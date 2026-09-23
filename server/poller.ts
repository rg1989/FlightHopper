// server/poller.ts
import type { CellStatus, StatusBrief, StatusReport } from '../shared/api.ts'
import { MinOffset } from '../shared/clock.ts'
import { isHidden, toSample } from '../shared/sample.ts'
import type { TokenBucket } from './budget.ts'
import { cellsForView, type Cell } from './cells.ts'
import type { InfoStore } from './infoStore.ts'
import type { Recorder } from './recorder.ts'
import type { FetchResult, Source } from './sources/types.ts'
import type { SampleStore } from './store.ts'

export interface PollerOpts {
  cellPeriodMs: number
  chasePeriodMs: number
  fullSnapshotPeriodMs: number
  interestTtlMs: number
  chaseTtlMs: number
  recorder: Recorder | null
  hideFlagged: boolean
  nowMs?: () => number
  info?: InfoStore // gets every non-hidden aircraft object of every good answer (identity, detail panel, routes)
}

/**
 * Suggested timing (WP-A1 may override). At adsb.lol's 1 req/s a 1.4 s chase uses 0.71 req/s and the view's cells
 * share the other 0.29 (one cell ≈ 4 s, three ≈ 11 s); a 1 s chase would starve them. The client's delay floor is
 * 3 s (WP-C3), so 1.4 s costs the chase nothing.
 */
export const POLLER_DEFAULTS = {
  cellPeriodMs: 3000,
  chasePeriodMs: 1400,
  fullSnapshotPeriodMs: 1000,
  interestTtlMs: 15_000,
  chaseTtlMs: 10_000,
} as const

const TICK_MS = 100
const MAX_HEXES = 100 // adsb.lol /v2/hex batch limit used by server/sources/adsblol.ts
const OFFSET_WINDOW_MS = 10 * 60_000
const HOUR_MS = 3_600_000
const MIN_SPAN_MS = 60_000 // bytes/hour is extrapolated from at least one minute
const KEEP_INTERVALS = 100 // p95 over the most recent intervals
/** The InfoStore forgets an aircraft after this long without an answer: the SampleStore's default horizon. */
export const INFO_HORIZON_MS = 180_000

/** p95 (nearest rank) of intervals in ms, as seconds; null when there are none. */
function p95S(xs: readonly number[]): number | null {
  if (xs.length === 0) return null
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.ceil(0.95 * sorted.length) - 1] / 1000
}

/** Intervals between successive good (200 + parsed) answers for one thing we poll. */
class OkIntervals {
  lastOkMs: number | null = null
  intervals: number[] = []

  ok(t: number): void {
    if (this.lastOkMs !== null) {
      this.intervals.push(t - this.lastOkMs)
      if (this.intervals.length > KEEP_INTERVALS) this.intervals.shift()
    }
    this.lastOkMs = t
  }
}

interface CellState {
  cell: Cell
  expiresMs: number
  lastReqMs: number
  ok: OkIntervals
}

/**
 * Decides what to ask the upstream next and feeds the answers into the store.
 * Full-snapshot sources (readsb, replay): one all() per fullSnapshotPeriodMs serves every view and chase.
 * Area sources (adsb.lol): the batched chase first (every chasePeriodMs), else the most overdue cell that someone
 * viewed within interestTtlMs (every cellPeriodMs). Every request needs a bucket token first.
 */
export class Poller {
  #source: Source
  #store: SampleStore
  #bucket: TokenBucket
  #opts: PollerOpts
  #now: () => number
  #startMs: number
  #offset = new MinOffset(OFFSET_WINDOW_MS)
  #cells = new Map<string, CellState>()
  #chased = new Map<string, number>() // hex → expiresMs
  #lastChaseReqMs = -Infinity
  #lastAllReqMs = -Infinity
  #chaseOk = new OkIntervals()
  #snapOk = new OkIntervals()
  #bytes: { t: number; n: number }[] = [] // last hour of responses
  #requestsTotal = 0
  #busy = false
  #timer: ReturnType<typeof setInterval> | null = null

  constructor(source: Source, store: SampleStore, bucket: TokenBucket, opts: PollerOpts) {
    this.#source = source
    this.#store = store
    this.#bucket = bucket
    this.#opts = opts
    this.#now = opts.nowMs ?? Date.now
    this.#startMs = this.#now()
  }

  /** Keeps the cells covering this view polled for interestTtlMs. Full-snapshot sources need no cells: []. */
  touchView(lat: number, lon: number, radiusNm: number): Cell[] {
    if (this.#source.caps.fullSnapshot) return []
    const expiresMs = this.#now() + this.#opts.interestTtlMs
    const cells = cellsForView(lat, lon, radiusNm)
    for (const cell of cells) {
      const c = this.#cells.get(cell.id)
      if (c) c.expiresMs = Math.max(c.expiresMs, expiresMs)
      else this.#cells.set(cell.id, { cell, expiresMs, lastReqMs: -Infinity, ok: new OkIntervals() })
    }
    return cells
  }

  /** Keeps this hex in the chase batch for chaseTtlMs. */
  touchChase(hex: string): void {
    this.#chased.set(hex.toLowerCase(), this.#now() + this.#opts.chaseTtlMs)
  }

  /** At most one upstream request. Returns whether one was made. Overlapping calls return false at once. */
  async tick(): Promise<boolean> {
    if (this.#busy) return false
    this.#busy = true
    try {
      const now = this.#now()
      this.#expire(now)
      this.#store.prune(now)
      if (this.#source.caps.fullSnapshot) {
        if (now - this.#lastAllReqMs < this.#opts.fullSnapshotPeriodMs || !this.#bucket.tryTake()) return false
        this.#lastAllReqMs = now
        if (this.#ingest(await this.#source.all())) {
          const t = this.#now()
          this.#snapOk.ok(t)
          if (this.#chased.size > 0) this.#chaseOk.ok(t)
        }
        return true
      }
      if (this.#chased.size > 0 && now - this.#lastChaseReqMs >= this.#opts.chasePeriodMs) {
        if (!this.#bucket.tryTake()) return false // a due chase never yields its token to a cell
        this.#lastChaseReqMs = now
        if (this.#ingest(await this.#source.hexes(this.#batch()))) this.#chaseOk.ok(this.#now())
        return true
      }
      const c = this.#mostOverdue(now)
      // While chasing, a cell takes a token only if one is left for the next chase: the chase never waits for a cell.
      if (!c || (this.#chased.size > 0 && this.#bucket.state().tokens < 2) || !this.#bucket.tryTake()) return false
      c.lastReqMs = now
      if (this.#ingest(await this.#source.circle(c.cell.lat, c.cell.lon, c.cell.radiusNm))) c.ok.ok(this.#now())
      return true
    } finally {
      this.#busy = false
    }
  }

  start(): void {
    if (this.#timer !== null) return
    this.#timer = setInterval(() => {
      this.tick().catch((e: unknown) => console.error('poller: tick failed:', e))
    }, TICK_MS)
    this.#timer.unref() // the HTTP server keeps the process alive, not the poller
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
  }

  brief(): StatusBrief {
    this.#expire(this.#now())
    const cellIntervals = this.#source.caps.fullSnapshot ? this.#snapOk.intervals : [...this.#cells.values()].flatMap((c) => c.ok.intervals)
    const b: StatusBrief = {
      source: this.#source.caps.kind,
      degraded: this.#bucket.degraded,
      cellPeriodP95S: p95S(cellIntervals),
      chasePeriodP95S: p95S(this.#chaseOk.intervals),
    }
    // The offset that stamps every sample (#ingest): lets the client light a replay at its recorded time (sun = tRender − it).
    if (this.#offset.ready) b.upstreamOffsetMs = Math.round(this.#offset.get())
    return b
  }

  report(): StatusReport {
    const now = this.#now()
    const brief = this.brief() // also drops expired cells and chases
    const cells: CellStatus[] = [...this.#cells.values()].map(({ cell: { id, lat, lon, radiusNm }, ok }) => ({
      id,
      lat,
      lon,
      radiusNm,
      lastOkMs: ok.lastOkMs,
      periodP95S: p95S(ok.intervals),
    }))
    this.#pruneBytes(now)
    let bytes = 0
    for (const b of this.#bytes) bytes += b.n
    const spanMs = Math.min(HOUR_MS, Math.max(MIN_SPAN_MS, now - this.#startMs))
    return {
      ...brief,
      budget: this.#bucket.state(),
      cells,
      chasedHexes: [...this.#chased.keys()],
      bytesPerHourEstimate: Math.round((bytes * HOUR_MS) / spanMs),
      requestsTotal: this.#requestsTotal,
    }
  }

  /** Budget, recorder, clock offset, stores. Returns whether the answer was good (200 and parsed). */
  #ingest(r: FetchResult): boolean {
    const now = this.#now()
    this.#bucket.onResult(r.status, r.retryAfterS)
    this.#requestsTotal++
    this.#bytes.push({ t: now, n: r.bytes })
    this.#pruneBytes(now)
    try {
      this.#opts.recorder?.write(this.#source.caps.kind, r)
    } catch (e) {
      console.error('poller: recorder write failed:', e) // ponytail: a full disk logs once per request; polling goes on
    }
    const snap = r.snapshot
    if (r.status !== 200 || snap === null) return false
    this.#offset.update(r.tRecvMs, snap.nowMs)
    const offsetMs = this.#offset.get()
    const info = this.#opts.info
    for (const ac of snap.aircraft) {
      if (this.#opts.hideFlagged && isHidden(ac)) continue
      info?.update(ac, r.tRecvMs)
      const s = toSample(ac, snap.nowMs, offsetMs, r.tRecvMs)
      if (s) this.#store.add(s)
    }
    info?.prune(now, INFO_HORIZON_MS) // on good answers only: its route-cache sweep need not run every 100 ms tick
    return true
  }

  #expire(now: number): void {
    for (const [id, c] of this.#cells) if (c.expiresMs <= now) this.#cells.delete(id)
    for (const [hex, exp] of this.#chased) if (exp <= now) this.#chased.delete(hex)
    if (this.#chased.size === 0) this.#chaseOk.lastOkMs = null // a new chase must not count the idle gap
  }

  /** The ≤ 100 most recently touched chased hexes. ponytail: more than 100 concurrent chases starve the rest. */
  #batch(): string[] {
    return [...this.#chased]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_HEXES)
      .map(([hex]) => hex)
  }

  /** The due cell whose last request is oldest (never-polled first, then registration order); null if none is due. */
  #mostOverdue(now: number): CellState | null {
    let best: CellState | null = null
    for (const c of this.#cells.values()) {
      if (now - c.lastReqMs < this.#opts.cellPeriodMs) continue
      if (best === null || c.lastReqMs < best.lastReqMs) best = c
    }
    return best
  }

  #pruneBytes(now: number): void {
    while (this.#bytes.length > 0 && this.#bytes[0].t <= now - HOUR_MS) this.#bytes.shift()
  }
}

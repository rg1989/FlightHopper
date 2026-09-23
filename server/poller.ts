// server/poller.ts
import type { CellStatus, StatusBrief, StatusReport } from '../shared/api.ts'
import { MinOffset } from '../shared/clock.ts'
import { isHidden, toSample } from '../shared/sample.ts'
import type { TokenBucket } from './budget.ts'
import { distanceNm } from '../shared/geo.ts'
import { cellBox, cellsForView, type Cell } from './cells.ts'
import type { InfoStore } from './infoStore.ts'
import type { Recorder } from './recorder.ts'
import type { FetchResult, Source } from './sources/types.ts'
import { LATEST_HORIZON_MS, type SampleStore } from './store.ts'

export interface PollerOpts {
  cellPeriodMs: number
  chasePeriodMs: number
  fullSnapshotPeriodMs: number
  interestTtlMs: number
  chaseTtlMs: number
  recorder: Recorder | null
  hideFlagged: boolean
  nowMs?: () => number
  // Low-budget mode (F2): every view, however wide, is polled as its own circle (≤ 250 nm around its centre). At
  // 0.04 req/s the cell cover of one view (2–4 cells) refreshed each aircraft only every 50–100 s; one circle, every 25 s.
  singleCircle?: boolean
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
/** A view up to this radius is polled as one circle of its own (the upstream's limit); a wider one as grid cells. */
export const VIEW_CIRCLE_MAX_NM = 250
const EMPTY_FACTOR = 4 // an area whose last answer was empty (sea, desert) is asked this many times less often…
const EMPTY_MAX_MS = 3_600_000 // …but at least hourly
const HEX_RETRY_MS = 30_000 // a chased hex whose hex request brought no position waits this long before the next one

/** A wide view asks only for the areas within this distance of its centre: the middle of the globe, not its rim. */
export const WIDE_REACH_NM = 2500

/**
 * How often to refresh the aircraft of a view radiusNm wide. Between answers the client dead-reckons every aircraft
 * along its track, so what a gap costs is the turn error on screen, which grows with the view's scale: 0.12 s per nm
 * up to 500 nm (5 s for a city, 16 s for the default regional view, 60 s at 500 nm). Wider, a view covers ~r² areas,
 * so the period grows as r² too and every zoomed-out view costs about the same (~0.3 req/s): 4 min for a continent
 * (1,000 nm), 30 min for the globe. The chased aircraft goes faster still (chasePeriodMs).
 */
export function viewPeriodMs(radiusNm: number): number {
  if (radiusNm <= 500) return Math.max(5_000, 120 * radiusNm)
  return Math.min(1_800_000, 60_000 * (radiusNm / 500) ** 2)
}
const MAX_HEXES = 100 // adsb.lol /v2/hex batch limit used by server/sources/adsblol.ts
const OFFSET_WINDOW_MS = 10 * 60_000
const HOUR_MS = 3_600_000
const MIN_SPAN_MS = 60_000 // bytes/hour is extrapolated from at least one minute
const KEEP_INTERVALS = 100 // p95 over the most recent intervals
/** The InfoStore forgets an aircraft after this long without an answer: as long as the SampleStore keeps its newest sample. */
export const INFO_HORIZON_MS = LATEST_HORIZON_MS

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
  periodMs: number // from the finest view that touched it within interestTtlMs
  periodSetMs: number
  count: number | null // aircraft in its last good answer; null before one
}

/**
 * Decides what to ask the upstream next and feeds the answers into the store.
 * Full-snapshot sources (readsb, replay): one all() per fullSnapshotPeriodMs serves every view and chase.
 * Area sources (adsb.fi, adsb.lol): the newest view up to 250 nm wide is one circle of its own, a wider one the grid
 * cells covering it. Each area is asked every viewPeriodMs of the finest view that touched it (empty ones less often),
 * never-asked ones first, nearest the view centre first. While an aircraft is chased the view circle, centred on it,
 * is asked every chasePeriodMs: it carries the chased aircraft and its traffic in one request. A hex request (the chase
 * batch) goes out only for a chased aircraft the areas have not delivered lately and that is not inside the view
 * circle. Every request needs a bucket token first; interest lapses interestTtlMs after the last touch.
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
  #viewAt = { lat: 0, lon: 0 } // centre of the newest view
  #viewPeriodMs = 0 // its period
  #chased = new Map<string, number>() // hex → expiresMs
  #lastChaseReqMs = -Infinity
  #hexRetryMs = new Map<string, number>() // hex → not asked again before this (its last hex request brought no position)
  #lastAllReqMs = -Infinity
  #chaseOk = new OkIntervals()
  #snapOk = new OkIntervals()
  #bytes: { t: number; n: number }[] = [] // last hour of responses
  #requestsTotal = 0
  #busy = false
  #asking: CellState | null = null // the area whose request is in flight
  #timer: ReturnType<typeof setInterval> | null = null

  constructor(source: Source, store: SampleStore, bucket: TokenBucket, opts: PollerOpts) {
    this.#source = source
    this.#store = store
    this.#bucket = bucket
    this.#opts = opts
    this.#now = opts.nowMs ?? Date.now
    this.#startMs = this.#now()
  }

  /**
   * Keeps this view's areas polled for interestTtlMs, each at least every viewPeriodMs(radiusNm). Returns them: one
   * circle ('view') up to 250 nm (always, with singleCircle), else the grid cells covering the view out to WIDE_REACH_NM
   * from its centre. Areas of an older
   * view that were never asked are dropped: the newest view wins (one person's app). Full-snapshot sources: [].
   */
  touchView(lat: number, lon: number, radiusNm: number): Cell[] {
    if (this.#source.caps.fullSnapshot) return []
    const now = this.#now()
    const expiresMs = now + this.#opts.interestTtlMs
    const single = this.#opts.singleCircle || radiusNm <= VIEW_CIRCLE_MAX_NM
    // One circle is at most 250 nm wide whatever the view: its period is that circle's, not the globe's.
    const periodMs = Math.max(this.#opts.cellPeriodMs, viewPeriodMs(single ? Math.min(VIEW_CIRCLE_MAX_NM, radiusNm) : radiusNm))
    this.#viewAt = { lat, lon }
    this.#viewPeriodMs = periodMs
    const cells = single
      ? [{ id: 'view', lat, lon, radiusNm: Math.ceil(Math.min(VIEW_CIRCLE_MAX_NM, radiusNm)) }]
      : cellsForView(lat, lon, Math.min(WIDE_REACH_NM, radiusNm))
    const ids = new Set(cells.map((c) => c.id))
    for (const [id, c] of this.#cells) if (!ids.has(id) && c.lastReqMs === -Infinity) this.#cells.delete(id)
    for (const cell of cells) {
      const c = this.#cells.get(cell.id)
      if (c === undefined) {
        this.#cells.set(cell.id, { cell, expiresMs, lastReqMs: -Infinity, ok: new OkIntervals(), periodMs, periodSetMs: now, count: null })
        continue
      }
      // The view circle moved a third of its radius or more (a pan, or the chased aircraft flying on): a new area, asked
      // at once, whatever the old one's timer (up to 4× a period after an empty answer) said.
      if (cell.id === 'view' && distanceNm(c.cell.lat, c.cell.lon, cell.lat, cell.lon) > c.cell.radiusNm / 3) {
        c.lastReqMs = -Infinity
        c.count = null
      }
      c.cell = cell
      c.expiresMs = Math.max(c.expiresMs, expiresMs)
      // The finest view wins while it is being watched; a coarser one takes over interestTtlMs after it.
      if (periodMs <= c.periodMs || now - c.periodSetMs > this.#opts.interestTtlMs) {
        c.periodMs = periodMs
        c.periodSetMs = now
      }
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
      const batch = now - this.#lastChaseReqMs >= this.#opts.chasePeriodMs ? this.#batch(now) : []
      if (batch.length > 0) {
        if (!this.#bucket.tryTake()) return false // a due chase never yields its token to an area
        this.#lastChaseReqMs = now
        const r = await this.#source.hexes(batch)
        if (this.#ingest(r)) {
          this.#chaseOk.ok(this.#now())
          // A good answer without a fresh (shown) position for it: not found, position-less or hidden. That hex waits
          // before it is asked again. A failed request is the bucket's to pace (Retry-After, back-off).
          for (const hex of batch) if ((this.#store.latest(hex)?.rxMs ?? -Infinity) < now) this.#hexRetryMs.set(hex, now + HEX_RETRY_MS)
        }
        return true
      }
      const c = this.#next(now)
      if (!c || !this.#bucket.tryTake()) return false
      c.lastReqMs = now
      this.#asking = c
      const r = await this.#source.circle(c.cell.lat, c.cell.lon, c.cell.radiusNm).finally(() => (this.#asking = null))
      if (this.#ingest(r)) {
        const t = this.#now()
        c.ok.ok(t)
        c.count = r.snapshot!.aircraft.length
        // The view circle is how a chased aircraft in it is refreshed: its answers count as chase answers.
        if (this.#chased.size > 0 && r.snapshot!.aircraft.some((a) => this.#chased.has(a.hex.toLowerCase()))) this.#chaseOk.ok(t)
      }
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
    const tokenMs = 1000 / this.#bucket.state().rps
    const full = this.#source.caps.fullSnapshot
    let busy = 0 // areas of the view that hold (or may hold) aircraft: each costs one request per round
    let pending = 0
    const waiting: CellState[] = []
    const now = this.#now()
    const chaseInView = this.#chaseInView()
    for (const c of this.#cells.values()) {
      if (c.count !== 0) busy++
      // Not loaded: never asked (or its view circle moved), or no good answer yet (in flight, or failed).
      if (c.lastReqMs !== -Infinity && c.ok.lastOkMs !== null) continue
      pending++
      if (c.cell.id !== 'view') waiting.push(c)
    }
    // In the order they will be asked: the one in flight first (the map shows a spinner in it).
    const order = (c: CellState): number => (c === this.#asking ? Infinity : this.#priority(c, now, chaseInView))
    const boxes = waiting.sort((a, b) => order(b) - order(a)).map((c) => cellBox(c.cell))
    const b: StatusBrief = {
      source: this.#source.caps.kind,
      degraded: this.#bucket.degraded,
      cellPeriodP95S: p95S(cellIntervals),
      chasePeriodP95S: p95S(this.#chaseOk.intervals),
      // What to expect next, for the client's delay and staleness: the budget stretches both when it cannot keep up.
      viewEveryS: (full ? Math.max(this.#opts.fullSnapshotPeriodMs, tokenMs) : Math.max(this.#viewPeriodMs, busy * tokenMs)) / 1000,
      chaseEveryS: Math.max(full ? this.#opts.fullSnapshotPeriodMs : this.#opts.chasePeriodMs, tokenMs) / 1000,
      pendingAreas: pending,
    }
    if (boxes.length > 0) b.pendingBoxes = boxes
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
    for (const [hex, until] of this.#hexRetryMs) if (until <= now) this.#hexRetryMs.delete(hex)
    if (this.#chased.size === 0) this.#chaseOk.lastOkMs = null // a new chase must not count the idle gap
  }

  /**
   * The chased hexes (≤ 100, most recently touched first) that need a hex request: never stored (a ?hex= link), or last
   * seen outside the view circle (none while the view is grid cells). A hex whose last hex request brought no position
   * (landed, out of coverage, position-less, hidden, a mistyped ?hex=) is left out for HEX_RETRY_MS.
   * ponytail: more than 100 concurrent chases starve the rest.
   */
  #batch(now: number): string[] {
    if (this.#chased.size === 0) return []
    const view = this.#cells.get('view')?.cell
    // Only chases a client asked about in the last 2.5 s (clients ask every second): one released by Esc or a new
    // selection stays in #chased for chaseTtlMs but is not worth a request.
    const recent = now + this.#opts.chaseTtlMs - 2500
    return [...this.#chased]
      .sort((a, b) => b[1] - a[1])
      .filter(([hex, expiresMs]) => {
        if (expiresMs < recent) return false
        if ((this.#hexRetryMs.get(hex) ?? -Infinity) > now) return false
        const s = this.#store.latest(hex)
        // Inside the view circle its answers carry the aircraft (or, once it is gone, a hex request would not find it either).
        return s === null || view === undefined || distanceNm(view.lat, view.lon, s.lat, s.lon) > view.radiusNm
      })
      .slice(0, MAX_HEXES)
      .map(([hex]) => hex)
  }

  /** Is a chased aircraft (as last stored) inside the view circle? Then that circle is how it is chased. */
  #chaseInView(): boolean {
    const view = this.#cells.get('view')?.cell
    if (view === undefined) return false
    for (const hex of this.#chased.keys()) {
      const s = this.#store.latest(hex)
      if (s !== null && distanceNm(view.lat, view.lon, s.lat, s.lon) <= view.radiusNm) return true
    }
    return false
  }

  /** How often this area is due: its view's period (the chase period for a view circle holding the chase), longer when empty. */
  #periodMs(c: CellState, chaseInView: boolean): number {
    const p = c.cell.id === 'view' && chaseInView ? Math.min(c.periodMs, this.#opts.chasePeriodMs) : c.periodMs
    return c.count === 0 ? Math.max(p, Math.min(EMPTY_MAX_MS, p * EMPTY_FACTOR)) : p
  }

  /**
   * The next area to ask: never-asked ones first, nearest the newest view centre first; then the most overdue for its
   * period.
   */
  #next(now: number): CellState | null {
    let best: CellState | null = null
    let bestKey = -Infinity
    const chaseInView = this.#chaseInView()
    for (const c of this.#cells.values()) {
      if (now - c.lastReqMs < this.#periodMs(c, chaseInView)) continue
      const key = this.#priority(c, now, chaseInView)
      if (key > bestKey) {
        best = c
        bestKey = key
      }
    }
    return best
  }

  /**
   * Never asked: 1e9 minus the distance from the view centre, so a view fills outwards from where the user looks. Else:
   * how many periods overdue (≥ 1 when due).
   */
  #priority(c: CellState, now: number, chaseInView: boolean): number {
    return c.lastReqMs === -Infinity
      ? 1e9 - distanceNm(this.#viewAt.lat, this.#viewAt.lon, c.cell.lat, c.cell.lon)
      : (now - c.lastReqMs) / this.#periodMs(c, chaseInView)
  }

  #pruneBytes(now: number): void {
    while (this.#bytes.length > 0 && this.#bytes[0].t <= now - HOUR_MS) this.#bytes.shift()
  }
}

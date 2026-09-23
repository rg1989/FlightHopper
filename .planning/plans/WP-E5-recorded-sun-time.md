# WP-E5 — Recorded Sun Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Light each replay by the sun at the time it was recorded (design brief D12, user decision 2026-09-22). The server re-stamps every sample onto its own clock (`tMs = upstream now − seen_pos + offset`), so today the client never sees when a replay was recorded. This package adds `StatusBrief.upstreamOffsetMs`. It is the poller's server − upstream clock offset, the same number that stamps every sample. E-A then computes sun time = `tRenderMs − upstreamOffsetMs`, and applies the `?sun=` override after that. For a replay the offset is how long ago it was recorded (hours or days). For live sources it is only the network latency, so live lighting does not change.

**Architecture:**
- `shared/api.ts`: `StatusBrief` gains the optional field `upstreamOffsetMs?: number`. Because it is optional, every existing `StatusBrief` literal still type-checks (`client/app.ts` `NO_STATUS`, the client tests, `harness/hud.ts`, `harness/detail.ts`). `StatusReport extends StatusBrief`, so `/api/status` gets the field too.
- `server/poller.ts`: `brief()` sets `upstreamOffsetMs = Math.round(this.#offset.get())` only when `this.#offset.ready`, which is true after the first good answer (200 and parsed). Before that the key is absent (not `undefined`, not 0), so a client can tell "unknown" from "zero". `report()` already spreads `brief()`, so it carries the field without a change of its own. The value is the windowed minimum (`OFFSET_WINDOW_MS`, 10 min) that `#ingest` already passes to `toSample`. So for every sample, `tMs − upstreamOffsetMs` is the position time on the upstream's clock. For live sources that is `now − seen_pos`. For a replay it is the recording machine's clock, because `server/sources/replay.ts` serves `now` = `vt`.
- Values:
  - A replay at speed 1: server start time − the first recorded receive time. It stays constant while the replay plays, because `vt` and the server clock advance together.
  - Live adsb.lol or readsb: one-way latency + upstream clock skew, typically hundreds of ms.
  - The poller tests run on a fake clock in 1970, so there the value is large and negative. That is correct.
- ponytail: with `REPLAY_SPEED` < 1 the offset grows over time, and the windowed minimum keeps the oldest value for up to 10 min. The sun then runs ahead of the recording by up to 10 min × (1 − speed): 5 min at 0.5×, about 1.25° of sun movement. Sample stamping has the same lag today. Speed ≥ 1 is exact.
- ponytail: a looped replay keeps serving `now` = `vt`, which continues past the end of the recording. The second pass is therefore lit one period later than the first, and the sun does not jump back at the seam.

**Tech Stack:** Node ≥ 24.2 stdlib only. No Cesium, no new dependencies.

**Wave:** E5 (parallel with E1–E4; it needs only the base tree, none of E0's code). Consumed by E-A. **Estimated:** 30 min.

**Validated:** 2026-09-22, Node 25.2.1, TypeScript 7.0.2, on the user's MacBook Air M2, in a scratch copy of the integrated tree (B-A applied, 604 tests).
- Package tests: `server/poller.test.ts` 18/18 (16 + 2 new), `server/main.test.ts` 7/7.
- `npx tsc --noEmit` is clean for the whole tree.
- Full `npm test`: 606/606 (604 + 2 new).
- Known flakes: two timing tests fail under full-suite load and pass alone: "sortRows and filterRows stay cheap at 12,000 rows" and "budget: /api/view of a 250 nm circle with 5,000 aircraft". The base tree's logged run failed both (602/604).
  - The replay's full run below also failed both. At that time the machine's load average was about 29, because four other WP agents were running.
  - Run alone after that, `client/ui/table.test.ts` passed 11/11 three times.
  - The budget test failed alone on the untouched base tree too (medians 425 ms and 86 ms against a 50 ms limit). On this package it passed once and failed once (63 ms). The cause is machine load, not this change.
- Values the tests pin:
  - fake source at the fake 1970 clock: −1,790,080,633,500 ms
  - a golden body served 3 days after its `now`: 259,200,000 ms, exactly 3 days
  - live, answer 180.6 ms after the upstream's `now`: 181 ms
  - the real replay source over HTTP on an injected clock `T0` = 2e12: 209,918,289,319 ms (`T0` − 1,790,081,710,681, the recording's first receive time)

**Replay.** A fresh copy of the base tree was rebuilt from this plan alone. Step 2 failed as written: 25 tests, 20 pass, 5 fail, with the messages quoted there. Step 4 passed 25/25. Every code block is byte-identical to the tested file. After the replay: tsc clean, `npm test` 604/606, where only the two known timing flakes failed (see above).

**Mutations** (each one was killed; the failing count is from `poller.test.ts` + `main.test.ts`):
- No rounding: 1 fail.
- No `ready` guard, so `get()` throws before the first answer: 11 fail.
- `upstreamOffsetMs: undefined` instead of an absent key: 2 fail.
- Sign flipped: 4 fail.
- The last answer's offset instead of the windowed minimum: 2 fail.
- `report()` drops the field: 3 fail.

**CLI check** (Task 2 Step 4, real server, replay of `recording-sample.jsonl` on 127.0.0.1:8798):
- `upstreamOffsetMs` was 27,207,458 ms (7.56 h). The sample was recorded at 12:55:10.681Z.
- `serverNowMs − upstreamOffsetMs` was 12:55:11.584Z, which is 0.9 s into the recording.
- No request left the machine.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- **Time.** `Sample.tMs` stays server clock. Stamping does not change. This package only exposes the offset that stamping already uses.
- **Tests never touch the network.** The poller tests use the fake source on a fake clock. `main.test.ts` uses 127.0.0.1 only.
- **File ownership.**
  - `shared/api.ts` (WP-00, extended by B0): an additive edit.
  - `server/poller.ts` (I1, B-S1) and `server/poller.test.ts`: edited.
  - `server/main.test.ts` (A1): edited. It compares the exact key list of `/api/status`, so it must list the new key. This is a forced change, as B-S1's `config.test.ts` edit was. The same edit adds one line that checks the replay value over HTTP.
  - No client file changes. E-A owns the client side.
- Code blocks preceded by `File: \`path\`` contain that file's complete content. Test-file edits are given as exact insertions and replacements.

## Files owned by this package

| Path | Change |
|---|---|
| `shared/api.ts` | `StatusBrief.upstreamOffsetMs?: number` (additive) |
| `server/poller.ts` | `brief()` (and therefore `report()`) adds it once the offset is known, rounded to whole ms |
| `server/poller.test.ts` | the full-snapshot `deepEqual` gains the field. Two new tests: a replay served 3 days later; live latency, rounding, and no key after a failed answer |
| `server/main.test.ts` | the `/api/status` key list gains `upstreamOffsetMs` (forced). The replay test checks the value on `/api/view` |

---

### Task 1: The status brief carries the upstream clock offset

**Files:**
- Modify: `shared/api.ts`, `server/poller.ts` (complete new contents below)
- Test: `server/poller.test.ts`, `server/main.test.ts` (edits below)

**Interfaces:**
- Consumes: `MinOffset` (`shared/clock.ts`: `ready`, `get()`), the poller's `#offset` (I1), `StatusBrief` / `StatusReport` (WP-00)
- Produces: `StatusBrief.upstreamOffsetMs?: number`. `Poller.brief(): StatusBrief` and `Poller.report(): StatusReport` include `upstreamOffsetMs: Math.round(#offset.get())` if and only if `#offset.ready`. Before that the key is absent. Contract for E-A: sun time = `tRenderMs − (status.upstreamOffsetMs ?? 0)`, then `?sun=`.

- [ ] **Step 1: Write the failing tests**

`server/poller.test.ts`, three edits:

(a) After the line `const LLBG = [32.0114, 34.8867] as const // a 5 nm view here is exactly one cell`, insert:
```ts
const DAY_MS = 86_400_000
// When the golden bodies were recorded: their own upstream `now`, in ms (2026-09-22).
const ALL_NOW_MS = normalizeReadsb(BODIES.all).nowMs // 1_790_081_633_500
const HEXES_NOW_MS = normalizeAdsblol(BODIES.hexes).nowMs // 1_790_081_641_500
```

(b) In the test `fullSnapshot source: all() once per fullSnapshotPeriodMs, never circle or hexes`, replace
```ts
  assert.deepEqual(b, { source: 'readsb', degraded: null, cellPeriodP95S: 1, chasePeriodP95S: 1 })
```
with
```ts
  assert.deepEqual(b, { source: 'readsb', degraded: null, cellPeriodP95S: 1, chasePeriodP95S: 1, upstreamOffsetMs: T0 - ALL_NOW_MS })
```

(c) After the test `brief before any response: nulls, not zeros`, insert the code below. Leave that test unchanged: its `deepEqual` already proves the key is absent before any answer.
```ts

test('upstreamOffsetMs: a recording served 3 days later reports 3 days; tMs − upstreamOffsetMs is the recorded time', async () => {
  const s = setup({ fullSnapshot: true }) // a replay-like upstream: its answers say "now" = when they were recorded
  s.clock.t = ALL_NOW_MS + 3 * DAY_MS
  assert.equal(await s.poller.tick(), true)
  const b = s.poller.brief()
  assert.equal(b.upstreamOffsetMs, 3 * DAY_MS)
  const ac = normalizeReadsb(BODIES.all).aircraft.find((a) => a.hex === 'a1c7e4')!
  assert.equal(s.store.latest('a1c7e4')!.tMs - b.upstreamOffsetMs!, ALL_NOW_MS - Math.round(ac.seen_pos! * 1000))
  // a later, slower answer does not move it (windowed minimum); report() extends brief() and carries it too
  s.clock.t += 1000
  assert.equal(await s.poller.tick(), true)
  assert.equal(s.poller.report().upstreamOffsetMs, 3 * DAY_MS)
})

test('upstreamOffsetMs: live, about the latency, in whole ms; absent until a good answer', async () => {
  const s = setup()
  s.poller.touchChase('71bd79')
  s.replies.push({ status: 503 })
  assert.equal(await s.poller.tick(), true)
  assert.equal('upstreamOffsetMs' in s.poller.brief(), false, 'a failed answer gives no offset')
  s.clock.t = HEXES_NOW_MS + 180.6 // this answer arrives 180.6 ms after the upstream's now
  s.poller.touchChase('71bd79')
  assert.equal(await s.poller.tick(), true)
  assert.equal(s.poller.brief().upstreamOffsetMs, 181)
})
```

`server/main.test.ts`, two edits:

(a) In `assertApi`, replace
```ts
  const keys = ['budget', 'bytesPerHourEstimate', 'cellPeriodP95S', 'cells', 'chasePeriodP95S', 'chasedHexes', 'degraded', 'requestsTotal', 'source']
```
with
```ts
  const keys = ['budget', 'bytesPerHourEstimate', 'cellPeriodP95S', 'cells', 'chasePeriodP95S', 'chasedHexes', 'degraded', 'requestsTotal', 'source', 'upstreamOffsetMs']
```

(b) In the test `replay on an injected server clock: …`, after the line `  assert.equal(v.body.serverNowMs, T0 + 2500)`, insert:
```ts
  // The replay tells the client how long ago it was recorded: server clock − the recording's clock (sun time, D12).
  assert.equal(v.body.status.upstreamOffsetMs, T0 - readRecording(FILE)[0].tRecvMs)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test server/poller.test.ts server/main.test.ts`
Expected: FAIL with `ℹ tests 25`, `ℹ pass 20`, `ℹ fail 5`:
- `✖ fullSnapshot source: …`: `Expected values to be strictly deep-equal:`, with the expected side showing `-   upstreamOffsetMs: -1790080633500`
- `✖ upstreamOffsetMs: a recording served 3 days later …`: `+ undefined` / `- 259200000`
- `✖ upstreamOffsetMs: live, about the latency …`: `undefined !== 181`
- `✖ replay on an injected server clock: …` and `✖ flip: the same API from ADSB_SOURCE=readsb …`: the key list, `-   'upstreamOffsetMs'`

(The "absent after a failed answer" assertion passes before the change, so the live test fails only at `181`.)

- [ ] **Step 3: Write the implementation**

File: `shared/api.ts`
```ts
import type { AircraftInfo } from './info.ts'
import type { ReadsbAircraft, Sample, SourceKind } from './types.ts'

export type Degraded = null | 'rate-limited' | 'blocked' | 'upstream-down'

export interface StatusBrief {
  source: SourceKind
  degraded: Degraded
  cellPeriodP95S: number | null
  chasePeriodP95S: number | null
  upstreamOffsetMs?: number      // server clock − upstream clock, whole ms (the poller's MinOffset); absent until known. Replay: server now − recording time; live: ≈ latency
}

export interface ViewResponse {
  serverNowMs: number
  samples: Sample[]
  status: StatusBrief
  info?: AircraftInfo[]          // for returned hexes whose info changed after `since` (all of them when since=0)
}

export interface ChaseResponse {
  serverNowMs: number
  samples: Sample[]
  status: StatusBrief
  raw?: ReadsbAircraft | null    // newest full upstream object for the detail panel
  info?: AircraftInfo | null
}

export interface BudgetState {
  rps: number
  maxRps: number
  tokens: number
  blocked: boolean
  pausedUntilMs: number
  counts: { ok: number; r429: number; r4xx: number; r5xx: number; err: number }
}

export interface CellStatus {
  id: string
  lat: number
  lon: number
  radiusNm: number
  lastOkMs: number | null
  periodP95S: number | null
}

export interface StatusReport extends StatusBrief {
  budget: BudgetState
  cells: CellStatus[]
  chasedHexes: string[]
  bytesPerHourEstimate: number
  requestsTotal: number
}
```

File: `server/poller.ts`
```ts
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
```

- [ ] **Step 4: Run them to verify they pass**

Run: `node --test server/poller.test.ts server/main.test.ts`
Expected: PASS, `ℹ tests 25`, `ℹ pass 25`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add shared/api.ts server/poller.ts server/poller.test.ts server/main.test.ts
git commit -m "feat(server): status brief reports the upstream clock offset (recorded sun time)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: WP gate

- [ ] **Step 1: This package's tests**

Run: `node --test server/poller.test.ts server/main.test.ts`
Expected: `ℹ tests 25`, `ℹ pass 25`, `ℹ fail 0`.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no output. The field is optional, so the `StatusBrief` literals in `client/`, `harness/` and their tests need no change.

- [ ] **Step 3: Full check**

Run: `npm run check`
Expected: `tsc` prints nothing. On the B-A tree plus this package: `ℹ tests 606`, `ℹ pass 606`, `ℹ fail 0` (604 + 2 new). Two timing tests can fail under full-suite load and pass when run alone: "sortRows and filterRows stay cheap at 12,000 rows" and "budget: /api/view of a 250 nm circle with 5,000 aircraft". These are known flakes, not failures of this package. Re-run their files alone to confirm.

- [ ] **Step 4: Check it by hand (optional, no adsb.lol traffic)**

Run: `ADSB_SOURCE=replay REPLAY_FILES=data/fixtures/golden/recording-sample.jsonl PORT=8798 RECORD_DIR= node server/main.ts`. Then, in another shell:

`curl -s --compressed 'http://127.0.0.1:8798/api/view?lat=37.6188&lon=-122.3758&nm=40&since=0'`

The `status` object ends in `"upstreamOffsetMs":<n>`, where `n` is the time between the recording and the server start, in ms. `serverNowMs − n` is a moment inside the recording: it starts at 2026-09-22T12:55:10.681Z. `/api/status` shows the same value.

Stop the server (Ctrl-C).

- [ ] **Step 5: Confirm there is nothing left to commit**

Run: `git status --short`
Expected: no output.

## Notes for later work

- E-A reads the field from the newest `ViewResponse.status` or `ChaseResponse.status`. `statusShown` in `client/app.ts` spreads the status, so the field passes through. Until the first answer (`NO_STATUS`) the field is absent. Treat that as 0, which means server time.
- The offset is the minimum over a 10-minute window, so it only moves when the upstream's clock or the latency changes. Clients can use the newest value without smoothing.

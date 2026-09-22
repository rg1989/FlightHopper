# WP-I1 — Poller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One class that decides what to ask the upstream next, asks it within the request budget, and turns every answer into server-clock samples in the `SampleStore`. It also reports the numbers that `/api/status` and Gate G1 read.

**Architecture:** `server/poller.ts` holds one `Poller` per source. Its state is two interest maps (cells from `touchView`, hexes from `touchChase`, each with a TTL), one `MinOffset` (upstream clock → server clock), and per-cell/chase interval rings for p95 periods. `tick()` makes at most one request. A full-snapshot source (readsb, replay) gets one `all()` per `fullSnapshotPeriodMs`. An area source (adsb.lol) gets the batched chase first when it is due, else the most overdue viewed cell. Every request needs a `TokenBucket` token, and while a chase is active a cell only takes a token when one is left over for the next chase. Each answer goes to the bucket (`onResult`), the recorder, the clock offset and the store, in that order. `start()` runs `tick()` on a 100 ms `setInterval`; a busy flag stops ticks from overlapping. The clock is injected (`nowMs`), so the tests drive a fake clock with a fake `Source`, the real `TokenBucket` and the real `SampleStore`.

**Tech Stack:** Node ≥ 24.2 (native TypeScript), `node:test`. No new dependencies. Consumes WP-00, WP-S2 (`Recorder`), WP-S3 (`TokenBucket`) and WP-S4 (`cellsForView`, `SampleStore`). WP-S1's sources are only used through the `Source` interface.

**Wave:** 2 (needs S1, S2, S3, S4 merged; WP-A1 waits for this). **Estimated:** 1.5–2 h. **Validated:** on 2026-09-22 in the shared sandbox (Node v25.2.1, TypeScript 7.0.2) that holds WP-00 and the merged-state code of S1–S4. The test below was written first and failed with `ERR_MODULE_NOT_FOUND`. With the implementation, `node --test server/poller.test.ts` gave 16/16 pass (the one real-timer test takes ≈ 1.5 s). `tsc --noEmit` reported nothing for these files, and the whole sandbox gave 412/412 tests with `tsc` silent. A budget simulation with the real `TokenBucket` (one view plus one chase for 10 simulated minutes) produced the numbers in the budget table and set `POLLER_DEFAULTS`. Every code block in this plan was then extracted into a copy of the sandbox and compared byte for byte with the tested files, and the tests were run again there.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. The ones that matter most for this package:
- **Time:** `Sample.tMs` is server clock: upstream `now − seen_pos`, moved into server clock by a per-source windowed `MinOffset` of `(tRecvMs − upstream now)`. Never stamp with a receipt time.
- **Upstream politeness:** every upstream request takes a `TokenBucket` token first, and every answer goes back to it with `onResult(status, retryAfterS)`. After a 401/403 the bucket blocks for good and this package never asks again.
- **Privacy:** aircraft with `dbFlags & 4` (PIA) or `& 8` (LADD) never reach the store while `hideFlagged` is true.
- **Tests never touch the network:** a fake `Source` answers golden bodies from `data/fixtures/golden/`.
- Erasable TypeScript only, `.ts` import extensions.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `server/poller.ts` | `Poller`, `PollerOpts`, `POLLER_DEFAULTS` |
| `server/poller.test.ts` | fake-source, fake-clock tests: priority, periods, TTLs, 429, 403, full snapshot, stamping, privacy, recorder, status, timer |

---

### Task 1: Poller

**Files:**
- Create: `server/poller.ts`, `server/poller.test.ts`
- Test: `server/poller.test.ts`

**Interfaces:**
- Consumes:
  - `Source`, `FetchResult` from `server/sources/types.ts` (WP-00): `caps.kind`, `caps.fullSnapshot`, `circle(lat, lon, radiusNm)`, `hexes(hexes)`, `all()`.
  - `TokenBucket` from `server/budget.ts` (WP-S3): `tryTake()`, `onResult(status, retryAfterS)`, `state()` (`tokens`, counters) and `degraded`.
  - `cellsForView(lat, lon, radiusNm): Cell[]` and `Cell` from `server/cells.ts` (WP-S4); `SampleStore` from `server/store.ts` (WP-S4): `add(s)`, `prune(nowMs)`.
  - `Recorder` from `server/recorder.ts` (WP-S2): `write(kind, r)`. It throws on I/O errors; the Poller logs them and keeps polling.
  - `MinOffset` (`shared/clock.ts`), `toSample`, `isHidden` (`shared/sample.ts`), `StatusBrief`, `StatusReport`, `CellStatus` (`shared/api.ts`), all WP-00.
- Produces (locked, PLAN.md §4 I1): `interface PollerOpts { cellPeriodMs: number; chasePeriodMs: number; fullSnapshotPeriodMs: number; interestTtlMs: number; chaseTtlMs: number; recorder: Recorder | null; hideFlagged: boolean; nowMs?: () => number }` and `class Poller { constructor(source: Source, store: SampleStore, bucket: TokenBucket, opts: PollerOpts); touchView(lat, lon, radiusNm): Cell[]; touchChase(hex): void; tick(): Promise<boolean>; start(): void; stop(): void; brief(): StatusBrief; report(): StatusReport }`. Extra export: `POLLER_DEFAULTS` (`cellPeriodMs 3000`, `chasePeriodMs 1400`, `fullSnapshotPeriodMs 1000`, `interestTtlMs 15000`, `chaseTtlMs 10000`).

| Call | Behaviour |
|---|---|
| `touchView(lat, lon, nm)` | area source: registers every `cellsForView` cell until `now + interestTtlMs` (a later touch extends it) and returns the cells. Full-snapshot source: returns `[]` and registers nothing, because `all()` serves every view |
| `touchChase(hex)` | lower-cases the hex and keeps it in the chase set until `now + chaseTtlMs` |
| `tick()` full snapshot | when `fullSnapshotPeriodMs` has passed since the last `all()` and `tryTake()` succeeds: `all()`. Never `circle` or `hexes` |
| `tick()` area source | 1. chase set not empty and `chasePeriodMs` passed since the last batch: take a token (or return `false`, never yielding it to a cell) and call `hexes(≤ 100 most recently touched)`. 2. Otherwise the due cell (`cellPeriodMs` since its last request) with the oldest last request; while a chase is active it only goes when the bucket holds ≥ 2 tokens. Returns whether a request was made |
| each answer | `bucket.onResult`; `requestsTotal++`; bytes logged for the last hour; `recorder?.write(caps.kind, r)`; if status 200 and a snapshot: `MinOffset(10 min).update(tRecvMs, snapshot.nowMs)`, then `toSample(ac, nowMs, offset, tRecvMs)` → `store.add` for each aircraft (hidden ones skipped when `hideFlagged`) |
| expiry | at each `tick`, `brief` and `report`, cells and hexes past their TTL are dropped. An empty chase set resets the chase interval clock, so an idle gap never counts as a period |
| `start()` / `stop()` | `setInterval(tick, 100)` (unref'd; the HTTP server keeps the process alive); a second `start()` does nothing; `tick()` returns `false` at once while another tick is running |
| `brief()` | `{ source: caps.kind, degraded: bucket.degraded, cellPeriodP95S, chasePeriodP95S }`. p95 (nearest rank, seconds) over the last 100 intervals between good answers. Cells: pooled over the active cells (full snapshot: between good `all()` answers). Chase: between good batch answers, or good `all()` answers while chasing. `null` before there are two good answers |
| `report()` | `brief()` + `budget: bucket.state()`, `cells` (active cells: id, centre, radius, `lastOkMs`, own `periodP95S`), `chasedHexes`, `requestsTotal`, `bytesPerHourEstimate` = bytes of the last hour × 1 h ÷ clamp(uptime, 1 min, 1 h) |

**Budget arithmetic (simulated with the real `TokenBucket`, one 40 nm view and one chase, 10 minutes):**

| max rps | chase period | view | cells | chase p95 | cell p95 |
|---|---|---|---|---|---|
| 1 | 1000 ms | any | 1–3 | 1.0 s | none (cells get no token) |
| 1 | 1400 ms | LLBG 5 nm | 1 | 1.4 s | 4 s |
| 1 | 1400 ms | LLBG 40 nm | 2 | 1.4 s | 7 s |
| 1 | 1400 ms | KSFO 40 nm | 3 | 1.4 s | 11 s |
| 0.5 | 1000 or 1400 ms | any | 1–3 | 2.0 s | none |

Without the "leave a token for the chase" rule the chase slipped to a 2.0 s p95 at 1400 ms, because a cell spent the token the chase needed. WP-C3's delay floor is 3 s, so a 1.4 s chase costs the client nothing. That is why `POLLER_DEFAULTS.chasePeriodMs` is 1400.

**How WP-A1 uses it:** construct one `Poller(source, store, new TokenBucket(maxRps), { ...POLLER_DEFAULTS, recorder, hideFlagged: !SHOW_PIA_LADD })`; call `start()` in `listen` and `stop()` in `close`; call `touchView(lat, lon, nm)` on every `GET /api/view` and `touchChase(hex)` on every `GET /api/chase`; answer `/api/status` with `report()` and put `brief()` into view/chase responses. Read samples with the store directly (`store.view`, `store.track`).

- [ ] **Step 1: Write the failing test**

```ts
// server/poller.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { normalizeAdsblol, normalizeReadsb } from '../shared/readsb.ts'
import { TokenBucket } from './budget.ts'
import { cellsForView } from './cells.ts'
import { Poller, type PollerOpts } from './poller.ts'
import { Recorder } from './recorder.ts'
import { readRecording } from './recording.ts'
import { SampleStore } from './store.ts'
import type { FetchResult, Source } from './sources/types.ts'

const golden = (f: string): string => readFileSync(new URL(`../data/fixtures/golden/${f}`, import.meta.url), 'utf8')

type Method = 'circle' | 'hexes' | 'all'
const BODIES: Record<Method, string> = {
  circle: golden('adsblol-point-ksfo.json'), // adsb.lol envelope, 7 aircraft incl. 000001 (dbFlags 8)
  hexes: golden('adsblol-hex.json'), // adsb.lol envelope: 71bd79, a448f2, a1c7e4
  all: golden('readsb-circle.json'), // readsb envelope, same 7 aircraft as the KSFO point
}

const KSFO = [37.6188, -122.3758] as const
const LLBG = [32.0114, 34.8867] as const // a 5 nm view here is exactly one cell

interface Call {
  t: number
  m: Method
  args: unknown[]
}

/** Fake upstream on a fake clock: records calls, answers golden bodies; queued replies override the status. */
function fakeSource(clock: { t: number }, fullSnapshot: boolean) {
  const calls: Call[] = []
  const replies: { status: number; retryAfterS?: number }[] = []
  const reply = (m: Method, args: unknown[]): Promise<FetchResult> => {
    calls.push({ t: clock.t, m, args })
    const { status, retryAfterS } = replies.shift() ?? { status: 200 }
    const body = status === 200 ? BODIES[m] : ''
    const snapshot = status === 200 ? (m === 'all' ? normalizeReadsb(body) : normalizeAdsblol(body)) : null
    const r = { url: `fake:${m}`, status, tSendMs: clock.t, tRecvMs: clock.t, bytes: body.length || 100, body, retryAfterS: retryAfterS ?? null, snapshot }
    return Promise.resolve(r)
  }
  const source: Source = {
    caps: { kind: fullSnapshot ? 'readsb' : 'adsblol', fullSnapshot, maxRps: fullSnapshot ? 5 : 1, coverage: null, attribution: 'test' },
    circle: (lat, lon, radiusNm) => reply('circle', [lat, lon, radiusNm]),
    hexes: (hexes) => reply('hexes', [hexes]),
    all: () => (fullSnapshot ? reply('all', []) : Promise.reject(new Error('unsupported'))),
  }
  return { source, calls, replies }
}

const T0 = 1_000_000

function setup(o: { fullSnapshot?: boolean; maxRps?: number; hideFlagged?: boolean; recorder?: Recorder; opts?: Partial<PollerOpts> } = {}) {
  const clock = { t: T0 }
  const f = fakeSource(clock, o.fullSnapshot ?? false)
  const store = new SampleStore()
  const bucket = new TokenBucket(o.maxRps ?? 100, () => clock.t, () => 0)
  const poller = new Poller(f.source, store, bucket, {
    cellPeriodMs: 3000,
    chasePeriodMs: 1000,
    fullSnapshotPeriodMs: 1000,
    interestTtlMs: 15_000,
    chaseTtlMs: 10_000,
    recorder: o.recorder ?? null,
    hideFlagged: o.hideFlagged ?? true,
    nowMs: () => clock.t,
    ...o.opts,
  })
  return { clock, store, bucket, poller, ...f }
}

/** Ticks every 100 ms from the current fake time up to and including T0 + untilMs. */
async function runUntil(s: ReturnType<typeof setup>, untilMs: number, each?: () => void): Promise<void> {
  for (; s.clock.t <= T0 + untilMs; s.clock.t += 100) {
    each?.()
    await s.poller.tick()
  }
}

const rel = (calls: Call[], m?: Method): number[] => calls.filter((c) => m === undefined || c.m === m).map((c) => c.t - T0)

test('touchView registers the cells of cellsForView and returns them', () => {
  const s = setup()
  const cells = s.poller.touchView(KSFO[0], KSFO[1], 40)
  assert.deepEqual(cells, cellsForView(KSFO[0], KSFO[1], 40))
  assert.equal(cells.length, 3)
  assert.deepEqual(s.poller.report().cells.map((c) => c.id), cells.map((c) => c.id))
  assert.ok(s.poller.report().cells.every((c) => c.lastOkMs === null && c.periodP95S === null))
})

test('chase batch goes before a due cell; the cell gets the next token', async () => {
  const s = setup()
  s.poller.touchView(LLBG[0], LLBG[1], 5)
  s.poller.touchChase('A1C7E4')
  assert.equal(await s.poller.tick(), true)
  assert.deepEqual(s.calls[0], { t: T0, m: 'hexes', args: [['a1c7e4']] })
  s.clock.t += 100
  assert.equal(await s.poller.tick(), true)
  assert.equal(s.calls[1].m, 'circle')
})

test('while chasing, a cell only gets a token when one is left for the next chase', async () => {
  // 1 req/s with a 1 s chase: the chase uses every token; the cell never makes the chase wait
  const s = setup({ maxRps: 1 })
  s.poller.touchView(LLBG[0], LLBG[1], 5)
  s.poller.touchChase('a1c7e4')
  await runUntil(s, 6000)
  // (The bucket accrues 0.1 token per 100 ms tick in floating point, so a token can show up one tick late.)
  const chase = rel(s.calls, 'hexes')
  assert.equal(chase[0], 0)
  assert.ok(chase.length >= 5)
  for (let i = 1; i < chase.length; i++) assert.ok(chase[i] - chase[i - 1] <= 1100, `${chase}`)
  assert.deepEqual(rel(s.calls, 'circle'), [])

  // 1 req/s with a 1.4 s chase: the cell gets the spare 0.29 token/s and the chase keeps its period
  const t = setup({ maxRps: 1, opts: { chasePeriodMs: 1400 } })
  await runUntil(t, 60_000, () => {
    if ((t.clock.t - T0) % 5000 !== 0) return
    t.poller.touchView(LLBG[0], LLBG[1], 5)
    t.poller.touchChase('a1c7e4')
  })
  const r = t.poller.report()
  assert.equal(r.chasePeriodP95S, 1.4)
  assert.ok(r.cellPeriodP95S !== null && r.cellPeriodP95S >= 3 && r.cellPeriodP95S <= 4.5, `cell p95 ${r.cellPeriodP95S}`)
  assert.ok(r.requestsTotal <= 62, `${r.requestsTotal} requests in 60 s at 1 req/s`)
})

test('each cell is polled once per cellPeriodMs, most overdue first', async () => {
  const s = setup()
  const cells = s.poller.touchView(KSFO[0], KSFO[1], 40)
  await runUntil(s, 6500)
  const at = (i: number): number[] => s.calls.filter((c) => c.args[0] === cells[i].lat && c.args[1] === cells[i].lon).map((c) => c.t - T0)
  assert.deepEqual(at(0), [0, 3000, 6000])
  assert.deepEqual(at(1), [100, 3100, 6100])
  assert.deepEqual(at(2), [200, 3200, 6200])
  assert.deepEqual(s.calls[0].args, [cells[0].lat, cells[0].lon, cells[0].radiusNm])
  assert.equal(s.calls.length, 9)
})

test('interest expires after interestTtlMs; touching again extends it', async () => {
  const s = setup()
  s.poller.touchView(LLBG[0], LLBG[1], 5)
  await runUntil(s, 20_000)
  assert.deepEqual(rel(s.calls), [0, 3000, 6000, 9000, 12_000])
  assert.deepEqual(s.poller.report().cells, [])

  const s2 = setup()
  s2.poller.touchView(LLBG[0], LLBG[1], 5)
  await runUntil(s2, 25_000, () => {
    if (s2.clock.t === T0 + 10_000) s2.poller.touchView(LLBG[0], LLBG[1], 5)
  })
  assert.deepEqual(rel(s2.calls), [0, 3000, 6000, 9000, 12_000, 15_000, 18_000, 21_000, 24_000])
})

test('a chase expires after chaseTtlMs', async () => {
  const s = setup()
  s.poller.touchChase('a1c7e4')
  assert.deepEqual(s.poller.report().chasedHexes, ['a1c7e4'])
  await runUntil(s, 12_000)
  assert.deepEqual(rel(s.calls, 'hexes'), [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000])
  assert.deepEqual(s.poller.report().chasedHexes, [])
})

test('the chase batch holds at most 100 hexes, most recently touched first', async () => {
  const s = setup()
  for (let i = 0; i < 150; i++) {
    s.poller.touchChase(i.toString(16).padStart(6, '0'))
    s.clock.t += 1
  }
  await s.poller.tick()
  const batch = s.calls[0].args[0] as string[]
  assert.equal(batch.length, 100)
  assert.equal(batch[0], (149).toString(16).padStart(6, '0'))
  assert.ok(!batch.includes('000000'))
})

test('429: no request until Retry-After has passed, then one probe; degraded rate-limited', async () => {
  const s = setup({ maxRps: 1 })
  s.poller.touchChase('a1c7e4')
  s.replies.push({ status: 429, retryAfterS: 5 })
  assert.equal(await s.poller.tick(), true)
  assert.equal(s.poller.brief().degraded, 'rate-limited')
  for (s.clock.t = T0 + 100; s.clock.t < T0 + 5000; s.clock.t += 100) assert.equal(await s.poller.tick(), false)
  assert.equal(s.calls.length, 1)
  s.poller.touchChase('a1c7e4')
  assert.equal(await s.poller.tick(), true)
  assert.deepEqual(rel(s.calls), [0, 5000])
  assert.equal(s.poller.report().budget.counts.r429, 1)
})

test('403: blocked for good, degraded blocked', async () => {
  const s = setup()
  s.poller.touchView(LLBG[0], LLBG[1], 5)
  s.replies.push({ status: 403 })
  assert.equal(await s.poller.tick(), true)
  for (let i = 0; i < 20; i++) {
    s.clock.t += 60_000
    s.poller.touchView(LLBG[0], LLBG[1], 5)
    s.poller.touchChase('a1c7e4')
    assert.equal(await s.poller.tick(), false)
  }
  assert.equal(s.calls.length, 1)
  assert.equal(s.poller.brief().degraded, 'blocked')
  assert.equal(s.poller.report().budget.blocked, true)
})

test('fullSnapshot source: all() once per fullSnapshotPeriodMs, never circle or hexes', async () => {
  const s = setup({ fullSnapshot: true })
  assert.deepEqual(s.poller.touchView(KSFO[0], KSFO[1], 40), [])
  s.poller.touchChase('a1c7e4')
  await runUntil(s, 3500)
  assert.deepEqual(s.calls.map((c) => c.m), ['all', 'all', 'all', 'all'])
  assert.deepEqual(rel(s.calls), [0, 1000, 2000, 3000])
  assert.equal(s.store.latest('a1c7e4')?.lat, 39.788635)
  const b = s.poller.brief()
  assert.deepEqual(b, { source: 'readsb', degraded: null, cellPeriodP95S: 1, chasePeriodP95S: 1 })
})

test('samples land in the store in server clock: upstream now − seen_pos + (tRecv − now)', async () => {
  const s = setup()
  s.poller.touchChase('71bd79')
  await s.poller.tick()
  const snap = normalizeAdsblol(BODIES.hexes)
  const ac = snap.aircraft.find((a) => a.hex === '71bd79')!
  const got = s.store.latest('71bd79')!
  assert.equal(got.tMs, T0 - Math.round(ac.seen_pos! * 1000))
  assert.equal(got.rxMs, T0)
  assert.equal(s.store.size, 3)
  // a later, slower answer does not move the offset (windowed minimum): the re-served body adds nothing
  s.clock.t += 1000
  await s.poller.tick()
  assert.equal(s.store.size, 3)
})

test('hidden (PIA/LADD) aircraft are dropped unless hideFlagged is false', async () => {
  const hide = setup()
  hide.poller.touchView(LLBG[0], LLBG[1], 5)
  await hide.poller.tick()
  assert.equal(hide.store.latest('000001'), null)
  assert.notEqual(hide.store.latest('71bd79'), null)
  assert.equal(hide.store.size, 6)

  const show = setup({ hideFlagged: false })
  show.poller.touchView(LLBG[0], LLBG[1], 5)
  await show.poller.tick()
  assert.notEqual(show.store.latest('000001'), null)
  assert.equal(show.store.size, 7)
})

test('the recorder receives every result, failures included', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fh-poller-'))
  const s = setup({ recorder: new Recorder(dir) })
  s.poller.touchView(LLBG[0], LLBG[1], 5)
  s.poller.touchChase('a1c7e4')
  s.replies.push({ status: 200 }, { status: 429, retryAfterS: 2 })
  await runUntil(s, 3000) // chase 200 at 0, cell 429 at 100, pause, chase 200 at 2100
  const files = readdirSync(dir)
  assert.deepEqual(files, ['1970-01-01.jsonl'])
  const lines = readRecording(join(dir, files[0]))
  assert.equal(lines.length, s.calls.length)
  assert.deepEqual(lines.map((l) => l.status), [200, 429, 200])
  assert.deepEqual(lines.map((l) => l.url), ['fake:hexes', 'fake:circle', 'fake:hexes'])
  assert.equal(lines[1].body, '')
  assert.equal(lines[0].source, 'adsblol')
})

test('report: periods, counters and bytes per hour', async () => {
  const s = setup()
  s.poller.touchView(LLBG[0], LLBG[1], 5)
  s.poller.touchChase('a1c7e4')
  await runUntil(s, 9950, () => {
    if ((s.clock.t - T0) % 5000 !== 0) return
    s.poller.touchView(LLBG[0], LLBG[1], 5)
    s.poller.touchChase('a1c7e4')
  })
  const r = s.poller.report()
  assert.equal(r.source, 'adsblol')
  assert.equal(r.degraded, null)
  assert.equal(r.requestsTotal, s.calls.length)
  assert.equal(r.requestsTotal, 10 + 4) // chase at 0..9000, cell at 100, 3100, 6100, 9100
  assert.equal(r.chasePeriodP95S, 1)
  assert.equal(r.cellPeriodP95S, 3)
  assert.equal(r.cells.length, 1)
  assert.equal(r.cells[0].lastOkMs, T0 + 9100)
  assert.equal(r.cells[0].periodP95S, 3)
  assert.deepEqual(r.chasedHexes, ['a1c7e4'])
  assert.equal(r.budget.counts.ok, 14)
  // under a minute of data is scaled up from a one-minute floor
  const bytes = 10 * BODIES.hexes.length + 4 * BODIES.circle.length
  assert.equal(r.bytesPerHourEstimate, bytes * 60)

  // bytes older than an hour no longer count
  s.clock.t += 2 * 3_600_000
  assert.equal(s.poller.report().bytesPerHourEstimate, 0)
})

test('brief before any response: nulls, not zeros', () => {
  const s = setup()
  assert.deepEqual(s.poller.brief(), { source: 'adsblol', degraded: null, cellPeriodP95S: null, chasePeriodP95S: null })
})

test('start() ticks every 100 ms without overlapping ticks; stop() ends it', async () => {
  let inFlight = 0
  let maxInFlight = 0
  let calls = 0
  const body = BODIES.all
  const source: Source = {
    caps: { kind: 'readsb', fullSnapshot: true, maxRps: 5, coverage: null, attribution: 'test' },
    circle: () => Promise.reject(new Error('unexpected')),
    hexes: () => Promise.reject(new Error('unexpected')),
    all: async () => {
      calls++
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await sleep(250) // a slow upstream: each request spans several 100 ms timer ticks
      inFlight--
      const t = Date.now()
      return { url: 'fake:all', status: 200, tSendMs: t, tRecvMs: t, bytes: body.length, body, retryAfterS: null, snapshot: normalizeReadsb(body) }
    },
  }
  const opts: PollerOpts = { cellPeriodMs: 3000, chasePeriodMs: 1000, fullSnapshotPeriodMs: 0, interestTtlMs: 15_000, chaseTtlMs: 10_000, recorder: null, hideFlagged: true }
  const p = new Poller(source, new SampleStore(), new TokenBucket(100), opts)
  p.start()
  p.start() // idempotent
  await sleep(1000)
  p.stop()
  const atStop = calls
  await sleep(500)
  assert.equal(maxInFlight, 1)
  assert.ok(atStop >= 2 && atStop <= 4, `calls=${atStop}`)
  assert.equal(calls, atStop)
  assert.equal(inFlight, 0)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test server/poller.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/server/poller.ts' imported from …/server/poller.test.ts`

- [ ] **Step 3: Write the implementation**

```ts
// server/poller.ts
import type { CellStatus, StatusBrief, StatusReport } from '../shared/api.ts'
import { MinOffset } from '../shared/clock.ts'
import { isHidden, toSample } from '../shared/sample.ts'
import type { TokenBucket } from './budget.ts'
import { cellsForView, type Cell } from './cells.ts'
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
    return {
      source: this.#source.caps.kind,
      degraded: this.#bucket.degraded,
      cellPeriodP95S: p95S(cellIntervals),
      chasePeriodP95S: p95S(this.#chaseOk.intervals),
    }
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

  /** Budget, recorder, clock offset, store. Returns whether the answer was good (200 and parsed). */
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
    for (const ac of snap.aircraft) {
      if (this.#opts.hideFlagged && isHidden(ac)) continue
      const s = toSample(ac, snap.nowMs, offsetMs, r.tRecvMs)
      if (s) this.#store.add(s)
    }
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

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test server/poller.test.ts`
Expected: PASS — `ℹ tests 16`, `ℹ pass 16`, `ℹ fail 0`. The last test uses real timers and takes ≈ 1.5 s; the others take milliseconds.

- [ ] **Step 5: Commit**

```bash
git add server/poller.ts server/poller.test.ts
git commit -m "feat(server): poller with chase-first budget, server-clock stamping and status" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: WP gate

- [ ] **Step 1: All tests of this package**

Run: `node --test server/poller.test.ts`
Expected: `ℹ tests 16`, `ℹ pass 16`, `ℹ fail 0`.

- [ ] **Step 2: Type-check, filtered to this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E '^server/poller'`
Expected: no output (grep exit status 1).

- [ ] **Step 3: Full check in the worktree**

Run: `npm run check`
Expected: `tsc` silent; `ℹ fail 0` (the test count is WP-00 + the merged Wave 1 packages + 16).

- [ ] **Step 4: Nothing left uncommitted**

Run: `git status --short`
Expected: no output. The branch is ready to merge (PLAN.md §5 step 4).

**Gate G1 note for the orchestrator:** with the S4 contract (`cellsForView` returns every cell whose ≈ 182 nm query circle meets the view), a 40 nm view is 2–3 cells. At 1 req/s one chase and one view cannot meet both G1 thresholds (chase p95 ≤ 1.5 s and cell p95 ≤ 3.5 s) — see the budget table. At `MAX_RPS=0.5` the chase alone cannot reach 1.5 s. This package cannot fix that inside its contract. Options, for the orchestrator to choose: (a) WP-S4 returns a minimal cover, often a single cell, because a cell's ≈ 182 nm query radius is much larger than a typical view radius; (b) G1 measures cell periods with no chase running, or scales the cell threshold by the budget that is left after the chase; (c) at `MAX_RPS=0.5`, stop the arrival recorder during G1 instead of halving the rate, or scale the chase threshold like the cell threshold.

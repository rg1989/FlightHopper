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
- Code blocks preceded by `File: \`path\`` contain that file's complete content. Test-file edits are given as exact insertions and replacements, and Step 1 also gives both test files complete (2026-09-23, for mechanical application).

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

The two test files after these edits, complete (for mechanical application; the edits above say what changed):

File: `server/poller.test.ts`
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
const DAY_MS = 86_400_000
// When the golden bodies were recorded: their own upstream `now`, in ms (2026-09-22).
const ALL_NOW_MS = normalizeReadsb(BODIES.all).nowMs // 1_790_081_633_500
const HEXES_NOW_MS = normalizeAdsblol(BODIES.hexes).nowMs // 1_790_081_641_500

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
  assert.deepEqual(b, { source: 'readsb', degraded: null, cellPeriodP95S: 1, chasePeriodP95S: 1, upstreamOffsetMs: T0 - ALL_NOW_MS })
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

File: `server/main.test.ts`
```ts
// server/main.test.ts
// End-to-end: the real server on port 0 against a recording. No network beyond 127.0.0.1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { ChaseResponse, StatusReport, ViewResponse } from '../shared/api.ts'
import { distanceNm } from '../shared/geo.ts'
import type { SourceKind } from '../shared/types.ts'
import { startFakeReadsb } from '../tools/fake-readsb.ts'
import { readServerConfig } from './config.ts'
import { createServer } from './main.ts'
import { readRecording } from './recording.ts'
import { makeReplay } from './sources/replay.ts'

const FILE = fileURLToPath(new URL('../data/fixtures/golden/recording-sample.jsonl', import.meta.url))
const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))
const KSFO = { lat: 37.6188, lon: -122.3758 }
const CHASED = 'a067ec' // airborne ADS-B v2 near KSFO; moves between the recording's two real polls (2.5 s apart)
const HIDDEN = '000002' // dbFlags 8 (LADD)
const T0 = 2_000_000_000_000 // injected server clock, far from the recording's (1.79e12): proves the rebase

const tmp = (): string => mkdtempSync(join(tmpdir(), 'fh-main-'))

async function get<T>(url: string): Promise<{ status: number; type: string | null; body: T }> {
  const res = await fetch(url)
  return { status: res.status, type: res.headers.get('content-type'), body: (await res.json()) as T }
}

async function getText(url: string, method = 'GET'): Promise<{ status: number; type: string | null; body: string }> {
  const res = await fetch(url, { method })
  return { status: res.status, type: res.headers.get('content-type'), body: await res.text() }
}

/** GET with the path sent byte for byte (fetch would resolve '..' before sending). */
function rawGet(base: string, path: string): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(base)
  return new Promise((resolve, reject) => {
    request({ hostname, port, path }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
      .on('error', reject)
      .end()
  })
}

async function waitFor<T>(what: string, fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 8000): Promise<T> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

const viewUrl = (base: string, since: number, nm = 10): string => `${base}/api/view?lat=${KSFO.lat}&lon=${KSFO.lon}&nm=${nm}&since=${since}`

/**
 * What a client sees, identical for every source. Run once per source, this is the flip test.
 * advance() lets the upstream move past the recording's second real poll.
 */
async function assertApi(base: string, kind: SourceKind, advance: () => void): Promise<void> {
  // 1. First view (since=0): the latest sample per aircraft inside the circle, stamped in server clock.
  const v1 = await waitFor('first samples', () => get<ViewResponse>(viewUrl(base, 0)), (r) => r.body.samples.length > 0)
  assert.equal(v1.status, 200)
  assert.equal(v1.type, 'application/json')
  assert.equal(v1.body.status.source, kind)
  assert.equal(v1.body.status.degraded, null)
  const first = v1.body.samples
  assert.equal(new Set(first.map((s) => s.hex)).size, first.length, 'since=0 gives one sample per aircraft')
  assert.ok(first.some((s) => s.hex === CHASED))
  assert.ok(!first.some((s) => s.hex === HIDDEN), 'LADD aircraft are hidden by default')
  for (const s of first) {
    assert.ok(distanceNm(KSFO.lat, KSFO.lon, s.lat, s.lon) <= 10, s.hex)
    assert.ok(s.tMs <= v1.body.serverNowMs && s.tMs > v1.body.serverNowMs - 60_000, `${s.hex} tMs ${s.tMs} vs server ${v1.body.serverNowMs}`)
    assert.ok(s.rxMs <= v1.body.serverNowMs)
  }

  // 2. Poll again with since = the newest rxMs seen: only samples that arrived later, each newer than before.
  const since = Math.max(...first.map((s) => s.rxMs))
  advance()
  const v2 = await waitFor('newer samples', () => get<ViewResponse>(viewUrl(base, since)), (r) => r.body.samples.length > 0)
  const before = new Map(first.map((s) => [s.hex, s]))
  for (const s of v2.body.samples) {
    assert.ok(s.rxMs > since, `${s.hex} rxMs ${s.rxMs} ≤ since ${since}`)
    const old = before.get(s.hex)
    if (old) assert.ok(s.tMs > old.tMs, `${s.hex} is newer than its first sample`)
  }
  assert.ok(v2.body.samples.some((s) => s.hex === CHASED))

  // 3. Chase: the stored track of one aircraft, oldest first; hex case does not matter.
  const c1 = await get<ChaseResponse>(`${base}/api/chase?hex=${CHASED.toUpperCase()}&since=0`)
  assert.equal(c1.status, 200)
  assert.equal(c1.type, 'application/json')
  assert.equal(c1.body.status.source, kind)
  const track = c1.body.samples
  assert.ok(track.length >= 2, `track has ${track.length} samples`)
  assert.ok(track.every((s) => s.hex === CHASED))
  for (let i = 1; i < track.length; i++) assert.ok(track[i].tMs > track[i - 1].tMs)
  const c2 = await get<ChaseResponse>(`${base}/api/chase?hex=${CHASED}&since=${track.at(-1)!.rxMs}`)
  assert.deepEqual(c2.body.samples, [], 'the recording has no later position')

  // 4. Status: the poller's report.
  const st = await get<StatusReport>(`${base}/api/status`)
  assert.equal(st.status, 200)
  assert.equal(st.type, 'application/json')
  const keys = ['budget', 'bytesPerHourEstimate', 'cellPeriodP95S', 'cells', 'chasePeriodP95S', 'chasedHexes', 'degraded', 'requestsTotal', 'source', 'upstreamOffsetMs']
  assert.deepEqual(Object.keys(st.body).sort(), keys)
  assert.equal(st.body.source, kind)
  assert.equal(st.body.degraded, null)
  assert.deepEqual(st.body.cells, [], 'full-snapshot sources poll no cells')
  assert.deepEqual(st.body.chasedHexes, [CHASED])
  assert.equal(st.body.budget.maxRps, 1)
  assert.equal(st.body.budget.blocked, false)
  assert.ok(st.body.requestsTotal >= 2)
  assert.ok(st.body.bytesPerHourEstimate > 0)
  assert.equal(typeof st.body.cellPeriodP95S, 'number')

  // 5. Bad parameters: 400 with a JSON error.
  const bad = [
    '/api/view?lon=0&nm=10',
    '/api/view?lat=&lon=0&nm=10',
    '/api/view?lat=91&lon=0&nm=10',
    '/api/view?lat=0&lon=-181&nm=10',
    '/api/view?lat=0&lon=0&nm=0',
    '/api/view?lat=0&lon=0&nm=ten',
    '/api/view?lat=0&lon=0&nm=10&since=-1',
    '/api/chase',
    '/api/chase?hex=a067e',
    '/api/chase?hex=xyz123',
    '/api/chase?hex=a067ec&since=soon',
  ]
  for (const path of bad) {
    const r = await get<{ error: string }>(base + path)
    assert.equal(r.status, 400, path)
    assert.equal(r.type, 'application/json', path)
    assert.equal(typeof r.body.error, 'string', path)
  }
}

test('replay on an injected server clock: view, since, chase, status, 400s; replay is never recorded', async (t) => {
  const clock = { t: T0 }
  const nowMs = (): number => clock.t
  const dir = tmp()
  const recordDir = join(dir, 'rec')
  const cfg = { ...readServerConfig({ REPLAY_FILES: FILE, RECORD_DIR: recordDir }), staticDir: join(dir, 'dist') }
  const app = createServer(cfg, { source: makeReplay({ files: cfg.replayFiles, nowMs }), nowMs })
  const base = await app.listen(0)
  t.after(() => app.close())
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/)

  await assertApi(base, 'replay', () => {
    clock.t += 2500
  })

  // Every sample was received at one of the two injected instants, and serverNowMs is the injected clock.
  const v = await get<ViewResponse>(viewUrl(base, 0))
  assert.equal(v.body.serverNowMs, T0 + 2500)
  // The replay tells the client how long ago it was recorded: server clock − the recording's clock (sun time, D12).
  assert.equal(v.body.status.upstreamOffsetMs, T0 - readRecording(FILE)[0].tRecvMs)
  const chase = await get<ChaseResponse>(`${base}/api/chase?hex=${CHASED}&since=0`)
  assert.deepEqual([...new Set(chase.body.samples.map((s) => s.rxMs))], [T0, T0 + 2500])
  assert.equal(existsSync(recordDir), false, 'RECORD_DIR is ignored for replay')
  // No dist/ here: the client is simply missing.
  const home = await getText(`${base}/`)
  assert.equal(home.status, 404)
  assert.match(home.body, /npm run build/)
})

test('flip: the same API from ADSB_SOURCE=readsb against a fake receiver serving the same recording', async (t) => {
  const fake = await startFakeReadsb({ files: [FILE], port: 0 })
  t.after(() => fake.close())
  const dir = tmp()
  const recordDir = join(dir, 'rec')
  const env = { ADSB_SOURCE: 'readsb', READSB_URL: fake.url, READSB_COVERAGE: '37.6188,-122.3758,200', RECORD_DIR: recordDir }
  const cfg = { ...readServerConfig(env), staticDir: join(dir, 'dist') }
  const app = createServer(cfg) // source from makeSource(cfg), real clock: what `npm run server` builds
  const base = await app.listen(0)
  t.after(() => app.close())

  await assertApi(base, 'readsb', () => {}) // real time: the fake receiver reaches the second poll 2.5 s after start

  const lines = readdirSync(recordDir).flatMap((f) => readRecording(join(recordDir, f)))
  assert.ok(lines.length >= 2, `${lines.length} recorded polls`)
  assert.ok(lines.every((l) => l.source === 'readsb' && l.url.startsWith(`${fake.url}/?`)))
})

test('SHOW_PIA_LADD=1 serves PIA/LADD aircraft too', async (t) => {
  const clock = { t: T0 }
  const nowMs = (): number => clock.t
  const cfg = { ...readServerConfig({ REPLAY_FILES: FILE, SHOW_PIA_LADD: '1' }), staticDir: join(tmp(), 'dist') }
  const app = createServer(cfg, { source: makeReplay({ files: cfg.replayFiles, nowMs }), nowMs })
  const base = await app.listen(0)
  t.after(() => app.close())
  const v = await waitFor('first samples', () => get<ViewResponse>(viewUrl(base, 0)), (r) => r.body.samples.length > 0)
  assert.ok(v.body.samples.some((s) => s.hex === HIDDEN))
})

test('a view wider than 250 nm is served, not rejected', async (t) => {
  const clock = { t: T0 }
  const nowMs = (): number => clock.t
  const cfg = { ...readServerConfig({ REPLAY_FILES: FILE }), staticDir: join(tmp(), 'dist') }
  const app = createServer(cfg, { source: makeReplay({ files: cfg.replayFiles, nowMs }), nowMs })
  const base = await app.listen(0)
  t.after(() => app.close())
  const v = await waitFor('first samples', () => get<ViewResponse>(viewUrl(base, 0, 3000)), (r) => r.body.samples.length > 0)
  assert.equal(v.status, 200)
})

test('static: dist/ files with content types, index.html for client routes, 404 for missing assets and traversal', async (t) => {
  const dir = tmp()
  const dist = join(dir, 'dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>FlightHopper</title>')
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(dist, 'assets', 'app.css'), 'body{}')
  writeFileSync(join(dist, 'assets', 'data.bin'), 'x')
  writeFileSync(join(dir, 'secret.txt'), 'TOP SECRET')
  const app = createServer({ ...readServerConfig({ REPLAY_FILES: FILE }), staticDir: dist })
  const base = await app.listen(0)
  t.after(() => app.close())

  const home = await getText(`${base}/`)
  assert.equal(home.status, 200)
  assert.equal(home.type, 'text/html; charset=utf-8')
  assert.match(home.body, /FlightHopper/)
  assert.deepEqual(await getText(`${base}/assets/app.js`), { status: 200, type: 'text/javascript; charset=utf-8', body: 'console.log(1)' })
  assert.equal((await getText(`${base}/assets/app.css`)).type, 'text/css; charset=utf-8')
  assert.equal((await getText(`${base}/assets/data.bin`)).type, 'application/octet-stream')
  for (const route of ['/?hex=a067ec&bench=1', '/chase/a067ec', '/assets/']) {
    const r = await getText(base + route)
    assert.equal(r.status, 200, route)
    assert.match(r.body, /FlightHopper/, route)
  }
  assert.equal((await getText(`${base}/assets/missing.js`)).status, 404)
  const api = await getText(`${base}/api/nope`)
  assert.equal(api.status, 404)
  assert.equal(api.type, 'application/json')
  assert.equal((await getText(`${base}/api/status`, 'POST')).status, 405)

  const attacks = [
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/..%2fsecret.txt',
    '/assets/..%2f..%2fsecret.txt',
    '/assets/%2e%2e%2f%2e%2e%2fsecret.txt',
    '/..%5csecret.txt',
    '/%00',
    '/%zz',
  ]
  for (const path of attacks) {
    const r = await rawGet(base, path)
    assert.equal(r.status, 404, path)
    assert.doesNotMatch(r.body, /TOP SECRET/, path)
  }
})

test('CLI: `node server/main.ts` reads the environment and serves', async (t) => {
  const child = spawn(process.execPath, [MAIN], {
    env: { ADSB_SOURCE: 'replay', REPLAY_FILES: FILE, PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  t.after(() => child.kill())
  let out = ''
  child.stdout.setEncoding('utf8')
  const base = await new Promise<string>((resolve, reject) => {
    child.stdout.on('data', (c: string) => {
      out += c
      const m = /http:\/\/127\.0\.0\.1:\d+/.exec(out)
      if (m) resolve(m[0])
    })
    child.on('exit', (code) => reject(new Error(`exited ${code}: ${out}`)))
  })
  assert.match(out, /source replay/)
  const st = await get<StatusReport>(`${base}/api/status`)
  assert.equal(st.status, 200)
  assert.equal(st.body.source, 'replay')
})

test('CLI: a config error exits 1 with the message (adsblol without CONTACT; nothing is fetched)', async () => {
  const child = spawn(process.execPath, [MAIN], { env: { ADSB_SOURCE: 'adsblol' }, stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (c: string) => (err += c))
  const [code] = await once(child, 'exit')
  assert.equal(code, 1)
  assert.match(err, /^server: CONTACT is required for ADSB_SOURCE=adsblol/)
})
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

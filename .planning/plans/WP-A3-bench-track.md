# WP-A3 — Bench CLI (G2 motion bench) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command that turns recorded upstream polls into the G2 motion verdict. It replays the recordings causally through the real server stamping and the real client estimator (`TrackRegistry`, `RenderClock`), renders the chosen aircraft at 60 Hz, and scores the frames with `tools/metrics.ts`: interpolation discontinuity, starvation, held-out cross-track error in turns (decimated to 3 s and 5 s, against linear), lateral acceleration, vertical fidelity, delay slew, extrapolation re-join, dedupe. `evaluateG2` applies the PLAN.md §6 bars. The CLI writes `.planning/reports/G2-<hex>-<date>.json` and prints a table.

**Architecture:** One file, `tools/bench-track.ts`, with no state between runs:
- **Lines:** `readRecording` (WP-00) per file, merged into one list and stable-sorted by `tRecvMs` (arrival order).
- **Server stamping:** `forEachSample` is `recordingToSamples` with the Deduper's verdict passed out instead of acted on. It uses the same `MinOffset(10 min)`, updated before each line, `toSample`, and PIA/LADD hidden, with `rxMs = tRecvMs`. Stamping is causal (a sample depends only on earlier lines), so stamping everything first and then showing each sample only to polls after its `rxMs` equals stamping line by line as they arrive. The test proves that the deduped output equals `recordingToSamples`.
- **Which aircraft and which stretch:** `--hex`, or else the hex with the most deduped samples in the `--from/--to` window (by sample `tMs`). Its samples are split at silences longer than 60 s, and the longest session is benched (`ponytail:`: one session per run). One `Enu` at the session's first sample, h = 0. Frame `e, n` come from `fwd(lat, lon, 0)` and `u = hM` (HAE), as T2 asks (no tangent-plane drop in `u`). `Frame.t` and every other time are seconds since the first sample's `tMs`. Relative times keep 60 Hz finite differences exact: absolute epoch seconds lose 2.4e-7 s per frame, which would read as up to ≈ 0.2 m/s² of fake acceleration at 250 m/s.
- **Simulated client:** it polls the chased hex every 1 s, from the first sample's `rxMs + 100 ms`. Each poll ingests every sample with `rxMs ≤ poll − 100 ms` that it has not delivered yet (`TrackRegistry.ingest`, `pollPeriodS: 1`). The render loop runs at 60 Hz from the first poll + D, where D is `registry.delayTargetS(hex)` after that poll, so the first render time is the first poll. Each frame does: deliver any polls due, `RenderClock.tick(serverNow = simulation time, registry.delayTargetS(hex), dt)`, then `Track.stateAt`. That is the frame order I2's notes prescribe. The loop stops when render time passes the newest sample. It records `Frame[]` (with mode and attitude) and the delay series `{ t: server time, d }`. `RateAt` values come from the samples: geometric rate for v2 when present, else barometric, × 0.00508.
- **Starvation vs coverage gap:** a frame that is not `'interp'` counts as **starvation** when the samples around its render time are ≤ `MAX_DELAY_S` (10 s) apart. At that spacing some allowed delay would have covered it. It counts as a **gap frame** when they are further apart (the aircraft was out of coverage). Gap frames are reported, not gated.
- **Re-join:** at every return to `'interp'`, a fresh `Track` fed the samples from 100 s before to 30 s after gives the hindsight estimate. The error is the horizontal distance on screen vs hindsight at the last frame before the new data. The blend time runs from that frame until the rendered frame is within `max(0.5 m, 1 % of the error)` of hindsight. It is Infinity if 3 s of interpolation never get there. With no re-join, `blendMaxS` is 0.
- **Decimation:** for each k (default 3 and 5), keep every k-th session sample, replay those through the same client, and score the held-out rest with `crossTrackErrors`. A held-out point is a turn when `|turnRateDegS(prev.track, next.track)| > 1 °/s`; points without a reported track are skipped. The baseline is the straight line between the kept samples around each turn point, at the same time.
- **Dedupe:** `served` = every positioned copy of the hex in the session, `unique` = the Deduper's survivors, `duplicateFraction = 1 − unique/served`. `--no-dedupe` replays `served` as well and reports its jerk p99.
- **Bars (`evaluateG2`):** the ADS-B v2 table checks interpolation discontinuity max ≤ 2 m, starvation = 0, turn cross-track p95 ≤ 5 m at k = 3 and ≤ 15 m at k = 5, both ≤ 50 % of linear, lateral acceleration p99 ≤ 5.7 m/s², VS error p95 ≤ 2 m/s, height step ≤ 1 m per frame, delay slew ≤ 0.2 s/s, and re-join blend ≤ 1.5 s. An MLAT hex is held only to its separate bar, lateral acceleration p99 ≤ 0.5 g. A NaN value (no data) fails. A missing k = 3 or 5 fails. 1e-9 absorbs float noise at a bar.

**Tech Stack:** Node ≥ 24.2 (native TypeScript), `node:test`, TypeScript 7 (type-check only). Stdlib `node:fs` (`globSync`), `node:util` (`parseArgs`). No dependencies beyond WP-00's.

**Wave:** 3 (needs WP-00, I2 and T2 merged; I2 brings C1–C5). **Estimated:** 2 h. **Validated:** on 2026-09-22 with Node v25.2.1 and TypeScript 7.0.2, in the shared sandbox that holds WP-00, every Wave 1 file, I2, T2 and `node_modules`. The code below was generated from the tested files, byte for byte. Task 1 went RED with `ERR_MODULE_NOT_FOUND`, then GREEN 4/4. Task 2 went RED with `SyntaxError: The requested module './bench-track.ts' does not provide an export named 'benchTrack'`, then GREEN: `node --test tools/bench-track.test.ts` → 12/12 pass in ≈ 0.4 s. `npx tsc --noEmit` reported no errors anywhere, so none in `tools/bench-track*`. The consumed tests also pass: `tools/metrics`, `client/track/{track,registry,delay}`, `server/recording`, 48/48.

Measured on the synthetic test recording (1 Hz, v2, 100 m/s, a 2 °/s turn, a 12 s gap, re-served duplicates):
- D held 3 s throughout, with 0 starvation frames.
- The gap produced 560 gap frames: exactly 8.0 s of extrapolation, then stale.
- 1 re-join: 133 m, blended in 1.43 s. Interpolation discontinuity max 0.153 m, at that re-join.
- Lateral acceleration p99 3.75 m/s² (the turn itself is v·ω = 3.49). VS error p95 0.84 m/s, max step 0.23 m per frame.
- Duplicate fraction 0.219.
- Turn cross-track p95 0.022 m at k = 3 (linear 3.49 m) and 0.030 m at k = 5 (linear 10.47 m).
- Jerk p99 102 m/s³. Horizontal-only jerk is 19.5 m/s³, so the vertical dominates (see the notes).

The CLI was also run on a copy of the real day-1 recording (`data/recordings/2026-09-22.jsonl`, 128 lines, local file, no network):
- Auto picked `a07341` (adsb2), 33 samples in 20 min. D slewed to 10 s.
- 57,936 of 72,740 frames were in coverage gaps, with 0 starvation frames. 32 re-joins, max blend 1.42 s.
- Verdict FAIL, as expected: `record-cells` sees each hex about every 30 s, so there are no turn points and the vertical is sparse. G2 needs WP-I3's 1 Hz hex recordings.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints; they apply to every task here. The ones this package relies on:
- Erasable TypeScript only, `.ts` extensions on relative imports, `if (import.meta.main)` for the CLI.
- Tests: `node:test` + `node:assert/strict`, next to the code, **no network**. The test writes synthetic `RecordLine` files (adsb.lol envelope, url `synthetic`) to `os.tmpdir()` and removes them afterwards. The CLI only reads local recordings. It never talks to adsb.lol.
- `Sample.tMs` is server clock (upstream `now − seen_pos` + windowed min offset). The bench never stamps with a receipt time; `rxMs` only gates when a sample becomes visible.
- Heights: `Frame.u` is `RenderState.hM` (WGS84 ellipsoidal metres).
- This package edits no other package's files. It imports WP-00, C1, C3, C5, I2 and T2 exactly as published.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `tools/bench-track.ts` | `readLines`, `forEachSample`, `benchTrack`, `evaluateG2`, `run` + CLI; types `CrossTrack`, `G2Metrics`, `G2Check`, `BenchOpts`, `BenchResult` |
| `tools/bench-track.test.ts` | synthetic recording (straight, 2 °/s turn, 12 s gap, duplicates, LADD, 429, two files out of order): stamping equivalence, auto hex, starvation vs gap, re-join, finite metrics, dedupe, decimation, window, report file; `evaluateG2` on hand-made metrics |

Runtime output (not committed by this package): `.planning/reports/G2-<hex>-<YYYY-MM-DD>.json`, written by the G2 run.

---

### Task 1: G2 metric set and bars

**Files:**
- Create: `tools/bench-track.ts`, `tools/bench-track.test.ts`
- Test: `tools/bench-track.test.ts`

**Interfaces:**
- Consumes: `Quality` from `shared/types.ts` (WP-00).
- Produces: `interface CrossTrack { k; nTurn; nStraight; turnP95M; straightP95M; linearTurnP95M }` · `interface G2Metrics` (fields as in the code) · `interface G2Check { name: string; value: number; threshold: number; pass: boolean }` · `evaluateG2(m: G2Metrics): { pass: boolean; checks: G2Check[] }`

- [ ] **Step 1: Write the failing test**

```ts
// tools/bench-track.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateG2, type G2Metrics } from './bench-track.ts'

// ---- evaluateG2 on hand-made metrics ----

function good(): G2Metrics {
  return {
    hex: 'abc123', quality: 'adsb2', samples: 200, frames: 12_000,
    delayS: { start: 3, p50: 3, max: 3 },
    starvationFrames: 0, gapFrames: 0,
    frameDiscontinuity: { maxM: 0.5, p99M: 0.01 },
    lateralAccel: { p99: 3.5, max: 4 },
    jerk: { p99: 1 },
    vertical: { vsErrP95: 1, maxStepM: 0.2 },
    delaySlew: 0.2,
    rejoin: { count: 1, errP95M: 200, blendMaxS: 1.45 },
    crossTrack: [
      { k: 3, nTurn: 60, nStraight: 80, turnP95M: 1, straightP95M: 0.5, linearTurnP95M: 3.5 },
      { k: 5, nTurn: 70, nStraight: 90, turnP95M: 4, straightP95M: 1, linearTurnP95M: 10 },
    ],
    dedupe: { served: 250, unique: 200, duplicateFraction: 0.2, jerkP99NoDedupe: null },
  }
}

const failing = (m: G2Metrics): string[] => evaluateG2(m).checks.filter((c) => !c.pass).map((c) => c.name)

test('evaluateG2: a metric set inside every ADS-B v2 bar passes', () => {
  const r = evaluateG2(good())
  assert.equal(r.pass, true)
  assert.deepEqual(r.checks.map((c) => [c.name, c.threshold]), [
    ['frameDiscontinuityMaxM', 2], ['starvationFrames', 0],
    ['crossTrackTurnP95M@3', 5], ['crossTrackTurnVsLinear@3', 0.5], ['crossTrackTurnP95M@5', 15], ['crossTrackTurnVsLinear@5', 0.5],
    ['lateralAccelP99', 5.7], ['vsErrP95', 2], ['verticalMaxStepM', 1], ['delaySlew', 0.2], ['rejoinBlendMaxS', 1.5],
  ])
})

test('evaluateG2: each bar fails on its own', () => {
  const cases: [string, (m: G2Metrics) => void][] = [
    ['frameDiscontinuityMaxM', (m) => (m.frameDiscontinuity.maxM = 2.5)],
    ['starvationFrames', (m) => (m.starvationFrames = 1)],
    ['crossTrackTurnP95M@3', (m) => Object.assign(m.crossTrack[0], { turnP95M: 6, linearTurnP95M: 20 })],
    ['crossTrackTurnVsLinear@3', (m) => Object.assign(m.crossTrack[0], { turnP95M: 2, linearTurnP95M: 3 })],
    ['crossTrackTurnP95M@5', (m) => Object.assign(m.crossTrack[1], { turnP95M: 16, linearTurnP95M: 40 })],
    ['crossTrackTurnVsLinear@5', (m) => Object.assign(m.crossTrack[1], { turnP95M: 6, linearTurnP95M: 10 })],
    ['lateralAccelP99', (m) => (m.lateralAccel.p99 = 5.8)],
    ['vsErrP95', (m) => (m.vertical.vsErrP95 = 2.1)],
    ['verticalMaxStepM', (m) => (m.vertical.maxStepM = 1.2)],
    ['delaySlew', (m) => (m.delaySlew = 0.25)],
    ['rejoinBlendMaxS', (m) => (m.rejoin.blendMaxS = 1.6)],
  ]
  for (const [name, spoil] of cases) {
    const m = good()
    spoil(m)
    assert.deepEqual(failing(m), [name])
    assert.equal(evaluateG2(m).pass, false)
  }
})

test('evaluateG2: no data fails, float noise at a bar does not, no re-join passes', () => {
  const nan = good()
  nan.frameDiscontinuity.maxM = NaN
  assert.deepEqual(failing(nan), ['frameDiscontinuityMaxM'])
  const no5 = good()
  no5.crossTrack = no5.crossTrack.slice(0, 1)
  assert.deepEqual(failing(no5), ['crossTrackTurnP95M@5', 'crossTrackTurnVsLinear@5'])
  const edge = good()
  edge.delaySlew = 0.2 + 1e-12
  edge.lateralAccel.p99 = 5.7
  assert.deepEqual(failing(edge), [])
  const calm = good()
  calm.rejoin = { count: 0, errP95M: NaN, blendMaxS: 0 }
  assert.equal(evaluateG2(calm).pass, true)
  const inf = good()
  inf.rejoin.blendMaxS = Infinity
  assert.deepEqual(failing(inf), ['rejoinBlendMaxS'])
})

test('evaluateG2: an MLAT hex is held to the separate bar, lateral acceleration p99 ≤ 0.5 g', () => {
  const m = good()
  m.quality = 'mlat'
  m.lateralAccel.p99 = 4.8
  m.crossTrack = [] // not gated for MLAT
  const r = evaluateG2(m)
  assert.equal(r.pass, true)
  assert.deepEqual(r.checks.map((c) => c.name), ['lateralAccelP99'])
  assert.ok(Math.abs(r.checks[0].threshold - 4.903325) < 1e-9)
  m.lateralAccel.p99 = 5 // inside the ADS-B bar, outside the MLAT one
  assert.equal(evaluateG2(m).pass, false)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tools/bench-track.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/tools/bench-track.ts' imported from …/tools/bench-track.test.ts` (`ℹ tests 1`, `ℹ fail 1`).

- [ ] **Step 3: Write the implementation**

```ts
// tools/bench-track.ts
// Gate G2 motion bench (PLAN.md §6). Step 1: the metric set and the G2 bars. The causal replay that fills the
// metrics, and the CLI that writes the report, come in the next step.
import type { Quality } from '../shared/types.ts'

const G = 9.80665
const TURN_BAR_M: Record<number, number> = { 3: 5, 5: 15 } // G2: decimated to 3 s / 5 s (1 Hz recordings, so k = seconds)

export interface CrossTrack {
  k: number
  nTurn: number
  nStraight: number
  turnP95M: number
  straightP95M: number
  linearTurnP95M: number // the same held-out turn points scored against straight lines between kept samples
}

export interface G2Metrics {
  hex: string
  quality: Quality // the session's most common quality
  samples: number // deduped samples in the session
  frames: number
  delayS: { start: number; p50: number; max: number }
  starvationFrames: number // not 'interp' although the bracketing samples are ≤ 10 s apart
  gapFrames: number // not 'interp' inside a coverage gap (> 10 s between samples): reported, not gated
  frameDiscontinuity: { maxM: number; p99M: number }
  lateralAccel: { p99: number; max: number }
  jerk: { p99: number }
  vertical: { vsErrP95: number; maxStepM: number }
  delaySlew: number
  rejoin: { count: number; errP95M: number; blendMaxS: number }
  crossTrack: CrossTrack[]
  dedupe: { served: number; unique: number; duplicateFraction: number; jerkP99NoDedupe: number | null }
}

export interface G2Check {
  name: string
  value: number
  threshold: number
  pass: boolean
}

/**
 * G2 motion bars (PLAN.md §6). ADS-B (the v2 table): interpolation discontinuity ≤ 2 m, 0 starvation frames, held-out
 * turn cross-track p95 ≤ 5 m at k = 3 and ≤ 15 m at k = 5 and ≤ 50 % of linear, lateral acceleration p99 ≤ 5.7 m/s²,
 * VS error p95 ≤ 2 m/s, height step ≤ 1 m per frame, delay slew ≤ 0.2 s/s, re-join blended ≤ 1.5 s. An MLAT hex is held
 * to its separate bar only: lateral acceleration p99 ≤ 0.5 g. NaN (no data) fails; 1e-9 absorbs float noise at a bar.
 */
export function evaluateG2(m: G2Metrics): { pass: boolean; checks: G2Check[] } {
  const check = (name: string, value: number, threshold: number): G2Check => ({ name, value, threshold, pass: value <= threshold + 1e-9 })
  const done = (checks: G2Check[]): { pass: boolean; checks: G2Check[] } => ({ pass: checks.every((c) => c.pass), checks })
  if (m.quality === 'mlat') return done([check('lateralAccelP99', m.lateralAccel.p99, 0.5 * G)])
  return done([
    check('frameDiscontinuityMaxM', m.frameDiscontinuity.maxM, 2),
    check('starvationFrames', m.starvationFrames, 0),
    ...[3, 5].flatMap((k) => {
      const c = m.crossTrack.find((x) => x.k === k)
      return [
        check(`crossTrackTurnP95M@${k}`, c?.turnP95M ?? NaN, TURN_BAR_M[k]),
        check(`crossTrackTurnVsLinear@${k}`, c ? c.turnP95M / c.linearTurnP95M : NaN, 0.5),
      ]
    }),
    check('lateralAccelP99', m.lateralAccel.p99, 5.7),
    check('vsErrP95', m.vertical.vsErrP95, 2),
    check('verticalMaxStepM', m.vertical.maxStepM, 1),
    check('delaySlew', m.delaySlew, 0.2),
    check('rejoinBlendMaxS', m.rejoin.blendMaxS, 1.5),
  ])
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tools/bench-track.test.ts`
Expected: PASS — `ℹ tests 4`, `ℹ pass 4`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add tools/bench-track.ts tools/bench-track.test.ts
git commit -m "feat(bench): G2 metric set and evaluateG2 bars (ADS-B v2 table, MLAT 0.5 g)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Causal replay bench and CLI

**Files:**
- Modify: `tools/bench-track.ts`, `tools/bench-track.test.ts` (complete final contents below)
- Test: `tools/bench-track.test.ts`

**Interfaces:**
- Consumes: `readRecording`, `recordingToSamples` (test only), `type RecordLine` from `server/recording.ts`; `MinOffset` (`shared/clock.ts`), `Deduper` (`shared/dedupe.ts`), `normalizers` (`shared/readsb.ts`), `isHidden`, `toSample` (`shared/sample.ts`), `Quality`, `Sample`, `ReadsbAircraft` (`shared/types.ts`) from WP-00; `Frame`, `RateAt` from `tools/types.ts` (WP-00); `Enu` from `shared/enu.ts` (C1); `MAX_DELAY_S`, `RenderClock` from `client/track/delay.ts` (C3); `turnRateDegS` from `client/track/attitude.ts` (C5); `TrackRegistry` (`client/track/registry.ts`) and `Track` (`client/track/track.ts`) from I2; `percentile`, `frameDiscontinuity`, `lateralAccel`, `jerk`, `verticalMetrics`, `crossTrackErrors`, `delaySlew` from `tools/metrics.ts` (T2).
- Produces: `readLines(files: string[]): RecordLine[]` · `forEachSample(lines: RecordLine[], fn: (s: Sample, dup: boolean) => void, hideFlagged?: boolean): void` · `interface BenchOpts { hex?: string; decimate?: number[]; noDedupe?: boolean; fromMs?: number; toMs?: number }` · `interface BenchResult { metrics: G2Metrics; frames: Frame[]; delays: { t: number; d: number }[]; rates: RateAt[]; session: { fromMs: number; toMs: number } }` · `benchTrack(files: string[], opts?: BenchOpts): BenchResult` · `run(argv: string[]): { report; path: string }` · CLI `node tools/bench-track.ts --recordings <files|glob> [--hex] [--decimate 3,5] [--no-dedupe] [--from] [--to] [--out .planning/reports]` (exit 0 = pass, 1 = fail).

- [ ] **Step 1: Write the failing test** (replaces the Task 1 test file; the `evaluateG2` tests are unchanged at the end)

```ts
// tools/bench-track.test.ts
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordingToSamples, type RecordLine } from '../server/recording.ts'
import { Enu } from '../shared/enu.ts'
import type { ReadsbAircraft, Sample } from '../shared/types.ts'
import { benchTrack, evaluateG2, forEachSample, readLines, run, type G2Metrics } from './bench-track.ts'

// Synthetic recording, adsb.lol envelope, 1 Hz server polls for 211 s. Aircraft abc123 (ADS-B v2, 100 m/s):
// north for 60 s, a 2 °/s right turn for 90 s (180°), then south. No new position in (30 s, 42 s): the gap
// opens with 5 re-served copies of the 30 s position, then the aircraft is missing. Every 4th second a second
// poll re-serves the current position (a duplicate). def456 is seen for 20 s; 000002 is LADD (dbFlags 8) and is in
// every poll, so it has the most samples but must stay hidden. One 429 line has no body.
const T0 = 1_790_000_000_000
const HEX = 'abc123'
const V = 100 // m/s
const W = 2 // °/s
const R = V / ((W * Math.PI) / 180) // turn radius, 2864.8 m
const GAP_FROM = 30
const GAP_TO = 42
const ORIGIN = new Enu(32, 34.9, 0)

function truthAt(t: number): { e: number; n: number; trackDeg: number } {
  if (t < 60) return { e: 0, n: V * t, trackDeg: 0 }
  if (t < 150) {
    const th = (W * (t - 60) * Math.PI) / 180
    return { e: R - R * Math.cos(th), n: V * 60 + R * Math.sin(th), trackDeg: W * (t - 60) }
  }
  return { e: 2 * R, n: V * 60 - V * (t - 150), trackDeg: 180 }
}

/** abc123 at position time t (s after T0), reported seenPos seconds before the response's `now`. */
function abc(t: number, seenPos: number): ReadsbAircraft {
  const p = truthAt(t)
  const g = ORIGIN.inv(p.e, p.n, 0)
  const altFt = Math.round((10_000 - (1000 * t) / 60) / 25) * 25 // −1000 fpm, 25 ft quantised
  return {
    hex: HEX, type: 'adsb_icao', flight: 'TST1    ', lat: g.lat, lon: g.lon, alt_baro: altFt, alt_geom: altFt + 300,
    gs: V / 0.514444, track: p.trackDeg, baro_rate: -1000, geom_rate: -1000, nav_qnh: 1013.2, version: 2, nic: 8, seen_pos: seenPos,
  }
}

function line(tRecvMs: number, nowMs: number, ac: ReadsbAircraft[], status = 200): RecordLine {
  const body = status === 200 ? JSON.stringify({ ac, msg: 'No error', now: nowMs, total: ac.length, ctime: nowMs, ptime: 1 }) : ''
  return { v: 1, source: 'adsblol', url: 'synthetic', status, tSendMs: tRecvMs - 100, tRecvMs, bytes: body.length, body }
}

function recording(): RecordLine[] {
  const out: RecordLine[] = []
  for (let i = 0; i <= 210; i++) {
    const now = T0 + i * 1000 + 250 // upstream clock; the position at T0 + i s is 0.25 s old
    const rx = now + 150 + (i % 3) * 40 // latency 150–230 ms, so the stamping offset is 150 ms
    const ac: ReadsbAircraft[] = [{ hex: '000002', type: 'adsb_icao', dbFlags: 8, version: 2, lat: 32.5, lon: 34.5, alt_baro: 30_000, seen_pos: 0.1 }]
    if (i < 20) ac.push({ hex: 'def456', type: 'adsb_icao', version: 2, lat: 32.2, lon: 34.6 + i * 0.001, alt_baro: 5000, gs: 180, track: 90, seen_pos: 0.3 })
    const inGap = i > GAP_FROM && i < GAP_TO
    if (!inGap) ac.push(abc(i, 0.25))
    else if (i <= GAP_FROM + 5) ac.push(abc(GAP_FROM, 0.25 + i - GAP_FROM))
    out.push(line(rx, now, ac))
    if (i % 4 === 2 && !inGap) out.push(line(rx + 500, now + 500, [abc(i, 0.75)]))
  }
  out.splice(100, 0, line(T0 + 99_900, 0, [], 429))
  return out
}

const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Writes the recording as two JSONL files, the later half first, so the bench must merge them by tRecvMs. */
function files(): string[] {
  const dir = tmp('bench-track-')
  const lines = recording()
  const late = join(dir, 'late.jsonl')
  const early = join(dir, 'early.jsonl')
  writeFileSync(late, lines.slice(120).map((l) => JSON.stringify(l)).join('\n') + '\n')
  writeFileSync(early, lines.slice(0, 120).map((l) => JSON.stringify(l)).join('\n') + '\n')
  return [late, early]
}

const FILES = files()
const main = benchTrack(FILES, { noDedupe: true })

test('lines replay in arrival order; server stamping and dedupe equal recordingToSamples', () => {
  const lines = readLines(FILES)
  assert.deepEqual(lines.map((l) => l.tRecvMs), recording().map((l) => l.tRecvMs).toSorted((a, b) => a - b))
  const unique: Sample[] = []
  let dups = 0
  forEachSample(lines, (s, dup) => (dup ? dups++ : unique.push(s)))
  assert.deepEqual(unique, recordingToSamples(lines))
  assert.ok(dups > 0)
})

test('auto hex: the visible hex with the most samples (LADD 000002 stays hidden)', () => {
  assert.equal(main.metrics.hex, HEX)
  assert.equal(main.metrics.quality, 'adsb2')
  assert.equal(main.metrics.samples, 211 - (GAP_TO - GAP_FROM - 1))
  assert.equal(main.session.fromMs, T0 + 150) // stamped: upstream now − seen_pos + 150 ms offset
})

test('starvation is 0 at the chosen D; the 12 s gap extrapolates, then goes stale, then re-joins within 1.5 s', () => {
  const m = main.metrics
  assert.deepEqual(m.delayS, { start: 3, p50: 3, max: 3 })
  assert.equal(m.starvationFrames, 0)
  const off = main.frames.filter((f) => f.mode !== 'interp')
  assert.equal(m.gapFrames, off.length)
  const extrap = off.filter((f) => f.mode === 'extrap')
  const stale = off.filter((f) => f.mode === 'stale')
  assert.ok(extrap.length > 0 && stale.length > 0)
  for (const f of off) assert.ok(f.t > GAP_FROM && f.t < GAP_TO, `non-interp frame at ${f.t} s is outside the gap`)
  assert.ok(extrap.at(-1)!.t < stale[0].t, 'extrapolation comes before stale')
  assert.ok(Math.abs(extrap.length / 60 - 8) < 0.05, `8 s of extrapolation, got ${extrap.length / 60} s`)
  assert.equal(m.rejoin.count, 1)
  assert.ok(m.rejoin.errP95M > 100, `frozen pose vs hindsight: ${m.rejoin.errP95M} m`)
  assert.ok(m.rejoin.blendMaxS > 1 && m.rejoin.blendMaxS <= 1.5, `blend ${m.rejoin.blendMaxS} s`)
})

test('every G2 metric is finite; frames are 60 Hz in one ENU frame at the first sample', () => {
  const m = main.metrics
  for (const [name, v] of Object.entries({
    discMax: m.frameDiscontinuity.maxM, discP99: m.frameDiscontinuity.p99M, latP99: m.lateralAccel.p99, latMax: m.lateralAccel.max,
    jerkP99: m.jerk.p99, vsErrP95: m.vertical.vsErrP95, maxStepM: m.vertical.maxStepM, delaySlew: m.delaySlew,
  })) assert.ok(Number.isFinite(v), `${name} = ${v}`)
  assert.ok(m.delaySlew <= 0.2 + 1e-9)
  assert.ok(m.frameDiscontinuity.maxM < 2, `interp discontinuity ${m.frameDiscontinuity.maxM} m`)
  const f = main.frames
  assert.equal(m.frames, f.length)
  assert.ok(Math.abs(f[1].t - f[0].t - 1 / 60) < 1e-6)
  assert.ok(Math.hypot(f[0].e, f[0].n) < V * 1.5, 'starts near the origin')
  const turn = f.filter((x) => x.t > 80 && x.t < 130)
  const lat = Math.max(...turn.map((x) => Math.abs(x.rollDeg)))
  assert.ok(lat > 15 && lat < 25, `coordinated-turn roll ≈ atan(v·ω/g) = 20°, got ${lat}`)
  assert.ok(main.rates.length > 0 && Math.abs(main.rates[0].vsMs + 5.08) < 1e-9)
})

test('dedupe: re-served positions counted and removed; the no-dedupe replay is scored too', () => {
  const d = main.metrics.dedupe
  assert.equal(d.unique, main.metrics.samples)
  assert.ok(d.served > d.unique)
  assert.ok(d.duplicateFraction > 0.15 && d.duplicateFraction < 0.3, `duplicate fraction ${d.duplicateFraction}`)
  assert.ok(Number.isFinite(d.jerkP99NoDedupe))
  assert.equal(benchTrack(FILES, { decimate: [] }).metrics.dedupe.jerkP99NoDedupe, null)
})

test('decimate 3 and 5 score held-out truth, split turn vs straight, against linear interpolation', () => {
  const [c3, c5] = main.metrics.crossTrack
  assert.deepEqual([c3.k, c5.k], [3, 5])
  for (const c of [c3, c5]) {
    assert.ok(c.nTurn > 20 && c.nStraight > 20, `k=${c.k}: ${c.nTurn} turn, ${c.nStraight} straight`)
    assert.ok(c.turnP95M <= 0.5 * c.linearTurnP95M, `k=${c.k}: ${c.turnP95M} m vs linear ${c.linearTurnP95M} m`)
  }
  assert.ok(c3.turnP95M < 5 && c3.linearTurnP95M > 2, `chord sag at 3 s ≈ 3.5 m: ${c3.linearTurnP95M}`)
  assert.ok(c5.turnP95M < 15 && c5.linearTurnP95M > c3.linearTurnP95M)
})

test('--hex and --from/--to select one aircraft and window', () => {
  const r = benchTrack(FILES, { hex: 'DEF456', decimate: [] })
  assert.equal(r.metrics.hex, 'def456')
  assert.equal(r.metrics.samples, 20)
  const w = benchTrack(FILES, { hex: HEX, fromMs: T0 + 60_000, toMs: T0 + 150_999, decimate: [3] })
  assert.equal(w.session.fromMs, T0 + 60_150)
  assert.equal(w.session.toMs, T0 + 150_150)
  assert.equal(w.metrics.samples, 91)
  assert.equal(w.metrics.gapFrames, 0)
  assert.throws(() => benchTrack(FILES, { hex: 'zzz999' }), /no samples/)
})

test('run() writes .planning-style G2-<hex>-<date>.json and returns the verdict', () => {
  const out = tmp('bench-report-')
  const { report, path } = run(['--recordings', ...FILES, '--hex', HEX, '--decimate', '3', '--out', out])
  assert.equal(path, join(out, `G2-${HEX}-${new Date().toISOString().slice(0, 10)}.json`))
  assert.ok(existsSync(path))
  const j = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(j.gate, 'G2')
  assert.equal(j.hex, HEX)
  assert.equal(j.pass, report.pass)
  assert.ok(j.checks.some((c: { name: string }) => c.name === 'crossTrackTurnP95M@5'))
  assert.throws(() => run(['--out', out]), /no recordings/)
})

// ---- evaluateG2 on hand-made metrics ----

function good(): G2Metrics {
  return {
    hex: 'abc123', quality: 'adsb2', samples: 200, frames: 12_000,
    delayS: { start: 3, p50: 3, max: 3 },
    starvationFrames: 0, gapFrames: 0,
    frameDiscontinuity: { maxM: 0.5, p99M: 0.01 },
    lateralAccel: { p99: 3.5, max: 4 },
    jerk: { p99: 1 },
    vertical: { vsErrP95: 1, maxStepM: 0.2 },
    delaySlew: 0.2,
    rejoin: { count: 1, errP95M: 200, blendMaxS: 1.45 },
    crossTrack: [
      { k: 3, nTurn: 60, nStraight: 80, turnP95M: 1, straightP95M: 0.5, linearTurnP95M: 3.5 },
      { k: 5, nTurn: 70, nStraight: 90, turnP95M: 4, straightP95M: 1, linearTurnP95M: 10 },
    ],
    dedupe: { served: 250, unique: 200, duplicateFraction: 0.2, jerkP99NoDedupe: null },
  }
}

const failing = (m: G2Metrics): string[] => evaluateG2(m).checks.filter((c) => !c.pass).map((c) => c.name)

test('evaluateG2: a metric set inside every ADS-B v2 bar passes', () => {
  const r = evaluateG2(good())
  assert.equal(r.pass, true)
  assert.deepEqual(r.checks.map((c) => [c.name, c.threshold]), [
    ['frameDiscontinuityMaxM', 2], ['starvationFrames', 0],
    ['crossTrackTurnP95M@3', 5], ['crossTrackTurnVsLinear@3', 0.5], ['crossTrackTurnP95M@5', 15], ['crossTrackTurnVsLinear@5', 0.5],
    ['lateralAccelP99', 5.7], ['vsErrP95', 2], ['verticalMaxStepM', 1], ['delaySlew', 0.2], ['rejoinBlendMaxS', 1.5],
  ])
})

test('evaluateG2: each bar fails on its own', () => {
  const cases: [string, (m: G2Metrics) => void][] = [
    ['frameDiscontinuityMaxM', (m) => (m.frameDiscontinuity.maxM = 2.5)],
    ['starvationFrames', (m) => (m.starvationFrames = 1)],
    ['crossTrackTurnP95M@3', (m) => Object.assign(m.crossTrack[0], { turnP95M: 6, linearTurnP95M: 20 })],
    ['crossTrackTurnVsLinear@3', (m) => Object.assign(m.crossTrack[0], { turnP95M: 2, linearTurnP95M: 3 })],
    ['crossTrackTurnP95M@5', (m) => Object.assign(m.crossTrack[1], { turnP95M: 16, linearTurnP95M: 40 })],
    ['crossTrackTurnVsLinear@5', (m) => Object.assign(m.crossTrack[1], { turnP95M: 6, linearTurnP95M: 10 })],
    ['lateralAccelP99', (m) => (m.lateralAccel.p99 = 5.8)],
    ['vsErrP95', (m) => (m.vertical.vsErrP95 = 2.1)],
    ['verticalMaxStepM', (m) => (m.vertical.maxStepM = 1.2)],
    ['delaySlew', (m) => (m.delaySlew = 0.25)],
    ['rejoinBlendMaxS', (m) => (m.rejoin.blendMaxS = 1.6)],
  ]
  for (const [name, spoil] of cases) {
    const m = good()
    spoil(m)
    assert.deepEqual(failing(m), [name])
    assert.equal(evaluateG2(m).pass, false)
  }
})

test('evaluateG2: no data fails, float noise at a bar does not, no re-join passes', () => {
  const nan = good()
  nan.frameDiscontinuity.maxM = NaN
  assert.deepEqual(failing(nan), ['frameDiscontinuityMaxM'])
  const no5 = good()
  no5.crossTrack = no5.crossTrack.slice(0, 1)
  assert.deepEqual(failing(no5), ['crossTrackTurnP95M@5', 'crossTrackTurnVsLinear@5'])
  const edge = good()
  edge.delaySlew = 0.2 + 1e-12
  edge.lateralAccel.p99 = 5.7
  assert.deepEqual(failing(edge), [])
  const calm = good()
  calm.rejoin = { count: 0, errP95M: NaN, blendMaxS: 0 }
  assert.equal(evaluateG2(calm).pass, true)
  const inf = good()
  inf.rejoin.blendMaxS = Infinity
  assert.deepEqual(failing(inf), ['rejoinBlendMaxS'])
})

test('evaluateG2: an MLAT hex is held to the separate bar, lateral acceleration p99 ≤ 0.5 g', () => {
  const m = good()
  m.quality = 'mlat'
  m.lateralAccel.p99 = 4.8
  m.crossTrack = [] // not gated for MLAT
  const r = evaluateG2(m)
  assert.equal(r.pass, true)
  assert.deepEqual(r.checks.map((c) => c.name), ['lateralAccelP99'])
  assert.ok(Math.abs(r.checks[0].threshold - 4.903325) < 1e-9)
  m.lateralAccel.p99 = 5 // inside the ADS-B bar, outside the MLAT one
  assert.equal(evaluateG2(m).pass, false)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tools/bench-track.test.ts`
Expected: FAIL — `SyntaxError: The requested module './bench-track.ts' does not provide an export named 'benchTrack'` (`ℹ tests 1`, `ℹ fail 1`).

- [ ] **Step 3: Write the implementation** (replaces the Task 1 file)

```ts
// tools/bench-track.ts
// Gate G2 motion bench (PLAN.md §6): replays recordings causally through the real client estimator and scores the
// rendered 60 Hz path of one aircraft with tools/metrics.ts. Writes <out>/G2-<hex>-<YYYY-MM-DD>.json.
//
//   node tools/bench-track.ts --recordings 'data/recordings/*.jsonl' [--hex 4x1234] [--decimate 3,5] [--no-dedupe]
//                             [--from 2026-09-22T10:00Z] [--to 2026-09-22T12:00Z] [--out .planning/reports]
//
// Causal replay: recorded polls in arrival (tRecvMs) order → server stamping and dedupe exactly as recordingToSamples
// (a sample becomes visible at its line's tRecvMs) → a simulated client polls the chased hex every 1 s and gets every
// sample with rxMs ≤ poll − 100 ms → TrackRegistry → RenderClock at 60 Hz with serverNow = the simulation clock.
// --decimate k[,k…] replays every k-th sample and scores the rest as held-out truth (G2 needs 3 and 5). --no-dedupe also
// replays the positions the server dedupe dropped and reports that run's jerk next to the deduped one.
// --from/--to take ISO times or epoch ms. Exit code 0 = pass, 1 = fail.
import { globSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { turnRateDegS } from '../client/track/attitude.ts'
import { MAX_DELAY_S, RenderClock } from '../client/track/delay.ts'
import { TrackRegistry } from '../client/track/registry.ts'
import { Track } from '../client/track/track.ts'
import { readRecording, type RecordLine } from '../server/recording.ts'
import { MinOffset } from '../shared/clock.ts'
import { Deduper } from '../shared/dedupe.ts'
import { Enu } from '../shared/enu.ts'
import { normalizers } from '../shared/readsb.ts'
import { isHidden, toSample } from '../shared/sample.ts'
import type { Quality, Sample } from '../shared/types.ts'
import { crossTrackErrors, delaySlew, frameDiscontinuity, jerk, lateralAccel, percentile, verticalMetrics } from './metrics.ts'
import type { Frame, RateAt } from './types.ts'

const POLL_MS = 1000 // simulated client chase poll
const HOP_MS = 100 // server → client: a poll at t sees samples with rxMs ≤ t − 100 ms
const FPS = 60
const SESSION_GAP_MS = 60_000 // a longer silence means the aircraft left coverage; the longest session is benched
const COVERAGE_GAP_MS = MAX_DELAY_S * 1000 // no allowed delay bridges a longer gap: frames in it are coverage, not starvation
const TURN_DEGS = 1 // |track rate| above this is a turn (G2 cross-track bar)
const FPM = 0.00508 // m/s per ft/min
const G = 9.80665
const TURN_BAR_M: Record<number, number> = { 3: 5, 5: 15 } // G2: decimated to 3 s / 5 s (1 Hz recordings, so k = seconds)

export interface CrossTrack {
  k: number
  nTurn: number
  nStraight: number
  turnP95M: number
  straightP95M: number
  linearTurnP95M: number // the same held-out turn points scored against straight lines between kept samples
}

export interface G2Metrics {
  hex: string
  quality: Quality // the session's most common quality
  samples: number // deduped samples in the session
  frames: number
  delayS: { start: number; p50: number; max: number }
  starvationFrames: number // not 'interp' although the bracketing samples are ≤ 10 s apart
  gapFrames: number // not 'interp' inside a coverage gap (> 10 s between samples): reported, not gated
  frameDiscontinuity: { maxM: number; p99M: number }
  lateralAccel: { p99: number; max: number }
  jerk: { p99: number }
  vertical: { vsErrP95: number; maxStepM: number }
  delaySlew: number
  rejoin: { count: number; errP95M: number; blendMaxS: number }
  crossTrack: CrossTrack[]
  dedupe: { served: number; unique: number; duplicateFraction: number; jerkP99NoDedupe: number | null }
}

export interface BenchOpts {
  hex?: string // default: the hex with the most deduped samples in the window
  decimate?: number[] // default [3, 5]
  noDedupe?: boolean // also replay the positions the server dedupe dropped and report that run's jerk
  fromMs?: number // sample time window, server clock
  toMs?: number
}

export interface BenchResult {
  metrics: G2Metrics
  frames: Frame[]
  delays: { t: number; d: number }[]
  rates: RateAt[]
  session: { fromMs: number; toMs: number } // first and last sample tMs; Frame.t = (tMs − fromMs) / 1000
}

export interface G2Check {
  name: string
  value: number
  threshold: number
  pass: boolean
}

/** All record lines of the files in arrival order (stable, so equal tRecvMs keep file order). */
export function readLines(files: string[]): RecordLine[] {
  // ponytail: readRecording holds each file in one string, so a file must stay under V8's ~512 MB string limit
  // (a day of record-cells is ~100 MB). Upgrade: stream lines with node:readline as tools/datum-check.ts does.
  return files.flatMap((f) => readRecording(f)).sort((a, b) => a.tRecvMs - b.tRecvMs)
}

/**
 * Server-side stamping exactly as recordingToSamples (server/recording.ts): lines in the given order, the clock
 * offset updated before each line's samples are stamped, rxMs = tRecvMs. fn also sees the positions the Deduper
 * rejects (dup = true), so the duplicate fraction and the no-dedupe replay come from the same pass.
 */
export function forEachSample(lines: RecordLine[], fn: (s: Sample, dup: boolean) => void, hideFlagged = true): void {
  const offset = new MinOffset(10 * 60_000)
  const dedupe = new Deduper()
  for (const line of lines) {
    if (line.status !== 200 || line.body === '') continue
    const snap = normalizers[line.source](line.body)
    offset.update(line.tRecvMs, snap.nowMs)
    for (const ac of snap.aircraft) {
      if (hideFlagged && isHidden(ac)) continue
      const s = toSample(ac, snap.nowMs, offset.get(), line.tRecvMs)
      if (s) fn(s, !dedupe.accept(s))
    }
  }
}

function pickHex(lines: RecordLine[], fromMs: number, toMs: number): string {
  const count = new Map<string, number>()
  forEachSample(lines, (s, dup) => {
    if (!dup && s.tMs >= fromMs && s.tMs <= toMs) count.set(s.hex, (count.get(s.hex) ?? 0) + 1)
  })
  let best = ''
  let most = 0
  for (const [hex, n] of count) if (n > most) [best, most] = [hex, n]
  if (best === '') throw new Error('no samples in the recordings and time window')
  return best
}

/** The run of samples with the most samples between silences longer than SESSION_GAP_MS. */
function longestSession(ss: Sample[]): Sample[] {
  let best: Sample[] = []
  let start = 0
  for (let i = 1; i <= ss.length; i++) {
    if (i < ss.length && ss[i].tMs - ss[i - 1].tMs <= SESSION_GAP_MS) continue
    if (i - start > best.length) best = ss.slice(start, i)
    start = i
  }
  return best
}

function mostCommon<T>(xs: T[]): T {
  const n = new Map<T, number>()
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1)
  return [...n].reduce((a, b) => (b[1] > a[1] ? b : a))[0]
}

/**
 * The simulated client. Polls every POLL_MS from the first sample's rxMs + HOP_MS, ingesting what each poll sees.
 * Renders at 60 Hz from the first poll + D, D = the registry's delay target after that poll, so the first frame's
 * render time is the first poll (after the first sample). Stops when render time passes the newest sample.
 */
function simulate(ss: Sample[], hex: string, enu: Enu, t0Ms: number): { frames: Frame[]; delays: { t: number; d: number }[] } {
  const byRx = ss.toSorted((a, b) => a.rxMs - b.rxMs)
  const endMs = ss.reduce((m, s) => Math.max(m, s.tMs), -Infinity)
  const reg = new TrackRegistry({ pollPeriodS: POLL_MS / 1000 })
  let next = 0
  const deliver = (pollMs: number): void => {
    const batch: Sample[] = []
    while (next < byRx.length && byRx[next].rxMs <= pollMs - HOP_MS) batch.push(byRx[next++])
    if (batch.length > 0) reg.ingest(batch)
  }
  let pollMs = byRx[0].rxMs + HOP_MS
  deliver(pollMs)
  const clock = new RenderClock(reg.delayTargetS(hex))
  const startMs = pollMs + clock.delayS * 1000
  const frames: Frame[] = []
  const delays: { t: number; d: number }[] = []
  let prevMs = startMs
  for (let i = 0; ; i++) {
    const nowMs = startMs + (i * 1000) / FPS
    while (pollMs + POLL_MS <= nowMs) deliver((pollMs += POLL_MS))
    const tR = clock.tick(nowMs, reg.delayTargetS(hex), (nowMs - prevMs) / 1000)
    prevMs = nowMs
    if (tR > endMs) break
    delays.push({ t: (nowMs - t0Ms) / 1000, d: clock.delayS })
    const st = reg.get(hex)?.stateAt(tR)
    if (!st) continue // cannot happen: the first render time is after the first sample, and sessions have no > 60 s gaps
    const [e, n] = enu.fwd(st.lat, st.lon, 0)
    frames.push({ t: (tR - t0Ms) / 1000, e, n, u: st.hM, mode: st.mode, headingDeg: st.headingDeg, pitchDeg: st.pitchDeg, rollDeg: st.rollDeg })
  }
  return { frames, delays }
}

/** Frames not interpolating, split by the gap between the samples that bracket their render time. ss sorted by tMs. */
function starvation(frames: Frame[], ss: Sample[], t0Ms: number): { starvationFrames: number; gapFrames: number } {
  let j = 0
  let starvationFrames = 0
  let gapFrames = 0
  for (const f of frames) {
    if (f.mode === 'interp') continue
    const tMs = t0Ms + f.t * 1000
    while (j + 1 < ss.length && ss[j + 1].tMs <= tMs) j++
    const next = ss[j + 1]
    if (next !== undefined && next.tMs - ss[j].tMs > COVERAGE_GAP_MS) gapFrames++
    else starvationFrames++
  }
  return { starvationFrames, gapFrames }
}

/**
 * Every return to 'interp' after extrapolating or going stale is a re-join. Its error is the horizontal distance, at
 * the last frame before the new data, between what was on screen and hindsight: a fresh Track given the samples from
 * 100 s before to 30 s after. The blend time runs from that frame to the first frame within max(0.5 m, 1 % of the
 * error) of hindsight; Infinity if 3 s of interpolation never get there. A re-join the data cuts short is skipped.
 * No re-join at all → blendMaxS 0 (nothing needed blending).
 */
function rejoins(frames: Frame[], ss: Sample[], hex: string, enu: Enu, t0Ms: number): G2Metrics['rejoin'] {
  const errs: number[] = []
  const blends: number[] = []
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].mode !== 'interp' || frames[i - 1].mode === 'interp') continue
    const a = frames[i - 1]
    const hind = new Track(hex, { pollPeriodS: POLL_MS / 1000 })
    for (const s of ss) if (s.tMs >= t0Ms + (a.t - 100) * 1000 && s.tMs <= t0Ms + (a.t + 30) * 1000) hind.add(s)
    const miss = (f: Frame): number => {
      const st = hind.stateAt(t0Ms + f.t * 1000)!
      const [e, n] = enu.fwd(st.lat, st.lon, 0)
      return Math.hypot(f.e - e, f.n - n)
    }
    const err = miss(a)
    const tol = Math.max(0.5, 0.01 * err)
    let j = i
    while (j < frames.length && frames[j].mode === 'interp' && frames[j].t - a.t <= 3 && miss(frames[j]) > tol) j++
    const f = frames[j]
    if (f === undefined || f.mode !== 'interp') continue
    errs.push(err)
    blends.push(f.t - a.t <= 3 ? f.t - a.t : Infinity)
  }
  return { count: errs.length, errP95M: percentile(errs, 95), blendMaxS: blends.reduce((m, b) => Math.max(m, b), 0) }
}

/** Reported vertical rate per airborne sample, m/s: geometric for ADS-B v2 when present (as Track uses it), else barometric. */
function ratesOf(ss: Sample[], t0Ms: number): RateAt[] {
  const out: RateAt[] = []
  for (const s of ss) {
    const fpm = s.version === 2 && s.geomRateFpm !== null ? s.geomRateFpm : s.baroRateFpm
    if (!s.onGround && fpm !== null) out.push({ t: (s.tMs - t0Ms) / 1000, vsMs: fpm * FPM })
  }
  return out
}

/**
 * Keeps every k-th session sample, replays those, and scores the held-out rest as truth. A held-out sample is a turn
 * point when |track rate| (central difference of the reported track) > 1 °/s; without a reported track it is skipped.
 * The linear baseline is the straight line between the kept samples around it, at the same time.
 */
function crossTrack(k: number, session: Sample[], hex: string, enu: Enu, t0Ms: number): CrossTrack {
  const pt = (s: Sample): { t: number; e: number; n: number } => {
    const [e, n] = enu.fwd(s.lat, s.lon, 0)
    return { t: (s.tMs - t0Ms) / 1000, e, n }
  }
  const kept = session.filter((_, i) => i % k === 0)
  const K = kept.map(pt)
  const { frames } = simulate(kept, hex, enu, t0Ms)
  const first = frames[0]?.t ?? Infinity
  const last = frames.at(-1)?.t ?? -Infinity
  const turn: { t: number; e: number; n: number }[] = []
  const straight: { t: number; e: number; n: number }[] = []
  const linear: number[] = []
  let j = 0
  for (let i = 1; i < session.length; i++) {
    if (i % k === 0) continue
    const p = pt(session[i])
    const a = session[i - 1]
    const b = session[Math.min(session.length - 1, i + 1)]
    if (p.t < first || p.t > last || a.trackDeg === null || b.trackDeg === null) continue
    if (Math.abs(turnRateDegS(a.trackDeg, b.trackDeg, (b.tMs - a.tMs) / 1000)) <= TURN_DEGS) {
      straight.push(p)
      continue
    }
    while (j + 1 < K.length && K[j + 1].t <= p.t) j++
    const [x, y] = [K[j], K[j + 1]]
    const w = (p.t - x.t) / (y.t - x.t)
    turn.push(p)
    linear.push(Math.hypot(x.e + w * (y.e - x.e) - p.e, x.n + w * (y.n - x.n) - p.n))
  }
  return {
    k,
    nTurn: turn.length,
    nStraight: straight.length,
    turnP95M: percentile(crossTrackErrors(frames, turn), 95),
    straightP95M: percentile(crossTrackErrors(frames, straight), 95),
    linearTurnP95M: percentile(linear, 95),
  }
}

/** Runs the causal replay for one aircraft and computes every G2 motion metric. */
export function benchTrack(files: string[], opts: BenchOpts = {}): BenchResult {
  const lines = readLines(files)
  const fromMs = opts.fromMs ?? -Infinity
  const toMs = opts.toMs ?? Infinity
  const hex = opts.hex?.toLowerCase() ?? pickHex(lines, fromMs, toMs)
  const unique: Sample[] = []
  const served: Sample[] = []
  forEachSample(lines, (s, dup) => {
    if (s.hex !== hex || s.tMs < fromMs || s.tMs > toMs) return
    served.push(s)
    if (!dup) unique.push(s)
  })
  if (unique.length === 0) throw new Error(`no samples for ${hex} in the recordings and time window`)
  // ponytail: one session per run (the longest); upgrade: bench every session and pool the per-frame values.
  const session = longestSession(unique)
  const t0Ms = session[0].tMs
  const endMs = session[session.length - 1].tMs
  const inSession = served.filter((s) => s.tMs >= t0Ms && s.tMs <= endMs + 100) // + the Deduper's 100 ms window
  // ponytail: one ENU frame at the first sample; its scale error is ≈ d²/2R² (1.2 % at 1000 km). Use --from/--to on long flights.
  const enu = new Enu(session[0].lat, session[0].lon, 0)
  const { frames, delays } = simulate(session, hex, enu, t0Ms)
  const rates = ratesOf(session, t0Ms)
  const ds = delays.map((x) => x.d)
  const metrics: G2Metrics = {
    hex,
    quality: mostCommon(session.map((s) => s.quality)),
    samples: session.length,
    frames: frames.length,
    delayS: { start: ds[0] ?? NaN, p50: percentile(ds, 50), max: ds.length > 0 ? ds.reduce((m, d) => Math.max(m, d)) : NaN },
    ...starvation(frames, session, t0Ms),
    frameDiscontinuity: frameDiscontinuity(frames),
    lateralAccel: lateralAccel(frames),
    jerk: jerk(frames),
    vertical: verticalMetrics(frames, rates),
    delaySlew: delaySlew(delays),
    rejoin: rejoins(frames, session, hex, enu, t0Ms),
    crossTrack: (opts.decimate ?? [3, 5]).map((k) => crossTrack(k, session, hex, enu, t0Ms)),
    dedupe: {
      served: inSession.length,
      unique: session.length,
      duplicateFraction: 1 - session.length / inSession.length,
      // ponytail: Track (WP-I2) dedupes on its own, so this equals jerk.p99 unless a duplicate slips past both.
      jerkP99NoDedupe: opts.noDedupe ? jerk(simulate(inSession, hex, enu, t0Ms).frames).p99 : null,
    },
  }
  return { metrics, frames, delays, rates, session: { fromMs: t0Ms, toMs: endMs } }
}

/**
 * G2 motion bars (PLAN.md §6). ADS-B (the v2 table): interpolation discontinuity ≤ 2 m, 0 starvation frames, held-out
 * turn cross-track p95 ≤ 5 m at k = 3 and ≤ 15 m at k = 5 and ≤ 50 % of linear, lateral acceleration p99 ≤ 5.7 m/s²,
 * VS error p95 ≤ 2 m/s, height step ≤ 1 m per frame, delay slew ≤ 0.2 s/s, re-join blended ≤ 1.5 s. An MLAT hex is held
 * to its separate bar only: lateral acceleration p99 ≤ 0.5 g. NaN (no data) fails; 1e-9 absorbs float noise at a bar.
 */
export function evaluateG2(m: G2Metrics): { pass: boolean; checks: G2Check[] } {
  const check = (name: string, value: number, threshold: number): G2Check => ({ name, value, threshold, pass: value <= threshold + 1e-9 })
  const done = (checks: G2Check[]): { pass: boolean; checks: G2Check[] } => ({ pass: checks.every((c) => c.pass), checks })
  if (m.quality === 'mlat') return done([check('lateralAccelP99', m.lateralAccel.p99, 0.5 * G)])
  return done([
    check('frameDiscontinuityMaxM', m.frameDiscontinuity.maxM, 2),
    check('starvationFrames', m.starvationFrames, 0),
    ...[3, 5].flatMap((k) => {
      const c = m.crossTrack.find((x) => x.k === k)
      return [
        check(`crossTrackTurnP95M@${k}`, c?.turnP95M ?? NaN, TURN_BAR_M[k]),
        check(`crossTrackTurnVsLinear@${k}`, c ? c.turnP95M / c.linearTurnP95M : NaN, 0.5),
      ]
    }),
    check('lateralAccelP99', m.lateralAccel.p99, 5.7),
    check('vsErrP95', m.vertical.vsErrP95, 2),
    check('verticalMaxStepM', m.vertical.maxStepM, 1),
    check('delaySlew', m.delaySlew, 0.2),
    check('rejoinBlendMaxS', m.rejoin.blendMaxS, 1.5),
  ])
}

const round3 = (x: number | null): number | null => (x === null || !Number.isFinite(x) ? x : Math.round(x * 1000) / 1000)

function timeArg(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined
  const ms = /^\d+$/.test(v) ? Number(v) : Date.parse(v)
  if (Number.isNaN(ms)) throw new Error(`--${name} must be an ISO time or epoch ms, got ${v}`)
  return ms
}

/** The CLI: parse, bench, score, write the report, print a table. Returns the report and where it was written. */
export function run(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      recordings: { type: 'string', multiple: true, default: [] },
      hex: { type: 'string' },
      decimate: { type: 'string', default: '3,5' },
      'no-dedupe': { type: 'boolean', default: false },
      from: { type: 'string' },
      to: { type: 'string' },
      out: { type: 'string', default: '.planning/reports' },
    },
  })
  const patterns = [...values.recordings, ...positionals]
  const files = [...new Set(patterns.flatMap((p) => (/[*?[{]/.test(p) ? globSync(p) : [p])))].sort()
  if (files.length === 0) throw new Error(`no recordings match ${patterns.join(' ') || '(none given)'}: pass --recordings <files or glob>`)
  const decimate = values.decimate.split(',').filter((x) => x !== '').map(Number)
  if (decimate.some((k) => !Number.isInteger(k) || k < 2)) throw new Error(`--decimate takes integers ≥ 2, got ${values.decimate}`)
  const { metrics, session } = benchTrack(files, {
    hex: values.hex,
    decimate,
    noDedupe: values['no-dedupe'],
    fromMs: timeArg(values.from, 'from'),
    toMs: timeArg(values.to, 'to'),
  })
  const result = evaluateG2(metrics)
  const now = new Date()
  // JSON has no NaN/Infinity: a missing metric and an unfinished blend are written as null.
  const report = {
    gate: 'G2',
    generatedAt: now.toISOString(),
    files,
    hex: metrics.hex,
    session: { from: new Date(session.fromMs).toISOString(), to: new Date(session.toMs).toISOString() },
    ...result,
    metrics,
  }
  mkdirSync(values.out, { recursive: true })
  const path = join(values.out, `G2-${metrics.hex}-${now.toISOString().slice(0, 10)}.json`)
  writeFileSync(path, JSON.stringify(report, null, 1) + '\n')
  console.log(`G2 bench ${metrics.hex} (${metrics.quality}), ${report.session.from} → ${report.session.to}, ${metrics.samples} samples, ${metrics.frames} frames, D p50 ${metrics.delayS.p50} s`)
  console.table(result.checks.map((c) => ({ check: c.name, value: round3(c.value), threshold: round3(c.threshold), result: c.pass ? 'pass' : 'FAIL' })))
  console.table({
    gapFrames: metrics.gapFrames,
    frameDiscontinuityP99M: round3(metrics.frameDiscontinuity.p99M),
    lateralAccelMax: round3(metrics.lateralAccel.max),
    jerkP99: round3(metrics.jerk.p99),
    jerkP99NoDedupe: round3(metrics.dedupe.jerkP99NoDedupe),
    duplicateFraction: round3(metrics.dedupe.duplicateFraction),
    rejoins: metrics.rejoin.count,
    rejoinErrP95M: round3(metrics.rejoin.errP95M),
    ...Object.fromEntries(metrics.crossTrack.map((c) => [`straightP95M@${c.k}`, round3(c.straightP95M)])),
  })
  console.log(`G2 ${result.pass ? 'PASS' : 'FAIL'} → ${path}`)
  return { report, path }
}

if (import.meta.main) {
  const { report } = run(process.argv.slice(2))
  process.exitCode = report.pass ? 0 : 1
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tools/bench-track.test.ts`
Expected: PASS — `ℹ tests 12`, `ℹ pass 12`, `ℹ fail 0` (≈ 0.4 s). The `run()` test prints its console tables; its verdict is FAIL because it passes `--decimate 3` only, so the k = 5 checks are NaN, as intended.

- [ ] **Step 5: Commit**

```bash
git add tools/bench-track.ts tools/bench-track.test.ts
git commit -m "feat(bench): causal replay bench CLI for gate G2 (tools/bench-track.ts)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: WP gate

- [ ] **Step 1: Run every test this package owns**

Run: `node --test tools/bench-track.test.ts`
Expected: `ℹ tests 12`, `ℹ pass 12`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'tools/bench-track'`
Expected: no output (grep exits 1). On a branch where every merged package is complete, `npm run check` must also pass.

- [ ] **Step 3: Smoke-run the CLI on whatever recordings exist (local files only, no network)**

Run: `node tools/bench-track.ts --recordings 'data/recordings/*.jsonl' --out "$(mktemp -d)"; echo "exit=$?"`
Expected: one summary line (`G2 bench <hex> (<quality>) …`), a checks table, a report-only table and `G2 PASS|FAIL → <tmp>/G2-<hex>-<date>.json`; `exit=0` or `exit=1`. On day-1 `record-cells` data expect FAIL: each hex is seen only every ~30 s, so D sits at 10 s, most frames are gap frames and there are no turn points. That is a data verdict, not a bench error.

- [ ] **Step 4: Confirm everything is committed and record the gate**

```bash
git status --short -- tools/bench-track.ts tools/bench-track.test.ts
git commit --allow-empty -m "chore(bench): WP-A3 gate passed (12 tests, tsc clean)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `git status` prints nothing before the commit. The branch `wp/A3` is ready to merge.

---

## Notes for the G2 run (orchestrator)

- **Command:** once WP-I3's 1 Hz hex recordings have ≥ 24 h, run `node tools/bench-track.ts --recordings 'data/recordings/*.jsonl' --hex <an adsb2 arrival that turns> --no-dedupe` → `.planning/reports/G2-<hex>-<date>.json`. Auto-pick takes the hex with the most samples, which may not be ADS-B v2 or may never turn (turn cross-track is then NaN → FAIL). Pick a v2 arrival hex from the census (`tools/census.ts`) and add `--from/--to` around one approach when the aircraft appears several times.
- **Report name:** PLAN.md §4 says `G2-<date>.json`. This package writes `G2-<hex>-<date>.json`, so several aircraft can be benched on one day.
- **Starvation vs gaps:** only non-interp frames between samples ≤ 10 s apart count against the "0 starvation" bar. Longer gaps are coverage and are reported as `gapFrames`. A silence > 60 s ends a session; the longest session is benched.
- **Re-join:** hindsight is a fresh `Track` given the samples around the re-join. The measured blend is ≈ 1.42–1.43 s against the 1.5 s bar (I2's `REJOIN_S`), so the bar is structural for ADS-B. `rejoin.errP95M` is the number to read: how far extrapolation was off when data resumed.
- **Jerk:** jerk p99 is dominated by the vertical. On the synthetic 25 ft-quantised descent it is 102 m/s³ in 3D vs 19.5 m/s³ horizontal only. C4's filter is α-β with Hermite between filtered states, which is C1, so the vertical acceleration steps at every sample. Jerk is report-only in G2.
- **`--no-dedupe` is currently equal to the deduped run:** `Track.add` (I2) runs its own `Deduper` with the same rules, so server-side duplicates never reach the estimator (verified on the synthetic recording, duplicate fraction 0.22: `jerkP99NoDedupe` = `jerk.p99` = 102.03 m/s³). The duplicate fraction is still real. See the contract issue in the WP report.
- **MLAT:** `evaluateG2` holds an MLAT hex only to lateral acceleration p99 ≤ 0.5 g; every other metric is still written to the report. I2 measured 31 m/s² on σ = 30 m synthetic MLAT, so expect this bar to fail unless I2's smoothing half-window grows (VERDICT: CONDITIONAL-GO, no MLAT chase).
- **Scale ceilings (`ponytail:`):** each recording file is read as one string. V8 caps a string at ≈ 512 MB, and a day of `record-cells` is ≈ 100 MB. The upgrade is to stream lines with `node:readline`, as `tools/datum-check.ts` does. All lines are held in memory, and auto-pick parses them twice. The bench uses one ENU frame per session (scale error ≈ d²/2R², 1.2 % at 1000 km); use `--from/--to` on long flights.

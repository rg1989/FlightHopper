# WP-C3 — Timing (Playback Delay) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Choose how far behind the server clock the client renders each aircraft, and move the render clock toward that delay smoothly. The estimator then interpolates between real samples instead of guessing past the newest one, and the delay never jumps (G2: delay slew ≤ 0.2 s/s).

**Architecture:** One pure module, `client/track/delay.ts`, with no dependencies. The consumers are I2 (`Track.gapP90S()` and `Track.delayTargetS` call `p90` and `targetDelayS`), A2 (the app loop runs one `RenderClock`) and A3 (the bench runs the same clock).
- `delayFloorS` looks up the floor by position quality: adsb2 3 s, adsb01 4 s, mlat 6 s, other 6 s.
- `targetDelayS = clamp(max(floor, poll + 1, p90 gap + 1), 3, 10)`. It keeps one second of headroom over the poll period and over the 90th-percentile gap between samples, so the next sample normally arrives before render time reaches the newest one. A NaN term counts as absent, so a bad input cannot make the clock NaN.
- `p90` uses **nearest rank, not linear interpolation**: it returns the ceil(0.9·n)-th smallest value. The result is always a gap that was really seen, and with few samples it rounds up (for n < 10 it is the maximum). Both properties push toward a longer delay, which is the safe direction against starvation. `p90([])` is 0 (no gap term). Non-finite values are skipped, and the input array is not mutated.
- `RenderClock` holds the current delay. Each `tick` moves the delay toward the target by at most `maxSlewSPerS · dtS` (default 0.2 s/s). It lands exactly on the target when the remaining distance fits in one step, so it never overshoots. It returns `tRenderMs = serverNowMs − delay·1000`. Render time therefore advances at 0.8–1.2× the rate of the server clock. When `dtS` is ≤ 0 or NaN (first frame, clock hiccup), the delay does not move. A jump in `serverNowMs` passes straight through, because smoothing the server clock is the caller's job.

**Tech Stack:** Node ≥ 24.2 (native TypeScript), `node:test`, TypeScript 7 (type-check only). The module has no runtime dependencies. It imports only the type `Quality` from `shared/types.ts`.

**Wave:** 1 (parallel; depends only on WP-00). **Estimated:** 30 min. **Validated:** every file below was run on 2026-09-22 in the shared Wave 1 sandbox (WP-00 files + installed `node_modules`). `node --test client/track/delay.test.ts` gave 14/14 pass. `npx tsc --noEmit` reported no errors in `client/track/delay*`. Task 1's intermediate files were type-checked and run in isolation (8/8 pass).

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- Delays and `dtS` are seconds. Timestamps (`serverNowMs`, the returned `tRenderMs`) are server-clock milliseconds, the same clock as `Sample.tMs`. `RenderClock` never reads `Date.now()`.
- Erasable TypeScript only (`#private` fields are plain JavaScript, so they are allowed). Relative imports have a `.ts` extension.
- This package creates or edits only the two files below.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `client/track/delay.ts` | `delayFloorS`, `targetDelayS`, `p90`, `class RenderClock`, `MIN_DELAY_S`, `MAX_DELAY_S` |
| `client/track/delay.test.ts` | floors, clamp, poll and gap terms, nearest-rank p90, slew limit, convergence |

---

### Task 1: Delay floor, target and p90

**Files:**
- Create: `client/track/delay.ts`, `client/track/delay.test.ts`
- Test: `client/track/delay.test.ts`

**Interfaces:**
- Consumes: `Quality` from `shared/types.ts` (WP-00)
- Produces: `delayFloorS(q: Quality): number` (adsb2 3, adsb01 4, mlat 6, other 6) · `targetDelayS(q: Quality, pollPeriodS: number, gapP90S: number): number` = `clamp(max(floor, poll + 1, p90 + 1), 3, 10)` · `p90(xs: number[]): number` (nearest rank; `[]` → 0) · extra exports `MIN_DELAY_S = 3`, `MAX_DELAY_S = 10`

- [ ] **Step 1: Write the failing test**

```ts
// client/track/delay.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { delayFloorS, p90, targetDelayS } from './delay.ts'

test('delay floor per quality: adsb2 3 s, adsb01 4 s, mlat 6 s, other 6 s', () => {
  assert.equal(delayFloorS('adsb2'), 3)
  assert.equal(delayFloorS('adsb01'), 4)
  assert.equal(delayFloorS('mlat'), 6)
  assert.equal(delayFloorS('other'), 6)
})

test('target = floor when polls are fast and gaps are small', () => {
  assert.equal(targetDelayS('adsb2', 1, 1), 3)
  assert.equal(targetDelayS('adsb01', 1, 1), 4)
  assert.equal(targetDelayS('mlat', 1, 2), 6)
})

test('poll-period term: poll + 1 s wins when it exceeds the floor', () => {
  assert.equal(targetDelayS('adsb2', 3, 0), 4)
  assert.equal(targetDelayS('adsb01', 5, 0), 6)
})

test('gap term: p90 gap + 1 s wins when it exceeds floor and poll term', () => {
  assert.equal(targetDelayS('adsb2', 1, 4.5), 5.5)
  assert.equal(targetDelayS('mlat', 1, 6.5), 7.5)
})

test('clamped to [3, 10] s', () => {
  assert.equal(targetDelayS('adsb2', 1, 30), 10)
  assert.equal(targetDelayS('mlat', 20, 0), 10)
  assert.equal(targetDelayS('adsb2', -5, -5), 3)
})

test('a NaN term is ignored rather than poisoning the clock', () => {
  assert.equal(targetDelayS('adsb2', Number.NaN, 4), 5)
  assert.equal(targetDelayS('adsb01', 1, Number.NaN), 4)
})

test('p90 is nearest-rank: the ceil(0.9·n)-th smallest observed value', () => {
  assert.equal(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9)
  assert.equal(p90([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]), 9)
  assert.equal(p90(Array.from({ length: 20 }, (_, i) => i + 1)), 18)
  assert.equal(p90([1, 1, 1, 1, 30]), 30)  // n = 5 → rank 5: one long gap in few samples counts
  assert.equal(p90([2.5]), 2.5)
})

test('p90 of nothing is 0 (no gap term); non-finite values are skipped; input is not mutated', () => {
  assert.equal(p90([]), 0)
  assert.equal(p90([Number.NaN, 2, 1]), 2)
  const xs = [3, 1, 2]
  p90(xs)
  assert.deepEqual(xs, [3, 1, 2])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/track/delay.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/track/delay.ts' imported from …/client/track/delay.test.ts`

- [ ] **Step 3: Write the implementation**

```ts
// client/track/delay.ts
// Playback delay: how far behind the server clock we render, so we interpolate between samples instead of guessing.
import type { Quality } from '../../shared/types.ts'

export const MIN_DELAY_S = 3
export const MAX_DELAY_S = 10

const FLOOR_S: Record<Quality, number> = { adsb2: 3, adsb01: 4, mlat: 6, other: 6 }

export function delayFloorS(q: Quality): number {
  return FLOOR_S[q]
}

/** 1 s of headroom over one poll period and over the p90 sample gap. A NaN term counts as absent. */
const term = (s: number): number => (Number.isNaN(s) ? 0 : s + 1)

/** clamp(max(floor, poll + 1, p90 gap + 1), 3, 10) seconds. */
export function targetDelayS(q: Quality, pollPeriodS: number, gapP90S: number): number {
  const d = Math.max(delayFloorS(q), term(pollPeriodS), term(gapP90S))
  return Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, d))
}

/**
 * 90th percentile by nearest rank: the ceil(0.9·n)-th smallest value, always an observed value, never
 * interpolated below a real gap. With few samples it rounds up (n < 10 → the max), which is the safe
 * direction for a delay. Empty → 0. Non-finite values are skipped.
 * ponytail: sorts a copy on every call; fine for the ≤ ~200 gaps a 180 s track holds. If it ever shows in a
 * profile, cache the result in Track and recompute only when a sample arrives.
 */
export function p90(xs: number[]): number {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  return s.length === 0 ? 0 : s[Math.ceil(0.9 * s.length) - 1]
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/track/delay.test.ts`
Expected: PASS — `ℹ tests 8`, `ℹ pass 8`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add client/track/delay.ts client/track/delay.test.ts
git commit -m "feat(track): playback delay floor, target and nearest-rank p90"
```

---

### Task 2: RenderClock

**Files:**
- Modify: `client/track/delay.ts`, `client/track/delay.test.ts` (the complete final content of both files is below)
- Test: `client/track/delay.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `class RenderClock { constructor(delayS: number, maxSlewSPerS?: number); tick(serverNowMs: number, targetDelayS: number, dtS: number): number; get delayS(): number }` (default slew 0.2 s/s; `tick` returns `tRenderMs = serverNowMs − delayS·1000`) · extra `readonly maxSlewSPerS: number`

- [ ] **Step 1: Write the failing test** (it replaces the whole file: Task 1's tests stay, and the `RenderClock` tests are added)

```ts
// client/track/delay.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { delayFloorS, p90, RenderClock, targetDelayS } from './delay.ts'

test('delay floor per quality: adsb2 3 s, adsb01 4 s, mlat 6 s, other 6 s', () => {
  assert.equal(delayFloorS('adsb2'), 3)
  assert.equal(delayFloorS('adsb01'), 4)
  assert.equal(delayFloorS('mlat'), 6)
  assert.equal(delayFloorS('other'), 6)
})

test('target = floor when polls are fast and gaps are small', () => {
  assert.equal(targetDelayS('adsb2', 1, 1), 3)
  assert.equal(targetDelayS('adsb01', 1, 1), 4)
  assert.equal(targetDelayS('mlat', 1, 2), 6)
})

test('poll-period term: poll + 1 s wins when it exceeds the floor', () => {
  assert.equal(targetDelayS('adsb2', 3, 0), 4)
  assert.equal(targetDelayS('adsb01', 5, 0), 6)
})

test('gap term: p90 gap + 1 s wins when it exceeds floor and poll term', () => {
  assert.equal(targetDelayS('adsb2', 1, 4.5), 5.5)
  assert.equal(targetDelayS('mlat', 1, 6.5), 7.5)
})

test('clamped to [3, 10] s', () => {
  assert.equal(targetDelayS('adsb2', 1, 30), 10)
  assert.equal(targetDelayS('mlat', 20, 0), 10)
  assert.equal(targetDelayS('adsb2', -5, -5), 3)
})

test('a NaN term is ignored rather than poisoning the clock', () => {
  assert.equal(targetDelayS('adsb2', Number.NaN, 4), 5)
  assert.equal(targetDelayS('adsb01', 1, Number.NaN), 4)
})

test('p90 is nearest-rank: the ceil(0.9·n)-th smallest observed value', () => {
  assert.equal(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9)
  assert.equal(p90([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]), 9)
  assert.equal(p90(Array.from({ length: 20 }, (_, i) => i + 1)), 18)
  assert.equal(p90([1, 1, 1, 1, 30]), 30)  // n = 5 → rank 5: one long gap in few samples counts
  assert.equal(p90([2.5]), 2.5)
})

test('p90 of nothing is 0 (no gap term); non-finite values are skipped; input is not mutated', () => {
  assert.equal(p90([]), 0)
  assert.equal(p90([Number.NaN, 2, 1]), 2)
  const xs = [3, 1, 2]
  p90(xs)
  assert.deepEqual(xs, [3, 1, 2])
})

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)

test('RenderClock at its target returns serverNowMs − delay·1000', () => {
  const c = new RenderClock(4)
  assert.equal(c.delayS, 4)
  assert.equal(c.tick(100_000, 4, 1 / 60), 96_000)
  assert.equal(c.delayS, 4)
})

test('RenderClock slews at most 0.2 s per second by default, both directions', () => {
  const up = new RenderClock(3)
  near(up.tick(50_000, 10, 1), 50_000 - 3200, 1e-9)
  near(up.delayS, 3.2, 1e-12)
  up.tick(50_000, 10, 0.5)
  near(up.delayS, 3.3, 1e-12)
  const down = new RenderClock(10)
  down.tick(50_000, 3, 2)
  near(down.delayS, 9.6, 1e-12)
})

test('RenderClock honours a custom maxSlewSPerS', () => {
  const c = new RenderClock(3, 1)
  c.tick(0, 10, 2)
  near(c.delayS, 5, 1e-12)
})

test('RenderClock over many 60 Hz ticks: slew-limited, render time keeps moving forward, converges without overshoot', () => {
  const c = new RenderClock(3)
  const dt = 1 / 60
  let server = 1_000_000
  let prevRender = c.tick(server, 10, 0)
  let prevDelay = c.delayS
  let reachedAtS: number | null = null
  for (let i = 1; i <= 60 * 40; i++) {
    server += dt * 1000
    const render = c.tick(server, 10, dt)
    const step = c.delayS - prevDelay
    assert.ok(Math.abs(step) <= 0.2 * dt + 1e-12, `tick ${i}: slew ${step / dt} s/s`)
    assert.ok(c.delayS <= 10, `overshoot ${c.delayS}`)
    const rate = (render - prevRender) / (dt * 1000)
    assert.ok(rate >= 0.8 - 1e-9 && rate <= 1.2 + 1e-9, `tick ${i}: render rate ${rate}`)
    if (reachedAtS === null && c.delayS === 10) reachedAtS = i * dt
    prevRender = render
    prevDelay = c.delayS
  }
  assert.ok(reachedAtS !== null, 'never reached the target')
  near(reachedAtS, 35, 2 * dt)  // (10 − 3) / 0.2
  assert.equal(c.delayS, 10)
  assert.equal(c.tick(server, 10, dt), server - 10_000)
})

test('RenderClock retargeted mid-slew turns around at once, still rate-limited', () => {
  const c = new RenderClock(3)
  for (let i = 0; i < 60 * 5; i++) c.tick(0, 10, 1 / 60)   // 5 s up → 4
  near(c.delayS, 4, 1e-9)
  for (let i = 0; i < 60 * 2; i++) c.tick(0, 3, 1 / 60)    // 2 s down → 3.6
  near(c.delayS, 3.6, 1e-9)
  for (let i = 0; i < 60 * 10; i++) c.tick(0, 3, 1 / 60)
  assert.equal(c.delayS, 3)
})

test('RenderClock: a long frame (tab hidden 10 s) moves the delay at most 2 s; zero, negative or NaN dt moves nothing', () => {
  const c = new RenderClock(3)
  c.tick(0, 10, 10)
  near(c.delayS, 5, 1e-12)
  for (const dt of [0, -1, Number.NaN]) {
    assert.equal(c.tick(20_000, 3, dt), 20_000 - c.delayS * 1000)
    near(c.delayS, 5, 1e-12)
  }
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/track/delay.test.ts`
Expected: FAIL — `SyntaxError: The requested module './delay.ts' does not provide an export named 'RenderClock'`

- [ ] **Step 3: Write the implementation** (complete final file)

```ts
// client/track/delay.ts
// Playback delay: how far behind the server clock we render, so we interpolate between samples instead of guessing.
import type { Quality } from '../../shared/types.ts'

export const MIN_DELAY_S = 3
export const MAX_DELAY_S = 10

const FLOOR_S: Record<Quality, number> = { adsb2: 3, adsb01: 4, mlat: 6, other: 6 }

export function delayFloorS(q: Quality): number {
  return FLOOR_S[q]
}

/** 1 s of headroom over one poll period and over the p90 sample gap. A NaN term counts as absent. */
const term = (s: number): number => (Number.isNaN(s) ? 0 : s + 1)

/** clamp(max(floor, poll + 1, p90 gap + 1), 3, 10) seconds. */
export function targetDelayS(q: Quality, pollPeriodS: number, gapP90S: number): number {
  const d = Math.max(delayFloorS(q), term(pollPeriodS), term(gapP90S))
  return Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, d))
}

/**
 * 90th percentile by nearest rank: the ceil(0.9·n)-th smallest value, always an observed value, never
 * interpolated below a real gap. With few samples it rounds up (n < 10 → the max), which is the safe
 * direction for a delay. Empty → 0. Non-finite values are skipped.
 * ponytail: sorts a copy on every call; fine for the ≤ ~200 gaps a 180 s track holds. If it ever shows in a
 * profile, cache the result in Track and recompute only when a sample arrives.
 */
export function p90(xs: number[]): number {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  return s.length === 0 ? 0 : s[Math.ceil(0.9 * s.length) - 1]
}

/**
 * Render time = server now − delay. The delay walks toward its target at ≤ maxSlewSPerS, so render time
 * advances at 0.8–1.2× the server clock's rate (default) and the delay never jumps. It lands exactly on
 * the target, no overshoot. A jump in serverNowMs passes straight through: smoothing that is the caller's job.
 */
export class RenderClock {
  #delayS: number
  readonly maxSlewSPerS: number

  constructor(delayS: number, maxSlewSPerS = 0.2) {
    this.#delayS = delayS
    this.maxSlewSPerS = maxSlewSPerS
  }

  /** Returns tRenderMs. dtS ≤ 0 or NaN (first frame, clock hiccup) leaves the delay unchanged. */
  tick(serverNowMs: number, targetDelayS: number, dtS: number): number {
    const step = this.maxSlewSPerS * (dtS > 0 ? dtS : 0)
    const diff = targetDelayS - this.#delayS
    this.#delayS = Math.abs(diff) <= step ? targetDelayS : this.#delayS + Math.sign(diff) * step
    return serverNowMs - this.#delayS * 1000
  }

  get delayS(): number {
    return this.#delayS
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/track/delay.test.ts`
Expected: PASS — `ℹ tests 14`, `ℹ pass 14`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add client/track/delay.ts client/track/delay.test.ts
git commit -m "feat(track): slew-limited RenderClock"
```

---

### Task 3: WP gate

- [ ] **Step 1: This package's tests**

Run: `node --test client/track/delay.test.ts`
Expected: `ℹ tests 14`, `ℹ pass 14`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/track/delay'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Full check in the worktree**

Run: `npm run check`
Expected: `tsc` prints nothing. On a worktree branched from `wave-0` the counts are `ℹ tests 55`, `ℹ pass 55`, `ℹ fail 0` (41 from WP-00 + 14 here).

- [ ] **Step 4: Confirm there is nothing left to commit**

Run: `git status --short`
Expected: no output.

# WP-T2 — Motion Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The pure scoring functions behind the G2 motion bars: frame discontinuity while interpolating, lateral acceleration, jerk, vertical-rate fidelity and per-frame height steps, held-out cross-track error and render-delay slew, plus the one `percentile` definition they share.

**Architecture:** One module of pure functions over `Frame[]` (`tools/types.ts`: t in s, e/n/u in m in one local ENU frame) that WP-A3 (`tools/bench-track.ts`) builds from a causal replay at 60 Hz. Everything is a plain finite difference. At 60 Hz the truncation error is O(a·dt²), far below every G2 threshold. Definitions (also documented in the code): `frameDiscontinuity` scores three consecutive `'interp'` frames a, b, c as the 3D miss `|(c − b) − v̂·(c.t − b.t)|`, with `v̂ = (b − a)/(b.t − a.t)` from the previous interval. So constant velocity scores 0 (also with irregular spacing), smooth acceleration scores a·dt², and a position step of s metres scores ≈ s. `lateralAccel` is `|a⊥| = |a_e·v_n − a_n·v_e| / |v|`, from horizontal second differences and central-difference velocity. A circle of radius r at speed v gives v²/r. Along-track acceleration gives 0. At zero speed the whole horizontal |a| counts. `jerk` is `|Δa|/Δt` between consecutive 3D second-difference accelerations (v³/r² on a circle). `verticalMetrics` compares the rendered VS `Δu/Δt` of each frame pair with the reported rate, linearly interpolated at the pair's midpoint. It returns the p95 of |error| (pairs outside the reported span are skipped) and the max |Δu| per frame. `crossTrackErrors` is the horizontal distance from each truth point to the rendered position at the same t, linearly interpolated between frames. Truth outside the rendered span is skipped. The distance includes along-track error, so it is an upper bound on pure cross-track error. `delaySlew` is `max |Δd/Δt|`. `percentile` interpolates linearly between the closest ranks (Hyndman–Fan type 7, as in numpy and Excel PERCENTILE.INC). Frames must be in time order, and pairs or triples whose t does not increase are skipped. **No data → NaN**, so a gate fed nothing fails instead of passing (`NaN <= x` is false; JSON writes `null`).

**Tech Stack:** Node ≥ 24.2 (native TypeScript), `node:test`, TypeScript 7 (type-check only). No dependencies.

**Wave:** 1 (parallel; depends only on WP-00). **Estimated:** 1 h. **Validated:** every file below was run in a sandbox copy of the Wave 0 tree on 2026-09-22 (Node v25.2.1, TypeScript 7.0.2). The test was run before the module existed and failed with `ERR_MODULE_NOT_FOUND`. After the implementation, `node --test tools/metrics.test.ts` → 11/11 pass, and `npx tsc --noEmit` reports no errors in `tools/metrics*`. Measured on synthetic 60 Hz frames: a 100 m/s circle of radius 2000 m gives lateral acceleration 5.0000 m/s² (tolerance 1e-4), jerk 0.250 m/s³, and a frame discontinuity of 1.39 mm. A 5 m step scores 5.000 m. A 25 ft quantised climb at 5 m/s gives `maxStepM` 7.62 m and `vsErrP95` 5 m/s. The smooth climb scores 0.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. The ones this package relies on:
- Erasable TypeScript only, `.ts` extensions on relative imports.
- Tests: `node:test` + `node:assert/strict`, next to the code, no network. All inputs are synthetic frames.
- SI units inside: seconds, metres, m/s. `RateAt.vsMs` is already m/s. WP-A3 converts fpm (× 0.00508).

**Notes for WP-A3 (the consumer):**
- `Frame.u` must be height above one reference, for example `hM − h0`. It must not be a tangent-plane "up": ENU up drops d²/2R below the height at distance d from the origin (7.8 m at 10 km). That drop reads as a spurious VS of d·v/R (0.78 m/s at 20 km and 250 m/s).
- Pass frames of one aircraft in time order. Filter by mode yourself when a bar is scoped (for example, turns only for the cross-track bar). Only `frameDiscontinuity` filters internally (interp only).
- `delaySlew` expects `t` and `d` both in seconds (result in s/s).

## Files owned by this package

| Path | Responsibility |
|---|---|
| `tools/metrics.ts` | `percentile`, `frameDiscontinuity`, `lateralAccel`, `jerk`, `verticalMetrics`, `crossTrackErrors`, `delaySlew` |
| `tools/metrics.test.ts` | straight line, circle (v²/r, v³/r²), injected 5 m jump, 25 ft quantisation, rate interpolation, cross-track, delay slew |

---

### Task 1: Motion metrics

**Files:**
- Create: `tools/metrics.ts`, `tools/metrics.test.ts`
- Test: `tools/metrics.test.ts`

**Interfaces:**
- Consumes: `Frame`, `RateAt` from `tools/types.ts` (WP-00)
- Produces: `percentile(xs: number[], p: number): number` (p in 0..100, clamped; empty → NaN) · `frameDiscontinuity(frames: Frame[]): { maxM: number; p99M: number }` · `lateralAccel(frames: Frame[]): { p99: number; max: number }` · `jerk(frames: Frame[]): { p99: number }` · `verticalMetrics(frames: Frame[], reported: RateAt[]): { vsErrP95: number; maxStepM: number }` · `crossTrackErrors(frames: Frame[], truth: { t: number; e: number; n: number }[]): number[]` · `delaySlew(delays: { t: number; d: number }[]): number`

- [ ] **Step 1: Write the failing test**

```ts
// tools/metrics.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crossTrackErrors, delaySlew, frameDiscontinuity, jerk, lateralAccel, percentile, verticalMetrics } from './metrics.ts'
import type { Frame, RateAt } from './types.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)
const HZ = 60

/** Synthetic 60 Hz frames for `seconds` of motion: pos(t) → [e, n, u]. */
function framesOf(pos: (t: number) => [number, number, number], seconds: number, mode: Frame['mode'] = 'interp'): Frame[] {
  const out: Frame[] = []
  for (let i = 0; i <= seconds * HZ; i++) {
    const t = i / HZ
    const [e, n, u] = pos(t)
    out.push({ t, e, n, u, mode, headingDeg: 0, pitchDeg: 0, rollDeg: 0 })
  }
  return out
}

const straight = (t: number): [number, number, number] => [120 * t - 3000, -80 * t + 1500, 5 * t + 900]
/** Circle of radius r (m) at speed v (m/s), counter-clockwise from due east of the centre, 1000 m up. */
const circle = (r: number, v: number) => (t: number): [number, number, number] => [r * Math.cos((v / r) * t), r * Math.sin((v / r) * t), 1000]

test('percentile: linear interpolation between closest ranks (type 7), input untouched, empty → NaN', () => {
  const xs = [4, 1, 3, 2]
  assert.equal(percentile(xs, 50), 2.5)
  assert.equal(percentile(xs, 0), 1)
  assert.equal(percentile(xs, 100), 4)
  assert.deepEqual(xs, [4, 1, 3, 2])
  near(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95), 95.05, 1e-9)
  assert.equal(percentile([7], 99), 7)
  assert.equal(percentile(xs, 150), 4, 'p is clamped to 0..100')
  assert.ok(Number.isNaN(percentile([], 50)))
})

test('frameDiscontinuity: constant velocity scores 0, also with irregular frame spacing', () => {
  const r = frameDiscontinuity(framesOf(straight, 10))
  near(r.maxM, 0, 1e-9)
  near(r.p99M, 0, 1e-9)
  let t = 0
  const jittered: Frame[] = []
  for (let i = 0; i < 600; i++) {
    t += i % 2 ? 1 / 50 : 1 / 70
    const [e, n, u] = straight(t)
    jittered.push({ t, e, n, u, mode: 'interp', headingDeg: 0, pitchDeg: 0, rollDeg: 0 })
  }
  near(frameDiscontinuity(jittered).maxM, 0, 1e-9)
})

test('frameDiscontinuity: a 5 m position jump scores ≈ 5 m; a smooth circle scores a·dt²', () => {
  const frames = framesOf(straight, 10).map((f, i) => (i >= 300 ? { ...f, e: f.e + 3, n: f.n + 4 } : f))
  near(frameDiscontinuity(frames).maxM, 5, 1e-6)
  const turn = frameDiscontinuity(framesOf(circle(2000, 100), 20))
  near(turn.maxM, 5 / HZ / HZ, 1e-6, 'a = v²/r = 5 m/s² → 1.39 mm per 60 Hz frame')
})

test('frameDiscontinuity: only triples of interp frames count; none → NaN', () => {
  const frames = framesOf(straight, 10).map((f, i) => (i >= 300 ? { ...f, e: f.e + 3, n: f.n + 4 } : f))
  frames[300] = { ...frames[300], mode: 'extrap' }
  frames[301] = { ...frames[301], mode: 'extrap' }
  near(frameDiscontinuity(frames).maxM, 0, 1e-9, 'the jump sits inside extrap frames')
  const none = frameDiscontinuity(framesOf(straight, 1, 'extrap'))
  assert.ok(Number.isNaN(none.maxM) && Number.isNaN(none.p99M))
})

test('lateralAccel: circle of radius r at speed v gives v²/r; straight line and along-track acceleration give 0', () => {
  const r = lateralAccel(framesOf(circle(2000, 100), 30))
  near(r.max, 5, 1e-4)
  near(r.p99, 5, 1e-4)
  const fast = lateralAccel(framesOf(circle(500, 60), 10))
  near(fast.max, 7.2, 1e-4, '60²/500')
  near(lateralAccel(framesOf(straight, 10)).max, 0, 1e-6)
  const braking = lateralAccel(framesOf((t) => [70 * t - 1.5 * t * t, 0, 0], 20))
  near(braking.max, 0, 1e-6, 'deceleration along the track is not lateral')
})

test('lateralAccel: a stopped aircraft counts its whole horizontal acceleration; too few frames → NaN', () => {
  const frames = framesOf(() => [10, 20, 5], 1)
  frames[30] = { ...frames[30], e: 10.01 }
  near(lateralAccel(frames).max, 0.02 * HZ * HZ, 1e-6, 'second difference of a 1 cm one-frame spike')
  assert.ok(Number.isNaN(lateralAccel(frames.slice(0, 2)).max))
})

test('jerk: |Δa|/Δt is v³/r² on a circle and 0 on a straight line', () => {
  near(jerk(framesOf(circle(2000, 100), 30)).p99, 0.25, 1e-3)
  near(jerk(framesOf(straight, 10)).p99, 0, 1e-5)
  near(jerk(framesOf((t) => [70 * t - 1.5 * t * t, 0, 0], 20)).p99, 0, 1e-5, 'constant acceleration has no jerk')
})

test('verticalMetrics: smooth climb matches the reported rate; 25 ft quantisation shows as steps', () => {
  const reported: RateAt[] = [{ t: 0, vsMs: 5 }, { t: 30, vsMs: 5 }]
  const smooth = verticalMetrics(framesOf((t) => [0, 0, 1000 + 5 * t], 30), reported)
  near(smooth.vsErrP95, 0, 1e-6)
  near(smooth.maxStepM, 5 / HZ, 1e-9)
  const step = 25 * 0.3048
  const quantised = verticalMetrics(framesOf((t) => [0, 0, Math.floor((1000 + 5 * t) / step) * step], 30), reported)
  near(quantised.maxStepM, step, 1e-9)
  near(quantised.vsErrP95, 5, 1e-9, 'most frames render 0 m/s against a reported 5 m/s')
})

test('verticalMetrics: reported rate is linearly interpolated at the frame-pair midpoint; frames outside it are skipped', () => {
  const reported: RateAt[] = [{ t: 0, vsMs: 0 }, { t: 10, vsMs: 10 }]
  near(verticalMetrics(framesOf((t) => [0, 0, 0.5 * t * t], 10), reported).vsErrP95, 0, 1e-6)
  const late = verticalMetrics(framesOf((t) => [0, 0, 0.5 * t * t], 10).map((f) => ({ ...f, t: f.t + 20 })), reported)
  assert.ok(Number.isNaN(late.vsErrP95))
  near(late.maxStepM, 10 / HZ, 1e-3, 'steps do not need a reported rate')
})

test('crossTrackErrors: distance to the rendered position at the same t, interpolated between frames', () => {
  const frames = framesOf((t) => [100 * t, 0, 500], 10)
  const errs = crossTrackErrors(frames, [
    { t: -1, e: -100, n: 0 },
    { t: 0.5, e: 50, n: 3 },
    { t: 1.2345, e: 123.45, n: -3 },
    { t: 2, e: 204, n: 0 },
    { t: 10, e: 1000, n: 0 },
    { t: 11, e: 1100, n: 0 },
  ])
  assert.equal(errs.length, 4, 'truth outside the rendered span is skipped')
  near(errs[0], 3, 1e-9)
  near(errs[1], 3, 1e-9)
  near(errs[2], 4, 1e-9, 'along-track error counts too (time-aligned distance)')
  near(errs[3], 0, 1e-9)
  assert.deepEqual(crossTrackErrors([], [{ t: 0, e: 0, n: 0 }]), [])
})

test('delaySlew: max |Δd/Δt| over consecutive samples', () => {
  const ramp = Array.from({ length: 121 }, (_, i) => ({ t: i / HZ, d: 3 + 0.2 * (i / HZ) }))
  near(delaySlew(ramp), 0.2, 1e-9)
  assert.equal(delaySlew(Array.from({ length: 10 }, (_, i) => ({ t: i, d: 4 }))), 0)
  near(delaySlew([{ t: 0, d: 3 }, { t: 1 / HZ, d: 3.5 }, { t: 1 / HZ, d: 9 }]), 30, 1e-9, 'a 0.5 s jump in one frame; the zero-Δt pair is skipped')
  assert.ok(Number.isNaN(delaySlew([{ t: 0, d: 3 }])))
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tools/metrics.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/tools/metrics.ts'`, `ℹ fail 1`

- [ ] **Step 3: Write the implementation**

```ts
// tools/metrics.ts
/**
 * G2 motion metrics over rendered frames. Pure functions; tools/bench-track.ts (WP-A3) feeds them the 60 Hz
 * Frame[] of a causal replay. Frame: t in seconds, e/n/u in metres in one local ENU frame.
 *
 * Conventions:
 * - Frames are in time order. A pair or triple whose t does not strictly increase is skipped.
 * - Every mode counts ('interp' | 'extrap' | 'stale': it is what the viewer sees) except in frameDiscontinuity,
 *   which scores interpolation only. Pass a filtered array to score a subset.
 * - No data → NaN, so a gate fed nothing fails instead of passing (NaN <= x is false; JSON writes it as null).
 * - Derivatives are plain finite differences. At 60 Hz their truncation error is O(a·dt²), far below every G2 bar.
 */
import type { Frame, RateAt } from './types.ts'

/** Largest value; NaN for an empty list. A loop, not Math.max(...xs), so an hour of 60 Hz frames cannot overflow the stack. */
function max(xs: number[]): number {
  let m = -Infinity
  for (const x of xs) if (x > m) m = x
  return xs.length === 0 ? NaN : m
}

/**
 * p-th percentile, p in 0..100 (clamped), by linear interpolation between the closest ranks of the ascending sort:
 * rank = p/100 · (n − 1) (Hyndman–Fan type 7, the default of numpy and Excel PERCENTILE.INC).
 * So p50 of [1, 2, 3, 4] is 2.5 and p95 of 1..100 is 95.05. The input is not mutated. Empty → NaN.
 */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN
  const s = xs.toSorted((a, b) => a - b)
  const r = (Math.min(Math.max(p, 0), 100) / 100) * (s.length - 1)
  const lo = Math.floor(r)
  const hi = Math.ceil(r)
  return s[lo] + (r - lo) * (s[hi] - s[lo])
}

/**
 * Frame-to-frame discontinuity while interpolating. For three consecutive 'interp' frames a, b, c the velocity
 * over the previous interval is v̂ = (b − a)/(b.t − a.t), and the score is the 3D miss |(c − b) − v̂·(c.t − b.t)| in metres.
 * Constant velocity scores 0 (also with irregular frame spacing). Smooth acceleration a scores a·dt²
 * (1.4 mm at 5 m/s² and 60 Hz). A position step of s metres scores ≈ s on its frame and on the next one.
 */
export function frameDiscontinuity(frames: Frame[]): { maxM: number; p99M: number } {
  const d: number[] = []
  for (let i = 2; i < frames.length; i++) {
    const a = frames[i - 2]
    const b = frames[i - 1]
    const c = frames[i]
    if (a.mode !== 'interp' || b.mode !== 'interp' || c.mode !== 'interp') continue
    const dt1 = b.t - a.t
    const dt2 = c.t - b.t
    if (!(dt1 > 0 && dt2 > 0)) continue
    const k = dt2 / dt1
    d.push(Math.hypot(c.e - b.e - k * (b.e - a.e), c.n - b.n - k * (b.n - a.n), c.u - b.u - k * (b.u - a.u)))
  }
  return { maxM: max(d), p99M: percentile(d, 99) }
}

interface Kin {
  t: number
  ae: number
  an: number
  au: number
  ve: number
  vn: number
}

/**
 * Acceleration (second difference, exact for constant acceleration) and horizontal velocity (central difference)
 * at the middle frame b of every three consecutive frames a, b, c with increasing t.
 */
function kinematics(frames: Frame[]): Kin[] {
  const out: Kin[] = []
  for (let i = 1; i + 1 < frames.length; i++) {
    const a = frames[i - 1]
    const b = frames[i]
    const c = frames[i + 1]
    const dt1 = b.t - a.t
    const dt2 = c.t - b.t
    if (!(dt1 > 0 && dt2 > 0)) continue
    const h = (dt1 + dt2) / 2
    const acc = (x: 'e' | 'n' | 'u'): number => ((c[x] - b[x]) / dt2 - (b[x] - a[x]) / dt1) / h
    out.push({ t: b.t, ae: acc('e'), an: acc('n'), au: acc('u'), ve: (c.e - a.e) / (dt1 + dt2), vn: (c.n - a.n) / (dt1 + dt2) })
  }
  return out
}

/**
 * Lateral acceleration |a⊥| in m/s²: the horizontal second-difference acceleration minus its component along the
 * horizontal velocity, |a_e·v_n − a_n·v_e| / |v|. A circle of radius r flown at speed v gives v²/r; speeding up or
 * braking along the track gives 0. At zero speed the direction is undefined, so the whole horizontal |a| counts.
 */
export function lateralAccel(frames: Frame[]): { p99: number; max: number } {
  const lat = kinematics(frames).map((k) => {
    const v = Math.hypot(k.ve, k.vn)
    return v > 0 ? Math.abs(k.ae * k.vn - k.an * k.ve) / v : Math.hypot(k.ae, k.an)
  })
  return { p99: percentile(lat, 99), max: max(lat) }
}

/**
 * Jerk |Δa|/Δt in m/s³ between the 3D second-difference accelerations of consecutive frames.
 * A circle of radius r at speed v gives v³/r²; a straight line or constant acceleration gives 0.
 */
export function jerk(frames: Frame[]): { p99: number } {
  const k = kinematics(frames)
  const j: number[] = []
  for (let i = 1; i < k.length; i++) {
    const dt = k[i].t - k[i - 1].t
    if (dt > 0) j.push(Math.hypot(k[i].ae - k[i - 1].ae, k[i].an - k[i - 1].an, k[i].au - k[i - 1].au) / dt)
  }
  return { p99: percentile(j, 99) }
}

/** Indices and weight for linear interpolation at t in a list sorted by t: value = x[i] + w·(x[j] − x[i]). Null outside [first.t, last.t]. */
function bracket(xs: { t: number }[], t: number): { i: number; j: number; w: number } | null {
  const n = xs.length
  if (n === 0 || !(t >= xs[0].t && t <= xs[n - 1].t)) return null
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1 // invariant: xs[lo].t <= t <= xs[hi].t
    if (xs[mid].t <= t) lo = mid
    else hi = mid
  }
  const dt = xs[hi].t - xs[lo].t
  return { i: lo, j: hi, w: dt > 0 ? (t - xs[lo].t) / dt : 1 }
}

/**
 * Vertical fidelity. For each consecutive frame pair the rendered VS is Δu/Δt (m/s). It is compared with the reported
 * rate (sorted by t, m/s) linearly interpolated at the pair's midpoint, the instant a finite difference measures.
 * Pairs outside the reported span are skipped. vsErrP95 = p95 of |rendered − reported|; maxStepM = max |Δu| between
 * consecutive frames over all pairs (a 25 ft quantisation step renders as a 7.62 m jump).
 * Frame.u must be height above one reference: an ENU "up" drops d²/2R below it at distance d from the origin
 * (7.8 m at 10 km), which reads as a spurious VS of d·v/R.
 */
export function verticalMetrics(frames: Frame[], reported: RateAt[]): { vsErrP95: number; maxStepM: number } {
  const err: number[] = []
  const steps: number[] = []
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]
    const b = frames[i]
    steps.push(Math.abs(b.u - a.u))
    const dt = b.t - a.t
    const r = dt > 0 ? bracket(reported, (a.t + b.t) / 2) : null
    if (!r) continue
    const vs = reported[r.i].vsMs + r.w * (reported[r.j].vsMs - reported[r.i].vsMs)
    err.push(Math.abs((b.u - a.u) / dt - vs))
  }
  return { vsErrP95: percentile(err, 95), maxStepM: max(steps) }
}

/**
 * Horizontal distance (m) from each truth point to the rendered position at the same t, linearly interpolated
 * between the bracketing frames. Truth points outside the rendered span are skipped, so the result can be shorter
 * than `truth`. This time-aligned distance includes along-track error, so it bounds the pure cross-track error from above.
 * ponytail: no projection onto the path normal, so a render that is only late along the track also scores here. That is
 * the conservative side for the G2 turn bars; if timing error ever dominates, project the miss onto the rendered track normal.
 */
export function crossTrackErrors(frames: Frame[], truth: { t: number; e: number; n: number }[]): number[] {
  const out: number[] = []
  for (const p of truth) {
    const r = bracket(frames, p.t)
    if (!r) continue
    const f = frames[r.i]
    const g = frames[r.j]
    out.push(Math.hypot(f.e + r.w * (g.e - f.e) - p.e, f.n + r.w * (g.n - f.n) - p.n))
  }
  return out
}

/** Largest render-delay slew max |Δd/Δt| over consecutive samples with increasing t; t and d both in seconds → s/s. */
export function delaySlew(delays: { t: number; d: number }[]): number {
  const s: number[] = []
  for (let i = 1; i < delays.length; i++) {
    const dt = delays[i].t - delays[i - 1].t
    if (dt > 0) s.push(Math.abs(delays[i].d - delays[i - 1].d) / dt)
  }
  return max(s)
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tools/metrics.test.ts`
Expected: PASS — `ℹ tests 11`, `ℹ pass 11`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add tools/metrics.ts tools/metrics.test.ts
git commit -m "feat(tools): G2 motion metrics (discontinuity, lateral accel, jerk, vertical, cross-track, delay slew)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: WP gate

- [ ] **Step 1: Run every test this package owns**

Run: `node --test tools/metrics.test.ts`
Expected: `ℹ tests 11`, `ℹ pass 11`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'tools/metrics'`
Expected: no output (grep exits 1). On a branch where every merged package is complete, `npm run check` must also pass.

- [ ] **Step 3: Confirm everything is committed and record the gate**

```bash
git status --short -- tools/metrics.ts tools/metrics.test.ts
git commit --allow-empty -m "chore(tools): WP-T2 gate passed (11 tests, tsc clean)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `git status` prints nothing before the commit. The branch `wp/T2` is ready to merge.

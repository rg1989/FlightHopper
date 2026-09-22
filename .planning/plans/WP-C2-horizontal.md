# WP-C2 — Horizontal Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pure, node-testable horizontal motion for the delayed-playback estimator: cubic Hermite between two samples, constant-turn dead reckoning after the newest one, a smooth re-join when fresh data corrects the path, and an MLAT clean-up chain (outlier gate → smoothing → velocities) that turns noisy positions into `KinPoint`s.

**Architecture:** Two small modules of pure functions in the Track's local ENU frame (`KinPoint`/`PosT` from `client/track/types.ts`: t in s, e/n in m, ve/vn in m/s). `hermite.ts` holds `hermite` (tangent = velocity·(b.t − a.t), t clamped to the segment, endpoints bit-exact), `extrapolate` (exact circular arc in sinc/rotation form, so 0 °/s is an exact straight line and tiny turn rates do not cancel; + = right turn = track angle increasing) and `RejoinBlend` (error = previously rendered − new estimate, decayed with a raised cosine `(1 + cos πu)/2`, so it has zero slope at both ends, exactly 0 from `tS + durationS` on, and 0 before any start and for t < tS). `mlat.ts` holds `gateOutliers` (speed from the last kept point, non-increasing times dropped), `smoothPositions` (centered window that shrinks symmetrically at the ends; t is averaged too, which keeps constant-velocity motion unbiased under irregular MLAT timing) and `velocitiesFromPositions` (central differences, one-sided at the ends). WP-I2's `Track` consumes all six: ADS-B samples become `KinPoint`s directly from gs/track, MLAT windows go gate → smooth → velocities, rendering uses `hermite` between the bracketing points, `extrapolate` past the newest (turn rate from WP-C5 `turnRateDegS`) and `RejoinBlend` when a new sample lands.

**Tech Stack:** Node ≥ 24.2 (native TypeScript), `node:test`, TypeScript 7 (type-check only). No dependencies.

**Wave:** 1 (parallel; depends only on WP-00). **Estimated:** 1 h. **Validated:** every file below was run in a sandbox copy of the Wave 0 tree on 2026-09-22 (Node v25.2.1, TypeScript 7.0.2): `node --test client/track/hermite.test.ts client/track/mlat.test.ts` → 21/21 pass; `npx tsc --noEmit` reports no errors in `client/track/{hermite,mlat}*`. Measured: a 250 m/s arc turning 1.5 °/s, sampled every 3 s, stays within 0.95 mm of the true arc (7.3 mm at 5 s) against a straight-chord error of 7.36 m (20.45 m at 5 s). Smoothing with halfWindow 3 cuts the RMS position error from 89.2 m to 43.2 m (σ = 60 m). Gate → smooth → differentiate cuts the velocity RMS from 266.7 m/s to 10.5 m/s with a 5 km outlier present. The speed gate at 1000 m/s dropped 0 % of good points at σ = 100 m and 1 s spacing (1.28 % at 600 m/s).

## Global Constraints

See `.planning/PLAN.md` § Global Constraints — they apply to every task here. The ones this package relies on:
- Erasable TypeScript only (`#private` fields, no parameter properties), `.ts` extensions on relative imports.
- Tests: `node:test` + `node:assert/strict`, next to the code, no network. Noisy tracks come from a seeded PRNG, so every run is identical.
- Units stay SI inside the estimator: seconds, metres, m/s, ENU axes (e = east, n = north).

## Files owned by this package

| Path | Responsibility |
|---|---|
| `client/track/hermite.ts` | `hermite`, `extrapolate`, `RejoinBlend` (+ exported `HState` return type) |
| `client/track/hermite.test.ts` | exactness, arc accuracy vs chord, turn sign, blend shape |
| `client/track/mlat.ts` | `gateOutliers`, `smoothPositions`, `velocitiesFromPositions` |
| `client/track/mlat.test.ts` | outlier removal, RMS reduction, end behaviour, full pipeline |

---

### Task 1: Hermite interpolation, dead reckoning and re-join blend

**Files:**
- Create: `client/track/hermite.ts`, `client/track/hermite.test.ts`
- Test: `client/track/hermite.test.ts`

**Interfaces:**
- Consumes: `KinPoint` from `client/track/types.ts` (WP-00)
- Produces: `hermite(a: KinPoint, b: KinPoint, t: number): { e: number; n: number; ve: number; vn: number }` · `extrapolate(last: KinPoint, turnRateDegS: number, dtS: number): { e: number; n: number; ve: number; vn: number }` (constant speed and turn rate; + = right turn) · `class RejoinBlend { constructor(durationS?: number); start(errE: number, errN: number, tS: number): void; offset(tS: number): { e: number; n: number } }` (default 1.5 s, raised-cosine decay) · extra export `interface HState { e; n; ve; vn }`

- [ ] **Step 1: Write the failing test**

```ts
// client/track/hermite.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RejoinBlend, extrapolate, hermite } from './hermite.ts'
import type { KinPoint } from './types.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)
const rad = (d: number): number => (d * Math.PI) / 180

/** True constant-turn arc: speed v m/s, initial track psi0Deg, turn rate wDegS (+ = right), starting at the origin at t = 0. */
function arc(v: number, psi0Deg: number, wDegS: number) {
  const w = rad(wDegS)
  const psi0 = rad(psi0Deg)
  const r = v / w
  return (t: number): KinPoint => {
    const psi = psi0 + w * t
    return { t, e: r * (Math.cos(psi0) - Math.cos(psi)), n: r * (Math.sin(psi) - Math.sin(psi0)), ve: v * Math.sin(psi), vn: v * Math.cos(psi) }
  }
}

/** Max position error of hermite (and of the straight chord) against the true arc, sampled every stepS over nSeg segments. */
function arcErrors(stepS: number, nSeg: number): { hermiteM: number; chordM: number; hermiteVelMs: number } {
  const truth = arc(250, 30, 1.5)
  let hermiteM = 0
  let chordM = 0
  let hermiteVelMs = 0
  for (let k = 0; k < nSeg; k++) {
    const a = truth(k * stepS)
    const b = truth((k + 1) * stepS)
    for (let i = 0; i <= 100; i++) {
      const t = a.t + (i / 100) * stepS
      const x = truth(t)
      const h = hermite(a, b, t)
      const s = (t - a.t) / stepS
      hermiteM = Math.max(hermiteM, Math.hypot(h.e - x.e, h.n - x.n))
      hermiteVelMs = Math.max(hermiteVelMs, Math.hypot(h.ve - x.ve, h.vn - x.vn))
      chordM = Math.max(chordM, Math.hypot(a.e + s * (b.e - a.e) - x.e, a.n + s * (b.n - a.n) - x.n))
    }
  }
  return { hermiteM, chordM, hermiteVelMs }
}

test('hermite: endpoints and endpoint velocities are exact', () => {
  const a: KinPoint = { t: 10, e: 123.4, n: -56.7, ve: 180.3, vn: -91.2 }
  const b: KinPoint = { t: 13, e: 650.1, n: -330.9, ve: 170.8, vn: -99.9 }
  assert.deepEqual(hermite(a, b, a.t), { e: a.e, n: a.n, ve: a.ve, vn: a.vn })
  assert.deepEqual(hermite(a, b, b.t), { e: b.e, n: b.n, ve: b.ve, vn: b.vn })
})

test('hermite: t is clamped to [a.t, b.t]', () => {
  const a: KinPoint = { t: 0, e: 0, n: 0, ve: 100, vn: 0 }
  const b: KinPoint = { t: 2, e: 200, n: 10, ve: 100, vn: 10 }
  assert.deepEqual(hermite(a, b, -5), hermite(a, b, 0))
  assert.deepEqual(hermite(a, b, 99), hermite(a, b, 2))
})

test('hermite: a degenerate segment (b.t <= a.t) returns b', () => {
  const a: KinPoint = { t: 5, e: 1, n: 2, ve: 3, vn: 4 }
  const b: KinPoint = { t: 5, e: 5, n: 6, ve: 7, vn: 8 }
  assert.deepEqual(hermite(a, b, 5), { e: 5, n: 6, ve: 7, vn: 8 })
})

test('hermite: a straight constant-velocity line is reproduced exactly', () => {
  const ve = 212.5
  const vn = -143.25
  const a: KinPoint = { t: 100, e: 1000, n: -2000, ve, vn }
  const b: KinPoint = { t: 104.5, e: 1000 + ve * 4.5, n: -2000 + vn * 4.5, ve, vn }
  for (let i = 0; i <= 45; i++) {
    const t = 100 + i * 0.1
    const p = hermite(a, b, t)
    near(p.e, 1000 + ve * (t - 100), 1e-9, `e at ${t}`)
    near(p.n, -2000 + vn * (t - 100), 1e-9, `n at ${t}`)
    near(p.ve, ve, 1e-9, `ve at ${t}`)
    near(p.vn, vn, 1e-9, `vn at ${t}`)
  }
})

test('hermite: 250 m/s arc turning 1.5°/s, sampled every 3 s, stays within 1 m of the true arc; chord error is far larger', (t) => {
  const three = arcErrors(3, 20)
  const five = arcErrors(5, 12)
  t.diagnostic(`3 s: hermite max ${three.hermiteM.toExponential(2)} m, vel ${three.hermiteVelMs.toExponential(2)} m/s, chord max ${three.chordM.toFixed(2)} m`)
  t.diagnostic(`5 s: hermite max ${five.hermiteM.toExponential(2)} m, vel ${five.hermiteVelMs.toExponential(2)} m/s, chord max ${five.chordM.toFixed(2)} m`)
  assert.ok(three.hermiteM < 1, `3 s hermite ${three.hermiteM} m`)
  assert.ok(five.hermiteM < 1, `5 s hermite ${five.hermiteM} m`)
  assert.ok(three.hermiteVelMs < 0.01, `3 s hermite velocity ${three.hermiteVelMs} m/s`)
  assert.ok(three.chordM > 5, `3 s chord ${three.chordM} m`)
  assert.ok(three.chordM > 100 * three.hermiteM, 'chord error should dwarf hermite error at 3 s')
  assert.ok(five.chordM > 100 * five.hermiteM, 'chord error should dwarf hermite error at 5 s')
})

test('extrapolate: zero turn rate is a straight line at constant velocity', () => {
  const last: KinPoint = { t: 50, e: 10, n: 20, ve: 150, vn: -80 }
  assert.deepEqual(extrapolate(last, 0, 0), { e: 10, n: 20, ve: 150, vn: -80 })
  const p = extrapolate(last, 0, 4)
  near(p.e, 10 + 150 * 4, 1e-9)
  near(p.n, 20 - 80 * 4, 1e-9)
  assert.equal(p.ve, 150)
  assert.equal(p.vn, -80)
})

test('extrapolate: constant speed and turn rate follow the exact arc', () => {
  const truth = arc(250, 30, 1.5)
  const last = truth(0)
  for (const dt of [0.5, 1, 3, 8, 20]) {
    const p = extrapolate(last, 1.5, dt)
    const x = truth(dt)
    near(p.e, x.e, 1e-6, `e at ${dt}`)
    near(p.n, x.n, 1e-6, `n at ${dt}`)
    near(p.ve, x.ve, 1e-9, `ve at ${dt}`)
    near(p.vn, x.vn, 1e-9, `vn at ${dt}`)
    near(Math.hypot(p.ve, p.vn), 250, 1e-9, `speed at ${dt}`)
  }
})

test('extrapolate: a full 360° turn returns to the start', () => {
  const last: KinPoint = { t: 0, e: 500, n: -300, ve: 0, vn: 200 }
  const p = extrapolate(last, 3, 120)
  near(p.e, 500, 1e-6)
  near(p.n, -300, 1e-6)
  near(p.ve, 0, 1e-9)
  near(p.vn, 200, 1e-9)
})

test('extrapolate: positive turn rate turns right (clockwise), negative turns left', () => {
  const north: KinPoint = { t: 0, e: 0, n: 0, ve: 0, vn: 200 }
  const right = extrapolate(north, 3, 5)
  const left = extrapolate(north, -3, 5)
  assert.ok(right.e > 0 && right.ve > 0, `right: e=${right.e} ve=${right.ve}`)
  assert.ok(left.e < 0 && left.ve < 0, `left: e=${left.e} ve=${left.ve}`)
  near(right.n, left.n, 1e-9)
  near(right.e, -left.e, 1e-9)
})

test('RejoinBlend: offset is 0 before start, the full error at start, and exactly 0 after durationS', () => {
  const b = new RejoinBlend()
  assert.deepEqual(b.offset(0), { e: 0, n: 0 })
  b.start(40, -30, 100)
  assert.deepEqual(b.offset(99.9), { e: 0, n: 0 })
  assert.deepEqual(b.offset(100), { e: 40, n: -30 })
  assert.deepEqual(b.offset(101.5), { e: 0, n: 0 })
  assert.deepEqual(b.offset(250), { e: 0, n: 0 })
})

test('RejoinBlend: cosine decay — half at mid-time, monotone, flat at both ends', () => {
  const b = new RejoinBlend(2)
  b.start(100, 0, 10)
  near(b.offset(11).e, 50, 1e-9)
  let prev = Infinity
  for (let i = 0; i <= 200; i++) {
    const e = b.offset(10 + i * 0.01).e
    assert.ok(e <= prev, `not monotone at step ${i}`)
    prev = e
  }
  // Flat ends: the first and last 1/60 s frames move the offset by far less than a mid-blend frame does.
  const firstStep = b.offset(10).e - b.offset(10 + 1 / 60).e
  const midStep = b.offset(11).e - b.offset(11 + 1 / 60).e
  const lastStep = b.offset(12 - 1 / 60).e - b.offset(12).e
  assert.ok(firstStep < midStep / 50, `first ${firstStep} mid ${midStep}`)
  assert.ok(lastStep < midStep / 50, `last ${lastStep} mid ${midStep}`)
})

test('RejoinBlend: a new start replaces the previous blend', () => {
  const b = new RejoinBlend()
  b.start(10, 10, 0)
  b.start(-4, 2, 1)
  assert.deepEqual(b.offset(1), { e: -4, n: 2 })
  assert.deepEqual(b.offset(0.5), { e: 0, n: 0 })
  assert.deepEqual(b.offset(2.5), { e: 0, n: 0 })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/track/hermite.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/track/hermite.ts'`, `ℹ fail 1`

- [ ] **Step 3: Write the implementation**

```ts
// client/track/hermite.ts
// Horizontal motion between and after samples, in a local ENU frame (t s, e/n m, ve/vn m/s).
import type { KinPoint } from './types.ts'

export interface HState {
  e: number
  n: number
  ve: number
  vn: number
}

/**
 * Cubic Hermite interpolation on e and n. Tangents are the sampled velocities scaled by the segment
 * length (b.t − a.t), so the curve passes through both positions with both velocities, and a
 * constant-velocity line is reproduced exactly. t is clamped to [a.t, b.t].
 */
export function hermite(a: KinPoint, b: KinPoint, t: number): HState {
  const h = b.t - a.t
  if (!(h > 0)) return { e: b.e, n: b.n, ve: b.ve, vn: b.vn } // degenerate segment: the newest point wins
  const s = (Math.min(b.t, Math.max(a.t, t)) - a.t) / h
  const s2 = s * s
  const s3 = s2 * s
  const h00 = 2 * s3 - 3 * s2 + 1
  const h01 = -2 * s3 + 3 * s2
  const h10 = s3 - 2 * s2 + s
  const h11 = s3 - s2
  // d/ds of the basis; dh01 = −dh00. Written so s = 0 and s = 1 return a's and b's values bit-exactly.
  const d00 = 6 * s2 - 6 * s
  const d10 = 3 * s2 - 4 * s + 1
  const d11 = 3 * s2 - 2 * s
  return {
    e: h00 * a.e + h01 * b.e + h * (h10 * a.ve + h11 * b.ve),
    n: h00 * a.n + h01 * b.n + h * (h10 * a.vn + h11 * b.vn),
    ve: (d00 * (a.e - b.e)) / h + d10 * a.ve + d11 * b.ve,
    vn: (d00 * (a.n - b.n)) / h + d10 * a.vn + d11 * b.vn,
  }
}

/**
 * Dead reckoning after the newest sample: constant speed and constant turn rate, on the exact circular arc.
 * turnRateDegS > 0 turns right (clockwise seen from above, track angle increasing); 0 is a straight line.
 */
export function extrapolate(last: KinPoint, turnRateDegS: number, dtS: number): HState {
  const x = (turnRateDegS * Math.PI * dtS) / 360 // half of the heading change, radians
  const k = x === 0 ? dtS : (dtS * Math.sin(x)) / x // chord length / speed (sinc form: no cancellation for tiny turns)
  const c = Math.cos(x)
  const s = Math.sin(x)
  // The chord points along the velocity turned clockwise by x; the final velocity is turned by 2x.
  const c2 = c * c - s * s
  const s2 = 2 * s * c
  return {
    e: last.e + k * (last.ve * c + last.vn * s),
    n: last.n + k * (last.vn * c - last.ve * s),
    ve: last.ve * c2 + last.vn * s2,
    vn: last.vn * c2 - last.ve * s2,
  }
}

/**
 * Hides the jump when a fresh sample corrects an extrapolated or stale path. start() takes the error
 * (previously rendered position − new estimate) at tS; add offset(t) to the new estimate. The offset
 * decays with a raised cosine, (1 + cos πu)/2 for u = (t − tS)/durationS: it starts and ends with zero
 * slope, so rendered velocity never jumps, and it is exactly 0 from tS + durationS on. Before any
 * start(), and for t < tS, the offset is 0.
 */
export class RejoinBlend {
  #durationS: number
  #t0 = NaN
  #e = 0
  #n = 0

  constructor(durationS = 1.5) {
    this.#durationS = durationS
  }

  start(errE: number, errN: number, tS: number): void {
    this.#e = errE
    this.#n = errN
    this.#t0 = tS
  }

  offset(tS: number): { e: number; n: number } {
    if (!(tS >= this.#t0) || tS >= this.#t0 + this.#durationS) return { e: 0, n: 0 }
    const w = (1 + Math.cos((Math.PI * (tS - this.#t0)) / this.#durationS)) / 2
    return { e: this.#e * w, n: this.#n * w }
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/track/hermite.test.ts`
Expected: PASS — `ℹ tests 12`, `ℹ pass 12`, `ℹ fail 0`, with the diagnostics `ℹ 3 s: hermite max 9.46e-4 m, vel 9.71e-4 m/s, chord max 7.36 m` and `ℹ 5 s: hermite max 7.30e-3 m, vel 4.49e-3 m/s, chord max 20.45 m`.

- [ ] **Step 5: Commit**

```bash
git add client/track/hermite.ts client/track/hermite.test.ts
git commit -m "feat(track): hermite interpolation, constant-turn extrapolation and re-join blend" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: MLAT outlier gate, smoothing and velocities

**Files:**
- Create: `client/track/mlat.ts`, `client/track/mlat.test.ts`
- Test: `client/track/mlat.test.ts`

**Interfaces:**
- Consumes: `KinPoint`, `PosT` from `client/track/types.ts` (WP-00)
- Produces: `gateOutliers(pts: PosT[], maxSpeedMs: number): PosT[]` (drops points implying speed > maxSpeedMs from the last kept point, or not later than it) · `smoothPositions(pts: PosT[], halfWindow: number): PosT[]` (centered moving average, window shrinks symmetrically at the ends, t averaged too) · `velocitiesFromPositions(pts: PosT[]): KinPoint[]` (central differences, one-sided at the ends, 0 for a lone point)

- [ ] **Step 1: Write the failing test**

```ts
// client/track/mlat.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gateOutliers, smoothPositions, velocitiesFromPositions } from './mlat.ts'
import type { PosT } from './types.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)

/** Deterministic PRNG (mulberry32) + Box–Muller, so the noisy tracks are identical on every run. */
function gauss(seed: number): () => number {
  let a = seed >>> 0
  const uni = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return () => Math.sqrt(-2 * Math.log(1 - uni())) * Math.cos(2 * Math.PI * uni())
}

// Straight track: 230 m/s on track 060°, starting at (−5000, 2000) at t = 1000 s.
const VE = 230 * Math.sin(Math.PI / 3)
const VN = 230 * Math.cos(Math.PI / 3)
const truthAt = (t: number): PosT => ({ t, e: -5000 + VE * (t - 1000), n: 2000 + VN * (t - 1000) })

/** n points with irregular MLAT-like spacing (0.6–2.4 s) and Gaussian position noise sigmaM. */
function noisyTrack(n: number, sigmaM: number, seed: number): { truth: PosT[]; meas: PosT[] } {
  const g = gauss(seed)
  const truth: PosT[] = []
  const meas: PosT[] = []
  let t = 1000
  for (let i = 0; i < n; i++) {
    const x = truthAt(t)
    truth.push(x)
    meas.push({ t, e: x.e + sigmaM * g(), n: x.n + sigmaM * g() })
    t += 1.5 + 0.9 * Math.sin(i * 1.7)
  }
  return { truth, meas }
}

const rmsPos = (pts: PosT[]): number => Math.sqrt(pts.reduce((s, p) => s + (p.e - truthAt(p.t).e) ** 2 + (p.n - truthAt(p.t).n) ** 2, 0) / pts.length)

test('gateOutliers: an injected 5 km outlier is removed and nothing else is', () => {
  const { meas } = noisyTrack(40, 30, 1)
  const bad = { ...meas[17], e: meas[17].e + 3000, n: meas[17].n - 4000 }
  const withOutlier = [...meas.slice(0, 17), bad, ...meas.slice(18)]
  const kept = gateOutliers(withOutlier, 600)
  assert.equal(kept.length, 39)
  assert.ok(!kept.includes(bad))
  assert.deepEqual(kept, withOutlier.filter((p) => p !== bad))
})

test('gateOutliers: a clean track passes untouched; speed exactly at the limit is kept', () => {
  const { meas } = noisyTrack(40, 30, 2)
  assert.deepEqual(gateOutliers(meas, 600), meas)
  const line: PosT[] = [{ t: 0, e: 0, n: 0 }, { t: 2, e: 600, n: 800 }, { t: 3, e: 600, n: 1300 }]
  assert.deepEqual(gateOutliers(line, 500), line)
  // Just under the limit, line[1] is dropped and line[2] is judged from line[0], the last kept point (1432 m in 3 s).
  assert.deepEqual(gateOutliers(line, 499.99), [line[0], line[2]])
})

test('gateOutliers: points that do not move forward in time are dropped; empty in, empty out', () => {
  const pts: PosT[] = [{ t: 5, e: 0, n: 0 }, { t: 5, e: 1, n: 1 }, { t: 4, e: 2, n: 2 }, { t: 6, e: 100, n: 0 }]
  assert.deepEqual(gateOutliers(pts, 300), [pts[0], pts[3]])
  assert.deepEqual(gateOutliers([], 300), [])
})

test('smoothPositions: reduces RMS position error of a noisy straight track', (t) => {
  const { meas } = noisyTrack(80, 60, 3)
  const smooth = smoothPositions(meas, 3)
  const raw = rmsPos(meas)
  const sm = rmsPos(smooth)
  t.diagnostic(`RMS raw ${raw.toFixed(1)} m → smoothed ${sm.toFixed(1)} m (halfWindow 3)`)
  assert.equal(smooth.length, meas.length)
  assert.ok(sm < 0.6 * raw, `raw ${raw} smoothed ${sm}`)
})

test('smoothPositions: noiseless constant-velocity motion is unbiased even with irregular timing', () => {
  const { truth } = noisyTrack(30, 0, 4)
  const smooth = smoothPositions(truth, 4)
  for (const p of smooth) {
    const x = truthAt(p.t)
    near(p.e, x.e, 1e-6, `e at ${p.t}`)
    near(p.n, x.n, 1e-6, `n at ${p.t}`)
  }
})

test('smoothPositions: centered window shrinks at the ends; halfWindow 0 is the identity', () => {
  const pts: PosT[] = [0, 1, 2, 3, 4].map((i) => ({ t: i, e: i * i, n: 3 - i }))
  const s = smoothPositions(pts, 2)
  assert.deepEqual(s[0], pts[0])
  assert.deepEqual(s[4], pts[4])
  assert.deepEqual(s[1], { t: 1, e: (0 + 1 + 4) / 3, n: 2 })
  assert.deepEqual(s[2], { t: 2, e: (0 + 1 + 4 + 9 + 16) / 5, n: 1 })
  assert.deepEqual(smoothPositions(pts, 0), pts)
  assert.deepEqual(smoothPositions([], 3), [])
})

test('velocitiesFromPositions: central differences inside, one-sided at the ends, exact on a line', () => {
  const { truth } = noisyTrack(12, 0, 5)
  const k = velocitiesFromPositions(truth)
  assert.equal(k.length, truth.length)
  for (let i = 0; i < k.length; i++) {
    assert.equal(k[i].t, truth[i].t)
    assert.equal(k[i].e, truth[i].e)
    assert.equal(k[i].n, truth[i].n)
    near(k[i].ve, VE, 1e-6, `ve[${i}]`)
    near(k[i].vn, VN, 1e-6, `vn[${i}]`)
  }
  const pts: PosT[] = [{ t: 0, e: 0, n: 0 }, { t: 1, e: 10, n: 0 }, { t: 3, e: 50, n: 4 }]
  assert.deepEqual(velocitiesFromPositions(pts).map((p) => [p.ve, p.vn]), [[10, 0], [50 / 3, 4 / 3], [20, 2]])
})

test('velocitiesFromPositions: one point has zero velocity; empty in, empty out', () => {
  assert.deepEqual(velocitiesFromPositions([{ t: 7, e: 1, n: 2 }]), [{ t: 7, e: 1, n: 2, ve: 0, vn: 0 }])
  assert.deepEqual(velocitiesFromPositions([]), [])
})

test('pipeline: gate → smooth → velocities beats raw differences on a noisy track with an outlier', (t) => {
  const { meas } = noisyTrack(80, 60, 6)
  meas[40] = { ...meas[40], e: meas[40].e + 5000 }
  const raw = velocitiesFromPositions(meas)
  const clean = velocitiesFromPositions(smoothPositions(gateOutliers(meas, 600), 3))
  const velRms = (k: { ve: number; vn: number }[]): number => Math.sqrt(k.reduce((s, p) => s + (p.ve - VE) ** 2 + (p.vn - VN) ** 2, 0) / k.length)
  t.diagnostic(`velocity RMS raw ${velRms(raw).toFixed(1)} m/s → cleaned ${velRms(clean).toFixed(1)} m/s`)
  assert.equal(clean.length, 79)
  assert.ok(velRms(clean) < 0.3 * velRms(raw), `raw ${velRms(raw)} clean ${velRms(clean)}`)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/track/mlat.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/track/mlat.ts'`, `ℹ fail 1`

- [ ] **Step 3: Write the implementation**

```ts
// client/track/mlat.ts
// Clean-up for MLAT tracks (noisy, irregular positions with no reliable velocity): gate → smooth → differentiate.
import type { KinPoint, PosT } from './types.ts'

/**
 * Drops every point that does not move forward in time from, or implies a speed above maxSpeedMs from,
 * the last kept point. The first point is always kept.
 * ponytail: speed-only gate trusting the first point. Ceilings: if the first point is itself an outlier
 * the rest of the window is dropped, and position noise inflates the implied speed at short spacing, so
 * callers need a generous maxSpeedMs (≈ 1000 m/s for MLAT). Upgrade: re-seed after 3 consecutive
 * rejections and gate on distance > maxSpeedMs·dt + 3σ.
 */
export function gateOutliers(pts: PosT[], maxSpeedMs: number): PosT[] {
  const out: PosT[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (last) {
      const dt = p.t - last.t
      if (!(dt > 0) || Math.hypot(p.e - last.e, p.n - last.n) > maxSpeedMs * dt) continue
    }
    out.push(p)
  }
  return out
}

/**
 * Centered moving average over indices i−k … i+k, with k = min(halfWindow, i, len−1−i) so the window
 * shrinks symmetrically at the ends (the first and last points pass through unsmoothed rather than
 * lagging). t is averaged too: it equals t_i for evenly spaced input and keeps constant-velocity motion
 * unbiased when MLAT timing is irregular.
 */
export function smoothPositions(pts: PosT[], halfWindow: number): PosT[] {
  return pts.map((_, i) => {
    const k = Math.min(halfWindow, i, pts.length - 1 - i)
    let t = 0
    let e = 0
    let n = 0
    for (let j = i - k; j <= i + k; j++) {
      t += pts[j].t
      e += pts[j].e
      n += pts[j].n
    }
    const m = 2 * k + 1
    return { t: t / m, e: e / m, n: n / m }
  })
}

/** Velocity at each point: central difference inside, one-sided at the ends, 0 for a lone point. */
export function velocitiesFromPositions(pts: PosT[]): KinPoint[] {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(pts.length - 1, i + 1)]
    const dt = b.t - a.t
    return { t: p.t, e: p.e, n: p.n, ve: dt > 0 ? (b.e - a.e) / dt : 0, vn: dt > 0 ? (b.n - a.n) / dt : 0 }
  })
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/track/mlat.test.ts`
Expected: PASS — `ℹ tests 9`, `ℹ pass 9`, `ℹ fail 0`, with the diagnostics `ℹ RMS raw 89.2 m → smoothed 43.2 m (halfWindow 3)` and `ℹ velocity RMS raw 266.7 m/s → cleaned 10.5 m/s`.

- [ ] **Step 5: Commit**

```bash
git add client/track/mlat.ts client/track/mlat.test.ts
git commit -m "feat(track): MLAT outlier gate, centered smoothing and finite-difference velocities" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: WP gate

- [ ] **Step 1: Run every test this package owns**

Run: `node --test client/track/hermite.test.ts client/track/mlat.test.ts`
Expected: `ℹ tests 21`, `ℹ pass 21`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/track/(hermite|mlat)'`
Expected: no output (grep exits 1). On a branch where every merged package is complete, `npm run check` must also pass.

- [ ] **Step 3: Confirm everything is committed and record the gate**

```bash
git status --short -- client/track
git commit --allow-empty -m "chore(track): WP-C2 gate passed (21 tests, tsc clean)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `git status` prints nothing before the commit. The branch `wp/C2` is ready to merge.

# WP-C5 — Attitude Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synthesise a believable heading, pitch and roll for the chased model from what ADS-B actually carries: ground speed, vertical rate, track or heading, and sometimes roll. Smooth it so the model never snaps between frames.

**Architecture:** One pure, node-testable file. `targetAttitude` computes the instantaneous target. Pitch is the flight-path angle plus a per-phase angle of attack. Roll is the broadcast roll when present, else the coordinated-turn bank `atan(V·ω/g)`. On the ground pitch and roll are both 0, and for MLAT roll is 0. `turnRateDegS` supplies a wrap-safe turn rate. `AttitudeSmoother` is a first-order lag per axis. It is exact for any frame time (`k = 1 − e^(−dt/τ)`), and heading takes the short way through north. I2's `Track` calls all three once per rendered frame.

**Tech Stack:** Node ≥ 24.2 (native TypeScript), `node:test`. No dependencies beyond WP-00's.

**Wave:** 1 (parallel; depends only on WP-00). **Estimated:** 1 h. **Validated:** on 2026-09-22 (Node v25.2.1), every file below was run in a clean tree that held only WP-00's contract files plus `node_modules`. Task 1 versions pass 13/13 and the final versions pass 18/18. `tsc --noEmit` is clean at both stages. Each Step 2 quotes its real RED output. The final files are byte-identical to the ones tested in the shared Wave 1 sandbox, where `tsc` also reports no errors in `client/track/attitude*.ts`.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints; they apply to every task here. The ones that bite this package:
- Sign conventions come from `Att` in `client/track/types.ts` (WP-00): heading is true degrees, pitch is positive nose-up, and roll is positive right-wing-down. Turn rate is positive for a right turn, the same convention as C2's `extrapolate`. So a right turn gives positive roll.
- Inputs are SI (`gsMs`, `vsMs` in m/s). Track converts from `Sample`'s kt and fpm.
- Erasable TypeScript only, `.ts` import extensions, and no network in tests.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `client/track/attitude.ts` | `targetAttitude`, `AttitudeSmoother`, `turnRateDegS` |
| `client/track/attitude.test.ts` | unit tests |

---

### Task 1: Target attitude and turn rate

**Files:**
- Create: `client/track/attitude.ts`, `client/track/attitude.test.ts`
- Test: `client/track/attitude.test.ts`

**Interfaces:**
- Consumes: `Att`, `Phase` (`client/track/types.ts`, WP-00)
- Produces: `targetAttitude(i: { gsMs; vsMs; headingDeg; broadcastRollDeg: number | null; turnRateDegS; onGround; phase: Phase | null; mlat: boolean }): Att` (the parameter type is also exported as `AttitudeInput`) · `turnRateDegS(prevTrackDeg: number, trackDeg: number, dtS: number): number`
  - pitch = `atan2(vs, gs)` + AoA, where AoA is: ground 0, takeoff/climb 6, cruise/descent 2, approach/landing 4. With `phase` null, the phase comes from vs: climb above +1.5 m/s (≈ 300 fpm), descent below −1.5 m/s, else cruise. Pitch is clamped to [−15, 25].
  - roll = `broadcastRollDeg ?? atan(gs·ω/g)`, with g = 9.80665 and ω in rad/s, clamped to ±35. For MLAT roll is 0 even when a roll is broadcast (contract).
  - On the ground pitch and roll are both 0. Heading is normalised to [0, 360).
  - `turnRateDegS` = the shortest signed track change (in [−180, 180)) divided by `dtS`, and 0 when `dtS ≤ 0`.
  - Pinned values: level cruise → 2.00°. 1500 fpm climb at 160 kt → `atan(7.62/82.3) + 6` ≈ 11.29°. 3°/s turn at 140 kt → `atan(72.0·0.0524/9.807)` ≈ 21.0° of roll.

- [ ] **Step 1: Write the failing test**

```ts
// client/track/attitude.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { targetAttitude, turnRateDegS } from './attitude.ts'
import type { Att, Phase } from './types.ts'

const KT = 1852 / 3600
const G = 9.80665
const DEG = 180 / Math.PI

type In = Parameters<typeof targetAttitude>[0]
const base: In = { gsMs: 140 * KT, vsMs: 0, headingDeg: 90, broadcastRollDeg: null, turnRateDegS: 0, onGround: false, phase: null, mlat: false }
const att = (p: Partial<In>): Att => targetAttitude({ ...base, ...p })

const near = (a: number, b: number, tol: number, msg?: string): void =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} got ${a}, expected ${b} ± ${tol}`)

// ---------- targetAttitude ----------

test('level cruise: pitch ≈ 2° (cruise AoA), wings level, heading passes through', () => {
  const a = att({ gsMs: 450 * KT })
  near(a.pitchDeg, 2, 1e-9)
  near(a.rollDeg, 0, 1e-9)
  assert.equal(a.headingDeg, 90)
})

test('1500 fpm climb at 160 kt: pitch ≈ atan(7.62/82.3) + 6', () => {
  const a = att({ gsMs: 160 * KT, vsMs: (1500 * 0.3048) / 60 })
  near(a.pitchDeg, Math.atan(7.62 / 82.3) * DEG + 6, 0.02) // ≈ 11.29°
})

test('phase sets the AoA: ground 0, takeoff/climb 6, cruise/descent 2, approach/landing 4', () => {
  const aoa: [Phase, number][] = [['ground', 0], ['takeoff', 6], ['climb', 6], ['cruise', 2], ['descent', 2], ['approach', 4], ['landing', 4]]
  for (const [phase, deg] of aoa) near(att({ phase }).pitchDeg, deg, 1e-9, phase)
  // a 3° approach: flight path −3° + AoA 4° → nose 1° up
  const gs = 140 * KT
  near(att({ phase: 'approach', gsMs: gs, vsMs: -gs * Math.tan(3 / DEG) }).pitchDeg, 1, 1e-9)
})

test('phase null → inferred from vs: climb above +1.5 m/s, descent below −1.5 m/s, else cruise', () => {
  const gs = base.gsMs
  near(att({ vsMs: 3 }).pitchDeg, Math.atan2(3, gs) * DEG + 6, 1e-9, 'climb')
  near(att({ vsMs: -3 }).pitchDeg, Math.atan2(-3, gs) * DEG + 2, 1e-9, 'descent')
  near(att({ vsMs: 1 }).pitchDeg, Math.atan2(1, gs) * DEG + 2, 1e-9, 'level band')
  near(att({ vsMs: -1 }).pitchDeg, Math.atan2(-1, gs) * DEG + 2, 1e-9, 'level band')
})

test('coordinated turn 3°/s at 140 kt: roll = atan(V·ω/g), right turn = right wing down', () => {
  const V = 140 * KT
  const expected = Math.atan((V * (3 / DEG)) / G) * DEG // ≈ 21.0°
  near(att({ turnRateDegS: 3 }).rollDeg, expected, 1e-9)
  near(att({ turnRateDegS: -3 }).rollDeg, -expected, 1e-9)
  assert.ok(expected > 20 && expected < 22)
})

test('broadcast roll overrides the coordinated-turn estimate', () => {
  near(att({ turnRateDegS: 3, broadcastRollDeg: -12 }).rollDeg, -12, 1e-9)
  near(att({ turnRateDegS: 3, broadcastRollDeg: 0 }).rollDeg, 0, 1e-9)
})

test('on ground: roll 0 and pitch 0 whatever the inputs say', () => {
  const a = att({ onGround: true, vsMs: 2, broadcastRollDeg: 5, turnRateDegS: 3, phase: 'takeoff', headingDeg: 280 })
  assert.equal(a.pitchDeg, 0)
  assert.equal(a.rollDeg, 0)
  assert.equal(a.headingDeg, 280)
})

test('MLAT: roll 0 (turn rate from MLAT positions is noise); pitch still computed', () => {
  const a = att({ mlat: true, turnRateDegS: 3, broadcastRollDeg: 10, vsMs: 3 })
  assert.equal(a.rollDeg, 0)
  near(a.pitchDeg, Math.atan2(3, base.gsMs) * DEG + 6, 1e-9)
})

test('clamps: pitch to [−15, 25], roll to ±35', () => {
  near(att({ gsMs: 10, vsMs: 100 }).pitchDeg, 25, 1e-9)
  near(att({ gsMs: 10, vsMs: -100 }).pitchDeg, -15, 1e-9)
  near(att({ broadcastRollDeg: 50 }).rollDeg, 35, 1e-9)
  near(att({ broadcastRollDeg: -50 }).rollDeg, -35, 1e-9)
  near(att({ gsMs: 250 * KT, turnRateDegS: 20 }).rollDeg, 35, 1e-9)
  near(att({ gsMs: 250 * KT, turnRateDegS: -20 }).rollDeg, -35, 1e-9)
})

test('heading is normalised to [0, 360)', () => {
  near(att({ headingDeg: -10 }).headingDeg, 350, 1e-9)
  near(att({ headingDeg: 370 }).headingDeg, 10, 1e-9)
  near(att({ headingDeg: 360 }).headingDeg, 0, 1e-9)
})

// ---------- turnRateDegS ----------

test('turnRateDegS: plain difference over dt', () => {
  near(turnRateDegS(90, 120, 10), 3, 1e-9)
  near(turnRateDegS(120, 90, 10), -3, 1e-9)
})

test('turnRateDegS: wrap-safe across north both ways', () => {
  near(turnRateDegS(350, 10, 10), 2, 1e-9)
  near(turnRateDegS(10, 350, 10), -2, 1e-9)
  near(turnRateDegS(359, 1, 1), 2, 1e-9)
  near(turnRateDegS(1, 359, 1), -2, 1e-9)
})

test('turnRateDegS: dt ≤ 0 → 0', () => {
  assert.equal(turnRateDegS(10, 20, 0), 0)
  assert.equal(turnRateDegS(10, 20, -1), 0)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/track/attitude.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/track/attitude.ts' imported from …/client/track/attitude.test.ts`

- [ ] **Step 3: Write the implementation**

```ts
// client/track/attitude.ts
import type { Att, Phase } from './types.ts'

const G = 9.80665
const DEG = 180 / Math.PI
const AOA_DEG: Record<Phase, number> = { ground: 0, takeoff: 6, climb: 6, cruise: 2, descent: 2, approach: 4, landing: 4 }
const LEVEL_MS = 1.5 // |vs| under ≈ 300 fpm counts as level when the phase is unknown

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const wrap360 = (d: number): number => ((d % 360) + 360) % 360
const wrap180 = (d: number): number => wrap360(d + 180) - 180

export interface AttitudeInput {
  gsMs: number
  vsMs: number
  headingDeg: number
  broadcastRollDeg: number | null
  turnRateDegS: number // + = right turn
  onGround: boolean
  phase: Phase | null
  mlat: boolean
}

/**
 * Synthesised attitude (ADS-B carries no pitch and rarely roll).
 * pitch = flight-path angle atan2(vs, gs) + AoA(phase), clamped to [−15, 25]. AoA: ground 0, takeoff/climb 6,
 * cruise/descent 2, approach/landing 4. phase null → climb above +1.5 m/s, descent below −1.5 m/s, else cruise.
 * roll = broadcast ?? coordinated turn atan(V·ω/g), clamped ±35; 0 on the ground or for MLAT.
 * On the ground pitch is 0 too.
 */
export function targetAttitude(i: AttitudeInput): Att {
  const headingDeg = wrap360(i.headingDeg)
  if (i.onGround) return { headingDeg, pitchDeg: 0, rollDeg: 0 }
  // ponytail: phase from vs alone cannot tell approach from descent (pitch −1° instead of +1° on a glide);
  // upgrade path is the M4 phase detector passing `phase`.
  const phase = i.phase ?? (i.vsMs > LEVEL_MS ? 'climb' : i.vsMs < -LEVEL_MS ? 'descent' : 'cruise')
  const pitchDeg = clamp(Math.atan2(i.vsMs, i.gsMs) * DEG + AOA_DEG[phase], -15, 25)
  const roll = i.mlat ? 0 : i.broadcastRollDeg ?? Math.atan((i.gsMs * (i.turnRateDegS / DEG)) / G) * DEG
  return { headingDeg, pitchDeg, rollDeg: clamp(roll, -35, 35) }
}

/** Signed track change rate in °/s, + = right turn, wrap-safe across north. 0 when dtS ≤ 0. */
export function turnRateDegS(prevTrackDeg: number, trackDeg: number, dtS: number): number {
  return dtS > 0 ? wrap180(trackDeg - prevTrackDeg) / dtS : 0
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/track/attitude.test.ts`
Expected: PASS — `ℹ tests 13`, `ℹ pass 13`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add client/track/attitude.ts client/track/attitude.test.ts
git commit -m "feat(track): synthesised target attitude (FPA + AoA pitch, coordinated-turn roll) and wrap-safe turn rate"
```

---

### Task 2: Attitude smoother

**Files:**
- Modify: `client/track/attitude.ts` (adds `AttitudeSmoother`), `client/track/attitude.test.ts` (adds smoother tests)
- Test: `client/track/attitude.test.ts`

**Interfaces:**
- Consumes: `Att` (`client/track/types.ts`, WP-00)
- Produces: `class AttitudeSmoother { constructor(tauS?: number); step(target: Att, dtS: number): Att }`
  - Each axis follows `x += (target − x)·(1 − e^(−dt/τ))`, which is exact for any step size: 120 steps of τ/120 give the same result as one step of τ. Heading moves along `wrap180(target − x)` and the output stays in [0, 360).
  - The first call returns the target. A call with `dt ≤ 0` returns the current attitude unchanged. Every call returns a new object.
  - The default τ is 1 s. It damps the ~1 Hz jitter of per-sample turn rates (≈ 0.16 residual at 1 Hz) without a visible lag in roll-in. I2 may pass a longer τ for MLAT or a shorter one for heading.

- [ ] **Step 1: Write the failing test** (replace the whole file)

```ts
// client/track/attitude.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AttitudeSmoother, targetAttitude, turnRateDegS } from './attitude.ts'
import type { Att, Phase } from './types.ts'

const KT = 1852 / 3600
const G = 9.80665
const DEG = 180 / Math.PI

type In = Parameters<typeof targetAttitude>[0]
const base: In = { gsMs: 140 * KT, vsMs: 0, headingDeg: 90, broadcastRollDeg: null, turnRateDegS: 0, onGround: false, phase: null, mlat: false }
const att = (p: Partial<In>): Att => targetAttitude({ ...base, ...p })

const near = (a: number, b: number, tol: number, msg?: string): void =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} got ${a}, expected ${b} ± ${tol}`)

// ---------- targetAttitude ----------

test('level cruise: pitch ≈ 2° (cruise AoA), wings level, heading passes through', () => {
  const a = att({ gsMs: 450 * KT })
  near(a.pitchDeg, 2, 1e-9)
  near(a.rollDeg, 0, 1e-9)
  assert.equal(a.headingDeg, 90)
})

test('1500 fpm climb at 160 kt: pitch ≈ atan(7.62/82.3) + 6', () => {
  const a = att({ gsMs: 160 * KT, vsMs: (1500 * 0.3048) / 60 })
  near(a.pitchDeg, Math.atan(7.62 / 82.3) * DEG + 6, 0.02) // ≈ 11.29°
})

test('phase sets the AoA: ground 0, takeoff/climb 6, cruise/descent 2, approach/landing 4', () => {
  const aoa: [Phase, number][] = [['ground', 0], ['takeoff', 6], ['climb', 6], ['cruise', 2], ['descent', 2], ['approach', 4], ['landing', 4]]
  for (const [phase, deg] of aoa) near(att({ phase }).pitchDeg, deg, 1e-9, phase)
  // a 3° approach: flight path −3° + AoA 4° → nose 1° up
  const gs = 140 * KT
  near(att({ phase: 'approach', gsMs: gs, vsMs: -gs * Math.tan(3 / DEG) }).pitchDeg, 1, 1e-9)
})

test('phase null → inferred from vs: climb above +1.5 m/s, descent below −1.5 m/s, else cruise', () => {
  const gs = base.gsMs
  near(att({ vsMs: 3 }).pitchDeg, Math.atan2(3, gs) * DEG + 6, 1e-9, 'climb')
  near(att({ vsMs: -3 }).pitchDeg, Math.atan2(-3, gs) * DEG + 2, 1e-9, 'descent')
  near(att({ vsMs: 1 }).pitchDeg, Math.atan2(1, gs) * DEG + 2, 1e-9, 'level band')
  near(att({ vsMs: -1 }).pitchDeg, Math.atan2(-1, gs) * DEG + 2, 1e-9, 'level band')
})

test('coordinated turn 3°/s at 140 kt: roll = atan(V·ω/g), right turn = right wing down', () => {
  const V = 140 * KT
  const expected = Math.atan((V * (3 / DEG)) / G) * DEG // ≈ 21.0°
  near(att({ turnRateDegS: 3 }).rollDeg, expected, 1e-9)
  near(att({ turnRateDegS: -3 }).rollDeg, -expected, 1e-9)
  assert.ok(expected > 20 && expected < 22)
})

test('broadcast roll overrides the coordinated-turn estimate', () => {
  near(att({ turnRateDegS: 3, broadcastRollDeg: -12 }).rollDeg, -12, 1e-9)
  near(att({ turnRateDegS: 3, broadcastRollDeg: 0 }).rollDeg, 0, 1e-9)
})

test('on ground: roll 0 and pitch 0 whatever the inputs say', () => {
  const a = att({ onGround: true, vsMs: 2, broadcastRollDeg: 5, turnRateDegS: 3, phase: 'takeoff', headingDeg: 280 })
  assert.equal(a.pitchDeg, 0)
  assert.equal(a.rollDeg, 0)
  assert.equal(a.headingDeg, 280)
})

test('MLAT: roll 0 (turn rate from MLAT positions is noise); pitch still computed', () => {
  const a = att({ mlat: true, turnRateDegS: 3, broadcastRollDeg: 10, vsMs: 3 })
  assert.equal(a.rollDeg, 0)
  near(a.pitchDeg, Math.atan2(3, base.gsMs) * DEG + 6, 1e-9)
})

test('clamps: pitch to [−15, 25], roll to ±35', () => {
  near(att({ gsMs: 10, vsMs: 100 }).pitchDeg, 25, 1e-9)
  near(att({ gsMs: 10, vsMs: -100 }).pitchDeg, -15, 1e-9)
  near(att({ broadcastRollDeg: 50 }).rollDeg, 35, 1e-9)
  near(att({ broadcastRollDeg: -50 }).rollDeg, -35, 1e-9)
  near(att({ gsMs: 250 * KT, turnRateDegS: 20 }).rollDeg, 35, 1e-9)
  near(att({ gsMs: 250 * KT, turnRateDegS: -20 }).rollDeg, -35, 1e-9)
})

test('heading is normalised to [0, 360)', () => {
  near(att({ headingDeg: -10 }).headingDeg, 350, 1e-9)
  near(att({ headingDeg: 370 }).headingDeg, 10, 1e-9)
  near(att({ headingDeg: 360 }).headingDeg, 0, 1e-9)
})

// ---------- turnRateDegS ----------

test('turnRateDegS: plain difference over dt', () => {
  near(turnRateDegS(90, 120, 10), 3, 1e-9)
  near(turnRateDegS(120, 90, 10), -3, 1e-9)
})

test('turnRateDegS: wrap-safe across north both ways', () => {
  near(turnRateDegS(350, 10, 10), 2, 1e-9)
  near(turnRateDegS(10, 350, 10), -2, 1e-9)
  near(turnRateDegS(359, 1, 1), 2, 1e-9)
  near(turnRateDegS(1, 359, 1), -2, 1e-9)
})

test('turnRateDegS: dt ≤ 0 → 0', () => {
  assert.equal(turnRateDegS(10, 20, 0), 0)
  assert.equal(turnRateDegS(10, 20, -1), 0)
})

// ---------- AttitudeSmoother ----------

test('smoother: the first step returns the target', () => {
  const s = new AttitudeSmoother(2)
  assert.deepEqual(s.step({ headingDeg: 45, pitchDeg: 3, rollDeg: -5 }, 0.016), { headingDeg: 45, pitchDeg: 3, rollDeg: -5 })
})

test('smoother: converges with time constant tau, independent of step size', () => {
  const target: Att = { headingDeg: 0, pitchDeg: 10, rollDeg: 20 }
  const fine = new AttitudeSmoother(2)
  fine.step({ headingDeg: 0, pitchDeg: 0, rollDeg: 0 }, 0)
  let a: Att = { headingDeg: 0, pitchDeg: 0, rollDeg: 0 }
  for (let i = 0; i < 120; i++) a = fine.step(target, 2 / 120) // 60 Hz for tau seconds
  const k = 1 - Math.exp(-1)
  near(a.pitchDeg, 10 * k, 1e-9)
  near(a.rollDeg, 20 * k, 1e-9)
  const coarse = new AttitudeSmoother(2)
  coarse.step({ headingDeg: 0, pitchDeg: 0, rollDeg: 0 }, 0)
  near(coarse.step(target, 2).pitchDeg, 10 * k, 1e-9)
  for (let i = 0; i < 1200; i++) a = fine.step(target, 1 / 60) // 20 s more: residual e^−11
  near(a.pitchDeg, 10, 1e-3)
  near(a.rollDeg, 20, 1e-3)
})

test('smoother: default tau is 1 s', () => {
  const s = new AttitudeSmoother()
  s.step({ headingDeg: 0, pitchDeg: 0, rollDeg: 0 }, 0)
  near(s.step({ headingDeg: 0, pitchDeg: 10, rollDeg: 0 }, 1).pitchDeg, 10 * (1 - Math.exp(-1)), 1e-9)
})

test('smoother: heading 359 → 1 goes the short way through north', () => {
  const s = new AttitudeSmoother(1)
  s.step({ headingDeg: 359, pitchDeg: 0, rollDeg: 0 }, 0)
  for (let i = 0; i < 300; i++) {
    const h = s.step({ headingDeg: 1, pitchDeg: 0, rollDeg: 0 }, 1 / 60).headingDeg
    assert.ok(h >= 0 && h < 360, `normalised: ${h}`)
    assert.ok(h >= 359 || h <= 1, `stayed on the 2° arc through north: ${h}`)
  }
  const t = new AttitudeSmoother(1)
  t.step({ headingDeg: 359, pitchDeg: 0, rollDeg: 0 }, 0)
  near(t.step({ headingDeg: 1, pitchDeg: 0, rollDeg: 0 }, 1).headingDeg, (359 + 2 * (1 - Math.exp(-1))) % 360, 1e-9) // ≈ 0.26
})

test('smoother: dt ≤ 0 holds the current attitude; returned objects are copies', () => {
  const s = new AttitudeSmoother(1)
  const first = s.step({ headingDeg: 10, pitchDeg: 1, rollDeg: 2 }, 0)
  first.pitchDeg = 99
  assert.deepEqual(s.step({ headingDeg: 50, pitchDeg: 5, rollDeg: 9 }, 0), { headingDeg: 10, pitchDeg: 1, rollDeg: 2 })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/track/attitude.test.ts`
Expected: FAIL — `SyntaxError: The requested module './attitude.ts' does not provide an export named 'AttitudeSmoother'`

- [ ] **Step 3: Write the implementation** (replace the whole file)

```ts
// client/track/attitude.ts
import type { Att, Phase } from './types.ts'

const G = 9.80665
const DEG = 180 / Math.PI
const AOA_DEG: Record<Phase, number> = { ground: 0, takeoff: 6, climb: 6, cruise: 2, descent: 2, approach: 4, landing: 4 }
const LEVEL_MS = 1.5 // |vs| under ≈ 300 fpm counts as level when the phase is unknown

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const wrap360 = (d: number): number => ((d % 360) + 360) % 360
const wrap180 = (d: number): number => wrap360(d + 180) - 180

export interface AttitudeInput {
  gsMs: number
  vsMs: number
  headingDeg: number
  broadcastRollDeg: number | null
  turnRateDegS: number // + = right turn
  onGround: boolean
  phase: Phase | null
  mlat: boolean
}

/**
 * Synthesised attitude (ADS-B carries no pitch and rarely roll).
 * pitch = flight-path angle atan2(vs, gs) + AoA(phase), clamped to [−15, 25]. AoA: ground 0, takeoff/climb 6,
 * cruise/descent 2, approach/landing 4. phase null → climb above +1.5 m/s, descent below −1.5 m/s, else cruise.
 * roll = broadcast ?? coordinated turn atan(V·ω/g), clamped ±35; 0 on the ground or for MLAT.
 * On the ground pitch is 0 too.
 */
export function targetAttitude(i: AttitudeInput): Att {
  const headingDeg = wrap360(i.headingDeg)
  if (i.onGround) return { headingDeg, pitchDeg: 0, rollDeg: 0 }
  // ponytail: phase from vs alone cannot tell approach from descent (pitch −1° instead of +1° on a glide);
  // upgrade path is the M4 phase detector passing `phase`.
  const phase = i.phase ?? (i.vsMs > LEVEL_MS ? 'climb' : i.vsMs < -LEVEL_MS ? 'descent' : 'cruise')
  const pitchDeg = clamp(Math.atan2(i.vsMs, i.gsMs) * DEG + AOA_DEG[phase], -15, 25)
  const roll = i.mlat ? 0 : i.broadcastRollDeg ?? Math.atan((i.gsMs * (i.turnRateDegS / DEG)) / G) * DEG
  return { headingDeg, pitchDeg, rollDeg: clamp(roll, -35, 35) }
}

/** First-order lag on each axis, exact for any dt: x += (target − x)·(1 − e^(−dt/τ)). Heading takes the short way. */
export class AttitudeSmoother {
  private readonly tauS: number
  private cur: Att | null = null

  /** tauS default 1 s: damps the ~1 Hz jitter of per-sample turn rates without a visible lag in roll-in. */
  constructor(tauS = 1) {
    this.tauS = tauS
  }

  step(target: Att, dtS: number): Att {
    const c = this.cur
    if (c === null) {
      this.cur = { headingDeg: wrap360(target.headingDeg), pitchDeg: target.pitchDeg, rollDeg: target.rollDeg }
    } else if (dtS > 0) {
      const k = 1 - Math.exp(-dtS / this.tauS)
      this.cur = {
        headingDeg: wrap360(c.headingDeg + k * wrap180(target.headingDeg - c.headingDeg)),
        pitchDeg: c.pitchDeg + k * (target.pitchDeg - c.pitchDeg),
        rollDeg: c.rollDeg + k * (target.rollDeg - c.rollDeg),
      }
    }
    return { ...this.cur! }
  }
}

/** Signed track change rate in °/s, + = right turn, wrap-safe across north. 0 when dtS ≤ 0. */
export function turnRateDegS(prevTrackDeg: number, trackDeg: number, dtS: number): number {
  return dtS > 0 ? wrap180(trackDeg - prevTrackDeg) / dtS : 0
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/track/attitude.test.ts`
Expected: PASS — `ℹ tests 18`, `ℹ pass 18`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add client/track/attitude.ts client/track/attitude.test.ts
git commit -m "feat(track): wrap-safe first-order attitude smoother"
```

---

### Task 3: WP gate

- [ ] **Step 1: Package tests**

Run: `node --test client/track/attitude.test.ts`
Expected: `ℹ tests 18`, `ℹ pass 18`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/track/attitude'`
Expected: no output. In this package's own worktree, which holds only WP-00 and this package, plain `npx tsc --noEmit` is silent too.

- [ ] **Step 3: Full check**

Run: `npm run check`
Expected: `tsc` silent; `ℹ tests 59` (WP-00's 41 + these 18), `ℹ fail 0`.

## Notes for I2 (Track)

- Per frame: `targetAttitude({ gsMs: gsKt * 1852 / 3600, vsMs: <VerticalFilter.at(t).vsMs>, headingDeg: trueHeadingDeg ?? <track of the interpolated velocity>, broadcastRollDeg: rollDeg, turnRateDegS, onGround, phase: null, mlat: quality === 'mlat' })`, then pass the result to one `AttitudeSmoother` per aircraft with the frame's `dtS`.
- Take `turnRateDegS` from two interpolated velocity headings a fixed interval apart, for example `turnRateDegS(trackAt(t − 1), trackAt(t), 1)`. Raw 1 Hz sample tracks are noisy. The velocity components come in 1 kt steps, so at 140 kt consecutive tracks jitter by about 0.4°. A 1 s difference of them then puts roughly ±3° of noise on roll, and the smoother removes only part of it.
- `phase` stays `null` until M4's phase detector. Until then an approach infers `descent`, so a 3° glide shows 1° nose-down instead of 1° nose-up (the `ponytail:` note in `targetAttitude`).

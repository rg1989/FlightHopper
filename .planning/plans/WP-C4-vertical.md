# WP-C4 — Vertical: Altitude Ladder + Vertical Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn one aircraft's mixed altitude reports into a single continuous WGS84 ellipsoidal height, and turn 25 ft quantised samples into a height and vertical speed that render at 60 Hz without bobbing or stepping.

**Architecture:** One pure, node-testable file with two classes. I2's `Track` owns one of each per aircraft. `AltitudeLadder.height(sample)` picks the best rung for each sample. The rungs are `geom` (v2 `alt_geom`, or a v0/v1 `alt_geom` within 60 m of the baro chain), then `baro-qnh`, then `baro-bias` (pressure altitude plus a bias learned from trusted geom). When the chosen rung changes, the ladder measures the jump between the two rungs at one instant and turns it into an offset that bleeds to zero at 0.5 m/s, so the output never steps. `VerticalFilter` runs an α-β filter over those heights at irregular sample times, using the reported vertical rate as a velocity measurement. `at(t)` interpolates the filtered (h, v) states with a cubic Hermite, and extrapolates with the last rate after the newest state.

**Tech Stack:** Node ≥ 24.2 (native TypeScript), `node:test`. No dependencies beyond WP-00's.

**Wave:** 1 (parallel; depends only on WP-00). **Estimated:** 1.5 h. **Validated:** on 2026-09-22 (Node v25.2.1), every file below was run in a clean tree that held only WP-00's contract files plus `node_modules`. Task 1 versions pass 12/12 and the final versions pass 20/20. `tsc --noEmit` is clean at both stages. Each Step 2 quotes its real RED output. The final files are byte-identical to the ones tested in the shared Wave 1 sandbox, where `tsc` also reports no errors in `client/track/vertical*.ts`.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints; they apply to every task here. The ones that bite this package:
- Output heights are WGS84 ellipsoidal metres (HAE): `h = H + N`, with `N = Sample.nM` in **metres**. `Sample` altitudes are **feet**. Apply every feet-domain correction first (the QNH term is 27 ft/hPa), then multiply by 0.3048, then add N. The old plan added N to feet; Task 1 has a regression test for that bug.
- `alt_geom` is HAE only when `version === 2`. v0/v1/unknown must pass the ladder's 60 m plausibility check.
- Erasable TypeScript only, `.ts` import extensions, and no network in tests.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `client/track/vertical.ts` | `AltitudeLadder` (rung choice, learned bias, switch continuity) and `VerticalFilter` (α-β + Hermite) |
| `client/track/vertical.test.ts` | unit tests, the 3° / 140 kt quantised descent scenario, and a ladder→filter rung-switch scenario |

---

### Task 1: Altitude ladder

**Files:**
- Create: `client/track/vertical.ts`, `client/track/vertical.test.ts`
- Test: `client/track/vertical.test.ts`

**Interfaces:**
- Consumes: `Sample` (`shared/types.ts`, WP-00: `tMs`, `onGround`, `altBaroFt`, `altGeomFt`, `navQnhHpa`, `version`, `nM`), `AltSource` (`client/track/types.ts`, WP-00)
- Produces: `class AltitudeLadder { height(s: Sample): { hM: number; source: AltSource } | null }`. Use one instance per aircraft and call it in sample-time order. The rules, each pinned by a test:
  - `geom` = `altGeomFt·0.3048` when `version === 2`. When the version is 0, 1 or null, geom is accepted only if `|geom − chain| ≤ 60 m`. The chain is `baro-qnh` when valid, else `baro-bias`. Geom is also accepted when there is no baro at all.
  - `baro-qnh` = `(altBaroFt + (navQnhHpa − 1013.25)·27)·0.3048 + nM`. It is valid when `950 ≤ qnh ≤ 1050` (inclusive) and `altBaroFt < 18000`.
  - `baro-bias` = `altBaroFt·0.3048 + nM + bias`. The bias is a per-sample EMA (gain 0.1, about 10 s at 1 Hz) of `geom − (altBaroFt·0.3048 + nM)`, taken over samples whose geom was **accepted**. It starts at 0 and is seeded by the first accepted geom. A rejected v0/v1 geom never updates it.
  - Rung switch: the ladder measures the jump `new − old` at the current sample when the old rung is still valid there. Otherwise it measures it at the previous sample, because the old rung's current value is missing or untrusted. The jump becomes an offset (`offset −= jump`) that decays linearly toward 0 at 0.5 m/s of sample time.
  - `null` on the ground, which also resets the offset and the switch history (the bias is kept). Also `null` when neither `altBaroFt` nor `altGeomFt` is present.

- [ ] **Step 1: Write the failing test**

```ts
// client/track/vertical.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AltitudeLadder } from './vertical.ts'
import type { Sample } from '../../shared/types.ts'

const FT = 0.3048
const N = -32.3 // KSFO-area geoid undulation, metres

function sample(p: Partial<Sample>): Sample {
  return {
    hex: 'abc123', tMs: 0, rxMs: 0, lat: 37.6, lon: -122.4, onGround: false,
    altBaroFt: null, altGeomFt: null, gsKt: 140, trackDeg: 280, trueHeadingDeg: null, rollDeg: null,
    baroRateFpm: null, geomRateFpm: null, navQnhHpa: null, version: 2, nic: 8, quality: 'adsb2',
    nM: N, callsign: null, typeCode: null, reg: null, ...p,
  }
}

const near = (a: number, b: number, tol: number, msg?: string): void =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} got ${a}, expected ${b} ± ${tol}`)

// ---------- AltitudeLadder ----------

test('ladder: v2 alt_geom is HAE and used directly', () => {
  const r = new AltitudeLadder().height(sample({ version: 2, altGeomFt: 10000, altBaroFt: 9800, navQnhHpa: 1020 }))
  assert.deepEqual(r, { hM: 10000 * FT, source: 'geom' })
})

test('ladder: on ground → null', () => {
  assert.equal(new AltitudeLadder().height(sample({ onGround: true, altGeomFt: 100 })), null)
})

test('ladder: no baro and no geom → null', () => {
  assert.equal(new AltitudeLadder().height(sample({ version: 0 })), null)
})

test('ladder: baro-qnh at 1003.25 hPa is −270 FEET before the metre conversion', () => {
  const r = new AltitudeLadder().height(sample({ version: 0, altBaroFt: 5000, navQnhHpa: 1003.25 }))!
  assert.equal(r.source, 'baro-qnh')
  near(r.hM, (5000 - 270) * FT + N, 1e-9)
  // the old plan's unit bug added N (metres) to feet: that answer is ~64 m away and must not come back
  assert.ok(Math.abs(r.hM - ((5000 - 270 + N) * FT)) > 20)
})

test('ladder: baro-qnh needs 950 ≤ qnh ≤ 1050 and alt_baro < 18000 ft, else baro-bias', () => {
  const raw = (ft: number): number => ft * FT + N
  const cases: [number, number | null][] = [[20000, 1003.25], [5000, 940], [5000, 1060], [5000, null]]
  for (const [ft, qnh] of cases) {
    const r = new AltitudeLadder().height(sample({ version: 0, altBaroFt: ft, navQnhHpa: qnh }))!
    assert.equal(r.source, 'baro-bias', `${ft} ft, qnh ${qnh}`)
    near(r.hM, raw(ft), 1e-9, `${ft} ft, qnh ${qnh}`)
  }
  assert.equal(new AltitudeLadder().height(sample({ version: 0, altBaroFt: 5000, navQnhHpa: 950 }))!.source, 'baro-qnh')
  assert.equal(new AltitudeLadder().height(sample({ version: 0, altBaroFt: 5000, navQnhHpa: 1050 }))!.source, 'baro-qnh')
})

test('ladder: v0/v1 geom 45 m from the baro chain is accepted', () => {
  const chain = 5000 * FT + N // qnh 1013.25 → no correction
  for (const version of [0, 1, null]) {
    const r = new AltitudeLadder().height(sample({ version, altBaroFt: 5000, navQnhHpa: 1013.25, altGeomFt: (chain + 45) / FT }))!
    assert.equal(r.source, 'geom', `version ${version}`)
    near(r.hM, chain + 45, 1e-9)
  }
})

test('ladder: v0/v1 geom 100 m from the baro chain is rejected → baro rung', () => {
  const chain = 5000 * FT + N
  for (const version of [0, 1, null]) {
    const r = new AltitudeLadder().height(sample({ version, altBaroFt: 5000, navQnhHpa: 1013.25, altGeomFt: (chain + 100) / FT }))!
    assert.equal(r.source, 'baro-qnh', `version ${version}`)
    near(r.hM, chain, 1e-9)
  }
})

test('ladder: v2 geom is trusted even 100 m from baro (the datum is known)', () => {
  const chain = 5000 * FT + N
  const r = new AltitudeLadder().height(sample({ version: 2, altBaroFt: 5000, navQnhHpa: 1013.25, altGeomFt: (chain + 100) / FT }))!
  assert.equal(r.source, 'geom')
})

test('ladder: learned bias carries geom − baro into baro-bias when geom drops out', () => {
  const lad = new AltitudeLadder()
  const baroFt = 25000 // above 18000 ft: no baro-qnh rung
  const bias = 120 // ISA+ air: geometric height sits above pressure altitude
  for (let i = 0; i < 30; i++) {
    const r = lad.height(sample({ tMs: i * 1000, altBaroFt: baroFt, altGeomFt: (baroFt * FT + N + bias) / FT }))!
    assert.equal(r.source, 'geom')
  }
  const r = lad.height(sample({ tMs: 30_000, altBaroFt: baroFt, altGeomFt: null }))!
  assert.equal(r.source, 'baro-bias')
  near(r.hM, baroFt * FT + N + bias, 0.5)
  // ... and a fresh sample much later still carries the learned bias (the switch offset has bled off by now)
  near(lad.height(sample({ tMs: 300_000, altBaroFt: baroFt, altGeomFt: null }))!.hM, baroFt * FT + N + bias, 0.5)
})

test('ladder: a rejected v0 geom does not teach the bias', () => {
  const lad = new AltitudeLadder()
  const baroFt = 25000
  let r = null
  for (let i = 0; i < 30; i++) {
    r = lad.height(sample({ tMs: i * 1000, version: 0, altBaroFt: baroFt, altGeomFt: (baroFt * FT + N + 100) / FT }))!
    assert.equal(r.source, 'baro-bias')
  }
  near(r!.hM, baroFt * FT + N, 1e-9)
})

test('ladder: switch geom → baro-qnh keeps continuity, steps ≤ 0.5 m per second, then converges', () => {
  const lad = new AltitudeLadder()
  const baroFt = 3000
  const qnh = 1020
  const baroQnh = (baroFt + (qnh - 1013.25) * 27) * FT + N
  const geom = baroQnh + 40 // v2 geom sits 40 m above the QNH-corrected baro
  const out: { t: number; h: number; source: string }[] = []
  for (let t = 0; t <= 200; t++) {
    const r = lad.height(sample({ tMs: t * 1000, altBaroFt: baroFt, navQnhHpa: qnh, altGeomFt: t < 20 ? geom / FT : null }))!
    out.push({ t, h: r.hM, source: r.source })
  }
  assert.equal(out[19].source, 'geom')
  near(out[19].h, geom, 1e-9)
  assert.equal(out[20].source, 'baro-qnh')
  near(out[20].h, geom, 1e-9, 'no step at the switch')
  for (let i = 1; i < out.length; i++) {
    const dt = out[i].t - out[i - 1].t
    assert.ok(Math.abs(out[i].h - out[i - 1].h) <= 0.5 * dt + 1e-9, `step at t=${out[i].t}: ${out[i].h - out[i - 1].h}`)
  }
  near(out.at(-1)!.h, baroQnh, 1e-9, 'converged onto the new rung')
})

test('ladder: an implausible v0 geom jump does not leak into the output', () => {
  const lad = new AltitudeLadder()
  const chain = 5000 * FT + N
  const hs: number[] = []
  for (let t = 0; t < 20; t++) {
    const g = chain + (t < 10 ? 30 : 180) // geom jumps +150 m at t = 10 → rejected
    const r = lad.height(sample({ tMs: t * 1000, version: 0, altBaroFt: 5000, navQnhHpa: 1013.25, altGeomFt: g / FT }))!
    assert.equal(r.source, t < 10 ? 'geom' : 'baro-qnh')
    hs.push(r.hM)
  }
  for (let i = 1; i < hs.length; i++) assert.ok(Math.abs(hs[i] - hs[i - 1]) <= 0.5 + 1e-9, `step at ${i}: ${hs[i] - hs[i - 1]}`)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/track/vertical.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/track/vertical.ts' imported from …/client/track/vertical.test.ts`

- [ ] **Step 3: Write the implementation**

```ts
// client/track/vertical.ts
import type { Sample } from '../../shared/types.ts'
import type { AltSource } from './types.ts'

const FT = 0.3048
const GEOM_GATE_M = 60 // v0/v1 alt_geom must sit within this of the baro chain to be trusted
const SLEW_MS = 0.5 // a rung-switch offset bleeds off at this rate, m/s
const BIAS_GAIN = 0.1 // per-sample EMA gain of (geom − raw baro), ≈ 10 s memory at 1 Hz
const ORDER: AltSource[] = ['geom', 'baro-qnh', 'baro-bias'] // ladder priority, best first

type Rungs = Partial<Record<AltSource, number>>

/**
 * Picks the best height for each sample, in WGS84 ellipsoidal metres. One instance per aircraft;
 * call height() in sample-time order. Rungs, best first:
 *  - geom: alt_geom when version === 2 (HAE by spec); v0/v1/unknown only within 60 m of the baro chain
 *    (or when there is no baro at all).
 *  - baro-qnh: (altBaroFt + (qnh − 1013.25)·27 ft/hPa)·0.3048 + N, when 950 ≤ qnh ≤ 1050 and altBaroFt < 18000.
 *  - baro-bias: altBaroFt·0.3048 + N + learned bias, the bias being an EMA of (trusted geom − raw baro).
 * A rung switch keeps the output continuous: the jump becomes an offset that bleeds to 0 at 0.5 m/s.
 * Returns null on the ground (and resets the continuity state) or when no rung is usable.
 */
export class AltitudeLadder {
  private bias: number | null = null
  private offset = 0
  private prev: { tMs: number; source: AltSource; rungs: Rungs } | null = null

  height(s: Sample): { hM: number; source: AltSource } | null {
    if (s.onGround) {
      this.prev = null
      this.offset = 0
      return null
    }
    const rungs: Rungs = {}
    const rawBaro = s.altBaroFt === null ? null : s.altBaroFt * FT + s.nM
    if (s.altBaroFt !== null && rawBaro !== null) {
      const q = s.navQnhHpa
      if (q !== null && q >= 950 && q <= 1050 && s.altBaroFt < 18000) rungs['baro-qnh'] = (s.altBaroFt + (q - 1013.25) * 27) * FT + s.nM
      rungs['baro-bias'] = rawBaro + (this.bias ?? 0)
    }
    const chain = rungs['baro-qnh'] ?? rungs['baro-bias']
    if (s.altGeomFt !== null) {
      const g = s.altGeomFt * FT
      if (s.version === 2 || chain === undefined || Math.abs(g - chain) <= GEOM_GATE_M) rungs.geom = g
    }
    const source = ORDER.find((k) => rungs[k] !== undefined)
    if (source === undefined) return null

    if (rungs.geom !== undefined && rawBaro !== null) {
      const d = rungs.geom - rawBaro
      this.bias = this.bias === null ? d : this.bias + BIAS_GAIN * (d - this.bias)
    }

    const p = this.prev
    if (p) {
      const dtS = Math.max(0, (s.tMs - p.tMs) / 1000)
      this.offset = Math.sign(this.offset) * Math.max(0, Math.abs(this.offset) - SLEW_MS * dtS)
      if (source !== p.source) {
        // Measure the jump between the two rungs at one instant: now if the old rung is still valid,
        // else at the previous sample (the old rung's current value is missing or untrusted).
        const now = rungs[p.source]
        const was = p.rungs[source]
        const jump = now !== undefined ? rungs[source]! - now
          : was !== undefined ? was - p.rungs[p.source]!
          : rungs[source]! - p.rungs[p.source]! // ponytail: includes dt of real motion; only when the rungs never overlapped
        this.offset -= jump
      }
    }
    this.prev = { tMs: s.tMs, source, rungs }
    return { hM: rungs[source]! + this.offset, source }
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/track/vertical.test.ts`
Expected: PASS — `ℹ tests 12`, `ℹ pass 12`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add client/track/vertical.ts client/track/vertical.test.ts
git commit -m "feat(track): altitude ladder with plausibility-gated geom and continuous rung switches"
```

---

### Task 2: Vertical filter

**Files:**
- Modify: `client/track/vertical.ts` (adds `VerticalFilter`), `client/track/vertical.test.ts` (adds filter and scenario tests)
- Test: `client/track/vertical.test.ts`

**Interfaces:**
- Consumes: `AltitudeLadder` (Task 1), used only by the ladder→filter scenario test
- Produces: `class VerticalFilter { constructor(opts?: { alpha?: number; beta?: number }); add(t: number, hM: number, rateMs: number | null): void; at(t: number): { hM: number; vsMs: number } | null }`
  - `t` is in **seconds**. Any epoch works if it is used consistently (Track passes `tMs / 1000`). `rateMs` is in m/s: `(geomRateFpm ?? baroRateFpm)·0.3048/60`, or null.
  - Update with `dt = t − t_prev`: `h⁻ = h + v·dt`, `r = z − h⁻`, `h = h⁻ + α·r`, `v = v + (β/dt)·r`. When a rate is present, also `v += 0.5·(rate − v)`. The first sample seeds `v = rate ?? 0`. A sample with `t ≤` the last `t` is ignored. The filter keeps the newest 600 states.
  - `at(t)`: `null` before the first state; a cubic Hermite through the filtered `(h, v)` states between states; `h_last + v_last·(t − t_last)` after the last one.
  - Defaults: `α = 0.2`, `β = 0.02`, which is about the critically damped pair `β = α²/(2 − α) = 0.022`. They were chosen by running the Step 1 descent scenario: a 3° glide at 140 kt, 25 ft quantisation, irregular sample times, rendered 3 s behind at 60 Hz, with p95 taken over 175 s. The table shows the results. Across 5 random seeds the defaults score a height p95 of 1.33–1.65 m and a VS p95 of 0.92–1.19 m/s.

| filter | reported rate | height p95 | VS p95 |
|---|---|---|---|
| linear interpolation of the raw samples (baseline) | — | 2.96 m | 6.32 m/s |
| α 0.1, β 0.005 | quantised / none / 10 % steep | 1.81 / **18.5** / 4.06 m | 0.50 / 1.07 / 0.58 m/s |
| **α 0.2, β 0.02 (default)** | quantised / none / 10 % steep | **1.34 / 1.54 / 2.29 m** | **1.03 / 1.04 / 1.03 m/s** |
| α 0.3, β 0.05 | quantised / none / 10 % steep | 1.35 / 1.44 / 1.84 m | 1.59 / 1.58 / 1.59 m/s |
| α 0.5, β 0.17 | quantised / none / 10 % steep | 1.80 / 1.96 / 1.85 m | 2.82 / 2.73 / 2.78 m/s |

  α 0.1 fails without a rate, and α 0.5 lets the quantisation through into VS. α 0.2 is the most even across all three rate conditions.

- [ ] **Step 1: Write the failing test** (replace the whole file)

```ts
// client/track/vertical.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AltitudeLadder, VerticalFilter } from './vertical.ts'
import type { Sample } from '../../shared/types.ts'

const FT = 0.3048
const KT = 1852 / 3600
const N = -32.3 // KSFO-area geoid undulation, metres

function sample(p: Partial<Sample>): Sample {
  return {
    hex: 'abc123', tMs: 0, rxMs: 0, lat: 37.6, lon: -122.4, onGround: false,
    altBaroFt: null, altGeomFt: null, gsKt: 140, trackDeg: 280, trueHeadingDeg: null, rollDeg: null,
    baroRateFpm: null, geomRateFpm: null, navQnhHpa: null, version: 2, nic: 8, quality: 'adsb2',
    nM: N, callsign: null, typeCode: null, reg: null, ...p,
  }
}

const near = (a: number, b: number, tol: number, msg?: string): void =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} got ${a}, expected ${b} ± ${tol}`)

// ---------- AltitudeLadder ----------

test('ladder: v2 alt_geom is HAE and used directly', () => {
  const r = new AltitudeLadder().height(sample({ version: 2, altGeomFt: 10000, altBaroFt: 9800, navQnhHpa: 1020 }))
  assert.deepEqual(r, { hM: 10000 * FT, source: 'geom' })
})

test('ladder: on ground → null', () => {
  assert.equal(new AltitudeLadder().height(sample({ onGround: true, altGeomFt: 100 })), null)
})

test('ladder: no baro and no geom → null', () => {
  assert.equal(new AltitudeLadder().height(sample({ version: 0 })), null)
})

test('ladder: baro-qnh at 1003.25 hPa is −270 FEET before the metre conversion', () => {
  const r = new AltitudeLadder().height(sample({ version: 0, altBaroFt: 5000, navQnhHpa: 1003.25 }))!
  assert.equal(r.source, 'baro-qnh')
  near(r.hM, (5000 - 270) * FT + N, 1e-9)
  // the old plan's unit bug added N (metres) to feet: that answer is ~64 m away and must not come back
  assert.ok(Math.abs(r.hM - ((5000 - 270 + N) * FT)) > 20)
})

test('ladder: baro-qnh needs 950 ≤ qnh ≤ 1050 and alt_baro < 18000 ft, else baro-bias', () => {
  const raw = (ft: number): number => ft * FT + N
  const cases: [number, number | null][] = [[20000, 1003.25], [5000, 940], [5000, 1060], [5000, null]]
  for (const [ft, qnh] of cases) {
    const r = new AltitudeLadder().height(sample({ version: 0, altBaroFt: ft, navQnhHpa: qnh }))!
    assert.equal(r.source, 'baro-bias', `${ft} ft, qnh ${qnh}`)
    near(r.hM, raw(ft), 1e-9, `${ft} ft, qnh ${qnh}`)
  }
  assert.equal(new AltitudeLadder().height(sample({ version: 0, altBaroFt: 5000, navQnhHpa: 950 }))!.source, 'baro-qnh')
  assert.equal(new AltitudeLadder().height(sample({ version: 0, altBaroFt: 5000, navQnhHpa: 1050 }))!.source, 'baro-qnh')
})

test('ladder: v0/v1 geom 45 m from the baro chain is accepted', () => {
  const chain = 5000 * FT + N // qnh 1013.25 → no correction
  for (const version of [0, 1, null]) {
    const r = new AltitudeLadder().height(sample({ version, altBaroFt: 5000, navQnhHpa: 1013.25, altGeomFt: (chain + 45) / FT }))!
    assert.equal(r.source, 'geom', `version ${version}`)
    near(r.hM, chain + 45, 1e-9)
  }
})

test('ladder: v0/v1 geom 100 m from the baro chain is rejected → baro rung', () => {
  const chain = 5000 * FT + N
  for (const version of [0, 1, null]) {
    const r = new AltitudeLadder().height(sample({ version, altBaroFt: 5000, navQnhHpa: 1013.25, altGeomFt: (chain + 100) / FT }))!
    assert.equal(r.source, 'baro-qnh', `version ${version}`)
    near(r.hM, chain, 1e-9)
  }
})

test('ladder: v2 geom is trusted even 100 m from baro (the datum is known)', () => {
  const chain = 5000 * FT + N
  const r = new AltitudeLadder().height(sample({ version: 2, altBaroFt: 5000, navQnhHpa: 1013.25, altGeomFt: (chain + 100) / FT }))!
  assert.equal(r.source, 'geom')
})

test('ladder: learned bias carries geom − baro into baro-bias when geom drops out', () => {
  const lad = new AltitudeLadder()
  const baroFt = 25000 // above 18000 ft: no baro-qnh rung
  const bias = 120 // ISA+ air: geometric height sits above pressure altitude
  for (let i = 0; i < 30; i++) {
    const r = lad.height(sample({ tMs: i * 1000, altBaroFt: baroFt, altGeomFt: (baroFt * FT + N + bias) / FT }))!
    assert.equal(r.source, 'geom')
  }
  const r = lad.height(sample({ tMs: 30_000, altBaroFt: baroFt, altGeomFt: null }))!
  assert.equal(r.source, 'baro-bias')
  near(r.hM, baroFt * FT + N + bias, 0.5)
  // ... and a fresh sample much later still carries the learned bias (the switch offset has bled off by now)
  near(lad.height(sample({ tMs: 300_000, altBaroFt: baroFt, altGeomFt: null }))!.hM, baroFt * FT + N + bias, 0.5)
})

test('ladder: a rejected v0 geom does not teach the bias', () => {
  const lad = new AltitudeLadder()
  const baroFt = 25000
  let r = null
  for (let i = 0; i < 30; i++) {
    r = lad.height(sample({ tMs: i * 1000, version: 0, altBaroFt: baroFt, altGeomFt: (baroFt * FT + N + 100) / FT }))!
    assert.equal(r.source, 'baro-bias')
  }
  near(r!.hM, baroFt * FT + N, 1e-9)
})

test('ladder: switch geom → baro-qnh keeps continuity, steps ≤ 0.5 m per second, then converges', () => {
  const lad = new AltitudeLadder()
  const baroFt = 3000
  const qnh = 1020
  const baroQnh = (baroFt + (qnh - 1013.25) * 27) * FT + N
  const geom = baroQnh + 40 // v2 geom sits 40 m above the QNH-corrected baro
  const out: { t: number; h: number; source: string }[] = []
  for (let t = 0; t <= 200; t++) {
    const r = lad.height(sample({ tMs: t * 1000, altBaroFt: baroFt, navQnhHpa: qnh, altGeomFt: t < 20 ? geom / FT : null }))!
    out.push({ t, h: r.hM, source: r.source })
  }
  assert.equal(out[19].source, 'geom')
  near(out[19].h, geom, 1e-9)
  assert.equal(out[20].source, 'baro-qnh')
  near(out[20].h, geom, 1e-9, 'no step at the switch')
  for (let i = 1; i < out.length; i++) {
    const dt = out[i].t - out[i - 1].t
    assert.ok(Math.abs(out[i].h - out[i - 1].h) <= 0.5 * dt + 1e-9, `step at t=${out[i].t}: ${out[i].h - out[i - 1].h}`)
  }
  near(out.at(-1)!.h, baroQnh, 1e-9, 'converged onto the new rung')
})

test('ladder: an implausible v0 geom jump does not leak into the output', () => {
  const lad = new AltitudeLadder()
  const chain = 5000 * FT + N
  const hs: number[] = []
  for (let t = 0; t < 20; t++) {
    const g = chain + (t < 10 ? 30 : 180) // geom jumps +150 m at t = 10 → rejected
    const r = lad.height(sample({ tMs: t * 1000, version: 0, altBaroFt: 5000, navQnhHpa: 1013.25, altGeomFt: g / FT }))!
    assert.equal(r.source, t < 10 ? 'geom' : 'baro-qnh')
    hs.push(r.hM)
  }
  for (let i = 1; i < hs.length; i++) assert.ok(Math.abs(hs[i] - hs[i - 1]) <= 0.5 + 1e-9, `step at ${i}: ${hs[i] - hs[i - 1]}`)
})

// ---------- VerticalFilter ----------

test('filter: null before the first sample, and before the first sample time', () => {
  const f = new VerticalFilter()
  assert.equal(f.at(0), null)
  f.add(10, 100, null)
  assert.equal(f.at(9.99), null)
  assert.deepEqual(f.at(10), { hM: 100, vsMs: 0 })
})

test('filter: extrapolates with the rate after the last state', () => {
  const f = new VerticalFilter()
  f.add(0, 100, 2)
  const s = f.at(5)!
  near(s.hM, 110, 1e-9)
  near(s.vsMs, 2, 1e-9)
})

test('filter: cubic Hermite between filtered states (smoothstep midpoint)', () => {
  const f = new VerticalFilter({ alpha: 1, beta: 0 }) // α = 1: states sit on the measurements
  f.add(0, 0, 0)
  f.add(1, 1, 0)
  const s = f.at(0.5)!
  near(s.hM, 0.5, 1e-9)
  near(s.vsMs, 1.5, 1e-9)
  near(f.at(1)!.hM, 1, 1e-9)
})

test('filter: a sample at or before the last time is ignored', () => {
  const f = new VerticalFilter()
  f.add(0, 100, 0)
  f.add(0, 500, 0)
  f.add(-1, 500, 0)
  assert.deepEqual(f.at(0), { hM: 100, vsMs: 0 })
})

// A 3° glide at 140 kt: VS ≈ −3.77 m/s. alt quantised to 25 ft, rate to 64 fpm, irregular sample times,
// 0.3 s transport latency, rendered causally 3 s behind at 60 Hz (what Track + RenderClock do).
const VS = -140 * KT * Math.tan((3 * Math.PI) / 180)
const truth = (t: number): number => 1000 + VS * t
const quantFt = (m: number, stepFt: number): number => Math.round(m / FT / stepFt) * stepFt * FT

function rng(seed: number): () => number {
  let x = seed >>> 0
  return () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32
}

const RATE_Q = (Math.round(((VS / FT) * 60) / 64) * 64 * FT) / 60 // reported rate, 64 fpm steps

const p95 = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(0.95 * s.length))]
}

function runDescent(f: VerticalFilter, rateMs: number | null): { posP95: number; vsP95: number; maxStep: number } {
  const next = rng(42)
  const times: number[] = []
  for (let t = 0; t < 200; t += 0.5 + next()) times.push(t)
  const posErr: number[] = []
  const vsErr: number[] = []
  let k = 0
  let prevH: number | null = null
  let maxStep = 0
  for (let frame = 0; frame < 195 * 60; frame++) {
    const T = frame / 60
    while (k < times.length && times[k] + 0.3 <= T) {
      f.add(times[k], quantFt(truth(times[k]), 25), rateMs)
      k++
    }
    const tr = T - 3
    const s = f.at(tr)
    if (s === null) continue
    if (prevH !== null) maxStep = Math.max(maxStep, Math.abs(s.hM - prevH))
    prevH = s.hM
    if (tr >= 20) {
      posErr.push(Math.abs(s.hM - truth(tr)))
      vsErr.push(Math.abs(s.vsMs - VS))
    }
  }
  return { posP95: p95(posErr), vsP95: p95(vsErr), maxStep }
}

test('filter: 3° descent at 140 kt, 25 ft quantised, with reported rate → smooth and accurate', () => {
  // naive linear interpolation of the raw samples scores height p95 ≈ 3.0 m and VS p95 ≈ 6.3 m/s here
  const r = runDescent(new VerticalFilter(), RATE_Q)
  assert.ok(r.posP95 <= 2.5, `height error p95 ${r.posP95.toFixed(2)} m (25 ft steps are 7.6 m)`)
  assert.ok(r.vsP95 <= 2, `VS error p95 ${r.vsP95.toFixed(2)} m/s`)
  assert.ok(r.maxStep <= 1, `max per-frame step ${r.maxStep.toFixed(3)} m`)
})

test('filter: same descent without any reported rate still meets the G2 vertical bar', () => {
  const r = runDescent(new VerticalFilter(), null)
  assert.ok(r.posP95 <= 2.5, `height error p95 ${r.posP95.toFixed(2)} m`)
  assert.ok(r.vsP95 <= 2, `VS error p95 ${r.vsP95.toFixed(2)} m/s`)
  assert.ok(r.maxStep <= 1, `max per-frame step ${r.maxStep.toFixed(3)} m`)
})

test('filter: a reported rate 10 % steeper than the height track (baro rate vs geometric height) does not drag the height away', () => {
  const r = runDescent(new VerticalFilter(), VS * 1.1)
  assert.ok(r.posP95 <= 3, `height error p95 ${r.posP95.toFixed(2)} m`)
  assert.ok(r.vsP95 <= 2, `VS error p95 ${r.vsP95.toFixed(2)} m/s`)
})

test('ladder → filter: a geom → baro-qnh switch mid-descent renders without a VS spike or a frame step > 1 m', () => {
  const lad = new AltitudeLadder()
  const f = new VerticalFilter()
  const qnh = 1020
  const corrM = (qnh - 1013.25) * 27 * FT
  const next = rng(7)
  const times: number[] = []
  for (let t = 0; t < 120; t += 0.5 + next()) times.push(t)
  let k = 0
  let prevH: number | null = null
  let maxStep = 0
  const vsErr: number[] = []
  for (let frame = 0; frame < 115 * 60; frame++) {
    const T = frame / 60
    while (k < times.length && times[k] + 0.3 <= T) {
      const t = times[k]
      const geomM = truth(t) + 40 // geom 40 m above the baro-qnh reading of the same air
      const baroFt = (truth(t) - N - corrM) / FT
      const s = sample({
        tMs: t * 1000,
        altBaroFt: Math.round(baroFt / 25) * 25,
        navQnhHpa: qnh,
        altGeomFt: t < 60 ? Math.round(geomM / FT / 25) * 25 : null,
        geomRateFpm: Math.round(((VS / FT) * 60) / 64) * 64,
      })
      const h = lad.height(s)!
      f.add(t, h.hM, (s.geomRateFpm! * FT) / 60)
      k++
    }
    const st = f.at(T - 3)
    if (st === null) continue
    if (prevH !== null) maxStep = Math.max(maxStep, Math.abs(st.hM - prevH))
    prevH = st.hM
    if (T - 3 >= 20) vsErr.push(Math.abs(st.vsMs - VS))
  }
  // without the ladder's continuity offset the raw 40 m rung jump shows up as VS p95 ≈ 3.1 m/s, max ≈ 12 m/s
  assert.ok(maxStep <= 1, `max per-frame step ${maxStep.toFixed(3)} m`)
  assert.ok(p95(vsErr) <= 2, `VS error p95 ${p95(vsErr).toFixed(2)} m/s`)
  assert.ok(Math.max(...vsErr) <= 4, `VS error max ${Math.max(...vsErr).toFixed(2)} m/s`)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/track/vertical.test.ts`
Expected: FAIL — `SyntaxError: The requested module './vertical.ts' does not provide an export named 'VerticalFilter'`

- [ ] **Step 3: Write the implementation** (replace the whole file)

```ts
// client/track/vertical.ts
import type { Sample } from '../../shared/types.ts'
import type { AltSource } from './types.ts'

const FT = 0.3048
const GEOM_GATE_M = 60 // v0/v1 alt_geom must sit within this of the baro chain to be trusted
const SLEW_MS = 0.5 // a rung-switch offset bleeds off at this rate, m/s
const BIAS_GAIN = 0.1 // per-sample EMA gain of (geom − raw baro), ≈ 10 s memory at 1 Hz
const ORDER: AltSource[] = ['geom', 'baro-qnh', 'baro-bias'] // ladder priority, best first

type Rungs = Partial<Record<AltSource, number>>

/**
 * Picks the best height for each sample, in WGS84 ellipsoidal metres. One instance per aircraft;
 * call height() in sample-time order. Rungs, best first:
 *  - geom: alt_geom when version === 2 (HAE by spec); v0/v1/unknown only within 60 m of the baro chain
 *    (or when there is no baro at all).
 *  - baro-qnh: (altBaroFt + (qnh − 1013.25)·27 ft/hPa)·0.3048 + N, when 950 ≤ qnh ≤ 1050 and altBaroFt < 18000.
 *  - baro-bias: altBaroFt·0.3048 + N + learned bias, the bias being an EMA of (trusted geom − raw baro).
 * A rung switch keeps the output continuous: the jump becomes an offset that bleeds to 0 at 0.5 m/s.
 * Returns null on the ground (and resets the continuity state) or when no rung is usable.
 */
export class AltitudeLadder {
  private bias: number | null = null
  private offset = 0
  private prev: { tMs: number; source: AltSource; rungs: Rungs } | null = null

  height(s: Sample): { hM: number; source: AltSource } | null {
    if (s.onGround) {
      this.prev = null
      this.offset = 0
      return null
    }
    const rungs: Rungs = {}
    const rawBaro = s.altBaroFt === null ? null : s.altBaroFt * FT + s.nM
    if (s.altBaroFt !== null && rawBaro !== null) {
      const q = s.navQnhHpa
      if (q !== null && q >= 950 && q <= 1050 && s.altBaroFt < 18000) rungs['baro-qnh'] = (s.altBaroFt + (q - 1013.25) * 27) * FT + s.nM
      rungs['baro-bias'] = rawBaro + (this.bias ?? 0)
    }
    const chain = rungs['baro-qnh'] ?? rungs['baro-bias']
    if (s.altGeomFt !== null) {
      const g = s.altGeomFt * FT
      if (s.version === 2 || chain === undefined || Math.abs(g - chain) <= GEOM_GATE_M) rungs.geom = g
    }
    const source = ORDER.find((k) => rungs[k] !== undefined)
    if (source === undefined) return null

    if (rungs.geom !== undefined && rawBaro !== null) {
      const d = rungs.geom - rawBaro
      this.bias = this.bias === null ? d : this.bias + BIAS_GAIN * (d - this.bias)
    }

    const p = this.prev
    if (p) {
      const dtS = Math.max(0, (s.tMs - p.tMs) / 1000)
      this.offset = Math.sign(this.offset) * Math.max(0, Math.abs(this.offset) - SLEW_MS * dtS)
      if (source !== p.source) {
        // Measure the jump between the two rungs at one instant: now if the old rung is still valid,
        // else at the previous sample (the old rung's current value is missing or untrusted).
        const now = rungs[p.source]
        const was = p.rungs[source]
        const jump = now !== undefined ? rungs[source]! - now
          : was !== undefined ? was - p.rungs[p.source]!
          : rungs[source]! - p.rungs[p.source]! // ponytail: includes dt of real motion; only when the rungs never overlapped
        this.offset -= jump
      }
    }
    this.prev = { tMs: s.tMs, source, rungs }
    return { hM: rungs[source]! + this.offset, source }
  }
}

interface State {
  t: number
  h: number
  v: number
}

const RATE_GAIN = 0.5 // how far a reported vertical rate pulls the velocity estimate per sample
const MAX_STATES = 600 // ponytail: ~10 min at 1 Hz; at() before the oldest kept state returns null. Render delay is ≤ 10 s.

/**
 * α-β filter over irregularly timed heights. t is in SECONDS (any epoch, consistent across calls), hM metres,
 * rateMs the reported vertical rate in m/s (geom_rate or baro_rate converted) or null.
 * Update per sample (dt = t − t_prev): predict h⁻ = h + v·dt; r = z − h⁻;
 *   h = h⁻ + α·r;  v = v + (β/dt)·r;  then, with a reported rate, v += RATE_GAIN·(rate − v).
 * at(t): null before the first state; cubic Hermite through the filtered (h, v) states between them;
 * h + v·(t − t_last) after the last.
 * Defaults α = 0.2, β = 0.02: the critically damped pair (β = α²/(2 − α)) that turns 25 ft (7.6 m) quantisation
 * into ≈ 1–2 m height noise while the β term still absorbs a biased or missing rate within ~20 samples.
 */
export class VerticalFilter {
  private readonly alpha: number
  private readonly beta: number
  private readonly states: State[] = []

  constructor(opts: { alpha?: number; beta?: number } = {}) {
    this.alpha = opts.alpha ?? 0.2
    this.beta = opts.beta ?? 0.02
  }

  add(t: number, hM: number, rateMs: number | null): void {
    const last = this.states.at(-1)
    if (last === undefined) {
      this.states.push({ t, h: hM, v: rateMs ?? 0 })
      return
    }
    const dt = t - last.t
    if (!(dt > 0)) return
    const hPred = last.h + last.v * dt
    const r = hM - hPred
    let v = last.v + (this.beta / dt) * r
    if (rateMs !== null) v += RATE_GAIN * (rateMs - v)
    this.states.push({ t, h: hPred + this.alpha * r, v })
    if (this.states.length > MAX_STATES) this.states.shift()
  }

  at(t: number): { hM: number; vsMs: number } | null {
    const st = this.states
    if (st.length === 0 || t < st[0].t) return null
    const last = st[st.length - 1]
    if (t >= last.t) return { hM: last.h + last.v * (t - last.t), vsMs: last.v }
    let i = st.length - 2
    while (st[i].t > t) i-- // render time sits near the newest states, so scan from the end
    return hermite(st[i], st[i + 1], t)
  }
}

function hermite(a: State, b: State, t: number): { hM: number; vsMs: number } {
  const dt = b.t - a.t
  const s = (t - a.t) / dt
  const s2 = s * s
  const s3 = s2 * s
  const hM = (2 * s3 - 3 * s2 + 1) * a.h + (s3 - 2 * s2 + s) * dt * a.v + (-2 * s3 + 3 * s2) * b.h + (s3 - s2) * dt * b.v
  const vsMs = ((6 * s2 - 6 * s) * a.h + (-6 * s2 + 6 * s) * b.h) / dt + (3 * s2 - 4 * s + 1) * a.v + (3 * s2 - 2 * s) * b.v
  return { hM, vsMs }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/track/vertical.test.ts`
Expected: PASS — `ℹ tests 20`, `ℹ pass 20`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add client/track/vertical.ts client/track/vertical.test.ts
git commit -m "feat(track): alpha-beta vertical filter with Hermite interpolation and rate extrapolation"
```

---

### Task 3: WP gate

- [ ] **Step 1: Package tests**

Run: `node --test client/track/vertical.test.ts`
Expected: `ℹ tests 20`, `ℹ pass 20`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/track/vertical'`
Expected: no output. In this package's own worktree, which holds only WP-00 and this package, plain `npx tsc --noEmit` is silent too.

- [ ] **Step 3: Full check**

Run: `npm run check`
Expected: `tsc` silent; `ℹ tests 61` (WP-00's 41 + these 20), `ℹ fail 0`.

## Notes for I2 (Track)

- Keep one `AltitudeLadder` and one `VerticalFilter` per aircraft. For each new sample in time order, `const h = ladder.height(s)`. If `h` is not null, call `filter.add(s.tMs / 1000, h.hM, rate)` with `rate = s.geomRateFpm ?? s.baroRateFpm`, converted with `* 0.3048 / 60`, or null.
- `height()` returns `null` both on the ground and when a sample carries no altitude. Check `s.onGround` to tell them apart. Ground height is not this package's job (M4).
- `RenderState.altSource` = the `source` of the newest accepted sample. `RenderState.vsFpm = filter.at(t).vsMs / 0.3048 * 60`.

# WP-I2 — Track Estimator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn each aircraft's stream of deduped `Sample`s into a smooth `RenderState` at any render time: Hermite between samples, constant-turn dead reckoning for at most 8 s after the newest (then `stale`, frozen), a re-join blend when fresh data corrects the path, a filtered vertical, synthesised attitude, and a per-aircraft playback-delay target. `TrackRegistry` holds one `Track` per hex for the app (A2) and the bench (A3).

**Architecture:** Two files. `client/track/track.ts` is one class per aircraft that wires the Wave 1 math together. Its only own maths is glue: meridian convergence, the tangent-plane sag and a velocity term for the re-join:
- **Samples:** a `Deduper` (WP-00) admits only strictly newer samples, so the array stays sorted by `tMs`; the window keeps the last 120 s. Internal time is seconds since the first sample.
- **ENU frame:** C1's `Enu` with the origin at the first sample at h = 0. It moves to the newest sample only when that is > 100 km away; the old on-screen point is carried into the new frame through geodetic, so a re-centre is invisible. Knots are the `(e, n)` of each sample at h = 0; going back to lat/lon uses `inv(e, n, −d²/2R)` (the tangent plane sags below the ellipsoid, ≤ 0.8 km at 100 km; the spherical sag leaves ≤ ~5 cm, a `ponytail:` note).
- **Horizontal knots (ADS-B, `other`):** velocity from `gsKt`·0.514444 along `trackDeg` (true heading on the ground when the track is missing), rotated by the meridian convergence of that sample in the ENU frame; fallback is the finite difference of the neighbouring samples (C2's `velocitiesFromPositions`: central, one-sided at the ends). The same finite difference vetoes a reported velocity that differs by > 20 % in speed or > 15° in direction, but only when the finite-difference speed is ≥ 10 m/s (below that, position quantisation dominates).
- **Horizontal knots (MLAT, chosen by the newest sample's quality):** C2's `gateOutliers(maxSpeedMs = 1.5 × the highest reported gs in the window, or 360 m/s)` → `smoothPositions(halfWindow 2)` → `velocitiesFromPositions`.
- **Rendering:** C2's `hermite` between the bracketing knots; after the newest knot C2's `extrapolate` with the turn rate from C5's `turnRateDegS` between the newest knot and the newest knot ≥ 2 s older (clamped ±6 °/s), for ≤ 8 s; past that the whole pose (horizontal, vertical, attitude target) is frozen at the 8 s point and `mode = 'stale'`.
- **Re-join:** whenever `add()` changes the estimate at the last rendered time (after extrapolating, when MLAT smoothing revises the newest knots, or on a re-centre), the difference between what was on screen and the new estimate is blended out: C2's `RejoinBlend` carries the position error (raised cosine), and a velocity bump `T·u(1 − u)²·errV` carries the velocity error, so the rendered path keeps position **and** velocity (C1-continuous) in all three axes. T = 1.5 s (the G2 re-join bar), 3 s for MLAT revisions. An unchanged estimate reproduces bit-exactly, so the running blend is left alone then.
- **Vertical:** one C4 `AltitudeLadder` → one C4 `VerticalFilter` per aircraft (`rate` = `geomRateFpm` on the geom rung when present, else `baroRateFpm`, × 0.3048/60). On the ground: the last airborne filtered height if it is < 60 s older than the render time, else the sample's `nM` (MSL 0 as HAE; consumers clamp ground aircraft to terrain). `altSource` is the newest rung seen.
- **Attitude:** C5 `targetAttitude({ gsMs, vsMs, headingDeg: true heading (interpolated the short way, turned at the dead-reckoning rate while extrapolating) ?? track of the interpolated velocity, broadcastRollDeg, turnRateDegS: track change over the last 1 s of the model, onGround, phase: null, mlat })` → one C5 `AttitudeSmoother`, stepped by the difference between successive `stateAt` times and replaced when render time goes backwards.
- **Delay:** `delayTargetS = targetDelayS(quality, pollPeriodS ?? 1, gapP90S())` (C3), where `gapP90S()` is C3's nearest-rank `p90` of the gaps whose later sample is within 60 s of the newest.

`client/track/registry.ts` is a `Map<hex, Track>`: `ingest` sorts each batch by `tMs` and routes it, `states` returns the non-null states, `delayTargetS(hex)` falls back to 3 s, `prune` drops tracks whose newest sample is older than `maxAgeS`.

**Tech Stack:** Node ≥ 24.2 (native TypeScript), `node:test`, TypeScript 7 (type-check only). No dependencies beyond WP-00's.

**Wave:** 2 (needs WP-00 and C1–C5 merged). **Estimated:** 2 h. **Validated:** on 2026-09-22 (Node v25.2.1, TypeScript 7.0.2) in the shared sandbox holding WP-00 and every Wave 1 file (C1–C5 included) plus `node_modules`: `node --test client/track/track.test.ts client/track/registry.test.ts` → 18/18 pass; `npx tsc --noEmit` reported no errors at all (so none in `client/track/{track,registry}*`). Each Step 2 quotes its real RED output. The code below was generated from the tested files, byte for byte. Measured in the tests: 3 °/s turn sampled every 3 s → max 0.067 m off the arc (straight chords 7.1 m); extrapolation re-join → 80.3 m unblended step becomes a 0.084 m max frame jump; MLAT (σ 30 m, 1–3 s spacing, one 3 km outlier) → lateral-acceleration p99 31.2 m/s² vs 196.6 m/s² for raw Hermite, position p95 43.2 m vs 79.7 m; 25 ft-quantised 3° descent → max step 0.091 m per 60 Hz frame, height p95 1.02 m, VS p95 1.08 m/s. Extra checks run outside the plan's tests: 300 aircraft cost 7.7 ms per 1 Hz `ingest` and 0.22 ms per `states()` frame; the real day-1 recording (`data/recordings/2026-09-22.jsonl`, 11.6 min, 143 hexes, 1191 samples, read locally, no network) replayed causally at 60 Hz gave 4.6 M states with 0 non-finite fields.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints; they apply to every task here. The ones that bite this package:
- Erasable TypeScript only (`#private` fields, no parameter properties), `.ts` extensions on relative imports, `import { type X }` for type-only names.
- Units: `Sample` stays in ADS-B units (ft, kt, fpm, deg); everything inside `Track` is SI (s, m, m/s) in the Track's ENU frame; `RenderState` goes back to lat/lon, HAE metres, kt, fpm and degrees as `client/types.ts` says.
- Signed conventions come from WP-00 and C5: heading and track are true degrees, pitch nose-up positive, roll right-wing-down positive, turn rate positive to the right.
- Tests: `node:test` + `node:assert/strict`, no network. Noisy tracks use a seeded PRNG, so every run is identical.
- This package consumes C1–C5 exactly as published and edits none of their files.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `client/track/track.ts` | `class Track` (per-aircraft estimator) |
| `client/track/track.test.ts` | straight, 3 °/s arc, duplicates, dead reckoning and stale, re-join continuity, velocity veto, re-centre, MLAT, vertical, heading, ground, landing, delay, empty track |
| `client/track/registry.ts` | `class TrackRegistry` |
| `client/track/registry.test.ts` | routing, batch ordering, delay default, prune |

---

### Task 1: Track

**Files:**
- Create: `client/track/track.ts`, `client/track/track.test.ts`
- Test: `client/track/track.test.ts`

**Interfaces:**
- Consumes:
  - WP-00: `Sample`, `Quality` (`shared/types.ts`); `Deduper` (`shared/dedupe.ts`); `RenderState` (`client/types.ts`); `KinPoint`, `PosT`, `AltSource` (`client/track/types.ts`)
  - C1: `Enu` (`shared/enu.ts`: `constructor(lat0, lon0, h0)`, `fwd(lat, lon, h): [e, n, u]`, `inv(e, n, u): { lat; lon; h }`)
  - C2: `hermite(a: KinPoint, b: KinPoint, t): HState`, `extrapolate(last: KinPoint, turnRateDegS, dtS): HState`, `class RejoinBlend { constructor(durationS?); start(errE, errN, tS); offset(tS): { e; n } }`, `type HState` (`client/track/hermite.ts`); `gateOutliers(pts: PosT[], maxSpeedMs)`, `smoothPositions(pts: PosT[], halfWindow)`, `velocitiesFromPositions(pts: PosT[]): KinPoint[]` (`client/track/mlat.ts`)
  - C3: `targetDelayS(q, pollPeriodS, gapP90S)`, `p90(xs)` (`client/track/delay.ts`)
  - C4: `class AltitudeLadder { height(s: Sample): { hM; source: AltSource } | null }`, `class VerticalFilter { add(t, hM, rateMs | null); at(t): { hM; vsMs } | null }` (`client/track/vertical.ts`)
  - C5: `targetAttitude(i: AttitudeInput): Att`, `class AttitudeSmoother { step(target: Att, dtS): Att }`, `turnRateDegS(prevTrackDeg, trackDeg, dtS)` (`client/track/attitude.ts`)
- Produces: `class Track { constructor(hex: string, opts?: { pollPeriodS?: number }); add(s: Sample): boolean; stateAt(tRenderMs: number): RenderState | null; gapP90S(): number; get quality(): Quality; get newestTMs(): number | null; get delayTargetS(): number }` (+ `readonly hex: string`)
  - `add` returns false for another hex, a duplicate (Deduper) or a sample not newer than the newest.
  - `stateAt` returns null before the first sample in the window. `mode` = `'interp'` up to the newest knot, `'extrap'` for ≤ 8 s after it, `'stale'` after that (pose frozen at +8 s). `ageS = (tRenderMs − newest tMs)/1000` (negative while interpolating, as the contract defines it). `gsKt` is the modelled speed (null only for a lone sample without gs); `trackDeg` the modelled track (the sample's reported track below 0.5 m/s); `altBaroFt`, `onGround`, `quality` come from the current sample (the newest at or before the render time); `vsFpm` is the filtered rate (0 on the ground, null with no altitude yet); `callsign`/`typeCode` the newest non-null values.
  - `quality` = the newest sample's (`'other'` when empty); `gapP90S()` = 0 with fewer than 2 samples.

- [ ] **Step 1: Write the failing test**

```ts
// client/track/track.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Enu } from '../../shared/enu.ts'
import type { Sample } from '../../shared/types.ts'
import type { RenderState } from '../types.ts'
import { hermite } from './hermite.ts'
import { velocitiesFromPositions } from './mlat.ts'
import { Track } from './track.ts'
import type { PosT } from './types.ts'

const KT = 1852 / 3600
const FT = 0.3048
const R = 6_371_000
const T0 = 1_760_000_000_000 // server-clock ms of t = 0 s
const frame = new Enu(32.0, 34.9, 0) // truth frame; near LLBG
const rad = (d: number): number => (d * Math.PI) / 180
const wrap180 = (d: number): number => ((((d + 180) % 360) + 360) % 360) - 180
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)

/** A Sample with realistic defaults (v2 ADS-B airborne at 10 000 ft); tests override what they need. */
function sample(o: Partial<Sample> & Pick<Sample, 'tMs' | 'lat' | 'lon'>): Sample {
  return {
    hex: 'abc123', rxMs: o.tMs + 1000, onGround: false, altBaroFt: 10000, altGeomFt: 10200, gsKt: null, trackDeg: null,
    trueHeadingDeg: null, rollDeg: null, baroRateFpm: null, geomRateFpm: null, navQnhHpa: null, version: 2, nic: 8,
    quality: 'adsb2', nM: 19.6, callsign: 'ELY001', typeCode: 'B738', reg: '4X-EKA', ...o,
  }
}

interface Truth { e: number; n: number; ve: number; vn: number }
type Path = (t: number) => Truth

/** Surface point whose horizontal ENU coordinates in `frame` are (e, n). */
const geo = (e: number, n: number): { lat: number; lon: number } => frame.inv(e, n, -(e * e + n * n) / (2 * R))

/** Sample of the truth path at t s: exact position; gs and track (local true azimuth of the velocity) as reported. */
function truthSample(path: Path, t: number, o: Partial<Sample> = {}): Sample {
  const p = path(t)
  const g = geo(p.e, p.n)
  const ahead = geo(p.e + p.ve * 0.01, p.n + p.vn * 0.01)
  const [de, dn] = new Enu(g.lat, g.lon, 0).fwd(ahead.lat, ahead.lon, 0)
  const trackDeg = ((Math.atan2(de, dn) * 180) / Math.PI + 360) % 360
  return sample({ tMs: T0 + t * 1000, lat: g.lat, lon: g.lon, gsKt: Math.hypot(p.ve, p.vn) / KT, trackDeg, ...o })
}

const straight = (v: number, trkDeg: number): Path => (t) => {
  const a = rad(trkDeg)
  return { e: v * t * Math.sin(a), n: v * t * Math.cos(a), ve: v * Math.sin(a), vn: v * Math.cos(a) }
}

/** Straight on trk0Deg until tTurn, then a constant turn of wDegS (+ = right). */
const turning = (v: number, trk0Deg: number, wDegS: number, tTurn = 0): Path => (t) => {
  if (t <= tTurn) return straight(v, trk0Deg)(t)
  const p0 = straight(v, trk0Deg)(tTurn)
  const a0 = rad(trk0Deg)
  const w = rad(wDegS)
  const psi = a0 + w * (t - tTurn)
  return { e: p0.e + (v / w) * (Math.cos(a0) - Math.cos(psi)), n: p0.n + (v / w) * (Math.sin(psi) - Math.sin(a0)), ve: v * Math.sin(psi), vn: v * Math.cos(psi) }
}

const errM = (s: RenderState, path: Path, t: number): number => {
  const [e, n] = frame.fwd(s.lat, s.lon, 0)
  const p = path(t)
  return Math.hypot(e - p.e, n - p.n)
}

interface Frame { t: number; s: RenderState }

/** Client-side causal playback: each sample becomes visible latencyS after its tMs; renders at 60 Hz, delayS behind. */
function replay(track: Track, samples: Sample[], o: { fromS: number; toS: number; delayS: number; latencyS?: number }): Frame[] {
  const out: Frame[] = []
  let k = 0
  for (let f = Math.round(o.fromS * 60); f <= Math.round(o.toS * 60); f++) {
    const now = T0 + (f * 1000) / 60
    while (k < samples.length && samples[k].tMs + (o.latencyS ?? 1) * 1000 <= now) track.add(samples[k++])
    const tR = now - o.delayS * 1000
    const s = track.stateAt(tR)
    if (s) out.push({ t: (tR - T0) / 1000, s })
  }
  return out
}

const enuOf = (fr: Frame[]): PosT[] => fr.map(({ t, s }) => { const [e, n] = frame.fwd(s.lat, s.lon, 0); return { t, e, n } })

/** Largest change of the per-frame displacement: a position jump of X m shows up as X. */
function maxJumpM(p: PosT[]): number {
  let m = 0
  for (let i = 2; i < p.length; i++) m = Math.max(m, Math.hypot(p[i].e - 2 * p[i - 1].e + p[i - 2].e, p[i].n - 2 * p[i - 1].n + p[i - 2].n))
  return m
}

const pct = (xs: number[], q: number): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))] }

/** p99 of the acceleration component perpendicular to the velocity, from 60 Hz positions. */
function latAccP99(p: PosT[]): number {
  const a: number[] = []
  for (let i = 1; i < p.length - 1; i++) {
    const dt = (p[i + 1].t - p[i - 1].t) / 2
    const ve = (p[i + 1].e - p[i - 1].e) / (2 * dt)
    const vn = (p[i + 1].n - p[i - 1].n) / (2 * dt)
    const ae = (p[i + 1].e - 2 * p[i].e + p[i - 1].e) / (dt * dt)
    const an = (p[i + 1].n - 2 * p[i].n + p[i - 1].n) / (dt * dt)
    a.push(Math.abs(ae * vn - an * ve) / Math.hypot(ve, vn))
  }
  return pct(a, 0.99)
}

/** Deterministic Gaussian noise (mulberry32 + Box–Muller) and uniform [0, 1). */
function rng(seed: number): { uni: () => number; gauss: () => number } {
  let a = seed >>> 0
  const uni = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { uni, gauss: () => Math.sqrt(-2 * Math.log(1 - uni())) * Math.cos(2 * Math.PI * uni()) }
}

const times = (from: number, to: number, step: number): number[] => { const t: number[] = []; for (let x = from; x <= to + 1e-9; x += step) t.push(x); return t }

test('straight flight: reproduced between samples, track and speed as reported', () => {
  const path = straight(230, 60)
  const tr = new Track('abc123')
  for (const t of times(0, 30, 1)) assert.equal(tr.add(truthSample(path, t)), true)
  let worst = 0
  for (let t = 0; t <= 30; t += 1 / 60) {
    const s = tr.stateAt(T0 + t * 1000)!
    assert.equal(s.mode, 'interp')
    worst = Math.max(worst, errM(s, path, t))
  }
  assert.ok(worst < 0.05, `max error ${worst} m`)
  const s = tr.stateAt(T0 + 12_500)!
  const local = truthSample(path, 12.5).trackDeg! // 60° in the truth frame; 60.013° as local true track 2.9 km away
  near(s.trackDeg!, local, 0.001)
  near(s.headingDeg, local, 0.001)
  near(s.gsKt!, 230 / KT, 0.01)
  near(s.rollDeg, 0, 0.01)
  assert.equal(s.hex, 'abc123')
  assert.equal(s.callsign, 'ELY001')
  assert.equal(s.typeCode, 'B738')
  assert.equal(s.quality, 'adsb2')
  assert.equal(s.onGround, false)
  near(s.ageS, -17.5, 1e-9)
})

test('3°/s turn sampled every 3 s stays on the arc (< 5 m) and banks right', (t) => {
  const path = turning(120, 10, 3) // radius 2292 m, one full circle in 120 s
  const tr = new Track('abc123')
  // adsb.lol precision: lat/lon 6 decimals, gs 0.1 kt, track 0.01°
  const q = (x: number, step: number): number => Math.round(x / step) * step
  for (const ts of times(0, 120, 3)) {
    const s = truthSample(path, ts)
    tr.add({ ...s, lat: q(s.lat, 1e-6), lon: q(s.lon, 1e-6), gsKt: q(s.gsKt!, 0.1), trackDeg: q(s.trackDeg!, 0.01) })
  }
  let worst = 0
  let chord = 0
  for (let ts = 0; ts <= 120; ts += 1 / 60) {
    worst = Math.max(worst, errM(tr.stateAt(T0 + ts * 1000)!, path, ts))
    const a = path(Math.floor(ts / 3) * 3)
    const b = path(Math.min(120, Math.floor(ts / 3) * 3 + 3))
    const u = (ts % 3) / 3
    const x = path(ts)
    chord = Math.max(chord, Math.hypot(a.e + u * (b.e - a.e) - x.e, a.n + u * (b.n - a.n) - x.n))
  }
  t.diagnostic(`max error ${worst.toFixed(3)} m (straight chords: ${chord.toFixed(1)} m)`)
  assert.ok(worst < 5, `max error ${worst} m`)
  // coordinated bank: atan(v·ω/g) = 32.6° right-wing-down
  const s = tr.stateAt(T0 + 60_000)!
  near(s.rollDeg, (Math.atan((120 * rad(3)) / 9.80665) * 180) / Math.PI, 1.5)
})

test('duplicate and re-served samples are ignored', () => {
  const path = straight(200, 90)
  const tr = new Track('abc123')
  const a = truthSample(path, 0)
  assert.equal(tr.add(a), true)
  assert.equal(tr.add(a), false)
  assert.equal(tr.add({ ...a, tMs: a.tMs + 3 }), false)
  assert.equal(tr.add(truthSample(path, -1)), false) // older than the newest
  assert.equal(tr.add({ ...truthSample(path, 1), hex: 'fff000' }), false) // another aircraft
  assert.equal(tr.add(truthSample(path, 1)), true)
  assert.equal(tr.newestTMs, T0 + 1000)
  assert.equal(tr.gapP90S(), 1)
})

test('dead reckoning follows the current turn, stops after 8 s and freezes as stale', () => {
  const path = turning(150, 0, 2)
  const tr = new Track('abc123')
  for (const t of times(0, 30, 1)) tr.add(truthSample(path, t))
  const at = (t: number): RenderState => tr.stateAt(T0 + t * 1000)!
  assert.equal(at(30).mode, 'interp')
  const e5 = at(35)
  assert.equal(e5.mode, 'extrap')
  assert.ok(errM(e5, path, 35) < 2, `5 s dead-reckoning error ${errM(e5, path, 35)} m`)
  assert.equal(at(38).mode, 'extrap')
  const frozen = at(38)
  const s1 = at(38.5)
  const s2 = at(60)
  for (const s of [s1, s2]) {
    assert.equal(s.mode, 'stale')
    near(s.lat, frozen.lat, 1e-9)
    near(s.lon, frozen.lon, 1e-9)
    near(s.hM, frozen.hM, 1e-9)
  }
  near(s2.ageS, 30, 1e-9)
})

test('a sample arriving after extrapolation re-joins without a frame jump (> 2 m at 60 Hz)', (t) => {
  const path = turning(200, 45, 3, 20) // starts a 3°/s turn at 20 s, exactly when the data stops
  const samples = [...times(0, 20, 1), ...times(26, 60, 1)].map((ts) => truthSample(path, ts))
  const fr = replay(new Track('abc123'), samples, { fromS: 3, toS: 60, delayS: 3 })
  const i = fr.findIndex((f) => f.t >= 24) // sample 26 s arrives at 27 s → render time 24 s
  assert.equal(fr[i - 1].s.mode, 'extrap')
  assert.equal(fr[i].s.mode, 'interp')
  // Without a blend the frame would land on the new estimate: a fresh Track holding the same samples.
  const fresh = new Track('abc123')
  for (const s of samples.filter((s) => s.tMs <= T0 + 26_000)) fresh.add(s)
  const [e0, n0] = frame.fwd(fr[i - 1].s.lat, fr[i - 1].s.lon, 0)
  const u = fresh.stateAt(T0 + fr[i].t * 1000)!
  const [e1, n1] = frame.fwd(u.lat, u.lon, 0)
  const unblended = Math.hypot(e1 - e0, n1 - n0) - 200 / 60
  const jump = maxJumpM(enuOf(fr))
  t.diagnostic(`unblended step ${unblended.toFixed(1)} m; blended max frame jump ${jump.toFixed(3)} m`)
  assert.ok(unblended > 20, `the scenario must need a real correction (${unblended} m)`)
  assert.ok(jump <= 2, `max frame jump ${jump} m`)
  const after = fr.filter((f) => f.t >= 26)
  const worst = Math.max(...after.map((f) => errM(f.s, path, f.t)))
  assert.ok(worst < 1, `back on the true path once the blend ends (${worst} m)`)
  assert.ok(after.every((f) => f.s.mode === 'interp'))
})

test('a reported velocity that contradicts the positions is replaced by the finite difference', () => {
  const path = straight(200, 90)
  const good = new Track('abc123')
  const badTrack = new Track('abc123')
  const badSpeed = new Track('abc123')
  for (const t of times(0, 20, 1)) {
    good.add(truthSample(path, t))
    badTrack.add(truthSample(path, t, { trackDeg: 120 })) // 30° off
    badSpeed.add(truthSample(path, t, { gsKt: 300 })) // 23 % slow
  }
  for (let t = 1; t < 19; t += 0.1) {
    for (const tr of [good, badTrack, badSpeed]) assert.ok(errM(tr.stateAt(T0 + t * 1000)!, path, t) < 0.5)
  }
  near(badTrack.stateAt(T0 + 10_500)!.trackDeg!, 90, 0.5)
  near(badSpeed.stateAt(T0 + 10_500)!.gsKt!, 200 / KT, 1)
})

test('the ENU origin re-centres after 100 km without disturbing the path', () => {
  const path = straight(250, 70)
  const samples = times(0, 600, 1).map((t) => truthSample(path, t)) // 150 km
  const fr = replay(new Track('abc123'), samples, { fromS: 5, toS: 600, delayS: 3 })
  const worst = Math.max(...fr.map((f) => errM(f.s, path, f.t)))
  assert.ok(worst < 1, `max error ${worst} m`)
  assert.ok(maxJumpM(enuOf(fr)) < 0.05, `max frame jump ${maxJumpM(enuOf(fr))} m`)
})

test('MLAT: gated, smoothed track renders with far lower lateral acceleration than raw positions', (t) => {
  const path = turning(200, 30, 1, 60)
  const r = rng(7)
  const samples: Sample[] = []
  const raw: PosT[] = []
  for (let ts = 0; ts <= 300; ts += 1 + 2 * r.uni()) {
    const s = truthSample(path, ts, { quality: 'mlat', version: null, altGeomFt: null, gsKt: 200 / KT + 5 * r.gauss(), trackDeg: null })
    const p = path(ts)
    const noisy = raw.length === 70 ? { e: p.e + 3000, n: p.n } : { e: p.e + 30 * r.gauss(), n: p.n + 30 * r.gauss() } // one 3 km outlier
    const g = geo(noisy.e, noisy.n)
    samples.push({ ...s, lat: g.lat, lon: g.lon })
    raw.push({ t: ts, ...noisy })
  }
  const tr = new Track('abc123')
  const fr = replay(tr, samples, { fromS: 30, toS: 280, delayS: 6 })
  assert.equal(tr.quality, 'mlat')
  assert.ok(fr.every((f) => f.s.quality === 'mlat' && f.s.rollDeg === 0))
  const rendered = latAccP99(enuOf(fr))
  const kin = velocitiesFromPositions(raw)
  const rawFrames: PosT[] = fr.map((f) => {
    let i = 0
    while (kin[i + 1].t < f.t) i++
    const h = hermite(kin[i], kin[i + 1], f.t)
    return { t: f.t, e: h.e, n: h.n }
  })
  const rawAcc = latAccP99(rawFrames)
  const posErr = pct(fr.map((f) => errM(f.s, path, f.t)), 0.95)
  const rawErr = pct(rawFrames.map((f) => { const p = path(f.t); return Math.hypot(f.e - p.e, f.n - p.n) }), 0.95)
  t.diagnostic(`lateral accel p99: rendered ${rendered.toFixed(2)} m/s², raw ${rawAcc.toFixed(2)} m/s²; position error p95: rendered ${posErr.toFixed(1)} m, raw ${rawErr.toFixed(1)} m`)
  assert.ok(rendered < rawAcc / 4, `rendered ${rendered} vs raw ${rawAcc}`)
  assert.ok(posErr < rawErr, `position error p95 ${posErr} m vs raw ${rawErr} m`)
})

test('vertical: 25 ft-quantised 3° descent renders with no step > 1 m per 60 Hz frame', (t) => {
  const vs = -140 * KT * Math.tan(rad(3)) // −3.77 m/s
  const h = (ts: number): number => 1000 + vs * ts // HAE metres
  const path = straight(140 * KT, 120)
  const r = rng(42)
  const q = (x: number, step: number): number => Math.round(x / step) * step
  const samples: Sample[] = []
  for (let ts = 0; ts <= 200; ts += 0.5 + r.uni()) {
    samples.push(truthSample(path, ts, {
      altGeomFt: q(h(ts) / FT, 25), altBaroFt: q((h(ts) - 19.6) / FT, 25),
      geomRateFpm: q((vs / FT) * 60, 64), baroRateFpm: q((vs / FT) * 60, 64),
    }))
  }
  const fr = replay(new Track('abc123'), samples, { fromS: 3.5, toS: 195, delayS: 3, latencyS: 0.3 })
  let maxStep = 0
  for (let i = 1; i < fr.length; i++) maxStep = Math.max(maxStep, Math.abs(fr[i].s.hM - fr[i - 1].s.hM))
  const late = fr.filter((f) => f.t >= 20)
  const hErr = pct(late.map((f) => Math.abs(f.s.hM - h(f.t))), 0.95)
  const vsErr = pct(late.map((f) => Math.abs((f.s.vsFpm! * FT) / 60 - vs)), 0.95)
  t.diagnostic(`max step ${maxStep.toFixed(3)} m, height error p95 ${hErr.toFixed(2)} m, VS error p95 ${vsErr.toFixed(2)} m/s`)
  assert.ok(maxStep <= 1, `max per-frame step ${maxStep} m`)
  assert.ok(hErr <= 2.5, `height error p95 ${hErr} m`)
  assert.ok(vsErr <= 2, `VS error p95 ${vsErr} m/s`)
  assert.ok(late.every((f) => f.s.altSource === 'geom' && f.s.pitchDeg < 2 && f.s.pitchDeg > -2))
})

test('heading prefers true_heading (interpolated the short way), else the track', () => {
  const path = straight(200 * KT, 90)
  const crab = new Track('abc123')
  for (const t of times(0, 10, 1)) crab.add(truthSample(path, t, { trueHeadingDeg: 100 }))
  const s = crab.stateAt(T0 + 5_500)!
  near(s.headingDeg, 100, 1e-6)
  near(s.trackDeg!, 90, 0.01)
  const plain = new Track('abc123')
  for (const t of times(0, 10, 1)) plain.add(truthSample(path, t))
  near(plain.stateAt(T0 + 5_500)!.headingDeg, 90, 0.01)
  const north = new Track('abc123')
  north.add(truthSample(path, 0, { trueHeadingDeg: 358 }))
  north.add(truthSample(path, 1, { trueHeadingDeg: 2 }))
  near(wrap180(north.stateAt(T0 + 500)!.headingDeg), 0, 1e-6)
})

test('ground aircraft: onGround, roll and pitch 0, MSL height, true heading', () => {
  const path = straight(15 * KT, 280)
  const tr = new Track('abc123')
  for (const t of times(0, 20, 1)) {
    tr.add(truthSample(path, t, { onGround: true, altBaroFt: null, altGeomFt: null, trueHeadingDeg: 281, rollDeg: 4 }))
  }
  const s = tr.stateAt(T0 + 10_000)!
  assert.equal(s.onGround, true)
  assert.equal(s.rollDeg, 0)
  assert.equal(s.pitchDeg, 0)
  assert.equal(s.hM, 19.6) // MSL 0 as HAE; consumers clamp ground aircraft to terrain
  assert.equal(s.vsFpm, 0)
  near(s.headingDeg, 281, 1e-6)
  assert.equal(s.altBaroFt, null)
})

test('landing: ground height holds the last airborne height for 60 s, then MSL; altSource keeps the last rung', () => {
  const path = straight(70, 300)
  const tr = new Track('abc123')
  for (const t of times(0, 20, 1)) tr.add(truthSample(path, t, { altGeomFt: 500 - 10 * t, altBaroFt: 400 - 10 * t }))
  for (const t of times(21, 120, 1)) tr.add(truthSample(path, t, { onGround: true, altBaroFt: null, altGeomFt: null, gsKt: 30 }))
  const air = tr.stateAt(T0 + 20_000)!
  assert.equal(air.onGround, false)
  const ground = tr.stateAt(T0 + 30_000)!
  assert.equal(ground.onGround, true)
  near(ground.hM, air.hM, 1e-9)
  assert.equal(ground.altSource, 'geom')
  assert.equal(tr.stateAt(T0 + 85_000)!.hM, 19.6)
})

test('gapP90S covers the last 60 s of gaps; delayTargetS follows quality, poll period and gaps', () => {
  const path = straight(200, 0)
  const tr = new Track('abc123')
  for (const t of [...times(0, 100, 5), ...times(101, 110, 1)]) tr.add(truthSample(path, t))
  assert.equal(tr.gapP90S(), 5)
  assert.equal(tr.delayTargetS, 6)
  for (const t of times(111, 200, 1)) tr.add(truthSample(path, t))
  assert.equal(tr.gapP90S(), 1)
  assert.equal(tr.delayTargetS, 3)
  assert.equal(tr.quality, 'adsb2')
  const slowPoll = new Track('abc123', { pollPeriodS: 4 })
  slowPoll.add(truthSample(path, 0))
  assert.equal(slowPoll.delayTargetS, 5)
  const mlat = new Track('abc123')
  mlat.add(truthSample(path, 0, { quality: 'mlat' }))
  assert.equal(mlat.delayTargetS, 6)
})

test('empty track and render times before the first sample give null', () => {
  const tr = new Track('abc123')
  assert.equal(tr.stateAt(T0), null)
  assert.equal(tr.newestTMs, null)
  assert.equal(tr.quality, 'other')
  tr.add(truthSample(straight(200, 0), 10))
  assert.equal(tr.stateAt(T0 + 9_999), null)
  const s = tr.stateAt(T0 + 10_000)!
  assert.equal(s.mode, 'interp')
  assert.equal(tr.stateAt(T0 + 12_000)!.mode, 'extrap')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/track/track.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/track/track.ts' imported from …/client/track/track.test.ts`, `ℹ tests 1`, `ℹ fail 1`

- [ ] **Step 3: Write the implementation**

```ts
// client/track/track.ts
// One aircraft's delayed-playback estimator: deduped samples in, a smooth RenderState at any render time out.
import { Deduper } from '../../shared/dedupe.ts'
import { Enu } from '../../shared/enu.ts'
import type { Quality, Sample } from '../../shared/types.ts'
import type { RenderState } from '../types.ts'
import { AttitudeSmoother, targetAttitude, turnRateDegS } from './attitude.ts'
import { p90, targetDelayS } from './delay.ts'
import { RejoinBlend, extrapolate, hermite, type HState } from './hermite.ts'
import { gateOutliers, smoothPositions, velocitiesFromPositions } from './mlat.ts'
import type { AltSource, KinPoint, PosT } from './types.ts'
import { AltitudeLadder, VerticalFilter } from './vertical.ts'

const KT = 1852 / 3600 // m/s per knot (0.514444)
const FPM = 0.3048 / 60 // m/s per ft/min
const DEG = 180 / Math.PI
const KEEP_MS = 120_000 // sample window
const GAP_WINDOW_MS = 60_000 // gapP90S() history
const EXTRAP_S = 8 // dead-reckoning cap; past it the pose freezes (mode 'stale')
const RECENTRE_M = 100_000 // move the ENU origin when the newest sample is this far from it
const GROUND_HOLD_S = 60 // on the ground, keep the last airborne height this long
const CHECK_MIN_MS = 10 // below this finite-difference speed, position noise dominates: don't judge the reported velocity
const MAX_TURN_DEGS = 6 // dead-reckoning turn-rate clamp (2× standard rate)
const R = 6_371_000 // mean Earth radius, only for the tangent-plane drop in #geo
const REJOIN_S = 1.5 // re-join blend duration (G2: re-join blended within 1.5 s)
const MLAT_REJOIN_S = 3 // MLAT revisions (every sample re-smooths the newest knots) blend over ≈ one smoothing window
const D = 1e-3 // s, forward-difference step for the on-screen velocity at a re-join

interface V { ve: number; vn: number }
interface P3 { e: number; n: number; h: number }

const wrap360 = (d: number): number => ((d % 360) + 360) % 360
const wrap180 = (d: number): number => wrap360(d + 180) - 180
const dirDeg = (v: V): number => wrap360(Math.atan2(v.ve, v.vn) * DEG)

/** The reported velocity is trusted unless the positions clearly contradict it: > 20 % in speed or > 15° in direction. */
function agrees(rep: V, fd: V): boolean {
  const vFd = Math.hypot(fd.ve, fd.vn)
  if (vFd < CHECK_MIN_MS) return true
  return Math.abs(Math.hypot(rep.ve, rep.vn) - vFd) <= 0.2 * vFd && Math.abs(wrap180(dirDeg(rep) - dirDeg(fd))) <= 15
}

/** Turn rate for dead reckoning: track change between the newest knot and the newest knot ≥ 2 s older (1 Hz jitter averages out). */
function recentTurnDegS(k: KinPoint[]): number {
  const last = k[k.length - 1]
  let i = k.length - 2
  while (i > 0 && k[i].t > last.t - 2) i--
  const ref = k[i]
  if (ref === undefined || Math.hypot(ref.ve, ref.vn) < 1 || Math.hypot(last.ve, last.vn) < 1) return 0
  const w = turnRateDegS(dirDeg(ref), dirDeg(last), last.t - ref.t)
  return Math.max(-MAX_TURN_DEGS, Math.min(MAX_TURN_DEGS, w))
}

interface Model {
  tE: number // evaluation time: render time, frozen EXTRAP_S after the last knot
  over: number // render time − last knot time, s (> 0 = extrapolating)
  hz: HState
  ci: number // current sample: the newest one at or before the render time
  hM: number
  vsMs: number | null
}

/**
 * Delayed-playback estimator for one aircraft. Times inside are seconds since the first sample.
 * Horizontal: a local ENU frame whose origin is the first sample at h = 0, moved to the newest sample only when that is
 * > 100 km away (the tangent plane then sags ≤ 0.8 km below it, handled by #geo). ADS-B knots take their velocity from
 * gs/track (true heading on the ground when track is missing), falling back to the finite difference of neighbouring
 * samples, which also vetoes a reported velocity that disagrees with it. MLAT knots go gate → smooth → differentiate.
 * Hermite between knots; constant-turn dead reckoning after the newest for ≤ 8 s, then frozen ('stale').
 * Whenever a new sample changes the estimate at the last rendered time (after extrapolating, or when MLAT smoothing
 * revises recent knots), a RejoinBlend plus a velocity bump absorb the difference, so the rendered path keeps its
 * position and velocity (C1) in all three axes.
 * Vertical: AltitudeLadder → VerticalFilter. Attitude: targetAttitude → AttitudeSmoother, stepped by render-time deltas.
 */
export class Track {
  readonly hex: string
  readonly #pollPeriodS: number
  readonly #dedupe = new Deduper()
  #samples: Sample[] = []
  #gamma: number[] = [] // per sample: bearing of local true north in the ENU frame, deg (meridian convergence)
  #knots: KinPoint[] = []
  #turnDegS = 0
  #enu: Enu | null = null
  #t0Ms = 0
  readonly #ladder = new AltitudeLadder()
  readonly #vf = new VerticalFilter()
  #altSource: AltSource = 'baro-bias' // until any rung has been seen: the least-trusted one
  #callsign: string | null = null
  #typeCode: string | null = null
  #blend = new RejoinBlend(REJOIN_S)
  #vBlend = new RejoinBlend(REJOIN_S) // vertical position error rides in its `e` component
  #bump: P3 = { e: 0, n: 0, h: 0 } // velocity error at the last re-join, m/s
  #bumpT0 = NaN
  #bumpS = REJOIN_S
  #att = new AttitudeSmoother()
  #lastT: number | null = null

  constructor(hex: string, opts: { pollPeriodS?: number } = {}) {
    this.hex = hex
    this.#pollPeriodS = opts.pollPeriodS ?? 1
  }

  /** false for another hex, a duplicate or an out-of-order sample (Deduper). */
  add(s: Sample): boolean {
    if (s.hex !== this.hex || !this.#dedupe.accept(s)) return false
    const tPrev = this.#lastT
    const was = tPrev === null ? null : [this.#pos(tPrev), this.#pos(tPrev + D)]
    const oldEnu = this.#enu
    if (this.#enu === null) {
      this.#enu = new Enu(s.lat, s.lon, 0)
      this.#t0Ms = s.tMs
    } else {
      const [e, n] = this.#enu.fwd(s.lat, s.lon, 0)
      if (Math.hypot(e, n) > RECENTRE_M) this.#enu = new Enu(s.lat, s.lon, 0)
    }
    this.#samples.push(s) // the Deduper only passes strictly newer samples, so the array stays sorted
    let drop = 0
    while (this.#samples[drop].tMs < s.tMs - KEEP_MS) drop++
    if (drop > 0) this.#samples = this.#samples.slice(drop)
    const h = this.#ladder.height(s)
    if (h !== null) {
      const rate = s.geomRateFpm !== null && h.source === 'geom' ? s.geomRateFpm : s.baroRateFpm
      this.#vf.add(this.#ts(s.tMs), h.hM, rate === null ? null : rate * FPM)
      this.#altSource = h.source
    }
    this.#callsign = s.callsign ?? this.#callsign
    this.#typeCode = s.typeCode ?? this.#typeCode
    this.#rebuild()
    if (was?.[0] && was[1] && tPrev !== null) this.#rejoin(was[0], was[1], oldEnu!, tPrev)
    return true
  }

  stateAt(tRenderMs: number): RenderState | null {
    const tS = this.#ts(tRenderMs)
    const m = this.#model(tS)
    if (m === null) return null
    const dtS = this.#lastT === null ? 0 : tS - this.#lastT
    if (dtS < 0) this.#att = new AttitudeSmoother() // render time went backwards: start the attitude afresh
    this.#lastT = tS
    const cur = this.#samples[m.ci]
    const off = this.#offset(tS)
    const g = this.#geo(m.hz.e + off.e, m.hz.n + off.n)
    const gsMs = Math.hypot(m.hz.ve, m.hz.vn)
    const trackDeg = gsMs >= 0.5 ? wrap360(dirDeg(m.hz) - this.#gamma[m.ci]) : cur.trackDeg
    const att = this.#att.step(
      targetAttitude({
        gsMs,
        vsMs: m.vsMs ?? 0,
        headingDeg: this.#trueHeading(m.ci, tS, m.tE) ?? trackDeg ?? 0,
        broadcastRollDeg: cur.rollDeg,
        turnRateDegS: turnRateDegS(dirDeg(this.#horiz(m.tE - 1)), dirDeg(m.hz), 1),
        onGround: cur.onGround,
        phase: null,
        mlat: cur.quality === 'mlat',
      }),
      Math.max(0, dtS),
    )
    return {
      hex: this.hex,
      lat: g.lat,
      lon: g.lon,
      hM: m.hM + off.h,
      headingDeg: att.headingDeg,
      pitchDeg: att.pitchDeg,
      rollDeg: att.rollDeg,
      gsKt: this.#knots.length < 2 && cur.gsKt === null ? null : gsMs / KT,
      trackDeg,
      altBaroFt: cur.altBaroFt,
      vsFpm: m.vsMs === null ? null : m.vsMs / FPM,
      mode: m.over <= 0 ? 'interp' : m.over <= EXTRAP_S ? 'extrap' : 'stale',
      altSource: this.#altSource,
      onGround: cur.onGround,
      ageS: (tRenderMs - this.#samples[this.#samples.length - 1].tMs) / 1000,
      quality: cur.quality,
      callsign: this.#callsign,
      typeCode: this.#typeCode,
    }
  }

  /** p90 of the gaps between consecutive samples whose later sample is within the last 60 s. 0 with < 2 samples. */
  gapP90S(): number {
    const ss = this.#samples
    const gaps: number[] = []
    for (let i = ss.length - 1; i > 0 && ss[ss.length - 1].tMs - ss[i].tMs <= GAP_WINDOW_MS; i--) gaps.push((ss[i].tMs - ss[i - 1].tMs) / 1000)
    return p90(gaps)
  }

  /** The newest sample's quality ('other' before any sample). It also picks the ADS-B or MLAT knot pipeline. */
  get quality(): Quality {
    return this.#samples[this.#samples.length - 1]?.quality ?? 'other'
  }

  get newestTMs(): number | null {
    return this.#samples[this.#samples.length - 1]?.tMs ?? null
  }

  get delayTargetS(): number {
    return targetDelayS(this.quality, this.#pollPeriodS, this.gapP90S())
  }

  #ts(tMs: number): number {
    return (tMs - this.#t0Ms) / 1000
  }

  /**
   * Horizontal ENU (h = 0 surface) → lat/lon. The ellipsoid under (e, n) lies ≈ d²/2R below the tangent plane.
   * ponytail: spherical sag; ≤ ~5 cm horizontal error at the 100 km re-centre radius. Upgrade: one Newton step on h.
   */
  #geo(e: number, n: number): { lat: number; lon: number } {
    return this.#enu!.inv(e, n, -(e * e + n * n) / (2 * R))
  }

  /**
   * Rebuilds every knot from the window.
   * ponytail: O(window) per sample (≈ 240 fwd() calls at 1 Hz); upgrade to incremental ADS-B knots if a busy view shows it.
   */
  #rebuild(): void {
    const enu = this.#enu!
    const ss = this.#samples
    const pts: PosT[] = ss.map((s) => {
      const [e, n] = enu.fwd(s.lat, s.lon, 0)
      return { t: this.#ts(s.tMs), e, n }
    })
    this.#gamma = ss.map((s, i) => {
      const [e, n] = enu.fwd(s.lat + 1e-4, s.lon, 0)
      return Math.atan2(e - pts[i].e, n - pts[i].n) * DEG
    })
    const fd = velocitiesFromPositions(pts) // central differences, one-sided at the ends, 0 for a lone sample
    if (this.quality === 'mlat') {
      // ponytail: the pipeline follows the newest sample's quality for the whole window; mixed windows are rare.
      const gsKt = Math.max(0, ...ss.map((s) => s.gsKt ?? 0))
      this.#knots = velocitiesFromPositions(smoothPositions(gateOutliers(pts, gsKt > 0 ? 1.5 * gsKt * KT : 360), 2))
    } else {
      this.#knots = pts.map((p, i) => ({ ...p, ...this.#reported(i, fd[i]) }))
    }
    this.#turnDegS = recentTurnDegS(this.#knots)
  }

  /** Knot velocity for ADS-B-like samples: reported gs + track (true heading on the ground), unless the positions veto it. */
  #reported(i: number, fd: V): V {
    const s = this.#samples[i]
    const dir = s.trackDeg ?? (s.onGround ? s.trueHeadingDeg : null)
    if (s.gsKt === null || dir === null) return { ve: fd.ve, vn: fd.vn }
    const a = (dir + this.#gamma[i]) / DEG
    const rep = { ve: s.gsKt * KT * Math.sin(a), vn: s.gsKt * KT * Math.cos(a) }
    return agrees(rep, fd) ? rep : { ve: fd.ve, vn: fd.vn }
  }

  #horiz(t: number): HState {
    const k = this.#knots
    const last = k[k.length - 1]
    if (t >= last.t || k.length < 2) return extrapolate(last, this.#turnDegS, Math.max(0, t - last.t))
    let i = k.length - 2
    while (i > 0 && k[i].t > t) i-- // render time sits near the newest knots: scan from the end
    return hermite(k[i], k[i + 1], t)
  }

  /** Everything position-like at render time tS, without blends. null before the first sample. */
  #model(tS: number): Model | null {
    const ss = this.#samples
    if (ss.length === 0 || tS < this.#ts(ss[0].tMs)) return null
    const lastT = this.#knots[this.#knots.length - 1].t
    const tE = Math.min(tS, lastT + EXTRAP_S)
    let ci = ss.length - 1
    while (ci > 0 && this.#ts(ss[ci].tMs) > tS) ci--
    return { tE, over: tS - lastT, hz: this.#horiz(tE), ci, ...this.#vertical(tE, ci) }
  }

  /**
   * Airborne: the filtered height. On the ground: the last airborne filtered height if it is < 60 s old, else the
   * sample's geoid N (MSL 0 as HAE). Consumers clamp ground aircraft to terrain; real touchdown handling is M4's job.
   * ponytail: no filter re-seed after a ground segment or a long airborne gap; α-β re-converges over ~10 samples.
   */
  #vertical(tE: number, ci: number): { hM: number; vsMs: number | null } {
    const ss = this.#samples
    const cur = ss[ci]
    if (!cur.onGround) return this.#vf.at(tE) ?? { hM: cur.nM, vsMs: null }
    for (let i = ci; i >= 0 && tE - this.#ts(ss[i].tMs) < GROUND_HOLD_S; i--) {
      const v = ss[i].onGround ? null : this.#vf.at(this.#ts(ss[i].tMs))
      if (v) return { hM: v.hM, vsMs: 0 }
    }
    return { hM: cur.nM, vsMs: 0 }
  }

  /** True heading when the current sample has one: interpolated the short way to the next sample, turned along while extrapolating. */
  #trueHeading(ci: number, tS: number, tE: number): number | null {
    const a = this.#samples[ci]
    if (a.trueHeadingDeg === null) return null
    const b = this.#samples[ci + 1]
    const ta = this.#ts(a.tMs)
    if (b === undefined) return a.trueHeadingDeg + this.#turnDegS * Math.max(0, tE - ta)
    if (b.trueHeadingDeg === null) return a.trueHeadingDeg
    const u = (tS - ta) / (this.#ts(b.tMs) - ta)
    return a.trueHeadingDeg + u * wrap180(b.trueHeadingDeg - a.trueHeadingDeg)
  }

  #pos(tS: number): P3 | null {
    const m = this.#model(tS)
    return m && { e: m.hz.e, n: m.hz.n, h: m.hM }
  }

  /**
   * What the re-join adds to the estimate: RejoinBlend's raised cosine carries the position error, plus a velocity
   * bump T·u(1 − u)²·errV (u = (t − t0)/T) that is 0 at both ends, has slope errV at t0 and none at the end.
   * Together the rendered path keeps its position and velocity (C1) when the estimate changes under it.
   */
  #offset(tS: number): P3 {
    const o = this.#blend.offset(tS)
    const u = (tS - this.#bumpT0) / this.#bumpS
    const b = u >= 0 && u < 1 ? this.#bumpS * u * (1 - u) ** 2 : 0
    return { e: o.e + b * this.#bump.e, n: o.n + b * this.#bump.n, h: this.#vBlend.offset(tS).e + b * this.#bump.h }
  }

  /**
   * A new sample may have moved the estimate at the last rendered time t (after extrapolating, or MLAT smoothing
   * revising recent knots). m0, m1 = the old estimate at t and t + D. Blend from what was on screen to the new estimate.
   */
  #rejoin(m0: P3, m1: P3, oldEnu: Enu, t: number): void {
    const q0 = this.#pos(t)
    const q1 = this.#pos(t + D)
    if (q0 === null || q1 === null) return
    const o0 = this.#offset(t)
    const o1 = this.#offset(t + D)
    const p0 = this.#reframe({ e: m0.e + o0.e, n: m0.n + o0.n, h: m0.h + o0.h }, oldEnu) // on screen at t
    const p1 = this.#reframe({ e: m1.e + o1.e, n: m1.n + o1.n, h: m1.h + o1.h }, oldEnu)
    const e0 = { e: p0.e - q0.e, n: p0.n - q0.n, h: p0.h - q0.h }
    const e1 = { e: p1.e - q1.e, n: p1.n - q1.n, h: p1.h - q1.h }
    // An unchanged estimate reproduces bit-exactly, so 1 µm at t and t + D (1 mm/s in velocity) means "changed".
    const same = (a: P3, b: P3): boolean => Math.hypot(a.e - b.e, a.n - b.n, a.h - b.h) <= 1e-6
    if (oldEnu === this.#enu && same(e0, o0) && same(e1, o1)) return // the running blend stays valid
    this.#bumpS = this.quality === 'mlat' ? MLAT_REJOIN_S : REJOIN_S
    this.#blend = new RejoinBlend(this.#bumpS)
    this.#blend.start(e0.e, e0.n, t)
    this.#vBlend = new RejoinBlend(this.#bumpS)
    this.#vBlend.start(e0.h, 0, t)
    this.#bump = { e: (e1.e - e0.e) / D, n: (e1.n - e0.n) / D, h: (e1.h - e0.h) / D }
    this.#bumpT0 = t
  }

  /** A point of the previous ENU frame in the current one (identity unless the origin moved). */
  #reframe(p: P3, oldEnu: Enu): P3 {
    if (oldEnu === this.#enu) return p
    const g = oldEnu.inv(p.e, p.n, -(p.e * p.e + p.n * p.n) / (2 * R))
    const [e, n] = this.#enu!.fwd(g.lat, g.lon, 0)
    return { e, n, h: p.h }
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/track/track.test.ts`
Expected: PASS — `ℹ tests 14`, `ℹ pass 14`, `ℹ fail 0`, with the diagnostics `ℹ max error 0.067 m (straight chords: 7.1 m)`, `ℹ unblended step 80.3 m; blended max frame jump 0.084 m`, `ℹ lateral accel p99: rendered 31.19 m/s², raw 196.62 m/s²; position error p95: rendered 43.2 m, raw 79.7 m` and `ℹ max step 0.091 m, height error p95 1.02 m, VS error p95 1.08 m/s`.

- [ ] **Step 5: Commit**

```bash
git add client/track/track.ts client/track/track.test.ts
git commit -m "feat(track): per-aircraft delayed-playback estimator (Hermite, dead reckoning, C1 re-join, MLAT, vertical, attitude)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: TrackRegistry

**Files:**
- Create: `client/track/registry.ts`, `client/track/registry.test.ts`
- Test: `client/track/registry.test.ts`

**Interfaces:**
- Consumes: `Track` (Task 1); `MIN_DELAY_S` (= 3, `client/track/delay.ts`, C3); `Sample` (`shared/types.ts`), `RenderState` (`client/types.ts`) from WP-00
- Produces: `class TrackRegistry { constructor(opts?: { pollPeriodS?: number }); ingest(samples: Sample[]): void; states(tRenderMs: number): RenderState[]; get(hex: string): Track | undefined; delayTargetS(hex: string | null): number; prune(serverNowMs: number, maxAgeS: number): void }`
  - `ingest` sorts a copy of the batch by `tMs`, then routes each sample to its hex's `Track` (created on first sight with the registry's `pollPeriodS`).
  - `states` = every track's non-null `stateAt(tRenderMs)`, in insertion order.
  - `delayTargetS(hex)` = that track's `delayTargetS`, or 3 s for `null` or an unknown hex.
  - `prune` deletes tracks whose `newestTMs < serverNowMs − maxAgeS·1000` (exactly `maxAgeS` old is kept).

- [ ] **Step 1: Write the failing test**

```ts
// client/track/registry.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Sample } from '../../shared/types.ts'
import { TrackRegistry } from './registry.ts'

const T0 = 1_760_000_000_000

/** Aircraft `hex` flying north at ~200 kt from (32, 34.9 + lonOffset); t in seconds. */
function s(hex: string, t: number, o: Partial<Sample> = {}): Sample {
  return {
    hex, tMs: T0 + t * 1000, rxMs: T0 + t * 1000 + 1000, lat: 32 + t * 0.001, lon: 34.9, onGround: false, altBaroFt: 5000,
    altGeomFt: 5200, gsKt: 216, trackDeg: 0, trueHeadingDeg: null, rollDeg: null, baroRateFpm: null, geomRateFpm: null,
    navQnhHpa: null, version: 2, nic: 8, quality: 'adsb2', nM: 19.6, callsign: null, typeCode: null, reg: null, ...o,
  }
}

test('ingest routes samples by hex; states() returns only renderable tracks', () => {
  const reg = new TrackRegistry()
  reg.ingest([s('aaa111', 0), s('bbb222', 0, { lon: 35 }), s('aaa111', 1), s('ccc333', 50)])
  assert.equal(reg.get('aaa111')?.newestTMs, T0 + 1000)
  assert.equal(reg.get('bbb222')?.newestTMs, T0)
  assert.equal(reg.get('zzz999'), undefined)
  const st = reg.states(T0 + 500) // ccc333's first sample is still in the future
  assert.deepEqual(st.map((x) => x.hex).sort(), ['aaa111', 'bbb222'])
  assert.equal(st.find((x) => x.hex === 'aaa111')!.mode, 'interp')
})

test('ingest sorts a batch by time, so an out-of-order response is not lost to the deduper', () => {
  const reg = new TrackRegistry()
  reg.ingest([s('aaa111', 2), s('aaa111', 0), s('aaa111', 1)])
  assert.equal(reg.get('aaa111')!.gapP90S(), 1)
  reg.ingest([s('aaa111', 2)]) // re-served
  assert.equal(reg.get('aaa111')!.newestTMs, T0 + 2000)
})

test('delayTargetS: the track target, else the 3 s default', () => {
  const reg = new TrackRegistry({ pollPeriodS: 1 })
  reg.ingest([0, 1, 2, 3].map((t) => s('aaa111', t, { quality: 'mlat' })))
  reg.ingest([0, 5, 10, 15].map((t) => s('bbb222', t)))
  assert.equal(reg.delayTargetS('aaa111'), 6) // MLAT floor
  assert.equal(reg.delayTargetS('bbb222'), 6) // p90 gap 5 s + 1
  assert.equal(reg.delayTargetS('zzz999'), 3)
  assert.equal(reg.delayTargetS(null), 3)
  const slow = new TrackRegistry({ pollPeriodS: 5 })
  slow.ingest([s('aaa111', 0)])
  assert.equal(slow.delayTargetS('aaa111'), 6) // poll period 5 s + 1
})

test('prune drops tracks whose newest sample is older than maxAgeS', () => {
  const reg = new TrackRegistry()
  reg.ingest([s('aaa111', 0), s('bbb222', 50)])
  reg.prune(T0 + 60_000, 30)
  assert.equal(reg.get('aaa111'), undefined)
  assert.ok(reg.get('bbb222'))
  reg.prune(T0 + 80_000, 30)
  assert.ok(reg.get('bbb222'), 'exactly maxAgeS old is kept')
  reg.prune(T0 + 80_001, 30)
  assert.equal(reg.get('bbb222'), undefined)
  assert.deepEqual(reg.states(T0 + 50_000), [])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/track/registry.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/track/registry.ts' imported from …/client/track/registry.test.ts`, `ℹ tests 1`, `ℹ fail 1`

- [ ] **Step 3: Write the implementation**

```ts
// client/track/registry.ts
// All tracks the client knows, keyed by hex. The app feeds poll responses in and draws states() each frame.
import type { Sample } from '../../shared/types.ts'
import type { RenderState } from '../types.ts'
import { MIN_DELAY_S } from './delay.ts'
import { Track } from './track.ts'

export class TrackRegistry {
  readonly #tracks = new Map<string, Track>()
  readonly #pollPeriodS: number | undefined

  constructor(opts: { pollPeriodS?: number } = {}) {
    this.#pollPeriodS = opts.pollPeriodS
  }

  /** Routes each sample to its hex's Track (created on first sight). The batch is taken in time order. */
  ingest(samples: Sample[]): void {
    for (const s of [...samples].sort((a, b) => a.tMs - b.tMs)) {
      let t = this.#tracks.get(s.hex)
      if (t === undefined) this.#tracks.set(s.hex, (t = new Track(s.hex, { pollPeriodS: this.#pollPeriodS })))
      t.add(s)
    }
  }

  /** One RenderState per track that has something to draw at tRenderMs. */
  states(tRenderMs: number): RenderState[] {
    const out: RenderState[] = []
    for (const t of this.#tracks.values()) {
      const s = t.stateAt(tRenderMs)
      if (s !== null) out.push(s)
    }
    return out
  }

  get(hex: string): Track | undefined {
    return this.#tracks.get(hex)
  }

  /** The chased track's target playback delay; 3 s when nothing (or nothing known) is chased. */
  delayTargetS(hex: string | null): number {
    const t = hex === null ? undefined : this.#tracks.get(hex)
    return t === undefined ? MIN_DELAY_S : t.delayTargetS
  }

  /** Forgets tracks whose newest sample is more than maxAgeS older than serverNowMs. */
  prune(serverNowMs: number, maxAgeS: number): void {
    for (const [hex, t] of this.#tracks) {
      if ((t.newestTMs ?? -Infinity) < serverNowMs - maxAgeS * 1000) this.#tracks.delete(hex)
    }
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/track/registry.test.ts`
Expected: PASS — `ℹ tests 4`, `ℹ pass 4`, `ℹ fail 0`

- [ ] **Step 5: Commit**

```bash
git add client/track/registry.ts client/track/registry.test.ts
git commit -m "feat(track): TrackRegistry routes samples by hex, serves states, delay target and prune" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: WP gate

- [ ] **Step 1: Run every test this package owns**

Run: `node --test client/track/track.test.ts client/track/registry.test.ts`
Expected: `ℹ tests 18`, `ℹ pass 18`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/track/(track|registry)'`
Expected: no output (grep exits 1). On a branch where every merged package is complete, `npm run check` must also pass.

- [ ] **Step 3: Confirm everything is committed and record the gate**

```bash
git status --short -- client/track
git commit --allow-empty -m "chore(track): WP-I2 gate passed (18 tests, tsc clean)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `git status` prints nothing before the commit. The branch `wp/I2` is ready to merge.

---

## Notes for A2 (client app) and A3 (bench)

- **Per frame, in this order:** `registry.ingest(newSamples)` for any poll response that arrived, then `tRenderMs = clock.tick(api.serverNowMs(), registry.delayTargetS(selectedHex), dtS)` (C3 `RenderClock`), then `registry.states(tRenderMs)`. A re-join blend is anchored at the last rendered time, so ingesting between two frames is what makes corrections continuous. Calling `registry.get(hex)!.stateAt(t)` again with the same `t` in the same frame is harmless (the attitude smoother steps by 0).
- **Pass the real poll period:** `new TrackRegistry({ pollPeriodS: 1 })` for the 1 Hz chase poll. The registry sorts each batch, but samples older than a track's newest are still dropped by the deduper, so feed batches in arrival order.
- **Prune** every few seconds, e.g. `registry.prune(api.serverNowMs(), 60)`.
- **Null is normal:** the chased hex returns null before its first sample and after a gap longer than the 120 s window (the window then holds only the new sample, so the aircraft disappears for about the delay and reappears at its new position). Keep the camera where it was.
- **`mode === 'stale'`** means the data stopped more than 8 s ago; the pose is frozen. When data resumes after a long gap, the re-join slides from the frozen pose to the new estimate over 1.5 s; in the real day-1 recording, one 67 s gap put that slide at 13.6 km. It stays continuous, but you may prefer to cut the camera when the re-join is that large.
- **`ageS` is negative while interpolating** (render time is behind the newest sample by about the delay minus the latency); it turns positive only when extrapolating or stale.
- **G2 (A3):** measure frames from `states()` at 60 Hz with the causal loop above. With σ = 30 m synthetic MLAT noise, the rendered lateral-acceleration p99 is 31 m/s², far above the 0.5 g MLAT bar. The floor without re-join effects (all samples known) is 18 m/s², set by `smoothPositions` halfWindow 2, which the I2 spec fixes. If real MLAT fails the bar, raise the half-window (the `2` passed to `smoothPositions` in `Track#rebuild`) or drop MLAT chase (the VERDICT's conditional-go).

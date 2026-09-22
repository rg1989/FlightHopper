# WP-C1 — ENU Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exact WGS84 conversions between geodetic coordinates (latitude, longitude, ellipsoidal height), Earth-centred Earth-fixed (ECEF) and a local east-north-up (ENU) tangent frame, with less than 1 mm round-trip error, so the track estimator, the bench and the metrics can work in metres.

**Architecture:** One pure module, `shared/enu.ts`, with no dependencies. It is in `shared/` because the client (I2 `Track`) and the tools (A3 bench → T2 metrics `Frame.e/n/u`) both import it. `geodeticToEcef` is the closed-form WGS84 formula. `ecefToGeodetic` iterates latitude with a fixed-point step: 5 passes, and each pass shrinks the error by about e² ≈ 0.0067. It gets height from `p·cos φ + z·sin φ − a·√(1 − e² sin² φ)`, which stays exact at the poles. `Enu` caches the origin's ECEF position and the sines and cosines of its rotation. `fwd` rotates an ECEF difference into `[e, n, u]`, and `inv` applies the transpose and converts back to geodetic. Conventions that consumers rely on:
- e points east, n points north, u points along the ellipsoid normal at the origin. Units are metres.
- The public API takes and returns degrees. Radians are used only inside.
- `ecefToGeodetic` and `Enu.inv` return longitude in [−180, 180].
- Heights are WGS84 ellipsoidal metres (HAE). This module never applies the geoid. Callers add `Sample.nM` first (`h = H + N`).

**Tech Stack:** Node ≥ 24.2 (native TypeScript), `node:test`, TypeScript 7 (type-check only). At runtime the module uses only `Math`. The tests also import `destination` from `shared/geo.ts` (WP-00) to place points up to 200 km away.

**Wave:** 1 (parallel; depends only on WP-00). **Estimated:** 45 min. **Validated:** every file below was run on 2026-09-22 in the shared Wave 1 sandbox (WP-00 files + installed `node_modules`). `node --test shared/enu.test.ts` gave 13/13 pass. `npx tsc --noEmit` reported no errors in `shared/enu*`. Task 1's intermediate files were type-checked and run in isolation (6/6 pass). A denser probe, not committed, used a 0.5° latitude × 15° longitude grid with h ∈ {−500, 0, 5000, 12000} m. It measured a worst geodetic → ECEF → geodetic error of 3.9 nm (ECEF distance) and 2.8 nm (height). The two reference values in the test come from CesiumJS 1.145 in Node (`Cartesian3.fromDegrees` and `Transforms.eastNorthUpToFixedFrame`, WGS84 b = 6356752.3142451793 in `@cesium/engine/Source/Core/Ellipsoid.js`). They were computed once, so the test does not import Cesium.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- Erasable TypeScript only (`#private` fields are plain JavaScript, so they are allowed). Relative imports have a `.ts` extension.
- Heights are WGS84 ellipsoidal metres (HAE). The geoid is the caller's job (`shared/geoid.ts`).
- This package creates or edits only the two files below.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `shared/enu.ts` | `WGS84_A`, `WGS84_F`, `geodeticToEcef`, `ecefToGeodetic`, `class Enu` |
| `shared/enu.test.ts` | known points, independent Cesium reference values, round-trip bounds |

---

### Task 1: WGS84 geodetic ↔ ECEF

**Files:**
- Create: `shared/enu.ts`, `shared/enu.test.ts`
- Test: `shared/enu.test.ts`

**Interfaces:**
- Consumes: nothing from other packages. The WGS84 defining constants are a = 6378137 m and 1/f = 298.257223563.
- Produces: `geodeticToEcef(latDeg: number, lonDeg: number, hM: number): [number, number, number]` · `ecefToGeodetic(x: number, y: number, z: number): { lat: number; lon: number; h: number }` (degrees, degrees, metres) · extra exports `WGS84_A`, `WGS84_F`

- [ ] **Step 1: Write the failing test**

```ts
// shared/enu.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ecefToGeodetic, geodeticToEcef, WGS84_A, WGS84_F } from './enu.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)
const dist = (p: number[], q: number[]): number => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])

test('WGS84 defining constants', () => {
  assert.equal(WGS84_A, 6378137)
  assert.equal(WGS84_F, 1 / 298.257223563)
})

test('ECEF of (0, 0, 0) is (a, 0, 0)', () => {
  assert.deepEqual(geodeticToEcef(0, 0, 0), [6378137, 0, 0])
})

test('north pole is (0, 0, b) with b = a(1 − f)', () => {
  const [x, y, z] = geodeticToEcef(90, 0, 0)
  near(x, 0, 1e-6)
  near(y, 0, 1e-6)
  near(z, 6356752.314245179, 1e-6)
})

test('matches an independent implementation (Cesium 1.145 Cartesian3.fromDegrees) at KSFO', () => {
  const p = geodeticToEcef(37.613538, -122.35716, 1234.5)
  assert.ok(dist(p, [-2707928.6898289714, -4274073.204684137, 3872307.2839324432]) < 1e-3, `${p}`)
})

test('geodetic → ECEF → geodetic round-trips < 1 mm for h in [−500, 12000] m, poles included', () => {
  let worst = 0
  for (let lat = -90; lat <= 90; lat += 7.5) {
    for (let lon = -180; lon <= 180; lon += 30) {
      for (const h of [-500, 0, 1234.5, 12000]) {
        const p = geodeticToEcef(lat, lon, h)
        const g = ecefToGeodetic(p[0], p[1], p[2])
        near(g.h, h, 1e-3, `h at ${lat},${lon},${h}`)
        near(g.lat, lat, 1e-9, `lat at ${lat},${lon},${h}`)
        worst = Math.max(worst, dist(geodeticToEcef(g.lat, g.lon, g.h), p))
      }
    }
  }
  assert.ok(worst < 1e-3, `worst ECEF round-trip error ${worst} m`)
})

test('ecefToGeodetic returns degrees and longitude in [−180, 180]', () => {
  const g = ecefToGeodetic(0, -6378137, 0)
  near(g.lat, 0, 1e-12)
  near(g.lon, -90, 1e-12)
  near(g.h, 0, 1e-6)
  const s = ecefToGeodetic(0, 0, -6356752.314245179 - 100)
  near(s.lat, -90, 1e-12)
  near(s.h, 100, 1e-6)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test shared/enu.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/shared/enu.ts' imported from …/shared/enu.test.ts`

- [ ] **Step 3: Write the implementation**

```ts
// shared/enu.ts
// Exact WGS84 geodetic ↔ ECEF. Degrees in and out, metres of ellipsoidal height (HAE).
// Spherical shortcuts for distances and bearings live in shared/geo.ts.

export const WGS84_A = 6378137
export const WGS84_F = 1 / 298.257223563
const E2 = WGS84_F * (2 - WGS84_F) // first eccentricity squared

const rad = (d: number): number => (d * Math.PI) / 180
const deg = (r: number): number => (r * 180) / Math.PI

export function geodeticToEcef(latDeg: number, lonDeg: number, hM: number): [number, number, number] {
  const φ = rad(latDeg)
  const λ = rad(lonDeg)
  const sφ = Math.sin(φ)
  const cφ = Math.cos(φ)
  const n = WGS84_A / Math.sqrt(1 - E2 * sφ * sφ) // prime-vertical radius of curvature
  return [(n + hM) * cφ * Math.cos(λ), (n + hM) * cφ * Math.sin(λ), (n * (1 - E2) + hM) * sφ]
}

/**
 * Fixed-point iteration on latitude; each pass shrinks the error by ≈ e² (0.0067), so 5 passes reach
 * double precision for any point within tens of km of the surface. Height uses the form that stays
 * exact at the poles (no division by cos φ).
 * ponytail: not valid near the Earth's centre (|h| ≳ 1000 km below surface); upgrade to Vermeille (2011) closed form if ever needed.
 */
export function ecefToGeodetic(x: number, y: number, z: number): { lat: number; lon: number; h: number } {
  const p = Math.hypot(x, y)
  let φ = Math.atan2(z, p * (1 - E2))
  for (let i = 0; i < 5; i++) {
    const sφ = Math.sin(φ)
    φ = Math.atan2(z + (E2 * WGS84_A * sφ) / Math.sqrt(1 - E2 * sφ * sφ), p)
  }
  const sφ = Math.sin(φ)
  const h = p * Math.cos(φ) + z * sφ - WGS84_A * Math.sqrt(1 - E2 * sφ * sφ)
  return { lat: deg(φ), lon: deg(Math.atan2(y, x)), h }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test shared/enu.test.ts`
Expected: PASS — `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add shared/enu.ts shared/enu.test.ts
git commit -m "feat(shared): exact WGS84 geodetic/ECEF conversion"
```

---

### Task 2: Local ENU frame

**Files:**
- Modify: `shared/enu.ts`, `shared/enu.test.ts` (the complete final content of both files is below)
- Test: `shared/enu.test.ts`

**Interfaces:**
- Consumes: `geodeticToEcef`, `ecefToGeodetic` (Task 1); `destination(lat: number, lon: number, brgDeg: number, distNm: number): { lat: number; lon: number }` from `shared/geo.ts` (WP-00, test only)
- Produces: `class Enu { constructor(lat0: number, lon0: number, h0: number); fwd(lat: number, lon: number, h: number): [number, number, number]; inv(e: number, n: number, u: number): { lat: number; lon: number; h: number } }`, where `fwd` returns `[e, n, u]` in metres

- [ ] **Step 1: Write the failing test** (it replaces the whole file: Task 1's tests stay, and the `Enu` tests are added. The "1 km north" point is 1000 m of meridian arc, Δφ = 1000 / (M + h). The expected u ≈ −d²/2M ≈ −0.0786 m at KSFO.)

```ts
// shared/enu.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { destination } from './geo.ts'
import { ecefToGeodetic, Enu, geodeticToEcef, WGS84_A, WGS84_F } from './enu.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)
const dist = (p: number[], q: number[]): number => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
const ecefOf = (g: { lat: number; lon: number; h: number }): number[] => geodeticToEcef(g.lat, g.lon, g.h)

test('WGS84 defining constants', () => {
  assert.equal(WGS84_A, 6378137)
  assert.equal(WGS84_F, 1 / 298.257223563)
})

test('ECEF of (0, 0, 0) is (a, 0, 0)', () => {
  assert.deepEqual(geodeticToEcef(0, 0, 0), [6378137, 0, 0])
})

test('north pole is (0, 0, b) with b = a(1 − f)', () => {
  const [x, y, z] = geodeticToEcef(90, 0, 0)
  near(x, 0, 1e-6)
  near(y, 0, 1e-6)
  near(z, 6356752.314245179, 1e-6)
})

test('matches an independent implementation (Cesium 1.145 Cartesian3.fromDegrees) at KSFO', () => {
  const p = geodeticToEcef(37.613538, -122.35716, 1234.5)
  assert.ok(dist(p, [-2707928.6898289714, -4274073.204684137, 3872307.2839324432]) < 1e-3, `${p}`)
})

test('geodetic → ECEF → geodetic round-trips < 1 mm for h in [−500, 12000] m, poles included', () => {
  let worst = 0
  for (let lat = -90; lat <= 90; lat += 7.5) {
    for (let lon = -180; lon <= 180; lon += 30) {
      for (const h of [-500, 0, 1234.5, 12000]) {
        const p = geodeticToEcef(lat, lon, h)
        const g = ecefToGeodetic(p[0], p[1], p[2])
        near(g.h, h, 1e-3, `h at ${lat},${lon},${h}`)
        near(g.lat, lat, 1e-9, `lat at ${lat},${lon},${h}`)
        worst = Math.max(worst, dist(ecefOf(g), p))
      }
    }
  }
  assert.ok(worst < 1e-3, `worst ECEF round-trip error ${worst} m`)
})

test('ecefToGeodetic returns degrees and longitude in [−180, 180]', () => {
  const g = ecefToGeodetic(0, -6378137, 0)
  near(g.lat, 0, 1e-12)
  near(g.lon, -90, 1e-12)
  near(g.h, 0, 1e-6)
  const s = ecefToGeodetic(0, 0, -6356752.314245179 - 100)
  near(s.lat, -90, 1e-12)
  near(s.h, 100, 1e-6)
})

// Meridian (M) and prime-vertical (N) radii of curvature, for building "1 km north / east" test points.
const E2 = WGS84_F * (2 - WGS84_F)
const radii = (latDeg: number): { m: number; n: number } => {
  const s = Math.sin((latDeg * Math.PI) / 180)
  const w = 1 - E2 * s * s
  return { m: (WGS84_A * (1 - E2)) / w ** 1.5, n: WGS84_A / Math.sqrt(w) }
}

const KSFO = { lat: 37.613538, lon: -122.35716, h: 4 }

test('the origin maps to (0, 0, 0)', () => {
  const [e, n, u] = new Enu(KSFO.lat, KSFO.lon, KSFO.h).fwd(KSFO.lat, KSFO.lon, KSFO.h)
  near(e, 0, 1e-9)
  near(n, 0, 1e-9)
  near(u, 0, 1e-9)
})

test('1 km north along the meridian at the same h ≈ (0, 1000, −0.078): u drops by d²/2M', () => {
  const enu = new Enu(KSFO.lat, KSFO.lon, KSFO.h)
  const dLatDeg = (1000 / (radii(KSFO.lat).m + KSFO.h)) * (180 / Math.PI)
  const [e, n, u] = enu.fwd(KSFO.lat + dLatDeg, KSFO.lon, KSFO.h)
  near(e, 0, 1e-6)
  near(n, 1000, 0.01)
  near(u, -0.078, 0.002)
})

test('1 km east along the parallel at the same h ≈ (1000, +0.06, −0.078): east is +e, the parallel bends north', () => {
  const enu = new Enu(KSFO.lat, KSFO.lon, KSFO.h)
  const cosLat = Math.cos((KSFO.lat * Math.PI) / 180)
  const dLonDeg = (1000 / ((radii(KSFO.lat).n + KSFO.h) * cosLat)) * (180 / Math.PI)
  const [e, n, u] = enu.fwd(KSFO.lat, KSFO.lon + dLonDeg, KSFO.h)
  near(e, 1000, 0.01)
  near(n, 0.06, 0.002)
  near(u, -0.078, 0.002)
})

test('up is up: same lat/lon, 500 m higher → (0, 0, 500)', () => {
  const [e, n, u] = new Enu(KSFO.lat, KSFO.lon, KSFO.h).fwd(KSFO.lat, KSFO.lon, KSFO.h + 500)
  near(e, 0, 1e-6)
  near(n, 0, 1e-6)
  near(u, 500, 1e-6)
})

test('matches an independent implementation (Cesium 1.145 eastNorthUpToFixedFrame) near LLBG', () => {
  const enu = new Enu(32.0114, 34.8867, 40)
  const p = enu.fwd(32.2, 35.1, 3000)
  assert.ok(dist(p, [20120.917477197945, 20943.292132342234, 2893.805459712632]) < 1e-3, `${p}`)
})

const ORIGINS = [
  { name: 'KSFO', lat: 37.613538, lon: -122.35716, h: 4 },
  { name: 'LLBG', lat: 32.0114, lon: 34.8867, h: 40 },
  { name: 'LOWI', lat: 47.2588, lon: 11.3309, h: 580 },
  { name: 'near pole', lat: 89.5, lon: 0, h: 0 },
  { name: 'antimeridian', lat: 0, lon: 179.9, h: 0 },
]

test('Enu fwd → inv round-trips < 1 mm within 200 km, h in [−500, 12000] m', () => {
  let worst = 0
  for (const o of ORIGINS) {
    const enu = new Enu(o.lat, o.lon, o.h)
    for (let brg = 0; brg < 360; brg += 30) {
      for (const dNm of [0, 0.5, 27, 108]) {  // 108 nm ≈ 200 km
        for (const h of [-500, 0, 12000]) {
          const q = destination(o.lat, o.lon, brg, dNm)
          const [e, n, u] = enu.fwd(q.lat, q.lon, h)
          const g = enu.inv(e, n, u)
          near(g.h, h, 1e-3, `${o.name} brg ${brg} d ${dNm} h ${h}`)
          worst = Math.max(worst, dist(ecefOf(g), geodeticToEcef(q.lat, q.lon, h)))
        }
      }
    }
  }
  assert.ok(worst < 1e-3, `worst fwd→inv error ${worst} m`)
})

test('Enu inv → fwd round-trips < 1 mm over ±200 km, u in [−500, 12000] m', () => {
  let worst = 0
  for (const o of ORIGINS) {
    const enu = new Enu(o.lat, o.lon, o.h)
    for (let e = -200e3; e <= 200e3; e += 50e3) {
      for (let n = -200e3; n <= 200e3; n += 50e3) {
        for (const u of [-500, 0, 12000]) {
          const g = enu.inv(e, n, u)
          worst = Math.max(worst, dist(enu.fwd(g.lat, g.lon, g.h), [e, n, u]))
        }
      }
    }
  }
  assert.ok(worst < 1e-3, `worst inv→fwd error ${worst} m`)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test shared/enu.test.ts`
Expected: FAIL — `SyntaxError: The requested module './enu.ts' does not provide an export named 'Enu'`

- [ ] **Step 3: Write the implementation** (complete final file)

```ts
// shared/enu.ts
// Exact WGS84 geodetic ↔ ECEF ↔ local east-north-up. Degrees in and out, metres of ellipsoidal height (HAE).
// Spherical shortcuts for distances and bearings live in shared/geo.ts.

export const WGS84_A = 6378137
export const WGS84_F = 1 / 298.257223563
const E2 = WGS84_F * (2 - WGS84_F) // first eccentricity squared

const rad = (d: number): number => (d * Math.PI) / 180
const deg = (r: number): number => (r * 180) / Math.PI

export function geodeticToEcef(latDeg: number, lonDeg: number, hM: number): [number, number, number] {
  const φ = rad(latDeg)
  const λ = rad(lonDeg)
  const sφ = Math.sin(φ)
  const cφ = Math.cos(φ)
  const n = WGS84_A / Math.sqrt(1 - E2 * sφ * sφ) // prime-vertical radius of curvature
  return [(n + hM) * cφ * Math.cos(λ), (n + hM) * cφ * Math.sin(λ), (n * (1 - E2) + hM) * sφ]
}

/**
 * Fixed-point iteration on latitude; each pass shrinks the error by ≈ e² (0.0067), so 5 passes reach
 * double precision for any point within tens of km of the surface. Height uses the form that stays
 * exact at the poles (no division by cos φ).
 * ponytail: not valid near the Earth's centre (|h| ≳ 1000 km below surface); upgrade to Vermeille (2011) closed form if ever needed.
 */
export function ecefToGeodetic(x: number, y: number, z: number): { lat: number; lon: number; h: number } {
  const p = Math.hypot(x, y)
  let φ = Math.atan2(z, p * (1 - E2))
  for (let i = 0; i < 5; i++) {
    const sφ = Math.sin(φ)
    φ = Math.atan2(z + (E2 * WGS84_A * sφ) / Math.sqrt(1 - E2 * sφ * sφ), p)
  }
  const sφ = Math.sin(φ)
  const h = p * Math.cos(φ) + z * sφ - WGS84_A * Math.sqrt(1 - E2 * sφ * sφ)
  return { lat: deg(φ), lon: deg(Math.atan2(y, x)), h }
}

/** Local tangent frame at (lat0, lon0, h0): e east, n north, u along the ellipsoid normal. Metres. */
export class Enu {
  readonly #o: [number, number, number]
  readonly #sφ: number
  readonly #cφ: number
  readonly #sλ: number
  readonly #cλ: number

  constructor(lat0: number, lon0: number, h0: number) {
    this.#o = geodeticToEcef(lat0, lon0, h0)
    this.#sφ = Math.sin(rad(lat0))
    this.#cφ = Math.cos(rad(lat0))
    this.#sλ = Math.sin(rad(lon0))
    this.#cλ = Math.cos(rad(lon0))
  }

  fwd(lat: number, lon: number, h: number): [number, number, number] {
    const [x, y, z] = geodeticToEcef(lat, lon, h)
    const dx = x - this.#o[0]
    const dy = y - this.#o[1]
    const dz = z - this.#o[2]
    const t = this.#cλ * dx + this.#sλ * dy
    return [-this.#sλ * dx + this.#cλ * dy, -this.#sφ * t + this.#cφ * dz, this.#cφ * t + this.#sφ * dz]
  }

  inv(e: number, n: number, u: number): { lat: number; lon: number; h: number } {
    const t = -this.#sφ * n + this.#cφ * u
    return ecefToGeodetic(
      this.#o[0] - this.#sλ * e + this.#cλ * t,
      this.#o[1] + this.#cλ * e + this.#sλ * t,
      this.#o[2] + this.#cφ * n + this.#sφ * u,
    )
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test shared/enu.test.ts`
Expected: PASS — `ℹ tests 13`, `ℹ pass 13`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add shared/enu.ts shared/enu.test.ts
git commit -m "feat(shared): local ENU tangent frame (Enu fwd/inv)"
```

---

### Task 3: WP gate

- [ ] **Step 1: This package's tests**

Run: `node --test shared/enu.test.ts`
Expected: `ℹ tests 13`, `ℹ pass 13`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'shared/enu'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Full check in the worktree**

Run: `npm run check`
Expected: `tsc` prints nothing. On a worktree branched from `wave-0` the counts are `ℹ tests 54`, `ℹ pass 54`, `ℹ fail 0` (41 from WP-00 + 13 here).

- [ ] **Step 4: Confirm there is nothing left to commit**

Run: `git status --short`
Expected: no output.

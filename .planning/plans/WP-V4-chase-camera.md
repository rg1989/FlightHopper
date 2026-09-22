# WP-V4 — Chase Camera Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third-person camera locked behind one aircraft: it follows the aircraft's heading with exponential damping, looks slightly down on it, and never goes below 15 m above the loaded terrain, so the chase can follow an aircraft down a valley to the runway.

**Architecture:** One module, `client/scene/chaseCamera.ts`.
- `chaseOffsetEnu(headingDeg, pitchDeg, rangeM)` is pure. It returns the camera position relative to the target in the target's east-north-up frame, with the same convention as Cesium's `lookAt(target, HeadingPitchRange)`: the camera looks along `headingDeg`, so it sits behind the nose direction; `pitchDeg` is the camera's look angle, negative = looking down, so it sits above. `e = −r·cos p·sin h`, `n = −r·cos p·cos h`, `u = −r·sin p`. A test checks this against the position Cesium's own `Camera` takes.
- `ChaseCamera.update(state, dtS)`:
  1. Heading: the first frame snaps to `state.headingDeg`. After that, exponential smoothing `k = 1 − exp(−dtS / headingTauS)` along the shorter arc (wrap-safe through north).
  2. Placement: target = `Cartesian3.fromDegrees(lon, lat, hM)`; `camera.lookAtTransform(Transforms.eastNorthUpToFixedFrame(target), HeadingPitchRange(heading, pitch, range))`.
  3. Clearance: `camera.positionCartographic.height − scene.globe.getHeight(camera.positionCartographic)`. `undefined` (tile not loaded) → `null`, and no correction.
  4. If clearance < `minClearanceM`: up to 4 passes. Pitching from p to p′ raises the camera by `range·(sin p − sin p′)`, so each pass solves for the missing metres, aiming at min + 0.5 m. If even −89° is not enough, it first goes to −89° and measures again (the terrain under the camera changes as it moves). If it is still short, the aircraft is under the terrain model (DEM or datum error), so the target point is raised by the missing metres.
  5. Returns `{ clearanceM }` measured after the last placement.
- `release()`: `camera.lookAtTransform(Matrix4.IDENTITY)` and forget the smoothed heading, so the next chase snaps.
- The target `Cartesian3`, frame `Matrix4` and `HeadingPitchRange` are reused every frame.
- Defaults: `rangeM` 150, `pitchDeg` −12, `minClearanceM` 15, `headingTauS` 1.0.

Conventions consumers (A2, V8) rely on: `clearanceM === null` means the terrain under the camera is not loaded yet; count it as unknown, not as a violation. Call `release()` before giving the camera back to the user. Cesium's `ScreenSpaceCameraController` stays enabled; a user drag is overwritten on the next `update()`.

**Tech Stack:** CesiumJS 1.145 (`Camera.lookAtTransform`, `Transforms.eastNorthUpToFixedFrame`, `HeadingPitchRange`, `Globe.getHeight`), `node:test`. The Node tests drive a **real** Cesium `Camera` on a minimal fake scene (canvas and drawing-buffer size, `GeographicProjection`, `SceneMode.SCENE3D`, WGS84, zoom limits, and a `globe.getHeight` backed by a terrain function). The harness uses Re:Earth terrain, `https://terrain.reearth.land/cesium-mesh/ellipsoid` (keyless quantized-mesh with WGS84 ellipsoidal heights; required credit `Re:Earth Terrain · Mapterhorn (CC BY 4.0)`; source: https://terrain.reearth.land/).

**Wave:** 1 (parallel; depends only on WP-00). Consumed by A2 (drives it) and V8 (records `clearanceM`). **Estimated:** 1.5 h. **Validated:** on 2026-09-22 in the shared Wave 1 sandbox (WP-00 files + installed `node_modules`, Node 25.2.1, TypeScript 7.0.2): `node --test client/scene/chaseCamera.test.ts` → 14/14 pass; `npx tsc --noEmit` reports no errors in `client/scene/chaseCamera*` or `harness/chase-camera*`. Every task was replayed in an isolated copy holding only WP-00's type files and this package's files: Task 1 failed then passed 2/2, Task 2 failed then passed 14/14, and a full `tsc --noEmit` was clean. Mutations: with the clearance loop disabled, 3 tests fail; an earlier version that lifted the target in the same pass as it clamped the pitch failed the no-overshoot test (camera 446 m from the aircraft instead of 150 m). The harness ran in Chrome through Vite over Re:Earth terrain at LOWI from `?t=385` (the bottom of the descent, hM ≈ 890 → 710 m HAE): about 2,500 chased frames (the bottom of the descent, then the loop restarting at 3,200 m), minimum clearance 15.0 m, 0 frames below 15 m, 6 frames `null` while the first tiles loaded; the pitch went from −12° to −65°…−89° with a lift where the synthetic circle crosses the Natters plateau. `R` released the camera (transform = identity). `?terrain=ellipsoid` also ran with no console errors.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- This package creates or edits only the four files below. It reads WP-00's `client/types.ts`.
- Heights are WGS84 ellipsoidal metres (HAE): `RenderState.hM` and `Globe.getHeight` (ellipsoidal terrain, per PLAN.md §1) are compared directly.
- Unit tests need no WebGL and no network. Only the harness page loads terrain tiles.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `client/scene/chaseCamera.ts` | `chaseOffsetEnu`, `ChaseCameraOpts`, `class ChaseCamera` |
| `client/scene/chaseCamera.test.ts` | offset convention vs Cesium, damping, clearance cases, release |
| `harness/chase-camera.html`, `harness/chase-camera.ts` | manual check: descending circle over LOWI on Re:Earth terrain, clearance overlay |

---

### Task 1: Chase offset

**Files:**
- Create: `client/scene/chaseCamera.ts`, `client/scene/chaseCamera.test.ts`
- Test: `client/scene/chaseCamera.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `chaseOffsetEnu(headingDeg: number, pitchDeg: number, rangeM: number): [number, number, number]` (`[e, n, u]` metres)

- [ ] **Step 1: Write the failing test**

```ts
// client/scene/chaseCamera.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chaseOffsetEnu } from './chaseCamera.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)
const DEG = 180 / Math.PI

test('chaseOffsetEnu: heading 0 → camera due south of the target, above it when looking down', () => {
  const [e, n, u] = chaseOffsetEnu(0, -12, 150)
  near(e, 0, 1e-9)
  assert.ok(n < 0)
  assert.ok(u > 0)
  near(Math.hypot(e, n, u), 150, 1e-9)
  near(u, 150 * Math.sin(12 / DEG), 1e-9)
})

test('chaseOffsetEnu: heading 90 → west; heading 225 → north-east', () => {
  const [e, n] = chaseOffsetEnu(90, -12, 150)
  assert.ok(e < 0)
  near(n, 0, 1e-9)
  const [e2, n2, u2] = chaseOffsetEnu(225, -30, 100)
  assert.ok(e2 > 0 && n2 > 0)
  near(e2, n2, 1e-9)
  near(u2, 50, 1e-9)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/scene/chaseCamera.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/scene/chaseCamera.ts' imported from …/client/scene/chaseCamera.test.ts`

- [ ] **Step 3: Write the implementation**

```ts
// client/scene/chaseCamera.ts
const RAD = Math.PI / 180

/**
 * Camera position relative to the target, in the target's local east-north-up frame (metres).
 * Same convention as Cesium's lookAt(HeadingPitchRange): the camera looks along headingDeg, so it sits behind
 * the nose direction; pitchDeg is the camera's look angle, negative = looking down, so it sits above.
 */
export function chaseOffsetEnu(headingDeg: number, pitchDeg: number, rangeM: number): [number, number, number] {
  const h = headingDeg * RAD
  const p = pitchDeg * RAD
  const horizontal = rangeM * Math.cos(p)
  return [-horizontal * Math.sin(h), -horizontal * Math.cos(h), -rangeM * Math.sin(p)]
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/scene/chaseCamera.test.ts`
Expected: PASS — `ℹ tests 2`, `ℹ pass 2`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add client/scene/chaseCamera.ts client/scene/chaseCamera.test.ts
git commit -m "feat(scene): chase camera offset in the target ENU frame"
```

---

### Task 2: ChaseCamera

**Files:**
- Modify: `client/scene/chaseCamera.ts`, `client/scene/chaseCamera.test.ts`
- Test: `client/scene/chaseCamera.test.ts`

**Interfaces:**
- Consumes: `RenderState` (`client/types.ts`, WP-00), `chaseOffsetEnu` (Task 1, used by the tests as the reference); Cesium `Viewer`
- Produces: `interface ChaseCameraOpts { rangeM?: number; pitchDeg?: number; minClearanceM?: number; headingTauS?: number }` · `class ChaseCamera { constructor(viewer: Viewer, opts?: ChaseCameraOpts); update(state: RenderState, dtS: number): { clearanceM: number | null }; release(): void }` (PLAN.md §4 V4, exactly)

- [ ] **Step 1: Write the failing test** (replace the whole file)

```ts
// client/scene/chaseCamera.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Camera, Cartesian3, Cartographic, Ellipsoid, GeographicProjection, MapMode2D, Matrix4, SceneMode } from 'cesium'
import type { Viewer } from 'cesium'
import type { RenderState } from '../types.ts'
import { chaseOffsetEnu, ChaseCamera } from './chaseCamera.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)
const DEG = 180 / Math.PI

type Terrain = (c: Cartographic) => number | undefined

/** A real Cesium Camera on the smallest scene its constructor and lookAtTransform read; the globe answers from `terrain`. */
function fakeViewer(terrain: Terrain) {
  const scene = {
    canvas: { clientWidth: 800, clientHeight: 600 },
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    mapProjection: new GeographicProjection(),
    mode: SceneMode.SCENE3D,
    mapMode2D: MapMode2D.INFINITE_SCROLL,
    ellipsoid: Ellipsoid.WGS84,
    screenSpaceCameraController: { minimumZoomDistance: 1, maximumZoomDistance: Number.POSITIVE_INFINITY },
    globe: { ellipsoid: Ellipsoid.WGS84, getHeight: (c: Cartographic) => terrain(c) },
  }
  const camera = new Camera(scene as never)
  return { camera, viewer: { scene, camera } as unknown as Viewer }
}

const LOWI = { lat: 47.2602, lon: 11.3439 }
const st = (o: Partial<RenderState> = {}): RenderState => ({
  hex: '4b1805', lat: LOWI.lat, lon: LOWI.lon, hM: 1000, headingDeg: 0, pitchDeg: -3, rollDeg: 0,
  gsKt: 140, trackDeg: 0, altBaroFt: 3100, vsFpm: -700, mode: 'interp', altSource: 'geom',
  onGround: false, ageS: 1, quality: 'adsb2', callsign: 'AUA905', typeCode: 'A320', ...o,
})

/** Metres south of LOWI (positive = south), for terrain that rises behind a northbound aircraft. */
const southM = (c: Cartographic): number => (LOWI.lat - c.latitude * DEG) * 111_200
/** Camera heading as seen from its offset in the target frame: the camera looks from its position towards the target. */
const lookHeadingDeg = (cam: Camera): number => ((Math.atan2(-cam.position.x, -cam.position.y) * DEG) + 360) % 360
const clearanceOf = (cam: Camera, terrain: Terrain): number => cam.positionCartographic.height - (terrain(cam.positionCartographic) as number)

test('chaseOffsetEnu: heading 0 → camera due south of the target, above it when looking down', () => {
  const [e, n, u] = chaseOffsetEnu(0, -12, 150)
  near(e, 0, 1e-9)
  assert.ok(n < 0)
  assert.ok(u > 0)
  near(Math.hypot(e, n, u), 150, 1e-9)
  near(u, 150 * Math.sin(12 / DEG), 1e-9)
})

test('chaseOffsetEnu: heading 90 → west; heading 225 → north-east', () => {
  const [e, n] = chaseOffsetEnu(90, -12, 150)
  assert.ok(e < 0)
  near(n, 0, 1e-9)
  const [e2, n2, u2] = chaseOffsetEnu(225, -30, 100)
  assert.ok(e2 > 0 && n2 > 0)
  near(e2, n2, 1e-9)
  near(u2, 50, 1e-9)
})

test('the camera Cesium places matches chaseOffsetEnu (same convention as HeadingPitchRange)', () => {
  const { camera, viewer } = fakeViewer(() => 0)
  for (const h of [0, 37, 90, 181, 300]) {
    const cc = new ChaseCamera(viewer, { rangeM: 120, pitchDeg: -15 })
    cc.update(st({ headingDeg: h }), 0.016)
    const [e, n, u] = chaseOffsetEnu(h, -15, 120)
    near(camera.position.x, e, 1e-6, `e @ ${h}`)
    near(camera.position.y, n, 1e-6, `n @ ${h}`)
    near(camera.position.z, u, 1e-6, `u @ ${h}`)
  }
})

test('update: camera behind and above the aircraft; clearance = camera height − terrain height', () => {
  const { camera, viewer } = fakeViewer(() => 0)
  const cc = new ChaseCamera(viewer)
  const { clearanceM } = cc.update(st({ hM: 1000 }), 0.016)
  const c = camera.positionCartographic
  assert.ok(c.latitude * DEG < LOWI.lat, 'south of a northbound aircraft')
  near(c.longitude * DEG, LOWI.lon, 1e-9)
  assert.ok(c.height > 1000)
  assert.equal(clearanceM, c.height)
})

test('defaults: range 150 m, pitch −12°, heading follows the aircraft on the first frame', () => {
  const { camera, viewer } = fakeViewer(() => 0)
  new ChaseCamera(viewer).update(st({ headingDeg: 123 }), 0.016)
  near(Math.hypot(camera.position.x, camera.position.y, camera.position.z), 150, 1e-6)
  near(camera.position.z, 150 * Math.sin(12 / DEG), 1e-6)
  near(lookHeadingDeg(camera), 123, 1e-6)
})

test('heading is damped exponentially (tau 1 s) and wraps through north, not the long way round', () => {
  const { camera, viewer } = fakeViewer(() => 0)
  const cc = new ChaseCamera(viewer)
  cc.update(st({ headingDeg: 350 }), 0.016)
  cc.update(st({ headingDeg: 10 }), 1.0)
  near(lookHeadingDeg(camera), (350 + 20 * (1 - Math.exp(-1))) % 360, 1e-6)
  cc.update(st({ headingDeg: 10 }), 0)
  near(lookHeadingDeg(camera), (350 + 20 * (1 - Math.exp(-1))) % 360, 1e-6, 'dt 0 changes nothing')
  for (let i = 0; i < 100; i++) cc.update(st({ headingDeg: 10 }), 0.1)
  near(lookHeadingDeg(camera), 10, 0.01)
})

test('headingTauS option: a slower camera turns less in the same time', () => {
  const a = fakeViewer(() => 0)
  const b = fakeViewer(() => 0)
  const fast = new ChaseCamera(a.viewer)
  const slow = new ChaseCamera(b.viewer, { headingTauS: 4 })
  for (const cc of [fast, slow]) cc.update(st({ headingDeg: 0 }), 0.016)
  fast.update(st({ headingDeg: 90 }), 0.5)
  slow.update(st({ headingDeg: 90 }), 0.5)
  near(lookHeadingDeg(b.camera), 90 * (1 - Math.exp(-0.5 / 4)), 1e-6)
  assert.ok(lookHeadingDeg(a.camera) > lookHeadingDeg(b.camera))
})

test('low over flat ground: pitches down just enough to stay ≥ 15 m above terrain', () => {
  const terrain: Terrain = () => 990 // the aircraft is 10 m above the runway
  const { camera, viewer } = fakeViewer(terrain)
  const { clearanceM } = new ChaseCamera(viewer, { pitchDeg: 0 }).update(st({ hM: 1000 }), 0.016)
  assert.ok(clearanceM !== null && clearanceM >= 15 && clearanceM < 17, `${clearanceM}`)
  near(clearanceOf(camera, terrain), clearanceM as number, 1e-9)
  assert.ok(camera.position.z > 0, 'now looking down')
})

test('no correction when already clear', () => {
  const { camera, viewer } = fakeViewer(() => 0)
  new ChaseCamera(viewer, { pitchDeg: -12 }).update(st({ hM: 1000 }), 0.016)
  near(camera.position.z, 150 * Math.sin(12 / DEG), 1e-6)
})

test('terrain rising behind the aircraft (valley approach): camera ends ≥ 15 m above the terrain under it', () => {
  for (const slope of [0.3, 1.0, 3.0]) {
    const terrain: Terrain = (c) => 990 + slope * Math.max(0, southM(c))
    const { camera, viewer } = fakeViewer(terrain)
    const { clearanceM } = new ChaseCamera(viewer).update(st({ hM: 1000 }), 0.016)
    assert.ok(clearanceM !== null && clearanceM >= 15, `slope ${slope}: ${clearanceM}`)
    near(clearanceOf(camera, terrain), clearanceM as number, 1e-9)
  }
})

test('a cliff behind: going straight above is enough, so the camera stays at range (no lift overshoot)', () => {
  const terrain: Terrain = (c) => 990 + 3.0 * Math.max(0, southM(c))
  const { camera, viewer } = fakeViewer(terrain)
  const { clearanceM } = new ChaseCamera(viewer).update(st({ hM: 1000 }), 0.016)
  assert.ok(clearanceM !== null && clearanceM >= 15, `${clearanceM}`)
  near(Cartesian3.distance(camera.positionWC, Cartesian3.fromDegrees(LOWI.lon, LOWI.lat, 1000)), 150, 1e-3)
})

test('aircraft below the terrain model (datum/DEM error): camera goes straight above and is lifted just clear', () => {
  const terrain: Terrain = () => 1200
  const { camera, viewer } = fakeViewer(terrain)
  const { clearanceM } = new ChaseCamera(viewer).update(st({ hM: 1000 }), 0.016)
  assert.ok(clearanceM !== null && clearanceM >= 15 && clearanceM < 16, `${clearanceM}`)
  near(clearanceOf(camera, terrain), clearanceM as number, 1e-9)
})

test('terrain not loaded under the camera: clearance null, no correction', () => {
  const { camera, viewer } = fakeViewer(() => undefined)
  const { clearanceM } = new ChaseCamera(viewer, { pitchDeg: 0 }).update(st({ hM: 1000 }), 0.016)
  assert.equal(clearanceM, null)
  near(camera.position.z, 0, 1e-6)
})

test('release hands the camera back (identity transform) and the next chase starts from the new heading', () => {
  const { camera, viewer } = fakeViewer(() => 0)
  const cc = new ChaseCamera(viewer)
  cc.update(st({ headingDeg: 0 }), 0.016)
  assert.ok(!Matrix4.equals(camera.transform, Matrix4.IDENTITY))
  cc.release()
  assert.ok(Matrix4.equals(camera.transform, Matrix4.IDENTITY))
  cc.update(st({ headingDeg: 200 }), 0.016)
  near(lookHeadingDeg(camera), 200, 1e-6)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/scene/chaseCamera.test.ts`
Expected: FAIL — `SyntaxError: The requested module './chaseCamera.ts' does not provide an export named 'ChaseCamera'`

- [ ] **Step 3: Write the implementation** (replace the whole file)

```ts
// client/scene/chaseCamera.ts
import { Cartesian3, Ellipsoid, HeadingPitchRange, Matrix4, Transforms } from 'cesium'
import type { Camera, Globe, Viewer } from 'cesium'
import type { RenderState } from '../types.ts'

const RAD = Math.PI / 180
const STEEPEST_DEG = -89 // looking straight down makes lookAt's heading degenerate
const AIM_ABOVE_MIN_M = 0.5 // correct to min + 0.5 m so float noise never reads as a violation
const CLEARANCE_PASSES = 4 // terrain under the camera changes as it moves; 4 re-measures settle real slopes

/**
 * Camera position relative to the target, in the target's local east-north-up frame (metres).
 * Same convention as Cesium's lookAt(HeadingPitchRange): the camera looks along headingDeg, so it sits behind
 * the nose direction; pitchDeg is the camera's look angle, negative = looking down, so it sits above.
 */
export function chaseOffsetEnu(headingDeg: number, pitchDeg: number, rangeM: number): [number, number, number] {
  const h = headingDeg * RAD
  const p = pitchDeg * RAD
  const horizontal = rangeM * Math.cos(p)
  return [-horizontal * Math.sin(h), -horizontal * Math.cos(h), -rangeM * Math.sin(p)]
}

export interface ChaseCameraOpts {
  rangeM?: number
  pitchDeg?: number
  minClearanceM?: number
  headingTauS?: number
}

/** Third-person camera locked behind one aircraft, heading-damped, kept ≥ minClearanceM above the loaded terrain. */
export class ChaseCamera {
  #camera: Camera
  #globe: Globe
  #rangeM: number
  #pitchDeg: number
  #minClearanceM: number
  #tauS: number
  #headingDeg: number | null = null
  #target = new Cartesian3()
  #frame = new Matrix4()
  #hpr = new HeadingPitchRange()

  constructor(viewer: Viewer, opts: ChaseCameraOpts = {}) {
    this.#camera = viewer.camera
    this.#globe = viewer.scene.globe
    this.#rangeM = opts.rangeM ?? 150
    this.#pitchDeg = opts.pitchDeg ?? -12
    this.#minClearanceM = opts.minClearanceM ?? 15
    this.#tauS = opts.headingTauS ?? 1.0
  }

  update(state: RenderState, dtS: number): { clearanceM: number | null } {
    const heading = this.#smoothHeading(state.headingDeg, dtS)
    let pitch = this.#pitchDeg
    let liftM = 0
    let clearance = this.#place(state, heading, pitch, liftM)
    // ponytail: the correction is recomputed every frame, not smoothed. Ceiling: a cliff under the camera snaps the pitch;
    // upgrade: low-pass the correction with the heading tau.
    for (let i = 0; i < CLEARANCE_PASSES && clearance !== null && clearance < this.#minClearanceM; i++) {
      // Pitching from p to p' raises the camera by range·(sin p − sin p'), so solve for the missing metres.
      const needM = this.#minClearanceM + AIM_ABOVE_MIN_M - clearance
      const sinP = Math.sin(pitch * RAD) - needM / this.#rangeM
      if (sinP >= Math.sin(STEEPEST_DEG * RAD)) pitch = Math.asin(sinP) / RAD
      else if (pitch > STEEPEST_DEG) pitch = STEEPEST_DEG // go (almost) straight above first, then measure again
      else liftM += needM // already above: the aircraft is under the terrain model, so raise the whole rig
      clearance = this.#place(state, heading, pitch, liftM)
    }
    return { clearanceM: clearance }
  }

  release(): void {
    this.#camera.lookAtTransform(Matrix4.IDENTITY)
    this.#headingDeg = null
  }

  /** Exponential smoothing towards the aircraft heading along the shorter way round; the first frame snaps. */
  #smoothHeading(targetDeg: number, dtS: number): number {
    if (this.#headingDeg === null) return (this.#headingDeg = wrap360(targetDeg))
    const k = this.#tauS > 0 ? 1 - Math.exp(-Math.max(0, dtS) / this.#tauS) : 1
    const delta = wrap360(targetDeg - this.#headingDeg + 180) - 180
    return (this.#headingDeg = wrap360(this.#headingDeg + k * delta))
  }

  /** Put the camera on the target's ENU frame; returns camera height − terrain height, null while that tile is not loaded. */
  #place(state: RenderState, headingDeg: number, pitchDeg: number, liftM: number): number | null {
    Cartesian3.fromDegrees(state.lon, state.lat, state.hM + liftM, Ellipsoid.WGS84, this.#target)
    Transforms.eastNorthUpToFixedFrame(this.#target, Ellipsoid.WGS84, this.#frame)
    this.#hpr.heading = headingDeg * RAD
    this.#hpr.pitch = pitchDeg * RAD
    this.#hpr.range = this.#rangeM
    this.#camera.lookAtTransform(this.#frame, this.#hpr)
    const c = this.#camera.positionCartographic
    const terrain = this.#globe.getHeight(c) ?? null
    return terrain === null ? null : c.height - terrain
  }
}

const wrap360 = (deg: number): number => ((deg % 360) + 360) % 360
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/scene/chaseCamera.test.ts`
Expected: PASS — `ℹ tests 14`, `ℹ pass 14`, `ℹ fail 0`.

- [ ] **Step 5: Type-check this file**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/chaseCamera'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 6: Commit**

```bash
git add client/scene/chaseCamera.ts client/scene/chaseCamera.test.ts
git commit -m "feat(scene): damped chase camera with terrain clearance"
```

---

### Task 3: Harness page

**Files:**
- Create: `harness/chase-camera.html`, `harness/chase-camera.ts`

**Interfaces:**
- Consumes: `ChaseCamera` (Task 2), `RenderState` (`client/types.ts`); the Vite setup from WP-00 Task 10; Re:Earth terrain `https://terrain.reearth.land/cesium-mesh/ellipsoid` (keyless)
- Produces: the page `/harness/chase-camera.html` (`?t=<s>` start offset, `?terrain=ellipsoid` forces the fallback) and, for console checks, `window.harness = { viewer, chase, stats, stateAt, terrain }`

- [ ] **Step 1: Write the page**

```html
<!-- harness/chase-camera.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Harness: chase camera</title>
    <style>
      html, body, #globe { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
      #info { position: absolute; top: 8px; left: 8px; padding: 6px 10px; font: 13px/1.5 ui-monospace, monospace; color: #fff; background: rgba(0, 0, 0, 0.65); border-radius: 4px; white-space: pre; pointer-events: none; }
    </style>
  </head>
  <body>
    <div id="globe"></div>
    <div id="info"></div>
    <script type="module" src="/harness/chase-camera.ts"></script>
  </body>
</html>
```

```ts
// harness/chase-camera.ts
// Manual check for WP-V4: a synthetic aircraft flies a descending 2.5 km circle over LOWI (Innsbruck, Inn valley)
// and the chase camera follows it over Re:Earth terrain (keyless; ?terrain=ellipsoid forces the fallback).
// The overlay shows clearance (camera height − terrain height) and counts frames below 15 m. Press R to release / re-chase.
// ?t=380 starts 380 s into the loop (hM ≈ 920 m HAE, near the bottom), where the clearance logic works hardest.
import { Cartesian3, CesiumTerrainProvider, Color, Credit, EllipsoidTerrainProvider, JulianDate, PointPrimitiveCollection, Viewer } from 'cesium'
import type { TerrainProvider } from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import type { RenderState } from '../client/types.ts'
import { ChaseCamera } from '../client/scene/chaseCamera.ts'

const LOWI = { lat: 47.2602, lon: 11.3439 }
const REEARTH_URL = 'https://terrain.reearth.land/cesium-mesh/ellipsoid' // WGS84 ellipsoidal heights, as the scene needs
const REEARTH_CREDIT = 'Re:Earth Terrain · Mapterhorn (CC BY 4.0)'
const RADIUS_M = 2500
const SPEED_MS = 70
const TOP_M = 3200
const SINK_MS = 6
const LOOP_S = 415 // 3200 m → 710 m HAE (about 80 m above the valley floor at LOWI), then start over
const M_PER_DEG = 111_320

async function loadTerrain(): Promise<{ provider: TerrainProvider; name: string }> {
  if (new URLSearchParams(location.search).get('terrain') === 'ellipsoid') return { provider: new EllipsoidTerrainProvider(), name: 'ellipsoid' }
  try {
    const provider = await CesiumTerrainProvider.fromUrl(REEARTH_URL, { requestVertexNormals: true, credit: new Credit(REEARTH_CREDIT) })
    return { provider, name: 'reearth' }
  } catch (err) {
    console.warn('Re:Earth terrain unavailable; falling back to the ellipsoid', err)
    return { provider: new EllipsoidTerrainProvider(), name: 'ellipsoid (Re:Earth failed)' }
  }
}

/** Counter-clockwise descending circle centred on LOWI. */
function stateAt(tS: number): RenderState {
  const t = tS % LOOP_S
  const th = (SPEED_MS / RADIUS_M) * t
  const e = RADIUS_M * Math.cos(th)
  const n = RADIUS_M * Math.sin(th)
  const headingDeg = ((Math.atan2(-Math.sin(th), Math.cos(th)) * 180) / Math.PI + 360) % 360
  return {
    hex: '440abc',
    lat: LOWI.lat + n / M_PER_DEG,
    lon: LOWI.lon + e / (M_PER_DEG * Math.cos((LOWI.lat * Math.PI) / 180)),
    hM: TOP_M - SINK_MS * t,
    headingDeg,
    pitchDeg: (Math.atan2(-SINK_MS, SPEED_MS) * 180) / Math.PI,
    rollDeg: 0,
    gsKt: SPEED_MS / 0.514444,
    trackDeg: headingDeg,
    altBaroFt: (TOP_M - 48 - SINK_MS * t) / 0.3048,
    vsFpm: (-SINK_MS / 0.3048) * 60,
    mode: 'interp',
    altSource: 'geom',
    onGround: false,
    ageS: 1,
    quality: 'adsb2',
    callsign: 'HOP1',
    typeCode: 'A320',
  }
}

async function main(): Promise<void> {
  const terrain = await loadTerrain()
  const t0S = Number(new URLSearchParams(location.search).get('t') ?? 0) - performance.now() / 1000
  const viewer = new Viewer('globe', {
    terrainProvider: terrain.provider,
    baseLayer: false,
    baseLayerPicker: false,
    geocoder: false,
    timeline: false,
    animation: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
  })
  // No imagery here: sun shading on a neutral base colour makes the relief readable.
  viewer.scene.globe.baseColor = Color.fromCssColorString('#8d927f')
  viewer.scene.globe.enableLighting = true
  viewer.scene.globe.depthTestAgainstTerrain = true
  viewer.clock.currentTime = JulianDate.fromIso8601('2026-06-21T10:30:00Z')
  viewer.clock.shouldAnimate = false

  const marker = viewer.scene.primitives.add(new PointPrimitiveCollection()).add({ pixelSize: 10, color: Color.RED, outlineColor: Color.WHITE, outlineWidth: 2 })
  const chase = new ChaseCamera(viewer)
  const stats = { frames: 0, violations: 0, unknown: 0, minClearanceM: Number.POSITIVE_INFINITY, lastClearanceM: null as number | null }
  let chasing = true
  let last = performance.now()
  const info = document.getElementById('info') as HTMLElement

  viewer.scene.preUpdate.addEventListener(() => {
    const now = performance.now()
    const dtS = Math.min(0.1, (now - last) / 1000)
    last = now
    const s = stateAt(t0S + now / 1000)
    marker.position = Cartesian3.fromDegrees(s.lon, s.lat, s.hM)
    if (chasing) {
      const { clearanceM } = chase.update(s, dtS)
      stats.frames++
      stats.lastClearanceM = clearanceM
      if (clearanceM === null) stats.unknown++
      else {
        stats.minClearanceM = Math.min(stats.minClearanceM, clearanceM)
        if (clearanceM < 15) stats.violations++
      }
    }
    info.textContent = [
      `terrain    ${terrain.name}`,
      `aircraft   hM ${s.hM.toFixed(0)} m  hdg ${s.headingDeg.toFixed(0)}°`,
      `clearance  ${stats.lastClearanceM === null ? 'terrain not loaded' : `${stats.lastClearanceM.toFixed(1)} m`}`,
      `min        ${Number.isFinite(stats.minClearanceM) ? `${stats.minClearanceM.toFixed(1)} m` : '—'}`,
      `frames     ${stats.frames}  < 15 m: ${stats.violations}  unknown: ${stats.unknown}`,
      `R          ${chasing ? 'release camera' : 'chase again'}`,
    ].join('\n')
  })

  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'r' && ev.key !== 'R') return
    chasing = !chasing
    if (!chasing) chase.release()
  })

  ;(window as unknown as { harness: object }).harness = { viewer, chase, stats, stateAt, terrain: terrain.name }
}

void main()
```

- [ ] **Step 2: Type-check the page**

Run: `npx tsc --noEmit 2>&1 | grep -E 'harness/chase-camera'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Look at it**

Run: `npm run dev -- --port 5173`, open `http://localhost:5173/harness/chase-camera.html?t=385`.
Expected: shaded grey-green relief of the Inn valley (no imagery) with a red dot 150 m ahead of the camera; the credit `Re:Earth Terrain · Mapterhorn (CC BY 4.0)` is under "Data attribution". The overlay shows `terrain reearth`, the aircraft's `hM` falling 6 m/s, `clearance` in metres (`terrain not loaded` only for the first few frames), `min` ≥ 15.0 m and `< 15 m: 0`. Near the bottom the camera tilts steeply down instead of entering the hillside. Press `R`: the camera is released (mouse navigation works, the overlay says `chase again`); press `R` again to re-chase. Then open `?terrain=ellipsoid`: `terrain ellipsoid`, clearance ≈ hM + 31 m. The console has no errors. Stop the server.

- [ ] **Step 4: Commit**

```bash
git add harness/chase-camera.html harness/chase-camera.ts
git commit -m "test(scene): chase camera harness page (descending circle over LOWI)"
```

---

### Task 4: Mouse orbit and zoom (user feedback, 2026-09-22)

In the preview, a chased aircraft could not be looked around. `update()` re-applied a fixed "150 m behind, 12° down" view every frame, so mouse input was overwritten. This task hands angle and distance to the user: **drag** orbits (relative to the aircraft's nose, so the view turns with it), **wheel** zooms (25 m – 3 km), **double-click** resets to behind. While chasing, Cesium's globe controls are disabled; `release()` (Esc) restores them. The clearance rule still wins: the camera stays ≥ 15 m above terrain whatever the user asks for.

**Files:**
- Modify: `client/scene/chaseCamera.ts` (complete new version below)
- Test: `client/scene/chaseCamera.test.ts` (complete new version below)

**Interfaces:**
- Consumes: Cesium `ScreenSpaceEventHandler`, `ScreenSpaceEventType` (LEFT_DOWN, LEFT_UP, MOUSE_MOVE, WHEEL, LEFT_DOUBLE_CLICK), `scene.screenSpaceCameraController.enableInputs`.
- Produces: `class OrbitControl { constructor(pitchDeg: number, rangeM: number); headingOffsetDeg: number; pitchDeg: number; rangeM: number; drag(dxPx: number, dyPx: number): void; wheel(delta: number): void; reset(): void }` and `ChaseCamera.orbit: OrbitControl` (readonly). Drag convention as three.js OrbitControls: the aircraft follows the mouse (drag right → heading offset +0.3°/px; drag down → pitch −0.25°/px, clamped −89…+10°). Wheel: `range ×= exp(−delta·0.0015)`, clamped 25–3000 m. `release()` resets the heading offset but keeps zoom and pitch. Input attaches on the first chased frame and only when `scene.canvas` has `addEventListener` (so node tests run without a DOM).

- [ ] **Step 1: Write the failing tests** (four new tests at the end; the rest of the file is unchanged)

```ts
// client/scene/chaseCamera.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Camera, Cartesian3, Cartographic, Ellipsoid, GeographicProjection, MapMode2D, Matrix4, SceneMode } from 'cesium'
import type { Viewer } from 'cesium'
import type { RenderState } from '../types.ts'
import { chaseOffsetEnu, ChaseCamera, OrbitControl } from './chaseCamera.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)
const DEG = 180 / Math.PI

type Terrain = (c: Cartographic) => number | undefined

/** A real Cesium Camera on the smallest scene its constructor and lookAtTransform read; the globe answers from `terrain`. */
function fakeViewer(terrain: Terrain) {
  const scene = {
    canvas: { clientWidth: 800, clientHeight: 600 },
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    mapProjection: new GeographicProjection(),
    mode: SceneMode.SCENE3D,
    mapMode2D: MapMode2D.INFINITE_SCROLL,
    ellipsoid: Ellipsoid.WGS84,
    screenSpaceCameraController: { minimumZoomDistance: 1, maximumZoomDistance: Number.POSITIVE_INFINITY },
    globe: { ellipsoid: Ellipsoid.WGS84, getHeight: (c: Cartographic) => terrain(c) },
  }
  const camera = new Camera(scene as never)
  return { camera, viewer: { scene, camera } as unknown as Viewer }
}

const LOWI = { lat: 47.2602, lon: 11.3439 }
const st = (o: Partial<RenderState> = {}): RenderState => ({
  hex: '4b1805', lat: LOWI.lat, lon: LOWI.lon, hM: 1000, headingDeg: 0, pitchDeg: -3, rollDeg: 0,
  gsKt: 140, trackDeg: 0, altBaroFt: 3100, vsFpm: -700, mode: 'interp', altSource: 'geom',
  onGround: false, ageS: 1, quality: 'adsb2', callsign: 'AUA905', typeCode: 'A320', ...o,
})

/** Metres south of LOWI (positive = south), for terrain that rises behind a northbound aircraft. */
const southM = (c: Cartographic): number => (LOWI.lat - c.latitude * DEG) * 111_200
/** Camera heading as seen from its offset in the target frame: the camera looks from its position towards the target. */
const lookHeadingDeg = (cam: Camera): number => ((Math.atan2(-cam.position.x, -cam.position.y) * DEG) + 360) % 360
const clearanceOf = (cam: Camera, terrain: Terrain): number => cam.positionCartographic.height - (terrain(cam.positionCartographic) as number)

test('chaseOffsetEnu: heading 0 → camera due south of the target, above it when looking down', () => {
  const [e, n, u] = chaseOffsetEnu(0, -12, 150)
  near(e, 0, 1e-9)
  assert.ok(n < 0)
  assert.ok(u > 0)
  near(Math.hypot(e, n, u), 150, 1e-9)
  near(u, 150 * Math.sin(12 / DEG), 1e-9)
})

test('chaseOffsetEnu: heading 90 → west; heading 225 → north-east', () => {
  const [e, n] = chaseOffsetEnu(90, -12, 150)
  assert.ok(e < 0)
  near(n, 0, 1e-9)
  const [e2, n2, u2] = chaseOffsetEnu(225, -30, 100)
  assert.ok(e2 > 0 && n2 > 0)
  near(e2, n2, 1e-9)
  near(u2, 50, 1e-9)
})

test('the camera Cesium places matches chaseOffsetEnu (same convention as HeadingPitchRange)', () => {
  const { camera, viewer } = fakeViewer(() => 0)
  for (const h of [0, 37, 90, 181, 300]) {
    const cc = new ChaseCamera(viewer, { rangeM: 120, pitchDeg: -15 })
    cc.update(st({ headingDeg: h }), 0.016)
    const [e, n, u] = chaseOffsetEnu(h, -15, 120)
    near(camera.position.x, e, 1e-6, `e @ ${h}`)
    near(camera.position.y, n, 1e-6, `n @ ${h}`)
    near(camera.position.z, u, 1e-6, `u @ ${h}`)
  }
})

test('update: camera behind and above the aircraft; clearance = camera height − terrain height', () => {
  const { camera, viewer } = fakeViewer(() => 0)
  const cc = new ChaseCamera(viewer)
  const { clearanceM } = cc.update(st({ hM: 1000 }), 0.016)
  const c = camera.positionCartographic
  assert.ok(c.latitude * DEG < LOWI.lat, 'south of a northbound aircraft')
  near(c.longitude * DEG, LOWI.lon, 1e-9)
  assert.ok(c.height > 1000)
  assert.equal(clearanceM, c.height)
})

test('defaults: range 150 m, pitch −12°, heading follows the aircraft on the first frame', () => {
  const { camera, viewer } = fakeViewer(() => 0)
  new ChaseCamera(viewer).update(st({ headingDeg: 123 }), 0.016)
  near(Math.hypot(camera.position.x, camera.position.y, camera.position.z), 150, 1e-6)
  near(camera.position.z, 150 * Math.sin(12 / DEG), 1e-6)
  near(lookHeadingDeg(camera), 123, 1e-6)
})

test('heading is damped exponentially (tau 1 s) and wraps through north, not the long way round', () => {
  const { camera, viewer } = fakeViewer(() => 0)
  const cc = new ChaseCamera(viewer)
  cc.update(st({ headingDeg: 350 }), 0.016)
  cc.update(st({ headingDeg: 10 }), 1.0)
  near(lookHeadingDeg(camera), (350 + 20 * (1 - Math.exp(-1))) % 360, 1e-6)
  cc.update(st({ headingDeg: 10 }), 0)
  near(lookHeadingDeg(camera), (350 + 20 * (1 - Math.exp(-1))) % 360, 1e-6, 'dt 0 changes nothing')
  for (let i = 0; i < 100; i++) cc.update(st({ headingDeg: 10 }), 0.1)
  near(lookHeadingDeg(camera), 10, 0.01)
})

test('headingTauS option: a slower camera turns less in the same time', () => {
  const a = fakeViewer(() => 0)
  const b = fakeViewer(() => 0)
  const fast = new ChaseCamera(a.viewer)
  const slow = new ChaseCamera(b.viewer, { headingTauS: 4 })
  for (const cc of [fast, slow]) cc.update(st({ headingDeg: 0 }), 0.016)
  fast.update(st({ headingDeg: 90 }), 0.5)
  slow.update(st({ headingDeg: 90 }), 0.5)
  near(lookHeadingDeg(b.camera), 90 * (1 - Math.exp(-0.5 / 4)), 1e-6)
  assert.ok(lookHeadingDeg(a.camera) > lookHeadingDeg(b.camera))
})

test('low over flat ground: pitches down just enough to stay ≥ 15 m above terrain', () => {
  const terrain: Terrain = () => 990 // the aircraft is 10 m above the runway
  const { camera, viewer } = fakeViewer(terrain)
  const { clearanceM } = new ChaseCamera(viewer, { pitchDeg: 0 }).update(st({ hM: 1000 }), 0.016)
  assert.ok(clearanceM !== null && clearanceM >= 15 && clearanceM < 17, `${clearanceM}`)
  near(clearanceOf(camera, terrain), clearanceM as number, 1e-9)
  assert.ok(camera.position.z > 0, 'now looking down')
})

test('no correction when already clear', () => {
  const { camera, viewer } = fakeViewer(() => 0)
  new ChaseCamera(viewer, { pitchDeg: -12 }).update(st({ hM: 1000 }), 0.016)
  near(camera.position.z, 150 * Math.sin(12 / DEG), 1e-6)
})

test('terrain rising behind the aircraft (valley approach): camera ends ≥ 15 m above the terrain under it', () => {
  for (const slope of [0.3, 1.0, 3.0]) {
    const terrain: Terrain = (c) => 990 + slope * Math.max(0, southM(c))
    const { camera, viewer } = fakeViewer(terrain)
    const { clearanceM } = new ChaseCamera(viewer).update(st({ hM: 1000 }), 0.016)
    assert.ok(clearanceM !== null && clearanceM >= 15, `slope ${slope}: ${clearanceM}`)
    near(clearanceOf(camera, terrain), clearanceM as number, 1e-9)
  }
})

test('a cliff behind: going straight above is enough, so the camera stays at range (no lift overshoot)', () => {
  const terrain: Terrain = (c) => 990 + 3.0 * Math.max(0, southM(c))
  const { camera, viewer } = fakeViewer(terrain)
  const { clearanceM } = new ChaseCamera(viewer).update(st({ hM: 1000 }), 0.016)
  assert.ok(clearanceM !== null && clearanceM >= 15, `${clearanceM}`)
  near(Cartesian3.distance(camera.positionWC, Cartesian3.fromDegrees(LOWI.lon, LOWI.lat, 1000)), 150, 1e-3)
})

test('aircraft below the terrain model (datum/DEM error): camera goes straight above and is lifted just clear', () => {
  const terrain: Terrain = () => 1200
  const { camera, viewer } = fakeViewer(terrain)
  const { clearanceM } = new ChaseCamera(viewer).update(st({ hM: 1000 }), 0.016)
  assert.ok(clearanceM !== null && clearanceM >= 15 && clearanceM < 16, `${clearanceM}`)
  near(clearanceOf(camera, terrain), clearanceM as number, 1e-9)
})

test('terrain not loaded under the camera: clearance null, no correction', () => {
  const { camera, viewer } = fakeViewer(() => undefined)
  const { clearanceM } = new ChaseCamera(viewer, { pitchDeg: 0 }).update(st({ hM: 1000 }), 0.016)
  assert.equal(clearanceM, null)
  near(camera.position.z, 0, 1e-6)
})

test('release hands the camera back (identity transform) and the next chase starts from the new heading', () => {
  const { camera, viewer } = fakeViewer(() => 0)
  const cc = new ChaseCamera(viewer)
  cc.update(st({ headingDeg: 0 }), 0.016)
  assert.ok(!Matrix4.equals(camera.transform, Matrix4.IDENTITY))
  cc.release()
  assert.ok(Matrix4.equals(camera.transform, Matrix4.IDENTITY))
  cc.update(st({ headingDeg: 200 }), 0.016)
  near(lookHeadingDeg(camera), 200, 1e-6)
})

test('OrbitControl: drag right swings the view clockwise, drag down raises the camera; both clamp', () => {
  const o = new OrbitControl(-12, 150)
  o.drag(300, 0) // 0.3°/px
  near(o.headingOffsetDeg, 90, 1e-9)
  o.drag(-600, 0)
  near(o.headingOffsetDeg, 270, 1e-9)
  o.drag(0, 100) // 0.25°/px, down = look more steeply down
  near(o.pitchDeg, -37, 1e-9)
  o.drag(0, 10_000)
  near(o.pitchDeg, -89, 1e-9)
  o.drag(0, -10_000)
  near(o.pitchDeg, 10, 1e-9)
})

test('OrbitControl: wheel up zooms in, wheel down out, clamped to 25 m … 3 km; reset restores the start', () => {
  const o = new OrbitControl(-12, 150)
  o.wheel(100)
  assert.ok(o.rangeM < 150 && o.rangeM > 120, `${o.rangeM}`)
  o.wheel(-200)
  assert.ok(o.rangeM > 150, `${o.rangeM}`)
  o.wheel(1e6)
  near(o.rangeM, 25, 1e-9)
  o.wheel(-1e6)
  near(o.rangeM, 3000, 1e-9)
  o.drag(123, 45)
  o.reset()
  assert.deepEqual([o.headingOffsetDeg, o.pitchDeg, o.rangeM], [0, -12, 150])
})

test('ChaseCamera follows the orbit: 90° offset looks east from the west side; zoom sets the distance', () => {
  const { camera, viewer } = fakeViewer(() => 0)
  const cc = new ChaseCamera(viewer)
  cc.orbit.drag(300, 0)
  cc.orbit.wheel(-200)
  cc.update(st({ headingDeg: 0 }), 1 / 60)
  near(lookHeadingDeg(camera), 90, 0.5)
  near(Cartesian3.magnitude(camera.position), cc.orbit.rangeM, 0.01)
})

test('release: next chase starts behind the aircraft again but keeps zoom and pitch', () => {
  const { camera, viewer } = fakeViewer(() => 0)
  const cc = new ChaseCamera(viewer)
  cc.orbit.drag(300, 40)
  cc.orbit.wheel(150)
  const [pitch, range] = [cc.orbit.pitchDeg, cc.orbit.rangeM]
  cc.update(st(), 1 / 60)
  cc.release()
  assert.equal(cc.orbit.headingOffsetDeg, 0)
  assert.deepEqual([cc.orbit.pitchDeg, cc.orbit.rangeM], [pitch, range])
  cc.update(st({ headingDeg: 0 }), 1 / 60)
  near(lookHeadingDeg(camera), 0, 0.5)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test client/scene/chaseCamera.test.ts`
Expected: FAIL — `SyntaxError: The requested module './chaseCamera.ts' does not provide an export named 'OrbitControl'`

- [ ] **Step 3: Write the implementation**

```ts
// client/scene/chaseCamera.ts
import { Cartesian3, Ellipsoid, HeadingPitchRange, Matrix4, ScreenSpaceEventHandler, ScreenSpaceEventType, Transforms } from 'cesium'
import type { Camera, Globe, Scene, Viewer } from 'cesium'
import type { RenderState } from '../types.ts'

const RAD = Math.PI / 180
const STEEPEST_DEG = -89 // looking straight down makes lookAt's heading degenerate
const AIM_ABOVE_MIN_M = 0.5 // correct to min + 0.5 m so float noise never reads as a violation
const CLEARANCE_PASSES = 4 // terrain under the camera changes as it moves; 4 re-measures settle real slopes
const DEG_PER_PX_H = 0.3 // horizontal drag: a 1,200 px swipe ≈ one full orbit
const DEG_PER_PX_V = 0.25
const PITCH_MAX_DEG = 10 // slightly below the aircraft, looking up
const ZOOM_PER_WHEEL = 0.0015 // Cesium wheel delta ≈ ±100 per notch → ×0.86 / ×1.16
const RANGE_MIN_M = 25
const RANGE_MAX_M = 3000

/**
 * Camera position relative to the target, in the target's local east-north-up frame (metres).
 * Same convention as Cesium's lookAt(HeadingPitchRange): the camera looks along headingDeg, so it sits behind
 * the nose direction; pitchDeg is the camera's look angle, negative = looking down, so it sits above.
 */
export function chaseOffsetEnu(headingDeg: number, pitchDeg: number, rangeM: number): [number, number, number] {
  const h = headingDeg * RAD
  const p = pitchDeg * RAD
  const horizontal = rangeM * Math.cos(p)
  return [-horizontal * Math.sin(h), -horizontal * Math.cos(h), -rangeM * Math.sin(p)]
}

/**
 * User-controlled orbit around the chased aircraft: horizontal angle relative to its nose, look pitch and distance.
 * Drag convention as in three.js OrbitControls: the aircraft follows the mouse (drag right → camera swings to its left).
 */
export class OrbitControl {
  headingOffsetDeg = 0
  pitchDeg: number
  rangeM: number
  #pitch0: number
  #range0: number

  constructor(pitchDeg: number, rangeM: number) {
    this.pitchDeg = this.#pitch0 = pitchDeg
    this.rangeM = this.#range0 = rangeM
  }

  drag(dxPx: number, dyPx: number): void {
    this.headingOffsetDeg = wrap360(this.headingOffsetDeg + dxPx * DEG_PER_PX_H)
    this.pitchDeg = clamp(this.pitchDeg - dyPx * DEG_PER_PX_V, STEEPEST_DEG, PITCH_MAX_DEG)
  }

  /** Cesium wheel delta: positive = wheel up = closer. */
  wheel(delta: number): void {
    this.rangeM = clamp(this.rangeM * Math.exp(-delta * ZOOM_PER_WHEEL), RANGE_MIN_M, RANGE_MAX_M)
  }

  /** Back behind the aircraft at the starting pitch and distance. */
  reset(): void {
    this.headingOffsetDeg = 0
    this.pitchDeg = this.#pitch0
    this.rangeM = this.#range0
  }
}

export interface ChaseCameraOpts {
  rangeM?: number
  pitchDeg?: number
  minClearanceM?: number
  headingTauS?: number
}

/**
 * Third-person camera on one aircraft, heading-damped, kept ≥ minClearanceM above the loaded terrain.
 * While chasing, mouse input orbits (drag), zooms (wheel) and resets (double-click) instead of moving the globe.
 */
export class ChaseCamera {
  readonly orbit: OrbitControl
  #camera: Camera
  #scene: Scene
  #globe: Globe
  #input: ScreenSpaceEventHandler | null = null
  #minClearanceM: number
  #tauS: number
  #headingDeg: number | null = null
  #target = new Cartesian3()
  #frame = new Matrix4()
  #hpr = new HeadingPitchRange()

  constructor(viewer: Viewer, opts: ChaseCameraOpts = {}) {
    this.#camera = viewer.camera
    this.#scene = viewer.scene
    this.#globe = viewer.scene.globe
    this.orbit = new OrbitControl(opts.pitchDeg ?? -12, opts.rangeM ?? 150)
    this.#minClearanceM = opts.minClearanceM ?? 15
    this.#tauS = opts.headingTauS ?? 1.0
  }

  update(state: RenderState, dtS: number): { clearanceM: number | null } {
    this.#attachInput()
    const heading = wrap360(this.#smoothHeading(state.headingDeg, dtS) + this.orbit.headingOffsetDeg)
    let pitch = this.orbit.pitchDeg
    let liftM = 0
    let clearance = this.#place(state, heading, pitch, liftM)
    // ponytail: the correction is recomputed every frame, not smoothed. Ceiling: a cliff under the camera snaps the pitch;
    // upgrade: low-pass the correction with the heading tau.
    for (let i = 0; i < CLEARANCE_PASSES && clearance !== null && clearance < this.#minClearanceM; i++) {
      // Pitching from p to p' raises the camera by range·(sin p − sin p'), so solve for the missing metres.
      const needM = this.#minClearanceM + AIM_ABOVE_MIN_M - clearance
      const sinP = Math.sin(pitch * RAD) - needM / this.orbit.rangeM
      if (sinP >= Math.sin(STEEPEST_DEG * RAD)) pitch = Math.asin(sinP) / RAD
      else if (pitch > STEEPEST_DEG) pitch = STEEPEST_DEG // go (almost) straight above first, then measure again
      else liftM += needM // already above: the aircraft is under the terrain model, so raise the whole rig
      clearance = this.#place(state, heading, pitch, liftM)
    }
    return { clearanceM: clearance }
  }

  /** Hand the camera back to the globe controls. The next chase starts behind its aircraft; zoom and pitch are kept. */
  release(): void {
    this.#camera.lookAtTransform(Matrix4.IDENTITY)
    this.#headingDeg = null
    this.orbit.headingOffsetDeg = 0
    this.#input?.destroy()
    this.#input = null
    this.#scene.screenSpaceCameraController.enableInputs = true
  }

  /** First chased frame: route the mouse to the orbit instead of Cesium's globe controls. No-op without a DOM canvas. */
  #attachInput(): void {
    if (this.#input || typeof (this.#scene.canvas as { addEventListener?: unknown }).addEventListener !== 'function') return
    this.#scene.screenSpaceCameraController.enableInputs = false
    const h = (this.#input = new ScreenSpaceEventHandler(this.#scene.canvas))
    let dragging = false
    h.setInputAction(() => (dragging = true), ScreenSpaceEventType.LEFT_DOWN)
    h.setInputAction(() => (dragging = false), ScreenSpaceEventType.LEFT_UP)
    h.setInputAction((m: ScreenSpaceEventHandler.MotionEvent) => {
      if (dragging) this.orbit.drag(m.endPosition.x - m.startPosition.x, m.endPosition.y - m.startPosition.y)
    }, ScreenSpaceEventType.MOUSE_MOVE)
    h.setInputAction((delta: number) => this.orbit.wheel(delta), ScreenSpaceEventType.WHEEL)
    h.setInputAction(() => this.orbit.reset(), ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
  }

  /** Exponential smoothing towards the aircraft heading along the shorter way round; the first frame snaps. */
  #smoothHeading(targetDeg: number, dtS: number): number {
    if (this.#headingDeg === null) return (this.#headingDeg = wrap360(targetDeg))
    const k = this.#tauS > 0 ? 1 - Math.exp(-Math.max(0, dtS) / this.#tauS) : 1
    const delta = wrap360(targetDeg - this.#headingDeg + 180) - 180
    return (this.#headingDeg = wrap360(this.#headingDeg + k * delta))
  }

  /** Put the camera on the target's ENU frame; returns camera height − terrain height, null while that tile is not loaded. */
  #place(state: RenderState, headingDeg: number, pitchDeg: number, liftM: number): number | null {
    Cartesian3.fromDegrees(state.lon, state.lat, state.hM + liftM, Ellipsoid.WGS84, this.#target)
    Transforms.eastNorthUpToFixedFrame(this.#target, Ellipsoid.WGS84, this.#frame)
    this.#hpr.heading = headingDeg * RAD
    this.#hpr.pitch = pitchDeg * RAD
    this.#hpr.range = this.orbit.rangeM
    this.#camera.lookAtTransform(this.#frame, this.#hpr)
    const c = this.#camera.positionCartographic
    const terrain = this.#globe.getHeight(c) ?? null
    return terrain === null ? null : c.height - terrain
  }
}

const wrap360 = (deg: number): number => ((deg % 360) + 360) % 360
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
```

- [ ] **Step 4: Run them to verify they pass**

Run: `node --test client/scene/chaseCamera.test.ts`
Expected: PASS — `ℹ tests 18`, `ℹ pass 18`, `ℹ fail 0`.

- [ ] **Step 5: Check it by hand**

Run the app (or `harness/chase-camera.html`), chase an aircraft: drag left/right/up/down orbits, the wheel zooms, double-click snaps back behind, `Esc` returns the mouse to the globe. Validated in the preview on 2026-09-22: a 180 px drag → heading offset +54°, 30 px down → pitch −19.5°; 5 wheel notches up zoomed in; double-click → heading 298° / pitch −12°; after `Esc`, `enableInputs === true`; no console errors.

- [ ] **Step 6: Commit**

```bash
git add client/scene/chaseCamera.ts client/scene/chaseCamera.test.ts
git commit -m "feat(camera): mouse orbit, wheel zoom and double-click reset while chasing"
```

---

### Task 5: WP gate

- [ ] **Step 1: This package's tests**

Run: `node --test client/scene/chaseCamera.test.ts`
Expected: `ℹ tests 18`, `ℹ pass 18`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/chaseCamera|harness/chase-camera'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Full check in the worktree**

Run: `npm run check`
Expected: `tsc` prints nothing. On a worktree branched from `wave-0` the counts are `ℹ tests 59`, `ℹ pass 59`, `ℹ fail 0` (41 from WP-00 + 18 here).

- [ ] **Step 4: Confirm there is nothing left to commit**

Run: `git status --short`
Expected: no output.

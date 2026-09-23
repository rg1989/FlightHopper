# WP-E3 — Ground Objects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the runway planes, their threshold markers and the fleet's ground icons on the terrain while the topography toggle (WP-E1) flattens the relief and grows it back (design D7). Keep the fleet's airborne icons above a flattened relief. Also light the runway planes and give them the app's light (WP-E2), so they darken at night as the terrain does. `scene.verticalExaggeration` moves only the globe. A `Primitive`, an entity's point or label and a billboard stay at their fixed HAE. Without this package they float above a flattened map or sink into it (research A11, E7, E8).

**Architecture:** Two edits to existing modules. Both take WP-E0's `TerrainFrame` and do only arithmetic per frame.
- `client/scene/runways.ts` (WP-V5):
  - **One `Primitive` per airport** instead of one batched `Primitive`, so that each airport can move. Each runway is the same `PolygonGeometry` with `perPositionHeight` as before. `runwayCorners`, `RUNWAY_LIFT_M`, the asphalt colour and the markers' look are unchanged. An airport without runways adds nothing.
  - **Lit:** `MaterialAppearance({ material: Material.fromType('Color', { color }), materialSupport: BASIC, flat: false, translucent: false })`. BASIC's vertex format is position + normal. With `perPositionHeight`, `PolygonGeometry` gives each plane its own face normal (`GeometryPipeline.computeNormal`), within the runway's slope of the ellipsoid normal (0.16° at LLBG 08/26). In Cesium "lit" here means `czm_phong`: half the colour as ambient, which the light does NOT scale, plus half the colour × a Lambert term from two eye-fixed directions × `czm_lightColor`. `czm_lightColor` is the light colour × intensity, divided by its largest component when that is above 1. So the planes do not shade with the sun direction, and on their own they never drop below 0.5× their colour:
    - by day (Cesium's `SunLight`, or E2's light at intensity 2.0): 1.0× (top-down) to about 1.2× (grazing) the old flat colour;
    - at night (E2's intensity 0.45): 0.73× (top-down) to about 0.8×, while E2 takes the terrain around them to 0.3 (day-layer brightness) × 0.45 of its imagery, or to the darker city-lights layer. That is a grey slab on a dark valley, which misses D7's reason for lighting them;
    - at golden hour: the diffuse half is tinted warm.
  - **`setLight(look)`** therefore scales the planes' colour by k = dayBrightness × 2L / (1 + L), L = min(1, intensity), from E2's `sunLook` (null while the Sun is off: k = 1, as built). Seen from above, a plane is then as dark as the day imagery under the same light: k = 0.9999 by day, 0.19 at night (0.135× the colour, the day layer's 0.3 × 0.45). Every airport's material reads one shared `Color` as a uniform on every draw, so `setLight` writes three numbers in place: nothing is allocated and no vertex is touched. A non-finite k is ignored.
  - **No shadows:** the planes keep `Primitive`'s default `ShadowMode.DISABLED`, which a test asserts (D10: no cast shadows).
  - **Runway height and up:** each airport's runway height h is the mean of its thresholds' `thrHaeM`: KSFO −29.32 m, LLBG 56.57 m, LOWI 627.72 m. Its up n is the ellipsoid normal at the airport reference point. h matters only through the scale's clamp (below).
  - **`update(frame)`:**
    - If `fNow` and `relHM` are unchanged, it returns. Idle frames therefore cost one comparison.
    - A non-finite value is ignored, because it would reach Cesium's matrices.
    - Otherwise each airport's matrix is, along n: a scale by s = max(`fNow`, 1e-3) about base, the point h + `RUNWAY_LIFT_M` above the reference point, then a shift by `drawnHeightM(h, fNow, relHM)` − h. With s = f this is the terrain's own map along n (h′ ↦ relH + f·(h′ − relH)) whatever h is, so each runway's slope flattens with the terrain, and the lift stays 0.2 m. f = 1 gives the identity.
    - It is written from a module scratch array into the airport's `Matrix4` (`Matrix4.fromColumnMajorArray`) and copied in place into its `Primitive.modelMatrix`. `Primitive` compares its `modelMatrix` with a copy on every update, so an in-place write is picked up. The markers apply the airport's `Matrix4`. Nothing is allocated.
    - s stays ≥ 1e-3, because a singular `modelMatrix` throws a `RuntimeError` in `Matrix4.inverse`: Cesium inverts the model-view for `czm_normal` and the model for the camera's model-space position (relative-to-eye rendering). The clamp is why the scale is about the airport's own h: it leaves (s − f)(h′ − h), at most 7 mm (LLBG's 7.4 m × 1e-3). About relH it would leave up to 0.66 m (KSFO flattened around LOWI).
    - `czm_normal` is the inverse transpose of the model-view, so the normals flatten with the planes: at f = 0 they lie along n.
  - **Markers:** each marker's position is a non-constant `CallbackPositionProperty` that returns the airport's matrix × threshold into the caller's result. Cesium's point and label visualizers read every entity position into a scratch every frame anyway, so this costs nothing extra when idle. The markers also move without entity change events. The alternative, `ConstantPositionProperty.setValue`, allocates a clone and raises `definitionChanged`, which EntityCollection turns into `collectionChanged` arrays. A non-constant position marks the entity cluster dirty every frame. Clustering is off, so that call returns at once.
  - **The shift runs along the airport's up, not each point's.** 2.5 km from the airport point the two normals differ by 0.02°, so a point moves 0.26 m sideways per 657 m of shift. 657 m is KSFO flattened around LOWI's runway, which is visible only from browse. Near the chased airport the shift is small.
  - **ponytail, curvature:** one scale along one up cannot follow the Earth's curvature under the plane through base. A point d from the reference point ends up above the drawn terrain (+ the lift) by (1 − s)·d²/2R. At f = 0 that is 0.48 m at LLBG (the 08 end, 2.5 km out), 0.29 m at KSFO and 0.08 m at LOWI. The planes are never under the drawn terrain. Upgrade if gate GE shows the float: one primitive per runway, scaled about its own centre, which halves d.
  - **Why the scale:** a translation alone keeps each runway's own slope, off the drawn terrain by (h′ − h)(1 − f). At f = 0 the part of a runway more than 0.2 m below its airport's h goes under the flat plane and is hidden, and the rest floats. From `public/airports/heroes.json`: LLBG 08/26 86 % hidden (its 49.14 m end 7.2 m under, lift included), 12/30 47 %, while 03/21 floats 2.5–4.1 m; KSFO 10L/28R 51 % and 10R/28L 44 %; LOWI 08/26 45 %. LLBG is the local hero (PLAN.md A1), so any flatten near it would leave its main runway a sliver.
- `client/scene/fleetLayer.ts` (WP-B-V1):
  - **`setTerrain(frame)`** copies `fSampled`, `fNow` and `relHM`, only when all three are finite. Until the first call they are 1, 1 and 0: the terrain as loaded, which is exactly today's behaviour.
  - **Cache:** `Slot.groundH` now holds the TRUE terrain height (no lift), `trueHeightM(reading, fSampled, relHM)`. The factor is `fSampled` because the fleet layer samples in `scene.preUpdate`, before `render()` hands the new factor to the tiles (WP-E0). The sampling rules are unchanged: after ~200 m of movement, every ~600 frames, and every ~30 frames while a reading holds no height (below).
  - **Drawing:** every frame a ground icon is drawn at `drawnHeightM(groundH, fNow, relHM) + GROUND_LIFT_M`. This is arithmetic, so a grow or sink moves ground icons with no extra `globe.getHeight` call. Positions still pass the existing quarter-pixel filter. Billboards are depth-tested against the globe (research VERIFY A16 correction), so an icon left at a stale height would hide under the grown terrain or float above it.
  - **A reading with no height keeps the cache:**
    - below factor 0.5 `trueHeightM` returns `null` (flat, or too flat to invert; WP-E0);
    - `globe.getHeight` returns `undefined` for a tile not loaded yet, and during Cesium's picker race: on many frames of every grow or sink and until Topography's nudge 0.5 s later (WP-E1 measured 175 frames in 10 toggles, runs of up to 37).

    Either way the terrain is re-sampled after `GROUND_RETRY_FRAMES` (~0.5 s). A parked icon therefore keeps its height through a flatten and through a toggle's race. It is drawn on the plane (relH + lift) while flat and is right on every frame of the grow. Clearing the cache on `undefined`, as before E3, would drop a parked icon whose ~10 s refresh lands on a failed reading to the geoid, 534 m under LOWI's apron, and hide it for at least 30 frames.
  - **No cache yet (NaN):** `drawnHeightM(hM, fNow, relHM) + GROUND_LIFT_M·(1 − fNow)`. That is `hM` at factor 1, exactly as today, and relH + lift on a flat map, like every sampled icon (the flat plane is the drawn terrain there). Only an aircraft never sampled gets it.
  - **Airborne icons:** at the true `e.hM` (D4: aircraft keep their true HAE; only the ground moves), except below relH while `fNow` < 1. The flat plane is global (D9) and fleet billboards are depth-tested against the globe (`depthTestAgainstTerrain`), so there an icon would be drawn under the drawn terrain and vanish: flattened at LOWI (relH 627.72 m) and seen from browse, every aircraft below 628 m anywhere, such as the finals at KSFO and LLBG; flattened over the Alps (relH ≈ 2–3 km, the ground under the chased aircraft), most climbing and descending traffic, in chase too. Such an icon is drawn like a ground icon with no sample, at `drawnHeightM(hM, fNow, relHM) + GROUND_LIFT_M·(1 − fNow)`: on the plane + the lift when flat. It stays above the drawn ground under it, which is no higher than the drawn hM. D4 holds wherever an aircraft can be seen at its true height: above relH, and at f ≥ 1 (see Notes).

Conventions consumers (E-A) rely on:
- Every frame after `topo.update()`, call `fleetLayer.setTerrain(fr)` before `fleetLayer.update(...)`, because its samples need this frame's `fSampled`. Call `runways.update(fr)` anywhere in the same `preUpdate` frame. Neither keeps the frame object. Both apply in browse and chase (D9: topography is global).
- Every frame after `sun.update(...)`, call `runways.setLight(lit && st !== null ? sunLook(st.elevDeg, look) : null)`: `st` is what `sun.update` returned, `lit` the Sun's enabled state (`selected !== null && prefs.light`, as passed to `sun.setEnabled`), and `look` one reused `SunLook`. Browse (the Sun off) passes `null`, so the planes stay as built there.
- A relH re-latch while flat (D4) needs nothing extra: the runways recompute on a `relHM` change, and the icons are arithmetic.

**Tech Stack:** CesiumJS 1.145 (`Primitive.modelMatrix`, `Matrix4.fromColumnMajorArray`, `MaterialAppearance` lit with `MaterialSupport.BASIC` and a `Color` `Material`, `PolygonGeometry` normals, `Ellipsoid.geodeticSurfaceNormalCartographic`, `CallbackPositionProperty`, `Globe.getHeight`), WP-E0's `drawnHeightM`, `trueHeightM` and `TerrainFrame`, and `node:test`. No new dependencies. The tests use real, offline Cesium objects on the stand-in viewers the two test files already have, both unchanged:
- runways: `scene.primitives`, a real `EntityCollection` and `isDestroyed`. The test file also defines four empty DOM classes, because `Material` checks its uniform values with `instanceof HTMLCanvasElement` and three others;
- fleet layer: a fake scene whose `globe.getHeight` returns `f.groundH`. The new tests set `f.groundH` to the surface drawn at the factor the tiles hold.

**Wave:** E1–E5 (parallel; depends only on WP-E0). Consumed by E-A. **Estimated:** 1.5 h. **Validated:** first on 2026-09-22 in a scratch copy of the WP-E0 tree (the integrated B-A tree + WP-E0; Node 25.2.1, TypeScript 7.0.2, Vite 8.3.0, Cesium 1.145.0) on the user's MacBook Air M2. Revised on 2026-09-23 after review (an `undefined` reading keeps the cache, airborne icons below a flattened relief, `setLight`, the scale along up) in the merged E-A sandbox (E0 + E1–E5 + E-A in progress), which holds the four final files. The File blocks are byte-for-byte copies of them.
- `node --test client/scene/runways.test.ts` passed 11/11. The E0 tree has 8: the five `runwayCorners` tests are unchanged, the three `addRunways` tests are rewritten, and three tests are new (two `update`, one `setLight`).
- `node --test client/scene/fleetLayer.test.ts` passed 22/22: the 16 existing tests unchanged, plus 6 new.
- `npx tsc --noEmit` is clean for the whole merged tree, including `client/app.ts`, `harness/runways.ts` and `harness/fleet-layer.ts`, which use these APIs unchanged. `setLight` is new and is not called yet: E-A wires it.
- `npm test` was not re-run for the revision (the machine was short on CPU). The first version gave 617/617 on the E0 tree (611 + 2 + 4); a second, loaded run failed only the two known timing flakes, which passed alone (`client/ui/table.test.ts` 11/11, `server/main.browse.test.ts` 5/5). The revision adds 1 + 2 tests: 620 expected.
- **RED:** Steps 2 quote the real output of the final test files against a fresh copy of the E0 tree (`client/`, `shared/` and the golden fixtures). The tsc lines come from `tsc --noEmit` over the two test files in that copy.
- **Mutations:** 34 hand-made faults, each caught by 1–6 failing tests.
  - runways (19): unlit (`flat: true`), no normals (`VertexFormat.POSITION_ONLY`), shift sign flipped, shift from `fSampled`, no idle check, idle check ignoring relH, no finite guard, markers not following, runway height = airport elevation, up = the Earth's axis, empty airport still adding a primitive, `shadows: RECEIVE_ONLY`, no scale (the translation of the first version), no clamp (singular at f = 0), scale about h without the lift, scale about the ellipsoid, `setLight` ignoring the unlit ambient (k = dayBrightness × L), `setLight` without its finite guard, one `Color` per airport (`setLight` reaching none). "Runway height = first end" is no longer a fault: with the scale, h only moves the clamp's residual, by at most 4 mm.
  - fleet layer (15): un-exaggerating with `fNow`, caching the drawn reading (the old code), drawing the cache without `drawnHeightM`, a flat reading dropping the cache, a flat or `undefined` reading waiting the full 600 frames, an `undefined` reading clearing the cache (the first version), fallback = `hM` (the old code), fallback without the lift, no finite guard, `setTerrain` ignoring relH, airborne icons exaggerated too, airborne icons under the flat plane (the first version), airborne icons lifted above relH too, lifted at f ≥ 1 too, lifted without the lift.
- **Replay:** the first version's code blocks were extracted into a fresh copy of the E0 tree. Each Step 2 failed as written, each Step 4 passed, `tsc --noEmit` was clean, and `npm test` gave 617/617. The revision was not replayed as a whole: its File blocks are byte-compared with the tested files, and its Steps 2 were re-run on the E0 tree.
- **Harness:** none. This package owns no page, and `harness/runways.ts` only stores the handle. Harness: browser check pending (run by the orchestrator for gate GE). The checks are listed in "Notes for later work".

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- **Heights** are WGS84 ellipsoidal metres (HAE). relH can be below the ellipsoid (KSFO, −28 m).
- **Cesium's debug assertions ship in this app** (Vite bundles the unbuilt source). `update` and `setTerrain` ignore a frame with a non-finite number, and `setLight` a non-finite k, so none can reach a matrix, a colour or a billboard position. The runway scale stays ≥ 1e-3, so its `modelMatrix` is never singular.
- **No per-frame allocations:** `runways.update` returns on idle frames and writes in place otherwise, from a module scratch array. `runways.setLight` writes one `Color` in place. The marker callbacks write into Cesium's scratch. The fleet layer adds three numbers of state and arithmetic.
- **File ownership:** this package edits two files of WP-V5 and two of WP-B-V1, and nothing else (the B-S1 precedent: the row in `.planning/terrain-sun-design.md` §5 lists them). `harness/runways.ts` needs no change.
- Tests never touch the network or import `client/scene/viewer.ts` (CSS).
- Code blocks preceded by `File: \`path\`` contain that file's complete content.

## Files owned by this package

| Path | Change |
|---|---|
| `client/scene/runways.ts` | edit (WP-V5 file): one lit `Primitive` per airport; the handle gains `update(frame: TerrainFrame)` and `setLight(look)` |
| `client/scene/runways.test.ts` | edit (WP-V5 file), rewritten as a complete file: the old one asserted exactly one primitive |
| `client/scene/fleetLayer.ts` | edit (WP-B-V1 file): `FleetLayer.setTerrain(frame: TerrainFrame)`; the ground cache holds the true height and survives a reading with no height; airborne icons below a flattened relief are drawn on it |
| `client/scene/fleetLayer.test.ts` | edit (WP-B-V1 file): 6 tests added, the 16 existing ones unchanged |

## Sources (checked 2026-09-22; revised 2026-09-23)

Paths are relative to `node_modules/@cesium/engine/Source` (Cesium 1.145.0, engine 26.3.0) unless marked `d.ts` (`node_modules/cesium/Source/Cesium.d.ts`).

| Fact | Source |
|---|---|
| `Primitive`, `Billboard` and `PointPrimitive` have no exaggeration code: they stay at their fixed HAE when the terrain is exaggerated. | `grep -ci exaggerat` = 0 in `Scene/Primitive.js`, `Scene/Billboard.js`, `Scene/BillboardCollection.js`, `Scene/PointPrimitive.js`, `DataSources/PointVisualizer.js`; research A11 |
| `Primitive.modelMatrix` starts as a copy of `options.modelMatrix ?? IDENTITY`. Every update compares it with the last one (`Matrix4.equals`) and re-transforms the bounding spheres on a change, so an in-place write is seen. Draw commands take it by reference. It is 3D-only (debug check). | `Scene/Primitive.js:227`, `:1953-1954`, `:2008-2015`, `:2048`; d.ts `:44121` |
| `Primitive.shadows` defaults to `ShadowMode.DISABLED`. | `Scene/Primitive.js:295`; d.ts `:44143` |
| `MaterialAppearance`: `flat` defaults to false; `MaterialSupport.BASIC.vertexFormat` = `POSITION_AND_NORMAL`; unless flat, its fragment shader returns `czm_phong`. A `Color` material's `diffuse` is `czm_gammaCorrect(color.rgb)`, as `PerInstanceColorAppearance` gamma-corrects its colour, so k = 1 draws the old asphalt. | `Scene/MaterialAppearance.js:95`, `:296-297`; `Shaders/Appearances/BasicMaterialAppearanceFS.glsl:18-21`; `Scene/Material.js:870-877`, `:1406-1421`; d.ts `:39633` |
| `Material.fromType(type, uniforms)` stores each uniform value by reference, and the uniform map returns `material.uniforms[name]` on every draw: writing the shared `Color` in place changes the colour. `getUniformType` tests a value with `instanceof HTMLCanvasElement`, `HTMLImageElement`, `ImageBitmap` and `OffscreenCanvas`, so Node needs those four names defined. | `Scene/Material.js:411-431`, `:1220`, `:1247-1249`, `:1255-1270`; d.ts `:39458` |
| Lit shading is `czm_phong`: ambient 0.5·colour, which no light term multiplies, plus 0.5·colour × Lambert from eye-fixed (0,0,1) and (0,1,0) × `czm_lightColor`. So a lit plane never drops below 0.5× its colour. The default material has no specular. | `Shaders/Builtin/Functions/phong.glsl:30-50`; `Shaders/Builtin/Functions/getDefaultMaterial.glsl:21` |
| E2's terrain: vertex lighting draws the imagery × `czm_lightColor` × diffuse; E2's `sunLook` takes the intensity from 2 to 0.45 and the day layer's brightness to min(0.9999, 1 − 0.7·night), 0.3 at night; the city-lights layer (brightness 1.6) fades in to alpha 0.9999. | `Shaders/GlobeFS.glsl:433`, `:437`; `client/scene/sun.ts` (`sunLook`, WP-E2); `client/scene/nightLights.ts:22` |
| `czm_lightColor` = `light.color × light.intensity`, divided by its largest component when that is above 1. | `Renderer/UniformState.js:1529-1550`; `Renderer/AutomaticUniforms.js:1374-1380` |
| With `perPositionHeight`, `PolygonGeometry`'s top face keeps the normals of `GeometryPipeline.computeNormal` (face normals, averaged per vertex): each runway plane's own, within its slope of the ellipsoid normal (0.16° at LLBG 08/26, measured). | `Core/PolygonGeometryLibrary.js:1019-1021`; `Core/PolygonGeometry.js:100-101` |
| `Matrix4.inverse` throws `RuntimeError` for a singular matrix. Cesium inverts the model-view for `czm_normal` and the model for the camera's model-space position (relative-to-eye rendering), which is why the scale needs s ≥ 1e-3. `czm_normal` is the inverse transpose of the model-view's 3 × 3, so the normals flatten with the planes. | `Core/Matrix4.js:2804-2839`; `Renderer/UniformState.js:298-307`, `:1699-1705`, `:1810-1817`, `:1852-1860` |
| `CallbackPositionProperty(callback, isConstant)` calls `callback(time, result)` and clones the value into `result`. The point and label visualizers pass a module scratch as `result`. A non-constant position only sets `cluster._clusterDirty`, and the declutter callback returns at once while clustering is off. | `DataSources/CallbackPositionProperty.js:122-143`; `DataSources/PositionProperty.js:98-113`; `DataSources/PointVisualizer.js:23`, `:101-105`, `:113`; `DataSources/LabelVisualizer.js:32`, `:110-114`, `:125`; `DataSources/EntityCluster.js:225`; d.ts `:19879-19901` |
| `ConstantPositionProperty.setValue` allocates a clone and raises `definitionChanged` (not used, see Architecture). | `DataSources/ConstantPositionProperty.js:90-103` |
| `globe.getHeight` returns the drawn (exaggerated) surface. In `scene.preUpdate` it reflects the previous render's factor. | `Scene/Globe.js:851`; `Core/TerrainPicker.js:533`; `Scene/Scene.js:4627` (`preUpdate` before `render()`); WP-E0 Sources |
| Fleet billboards are depth-tested against the terrain: the layer sets no `disableDepthTestDistance` on them (only on the label), and the viewer sets `depthTestAgainstTerrain`. | `Scene/Billboard.js:181`; `client/scene/fleetLayer.ts` (constructor); `client/scene/viewer.ts:29`; research VERIFY A16 |
| `globe.getHeight` answers `undefined` on many frames of every grow or sink and until Topography's nudge 0.5 s later: Cesium's TerrainPicker race (gate GE: 175 frames in 10 toggles, runs of up to 37; without the nudge 40 of 80 readings after animations). | `client/scene/topography.ts` (class comment, WP-E1); `.planning/terrain-sun-design.md` §2 |
| `Ellipsoid.geodeticSurfaceNormalCartographic(c, result?)`, `Matrix4.fromColumnMajorArray(values, result?)`. | d.ts `:6080`, `:11359` |

---

### Task 1: Runways: one lit primitive per airport that follows the exaggeration and the light

**Files:**
- Modify: `client/scene/runways.ts` (complete new contents below)
- Modify: `client/scene/runways.test.ts` (complete new contents below; rewritten)
- Test: `client/scene/runways.test.ts`

**Interfaces:**
- Consumes: `TerrainFrame` (`client/types.ts`, WP-E0), `drawnHeightM`, `TOPO_ON` (tests) from `client/scene/exaggeration.ts` (WP-E0)
- Consumes, by shape only: WP-E2's `SunLook` (`dayBrightness`, `intensity`; `client/scene/sun.ts`), passed in by E-A. No import.
- Produces: `addRunways(viewer: Viewer, airports: Airport[]): { update(frame: TerrainFrame): void; setLight(look: { dayBrightness: number; intensity: number } | null): void; destroy(): void }`. `runwayCorners` and `RUNWAY_LIFT_M` are unchanged.

- [ ] **Step 1: Write the failing test**

File: `client/scene/runways.test.ts`
```ts
// client/scene/runways.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  Cartesian3,
  Cartographic,
  Color,
  Ellipsoid,
  EntityCollection,
  JulianDate,
  MaterialAppearance,
  Matrix3,
  Matrix4,
  PolygonGeometry,
  Primitive,
  ShadowMode,
  type GeometryInstance,
  type Viewer,
} from 'cesium'
import type { Airport } from '../../shared/airports.ts'
import { bearingDeg, distanceNm } from '../../shared/geo.ts'
import type { TerrainFrame } from '../types.ts'
import { TOPO_ON, drawnHeightM } from './exaggeration.ts'
import { addRunways, RUNWAY_LIFT_M, runwayCorners } from './runways.ts'

const airports: Airport[] = JSON.parse(readFileSync(new URL('../../data/fixtures/golden/airports-sample.json', import.meta.url), 'utf8'))
const ksfo = airports.find((a) => a.ident === 'KSFO')!
const rwy = ksfo.runways.find((r) => r.ends[1].ident === '28R')! // ends: [10L, 28R]
const [e10L, e28R] = rwy.ends

const m = (lat1: number, lon1: number, lat2: number, lon2: number): number => distanceNm(lat1, lon1, lat2, lon2) * 1852
const turn = (from: number, to: number): number => ((to - from + 540) % 360) - 180
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)

test('KSFO 10L/28R: four corners, 10L end first, heights from each end', () => {
  const c = runwayCorners(rwy)
  assert.equal(c.length, 4)
  assert.deepEqual(c.map((p) => p.h), [-30.79, -30.79, -28.3, -28.3])
})

test('width: 200 ft across each physical end, centred on it', () => {
  const [a, b, c, d] = runwayCorners(rwy)
  near(m(a.lat, a.lon, b.lat, b.lon), 60.96, 0.01, 'width at 10L')
  near(m(c.lat, c.lon, d.lat, d.lon), 60.96, 0.01, 'width at 28R')
  for (const p of [a, b]) near(m(e10L.lat, e10L.lon, p.lat, p.lon), 30.48, 0.01, 'half width at 10L')
  for (const p of [c, d]) near(m(e28R.lat, e28R.lon, p.lat, p.lon), 30.48, 0.01, 'half width at 28R')
})

test('ring order: left then right of 10L, right then left of 28R (a rectangle, not a bow tie)', () => {
  const [a, b, c, d] = runwayCorners(rwy)
  const brg = bearingDeg(e10L.lat, e10L.lon, e28R.lat, e28R.lon) // 10L → 28R ≈ 117.9° true
  near(turn(brg, bearingDeg(e10L.lat, e10L.lon, a.lat, a.lon)), -90, 0.01, 'a is left of 10L')
  near(turn(brg, bearingDeg(e10L.lat, e10L.lon, b.lat, b.lon)), 90, 0.01, 'b is right of 10L')
  near(turn(brg, bearingDeg(e28R.lat, e28R.lon, c.lat, c.lon)), 90, 0.05, 'c is right of 28R')
  near(turn(brg, bearingDeg(e28R.lat, e28R.lon, d.lat, d.lon)), -90, 0.05, 'd is left of 28R')
})

test('length: both long sides equal the end-to-end distance, within 0.5 % of the published 11,870 ft', () => {
  const [a, b, c, d] = runwayCorners(rwy)
  const centre = m(e10L.lat, e10L.lon, e28R.lat, e28R.lon)
  near(m(b.lat, b.lon, c.lat, c.lon), centre, 0.05, 'right side')
  near(m(a.lat, a.lon, d.lat, d.lon), centre, 0.05, 'left side')
  near(centre, 11870 * 0.3048, 11870 * 0.3048 * 0.005, 'published length')
})

test('every golden runway: rectangle as wide as published, as long as its ends are apart', () => {
  for (const ap of airports) {
    for (const r of ap.runways) {
      const [a, b, c, d] = runwayCorners(r)
      const [x, y] = r.ends
      const name = `${ap.ident} ${x.ident}/${y.ident}`
      near(m(a.lat, a.lon, b.lat, b.lon), r.widthFt * 0.3048, 0.01, name)
      near(m(b.lat, b.lon, c.lat, c.lon), m(x.lat, x.lon, y.lat, y.lon), 0.05, name)
      assert.deepEqual([a.h, b.h, c.h, d.h], [x.thrHaeM, x.thrHaeM, y.thrHaeM, y.thrHaeM], name)
    }
  }
})

// addRunways against a stand-in viewer: the scene's primitive list and an entity collection are all it touches.
// (Labels only need a DOM once Cesium renders them, so this runs in Node.)
function fakeViewer(): { viewer: Viewer; added: unknown[]; removed: unknown[]; entities: EntityCollection } {
  const added: unknown[] = []
  const removed: unknown[] = []
  const entities = new EntityCollection()
  const primitives = { add: (p: unknown) => (added.push(p), p), remove: (p: unknown) => (removed.push(p), true) }
  const viewer = { scene: { primitives }, entities, isDestroyed: () => false } as unknown as Viewer
  return { viewer, added, removed, entities }
}
// A Material types its uniforms with instanceof checks against these DOM classes (Material.js getUniformType); Node has none.
Object.assign(globalThis, { HTMLCanvasElement: class {}, HTMLImageElement: class {}, ImageBitmap: class {}, OffscreenCanvas: class {} })

const deg = (rad: number): number => (rad * 180) / Math.PI
const now = JulianDate.now()
const ASPHALT = Color.fromCssColorString('#3a3a3a')
/** An airport's runway height: the mean of its thresholds' thrHaeM (KSFO −29.32, LLBG 56.57, LOWI 627.72 m). */
const runwayHM = (ap: Airport): number => {
  const hs = ap.runways.flatMap((r) => r.ends.map((e) => e.thrHaeM))
  return hs.reduce((s, h) => s + h, 0) / hs.length
}
/**
 * A point update() placed, built at true height hM (+ the lift) at lat/lon of airport ap: on the terrain drawn there
 * (+ the lift), never under it, and above it by at most the Earth's curvature under the airport's plane, which one scale
 * along its up cannot follow: (1 − f)·d²/2R, 0.5 m 2.5 km out when flat. Not moved sideways.
 */
function onDrawnTerrain(ap: Airport, fr: TerrainFrame, at: Cartesian3, lat: number, lon: number, hM: number, what: string): void {
  const c = Cartographic.fromCartesian(at)
  const name = `${ap.ident} ${what} at f ${fr.fNow}`
  const overM = c.height - (drawnHeightM(hM, fr.fNow, fr.relHM) + RUNWAY_LIFT_M)
  const d = m(ap.lat, ap.lon, lat, lon)
  assert.ok(overM >= -0.01 && overM <= (Math.max(0, 1 - fr.fNow) * d * d) / (2 * 6.3e6) + 0.01, `${name}: ${overM} m over the drawn terrain`)
  // along the airport's up, not each point's: 2 km away they differ by 0.02°, 0.2 m sideways per 650 m of shift
  near(m(deg(c.latitude), deg(c.longitude), lat, lon), 0, 0.5, `${name} sideways`)
}

test('addRunways: one lit polygon primitive per airport, one marker per threshold', () => {
  const { viewer, added, entities } = fakeViewer()
  addRunways(viewer, [...airports, { ...ksfo, ident: 'XXXX', runways: [] }])
  assert.equal(added.length, airports.length, 'an airport without runways adds nothing')
  airports.forEach((ap, i) => {
    const prim = added[i] as Primitive
    assert.ok(prim instanceof Primitive)
    assert.equal((prim.geometryInstances as unknown[]).length, ap.runways.length, ap.ident)
    const look = prim.appearance as MaterialAppearance
    assert.ok(look instanceof MaterialAppearance)
    assert.equal(look.flat, false, 'lit: darkens with the scene light')
    assert.equal(look.translucent, false)
    assert.equal(look.material.type, 'Color')
    assert.ok(Color.equals(look.material.uniforms.color as Color, ASPHALT), 'asphalt')
    assert.equal(prim.shadows, ShadowMode.DISABLED, 'casts and receives no shadows (D10)')
    assert.ok(Matrix4.equals(prim.modelMatrix, Matrix4.IDENTITY), 'unmoved until update')
  })
  const runways = airports.flatMap((a) => a.runways)
  assert.equal(entities.values.length, runways.length * 2)
  const ksfoLabels = entities.values.slice(0, 8).map((e) => e.label!.text!.getValue(now))
  assert.deepEqual(ksfoLabels, ['10L', '28R', '10R', '28L', '1L', '19R', '1R', '19L'])
})

test('addRunways: the polygon sits on the corners, lifted RUNWAY_LIFT_M, lit along its local up; the marker sits on the threshold', () => {
  const { viewer, added, entities } = fakeViewer()
  addRunways(viewer, [{ ...ksfo, runways: [rwy] }])
  const instance = ((added[0] as Primitive).geometryInstances as GeometryInstance[])[0]
  const geom = PolygonGeometry.createGeometry(instance.geometry as unknown as PolygonGeometry)!
  const v = geom.attributes.position!.values as unknown as number[]
  const n = geom.attributes.normal!.values as unknown as number[]
  assert.equal(v.length, 4 * 3)
  const corners = runwayCorners(rwy)
  for (let i = 0; i < 4; i++) {
    const p = new Cartesian3(v[3 * i], v[3 * i + 1], v[3 * i + 2])
    const c = Cartographic.fromCartesian(p)
    near(deg(c.latitude), corners[i].lat, 1e-7, `corner ${i} lat`)
    near(deg(c.longitude), corners[i].lon, 1e-7, `corner ${i} lon`)
    near(c.height, corners[i].h + RUNWAY_LIFT_M, 0.01, `corner ${i} h`)
    const up = Ellipsoid.WGS84.geodeticSurfaceNormal(p)
    near(Cartesian3.dot(up, new Cartesian3(n[3 * i], n[3 * i + 1], n[3 * i + 2])), 1, 1e-6, `corner ${i} normal`)
  }
  assert.equal(geom.indices!.length, 2 * 3) // two flat triangles: a plane, no subdivision
  const p = Cartographic.fromCartesian(entities.values[1].position!.getValue(now)!)
  near(deg(p.latitude), e28R.thrLat, 1e-7)
  near(deg(p.longitude), e28R.thrLon, 1e-7)
  near(p.height, e28R.thrHaeM + RUNWAY_LIFT_M, 0.01)
})

test('update: each airport lies on the drawn terrain, its runways flattened with it, its markers with them, lit along up', () => {
  const lowi = airports.find((a) => a.ident === 'LOWI')!
  const llbg = airports.find((a) => a.ident === 'LLBG')!
  const frames: TerrainFrame[] = [
    { fSampled: TOPO_ON, fNow: 0, relHM: runwayHM(lowi) }, // flat around LOWI's runway: KSFO rises 657 m, LLBG 571 m
    { fSampled: 1e-7, fNow: 1e-7, relHM: runwayHM(llbg) }, // flat around LLBG after the nudge: its 08/26 spans −7.4 to +1.0 m
    { fSampled: 0.51, fNow: 0.5, relHM: 0 }, // mid-animation around the ellipsoid: LOWI sinks 314 m
    { fSampled: TOPO_ON, fNow: TOPO_ON, relHM: runwayHM(lowi) }, // on: KSFO 7 mm down, LOWI not at all
  ]
  for (const fr of frames) {
    const { viewer, added, entities } = fakeViewer()
    addRunways(viewer, airports).update(fr)
    let marker = 0
    airports.forEach((ap, i) => {
      const prim = added[i] as Primitive
      Matrix4.inverse(prim.modelMatrix, new Matrix4()) // Cesium inverts it (czm_normal, relative-to-eye): a singular one throws
      // czm_normal without the view: the inverse transpose of the model's 3 × 3
      const normalM = Matrix3.transpose(Matrix3.inverse(Matrix4.getMatrix3(prim.modelMatrix, new Matrix3()), new Matrix3()), new Matrix3())
      ap.runways.forEach((r, j) => {
        const g = (prim.geometryInstances as GeometryInstance[])[j].geometry as unknown as PolygonGeometry
        const geom = PolygonGeometry.createGeometry(g)!
        const v = geom.attributes.position!.values as unknown as number[]
        const n = geom.attributes.normal!.values as unknown as number[]
        for (const [k, c] of runwayCorners(r).entries()) {
          const at = Matrix4.multiplyByPoint(prim.modelMatrix, new Cartesian3(v[3 * k], v[3 * k + 1], v[3 * k + 2]), new Cartesian3())
          onDrawnTerrain(ap, fr, at, c.lat, c.lon, c.h, `${r.ends[0].ident} corner ${k}`)
          const lit = Matrix3.multiplyByVector(normalM, new Cartesian3(n[3 * k], n[3 * k + 1], n[3 * k + 2]), new Cartesian3())
          const up = Ellipsoid.WGS84.geodeticSurfaceNormal(at)
          // each plane's own normal: within its slope of up (0.16° at LLBG 08/26), less as it flattens
          near(Cartesian3.dot(Cartesian3.normalize(lit, lit), up), 1, 1e-5, `${ap.ident} ${r.ends[0].ident} corner ${k} lit along up`)
        }
        for (const e of r.ends) onDrawnTerrain(ap, fr, entities.values[marker++].position!.getValue(now)!, e.thrLat, e.thrLon, e.thrHaeM, e.ident)
      })
    })
  }
})

test('update: recomputes only when the factor or relH changes, and ignores a non-finite frame', () => {
  const { viewer, added, entities } = fakeViewer()
  const rw = addRunways(viewer, [ksfo])
  const prim = added[0] as Primitive
  const markerH = (): number => Cartographic.fromCartesian(entities.values[0].position!.getValue(now)!).height
  rw.update({ fSampled: 1, fNow: 1, relHM: 0 })
  assert.ok(Matrix4.equals(prim.modelMatrix, Matrix4.IDENTITY), 'factor 1: the terrain as loaded, nothing moves')
  near(markerH(), e10L.thrHaeM + RUNWAY_LIFT_M, 0.01)
  rw.update({ fSampled: TOPO_ON, fNow: 0.5, relHM: 100 })
  const moved = Matrix4.clone(prim.modelMatrix)
  const placedH = markerH()
  Matrix4.clone(Matrix4.IDENTITY, prim.modelMatrix) // shows whether update() writes the matrix again
  rw.update({ fSampled: 0.5, fNow: 0.5, relHM: 100 }) // only fSampled differs: nothing to do
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    rw.update({ fSampled: 0.5, fNow: bad, relHM: 100 })
    rw.update({ fSampled: 0.5, fNow: 0.5, relHM: bad })
  }
  assert.ok(Matrix4.equals(prim.modelMatrix, Matrix4.IDENTITY), 'not rewritten')
  assert.equal(markerH(), placedH, 'markers keep the last good place')
  rw.update({ fSampled: 0.5, fNow: 0.5, relHM: 200 }) // relH alone: a re-latch while flat
  assert.ok(!Matrix4.equals(prim.modelMatrix, Matrix4.IDENTITY), 'a new relH rewrites it')
  near(markerH() - placedH, 50, 0.01, 'markers too: a plane 100 m higher, at f 0.5')
  Matrix4.clone(Matrix4.IDENTITY, prim.modelMatrix)
  rw.update({ fSampled: 0.5, fNow: 0.4, relHM: 200 }) // the factor alone
  assert.ok(!Matrix4.equals(prim.modelMatrix, Matrix4.IDENTITY), 'a new factor rewrites it')
  rw.update({ fSampled: 0.4, fNow: 0.5, relHM: 100 })
  assert.ok(Matrix4.equals(prim.modelMatrix, moved), 'the same frame, the same place')
  assert.equal(markerH(), placedH)
})

test('setLight: the planes darken as the day imagery does under WP-E2’s light (czm_phong keeps half the colour unlit)', () => {
  const { viewer, added } = fakeViewer()
  const rw = addRunways(viewer, airports)
  const colours = added.map((p) => ((p as Primitive).appearance as MaterialAppearance).material.uniforms.color as Color)
  const paint = colours[0]
  assert.ok(colours.every((c) => c === paint), 'one Color that every airport reads')
  const k = (): number => paint.red / ASPHALT.red
  rw.setLight({ dayBrightness: 0.9999, intensity: 2 }) // by day
  near(k(), 0.9999, 1e-9)
  rw.setLight({ dayBrightness: 0.3, intensity: 0.45 }) // at night
  // seen from above czm_phong draws k·colour·(0.5 + 0.5·czm_lightColor); the day imagery gets dayBrightness × czm_lightColor
  near(k() * (0.5 + 0.5 * 0.45), 0.3 * 0.45, 1e-9, 'as dark as the imagery around it')
  near(paint.green / ASPHALT.green, k(), 1e-9)
  near(paint.blue / ASPHALT.blue, k(), 1e-9)
  assert.equal(paint.alpha, 1, 'still opaque')
  const night = k()
  for (const bad of [{ dayBrightness: Number.NaN, intensity: 2 }, { dayBrightness: 0.3, intensity: Number.NaN }, { dayBrightness: 0.3, intensity: -1 }]) {
    rw.setLight(bad)
  }
  assert.equal(k(), night, 'a non-finite k is ignored')
  rw.setLight(null) // the Sun off
  assert.ok(Color.equals(paint, ASPHALT), 'as built')
})

test('addRunways: destroy removes exactly what it added; no airports adds nothing', () => {
  const { viewer, added, removed, entities } = fakeViewer()
  entities.add({ id: 'someone-else' })
  const h = addRunways(viewer, airports)
  h.destroy()
  assert.deepEqual(removed, added)
  assert.deepEqual(entities.values.map((e) => e.id), ['someone-else'])
  const empty = fakeViewer()
  addRunways(empty.viewer, []).destroy()
  assert.equal(empty.added.length, 0)
  assert.equal(empty.removed.length, 0)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/scene/runways.test.ts`
Expected: FAIL, with `ℹ tests 11`, `ℹ pass 6`, `ℹ fail 5`. The five `runwayCorners` tests and `destroy` pass. The failures are:
- `addRunways: one lit polygon primitive per airport…`: `AssertionError [ERR_ASSERTION]: an airport without runways adds nothing` / `1 !== 3`
- `addRunways: the polygon sits on the corners…`: `TypeError: Cannot read properties of undefined (reading 'values')` (no normals)
- `update: each airport lies on the drawn terrain…`: `TypeError: addRunways(...).update is not a function`
- `update: recomputes only when…`: `TypeError: rw.update is not a function`
- `setLight: the planes darken…`: `TypeError: Cannot read properties of undefined (reading 'uniforms')` (no material)

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/runways'`
Expected:
```
client/scene/runways.test.ts(175,34): error TS2339: Property 'update' does not exist on type '{ destroy(): void; }'.
client/scene/runways.test.ts(206,6): error TS2339: Property 'update' does not exist on type '{ destroy(): void; }'.
client/scene/runways.test.ts(209,6): error TS2339: Property 'update' does not exist on type '{ destroy(): void; }'.
client/scene/runways.test.ts(213,6): error TS2339: Property 'update' does not exist on type '{ destroy(): void; }'.
client/scene/runways.test.ts(215,8): error TS2339: Property 'update' does not exist on type '{ destroy(): void; }'.
client/scene/runways.test.ts(216,8): error TS2339: Property 'update' does not exist on type '{ destroy(): void; }'.
client/scene/runways.test.ts(220,6): error TS2339: Property 'update' does not exist on type '{ destroy(): void; }'.
client/scene/runways.test.ts(224,6): error TS2339: Property 'update' does not exist on type '{ destroy(): void; }'.
client/scene/runways.test.ts(226,6): error TS2339: Property 'update' does not exist on type '{ destroy(): void; }'.
client/scene/runways.test.ts(238,6): error TS2339: Property 'setLight' does not exist on type '{ destroy(): void; }'.
client/scene/runways.test.ts(240,6): error TS2339: Property 'setLight' does not exist on type '{ destroy(): void; }'.
client/scene/runways.test.ts(248,8): error TS2339: Property 'setLight' does not exist on type '{ destroy(): void; }'.
client/scene/runways.test.ts(251,6): error TS2339: Property 'setLight' does not exist on type '{ destroy(): void; }'.
```

- [ ] **Step 3: Write the implementation**

File: `client/scene/runways.ts`
```ts
// client/scene/runways.ts
import {
  CallbackPositionProperty,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  DistanceDisplayCondition,
  Ellipsoid,
  GeometryInstance,
  LabelStyle,
  Material,
  MaterialAppearance,
  Matrix4,
  PolygonGeometry,
  PolygonHierarchy,
  Primitive,
  VerticalOrigin,
  type Entity,
  type Viewer,
} from 'cesium'
import type { Airport, Runway } from '../../shared/airports.ts'
import { bearingDeg, destination } from '../../shared/geo.ts'
import type { TerrainFrame } from '../types.ts'
import { drawnHeightM } from './exaggeration.ts'

/**
 * The paved rectangle of a runway: the two PHYSICAL ends (ends[i].lat/lon) ± half the width,
 * perpendicular to the end-to-end bearing. Order: left, right of ends[0], then right, left of ends[1]
 * ("left" = looking from ends[0] towards ends[1]), so the ring is a rectangle, not a bow tie.
 * h is WGS84 ellipsoidal metres. One bearing serves both ends: over a 4 km runway the great-circle
 * bearing turns < 0.03°, which moves a corner < 2 cm.
 * ponytail: each physical end takes its own THRESHOLD height (thrHaeM). At a displaced threshold the
 * plane is then off by (displacement / length) × (height difference): 6 cm at KSFO 28R, 21 cm at LOWI 08,
 * 1.4 m at LLBG 26 (1,969 ft displaced). Upgrade (M4): extrapolate the end heights so that the plane
 * passes through both thresholds.
 */
export function runwayCorners(r: Runway): { lat: number; lon: number; h: number }[] {
  const [a, b] = r.ends
  const brg = bearingDeg(a.lat, a.lon, b.lat, b.lon)
  const halfNm = (r.widthFt * 0.3048) / 2 / 1852
  const corner = (end: Runway['ends'][number], side: -90 | 90): { lat: number; lon: number; h: number } => ({
    ...destination(end.lat, end.lon, brg + side, halfNm),
    h: end.thrHaeM,
  })
  return [corner(a, -90), corner(a, 90), corner(b, 90), corner(b, -90)]
}

/**
 * Drawn this far above the runway HAE so the plane wins against terrain that matches it exactly.
 * ponytail: a fixed lift, not polygon offset (Cesium's log depth writes gl_FragDepth, which bypasses
 * polygon offset). Where terrain is more than this above the plane, the terrain hides it: that
 * residual is what M4 measures and fixes (plane vs globe.clippingPolygons).
 */
export const RUNWAY_LIFT_M = 0.2

const ASPHALT = Color.fromCssColorString('#3a3a3a')
const MARKER_RANGE = new DistanceDisplayCondition(0, 30_000) // markers only near an airport
/** The smallest scale along up in a modelMatrix: at 0 it is singular, and Cesium inverts it (Matrix4.inverse throws). */
const MIN_SCALE = 1e-3
const COLS = Matrix4.toArray(Matrix4.IDENTITY) // update()'s scratch (column-major): it allocates nothing

/** One airport's planes and markers: they move together with the terrain exaggeration (design D7). */
interface Placed {
  planes: Primitive
  model: Matrix4 // where update() puts them: copied into planes.modelMatrix, and applied by the markers
  hM: number // the airport's runway height: mean of its thresholds' thrHaeM
  up: Cartesian3 // n: ellipsoid normal at the airport reference point
  upDotBase: number // n · base, base = the point hM + RUNWAY_LIFT_M above the reference point: update() scales about it
}

/**
 * Runway planes + threshold markers for these airports. The planes are one unpickable Primitive per
 * airport, so that each airport can follow the terrain exaggeration (update). PolygonGeometry with
 * perPositionHeight draws two flat triangles through the corners, i.e. a plane between the two end heights
 * (mid-runway it sits ≈ L²/8R ≈ 0.26 m below a surface parallel to the ellipsoid for KSFO 28R's 3.6 km).
 * The planes are lit (normals: each plane's own, within its slope of the ellipsoid normal: 0.16° at LLBG
 * 08/26), and their colour follows WP-E2's light (setLight), so they darken with the terrain at night. They
 * cast and receive no shadows (Primitive's default; design D10). Markers are entities (a point + the end's
 * ident at thrLat/thrLon/thrHaeM) that stay visible through terrain.
 */
export function addRunways(
  viewer: Viewer,
  airports: Airport[],
): {
  update(frame: TerrainFrame): void
  setLight(look: { dayBrightness: number; intensity: number } | null): void
  destroy(): void
} {
  const placed: Placed[] = []
  const markers: Entity[] = []
  const paint = ASPHALT.clone() // every airport's material reads it: setLight() writes it in place
  for (const ap of airports) {
    if (ap.runways.length === 0) continue
    const instances: GeometryInstance[] = []
    const model = Matrix4.clone(Matrix4.IDENTITY)
    let sumH = 0
    for (const r of ap.runways) {
      const corners = runwayCorners(r).map((c) => Cartesian3.fromDegrees(c.lon, c.lat, c.h + RUNWAY_LIFT_M))
      instances.push(
        new GeometryInstance({
          geometry: new PolygonGeometry({
            polygonHierarchy: new PolygonHierarchy(corners),
            perPositionHeight: true,
            vertexFormat: MaterialAppearance.MaterialSupport.BASIC.vertexFormat,
          }),
        }),
      )
      for (const e of r.ends) {
        sumH += e.thrHaeM
        const at = Cartesian3.fromDegrees(e.thrLon, e.thrLat, e.thrHaeM + RUNWAY_LIFT_M)
        markers.push(
          viewer.entities.add({
            // evaluated by Cesium every frame anyway; a callback follows the planes without entity change events
            position: new CallbackPositionProperty((_t, result) => Matrix4.multiplyByPoint(model, at, result ?? new Cartesian3()), false),
            point: {
              pixelSize: 7,
              color: Color.YELLOW,
              outlineColor: Color.BLACK,
              outlineWidth: 1,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              distanceDisplayCondition: MARKER_RANGE,
            },
            label: {
              text: e.ident,
              font: '13px sans-serif',
              style: LabelStyle.FILL_AND_OUTLINE,
              fillColor: Color.WHITE,
              outlineColor: Color.BLACK,
              outlineWidth: 3,
              verticalOrigin: VerticalOrigin.BOTTOM,
              pixelOffset: new Cartesian2(0, -8),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              distanceDisplayCondition: MARKER_RANGE,
            },
          }),
        )
      }
    }
    const hM = sumH / (2 * ap.runways.length)
    const up = Ellipsoid.WGS84.geodeticSurfaceNormalCartographic(Cartographic.fromDegrees(ap.lon, ap.lat))
    placed.push({
      planes: viewer.scene.primitives.add(
        new Primitive({
          geometryInstances: instances,
          appearance: new MaterialAppearance({
            material: Material.fromType('Color', { color: paint }),
            materialSupport: MaterialAppearance.MaterialSupport.BASIC, // position + normal
            flat: false,
            translucent: false,
          }),
          asynchronous: false,
          allowPicking: false,
        }),
      ),
      model,
      hM,
      up,
      upDotBase: Cartesian3.dot(up, Cartesian3.fromDegrees(ap.lon, ap.lat, hM + RUNWAY_LIFT_M)),
    })
  }
  let f = 1 // the factor and relH the planes are placed for; as built: the terrain as loaded
  let relHM = 0
  return {
    /**
     * Puts each airport's planes and markers where the terrain around it is drawn: along its up n, a scale by
     * s = max(f, 1e-3) about base (the airport's runway height h + the lift), then a shift by drawnHeightM(h, f, relH) − h.
     * The scale flattens each runway's own slope with the terrain: a point built at h′ ends up off the drawn terrain
     * (+ the lift) by (s − f)(h′ − h), ≤ 7 mm (LLBG's 7.4 m span × 1e-3), plus the Earth's curvature under the plane
     * through base, (1 − s)·d²/2R at d from the reference point: at f = 0 the planes float up to 0.48 m (LLBG's 08 end,
     * 2.5 km out; KSFO 0.29 m, LOWI 0.08 m) and are never under the drawn terrain. s stays ≥ 1e-3 because Cesium inverts
     * the modelMatrix (czm_normal, the camera's model-space position); the normals flatten with the planes.
     * Only when fNow or relHM changed: idle frames cost one comparison. A non-finite frame is ignored (it would reach
     * Cesium's matrices).
     */
    update(frame: TerrainFrame): void {
      if (frame.fNow === f && frame.relHM === relHM) return
      if (!Number.isFinite(frame.fNow) || !Number.isFinite(frame.relHM)) return
      f = frame.fNow
      relHM = frame.relHM
      const k = Math.max(f, MIN_SCALE) - 1
      for (const p of placed) {
        // x ↦ x + k·n·(n·x − n·base) + n·(drawn(h) − h): I + k·n·nᵀ, then a translation along n. f = 1: the identity.
        const { x, y, z } = p.up
        const t = drawnHeightM(p.hM, f, relHM) - p.hM - k * p.upDotBase
        COLS[0] = 1 + k * x * x
        COLS[1] = k * y * x
        COLS[2] = k * z * x
        COLS[4] = k * x * y
        COLS[5] = 1 + k * y * y
        COLS[6] = k * z * y
        COLS[8] = k * x * z
        COLS[9] = k * y * z
        COLS[10] = 1 + k * z * z
        COLS[12] = t * x
        COLS[13] = t * y
        COLS[14] = t * z
        Matrix4.fromColumnMajorArray(COLS, p.model)
        Matrix4.clone(p.model, p.planes.modelMatrix) // in place: Primitive compares it every frame
      }
    },
    /**
     * The planes' colour under WP-E2's light: sunLook's dayBrightness and intensity while the Sun is on, null while it
     * is off (as built). They are lit by czm_phong, which keeps half the colour as unlit ambient: on its own a plane
     * never drops below 0.5× its colour (0.73× at E2's night intensity 0.45), while the terrain around it goes to
     * 0.3 × 0.45 of its imagery. So the colour is scaled by k = dayBrightness × 2L / (1 + L), L = min(1, intensity)
     * (czm_lightColor: a white light, normalised above 1). Seen from above, a plane is then as dark as the day imagery
     * under the same light: k is 0.9999 by day and 0.19 at night. It writes the one Color every airport's material
     * reads, every frame if need be: nothing is allocated and no vertex is touched. A non-finite k is ignored.
     */
    setLight(look: { dayBrightness: number; intensity: number } | null): void {
      const l = look === null ? 1 : Math.min(1, look.intensity)
      const k = look === null ? 1 : (2 * look.dayBrightness * l) / (1 + l)
      if (!Number.isFinite(k)) return
      paint.red = ASPHALT.red * k
      paint.green = ASPHALT.green * k
      paint.blue = ASPHALT.blue * k
    },
    destroy(): void {
      if (viewer.isDestroyed()) return
      for (const p of placed) viewer.scene.primitives.remove(p.planes)
      for (const m of markers) viewer.entities.remove(m)
    },
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/scene/runways.test.ts`
Expected: PASS: `ℹ tests 11`, `ℹ pass 11`, `ℹ fail 0`.

- [ ] **Step 5: Type-check these files and their users**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/runways|client/app|harness/runways'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 6: Commit**

```bash
git add client/scene/runways.ts client/scene/runways.test.ts
git commit -m "feat(scene): runways follow the terrain exaggeration and the light, one lit primitive per airport" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Fleet icons: ground icons keep the true terrain height, airborne ones stay above a flat map

**Files:**
- Modify: `client/scene/fleetLayer.ts` (complete new contents below)
- Modify: `client/scene/fleetLayer.test.ts` (complete new contents below; one import and six tests added)
- Test: `client/scene/fleetLayer.test.ts`

**Interfaces:**
- Consumes: `TerrainFrame` (`client/types.ts`, WP-E0), `drawnHeightM`, `trueHeightM`, and in the tests `TOPO_ON` and `smoothstep` (`client/scene/exaggeration.ts`, WP-E0)
- Produces: `FleetLayer.setTerrain(frame: TerrainFrame): void`. Every other signature is unchanged: `update`, `pick`, `destroy`, `northAt`, `MAX_AGE_S`, `SELECTED_SCALE`, `CHASE_HIDE_M` and `GROUND_LIFT_M` (still 2 m, now above the drawn terrain). `update` now draws an airborne icon below a flattened relief on it (Architecture).

- [ ] **Step 1: Write the failing test**

File: `client/scene/fleetLayer.test.ts`
```ts
// client/scene/fleetLayer.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BillboardCollection, BlendOption, Cartesian2, Cartesian3, Cartesian4, Cartographic, Color, LabelCollection, Matrix4, Transforms } from 'cesium'
import type { Billboard, Viewer } from 'cesium'
import type { AircraftInfo } from '../../shared/info.ts'
import type { FleetEntry } from '../types.ts'
import { altitudeColor } from './altitudeColor.ts'
import { TOPO_ON, drawnHeightM, smoothstep } from './exaggeration.ts'
import { FleetLayer, GROUND_LIFT_M, MAX_AGE_S, SELECTED_SCALE, northAt } from './fleetLayer.ts'
import { HALO_ID, ICON_ID } from './icons.ts'

// Node has no DOM. Label measures its CSS font through the DOM once per font (Label.js parseFont); the icons draw on a
// canvas. Both are stubbed; glyphs and textures are only uploaded by a real scene's render, which these tests never run.
Object.assign(globalThis, {
  document: {
    createElement: (tag: string) =>
      tag === 'canvas'
        ? { width: 0, height: 0, getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }
        : { style: {} },
    body: { appendChild: () => {}, removeChild: () => {} },
    defaultView: { getComputedStyle: () => ({ getPropertyValue: (p: string) => (p === 'font-size' ? '13px' : '') }) },
  },
})

/** camera: a perspective camera at `camera` looking with vertical field of view fovy over a 1,000 px high buffer. */
function fakeViewer(groundH?: number, camera?: Cartesian3, fovy = 1) {
  const f = {
    added: [] as unknown[],
    pickResult: undefined as unknown,
    pickedAt: null as Cartesian2 | null,
    heightCalls: 0,
    groundH,
    viewer: null as unknown as Viewer,
  }
  const scene = {
    primitives: {
      add: <T>(p: T): T => (f.added.push(p), p),
      remove: (p: { destroy(): void }): boolean => {
        const i = f.added.indexOf(p)
        if (i < 0) return false
        f.added.splice(i, 1)
        p.destroy()
        return true
      },
    },
    globe: { getHeight: (_c: Cartographic): number | undefined => (f.heightCalls++, f.groundH) },
    pick: (pos: Cartesian2): unknown => ((f.pickedAt = pos), f.pickResult),
    camera: camera && { positionWC: camera, frustum: { fovy } },
    drawingBufferHeight: 1_000,
  }
  f.viewer = { scene } as unknown as Viewer
  return f
}

type F = ReturnType<typeof fakeViewer>
const bbs = (f: F): BillboardCollection => f.added.find((p) => p instanceof BillboardCollection) as BillboardCollection
const labels = (f: F): LabelCollection => f.added.find((p) => p instanceof LabelCollection) as LabelCollection
const all = (f: F): Billboard[] => Array.from({ length: bbs(f).length }, (_, i) => bbs(f).get(i))
const bb = (f: F, hex: string): Billboard => all(f).find((b) => b.id === hex && b.image !== HALO_ID) as Billboard
const halo = (f: F): Billboard => all(f).find((b) => b.image === HALO_ID) as Billboard
const label = (f: F) => labels(f).get(0)
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} ${msg}`)
/** Cesium counts property changes per property index; a frame that changes nothing adds nothing. */
const changes = (f: F): number[] => [...(bbs(f) as unknown as { _propertiesChanged: Uint32Array })._propertiesChanged]
const atlasIds = (f: F): number => (bbs(f) as unknown as { textureAtlas: { _indexById: Map<string, number> } }).textureAtlas._indexById.size

const info = (hex: string, o: Partial<AircraftInfo> = {}): AircraftInfo => ({
  hex, callsign: 'DLH4AB', reg: null, typeCode: 'A320', category: 'A3', squawk: null, emergency: null, military: false, route: null, ...o,
})
const fe = (hex: string, o: Partial<FleetEntry> = {}): FleetEntry => ({
  hex, lat: 50, lon: 10, hM: 10_000, altFt: 33_000, onGround: false, trackDeg: 90, gsKt: 450, vsFpm: 0, ageS: 1, quality: 'adsb2',
  info: info(hex), ...o,
})

test('one billboard collection (single translucent pass) and one label collection', () => {
  const f = fakeViewer()
  new FleetLayer(f.viewer)
  assert.equal(f.added.length, 2)
  assert.equal(bbs(f).blendOption, BlendOption.TRANSLUCENT)
  assert.ok(labels(f))
  assert.equal(halo(f).show, false, 'selection ring starts hidden')
  assert.equal(label(f).show, false, 'label starts hidden')
})

test('one billboard per hex at its position, reused and moved in place', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  layer.update([fe('aaaaaa', { lat: 50, lon: 10, hM: 9_000 }), fe('bbbbbb', { lat: 45, lon: 5 })], null, null)
  const a = bb(f, 'aaaaaa')
  assert.ok(a && bb(f, 'bbbbbb'))
  assert.equal(bbs(f).length, 3, 'two aircraft + the selection ring')
  assert.ok(Cartesian3.equalsEpsilon(a.position, Cartesian3.fromDegrees(10, 50, 9_000), 0, 1e-6))
  layer.update([fe('aaaaaa', { lat: 50.1, lon: 10, hM: 9_000 }), fe('bbbbbb', { lat: 45, lon: 5 })], null, null)
  assert.equal(bb(f, 'aaaaaa'), a, 'same Billboard object')
  assert.equal(bbs(f).length, 3)
  assert.ok(Cartesian3.equalsEpsilon(a.position, Cartesian3.fromDegrees(10, 50.1, 9_000), 0, 1e-6))
})

test('rotation = −track, about the local north axis, so the nose points along the track', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  layer.update([fe('aaaaaa', { lat: 47.3, lon: 11.4, trackDeg: 90 })], null, null)
  const b = bb(f, 'aaaaaa')
  near(b.rotation, -Math.PI / 2, 1e-12)
  const enu = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(11.4, 47.3, 0))
  const north = Matrix4.getColumn(enu, 1, new Cartesian4())
  assert.ok(Cartesian3.equalsEpsilon(b.alignedAxis, new Cartesian3(north.x, north.y, north.z), 1e-12), 'aligned axis = ENU north')
  layer.update([fe('aaaaaa', { lat: 47.3, lon: 11.4, trackDeg: 225 })], null, null)
  near(b.rotation, (-225 * Math.PI) / 180, 1e-12)
  layer.update([fe('aaaaaa', { lat: 47.3, lon: 11.4, trackDeg: null })], null, null)
  near(b.rotation, (-225 * Math.PI) / 180, 1e-12, 'no track → keep the last one')
  layer.update([fe('bbbbbb', { trackDeg: null })], null, null)
  assert.equal(bb(f, 'bbbbbb').rotation, 0, 'never had a track → north')
})

test('northAt is the unit ENU north vector', () => {
  for (const [lat, lon] of [[0, 0], [37.6, -122.4], [-33.9, 151.2], [89, 45]]) {
    const n = northAt(lat, lon, new Cartesian3())
    const enu = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(lon, lat, 0))
    const c = Matrix4.getColumn(enu, 1, new Cartesian4())
    assert.ok(Cartesian3.equalsEpsilon(n, new Cartesian3(c.x, c.y, c.z), 1e-12), `${lat}, ${lon}`)
  }
})

test('colour = altitude colour; ground grey; unknown altitude light grey', () => {
  const f = fakeViewer(100)
  const layer = new FleetLayer(f.viewer)
  layer.update([fe('aaaaaa', { altFt: 2_000 }), fe('bbbbbb', { altFt: 38_000 }), fe('cccccc', { onGround: true, altFt: null }), fe('dddddd', { altFt: null })], null, null)
  const css = (hex: string): Color => bb(f, hex).color
  assert.ok(css('aaaaaa').equalsEpsilon(Color.fromCssColorString(altitudeColor(2_000, false)), 1e-6))
  assert.ok(css('bbbbbb').equalsEpsilon(Color.fromCssColorString(altitudeColor(38_000, false)), 1e-6))
  assert.ok(css('cccccc').equalsEpsilon(Color.fromCssColorString(altitudeColor(null, true)), 1e-6))
  assert.ok(css('dddddd').equalsEpsilon(Color.fromCssColorString(altitudeColor(null, false)), 1e-6))
  layer.update([fe('aaaaaa', { altFt: 12_000 })], null, null)
  assert.ok(css('aaaaaa').equalsEpsilon(Color.fromCssColorString(altitudeColor(12_000, false)), 1e-6), 'climbing re-tints')
})

test('silhouette follows category/type; one atlas image per kind however many aircraft', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  const many = Array.from({ length: 60 }, (_, i) =>
    fe(`a${String(i).padStart(5, '0')}`, { info: info('x', { category: i % 3 === 0 ? 'A5' : 'A3' }) }),
  )
  layer.update([...many, fe('eeeeee', { info: null }), fe('ffffff', { info: info('ffffff', { category: null, typeCode: 'EC35' }) })], null, null)
  assert.equal(bb(f, 'a00000').image, ICON_ID.heavy)
  assert.equal(bb(f, 'a00001').image, ICON_ID.jet)
  assert.equal(bb(f, 'eeeeee').image, ICON_ID.unknown, 'no info → unknown')
  assert.equal(bb(f, 'ffffff').image, ICON_ID.heli, 'type-code fallback')
  assert.equal(atlasIds(f), 5, 'heavy, jet, unknown, heli + the ring: 62 aircraft share 4 textures')
  layer.update([fe('eeeeee', { info: info('eeeeee', { category: 'A7' }) })], null, null)
  assert.equal(bb(f, 'eeeeee').image, ICON_ID.heli, 'info arriving later swaps the icon')
})

test('selected: 1.4× with the ring on it and hidden inside chase range; deselect restores', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  layer.update([fe('aaaaaa'), fe('bbbbbb', { lat: 48 })], 'bbbbbb', null)
  const [a, b] = [bb(f, 'aaaaaa'), bb(f, 'bbbbbb')]
  assert.equal(b.scale, SELECTED_SCALE)
  assert.equal(SELECTED_SCALE, 1.4)
  assert.equal(a.scale, 1)
  assert.equal(halo(f).show, true)
  assert.ok(halo(f).position.equals(b.position), 'ring sits on the selected aircraft')
  assert.equal(halo(f).id, 'bbbbbb', 'clicking the ring picks the aircraft')
  assert.ok(b.distanceDisplayCondition.near > 1_000, 'icon gives way to the 3-D model when the camera is close')
  assert.ok(!a.distanceDisplayCondition || a.distanceDisplayCondition.near === 0)
  layer.update([fe('aaaaaa'), fe('bbbbbb', { lat: 48 })], null, null)
  assert.equal(b.scale, 1)
  assert.equal(b.distanceDisplayCondition.near, 0)
  assert.equal(halo(f).show, false)
})

test(`entries older than ${MAX_AGE_S} s are hidden, and shown again when fresh`, () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  layer.update([fe('aaaaaa', { ageS: 5 }), fe('bbbbbb', { ageS: MAX_AGE_S + 1 })], 'bbbbbb', 'bbbbbb')
  assert.equal(bb(f, 'aaaaaa').show, true)
  assert.equal(bb(f, 'bbbbbb').show, false)
  assert.equal(halo(f).show, false, 'no ring on a hidden aircraft')
  assert.equal(label(f).show, false, 'no label on a hidden aircraft')
  layer.update([fe('aaaaaa', { ageS: 5 }), fe('bbbbbb', { ageS: 2 })], null, null)
  assert.equal(bb(f, 'bbbbbb').show, true)
})

test('hexes that leave are hidden and their billboards reused for new hexes (no vertex-array rebuild churn)', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  layer.update([fe('aaaaaa'), fe('bbbbbb'), fe('cccccc')], null, null)
  const b = bb(f, 'bbbbbb')
  layer.update([fe('aaaaaa'), fe('cccccc')], null, null)
  assert.equal(b.show, false)
  assert.equal(bb(f, 'bbbbbb'), undefined, 'id cleared')
  f.pickResult = { id: 'bbbbbb' }
  assert.equal(layer.pick(new Cartesian2(1, 1)), null, 'a gone hex cannot be picked')
  layer.update([fe('aaaaaa'), fe('cccccc'), fe('dddddd', { lat: 40, trackDeg: 10, altFt: 1_000, info: info('dddddd', { category: 'A1' }) })], null, null)
  assert.equal(bbs(f).length, 4, 'three aircraft + ring: the freed billboard was reused')
  const d = bb(f, 'dddddd')
  assert.equal(d, b)
  assert.equal(d.show, true)
  assert.equal(d.image, ICON_ID.light)
  near(d.rotation, (-10 * Math.PI) / 180, 1e-12)
  assert.ok(Cartesian3.equalsEpsilon(d.position, Cartesian3.fromDegrees(10, 40, 10_000), 0, 1e-6))
  layer.update([], null, null)
  assert.equal(all(f).filter((x) => x.show).length, 0)
})

test('label: hover callsign, else the selected one; hex when no callsign; hidden when neither', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  const es = [fe('aaaaaa', { info: info('aaaaaa', { callsign: 'EZY12' }) }), fe('bbbbbb', { lat: 48, info: null })]
  layer.update(es, null, null)
  assert.equal(label(f).show, false)
  layer.update(es, 'aaaaaa', null)
  assert.equal(label(f).show, true)
  assert.equal(label(f).text, 'EZY12')
  assert.equal(label(f).id, 'aaaaaa')
  assert.ok(label(f).position.equals(bb(f, 'aaaaaa').position))
  layer.update(es, 'aaaaaa', 'bbbbbb')
  assert.equal(label(f).text, 'BBBBBB', 'hover wins; no callsign → hex')
  assert.ok(label(f).position.equals(bb(f, 'bbbbbb').position))
  layer.update(es, null, 'cccccc')
  assert.equal(label(f).show, false, 'hovering a hex that is not drawn')
  assert.equal(labels(f).length, 1, 'exactly one label, ever')
})

test('on the ground: placed on the loaded terrain, sampled once and re-sampled only after moving ~200 m', () => {
  const f = fakeViewer(412)
  const layer = new FleetLayer(f.viewer)
  const g = (lat: number): FleetEntry => fe('aaaaaa', { onGround: true, altFt: null, hM: 48, lat })
  layer.update([g(47.26)], null, null)
  assert.equal(f.heightCalls, 1)
  near(Cartographic.fromCartesian(bb(f, 'aaaaaa').position).height, 412 + GROUND_LIFT_M, 1e-3)
  layer.update([g(47.2601)], null, null)
  layer.update([g(47.2602)], null, null)
  assert.equal(f.heightCalls, 1, '11 m of taxiing: cached')
  layer.update([g(47.263)], null, null)
  assert.equal(f.heightCalls, 2, '330 m: re-sampled')
  layer.update([fe('bbbbbb', { hM: 5_000 })], null, null)
  assert.equal(f.heightCalls, 2, 'airborne aircraft never sample terrain')
})

test('on the ground before the terrain tile loads: at hM, retried a little later', () => {
  const f = fakeViewer(undefined)
  const layer = new FleetLayer(f.viewer)
  const g = fe('aaaaaa', { onGround: true, altFt: null, hM: 48 })
  layer.update([g], null, null)
  near(Cartographic.fromCartesian(bb(f, 'aaaaaa').position).height, 48, 1e-3)
  const calls = f.heightCalls
  for (let i = 0; i < 10; i++) layer.update([g], null, null)
  assert.equal(f.heightCalls, calls, 'not every frame')
  f.groundH = 300
  for (let i = 0; i < 60; i++) layer.update([g], null, null)
  near(Cartographic.fromCartesian(bb(f, 'aaaaaa').position).height, 300 + GROUND_LIFT_M, 1e-3)
})

// Terrain exaggeration (design D7). LOWI: runway HAE (the relH Topography latches there) and an apron's true HAE.
const LOWI_RWY = 627.72
const APRON = 580
const heightOf = (f: F, hex: string): number => Cartographic.fromCartesian(bb(f, hex).position).height

test('exaggerated terrain: a ground icon keeps the TRUE height and follows a sink and a grow without sampling', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  const g = fe('aaaaaa', { onGround: true, altFt: null, hM: 48, lat: 47.26, lon: 11.35 })
  const frame = (fSampled: number, fNow: number): void => {
    f.groundH = drawnHeightM(APRON, fSampled, LOWI_RWY) // globe.getHeight: the surface of the last render
    layer.setTerrain({ fSampled, fNow, relHM: LOWI_RWY })
    layer.update([g], null, null)
  }
  frame(TOPO_ON, TOPO_ON)
  near(heightOf(f, 'aaaaaa'), APRON + GROUND_LIFT_M, 0.01)
  const calls = f.heightCalls
  let fPrev = TOPO_ON
  for (let i = 1; i <= 150; i++) { // a 2.5 s sink at 60 fps: 1 + 1e-5 → 0
    const fNow = TOPO_ON * (1 - smoothstep(i / 150))
    frame(fPrev, fNow)
    near(heightOf(f, 'aaaaaa'), drawnHeightM(APRON, fNow, LOWI_RWY) + GROUND_LIFT_M, 1e-3, `sink frame ${i}`)
    fPrev = fNow
  }
  assert.equal(f.heightCalls, calls, 'arithmetic only: no terrain sample during the animation')
  near(heightOf(f, 'aaaaaa'), LOWI_RWY + GROUND_LIFT_M, 1e-3, 'flat: on the plane')
  for (let i = 0; i < 700; i++) frame(0, 0) // frames 152–851
  // the ~10 s refresh (frame 601) reads the flat surface, which holds no relief: kept, and retried every 30 frames
  assert.equal(f.heightCalls - calls, 9, 'frames 601, 631, …, 841')
  near(heightOf(f, 'aaaaaa'), LOWI_RWY + GROUND_LIFT_M, 1e-3, 'still on the plane')
  fPrev = 0
  for (let i = 1; i <= 150; i++) { // grow back: the cached true height is still there
    const fNow = TOPO_ON * smoothstep(i / 150)
    frame(fPrev, fNow)
    near(heightOf(f, 'aaaaaa'), drawnHeightM(APRON, fNow, LOWI_RWY) + GROUND_LIFT_M, 1e-3, `grow frame ${i}`)
    fPrev = fNow
  }
  near(heightOf(f, 'aaaaaa'), APRON + GROUND_LIFT_M, 0.01)
})

test('exaggerated terrain: a sample is un-exaggerated with the factor the tiles held (fSampled), drawn at fNow', () => {
  const f = fakeViewer(drawnHeightM(APRON, 0.7, LOWI_RWY))
  const layer = new FleetLayer(f.viewer)
  layer.setTerrain({ fSampled: 0.7, fNow: 0.69, relHM: LOWI_RWY }) // mid-sink, first sample
  layer.update([fe('aaaaaa', { onGround: true, altFt: null, hM: 48, lat: 47.26, lon: 11.35 })], null, null)
  assert.equal(f.heightCalls, 1)
  near(heightOf(f, 'aaaaaa'), drawnHeightM(APRON, 0.69, LOWI_RWY) + GROUND_LIFT_M, 1e-3)
})

test('exaggerated terrain: while flat, a new ground icon sits on the plane, retries ~2 per s, and finds its height as the relief grows', () => {
  const f = fakeViewer(LOWI_RWY - 0.03) // a flat surface, read a little low (the picker's flat-triangle error)
  const layer = new FleetLayer(f.viewer)
  const g = fe('aaaaaa', { onGround: true, altFt: null, hM: 48, lat: 47.26, lon: 11.35 })
  layer.setTerrain({ fSampled: 1e-7, fNow: 1e-7, relHM: LOWI_RWY }) // flat after Topography's nudge
  for (let i = 0; i < 90; i++) layer.update([g], null, null)
  near(heightOf(f, 'aaaaaa'), LOWI_RWY + GROUND_LIFT_M, 1e-3, 'on the plane, like every sampled icon')
  assert.equal(f.heightCalls, 3, 'frames 1, 31 and 61: not every frame')
  let fPrev = 1e-7
  for (let i = 1; i <= 150; i++) {
    const fNow = TOPO_ON * smoothstep(i / 150)
    f.groundH = drawnHeightM(APRON, fPrev, LOWI_RWY)
    layer.setTerrain({ fSampled: fPrev, fNow, relHM: LOWI_RWY })
    layer.update([g], null, null)
    fPrev = fNow
  }
  near(heightOf(f, 'aaaaaa'), APRON + GROUND_LIFT_M, 0.01, 'sampled once the relief could be recovered')
})

test('exaggerated terrain: airborne icons stay at hM; a non-finite frame is ignored; factor 1 around 0 is the default', () => {
  const f = fakeViewer(412)
  const layer = new FleetLayer(f.viewer)
  const es = [fe('aaaaaa', { hM: 3_000 }), fe('bbbbbb', { onGround: true, altFt: null, hM: 48, lat: 47.3 })]
  layer.update(es, null, null)
  const before = [heightOf(f, 'aaaaaa'), heightOf(f, 'bbbbbb')]
  layer.setTerrain({ fSampled: 1, fNow: 1, relHM: 0 })
  layer.update(es, null, null)
  assert.deepEqual([heightOf(f, 'aaaaaa'), heightOf(f, 'bbbbbb')], before, 'the same as never calling setTerrain')
  layer.setTerrain({ fSampled: 1, fNow: 0.5, relHM: 100 })
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    layer.setTerrain({ fSampled: bad, fNow: 0.5, relHM: 100 })
    layer.setTerrain({ fSampled: 1, fNow: bad, relHM: 100 })
    layer.setTerrain({ fSampled: 1, fNow: 0.5, relHM: bad })
  }
  layer.update(es, null, null)
  near(heightOf(f, 'aaaaaa'), 3_000, 1e-3, 'airborne: true HAE whatever the terrain does')
  near(heightOf(f, 'bbbbbb'), drawnHeightM(412, 0.5, 100) + GROUND_LIFT_M, 1e-3, 'the last finite frame')
})

test('exaggerated terrain: an undefined reading (the picker race during a toggle) keeps the cached height and retries ~2 per s', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  const g = fe('aaaaaa', { onGround: true, altFt: null, hM: 48, lat: 47.26, lon: 11.35 })
  const frame = (fSampled: number, fNow: number, reading: number | undefined): void => {
    f.groundH = reading
    layer.setTerrain({ fSampled, fNow, relHM: LOWI_RWY })
    layer.update([g], null, null)
  }
  for (let i = 1; i <= 590; i++) frame(TOPO_ON, TOPO_ON, drawnHeightM(APRON, TOPO_ON, LOWI_RWY)) // sampled at frame 1
  const calls = f.heightCalls
  let fPrev = TOPO_ON
  for (let i = 1; i <= 150; i++) { // a sink from frame 591: every reading fails, the ~10 s refresh (frame 601) too
    const fNow = TOPO_ON * (1 - smoothstep(i / 150))
    frame(fPrev, fNow, undefined)
    near(heightOf(f, 'aaaaaa'), drawnHeightM(APRON, fNow, LOWI_RWY) + GROUND_LIFT_M, 1e-3, `sink frame ${i}`)
    fPrev = fNow
  }
  assert.equal(f.heightCalls - calls, 5, 'frames 601, 631, …, 721: retried, not every frame')
  near(heightOf(f, 'aaaaaa'), LOWI_RWY + GROUND_LIFT_M, 1e-3, 'flat: on the plane')
})

test('exaggerated terrain: an airborne icon below the flattened relief is drawn on it, not hidden under it; above it, at its true HAE', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  // flattened around LOWI's runway, seen from browse (D9): a KSFO final at 300 m over ground at ≈ −30 m; cruise traffic
  const es = [fe('aaaaaa', { hM: 300, lat: 37.6, lon: -122.3 }), fe('bbbbbb', { hM: 3_000 })]
  const cases: [number, number, string][] = [
    [0, LOWI_RWY + GROUND_LIFT_M, 'flat: on the plane, + the lift, like a ground icon'],
    [0.5, drawnHeightM(300, 0.5, LOWI_RWY) + GROUND_LIFT_M / 2, 'mid-grow: where 300 m is drawn'],
    [1, 300, 'the terrain as loaded: true HAE'],
    [TOPO_ON, 300, 'on: true HAE'],
  ]
  for (const [fNow, want, what] of cases) {
    layer.setTerrain({ fSampled: fNow, fNow, relHM: LOWI_RWY })
    layer.update(es, null, null)
    near(heightOf(f, 'aaaaaa'), want, 1e-3, what)
    assert.ok(heightOf(f, 'aaaaaa') > drawnHeightM(-30, fNow, LOWI_RWY) + 1, `above the drawn ground at f ${fNow}`)
    near(heightOf(f, 'bbbbbb'), 3_000, 1e-3, `above relH at f ${fNow}: true HAE (D4)`)
  }
})

test('an unchanged frame touches no billboard property; a moving aircraft touches only its position', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  const es = [fe('aaaaaa'), fe('bbbbbb', { lat: 48 })]
  layer.update(es, 'aaaaaa', 'bbbbbb')
  const before = changes(f)
  layer.update(es, 'aaaaaa', 'bbbbbb')
  assert.deepEqual(changes(f), before)
  es[1].lat += 0.001
  layer.update(es, 'aaaaaa', 'bbbbbb')
  const diff = changes(f).map((v, i) => v - before[i])
  const POSITION_INDEX = 1
  assert.equal(diff[POSITION_INDEX], 1, 'one position write')
  assert.equal(diff.reduce((s, v) => s + v, 0), 1, 'nothing else')
})

test('moves below a quarter pixel on screen are not written; they add up until they show', () => {
  // 1,000 km above the aircraft, 1 mrad per pixel: a quarter pixel is ~250 m there
  const f = fakeViewer(undefined, Cartesian3.fromDegrees(10, 50, 1_010_000))
  const layer = new FleetLayer(f.viewer)
  const e = fe('aaaaaa', { lat: 50, lon: 10, hM: 10_000 })
  layer.update([e], null, null)
  const b = bb(f, 'aaaaaa')
  const first = b.position.clone()
  const POSITION_INDEX = 1
  const writes = (): number => changes(f)[POSITION_INDEX]
  const w0 = writes()
  e.lat += 0.001 // 111 m
  layer.update([e], null, null)
  e.lat += 0.001 // 222 m in total
  layer.update([e], null, null)
  assert.equal(writes(), w0, 'not written')
  assert.ok(b.position.equals(first))
  e.lat += 0.001 // 333 m since the last write
  layer.update([e], null, null)
  assert.equal(writes(), w0 + 1)
  assert.ok(Cartesian3.equalsEpsilon(b.position, Cartesian3.fromDegrees(10, 50.003, 10_000), 0, 1e-6))
  e.lon += 0.002 // 143 m east at 50° N
  layer.update([e], null, null)
  assert.equal(writes(), w0 + 1, 'not written')
  e.lon += 0.003 // 358 m east since the last write
  layer.update([e], null, null)
  assert.equal(writes(), w0 + 2, 'eastward moves count too')

  const close = fakeViewer(undefined, Cartesian3.fromDegrees(10, 50, 10_500)) // chase range: 500 m away
  const layer2 = new FleetLayer(close.viewer)
  const e2 = fe('bbbbbb', { lat: 50, lon: 10, hM: 10_000 })
  layer2.update([e2], null, null)
  e2.lat += 0.00005 // 5.6 m, ~11 px at 500 m
  layer2.update([e2], null, null)
  assert.ok(Cartesian3.equalsEpsilon(bb(close, 'bbbbbb').position, Cartesian3.fromDegrees(10, 50.00005, 10_000), 0, 1e-6), 'written')
})

test('pick returns the hex under the cursor (icon, ring or label), null otherwise', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  layer.update([fe('a1b2c3')], 'a1b2c3', null)
  const at = new Cartesian2(100, 200)
  f.pickResult = { primitive: bb(f, 'a1b2c3'), id: 'a1b2c3' }
  assert.equal(layer.pick(at), 'a1b2c3')
  assert.equal(f.pickedAt, at)
  f.pickResult = { primitive: halo(f), id: halo(f).id }
  assert.equal(layer.pick(at), 'a1b2c3')
  f.pickResult = { id: label(f).id }
  assert.equal(layer.pick(at), 'a1b2c3')
  f.pickResult = undefined
  assert.equal(layer.pick(at), null, 'nothing under the cursor')
  f.pickResult = { id: 'ffffff' }
  assert.equal(layer.pick(at), null, 'a hex this layer does not draw')
  f.pickResult = { id: { name: 'an entity' } }
  assert.equal(layer.pick(at), null, 'another layer’s object')
})

test('destroy removes and destroys both collections', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  layer.update([fe('a1b2c3')], null, null)
  const [b, l] = [bbs(f), labels(f)]
  layer.destroy()
  assert.equal(f.added.length, 0)
  assert.ok(b.isDestroyed())
  assert.ok(l.isDestroyed())
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/scene/fleetLayer.test.ts`
Expected: FAIL, with `ℹ tests 22`, `ℹ pass 16`, `ℹ fail 6`. All 16 existing tests pass, and each of the six `exaggerated terrain: …` tests fails with `TypeError: layer.setTerrain is not a function`.

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/fleetLayer'`
Expected:
```
client/scene/fleetLayer.test.ts(268,11): error TS2339: Property 'setTerrain' does not exist on type 'FleetLayer'.
client/scene/fleetLayer.test.ts(300,9): error TS2339: Property 'setTerrain' does not exist on type 'FleetLayer'.
client/scene/fleetLayer.test.ts(310,9): error TS2339: Property 'setTerrain' does not exist on type 'FleetLayer'.
client/scene/fleetLayer.test.ts(318,11): error TS2339: Property 'setTerrain' does not exist on type 'FleetLayer'.
client/scene/fleetLayer.test.ts(331,9): error TS2339: Property 'setTerrain' does not exist on type 'FleetLayer'.
client/scene/fleetLayer.test.ts(334,9): error TS2339: Property 'setTerrain' does not exist on type 'FleetLayer'.
client/scene/fleetLayer.test.ts(336,11): error TS2339: Property 'setTerrain' does not exist on type 'FleetLayer'.
client/scene/fleetLayer.test.ts(337,11): error TS2339: Property 'setTerrain' does not exist on type 'FleetLayer'.
client/scene/fleetLayer.test.ts(338,11): error TS2339: Property 'setTerrain' does not exist on type 'FleetLayer'.
client/scene/fleetLayer.test.ts(351,11): error TS2339: Property 'setTerrain' does not exist on type 'FleetLayer'.
client/scene/fleetLayer.test.ts(379,11): error TS2339: Property 'setTerrain' does not exist on type 'FleetLayer'.
```

- [ ] **Step 3: Write the implementation**

File: `client/scene/fleetLayer.ts`
```ts
// client/scene/fleetLayer.ts
import {
  BillboardCollection,
  BlendOption,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  DistanceDisplayCondition,
  Ellipsoid,
  HorizontalOrigin,
  LabelCollection,
  LabelStyle,
  NearFarScalar,
  VerticalOrigin,
} from 'cesium'
import type { Billboard, Label, PerspectiveFrustum, Scene, Viewer } from 'cesium'
import type { FleetEntry, TerrainFrame } from '../types.ts'
import { ALTITUDE_RGBA, COLOR_COUNT, altitudeIndex } from './altitudeColor.ts'
import { drawnHeightM, trueHeightM } from './exaggeration.ts'
import { HALO_ID, HALO_PX, ICON_ID, ICON_PX, haloCanvas, iconCanvas, iconFor } from './icons.ts'
import type { IconKind } from './icons.ts'

const RAD = Math.PI / 180
export const MAX_AGE_S = 60 // older entries are hidden (the Fleet prunes them later)
export const SELECTED_SCALE = 1.4
export const CHASE_HIDE_M = 5_000 // the selected icon, ring and label give way to the 3-D model inside this range
export const GROUND_LIFT_M = 2 // above the drawn terrain, so a ground icon never z-fights the surface
const AXIS_STEP_DEG = 0.05 // re-aim a billboard's north axis after moving this far (0.05° of arc is invisible)
const MIN_MOVE_PX = 0.25 // a position change smaller than this on screen is not written (see #draw)
const M_PER_DEG = 111_320
const GROUND_STEP_DEG = 0.002 // re-sample the terrain under a ground aircraft after ~200 m
const GROUND_REFRESH_FRAMES = 600 // … and every ~10 s anyway, as finer terrain tiles load
const GROUND_RETRY_FRAMES = 30 // tile not loaded yet, or the terrain flat: try again in ~0.5 s (staggered per aircraft)

/** One shared Color per colour-table entry: frames allocate none. */
const COLORS: readonly Color[] = Array.from(
  { length: COLOR_COUNT },
  (_, i) => new Color(ALTITUDE_RGBA[i * 4], ALTITUDE_RGBA[i * 4 + 1], ALTITUDE_RGBA[i * 4 + 2], ALTITUDE_RGBA[i * 4 + 3]),
)
const HALO_COLOR = Color.fromCssColorString('#ffd23f')
const LABEL_BG = Color.fromCssColorString('#16181d')
/** Icons shrink to half size between 300 km and 8,000 km from the camera (continental views stay readable). */
const SIZE_BY_DISTANCE = new NearFarScalar(3e5, 1, 8e6, 0.5)
const ALWAYS = new DistanceDisplayCondition(0, Number.MAX_VALUE)
const CHASE_HIDE = new DistanceDisplayCondition(CHASE_HIDE_M, Number.MAX_VALUE)
const LABEL_OFFSET = new Cartesian2(0, -(ICON_PX / 2 + 2))
const LABEL_OFFSET_SELECTED = new Cartesian2(0, -(HALO_PX / 2 + 2)) // above the selection ring

/** Local east-north-up "north" unit vector at a geodetic lat/lon, written into `out`. */
export function northAt(latDeg: number, lonDeg: number, out: Cartesian3): Cartesian3 {
  const lat = latDeg * RAD
  const lon = lonDeg * RAD
  const s = Math.sin(lat)
  out.x = -s * Math.cos(lon)
  out.y = -s * Math.sin(lon)
  out.z = Math.cos(lat)
  return out
}

/** Per-hex state: what was last written to the billboard, so unchanged properties are never touched. */
interface Slot {
  b: Billboard
  frame: number
  n: number // creation order, staggers terrain re-samples
  show: boolean
  lat: number // last written position (degrees, metres, and the Cartesian)
  lon: number
  h: number
  x: number
  y: number
  z: number
  cosLat: number
  axisLat: number
  axisLon: number
  rot: number
  color: number
  cat: string | null | undefined
  type: string | null | undefined
  kind: IconKind | null
  sel: boolean | null
  groundH: number // TRUE terrain height (HAE m) under the aircraft; NaN = none yet
  groundLat: number
  groundLon: number
  groundAt: number
}

/**
 * Every aircraft of the browse view as a small silhouette, rotated to its track and tinted by altitude, in ONE
 * BillboardCollection (one draw call; one texture per silhouette kind). Billboards are keyed by hex and kept across
 * frames; each frame only writes the properties that changed. Aircraft that leave are hidden and their billboards
 * pooled for the next new hex (adding or removing a billboard makes Cesium rebuild the whole vertex array).
 * One reused Label shows the hovered (else selected) callsign; one reused ring marks the selected aircraft.
 */
export class FleetLayer {
  #scene: Scene
  #bbs: BillboardCollection
  #labels: LabelCollection
  #halo: Billboard
  #label: Label
  #byHex = new Map<string, Slot>()
  #free: Billboard[] = []
  #frame = 0
  #made = 0
  #labelHex: string | null = null
  #labelCallsign: string | null = null
  #pos = new Cartesian3()
  #axis = new Cartesian3()
  #cam = new Cartesian3()
  #moveK2 = 0 // (MIN_MOVE_PX × radians per pixel)²; 0 = write every change
  #carto = new Cartographic()
  #fSampled = 1 // terrain exaggeration of this frame (setTerrain); until the first call, the terrain as loaded
  #fNow = 1
  #relHM = 0

  constructor(viewer: Viewer) {
    this.#scene = viewer.scene
    // TRANSLUCENT: one pass instead of opaque + translucent (icons have soft edges; they still depth-test against the globe).
    this.#bbs = this.#scene.primitives.add(new BillboardCollection({ blendOption: BlendOption.TRANSLUCENT }))
    this.#halo = this.#bbs.add({ position: Cartesian3.ZERO, show: false, color: HALO_COLOR, scaleByDistance: SIZE_BY_DISTANCE, distanceDisplayCondition: CHASE_HIDE })
    this.#halo.setImage(HALO_ID, haloCanvas())
    this.#labels = this.#scene.primitives.add(new LabelCollection())
    this.#label = this.#labels.add({
      position: Cartesian3.ZERO,
      show: false,
      font: '600 13px system-ui, sans-serif',
      fillColor: Color.WHITE,
      style: LabelStyle.FILL,
      showBackground: true,
      backgroundColor: LABEL_BG, // opaque: drawn in the opaque pass, so no icon paints over it
      backgroundPadding: new Cartesian2(6, 3),
      verticalOrigin: VerticalOrigin.BOTTOM,
      horizontalOrigin: HorizontalOrigin.CENTER,
      pixelOffset: LABEL_OFFSET,
      pixelOffsetScaleByDistance: SIZE_BY_DISTANCE,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    })
  }

  /**
   * This frame's terrain exaggeration (design D7): call it before update(). Ground icons keep the TRUE terrain height and
   * are drawn where the terrain is drawn this frame. The numbers are copied (Topography reuses the object); a frame with
   * a non-finite one is ignored (it would reach the billboard positions).
   */
  setTerrain(frame: TerrainFrame): void {
    if (!(Number.isFinite(frame.fSampled) && Number.isFinite(frame.fNow) && Number.isFinite(frame.relHM))) return
    this.#fSampled = frame.fSampled
    this.#fNow = frame.fNow
    this.#relHM = frame.relHM
  }

  update(entries: readonly FleetEntry[], selectedHex: string | null, hoverHex: string | null): void {
    const frame = ++this.#frame
    this.#frameMoveThreshold()
    let touched = 0
    let sel: Slot | null = null
    let selE: FleetEntry | null = null
    let hover: Slot | null = null
    let hoverE: FleetEntry | null = null
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      const s = this.#byHex.get(e.hex) ?? this.#add(e.hex)
      if (s.frame !== frame) touched++
      s.frame = frame
      const visible = e.ageS <= MAX_AGE_S
      if (visible !== s.show) {
        s.b.show = visible
        s.show = visible
      }
      if (!visible) continue
      this.#draw(s, e)
      const isSel = e.hex === selectedHex
      if (isSel !== s.sel) {
        s.b.scale = isSel ? SELECTED_SCALE : 1
        s.b.distanceDisplayCondition = isSel ? CHASE_HIDE : ALWAYS
        s.sel = isSel
      }
      if (isSel) {
        sel = s
        selE = e
      }
      if (e.hex === hoverHex) {
        hover = s
        hoverE = e
      }
    }
    if (touched < this.#byHex.size) this.#sweep(frame)

    const halo = this.#halo
    if (sel && selE) {
      halo.position = sel.b.position
      halo.id = selE.hex
      if (!halo.show) halo.show = true
    } else if (halo.show) halo.show = false
    this.#updateLabel(hover ?? sel, hoverE ?? selE, sel !== null && (hover ?? sel) === sel)
  }

  pick(windowPos: Cartesian2): string | null {
    const id: unknown = this.#scene.pick(windowPos)?.id
    return typeof id === 'string' && this.#byHex.has(id) ? id : null
  }

  destroy(): void {
    this.#scene.primitives.remove(this.#bbs)
    this.#scene.primitives.remove(this.#labels)
    this.#byHex.clear()
    this.#free.length = 0
  }

  #add(hex: string): Slot {
    const b = this.#free.pop() ?? this.#bbs.add({ position: Cartesian3.ZERO, scaleByDistance: SIZE_BY_DISTANCE })
    b.id = hex
    const s: Slot = {
      b, frame: 0, n: this.#made++, show: b.show, lat: NaN, lon: NaN, h: NaN, x: 0, y: 0, z: 0, cosLat: NaN, axisLat: NaN, axisLon: NaN, rot: NaN, color: -1,
      cat: undefined, type: undefined, kind: null, sel: null, groundH: NaN, groundLat: NaN, groundLon: NaN, groundAt: 0,
    }
    this.#byHex.set(hex, s)
    return s
  }

  /** Hides the billboards of hexes missing from this frame and pools them for reuse. */
  #sweep(frame: number): void {
    for (const [hex, s] of this.#byHex) {
      if (s.frame === frame) continue
      s.b.show = false
      s.b.id = undefined
      this.#free.push(s.b)
      this.#byHex.delete(hex)
    }
  }

  /**
   * Movement below MIN_MOVE_PX on screen is not written: every position write makes Cesium re-encode that billboard,
   * and above 10 % dirty it rewrites the whole buffer. Screen size of a move ≈ metres / distance ÷ (radians per pixel).
   * Without a perspective camera (e.g. in Node tests) every change is written.
   */
  #frameMoveThreshold(): void {
    const cam = this.#scene.camera
    const fovy = (cam?.frustum as PerspectiveFrustum | undefined)?.fovy
    const hPx = this.#scene.drawingBufferHeight
    if (!cam || !(typeof fovy === 'number' && fovy > 0) || !(hPx > 0)) {
      this.#moveK2 = 0
      return
    }
    Cartesian3.clone(cam.positionWC, this.#cam)
    const k = (MIN_MOVE_PX * fovy) / hPx
    this.#moveK2 = k * k
  }

  #draw(s: Slot, e: FleetEntry): void {
    const b = s.b
    const h = e.onGround ? this.#groundHeight(s, e) : this.#airHeight(e.hM)
    if (e.lat !== s.lat || e.lon !== s.lon || h !== s.h) {
      const dN = (e.lat - s.lat) * M_PER_DEG
      const dE = (e.lon - s.lon) * M_PER_DEG * s.cosLat
      const dH = h - s.h
      const dx = s.x - this.#cam.x
      const dy = s.y - this.#cam.y
      const dz = s.z - this.#cam.z
      // NaN (first write) fails the test and writes
      if (!(dN * dN + dE * dE + dH * dH <= this.#moveK2 * (dx * dx + dy * dy + dz * dz))) {
        const p = Cartesian3.fromDegrees(e.lon, e.lat, h, Ellipsoid.WGS84, this.#pos)
        b.position = p
        s.lat = e.lat
        s.lon = e.lon
        s.h = h
        s.x = p.x
        s.y = p.y
        s.z = p.z
        if (!(Math.abs(e.lat - s.axisLat) <= AXIS_STEP_DEG && Math.abs(e.lon - s.axisLon) <= AXIS_STEP_DEG)) {
          // rotation is measured from this axis: with north as the axis, rotation = −track points the nose along the track
          b.alignedAxis = northAt(e.lat, e.lon, this.#axis)
          s.axisLat = e.lat
          s.axisLon = e.lon
          s.cosLat = Math.cos(e.lat * RAD)
        }
      }
    }
    if (e.trackDeg !== null) {
      const rot = -e.trackDeg * RAD
      if (rot !== s.rot) {
        b.rotation = rot
        s.rot = rot
      }
    } else if (Number.isNaN(s.rot)) {
      b.rotation = 0
      s.rot = 0
    }
    const c = altitudeIndex(e.altFt, e.onGround)
    if (c !== s.color) {
      b.color = COLORS[c]
      s.color = c
    }
    const cat = e.info === null ? null : e.info.category
    const type = e.info === null ? null : e.info.typeCode
    if (cat !== s.cat || type !== s.type) {
      s.cat = cat
      s.type = type
      const kind = iconFor(cat, type)
      if (kind !== s.kind) {
        b.setImage(ICON_ID[kind], iconCanvas(kind)) // stable id → one atlas entry per kind
        s.kind = kind
      }
    }
  }

  /**
   * FleetEntry.hM on the ground is the geoid (≈ sea level), which can be under the terrain; the loaded terrain height is
   * sampled instead, cached per aircraft. globe.getHeight returns the exaggerated surface of the last render, so the
   * cache holds it un-exaggerated with that factor (fSampled): the TRUE height. It is drawn at this frame's factor
   * every frame, which is arithmetic: a grow or sink animation costs no extra sample. A reading that holds no height
   * keeps the cache, and the terrain is re-sampled ~0.5 s later: undefined (a tile not loaded yet, or Cesium's picker
   * race, during every grow or sink and until Topography's nudge) or taken below factor 0.5 (flat, or too flat to
   * invert: trueHeightM is null). Only an aircraft never sampled falls back to hM.
   * ponytail: coarse tiles can sit a little off the true surface until the ~10 s refresh; upgrade: re-sample on the
   * globe's tileLoadProgressEvent reaching 0. While flat, every ground aircraft re-samples every ~0.5 s (as for a tile
   * not loaded yet): N ground icons cost N / 30 globe.getHeight calls per frame; upgrade: skip the sample while
   * trueHeightM would return null.
   */
  #groundHeight(s: Slot, e: FleetEntry): number {
    const globe = this.#scene.globe
    if (!globe) return e.hM
    const moved = !(Math.abs(e.lat - s.groundLat) <= GROUND_STEP_DEG && Math.abs(e.lon - s.groundLon) <= GROUND_STEP_DEG)
    if (moved || this.#frame >= s.groundAt) {
      const h = globe.getHeight(Cartographic.fromDegrees(e.lon, e.lat, 0, this.#carto))
      const t = h === undefined ? null : trueHeightM(h, this.#fSampled, this.#relHM) // null: no height, keep the cache
      if (t !== null) s.groundH = t
      s.groundLat = e.lat
      s.groundLon = e.lon
      s.groundAt = this.#frame + (t === null ? GROUND_RETRY_FRAMES : GROUND_REFRESH_FRAMES) + (s.n % GROUND_RETRY_FRAMES)
    }
    if (!Number.isNaN(s.groundH)) return drawnHeightM(s.groundH, this.#fNow, this.#relHM) + GROUND_LIFT_M
    // No terrain height yet: hM at factor 1, as always. As the ground flattens onto relH, so does the icon, and it
    // takes the lift there, since that plane IS the drawn terrain.
    return drawnHeightM(e.hM, this.#fNow, this.#relHM) + GROUND_LIFT_M * (1 - this.#fNow)
  }

  /**
   * An airborne aircraft keeps its true HAE (D4), except under a flattened relief: below relH while f < 1 it would be
   * drawn under the drawn terrain and hidden (billboards depth-test against the globe, and the flat plane is global, D9:
   * in browse and far from the airport relH was picked at too). There it is drawn where its own height is drawn, like a
   * ground icon with no sample: on the plane, + the lift, when flat. It stays above the drawn ground under it, which is
   * no higher than the drawn hM (below relH) or than max(ground, relH) ≤ hM (above it).
   */
  #airHeight(hM: number): number {
    const f = this.#fNow
    return hM < this.#relHM && f < 1 ? drawnHeightM(hM, f, this.#relHM) + GROUND_LIFT_M * (1 - f) : hM
  }

  #updateLabel(s: Slot | null, e: FleetEntry | null, selected: boolean): void {
    const l = this.#label
    if (!s || !e) {
      if (l.show) l.show = false
      return
    }
    const callsign = e.info === null ? null : e.info.callsign
    if (e.hex !== this.#labelHex || callsign !== this.#labelCallsign) {
      l.text = callsign ?? e.hex.toUpperCase()
      l.id = e.hex
      this.#labelHex = e.hex
      this.#labelCallsign = callsign
    }
    l.position = s.b.position
    l.pixelOffset = selected ? LABEL_OFFSET_SELECTED : LABEL_OFFSET
    l.distanceDisplayCondition = selected ? CHASE_HIDE : ALWAYS
    if (!l.show) l.show = true
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/scene/fleetLayer.test.ts`
Expected: PASS: `ℹ tests 22`, `ℹ pass 22`, `ℹ fail 0`.

- [ ] **Step 5: Type-check these files and their users**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/fleetLayer|client/app|harness/fleet-layer'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 6: Commit**

```bash
git add client/scene/fleetLayer.ts client/scene/fleetLayer.test.ts
git commit -m "feat(scene): fleet icons keep the true terrain height and stay above a flattened relief" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: WP gate

- [ ] **Step 1: This package's tests**

Run: `node --test client/scene/runways.test.ts client/scene/fleetLayer.test.ts`
Expected: `ℹ tests 33`, `ℹ pass 33`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files and their users**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/(runways|fleetLayer)|client/app|harness/(runways|fleet-layer)'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Full check**

Run: `npm run check`
Expected: `tsc` prints nothing, then `ℹ tests 620`, `ℹ fail 0` on the E0 tree (611 + 3 + 6). Other E packages merged before this one add their own tests. Two timing tests can fail under full-suite load and pass when run alone: "sortRows and filterRows stay cheap at 12,000 rows" (`client/ui/table.test.ts`) and "budget: /api/view of a 250 nm circle with 5,000 aircraft" (`server/main.browse.test.ts`). They are known flakes, not regressions. Any other failure must be fixed.

- [ ] **Step 4: Confirm there is nothing left to commit**

Run: `git status --short`
Expected: no output.

## Notes for later work

- **Deviations from the design brief:**
  - §5 writes the E3 APIs as `update(f, relHM)` and `setTerrain(f, relHM)`. Both take WP-E0's `TerrainFrame` instead. The fleet layer needs `fSampled` as well: a reading is un-exaggerated with the factor the tiles held, not the one about to be drawn.
  - An icon with no terrain height yet sits at relH + `GROUND_LIFT_M` on a flat map, not at relH as WP-E0's note says. Like every sampled icon it needs the lift, because there the flat plane is the drawn terrain.
  - A reading with no height keeps the cache: an `undefined` one (a tile not loaded, or the picker race) as well as a flat one (`trueHeightM` null). Before E3 an `undefined` reading cleared it; with E1's toggle that made parked icons blink out around toggles (review).
  - **D4 exception, for the user to confirm:** an airborne icon below relH while f < 1 is drawn on the flattened relief, not at its true HAE, where it would be hidden under the global flat plane (D9). Keeping D4 strictly instead means that, while the map is flat, fleet traffic below relH disappears everywhere: in browse after a flatten at LOWI, every aircraft below 628 m on Earth. The chased aircraft's model is E-A's placement, not this layer's.
  - `runways.setLight` is new. D7 lights the planes "so they darken at night", which `czm_phong` alone cannot do: its unlit half keeps them at 0.5× their colour or more.
  - The runway planes scale along up as well as shift (the first version's upgrade), so their own slope flattens with the terrain.
  - Markers use `CallbackPositionProperty` (see Architecture).
  - `shadows: ShadowMode.DISABLED` is not written, because it is `Primitive`'s default. A test pins it.
- **E-A wiring** (frame order in design §5: topography → clock → placement → sun → runways/fleet). `setTerrain` must come before `fleetLayer.update`, which in today's `frame()` runs before the chase placement. `setLight` needs this frame's `sun.update` result:
  ```ts
  const fr = topo.update(now)
  fleetLayer.setTerrain(fr)
  fleetLayer.update(all, selected, tableHover ?? mapHover)
  // … placement …
  const st = sun.update(tSunMs, sunWC)
  runways.update(fr)
  runways.setLight(selected !== null && prefs.light && st !== null ? sunLook(st.elevDeg, runwayLook) : null) // runwayLook: one reused SunLook
  ```
- **Browser checks for gate GE** (orchestrator):
  - LLBG (the local hero), topography off near its runways: relH is LLBG's runway height. All three runways lie flat on the flat map; 08/26 is whole, not a sliver (without the scale 86 % of it would be hidden). They float at most 0.48 m (the 08 end): from a low, grazing view the float must not show. The markers sit on the runway ends.
  - LOWI and KSFO, the same test: at most 0.08 m and 0.29 m of float.
  - Flatten more than 30 km from every hero airport (relH = the ground under the aircraft), then look at a hero airport: its planes and markers sit on the flat map and ride back up with the grow.
  - Lighting of the scaled planes: at f = 0 and during the animation they shade as at f = 1, with no black or blown-out plane (`czm_normal` of a non-rigid `modelMatrix`), and they do not jitter at close range (relative-to-eye precision with a 1e-3 scale).
  - LOWI at night: the runway plane about as dark as the terrain around it, not a grey slab. By day: as today. Golden hour: warm. Browse at night: as today (`setLight(null)`).
  - Fleet ground icons: parked aircraft follow the grow and sink on every frame, with no pop at the end, and no icon blinks out during a toggle or in the 0.5 s after it. A newly appearing ground icon sits on the flat map.
  - Fleet airborne icons: flatten at LOWI, go to browse and look at KSFO or LLBG. The aircraft on final (below 628 m) stay visible on the flat map; cruise traffic keeps its height.
  - Performance: no frame cost from `runways.update`, `runways.setLight` or `setTerrain` in the bench (`fh:frame`) when idle.
- **Browse lighting (D9, WP-E2):** in browse the Sun is off and E-A passes `setLight(null)`. The planes then follow E2's fixed white light at intensity 2, which `czm_lightColor` normalises to 1: as today.
- **ponytail, curvature float:** see Architecture. If gate GE shows it, the upgrade is one primitive per runway, scaled about its own centre, which halves d.
- **ponytail, flat cost:** while the ground is flat, every ground icon re-samples every ~0.5 s. N ground icons cost N / 30 `globe.getHeight` calls per frame, the same as unloaded tiles today. Upgrade: skip the sample while `trueHeightM` would return `null`.
- The PoC (`harness/terrain-sun.ts`) drew neither runways nor fleet icons, so there was nothing of it to port here.
- **Stale cache without a height:** a reading with no height (flat, or `undefined`) keeps the cache even after the aircraft has moved more than ~200 m, for example when it taxied, or landed at another airport while the map was flat or the reading failed. While flat this is invisible (everything is drawn at relH). During the next grow the icon is off by (old − new ground)·f until a reading at f ≥ 0.5, at most ~1.75 s into the 2.5 s grow. After an `undefined` reading it is off until the next good one, ~0.5 s later or more for a tile not loaded yet. Keeping the cache is the better choice for parked and taxiing aircraft, which are the common case.

# WP-B-V3 — Browse Camera + Street Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When nothing is selected, the app looks like tar1090's map: the camera flies to a north-up, straight-down view 300 km above the last place, tilt and free-look are locked so the map stays flat, zoom is held between 2 km and 10,000 km, and an OpenStreetMap street layer covers the satellite imagery. Leaving browse hands the camera back to the chase camera with Cesium's settings as they were.

**Architecture:** Two modules.
- `client/scene/browseCamera.ts` (PLAN.md §5.3 B-V3, exactly, plus extra exports):
  - Pure helpers. `viewWidthM(heightM, fovRad = 60°)` is the ground distance a camera `heightM` up sees across `fovRad` when it looks straight down. A ray at angle θ off nadir meets a sphere of radius R at central angle `asin((R+h)/R · sin θ) − θ`. When the edge rays miss the Earth, the view ends at the horizon, `acos(R/(R+h))`. `heightForViewWidthM` is the inverse, in closed form on both branches. R is the WGS84 equatorial radius, so the helpers are exact east-west along the equator (a test checks them against the rays Cesium's own camera picks) and within 0.34 % elsewhere. Cesium's default frustum is 60° across the wider canvas axis, so the default 300 km shows about 189 nm across the wider axis (117 nm down a 16:10 canvas). A 170 nm view would need `heightForViewWidthM(170 × 1852)` ≈ 271 km. `containsDeg(rect, lat, lon)` tests a point against a rectangle and handles the antimeridian.
  - `enterBrowse(viewer, center, opts)`. The first call saves `enableTilt`, `enableLook`, `minimumZoomDistance` and `maximumZoomDistance` of the `ScreenSpaceCameraController` in a `WeakMap` keyed by the controller. An entry in the map means "browsing", so a second call (re-centre) does not save the browse values as the originals. It then locks tilt and look and sets the zoom limits. `camera.cancelFlight()` stops a browse flight that is still running (`flyTo` would cancel it, `setView` would not). `camera.lookAtTransform(Matrix4.IDENTITY)` drops a chase camera's lookAt frame. The centre is `center`, or the point under the camera (`camera.positionCartographic`) when `center` is null. The height (default 300 km) is clamped to the zoom limits. Orientation is heading 0, pitch −90°, roll 0. `flyS` 0 calls `setView`; otherwise `flyTo` runs with that duration (default 1.2 s).
  - `exitBrowse(viewer)`. When browsing, it calls `camera.cancelFlight()` (a browse flight still under way would overwrite the chase camera every frame) and restores the saved settings. When not browsing, it does nothing.
  - `viewRectangleDeg(viewer)` returns `camera.computeViewRectangle(Ellipsoid.WGS84, scratch)` in degrees. It is null when the globe is out of view. It is the whole world when fewer than two canvas corners hit the globe (Cesium then returns `Rectangle.MAX_VALUE`). west > east when the view spans the antimeridian.
  - Extra: `isBrowsing(viewer)`, the constants `BROWSE_HEIGHT_M` 300,000, `BROWSE_FLY_S` 1.2, `MIN_ZOOM_M` 2,000, `MAX_ZOOM_M` 10,000,000 and `CESIUM_FOV_RAD`, and `interface RectDeg`.
  - Why no per-frame correction: panning in 3D (left drag) spins the globe about the Earth's axis (Cesium constrains the spin to `UNIT_Z`), and zooming to the cursor moves the camera without turning it. The harness measured heading 0.0° and pitch −90.0° after drags and off-centre wheel zooms.
- `client/scene/mapLayer.ts`: `makeMapLayer(viewer, url = OSM_URL)` adds Cesium's `OpenStreetMapImageryProvider` (tile.openstreetmap.org, `maximumLevel` 19) on top of `viewer.imageryLayers`. It passes its own credit, because Cesium's default credit ("MapQuest, Open Street Map and contributors, CC-BY-SA") is outdated. The layer is muted a little (brightness 0.85, saturation 0.6) so the altitude-coloured icons stand out. `show` reads and writes `ImageryLayer.show`. Cesium creates no tile imagery for a hidden layer (`GlobeSurfaceTileProvider._onLayerShownOrHidden` → `_onLayerRemoved`) and drops its credit, so chase mode requests no OSM tiles. `destroy()` removes and destroys the layer; a second call finds nothing to remove. The optional `url` (an extra, compatible parameter) is there because the OSM policy asks that the tile server can be changed without a code change.

Conventions consumers (B-A) rely on:
- Browse → chase: `exitBrowse(viewer)`, `map.show = false`, then `ChaseCamera.update()`. Chase → browse: `chaseCam.release()` first (it gives the mouse back to Cesium's controls: `ChaseCamera` owns `enableInputs`, and this package does not touch it), then `map.show = true` and `enterBrowse(viewer, { lat, lon } of the last aircraft)`.
- The map layer starts **shown**, because the app starts in browse. With `?hex=` the app starts in chase, so set `show = false` at start-up.
- On-screen set for the table: `const r = viewRectangleDeg(viewer)`, then `r !== null && containsDeg(r, e.lat, e.lon)`. It costs 6.8 µs per call in the browser.
- The OSM attribution is Cesium's on-canvas credit line ("© OpenStreetMap contributors", linked). The policy forbids hiding it under UI, so the browse layout (right-hand table, bottom legend) must leave Cesium's bottom credit line visible. Do not give `index.html` a `no-referrer` Referrer-Policy.
- `enterBrowse` while a browse flight is running replaces that flight, also with `flyS` 0.

**Tech Stack:** CesiumJS 1.145 (`Camera.setView`/`flyTo`/`cancelFlight`/`lookAtTransform`/`computeViewRectangle`, `ScreenSpaceCameraController`, `OpenStreetMapImageryProvider`, `ImageryLayerCollection`, `Credit`), `node:test`. The Node tests drive a **real** Cesium `Camera` on the minimal fake scene of WP-V4 (canvas and drawing-buffer size, `GeographicProjection`, `SceneMode.SCENE3D`, WGS84) plus Cesium's default controller settings. For flights, the scene also has a real `TweenCollection`. Cesium exports that class at runtime, but its type definitions leave it out (it is private), so the test reaches it through a typed cast. The map-layer tests use a real `ImageryLayerCollection`; building providers and layers does no network I/O. The harness uses the app's own `createViewer` (Re:Earth terrain + EOX imagery by default, both keyless) and loads OpenStreetMap tiles.

**Wave:** B1 (parallel with the other seven B-* packages; depends only on WP-B0). Consumed by B-A. **Estimated:** 1.5 h. **Validated:** 2026-09-22 in the integrated tree (WP-00 + 26 WPs + WP-V4 orbit + WP-B0, installed `node_modules`, Node 25.2.1, Cesium 1.145.0, TypeScript 7.0.2) on the user's Mac:
- `node --test client/scene/browseCamera.test.ts client/scene/mapLayer.test.ts` → 19/19 pass (14 + 5). `npx tsc --noEmit` reports no errors in `client/scene/browseCamera*`, `client/scene/mapLayer*` or `harness/browse*`. A full `npm test` in the shared tree had 547/554 passing; all 7 failures were in other B-* packages' unfinished files (fleet layer, table, server info/routes).
- **Mutations** (13 hand-made faults): no lookAt reset, no `cancelFlight` on exit, no `cancelFlight` on a jump, settings re-saved on re-centre, tilt not locked, flat-earth width, no antimeridian wrap, no height clamp, credit off-screen, no max zoom, map not muted and layer not destroyed were each caught by 1–5 failing tests. The one survivor, "destroy not idempotent", showed that the guard was redundant (`ImageryLayerCollection.remove` of a removed layer returns false), so the guard was deleted.
- **Harness** (in-app Chromium browser, Vite on :5413, `/harness/browse.html`): start 60 km over LLBG → 1.2 s flight → 300 km: heading 0.0°, pitch −90.0°, roll 0.0°, rectangle W 32.999 S 30.628 E 36.774 N 33.367 on an 800 × 692 canvas (356 km across at mid-latitude vs `viewWidthM` 349 km: the corners reach a little further than the mid-edges), street map with the "© OpenStreetMap contributors" credit at the bottom, **27 OSM tiles** for that first view. A left drag and 5 wheel ticks at an off-centre cursor (300 km → 6.5 km): heading 0.0°, pitch −90.0°. Ctrl-drag, middle-drag and shift-drag in browse changed nothing. `C` (exitBrowse + map hidden + a low oblique view): ctrl-drag tilted again (pitch −12° → +10.9°), zoom limits back to 1 m … ∞, satellite imagery only, OSM credit gone, **0 OSM tiles requested in 6 s hidden**. Back to browse, the tiles came from the browser cache (1–3 ms each vs 70–280 ms from the network). `H` from the chase view went top-down over the point under the camera. A browse flight cancelled at 52 km by `exitBrowse` left the chase view in place (no flight running afterwards). The whole session requested 217 distinct OSM tiles. No console errors. After the harness run, one line was added (`enterBrowse` cancels a running flight before a jump). The browser could not be re-opened for it (the pane's tab limit was reached by other sessions), so the real-flight unit test covers it: without the line, the old flight carries on to its own destination.
- **Performance** (1440 × 900, DPR 1, `viewer.render()` + a 1-pixel `readPixels` GPU sync per frame, 200 frames, 300 km top-down over LLBG with 5,007 point primitives): p50 10.1–10.4 ms, p95 12.0–13.0 ms; street map on vs off differs by ≤ 0.4 ms. Without the points: no imagery 8.6 ms, OSM only 8.9 ms, OSM + satellite underneath 9.2 ms (p50). On a live, fronted tab the rAF meter showed p50 97–100 FPS (display-limited). `viewRectangleDeg` costs 6.8 µs per call.
- **Replay:** the plan's code blocks were extracted into an isolated copy (WP-00/V1 viewer, config and type files only). Task 1 Step 2 and Task 2 Step 2 failed as written, Steps 4 passed 14/14 and 5/5, `tsc --noEmit` over the whole copy (harness included) was clean, and every extracted file was byte-identical to the tested tree.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- This package creates only the six files below. It reads `client/scene/viewer.ts` and `client/config.ts` (harness only) and edits nothing else.
- Unit tests need no WebGL and no network. Only the harness page loads tiles (terrain, satellite, OpenStreetMap).
- Never request anything from adsb.lol here.

## Decision: standard OpenStreetMap tiles are acceptable (with conditions)

Read on 2026-09-22: the OSMF Tile Usage Policy, https://operations.osmfoundation.org/policies/tiles/, and the copyright page, https://www.openstreetmap.org/copyright.
- The policy allows "normal interactive viewing by a human where the client requests only the tiles needed for the current viewport", and states that modern browsers with default settings already meet its technical requirements (valid User-Agent and Referer, honouring cache headers). FlightHopper is a personal, low-volume viewer in an unmodified browser, and Cesium requests only the tiles in view. With a top-down camera there is no horizon, so it does not fetch tiles far outside the view either.
- Requirements met: visible attribution "© OpenStreetMap contributors", linked to https://www.openstreetmap.org/copyright, as an on-screen Cesium credit (typically bottom-right; must not be hidden under UI). The URL `https://tile.openstreetmap.org/{z}/{x}/{y}.png` over HTTPS. No bulk download, prefetch or offline archive: the layer is hidden in chase and a hidden layer loads nothing. No no-cache headers (Cesium sends none). No restrictive Referrer-Policy.
- Recommended and done: the tile server URL can be changed (`makeMapLayer(viewer, url)`; B-A can wire it to an env var).
- Limits: the service is best-effort with no SLA, and access "may be withdrawn at any point" for commercial services. **If FlightHopper goes public** (PLAN.md A2 "public launch → rights matrix"), move to a hosted tile provider or self-hosted tiles through the `url` parameter.
- Licence: OpenStreetMap data is ODbL 1.0; the attribution above is what the policy asks for. No tiles are shipped in the repo.
- No code, tables, icons or colours were taken from tar1090, dump1090 or any other GPL project. The harness's seven check colours are plain CSS colour names.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `client/scene/browseCamera.ts` | `enterBrowse`, `exitBrowse`, `viewRectangleDeg`, `isBrowsing`, `viewWidthM`, `heightForViewWidthM`, `containsDeg`, constants |
| `client/scene/browseCamera.test.ts` | width helpers vs Cesium's own rays, top-down pose, null centre, chase frame dropped, flight options, a real flight replaced by a jump and stopped by exit, settings restore, view rectangle (normal, out of view, whole world, antimeridian) |
| `client/scene/mapLayer.ts` | `makeMapLayer`, `MapLayer`, `OSM_URL`, `OSM_CREDIT_HTML` |
| `client/scene/mapLayer.test.ts` | layer order, tile URL, max zoom, credit, show, muting, destroy, custom server |
| `harness/browse.html`, `harness/browse.ts` | manual check over LLBG: browse on/off, control locks, OSM tile counter, FPS, `?points=N`, `?instant=1` |

---

### Task 1: Browse camera

**Files:**
- Create: `client/scene/browseCamera.ts`, `client/scene/browseCamera.test.ts`
- Test: `client/scene/browseCamera.test.ts`

**Interfaces:**
- Consumes: Cesium `Viewer` (`camera`, `scene.screenSpaceCameraController`)
- Produces: `enterBrowse(viewer: Viewer, center: { lat: number; lon: number } | null, opts?: { heightM?: number; flyS?: number }): void` · `exitBrowse(viewer: Viewer): void` · `viewRectangleDeg(viewer: Viewer): { west: number; south: number; east: number; north: number } | null` (PLAN.md §5.3 B-V3, exactly) · extras `isBrowsing(viewer): boolean`, `viewWidthM(heightM, fovRad?)`, `heightForViewWidthM(widthM, fovRad?)`, `containsDeg(r: RectDeg, lat, lon): boolean`, `interface RectDeg`, `BROWSE_HEIGHT_M`, `BROWSE_FLY_S`, `MIN_ZOOM_M`, `MAX_ZOOM_M`, `CESIUM_FOV_RAD`

- [ ] **Step 1: Write the failing test**

```ts
// client/scene/browseCamera.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Cesium from 'cesium'
import { Camera, Cartesian2, Cartesian3, Ellipsoid, GeographicProjection, HeadingPitchRange, MapMode2D, Math as CesiumMath, Matrix4, SceneMode, Transforms } from 'cesium'
import type { Viewer } from 'cesium'
import {
  BROWSE_FLY_S, BROWSE_HEIGHT_M, MAX_ZOOM_M, MIN_ZOOM_M,
  containsDeg, enterBrowse, exitBrowse, heightForViewWidthM, isBrowsing, viewRectangleDeg, viewWidthM,
} from './browseCamera.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)
const DEG = 180 / Math.PI
const A = 6_378_137 // WGS84 equatorial radius: along the equator the ellipsoid is this circle, so the helpers are exact there
const LLBG = { lat: 32.0114, lon: 34.8867 }
// Scene.tweens' class: exported at runtime, but missing from Cesium's type definitions (it is marked private).
const TweenCollection = (Cesium as unknown as { TweenCollection: new () => { update(timeS: number): void } }).TweenCollection

/**
 * A real Cesium Camera on the smallest scene its constructor, setView, picking and flights read, plus Cesium's default
 * controller settings. Flights run on a real TweenCollection: tweens.update(s) starts them on its first call, then advances.
 */
function fakeViewer() {
  const tweens = new TweenCollection()
  const scene = {
    canvas: { clientWidth: 800, clientHeight: 600 },
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    mapProjection: new GeographicProjection(),
    mode: SceneMode.SCENE3D,
    mapMode2D: MapMode2D.INFINITE_SCROLL,
    ellipsoid: Ellipsoid.WGS84,
    screenSpaceCameraController: { enableTilt: true, enableLook: true, minimumZoomDistance: 1, maximumZoomDistance: Number.POSITIVE_INFINITY },
    globe: { ellipsoid: Ellipsoid.WGS84, getHeight: () => 0 },
    tweens,
    camera: null as Camera | null,
  }
  const camera = (scene.camera = new Camera(scene as never))
  return { camera, tweens, sscc: scene.screenSpaceCameraController, viewer: { scene, camera } as unknown as Viewer }
}

const headingDeg = (cam: Camera): number => (((cam.heading * DEG) % 360) + 360) % 360
const latLonH = (cam: Camera): { lat: number; lon: number; h: number } => {
  const c = cam.positionCartographic
  return { lat: c.latitude * DEG, lon: c.longitude * DEG, h: c.height }
}

test('viewWidthM: flat-earth limit 2·h·tan(fov/2) when low, wider than that when high (the Earth curves away)', () => {
  near(viewWidthM(2_000), 2 * 2_000 * Math.tan(Math.PI / 6), 0.5)
  near(viewWidthM(1_000, Math.PI / 2), 2_000, 0.5)
  const flat = 2 * BROWSE_HEIGHT_M * Math.tan(Math.PI / 6)
  const w = viewWidthM(BROWSE_HEIGHT_M)
  assert.ok(w > flat && w < flat * 1.05, `${w} vs flat ${flat}`)
  assert.ok(w / 1852 > 185 && w / 1852 < 192, `${w / 1852} nm`) // the default browse view is about 189 nm across
})

test('viewWidthM: once the fan of rays misses the Earth, the visible cap stops at the horizon', () => {
  const tangentH = A * (1 / Math.sin(Math.PI / 6) - 1) // the edge ray grazes the Earth at this height (= A for 60°)
  near(viewWidthM(tangentH), 2 * A * (Math.PI / 3), 1e-3)
  near(viewWidthM(3 * A), 2 * A * Math.acos(1 / 4), 1e-3)
  let prev = 0
  for (const h of [1, 1e3, 1e5, 1e6, tangentH * 0.999, tangentH * 1.001, 1e7, 1e8]) {
    const w = viewWidthM(h)
    assert.ok(w > prev, `monotonic at ${h}`)
    prev = w
  }
  assert.ok(viewWidthM(1e12) < Math.PI * A)
})

test('heightForViewWidthM inverts viewWidthM on both branches; out of reach → Infinity', () => {
  for (const h of [2_000, 50_000, BROWSE_HEIGHT_M, 3_000_000, A, 2 * A, 5e7]) near(heightForViewWidthM(viewWidthM(h)), h, h * 1e-9, `h ${h}`)
  for (const fov of [Math.PI / 6, Math.PI / 2]) near(heightForViewWidthM(viewWidthM(80_000, fov), fov), 80_000, 1e-4)
  near(heightForViewWidthM(0), 0, 1e-9)
  assert.equal(heightForViewWidthM(Math.PI * A), Number.POSITIVE_INFINITY)
})

test('viewWidthM matches where Cesium’s camera actually looks: canvas mid-left to mid-right edge over the equator', () => {
  const { camera, viewer } = fakeViewer()
  for (const h of [5_000, BROWSE_HEIGHT_M, 3_000_000]) {
    enterBrowse(viewer, { lat: 0, lon: 30 }, { heightM: h, flyS: 0 })
    const left = camera.pickEllipsoid(new Cartesian2(0, 300), Ellipsoid.WGS84) as Cartesian3
    const right = camera.pickEllipsoid(new Cartesian2(800, 300), Ellipsoid.WGS84) as Cartesian3
    const dLon = Ellipsoid.WGS84.cartesianToCartographic(right).longitude - Ellipsoid.WGS84.cartesianToCartographic(left).longitude
    near(A * dLon, viewWidthM(h), viewWidthM(h) * 1e-6, `h ${h}`)
  }
})

test('enterBrowse flyS 0: north-up, straight down, 300 km above the centre; tilt and free-look locked; zoom clamped', () => {
  const { camera, sscc, viewer } = fakeViewer()
  assert.equal(isBrowsing(viewer), false)
  enterBrowse(viewer, LLBG, { flyS: 0 })
  const p = latLonH(camera)
  near(p.lat, LLBG.lat, 1e-9)
  near(p.lon, LLBG.lon, 1e-9)
  near(p.h, BROWSE_HEIGHT_M, 1e-3)
  near(Math.min(headingDeg(camera), 360 - headingDeg(camera)), 0, 1e-6, 'north up')
  near(camera.pitch * DEG, -90, 1e-6)
  near(camera.roll, 0, 1e-9)
  assert.deepEqual(sscc, { enableTilt: false, enableLook: false, minimumZoomDistance: MIN_ZOOM_M, maximumZoomDistance: MAX_ZOOM_M })
  assert.equal(MIN_ZOOM_M, 2_000)
  assert.equal(MAX_ZOOM_M, 10_000_000)
  assert.equal(isBrowsing(viewer), true)
})

test('enterBrowse center null: over the point under the current camera; heightM is clamped to the zoom limits', () => {
  const { camera, viewer } = fakeViewer()
  camera.setView({ destination: Cartesian3.fromDegrees(11.34, 47.26, 1_500), orientation: { heading: 1, pitch: -0.2, roll: 0 } })
  enterBrowse(viewer, null, { heightM: 50, flyS: 0 })
  const p = latLonH(camera)
  near(p.lat, 47.26, 1e-9)
  near(p.lon, 11.34, 1e-9)
  near(p.h, MIN_ZOOM_M, 1e-3)
  enterBrowse(viewer, null, { heightM: 1e9, flyS: 0 })
  near(latLonH(camera).h, MAX_ZOOM_M, 1e-2)
  near(latLonH(camera).lon, 11.34, 1e-9)
})

test('enterBrowse from a chase camera: the lookAt frame is dropped first, so the view lands where asked', () => {
  const { camera, viewer } = fakeViewer()
  const target = Cartesian3.fromDegrees(LLBG.lon, LLBG.lat, 600)
  camera.lookAtTransform(Transforms.eastNorthUpToFixedFrame(target), new HeadingPitchRange(2, -0.2, 150))
  assert.ok(!Matrix4.equals(camera.transform, Matrix4.IDENTITY))
  enterBrowse(viewer, null, { flyS: 0 })
  assert.ok(Matrix4.equals(camera.transform, Matrix4.IDENTITY))
  const p = latLonH(camera)
  near(p.lat, LLBG.lat, 0.01, 'the chase camera was within 150 m of LLBG')
  near(p.lon, LLBG.lon, 0.01)
  near(p.h, BROWSE_HEIGHT_M, 1e-3)
})

test('enterBrowse default: a 1.2 s flight to the top-down view; flyS sets the duration', () => {
  const { camera, viewer } = fakeViewer()
  const flights: { destination: Cartesian3; orientation: { heading: number; pitch: number; roll: number }; duration: number }[] = []
  camera.flyTo = ((o: (typeof flights)[number]) => void flights.push(o)) as never
  enterBrowse(viewer, LLBG)
  enterBrowse(viewer, LLBG, { flyS: 3, heightM: 40_000 })
  assert.equal(BROWSE_FLY_S, 1.2)
  assert.equal(flights.length, 2)
  assert.equal(flights[0].duration, 1.2)
  assert.deepEqual(flights[0].orientation, { heading: 0, pitch: -Math.PI / 2, roll: 0 })
  assert.ok(Cartesian3.equalsEpsilon(flights[0].destination, Cartesian3.fromDegrees(LLBG.lon, LLBG.lat, BROWSE_HEIGHT_M), 0, 1e-6))
  assert.equal(flights[1].duration, 3)
  assert.ok(Cartesian3.equalsEpsilon(flights[1].destination, Cartesian3.fromDegrees(LLBG.lon, LLBG.lat, 40_000), 0, 1e-6))
})

test('a real 1.2 s flight: a jump while it runs replaces it, and exitBrowse stops it where it is', () => {
  const { camera, tweens, viewer } = fakeViewer()
  const EILAT = { lat: 29.56, lon: 34.95 }
  camera.setView({ destination: Cartesian3.fromDegrees(LLBG.lon, LLBG.lat, 60_000) })
  enterBrowse(viewer, EILAT)
  tweens.update(0)
  tweens.update(0.6)
  const mid = latLonH(camera).lat
  assert.ok(mid < LLBG.lat && mid > EILAT.lat, `halfway: ${mid}`)
  enterBrowse(viewer, LLBG, { flyS: 0 })
  tweens.update(5)
  near(latLonH(camera).lat, LLBG.lat, 1e-9, 'the jump stands; the old flight did not carry on to Eilat')
  near(latLonH(camera).h, BROWSE_HEIGHT_M, 1e-3)
  enterBrowse(viewer, EILAT)
  tweens.update(10)
  tweens.update(10.6)
  exitBrowse(viewer)
  const stopped = latLonH(camera)
  tweens.update(20)
  assert.deepEqual(latLonH(camera), stopped, 'nothing left to move the camera under the chase camera')
  assert.ok(stopped.lat < LLBG.lat && stopped.lat > EILAT.lat)
})

test('exitBrowse restores the controller settings from before browse, cancels a running browse flight, and is idempotent; a jump cancels too', () => {
  const { camera, sscc, viewer } = fakeViewer()
  sscc.minimumZoomDistance = 5 // some caller's own setting survives the round trip
  let cancels = 0
  camera.cancelFlight = () => void cancels++
  exitBrowse(viewer)
  assert.equal(cancels, 0, 'not browsing: nothing to cancel')
  enterBrowse(viewer, LLBG, { flyS: 0 })
  enterBrowse(viewer, LLBG, { flyS: 0 }) // re-centring must not save the browse settings as the originals
  assert.equal(cancels, 2, 'a jump stops a browse flight that may still be running')
  exitBrowse(viewer)
  assert.deepEqual(sscc, { enableTilt: true, enableLook: true, minimumZoomDistance: 5, maximumZoomDistance: Number.POSITIVE_INFINITY })
  assert.equal(cancels, 3)
  assert.equal(isBrowsing(viewer), false)
  exitBrowse(viewer)
  assert.equal(cancels, 3)
  assert.equal(sscc.minimumZoomDistance, 5)
})

test('viewRectangleDeg: the ground under a top-down view, in degrees', () => {
  const { viewer } = fakeViewer()
  enterBrowse(viewer, LLBG, { flyS: 0 })
  const r = viewRectangleDeg(viewer)
  assert.ok(r)
  assert.ok(containsDeg(r, LLBG.lat, LLBG.lon))
  near((r.west + r.east) / 2, LLBG.lon, 0.01, 'centred east-west')
  assert.ok(r.north - LLBG.lat > 0 && LLBG.lat - r.south > 0)
  // The corners sit a little further out than the mid-edges, so the rectangle is a bit wider than viewWidthM.
  const widthM = ((r.east - r.west) / DEG) * A * Math.cos(LLBG.lat / DEG)
  assert.ok(widthM > viewWidthM(BROWSE_HEIGHT_M) && widthM < viewWidthM(BROWSE_HEIGHT_M) * 1.1, `${widthM}`)
  const heightM = ((r.north - r.south) / DEG) * A
  near(heightM / widthM, 600 / 800, 0.05, '4:3 canvas')
})

test('viewRectangleDeg: null when the globe is out of view; the whole world when zoomed right out', () => {
  const { camera, viewer } = fakeViewer()
  camera.setView({ destination: Cartesian3.fromDegrees(LLBG.lon, LLBG.lat, BROWSE_HEIGHT_M), orientation: { heading: 0, pitch: CesiumMath.PI_OVER_TWO, roll: 0 } })
  assert.equal(viewRectangleDeg(viewer), null)
  enterBrowse(viewer, LLBG, { heightM: MAX_ZOOM_M, flyS: 0 })
  const r = viewRectangleDeg(viewer)
  assert.ok(r && containsDeg(r, LLBG.lat, LLBG.lon) && r.east - r.west > 90, JSON.stringify(r))
})

test('viewRectangleDeg across the antimeridian: west > east, and containsDeg handles the wrap', () => {
  const { viewer } = fakeViewer()
  enterBrowse(viewer, { lat: 0, lon: 180 }, { flyS: 0 })
  const r = viewRectangleDeg(viewer)
  assert.ok(r && r.west > r.east, JSON.stringify(r))
  assert.ok(containsDeg(r, 0, 179.9))
  assert.ok(containsDeg(r, 0, -179.9))
  assert.ok(!containsDeg(r, 0, 0))
  assert.ok(!containsDeg(r, 10, 180))
})

test('containsDeg: edges inclusive; latitude outside → false', () => {
  const r = { west: 30, south: 29, east: 36, north: 34 }
  assert.ok(containsDeg(r, 32, 34.9))
  assert.ok(containsDeg(r, 29, 30) && containsDeg(r, 34, 36))
  assert.ok(!containsDeg(r, 28.99, 32) && !containsDeg(r, 34.01, 32))
  assert.ok(!containsDeg(r, 32, 29.99) && !containsDeg(r, 32, 36.01))
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/scene/browseCamera.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/scene/browseCamera.ts' imported from …/client/scene/browseCamera.test.ts`

- [ ] **Step 3: Write the implementation**

```ts
// client/scene/browseCamera.ts
// Browse mode's camera: a north-up, straight-down view like a slippy map. Tilt and free-look are locked so the map stays
// flat; Cesium's own controls still pan (drag) and zoom (wheel, right-drag), within MIN_ZOOM_M … MAX_ZOOM_M.
import { Cartesian3, Ellipsoid, Math as CesiumMath, Matrix4, Rectangle } from 'cesium'
import type { ScreenSpaceCameraController, Viewer } from 'cesium'

export const BROWSE_HEIGHT_M = 300_000 // ≈ 189 nm across the wider canvas axis (viewWidthM)
export const BROWSE_FLY_S = 1.2
export const MIN_ZOOM_M = 2_000
export const MAX_ZOOM_M = 10_000_000
/** Cesium's default PerspectiveFrustum.fov (60°). It spans the wider canvas axis. */
export const CESIUM_FOV_RAD = Math.PI / 3
// ponytail: the helpers treat the Earth as a sphere of the WGS84 equatorial radius: exact east-west along the equator,
// ≤ 0.34 % off elsewhere. Upgrade: pick the camera's rays against Ellipsoid.WGS84 (viewRectangleDeg already does).
const EARTH_R = 6_378_137

/** Visible ground rectangle in degrees. west > east when it spans the antimeridian. */
export interface RectDeg {
  west: number
  south: number
  east: number
  north: number
}

/**
 * Ground distance (m) spanned by a fan of rays fovRad wide, from a camera heightM up looking straight down.
 * A ray at angle θ off nadir meets the sphere at central angle asin((R+h)/R · sin θ) − θ. Once the edge rays miss the
 * Earth, the visible cap stops at the horizon, acos(R/(R+h)).
 */
export function viewWidthM(heightM: number, fovRad: number = CESIUM_FOV_RAD): number {
  const half = fovRad / 2
  const k = ((EARTH_R + heightM) / EARTH_R) * Math.sin(half)
  const phi = k <= 1 ? Math.asin(k) - half : Math.acos(EARTH_R / (EARTH_R + heightM))
  return 2 * EARTH_R * phi
}

/** Inverse of viewWidthM: the camera height that shows widthM across fovRad. Infinity when no height can. */
export function heightForViewWidthM(widthM: number, fovRad: number = CESIUM_FOV_RAD): number {
  const half = fovRad / 2
  const phi = widthM / (2 * EARTH_R)
  if (phi <= Math.PI / 2 - half) return EARTH_R * (Math.sin(half + phi) / Math.sin(half) - 1)
  if (phi < Math.PI / 2) return EARTH_R / Math.cos(phi) - EARTH_R
  return Number.POSITIVE_INFINITY
}

/** Is (lat, lon) inside r? Edges count as inside; a rectangle with west > east wraps across the antimeridian. */
export function containsDeg(r: RectDeg, lat: number, lon: number): boolean {
  if (lat < r.south || lat > r.north) return false
  return r.west <= r.east ? lon >= r.west && lon <= r.east : lon >= r.west || lon <= r.east
}

type Saved = Pick<ScreenSpaceCameraController, 'enableTilt' | 'enableLook' | 'minimumZoomDistance' | 'maximumZoomDistance'>
/** The controller settings from before browse, keyed by controller; present = browsing. */
const saved = new WeakMap<object, Saved>()

export function isBrowsing(viewer: Viewer): boolean {
  return saved.has(viewer.scene.screenSpaceCameraController)
}

/**
 * Fly to a north-up top-down view (heading 0, pitch −90°) heightM above center, or above the point under the camera when
 * center is null. flyS 0 jumps. Locks tilt and free-look and clamps zoom until exitBrowse; calling it again re-centres.
 * Call ChaseCamera.release() first: it hands the mouse back to Cesium's controls.
 */
export function enterBrowse(viewer: Viewer, center: { lat: number; lon: number } | null, opts: { heightM?: number; flyS?: number } = {}): void {
  const camera = viewer.camera
  const sscc = viewer.scene.screenSpaceCameraController
  if (!saved.has(sscc)) {
    const { enableTilt, enableLook, minimumZoomDistance, maximumZoomDistance } = sscc
    saved.set(sscc, { enableTilt, enableLook, minimumZoomDistance, maximumZoomDistance })
  }
  sscc.enableTilt = false
  sscc.enableLook = false
  sscc.minimumZoomDistance = MIN_ZOOM_M
  sscc.maximumZoomDistance = MAX_ZOOM_M

  camera.cancelFlight() // flyTo cancels a running flight itself; setView alone would leave it running
  camera.lookAtTransform(Matrix4.IDENTITY) // a chase camera leaves its lookAt frame on the camera
  const under = camera.positionCartographic
  const lat = center ? center.lat : CesiumMath.toDegrees(under.latitude)
  const lon = center ? center.lon : CesiumMath.toDegrees(under.longitude)
  const heightM = CesiumMath.clamp(opts.heightM ?? BROWSE_HEIGHT_M, MIN_ZOOM_M, MAX_ZOOM_M)
  const destination = Cartesian3.fromDegrees(lon, lat, heightM)
  const orientation = { heading: 0, pitch: -CesiumMath.PI_OVER_TWO, roll: 0 }
  const flyS = Math.max(0, opts.flyS ?? BROWSE_FLY_S)
  if (flyS === 0) camera.setView({ destination, orientation })
  else camera.flyTo({ destination, orientation, duration: flyS })
}

/** Leave browse: stop a browse flight still under way (it would fight the chase camera) and restore the controller settings. */
export function exitBrowse(viewer: Viewer): void {
  const sscc = viewer.scene.screenSpaceCameraController
  const before = saved.get(sscc)
  if (!before) return
  viewer.camera.cancelFlight()
  Object.assign(sscc, before)
  saved.delete(sscc)
}

const scratchRect = new Rectangle()

/** The ground the camera sees (Camera.computeViewRectangle, WGS84), in degrees; null when the globe is out of view. */
export function viewRectangleDeg(viewer: Viewer): RectDeg | null {
  const r = viewer.camera.computeViewRectangle(Ellipsoid.WGS84, scratchRect)
  if (!r) return null
  const d = CesiumMath.toDegrees
  return { west: d(r.west), south: d(r.south), east: d(r.east), north: d(r.north) }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/scene/browseCamera.test.ts`
Expected: PASS — `ℹ tests 14`, `ℹ pass 14`, `ℹ fail 0`.

- [ ] **Step 5: Type-check this file**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/browseCamera'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 6: Commit**

```bash
git add client/scene/browseCamera.ts client/scene/browseCamera.test.ts
git commit -m "feat(scene): north-up top-down browse camera with locked tilt and zoom limits" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Street map layer

**Files:**
- Create: `client/scene/mapLayer.ts`, `client/scene/mapLayer.test.ts`
- Test: `client/scene/mapLayer.test.ts`

**Interfaces:**
- Consumes: Cesium `Viewer` (`imageryLayers`); the base imagery layer from WP-V1 `createViewer` stays underneath
- Produces: `makeMapLayer(viewer: Viewer): { show: boolean; destroy(): void }` (PLAN.md §5.3 B-V3; extra optional second parameter `url: string = OSM_URL`) · `interface MapLayer` · `OSM_URL` · `OSM_CREDIT_HTML`

- [ ] **Step 1: Write the failing test**

```ts
// client/scene/mapLayer.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ImageryLayer, ImageryLayerCollection, OpenStreetMapImageryProvider, UrlTemplateImageryProvider } from 'cesium'
import type { Viewer } from 'cesium'
import { OSM_CREDIT_HTML, OSM_URL, makeMapLayer } from './mapLayer.ts'

/** Just the imagery collection, with a satellite-like base layer already in it. Nothing here touches the network. */
function fakeViewer() {
  const imageryLayers = new ImageryLayerCollection()
  const base = imageryLayers.addImageryProvider(new UrlTemplateImageryProvider({ url: 'https://satellite.invalid/{z}/{x}/{y}.jpg' }))
  return { imageryLayers, base, viewer: { imageryLayers } as unknown as Viewer }
}

test('makeMapLayer: one OpenStreetMap layer on top of the base layer, standard tile URL, zoom ≤ 19', () => {
  const { imageryLayers, base, viewer } = fakeViewer()
  makeMapLayer(viewer)
  assert.equal(imageryLayers.length, 2)
  assert.equal(imageryLayers.get(0), base, 'the satellite layer stays underneath')
  const provider = imageryLayers.get(1).imageryProvider as OpenStreetMapImageryProvider
  assert.ok(provider instanceof OpenStreetMapImageryProvider)
  assert.equal(OSM_URL, 'https://tile.openstreetmap.org/')
  assert.equal(provider.url, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png')
  assert.equal(provider.maximumLevel, 19)
})

test('makeMapLayer: the credit is OSMF’s required attribution, linked to the copyright page, shown on screen', () => {
  const { imageryLayers, viewer } = fakeViewer()
  makeMapLayer(viewer)
  const credit = imageryLayers.get(1).imageryProvider.credit
  assert.equal(credit.html, OSM_CREDIT_HTML)
  assert.match(credit.html, /© <a href="https:\/\/www\.openstreetmap\.org\/copyright"[^>]*>OpenStreetMap<\/a> contributors/)
  assert.equal(credit.showOnScreen, true)
})

test('show: starts shown (the app starts in browse) and switches the layer; a hidden layer loads no tiles', () => {
  const { imageryLayers, viewer } = fakeViewer()
  const map = makeMapLayer(viewer)
  const layer = imageryLayers.get(1)
  assert.equal(map.show, true)
  assert.equal(layer.show, true)
  map.show = false
  assert.equal(map.show, false)
  assert.equal(layer.show, false)
  map.show = true
  assert.equal(layer.show, true)
})

test('the street map is muted a little so the altitude colours stand out; the base layer is untouched', () => {
  const { imageryLayers, base, viewer } = fakeViewer()
  makeMapLayer(viewer)
  const layer = imageryLayers.get(1)
  assert.ok(layer.brightness < 1 && layer.brightness > 0.5, `${layer.brightness}`)
  assert.ok(layer.saturation < 1 && layer.saturation > 0.3, `${layer.saturation}`)
  assert.equal(base.brightness, ImageryLayer.DEFAULT_BRIGHTNESS)
})

test('destroy removes only the street map and is idempotent; another tile server can be passed in', () => {
  const { imageryLayers, base, viewer } = fakeViewer()
  const map = makeMapLayer(viewer)
  const layer = imageryLayers.get(1)
  map.destroy()
  map.destroy()
  assert.equal(imageryLayers.length, 1)
  assert.equal(imageryLayers.get(0), base)
  assert.equal(layer.isDestroyed(), true)
  makeMapLayer(viewer, 'https://tiles.example.org/osm')
  assert.equal((imageryLayers.get(1).imageryProvider as OpenStreetMapImageryProvider).url, 'https://tiles.example.org/osm/{z}/{x}/{y}.png')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/scene/mapLayer.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/scene/mapLayer.ts' imported from …/client/scene/mapLayer.test.ts`

- [ ] **Step 3: Write the implementation**

```ts
// client/scene/mapLayer.ts
// Browse mode's street map: standard OpenStreetMap raster tiles as an imagery layer above the satellite base layer.
//
// Tile usage policy (https://operations.osmfoundation.org/policies/tiles/, read 2026-09-22): normal interactive viewing
// by a human, where the client requests only the tiles for the current viewport, is allowed. Browsers with default
// settings already send the User-Agent and Referer it requires, and keep the tile cache headers. What we must do:
// (1) show "© OpenStreetMap contributors" linked to https://www.openstreetmap.org/copyright, visible on the map, and
// (2) never bulk-download or prefetch. Cesium requests only the tiles in view, and a hidden layer loads none, so chase
// mode costs OSM nothing. Do not set a no-referrer Referrer-Policy on the page. Access is best-effort and can be
// withdrawn: pass another tile server's URL (the policy asks that the URL can be changed without a code change).
import { Credit, OpenStreetMapImageryProvider } from 'cesium'
import type { Viewer } from 'cesium'

export const OSM_URL = 'https://tile.openstreetmap.org/'
export const OSM_CREDIT_HTML = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
const OSM_MAX_ZOOM = 19 // the standard layer's deepest zoom; browse never zooms past ~z15 (MIN_ZOOM_M)
// Muted a little so the altitude-coloured icons (orange … magenta) stand out on the white and yellow streets.
const BRIGHTNESS = 0.85
const SATURATION = 0.6

export interface MapLayer {
  show: boolean
  destroy(): void
}

/**
 * Adds the street map on top of the viewer's imagery (the satellite base layer stays underneath). It starts shown, because
 * the app starts in browse: set show = false for chase. url replaces the OSM tile server ({z}/{x}/{y}.png is appended).
 */
export function makeMapLayer(viewer: Viewer, url: string = OSM_URL): MapLayer {
  const provider = new OpenStreetMapImageryProvider({ url, maximumLevel: OSM_MAX_ZOOM, credit: new Credit(OSM_CREDIT_HTML, true) })
  const layer = viewer.imageryLayers.addImageryProvider(provider)
  layer.brightness = BRIGHTNESS
  layer.saturation = SATURATION
  return {
    get show(): boolean {
      return layer.show
    },
    set show(v: boolean) {
      layer.show = v
    },
    destroy(): void {
      viewer.imageryLayers.remove(layer, true) // a second call finds nothing to remove
    },
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/scene/mapLayer.test.ts`
Expected: PASS — `ℹ tests 5`, `ℹ pass 5`, `ℹ fail 0`.

- [ ] **Step 5: Type-check this file**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/mapLayer'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 6: Commit**

```bash
git add client/scene/mapLayer.ts client/scene/mapLayer.test.ts
git commit -m "feat(scene): OpenStreetMap street layer for browse, attributed, hidden in chase" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Harness page

**Files:**
- Create: `harness/browse.html`, `harness/browse.ts`

**Interfaces:**
- Consumes: `enterBrowse`, `exitBrowse`, `isBrowsing`, `viewRectangleDeg`, `viewWidthM` (Task 1), `makeMapLayer` (Task 2), `createViewer` (WP-V1), `readConfig` (WP-00); the Vite setup from WP-00
- Produces: the page `/harness/browse.html` (`?terrain=` / `?imagery=` as in the viewer harness, `?instant=1`, `?points=N`) and, for console checks, `window.harness = { viewer, map, osm, fps, enterBrowse, exitBrowse, isBrowsing, viewRectangleDeg, browse, chase }`

- [ ] **Step 1: Write the page**

```html
<!-- harness/browse.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Harness: browse camera + map</title>
    <style>
      html, body, #globe { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
      #panel { position: absolute; top: 8px; left: 8px; z-index: 1; max-width: calc(100% - 32px); padding: 6px 8px;
        font: 12px/1.45 ui-monospace, monospace; color: #fff; background: rgba(0, 0, 0, 0.7); border-radius: 4px; }
      #panel button { font: inherit; margin: 0 4px 6px 0; }
      #status { white-space: pre; }
    </style>
  </head>
  <body>
    <div id="globe"></div>
    <div id="panel">
      <div>
        <button id="browse">browse over LLBG (B)</button>
        <button id="here">browse here (H)</button>
        <button id="chase">chase view (C)</button>
      </div>
      <div id="status">loading…</div>
    </div>
    <script type="module" src="./browse.ts"></script>
  </body>
</html>
```

```ts
// harness/browse.ts
// WP-B-V3 harness: /harness/browse.html starts over LLBG and flies into browse (north-up, top-down, street map).
// B = browse over LLBG, H = browse over the point under the camera, C = leave browse for a low oblique "chase" view
// (street map hidden, tilt unlocked). The panel shows the camera, the view rectangle, the controller locks, how many
// OSM tiles the page has requested, and FPS. Query: ?terrain= / ?imagery= as in the viewer harness, ?instant=1 jumps
// instead of flying, ?points=5000 adds that many coloured points near LLBG (FPS with a crowded view).
import { Cartesian3, Color, Math as CesiumMath, PointPrimitiveCollection, type Viewer } from 'cesium'
import { readConfig } from '../client/config.ts'
import { enterBrowse, exitBrowse, isBrowsing, viewRectangleDeg, viewWidthM } from '../client/scene/browseCamera.ts'
import { makeMapLayer } from '../client/scene/mapLayer.ts'
import { createViewer } from '../client/scene/viewer.ts'

const LLBG = { lat: 32.0114, lon: 34.8867 }
const COLORS = ['darkorange', 'gold', 'limegreen', 'cyan', 'dodgerblue', 'magenta', 'gray'].map((c) => Color.fromCssColorString(c))
const status = document.getElementById('status')!
const q = new URLSearchParams(location.search)
const flyS = q.get('instant') === '1' ? 0 : undefined

/** Contrast check: seven coloured dots in a row east of LLBG, plus ?points=N scattered ones. */
function addPoints(viewer: Viewer, n: number): void {
  const pts = viewer.scene.primitives.add(new PointPrimitiveCollection()) as PointPrimitiveCollection
  COLORS.forEach((color, i) => pts.add({ position: Cartesian3.fromDegrees(LLBG.lon + 0.15 + i * 0.12, LLBG.lat, 3000), color, pixelSize: 9, outlineColor: Color.BLACK, outlineWidth: 1 }))
  for (let i = 0; i < n; i++) {
    const lon = LLBG.lon + (Math.random() - 0.5) * 3
    const lat = LLBG.lat + (Math.random() - 0.5) * 3
    pts.add({ position: Cartesian3.fromDegrees(lon, lat, 1000 + Math.random() * 11000), color: COLORS[i % COLORS.length], pixelSize: 6 })
  }
}

/** Frame intervals from postRender into a fixed ring; p50 and p5 FPS over the last 240 frames. */
function fpsMeter(viewer: Viewer): { fps(): { p50: number; p5: number; frames: number } } {
  const ring = new Float64Array(240)
  const sorted = new Float64Array(240)
  let n = 0
  let last = -1
  viewer.scene.postRender.addEventListener(() => {
    const now = performance.now()
    if (last >= 0) ring[n++ % ring.length] = now - last
    last = now
  })
  return {
    fps() {
      const k = Math.min(n, ring.length)
      if (k === 0) return { p50: 0, p5: 0, frames: 0 }
      sorted.set(ring)
      const s = sorted.subarray(0, k).sort()
      return { p50: 1000 / s[Math.floor(k * 0.5)], p5: 1000 / s[Math.min(k - 1, Math.floor(k * 0.95))], frames: n }
    },
  }
}

try {
  const cfg = readConfig({
    VITE_TERRAIN: q.get('terrain') ?? import.meta.env.VITE_TERRAIN,
    VITE_IMAGERY: q.get('imagery') ?? import.meta.env.VITE_IMAGERY,
    VITE_CESIUM_ION_TOKEN: import.meta.env.VITE_CESIUM_ION_TOKEN,
    VITE_API_BASE: import.meta.env.VITE_API_BASE,
  })
  const viewer = await createViewer('globe', cfg)
  const map = makeMapLayer(viewer)
  addPoints(viewer, Number(q.get('points') ?? 0))
  const meter = fpsMeter(viewer)

  // Count the OSM tiles this page requests (policy check: viewport only, nothing while hidden).
  const osm = { tiles: 0, whileHidden: 0 }
  let hiddenSinceMs: number | null = null
  performance.setResourceTimingBufferSize(10_000)
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (!e.name.includes('tile.openstreetmap.org')) continue
      osm.tiles++
      if (hiddenSinceMs !== null && e.startTime >= hiddenSinceMs) osm.whileHidden++
    }
  }).observe({ type: 'resource', buffered: true })

  const browse = (center: { lat: number; lon: number } | null): void => {
    map.show = true
    hiddenSinceMs = null
    enterBrowse(viewer, center, { flyS })
  }
  const chase = (): void => {
    exitBrowse(viewer)
    map.show = false
    hiddenSinceMs = performance.now()
    // Stand-in for the chase camera: low and oblique over LLBG's runway 30, looking along it.
    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(34.905, 31.995, 700),
      orientation: { heading: CesiumMath.toRadians(300), pitch: CesiumMath.toRadians(-12), roll: 0 },
    })
  }
  document.getElementById('browse')!.onclick = () => browse(LLBG)
  document.getElementById('here')!.onclick = () => browse(null)
  document.getElementById('chase')!.onclick = chase
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase()
    if (k === 'b') browse(LLBG)
    else if (k === 'h') browse(null)
    else if (k === 'c') chase()
  })

  // Start as the app does (60 km over the hero airport, straight down), then fly into browse.
  viewer.camera.setView({ destination: Cartesian3.fromDegrees(LLBG.lon, LLBG.lat, 60_000) })
  browse(LLBG)

  const sscc = viewer.scene.screenSpaceCameraController
  const f1 = (x: number): string => x.toFixed(1)
  const f3 = (x: number): string => x.toFixed(3)
  setInterval(() => {
    const cam = viewer.camera
    const c = cam.positionCartographic
    const r = viewRectangleDeg(viewer)
    // East-west span of the rectangle at its middle latitude (west > east wraps the antimeridian).
    const spanDeg = r ? (r.east - r.west + 360) % 360 || 360 : 0
    const widthKm = r ? (CesiumMath.toRadians(spanDeg) * 6_378.137 * Math.cos(CesiumMath.toRadians((r.north + r.south) / 2))) : null
    const fps = meter.fps()
    status.textContent = [
      `mode      ${isBrowsing(viewer) ? 'browse' : 'chase view'}   map.show ${map.show}`,
      `camera    lat ${f3(CesiumMath.toDegrees(c.latitude))} lon ${f3(CesiumMath.toDegrees(c.longitude))} h ${(c.height / 1000).toFixed(2)} km`,
      `          heading ${f1(CesiumMath.toDegrees(cam.heading))}° pitch ${f1(CesiumMath.toDegrees(cam.pitch))}° roll ${f1(CesiumMath.toDegrees(cam.roll))}°`,
      `rect      ${r ? `W ${f3(r.west)} S ${f3(r.south)} E ${f3(r.east)} N ${f3(r.north)}` : 'null'}`,
      `width     rect ${widthKm === null ? '—' : widthKm.toFixed(0)} km (mid-lat)   viewWidthM(h) ${(viewWidthM(c.height) / 1000).toFixed(0)} km`,
      `controls  tilt ${sscc.enableTilt} look ${sscc.enableLook} zoom ${sscc.minimumZoomDistance}…${sscc.maximumZoomDistance} m`,
      `osm tiles ${osm.tiles} requested, ${osm.whileHidden} while hidden   globe tilesLoaded ${viewer.scene.globe.tilesLoaded}`,
      `fps       p50 ${f1(fps.p50)}  p5 ${f1(fps.p5)}  (last ${Math.min(fps.frames, 240)} of ${fps.frames} frames)`,
    ].join('\n')
  }, 250)

  ;(window as unknown as { harness: object }).harness = { viewer, map, osm, fps: meter.fps, enterBrowse, exitBrowse, isBrowsing, viewRectangleDeg, browse, chase }
} catch (err) {
  status.textContent = `error: ${(err as Error).message}`
  status.style.color = '#ff8080'
}
```

- [ ] **Step 2: Type-check the harness**

Run: `npx tsc --noEmit 2>&1 | grep -E 'harness/browse'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Check it in a browser**

Run: `npx vite --port 5413 --strictPort` and open `http://localhost:5413/harness/browse.html` (pick any free port; never reuse the app's own dev server port).
Expected:
1. After about 2 s: `mode browse map.show true`, `heading 360.0° pitch -90.0° roll 0.0°` (360 = 0), `h 300.00 km` over `lat 32.011 lon 34.887`, a street map of Israel with seven coloured check dots east of Tel Aviv, and `© OpenStreetMap contributors` in Cesium's credit line. `osm tiles` is a few dozen (27 on an 800 × 692 canvas). The `width` line shows the rectangle a few per cent wider than `viewWidthM(h)`.
2. Drag the map and wheel-zoom with the cursor off-centre: the map pans and zooms, `heading` stays 0 (shown as 360.0°), `pitch` stays −90.0°, and height stays between 2 km and 10,000 km. Ctrl-drag, middle-drag and shift-drag do not tilt or turn it. `controls tilt false look false zoom 2000…10000000 m`.
3. Press `C`: `mode chase view map.show false`, a low oblique satellite view along LLBG's runway, the OSM credit gone, `controls tilt true look true zoom 1…Infinity m`, and ctrl-drag tilts again. `osm tiles … 0 while hidden` stays 0.
4. Press `H`: the camera flies top-down over the point it was above; `B` flies back over LLBG.
5. Optional load check: `?points=5000` adds 5,000 dots; `fps` p50 stays at the display rate.
The console shows no errors. Stop Vite when done.

- [ ] **Step 4: Commit**

```bash
git add harness/browse.html harness/browse.ts
git commit -m "test(harness): browse camera and street map over LLBG" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: WP gate

- [ ] **Step 1: This package's tests**

Run: `node --test client/scene/browseCamera.test.ts client/scene/mapLayer.test.ts`
Expected: `ℹ tests 19`, `ℹ pass 19`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/(browseCamera|mapLayer)|harness/browse'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Full check**

Run: `npm run check`
Expected: `tsc` prints nothing and every test passes. On WP-B0's tree (460 tests) plus this package, that is `ℹ tests 479`, `ℹ pass 479`, `ℹ fail 0`. With other B-* packages merged, the total is higher and `fail` is still 0.

- [ ] **Step 4: Confirm there is nothing left to commit**

Run: `git status --short`
Expected: no output.

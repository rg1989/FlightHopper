# WP-E2 — Sun Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Light the chase view from the real sun (`.planning/terrain-sun-design.md` D8–D10, D12, D13, §4). Terrain slopes and the aircraft are shaded by a light that follows the sun but never comes from below the horizon. Golden hour gives a warm light and a lifted ambient floor. At night the land darkens, a dim light from straight overhead keeps the relief readable, the aircraft's ambient light is dimmed, and NASA GIBS city lights fade in. Browse, or the user's Sun toggle off, gives the unlit daytime map with a fixed high light on the aircraft. No cast shadows. This package delivers the modules and a harness page. E-A wires them into the app.

**Architecture:** Two modules and a harness page. Everything is a port of the PoC (`plans/assets/WP-E/poc/terrain-sun.ts`: `toSun`, `aimLight`, `night01`, `golden01`), which was checked in screenshots 02–04.
- `client/scene/nightLights.ts`: `NIGHT_URL` (GIBS WMTS `VIIRS_Black_Marble`, the 2016 composite, `GoogleMapsCompatible_Level8`, `{z}/{y}/{x}.png`), `NIGHT_MAX_LEVEL = 8` (GIBS answers z9 with HTTP 400), `NIGHT_CREDIT` (the acknowledgment GIBS asks for, plus "VIIRS Black Marble 2016"). `makeNightLayer()` returns an `ImageryLayer` over a `UrlTemplateImageryProvider` with alpha 0, `show: false` and brightness 1.6. Constructing it requests nothing (a test records `fetch`). ponytail: level 8 is about 600 m/px, so at chase range the lights are a soft glow; there is no sharper keyless source.
- `client/scene/sun.ts`, pure helpers (tested in Node):
  - `sunDirectionWC(jd, result)`: the unit vector Earth → Sun in the Earth-fixed frame, the way Cesium's `UniformState` computes `czm_sunDirectionWC`: Simon 1994 in the inertial frame, then `Transforms.computeIcrfToFixedMatrix(jd) ?? computeTemeToPseudoFixedMatrix(jd)`. The ICRF matrix needs Cesium's IAU 2006 XYS table, which Cesium fetches from `/cesiumStatic/Assets` on first use. In the browser the ICRF frame is used after the first frames. In Node (no `CESIUM_BASE_URL`) the request is a `file:` URL that `fetch` rejects, so Node tests run on TEME. The two differ by 0.37° (VERIFY C4), so the test tolerance is 0.5°.
  - `sunElevationDeg(sunWC, posWC)`: `asin(up · sun)` in degrees, with `up = Ellipsoid.WGS84.geodeticSurfaceNormal(posWC)`.
  - `sunLook(elevDeg, result?)`: the §4 constants. `night = smoothstep((2 − el)/10)` (0 at +2°, 1 at −8°). `golden = smoothstep((15 − el)/15)·(1 − night)`, the warmth actually applied (0 in full day and at full night). Light intensity `2 + (0.45 − 2)·night`. Colour `(1, 1 − 0.2·golden, 1 − 0.38·golden)` (white → (1.0, 0.8, 0.62)). `vertexShadowDarkness = 0.3 + 0.2·golden`. Day brightness `min(0.9999, 1 − 0.7·night)`. Night alpha `min(0.9999, night)`. Model IBL factor `1 − 0.85·night`. The day brightness never reaches 1, so the `APPLY_BRIGHTNESS` shader variant stays compiled (research C20). The night alpha never reaches 1 either: at alpha 1 Cesium switches `APPLY_ALPHA` off and compiles another globe program at the first full night. The night layer's first draw (near +1.4°) still compiles the globe's shaders once, because tiles gain a second texture. The layer is hidden by day (no tile traffic), so that compile cannot be pre-warmed. The harness measures it. The IBL factor never reaches 0, because crossing 0 regenerates the model's shaders (C9). `smoothstep` (E0) turns NaN into 0, so a broken time gives the day look and never a NaN.
  - `aimLight(sunWC, upWC, night, result)`: the light's travel direction. The sun's vertical part is raised to at least `tan 2°` of its horizontal part (same azimuth, elevation ≥ 2°). The result is blended towards `up` by `night`, normalised and negated. It never has an upward component, so the light never comes from below the horizon. It normalises once, after the blend. The PoC also normalised before the blend. The results are identical at night 0 and 1 and differ by < 1 % of the blend weight between +2° and −8°. At the antisolar point the raised vector is zero, but night is 1 there, so the blend is `up` and no zero-length vector reaches `Cartesian3.normalize`, which throws in this build.
  - `parseSunParam(search)`: `?sun=2026-06-21T06:30:00Z` fixes the sun time (a time without a zone is UTC). `?sun=+6h`, `-2h` or `+30m` offsets it. Anything else gives `{ fixedMs: null, offsetMs: 0 }`. `URLSearchParams` decodes a `+` typed into a URL as a space, so a space reads as `+` (also in `+02:00`).
  - `sunTimeMs(tRenderMs, p, upstreamOffsetMs = 0)` = `p.fixedMs ?? tRenderMs − upstreamOffsetMs + p.offsetMs` (D12). `upstreamOffsetMs` is WP-E5's `StatusBrief.upstreamOffsetMs` (server clock − upstream clock). For a replay, that moves the render time back onto the recording's clock.
- `class Sun` (no per-frame allocation: one `Date`, `JulianDate`, `DirectionalLight`, look, state, `Cartesian2`, `Matrix4` and scratch vectors):
  - `constructor(viewer, { day, night })` installs its own `DirectionalLight` as `scene.light`. It sets `scene.atmosphere.dynamicLighting = SUNLIGHT` and `globe.dynamicAtmosphereLightingFromSun = true`, so the sky, the fog and the model's environment map follow the real sun, below the horizon too. It sets `viewer.clock.shouldAnimate = false`. `viewer.shadows` stays false (D10). The Sun starts off (`setEnabled(false)`), with its fixed light above the camera position until the first `update()`.
  - `setEnabled(true)`: `globe.enableLighting = true`. The next `update()` applies the look. `setEnabled(false)` (browse, or the Sun toggle off): `enableLighting = false`, the night layer hidden, day brightness back to 0.9999, a white light of intensity 2 from 60° above the southern horizon at the last `update()` position, and model IBL 1. This gives a fixed look for the aircraft.
  - `attachModel(model | null)`: sets `environmentMapManager.maximumPositionEpsilon = 20,000` m (research C11: the default of 1 km rebuilds the map about every 4 s at airliner speed), and remembers the model for its IBL factor.
  - `update(tSunMs, atWC)`: rejects a time that is no `Date` (`Date#setTime` returns NaN for NaN, ±∞ and anything beyond ±8.64e15 ms) and a non-finite position. Then it writes `viewer.clock.currentTime` from one reused `JulianDate`. Cesium's clock clones it on its next tick, so Cesium's sun, sky and environment map use it one frame later. It computes the sun at `atWC` and `sunLook`. While on, it applies the look: light direction (`aimLight`), intensity and colour, `vertexShadowDarkness`, day brightness, night alpha, night `show` only while alpha > 0.01 (a hidden layer requests no tiles, so daylight makes no GIBS requests), and the model's IBL factor. While off, it keeps the fixed light above `atWC`. It returns one reused `{ elevDeg, night, golden }`.
- `harness/sun.html` + `harness/sun.ts`: the PoC's view. The chase model holds a point on the 6 km circle round LOWI at 2,700 m HAE (default `?at=0`: 6 km east, heading north towards the Nordkette), and the real `ChaseCamera` follows it. Re:Earth terrain with vertex normals (and the `?extensions=octvertexnormals` cache key of D1), EOX day imagery and the night layer. `ChaseModel` with `enableVerticalExaggeration = false`. The Sun is wired. `?sun=`, `?light=0`. Keys `[` `]` ±1 h, `{` `}` ±10 min, `P` time-lapse ×600, `L` Sun on/off. The overlay shows the time, sun elevation, night, golden, the night layer, the frame time and the number of frames over 50 ms since the last `P`. `window.harness = { viewer, sun, setTime(iso), stats() }`, where `stats().hitches` lists those frames with the sun elevation.

Conventions consumers (E-A) rely on:
- Build one `Sun` after the viewer: `const night = makeNightLayer(); viewer.imageryLayers.add(night)`, then `new Sun(viewer, { day: <the base layer or null>, night })`. After `ChaseModel.load`, call `sun.attachModel(model?.model ?? null)`.
- Call `sun.update(sunTimeMs(tRenderMs, parseSunParam(location.search), status.upstreamOffsetMs ?? 0), atWC)` in `frame()` every frame, in both modes. In chase, `atWC` is the placed chased aircraft. In browse, or before the first state, it is `viewer.camera.positionWC`, and `Date.now()` stands in for `tRenderMs` until `api.ready`. Parse `?sun=` once, not per frame. Off, `update()` only keeps the clock and the fixed light above `atWC`, so a lit primitive (E3's runways) never gets a light from below the horizon.
- `sun.setEnabled(selected !== null && prefs.light)` on every selection change and Sun toggle (D9). The call is cheap and idempotent.
- `Sun` is the only writer of `scene.light`, `viewer.clock.currentTime`, `globe.enableLighting`, `globe.vertexShadowDarkness`, the day layer's brightness, the night layer's alpha and `show`, and the model's `imageBasedLightingFactor`. Nobody sets `viewer.shadows` (D10).
- `update()`'s result is one reused object. It is `null` for a bad time or position, and then nothing was written.
- `NIGHT_CREDIT` is in Cesium's credit list (the "Data attribution" pop-up) while the layer draws. E-A's attribution line should add a short "Night lights: NASA GIBS" (D13).

**Tech Stack:** CesiumJS 1.145 (`Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame`, `Transforms.computeIcrfToFixedMatrix`, `computeTemeToPseudoFixedMatrix`, `eastNorthUpToFixedFrame`, `Ellipsoid.geodeticSurfaceNormal`, `DirectionalLight`, `Scene.light`, `Atmosphere.dynamicLighting`, `DynamicAtmosphereLightingType.SUNLIGHT`, `Globe.enableLighting`, `dynamicAtmosphereLightingFromSun`, `vertexShadowDarkness`, `Clock.currentTime`/`shouldAnimate`, `JulianDate.fromDate`, `ImageryLayer` alpha/brightness/show, `UrlTemplateImageryProvider`, `Credit`, `Model.imageBasedLighting.imageBasedLightingFactor`, `Model.environmentMapManager.maximumPositionEpsilon`, `Model.enableVerticalExaggeration`, `CesiumTerrainProvider.fromUrl` with a `Resource`), `smoothstep` from WP-E0, `node:test`. No new dependencies. D13 adds NASA GIBS (keyless) to the allowed services.

**Wave:** after E0, in parallel with WP-E1, E3, E4 and E5 (depends only on E0). Consumed by E-A. **Estimated:** 2 h. **Validated:** 2026-09-22 in a scratch copy of the E0 tree (the integrated B-A tree plus WP-E0; Node 25.2.1, TypeScript 7.0.2, Vite 8.3.0, Cesium 1.145.0) on the user's MacBook Air M2:
- `node --test client/scene/nightLights.test.ts client/scene/sun.test.ts` passed 21/21 (4 + 17). `npx tsc --noEmit` is clean for the whole tree, including `harness/sun.ts`.
- `npm run check`: `tsc` clean, then 632 tests (611 on the E0 tree + 21). The final run passed 632/632. An earlier run had 631: the one failure was the known flake "budget: /api/view of a 250 nm circle with 5,000 aircraft", which passed alone (`server/main.browse.test.ts` 5/5).
- **RED:** each Step 2 quotes the real output: `ERR_MODULE_NOT_FOUND` from the test and TS2307 from `tsc`.
- **Sun positions (Node, TEME):** the test times give LOWI 2026-09-22 05:00Z −0.70°, 10:00Z +40.96° (azimuth 157.9°), 19:00Z −18.73°, KSFO 19:00Z +50.07° (research C21, reproduced by VERIFY). The browser's ICRF values are −1.04°, +40.73°, −18.63° and +49.82°, all within the tests' 0.5°. The only request any test makes is Cesium's `file:` URL for `IAU2006_XYS_18.json`, which the test's `fetch` stub rejects, as Node's `fetch` would. A test asserts this.
- **Mutations:** 36 hand-made faults, each caught by 1–6 failing tests:
  - the night layer shown at creation, alpha 1, brightness 1, level 9, a credit without the acknowledgment, a tile request at construction (`Resource.fetch`, caught by the no-request test);
  - TEME only (caught by the ICRF-attempt check), no normalisation, the transposed frame;
  - night from 0°, golden without `(1 − night)`, day brightness reaching 1, the night alpha reaching 1 (3 tests), the IBL factor reaching 0, no golden floor;
  - a 0° light floor, the raise ignoring the horizontal part, the light not negated;
  - a space not read as `+`, a zone-less time as local time, the upstream offset added;
  - the night layer always shown, no 1 % threshold;
  - no time guard, no position guard;
  - off: day brightness kept, the warm colour kept, the dim IBL kept, the light at 30°, the light not following the target;
  - no environment-map epsilon, `viewer.shadows = true` instead of pausing the clock, a new `JulianDate` per frame, the atmosphere not on SUNLIGHT, `SunLight` kept, `attachModel(null)` not detaching.
- **Replay:** the plan's code blocks were extracted into a fresh copy of the E0 tree. Each Step 2 failed as written, each Step 4 passed (4, 17), and `tsc --noEmit` of the copy was clean. The extracted files are byte-identical to the validated sandbox.
- **Amendment 2026-09-23 (review):** the night alpha is capped at 0.9999 (`NIGHT_MAX_ALPHA`), as the day brightness is. At exactly 1 it made Cesium compile a third globe program at the first full night (Sources, Notes). `sun.test.ts` pins 0.9999 at −15° and at LOWI 21:00, and its every-elevation test asserts that the night alpha stays below 1. The harness logs the frames over 50 ms since the last `P`, with the sun elevation (`stats().hitches`), so the dusk time-lapse measures the night layer's first-draw compile. In the merged E-A sandbox (the E0 tree plus E1–E5): `node --test client/scene/nightLights.test.ts client/scene/sun.test.ts` passed 21/21 (4 + 17), and `npx tsc --noEmit` was clean for the whole tree. With the cap removed, 3 of the 17 sun tests fail. The RED steps and the test counts are unchanged. The plan's `sun.ts`, `sun.test.ts` and `harness/sun.ts` blocks were copied from that sandbox and are byte-identical to it. `npm run check` was not run again (the machine was short on CPU).
- **Harness:** browser check pending (run by the orchestrator for gate GE).

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- Erasable TypeScript only, `#` private fields, relative imports end in `.ts`. The tests import `sun.ts` and `nightLights.ts`, never `viewer.ts` (it imports CSS).
- **Tests never touch the network.** The Cesium objects in the tests are fakes, or objects that construct offline (`Clock`, `ImageBasedLighting`, the night layer). Both test files stub `fetch` and assert what was asked.
- **Cesium's debug assertions ship in this app** (Vite bundles the unbuilt source). `update()` writes nothing for a non-finite time or position. `sunLook` never returns NaN. The IBL factor stays in [0.15, 1] (the setter checks [0, 1]). No zero-length vector reaches `normalize`.
- **No per-frame allocation** in `Sun.update()`: every object is reused. `JulianDate.fromDate` allocates one two-number array inside Cesium, as Cesium's own clock tick does.
- **No paid services.** NASA GIBS is keyless and CORS `*`. D13 adds it to PLAN.md's allowed list, with its acknowledgment in the credits.
- **Heights** are WGS84 ellipsoidal metres (HAE). The sun elevation uses the geodetic normal at the given point.
- Code blocks preceded by `File: \`path\`` contain that file's complete content.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `client/scene/nightLights.ts`, `client/scene/nightLights.test.ts` | new: `NIGHT_URL`, `NIGHT_MAX_LEVEL`, `NIGHT_CREDIT`, `makeNightLayer` |
| `client/scene/sun.ts`, `client/scene/sun.test.ts` | new: `sunDirectionWC`, `sunElevationDeg`, `SunLook`, `sunLook`, `aimLight`, `SunParam`, `parseSunParam`, `sunTimeMs`, `SunState`, `class Sun` |
| `harness/sun.html`, `harness/sun.ts` | new: LOWI chase view with time keys, time-lapse and overlay; `window.harness` |

## Sources (checked 2026-09-22)

Paths are relative to `node_modules/@cesium/engine/Source` (Cesium 1.145.0, engine 26.3.0) unless marked `d.ts` (`node_modules/cesium/Source/Cesium.d.ts`) or `widgets`.

| Fact | Source |
|---|---|
| Cesium computes the sun each frame as Simon 1994 → ICRF-to-fixed (TEME fallback) → normalise. `sunDirectionWC` does the same, so the light, the sky and the model's environment map agree. | `Renderer/UniformState.js:1375-1388`; `Core/Transforms.js:554-561`, `:582`, `:733-749`, `:898-930`; d.ts `:16574`, `:18093`, `:18129` |
| The ICRF matrix is undefined until the XYS table has loaded. Cesium requests the chunk from `buildModuleUrl('Assets/IAU2006_XYS/…')`: `CESIUM_BASE_URL` in the browser (`vite.config.ts` defines it and copies `Assets`: 28 XYS files), `import.meta.url` (a `file:` URL) in Node, where `fetch` rejects it. Errors are swallowed, and the TEME fallback is 0.37° off. | `Core/Iau2006XysData.js:183-196`, `:251-259`, `:261-285`; `Core/buildModuleUrl.js:43-46`; `Core/Resource.js:2053-2066`, `:2096`; research VERIFY C4, C21; probe in Node: one call to `file:…/IAU2006_XYS_18.json` |
| `scene.light` defaults to a `SunLight` (intensity 2) that follows the sun below the horizon too. For any other light: light direction = `normalize(−light.direction)`, `czm_lightColorHdr` = colour × intensity, and `czm_lightColor` = that divided by its largest component when that exceeds 1. | `Scene/Scene.js:768`; `Scene/SunLight.js:28`; `Renderer/UniformState.js:1507-1549`; d.ts `:44695` |
| `DirectionalLight`: `direction` is where the light travels, `color` defaults to white, `intensity` to 1.0. A zero direction throws in debug builds. | `Scene/DirectionalLight.js:20-46`; d.ts `:34266-34284` |
| With vertex normals the globe compiles `ENABLE_VERTEX_LIGHTING`: diffuse = clamp(max(N·L, 0)·0.9 + `vertexShadowDarkness`) × `czm_lightColor`. `dayAlpha`/`nightAlpha` act only under `ENABLE_DAYNIGHT_SHADING` (no normals). | `Scene/GlobeSurfaceShaderSet.js:327-334`; `Shaders/GlobeFS.glsl:213`, `:343`, `:432-433`; `Scene/Globe.js:166`, `:379`; d.ts `:35240`, `:35359` |
| `scene.atmosphere.dynamicLighting` defaults to NONE (lit from straight above). SUNLIGHT uses `czm_sunDirectionWC`. The sky atmosphere takes the globe flags, and `dynamicAtmosphereLightingFromSun` makes it SUNLIGHT. | `Scene/Atmosphere.js:125`; `Shaders/Builtin/Functions/getDynamicAtmosphereLightDirection.glsl:18-20`; `Scene/DynamicAtmosphereLightingType.js:42-50`; `Scene/Scene.js:3745`; `Scene/Globe.js:195`; `Renderer/UniformState.js:1593`; d.ts `:26835`, `:35257` |
| The Viewer's clock does not animate by default. The `currentTime` setter keeps the reference, and `tick()` clones it. `CesiumWidget` ticks, then renders, and `preUpdate` fires inside the render after `frameState.time` is set, so a time written in `preUpdate` is used next frame. | widgets `Viewer/Viewer.js:501`; `Core/Clock.js:139`, `:156-166`, `:260`, `:311`; `Widget/CesiumWidget.js:1078-1079`; `Scene/Scene.js:2032`, `:4627`; d.ts `:3537`, `:3563` |
| `JulianDate.fromDate(date, result)` writes into `result`, and throws in debug builds for an invalid `Date`. | `Core/JulianDate.js:277-299`; d.ts `:9467` |
| A day-layer brightness other than 1 turns on the `APPLY_BRIGHTNESS` variant. A layer with `show` false gets no tile imagery, so it makes no requests. | `Scene/GlobeSurfaceTileProvider.js:3062-3066`; `Scene/ImageryLayer.js:434`; `Scene/GlobeSurfaceTile.js:691`; research C20 |
| Every drawn layer with alpha other than 0 adds a texture to the tile, and any alpha other than 1 turns on `APPLY_ALPHA`. The globe caches one program per texture count and flag set, and compiles a new one on a miss. So the night layer's first draw compiles, and an alpha of exactly 1 (with the day layer at 1) would compile again. | `Scene/GlobeSurfaceTileProvider.js:3004`, `:3045-3047`; `Scene/GlobeSurfaceShaderSet.js:188`, `:254-256`, `:267`; research C20 |
| The `UrlTemplateImageryProvider` constructor makes no request, and its default tiling scheme is Web Mercator. `ImageryLayer` takes `alpha`, `brightness` and `show` options, and its constructor makes no request either. | `Scene/UrlTemplateImageryProvider.js:189-266` (`:221-222`); `Scene/ImageryLayer.js:174-345` (`:190`, `:218`, `:313`) |
| The `imageBasedLightingFactor` setter copies the value and checks [0, 1] in debug builds. Crossing 0 regenerates the model's shaders. | `Scene/ImageBasedLighting.js:115-146`, `:346`; d.ts `:37404`, `:40988` |
| The model's environment map is rebuilt when the model moves more than `maximumPositionEpsilon` (default 1,000 m, per component), or when the time moves more than `maximumSecondsDifference` (3,600 s) under SUNLIGHT. `Model` sets the manager's position every frame. | `Scene/DynamicEnvironmentMapManager.js:145`, `:152`, `:236-252`, `:875-888`; `Scene/Model/Model.js:2167`; d.ts `:34421`, `:40996` |
| `viewer.shadows` is `scene.shadowMap.enabled`, which defaults to false. | widgets `Viewer/Viewer.js:1223-1230`; `Scene/Scene.js:585`; d.ts `:50767` |
| Debug assertions: `Cartesian3.normalize` throws on a NaN result, and `geodeticSurfaceNormal` throws on a NaN component. | `Core/Cartesian3.js:405-423`; `Core/Ellipsoid.js:350-371` |
| `Transforms.eastNorthUpToFixedFrame(origin, ellipsoid, result)`; `Matrix4.multiplyByPointAsVector`. | d.ts `:17947`, `:11816` |
| NASA GIBS: `VIIRS_Black_Marble`, times 2012-01-01 / 2016-01-01, `GoogleMapsCompatible_Level8`, PNG, CORS `*`, z9 → HTTP 400, `cache-control: no-store`. The acknowledgment text was re-read on 2026-09-22. | research C14 (WMTSCapabilities and tile HEADs); https://nasa-gibs.github.io/gibs-api-docs/ |
| Harness: `Model.enableVerticalExaggeration` is declared, and `CesiumTerrainProvider.fromUrl` takes a `Resource`, whose query survives into every tile URL. | d.ts `:40975`, `:3205`; research B4 and VERIFY |

---

### Task 1: Night-lights layer

**Files:**
- Create: `client/scene/nightLights.ts`
- Test: `client/scene/nightLights.test.ts`

**Interfaces:**
- Consumes: Cesium `Credit`, `ImageryLayer`, `UrlTemplateImageryProvider`
- Produces:
  - `NIGHT_URL: string` (GIBS `VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png`)
  - `NIGHT_MAX_LEVEL: number` (8)
  - `NIGHT_CREDIT: string` (the GIBS acknowledgment and "VIIRS Black Marble 2016")
  - `makeNightLayer(): ImageryLayer` (alpha 0, `show` false, brightness 1.6; no request)

- [ ] **Step 1: Write the failing test**

File: `client/scene/nightLights.test.ts`
```ts
// client/scene/nightLights.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UrlTemplateImageryProvider, WebMercatorTilingScheme } from 'cesium'
import { NIGHT_CREDIT, NIGHT_MAX_LEVEL, NIGHT_URL, makeNightLayer } from './nightLights.ts'

test('NIGHT_URL: GIBS VIIRS Black Marble 2016, Web Mercator Level8 PNG tiles, z/y/x', () => {
  assert.equal(
    NIGHT_URL,
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png',
  )
  assert.equal(NIGHT_MAX_LEVEL, 8) // GIBS answers z9 with HTTP 400
})

test('NIGHT_CREDIT carries the GIBS acknowledgment and names the layer', () => {
  assert.match(NIGHT_CREDIT, /We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services \(GIBS\), part of NASA's Earth Science Data and Information System \(ESDIS\)\./)
  assert.match(NIGHT_CREDIT, /VIIRS Black Marble 2016/)
})

test('makeNightLayer: hidden, transparent, bright; the provider stops at level 8 and credits GIBS', () => {
  const layer = makeNightLayer()
  assert.equal(layer.show, false) // no tile requests until Sun shows it at dusk
  assert.equal(layer.alpha, 0)
  assert.equal(layer.brightness, 1.6)
  const p = layer.imageryProvider as UrlTemplateImageryProvider
  assert.ok(p instanceof UrlTemplateImageryProvider)
  assert.equal(p.url, NIGHT_URL)
  assert.equal(p.maximumLevel, NIGHT_MAX_LEVEL)
  assert.ok(p.tilingScheme instanceof WebMercatorTilingScheme) // EPSG:3857, as the tile matrix set
  assert.equal(p.credit.html, NIGHT_CREDIT)
  assert.notEqual(makeNightLayer(), layer) // one per call: a layer belongs to one collection
})

test('makeNightLayer makes no request (Cesium fetches tiles only for a shown layer while it renders)', () => {
  const urls: string[] = []
  const real = globalThis.fetch
  globalThis.fetch = ((url: string) => (urls.push(String(url)), Promise.reject(new Error('offline')))) as typeof fetch
  try {
    makeNightLayer()
  } finally {
    globalThis.fetch = real
  }
  assert.deepEqual(urls, [])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/scene/nightLights.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/scene/nightLights.ts' imported from …/client/scene/nightLights.test.ts`, then `ℹ tests 1`, `ℹ fail 1`.

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/nightLights'`
Expected:
```
client/scene/nightLights.test.ts(5,74): error TS2307: Cannot find module './nightLights.ts' or its corresponding type declarations.
```

- [ ] **Step 3: Write the implementation**

File: `client/scene/nightLights.ts`
```ts
// client/scene/nightLights.ts
import { Credit, ImageryLayer, UrlTemplateImageryProvider } from 'cesium'

// NASA GIBS WMTS: keyless, CORS *. VIIRS Black Marble (city lights), the 2016 composite, EPSG:3857, tile matrix set
// GoogleMapsCompatible_Level8 (z ≤ 8, z9 → HTTP 400). Checked 2026-09-22:
// https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml
// ponytail: level 8 is ~600 m/px at the equator, so at chase range the lights are a soft glow. No sharper keyless source.
export const NIGHT_URL =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png'
export const NIGHT_MAX_LEVEL = 8
// The acknowledgment GIBS asks clients to show: https://nasa-gibs.github.io/gibs-api-docs/
export const NIGHT_CREDIT =
  "VIIRS Black Marble 2016. We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS)."

/**
 * The city-lights layer, hidden and transparent: Sun fades it in at dusk (alpha = night) and shows it only while it is
 * visible, so daytime makes no GIBS requests. Brightness 1.6 lifts the lights over the darkened day layer.
 * Add it right above the day layer. Constructing it requests nothing.
 */
export function makeNightLayer(): ImageryLayer {
  const provider = new UrlTemplateImageryProvider({ url: NIGHT_URL, maximumLevel: NIGHT_MAX_LEVEL, credit: new Credit(NIGHT_CREDIT) })
  return new ImageryLayer(provider, { alpha: 0, show: false, brightness: 1.6 })
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/scene/nightLights.test.ts`
Expected: PASS — `ℹ tests 4`, `ℹ pass 4`, `ℹ fail 0`.

- [ ] **Step 5: Type-check these files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/nightLights'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 6: Commit**

```bash
git add client/scene/nightLights.ts client/scene/nightLights.test.ts
git commit -m "feat(scene): NASA GIBS night-lights layer, hidden until dusk" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Sun — ephemeris, look, light and the `Sun` class

**Files:**
- Create: `client/scene/sun.ts`
- Test: `client/scene/sun.test.ts`

**Interfaces:**
- Consumes: `smoothstep(u)` from `client/scene/exaggeration.ts` (WP-E0); `makeNightLayer()` (Task 1, test only); Cesium (see Tech Stack)
- Produces:
  - `sunDirectionWC(jd: JulianDate, result: Cartesian3): Cartesian3`: unit Earth → Sun, Earth-fixed
  - `sunElevationDeg(sunWC: Cartesian3, posWC: Cartesian3): number`
  - `interface SunLook { night; golden; intensity; red; green; blue; vertexShadowDarkness; dayBrightness; nightAlpha; iblFactor }` (all `number`)
  - `sunLook(elevDeg: number, result?: SunLook): SunLook`
  - `aimLight(sunWC: Cartesian3, upWC: Cartesian3, night: number, result: Cartesian3): Cartesian3`
  - `interface SunParam { fixedMs: number | null; offsetMs: number }`
  - `parseSunParam(search: string): SunParam`
  - `sunTimeMs(tRenderMs: number, p: SunParam, upstreamOffsetMs?: number): number`
  - `interface SunState { elevDeg: number; night: number; golden: number }`
  - `class Sun { constructor(viewer: Viewer, layers: { day: ImageryLayer | null; night: ImageryLayer | null }); setEnabled(on: boolean): void; attachModel(model: Model | null): void; update(tSunMs: number, atWC: Cartesian3): SunState | null }`

- [ ] **Step 1: Write the failing test**

File: `client/scene/sun.test.ts`
```ts
// client/scene/sun.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cartesian3, Clock, Color, DirectionalLight, DynamicAtmosphereLightingType, ImageBasedLighting, JulianDate } from 'cesium'
import type { ImageryLayer, Model, Viewer } from 'cesium'
import { makeNightLayer } from './nightLights.ts'
import { Sun, aimLight, parseSunParam, sunDirectionWC, sunElevationDeg, sunLook, sunTimeMs } from './sun.ts'

// Cesium asks for its IAU 2006 XYS table the first time the ICRF frame is needed. Without CESIUM_BASE_URL (Node) that is
// a file: URL next to the engine, so the TEME fallback is used. Record every request and refuse it: no network here.
const fetched: string[] = []
globalThis.fetch = ((url: string) => (fetched.push(String(url)), Promise.reject(new Error('offline')))) as typeof fetch

const DEG = Math.PI / 180
const LOWI = { lat: 47.2602, lon: 11.3439 }
const KSFO = { lat: 37.6189, lon: -122.375 }
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${msg} got ${a}, expected ${b} ± ${tol}`)
const jdOf = (iso: string): JulianDate => JulianDate.fromIso8601(iso)
const at = (p: { lat: number; lon: number }, hM = 0): Cartesian3 => Cartesian3.fromDegrees(p.lon, p.lat, hM)

/** East, north, up unit vectors at a geodetic lat/lon: our own formulas, not Cesium's ENU. */
function enu(p: { lat: number; lon: number }): [Cartesian3, Cartesian3, Cartesian3] {
  const [f, l] = [p.lat * DEG, p.lon * DEG]
  return [
    new Cartesian3(-Math.sin(l), Math.cos(l), 0),
    new Cartesian3(-Math.sin(f) * Math.cos(l), -Math.sin(f) * Math.sin(l), Math.cos(f)),
    new Cartesian3(Math.cos(f) * Math.cos(l), Math.cos(f) * Math.sin(l), Math.sin(f)),
  ]
}
/** Elevation and azimuth (degrees, azimuth clockwise from north) of a world direction seen from p. */
function elAz(v: Cartesian3, p: { lat: number; lon: number }): { el: number; az: number } {
  const [e, n, u] = enu(p)
  const w = Cartesian3.normalize(v, new Cartesian3())
  return { el: Math.asin(Cartesian3.dot(w, u)) / DEG, az: (Math.atan2(Cartesian3.dot(w, e), Cartesian3.dot(w, n)) / DEG + 360) % 360 }
}
/** Unit world direction at elevation/azimuth seen from p. */
function dirAt(elDeg: number, azDeg: number, p: { lat: number; lon: number }): Cartesian3 {
  const [e, n, u] = enu(p)
  const h = Math.cos(elDeg * DEG)
  const v = new Cartesian3()
  Cartesian3.add(Cartesian3.multiplyByScalar(e, h * Math.sin(azDeg * DEG), new Cartesian3()), Cartesian3.multiplyByScalar(n, h * Math.cos(azDeg * DEG), new Cartesian3()), v)
  return Cartesian3.add(v, Cartesian3.multiplyByScalar(u, Math.sin(elDeg * DEG), new Cartesian3()), v)
}

// ---------- ephemeris ----------

test('sunDirectionWC: unit vector; elevations match the reference (LOWI 2026-09-22 05, 10, 19 Z; KSFO 19 Z)', () => {
  // Research C21 (Cesium's own functions). Node uses TEME, the browser ICRF once Cesium's XYS table loads: 0.37° apart.
  const cases: [string, { lat: number; lon: number }, number][] = [
    ['2026-09-22T05:00:00Z', LOWI, -0.7],
    ['2026-09-22T10:00:00Z', LOWI, 41.0],
    ['2026-09-22T19:00:00Z', LOWI, -18.7],
    ['2026-09-22T19:00:00Z', KSFO, 50.1],
  ]
  for (const [iso, p, el] of cases) {
    const r = new Cartesian3()
    assert.equal(sunDirectionWC(jdOf(iso), r), r)
    near(Cartesian3.magnitude(r), 1, 1e-12, 'length')
    near(elAz(r, p).el, el, 0.5, `${iso} elevation`)
  }
  near(elAz(sunDirectionWC(jdOf('2026-09-22T10:00:00Z'), new Cartesian3()), LOWI).az, 158, 1, 'LOWI 10:00Z azimuth (SSE)')
})

test('sunElevationDeg: +90 overhead, −90 underfoot, 0 on the horizon, and the ENU elevation of the real sun', () => {
  const [e, , u] = enu(LOWI)
  const p = at(LOWI)
  near(sunElevationDeg(u, p), 90, 1e-6)
  near(sunElevationDeg(Cartesian3.negate(u, new Cartesian3()), p), -90, 1e-6)
  near(sunElevationDeg(e, p), 0, 1e-9)
  near(sunElevationDeg(dirAt(12.5, 250, KSFO), at(KSFO)), 12.5, 1e-9)
  const sun = sunDirectionWC(jdOf('2026-09-22T10:00:00Z'), new Cartesian3())
  near(sunElevationDeg(sun, p), elAz(sun, LOWI).el, 1e-9)
})

// ---------- the look (design §4) ----------

const LOOKS: [number, Record<string, number>][] = [
  [45, { night: 0, golden: 0, intensity: 2, red: 1, green: 1, blue: 1, vertexShadowDarkness: 0.3, dayBrightness: 0.9999, nightAlpha: 0, iblFactor: 1 }],
  // golden01(4°) = smoothstep(11/15) = 0.824593
  [4, { night: 0, golden: 0.824593, intensity: 2, red: 1, green: 0.835081, blue: 0.686655, vertexShadowDarkness: 0.464919, dayBrightness: 0.9999, nightAlpha: 0, iblFactor: 1 }],
  [-3, { night: 0.5, golden: 0.5, intensity: 1.225, red: 1, green: 0.9, blue: 0.81, vertexShadowDarkness: 0.4, dayBrightness: 0.65, nightAlpha: 0.5, iblFactor: 0.575 }],
  [-15, { night: 1, golden: 0, intensity: 0.45, red: 1, green: 1, blue: 1, vertexShadowDarkness: 0.3, dayBrightness: 0.3, nightAlpha: 0.9999, iblFactor: 0.15 }],
]

test('sunLook at +45° (day), +4° (golden hour), −3° (dusk), −15° (night)', () => {
  for (const [el, want] of LOOKS) {
    const look = sunLook(el) as unknown as Record<string, number>
    assert.deepEqual(Object.keys(look).sort(), Object.keys(want).sort())
    for (const k of Object.keys(want)) near(look[k], want[k], 1e-6, `${el}° ${k}`)
  }
})

test('sunLook over every elevation: monotonic night, day brightness and night alpha never 1, image-based light never 0, all finite', () => {
  const r = sunLook(0)
  assert.equal(sunLook(10, r), r) // writes into result
  let prevNight = 0
  for (let el = 90; el >= -90; el -= 0.25) {
    const l = sunLook(el, r)
    assert.ok(l.night >= prevNight, `night falls at ${el}°`)
    prevNight = l.night
    assert.ok(l.dayBrightness < 1, `${el}°: brightness 1 would switch off APPLY_BRIGHTNESS`)
    assert.ok(l.nightAlpha < 1, `${el}°: night alpha 1 would switch off APPLY_ALPHA`)
    assert.ok(l.iblFactor >= 0.15, `${el}°: an IBL factor of 0 regenerates the model's shaders`)
    assert.ok(l.golden >= 0 && l.golden <= 1 && l.intensity >= 0.45 - 1e-12 && l.intensity <= 2)
  }
  for (const v of Object.values(sunLook(Number.NaN))) assert.ok(Number.isFinite(v))
  assert.equal(sunLook(Number.NaN).night, 0) // a broken sun time looks like day, never NaN in a Cesium setter
})

test('aimLight: straight from a sun above 2°; straight down at full night', () => {
  const [, , up] = enu(LOWI)
  const sun = dirAt(30, 140, LOWI)
  const r = new Cartesian3()
  assert.equal(aimLight(sun, up, 0, r), r)
  assert.ok(Cartesian3.equalsEpsilon(r, Cartesian3.negate(sun, new Cartesian3()), 1e-12), `${r}`)
  assert.ok(Cartesian3.equalsEpsilon(aimLight(sun, up, 1, r), Cartesian3.negate(up, new Cartesian3()), 1e-12))
  // The antisolar point (sun straight underfoot) is full night: light from overhead, no zero-length vector.
  assert.ok(Cartesian3.equalsEpsilon(aimLight(Cartesian3.negate(up, new Cartesian3()), up, 1, r), Cartesian3.negate(up, new Cartesian3()), 1e-12))
})

test('aimLight never comes from below 2°: a low or set sun is raised to 2° on its own azimuth, then blended up by night', () => {
  const r = new Cartesian3()
  const minUp = Math.sin(2 * DEG)
  for (const p of [LOWI, KSFO, { lat: -33.9, lon: 151.2 }]) {
    const [, , up] = enu(p)
    for (let el = -89; el <= 89; el += 1) {
      for (const az of [0, 95, 200, 333]) {
        const sun = dirAt(el, az, p)
        for (const night of [0, 0.3, 0.7, 1]) {
          aimLight(sun, up, night, r)
          near(Cartesian3.magnitude(r), 1, 1e-12, 'unit')
          assert.ok(-Cartesian3.dot(r, up) >= minUp - 1e-12, `sun ${el}° az ${az} night ${night}: light from ${-Cartesian3.dot(r, up)}`)
          const from = elAz(Cartesian3.negate(r, new Cartesian3()), p)
          if (night < 1) near(((from.az - az + 540) % 360) - 180, 0, 1e-6, 'azimuth kept')
          if (night === 0) near(from.el, Math.max(el, 2), 1e-9, 'elevation')
        }
      }
    }
  }
})

// ---------- ?sun= and the sun time ----------

test('parseSunParam: a fixed ISO time (zone optional, UTC by default) or an offset in h / m; anything else is none', () => {
  const none = { fixedMs: null, offsetMs: 0 }
  assert.deepEqual(parseSunParam('?sun=2026-06-21T06:30:00Z'), { fixedMs: Date.UTC(2026, 5, 21, 6, 30), offsetMs: 0 })
  assert.deepEqual(parseSunParam('?hex=abc123&sun=2026-06-21T06:30Z'), { fixedMs: Date.UTC(2026, 5, 21, 6, 30), offsetMs: 0 })
  assert.deepEqual(parseSunParam('?sun=2026-06-21T06:30:00'), { fixedMs: Date.UTC(2026, 5, 21, 6, 30), offsetMs: 0 })
  // A '+' typed into a URL arrives as a space (URLSearchParams); %2B is a real '+'.
  assert.deepEqual(parseSunParam('?sun=2026-06-21T08:30:00+02:00'), { fixedMs: Date.UTC(2026, 5, 21, 6, 30), offsetMs: 0 })
  assert.deepEqual(parseSunParam('?sun=+6h'), { fixedMs: null, offsetMs: 6 * 3_600_000 })
  assert.deepEqual(parseSunParam('?sun=%2B6h'), { fixedMs: null, offsetMs: 6 * 3_600_000 })
  assert.deepEqual(parseSunParam('?sun=-2h'), { fixedMs: null, offsetMs: -2 * 3_600_000 })
  assert.deepEqual(parseSunParam('?sun=+30m'), { fixedMs: null, offsetMs: 30 * 60_000 })
  for (const bad of ['', '?sun=', '?sun=noon', '?sun=6h', '?sun=+6', '?sun=+6d', '?sun=1', '?sun=2026-13-45T00:00Z', '?sun=2026-06-21', '?light=0']) {
    assert.deepEqual(parseSunParam(bad), none, bad)
  }
})

test('sunTimeMs: render time on the recording clock (D12), then the offset; a fixed time wins', () => {
  const t = Date.UTC(2026, 8, 22, 10)
  assert.equal(sunTimeMs(t, { fixedMs: null, offsetMs: 0 }), t)
  assert.equal(sunTimeMs(t, { fixedMs: null, offsetMs: 0 }, 3 * 86_400_000), t - 3 * 86_400_000) // replay served 3 days later
  assert.equal(sunTimeMs(t, { fixedMs: null, offsetMs: 6 * 3_600_000 }, 150), t - 150 + 6 * 3_600_000)
  assert.equal(sunTimeMs(t, { fixedMs: 42, offsetMs: 0 }, 150), 42)
})

// ---------- class Sun ----------

/** The viewer shapes Sun touches, as plain objects; the clock, the model's IBL and the night layer are real (offline). */
function fakeViewer() {
  const globe = { enableLighting: true, dynamicAtmosphereLightingFromSun: false, vertexShadowDarkness: 0.3 }
  const scene = { globe, atmosphere: { dynamicLighting: DynamicAtmosphereLightingType.NONE }, light: null as unknown }
  const clock = new Clock({ shouldAnimate: true })
  const viewer = { scene, clock, camera: { positionWC: at(LOWI, 300_000) }, shadows: false }
  const day = { brightness: 1, alpha: 1, show: true }
  const night = makeNightLayer()
  const model = { environmentMapManager: { maximumPositionEpsilon: 1000 }, imageBasedLighting: new ImageBasedLighting() }
  const sun = new Sun(viewer as unknown as Viewer, { day: day as unknown as ImageryLayer, night })
  const light = scene.light as DirectionalLight
  const ibl = (): number[] => [model.imageBasedLighting.imageBasedLightingFactor.x, model.imageBasedLighting.imageBasedLightingFactor.y]
  return { sun, viewer, globe, scene, clock, day, night, model, light, ibl, attach: () => sun.attachModel(model as unknown as Model) }
}
const AIRCRAFT = at(LOWI, 2700)
const T10 = Date.parse('2026-09-22T10:00:00Z') // LOWI 12:00 local, sun +41°
const T19 = Date.parse('2026-09-22T19:00:00Z') // LOWI 21:00 local, sun −18.7°

test('new Sun: its own DirectionalLight, sky and model environment from the real sun, clock paused, starts off', () => {
  const s = fakeViewer()
  assert.ok(s.scene.light instanceof DirectionalLight)
  assert.equal(s.scene.atmosphere.dynamicLighting, DynamicAtmosphereLightingType.SUNLIGHT)
  assert.equal(s.globe.dynamicAtmosphereLightingFromSun, true)
  assert.equal(s.clock.shouldAnimate, false)
  assert.equal(s.day.brightness, 0.9999) // APPLY_BRIGHTNESS compiled from the start
  assert.equal(s.globe.enableLighting, false)
  assert.equal(s.night.show, false)
  assert.equal(s.light.intensity, 2)
  assert.ok(s.light.color.equals(Color.WHITE))
  // Above the camera until an update. Cesium's "up" at a point above the ground (Ellipsoid.geodeticSurfaceNormal of the
  // point itself) leans from the geodetic up by ~1e-4° at 2.7 km and ~0.009° at 300 km.
  const from = elAz(Cartesian3.negate(s.light.direction, new Cartesian3()), LOWI)
  near(from.el, 60, 0.01)
  near(from.az, 180, 0.01)
  assert.equal(s.viewer.shadows, false) // D10
})

test('update writes the sun time into the paused clock, reusing one JulianDate and one result object', () => {
  const s = fakeViewer()
  const r1 = s.sun.update(T10, AIRCRAFT)
  const jd = s.clock.currentTime
  assert.equal(JulianDate.toDate(jd).getTime(), T10)
  const r2 = s.sun.update(T19, AIRCRAFT)
  assert.equal(s.clock.currentTime, jd)
  assert.equal(JulianDate.toDate(jd).getTime(), T19)
  assert.equal(r2, r1)
  assert.equal(s.clock.shouldAnimate, false)
  assert.equal(s.scene.light, s.light) // one light, its direction written in place
})

test('lit at LOWI 12:00 local: the light follows the sun, white, full strength; no night layer, so no GIBS requests', () => {
  const s = fakeViewer()
  s.attach()
  s.sun.setEnabled(true)
  const r = s.sun.update(T10, AIRCRAFT)!
  near(r.elevDeg, 41, 0.5)
  assert.equal(r.night, 0)
  assert.equal(r.golden, 0)
  assert.equal(s.globe.enableLighting, true)
  const sun = sunDirectionWC(jdOf('2026-09-22T10:00:00Z'), new Cartesian3())
  assert.ok(Cartesian3.equalsEpsilon(s.light.direction, Cartesian3.negate(sun, new Cartesian3()), 1e-12))
  assert.equal(s.light.intensity, 2)
  assert.deepEqual([s.light.color.red, s.light.color.green, s.light.color.blue], [1, 1, 1])
  assert.equal(s.globe.vertexShadowDarkness, 0.3)
  assert.equal(s.day.brightness, 0.9999)
  assert.equal(s.night.show, false)
  assert.equal(s.night.alpha, 0)
  assert.deepEqual(s.ibl(), [1, 1])
  assert.equal(s.model.environmentMapManager.maximumPositionEpsilon, 20_000)
})

test('lit at LOWI 21:00 local: a dim light from straight overhead, city lights, darker land, dimmed aircraft', () => {
  const s = fakeViewer()
  s.attach()
  s.sun.setEnabled(true)
  const r = s.sun.update(T19, AIRCRAFT)!
  near(r.elevDeg, -18.7, 0.5)
  assert.equal(r.night, 1)
  const [, , up] = enu(LOWI)
  assert.ok(Cartesian3.equalsEpsilon(s.light.direction, Cartesian3.negate(up, new Cartesian3()), 1e-5))
  near(s.light.intensity, 0.45, 1e-12)
  near(s.day.brightness, 0.3, 1e-12)
  assert.equal(s.night.show, true)
  assert.equal(s.night.alpha, 0.9999) // never 1: APPLY_ALPHA stays on at full night
  assert.equal(s.night.brightness, 1.6)
  near(s.ibl()[0], 0.15, 1e-12)
  near(s.ibl()[1], 0.15, 1e-12)
  assert.equal(s.globe.vertexShadowDarkness, 0.3)
  assert.equal(s.viewer.shadows, false) // D10
})

test('dusk at LOWI: the night layer shows only above 1 % alpha; the light warms and never comes from below 2°', () => {
  const s = fakeViewer()
  s.sun.setEnabled(true)
  const [, , up] = enu(LOWI)
  let hiddenButFading = 0
  let warmest = 1
  for (let t = Date.parse('2026-09-22T16:30:00Z'); t <= Date.parse('2026-09-22T17:30:00Z'); t += 10_000) {
    const r = s.sun.update(t, AIRCRAFT)!
    assert.equal(s.night.alpha, r.night)
    assert.equal(s.night.show, s.night.alpha > 0.01)
    if (s.night.alpha > 0 && !s.night.show) hiddenButFading++
    assert.ok(-Cartesian3.dot(s.light.direction, up) >= Math.sin(2 * DEG) - 1e-12)
    warmest = Math.min(warmest, s.light.color.blue)
    near(s.globe.vertexShadowDarkness, 0.3 + 0.2 * r.golden, 1e-12)
  }
  assert.ok(hiddenButFading > 0, 'a faint fade stays hidden')
  near(warmest, 1 - 0.38 * 0.965, 0.01) // golden·(1 − night) peaks at 0.965, near +1.4°
  const dawn = s.sun.update(Date.parse('2026-09-22T05:30:00Z'), AIRCRAFT)! // +4.4°
  assert.equal(s.night.show, false)
  assert.ok(dawn.golden > 0.5 && s.light.color.blue < 0.8, 'golden hour')
})

test('setEnabled(false) (browse, or the Sun toggle off): unlit, day imagery, white light from 60° above the last position', () => {
  const s = fakeViewer()
  s.attach()
  s.sun.setEnabled(true)
  s.sun.update(Date.parse('2026-09-22T17:15:00Z'), AIRCRAFT) // −1.4°: warm light, lights fading in, dimmed land and IBL
  assert.ok(s.night.show && s.light.color.blue < 0.8 && s.day.brightness < 0.9 && s.ibl()[0] < 0.9)
  s.sun.setEnabled(false)
  assert.equal(s.globe.enableLighting, false)
  assert.equal(s.night.show, false)
  assert.equal(s.day.brightness, 0.9999)
  assert.equal(s.light.intensity, 2)
  assert.deepEqual([s.light.color.red, s.light.color.green, s.light.color.blue], [1, 1, 1])
  assert.deepEqual(s.ibl(), [1, 1])
  let from = elAz(Cartesian3.negate(s.light.direction, new Cartesian3()), LOWI)
  near(from.el, 60, 1e-3)
  near(from.az, 180, 1e-3)
  // Off, update keeps the clock and moves the fixed light with the target; the look stays off.
  const r = s.sun.update(T19, at(KSFO, 500))!
  near(r.elevDeg, 50.1, 0.5)
  assert.equal(JulianDate.toDate(s.clock.currentTime).getTime(), T19)
  from = elAz(Cartesian3.negate(s.light.direction, new Cartesian3()), KSFO)
  near(from.el, 60, 1e-3)
  near(from.az, 180, 1e-3)
  assert.equal(s.light.intensity, 2)
  assert.equal(s.day.brightness, 0.9999)
  assert.equal(s.night.show, false)
  assert.deepEqual(s.ibl(), [1, 1])
  // On again: the next update lights it.
  s.sun.setEnabled(true)
  s.sun.update(T19, AIRCRAFT)
  assert.equal(s.globe.enableLighting, true)
  assert.equal(s.night.show, true)
  assert.equal(s.viewer.shadows, false) // D10
})

test('update rejects a time that is no Date and a non-finite position, and writes nothing', () => {
  const s = fakeViewer()
  s.sun.setEnabled(true)
  s.sun.update(T10, AIRCRAFT)
  const before = Cartesian3.clone(s.light.direction)
  for (const t of [Number.NaN, Number.POSITIVE_INFINITY, 1e16]) assert.equal(s.sun.update(t, AIRCRAFT), null, String(t))
  assert.equal(s.sun.update(T19, new Cartesian3(Number.NaN, 0, 0)), null)
  assert.equal(JulianDate.toDate(s.clock.currentTime).getTime(), T10)
  assert.ok(Cartesian3.equals(s.light.direction, before))
  assert.equal(s.night.show, false)
})

test('attachModel(null) detaches: a later night leaves the old model alone', () => {
  const s = fakeViewer()
  s.attach()
  s.sun.attachModel(null)
  s.sun.setEnabled(true)
  s.sun.update(T19, AIRCRAFT)
  assert.deepEqual(s.ibl(), [1, 1])
})

test('no test touched the network: Cesium asked only for its XYS table, from a file: URL (so Node runs on TEME)', () => {
  assert.ok(fetched.length > 0, 'sunDirectionWC tries the ICRF frame first')
  for (const url of fetched) assert.match(url, /^file:.*IAU2006_XYS/)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/scene/sun.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/scene/sun.ts' imported from …/client/scene/sun.test.ts`, then `ℹ tests 1`, `ℹ fail 1`.

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/sun'`
Expected:
```
client/scene/sun.test.ts(7,99): error TS2307: Cannot find module './sun.ts' or its corresponding type declarations.
```

- [ ] **Step 3: Write the implementation**

File: `client/scene/sun.ts`
```ts
// client/scene/sun.ts
// WP-E2: sunlight in the chase view (design D8–D10, D12, §4). The sun comes from Cesium's own ephemeris; the app owns
// the light, the night blend and the aircraft's ambient light. Cesium's SunLight lights slopes and the aircraft from
// below the horizon, and its day/night imagery blend (dayAlpha/nightAlpha) does nothing once the terrain has normals.
import {
  Cartesian2,
  Cartesian3,
  Color,
  DirectionalLight,
  DynamicAtmosphereLightingType,
  Ellipsoid,
  JulianDate,
  Math as CesiumMath,
  Matrix3,
  Matrix4,
  Simon1994PlanetaryPositions,
  Transforms,
} from 'cesium'
import type { ImageryLayer, Model, Viewer } from 'cesium'
import { smoothstep } from './exaggeration.ts'

const RAD = Math.PI / 180
/** The light never comes from lower: a low sun must not light slopes that face it from below the horizon. */
const MIN_LIGHT_ELEV_DEG = 2
const MIN_LIGHT_TAN = Math.tan(MIN_LIGHT_ELEV_DEG * RAD)
const DAY_INTENSITY = 2 // SunLight's default: czm_lightColorHdr = colour × intensity
const NIGHT_INTENSITY = 0.45
const WARM_GREEN = 0.8 // warm low sun (1.0, 0.8, 0.62)
const WARM_BLUE = 0.62
/** Below 1, so the day layer's APPLY_BRIGHTNESS shader variant is compiled from the start, not at the first dusk. */
const DAY_BRIGHTNESS = 0.9999
/**
 * Below 1, so full night keeps the APPLY_ALPHA variant of the dusk. At alpha 1 Cesium drops APPLY_ALPHA and compiles
 * another globe program. The night layer's first draw still compiles one (a second texture): hidden by day, it cannot
 * be pre-warmed.
 */
const NIGHT_MAX_ALPHA = 0.9999
const NIGHT_SHOW_ALPHA = 0.01
/** The model's environment map is rebuilt after this much movement (Cesium: 1 km, every ~4 s at airliner speed). */
const ENV_MAP_EPSILON_M = 20_000
/** Sun off: a light from 60° above the southern horizon. Where it travels, in east-north-up: north and down. */
const OFF_TRAVEL_ENU = new Cartesian3(0, Math.cos(60 * RAD), -Math.sin(60 * RAD))

const scratchM3 = new Matrix3()
const scratchUp = new Cartesian3()
const scratchH = new Cartesian3()

/**
 * Unit vector Earth → Sun in the Earth-fixed frame, computed as Cesium's UniformState computes czm_sunDirectionWC
 * (Simon 1994). ICRF → fixed needs Cesium's IAU 2006 XYS table, which it fetches from its Assets on first use; until
 * then, and always in Node, the TEME → pseudo-fixed fallback is used, 0.37° off.
 */
export function sunDirectionWC(jd: JulianDate, result: Cartesian3): Cartesian3 {
  const toFixed = Transforms.computeIcrfToFixedMatrix(jd, scratchM3) ?? Transforms.computeTemeToPseudoFixedMatrix(jd, scratchM3)
  Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(jd, result)
  return Cartesian3.normalize(Matrix3.multiplyByVector(toFixed, result, result), result)
}

/** Degrees of the sun above the geodetic horizon at posWC (no refraction; parallax is 9″). */
export function sunElevationDeg(sunWC: Cartesian3, posWC: Cartesian3): number {
  const up = Ellipsoid.WGS84.geodeticSurfaceNormal(posWC, scratchUp)
  return CesiumMath.toDegrees(Math.asin(CesiumMath.clamp(Cartesian3.dot(up, sunWC), -1, 1)))
}

/** Everything the sun elevation sets (design §4). golden is the warmth applied: golden01·(1 − night). */
export interface SunLook {
  night: number // 0 at +2°, 1 at −8°
  golden: number // 0 above +15° and at full night
  intensity: number // scene light
  red: number // scene light colour
  green: number
  blue: number
  vertexShadowDarkness: number // globe ambient floor
  dayBrightness: number // day imagery layer
  nightAlpha: number // city-lights layer
  iblFactor: number // chased model's image-based lighting
}

/** The look at a sun elevation. Pure; writes into result when given (Sun reuses one). NaN looks like day. */
export function sunLook(elevDeg: number, result?: SunLook): SunLook {
  const night = smoothstep((2 - elevDeg) / 10)
  const golden = smoothstep((15 - elevDeg) / 15) * (1 - night)
  const r = result ?? ({} as SunLook)
  r.night = night
  r.golden = golden
  r.intensity = DAY_INTENSITY + (NIGHT_INTENSITY - DAY_INTENSITY) * night
  r.red = 1
  r.green = 1 + (WARM_GREEN - 1) * golden
  r.blue = 1 + (WARM_BLUE - 1) * golden
  r.vertexShadowDarkness = 0.3 + 0.2 * golden // a warm, lifted floor at golden hour instead of black shade
  r.dayBrightness = Math.min(DAY_BRIGHTNESS, 1 - 0.7 * night)
  r.nightAlpha = Math.min(NIGHT_MAX_ALPHA, night)
  r.iblFactor = 1 - 0.85 * night // never 0: crossing 0 regenerates the model's shaders
  return r
}

/**
 * The scene light's travel direction (DirectionalLight.direction, unit): from the sun, raised to at least 2° above the
 * horizon on the sun's own azimuth, then blended towards a light from straight overhead by night (dim relief at night,
 * design §7.1). Normalised once after the blend: at the antisolar point the raised vector is 0, but night is 1 there.
 */
export function aimLight(sunWC: Cartesian3, upWC: Cartesian3, night: number, result: Cartesian3): Cartesian3 {
  const v = Cartesian3.dot(sunWC, upWC)
  const h = Cartesian3.subtract(sunWC, Cartesian3.multiplyByScalar(upWC, v, scratchH), scratchH) // horizontal part
  Cartesian3.multiplyByScalar(upWC, Math.max(v, MIN_LIGHT_TAN * Cartesian3.magnitude(h)), result)
  Cartesian3.lerp(Cartesian3.add(h, result, result), upWC, night, result)
  return Cartesian3.negate(Cartesian3.normalize(result, result), result)
}

/** ?sun= from the page URL: a fixed instant, or an offset from the render time. */
export interface SunParam {
  fixedMs: number | null
  offsetMs: number
}

const SUN_OFFSET = /^([+-])(\d+)([hm])$/
const SUN_ISO = /^(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?)(Z|[+-]\d\d:\d\d)?$/

/**
 * ?sun=2026-06-21T06:30:00Z fixes the sun time (no zone = UTC); ?sun=+6h, -2h or +30m offsets it. Anything else: none.
 * URLSearchParams turns a '+' typed into the URL into a space, so a space reads as '+'.
 */
export function parseSunParam(search: string): SunParam {
  const s = (new URLSearchParams(search).get('sun') ?? '').replaceAll(' ', '+')
  const o = SUN_OFFSET.exec(s)
  if (o) return { fixedMs: null, offsetMs: (o[1] === '-' ? -1 : 1) * Number(o[2]) * (o[3] === 'h' ? 3_600_000 : 60_000) }
  const m = SUN_ISO.exec(s)
  const fixedMs = m ? Date.parse(m[1] + (m[2] ?? 'Z')) : Number.NaN
  return { fixedMs: Number.isFinite(fixedMs) ? fixedMs : null, offsetMs: 0 }
}

/**
 * The instant that lights the scene (D12): the render time (server clock) moved back onto the upstream clock, which for
 * a replay is the recording's, then the ?sun= override. upstreamOffsetMs is StatusBrief.upstreamOffsetMs (WP-E5):
 * 0 until the server reports it, so until then a replay is lit at wall-clock time.
 */
export function sunTimeMs(tRenderMs: number, p: SunParam, upstreamOffsetMs = 0): number {
  return p.fixedMs ?? tRenderMs - upstreamOffsetMs + p.offsetMs
}

/** What update() reports. One reused object: read it during the frame. */
export interface SunState {
  elevDeg: number
  night: number
  golden: number
}

/**
 * The scene's sun: Cesium's clock, the one scene light, the day/night imagery blend and the chased model's ambient light.
 * Starts off. Allocates nothing per frame.
 */
export class Sun {
  #viewer: Viewer
  #day: ImageryLayer | null
  #night: ImageryLayer | null
  #model: Model | null = null
  #enabled = false
  #light = new DirectionalLight({ direction: new Cartesian3(0, 0, -1), intensity: DAY_INTENSITY })
  #date = new Date(0)
  #jd = new JulianDate()
  #sun = new Cartesian3()
  #up = new Cartesian3()
  #at = new Cartesian3() // the last update() position: where the off light stands
  #enu = new Matrix4()
  #ibl = new Cartesian2(1, 1)
  #look = sunLook(90)
  #state: SunState = { elevDeg: 90, night: 0, golden: 0 }

  constructor(viewer: Viewer, layers: { day: ImageryLayer | null; night: ImageryLayer | null }) {
    this.#viewer = viewer
    this.#day = layers.day
    this.#night = layers.night
    const { scene } = viewer
    scene.light = this.#light
    // The sky, the fog and the model's environment map follow the real sun (below the horizon too), not this light.
    scene.atmosphere.dynamicLighting = DynamicAtmosphereLightingType.SUNLIGHT
    scene.globe.dynamicAtmosphereLightingFromSun = true
    viewer.clock.shouldAnimate = false // the Viewer's default: update() writes currentTime every frame
    // D10: no cast shadows, so viewer.shadows stays false (the Viewer's default). In the PoC they cost 65 → 46–52 fps
    // and drew acne stripes on the aircraft for a small visual gain. Measure again before anyone turns them on.
    Cartesian3.clone(viewer.camera.positionWC, this.#at)
    this.setEnabled(false)
  }

  /** On: chase with the Sun toggle on. Off (browse, or the toggle off): unlit globe, day imagery, a fixed high light. */
  setEnabled(on: boolean): void {
    this.#enabled = on
    this.#viewer.scene.globe.enableLighting = on
    if (on) return // the next update() applies the look
    if (this.#night) this.#night.show = false
    if (this.#day) this.#day.brightness = DAY_BRIGHTNESS
    this.#light.intensity = DAY_INTENSITY
    Color.clone(Color.WHITE, this.#light.color)
    this.#setIbl(1)
    this.#aimOff()
  }

  /** The chased model (null: none). Sun dims its image-based light at night and slows its environment-map rebuilds. */
  attachModel(model: Model | null): void {
    this.#model = model
    // ponytail: maximumSecondsDifference stays 3,600 s, so a slow aircraft can reflect a sky up to an hour old at dusk
    // (the IBL factor hides it at night). Upgrade: ~300 s here if the golden-hour screenshots show it.
    if (model) model.environmentMapManager.maximumPositionEpsilon = ENV_MAP_EPSILON_M
  }

  /**
   * Every frame, in both modes: tSunMs from sunTimeMs, atWC the chased aircraft (browse: the camera). Writes the clock,
   * which Cesium's sun, sky and environment maps take one frame later. On, applies sunLook at atWC; off, keeps the fixed
   * light above atWC. null, writing nothing, for a time that is no Date or a non-finite position.
   */
  update(tSunMs: number, atWC: Cartesian3): SunState | null {
    if (!Number.isFinite(this.#date.setTime(tSunMs)) || !Number.isFinite(Cartesian3.magnitudeSquared(atWC))) return null
    this.#viewer.clock.currentTime = JulianDate.fromDate(this.#date, this.#jd) // the Clock clones it on its next tick
    Cartesian3.clone(atWC, this.#at)
    const sun = sunDirectionWC(this.#jd, this.#sun)
    // ponytail: one elevation for the whole view, at atWC, with no horizon dip for a high aircraft (3.2° at 10 km).
    // Upgrade: a direct-sun factor on model.lightColor (research C7) if dusk shows a dark airliner in a sunlit sky.
    const elevDeg = sunElevationDeg(sun, atWC)
    const look = sunLook(elevDeg, this.#look)
    const st = this.#state
    st.elevDeg = elevDeg
    st.night = look.night
    st.golden = look.golden
    if (!this.#enabled) {
      this.#aimOff()
      return st
    }
    const light = this.#light
    aimLight(sun, Ellipsoid.WGS84.geodeticSurfaceNormal(atWC, this.#up), look.night, light.direction)
    light.intensity = look.intensity
    light.color.red = look.red
    light.color.green = look.green
    light.color.blue = look.blue
    this.#viewer.scene.globe.vertexShadowDarkness = look.vertexShadowDarkness
    if (this.#day) this.#day.brightness = look.dayBrightness
    if (this.#night) {
      this.#night.alpha = look.nightAlpha
      this.#night.show = look.nightAlpha > NIGHT_SHOW_ALPHA // hidden layers request no tiles: none by day
    }
    this.#setIbl(look.iblFactor)
    return st
  }

  #setIbl(f: number): void {
    if (!this.#model) return
    this.#ibl.x = this.#ibl.y = f
    this.#model.imageBasedLighting.imageBasedLightingFactor = this.#ibl // the setter copies it
  }

  #aimOff(): void {
    Transforms.eastNorthUpToFixedFrame(this.#at, Ellipsoid.WGS84, this.#enu)
    Matrix4.multiplyByPointAsVector(this.#enu, OFF_TRAVEL_ENU, this.#light.direction)
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/scene/sun.test.ts`
Expected: PASS — `ℹ tests 17`, `ℹ pass 17`, `ℹ fail 0`.

- [ ] **Step 5: Type-check these files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/sun'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 6: Commit**

```bash
git add client/scene/sun.ts client/scene/sun.test.ts
git commit -m "feat(scene): Sun — ephemeris, app-owned light, night blend, ?sun= time" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Harness page

**Files:**
- Create: `harness/sun.html`, `harness/sun.ts`
- Test: `npx tsc --noEmit`, then the page in a browser

**Interfaces:**
- Consumes: `Sun`, `parseSunParam`, `sunTimeMs`, `SunState` (Task 2); `makeNightLayer` (Task 1); `ChaseCamera` (V4), `ChaseModel` (V3), `makeImagery` (V1), `REEARTH_TERRAIN_URL` (V1); `public/models/manifest.json`; the Vite setup from WP-00
- Produces: the page `/harness/sun.html` (`?sun=`, `?at=`, `?light=0`; keys `[` `]` `{` `}` `P` `L`) and `window.harness = { viewer, sun, setTime(iso: string): void, stats(): { time, elevDeg, night, golden, lit, nightShown, dayBrightness, fps, worstMs, hitches, tilesLoaded } }` (`hitches`: the frames over 50 ms since the last `P`, as `{ ms, elevDeg }`, at most 100)

- [ ] **Step 1: Write the page**

File: `harness/sun.html`
```html
<!-- harness/sun.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Harness: sun</title>
    <style>
      html, body, #globe { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
      #info { position: absolute; top: 8px; left: 8px; padding: 6px 10px; font: 12px/1.45 ui-monospace, monospace; color: #fff; background: rgba(0, 0, 0, 0.65); border-radius: 4px; white-space: pre; pointer-events: none; }
    </style>
  </head>
  <body>
    <div id="globe"></div>
    <div id="info">loading…</div>
    <script type="module" src="/harness/sun.ts"></script>
  </body>
</html>
```

File: `harness/sun.ts`
```ts
// harness/sun.ts
// WP-E2 harness: /harness/sun.html. The chase model holds a point on the PoC's 6 km circle round LOWI (Innsbruck) at
// 2,700 m HAE and the chase camera follows it (drag to orbit, wheel to zoom, double-click to reset). Re:Earth terrain
// with vertex normals, EOX day imagery and the GIBS night layer; Sun lights it all from the sun time.
//   ?sun=2026-09-22T05:00:00Z | +6h | -30m   start time (default now; see parseSunParam)
//   ?at=0      seconds into the circle where the aircraft holds (default 0: 6 km east, heading north: the PoC's view)
//   ?light=0   start with the Sun off (the browse look)
// Keys: [ ] −/+ 1 h   { } −/+ 10 min   P time-lapse ×600 (and clears the hitch log)   L Sun on/off
// window.harness = { viewer, sun, setTime(iso), stats() }
import { Cartesian3, CesiumTerrainProvider, Ellipsoid, ImageryLayer, Resource, Viewer } from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { ChaseCamera } from '../client/scene/chaseCamera.ts'
import { makeImagery } from '../client/scene/imagery.ts'
import { ChaseModel } from '../client/scene/model.ts'
import { makeNightLayer } from '../client/scene/nightLights.ts'
import { Sun, parseSunParam, sunTimeMs, type SunState } from '../client/scene/sun.ts'
import { REEARTH_TERRAIN_URL } from '../client/scene/terrain.ts'
import type { ModelManifest, RenderState } from '../client/types.ts'

const q = new URLSearchParams(location.search)
const LOWI = { lat: 47.2602, lon: 11.3439 }
const RADIUS_M = 6000 // the PoC's circle: its north side crosses the Nordkette ridge (Hafelekar 2,334 m)
const H_M = 2700
const SPEED_MS = 70
const M_PER_DEG = 111_320
const AT_S = Number(q.get('at')) || 0
const HOUR_MS = 3_600_000
const LAPSE = 600

/** The PoC's counter-clockwise circle round LOWI, level. */
function stateAt(tS: number): RenderState {
  const th = (SPEED_MS / RADIUS_M) * tS
  const headingDeg = ((Math.atan2(-Math.sin(th), Math.cos(th)) * 180) / Math.PI + 360) % 360
  return {
    hex: '440abc', lat: LOWI.lat + (RADIUS_M * Math.sin(th)) / M_PER_DEG,
    lon: LOWI.lon + (RADIUS_M * Math.cos(th)) / (M_PER_DEG * Math.cos((LOWI.lat * Math.PI) / 180)),
    hM: H_M, headingDeg, pitchDeg: 0, rollDeg: 0, gsKt: SPEED_MS / 0.514444, trackDeg: headingDeg, altBaroFt: H_M / 0.3048,
    vsFpm: 0, mode: 'interp', altSource: 'geom', onGround: false, ageS: 1, quality: 'adsb2', callsign: 'HOP1', typeCode: 'A320',
  }
}

const iso = (t: number): string => (Math.abs(t) <= 8.64e15 ? new Date(t).toISOString().slice(0, 19) + 'Z' : 'invalid')

async function main(): Promise<void> {
  const [terrainProvider, dayProvider, manifest] = await Promise.all([
    // Normals for slope shading; the query gives normal tiles their own browser-cache key (design D1).
    CesiumTerrainProvider.fromUrl(new Resource({ url: REEARTH_TERRAIN_URL, queryParameters: { extensions: 'octvertexnormals' } }), { requestVertexNormals: true }),
    makeImagery({ terrain: 'reearth', imagery: 'eox', ionToken: null, apiBase: '/api' }),
    fetch('/models/manifest.json').then((r) => r.json() as Promise<ModelManifest>),
  ])
  const day = dayProvider ? new ImageryLayer(dayProvider) : null
  const viewer = new Viewer('globe', {
    terrainProvider, baseLayer: day ?? false,
    timeline: false, animation: false, geocoder: false, baseLayerPicker: false, sceneModePicker: false,
    navigationHelpButton: false, homeButton: false, infoBox: false, selectionIndicator: false, fullscreenButton: false,
    requestRenderMode: false,
  })
  viewer.scene.globe.depthTestAgainstTerrain = true
  const night = makeNightLayer()
  viewer.imageryLayers.add(night)
  const sun = new Sun(viewer, { day, night })
  const model = await ChaseModel.load(viewer, manifest.models.find((m) => m.id === manifest.default)!)
  model.model.enableVerticalExaggeration = false // design D6 (WP-E1 moves it into ChaseModel.load)
  sun.attachModel(model.model)
  let lit = q.get('light') !== '0'
  sun.setEnabled(lit)
  const chase = new ChaseCamera(viewer)
  const s = stateAt(AT_S)
  const aircraftWC = Cartesian3.fromDegrees(s.lon, s.lat, s.hM, Ellipsoid.WGS84)

  let tSunMs = sunTimeMs(Date.now(), parseSunParam(location.search))
  let lapse = false
  let state: SunState | null = null
  let last = performance.now()
  const frameMs: number[] = []
  // Frames over 50 ms since the last P, with the sun elevation: the dusk's shader compiles (the night layer's first draw).
  const hitches: { ms: number; elevDeg: number }[] = []
  const fps = (): number => (1000 * frameMs.length) / frameMs.reduce((a, b) => a + b, 0)
  const info = document.getElementById('info')!
  let infoAt = 0

  viewer.scene.preUpdate.addEventListener(() => {
    const now = performance.now()
    const dtMs = now - last
    last = now
    frameMs.push(dtMs)
    if (frameMs.length > 240) frameMs.shift()
    if (dtMs > 50 && state !== null && hitches.length < 100) hitches.push({ ms: Math.round(dtMs), elevDeg: Math.round(state.elevDeg * 10) / 10 })
    if (lapse) tSunMs += dtMs * LAPSE
    model.update(s)
    chase.update(s, Math.min(0.1, dtMs / 1000))
    state = sun.update(tSunMs, aircraftWC)
    if (now - infoAt < 250) return
    infoAt = now
    info.textContent = [
      `time   ${iso(tSunMs)}${lapse ? `  time-lapse ×${LAPSE}` : ''}`,
      state === null ? 'sun    —' : `sun    elev ${state.elevDeg.toFixed(1)}°  night ${state.night.toFixed(2)}  golden ${state.golden.toFixed(2)}`,
      `light  ${lit ? 'Sun on' : 'Sun off'}  night layer ${night.show ? `shown, alpha ${night.alpha.toFixed(2)}` : 'hidden'}`,
      `fps    ${fps().toFixed(0)}  worst frame (last 60) ${Math.max(...frameMs.slice(-60)).toFixed(1)} ms  over 50 ms since P ${hitches.length}`,
      'keys   [ ] ±1 h   { } ±10 min   P time-lapse   L Sun',
    ].join('\n')
  })

  window.addEventListener('keydown', (e) => {
    if (e.key === '[') tSunMs -= HOUR_MS
    else if (e.key === ']') tSunMs += HOUR_MS
    else if (e.key === '{') tSunMs -= HOUR_MS / 6
    else if (e.key === '}') tSunMs += HOUR_MS / 6
    else if (e.key === 'p' || e.key === 'P') {
      lapse = !lapse
      hitches.length = 0
    } else if (e.key === 'l' || e.key === 'L') sun.setEnabled((lit = !lit))
  })

  ;(window as unknown as { harness: object }).harness = {
    viewer,
    sun,
    setTime: (t: string) => void (tSunMs = Date.parse(t)),
    stats: () => ({
      time: iso(tSunMs), elevDeg: state?.elevDeg ?? null, night: state?.night ?? null, golden: state?.golden ?? null, lit,
      nightShown: night.show, dayBrightness: day?.brightness ?? null, fps: fps(), worstMs: Math.max(...frameMs.slice(-60)),
      hitches: hitches.slice(),
      tilesLoaded: viewer.scene.globe.tilesLoaded,
    }),
  }
}

main().catch((err: unknown) => {
  document.getElementById('info')!.textContent = `error: ${err instanceof Error ? err.message : String(err)}`
  console.error(err)
})
```

- [ ] **Step 2: Type-check the page**

Run: `npx tsc --noEmit 2>&1 | grep -E 'harness/sun'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Look at it**

Run: `npx vite --port 5452 --strictPort`. Open each page, wait for `tilesLoaded: true` in `harness.stats()`, then compare it with the PoC screenshots in `plans/assets/WP-E/poc/`. The elevations below are the Node (TEME) values at the hold point. The browser (ICRF) differs by up to 0.4°.
- `http://localhost:5452/harness/sun.html?sun=2026-06-21T06:30:00Z` (morning, like `02-sun-lighting.jpg`). Expected: overlay `sun elev 29.6°  night 0.00  golden 0.00`, `night layer hidden`. The slopes facing the sun in the east (azimuth 87°) are lit, and the slopes facing away are in shade. DevTools Network: no request to `gibs.earthdata.nasa.gov`. Re:Earth tile URLs carry `?extensions=octvertexnormals`.
- `…?sun=2026-06-21T18:40:00Z` (golden hour, like `03-golden-hour.jpg`). Expected: `elev 3.7°  night 0.00  golden 0.84`. The light is warm and comes from the west-north-west (azimuth 301°), and the shaded slopes are warm grey, not black.
- `…?sun=2026-06-21T21:30:00Z` (night, like `04-night.jpg`). Expected: `elev −15.5°  night 1.00  golden 0.00`, `night layer shown, alpha 1.00`. The Innsbruck lights glow in the valley, and the mountains are dim but readable under a light from overhead. The aircraft is dim and not glowing, and its underside is no brighter than its top. The sky is dark. GIBS requests are PNG tiles at z ≤ 8, all HTTP 200.
- On the night page, press `L`. Expected: `Sun off`, `night layer hidden`. The globe is the flat, unlit daytime imagery, and the aircraft is lit white from high in the south. Press `L` again to get the night back.
- `…?sun=2026-09-22T16:30:00Z`, wait for the tiles, then `P` (time-lapse ×600: 1 h in 6 s; `P` also clears the hitch log). Keep it running until the overlay shows an elevation below −9° (full night is −8°: about 18:00Z, 9 s after `P`), then read `harness.stats().hitches`. Expected: the sun sets past 17:08Z. The light warms, then fades towards overhead. The night layer appears (below +1.4°, about 16:58Z) without a visible pop. Frames over 50 ms, if any, come only just after the night layer appears, when its first tiles arrive: Cesium compiles the globe's shaders for tiles with a second texture and `APPLY_ALPHA`. Sun cannot pre-warm that while the layer is hidden by day (D8). Record the entries (`ms` and `elevDeg`) for gate GE. There is none at or after full night: the day brightness and the night alpha stop at 0.9999, so no other variant is compiled.
- `[` / `]` step the time by an hour, and `{` / `}` by 10 minutes. `harness.setTime('2026-09-22T10:00:00Z')` gives `elev ≈ 40.7°` (ICRF) at noon, and `harness.stats()` matches the overlay. The console has no errors.

Stop the server.

- [ ] **Step 4: Commit**

```bash
git add harness/sun.html harness/sun.ts
git commit -m "test(scene): sun harness — LOWI chase view with time keys and time-lapse" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: WP gate

- [ ] **Step 1: This package's tests**

Run: `node --test client/scene/nightLights.test.ts client/scene/sun.test.ts`
Expected: `ℹ tests 21`, `ℹ pass 21`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/(sun|nightLights)|harness/sun'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Full check**

Run: `npm run check`
Expected: `tsc` prints nothing, then `ℹ tests 632`, `ℹ fail 0` (611 on the E0 tree + 21). Two timing tests can fail under full-suite load and pass when run alone: "sortRows and filterRows stay cheap at 12,000 rows" (`client/ui/table.test.ts`) and "budget: /api/view of a 250 nm circle with 5,000 aircraft" (`server/main.browse.test.ts`). They are known flakes, not regressions. Any other failure must be fixed.

- [ ] **Step 4: Confirm there is nothing left to commit**

Run: `git status --short`
Expected: no output.

## Notes for later work

- **D12, replay time.** A replay is lit at the time it was recorded once WP-E5's `StatusBrief.upstreamOffsetMs` reaches `sunTimeMs` (E-A passes `status.upstreamOffsetMs ?? 0`). Until the server reports it, or with an older server, the offset is 0 and a replay is lit at wall-clock time. `?sun=<ISO>` then fixes any instant, for example the recording's, and `?sun=+6h` shifts a live view for demos. For live sources the offset is only the network latency (well under 0.01° of sun movement).
- **Rejected: Cesium's `SunLight` with `ImageryLayer.dayAlpha`/`nightAlpha`** (research C3, C4, C7). Once the terrain has vertex normals, which relief shading needs, the globe compiles `ENABLE_VERTEX_LIGHTING`, and the per-pixel day/night blend exists only under `ENABLE_DAYNIGHT_SHADING` (`GlobeFS.glsl:213`, `:343`). So `dayAlpha`/`nightAlpha` do nothing, and the night layer must be faded from JS. `SunLight` also follows the sun below the horizon (`UniformState.js:1508-1516`). At dusk and at night it lights the slopes that face the sun from below the horizon, and it lights the aircraft's belly through the Earth. Cast shadows cannot hide that, because the shadow map switches itself off below the horizon. The app-owned `DirectionalLight` (never below +2°, blended to overhead at night) fixed both in the PoC (screenshots 03, 04).
- **Shadows (user feedback, 2026-09-22).** With the PoC's Shadows toggle off, the terrain and the aircraft were still shaded. That is Lambert shading (N·L) by the light, which gives relief its shape. It is not a cast shadow. Cast shadows (the toggle) cost 65 → 46–52 fps and drew acne stripes on the aircraft for a small visual gain, so D10 drops them. `Sun` never sets `viewer.shadows`, and a test holds it at false.
- **Deviations from the design brief and the WP brief:**
  - The design's §5 names the look function `sunFactors`. It is `sunLook` here, as the WP brief asks. It takes an optional `result`, so `Sun` reuses one object per frame.
  - `sunTimeMs` has a third parameter, `upstreamOffsetMs = 0`, so D12's formula is tested here and not re-derived in E-A.
  - `parseSunParam` reads a space as `+` (URL decoding), treats a zone-less time as UTC and rejects a date without a time.
  - `aimLight` normalises once, after the night blend. See Architecture: the same result at night 0 and 1, < 1 % between, and no zero vector at the antisolar point.
  - The off light comes from azimuth 180° (south), 60° high. `update()` re-aims it at `atWC` every frame while off, so E-A calls `update()` in browse too, with the camera position.
  - The harness adds `L` (Sun on/off), `?light=0` and `?at=` to the requested keys, to check the off look. Its time stands still except for the keys and the time-lapse, as in the PoC, so screenshots are repeatable.
  - `NIGHT_CREDIT` goes into Cesium's credit pop-up, not on screen. E-A's attribution line names GIBS.
- **ponytail: one light for the whole view.** The sun elevation is taken at the chased aircraft. A chase view spans < 1°, and the terminator moves about 15°/h, so the view and the aircraft share one regime. There is no horizon dip either: at 10 km an airliner still sees the sun 3.2° below the ground's horizon, but it is lit like the valley below it. Upgrade: a direct-sun factor from `horizonDipDeg` on `model.lightColor` (research C7, C8), if GE's dusk screenshots show a dark airliner in a sunlit sky.
- **ponytail: the environment map's time step.** `maximumSecondsDifference` stays at 3,600 s. A parked or slow aircraft can reflect a sky up to an hour old at dusk (VERIFY). The IBL factor dims it at night. Upgrade: set it to about 300 s in `attachModel` if the golden-hour screenshots show a stale sky on the aircraft.
- **Fog at dusk.** Cesium darkens the fog by sin(sun elevation) at the viewer, down to `fog.minimumBrightness` 0.03 (VERIFY), so distant ridges fade early at dusk. Tune it only with screenshots (§4).
- **The night layer's first draw compiles once (review, 2026-09-23).** Cesium picks the globe's shader program by the number of textures on a tile and by flags such as `APPLY_BRIGHTNESS` and `APPLY_ALPHA`, and compiles one on a cache miss (Sources). The day brightness (0.9999) is compiled at load. The night alpha stops at 0.9999, so full night keeps the dusk's `APPLY_ALPHA` program. As first written, the alpha reached exactly 1 at −8°, and Cesium compiled a third program at the first full night. The first draw of the night layer (near +1.4°) still adds a texture to the tiles and compiles once per session. It cannot be pre-warmed while D8 keeps the layer hidden by day, which is what keeps GIBS traffic at zero. Task 3 Step 3 measures it (`stats().hitches`), and gate GE records it through WP-E-A Task 5 Step 1. The design's D8 still says "no shader compile at the first dusk". That file is not this package's: its owner should reword it to "no compile from the day brightness or at full night; one at the night layer's first draw".
- **GIBS tiles** come with `cache-control: no-store`, so every dusk downloads the night tiles in view again (z ≤ 8, about 70 KB each). By day the layer is hidden and costs nothing.
- **Runways** stay flat-coloured until E3 gives them a lit appearance (D7). With E3 they follow this light, including the off light in browse.

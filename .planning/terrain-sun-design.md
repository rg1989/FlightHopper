# Terrain & sun — design brief (user feedback #3, 2026-09-22)

**Request.** In chase mode: (1) visible 3-D topography with the satellite imagery draped over it, switchable, ideally animated so the mountains grow out of the flat map and sink back; (2) sunlight: day/night from the real sun position, shading the terrain and the aircraft, and cast shadows. Proof of concept now, plans now, implementation later.

**Status.** Proof of concept done (below). Work packages E0–E5 and E-A are planned in `plans/WP-E*.md` (PLAN.md §5.4), each validated in a scratch copy of the integrated tree, which is byte-identical to `main` for every file they edit. Nothing is implemented in the app yet.

## 1. Why the chase view looks flat today

The integrated tree already draws real relief: `client/scene/terrain.ts` loads Re:Earth quantized-mesh (WGS84 ellipsoidal heights). It reads as flat for three reasons:
1. The terrain provider does not request vertex normals, so Cesium cannot shade slopes.
2. `globe.enableLighting` is off. Even with it on but without normals, Cesium only shades by the ellipsoid normal and fades that to fully lit when the camera is closer than ~3,600 km (`lightingFadeOutDistance`). A chase camera never sees it.
3. `viewer.clock` is frozen at page load (`shouldAnimate` false, never written), so any sun is at the wrong time.

So "topography" = vertex normals + sun lighting + a way to switch the relief off (flatten) and back on (grow).

## 2. Proof of concept (2026-09-22)

`plans/assets/WP-E/poc/terrain-sun.ts` (+ `.html`) was run in the integrated tree (`harness/terrain-sun.html`): the real chase model and `ChaseCamera` fly a level circle over Innsbruck (LOWI, r = 6 km over the Nordkette ridge, 2,700 m HAE) on Re:Earth terrain with normals, EOX imagery and NASA GIBS night lights. `plans/assets/WP-E/poc/bench.mjs` drove it in headless Chrome over CDP on the MacBook Air M2 (ANGLE Metal, 1280×713, `--disable-frame-rate-limit`). Screenshots: `plans/assets/WP-E/poc/NN-*.jpg` (numbers below); raw numbers: `plans/assets/WP-E/poc/results-*.json`.

| Question | Result |
|---|---|
| Does lighting make relief visible? | Yes. `requestVertexNormals` + `enableLighting` gives slope shading (01 vs 02). Cost: 89.3 vs 91.5 fps (≈ free). |
| Can topography be switched off and animated? | Yes: `scene.verticalExaggeration` 1 → 0 (smoothstep, 2.5 s) around `verticalExaggerationRelativeHeight` = ground under the aircraft. The imagery stays draped; the mountains sink into a flat map and grow back (05–08). Without shadows, warm cache: animation frames average 6.2 ms, worst 12.8 ms. |
| Hitch when leaving 1.0 | **686–2,008 ms** first frame (Cesium adds geodetic normals to every loaded tile). Fixed by never returning to exactly 1: "on" = **1 + 1e-5** → worst animation frame **36–44 ms**. |
| Does `globe.getHeight` follow the animation? | Yes, it returns the drawn (exaggerated) surface, one frame late. Probes at two peaks match `(true − relH)·f + relH` within the one-frame lag (20–35 m at mid-animation) plus LOD. |
| Terrain heights after an animation | **Cesium bug**: 40/80 `getHeight` samples under the aircraft returned `undefined` after animations (TerrainPicker worker/reset race), 5 during them. A single tiny factor change 0.5 s after the animation ends ("nudge") → **0/80 and 0**. |
| Aircraft during the animation | **Cesium default**: `Model.enableVerticalExaggeration` is true, so the aircraft is squashed towards relH and vanishes (09, f = 0.48). With `false` it stays at its true HAE (05–08). |
| Night lights | Cesium ignores `ImageryLayer.dayAlpha/nightAlpha` once the terrain has vertex normals (the blend exists only in the no-normals shader path). The app must fade the night layer itself. Works (04). |
| Sun below the horizon | A `SunLight` below the horizon still lights slopes that face it, and the model is lit through the Earth. An app-owned `DirectionalLight` that follows the sun but never drops below +2°, blending to a dim light from overhead at night, looks right (03, 04). |
| Cast shadows | Work (mountains on valleys 10, aircraft shadow on terrain 11), but cost **65 → 46–52 fps**, show acne stripes on the aircraft, and the user judged the visual gain small (feedback 2026-09-22). **Dropped.** |

## 3. Decisions

| # | Decision | Why / evidence |
|---|---|---|
| D1 | Terrain always requests vertex normals (Re:Earth and ion). Re:Earth URL gets `?extensions=octvertexnormals` so normal tiles have their own browser-cache key. | Re:Earth varies the tile body by `Accept` without a `Vary` header and caches 30 days, so old no-normals tiles would be reused (research B4; verifier confirmed the query survives into every tile URL). No water mask (+64 KB per coastal tile). |
| D2 | Topography on/off = `scene.verticalExaggeration` animated between `TOPO_ON = 1 + 1e-5` and 0 with smoothstep over 2.5 s. Never swap the terrain provider (reloads every tile and imagery, cannot animate, puts the ground at 0 m HAE). | PoC hitch numbers. Cost of the epsilon: geodetic normals stay on every tile (~30 % more terrain-mesh memory, Cesium PR #9603). |
| D3 | One `Topography` object is the only writer of `verticalExaggeration` / `verticalExaggerationRelativeHeight`. 0.5 s after each animation ends it adds 1e-7 to the factor once (nudge). Both values are guarded with `Number.isFinite` (Cesium's debug assertions ship in this Vite build: a NaN throws inside `render`). | PoC 40/80 → 0/80. |
| D4 | relH (the flat plane's height) is latched when a flatten starts: the nearest hero airport's runway HAE if within 30 km of the chased aircraft, else the drawn ground under it, else 0. While flat, a new selection re-latches relH (the camera jumps anyway). Aircraft keep their true HAE; only the ground moves. | Runway and touchdown agree near hero airports. At f = 0 the drawn ground is relH everywhere, so `placedHeightM` stays correct. |
| D5 | Ground readings in `frame()` are corrected for the one-frame lag: `rescaleSampledM(h, fSampled, fNow, relH)`. `ChaseCamera` takes an optional `groundAt` so its clearance uses the corrected ground. | Research A7/E4: up to 20–45 m error mid-animation, more than the 15 m clearance. |
| D6 | The chase model loads with `enableVerticalExaggeration: false`. | PoC. |
| D7 | Runways: one `Primitive` per airport, shifted along the local up by `drawnHeightM(h, f, relH) − h` through `modelMatrix`, with a lit appearance (so they darken at night); markers follow. Fleet ground icons store the true ground height and draw at `drawnHeightM`. | Runways and ground icons are fixed-HAE and would float or sink when flattened (research A11, E7, E8). |
| D8 | Sun: every chase frame `viewer.clock.currentTime` = render time (`tRenderMs`, plus the `?sun=` override). An app-owned `DirectionalLight` (PoC `aimLight`) replaces `SunLight`. Night: GIBS VIIRS Black Marble layer alpha, day-layer brightness, light intensity and model image-based lighting are faded from the sun elevation at the chased aircraft. Golden hour: warm light colour and a higher ambient floor (`globe.vertexShadowDarkness`). `scene.atmosphere.dynamicLighting = SUNLIGHT`. Night layer `show = false` in daylight (no tile traffic). Day-layer brightness pre-warmed at 0.9999 (no shader compile at the first dusk). | PoC screenshots 02–04. Research C. |
| D9 | Lighting applies in chase only. Browse (the top-down street map) stays unlit, day, as today. Topography is global (browse is top-down, so the factor is invisible there, and Esc does not animate). | Readability of the street map at night. |
| D10 | No cast shadows (`viewer.shadows` stays false). | PoC + user feedback. Recorded so nobody re-adds them without measuring. |
| D11 | UI: a two-button group ("3-D terrain", "Sun") at the top of the right column, chase only, `aria-pressed`. Keys **T** and **L** (ignored with a modifier key or while typing in an input). Preferences: URL (`?topo=0|1`, `?light=0|1`) > `localStorage['fh.scene.v1']` > defaults (both on). `?sun=<ISO>` fixes the sun time, `?sun=+6h` / `-2h` offsets it (demos). | Research E12–E14. |
| D12 | Replays are lit at the time they were recorded (user decision 2026-09-22). The server re-stamps samples to its own clock, so its status reply gains `upstreamOffsetMs` (the poller's server − upstream clock offset, already computed for stamping). Sun time = `tRenderMs − upstreamOffsetMs`, then the `?sun=` override. For live sources the offset is only network latency. | Research C16. |
| D13 | NASA GIBS (keyless, CORS `*`, zoom ≤ 8) is added to the allowed services, with its acknowledgment in the credits. | It is free and keyless like EOX; PLAN.md's list is amended by this feature. |

**Rejected:** swapping to `EllipsoidTerrainProvider` for "off" (reload, flicker, no animation, wrong datum); Cesium's `dayAlpha/nightAlpha` (dead with normals); cast shadows (D10); HDR (not needed, cost unmeasured); water mask; raising `tileCacheSize` (unmeasured, later).

## 4. Constants (from the PoC; tune only with screenshots)

| Name | Value | Meaning |
|---|---|---|
| `TOPO_ON` | 1 + 1e-5 | exaggeration while topography is on |
| `TOPO_ANIM_MS` | 2500 | grow/sink duration, smoothstep |
| `NUDGE_DELAY_MS`, `NUDGE` | 500, 1e-7 | picker re-arm after an animation |
| `HERO_RELH_KM` | 30 | hero airport within this distance → relH = its runway HAE |
| `night01(el)` | smoothstep((2 − el)/10) | 0 at +2°, 1 at −8° |
| `golden01(el)` | smoothstep((15 − el)/15) | 0 at +15°, 1 at 0° |
| `MIN_LIGHT_ELEV_DEG` | 2 | the light never comes from lower |
| light intensity | 2.0 → 0.45 by `night01` | day → night |
| light colour | white → (1.0, 0.8, 0.62) by `golden01·(1 − night)` | warm low sun |
| `globe.vertexShadowDarkness` | 0.3 + 0.2·golden·(1 − night) | ambient floor |
| day layer brightness | min(0.9999, 1 − 0.7·night) | darker land at night |
| night layer alpha / brightness | night / 1.6 | city lights |
| model image-based lighting factor | 1 − 0.85·night | no glowing aircraft at night |
| `environmentMapManager.maximumPositionEpsilon` | 20,000 m | no env-map rebuild every ~4 s at airliner speed |

## 5. Work packages (ownership is disjoint)

| WP | Needs | Owns | Produces |
|---|---|---|---|
| **E0** Contract | B-A | `client/scene/exaggeration.ts` + test (new); additive edit to `client/types.ts` | `TOPO_ON`, `drawnHeightM(trueM, f, relHM)`, `trueHeightM(drawnM, f, relHM): number \| null`, `rescaleSampledM(h, fSampled, fNow, relHM)`, `smoothstep(u)`; `interface ScenePrefs { topo: boolean; light: boolean }`, `interface TerrainFrame { fSampled: number; fNow: number; relHM: number }` |
| **E1** Topography | E0 | `client/scene/topography.ts` + test (new), `harness/topography.*`; edits `client/scene/terrain.ts` (V1), `client/scene/model.ts` (V3), `client/scene/chaseCamera.ts` (V4) and their tests | `class Topography` (animation, epsilon, nudge, relH latch, lag correction), `pickRelHM(...)`, `ChaseCameraOpts.groundAt?`, normals + cache key, `enableVerticalExaggeration: false` |
| **E2** Sun | E0 | `client/scene/sun.ts` + test, `client/scene/nightLights.ts` + test (new), `harness/sun.*` | ephemeris helpers, `sunFactors`, `parseSunParam`, `sunTimeMs`, `class Sun` (clock, light, night blend, model lighting, browse off), `makeNightLayer()`, `NIGHT_CREDIT` |
| **E3** Ground objects | E0 | edits `client/scene/runways.ts` (V5) + test, `client/scene/fleetLayer.ts` (B-V1) + test | runways `update(f, relHM)` (per-airport modelMatrix shift, lit), `FleetLayer.setTerrain(f, relHM)` |
| **E4** Scene toggles | E0 | `client/ui/scenePrefs.ts`, `client/ui/sceneToggles.ts` + tests, `client/ui/sceneToggles.css`, `harness/scene-toggles.*` (new) | `readScenePrefs`, `writeScenePrefs`, `PREFS_KEY`, `mountSceneToggles(root, { prefs, onChange })` |
| **E5** Recorded sun time | base | additive edit to `shared/api.ts`; edits `server/poller.ts` (I1/B-S1) + test, `server/main.test.ts` (its `/api/status` key list) | `StatusBrief.upstreamOffsetMs?: number` (poller clock offset, ms) |
| **E-A** Integration | E1–E5 | edits `client/app.ts` + test, `client/ui/layout.css` (B-A); `plans/assets/WP-E-A/gen-synthetic-lowi.ts` | frame order (topography → clock → placement → sun → runways/fleet), select() switches lighting, keys T/L, prefs, attribution line, gate GE |

## 6. Gate GE (after E-A)

On the MacBook Air M2, synthetic LOWI replay (valley arrival + Nordkette pass), chase, topography and sun on:
- FPS p50 ≥ 60, p5 ≥ 30; no long task > 50 ms after load, including 10 terrain toggles; worst animation frame reported.
- Camera ≥ 15 m above the drawn terrain every frame (G3's rule), including during animations.
- 0 `undefined` ground readings under the chased aircraft once tiles are loaded, after 10 toggles.
- Screenshots at LOWI: morning, golden hour, night; KSFO day; the grow sequence; browse at local night (street map not darkened).
- `T`/`L` typed into the table search box do nothing; preferences survive a reload; `?topo=0` wins over the stored value.

## 7. Decisions taken with the user

1. **Night look** (decided 2026-09-22): mountains stay faintly visible under a dim light from overhead, so peak clearance stays readable.
2. **Replay lighting** (decided 2026-09-22): the recorded time (D12, WP-E5).
3. **Upstream note.** The TerrainPicker race (D3) is a Cesium bug worth reporting with a Sandcastle repro. Our nudge works around it; a report is the user's call.

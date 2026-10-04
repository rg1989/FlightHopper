# Weather and map in 3-D — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The chase (3-D) view gets the weather the top-down map has — and more — drawn as a pilot would see it, and
its map overlays read well: thin roads, crisp borders, place names upright for the camera.

**User's words (2026-10-03):** "implement all the weather features we can in 3d as long as performance stays good …
look at how borders and roads appear in 3d mode, i think roads are extremely wide looking … fonts appear not focused …
make names and texts shown for countries etc in 3d mode to be oriented correctly for the user camera angle, currently he
might need to read sideways or upside down." The user is away: the controller decides and checks every task in the
browser.

**What the controller saw (headless Chrome, chase over SFO, satellite + Roads + Borders & places):** distant roads are
wide orange bands (Esri's road raster drawn for top-down zooms, on far terrain tiles); names baked into the Esri places
raster lie on the ground, blurry and turned with the map, not the camera.

**Architecture:** five tasks, each leaving the app working.
1. Chase map: the roads raster only on near terrain tiles; borders drawn by us as thin crisp lines on any terrain tile;
   place names as an HTML overlay, upright, decluttered.
2. 3-D weather foundation: `Weather3D` (data around the chased aircraft), the Weather switch in the chase's Layers panel,
   hazard areas (SIGMETs) as translucent volumes at their heights.
3. Clouds from airport reports (Cesium `CloudCollection`), ground fog from visibility (a post-process stage), rain or
   snow around the camera (Cesium `ParticleSystem`).
4. Rain clouds and rain shafts where the radar shows rain near the aircraft.
5. Model clouds everywhere else and model winds aloft (Open-Meteo, through our server), the winds as the flight-data
   frame's fallback when the aircraft sends none.

**Tech Stack:** TypeScript 7, Node 25 `node:test`, Cesium 1.145 (`CloudCollection`, `CumulusCloud`, `ParticleSystem`,
`PostProcessStage`, `ImageryLayer` option `minimumTerrainLevel`), Vite. No new dependencies.

## Global Constraints

- Performance: the chase must stay smooth. Budgets: clouds ≤ 700 drawn at once, culled beyond 150 km; particles ≤ 3000;
  one post-process pass, only while fog is on; place labels ≤ 60 in the DOM; per-frame JS of each new piece ≲ 1 ms
  (heavier work throttled or queued with `client/scene/drawQueue.ts`). Nothing new runs in the top-down map or while
  the 3-D weather / Borders & places are off.
- The data stays what the sources send: METAR/SIGMET (aviationweather.gov via server/wx.ts), RainViewer's newest past
  frame (client/scene/radar.ts `RadarSource`), Open-Meteo's forecast (Task 5). Where we estimate (cloud tops, cloud
  bases under radar echoes), the code says so in a comment; no invented weather where the data says none.
- 3-D weather shows only live: hidden in History (`hist !== null`) and in scenarios (`run !== null`), where the panel
  line says why ("Live only").
- Top-down behaviour stays as it is (its roads, Esri places raster, 2-D weather).
- Data files we build go in `public/map/` from public-domain sources (Natural Earth); downloads cached under
  `node_modules/.cache` as `tools/build-places.ts` does. The repo is public: nothing from FR24/ADSBx.
- Copy is plain words; no filler. Repo style: header comment per file (what and why), comments only where code can't
  say it, `ponytail:` names a known ceiling. Match neighbouring code.
- The user's Mac is shared and was made unusable by heavy runs before: every command that does work runs at background
  priority, one at a time — `taskpolicy -b nice -n 19 npm run typecheck`,
  `taskpolicy -b nice -n 19 node --test --test-concurrency=1 <the test files you touched>`. No dev servers, no browsers,
  no full test suite (the controller runs those).
- Commit on branch `feat/weather-3d` in `../FlightHopper-liveries`; end commit messages
  with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Chase map — thin roads, crisp borders, upright names

**Files:** `client/scene/mapLayer.ts` (+test), new `client/scene/borders.ts` (+test), new `client/scene/placeLabels.ts`
(+test), new `tools/build-map-overlays.ts` (+test), new `public/map/borders.json`, `public/map/seas.json`,
`client/app.ts`, a CSS file for the labels (follow where layout.css keeps the traffic brackets' styles).

1a. **Roads in the chase.** `makeReferenceLayers` gains a third layer: the same Esri World_Transportation URL with
`minimumTerrainLevel: CHASE_ROADS_MIN_TERRAIN_LEVEL` (start at 12; a constant the controller tunes by eye), hidden.
`ReferenceLayers` gains `chase: boolean`: while true the Roads switch shows that layer instead of the top-down one, and
the Esri places raster stays hidden (1b and 1c take over in the chase). app.ts sets it from `chasing`.

1b. **Borders, drawn by us.** `tools/build-map-overlays.ts` downloads Natural Earth (public domain)
`ne_10m_admin_0_boundary_lines_land.geojson` (raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/)
and writes `public/map/borders.json`: `{ "lines": number[][] }`, each line `[lon0, lat0, dlon1, dlat1, …]` in integer
units of 1e-4° (delta-encoded after the first point). `client/scene/borders.ts`: `decodeBorders(json)` → lines as
Float64Array lon/lat + a bounding box each; `BordersProvider` (an ImageryProvider subclass, as weather.ts'
`RadarProvider` extends `UrlTemplateImageryProvider`) draws each requested tile (Web Mercator, levels 0–18) on a
256-px canvas: every line crossing the tile's box (plus a 2-px margin), a dark halo `rgba(0, 0, 0, 0.45)` 3 px wide under
a `rgba(255, 238, 205, 0.92)` 1.4 px line, round joins; a tile with no line → one shared 1 × 1 clear image. The data
is fetched once, when the layer is first shown (requests before then wait for it). Because every tile draws its lines at
the same pixel width whatever its zoom, borders stay thin at any distance and drape on any terrain. A chase-only
imagery layer, shown while `chase && places`.

1c. **Place names, upright.** `client/scene/placeLabels.ts`: an HTML overlay (a div over the Cesium canvas, under the
app's UI; pointer-events none) of names for the chase, while Borders & places is on.
- Data: `public/search/places.json` (`shared/places.ts`: cities with population, countries with a box; fetch it — the
  browser shares the search box's copy) and `public/map/seas.json` (from 1b's tool: Natural Earth
  `ne_10m_geography_marine_polys`, one label point per sea/ocean/gulf/bay — a point well inside the polygon, e.g. the
  centre of the largest inscribed circle found on a coarse grid — with its `scalerank`).
- Candidates, recomputed every 500 ms from the camera position: cities by population with a reach (5 M+: 1,500 km;
  1 M+: 600 km; 300 k+: 250 km; 100 k+: 120 km; 30 k+: 60 km; else 25 km); countries (the centre of their box) from
  150 to 3,000 km; seas from 50 to 4,000 km (scalerank ≤ 2 farther, others to 800 km). Each candidate's ground height
  from `globe.getHeight` when its tile is loaded (cached once known), else 0.
- Every frame: project the candidates (`SceneTransforms.worldToWindowCoordinates`), drop those behind the camera, beyond
  the globe's horizon (`EllipsoidalOccluder`) or off screen; place by priority (countries, seas, then cities by
  population) skipping any whose box overlaps one already placed (4 px gap); reuse DOM nodes; at most 60. Each label
  fades out over the last 20 % of its reach. Measure a label's size once, when created.
- Look (the app's font): cities white 600, 13 px (5 M+ 15 px, under 100 k 12 px), with a 1-px dot at the place and the
  text centred above it; countries 600 12 px uppercase, letter-spacing 0.14em, `rgba(255, 255, 255, 0.85)`, no dot;
  seas italic 12px `#9fd3ff`, no dot. A dark halo for legibility over imagery:
  `text-shadow: 0 0 2px rgba(0,0,0,.95), 0 0 6px rgba(0,0,0,.6)`.
- Upright and crisp by construction (screen text at device resolution).

Tests: decodeBorders round trip; a tile with a line draws pixels along it and none far from it (fake 2-D context
recording strokes is fine); the tool's encoder/decoder and its inside-point finder; placeLabels' pure parts (candidate
selection by reach/tier, the greedy declutter over boxes, horizon/behind culling with a fake camera).

- [ ] Build the data (`taskpolicy -b nice -n 19 node tools/build-map-overlays.ts`), commit the two JSON files.
- [ ] Implement with tests; typecheck; touched tests; commit `feat(chase): thin roads, crisp borders and upright place names in 3-D`.

---

### Task 2: 3-D weather foundation and hazard volumes

**Files:** new `client/scene/weather3d.ts` (+test), `client/ui/sceneToggles.ts` (+test), `client/app.ts`,
`shared/wx.ts` (+test: METAR `elevM` from the API's `elev`, metres).

- `Weather3D` (`show`, `update(aircraft: { lat, lon, altM } | null, nowMs)` called every frame and throttled inside,
  `destroy()`, `onStatus(text)`): around the chased aircraft it keeps METARs (whole-degree box ±2°, refreshed every 5 min
  or when the aircraft leaves the box; `/api/wx/metar`), SIGMETs (10 min; `/api/wx/sigmet`) and RainViewer's newest
  frame (10 min; `RadarSource` from radar.ts, for Tasks 3–4 to sample). Hidden: it asks for nothing and draws nothing.
- Hazard volumes: SIGMETs with a top whose ring passes within 800 km of the aircraft, as polygon entities from
  `base` (null → 0) to `top` metres, `material` the hazard colour (`sigmetColor`) at alpha 0.10, outline at 0.6; and each
  one's name and levels (wxText's `sigmetTitle` / `sigmetLevels`) as a label at the ring's centre at the top height —
  through Task 1's label overlay (give it a way to add labels from other layers: a kind with its own priority above
  cities, a 3-D position, a text and a colour).
- Layers panel (chase): the Weather row shows in the chase too (key W), hint "Clouds, rain and hazard areas around the
  aircraft"; the rain scale and airports legend stay top-down only; the status line comes from `Weather3D` in the chase
  ("Clouds from 3 airports · 2 hazard areas", "Live only" when History or a scenario runs).
- app.ts: `weather3d.show = prefs.wx && chasing && hist === null && run === null`; `update` from the frame loop with
  the chased aircraft's position (as `buildings.update` gets it).
- Dev check aid: `?wxat=<lat>,<lon>` (read once at start, undocumented in the UI) makes Weather3D take its weather from
  around that place, shifted onto the aircraft — the replay's aircraft fly where the sky may be clear. Comment it as
  a check aid. Expose `window.weather3d` like `window.viewer` for console checks.

Tests: show/hide asks nothing while hidden; the box and refresh rules; hazard selection within 800 km and the volume's
heights; the `?wxat` shift; the panel rows/hint per view; slimMetars' `elevM`.

- [ ] Implement; typecheck; touched tests; commit `feat(chase): 3-D weather switch, hazard areas as volumes at their heights`.

---

### Task 3: Clouds from airport reports, ground fog, rain and snow

**Files:** new `client/scene/cloudField.ts` (+test, pure), new `client/scene/groundFog.ts` (+test for its pure maths),
new `client/scene/precip.ts`, `client/scene/weather3d.ts`.

- `cloudField.ts` `metarClouds(m: Metar, seed)` → `CloudSpec[]` (`lon`, `lat`, `heightM` MSL, `scale` [x, y] m,
  `maxSize` [x, y, z] m, `slice`, `brightness`, `tint` 0–1 darkness), deterministic (a seeded PRNG from the station id
  and layer, so a refresh does not reshuffle the sky). Per METAR layer, in a disc of 25 km round the station, base MSL =
  `elevM + baseFt·0.3048`: FEW ≈ 0.02 clouds/km², SCT 0.06, BKN 0.14 (wider, flatter), OVC 0.25 (flat, wide, overlapping
  into a deck); sizes 1–3 km wide, 0.4–1.2 km tall (cumulus) and flatter for BKN/OVC; CB: 2–4 towers 4–9 km tall with
  dark bases, TCU 3–6 towers 2–4 km tall. No layers (CLR/NCD/CAVOK) → none. Cap 120 per station; the nearest first
  when the total passes 700.
- Weather3D draws them with one `CloudCollection` (rebuilt when the METARs change or the aircraft has moved 30 km since
  the last build; nothing beyond 150 km), brightness scaled by the sun (sun.ts `sunElevationDeg`: full by day, ~0.5 at
  dusk, ~0.15 at night).
- `groundFog.ts`: a `PostProcessStage` (depth → world position): fog only in the air below `topM`, the ray's share
  inside the layer giving `1 − exp(−σ·d)`, colour a pale haze by day, dark at night; `σ = 3.912 / visibility_m`. Weather3D
  turns it on near (≤ 40 km) a station reporting visibility under 8 km or FG/BR/HZ/FU/DU (top: FG 300 m, BR 800 m, HZ/FU/DU
  1,500 m above the station), weakening with distance from it; off otherwise (the stage removed or disabled: no pass).
- `precip.ts`: rain streaks or snow flakes around the camera with a `ParticleSystem` (follows the camera each frame,
  falls with gravity, drifts with the surface wind; rain ~1,200–3,000 particles by intensity, snow slower and softer).
  Intensity from the radar under the camera (sample `RadarSource`'s decoded z7 tile, ≥ 15 dBZ) or the nearest station's
  weather within 30 km (`-RA` light, `RA` moderate, `+RA`/`TS` heavy; SN for snow); only while the camera is below the
  cloud base + 300 m (or 3 km above ground when no base is known).

Tests: metarClouds counts by cover, heights from elevation + base, CB/TCU towers, determinism, the caps; the fog
maths (σ from visibility, the in-layer share of a ray); precipitation intensity from dBZ / METAR words.

- [ ] Implement; typecheck; touched tests; commit `feat(chase): clouds from airport reports, ground fog, rain and snow round the camera`.

---

### Task 4: Rain clouds and rain shafts from the radar

**Files:** `client/scene/cloudField.ts` (+test), new `client/scene/rainShafts.ts`, `client/scene/weather3d.ts`.

- Sample the radar frame within 100 km of the aircraft (decoded z7 source tiles via `RadarSource`; 3 × 3-pixel blocks):
  blocks ≥ 30 dBZ become rain clouds — base at the nearest station's ceiling (BKN/OVC/VV) within 60 km, else 1,200 m
  above the ground (an estimate: say so); tops by intensity (30 dBZ ≈ 3 km, 45 ≈ 7 km, 55+ ≈ 10 km); darker grey the
  heavier; 3–6 km wide. Blocks 15–30 dBZ: a flat grey stratiform deck at the base. `radarClouds(cells, base)` in
  cloudField.ts (pure).
- Rain shafts under blocks ≥ 35 dBZ: `rainShafts.ts`, a `BillboardCollection` of vertical streaked-gradient images
  (`sizeInMeters`, aligned to the local up so they turn about the vertical to face the camera), from the base to the
  ground, 2–4 km wide, alpha by intensity; at most 40, the nearest.

Tests: cells from a synthetic decoded tile (thresholds, block sizes), bases and tops, the shafts' selection and cap.

- [ ] Implement; typecheck; touched tests; commit `feat(chase): rain clouds and rain shafts where the radar shows rain`.

---

### Task 5: Model clouds and winds aloft (Open-Meteo)

**Files:** `server/wx.ts` (+test), `shared/wx.ts` (+test), `client/scene/cloudField.ts` (+test),
`client/scene/weather3d.ts`, `client/scene/flightFrame.ts` (`liveFlightData`), `client/app.ts`, `README.md`.

- Server `GET /api/wx/model?lat&lon`: snaps to a 0.5° cell, asks Open-Meteo (https://api.open-meteo.com/v1/forecast,
  keyless; CC BY 4.0, attribution "Weather data by Open-Meteo.com") for a 7 × 7 grid at 0.25° spacing round the cell's
  centre, the current hour: `cloud_cover_<p>hPa` and `geopotential_height_<p>hPa` for p in 1000, 925, 850, 700, 600, 500,
  400, 300, 250, 200, and `wind_speed_<p>hPa` / `wind_direction_<p>hPa` (kn) for 850, 700, 500, 300, 250, 200;
  multi-point request (comma-separated latitude/longitude lists answer an array); cached 30 min per cell; slimmed
  (`slimModel` in shared/wx.ts) to compact arrays; a failing upstream serves the last good answer (as `cached` in
  server/wx.ts).
- Client: Weather3D fetches the grid when the aircraft leaves the inner half of the last grid or after 30 min;
  `modelClouds(grid, metarsNear)` → clouds per grid cell and level with cover ≥ 20 % (density by cover): low levels
  (≥ 850 hPa) skipped within 40 km of a station that reports layers (observations win); mid levels flatter altocumulus;
  high levels (≤ 300 hPa) thin, flat, faint cirrus-like puffs. Joins the same `CloudCollection` within the 700 cap
  (observed first).
- Winds: `modelWindAt(grid, lat, lon, altFt)` (pressure altitude → hPa by the standard atmosphere, interpolated between
  levels, nearest grid point) → the flight-data frame's wind when the aircraft sends none (`liveFlightData` takes an
  optional fallback; it is an estimate, drawn dim as the frame's estimates are). Live chase only.
- README: the data source and its attribution.

Tests: the request URL, slimming, the cache and stale fallback; modelClouds (levels, cover threshold, METAR
precedence); modelWindAt interpolation.

- [ ] Implement; typecheck; touched tests; commit `feat(chase): model clouds everywhere else and winds aloft (Open-Meteo)`.

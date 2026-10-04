# FlightHopper — Handoff

**Updated:** 2026-09-29 morning (the chase HUD suite: proportional cards, layout edit mode, the chased aircraft's
bracket, a clicked aircraft's full card, a Settings dialog for API keys), after 2026-09-29 (the Air Astana 1388 scenario
and the E190 model) and 2026-09-28 late (tape polish, moonlit
runways, threshold markers, the KZR livery). Earlier on 2026-09-28: flight physics, glass-cockpit instruments, aircraft lights, flat runways in the terrain,
painted runways, landing gear. The previous handoff (UI revamp, live data on adsb.fi, polling, URL state, data-source
options) is `git show 0737372:.planning/HANDOFF.md`; older ones are linked from it.

## Where things stand

- **Buttons rearranged on local `main` (2026-09-30, not pushed).** rail.ts items take `spot: 'under' | 'corner' |
  'left' | 'bottom'` (was `corner`/`under` booleans). Scenarios is a square at the top left (its panel opens beside it,
  `.fh-panel-left`; the flight card moved right by `--fh-spot`), the instrument layout a square at the bottom centre
  (chase only; over the play bar's left end in a scenario), Settings joined full screen in the bottom-right corner. On
  phones every button is a tab in the one bottom strip (rail.ts `arrange`, item order; it scrolls sideways), no squares.
- **Night: loading ground stays dark (local `main`, 2026-09-30).** Lamp tiles still loading used to be stood in for by
  much coarser ones: a pale wash with glowing roads over km (worst from the street map into the chase). `lampsWait`
  (nightLights.ts, an endUpdate wrap like imageryFade's) drops the lamps from a tile whose stand-in is > 2 levels
  coarser, or a tile shallower than 12 past 4× the SSE. Open: why some areas load slowly at all (user: a separate issue).
- **Map layers on local `main` (2026-09-30, not pushed).** The Scene panel left the rail: it is "Layers", a panel
  button in a glass square of its own under the rail (rail.ts `under` items; on phones at the top right, the corner
  buttons below it). Map: Map | Satellite for the view on screen (M; `mapTop` default map, `mapChase` default
  satellite), Roads & places over the satellite (R; Esri's keyless World_Transportation + World_Boundaries_and_Places
  overlays), Weather (W) on the top-down map only: RainViewer radar (z ≤ 7), METAR dots in flight-rules colours with
  wind barbs (hover or tap for the METAR), SIGMET areas (hover for the text) — `client/scene/weather.ts`, served by
  `/api/wx/metar?bbox=` and `/api/wx/sigmet` (`server/wx.ts`: aviationweather.gov has no CORS; cached 5/10 min).
  Then the 3-D scene switches (T, L, X). All seven prefs persist (URL > localStorage > defaults). **Deferred (user):**
  real 3-D weather in the chase (cloud types and heights drawn as clouds). `npm run check` 1255/1255.
- **Corner buttons and a Controls panel on local `main` as `b32d62b` (2026-09-30, not pushed).** The instrument-layout
  and full-screen buttons left the rail: each is a button of its own in a glass square at the bottom right (on phones
  the top right; rail.ts `corner` items). "Controls and credits" is now "Controls" (map, 3-D chase, keys, scenario;
  touch gestures on touch screens), and every credit line is gone at the user's request, with the code that fed them.
- **Trackpad gestures on local `main` as `d99bb4d` (2026-09-29, not pushed).** A pinch zooms (Chromium sends it as
  ctrl + wheel, which Cesium dropped) and two fingers moving pan the top-down map, where they used to zoom; in the chase
  two fingers only zoom (`OrbitControl.trackpad`; the user tried orbiting and rejected it: a pinch's drifting fingers
  turned the view). A mouse wheel's notches still zoom through Cesium (`client/scene/trackpad.ts`, `browseDrag`,
  `browsePinch`). Open: a Windows/Linux wheel notch (±100 px) reads as a scroll and pans; Safari's pinch (gesture events)
  and a two-finger touch drag are not handled. `npm run check` 1250/1250.
- **Livery pipeline merged into local `main` as `fa013e8` (2026-09-29, not pushed).** Airline liveries are designs drawn
  with a kit (`client/livery/`) onto each model's measured side profile and projected by the paint shader; guide in
  `docs/liveries.md`, design in `.planning/livery-pipeline-design.md`, dossiers in `.planning/liveries/`. New models
  `a20n`, `a21n`, `b38m` (recipes in `tools/models/variants.json`). Designs: El Al (schemes A1/A2/B by registration),
  Wizz Air, Israir, flydubai, Royal Jordanian. Reference photos are in `data/livery-refs/` (git-ignored, 124 MB). To add
  an airline: `tools/liveries/livery.workflow.js` (docs Part 5). `npm run check` 1241/1241.
- **`main` is this handoff's commit; everything is merged into it** (2026-09-29, at the user's request): every branch
  (`feat/flight-physics`, `worktree-kc1388-airspeed`, `build/mvp`, `feat/traffic-id`) has no commit outside `main`, and
  the main checkout has no uncommitted work. The voice-over/playbar work that sat uncommitted since 2026-09-23 is
  `42a01d9`; `feat/traffic-id` (traffic flight IDs, distances, a popup with Chase) is merged as `94988fe`.
  The HUD suite is merged as `f4b8412` (below). `npm run check`: `tsc` clean, 1207/1207. `vite build` works (the usual
  chunk-size warning only).
- **Worktrees:** none besides the main checkout (`git worktree list`). Work in a sibling `../FlightHopper-<name>` worktree
  (never under `.claude/`) and merge into `main`.
- **Pushed:** `origin/main` is `3d64639`; the wind-card fix `9e356e5`, the HUD-suite merge `f4b8412` and this handoff
  are local. A push needs the user's OK.

### What the morning of 2026-09-29 added: the chase HUD suite (merged `f4b8412`, all on `main`)

Built by subagents in worktrees, each feature judged by an independent critic from headless-Chrome screenshots over
three rounds until it passed.

| What | Where |
|---|---|
| **Proportional cards at every zoom.** The four HUD cards go round a layout square clamped between a minimum (the larger of 0.42 × the view's shorter side and the aircraft's own square at the default range) and the largest square the default arrangement fits, so zoomed out they keep the default distances and zoomed in they stay, over the aircraft. Short room (a photo card at 1024 px, an open panel) takes compact cards or another side instead of shrinking the square. Transient overlays (scenario captions, a traffic card) never move the cards: captions keep a fixed two-line band. The chase camera orbits the aircraft's middle (it aimed at the wheels, so the aircraft drifted on screen when zooming), and the default range on tall screens is 150 m × height/width. Figures (V/S, AGL, TAS, GS) have fixed widths. | `client/scene/flightFrame.ts` (`frameLayout`, layout side), `client/scene/chaseCamera.ts` (`b0b32a0`) |
| **Layout edit mode.** A rail button (chase only; disabled while no cards are drawn): drag cards (mouse/touch; the camera stays still), hide/show each (ghosted while editing), Reset to defaults, Done/Esc. Moving one card pins the others where they are; the last moved card stays on top. Offsets are in layout-side units, so a custom layout keeps its proportions when zooming. Saved per browser (`fh.hudLayout.v1`). | `client/ui/framePrefs.ts`, `client/scene/flightFrame.ts`, `client/ui/flightFrame.css` |
| **The chased aircraft's brackets** in the traffic's style, with its callsign (no distance); traffic labels keep 6 px clear of it. The bracket uses Cesium's drawn model scale (far models are drawn larger than true). | `client/ui/layout.css`, `client/ui/theme.css`, `client/scene/traffic.ts` |
| **A clicked traffic aircraft gets the chased aircraft's card** (photo with credit or the no-photo icon, stats, status, details, "N m from <chased>", Chase, close) at the first free place (top-right, bottom-right, or the chased card's slot); its bracket is highlighted above the HUD. On phones in chase both cards show a 72×48 photo thumbnail. Esc steps back: panel → traffic card → edit mode → scenario/chase. | `client/ui/flightCard.ts/.css`, `client/scene/traffic.ts`, `client/app.ts` |
| **Settings dialog (gear, bottom of the rail):** the ArcGIS key and the Cesium ion token, masked with show/hide, checked with their own provider (key in a header) on Save, saved in the browser, overriding `.env.local` after a reload; a key that fails at runtime falls back to Re:Earth terrain / EOX imagery and its status says so. The phone tab bar scrolls sideways with snap when its tabs don't fit. | `client/ui/settings.ts/.css`, `client/config.ts` (stored > env > keyless), `client/scene/{terrain,imagery,viewer}.ts`, `client/main.ts` |

Known limits: at 390×844 an open traffic card covers the bottom 16 px of the attitude card; a card dragged into the
flight card's area stops there (cards keep clear of covers); dragging has no keyboard alternative; Esri tile URLs and
ion requests carry their keys (the providers' design); the photo service refuses headless Chrome (403), so photos were
checked with stubs; three or four real Escape presses in browse mode freeze *headless* Chrome, on the old `main` too
(in-page key events are fine) — worth one look in a real browser.

### What 2026-09-29 added (all on `main`)

| What | Where |
|---|---|
| **Air Astana 1388** (11 Nov 2018, ERJ-190LR P4-KCJ, Alverca → Beja, 13:29:30–15:28 UTC), the second scenario. Track (every row q=R): the multilateration fixes 13:34–15:04 on their own time stamps (the recorder's clock; the first build re-timed them and made the aircraft dive while slowing, fixed 2026-09-29), fused with Figure 13's altitude and airspeed by `tools/scenarios/fuse.ts` (energy, wind triangle, nine spirals re-flown); the take-off at the report's times; the three Beja approaches traced from the report's Figure 3 and timed by the altitude-only record (go-arounds 15:08:00, 15:18:40; touchdown 15:26:50 on 19L), with a flare; attitude from the app's flight-mechanics model; IAS and g digitised from the report's DVDR plot (Figure 13). No transcript is published: 20 story messages quote the report (checked line by line against its pages). Closing card; crew by role (the report names nobody). | `public/scenarios/kc1388/`, build scripts and README `tools/scenarios/kc1388/`; inputs (report PDF, multilateration CSVs, OSM/SRTM JSON) in the main checkout's git-excluded `.work/kc1388/sources/` |
| E175 gear on Embraer's APM-2259 (wheelbase 11.40 m, track 5.20 m, H38x13-18 mains; it had the E190's 5.94 m track). | `tools/models/gear-glb.ts`, `public/models/e75l-gear.glb` |
| A package's `airport.json` may list several airfields (KC1388: Alverca and Beja, runway ends from OpenStreetMap, SRTM elevations); documented in `docs/scenarios.md` §1.11a. | `client/app.ts` |
| **E190 model** (built by a helper agent with the documented livetaiwan pipeline; the same commands rebuild `e75l.glb` byte for byte): manifest `e190` (E19*, E29* move off `e75l`), paint map, lights, gear from Embraer's APM-1901 (wheelbase 13.83 m, track 5.94 m; fitted 0.38 m forward like e75l's). Renders: `.planning/reports/e190-model/`. | `public/models/e190{,-gear}.glb`, `tools/models/gear-glb.ts`, `third_party/aircraft-models/` |

Checked on screen (headless Chrome; the pane was hidden): KC1388's take-off roll on Alverca 04 (E190, Air Astana livery, gear), gear retracting after lift-off, the 13:39 upset (IAS 261, GS 210, 2.5 g), the flare and roll-out on Beja 19L, the closing card, the Scenarios panel; JAL 123 still paints 1985 Haneda.

### What the late session of 2026-09-28 added (all on `main`)

| What | Where |
|---|---|
| Rolling digits: the altitude readout's last two digits on a drum in 20 ft steps, the speed's last digit; a speed-trend arrow (green, along the ticks, index → the speed 10 s ahead; shows from 2 kt, hides below 1 kt). The trend runs on the data's clock: a scenario's pause holds it, a seek restarts it, 4× play does not stretch it. | `client/scene/instrumentMath.ts` (`drum`, `drumLabels`, `drumShift`, `Trend`, `trendShown`), `client/ui/instruments.ts` (`Tape`), `FlightFrame.update(…, dataT)` |
| Runways at night: moonlit like the ground. They took their light from the Sun's elevation alone while the globe also gets the Moon, so two days past full moon LLBG 21 was a black wedge. `Sun.update` now reports the light it set (`SunState.intensity`, `dayBrightness`, the Moon's included); runways and a scenario airfield use it. | `client/scene/sun.ts`, `client/app.ts` |
| Threshold markers (the yellow dots + idents, user asked what they are) show from 3 to 30 km: up close the paint shows the designators itself. | `client/scene/runways.ts` `MARKER_RANGE` |
| Air Astana (KZR) livery: white, midnight-blue fin `#253168` (brand; a May 2018 Commons photo of P4-KCJ agrees), light engines. Colours only: the logo is not free-licensed. | `client/scene/liveries.json` |

Checked on screen (Browser pane, visible while the user was at the desk): the painted, flattened hero runways at KSFO 28L
(live, day and night), LLBG 21 (live, night: the bug above) and LOWI 26 (the synthetic replay
`data/recordings/synthetic-lowi.jsonl`, launch config `physics-lowi-api`, REPLAY_SPEED=4). JAL 123's 1985 imagery at the
default chase range looks soft, not smeared; the smear at ~20 m camera height is the GSI photos' own ~1 m/px (max z17), and
no app setting sharpens it: left as a known limit.

### What 2026-09-28 added (all on `main`)

| Area | What | Where |
|---|---|---|
| Motion | Kalman + RTS smoother per axis (white-jerk model; velocity reports lag positions by 0.75 s, measured), outlier gating, physical limits; quintic path between smoothed knots; flight-mechanics attitude (pitch = path angle + angle of attack from the lift equation, coordinated-turn bank, crab); traffic within 12 nm runs the same tracks. Final-approach pitch −1.0° → +3.0°, speed-change p99 35 → 2.4 kt/s (Heathrow capture). | `client/track/{smoother,attitude,track,registry}.ts`, design + results `.planning/flight-physics-design.md`, real-data test `client/track/realdata.test.ts` |
| First seconds of a track | A velocity report is judged only against positions spanning ≥ 3 s; mis-stamped ADS-B positions are dropped by consensus (`positionOutliers`); MLAT velocity reports count (σ 5 m/s); MLAT readouts lag 2 s. No more 0 kt or 784 kt starts. | `client/track/{track,mlat}.ts` |
| Instruments | Glass-cockpit blocks round the chased aircraft, never over it: altitude + V/S tapes, airspeed/GS tape, heading tape + wind, attitude indicator with bank scale, load/gear/flaps/thrust gauges. Live: ALT is the smoothed height, IAS the track's average, HDG the drawn nose, GEAR DN once the gear locks. | `client/scene/{flightFrame,instrumentMath}.ts`, `client/ui/{instruments.ts,flightFrame.css}`, harness `harness/flight-frame.*` |
| Lights | Nav lights in their sectors, alternating beacons, double strobes, landing/taxi lights below 10,000 ft, lit fin, cabin window row, glossier paint; the chased model's lamps light its skin. ~0.1 ms/frame at 113 glows. | `client/scene/aircraftLights.ts`, `client/scene/livery.ts`, anchors `tools/models/light-anchors.ts` → manifest `lights` |
| Flat runways | `FlatTerrainProvider` wraps the terrain source and lays the ground flat along every known runway (plane through the threshold heights, 100 m either side, 120 m blend) and over a scenario airfield's outline. The DEM is today's ground and in places a surface model: 1985 Haneda 15L sat on 13.5 m of modern relief. | `client/scene/flatTerrain.ts`; a scenario package may add `airport.json` (the `Airport` shape + `flat` rings), e.g. `public/scenarios/jal123/airport.json` |
| Painted runways | Each runway a strip of quads every 100 m (follows the Earth's curvature), texture coordinates in metres, procedural ICAO markings (threshold stripes, designator glyph atlas, centre line, touchdown zone, aiming point, side stripes, asphalt, rubber). Hero airports and a scenario's airfield (no threshold dots there). | `client/scene/{runwayPaint,runways}.ts` |
| Landing gear | The type models had none (they sat on their engines). Generated per type from published layouts, one node per leg hinged at its top; models stand on their wheels (`gearHeightM` = the gear's). Down on the ground and on the approach (< 2,000 ft AGL, descending, < 230 kt), up after lift-off (> 400 fpm), 12 s down / 9 s up; chased aircraft, traffic and scenario events. | `tools/models/gear-glb.ts` (`GEAR` specs; `node tools/models/gear-glb.ts --write` regenerates GLBs + manifest), `client/scene/gear.ts`, `ChaseModel.setGear/snapGear`, `Traffic` slots |

JAL 123's "hilly take-off strip" (user report) had two causes: the modern DEM under the 1985 runway, and the scenario's
GSI 1984–86 photos (max zoom 17, ~1 m/px, 6 KB tiles) smearing into ramps at the chase camera's 20 m. Terrain
exaggeration, screen-space error, anisotropy and the imagery fade were each ruled out by test. Fixed by the flat
airfield and the painted 1985 runways (15L/33R from the DFDR take-off roll, 04/22 and the island outline traced from the
same photos).

## Next

1. **Air Astana 1388 (`public/scenarios/kc1388/`, 2026-09-29):** done; see "What 2026-09-29 added". Known limits, all
   said in the package: the attitude is what the path requires (the real aircraft rolled far more; the recorded
   attitude is not published); the Beja approaches are traced from a perspective figure (to within a few km); the
   take-off path before the first multilateration fix is the smoothest one that keeps the report's times. Better data would come
   only from GPIAAF or Embraer (the DVDR values). Crew names are not in the report and are left out.
2. **Optional:** runway and approach lights at night (the painted runways are unlit; real ones glow); the Air Astana title
   decal only if a public-domain wordmark turns up.

## How to check things on screen

The Browser pane does not render while the user is away (hidden tab). Use headless Chrome over CDP, frame-capped:
`--headless=new --remote-debugging-port=0 --user-data-dir=<own profile>` and read the port from
`<profile>/DevToolsActivePort` (other sessions' Chromes hold fixed ports), or the repo's gate driver with `CDP_PORT=<free>`.
Launch configs in the main checkout's `.claude/launch.json` (git-excluded): `physics-replay-api` (8796, replays the
Heathrow capture `data/recordings/egll-arrivals-2026-09-28.jsonl` once — restart the API to replay) with
`physics-replay-client` (5184), and `physics-live-*` (8797/5185, adsb.fi). Useful URLs: `?hex=3c65cf&chase=1&cam=-95,-4,48`
(an A320 on final at Heathrow early in the replay), `&sun=2026-09-28T20:30:00Z` (night), `?scenario=jal123&t=65475`
(t = seconds of the scenario's local day: 18:11:15). Pass `topo=1&light=1` explicitly: the app stores the toggles, so a
profile that once had `?topo=0` stays flat.

## Rules

- **adsb.lol:** one poller at a time (429s above ~0.04 req/s). `make` is live on adsb.fi at 0.9 req/s; mind its terms.
- **Tests never touch the network.** `npm run check` — and read its exit code: `npm run check | grep …` hides a failure.
- **Keep the machine's load low:** no uncapped GPU benchmarks, no parallel full suites, stop every server and Chrome
  you start. Timing tests can flake under load (table sort, `/api/view` at 5,000 aircraft); re-run them alone.
- **Git:** the repo-local identity, `git add` explicit paths only, never commit other
  sessions' files, messages end with the `Co-Authored-By` line.
- **Downloads that a task the user asked for needs are approved** (the user, emphatically, 2026-09-28: "i did like 10
  times do it already"): fetch them, then say what (file, source, size). Ask first only for out-of-scope, very large,
  paid or doubtful files (leaked audio, unclear licences). Airline logos only if free-licensed (public domain); else
  colours. Scenario captions only from the official record.
- **Decisions in `terrain-sun-design.md` stand:** no cast shadows; night keeps the mountains faintly visible; lighting in
  chase only; replays lit at their recorded time.

## Gotchas learned 2026-09-28

- The multilateration CSVs: keep their own time stamps (the altitudes match the flight recorder's to ~2 s). The spread of the
  speeds consecutive fixes imply (108–381 kt around a flown ~250) is ~250 m of MLAT position noise, not clock error:
  re-timing by distance at the airspeed (the first KC1388 build) moved the dives 25 s against the airspeed, so the
  aircraft fell while slowing (fixed 2026-09-29, `tools/scenarios/fuse.ts`). The speed/direction columns repeat stale
  values. Its altitude-only CSV uses bare CR line ends.
- The ASN report mirror answers 403 to curl's default agent (a browser User-Agent works); Planespotters answers tools
  with a bot check (Commons photo pages work). OpenStreetMap's Overpass API gives runway ends as small JSON.
- A report figure in a PDF is a raster: `pdfimages` gives its native pixels (rendering the page at 400 dpi adds none).

- Anything that lights itself (runways, airfield) must take the light as the Sun set it (`SunState`), not recompute
  `sunLook(elevation)`: the Moon (up to 1.7 intensity) is applied on top, only inside `Sun.update`.
- A replay at `REPLAY_SPEED` > 1 moves positions faster: speeds read × that factor (GS 615 kt at 4×).
- Planespotters answers tools with a bot check; Commons photo pages and `upload.wikimedia.org` thumbnails work, and a
  canvas can sample their pixels (same origin when the image is the page).
- The readout drum's cell is `DRUM_CELL_EM` (instruments.ts, set inline): moving it by whole em instead of cells was a
  cell off.

- Cesium puts a `BlendOption.TRANSLUCENT` BillboardCollection in the **opaque** pass with depth writes: a glow drawn before
  an aircraft punches a hole in it. Glows use `OPAQUE_AND_TRANSLUCENT`.
- `Primitive` compresses texture coordinates into two 12-bit fractions of 1 by default: set `compressVertices: false` for
  `st` in metres (runways).
- In page scripts, `import('/node_modules/.vite/deps/cesium.js')` without Vite's `?v=` hash is a second Cesium instance
  (its `ContextLimits` are zero): reach Cesium through the app's objects (`window.viewer`, constructors of live objects).
- Geared models' `gearHeightM` is the gear's height (wheels down); a new type model needs a `GEAR` spec, then
  `node tools/models/gear-glb.ts --write` (a high wing's legs mount inboard on its fairings automatically).
- A new scenario airfield is data only: `public/scenarios/<id>/airport.json` (runway ends with `thrHaeM` = MSL + EGM96
  geoid, `flat` rings); `app.ts` loads it with the package, flattens the terrain and paints its runways while it plays.

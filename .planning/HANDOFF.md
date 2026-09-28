# FlightHopper — Handoff

**Updated:** 2026-09-28 (flight physics, glass-cockpit instruments, aircraft lights, flat runways in the terrain, painted
runways, landing gear). The previous handoff (UI revamp, live data on adsb.fi, polling, URL state, data-source options)
is `git show 0737372:.planning/HANDOFF.md`; older ones are linked from it.

## Where things stand

- **`main` is `c9c3e32`.** `npm run check`: `tsc` clean, 1112/1112 (1114 in the main checkout with the uncommitted work
  below). `vite build` works (the usual chunk-size warning only).
- **Uncommitted in the main checkout, not ours:** another session's voice-over/playbar work (`client/scenario/{format,run,
  types}.ts` and tests, `client/ui/{icons,info,playbar}.*`, `public/scenarios/jal123/scenario.json`, untracked
  `tools/scenarios/voiceover.py`, `tools/scenarios/jal123/voices.json`). Leave it alone. Work in a worktree
  (`../FlightHopper-physics` on `feat/flight-physics` = `main` now) and fast-forward `main`: git refuses a merge that would
  touch those files, and none of ours does.
- **Not pushed:** `origin/main` is `b9e0f1f`; the 39 commits since (liveries `ed2b0b0` onward, the JAL 123 scenario,
  2026-09-28) are local. Ask before pushing.

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

1. **Air Astana 1388 scenario — blocked on the user's permission to download** (asked, not yet answered):
   - `E190.glb`, 3.5 MB, GPL-2.0: `https://github.com/Ysurac/FlightAirMap-3dmodels/blob/0906d9ba1bdd906ce45807e45ed706c09912db19/e190/glTF2/E190.glb`
     (same source and licence as `e75l.glb`; keep the upstream file in `third_party/aircraft-models/source/flightairmap-glb/`,
     update that README and `licences.json`).
   - The GPIAAF final report (process 08/ACCID/2018), 6.3 MB PDF, via the ASN mirror
     `https://asn.flightsafety.org/reports/2018/20181111_E190_P4-KCJ.pdf` (gpiaaf.gov.pt answers 403 to tools; in the
     Browser pane a PDF turns into a save dialog on the user's screen — do not open PDF links there).
   - FR24's MLAT track `KC1388_1e84fc24.csv` (29 KB) and `KC1388-Altitude-Only-Data.csv` (71 KB) from the FR24 blog post,
     as a reference only: FR24's terms, not committed.
   - **Then:** manifest entry + a `GEAR` spec for the E190 (animated gear, as asked); Air Astana livery (colours; a logo only
     if public domain, per the liveries rule); a package like JAL 123 (`docs/scenarios.md`): track, events, transcript and
     captions **only from the official record**; `airport.json` for Alverca (LPAR) and Beja (LPBJ, landed on 19L meaning 19R).
   - **Facts so far (Wikipedia, SKYbrary, AvHerald, FR24):** 11 Nov 2018, KC1388/KZR1388, ERJ-190LR P4-KCJ (MSN 19000653),
     ferry Alverca → Minsk → Almaty after a C-check at OGMA; the aileron cables were installed reversed in both wings
     (SB 190-57-0038 work). Take-off 13:31 UTC in IMC; control repeatedly lost; direct mode regained partial control; two
     Portuguese F-16s from Monte Real escorted; ditching considered; three approaches at Beja, landed almost two hours
     after take-off; 3 crew (Capt Vyacheslav Aushev, FO Bauyrzhan Karasholakov, relief FO Sergey Sokolov) + 3 engineers,
     one minor injury; hull loss. FR24 tracked it by MLAT only (gaps), with altitudes for the three approaches.
2. **Optional polish:** a speed-trend arrow and rolling digits on the tapes; a live look at the painted and flattened hero
   runways (KSFO, LLBG, LOWI: only JAL 123's airfield was checked on screen); the era imagery's blur off the runway in
   scenario close-ups.

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
- **Git:** identity `rg1989 <roman.grinevic@gmail.com>` (repo-local), `git add` explicit paths only, never commit other
  sessions' files, messages end with the `Co-Authored-By` line.
- **Downloads need the user's explicit yes** (file, source, size). Airline logos only if free-licensed (public domain);
  else colours. Scenario captions only from the official record.
- **Decisions in `terrain-sun-design.md` stand:** no cast shadows; night keeps the mountains faintly visible; lighting in
  chase only; replays lit at their recorded time.

## Gotchas learned 2026-09-28

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

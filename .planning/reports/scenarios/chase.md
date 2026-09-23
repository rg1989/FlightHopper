## Chase-mode discovery: driving the chased aircraft from a scripted pose source

### 1. Per-frame render loop

**Where it runs:** `frame()` is registered with `viewer.scene.preUpdate.addEventListener(frame)` (app.ts:632). It runs after Cesium applies mouse input and before it renders (app.ts:255-258). `stop()` removes it (app.ts:790).

**Order inside `frame()`** (app.ts:536-631):
1. `tf = topo.update(now)` gives the `TerrainFrame {fSampled, fNow, relHM}` (app.ts:538, types.ts:105-109).
2. `dtS` is the wall-clock frame delta, clamped to 1 s (app.ts:539).
3. This step runs only when `api.ready`, meaning at least one HTTP reply has arrived (api.ts:43-45):
   - `tServerMs = api.serverNowMs()`
   - `tRenderMs = clock.tick(tServerMs, delayTargetS(), dtS)`. This is the `RenderClock` (delay.ts:55-60).
   - `all = fleet.entries(...)`
   - `s = registry.get(selected)?.stateAt(tRenderMs)`. If render time is before the first sample, it holds the oldest sample (app.ts:545-562).
4. `fleetLayer`, `traffic.select` and `table.update` are fed from `all` (app.ts:563-574).
5. Chased placement, when `s !== null && chasing` (app.ts:583-605):
   - `globe.getHeight` → `groundM = topo.ground(sampled, tf, acGround, carto)`
   - `placed = {...s, hM: placedHeightM(s.hM, s.onGround, groundM)}`
   - model pick and paint → `model.update(placed)` → `chaseCam.update(placed, dtS)` → `traffic.update(...)`
   - `chased = placed`, and `sunWC` is set at the aircraft.
6. `sun.update(sunTimeMs(tSunMs, sunParam, status.upstreamOffsetMs ?? 0), sunWC)` (app.ts:608). Then buildings and runways (app.ts:609-614), `model.show = chasing && s !== null` (app.ts:616), and finally the card, banner, status, pending layer, `syncUrl` and bench (app.ts:620-630).

**Data shape:** `RenderState` (types.ts:6-25) has these fields: `hex, lat, lon, hM` (WGS84 ellipsoidal metres of the **wheels**), `headingDeg` (true), `pitchDeg` (nose-up +), `rollDeg` (right-wing-down +), `gsKt, trackDeg, altBaroFt, vsFpm, mode ('interp'|'extrap'|'stale'), altSource, onGround, ageS, quality, callsign, typeCode`.

**Model:** `ChaseModel.update(state)` (model.ts:225-229) calls `modelMatrixFor` (model.ts:125-129).
- Position is `fromDegrees(lon, lat, hM + gearHeightM)`.
- Attitude is `hprFor` = state attitude + `forwardAxisFix` (model.ts:107-113), with no sign flips.
- There is **no smoothing** in the model, so pitch and roll are drawn exactly as given.
- The model loads with `enableVerticalExaggeration: false` (model.ts:253-255), so it always keeps its true height.

**Camera:** `ChaseCamera.update(state, dtS)` (chaseCamera.ts:118-136).
- It uses only the aircraft's heading. That heading is smoothed with τ = 1 s (chaseCamera.ts:181-186), then the orbit offset is added.
- It places the camera with `lookAtTransform` on the ENU frame at (lat, lon, hM) (chaseCamera.ts:189-199).
- It keeps the camera at least 15 m above the ground through `groundAt`, which is wired to `topo.ground` (app.ts:407; chaseCamera.ts:114, 126-134).

**Where attitude comes from today:** it is synthesised inside `Track.stateAt` by `targetAttitude` + `AttitudeSmoother` (track.ts:145-157), not in the model or the camera.

### 2. Narrowest seam for a synthetic pose source

**The seam is the block that computes `s`** (app.ts:542-562). Everything from app.ts:563 down reads only `s`, `all`, `chasing`, `selected`, `tSunMs` and `dtS`. Suggested shape:

```ts
interface PoseSource { readonly t0UtcMs: number; readonly durationS: number; stateAt(tS: number): RenderState } // pure in tS
// frame():
if (scenario) { const tS = scenario.clock.advance(dtS); s = scenario.poses.stateAt(tS); tSunMs = scenario.poses.t0UtcMs + tS * 1000 } // all stays NO_ENTRIES
else if (api.ready) { /* existing */ }
```

**Bypass these:**
- The poll loop and `poll()` (app.ts:655-734).
- `RenderClock`, which runs at 0.8–1.2× real time and never steps (delay.ts:37-60; app.ts:411, 547), and `delayTargetS` (app.ts:423-424).
- `Fleet`.
- `TrackRegistry`/`Track` (registry.ts; track.ts). `Track` keeps state and cannot be scrubbed:
  - it resets its attitude smoother whenever time runs backwards (track.ts:137-139);
  - it runs rejoin blends (track.ts:322-342);
  - it keeps only a 120 s window (track.ts:17);
  - it marks the pose `stale` 8 s past the newest sample (track.ts:19).
- `select()`'s registry reseed (app.ts:480-490) does no harm but is not needed.

**What `stateAt` must return:**
- `mode: 'interp'` and `ageS: 0`. Otherwise the card shows "Signal lost" (format.ts:36-38).
- `onGround: true` for the take-off roll rows (the CSV's `alt_ft` is 0 at 18:12:00–18:12:15).
- `hM = alt_ft·0.3048 + geoidN(lat, lon)`. `hM` is ellipsoidal (HAE), not MSL (shared/geoid.ts:4; `Sample.nM` is computed the same way at shared/sample.ts:54).
- Pitch and roll straight from the dossier columns.

**Code you can reuse for interpolation:**
- `hermite(a, b, t)` on `KinPoint` in a local `Enu` frame (track/hermite.ts:17; track/types.ts:2-8; shared/enu.ts), exactly as `Track` does.
- Wrap-aware heading interpolation follows the pattern at track.ts:297-298.
- The vertical Hermite is private to its module (vertical.ts:130).
- The CSV has one row every 15 s. Plain interpolation between rows will smooth out oscillations shorter than about 30 s, so the source has to synthesise them.

**Reuse as-is:**
- `placedHeightM` + `topo.ground` + the `acGround` memo (app.ts:164-167, 588-596; topography.ts:160-176).
- `relatch` (app.ts:584-587).
- `ChaseModel.update`/`modelMatrixFor`, with pitch and roll.
- `ChaseCamera` with its orbit and clearance.
- Exaggeration: the model stays at true height while the ground is drawn at `tf.fNow`.
- `Sun`, and `buildings.update(chased, tf)` (app.ts:611).

**Caveats:**
- **Model and livery come from `AircraftInfo`, not from `RenderState`:** `ci = chaseInfo ?? fleet.get(selected)?.info` (app.ts:597-599).
  - Set `chaseInfo` to a synthetic `AircraftInfo` (shared/info.ts:8-18) with a `B74…` type code. `ModelPicker.for` matches the `B74*` prefix and picks `b744` (modelFor.ts:36-45; public/models/manifest.json:182-189).
  - `paint()` takes a **livery code**, not a callsign (model.ts:216-222). `liveries.json` has no JAL entry, so a 1985 JAL code must be added and passed directly.
- **Scrub jumps swing the camera** for about 1 s because of the heading smoothing. `release()` would snap the heading, but it also resets the orbit heading offset and the mouse input (chaseCamera.ts:139-146). A small `snapHeading()` that sets `#headingDeg = null` is the clean fix.

### 3. Hiding other aircraft and stopping network polling

- **Polling:** the only traffic fetches are `api.view` and `api.chase`, both from `poll()` (api.ts:27-35; app.ts:664). Gate the loop at app.ts:727 with something like `if (document.hidden || scenario)`.
  - This is required, not optional. While chasing, `poll()` asks `/chase?hex=` every second (app.ts:662-664), which makes the server chase that hex upstream (`StatusReport.chasedHexes`, shared/api.ts:54). A fake hex would spend upstream budget.
  - The view poll centred on the chased position (app.ts:648) would also load live traffic around Tokyo.
- **3-D traffic:** `traffic.select(NO_ENTRIES, hex, null)` frees every slot (`model.show = false`) and hides the brackets (traffic.ts:160-188, 172, 257-262).
- **Fleet icons:** `fleetLayer.update(NO_ENTRIES, …)` hides every billboard, the halo and the label in its sweep (fleetLayer.ts:193-201, 235-243). Clicks then find nothing (app.ts:740-747).
- **Street map:** already hidden in chase (`map.show = false`, app.ts:443, 512; mapLayer.ts:36-41).
- **Pending veils:** hidden in chase through `!chasing` (app.ts:627).
- **List:** `table.update(NO_ENTRIES, [], null, false)` (app.ts:570) and a `null` badge (app.ts:571-574). Hide the rail's `aircraft`/`status` entries (app.ts:347-362; `rail.button(id)`, rail.ts:25).
- **Still loads, as intended:** terrain, imagery, OpenFreeMap buildings and night lights.

### 4. Scene "now"

- **Cesium's clock never runs on its own.** `Sun` sets `viewer.clock.shouldAnimate = false` (sun.ts:221) and writes `clock.currentTime = JulianDate.fromDate(tSunMs)` every frame (sun.ts:261-263). The sun direction, moon (moon.ts:16), IBL and night-lights alpha all come from that time (sun.ts:265-297). So the scene's "now" is simply the `tSunMs` passed to `Sun.update`.
- **How `tSunMs` is set today:** `Date.now()` until `api.ready`, then `tRenderMs` on the server clock (app.ts:544-548). Then `sunTimeMs` applies `p.fixedMs ?? t − upstreamOffsetMs + p.offsetMs` (sun.ts:177-179).
- **`upstreamOffsetMs`** is the server clock minus the upstream clock. For a replay it is server now minus recording time (shared/api.ts:11; server/poller.ts:285).
- **`MinOffset`** (shared/clock.ts:5-29) is unrelated to scene time. It only estimates the server-clock offset inside `ApiClient` (api.ts:16, 37-41).
- **`?sun=1985-08-12T09:12:00Z`** already pins the lighting today (sun.ts:163-170), but the time stays frozen.
- **For the scenario:**
  - The CSV is in JST, with `sec_since_1812` counting from 18:12 JST, which is 09:12 UTC.
  - Set `t0 = Date.UTC(1985, 7, 12, 9, 12, 0)`, then `tSunMs = t0 + tS·1000`.
  - Call `sun.update` directly, or `sunTimeMs(tSunMs, {fixedMs: null, offsetMs: 0}, 0)` so that `?sun=` and the offset cannot interfere.
- **Scrubbing backwards is safe.** `Sun.update` only uses scratch objects and carries nothing between frames. The environment map rebuilds on time only after 3,600 s by default (sun.ts:250-251), and the flight is shorter than that.
- **Scenario clock:** keep `{tS, rate, playing}` and advance it by `dtS·rate`. `dtS` is clamped to 1 s (app.ts:539), and a scrub sets `tS` directly.
  - Because audio plays along, make `audio.currentTime` the master clock, or pause the audio on `visibilitychange`. Frames stop in a hidden tab, but audio keeps playing.
- **Anachronism:** the night lights are modern VIIRS Black Marble data (app.ts:220).

### 5. URL state

- **What `urlState.ts` owns:** `at, hex, chase, cam, topo, light, glass` (urlState.ts:55). It keeps every other parameter (urlState.ts:6, 52).
  - `readView` treats the view as a chase only when `hex` matches the regex (urlState.ts:48).
  - `readParams` reads `hex, bench, airport` (app.ts:195-206). `?sun=` is read in sun.ts:163.
- **`syncUrl`** runs every 1 s with `replaceState` and writes `hex`, `chase=1`, `at` (the chased position) and `cam` (app.ts:451-463).
- **Conventions:** short keys, comma-separated numbers, rounding against history churn, `1`/`0` booleans, and pure tested functions (urlState.test.ts).
- **A `?scenario=jal123` parameter would already survive `writeUrl` untouched.** It would also need:
  - parsing into `AppParams`;
  - forcing `selected = <scenario hex>` and `chasing = true` (overriding app.ts:309-312);
  - **not writing `hex`/`chase`**. Otherwise a reload becomes a live chase of a fake hex (app.ts:312);
  - a `cam` write that does not need `hex && chase`, since that condition is at urlState.ts:59;
  - a `?t=` for the playhead in whole seconds;
  - a start camera set from the first pose. Otherwise `setView` starts over LLBG at 60 km (app.ts:436-446).

### 6. Live-data assumptions that would break

1. **`api.ready` gate** (app.ts:545): with no poll reply, `s` stays `null` and the model hides (app.ts:616).
2. **Splash:** `onFirstData` fires only once `status !== NO_STATUS` (app.ts:575-578). The splash then waits the full 12 s and says "Connecting to live traffic…" (main.ts:7, 12-14).
3. **Status icon** spins forever while `known === null` (app.ts:622-625).
4. **Flight card:**
   - The status line is Live / Predicting / "Signal lost" based on `mode` and `ageS` (flightCard.ts:75-98; format.ts:17, 36-38). "Live · source" is wrong for a 1985 reconstruction.
   - The HUD tags values as observed or derived (format.ts:45-52).
   - It fetches a photo from planespotters by hex (flightCard.ts:302; photo.ts:85).
   - The Chase/Map button calls `setChase(false)` and goes back to browse (flightCard.ts:390; app.ts:365, 505-524).
   - The close button calls `select(null)` (app.ts:469-471).
5. **Esc** calls `setChase(false)` (app.ts:773-777). In a scenario it has to exit the scenario instead.
6. **Focus/chase polling:** `/chase` is asked every second while chasing (app.ts:662). The first reply rebuilds the registry and resets the clock (app.ts:698-707).
7. **URL:** `syncUrl` writes `hex`/`chase` (app.ts:458-462).
8. **Model type and livery** come from `AircraftInfo` (app.ts:597-599), and there is no JAL livery.
9. **Hero airports** are only KSFO, LLBG and LOWI (public/airports/heroes.json). Haneda gets no painted runways, and a relatch uses the drawn ground (app.ts:176-178).
10. **The 35-min store** is `LATEST_HORIZON_MS`, server-side retention of each aircraft's newest sample (server/store.ts:10), on top of 180 s of track (store.ts:25). A client-side scenario never touches it. Do not route the 1985 data through `/view`, `/chase` or `make replay`.
11. **Credits:** `attributionFor` credits the live source (app.ts:212-228). Scenario credits need to be added.
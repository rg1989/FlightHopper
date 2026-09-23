# WP-E-A — Terrain & Sun Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the terrain & sun packages (WP-E0 to WP-E5) into the app the user opens (`.planning/terrain-sun-design.md`, D2–D13, §5, §6). In chase, the real sun lights the terrain and the aircraft. A replay is lit at the time it was recorded, and city lights come up at night. Two toggles, "3-D terrain" and "Sun" (keys T and L), flatten the relief into the map and grow it back, or switch the lighting off. The user's choices persist. Browse stays the unlit street map. There are no cast shadows (D10). In the PoC they cost 65 → 46–52 fps and drew stripes on the aircraft, and the user judged the gain small. This package also adds the synthetic Innsbruck replay and the checklist for gate GE.

**Architecture:** Three files of WP-B-A are edited, and one script is new.
- `client/app.ts` (edited):
  - **Start.** `?sun=` is read once with `parseSunParam` (WP-E2). `readParams` keeps its shape, because its tests `deepEqual` it. The stored toggles are read with both the `localStorage` getter and `getItem` inside `try`, because either one throws where storage is blocked. Then `prefs = readScenePrefs(location.search, stored)` (WP-E4).
  - **Topography first.** An async wrapper inside the startup `Promise.all` builds `new Topography(viewer.scene, prefs.topo)` (WP-E1) as soon as `createViewer` resolves. That code runs as a microtask. Cesium renders its first frame in a `requestAnimationFrame` callback (`CesiumWidget.js:47-88`), so the factor has left 1 before any tile is loaded. When the factor leaves 1 after tiles are loaded, every tile is rebuilt (PoC: 686–2,008 ms).
  - **Sun.** The night layer (`makeNightLayer`, WP-E2) is added on top of the satellite base layer, before `makeMapLayer` adds the street map, so browse's street map covers it. Then the app calls `new Sun(viewer, { day: the base layer or null, night })`, `sun.attachModel(model?.model ?? null)` and `sun.setEnabled(selected !== null && prefs.light)`.
  - **Chase camera.** `new ChaseCamera(viewer, { groundAt: (c) => topo.ground(globe.getHeight(c), tf, camGround, c) })` (WP-E1, D5). `tf` is this frame's `TerrainFrame`, which `frame()` assigns first. `camGround` is a `GroundMemo` (WP-E1), and `c` is the point read. `ground()` uses a memo only with that point: without it, the memo is neither read nor refilled. When Cesium's picker race answers `undefined` at a point, the last reading within 50 m of it (WP-E1's `MEMO_RADIUS_M`), rescaled to this frame's factor, stands in. That covers small clearance corrections only. While a large correction holds, the camera starts each frame farther than 50 m from its last reading, so the memo lapses and the frame gets no correction, as without a memo (WP-E1's ponytail). The ground is also unknown in a run from the first frames of a grow from flat: the last reading is a flat one and holds no relief (WP-E1's residual, in its Notes).
  - **Toggles.** `mountSceneToggles` (WP-E4) is mounted as the first child of `.fh-right`, before the table. Clicks and keys go through one path, `setPrefs(next)`:
    - on a topography change, `topo.set(next.topo, now, relHFor(chased, groundM, topo.relHM, airports))`;
    - then it stores `prefs`, and calls `sun.setEnabled(selected !== null && next.light)`, `writeScenePrefs(next, store)` and `toggles.update(next)`.

    Preferences are stored only on a user action, never at load.
  - **Keys.** `sceneKey(e)` (new, pure) returns `'topo'` for T and `'light'` for L, in either case. It returns `null` in these cases:
    - with Cmd, Ctrl or Alt held (Cmd/Ctrl+L and Ctrl+T belong to the browser);
    - on auto-repeat;
    - when the target is an `INPUT`, `TEXTAREA`, `SELECT` or content-editable element (the table's search box).

    The keys act in chase only, like the buttons, which browse hides. Escape and `b` are checked first and work as before.
  - **Flat plane (D4).** `relHFor(at, groundM, relHM, airports)` (new, pure) returns `pickRelHM(at.lat, at.lon, groundM ?? relHM, airports)` (WP-E1), or `relHM` when there is no aircraft. That gives, in order: a hero airport's runway height within 30 km, else the ground, else the plane as it is.
    - A flatten passes the lag-corrected ground under the chased aircraft. At rest at `TOPO_ON`, that ground is within 1e-5 of the true ground.
    - `select()` sets `relatchPending`. The first chased frame without an animation then calls `topo.relatch(relHFor(s, null, topo.relHM, airports))`. Near a hero airport the plane moves to its runway height. Elsewhere it stays. `relatch` acts only while the map is flat and at rest.
    - The relatch waits for the first state. `select()` has no drawn position yet, and `?hex=` never calls `select()` (`relatchPending` starts true for it). A relatch during an animation would be ignored, so it waits for the animation to end.
  - **`select()`** also forgets the ground (`groundM = null`, and `ok = false` on both memos) and calls `sun.setEnabled(hex !== null && prefs.light)` (D9).
  - **`frame()`** runs in the order of design §5:
    1. `tf = topo.update(now)`.
    2. The render clock and the fleet.
    3. `fleetLayer.setTerrain(tf)`, before `fleetLayer.update` (WP-E3).
    4. The table.
    5. For the chased state: the pending relatch, then `groundM = topo.ground(globe.getHeight(carto), tf, acGround, carto)` (`carto` is the aircraft's point, in radians), then `placedHeightM`, the model and the chase camera.
       - An `undefined` reading (Cesium's picker race, during an animation and before the nudge) answers `acGround`'s last reading, rescaled to this frame's factor, while the aircraft is within 50 m of where it was read. The aircraft's ground therefore follows the grow or the sink instead of lagging by Δf·relief, for the first part of a run only: at SYN601's 180 kt (92.6 m/s), 50 m is 0.54 s, about 32 frames at 60 fps. The rest of a longer run gives `null`.
       - `null` (the ground is unknown) also comes before the first reading after a selection (tiles not loaded), after a new plane, and in a run from the first frames of a grow from flat: the last reading is a flat one and holds no relief (WP-E1's residual, in its Notes). `placedHeightM` then keeps the estimated height, as before the terrain packages.
    6. `sun.update(sunTimeMs(tSunMs, sunParam, status.upstreamOffsetMs ?? 0), at)`, every frame in both modes (WP-E2's convention). `tSunMs` is the render time, or `Date.now()` before the first reply. `at` is the placed aircraft, written with `Cartesian3.fromDegrees` into a reused vector, else `viewer.camera.positionWC`. `upstreamOffsetMs` (WP-E5) lights a replay at the time it was recorded (D12).
    7. `runways.update(tf)`, then `runways.setLight(selected !== null && prefs.light && st !== null ? sunLook(st.elevDeg, runwayLook) : null)` (WP-E3). `st` is what step 6's `sun.update` returned, and `runwayLook` is one `SunLook` made at startup, which `sunLook` rewrites in place. While the Sun is on, the runway planes darken as the day imagery does. In browse, or with the toggle off, `null` keeps them as built. `setLight` writes three numbers into one shared `Color`, so it runs every frame with no check for change.
    8. The HUD, the detail panel, the banner and the bench, as before.
  - **`?bench=1`** also sets two User Timing marks under the chased aircraft. Gate GE counts both in the app.
    - `fh:no-ground` for every `undefined` terrain reading. It counts the raw readings, before the memo.
    - `fh:ground-unknown` for every frame whose ground is still `null` after `ground()`, that is, where the memo did not answer. It is the only check in the app that the memo is wired: an inert memo (for example, one called without the point) makes it equal to `fh:no-ground`.
  - `attributionFor` adds "Night lights: NASA GIBS, VIIRS Black Marble" (D13). The full acknowledgment is `NIGHT_CREDIT`, in Cesium's credit list.
  - `stop()` also destroys the toggles and removes the night layer, which destroys it. `Sun` and `Topography` hold nothing outside the viewer's state, and `viewer.destroy()` releases that.
  - ponytail: while the map is flat, a selection away from the three hero airports keeps the old plane. At start that plane is the ellipsoid (0 m).
    - Everything drawn stays consistent: runways, ground icons and a landed aircraft all sit on that plane.
    - The aircraft's height above the flat map is off by the height of the true ground.
    - Upgrade: `sampleTerrainMostDetailed` (true heights, async) under the new aircraft, then `relatch` when it resolves (WP-E1's note).
- `client/ui/layout.css` (edited):
  - `.fh-ui[data-mode='browse'] .fh-toggles { display: none }`. `sceneToggles.css` already gives the group `pointer-events: auto`, `flex: none` and `width: max-content`. As the first child of the column (`align-items: flex-end`), it sits at the top right, above the table.
  - **Phones (≤ 640 px), in chase.** The detail panel spans the width at `z-index: 11`, above the column, so it would cover the toggles. It now starts at `top: 52px`: 8 px, plus the group's 38 px, plus the column's 6 px gap.
    - The GIBS line adds one row to the credits box, which spans the width at the bottom (about 139 px high on a 375 px screen, from 72 px above the bottom). The HUD therefore moves up one credit row, from `bottom: 204px` to `220px`, 8 px above the box.
    - The panel's `max-height` loses the 44 px and that row: `calc(100% - 452px)`, which is 52 + 220 + 172 (the HUD) + 8 px. Its bottom edge is 400 px from the bottom, 8 px above the HUD.
  - WP-E4 suggested another placement: the group just above the credits (`margin-top: auto`). There it would share rows with the HUD. On a 375 px screen the group is about 166 px wide on the right. The HUD is 180–250 px wide on the left (`min-width: 24ch`, with rows like "ALT 12,350 ft baro · alt est."). Both do not fit.
- `.planning/plans/assets/WP-E-A/gen-synthetic-lowi.ts` (new) writes the replay for gate GE in WP-A2's `RecordLine` format: 600 adsb.lol-style polls at 1 Hz, 40 nm around LOWI, from 2026-09-22 10:00Z (12:00 CEST, sun 41°). Its output, `data/recordings/synthetic-lowi.jsonl`, is gitignored.
  - **SYN601 (`000e01`, A320)**, the aircraft to chase:
    - It comes from the north over the Karwendel on 168° at 180 kt and descends from 2,950 m to 2,700 m HAE. It crosses the Nordkette at the Hafelekar (terrain 2,325–2,345 m) 74 s after the start.
    - A small autopilot then flies a right-hand circuit. The downwind runs east along the Inn valley, descending at 1,500 fpm to 1,450 m, 2 × 1,572 m left of the final course. A 180° standard-rate turn at 160 kt ends on the runway 26 final, 16 km out.
    - It intercepts the 3° glide path from below and crosses the threshold at 15 m. The flare follows the runway, which rises 4 m towards 08. It touches down at 510 s and stops on the runway at 560 s. Stopped, it sends `true_heading` 261° (no `track` while stationary), so the chased model points along runway 26.
  - **Three more aircraft for the fleet layer:**
    - SYN602, an A320 parked south of the runway (a ground icon);
    - SYN603, a C172 westbound along the valley at 1,100 m HAE;
    - SYN604, a B77W at FL350.
  - **Heights:** `alt_geom` is HAE (ADS-B version 2). `alt_baro` comes from the EGM96 geoid and QNH 1016, as in WP-A2's generator.
  - The paths were checked against Re:Earth terrain (see Validated).

**Tech Stack:**
- CesiumJS 1.145: `ImageryLayerCollection.add`, `get`, `length` and `remove`; `Globe.getHeight`; `Camera.positionWC`; `Cartesian3.fromDegrees(…, result)`; `Ellipsoid.WGS84`.
- The modules of WP-E0 to WP-E5.
- Browser APIs: Web Storage, `KeyboardEvent`, User Timing.
- `node:test`, and Vite 8 for the CSS check.
- The generator uses Node's standard library, `shared/geo.ts` and `shared/geoid.ts`.
- No new dependencies.

**Wave:** E-A, after WP-E0, E1, E2, E3, E4 and E5. **Estimated:** 1.5 h, plus about 45 min for gate GE.

**Validated:** 2026-09-23 (Node 25.2.1, TypeScript 7.0.2, Vite 8.3.0, CesiumJS 1.145.0) on the user's MacBook Air M2. The scratch copy was the integrated tree (B-A applied, 604 tests) plus the files owned by WP-E0 to WP-E5, copied from their validated sandboxes. No path is owned by two packages.
- **The merged tree before this package:** `npx tsc --noEmit` clean, `npm test` 670/670 (604 + E0 7 + E1 16 + E2 21 + E3 6 + E4 14 + E5 2).
- **After this package:**
  - `node --test client/app.test.ts`: 12/12 (9 + 3).
  - `npx tsc --noEmit`: clean for the whole tree.
  - `npm run check`: `tsc` clean, then 673/673 (670 + 3). The two known timing flakes did not fail in these runs.
- **RED:**
  - Task 1 Step 2: 12 tests, 9 pass, 3 fail. The failures are `TypeError: sceneKey is not a function`, `TypeError: relHFor is not a function` and the missing GIBS line. `tsc` adds TS2339 twice.
  - Task 2's check finds only the old phone rules for the HUD and the panel.
  - Task 3's check fails with `ENOENT`.
- **Mutations** of `app.ts`: 11 tried, 11 caught, each by 1 failing test:
  - the Meta check removed; the repeat check removed; content-editable ignored; the field check dropped; `SELECT` missing;
  - keys case-sensitive; T and L swapped;
  - the ground ignored in `relHFor`; an unknown ground read as 0; no aircraft read as 0;
  - the GIBS line dropped.

  The wiring inside `startApp` has no Node test, because it needs WebGL and a DOM. Gate GE checks it.
- **Build:** `npx vite build` succeeds. The bundled CSS holds both new rules (and, since the review amendment, the moved HUD rule), and `layout.css` comes after `sceneToggles.css`.
- **Replay generator:**
  - One run takes 0.2 s and writes 600 polls, 1,486,121 bytes, SHA-256 `0ca51b2154728363c0c189d3f6ca2e2ebbfd572ab66966342f5e1b4d2f4b09cb` (since the review amendment below; before it, 1,485,281 bytes and `4024544d…`).
  - Two runs wrote identical bytes.
  - `server/recording.ts` reads back 1,849 samples of 4 aircraft, 567 of them SYN601.
- **Terrain clearance:** the paths were checked against Re:Earth terrain, with `sampleTerrainMostDetailed` in Node under every sample. This was a one-off probe, not part of the plan's code.
  - SYN601 crosses the ridge at 2,697 m HAE, over 2,325 m of terrain.
  - SYN601's lowest height above the ground is 291 m north of the ridge (the Gleirsch–Halltal chain, 47.353° N, 11.374° E), 582 m on the downwind and base, and 99 m on the final at 480 s.
  - In the flare it reads −2 m at 508 s, because `alt_geom` comes in 25 ft steps.
  - SYN603 stays at least 376 m above the ground. It turns onto 280° after passing the airport, because on 261° it would hit the south side of the valley at 11.21° E.
- **Replay:** the plan's code blocks were extracted into a fresh copy of the merged tree (before this package) and applied task by task.
  - Each Step 2 failed as written. Task 1: 12 tests, 9 pass, 3 fail, with the quoted messages, and the two TS2339 errors. Task 2's check printed only the old panel rule. Task 3's check failed with `ENOENT`.
  - Each Step 4 passed. Task 1: 12/12 and a clean `tsc`. Task 2: both CSS rules. Task 3: the generator's line, the SHA-256 and the check's two lines.
  - The script type-checked, and `npm run check` gave 673/673.
  - The replayed tree matched the sandbox file for file (`diff -rq`, with `node_modules`, `dist` and `data` excluded).
- **Browser:** gate GE's first runs were on 2026-09-23 (Task 5 Step 3 has the results). They found the `undefined` runs that led to the amendment below.
- **Amendment 2026-09-23 (after gate GE's first runs):** `app.ts` passes WP-E1's `GroundMemo` to `ground()`: `acGround` for the aircraft, in place of the `?? groundM` keep-last, and `camGround` for the chase camera's `groundAt`. `select()` resets both. `app.test.ts` is unchanged: the wiring is inside `startApp`, which has no Node test, so gate GE checks it.
  - `node --test client/app.test.ts client/scene/topography.test.ts`: 25/25 (12 + 13).
  - `npx tsc --noEmit`: clean for the whole tree.
  - `npm test`: 675/675 (the merged tree with WP-E1's 2 new tests, 672, + 3). The two known timing flakes passed.
  - The amended `app.ts` block is byte-identical to the sandbox.
  - Replay: WP-E1's two amended blocks and this `app.ts` were extracted into the replay copy. `topography.test.ts` failed first (`groundMemo` not exported), then `app.test.ts` and `topography.test.ts` passed 25/25. The copy matched the sandbox file for file (`diff -rq`, with `node_modules`, `dist` and `data` excluded). Only `vite.gate.config.ts`, a helper added in the sandbox for the gate runs, is not in the copy.
- **Amendment 2026-09-23 (review: the memo's point, the credits row, the stopped heading):**
  - **The memos were inert.** `app.ts` called `topo.ground(sampled, tf, acGround)` and `topo.ground(globe.getHeight(c), tf, camGround)`. WP-E1's point amendment made `at` the fourth parameter, and `ground()` reads and refills a memo only with it. `at` is optional, so `tsc` accepted both calls, and every `undefined` reading still gave `null`. A scratch probe with the real `Topography`, a sink and a 180 kt southbound track at 60 fps: without the point, `null` from the first `undefined` frame, `memo.ok` false; with it, the rescaled memo up to frame 32 (49.4 m), then `null` from frame 33 (50.9 m). `app.ts` now passes `c` and `carto`. It also sets the `fh:ground-unknown` mark under `?bench=1`, so gate GE can tell a working memo from an inert one (Task 5 Step 3). The comments no longer claim 37-frame runs or clearance kept on every frame.
  - **The memo's radius at 180 kt.** WP-E1's `MEMO_RADIUS_M` is 50 m, sized for 70 m/s. SYN601 flies the toggles at 180 kt (92.6 m/s), so the memo covers about the first 0.54 s of a run. This plan now says so (Architecture, Task 5 Step 3, Notes). `MEMO_RADIUS_M` belongs to WP-E1 and is unchanged.
  - **The credits row on phones.** The GIBS line made the credits box about 139 px high on a 375×812 screen, from 601.5 px down. The HUD, at `bottom: 204px`, ended at 608 px, so they overlapped by about 6 px (`results-ksfo-phone.json`: HUD `[8,436,187,608]`; `12-phone-375x812.jpg`: a doubly darkened band at y 1,204–1,215 of the 2× image). `layout.css` now puts the HUD at `bottom: 220px` and the panel's `max-height` at `calc(100% - 452px)`. Task 2's check also prints the HUD rule. Its RED and GREEN lines were computed with `lightningcss` (Vite's CSS minifier) on B-A's and the new `layout.css`; for the previous `layout.css` this gave exactly the lines of the earlier `vite build`. `vite build` was not re-run.
  - **The stopped heading.** SYN601 stopped at 560 s, not at 595 s: 595 s is its last 5-second position report. After the stop the replay sent neither `track` nor `true_heading`, so `track.ts` drew heading 000°, across runway 26 (gate GE's `results-quiet-machine.json`: "TRK—HDG000°" on the runway, flat and grown). SYN601 now has `heading: 261`. The Task 3 check prints the first sample with `gsKt` 0 and the last `trueHeadingDeg`. Against the old output it printed `stops 560 s, heading null`, and against the new one `stops 560 s, heading 261`. The new output is 1,486,121 bytes, SHA-256 `0ca51b21…`, and two runs wrote identical bytes. The sample count is unchanged.
  - `node --test client/app.test.ts`: 12/12. `node --test client/scene/topography.test.ts`: 15/15 (WP-E1's, unchanged).
  - `npx tsc --noEmit` over the whole tree plus the generator, in one run: clean.
  - `npm test`, `vite build`, the replay and the browser were not run (the machine was short on CPU). Task 4 Step 3's count is computed: 677 (680 since the `setLight` amendment below). The amended blocks for `app.ts`, `layout.css` and the generator are byte-identical to the sandbox.
  - Gate GE's runs above used the inert memos and the old replay. Task 5 Steps 3 and 4 and Step 6 item 5 must run again.
- **Amendment 2026-09-23 (WP-E3's `setLight`):** WP-E3's review revision gave the runway handle `setLight(look)`, to be called every frame after `sun.update` (WP-E3, Notes: "E-A wiring"). `app.ts` now keeps `sun.update`'s result as `st`, imports `sunLook`, makes one `runwayLook = sunLook(90)` at startup, and after `runways.update(tf)` calls `runways.setLight(selected !== null && prefs.light && st !== null ? sunLook(st.elevDeg, runwayLook) : null)` (change list step 16). `setLight` writes three numbers into one shared `Color`, and `sunLook` writes into `runwayLook`, so the call runs every frame with no change check and allocates nothing. `app.test.ts` is unchanged: the call is inside `startApp`, which has no Node test. Gate GE checks it (Task 5 Step 5, items 3 and 6).
  - `node --test client/app.test.ts client/scene/runways.test.ts`: 23/23 (12 + 11).
  - `npx tsc --noEmit`: clean for the whole tree.
  - `npm test`, `vite build`, the replay and the browser were not run (the machine was short on CPU). The counts are computed. WP-E3's revision has 9 tests where its first version had 6 (`runways.test.ts` 8 → 11, `fleetLayer.test.ts` 16 → 22), so the E0–E5 tree counts 674 + 3 = 677 ("Before you start"), and this package makes it 677 + 3 = 680 (Task 4 Step 3). WP-E2's review amendment (the night alpha cap) adds no test. Cross-check: counting the `test(` calls per test file, the sandbox has 76 more than the B-A tree (E0 7, E1 20, E2 21, E3 9, E4 14, E5 2, E-A 3), and 604 + 76 = 680.
  - The amended `app.ts` block is byte-identical to the sandbox (567 lines).

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- **Cesium's debug assertions ship in this app** (Vite bundles the unbuilt source). A throw inside `render` stops Cesium's render loop for good (`CesiumWidget.js:74-81`). The app writes no number into Cesium directly:
  - The factor and the plane go through `Topography`, which checks `set` and `relatch` with `Number.isFinite`. `relHFor` returns `pickRelHM`'s finite value or the current plane.
  - The light and the clock go through `Sun.update`, which writes nothing for a bad time or position.
  - The runway and fleet shifts, and the runway colour (`setLight`), go through WP-E3's guards.
- **No per-frame allocation is added.** `tf` is Topography's reused object. `sunAt` and `carto` are scratch objects, and so is `runwayLook`, the `SunLook` that `sunLook` rewrites for `runways.setLight`. `groundAt` is one closure, made at startup. `acGround` and `camGround` are made once and reset in place. `relHFor` runs only on a flatten or a relatch. The `fh:no-ground` and `fh:ground-unknown` marks allocate only under `?bench=1`, and only on a failed reading.
- **Tests never touch the network.** `client/app.test.ts` reads `public/airports/heroes.json` from disk. It imports `app.ts` only through its existing hook, which loads every `.css` as an empty module (`app.ts` reaches `viewer.ts` and the UI styles).
- **Gate runs use `ADSB_SOURCE=replay`**, so they send nothing to adsb.lol. `data/recordings/synthetic-lowi.jsonl` is gitignored. Never commit it: the generator is its source.
- **No paid services.** NASA GIBS is keyless (D13). This package adds its line to the on-screen credits. PLAN.md's list of allowed services is not a file of this package (see Notes).
- **Heights** are WGS84 ellipsoidal metres (HAE): relH, the chased aircraft, the replay's `alt_geom`.
- **File ownership:** this package edits `client/app.ts`, `client/app.test.ts` and `client/ui/layout.css` (WP-B-A). It creates one script. No file of WP-E0 to WP-E5 changes.
- Erasable TypeScript only. Relative imports end in `.ts`.
- Code blocks preceded by `File: \`path\`` contain that file's complete content. For the three edited files, an ordered change list anchored on today's code follows the complete file, so the edit can be applied again if B-A's final file differs.

## Files owned by this package

| Path | Change |
|---|---|
| `client/app.ts` | edited (WP-B-A): Topography, Sun, the night layer, the scene toggles and keys, the frame order, the flat-plane relatch, the ground memos with their points, the runways' light (`setLight`), the GIBS credit, the `fh:no-ground` and `fh:ground-unknown` bench marks; new pure helpers `sceneKey`, `relHFor` |
| `client/app.test.ts` | edited (WP-B-A): 12 tests (3 new); the 9 existing tests are unchanged |
| `client/ui/layout.css` | edited (WP-B-A): the toggles hidden in browse; on phones in chase, the panel starts below the toggles, and the HUD moves up one credit row (the GIBS line) |
| `.planning/plans/assets/WP-E-A/gen-synthetic-lowi.ts` | new: deterministic LOWI replay generator for gate GE (its output is gitignored) |

## Sources (checked 2026-09-23)

Paths are relative to `node_modules/@cesium/engine/Source` (Cesium 1.145.0) unless they are marked `d.ts` (`node_modules/cesium/Source/Cesium.d.ts`) or are repository paths.

| Fact | Source |
|---|---|
| The widget renders its first frame in a `requestAnimationFrame` callback that its constructor schedules. Code that runs in a microtask after `createViewer` resolves therefore runs before that frame. A throw inside the render stops the loop for good: the `catch` sets `_useDefaultRenderLoop = false`. | `Widget/CesiumWidget.js:47-88` (`:88`, `:74-81`) |
| `scene.preUpdate` fires at the start of `Scene.render`, before the globe takes this frame's exaggeration. `globe.getHeight` in `frame()` therefore answers the previous render's surface, which is why `TerrainFrame` and `groundAt` exist. | `Scene/Scene.js:4621-4627`, `:4696`; `Scene/GlobeSurfaceTileProvider.js:555-576`; d.ts `:44801`; research VERIFY (verify:exaggeration) |
| `ImageryLayerCollection.add(layer)` without an index puts the layer on top. `makeMapLayer` then adds the street map above it (`addImageryProvider`). `remove(layer, destroy = true)` destroys the layer it removes. The collection also has `length` and `get(index)`. | `Scene/ImageryLayerCollection.js:79-80`, `:92`, `:164-165`; d.ts `:37859`, `:37872`, `:37895`, `:37918`; `client/scene/mapLayer.ts:32` |
| `createViewer` passes the configured imagery as `baseLayer` (index 0), or `false` for `none`. | `client/scene/viewer.ts:17` |
| `Globe.getHeight(cartographic): number \| undefined`. `Camera.positionWC` is a getter that returns the camera's own `Cartesian3`. `Cartesian3.fromDegrees(lon, lat, h, ellipsoid, result)` writes into `result`. | d.ts `:35457`, `:29061`, `:2125`; `Scene/Camera.js:938-943` |
| The table's search box stops its `keydown` events, so the window listener does not see them. `sceneKey` filters fields anyway (another input, or a future one). | `client/ui/table.ts:424-425` |
| The detail panel has `z-index: 11` and `top: 8px`, and on phones (≤ 640 px) it spans the full width, above `.fh-right` (`z-index: 10`). The HUD has `min-width: 24ch`, 12 px monospace, at the bottom left. | `client/ui/detail.css:5-10`, `:185-190`; `client/ui/layout.css:13-25`; `client/ui/ui.css:5-31` |
| The toggle group: 26 px buttons (32 px on phones) in a box with 3 px padding, `pointer-events: auto`, and no position of its own. | `client/ui/sceneToggles.css:5-16`, `:63-68` |
| `Topography`: `update` first in the frame; `ground(sampledM, frame, memo, at)` with one `GroundMemo` per followed point, passed together with that point (`at`, radians; without it the memo is neither read nor refilled, and `tsc` does not object, because `at` is optional); a memo answers only within 50 m of where it was read (`MEMO_RADIUS_M`, sized for 70 m/s); a `null` ground means "unknown"; `relatch` only while flat and at rest; construct it before the first frame. | `.planning/plans/WP-E1-topography.md`, Architecture: "Conventions consumers rely on", `ground()`; `client/scene/topography.ts:17`, `:160-175` |
| Under the chased aircraft, `globe.getHeight` answered `undefined` on 175 frames inside the 2.5 s animation + 0.5 s nudge windows and 1 outside, in runs of up to 37 frames (~0.6 s), in 10 toggles. The app then kept a ground that lagged by Δf·relief, and the camera skipped its clearance correction on those frames. | Gate GE, 2026-09-23 (Task 5 Step 3, run 2); WP-E1 Sources |
| On a 375×812 phone in chase, the credits box with the GIBS line spans y 601.5–740 px (a model line wraps to 2 rows; rows are about 14.5 px apart). The HUD at `bottom: 204px` spans y 436–608 px, so the two overlapped by about 6 px. | Gate GE, 2026-09-23: `assets/WP-E-A/gate-GE/results-ksfo-phone.json` (HUD `[8,436,187,608]`), and a pixel scan of `12-phone-375x812.jpg` (2×: a doubly darkened band at y 1,204–1,215) |
| After it stops (560 s), the old replay sent SYN601 with neither `track` nor `true_heading`. The track then gives `this.#trueHeading(…) ?? trackDeg ?? 0`, heading 000°. `object()` sends `true_heading` only for a plane with `heading`, and only while `trk` is `null`. | `client/track/track.ts:149`; `.planning/plans/assets/WP-E-A/gen-synthetic-lowi.ts` (`object()`); gate GE `results-quiet-machine.json` ("TRK—HDG000°") |
| `Sun`: `update` every frame in both modes (in browse at the camera, `Date.now()` before the first reply); `setEnabled` on every selection and toggle; the night layer right above the day layer; `Sun` is the only writer of the light, the clock and the globe lighting; nobody sets `viewer.shadows`. | `.planning/plans/WP-E2-sun.md`: "Conventions consumers (E-A) rely on" |
| `fleetLayer.setTerrain(frame)` comes before `fleetLayer.update`, and `runways.update(frame)` runs in the same frame. Neither keeps the object. After `sun.update`, `runways.setLight(look)` takes `sunLook(st.elevDeg, look)` into one reused `SunLook` while the Sun is on (`selected !== null && prefs.light`), else `null`. It reads only `dayBrightness` and `intensity`, and writes three numbers into one `Color` (no allocation, no vertex touched). | `.planning/plans/WP-E3-ground-objects.md`, Architecture (`setLight`) and Notes: "E-A wiring"; `client/scene/runways.ts` (`setLight`) |
| `sunLook(elevDeg, result?)` is pure and writes into `result` when it is given. `Sun.update` returns one reused `SunState` (`elevDeg`, `night`, `golden`), or `null` for a bad time or position. | `client/scene/sun.ts` (`sunLook`, `SunState`, `Sun.update`) |
| Read storage inside `try`; one `setPrefs` path; store only on a user action; the group first in `.fh-right`; the browse rule in `layout.css`; the phone layout. | `.planning/plans/WP-E4-scene-toggles.md`: "Conventions consumers (E-A) rely on" |
| `StatusBrief.upstreamOffsetMs` is absent until the first good answer. Treat that as 0. | `.planning/plans/WP-E5-recorded-sun-time.md`, Notes; `shared/api.ts:11` |
| LOWI runway 26 threshold: 47.26160049438477, 11.357000350952148, 625.72 m HAE, 261°. Runway 08 threshold: 47.258945864390505, 11.332252515916366, 629.72 m HAE. Length 6,562 ft. | `public/airports/heroes.json` (WP-T1) |
| Terrain under the replay's paths: Re:Earth heights from `sampleTerrainMostDetailed` in Node. The Hafelekar reads 2,345.5 m and the runway 26 threshold 626.2 m, and every SYN601 and SYN603 sample was checked. | `https://terrain.reearth.land/cesium-mesh/ellipsoid`, probe run on 2026-09-23 |
| Sun at LOWI (1,500 m) on 2026-09-22 for gate GE's `?sun=` times: 06:00Z +9.4° (azimuth 100°), 10:00Z +41.0° (158°, the replay), 16:45Z +3.7° (266°, golden 0.84), 20:30Z −31.7° (night 1). KSFO at 18:00Z: +43.4°. These are Node (TEME) values from WP-E2's `sunDirectionWC`. The browser (ICRF) differs by up to 0.4°. | `client/scene/sun.ts` (WP-E2); research VERIFY C4, C21 |
| The replay server plays a recording once from its own start (no loop by default) and serves positions up to 60 s old. | `server/sources/index.ts:22-23`; `server/sources/replay.ts:14`, `:87-110` |

---

### Task 1: Wire the terrain & sun packages into the app

**Files:**
- Modify: `client/app.test.ts`, `client/app.ts`. The complete new contents are below, each followed by a change list anchored on today's code.
- Test: `client/app.test.ts`

**Interfaces:**
- Consumes:
  - WP-E0: `ScenePrefs`, `TerrainFrame`.
  - WP-E1: `Topography` (`update`, `set`, `relatch`, `ground(sampled, frame, memo, at)` with a memo and the point it reads at, `relHM`, `animating`), `groundMemo` (`GroundMemo`), `pickRelHM`, `ChaseCameraOpts.groundAt`.
  - WP-E2: `Sun` (`setEnabled`, `attachModel`, `update`, whose `SunState | null` result gives `elevDeg`), `sunLook(elevDeg, result?)` (`SunLook`), `parseSunParam`, `sunTimeMs`, `makeNightLayer`.
  - WP-E3: `addRunways(…).update(frame)`, `addRunways(…).setLight(look: { dayBrightness: number; intensity: number } | null)` (WP-E3's review revision), `FleetLayer.setTerrain(frame)`.
  - WP-E4: `PREFS_KEY`, `readScenePrefs`, `writeScenePrefs`, `mountSceneToggles`.
  - WP-E5: `StatusBrief.upstreamOffsetMs`.
- Produces:
  - `sceneKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; repeat: boolean; target: unknown }): keyof ScenePrefs | null`
  - `relHFor(at: { lat: number; lon: number } | null, groundM: number | null, relHM: number, airports: readonly Airport[]): number`
  - `attributionFor(model)`, now with the GIBS line.
  - `startApp(root, cfg)`, same signature. Under `?bench=1` it also sets the `fh:no-ground` and `fh:ground-unknown` marks.

**Before you start:** WP-E0 to WP-E5 are applied, WP-E1 with all three of its memo amendments: `GroundMemo`, the flat memo, and the memo's point (`ground(…, memo, at)`, with its 50 m radius). WP-E3 is applied as revised after its review: the runway handle has `setLight`, and `runways.test.ts` and `fleetLayer.test.ts` count 11 and 22 tests. WP-E2's review amendment (the night alpha cap) adds no test. `npx tsc --noEmit` is clean, and `npm test` counts 677 tests: 674 with WP-E3's first version (6 tests, now 9), 673 before WP-E1's point test, 672 before its flat-memo test. `tsc` does not show a missing point: `at` is optional.

- [ ] **Step 1: Write the failing test** (the complete file: the 9 tests of today are unchanged; the imports change and 3 tests are new)

File: `client/app.test.ts`
```ts
// client/app.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import type { Airport } from '../shared/airports.ts'
import type { StatusBrief } from '../shared/api.ts'
import { distanceNm } from '../shared/geo.ts'
import { countryOf } from '../shared/icaoCountry.ts'
import type { FleetEntry, ModelManifestEntry } from './types.ts'

// app.ts imports viewer.ts, the ui/ modules and layout.css, which import CSS for Vite. Node cannot load CSS, so this file
// loads every .css as an empty module. The hook lives only in this test's process: node --test runs each file in its own.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { attributionFor, browseCircle, entriesIn, flagOf, lookupFor, placedHeightM, readParams, relHFor, sceneKey, statusShown, viewRadiusNm } =
  await import('./app.ts')

const entry = (hex: string, lat: number, lon: number): FleetEntry => ({
  hex, lat, lon, hM: 0, altFt: null, onGround: false, trackDeg: null, gsKt: null, vsFpm: null, ageS: 0, quality: 'adsb2', info: null,
})

test('view radius follows the camera height, in 10 nm steps, clamped to 20–250 nm', () => {
  assert.equal(viewRadiusNm(0), 20)
  assert.equal(viewRadiusNm(150), 20) // chasing on the runway
  assert.equal(viewRadiusNm(37_040), 20) // 20 nm up
  assert.equal(viewRadiusNm(37_041), 30)
  assert.equal(viewRadiusNm(100_000), 60) // 54 nm → next step
  assert.equal(viewRadiusNm(20_000_000), 250) // whole-Earth view
  assert.equal(viewRadiusNm(Number.NaN), 250)
})

test('browse poll circle: centred on the visible rectangle, covering all of it, in 10 nm steps within 20–250 nm', () => {
  // The rectangle WP-B-V3's harness measured for the 300 km top-down view over LLBG (800×692 px canvas).
  const r = { west: 32.999, south: 30.628, east: 36.774, north: 33.367 }
  const c = browseCircle(r)
  assert.deepEqual({ lat: c.lat, lon: c.lon }, { lat: 32, lon: 34.89 }) // 2 decimals: the ApiClient's view key
  assert.equal(c.nm % 10, 0)
  for (const [lat, lon] of [[r.south, r.west], [r.south, r.east], [r.north, r.west], [r.north, r.east]]) {
    const d = distanceNm(c.lat, c.lon, lat, lon)
    assert.ok(d <= c.nm && d > c.nm - 10, `corner ${lat},${lon} at ${d.toFixed(1)} nm, circle ${c.nm} nm`)
  }
  assert.equal(c.nm, 130)
})

test('browse poll circle: antimeridian, whole world, tiny views, and a stable key for a camera at rest', () => {
  const across = browseCircle({ west: 179, south: -1, east: -179, north: 1 })
  assert.deepEqual(across, { lat: 0, lon: -180, nm: 90 }) // 2° wide across 180°: centred on it, not on Greenwich
  assert.ok(distanceNm(0, -180, 1, 179) <= 90)
  assert.deepEqual(browseCircle({ west: -180, south: -90, east: 180, north: 90 }), { lat: 0, lon: 0, nm: 250 }) // capped
  assert.equal(browseCircle({ west: 11.33, south: 47.25, east: 11.36, north: 47.27 }).nm, 20) // 2 km up: the floor
  const r = { west: 8.1, south: 46.2, east: 14.6, north: 48.3 }
  assert.deepEqual(browseCircle(r), browseCircle({ ...r })) // same view → same key → the server sends only what is new
})

test('on-screen entries: the ones inside the rectangle, written into a reused array', () => {
  const all = [entry('a', 47, 11), entry('b', 50, 11), entry('c', 0, 179.5), entry('d', 0, -179.5), entry('e', 0, 170)]
  const out: FleetEntry[] = [entry('stale', 0, 0)]
  const got = entriesIn(all, { west: 10, south: 46, east: 12, north: 48 }, out)
  assert.equal(got, out) // no new array per frame
  assert.deepEqual(got.map((e) => e.hex), ['a'])
  assert.deepEqual(entriesIn(all, { west: 179, south: -1, east: -179, north: 1 }, out).map((e) => e.hex), ['c', 'd'])
  assert.deepEqual(entriesIn(all, null, out), []) // globe out of view
  assert.equal(out.length, 0)
  // The selected aircraft always counts: chasing, it flies in front of the camera, above the ground the camera sees.
  assert.deepEqual(entriesIn(all, { west: 10, south: 46, east: 12, north: 48 }, out, 'e').map((e) => e.hex), ['a', 'e'])
  assert.deepEqual(entriesIn(all, null, out, 'b').map((e) => e.hex), ['b'])
})

test('flags and lookups: country from the ICAO address block, airline from the callsign designator', () => {
  assert.equal(flagOf('4b1805'), '🇨🇭') // Switzerland 4B0000–4B7FFF
  assert.equal(flagOf('738065'), '🇮🇱')
  assert.equal(flagOf('~4b1805'), '') // non-ICAO (TIS-B) address: no country
  assert.equal(flagOf('b00001'), '') // unallocated block (the synthetic heavy replay uses it)
  const l = lookupFor('4b1805', 'SWR8KL')
  assert.deepEqual(l, { country: { iso2: 'CH', name: 'Switzerland', flag: '🇨🇭' }, airline: 'Swiss International Air Lines' })
  assert.notEqual(l.country, countryOf('4b1805')) // a copy: countryOf's objects are shared and frozen
  assert.deepEqual(lookupFor('b00001', null), { country: null, airline: null })
  assert.deepEqual(lookupFor('3c6444', 'DABCD'), { country: { iso2: 'DE', name: 'Germany', flag: '🇩🇪' }, airline: null }) // a registration, not a flight
})

test('chased model height: wheels on the terrain on the ground, never below it in the air', () => {
  assert.equal(placedHeightM(-20, true, -31.5), -31.5) // ground: the terrain, whatever the estimator says
  assert.equal(placedHeightM(-20, true, null), -20) // tile not loaded yet: the estimate
  assert.equal(placedHeightM(-40, false, -31.5), -31.5) // airborne below the terrain: lifted to it
  assert.equal(placedHeightM(300, false, -31.5), 300) // airborne above: untouched
  assert.equal(placedHeightM(300, false, null), 300)
})

test('URL parameters: ?hex= (lower-cased, validated), ?bench=1, ?airport=', () => {
  assert.deepEqual(readParams('?hex=A1B2C3&bench=1'), { hex: 'a1b2c3', bench: true, airport: null })
  assert.deepEqual(readParams('?hex=~a330e6'), { hex: '~a330e6', bench: false, airport: null })
  assert.deepEqual(readParams('?hex=nope&bench=true&airport=llbg'), { hex: null, bench: false, airport: 'LLBG' })
  assert.deepEqual(readParams(''), { hex: null, bench: false, airport: null })
})

test('attribution: adsb.lol ODbL, OurAirports, OpenFlights ODbL, OpenStreetMap, planespotters, the model licence', () => {
  const m: ModelManifestEntry = {
    id: 'cesium-air',
    uri: 'models/Cesium_Air.glb',
    license: 'Apache-2.0: CesiumJS repository LICENSE.md',
    author: 'CesiumJS Contributors (Cesium GS, Inc.)',
    source: 'https://github.com/CesiumGS/cesium',
    forwardAxisFix: { headingDeg: -90, pitchDeg: 0, rollDeg: 0 },
    gearHeightM: 4.03,
    lengthM: 37.57,
    scale: 1.7555,
  }
  const lines = attributionFor(m)
  assert.ok(lines.some((l) => /adsb\.lol/.test(l) && /ODbL/.test(l)), lines.join(' | '))
  assert.ok(lines.some((l) => /OurAirports/.test(l)))
  assert.ok(lines.includes('Airline names: OpenFlights (ODbL)'), lines.join(' | ')) // ODbL requires the credit
  assert.ok(lines.some((l) => /OpenStreetMap contributors/.test(l) && /ODbL/.test(l)), lines.join(' | '))
  assert.ok(lines.some((l) => /planespotters\.net/.test(l)), lines.join(' | '))
  assert.ok(lines.includes('3D model: CesiumJS Contributors (Cesium GS, Inc.), Apache-2.0'), lines.join(' | '))
  assert.equal(attributionFor(null).length, lines.length - 1)
})

test('status shown: 3 failed polls in a row read as "upstream-down"; fewer change nothing', () => {
  const ok: StatusBrief = { source: 'replay', degraded: null, cellPeriodP95S: null, chasePeriodP95S: null }
  assert.equal(statusShown(ok, 0), ok)
  assert.equal(statusShown(ok, 2), ok)
  assert.deepEqual(statusShown(ok, 3), { ...ok, degraded: 'upstream-down' })
  assert.deepEqual(statusShown({ ...ok, degraded: 'blocked' }, 0), { ...ok, degraded: 'blocked' })
})

const press = (key: string, more: object = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, repeat: false, target: null, ...more })

test('scene keys: T topography and L sun, either case; not with a modifier, on auto-repeat or while typing in a field', () => {
  assert.equal(sceneKey(press('t')), 'topo')
  assert.equal(sceneKey(press('T')), 'topo') // Shift or Caps Lock
  assert.equal(sceneKey(press('l')), 'light')
  assert.equal(sceneKey(press('L')), 'light')
  assert.equal(sceneKey(press('b')), null)
  assert.equal(sceneKey(press('Escape')), null)
  for (const m of ['metaKey', 'ctrlKey', 'altKey', 'repeat']) assert.equal(sceneKey(press('l', { [m]: true })), null, m) // Cmd+L, Ctrl+T: the browser's
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(sceneKey(press('t', { target: { tagName } })), null, tagName) // the table's search box
  assert.equal(sceneKey(press('t', { target: { tagName: 'DIV', isContentEditable: true } })), null)
  assert.equal(sceneKey(press('t', { target: { tagName: 'BUTTON', isContentEditable: false } })), 'topo') // a focused toggle
})

test('flat plane (design D4): a hero airport within 30 km gives its runway height, else the ground under the aircraft, else the plane stays', () => {
  const heroes: Airport[] = JSON.parse(readFileSync(new URL('../public/airports/heroes.json', import.meta.url), 'utf8'))
  const hafelekar = { lat: 47.3125, lon: 11.3864 } // on the Nordkette, 6.6 km from LOWI
  assert.equal(relHFor(hafelekar, 2345, 0, heroes), 627.72) // LOWI: the mean of its threshold heights 629.72 and 625.72
  assert.equal(relHFor(hafelekar, null, 0, heroes), 627.72)
  const zugspitze = { lat: 47.4211, lon: 10.9853 } // 32.4 km from LOWI
  assert.equal(relHFor(zugspitze, 2950, 627.72, heroes), 2950) // flatten from rest: the drawn ground is the true one
  assert.equal(relHFor(zugspitze, null, 627.72, heroes), 627.72) // ground unknown, or a new selection while flat: keep the plane
  assert.equal(relHFor(null, 2950, 56.57, heroes), 56.57) // no aircraft drawn yet
})

test('attribution: the night lights credit NASA GIBS (design D13)', () => {
  assert.ok(attributionFor(null).includes('Night lights: NASA GIBS, VIIRS Black Marble'))
})
```

Change list, applied to today's `client/app.test.ts`:
1. After `import assert from 'node:assert/strict'`, add `import { readFileSync } from 'node:fs'`. After `import { registerHooks } from 'node:module'`, add `import type { Airport } from '../shared/airports.ts'`.
2. The destructuring of `await import('./app.ts')` also takes `relHFor` and `sceneKey`, in alphabetical order. The line wraps before `await`.
3. At the end of the file, append the `press` helper and the three tests `scene keys: …`, `flat plane (design D4): …` and `attribution: the night lights credit NASA GIBS (design D13)`.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/app.test.ts`
Expected: FAIL with `ℹ tests 12`, `ℹ pass 9`, `ℹ fail 3`:
```
✖ scene keys: T topography and L sun, either case; not with a modifier, on auto-repeat or while typing in a field
  TypeError: sceneKey is not a function
✖ flat plane (design D4): a hero airport within 30 km gives its runway height, else the ground under the aircraft, else the plane stays
  TypeError: relHFor is not a function
✖ attribution: the night lights credit NASA GIBS (design D13)
  AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
    assert.ok(attributionFor(null).includes('Night lights: NASA GIBS, VIIRS Black Marble'))
```

Run: `npx tsc --noEmit`
Expected:
```
client/app.test.ts(17,96): error TS2339: Property 'relHFor' does not exist on type 'typeof import("<repo>/client/app")'.
client/app.test.ts(17,105): error TS2339: Property 'sceneKey' does not exist on type 'typeof import("<repo>/client/app")'.
```

- [ ] **Step 3: Write the implementation**

File: `client/app.ts`
```ts
// client/app.ts
// The client app: one Cesium viewer in two modes, fed by 1 Hz polls of the server.
// - Browse (nothing selected): a north-up, top-down street map. Every aircraft is an icon turned to its track and
//   coloured by altitude, with the table of the aircraft on screen on the right and the altitude legend at the bottom.
// - Chase (an aircraft selected by a table row, a click on its icon or ?hex=): the 3-D model and the chase camera over
//   the satellite imagery, the detail panel on the left and the HUD. The other aircraft stay on screen as icons. The
//   sun lights the chase view, and the relief can sink into the map and grow back (toggles "3-D terrain" and "Sun",
//   keys T and L).
// Every aircraft goes into the Fleet (newest sample, dead-reckoned: cheap enough for thousands a frame). Only the
// selected one also goes into the TrackRegistry, whose full estimator the chase camera follows.
// This file only wires the parts in scene/, track/, browse/, ui/, bench/ and api.ts together.
import { Cartesian2, Cartesian3, Cartographic, Ellipsoid, Math as CesiumMath, ScreenSpaceEventHandler, ScreenSpaceEventType } from 'cesium'
import type { Viewer } from 'cesium'
import { AIRLINES_CREDIT, airlineOf } from '../shared/airlines.ts'
import type { Airport } from '../shared/airports.ts'
import type { ChaseResponse, StatusBrief } from '../shared/api.ts'
import { distanceNm } from '../shared/geo.ts'
import { countryOf, flagEmoji } from '../shared/icaoCountry.ts'
import type { AircraftInfo } from '../shared/info.ts'
import type { ReadsbAircraft } from '../shared/types.ts'
import { ApiClient } from './api.ts'
import { BenchRecorder } from './bench/overlay.ts'
import { Fleet } from './browse/fleet.ts'
import { containsDeg, enterBrowse, exitBrowse, viewRectangleDeg } from './scene/browseCamera.ts'
import type { RectDeg } from './scene/browseCamera.ts'
import { ChaseCamera } from './scene/chaseCamera.ts'
import { FleetLayer } from './scene/fleetLayer.ts'
import { makeMapLayer } from './scene/mapLayer.ts'
import { ChaseModel } from './scene/model.ts'
import { makeNightLayer } from './scene/nightLights.ts'
import { addRunways } from './scene/runways.ts'
import { Sun, parseSunParam, sunLook, sunTimeMs } from './scene/sun.ts'
import { Topography, groundMemo, pickRelHM } from './scene/topography.ts'
import { createViewer } from './scene/viewer.ts'
import { MIN_DELAY_S, RenderClock } from './track/delay.ts'
import { TrackRegistry } from './track/registry.ts'
import type { ClientConfig, FleetEntry, ModelManifest, ModelManifestEntry, RenderState, ScenePrefs, TerrainFrame } from './types.ts'
import { mountAttribution, mountBanner } from './ui/banner.ts'
import { mountDetail } from './ui/detail.ts'
import type { Lookup } from './ui/detail.ts'
import { mountHud } from './ui/hud.ts'
import { mountLegend } from './ui/legend.ts'
import { PhotoCache } from './ui/photo.ts'
import { PREFS_KEY, readScenePrefs, writeScenePrefs } from './ui/scenePrefs.ts'
import { mountSceneToggles } from './ui/sceneToggles.ts'
import { mountTable } from './ui/table.ts'
import './ui/layout.css'

const POLL_MS = 1000 // view and chase both poll at 1 Hz; TrackRegistry's pollPeriodS says the same
const PRUNE_AGE_S = 60 // forget an aircraft one minute after its newest sample (FleetLayer hides it at that age too)
const FAILS_DOWN = 3 // failed polls in a row before the banner reports it
const START_HEIGHT_M = 60_000 // ?hex= start: straight down on the hero airport until the chase camera takes over
const MIN_VIEW_NM = 20
const MAX_VIEW_NM = 250 // the server's cap: it polls an area source (adsb.lol) out to this radius
const HOVER_PICK_MS = 100 // at most ten hover picks a second while the mouse moves (each pick is a small render pass)
const HEX = /^~?[0-9a-f]{6}$/
// Until the first reply. Nothing is drawn before it, so the source named here is never shown.
const NO_STATUS: StatusBrief = { source: 'adsblol', degraded: null, cellPeriodP95S: null, chasePeriodP95S: null }
const NO_ENTRIES: readonly FleetEntry[] = []

/** Radius in whole 10 nm steps (so the ApiClient's per-view `since` key survives small changes), clamped to 20–250 nm. */
function viewNm(nm: number): number {
  const r = Math.ceil(nm / 10) * 10
  return Number.isFinite(r) ? Math.min(MAX_VIEW_NM, Math.max(MIN_VIEW_NM, r)) : MAX_VIEW_NM
}

/**
 * Radius of the chase view poll: the camera height in nm (a top-down view shows about ±0.6 h), in 10 nm steps, 20–250 nm.
 * ponytail: a tilted camera sees further than its height; the far part of such a view stays empty until the user looks
 * down. Upgrade: size the circle from the frustum's ground footprint (browseCircle does, for the top-down view).
 */
export function viewRadiusNm(cameraHeightM: number): number {
  return viewNm(cameraHeightM / 1852)
}

const round2 = (deg: number): number => Math.round(deg * 100) / 100
const wrap180 = (lon: number): number => ((((lon + 180) % 360) + 360) % 360) - 180

/**
 * The browse view poll: the circle around the visible rectangle, centred on it (to 0.01°, the ApiClient's key) and
 * reaching its farthest corner (a lat/lon rectangle's farthest point from inside it is a corner), 20–250 nm.
 * A view wider than 500 nm gets the 250 nm around its centre. A rectangle with west > east spans the antimeridian.
 * ponytail: every pan moves the centre, so the first poll after it is a new view key and a full (since=0) reply
 * (~200 KB gzipped for 5,000 aircraft). Upgrade: snap the centre to a grid so small pans keep their key.
 */
export function browseCircle(r: RectDeg): { lat: number; lon: number; nm: number } {
  const spanDeg = r.west <= r.east ? r.east - r.west : r.east + 360 - r.west
  const lat = round2((r.south + r.north) / 2)
  const lon = round2(wrap180(r.west + spanDeg / 2))
  const farNm = Math.max(
    distanceNm(lat, lon, r.south, r.west),
    distanceNm(lat, lon, r.south, r.east),
    distanceNm(lat, lon, r.north, r.west),
    distanceNm(lat, lon, r.north, r.east),
  )
  return { lat, lon, nm: viewNm(farNm) }
}

/**
 * The entries inside r (r null: the globe is out of view), plus the one with keepHex, written into out, which is
 * returned. Allocates nothing. keepHex is the selected aircraft: chasing, it flies in front of the camera but above the
 * ground rectangle the camera sees, which starts beyond it.
 */
export function entriesIn(entries: readonly FleetEntry[], r: RectDeg | null, out: FleetEntry[], keepHex: string | null = null): FleetEntry[] {
  out.length = 0
  if (r === null && keepHex === null) return out
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e.hex === keepHex || (r !== null && containsDeg(r, e.lat, e.lon))) out.push(e)
  }
  return out
}

/** Flag emoji of the country the ICAO address is allocated to; '' when none (non-ICAO '~' address, unallocated block). */
export function flagOf(hex: string): string {
  const c = countryOf(hex)
  return c === null ? '' : flagEmoji(c.iso2)
}

/** Country (from the address) and airline (from the callsign) for the detail panel. countryOf's object is shared: copied. */
export function lookupFor(hex: string, callsign: string | null): Lookup {
  const c = countryOf(hex)
  return { country: c === null ? null : { iso2: c.iso2, name: c.name, flag: flagEmoji(c.iso2) }, airline: airlineOf(callsign) }
}

/**
 * Height for the chased model and camera. hM is the wheels' height (see modelMatrixFor). On the ground the wheels sit on
 * the loaded terrain; in the air they never go below it. terrainM null = tile not loaded yet: keep the estimate.
 * ponytail: terrain, not the runway plane; M4's geometric touchdown replaces this clamp.
 */
export function placedHeightM(hM: number, onGround: boolean, terrainM: number | null): number {
  if (terrainM === null) return hM
  return onGround ? terrainM : Math.max(hM, terrainM)
}

/**
 * The flat plane's height (design D4) for a flatten, or for a new selection while flat: the runway height of a hero airport
 * within 30 km of the aircraft, else the ground under it (groundM: the drawn ground, true at rest), else the plane as it is
 * (relHM). While flat the drawn ground is the old plane everywhere, so a new selection passes groundM null.
 * ponytail: away from the heroes a selection while flat keeps the old plane. Upgrade: sampleTerrainMostDetailed (true
 * heights, async) under the new aircraft, then relatch when it resolves.
 */
export function relHFor(at: { lat: number; lon: number } | null, groundM: number | null, relHM: number, airports: readonly Airport[]): number {
  return at === null ? relHM : pickRelHM(at.lat, at.lon, groundM ?? relHM, airports)
}

/** Where a typed T or L is text, not a toggle (the table's search box). */
const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/**
 * The scene toggle a keydown asks for (design D11): T topography, L sun. null with a modifier (Cmd/Ctrl+L and Ctrl+T are
 * the browser's), on auto-repeat and while typing in a field.
 */
export function sceneKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; repeat: boolean; target: unknown }): keyof ScenePrefs | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return null
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null
  if (t?.isContentEditable || TYPING.has(t?.tagName ?? '')) return null
  const k = e.key.toLowerCase()
  return k === 't' ? 'topo' : k === 'l' ? 'light' : null
}

export interface AppParams {
  hex: string | null // ?hex=a1b2c3: chase this aircraft from the start (G3; the detail panel's "Copy link")
  bench: boolean // ?bench=1: bench overlay and User Timing measures, 'b' downloads the report
  airport: string | null // ?airport=LLBG: first view over this hero (default: the first in heroes.json)
}

export function readParams(search: string): AppParams {
  const q = new URLSearchParams(search)
  const hex = (q.get('hex') ?? '').trim().toLowerCase()
  const airport = (q.get('airport') ?? '').trim().toUpperCase()
  return { hex: HEX.test(hex) ? hex : null, bench: q.get('bench') === '1', airport: airport === '' ? null : airport }
}

/**
 * Credit lines for the attribution box. mountAttribution adds "Not for navigation"; Cesium shows the terrain, imagery and
 * street-map credits on the map itself (the OpenStreetMap one linked, as its tile policy asks). The detail panel credits
 * each photo ("Image © name", linked to its page on planespotters.net).
 */
export function attributionFor(model: ModelManifestEntry | null): string[] {
  const lines = [
    'Flight data © adsb.lol contributors, ODbL 1.0',
    'Airports: OurAirports (public domain)',
    AIRLINES_CREDIT,
    'Map: © OpenStreetMap contributors, ODbL',
    'Photos: planespotters.net, © each photographer',
    'Night lights: NASA GIBS, VIIRS Black Marble', // D13; the full GIBS acknowledgment is in Cesium's credit list
  ]
  // Manifest licences read "<SPDX id>: <note>"; the id is enough on screen.
  if (model) lines.push(`3D model: ${model.author}, ${model.license.split(':')[0].trim()}`)
  return lines
}

/** The server's status, except that FAILS_DOWN failed polls in a row mean we have no live data at all. */
export function statusShown(status: StatusBrief, failedPolls: number): StatusBrief {
  return failedPolls >= FAILS_DOWN ? { ...status, degraded: 'upstream-down' } : status
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return (await res.json()) as T
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function div(className: string, parent: HTMLElement): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className
  parent.append(el)
  return el
}

/**
 * Builds the viewer in root and runs the app until stop(). Loops:
 * - every second: view(browse: the circle around the visible map; chase: around the chased aircraft) and, while an
 *   aircraft is selected, chase(hex). Every sample goes into the Fleet; the selected aircraft's samples also go into the
 *   TrackRegistry, between frames, so re-join blends stay continuous.
 * - every frame (scene.preUpdate: after Cesium applies mouse input to the camera, before it updates primitives and
 *   renders, so camera and model move in the same frame): Topography first (the relief's factor and flat plane for this
 *   frame); Fleet → FleetLayer and table (all aircraft, dead-reckoned to server now); RenderClock → the selected
 *   aircraft's state → model, chase camera; the Sun (clock and light) and the runways; HUD, detail panel, banner, bench.
 * A table row or a click on an icon selects; Esc or the panel's × goes back to browse over the last chased position.
 * The scene toggles (buttons, keys T and L) apply in chase and persist: URL > localStorage > defaults (both on).
 * Runways and the model are optional: if their files fail to load, the app runs without them. createViewer failing
 * (terrain unreachable) rejects.
 */
export async function startApp(root: HTMLElement, cfg: ClientConfig): Promise<{ stop(): void }> {
  const params = readParams(location.search)
  const sunParam = parseSunParam(location.search) // ?sun=<ISO> fixes the sun's time, ?sun=+6h shifts it (demos)
  // The localStorage getter and getItem both throw where storage is blocked: then only the URL and the defaults count.
  let store: Storage | null = null
  let stored: string | null = null
  try {
    store = window.localStorage
    stored = store.getItem(PREFS_KEY)
  } catch {
    // blocked: nothing stored, nothing kept
  }
  let prefs = readScenePrefs(location.search, stored)
  const base = import.meta.env.BASE_URL
  // Topography takes the scene in the task that builds the viewer, before its first frame: moving the factor off 1
  // with tiles loaded rebuilds every tile (PoC: up to 2 s).
  const viewerWithTopography = async (): Promise<[Viewer, Topography]> => {
    const v = await createViewer(root, cfg)
    return [v, new Topography(v.scene, prefs.topo)]
  }
  const [[viewer, topo], airports, manifest] = await Promise.all([
    viewerWithTopography(),
    getJson<Airport[]>(`${base}airports/heroes.json`).catch((e: unknown): Airport[] => {
      console.warn('FlightHopper: no runways:', e)
      return []
    }),
    getJson<ModelManifest>(`${base}models/manifest.json`).catch((e: unknown): null => {
      console.warn('FlightHopper: no model manifest:', e)
      return null
    }),
  ])
  const entry = manifest?.models.find((m) => m.id === manifest.default) ?? null
  const model = entry
    ? await ChaseModel.load(viewer, entry).catch((e: unknown): null => {
        console.warn('FlightHopper: chase model not loaded:', e)
        return null
      })
    : null

  let selected: string | null = params.hex // ?hex= is chased from the start; the camera engages at its first state
  let chased: RenderState | null = null // the selected aircraft as drawn in the last frame that had it
  let groundM: number | null = null // the ground drawn under it (lag-corrected), null while unknown
  // The last terrain readings under the aircraft and under the chase camera, with the points they were read at.
  // Topography.ground rescales them for an undefined reading (Cesium's picker race, in runs during an animation) within
  // 50 m of that point: about the first 0.5 s of a run at 180 kt. Reset on each selection.
  const acGround = groundMemo()
  const camGround = groundMemo()
  let relatchPending = selected !== null // a new selection moves a flat map's plane at its first state (D4)
  let tf: TerrainFrame // this frame's exaggeration: topo.update() writes it first in every frame
  let chaseRaw: ReadsbAircraft | null = null // newest full upstream object and info of the selected aircraft
  let chaseInfo: AircraftInfo | null = null
  let tableHover: string | null = null
  let mapHover: string | null = null
  let status = NO_STATUS
  let failedPolls = 0
  let stopped = false
  let lastFrameMs: number | null = null
  const carto = new Cartographic()
  const sunAt = new Cartesian3() // the chased aircraft, where the sun's elevation is taken
  const runwayLook = sunLook(90) // the runways' light, rewritten every frame
  const onScreen: FleetEntry[] = [] // reused every frame

  // Overlays live in one element so stop() removes them together (mountAttribution returns no handle). layout.css
  // places them; data-mode switches what browse and chase show.
  const ui = div('fh-ui', root)
  ui.dataset.mode = selected === null ? 'browse' : 'chase'
  const right = div('fh-right', ui) // the scene toggles, then the table above the credits
  const toggles = mountSceneToggles(right, { prefs, onChange: (next) => setPrefs(next) })
  const hud = mountHud(ui)
  const banner = mountBanner(ui)
  const detail = mountDetail(ui, { onClose: () => select(null), photos: new PhotoCache(), lookup: lookupFor })
  const table = mountTable(right, { onSelect: (hex) => select(hex), onHover: (hex) => (tableHover = hex), flagOf })
  mountAttribution(right, attributionFor(entry))
  const legend = mountLegend(div('fh-legend-root', ui))
  const runways = addRunways(viewer, airports)
  // The city lights go right above the satellite base layer, under the street map added next (browse shows it on top).
  const day = viewer.imageryLayers.length > 0 ? viewer.imageryLayers.get(0) : null
  const night = makeNightLayer()
  viewer.imageryLayers.add(night)
  const sun = new Sun(viewer, { day, night })
  sun.attachModel(model?.model ?? null)
  sun.setEnabled(selected !== null && prefs.light)
  // VITE_MAP_URL: another tile server ({z}/{x}/{y}.png is appended), as the OpenStreetMap tile policy asks to allow.
  const mapUrl: string | undefined = import.meta.env.VITE_MAP_URL?.trim() || undefined
  const map = makeMapLayer(viewer, mapUrl)
  const fleetLayer = new FleetLayer(viewer)
  const globe = viewer.scene.globe
  // Clearance above the ground drawn this frame: globe.getHeight answers last frame's while the relief grows or sinks.
  const chaseCam = new ChaseCamera(viewer, { groundAt: (c) => topo.ground(globe.getHeight(c), tf, camGround, c) })
  const api = new ApiClient(cfg.apiBase)
  const fleet = new Fleet()
  let registry = new TrackRegistry({ pollPeriodS: POLL_MS / 1000 })
  const clock = new RenderClock(MIN_DELAY_S)
  const bench = params.bench ? new BenchRecorder(viewer, { label: params.hex ?? 'browse' }) : null
  bench?.mountOverlay(div('fh-bench', ui))
  // ?bench=1: User Timing measures fh:frame, fh:fleet, fh:table (each frame) and fh:ingest (each poll), and two marks
  // under the chased aircraft for gate GE: fh:no-ground for each undefined terrain reading, and fh:ground-unknown for
  // each frame whose ground is still unknown after the memo. Read them with performance.getEntriesByName(name) or in
  // DevTools. ponytail: entries pile up (~200 per second) until performance.clearMeasures(); fine for runs of minutes.
  const measure = bench === null ? null : (name: string, startMs: number): void => void performance.measure(name, { start: startMs })
  ;(window as unknown as { viewer?: Viewer }).viewer = viewer // console access for debugging and G3, as in WP-00

  const home = airports.find((a) => a.ident === params.airport) ?? airports[0]
  const homeCenter = home ? { lat: home.lat, lon: home.lon } : null
  if (selected === null) enterBrowse(viewer, homeCenter, { flyS: 0 })
  else {
    map.show = false
    if (home) viewer.camera.setView({ destination: Cartesian3.fromDegrees(home.lon, home.lat, START_HEIGHT_M) })
  }

  /** Browse ↔ chase. The camera leaves browse at once and engages behind the aircraft at its first state. */
  function select(hex: string | null): void {
    if (hex === selected) return
    const last = chased
    chaseCam.release() // hands the mouse back to Cesium's controls; the next chase starts behind its aircraft
    selected = hex
    chased = null
    groundM = null
    acGround.ok = camGround.ok = false // the next readings are under another aircraft
    relatchPending = hex !== null
    chaseRaw = null
    chaseInfo = null
    // Only the selected aircraft is estimated: a fresh registry, seeded with the newest sample the fleet has of it.
    registry = new TrackRegistry({ pollPeriodS: POLL_MS / 1000 })
    if (hex !== null) {
      const seed = fleet.newest(hex)
      if (seed) registry.ingest([seed])
      exitBrowse(viewer) // restores tilt and zoom limits; nothing when already chasing
      map.show = false
    } else {
      map.show = true
      enterBrowse(viewer, last) // over the last chased position, else where the camera is
    }
    sun.setEnabled(hex !== null && prefs.light) // chase only (D9): browse stays the unlit street map
    ui.dataset.mode = hex === null ? 'browse' : 'chase'
  }

  /** Every scene-toggle change, from a button or a key: apply it, store it, show it. */
  function setPrefs(next: ScenePrefs): void {
    if (next.topo !== prefs.topo) topo.set(next.topo, performance.now(), relHFor(chased, groundM, topo.relHM, airports))
    prefs = next
    sun.setEnabled(selected !== null && next.light)
    writeScenePrefs(next, store)
    toggles.update(next)
  }

  function frame(): void {
    const now = performance.now()
    tf = topo.update(now) // first: the factor and plane drawn this frame, before any terrain reading
    const dtS = lastFrameMs === null ? 0 : Math.min(1, (now - lastFrameMs) / 1000)
    lastFrameMs = now
    const shown = statusShown(status, failedPolls)
    let all = NO_ENTRIES
    let s: RenderState | null = null
    let tSunMs = Date.now() // until the first reply; then the render time (server clock)
    if (api.ready) {
      const tServerMs = api.serverNowMs()
      const tRenderMs = clock.tick(tServerMs, registry.delayTargetS(selected), dtS)
      tSunMs = tRenderMs
      // ponytail: the fleet is drawn at server now, the chased aircraft at the delayed render time (≥ 3 s earlier), so
      // traffic around it runs a few seconds ahead of it. Upgrade: draw the fleet at tRenderMs, which needs Fleet to
      // interpolate between samples instead of only dead-reckoning past the newest.
      all = fleet.entries(tServerMs)
      if (selected !== null) s = registry.get(selected)?.stateAt(tRenderMs) ?? null
    }
    fleetLayer.setTerrain(tf) // ground icons follow the grow and sink
    fleetLayer.update(all, selected, tableHover ?? mapHover)
    const tTable = measure === null ? 0 : performance.now()
    measure?.('fh:fleet', now)
    table.update(all, entriesIn(all, viewRectangleDeg(viewer), onScreen, selected), selected) // re-sorts ≤ 1 Hz itself
    measure?.('fh:table', tTable)
    let clearanceM: number | null = null
    let sunWC = viewer.camera.positionWC // browse, or no state yet: the sun where the camera is
    if (s !== null) {
      if (relatchPending && !topo.animating) {
        relatchPending = false
        topo.relatch(relHFor(s, null, topo.relHM, airports)) // takes effect only while the map is flat
      }
      const sampled = globe.getHeight(Cartographic.fromDegrees(s.lon, s.lat, 0, carto))
      if (sampled === undefined && bench !== null) performance.mark('fh:no-ground')
      // undefined (Cesium's picker race, during an animation and before the nudge): the last reading, rescaled to this
      // frame's factor, while the aircraft is within 50 m of where it was read. null before the first reading (tiles
      // not loaded), after a new plane, farther than 50 m, and in a grow while the last reading is a flat one (it holds
      // no relief): the estimate stays.
      groundM = topo.ground(sampled, tf, acGround, carto)
      if (groundM === null && bench !== null) performance.mark('fh:ground-unknown')
      const placed: RenderState = { ...s, hM: placedHeightM(s.hM, s.onGround, groundM) }
      model?.update(placed)
      clearanceM = chaseCam.update(placed, dtS).clearanceM
      chased = placed
      sunWC = Cartesian3.fromDegrees(placed.lon, placed.lat, placed.hM, Ellipsoid.WGS84, sunAt)
    }
    // Every frame, in both modes (off, it keeps the fixed light above the camera). Replays are lit at their recording
    // time (D12): the server reports how far its clock is ahead of the upstream's.
    const st = sun.update(sunTimeMs(tSunMs, sunParam, status.upstreamOffsetMs ?? 0), sunWC)
    runways.update(tf)
    // The planes darken with the terrain under the Sun (WP-E3); off (browse, the toggle off) they stay as built. Three
    // numbers written in place, so it runs every frame.
    runways.setLight(selected !== null && prefs.light && st !== null ? sunLook(st.elevDeg, runwayLook) : null)
    // No state (before the first samples, pruned, or a gap > 2 min): the model goes; the camera stays put.
    if (model) model.show = s !== null
    hud.update(s, shown)
    // The panel shows as soon as something is known: identity from the fleet before the chase reply and first state.
    detail.update(s, chaseRaw, chaseInfo ?? (selected === null ? null : (fleet.get(selected)?.info ?? null))) // ≤ 4 Hz
    banner.update(shown, s)
    bench?.frame(s, clearanceM)
    measure?.('fh:frame', now)
  }
  const removeFrame = viewer.scene.preUpdate.addEventListener(frame)

  /** Centre and radius of the view poll: browse, around the visible map; else the chased aircraft, else the globe point at the canvas centre, else below the camera. */
  function viewCircle(): { lat: number; lon: number; nm: number } {
    if (selected === null) {
      const r = viewRectangleDeg(viewer)
      if (r !== null) return browseCircle(r)
    }
    const cam = viewer.camera.positionCartographic
    const nm = viewRadiusNm(cam.height)
    const round = (deg: number): number => Math.round(deg * 1e4) / 1e4
    if (chased !== null) return { lat: round(chased.lat), lon: round(chased.lon), nm }
    const c = viewer.canvas
    const hit = viewer.camera.pickEllipsoid(new Cartesian2(c.clientWidth / 2, c.clientHeight / 2))
    const g = (hit && Cartographic.fromCartesian(hit)) ?? cam
    return { lat: round(CesiumMath.toDegrees(g.latitude)), lon: round(CesiumMath.toDegrees(g.longitude)), nm }
  }

  async function poll(): Promise<void> {
    const hex = selected
    const v = viewCircle()
    const noChase: Promise<ChaseResponse | null> = Promise.resolve(null)
    const [view, chase] = await Promise.allSettled([api.view(v.lat, v.lon, v.nm), hex === null ? noChase : api.chase(hex)])
    if (stopped) return
    const t0 = measure === null ? 0 : performance.now()
    const current = hex !== null && hex === selected // a reply for an earlier selection only feeds the fleet
    let ok = false
    if (view.status === 'fulfilled') {
      const r = view.value
      fleet.ingest(r.samples, r.info)
      if (current) registry.ingest(r.samples.filter((x) => x.hex === hex))
      status = r.status
      ok = true
    }
    if (chase.status === 'fulfilled' && chase.value !== null) {
      const r = chase.value
      fleet.ingest(r.samples, r.info ? [r.info] : undefined)
      if (current) {
        registry.ingest(r.samples)
        chaseRaw = r.raw ?? chaseRaw
        chaseInfo = r.info ?? chaseInfo
      }
      status = r.status
      ok = true
    }
    measure?.('fh:ingest', t0)
    if (ok) failedPolls = 0
    else if (failedPolls++ === 0) console.warn('FlightHopper: poll failed:', (view as PromiseRejectedResult).reason)
    if (api.ready) {
      const t = api.serverNowMs()
      fleet.prune(t, PRUNE_AGE_S)
      registry.prune(t, PRUNE_AGE_S)
    }
  }

  void (async () => {
    while (!stopped) {
      const t0 = performance.now()
      await poll().catch((e: unknown) => console.error('FlightHopper: poll crashed:', e))
      await sleep(Math.max(0, POLL_MS - (performance.now() - t0)))
    }
  })()

  // Cesium's default double-click tracks an entity (the runway markers are entities), which would fight the chase camera.
  viewer.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
  const mouse = new ScreenSpaceEventHandler(viewer.scene.canvas)
  mouse.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
    const hex = fleetLayer.pick(e.position)
    if (hex !== null) select(hex)
  }, ScreenSpaceEventType.LEFT_CLICK)
  // Hover over an icon: its callsign label and a pointer cursor. Picks at most every HOVER_PICK_MS, at the newest position.
  const mousePos = new Cartesian2()
  let hoverTimer: ReturnType<typeof setTimeout> | null = null
  let lastPickMs = -Infinity
  const pickHover = (): void => {
    hoverTimer = null
    lastPickMs = performance.now()
    const hex = fleetLayer.pick(mousePos)
    if (hex === mapHover) return
    mapHover = hex
    viewer.canvas.style.cursor = hex === null ? '' : 'pointer'
  }
  mouse.setInputAction((m: ScreenSpaceEventHandler.MotionEvent) => {
    Cartesian2.clone(m.endPosition, mousePos)
    hoverTimer ??= setTimeout(pickHover, Math.max(0, lastPickMs + HOVER_PICK_MS - performance.now()))
  }, ScreenSpaceEventType.MOUSE_MOVE)
  const onLeave = (): void => {
    if (hoverTimer !== null) clearTimeout(hoverTimer)
    hoverTimer = null
    mapHover = null
    viewer.canvas.style.cursor = ''
  }
  viewer.canvas.addEventListener('pointerleave', onLeave) // onto the table or panel, or out of the window
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') select(null)
    else if ((e.key === 'b' || e.key === 'B') && bench) bench.download()
    else if (selected !== null) {
      const k = sceneKey(e) // the toggles belong to chase, like their buttons (D9, D11)
      if (k !== null) setPrefs({ ...prefs, [k]: !prefs[k] })
    }
  }
  window.addEventListener('keydown', onKey)

  return {
    stop(): void {
      if (stopped) return
      stopped = true
      removeFrame()
      window.removeEventListener('keydown', onKey)
      viewer.canvas.removeEventListener('pointerleave', onLeave)
      if (hoverTimer !== null) clearTimeout(hoverTimer)
      mouse.destroy()
      bench?.destroy()
      toggles.destroy()
      hud.destroy()
      banner.destroy()
      detail.destroy()
      table.destroy()
      legend.destroy()
      ui.remove()
      chaseCam.release()
      exitBrowse(viewer)
      model?.destroy()
      fleetLayer.destroy()
      map.destroy()
      viewer.imageryLayers.remove(night) // and destroys it
      runways.destroy()
      viewer.destroy()
      delete (window as unknown as { viewer?: Viewer }).viewer
    },
  }
}
```

Change list, applied in this order to today's `client/app.ts` (WP-B-A's):
1. **Header comment.** After "The other aircraft stay on screen as icons.", add: "The sun lights the chase view, and the relief can sink into the map and grow back (toggles "3-D terrain" and "Sun", keys T and L)."
2. **Imports.**
   - The `cesium` import adds `Ellipsoid`.
   - After `./scene/model.ts`, import `makeNightLayer` from `./scene/nightLights.ts`.
   - After `./scene/runways.ts`, import `Sun, parseSunParam, sunTimeMs` from `./scene/sun.ts` and `Topography, groundMemo, pickRelHM` from `./scene/topography.ts`.
   - The `./types.ts` type import adds `ScenePrefs, TerrainFrame`.
   - After `./ui/photo.ts`, import `PREFS_KEY, readScenePrefs, writeScenePrefs` from `./ui/scenePrefs.ts` and `mountSceneToggles` from `./ui/sceneToggles.ts`.
3. **Helpers.** After `placedHeightM`, add `relHFor`, the `TYPING` set and `sceneKey`, as in the file above.
4. **`attributionFor`.** After `'Photos: planespotters.net, © each photographer',`, add `'Night lights: NASA GIBS, VIIRS Black Marble',` with its comment.
5. **`startApp`'s doc comment.** Replace the "every frame" bullet with the new order: Topography first, and the Sun and the runways after the chase camera. Add the sentence about the scene toggles.
6. **The start of `startApp`.**
   - After `const params = readParams(location.search)`, add `sunParam`, the guarded storage read (`store`, `stored`) and `let prefs = readScenePrefs(…)`.
   - Before the `Promise.all`, define `viewerWithTopography`. Replace `createViewer(root, cfg),` with `viewerWithTopography(),`, and destructure `const [[viewer, topo], airports, manifest]`.
7. **State.** After `let chased …`, add `groundM`, the two ground memos `acGround` and `camGround` with their comment, `relatchPending` and `let tf: TerrainFrame`. After `const carto = new Cartographic()`, add `sunAt`.
8. **Toggles.** On the line after `const right = div('fh-right', ui)`, before `mountTable`, mount the toggles. Change that line's comment to "the scene toggles, then the table above the credits".
9. **Sun.** After `const runways = addRunways(viewer, airports)`, before the `VITE_MAP_URL` comment and `makeMapLayer`, add the night layer and the Sun: `day`, `night`, `viewer.imageryLayers.add(night)`, `new Sun(…)`, `attachModel`, `setEnabled`.
10. **Chase camera.** Replace `const chaseCam = new ChaseCamera(viewer)` with `const globe = viewer.scene.globe`, its comment, and the `groundAt` constructor call (through `camGround`, with the point `c` as `ground()`'s fourth argument).
11. **Bench comment.** The `?bench=1` comment also names the `fh:no-ground` and `fh:ground-unknown` marks.
12. **`select()`.** After `chased = null`, add `groundM = null`, the reset of both memos (`acGround.ok = camGround.ok = false`) and `relatchPending = hex !== null`. Before `ui.dataset.mode = …`, add `sun.setEnabled(hex !== null && prefs.light)`. After `select()`, add `setPrefs`.
13. **`frame()`.**
    - After `const now = performance.now()`, add `tf = topo.update(now)`.
    - Before `if (api.ready)`, add `let tSunMs = Date.now()`. After the `clock.tick` line, add `tSunMs = tRenderMs`.
    - Before `fleetLayer.update(…)`, add `fleetLayer.setTerrain(tf)`.
    - After `let clearanceM`, add `let sunWC = viewer.camera.positionWC`.
    - In the `if (s !== null)` block, replace the `terrainM` and `placed` lines with the relatch, the reading, the `fh:no-ground` mark, `groundM` (through `acGround`, with `carto` as `ground()`'s fourth argument), the `fh:ground-unknown` mark and the new `placed`. After `chased = placed`, add the `sunWC` line.
    - After the block, add the `sun.update(…)` comment and call, then `runways.update(tf)`.
14. **`onKey`.** After the `b` branch, add the `else if (selected !== null)` branch.
15. **`stop()`.** After `bench?.destroy()`, add `toggles.destroy()`. After `map.destroy()`, add `viewer.imageryLayers.remove(night)`.
16. **Runway light (WP-E3's `setLight`).**
    - The `./scene/sun.ts` import (step 2) also takes `sunLook`, between `parseSunParam` and `sunTimeMs`.
    - After `const sunAt = …` (step 7), add `const runwayLook = sunLook(90)` with its comment.
    - In `frame()`, keep `sun.update(…)`'s result: `const st = sun.update(…)`. After `runways.update(tf)` (step 13), add the two-line comment and `runways.setLight(selected !== null && prefs.light && st !== null ? sunLook(st.elevDeg, runwayLook) : null)`.

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/app.test.ts`
Expected: PASS with `ℹ tests 12`, `ℹ pass 12`, `ℹ fail 0`.

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add client/app.ts client/app.test.ts
git commit -m "feat(client): terrain and sun in the app — topography, sun, scene toggles, keys T and L" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Layout: the toggles in chase, and the phone panel below them

**Files:**
- Modify: `client/ui/layout.css`. The complete new contents are below, followed by a change list.
- Test: `npx vite build`, then a grep of the bundled CSS. CSS has no unit test.

**Interfaces:**
- Consumes: `.fh-toggles` (WP-E4 `sceneToggles.css`), `.fh-detail` (WP-B-U2 `detail.css`), `.fh-hud` (`ui.css`), the column from Task 1 (the toggles as the first child of `.fh-right`, the GIBS line in the credits).
- Produces: in browse the toggles are hidden. On phones in chase the panel starts at 52 px, below the toggles, and the HUD sits one credit row higher (`bottom: 220px`), above the taller credits box.

- [ ] **Step 1: Write the check**

It builds the client and prints the browse rule for the toggles and the phone rules for the HUD and the panel in chase, as Vite minifies them.

```bash
npx vite build && grep -oE '\.fh-ui\[data-mode=browse\] \.fh-toggles\{display:none\}|\.fh-ui\[data-mode=chase\] \.fh-(hud|detail)\{[^}]*\}' dist/assets/*.css
```

- [ ] **Step 2: Run it to verify it fails**

Run: the check above.
Expected: FAIL. The build succeeds, but only the old HUD and panel rules print: no toggles rule, the HUD at 204 px, and no `top`.
```
.fh-ui[data-mode=chase] .fh-hud{bottom:204px}
.fh-ui[data-mode=chase] .fh-detail{max-height:max(120px,100% - 392px)}
```

- [ ] **Step 3: Write the layout**

File: `client/ui/layout.css`
```css
/* client/ui/layout.css */
/* Where the overlays sit (WP-B-A, WP-E-A). client/app.ts builds:
     .fh-ui[data-mode=browse|chase]
       .fh-right        the scene toggles (sceneToggles.css, chase only), the aircraft table (table.css) and the credit
                        box (ui.css), one column on the right
       .fh-legend-root  the altitude legend (legend.ts), bottom centre of the space left of that column
       .fh-bench        the ?bench=1 overlay (bench/overlay.ts)
       + the HUD and banner (ui.css) and the detail panel (detail.css), which place themselves.
   Browse shows the table and the legend. Chase shows the detail panel top-left and the HUD bottom-left (the panel stops
   236px above the bottom, so they never meet), the scene toggles at the top of the column, and keeps the table. Every
   box clears Cesium's credit line (bottom-left) and its fullscreen button (29px, bottom-right). Loaded after the
   modules' own CSS; the selectors are also more specific, so the order does not matter. */

.fh-right {
  position: absolute;
  z-index: 10;
  top: 8px;
  right: 8px;
  bottom: 36px;
  width: min(420px, calc(100vw - 16px));
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  pointer-events: none; /* the empty part of the column stays map */
}

/* The table fills the column above the credits instead of the whole height (table.css places it alone). */
.fh-right > .fh-table {
  position: relative;
  top: auto;
  right: auto;
  bottom: auto;
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
  pointer-events: auto;
}

.fh-right > .fh-table.fh-collapsed {
  flex: none;
  width: auto;
}

.fh-right > .fh-attribution {
  position: relative;
  right: auto;
  bottom: auto;
  flex: none;
  margin-top: auto; /* stays at the bottom when the table is collapsed */
}

/* The scene toggles head the column (the first child) in chase. Browse is the unlit top-down map (D9, D11). */
.fh-ui[data-mode='browse'] .fh-toggles {
  display: none;
}

.fh-legend-root {
  position: absolute;
  z-index: 9;
  left: 8px;
  right: calc(min(420px, 100vw - 16px) + 16px);
  bottom: 32px;
  display: flex;
  justify-content: center;
  pointer-events: none;
}

.fh-ui[data-mode='chase'] .fh-legend-root {
  display: none;
}

/* The bench overlay places itself top-left with inline styles, where the detail panel is: move it right of the panel. */
.fh-bench > pre {
  left: 316px !important;
}

/* Phones: Cesium's credit block wraps to about three lines (~64px), so the legend sits 72px up and the column (table
   above the credits, full width: collapse the table to see the map) ends above the legend. The credits use the full
   width (half the lines, ~139px with the night-lights line). Chasing (no legend), the panel (top, detail.css) and the
   HUD need the screen: the table hides, the credits drop to the legend's place, the HUD sits 8px above them (72px +
   ~139px + 8px, rounded to 220px) and the panel stops 8px above the HUD (~172px tall). The panel spans the width there,
   so it starts below the scene toggles (8px + 38px + the column's 6px gap) and its height leaves 452px (52px + 220px +
   172px + 8px). Not above the credits instead: on a 375px screen the toggles (~166px) would share a row with the HUD
   (180–250px). */
@media (max-width: 640px) {
  .fh-right {
    bottom: 108px;
  }

  .fh-right > .fh-attribution {
    max-width: none;
  }

  .fh-legend-root {
    right: 8px;
    bottom: 72px;
  }

  .fh-ui[data-mode='chase'] .fh-right {
    bottom: 72px;
  }

  .fh-ui[data-mode='chase'] .fh-right > .fh-table {
    display: none;
  }

  .fh-ui[data-mode='chase'] .fh-hud {
    bottom: 220px;
  }

  .fh-ui[data-mode='chase'] .fh-detail {
    top: 52px;
    max-height: max(120px, calc(100% - 452px));
  }
}
```

Change list, applied to today's `client/ui/layout.css`:
1. **Header comment.** The `.fh-right` line names the scene toggles first ("the scene toggles (sceneToggles.css, chase only), the aircraft table (table.css) and the credit box (ui.css)"). The chase sentence adds "the scene toggles at the top of the column". Rewrap the comment.
2. **Browse rule.** After the `.fh-right > .fh-attribution` rule, add the comment and `.fh-ui[data-mode='browse'] .fh-toggles { display: none; }`.
3. **Phone comment.** The credits' height becomes "~139px with the night-lights line". "the HUD sits above them and the panel stops above the HUD" gains the numbers (the HUD 8px above the credits, 72px + ~139px + 8px, rounded to 220px; the panel 8px above the HUD, ~172px tall). Append the sentences on the panel below the toggles (its height leaves 452px) and on why the toggles do not sit above the credits. Rewrap the comment.
4. **Phone rules.** In `@media (max-width: 640px)`, change `.fh-ui[data-mode='chase'] .fh-hud`'s `bottom` from `204px` to `220px`. In `.fh-ui[data-mode='chase'] .fh-detail`, add `top: 52px;`, and change the `max-height` to `max(120px, calc(100% - 452px))`.

- [ ] **Step 4: Run it to verify it passes**

Run: the check from Step 1.
Expected: PASS. The three rules print:
```
.fh-ui[data-mode=browse] .fh-toggles{display:none}
.fh-ui[data-mode=chase] .fh-hud{bottom:220px}
.fh-ui[data-mode=chase] .fh-detail{max-height:max(120px,100% - 452px);top:52px}
```
`dist/` is gitignored.

- [ ] **Step 5: Commit**

```bash
git add client/ui/layout.css
git commit -m "feat(ui): scene toggles at the top of the column in chase; phone panel below them, HUD above the credits" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Synthetic LOWI replay for gate GE

**Files:**
- Create: `.planning/plans/assets/WP-E-A/gen-synthetic-lowi.ts`
- Output (gitignored, never committed): `data/recordings/synthetic-lowi.jsonl`
- Test: a read-back through `server/recording.ts` (Step 1)

**Interfaces:**
- Consumes:
  - `bearingDeg`, `destination`, `distanceNm` (WP-00 `shared/geo.ts`) and `geoidN` (WP-00 `shared/geoid.ts`).
  - It writes the `RecordLine` format (WP-00 `server/recording.ts`) with adsb.lol v2 bodies, which `makeReplay` (S2) reads through `REPLAY_FILES`.
  - The LOWI thresholds of runways 26 and 08 are copied from `public/airports/heroes.json` (WP-T1).
- Produces: `node .planning/plans/assets/WP-E-A/gen-synthetic-lowi.ts [out]` (default `data/recordings/synthetic-lowi.jsonl`) and the aircraft `000e01` (SYN601, to chase), `000e02`, `000e03` and `000e04`.

- [ ] **Step 1: Write the check**

It reads the replay back the way the server does, and prints the chased aircraft's ridge crossing, touchdown and stop (the first sample at 0 kt; later samples are its 5-second position reports), and the heading it keeps once stopped.

```bash
node --input-type=module -e "
const { readRecording, recordingToSamples } = await import('./server/recording.ts')
const s = recordingToSamples(readRecording('data/recordings/synthetic-lowi.jsonl'))
const a = s.filter((x) => x.hex === '000e01')
const t = (x) => Math.round((x.tMs - a[0].tMs) / 1000)
const ridge = a.reduce((b, x) => (Math.abs(x.lat - 47.3125) < Math.abs(b.lat - 47.3125) ? x : b))
const td = a.find((x) => x.onGround)
const stop = a.find((x) => x.gsKt === 0)
console.log('samples', s.length, 'aircraft', new Set(s.map((x) => x.hex)).size, 'SYN601', a.length)
console.log('ridge', t(ridge), 's', Math.round(ridge.altGeomFt * 0.3048), 'm HAE; touchdown', t(td), 's at', td.lat, td.lon, 'track', td.trackDeg, '; stops', t(stop), 's, heading', a.at(-1).trueHeadingDeg)
"
```

- [ ] **Step 2: Run it to verify it fails**

Run: the check above.
Expected: FAIL with `Error: ENOENT: no such file or directory, open 'data/recordings/synthetic-lowi.jsonl'` (from `readRecording`, `server/recording.ts:29`).

- [ ] **Step 3: Write the generator**

File: `.planning/plans/assets/WP-E-A/gen-synthetic-lowi.ts`
```ts
// .planning/plans/assets/WP-E-A/gen-synthetic-lowi.ts
// Synthetic Innsbruck replay for gate GE (terrain & sun): 600 adsb.lol-style polls (RecordLine JSONL, 1 Hz, 40 nm around
// LOWI) holding four invented aircraft. Run from the repository root:
//   node .planning/plans/assets/WP-E-A/gen-synthetic-lowi.ts [out]      (default data/recordings/synthetic-lowi.jsonl)
//   ADSB_SOURCE=replay REPLAY_FILES=data/recordings/synthetic-lowi.jsonl RECORD_DIR= npm run server
// data/recordings/ is gitignored: the output is never committed; this script is its source.
// Deterministic (fixed epoch, no randomness): every run writes the same bytes. Same conventions as WP-A2's
// gen-synthetic-ksfo.ts: unallocated ICAO addresses 000e01–000e04, SYN callsigns, invalid N-numbers (N0…), heights in
// WGS84 ellipsoidal metres (HAE, alt_geom with ADS-B version 2; alt_baro from the EGM96 geoid and the QNH). Runway 26 is
// from public/airports/heroes.json (WP-T1, 2026-09-22).
// SYN601 (?hex=000e01) is the one to chase: over the Karwendel from the north, across the Nordkette ridge at 2,700 m HAE
// (the ridge is 2,350 m there), a left turn onto a downwind east along the Inn valley, a right turn onto the runway 26
// final, a 3° glide path, touchdown and rollout. Its terrain clearance was checked against Re:Earth (plan WP-E-A).
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { bearingDeg, destination, distanceNm } from '../../../../shared/geo.ts'
import { geoidN } from '../../../../shared/geoid.ts'

const T0_MS = Date.UTC(2026, 8, 22, 10, 0, 0) // 12:00 CEST: the replay is lit at this time (D12), sun ~41° high
const POLLS = 600
const DT = 0.02 // s, integration step
const T_MIN = -2 // s: the first poll's positions are up to 1 s old
const KT = 1852 / 3600 // m/s per knot
const FT = 0.3048
const FPM = FT / 60 // m/s per ft/min
const RAD = Math.PI / 180
const QNH = 1016.0 // hPa (ADS-B reports QNH in 0.8 hPa steps: 1016.0 is one)
const TAN3 = Math.tan(3 * RAD)
const TURN_DEG_S = 3 // standard rate
const LOWI = { lat: 47.260201, lon: 11.344 } // heroes.json reference point: the poll centre
const RWY_26 = { lat: 47.26160049438477, lon: 11.357000350952148, hdg: 261, haeM: 625.72 } // landing threshold
const RWY_08 = { lat: 47.258945864390505, lon: 11.332252515916366, haeM: 629.72 } // the far threshold
/** The runway rises 4 m towards 08 (m per m): the flare and the rollout follow it. */
const RWY_RISE = (RWY_08.haeM - RWY_26.haeM) / (distanceNm(RWY_26.lat, RWY_26.lon, RWY_08.lat, RWY_08.lon) * 1852)
const OUT_CRS = 81 // the final approach course seen from the threshold (reciprocal of 261)
const NORDKETTE = { lat: 47.3125, lon: 11.3864 } // Hafelekar, 2,345 m HAE (Re:Earth)
const PASS_HAE = 2700 // over the ridge
const DOWNWIND_HAE = 1450 // level until the glide path comes down to it (~15 km out: intercepted from below)
const TURN_R = (160 * KT) / (TURN_DEG_S * RAD) // 1,572 m: the base turn's radius at 160 kt
const BASE_AT = 16_000 // m from the threshold along the final course where the base turn starts
const X_FLARE = 5 / TAN3 // m past the threshold: glide path 15 m (50 ft) over it, flare from 10 m
const X_TD = X_FLARE + 400

/** One point of a flight path. h: WGS84 ellipsoidal metres, null = on the ground. trk null = no valid track (stationary). */
interface Row {
  t: number
  lat: number
  lon: number
  h: number | null
  v: number // ground speed, m/s
  trk: number | null
  vs: number // m/s
}

const frac = (x: number): number => x - Math.floor(x)
const lerp = (a: number, b: number, u: number): number => a + (b - a) * Math.min(1, Math.max(0, u))
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const wrap360 = (d: number): number => ((d % 360) + 360) % 360
const wrap180 = (d: number): number => wrap360(d + 180) - 180
/** x to a multiple of step; steps below 1 divide by an integer so 0.1 prints as 0.1, not 0.30000000000000004. */
const round = (x: number, step: number): number => (step < 1 ? Math.round(x / step) / Math.round(1 / step) : Math.round(x / step) * step)
/** Deterministic noise in [−1, 1]. */
const noise = (i: number, k: number): number => 2 * frac(Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) - 1

function run(step: (t: number) => Row): Row[] {
  const rows: Row[] = []
  for (let n = 0; T_MIN + n * DT <= POLLS + 2; n++) rows.push(step(T_MIN + n * DT))
  return rows
}

/** Linear interpolation between integration rows (track from the earlier row). */
function at(rows: Row[], t: number): Row {
  const k = Math.min(rows.length - 2, Math.max(0, Math.floor((t - T_MIN) / DT)))
  const [a, b] = [rows[k], rows[k + 1]]
  const u = (t - a.t) / DT
  const h = a.h === null || b.h === null ? (u < 0.5 ? a.h : b.h) : lerp(a.h, b.h, u)
  return { t, lat: lerp(a.lat, b.lat, u), lon: lerp(a.lon, b.lon, u), h, v: lerp(a.v, b.v, u), trk: a.trk, vs: lerp(a.vs, b.vs, u) }
}

/** Metres along the final approach course out from the runway 26 threshold, and to its right (south: positive). */
function finalFrame(lat: number, lon: number): { along: number; cross: number } {
  const d = distanceNm(RWY_26.lat, RWY_26.lon, lat, lon) * 1852
  const b = (bearingDeg(RWY_26.lat, RWY_26.lon, lat, lon) - OUT_CRS) * RAD
  return { along: d * Math.cos(b), cross: d * Math.sin(b) }
}

/** Height above the threshold on the 3° glide path, flare and touchdown (as WP-A2's 28R arrival); null = on the ground. */
function glideAbove(x: number): number | null {
  if (x <= X_FLARE) return 15 - x * TAN3
  if (x >= X_TD) return null
  const u = (x - X_FLARE) / 400
  const [m0, m1] = [-TAN3 * 400, -0.15 * TAN3 * 400] // cubic Hermite: 10 m → 0 m, slope −3° → −0.45°
  return 10 * (2 * u ** 3 - 3 * u ** 2 + 1) + m0 * (u ** 3 - 2 * u ** 2 + u) + m1 * (u ** 3 - u ** 2)
}

/** HAE on the glide path x metres past the threshold (negative on final), over the rising runway; null = on the ground. */
function pathHae(x: number): number | null {
  const g = glideAbove(x)
  return g === null ? null : RWY_26.haeM + Math.max(0, x) * RWY_RISE + g
}

/** Turns trk towards cmd at the standard rate; returns the new track. */
const steer = (trk: number, cmd: number): number => wrap360(trk + clamp(wrap180(cmd - trk), -TURN_DEG_S * DT, TURN_DEG_S * DT))

// ---------- SYN601: A320 across the Nordkette, downwind in the Inn valley, runway 26 ----------
// A right-hand circuit flown by a small autopilot: the downwind is 2·TURN_R left of the final course, so a 180° standard
// rate turn at 160 kt ends on it. The cross-track laws (30° per km, at most 45°) settle in ~20 s without overshoot.
function arrival(): Row[] {
  let { lat, lon } = destination(NORDKETTE.lat, NORDKETTE.lon, 348, 7000 / 1852) // 7 km before the ridge, on 168°
  let h: number | null = 2950
  let v = 180 * KT
  let trk = 168
  let vs = 0
  let phase: 'pass' | 'downwind' | 'base' | 'final' | 'ground' = 'pass'
  return run((t) => {
    const { along, cross } = finalFrame(lat, lon)
    const row: Row = { t, lat, lon, h, v, trk: v > 0 ? trk : null, vs }
    let hNext = h
    if (phase === 'pass') {
      // 2,950 → 2,700 m over the 7 km to the ridge (−650 fpm), then down the south face into the valley
      vs = -(250 / 7000) * v
      if (distanceNm(lat, lon, NORDKETTE.lat, NORDKETTE.lon) * 1852 < 50) phase = 'downwind'
    } else if (phase === 'downwind') {
      trk = steer(trk, OUT_CRS + clamp(-0.03 * (cross + 2 * TURN_R), -45, 45))
      vs = h! > DOWNWIND_HAE ? -1500 * FPM : 0
      if (along > 10_000) v = Math.max(160 * KT, v - 0.5 * DT) // slow to the base-turn speed
      if (along >= BASE_AT) phase = 'base'
    } else if (phase === 'base') {
      trk = wrap360(trk + TURN_DEG_S * DT) // right turn, 081 → 261
      vs = h! > DOWNWIND_HAE ? -1500 * FPM : 0
      if (wrap180(trk - RWY_26.hdg) >= 0) {
        trk = RWY_26.hdg
        phase = 'final'
      }
    } else if (phase === 'final') {
      trk = steer(trk, RWY_26.hdg + clamp(0.03 * cross, -30, 30))
      const x = -along // metres past the threshold
      if (along > 12_000) v = 160 * KT
      else if (along > 7000) v = lerp(138, 160, (along - 7000) / 5000) * KT // 160 → 138 kt from 12 to 7 km out
      else if (x <= X_FLARE) v = 138 * KT
      else v = lerp(138, 132, (x - X_FLARE) / 400) * KT // bleeds 6 kt in the flare
      const onPath = pathHae(x)
      if (onPath === null) {
        phase = 'ground'
        hNext = null
        vs = 0
      } else if (onPath <= h!) {
        const ahead = pathHae(x + 0.5)
        const behind = pathHae(x - 0.5)
        vs = ahead === null || behind === null ? 0 : (ahead - behind) * v
        hNext = onPath
      } else vs = 0 // below the glide path: level until it comes down
    } else {
      if (v > 30 * KT) v -= 2.0 * DT // autobrake
      else if (v > 15 * KT) v -= 0.8 * DT
      else v = Math.max(0, v - 0.6 * DT) // stops on the runway, ~250 m before its end
    }
    if (phase !== 'final' && hNext !== null) hNext += vs * DT
    ;({ lat, lon } = destination(lat, lon, trk, (v * DT) / 1852))
    h = hNext
    return row
  })
}

// ---------- SYN602: A320 parked south of the runway, transponder on (a ground icon for the grow and sink) ----------
function parked(): Row[] {
  const p = { lat: 47.2592, lon: 11.348 }
  return run((t) => ({ t, ...p, h: null, v: 0, trk: null, vs: 0 }))
}

// ---------- SYN603: C172 westbound along the Inn valley at 1,100 m HAE, 100 kt (a low icon over the valley) ----------
// Over Wattens, down the valley past the airport, then right onto 280° where the valley bends north-west towards Zirl.
function valley(): Row[] {
  let { lat, lon } = destination(RWY_26.lat, RWY_26.lon, OUT_CRS, 18_000 / 1852)
  const v = 100 * KT
  let trk = RWY_26.hdg
  return run((t) => {
    const row: Row = { t, lat, lon, h: 1100, v, trk, vs: 0 }
    if (finalFrame(lat, lon).along < -2000) trk = steer(trk, 280)
    ;({ lat, lon } = destination(lat, lon, trk, (v * DT) / 1852))
    return row
  })
}

// ---------- SYN604: B77W cruising FL350 on 135° at 480 kt, from 35 nm north-west of LOWI ----------
function cruise(): Row[] {
  let { lat, lon } = destination(LOWI.lat, LOWI.lon, 315, 35)
  const v = 480 * KT
  return run((t) => {
    const row: Row = { t, lat, lon, h: 36_125 * FT, v, trk: 135, vs: 0 } // alt_geom 36,125 ft with alt_baro FL350
    ;({ lat, lon } = destination(lat, lon, 135, (v * DT) / 1852))
    return row
  })
}

// ---------- readsb / adsb.lol v2 aircraft objects ----------

interface Plane {
  k: number
  hex: string
  flight: string
  r: string
  t: string
  category: string
  squawk: string
  mcpFt: number | null
  baroFt?: number // fixed pressure altitude (cruise); otherwise from the height
  heading?: number // true heading sent while stationary
  rows: Row[]
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6

/** The object one poll at now (s since T0, integer i) shows for this aircraft (ADS-B version 2). */
function object(p: Plane, i: number): Record<string, unknown> {
  // Position message times: 1–2 per second in the air; every 5 s for a stationary aircraft on the ground.
  let seenPos = 0.05 + 0.9 * frac(0.6180339887 * i + 0.3183 * p.k)
  let s = at(p.rows, i - seenPos)
  if (s.h === null && s.v === 0) {
    const tPos = 5 * Math.floor((i + 0.3) / 5) - 0.3
    seenPos = i - tPos
    s = at(p.rows, tPos)
  }
  const seen = Math.min(seenPos, 0.05 + 0.5 * frac(0.4142 * i + 0.27 * p.k))
  const o: Record<string, unknown> = { hex: p.hex, type: 'adsb_icao', flight: p.flight, r: p.r, t: p.t }
  if (s.h === null) {
    o.alt_baro = 'ground'
    o.gs = round(s.v / KT, 0.1)
    if (s.trk !== null) o.track = round(s.trk, 0.01)
    else if (p.heading !== undefined) o.true_heading = p.heading
  } else {
    o.alt_baro = p.baroFt ?? round((s.h - geoidN(s.lat, s.lon)) / FT - (QNH - 1013.25) * 27, 25)
    o.alt_geom = round(s.h / FT, 25)
    o.gs = round(s.v / KT, 0.1)
    if (s.trk !== null) o.track = round(s.trk, 0.01)
    o.baro_rate = round(s.vs / FPM, 64)
    if (s.vs !== 0) o.geom_rate = round(s.vs / FPM + 32 * noise(i, p.k + 3), 64)
  }
  o.squawk = p.squawk
  o.emergency = 'none'
  o.category = p.category
  if (s.h !== null) o.nav_qnh = QNH
  if (p.mcpFt !== null && s.h !== null) o.nav_altitude_mcp = p.mcpFt
  o.lat = round6(s.lat)
  o.lon = round6(s.lon)
  o.nic = 8
  o.rc = 186
  o.seen_pos = Math.round(seenPos * 1000) / 1000
  o.version = 2
  o.nic_baro = 1
  o.nac_p = 9
  o.nac_v = 2
  o.sil = 3
  o.sil_type = 'perhour'
  o.gva = 2
  o.sda = 2
  o.alert = 0
  o.spi = 0
  o.mlat = []
  o.tisb = []
  o.messages = 1000 * p.k + 9 * i
  o.seen = Math.floor(seen * 10) / 10 // adsb.lol rounds seen to 0.1 s; floor keeps seen ≤ seen_pos
  o.rssi = Math.round((-24 - 3 * p.k + 2 * noise(i, p.k + 4)) * 10) / 10
  o.dst = Math.round(distanceNm(LOWI.lat, LOWI.lon, s.lat, s.lon) * 1000) / 1000
  o.dir = Math.round(bearingDeg(LOWI.lat, LOWI.lon, s.lat, s.lon) * 10) / 10
  return o
}

const planes: Plane[] = [
  { k: 1, hex: '000e01', flight: 'SYN601  ', r: 'N0SYN6', t: 'A320', category: 'A3', squawk: '4521', mcpFt: 5000, heading: 261, rows: arrival() },
  { k: 2, hex: '000e02', flight: 'SYN602  ', r: 'N0SYN7', t: 'A320', category: 'A3', squawk: '2000', mcpFt: null, heading: 81, rows: parked() },
  { k: 3, hex: '000e03', flight: 'SYN603  ', r: 'N0SYN8', t: 'C172', category: 'A1', squawk: '7000', mcpFt: null, rows: valley() },
  { k: 4, hex: '000e04', flight: 'SYN604  ', r: 'N0SYN9', t: 'B77W', category: 'A5', squawk: '2206', mcpFt: 35_008, baroFt: 35_000, rows: cruise() },
]

const OUT = process.argv[2] ?? 'data/recordings/synthetic-lowi.jsonl'
const lines: string[] = []
for (let i = 0; i < POLLS; i++) {
  const now = T0_MS + i * 1000
  const ac = planes.map((p) => object(p, i)).filter((o) => (o.dst as number) <= 40)
  const body = JSON.stringify({ ac, ctime: now, msg: 'No error', now, ptime: 0, total: ac.length })
  const tSendMs = now - 45 - ((i * 17) % 30)
  const tRecvMs = now + 95 + ((i * 29) % 60)
  const url = `synthetic:/v2/point/${LOWI.lat}/${LOWI.lon}/40`
  lines.push(JSON.stringify({ v: 1, source: 'adsblol', url, status: 200, tSendMs, tRecvMs, bytes: Buffer.byteLength(body), body }))
}
const text = lines.join('\n') + '\n'
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, text)
console.log(`${OUT}: ${POLLS} polls, ${planes.length} aircraft, ${Buffer.byteLength(text)} bytes`)
```

- [ ] **Step 4: Generate the replay and run the check**

Run: `node .planning/plans/assets/WP-E-A/gen-synthetic-lowi.ts`
Expected (about 0.2 s):
```
data/recordings/synthetic-lowi.jsonl: 600 polls, 4 aircraft, 1486121 bytes
```
Then `shasum -a 256 data/recordings/synthetic-lowi.jsonl` prints `0ca51b2154728363c0c189d3f6ca2e2ebbfd572ab66966342f5e1b4d2f4b09cb`. A second run writes identical bytes.

Run: the check from Step 1.
Expected: PASS:
```
samples 1849 aircraft 4 SYN601 567
ridge 74 s 2697 m HAE; touchdown 510 s at 47.260897 11.350492 track 261.01 ; stops 560 s, heading 261
```
The touchdown is 495 m past the runway 26 threshold, on the centre line. Stopped, SYN601 sends no `track`, so `heading 261` (its `true_heading`) is what points the chased model along the runway; `null` there means the model turns to 000°. `git status --short data/` prints nothing, because the file is gitignored.

- [ ] **Step 5: Type-check the script** (it is outside `tsconfig.json`'s `include`)

Run: `printf '{ "extends": "./tsconfig.json", "include": [".planning/plans/assets/WP-E-A/*.ts"] }\n' > tsconfig.e-a.json && npx tsc --noEmit -p tsconfig.e-a.json; echo "exit $?"; rm tsconfig.e-a.json`
Expected: `exit 0`

- [ ] **Step 6: Commit** (the script only; the replay stays local)

```bash
git add .planning/plans/assets/WP-E-A/gen-synthetic-lowi.ts
git commit -m "test(plan): synthetic LOWI replay for gate GE — Nordkette pass and a runway 26 arrival" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: WP gate

- [ ] **Step 1: This package's tests**

Run: `node --test client/app.test.ts`
Expected: `ℹ tests 12`, `ℹ pass 12`, `ℹ fail 0`.

- [ ] **Step 2: Type-check the whole tree**

Run: `npx tsc --noEmit`
Expected: no output. The whole tree is checked, because `app.ts` consumes every E package.

- [ ] **Step 3: Full check**

Run: `npm run check`
Expected: `tsc` prints nothing, then `ℹ tests 680`, `ℹ fail 0` (677 on the E0–E5 tree with WP-E3's review revision, + 3; computed, see Validated).

Two timing tests can fail under full-suite load and pass when run alone: "sortRows and filterRows stay cheap at 12,000 rows" (`client/ui/table.test.ts`) and "budget: /api/view of a 250 nm circle with 5,000 aircraft" (`server/main.browse.test.ts`). They are known flakes, not regressions. Any other failure must be fixed.

- [ ] **Step 4: Confirm there is nothing left to commit**

Run: `git status --short`
Expected: no output (`dist/` and `data/recordings/` are gitignored).

---

### Task 5: Gate GE (design §6; the orchestrator runs it)

These steps measure and look. They change no file. Use Chrome on the MacBook Air M2, keep the tab in front (a background tab pauses `requestAnimationFrame`), and make sure no ion token is set, so the app uses Re:Earth and EOX. Write each measured value where it says "(orchestrator fills in)".

- [ ] **Step 1: The packages' own harness checks first**

They isolate what this gate sees combined:
- WP-E1 Task 5 Steps 3–4 (`harness/topography.html`: normals, the model not squashed, the animation's worst frame, `undefined` readings, clearance).
- WP-E2 Task 3 Step 3 (`harness/sun.html`: morning, golden hour, night, Sun off, dusk time-lapse).
- WP-E4 Task 3 Step 3 (`harness/scene-toggles.html`).

Results: WP-E1's are in WP-E1 Task 5 Step 4 (2026-09-23). WP-E2 and WP-E4 (2026-09-23, headless Chrome on the M2 over CDP, driver `plans/assets/WP-E-A/gate.mjs`):
- WP-E4 `harness/scene-toggles.html`: both buttons render pressed. `readScenePrefs` gives `{"topo":true,"light":true}` with nothing stored. At 375×812 both buttons are 32 px tall on one line at the top right, and the page does not scroll sideways (`scrollWidth` 375). No console errors.
- WP-E2's looks were checked in the app itself (Step 5), which runs the same `Sun`.

- [ ] **Step 2: Serve the LOWI replay**

Run: `node .planning/plans/assets/WP-E-A/gen-synthetic-lowi.ts` (unless Task 3 already generated the file), then `ADSB_SOURCE=replay REPLAY_FILES=data/recordings/synthetic-lowi.jsonl RECORD_DIR= npm run server`
Expected: `FlightHopper server on http://127.0.0.1:8787 (source replay)`. Variables on the command line win over `.env.local`.

In a second terminal, run `npm run dev` (Vite on port 5173, which proxies `/api` to 8787).

The replay plays once, starting when the server starts:
- SYN601 crosses the Nordkette about 74 s in, touches down at about 510 s and stops at about 560 s, heading 261°. Its last position report is at 595 s.
- Positions expire 60 s after the replay ends.
- Restart the server to replay it again. The client keeps polling through a restart.

- [ ] **Step 3: Chase over the ridge with 10 terrain toggles** (gate: FPS p50 ≥ 60 and p5 ≥ 30; no long task over 50 ms after load; worst animation frame reported; 0 settled `undefined` ground readings after load; camera ≥ 15 m above the drawn terrain on every frame)

Within 20 s of starting the server, open `http://localhost:5173/?hex=000e01&bench=1` at 1440×900.

Expected at first sight:
- The chase view over the Karwendel at midday (sun about 41°), with slopes shaded by the sun.
- The two toggles at the top right, both pressed.
- The detail panel on the left, and the HUD and the bench overlay.
- In the console: `viewer.scene.verticalExaggeration` is `1.00001`, `viewer.scene.globe.enableLighting` is `true`, and `viewer.shadows` is `false`.

Then paste this into the DevTools console. It waits until the tiles are loaded, clears the `fh:no-ground` and `fh:ground-unknown` marks, and presses T ten times, 3.5 s apart: 5 flattens and 5 grows, the last one back to on. It measures the frame intervals and the long tasks over the whole run and reports the worst frame in the 3 s after each press. For each of the two marks, it splits them into those inside the 3 s after a press (the 2.5 s animation and the 0.5 s before the nudge) and the settled ones, and reports the longest run of frames with a mark. It starts when the tiles are loaded, so the toggles cover the ridge crossing at about 74 s and the descent after it.

```js
const v = window.viewer, sleep = (ms) => new Promise((r) => setTimeout(r, ms))
while (!v.scene.globe.tilesLoaded) await sleep(250)
performance.clearMarks('fh:no-ground'); performance.clearMarks('fh:ground-unknown')
const iv = []; let last = null, run = true
const tick = (t) => { if (last !== null) iv.push([t, t - last]); last = t; if (run) requestAnimationFrame(tick) }
requestAnimationFrame(tick)
const lt = []; const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) lt.push(Math.round(e.duration)) }); po.observe({ type: 'longtask' })
const worst = [], presses = []
for (let i = 0; i < 10; i++) {
  const t0 = performance.now()
  presses.push(t0)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 't' }))
  await sleep(3500)
  worst.push(+Math.max(...iv.filter(([t]) => t > t0 && t < t0 + 3000).map(([, d]) => d)).toFixed(1))
}
await sleep(5000); run = false; po.disconnect()
const d = iv.map(([, x]) => x).toSorted((a, b) => a - b), q = (p) => d[Math.min(d.length - 1, Math.floor(p * d.length))]
const marks = (name) => { // inside the 3 s after a press, settled, and the longest run of frames with a mark
  const ng = performance.getEntriesByName(name).map((e) => e.startTime)
  const inWindows = ng.filter((t) => presses.some((p) => t >= p && t < p + 3000)).length
  let maxRun = 0 // walk the frame ticks and the marks together
  for (let i = 1, j = 0, n = 0; i < iv.length; i++) {
    let hit = false
    for (; j < ng.length && ng[j] <= iv[i][0]; j++) hit ||= ng[j] > iv[i - 1][0]
    maxRun = Math.max(maxRun, (n = hit ? n + 1 : 0))
  }
  return { all: ng.length, inWindows, settled: ng.length - inWindows, maxRun }
}
console.log({ fpsP50: +(1000 / q(0.5)).toFixed(1), fpsP5: +(1000 / q(0.95)).toFixed(1), longTasks: lt, worstAnimFrameMs: worst,
  noGround: marks('fh:no-ground'), groundUnknown: marks('fh:ground-unknown'), f: v.scene.verticalExaggeration,
  relH: v.scene.verticalExaggerationRelativeHeight, shadows: v.shadows, bench: document.querySelector('.fh-bench pre').textContent })
```

Expected:
- `fpsP50` ≥ 60, `fpsP5` ≥ 30.
- `longTasks` is `[]`.
- `worstAnimFrameMs`: 10 values, each expected under 50 ms (PoC with `TOPO_ON` = 1 + 1e-5: 36–44 ms).
- `noGround.settled` is 0: no `undefined` reading under the aircraft outside the 3 s after a press (the 2.5 s animation and the 0.5 s before the nudge). Readings inside those windows (`noGround.inWindows`, runs of up to `noGround.maxRun` frames) are Cesium's picker race during the animation.
- `groundUnknown` counts the frames where the memo did not cover such a reading, so the aircraft kept its estimated height:
  - `groundUnknown.settled` is 0. A settled `undefined` reading is a single frame, which the memo covers.
  - `groundUnknown.inWindows` is well below `noGround.inWindows`. If the two are equal, the memo is inert (for example, `ground()` called without the point), and the finding goes back to Task 1.
  - It is not 0. The memo answers only within 50 m of its reading: at SYN601's 180 kt that is the first ~0.54 s of a run (about 32 frames at 60 fps), and the rest of a longer run is unknown. A run from the first frames of a grow from flat is unknown throughout, because the last reading is a flat one (WP-E1's residual, in its Notes). So is a run at the start of the first flatten, because the plane moves from 0 to LOWI's 627.72 m and the memo was read around the old one.
  - The chase camera's memo has no mark. It follows the same rules: the camera moves with the aircraft, so its memo lapses after about the same 0.54 s of a run, and also while a large clearance correction holds (WP-E1's ponytail). On those frames the camera gets no clearance correction.
- `f` is `1.0000101000000001`: `TOPO_ON` plus the 1e-7 nudge that follows the last grow.
- `relH` is 627.72 (LOWI's runway height: SYN601 is within 30 km of LOWI).
- `shadows` is `false`.
- The bench text reads `clearance min` ≥ 15 m and `violations 0`. The bench computes clearance from the same ground as the camera, so it cannot show a wrong or unknown ground. The independent check is WP-E1's harness, Task 5 Step 4 item 5 (`expectedGroundM`, `?hold=1`).
- While the relief sinks and grows, SYN601 keeps its true height (it never sinks with the ground), the camera never enters a slope, and the ridge sinks into the draped imagery and grows back with no jump at the start or end.

Results (2026-09-23, headless Chrome on the M2 over CDP, with the build before the `GroundMemo` amendment; `fh:ground-unknown` did not exist yet):
- **Run 1, cold cache:** `fpsP50` 62.9, `fpsP5` 29.9, `longTasks` [61], `worstAnimFrameMs` 34.9–66.3. Bench `clearance min` 308 m, `violations 0`. `f` 1.0000101, `relH` 627.72, `shadows` false. The clock showed the recording's time, 2026-09-22 about 10:01Z, so D12 works.
- **Run 2, under heavy machine load** (load average above 60, from macOS `mobileassetd` and `modelcatalogd`): `fpsP50` 50.8. `noGround` 176: 175 inside the animation windows and 1 settled, with at most 37 in a row. Bench `clearance min` 362 m, `violations 0`.
- The `undefined` runs inside the windows led to WP-E1's `GroundMemo` and to `acGround` and `camGround` here (see Validated).
- The long task and the worst animation frames over 50 ms match WP-E1's harness profile: Cesium shader-program compiles on first use, which occur with or without toggles (WP-E1 Task 5 Step 4).
- **Run 3, quiet machine** (load average ≈ 3, cold cache, the first `GroundMemo` build, whose memos were still inert): `fpsP50` 131.6, `fpsP5` 84.7, `longTasks` [] during the 10 presses, `worstAnimFrameMs` 12.4–15.4 with one 54.4 (a first-use shader compile). `noGround` 427, all inside the animation windows (0 settled), at most 89 in a row. Bench `clearance min` 372 m, `violations 0`. `f` 1.0000101, `relH` 627.72, `shadows` false.
- **Run 4, quiet machine, final build** (the memo passes its point; load average ≈ 2, cold cache): `fpsP50` 137.0, `fpsP5` 103.1, `longTasks` [] during the 10 presses, `worstAnimFrameMs` 11.4–44.9 (all under 50). `noGround` 347, all inside the animation windows (0 settled), at most 84 in a row. `groundUnknown` 0: the aircraft memo answered every one of them. Bench `clearance min` 326 m, `violations 0`. `f` 1.0000101, `relH` 627.72, `shadows` false. Gate GE's Step 3 passes.

- [ ] **Step 4: Ground objects while flat and growing** (after touchdown, from about 520 s)

With SYN601 on the runway, press T (flatten). Wait 3 s, then press T again (grow). Repeat once after it stops (from about 565 s).

Expected:
- Stopped, SYN601 points along the runway: the HUD reads HDG about 261°, not 000° (the replay before the review amendment had no heading after the stop).
- The runway planes and threshold markers stay on the ground. At LOWI the plane is the runway height, so they barely move: a residual of ±2 m, with the lower ~45 % of 08/26 under the flat map at factor 0 (WP-E3).
- The parked SYN602 icon, south of the runway, rides the grow and the sink with no pop at the end.
- SYN601 stays on the runway (`placedHeightM` on the lag-corrected ground).

Results (2026-09-23, the replay at `REPLAY_SPEED=5`, before the heading amendment): SYN601 stayed on the runway through the sink and the grow, and the HUD read GND. Flat (`f` 1e-7, `relH` 627.72), the runway plane shows on the flat map under the aircraft (`gate-GE/09-runway-flat.jpg`). At full relief the plane is mostly hidden by terrain that sits up to about 1 m above the runway's surveyed height, as it already was before the flatten (`gate-GE/08-runway-full.jpg`). This is WP-V5's documented residual, not a regression. No console errors.

- [ ] **Step 5: Screenshots**

Restart the server before each LOWI page, so SYN601 is over the ridge. Fix the sun time with `?sun=`: the replay is otherwise lit at its recording time, 10:00Z.
1. LOWI morning: `http://localhost:5173/?hex=000e01&sun=2026-09-22T06:00:00Z` (sun +9.4° from azimuth 100°). Expected:
   - the east-facing slopes are lit and the west-facing ones are in shade;
   - the light is slightly warm (golden 0.31);
   - there is no request to `gibs.earthdata.nasa.gov`.
2. LOWI golden hour: `…&sun=2026-09-22T16:45:00Z` (+3.7°, azimuth 266°, golden 0.84). Expected: a warm light from the west, and warm grey shaded slopes, not black.
3. LOWI night: `…&sun=2026-09-22T20:30:00Z` (−31.7°). Expected:
   - dark land, with the Innsbruck lights (GIBS) in the valley;
   - the mountains are dim but readable under a light from overhead;
   - the aircraft is dim and does not glow;
   - the runway plane is about as dark as the terrain around it, not a grey slab (`runways.setLight`, WP-E3);
   - GIBS tiles are PNG at z ≤ 8, HTTP 200.
4. The grow sequence: `http://localhost:5173/?hex=000e01&topo=0`. Expected at start: a flat map at LOWI's runway height (`viewer.scene.verticalExaggerationRelativeHeight` 627.72, `verticalExaggeration` 0, or 1e-7 after the nudge). Press T, and take screenshots at about 0.8 s, 1.6 s and 2.5 s (compare `plans/assets/WP-E/poc/05`–`08`).
5. KSFO day: stop the server and run `ADSB_SOURCE=replay REPLAY_FILES=.planning/plans/assets/WP-A2/synthetic-ksfo.jsonl RECORD_DIR= npm run server`. Open `http://localhost:5173/?hex=000a01&airport=KSFO`. Expected:
   - SYN101 on the 28R final, lit at the recording's time (18:00Z, sun +43°);
   - the clock shows the recording's time (D12, WP-E5), not today's: `viewer.clock.currentTime.dayNumber` is 2461306 and `secondsOfDay` is about 21,637 plus the seconds since the server started. That is 18:00Z; Cesium's day turns at noon TAI.
6. Browse at local night: with the LOWI replay, open `http://localhost:5173/?airport=LOWI&sun=2026-09-22T20:30:00Z` (no `hex`). Expected:
   - the street map is not darkened;
   - the runway planes are as by day (`setLight(null)`);
   - `viewer.scene.globe.enableLighting` is `false`;
   - the toggles are hidden;
   - there is no GIBS request.

   Select an aircraft: the night look appears. Press Esc: back to the unlit street map.

Screenshot files and remarks (2026-09-23, `plans/assets/WP-E-A/gate-GE/`, 1440×900):
1. `01-lowi-morning.jpg`: low sun from the east, strong relief, and no shadows. 4 GIBS tiles were requested once at start, all 200. Without `?airport=`, the start camera sits over KSFO (the first hero), where 06:00Z is night, until the first chased state moves the sun's point to LOWI. Harmless; `?airport=LOWI` avoids it.
2. `02-lowi-golden-hour.jpg`: warm light from the west, warm shaded slopes, not black. No GIBS requests.
3. `03-lowi-night.jpg`: dark land with the Innsbruck glow in the valley (62 GIBS tiles, all 200, z ≤ 8), mountains faint but readable, stars, and the aircraft visible without glowing.
4. `04-grow-flat.jpg` (start `f` 1e-7, `relH` 627.72), `05-grow-f024.jpg`, `06-grow-f071.jpg`, `07-grow-full.jpg`: the ridge grows out of the flat map, and the aircraft keeps its height.
5. `11-ksfo-recorded-time.jpg`: SYN101 on the 28R final in daylight. `viewer.clock.currentTime` = 2026-09-22T18:00:23Z, the recording's time (D12, WP-E5).
6. `10-browse-night.jpg`: the street map is not darkened, `enableLighting` is false, the toggles are hidden, and there are no GIBS requests.

- [ ] **Step 6: Keys, persistence and layout**
1. Chasing, click into the table's search box and type `tl`. Expected: the box shows `tl`, both toggles stay pressed, the factor stays `1.00001` and the lighting stays on. Press Cmd+L: the address bar takes the focus, and nothing toggles.
2. Click the map, press L. Expected: the Sun button is unpressed, `enableLighting` is `false`, and the aircraft is lit white from high in the south. `localStorage['fh.scene.v1']` is `{"topo":true,"light":false}`. Reload: the Sun is still off.
3. Open `…/?hex=000e01&topo=0` while the stored topo is `true`. Expected: the map starts flat, and the stored value is unchanged until the next toggle.
4. Press Esc. Expected: browse, the toggles hidden, `enableLighting` `false`. T and L do nothing in browse.
5. Narrow the window, or emulate 375×667 and 375×812. Read the rectangles with `getBoundingClientRect()` of `.fh-toggles`, `.fh-detail`, `.fh-hud` and `.fh-right > .fh-attribution`. Expected in chase:
   - the toggles are at the top right;
   - the detail panel starts just below them (52 px) and ends 8 px above the HUD;
   - the credits are at the bottom, with the GIBS line, and the HUD ends at least 8 px above the credits box's top (at 375×812 the box starts near 601 px, the HUD ends near 592 px);
   - nothing overlaps, and there is no sideways scroll.

   In browse the toggles are hidden.
6. Everywhere: no Shadows button, `viewer.shadows` is `false` (D10), and the console has no errors.

Results (2026-09-23):
1. `t` and `l` typed into the search box: the factor stays 1.00001 and the lighting stays on. A Cmd+L keydown toggles nothing.
2. L: the Sun button is unpressed, `enableLighting` is false, and `localStorage['fh.scene.v1']` is `{"topo":true,"light":false}`. After a reload the Sun is still off.
3. `?topo=0`: starts flat (`f` 1e-7), and the stored value is unchanged.
4. Esc: browse, `enableLighting` false, the toggles `display: none`. T in browse does nothing.
5. 375×667: toggles at the top right (top 8–46), the detail panel at 52–283, the HUD at 291–463. 375×812: the panel at 52–428, the HUD at 436–608. Both: no overlap between them, `scrollWidth` 375. (The review amendment then moved the phone HUD up 16 px, because the new credit line overlapped its bottom by about 6 px.)
6. No Shadows button, `viewer.shadows` false in every run, and no console errors in any step.

## Notes for later work

- **Deviations from the brief:**
  - `sun.update` runs every frame in both modes (at the camera in browse), not only while chasing. This is WP-E2's convention. While the Sun is off, `update` aims the fixed light above the camera, so WP-E3's lit runways never get a light from below the horizon in browse, and the clock stays current.
  - The relatch after a selection runs at the new aircraft's first state, not inside `select()`. There is no drawn position at `select()` time, and `?hex=` never calls `select()`. `relatch` is also ignored during an animation.
  - T and L act in chase only, like their buttons, which browse hides.
  - The flatten's plane goes through `relHFor`, a pure wrapper of `pickRelHM` that adds the cases "ground unknown" and "no aircraft", so it has a test.
  - An `undefined` ground reading uses the last reading within 50 m of the point, rescaled to this frame's factor (WP-E1's `GroundMemo`), for the aircraft and for the chase camera. Each call passes the point it reads at: without it, `ground()` neither reads nor refills the memo, and `tsc` does not object. `null` (no reading since the selection, a new plane, more than 50 m from the last reading, or a grow while the last reading is a flat one) falls back to the estimated height, as before. `select()` resets both memos.
  - On phones the detail panel moves below the toggles. WP-E4 suggested moving the toggles above the credits instead, but there they would collide with the HUD (see Architecture).
  - `?bench=1` adds the `fh:no-ground` and `fh:ground-unknown` marks, so gate GE can count `undefined` readings in the app and see how many the memo did not cover. The second mark is the only check of the memo wiring: `startApp` has no Node test, and the bench's clearance comes from the same ground.
  - WP-E5's files were merged as well. The WP brief listed E0–E4, but `status.upstreamOffsetMs` needs E5's `StatusBrief` field, and design §5 lists E1–E5 as E-A's needs.
  - The WP brief said B-A's plan was never written. `plans/WP-B-A-integration.md` exists (commit `aef6872`), and the integrated tree's `app.ts`, `app.test.ts` and `layout.css` are byte-identical to the repository's HEAD. The change lists are anchored there.
- **PLAN.md** is not a file of any E package. D13 adds NASA GIBS (keyless) to the allowed services, and §5.4 should list E0–E5 and E-A with gate GE. Someone who owns PLAN.md should make both edits.
- **Shadows (user feedback, 2026-09-22).** With the PoC's Shadows toggle off, the terrain and the aircraft were still shaded. That was slope and model shading by the light (Lambert, N·L), not cast shadows. In the app, the Sun toggle switches the globe's lighting off (flat, unshaded imagery). The aircraft keeps WP-E2's fixed white light from 60° above the southern horizon, so it never looks flat. Cast shadows (`viewer.shadows`) are never on, and gate GE checks that.
- **ponytail:** while the map is flat, a selection away from the heroes keeps the old plane (see Architecture). Upgrade: `sampleTerrainMostDetailed` under the new aircraft, then `relatch`.
- **ponytail:** a ground memo covers only the first part of a long run of `undefined` readings. It has no age limit, but WP-E1 answers only within 50 m of the reading (`MEMO_RADIUS_M`, sized for 70 m/s). SYN601 flies the toggles at 180 kt (92.6 m/s), so the memo lapses after about 0.54 s, and the rest of the run is unknown (`null`): the aircraft keeps its estimated height, and the camera gets no clearance correction. Gate GE's run 2 measured runs of up to 37 frames (0.6–0.7 s) under heavy load; a slower frame rate makes the same number of frames last longer. Within the radius, a fixed point stays exact across factor changes, so the memo's error is how the ground changes over up to 50 m of travel, times the slope and the factor. A memo read while flat is not used once the relief grows (`null`: WP-E1's residual, in its Notes). A memo read in a grow's first frames also carries WP-E1's ratio note. `fh:ground-unknown` (Task 5 Step 3) counts the uncovered frames. Upgrade (WP-E1's constant, so a change to agree there): a radius that scales with the chase speed or with the memo's age (for example 150 m, which covers 1.6 s at 180 kt), with its error re-derived from the slope, or WP-E1's async `sampleTerrainMostDetailed` during animations. A check against the true ground (WP-E1's harness, `expectedGroundM` with `?hold=1`, and `?memo=1`) decides. Gate GE's clearance log cannot show it, because it is computed from the same ground.
- **`gate.mjs`** (`assets/WP-E-A/`, the orchestrator's CDP driver, not a file of this package) counts only `fh:no-ground`. The next gate run should also count `fh:ground-unknown`, as Task 5 Step 3's console script does.
- **The replay plays once.** It lasts 600 s, and its positions expire 60 s after the end. Restart the server to replay it. SYN601's lowest point is 291 m above the Gleirsch–Halltal chain, which is lower than a real IFR arrival would fly. A real one would stay higher over the Karwendel. The route shows the relief close up, as the PoC's 2,700 m circle did.

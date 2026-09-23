# WP-E1 — Topography Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chase view's relief readable and switchable (`.planning/terrain-sun-design.md`, D1–D6). The terrain sends per-vertex normals, so the sun (WP-E2) can shade slopes. One `Topography` object flattens the relief into the map and grows it back: it animates `scene.verticalExaggeration` with a smoothstep, flattens around a latched height (relH), and works around Cesium's picker race. The chase model keeps its true height while the ground moves, and `ChaseCamera` keeps its clearance against the ground that is actually drawn in the frame, not last frame's.

**Architecture:** One new module, three small edits to earlier packages' files, and a harness page.
- `client/scene/terrain.ts` (WP-V1, edited): both remote sources request vertex normals (D1). ion: `createWorldTerrainAsync({ requestVertexNormals: true })`. ion already puts extensions in the URL query. Re:Earth: `CesiumTerrainProvider.fromUrl(new Resource({ url: REEARTH_TERRAIN_URL, queryParameters: { extensions: 'octvertexnormals' } }), { requestVertexNormals: true })`. Cesium asks other servers for extensions in the `Accept` header, and Re:Earth varies the tile body by that header without a `Vary` header and with a 30-day cache. A browser could therefore hand back tiles it cached without normals. The query gives the normals tiles their own URLs. Cesium keeps the query on `layer.json` and on every tile it derives (checked offline in `config.test.ts`). No water mask: it adds 64 KB to each tile with both land and water. A new `Resource` is built per call, because `fromUrl` appends a slash to the resource it is given.
- `client/scene/model.ts` (WP-V3, edited): `ChaseModel.load` passes `enableVerticalExaggeration: false` to `Model.fromGltfAsync` (D6). Cesium's default of `true` squashes the aircraft towards relH with the ground and flattens it at factor 0 (PoC screenshot 09).
- `client/scene/chaseCamera.ts` (WP-V4, edited): `ChaseCameraOpts.groundAt?: (c: Cartographic) => number | null` (D5). The default is `globe.getHeight(c) ?? null`, which is today's behaviour. `#place` measures clearance against `groundAt`, once per clearance pass: up to 5 calls a frame, each at the camera's new position. The app passes the lag-corrected ground, because `globe.getHeight` answers last frame's surface. On the steepest grow frame at LOWI that surface is 17 m off, more than the 15 m clearance.
- `client/scene/topography.ts` (new):
  - `class Topography` is the only writer of `scene.verticalExaggeration` and `scene.verticalExaggerationRelativeHeight` (D2, D3). Its state: the target (`on`), the factor written last (`#f`), relH, the animation (`#from`, `#to`, `#t0`, null at rest) and the pending nudge time.
  - `constructor(scene, on, { durationMs = 2500, nudgeDelayMs = 500 })` writes the factor at once: `TOPO_ON` (1 + 1e-5) or 0. relH stays at Cesium's default 0 until the first latch. `scene` is typed `Pick<Scene, 'verticalExaggeration' | 'verticalExaggerationRelativeHeight'>`: a `Scene` fits, and so does the tests' plain fake.
  - `set(on, nowMs, relHM)` does nothing when `on` is unchanged. Otherwise it starts an animation from the current factor to `TOPO_ON` or 0, so a reversal mid-animation continues without a jump. A flatten from rest latches `relHM`, only if it is finite. A reversal keeps the plane. So does a grow: "growing never changes relH".
  - `relatch(relHM)` takes a new plane only while fully flat and at rest (D4: a new selection while flat). It is ignored otherwise, and for a non-finite value.
  - `update(nowMs): TerrainFrame` is called first in `scene.preUpdate`. It sets `fSampled` to the factor written last (what the tiles hold while `globe.getHeight` runs this frame). It then advances `from + (to − from)·smoothstep((now − t0)/durationMs)`. At `u ≥ 1`, and also for a NaN clock, it ends exactly on `TOPO_ON` or 0 and schedules the nudge `nudgeDelayMs` later. At the nudge time the factor moves once to the end value + 1e-7. A relH change reaches the scene here too. It also resets every tile's picker, so a change at rest (a re-latch) schedules a nudge as well. A second nudge moves the factor back to the end value, so re-latches never add up. `update()` writes both values and returns one `TerrainFrame` object that it reuses every frame.
  - `ground(sampledM, frame, memo?, at?)`: `at` is the point the reading was taken at (a `Cartographic`, or any `{ latitude, longitude }` in radians). A reading gives `rescaleSampledM(sampledM, frame.fSampled, frame.fNow, frame.relHM)`, the ground drawn this frame (E0). `undefined` gives `null`, or, with a `GroundMemo` and `at`, the memo's last reading rescaled to this frame's factor: `rescaleSampledM(memo.m, memo.f, frame.fNow, frame.relHM)`. The memo counts only if it was read around the same relH and within 50 m of `at` (`MEMO_RADIUS_M`, module-private; great circle via `shared/geo.ts`). A memo read while flat (`memo.f` below 1e-4, WP-E0's flat threshold `FLAT_F`, which `topography.ts` repeats as a local constant because E0 does not export it) holds no relief. It gives relH while this frame is flat too, and `null` (unknown) once the relief grows (`frame.fNow` ≥ 1e-4). Each reading with `at` refills the memo with the reading, `frame.fSampled`, `frame.relHM` and the point. A memo passed without `at` is neither read nor refilled. A fixed point's drawn height follows the factor exactly, so the memo's error is the ground's change between where it was read and `at`, at most 50 m apart (plus the picker-error amplification in the ponytail below). Why the point: `ChaseCamera` reads up to 5 points a frame, `rangeM·(cos p − cos p′)` apart (about 147 m at the default 150 m range, up to 2.9 km at 3 km), and every frame starts again at the uncorrected point. A memo that ignored the point answered one point with another's ground. On the valley approach of `chaseCamera.test.ts`, it reported 33.3 m of clearance for a camera 399 m inside the slope, and in the mixed case (the first pass reads, the others do not) it lifted the whole rig by 295 m. 50 m covers gate GE's longest run (37 frames) at 70 m/s, about an approach speed (43 m). Without a memo, `ground` behaves as before.
  - `GroundMemo { m, f, relHM, lat, lon, ok }` (`lat`, `lon`: where it was read, radians) and `groundMemo()` (an empty one, `ok: false`). The caller makes one per point it follows, once, and sets `ok = false` to forget it. Why it exists: the nudge ends the picker race at rest, but during an animation every frame changes the factor. At gate GE (the LOWI replay in the app, 10 toggles, headless Chrome on the M2), `globe.getHeight` under the chased aircraft answered `undefined` on 175 frames inside the 2.5 s animation + 0.5 s nudge windows and on 1 frame outside, in runs of up to 37 frames (~0.6 s). The app then kept the last drawn ground, which lags by Δf·relief over such a run (hundreds of metres possible). The chase camera's clearance was unknown, so its ≥ 15 m correction was skipped on those frames. The memo covers a run that follows a reading with relief, within 50 m of it. It cannot cover a run from the first frames of a grow from flat: every reading before such a grow is flat, so the ground stays unknown until the next reading (see the ponytail below).
  - `pickRelHM(lat, lon, drawnGroundM, airports)` (D4): the nearest airport within `HERO_RELH_KM` (30 km, great circle via `shared/geo.ts`) that has runways gives the mean `thrHaeM` of its runway ends: LOWI 627.72 m, KSFO −29.32 m, LLBG 56.57 m HAE. Otherwise the drawn ground under the aircraft (when finite), else 0.
  - The nudge: every factor or relH change resets each tile's `TerrainPicker`. A picker worker that comes back after a reset still empties the tile's root, so `globe.getHeight` answers `undefined` there until the next change (PoC: 40 of 80 readings after animations). One tiny change once the workers are idle rebuilds every picker cleanly (PoC: 0 of 80).
  - ponytail (in the code): a stall, for example a hidden tab, skips the animation ahead by its length, so the ground correction spans a large factor step for one frame. Upgrade: move `#t0` forward by the stall. In `pickRelHM`, one plane per airport: at LLBG the runway ends span 49–61 m, so a touchdown far from the mean snaps the aircraft by up to 7.4 m while the ground is flat. Upgrade: use the nearest runway end's height. During a grow from flat, if Cesium's picker gives no ground for a run of frames from the grow's start, `ground()` gives `null` for that run. The aircraft keeps its estimated height, and the chase camera has no clearance ground for those frames, so it can briefly clip a rising slope (for at most the run's length: gate GE measured runs of up to 37 frames, about 0.6 s). A memo read in a grow's first frames multiplies the picker's own error (WP-E0: 0.3 mm for 100 m triangles, 3.1 mm for 300 m) by fNow/f. Over a 37-frame run at 60 fps that ratio reaches about 1,300: 0.4 m and 4 m. Upgrade for both: fall back to `drawnHeightM(sampleTerrainMostDetailed(point), fNow, relH)` (raw provider heights, async, for example at 4 Hz during animations). The independent check is the harness's `?memo=1` (Task 5 Step 4, check 7): it compares the memo'd ground and the camera's clearance with those provider heights, at the same frame and points. The app's clearance log cannot show either error, because it is computed from the same ground. `?hold=1` without a memo cannot either: the harness then passes no memo, and a fixed aircraft never moves its point. The chase camera starts each frame at its uncorrected point, which is more than 50 m from its last reading while a large correction holds. Its memo then lapses: `null`, no correction, as without a memo. In a scratch check on the valley approach (slopes 0.02–3, 3 frames of `undefined` after a read frame), the memo answered while the correction was small (slope 0.3: 15.5 m reported, 15.8 m true) and lapsed at slopes 1 and 3. Upgrade: one memo per clearance pass.
- `harness/topography.html` + `.ts`: the real `ChaseModel` and `ChaseCamera` (with `groundAt`) fly a level 6 km circle at 2,700 m HAE around LOWI. Its northern half crosses the Nordkette ridge. The page uses the app's `createViewer`, so it gets Re:Earth with normals and EOX. `globe.enableLighting = true` is set only so the relief reads, at `?time=` (default 2026-06-21T10:30Z). WP-E2 owns the sun. T or the button toggles. The overlay shows the factor, relH, the drawn ground (corrected and raw) against `sampleTerrainMostDetailed` at 1 Hz at the current factor, AGL, camera clearance (minimum, frames < 15 m), the frame times of the frames that rendered a new factor since the last toggle, and undefined ground readings under the aircraft (near a factor change, and settled with all tiles loaded). `?memo=1` passes a `GroundMemo` for the aircraft and one for the camera, as the app does. It then samples the provider's heights under both points, 4 times a second and on every frame a memo answered. Each sample is compared with what that frame drew: the ground error under the aircraft, and the camera's true clearance (`stats().truth`). The page sets `window.harness = { viewer, topo, setTopo(on), stats() }` for gate GE's bench.

Conventions consumers (WP-E-A, and WP-E3 through the app) rely on:
- Construct `Topography` right after `await createViewer(…)`, before any other `await`, so that no frame has rendered yet. Leaving factor 1 with tiles loaded rebuilds all of them (PoC: 686–2,008 ms). With no tiles loaded, the first write costs nothing, and tiles that load later are built with normals.
- In `frame()`: `const fr = topo.update(performance.now())` comes first. Then `topo.ground(globe.getHeight(carto), fr, acGround, carto)` for the chased aircraft, and `new ChaseCamera(viewer, { groundAt: (c) => topo.ground(globe.getHeight(c), fr, camGround, c) })`. Pass the point that was read: a memo answers only within 50 m of where it was read, and a memo passed without its point is never used. `fr` is held in a variable that `frame()` assigns. `acGround` and `camGround` are made once with `groundMemo()`. Pass `fr` (fSampled, fNow, relHM) to WP-E3's runways and fleet layer. Read it during the frame and never keep it.
- Toggle: `topo.set(on, performance.now(), pickRelHM(s.lat, s.lon, terrainM, heroes))`, with `terrainM` the corrected ground under the chased aircraft. A flatten latches only from rest at `TOPO_ON`, where the drawn ground is the true ground within 1e-5.
- A selection changed while flat: `topo.relatch(pickRelHM(s.lat, s.lon, null, heroes))`. While flat, `globe.getHeight` answers the old plane everywhere. Away from a hero airport, pass a true ground (`sampleTerrainMostDetailed`, async) and relatch again when it resolves. `relatch` is ignored once a grow has started. A selection made during an animation needs a relatch after the animation ends.
- Without a memo, `ground()` returns `null` for a tile that is not loaded and in the picker race: during an animation and up to 0.5 s after it, before the nudge. Pass one `GroundMemo` per point you follow (the aircraft, the camera), with the point. An `undefined` reading then answers the last reading, rescaled to this frame's factor. `null` remains before the first reading, after a relH change, farther than 50 m from the last reading, and during a grow while the last reading is a flat one (it holds no relief). Treat it as "unknown" (keep the estimated height; no clearance correction), not as "no terrain". Set `ok = false` on both memos on a new selection.

**Tech Stack:** CesiumJS 1.145 (`Scene.verticalExaggeration`, `Scene.verticalExaggerationRelativeHeight`, `Globe.getHeight`, `CesiumTerrainProvider.fromUrl(Resource, { requestVertexNormals })`, `Resource` with `queryParameters`, `createWorldTerrainAsync({ requestVertexNormals })`, `Model.fromGltfAsync({ enableVerticalExaggeration })`, and in the harness `sampleTerrainMostDetailed`). `node:test` with `t.mock.method`, which `client/api.test.ts` already uses. WP-E0's `client/scene/exaggeration.ts` and `TerrainFrame`, and `shared/geo.ts` `distanceNm`. No new dependencies.

**Wave:** E1 (parallel with E2–E5; depends only on WP-E0). Consumed by WP-E-A. **Estimated:** 1.5 h. **Validated:** 2026-09-22 in a scratch copy of the WP-E0 tree (the integrated B-A tree + E0; Node 25.2.1, TypeScript 7.0.2, Vite 8.3.0, CesiumJS 1.145.0 / engine 26.3.0) on the user's MacBook Air M2:
- Package tests: `client/config.test.ts` 11/11 (9 + 2), `client/scene/model.test.ts` 19/19 (18 + 1), `client/scene/chaseCamera.test.ts` 20/20 (18 + 2), `client/scene/topography.test.ts` 11/11: 61/61 together. `npx tsc --noEmit` is clean for the whole tree, harness included. `npm run check` gave 627/627 (611 + 16) in 6 of 8 full-suite runs. In each of the other 2 runs, one timing test failed under load. The one the log named was the known flake "budget: /api/view of a 250 nm circle with 5,000 aircraft", which passes alone (`server/main.browse.test.ts` 5/5).
- **RED:** each Step 2 quotes the real output. Tasks 1 and 2 fail on assertions: the options are missing. Task 3 fails on assertions and TS2353. Task 4 fails with `ERR_MODULE_NOT_FOUND` and TS2307.
- **Mutations:** 36 hand-made faults, each caught by 1–5 failing tests:
  - `TOPO_ON` exactly 1, at the start or at the end of a grow; the constructor leaving the factor at 1;
  - no latch; a latch mid-animation or when growing; no finite guard in `set` or `relatch`;
  - a reversal restarting from the far end; `set` not a no-op; linear instead of smoothstep; a NaN clock animating forever;
  - no nudge, a nudge every frame, a nudge without delay, a creeping nudge, no nudge after a re-latch;
  - `relatch` while on or while animating; `fSampled` equal to `fNow`; `ground` without the rescale, or `relH` for `undefined`;
  - `pickRelHM`: no radius, the first airport in range instead of the nearest, airports without runways, the first runway end only, the radius in nm, NaN let through;
  - `#place` ignoring `groundAt`; a `null` default `groundAt`;
  - Re:Earth without the query, without normals, or with the water mask; ion without normals or with the water mask; the model exaggerated again.

  Two first-draft lines turned out to be dead code (removed): `set()` cancelling a pending nudge, which the animation's end overwrites anyway, and the constructor writing relH 0 over Cesium's default 0.
- **Replay:** the plan's code blocks were extracted into a fresh copy of the WP-E0 tree and applied task by task. Each Step 2 failed as written: Task 1 at 9/11 with the two quoted assertions, Task 2 at 18/19, Task 3 at 18/20 plus the three quoted tsc errors, Task 4 with `ERR_MODULE_NOT_FOUND` plus TS2307. Each Step 4 passed (11, 19, 20, 11). After Task 5, `tsc --noEmit` of the copy was clean and `npm test` gave 627/627. The copy was byte-identical to the sandbox (`diff -rq`, `node_modules` excluded).
- **Harness:** `harness/topography.ts` type-checks. The orchestrator ran the browser check for gate GE on 2026-09-23. Task 5 Step 4 lists the checks, their pass criteria and the results.
- **Amendment 2026-09-23 (after gate GE):** `GroundMemo`, `groundMemo()` and `ground(…, memo?)` (Architecture, "Why it exists"). The code was changed in the same sandbox:
  - `topography.test.ts`: 13/13 (11 + 2). The two new tests failed first with `SyntaxError: The requested module './topography.ts' does not provide an export named 'groundMemo'`. The four package files together gave 63/63.
  - 8 more hand-made faults, each caught by 1–2 failing tests: the memo ignored; not rescaled; no relH check; `ok` ignored; `ok` never set; not refilled; storing `fNow` instead of `fSampled`; storing the rescaled value.
  - The full suite ran once, in WP-E-A's merged tree (E0–E5 + E-A + this amendment): `npx tsc --noEmit` clean, `npm test` 675/675. In this package's tree, Task 6 counts 629 (627 + 2). That count is computed, not re-run here.
  - The amended code blocks are byte-identical to the sandbox. Task 4 Step 2's `tsc` column moves from 90 to 102 because of the longer import.
  - Replay: the amended test block, extracted into WP-E-A's replay copy of the merged tree, failed against the old `topography.ts` with that `SyntaxError`. With the amended `topography.ts` block it passed 13/13.
- **Amendment 2026-09-23 (review of the memo):** a memo read while flat holds no relief, but `ground()` rescaled it with `rescaleSampledM`, which returns relH for a flat reading, while a grow raised the relief. The last reading before a grow is always a flat one, and the `undefined` runs occur during animations, so this was the likely case: the ground came out 257.7 m too low under the Nordkette at f = 0.15 (`rescaleSampledM(628.4, 1e-7, 0.1525, 628.4)` against `drawnHeightM(2317.9, 0.1525, 628.4)`). `ground()` now gives `null` for a flat memo once `frame.fNow` ≥ 1e-4, and relH while the frame is flat too (Architecture, `ground()` and the ponytail). WP-E0 is unchanged. WP-E-A's `app.ts` comment on the `null` cases changed with it. The code was changed in WP-E-A's sandbox and copied to this package's:
  - `topography.test.ts`: 14/14 (13 + 1). The new test failed first: `AssertionError [ERR_ASSERTION]: 2016` with `627.72 !== null` (the first frame of the run). The four package files together gave 64/64 in this package's sandbox. In WP-E-A's, `node --test client/app.test.ts client/scene/topography.test.ts` gave 26/26.
  - 4 more hand-made faults, each caught by the new test: no flat check; a flat memo always `null`, also while the frame is flat; the check on `fSampled` instead of `fNow`; the threshold at 1e-7.
  - `npx tsc --noEmit` is clean for WP-E-A's tree. The full suite was not run (the machine was short on CPU). Task 6 counts 630 (629 + 1): computed, not run.
  - The amended code blocks are byte-identical to both sandboxes. There was no replay.
- **Amendment 2026-09-23 (review: the memo's point):** one memo served every point it was asked about. `ChaseCamera` reads up to 5 points a frame, so `camGround` answered the uncorrected camera with the corrected camera's ground. On the valley approach, a frame with every reading `undefined` after a read frame reported 33.3 m of clearance for a camera 399 m inside the slope. Before the memo, the same frame reported `null`. When only the first pass read, the memo lifted the rig by 295 m and reported 15.5 m against a true 447.8 m. Both came from the reviewer's scratch test, which drives the real `ChaseCamera` with `Topography.ground` and a memo. `ground()` now takes the point (`at`), and a memo answers only within 50 m of where it was read (Architecture, `ground()`). The harness gained `?memo=1` and Task 5 Step 4 check 7, the independent check that neither `?hold=1` nor `below15` gave. `chaseCamera.ts` changed only in the `groundAt` comment. The code was changed in WP-E-A's sandbox and copied to this package's:
  - `topography.test.ts`: 15/15 (14 + 1). The three earlier memo tests pass the point. The new test failed first against the old `topography.ts`, 14/15: `AssertionError [ERR_ASSERTION]: the first pass: 144 m from the reading` with `999 !== null`. The four package files together gave 65/65 in this package's sandbox. In WP-E-A's, `node --test client/scene/topography.test.ts client/scene/chaseCamera.test.ts` gave 35/35.
  - 11 more hand-made faults, each caught by 1–4 failing tests: no radius check; the check reversed; the radius in nm or in km; no check for a missing point; latitude and longitude swapped; radians taken as degrees; the point not stored; the longitude not stored; refilled without a point (crash); refilled without a point, keeping the old point.
  - The reviewer's scratch test, run against the new code with the point passed: `null` (unknown) in both cases, and no lift of the rig.
  - `npx tsc --noEmit` is clean for WP-E-A's tree, harness included. `app.ts` still passes its memos without the point, so they are unused there until WP-E-A passes it (Notes). The full suite was not run (the machine was short on CPU). Task 6 counts 631 (630 + 1): computed, not run.
  - The amended code blocks are byte-identical to both sandboxes. The replay was the RED run: the new test block against the old `topography.ts` block, in an isolated copy. Check 7 has not run.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- **Cesium's debug assertions ship in this app** (Vite bundles the unbuilt source): a non-finite factor or relH throws inside `render`. `Topography` checks relH with `Number.isFinite` in `set` and `relatch`. The factor is always computed from finite values: `TOPO_ON`, 0, and `smoothstep`, which never returns NaN. A NaN clock ends the animation on its end value. A test records every write to a fake scene and checks that each one is finite.
- **Tests never touch the network.** The remote terrain branches and `Model.fromGltfAsync` are replaced for one test each with `t.mock.method`, which is restored after the test. `topography.test.ts` loads no Cesium at runtime: its Cesium import is type-only. No test imports `client/scene/viewer.ts` (it imports CSS). Only the harness does.
- **No per-frame allocations:** `update()` reuses one `TerrainFrame`, `ground()` writes into the caller's memo (made once), and `ChaseCamera`'s default `groundAt` closure is created once in the constructor.
- **Heights** are WGS84 ellipsoidal metres (HAE), relH included (KSFO −29.3 m).
- **File ownership:** this package edits files of WP-V1 (`terrain.ts`, `config.test.ts`), WP-V3 (`model.ts`, `model.test.ts`) and WP-V4 (`chaseCamera.ts`, `chaseCamera.test.ts`). No other E package touches them.
- Erasable TypeScript only (`#` private fields, no parameter properties). Relative imports end in `.ts`.
- Code blocks preceded by `File: \`path\`` contain that file's complete content.

## Files owned by this package

| Path | Change |
|---|---|
| `client/scene/topography.ts`, `client/scene/topography.test.ts` | new: `Topography`, `GroundMemo`, `groundMemo`, `pickRelHM`, `TOPO_ANIM_MS`, `NUDGE_DELAY_MS`, `NUDGE`, `HERO_RELH_KM` |
| `harness/topography.html`, `harness/topography.ts` | new: LOWI Nordkette circle, T toggle, ground / clearance / frame-time / picker overlay, `?memo=1` check against the provider's heights, `window.harness` |
| `client/scene/terrain.ts` (WP-V1) | edit: vertex normals on both remote sources, Re:Earth `?extensions=octvertexnormals` |
| `client/config.test.ts` (WP-V1) | edit: two tests for the remote terrain branches (factories mocked) |
| `client/scene/model.ts` (WP-V3) | edit: `enableVerticalExaggeration: false` in `ChaseModel.load` |
| `client/scene/model.test.ts` (WP-V3) | edit: one test for the load options (`Model.fromGltfAsync` mocked) |
| `client/scene/chaseCamera.ts` (WP-V4) | edit: `ChaseCameraOpts.groundAt?` |
| `client/scene/chaseCamera.test.ts` (WP-V4) | edit: two `groundAt` tests |

## Sources (checked 2026-09-22)

Paths are relative to `node_modules/@cesium/engine/Source` (Cesium 1.145.0, engine 26.3.0) unless marked `d.ts` (`node_modules/cesium/Source/Cesium.d.ts`).

| Fact | Source |
|---|---|
| `CesiumTerrainProvider.fromUrl(url: Resource \| string \| …, options?)`, with `requestVertexNormals?` and `requestWaterMask?` (both default false). `createWorldTerrainAsync({ requestVertexNormals?, requestWaterMask? })` is `fromIonAssetId(1, { requestVertexNormals ?? false, requestWaterMask ?? false, ellipsoid })`. `new Resource({ url, queryParameters })`. | d.ts `:3205`, `:3053-3054`, `:19138-19140`, `:15510`, `:15459`; `Core/createWorldTerrainAsync.js:44-48` |
| An extension is requested only when the app asks for it and `layer.json` lists it. ion gets it in the URL query, every other server in the `Accept` header. | `Core/CesiumTerrainProvider.js:931-944`, `:955-962`, `:562` (`getRequestHeader`) |
| `fromUrl` appends a slash to the resource it is given and derives `layer.json` from it. Each layer keeps that resource, and every tile is derived from it. `getDerivedResource` merges the base query into the derived URL, so `?extensions=octvertexnormals` reaches `layer.json` and every tile (Task 1's test derives both, offline). | `Core/CesiumTerrainProvider.js:1224-1241`, `:323-324`, `:950`, `:965-975`; `Core/Resource.js:664-670`, `:415` |
| Re:Earth varies the tile body by `Accept`, sends no `Vary` header and sends `cache-control: public, max-age=2592000`. It honours `?extensions=octvertexnormals`: `layer.json` 200 (1,410 B), level-14 tile 9,641 B with normals against 8,652 B plain. The water mask adds 65,536 B to a tile with land and water. | research B3/B4 (curl of the live endpoint), confirmed by the verifier (VERIFY.md, verify:terrain-quality) |
| `Model.enableVerticalExaggeration` defaults to true and is a `fromGltfAsync` option. The shader moves each vertex by `(h − relH)·(f − 1)`. 1.145 also exaggerates models whose scale is in their matrix. | `Scene/Model/Model.js:361`, `:3293`; d.ts `:40975`, `:41257`; `Shaders/Model/VerticalExaggerationStageVS.glsl:36-37`; `CHANGES.md:25` (#13518) |
| `Scene.verticalExaggeration` and `verticalExaggerationRelativeHeight` are plain numbers, default 1 and 0. A non-finite value throws in the debug build. | `Scene/Scene.js:400`, `:409`; d.ts `:44535`, `:44540`; `Core/VerticalExaggeration.js:20-24` |
| A change of the factor or of relH runs `updateExaggeration` on every loaded tile, which marks the tile's `TerrainPicker` for a rebuild. Crossing exactly 1 adds or removes geodetic normals. | `Scene/GlobeSurfaceTileProvider.js:560-574`; `Scene/GlobeSurfaceTile.js:426-464`; `Core/TerrainMesh.js:359` |
| The picker race: the reset is lazy (next pick) and empties the root's children. A worker result that arrives after a reset skips the missing children but still empties the root, so the tile answers `undefined` until the next change. | `Core/TerrainPicker.js:98-102`, `:238`, `:627-633`; PoC 40/80 → 0/80 with the nudge (design §2) |
| The race also fires during an animation, where every frame changes the factor, and the nudge cannot help there. Under the chased aircraft in the app: `undefined` on 175 frames inside the animation + nudge windows and 1 outside, in runs of up to 37 frames (~0.6 s), in 10 toggles. Hence `GroundMemo`. | Gate GE, 2026-09-23 (WP-E-A Task 5 Step 3, run 2: LOWI replay, headless Chrome on the M2); research A6 |
| The tiles take a new factor inside `render()`, after `scene.preUpdate`, and `globe.getHeight` returns the drawn surface (`number \| undefined`), so a reading in `preUpdate` is one frame late. | `Scene/Scene.js:4621-4627`, `:4519-4528`, `:2079`; `Scene/Globe.js:851`; d.ts `:35457` |
| `sampleTerrainMostDetailed` returns raw provider heights (the harness reference). | `Core/sampleTerrain.js:258`; d.ts `:19435` |
| `t.mock.method(object, name, implementation)` replaces a method for one test and restores it afterwards. | `node_modules/@types/node/test.d.ts:1611-1620`; precedent `client/api.test.ts:141` |

---

### Task 1: Vertex normals with their own cache key

**Files:**
- Modify: `client/scene/terrain.ts`, `client/config.test.ts` (complete new contents below)
- Test: `client/config.test.ts`

**Interfaces:**
- Consumes: `ClientConfig` (WP-00), `readConfig` (WP-V1); Cesium `CesiumTerrainProvider.fromUrl`, `createWorldTerrainAsync`, `Resource`, `Ion`
- Produces: `makeTerrain(cfg: ClientConfig): Promise<TerrainProvider>` (signature unchanged; both remote sources now have `hasVertexNormals`), `REEARTH_TERRAIN_URL` (unchanged)

- [ ] **Step 1: Write the failing test**

File: `client/config.test.ts`
```ts
// client/config.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CesiumTerrainProvider, EllipsoidTerrainProvider, Ion, Resource, UrlTemplateImageryProvider } from 'cesium'
import { readConfig } from './config.ts'
import { EOX_ATTRIBUTION, makeImagery } from './scene/imagery.ts'
import { REEARTH_TERRAIN_URL, makeTerrain } from './scene/terrain.ts'

test('no env at all → keyless defaults (Re:Earth terrain, EOX imagery, /api)', () => {
  assert.deepEqual(readConfig({}), { terrain: 'reearth', imagery: 'eox', ionToken: null, apiBase: '/api' })
})

test('an ion token switches both defaults to ion', () => {
  assert.deepEqual(readConfig({ VITE_CESIUM_ION_TOKEN: 'tok' }), { terrain: 'ion', imagery: 'ion', ionToken: 'tok', apiBase: '/api' })
})

test('explicit choices win over the token-based defaults', () => {
  const c = readConfig({ VITE_CESIUM_ION_TOKEN: 'tok', VITE_TERRAIN: 'reearth', VITE_IMAGERY: 'none' })
  assert.equal(c.terrain, 'reearth')
  assert.equal(c.imagery, 'none')
  assert.equal(c.ionToken, 'tok')
  assert.equal(readConfig({ VITE_TERRAIN: 'ellipsoid' }).terrain, 'ellipsoid')
})

test('empty or blank values count as unset (Vite turns `VITE_X=` into "")', () => {
  assert.deepEqual(readConfig({ VITE_TERRAIN: '', VITE_IMAGERY: ' ', VITE_CESIUM_ION_TOKEN: '  ', VITE_API_BASE: '' }), readConfig({}))
  assert.equal(readConfig({ VITE_CESIUM_ION_TOKEN: ' tok ' }).ionToken, 'tok')
})

test('invalid values throw and name the variable', () => {
  assert.throws(() => readConfig({ VITE_TERRAIN: 'terrarium' }), /VITE_TERRAIN=terrarium/)
  assert.throws(() => readConfig({ VITE_IMAGERY: 'bing' }), /VITE_IMAGERY=bing/)
  assert.throws(() => readConfig({ VITE_TERRAIN: 'Ion', VITE_CESIUM_ION_TOKEN: 'tok' }), /ion \| reearth \| ellipsoid/)
})

test('ion without a token throws instead of silently using the Cesium evaluation token', () => {
  assert.throws(() => readConfig({ VITE_TERRAIN: 'ion' }), /VITE_CESIUM_ION_TOKEN/)
  assert.throws(() => readConfig({ VITE_IMAGERY: 'ion' }), /VITE_CESIUM_ION_TOKEN/)
})

test('apiBase: custom value kept, trailing slashes dropped', () => {
  assert.equal(readConfig({ VITE_API_BASE: 'https://fh.example.net/api/' }).apiBase, 'https://fh.example.net/api')
  assert.equal(readConfig({ VITE_API_BASE: '/api' }).apiBase, '/api')
})

// Provider wiring for the branches that need no network. ion and reearth load in harness/viewer.html; the tests below
// check what they ask for, with Cesium's provider factories mocked (no request is made).
test('offline branches: ellipsoid terrain, no imagery', async () => {
  const cfg = readConfig({ VITE_TERRAIN: 'ellipsoid', VITE_IMAGERY: 'none' })
  assert.ok((await makeTerrain(cfg)) instanceof EllipsoidTerrainProvider)
  assert.equal(await makeImagery(cfg), null)
})

test('EOX imagery: Sentinel-2 cloudless WebMercator template, native zoom cap, attribution on screen', async () => {
  const p = await makeImagery(readConfig({}))
  assert.ok(p instanceof UrlTemplateImageryProvider)
  assert.equal(p.url, 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg')
  assert.equal(p.maximumLevel, 14)
  assert.equal(p.credit.showOnScreen, true)
  assert.match(p.credit.html, /by EOX IT Services GmbH \(Contains modified Copernicus Sentinel data 2025\)/)
  assert.equal(EOX_ATTRIBUTION, 'EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025)')
})

test('Re:Earth terrain: vertex normals, also in the URL query (their own browser-cache key), no water mask', async (t) => {
  const fake = new EllipsoidTerrainProvider()
  const fromUrl = t.mock.method(CesiumTerrainProvider, 'fromUrl', async () => fake)
  assert.equal(await makeTerrain(readConfig({})), fake)
  assert.equal(fromUrl.mock.callCount(), 1)
  const [url, options] = fromUrl.mock.calls[0].arguments
  assert.deepEqual(options, { requestVertexNormals: true })
  assert.ok(url instanceof Resource)
  // What CesiumTerrainProvider does with it: append a slash, derive layer.json, then each tile from its template.
  url.appendForwardSlash()
  assert.equal(url.getDerivedResource({ url: 'layer.json' }).url, `${REEARTH_TERRAIN_URL}/layer.json?extensions=octvertexnormals`)
  const tile = url.getDerivedResource({ url: '{z}/{x}/{y}.terrain', templateValues: { z: 14, x: 17416, y: 12493 } })
  assert.equal(tile.url, `${REEARTH_TERRAIN_URL}/14/17416/12493.terrain?extensions=octvertexnormals`)
})

test('ion terrain: Cesium World Terrain (asset 1) with vertex normals and no water mask, on the configured token', async (t) => {
  const fake = new EllipsoidTerrainProvider()
  const fromIon = t.mock.method(CesiumTerrainProvider, 'fromIonAssetId', async () => fake)
  const token = Ion.defaultAccessToken
  t.after(() => void (Ion.defaultAccessToken = token))
  assert.equal(await makeTerrain(readConfig({ VITE_CESIUM_ION_TOKEN: 'tok' })), fake)
  assert.equal(Ion.defaultAccessToken, 'tok')
  const [assetId, options] = fromIon.mock.calls[0].arguments
  assert.equal(assetId, 1)
  assert.equal(options?.requestVertexNormals, true)
  assert.equal(options?.requestWaterMask, false)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/config.test.ts`
Expected: FAIL — `ℹ tests 11`, `ℹ pass 9`, `ℹ fail 2`:
```
✖ Re:Earth terrain: vertex normals, also in the URL query (their own browser-cache key), no water mask
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected

  + undefined
  - {
  -   requestVertexNormals: true
  - }
✖ ion terrain: Cesium World Terrain (asset 1) with vertex normals and no water mask, on the configured token
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  false !== true
```
`npx tsc --noEmit` is already clean: the test uses only existing exports.

- [ ] **Step 3: Write the implementation**

File: `client/scene/terrain.ts`
```ts
// client/scene/terrain.ts
import { CesiumTerrainProvider, EllipsoidTerrainProvider, Ion, Resource, createWorldTerrainAsync, type TerrainProvider } from 'cesium'
import type { ClientConfig } from '../types.ts'

/**
 * Re:Earth Terrain: keyless quantized-mesh-1.0 with heights on the WGS84 ellipsoid
 * (Mapterhorn DEM + EGM2008 geoid, blended server-side). Its layer.json carries the attribution,
 * which Cesium shows as a credit. Source: https://github.com/reearth/reearth-terrain
 * Checked 2026-09-22: GET <url>/layer.json → 200, format quantized-mesh-1.0, maxzoom 14,
 * extensions octvertexnormals + watermask, CORS *.
 */
export const REEARTH_TERRAIN_URL = 'https://terrain.reearth.land/cesium-mesh/ellipsoid'

/**
 * Terrain for the configured source. All three put heights on the WGS84 ellipsoid (HAE), like RenderState.hM.
 * ion = Cesium World Terrain (asset 1; Community plan, 15 GB/month streaming).
 * Both remote sources send per-vertex normals, which sun lighting needs to shade slopes. No water mask: it adds 64 KB
 * to every tile with both land and water. A provider's normals are fixed when it is built, and nothing rebuilds it
 * (the topography toggle animates scene.verticalExaggeration instead).
 * Rejects when the terrain service cannot be reached: a scene on the wrong datum is worse than none.
 */
export async function makeTerrain(cfg: ClientConfig): Promise<TerrainProvider> {
  if (cfg.terrain === 'ion') {
    if (cfg.ionToken) Ion.defaultAccessToken = cfg.ionToken
    return createWorldTerrainAsync({ requestVertexNormals: true }) // ion requests extensions in the URL query itself
  }
  if (cfg.terrain === 'reearth') {
    // Cesium requests extensions from other servers in the Accept header. Re:Earth varies the tile body by it but
    // sends no Vary header and lets browsers cache tiles for 30 days, so a browser could hand back tiles it cached
    // without normals. The query (which Re:Earth honours too) gives the normals tiles their own URLs: Cesium keeps
    // it on layer.json and on every tile it derives.
    const url = new Resource({ url: REEARTH_TERRAIN_URL, queryParameters: { extensions: 'octvertexnormals' } })
    return CesiumTerrainProvider.fromUrl(url, { requestVertexNormals: true })
  }
  return new EllipsoidTerrainProvider()
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/config.test.ts`
Expected: PASS — `ℹ tests 11`, `ℹ pass 11`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add client/scene/terrain.ts client/config.test.ts
git commit -m "feat(scene): terrain with vertex normals; Re:Earth normals under their own cache key" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The chase model keeps its true height

**Files:**
- Modify: `client/scene/model.ts`, `client/scene/model.test.ts` (complete new contents below)
- Test: `client/scene/model.test.ts`

**Interfaces:**
- Consumes: Cesium `Model.fromGltfAsync({ …, enableVerticalExaggeration })`
- Produces: `ChaseModel.load(viewer, m)` (signature unchanged), now with `model.enableVerticalExaggeration === false`

- [ ] **Step 1: Write the failing test**

File: `client/scene/model.test.ts`
```ts
// client/scene/model.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { Cartesian3, Cartographic, HeadingPitchRoll, Math as CesiumMath, Matrix4, Model, Transforms } from 'cesium'
import type { Viewer } from 'cesium'
import type { Airport } from '../../shared/airports.ts'
import { bearingDeg } from '../../shared/geo.ts'
import type { ModelManifest, RenderState } from '../types.ts'
import { ChaseModel, GLTF_TO_CESIUM, hprFor, measureGlb, modelMatrixFor, noseAzimuthDeg } from './model.ts'

const root = new URL('../../', import.meta.url)
const manifest: ModelManifest = JSON.parse(readFileSync(new URL('public/models/manifest.json', root), 'utf8'))
const m = manifest.models.find((x) => x.id === manifest.default)!
const glbUrl = new URL(`public/${m.uri}`, root)
const axes = measureGlb(readFileSync(glbUrl))
const airports: Airport[] = JSON.parse(readFileSync(new URL('data/fixtures/golden/airports-sample.json', root), 'utf8'))
const KSFO = airports.find((a) => a.ident === 'KSFO')!

const DEG = Math.PI / 180
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${msg} got ${a}, expected ${b} ± ${tol}`)
const azErr = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180)

function state(lat: number, lon: number, hM: number, headingDeg: number, pitchDeg = 0, rollDeg = 0): RenderState {
  return {
    hex: 'abc123', lat, lon, hM, headingDeg, pitchDeg, rollDeg,
    gsKt: null, trackDeg: null, altBaroFt: null, vsFpm: null, mode: 'interp', altSource: 'geom',
    onGround: false, ageS: 0, quality: 'adsb2', callsign: null, typeCode: null,
  }
}

/** Model-frame direction v under modelMatrix, as unit [east, north, up]. Own geodetic formulas, not Cesium's ENU. */
function enu(mm: Matrix4, v: Cartesian3, latDeg: number, lonDeg: number): [number, number, number] {
  const w = Cartesian3.normalize(Matrix4.multiplyByPointAsVector(mm, v, new Cartesian3()), new Cartesian3())
  const [p, l] = [latDeg * DEG, lonDeg * DEG]
  const e = new Cartesian3(-Math.sin(l), Math.cos(l), 0)
  const n = new Cartesian3(-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p))
  const u = new Cartesian3(Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p))
  return [Cartesian3.dot(w, e), Cartesian3.dot(w, n), Cartesian3.dot(w, u)]
}
const azimuth = ([e, n]: [number, number, number]): number => (Math.atan2(e, n) / DEG + 360) % 360

// ---------- the asset: where is the nose? ----------

test("Cesium's glTF axis correction: glTF +Z (front) → +X, +Y (up) → +Z, +X → +Y", () => {
  const map = (x: number, y: number, z: number): Cartesian3 => Matrix4.multiplyByPointAsVector(GLTF_TO_CESIUM, new Cartesian3(x, y, z), new Cartesian3())
  assert.ok(Cartesian3.equalsEpsilon(map(0, 0, 1), Cartesian3.UNIT_X, 1e-12))
  assert.ok(Cartesian3.equalsEpsilon(map(0, 1, 0), Cartesian3.UNIT_Z, 1e-12))
  assert.ok(Cartesian3.equalsEpsilon(map(1, 0, 0), Cartesian3.UNIT_Y, 1e-12))
})

test('measureGlb: Cesium_Air noses +X (fin at the tail), up +Z, right wing −Y', () => {
  assert.ok(Cartesian3.angleBetween(axes.nose, Cartesian3.UNIT_X) / DEG < 0.5, `nose ${axes.nose}`)
  assert.ok(Cartesian3.equalsEpsilon(axes.up, Cartesian3.UNIT_Z, 1e-12))
  assert.ok(Cartesian3.angleBetween(axes.right, new Cartesian3(0, -1, 0)) / DEG < 0.5, `right ${axes.right}`)
  near(axes.lengthM, 21.4, 0.01, 'length')
  near(axes.spanM, 25.74, 0.01, 'span')
  near(axes.belowOriginM, 2.296, 0.001, 'origin → wheels')
})

test('measureGlb rejects bytes that are not a GLB', () => {
  assert.throws(() => measureGlb(new TextEncoder().encode('{"asset":{"version":"2.0"},"nodes":[]}')), /GLB/)
})

test('manifest: default model exists, ≤ 5 MB, has provenance; scale, lengthM and gearHeightM match the geometry', () => {
  assert.ok(m, `default "${manifest.default}" is not in models`)
  assert.ok(statSync(glbUrl).size <= 5 * 1024 * 1024)
  for (const k of ['license', 'author', 'source'] as const) assert.ok(m[k].length > 0, k)
  near(axes.lengthM * m.scale, m.lengthM, 0.05, 'lengthM')
  near(axes.belowOriginM * m.scale, m.gearHeightM, 0.05, 'gearHeightM')
})

// ---------- calibration: the gate G3 checks this is green ----------

test('Cesium convention: HeadingPitchRoll(0, 0, 0) points model +X east; +90° turns it south', () => {
  const p = Cartesian3.fromDegrees(KSFO.lon, KSFO.lat, 0)
  const at = (hDeg: number): number => azimuth(enu(Transforms.headingPitchRollToFixedFrame(p, new HeadingPitchRoll(hDeg * DEG, 0, 0)), Cartesian3.UNIT_X, KSFO.lat, KSFO.lon))
  near(at(0), 90, 1e-9)
  near(at(90), 180, 1e-9)
})

test('hprFor adds forwardAxisFix (−90° for a +X nose) to the state, in radians, with no sign flips', () => {
  assert.deepEqual(m.forwardAxisFix, { headingDeg: -90, pitchDeg: 0, rollDeg: 0 })
  const h = hprFor(state(0, 0, 0, 297.9, 3, -7), m)
  near(h.heading, (297.9 - 90) * DEG, 1e-12)
  near(h.pitch, 3 * DEG, 1e-12)
  near(h.roll, -7 * DEG, 1e-12)
})

for (const hdg of [0, 90, 180, 270, 297.9, 27.7]) {
  test(`heading ${hdg}°: nose azimuth within 1°`, () => {
    const s = state(KSFO.lat, KSFO.lon, 0, hdg)
    const mm = modelMatrixFor(s, m)
    const az = azimuth(enu(mm, axes.nose, s.lat, s.lon))
    assert.ok(azErr(az, hdg) <= 1, `measured nose at ${az}°`)
    assert.ok(azErr(noseAzimuthDeg(mm, axes.nose), hdg) <= 1)
    assert.ok(azErr(noseAzimuthDeg(mm), hdg) <= 1)
  })
}

for (const [ident, trueDeg] of [['28L', 297.9], ['1R', 27.7]] as const) {
  test(`KSFO ${ident} threshold: nose along the runway (${trueDeg}° true) within 1°`, () => {
    const r = KSFO.runways.find((x) => x.ends.some((e) => e.ident === ident))!
    const [thr, far] = r.ends[0].ident === ident ? r.ends : [r.ends[1], r.ends[0]]
    const brg = bearingDeg(thr.thrLat, thr.thrLon, far.thrLat, far.thrLon)
    near(brg, trueDeg, 0.1, 'fixture runway bearing')
    const s = state(thr.thrLat, thr.thrLon, thr.thrHaeM, brg)
    const mm = modelMatrixFor(s, m)
    const az = azimuth(enu(mm, axes.nose, s.lat, s.lon))
    assert.ok(azErr(az, brg) <= 1, `nose ${az}° vs runway ${brg}°`)
    assert.ok(azErr(noseAzimuthDeg(mm, axes.nose), brg) <= 1)
  })
}

test('pitch +10° → nose ENU up = sin 10° ± 0.01 and azimuth unchanged; −10° → nose down', () => {
  for (const hdg of [0, 90, 297.9]) {
    const mm = modelMatrixFor(state(KSFO.lat, KSFO.lon, 300, hdg, 10), m)
    const nose = enu(mm, axes.nose, KSFO.lat, KSFO.lon)
    near(nose[2], Math.sin(10 * DEG), 0.01, `heading ${hdg}: nose up`)
    assert.ok(azErr(azimuth(nose), hdg) <= 1)
  }
  assert.ok(enu(modelMatrixFor(state(KSFO.lat, KSFO.lon, 300, 90, -10), m), axes.nose, KSFO.lat, KSFO.lon)[2] < 0)
})

test('roll +20° → right wing ENU up < 0 (right wing down), nose level; −20° → right wing up', () => {
  for (const hdg of [0, 90, 297.9]) {
    const mm = modelMatrixFor(state(KSFO.lat, KSFO.lon, 300, hdg, 0, 20), m)
    const wing = enu(mm, axes.right, KSFO.lat, KSFO.lon)[2]
    assert.ok(wing < 0, `heading ${hdg}: right wing up component ${wing}`)
    near(wing, -Math.sin(20 * DEG), 0.01)
    near(enu(mm, axes.nose, KSFO.lat, KSFO.lon)[2], 0, 1e-6, 'nose level')
  }
  assert.ok(enu(modelMatrixFor(state(KSFO.lat, KSFO.lon, 300, 90, 0, -20), m), axes.right, KSFO.lat, KSFO.lon)[2] > 0)
})

test('modelMatrixFor: origin at lat/lon and hM + gearHeightM, scale baked in, result reused', () => {
  const out = new Matrix4()
  const mm = modelMatrixFor(state(37.6, -122.4, -28.3, 45, 5, 5), m, out)
  assert.equal(mm, out)
  const c = Cartographic.fromCartesian(Matrix4.getTranslation(mm, new Cartesian3()))
  near(CesiumMath.toDegrees(c.latitude), 37.6, 1e-9)
  near(CesiumMath.toDegrees(c.longitude), -122.4, 1e-9)
  near(c.height, -28.3 + m.gearHeightM, 1e-4)
  near(Matrix4.getMaximumScale(mm), m.scale, 1e-9)
})

// ---------- ChaseModel (Model and Viewer faked: no WebGL in Node) ----------

function fakes(): { viewer: Viewer; added: unknown[]; model: { modelMatrix: Matrix4; show: boolean } } {
  const added: unknown[] = []
  const viewer = {
    scene: { primitives: { add: <T>(p: T): T => (added.push(p), p), remove: (p: unknown): boolean => added.splice(added.indexOf(p), 1).length === 1 } },
  } as unknown as Viewer
  return { viewer, added, model: { modelMatrix: new Matrix4(), show: true } }
}

test('ChaseModel: added hidden; update rewrites modelMatrix in place and shows it; show=false hides; destroy removes', () => {
  const f = fakes()
  const cm = new ChaseModel(f.viewer, m, f.model as unknown as Model)
  assert.deepEqual(f.added, [f.model])
  assert.equal(f.model.show, false)
  cm.show = true
  assert.equal(f.model.show, false, 'not shown before the first update (it would sit at the Earth centre)')

  const same = f.model.modelMatrix
  const s = state(KSFO.lat, KSFO.lon, 0, 297.9)
  cm.update(s)
  assert.equal(f.model.modelMatrix, same)
  assert.ok(Matrix4.equals(f.model.modelMatrix, modelMatrixFor(s, m)))
  assert.equal(f.model.show, true)

  cm.show = false
  cm.update(s)
  assert.equal(f.model.show, false)
  assert.equal(cm.show, false)
  cm.show = true
  assert.equal(f.model.show, true)

  cm.destroy()
  assert.deepEqual(f.added, [])
})

test('ChaseModel.load: the model does not follow terrain exaggeration (keeps its true HAE) and starts hidden', async (t) => {
  const f = fakes()
  const fromGltf = t.mock.method(Model, 'fromGltfAsync', async () => f.model as unknown as Model)
  const cm = await ChaseModel.load(f.viewer, m)
  // Cesium's default would squash the aircraft towards relH with the ground, and flatten it at factor 0.
  assert.deepEqual(fromGltf.mock.calls[0].arguments, [{ url: `/${m.uri}`, minimumPixelSize: 32, show: false, enableVerticalExaggeration: false }])
  assert.equal(cm.model, f.model)
  assert.deepEqual(f.added, [f.model])
  assert.equal(f.model.show, false)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/scene/model.test.ts`
Expected: FAIL — `ℹ tests 19`, `ℹ pass 18`, `ℹ fail 1`:
```
✖ ChaseModel.load: the model does not follow terrain exaggeration (keeps its true HAE) and starts hidden
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected

    [
      {
  -     enableVerticalExaggeration: false,
        minimumPixelSize: 32,
        show: false,
        url: '/models/Cesium_Air.glb'
      }
    ]
```

- [ ] **Step 3: Write the implementation**

File: `client/scene/model.ts`
```ts
// client/scene/model.ts
// WP-V3 model calibration: place the chase model so that its nose points along RenderState.headingDeg.
// The aircraft must never fly sideways. model.test.ts proves it from the GLB's own geometry.
import { Axis, Cartesian3, HeadingPitchRoll, Math as CesiumMath, Matrix4, Model, Quaternion, Transforms } from 'cesium'
import type { Viewer } from 'cesium'
import type { ModelManifestEntry, RenderState } from '../types.ts'

// ---------- glTF geometry in Cesium's model frame ----------

// Model applies this rotation to every glTF 2.0 asset before modelMatrix
// (ModelUtility.getAxisCorrectionMatrix(Axis.Y, Axis.Z) = Axis.Y_UP_TO_Z_UP · Axis.Z_UP_TO_X_UP):
// glTF +Z (the front, per the glTF spec) → +X, glTF +Y (up) → +Z, glTF +X → +Y.
// The Axis matrices exist at runtime but Cesium.d.ts does not declare them, hence the cast.
const axis = Axis as unknown as { Y_UP_TO_Z_UP: Matrix4; Z_UP_TO_X_UP: Matrix4 }
export const GLTF_TO_CESIUM: Matrix4 = Matrix4.multiplyTransformation(axis.Y_UP_TO_Z_UP, axis.Z_UP_TO_X_UP, new Matrix4())

/** A GLB measured in Cesium's model frame (after GLTF_TO_CESIUM, before scale). Axes are unit vectors. */
export interface GlbAxes {
  nose: Cartesian3
  up: Cartesian3
  right: Cartesian3 // nose × up
  lengthM: number // extent along nose
  spanM: number // extent along right
  belowOriginM: number // origin → lowest vertex (wheel bottom)
}

/**
 * Finds the nose from the geometry alone. Up is glTF +Y (the glTF spec). The vertical fin (every vertex in the top
 * quarter of the height) sits at the tail, so the nose is the horizontal direction from the fin's centroid to the
 * bounding-box centre.
 * ponytail: reads dense float VEC3 POSITION from the GLB's BIN chunk only, and refuses any extensionsRequired
 * (Draco, meshopt). Upgrade: decode through Cesium's GltfLoader if a compressed model is ever added.
 */
export function measureGlb(glb: Uint8Array): GlbAxes {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  if (glb.byteLength < 28 || dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(4, true) !== 2) {
    throw new Error('not a glTF 2.0 GLB')
  }
  const jsonLen = dv.getUint32(12, true)
  const gltf = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)))
  if (gltf.extensionsRequired?.length) throw new Error(`unsupported glTF extensions: ${gltf.extensionsRequired.join(', ')}`)
  const binStart = 20 + jsonLen + 8

  const pts: Cartesian3[] = []
  const visit = (i: number, parent: Matrix4): void => {
    const n = gltf.nodes[i]
    const local = n.matrix
      ? Matrix4.fromArray(n.matrix)
      : Matrix4.fromTranslationQuaternionRotationScale(
          Cartesian3.fromArray(n.translation ?? [0, 0, 0]),
          Quaternion.unpack(n.rotation ?? [0, 0, 0, 1]),
          Cartesian3.fromArray(n.scale ?? [1, 1, 1]),
        )
    const world = Matrix4.multiply(parent, local, new Matrix4())
    for (const prim of n.mesh === undefined ? [] : gltf.meshes[n.mesh].primitives) {
      const a = gltf.accessors[prim.attributes.POSITION]
      if (a.componentType !== 5126 || a.type !== 'VEC3' || a.sparse) throw new Error('POSITION must be dense float VEC3')
      const bv = gltf.bufferViews[a.bufferView]
      const stride = bv.byteStride ?? 12
      const base = binStart + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0)
      for (let k = 0; k < a.count; k++) {
        const o = base + k * stride
        const p = new Cartesian3(dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true))
        pts.push(Matrix4.multiplyByPoint(world, p, p))
      }
    }
    for (const c of n.children ?? []) visit(c, world)
  }
  for (const i of gltf.scenes[gltf.scene ?? 0].nodes) visit(i, GLTF_TO_CESIUM)

  let [xMin, xMax, yMin, yMax, zMin, zMax] = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity]
  for (const p of pts) {
    xMin = Math.min(xMin, p.x); xMax = Math.max(xMax, p.x)
    yMin = Math.min(yMin, p.y); yMax = Math.max(yMax, p.y)
    zMin = Math.min(zMin, p.z); zMax = Math.max(zMax, p.z)
  }
  const finZ = zMax - 0.25 * (zMax - zMin)
  let [fx, fy, nf] = [0, 0, 0]
  for (const p of pts) if (p.z >= finZ) { fx += p.x; fy += p.y; nf++ }
  const tailToCentre = new Cartesian3((xMin + xMax) / 2 - fx / nf, (yMin + yMax) / 2 - fy / nf, 0)
  const nose = Cartesian3.normalize(tailToCentre, new Cartesian3())
  const up = Cartesian3.clone(Cartesian3.UNIT_Z)
  const right = Cartesian3.cross(nose, up, new Cartesian3())
  const extent = (v: Cartesian3): number => {
    let [lo, hi] = [Infinity, -Infinity]
    for (const p of pts) { const d = Cartesian3.dot(p, v); lo = Math.min(lo, d); hi = Math.max(hi, d) }
    return hi - lo
  }
  return { nose, up, right, lengthM: extent(nose), spanM: extent(right), belowOriginM: -zMin }
}

// ---------- attitude → Cesium ----------
//
// Cesium's conventions, read from the cesium 1.145 source (@cesium/engine Core/Quaternion.js fromHeadingPitchRoll and
// Core/Transforms.js headingPitchRollToFixedFrame): the matrix is ENU(origin) · Rz(−heading) · Ry(−pitch) · Rx(roll),
// with ENU x = east, y = north, z = up. In the model frame above (nose +X, left wing +Y, up +Z) that means:
// - heading 0 points the nose EAST, and positive heading turns it clockwise seen from above: azimuth = 90° + heading.
//   A model whose nose is +X therefore needs forwardAxisFix.headingDeg = −90.
// - positive pitch raises +X: nose up, the same sign as RenderState.pitchDeg.
// - positive roll lifts +Y (the left wing): right wing down, the same sign as RenderState.rollDeg.
// So hprFor only adds the fix. No sign is flipped.

/** Cesium HeadingPitchRoll (radians) for a RenderState: its attitude plus the model's forwardAxisFix. */
export function hprFor(state: RenderState, m: ModelManifestEntry, result: HeadingPitchRoll = new HeadingPitchRoll()): HeadingPitchRoll {
  const fix = m.forwardAxisFix
  result.heading = CesiumMath.toRadians(state.headingDeg + fix.headingDeg)
  result.pitch = CesiumMath.toRadians(state.pitchDeg + fix.pitchDeg)
  result.roll = CesiumMath.toRadians(state.rollDeg + fix.rollDeg)
  return result
}

const scratchPos = new Cartesian3()
const scratchHpr = new HeadingPitchRoll()

/**
 * World matrix of the chase model: origin at (lat, lon, hM + gearHeightM), attitude from hprFor, uniform m.scale
 * baked in (so ChaseModel leaves Model.scale at 1).
 * ponytail: hM is the wheel-bottom height in every phase, not only on the ground, so touchdown has no gear-height
 * step. Airborne, that bias is smaller than ADS-B's 25 ft altitude step. The offset runs along the ellipsoid normal,
 * not body-up, so at 10° pitch the wheels sit 0.06 m high. Upgrade: offset along body-up when M4 adds ground contact.
 */
export function modelMatrixFor(state: RenderState, m: ModelManifestEntry, result?: Matrix4): Matrix4 {
  const pos = Cartesian3.fromDegrees(state.lon, state.lat, state.hM + m.gearHeightM, undefined, scratchPos)
  const mm = Transforms.headingPitchRollToFixedFrame(pos, hprFor(state, m, scratchHpr), undefined, undefined, result ?? new Matrix4())
  return Matrix4.multiplyByUniformScale(mm, m.scale, mm)
}

const scratchOrigin = new Cartesian3()
const scratchEnu = new Matrix4()
const scratchDir = new Cartesian3()

/** A model-frame direction as a unit vector in ENU (x east, y north, z up) at the model's origin. */
function toEnu(modelMatrix: Matrix4, v: Cartesian3, result: Cartesian3): Cartesian3 {
  const origin = Matrix4.getTranslation(modelMatrix, scratchOrigin)
  const fixedToEnu = Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(origin, undefined, scratchEnu), scratchEnu)
  const world = Matrix4.multiplyByPointAsVector(modelMatrix, v, result)
  return Cartesian3.normalize(Matrix4.multiplyByPointAsVector(fixedToEnu, world, result), result)
}

/**
 * True azimuth of the model's nose in [0, 360), clockwise from north. noseAxis is the nose in Cesium's model frame:
 * +X by Cesium's convention, or measureGlb(glb).nose to check a particular asset.
 */
export function noseAzimuthDeg(modelMatrix: Matrix4, noseAxis: Cartesian3 = Cartesian3.UNIT_X): number {
  const f = toEnu(modelMatrix, noseAxis, scratchDir)
  return (CesiumMath.toDegrees(Math.atan2(f.x, f.y)) + 360) % 360
}

// ---------- the chased model in the scene ----------

/** Manifest uris are relative to public/, so they resolve against Vite's base URL ('/' in Node tests). */
function modelUrl(m: ModelManifestEntry): string {
  return `${import.meta.env?.BASE_URL ?? '/'}${m.uri}`
}

export class ChaseModel {
  readonly model: Model
  private readonly viewer: Viewer
  private readonly m: ModelManifestEntry
  private visible = true
  private placed = false

  /** Prefer ChaseModel.load. Adds the model to the scene hidden: it appears on the first update(), not at the Earth's centre. */
  constructor(viewer: Viewer, m: ModelManifestEntry, model: Model) {
    this.viewer = viewer
    this.m = m
    this.model = model
    model.show = false
    viewer.scene.primitives.add(model)
  }

  static async load(viewer: Viewer, m: ModelManifestEntry): Promise<ChaseModel> {
    // Model clones its own identity modelMatrix, which update() then rewrites. The scale is in modelMatrixFor, so
    // Model.scale stays 1. minimumPixelSize keeps a distant model visible. Cesium exaggerates models with the terrain
    // by default (squashed towards verticalExaggerationRelativeHeight, flat at factor 0); the aircraft keeps its true
    // height while the topography toggle flattens or grows the ground.
    const model = await Model.fromGltfAsync({ url: modelUrl(m), minimumPixelSize: 32, show: false, enableVerticalExaggeration: false })
    return new ChaseModel(viewer, m, model)
  }

  /** Rewrites modelMatrix in place. Model.update compares it with its cached copy on the next frame. */
  update(state: RenderState): void {
    modelMatrixFor(state, this.m, this.model.modelMatrix)
    this.placed = true
    this.model.show = this.visible
  }

  get show(): boolean {
    return this.visible
  }

  set show(v: boolean) {
    this.visible = v
    this.model.show = v && this.placed
  }

  /** Removes the model from the scene. PrimitiveCollection destroys what it removes by default. */
  destroy(): void {
    this.viewer.scene.primitives.remove(this.model)
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/scene/model.test.ts`
Expected: PASS — `ℹ tests 19`, `ℹ pass 19`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add client/scene/model.ts client/scene/model.test.ts
git commit -m "fix(scene): the chase model keeps its true height when the terrain is exaggerated" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `ChaseCamera` measures clearance against `groundAt`

**Files:**
- Modify: `client/scene/chaseCamera.ts`, `client/scene/chaseCamera.test.ts` (complete new contents below)
- Test: `client/scene/chaseCamera.test.ts`

**Interfaces:**
- Consumes: Cesium `Globe.getHeight(c): number | undefined` (the default), `Cartographic`
- Produces: `ChaseCameraOpts.groundAt?: (c: Cartographic) => number | null` (HAE m, `null` while unknown). `ChaseCamera` is otherwise unchanged.

- [ ] **Step 1: Write the failing test**

File: `client/scene/chaseCamera.test.ts`
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

test('groundAt: clearance is kept against the ground it returns (this frame’s drawn ground), not globe.getHeight', () => {
  // Growing relief: globe.getHeight still answers last frame’s surface; the ground drawn this frame is 17 m higher.
  const stale: Terrain = () => 975
  const drawn: Terrain = () => 992
  const { camera, viewer } = fakeViewer(stale)
  const cc = new ChaseCamera(viewer, { pitchDeg: 0, groundAt: (c) => drawn(c) ?? null })
  const { clearanceM } = cc.update(st({ hM: 1000 }), 0.016)
  assert.ok(clearanceM !== null && clearanceM >= 15 && clearanceM < 17, `${clearanceM}`)
  near(clearanceOf(camera, drawn), clearanceM as number, 1e-9)
})

test('groundAt returning null (tile not loaded): clearance null, no correction', () => {
  const { camera, viewer } = fakeViewer(() => 0)
  const { clearanceM } = new ChaseCamera(viewer, { pitchDeg: 0, groundAt: () => null }).update(st({ hM: 1000 }), 0.016)
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

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/scene/chaseCamera.test.ts`
Expected: FAIL — `ℹ tests 20`, `ℹ pass 18`, `ℹ fail 2`. The camera still measures against the stale 975 m (clearance 25 m, so no correction), and against `globe.getHeight` instead of the `null` it was given:
```
✖ groundAt: clearance is kept against the ground it returns (this frame’s drawn ground), not globe.getHeight
  AssertionError [ERR_ASSERTION]: 25.001844686931236
✖ groundAt returning null (tile not loaded): clearance null, no correction
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected

  + 1000.0018446869312
  - null
```

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/chaseCamera'`
Expected:
```
client/scene/chaseCamera.test.ts(171,53): error TS2353: Object literal may only specify known properties, and 'groundAt' does not exist in type 'ChaseCameraOpts'.
client/scene/chaseCamera.test.ts(171,64): error TS7006: Parameter 'c' implicitly has an 'any' type.
client/scene/chaseCamera.test.ts(179,65): error TS2353: Object literal may only specify known properties, and 'groundAt' does not exist in type 'ChaseCameraOpts'.
```

- [ ] **Step 3: Write the implementation**

File: `client/scene/chaseCamera.ts`
```ts
// client/scene/chaseCamera.ts
import { Cartesian3, Ellipsoid, HeadingPitchRange, Matrix4, ScreenSpaceEventHandler, ScreenSpaceEventType, Transforms } from 'cesium'
import type { Camera, Cartographic, Scene, Viewer } from 'cesium'
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
  /**
   * Ground height (HAE m) under a point, null while unknown. Default: globe.getHeight. The app passes the ground drawn
   * this frame, because globe.getHeight lags one frame behind the topography animation (Topography.ground). Called once
   * per clearance pass, up to 5 times a frame, each time at the camera's new position.
   */
  groundAt?: (c: Cartographic) => number | null
}

/**
 * Third-person camera on one aircraft, heading-damped, kept ≥ minClearanceM above the loaded terrain.
 * While chasing, mouse input orbits (drag), zooms (wheel) and resets (double-click) instead of moving the globe.
 */
export class ChaseCamera {
  readonly orbit: OrbitControl
  #camera: Camera
  #scene: Scene
  #groundAt: (c: Cartographic) => number | null
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
    const globe = viewer.scene.globe
    this.#groundAt = opts.groundAt ?? ((c) => globe.getHeight(c) ?? null)
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

  /** Put the camera on the target's ENU frame; returns camera height − ground height, null while the ground is unknown. */
  #place(state: RenderState, headingDeg: number, pitchDeg: number, liftM: number): number | null {
    Cartesian3.fromDegrees(state.lon, state.lat, state.hM + liftM, Ellipsoid.WGS84, this.#target)
    Transforms.eastNorthUpToFixedFrame(this.#target, Ellipsoid.WGS84, this.#frame)
    this.#hpr.heading = headingDeg * RAD
    this.#hpr.pitch = pitchDeg * RAD
    this.#hpr.range = this.orbit.rangeM
    this.#camera.lookAtTransform(this.#frame, this.#hpr)
    const c = this.#camera.positionCartographic
    const ground = this.#groundAt(c)
    return ground === null ? null : c.height - ground
  }
}

const wrap360 = (deg: number): number => ((deg % 360) + 360) % 360
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/scene/chaseCamera.test.ts`
Expected: PASS — `ℹ tests 20`, `ℹ pass 20`, `ℹ fail 0`.

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/chaseCamera'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 5: Commit**

```bash
git add client/scene/chaseCamera.ts client/scene/chaseCamera.test.ts
git commit -m "feat(scene): ChaseCamera groundAt option for the lag-corrected ground" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `Topography` and `pickRelHM`

**Files:**
- Create: `client/scene/topography.ts`, `client/scene/topography.test.ts`
- Test: `client/scene/topography.test.ts`

**Interfaces:**
- Consumes: `TOPO_ON`, `rescaleSampledM`, `smoothstep` (and `drawnHeightM` in the test) from `client/scene/exaggeration.ts`; `TerrainFrame` from `client/types.ts` (WP-E0); `Airport` (`shared/airports.ts`), `distanceNm` (`shared/geo.ts`); `public/airports/heroes.json` in the test
- Produces:
  - `class Topography`:
    - `constructor(scene: Pick<Scene, 'verticalExaggeration' | 'verticalExaggerationRelativeHeight'>, on: boolean, opts?: { durationMs?: number; nudgeDelayMs?: number })`
    - `get on(): boolean`, `get relHM(): number`, `get animating(): boolean`
    - `set(on: boolean, nowMs: number, relHM: number): void`
    - `relatch(relHM: number): void`
    - `update(nowMs: number): TerrainFrame` (one reused object)
    - `ground(sampledM: number | undefined, frame: TerrainFrame, memo?: GroundMemo, at?: Pick<Cartographic, 'latitude' | 'longitude'>): number | null`
  - `interface GroundMemo { m: number; f: number; relHM: number; lat: number; lon: number; ok: boolean }` and `groundMemo(): GroundMemo` (empty: `ok` false)
  - `pickRelHM(lat: number, lon: number, drawnGroundM: number | null, airports: readonly Airport[]): number`
  - `TOPO_ANIM_MS = 2500`, `NUDGE_DELAY_MS = 500`, `NUDGE = 1e-7`, `HERO_RELH_KM = 30`

- [ ] **Step 1: Write the failing test**

File: `client/scene/topography.test.ts`
```ts
// client/scene/topography.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Airport } from '../../shared/airports.ts'
import { destination } from '../../shared/geo.ts'
import { TOPO_ON, drawnHeightM, smoothstep } from './exaggeration.ts'
import { HERO_RELH_KM, NUDGE, NUDGE_DELAY_MS, TOPO_ANIM_MS, Topography, groundMemo, pickRelHM } from './topography.ts'

const heroes: Airport[] = JSON.parse(readFileSync(new URL('../../public/airports/heroes.json', import.meta.url), 'utf8'))
const hero = (ident: string): Airport => heroes.find((a) => a.ident === ident)!
const [LOWI, KSFO, LLBG] = [hero('LOWI'), hero('KSFO'), hero('LLBG')]
const LOWI_RWY = 627.72 // mean of the runway 08 and 26 threshold heights, HAE (629.72, 625.72)
const NORDKETTE = 2_317.9 // true HAE of a point high on the ridge north of LOWI
const KM_PER_NM = 1.852
const RAD = Math.PI / 180
const RIDGE = { latitude: 47.3104 * RAD, longitude: 11.3787 * RAD } // where a memo is read: radians, as a Cartographic

function near(actual: number | null, expected: number, tol: number): void {
  assert.ok(actual !== null && Math.abs(actual - expected) <= tol, `${actual} ≠ ${expected} ± ${tol}`)
}

/** The two Scene fields Topography owns, recording every write (Cesium's debug build throws on a non-finite one). */
function fakeScene() {
  const writes: number[] = []
  let f = 1 // Cesium's defaults
  let rel = 0
  return {
    writes,
    get verticalExaggeration(): number { return f },
    set verticalExaggeration(v: number) { writes.push(v); f = v },
    get verticalExaggerationRelativeHeight(): number { return rel },
    set verticalExaggerationRelativeHeight(v: number) { writes.push(v); rel = v },
  }
}

test('constructor sets the factor at once: TOPO_ON (never exactly 1) or 0 (flat), around relH 0', () => {
  const s = fakeScene()
  const topo = new Topography(s, true)
  assert.equal(s.verticalExaggeration, TOPO_ON)
  assert.equal(s.verticalExaggerationRelativeHeight, 0)
  assert.deepEqual([topo.on, topo.animating, topo.relHM], [true, false, 0])
  const flat = fakeScene()
  const off = new Topography(flat, false)
  assert.equal(flat.verticalExaggeration, 0)
  assert.equal(off.on, false)
  assert.deepEqual({ ...off.update(0) }, { fSampled: 0, fNow: 0, relHM: 0 })
  assert.equal(TOPO_ANIM_MS, 2500)
})

test('a flatten: smoothstep over 2.5 s around the latched relH, exactly 0 at the end; fSampled is the previous fNow', () => {
  const s = fakeScene()
  const topo = new Topography(s, true)
  const idle = topo.update(0)
  topo.set(false, 1_000, LOWI_RWY)
  assert.deepEqual([topo.on, topo.animating, topo.relHM], [false, true, LOWI_RWY])
  let prev = TOPO_ON
  for (const t of [1_000, 1_625, 2_250, 2_875, 3_499]) {
    const fr = topo.update(t)
    assert.equal(fr, idle, 'one reused object')
    assert.equal(fr.fSampled, prev)
    near(fr.fNow, TOPO_ON * (1 - smoothstep((t - 1_000) / TOPO_ANIM_MS)), 1e-12)
    assert.equal(fr.relHM, LOWI_RWY)
    assert.equal(s.verticalExaggeration, fr.fNow)
    assert.equal(s.verticalExaggerationRelativeHeight, LOWI_RWY)
    prev = fr.fNow
  }
  assert.ok(prev > 0 && prev < 1e-6, `${prev}`)
  const end = topo.update(3_500)
  assert.deepEqual([end.fSampled, end.fNow, topo.animating], [prev, 0, false])
})

test('the nudge: 0.5 s after an animation ends the factor gains 1e-7, once (the TerrainPicker race)', () => {
  assert.deepEqual([NUDGE, NUDGE_DELAY_MS], [1e-7, 500])
  const s = fakeScene()
  const topo = new Topography(s, true)
  topo.set(false, 0, LOWI_RWY)
  assert.equal(topo.update(2_500).fNow, 0)
  assert.equal(topo.update(2_999).fNow, 0)
  const nudged = topo.update(3_000)
  assert.deepEqual([nudged.fSampled, nudged.fNow], [0, NUDGE])
  for (const t of [3_001, 4_000, 60_000]) assert.equal(topo.update(t).fNow, NUDGE)
  // Growing back ends exactly on TOPO_ON, around the same plane, and is nudged the same way.
  topo.set(true, 70_000, 5)
  assert.equal(topo.relHM, LOWI_RWY, 'growing never moves relH')
  assert.equal(topo.update(72_499).relHM, LOWI_RWY)
  assert.equal(topo.update(72_500).fNow, TOPO_ON)
  assert.equal(topo.update(72_999).fNow, TOPO_ON)
  assert.equal(topo.update(73_000).fNow, TOPO_ON + NUDGE)
  assert.equal(topo.update(90_000).fNow, TOPO_ON + NUDGE)
  assert.equal(s.verticalExaggeration, TOPO_ON + NUDGE)
})

test('set is a no-op when unchanged; a new animation cancels a pending nudge', () => {
  const s = fakeScene()
  const topo = new Topography(s, true)
  topo.set(true, 0, 999)
  assert.deepEqual({ ...topo.update(10) }, { fSampled: TOPO_ON, fNow: TOPO_ON, relHM: 0 })
  topo.set(false, 100, LOWI_RWY)
  topo.set(false, 1_100, 700) // T again while sinking: nothing restarts, the plane stays
  near(topo.update(1_350).fNow, TOPO_ON / 2, 1e-12)
  assert.equal(topo.relHM, LOWI_RWY)
  assert.equal(topo.update(2_600).fNow, 0)
  topo.set(true, 2_700, 0) // before the nudge due at 3,100
  near(topo.update(3_100).fNow, TOPO_ON * smoothstep(400 / TOPO_ANIM_MS), 1e-15)
  assert.equal(topo.update(5_200).fNow, TOPO_ON)
  assert.equal(topo.update(5_700).fNow, TOPO_ON + NUDGE)
})

test('a reversal mid-animation continues from the current factor and keeps relH', () => {
  const topo = new Topography(fakeScene(), true)
  topo.set(false, 0, LOWI_RWY)
  const half = topo.update(1_250).fNow
  near(half, TOPO_ON / 2, 1e-12)
  topo.set(true, 1_250, 5_000)
  assert.deepEqual([topo.on, topo.animating, topo.relHM], [true, true, LOWI_RWY])
  assert.equal(topo.update(1_250).fNow, half, 'no jump')
  near(topo.update(2_500).fNow, half + (TOPO_ON - half) / 2, 1e-12)
  assert.equal(topo.update(3_750).fNow, TOPO_ON)
  // Reversing a grow keeps the plane too.
  const flat = new Topography(fakeScene(), false)
  flat.relatch(LOWI_RWY)
  flat.set(true, 0, 1)
  const partial = flat.update(1_000).fNow
  flat.set(false, 1_000, 42)
  assert.equal(flat.relHM, LOWI_RWY)
  assert.equal(flat.update(1_000).fNow, partial)
  assert.equal(flat.update(3_500).fNow, 0)
})

test('relatch: only while fully flat and idle; it moves the plane and re-arms the pickers 0.5 s later', () => {
  const s = fakeScene()
  const topo = new Topography(s, true)
  topo.relatch(LOWI_RWY) // on: ignored
  assert.equal(topo.update(0).relHM, 0)
  topo.set(false, 0, 100)
  topo.relatch(LOWI_RWY) // sinking: ignored
  assert.equal(topo.update(2_500).relHM, 100)
  assert.equal(topo.update(3_000).fNow, NUDGE)
  topo.relatch(LOWI_RWY) // a new selection while flat
  assert.equal(topo.relHM, LOWI_RWY)
  const fr = topo.update(4_000)
  assert.deepEqual([fr.fNow, fr.relHM, s.verticalExaggerationRelativeHeight], [NUDGE, LOWI_RWY, LOWI_RWY])
  assert.equal(topo.update(4_499).fNow, NUDGE)
  assert.equal(topo.update(4_500).fNow, 0, 'the re-arm flips the nudge back: the factor never creeps')
  assert.equal(topo.update(9_000).fNow, 0)
  topo.relatch(Number.NaN)
  topo.relatch(Number.POSITIVE_INFINITY)
  assert.equal(topo.relHM, LOWI_RWY)
  topo.relatch(LOWI_RWY) // unchanged: nothing to re-arm
  assert.equal(topo.update(10_000).fNow, 0)
  assert.equal(topo.update(20_000).fNow, 0)
  topo.set(true, 30_000, 0)
  topo.relatch(1) // growing: ignored
  assert.equal(topo.update(31_000).relHM, LOWI_RWY)
  topo.update(40_000)
  topo.relatch(2) // on: ignored
  assert.equal(topo.update(41_000).relHM, LOWI_RWY)
})

test('never writes a non-finite value: a NaN relH is ignored, a NaN clock ends the animation on its end value', () => {
  const s = fakeScene()
  const topo = new Topography(s, true)
  topo.set(false, 0, Number.NaN)
  assert.equal(topo.relHM, 0)
  assert.ok(topo.update(1_000).fNow > 0)
  assert.equal(topo.update(Number.NaN).fNow, 0)
  assert.equal(topo.animating, false)
  topo.set(true, Number.NaN, 0)
  assert.equal(topo.update(5_000).fNow, TOPO_ON)
  topo.set(false, 6_000, Number.POSITIVE_INFINITY)
  topo.update(7_000)
  assert.equal(topo.relHM, 0)
  assert.ok(s.writes.length > 0 && s.writes.every(Number.isFinite), `${s.writes}`)
})

test('ground: undefined → null; a globe.getHeight reading → the ground drawn this frame', () => {
  const topo = new Topography(fakeScene(), true)
  assert.equal(topo.ground(undefined, { fSampled: 1, fNow: 1, relHM: 0 }), null)
  topo.set(false, 0, LOWI_RWY)
  topo.update(0)
  for (const t of [600, 1_250, 1_900]) {
    const fr = topo.update(t)
    const sampled = drawnHeightM(NORDKETTE, fr.fSampled, fr.relHM) // what the tiles held when getHeight ran
    near(topo.ground(sampled, fr), drawnHeightM(NORDKETTE, fr.fNow, fr.relHM), 1e-9)
  }
  // Flat: the plane, whatever the picker's few-cm error.
  assert.equal(topo.ground(LOWI_RWY - 0.03, { fSampled: NUDGE, fNow: NUDGE, relHM: LOWI_RWY }), LOWI_RWY)
})

test('ground with a memo: undefined readings (the picker race) follow the grow from the last one; no memo → null', () => {
  const topo = new Topography(fakeScene(), false)
  topo.relatch(LOWI_RWY)
  topo.set(true, 0, 0)
  const memo = groundMemo()
  assert.equal(topo.ground(undefined, topo.update(0), memo, RIDGE), null, 'nothing read yet')
  topo.update(600)
  let fr = topo.update(616)
  near(topo.ground(drawnHeightM(NORDKETTE, fr.fSampled, LOWI_RWY), fr, memo, RIDGE), drawnHeightM(NORDKETTE, fr.fNow, LOWI_RWY), 1e-9)
  // Gate GE: runs of up to 37 undefined frames inside the animation and nudge windows. A fixed point's drawn height
  // follows the factor, so the memo stays exact through the grow, its end and the nudge.
  for (let t = 632; t <= 3_200; t += 16) {
    fr = topo.update(t)
    near(topo.ground(undefined, fr, memo, RIDGE), drawnHeightM(NORDKETTE, fr.fNow, LOWI_RWY), 1e-9)
    assert.equal(topo.ground(undefined, fr), null, 'no memo: null, as before')
  }
  assert.equal(fr.fNow, TOPO_ON + NUDGE)
})

test('ground with a memo: a new plane (relH) drops it, the next reading refills it, ok = false forgets it', () => {
  const topo = new Topography(fakeScene(), true)
  const memo = groundMemo()
  near(topo.ground(NORDKETTE, topo.update(0), memo, RIDGE), NORDKETTE, 1e-9) // on, at rest, around relH 0
  topo.set(false, 100, LOWI_RWY) // the flatten latches LOWI's runway height
  let fr = topo.update(116)
  assert.equal(topo.ground(undefined, fr, memo, RIDGE), null, 'read around the old plane')
  topo.update(1_000)
  fr = topo.update(1_016)
  topo.ground(drawnHeightM(NORDKETTE, fr.fSampled, LOWI_RWY), fr, memo, RIDGE)
  for (const t of [1_032, 2_000, 2_600, 3_100]) { // through the end of the sink (relH) and the nudge (1e-7)
    fr = topo.update(t)
    near(topo.ground(undefined, fr, memo, RIDGE), drawnHeightM(NORDKETTE, fr.fNow, LOWI_RWY), 1e-9)
  }
  assert.equal(fr.fNow, NUDGE)
  memo.ok = false // a new selection
  assert.equal(topo.ground(undefined, fr, memo, RIDGE), null)
})

test('ground with a memo: a flat reading holds no relief: the plane while flat, null once the relief grows', () => {
  const topo = new Topography(fakeScene(), false)
  topo.relatch(LOWI_RWY)
  const memo = groundMemo()
  let fr = topo.update(0)
  assert.equal(topo.ground(LOWI_RWY - 0.03, fr, memo, RIDGE), LOWI_RWY) // read while flat: the last one before any grow
  assert.equal(topo.ground(undefined, topo.update(1_000), memo, RIDGE), LOWI_RWY, 'still flat (the nudge): the plane')
  topo.set(true, 2_000, 0)
  assert.equal(topo.ground(undefined, topo.update(2_000), memo, RIDGE), LOWI_RWY, "the grow's first frame is still flat")
  // Gate GE's longest run, 37 frames: the relief is unknown. relH would be 239 m low under the Nordkette by the last.
  for (let t = 2_016; t <= 2_592; t += 16) assert.equal(topo.ground(undefined, topo.update(t), memo, RIDGE), null, `${t}`)
  fr = topo.update(2_608) // the next reading refills the memo, which follows the grow again
  near(topo.ground(drawnHeightM(NORDKETTE, fr.fSampled, LOWI_RWY), fr, memo, RIDGE), drawnHeightM(NORDKETTE, fr.fNow, LOWI_RWY), 1e-9)
  fr = topo.update(2_624)
  near(topo.ground(undefined, fr, memo, RIDGE), drawnHeightM(NORDKETTE, fr.fNow, LOWI_RWY), 1e-9)
})

test('ground with a memo: it answers only within 50 m of where it was read (the chase camera reads several points)', () => {
  // ChaseCamera reads the ground once per clearance pass. At its default 150 m range it starts 147 m south of a
  // northbound aircraft; over the valley approach's slope (chaseCamera.test.ts) it ends almost above it, and the next
  // frame starts again 147 m south. One memo serves all of these points.
  const south = (m: number, eastM = 0) => {
    const s = destination(LOWI.lat, LOWI.lon, 180, m / 1000 / KM_PER_NM)
    const p = destination(s.lat, s.lon, 90, eastM / 1000 / KM_PER_NM)
    return { latitude: p.lat * RAD, longitude: p.lon * RAD }
  }
  const slope = (m: number): number => 990 + 3 * m // the terrain m metres south
  const topo = new Topography(fakeScene(), true)
  const memo = groundMemo()
  let fr = topo.update(0)
  near(topo.ground(slope(147), fr, memo, south(147)), slope(147), 1e-9) // the first pass
  near(topo.ground(slope(3), fr, memo, south(3)), slope(3), 1e-9) // the last pass: the camera is now clear
  fr = topo.update(16) // the picker race: every reading undefined
  assert.equal(topo.ground(undefined, fr, memo, south(147)), null, 'the first pass: 144 m from the reading')
  near(topo.ground(undefined, fr, memo, south(52)), slope(3), 1e-9) // 49 m
  near(topo.ground(undefined, fr, memo, south(3, 40)), slope(3), 1e-9) // 40 m east: the orbit swings round
  assert.equal(topo.ground(undefined, fr, memo, south(54)), null, '51 m')
  assert.equal(topo.ground(undefined, fr, memo), null, 'no point: the memo is not used')
  // The first pass reads, the second does not: the first pass's ground is not the second's.
  topo.ground(slope(147), fr, memo, south(147))
  assert.equal(topo.ground(undefined, fr, memo, south(3)), null)
  topo.ground(slope(3), fr, memo, south(3))
  topo.ground(slope(147), fr, memo) // a reading without its point leaves the memo alone
  near(topo.ground(undefined, fr, memo, south(3)), slope(3), 1e-9)
})

test('pickRelHM: within 30 km of a hero → the mean of its runway threshold heights (HAE)', () => {
  assert.equal(HERO_RELH_KM, 30)
  const ridge = destination(LOWI.lat, LOWI.lon, 0, 6 / KM_PER_NM) // the harness circle's northern point
  near(pickRelHM(ridge.lat, ridge.lon, 2_100, heroes), LOWI_RWY, 1e-9)
  near(pickRelHM(KSFO.lat, KSFO.lon, -32, heroes), -29.3175, 1e-9) // below the ellipsoid
  near(pickRelHM(LLBG.lat, LLBG.lon, null, heroes), 56.57, 1e-9)
  const inside = destination(LOWI.lat, LOWI.lon, 90, 29.9 / KM_PER_NM)
  near(pickRelHM(inside.lat, inside.lon, 900, heroes), LOWI_RWY, 1e-9)
  const outside = destination(LOWI.lat, LOWI.lon, 90, 30.1 / KM_PER_NM)
  assert.equal(pickRelHM(outside.lat, outside.lon, 900, heroes), 900)
})

test('pickRelHM elsewhere: the drawn ground under the aircraft, else 0 (the ellipsoid); never NaN', () => {
  const EDDM = { lat: 48.3538, lon: 11.7861 } // Munich: 125 km from LOWI, no hero
  assert.equal(pickRelHM(EDDM.lat, EDDM.lon, 493.2, heroes), 493.2)
  assert.equal(pickRelHM(EDDM.lat, EDDM.lon, null, heroes), 0)
  assert.equal(pickRelHM(EDDM.lat, EDDM.lon, Number.NaN, heroes), 0)
  assert.equal(pickRelHM(Number.NaN, Number.NaN, 493.2, heroes), 493.2)
  assert.equal(pickRelHM(LOWI.lat, LOWI.lon, 600, []), 600)
})

test('pickRelHM: the nearest airport wins; one without runways is skipped', () => {
  const at = (km: number) => destination(LOWI.lat, LOWI.lon, 90, km / KM_PER_NM)
  const [e0, e1] = LOWI.runways[0].ends
  const east: Airport = { ...LOWI, ident: 'XEST', ...at(20), runways: [{ ...LOWI.runways[0], ends: [{ ...e0, thrHaeM: 700 }, { ...e1, thrHaeM: 710 }] }] }
  const heliport: Airport = { ...LOWI, ident: 'XHEL', ...at(14), runways: [] }
  const list = [...heroes, east, heliport]
  near(pickRelHM(at(15).lat, at(15).lon, null, list), 705, 1e-9)
  near(pickRelHM(at(5).lat, at(5).lon, null, list), LOWI_RWY, 1e-9)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/scene/topography.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/scene/topography.ts' imported from …/client/scene/topography.test.ts`, then `ℹ tests 1`, `ℹ fail 1`.

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/topography'`
Expected:
```
client/scene/topography.test.ts(8,102): error TS2307: Cannot find module './topography.ts' or its corresponding type declarations.
```

- [ ] **Step 3: Write the implementation**

File: `client/scene/topography.ts`
```ts
// client/scene/topography.ts
// The topography toggle (design D2–D5): the relief grows out of the flat map and sinks back by animating
// scene.verticalExaggeration. The imagery stays draped; aircraft keep their true heights, only the ground moves.
import type { Cartographic, Scene } from 'cesium'
import type { Airport } from '../../shared/airports.ts'
import { distanceNm } from '../../shared/geo.ts'
import type { TerrainFrame } from '../types.ts'
import { TOPO_ON, rescaleSampledM, smoothstep } from './exaggeration.ts'

export const TOPO_ANIM_MS = 2500 // grow / sink duration (smoothstep)
export const NUDGE_DELAY_MS = 500 // PoC: the pickers' workers are idle by then
export const NUDGE = 1e-7
export const HERO_RELH_KM = 30 // a hero airport this close gives the flat plane its runway height
const KM_PER_NM = 1.852
const DEG = 180 / Math.PI
const FLAT_F = 1e-4 // a factor below this draws a flat ground: exaggeration.ts's FLAT_F, which it does not export
const MEMO_RADIUS_M = 50 // a memo answers this close to where it was read: gate GE's longest run at 70 m/s is 43 m

type ExaggeratedScene = Pick<Scene, 'verticalExaggeration' | 'verticalExaggerationRelativeHeight'> // a Scene, or a test fake
type GroundPoint = Pick<Cartographic, 'latitude' | 'longitude'> // a Cartographic, or a test's plain point (radians)

/**
 * The last globe.getHeight reading under one followed point (the chased aircraft, or the chase camera), kept by
 * Topography.ground with the point it was read at. Make one per point, once (groundMemo()); set ok = false to forget
 * it (a new selection).
 */
export interface GroundMemo {
  m: number // the reading: drawn height, HAE m
  f: number // the factor the tiles held when it was read (that frame's fSampled)
  relHM: number // the plane it was read around (that frame's relHM)
  lat: number // where it was read, radians
  lon: number
  ok: boolean // false until the first reading, and after a reset
}

/** An empty memo for Topography.ground. */
export function groundMemo(): GroundMemo {
  return { m: 0, f: 0, relHM: 0, lat: 0, lon: 0, ok: false }
}

/**
 * The only writer of scene.verticalExaggeration and scene.verticalExaggerationRelativeHeight (relH, the height the
 * relief flattens towards). The factor is TOPO_ON while on (never exactly 1: crossing 1 rebuilds every loaded tile)
 * and 0 while flat. Call update() first in scene.preUpdate, before any globe.getHeight.
 *
 * The nudge works around a race in Cesium's TerrainPicker: every factor or relH change resets each tile's picker, and
 * a picker worker that returns after a reset can leave the tile answering globe.getHeight with undefined until the
 * next change (PoC: 40 of 80 readings under the aircraft after animations). So once the workers are idle, 0.5 s after
 * an animation or a re-latch, the factor changes once more by 1e-7 (PoC: 0 of 80). During an animation every frame is
 * a change, so readings still fail there (gate GE: 175 frames in 10 toggles, runs of up to 37): ground() bridges them
 * with a GroundMemo.
 */
export class Topography {
  #scene: ExaggeratedScene
  #durationMs: number
  #nudgeDelayMs: number
  #frame: TerrainFrame = { fSampled: 0, fNow: 0, relHM: 0 }
  #on: boolean
  #f: number // factor written last, the one the tiles hold on the next preUpdate
  #relH = 0 // the ellipsoid until the first latch
  #from = 0
  #to: number
  #t0: number | null = null // animation start; null at rest
  #nudgeAt: number | null = null

  /** Starts at rest, on (TOPO_ON) or flat (0). */
  constructor(scene: ExaggeratedScene, on: boolean, opts: { durationMs?: number; nudgeDelayMs?: number } = {}) {
    this.#scene = scene
    this.#on = on
    this.#f = this.#to = on ? TOPO_ON : 0
    this.#durationMs = opts.durationMs ?? TOPO_ANIM_MS
    this.#nudgeDelayMs = opts.nudgeDelayMs ?? NUDGE_DELAY_MS
    scene.verticalExaggeration = this.#f
  }

  get on(): boolean {
    return this.#on
  }

  /** relH (HAE m), drawn from the next update() on. */
  get relHM(): number {
    return this.#relH
  }

  get animating(): boolean {
    return this.#t0 !== null
  }

  /**
   * Grow (true) or flatten (false), animated from the current factor, so a reversal mid-animation has no jump.
   * A flatten from rest latches relHM (pickRelHM) as the flat plane; mid-animation, and when growing, the plane stays.
   */
  set(on: boolean, nowMs: number, relHM: number): void {
    if (on === this.#on) return
    if (!on && this.#t0 === null && Number.isFinite(relHM)) this.#relH = relHM
    this.#on = on
    this.#from = this.#f
    this.#to = on ? TOPO_ON : 0
    this.#t0 = nowMs
  }

  /** A new plane while fully flat and at rest (a new selection, D4). Ignored otherwise: the relief would jump. */
  relatch(relHM: number): void {
    if (!this.#on && this.#t0 === null && Number.isFinite(relHM)) this.#relH = relHM
  }

  /**
   * Advances the animation and writes both values. Returns the frame's factors and relH in one object that is reused
   * every frame: read it during the frame, never keep it.
   */
  update(nowMs: number): TerrainFrame {
    const fr = this.#frame
    fr.fSampled = this.#f
    if (this.#t0 !== null) {
      // ponytail: a stall (hidden tab) skips ahead by its length, so the ground correction spans a large factor step
      // for one frame (see rescaleSampledM). Upgrade: move #t0 forward by the stall.
      const u = (nowMs - this.#t0) / this.#durationMs
      if (u < 1) this.#f = this.#from + (this.#to - this.#from) * smoothstep(u)
      else {
        // Also for a NaN clock: the animation ends on its exact end value, never on NaN.
        this.#f = this.#to
        this.#t0 = null
        this.#nudgeAt = nowMs + this.#nudgeDelayMs
      }
    } else if (this.#nudgeAt !== null && nowMs >= this.#nudgeAt) {
      // Toggles between the end value and 1e-7 above it, so re-latches never add up.
      this.#f = this.#f === this.#to ? this.#to + NUDGE : this.#to
      this.#nudgeAt = null
    }
    const s = this.#scene
    if (s.verticalExaggerationRelativeHeight !== this.#relH) {
      s.verticalExaggerationRelativeHeight = this.#relH
      if (this.#t0 === null) this.#nudgeAt = nowMs + this.#nudgeDelayMs // a relH change resets the pickers too
    }
    s.verticalExaggeration = this.#f
    fr.fNow = this.#f
    fr.relHM = this.#relH
    return fr
  }

  /**
   * A globe.getHeight reading at `at`, taken this frame (it reflects the previous render's factor) → the ground drawn
   * this frame. undefined (tile not loaded, or the picker race) → null, or, with a memo read around the same plane
   * within 50 m of `at`, the memo's reading rescaled to this frame's factor. A defined reading refills the memo; a memo
   * without the point is neither read nor refilled. A fixed point's drawn height follows the factor exactly, so the
   * memo's error is the ground's change between where it was read and `at`, at most 50 m apart. Farther it answers
   * null: the chase camera reads up to five points a frame, up to 2.9 km apart. A memo read while flat holds no relief:
   * it answers the plane while this frame is flat too, and null (unknown) once the relief grows.
   * ponytail: a grow from flat starts with a flat memo, so a run of undefined readings from its start leaves the ground
   * unknown: the aircraft keeps its estimate and the chase camera has no clearance correction, so it can clip a rising
   * slope for up to the run's length (gate GE: 37 frames, ~0.6 s). A memo read in a grow's first frames multiplies the
   * picker's own error (0.3 mm for 100 m triangles, 3 mm for 300 m) by fNow/f, up to ~1,300 over a 37-frame run.
   * Upgrade for both: drawnHeightM(sampleTerrainMostDetailed(point), fNow, relH) (raw heights, async, e.g. 4 Hz during
   * animations). The check is the harness's ?memo=1 (true heights under the aircraft and the camera): a clearance
   * computed from this result cannot show either.
   * ponytail: the chase camera starts each frame at its uncorrected point, farther than 50 m from its last reading while
   * a large correction holds (range·(cos p − cos p′)), so its memo lapses then: null, no correction, as without a memo.
   * Upgrade: one memo per clearance pass.
   */
  ground(sampledM: number | undefined, frame: TerrainFrame, memo?: GroundMemo, at?: GroundPoint): number | null {
    if (sampledM === undefined) {
      if (!memo?.ok || at === undefined || memo.relHM !== frame.relHM || (memo.f < FLAT_F && frame.fNow >= FLAT_F)) return null
      const m = distanceNm(memo.lat * DEG, memo.lon * DEG, at.latitude * DEG, at.longitude * DEG) * KM_PER_NM * 1000
      return m > MEMO_RADIUS_M ? null : rescaleSampledM(memo.m, memo.f, frame.fNow, frame.relHM)
    }
    if (memo && at) {
      memo.m = sampledM
      memo.f = frame.fSampled
      memo.relHM = frame.relHM
      memo.lat = at.latitude
      memo.lon = at.longitude
      memo.ok = true
    }
    return rescaleSampledM(sampledM, frame.fSampled, frame.fNow, frame.relHM)
  }
}

/**
 * The flat plane for a flatten or re-latch at (lat, lon), HAE m (D4): the runway height of the nearest airport within
 * 30 km (the mean of its runway ends' threshold heights), so runway and touchdown agree; else the drawn ground under
 * the aircraft; else 0 (the ellipsoid). While the ground is flat globe.getHeight answers the old plane everywhere, so
 * pass null or a true height (sampleTerrainMostDetailed) then.
 * ponytail: one plane per airport. At LLBG the runway ends span 49–61 m, so a touchdown far from the mean snaps the
 * aircraft by up to 7.4 m while flat. Upgrade: the nearest runway end’s height.
 */
export function pickRelHM(lat: number, lon: number, drawnGroundM: number | null, airports: readonly Airport[]): number {
  let best: Airport | null = null
  let bestKm = HERO_RELH_KM
  for (const a of airports) {
    const km = distanceNm(lat, lon, a.lat, a.lon) * KM_PER_NM
    if (km <= bestKm && a.runways.length > 0) {
      best = a
      bestKm = km
    }
  }
  if (best !== null) {
    let sum = 0
    let n = 0
    for (const r of best.runways) {
      for (const e of r.ends) {
        sum += e.thrHaeM
        n++
      }
    }
    return sum / n
  }
  return drawnGroundM !== null && Number.isFinite(drawnGroundM) ? drawnGroundM : 0
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/scene/topography.test.ts`
Expected: PASS — `ℹ tests 15`, `ℹ pass 15`, `ℹ fail 0`.

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/topography'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 5: Commit**

```bash
git add client/scene/topography.ts client/scene/topography.test.ts
git commit -m "feat(scene): Topography (animated flatten and grow, nudge, relH latch) and pickRelHM" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Harness page

**Files:**
- Create: `harness/topography.html`, `harness/topography.ts`

**Interfaces:**
- Consumes: `readConfig` (WP-V1), `createViewer` (WP-V1, now with normals), `ChaseModel` (Task 2), `ChaseCamera` with `groundAt` (Task 3), `Topography`, `groundMemo`, `pickRelHM` (Task 4), `drawnHeightM` and `TerrainFrame` (WP-E0); `/models/manifest.json`, `/airports/heroes.json`; Cesium `sampleTerrainMostDetailed`, `JulianDate`
- Produces: the page `/harness/topography.html` (`?topo=0`, `?r=`, `?h=`, `?at=`, `?hold=1`, `?memo=1`, `?time=`, `?terrain=`, `?imagery=`) and `window.harness = { viewer, topo, setTopo(on: boolean), stats() }`. `stats()` returns `f`, `relHM`, `on`, `animating`, `groundM`, `rawGroundM`, `trueGroundM`, `expectedGroundM`, `aircraftHM`, `aglM`, `clearanceM`, `minClearanceM`, `below15`, `clearanceUnknown`, `lastToggle { frames, avgMs, worstMs }`, `undefinedNearChange`, `undefinedSettled`, `toggles`, `tilesLoaded`, `fps`, `memo` and `truth { samples, acMemo, acMaxErrReadM, acMaxErrMemoM, acOverTol, camMemo, camBelow15, camFalse }` (counted only with `?memo=1`).

- [ ] **Step 1: Write the page**

File: `harness/topography.html`
```html
<!-- harness/topography.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Harness: topography</title>
    <style>
      html, body, #globe { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
      #info { position: absolute; top: 8px; left: 8px; max-width: calc(100% - 32px); padding: 6px 10px; font: 12px/1.45 ui-monospace, monospace; color: #fff; background: rgba(0, 0, 0, 0.65); border-radius: 4px; white-space: pre-wrap; pointer-events: none; }
      #topo { position: absolute; top: 8px; right: 8px; font: 12px ui-monospace, monospace; padding: 5px 9px; border-radius: 4px; border: 1px solid #555; background: rgba(0, 0, 0, 0.7); color: #fff; cursor: pointer; }
      #topo[aria-pressed='true'] { background: #1f5fa8; border-color: #6aa6ec; }
    </style>
  </head>
  <body>
    <div id="globe"></div>
    <div id="info">loading…</div>
    <button id="topo" aria-pressed="true" title="T">3-D terrain</button>
    <script type="module" src="/harness/topography.ts"></script>
  </body>
</html>
```

File: `harness/topography.ts`
```ts
// harness/topography.ts
// WP-E1 harness: the real chase model and ChaseCamera fly a level circle over Innsbruck (LOWI) that crosses the
// Nordkette ridge, on the app's terrain (makeTerrain: Re:Earth with vertex normals) and imagery. T or the button
// flattens the relief into the map and grows it back through Topography. The overlay compares the ground drawn this
// frame (globe.getHeight, lag-corrected) with the provider's true height (sampleTerrainMostDetailed, 1 Hz, so up to
// 70 m behind the aircraft; ?hold=1 for exact comparisons) at the current factor, and counts undefined ground readings
// under the aircraft (the TerrainPicker race that the nudge fixes). Lighting is on only so the relief reads; WP-E2
// owns the sun. ?memo=1 passes a GroundMemo for the aircraft and one for the camera, as the app does, and checks the
// ground and the camera's clearance against the provider's heights at the same frame and points (stats().truth).
// Query: ?topo=0 (start flat)  ?r=6000 (circle radius m)  ?h=2700 (HAE m)  ?at=0 (s into the circle)  ?hold=1 (stand
//        still)  ?memo=1  ?time=2026-06-21T10:30:00Z (sun)  ?terrain=reearth|ion|ellipsoid  ?imagery=eox|ion|none
// window.harness = { viewer, topo, setTopo(on), stats() } for the gate GE bench.
import { Cartographic, JulianDate, sampleTerrainMostDetailed } from 'cesium'
import { readConfig } from '../client/config.ts'
import { ChaseCamera } from '../client/scene/chaseCamera.ts'
import { drawnHeightM } from '../client/scene/exaggeration.ts'
import { ChaseModel } from '../client/scene/model.ts'
import { Topography, groundMemo, pickRelHM } from '../client/scene/topography.ts'
import { createViewer } from '../client/scene/viewer.ts'
import type { ModelManifest, RenderState, TerrainFrame } from '../client/types.ts'
import type { Airport } from '../shared/airports.ts'

const q = new URLSearchParams(location.search)
const num = (k: string, d: number): number => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d)
const LOWI = { lat: 47.2602, lon: 11.3439 }
const RADIUS_M = num('r', 6000) // the northern half crosses the Nordkette ridge (Hafelekar 2,334 m)
const H_M = num('h', 2700)
const SPEED_MS = 70
const M_PER_DEG = 111_320
const QUIET_MS = 600 // a factor change resets the pickers; undefined readings this soon after one are expected
const TRUTH_TOL_M = 2 // drawn against true ground: the level-of-detail difference (gate GE: at most 1.4 m at rest)
const info = document.getElementById('info')!
const button = document.getElementById('topo')!

const ac: RenderState = {
  hex: '440abc', lat: LOWI.lat, lon: LOWI.lon, hM: H_M, headingDeg: 0, pitchDeg: 0, rollDeg: -12,
  gsKt: SPEED_MS / 0.514444, trackDeg: 0, altBaroFt: H_M / 0.3048, vsFpm: 0, mode: 'interp', altSource: 'geom',
  onGround: false, ageS: 1, quality: 'adsb2', callsign: 'HOP1', typeCode: 'A320',
}

/** Level counter-clockwise circle around LOWI, tS seconds in (one RenderState for the whole run). */
function fly(tS: number): void {
  const th = (SPEED_MS / RADIUS_M) * tS
  ac.lat = LOWI.lat + (RADIUS_M * Math.sin(th)) / M_PER_DEG
  ac.lon = LOWI.lon + (RADIUS_M * Math.cos(th)) / (M_PER_DEG * Math.cos((LOWI.lat * Math.PI) / 180))
  ac.headingDeg = ac.trackDeg = ((Math.atan2(-Math.sin(th), Math.cos(th)) * 180) / Math.PI + 360) % 360
}

async function main(): Promise<void> {
  const cfg = readConfig({
    VITE_TERRAIN: q.get('terrain') ?? import.meta.env.VITE_TERRAIN,
    VITE_IMAGERY: q.get('imagery') ?? import.meta.env.VITE_IMAGERY,
    VITE_CESIUM_ION_TOKEN: import.meta.env.VITE_CESIUM_ION_TOKEN,
    VITE_API_BASE: import.meta.env.VITE_API_BASE,
  })
  const [viewer, manifest, heroes] = await Promise.all([
    createViewer('globe', cfg),
    fetch('/models/manifest.json').then((r) => r.json() as Promise<ModelManifest>),
    fetch('/airports/heroes.json').then((r) => r.json() as Promise<Airport[]>),
  ])
  const { scene } = viewer
  const globe = scene.globe
  globe.enableLighting = true
  viewer.clock.currentTime = JulianDate.fromIso8601(q.get('time') ?? '2026-06-21T10:30:00Z')

  const model = await ChaseModel.load(viewer, manifest.models.find((m) => m.id === manifest.default)!)
  const topo = new Topography(scene, q.get('topo') !== '0')
  topo.relatch(pickRelHM(ac.lat, ac.lon, null, heroes)) // ?topo=0: flat at LOWI's runway height, as on a selection
  let frame: TerrainFrame = topo.update(performance.now())
  const memo = q.get('memo') === '1'
  const acMemo = memo ? groundMemo() : undefined
  const camMemo = memo ? groundMemo() : undefined
  let camFromMemo = false // the camera's ground (its last clearance pass) came from camMemo this frame
  const chase = new ChaseCamera(viewer, {
    groundAt: (c) => {
      const raw = globe.getHeight(c)
      const g = topo.ground(raw, frame, camMemo, c)
      camFromMemo = raw === undefined && g !== null
      return g
    },
  })

  const st = {
    toggles: 0,
    groundM: null as number | null, // drawn this frame under the aircraft (lag-corrected globe.getHeight)
    rawGroundM: null as number | null, // globe.getHeight as read (last frame's factor)
    trueGroundM: null as number | null, // sampleTerrainMostDetailed: the provider's heights, never exaggerated
    clearanceM: null as number | null,
    minClearanceM: Number.POSITIVE_INFINITY,
    below15: 0,
    clearanceUnknown: 0,
    undefinedNearChange: 0, // globe.getHeight undefined under the aircraft within QUIET_MS of a factor change
    undefinedSettled: 0, // … later, with every tile loaded (gate GE: 0)
    lastToggle: { frames: 0, avgMs: 0, worstMs: 0 }, // frames that rendered a new factor since the last toggle
    // ?memo=1: frames checked against sampleTerrainMostDetailed at the aircraft and the camera (4 Hz, and every frame a
    // memo answered), each at that frame's factor and plane
    truth: {
      samples: 0,
      acMemo: 0, // … whose aircraft ground came from the memo
      acMaxErrReadM: 0, // |ground − drawnHeightM(true, f, relH)| under the aircraft, from a reading
      acMaxErrMemoM: 0, // … from the memo
      acOverTol: 0, // samples with that error over TRUTH_TOL_M
      camMemo: 0, // samples whose camera ground came from the memo
      camBelow15: 0, // the camera's true clearance under 15 m − TRUTH_TOL_M
      camFalse: 0, // … while it reported a clearance (it believed it was clear)
    },
  }
  const setTopo = (on: boolean): void => {
    if (on === topo.on) return
    topo.set(on, performance.now(), pickRelHM(ac.lat, ac.lon, st.groundM, heroes))
    st.toggles++
    st.lastToggle = { frames: 0, avgMs: 0, worstMs: 0 }
    button.setAttribute('aria-pressed', String(on))
  }
  button.setAttribute('aria-pressed', String(topo.on))
  button.onclick = () => setTopo(!topo.on)
  window.addEventListener('keydown', (e) => {
    if ((e.key === 't' || e.key === 'T') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat) setTopo(!topo.on)
  })

  const hold = q.get('hold') === '1'
  const t0S = performance.now() / 1000 - num('at', 0)
  const carto = new Cartographic()
  const frameMs = new Float64Array(240) // ring buffer for the fps figure
  let frames = 0
  let last = performance.now()
  let changed = false // the previous update wrote a new factor: the frame just rendered carries its cost
  let quietFrom = 0
  let infoAt = 0
  let truthAt = 0

  // One frame against the provider's heights: the points, factor, plane, ground and clearance are taken now, so the
  // async answer is compared with what this frame drew.
  const checkTruth = (acFromMemo: boolean): void => {
    const [a, c] = [Cartographic.clone(carto), Cartographic.clone(viewer.camera.positionCartographic)]
    const camHM = c.height
    const { fNow, relHM } = frame
    const { groundM, clearanceM } = st
    const camMemoNow = camFromMemo
    sampleTerrainMostDetailed(viewer.terrainProvider, [a, c], true).then(() => {
      const t = st.truth
      t.samples++
      if (groundM !== null) {
        const err = Math.abs(groundM - drawnHeightM(a.height, fNow, relHM))
        if (acFromMemo) {
          t.acMemo++
          t.acMaxErrMemoM = Math.max(t.acMaxErrMemoM, err)
        } else t.acMaxErrReadM = Math.max(t.acMaxErrReadM, err)
        if (err > TRUTH_TOL_M) t.acOverTol++
      }
      if (camMemoNow) t.camMemo++
      if (camHM - drawnHeightM(c.height, fNow, relHM) < 15 - TRUTH_TOL_M) {
        t.camBelow15++
        if (clearanceM !== null) t.camFalse++
      }
    }, () => undefined) // a failed tile: not counted
  }

  scene.preUpdate.addEventListener(() => {
    const now = performance.now()
    const dtMs = now - last
    last = now
    frameMs[frames++ % frameMs.length] = dtMs
    if (changed) {
      const a = st.lastToggle
      a.avgMs = (a.avgMs * a.frames + dtMs) / (a.frames + 1)
      a.frames++
      a.worstMs = Math.max(a.worstMs, dtMs)
    }
    frame = topo.update(now) // first, before any globe.getHeight
    changed = frame.fNow !== frame.fSampled
    if (changed) quietFrom = now + QUIET_MS

    fly(hold ? num('at', 0) : now / 1000 - t0S)
    const raw = globe.getHeight(Cartographic.fromDegrees(ac.lon, ac.lat, 0, carto))
    if (raw === undefined) {
      if (now < quietFrom) st.undefinedNearChange++
      else if (globe.tilesLoaded) st.undefinedSettled++
    }
    st.rawGroundM = raw ?? null
    st.groundM = topo.ground(raw, frame, acMemo, carto)
    ac.hM = st.groundM === null ? H_M : Math.max(H_M, st.groundM) // the app's placedHeightM, airborne
    model.update(ac)
    st.clearanceM = chase.update(ac, Math.min(0.1, dtMs / 1000)).clearanceM
    if (st.clearanceM === null) st.clearanceUnknown++
    else {
      st.minClearanceM = Math.min(st.minClearanceM, st.clearanceM)
      if (st.clearanceM < 15) st.below15++
    }
    const acFromMemo = raw === undefined && st.groundM !== null
    if (memo && (acFromMemo || camFromMemo || now >= truthAt)) {
      truthAt = now + 250
      checkTruth(acFromMemo)
    }
    if (now - infoAt > 250) {
      infoAt = now
      info.textContent = describe()
    }
  })

  // True ground under the aircraft, 1 Hz: the drawn ground must equal drawnHeightM(true, f, relH).
  setInterval(() => {
    sampleTerrainMostDetailed(viewer.terrainProvider, [Cartographic.fromDegrees(ac.lon, ac.lat)]).then(
      ([c]) => void (st.trueGroundM = c.height),
      () => void (st.trueGroundM = null),
    )
  }, 1000)

  const fps = (): number => {
    const n = Math.min(frames, frameMs.length)
    let sum = 0
    for (let i = 0; i < n; i++) sum += frameMs[i]
    return (1000 * n) / sum
  }
  const expectedGroundM = (): number | null => (st.trueGroundM === null ? null : drawnHeightM(st.trueGroundM, frame.fNow, frame.relHM))
  const stats = () => ({
    ...st,
    truth: { ...st.truth },
    memo,
    f: frame.fNow,
    relHM: frame.relHM,
    on: topo.on,
    animating: topo.animating,
    expectedGroundM: expectedGroundM(),
    aircraftHM: ac.hM,
    aglM: st.groundM === null ? null : ac.hM - st.groundM,
    tilesLoaded: globe.tilesLoaded,
    fps: fps(),
  })
  const fmt = (v: number | null, d = 1): string => (v === null ? '—' : v.toFixed(d))
  const truthLine = (t: typeof st.truth): string =>
    `memo check: ${t.samples} frames; aircraft error ${fmt(t.acMaxErrReadM)} m read, ${fmt(t.acMaxErrMemoM)} m memo (${t.acMemo}), ${t.acOverTol} > ${TRUTH_TOL_M} m; camera < 15 m ${t.camBelow15}, ${t.camFalse} reported clear (${t.camMemo} memo)`
  function describe(): string {
    const s = stats()
    const err = s.groundM === null || s.expectedGroundM === null ? null : s.groundM - s.expectedGroundM
    return [
      `factor ${s.f.toFixed(7)}  relH ${fmt(s.relHM)} m HAE  ${s.animating ? (s.on ? 'growing' : 'sinking') : s.on ? 'on' : 'flat'}`,
      `ground drawn ${fmt(s.groundM)} m (getHeight ${fmt(s.rawGroundM)})  true ${fmt(s.trueGroundM)} → at this factor ${fmt(s.expectedGroundM)} (Δ ${fmt(err)})`,
      `aircraft ${fmt(s.aircraftHM, 0)} m HAE  AGL ${fmt(s.aglM, 0)} m  camera clearance ${fmt(s.clearanceM)} m (min ${fmt(Number.isFinite(s.minClearanceM) ? s.minClearanceM : null)}, < 15 m: ${s.below15} frames, unknown ${s.clearanceUnknown})`,
      `last toggle: ${s.lastToggle.frames} frames with a new factor, avg ${s.lastToggle.avgMs.toFixed(1)} ms, worst ${s.lastToggle.worstMs.toFixed(1)} ms`,
      `undefined ground under the aircraft: ${s.undefinedNearChange} near a factor change, ${s.undefinedSettled} settled  tilesLoaded ${s.tilesLoaded}  fps ${s.fps.toFixed(0)}`,
      ...(s.memo ? [truthLine(s.truth)] : []),
      `T or the button: ${s.on ? 'flatten' : 'grow'}`,
    ].join('\n')
  }

  ;(window as unknown as { harness: object }).harness = { viewer, topo, setTopo, stats }
}

main().catch((err: unknown) => {
  info.textContent = `error: ${err instanceof Error ? err.message : String(err)}`
  console.error(err)
})
```

- [ ] **Step 2: Type-check the page**

Run: `npx tsc --noEmit 2>&1 | grep -E 'harness/topography'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Look at it**

Run: `npx vite --port 5321 --strictPort`, then open `http://localhost:5321/harness/topography.html`. Wait for `tilesLoaded true`.
Expected: the chase camera behind the aircraft on its circle around Innsbruck, with EOX imagery on sun-shaded relief. Slopes that face the sun are brighter. The overlay reads `factor 1.0000100  relH 0.0 m HAE  on`. The drawn ground and the true ground agree within the level-of-detail difference (a few metres). Press T: the overlay switches to `relH 627.7 m HAE  sinking`, and the Nordkette and the Inn valley sink into a flat, still-imaged map at LOWI's runway height over 2.5 s. The aircraft keeps its size, shape and height, and the camera stays above the ground. Half a second after `flat`, the factor reads `0.0000001`. Press T again: the relief grows back around the same plane, and the factor ends on `1.0000100`, then `1.0000101`. `?topo=0` starts flat at relH 627.7 m. `?memo=1` adds a `memo check:` line. The console has no errors.

- [ ] **Step 4: Measure (gate GE bench)**

Headless Chrome on the MacBook Air M2 (ANGLE Metal, 1280 × 713, `--disable-frame-rate-limit`), driven over CDP with `window.harness`:
1. **Normals and cache key:** in the network log, every `terrain.reearth.land` request (`layer.json` and the `.terrain` tiles) carries `?extensions=octvertexnormals`, returns 200, and makes no CORS preflight. `harness.viewer.terrainProvider.hasVertexNormals === true`. Report the level-14 tile sizes against the plain variant.
2. **The model is not squashed:** screenshots at `stats().f` ≈ 0.5 and at 0. The aircraft has the same proportions and on-screen height as at `TOPO_ON`.
3. **Animation cost:** with a warm cache, 10 toggles (`harness.setTopo(false)` and `harness.setTopo(true)` alternately, 4 s apart). For each toggle, record `stats().lastToggle`. Pass: `worstMs` ≤ 50 (no long task > 50 ms), `avgMs` ≤ 16.7.
4. **Picker race:** after the 10 toggles, `stats().undefinedSettled === 0`. Report `undefinedNearChange`.
5. **Lag correction:** `?hold=1&at=135` (the northern point, over the Nordkette). Log `stats()` every frame through a grow and a sink. Pass: |`groundM − expectedGroundM`| stays within its at-rest value (the level-of-detail difference) + 1 m on every frame. Report the raw error `rawGroundM − expectedGroundM`, which should peak near one frame's Δf times (ground − relH): about 1 % of it at 60 fps.
6. **Clearance:** near the northern point, zoom the chase in to 25–150 m (mouse wheel) and toggle 10 times. Pass: `stats().below15 === 0`, and the camera is never under the drawn terrain on screen. `below15` is measured against the same ground the camera corrects against, so it only shows that the passes converge. Check 7 is the independent one.
7. **The memos against the provider's heights:** `?memo=1&at=135`, without `?hold=1`, so the aircraft flies on over the Nordkette. Zoom the chase in to 25–150 m, toggle 10 times 4 s apart, then read `stats().truth`. Pass: `camFalse === 0`: no sampled frame reported a clearance while the camera's true clearance was under 15 m − 2 m (`TRUTH_TOL_M`, the level-of-detail difference). Also `acMemo > 0` and `camMemo > 0`: the memos answered, otherwise toggle more. Report `acMaxErrReadM`, `acMaxErrMemoM`, `acOverTol` and `camBelow15`. `camBelow15` includes the frames with an unknown clearance: a run from a grow's first frames, and a camera memo that lapsed under a large correction. A memo error well above the reading error, beyond the ground's change within 50 m, is a memo fault.

Results (2026-09-23, run by the orchestrator for gate GE, before the `GroundMemo` amendment; the harness calls `ground()` without a memo). Check 7 was added after review and has not run:
- **1, normals and cache key:** 249 of 249 Re:Earth requests carried `?extensions=octvertexnormals`. All returned 200, with no CORS preflight. `hasVertexNormals` is `true`.
- **2:** the `stats()` read mid-sink were sane.
- **3, animation cost:** over the 10 toggles, `worstMs` was 20.6–235.6 ms and `avgMs` 10.7–19.4 ms, above the 50 ms and 16.7 ms bars on some toggles. A profile showed that the long tasks over 50 ms are Cesium shader-program compiles (`createAndLinkProgram`, `getProgramParameter`: 1,042 of the 1,065 ms inside long tasks). They occur with or without toggles: 40 s of flight without toggles had 5–6 frames over 50 ms, with toggles 8. They are first-use warm-up, not the feature.
- **4, picker race:** `undefinedSettled` 0.
- **5, lag correction:** at rest the error was at most 1.4 m. During the animations the corrected error reached 8.5 m, against 50.4 m raw. That is above this step's bar (the at-rest value + 1 m). The cause of the rest was not isolated.

- [ ] **Step 5: Commit**

```bash
git add harness/topography.html harness/topography.ts
git commit -m "test(scene): topography harness — LOWI Nordkette circle, T toggle, ground, clearance and picker overlay" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: WP gate

- [ ] **Step 1: This package's tests**

Run: `node --test client/config.test.ts client/scene/model.test.ts client/scene/chaseCamera.test.ts client/scene/topography.test.ts`
Expected: `ℹ tests 65`, `ℹ pass 65`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/config|client/scene/(terrain|model|chaseCamera|topography)|harness/topography'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Full check**

Run: `npm run check`
Expected: `tsc` prints nothing, then `ℹ tests 631`, `ℹ fail 0` (611 on the WP-E0 tree + 20). Two timing tests can fail under full-suite load and pass when run alone: "sortRows and filterRows stay cheap at 12,000 rows" (`client/ui/table.test.ts`) and "budget: /api/view of a 250 nm circle with 5,000 aircraft" (`server/main.browse.test.ts`). They are known flakes, not regressions. Any other failure must be fixed.

- [ ] **Step 4: Confirm there is nothing left to commit**

Run: `git status --short`
Expected: no output.

## Notes for later work

- **Deviations from the brief:**
  - The constructor takes `Pick<Scene, 'verticalExaggeration' | 'verticalExaggerationRelativeHeight'>` rather than `Scene`. A `Scene` fits, and the tests pass a plain fake without a cast.
  - `set()` and `relatch()` only record. `update()` writes both values, so the `TerrainFrame` always matches what is drawn. The constructor writes only the factor.
  - The nudge also runs 0.5 s after a re-latch, because a relH change resets every picker too (`GlobeSurfaceTileProvider.js:560-574`). A nudge moves the factor from the end value to 1e-7 above it, or back. After an animation this is exactly "+1e-7 once", and repeated re-latches never add up.
  - A NaN clock ends an animation on its end value.
  - `ground()` takes an optional `GroundMemo` (added after gate GE) and the point that was read (added after review). Without them it behaves as the brief says. A memo read while flat gives `null` once the relief grows, and a memo answers only within 50 m of where it was read (both added after review).
  - `pickRelHM` uses the mean `thrHaeM` of all the airport's runway ends and skips airports without runways.
  - The remote terrain branches and `ChaseModel.load` are tested by mocking Cesium's factories for one call (`t.mock.method`). No export was added for the tests.
  - The harness builds its viewer with the app's `createViewer`, not with its own `Viewer` as the PoC did. It has no night lights (WP-E2) and no shadows (D10).
- **For WP-E-A:** see "Conventions consumers rely on" in the Architecture section. In particular, construct `Topography` before the first render, pass one `GroundMemo` per followed point to `ground()` together with that point (a `null` ground means "unknown"), and relatch on selection with a true ground away from the heroes. **Open:** `client/app.ts` in WP-E-A's tree still calls `topo.ground(sampled, tf, acGround)` and `topo.ground(globe.getHeight(c), tf, camGround)`. It type-checks, but without the point both memos are unused: an `undefined` reading gives `null`, as before the memo. It must pass `carto` and `c` as the fourth argument. WP-E-A's claim that `camGround` "keeps the ≥ 15 m clearance correction working" holds only for small corrections (Architecture, the ponytail).
- **Measured at gate GE:** `undefined` readings under the aircraft occur inside the animation and nudge windows (175 frames in 10 toggles, runs of up to 37), which is why `GroundMemo` exists. **Still unmeasured:** the ion branch. There is no token, so CWT with normals has not run in a browser.
- **Residual of the memo (not measured):** during a grow from flat, if Cesium's picker gives no ground for a run of frames from the grow's start, the memo holds only a flat reading and `ground()` gives `null` until the next reading. The aircraft keeps its estimated height, and the chase camera has no clearance ground for those frames: it can briefly clip a rising slope, for at most the run's length (gate GE: runs of up to 37 frames, about 0.6 s). Upgrade: fall back to `drawnHeightM(sampleTerrainMostDetailed(point), fNow, relH)` (raw provider heights, async, for example at 4 Hz during animations). The same comparison is the independent check: the harness's `?memo=1` (Task 5 Step 4, check 7). The app's clearance log cannot see this, because it is computed from the same ground. Neither can `?hold=1`, which runs without a memo and keeps the aircraft's point fixed.
- **Residual of the memo's radius (not measured):** within 50 m, the memo's error is the ground's change between the two points: up to 50 m on a 45° slope. While a large clearance correction holds, the chase camera's memo lapses (Architecture, the ponytail). Check 7 measures both. Shrink `MEMO_RADIUS_M`, or give each clearance pass its own memo, if `camFalse` is not 0.
- By default `harness/topography.ts` calls `ground()` without a memo on purpose: it shows and counts the raw readings. Its camera clearance is therefore unknown on `undefined` frames (`clearanceUnknown`). The app's is known on those frames, except in the residual cases above. `?memo=1` passes memos as the app does and checks them against the provider's heights.
- `harness/chase-camera.ts` (WP-V4) and `harness/runways.ts` (WP-V5) still load Re:Earth at the bare URL, the first with normals through `Accept` and the second without. They can still serve each other's cached bodies (research B4). The app no longer shares those cache entries. If those pages are used for screenshots, switch them to `makeTerrain`.
- **Upstream:** the TerrainPicker race is worth a Cesium issue with a Sandcastle repro (design §7). Remove the nudge once a fix ships.

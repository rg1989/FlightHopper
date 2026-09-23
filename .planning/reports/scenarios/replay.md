## Pre-recorded flights: how the replay system works, and where scenarios fit

### 1. How recordings are stored, selected and replayed

**Storage.** Recordings are JSONL files. Each line is one upstream poll, stored verbatim as `RecordLine { v: 1, source: 'adsblol'|'adsbfi'|'readsb', url, status, tSendMs, tRecvMs, bytes, body }`. `body` is the raw readsb/adsb.lol JSON text (server/recording.ts:9-18).
- `Recorder.write(kind, r)` appends to `<RECORD_DIR>/YYYY-MM-DD.jsonl`, using the UTC date of `tSendMs` (server/recorder.ts:22-35). It never records a replay (recorder.ts:23; server/main.ts:147).
- `readRecording(path)` reads the whole file into memory (recording.ts:26-39).
- Synthetic recordings already exist. `gen-synthetic-lowi.ts` writes `RecordLine`s with `url: "synthetic:/v2/point/…"`, made-up hexes and 1 Hz polls (.planning/plans/assets/WP-E-A/gen-synthetic-lowi.ts:1-12). Its output is `data/recordings/synthetic-lowi.jsonl`.

**Selection happens at server start only.**
- The server reads `ADSB_SOURCE=replay`, `REPLAY_FILES` (a comma list or globs; default `data/fixtures/*.jsonl`) and `REPLAY_SPEED` (server/config.ts:27, 87-89, 98).
- `make replay` picks the newest file by default (`REC ?=`, Makefile:5, 25-26).
- `makeSource` calls `makeReplay({ files, speed })` and does not pass `loop` (server/sources/index.ts:25-26).
- One server process has exactly one source (main.ts:142).
- The API is GET-only and has three routes: `/api/view`, `/api/chase`, `/api/status` (main.ts:226, 234-237). No route lists or switches recordings.

So a client cannot pick a recording at runtime.

**Replay.** `loadPolls` parses every line, sorts by `tRecvMs` and computes one global offset (sources/replay.ts:35-63).
- Virtual time is `vt = first + (nowMs() − start)·speed`, where `start` is when the process started (replay.ts:91-96).
- Each `all()` call serves, per hex, the newest object at or before `vt` whose position is at most 60 s old, with `seen_pos` rebased (replay.ts:95-113).
- Caps are `fullSnapshot: true, maxRps: 10` (replay.ts:123-129).
- Without `loop`, every aircraft ages out 60 s after the last poll (.planning/plans/WP-S2-replay-recorder-fake.md:35).
- The Poller calls `all()` once per `fullSnapshotPeriodMs = 1000` (server/poller.ts:36, 199-207). `#ingest` turns each object into a `Sample` with `toSample` and adds it to `SampleStore` (poller.ts:325-336).

### 2. How the client knows it is watching a replay, and at what time

**The replay flag.** Every `/api/view` and `/api/chase` reply carries `serverNowMs` and `status: StatusBrief` (main.ts:210, 220; shared/api.ts:6-31). The only replay flag is `status.source === 'replay'` (sourceBadge.ts:34).

**Recording time.**
- `upstreamOffsetMs` is the poller's `MinOffset` of server clock minus upstream clock, over a 10-minute window. It is present only after the first good answer (poller.ts:63, 118, 285). For a replay it equals server now minus recording time (shared/api.ts:11).
- The server re-stamps samples as `tMs = upstreamNow − seen_pos + offset` (shared/sample.ts:24-37). The client therefore never sees the recording time directly.
- `ApiClient.serverNowMs()` comes from a 60 s `MinOffset` of local receive time minus `serverNowMs` (client/api.ts:37-41, 53).
- The badge shows `new Date(serverNowMs − upstreamOffsetMs)` as `REPLAY · YYYY-MM-DD HH:MM UTC` (client/ui/sourceBadge.ts:28-37).

**Sun time.**
- In `frame()`, `tRenderMs = clock.tick(serverNow, delayTargetS(), dtS)` (client/app.ts:546-548).
- The sun is then set by `sun.update(sunTimeMs(tSunMs, sunParam, status.upstreamOffsetMs ?? 0), sunWC)` (app.ts:608).
- `sunTimeMs = p.fixedMs ?? tRenderMs − upstreamOffsetMs + p.offsetMs` (client/scene/sun.ts:177-178). The `?sun=` parameter takes an ISO instant or a ±h/m offset (sun.ts:160-170).

So the sun follows the delayed render time, mapped back onto the recording's clock. A scenario player can pass its own absolute instant (for example 1985-08-12T09:12Z + t) to `sun.update` instead.

### 3. Attitude, seeking backward, data rate and display delay

**Attitude cannot pass through the server path.**
- `ReadsbAircraft` has `roll` but no pitch (shared/types.ts:17). `Sample` carries `rollDeg` and `trueHeadingDeg` only (types.ts:64-87; sample.ts:45-47).
- The client makes up the attitude in `targetAttitude` (client/track/attitude.ts:23-40):
  - pitch = `atan2(vs, gs)` + an angle of attack by flight phase, clamped to [−15°, +25°]
  - roll = the broadcast roll if present, else a coordinated turn; clamped to ±35°; 0 for MLAT or on the ground
  - then a 1 s first-order lag (attitude.ts:43-66), fed by `Track.stateAt` (client/track/track.ts:133-166).
- The JAL123 CSV has pitch from −36° to +15° and roll from −38.5° to +81.6°, and gives `ias_kt` rather than ground speed. Through this path the dive and every roll past 35° would be lost, even if a roll value were added.

**Seeking backward is not possible.**
- `vt` only moves forward from process start, and there is no seek API (replay.ts:93-96).
- `SampleStore` keeps 180 s of track, and the newest sample for 35 min (server/store.ts:10, 25).
- `Deduper.accept` drops any sample that is not more than 5 ms newer than the last one (shared/dedupe.ts:10-15; store.ts:30-31).
- The client's `since` only ever rises (client/api.ts:54-55), and `Track` keeps a 120 s window (track.ts:17).
- `REPLAY_SPEED` is the only control, and it is read at start. `stateAt` handles time going backward only by resetting the attitude smoother (track.ts:137).

**Data rate.**
- The server polls the replay about once a second: one `all()` per 1000 ms, and the bucket rate is `min(MAX_RPS, caps.maxRps)` = min(1, 10) for a replay (poller.ts:36, 200; config.ts:26; main.ts:145-146).
- The client polls view and chase at 1 Hz (app.ts:63, 664, 728-732).
- Samples are only as dense as the recording. 15-s rows give 15-s gaps.

**Display delay.**
- The picture is drawn at server now minus a delay (delay.ts:42-60).
- The target delay is `min(30, max(track target, chaseEveryS + p90 arrival age + 0.5))` (app.ts:423-424).
- The track target is `clamp(max(quality floor 3–6 s, poll + 1, p90 gap + 1), 3, 30)` (delay.ts:5-23; track.ts:201-203).
- With 15-s rows the delay is about 16 s. After a chase starts, the delay shrinks at 0.05 s/s (app.ts:79, 704).
- Past 8 s of extrapolation the pose freezes as `'stale'` (track.ts:19).

### 4. Recommendation: where scenarios should live

**A. Static asset plus a client player (recommended).**
- The files go in `public/scenarios/<id>/`. A `ScenarioPlayer.stateAt(tS): RenderState` gives exact heading, pitch and roll, because `RenderState` already has `pitchDeg` and `rollDeg` (client/types.ts:6-25).
- `harness/chase-camera.ts` already works this way: a pure `stateAt(t)` (lines 34-63) drives `ChaseCamera.update(s, dtS)` each frame (line 99).
- Pros:
  - Scrubbing, pausing and speed are free, since the pose is a pure function of `t`.
  - No 3–16 s delay.
  - No server change, and it runs next to any running server.
  - Audio, captions and the sun all share one scenario clock.
  - It can show only this aircraft.
- Costs:
  - `frame()` has to be split so that a scenario mode skips the fleet, the registry, the poll loop and the status panel. The coupling is at app.ts:536-620, and rendering is gated on `api.ready` at app.ts:545.
  - 15-s rows need proper spline interpolation for the turns and the phugoid.

**B. Convert the scenario into a replay recording** (a `RecordLine` generator, as in gen-synthetic-lowi.ts).
- Pros: basic playback needs no client code, and the badge and sun time work.
- Cons:
  - No pitch, and roll clamped to ±35°.
  - No scrubbing, and playback starts when the server starts.
  - The recording is chosen when the server starts, so a runtime Scenarios menu cannot switch to it.
  - About 16 s of delay.
  - Syncing captions and audio would need `serverNow − upstreamOffsetMs − delay`.

This option fails the user's requirements.

**C. Hybrid with a `/api/scenarios` listing.** This adds a server route, which Vite would already proxy (vite.config.ts:15). But a static `public/scenarios/index.json` does the same job with no server change. Add a server route only if packages are later uploaded at runtime.

**Suggested package layout (A + a static index):**
- `index.json`: a list of `{ id, title, date, summary }`
- `<id>/scenario.json`: epoch in UTC, time range, aircraft `{ icaoType, reg, modelId, liveryId }`, content notes
- `track.csv`: the dossier's columns, `t, lat, lon, alt_ft, ias_kt, hdg, pitch, roll, vs, flag, event`
- `captions.json`: `{ t, dur, speaker, to, channel: 'CVR'|'ATC', text, src }`
- `audio/*` with a start offset

### 5. Static assets in dev and in the built `dist/`

**Dev.** vite.config.ts sets neither `root` nor `publicDir`, so `public/` is served at `/` (vite.config.ts:8-16). Only `/api` is proxied. The client already builds paths as `${import.meta.env.BASE_URL}models/manifest.json` (app.ts:280, 293) and `…liveries/<code>` (client/scene/livery.ts:117). `${base}scenarios/<id>/…` will resolve the same way.

**Build.** `npm run build` (`vite build`, package.json) copies `public/` to the root of `dist/`. The server serves `dist/` (config.ts:103; main.ts:156, 230) through `serveStatic` (main.ts:112-129): it guards against path traversal, sends `index.html` for paths without an extension, and returns 404 for a missing file that has one.

**Gaps that affect scenarios:**
1. The `TYPES` map (main.ts:42-59) has no entry for `.mp3/.m4a/.ogg/.opus/.wav/.webm/.vtt/.csv/.kml/.webp/.jpeg`. Those files are sent as `application/octet-stream`.
2. `serveStatic` has no Range support (no 206, no `Accept-Ranges`) and reads each file whole (main.ts:127-128). Chrome may not be able to seek an `<audio>` element outside its buffered data without Range support, so scrubbing on port 8791 is at risk. Vite's dev server does support Range, so dev and dist behave differently. Two fixes: fetch the audio and decode it with `AudioContext.decodeAudioData`, which also allows exact seeking, or add audio MIME types and Range handling to the server.
3. `dist/` is out of date. It was built at 09:46 and has no `liveries/`, although HEAD `f875fa4` added `public/liveries`. `main-api` on port 8791 needs `npm run build` before it serves any new `public/` files.
4. There are no cache headers (main.ts:109-110).

### 6. Running the app and verifying it

**Makefile and npm scripts.**
- `make` / `make live`: API on 8787 (adsb.fi, 0.9 req/s) plus Vite on 5173 in the foreground (Makefile:6-7, 19-23). It refuses to start if the API port is busy (Makefile:30).
- `make replay [REC=data/recordings/<f>.jsonl]` (Makefile:5, 25-26).
- `npm run check` (typecheck and tests), `npm run build`.

**`.claude/launch.json`** is excluded from git in `.git/info/exclude`. Configurations for this repository:

| Name | What it runs | Port | launch.json lines |
|---|---|---|---|
| `main-api` | live adsb.fi API; also serves `dist/` | 8791 | 171-185 |
| `main-client` | Vite, proxies to 8791 | 5179 | 186-202 |
| `main-replay-api` | replay of `2026-09-22.jsonl` | 8792 | 203-219 |
| `main-replay-client` | Vite | 5180 | 220-236 |
| `live-api` / `live-client` | live adsb.lol at 0.04 req/s, and Vite | 8787 / 5173 | 114-139 |
| `preview-buildings` | Vite | 5176 | 103-113 |

The other configurations point at other trees:
- `preview-*` → `<scratch>` (still exists)
- `*-e` → `<scratch>` (still exists)
- `traffic-*` → the `FlightHopper-traffic-id` worktree (still exists)
- `world-*` and `liveries-*` → `FlightHopper-world` and `FlightHopper-liveries`, which no longer exist
- `scratch-sheet`: a Python HTTP server on 5190

**Harness pages and hooks.**
- The pages are Vite-served at `/harness/<name>.html` and exist in dev only, because the build has just `index.html`. They are: browse, buildings, chase-camera, fleet-layer, lod, model, runways, scene-toggles, sun, table, topography, viewer.
- They expose `window.harness` (e.g. chase-camera.ts:125) or `window.__lod` (lod.ts:483).
- The app exposes `window.viewer` (app.ts:432).
- URL parameters: `?hex=`, `?bench=1`, `?airport=` (app.ts:195-205) and `?sun=` (sun.ts:160-170).

**Headless-Chrome / CDP pattern** (.planning/plans/assets/WP-E-A/gate.mjs):
1. Start Chrome (gate.mjs:14-17):
   ```
   /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --remote-debugging-port=9334 --user-data-dir=<out>/profile --window-size=1440,900 --use-angle=metal --ignore-gpu-blocklist [--disable-gpu-vsync --disable-frame-rate-limit] --no-first-run --no-default-browser-check about:blank
   ```
2. Poll `http://127.0.0.1:PORT/json/list` until a page target appears, then open a WebSocket to it (gate.mjs:24).
3. Drive it with `Runtime.evaluate` (awaitPromise, returnByValue; gate.mjs:47), `Page.navigate` and `Page.captureScreenshot` (gate.mjs:53). Collect `Network.*` events and `Runtime.exceptionThrown`.
4. Wait until `window.viewer && viewer.scene.globe.tilesLoaded` is true three times in a row (gate.mjs:64, 226).
5. `HOST` defaults to `http://localhost:5173`.

The chase-LOD drivers (.planning/reports/chase-lod/driver/fix-driver.mjs) follow the same pattern with a few changes:
- They use port 9350.
- They add the uncapped flags only for the fps step (line 46), so they are frame-capped by default.
- They kill Chrome with SIGKILL on exit (line 49).
- They wait `SPACING_MS = 15000` between browsers, because the terrain server answered 429 (lines 26, 349).

Your saved memory notes that uncapped runs saturate the GPU and slowed your Mac. Scenario checks should use the capped flags and run one Chrome at a time.
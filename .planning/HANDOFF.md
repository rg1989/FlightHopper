# FlightHopper — Handoff: terrain & sun into the app, tested, and running

**Written:** 2026-09-23. The commit that adds this file also adds the `make live` guard and rate, and the gate driver's host setting; branch from `main` at or after it. **One goal, three steps:**
1. Put the terrain & sun feature into the app.
2. Test it.
3. Run the full app for real.

Everything else is in the backlog at the end.

## Where things stand

- **The app works on `main`.** The server (adsb.lol / readsb / replay) serves `/api/view`, `/api/chase` and `/api/status`. The client has browse mode (top-down street map, altitude-coloured icons, table, legend) and chase mode (3-D model, chase camera, detail panel, HUD). `npm run check` passes 604/604 and `vite build` works. `make` starts it (see Step 3).
- **Terrain & sun is ready code, not yet applied.** The seven plans hold the finished, tested and reviewed code in complete-file blocks (the PoC was only the prototype). Applying them is mechanical.
  - What they do: chase mode gets visible 3-D relief with sun shading, a **3-D terrain** toggle (T) that sinks the mountains into the flat map and grows them back, and a **Sun** toggle (L). The sun follows real time (morning, golden hour, night with city lights, mountains still faintly visible). Replays are lit at their recorded time.
  - Plans: `.planning/plans/WP-E0…E5`, `WP-E-A`. Design and decisions: `.planning/terrain-sun-design.md`. `PLAN.md` §5.4.
  - Already proven:
    - a rebuild from the plans alone gave 680/680 tests and `vite build` ok;
    - a dry run of `apply_plans.py` on `64d2b96` was green;
    - gate GE in headless Chrome on the M2 gave FPS p50 137 / p5 103, no long task in 10 toggles, and camera clearance ≥ 326 m.
- **Processes that may be running:** the adsb.lol recorder (`node tools/record-cells.ts` under `nohup caffeinate`, from the main checkout). It polls at ~0.04 req/s: three 429s on 2026-09-22 doubled its interval each time. Replays don't touch adsb.lol, but `make live` refuses to start while the recorder runs (Step 3.3). The old preview servers on 8787/5174 were stopped on 2026-09-23.

## Rules for this work

- **adsb.lol:** only one process polls it at a time. This IP got 429s at 0.14–0.5 req/s, and once at ~0.082 req/s after 1.5 h; it has run clean at 0.041 req/s since. The server's `MAX_RPS` default is 1 req/s, so a live run must always set it. `make live` sets 0.04 (`LIVE_RPS`). Stop the recorder before any live run.
- **Tests never touch the network.**
- **Keep the machine's load low:** no parallel full-suite runs and no stray servers. Stop what you start.
- **Git:** commit identity `rg1989 <roman.grinevic@gmail.com>` (set repo-locally). Push to `git@github.com:rg1989/FlightHopper.git`. `git add` explicit paths only.
- **Decisions in `terrain-sun-design.md` stand:**
  - no cast shadows (the user rejected them);
  - night keeps the mountains faintly visible;
  - lighting applies in chase only (browse stays the unlit street map);
  - replays are lit at their recorded time.

---

## Step 1 — Apply the terrain & sun plans (≈ 15 min, mechanical)

1. Make a worktree on a branch:
   ```bash
   git worktree add ../FlightHopper-e -b build/terrain-sun main
   ```
   ```bash
   cd ../FlightHopper-e && npm ci
   ```
2. Apply the seven plans **in this order**. The tool commits once per task and runs the full check after each WP:
   ```bash
   python3 .planning/tools/apply_plans.py ../FlightHopper-e WP-E0-terrain-sun-contract WP-E5-recorded-sun-time WP-E1-topography WP-E2-sun WP-E3-ground-objects WP-E4-scene-toggles WP-E-A-integration
   ```
   Run it from the worktree you are in. It also works from the main checkout: it reads the plans from, and commits in, `../FlightHopper-e`.
   - **Expected test counts after each WP:** 611 → 613 → 633 → 654 → 663 → 677 → **680**. `tsc` stays clean.
   - **Two timing tests can flake** when the whole suite runs under load: "sortRows and filterRows stay cheap at 12,000 rows" (`client/ui/table.test.ts`) and "/api/view of a 250 nm circle with 5,000 aircraft" (`server/main.browse.test.ts`). The tool stops at the first WP whose check fails, and it prints only counts:
     - To see what failed, run `npm test 2>&1 | grep '^✖'` in the worktree.
     - If only those two failed, confirm with `node --test client/ui/table.test.ts server/main.browse.test.ts`.
     - Then resume with only the WPs **after** the one that stopped (its commits are already in), e.g. `python3 .planning/tools/apply_plans.py ../FlightHopper-e WP-E2-sun WP-E3-ground-objects WP-E4-scene-toggles WP-E-A-integration`.
     - Re-running the full command also works (applied WPs give no diff), but it repeats every full check.
3. In the worktree:
   ```bash
   npm run build
   ```
   Expected: the build succeeds. The only warning is the usual one about a chunk over 500 kB.

## Step 2 — Test it (≈ 30 min)

All of this runs in the worktree `../FlightHopper-e`, with nothing else on ports 8787/5173 (see Step 3.1).

### 2.1 Automated

```bash
npm run check
```
Expected: `tsc` clean, 680/680.

### 2.2 Gate GE in the browser

Full steps and pass criteria: `.planning/plans/WP-E-A-integration.md`, Task 5. Reference values from the validated run: `.planning/plans/assets/WP-E-A/gate-GE/` (screenshots + `results-*.json`).

1. Make the Innsbruck test replay. It is deterministic; the output goes to `data/recordings/`, which is gitignored:
   ```bash
   node .planning/plans/assets/WP-E-A/gen-synthetic-lowi.ts
   ```
2. Start the app on it. The replay plays once from server start: SYN601 crosses the Nordkette at about 74 s, lands at about 510 s and stops at about 560 s. Restart `make` to replay it again.
   ```bash
   make REC=data/recordings/synthetic-lowi.jsonl
   ```
3. **By hand in Chrome**, within ~20 s of the start: open `http://localhost:5173/?hex=000e01&bench=1` and check:
   - **Toggles:** top right, "3-D terrain" and "Sun", both on.
   - **Relief:** the Karwendel slopes are shaded by the sun.
   - **Press T:** the relief sinks into the flat satellite map over 2.5 s. Press T again: it grows back. The aircraft keeps its height and the camera never goes into a slope.
   - **Press L:** the sun lighting goes off (flat daytime imagery); press again to turn it back on.
   - **Night:** add `&sun=2026-09-22T20:30:00Z` to the URL. You get dark land, the Innsbruck lights, and mountains that are faint but readable.
   - **Golden hour:** `&sun=2026-09-22T16:45:00Z` gives warm light from the west.
   - **Esc:** back to browse, an unlit street map, and the toggles hidden.
4. **Or automated.** The driver runs headless Chrome over CDP and writes screenshots + `results.json` into the output directory you give it. Use a new directory per run: each run rewrites that directory's `results.json`. It does not need the app's tab in front.
   - **Ridge run.** Start it as soon as `make` prints the link (within ~20 s of the server start), so its 10 terrain presses cover the ridge crossing at ~74 s:
     ```bash
     node .planning/plans/assets/WP-E-A/gate.mjs /tmp/gate-ridge app-ridge
     ```
     - **Pass:** `fpsP50` ≥ 60, `fpsP5` ≥ 30, `longTasks` [], `worstAnimFrameMs` all < 50, `noGroundSettled` 0, `groundUnknownSettled` 0, `groundUnknown` below `noGroundInAnimOrNudge` (equal would mean the memo is inert), `shadows` false, and bench `clearance min` ≥ 15 m with `violations 0`.
     - **Validated run:** 137 / 103 / [] / ≤ 45 ms / 0 / 0 / 0 of 347, clearance 326 m.
   - **One LOWI scenario per fresh `make REC=data/recordings/synthetic-lowi.jsonl`**, each with its own directory: `ge-8-lowi-morning`, `ge-9-lowi-golden`, `ge-10-lowi-night` and `app-grow` (screenshots). `app-browse-night` and `app-keys` (keys, persistence, phone layout) can share one start.
   - **Ground objects** (Task 5 Step 4): start `REPLAY_SPEED=5 make REC=data/recordings/synthetic-lowi.jsonl`, then at once:
     ```bash
     node .planning/plans/assets/WP-E-A/gate.mjs /tmp/gate-ground app-ground
     ```
     If you start the driver late, set `SERVER_AGE_MS` to the milliseconds since `make` started.
   - **Harness checks** (Task 5 Step 1; the harness pages need no replay):
     ```bash
     node .planning/plans/assets/WP-E-A/gate.mjs /tmp/gate-harness topo toggles sun
     ```
   - **KSFO at its recorded time** (the clock should read 2026-09-22T18:00Z): `make REC=.planning/plans/assets/WP-A2/synthetic-ksfo.jsonl`, then scenario `app-ksfo`.
5. Stop `make` (Ctrl+C) when done.

### 2.3 Merge

If 2.1 and 2.2 pass, from the main checkout:
```bash
git merge --ff-only build/terrain-sun
```
```bash
npm run check
```
```bash
git push origin main
```
```bash
git worktree remove ../FlightHopper-e
```
If a gate item fails, fix it in the worktree first (the plan and its WP own the file).

## Step 3 — Run the full app (≈ 10 min)

### 3.1 Free the ports
`make` needs 8787 (API) and 5173 (client), and it stops with a message if 8787 is taken. To clear stray servers:
```bash
lsof -ti tcp:8787,5173,5174 -sTCP:LISTEN | xargs kill
```

### 3.2 On recorded data (no upstream traffic)
```bash
make
```
- It replays the most recently modified `.jsonl` in `data/recordings/` (normally today's recording) and prints `FlightHopper → http://localhost:5173/`. Ctrl+C stops both the API and the client.
- **Pick a recording:** `make REC=data/recordings/2026-09-22.jsonl`.
- **Chase a specific aircraft:** `?hex=<hex>`. Otherwise click an icon or a table row. Esc goes back to browse.

### 3.3 Live on adsb.lol
**Before the first live run, fix F1.** `PLAN.md` Global Constraints require it: after a 429, the rate must never climb back above half the rate that was refused.
- **Now:** in `server/budget.ts`, a 429 halves the rate (floor `maxRps/8`). It then recovers ×1.1 per quiet minute all the way back to `maxRps` (`RECOVERY_STEP_MS`), which re-probes the limit that just refused us.
- **Change:** on each 429, `ceiling = min(ceiling, rps / 2)`, then `rps = min(ceiling, max(maxRps / 8, rps / 2))`. Recovery climbs only up to `ceiling`. It's the same rule as `tools/record-cells.ts` `nextBase()`. `state().maxRps` keeps reporting the configured maximum. If you add `ceilingRps`, add it to `BudgetState` in `shared/api.ts` and update the `deepEqual` in `server/budget.test.ts`.
- **Tests (fake clock):**
  - after a 429 at rate r, the rate never exceeds r/2, even after hours without a 429;
  - two 429s give r/4.
- Size S. Do it on a branch with TDD, then `npm run check`, merge and push.

Then stop the recorder, because only one process may poll adsb.lol, and `make live` refuses to start while it runs:
```bash
pkill -f record-cells
```
```bash
make live
```
- **What to expect:** at 0.04 req/s, live adsb.lol is browse quality. A 40 nm view covers 2–3 cells, each refreshed about once a minute. Chase works, but the aircraft is dead-reckoned between sparse samples. Smooth live chase needs more budget: backlog F2/F6, or your own receiver.
- **Check it's clean:** after ~10 min,
  ```bash
  curl -s http://localhost:8787/api/status
  ```
  should show `budget.maxRps` 0.04, with `budget.counts.r429` and `budget.counts.r4xx` both 0. The server log does not show upstream statuses.
- **Afterwards,** restart the recorder from the main checkout, at the interval it has run clean at. `>>` appends, so the log's 429 history is kept. Never go below 12500 ms:
  ```bash
  nohup caffeinate -i npm run record:cells -- --interval-ms 24000 >> data/recordings/record-cells.log 2>&1 &
  ```

## Done when

- [ ] Terrain & sun is merged on `main` and pushed. `npm run check` gives 680/680 and `vite build` passes.
- [ ] Gate GE passes on your Mac (2.2), and the look checks match `.planning/plans/assets/WP-E-A/gate-GE/`.
- [ ] `make` starts the app on a recording and prints the link. Chase over Innsbruck shows relief, both toggles work, and night works.
- [ ] F1 is merged, and `make live` runs clean: after 10 min, `/api/status` shows `budget.counts.r429` = `r4xx` = 0.
- [ ] The recorder is running again, and no stray servers are left.

---

## Backlog (not part of this handoff)

The full text of each item, with specs, is in the previous handoff: `git show 4a5e1cc:.planning/HANDOFF.md`.

- **F2 · Low-budget poll mode** (`server/poller.ts`): one view-centred circle instead of the cell cover when `MAX_RPS` < 0.5.
- **F6 · adsb.fi** as a second free source: about 12× the live budget, which makes smooth live chase possible. Its envelope must be confirmed with one real request per endpoint.
- **F3 · MLAT re-join velocity continuity** (`hermite.ts`/`track.ts`). Measure it first with `tools/bench-track.ts`.
- **F4 · Approach pitch** (`attitude.ts`): descending below 175 kt should use approach AoA.
- **F5 · Estimator `dedupe` switch** for the bench.
- **Detail panel:** a distance-from-home row, and signal ages that count up between polls.
- **F7 · Real airliner glTF model**, with a re-run of the V3 calibration.
- **Gates G1/G2/G3/GB** on the real repo, then `.planning/reports/VERDICT.md`.
- **Milestones M4** (ground realism), **M5** (product loop), **M6** (receiver switch, when the hardware arrives).
- **Terrain & sun follow-ups:** they are listed in each WP-E plan's "Notes for later work". Examples: a `sampleTerrainMostDetailed` fallback for camera ground while the relief grows from flat, and an upstream report of Cesium's TerrainPicker race.

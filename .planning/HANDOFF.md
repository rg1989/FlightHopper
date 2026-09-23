# FlightHopper — Handoff: remaining code work

**Written:** 2026-09-23, at `main` = `4af8be8` (code from `307245e`, plus the terrain & sun plans). **Scope:** code fixes and code changes only.

## Where things stand

**In `main`, and working:**
- **Everything in `.planning/PLAN.md` up to and including the browse & detail feature.** That's 35 work packages applied from `.planning/plans/WP-*.md`, one commit per task.
- **Checks:** `npm run check` gives 604/604 tests with tsc clean, and `vite build` succeeds.

**What the app does:**
- **Server** (`node:http`): polls one source, `ADSB_SOURCE=adsblol|readsb|replay`. It stamps and dedupes samples in server clock and serves `/api/view`, `/api/chase` and `/api/status`, with gzip, aircraft info, and adsb.lol routes behind `ROUTES=1`.
- **Client** (Vite + CesiumJS), two modes:
  - **Browse** (nothing selected): top-down street map, altitude-coloured icons, visible-aircraft table, legend.
  - **Chase** (aircraft selected): satellite imagery, glTF model, chase camera with drag-orbit, wheel-zoom and double-click reset, the detail panel (planespotters photo, country, airline, spatial, signal, FMS and wind data), and the HUD.

**Run it on recorded data:**
```bash
ADSB_SOURCE=replay REPLAY_FILES=data/recordings/2026-09-22.jsonl RECORD_DIR= npm run server
```
```bash
npm run dev
```
The dev server's `/api` proxy is fixed to port 8787 (`vite.config.ts`). Give the API server another port only if you run vite with a matching proxy.

**Must-read before changing code:**
- `.planning/PLAN.md`: Global Constraints (politeness, time base, heights, file ownership), §4 and §5.3 locked signatures, §6 gates.
- The WP plan of the module you touch.

**Hard rules that apply to every item below:**
- Only one process polls adsb.lol at a time. The budget is `MAX_RPS=0.08`: this IP got 429s at 0.14–0.5 req/s. Stop the recorder before any live server run (`pkill -f record-cells`).
- Tests never touch the network.
- Commit identity is `rg1989 <roman.grinevic@gmail.com>` (set repo-locally). Push to `git@github.com:rg1989/FlightHopper.git`.

**Terrain & sun (user feedback #3): planned, not applied.** The plans are committed in `4af8be8`: `.planning/terrain-sun-design.md`, `.planning/plans/WP-E0…E5` and `WP-E-A`, and `PLAN.md` §5.4. They were validated by rebuilding from the plans alone: 680/680 tests, `vite build` ok, gate GE at FPS p50 137 in headless Chrome.
- **Files they edit when applied:** `client/scene/terrain.ts`, `model.ts`, `chaseCamera.ts`, `runways.ts`, `fleetLayer.ts`, `shared/api.ts`, `server/poller.ts`, `client/app.ts`, `client/ui/layout.css`.
- **Order:** apply them before the items below that touch the same files (F2: `server/poller.ts`; item 7: `client/app.ts`).

**How work is done here.** The pattern:
1. A contract WP (shared types/signatures).
2. Parallel WPs, each implemented and tested in a scratch tree, with its plan generated from the tested files.
3. An assembler that rebuilds from plans.
4. `python3 .planning/tools/apply_plans.py <worktree> <WP stems…>`, run in a worktree on a branch, then a fast-forward merge.

---

## Work items (priority order)

### 0. Apply the terrain & sun plans · WP-E0, E1–E5, E-A · S (mechanical)
1. Branch into a worktree: `git worktree add ../FlightHopper-e -b build/terrain-sun main`, then `npm ci`.
2. Apply, in this order: `python3 .planning/tools/apply_plans.py ../FlightHopper-e WP-E0-terrain-sun-contract WP-E5-recorded-sun-time WP-E1-topography WP-E2-sun WP-E3-ground-objects WP-E4-scene-toggles WP-E-A-integration`. Each WP's full check must stay green; expect 680 tests at the end.
   - **Caveat (dry run, 2026-09-23):** E0–E4 apply green. WP-E5 gives four edits to `server/poller.test.ts` and `server/main.test.ts` as prose ("after the line …, insert …"), not as complete-file blocks, so the tool skips them and E5's check fails (3 tests).
   - **The fix is requested** from the plan's author: complete `File:` blocks for those two tests. Until it lands, apply those four edits by hand, exactly as written in E5 Task 1 Step 1, then continue.
   - Two timing tests can flake under full-suite load ("sortRows and filterRows stay cheap at 12,000 rows", "/api/view of a 250 nm circle with 5,000 aircraft"). Re-run those files alone before treating them as failures.
3. Run gate GE on your Mac, following WP-E-A Task 5.
4. Fast-forward `main`.

Decisions in `terrain-sun-design.md` stand. In particular, **no cast shadows** (you rejected them).

### 1. F1 — Token bucket never climbs back above a refused rate · `server/budget.ts` · S
- **Now:** a 429 halves the rate (floor `maxRps/8`), then it recovers ×1.1 per quiet minute, **all the way back to `maxRps`** (`RECOVERY_STEP_MS`). That re-probes the limit that just refused us.
- **Change:** on each 429, set a run-long ceiling of `min(ceiling, rateAtThe429 / 2)`. Recovery may climb only up to that ceiling. This is the same rule as `tools/record-cells.ts` `nextBase()`.
- **Tests (fake clock):**
  - after a 429 at rate r, the rate never exceeds r/2, even after hours without a 429;
  - two 429s give r/4;
  - `state().maxRps` still reports the configured ceiling (add `ceilingRps` if needed).
- **Needed before:** any live adsb.lol run, including gate G1.

### 2. F2 — Low-budget poll mode · `server/poller.ts` (+ test) · M
- **Now:** a 40 nm view maps to 2–3 of the 4° cells (`cellsForView`), plus a separate `/v2/hex` chase batch. At 0.08 req/s every cell refreshes only every ~30–40 s.
- **Change:** when `bucket.state().maxRps < 0.5`, poll **one view-centred circle** (radius = view radius + 10 nm, ≤ 250, rounded to reduce distinct URLs) instead of the cell cover. Serve the chased hex from that same poll: no hex batch, and the chased aircraft is always inside its own view circle. Keep the cell mode for budgets ≥ 0.5 req/s and for multi-user use.
- **Tests (fake source + clock):**
  - low budget → exactly one request per period, centred on the latest view, and no `hexes()` calls;
  - high budget → current behaviour unchanged.
- **Coordinate:** WP-E also edits `server/poller.ts`.

### 3. F6 — Second free source: adsb.fi open data · new adapter · M
**What it gives you:**
- **About 12× the live budget.** adsb.fi publishes 1 req/s for its public endpoints; adsb.lol tolerates about 0.08 req/s from this IP. Browse areas would refresh every few seconds instead of every ~37 s, and a chased aircraft could update at ~1 Hz. **That makes smooth live chase possible before your own receiver arrives.**
- **An independent feeder network.** It covers some places adsb.lol misses and vice versa, and it's a fallback if adsb.lol throttles or blocks.
- **The same readsb per-aircraft JSON**, so it's a small adapter; the estimator, UI and switch are unchanged.
- **Later, as a feeder** (after the receiver feeds adsb.fi): the feeder-only `/api/v2/snapshot`, which gives **all aircraft worldwide**, refreshed twice a minute, 1 request per 30 s, from the feeder's IP.

**Its rules** (README verified 2026-09-22, https://github.com/adsbfi/opendata):
- personal, non-commercial use only;
- you must cite adsb.fi and link to its home page;
- 1 req/s;
- responses 400/401/403/404/429 **count toward the limit**, and excessive invalid requests trigger a temporary IP restriction.

**Endpoints** (base `https://opendata.adsb.fi/api`):
- `/v3/lat/{lat}/lon/{lon}/dist/{nm ≤ 250}` for areas. Don't use v2 lat/lon: it's deprecated and returns a different format.
- `/v2/hex/{h1,h2,…}` or `/v2/icao/{…}` for batched hexes.
- Also `/v2/callsign/…`, `/v2/registration/…`, `/v2/sqk/…`, `/v2/mil`.

**Change:**
1. **Contract** (WP-00 files, as a small contract WP):
   - add `'adsbfi'` to `SourceKind` and to `RecordLine.source`;
   - add `normalizeAdsbfi(body)` to `shared/readsb.ts` and to the `normalizers` map.
   - **The response envelope isn't documented.** Confirm it with **one** real request per endpoint at build time (list key? `now` in s or ms?) and save each as a golden fixture in `data/fixtures/golden/`.
2. **`server/sources/adsbfi.ts`:** `makeAdsbfi({ userAgent, baseUrl?, timeoutMs? }): Source` with caps `{ kind:'adsbfi', fullSnapshot:false, maxRps:1, coverage:null, attribution:'Data: adsb.fi (https://adsb.fi)' }`. Model it on `server/sources/adsblol.ts`. Validate lat/lon/radius/hexes client-side so no 4xx is ever sent.
3. **Wiring and UI:**
   - `server/sources/index.ts` (`case 'adsbfi'`);
   - `server/config.ts`: accept `adsbfi`, require `CONTACT`, clamp `MAX_RPS` ≤ 0.9;
   - `.env.example`: document it;
   - `client/app.ts` `attributionFor`: show "Data: adsb.fi" with a link when the source is adsbfi (the source kind is in `StatusBrief`).
4. **Replay and recorder:** accept `source:'adsbfi'` lines (normalizer map). Optionally, a recorder mode that collects 1 Hz arrival fixtures from adsb.fi. That's the missing input for gate G2's motion metrics.

**Tests:** normalizer on the golden bodies, adapter URLs and caps against a mock server (as in `server/sources/adsblol.test.ts`), config validation.

### 4. F3 — MLAT re-join velocity continuity · `client/track/hermite.ts`, `client/track/track.ts` · S–M
- **Now:** when a fresh MLAT sample re-smooths recent knots, positions blend over 1.5 s but velocity steps (I2 measured a lateral-acceleration p99 of 61 m/s² in causal MLAT replay). `track.ts` already carries a `#vBlend` for the vertical and a "velocity bump".
- **First:** measure with `node tools/bench-track.ts --recordings <file> --hex <an MLAT hex>`.
- **Then, if still over the bar:** blend velocity as well as position in `RejoinBlend` (cubic Hermite from the old state to the new one).
- **Gate:** G2 MLAT bar, lateral accel p99 ≤ 0.5 g.

### 5. F4 — Approach pitch · `client/track/attitude.ts` · S
- **Now:** with `phase === null`, descending means `'descent'` (AoA 2°), so a 3° glide renders nose-down (−1°).
- **Change:** descending and `gsMs < 90` (≈ 175 kt) → `'approach'` (AoA 4°).
- **Test:** 3° glide at 140 kt gives pitch ≈ +1°.
- **Later:** M4's phase detector replaces this rule.

### 6. F5 — Estimator dedupe switch for the bench · `client/track/track.ts`, `registry.ts`, `tools/bench-track.ts` · S
Add a `dedupe?: boolean` option (default `true`) to `Track`/`TrackRegistry`. Make `--no-dedupe` in `bench-track` pass `false`, so G2 can report jerk with and without dedupe (now both numbers are identical).

### 7. Detail panel gaps · `client/ui/detail.ts`, `client/app.ts` · S
- **Distance row:** add an optional reference position (`VITE_HOME=lat,lon`, later the receiver site) and show the great-circle distance (nm) in SPATIAL.
- **Signal ages** (Last position, Last seen): count them up between polls from the raw object's receive time instead of freezing at the reported value.

### 8. F7 — Real airliner model · `public/models/`, `public/models/manifest.json` · S
- **Now:** a placeholder (Cesium Air, a prop plane).
- **Change:** add a free (CC0/CC-BY/Apache) airliner glTF ≤ 5 MB, with source and licence in the manifest, and optionally pick the model by `typeCode`/category.
- **Calibration:** re-run the WP-V3 calibration test with the new model's nose axis (≤ 1° azimuth at KSFO 28L/1R and synthetic headings; pitch/roll signs).

### 9. Run the gates on the real repo · reports in `.planning/reports/`
- **G1** (after F1 + F2): stop the recorder, then run `ADSB_SOURCE=adsblol MAX_RPS=0.08 npm run server` with one view and one selection for 60 min, plus `node tools/gate-g1.ts --minutes 60`. Pass: 0 × 4xx. The flip test already passes in CI.
- **G2:**
  - motion: `node tools/bench-track.ts` on recordings (1 Hz fixtures need F6);
  - datum: `node tools/datum-check.ts --airport KSFO` and `--airport LLBG` (|median| ≤ 10 m);
  - census: `node tools/census.ts` (per hero, ≥ 80 % tracked below 200 ft AGL).
- **G3 and GB:** in the browser with `?bench=1` (download the report with `b`). G3 is a KSFO arrival: FPS, clearance and calibration. GB is `data/recordings/synthetic-heavy.jsonl` (generate it with `.planning/plans/assets/WP-B-A/gen-synthetic-heavy.ts`): 5,000 aircraft, FPS p50 ≥ 50 and table ≤ 5 ms.
- **Then:** write `.planning/reports/VERDICT.md` using the PLAN §6 rules.

### 10. Remaining milestones (code) · detailed plans to be written per PLAN §7
- **M4 Ground realism:** runway surfaces (planar vs `globe.clippingPolygons`, p95 gap ≤ 1 m), geometric touchdown + clamp blend, phase detector, likely-runway inference + centreline flag, KSFO/LLBG thresholds hand-verified.
- **M5 Product loop:**
  - Hop: nearest, phase-ranked within 15 nm of heroes;
  - a Tower camera preset;
  - HUD honesty tags;
  - "no data below X ft" and degraded UX;
  - perf flags and phone FPS.
- **M6 Receiver switch** (when the hardware arrives):
  - readsb with `--net-api-port`, `ADSB_SOURCE=readsb`;
  - dual-source merge: one Poller per source into one `SampleStore`, local preferred while fresh;
  - GNSS-interference quality gate at LLBG (`nic < 6`, jumps);
  - Cloudflare Tunnel, with the server serving `dist/`;
  - a 24 h replay soak.

### Notes
- `tools/record-cells.ts` is the running recorder (3 heroes, 40 nm, ~0.08 req/s). `tools/record-arrivals.ts` (1 Hz arrival fixtures) needs more budget than adsb.lol gives, so use it with F6 or the receiver.
- Photos: planespotters sometimes refuses a browser request from `localhost` (CORS); reselecting retries. Their terms forbid proxying photos through our server.

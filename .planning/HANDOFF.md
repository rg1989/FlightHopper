# FlightHopper — Handoff

**Updated:** 2026-09-23. The previous handoff (apply terrain & sun, gate GE, run the full app) is done. Its step-by-step text is in `git show d242fed:.planning/HANDOFF.md`. The long-form backlog specs are in `git show 4a5e1cc:.planning/HANDOFF.md`.

## Where things stand

- **`main` has the MVP plus terrain & sun plus F1.** `npm run check`: `tsc` clean, 681/681. `vite build` works (the only warning is the usual one about a chunk over 500 kB).
- **Terrain & sun** (`5ff0b0e`): chase mode has 3-D relief with sun shading, a **3-D terrain** toggle (T) and a **Sun** toggle (L). The sun follows real time, and replays are lit at their recorded time. Design and decisions: `.planning/terrain-sun-design.md`. `apply_plans.py` gave 611 → 613 → 633 → 654 → 663 → 677 → 680, as planned.
- **F1** (`85a7577`): after a 429, `server/budget.ts` halves the upstream rate for good. The handoff's ceiling rule (`ceiling = min(ceiling, rps/2)`, `rps = min(ceiling, max(maxRps/8, rps/2))`) reduces to `rps /= 2`, because `rps ≤ ceiling` always holds. So the ×1.1 recovery and the `maxRps/8` floor were deleted, and no `ceilingRps` field was needed. This is the same rule as `tools/record-cells.ts` `nextBase()`.
- **`make`** replays the newest recording and prints the link. **`make live`** was checked against adsb.lol: 10.8 min with a 40 nm view over LLBG, 27 requests (0.04 req/s plus the burst of 2), all 200, `r429` = `r4xx` = `r5xx` = `err` = 0. At this rate live is browse quality: 2 cells, each refreshed about once a minute, and a chased aircraft is dead-reckoned between sparse samples (backlog F2/F6).
- **The recorder** runs again from the main checkout (`--interval-ms 24000`, log `data/recordings/record-cells.log`). Stop it before any live run: only one process may poll adsb.lol.

### Gate GE results (2026-09-23, headless Chrome on the M2)

- **Ridge, 10 terrain presses:** FPS p50 144.9 / p5 102, `longTasks` [], worst animation frame 10.7–16.8 ms, `noGroundSettled` 0, `groundUnknownSettled` 0, `groundUnknown` 10 of 539 in the windows (the memo works), `shadows` false, clearance min 426 m, 0 violations. The validated run was 137 / 103 and 326 m.
- **Looks match `.planning/plans/assets/WP-E-A/gate-GE/`:** LOWI morning, golden hour and night (61 GIBS tiles, all 200, z ≤ 8), the grow from flat (f 1e-7 → 0.24 → 0.70 → 1.00, `relH` 627.72), browse at night (unlit, toggles hidden, no GIBS), keys and persistence, phones 375×667 and 375×812 (no overlap, no sideways scroll), ground objects (HDG 261°, GND through a flatten and a grow), KSFO at its recorded time (clock 2026-09-22T18:00Z).
- **Harness pages:** WP-E4 toggles and WP-E2 sun pass. WP-E1 topography: `undefinedSettled` 0 and `worstMs` ≤ 45 ms. `avgMs` was 16–29 ms at a load average of 10–20, which is over the 16.7 ms bar; WP-E1's own reference run was also over it (Cesium shader compiles). A first run at a higher load gave `undefinedSettled` 62; the rerun gave 0.

## Rules

- **adsb.lol:** only one process polls it at a time. This IP got 429s at 0.14–0.5 req/s, and once at ~0.082 req/s after 1.5 h; it has run clean at 0.04 req/s. `make live` sets 0.04 (`LIVE_RPS`). The server's own `MAX_RPS` default is still 1 req/s (backlog).
- **Tests never touch the network.**
- **Keep the machine's load low:** no parallel full-suite runs and no stray servers. Stop what you start. Two timing tests flake when the load average is high: "sortRows and filterRows stay cheap at 12,000 rows" and "/api/view of a 250 nm circle with 5,000 aircraft". Confirm them with `node --test client/ui/table.test.ts server/main.browse.test.ts`.
- **Other sessions share this machine.** Their headless Chromes have used CDP port 9334, which is also the gate driver's default. Run the driver with `CDP_PORT=<free port>`. The Browser pane is a hidden tab (`requestAnimationFrame` paused), so it cannot show the chase scene: use the gate driver.
- **Git:** commit identity `rg1989 <roman.grinevic@gmail.com>` (set repo-locally). Push to `git@github.com:rg1989/FlightHopper.git`. `git add` explicit paths only. Never commit other sessions' untracked files.
- **Decisions in `terrain-sun-design.md` stand:** no cast shadows; night keeps the mountains faintly visible; lighting applies in chase only; replays are lit at their recorded time.

## Open: decide first

**Night lights wash out big cities.** At night over a large metro area, the chase view's ground becomes one flat blob. Reproduce: `make REC=data/recordings/2026-09-22.jsonl`, then at once open `/?hex=3c64a8&sun=2026-09-22T17:40:00Z` (DLH681 climbing out over Tel Aviv at ~2,700 ft).
- At brightness 1.6 (as shipped), the land and the sea near the coast are flat white-beige: `.planning/reports/night-washout/tlv-1740Z-night-brightness-1.6.jpg`.
- At brightness 0.6 it is flat grey: `…-0.6.jpg`. So the cause is resolution, not brightness. The layer is VIIRS Black Marble at z8 max (about 500 m per pixel) at alpha 0.9999. From a low chase camera over a dense city, a few dozen of those pixels fill the view.
- Innsbruck (gate GE) is too small to show it. The "3-D structures" session found it first (its `.planning/reports/buildings-poc/C-limits.jpg`, untracked).
- Options: fade the night layer's alpha with the camera's height above ground (the land then shows the dark lit globe close up, and lights from higher up); cap the brightness over bright pixels; or find a sharper night source (GIBS has no Black Marble above z8). The owner is WP-E2 (`client/scene/sun.ts`, `client/scene/nightLights.ts`).

## Backlog

- **`MAX_RPS` default** (`server/config.ts`): the default is 1 req/s, which contradicts `PLAN.md`'s Global Constraints. Make it 0.04, so a plain `npm run server` against adsb.lol is polite without `make live`. Update `server/config.test.ts`.
- **F2 · Low-budget poll mode** (`server/poller.ts`): one view-centred circle instead of the cell cover when `MAX_RPS` < 0.5.
- **F6 · adsb.fi** as a second free source: about 12× the live budget, which makes smooth live chase possible. Its envelope must be confirmed with one real request per endpoint.
- **F3 · MLAT re-join velocity continuity** (`hermite.ts`/`track.ts`). Measure it first with `tools/bench-track.ts`.
- **F4 · Approach pitch** (`attitude.ts`): descending below 175 kt should use approach AoA.
- **F5 · Estimator `dedupe` switch** for the bench.
- **Detail panel:** a distance-from-home row, and signal ages that count up between polls.
- **F7 · Real airliner glTF model**, with a re-run of the V3 calibration.
- **Gates G1/G2/G3/GB** on the real repo, then `.planning/reports/VERDICT.md`.
- **Milestones M4** (ground realism), **M5** (product loop), **M6** (receiver switch, when the hardware arrives).
- **Terrain & sun follow-ups:** each WP-E plan's "Notes for later work". Examples: a `sampleTerrainMostDetailed` fallback for camera ground while the relief grows from flat, and an upstream report of Cesium's TerrainPicker race.
- **Parallel work in other sessions (not committed):** a 3-D buildings PoC (OSM extrusions) and sharper chase imagery research (`.planning/reports/sharper-chase-imagery-research.md`).

# FlightHopper — Implementation Plan (v2, parallel)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Dispatch **one subagent per work package (WP)**; every WP has its own plan in `.planning/plans/WP-*.md`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A free, personal-use CesiumJS globe of live aircraft where you pick one and chase it in third person over real terrain, down to a geographically correct landing. Built now on the free adsb.lol API, and switched to your own ADS-B receiver by changing one setting.

**Architecture:** One small Node server (stdlib `http`, no framework) polls one upstream *source*: adsb.lol today, your receiver later, or recorded replay for development. It stamps and dedupes samples in server clock and serves them over plain HTTP polling to a Vite + CesiumJS client. The client runs a delayed-playback estimator (Hermite horizontal, filtered vertical, synthesised attitude) and drives a chase camera over ellipsoidal terrain. The former "Phase 0 spikes" are now measurable **gates** run against the real code.

**How it parallelises:** **Contract-first.** WP-00 (Wave 0, ~2–3 h, one agent) writes every cross-package type and small shared helper as real, tested code, plus golden fixtures and the build setup. After that, **20 Wave 1 packages run in parallel**. Each owns disjoint files and depends only on WP-00. Three Wave 2 integrators and three Wave 3 glue packages follow, each starting as soon as *its own* inputs are merged, not the whole previous wave. No two packages edit the same file, so merges cannot conflict.

**Tech Stack:** Node ≥ 24.2 (native TypeScript type-stripping), `node:test`, TypeScript 7 (type-check only), Vite 8, CesiumJS 1.145, `egm96-universal`. Nothing paid.

**Supersedes:** `FINAL-PLAN.md` and `PHASE-0-RESEARCH-BRIEF.md` (kept as history). Review evidence: workflow `wf_a83bb071-6da` (45 verified findings + 7 completeness findings), indexed in §10.

**Safety:** Entertainment / situational awareness only — not for navigation, ATC or operational decisions. The UI says so.

---

## Global Constraints

Every task in every WP plan implicitly includes these.

- **Runtime:** Node `>=24.2`. Run TypeScript directly (`node server/main.ts`); no build step for server/tools. Erasable TS only — no `enum`, `namespace`, parameter properties, decorators. Relative imports carry `.ts`. `"type": "module"`. CLI entry points use `if (import.meta.main)`.
- **Tests:** `node:test` + `node:assert/strict`; `*.test.ts` next to the code. `npm test` discovers them by glob, so **no WP edits `package.json`**. `npm run check` = `tsc --noEmit` + all tests.
- **Dependencies (complete list, installed by WP-00):** runtime `cesium`, `egm96-universal`; dev `vite`, `vite-plugin-static-copy`, `typescript`, `@types/node`. A WP that needs anything else stops and files a contract change request (§5).
- **No paid services.** Allowed: adsb.lol public API (no key today), Cesium ion **Community** token (free, non-commercial), Re:Earth terrain (keyless), EOX Sentinel-2 cloudless (keyless), OurAirports (public domain), Cloudflare Tunnel / Tailscale free tiers.
- **Upstream politeness (adsb.lol):** ≤ **`MAX_RPS` total** from all processes combined. The default is **0.08 req/s**. On 2026-09-22 this IP got 429s at 0.5, 0.33 and 0.14 req/s and ran clean at ~0.08 req/s for hours, so the old "1 req/s" premise is void. `Accept-Encoding: gzip`, `User-Agent: FlightHopper/0.1 (+${CONTACT})`. 429 → halve the rate **and never climb back above half the refused rate for the rest of the run**; honour `Retry-After`. 401/403 → stop that source, no retry loop, "blocked" banner. 5xx/timeout → exponential backoff with jitter. Never probe for the failure rate. Only one process polls adsb.lol at a time (stop the recorder before a live server run). **Unit tests never touch the network**: they use local mock servers and golden fixtures.
- **Time:** `Sample.tMs` is **server clock**, from the upstream response's own `now` minus `seen_pos`. Never stamp with a receipt time.
- **Heights:** render heights are WGS84 ellipsoidal metres (HAE), `h = H + N`, N from `shared/geoid.ts`. `Sample` keeps ADS-B units (ft, kt, fpm, deg). The estimator converts to SI.
- **`alt_geom` is HAE only when `version === 2`.** Otherwise the altitude ladder's plausibility check decides.
- **Privacy:** `dbFlags & 4` (PIA) and `dbFlags & 8` (LADD) are dropped server-side unless `SHOW_PIA_LADD=1`.
- **Attribution** visible in the UI: adsb.lol (ODbL), OurAirports, terrain/imagery credits.
- **File ownership:** a WP creates or edits **only** the files listed for it in §4. It may read anything.
- **Commits:** at least one per task; conventional-commit messages; agents end commit messages with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## 0. Assumptions (defaults used until you say otherwise)

| # | Assumption | Default | If wrong |
|---|---|---|---|
| A1 | Receiver will be in Israel (machine clock is on IDT) | Local hero **LLBG** (EGM96 N = +19.6 m, opposite sign to KSFO's −32.3 m, which is what the datum gate needs) | Change `tools/heroes.json` |
| A2 | Audience: you + a few friends | HTTP polling, home-hosted, Cloudflare Tunnel | Public launch → rights matrix + WS fan-out (v1) |
| A3 | A free Cesium ion Community token is fine | Cesium World Terrain + Bing via ion | `VITE_TERRAIN=reearth`, `VITE_IMAGERY=eox` (keyless) |
| A4 | Courtesy note to adsb.lol is sent by you | Draft: `.planning/reports/adsblol-note.md` (WP-I3) | — |
| A5 | Live chase needs ~1 Hz samples; adsb.lol gives this IP ~1 poll / 12 s | Live adsb.lol = **browse** quality. Chase quality is proven on recordings (G2) and delivered by your receiver (M6) | If the operator allows more, or you pick the adsb.fi option (F6), re-run G1 |

---

## 1. What changed from FINAL-PLAN (and why)

| Decision | FINAL-PLAN | v2 | Review ids |
|---|---|---|---|
| Research phase | Throwaway spikes | Gates G1–G3 on real code | IC1, IC7 |
| Terrain (MVP) | Terrarium via CustomHeightmap | Ellipsoidal quantized-mesh (ion CWT or Re:Earth), switchable | SS2, TD3, TD5, CC1 |
| Upstream budget | 2 req/s, 1 Hz per chased hex | 1 req/s bucket, one batched `/v2/hex/{…}`, chase-first priority, 403 stops | PE1, IC2, PE3, PE7 |
| Stamping | `t_recv − seen_pos`, drop unchanged | `upstream.now − seen_pos` → server clock via windowed min offset; dedupe with tolerance | AB1, IC4, PE6, SS5 |
| Transport | Fastify + ws | `node:http` + HTTP polling with `since`; WS → v1 | SS6 |
| Frontend | React + Zustand | Vanilla TS + DOM | YAGNI |
| Node | 22 | ≥ 24.2 | CC7 |
| Vertical | Hermite through raw alt | α-β filter + slewed ladder switches | AB4 |
| Attitude | unspecified | pitch = FPA + AoA; roll = broadcast ?? coordinated turn; yaw = heading ?? track | CC2 |
| MLAT | 6 s floor | + outlier gate + smoothing + own metric | AB6 |
| Touchdown | first `onGround` | geometric (runway polygon, near runway HAE, decelerating) — M4 | AB2, IC3 |
| Datum test | OA vs terrain (N cancels) | pinned geoid unit test (WP-00) + `alt_geom` at KSFO & LLBG (G2) | IC1, TD1, SS1 |
| Heroes | KSFO + LOWI | KSFO + LLBG by coverage census; LOWI = terrain showcase | AB3, SS3, TD2 |
| Own receiver | "path to RE-API" | a **source** (`ADSB_SOURCE=readsb`), goodwill, future key | PE5, SS7 |
| Privacy | dropped | PIA/LADD filtered | IC12 |
| NASR | MVP | v1 (heroes hand-verified) | scope |

---

## 2. Architecture

```
            ┌──────────────── server (Node, stdlib http) ────────────────┐
 upstream   │  Source ──► Poller ──► toSample ─► SampleStore (dedupe) ──┼──► /api/view   ┐
 (one of):  │   ▲          │ TokenBucket (1 rps)     ▲                  │   /api/chase   ├─► client (Vite + Cesium)
 adsb.lol   │   │          │ Cells (4° bands)       MinOffset           │   /api/status  ┘     TrackRegistry → RenderState
 readsb     │   │          └─► Recorder (raw JSONL) ──► data/recordings │                      AircraftLayer, ChaseModel,
 replay ◄───┼───┘                                                       │                      ChaseCamera, HUD, Bench
            └───────────────────────────────────────────────────────────┘
```

**The switch.** `ADSB_SOURCE=adsblol|readsb|replay`. All three use readsb's per-aircraft JSON. Only the envelope differs, and `shared/readsb.ts` handles that (verified: the golden test proves both normalise to identical snapshots).

| | adsb.lol v2 | own readsb (`--net-api-port`) | replay |
|---|---|---|---|
| list key / `now` | `ac` / ms | `aircraft` / **seconds** | readsb-shaped |
| area | `/v2/point/{lat}/{lon}/{nm}` | `/?circle=lat,lon,nm` | in memory |
| hex batch | `/v2/hex/{h1,h2,…}` | `/?find_hex=h1,h2,…` (≤1000) | in memory |
| everything | — | `/?all_with_pos` | yes |
| `fullSnapshot` | false | true | true |

`fullSnapshot` sources are read with one `all()` per second and serve every view and chase from that one read. There are no cells and no budget pressure. Area sources use cells plus the chase batch under the token bucket.

**Hosting (free).** Dev: laptop. Later the server runs on the receiver's home box, serves `dist/`, and is exposed via Cloudflare Tunnel.

---

## 3. Dependency graph

```
Wave 0      WP-00 contract & scaffold  (starts day-1 recorder)
              │
Wave 1   ┌────┴──────────────┬───────────────────┬──────────────────────────────┐
(20 ‖)   S1 S2 S3 S4         C1 C2 C3 C4 C5       T1 T2 T3                        V1 V2 V3 V4 V5 V6 V7 V8
         │  │  │  │          └───────┬─────┘      │  │  │                         └──────────┬──────────┘
Wave 2   └──┴──┴──┴─► I1 Poller      I2 Track     │  │  │                                    │
(3 ‖)    S1–S4 ─────► I3 ArrivalRec   │           │  │  │                                    │
Wave 3   I1 ─────────► A1 Server app  ├───────────┼──┴──┼──► A3 Bench CLI                    │
(3 ‖)                                 └───────────┼─────┼────────────────────────────────────┴─► A2 Client app
Gates    A1 → G1 (budget, flip)       A3 + T3 + recordings → G2 (motion, datum, census)      A1 + A2 → G3 → VERDICT
```

**Critical path:** WP-00 → S1/S2/S3/S4 → I1 → A1 → G1, and WP-00 → C1–C5 → I2 → A2 → G3. Wall-clock is dominated by **recordings**: the day-1 recorder (WP-00 Task 9) starts collecting in the first hour, so G2 has 24–48 h of data when A3 lands.

---

## 4. Work packages

Signatures are **locked**. A WP implements exactly what it "Produces" and may only rely on what it "Consumes". WP-00 is the source of truth for all types (`shared/types.ts`, `shared/api.ts`, `shared/airports.ts`, `server/sources/types.ts`, `server/recording.ts`, `client/types.ts`, `client/track/types.ts`, `tools/types.ts`).

### Wave 0

| WP | Owns | Produces |
|---|---|---|
| **00** Contract & scaffold — `plans/WP-00-contract-and-scaffold.md` | `package.json`, lockfile, `tsconfig.json`, `.gitignore`, `.env.example`, `vite.config.ts`, `index.html`, `client/main.ts` (placeholder until A2), `shared/{types,api,airports,readsb,sample,geoid,dedupe,clock,geo}.ts`, `server/sources/types.ts`, `server/recording.ts`, `client/types.ts`, `client/track/types.ts`, `tools/types.ts`, `tools/record-cells.ts`, `data/fixtures/**` | `normalizeAdsblol/normalizeReadsb(body): Snapshot`, `normalizers` · `classify(ac): Quality` · `isHidden(ac): boolean` · `toSample(ac, upstreamNowMs, offsetMs, rxMs): Sample \| null` · `geoidN(lat, lon): number` · `class Deduper { accept(s): boolean; forget(hex): void }` · `class MinOffset { constructor(windowMs); update(localRecvMs, remoteNowMs): void; get ready(): boolean; get(): number }` · `distanceNm`, `bearingDeg`, `destination` · `RecordLine`, `parseRecordLine`, `readRecording(path)`, `recordingToSamples(lines, { hideFlagged? }): Sample[]` · `nextInterval(...)` + running recorder |

### Wave 1 — all parallel, each depends only on WP-00

**Server**

| WP | Owns | Produces |
|---|---|---|
| **S1** Live sources | `server/sources/{http,adsblol,readsb}.ts` + tests | `timedFetch(url, opts: { userAgent?: string; timeoutMs?: number }): Promise<Omit<FetchResult, 'snapshot'>>` (never throws; status 0 on error/timeout; `retryAfterS` from seconds or HTTP-date) · `makeAdsblol(opts: { userAgent: string; baseUrl?: string; timeoutMs?: number }): Source` (`circle` → `/v2/point/{lat.toFixed(4)}/{lon.toFixed(4)}/{min(250, round(nm))}`; `hexes` → `/v2/hex/{≤100 lowercased, comma-joined}`; `all` rejects `Error('unsupported')`; caps `{kind:'adsblol', fullSnapshot:false, maxRps:1, coverage:null}`) · `makeReadsb(opts: { baseUrl: string; coverage: {lat; lon; radiusNm}; timeoutMs?: number }): Source` (`/?circle=`, `/?find_hex=`, `/?all_with_pos`; caps `{kind:'readsb', fullSnapshot:true, maxRps:5}`). `snapshot` is null when status ≠ 200 **or** the body fails to normalise. |
| **S2** Replay, recorder, fake receiver | `server/sources/replay.ts`, `server/recorder.ts`, `tools/fake-readsb.ts` + tests | `makeReplay(opts: { files: string[]; speed?: number; loop?: boolean; nowMs?: () => number }): Source`. Virtual time `vt = firstTRecv + (nowMs() − start)·speed`. Every call returns a readsb-shaped body `{now: vt/1000, aircraft}` holding the latest recorded object per hex seen ≤ 60 s before `vt`. Each object's `seen_pos` is rebased so `now − seen_pos` equals its original position time. That time is mapped into recording clock with one global offset `min(tRecvMs − nowMs)` over all lines. caps `{kind:'replay', fullSnapshot:true, maxRps:10, coverage:null}` · `class Recorder { constructor(dir: string); write(kind: SourceKind, r: FetchResult): void }` (skips `'replay'`, UTC daily files, body only on 200) · `startFakeReadsb(opts: { files: string[]; port: number; speed?: number }): Promise<{ url: string; close(): Promise<void> }>` + CLI. Serves `/?circle`, `/?find_hex`, `/?all_with_pos` in the readsb API envelope `{now, resultCount, ptime, aircraft}`. |
| **S3** Budget | `server/budget.ts`, `tools/gate-g1.ts` + tests | `class TokenBucket { constructor(maxRps: number, nowMs?: () => number, random?: () => number); tryTake(): boolean; onResult(status: number, retryAfterS: number \| null): void; state(): BudgetState; get degraded(): Degraded }`. Burst 2. On 429: `rps = max(maxRps/8, rps/2)`, pause `Retry-After ?? 5 s`. Recovery: ×1.1 per 60 s without a 429. On 401/403: blocked forever. On 5xx/0: pause `min(60 s, 2^k s + jitter)`. `degraded` is blocked → `'blocked'`; a 429 < 60 s ago → `'rate-limited'`; ≥ 3 consecutive 5xx/0 → `'upstream-down'` · `evaluateG1(reports: StatusReport[], seconds: number): { pass: boolean; checks: { name: string; value: number; threshold: number; pass: boolean }[] }` + CLI `node tools/gate-g1.ts --base http://127.0.0.1:8787 --minutes 60` → `.planning/reports/G1-<date>.json` |
| **S4** Cells & store | `server/cells.ts`, `server/store.ts` + tests | `interface Cell { id: string; lat: number; lon: number; radiusNm: number }`. `cellsForView(lat, lon, radiusNm): Cell[]` uses 4° latitude bands. Lon step is `360 / floor(360·cos(φc)/4)`. id is `b{band}:{col}`. Query radius is half-diagonal + 10 nm, ≤ 250. It returns the cells whose query circle intersects the view circle. `cellById(id): Cell` · `class SampleStore { constructor(opts?: { horizonMs?: number }); add(s: Sample): boolean; view(lat, lon, radiusNm, sinceRxMs): Sample[]; track(hex, sinceRxMs): Sample[]; latest(hex): Sample \| null; prune(nowMs): void; get size(): number }` (180 s ring; `Deduper` inside; `view(…, 0)` = latest per hex in circle) |

**Client math (pure, node-testable)**

| WP | Owns | Produces |
|---|---|---|
| **C1** ENU | `shared/enu.ts` + test | `geodeticToEcef(latDeg, lonDeg, hM): [number, number, number]` · `ecefToGeodetic(x, y, z): { lat; lon; h }` · `class Enu { constructor(lat0, lon0, h0); fwd(lat, lon, h): [e, n, u]; inv(e, n, u): { lat; lon; h } }` (WGS84 exact, round-trip < 1 mm) |
| **C2** Horizontal | `client/track/hermite.ts`, `client/track/mlat.ts` + tests | `hermite(a: KinPoint, b: KinPoint, t: number): { e; n; ve; vn }` · `extrapolate(last: KinPoint, turnRateDegS: number, dtS: number): { e; n; ve; vn }` (constant speed & turn rate; + = right turn) · `class RejoinBlend { constructor(durationS?: number); start(errE, errN, tS): void; offset(tS): { e; n } }` (default 1.5 s) · `gateOutliers(pts: PosT[], maxSpeedMs: number): PosT[]` · `smoothPositions(pts: PosT[], halfWindow: number): PosT[]` · `velocitiesFromPositions(pts: PosT[]): KinPoint[]` |
| **C3** Timing | `client/track/delay.ts` + test | `delayFloorS(q: Quality): number` (adsb2 3, adsb01 4, mlat 6, other 6) · `targetDelayS(q, pollPeriodS, gapP90S): number` = `clamp(max(floor, poll+1, p90+1), 3, 10)` · `p90(xs: number[]): number` · `class RenderClock { constructor(delayS: number, maxSlewSPerS?: number); tick(serverNowMs: number, targetDelayS: number, dtS: number): number; get delayS(): number }` (slew ≤ 0.2 s/s; returns tRenderMs) |
| **C4** Vertical | `client/track/vertical.ts` + test | `class AltitudeLadder { height(s: Sample): { hM: number; source: AltSource } \| null }`. It returns null on ground. Rungs: geom when `version === 2`. v0/1 geom only if within 60 m of the baro chain. baro-qnh `(altBaroFt + (qnh − 1013.25)·27)·0.3048 + nM` when 950 ≤ qnh ≤ 1050 and altBaroFt < 18000. Otherwise baro-bias: `altBaroFt·0.3048 + nM + learned bias`. A rung switch keeps continuity: the jump becomes an offset that decays ≤ 0.5 m/s · `class VerticalFilter { constructor(opts?: { alpha?: number; beta?: number }); add(tS, hM, rateMs: number \| null): void; at(tS): { hM; vsMs } \| null }` (times in **seconds**; the ladder also returns null when a sample has no altitude) (α-β over samples, Hermite between filtered states, rate-extrapolate after last) |
| **C5** Attitude | `client/track/attitude.ts` + test | `targetAttitude(i: { gsMs; vsMs; headingDeg; broadcastRollDeg: number \| null; turnRateDegS; onGround; phase: Phase \| null; mlat: boolean }): Att`. pitch = `atan2(vs, gs) + AoA`, where AoA is ground 0, takeoff/climb 6, cruise/descent 2, approach/landing 4; when phase is null it's inferred from vs. Pitch clamps to [−15, 25]. roll = broadcast ?? `atan(V·ω/g)`, clamped ±35, and 0 on ground or MLAT · `class AttitudeSmoother { constructor(tauS?: number); step(target: Att, dtS: number): Att }` (heading wrap-safe) · `turnRateDegS(prevTrackDeg, trackDeg, dtS): number` |

**Tools**

| WP | Owns | Produces |
|---|---|---|
| **T1** Airports | `tools/build-airports.ts`, `tools/heroes.json`, `public/airports/heroes.json` + test | `parseCsv(text): Record<string, string>[]` (RFC 4180) · `buildAirports(airportsCsv: string, runwaysCsv: string, idents: string[]): Airport[]` (open, non-grass runways; missing heading → bearing; displaced threshold applied; `thrHaeM = elevFt·0.3048 + geoidN(thr)`; equals `data/fixtures/golden/airports-sample.json` within 0.05 m / 1e-6°) · CLI downloads OurAirports CSVs to `node_modules/.cache/ourairports/` and writes `public/airports/heroes.json` |
| **T2** Metrics | `tools/metrics.ts` + test | `percentile(xs, p): number` · `frameDiscontinuity(frames: Frame[]): { maxM; p99M }` (interp frames; `|Δp − v̂Δt|`) · `lateralAccel(frames): { p99; max }` · `jerk(frames): { p99 }` · `verticalMetrics(frames, reported: RateAt[]): { vsErrP95; maxStepM }` · `crossTrackErrors(frames, truth: { t; e; n }[]): number[]` · `delaySlew(delays: { t; d }[]): number` |
| **T3** Datum & census | `tools/analysis/{datum,census}.ts`, `tools/{datum-check,census}.ts` + tests | `approachResiduals(samples: Sample[], rwy: RunwayEnd): { hex; tMs; dNm; rM; version }[]`: airborne, `altGeomFt` present, 0.3–2 nm before the threshold, within 100 m of the extended centreline, `r = altGeomFt·0.3048 − (thrHaeM + 15 + d·tan 3°)` · `summarizeDatum(res, minArrivals?): { arrivals; n; medianM; pass }` · `interface Arrival { hex; callsign; minAglFt; reachedGround; p90GapBelow1000S; geomShare; badNicShare; jumps }` · `findArrivals(samples, ap: Airport): Arrival[]` · `summarizeCensus(a: Arrival[]): { arrivals; trackedBelow200Pct; p90GapBelow1000S; geomSharePct; badNicPct; landingHeroOk }` · CLIs read `--recordings <glob> --airports public/airports/heroes.json --airport KSFO` → `.planning/reports/` |

**Client scene (Cesium; each WP adds its own `harness/<wp>.html` + `.ts` page, served by `npm run dev`)**

| WP | Owns | Produces |
|---|---|---|
| **V1** Viewer | `client/config.ts`, `client/scene/{viewer,terrain,imagery}.ts`, `harness/viewer.*` + test | `readConfig(env: Record<string, string \| undefined>): ClientConfig` · `createViewer(el: HTMLElement \| string, cfg: ClientConfig): Promise<Viewer>` (no timeline/animation/geocoder; `requestRenderMode` off) · `makeTerrain(cfg): Promise<TerrainProvider>` · `makeImagery(cfg): Promise<ImageryProvider \| null>` |
| **V2** Aircraft layer | `client/scene/aircraftLayer.ts`, `harness/aircraft-layer.*` + test | `class AircraftLayer { constructor(viewer: Viewer); update(states: RenderState[], selectedHex: string \| null): void; pick(windowPos: Cartesian2): string \| null; destroy(): void }` |
| **V3** Model calibration | `client/scene/model.ts`, `public/models/manifest.json`, `public/models/*.glb`, `harness/model.*` + test | `hprFor(state: RenderState, m: ModelManifestEntry): HeadingPitchRoll` · `modelMatrixFor(state, m, result?: Matrix4): Matrix4` · `noseAzimuthDeg(modelMatrix: Matrix4, noseAxis?: Cartesian3): number` · `class ChaseModel { static load(viewer: Viewer, m: ModelManifestEntry): Promise<ChaseModel>; update(state: RenderState): void; show: boolean; destroy(): void }` · calibration test: azimuth error ≤ 1° at KSFO 28L, 1R and 0/90/180/270; pitch +10 → nose up; roll +20 → right wing down |
| **V4** Chase camera | `client/scene/chaseCamera.ts`, `harness/chase-camera.*` + test | `chaseOffsetEnu(headingDeg, pitchDeg, rangeM): [e, n, u]` · `class OrbitControl { drag(dxPx, dyPx): void; wheel(delta): void; reset(): void; headingOffsetDeg; pitchDeg; rangeM }` · `class ChaseCamera { readonly orbit: OrbitControl; constructor(viewer: Viewer, opts?: { rangeM?; pitchDeg?; minClearanceM?; headingTauS? }); update(state: RenderState, dtS: number): { clearanceM: number \| null }; release(): void }` (damped heading; camera ≥ terrain + 15 m; while chasing: drag orbits, wheel zooms 25 m–3 km, double-click resets, globe controls off until `release()`) |
| **V5** Runways | `client/scene/runways.ts`, `harness/runways.*` + test | `runwayCorners(r: Runway): { lat; lon; h }[]` · `addRunways(viewer: Viewer, airports: Airport[]): { destroy(): void }` (planar polygon at interpolated threshold HAE + threshold markers) |
| **V6** HUD & banner | `client/ui/{format,hud,banner}.ts`, `client/ui/ui.css`, `harness/hud.*` + test | `hudFields(s: RenderState \| null, status: StatusBrief): { label; value; tag: 'observed' \| 'derived' \| 'stale' \| 'unknown' }[]` · `bannerText(status: StatusBrief, s: RenderState \| null): string \| null` · `mountHud(root): { update(s, status): void; destroy(): void }` · `mountBanner(root): { update(status, s): void; destroy(): void }` · `mountAttribution(root, lines: string[]): void` (includes "not for navigation") |
| **V7** API client | `client/api.ts` + test | `class ApiClient { constructor(base: string, fetchFn?: typeof fetch, nowMs?: () => number); view(lat, lon, radiusNm): Promise<ViewResponse>; chase(hex): Promise<ChaseResponse>; serverNowMs(): number; get ready(): boolean }` (tracks `since` per view key/hex; MinOffset of local recv − `serverNowMs`; throws `Error` with status on HTTP error). Query format: `GET {base}/view?lat&lon&nm&since`, `GET {base}/chase?hex&since` |
| **V8** Bench overlay | `client/bench/overlay.ts` + test | `interface BenchReport { label; frames; fpsP50; fpsP5; frameMsP95; longTasks; longTaskMsMax; minClearanceM: number \| null; clearanceViolations; heapMB: number \| null }` · `summarizeFrames(frameMs: number[]): { fpsP50; fpsP5; frameMsP95 }` · `class BenchRecorder { constructor(viewer: Viewer, opts?: { label?: string; minClearanceM?: number }); frame(state: RenderState \| null, clearanceM: number \| null): void; report(): BenchReport; download(filename?: string): void; mountOverlay(root: HTMLElement): void }` |

### Wave 2 — each starts when its inputs are merged

| WP | Needs | Owns | Produces |
|---|---|---|---|
| **I1** Poller | S1 S2 S3 S4 | `server/poller.ts` + test | `interface PollerOpts { cellPeriodMs: number; chasePeriodMs: number; fullSnapshotPeriodMs: number; interestTtlMs: number; chaseTtlMs: number; recorder: Recorder \| null; hideFlagged: boolean; nowMs?: () => number }` · `class Poller { constructor(source: Source, store: SampleStore, bucket: TokenBucket, opts: PollerOpts); touchView(lat, lon, radiusNm): Cell[]; touchChase(hex): void; tick(): Promise<boolean>; start(): void; stop(): void; brief(): StatusBrief; report(): StatusReport }` — chase batch first, then most-overdue cell; `fullSnapshot` → `all()` each period; per-source `MinOffset` → server clock |
| **I2** Track | C1–C5 | `client/track/{track,registry}.ts` + tests | `class Track { constructor(hex: string, opts?: { pollPeriodS?: number }); add(s: Sample): boolean; stateAt(tRenderMs: number): RenderState \| null; gapP90S(): number; get quality(): Quality; get newestTMs(): number \| null; get delayTargetS(): number }` (8 s extrapolation cap → `stale`) · `class TrackRegistry { constructor(opts?: { pollPeriodS?: number }); ingest(samples: Sample[]): void; states(tRenderMs: number): RenderState[]; get(hex): Track \| undefined; delayTargetS(hex: string \| null): number; prune(serverNowMs: number, maxAgeS: number): void }` |
| **I3** Arrival recorder | S1 S2 S3 S4 | `tools/record-arrivals.ts`, `.planning/reports/adsblol-note.md` + test | `pickArrivals(samples: Sample[], heroes: { ident; lat; lon; elevFt }[]): string[]` (≤ 25 nm, < 10,000 ft, descending or rolling) · CLI: hero cells every 6 s + batched hex 1 Hz under one `TokenBucket(1)` + `Recorder`; replaces `record-cells` |

### Wave 3 — glue

| WP | Needs | Owns | Produces |
|---|---|---|---|
| **A1** Server app | I1 S1 S2 | `server/sources/index.ts`, `server/config.ts`, `server/main.ts` + e2e tests | `makeSource(cfg): Source` · `readServerConfig(env): ServerConfig` · `createServer(cfg: ServerConfig, deps?: { source?: Source; nowMs?: () => number }): { listen(port: number): Promise<string>; close(): Promise<void>; poller: Poller }` · routes `GET /api/view`, `/api/chase`, `/api/status`, static `dist/` · **flip test**: identical API assertions for `replay` and for `readsb` → `startFakeReadsb` |
| **A2** Client app | V1–V8 I2 (runtime data: T1 `heroes.json`, V3 manifest) | `client/main.ts` (replaces placeholder), `client/app.ts` + test, `.planning/plans/assets/WP-A2/*` (synthetic KSFO replay + generator) | `startApp(root: HTMLElement, cfg: ClientConfig): Promise<{ stop(): void }>`. It polls `view` at 1 Hz for the camera-view circle and `chase` at 1 Hz for the selection, runs `RenderClock` against the server clock, and drives layer, model, camera, HUD, banner and attribution. `?bench=1` shows the overlay; `?hex=` auto-chases (for G3) |
| **A3** Bench CLI | I2 T2 | `tools/bench-track.ts` + test | Causal replay: `readRecording` → server stamping → simulated 1 Hz client poll (+100 ms hop) → `TrackRegistry` → 60 Hz `Frame[]` → metrics; `--decimate k` + held-out truth · `evaluateG2(m): { pass; checks }` → `.planning/reports/G2-<hex>-<date>.json` |

**Parallel width:** 1 → 20 → 3 → 3. With subagents, calendar time ≈ WP-00 + slowest Wave 1 WP + slowest I + slowest A, plus the gates.

---

## 5. Execution protocol (for the orchestrating agent)

1. **Wave 0:** run WP-00 on `main`; tag `wave-0`. Confirm the recorder is running (`tail data/recordings/*.jsonl`).
2. **Per WP:** create a worktree `git worktree add ../fh-<wp> -b wp/<wp> wave-0` (Wave 2/3: branch from the latest `main` containing the WP's "Needs"). Dispatch one subagent with its plan file. It must touch only its owned files.
3. **Contract change requests:** if a WP needs a type/signature change or a dependency, it **stops that task** and writes `.planning/requests/<wp>-<n>.md` (what, why, proposed diff). The orchestrator applies approved contract edits on `main` (as a WP-00 follow-up commit), rebases waiting branches, and resumes. WPs never edit WP-00 files themselves.
4. **Merge:** as soon as a WP's `npm run check` passes in its worktree, merge `--no-ff` into `main`, run `npm run check` on `main`, delete the worktree. Order does not matter because ownership is disjoint.
5. **Unblock:** after each merge, start any Wave 2/3 WP whose "Needs" are all merged.
6. **Tags:** `wave-1` when all 20 are merged (informational only; nothing waits on it).
7. **Gates** run on `main` as soon as their inputs merge. Reports go to `.planning/reports/`.

### 5.1 Plan validation (done 2026-09-22, workflow `wf_00600502-dab`)
Every WP was implemented and tested in a scratch tree before its plan was written; each plan embeds that exact code. An independent assembler then rebuilt the project **from the plan files alone** (WP-00 base + 26 plans + assets): `npm run check` → tsc clean, **453/453 tests**, `vite build` ✓. A task-by-task replay was green at all 62 stages. No two WPs write the same path.

### 5.2 Follow-up tickets (small; dispatch after the WP they touch is merged — each is independent)
| # | Touches | Change | Why |
|---|---|---|---|
| F1 | S3 `server/budget.ts` | After a 429, cap the ceiling at half the refused rate for the process lifetime (no recovery above it) | Politeness: recovering to a refused rate is probing (same rule as `record-cells`) |
| F2 | I1 `server/poller.ts` | Single-user low-budget mode: when `MAX_RPS < 0.5`, poll one view-centred circle (radius = view + 10 nm) instead of the 4° cell cover, and serve chase from it (no hex batch) | A 40 nm view needs 2–3 cells; at ~0.08 req/s each would refresh every ~30 s |
| F3 | C2 `hermite.ts` + I2 `track.ts` | Re-join blends velocity as well as position | MLAT causal replay: lateral accel p99 61 m/s² from velocity steps at re-join |
| F4 | C5 `attitude.ts` | `phase === null`, descending and gs < 90 m/s → approach AoA | Final approach otherwise renders nose-down (−1° instead of ≈ +1°) |
| F5 | I2 `track.ts` + A3 | `Track`/`TrackRegistry` opt `dedupe?: boolean` (default true) | A3 `--no-dedupe` cannot show the with/without comparison otherwise |
| F6 | new source (S1-style adapter) | **Needs your decision.** adsb.fi open data (personal/non-commercial, published 1 req/s) as a second free source | ~12× the budget adsb.lol currently gives this IP |
| F7 | V3 manifest | Replace the placeholder Cesium Air (Apache-2.0 prop plane) with a proper airliner | Cosmetic; later |

### 5.3 Browse & detail (user feedback #2, 2026-09-22) — WP-B0 contract, then 8 parallel WPs, then B-A

The goal is to resemble adsb.lol's tar1090 view. With nothing selected, the camera goes **top-down** and zooms out over a map. Aircraft are drawn as **icons rotated to track and coloured by altitude**, with an altitude legend and a sortable **table of the aircraft on screen**. Selecting one opens a **detail panel**: photo with credit, callsign/hex, registration + country flag, airline, type, squawk, route, then spatial, signal, FMS-selected and wind data. It must stay fluid with thousands of aircraft. Browse uses cheap dead-reckoning from each aircraft's newest sample. The full estimator runs only for the chased aircraft. The eight B-* packages depend only on B0: the table and detail panel receive country, flag and airline lookups from B-A (`flagOf`, `lookup`) rather than importing B-C1/B-C2.

| WP | Needs | Owns | Produces |
|---|---|---|---|
| **B0** Contract — `plans/WP-B0-browse-contract.md` | A1 A2 A3 V4 | `shared/info.ts`; additive edits to `shared/types.ts`, `shared/api.ts`, `client/types.ts` | `AircraftInfo`, `RouteInfo`, `toInfo`, `sameInfo`, `ViewResponse.info?`, `ChaseResponse.raw?/info?`, `FleetEntry` |
| **B-C1** Country | B0 | `shared/icaoCountry.ts` + test | `countryOf(hex: string): { iso2: string; name: string } \| null` (ICAO 24-bit address allocation blocks) · `flagEmoji(iso2: string): string` |
| **B-C2** Airlines | B0 | `shared/airlines.ts`, `shared/airlines.json`, `tools/build-airlines.ts` + test | `airlineOf(callsign: string \| null): string \| null` (ICAO 3-letter designator prefix → name) |
| **B-S1** Server info + routes + gzip | B0 | `server/infoStore.ts`, `server/routes.ts` + tests; edits `server/poller.ts` (`PollerOpts.info?: InfoStore`), `server/main.ts`, `server/config.ts` (`ROUTES`) | `class InfoStore { update(ac: ReadsbAircraft, rxMs: number): void; since(hexes: Iterable<string>, sinceRxMs: number): AircraftInfo[]; get(hex): AircraftInfo \| null; raw(hex): ReadsbAircraft \| null; setRoute(callsign: string, route: string \| null): void; needRoutes(max: number): { callsign: string; lat: number; lon: number }[]; prune(nowMs: number, horizonMs: number): void }` · `class RouteFetcher { constructor(opts: { bucket: TokenBucket; userAgent: string; nowMs?: () => number; fetchFn?: typeof fetch; minIntervalMs?: number }); tick(store: InfoStore): Promise<boolean> }` (one batched POST `/api/0/routeset` ≤ 100 callsigns, ≥ 60 s apart, shares the poller's bucket, cache 6 h, negative cache 1 h) · `/api/view` adds `info`, `/api/chase` adds `raw` + `info` · gzip when `Accept-Encoding` allows |
| **B-V1** Fleet layer | B0 | `client/scene/fleetLayer.ts`, `client/scene/icons.ts`, `client/scene/altitudeColor.ts`, `client/ui/legend.ts`, `harness/fleet-layer.*` + tests | `altitudeColor(altFt: number \| null, onGround: boolean): string` (tar1090-like scale) · `iconFor(category: string \| null, typeCode: string \| null): IconKind` · `class FleetLayer { constructor(viewer: Viewer); update(entries: readonly FleetEntry[], selectedHex: string \| null, hoverHex: string \| null): void; pick(windowPos: Cartesian2): string \| null; destroy(): void }` (one BillboardCollection, own silhouettes, rotated to track, reused billboards, one hover label) · `mountLegend(root): { destroy(): void }` |
| **B-V2** Fleet | B0 | `client/browse/fleet.ts` + test | `class Fleet { ingest(samples: Sample[], info?: AircraftInfo[]): void; entries(tServerMs: number): readonly FleetEntry[]; get(hex: string): FleetEntry \| undefined; prune(tServerMs: number, maxAgeS: number): void; get size(): number }` (newest sample per hex, great-circle dead-reckoning ≤ 20 s, reused objects, no per-frame allocation) |
| **B-V3** Browse camera + map | B0 | `client/scene/browseCamera.ts`, `client/scene/mapLayer.ts`, `harness/browse.*` + test | `enterBrowse(viewer: Viewer, center: { lat: number; lon: number } \| null, opts?: { heightM?: number; flyS?: number }): void` (north-up top-down, tilt locked) · `exitBrowse(viewer: Viewer): void` · `viewRectangleDeg(viewer: Viewer): { west: number; south: number; east: number; north: number } \| null` · `makeMapLayer(viewer: Viewer): { show: boolean; destroy(): void }` (OpenStreetMap-style street map for browse; satellite for chase) |
| **B-U1** Table | B0 | `client/ui/table.ts`, `client/ui/table.css`, `harness/table.*` + test | `sortRows(rows: FleetEntry[], key: TableKey, desc: boolean): FleetEntry[]` · `filterRows(rows, query: string): FleetEntry[]` · `mountTable(root: HTMLElement, opts: { onSelect(hex: string): void; onHover(hex: string \| null): void; flagOf?: (hex: string) => string }): { update(all: readonly FleetEntry[], onScreen: readonly FleetEntry[], selectedHex: string \| null): void; destroy(): void }` (virtualised rows, ≤ 1 Hz, flag · callsign · route · type · squawk · alt · speed; totals; search) |
| **B-U2** Detail panel + photos | B0 | `client/ui/detail.ts`, `client/ui/photo.ts`, `client/ui/detail.css`, `harness/detail.*` + tests | `interface Photo { thumbUrl: string; link: string; photographer: string }` · `class PhotoCache { constructor(fetchFn?: typeof fetch); get(hex: string): Promise<Photo \| null> }` (planespotters.net public API, selected aircraft only, cached) · `interface Lookup { country: { iso2: string; name: string; flag: string } \| null; airline: string \| null }` · `detailRows(s: RenderState \| null, raw: ReadsbAircraft \| null, info: AircraftInfo \| null, lookup: Lookup): DetailSection[]` · `mountDetail(root: HTMLElement, opts: { onClose(): void; photos?: PhotoCache; lookup(hex: string, callsign: string \| null): Lookup }): { update(s: RenderState \| null, raw: ReadsbAircraft \| null, info: AircraftInfo \| null): void; destroy(): void }` |
| **B-A** Integration | all B-* | rewrites `client/app.ts` (+ test), adds `client/ui/layout.css`; removes the superseded `client/scene/aircraftLayer.*`, `harness/aircraft-layer.*` | Browse mode (nothing selected: `enterBrowse`, map layer, fleet layer, table, legend) ↔ chase mode (model, `ChaseCamera`, detail panel, HUD). `TrackRegistry` gets only the selected hex; `Fleet` gets everything. Table/row click selects; `Esc` returns to browse over the last aircraft. `?heavy=1` bench doc |

**Gate GB (after B-A):**
- Replay a synthetic **5,000-aircraft** recording (generator in B-A's plan; output gitignored). In browse top-down: FPS p50 ≥ 50 and p5 ≥ 30 on your Mac; table update p95 ≤ 5 ms; `/api/view` response ≤ 50 ms server-side.
- Detail panel shows photo, credit, country and airline for a real recorded aircraft (`ADSB_SOURCE=replay REPLAY_FILES=data/recordings/*.jsonl`).
- Routes are fetched only with `ADSB_SOURCE=adsblol`, and only when `ROUTES=1`.

---

## 6. Gates (the former Phase 0)

### G1 — Provider politeness + the switch (after A1, F1, F2)
Revised 2026-09-22. The plan's 1 req/s premise was void (429s at 0.14–0.5 req/s, clean at ~0.08), and the old thresholds couldn't be met even at 1 req/s (S3/I1/A1 simulations). G1 now tests politeness and the switch, not chase cadence.
Stop the recorder, then run `ADSB_SOURCE=adsblol MAX_RPS=0.08 npm run server` with one browser view (+ one selected aircraft) for 60 min at a peak hour, and `node tools/gate-g1.ts --minutes 60`. Fault injection (429 / Retry-After / 403 / 5xx) is covered by S3 + I1 unit tests against mock upstreams.
- **Pass:** 0 × 4xx; average upstream ≤ MAX_RPS (+ one burst of 2 over the window); achieved view refresh period and bytes/hour **reported** (they set browse expectations; no threshold).
- **Flip:** A1's flip test passes (`readsb` via `fake-readsb`). This is the "change one setting" guarantee.
- **Fail →** not fatal: develop on `replay` until the receiver arrives.

### G2 — Motion + datum + coverage (after A3, T3, T1 and ≥ 24 h of recordings)
| Metric (`tools/bench-track.ts`, ADS-B v2) | Threshold |
|---|---|
| Frame discontinuity while interpolating | ≤ 2 m |
| Starvation frames at chosen D | 0 |
| Held-out cross-track error in turns (\|track rate\| > 1°/s), decimated to 3 s / 5 s | p95 ≤ 5 m / ≤ 15 m, and ≤ 50 % of linear |
| Lateral acceleration | p99 ≤ 5.7 m/s² |
| Vertical: \|rendered VS − reported\| / step per frame | p95 ≤ 2 m/s / ≤ 1 m |
| Delay slew | ≤ 0.2 s/s |
| Extrapolation re-join | blended ≤ 1.5 s; p95 reported |
| MLAT (separate bar) | lateral accel p99 ≤ 0.5 g |
| Dedupe | duplicate fraction + jerk with/without reported |

**Datum** (`tools/datum-check.ts`): `|median r| ≤ 10 m` over ≥ 3 v2 arrivals at **KSFO** (N −32 m) and **LLBG** (N +20 m). The geoid unit test in WP-00 is the other half.
**Census** (`tools/census.ts`): a landing hero needs ≥ 80 % of arrivals tracked below 200 ft AGL; report p90 gap < 1,000 ft, `alt_geom` share, `nic < 6` / jump share (GNSS interference).

### G3 — Integrated scene (after A1 + A2)
Replay a recorded KSFO arrival (`ADSB_SOURCE=replay`), open `/?hex=<hex>&bench=1`, and download the bench report. Machine = your Mac (name it).
- FPS p50 ≥ 60, p5 ≥ 30 across 3,000 ft → rollout, plus a LOWI valley pass
- Camera ≥ 15 m above terrain every frame · long tasks > 50 ms after load: 0
- V3 calibration test green (≤ 1° azimuth at 28L, 1R, synthetic headings; pitch/roll signs)
- Runway planes drawn; residual terrain − plane along centreline reported (input to M4)

### Verdict → `.planning/reports/VERDICT.md`
- **GO:** G1, G2 (v2 + datum) and G3 pass.
- **CONDITIONAL-GO:** MLAT bar fails → no MLAT chase · hero fails census → swap hero · FPS fails → drop-layer flags · G1 fails → replay + receiver path.
- **NO-GO (re-plan):** datum fails while the geoid unit test passes → baro-only ladder · v2 held-out metrics fail at 3 s after tuning → chase isn't the differentiator.

---

## 7. After the verdict (M4–M6, same parallel method: contract WP first, then parallel WPs)

**M4 — Ground realism.** Contract addendum: `Phase`, `RunwayMatch`, `GroundState` types. Parallel WPs:
- runway surface mechanism (plane vs `globe.clippingPolygons`, p95 visible gap ≤ 1 m)
- geometric touchdown + clamp blend (≤ 0.5 m/frame, ≤ 5 m total)
- phase detector
- likely-runway inference + centreline flag
- KSFO/LLBG threshold hand-verification vs AIP

**M5 — Product loop.** Parallel WPs:
- Hop (nearest; phase-ranked ≤ 15 nm of heroes)
- Tower camera preset
- HUD honesty tags complete
- search (server-side over the store)
- degraded / "no data below X ft" UX
- perf flags + phone FPS measurement

**M6 — Receiver switch.** Parallel WPs:
- receiver setup doc + `ADSB_SOURCE=readsb` validation (re-run G1 flip + G2 on local recordings)
- dual source: one Poller per source into one store; remote skips cells inside local coverage; prefer local < 5 s
- GNSS-interference quality gate (drop `nic < 6` or implied speed > 1.5 × gs)
- Cloudflare Tunnel + server serves `dist/`
- 24 h soak on a replay upstream with 50 synthetic clients over ≥ 10 regions

**Later (v1+):** WebSocket fan-out · self-hosted Terrarium terrain (commercial path) · OSM runways/taxiways · nominal glide ribbon · NASR automation · rights matrix + public launch · CIFP (v2).

---

## 8. Day-1 user actions (≈ 20 min, parallel to WP-00)

1. Free Cesium ion account → `VITE_CESIUM_ION_TOKEN` in `.env.local` (check the Community plan terms when you sign up).
2. `CONTACT=<your email or URL>` in `.env.local` (User-Agent), needed before WP-00 Task 9 starts the recorder.
3. Optional: send the adsb.lol courtesy note (WP-I3 drafts it).

---

## 9. Risk register

| Risk | Signal | Mitigation |
|---|---|---|
| adsb.lol limits/terms/key change | **realised:** ~0.08 req/s tolerated from this IP (2026-09-22) | live adsb.lol = browse quality; chase via recordings now, receiver later; ask the operator (note drafted); F6 (adsb.fi) if you choose; feeding earns the future key |
| `alt_geom` datum mixed (v0/v1 MSL) | G2 datum | HAE only for v2; ladder |
| Low-altitude coverage gaps | G2 census | heroes by census; "no data below X" UX; receiver |
| GNSS interference near LLBG | census `nic`/jumps | quality gate (M6) |
| ion Community quota | ion dashboard | `reearth` + `eox` |
| 25 ft quantisation bob | G2 vertical | α-β filter |
| Contract churn blocks parallel work | change requests pile up | WP-00 validated end-to-end before fan-out; requests batched by orchestrator |
| Scope creep | WP overrun > 30 % | cut M5 first; never cut gates |

---

## 10. Review evidence index

IC1/TD1/SS1 → WP-00 geoid test + G2 datum · AB1/IC4/PE6/SS5 → `toSample`, `MinOffset`, `recordingToSamples` · PE1/IC2/PE2 → S3, I1, G1 · PE3/PE7 → politeness constraints · PE4/PE5/SS7 → receiver = source · IC5/AB5 → G2 metrics (T2, A3) · AB4 → C4 · AB6 → C2 MLAT + G2 bar · AB2/IC3 → M4 geometric touchdown · AB3/SS3 → T3 census · TD2/CC1 → Terrarium deferred · TD3/TD5/SS2 → V1 terrain switch · TD7 → T1 displaced thresholds · IC9 → V3 calibration test · CC2 → C5 · CC3 → `recordingToSamples` + A3 causal replay · CC4 → G3 integrated scene · CC5 → G3 moving-camera FPS · CC6 → `bytesPerHourEstimate` · CC7 → Node ≥ 24.2 · IC12 → PIA/LADD + ladder units · SS10 → EOX 2016 CC BY noted · SS8 → Google 3D tiles rejected for now.

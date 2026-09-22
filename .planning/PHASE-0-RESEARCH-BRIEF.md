# FlightHopper — Phase 0 Research Brief

**For:** research / spike agent  
**Goal:** Prove or kill the four technical bets that block MVP. Do **not** build the product. Produce evidence, measurements, and a go/no-go recommendation.  
**Parent plan:** `.planning/FINAL-PLAN.md`  
**Safety:** Entertainment / situational awareness only — not for navigation.

---

## Context (one paragraph)

FlightHopper is a CesiumJS live ADS-B globe viewer where users select an aircraft and chase it in third person (camera behind/above), with HUD (GS, ALT, VS, TRK/HDG) and geographically correct takeoff/landing against real terrain and runways. Live data: **adsb.lol v2** via a future thin backend (for P0, a local proxy is fine). Terrain: **AWS Terrarium** + **EGM96**. Airports: **OurAirports** (NASR later). Render ~adaptive delay behind live with Hermite interpolation. Full product is out of scope for this brief.

---

## Deliverable

A single report: `.planning/PHASE-0-RESEARCH.md` with:

1. Executive go / no-go / conditional-go for MVP  
2. Per-spike findings (method, evidence, numbers, screenshots/paths)  
3. Open risks remaining  
4. Recommended next implementation ticket list (ordered, ≤10 items)

Also save any fixtures, scripts, and spike notes under `.planning/phase0/` (or `spikes/phase0/`).

---

## Non-goals

- Full React app, WebSocket fan-out, Hop, glide ribbons, CIFP, OSM, Postgres  
- Production licensing outreach (note issues; do not block on emails)  
- Polished UI / mobile polish  
- Claiming fallback providers work without ToS proof  

---

## Spike A — Terrain + vertical datums (BLOCKER)

### Question
Can Cesium show free global terrain such that a runway and an aircraft with geometric altitude meet correctly in HAE (WGS84 ellipsoidal height)?

### Tasks
1. Fetch Terrarium tiles from AWS Open Data (`elevation-tiles-prod`, Terrarium PNG). Decode height: `h = R*256 + G + B/256 - 32768` (metres, ≈ MSL).  
2. Wire into Cesium via `CustomHeightmapTerrainProvider` (or documented equivalent), preferably through a small local/Cloudflare-style cache proxy.  
3. Apply **EGM96** geoid undulation `N` so terrain HAE ≈ MSL + N (confirm sign convention carefully: Cesium height is ellipsoidal).  
4. Load OurAirports runway ends for **KSFO** and **LOWI** (or equivalent scenic/mountain airport). Convert runway elev MSL → HAE using same geoid.  
5. Place a static marker/model at each threshold using HAE. Visually and numerically compare to terrain height at that lat/lon.

### Exit criteria
| ID | Criterion |
|---|---|
| A1 | Terrain loads in Cesium for KSFO + LOWI without main-thread freeze (record tile decode p95 ms; note resolution used, e.g. downsample 256²→64²). |
| A2 | Threshold HAE from airport JSON vs `globe.getHeight` / sampleTerrain within **~10 m** at both airports. |
| A3 | Documented vertical stack: `alt_geom` (HAE), Terrarium (MSL), OurAirports elev (MSL), EGM96 `N`, Cesium Cartesian. |
| A4 | Explicit note if CustomHeightmap is too slow → recommend quantized-mesh bake path instead. |

### Evidence to capture
- Numbers table (airport, N, elev MSL, elev HAE, terrain HAE, delta)  
- 1–2 screenshots of threshold markers on terrain  
- Script/repo path used  

### Failure mode
If A2 fails by tens of metres after correct geoid math → **no-go** on Terrarium path until fixed; propose alternate terrain strategy.

---

## Spike B — Chase motion on real ADS-B (BLOCKER)

### Question
Does delayed Hermite playback make real adsb.lol tracks look continuous enough for third-person chase?

### Tasks
1. Record **≥10 minutes** each of three `/v2/icao/{hex}` streams at ~1 Hz (or best available), saved as JSON fixtures:  
   - cruise / enroute  
   - arrival / approach (prefer near a major airport)  
   - MLAT or poor-quality track if identifiable  
2. Implement a **minimal** offline/replay estimator (can be a single HTML/TS page):  
   - Server-like stamp: `t_sample = t_recv - seen_pos`  
   - **Dedupe:** if `t_sample` unchanged, discard (adsb.lol often re-serves same position)  
   - Playback delay `D = clamp(p90(inter-sample gap)+1s, 3s, 10s)`  
   - Cubic Hermite (or equivalent velocity-aware) between samples in local ENU  
   - Extrapolation **hard stop at 8 s**, then freeze/fade  
3. Drive a Cesium camera behind the aircraft (simple fixed offset OK).  
4. Optional live path: local proxy polling adsb.lol **politely** (≤ ~2 req/s total; prefer hex poll only for one aircraft).

### Exit criteria
| ID | Criterion |
|---|---|
| B1 | Fixtures saved under `.planning/phase0/fixtures/` with README (hex, time, source URL, quality notes). |
| B2 | On ADS-B v2 fixture: **no visible snap >20 m** over a 5-minute chase segment; turns read as arcs not chords. |
| B3 | Dedupe demonstrably required (show before/after judder clip or metric). |
| B4 | MLAT fixture: heavier delay (≥6 s floor) documented; do not claim approach precision. |
| B5 | Measured: sample gaps p50/p90, chosen `D`, FPS of spike page. |

### Failure mode
If B2 fails after tuning → **conditional-go** only with alternate filter proposal, or **no-go** on chase-as-differentiator until data quality strategy changes.

---

## Spike C — glTF orientation calibration (BLOCKER)

### Question
Can we place one CC0/CC-BY airliner (or generic) glTF on a known runway heading without flying sideways?

### Tasks
1. Pick one free glTF model; record license.  
2. Place on a known runway true heading (from OurAirports).  
3. Resolve Cesium HPR vs glTF forward-axis mismatch; store `{forwardAxisFix, pitchOffsetDeg, gearHeightM, lengthM}` in a tiny models manifest.  
4. Confirm pitch/roll sign convention (even if pitch=0 for this spike).

### Exit criteria
| ID | Criterion |
|---|---|
| C1 | Nose aligns with runway within a few degrees visually. |
| C2 | Manifest schema written; calibration steps reproducible in ≤1 hour. |

### Failure mode
Uncalibrated models → block chase MVP polish, not the whole product; still mark spike incomplete.

---

## Spike D — Provider request economics (BLOCKER-lite)

### Question
Is interest-driven polling against adsb.lol viable without instant 429s?

### Tasks
1. Read current adsb.lol API docs/limits (dynamic limits).  
2. Design cell model: **~250 nm** overlapping query circles; browse cadence **~3 s** per active cell; global token bucket **~2 req/s** (halve on 429).  
3. Chased aircraft: dedicated `/v2/icao/{hex}` at **1 Hz**, deduped.  
4. Simulate or measure: 1 viewer, 10 viewers same cell, viewport spanning 2–4 cells. Count upstream req/s.  
5. Note: production rights/licensing are **out of scope**, but record any “contact us for production” language found.

### Exit criteria
| ID | Criterion |
|---|---|
| D1 | Written budget: max concurrent cells, req/s, backoff policy. |
| D2 | Short soak (≥30–60 min) or scripted simulation with **zero uncontrolled 429s** at the proposed budget (or document the rate that starts failing). |
| D3 | Explicit: “N browsers must not equal N upstream polls.” |

### Failure mode
If even one-cell / 3 s is hostile → propose feeder/RE-API path or negotiated access before MVP scale claims.

---

## Suggested method

1. Work spikes **A → C → B → D** (terrain and model unlock visual judgment of chase).  
2. Prefer small throwaway Vite/TS + Cesium pages over framework sprawl.  
3. Log every upstream call (URL, status, latency).  
4. Prefer recorded fixtures for B over live demos when comparing algorithms.  
5. Be a good API citizen: descriptive User-Agent with contact, backoff on 429, no mesh of global polls.

---

## Key references (verify live)

- Plan: `.planning/FINAL-PLAN.md`  
- ADSB.lol v2: `https://api.adsb.lol/v2/point/{lat}/{lon}/{radius_nm}`, `/v2/icao/{hex}`  
- Terrarium: `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`  
- OurAirports: `https://ourairports.com/data/`  
- CesiumJS: Apache-2.0 — CustomHeightmapTerrainProvider, camera `lookAtTransform`  
- EGM96 / geoid undulation grids (NGA or equivalent library, e.g. geographiclib)

---

## Report template (copy into PHASE-0-RESEARCH.md)

```markdown
# Phase 0 Research Report

## Verdict
Go | Conditional-go | No-go
One paragraph why.

## Spike A — Terrain/datums
### Method
### Results (table)
### Pass/Fail vs A1–A4
### Artifacts

## Spike B — Chase motion
### Method
### Results (gaps, D, snap metrics)
### Pass/Fail vs B1–B5
### Artifacts

## Spike C — Model calibration
### Method
### Results
### Pass/Fail vs C1–C2
### Artifacts

## Spike D — Provider economics
### Method
### Results (req/s, 429s)
### Pass/Fail vs D1–D3
### Artifacts

## Cross-cutting risks
-

## Recommended next tickets (ordered)
1.
```

---

## Definition of done for this research agent

- [ ] `.planning/PHASE-0-RESEARCH.md` complete with verdict  
- [ ] Fixtures + spike code paths referenced  
- [ ] Each of A–D marked pass/fail against exit criteria  
- [ ] Clear statement: **safe to start MVP implementation?** yes/no/with conditions  

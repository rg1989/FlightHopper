# Fixtures

`golden/` — tiny, committed, used by unit tests. Real adsb.lol responses captured on 2026-09-22, trimmed:

| File | What | Source |
|---|---|---|
| `adsblol-point-ksfo.json` | `/v2/point` KSFO, 7 aircraft: v2 airborne, ground, `adsr_icao`, `adsb_other` (`~` hex), `dbFlags: 8` | api.adsb.lol |
| `adsblol-point-lowi.json` | `/v2/point` LOWI, 9 aircraft incl. one `mlat` | api.adsb.lol |
| `adsblol-hex.json` | batched `/v2/hex/{h1,h2,h3}` | api.adsb.lol |
| `readsb-circle.json` | the KSFO aircraft re-wrapped as a readsb `--net-api-port` response (`aircraft`, `now` in seconds) | derived |
| `recording-sample.jsonl` | 4 RecordLines: real poll, synthetic re-serve of it (+1 s), a 429, second real poll 2.5 s later | derived |
| `adsbfi-egll-arrival.jsonl` | 236 Samples (the server's own records, one per line) of IBE07MM, an A350-900 landing east at Heathrow on 2026-09-28 15:59–16:07 UTC at the chase rate: the turn onto final, a 3° approach, the touchdown (flagged airborne until 99 kt) and the rollout. The physics regression test (`client/track/realdata.test.ts`) | opendata.adsb.fi, via the app's server |
| `airports-sample.json` | KSFO, LLBG, LOWI built from OurAirports + EGM96 (expected output of tools/build-airports.ts) | OurAirports (public domain) |

Top-level `*.jsonl` — curated replay fixtures (cruise, arrival, MLAT) promoted from `data/recordings/` (gitignored).

**Privacy:** aircraft flagged PIA or LADD (`dbFlags & 12`) have their identity replaced with unallocated ICAO addresses `000001`, `000002` and their callsign, registration and type removed. The app hides such aircraft anyway.

**License:** adsb.lol data is © adsb.lol contributors, ODbL 1.0 (https://opendatacommons.org/licenses/odbl/1-0/).
adsb.fi data: https://adsb.fi (open data, personal and non-commercial use, attribution).
OurAirports data is public domain.

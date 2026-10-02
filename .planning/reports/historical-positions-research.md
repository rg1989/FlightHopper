<!-- .planning/reports/historical-positions-research.md -->
# Aircraft positions in the past: free sources for one aircraft and for everything in view

Research only. No project code changed. The probes ran on **2026-10-01, 10:38–11:05 UTC**, from this Mac. Lines that say 2026-09-30 refer to the earlier FZ1073 probes (files in `.work/fz1073/sources/adsb/`). Source code was read at these commits: tar1090 `e784ee5` (2026-09-29), readsb `0947209` (2026-09-27), adsblol/infra `b4712ea`, adsblol/api `3c969c8`, openskynetwork/opensky-api `c4af9c9`, Flightradar24/fr24api-sdk-python `5d8ef20`, ClickHouse/adsb.exposed `de92823`. Line numbers refer to those trees. "Docs only" means not probed. Probe outputs stay in the session scratchpad, not in the repo. No request went to an adsb.fi or airplanes.live host. Nothing here is legal advice.

## Summary

- **The best free, keyless source is the tar1090 "heatmap" file.** readsb writes one file per UTC half hour. The file holds every aircraft that the network heard, at most one position per aircraft per slice.
- **adsb.lol serves these files** at `https://adsb.lol/globe_history/YYYY/MM/DD/heatmap/NN.bin.ttf`, with 10 s slices. One request (12–25 MB gzip) gives the whole world for 30 minutes. Probes: 200 for 2026-09-30 and for 2026-09-01; 404 for 2026-08-15, 2026-07-01 and 2026-06-01. So the server keeps about 30 days.
- **The same file answers both questions.** Filter it by bounding box for (b), "everything in view". Filter it by hex for (a), "one aircraft". It has lat, lon, baro altitude (25 ft steps), ground speed, callsign and squawk. It has no track, no vertical rate and no type.
- **One aircraft at full resolution:** `https://adsb.lol/data/traces/<xx>/trace_full_<hex>.json` covers the last 24 h + 60 min. For an earlier UTC day, `globe_history/YYYY/MM/DD/traces/<xx>/trace_full_<hex>.json` covers that day. The day file worked for `a0cbff` (16,052 points) but gave 404 for FZ1073's `8965d1`.
- **Older than the server keeps:** adsb.lol publishes every day since 2023-02-16 on GitHub (ODbL 1.0), about 3.5 h after the UTC day ends. A day is about 4 GB. The heatmap files are inside. HTTP Range requests can extract one half hour without the 4 GB download (tested on 2 days).
- theairtraffic.com serves the same heatmaps with 60 s slices. ADS-B Exchange refuses: 403 "Direct access to globe history data is not permitted."
- **OpenSky** gives no history without an account. A free account gives states back 1 hour and tracks back 30 days. OpenSky's terms require a written licence for "operational use of the REST API in any live product, service, or automated system". Trino is for university, government and aviation-authority research only.
- **Paid options** need accounts and do not beat the keyless path here: Flightradar24 API Explorer ($9/month, 30 days, one timestamp per call), FlightAware AeroAPI Personal (no history, tracks up to 10 days back).
- **No probed history source sends a CORS header that another origin can use,** except the adsb.exposed ClickHouse demo. The FlightHopper Node server must do the fetching.

---

## Comparison table

| Source | Per aircraft / by area | How far back | Time step | Time range in one request? | Key / account | Cost | Licence / terms | Browser CORS | Verified |
|---|---|---|---|---|---|---|---|---|---|
| adsb.lol live trace `data/traces/<xx>/trace_full_<hex>.json` | per aircraft | 24 h + 60 min, rolling | adaptive, median 1–4 s | yes, whole window | none | free | ODbL 1.0 | not checked | probe 2026-09-30 |
| adsb.lol day trace `globe_history/…/traces/…` | per aircraft | ≥ 1 day (2026-09-30 OK), limit unknown | adaptive | yes, one UTC day | none | free | ODbL 1.0 | no `Access-Control-Allow-Origin` | probe: 200 `a0cbff`, 404 `8965d1` |
| **adsb.lol heatmap** `globe_history/…/heatmap/NN.bin.ttf` | **all aircraft, global** | **about 30 days** (2026-09-01 OK, 2026-08-15 404) | **10 s slices** | **yes, 30 min** | none | free | ODbL 1.0 | no | probe |
| adsb.lol GitHub daily archives | both | 2023-02-16 to yesterday | as above | 1 day per archive (~4 GB), or 1 half hour by Range | none | free | ODbL 1.0 | no | probe (Range) |
| theairtraffic heatmap | all aircraft, global | ≥ 30 days | 60 s slices | yes, 30 min | none | free | none published | no | probe |
| theairtraffic day trace | per aircraft | not served | – | – | – | – | – | – | probe: 404 × 2 |
| ADS-B Exchange globe history | – | refused | – | – | – | – | JETNET terms | – | probe: 403 × 2 |
| ADS-B Exchange samples | both | 1st of each month, since 2016-07 | snapshots 5 s (60 s before 2020-05), hires traces 0.5 s | 1 snapshot or 1 aircraft-day per file | none | free | "testing and evaluation", no redistribution | no | probe (1 file) |
| OpenSky REST, anonymous | – | none (403) | 10 s, live only | – | none | free | OpenSky terms | only `https://opensky-network.org` | probe |
| OpenSky REST, account | both | states 1 h, tracks 30 days | states 5 s, tracks = waypoints | states: no. tracks: 1 flight | free account, OAuth2 | 4,000 credits/day per endpoint group | licence needed for app use | same | docs |
| OpenSky Trino | both (SQL) | 2013 onward | 1 s | yes | approved researchers only | free | research only | n/a | docs |
| OpenSky weekly datasets | both | Mondays 2017-06-05 → 2022-06-27 | 10 s | 1 hour per file | none | free | OpenSky data licence | n/a | probe (listing) |
| Flightradar24 API | both | Explorer 30 days, Essential 2 years, Advanced to 2016-05-11 | 10 s (60 s before 2019-11-18) | no, 1 timestamp per call | paid account | $9 / $90 / $900 per month | keep ≤ 30 days | not checked | docs |
| FlightAware AeroAPI | per aircraft | Personal: track ≤ 10 days. Standard: 2011 onward | not checked | 1 flight per call | account | Personal: $5 free per month. Standard: $100/month minimum | Personal: personal/academic only | not checked | docs |
| adsb.exposed ClickHouse (demo) | both (SQL) | airplanes.live real time, adsb.lol archives | ~1–2 s | yes (SQL) | none (public user `website`) | free | technology demo, source restrictions | `*` | probe (1 query) |
| airplanes.live, adsb.fi, adsb.one | – | no history API | – | – | – | – | non-commercial | – | docs |

---

## 1. tar1090 and readsb history (the keyless path)

### 1.1 What readsb writes

readsb writes history when it runs with `--write-globe-history <dir>`. The help text says: "Write traces to this directory, 1 gz compressed json per day and airframe" (`readsb/help.h:106`). Heatmaps need `--heatmap <interval in seconds>` (`help.h:111`). They go to the same directory unless `--heatmap-dir` is set (`help.h:110`).

**Per-day traces.**
- Path: `<dir>/YYYY/MM/DD/traces/<last 2 hex digits>/trace_full_<hex>.json` (`globe_index.c:659-663`). Non-ICAO addresses get a `~` before the hex.
- The file is gzip level 9. It covers 00:00–24:00 UTC of that day (`globe_index.c:592-603`).
- readsb rewrites the file during the day. It stops writing the previous day 55 min after midnight (`globe_index.c:580`).
- Format: readsb trace JSON (`README-json.md:210-246`). Each row is `[seconds after timestamp, lat, lon, alt|"ground", gs, track, flags, vertical rate, aircraft object|null, source type, geom alt, geom rate, IAS, roll]`.

**Trace points are adaptive.** readsb adds a point when speed, vertical rate, altitude or track changes past a threshold (`globe_index.c:2558-2760`). It adds a point at least every `--json-trace-interval`. The code default is 20 s (`readsb.c:193`). The help text says 30 s. Measured median gaps: 0.98 s (`a0cbff`, day file), 3.9 s (`8965d1`, adsb.lol live file, 2026-09-30).

**Live traces.** With globe index or history on, readsb keeps 24 h + 60 min of trace in memory (`readsb.c:2557-2558`). That is the window of `data/traces/<xx>/trace_full_<hex>.json`. tar1090 uses these live files until 60 min after the selected UTC day ends. After that, it uses the `globe_history` files (`tar1090/html/script.js:7476-7491`).

**Heatmap files.** The writer is `handleHeatmap()` (`globe_index.c:3418-3628`).
- One file per UTC half hour: `<dir>/YYYY/MM/DD/heatmap/NN.bin.ttf`. `NN` = 2 × hour + (1 if minute ≥ 30), from `00` to `47` (`globe_index.c:3595`).
- readsb writes the file once, right after its half hour ends. Probe: chunk 08 (04:00–04:30) has `Last-Modified: … 04:30:01 GMT`.
- The content is gzip level 9 (`globe_index.c:3610`). The `.ttf` suffix is only part of the name. The code gives no reason for it. tar1090's nginx config serves these files with `Content-Encoding: gzip` (`tar1090/nginx.conf:71-75`).
- It includes every aircraft with a trace. Only non-ICAO addresses on the ground are left out (`globe_index.c:3467`).
- For each aircraft and slice, it stores the first trace point at or after the slice start. So there is at most one position per aircraft per slice.
- Callsign and squawk go in separate records: at most once per minute, or when they change (`globe_index.c:3476-3495`).
- The slice interval comes from `--heatmap <s>` (`readsb.c:1833-1836`). If the value is not a positive number, readsb keeps its default of 60 s (`readsb.c:199`). tar1090's README suggests 30 (`README.md:383`). adsb.lol uses 10 s (measured). theairtraffic uses 60 s (measured).

**Binary format.** The decompressed file is an array of 16-byte records (`struct heatEntry` = `int32 hex, int32 lat, int32 lon, int16 alt, int16 gs`, `globe_index.h:87-93`). Byte order is little-endian: readsb writes host order, and tar1090 reads with a plain `Int32Array`.

| Record kind | Bytes 0–3 | Bytes 4–7 | Bytes 8–11 | Bytes 12–15 |
|---|---|---|---|---|
| Index (the first `num_slices` records) | record offset of slice *i* | 0 | 0 | 0 |
| Slice header | `0xe7f7c9d` (magic) | slice time in ms, high 32 bits | slice time in ms, low 32 bits | interval in ms (low 16 bits, read unsigned) |
| Position | bits 0–23 address, bit 24 non-ICAO (`~`), bits 27–31 address type | lat × 1e6 | lon × 1e6 | alt int16 (× 25 ft, −123 = ground, −124 = unknown), gs int16 (× 0.1 kt, −1 = unknown) |
| Callsign + squawk | bits 0–23 address | `(1 << 30) \| squawk` (≥ 2^30 marks this kind, squawk digits as a decimal number) | callsign bytes 0–3 | callsign bytes 4–7 |

The reader is tar1090 `initReplay()` and `replayStep()` (`html/script.js:8017-8063`, `8136-8313`). Address types 0–12 are `adsb_icao, adsb_icao_nt, adsr_icao, tisb_icao, adsc, mlat, other, mode_s, adsb_other, adsr_other, tisb_trackfile, tisb_other, mode_ac` (`script.js:8247-8259`). A minimal decoder:

```ts
// buf = decompressed file (Node fetch decompresses Content-Encoding: gzip by itself)
const dv = new DataView(buf); const MAGIC = 0xe7f7c9d; let t = 0; // slice start, ms
for (let o = 0; o + 16 <= dv.byteLength; o += 16) {
  const w0 = dv.getUint32(o, true), lat = dv.getInt32(o + 4, true);
  if (w0 === MAGIC) { t = dv.getUint32(o + 4, true) * 2 ** 32 + dv.getUint32(o + 8, true); continue; }
  if (t === 0) continue;                         // index records before the first slice
  const hex = ((w0 & 0x1000000) ? '~' : '') + (w0 & 0xffffff).toString(16).padStart(6, '0');
  if (lat >= 1 << 30) { /* squawk = lat & 0xffff; callsign = ASCII bytes o+8 … o+15 */ continue; }
  const lon = dv.getInt32(o + 8, true) / 1e6, alt = dv.getInt16(o + 12, true), gs = dv.getInt16(o + 14, true);
  // position of `hex` at t … t + interval: lat / 1e6, lon, alt, gs, address type = w0 >>> 27
}
```

**Retention.** readsb never deletes history. tar1090's README says the files "will be kept indefinitely so if the folder grows too big you'll have to delete old files yourself" (`README.md:375`). So each operator decides how long to keep them.

### 1.2 How tar1090 reads it

- Replay: `?replay=YYYY-MM-DD-HH:MM` (UTC), or `?r=` (`script.js:1210-1224`). It fetches `globe_history/YYYY/MM/DD/heatmap/NN.bin.ttf` (`script.js:7918-7925`). It does not ask for the current half hour, because that file does not exist yet (`script.js:7931-7942`).
- Heatmap view: `?heatmap=<max dots>&heatDuration=<hours>&heatEnd=<hours>`. It loads one chunk per half hour (`early.js:478-539`, `README.md:480-495`).
- Historic trace: `?icao=<hex>&showTrace=YYYY-MM-DD`, with optional `&startTime=HH:MM&endTime=HH:MM` (`script.js:6178-6195`).
- adsb.lol links its replay as `https://adsb.lol?r` (README of adsblol/globe_history_2026).

### 1.3 Which networks serve it (probes, 2026-10-01)

User-Agent `FlightHopper-research/0.1 (personal non-commercial; one-off history probe)`. 2 s or more between requests. Four requests or fewer per host.

| Host | Request | Status | Result |
|---|---|---|---|
| adsb.lol | GET `/globe_history/2026/09/30/traces/d1/trace_full_8965d1.json` | **404** | nginx "404 Not Found" |
| adsb.lol | GET `/globe_history/2026/09/30/heatmap/08.bin.ttf` | **200** | 11,681,741 B, `Content-Encoding: gzip`, `Last-Modified: Wed, 30 Sep 2026 04:30:01 GMT`, `Cache-Control: no-cache`. No `Access-Control-Allow-Origin`, although the request sent `Origin`. |
| adsb.lol | GET `/globe_history/2026/09/30/traces/ff/trace_full_a0cbff.json` | **200** | 349,191 B gzip. UPS A300 N150UP, 16,052 points, 02:08:41–23:09:55 UTC. |
| adsb.lol | HEAD `/globe_history/2026/09/01/heatmap/20.bin.ttf` | **200** | 15,258,789 B, `Last-Modified: Tue, 01 Sep 2026 10:30:12 GMT` |
| globe.theairtraffic.com | GET `/globe_history/2026/09/30/traces/d1/trace_full_8965d1.json` | **404** | nginx 404 behind Cloudflare |
| globe.theairtraffic.com | GET `/globe_history/2026/09/30/heatmap/06.bin.ttf` | **200** | 4,388,912 B uncompressed (no gzip was asked for), `Cache-Control: public, max-age=1209600`. No `Access-Control-Allow-Origin`. |
| globe.theairtraffic.com | GET `/globe_history/2026/09/30/traces/7d/trace_full_4b187d.json` | **404** | an aircraft that is in every slice of the heatmap above |
| globe.theairtraffic.com | HEAD `/globe_history/2026/09/01/heatmap/20.bin.ttf` | **200** | `Last-Modified: Tue, 01 Sep 2026 10:30:00 GMT` |
| globe.adsbexchange.com | GET `/globe_history/2026/09/30/traces/d1/trace_full_8965d1.json` | **403** | text: "Direct access to globe history data is not permitted." |
| globe.adsbexchange.com | HEAD `/globe_history/2026/09/30/heatmap/06.bin.ttf` | **403** | same refusal |

Decoded content:
- **adsb.lol, 2026-09-30, 04:00–04:30 UTC:** 13,208,528 B, 825,533 records, 180 slices of 10 s. It holds 697,014 positions and 128,159 callsign/squawk records for 9,513 aircraft. Each slice has 3,664–3,990 positions. Gaps between one aircraft's positions: p50 10 s, p90 20 s, p99 70 s. In the box 29–34° N, 33–36.5° E: 47 aircraft. Address types: 646,311 `adsb_icao`, 24,011 `mlat`, 19,439 `adsb_icao_nt`, 5,202 `adsr_icao`, the rest TIS-B.
- **theairtraffic, 2026-09-30, 03:00–03:30 UTC:** 30 slices of 60 s, 9,079 aircraft, 166,247 positions. It has FZ1073 (`8965d1`, callsign `FDB1073`, squawk 0527) once per minute, for example 03:07 at 25.298767, 55.258433, 2,600 ft, 263.2 kt.
- **The 8965d1 day trace is missing on both hosts** while their heatmaps have the flight. At adsb.lol, the 404 (`8965d1`) and the 200 (`a0cbff`) came with different sticky-route cookie values (`…17…` and `…54…`). So the replicas may hold different history. This is not verified.

How far back each host goes:
- **adsb.lol:** the live trace covers 24 h + 60 min (code). On 2026-09-30 it covered 06:50 (09-29) to 05:53 for `8965d1`. Heatmaps reach at least 2026-09-01. The day traces reach at least 2026-09-30.
- **adsb.lol follow-up (2026-10-01 ~11:50 UTC, HEAD of chunk 20):** 2026-08-15, 2026-07-01 and 2026-06-01 → 404. 2025-10-01 → 200 (13,132,414 B, `Last-Modified: Thu, 02 Oct 2025 03:00:49 GMT`). So the server keeps about 30 days, plus some older days without a pattern. For anything older than about 30 days, use the GitHub archive.
- **theairtraffic:** the live trace was served on 2026-09-30. Heatmaps reach at least 2026-09-01. Day traces: 404.
- **ADS-B Exchange:** the live trace was served on 2026-09-30. `globe_history`: 403.
- **adsb.fi, airplanes.live:** Cloudflare "Just a moment..." challenge on 2026-09-30. Not probed again (rule).

---

## 2. adsb.lol open data

### 2.1 GitHub daily archives

- **Repos:** `github.com/adsblol/globe_history_2023` … `globe_history_2026`. License: `ODbL-1.0` (GitHub API, 2026-10-01).
- **Content:** "A dump of the /var/globe_history directory from adsb.lol planes containers" (README of `globe_history_2026`). The README says that the heatmap files serve the replay function. It says: "The files in the traces folder are used when displaying the historic data for a specific aircraft."
- **Releases per day:** `vYYYY.MM.DD-planes-readsb-prod-0`, `…-staging-0` and `…-mlatonly-0` (2025–2026). The README says: "Download both files from the prod or staging release for a day you're interested in." The tar is split into `.tar.aa` (2,000,000,000 B) and `.tar.ab`. Join them with `cat … | tar -xf -`.
- **Inside (2026-09-30 prod, read by Range):** `./README.txt`, `./LICENSE-ODbL.txt`, `./LICENSE-cc0.txt`, `./acas/acas.csv.gz`, `./acas/acas.json.gz`, `./traces/<xx>/trace_full_<hex>.json` and `./heatmap/NN.bin.ttf`. The `README.txt` says: "This database is made available under the Open Database License". It also says that feeders waive their rights to their data under CC0.
- **Heatmaps are inside.** In the 2026-09-30 prod archive, `./heatmap/` starts at offset 1,055,355,392 of `.tar.ab`. The first chunk there is `41.bin.ttf`, 24,378,664 B. The heatmap section is about 923 MB, at the end of the archive. In the 2024-10-01 prod archive, `./heatmap/` is at offset 755,712 of `.tar.aa`, near the start. Its first chunks are `22.bin.ttf` (10,407,595 B), `14.bin.ttf` (7,312,580 B) and `01.bin.ttf` (11,433,717 B). Chunk 14, decoded: 180 slices of 10 s, 5,949 aircraft.
- **One chunk without the whole day:** GitHub release assets answer HTTP Range requests (206). A tar header is 512 B, and the next header is at `offset + 512 + ceil(size / 512) × 512`. Two such hops gave the next two chunk headers exactly. To index a day: find the `./heatmap/` entry with about 10 one-MiB Range reads, then walk 48 headers. After that, one Range read gets any half hour (7–25 MB). The member order differs per day, so each day needs its own index.
- **Coverage:** releases exist for every day from 2023-02-16 to 2026-09-30, 1,323 days with no gap. The first 2023 releases are named `…-test-…`.
- **Size per day** (prod, else staging, from the GitHub API):

  | Year | Days | Median per day | Total |
  |---|---|---|---|
  | 2023 (from 02-16) | 319 | 1.32 GB | 0.44 TB |
  | 2024 | 366 | 2.18 GB | 0.77 TB |
  | 2025 | 365 | 3.20 GB | 1.11 TB |
  | 2026 (to 09-30) | 273 | 3.49 GB | 0.94 TB |

  The 2026-09-30 prod archive is 3,978,338,304 B. The README of `globe_history_2026` gives 1735 GiB for all its releases (prod, staging and mlatonly).
- **Delay:** prod releases appear about 03:25 UTC on the next day. The median delay after the UTC day ends is 3.0–3.5 h. Example: 2026-09-30 prod was published `2026-10-01T03:25:46Z`.
- **Browser CORS:** none. The `github.com` 302 and the `release-assets.githubusercontent.com` 206 have no `Access-Control-Allow-Origin`.

### 2.2 adsb.lol API

The API has no history endpoint. The source (`adsblol/api`, `src/adsb_api/utils/api_v2.py`) defines only live `/v2` routes: `pia`, `mil`, `ladd`, `squawk`, `type`, `registration`, `hex`, `callsign`, `point`, `closest`. The `/0` routes are for airports, routes and receiver status. The README says: "In the future, you will require an API key which you can obtain by feeding adsb.lol." The site docs give the licence as ODbL 1.0 (`adsblol/website`, `content/en/docs/open-data/api.md`, `historical.md`). `api.adsb.lol` was not probed, because this project's recorder polls it from this IP.

### 2.3 Other adsb.lol items

- `adsblol/infra` sets `--heatmap 30` (prod overlay, `manifests/default/planes/default/kustomization.yaml:41`) and `--heatmap=30 --json-trace-interval=15` (test overlay, `…/planes/test/kustomization.yaml:36,53`). The served files use 10 s. So the repo is not the live configuration.
- `history.adsb.lol` was a 2023 service that saved `aircraft.json` about every 5 s (`adsblol/history`, `app.py`). On 2026-10-01 it presented the "Kubernetes Ingress Controller Fake Certificate". So it is not served. Treat it as discontinued.

---

## 3. OpenSky Network

### 3.1 REST API (docs: `openskynetwork/opensky-api`, `docs/free/rest.rst`)

- **Base URL:** `https://opensky-network.org/api`. Token endpoint: `https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token`.
- **`/states/all`:** parameters `time`, `icao24`, and the box `lamin, lomin, lamax, lomax`.
  - Anonymous: "Only the most recent state vectors are available - the `time` parameter is ignored." Time resolution 10 s.
  - Authenticated: "State vectors up to 1 hour in the past. Requests with t < now − 3600 return 400 Bad Request." Time resolution 5 s.
- **Credits:** there are three independent daily buckets, for `/states/*`, `/tracks/*` and `/flights/*`. Anonymous: 400. Standard user: 4,000. Active feeder (≥ 30 % uptime per month): 8,000. Licensed user: 14,400 per hour.
- **`/states/all` cost** by box area (degrees of latitude × degrees of longitude): ≤ 25 sq° = 1, 25–100 = 2, 100–400 = 3, more or global = 4.
- **`/flights/*` and `/tracks/*` cost** by UTC day partitions crossed: live or < 24 h = 4, 1–2 partitions = 30, 3–10 = 60 × N, up to 960 × N above 25.
- **`/tracks/all?icao24=&time=`** is "purely experimental". It returns waypoints, not all positions. The waypoint rules: at least every 15 min, on a track change of more than 2.5°, on an altitude change of more than 100 m, and on a ground-state change. Docs: "It is not possible to access flight tracks from more than 30 days in the past." `time=0` returns the live track.
- **`/flights/all`:** at most 2 h per call. **`/flights/aircraft`:** at most 2 days. **`/flights/arrival`:** at most 2 days. The docs say flights come from a nightly batch ("only flights from the previous day or earlier"). The probes below contradict that note for recent flights.
- **Authentication:** OAuth2 client credentials only. Basic authentication is no longer accepted. Tokens expire after 30 minutes. A docs change on 2025-05-23 made OAuth2 "required for all accounts created since mid-March 2025". The README says basic authentication stopped on 2026-03-18.

### 3.2 Anonymous probes (2026-10-01, 7 calls)

| Time (UTC) | Request | Status | Body |
|---|---|---|---|
| 10:50:00 | `/api/states/all?time=<now−1800>&lamin=29&lomin=33&lamax=34&lomax=36.5` | 403 | "Authenticate to get historical data" |
| 10:50:14 | `/api/tracks/all?icao24=8965d1&time=1790740800` (2026-09-30 04:00) | 403 | "You cannot access historical tracks" |
| 10:50:25 | `/api/flights/aircraft?icao24=8965d1`, 2026-08-26 → 08-28 | 403 | "You cannot access historical flights" |
| 10:50:37 | same, 2026-09-30 00:00 → 10-01 00:00 | 403 | same |
| 10:50:49 | same, now − 23 h → now | 403 | same |
| 10:51:06 | same, now − 2 h → now | 404 | `[]`, `X-Rate-Limit-Remaining: 370` |
| 10:51:23 | same, 2026-10-01 00:00 → now (10.9 h) | 403 | same as above |

So the anonymous API has no history. The `time` parameter is refused, not ignored. On 2026-09-30, an anonymous `/flights/aircraft` call and a `/tracks/all?time=0` call still worked (the files in `.work/fz1073/sources/tracks/`). Every response carried `Access-Control-Allow-Origin: https://opensky-network.org`, so other origins cannot read them in a browser.

### 3.3 Trino historical database (docs: `docs/free/trino.rst`)

- **Eligibility:** "This service is available to university-affiliated researchers, governmental organisations, and aviation authorities for aviation-related research and incident investigations. Private or commercial entities must contact us for a licence." Access is granted after an application (My OpenSky → Request Data Access). A personal hobby app does not fit these groups.
- **Data:** `state_vectors_data4` "has unlimited retention since 2013". There is one state vector per aircraft per second while OpenSky hears it (datasets `README.txt`, copied from the Impala guide).
- **One query:** SQL with `lat BETWEEN … AND lon BETWEEN …` and an `hour` partition filter. The filter is mandatory: Trino rejects queries without it. Limits: 2 concurrent and 2 queued queries per user, and a scan limit of 100 GB per query. Example for the Israel box over one hour: `SELECT time, icao24, lat, lon, baroaltitude, velocity, heading FROM state_vectors_data4 WHERE hour = 1790740800 AND lat BETWEEN 29 AND 34 AND lon BETWEEN 33 AND 36.5`.

### 3.4 Free downloadable datasets (`opensky-network.org/data/scientific`)

- **Weekly 24 h of state vectors:** every Monday from 2017-06-05 to 2022-06-27 (S3 listing of `s3.opensky-network.org/data-samples/states/`, 257 dated folders). There is nothing after 2022-06-27. The page says the data has "10 second update intervals". There is one file per hour, in CSV, Avro and JSON. On 2022-06-27, one hour was 120–155 MB per format, and the day was 3.8–4.2 GB per format.
- **Complete one-day Trino snapshot (2026-03-01):** 320 files, 275.6 GB. `state_vectors` is 24 hourly Parquet files, 13.0 GB.
- **COVID-19 flight dataset (Zenodo):** flight lists only, no positions. The page says: "We stopped updating the dataset after December 2022." It links a "Zenodo Dataset (CC-BY)".
- **Licence for the datasets** (`states/LICENSE.txt`): use "solely for the purpose of non-profit research, non-profit education, commercial internal testing and evaluation of the data, or for government purposes". It also says: "You will not distribute, disclose, transfer or otherwise make available the data set(s)".

### 3.5 Terms of use (`opensky-network.org/about/terms-of-use`, read 2026-10-01)

The licence is "solely for the purpose of non-profit research and non-profit education". The terms also say: "Operational use of the REST API in any live product, service, or automated system also requires a written license, regardless of the entity's non-profit status." FlightHopper's server is an automated system. So OpenSky in the app needs a written licence.

---

## 4. ADS-B Exchange

- **Globe history:** 403 "Direct access to globe history data is not permitted." (probe, §1.3).
- **Free samples** (`www.adsbexchange.com/data-products/sample-data/`): "Complete data from the 1st of each month are made available free of charge", "for testing and evaluation".
  - `https://samples.adsbexchange.com/readsb-hist/YYYY/MM/01/HHMMSSZ.json.gz`, one file every 5 s: "Snapshots of all global airborne traffic, archived every 5 seconds starting May 2020 (prior data is available every 60 seconds starting July 2016)".
  - `https://samples.adsbexchange.com/traces/YYYY/MM/01/<xx>/trace_full_<hex>.json`, one file per aircraft and day, listed in `traces/YYYY/MM/01/index.json`. `hires-traces/…` has the same layout, with "a higher sample rate of 2× per second", from 2022-02. The page says these files are gzip without a `.gz` extension.
  - `acas/` (from 2021-04), `flights-ax-v2/` and `operations-ax-v2/` (from 2024-07). These start dates come from the site's own listing script (`samples.adsbexchange.com/index.js`). It shows day `01` only.
- **Probe:** GET `samples.adsbexchange.com/readsb-hist/2026/09/01/040000Z.json.gz` → 200, 4,974,856 B `application/json`, no `Access-Control-Allow-Origin`. `now` = 2026-09-01 03:59:59 UTC. It had 10,147 aircraft, 8,839 with a position, and 33 in the Israel box. At 17,280 snapshots per day, a day is about 86 GB of uncompressed JSON. The compressed size was not measured.
- **Terms:** the samples page has no licence text. Its "Terms of Use" link goes to JETNET's terms (last modified 2026-07-06). These say the customer "shall not … publish, resell, transmit, broadcast, distribute the Services or data acquired from the Services". So private evaluation is fine. Do not commit sample data to the public repo.
- **Paid history:** "Our data products are delivered as ongoing subscription services with minimum annual commitments." "Historical backfills for up to 10 years are available to subscription customers only." There are no public prices (`/data-products/`). The Community API ($10/month on RapidAPI) is live only (`/community/developer-hub/`).

---

## 5. Paid or keyed options (docs only)

### 5.1 Flightradar24 API (`fr24api.flightradar24.com`)

- **Plans** (the subscriptions page data, read 2026-10-01):

  | Plan | Price | Credits per month | Requests per minute | History |
  |---|---|---|---|---|
  | Explorer | $9/month or $99/year | 30,000 | 10 | 30 days |
  | Essential | $90/month or $990/year | 333,000 | 30 | 2 years |
  | Advanced | $900/month or $9,900/year | 4,050,000 | 200 | all available |

  A "Double Credits Deal" doubles the monthly credits for billing cycles that start on or before 2026-12-31.
- **Historic positions:** `GET https://fr24api.flightradar24.com/api/historic/flight-positions/{light|full}?timestamp=<unix>&bounds=<N,S,W,E>` (and other filters, `limit` up to 30,000) (SDK `historic/positions.py`). The docs say: "the API does not currently support fetching positional data over a date range". You loop over timestamps instead.
- **Resolution:** history starts 2016-05-11 with 1 snapshot per minute. From 2019-11-18 it has "1 snapshot/10 seconds" (`/docs/endpoints/flight-positions-resolution`).
- **Cost:** historic positions cost 8 credits (full) or 6 (light) "per returned flight". Flight tracks (`GET /api/flight-tracks?flight_id=`, SDK `flight_tracks.py:13-28`) cost 40 per returned flight (`/docs/credit-overview`). Example: a view with 30 aircraft costs about 180 credits per frame (light). Explorer then gives about 166 frames per month. A 30-minute replay at 10 s needs 180 frames.
- **Free use:** the sandbox returns "static, predefined responses" and "ignore[s] query parameters" (`/docs/sandbox-environment`). So it has no real history.
- **Storage rule:** "All data accumulated from the FR24 API should not be stored for more than 30 days" (`/docs/storage-rules`).

### 5.2 FlightAware AeroAPI (`flightaware.com/commercial/aeroapi/`, OpenAPI 4.17.1)

- **Personal tier:** no monthly minimum. Usage fees per query, with "up to $5 free per month, or $10 free per month for ADS-B feeders". 10 result sets per minute. "Historical Flight Data: Not included in Personal". Use: "Storage and distribution of derivative works for personal or academic purposes only."
- **Personal endpoints** (base `https://aeroapi.flightaware.com/aeroapi`): `GET /flights/{id}/track` returns a flight's positions. "Data from up to 10 days ago can be obtained." It costs $0.012 per result set. `GET /flights/search/positions` finds flights by a lat/lon box, but "only searches flight data representing approximately the last 24 hours". It costs $0.050 per result set.
- **Standard tier:** a minimum of $100/month. `GET /history/flights/{id}/track` costs $0.060 per result set. History is available "from now back to 2011-01-01".
- AeroAPI has no "all aircraft in a box at a past time" call.

### 5.3 airplanes.live, adsb.fi, adsb.one (their docs, read through GitHub and the Wayback Machine)

- **airplanes.live:** the REST API guide (Wayback, 2026-08-16) lists live endpoints only, "Non-Commercial Use", 1 request per second. The API page (Wayback, 2026-03-13) says: "Historical data is available to replay on the globe." The FAQ (Wayback, 2026-08-23) lists "Ability to replay data" under "What a feeder gets access to". So there is no programmatic history. On 2026-09-30, the globe answered with a Cloudflare challenge.
- **adsb.fi:** the open-data README (`github.com/adsbfi/opendata`) lists live endpoints only, "for personal, non-commercial use only", 1 request per second. It has no history endpoint. On 2026-09-30, the globe answered with a Cloudflare challenge.
- **adsb.one:** the API README (`ADSB-One/api`, last activity 2023) lists live endpoints only. On 2026-09-30, the host answered "521: Web server is down".

### 5.4 Others found

- **SkyLink API:** historical ADS-B on the paid "ULTRA & MEGA" plans only. Archive from 2026-05-01, 5 s samples, by flight or aircraft (`skylinkapi.com/features/historical-adsb/`).
- **Wingbits:** one free day per month as hourly Parquet files, "solely for evaluation purposes" (`wingbits.com/data-sample`).
- **AvioADSB:** live only. The site says that the API shows positions "rounded to a ~28 km grid" (`avioadsb.org`).
- **Bellingcat Turnstone** (`github.com/bellingcat/adsb-history`, MIT): it loads tar1090 heatmap files into PostGIS for box and time queries. It shows that the heatmap file works as a history store.
- RadarBox and Planefinder were not checked.

---

## 6. adsb.exposed (ClickHouse demo)

- **What it is:** the README of `ClickHouse/adsb.exposed` calls it a "technology demo". Its data comes from adsb.lol ("full historical data is provided without restrictions … available since 2023"), from airplanes.live ("full historical data since 2023 … and live real-time feed") and from the ADS-B Exchange samples. The airplanes.live data comes "with the following restrictions: no reselling the data; no commercial use (except for within this application) without an agreement; attribution is required".
- **Access:** a public read-only user `website` with an empty password (`setup.sql:84-111`). It sends a CORS header (`add_http_cors_header = 1`). It allows at most 1,048,576 result rows and 180 s per query. The per-IP quotas are 1,000 queries per minute and 50,000 per day. The table `planes_mercator` is ordered by `(mortonEncode(mercator_x, mercator_y), time)`. So box queries are cheap, and queries for one aircraft scan a lot.
- **Probe** (1 POST to the endpoint in `config.js`): a 10-minute Israel-box query for 2026-09-30 04:00 returned 200 in 4.5 s, with `Access-Control-Allow-Origin: *`. It read 832,922,978 rows (11.2 GB) on the server. It returned only `airplanes.live` rows: 11,002 rows for 32 aircraft, about one row per aircraft every 1.7 s.
- **Verdict:** it works without a key and from a browser. But it is a demo with no terms for other apps, and each query is heavy for the server. Ask ClickHouse before you depend on it.

---

## For FlightHopper

### (a) One aircraft over a time range, ranked by free + keyless + effort

1. **Within the last 25 h:** adsb.lol `data/traces/<xx>/trace_full_<hex>.json`. One keyless request gives full resolution with track, vertical rate and flags. The FZ1073 tooling already uses it.
2. **An earlier UTC day, within the server's retention:** adsb.lol `globe_history/YYYY/MM/DD/traces/<xx>/trace_full_<hex>.json`, one request per day. If it gives 404 (as for `8965d1`), use item 3.
3. **Heatmap chunks filtered by hex:** one request per half hour. You get 10 s positions with altitude, ground speed, callsign and squawk. Derive the track and the vertical rate from successive points. This works for any aircraft that the network heard, from adsb.lol (10 s) or theairtraffic (60 s).
4. **Older than the server keeps:** the GitHub archive. For a heatmap chunk, use Range reads (§2.1). The full-resolution trace needs the whole day, about 4 GB.
5. **Only if the open networks did not hear the aircraft:** a paid source. Flightradar24 Explorer flight tracks cost 40 credits per flight, for 30 days back. FlightAware Personal `/flights/{id}/track` costs $0.012, for 10 days back. An OpenSky account gives tracks for 30 days, but app use needs their licence.

### (b) Everything in view at a past moment or over a range, ranked

1. **adsb.lol heatmap chunks.** They are keyless, global, 10 s, at least 30 days back, and one request covers 30 minutes. Filter by the view's box on the server. A chunk does not change after its half hour ends, so cache each chunk on disk for good.
2. **The GitHub archives,** for days older than the server keeps, and to keep the load off adsb.lol. They cover 2023-02-16 to yesterday. Heatmaps are confirmed in the 2024-10-01 and 2026-09-30 archives.
3. **theairtraffic heatmaps** (60 s), as a second source or fallback.
4. **The last hour only, at 5 s:** OpenSky `states/all?time=` with a free account. A view of 25 sq° or less costs 1 credit, and the daily quota is 4,000. App use needs their licence.
5. **Paid:** Flightradar24 Explorer historic positions by bounds, 10 s granularity, 30 days back, about 6 credits per aircraft per frame (§5.1).
6. **adsb.exposed SQL:** it works keyless and from a browser, but it is a demo. Ask first.

### Limits to plan for

- **Coverage:** the data is what community receivers heard. No open network heard FZ1073 from 03:54 to 05:16 and from 05:22 to 05:31 UTC on 2026-09-30 (`tools/scenarios/fz1073/README.md`).
- **Heatmap precision:** one point per aircraft per 10 s slice. The time is the slice start, and the true time is within 10 s after it. Altitude is in 25 ft steps. There is no track, vertical rate, geometric altitude or type. Use the project's adsbdb lookup or tar1090-db for the type.
- **The current half hour is never in a heatmap.** Use live data or `trace_full` for the last 30 minutes.
- **Retention on the servers is operator policy.** The probes show at least 30 days. It can change without notice.
- **Volume:** 12–25 MB per half hour for the whole world, so 0.6–1.2 GB per day. FlightHopper needs only the chunks that a user asks for.
- **Terms:**
  - adsb.lol data is ODbL 1.0. The app already shows "adsb.lol (ODbL 1.0)". If FlightHopper publishes a derived database, for example recordings in the public repo, share-alike applies.
  - theairtraffic publishes no data terms. Its data also feeds adsb.lol, per the adsb.lol archive README.
  - ADS-B Exchange samples: evaluation only, no redistribution.
  - OpenSky: a written licence for app use.
  - Flightradar24: delete data after 30 days.
- **No CORS:** only the Node server can fetch these files. A future static build needs a proxy for them.
- **Load:** the adsb.lol API answered 429 to this project's polling every 2–7 s (`.planning/reports/adsblol-note.md`). Send the contact User-Agent, fetch each chunk once and cache it. Prefer GitHub for past days. The courtesy note to adsb.lol could also ask whether heatmap downloads by an app are acceptable.

---

## Independent check (2026-10-01)

The adsb.lol chunk 2026-09-30 `08` was decoded again with a separate Python decoder. The result was the same: 180 slices of 10 s, 9,513 aircraft, 697,014 positions, 47 aircraft in the Israel box. It was then compared with this project's own adsb.lol recordings of the same half hour (`data/recordings/2026-09-30.jsonl`, KSFO/LLBG/LOWI circles). Of 1,828 recorded fixes, 1,606 had a heatmap position of the same aircraft within 10 s. The distance between them was 0.07 km (median), 0.97 km (p90) and 4.44 km (max). 11 of 179 recorded aircraft were not in the heatmap.

## Open questions

1. How far back does theairtraffic keep heatmaps? 30 days is proven. (adsb.lol: about 30 days, see §1.3 follow-up.)
2. Why did both hosts give 404 for the `8965d1` day trace of 2026-09-30, while other day traces and the heatmaps exist? Is the cause a replica difference or a removal? Unknown.
3. Does theairtraffic serve day traces at all? Two aircraft gave 404.
4. Is the heatmap in every daily archive since 2023? Only 2 days were checked. The position of the heatmap section in the tar changes per day.
5. What is the exact window of the anonymous OpenSky `/flights/aircraft` call now? It is between 2 h and 10.9 h. The behaviour changed after 2026-09-30.
6. How large are the ADS-B Exchange samples compressed? Do the `traces/` and `hires-traces/` samples exist for 2026-09-01? Not probed (host budget).
7. Does ClickHouse accept use of the adsb.exposed `website` user by another app? Does it still load adsb.lol rows? The probe returned only airplanes.live rows for 2026-09-30.
8. Do the Flightradar24 historic positions fill the gaps of the open networks (FR24's own receivers and satellite)? This needs a key to test.

## Probe log (2026-10-01, UTC)

- **adsb.lol:** 4 requests, 10:42:09–10:43:40 (table in §1.3).
- **globe.theairtraffic.com:** 4 requests, 10:44:37–10:45:25.
- **globe.adsbexchange.com:** 2 requests, 10:45:37 and 10:45:42.
- **samples.adsbexchange.com:** 4 requests, 10:45:48–10:46:31 (`/` → 301, `/index.html`, `/index.js`, one `readsb-hist` file).
- **opensky-network.org/api:** 7 anonymous calls, 10:50:00–10:51:23 (table in §3.2).
- **s3.opensky-network.org:** 5 requests: `README.txt`, `LICENSE.txt`, and three listings.
- **GitHub release assets (adsblol):** 20 Range requests of 1 B to 8 MiB each, about 50 MB in total, for the 2026-09-30 and 2024-10-01 prod archives. Release lists came from the GitHub API.
- **adsb.exposed ClickHouse:** 1 SQL query, 10:56:58.
- **history.adsb.lol:** 1 TLS handshake (fake certificate, no HTTP request completed).
- **Docs pages:** fr24api.flightradar24.com (8 page loads), flightaware.com (AeroAPI page and OpenAPI file), opensky-network.org (3 pages), adsbexchange.com (7 page loads), jetnet.com (terms), web.archive.org (3 airplanes.live pages), GitHub (READMEs and source).

<!-- docs/anomaly-alerts.md -->
# Anomaly alerts: free sources, detection rules and a design

- **Verdict.** Doable for squawk alerts anywhere. A sweep of 3 adsb.fi requests every 30 s costs 11 % of the app's 0.9 req/s. It confirms each 7500, 7600 or 7700 within 30 to 60 s.
- **Sources.** Use adsb.fi `/v2/sqk/{code}` for the live sweep and ntfy.sh for phone push. adsb.lol's half-hour heatmap, which the server downloads already, gives a worldwide check 1 to 31 min late.
- **Not caught.** In real time, steep descents and ADS-B emergency status (lifeguard, minfuel…) show only for polled aircraft: no free whole-world feed is fast enough. Receiver gaps hide the rest: the open networks lost FZ1073 one minute into its dive.

Researched on 2026-10-03 from primary sources: API docs, source code, regulations and one peer-reviewed study. Each live endpoint got one or
two requests (times in UTC). The adsb.fi requests went out while the app's poller was idle. Results marked *measured* come from two
places: this app's own recordings (`data/recordings/`) and the heatmaps that the running server held. Neither needed an upstream request.
Numbers in brackets point to the Sources list at the end.

## 1. Sources of emergency data

| Source | Endpoint | What it gives | Limits and terms | Verified |
|---|---|---|---|---|
| adsb.fi | `opendata.adsb.fi/api/v2/sqk/{code}` | Every aircraft on one squawk, worldwide, readsb v2 JSON [1] | 1 req/s per IP. Answers 400, 401, 403, 404 and 429 count toward a temporary IP block. Personal, non-commercial use. Cite adsb.fi with a link [1] | Y: 200, 93 B gzip with no aircraft (02:07). An empty answer is a 200 |
| adsb.fi | `/v2/mil` | Every aircraft flagged military [1], also those without a position | As above | Y: 128 aircraft, 13 KB gzip, 54 KB raw, 48 without a current position |
| adsb.fi | `/v2/icao/{hex},{hex}` | 2 or more aircraft in one request [1] | As above | Y: 2 hexes asked, 2 aircraft back |
| adsb.fi | `/v2/snapshot` | All aircraft, refreshed twice a minute [1] | Feeders only (by the feeder's IP), 1 request per 30 s [1] | N: needs a receiver |
| adsb.lol | `api.adsb.lol/v2/sqk/{codes}` | readsb `all&filter_squawk={codes}&jv2` [7], so `7500,7600,7700` is one request | Free. Limits "dynamic", an API key "in the future" for feeders, ODbL 1.0 [8]. This IP got 429s at 0.08 to 0.5 req/s, clean at 0.04 (`server/config.ts`) | Y: list accepted, 200, no aircraft (02:08) |
| adsb.lol | `/v2/mil`, `/v2/type/{types}`, `/v2/pia`, `/v2/ladd` | Worldwide lists by flag or by type (comma list) [7] | As above | Source read, not probed |
| adsb.lol | `re-api.adsb.lol/?all`, `?box=…` + filters | The readsb query API [9]. Its `?all` covers the whole world [2] | Only from a feeder's own IP [9] | N: needs a receiver |
| adsb.lol | `adsb.lol/globe_history/…/heatmap/NN.bin.ttf` | Every aircraft heard in one UTC half hour: a position, an altitude (25 ft steps) and a ground speed per 10 s slice, the squawk when it changes and once a minute (`server/heatmap.ts`, [6]) | 12 to 25 MB a file, published 2 to 8 s after the half hour (`server/historyStore.ts`). ODbL [8] | Y: the server reads it today |
| airplanes.live | `api.airplanes.live/v2/squawk/{code}`, `/v2/mil` | Documented in the archived ADSB One README, 1 req/s [10] | Answers this IP with 403 and asks for an email that describes the project | Y: blocked |
| ADS-B Exchange | Community API (RapidAPI) | Queries by location, hex, callsign, squawk [11] | $10 a month for 10,000 requests, non-commercial. No free tier found [11] | Page read |
| OpenSky Network | `opensky-network.org/api/states/all` | One state vector per aircraft, worldwide: squawk, `vertical_rate` (m/s), baro and geo altitude, `spi`. No emergency status [12] | Credits a day: anonymous 400 (by IP), registered user 4,000, active feeder 8,000. The whole world costs 4. Anonymous gets the newest states only, at 10 s resolution. OAuth2 client credentials only [12]. Research and non-commercial use. OpenSky can block cloud (AWS) IPs [13] | Y: 200, 988 KB (not gzipped), 7,520 aircraft, 396 credits left (02:06) |

OpenSky's whole world costs 4 credits: one call every 14.4 min anonymous, every 86 s as a registered user, every 43 s as a feeder.

No public endpoint filters on the ADS-B `emergency` field. readsb's query API has no such filter. Its filters are squawk, type,
callsign, military, interesting, PIA, LADD, with position, and above or below a baro altitude [3]. adsb.fi offers squawk and military
[1]. adsb.lol adds type, PIA and LADD [7]. readsb's `filter_interesting` reaches the public on neither site.

The map sites' internal globe tiles are not an API. The adsb.fi terms and the adsb.lol API and re-api pages do not mention them
[1][8][9]. This design does not use them.

## 2. readsb fields for alerts

| Field | Meaning [2] | Use |
|---|---|---|
| `squawk` | Mode A code, 4 octal digits | 7700: distress or urgency [16]. 7600: two-way radio failure [17]. 7500: the hijack code [15]. In the US the 7600 to 7677 and 7700 to 7777 series also trigger indicators, and 7777 is for military interceptors [15] |
| `emergency` | ADS-B emergency/priority status, "a superset of the 7x00 squawks": none, general, lifeguard, minfuel, nordo, unlawful, downed, reserved | Sent only in ADS-B extended squitters: the aircraft status message, which also carries the Mode A code, and the version 1 target state message [4]. An aircraft without ADS-B Out never sends it. readsb drops it 60 s after the last message [5]. US rule: ADS-B Out broadcasts whether the crew has an emergency, a radio failure or unlawful interference [20] |
| `alert` | Mode S flight status alert bit | Set for 18 s after any squawk change, and permanently with 7500, 7600 or 7700 [21]. *Measured*: set in at least one report of 5,134 of 15,405 aircraft. Not an emergency signal alone |
| `spi` | IDENT pressed | *Measured*: 3,946 of 15,405 aircraft. Not an emergency |
| `baro_rate`, `geom_rate` | Rate of change of baro and GNSS altitude, ft/min | The descent rules use `baro_rate` and `alt_baro`. `geom_rate` is a cross-check only |
| `alt_baro`, `alt_geom` | Baro altitude in ft or `"ground"`. GNSS altitude above the WGS84 ellipsoid | Spoofing can make GNSS altitude misleading [22] |
| `nav_altitude_mcp` | Selected altitude (MCP or FCU) | A fast descent far below it was not commanded. FZ1073 kept 34,000 ft selected as it dived (`public/scenarios/fz1073/events.csv`) |
| `nav_modes` | autopilot, vnav, althold, approach, lnav, tcas | In readsb, `tcas` marks TCAS as operational. It does not mark a resolution advisory [4]. The advisory is the experimental `acas_ra` [2] |
| `nic`, `nac_p`, `gpsOkBefore` | Position integrity and accuracy. `gpsOkBefore` (experimental): GPS lost or heavily degraded, good before this time, shown for 15 min | GNSS loss. *Measured*: `nic` is 0 in 11 % of all reports, so 0 alone is not a jamming test |
| `seen`, `seen_pos`, `lastPosition` | Message age, position age. `lastPosition` when the position is over 60 s old | When GNSS fails, the aircraft keeps a fresh `seen` and, after 60 s, only `lastPosition` [2]. Circle queries leave it out (*measured*: no such aircraft in 24,803 circle answers). `all`-based squawk and military queries keep it [2][7] |
| `dbFlags` | 1 military, 2 interesting, 4 PIA, 8 LADD | The poller drops PIA and LADD aircraft unless `SHOW_PIA_LADD=1` (`shared/sample.ts`). Alerts do the same |

## 3. Detection rules

### 3.1 Squawk and emergency status

1. Skip aircraft on the ground and surface vehicles (category C1 to C3). Skip addresses that are not 6 hex digits, and `000000` and `000001` [14]. Skip `emergency: reserved`.
2. Mark the first sighting *suspected*. Mark it *confirmed* when a sweep at least 30 s later still sees it. Alert on *confirmed*.
3. Mark it *ended* after 2 sweeps without it.
4. Word 7500 as "often set by mistake" and 7600 as "most are light aircraft on approach" (section 4).

Genuine 7700 cases last long: the OpenSky study kept only flights with more than 1,000 7700 samples [14]. OpenSky's own alert bot
waits about 5 minutes to avoid spurious alerts [14]. A 30 s confirmation is a compromise between speed and noise.

### 3.2 Steep descent

Normal practice: descend at an optimum rate, then at 500 to 1,500 fpm in the last 1,000 ft [18]. A decompression leads to "a steep descent
to 10,000 ft (at up to −6,000 ft/min)" [14]. The design rule for transport aircraft lets the cabin stay above 25,000 ft for no more than 2 minutes
after a decompression [19]. From FL400 that means about 7,500 fpm on average (derived, not stated in the rule).

*Measured*, the app's recordings: adsb.lol answers from 22 September to 3 October 2026, 921,270 reports (80 % San Francisco, 12 %
Innsbruck, 8 % Ben Gurion).
`baro_rate` was −4,000 fpm or lower in 149 of 436,489 airborne reports, and −6,000 fpm or lower in 29 reports from 16 aircraft. Only 2 of
the 16 showed a matching altitude fall between reports.

*Measured*, adsb.lol heatmaps: 5 half hours from 2026-10-02 23:30 UTC, 11,400 to 13,450 aircraft each, points every 60 s, median of 3.
Each half hour, 10 to 13 aircraft lost 8,000 ft or more within 2 minutes. They were airliners at 4,000 to 4,750 fpm and Cessna 208s with
the profile of jump flights. 0 to 2 lost 10,000 ft or more, none of them from FL200 or above. None lost 12,000 ft.

*Measured*, FZ1073 as the open networks heard it (`public/scenarios/fz1073/track.csv`, rows `q=A`, `src=ADSBLOL`): it lost about 5,900 ft
in 73 s from 05:21:00. The last 4 s were at about 23,000 fpm. Then the open networks heard nothing for 9 minutes.

*Measured on 8 real half hours (2026-10-03)*, adsb.lol heatmaps (2026-09-30 05:00 UTC, 2026-10-01 13:00 UTC and 2026-10-02 08:00 to 18:00 UTC),
125,941 aircraft-half-hours. The first rules missed FZ1073. Its points hold a GNSS altitude among the baro ones and miss a slice, so its
last step was faster than 30,000 fpm and its 30 s window held 2 real points. D1 at 10,000 ft in 120 s gave 21 events: 8 aircraft that
Mictronics flags military (T-38, M-339, M-345, T-7, Texan II), 7 fighters on civil registrations (F-5 ×3, Mirage F1, a NASA T-38, an S-211
and one unknown), and 6 business jets and an A321 descending steeply into airports, the largest 12,025 ft (H25B) and 15,850 ft (C25M) in
120 s. At 15,000 ft in 120 s, with military and fast-jet types left out, 2 remain (an FA20 and a C25M). The same files held a KC-135 and a
C-130 on 7700: real emergencies, so squawks and statuses are not left out for military aircraft. The rules below use these values.

The rules use `alt_baro`. Points are an aircraft's reports, or the 10 s heatmap points.

- **Clean first.** Drop points above 50,000 ft and repeated times. Drop an outlier: an inner point whose steps to its two neighbours go in opposite directions and that is more than 1,000 ft off the line between them (a GNSS altitude among baro ones, or a bad decode), or whose two steps are both faster than 30,000 fpm. Judge a point only when both its steps are at most 60 s, so a point across a coverage hole stays. Drop it only if it is at least as far off its line as each of the two points next to it is off theirs: the good point beside an outlier is off the line to it too, and stays. The first and last points are never judged. The steps of a fall go down, or up by 300 ft at most, at 30,000 fpm or less, with at most 60 s between points.
- **D1, emergency descent.** From FL200 or above, 15,000 ft or more lost within 120 s (7,500 fpm), over 4 or more falling points. The fall is then followed to its bottom: on while each step is a fall, until 60 s pass with no new low. For an aircraft that is not an airliner the fall is 20,000 ft (section 3.3).
- **D2, dive then lost.** The fall into the last point. Its top is within the last 60 s, with every step from it a fall, over 3 or more points. The fall is 3,000 ft or more, at 5,000 fpm or more on average. Then no position for 60 s. Of the tops that fit, the biggest fall is taken. FZ1073 fits (section 7.5). For an aircraft that is not an airliner the top is at FL150 or above and the average is 10,000 fpm or more (section 3.3).
- **D3, plunge (airliners only).** 8,000 ft or more lost within 60 s, over 3 or more points, at any level (section 3.3).
- **A fall has two steps.** Each step is at most 45,000 fpm, and two or more steps go down by 200 ft or more. One jump between two level stretches is an altitude encoder's stuck bit (section 3.3).
- **No fall event.** Military aircraft (the Mictronics flag, and live `dbFlags & 1`) and fighter and trainer types (a list of type designators in `server/alerts.ts`: F-5, T-38, Texan II, L-39, Su-27 and others). They dive as routine. Their squawks and statuses still count.
- **Not built: a rate rule on polled aircraft** (log only). `baro_rate` at −6,000 fpm or lower, with `alt_baro` falling at 4,000 fpm or more since a report 5 to 120 s earlier. In the recordings, 2 aircraft passed: a jump plane and a military jet.
- **Urgent.** A 7x00 code or an emergency status at the same time, or `nav_altitude_mcp` 5,000 ft or more above `alt_baro` (not commanded).
- **Log, no push.** Category A1 or B. A C208, DHC6, PC6T or P750 below FL150 (jump planes).
- **GNSS.** Use `geom_rate` only when `alt_baro` agrees. Never alert on GNSS altitude alone.

### 3.3 Known emergencies and real traffic: rules by the kind of aircraft (2026-10-03, second round)

Question: do the alerts find known emergencies, and can they find more without false alarms?

**Method.**
- 33 known emergencies, each with its published squawk times and barometric altitudes (accident reports, the Flightradar24 blog, The
  Aviation Herald). The figures and their sources are in `server/alerts.cases.ts`.
- `server/alerts.cases.test.ts` replays each one through the real `Poller` and `Alerts`. The upstream is a model: adsb.fi's squawk
  answers at the poller's pace, and adsb.lol's half-hour files with a position every 10 s while the altitude changes. The model
  assumes that a receiver of the open networks hears the aircraft.
- False alarms: the real `Alerts.scanSlot` on 18 real half-hour files (2026-09-28 to 2026-10-03, about 290,000 aircraft-half-hours,
  164,362 of them airliners), with the real type table.

**What ordinary traffic does** (the 18 files):

| Aircraft | Ordinary flight | So |
|---|---|---|
| Airliners | At most 5,875 ft in 60 s and 10,725 ft in 120 s. 16,500 ft in 240 s is common. | D3 at 8,000 ft in 60 s and D1 at 15,000 ft in 120 s are clear of it. A slower emergency descent is not. |
| Airliners lost while descending | At most 4,975 fpm over the last minute. Up to 3,960 fpm below 10,000 ft. | D2 at 6,000 fpm is clear of it. A descent like Germanwings 9525 (3,500 fpm) is not. |
| Jump planes (C208, PC-6, SC-7, P-750) | 10,000 to 12,400 ft in 120 s from FL130, each load. | No low-level rule for aircraft that are not airliners. |
| Business jets | 15,850 ft (C25M, a drill) and 17,925 ft (FA20, a contractor's target aircraft) in 120 s. One G200 at 5,070 fpm into the edge of coverage. | D1_OTHER at 20,000 ft and D2_OTHER at 10,000 fpm. |
| A PA-28 with a faulty altitude encoder | 6,600 ft and 38,900 ft in turn, twice in a row once. | A fall needs two steps down. |

**Result on the 18 real files.** The first rules gave 4 fall events: FZ1073 (real) and 3 false ones (the FA20, the C25M and the G200).
The rules of section 3.2 give 1: FZ1073. Both give the same 8 squawk events, which are real codes.

**Result on the 33 known emergencies.**

| Kind | Cases | Found | How |
|---|---|---|---|
| The crew set 7700 or 7600 | 7 | 7 | The sweep, 50 to 59 s after the code was set. Also late from the file. |
| Dive or spin, no code | 6 | 6 | From the half-hour file, 9 to 30 min later; 4 of them within about a minute when the aircraft is on the map. |
| Emergency descent or upset, no code reported | 8 | 0 | The steepest was 5,228 fpm (Southwest 1380): inside ordinary flight. |
| Slow descent into terrain or sea, no code | 2 | 0 | Germanwings 9525 and OE-FGR: inside ordinary flight. |
| Transponder stopped, or no receiver heard the fall | 3 | 0 | MH17, MS804, QZ8501: no data to read. |
| Accident at take-off or on approach | 7 | 0 | Below any rule, and over in seconds. |

The first rules found 10 of the 33. The rules of section 3.2 find 13: Metrojet 9268, Sriwijaya 182 and Lion Air 610 are new, and
Voepass 2283 is now found live on the map.

**Not built, and why.**
- A rule for a slower emergency descent. Ordinary airliners descend as fast.
- A rule for an aircraft that is lost at cruise level with no fall. Aircraft leave the receivers' reach all the time.
- A rule for a descent to low level away from an airport. It needs terrain and the route of each flight.

## 4. False alarms

- **Code changes.** Pilots "should avoid inadvertent selection of Codes 7500, 7600 or 7700 thereby causing momentary false alarms" (AIM) [15]. Some transponders change one digit at a time: 6203, then 7703, then 7700 [14].
- **Glitches.** In 4 months OpenSky dropped over 8,000 aircraft that sent 7500 once or only briefly, for example 1000, then 7500 for 2 to 3 s, then 1000 [14]. The 4 sustained 7500 codes were mistakes, with a median of 5 min [14].
- **On the ground.** An A321neo sent 7600 once on the ground (*measured*). A ground vehicle squawked 7700 continuously at Dubai [14]. An airliner set 7500 at a Schiphol gate in 2019, and parts of the terminal closed for hours [14].
- **Bad addresses.** OpenSky removes `000000` and `000001` [14]. adsb.fi's `/v2/mil` answer held `000001` ("TB2T1071") with `emergency: general` on squawk 5517, and another aircraft with `emergency: reserved` (*measured*).
- **Status without a code.** 5 reports in the recordings (lifeguard 3, minfuel 1, nordo 1), on airliners at 13,900 to 38,000 ft with squawk 1000, each seen once (*measured*).
- **Rate spikes.** A 787 at FL400 reported −21,376 fpm, with `geom_rate` −64 and no altitude change (*measured*).
- **Real but routine.** A Cessna 208 (4X-CSX) at Habonim, where a skydiving centre flies a Grand Caravan [31], at −6,000 to −6,800 fpm on 4 days. An Israeli military Gulfstream V at FL322, about −6,600 fpm. Military jets north of Innsbruck reported −6,700 to −10,700 fpm with little altitude change between reports (*measured*). With 30 s heatmap points, airliners lose 5,000 ft in a minute 1 to 3 times per half hour worldwide (*measured*).
- **7600.** 70 cases in 4 months: 79 % small private aircraft, 53 % on approach, median 11 min [14].
- **GNSS jamming and spoofing.** EASA names the south and east Mediterranean and the Middle East, among other areas. Effects include corrupted ADS-B, misleading GNSS altitude, and spurious TAWS pull-ups that cause high-rate climbs [22]. readsb writes GNSS altitude into the heatmap when it has no baro altitude [6]. *Measured*: raw 30 s heatmap points held altitudes of 69,400 ft and 90,000 ft. Others showed falls of 22,000 to 50,000 ft within 30 s, mostly on Gulf and Levant flights. The cause is not confirmed.
- **Coverage.** A lost aircraft is normal, mostly low on approach (`server/flightLog.ts` ends a recording after 15 min of silence). Only D2 reads a loss as a sign.

## 5. Other events

| Event | Worldwide and cheap? (real time unless "late") | How |
|---|---|---|
| 7500, 7600, 7700 | Yes | The sweep (section 7) and the late heatmap check |
| 7777, US military interception [15] | Yes | One more sweep request |
| Emergency status without a 7x00 code | No | Polled aircraft only: view, chase, recordings, sweep answers, military list |
| Military aircraft | Yes | adsb.fi `/v2/mil` every 2 to 5 min, 13 KB gzip at night |
| Interesting or rare aircraft | Partly | Plane Alert DB (17,259 aircraft by hex, CSV, ODbL [30]) against what the app sees. adsb.lol `/v2/type/{types}` for rare types, when adsb.lol has budget |
| Steep descent, steep climb | Late, 1 to 31 min | D1 and D3 in real time on polled aircraft, D1 to D3 worldwide 1 to 31 min late from the heatmap. Spoofing makes false climbs [22] |
| Lost at altitude | Late, 1 to 31 min | D2 on the heatmap. Gaps at the edge of coverage are common |
| Go-around, holding, circling | Late, 1 to 31 min | From heatmap positions (no track field), or live on polled aircraft |
| Diversion | No | Needs the route of every flight (adsb.lol routes, adsbdb) |
| Low and far from an airport | Late, 1 to 31 min | Heatmap positions with the airport list and terrain |
| GNSS loss | No | `gpsOkBefore`, `nic`, `lastPosition`: polled aircraft only |
| TCAS resolution advisory | No | `acas_ra` (experimental [2]): polled aircraft only |

## 6. Event feeds beyond ADS-B

- **The Aviation Herald.** Its footer reserves all rights and prohibits reproduction, redistribution and AI learning or use [28]. Not usable. It covered 90 of the 832 7700 cases in the OpenSky study [14].
- **Aviation Safety Network** (Flight Safety Foundation). No feed link on the home page, and its about page refused a script with 403 [29]. Not usable.
- **FAA TFRs.** `tfr.faa.gov/tfrapi/exportTfrList` returns keyless JSON: 89 TFRs with id, type, facility, state, description and date [26]. US only. Context, not anomalies.
- **FAA NOTAM API.** Needs an FAA API portal account and approval (from a search result, page not read: unverified).
- **X accounts.** @OpenSkyAlerts and @SquawkAlert post emergencies [14]. Reading posts costs $0.005 each, with no free tier [27]. Not usable.
- **OpenSky alerts page** (`opensky-network.org/network/alerts`, cited in [14]). It refused automated access: status unverified.
- **Streams.** This search found no free emergency stream or websocket (unverified).

## 7. Design for FlightHopper

This section is the proposal from before the design. Where they differ, [the design](superpowers/specs/2026-10-03-alerts-design.md) is what was built.

### 7.1 What the app has

- One upstream Source behind one TokenBucket: adsb.fi at 0.9 req/s, burst 1 (`server/config.ts`, `server/budget.ts`). A 429 halves the rate for good.
- The Poller makes at most one request per 100 ms tick, in this order: chase, watch, areas (`server/poller.ts`). Views and chases need a client: interest lapses 15 s after the last ask. The Poller also polls watched (recorded) aircraft with no client.
- `InfoStore.update` gets every aircraft object of every good answer, with `squawk`, `emergency` and the rates (`server/infoStore.ts`).
- FlightLog records chosen flights to `data/flights/` and resumes after a restart. A recording ends on landing or after 15 min of silence (`server/flightLog.ts`).
- For a live source, HistoryStore keeps the newest 2 heatmaps in memory and checks every minute (`server/historyStore.ts`, `server/main.ts`).
- The table and the card already mark 7500, 7600 and 7700 (`client/ui/table.ts`, `client/ui/detail.ts`).

### 7.2 Budget

| Use (adsb.fi, 0.9 req/s) | Requests | req/s |
|---|---|---|
| Chase, aircraft inside the view circle | 1 per 1.4 s | 0.71 |
| Squawk sweep: 7700, 7600, 7500 | 3 per 30 s | 0.10 |
| Military list | 1 per 5 min | 0.003 |
| Alert recordings: one `/v2/icao/{list}` | 1 per 15 s | 0.067 |
| Total while chasing | | 0.88 |
| Home circle, 250 nm, only while no client asks (optional) | 1 per 30 s | 0.033 |

The sweep fits. A sweep answer is 93 B gzip when empty and about 100 B gzip per aircraft. Keep the sweep off adsb.lol while
`tools/record-cells.ts` polls it every 24 s (0.042 req/s, about the rate that ran clean). Without the recorder, one adsb.lol request with
the comma list every 60 s (0.017 req/s) can do the sweep.

`server/sources/adsbfi.ts` asks one hex per request, because "the docs show no batch form". The README shows `/v2/icao/{hex},{hex}`, and
it works (section 1). The watch batch can use it.

### 7.3 Server: `server/alerts.ts`, no new dependency

1. Turn it on with `ALERTS=1` in `.env.local`, or from the Settings toggle through `POST /api/alerts?on=1|0` (kept in `data/events/state.json`). It runs with or without a browser.
2. Add the sweep as a fourth request kind in `Poller.tick`, after a due chase and before the watch. Its answers go through `#ingest`, so the store, the InfoStore and the recordings get them.
3. Apply section 3.1 and the rate rule of section 3.2 (not built) in a hook next to `InfoStore.update`. Run D1 and D2 on each aircraft's samples in the SampleStore.
4. When HistoryStore holds a new newest half hour, run `scanHeatmap(file)` (new, in `server/heatmap.ts`). It applies section 3.1 to the ident records and D1 and D2 to the positions. It adds the events that are not in the log, marked late.
5. Optional: `ALERT_HOME=lat,lon,nm` polls one circle every 30 s while no client asks, so D1 to D3 run there while you are away.

**Event log.** `data/events/YYYY-MM-DD.jsonl`, by UTC day. Add `data/events/` to `.gitignore`. One line per change:

```
{"open":{"id":"<hex>-<ms>","kind":"squawk|status|descent|lost","hex":…,"callsign":…,"reg":…,"type":…,"squawk":…,"emergency":…,
         "lat":…,"lon":…,"altFt":…,"rateFpm":…,"atMs":…,"source":"sweep|view|chase|watch|home|heatmap","late":false}}
{"confirm":{"id":…,"atMs":…}}   {"update":{"id":…,"squawk":…,"emergency":…,"altFt":…,"atMs":…}}   {"end":{"id":…,"atMs":…,"why":…}}
```

**Recording.** On *confirmed*, call `FlightLog.start(hex, info, store.track(hex, 0))` with `by: 'alert'` and the event id. Today `start`
writes `by: 'hand'`. Keep at most 5 alert recordings. Refresh them with one batched `/v2/icao` request every 15 s. The Recordings panel
replays them. adsb.lol's trace file (`/api/trace`) gives the full path later.

**API.** `GET /api/events?since=<ms>` returns the log. `StatusBrief` gets `events: {open, newestMs}`, so the 1 s view request tells the
client when to ask.

**Push.** Set `NTFY_URL=https://ntfy.sh/<random topic>`. On *confirmed* and on late events, POST the text with the `Title`, `Priority`
(urgent for 7500, 7700, D1 and D2), `Tags` and `Click: <APP_URL>/?hex=<hex>` headers [23]. ntfy.sh needs no account. The topic is the
password, so make it random [23]. ntfy.sh allows 250 messages a day. The default request limit is 60 at once, then 1 per 5 s [23]. A self-hosted ntfy server needs
`upstream-base-url` for prompt delivery to iOS [23].

### 7.4 Client

- Settings, Display tab: "Alerts" (off, on), "Follow automatically", "Desktop notifications". Call `Notification.requestPermission()` in that click's handler [24].
- On a new event, show a toast with Follow and Dismiss, and a `new Notification(…, {tag: hex})`. A click calls `select(hex)` (`client/app.ts`).
- Notifications need a secure context: `localhost`, or Tailscale's HTTPS, not a LAN `http://` address [24]. They last only while the page is open [24]. With the page closed, ntfy is the path. Web Push needs a service worker [24], and on an iPhone a Home Screen web app on iOS 16.4 or later [25].
- Auto-follow: `select(hex)` then `setChase(true)`, once per event. Only when it is on, outside History and scenarios, and when you are not chasing an aircraft you chose.
- On load, list the events since the last visit (time kept in `localStorage`).

### 7.5 Example: FZ1073, 2026-09-30

The dive started at 05:21:09 over northern Saudi Arabia, outside any polled area. With this design, the server reads the 05:00 to 05:30
file between 05:30:20 and 05:31:20, and D2 fires. In that file, aircraft 8965d1 is at 34,000 ft until 05:20:50, then at 33,950 ft at 05:21:10
and falling to 32,850 ft at 05:21:40. It has a GNSS altitude of 35,550 ft at 05:22:00 among the baro ones, and 27,950 ft at 05:22:10. The slice
at 05:21:50 is missing, and the file's last slice is at 05:29:50. `clean` drops just that GNSS altitude: the baro point before it, 32,850 ft at 05:21:40, stays. D2 takes the fall into the last point:
33,950 ft at 05:21:10 to 27,950 ft at 05:22:10, 6,000 ft in 60 s, then no position for the 460 s to the end of the file. The sweep sees 7700
at 05:31:26 and confirms it about 30 s later. The status changes to unlawful interference at 05:35:17 (`events.csv`). The first push reaches
the phone about 10 minutes after the dive started.

### 7.6 Beyond this design

- Real-time descent and emergency-status alerts outside the polled areas need a whole-world feed with vertical rate. OpenSky as a registered user gives one every 86 s [12]: at the measured 988 KB a call, about 1 GB a day. That is too slow for D1's 4 points in 120 s, so it can only flag a candidate from `vertical_rate` in 2 successive snapshots. A receiver that feeds adsb.fi unlocks `/v2/snapshot` every 30 s [1]. Estimate for one snapshot: 12,000 aircraft at 421 B (the `/mil` average) is about 5 MB raw and 1.2 MB gzip. At one call every 30 s, that is about 3.5 GB a day.
- No source sees an aircraft that no receiver hears.
- With the server stopped or the Mac asleep, nothing runs.

## Sources

1. adsb.fi open data API, README (endpoints, limits, terms): https://github.com/adsbfi/opendata
2. readsb, README-json.md (fields, query API, trace format): https://github.com/wiedehopf/readsb/blob/dev/README-json.md
3. readsb, api.c (query options, no emergency filter): https://github.com/wiedehopf/readsb/blob/dev/api.c
4. readsb, mode_s.c (emergency/priority status decode, `tcas` mode): https://github.com/wiedehopf/readsb/blob/dev/mode_s.c
5. readsb, track.c and track.h (`emergency_valid` expires after TRACK_EXPIRE, 60 s): https://github.com/wiedehopf/readsb/blob/dev/track.c, https://github.com/wiedehopf/readsb/blob/dev/track.h
6. readsb, globe_index.c (heatmap writer: baro altitude, else GNSS altitude, and squawk idents): https://github.com/wiedehopf/readsb/blob/dev/globe_index.c
7. adsb.lol API source, v2 routes: https://github.com/adsblol/api/blob/main/src/adsb_api/utils/api_v2.py
8. adsb.lol API, description, terms and ODbL licence: https://github.com/adsblol/api/blob/main/src/adsb_api/app.py, https://github.com/adsblol/api
9. adsb.lol, re-api (feeders only): https://www.adsb.lol/docs/feeders-only/re-api/
10. airplanes.live, archived API README (ADSB One): https://github.com/airplanes-live/api-archive
11. ADS-B Exchange, Community API: https://www.adsbexchange.com/community/developer-hub/
12. OpenSky REST API, limitations, credits and state vectors: https://github.com/openskynetwork/opensky-api/blob/master/docs/free/rest.rst, https://github.com/openskynetwork/opensky-api/blob/master/docs/free/states-response.rst
13. OpenSky API documentation, terms of use: https://github.com/openskynetwork/opensky-api/blob/master/docs/free/index.rst
14. Olive, Tanner, Strohmeier et al., "OpenSky Report 2020: Analysing in-flight emergencies using big data", DASC 2020: http://www.cs.ox.ac.uk/files/12039/OpenSky%20Report%202020.pdf
15. FAA AIM 4-1-20, Transponder and ADS-B Out Operation: https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap4_section_1.html
16. FAA AIM 6-2-2, Transponder Emergency Operation: https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap6_section_2.html
17. FAA AIM 6-4-2, Transponder Operation During Two-way Communications Failure: https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap6_section_4.html
18. FAA AIM 4-4-10, Adherence to Clearance: https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap4_section_4.html
19. 14 CFR 25.841(a)(2), Pressurized cabins (read through the eCFR API): https://www.ecfr.gov/current/title-14/section-25.841
20. 14 CFR 91.227(d)(9), ADS-B Out equipment performance (read through the eCFR API): https://www.ecfr.gov/current/title-14/section-91.227
21. ICAO Asia and Pacific Office, Mode S Downlink Aircraft Parameters Implementation and Operations Guidance Document, 3.7: https://www.icao.int/sites/default/files/APAC/Documents/The-6th-Edition-of-Mode-S-Downlink-Aircraft-Parameters-Implementation-and-Operations-Guidance-Document.pdf
22. EASA Safety Information Bulletin 2022-02R4, GNSS outage and alterations, 3 July 2026: https://ad.easa.europa.eu/blob/EASA_SIB_2022_02R4.pdf/SIB_2022-02R4_1
23. ntfy documentation, publishing and limits, FAQ, iOS: https://docs.ntfy.sh/publish/, https://docs.ntfy.sh/faq/, https://docs.ntfy.sh/config/#ios-instant-notifications
24. MDN, Notifications API, Using the Notifications API, Push API: https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API, https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API, https://developer.mozilla.org/en-US/docs/Web/API/Push_API
25. WebKit, Web Push for Web Apps on iOS and iPadOS: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
26. FAA TFR list (JSON) and its help file: https://tfr.faa.gov/tfrapi/exportTfrList, https://tfr.faa.gov/tfr3/AboutTFRWebsite.pdf
27. X API pricing: https://docs.x.com/x-api/getting-started/pricing
28. The Aviation Herald, home page footer: https://avherald.com/
29. Aviation Safety Network: https://aviation-safety.net/
30. Plane Alert DB (ODbL 1.0): https://github.com/sdr-enthusiasts/plane-alert-db
31. Paradive, the skydiving centre at Habonim Beach (C208B Grand Caravan): https://www.paradive.co.il/index.php?dir=site&page=content&cs=3388&langpage=eng

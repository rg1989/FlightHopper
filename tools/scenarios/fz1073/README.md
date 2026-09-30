# FZ1073 package: how it was built

flydubai Flight 1073, 30 September 2026, Boeing 737 MAX 8 A6-FKF (ICAO 8965D1), Dubai → Tel Aviv, diverted to Tabuk
(`public/scenarios/fz1073/`). There is no investigation report yet, so this package is a reconstruction from the
aircraft's own ADS-B broadcasts, and has no captions: the story messages give the data and attribute the reports.

Inputs (not in the repository; `.work/fz1073/sources/` in the main checkout):

- `adsb/adsblol_trace_full.json`: adsb.lol's tar1090 trace of the day for 8965d1
  (`https://adsb.lol/data/traces/d1/trace_full_8965d1.json`, fetched 2026-09-30 08:31 UTC; ODbL). The only source of
  the track.
- `adsb/adsbx_trace_full.json`, `adsb/theairtraffic_trace_full.json`, `adsb/opensky_track.json`: the same flight from
  ADS-B Exchange, theairtraffic and OpenSky, for cross-checks only (their terms do not let us republish them). All four
  lose the aircraft at 05:22:13 and hear it again at 05:31:26, and all end at 05:53:32.
- `adsb/fz1073_merged.csv`: the four merged, one row per reception (for reading, not for the build).
- `research.md`: the news, statements, weather and the list of sources.

Steps:

```bash
node tools/scenarios/fz1073/reconstruct.ts .work/fz1073/sources/adsb/adsblol_trace_full.json
node --test client/scenario/format.test.ts client/scenario/physics.test.ts
```

What the reconstruction knows and does not know is in the header of `reconstruct.ts`. In short: positions, heights and
airspeed are the broadcasts' where received (rows `q=A`); from 05:21:44 the broadcast pressure altitude jumps by up to
1,000 ft within a second while the positions stay smooth, so those altitudes count for little; 05:22:13–05:31:26 was
not received and is the smoothest path between its ends, down to the ~17,000 ft Israeli media reported (`BOTTOM_FT`),
then to 15,000 ft (rows `q=R`, `src=MEDIA`). The attitude is the app's flight-mechanics model on that path.

Checked against ADS-B Exchange's receptions (not used in the build): positions median 18 m, 95th percentile 48 m;
GNSS heights median 18 ft. theairtraffic's receptions sit ~160 m behind along the track (about 1 s late).

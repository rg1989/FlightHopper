# FZ1073 package: how it was built

flydubai Flight 1073, 30 September 2026, Boeing 737 MAX 8 A6-FKF (ICAO 8965D1), Dubai → Tel Aviv, diverted to Tabuk
(`public/scenarios/fz1073/`). There is no investigation report yet, so this package is a reconstruction from the
aircraft's own ADS-B broadcasts, and has no captions: the story messages give the data and attribute the reports. What
happened on board follows Israel's assessment (an attempted suicide terror attack by a radicalized first officer),
attributed as such, with the Saudi and UAE inquiries beside it (updated 2 October 2026; notes in
`articles/17_updates_2026-10-01_02.md`).

Inputs (not in the repository; `.work/fz1073/sources/` in the main checkout):

- `adsb/adsblol_trace_full.json`: adsb.lol's tar1090 trace of the day for 8965d1
  (`https://adsb.lol/data/traces/d1/trace_full_8965d1.json`, fetched 2026-09-30 08:31 UTC; ODbL). The track wherever an
  open network heard the aircraft: 03:05–03:54 and 05:16–05:53.
- `tracks/playback_41e663ed.csv`: a commercial tracking network's playback of the flight, used
  only where no open network heard it: the cruise 03:54–05:16, the dive and zoom 05:22–05:31, 05:53–06:13, and its
  satellite fixes at 06:28:37 and 06:43:39. Its time stamps scatter −5…+6 s against adsb.lol's; its fixes count for
  that. Its positions only: the heights there come from the next file.
- `tracks/granular.csv`: the granular data published for the flight:
  pressure altitude, ground speed and vertical rate about once a second, on the playback's clock (the playback's rows
  are a subsample of it). The heights wherever no open network heard the aircraft, except 05:21:44–05:23:00, where the
  pressure altitude is unreliable and the playback's sparser heights are kept.
- `osm_runways_omdb.json`, `osm_runways_oetb.json`: OpenStreetMap's runways at Dubai and Tabuk (Overpass, ODbL), for
  `airport.json`.
- `adsb/adsbx_trace_full.json`, `adsb/theairtraffic_trace_full.json`, `adsb/opensky_track.json`: the same flight from
  ADS-B Exchange, theairtraffic and OpenSky, for cross-checks only. All lose the aircraft at 05:22:13–05:31:26 and after
  05:53:32.
- `articles/`: the news, statements, weather and the list of sources.

Steps:

```bash
node tools/scenarios/fz1073/airports.ts
node tools/scenarios/fz1073/reconstruct.ts .work/fz1073/sources/adsb/adsblol_trace_full.json .work/fz1073/sources/tracks/playback_41e663ed.csv .work/fz1073/sources/tracks/granular.csv
node --test client/scenario/format.test.ts client/scenario/physics.test.ts
```

What the reconstruction knows and does not know is in the header of `reconstruct.ts`. In short: rows `q=A` are within
5 s of a reception. Built, not heard (`q=R`): the take-off roll on 30R (timed by the playback's 03:04:54 fix and
adsb.lol's first airborne one), the descent 06:13–06:28 (the smoothest path between two fixes), 06:28–06:43 (two
satellite fixes 14 nm and 15 minutes apart: drawn as an extended right-hand circuit for runway 31, not known), and the
landing (3° glidepath, touchdown ~06:44:50). The attitude is the app's flight-mechanics model on that path.

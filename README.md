# FlightHopper

Live ADS-B chase-cam on a CesiumJS globe: pick an aircraft and follow it in third person over real terrain, down to a geographically correct landing.

Personal, non-commercial project. **Entertainment only — not for navigation, ATC or any operational decision.**

**Status:** under construction. Plan: [`.planning/PLAN.md`](.planning/PLAN.md) · work packages: [`.planning/plans/`](.planning/plans/).

## Quick start

```bash
npm ci
cp .env.example .env.local   # set CONTACT; optional VITE_ARCGIS_KEY (sharp imagery), VITE_CESIUM_ION_TOKEN
npm run check                # type-check + tests
make                         # live traffic (adsb.fi) + client; prints the link, Ctrl+C stops both
make replay                  # the same, replaying the newest recording
```

## The past

- **Flown path:** select an aircraft and its whole leg so far shows behind it, coloured by altitude; dotted where no
  receiver heard it, and from its origin airport when the route is known.
- **History** (the rail's clock button, or `?hist=<unix s>`): the map as it was at any time of the last ~42 days (what
  adsb.lol keeps), every aircraft in view on a replay clock with its type's silhouette, and a time bar (play, scrub over
  the day, the day before and after, 1×/10×/60×, Go to, Live) that shows a loader while the time under it loads. A
  selected aircraft brings its day: its flights in amber on the bar, and where it was at any time (flying, on the ground,
  or faded where it was last heard). Chase in 3-D works in the past too. Aircraft types: the Mictronics database (ODC-By
  1.0, credit below). Design: [`.planning/history-design.md`](.planning/history-design.md),
  [`.planning/history-ux-design.md`](.planning/history-ux-design.md).
- A live server keeps the newest hour of the past in memory (two half-hour files, ~25 MB per 30 min while it runs); older
  half hours are fetched when the replay needs them and dropped again. Nothing is written to disk.

## Data sources

- Live aircraft: [adsb.fi](https://adsb.fi) open data (personal, non-commercial use), the default; [adsb.lol](https://adsb.lol) — data © adsb.lol contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) — for recordings and `LIVE_SOURCE=adsblol`. Later: the author's own receiver.
- The past: adsb.lol's tar1090 heatmap files (every aircraft, 10 s) and per-aircraft traces, the same ODbL 1.0 data.
- Aircraft types in the past: the [Mictronics aircraft database](https://github.com/Mictronics/aircraft-database). Contains information from the Mictronics aircraft database, made available under the [ODC Attribution License](https://opendatacommons.org/licenses/by/1-0/). The server downloads it and holds it in memory only.
- Airports: [OurAirports](https://ourairports.com/data/) (public domain).
- Search places: airports and countries from OurAirports, cities of 15 000+ people and their regions from [GeoNames](https://www.geonames.org/) ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)); `node tools/build-places.ts` rebuilds `public/search/places.json`.
- Chase map borders, country and sea names: [Natural Earth](https://www.naturalearthdata.com/) (public domain); `node tools/build-map-overlays.ts` rebuilds `public/map/`.
- Terrain / imagery: Cesium ion (Community plan), Re:Earth terrain, Esri World Imagery (optional `VITE_ARCGIS_KEY`), EOX Sentinel-2 cloudless.

Contact: roman.grinevic@gmail.com

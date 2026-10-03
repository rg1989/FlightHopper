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

## The weather in the chase

- **Weather** (the Layers panel's switch, or `W`): in the chase the clouds, rain and storms are volumes round the aircraft, from airport
  reports, the rain radar and the weather model: it flies into them and fades out of sight in thick ones. A line at the top says what is
  on its heading ("In light rain", "Clear air · a thunderstorm in 3 min") and a red frame shows it is inside a hazard area. Live only:
  History and scenarios draw none.
- **The Weather menu** (a square of its own under Layers, there while the chase's weather is drawn; it opens when you turn Weather on in
  a live chase, not at load). **Clouds:** natural, severity colours (cloud white, light rain blue, heavy rain amber, thunderstorm red) or
  blocks. **Hazard areas:** a curtain, a fence or a box. **Looking ahead:** three switches, the track line (the next six minutes on this
  heading), the level slice (the weather at the aircraft's own altitude) and the ahead strip (a side view of the next 80 km). A choice
  applies at once and is kept in this browser; `?wxlook=natural|severity|blocks`, `?wxhaz=curtain|fence|box` and `?wxtrack`, `?wxslice`,
  `?wxstrip` (`=0` or `=1`) set them for one load.

## Data sources

- Live aircraft: [adsb.fi](https://adsb.fi) open data (personal, non-commercial use), the default; [adsb.lol](https://adsb.lol) — data © adsb.lol contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) — for recordings and `LIVE_SOURCE=adsblol`. Later: the author's own receiver.
- The past: adsb.lol's tar1090 heatmap files (every aircraft, 10 s) and per-aircraft traces, the same ODbL 1.0 data.
- Aircraft types in the past: the [Mictronics aircraft database](https://github.com/Mictronics/aircraft-database). Contains information from the Mictronics aircraft database, made available under the [ODC Attribution License](https://opendatacommons.org/licenses/by/1-0/). The server downloads it and holds it in memory only.
- Airports: [OurAirports](https://ourairports.com/data/) (public domain).
- Airport weather reports (METARs) and hazard areas (SIGMETs): the [aviationweather.gov](https://aviationweather.gov/data/api/) Data API (no key). The server fetches them for the client, because aviationweather.gov sends no CORS headers.
- Rain radar: [RainViewer](https://www.rainviewer.com/api.html)'s newest radar frame (keyless tiles), which the client fetches and draws itself.
- Weather model, for the chase's clouds where no report or radar says and its winds aloft (the flight-data frame's wind when an aircraft sends none): [Open-Meteo](https://open-meteo.com/). Weather data by Open-Meteo.com, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), free for non-commercial use. Round the chase the server wants a grid of places 0.25° apart: it asks Open-Meteo once for the places it lacks, keeps each place fresh for 30 min, and holds it up to 2 h. It asks for at most 8,000 calls a day and 4,000 an hour, under Open-Meteo's free 10,000 and 5,000.
- Search places: airports and countries from OurAirports, cities of 15 000+ people and their regions from [GeoNames](https://www.geonames.org/) ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)); `node tools/build-places.ts` rebuilds `public/search/places.json`.
- Chase map borders, country and sea names: [Natural Earth](https://www.naturalearthdata.com/) (public domain); `node tools/build-map-overlays.ts` rebuilds `public/map/`.
- Terrain / imagery: Cesium ion (Community plan), Re:Earth terrain, Esri World Imagery (optional `VITE_ARCGIS_KEY`), EOX Sentinel-2 cloudless.

Contact: roman.grinevic@gmail.com

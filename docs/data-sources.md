# Data sources

What FlightHopper reads, from where, and under which terms.

- Live aircraft: [adsb.fi](https://adsb.fi) open data (personal, non-commercial use), the default; [adsb.lol](https://adsb.lol) — data © adsb.lol contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) — for recordings and `LIVE_SOURCE=adsblol`.
- The past: adsb.lol's tar1090 heatmap files (every aircraft, 10 s) and per-aircraft traces, the same ODbL 1.0 data.
- Aircraft types in the past: the [Mictronics aircraft database](https://github.com/Mictronics/aircraft-database). Contains information from the Mictronics aircraft database, made available under the [ODC Attribution License](https://opendatacommons.org/licenses/by/1-0/). The server downloads it and holds it in memory only.
- Airports: [OurAirports](https://ourairports.com/data/) (public domain). `node tools/build-runways.ts` rebuilds `public/airports/runways.json`: every open runway with both ends placed (14,299 runways of 10,873 airports). The app fetches it the first time the selected aircraft's signal is lost. An aircraft that is no longer heard on its final approach to one of these runways is drawn landing on it, and its card says "Landed": an estimate, as receivers lose most aircraft below their horizon just before they touch down.
- Airport weather reports (METARs) and hazard areas (SIGMETs): the [aviationweather.gov](https://aviationweather.gov/data/api/) Data API (no key). The server fetches them for the client, because aviationweather.gov sends no CORS headers.
- Rain radar: [RainViewer](https://www.rainviewer.com/api.html)'s newest radar frame (keyless tiles), which the client fetches and draws itself.
- Weather model, for the chase's clouds where no report or radar says and its winds aloft (the flight-data frame's wind when an aircraft sends none): [Open-Meteo](https://open-meteo.com/). Weather data by Open-Meteo.com, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), free for non-commercial use. Round the chase the server wants a grid of places 0.25° apart: it asks Open-Meteo once for the places it lacks, keeps each place fresh for 30 min, and holds it up to 2 h. It asks for at most 8,000 calls a day and 4,000 an hour, under Open-Meteo's free 10,000 and 5,000.
- Search places: airports and countries from OurAirports, cities of 15 000+ people and their regions from [GeoNames](https://www.geonames.org/) ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)); `node tools/build-places.ts` rebuilds `public/search/places.json`.
- Chase map borders, country and sea names: [Natural Earth](https://www.naturalearthdata.com/) (public domain); `node tools/build-map-overlays.ts` rebuilds `public/map/`.
- Terrain / imagery: Cesium ion (Community plan), Re:Earth terrain, Esri World Imagery (optional `VITE_ARCGIS_KEY`), EOX Sentinel-2 cloudless.
- Aircraft photos: [Planespotters.net](https://www.planespotters.net/), each shown with its photographer's credit and a link.
- Flight routes: [adsbdb.com](https://www.adsbdb.com/), asked for the selected flight only.
- Street map: [OpenStreetMap](https://www.openstreetmap.org/copyright) tiles. Buildings and streets in the chase: [OpenFreeMap](https://openfreemap.org/) vector tiles of OpenStreetMap data. © OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
- City lights at night: NASA's VIIRS Black Marble, from [GIBS](https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api).

# FlightHopper

Live ADS-B chase-cam on a CesiumJS globe: pick an aircraft and follow it in third person over real terrain, down to a geographically correct landing.

Personal, non-commercial project. **Entertainment only — not for navigation, ATC or any operational decision.**

**Status:** under construction. Plan: [`.planning/PLAN.md`](.planning/PLAN.md) · work packages: [`.planning/plans/`](.planning/plans/).

## Quick start

```bash
npm ci
cp .env.example .env.local   # set CONTACT; optional VITE_ARCGIS_KEY (sharp imagery), VITE_CESIUM_ION_TOKEN
npm run check                # type-check + tests
make                         # API (replaying the newest recording) + client; prints the link, Ctrl+C stops both
make live                    # the same on live adsb.lol (stop the recorder first)
```

## Data sources

- Live aircraft: [adsb.lol](https://adsb.lol) — data © adsb.lol contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Later: the author's own receiver.
- Airports: [OurAirports](https://ourairports.com/data/) (public domain).
- Terrain / imagery: Cesium ion (Community plan), Re:Earth terrain, Esri World Imagery (optional `VITE_ARCGIS_KEY`), EOX Sentinel-2 cloudless.

Contact: roman.grinevic@gmail.com

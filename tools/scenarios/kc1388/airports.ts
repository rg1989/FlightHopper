// tools/scenarios/kc1388/airports.ts
// Writes public/scenarios/kc1388/airport.json: Alverca (LPAR), where KC1388 took off, and Beja (LPBJ), where it landed,
// in the app's Airport shape (shared/airports.ts). Runway ends from OpenStreetMap (ODbL, © OpenStreetMap contributors;
// ways 643904610, 27507182, 157940294 + 1446007553), lengths and widths checked against the GPIAAF report §1.10;
// end elevations from SRTM 30 m (OpenTopoData), rounded to feet. Heights: MSL + EGM96.
//
//   node tools/scenarios/kc1388/airports.ts
import { writeFileSync } from 'node:fs'
import type { Airport, RunwayEnd } from '../../../shared/airports.ts'
import { bearingDeg } from '../../../shared/geo.ts'
import { geoidN } from '../../../shared/geoid.ts'

const FT = 0.3048
const r2 = (v: number): number => Math.round(v * 100) / 100
const r1 = (v: number): number => Math.round(v * 10) / 10

type End = { ident: string; lat: number; lon: number; elevFt: number }

function runway(a: End, b: End, widthFt: number, surface: string): Airport['runways'][number] {
  const end = (e: End, to: End): RunwayEnd => ({
    ident: e.ident, lat: e.lat, lon: e.lon, thrLat: e.lat, thrLon: e.lon, displacedFt: 0, elevFt: e.elevFt,
    hdgTrueDeg: r1(bearingDeg(e.lat, e.lon, to.lat, to.lon)), thrHaeM: r2(e.elevFt * FT + geoidN(e.lat, e.lon)),
  })
  const m = Math.hypot((b.lat - a.lat) * 111_000, (b.lon - a.lon) * 111_000 * Math.cos((a.lat * Math.PI) / 180))
  return { lengthFt: Math.round(m / FT), widthFt, surface, ends: [end(a, b), end(b, a)] }
}

function airport(ident: string, name: string, lat: number, lon: number, elevFt: number, source: string, rws: Airport['runways']): Airport & { source: string } {
  return { ident, name, source, lat, lon, elevFt, nM: r2(geoidN(lat, lon)), runways: rws }
}

const out = [
  airport('LPAR', 'Alverca Air Base (BA1 / OGMA)', 38.8833, -9.0301, 11,
    'Runway 04/22 ends from OpenStreetMap way 643904610 (2,500 m, as the GPIAAF report §1.10 gives it); width 45 m ' +
    '(report); elevation 11 ft (SRTM: the Tagus bank, 0–3 m). Heights: MSL + EGM96.', [
      runway({ ident: '04', lat: 38.8737041, lon: -9.037774, elevFt: 11 }, { ident: '22', lat: 38.8926808, lon: -9.0222391, elevFt: 11 }, 148, 'ASP'),
    ]),
  airport('LPBJ', 'Beja Air Base (BA11) / Beja Airport', 38.078903, -7.932397, 617,
    'Runway ends from OpenStreetMap ways 27507182 (01L/19R, 60 m) and 157940294 + 1446007553 (01R/19L, 30 m); ' +
    'the GPIAAF report §1.10: 19R/01L 3,450 × 60 m, 19L/01R 3,449 × 30 m, concrete, airport 617 ft, ' +
    'ARP N38°04′44.05″ W007°55′56.63″. End elevations from SRTM 30 m. Heights: MSL + EGM96.', [
      runway({ ident: '01L', lat: 38.0634496, lon: -7.934437, elevFt: 627 }, { ident: '19R', lat: 38.0943509, lon: -7.930368, elevFt: 623 }, 197, 'CON'),
      runway({ ident: '01R', lat: 38.0654423, lon: -7.931698, elevFt: 630 }, { ident: '19L', lat: 38.0919489, lon: -7.9282007, elevFt: 607 }, 98, 'CON'),
    ]),
]

writeFileSync(new URL('../../../public/scenarios/kc1388/airport.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`)
console.log(out.map((a) => `${a.ident}: ${a.runways.map((r) => `${r.ends[0].ident}/${r.ends[1].ident} ${r.lengthFt} ft, ${r.ends[0].hdgTrueDeg}°`).join('; ')}`).join('\n'))

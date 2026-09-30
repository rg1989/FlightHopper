// tools/scenarios/fz1073/airports.ts
// Writes public/scenarios/fz1073/airport.json: Dubai International (OMDB), where FZ1073 took off, and Tabuk (OETB),
// where it landed, in the app's Airport shape (shared/airports.ts). Runway ends from OpenStreetMap (ODbL, © OpenStreetMap
// contributors); Dubai's displaced thresholds where OSM's runway ways join, as OurAirports gives them (984 ft 30R, 1,476
// ft 12L, 433 ft 30L, 2,345 ft 12R); end elevations, widths and Tabuk 06/24 from OurAirports (public domain).
// Heights: MSL + EGM96.
//
//   node tools/scenarios/fz1073/airports.ts
import { writeFileSync } from 'node:fs'
import type { Airport, RunwayEnd } from '../../../shared/airports.ts'
import { bearingDeg } from '../../../shared/geo.ts'
import { geoidN } from '../../../shared/geoid.ts'

const FT = 0.3048
const r2 = (v: number): number => Math.round(v * 100) / 100
const r1 = (v: number): number => Math.round(v * 10) / 10

/** A runway end: the pavement's end, and the landing threshold where it is displaced. */
type End = { ident: string; lat: number; lon: number; elevFt: number; thr?: [number, number]; displacedFt?: number }

function runway(a: End, b: End, widthFt: number, surface: string): Airport['runways'][number] {
  const end = (e: End, to: End): RunwayEnd => {
    const [thrLat, thrLon] = e.thr ?? [e.lat, e.lon]
    return {
      ident: e.ident, lat: e.lat, lon: e.lon, thrLat, thrLon, displacedFt: e.displacedFt ?? 0, elevFt: e.elevFt,
      hdgTrueDeg: r1(bearingDeg(e.lat, e.lon, to.lat, to.lon)), thrHaeM: r2(e.elevFt * FT + geoidN(thrLat, thrLon)),
    }
  }
  const m = Math.hypot((b.lat - a.lat) * 111_195, (b.lon - a.lon) * 111_195 * Math.cos((a.lat * Math.PI) / 180))
  return { lengthFt: Math.round(m / FT), widthFt, surface, ends: [end(a, b), end(b, a)] }
}

function airport(ident: string, name: string, lat: number, lon: number, elevFt: number, source: string, rws: Airport['runways']): Airport & { source: string } {
  return { ident, name, source, lat, lon, elevFt, nM: r2(geoidN(lat, lon)), runways: rws }
}

const out = [
  airport('OMDB', 'Dubai International Airport', 25.24979, 55.370992, 62,
    'Runway ends from OpenStreetMap ways 95511342 + 1059547901 + 1076760102 (12L/30R) and 152351328 + 1077849652 ' +
    '(12R/30L); thresholds where those ways join (OurAirports: displaced 1,476/984 ft and 2,345/433 ft); widths and end ' +
    'elevations from OurAirports. Heights: MSL + EGM96.', [
      runway(
        { ident: '12L', lat: 25.2667249, lon: 55.3466213, elevFt: 11, thr: [25.2646315, 55.3504159], displacedFt: 1476 },
        { ident: '30R', lat: 25.2462962, lon: 55.3834414, elevFt: 32, thr: [25.2477035, 55.3809094], displacedFt: 984 }, 197, 'ASP'),
      runway(
        { ident: '12R', lat: 25.2561974, lon: 55.3582935, elevFt: 11, thr: [25.252836, 55.364376], displacedFt: 2345 },
        { ident: '30L', lat: 25.2353515, lon: 55.3958753, elevFt: 60, thr: [25.235919, 55.394882], displacedFt: 433 }, 197, 'ASP'),
    ]),
  airport('OETB', 'Prince Sultan bin Abdulaziz International Airport (Tabuk)', 28.3711, 36.624865, 2551,
    'Runway 13/31 ends from OpenStreetMap ways 35164178 + 1451637075 + 1451637073 (3,048 m, 45 m wide); 06/24 and the ' +
    'end elevations from OurAirports. Heights: MSL + EGM96.', [
      runway({ ident: '13', lat: 28.3803511, lon: 36.5945249, elevFt: 2530 }, { ident: '31', lat: 28.3618733, lon: 36.6175436, elevFt: 2539 }, 148, 'ASP'),
      runway({ ident: '06', lat: 28.3692, lon: 36.6199, elevFt: 2545 }, { ident: '24', lat: 28.382, lon: 36.6509, elevFt: 2551 }, 148, 'ASP'),
    ]),
]

writeFileSync(new URL('../../../public/scenarios/fz1073/airport.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`)
console.log(out.map((a) => `${a.ident}: ${a.runways.map((r) => `${r.ends[0].ident}/${r.ends[1].ident} ${r.lengthFt} ft, ${r.ends[0].hdgTrueDeg}°`).join('; ')}`).join('\n'))

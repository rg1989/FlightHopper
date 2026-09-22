// tools/build-airports.ts
// Builds public/airports/heroes.json from OurAirports (public domain) + EGM96.
//
//   node tools/build-airports.ts [--heroes tools/heroes.json] [--out public/airports/heroes.json] [--cache node_modules/.cache/ourairports]
//
// The two CSVs (~17 MB) are downloaded once into --cache (under node_modules, so gitignored); delete the folder to refresh.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import type { Airport, RunwayEnd } from '../shared/airports.ts'
import { bearingDeg, destination } from '../shared/geo.ts'
import { geoidN } from '../shared/geoid.ts'

const OURAIRPORTS = 'https://davidmegginson.github.io/ourairports-data/'
const FT = 0.3048

/** RFC 4180 CSV → one object per data row, keyed by the header row. Blank lines are skipped. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let i = 0
  const n = text.length
  while (i < n) {
    let field = ''
    if (text[i] === '"') {
      let j = i + 1
      for (;;) {
        const q = text.indexOf('"', j)
        if (q === -1) throw new Error(`CSV: unterminated quote starting at ${i}`)
        field += text.slice(j, q)
        if (text[q + 1] !== '"') {
          i = q + 1
          break
        }
        field += '"'
        j = q + 2
      }
    } else {
      let j = i
      while (j < n && text[j] !== ',' && text[j] !== '\n' && text[j] !== '\r') j++
      field = text.slice(i, j)
      i = j
    }
    row.push(field)
    const c = text[i]
    if (c === ',') {
      i++
      if (i === n) row.push('')
      else continue
    } else if (c === '\r' && text[i + 1] === '\n') i += 2
    else if (c === '\r' || c === '\n') i++
    else if (i < n) throw new Error(`CSV: unexpected ${JSON.stringify(c)} after a quoted field at ${i}`)
    rows.push(row)
    row = []
  }
  const [header, ...body] = rows
  if (!header) return []
  return body
    .filter((r) => !(r.length === 1 && r[0] === ''))
    .map((r) => Object.fromEntries(header.map((k, j) => [k, r[j] ?? ''])))
}

const round = (x: number, digits: number): number => Math.round(x * 10 ** digits) / 10 ** digits

/** One runway end from the le_/he_ columns; `other` is the opposite end's prefix (for the heading fallback). */
function runwayEnd(r: Record<string, string>, p: 'le_' | 'he_', other: 'le_' | 'he_', airportElevFt: number): RunwayEnd {
  const lat = Number(r[`${p}latitude_deg`])
  const lon = Number(r[`${p}longitude_deg`])
  const hdgTrueDeg =
    r[`${p}heading_degT`] !== ''
      ? Number(r[`${p}heading_degT`])
      : bearingDeg(lat, lon, Number(r[`${other}latitude_deg`]), Number(r[`${other}longitude_deg`]))
  const displacedFt = Number(r[`${p}displaced_threshold_ft`] || 0)
  const elevFt = r[`${p}elevation_ft`] !== '' ? Number(r[`${p}elevation_ft`]) : airportElevFt
  const thr = destination(lat, lon, hdgTrueDeg, (displacedFt * FT) / 1852)
  return {
    ident: r[`${p}ident`],
    lat,
    lon,
    thrLat: thr.lat,
    thrLon: thr.lon,
    displacedFt,
    elevFt,
    hdgTrueDeg,
    thrHaeM: round(elevFt * FT + geoidN(thr.lat, thr.lon), 2),
  }
}

/**
 * Airports for `idents` (in that order) from the OurAirports airports.csv / runways.csv text.
 * Keeps open (closed === '0'), non-grass/turf runways with both end coordinates.
 * ponytail: the OurAirports threshold is trusted as published; hand-verification against the AIP is M4.
 */
export function buildAirports(airportsCsv: string, runwaysCsv: string, idents: string[]): Airport[] {
  const wanted = new Set(idents)
  const airports = new Map(parseCsv(airportsCsv).filter((a) => wanted.has(a.ident)).map((a) => [a.ident, a]))
  const runways = parseCsv(runwaysCsv).filter(
    (r) =>
      wanted.has(r.airport_ident) &&
      r.closed === '0' &&
      !/GRASS|TURF/i.test(r.surface) &&
      [r.le_latitude_deg, r.le_longitude_deg, r.he_latitude_deg, r.he_longitude_deg].every((v) => v !== ''),
  )
  return idents.map((ident) => {
    const a = airports.get(ident)
    if (!a) throw new Error(`airport ${ident} not found in airports.csv`)
    const lat = Number(a.latitude_deg)
    const lon = Number(a.longitude_deg)
    const elevFt = Number(a.elevation_ft)
    return {
      ident,
      name: a.name,
      lat,
      lon,
      elevFt,
      nM: round(geoidN(lat, lon), 1),
      runways: runways
        .filter((r) => r.airport_ident === ident)
        .map((r) => ({
          lengthFt: Number(r.length_ft),
          widthFt: Number(r.width_ft),
          surface: r.surface,
          ends: [runwayEnd(r, 'le_', 'he_', elevFt), runwayEnd(r, 'he_', 'le_', elevFt)] as [RunwayEnd, RunwayEnd],
        })),
    }
  })
}

/** CSV text from `dir/name`, downloaded from OurAirports first when it is not cached yet. */
export async function cachedCsv(dir: string, name: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const path = join(dir, name)
  if (existsSync(path)) return readFileSync(path, 'utf8')
  const res = await fetchFn(OURAIRPORTS + name)
  if (!res.ok) throw new Error(`GET ${OURAIRPORTS + name}: HTTP ${res.status}`)
  const text = await res.text()
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, text)
  return text
}

export async function main(argv: string[], fetchFn: typeof fetch = fetch): Promise<Airport[]> {
  const { values } = parseArgs({
    args: argv,
    options: {
      heroes: { type: 'string', default: 'tools/heroes.json' },
      out: { type: 'string', default: 'public/airports/heroes.json' },
      cache: { type: 'string', default: 'node_modules/.cache/ourairports' },
    },
  })
  const heroes: { ident: string; role: string }[] = JSON.parse(readFileSync(values.heroes, 'utf8'))
  const airportsCsv = await cachedCsv(values.cache, 'airports.csv', fetchFn)
  const runwaysCsv = await cachedCsv(values.cache, 'runways.csv', fetchFn)
  const airports = buildAirports(airportsCsv, runwaysCsv, heroes.map((h) => h.ident))
  mkdirSync(dirname(values.out), { recursive: true })
  writeFileSync(values.out, JSON.stringify(airports, null, 1) + '\n')
  for (const a of airports) console.log(`${a.ident}  ${a.name}: ${a.runways.length} runways, N ${a.nM} m`)
  console.log(`wrote ${values.out}`)
  return airports
}

if (import.meta.main) await main(process.argv.slice(2))

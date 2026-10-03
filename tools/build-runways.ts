// tools/build-runways.ts
// Builds public/airports/runways.json (shared/landing.ts RunwayTable) from OurAirports (public domain): every open runway
// of an airport or seaplane base with both ends placed, 300 m or more apart. For finding the runway an aircraft that is no
// longer heard was landing on (shared/landing.ts).
//
//   node tools/build-runways.ts [--out public/airports/runways.json] [--cache node_modules/.cache/ourairports]
//
// The two CSVs (~17 MB) are downloaded once into --cache (under node_modules, so gitignored); delete the folder to refresh.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { distanceNm } from '../shared/geo.ts'
import type { RunwayRow, RunwayTable } from '../shared/landing.ts'
import { cachedCsv, parseCsv } from './build-airports.ts'

const TYPES = new Set(['large_airport', 'medium_airport', 'small_airport', 'seaplane_base'])
const MIN_M = 300 // shorter is a helipad or a slip of the pen
const r5 = (x: number): number => Math.round(x * 1e5) / 1e5 // 1 m

/**
 * The table from the OurAirports airports.csv and runways.csv text. An end with no elevation takes its airport's (0 when
 * that is blank too). Airports with no runway kept are left out; the order is the CSVs'.
 */
export function buildRunways(airportsCsv: string, runwaysCsv: string): RunwayTable {
  const airports = new Map(parseCsv(airportsCsv).filter((a) => TYPES.has(a.type)).map((a) => [a.ident, a]))
  const index = new Map<string, number>()
  const out: RunwayTable = { airports: [], runways: [] }
  for (const r of parseCsv(runwaysCsv)) {
    const a = airports.get(r.airport_ident)
    if (a === undefined || r.closed !== '0') continue
    if ([r.le_latitude_deg, r.le_longitude_deg, r.he_latitude_deg, r.he_longitude_deg].some((v) => v === '')) continue
    const [lat1, lon1, lat2, lon2] = [r.le_latitude_deg, r.le_longitude_deg, r.he_latitude_deg, r.he_longitude_deg].map((v) => r5(Number(v)))
    if (![lat1, lon1, lat2, lon2].every(Number.isFinite) || distanceNm(lat1, lon1, lat2, lon2) * 1852 < MIN_M) continue
    let i = index.get(a.ident)
    if (i === undefined) {
      index.set(a.ident, (i = out.airports.length))
      out.airports.push([a.ident, a.name])
    }
    const elev = (v: string): number => Math.round(Number(v !== '' ? v : a.elevation_ft) || 0)
    const row: RunwayRow = [
      i,
      r.le_ident, lat1, lon1, elev(r.le_elevation_ft), Math.round(Number(r.le_displaced_threshold_ft) || 0),
      r.he_ident, lat2, lon2, elev(r.he_elevation_ft), Math.round(Number(r.he_displaced_threshold_ft) || 0),
    ]
    out.runways.push(row)
  }
  return out
}

export async function main(argv: string[], fetchFn: typeof fetch = fetch): Promise<RunwayTable> {
  const { values } = parseArgs({
    args: argv,
    options: { out: { type: 'string', default: 'public/airports/runways.json' }, cache: { type: 'string', default: 'node_modules/.cache/ourairports' } },
  })
  const table = buildRunways(await cachedCsv(values.cache, 'airports.csv', fetchFn), await cachedCsv(values.cache, 'runways.csv', fetchFn))
  mkdirSync(dirname(values.out), { recursive: true })
  writeFileSync(values.out, JSON.stringify(table) + '\n')
  console.log(`${table.runways.length} runways of ${table.airports.length} airports: wrote ${values.out}`)
  return table
}

if (import.meta.main) await main(process.argv.slice(2))

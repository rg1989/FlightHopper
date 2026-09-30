// tools/build-places.ts
// Builds public/search/places.json (shared/places.ts) for the search box: airports with scheduled flights from OurAirports
// (public domain), cities of 15 000+ people and their regions from GeoNames (CC BY 4.0), countries from OurAirports with
// a box around where their people live.
//
//   node tools/build-places.ts [--out public/search/places.json] [--cache node_modules/.cache]
//
// The sources (~16 MB) are downloaded once into --cache (under node_modules, so gitignored); delete them to refresh.
// cities15000 comes zipped: `unzip` (macOS, Linux) reads it.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import type { Places } from '../shared/places.ts'
import { parseCsv } from './build-airports.ts'

const OURAIRPORTS = 'https://davidmegginson.github.io/ourairports-data/'
const GEONAMES = 'https://download.geonames.org/export/dump/'
const SIZE = { large_airport: 3, medium_airport: 2, small_airport: 1 } as const
// OurAirports' keywords are mostly "<country> airports" in its own script; these are the names people type.
const AKA: Record<string, string> = { US: 'USA,America', GB: 'UK,Britain,Great Britain,England', AE: 'UAE', KR: 'Korea', NL: 'Holland' }
// ponytail: Hawaii and Alaska hold 0.5 % of the US's people, enough to stretch its box over the Pacific; the lower 48
// instead. Add a country here when its box frames too much sea.
const BOX: Record<string, [south: number, north: number, west: number, east: number]> = { US: [24.5, 49.4, -124.8, -66.9] }

const r3 = (x: number): number => Math.round(x * 1000) / 1000

/** The value below which share q of the total weight lies. xs and ws are parallel; xs non-empty. */
export function weightedQuantile(xs: readonly number[], ws: readonly number[], q: number): number {
  const order = xs.map((_, i) => i).sort((a, b) => xs[a]! - xs[b]!)
  const total = ws.reduce((s, w) => s + w, 0)
  let acc = 0
  for (const i of order) {
    acc += ws[i]!
    if (acc >= q * total) return xs[i]!
  }
  return xs[order[order.length - 1]!]!
}

/**
 * The places from the four sources' text. A country's box holds 99 % of its cities' people along each axis
 * (0.5 %–99.5 %): a far-off village does not stretch it, and a small city at the edge (Eilat) still counts. One with no
 * city of 15 000 boxes its airports; one with neither is left out.
 * ponytail: the box is taken along longitude as numbers, so a country across the antimeridian (Fiji, Kiribati) would
 * get a box round the world; none with cities of 15 000+ crosses it today.
 */
export function buildPlaces(airportsCsv: string, countriesCsv: string, citiesTsv: string, admin1Tsv: string): Places {
  const regionName = new Map<string, string>()
  for (const line of admin1Tsv.split('\n')) {
    const [code, name] = line.split('\t')
    if (code && name) regionName.set(code, name)
  }
  const regions: string[] = []
  const regionIdx = new Map<string, number>()
  const cities: Places['cities'] = []
  for (const line of citiesTsv.split('\n')) {
    const f = line.split('\t')
    if (f.length < 15) continue
    const [name, lat, lon, iso2, admin1, pop] = [f[1]!, Number(f[4]), Number(f[5]), f[8]!, f[10]!, Number(f[14])]
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || !/^[A-Z]{2}$/.test(iso2)) continue
    const rn = regionName.get(`${iso2}.${admin1}`)
    let ri = -1
    if (rn !== undefined) {
      ri = regionIdx.get(rn) ?? regions.length
      if (ri === regions.length) {
        regions.push(rn)
        regionIdx.set(rn, ri)
      }
    }
    cities.push([name, iso2, ri, r3(lat), r3(lon), Number.isFinite(pop) ? pop : 0])
  }
  cities.sort((a, b) => b[5] - a[5]) // biggest first: ties in the search go to the bigger city

  const airports: Places['airports'] = []
  for (const a of parseCsv(airportsCsv)) {
    const size = SIZE[a.type as keyof typeof SIZE]
    if (size === undefined || a.scheduled_service !== 'yes') continue
    const lat = Number(a.latitude_deg)
    const lon = Number(a.longitude_deg)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    const ident = a.icao_code || a.ident
    airports.push([ident, a.iata_code ?? '', a.name ?? ident, a.municipality ?? '', a.iso_country ?? '', r3(lat), r3(lon), size])
  }
  airports.sort((a, b) => b[7] - a[7])

  const countries: Places['countries'] = []
  for (const c of parseCsv(countriesCsv)) {
    const iso2 = c.code ?? ''
    const own = cities.filter((x) => x[1] === iso2)
    const pts = own.length > 0 ? own.map((x) => [x[3], x[4], x[5]] as const) : airports.filter((x) => x[4] === iso2).map((x) => [x[5], x[6], 1] as const)
    if (pts.length === 0) continue
    const lats = pts.map((p) => p[0])
    const lons = pts.map((p) => p[1])
    const ws = pts.map((p) => Math.max(1, p[2]))
    const kw = (c.keywords ?? '').split(',').map((k) => k.trim()).filter((k) => /^[A-Za-z'-]+$/.test(k)) // one word: not "<country> airports"
    const aka = [...new Set([...(AKA[iso2]?.split(',') ?? []), ...kw])].join(',')
    const box = BOX[iso2] ?? [weightedQuantile(lats, ws, 0.005), weightedQuantile(lats, ws, 0.995), weightedQuantile(lons, ws, 0.005), weightedQuantile(lons, ws, 0.995)]
    countries.push([iso2, c.name ?? iso2, aka, ...(box.map(r3) as typeof box)])
  }
  return { countries, airports, regions, cities }
}

/** Text of `dir/name`, downloaded from `base` first when it is not cached yet. */
async function cached(dir: string, base: string, name: string): Promise<Buffer> {
  const path = join(dir, name)
  if (!existsSync(path)) {
    const res = await fetch(base + name)
    if (!res.ok) throw new Error(`${base + name}: HTTP ${res.status}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, Buffer.from(await res.arrayBuffer()))
  }
  return readFileSync(path)
}

export async function main(argv: string[]): Promise<Places> {
  const { values } = parseArgs({
    args: argv,
    options: { out: { type: 'string', default: 'public/search/places.json' }, cache: { type: 'string', default: 'node_modules/.cache' } },
  })
  const oa = join(values.cache, 'ourairports')
  const gn = join(values.cache, 'geonames')
  const airportsCsv = (await cached(oa, OURAIRPORTS, 'airports.csv')).toString('utf8')
  const countriesCsv = (await cached(oa, OURAIRPORTS, 'countries.csv')).toString('utf8')
  const admin1 = (await cached(gn, GEONAMES, 'admin1CodesASCII.txt')).toString('utf8')
  await cached(gn, GEONAMES, 'cities15000.zip')
  const citiesTsv = execFileSync('unzip', ['-p', join(gn, 'cities15000.zip'), 'cities15000.txt'], { maxBuffer: 64 << 20 }).toString('utf8')
  const places = buildPlaces(airportsCsv, countriesCsv, citiesTsv, admin1)
  mkdirSync(dirname(values.out), { recursive: true })
  // One row a line: small diffs when the sources change.
  const rows = (k: keyof Places): string => `"${k}":[\n${(places[k] as unknown[]).map((r) => JSON.stringify(r)).join(',\n')}\n]`
  writeFileSync(values.out, `{${(['countries', 'airports', 'regions', 'cities'] as const).map(rows).join(',\n')}}\n`)
  console.log(`${values.out}: ${places.countries.length} countries, ${places.airports.length} airports, ${places.cities.length} cities`)
  return places
}

if (import.meta.main) await main(process.argv.slice(2))

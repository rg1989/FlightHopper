// tools/build-airlines.ts
// Builds shared/airlines.json ({ICAO airline designator: name}) from the OpenFlights airline database.
//
//   node tools/build-airlines.ts [--out shared/airlines.json] [--cache node_modules/.cache/openflights]
//
// Source: https://openflights.org/data (airlines.dat), Open Database License 1.0; contents under the Database
// Contents License 1.0. Attribution: "Airline names: OpenFlights (ODbL)". airlines.dat (~400 KB) is downloaded once
// into --cache (under node_modules, so gitignored); delete the folder to refresh.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { parseCsv } from './build-airports.ts'

export const AIRLINES_DAT = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat'
const COLUMNS = 'id,name,alias,iata,icao,callsign,country,active'

/**
 * {ICAO designator: name} from airlines.dat text (no header row; \N = null).
 * Keeps rows with active === 'Y' and a 3-letter A–Z ICAO code; names are trimmed.
 * A code on several active rows goes to the lowest OpenFlights id (the original entry; later ids are user additions,
 * e.g. SWR: Swiss International Air Lines 4559 over Swissair 4560). Keys come back sorted.
 * ponytail: OpenFlights' active flag is unreliable for some defunct carriers, so a few stale names ship; the ceiling is
 * a wrong name on an old designator, and the upgrade path is a curated source (e.g. ICAO Doc 8585) when it matters.
 */
export function buildAirlines(dat: string): Record<string, string> {
  const best = new Map<string, { id: number; name: string }>()
  for (const r of parseCsv(`${COLUMNS}\n${dat}`)) {
    const name = r.name.trim()
    if (r.active !== 'Y' || !/^[A-Z]{3}$/.test(r.icao) || name === '' || name === '\\N') continue
    const id = Number(r.id)
    const prev = best.get(r.icao)
    if (!prev || id < prev.id) best.set(r.icao, { id, name })
  }
  return Object.fromEntries([...best].sort(([a], [b]) => (a < b ? -1 : 1)).map(([code, { name }]) => [code, name]))
}

/** JSON with one entry per line, so diffs of the committed file stay readable. */
export function formatAirlines(names: Record<string, string>): string {
  const lines = Object.entries(names).map(([code, name]) => `${JSON.stringify(code)}:${JSON.stringify(name)}`)
  return `{\n${lines.join(',\n')}\n}\n`
}

export async function main(argv: string[], fetchFn: typeof fetch = fetch): Promise<Record<string, string>> {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string', default: 'shared/airlines.json' },
      cache: { type: 'string', default: 'node_modules/.cache/openflights' },
    },
  })
  const cached = join(values.cache, 'airlines.dat')
  const fromCache = existsSync(cached)
  let dat: string
  if (fromCache) dat = readFileSync(cached, 'utf8')
  else {
    const res = await fetchFn(AIRLINES_DAT)
    if (!res.ok) throw new Error(`GET ${AIRLINES_DAT}: HTTP ${res.status}`)
    dat = await res.text()
  }
  const names = buildAirlines(dat)
  const n = Object.keys(names).length
  if (n === 0) throw new Error(`no airlines in ${fromCache ? cached : AIRLINES_DAT}`)
  if (!fromCache) {
    mkdirSync(values.cache, { recursive: true })
    writeFileSync(cached, dat)
  }
  const text = formatAirlines(names)
  mkdirSync(dirname(values.out), { recursive: true })
  writeFileSync(values.out, text)
  console.log(`wrote ${values.out}: ${n} airlines, ${Buffer.byteLength(text)} bytes`)
  return names
}

if (import.meta.main) await main(process.argv.slice(2))

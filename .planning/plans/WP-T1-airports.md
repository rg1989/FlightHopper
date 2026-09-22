# WP-T1 — Airports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn OurAirports' public-domain `airports.csv` and `runways.csv` into `public/airports/heroes.json`: the hero airports (KSFO, LLBG, LOWI) with their open paved runways, landing thresholds moved by their published displacement, and threshold heights on the WGS84 ellipsoid. Runways (V5), the datum check and census (T3) and the client (A2) all read this one file.

**Architecture:** One tool file, `tools/build-airports.ts`. `parseCsv` is a small RFC 4180 scanner: quoted fields, doubled quotes, embedded commas and newlines, CRLF, blank lines skipped, short rows padded with `''`. It returns one header-keyed object per row. `buildAirports` keeps runways with `closed === '0'`, all four end coordinates present and a surface that does not match `/GRASS|TURF/i`. For each end it takes `*_heading_degT` or, when blank, the bearing to the opposite end (`shared/geo.bearingDeg`). It moves the threshold along that heading by `*_displaced_threshold_ft` with `shared/geo.destination`, takes the end elevation or else the airport elevation, and sets `thrHaeM = round2(elevFt·0.3048 + geoidN(thrLat, thrLon))`. The airport gets `nM = round1(geoidN(lat, lon))`. Airports come back in the order of `idents`; an unknown ident throws. The CLI downloads the two CSVs once into `node_modules/.cache/ourairports/` (gitignored with `node_modules/`; delete the folder to refresh). It reads the hero list from `tools/heroes.json` and writes `public/airports/heroes.json` with `JSON.stringify(airports, null, 1)`. The download helper and the CLI take an injectable `fetch`, so every test runs offline.

**Tech Stack:** Node ≥ 24.2 (native TypeScript), `node:test`, TypeScript 7 (type-check only). Uses `shared/geo.ts` and `shared/geoid.ts` (`egm96-universal`) from WP-00. No new dependencies.

**Wave:** 1 (parallel; depends only on WP-00). **Estimated:** 1 h. **Validated:** every file below was run in a sandbox copy of the Wave 0 tree on 2026-09-22 (Node v25.2.1, TypeScript 7.0.2). `node --test tools/build-airports.test.ts` → 18/18 pass. `npx tsc --noEmit` reports nothing for `tools/build-airports*` (the whole sandbox type-checked clean). `node tools/build-airports.ts` ran against the OurAirports CSVs downloaded that day (`airports.csv` 12,728,446 B, `runways.csv` 3,965,119 B) and wrote a `public/airports/heroes.json` that `cmp` reports byte-identical to `data/fixtures/golden/airports-sample.json`. On the full files `parseCsv` agrees field for field with Python's `csv.DictReader`: 86,116 airport rows (158 with embedded quotes or newlines) and 48,252 runway rows, parsed in 164 ms and 97 ms.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints — they apply to every task here. The ones this package relies on:
- Tests never touch the network: the OurAirports rows the tests need are inline, and `cachedCsv` and `main` get a fake `fetch`. Only Task 3 downloads (two GETs, about 17 MB, once).
- Heights: `thrHaeM` is WGS84 ellipsoidal metres (`h = H + N`, N from `shared/geoid.ts`); `elevFt` stays MSL feet as published.
- Deviation from PLAN.md §4 T1 text: the cache is `node_modules/.cache/ourairports/`, not `data/cache/`. WP-00's `.gitignore` ignores `node_modules/` but not `data/cache/`, and this package may not edit `.gitignore`.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `tools/build-airports.ts` | `parseCsv`, `buildAirports`, `cachedCsv`, `main` + CLI |
| `tools/build-airports.test.ts` | RFC 4180 cases, golden-file match, runway filters, heading/elevation fallbacks, offline cache and CLI |
| `tools/heroes.json` | hero list `{ ident, role }[]` read by the CLI |
| `public/airports/heroes.json` | generated airport data for KSFO, LLBG, LOWI (committed) |

---

### Task 1: RFC 4180 CSV parser

**Files:**
- Create: `tools/build-airports.ts`, `tools/build-airports.test.ts`
- Test: `tools/build-airports.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `parseCsv(text: string): Record<string, string>[]` (header row = keys; blank lines skipped; missing trailing fields = `''`; throws on an unterminated quote)

- [ ] **Step 1: Write the failing test**

```ts
// tools/build-airports.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv } from './build-airports.ts'

test('parseCsv: header row becomes the keys; quoted and bare fields', () => {
  assert.deepEqual(parseCsv('"id","ident",elev\n1,"KSFO",13\n'), [{ id: '1', ident: 'KSFO', elev: '13' }])
})

test('parseCsv: embedded commas, doubled quotes and newlines inside quotes', () => {
  const rows = parseCsv('a,b,c\n"x, y","say ""hi""","line1\nline2"\n')
  assert.deepEqual(rows, [{ a: 'x, y', b: 'say "hi"', c: 'line1\nline2' }])
})

test('parseCsv: CRLF line ends, empty fields, no trailing newline', () => {
  assert.deepEqual(parseCsv('a,b,c\r\n1,,3\r\n,,\r\n4,5,6'), [
    { a: '1', b: '', c: '3' },
    { a: '', b: '', c: '' },
    { a: '4', b: '5', c: '6' },
  ])
})

test('parseCsv: CRLF inside a quoted field is kept verbatim', () => {
  assert.deepEqual(parseCsv('a,b\r\n"1\r\n2",3\r\n'), [{ a: '1\r\n2', b: '3' }])
})

test('parseCsv: blank lines are skipped; short rows fill with empty strings', () => {
  assert.deepEqual(parseCsv('a,b\n\n1\n\n'), [{ a: '1', b: '' }])
})

test('parseCsv: header only or empty text gives no rows', () => {
  assert.deepEqual(parseCsv('a,b\n'), [])
  assert.deepEqual(parseCsv(''), [])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tools/build-airports.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/tools/build-airports.ts'`, `ℹ fail 1`

- [ ] **Step 3: Write the implementation**

```ts
// tools/build-airports.ts
// Builds public/airports/heroes.json from OurAirports (public domain) + EGM96.

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
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tools/build-airports.test.ts`
Expected: PASS — `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0`

- [ ] **Step 5: Commit**

```bash
git add tools/build-airports.ts tools/build-airports.test.ts
git commit -m "feat(tools): RFC 4180 CSV parser for OurAirports" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: buildAirports, download cache and CLI

**Files:**
- Modify: `tools/build-airports.ts`, `tools/build-airports.test.ts`
- Create: `tools/heroes.json`
- Test: `tools/build-airports.test.ts`

**Interfaces:**
- Consumes: `Airport`, `RunwayEnd` (`shared/airports.ts`, WP-00) · `bearingDeg`, `destination`, `distanceNm` (`shared/geo.ts`, WP-00) · `geoidN` (`shared/geoid.ts`, WP-00) · `data/fixtures/golden/airports-sample.json` (WP-00)
- Produces: `buildAirports(airportsCsv: string, runwaysCsv: string, idents: string[]): Airport[]` (output in `idents` order; unknown ident throws; matches the golden file within 1e-6° and 0.05 m) · extra exports `cachedCsv(dir: string, name: string, fetchFn?: typeof fetch): Promise<string>` (reads `dir/name`, else GETs `https://davidmegginson.github.io/ourairports-data/<name>` and caches it; HTTP error throws and caches nothing) and `main(argv: string[], fetchFn?: typeof fetch): Promise<Airport[]>` · CLI `node tools/build-airports.ts [--heroes tools/heroes.json] [--out public/airports/heroes.json] [--cache node_modules/.cache/ourairports]` · `tools/heroes.json`: `{ ident: string; role: string }[]`

- [ ] **Step 1: Write the failing test** (replaces the Task 1 file; the six `parseCsv` tests are unchanged. The inline CSV rows are the real OurAirports rows for KSFO, LLBG and LOWI, copied on 2026-09-22, including LOWI's grass strip.)

```ts
// tools/build-airports.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bearingDeg, distanceNm } from '../shared/geo.ts'
import { geoidN } from '../shared/geoid.ts'
import type { Airport } from '../shared/airports.ts'
import { buildAirports, cachedCsv, main, parseCsv } from './build-airports.ts'

test('parseCsv: header row becomes the keys; quoted and bare fields', () => {
  assert.deepEqual(parseCsv('"id","ident",elev\n1,"KSFO",13\n'), [{ id: '1', ident: 'KSFO', elev: '13' }])
})

test('parseCsv: embedded commas, doubled quotes and newlines inside quotes', () => {
  const rows = parseCsv('a,b,c\n"x, y","say ""hi""","line1\nline2"\n')
  assert.deepEqual(rows, [{ a: 'x, y', b: 'say "hi"', c: 'line1\nline2' }])
})

test('parseCsv: CRLF line ends, empty fields, no trailing newline', () => {
  assert.deepEqual(parseCsv('a,b,c\r\n1,,3\r\n,,\r\n4,5,6'), [
    { a: '1', b: '', c: '3' },
    { a: '', b: '', c: '' },
    { a: '4', b: '5', c: '6' },
  ])
})

test('parseCsv: CRLF inside a quoted field is kept verbatim', () => {
  assert.deepEqual(parseCsv('a,b\r\n"1\r\n2",3\r\n'), [{ a: '1\r\n2', b: '3' }])
})

test('parseCsv: blank lines are skipped; short rows fill with empty strings', () => {
  assert.deepEqual(parseCsv('a,b\n\n1\n\n'), [{ a: '1', b: '' }])
})

test('parseCsv: header only or empty text gives no rows', () => {
  assert.deepEqual(parseCsv('a,b\n'), [])
  assert.deepEqual(parseCsv(''), [])
})

// Real OurAirports rows (public domain), copied from airports.csv / runways.csv on 2026-09-22.
const AIRPORTS_CSV = `"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country","iso_region","municipality","scheduled_service","icao_code","iata_code","gps_code","local_code","home_link","wikipedia_link","keywords"
3878,"KSFO","large_airport","San Francisco International Airport",37.619806,-122.374821,13,"NA","US","US-CA","San Francisco","yes","KSFO","SFO","KSFO","SFO","http://www.flysfo.com/","https://en.wikipedia.org/wiki/San_Francisco_International_Airport","QSF, QBA"
4411,"LLBG","large_airport","Ben Gurion International Airport",32.011398,34.8867,135,"AS","IL","IL-M","Tel Aviv","yes","LLBG","TLV","LLBG",,"http://www.iaa.gov.il/Rashat/en-US/Airports/BenGurion/","https://en.wikipedia.org/wiki/Ben_Gurion_International_Airport",
4431,"LOWI","large_airport","Innsbruck Airport",47.260201,11.344,1907,"EU","AT","AT-7","Innsbruck","yes","LOWI","INN","LOWI",,"http://www.innsbruck-airport.com/","https://en.wikipedia.org/wiki/Innsbruck_Airport","Kranebitten Airport"
`

const RUNWAYS_HEADER =
  '"id","airport_ref","airport_ident","length_ft","width_ft","surface","lighted","closed","le_ident","le_latitude_deg","le_longitude_deg","le_elevation_ft","le_heading_degT","le_displaced_threshold_ft","he_ident","he_latitude_deg","he_longitude_deg","he_elevation_ft","he_heading_degT","he_displaced_threshold_ft"'

const RUNWAYS_CSV = `${RUNWAYS_HEADER}
240772,3878,"KSFO",11870,200,"ASP",1,0,"10L",37.628742,-122.39341,5,118,,"28R",37.613538,-122.35716,13,298,300
240771,3878,"KSFO",11381,200,"ASP",1,0,"10R",37.626298,-122.393124,6,118,,"28L",37.61172,-122.358367,13,298,300
240770,3878,"KSFO",7650,200,"ASP",1,0,"1L",37.607898,-122.38295,10,28,645,"19R",37.626476,-122.37063,9,208,
240769,3878,"KSFO",8660,200,"ASP",1,0,"1R",37.606333,-122.381061,12,28,560,"19L",37.627346,-122.367124,10,208,
236953,4411,"LLBG",9094,197,"ASP",1,0,"03",31.9962158203125,34.88608169555664,129,29,,"21",32.018123626708984,34.90022659301758,134,209,
236954,4411,"LLBG",13327,148,"ASP",1,0,"08",32.01300048828125,34.86040115356445,97,80,,"26",32.01890182495117,34.89860153198242,124,260,1969
236955,4411,"LLBG",10209,148,"ASP",1,0,"12",32.01470184326172,34.86579895019531,112,121.4,,"30",31.999900817871094,34.89419937133789,130,301.4,246
233580,4431,"LOWI",6562,148,"ASP",1,0,"08",47.2588005065918,11.330900192260742,1907,81,339,"26",47.261600494384766,11.357000350952148,1894,261,
608401,4431,"LOWI",1148,155,"GRASS",0,0,"08G",47.261341,11.337495,,,,"28G",47.26183,11.34205,,,
`

const golden: Airport[] = JSON.parse(readFileSync(new URL('../data/fixtures/golden/airports-sample.json', import.meta.url), 'utf8'))

/** Deep compare: lat/lon-like keys within 1e-6°, other numbers within 0.05 (m or ft), everything else exact. */
function assertClose(actual: unknown, expected: unknown, path = '$'): void {
  if (typeof expected === 'number') {
    assert.equal(typeof actual, 'number', path)
    const tol = /(lat|lon)$/i.test(path) ? 1e-6 : 0.05
    assert.ok(Math.abs((actual as number) - expected) <= tol, `${path}: ${actual} vs ${expected}`)
  } else if (expected !== null && typeof expected === 'object') {
    assert.ok(actual !== null && typeof actual === 'object', path)
    assert.deepEqual(Object.keys(actual as object).sort(), Object.keys(expected).sort(), path)
    for (const [k, v] of Object.entries(expected)) assertClose((actual as Record<string, unknown>)[k], v, `${path}.${k}`)
  } else assert.equal(actual, expected, path)
}

test('buildAirports reproduces the golden KSFO / LLBG / LOWI file', () => {
  assertClose(buildAirports(AIRPORTS_CSV, RUNWAYS_CSV, ['KSFO', 'LLBG', 'LOWI']), golden)
})

test('output follows the order of idents', () => {
  assert.deepEqual(buildAirports(AIRPORTS_CSV, RUNWAYS_CSV, ['LOWI', 'KSFO']).map((a) => a.ident), ['LOWI', 'KSFO'])
})

test('grass runways are dropped (LOWI keeps only 08/26)', () => {
  const [lowi] = buildAirports(AIRPORTS_CSV, RUNWAYS_CSV, ['LOWI'])
  assert.deepEqual(lowi.runways.map((r) => r.ends.map((e) => e.ident)), [['08', '26']])
})

test('displaced threshold: moved along the landing heading by displacedFt', () => {
  const [ksfo] = buildAirports(AIRPORTS_CSV, RUNWAYS_CSV, ['KSFO'])
  const e28r = ksfo.runways[0].ends[1]
  assert.equal(e28r.ident, '28R')
  assert.equal(e28r.displacedFt, 300)
  assert.ok(Math.abs(distanceNm(e28r.lat, e28r.lon, e28r.thrLat, e28r.thrLon) * 1852 - 300 * 0.3048) < 0.01)
  assert.ok(Math.abs(bearingDeg(e28r.lat, e28r.lon, e28r.thrLat, e28r.thrLon) - 298) < 1e-6)
})

test('thrHaeM = elevFt·0.3048 + N at the threshold, rounded to cm; airport nM rounded to dm', () => {
  const [ksfo] = buildAirports(AIRPORTS_CSV, RUNWAYS_CSV, ['KSFO'])
  const e = ksfo.runways[2].ends[0] // 1L, 645 ft displaced
  assert.equal(e.thrHaeM, Math.round((e.elevFt * 0.3048 + geoidN(e.thrLat, e.thrLon)) * 100) / 100)
  assert.equal(ksfo.nM, Math.round(geoidN(ksfo.lat, ksfo.lon) * 10) / 10)
})

test('missing heading → bearing to the opposite end; missing end elevation → airport elevation', () => {
  const paved = `${RUNWAYS_HEADER}\n1,4431,"LOWI",1148,155,"ASP",0,0,"08G",47.261341,11.337495,,,,"28G",47.26183,11.34205,,,\n`
  const [lowi] = buildAirports(AIRPORTS_CSV, paved, ['LOWI'])
  const [le, he] = lowi.runways[0].ends
  assert.ok(Math.abs(le.hdgTrueDeg - bearingDeg(47.261341, 11.337495, 47.26183, 11.34205)) < 1e-9)
  assert.ok(Math.abs(he.hdgTrueDeg - bearingDeg(47.26183, 11.34205, 47.261341, 11.337495)) < 1e-9)
  assert.equal(le.elevFt, 1907)
  assert.equal(he.elevFt, 1907)
  assert.equal(le.displacedFt, 0)
})

test('closed runways, runways without both end coordinates, and turf are dropped', () => {
  const rows = `${RUNWAYS_HEADER}
1,4431,"LOWI",6562,148,"ASP",1,1,"08",47.2588,11.3309,1907,81,339,"26",47.2616,11.357,1894,261,
2,4431,"LOWI",6562,148,"ASP",1,0,"08",47.2588,11.3309,1907,81,339,"26",,,1894,261,
3,4431,"LOWI",6562,148,"Turf/Gravel",1,0,"08",47.2588,11.3309,1907,81,339,"26",47.2616,11.357,1894,261,
4,4431,"LOWI",6562,148,"ASP",1,0,"08",47.2588,11.3309,1907,81,339,"26",47.2616,11.357,1894,261,
`
  const [lowi] = buildAirports(AIRPORTS_CSV, rows, ['LOWI'])
  assert.equal(lowi.runways.length, 1)
  assert.equal(lowi.runways[0].surface, 'ASP')
})

test('unknown ident throws', () => {
  assert.throws(() => buildAirports(AIRPORTS_CSV, RUNWAYS_CSV, ['KXXX']), /KXXX/)
})

test('cachedCsv downloads once, then serves the cache without fetching', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'fh-oa-')), 'cache')
  const urls: string[] = []
  const fakeFetch = (async (url: string) => {
    urls.push(url)
    return new Response('a,b\n1,2\n')
  }) as typeof fetch
  assert.equal(await cachedCsv(dir, 'runways.csv', fakeFetch), 'a,b\n1,2\n')
  assert.deepEqual(urls, ['https://davidmegginson.github.io/ourairports-data/runways.csv'])
  assert.equal(await cachedCsv(dir, 'runways.csv', fakeFetch), 'a,b\n1,2\n')
  assert.equal(urls.length, 1)
})

test('cachedCsv throws on an HTTP error and caches nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fh-oa-'))
  const notFound = (async () => new Response('nope', { status: 404 })) as typeof fetch
  await assert.rejects(cachedCsv(dir, 'airports.csv', notFound), /HTTP 404/)
  await assert.rejects(cachedCsv(dir, 'airports.csv', notFound), /HTTP 404/)
})

test('CLI main: reads the heroes list, uses the cache, writes the airports file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fh-oa-'))
  writeFileSync(join(dir, 'airports.csv'), AIRPORTS_CSV)
  writeFileSync(join(dir, 'runways.csv'), RUNWAYS_CSV)
  writeFileSync(join(dir, 'heroes.json'), JSON.stringify([{ ident: 'KSFO', role: 'landing' }, { ident: 'LOWI', role: 'terrain' }]))
  const out = join(dir, 'out', 'heroes.json')
  const noNetwork = (async () => {
    throw new Error('network used')
  }) as typeof fetch
  const airports = await main(['--heroes', join(dir, 'heroes.json'), '--cache', dir, '--out', out], noNetwork)
  assert.deepEqual(airports.map((a) => a.ident), ['KSFO', 'LOWI'])
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), airports)
})

test('tools/heroes.json lists KSFO, LLBG, LOWI with a role each', () => {
  const heroes: { ident: string; role: string }[] = JSON.parse(readFileSync(new URL('./heroes.json', import.meta.url), 'utf8'))
  assert.deepEqual(heroes.map((h) => h.ident), ['KSFO', 'LLBG', 'LOWI'])
  assert.ok(heroes.every((h) => typeof h.role === 'string' && h.role.length > 0))
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tools/build-airports.test.ts`
Expected: FAIL — `SyntaxError: The requested module './build-airports.ts' does not provide an export named 'buildAirports'`, `ℹ fail 1`

- [ ] **Step 3: Write the implementation and the hero list**

```ts
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
```

File: `tools/heroes.json`

```json
[
  { "ident": "KSFO", "role": "landing hero; datum gate (EGM96 N -32 m)" },
  { "ident": "LLBG", "role": "local landing hero near the receiver; datum gate (EGM96 N +20 m)" },
  { "ident": "LOWI", "role": "terrain showcase (Inn valley approach)" }
]
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tools/build-airports.test.ts`
Expected: PASS — `ℹ tests 18`, `ℹ pass 18`, `ℹ fail 0`

- [ ] **Step 5: Commit**

```bash
git add tools/build-airports.ts tools/build-airports.test.ts tools/heroes.json
git commit -m "feat(tools): build hero airports from OurAirports + EGM96" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Generate and commit `public/airports/heroes.json`

**Files:**
- Create: `public/airports/heroes.json`

**Interfaces:**
- Consumes: the CLI from Task 2; network: two GETs to `davidmegginson.github.io` (about 17 MB, once; later runs use the cache)
- Produces: `public/airports/heroes.json` — `Airport[]` for KSFO (4 runways), LLBG (3), LOWI (1), served by Vite at `/airports/heroes.json`, read by WP-V5, WP-T3's CLIs and WP-A2

- [ ] **Step 1: Run the builder**

Run: `node tools/build-airports.ts`
Expected:

```
KSFO  San Francisco International Airport: 4 runways, N -32.3 m
LLBG  Ben Gurion International Airport: 3 runways, N 19.7 m
LOWI  Innsbruck Airport: 1 runways, N 48.4 m
wrote public/airports/heroes.json
```

- [ ] **Step 2: Verify it equals the golden fixture**

Run: `cmp public/airports/heroes.json data/fixtures/golden/airports-sample.json && echo identical`
Expected: `identical`. The committed file is exactly the content below. If `cmp` reports a difference, OurAirports has edited a hero row since 2026-09-22. Write the content below instead (the reviewed build, equal to the golden fixture) and name the upstream change in the commit body. Refreshing the hero data is a separate, deliberate change, because the golden fixture pins it.

File: `public/airports/heroes.json`

```json
[
 {
  "ident": "KSFO",
  "name": "San Francisco International Airport",
  "lat": 37.619806,
  "lon": -122.374821,
  "elevFt": 13,
  "nM": -32.3,
  "runways": [
   {
    "lengthFt": 11870,
    "widthFt": 200,
    "surface": "ASP",
    "ends": [
     {
      "ident": "10L",
      "lat": 37.628742,
      "lon": -122.39341,
      "thrLat": 37.62874200000001,
      "thrLon": -122.39341000000002,
      "displacedFt": 0,
      "elevFt": 5,
      "hdgTrueDeg": 118,
      "thrHaeM": -30.79
     },
     {
      "ident": "28R",
      "lat": 37.613538,
      "lon": -122.35716,
      "thrLat": 37.61392406152527,
      "thrLon": -122.35807660762543,
      "displacedFt": 300,
      "elevFt": 13,
      "hdgTrueDeg": 298,
      "thrHaeM": -28.3
     }
    ]
   },
   {
    "lengthFt": 11381,
    "widthFt": 200,
    "surface": "ASP",
    "ends": [
     {
      "ident": "10R",
      "lat": 37.626298,
      "lon": -122.393124,
      "thrLat": 37.626298000000006,
      "thrLon": -122.393124,
      "displacedFt": 0,
      "elevFt": 6,
      "hdgTrueDeg": 118,
      "thrHaeM": -30.49
     },
     {
      "ident": "28L",
      "lat": 37.61172,
      "lon": -122.358367,
      "thrLat": 37.612106061525516,
      "thrLon": -122.35928358521744,
      "displacedFt": 300,
      "elevFt": 13,
      "hdgTrueDeg": 298,
      "thrHaeM": -28.3
     }
    ]
   },
   {
    "lengthFt": 7650,
    "widthFt": 200,
    "surface": "ASP",
    "ends": [
     {
      "ident": "1L",
      "lat": 37.607898,
      "lon": -122.38295,
      "thrLat": 37.60945907337661,
      "thrLon": -122.38190221973213,
      "displacedFt": 645,
      "elevFt": 10,
      "hdgTrueDeg": 28,
      "thrHaeM": -29.26
     },
     {
      "ident": "19R",
      "lat": 37.626476,
      "lon": -122.37063,
      "thrLat": 37.626476,
      "thrLon": -122.37063,
      "displacedFt": 0,
      "elevFt": 9,
      "hdgTrueDeg": 208,
      "thrHaeM": -29.53
     }
    ]
   },
   {
    "lengthFt": 8660,
    "widthFt": 200,
    "surface": "ASP",
    "ends": [
     {
      "ident": "1R",
      "lat": 37.606333,
      "lon": -122.381061,
      "thrLat": 37.60768835105868,
      "thrLon": -122.38015132095961,
      "displacedFt": 560,
      "elevFt": 12,
      "hdgTrueDeg": 28,
      "thrHaeM": -28.65
     },
     {
      "ident": "19L",
      "lat": 37.627346,
      "lon": -122.367124,
      "thrLat": 37.627346,
      "thrLon": -122.36712399999999,
      "displacedFt": 0,
      "elevFt": 10,
      "hdgTrueDeg": 208,
      "thrHaeM": -29.22
     }
    ]
   }
  ]
 },
 {
  "ident": "LLBG",
  "name": "Ben Gurion International Airport",
  "lat": 32.011398,
  "lon": 34.8867,
  "elevFt": 135,
  "nM": 19.7,
  "runways": [
   {
    "lengthFt": 9094,
    "widthFt": 197,
    "surface": "ASP",
    "ends": [
     {
      "ident": "03",
      "lat": 31.9962158203125,
      "lon": 34.88608169555664,
      "thrLat": 31.99621582031251,
      "thrLon": 34.88608169555664,
      "displacedFt": 0,
      "elevFt": 129,
      "hdgTrueDeg": 29,
      "thrHaeM": 59.02
     },
     {
      "ident": "21",
      "lat": 32.018123626708984,
      "lon": 34.90022659301758,
      "thrLat": 32.01812362670899,
      "thrLon": 34.90022659301758,
      "displacedFt": 0,
      "elevFt": 134,
      "hdgTrueDeg": 209,
      "thrHaeM": 60.62
     }
    ]
   },
   {
    "lengthFt": 13327,
    "widthFt": 148,
    "surface": "ASP",
    "ends": [
     {
      "ident": "08",
      "lat": 32.01300048828125,
      "lon": 34.86040115356445,
      "thrLat": 32.01300048828124,
      "thrLon": 34.86040115356445,
      "displacedFt": 0,
      "elevFt": 97,
      "hdgTrueDeg": 80,
      "thrHaeM": 49.14
     },
     {
      "ident": "26",
      "lat": 32.01890182495117,
      "lon": 34.89860153198242,
      "thrLat": 32.017964441366175,
      "thrLon": 34.892332625764766,
      "displacedFt": 1969,
      "elevFt": 124,
      "hdgTrueDeg": 260,
      "thrHaeM": 57.53
     }
    ]
   },
   {
    "lengthFt": 10209,
    "widthFt": 148,
    "surface": "ASP",
    "ends": [
     {
      "ident": "12",
      "lat": 32.01470184326172,
      "lon": 34.86579895019531,
      "thrLat": 32.014701843261726,
      "thrLon": 34.86579895019531,
      "displacedFt": 0,
      "elevFt": 112,
      "hdgTrueDeg": 121.4,
      "thrHaeM": 53.74
     },
     {
      "ident": "30",
      "lat": 31.999900817871094,
      "lon": 34.89419937133789,
      "thrLat": 32.000252142495185,
      "thrLon": 34.89352067554944,
      "displacedFt": 246,
      "elevFt": 130,
      "hdgTrueDeg": 301.4,
      "thrHaeM": 59.37
     }
    ]
   }
  ]
 },
 {
  "ident": "LOWI",
  "name": "Innsbruck Airport",
  "lat": 47.260201,
  "lon": 11.344,
  "elevFt": 1907,
  "nM": 48.4,
  "runways": [
   {
    "lengthFt": 6562,
    "widthFt": 148,
    "surface": "ASP",
    "ends": [
     {
      "ident": "08",
      "lat": 47.2588005065918,
      "lon": 11.330900192260742,
      "thrLat": 47.258945864390505,
      "thrLon": 11.332252515916366,
      "displacedFt": 339,
      "elevFt": 1907,
      "hdgTrueDeg": 81,
      "thrHaeM": 629.72
     },
     {
      "ident": "26",
      "lat": 47.261600494384766,
      "lon": 11.357000350952148,
      "thrLat": 47.26160049438477,
      "thrLon": 11.357000350952148,
      "displacedFt": 0,
      "elevFt": 1894,
      "hdgTrueDeg": 261,
      "thrHaeM": 625.72
     }
    ]
   }
  ]
 }
]
```

- [ ] **Step 3: Commit**

```bash
git add public/airports/heroes.json
git commit -m "feat(data): hero airports KSFO, LLBG, LOWI (OurAirports, EGM96 threshold heights)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: WP gate

- [ ] **Step 1: Run every test this package owns**

Run: `node --test tools/build-airports.test.ts`
Expected: `ℹ tests 18`, `ℹ pass 18`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'tools/build-airports'`
Expected: no output (grep exits 1). On a branch where every merged package is complete, `npm run check` must also pass.

- [ ] **Step 3: Confirm everything is committed and record the gate**

```bash
git status --short -- tools public
git commit --allow-empty -m "chore(tools): WP-T1 gate passed (18 tests, tsc clean)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `git status` prints nothing before the commit. The branch `wp/T1` is ready to merge.

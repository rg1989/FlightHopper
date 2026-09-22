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

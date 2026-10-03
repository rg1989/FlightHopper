// server/wx.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODEL_VARIABLES } from '../shared/wx.ts'
import { WxError, makeWx, modelGeo, modelPlaces, modelUrl, parseBbox } from './wx.ts'

const METARS = [
  { icaoId: 'LLBG', lat: 32.01, lon: 34.87, elev: 35, fltCat: 'MVFR', wdir: 290, wspd: 12, wgst: 22, rawOb: 'METAR LLBG …' },
  { icaoId: 'OJAM', lat: 31.97, lon: 35.99, fltCat: 'VFR', wdir: 'VRB', wspd: 3, rawOb: 'METAR OJAM …' },
  { icaoId: 'XXXX', lat: null, lon: 1 }, // no position: dropped
]

test('parseBbox: south,west,north,east to whole degrees outward; bad, inverted, out of range or too wide → 400', () => {
  assert.deepEqual(parseBbox('29.5,34.2,33.1,35.9'), [29, 34, 34, 36])
  for (const bad of [null, '', '1,2,3', 'a,b,c,d', '1,2,3,4,5', '10,0,5,5', '-91,0,0,1', '0,0,41,1', '0,-180,1,-100']) {
    assert.throws(() => parseBbox(bad), (e: unknown) => e instanceof WxError && e.status === 400, String(bad))
  }
})

test('metars: slimmed, one upstream request per box and TTL (concurrent asks share it), stale served when upstream fails', async () => {
  let now = 0
  const asked: string[] = []
  let fail = false
  const fetchFn = (async (url: string) => {
    asked.push(url)
    if (fail) throw new Error('down')
    await Promise.resolve()
    return new Response(JSON.stringify(METARS))
  }) as unknown as typeof fetch
  const wx = makeWx({ userAgent: 'test', fetchFn, nowMs: () => now })
  const [a, b] = await Promise.all([wx.metars('29.5,34.2,33.1,35.9'), wx.metars('29.1,34.9,33.9,35.1')]) // same whole-degree box
  assert.equal(asked.length, 1)
  assert.equal(asked[0], 'https://aviationweather.gov/api/data/metar?bbox=29,34,34,36&format=json')
  assert.deepEqual(a, b)
  const lacking = { name: null, elevM: null, obsMs: null, visKm: null, visPlus: false, tempC: null, dewC: null, qnhHpa: null, wx: null, clouds: [], vertVisFt: null }
  assert.deepEqual(a, [
    { id: 'LLBG', lat: 32.01, lon: 34.87, cat: 'MVFR', wdir: 290, wspd: 12, wgst: 22, raw: 'METAR LLBG …', ...lacking, elevM: 35 },
    { id: 'OJAM', lat: 31.97, lon: 35.99, cat: 'VFR', wdir: null, wspd: 3, wgst: null, raw: 'METAR OJAM …', ...lacking },
  ])
  now = 6 * 60_000 // past the TTL, upstream down: the last good answer
  fail = true
  assert.deepEqual(await wx.metars('29,34,34,36'), a)
  assert.equal(asked.length, 2)
  await assert.rejects(wx.metars('0,0,1,1'), (e: unknown) => e instanceof WxError && e.status === 502) // nothing to fall back on
})

test('sigmets: polygons and multipolygons kept with hazard, levels and expiry; points dropped', async () => {
  const geo = {
    features: [
      { properties: { hazard: 'TS', qualifier: 'EMBD', top: 35000, validTimeTo: '2026-09-30T02:00:00Z', rawSigmet: 'S1' },
        geometry: { type: 'Polygon', coordinates: [[[15, -34], [15, -37], [21, -37], [15, -34]]] } },
      { properties: { hazard: 'VA' }, geometry: { type: 'Point', coordinates: [1, 2] } },
      { properties: { hazard: 'TURB', base: 0, top: 5500 },
        geometry: { type: 'MultiPolygon', coordinates: [[[[1, 1], [2, 1], [2, 2]]], [[[5, 5], [6, 5], [6, 6]]]] } },
    ],
  }
  const wx = makeWx({ userAgent: 't', fetchFn: (async () => new Response(JSON.stringify(geo))) as unknown as typeof fetch })
  const s = await wx.sigmets()
  assert.equal(s.length, 2)
  assert.deepEqual(s[0], { hazard: 'TS', qualifier: 'EMBD', base: null, top: 35000, until: '2026-09-30T02:00:00Z', raw: 'S1', rings: [[[15, -34], [15, -37], [21, -37], [15, -34]]] })
  assert.equal(s[1].rings.length, 2)
})

// ---- the model ---------------------------------------------------------------------------------------------------------------

const rows = (url: string, name: 'latitude' | 'longitude'): number[] => new URL(url).searchParams.get(name)!.split(',').map(Number)

test('modelGeo: the 0.5° cell that holds the place; a grid of 7 × 7 places 0.25° apart round its middle, the same for every place of the cell', () => {
  assert.deepEqual(modelGeo('32.1', '34.9'), { lat0: 31.5, lon0: 34, step: 0.25, n: 7 }, 'cell 32 to 32.5 north (middle 32.25), 34.5 to 35 east (34.75)')
  assert.deepEqual(modelGeo('32.4999', '34.5'), modelGeo('32.0', '34.9999'))
  assert.deepEqual(modelGeo('32.5', '35'), { lat0: 32, lon0: 34.5, step: 0.25, n: 7 }, 'the next cell begins on its edge')
  assert.deepEqual(modelGeo('-0.1', '-122.4'), { lat0: -1, lon0: -123, step: 0.25, n: 7 }, 'south and west: the cell is the one below the place, not the one nearer zero')
  assert.deepEqual(modelGeo(' 32.1 ', ' 34.9 '), modelGeo('32.1', '34.9'))
  assert.deepEqual(modelGeo('32.1', '1e1'), { lat0: 31.5, lon0: 9.5, step: 0.25, n: 7 }, 'a number as JavaScript reads it')
})

test('modelGeo: at a pole the grid ends at it (the model has no places beyond); across the antimeridian it runs on past 180', () => {
  assert.equal(modelGeo('90', '0').lat0, 88.5, 'the grid reaches 90.0')
  assert.equal(modelGeo('89.9', '0').lat0, 88.5)
  assert.equal(modelGeo('-90', '0').lat0, -90)
  assert.equal(modelGeo('-89.9', '0').lat0, -90)
  assert.equal(modelGeo('89.2', '0').lat0, 88.5, 'cell 89 to 89.5: its middle 89.25 is the last that fits')
  assert.equal(modelGeo('0', '179.9').lon0, 179, 'cell 179.5 to 180: places 179 … 180.5')
  assert.equal(modelGeo('0', '180').lon0, 179.5, '180 is −180: cell −180 to −179.5, places −180.5 … −179, written from 179.5')
  assert.equal(modelGeo('0', '-180').lon0, 179.5)
  assert.equal(modelGeo('0', '-179.9').lon0, 179.5)
})

test('modelGeo: not a place → 400', () => {
  for (const [lat, lon] of [[null, '1'], ['1', null], ['', '1'], ['1', ' '], ['abc', '1'], ['1', 'x'], ['91', '0'], ['-90.1', '0'], ['0', '180.1'], ['0', '-181'], ['NaN', '0'], ['Infinity', '0'], ['0', '-Infinity']] as const) {
    assert.throws(() => modelGeo(lat, lon), (e: unknown) => e instanceof WxError && e.status === 400, `${lat}, ${lon}`)
  }
})

test('modelPlaces: the places of a grid row by row from its south-west, a key for each that is the same in every grid that holds it', () => {
  const places = modelPlaces(modelGeo('32.1', '34.9'))
  assert.equal(places.length, 49)
  assert.deepEqual(places.slice(0, 8).map((p) => [p.lat, p.lon]), [[31.5, 34], [31.5, 34.25], [31.5, 34.5], [31.5, 34.75], [31.5, 35], [31.5, 35.25], [31.5, 35.5], [31.75, 34]], 'rows go north, columns east')
  assert.deepEqual([places[48].lat, places[48].lon], [33, 35.5])
  assert.equal(places[0].key, '31.5,34')
  assert.equal(new Set(places.map((p) => p.key)).size, 49)
  const north = modelPlaces(modelGeo('32.6', '34.9')) // the next cell north: two rows on
  assert.deepEqual(north.slice(0, 35).map((p) => p.key), places.slice(14).map((p) => p.key), 'five rows of it are five rows of the first')
  const across = modelPlaces(modelGeo('10', '180'))
  assert.deepEqual(across.slice(0, 7).map((p) => p.lon), [179.5, 179.75, -180, -179.75, -179.5, -179.25, -179], 'across the antimeridian: within −180 … 180, 180 itself as −180')
  assert.equal(across[2].key, '9.5,-180')
  assert.ok(modelPlaces(modelGeo('90', '10')).every((p) => p.lat >= 88.5 && p.lat <= 90))
})

test('modelUrl: Open-Meteo\'s forecast for the places given, in their order: the levels asked for, the current hour, the wind in knots', () => {
  const places = modelPlaces(modelGeo('32.1', '34.9'))
  const url = modelUrl(places)
  const u = new URL(url)
  assert.equal(`${u.origin}${u.pathname}`, 'https://api.open-meteo.com/v1/forecast')
  const [lats, lons] = [rows(url, 'latitude'), rows(url, 'longitude')]
  assert.deepEqual(lats, places.map((p) => p.lat))
  assert.deepEqual(lons, places.map((p) => p.lon))
  assert.equal(u.searchParams.get('hourly'), MODEL_VARIABLES.join(','))
  assert.equal(u.searchParams.get('hourly'), 'cloud_cover_1000hPa,cloud_cover_925hPa,cloud_cover_850hPa,cloud_cover_700hPa,cloud_cover_600hPa,cloud_cover_500hPa,cloud_cover_400hPa,cloud_cover_300hPa,cloud_cover_250hPa,cloud_cover_200hPa,'
    + 'geopotential_height_1000hPa,geopotential_height_925hPa,geopotential_height_850hPa,geopotential_height_700hPa,geopotential_height_600hPa,geopotential_height_500hPa,geopotential_height_400hPa,geopotential_height_300hPa,geopotential_height_250hPa,geopotential_height_200hPa,'
    + 'wind_speed_850hPa,wind_speed_700hPa,wind_speed_500hPa,wind_speed_300hPa,wind_speed_250hPa,wind_speed_200hPa,wind_direction_850hPa,wind_direction_700hPa,wind_direction_500hPa,wind_direction_300hPa,wind_direction_250hPa,wind_direction_200hPa')
  assert.equal(u.searchParams.get('wind_speed_unit'), 'kn')
  assert.equal(u.searchParams.get('forecast_hours'), '1', 'the current hour')
  assert.equal(u.searchParams.get('timeformat'), 'unixtime')
  assert.deepEqual([...u.searchParams.keys()], ['latitude', 'longitude', 'hourly', 'wind_speed_unit', 'forecast_hours', 'timeformat'])
  assert.ok(url.length < 2000, `${url.length} characters: a URL a server takes`)
  assert.deepEqual(rows(modelUrl([{ lat: 33.25, lon: -179.5 }]), 'latitude'), [33.25], 'one place')
  assert.deepEqual(rows(modelUrl([{ lat: 33.25, lon: -179.5 }, { lat: 1, lon: 2 }]), 'longitude'), [-179.5, 2])
})

// A fake Open-Meteo: every place answered from where it is (its 700 hPa cloud cover from COVER) and by which ask it came in (its ground
// height: 1 for the first ask, 2 for the second …); one place comes as the object, many as an array. It records what it was asked.
const T0 = Date.UTC(2026, 9, 3, 10, 0, 0) // a clock for the tests: 10:00 UTC
const HOUR_S = Date.UTC(2026, 9, 3, 10, 0, 0) / 1000
const MIN = 60_000
const COVER = (lat: number, lon: number): number => Math.round((lat + 90) * 4 + (lon + 180) * 4) % 100
interface Ask { url: string; ua: string; places: [number, number][] }
function upstream() {
  const asks: Ask[] = []
  const state = { how: 'ok' as 'ok' | 'down' | 'http' | 'error' | 'short' }
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const q = new URL(url).searchParams
    const lats = q.get('latitude')!.split(',').map(Number)
    const lons = q.get('longitude')!.split(',').map(Number)
    asks.push({ url, ua: (init?.headers as Record<string, string>)['user-agent'], places: lats.map((la, i) => [la, lons[i]]) })
    await Promise.resolve()
    if (state.how === 'down') throw new Error('offline')
    if (state.how === 'http') return new Response('{"error":true,"reason":"Too many requests"}', { status: 429 })
    if (state.how === 'error') return new Response('{"error":true,"reason":"Latitude must be in range of -90 to 90°."}')
    const answers = lats.map((la, i) => ({ latitude: la, longitude: lons[i], elevation: asks.length, hourly: { time: [HOUR_S], cloud_cover_700hPa: [COVER(la, lons[i])] } }))
    if (state.how === 'short') return new Response(JSON.stringify(answers.slice(1)))
    return new Response(JSON.stringify(answers.length === 1 ? answers[0] : answers))
  }) as unknown as typeof fetch
  return { asks, state, fetchFn }
}
const gridPlaces = (g: { lat0: number; lon0: number; step: number; n: number }): [number, number][] => modelPlaces(g).map((p) => [p.lat, p.lon])
const lattice = (lats: number[], lons: number[]): [number, number][] => lats.flatMap((la) => lons.map((lo): [number, number] => [la, lo]))
const LONS = [34, 34.25, 34.5, 34.75, 35, 35.25, 35.5]
const askedFor = (a: Ask): string => `${a.places.length}: ${a.places[0]} … ${a.places.at(-1)}`

test('model: one request to Open-Meteo for the 49 places of a cell, slimmed to the grid, each place the answer for where it stands; two clients in one cell at once share it', async () => {
  const up = upstream()
  const wx = makeWx({ userAgent: 'test ua', fetchFn: up.fetchFn, nowMs: () => T0 })
  const [a, b] = await Promise.all([wx.model('32.1', '34.9'), wx.model('32.45', '34.55')])
  assert.equal(up.asks.length, 1)
  assert.equal(up.asks[0].url, modelUrl(modelPlaces(modelGeo('32.1', '34.9'))))
  assert.equal(up.asks[0].ua, 'test ua')
  assert.deepEqual(a, b)
  assert.deepEqual([a.lat0, a.lon0, a.step, a.n, a.timeMs], [31.5, 34, 0.25, 7, HOUR_S * 1000])
  assert.ok(a.elevM.every((e) => e === 1))
  assert.equal(a.clouds[3].hPa, 700)
  gridPlaces(a).forEach(([la, lo], i) => assert.equal(a.clouds[3].cover[i], COVER(la, lo), `place ${i} is the answer for ${la}, ${lo}`))
  assert.deepEqual(await wx.model('32.0', '34.5'), a)
  assert.equal(up.asks.length, 1, 'the same cell again: no request')
})

test('model: cells next to each other share places: a cell asks Open-Meteo only for the places it lacks, in one request, and the shared places keep what they had', async () => {
  let now = T0
  const up = upstream()
  const wx = makeWx({ userAgent: 't', fetchFn: up.fetchFn, nowMs: () => now })
  await wx.model('32.1', '34.9') // places 31.5 … 33 N, 34 … 35.5 E
  now += 25_000
  const north = await wx.model('32.6', '34.9') // 32 … 33.5 N: two rows more
  assert.deepEqual(up.asks[1].places, lattice([33.25, 33.5], LONS), askedFor(up.asks[1]))
  north.elevM.forEach((e, i) => assert.equal(e, north.lat0 + Math.floor(i / 7) * 0.25 > 33 ? 2 : 1, `place ${i}: the ask it came in`))
  gridPlaces(north).forEach(([la, lo], i) => assert.equal(north.clouds[3].cover[i], COVER(la, lo)))
  now += 25_000
  const east = await wx.model('32.1', '35.1') // 31.5 … 33 N, 34.5 … 36 E: two columns more
  assert.deepEqual(up.asks[2].places, lattice([31.5, 31.75, 32, 32.25, 32.5, 32.75, 33], [35.75, 36]), askedFor(up.asks[2]))
  east.elevM.forEach((e, i) => assert.equal(e, east.lon0 + (i % 7) * 0.25 > 35.5 ? 3 : 1))
  now += 25_000
  const diagonal = await wx.model('32.6', '35.1') // 32 … 33.5 N, 34.5 … 36 E: 25 places of the first, 10 of the second, 10 of the third
  assert.deepEqual(up.asks[3].places, lattice([33.25, 33.5], [35.75, 36]), `${askedFor(up.asks[3])}: the corner no cell of the three had`)
  assert.equal(diagonal.elevM.filter((e) => e === 4).length, 4)
  assert.equal(diagonal.elevM.filter((e) => e === 1).length, 25, 'the 5 × 5 of the first')
  now += 25_000
  await wx.model('32.1', '34.9')
  await wx.model('32.6', '34.9')
  assert.equal(up.asks.length, 4, 'the first two cells again: every place of them is held')
})

test('model: a place is kept 30 min from when it was fetched, on its own: a cell asks only for the places that have run out', async () => {
  let now = T0
  const up = upstream()
  const wx = makeWx({ userAgent: 't', fetchFn: up.fetchFn, nowMs: () => now })
  await wx.model('32.1', '34.9') // all 49 at 0 min
  now = T0 + 25 * MIN
  await wx.model('32.6', '34.9') // 14 more at 25 min
  now = T0 + 29 * MIN + 59_000
  await wx.model('32.6', '34.9')
  assert.equal(up.asks.length, 2, 'not yet: 30 min from 0')
  now = T0 + 30 * MIN
  const north = await wx.model('32.6', '34.9')
  assert.equal(up.asks.length, 3)
  assert.deepEqual(up.asks[2].places, gridPlaces(north).slice(0, 35), 'the 35 it shares with the first cell, fetched at 0 min: the 14 of 25 min are not asked for again')
  now = T0 + 55 * MIN
  await wx.model('32.6', '34.9')
  assert.deepEqual(up.asks[3].places, gridPlaces(north).slice(35), 'and 30 min after 25: the 14')
})

test('model: at most 8,000 weighted calls a UTC day (a place counts 3.2: 32 variables a place): 51 grids; then what is held is served as it is, a cell not held is a 503 with Retry-After until the day turns', async () => {
  let now = T0
  const up = upstream()
  const wx = makeWx({ userAgent: 't', fetchFn: up.fetchFn, nowMs: () => now })
  const cell = (k: number): [string, string] => [String(-62 + 2 * k), '10'] // 2° apart: no place in two cells
  for (let k = 0; k < 51; k++) {
    now += 21_000
    await wx.model(...cell(k))
  }
  assert.equal(up.asks.length, 51, '51 × 49 × 3.2 = 7,996.8 calls')
  now += 21_000
  await assert.rejects(wx.model(...cell(51)), (e: unknown) => {
    const secondsToMidnight = Math.ceil((Date.UTC(2026, 9, 4) - now) / 1000)
    return e instanceof WxError && e.status === 503 && e.retryAfterS === secondsToMidnight && /allowance/.test(e.message)
  })
  assert.equal(up.asks.length, 51, 'the 52nd would pass 8,000: not asked')
  now += 31 * MIN
  const stale = await wx.model(...cell(0))
  assert.ok(stale.elevM.every((e) => e === 1) && up.asks.length === 51, 'a cell held, run out: served as it is, nothing asked')
  await assert.rejects(wx.model(...cell(52)), (e: unknown) => e instanceof WxError && e.status === 503)
  now = Date.UTC(2026, 9, 4, 0, 0, 1)
  const fresh = await wx.model(...cell(51))
  assert.equal(up.asks.length, 52, 'a new day: asked')
  assert.ok(fresh.elevM.every((e) => e === 52))
  now += 21_000
  const again = await wx.model(...cell(0))
  assert.equal(up.asks.length, 53, 'and the cell that had run out is fetched again')
  assert.ok(again.elevM.every((e) => e === 53))
})

test('model: a jet\'s cells, 0.5° on at each step, cost 14 places (44.8 calls) each after the first: 176 of them in a day, not 51', async () => {
  let now = T0
  const up = upstream()
  const wx = makeWx({ userAgent: 't', fetchFn: up.fetchFn, nowMs: () => now })
  // 156.8 for the first cell, 44.8 for each of the next 175: 7,996.8 calls
  let asked = 0
  for (let k = 0; k < 176; k++) {
    now += 21_000
    await wx.model(String(0.1 + 0.5 * k), '10')
    asked = up.asks.length
  }
  assert.equal(asked, 176, 'every step asked, every one within the day\'s calls (156.8 + 175 × 44.8 = 7,996.8)')
  assert.ok(up.asks.slice(1).every((a) => a.places.length === 14))
  now += 21_000
  await assert.rejects(wx.model(String(0.1 + 0.5 * 176), '10'), (e: unknown) => e instanceof WxError && e.status === 503)
})

test('model: at least 20 s between requests to Open-Meteo: a cell that needs one sooner is served from what is held (old is fine), else it is a 503 with Retry-After for the rest of the 20 s', async () => {
  let now = T0
  const up = upstream()
  const wx = makeWx({ userAgent: 't', fetchFn: up.fetchFn, nowMs: () => now })
  await wx.model('10', '10')
  now += 5_000
  await assert.rejects(wx.model('40', '10'), (e: unknown) => e instanceof WxError && e.status === 503 && e.retryAfterS === 15 && /20 s/.test(e.message))
  assert.equal(up.asks.length, 1)
  now += 15_000
  await wx.model('40', '10')
  assert.equal(up.asks.length, 2, 'after 20 s')
  now = T0 + 30 * MIN + 21_000
  await wx.model('10', '10') // the first cell has run out: asked at 30 min 21 s
  assert.equal(up.asks.length, 3)
  now += 4_000
  const stale = await wx.model('40', '10') // the second has run out (30 min 20 s), but the last ask was 4 s ago
  assert.equal(up.asks.length, 3, 'not asked: too soon')
  assert.ok(stale.elevM.every((e) => e === 2), 'served as it was')
})

test('model: a failure is remembered for 60 s: Open-Meteo is not asked again meanwhile, what is held is served even if old, a cell not held is a 503 with Retry-After; then it asks again', async () => {
  let now = T0
  const up = upstream()
  const wx = makeWx({ userAgent: 't', fetchFn: up.fetchFn, nowMs: () => now })
  up.state.how = 'down'
  await assert.rejects(wx.model('10', '10'), (e: unknown) => e instanceof WxError && e.status === 502 && /^api\.open-meteo\.com: offline/.test(e.message))
  assert.equal(up.asks.length, 1)
  now += 30_000
  await assert.rejects(wx.model('10', '10'), (e: unknown) => e instanceof WxError && e.status === 503 && e.retryAfterS === 30 && /failed/.test(e.message))
  assert.equal(up.asks.length, 1, 'remembered: not asked again')
  now += 30_000
  await assert.rejects(wx.model('10', '10'), (e: unknown) => e instanceof WxError && e.status === 502)
  assert.equal(up.asks.length, 2, 'after 60 s exactly: asked, and it failed again')
  up.state.how = 'ok'
  now += 61_000
  const grid = await wx.model('10', '10')
  assert.equal(up.asks.length, 3)
  assert.ok(grid.elevM.every((e) => e === 3))
  // a failure with places held: the old places are served, a cell with places not held is not
  now += 31 * MIN
  up.state.how = 'down'
  const old = await wx.model('10', '10')
  assert.deepEqual(old, grid, 'every place held, run out, Open-Meteo down: as it was')
  assert.equal(up.asks.length, 4, 'it tried once')
  now += 10_000
  assert.deepEqual(await wx.model('10', '10'), grid)
  await assert.rejects(wx.model('10.6', '10'), (e: unknown) => e instanceof WxError && e.status === 503 && e.retryAfterS === 50, 'a cell with 14 places it never had')
  assert.equal(up.asks.length, 4, 'not asked: it failed 10 s ago')
})

test('model: an answer that is not the places asked for (HTTP error, an error object, a place short) is a failure: remembered, a 502 with nothing held', async () => {
  for (const [how, said] of [['http', /HTTP 429/], ['error', /expected an object for each of 49 places/], ['short', /expected an object for each of 49 places/]] as const) {
    const up = upstream()
    up.state.how = how
    const wx = makeWx({ userAgent: 't', fetchFn: up.fetchFn, nowMs: () => T0 })
    await assert.rejects(wx.model('10', '10'), (e: unknown) => e instanceof WxError && e.status === 502 && /^api\.open-meteo\.com: /.test(e.message) && said.test(e.message), how)
    await assert.rejects(wx.model('10', '10'), (e: unknown) => e instanceof WxError && e.status === 503, `${how}: remembered`)
    assert.equal(up.asks.length, 1, how)
  }
})

test('model: a place is not served past 2 h, whatever the state of Open-Meteo: the client drops a grid that old', async () => {
  let now = T0
  const up = upstream()
  const wx = makeWx({ userAgent: 't', fetchFn: up.fetchFn, nowMs: () => now })
  await wx.model('10', '10')
  up.state.how = 'down'
  now += 2 * 60 * MIN - 1_000
  assert.ok((await wx.model('10', '10')).elevM.every((e) => e === 1), '1 h 59 min: still served')
  now += 61_000
  await assert.rejects(wx.model('10', '10'), (e: unknown) => e instanceof WxError && e.status >= 502)
})

test('model: a bad place is a 400 and asks nothing', async () => {
  let asked = 0
  const wx = makeWx({ userAgent: 't', fetchFn: (async () => void asked++) as unknown as typeof fetch })
  for (const [lat, lon] of [[null, null], ['x', '1'], ['100', '0']] as const) {
    assert.throws(() => wx.model(lat, lon), (e: unknown) => e instanceof WxError && e.status === 400)
  }
  assert.equal(asked, 0)
})

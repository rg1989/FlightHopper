// server/wx.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODEL_VARIABLES } from '../shared/wx.ts'
import { WxError, makeWx, modelGeo, modelUrl, parseBbox } from './wx.ts'

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

test('modelUrl: Open-Meteo\'s forecast for the 49 places, row by row from the south-west: the levels asked for, the current hour, the wind in knots', () => {
  const url = modelUrl({ lat0: 31.5, lon0: 34, step: 0.25, n: 7 })
  const u = new URL(url)
  assert.equal(`${u.origin}${u.pathname}`, 'https://api.open-meteo.com/v1/forecast')
  const [lats, lons] = [rows(url, 'latitude'), rows(url, 'longitude')]
  assert.equal(lats.length, 49)
  assert.deepEqual(lats.slice(0, 8), [31.5, 31.5, 31.5, 31.5, 31.5, 31.5, 31.5, 31.75], 'rows go north')
  assert.deepEqual(lons.slice(0, 8), [34, 34.25, 34.5, 34.75, 35, 35.25, 35.5, 34], 'columns go east, and start again each row')
  assert.deepEqual([lats[48], lons[48]], [33, 35.5])
  assert.equal(u.searchParams.get('hourly'), MODEL_VARIABLES.join(','))
  assert.equal(u.searchParams.get('hourly'), 'cloud_cover_1000hPa,cloud_cover_925hPa,cloud_cover_850hPa,cloud_cover_700hPa,cloud_cover_600hPa,cloud_cover_500hPa,cloud_cover_400hPa,cloud_cover_300hPa,cloud_cover_250hPa,cloud_cover_200hPa,'
    + 'geopotential_height_1000hPa,geopotential_height_925hPa,geopotential_height_850hPa,geopotential_height_700hPa,geopotential_height_600hPa,geopotential_height_500hPa,geopotential_height_400hPa,geopotential_height_300hPa,geopotential_height_250hPa,geopotential_height_200hPa,'
    + 'wind_speed_850hPa,wind_speed_700hPa,wind_speed_500hPa,wind_speed_300hPa,wind_speed_250hPa,wind_speed_200hPa,wind_direction_850hPa,wind_direction_700hPa,wind_direction_500hPa,wind_direction_300hPa,wind_direction_250hPa,wind_direction_200hPa')
  assert.equal(u.searchParams.get('wind_speed_unit'), 'kn')
  assert.equal(u.searchParams.get('forecast_hours'), '1', 'the current hour')
  assert.equal(u.searchParams.get('timeformat'), 'unixtime')
  assert.deepEqual([...u.searchParams.keys()], ['latitude', 'longitude', 'hourly', 'wind_speed_unit', 'forecast_hours', 'timeformat'])
  assert.ok(url.length < 2000, `${url.length} characters: a URL a server takes`)
})

test('modelUrl: across the antimeridian the longitudes stay within −180 … 180 (180 itself as −180); at the pole the latitudes within ±90', () => {
  const east = rows(modelUrl(modelGeo('10', '180')), 'longitude')
  assert.deepEqual(east.slice(0, 7), [179.5, 179.75, -180, -179.75, -179.5, -179.25, -179])
  assert.ok(east.every((v) => v >= -180 && v < 180))
  const pole = rows(modelUrl(modelGeo('90', '10')), 'latitude')
  assert.deepEqual([pole[0], pole[48]], [88.5, 90])
  const south = rows(modelUrl(modelGeo('-90', '10')), 'latitude')
  assert.deepEqual([south[0], south[48]], [-90, -88.5])
})

/** What Open-Meteo answers for a grid: one object a place, the order asked, each with its own nearest point. `cover` is the 700 hPa cloud cover of every place. */
const omAnswer = (cover = 40): unknown => Array.from({ length: 49 }, (_, k) => ({
  latitude: 0, longitude: 0, elevation: k, hourly: { time: [1791014400], cloud_cover_700hPa: [cover], wind_speed_500hPa: [20 + k], wind_direction_500hPa: [270] },
}))

test('model: one upstream request for a cell and 30 min, slimmed to the grid; the whole cell is the same request, the next cell another', async () => {
  let now = 0
  const asked: { url: string; ua: string }[] = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    asked.push({ url, ua: (init?.headers as Record<string, string>)['user-agent'] })
    await Promise.resolve()
    return new Response(JSON.stringify(omAnswer()))
  }) as unknown as typeof fetch
  const wx = makeWx({ userAgent: 'test ua', fetchFn, nowMs: () => now })
  const [a, b] = await Promise.all([wx.model('32.1', '34.9'), wx.model('32.45', '34.55')]) // two clients, one cell, at once
  assert.equal(asked.length, 1)
  assert.equal(asked[0].url, modelUrl(modelGeo('32.1', '34.9')))
  assert.equal(asked[0].ua, 'test ua')
  assert.deepEqual(a, b)
  assert.deepEqual([a.lat0, a.lon0, a.step, a.n, a.timeMs], [31.5, 34, 0.25, 7, 1791014400_000])
  assert.equal(a.elevM[48], 48)
  assert.equal(a.clouds[3].hPa, 700)
  assert.ok(a.clouds[3].cover.every((v) => v === 40))
  assert.equal(a.winds[2].kt[10], 30)
  now = 29 * 60_000
  assert.deepEqual(await wx.model('32.0', '34.5'), a)
  assert.equal(asked.length, 1, 'within 30 min: the same answer, no request')
  await wx.model('32.6', '34.9') // the cell north of it
  assert.equal(asked.length, 2)
  assert.notEqual(asked[1].url, asked[0].url)
  now = 31 * 60_000
  await wx.model('32.1', '34.9')
  assert.equal(asked.length, 3, 'past 30 min: asked again')
})

test('model: a failing upstream serves the last good grid, past its 30 min too; with none to serve it is a 502 that names Open-Meteo', async () => {
  let now = 0
  const asked: string[] = []
  let how: 'ok' | 'down' | 'http' | 'bad' | 'short' = 'ok'
  let cover = 55
  const fetchFn = (async (url: string) => {
    asked.push(url)
    if (how === 'down') throw new Error('connect ETIMEDOUT')
    if (how === 'http') return new Response('{"error":true,"reason":"Too many requests"}', { status: 429 })
    if (how === 'bad') return new Response('{"error":true,"reason":"Latitude must be in range of -90 to 90°."}') // not the array of places
    if (how === 'short') return new Response(JSON.stringify((omAnswer() as unknown[]).slice(0, 48)))
    return new Response(JSON.stringify(omAnswer(cover)))
  }) as unknown as typeof fetch
  const wx = makeWx({ userAgent: 't', fetchFn, nowMs: () => now })
  how = 'down'
  await assert.rejects(wx.model('10', '10'), (e: unknown) => e instanceof WxError && e.status === 502 && /^api\.open-meteo\.com: /.test(e.message) && /ETIMEDOUT/.test(e.message))
  for (const kind of ['http', 'bad', 'short'] as const) {
    how = kind
    await assert.rejects(wx.model('10', '10'), (e: unknown) => e instanceof WxError && e.status === 502, kind)
  }
  how = 'ok'
  const good = await wx.model('10', '10')
  assert.ok(good.clouds[3].cover.every((v) => v === 55))
  now = 31 * 60_000
  for (const kind of ['down', 'http', 'bad', 'short'] as const) {
    how = kind
    assert.deepEqual(await wx.model('10', '10'), good, `${kind}: the last good answer`)
  }
  assert.equal(asked.length, 9, 'it asked each time: a failure keeps nothing')
  how = 'ok'
  cover = 70
  const again = await wx.model('10', '10')
  assert.ok(again.clouds[3].cover.every((v) => v === 70), 'upstream back: the new numbers')
  assert.equal(asked.length, 10)
})

test('model: a bad place is a 400 and asks nothing', async () => {
  let asked = 0
  const wx = makeWx({ userAgent: 't', fetchFn: (async () => void asked++) as unknown as typeof fetch })
  for (const [lat, lon] of [[null, null], ['x', '1'], ['100', '0']] as const) {
    assert.throws(() => wx.model(lat, lon), (e: unknown) => e instanceof WxError && e.status === 400)
  }
  assert.equal(asked, 0)
})

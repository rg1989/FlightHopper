// server/wx.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WxError, makeWx, parseBbox } from './wx.ts'

const METARS = [
  { icaoId: 'LLBG', lat: 32.01, lon: 34.87, fltCat: 'MVFR', wdir: 290, wspd: 12, wgst: 22, rawOb: 'METAR LLBG …' },
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
  assert.deepEqual(a, [
    { id: 'LLBG', lat: 32.01, lon: 34.87, cat: 'MVFR', wdir: 290, wspd: 12, wgst: 22, raw: 'METAR LLBG …' },
    { id: 'OJAM', lat: 31.97, lon: 35.99, cat: 'VFR', wdir: null, wspd: 3, wgst: null, raw: 'METAR OJAM …' },
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

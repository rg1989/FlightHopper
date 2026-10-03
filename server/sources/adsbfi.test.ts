// server/sources/adsbfi.test.ts
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { ADSBFI_BASE, makeAdsbfi } from './adsbfi.ts'
import type { Source } from './types.ts'

const golden = (f: string): string => readFileSync(new URL(`../../data/fixtures/golden/${f}`, import.meta.url), 'utf8')
const POINT = golden('adsbfi-point-llbg.json') // one real answer, 2026-09-23: /api/v3/lat/32.0114/lon/34.8867/dist/40
const HEX = golden('adsbfi-hex.json')
// A squawk answer in the adsb.lol envelope (a real empty one, 2026-10-03: {"ac":[],"msg":"No error","now":…,"total":0}).
const SQK = '{"ac":[{"hex":"89645a","squawk":"7700","lat":29.9,"lon":38.1,"seen_pos":1,"alt_baro":30000}],"msg":"No error","now":1790995674001,"total":1}'
const UA = 'FlightHopper/0.1 (+test@example.com)'

const seen: { url: string; ua: string | undefined }[] = []
let server: Server
let src: Source

before(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', ua: req.headers['user-agent'] })
    if (req.url?.startsWith('/api/v3/lat/')) return void res.end(POINT)
    if (req.url?.startsWith('/api/v2/hex/')) return void res.end(HEX)
    if (req.url?.startsWith('/api/v2/sqk/')) return void res.end(SQK)
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  src = makeAdsbfi({ userAgent: UA, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`, timeoutMs: 2000 })
})

after(() => {
  server.closeAllConnections()
  server.close()
})

test('caps: area source paced at 1 req/s with burst 1, personal non-commercial attribution', () => {
  assert.deepEqual(src.caps, { kind: 'adsbfi', fullSnapshot: false, maxRps: 1, burst: 1, coverage: null, attribution: 'adsb.fi (personal, non-commercial use)' })
  assert.equal(ADSBFI_BASE, 'https://opendata.adsb.fi/api') // default; never contacted by tests
})

test('circle: /v3/lat/{lat}/lon/{lon}/dist/{nm}, radius whole nm in 1..250; the adsb.lol envelope parses', async () => {
  const r = await src.circle(32.0114, 34.8867, 40)
  assert.equal(seen.at(-1)!.url, '/api/v3/lat/32.0114/lon/34.8867/dist/40')
  assert.equal(seen.at(-1)!.ua, UA)
  assert.equal(r.status, 200)
  assert.equal(r.snapshot!.aircraft.length, 13)
  assert.equal(r.snapshot!.nowMs, 1_790_135_080_000)
  await src.circle(0, 0, 900)
  assert.equal(seen.at(-1)!.url, '/api/v3/lat/0.0000/lon/0.0000/dist/250')
  await src.circle(0, 0, 0.2)
  assert.equal(seen.at(-1)!.url, '/api/v3/lat/0.0000/lon/0.0000/dist/1')
})

test('hexes: one ICAO hex per request, /v2/hex/{hex}; non-ICAO ("~") addresses are never sent', async () => {
  const r = await src.hexes(['4ca87c', 'abcdef'])
  assert.equal(seen.at(-1)!.url, '/api/v2/hex/4ca87c')
  assert.equal(r.snapshot!.aircraft.length, 1)
  await src.hexes(['~a1b2c3', '71bd79'])
  assert.equal(seen.at(-1)!.url, '/api/v2/hex/71bd79', 'the first ICAO one')
  const n = seen.length
  const skipped = await src.hexes(['~a1b2c3'])
  assert.equal(seen.length, n, 'nothing sent')
  assert.equal(skipped.status, 200)
  assert.deepEqual(skipped.snapshot!.aircraft, [])
  await assert.rejects(src.all(), /unsupported/)
})

test('squawk: /v2/sqk/{code} for four octal digits and the envelope parses; any other code is never sent, answered 200 with no aircraft', async () => {
  const r = await src.squawk!('7700')
  assert.equal(seen.at(-1)!.url, '/api/v2/sqk/7700')
  assert.equal(seen.at(-1)!.ua, UA)
  assert.equal(r.status, 200)
  assert.equal(r.snapshot!.nowMs, 1_790_995_674_001)
  assert.deepEqual(r.snapshot!.aircraft.map((a) => [a.hex, a.squawk]), [['89645a', '7700']])
  const n = seen.length
  for (const code of ['7708', '77', '', '77000', '770a', '7700\n', ' 7700', '7700/../hex/abcdef']) {
    const skipped = await src.squawk!(code)
    assert.equal(skipped.status, 200, JSON.stringify(code))
    assert.deepEqual(skipped.snapshot!.aircraft, [], JSON.stringify(code))
  }
  assert.equal(seen.length, n, 'nothing sent: a 400 or 404 counts toward adsb.fi\'s IP restriction')
})

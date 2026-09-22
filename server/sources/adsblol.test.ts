// server/sources/adsblol.test.ts
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { ADSBLOL_BASE, makeAdsblol } from './adsblol.ts'
import { normalizeAdsblol } from '../../shared/readsb.ts'
import type { Source } from './types.ts'

const golden = (f: string): string => readFileSync(new URL(`../../data/fixtures/golden/${f}`, import.meta.url), 'utf8')
const POINT = golden('adsblol-point-ksfo.json')
const HEX = golden('adsblol-hex.json')
const UA = 'FlightHopper/0.1 (+test@example.com)'

// The mock answers by path prefix; `mode` switches the next responses to a failure.
let mode: 'ok' | '429' | '403' | '500' | 'bad' | 'readsb' = 'ok'
const seen: { url: string; ua: string | undefined; ae: string | undefined }[] = []
let server: Server
let src: Source
let base = ''

before(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', ua: req.headers['user-agent'], ae: req.headers['accept-encoding'] })
    if (mode === '429') { res.writeHead(429, { 'Retry-After': '30' }); return void res.end() }
    if (mode === '403') { res.writeHead(403); return void res.end('blocked') }
    if (mode === '500') { res.writeHead(500); return void res.end() }
    if (mode === 'bad') return void res.end('<html>maintenance</html>')
    if (mode === 'readsb') return void res.end(golden('readsb-circle.json'))
    if (req.url?.startsWith('/v2/point/')) return void res.end(POINT)
    if (req.url?.startsWith('/v2/hex/')) return void res.end(HEX)
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  src = makeAdsblol({ userAgent: UA, baseUrl: `${base}/`, timeoutMs: 2000 })
})

after(() => {
  server.closeAllConnections()
  server.close()
})

const last = () => seen[seen.length - 1]

test('caps: area source, 1 req/s, global, ODbL attribution', () => {
  assert.deepEqual(src.caps, { kind: 'adsblol', fullSnapshot: false, maxRps: 1, coverage: null, attribution: 'adsb.lol (ODbL 1.0)' })
  assert.equal(ADSBLOL_BASE, 'https://api.adsb.lol') // default; never contacted by tests
})

test('circle → /v2/point/{lat.toFixed(4)}/{lon.toFixed(4)}/{round(nm)}; snapshot = normalizeAdsblol(body)', async () => {
  mode = 'ok'
  const r = await src.circle(37.61881234, -122.37579999, 39.6)
  assert.equal(r.url, `${base}/v2/point/37.6188/-122.3758/40`)
  assert.equal(last().url, '/v2/point/37.6188/-122.3758/40')
  assert.equal(r.status, 200)
  assert.equal(r.body, POINT)
  assert.equal(r.bytes, Buffer.byteLength(POINT))
  assert.deepEqual(r.snapshot, normalizeAdsblol(POINT))
})

test('circle radius is capped at 250 nm', async () => {
  mode = 'ok'
  const r = await src.circle(0, 0, 400)
  assert.equal(r.url, `${base}/v2/point/0.0000/0.0000/250`)
})

test('hexes → /v2/hex/{lowercased,comma-joined}; snapshot = normalizeAdsblol(body)', async () => {
  mode = 'ok'
  const r = await src.hexes(['71BD79', 'A0B88D', '~a330e6'])
  assert.equal(r.url, `${base}/v2/hex/71bd79,a0b88d,~a330e6`)
  assert.equal(last().url, '/v2/hex/71bd79,a0b88d,~a330e6')
  assert.deepEqual(r.snapshot, normalizeAdsblol(HEX))
})

test('hexes: empty or more than 100 → RangeError, no request sent', async () => {
  const n0 = seen.length
  await assert.rejects(src.hexes([]), RangeError)
  await assert.rejects(src.hexes(Array.from({ length: 101 }, (_, i) => (0xa00000 + i).toString(16))), RangeError)
  assert.equal(seen.length, n0)
  mode = 'ok'
  assert.equal((await src.hexes(Array.from({ length: 100 }, (_, i) => (0xa00000 + i).toString(16)))).status, 200)
})

test('all() rejects with Error("unsupported")', async () => {
  await assert.rejects(src.all(), { name: 'Error', message: 'unsupported' })
})

test('sends User-Agent and Accept-Encoding: gzip', async () => {
  mode = 'ok'
  await src.circle(1, 2, 3)
  assert.equal(last().ua, UA)
  assert.equal(last().ae, 'gzip')
})

test('429: status, Retry-After, no snapshot', async () => {
  mode = '429'
  const r = await src.circle(1, 2, 3)
  assert.equal(r.status, 429)
  assert.equal(r.retryAfterS, 30)
  assert.equal(r.snapshot, null)
})

test('403 and 500: status kept, snapshot null', async () => {
  mode = '403'
  const blocked = await src.hexes(['abc123'])
  assert.equal(blocked.status, 403)
  assert.equal(blocked.snapshot, null)
  mode = '500'
  assert.equal((await src.circle(1, 2, 3)).status, 500)
})

test('200 with a body that does not normalize → snapshot null, body kept', async () => {
  mode = 'bad'
  const r = await src.circle(1, 2, 3)
  assert.equal(r.status, 200)
  assert.equal(r.body, '<html>maintenance</html>')
  assert.equal(r.snapshot, null)
  mode = 'readsb' // right JSON, wrong envelope
  assert.equal((await src.circle(1, 2, 3)).snapshot, null)
})

test('timeout → status 0', async () => {
  const hang = createServer(() => {})
  await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r))
  const s = makeAdsblol({ userAgent: UA, baseUrl: `http://127.0.0.1:${(hang.address() as AddressInfo).port}`, timeoutMs: 200 })
  const r = await s.circle(1, 2, 3)
  assert.equal(r.status, 0)
  assert.equal(r.snapshot, null)
  hang.closeAllConnections()
  hang.close()
})

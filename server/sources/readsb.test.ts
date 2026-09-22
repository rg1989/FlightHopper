// server/sources/readsb.test.ts
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { makeReadsb } from './readsb.ts'
import { normalizeAdsblol, normalizeReadsb } from '../../shared/readsb.ts'
import type { Source } from './types.ts'

const golden = (f: string): string => readFileSync(new URL(`../../data/fixtures/golden/${f}`, import.meta.url), 'utf8')
const CIRCLE = golden('readsb-circle.json')
const COVERAGE = { lat: 32.01, lon: 34.88, radiusNm: 200 }

let mode: 'ok' | '500' | 'bad' = 'ok'
const seen: string[] = []
let server: Server
let src: Source
let base = ''

before(async () => {
  server = createServer((req, res) => {
    seen.push(req.url ?? '')
    if (mode === '500') { res.writeHead(500); return void res.end() }
    if (mode === 'bad') return void res.end('{"now": 1790081633.5, "aircraft": [')
    res.end(CIRCLE)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  src = makeReadsb({ baseUrl: base, coverage: COVERAGE, timeoutMs: 2000 })
})

after(() => {
  server.closeAllConnections()
  server.close()
})

const last = () => seen[seen.length - 1]

test('caps: full-snapshot receiver with its own coverage', () => {
  assert.deepEqual(src.caps, { kind: 'readsb', fullSnapshot: true, maxRps: 5, coverage: COVERAGE, attribution: 'own receiver (readsb)' })
})

test('all() → /?all_with_pos; snapshot = normalizeReadsb(body)', async () => {
  mode = 'ok'
  const r = await src.all()
  assert.equal(r.url, `${base}/?all_with_pos`)
  assert.equal(last(), '/?all_with_pos')
  assert.equal(r.status, 200)
  assert.equal(r.bytes, Buffer.byteLength(CIRCLE))
  assert.deepEqual(r.snapshot, normalizeReadsb(CIRCLE))
})

test('the flip: a readsb snapshot equals the adsb.lol snapshot of the same moment', async () => {
  mode = 'ok'
  const r = await src.all()
  assert.deepEqual(r.snapshot, normalizeAdsblol(golden('adsblol-point-ksfo.json')))
})

test('circle → /?circle=lat,lon,nm', async () => {
  mode = 'ok'
  const r = await src.circle(32.01141234, 34.88669999, 39.6)
  assert.equal(r.url, `${base}/?circle=32.0114,34.8867,40`)
  assert.equal(last(), '/?circle=32.0114,34.8867,40')
  assert.deepEqual(r.snapshot, normalizeReadsb(CIRCLE))
})

test('hexes → /?find_hex=lowercased,comma-joined; 1..1000 else RangeError', async () => {
  mode = 'ok'
  const r = await src.hexes(['738065', 'ABC123'])
  assert.equal(r.url, `${base}/?find_hex=738065,abc123`)
  const n0 = seen.length
  await assert.rejects(src.hexes([]), RangeError)
  await assert.rejects(src.hexes(Array.from({ length: 1001 }, () => 'abc123')), RangeError)
  assert.equal(seen.length, n0)
  assert.equal((await src.hexes(Array.from({ length: 1000 }, () => 'abc123'))).status, 200)
})

test('trailing slash on baseUrl is tolerated', async () => {
  mode = 'ok'
  const r = await makeReadsb({ baseUrl: `${base}/`, coverage: COVERAGE }).all()
  assert.equal(r.url, `${base}/?all_with_pos`)
})

test('500 and malformed 200 → snapshot null', async () => {
  mode = '500'
  const down = await src.all()
  assert.equal(down.status, 500)
  assert.equal(down.snapshot, null)
  mode = 'bad'
  const bad = await src.all()
  assert.equal(bad.status, 200)
  assert.equal(bad.snapshot, null)
})

test('receiver not running → status 0', async () => {
  const dead = createServer()
  await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`
  await new Promise((r) => dead.close(r))
  const r = await makeReadsb({ baseUrl: url, coverage: COVERAGE, timeoutMs: 500 }).all()
  assert.equal(r.status, 0)
  assert.equal(r.snapshot, null)
})

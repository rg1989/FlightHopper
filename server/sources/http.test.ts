// server/sources/http.test.ts
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { fetchSnapshot, hexList, parseRetryAfter, timedFetch } from './http.ts'
import { normalizeAdsblol } from '../../shared/readsb.ts'

const KSFO = readFileSync(new URL('../../data/fixtures/golden/adsblol-point-ksfo.json', import.meta.url), 'utf8')
const T = Date.UTC(2026, 8, 22, 12, 0, 0) // server clock for the HTTP-date case
const seen: { url: string; ua: string | undefined; ae: string | undefined }[] = []
let server: Server
let base = ''

before(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', ua: req.headers['user-agent'], ae: req.headers['accept-encoding'] })
    switch (req.url) {
      case '/ok': return void res.end(KSFO)                      // Node sets Content-Length
      case '/chunked': res.write('äöü'); return void res.end()    // no Content-Length
      case '/gzip': {
        const gz = gzipSync(KSFO)
        res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': gz.length })
        return void res.end(gz)
      }
      case '/429s': res.writeHead(429, { 'Retry-After': '7' }); return void res.end('slow down')
      case '/429d':
        res.writeHead(429, { Date: new Date(T).toUTCString(), 'Retry-After': new Date(T + 120_000).toUTCString() })
        return void res.end()
      case '/403': res.writeHead(403); return void res.end('blocked')
      case '/500': res.writeHead(500); return void res.end('oops')
      case '/bad': return void res.end('{"ac": [')
      case '/hang': return                                          // never responds
      default: res.writeHead(404); res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(() => {
  server.closeAllConnections()
  server.close()
})

test('200: body verbatim, bytes = Content-Length, times ordered', async () => {
  const r = await timedFetch(`${base}/ok`, {})
  assert.equal(r.url, `${base}/ok`)
  assert.equal(r.status, 200)
  assert.equal(r.body, KSFO)
  assert.equal(r.bytes, Buffer.byteLength(KSFO))
  assert.equal(r.retryAfterS, null)
  assert.ok(r.tSendMs <= r.tRecvMs && r.tRecvMs - r.tSendMs < 5000)
})

test('no Content-Length: bytes = UTF-8 byte length of the body', async () => {
  const r = await timedFetch(`${base}/chunked`, {})
  assert.equal(r.body, 'äöü')
  assert.equal(r.bytes, 6)
})

test('gzip: body is decoded, bytes are the compressed wire bytes', async () => {
  const r = await timedFetch(`${base}/gzip`, {})
  assert.equal(r.body, KSFO)
  assert.equal(r.bytes, gzipSync(KSFO).length)
  assert.ok(r.bytes < Buffer.byteLength(KSFO))
})

test('sends User-Agent and Accept-Encoding: gzip', async () => {
  await timedFetch(`${base}/ok?ua`, { userAgent: 'FlightHopper/0.1 (+test@example.com)' })
  const req = seen.find((s) => s.url === '/ok?ua')!
  assert.equal(req.ua, 'FlightHopper/0.1 (+test@example.com)')
  assert.equal(req.ae, 'gzip')
})

test('429 with Retry-After in seconds', async () => {
  const r = await timedFetch(`${base}/429s`, {})
  assert.equal(r.status, 429)
  assert.equal(r.retryAfterS, 7)
  assert.equal(r.body, 'slow down')
})

test('429 with Retry-After as HTTP-date, measured against the response Date header', async () => {
  const r = await timedFetch(`${base}/429d`, {})
  assert.equal(r.status, 429)
  assert.equal(r.retryAfterS, 120)
})

test('403 and 500 are returned as statuses, not thrown', async () => {
  assert.equal((await timedFetch(`${base}/403`, {})).status, 403)
  const r = await timedFetch(`${base}/500`, {})
  assert.equal(r.status, 500)
  assert.equal(r.body, 'oops')
})

test('timeout → status 0, empty body, no throw', async () => {
  const t0 = Date.now()
  const r = await timedFetch(`${base}/hang`, { timeoutMs: 200 })
  assert.equal(r.status, 0)
  assert.equal(r.body, '')
  assert.equal(r.bytes, 0)
  assert.equal(r.retryAfterS, null)
  assert.ok(Date.now() - t0 < 2000, 'timed out promptly')
})

test('connection refused → status 0', async () => {
  const dead = createServer()
  await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(dead.address() as AddressInfo).port}/`
  await new Promise((r) => dead.close(r))
  const r = await timedFetch(url, { timeoutMs: 2000 })
  assert.equal(r.status, 0)
  assert.equal(r.body, '')
})

test('parseRetryAfter: seconds, HTTP-date, garbage', () => {
  assert.equal(parseRetryAfter(null, null, 0), null)
  assert.equal(parseRetryAfter('', null, 0), null)
  assert.equal(parseRetryAfter('soon', null, 0), null)
  assert.equal(parseRetryAfter(' 30 ', null, 0), 30)
  assert.equal(parseRetryAfter('1.5', null, 0), 1.5)
  // HTTP-date without a Date header: measured against nowMs, rounded up, never negative
  assert.equal(parseRetryAfter(new Date(T + 4500).toUTCString(), null, T), 4)
  assert.equal(parseRetryAfter(new Date(T + 4000).toUTCString(), null, T + 500), 4)
  assert.equal(parseRetryAfter(new Date(T - 60_000).toUTCString(), null, T), 0)
  // a Date header wins over the local clock (no skew)
  assert.equal(parseRetryAfter(new Date(T + 60_000).toUTCString(), new Date(T).toUTCString(), T + 3_600_000), 60)
})

test('fetchSnapshot: 200 → normalized snapshot', async () => {
  const r = await fetchSnapshot(`${base}/ok`, normalizeAdsblol, {})
  assert.deepEqual(r.snapshot, normalizeAdsblol(KSFO))
})

test('fetchSnapshot: malformed 200 body, non-200 and status 0 → snapshot null', async () => {
  const bad = await fetchSnapshot(`${base}/bad`, normalizeAdsblol, {})
  assert.equal(bad.status, 200)
  assert.equal(bad.body, '{"ac": [')
  assert.equal(bad.snapshot, null)
  assert.equal((await fetchSnapshot(`${base}/429s`, normalizeAdsblol, {})).snapshot, null)
  assert.equal((await fetchSnapshot(`${base}/hang`, normalizeAdsblol, { timeoutMs: 100 })).snapshot, null)
})

test('hexList: lowercased, comma-joined; empty or over the cap → RangeError', () => {
  assert.equal(hexList(['ABC123', '~a330E6'], 100), 'abc123,~a330e6')
  assert.throws(() => hexList([], 100), RangeError)
  assert.throws(() => hexList(Array.from({ length: 101 }, (_, i) => i.toString(16)), 100), RangeError)
  assert.equal(hexList(Array.from({ length: 100 }, () => 'a'), 100).split(',').length, 100)
})

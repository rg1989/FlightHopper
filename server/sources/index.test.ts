// server/sources/index.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { readServerConfig } from '../config.ts'
import { makeSource, userAgent } from './index.ts'

const FILE = fileURLToPath(new URL('../../data/fixtures/golden/recording-sample.jsonl', import.meta.url))

test('replay: the recording as a full-snapshot source', async () => {
  const src = makeSource(readServerConfig({ REPLAY_FILES: FILE, REPLAY_SPEED: '2' }))
  assert.equal(src.caps.kind, 'replay')
  assert.equal(src.caps.fullSnapshot, true)
  const r = await src.all()
  assert.equal(r.status, 200)
  assert.ok(r.snapshot!.aircraft.length > 30)
})

test('readsb: receiver URL and coverage come from the config (nothing is fetched here)', () => {
  const src = makeSource(readServerConfig({ ADSB_SOURCE: 'readsb', READSB_URL: 'http://127.0.0.1:1', READSB_COVERAGE: '32.01,34.88,200' }))
  assert.equal(src.caps.kind, 'readsb')
  assert.equal(src.caps.fullSnapshot, true)
  assert.deepEqual(src.caps.coverage, { lat: 32.01, lon: 34.88, radiusNm: 200 })
})

test('adsblol: area source at ≤ 1 req/s whose User-Agent carries CONTACT (fetch is mocked: nothing leaves the machine)', async (t) => {
  const src = makeSource(readServerConfig({ ADSB_SOURCE: 'adsblol', CONTACT: 'me@example.invalid' }))
  assert.equal(src.caps.kind, 'adsblol')
  assert.equal(src.caps.fullSnapshot, false)
  assert.equal(src.caps.maxRps, 1)
  const seen: { url: string; ua: string | null }[] = []
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), ua: new Headers(init?.headers).get('user-agent') })
    return new Response(JSON.stringify({ ac: [], now: 1_790_081_710_501 }), { status: 200 })
  })
  // Prove the mock is in place before the source is called: if it were not, this probe goes nowhere (port 1).
  await fetch('http://127.0.0.1:1/probe')
  assert.equal(seen.length, 1, 'fetch mock not installed; refusing to call the adsb.lol source')
  seen.length = 0
  const r = await src.circle(37.6188, -122.3758, 40)
  assert.equal(r.status, 200)
  assert.deepEqual(r.snapshot, { nowMs: 1_790_081_710_501, aircraft: [] })
  assert.deepEqual(seen, [{ url: 'https://api.adsb.lol/v2/point/37.6188/-122.3758/40', ua: 'FlightHopper/0.1 (+me@example.invalid)' }])
})

test('userAgent: FlightHopper/0.1 (+contact)', () => {
  assert.equal(userAgent('https://example.invalid/me'), 'FlightHopper/0.1 (+https://example.invalid/me)')
})

test('a hand-built config that lacks what its source needs throws', () => {
  const cfg = readServerConfig({ REPLAY_FILES: FILE })
  assert.throws(() => makeSource({ ...cfg, source: 'adsblol', contact: null }), /adsblol needs a contact/)
  assert.throws(() => makeSource({ ...cfg, source: 'readsb', readsbCoverage: null }), /readsb needs a coverage circle/)
})

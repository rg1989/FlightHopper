// client/api.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { StatusBrief } from '../shared/api.ts'
import type { Sample } from '../shared/types.ts'
import { ApiClient } from './api.ts'

const status: StatusBrief = { source: 'replay', degraded: null, cellPeriodP95S: null, chasePeriodP95S: null }

const sample = (hex: string, rxMs: number): Sample => ({
  hex, tMs: rxMs - 500, rxMs, lat: 37.6, lon: -122.4, onGround: false, altBaroFt: 3000, altGeomFt: 3100, gsKt: 150,
  trackDeg: 280, trueHeadingDeg: null, rollDeg: null, baroRateFpm: -700, geomRateFpm: null, navQnhHpa: null,
  version: 2, nic: 8, quality: 'adsb2', nM: -32.3, callsign: null, typeCode: null, reg: null,
})

interface Reply {
  status?: number
  serverNowMs?: number
  samples?: Sample[]
  latencyMs?: number
}

/** A fake server behind a fake fetch: records each request and answers with the next queued reply (default 200, no samples). */
function fake(startMs = 1_000_000) {
  const clock = { t: startMs }
  const urls: string[] = []
  const inits: (RequestInit | undefined)[] = []
  const replies: Reply[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input))
    inits.push(init)
    const r = replies.shift() ?? {}
    clock.t += r.latencyMs ?? 0
    const body = { serverNowMs: r.serverNowMs ?? clock.t, samples: r.samples ?? [], status }
    return new Response(JSON.stringify(body), { status: r.status ?? 200 })
  }) as typeof fetch
  const api = new ApiClient('http://host/api', fetchFn, () => clock.t)
  return { api, clock, urls, inits, replies }
}

test('view: exact query string, since starts at 0, parsed body returned, request has a timeout signal', async () => {
  const f = fake()
  f.replies.push({ serverNowMs: 999_900, samples: [sample('abc123', 999_000)] })
  const r = await f.api.view(37.6188, -122.3758, 40)
  assert.deepEqual(f.urls, ['http://host/api/view?lat=37.6188&lon=-122.3758&nm=40&since=0'])
  assert.equal(r.serverNowMs, 999_900)
  assert.deepEqual(r.samples, [sample('abc123', 999_000)])
  assert.deepEqual(r.status, status)
  assert.ok(f.inits[0]?.signal instanceof AbortSignal)
})

test('view: since = max rxMs seen so far for that key; empty or older replies never lower it', async () => {
  const f = fake()
  f.replies.push({ samples: [sample('a', 1000), sample('b', 3000), sample('c', 2000)] }, {}, { samples: [sample('a', 2500)] })
  for (let i = 0; i < 4; i++) await f.api.view(10, 20, 30)
  assert.deepEqual(f.urls.map((u) => new URL(u).searchParams.get('since')), ['0', '3000', '3000', '3000'])
})

test('view key: lat/lon rounded to 2 decimals plus nm; the query keeps the exact values', async () => {
  const f = fake()
  f.replies.push({ samples: [sample('a', 5000)] })
  await f.api.view(37.6188, -122.3758, 40)
  await f.api.view(37.6212, -122.3771, 40) // same key 37.62,-122.38,40
  await f.api.view(37.6212, -122.3771, 60) // other nm
  await f.api.view(37.6312, -122.3771, 40) // other lat
  assert.deepEqual(f.urls, [
    'http://host/api/view?lat=37.6188&lon=-122.3758&nm=40&since=0',
    'http://host/api/view?lat=37.6212&lon=-122.3771&nm=40&since=5000',
    'http://host/api/view?lat=37.6212&lon=-122.3771&nm=60&since=0',
    'http://host/api/view?lat=37.6312&lon=-122.3771&nm=40&since=0',
  ])
})

test('chase: exact query string, since per hex, independent of views', async () => {
  const f = fake()
  f.replies.push({ samples: [sample('abc123', 7000)] }, { samples: [sample('def456', 9000)] }, { samples: [sample('x', 8000)] })
  await f.api.chase('abc123')
  await f.api.chase('def456')
  await f.api.view(1, 2, 3)
  await f.api.chase('abc123')
  await f.api.chase('~a330e6')
  assert.deepEqual(f.urls, [
    'http://host/api/chase?hex=abc123&since=0',
    'http://host/api/chase?hex=def456&since=0',
    'http://host/api/view?lat=1&lon=2&nm=3&since=0',
    'http://host/api/chase?hex=abc123&since=7000',
    'http://host/api/chase?hex=~a330e6&since=0',
  ])
})

test('since memory is capped at 100 keys, least recently used first', async () => {
  const f = fake()
  f.replies.push({ samples: [sample('a', 4000)] }, { samples: [sample('b', 6000)] })
  await f.api.chase('first')
  await f.api.chase('kept')
  for (let i = 0; i < 98; i++) await f.api.view(i, 0, 10) // 100 keys: nothing evicted yet
  await f.api.chase('first') // touch: now the most recently used
  await f.api.view(0, 1, 10) // key 101 evicts the oldest: 'kept'
  await f.api.chase('first')
  await f.api.chase('kept')
  assert.deepEqual(f.urls.slice(-2), ['http://host/api/chase?hex=first&since=4000', 'http://host/api/chase?hex=kept&since=0'])
})

test('not ready, and serverNowMs throws, until the first response', async () => {
  const f = fake()
  assert.equal(f.api.ready, false)
  assert.throws(() => f.api.serverNowMs(), /no response yet/)
  await f.api.chase('abc123')
  assert.equal(f.api.ready, true)
})

test('serverNowMs = nowMs − min(local receive − serverNowMs) over the last 60 s', async () => {
  const f = fake(1_000_000)
  f.replies.push({ serverNowMs: 999_750 }) // offset 250
  await f.api.view(1, 2, 3)
  assert.equal(f.api.serverNowMs(), 999_750)
  f.clock.t += 5000
  assert.equal(f.api.serverNowMs(), 1_004_750) // runs on the local clock between responses
  f.replies.push({ serverNowMs: 1_004_850, latencyMs: 400 }) // received at 1_005_400 → 550: a slow reply, not a clock change
  await f.api.chase('abc123')
  assert.equal(f.api.serverNowMs(), f.clock.t - 250)
  f.clock.t += 61_000
  f.replies.push({ serverNowMs: f.clock.t - 300 }) // both older entries have left the window
  await f.api.view(1, 2, 3)
  assert.equal(f.api.serverNowMs(), f.clock.t - 300)
})

test('non-2xx rejects with Error("HTTP <status>") and changes neither the clock nor since', async () => {
  const f = fake()
  f.replies.push({ status: 503, samples: [sample('a', 9000)] })
  await assert.rejects(f.api.view(1, 2, 3), { name: 'Error', message: 'HTTP 503' })
  assert.equal(f.api.ready, false)
  f.replies.push({ status: 404 })
  await assert.rejects(f.api.chase('abc123'), { message: 'HTTP 404' })
  await f.api.view(1, 2, 3)
  assert.equal(new URL(f.urls.at(-1)!).searchParams.get('since'), '0')
})

test('default fetch is the global one, called unbound (a browser throws "Illegal invocation" otherwise)', async (t) => {
  const seenThis: unknown[] = []
  t.mock.method(globalThis, 'fetch', async function (this: unknown) {
    seenThis.push(this)
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
    return new Response(JSON.stringify({ serverNowMs: 1, samples: [], status }))
  })
  const r = await new ApiClient('/api').view(1, 2, 3)
  assert.equal(r.serverNowMs, 1)
  assert.equal(seenThis.length, 1)
})

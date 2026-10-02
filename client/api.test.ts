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

test('history, historyStatus and trace ask their endpoints; a 404 is null, not an error', async () => {
  const urls: string[] = []
  const answers: Response[] = []
  const fetchFn = (async (input: string | URL | Request) => {
    urls.push(String(input))
    return answers.shift()!
  }) as typeof fetch
  const api = new ApiClient('http://host/api', fetchFn, () => 0)
  const slot = { slotMs: 1_790_740_800_000, stepS: 10, aircraft: [] }
  answers.push(new Response(JSON.stringify(slot)), new Response('{"error":"none"}', { status: 404 }))
  assert.deepEqual(await api.history(1_790_740_800_000, 32.1, 34.8, 120), slot)
  assert.equal(await api.history(1_790_742_600_000, 32.1, 34.8, 120), null)
  assert.equal(urls[0], 'http://host/api/history?slot=1790740800000&lat=32.1&lon=34.8&nm=120')
  answers.push(new Response(JSON.stringify({ newestSlotMs: 5, slots: [] })))
  assert.deepEqual(await api.historyStatus(), { newestSlotMs: 5, slots: [] })
  assert.equal(urls[2], 'http://host/api/history/status')
  answers.push(new Response('{"error":"none"}', { status: 404 }), new Response('{"hex":"4691c4"}'))
  assert.equal(await api.trace('4691c4'), null)
  assert.deepEqual(await api.trace('~abc123'), { hex: '4691c4' })
  assert.equal(urls[3], 'http://host/api/trace?hex=4691c4')
  assert.equal(urls[4], 'http://host/api/trace?hex=~abc123')
  answers.push(new Response('', { status: 502 }))
  await assert.rejects(api.historyStatus(), { message: 'HTTP 502' })
  assert.equal(api.ready, false, 'the history endpoints do not set the server clock')
})

test('traceDay asks the legs of a span in whole ms, given 30 s; a 404 is null, another failure throws', async (t) => {
  const timeouts: number[] = []
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    timeouts.push(ms)
    return timeout(ms)
  })
  const urls: string[] = []
  const inits: (RequestInit | undefined)[] = []
  const answers: Response[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input))
    inits.push(init)
    return answers.shift()!
  }) as typeof fetch
  const api = new ApiClient('http://host/api', fetchFn, () => 0)
  const day = { hex: '4691c4', reg: null, typeCode: null, fromMs: 1_790_640_000_000, toMs: 1_790_726_400_000, legs: [] }
  answers.push(new Response(JSON.stringify(day)), new Response('{"error":"none"}', { status: 404 }), new Response('', { status: 500 }), new Response('{}', { status: 404 }))
  assert.deepEqual(await api.traceDay('4691c4', 1_790_640_000_000, 1_790_726_400_000), day)
  assert.equal(urls[0], 'http://host/api/trace?hex=4691c4&from=1790640000000&to=1790726400000')
  assert.ok(inits[0]?.signal instanceof AbortSignal, 'a timeout signal')
  assert.deepEqual(timeouts, [30_000], 'a day file of a few MB, perhaps fetched from adsb.lol first: 30 s, not the poll’s 10')
  assert.equal(await api.traceDay('~abc123', 1_790_640_000_000.4, 1_790_726_400_000.6), null)
  assert.equal(urls[1], 'http://host/api/trace?hex=~abc123&from=1790640000000&to=1790726400001', 'whole numbers')
  await assert.rejects(api.traceDay('4691c4', 1, 2), { message: 'HTTP 500' })
  await api.traceDay('x&to=1', 1, 2)
  assert.equal(urls[3], 'http://host/api/trace?hex=x%26to%3D1&from=1&to=2', 'the hex cannot add a parameter')
  assert.equal(api.ready, false, 'it does not set the server clock')
})

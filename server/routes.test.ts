// server/routes.test.ts
// RouteFetcher against a fake fetch on a fake clock. Nothing here touches the network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadsbAircraft } from '../shared/types.ts'
import { TokenBucket } from './budget.ts'
import { InfoStore } from './infoStore.ts'
import { MAX_PLANES, parseRouteset, ROUTESET_URL, RouteFetcher } from './routes.ts'

const T0 = 2_000_000_000_000
const UA = 'FlightHopper/0.1 (+me@example.invalid)'

/** One routeset item shaped like adsb.lol's (api_routes.py api_routeset → provider.py _route; orjson, sorted keys). */
function known(callsign: string, icao: string, iata: string, plausible = true) {
  const airports = icao.split('-').map((code, i) => ({ icao: code, iata: iata.split('-')[i], name: `${code} airport`, location: 'Somewhere', countryiso2: 'XX', lat: 44 + i, lon: 26 + i, alt_feet: 300, alt_meters: 91.44 }))
  return { _airport_codes_iata: iata, _airports: airports, airline_code: callsign.slice(0, 3), airport_codes: icao, callsign, number: callsign.slice(3), plausible }
}
const unknown = (callsign: string) => ({ _airports: [], airport_codes: 'unknown', callsign })

test('parseRouteset: ICAO airport_codes first, IATA as a fallback; unknown and malformed items are skipped', () => {
  const body = [
    known('ROT1234', 'LROP-OTHH', 'OTP-DOH'),
    known('QTR5', 'OTHH-EGLL-KJFK', 'DOH-LHR-JFK'),
    known('ELY27', 'LLBG-KJFK', 'TLV-JFK', false),
    unknown('UAL1'),
    { callsign: 'DAL45', _airport_codes_iata: 'ATL-LAX', _airports: [] }, // no ICAO field: IATA is used
    { callsign: 'AAL9', airport_codes: 'KJFK', _airports: [] }, // one airport is not a route
    { callsign: 'SWA1', airport_codes: 'KDAL-<script>' }, // not airport codes
    { callsign: 'BAW1', airport_codes: 'egll-kjfk' }, // lower case is normalised
    { callsign: 'KLM1', airport_codes: 'EHAM-KJFK', plausible: 0 }, // only false is implausible
    { airport_codes: 'EHAM-KJFK' },
    { callsign: '  ', airport_codes: 'EHAM-KJFK' },
    null,
    42,
    'EHAM-KJFK',
  ]
  assert.deepEqual(parseRouteset(body), [
    { callsign: 'ROT1234', route: 'LROP-OTHH', plausible: true },
    { callsign: 'QTR5', route: 'OTHH-EGLL-KJFK', plausible: true },
    { callsign: 'ELY27', route: 'LLBG-KJFK', plausible: false },
    { callsign: 'DAL45', route: 'ATL-LAX', plausible: true },
    { callsign: 'BAW1', route: 'EGLL-KJFK', plausible: true },
    { callsign: 'KLM1', route: 'EHAM-KJFK', plausible: true },
  ])
  assert.equal(parseRouteset({ planes: [] }), null, 'not an array: not a routeset answer')
  assert.equal(parseRouteset(null), null)
  assert.deepEqual(parseRouteset([]), [])
})

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: { planes: { callsign: string; lat: number; lng: number }[] }
}

type Reply = { status: number; body?: string; headers?: Record<string, string> } | 'network-error'

function setup(maxRps = 100) {
  const clock = { t: T0 }
  const nowMs = (): number => clock.t
  const calls: Call[] = []
  const replies: Reply[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) })
    const r = replies.shift() ?? { status: 200, body: '[]' }
    if (r === 'network-error') throw new TypeError('fetch failed')
    return new Response(r.body ?? '', { status: r.status, headers: r.headers })
  }) as typeof fetch
  const bucket = new TokenBucket(maxRps, nowMs, () => 0)
  const store = new InfoStore({ nowMs })
  const fetcher = new RouteFetcher({ bucket, userAgent: UA, nowMs, fetchFn })
  return { clock, calls, replies, bucket, store, fetcher }
}

const plane = (hex: string, flight: string, lat = 44.5712, lon = 26.0851): ReadsbAircraft => ({ hex, flight: `${flight}  `, lat, lon, seen_pos: 1 })

test('tick: one POST to /api/0/routeset with the callsigns that need a route; routes fill the store, the rest are misses', async () => {
  const s = setup()
  s.store.update(plane('4a8123', 'ROT1234', 44.571234, 26.085149), T0)
  s.store.update(plane('06a1e7', 'QTR5'), T0)
  s.store.update(plane('738065', 'ELY27'), T0)
  s.store.update(plane('a1c7e4', 'UAL1'), T0)
  s.store.update(plane('4b1805', 'HBJZA'), T0) // not an airline callsign: never asked
  s.replies.push({ status: 200, body: JSON.stringify([known('ROT1234', 'LROP-OTHH', 'OTP-DOH'), known('QTR5', 'OTHH-EGLL', 'DOH-LHR'), known('ELY27', 'LLBG-KJFK', 'TLV-JFK', false), unknown('UAL1')]) })

  assert.equal(await s.fetcher.tick(s.store), true)
  assert.equal(s.calls.length, 1)
  const c = s.calls[0]
  assert.equal(c.url, ROUTESET_URL)
  assert.equal(ROUTESET_URL, 'https://api.adsb.lol/api/0/routeset')
  assert.equal(c.method, 'POST')
  assert.equal(c.headers['Content-Type'], 'application/json')
  assert.equal(c.headers['User-Agent'], UA)
  assert.deepEqual(c.body, {
    planes: [
      { callsign: 'ROT1234', lat: 44.571, lng: 26.085 },
      { callsign: 'QTR5', lat: 44.571, lng: 26.085 },
      { callsign: 'ELY27', lat: 44.571, lng: 26.085 },
      { callsign: 'UAL1', lat: 44.571, lng: 26.085 },
    ],
  })
  assert.equal(s.store.get('4a8123')?.route, 'LROP-OTHH')
  assert.equal(s.store.get('06a1e7')?.route, 'OTHH-EGLL')
  assert.equal(s.store.get('738065')?.route, null, 'an implausible route is not shown')
  assert.equal(s.store.get('a1c7e4')?.route, null)
  assert.deepEqual(s.store.needRoutes(10), [], 'misses are cached too')
  assert.equal(s.bucket.state().counts.ok, 1)
})

test('at most one request per minIntervalMs (default 60 s), ≤ 100 callsigns each; nothing to ask → no request', async () => {
  const s = setup()
  assert.equal(await s.fetcher.tick(s.store), false, 'empty store')
  assert.equal(s.calls.length, 0)
  assert.equal(s.bucket.state().tokens, 2, 'no token spent')

  for (let i = 0; i < 150; i++) s.store.update(plane(i.toString(16).padStart(6, '0'), `DAL${i + 1}`), T0)
  assert.equal(await s.fetcher.tick(s.store), true)
  assert.equal(s.calls[0].body.planes.length, MAX_PLANES)
  assert.equal(MAX_PLANES, 100)
  s.clock.t = T0 + 59_999
  assert.equal(await s.fetcher.tick(s.store), false)
  s.clock.t = T0 + 60_000
  assert.equal(await s.fetcher.tick(s.store), true)
  assert.deepEqual(s.calls.map((c) => c.body.planes.length), [100, 50])
  assert.equal(s.calls[1].body.planes[0].callsign, 'DAL101')
  s.clock.t = T0 + 120_000
  assert.equal(await s.fetcher.tick(s.store), false, 'all answered (as misses)')

  const t = setup()
  const quick = new RouteFetcher({ bucket: t.bucket, userAgent: UA, nowMs: () => t.clock.t, fetchFn: (async () => new Response('[]')) as typeof fetch, minIntervalMs: 5000 })
  t.store.update(plane('000001', 'DAL1'), T0)
  assert.equal(await quick.tick(t.store), true)
  t.store.update(plane('000002', 'DAL2'), T0)
  t.clock.t = T0 + 4999
  assert.equal(await quick.tick(t.store), false)
  t.clock.t = T0 + 5000
  assert.equal(await quick.tick(t.store), true)
})

test('shares the budget: no token → no request; the answer goes to bucket.onResult (429 pauses, Retry-After honoured)', async () => {
  const s = setup(1)
  s.store.update(plane('4a8123', 'ROT1234'), T0)
  assert.ok(s.bucket.tryTake() && s.bucket.tryTake(), 'the poller took both tokens')
  assert.equal(await s.fetcher.tick(s.store), false)
  assert.equal(s.calls.length, 0)

  s.clock.t = T0 + 1000
  s.replies.push({ status: 429, headers: { 'retry-after': '30' } })
  assert.equal(await s.fetcher.tick(s.store), true)
  const st = s.bucket.state()
  assert.equal(st.counts.r429, 1)
  assert.equal(st.pausedUntilMs, T0 + 31_000)
  assert.equal(s.bucket.degraded, 'rate-limited')
  assert.deepEqual(s.store.needRoutes(10).map((p) => p.callsign), ['ROT1234'], 'a refused request caches nothing')

  s.clock.t = T0 + 61_000
  s.replies.push({ status: 403 })
  assert.equal(await s.fetcher.tick(s.store), true)
  assert.equal(s.bucket.degraded, 'blocked', 'a block stops the whole adsb.lol source')
  s.clock.t = T0 + 200_000
  assert.equal(await s.fetcher.tick(s.store), false)
  assert.equal(s.calls.length, 2)
})

test('network errors, 5xx and non-routeset bodies cache nothing and count against the bucket', async () => {
  const s = setup()
  s.store.update(plane('4a8123', 'ROT1234'), T0)
  s.replies.push('network-error')
  assert.equal(await s.fetcher.tick(s.store), true)
  assert.equal(s.bucket.state().counts.err, 1)

  s.clock.t += 120_000
  s.replies.push({ status: 503, body: 'busy' })
  assert.equal(await s.fetcher.tick(s.store), true)
  assert.equal(s.bucket.state().counts.r5xx, 1)

  for (const body of ['<html>proxy error</html>', '{"planes":[]}']) {
    s.clock.t += 120_000
    s.replies.push({ status: 200, body })
    assert.equal(await s.fetcher.tick(s.store), true)
  }
  assert.equal(s.calls.length, 4)
  assert.deepEqual(s.store.needRoutes(10).map((p) => p.callsign), ['ROT1234'])
})

test('overlapping ticks: the second returns false at once', async () => {
  const s = setup()
  s.store.update(plane('4a8123', 'ROT1234'), T0)
  const first = s.fetcher.tick(s.store)
  s.clock.t += 120_000
  assert.equal(await s.fetcher.tick(s.store), false)
  assert.equal(await first, true)
  assert.equal(s.calls.length, 1)
})

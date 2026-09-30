// server/adsbdb.test.ts
// AdsbdbRoutes against a fake fetch on a fake clock. Nothing here touches the network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TokenBucket } from './budget.ts'
import { ADSBDB_URL, AdsbdbRoutes, parseAdsbdb } from './adsbdb.ts'
import { InfoStore } from './infoStore.ts'
import type { ReadsbAircraft } from '../shared/types.ts'

const T0 = 2_000_000_000_000
// The shape of a real answer (ITY810, 2026-09-30), trimmed.
const ITY810 = { response: { flightroute: { callsign: 'ITY810',
  origin: { icao_code: 'LIRF', iata_code: 'FCO', latitude: 41.804532, longitude: 12.251998, elevation: 13 },
  destination: { icao_code: 'LLBG', iata_code: 'TLV', latitude: 32.01139831542969, longitude: 34.88669967651367, elevation: 135 } } } }

test('parseAdsbdb: origin (midpoint) destination with positions, ICAO first; anything else is no route', () => {
  assert.deepEqual(parseAdsbdb(ITY810), [{ code: 'LIRF', lat: 41.804532, lon: 12.251998 }, { code: 'LLBG', lat: 32.01139831542969, lon: 34.88669967651367 }])
  const via = structuredClone(ITY810) as { response: { flightroute: Record<string, unknown> } }
  via.response.flightroute.midpoint = { icao_code: 'LGAV', latitude: 37.9, longitude: 23.9 }
  assert.deepEqual(parseAdsbdb(via)?.map((p) => p.code), ['LIRF', 'LGAV', 'LLBG'])
  assert.equal(parseAdsbdb({ response: 'unknown callsign' }), null)
  assert.equal(parseAdsbdb(null), null)
  const noPos = structuredClone(ITY810) as { response: { flightroute: { destination: Record<string, unknown> } } }
  delete noPos.response.flightroute.destination.latitude
  assert.equal(parseAdsbdb(noPos), null)
})

test('AdsbdbRoutes: one callsign a request, only the given hexes; a route and its places cached, a 404 a miss, a 500 nothing', async () => {
  const clock = { t: T0 }
  const store = new InfoStore({ nowMs: () => clock.t })
  const ac = (hex: string, flight: string) => ({ hex, flight, lat: 32.3, lon: 34.2 }) as ReadsbAircraft
  store.update(ac('4cae1d', 'ITY810'), T0)
  store.update(ac('738443', 'AIZ622'), T0)
  const calls: string[] = []
  let reply: { status: number; body: unknown } = { status: 200, body: ITY810 }
  const fetchFn = (async (url: string) => {
    calls.push(url)
    return new Response(JSON.stringify(reply.body), { status: reply.status })
  }) as unknown as typeof fetch
  const r = new AdsbdbRoutes({ bucket: new TokenBucket(100, () => clock.t, () => 0), userAgent: 'test', nowMs: () => clock.t, fetchFn, minIntervalMs: 5000 })
  assert.equal(await r.tick(store, new Set(['4cae1d'])), true)
  assert.deepEqual(calls, [`${ADSBDB_URL}ITY810`])
  assert.equal(store.get('4cae1d')?.route, 'LIRF-LLBG')
  assert.deepEqual(store.dest('4cae1d'), { code: 'LLBG', lat: 32.01139831542969, lon: 34.88669967651367 })
  assert.equal(await r.tick(store, new Set(['4cae1d', '738443'])), false, 'within minIntervalMs')
  clock.t += 5000
  reply = { status: 500, body: null }
  assert.equal(await r.tick(store, new Set(['738443'])), true)
  assert.equal(store.needRoutes(5, new Set(['738443'])).length, 1, 'a failure caches nothing')
  clock.t += 60_000
  reply = { status: 404, body: { response: 'unknown callsign' } }
  await r.tick(store, new Set(['738443']))
  assert.equal(store.needRoutes(5, new Set(['738443'])).length, 0, 'a 404 is a cached miss')
  assert.equal(store.get('738443')?.route, null)
})

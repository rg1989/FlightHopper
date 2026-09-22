// server/infoStore.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeAdsblol } from '../shared/readsb.ts'
import type { ReadsbAircraft } from '../shared/types.ts'
import { InfoStore, MISS_TTL_MS, ROUTE_TTL_MS } from './infoStore.ts'

// adsb.lol envelope, 7 aircraft near KSFO: 71bd79 AAR202, a448f2 UAL1724, a1c7e4 UAL872, a0b88d (no callsign),
// a37732 OPS12, ~a330e6 (TIS-B, nothing but a position), 000001 (LADD)
const KSFO = normalizeAdsblol(readFileSync(new URL('../data/fixtures/golden/adsblol-point-ksfo.json', import.meta.url), 'utf8'))
const byHex = (hex: string): ReadsbAircraft => KSFO.aircraft.find((a) => a.hex === hex)!

const T0 = 2_000_000_000_000

function setup() {
  const clock = { t: T0 }
  return { clock, store: new InfoStore({ nowMs: () => clock.t }) }
}

test('update keeps the newest full object and its info per hex; get and raw take any case', () => {
  const { store } = setup()
  const ac = byHex('a448f2')
  store.update(ac, T0)
  assert.equal(store.raw('A448F2'), ac)
  assert.deepEqual(store.get('a448f2'), {
    hex: 'a448f2', callsign: 'UAL1724', reg: 'N37510', typeCode: 'B39M', category: 'A3', squawk: '2737', emergency: null, military: false, route: null,
  })
  assert.equal(store.rxMs('a448f2'), T0)
  assert.equal(store.get('abcdef'), null)
  assert.equal(store.raw('abcdef'), null)
  assert.equal(store.rxMs('abcdef'), null)

  const newer = { ...ac, seen: 0.1 }
  store.update(newer, T0 + 1000)
  assert.equal(store.raw('a448f2'), newer)
  store.update(ac, T0 + 500) // an older answer arriving late never replaces a newer one
  assert.equal(store.raw('a448f2'), newer)
  assert.equal(store.rxMs('a448f2'), T0 + 1000)
  assert.equal(store.size, 1)
})

test('since: everything when 0, else only infos that changed after sinceRxMs; unknown hexes are skipped', () => {
  const { store } = setup()
  for (const ac of KSFO.aircraft) store.update(ac, T0)
  const hexes = ['71bd79', 'a448f2', 'a1c7e4', 'nothere']
  assert.deepEqual(store.since(hexes, 0).map((i) => i.hex), ['71bd79', 'a448f2', 'a1c7e4'])
  assert.deepEqual(store.since(hexes, T0), [], 'nothing changed after T0')

  // A new position with the same identity is not a change; a new squawk is.
  store.update({ ...byHex('71bd79'), lat: 39 }, T0 + 1000)
  store.update({ ...byHex('a448f2'), squawk: '7700' }, T0 + 1000)
  const changed = store.since(new Set(hexes), T0)
  assert.deepEqual(changed.map((i) => [i.hex, i.squawk]), [['a448f2', '7700']])
  assert.equal(store.changedMs('A448F2'), T0 + 1000)
  assert.equal(store.changedMs('71bd79'), T0)
  assert.equal(store.changedMs('nothere'), null)
})

test('setRoute fills the route of every aircraft with that callsign, marks them changed, and is used for newcomers', () => {
  const { clock, store } = setup()
  store.update(byHex('a1c7e4'), T0) // UAL872
  store.update({ ...byHex('a448f2'), hex: 'aaaaaa', flight: 'UAL872  ' }, T0) // same callsign on another airframe
  store.update(byHex('71bd79'), T0)
  clock.t = T0 + 5000
  store.setRoute('UAL872', 'RJAA-KSFO')
  assert.equal(store.get('a1c7e4')?.route, 'RJAA-KSFO')
  assert.equal(store.get('aaaaaa')?.route, 'RJAA-KSFO')
  assert.equal(store.get('71bd79')?.route, null)
  assert.deepEqual(store.since(['a1c7e4', 'aaaaaa', '71bd79'], T0).map((i) => i.hex), ['a1c7e4', 'aaaaaa'])
  assert.equal(store.changedMs('a1c7e4'), T0 + 5000, 'changed at the store clock')

  // The next update keeps the cached route and is not a change.
  store.update({ ...byHex('a1c7e4'), lat: 40 }, T0 + 6000)
  assert.equal(store.get('a1c7e4')?.route, 'RJAA-KSFO')
  assert.equal(store.changedMs('a1c7e4'), T0 + 5000)
  // An aircraft that shows up later with a cached callsign gets the route at once.
  store.update({ ...byHex('a448f2'), hex: 'bbbbbb', flight: 'UAL872' }, T0 + 7000)
  assert.equal(store.get('bbbbbb')?.route, 'RJAA-KSFO')
  // A miss clears it; a change in the same millisecond as the newest answer is stamped just after it.
  clock.t = T0 + 7000
  store.setRoute('UAL872', null)
  assert.equal(store.get('a1c7e4')?.route, null)
  assert.equal(store.changedMs('bbbbbb'), T0 + 7001)
  assert.equal(store.changedMs('a1c7e4'), T0 + 7000)
})

test('needRoutes: airline-style callsigns with a position and no fresh cached answer, deduped, capped', () => {
  const { clock, store } = setup()
  for (const ac of KSFO.aircraft) store.update(ac, T0)
  store.update({ ...byHex('a448f2'), hex: 'aaaaaa' }, T0) // UAL1724 twice
  store.update({ ...byHex('a448f2'), hex: 'cccccc', flight: 'N37510', lat: undefined, lon: undefined }, T0) // registration, no position
  store.update({ ...byHex('a448f2'), hex: 'dddddd', flight: 'DAL45', lat: undefined }, T0) // no position
  const a448 = byHex('a448f2')
  assert.deepEqual(store.needRoutes(10), [
    { callsign: 'AAR202', lat: byHex('71bd79').lat, lon: byHex('71bd79').lon },
    { callsign: 'UAL1724', lat: a448.lat, lon: a448.lon },
    { callsign: 'UAL872', lat: byHex('a1c7e4').lat, lon: byHex('a1c7e4').lon },
    { callsign: 'OPS12', lat: byHex('a37732').lat, lon: byHex('a37732').lon },
  ])
  assert.equal(store.needRoutes(2).length, 2)
  assert.deepEqual(store.needRoutes(0), [])

  store.setRoute('AAR202', 'RKSI-KSFO')
  store.setRoute('OPS12', null)
  assert.deepEqual(store.needRoutes(10).map((p) => p.callsign), ['UAL1724', 'UAL872'])
  // A miss is asked again after an hour, a route after six; never-asked callsigns come before stale ones.
  clock.t = T0 + MISS_TTL_MS
  assert.deepEqual(store.needRoutes(10).map((p) => p.callsign), ['UAL1724', 'UAL872', 'OPS12'])
  clock.t = T0 + ROUTE_TTL_MS
  assert.deepEqual(store.needRoutes(10).map((p) => p.callsign), ['UAL1724', 'UAL872', 'AAR202', 'OPS12'])
  // A stale route is still shown until the new answer arrives.
  store.update({ ...byHex('71bd79'), lat: 38.5 }, T0 + ROUTE_TTL_MS)
  assert.equal(store.get('71bd79')?.route, 'RKSI-KSFO')
})

test('prune drops aircraft not updated within the horizon, and routes long expired', () => {
  const { clock, store } = setup()
  store.update(byHex('a1c7e4'), T0)
  store.update(byHex('a448f2'), T0 + 100_000)
  store.prune(T0 + 180_000, 180_000)
  assert.equal(store.size, 2, 'exactly at the horizon is kept')
  store.prune(T0 + 180_001, 180_000)
  assert.equal(store.get('a1c7e4'), null)
  assert.equal(store.get('a448f2')?.callsign, 'UAL1724')
  assert.equal(store.size, 1)

  store.setRoute('UAL872', 'RJAA-KSFO') // at T0: expires T0 + 6 h and is forgotten 6 h after that
  clock.t = T0 + 2 * ROUTE_TTL_MS
  store.prune(clock.t, 180_000)
  store.update(byHex('a1c7e4'), clock.t)
  assert.equal(store.get('a1c7e4')?.route, 'RJAA-KSFO')
  clock.t += 1
  store.prune(clock.t, 180_000)
  store.update(byHex('a1c7e4'), clock.t)
  assert.equal(store.get('a1c7e4')?.route, null)
})

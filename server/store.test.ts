// server/store.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SampleStore } from './store.ts'
import type { Sample } from '../shared/types.ts'

const KSFO = { lat: 37.6188, lon: -122.3758 }

const s = (hex: string, tMs: number, rxMs: number, lat = KSFO.lat, lon = KSFO.lon): Sample => ({
  hex, tMs, rxMs, lat, lon, onGround: false, altBaroFt: 5000, altGeomFt: null, gsKt: 200, trackDeg: 90,
  trueHeadingDeg: null, rollDeg: null, baroRateFpm: null, geomRateFpm: null, navQnhHpa: null, version: 2, nic: 8,
  quality: 'adsb2', nM: -32.3, callsign: null, typeCode: null, reg: null,
})

const hexes = (xs: Sample[]): string[] => xs.map((x) => `${x.hex}@${x.tMs}`).sort()

test('add dedupes through Deduper; size counts stored samples', () => {
  const st = new SampleStore()
  assert.equal(st.size, 0)
  assert.equal(st.add(s('a', 1000, 1100)), true)
  assert.equal(st.add(s('a', 1000, 2100)), false) // re-served
  assert.equal(st.add(s('a', 900, 2100, 38)), false) // older
  assert.equal(st.add(s('a', 2000, 2100, 37.62)), true)
  assert.equal(st.add(s('b', 1000, 1100)), true)
  assert.equal(st.size, 3)
})

test('latest(hex) is the newest sample, null for an unknown hex', () => {
  const st = new SampleStore()
  st.add(s('a', 1000, 1100))
  st.add(s('a', 2000, 2100, 37.7))
  assert.equal(st.latest('a')?.tMs, 2000)
  assert.equal(st.latest('zzz'), null)
})

test('view(…, 0) = latest sample per hex whose latest position is inside the circle', () => {
  const st = new SampleStore()
  st.add(s('in', 1000, 1100))
  st.add(s('in', 2000, 2100, 37.7))
  st.add(s('out', 1000, 1100, 40, -122.3)) // ≈ 143 nm north
  st.add(s('left', 1000, 1100)) // was inside…
  st.add(s('left', 2000, 2100, 41, -122.3)) // …now outside
  assert.deepEqual(hexes(st.view(KSFO.lat, KSFO.lon, 40, 0)), ['in@2000'])
  assert.deepEqual(hexes(st.view(KSFO.lat, KSFO.lon, 250, 0)), ['in@2000', 'left@2000', 'out@1000'])
})

test('view(…, since) = every sample received after since, for hexes whose latest is inside', () => {
  const st = new SampleStore()
  st.add(s('a', 1000, 1100, 36.9)) // outside a 40 nm circle, but a's latest is inside
  st.add(s('a', 2000, 2100))
  st.add(s('a', 3000, 3100, 37.62))
  st.add(s('b', 2500, 2600, 41)) // outside
  assert.deepEqual(hexes(st.view(KSFO.lat, KSFO.lon, 40, 1100)), ['a@2000', 'a@3000'])
  assert.deepEqual(hexes(st.view(KSFO.lat, KSFO.lon, 40, 1099)), ['a@1000', 'a@2000', 'a@3000'])
  assert.deepEqual(st.view(KSFO.lat, KSFO.lon, 40, 3100), [])
})

test('track(hex, since) = the samples of one hex received after since, oldest first', () => {
  const st = new SampleStore()
  st.add(s('a', 1000, 1100))
  st.add(s('a', 2000, 2100, 37.7))
  st.add(s('a', 3000, 3100, 37.8))
  st.add(s('b', 3000, 3100))
  assert.deepEqual(st.track('a', 0).map((x) => x.tMs), [1000, 2000, 3000])
  assert.deepEqual(st.track('a', 2100).map((x) => x.tMs), [3000])
  assert.deepEqual(st.track('zzz', 0), [])
})

test('prune drops samples received before now − horizon (180 s by default)', () => {
  const st = new SampleStore()
  st.add(s('a', 1000, 10_000))
  st.add(s('a', 2000, 20_000, 37.7))
  st.add(s('b', 2000, 20_000))
  st.prune(190_000) // cutoff 10_000: rxMs 10_000 is kept
  assert.equal(st.size, 3)
  st.prune(190_001)
  assert.equal(st.size, 2)
  assert.deepEqual(st.track('a', 0).map((x) => x.tMs), [2000])
})

test('prune forgets emptied hexes everywhere, including the Deduper', () => {
  const st = new SampleStore({ horizonMs: 60_000 })
  st.add(s('a', 1000, 1000))
  st.add(s('b', 1000, 50_000))
  st.prune(61_001)
  assert.equal(st.size, 1)
  assert.equal(st.latest('a'), null)
  assert.deepEqual(st.track('a', 0), [])
  assert.deepEqual(hexes(st.view(KSFO.lat, KSFO.lon, 40, 0)), ['b@1000'])
  // the Deduper forgot 'a', so the same position is new again
  assert.equal(st.add(s('a', 1000, 70_000)), true)
  // 'b' was not emptied, so its Deduper memory stays
  assert.equal(st.add(s('b', 1000, 70_000)), false)
})

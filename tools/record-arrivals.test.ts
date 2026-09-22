// tools/record-arrivals.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { destination } from '../shared/geo.ts'
import type { Sample } from '../shared/types.ts'
import { HEROES, pickArrivals, type Hero } from './record-arrivals.ts'

const hero = (ident: string): Hero => HEROES.find((h) => h.ident === ident)!
const KSFO = hero('KSFO')
const LOWI = hero('LOWI')

/** A sample `nm` from the hero on bearing 120°, descending through 3,000 ft unless overridden. */
function smp(hex: string, h: Hero, nm: number, over: Partial<Sample> = {}): Sample {
  const p = destination(h.lat, h.lon, 120, nm)
  return {
    hex, tMs: 1000, rxMs: 1000, lat: p.lat, lon: p.lon, onGround: false, altBaroFt: 3000, altGeomFt: null, gsKt: 160,
    trackDeg: 300, trueHeadingDeg: null, rollDeg: null, baroRateFpm: -800, geomRateFpm: null, navQnhHpa: null,
    version: 2, nic: 8, quality: 'adsb2', nM: 0, callsign: null, typeCode: null, reg: null, ...over,
  }
}

test('pickArrivals: low, descending, within 25 nm of a hero', () => {
  assert.deepEqual(pickArrivals([smp('a00001', KSFO, 10)], HEROES), ['a00001'])
  assert.deepEqual(pickArrivals([smp('a00002', KSFO, 24.5)], HEROES), ['a00002'])
  assert.deepEqual(pickArrivals([smp('a00003', KSFO, 26)], HEROES), [])
})

test('pickArrivals: below 10,000 ft above the field', () => {
  assert.deepEqual(pickArrivals([smp('a00001', KSFO, 10, { altBaroFt: 10_500 })], HEROES), [])
  assert.deepEqual(pickArrivals([smp('a00002', KSFO, 10, { altBaroFt: 9900 })], HEROES), ['a00002'])
  // LOWI's field is at 1,907 ft: 11,000 ft MSL in the Inn valley is 9,093 ft above it
  assert.deepEqual(pickArrivals([smp('a00003', LOWI, 15, { altBaroFt: 11_000 })], HEROES), ['a00003'])
  assert.deepEqual(pickArrivals([smp('a00004', LOWI, 15, { altBaroFt: 12_000 })], HEROES), [])
})

test('pickArrivals: must be descending faster than 300 fpm (baro rate, else geometric rate)', () => {
  assert.deepEqual(pickArrivals([smp('a00001', KSFO, 10, { baroRateFpm: -200 })], HEROES), [])
  assert.deepEqual(pickArrivals([smp('a00002', KSFO, 10, { baroRateFpm: 1500 })], HEROES), [])
  assert.deepEqual(pickArrivals([smp('a00003', KSFO, 10, { baroRateFpm: null, geomRateFpm: -704 })], HEROES), ['a00003'])
  assert.deepEqual(pickArrivals([smp('a00004', KSFO, 10, { baroRateFpm: null })], HEROES), [])
})

test('pickArrivals: no baro altitude falls back to geometric altitude', () => {
  assert.deepEqual(pickArrivals([smp('a00001', KSFO, 10, { altBaroFt: null, altGeomFt: 2500 })], HEROES), ['a00001'])
  assert.deepEqual(pickArrivals([smp('a00002', KSFO, 10, { altBaroFt: null })], HEROES), [])
})

test('pickArrivals: on the ground only while rolling faster than 30 kt', () => {
  const ground = { onGround: true, altBaroFt: null, baroRateFpm: null }
  assert.deepEqual(pickArrivals([smp('a00001', KSFO, 0.5, { ...ground, gsKt: 120 })], HEROES), ['a00001'])
  assert.deepEqual(pickArrivals([smp('a00002', KSFO, 0.5, { ...ground, gsKt: 12 })], HEROES), [])
  assert.deepEqual(pickArrivals([smp('a00003', KSFO, 0.5, { ...ground, gsKt: null })], HEROES), [])
})

test('pickArrivals: the latest sample of each hex decides, whatever the array order', () => {
  const landed = smp('a00001', KSFO, 0.5, { tMs: 9000, onGround: true, altBaroFt: null, baroRateFpm: null, gsKt: 15 })
  const approach = smp('a00001', KSFO, 8, { tMs: 5000 })
  assert.deepEqual(pickArrivals([landed, approach], HEROES), [])
  assert.deepEqual(pickArrivals([approach, landed], HEROES), [])
  const later = smp('a00002', KSFO, 8, { tMs: 9000 })
  const climbing = smp('a00002', KSFO, 4, { tMs: 5000, baroRateFpm: 2000 })
  assert.deepEqual(pickArrivals([later, climbing], HEROES), ['a00002'])
})

test('pickArrivals: one entry per hex even when near two heroes', () => {
  const twin: Hero = { ident: 'TWIN', lat: KSFO.lat + 0.1, lon: KSFO.lon, elevFt: 0 }
  assert.deepEqual(pickArrivals([smp('a00001', KSFO, 5), smp('a00001', KSFO, 5)], [KSFO, twin]), ['a00001'])
})

test('HEROES: the three hero airports with field elevations', () => {
  assert.deepEqual(HEROES.map((h) => h.ident), ['KSFO', 'LLBG', 'LOWI'])
  assert.deepEqual(HEROES.map((h) => h.elevFt), [13, 135, 1907])
})

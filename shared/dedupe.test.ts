import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Deduper } from './dedupe.ts'
import type { Sample } from './types.ts'

const s = (hex: string, tMs: number, lat = 1, lon = 2): Sample => ({
  hex, tMs, rxMs: 0, lat, lon, onGround: false, altBaroFt: null, altGeomFt: null, gsKt: null, trackDeg: null,
  trueHeadingDeg: null, rollDeg: null, baroRateFpm: null, geomRateFpm: null, navQnhHpa: null, version: 2, nic: 8,
  quality: 'adsb2', nM: 0, callsign: null, typeCode: null, reg: null,
})

test('first sample per hex is accepted', () => {
  assert.equal(new Deduper().accept(s('a', 1000)), true)
})

test('re-served position (same tMs within rounding) is rejected', () => {
  const d = new Deduper()
  d.accept(s('a', 1000))
  assert.equal(d.accept(s('a', 1003)), false)
  assert.equal(d.accept(s('a', 1000)), false)
})

test('older sample is rejected', () => {
  const d = new Deduper()
  d.accept(s('a', 1000))
  assert.equal(d.accept(s('a', 900, 5, 5)), false)
})

test('identical position < 100 ms later is rejected; a moved one is accepted', () => {
  const d = new Deduper()
  d.accept(s('a', 1000))
  assert.equal(d.accept(s('a', 1050)), false)
  assert.equal(d.accept(s('a', 1060, 1.0001, 2)), true)
})

test('new position ≥ 100 ms later is accepted even if identical (parked aircraft)', () => {
  const d = new Deduper()
  d.accept(s('a', 1000))
  assert.equal(d.accept(s('a', 1500)), true)
})

test('hexes are independent; forget resets', () => {
  const d = new Deduper()
  d.accept(s('a', 1000))
  assert.equal(d.accept(s('b', 1000)), true)
  d.forget('a')
  assert.equal(d.accept(s('a', 1000)), true)
})

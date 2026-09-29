// client/scene/weather.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { barbs, inRing, sigmetColor, sigmetLabel, viewBox } from './weather.ts'

test('barbs: rounded to 5 kt; pennant 50, full 10, half 5', () => {
  assert.deepEqual(barbs(2), { pennants: 0, full: 0, half: false }) // calm
  assert.deepEqual(barbs(5), { pennants: 0, full: 0, half: true })
  assert.deepEqual(barbs(14), { pennants: 0, full: 1, half: true })
  assert.deepEqual(barbs(23), { pennants: 0, full: 2, half: true })
  assert.deepEqual(barbs(65), { pennants: 1, full: 1, half: true })
  assert.deepEqual(barbs(100), { pennants: 2, full: 0, half: false })
})

test('viewBox: whole degrees outward; null when wider than 40°, crossing the antimeridian, or no view', () => {
  assert.equal(viewBox({ west: 34.2, south: 29.5, east: 35.9, north: 33.1 }), '29,34,34,36')
  assert.equal(viewBox({ west: -10, south: 20, east: 31, north: 30 }), null)
  assert.equal(viewBox({ west: 170, south: 0, east: -170, north: 10 }), null)
  assert.equal(viewBox(null), null)
})

test('sigmet label, colour and point-in-area', () => {
  const s = { hazard: 'TURB', qualifier: 'SEV', base: 0, top: 5500, until: '', raw: '', rings: [] }
  assert.equal(sigmetLabel(s), 'TURB SEV SFC–FL055')
  assert.equal(sigmetLabel({ ...s, hazard: 'TS', qualifier: 'EMBD', base: null, top: 35000 }), 'TS EMBD FL350')
  assert.equal(sigmetLabel({ ...s, qualifier: null, top: null }), 'TURB')
  assert.equal(sigmetColor('TS'), '#ff5a5a')
  assert.equal(sigmetColor('ICE'), '#4fd1ff')
  const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]]
  assert.equal(inRing(sq, 5, 5), true)
  assert.equal(inRing(sq, 15, 5), false)
})

// client/scene/aircraftLayer.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Color } from 'cesium'
import { colorFor } from './aircraftLayer.ts'

test('colorFor: one hue per quality, full opacity while live', () => {
  assert.equal(colorFor('adsb2', false, 'interp'), 'rgba(56, 189, 248, 1)')
  const all = (['adsb2', 'adsb01', 'mlat', 'other'] as const).map((q) => colorFor(q, false, 'interp'))
  assert.equal(new Set(all).size, 4)
  assert.equal(colorFor('mlat', false, 'extrap'), colorFor('mlat', false, 'interp'))
})

test('colorFor: stale is dimmed, less so when selected, and Cesium parses it', () => {
  const alpha = (css: string): number => Color.fromCssColorString(css).alpha
  assert.equal(alpha(colorFor('adsb2', false, 'interp')), 1)
  assert.ok(alpha(colorFor('adsb2', false, 'stale')) < 0.5)
  assert.ok(alpha(colorFor('adsb2', true, 'stale')) > alpha(colorFor('adsb2', false, 'stale')))
  assert.ok(alpha(colorFor('adsb2', true, 'stale')) < 1)
  assert.equal(alpha(colorFor('other', true, 'interp')), 1)
})

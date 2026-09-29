// client/ui/units.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_UNITS, altIn, altLabel, readUnits, speedIn, speedLabel, vsLabel } from './units.ts'

test('conversions and labels: feet, metres; knots, km/h, mph; ft/min, m/s', () => {
  assert.equal(altIn(1000, 'ft'), 1000)
  assert.ok(Math.abs(altIn(1000, 'm') - 304.8) < 1e-9)
  assert.equal(altIn(1000, 'ft+m'), 1000) // "both": feet first
  assert.ok(Math.abs(speedIn(100, 'kmh') - 185.2) < 1e-9)
  assert.ok(Math.abs(speedIn(100, 'mph') - 115.0779) < 1e-6)
  assert.equal(speedIn(100, 'kt+kmh'), 100)
  assert.deepEqual([altLabel('m'), altLabel('ft+m'), speedLabel('kmh'), speedLabel('kt+kmh'), vsLabel('ms')], ['m', 'ft', 'km/h', 'kt', 'm/s'])
  assert.deepEqual(readUnits(null), DEFAULT_UNITS)
  assert.deepEqual(readUnits({ alt: 'm', speed: 'mph', vs: 'ms' }), { alt: 'm', speed: 'mph', vs: 'ms' })
})

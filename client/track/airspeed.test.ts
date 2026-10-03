// client/track/airspeed.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pressureHPa, specificEnergyM, trueAirspeedKt } from './airspeed.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${msg} got ${a}, expected ${b} ± ${tol}`)

test('true airspeed from calibrated, ISA: the flight manual tables', () => {
  near(trueAirspeedKt(150, 0), 150, 0.01, 'sea level: TAS = CAS')
  near(trueAirspeedKt(250, 10_000), 288.7, 0.5, '250 KCAS at 10,000 ft')
  near(trueAirspeedKt(280, 35_000), 473.5, 1, '280 KCAS at FL350 (M 0.82): compressibility counts, 1/√σ alone would give ~503')
  near(trueAirspeedKt(250, 45_000), 522.6, 1, 'above the tropopause (11 km), where the temperature stops falling: M 0.91')
})

test('a measured outside air temperature replaces ISA: warmer air, faster through it', () => {
  const isa = trueAirspeedKt(250, 10_000)
  assert.ok(trueAirspeedKt(250, 10_000, 15) > isa + 5, 'ISA+20 at 10,000 ft') // ISA there is −4.8 °C
  near(trueAirspeedKt(250, 10_000, -4.8), isa, 0.3, 'the ISA temperature itself')
})

test('specific energy: a 250-kt aircraft trading its speed for height climbs ~2,800 ft to a standstill', () => {
  const kt = 1852 / 3600
  near(specificEnergyM(0, 250 * kt), (250 * kt) ** 2 / (2 * 9.80665), 1e-9)
  near(specificEnergyM(1000, 0) - specificEnergyM(0, 250 * kt), 1000 - 843, 1, 'm')
})

test('pressure at a pressure altitude, ISA: the standard atmosphere\'s table, through the tropopause', () => {
  near(pressureHPa(0), 1013.25, 0.01, 'sea level')
  near(pressureHPa(5_000), 843.1, 0.15)
  near(pressureHPa(10_000), 696.8, 0.15)
  near(pressureHPa(18_289), 500, 0.3, 'the 500 hPa level is at 5,574 m')
  near(pressureHPa(30_000), 300.9, 0.15)
  near(pressureHPa(36_089), 226.3, 0.15, 'the tropopause, 11 km')
  near(pressureHPa(39_370), 193.3, 0.2, '12 km, in the stratosphere')
  near(pressureHPa(45_000), 147.5, 0.2)
  near(pressureHPa(-500), 1031.7, 0.2, 'below sea level, a little more')
  assert.equal(pressureHPa(-5_000), pressureHPa(-1_000), 'not below 1,000 ft under, as the airspeed\'s')
})

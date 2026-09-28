// client/track/airspeed.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { specificEnergyM, trueAirspeedKt } from './airspeed.ts'

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

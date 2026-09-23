// client/scene/moon.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cartesian3, Ellipsoid, JulianDate } from 'cesium'
import { moonLitFraction, moonPositionWC, moonWeight } from './moon.ts'
import { sunDirectionWC } from './sun.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${msg} got ${a}, expected ${b} ± ${tol}`)
const LOWI = Cartesian3.fromDegrees(11.3439, 47.2602, 0)
const jd = (iso: string): JulianDate => JulianDate.fromIso8601(iso)
const sunDir = (iso: string): Cartesian3 => sunDirectionWC(jd(iso), new Cartesian3())
/** Degrees above the horizon at LOWI of the Moon at iso. */
function moonElevDeg(iso: string): number {
  const toMoon = Cartesian3.normalize(Cartesian3.subtract(moonPositionWC(jd(iso), new Cartesian3()), LOWI, new Cartesian3()), new Cartesian3())
  const up = Ellipsoid.WGS84.geodeticSurfaceNormal(LOWI, new Cartesian3())
  return (Math.asin(Cartesian3.dot(up, toMoon)) * 180) / Math.PI
}

test('moonPositionWC: the Moon is 356,000–407,000 km away, Earth-fixed', () => {
  for (const iso of ['2026-09-22T19:00:00Z', '2026-09-26T22:30:00Z', '2026-10-10T19:00:00Z']) {
    const d = Cartesian3.magnitude(moonPositionWC(jd(iso), new Cartesian3())) / 1000
    assert.ok(d > 356_000 && d < 407_000, `${iso}: ${d} km`)
  }
})

test('the full moon of 26 Sep 2026 stands high over Innsbruck at 22:30Z; on 10 Oct, new moon, it is below the horizon', () => {
  near(moonElevDeg('2026-09-26T22:30:00Z'), 46.6, 0.5)
  assert.ok(moonElevDeg('2026-10-10T19:00:00Z') < -20)
  assert.ok(moonLitFraction(moonPositionWC(jd('2026-09-26T22:30:00Z'), new Cartesian3()), sunDir('2026-09-26T22:30:00Z')) > 0.99)
  assert.ok(moonLitFraction(moonPositionWC(jd('2026-10-10T19:00:00Z'), new Cartesian3()), sunDir('2026-10-10T19:00:00Z')) < 0.01)
})

test('moonLitFraction: 1 opposite the Sun (full), 0 in line with it (new), ½ at a right angle (quarter)', () => {
  const sun = new Cartesian3(1, 0, 0)
  near(moonLitFraction(new Cartesian3(-384e6, 0, 0), sun), 1, 1e-12)
  near(moonLitFraction(new Cartesian3(384e6, 0, 0), sun), 0, 1e-12)
  near(moonLitFraction(new Cartesian3(0, 384e6, 0), sun), 0.5, 1e-12)
})

test('moonWeight: the lit fraction, faded in from −1° to +10° above the horizon', () => {
  assert.equal(moonWeight(-5, 1), 0)
  assert.equal(moonWeight(-1, 1), 0)
  assert.equal(moonWeight(10, 1), 1)
  assert.equal(moonWeight(45, 0.5), 0.5)
  assert.equal(moonWeight(45, 0), 0)
  let last = 0
  for (let el = -2; el <= 12; el += 0.5) {
    assert.ok(moonWeight(el, 1) >= last, `${el}°`)
    last = moonWeight(el, 1)
  }
})

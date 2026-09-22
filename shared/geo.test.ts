import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bearingDeg, destination, distanceNm } from './geo.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} ${msg}`)

test('one degree of latitude ≈ 60 nm', () => {
  near(distanceNm(0, 0, 1, 0), 60.04, 0.01)
})

test('KSFO → LLBG great-circle distance ≈ 6,437 nm', () => {
  near(distanceNm(37.6188, -122.3758, 32.0114, 34.8867), 6437, 5)
})

test('bearings: north, east, west', () => {
  near(bearingDeg(0, 0, 1, 0), 0, 1e-9)
  near(bearingDeg(0, 0, 0, 1), 90, 1e-9)
  near(bearingDeg(0, 0, 0, -1), 270, 1e-9)
})

test('destination round-trips distance and bearing', () => {
  const p = destination(37.6135, -122.3572, 298, 1.5)
  near(distanceNm(37.6135, -122.3572, p.lat, p.lon), 1.5, 1e-6)
  near(bearingDeg(37.6135, -122.3572, p.lat, p.lon), 298, 1e-6)
})

test('destination wraps longitude across the antimeridian', () => {
  const p = destination(0, 179.9, 90, 30)
  assert.ok(p.lon < -179, `lon=${p.lon}`)
})

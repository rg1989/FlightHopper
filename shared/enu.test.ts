// shared/enu.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ecefToGeodetic, geodeticToEcef, WGS84_A, WGS84_F } from './enu.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)
const dist = (p: number[], q: number[]): number => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])

test('WGS84 defining constants', () => {
  assert.equal(WGS84_A, 6378137)
  assert.equal(WGS84_F, 1 / 298.257223563)
})

test('ECEF of (0, 0, 0) is (a, 0, 0)', () => {
  assert.deepEqual(geodeticToEcef(0, 0, 0), [6378137, 0, 0])
})

test('north pole is (0, 0, b) with b = a(1 − f)', () => {
  const [x, y, z] = geodeticToEcef(90, 0, 0)
  near(x, 0, 1e-6)
  near(y, 0, 1e-6)
  near(z, 6356752.314245179, 1e-6)
})

test('matches an independent implementation (Cesium 1.145 Cartesian3.fromDegrees) at KSFO', () => {
  const p = geodeticToEcef(37.613538, -122.35716, 1234.5)
  assert.ok(dist(p, [-2707928.6898289714, -4274073.204684137, 3872307.2839324432]) < 1e-3, `${p}`)
})

test('geodetic → ECEF → geodetic round-trips < 1 mm for h in [−500, 12000] m, poles included', () => {
  let worst = 0
  for (let lat = -90; lat <= 90; lat += 7.5) {
    for (let lon = -180; lon <= 180; lon += 30) {
      for (const h of [-500, 0, 1234.5, 12000]) {
        const p = geodeticToEcef(lat, lon, h)
        const g = ecefToGeodetic(p[0], p[1], p[2])
        near(g.h, h, 1e-3, `h at ${lat},${lon},${h}`)
        near(g.lat, lat, 1e-9, `lat at ${lat},${lon},${h}`)
        worst = Math.max(worst, dist(geodeticToEcef(g.lat, g.lon, g.h), p))
      }
    }
  }
  assert.ok(worst < 1e-3, `worst ECEF round-trip error ${worst} m`)
})

test('ecefToGeodetic returns degrees and longitude in [−180, 180]', () => {
  const g = ecefToGeodetic(0, -6378137, 0)
  near(g.lat, 0, 1e-12)
  near(g.lon, -90, 1e-12)
  near(g.h, 0, 1e-6)
  const s = ecefToGeodetic(0, 0, -6356752.314245179 - 100)
  near(s.lat, -90, 1e-12)
  near(s.h, 100, 1e-6)
})

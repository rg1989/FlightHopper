// shared/enu.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { destination } from './geo.ts'
import { ecefToGeodetic, Enu, geodeticToEcef, WGS84_A, WGS84_F } from './enu.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)
const dist = (p: number[], q: number[]): number => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
const ecefOf = (g: { lat: number; lon: number; h: number }): number[] => geodeticToEcef(g.lat, g.lon, g.h)

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
        worst = Math.max(worst, dist(ecefOf(g), p))
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

// Meridian (M) and prime-vertical (N) radii of curvature, for building "1 km north / east" test points.
const E2 = WGS84_F * (2 - WGS84_F)
const radii = (latDeg: number): { m: number; n: number } => {
  const s = Math.sin((latDeg * Math.PI) / 180)
  const w = 1 - E2 * s * s
  return { m: (WGS84_A * (1 - E2)) / w ** 1.5, n: WGS84_A / Math.sqrt(w) }
}

const KSFO = { lat: 37.613538, lon: -122.35716, h: 4 }

test('the origin maps to (0, 0, 0)', () => {
  const [e, n, u] = new Enu(KSFO.lat, KSFO.lon, KSFO.h).fwd(KSFO.lat, KSFO.lon, KSFO.h)
  near(e, 0, 1e-9)
  near(n, 0, 1e-9)
  near(u, 0, 1e-9)
})

test('1 km north along the meridian at the same h ≈ (0, 1000, −0.078): u drops by d²/2M', () => {
  const enu = new Enu(KSFO.lat, KSFO.lon, KSFO.h)
  const dLatDeg = (1000 / (radii(KSFO.lat).m + KSFO.h)) * (180 / Math.PI)
  const [e, n, u] = enu.fwd(KSFO.lat + dLatDeg, KSFO.lon, KSFO.h)
  near(e, 0, 1e-6)
  near(n, 1000, 0.01)
  near(u, -0.078, 0.002)
})

test('1 km east along the parallel at the same h ≈ (1000, +0.06, −0.078): east is +e, the parallel bends north', () => {
  const enu = new Enu(KSFO.lat, KSFO.lon, KSFO.h)
  const cosLat = Math.cos((KSFO.lat * Math.PI) / 180)
  const dLonDeg = (1000 / ((radii(KSFO.lat).n + KSFO.h) * cosLat)) * (180 / Math.PI)
  const [e, n, u] = enu.fwd(KSFO.lat, KSFO.lon + dLonDeg, KSFO.h)
  near(e, 1000, 0.01)
  near(n, 0.06, 0.002)
  near(u, -0.078, 0.002)
})

test('up is up: same lat/lon, 500 m higher → (0, 0, 500)', () => {
  const [e, n, u] = new Enu(KSFO.lat, KSFO.lon, KSFO.h).fwd(KSFO.lat, KSFO.lon, KSFO.h + 500)
  near(e, 0, 1e-6)
  near(n, 0, 1e-6)
  near(u, 500, 1e-6)
})

test('matches an independent implementation (Cesium 1.145 eastNorthUpToFixedFrame) near LLBG', () => {
  const enu = new Enu(32.0114, 34.8867, 40)
  const p = enu.fwd(32.2, 35.1, 3000)
  assert.ok(dist(p, [20120.917477197945, 20943.292132342234, 2893.805459712632]) < 1e-3, `${p}`)
})

const ORIGINS = [
  { name: 'KSFO', lat: 37.613538, lon: -122.35716, h: 4 },
  { name: 'LLBG', lat: 32.0114, lon: 34.8867, h: 40 },
  { name: 'LOWI', lat: 47.2588, lon: 11.3309, h: 580 },
  { name: 'near pole', lat: 89.5, lon: 0, h: 0 },
  { name: 'antimeridian', lat: 0, lon: 179.9, h: 0 },
]

test('Enu fwd → inv round-trips < 1 mm within 200 km, h in [−500, 12000] m', () => {
  let worst = 0
  for (const o of ORIGINS) {
    const enu = new Enu(o.lat, o.lon, o.h)
    for (let brg = 0; brg < 360; brg += 30) {
      for (const dNm of [0, 0.5, 27, 108]) {  // 108 nm ≈ 200 km
        for (const h of [-500, 0, 12000]) {
          const q = destination(o.lat, o.lon, brg, dNm)
          const [e, n, u] = enu.fwd(q.lat, q.lon, h)
          const g = enu.inv(e, n, u)
          near(g.h, h, 1e-3, `${o.name} brg ${brg} d ${dNm} h ${h}`)
          worst = Math.max(worst, dist(ecefOf(g), geodeticToEcef(q.lat, q.lon, h)))
        }
      }
    }
  }
  assert.ok(worst < 1e-3, `worst fwd→inv error ${worst} m`)
})

test('Enu inv → fwd round-trips < 1 mm over ±200 km, u in [−500, 12000] m', () => {
  let worst = 0
  for (const o of ORIGINS) {
    const enu = new Enu(o.lat, o.lon, o.h)
    for (let e = -200e3; e <= 200e3; e += 50e3) {
      for (let n = -200e3; n <= 200e3; n += 50e3) {
        for (const u of [-500, 0, 12000]) {
          const g = enu.inv(e, n, u)
          worst = Math.max(worst, dist(enu.fwd(g.lat, g.lon, g.h), [e, n, u]))
        }
      }
    }
  }
  assert.ok(worst < 1e-3, `worst inv→fwd error ${worst} m`)
})

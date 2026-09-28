// client/scene/runwayPaint.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cartesian3, Cartographic, Ellipsoid } from 'cesium'
import type { Runway } from '../../shared/airports.ts'
import { GLYPHS, RUNWAY_STEP_M, designator, runwayGeometryData, thresholdStripesPerSide } from './runwayPaint.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${msg} got ${a}, expected ${b} ± ${tol}`)
const end = (ident: string, lat: number, lon: number, thrHaeM: number, displacedFt = 0): Runway['ends'][number] =>
  ({ ident, lat, lon, thrLat: lat, thrLon: lon, displacedFt, elevFt: 12, hdgTrueDeg: 145, thrHaeM })
// Haneda 1985 15L/33R: 3,078 m, 60 m wide, its ends 0.13 m apart in height
const RWY: Runway = { lengthFt: 10099, widthFt: 197, surface: 'ASP', ends: [end('15L', 35.56189, 139.76002, 39.56), end('33R', 35.539106, 139.77939, 39.69, 300)] }

test('designator: the glyphs a runway end shows, letter first (nearest the threshold), then two digits', () => {
  const at = (c: string): number => GLYPHS.indexOf(c)
  assert.deepEqual(designator('15L'), [at('L'), at('1'), at('5')])
  assert.deepEqual(designator('04'), [-1, at('0'), at('4')])
  assert.deepEqual(designator('4'), [-1, at('0'), at('4')], 'one digit is written with a leading 0')
  assert.deepEqual(designator('27C'), [at('C'), at('2'), at('7')])
  assert.deepEqual(designator('H1'), [-1, -1, -1], 'not a runway number: none')
})

test('threshold stripes: 1.8 m on a 3.6 m pitch from 1.8 m off the centre line to 27 m or 3 m inside the edge', () => {
  assert.equal(thresholdStripesPerSide(60), 7)
  assert.equal(thresholdStripesPerSide(45), 5)
  assert.equal(thresholdStripesPerSide(30), 3)
  assert.equal(thresholdStripesPerSide(18), 1)
})

test('runwayGeometryData: a strip of quads every ≤ 100 m, st in metres (across, along), on the runway plane plus the lift', () => {
  const g = runwayGeometryData(RWY, 0.2)
  const lengthM = 3078
  const rows = g.positions.length / 6
  assert.ok(rows >= Math.ceil(lengthM / RUNWAY_STEP_M) + 1, `${rows} rows`)
  assert.equal(g.st.length, rows * 4)
  assert.equal(g.indices.length, (rows - 1) * 6)
  // the first row: the physical end of 15L, ±30 m across, at its threshold height + lift
  const w = RWY.widthFt * 0.3048
  near(g.st[0], -w / 2, 1e-6)
  near(g.st[2], w / 2, 1e-6)
  near(g.st[1], 0, 1e-6)
  near(g.st[g.st.length - 1], lengthM, 3, 'along at the far end')
  const mid = (i: number): Cartographic => {
    const a = Cartesian3.fromArray(Array.from(g.positions), 6 * i)
    const b = Cartesian3.fromArray(Array.from(g.positions), 6 * i + 3)
    return Ellipsoid.WGS84.cartesianToCartographic(Cartesian3.midpoint(a, b, new Cartesian3()))
  }
  const c0 = mid(0)
  near((c0.latitude * 180) / Math.PI, 35.56189, 1e-6)
  near((c0.longitude * 180) / Math.PI, 139.76002, 1e-6)
  near(c0.height, 39.56 + 0.2, 0.01)
  const cN = mid(rows - 1)
  near((cN.latitude * 180) / Math.PI, 35.539106, 2e-5)
  near(cN.height, 39.69 + 0.2, 0.01)
  near(mid(Math.floor(rows / 2)).height, 39.56 + 0.2 + 0.13 * (g.st[4 * Math.floor(rows / 2) + 1] / lengthM), 0.01, 'mid-runway: on the plane, not a chord under it')
  // every normal is the ellipsoid's up there
  for (let i = 0; i < rows * 2; i++) {
    const p = Cartesian3.fromArray(Array.from(g.positions), 3 * i)
    const up = Ellipsoid.WGS84.geodeticSurfaceNormal(p, new Cartesian3())
    near(Cartesian3.dot(up, Cartesian3.fromArray(Array.from(g.normals), 3 * i)), 1, 1e-6)
  }
  assert.deepEqual([g.thrA, g.thrB], [0, 300 * 0.3048], 'displaced thresholds, metres from each end')
})

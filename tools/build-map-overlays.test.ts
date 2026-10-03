// tools/build-map-overlays.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bordersFrom, encodeLine, insidePoint, seasFrom } from './build-map-overlays.ts'

test('encodeLine: the first point in 1e-4° units, then each step from the one before; a point that rounds onto the last is dropped', () => {
  assert.deepEqual(encodeLine([[34.78, 32.08], [34.7801, 32.0802], [34.78012, 32.08021], [34.8, 32.1]]), [347800, 320800, 1, 2, 199, 198])
  assert.deepEqual(encodeLine([[-122.5, 37.7], [-122.4999, 37.6999]]), [-1225000, 377000, 1, -1])
})

const line = (coordinates: number[][]) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } })
const multi = (coordinates: number[][][]) => ({ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates } })

test('bordersFrom: every line of LineStrings and MultiLineStrings, encoded; a line that rounds to one point is left out', () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      line([[35.1, 33.1], [35.2, 33.05]]),
      multi([[[35.5, 33.2], [35.6, 33.3], [35.7, 33.3]], [[36, 34], [36.00001, 34.00001]]]),
    ],
  }
  assert.deepEqual(bordersFrom(fc), { lines: [[351000, 331000, 1000, -500], [355000, 332000, 1000, 1000, 1000, 0]] })
})

const ring = (pts: number[][]): number[][] => [...pts, pts[0]] // GeoJSON rings are closed
const inRing = (r: number[][], x: number, y: number): boolean => {
  let inside = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i]
    const [xj, yj] = r[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

test('insidePoint: a square\'s middle, the circle reaching its sides', () => {
  const [lon, lat, r] = insidePoint([ring([[0, 0], [10, 0], [10, 10], [0, 10]])])
  assert.ok(Math.abs(lon - 5) < 0.3 && Math.abs(lat - 5) < 0.3, `${lon}, ${lat}`)
  assert.ok(r > 4.7 && r <= 5, `r ${r}`)
})

test('insidePoint: a U\'s middle is outside it; the point found is inside, where the arm meets the base (the widest place)', () => {
  const u = ring([[0, 0], [10, 0], [10, 10], [7, 10], [7, 3], [3, 3], [3, 10], [0, 10]])
  const [lon, lat, r] = insidePoint([u])
  assert.ok(inRing(u, lon, lat), `${lon}, ${lat} is in the notch`)
  assert.ok(r > 1.6, `r ${r}: the corner circle is ~1.76; along an arm only 1.5`)
  assert.ok(lat < 3, `${lat}: in the base`)
})

test('insidePoint: a hole is not inside', () => {
  const outer = ring([[0, 0], [10, 0], [10, 10], [0, 10]])
  const hole = ring([[4, 4], [6, 4], [6, 6], [4, 6]])
  const [lon, lat, r] = insidePoint([outer, hole])
  assert.ok(inRing(outer, lon, lat) && !inRing(hole, lon, lat), `${lon}, ${lat}`)
  assert.ok(r > 2, `r ${r}: a corner's circle (~2.3) beats a side's (2)`)
})

const sea = (name: string | null, featurecla: string, scalerank: number, coordinates: unknown, type = 'Polygon') =>
  ({ type: 'Feature', properties: { name, featurecla, scalerank }, geometry: { type, coordinates } })

test('seasFrom: one point per named ocean, sea, gulf or bay, inside it, with its scalerank; biggest first, then by name', () => {
  const square = (x: number, y: number, s: number): number[][][] => [ring([[x, y], [x + s, y], [x + s, y + s], [x, y + s]])]
  const fc = {
    type: 'FeatureCollection',
    features: [
      sea('Red Sea', 'sea', 1, square(32, 12, 4)),
      sea('Gulf of Aqaba', 'gulf', 4, square(34.5, 28, 0.4)),
      sea('Strait of Tiran', 'strait', 7, square(34.4, 27.9, 0.1)),
      sea(null, 'bay', 8, square(0, 0, 1)),
      sea('INDIAN OCEAN', 'ocean', 0, square(60, -30, 20)),
      // the bigger part holds the point
      sea('Bay of Bengal', 'bay', 1, [square(80, 10, 6), square(95, 15, 1)], 'MultiPolygon'),
    ],
  }
  const got = seasFrom(fc)
  assert.deepEqual(got.map(([name, , , rank]) => [name, rank]), [['Indian Ocean', 0], ['Bay of Bengal', 1], ['Red Sea', 1], ['Gulf of Aqaba', 4]])
  // Near each square's middle (a square wider than tall on the ground holds its circle anywhere along a short line).
  const near = ([, lon, lat]: (typeof got)[number], x: number, y: number, tol: number): boolean => Math.abs(lon - x) <= tol && Math.abs(lat - y) <= tol
  assert.ok(near(got[0], 70, -20, 1), String(got[0]))
  assert.ok(near(got[1], 83, 13, 0.5), `${got[1]}: in the bigger part`)
  assert.ok(near(got[2], 34, 14, 0.3), String(got[2]))
  assert.ok(near(got[3], 34.7, 28.2, 0.05), String(got[3]))
  const twoDecimals = (v: number): boolean => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6
  assert.ok(got.every(([, lon, lat]) => twoDecimals(lon) && twoDecimals(lat)), 'two decimals (1 km)')
})

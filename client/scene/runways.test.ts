// client/scene/runways.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Airport } from '../../shared/airports.ts'
import { bearingDeg, distanceNm } from '../../shared/geo.ts'
import { runwayCorners } from './runways.ts'

const airports: Airport[] = JSON.parse(readFileSync(new URL('../../data/fixtures/golden/airports-sample.json', import.meta.url), 'utf8'))
const ksfo = airports.find((a) => a.ident === 'KSFO')!
const rwy = ksfo.runways.find((r) => r.ends[1].ident === '28R')! // ends: [10L, 28R]
const [e10L, e28R] = rwy.ends

const m = (lat1: number, lon1: number, lat2: number, lon2: number): number => distanceNm(lat1, lon1, lat2, lon2) * 1852
const turn = (from: number, to: number): number => ((to - from + 540) % 360) - 180
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)

test('KSFO 10L/28R: four corners, 10L end first, heights from each end', () => {
  const c = runwayCorners(rwy)
  assert.equal(c.length, 4)
  assert.deepEqual(c.map((p) => p.h), [-30.79, -30.79, -28.3, -28.3])
})

test('width: 200 ft across each physical end, centred on it', () => {
  const [a, b, c, d] = runwayCorners(rwy)
  near(m(a.lat, a.lon, b.lat, b.lon), 60.96, 0.01, 'width at 10L')
  near(m(c.lat, c.lon, d.lat, d.lon), 60.96, 0.01, 'width at 28R')
  for (const p of [a, b]) near(m(e10L.lat, e10L.lon, p.lat, p.lon), 30.48, 0.01, 'half width at 10L')
  for (const p of [c, d]) near(m(e28R.lat, e28R.lon, p.lat, p.lon), 30.48, 0.01, 'half width at 28R')
})

test('ring order: left then right of 10L, right then left of 28R (a rectangle, not a bow tie)', () => {
  const [a, b, c, d] = runwayCorners(rwy)
  const brg = bearingDeg(e10L.lat, e10L.lon, e28R.lat, e28R.lon) // 10L → 28R ≈ 117.9° true
  near(turn(brg, bearingDeg(e10L.lat, e10L.lon, a.lat, a.lon)), -90, 0.01, 'a is left of 10L')
  near(turn(brg, bearingDeg(e10L.lat, e10L.lon, b.lat, b.lon)), 90, 0.01, 'b is right of 10L')
  near(turn(brg, bearingDeg(e28R.lat, e28R.lon, c.lat, c.lon)), 90, 0.05, 'c is right of 28R')
  near(turn(brg, bearingDeg(e28R.lat, e28R.lon, d.lat, d.lon)), -90, 0.05, 'd is left of 28R')
})

test('length: both long sides equal the end-to-end distance, within 0.5 % of the published 11,870 ft', () => {
  const [a, b, c, d] = runwayCorners(rwy)
  const centre = m(e10L.lat, e10L.lon, e28R.lat, e28R.lon)
  near(m(b.lat, b.lon, c.lat, c.lon), centre, 0.05, 'right side')
  near(m(a.lat, a.lon, d.lat, d.lon), centre, 0.05, 'left side')
  near(centre, 11870 * 0.3048, 11870 * 0.3048 * 0.005, 'published length')
})

test('every golden runway: rectangle as wide as published, as long as its ends are apart', () => {
  for (const ap of airports) {
    for (const r of ap.runways) {
      const [a, b, c, d] = runwayCorners(r)
      const [x, y] = r.ends
      const name = `${ap.ident} ${x.ident}/${y.ident}`
      near(m(a.lat, a.lon, b.lat, b.lon), r.widthFt * 0.3048, 0.01, name)
      near(m(b.lat, b.lon, c.lat, c.lon), m(x.lat, x.lon, y.lat, y.lon), 0.05, name)
      assert.deepEqual([a.h, b.h, c.h, d.h], [x.thrHaeM, x.thrHaeM, y.thrHaeM, y.thrHaeM], name)
    }
  }
})

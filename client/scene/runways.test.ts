// client/scene/runways.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Cartographic, EntityCollection, JulianDate, PolygonGeometry, Primitive, type GeometryInstance, type Viewer } from 'cesium'
import type { Airport } from '../../shared/airports.ts'
import { bearingDeg, distanceNm } from '../../shared/geo.ts'
import { addRunways, RUNWAY_LIFT_M, runwayCorners } from './runways.ts'

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

// addRunways against a stand-in viewer: the scene's primitive list and an entity collection are all it touches.
// (Labels only need a DOM once Cesium renders them, so this runs in Node.)
function fakeViewer(): { viewer: Viewer; added: unknown[]; removed: unknown[]; entities: EntityCollection } {
  const added: unknown[] = []
  const removed: unknown[] = []
  const entities = new EntityCollection()
  const primitives = { add: (p: unknown) => (added.push(p), p), remove: (p: unknown) => (removed.push(p), true) }
  const viewer = { scene: { primitives }, entities, isDestroyed: () => false } as unknown as Viewer
  return { viewer, added, removed, entities }
}

const deg = (rad: number): number => (rad * 180) / Math.PI
const now = JulianDate.now()

test('addRunways: one batched polygon primitive for all runways, one marker per threshold', () => {
  const { viewer, added, entities } = fakeViewer()
  addRunways(viewer, airports)
  const runways = airports.flatMap((a) => a.runways)
  assert.equal(added.length, 1)
  const prim = added[0] as Primitive
  assert.ok(prim instanceof Primitive)
  assert.equal((prim.geometryInstances as unknown[]).length, runways.length)
  assert.equal(entities.values.length, runways.length * 2)
  const ksfoLabels = entities.values.slice(0, 8).map((e) => e.label!.text!.getValue(now))
  assert.deepEqual(ksfoLabels, ['10L', '28R', '10R', '28L', '1L', '19R', '1R', '19L'])
})

test('addRunways: the polygon sits on the corners, lifted RUNWAY_LIFT_M; the marker sits on the threshold', () => {
  const { viewer, added, entities } = fakeViewer()
  addRunways(viewer, [{ ...ksfo, runways: [rwy] }])
  const instance = ((added[0] as Primitive).geometryInstances as GeometryInstance[])[0]
  const geom = PolygonGeometry.createGeometry(instance.geometry as unknown as PolygonGeometry)!
  const v = geom.attributes.position!.values as unknown as number[]
  assert.equal(v.length, 4 * 3)
  const corners = runwayCorners(rwy)
  for (let i = 0; i < 4; i++) {
    const c = Cartographic.fromCartesian({ x: v[3 * i], y: v[3 * i + 1], z: v[3 * i + 2] } as never)
    near(deg(c.latitude), corners[i].lat, 1e-7, `corner ${i} lat`)
    near(deg(c.longitude), corners[i].lon, 1e-7, `corner ${i} lon`)
    near(c.height, corners[i].h + RUNWAY_LIFT_M, 0.01, `corner ${i} h`)
  }
  assert.equal(geom.indices!.length, 2 * 3) // two flat triangles: a plane, no subdivision
  const p = Cartographic.fromCartesian(entities.values[1].position!.getValue(now)!)
  near(deg(p.latitude), e28R.thrLat, 1e-7)
  near(deg(p.longitude), e28R.thrLon, 1e-7)
  near(p.height, e28R.thrHaeM + RUNWAY_LIFT_M, 0.01)
})

test('addRunways: destroy removes exactly what it added; no airports adds nothing', () => {
  const { viewer, added, removed, entities } = fakeViewer()
  entities.add({ id: 'someone-else' })
  const h = addRunways(viewer, airports)
  h.destroy()
  assert.deepEqual(removed, added)
  assert.deepEqual(entities.values.map((e) => e.id), ['someone-else'])
  const empty = fakeViewer()
  addRunways(empty.viewer, []).destroy()
  assert.equal(empty.added.length, 0)
  assert.equal(empty.removed.length, 0)
})

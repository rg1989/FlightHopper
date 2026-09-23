// client/scene/runways.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  Cartesian3,
  Cartographic,
  Color,
  Ellipsoid,
  EntityCollection,
  JulianDate,
  MaterialAppearance,
  Matrix3,
  Matrix4,
  PolygonGeometry,
  Primitive,
  ShadowMode,
  type GeometryInstance,
  type Viewer,
} from 'cesium'
import type { Airport } from '../../shared/airports.ts'
import { bearingDeg, distanceNm } from '../../shared/geo.ts'
import type { TerrainFrame } from '../types.ts'
import { TOPO_ON, drawnHeightM } from './exaggeration.ts'
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
// A Material types its uniforms with instanceof checks against these DOM classes (Material.js getUniformType); Node has none.
Object.assign(globalThis, { HTMLCanvasElement: class {}, HTMLImageElement: class {}, ImageBitmap: class {}, OffscreenCanvas: class {} })

const deg = (rad: number): number => (rad * 180) / Math.PI
const now = JulianDate.now()
const ASPHALT = Color.fromCssColorString('#3a3a3a')
/** An airport's runway height: the mean of its thresholds' thrHaeM (KSFO −29.32, LLBG 56.57, LOWI 627.72 m). */
const runwayHM = (ap: Airport): number => {
  const hs = ap.runways.flatMap((r) => r.ends.map((e) => e.thrHaeM))
  return hs.reduce((s, h) => s + h, 0) / hs.length
}
/**
 * A point update() placed, built at true height hM (+ the lift) at lat/lon of airport ap: on the terrain drawn there
 * (+ the lift), never under it, and above it by at most the Earth's curvature under the airport's plane, which one scale
 * along its up cannot follow: (1 − f)·d²/2R, 0.5 m 2.5 km out when flat. Not moved sideways.
 */
function onDrawnTerrain(ap: Airport, fr: TerrainFrame, at: Cartesian3, lat: number, lon: number, hM: number, what: string): void {
  const c = Cartographic.fromCartesian(at)
  const name = `${ap.ident} ${what} at f ${fr.fNow}`
  const overM = c.height - (drawnHeightM(hM, fr.fNow, fr.relHM) + RUNWAY_LIFT_M)
  const d = m(ap.lat, ap.lon, lat, lon)
  assert.ok(overM >= -0.01 && overM <= (Math.max(0, 1 - fr.fNow) * d * d) / (2 * 6.3e6) + 0.01, `${name}: ${overM} m over the drawn terrain`)
  // along the airport's up, not each point's: 2 km away they differ by 0.02°, 0.2 m sideways per 650 m of shift
  near(m(deg(c.latitude), deg(c.longitude), lat, lon), 0, 0.5, `${name} sideways`)
}

test('addRunways: one lit polygon primitive per airport, one marker per threshold', () => {
  const { viewer, added, entities } = fakeViewer()
  addRunways(viewer, [...airports, { ...ksfo, ident: 'XXXX', runways: [] }])
  assert.equal(added.length, airports.length, 'an airport without runways adds nothing')
  airports.forEach((ap, i) => {
    const prim = added[i] as Primitive
    assert.ok(prim instanceof Primitive)
    assert.equal((prim.geometryInstances as unknown[]).length, ap.runways.length, ap.ident)
    const look = prim.appearance as MaterialAppearance
    assert.ok(look instanceof MaterialAppearance)
    assert.equal(look.flat, false, 'lit: darkens with the scene light')
    assert.equal(look.translucent, false)
    assert.equal(look.material.type, 'Color')
    assert.ok(Color.equals(look.material.uniforms.color as Color, ASPHALT), 'asphalt')
    assert.equal(prim.shadows, ShadowMode.DISABLED, 'casts and receives no shadows (D10)')
    assert.ok(Matrix4.equals(prim.modelMatrix, Matrix4.IDENTITY), 'unmoved until update')
  })
  const runways = airports.flatMap((a) => a.runways)
  assert.equal(entities.values.length, runways.length * 2)
  const ksfoLabels = entities.values.slice(0, 8).map((e) => e.label!.text!.getValue(now))
  assert.deepEqual(ksfoLabels, ['10L', '28R', '10R', '28L', '1L', '19R', '1R', '19L'])
})

test('addRunways: the polygon sits on the corners, lifted RUNWAY_LIFT_M, lit along its local up; the marker sits on the threshold', () => {
  const { viewer, added, entities } = fakeViewer()
  addRunways(viewer, [{ ...ksfo, runways: [rwy] }])
  const instance = ((added[0] as Primitive).geometryInstances as GeometryInstance[])[0]
  const geom = PolygonGeometry.createGeometry(instance.geometry as unknown as PolygonGeometry)!
  const v = geom.attributes.position!.values as unknown as number[]
  const n = geom.attributes.normal!.values as unknown as number[]
  assert.equal(v.length, 4 * 3)
  const corners = runwayCorners(rwy)
  for (let i = 0; i < 4; i++) {
    const p = new Cartesian3(v[3 * i], v[3 * i + 1], v[3 * i + 2])
    const c = Cartographic.fromCartesian(p)
    near(deg(c.latitude), corners[i].lat, 1e-7, `corner ${i} lat`)
    near(deg(c.longitude), corners[i].lon, 1e-7, `corner ${i} lon`)
    near(c.height, corners[i].h + RUNWAY_LIFT_M, 0.01, `corner ${i} h`)
    const up = Ellipsoid.WGS84.geodeticSurfaceNormal(p)
    near(Cartesian3.dot(up, new Cartesian3(n[3 * i], n[3 * i + 1], n[3 * i + 2])), 1, 1e-6, `corner ${i} normal`)
  }
  assert.equal(geom.indices!.length, 2 * 3) // two flat triangles: a plane, no subdivision
  const p = Cartographic.fromCartesian(entities.values[1].position!.getValue(now)!)
  near(deg(p.latitude), e28R.thrLat, 1e-7)
  near(deg(p.longitude), e28R.thrLon, 1e-7)
  near(p.height, e28R.thrHaeM + RUNWAY_LIFT_M, 0.01)
})

test('update: each airport lies on the drawn terrain, its runways flattened with it, its markers with them, lit along up', () => {
  const lowi = airports.find((a) => a.ident === 'LOWI')!
  const llbg = airports.find((a) => a.ident === 'LLBG')!
  const frames: TerrainFrame[] = [
    { fSampled: TOPO_ON, fNow: 0, relHM: runwayHM(lowi) }, // flat around LOWI's runway: KSFO rises 657 m, LLBG 571 m
    { fSampled: 1e-7, fNow: 1e-7, relHM: runwayHM(llbg) }, // flat around LLBG after the nudge: its 08/26 spans −7.4 to +1.0 m
    { fSampled: 0.51, fNow: 0.5, relHM: 0 }, // mid-animation around the ellipsoid: LOWI sinks 314 m
    { fSampled: TOPO_ON, fNow: TOPO_ON, relHM: runwayHM(lowi) }, // on: KSFO 7 mm down, LOWI not at all
  ]
  for (const fr of frames) {
    const { viewer, added, entities } = fakeViewer()
    addRunways(viewer, airports).update(fr)
    let marker = 0
    airports.forEach((ap, i) => {
      const prim = added[i] as Primitive
      Matrix4.inverse(prim.modelMatrix, new Matrix4()) // Cesium inverts it (czm_normal, relative-to-eye): a singular one throws
      // czm_normal without the view: the inverse transpose of the model's 3 × 3
      const normalM = Matrix3.transpose(Matrix3.inverse(Matrix4.getMatrix3(prim.modelMatrix, new Matrix3()), new Matrix3()), new Matrix3())
      ap.runways.forEach((r, j) => {
        const g = (prim.geometryInstances as GeometryInstance[])[j].geometry as unknown as PolygonGeometry
        const geom = PolygonGeometry.createGeometry(g)!
        const v = geom.attributes.position!.values as unknown as number[]
        const n = geom.attributes.normal!.values as unknown as number[]
        for (const [k, c] of runwayCorners(r).entries()) {
          const at = Matrix4.multiplyByPoint(prim.modelMatrix, new Cartesian3(v[3 * k], v[3 * k + 1], v[3 * k + 2]), new Cartesian3())
          onDrawnTerrain(ap, fr, at, c.lat, c.lon, c.h, `${r.ends[0].ident} corner ${k}`)
          const lit = Matrix3.multiplyByVector(normalM, new Cartesian3(n[3 * k], n[3 * k + 1], n[3 * k + 2]), new Cartesian3())
          const up = Ellipsoid.WGS84.geodeticSurfaceNormal(at)
          // each plane's own normal: within its slope of up (0.16° at LLBG 08/26), less as it flattens
          near(Cartesian3.dot(Cartesian3.normalize(lit, lit), up), 1, 1e-5, `${ap.ident} ${r.ends[0].ident} corner ${k} lit along up`)
        }
        for (const e of r.ends) onDrawnTerrain(ap, fr, entities.values[marker++].position!.getValue(now)!, e.thrLat, e.thrLon, e.thrHaeM, e.ident)
      })
    })
  }
})

test('update: recomputes only when the factor or relH changes, and ignores a non-finite frame', () => {
  const { viewer, added, entities } = fakeViewer()
  const rw = addRunways(viewer, [ksfo])
  const prim = added[0] as Primitive
  const markerH = (): number => Cartographic.fromCartesian(entities.values[0].position!.getValue(now)!).height
  rw.update({ fSampled: 1, fNow: 1, relHM: 0 })
  assert.ok(Matrix4.equals(prim.modelMatrix, Matrix4.IDENTITY), 'factor 1: the terrain as loaded, nothing moves')
  near(markerH(), e10L.thrHaeM + RUNWAY_LIFT_M, 0.01)
  rw.update({ fSampled: TOPO_ON, fNow: 0.5, relHM: 100 })
  const moved = Matrix4.clone(prim.modelMatrix)
  const placedH = markerH()
  Matrix4.clone(Matrix4.IDENTITY, prim.modelMatrix) // shows whether update() writes the matrix again
  rw.update({ fSampled: 0.5, fNow: 0.5, relHM: 100 }) // only fSampled differs: nothing to do
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    rw.update({ fSampled: 0.5, fNow: bad, relHM: 100 })
    rw.update({ fSampled: 0.5, fNow: 0.5, relHM: bad })
  }
  assert.ok(Matrix4.equals(prim.modelMatrix, Matrix4.IDENTITY), 'not rewritten')
  assert.equal(markerH(), placedH, 'markers keep the last good place')
  rw.update({ fSampled: 0.5, fNow: 0.5, relHM: 200 }) // relH alone: a re-latch while flat
  assert.ok(!Matrix4.equals(prim.modelMatrix, Matrix4.IDENTITY), 'a new relH rewrites it')
  near(markerH() - placedH, 50, 0.01, 'markers too: a plane 100 m higher, at f 0.5')
  Matrix4.clone(Matrix4.IDENTITY, prim.modelMatrix)
  rw.update({ fSampled: 0.5, fNow: 0.4, relHM: 200 }) // the factor alone
  assert.ok(!Matrix4.equals(prim.modelMatrix, Matrix4.IDENTITY), 'a new factor rewrites it')
  rw.update({ fSampled: 0.4, fNow: 0.5, relHM: 100 })
  assert.ok(Matrix4.equals(prim.modelMatrix, moved), 'the same frame, the same place')
  assert.equal(markerH(), placedH)
})

test('setLight: the planes darken as the day imagery does under WP-E2’s light (czm_phong keeps half the colour unlit)', () => {
  const { viewer, added } = fakeViewer()
  const rw = addRunways(viewer, airports)
  const colours = added.map((p) => ((p as Primitive).appearance as MaterialAppearance).material.uniforms.color as Color)
  const paint = colours[0]
  assert.ok(colours.every((c) => c === paint), 'one Color that every airport reads')
  const k = (): number => paint.red / ASPHALT.red
  rw.setLight({ dayBrightness: 0.9999, intensity: 2 }) // by day
  near(k(), 0.9999, 1e-9)
  rw.setLight({ dayBrightness: 0.3, intensity: 0.45 }) // at night
  // seen from above czm_phong draws k·colour·(0.5 + 0.5·czm_lightColor); the day imagery gets dayBrightness × czm_lightColor
  near(k() * (0.5 + 0.5 * 0.45), 0.3 * 0.45, 1e-9, 'as dark as the imagery around it')
  near(paint.green / ASPHALT.green, k(), 1e-9)
  near(paint.blue / ASPHALT.blue, k(), 1e-9)
  assert.equal(paint.alpha, 1, 'still opaque')
  const night = k()
  for (const bad of [{ dayBrightness: Number.NaN, intensity: 2 }, { dayBrightness: 0.3, intensity: Number.NaN }, { dayBrightness: 0.3, intensity: -1 }]) {
    rw.setLight(bad)
  }
  assert.equal(k(), night, 'a non-finite k is ignored')
  rw.setLight(null) // the Sun off
  assert.ok(Color.equals(paint, ASPHALT), 'as built')
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

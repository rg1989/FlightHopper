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
  Event,
  HorizontalOrigin,
  JulianDate,
  MaterialAppearance,
  Matrix3,
  Matrix4,
  Primitive,
  ShadowMode,
  type Geometry,
  VerticalOrigin,
  type Cartesian2,
  type GeometryInstance,
  type Viewer,
} from 'cesium'
import type { Airport } from '../../shared/airports.ts'
import { bearingDeg, distanceNm } from '../../shared/geo.ts'
import type { TerrainFrame } from '../types.ts'
import { TOPO_ON, drawnHeightM } from './exaggeration.ts'
import { northAt } from './fleetLayer.ts'
import { addRunways, compassWord, keepOnScreen, labelSide, RUNWAY_LIFT_M, runwayCorners, runwayTip } from './runways.ts'

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

// addRunways against a stand-in viewer: the scene's primitive list, an entity collection, and for the markers a camera
// 10 km above (LAT0, LON0) looking straight down, north up, PX_PER_DEG pixels to a degree of latitude, (600, 400) under it.
// (Labels only need a DOM once Cesium renders them, so this runs in Node.)
const LAT0 = 32.0
const LON0 = 34.88
const PX_PER_DEG = 10_000
function fakeViewer(): { viewer: Viewer; added: unknown[]; removed: unknown[]; entities: EntityCollection; preRender: Event } {
  const added: unknown[] = []
  const removed: unknown[] = []
  const entities = new EntityCollection()
  const primitives = { add: (p: unknown) => (added.push(p), p), remove: (p: unknown) => (removed.push(p), true) }
  const preRender = new Event()
  const cartesianToCanvasCoordinates = (p: Cartesian3, out: Cartesian2): Cartesian2 => {
    const c = Cartographic.fromCartesian(p)
    out.x = 600 + (deg(c.longitude) - LON0) * PX_PER_DEG * Math.cos(LAT0 * (Math.PI / 180))
    out.y = 400 - (deg(c.latitude) - LAT0) * PX_PER_DEG
    return out
  }
  const camera = { positionWC: Cartesian3.fromDegrees(LON0, LAT0, 10_000) }
  const scene = { primitives, preRender, camera, cartesianToCanvasCoordinates, canvas: { clientWidth: 1200, clientHeight: 800 } }
  const viewer = { scene, entities, isDestroyed: () => false } as unknown as Viewer
  return { viewer, added, removed, entities, preRender }
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

/** Each runway's primitive, in the order addRunways added them: airport by airport, runway by runway. */
const primsOf = (added: unknown[]): Primitive[] => added as Primitive[]
const geometryOf = (p: Primitive): Geometry => (p.geometryInstances as GeometryInstance).geometry as Geometry
const valuesOf = (g: Geometry, name: 'position' | 'normal'): number[] => Array.from(g.attributes[name]!.values as ArrayLike<number>)

test('addRunways: one lit, painted primitive per runway, one marker per threshold', () => {
  const { viewer, added, entities } = fakeViewer()
  addRunways(viewer, [...airports, { ...ksfo, ident: 'XXXX', runways: [] }])
  const runways = airports.flatMap((a) => a.runways)
  assert.equal(added.length, runways.length, 'an airport without runways adds nothing')
  for (const prim of primsOf(added)) {
    assert.ok(prim instanceof Primitive)
    const look = prim.appearance as MaterialAppearance
    assert.ok(look instanceof MaterialAppearance)
    assert.equal(look.flat, false, 'lit: darkens with the scene light')
    assert.equal(look.translucent, false)
    assert.ok(Color.equals(look.material.uniforms.asphalt as Color, ASPHALT), 'asphalt')
    assert.equal(prim.shadows, ShadowMode.DISABLED, 'casts and receives no shadows (D10)')
    assert.ok(Matrix4.equals(prim.modelMatrix, Matrix4.IDENTITY), 'unmoved until update')
    assert.equal(prim.compressVertices, false, 'st in metres survives (compression packs it into [0, 1])')
  }
  assert.equal(entities.values.length, runways.length * 2)
  const ksfoLabels = entities.values.slice(0, 8).map((e) => e.label!.text!.getValue(now))
  assert.deepEqual(ksfoLabels, ['10L', '28R', '10R', '28L', '1L', '19R', '1R', '19L'])
})

test('addRunways: the painted strip spans the corners, lifted RUNWAY_LIFT_M, lit along its local up; the marker sits on the threshold', () => {
  const { viewer, added, entities } = fakeViewer()
  addRunways(viewer, [{ ...ksfo, runways: [rwy] }])
  const geom = geometryOf(primsOf(added)[0])
  const v = valuesOf(geom, 'position')
  const n = valuesOf(geom, 'normal')
  const rows = v.length / 6
  assert.ok(rows >= Math.ceil((11870 * 0.3048) / 100) + 1, `a quad every 100 m or less: ${rows} rows`)
  const corners = runwayCorners(rwy) // left, right of 10L; right, left of 28R
  for (const [i, k] of [[0, 0], [1, 1], [2, 2 * rows - 1], [3, 2 * rows - 2]]) {
    const c = Cartographic.fromCartesian(new Cartesian3(v[3 * k], v[3 * k + 1], v[3 * k + 2]))
    near(deg(c.latitude), corners[i].lat, 2e-6, `corner ${i} lat`)
    near(deg(c.longitude), corners[i].lon, 2e-6, `corner ${i} lon`)
    near(c.height, corners[i].h + RUNWAY_LIFT_M, 0.01, `corner ${i} h`)
  }
  for (let k = 0; k < 2 * rows; k++) {
    const p = new Cartesian3(v[3 * k], v[3 * k + 1], v[3 * k + 2])
    near(Cartesian3.dot(Ellipsoid.WGS84.geodeticSurfaceNormal(p), new Cartesian3(n[3 * k], n[3 * k + 1], n[3 * k + 2])), 1, 1e-6, `vertex ${k} normal`)
  }
  assert.equal(geom.indices!.length, (rows - 1) * 6)
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
    let next = 0
    for (const ap of airports) {
      for (const r of ap.runways) {
        const prim = primsOf(added)[next++]
        Matrix4.inverse(prim.modelMatrix, new Matrix4()) // Cesium inverts it (czm_normal, relative-to-eye): a singular one throws
        // czm_normal without the view: the inverse transpose of the model's 3 × 3
        const normalM = Matrix3.transpose(Matrix3.inverse(Matrix4.getMatrix3(prim.modelMatrix, new Matrix3()), new Matrix3()), new Matrix3())
        const geom = geometryOf(prim)
        const v = valuesOf(geom, 'position')
        const n = valuesOf(geom, 'normal')
        for (let k = 0; k < v.length / 3; k += 7) { // every 7th vertex: both edges, all along
          const built = Cartographic.fromCartesian(new Cartesian3(v[3 * k], v[3 * k + 1], v[3 * k + 2]))
          const at = Matrix4.multiplyByPoint(prim.modelMatrix, new Cartesian3(v[3 * k], v[3 * k + 1], v[3 * k + 2]), new Cartesian3())
          onDrawnTerrain(ap, fr, at, deg(built.latitude), deg(built.longitude), built.height - RUNWAY_LIFT_M, `${r.ends[0].ident} vertex ${k}`)
          const lit = Matrix3.multiplyByVector(normalM, new Cartesian3(n[3 * k], n[3 * k + 1], n[3 * k + 2]), new Cartesian3())
          const up = Ellipsoid.WGS84.geodeticSurfaceNormal(at)
          near(Cartesian3.dot(Cartesian3.normalize(lit, lit), up), 1, 1e-5, `${ap.ident} ${r.ends[0].ident} vertex ${k} lit along up`)
        }
        for (const e of r.ends) onDrawnTerrain(ap, fr, entities.values[marker++].position!.getValue(now)!, e.thrLat, e.thrLon, e.thrHaeM, e.ident)
      }
    }
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
  const uniforms = added.map((p) => ((p as Primitive).appearance as MaterialAppearance).material.uniforms)
  const paint = uniforms[0].asphalt as Color
  const white = uniforms[0].paint as Color
  assert.ok(uniforms.every((u) => u.asphalt === paint && u.paint === white), 'one asphalt and one paint Color every runway reads')
  const whiteBy = (): number => white.red / Color.fromCssColorString('#e4e4dc').red
  const k = (): number => paint.red / ASPHALT.red
  rw.setLight({ dayBrightness: 0.9999, intensity: 2 }) // by day
  near(k(), 0.9999, 1e-9)
  rw.setLight({ dayBrightness: 0.3, intensity: 0.45 }) // at night
  // seen from above czm_phong draws k·colour·(0.5 + 0.5·czm_lightColor); the day imagery gets dayBrightness × czm_lightColor
  near(k() * (0.5 + 0.5 * 0.45), 0.3 * 0.45, 1e-9, 'as dark as the imagery around it')
  near(paint.green / ASPHALT.green, k(), 1e-9)
  near(paint.blue / ASPHALT.blue, k(), 1e-9)
  near(whiteBy(), k(), 1e-9, 'the markings darken as much')
  assert.equal(paint.alpha, 1, 'still opaque')
  const night = k()
  for (const bad of [{ dayBrightness: Number.NaN, intensity: 2 }, { dayBrightness: 0.3, intensity: Number.NaN }, { dayBrightness: 0.3, intensity: -1 }]) {
    rw.setLight(bad)
  }
  assert.equal(k(), night, 'a non-finite k is ignored')
  rw.setLight(null) // the Sun off
  assert.ok(Color.equals(paint, ASPHALT), 'as built')
})

test('addRunways: markers off (a scenario airfield): the runways, no threshold dots', () => {
  const { viewer, added, entities } = fakeViewer()
  addRunways(viewer, [ksfo], { markers: false })
  assert.equal(added.length, ksfo.runways.length)
  assert.equal(entities.values.length, 0)
})

test('addRunways: destroy removes exactly what it added; no airports adds nothing', () => {
  const { viewer, added, removed, entities, preRender } = fakeViewer()
  entities.add({ id: 'someone-else' })
  const h = addRunways(viewer, airports)
  h.destroy()
  assert.deepEqual(removed, added)
  assert.deepEqual(entities.values.map((e) => e.id), ['someone-else'])
  assert.equal(preRender.numberOfListeners, 0, 'stops aiming the labels')
  const empty = fakeViewer()
  addRunways(empty.viewer, []).destroy()
  assert.equal(empty.added.length, 0)
  assert.equal(empty.removed.length, 0)
})

test('compassWord: the 8-point compass of a true heading, any number of turns', () => {
  const cases: [number, string][] = [
    [0, 'north'], [22.4, 'north'], [22.6, 'northeast'], [80, 'east'], [121.4, 'southeast'], [209, 'southwest'],
    [260, 'west'], [298, 'northwest'], [337.6, 'north'], [360, 'north'], [-10, 'north'], [-100, 'west'], [725, 'north'],
  ]
  for (const [d, w] of cases) assert.equal(compassWord(d), w, `${d}°`)
})

test('runwayTip: which way planes go on it, how long it is, and which of the parallels it is', () => {
  const llbg = airports.find((a) => a.ident === 'LLBG')!
  const tip = (ap: Airport, ident: string): string => {
    const r = ap.runways.find((x) => x.ends.some((e) => e.ident === ident))!
    return runwayTip(ap, r, r.ends.find((e) => e.ident === ident)!)
  }
  assert.equal(tip(llbg, '26'), 'Runway 26\nPlanes head west · 4.1 km')
  assert.equal(tip(llbg, '03'), 'Runway 03\nPlanes head northeast · 2.8 km')
  assert.equal(tip(ksfo, '28R'), 'Runway 28R\nPlanes head northwest · 3.6 km\nRight of 2 parallel runways')
  assert.equal(tip(ksfo, '1L'), 'Runway 1L\nPlanes head northeast · 2.3 km\nLeft of 2 parallel runways')
  // three side by side, a lone suffixed one, and an ident that is not a number
  const end = (ident: string, hdgTrueDeg: number) => ({ ...e10L, ident, hdgTrueDeg })
  const three: Airport = {
    ...ksfo,
    runways: [['09L', '27R'], ['09C', '27C'], ['09R', '27L']].map(([a, b]) => ({ ...rwy, lengthFt: 10_000, ends: [end(a, 90), end(b, 270)] })),
  }
  assert.equal(tip(three, '27C'), 'Runway 27C\nPlanes head west · 3.0 km\nCentre of 3 parallel runways')
  const lone: Airport = { ...ksfo, runways: [{ ...rwy, lengthFt: 3_281, ends: [end('18C', 180), end('N', 0)] }] }
  assert.equal(tip(lone, '18C'), 'Runway 18C\nPlanes head south · 1.0 km')
  assert.equal(tip(lone, 'N'), 'Runway N\nPlanes head north · 1.0 km')
})

test('labelSide: the label sits behind the arrow on screen and grows away from it', () => {
  const side = (dx: number, dy: number) => {
    const s = labelSide(dx, dy, { x: 0, y: 0, h: HorizontalOrigin.CENTER, v: VerticalOrigin.CENTER })
    return { x: Math.sign(Math.round(s.x * 1e6)) + 0, y: Math.sign(Math.round(s.y * 1e6)) + 0, h: s.h, v: s.v } // + 0: no −0
  }
  // screen y grows downwards
  assert.deepEqual(side(0, -1), { x: 0, y: 1, h: HorizontalOrigin.CENTER, v: VerticalOrigin.TOP }, 'arrow up: label below, hanging from its top')
  assert.deepEqual(side(1, 0), { x: -1, y: 0, h: HorizontalOrigin.RIGHT, v: VerticalOrigin.CENTER }, 'arrow right: label to the left')
  assert.deepEqual(side(0, 1), { x: 0, y: -1, h: HorizontalOrigin.CENTER, v: VerticalOrigin.BOTTOM }, 'arrow down: label above')
  assert.deepEqual(side(-1, 0), { x: 1, y: 0, h: HorizontalOrigin.LEFT, v: VerticalOrigin.CENTER }, 'arrow left: label to the right')
  const d = Math.SQRT1_2
  assert.deepEqual(side(d, -d), { x: -1, y: 1, h: HorizontalOrigin.RIGHT, v: VerticalOrigin.TOP }, 'arrow up-right: label down-left')
})

test('addRunways: an arrow at each threshold points down its runway, the number behind it; hover or tap spells it out', () => {
  const llbg = airports.find((a) => a.ident === 'LLBG')!
  const { viewer, entities, preRender } = fakeViewer()
  const rw = addRunways(viewer, [llbg])
  const byIdent = new Map(entities.values.map((e) => [e.label!.text!.getValue(now) as string, e]))
  assert.deepEqual([...byIdent.keys()], ['03', '21', '08', '26', '12', '30'])
  for (const r of llbg.runways) {
    for (const e of r.ends) {
      const m = byIdent.get(e.ident)!
      assert.equal(m.point, undefined, `${e.ident}: an arrow, not a dot`)
      near(m.billboard!.rotation!.getValue(now), (-e.hdgTrueDeg * Math.PI) / 180, 1e-12, `${e.ident} turned to its heading`)
      const axis = m.billboard!.alignedAxis!.getValue(now) as Cartesian3
      near(Cartesian3.distance(axis, northAt(e.thrLat, e.thrLon, new Cartesian3())), 0, 1e-12, `${e.ident} measured from north`)
    }
  }
  preRender.raiseEvent() // aims each label behind its arrow as the camera sees it: north up
  const m26 = byIdent.get('26')!
  const off = m26.label!.pixelOffset!.getValue(now) as Cartesian2
  assert.ok(off.x > 0 && Math.abs(off.y) < off.x, `26 heads west: its number east of the threshold (${off.x}, ${off.y})`)
  assert.equal(m26.label!.horizontalOrigin!.getValue(now), HorizontalOrigin.LEFT)
  const m03 = byIdent.get('03')!
  assert.equal(m03.label!.verticalOrigin!.getValue(now), VerticalOrigin.TOP, '03 heads up the screen: its number below')

  const e26 = llbg.runways[1].ends[1]
  const at = viewer.scene.cartesianToCanvasCoordinates(Cartesian3.fromDegrees(e26.thrLon, e26.thrLat), new Cartesian3() as unknown as Cartesian2)!
  const over = { x: at.x - 15, y: at.y + 2 } as Cartesian2 // on the arrow, half way along (it points west, slightly down)
  assert.equal(rw.hover(over), true)
  assert.equal(m26.label!.text!.getValue(now), 'Runway 26\nPlanes head west · 4.1 km')
  assert.equal(m26.label!.showBackground!.getValue(now), true)
  assert.equal(byIdent.get('08')!.label!.text!.getValue(now), '08', 'the others stay short')
  assert.equal(rw.hover({ x: at.x, y: at.y + 60 } as Cartesian2), false, 'off the arrow')
  assert.equal(m26.label!.text!.getValue(now), '26')
  assert.equal(m26.label!.showBackground!.getValue(now), false)
  assert.equal(rw.hover({ x: at.x, y: at.y + 60 } as Cartesian2, 70), true, 'a fingertip reaches further')
  assert.equal(rw.hover(null), false)
  assert.equal(m26.label!.text!.getValue(now), '26')
  Cartesian3.fromDegrees(LON0, LAT0, 40_000, undefined, viewer.scene.camera.positionWC) // above 30 km the markers are hidden
  preRender.raiseEvent()
  assert.equal(rw.hover(over), false, 'a hidden marker is not hit')
})

test('keepOnScreen: a spelled-out label near an edge moves back inside the screen, 8 px in; one inside stays', () => {
  const at = (h: HorizontalOrigin, v: VerticalOrigin, x = 5, y = 5) => ({ x, y, h, v })
  // anchored at (360, 400) on a 375 × 812 phone, growing right: 240 px wide would end at 605
  const right = keepOnScreen(at(HorizontalOrigin.LEFT, VerticalOrigin.TOP), 360, 400, 240, 40, 375, 812)
  assert.equal(360 + right.x + 240, 375 - 8)
  assert.equal(right.y, 5, 'not moved up or down')
  const left = keepOnScreen(at(HorizontalOrigin.RIGHT, VerticalOrigin.CENTER), 20, 400, 240, 40, 375, 812)
  assert.equal(20 + left.x - 240, 8)
  const centred = keepOnScreen(at(HorizontalOrigin.CENTER, VerticalOrigin.BOTTOM, 0, -5), 187, 30, 240, 40, 375, 812)
  assert.equal(30 + centred.y - 40, 8, 'pushed down from the top')
  assert.equal(centred.x, 0)
  const low = keepOnScreen(at(HorizontalOrigin.CENTER, VerticalOrigin.TOP, 0, 5), 187, 800, 100, 40, 375, 812)
  assert.equal(800 + low.y + 40, 812 - 8, 'pushed up from the bottom')
  const inside = keepOnScreen(at(HorizontalOrigin.LEFT, VerticalOrigin.TOP), 100, 100, 240, 40, 375, 812)
  assert.deepEqual([inside.x, inside.y], [5, 5])
})

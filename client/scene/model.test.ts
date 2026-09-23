// client/scene/model.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { Cartesian2, Cartesian3, Cartographic, HeadingPitchRoll, Math as CesiumMath, Matrix4, Model, Transforms } from 'cesium'
import type { CustomShader, Viewer } from 'cesium'
import type { Airport } from '../../shared/airports.ts'
import { bearingDeg } from '../../shared/geo.ts'
import type { ModelManifest, RenderState } from '../types.ts'
import { liveryFromSpec } from './livery.ts'
import { ChaseModel, GLTF_TO_CESIUM, hprFor, loadGearModel, measureGlb, modelMatrixFor, noseAzimuthDeg } from './model.ts'

const root = new URL('../../', import.meta.url)
const manifest: ModelManifest = JSON.parse(readFileSync(new URL('public/models/manifest.json', root), 'utf8'))
const m = manifest.models.find((x) => x.id === manifest.default)!
const glbUrl = new URL(`public/${m.uri}`, root)
const axes = measureGlb(readFileSync(glbUrl))
const airports: Airport[] = JSON.parse(readFileSync(new URL('data/fixtures/golden/airports-sample.json', root), 'utf8'))
const KSFO = airports.find((a) => a.ident === 'KSFO')!

const DEG = Math.PI / 180
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${msg} got ${a}, expected ${b} ± ${tol}`)
const azErr = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180)

function state(lat: number, lon: number, hM: number, headingDeg: number, pitchDeg = 0, rollDeg = 0): RenderState {
  return {
    hex: 'abc123', lat, lon, hM, headingDeg, pitchDeg, rollDeg,
    gsKt: null, trackDeg: null, altBaroFt: null, vsFpm: null, mode: 'interp', altSource: 'geom',
    onGround: false, ageS: 0, quality: 'adsb2', callsign: null, typeCode: null,
  }
}

/** Model-frame direction v under modelMatrix, as unit [east, north, up]. Own geodetic formulas, not Cesium's ENU. */
function enu(mm: Matrix4, v: Cartesian3, latDeg: number, lonDeg: number): [number, number, number] {
  const w = Cartesian3.normalize(Matrix4.multiplyByPointAsVector(mm, v, new Cartesian3()), new Cartesian3())
  const [p, l] = [latDeg * DEG, lonDeg * DEG]
  const e = new Cartesian3(-Math.sin(l), Math.cos(l), 0)
  const n = new Cartesian3(-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p))
  const u = new Cartesian3(Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p))
  return [Cartesian3.dot(w, e), Cartesian3.dot(w, n), Cartesian3.dot(w, u)]
}
const azimuth = ([e, n]: [number, number, number]): number => (Math.atan2(e, n) / DEG + 360) % 360

// ---------- the asset: where is the nose? ----------

test("Cesium's glTF axis correction: glTF +Z (front) → +X, +Y (up) → +Z, +X → +Y", () => {
  const map = (x: number, y: number, z: number): Cartesian3 => Matrix4.multiplyByPointAsVector(GLTF_TO_CESIUM, new Cartesian3(x, y, z), new Cartesian3())
  assert.ok(Cartesian3.equalsEpsilon(map(0, 0, 1), Cartesian3.UNIT_X, 1e-12))
  assert.ok(Cartesian3.equalsEpsilon(map(0, 1, 0), Cartesian3.UNIT_Z, 1e-12))
  assert.ok(Cartesian3.equalsEpsilon(map(1, 0, 0), Cartesian3.UNIT_Y, 1e-12))
})

test('measureGlb: Cesium_Air noses +X (fin at the tail), up +Z, right wing −Y', () => {
  assert.ok(Cartesian3.angleBetween(axes.nose, Cartesian3.UNIT_X) / DEG < 0.5, `nose ${axes.nose}`)
  assert.ok(Cartesian3.equalsEpsilon(axes.up, Cartesian3.UNIT_Z, 1e-12))
  assert.ok(Cartesian3.angleBetween(axes.right, new Cartesian3(0, -1, 0)) / DEG < 0.5, `right ${axes.right}`)
  near(axes.lengthM, 21.4, 0.01, 'length')
  near(axes.spanM, 25.74, 0.01, 'span')
  near(axes.belowOriginM, 2.296, 0.001, 'origin → wheels')
})

test('measureGlb: the bounding box (min, max) around the centre, its floor the wheels', () => {
  const mid = Cartesian3.midpoint(axes.min, axes.max, new Cartesian3())
  assert.ok(Cartesian3.equalsEpsilon(mid, axes.centre, 1e-9), `${mid} vs ${axes.centre}`)
  near(-axes.min.z, axes.belowOriginM, 1e-9)
  near(axes.max.x - axes.min.x, axes.lengthM, 0.01, 'x extent = length (nose along +X)')
  near(axes.max.y - axes.min.y, axes.spanM, 0.01, 'y extent = span')
})

test('measureGlb rejects bytes that are not a GLB', () => {
  assert.throws(() => measureGlb(new TextEncoder().encode('{"asset":{"version":"2.0"},"nodes":[]}')), /GLB/)
})

test('manifest: default model exists, ≤ 5 MB, has provenance; scale, lengthM and gearHeightM match the geometry', () => {
  assert.ok(m, `default "${manifest.default}" is not in models`)
  assert.ok(statSync(glbUrl).size <= 5 * 1024 * 1024)
  for (const k of ['license', 'author', 'source'] as const) assert.ok(m[k].length > 0, k)
  near(axes.lengthM * m.scale, m.lengthM, 0.05, 'lengthM')
  near(axes.belowOriginM * m.scale, m.gearHeightM, 0.05, 'gearHeightM')
})

// ---------- calibration: the gate G3 checks this is green ----------

test('Cesium convention: HeadingPitchRoll(0, 0, 0) points model +X east; +90° turns it south', () => {
  const p = Cartesian3.fromDegrees(KSFO.lon, KSFO.lat, 0)
  const at = (hDeg: number): number => azimuth(enu(Transforms.headingPitchRollToFixedFrame(p, new HeadingPitchRoll(hDeg * DEG, 0, 0)), Cartesian3.UNIT_X, KSFO.lat, KSFO.lon))
  near(at(0), 90, 1e-9)
  near(at(90), 180, 1e-9)
})

test('hprFor adds forwardAxisFix (−90° for a +X nose) to the state, in radians, with no sign flips', () => {
  assert.deepEqual(m.forwardAxisFix, { headingDeg: -90, pitchDeg: 0, rollDeg: 0 })
  const h = hprFor(state(0, 0, 0, 297.9, 3, -7), m)
  near(h.heading, (297.9 - 90) * DEG, 1e-12)
  near(h.pitch, 3 * DEG, 1e-12)
  near(h.roll, -7 * DEG, 1e-12)
})

for (const hdg of [0, 90, 180, 270, 297.9, 27.7]) {
  test(`heading ${hdg}°: nose azimuth within 1°`, () => {
    const s = state(KSFO.lat, KSFO.lon, 0, hdg)
    const mm = modelMatrixFor(s, m)
    const az = azimuth(enu(mm, axes.nose, s.lat, s.lon))
    assert.ok(azErr(az, hdg) <= 1, `measured nose at ${az}°`)
    assert.ok(azErr(noseAzimuthDeg(mm, axes.nose), hdg) <= 1)
    assert.ok(azErr(noseAzimuthDeg(mm), hdg) <= 1)
  })
}

for (const [ident, trueDeg] of [['28L', 297.9], ['1R', 27.7]] as const) {
  test(`KSFO ${ident} threshold: nose along the runway (${trueDeg}° true) within 1°`, () => {
    const r = KSFO.runways.find((x) => x.ends.some((e) => e.ident === ident))!
    const [thr, far] = r.ends[0].ident === ident ? r.ends : [r.ends[1], r.ends[0]]
    const brg = bearingDeg(thr.thrLat, thr.thrLon, far.thrLat, far.thrLon)
    near(brg, trueDeg, 0.1, 'fixture runway bearing')
    const s = state(thr.thrLat, thr.thrLon, thr.thrHaeM, brg)
    const mm = modelMatrixFor(s, m)
    const az = azimuth(enu(mm, axes.nose, s.lat, s.lon))
    assert.ok(azErr(az, brg) <= 1, `nose ${az}° vs runway ${brg}°`)
    assert.ok(azErr(noseAzimuthDeg(mm, axes.nose), brg) <= 1)
  })
}

test('pitch +10° → nose ENU up = sin 10° ± 0.01 and azimuth unchanged; −10° → nose down', () => {
  for (const hdg of [0, 90, 297.9]) {
    const mm = modelMatrixFor(state(KSFO.lat, KSFO.lon, 300, hdg, 10), m)
    const nose = enu(mm, axes.nose, KSFO.lat, KSFO.lon)
    near(nose[2], Math.sin(10 * DEG), 0.01, `heading ${hdg}: nose up`)
    assert.ok(azErr(azimuth(nose), hdg) <= 1)
  }
  assert.ok(enu(modelMatrixFor(state(KSFO.lat, KSFO.lon, 300, 90, -10), m), axes.nose, KSFO.lat, KSFO.lon)[2] < 0)
})

test('roll +20° → right wing ENU up < 0 (right wing down), nose level; −20° → right wing up', () => {
  for (const hdg of [0, 90, 297.9]) {
    const mm = modelMatrixFor(state(KSFO.lat, KSFO.lon, 300, hdg, 0, 20), m)
    const wing = enu(mm, axes.right, KSFO.lat, KSFO.lon)[2]
    assert.ok(wing < 0, `heading ${hdg}: right wing up component ${wing}`)
    near(wing, -Math.sin(20 * DEG), 0.01)
    near(enu(mm, axes.nose, KSFO.lat, KSFO.lon)[2], 0, 1e-6, 'nose level')
  }
  assert.ok(enu(modelMatrixFor(state(KSFO.lat, KSFO.lon, 300, 90, 0, -20), m), axes.right, KSFO.lat, KSFO.lon)[2] > 0)
})

test('modelMatrixFor: origin at lat/lon and hM + gearHeightM, scale baked in, result reused', () => {
  const out = new Matrix4()
  const mm = modelMatrixFor(state(37.6, -122.4, -28.3, 45, 5, 5), m, out)
  assert.equal(mm, out)
  const c = Cartographic.fromCartesian(Matrix4.getTranslation(mm, new Cartesian3()))
  near(CesiumMath.toDegrees(c.latitude), 37.6, 1e-9)
  near(CesiumMath.toDegrees(c.longitude), -122.4, 1e-9)
  near(c.height, -28.3 + m.gearHeightM, 1e-4)
  near(Matrix4.getMaximumScale(mm), m.scale, 1e-9)
  const down = Cartographic.fromCartesian(Matrix4.getTranslation(modelMatrixFor(state(37.6, -122.4, -28.3, 45), m, undefined, 11.6), new Cartesian3()))
  near(down.height, -28.3 + 11.6, 1e-4, 'an explicit origin → wheel height (the gear down)')
})

// ---------- ChaseModel (Model and Viewer faked: no WebGL in Node) ----------

function fakes(): { viewer: Viewer; added: unknown[]; model: { modelMatrix: Matrix4; show: boolean } } {
  const added: unknown[] = []
  const viewer = {
    scene: { primitives: { add: <T>(p: T): T => (added.push(p), p), remove: (p: unknown): boolean => added.splice(added.indexOf(p), 1).length === 1 } },
  } as unknown as Viewer
  return { viewer, added, model: { modelMatrix: new Matrix4(), show: true } }
}

test('ChaseModel: added hidden; update rewrites modelMatrix in place and shows it; show=false hides; destroy removes', () => {
  const f = fakes()
  const cm = new ChaseModel(f.viewer, m, f.model as unknown as Model)
  assert.deepEqual(f.added, [f.model])
  assert.equal(f.model.show, false)
  cm.show = true
  assert.equal(f.model.show, false, 'not shown before the first update (it would sit at the Earth centre)')

  const same = f.model.modelMatrix
  const s = state(KSFO.lat, KSFO.lon, 0, 297.9)
  cm.update(s)
  assert.equal(f.model.modelMatrix, same)
  assert.ok(Matrix4.equals(f.model.modelMatrix, modelMatrixFor(s, m)))
  assert.equal(f.model.show, true)

  cm.show = false
  cm.update(s)
  assert.equal(f.model.show, false)
  assert.equal(cm.show, false)
  cm.show = true
  assert.equal(f.model.show, true)

  cm.destroy()
  assert.deepEqual(f.added, [])
})

test('ChaseModel.load: the model does not follow terrain exaggeration (keeps its true HAE) and starts hidden', async (t) => {
  const f = fakes()
  const fromGltf = t.mock.method(Model, 'fromGltfAsync', async () => f.model as unknown as Model)
  const cm = await ChaseModel.load(f.viewer, m)
  // Cesium's default would squash the aircraft towards relH with the ground, and flatten it at factor 0.
  assert.deepEqual(fromGltf.mock.calls[0].arguments, [{ url: `/${m.uri}`, minimumPixelSize: 32, show: false, enableVerticalExaggeration: false }])
  assert.equal(cm.model, f.model)
  assert.deepEqual(f.added, [f.model])
  assert.equal(f.model.show, false)
})

test('ChaseModel.use: loads another type once, keeps the current model until it is ready, then swaps (shown as before)', async () => {
  const f = fakes()
  const other = { modelMatrix: new Matrix4(), show: true }
  const b738 = { ...m, id: 'b738', uri: 'models/b738.glb' }
  let loads = 0
  let done!: (v: Model) => void
  const cm = new ChaseModel(f.viewer, m, f.model as unknown as Model, () => (loads++, new Promise<Model>((r) => (done = r))))
  cm.update(state(KSFO.lat, KSFO.lon, 0, 0))
  assert.equal(cm.use(m), false, 'same type: nothing to do')
  assert.equal(cm.use(b738), false, 'not loaded yet')
  assert.equal(cm.use(b738), false)
  assert.equal(loads, 1, 'asked once')
  assert.equal(cm.model, f.model)
  done(other as unknown as Model)
  await Promise.resolve()
  assert.equal(other.show, false, 'added hidden')
  assert.equal(cm.use(b738), true)
  assert.equal(cm.model, other)
  assert.equal(other.show, true)
  assert.equal(f.model.show, false)
  assert.equal(cm.use(m), true, 'back to the first: already loaded')
  cm.destroy()
  assert.deepEqual(f.added, [])
})

test('every manifest model: ≤ 1 MB (the default ≤ 5 MB), provenance, true size, wheels, and the nose along the heading', () => {
  for (const e of manifest.models) {
    const url = new URL(`public/${e.uri}`, root)
    assert.ok(statSync(url).size <= (e.id === manifest.default ? 5 : 1) * 1024 * 1024, e.id)
    for (const k of ['license', 'author', 'source'] as const) assert.ok(e[k].length > 0, `${e.id} ${k}`)
    const a = measureGlb(readFileSync(url))
    near(a.lengthM * e.scale, e.lengthM, 0.05, `${e.id} lengthM`)
    near(a.belowOriginM * e.scale, e.gearHeightM, 0.05, `${e.id} gearHeightM`)
    // measureGlb finds the nose from the fin, which a helicopter's rotor outranks: livetaiwan's models all face glTF −Z.
    const nose = e.id === 'ec135' ? new Cartesian3(-1, 0, 0) : a.nose
    const s = state(KSFO.lat, KSFO.lon, 0, 297.9)
    assert.ok(azErr(azimuth(enu(modelMatrixFor(s, e), nose, s.lat, s.lon)), 297.9) <= 1, `${e.id} nose`)
  }
})

// ---------- scenarios: the b744's body wrap, span fold, damage and gear ----------

const b744 = manifest.models.find((x) => x.id === 'b744')!

test("b744 manifest: body box, wing tip, damage cut and gear lie on the GLB's bounding box (turned frame)", () => {
  const a = measureGlb(readFileSync(new URL(`public/${b744.uri}`, root)))
  // Cesium model frame (x = glTF z, y = glTF x, z = glTF y) → the paint's turned frame (x = −glTF x, y = glTF y, z = −glTF z)
  const X = [-a.max.y, -a.min.y]
  const Y = [a.min.z, a.max.z]
  const Z = [-a.max.x, -a.min.x]
  const inside = (v: number, [lo, hi]: number[], what: string, tol = 0.05): void =>
    assert.ok(v >= lo - tol && v <= hi + tol, `${what}: ${v} outside ${lo}…${hi}`)
  const p = b744.paint!
  const [zNose, zTail, yBottom, yTop] = p.body!
  for (const [v, what] of [[zNose, 'zNose'], [zTail, 'zTail']] as const) inside(v, Z, `body ${what}`)
  for (const [v, what] of [[yBottom, 'yBottom'], [yTop, 'yTop']] as const) inside(v, Y, `body ${what}`)
  near(zNose, Z[1], 0.1, 'the wrap starts at the nose')
  near(zTail, Z[0], 0.1, 'and ends at the tail')
  assert.ok(yTop > yBottom)
  inside(p.wingTipY!, Y, 'wingTipY')
  const c = p.cut!
  const [yRoot, leRoot, teRoot, yTip, leTip, teTip] = c.finEdges
  for (const y of [yRoot, yTip]) inside(y, Y, 'fin chord y')
  for (const z of [leRoot, teRoot, leTip, teTip]) inside(z, Z, 'fin chord z')
  assert.ok(leRoot > teRoot && leTip > teTip, 'leading edges nose-side (turned +z)')
  inside(c.finKeepY, [yRoot, yTip], 'finKeepY between the fin root and tip', 0)
  assert.ok(c.rudderFrac > 0 && c.rudderFrac < 1)
  inside(c.tailConeZ, [Z[0], leRoot], 'tailConeZ between the tail and the fin root leading edge', 0)
  assert.ok(c.tailHalfWidth > p.fin.halfWidth && c.tailHalfWidth < p.bodyHalfWidth)
  const g = measureGlb(readFileSync(new URL(`public/${b744.gear!.uri}`, root)))
  near(g.belowOriginM * b744.scale, b744.gear!.heightM, 0.05, 'gear heightM = origin → wheel bottom')
  near(b744.gear!.heightM, 11.6, 1e-9, 'belly −8.6 less 3.0 m of gear')
  assert.ok(b744.gear!.heightM > b744.gearHeightM, 'the wheels hang below the nacelles')
  inside(-g.max.x, Z, 'gear front') // raw frame: the gear sits under the aircraft
  inside(-g.min.x, Z, 'gear back')
  inside(-g.max.y, X, 'gear right')
  inside(-g.min.y, X, 'gear left')
})

interface FakeModel { modelMatrix: Matrix4; show: boolean; customShader: CustomShader | undefined; backFaceCulling: boolean; imageBasedLighting: { imageBasedLightingFactor: Cartesian2 } }
const fakeModel = (): FakeModel => ({ modelMatrix: new Matrix4(), show: true, customShader: undefined, backFaceCulling: true, imageBasedLighting: { imageBasedLightingFactor: new Cartesian2(1, 1) } })
const jal = liveryFromSpec('scenario:jal123', { base: '#f4f4f1', fin: '#f4f4f1' }, '/scenarios/jal123/', { body: false, finLogo: false })
const uniform = (x: FakeModel, name: string): unknown => x.customShader!.uniforms[name].value

test('ChaseModel.setShape/setDamage: u_span and u_cut on the current shader, re-applied when paint, paintLivery or use switch it', async () => {
  const f = fakes()
  const first = fakeModel()
  const other = fakeModel()
  const clone = { ...b744, id: 'b744-other' }
  const cm = new ChaseModel(f.viewer, b744, first as unknown as Model, async () => other as unknown as Model)
  assert.equal(cm.entry, b744)
  cm.paint(null)
  const white = first.customShader!
  assert.deepEqual([uniform(first, 'u_span'), uniform(first, 'u_cut'), first.backFaceCulling], [0, 0, true])

  cm.setShape(29.8)
  cm.setDamage(true)
  assert.deepEqual([uniform(first, 'u_span'), uniform(first, 'u_cut'), first.backFaceCulling], [29.8, 1, false], 'back faces drawn while damaged')

  cm.paintLivery(jal)
  assert.notEqual(first.customShader, white)
  assert.deepEqual([uniform(first, 'u_span'), uniform(first, 'u_cut')], [29.8, 1], 'carried to the new shader')
  const scn = first.customShader
  cm.paintLivery({ ...jal })
  assert.equal(first.customShader, scn, 'same livery code: same shader')

  cm.setDamage(false)
  cm.setShape(null)
  assert.deepEqual([uniform(first, 'u_span'), uniform(first, 'u_cut'), first.backFaceCulling], [0, 0, true])
  cm.setShape(29.8)
  cm.paint(null)
  assert.equal(first.customShader, white, 'a table livery replaces the scenario livery')
  assert.deepEqual([uniform(first, 'u_span'), uniform(first, 'u_cut')], [29.8, 0], 'the stale values on the cached shader are rewritten')

  cm.setDamage(true)
  cm.use(clone)
  await Promise.resolve()
  assert.equal(cm.use(clone), true)
  assert.equal(cm.entry, clone)
  assert.equal(other.backFaceCulling, false, 'the new model is damaged too')
  cm.paint(null)
  assert.deepEqual([uniform(other, 'u_span'), uniform(other, 'u_cut')], [29.8, 1])
  cm.setShape(null)
  cm.setDamage(false)
  assert.equal(cm.use(b744), true)
  assert.deepEqual([uniform(first, 'u_span'), uniform(first, 'u_cut'), first.backFaceCulling], [0, 0, true], 'back on the first model: its shader is rewritten')

  const half = new ChaseModel(fakes().viewer, { ...b744, scale: 0.5 }, fakeModel() as unknown as Model)
  half.paint(null)
  half.setShape(29.8)
  assert.equal(half.model.customShader!.uniforms.u_span.value, 59.6, 'u_span is in the unscaled mesh frame')
})

test('ChaseModel.setGear: loads the gear once, draws it with the chase matrix, wheels gear.heightM below the origin', async () => {
  const f = fakes()
  const body = fakeModel()
  const gear = fakeModel()
  const asked: string[] = []
  let done!: (v: Model) => void
  const cm = new ChaseModel(f.viewer, b744, body as unknown as Model, undefined, (uri) => (asked.push(uri), new Promise<Model>((r) => (done = r))))
  const s = state(KSFO.lat, KSFO.lon, 0, 297.9)
  const heightOf = (mm: Matrix4): number => Cartographic.fromCartesian(Matrix4.getTranslation(mm, new Cartesian3())).height

  cm.update(s)
  cm.setGear(true)
  cm.setGear(true)
  assert.deepEqual(asked, ['models/b744-gear.glb'], 'asked once')
  cm.update(s)
  near(heightOf(body.modelMatrix), b744.gearHeightM, 1e-3, 'until it has loaded, the gearless height')

  done(gear as unknown as Model)
  await Promise.resolve()
  assert.deepEqual(f.added, [body, gear])
  assert.equal(gear.show, false, 'added hidden')
  assert.ok(Matrix4.equals(gear.modelMatrix, body.modelMatrix), "placed with the aircraft on load: its first environment map is not at the Earth's centre")
  body.imageBasedLighting.imageBasedLightingFactor = new Cartesian2(0.2, 0.2)
  cm.update(s)
  near(heightOf(body.modelMatrix), b744.gear!.heightM, 1e-3, 'wheels on the ground')
  assert.ok(Matrix4.equals(gear.modelMatrix, body.modelMatrix))
  assert.equal(gear.show, true)
  assert.ok(Cartesian2.equals(gear.imageBasedLighting.imageBasedLightingFactor, new Cartesian2(0.2, 0.2)), 'lit as the aircraft (the Sun dims it at night)')

  cm.show = false
  assert.equal(gear.show, false)
  cm.show = true
  cm.update(s)
  assert.equal(gear.show, true)

  cm.setGear(false)
  assert.equal(gear.show, false)
  cm.update(s)
  assert.equal(gear.show, false)
  near(heightOf(body.modelMatrix), b744.gearHeightM, 1e-3)
  cm.setGear(true)
  assert.equal(asked.length, 1, 'not loaded again')
  cm.update(s)
  assert.equal(gear.show, true)

  cm.destroy()
  assert.deepEqual(f.added, [])
})

test('ChaseModel.setGear on a model without gear: nothing loads, the placement stays', () => {
  const f = fakes()
  const body = fakeModel()
  let loads = 0
  const cm = new ChaseModel(f.viewer, m, body as unknown as Model, undefined, async () => (loads++, fakeModel() as unknown as Model))
  cm.setGear(true)
  cm.update(state(KSFO.lat, KSFO.lon, 0, 0))
  assert.equal(loads, 0)
  assert.ok(Matrix4.equals(body.modelMatrix, modelMatrixFor(state(KSFO.lat, KSFO.lon, 0, 0), m)))
})

test("loadGearModel: a plain model (no minimum pixel size), true height, hidden; its sky map rebuilt every 20 km as the aircraft's", async (t) => {
  const g = fakeModel()
  const fromGltf = t.mock.method(Model, 'fromGltfAsync', async () => g as unknown as Model)
  assert.equal(await loadGearModel('models/b744-gear.glb'), g)
  assert.deepEqual(fromGltf.mock.calls[0].arguments, [{
    url: '/models/b744-gear.glb', show: false, enableVerticalExaggeration: false, environmentMapOptions: { maximumPositionEpsilon: 20_000 },
  }])
})

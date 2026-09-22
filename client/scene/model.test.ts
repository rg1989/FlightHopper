// client/scene/model.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { Cartesian3, Cartographic, HeadingPitchRoll, Math as CesiumMath, Matrix4, Transforms } from 'cesium'
import type { Airport } from '../../shared/airports.ts'
import { bearingDeg } from '../../shared/geo.ts'
import type { ModelManifest, RenderState } from '../types.ts'
import { GLTF_TO_CESIUM, hprFor, measureGlb, modelMatrixFor, noseAzimuthDeg } from './model.ts'

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
})

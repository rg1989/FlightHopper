// client/scene/traffic.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Cartesian3, Cartographic, Ellipsoid, HeadingPitchRoll, Matrix4 } from 'cesium'
import { destination } from '../../shared/geo.ts'
import type { FleetEntry, ModelManifest } from '../types.ts'
import { measureGlb, noseAzimuthDeg } from './model.ts'
import { BOX_CENTRE, BOX_HALF, MIN_PX, hitAt, minScale, nearestInRange, scaleFor, squarePx, trafficHpr, trafficMatrix } from './traffic.ts'
import type { Box } from './traffic.ts'

const root = new URL('../../', import.meta.url)
const manifest: ModelManifest = JSON.parse(readFileSync(new URL('public/models/manifest.json', root), 'utf8'))
const m = manifest.models.find((x) => x.id === manifest.default)!
const axes = measureGlb(readFileSync(new URL(`public/${m.uri}`, root)))
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} ${msg}`)
const azErr = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180)
const fe = (hex: string, o: Partial<FleetEntry> = {}): FleetEntry => ({
  hex, lat: 51.5, lon: -0.1, hM: 5_000, altFt: 16_000, onGround: false, trackDeg: 90, gsKt: 300, vsFpm: 0, ageS: 1, staleS: 60, gapS: 1,
  quality: 'adsb2', info: null, ...o,
})
const at = (hex: string, nm: number, brg = 45, o: Partial<FleetEntry> = {}): FleetEntry => {
  const p = destination(51.5, -0.1, brg, nm)
  return fe(hex, { lat: p.lat, lon: p.lon, ...o })
}

test('scale by ADS-B emitter category; unknown is 1', () => {
  assert.equal(scaleFor('A1'), 0.35)
  assert.equal(scaleFor('A5'), 1.8)
  assert.equal(scaleFor('A7'), 0.4)
  assert.equal(scaleFor('B2'), 1)
  assert.equal(scaleFor(null), 1)
})

test('nearestInRange: within the range, airborne first (parked ones at a hub must not take every model), then nearest', () => {
  const es = [
    at('far', 12), at('mid', 6, 200), at('me', 0.1), at('close', 2, 300), at('stale', 1, 10, { ageS: 90 }), at('edge', 9.9, 100),
    at('parked', 0.5, 90, { onGround: true }), at('taxi', 3, 90, { onGround: true }),
  ]
  const r = nearestInRange(es, 'me', 51.5, -0.1, 10)
  assert.deepEqual(r.map((x) => x.e.hex), ['close', 'mid', 'edge', 'parked', 'taxi'])
  near(r[0].nm, 2, 1e-9)
})

test('squarePx: the projected diameter, never under MIN_PX, capped when the camera is inside it', () => {
  // 60° fov over 1,000 px: at depth d a pixel is 2·d·tan 30° / 1000 m
  const mPerPx = (d: number): number => (2 * d * Math.tan(Math.PI / 6)) / 1000
  near(squarePx(20, 500, Math.PI / 3, 1000), 40 / mPerPx(500), 1e-9)
  assert.ok(squarePx(20, 250, Math.PI / 3, 1000) > squarePx(20, 500, Math.PI / 3, 1000), 'closer is bigger')
  assert.equal(squarePx(20, 50_000, Math.PI / 3, 1000), MIN_PX)
  assert.equal(squarePx(20, 0, Math.PI / 3, 1000), 4000)
})

test('minScale: a far model is enlarged to MIN_PX on screen, exactly the square squarePx draws around it', () => {
  assert.equal(minScale(20, 500, Math.PI / 3, 1000), 1, 'near: true size')
  const g = minScale(20, 50_000, Math.PI / 3, 1000)
  assert.ok(g > 1)
  near(squarePx(20 * g, 50_000, Math.PI / 3, 1000), MIN_PX, 1e-9)
  near((20 * g * 1000) / (50_000 * Math.tan(Math.PI / 6)), MIN_PX, 1e-9, 'its projected diameter is MIN_PX')
})

test('the bracket square is centred on each model and spans its wingspan and length (box matches the GLB)', () => {
  for (const e of manifest.models) {
    const a = e === m ? axes : measureGlb(readFileSync(new URL(`public/${e.uri}`, root)))
    const centre = e.box ? Cartesian3.fromArray(e.box.centre) : BOX_CENTRE
    const half = e.box?.half ?? BOX_HALF
    const size = Math.max(a.spanM, a.lengthM)
    assert.ok(Cartesian3.equalsEpsilon(centre, a.centre, 0, 0.01), `${e.id} centre ${a.centre}`)
    assert.ok(half >= size / 2 && half <= 0.6 * size, `${e.id}: half the larger of span and length plus a small margin`)
  }
})

test('hitAt: inside a square hits; overlapping squares → the nearest to the camera; outside → null', () => {
  const boxes: Box[] = [
    { hex: 'back', x: 100, y: 100, side: 80, depthM: 900 },
    { hex: 'front', x: 120, y: 110, side: 40, depthM: 300 },
    { hex: 'unused', x: 500, y: 500, side: 80, depthM: 1 },
  ]
  assert.equal(hitAt(boxes, 2, 125, 115), 'front')
  assert.equal(hitAt(boxes, 2, 70, 70), 'back')
  assert.equal(hitAt(boxes, 2, 141, 100), null, 'just right of both')
  assert.equal(hitAt(boxes, 2, 500, 500), null, 'only the first n boxes count')
})

test('traffic model: nose along the track, pitched with the climb, wings level, wheels at the placed height', () => {
  const pos = Cartesian3.fromDegrees(-0.1, 51.5, 5_000)
  for (const trk of [0, 90, 237, 359]) {
    const hpr = trafficHpr(fe('x', { trackDeg: trk }), 0, new HeadingPitchRoll())
    const mm = trafficMatrix(pos, hpr, m, 1, new Matrix4())
    assert.ok(azErr(noseAzimuthDeg(mm, axes.nose), trk) < 1, `track ${trk}`)
  }
  const climb = trafficHpr(fe('x', { vsFpm: 2_000, gsKt: 250 }), 0, new HeadingPitchRoll())
  assert.ok(climb.pitch > 0.1, 'nose up in a climb')
  assert.equal(climb.roll, 0)
  const slow = trafficHpr(fe('x', { vsFpm: 1_500, gsKt: 20 }), 0, new HeadingPitchRoll())
  assert.ok(Math.abs(slow.pitch) < 0.05, 'a slow aircraft stays about level')
  const noTrack = trafficHpr(fe('x', { trackDeg: null }), 123, new HeadingPitchRoll())
  const mm = trafficMatrix(pos, noTrack, m, 1, new Matrix4())
  assert.ok(azErr(noseAzimuthDeg(mm, axes.nose), 123) < 1, 'no track: the heading given')
  const h = Cartographic.fromCartesian(Matrix4.getTranslation(trafficMatrix(pos, trafficHpr(fe('x'), 0, new HeadingPitchRoll()), m, 2, new Matrix4()), new Cartesian3())).height
  near(h - 5_000, m.gearHeightM * 2, 0.2, 'origin a gear height above the wheels, times the factor')
})

test('traffic with a smoothed track flies its attitude (heading, pitch and bank) instead of the newest sample\'s', () => {
  const att = { headingDeg: 131, pitchDeg: 4, rollDeg: -22 }
  const hpr = trafficHpr(fe('x', { trackDeg: 90, vsFpm: 0, gsKt: 250, att }), 0, new HeadingPitchRoll())
  near(hpr.heading, ((131 - 90) * Math.PI) / 180, 1e-9)
  near(hpr.pitch, (4 * Math.PI) / 180, 1e-9)
  near(hpr.roll, (-22 * Math.PI) / 180, 1e-9)
})

test('traffic: a climbing type model (its nose on glTF −Z) raises its nose, not its tail', () => {
  const b738 = manifest.models.find((x) => x.id === 'b738')!
  const nose = measureGlb(readFileSync(new URL(`public/${b738.uri}`, root))).nose
  const pos = Cartesian3.fromDegrees(-0.1, 51.5, 5_000)
  const mm = trafficMatrix(pos, trafficHpr(fe('x', { vsFpm: 2_000, gsKt: 250, trackDeg: 90 }), 0, new HeadingPitchRoll()), b738, 1, new Matrix4())
  const w = Cartesian3.normalize(Matrix4.multiplyByPointAsVector(mm, nose, new Cartesian3()), new Cartesian3())
  assert.ok(Cartesian3.dot(w, Ellipsoid.WGS84.geodeticSurfaceNormal(pos, new Cartesian3())) > 0.05, 'nose up')
  assert.ok(azErr(noseAzimuthDeg(mm, nose), 90) < 1, 'nose along the track')
})

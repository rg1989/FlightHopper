// client/scene/chaseCamera.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Camera, Cartesian3, Cartographic, Ellipsoid, GeographicProjection, MapMode2D, Matrix4, SceneMode } from 'cesium'
import type { Viewer } from 'cesium'
import type { RenderState } from '../types.ts'
import { chaseOffsetEnu, ChaseCamera, OrbitControl } from './chaseCamera.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)
const DEG = 180 / Math.PI

type Terrain = (c: Cartographic) => number | undefined

/** A real Cesium Camera on the smallest scene its constructor and lookAtTransform read; the globe answers from `terrain`. */
function fakeViewer(terrain: Terrain) {
  const scene = {
    canvas: { clientWidth: 800, clientHeight: 600 },
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    mapProjection: new GeographicProjection(),
    mode: SceneMode.SCENE3D,
    mapMode2D: MapMode2D.INFINITE_SCROLL,
    ellipsoid: Ellipsoid.WGS84,
    screenSpaceCameraController: { minimumZoomDistance: 1, maximumZoomDistance: Number.POSITIVE_INFINITY },
    globe: { ellipsoid: Ellipsoid.WGS84, getHeight: (c: Cartographic) => terrain(c) },
  }
  const camera = new Camera(scene as never)
  return { camera, viewer: { scene, camera } as unknown as Viewer }
}

const LOWI = { lat: 47.2602, lon: 11.3439 }
const st = (o: Partial<RenderState> = {}): RenderState => ({
  hex: '4b1805', lat: LOWI.lat, lon: LOWI.lon, hM: 1000, headingDeg: 0, pitchDeg: -3, rollDeg: 0,
  gsKt: 140, trackDeg: 0, altBaroFt: 3100, vsFpm: -700, mode: 'interp', altSource: 'geom',
  onGround: false, ageS: 1, quality: 'adsb2', callsign: 'AUA905', typeCode: 'A320', ...o,
})

/** Metres south of LOWI (positive = south), for terrain that rises behind a northbound aircraft. */
const southM = (c: Cartographic): number => (LOWI.lat - c.latitude * DEG) * 111_200
/** Camera heading as seen from its offset in the target frame: the camera looks from its position towards the target. */
const lookHeadingDeg = (cam: Camera): number => ((Math.atan2(-cam.position.x, -cam.position.y) * DEG) + 360) % 360
const clearanceOf = (cam: Camera, terrain: Terrain): number => cam.positionCartographic.height - (terrain(cam.positionCartographic) as number)

test('chaseOffsetEnu: heading 0 → camera due south of the target, above it when looking down', () => {
  const [e, n, u] = chaseOffsetEnu(0, -12, 150)
  near(e, 0, 1e-9)
  assert.ok(n < 0)
  assert.ok(u > 0)
  near(Math.hypot(e, n, u), 150, 1e-9)
  near(u, 150 * Math.sin(12 / DEG), 1e-9)
})

test('chaseOffsetEnu: heading 90 → west; heading 225 → north-east', () => {
  const [e, n] = chaseOffsetEnu(90, -12, 150)
  assert.ok(e < 0)
  near(n, 0, 1e-9)
  const [e2, n2, u2] = chaseOffsetEnu(225, -30, 100)
  assert.ok(e2 > 0 && n2 > 0)
  near(e2, n2, 1e-9)
  near(u2, 50, 1e-9)
})

test('the camera Cesium places matches chaseOffsetEnu (same convention as HeadingPitchRange)', () => {
  const { camera, viewer } = fakeViewer(() => 0)
  for (const h of [0, 37, 90, 181, 300]) {
    const cc = new ChaseCamera(viewer, { rangeM: 120, pitchDeg: -15 })
    cc.update(st({ headingDeg: h }), 0.016)
    const [e, n, u] = chaseOffsetEnu(h, -15, 120)
    near(camera.position.x, e, 1e-6, `e @ ${h}`)
    near(camera.position.y, n, 1e-6, `n @ ${h}`)
    near(camera.position.z, u, 1e-6, `u @ ${h}`)
  }
})

test('update: camera behind and above the aircraft; clearance = camera height − terrain height', () => {
  const { camera, viewer } = fakeViewer(() => 0)
  const cc = new ChaseCamera(viewer)
  const { clearanceM } = cc.update(st({ hM: 1000 }), 0.016)
  const c = camera.positionCartographic
  assert.ok(c.latitude * DEG < LOWI.lat, 'south of a northbound aircraft')
  near(c.longitude * DEG, LOWI.lon, 1e-9)
  assert.ok(c.height > 1000)
  assert.equal(clearanceM, c.height)
})

test('defaults: range 150 m, pitch −12°, heading follows the aircraft on the first frame', () => {
  const { camera, viewer } = fakeViewer(() => 0)
  new ChaseCamera(viewer).update(st({ headingDeg: 123 }), 0.016)
  near(Math.hypot(camera.position.x, camera.position.y, camera.position.z), 150, 1e-6)
  near(camera.position.z, 150 * Math.sin(12 / DEG), 1e-6)
  near(lookHeadingDeg(camera), 123, 1e-6)
})

test('heading is damped exponentially (tau 1 s) and wraps through north, not the long way round', () => {
  const { camera, viewer } = fakeViewer(() => 0)
  const cc = new ChaseCamera(viewer)
  cc.update(st({ headingDeg: 350 }), 0.016)
  cc.update(st({ headingDeg: 10 }), 1.0)
  near(lookHeadingDeg(camera), (350 + 20 * (1 - Math.exp(-1))) % 360, 1e-6)
  cc.update(st({ headingDeg: 10 }), 0)
  near(lookHeadingDeg(camera), (350 + 20 * (1 - Math.exp(-1))) % 360, 1e-6, 'dt 0 changes nothing')
  for (let i = 0; i < 100; i++) cc.update(st({ headingDeg: 10 }), 0.1)
  near(lookHeadingDeg(camera), 10, 0.01)
})

test('headingTauS option: a slower camera turns less in the same time', () => {
  const a = fakeViewer(() => 0)
  const b = fakeViewer(() => 0)
  const fast = new ChaseCamera(a.viewer)
  const slow = new ChaseCamera(b.viewer, { headingTauS: 4 })
  for (const cc of [fast, slow]) cc.update(st({ headingDeg: 0 }), 0.016)
  fast.update(st({ headingDeg: 90 }), 0.5)
  slow.update(st({ headingDeg: 90 }), 0.5)
  near(lookHeadingDeg(b.camera), 90 * (1 - Math.exp(-0.5 / 4)), 1e-6)
  assert.ok(lookHeadingDeg(a.camera) > lookHeadingDeg(b.camera))
})

test('low over flat ground: pitches down just enough to stay ≥ 15 m above terrain', () => {
  const terrain: Terrain = () => 990 // the aircraft is 10 m above the runway
  const { camera, viewer } = fakeViewer(terrain)
  const { clearanceM } = new ChaseCamera(viewer, { pitchDeg: 0 }).update(st({ hM: 1000 }), 0.016)
  assert.ok(clearanceM !== null && clearanceM >= 15 && clearanceM < 17, `${clearanceM}`)
  near(clearanceOf(camera, terrain), clearanceM as number, 1e-9)
  assert.ok(camera.position.z > 0, 'now looking down')
})

test('no correction when already clear', () => {
  const { camera, viewer } = fakeViewer(() => 0)
  new ChaseCamera(viewer, { pitchDeg: -12 }).update(st({ hM: 1000 }), 0.016)
  near(camera.position.z, 150 * Math.sin(12 / DEG), 1e-6)
})

test('terrain rising behind the aircraft (valley approach): camera ends ≥ 15 m above the terrain under it', () => {
  for (const slope of [0.3, 1.0, 3.0]) {
    const terrain: Terrain = (c) => 990 + slope * Math.max(0, southM(c))
    const { camera, viewer } = fakeViewer(terrain)
    const { clearanceM } = new ChaseCamera(viewer).update(st({ hM: 1000 }), 0.016)
    assert.ok(clearanceM !== null && clearanceM >= 15, `slope ${slope}: ${clearanceM}`)
    near(clearanceOf(camera, terrain), clearanceM as number, 1e-9)
  }
})

test('a cliff behind: going straight above is enough, so the camera stays at range (no lift overshoot)', () => {
  const terrain: Terrain = (c) => 990 + 3.0 * Math.max(0, southM(c))
  const { camera, viewer } = fakeViewer(terrain)
  const { clearanceM } = new ChaseCamera(viewer).update(st({ hM: 1000 }), 0.016)
  assert.ok(clearanceM !== null && clearanceM >= 15, `${clearanceM}`)
  near(Cartesian3.distance(camera.positionWC, Cartesian3.fromDegrees(LOWI.lon, LOWI.lat, 1000)), 150, 1e-3)
})

test('aircraft below the terrain model (datum/DEM error): camera goes straight above and is lifted just clear', () => {
  const terrain: Terrain = () => 1200
  const { camera, viewer } = fakeViewer(terrain)
  const { clearanceM } = new ChaseCamera(viewer).update(st({ hM: 1000 }), 0.016)
  assert.ok(clearanceM !== null && clearanceM >= 15 && clearanceM < 16, `${clearanceM}`)
  near(clearanceOf(camera, terrain), clearanceM as number, 1e-9)
})

test('terrain not loaded under the camera: clearance null, no correction', () => {
  const { camera, viewer } = fakeViewer(() => undefined)
  const { clearanceM } = new ChaseCamera(viewer, { pitchDeg: 0 }).update(st({ hM: 1000 }), 0.016)
  assert.equal(clearanceM, null)
  near(camera.position.z, 0, 1e-6)
})

test('groundAt: clearance is kept against the ground it returns (this frame’s drawn ground), not globe.getHeight', () => {
  // Growing relief: globe.getHeight still answers last frame’s surface; the ground drawn this frame is 17 m higher.
  const stale: Terrain = () => 975
  const drawn: Terrain = () => 992
  const { camera, viewer } = fakeViewer(stale)
  const cc = new ChaseCamera(viewer, { pitchDeg: 0, groundAt: (c) => drawn(c) ?? null })
  const { clearanceM } = cc.update(st({ hM: 1000 }), 0.016)
  assert.ok(clearanceM !== null && clearanceM >= 15 && clearanceM < 17, `${clearanceM}`)
  near(clearanceOf(camera, drawn), clearanceM as number, 1e-9)
})

test('groundAt returning null (tile not loaded): clearance null, no correction', () => {
  const { camera, viewer } = fakeViewer(() => 0)
  const { clearanceM } = new ChaseCamera(viewer, { pitchDeg: 0, groundAt: () => null }).update(st({ hM: 1000 }), 0.016)
  assert.equal(clearanceM, null)
  near(camera.position.z, 0, 1e-6)
})

test('release hands the camera back (identity transform) and the next chase starts from the new heading', () => {
  const { camera, viewer } = fakeViewer(() => 0)
  const cc = new ChaseCamera(viewer)
  cc.update(st({ headingDeg: 0 }), 0.016)
  assert.ok(!Matrix4.equals(camera.transform, Matrix4.IDENTITY))
  cc.release()
  assert.ok(Matrix4.equals(camera.transform, Matrix4.IDENTITY))
  cc.update(st({ headingDeg: 200 }), 0.016)
  near(lookHeadingDeg(camera), 200, 1e-6)
})

test('OrbitControl: drag right swings the view clockwise, drag down raises the camera; both clamp', () => {
  const o = new OrbitControl(-12, 150)
  o.drag(300, 0) // 0.3°/px
  near(o.headingOffsetDeg, 90, 1e-9)
  o.drag(-600, 0)
  near(o.headingOffsetDeg, 270, 1e-9)
  o.drag(0, 100) // 0.25°/px, down = look more steeply down
  near(o.pitchDeg, -37, 1e-9)
  o.drag(0, 10_000)
  near(o.pitchDeg, -89, 1e-9)
  o.drag(0, -10_000)
  near(o.pitchDeg, 10, 1e-9)
})

test('OrbitControl: wheel up zooms in, wheel down out, clamped to 25 m … 3 km; reset restores the start', () => {
  const o = new OrbitControl(-12, 150)
  o.wheel(100)
  assert.ok(o.rangeM < 150 && o.rangeM > 120, `${o.rangeM}`)
  o.wheel(-200)
  assert.ok(o.rangeM > 150, `${o.rangeM}`)
  o.wheel(1e6)
  near(o.rangeM, 25, 1e-9)
  o.wheel(-1e6)
  near(o.rangeM, 3000, 1e-9)
  o.drag(123, 45)
  o.reset()
  assert.deepEqual([o.headingOffsetDeg, o.pitchDeg, o.rangeM], [0, -12, 150])
})

test('ChaseCamera follows the orbit: 90° offset looks east from the west side; zoom sets the distance', () => {
  const { camera, viewer } = fakeViewer(() => 0)
  const cc = new ChaseCamera(viewer)
  cc.orbit.drag(300, 0)
  cc.orbit.wheel(-200)
  cc.update(st({ headingDeg: 0 }), 1 / 60)
  near(lookHeadingDeg(camera), 90, 0.5)
  near(Cartesian3.magnitude(camera.position), cc.orbit.rangeM, 0.01)
})

test('release: next chase starts behind the aircraft again but keeps zoom and pitch', () => {
  const { camera, viewer } = fakeViewer(() => 0)
  const cc = new ChaseCamera(viewer)
  cc.orbit.drag(300, 40)
  cc.orbit.wheel(150)
  const [pitch, range] = [cc.orbit.pitchDeg, cc.orbit.rangeM]
  cc.update(st(), 1 / 60)
  cc.release()
  assert.equal(cc.orbit.headingOffsetDeg, 0)
  assert.deepEqual([cc.orbit.pitchDeg, cc.orbit.rangeM], [pitch, range])
  cc.update(st({ headingDeg: 0 }), 1 / 60)
  near(lookHeadingDeg(camera), 0, 0.5)
})

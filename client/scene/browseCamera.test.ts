// client/scene/browseCamera.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Cesium from 'cesium'
import { Camera, Cartesian2, Cartesian3, Ellipsoid, GeographicProjection, HeadingPitchRange, MapMode2D, Math as CesiumMath, Matrix4, SceneMode, Transforms } from 'cesium'
import type { Viewer } from 'cesium'
import {
  BROWSE_FLY_S, BROWSE_HEIGHT_M, MAX_ZOOM_M, MIN_ZOOM_M,
  containsDeg, enterBrowse, exitBrowse, heightForViewWidthM, isBrowsing, viewRectangleDeg, viewWidthM,
} from './browseCamera.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)
const DEG = 180 / Math.PI
const A = 6_378_137 // WGS84 equatorial radius: along the equator the ellipsoid is this circle, so the helpers are exact there
const LLBG = { lat: 32.0114, lon: 34.8867 }
// Scene.tweens' class: exported at runtime, but missing from Cesium's type definitions (it is marked private).
const TweenCollection = (Cesium as unknown as { TweenCollection: new () => { update(timeS: number): void } }).TweenCollection

/**
 * A real Cesium Camera on the smallest scene its constructor, setView, picking and flights read, plus Cesium's default
 * controller settings. Flights run on a real TweenCollection: tweens.update(s) starts them on its first call, then advances.
 */
function fakeViewer() {
  const tweens = new TweenCollection()
  const scene = {
    canvas: { clientWidth: 800, clientHeight: 600 },
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    mapProjection: new GeographicProjection(),
    mode: SceneMode.SCENE3D,
    mapMode2D: MapMode2D.INFINITE_SCROLL,
    ellipsoid: Ellipsoid.WGS84,
    screenSpaceCameraController: { enableTilt: true, enableLook: true, minimumZoomDistance: 1, maximumZoomDistance: Number.POSITIVE_INFINITY },
    globe: { ellipsoid: Ellipsoid.WGS84, getHeight: () => 0 },
    tweens,
    camera: null as Camera | null,
  }
  const camera = (scene.camera = new Camera(scene as never))
  return { camera, tweens, sscc: scene.screenSpaceCameraController, viewer: { scene, camera } as unknown as Viewer }
}

const headingDeg = (cam: Camera): number => (((cam.heading * DEG) % 360) + 360) % 360
const latLonH = (cam: Camera): { lat: number; lon: number; h: number } => {
  const c = cam.positionCartographic
  return { lat: c.latitude * DEG, lon: c.longitude * DEG, h: c.height }
}

test('viewWidthM: flat-earth limit 2·h·tan(fov/2) when low, wider than that when high (the Earth curves away)', () => {
  near(viewWidthM(2_000), 2 * 2_000 * Math.tan(Math.PI / 6), 0.5)
  near(viewWidthM(1_000, Math.PI / 2), 2_000, 0.5)
  const flat = 2 * BROWSE_HEIGHT_M * Math.tan(Math.PI / 6)
  const w = viewWidthM(BROWSE_HEIGHT_M)
  assert.ok(w > flat && w < flat * 1.05, `${w} vs flat ${flat}`)
  assert.ok(w / 1852 > 185 && w / 1852 < 192, `${w / 1852} nm`) // the default browse view is about 189 nm across
})

test('viewWidthM: once the fan of rays misses the Earth, the visible cap stops at the horizon', () => {
  const tangentH = A * (1 / Math.sin(Math.PI / 6) - 1) // the edge ray grazes the Earth at this height (= A for 60°)
  near(viewWidthM(tangentH), 2 * A * (Math.PI / 3), 1e-3)
  near(viewWidthM(3 * A), 2 * A * Math.acos(1 / 4), 1e-3)
  let prev = 0
  for (const h of [1, 1e3, 1e5, 1e6, tangentH * 0.999, tangentH * 1.001, 1e7, 1e8]) {
    const w = viewWidthM(h)
    assert.ok(w > prev, `monotonic at ${h}`)
    prev = w
  }
  assert.ok(viewWidthM(1e12) < Math.PI * A)
})

test('heightForViewWidthM inverts viewWidthM on both branches; out of reach → Infinity', () => {
  for (const h of [2_000, 50_000, BROWSE_HEIGHT_M, 3_000_000, A, 2 * A, 5e7]) near(heightForViewWidthM(viewWidthM(h)), h, h * 1e-9, `h ${h}`)
  for (const fov of [Math.PI / 6, Math.PI / 2]) near(heightForViewWidthM(viewWidthM(80_000, fov), fov), 80_000, 1e-4)
  near(heightForViewWidthM(0), 0, 1e-9)
  assert.equal(heightForViewWidthM(Math.PI * A), Number.POSITIVE_INFINITY)
})

test('viewWidthM matches where Cesium’s camera actually looks: canvas mid-left to mid-right edge over the equator', () => {
  const { camera, viewer } = fakeViewer()
  for (const h of [5_000, BROWSE_HEIGHT_M, 3_000_000]) {
    enterBrowse(viewer, { lat: 0, lon: 30 }, { heightM: h, flyS: 0 })
    const left = camera.pickEllipsoid(new Cartesian2(0, 300), Ellipsoid.WGS84) as Cartesian3
    const right = camera.pickEllipsoid(new Cartesian2(800, 300), Ellipsoid.WGS84) as Cartesian3
    const dLon = Ellipsoid.WGS84.cartesianToCartographic(right).longitude - Ellipsoid.WGS84.cartesianToCartographic(left).longitude
    near(A * dLon, viewWidthM(h), viewWidthM(h) * 1e-6, `h ${h}`)
  }
})

test('enterBrowse flyS 0: north-up, straight down, 300 km above the centre; tilt and free-look locked; zoom clamped', () => {
  const { camera, sscc, viewer } = fakeViewer()
  assert.equal(isBrowsing(viewer), false)
  enterBrowse(viewer, LLBG, { flyS: 0 })
  const p = latLonH(camera)
  near(p.lat, LLBG.lat, 1e-9)
  near(p.lon, LLBG.lon, 1e-9)
  near(p.h, BROWSE_HEIGHT_M, 1e-3)
  near(Math.min(headingDeg(camera), 360 - headingDeg(camera)), 0, 1e-6, 'north up')
  near(camera.pitch * DEG, -90, 1e-6)
  near(camera.roll, 0, 1e-9)
  assert.deepEqual(sscc, { enableTilt: false, enableLook: false, minimumZoomDistance: MIN_ZOOM_M, maximumZoomDistance: MAX_ZOOM_M })
  assert.equal(MIN_ZOOM_M, 2_000)
  assert.equal(MAX_ZOOM_M, 10_000_000)
  assert.equal(isBrowsing(viewer), true)
})

test('enterBrowse center null: over the point under the current camera; heightM is clamped to the zoom limits', () => {
  const { camera, viewer } = fakeViewer()
  camera.setView({ destination: Cartesian3.fromDegrees(11.34, 47.26, 1_500), orientation: { heading: 1, pitch: -0.2, roll: 0 } })
  enterBrowse(viewer, null, { heightM: 50, flyS: 0 })
  const p = latLonH(camera)
  near(p.lat, 47.26, 1e-9)
  near(p.lon, 11.34, 1e-9)
  near(p.h, MIN_ZOOM_M, 1e-3)
  enterBrowse(viewer, null, { heightM: 1e9, flyS: 0 })
  near(latLonH(camera).h, MAX_ZOOM_M, 1e-2)
  near(latLonH(camera).lon, 11.34, 1e-9)
})

test('enterBrowse from a chase camera: the lookAt frame is dropped first, so the view lands where asked', () => {
  const { camera, viewer } = fakeViewer()
  const target = Cartesian3.fromDegrees(LLBG.lon, LLBG.lat, 600)
  camera.lookAtTransform(Transforms.eastNorthUpToFixedFrame(target), new HeadingPitchRange(2, -0.2, 150))
  assert.ok(!Matrix4.equals(camera.transform, Matrix4.IDENTITY))
  enterBrowse(viewer, null, { flyS: 0 })
  assert.ok(Matrix4.equals(camera.transform, Matrix4.IDENTITY))
  const p = latLonH(camera)
  near(p.lat, LLBG.lat, 0.01, 'the chase camera was within 150 m of LLBG')
  near(p.lon, LLBG.lon, 0.01)
  near(p.h, BROWSE_HEIGHT_M, 1e-3)
})

test('enterBrowse default: a 1.2 s flight to the top-down view; flyS sets the duration', () => {
  const { camera, viewer } = fakeViewer()
  const flights: { destination: Cartesian3; orientation: { heading: number; pitch: number; roll: number }; duration: number }[] = []
  camera.flyTo = ((o: (typeof flights)[number]) => void flights.push(o)) as never
  enterBrowse(viewer, LLBG)
  enterBrowse(viewer, LLBG, { flyS: 3, heightM: 40_000 })
  assert.equal(BROWSE_FLY_S, 1.2)
  assert.equal(flights.length, 2)
  assert.equal(flights[0].duration, 1.2)
  assert.deepEqual(flights[0].orientation, { heading: 0, pitch: -Math.PI / 2, roll: 0 })
  assert.ok(Cartesian3.equalsEpsilon(flights[0].destination, Cartesian3.fromDegrees(LLBG.lon, LLBG.lat, BROWSE_HEIGHT_M), 0, 1e-6))
  assert.equal(flights[1].duration, 3)
  assert.ok(Cartesian3.equalsEpsilon(flights[1].destination, Cartesian3.fromDegrees(LLBG.lon, LLBG.lat, 40_000), 0, 1e-6))
})

test('a real 1.2 s flight: a jump while it runs replaces it, and exitBrowse stops it where it is', () => {
  const { camera, tweens, viewer } = fakeViewer()
  const EILAT = { lat: 29.56, lon: 34.95 }
  camera.setView({ destination: Cartesian3.fromDegrees(LLBG.lon, LLBG.lat, 60_000) })
  enterBrowse(viewer, EILAT)
  tweens.update(0)
  tweens.update(0.6)
  const mid = latLonH(camera).lat
  assert.ok(mid < LLBG.lat && mid > EILAT.lat, `halfway: ${mid}`)
  enterBrowse(viewer, LLBG, { flyS: 0 })
  tweens.update(5)
  near(latLonH(camera).lat, LLBG.lat, 1e-9, 'the jump stands; the old flight did not carry on to Eilat')
  near(latLonH(camera).h, BROWSE_HEIGHT_M, 1e-3)
  enterBrowse(viewer, EILAT)
  tweens.update(10)
  tweens.update(10.6)
  exitBrowse(viewer)
  const stopped = latLonH(camera)
  tweens.update(20)
  assert.deepEqual(latLonH(camera), stopped, 'nothing left to move the camera under the chase camera')
  assert.ok(stopped.lat < LLBG.lat && stopped.lat > EILAT.lat)
})

test('exitBrowse restores the controller settings from before browse, cancels a running browse flight, and is idempotent; a jump cancels too', () => {
  const { camera, sscc, viewer } = fakeViewer()
  sscc.minimumZoomDistance = 5 // some caller's own setting survives the round trip
  let cancels = 0
  camera.cancelFlight = () => void cancels++
  exitBrowse(viewer)
  assert.equal(cancels, 0, 'not browsing: nothing to cancel')
  enterBrowse(viewer, LLBG, { flyS: 0 })
  enterBrowse(viewer, LLBG, { flyS: 0 }) // re-centring must not save the browse settings as the originals
  assert.equal(cancels, 2, 'a jump stops a browse flight that may still be running')
  exitBrowse(viewer)
  assert.deepEqual(sscc, { enableTilt: true, enableLook: true, minimumZoomDistance: 5, maximumZoomDistance: Number.POSITIVE_INFINITY })
  assert.equal(cancels, 3)
  assert.equal(isBrowsing(viewer), false)
  exitBrowse(viewer)
  assert.equal(cancels, 3)
  assert.equal(sscc.minimumZoomDistance, 5)
})

test('viewRectangleDeg: the ground under a top-down view, in degrees', () => {
  const { viewer } = fakeViewer()
  enterBrowse(viewer, LLBG, { flyS: 0 })
  const r = viewRectangleDeg(viewer)
  assert.ok(r)
  assert.ok(containsDeg(r, LLBG.lat, LLBG.lon))
  near((r.west + r.east) / 2, LLBG.lon, 0.01, 'centred east-west')
  assert.ok(r.north - LLBG.lat > 0 && LLBG.lat - r.south > 0)
  // The corners sit a little further out than the mid-edges, so the rectangle is a bit wider than viewWidthM.
  const widthM = ((r.east - r.west) / DEG) * A * Math.cos(LLBG.lat / DEG)
  assert.ok(widthM > viewWidthM(BROWSE_HEIGHT_M) && widthM < viewWidthM(BROWSE_HEIGHT_M) * 1.1, `${widthM}`)
  const heightM = ((r.north - r.south) / DEG) * A
  near(heightM / widthM, 600 / 800, 0.05, '4:3 canvas')
})

test('viewRectangleDeg: null when the globe is out of view; the whole world when zoomed right out', () => {
  const { camera, viewer } = fakeViewer()
  camera.setView({ destination: Cartesian3.fromDegrees(LLBG.lon, LLBG.lat, BROWSE_HEIGHT_M), orientation: { heading: 0, pitch: CesiumMath.PI_OVER_TWO, roll: 0 } })
  assert.equal(viewRectangleDeg(viewer), null)
  enterBrowse(viewer, LLBG, { heightM: MAX_ZOOM_M, flyS: 0 })
  const r = viewRectangleDeg(viewer)
  assert.ok(r && containsDeg(r, LLBG.lat, LLBG.lon) && r.east - r.west > 90, JSON.stringify(r))
})

test('viewRectangleDeg across the antimeridian: west > east, and containsDeg handles the wrap', () => {
  const { viewer } = fakeViewer()
  enterBrowse(viewer, { lat: 0, lon: 180 }, { flyS: 0 })
  const r = viewRectangleDeg(viewer)
  assert.ok(r && r.west > r.east, JSON.stringify(r))
  assert.ok(containsDeg(r, 0, 179.9))
  assert.ok(containsDeg(r, 0, -179.9))
  assert.ok(!containsDeg(r, 0, 0))
  assert.ok(!containsDeg(r, 10, 180))
})

test('containsDeg: edges inclusive; latitude outside → false', () => {
  const r = { west: 30, south: 29, east: 36, north: 34 }
  assert.ok(containsDeg(r, 32, 34.9))
  assert.ok(containsDeg(r, 29, 30) && containsDeg(r, 34, 36))
  assert.ok(!containsDeg(r, 28.99, 32) && !containsDeg(r, 34.01, 32))
  assert.ok(!containsDeg(r, 32, 29.99) && !containsDeg(r, 32, 36.01))
})

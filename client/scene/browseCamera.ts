// client/scene/browseCamera.ts
// Browse mode's camera: a north-up, straight-down view like a slippy map. Tilt and free-look are locked so the map stays
// flat; Cesium's own controls still pan (drag) and zoom (wheel, right-drag), within MIN_ZOOM_M … MAX_ZOOM_M. On a
// trackpad, two fingers pan (browseDrag) and a pinch zooms (browsePinch).
import { Cartesian3, Ellipsoid, Math as CesiumMath, Matrix4, Rectangle } from 'cesium'
import type { ScreenSpaceCameraController, Viewer } from 'cesium'
import { attachTrackpad } from './trackpad.ts'

export const BROWSE_HEIGHT_M = 300_000 // ≈ 189 nm across the wider canvas axis (viewWidthM)
export const BROWSE_FLY_S = 1.2
export const MIN_ZOOM_M = 2_000
export const MAX_ZOOM_M = 10_000_000
/** Cesium's default PerspectiveFrustum.fov (60°). It spans the wider canvas axis. */
export const CESIUM_FOV_RAD = Math.PI / 3
// ponytail: the helpers treat the Earth as a sphere of the WGS84 equatorial radius: exact east-west along the equator,
// ≤ 0.34 % off elsewhere. Upgrade: pick the camera's rays against Ellipsoid.WGS84 (viewRectangleDeg already does).
const EARTH_R = 6_378_137
const TOP_DOWN = { heading: 0, pitch: -CesiumMath.PI_OVER_TWO, roll: 0 }
const MAX_DRAG_LAT = CesiumMath.toRadians(89) // a drag stops short of the pole, where north-up has no meaning

/** Visible ground rectangle in degrees. west > east when it spans the antimeridian. */
export interface RectDeg {
  west: number
  south: number
  east: number
  north: number
}

/**
 * Ground distance (m) spanned by a fan of rays fovRad wide, from a camera heightM up looking straight down.
 * A ray at angle θ off nadir meets the sphere at central angle asin((R+h)/R · sin θ) − θ. Once the edge rays miss the
 * Earth, the visible cap stops at the horizon, acos(R/(R+h)).
 */
export function viewWidthM(heightM: number, fovRad: number = CESIUM_FOV_RAD): number {
  const half = fovRad / 2
  const k = ((EARTH_R + heightM) / EARTH_R) * Math.sin(half)
  const phi = k <= 1 ? Math.asin(k) - half : Math.acos(EARTH_R / (EARTH_R + heightM))
  return 2 * EARTH_R * phi
}

/** Inverse of viewWidthM: the camera height that shows widthM across fovRad. Infinity when no height can. */
export function heightForViewWidthM(widthM: number, fovRad: number = CESIUM_FOV_RAD): number {
  const half = fovRad / 2
  const phi = widthM / (2 * EARTH_R)
  if (phi <= Math.PI / 2 - half) return EARTH_R * (Math.sin(half + phi) / Math.sin(half) - 1)
  if (phi < Math.PI / 2) return EARTH_R / Math.cos(phi) - EARTH_R
  return Number.POSITIVE_INFINITY
}

/**
 * The camera height that shows the whole of box, top-down, on a canvas widthPx × heightPx, with a little to spare. The
 * field of view spans the wider axis; the narrower one sees proportionally less.
 */
export function heightToFit(box: RectDeg, widthPx: number, heightPx: number, spare = 1.05): number {
  const mPerDeg = (EARTH_R * Math.PI) / 180
  const nsM = (box.north - box.south) * mPerDeg
  const ewM = (box.east - box.west) * mPerDeg * Math.cos((((box.north + box.south) / 2) * Math.PI) / 180)
  const narrowFov = 2 * Math.atan((Math.tan(CESIUM_FOV_RAD / 2) * Math.min(widthPx, heightPx)) / Math.max(widthPx, heightPx))
  const [fovX, fovY] = widthPx >= heightPx ? [CESIUM_FOV_RAD, narrowFov] : [narrowFov, CESIUM_FOV_RAD]
  return Math.max(heightForViewWidthM(ewM * spare, fovX), heightForViewWidthM(nsM * spare, fovY))
}

/** Is (lat, lon) inside r? Edges count as inside; a rectangle with west > east wraps across the antimeridian. */
export function containsDeg(r: RectDeg, lat: number, lon: number): boolean {
  if (lat < r.south || lat > r.north) return false
  return r.west <= r.east ? lon >= r.west && lon <= r.east : lon >= r.west || lon <= r.east
}

type Saved = Pick<ScreenSpaceCameraController, 'enableTilt' | 'enableLook' | 'minimumZoomDistance' | 'maximumZoomDistance'>
/** Keyed by controller, present = browsing: its settings from before browse, and the detach of browse's trackpad. */
const saved = new WeakMap<object, { before: Saved; detach: () => void }>()

export function isBrowsing(viewer: Viewer): boolean {
  return saved.has(viewer.scene.screenSpaceCameraController)
}

/**
 * Fly to a north-up top-down view (heading 0, pitch −90°) heightM above center, or above the point under the camera when
 * center is null. flyS 0 jumps. Locks tilt and free-look and clamps zoom until exitBrowse; calling it again re-centres.
 * Call ChaseCamera.release() first: it hands the mouse back to Cesium's controls.
 */
export function enterBrowse(viewer: Viewer, center: { lat: number; lon: number } | null, opts: { heightM?: number; flyS?: number } = {}): void {
  const camera = viewer.camera
  const sscc = viewer.scene.screenSpaceCameraController
  if (!saved.has(sscc)) {
    const { enableTilt, enableLook, minimumZoomDistance, maximumZoomDistance } = sscc
    const detach = attachTrackpad(viewer.scene.canvas, {
      drag: (dx, dy) => browseDrag(viewer, dx, dy),
      pinch: (ratio, x, y) => browsePinch(viewer, ratio, x, y),
    })
    saved.set(sscc, { before: { enableTilt, enableLook, minimumZoomDistance, maximumZoomDistance }, detach })
  }
  sscc.enableTilt = false
  sscc.enableLook = false
  sscc.minimumZoomDistance = MIN_ZOOM_M
  sscc.maximumZoomDistance = MAX_ZOOM_M

  camera.cancelFlight() // flyTo cancels a running flight itself; setView alone would leave it running
  camera.lookAtTransform(Matrix4.IDENTITY) // a chase camera leaves its lookAt frame on the camera
  const under = camera.positionCartographic
  const lat = center ? center.lat : CesiumMath.toDegrees(under.latitude)
  const lon = center ? center.lon : CesiumMath.toDegrees(under.longitude)
  const heightM = CesiumMath.clamp(opts.heightM ?? BROWSE_HEIGHT_M, MIN_ZOOM_M, MAX_ZOOM_M)
  const destination = Cartesian3.fromDegrees(lon, lat, heightM)
  const flyS = Math.max(0, opts.flyS ?? BROWSE_FLY_S)
  if (flyS === 0) camera.setView({ destination, orientation: TOP_DOWN })
  else camera.flyTo({ destination, orientation: TOP_DOWN, duration: flyS })
}

/** Leave browse: stop a browse flight still under way (it would fight the chase camera) and restore the controller settings. */
export function exitBrowse(viewer: Viewer): void {
  const sscc = viewer.scene.screenSpaceCameraController
  const s = saved.get(sscc)
  if (!s) return
  viewer.camera.cancelFlight()
  s.detach()
  Object.assign(sscc, s.before)
  saved.delete(sscc)
}

/** Browse: the map follows two fingers moving (dxPx, dyPx) (right, down) on a trackpad. */
export function browseDrag(viewer: Viewer, dxPx: number, dyPx: number): void {
  moveTopDown(viewer, dxPx, dyPx)
}

/**
 * Browse: two fingers spread by ratio around (xPx, yPx) (CSS px from the canvas's top-left). The camera comes that much
 * closer, no lower than MIN_ZOOM_M over the ground (where Cesium would lift it) and no higher than MAX_ZOOM_M, and the
 * ground under the fingers stays under them.
 */
export function browsePinch(viewer: Viewer, ratio: number, xPx: number, yPx: number): void {
  const c = viewer.camera.positionCartographic
  const canvas = viewer.scene.canvas
  const heightM = CesiumMath.clamp(c.height / ratio, (viewer.scene.globe.getHeight(c) ?? 0) + MIN_ZOOM_M, MAX_ZOOM_M)
  const k = 1 - heightM / c.height // the share of the way to the fingers that the middle moves
  moveTopDown(viewer, (canvas.clientWidth / 2 - xPx) * k, (canvas.clientHeight / 2 - yPx) * k, heightM)
}

/**
 * Moves the top-down view so the ground follows a drag of (dxPx, dyPx), at the middle's scale (a pinhole camera over
 * flat ground: exact there, and close enough across the view), then puts the camera heightM up. North up, straight down.
 */
function moveTopDown(viewer: Viewer, dxPx: number, dyPx: number, heightM?: number): void {
  const camera = viewer.camera
  const c = camera.positionCartographic
  const canvas = viewer.scene.canvas
  const mPerPx = (2 * c.height * Math.tan(CESIUM_FOV_RAD / 2)) / Math.max(canvas.clientWidth, canvas.clientHeight)
  const lat = CesiumMath.clamp(c.latitude + (dyPx * mPerPx) / EARTH_R, -MAX_DRAG_LAT, MAX_DRAG_LAT)
  const lon = c.longitude - (dxPx * mPerPx) / (EARTH_R * Math.cos(c.latitude))
  camera.cancelFlight() // the fingers win over a flight still under way
  camera.setView({ destination: Cartesian3.fromRadians(lon, lat, heightM ?? c.height), orientation: TOP_DOWN })
}

const scratchRect = new Rectangle()

/** The ground the camera sees (Camera.computeViewRectangle, WGS84), in degrees; null when the globe is out of view. */
export function viewRectangleDeg(viewer: Viewer): RectDeg | null {
  const r = viewer.camera.computeViewRectangle(Ellipsoid.WGS84, scratchRect)
  if (!r) return null
  const d = CesiumMath.toDegrees
  return { west: d(r.west), south: d(r.south), east: d(r.east), north: d(r.north) }
}

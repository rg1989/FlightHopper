// client/scene/chaseCamera.ts
import { Cartesian3, Ellipsoid, HeadingPitchRange, Matrix4, ScreenSpaceEventHandler, ScreenSpaceEventType, Transforms } from 'cesium'
import type { Camera, Cartographic, Scene, Viewer } from 'cesium'
import type { RenderState } from '../types.ts'

const RAD = Math.PI / 180
const STEEPEST_DEG = -89 // looking straight down makes lookAt's heading degenerate
const AIM_ABOVE_MIN_M = 0.5 // correct to min + 0.5 m so float noise never reads as a violation
const CLEARANCE_PASSES = 4 // terrain under the camera changes as it moves; 4 re-measures settle real slopes
const DEG_PER_PX_H = 0.3 // horizontal drag: a 1,200 px swipe ≈ one full orbit
const DEG_PER_PX_V = 0.25
const PITCH_MAX_DEG = 10 // slightly below the aircraft, looking up
const ZOOM_PER_WHEEL = 0.0015 // Cesium wheel delta ≈ ±100 per notch → ×0.86 / ×1.16
const RANGE_MIN_M = 25
const RANGE_MAX_M = 3000

/**
 * Camera position relative to the target, in the target's local east-north-up frame (metres).
 * Same convention as Cesium's lookAt(HeadingPitchRange): the camera looks along headingDeg, so it sits behind
 * the nose direction; pitchDeg is the camera's look angle, negative = looking down, so it sits above.
 */
export function chaseOffsetEnu(headingDeg: number, pitchDeg: number, rangeM: number): [number, number, number] {
  const h = headingDeg * RAD
  const p = pitchDeg * RAD
  const horizontal = rangeM * Math.cos(p)
  return [-horizontal * Math.sin(h), -horizontal * Math.cos(h), -rangeM * Math.sin(p)]
}

/**
 * User-controlled orbit around the chased aircraft: horizontal angle relative to its nose, look pitch and distance.
 * Drag convention as in three.js OrbitControls: the aircraft follows the mouse (drag right → camera swings to its left).
 */
export class OrbitControl {
  headingOffsetDeg = 0
  pitchDeg: number
  rangeM: number
  #pitch0: number
  #range0: number

  constructor(pitchDeg: number, rangeM: number) {
    this.pitchDeg = this.#pitch0 = pitchDeg
    this.rangeM = this.#range0 = rangeM
  }

  drag(dxPx: number, dyPx: number): void {
    this.headingOffsetDeg = wrap360(this.headingOffsetDeg + dxPx * DEG_PER_PX_H)
    this.pitchDeg = clamp(this.pitchDeg - dyPx * DEG_PER_PX_V, STEEPEST_DEG, PITCH_MAX_DEG)
  }

  /** Cesium wheel delta: positive = wheel up = closer. */
  wheel(delta: number): void {
    this.rangeM = clamp(this.rangeM * Math.exp(-delta * ZOOM_PER_WHEEL), RANGE_MIN_M, RANGE_MAX_M)
  }

  /** Back behind the aircraft at the starting pitch and distance. */
  reset(): void {
    this.headingOffsetDeg = 0
    this.pitchDeg = this.#pitch0
    this.rangeM = this.#range0
  }
}

export interface ChaseCameraOpts {
  rangeM?: number
  pitchDeg?: number
  minClearanceM?: number
  headingTauS?: number
  /**
   * Ground height (HAE m) under a point, null while unknown. Default: globe.getHeight. The app passes the ground drawn
   * this frame, because globe.getHeight lags one frame behind the topography animation (Topography.ground). Called once
   * per clearance pass, up to 5 times a frame, each time at the camera's new position.
   */
  groundAt?: (c: Cartographic) => number | null
}

/**
 * Third-person camera on one aircraft, heading-damped, kept ≥ minClearanceM above the loaded terrain.
 * While chasing, mouse input orbits (drag), zooms (wheel) and resets (double-click) instead of moving the globe.
 */
export class ChaseCamera {
  readonly orbit: OrbitControl
  #camera: Camera
  #scene: Scene
  #groundAt: (c: Cartographic) => number | null
  #input: ScreenSpaceEventHandler | null = null
  #minClearanceM: number
  #tauS: number
  #headingDeg: number | null = null
  #target = new Cartesian3()
  #frame = new Matrix4()
  #hpr = new HeadingPitchRange()

  constructor(viewer: Viewer, opts: ChaseCameraOpts = {}) {
    this.#camera = viewer.camera
    this.#scene = viewer.scene
    const globe = viewer.scene.globe
    this.#groundAt = opts.groundAt ?? ((c) => globe.getHeight(c) ?? null)
    this.orbit = new OrbitControl(opts.pitchDeg ?? -12, opts.rangeM ?? 150)
    this.#minClearanceM = opts.minClearanceM ?? 15
    this.#tauS = opts.headingTauS ?? 1.0
  }

  update(state: RenderState, dtS: number): { clearanceM: number | null } {
    this.#attachInput()
    const heading = wrap360(this.#smoothHeading(state.headingDeg, dtS) + this.orbit.headingOffsetDeg)
    let pitch = this.orbit.pitchDeg
    let liftM = 0
    let clearance = this.#place(state, heading, pitch, liftM)
    // ponytail: the correction is recomputed every frame, not smoothed. Ceiling: a cliff under the camera snaps the pitch;
    // upgrade: low-pass the correction with the heading tau.
    for (let i = 0; i < CLEARANCE_PASSES && clearance !== null && clearance < this.#minClearanceM; i++) {
      // Pitching from p to p' raises the camera by range·(sin p − sin p'), so solve for the missing metres.
      const needM = this.#minClearanceM + AIM_ABOVE_MIN_M - clearance
      const sinP = Math.sin(pitch * RAD) - needM / this.orbit.rangeM
      if (sinP >= Math.sin(STEEPEST_DEG * RAD)) pitch = Math.asin(sinP) / RAD
      else if (pitch > STEEPEST_DEG) pitch = STEEPEST_DEG // go (almost) straight above first, then measure again
      else liftM += needM // already above: the aircraft is under the terrain model, so raise the whole rig
      clearance = this.#place(state, heading, pitch, liftM)
    }
    return { clearanceM: clearance }
  }

  /** Hand the camera back to the globe controls. The next chase starts behind its aircraft; zoom and pitch are kept. */
  release(): void {
    this.#camera.lookAtTransform(Matrix4.IDENTITY)
    this.#headingDeg = null
    this.orbit.headingOffsetDeg = 0
    this.#input?.destroy()
    this.#input = null
    this.#scene.screenSpaceCameraController.enableInputs = true
  }

  /** First chased frame: route the mouse to the orbit instead of Cesium's globe controls. No-op without a DOM canvas. */
  #attachInput(): void {
    if (this.#input || typeof (this.#scene.canvas as { addEventListener?: unknown }).addEventListener !== 'function') return
    this.#scene.screenSpaceCameraController.enableInputs = false
    const h = (this.#input = new ScreenSpaceEventHandler(this.#scene.canvas))
    let dragging = false
    h.setInputAction(() => (dragging = true), ScreenSpaceEventType.LEFT_DOWN)
    h.setInputAction(() => (dragging = false), ScreenSpaceEventType.LEFT_UP)
    h.setInputAction((m: ScreenSpaceEventHandler.MotionEvent) => {
      if (dragging) this.orbit.drag(m.endPosition.x - m.startPosition.x, m.endPosition.y - m.startPosition.y)
    }, ScreenSpaceEventType.MOUSE_MOVE)
    h.setInputAction((delta: number) => this.orbit.wheel(delta), ScreenSpaceEventType.WHEEL)
    h.setInputAction(() => this.orbit.reset(), ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
  }

  /** Exponential smoothing towards the aircraft heading along the shorter way round; the first frame snaps. */
  #smoothHeading(targetDeg: number, dtS: number): number {
    if (this.#headingDeg === null) return (this.#headingDeg = wrap360(targetDeg))
    const k = this.#tauS > 0 ? 1 - Math.exp(-Math.max(0, dtS) / this.#tauS) : 1
    const delta = wrap360(targetDeg - this.#headingDeg + 180) - 180
    return (this.#headingDeg = wrap360(this.#headingDeg + k * delta))
  }

  /** Put the camera on the target's ENU frame; returns camera height − ground height, null while the ground is unknown. */
  #place(state: RenderState, headingDeg: number, pitchDeg: number, liftM: number): number | null {
    Cartesian3.fromDegrees(state.lon, state.lat, state.hM + liftM, Ellipsoid.WGS84, this.#target)
    Transforms.eastNorthUpToFixedFrame(this.#target, Ellipsoid.WGS84, this.#frame)
    this.#hpr.heading = headingDeg * RAD
    this.#hpr.pitch = pitchDeg * RAD
    this.#hpr.range = this.orbit.rangeM
    this.#camera.lookAtTransform(this.#frame, this.#hpr)
    const c = this.#camera.positionCartographic
    const ground = this.#groundAt(c)
    return ground === null ? null : c.height - ground
  }
}

const wrap360 = (deg: number): number => ((deg % 360) + 360) % 360
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))

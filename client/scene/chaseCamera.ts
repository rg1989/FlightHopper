// client/scene/chaseCamera.ts
import { Cartesian3, Ellipsoid, HeadingPitchRange, Matrix4, Transforms } from 'cesium'
import type { Camera, Globe, Viewer } from 'cesium'
import type { RenderState } from '../types.ts'

const RAD = Math.PI / 180
const STEEPEST_DEG = -89 // looking straight down makes lookAt's heading degenerate
const AIM_ABOVE_MIN_M = 0.5 // correct to min + 0.5 m so float noise never reads as a violation
const CLEARANCE_PASSES = 4 // terrain under the camera changes as it moves; 4 re-measures settle real slopes

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

export interface ChaseCameraOpts {
  rangeM?: number
  pitchDeg?: number
  minClearanceM?: number
  headingTauS?: number
}

/** Third-person camera locked behind one aircraft, heading-damped, kept ≥ minClearanceM above the loaded terrain. */
export class ChaseCamera {
  #camera: Camera
  #globe: Globe
  #rangeM: number
  #pitchDeg: number
  #minClearanceM: number
  #tauS: number
  #headingDeg: number | null = null
  #target = new Cartesian3()
  #frame = new Matrix4()
  #hpr = new HeadingPitchRange()

  constructor(viewer: Viewer, opts: ChaseCameraOpts = {}) {
    this.#camera = viewer.camera
    this.#globe = viewer.scene.globe
    this.#rangeM = opts.rangeM ?? 150
    this.#pitchDeg = opts.pitchDeg ?? -12
    this.#minClearanceM = opts.minClearanceM ?? 15
    this.#tauS = opts.headingTauS ?? 1.0
  }

  update(state: RenderState, dtS: number): { clearanceM: number | null } {
    const heading = this.#smoothHeading(state.headingDeg, dtS)
    let pitch = this.#pitchDeg
    let liftM = 0
    let clearance = this.#place(state, heading, pitch, liftM)
    // ponytail: the correction is recomputed every frame, not smoothed. Ceiling: a cliff under the camera snaps the pitch;
    // upgrade: low-pass the correction with the heading tau.
    for (let i = 0; i < CLEARANCE_PASSES && clearance !== null && clearance < this.#minClearanceM; i++) {
      // Pitching from p to p' raises the camera by range·(sin p − sin p'), so solve for the missing metres.
      const needM = this.#minClearanceM + AIM_ABOVE_MIN_M - clearance
      const sinP = Math.sin(pitch * RAD) - needM / this.#rangeM
      if (sinP >= Math.sin(STEEPEST_DEG * RAD)) pitch = Math.asin(sinP) / RAD
      else if (pitch > STEEPEST_DEG) pitch = STEEPEST_DEG // go (almost) straight above first, then measure again
      else liftM += needM // already above: the aircraft is under the terrain model, so raise the whole rig
      clearance = this.#place(state, heading, pitch, liftM)
    }
    return { clearanceM: clearance }
  }

  release(): void {
    this.#camera.lookAtTransform(Matrix4.IDENTITY)
    this.#headingDeg = null
  }

  /** Exponential smoothing towards the aircraft heading along the shorter way round; the first frame snaps. */
  #smoothHeading(targetDeg: number, dtS: number): number {
    if (this.#headingDeg === null) return (this.#headingDeg = wrap360(targetDeg))
    const k = this.#tauS > 0 ? 1 - Math.exp(-Math.max(0, dtS) / this.#tauS) : 1
    const delta = wrap360(targetDeg - this.#headingDeg + 180) - 180
    return (this.#headingDeg = wrap360(this.#headingDeg + k * delta))
  }

  /** Put the camera on the target's ENU frame; returns camera height − terrain height, null while that tile is not loaded. */
  #place(state: RenderState, headingDeg: number, pitchDeg: number, liftM: number): number | null {
    Cartesian3.fromDegrees(state.lon, state.lat, state.hM + liftM, Ellipsoid.WGS84, this.#target)
    Transforms.eastNorthUpToFixedFrame(this.#target, Ellipsoid.WGS84, this.#frame)
    this.#hpr.heading = headingDeg * RAD
    this.#hpr.pitch = pitchDeg * RAD
    this.#hpr.range = this.#rangeM
    this.#camera.lookAtTransform(this.#frame, this.#hpr)
    const c = this.#camera.positionCartographic
    const terrain = this.#globe.getHeight(c) ?? null
    return terrain === null ? null : c.height - terrain
  }
}

const wrap360 = (deg: number): number => ((deg % 360) + 360) % 360

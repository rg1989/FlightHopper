// client/scene/gear.ts
// The landing gear of a live aircraft: when it is down (gearWanted, from what the aircraft is doing), how it moves
// (GearMotion: the hydraulics' time, eased), and where each leg is (legMatrix: swung about its hinge, manifest legs).
// A crew lowers the gear on the approach, typically between 2,000 and 1,000 ft above the ground and well below the
// gear's speed limit (VLE ~250 kt), and raises it once the aircraft climbs away with a positive rate; in between it
// stays as it was.
import { Cartesian3, Matrix3, Matrix4, Quaternion } from 'cesium'
import type { Model, ModelNode } from 'cesium'
import type { ModelManifestEntry } from '../types.ts'
import { smoothstep } from './exaggeration.ts'

export const EXTEND_S = 12 // down: doors, free fall and lock, about 10–15 s on an airliner
export const RETRACT_S = 9 // up: 8–10 s
export const GEAR_DOWN_AGL_FT = 2000 // on the approach, below this…
const APPROACH_VS_FPM = -250 // …descending…
const GEAR_MAX_KT = 230 // …and slow enough (VLE, with a margin: ground speed stands in for airspeed)
const CLIMB_VS_FPM = 400 // positive rate: gear up…
const LIFTOFF_AGL_FT = 35 // …once clear of the runway
const EN_ROUTE_AGL_FT = 5000 // above this, up whatever it was

/** What decides the gear: the aircraft's state and its height above the ground (null: unknown). */
export interface GearCue {
  onGround: boolean
  aglFt: number | null
  vsFpm: number | null
  gsKt: number | null
}

/** Whether the gear should be down now; prev: the last answer (null: a first look, taken as up unless shown otherwise). */
export function gearWanted(prev: boolean | null, s: GearCue): boolean {
  if (s.onGround) return true
  const vs = s.vsFpm ?? 0
  if (s.aglFt === null) return vs > CLIMB_VS_FPM ? false : (prev ?? false)
  if (s.aglFt > EN_ROUTE_AGL_FT) return false
  if (s.aglFt < GEAR_DOWN_AGL_FT && vs < APPROACH_VS_FPM && (s.gsKt ?? Infinity) < GEAR_MAX_KT) return true
  if (vs > CLIMB_VS_FPM && s.aglFt > LIFTOFF_AGL_FT) return false
  return prev ?? false
}

/** The gear's position, 0 up … 1 down, moving towards its target at the hydraulics' rates. */
export class GearMotion {
  pos = 0
  target = false
  #first = true

  /** Towards target for dtS seconds. The first call takes the target at once (an aircraft first seen as it is). */
  step(target: boolean, dtS: number): void {
    if (this.#first) {
      this.snap(target)
      return
    }
    this.target = target
    const d = Math.max(0, dtS)
    this.pos = target ? Math.min(1, this.pos + d / EXTEND_S) : Math.max(0, this.pos - d / RETRACT_S)
  }

  /** At target at once (a seek, a new aircraft). */
  snap(target: boolean): void {
    this.#first = false
    this.target = target
    this.pos = target ? 1 : 0
  }

  /** The next step() snaps again (another aircraft). */
  reset(): void {
    this.#first = true
  }
}

const scratchQ = new Quaternion()
const scratchM3 = new Matrix3()

/**
 * A leg's node matrix at position p (1 down): its hinge, and swung upDeg about axis (body frame, right-handed) as the
 * gear goes up, eased at both ends.
 */
export function legMatrix(hinge: Cartesian3, axis: Cartesian3, upDeg: number, p: number, result: Matrix4): Matrix4 {
  const angle = ((upDeg * Math.PI) / 180) * (1 - smoothstep(p))
  Matrix3.fromQuaternion(Quaternion.fromAxisAngle(axis, angle, scratchQ), scratchM3)
  return Matrix4.fromRotationTranslation(scratchM3, hinge, result)
}

type Legs = NonNullable<NonNullable<ModelManifestEntry['gear']>['legs']>
const scratchHinge = new Cartesian3()
const scratchAxis = new Cartesian3()

/**
 * A loaded gear model's legs swung to position p (1 down). nodes: its leg nodes in the manifest's order, looked up once
 * (the model must be ready). Returns them for the next call.
 */
export function swingLegs(model: Model, legs: Legs, p: number, nodes?: Array<ModelNode | undefined>): Array<ModelNode | undefined> {
  const ns = nodes ?? legs.map((l) => model.getNode(l.node))
  legs.forEach((l, i) => {
    const n = ns[i]
    if (n === undefined) return
    const hinge = Matrix4.getTranslation(n.originalMatrix, scratchHinge)
    n.matrix = legMatrix(hinge, Cartesian3.fromArray(l.axis, 0, scratchAxis), l.upDeg, p, new Matrix4())
  })
  return ns
}

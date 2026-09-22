// client/scene/model.ts
// WP-V3 model calibration: place the chase model so that its nose points along RenderState.headingDeg.
// The aircraft must never fly sideways. model.test.ts proves it from the GLB's own geometry.
import { Axis, Cartesian3, HeadingPitchRoll, Math as CesiumMath, Matrix4, Model, Quaternion, Transforms } from 'cesium'
import type { Viewer } from 'cesium'
import type { ModelManifestEntry, RenderState } from '../types.ts'

// ---------- glTF geometry in Cesium's model frame ----------

// Model applies this rotation to every glTF 2.0 asset before modelMatrix
// (ModelUtility.getAxisCorrectionMatrix(Axis.Y, Axis.Z) = Axis.Y_UP_TO_Z_UP · Axis.Z_UP_TO_X_UP):
// glTF +Z (the front, per the glTF spec) → +X, glTF +Y (up) → +Z, glTF +X → +Y.
// The Axis matrices exist at runtime but Cesium.d.ts does not declare them, hence the cast.
const axis = Axis as unknown as { Y_UP_TO_Z_UP: Matrix4; Z_UP_TO_X_UP: Matrix4 }
export const GLTF_TO_CESIUM: Matrix4 = Matrix4.multiplyTransformation(axis.Y_UP_TO_Z_UP, axis.Z_UP_TO_X_UP, new Matrix4())

/** A GLB measured in Cesium's model frame (after GLTF_TO_CESIUM, before scale). Axes are unit vectors. */
export interface GlbAxes {
  nose: Cartesian3
  up: Cartesian3
  right: Cartesian3 // nose × up
  lengthM: number // extent along nose
  spanM: number // extent along right
  belowOriginM: number // origin → lowest vertex (wheel bottom)
}

/**
 * Finds the nose from the geometry alone. Up is glTF +Y (the glTF spec). The vertical fin (every vertex in the top
 * quarter of the height) sits at the tail, so the nose is the horizontal direction from the fin's centroid to the
 * bounding-box centre.
 * ponytail: reads dense float VEC3 POSITION from the GLB's BIN chunk only, and refuses any extensionsRequired
 * (Draco, meshopt). Upgrade: decode through Cesium's GltfLoader if a compressed model is ever added.
 */
export function measureGlb(glb: Uint8Array): GlbAxes {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  if (glb.byteLength < 28 || dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(4, true) !== 2) {
    throw new Error('not a glTF 2.0 GLB')
  }
  const jsonLen = dv.getUint32(12, true)
  const gltf = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)))
  if (gltf.extensionsRequired?.length) throw new Error(`unsupported glTF extensions: ${gltf.extensionsRequired.join(', ')}`)
  const binStart = 20 + jsonLen + 8

  const pts: Cartesian3[] = []
  const visit = (i: number, parent: Matrix4): void => {
    const n = gltf.nodes[i]
    const local = n.matrix
      ? Matrix4.fromArray(n.matrix)
      : Matrix4.fromTranslationQuaternionRotationScale(
          Cartesian3.fromArray(n.translation ?? [0, 0, 0]),
          Quaternion.unpack(n.rotation ?? [0, 0, 0, 1]),
          Cartesian3.fromArray(n.scale ?? [1, 1, 1]),
        )
    const world = Matrix4.multiply(parent, local, new Matrix4())
    for (const prim of n.mesh === undefined ? [] : gltf.meshes[n.mesh].primitives) {
      const a = gltf.accessors[prim.attributes.POSITION]
      if (a.componentType !== 5126 || a.type !== 'VEC3' || a.sparse) throw new Error('POSITION must be dense float VEC3')
      const bv = gltf.bufferViews[a.bufferView]
      const stride = bv.byteStride ?? 12
      const base = binStart + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0)
      for (let k = 0; k < a.count; k++) {
        const o = base + k * stride
        const p = new Cartesian3(dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true))
        pts.push(Matrix4.multiplyByPoint(world, p, p))
      }
    }
    for (const c of n.children ?? []) visit(c, world)
  }
  for (const i of gltf.scenes[gltf.scene ?? 0].nodes) visit(i, GLTF_TO_CESIUM)

  let [xMin, xMax, yMin, yMax, zMin, zMax] = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity]
  for (const p of pts) {
    xMin = Math.min(xMin, p.x); xMax = Math.max(xMax, p.x)
    yMin = Math.min(yMin, p.y); yMax = Math.max(yMax, p.y)
    zMin = Math.min(zMin, p.z); zMax = Math.max(zMax, p.z)
  }
  const finZ = zMax - 0.25 * (zMax - zMin)
  let [fx, fy, nf] = [0, 0, 0]
  for (const p of pts) if (p.z >= finZ) { fx += p.x; fy += p.y; nf++ }
  const tailToCentre = new Cartesian3((xMin + xMax) / 2 - fx / nf, (yMin + yMax) / 2 - fy / nf, 0)
  const nose = Cartesian3.normalize(tailToCentre, new Cartesian3())
  const up = Cartesian3.clone(Cartesian3.UNIT_Z)
  const right = Cartesian3.cross(nose, up, new Cartesian3())
  const extent = (v: Cartesian3): number => {
    let [lo, hi] = [Infinity, -Infinity]
    for (const p of pts) { const d = Cartesian3.dot(p, v); lo = Math.min(lo, d); hi = Math.max(hi, d) }
    return hi - lo
  }
  return { nose, up, right, lengthM: extent(nose), spanM: extent(right), belowOriginM: -zMin }
}

// ---------- attitude → Cesium ----------
//
// Cesium's conventions, read from the cesium 1.145 source (@cesium/engine Core/Quaternion.js fromHeadingPitchRoll and
// Core/Transforms.js headingPitchRollToFixedFrame): the matrix is ENU(origin) · Rz(−heading) · Ry(−pitch) · Rx(roll),
// with ENU x = east, y = north, z = up. In the model frame above (nose +X, left wing +Y, up +Z) that means:
// - heading 0 points the nose EAST, and positive heading turns it clockwise seen from above: azimuth = 90° + heading.
//   A model whose nose is +X therefore needs forwardAxisFix.headingDeg = −90.
// - positive pitch raises +X: nose up, the same sign as RenderState.pitchDeg.
// - positive roll lifts +Y (the left wing): right wing down, the same sign as RenderState.rollDeg.
// So hprFor only adds the fix. No sign is flipped.

/** Cesium HeadingPitchRoll (radians) for a RenderState: its attitude plus the model's forwardAxisFix. */
export function hprFor(state: RenderState, m: ModelManifestEntry, result: HeadingPitchRoll = new HeadingPitchRoll()): HeadingPitchRoll {
  const fix = m.forwardAxisFix
  result.heading = CesiumMath.toRadians(state.headingDeg + fix.headingDeg)
  result.pitch = CesiumMath.toRadians(state.pitchDeg + fix.pitchDeg)
  result.roll = CesiumMath.toRadians(state.rollDeg + fix.rollDeg)
  return result
}

const scratchPos = new Cartesian3()
const scratchHpr = new HeadingPitchRoll()

/**
 * World matrix of the chase model: origin at (lat, lon, hM + gearHeightM), attitude from hprFor, uniform m.scale
 * baked in (so ChaseModel leaves Model.scale at 1).
 * ponytail: hM is the wheel-bottom height in every phase, not only on the ground, so touchdown has no gear-height
 * step. Airborne, that bias is smaller than ADS-B's 25 ft altitude step. The offset runs along the ellipsoid normal,
 * not body-up, so at 10° pitch the wheels sit 0.06 m high. Upgrade: offset along body-up when M4 adds ground contact.
 */
export function modelMatrixFor(state: RenderState, m: ModelManifestEntry, result?: Matrix4): Matrix4 {
  const pos = Cartesian3.fromDegrees(state.lon, state.lat, state.hM + m.gearHeightM, undefined, scratchPos)
  const mm = Transforms.headingPitchRollToFixedFrame(pos, hprFor(state, m, scratchHpr), undefined, undefined, result ?? new Matrix4())
  return Matrix4.multiplyByUniformScale(mm, m.scale, mm)
}

const scratchOrigin = new Cartesian3()
const scratchEnu = new Matrix4()
const scratchDir = new Cartesian3()

/** A model-frame direction as a unit vector in ENU (x east, y north, z up) at the model's origin. */
function toEnu(modelMatrix: Matrix4, v: Cartesian3, result: Cartesian3): Cartesian3 {
  const origin = Matrix4.getTranslation(modelMatrix, scratchOrigin)
  const fixedToEnu = Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(origin, undefined, scratchEnu), scratchEnu)
  const world = Matrix4.multiplyByPointAsVector(modelMatrix, v, result)
  return Cartesian3.normalize(Matrix4.multiplyByPointAsVector(fixedToEnu, world, result), result)
}

/**
 * True azimuth of the model's nose in [0, 360), clockwise from north. noseAxis is the nose in Cesium's model frame:
 * +X by Cesium's convention, or measureGlb(glb).nose to check a particular asset.
 */
export function noseAzimuthDeg(modelMatrix: Matrix4, noseAxis: Cartesian3 = Cartesian3.UNIT_X): number {
  const f = toEnu(modelMatrix, noseAxis, scratchDir)
  return (CesiumMath.toDegrees(Math.atan2(f.x, f.y)) + 360) % 360
}

// ---------- the chased model in the scene ----------

/** Manifest uris are relative to public/, so they resolve against Vite's base URL ('/' in Node tests). */
function modelUrl(m: ModelManifestEntry): string {
  return `${import.meta.env?.BASE_URL ?? '/'}${m.uri}`
}

export class ChaseModel {
  readonly model: Model
  private readonly viewer: Viewer
  private readonly m: ModelManifestEntry
  private visible = true
  private placed = false

  /** Prefer ChaseModel.load. Adds the model to the scene hidden: it appears on the first update(), not at the Earth's centre. */
  constructor(viewer: Viewer, m: ModelManifestEntry, model: Model) {
    this.viewer = viewer
    this.m = m
    this.model = model
    model.show = false
    viewer.scene.primitives.add(model)
  }

  static async load(viewer: Viewer, m: ModelManifestEntry): Promise<ChaseModel> {
    // Model clones its own identity modelMatrix, which update() then rewrites. The scale is in modelMatrixFor, so
    // Model.scale stays 1. minimumPixelSize keeps a distant model visible.
    const model = await Model.fromGltfAsync({ url: modelUrl(m), minimumPixelSize: 32, show: false })
    return new ChaseModel(viewer, m, model)
  }

  /** Rewrites modelMatrix in place. Model.update compares it with its cached copy on the next frame. */
  update(state: RenderState): void {
    modelMatrixFor(state, this.m, this.model.modelMatrix)
    this.placed = true
    this.model.show = this.visible
  }

  get show(): boolean {
    return this.visible
  }

  set show(v: boolean) {
    this.visible = v
    this.model.show = v && this.placed
  }

  /** Removes the model from the scene. PrimitiveCollection destroys what it removes by default. */
  destroy(): void {
    this.viewer.scene.primitives.remove(this.model)
  }
}

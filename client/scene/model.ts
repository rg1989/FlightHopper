// client/scene/model.ts
// WP-V3 model calibration: place the chase model so that its nose points along RenderState.headingDeg.
// The aircraft must never fly sideways. model.test.ts proves it from the GLB's own geometry.
// ChaseModel also carries a scenario's look: its livery, a folded span, damage and a separate landing gear.
import { Axis, Cartesian3, HeadingPitchRoll, Math as CesiumMath, Matrix4, Model, Quaternion, Transforms } from 'cesium'
import type { CustomShader, Viewer } from 'cesium'
import type { ModelManifestEntry, RenderState } from '../types.ts'
import { LiveryShaders } from './livery.ts'
import type { Livery } from './livery.ts'

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
  centre: Cartesian3 // bounding-box centre
  min: Cartesian3 // bounding box
  max: Cartesian3
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
  const centre = new Cartesian3((xMin + xMax) / 2, (yMin + yMax) / 2, (zMin + zMax) / 2)
  const [min, max] = [new Cartesian3(xMin, yMin, zMin), new Cartesian3(xMax, yMax, zMax)]
  return { nose, up, right, lengthM: extent(nose), spanM: extent(right), belowOriginM: -zMin, centre, min, max }
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
 * World matrix of the chase model: origin at (lat, lon, hM + heightM), attitude from hprFor, uniform m.scale
 * baked in (so ChaseModel leaves Model.scale at 1). heightM is origin → wheel bottom: gearHeightM, or gear.heightM
 * while ChaseModel draws the separate gear.
 * ponytail: hM is the wheel-bottom height in every phase, not only on the ground, so touchdown has no gear-height
 * step. Airborne, that bias is smaller than ADS-B's 25 ft altitude step. The offset runs along the ellipsoid normal,
 * not body-up, so at 10° pitch the wheels sit 0.06 m high. Upgrade: offset along body-up when M4 adds ground contact.
 */
export function modelMatrixFor(state: RenderState, m: ModelManifestEntry, result?: Matrix4, heightM = m.gearHeightM): Matrix4 {
  const pos = Cartesian3.fromDegrees(state.lon, state.lat, state.hM + heightM, undefined, scratchPos)
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
export function modelUrl(m: ModelManifestEntry): string {
  return `${import.meta.env?.BASE_URL ?? '/'}${m.uri}`
}

export class ChaseModel {
  /** The model drawn now: the chased type's once it has loaded (use), until then the one before. */
  model: Model
  private readonly viewer: Viewer
  private m: ModelManifestEntry
  private visible = true
  private placed = false
  private readonly liveries = new Map<string, LiveryShaders>()
  private livery: string | null | undefined
  private readonly ready = new Map<string, Model>() // every loaded model by entry id, in the scene (hidden unless drawn)
  private readonly asked = new Set<string>() // entry ids loading or loaded (or failed: not asked again)
  private readonly loader: (m: ModelManifestEntry) => Promise<Model>
  private readonly gearLoader: (uri: string) => Promise<Model>
  private readonly gears = new Map<string, Model>() // loaded gear models by uri, in the scene (hidden unless drawn)
  private readonly gearAsked = new Set<string>()
  private halfSpanM: number | null = null
  private damaged = false
  private gearDown = false

  /** Prefer ChaseModel.load. Adds the model to the scene hidden: it appears on the first update(), not at the Earth's centre. */
  constructor(viewer: Viewer, m: ModelManifestEntry, model: Model, loader = loadChaseModel, gearLoader = loadGearModel) {
    this.viewer = viewer
    this.loader = loader
    this.gearLoader = gearLoader
    this.m = m
    this.model = model
    model.show = false
    viewer.scene.primitives.add(model)
    this.ready.set(m.id, model)
    this.asked.add(m.id)
  }

  static async load(viewer: Viewer, m: ModelManifestEntry): Promise<ChaseModel> {
    return new ChaseModel(viewer, m, await loadChaseModel(m))
  }

  /** The manifest entry drawn now. */
  get entry(): ModelManifestEntry {
    return this.m
  }

  /**
   * Draws the chased aircraft on entry's model (ModelPicker). Loads it on first use and keeps the current model until
   * it is ready. True when the drawn model changed this call (the Sun re-attaches its light to the new one).
   */
  use(entry: ModelManifestEntry): boolean {
    if (entry === this.m) return false
    if (!this.asked.has(entry.id)) {
      this.asked.add(entry.id)
      this.loader(entry).then(
        (model) => {
          model.show = false
          this.viewer.scene.primitives.add(model)
          this.ready.set(entry.id, model)
        },
        (err: unknown) => console.warn(`FlightHopper: chase model ${entry.id} not loaded; keeping ${this.m.id}:`, err),
      )
    }
    const next = this.ready.get(entry.id)
    if (next === undefined) return false
    this.model.show = false
    this.hideGears()
    this.model = next
    this.m = entry
    this.livery = undefined
    this.model.show = this.visible && this.placed
    this.look()
    if (this.gearDown) this.askGear()
    return true
  }

  /** Paints the model in a livery (livery.ts liveryCode; null: plain white). Cheap when unchanged. */
  paint(code: string | null): void {
    if (!this.m.paint || code === this.livery) return
    this.livery = code
    this.shade(this.shaders(this.m.paint).for(code))
  }

  /** Paints the model in a livery that is not in the table (a scenario's: liveryFromSpec) until the next paint(code). */
  paintLivery(livery: Livery): void {
    if (!this.m.paint) return
    this.livery = undefined
    this.shade(this.shaders(this.m.paint).custom(livery))
  }

  /** Folds the wing tips in to halfSpanM (real metres; null: the model's own span). Only where the paint map has wingTipY. */
  setShape(halfSpanM: number | null): void {
    if (halfSpanM === this.halfSpanM) return
    this.halfSpanM = halfSpanM
    this.look()
  }

  /** Shows the paint map's cut (the lost fin and tail cone) and the model's inside through it. Cheap when unchanged. */
  setDamage(on: boolean): void {
    if (on === this.damaged) return
    this.damaged = on
    this.look()
  }

  /** Draws the entry's separate landing gear (manifest gear), loaded on first use. Cheap when unchanged. */
  setGear(on: boolean): void {
    if (on === this.gearDown) return
    this.gearDown = on
    if (on) this.askGear()
    else this.hideGears()
  }

  /**
   * Rewrites modelMatrix in place. Model.update compares it with its cached copy on the next frame. With the gear
   * drawn, the wheels are gear.heightM below the origin, and the gear takes the same matrix and image-based light.
   */
  update(state: RenderState): void {
    const gear = this.drawnGear()
    modelMatrixFor(state, this.m, this.model.modelMatrix, gear === null ? this.m.gearHeightM : gear.heightM)
    this.placed = true
    this.model.show = this.visible
    if (gear === null) return
    Matrix4.clone(this.model.modelMatrix, gear.model.modelMatrix)
    gear.model.imageBasedLighting.imageBasedLightingFactor = this.model.imageBasedLighting.imageBasedLightingFactor // the setter copies it
    gear.model.show = this.visible
  }

  get show(): boolean {
    return this.visible
  }

  set show(v: boolean) {
    this.visible = v
    this.model.show = v && this.placed
    if (!v) this.hideGears() // shown again by the next update(), with its matrix
  }

  /** Removes every loaded model and gear from the scene. PrimitiveCollection destroys what it removes by default. */
  destroy(): void {
    for (const model of [...this.ready.values(), ...this.gears.values()]) this.viewer.scene.primitives.remove(model)
    this.ready.clear()
    this.gears.clear()
  }

  private shaders(paint: NonNullable<ModelManifestEntry['paint']>): LiveryShaders {
    let l = this.liveries.get(this.m.id)
    if (l === undefined) this.liveries.set(this.m.id, (l = new LiveryShaders(paint)))
    return l
  }

  private shade(s: CustomShader): void {
    if (this.model.customShader === s) return
    this.model.customShader = s
    this.look()
  }

  /**
   * Writes the shape and the damage onto the drawn model: its shader's u_span (mesh metres) and u_cut, and back faces
   * drawn only while damaged. Shaders are cached and shared by the models of one entry, so every switch rewrites them.
   */
  private look(): void {
    this.model.backFaceCulling = !this.damaged
    const s = this.model.customShader
    if (s === undefined) return
    s.setUniform('u_span', this.halfSpanM === null ? 0 : this.halfSpanM / this.m.scale)
    s.setUniform('u_cut', this.damaged ? 1 : 0)
  }

  /** The gear drawn now: down, the entry has one, and it has loaded. */
  private drawnGear(): { model: Model; heightM: number } | null {
    const g = this.m.gear
    if (!this.gearDown || g === undefined) return null
    const model = this.gears.get(g.uri)
    return model === undefined ? null : { model, heightM: g.heightM }
  }

  private askGear(): void {
    const g = this.m.gear
    if (g === undefined || this.gearAsked.has(g.uri)) return
    this.gearAsked.add(g.uri)
    this.gearLoader(g.uri).then(
      (model) => {
        model.show = false
        Matrix4.clone(this.model.modelMatrix, model.modelMatrix) // hidden, it still renders its first sky map: here, not at the Earth's centre
        this.viewer.scene.primitives.add(model)
        this.gears.set(g.uri, model)
      },
      (err: unknown) => console.warn(`FlightHopper: landing gear ${g.uri} not loaded; flying without it:`, err),
    )
  }

  private hideGears(): void {
    for (const g of this.gears.values()) g.show = false
  }
}

/**
 * One chase model. Model clones its own identity modelMatrix, which update() then rewrites. The scale is in
 * modelMatrixFor, so Model.scale stays 1. minimumPixelSize keeps a distant model visible. Cesium exaggerates models with
 * the terrain by default (squashed towards verticalExaggerationRelativeHeight, flat at factor 0); the aircraft keeps
 * its true height while the topography toggle flattens or grows the ground.
 */
export function loadChaseModel(m: ModelManifestEntry): Promise<Model> {
  return Model.fromGltfAsync({ url: modelUrl(m), minimumPixelSize: 32, show: false, enableVerticalExaggeration: false })
}

/**
 * Every Model renders its own sky map (DynamicEnvironmentMapManager), hidden or not, again after this much movement.
 * The gear follows the aircraft, so Cesium's 1 km would re-render the sky every few seconds (several times a second at
 * fast playback); 20 km is the aircraft's own (sun.ts ENV_MAP_EPSILON_M), so both are lit by the same sky.
 */
const GEAR_ENV_MAP_EPSILON_M = 20_000

/**
 * A landing gear (manifest gear.uri, relative to public/): drawn with the chase model's matrix, true height like it.
 * ponytail: no minimumPixelSize, since Cesium would enlarge the gear about its own bounding sphere, not the aircraft's.
 * Below 32 px the aircraft grows and the gear does not (a few pixels off). Upgrade: copy the aircraft's scale when that shows.
 */
export function loadGearModel(uri: string): Promise<Model> {
  return Model.fromGltfAsync({
    url: `${import.meta.env?.BASE_URL ?? '/'}${uri}`, show: false, enableVerticalExaggeration: false,
    environmentMapOptions: { maximumPositionEpsilon: GEAR_ENV_MAP_EPSILON_M },
  })
}

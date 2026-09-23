// client/scene/traffic.ts
// Chase traffic (.planning/chase-traffic-design.md): the other aircraft within RANGE_NM of the chased one as 3-D models
// (the one GLB, sized by ADS-B emitter category), each framed on screen by two corner brackets whose square is also
// its click target.
import { Cartesian2, Cartesian3, HeadingPitchRoll, Math as CesiumMath, Matrix4, Model, SceneTransforms, Transforms } from 'cesium'
import type { PerspectiveFrustum, Viewer } from 'cesium'
import { distanceNm } from '../../shared/geo.ts'
import { targetAttitude } from '../track/attitude.ts'
import type { FleetEntry, ModelManifestEntry } from '../types.ts'
import { LiveryShaders, liveryCode } from './livery.ts'
import type { ModelPicker } from './modelFor.ts'
import { modelUrl } from './model.ts'

export const RANGE_NM = 10
export const MAX_MODELS = 30
export const MIN_PX = 24 // a far model is enlarged to keep this size on screen (minScale), and so is its square
// The bracket square, in the GLB's model frame (Cesium's: nose +X, up +Z; unscaled): the bounding-box centre, and half
// the side, half the larger of wingspan and length plus 8 %. A manifest entry's `box`; these are Cesium_Air.glb's (span
// 25.7, length 21.4), for an entry without one. traffic.test checks every model's against its GLB.
export const BOX_CENTRE = new Cartesian3(-2.7, 0, 1.58)
export const BOX_HALF = 13.9
const KT = 1852 / 3600
const FPM = 0.3048 / 60
const SLOW_KT = 40 // slower than this a vertical rate says little about pitch (a helicopter, a hover): level
/** Length factor per ADS-B emitter category on a generic model (one without `types`); a typed model is true size. */
const SCALE: Record<string, number> = { A1: 0.35, A2: 0.6, A3: 1, A4: 1.2, A5: 1.8, A7: 0.4 }

export const scaleFor = (category: string | null | undefined): number => (category ? SCALE[category] : undefined) ?? 1

export interface Near { e: FleetEntry; nm: number }

/**
 * The entries within rangeNm of (lat, lon), except skipHex and stale ones: airborne first, then nearest first. At a hub
 * the nearest dozens are parked; ranked by distance alone they would take every model from the traffic in the air.
 */
export function nearestInRange(entries: readonly FleetEntry[], skipHex: string | null, lat: number, lon: number, rangeNm: number): Near[] {
  const dLat = rangeNm / 60 // a nautical mile is a minute of latitude: a cheap reject before the great-circle distance
  const out: Near[] = []
  for (const e of entries) {
    if (e.hex === skipHex || e.ageS > e.staleS || Math.abs(e.lat - lat) > dLat) continue
    const nm = distanceNm(lat, lon, e.lat, e.lon)
    if (nm <= rangeNm) out.push({ e, nm })
  }
  return out.sort((a, b) => (a.e.onGround === b.e.onGround ? a.nm - b.nm : a.e.onGround ? 1 : -1))
}

/**
 * The factor that enlarges a model of radius rM at depthM along the view to MIN_PX on screen (1 when it is already
 * that big). The app's own minimumPixelSize: Cesium's multiplies the scale in the model matrix, so its size is not
 * the one the brackets are drawn from.
 */
export function minScale(rM: number, depthM: number, fovyRad: number, viewHeightPx: number): number {
  const px = (rM * viewHeightPx) / (depthM * Math.tan(fovyRad / 2))
  return px >= MIN_PX ? 1 : MIN_PX / px
}

/** Side of the on-screen square around a sphere of radius rM at depthM along the view, in CSS px: its projected diameter, ≥ MIN_PX, ≤ 4 screens. */
export function squarePx(rM: number, depthM: number, fovyRad: number, viewHeightPx: number): number {
  const px = (rM * viewHeightPx) / (depthM * Math.tan(fovyRad / 2))
  return Math.min(Math.max(px, MIN_PX), 4 * viewHeightPx)
}

/** A bracket square: centre (CSS px from the canvas's top-left), side, and depth along the view (m). */
export interface Box { hex: string; x: number; y: number; side: number; depthM: number }

/** The hex whose square (of the first n boxes) holds (x, y); the nearest to the camera when squares overlap; else null. */
export function hitAt(boxes: readonly Box[], n: number, x: number, y: number): string | null {
  let best: Box | null = null
  for (let i = 0; i < n; i++) {
    const b = boxes[i]
    const h = b.side / 2
    if (Math.abs(x - b.x) <= h && Math.abs(y - b.y) <= h && (best === null || b.depthM < best.depthM)) best = b
  }
  return best === null ? null : best.hex
}

/**
 * Cesium HeadingPitchRoll of a traffic aircraft on model m: the nose along its track (headingDeg when it has none),
 * pitch from its climb (targetAttitude: flight-path angle + AoA), wings level (the fleet keeps only the newest sample,
 * so no turn rate). ponytail: roll 0; upgrade: the track change between samples, as the chased Track does.
 */
export function trafficHpr(e: FleetEntry, m: ModelManifestEntry, headingDeg: number, out: HeadingPitchRoll): HeadingPitchRoll {
  const gs = e.gsKt ?? 0
  const att = targetAttitude({
    gsMs: gs * KT, vsMs: gs >= SLOW_KT ? (e.vsFpm ?? 0) * FPM : 0, headingDeg: e.trackDeg ?? headingDeg,
    broadcastRollDeg: 0, turnRateDegS: 0, onGround: e.onGround, phase: null, mlat: false,
  })
  const fix = m.forwardAxisFix
  out.heading = CesiumMath.toRadians(att.headingDeg + fix.headingDeg)
  out.pitch = CesiumMath.toRadians(att.pitchDeg + fix.pitchDeg)
  out.roll = CesiumMath.toRadians(fix.rollDeg)
  return out
}

const lift = new Cartesian3()

/** World matrix of a traffic model: wheels at pos (the origin k × gearHeightM above, along body up), attitude hpr, k × m.scale. */
export function trafficMatrix(pos: Cartesian3, hpr: HeadingPitchRoll, m: ModelManifestEntry, k: number, out: Matrix4): Matrix4 {
  Transforms.headingPitchRollToFixedFrame(pos, hpr, undefined, undefined, out)
  Matrix4.multiplyByTranslation(out, Cartesian3.fromElements(0, 0, m.gearHeightM * k, lift), out)
  return Matrix4.multiplyByUniformScale(out, m.scale * k, out)
}

/**
 * One traffic model: no dynamic environment map (one per model would render the sky once per model), true height as
 * ChaseModel, and no minimumPixelSize (Traffic enlarges a far model itself: minScale).
 */
export function loadTrafficModel(m: ModelManifestEntry): Promise<Model> {
  return Model.fromGltfAsync({
    url: modelUrl(m), show: false, enableVerticalExaggeration: false, environmentMapOptions: { enabled: false },
  })
}

interface Slot { m: ModelManifestEntry; model: Model; hex: string | null; e: FleetEntry | null; headingDeg: number; livery?: string | null }

/**
 * The chase traffic, each aircraft on its type's model (ModelPicker). Models come from a pool per GLB that grows to the
 * most ever needed of it (≤ MAX_MODELS drawn in all), and Cesium shares one GLB's geometry between its models. A model
 * loads async; an aircraft shows nothing until a ready model of its type is free (chase shows no flat icons), and nor
 * does one over MAX_MODELS. A GLB that fails to load leaves its aircraft undrawn.
 * ponytail: pools never shrink, so a session of many types keeps up to MAX_MODELS per type loaded. Upgrade: evict idle.
 * ponytail: brackets do not hide behind terrain or buildings, only behind the camera. Upgrade: a depth test under the
 * square's centre. No hysteresis at the range edge. Upgrade: leave at 10.5 nm.
 */
export class Traffic {
  readonly #viewer: Viewer
  readonly #pick: ModelPicker
  readonly #layer: HTMLElement
  readonly #load: (m: ModelManifestEntry) => Promise<Model>
  readonly #paint = new Map<string, LiveryShaders>()
  readonly #wantOf = new Map<ModelManifestEntry, number>()
  readonly #loading = new Map<string, number>()
  readonly #failed = new Set<string>()
  readonly #slots: Slot[] = []
  readonly #byHex = new Map<string, Slot>()
  readonly #models = new Set<string>()
  readonly #want = new Map<string, ModelManifestEntry>()
  readonly #boxes: Box[] = []
  readonly #els: HTMLDivElement[] = []
  readonly #hpr = new HeadingPitchRoll()
  readonly #c = new Cartesian3()
  readonly #v = new Cartesian3()
  readonly #w = new Cartesian2()
  readonly #bc = new Cartesian3()
  #nBoxes = 0
  #destroyed = false

  constructor(viewer: Viewer, pick: ModelPicker, layer: HTMLElement, load = loadTrafficModel) {
    this.#viewer = viewer
    this.#pick = pick
    this.#layer = layer
    this.#load = load
  }

  /**
   * This frame's traffic around the chased aircraft at `at`, for FleetLayer.update: the hexes drawn as models, the first
   * MAX_MODELS of nearestInRange's order that have a ready model. null at (not chasing, or no position yet): an empty
   * set, and every model and bracket hides.
   */
  select(entries: readonly FleetEntry[], chasedHex: string | null, at: { lat: number; lon: number } | null): ReadonlySet<string> {
    this.#models.clear()
    this.#want.clear()
    const near = at === null ? [] : nearestInRange(entries, chasedHex, at.lat, at.lon, RANGE_NM)
    this.#wantOf.clear()
    for (let i = 0; i < near.length && i < MAX_MODELS; i++) {
      const e = near[i].e
      const m = this.#pick.for(e.info?.typeCode ?? null, e.info?.category ?? null)
      this.#want.set(e.hex, m)
      this.#wantOf.set(m, (this.#wantOf.get(m) ?? 0) + 1)
    }
    // Gone from range, or its type became known after it was drawn on another model: the slot goes back to its pool.
    for (const s of this.#slots) if (s.hex !== null && this.#want.get(s.hex) !== s.m) this.#free(s)
    for (const [m, n] of this.#wantOf) this.#grow(m, n)
    for (let i = 0; i < near.length && i < MAX_MODELS; i++) {
      const e = near[i].e
      let s = this.#byHex.get(e.hex)
      if (s === undefined) {
        s = this.#slots.find((x) => x.hex === null && x.m === this.#want.get(e.hex) && x.model.ready)
        if (s === undefined) continue // none free and ready yet: not drawn this frame
        s.hex = e.hex
        s.headingDeg = e.trackDeg ?? 0
        this.#byHex.set(e.hex, s)
      }
      s.e = e
      this.#models.add(e.hex)
    }
    if (at === null) this.#hideBoxes(0)
    return this.#models
  }

  /**
   * After the camera moved this frame: each selected model goes where FleetLayer placed its aircraft, and its brackets
   * around it. ibl: the chased model's image-based light (the Sun dims it at night), copied so the traffic dims too.
   */
  update(placed: { positionOf(hex: string): Cartesian3 | undefined }, ibl?: Cartesian2): void {
    const scene = this.#viewer.scene
    const cam = scene.camera
    const fovy = (cam.frustum as PerspectiveFrustum).fovy ?? CesiumMath.PI_OVER_THREE // undefined before the first render
    const hPx = scene.canvas.clientHeight
    let n = 0
    for (const s of this.#slots) {
      if (s.hex === null || s.e === null) continue
      const pos = placed.positionOf(s.hex)
      if (pos === undefined) {
        s.model.show = false
        continue
      }
      const e = s.e
      if (e.trackDeg !== null) s.headingDeg = e.trackDeg
      const m = s.m
      const livery = liveryCode(e.info?.callsign ?? null) // the callsign can arrive after the aircraft does
      if (m.paint && s.livery !== livery) {
        s.livery = livery
        s.model.customShader = this.#shaders(m).for(livery)
      }
      // The square's radius at true size; a far model and its square are enlarged together to MIN_PX (depth taken at
      // the wheels: the centre is a few metres off).
      const k = m.types ? 1 : scaleFor(e.info?.category)
      const rM = (m.box?.half ?? BOX_HALF) * m.scale * k
      const depth0 = Cartesian3.dot(Cartesian3.subtract(pos, cam.positionWC, this.#v), cam.directionWC)
      const g = depth0 > 1 ? minScale(rM, depth0, fovy, hPx) : 1
      const mm = trafficMatrix(pos, trafficHpr(e, m, s.headingDeg, this.#hpr), m, k * g, s.model.modelMatrix)
      if (ibl) s.model.imageBasedLighting.imageBasedLightingFactor = ibl // the setter copies it
      s.model.show = true
      const bc = m.box ? Cartesian3.fromArray(m.box.centre, 0, this.#bc) : BOX_CENTRE
      const c = Matrix4.multiplyByPoint(mm, bc, this.#c)
      const depthM = Cartesian3.dot(Cartesian3.subtract(c, cam.positionWC, this.#v), cam.directionWC)
      if (!(depthM > 1)) continue // behind the camera
      const w = SceneTransforms.worldToWindowCoordinates(scene, c, this.#w)
      if (w === undefined) continue
      const b = this.#boxes[n] ?? (this.#boxes[n] = { hex: '', x: 0, y: 0, side: 0, depthM: 0 })
      b.hex = s.hex
      b.x = w.x
      b.y = w.y
      b.side = squarePx(rM * g, depthM, fovy, hPx)
      b.depthM = depthM
      this.#place(n++, b)
    }
    this.#hideBoxes(n)
  }

  /** The traffic aircraft whose bracket square holds (x, y) (canvas CSS px), nearest first; null when none. */
  hitAt(x: number, y: number): string | null {
    return hitAt(this.#boxes, this.#nBoxes, x, y)
  }

  destroy(): void {
    this.#destroyed = true
    for (const s of this.#slots) this.#viewer.scene.primitives.remove(s.model)
    this.#slots.length = 0
    this.#byHex.clear()
    for (const el of this.#els) el.remove()
    this.#els.length = 0
    this.#nBoxes = 0
  }

  #free(s: Slot): void {
    s.model.show = false
    if (s.hex !== null) this.#byHex.delete(s.hex)
    s.hex = null
    s.e = null
  }

  #shaders(m: ModelManifestEntry): LiveryShaders {
    let p = this.#paint.get(m.id)
    if (p === undefined) this.#paint.set(m.id, (p = new LiveryShaders(m.paint!)))
    return p
  }

  /** Loads models of m until its pool (ready + loading) holds want. */
  #grow(m: ModelManifestEntry, want: number): void {
    let have = (this.#loading.get(m.id) ?? 0) + this.#slots.filter((s) => s.m === m).length
    for (; have < want && !this.#failed.has(m.id) && !this.#destroyed; have++) {
      this.#loading.set(m.id, (this.#loading.get(m.id) ?? 0) + 1)
      this.#load(m).then(
        (model) => {
          this.#loading.set(m.id, this.#loading.get(m.id)! - 1)
          if (this.#destroyed) return void model.destroy()
          model.show = false
          this.#viewer.scene.primitives.add(model)
          this.#slots.push({ m, model, hex: null, e: null, headingDeg: 0 })
        },
        (err: unknown) => {
          this.#loading.set(m.id, this.#loading.get(m.id)! - 1)
          if (!this.#failed.has(m.id)) console.warn(`FlightHopper: traffic model ${m.id} not loaded; its aircraft are not drawn:`, err)
          this.#failed.add(m.id)
        },
      )
    }
  }

  #place(i: number, b: Box): void {
    let el = this.#els[i]
    if (el === undefined) {
      el = this.#els[i] = document.createElement('div')
      el.className = 'fh-bracket'
      this.#layer.append(el)
    }
    const side = Math.round(b.side)
    el.style.width = el.style.height = `${side}px`
    el.style.transform = `translate(${(b.x - side / 2).toFixed(1)}px, ${(b.y - side / 2).toFixed(1)}px)`
    el.hidden = false
  }

  #hideBoxes(n: number): void {
    for (let i = n; i < this.#nBoxes; i++) this.#els[i].hidden = true
    this.#nBoxes = n
  }
}

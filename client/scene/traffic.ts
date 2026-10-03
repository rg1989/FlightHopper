// client/scene/traffic.ts
// Chase traffic (.planning/chase-traffic-design.md): the other aircraft round the chased one (within RANGE_NM, farther
// as the camera zooms out: trafficRangeNm) as 3-D models (the one GLB, sized by ADS-B emitter category), each framed on
// screen by two corner brackets whose square is also its click target.
import { Cartesian2, Cartesian3, Cartographic, HeadingPitchRoll, Math as CesiumMath, Matrix3, Matrix4, Model, SceneTransforms, Transforms } from 'cesium'
import type { ModelNode, PerspectiveFrustum, Viewer } from 'cesium'
import { distanceNm } from '../../shared/geo.ts'
import { aeroPitchRoll } from '../track/attitude.ts'
import type { FleetEntry, ModelManifestEntry } from '../types.ts'
import { formatDistanceM } from '../ui/format.ts'
import { LiveryShaders, liveryCode } from './livery.ts'
import type { ModelPicker } from './modelFor.ts'
import { GearMotion, gearWanted, swingLegs } from './gear.ts'
import { fixMatrix, hprFor, loadGearModel, modelUrl } from './model.ts'

export const RANGE_NM = 10 // while the camera is within NEAR_CAMERA_M of the chased aircraft
const FAR_RANGE_NM = 60
const NEAR_CAMERA_M = 5000
export const MAX_MODELS = 30
export const MIN_PX = 24 // a far model is enlarged to keep this size on screen (minScale), and so is its square
// The bracket square, in the GLB's model frame (Cesium's: nose +X, up +Z; unscaled): the bounding-box centre, and half
// the side, half the larger of wingspan and length plus 8 %. A manifest entry's `box`; these are Cesium_Air.glb's (span
// 25.7, length 21.4), for an entry without one. traffic.test checks every model's against its GLB.
export const BOX_CENTRE = new Cartesian3(-2.7, 0, 1.58)
export const BOX_HALF = 13.9
const KT = 1852 / 3600
const FPM = 0.3048 / 60
const SLOW_KT = 40 // slower than this no wing flies (a helicopter's hover, a glitch): level
/** Length factor per ADS-B emitter category on a generic model (one without `types`); a typed model is true size. */
const SCALE: Record<string, number> = { A1: 0.35, A2: 0.6, A3: 1, A4: 1.2, A5: 1.8, A7: 0.4 }

export const scaleFor = (category: string | null | undefined): number => (category ? SCALE[category] : undefined) ?? 1

/** The flight ID above a traffic model's brackets: its callsign, else its ICAO hex (as FleetLayer's label). */
export const flightId = (e: FleetEntry): string => e.info?.callsign ?? e.hex.toUpperCase()

/**
 * The traffic's radius round the chased aircraft with the chase camera camRangeM from it: RANGE_NM near, then in
 * proportion to the camera's range (the view widens with it), FAR_RANGE_NM at most.
 * ponytail: a circle sized by the range, not what the view holds: FAR_RANGE_NM is reached 30 km out, a view along the
 * ground sees past it, and MAX_MODELS of it are drawn. Upgrade: the aircraft in the view's frustum, the far ones instanced.
 */
export const trafficRangeNm = (camRangeM: number): number => Math.min(FAR_RANGE_NM, RANGE_NM * Math.max(1, camRangeM / NEAR_CAMERA_M))

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
 * that big, and for a view of no height). The app's own minimumPixelSize: Cesium's multiplies the scale in the model
 * matrix, so its size is not the one the brackets are drawn from.
 */
export function minScale(rM: number, depthM: number, fovyRad: number, viewHeightPx: number): number {
  const px = (rM * viewHeightPx) / (depthM * Math.tan(fovyRad / 2))
  return px > 0 && px < MIN_PX ? MIN_PX / px : 1
}

/** Side of the on-screen square around a sphere of radius rM at depthM along the view, in CSS px: its projected diameter, ≥ MIN_PX, ≤ 4 screens. */
export function squarePx(rM: number, depthM: number, fovyRad: number, viewHeightPx: number): number {
  const px = (rM * viewHeightPx) / (depthM * Math.tan(fovyRad / 2))
  return Math.min(Math.max(px, MIN_PX), 4 * viewHeightPx)
}

/**
 * A bracket square: centre (CSS px from the canvas's top-left), side, depth along the view (m), the flight ID above it
 * and the distance from the chased aircraft (m) under it.
 */
export interface Box { hex: string; x: number; y: number; side: number; depthM: number; label: string; distM: number }

/** A screen rectangle, canvas CSS px from its top-left. */
export interface Rect { x: number; y: number; w: number; h: number }

/**
 * Whether a traffic model is hidden: the scene's depth under its square's centre (hitDistM from the camera; undefined:
 * sky) lies nearer than the model's near side (centreDistM − rM). A hit on the model itself or behind it is not.
 */
export const isOccluded = (hitDistM: number | undefined, centreDistM: number, rM: number): boolean =>
  hitDistM !== undefined && hitDistM < centreDistM - rM

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

// The two label lines of a square (layout.css): the ID 5 px above it, the distance 5 px under it.
const LINE_GAP_PX = 5
const ID_H_PX = 12
const DIST_H_PX = 11
const ID_CHAR_PX = 9 // bold 11 px capitals with 0.08em spacing (phones' 12 px run a little wider)
const DIST_CHAR_PX = 7 // 10 px digits
const KEEP_OFF_PX = 6 // round the chased aircraft's flight ID: another label beside it does not run into it

/** The label lines of square b as [centre x, centre y, width, height] × 2 (ID, then distance), written into out. */
function labelLines(b: Box, distChars: number, out: number[]): number[] {
  out[0] = out[4] = b.x
  out[1] = b.y - b.side / 2 - LINE_GAP_PX - ID_H_PX / 2
  out[2] = b.label.length * ID_CHAR_PX
  out[3] = ID_H_PX
  out[5] = b.y + b.side / 2 + LINE_GAP_PX + DIST_H_PX / 2
  out[6] = distChars * DIST_CHAR_PX
  out[7] = DIST_H_PX
  return out
}

const la: number[] = []
const lb: number[] = []

/** Whether any line of one square's labels (a) touches any line of another's (b). */
function linesClash(a: number[], b: number[]): boolean {
  for (let i = 0; i < 8; i += 4) {
    for (let j = 0; j < 8; j += 4) {
      if (Math.abs(a[i] - b[j]) < (a[i + 2] + b[j + 2]) / 2 && Math.abs(a[i + 1] - b[j + 1]) < (a[i + 3] + b[j + 3]) / 2) return true
    }
  }
  return false
}

/**
 * Which labels show (out[i] for the first n boxes; a square's ID and distance show or hide together): nearest first,
 * and a square whose label lines would touch lines already shown loses them, so a distant airport's crowd reads as
 * brackets with a few labels instead of a smear of text. Brackets all stay. firstHex (the aircraft whose card is open)
 * goes before the nearest: its labels always show. keepOff (the chased aircraft's flight ID, FlightFrame.idRect): no
 * other label goes over it.
 * ponytail: widths estimated from the character count; upgrade: measure each label text once.
 */
export function shownLabels(
  boxes: readonly Box[], n: number, out: boolean[], firstHex: string | null = null, keepOff: Rect | null = null,
): boolean[] {
  out.length = n
  const rank = (i: number): number => (boxes[i].hex === firstHex ? -Infinity : boxes[i].depthM)
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => rank(a) - rank(b))
  const distChars = boxes.slice(0, n).map((b) => formatDistanceM(b.distM).length)
  const c = keepOff === null ? null
    : [keepOff.x + keepOff.w / 2, keepOff.y + keepOff.h / 2, keepOff.w + 2 * KEEP_OFF_PX, keepOff.h + 2 * KEEP_OFF_PX]
  const off = c === null ? null : [...c, ...c] // as a square's two lines (linesClash compares two a side)
  for (let k = 0; k < n; k++) {
    const i = order[k]
    labelLines(boxes[i], distChars[i], la)
    let clear = off === null || boxes[i].hex === firstHex || !linesClash(la, off)
    for (let q = 0; q < k && clear; q++) {
      const j = order[q]
      if (out[j]) clear = !linesClash(la, labelLines(boxes[j], distChars[j], lb))
    }
    out[i] = clear
  }
  return out
}

/**
 * Cesium HeadingPitchRoll of a traffic aircraft (trafficMatrix turns model m to it): its Track's attitude when it has one
 * (e.att); else from its newest sample: the nose along its track (headingDeg when it has none), pitch from flight
 * mechanics (aeroPitchRoll: path angle + angle of attack), wings level (one sample has no turn rate).
 */
export function trafficHpr(e: FleetEntry, headingDeg: number, out: HeadingPitchRoll): HeadingPitchRoll {
  if (e.att) return hprFor(e.att, out)
  const gs = e.gsKt ?? 0
  // Slower than any wing flies (a hover, a glitch): level.
  const pr = gs < SLOW_KT ? { pitchDeg: 0, rollDeg: 0 } : aeroPitchRoll({
    gsMs: gs * KT, vsMs: (e.vsFpm ?? 0) * FPM, turnRateDegS: 0, alongMs2: 0, easKt: null,
    altM: e.hM, onGround: e.onGround, category: e.info?.category ?? null,
  })
  return hprFor({ headingDeg: e.trackDeg ?? headingDeg, ...pr }, out)
}

const lift = new Cartesian3()
const fix = new Matrix3()

/** World matrix of a traffic model: wheels at pos (the origin k × gearHeightM above, along body up), attitude hpr, k × m.scale. */
export function trafficMatrix(pos: Cartesian3, hpr: HeadingPitchRoll, m: ModelManifestEntry, k: number, out: Matrix4): Matrix4 {
  Transforms.headingPitchRollToFixedFrame(pos, hpr, undefined, undefined, out)
  Matrix4.multiplyByTranslation(out, Cartesian3.fromElements(0, 0, m.gearHeightM * k, lift), out)
  Matrix4.multiplyByMatrix3(out, fixMatrix(m, fix), out)
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

interface Slot {
  m: ModelManifestEntry
  model: Model
  hex: string | null
  e: FleetEntry | null
  headingDeg: number
  livery?: string | null
  // its landing gear (manifest gear): the model, where it is, the last decision (null: a first look), when the height
  // above the ground was last read and what it was, and the leg nodes swung to legsAt
  gear: Model | null
  motion: GearMotion
  want: boolean | null
  aglS: number
  aglFt: number | null
  nodes?: Array<ModelNode | undefined>
  legsAt: number
  occluded: boolean // its model hidden (isOccluded): no brackets
}

export interface TrafficOpts {
  load?: (m: ModelManifestEntry) => Promise<Model>
  loadGear?: (uri: string) => Promise<Model>
  openLayer?: HTMLElement // where the open aircraft's brackets go (layout.css: over the flight-data frame); else layer
}

const PROBES_PER_FRAME = 2 // depth reads (each a GPU sync) per frame: every square is re-checked every n / 2 frames
const FT = 0.3048
const AGL_EVERY_S = 0.5 // a traffic aircraft's height above the drawn ground is read this often (globe.getHeight picks)

/**
 * The chase traffic, each aircraft on its type's model (ModelPicker). Models come from a pool per GLB that grows to the
 * most ever needed of it (≤ MAX_MODELS drawn in all), and Cesium shares one GLB's geometry between its models. A model
 * loads async; an aircraft shows nothing until a ready model of its type is free (chase shows no flat icons), and nor
 * does one over MAX_MODELS. A GLB that fails to load leaves its aircraft undrawn.
 * Brackets hide while the model is hidden (isOccluded: buildings, terrain, the chased aircraft), and behind the camera;
 * over each the flight ID, under it the distance from the chased aircraft (shownLabels keeps a crowd readable). A click
 * in a square opens that aircraft (open, one at most): app.ts shows its card, and its brackets are highlighted, its
 * labels always shown, until close() or it leaves the traffic.
 * ponytail: pools never shrink, so a session of many types keeps up to MAX_MODELS per type loaded. Upgrade: evict idle.
 * ponytail: no hysteresis at the range edge. Upgrade: leave 5 % farther out than it enters.
 */
export class Traffic {
  readonly #viewer: Viewer
  readonly #pick: ModelPicker
  readonly #layer: HTMLElement
  readonly #openLayer: HTMLElement
  readonly #load: (m: ModelManifestEntry) => Promise<Model>
  readonly #loadGear: (uri: string) => Promise<Model>
  readonly #carto = new Cartographic()
  readonly #paint = new Map<string, LiveryShaders>()
  readonly #wantOf = new Map<ModelManifestEntry, number>()
  readonly #loading = new Map<string, number>()
  readonly #failed = new Set<string>()
  readonly #slots: Slot[] = []
  readonly #byHex = new Map<string, Slot>()
  readonly #models = new Set<string>()
  readonly #want = new Map<string, ModelManifestEntry>()
  readonly #boxes: Box[] = []
  readonly #boxSlot: Slot[] = [] // the slot of boxes[i]
  readonly #camDist: number[] = [] // camera → square centre (m), for the depth probe
  readonly #radius: number[] = [] // the square's radius (m) as drawn
  readonly #els: HTMLDivElement[] = []
  readonly #labelShown: boolean[] = []
  readonly #hpr = new HeadingPitchRoll()
  readonly #c = new Cartesian3()
  readonly #v = new Cartesian3()
  readonly #w = new Cartesian2()
  readonly #bc = new Cartesian3()
  readonly #p = new Cartesian3()
  #nBoxes = 0
  #probe = 0
  #destroyed = false
  #openHex: string | null = null
  #openDistM: number | null = null
  /** The chased aircraft's flight ID (canvas px; FlightFrame.idRect): no traffic label goes over it. */
  keepOff: Rect | null = null

  constructor(viewer: Viewer, pick: ModelPicker, layer: HTMLElement, opts: TrafficOpts = {}) {
    this.#viewer = viewer
    this.#pick = pick
    this.#layer = layer
    this.#openLayer = opts.openLayer ?? layer
    this.#load = opts.load ?? loadTrafficModel
    this.#loadGear = opts.loadGear ?? loadGearModel
  }

  /**
   * This frame's traffic within rangeNm of the chased aircraft at `at` (trafficRangeNm of the camera's range), for
   * FleetLayer.update: the hexes drawn as models, the first MAX_MODELS of nearestInRange's order that have a ready
   * model. null at (not chasing, or no position yet): an empty set, every model and bracket hide, and the open aircraft
   * closes.
   */
  select(entries: readonly FleetEntry[], chasedHex: string | null, at: { lat: number; lon: number } | null, rangeNm = RANGE_NM): ReadonlySet<string> {
    this.#models.clear()
    this.#want.clear()
    const near = at === null ? [] : nearestInRange(entries, chasedHex, at.lat, at.lon, rangeNm)
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
        s.motion.reset() // its gear as first seen, not swinging there
        s.want = null
        s.aglS = Infinity
        s.occluded = false
        this.#byHex.set(e.hex, s)
      }
      s.e = e
      this.#models.add(e.hex)
    }
    if (this.#openHex !== null && !this.#want.has(this.#openHex)) this.close() // it left the traffic
    if (at === null) this.#hideBoxes(0)
    return this.#models
  }

  /**
   * After the camera moved this frame: each selected model goes where FleetLayer placed its aircraft, and its brackets
   * around it. ibl: the chased model's image-based light (the Sun dims it at night), copied so the traffic dims too.
   * dtS: seconds since the last update (the gear moves). chasedWC: the chased aircraft, for the distances under the
   * brackets and the open aircraft's (openDistM).
   */
  update(placed: { positionOf(hex: string): Cartesian3 | undefined }, ibl?: Cartesian2, dtS = 0, chasedWC?: Cartesian3): void {
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
        if (s.gear !== null) s.gear.show = false
        continue
      }
      const e = s.e
      if (e.trackDeg !== null) s.headingDeg = e.trackDeg
      const m = s.m
      const livery = liveryCode(e.info?.callsign ?? null, e.info?.reg ?? null, e.info?.military) // the callsign can arrive after the aircraft does
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
      const mm = trafficMatrix(pos, trafficHpr(e, s.headingDeg, this.#hpr), m, k * g, s.model.modelMatrix)
      if (ibl) s.model.imageBasedLighting.imageBasedLightingFactor = ibl // the setter copies it
      s.model.show = true
      this.#gear(s, pos, mm, ibl, dtS)
      const bc = m.box ? Cartesian3.fromArray(m.box.centre, 0, this.#bc) : BOX_CENTRE
      const c = Matrix4.multiplyByPoint(mm, bc, this.#c)
      const toC = Cartesian3.subtract(c, cam.positionWC, this.#v)
      const depthM = Cartesian3.dot(toC, cam.directionWC)
      if (!(depthM > 1)) continue // behind the camera
      const w = SceneTransforms.worldToWindowCoordinates(scene, c, this.#w)
      if (w === undefined) continue
      const b = this.#boxes[n] ?? (this.#boxes[n] = { hex: '', x: 0, y: 0, side: 0, depthM: 0, label: '', distM: 0 })
      b.hex = s.hex
      b.label = flightId(e)
      b.x = w.x
      b.y = w.y
      b.side = squarePx(rM * g, depthM, fovy, hPx)
      b.depthM = depthM
      b.distM = chasedWC ? Cartesian3.distance(pos, chasedWC) : 0
      this.#boxSlot[n] = s
      this.#camDist[n] = Cartesian3.magnitude(toC)
      this.#radius[n] = rM * g
      n++
    }
    n = this.#dropOccluded(n)
    shownLabels(this.#boxes, n, this.#labelShown, this.#openHex, this.keepOff)
    for (let i = 0; i < n; i++) this.#place(i, this.#boxes[i], this.#labelShown[i])
    this.#hideBoxes(n)
    // Drawn or not (occluded, behind the camera, no model free yet), the open aircraft's card shows its distance.
    const at = this.#openHex === null ? undefined : placed.positionOf(this.#openHex)
    this.#openDistM = at === undefined || chasedWC === undefined ? null : Cartesian3.distance(at, chasedWC)
  }

  /** The traffic aircraft whose bracket square holds (x, y) (canvas CSS px), nearest first; null when none. */
  hitAt(x: number, y: number): string | null {
    return hitAt(this.#boxes, this.#nBoxes, x, y)
  }

  /** Opens this traffic aircraft (its card, its brackets highlighted), in place of another one: one at most. */
  open(hex: string): void {
    if (hex === this.#openHex) return
    this.#openHex = hex
    this.#openDistM = null // until the next update
  }

  /** Closes the open aircraft; true if one was open. */
  close(): boolean {
    if (this.#openHex === null) return false
    this.#openHex = null
    this.#openDistM = null
    return true
  }

  /** The open aircraft's hex; null when none. */
  get openHex(): string | null {
    return this.#openHex
  }

  /** The open aircraft's distance from the chased one (m) as of the last update; null while unknown. */
  get openDistM(): number | null {
    return this.#openDistM
  }

  /** Each model drawn this frame (after update): its hex, the matrix it is drawn with, its manifest entry and aircraft. */
  forEachDrawn(f: (hex: string, mm: Matrix4, m: ModelManifestEntry, e: FleetEntry) => void): void {
    for (const s of this.#slots) if (s.hex !== null && s.e !== null && s.model.show) f(s.hex, s.model.modelMatrix, s.m, s.e)
  }

  destroy(): void {
    this.#destroyed = true
    for (const s of this.#slots) {
      this.#viewer.scene.primitives.remove(s.model)
      if (s.gear !== null) this.#viewer.scene.primitives.remove(s.gear)
    }
    this.#slots.length = 0
    this.#byHex.clear()
    for (const el of this.#els) el.remove()
    this.#els.length = 0
    this.#nBoxes = 0
    this.#openHex = null
  }

  /**
   * Re-checks PROBES_PER_FRAME squares against the scene's depth (last frame's: Scene.pickPosition), in turn, then drops
   * the squares whose model is hidden. Returns the count left, compacted to the front.
   */
  #dropOccluded(n: number): number {
    const scene = this.#viewer.scene
    if (n > 0 && scene.pickPositionSupported) {
      const cam = scene.camera.positionWC
      for (let k = 0; k < PROBES_PER_FRAME && k < n; k++) {
        const i = (this.#probe + k) % n
        const b = this.#boxes[i]
        const hit = scene.pickPosition(Cartesian2.fromElements(b.x, b.y, this.#w), this.#p)
        this.#boxSlot[i].occluded = isOccluded(hit === undefined ? undefined : Cartesian3.distance(cam, hit), this.#camDist[i], this.#radius[i])
      }
      this.#probe = (this.#probe + PROBES_PER_FRAME) % n
    }
    let j = 0
    for (let i = 0; i < n; i++) {
      if (this.#boxSlot[i].occluded) continue
      if (i !== j) {
        const t = this.#boxes[j]
        this.#boxes[j] = this.#boxes[i]
        this.#boxes[i] = t
        this.#boxSlot[j] = this.#boxSlot[i]
      }
      j++
    }
    return j
  }

  /**
   * A slot's gear this frame: down or up as a crew would have it (gear.ts, from its state and its height over the drawn
   * ground, read every AGL_EVERY_S), moving at the hydraulics' pace, drawn with the aircraft's matrix unless fully up.
   */
  #gear(s: Slot, pos: Cartesian3, mm: Matrix4, ibl: Cartesian2 | undefined, dtS: number): void {
    const legs = s.m.gear?.legs
    if (s.gear === null || legs === undefined || s.e === null) return
    s.aglS += dtS
    if (s.aglS >= AGL_EVERY_S) {
      s.aglS = 0
      const c = Cartographic.fromCartesian(pos, undefined, this.#carto)
      const ground = c === undefined ? undefined : this.#viewer.scene.globe.getHeight(c)
      s.aglFt = c === undefined || ground === undefined ? null : (c.height - ground) / FT
    }
    const e = s.e
    s.want = gearWanted(s.want, { onGround: e.onGround, aglFt: s.aglFt, vsFpm: e.vsFpm, gsKt: e.gsKt })
    s.motion.step(s.want, dtS)
    if (s.motion.pos <= 0 || !s.gear.ready) {
      s.gear.show = false
      return
    }
    Matrix4.clone(mm, s.gear.modelMatrix)
    if (ibl) s.gear.imageBasedLighting.imageBasedLightingFactor = ibl
    s.gear.show = true
    if (s.motion.pos !== s.legsAt) {
      s.nodes = swingLegs(s.gear, legs, s.motion.pos, s.nodes)
      s.legsAt = s.motion.pos
    }
  }

  #free(s: Slot): void {
    s.model.show = false
    if (s.gear !== null) s.gear.show = false
    if (s.hex !== null) this.#byHex.delete(s.hex)
    s.hex = null
    s.e = null
  }

  #shaders(m: ModelManifestEntry): LiveryShaders {
    let p = this.#paint.get(m.id)
    if (p === undefined) this.#paint.set(m.id, (p = new LiveryShaders(m, 0.5))) // small on screen: half-size atlases
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
          const slot: Slot = { m, model, hex: null, e: null, headingDeg: 0, gear: null, motion: new GearMotion(), want: null, aglS: Infinity, aglFt: null, legsAt: -1, occluded: false }
          this.#slots.push(slot)
          if (m.gear !== undefined) {
            this.#loadGear(m.gear.uri).then(
              (g) => {
                if (this.#destroyed) return void g.destroy()
                g.show = false
                Matrix4.clone(model.modelMatrix, g.modelMatrix) // hidden, it still renders its first sky map: here, not at the Earth's centre
                this.#viewer.scene.primitives.add(g)
                slot.gear = g
              },
              (err: unknown) => console.warn(`FlightHopper: traffic gear ${m.gear!.uri} not loaded; flying without it:`, err),
            )
          }
        },
        (err: unknown) => {
          this.#loading.set(m.id, this.#loading.get(m.id)! - 1)
          if (!this.#failed.has(m.id)) console.warn(`FlightHopper: traffic model ${m.id} not loaded; its aircraft are not drawn:`, err)
          this.#failed.add(m.id)
        },
      )
    }
  }

  #place(i: number, b: Box, labelShown: boolean): void {
    let el = this.#els[i]
    if (el === undefined) {
      el = this.#els[i] = document.createElement('div')
      el.className = 'fh-bracket'
      const id = document.createElement('span') // the flight ID, above the square
      id.className = 'fh-bracket-id'
      const dist = document.createElement('span') // the distance, under it
      dist.className = 'fh-bracket-dist'
      el.append(id, dist)
      this.#layer.append(el)
    }
    const [id, dist] = el.children as unknown as [HTMLSpanElement, HTMLSpanElement]
    setText(id, b.label)
    setText(dist, formatDistanceM(b.distM))
    if (id.hidden === labelShown) id.hidden = dist.hidden = !labelShown
    const open = b.hex === this.#openHex // layout.css: highlighted while its card is open, and over the frame's cards
    el.classList.toggle('fh-bracket-open', open)
    const home = open ? this.#openLayer : this.#layer
    if (el.parentElement !== home) home.append(el)
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

/** Writes a text only when it changed (no DOM write, no style recalculation, in the steady state). */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text
}

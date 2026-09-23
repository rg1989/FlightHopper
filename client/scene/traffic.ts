// client/scene/traffic.ts
// Chase traffic (.planning/chase-traffic-design.md): the other aircraft within RANGE_NM of the chased one as 3-D models
// (the one GLB, sized by ADS-B emitter category), each framed on screen by two corner brackets whose square is also
// its click target.
import { Cartesian2, Cartesian3, HeadingPitchRoll, Math as CesiumMath, Matrix4, Model, SceneTransforms, Transforms } from 'cesium'
import type { PerspectiveFrustum, Viewer } from 'cesium'
import { distanceNm } from '../../shared/geo.ts'
import { targetAttitude } from '../track/attitude.ts'
import type { FleetEntry, ModelManifestEntry } from '../types.ts'
import { modelUrl } from './model.ts'

export const RANGE_NM = 10
export const MAX_MODELS = 30
export const MIN_PX = 24 // a far model is enlarged to keep this size on screen (minScale), and so is its square
// The bracket square, in the GLB's model frame (Cesium's: nose +X, up +Z; unscaled): the bounding-box centre, and half
// the side, half the wingspan (25.7) plus 8 %. The length (21.4) and height fit inside. traffic.test checks them.
// ponytail: constants of Cesium_Air.glb, the one model; upgrade: per-model manifest fields if a second GLB comes.
export const BOX_CENTRE = new Cartesian3(-2.7, 0, 1.58)
export const BOX_HALF = 13.9
const KT = 1852 / 3600
const FPM = 0.3048 / 60
const SLOW_KT = 40 // slower than this a vertical rate says little about pitch (a helicopter, a hover): level
/** Length factor per ADS-B emitter category on the one model (37.6 m long: a large airliner). */
const SCALE: Record<string, number> = { A1: 0.35, A2: 0.6, A3: 1, A4: 1.2, A5: 1.8, A7: 0.4 }

export const scaleFor = (category: string | null | undefined): number => (category ? SCALE[category] : undefined) ?? 1

/** The flight ID above a traffic model's brackets: its callsign, else its ICAO hex (as FleetLayer's label). */
export const flightId = (e: FleetEntry): string => e.info?.callsign ?? e.hex.toUpperCase()

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

/**
 * A bracket square: centre (CSS px from the canvas's top-left), side, depth along the view (m), the flight ID above it
 * and the distance from the chased aircraft (m) under it.
 */
export interface Box { hex: string; x: number; y: number; side: number; depthM: number; label: string; distM: number }

/** The distance under the brackets: whole metres, thousands separated ("12,345 m"). */
export const formatDistanceM = (m: number): string => `${Math.round(m).toLocaleString('en-US')} m`

/**
 * Whether a traffic model is hidden: the scene's depth under its square's centre (hitDistM from the camera; undefined:
 * sky) lies nearer than the model's near side (centreDistM − rM). A hit on the model itself or behind it is not.
 */
export const isOccluded = (hitDistM: number | undefined, centreDistM: number, rM: number): boolean =>
  hitDistM !== undefined && hitDistM < centreDistM - rM

const POPUP_GAP_PX = 10 // square → popup
const EDGE_PX = 8 // popup ↔ screen edge

/**
 * Where the popup of an aircraft goes: beside its square (right, or left at the right edge: flip), vertically centred
 * on it and kept on screen, clear of the rail (insetR) or the phone tab bar (insetB); tickY is where its pointer meets
 * the square's centre, from the popup's top.
 */
export function popupPlacement(
  b: Box, w: number, h: number, viewW: number, viewH: number, insetR = EDGE_PX, insetB = EDGE_PX,
): { left: number; top: number; flip: boolean; tickY: number } {
  let left = b.x + b.side / 2 + POPUP_GAP_PX
  const flip = left + w > viewW - insetR
  if (flip) left = Math.max(EDGE_PX, b.x - b.side / 2 - POPUP_GAP_PX - w)
  const top = Math.min(Math.max(b.y - h / 2, EDGE_PX), viewH - h - insetB)
  return { left, top, flip, tickY: Math.min(Math.max(b.y - top, 10), h - 10) }
}

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
 * brackets with a few labels instead of a smear of text. Brackets all stay.
 * ponytail: widths estimated from the character count; upgrade: measure each label text once.
 */
export function shownLabels(boxes: readonly Box[], n: number, out: boolean[]): boolean[] {
  out.length = n
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => boxes[a].depthM - boxes[b].depthM)
  const distChars = boxes.slice(0, n).map((b) => formatDistanceM(b.distM).length)
  for (let k = 0; k < n; k++) {
    const i = order[k]
    labelLines(boxes[i], distChars[i], la)
    let clear = true
    for (let q = 0; q < k && clear; q++) {
      const j = order[q]
      if (out[j]) clear = !linesClash(la, labelLines(boxes[j], distChars[j], lb))
    }
    out[i] = clear
  }
  return out
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

interface Slot { model: Model; hex: string | null; e: FleetEntry | null; headingDeg: number; occluded: boolean }

export interface TrafficOpts {
  load?: () => Promise<Model>
  flagOf?: (hex: string) => string // the country flag for the popup
  onChase?: (hex: string) => void // the popup's Chase button
}

const PROBES_PER_FRAME = 2 // depth reads (each a GPU sync) per frame: every square is re-checked every n / 2 frames

/**
 * The chase traffic. Models come from a pool that grows to the most ever needed (≤ MAX_MODELS), and Cesium shares
 * one GLB's geometry and textures between them. A model loads async; an aircraft shows nothing until a ready model is
 * free (chase shows no flat icons), and nor does one over MAX_MODELS. If the GLB fails, chase shows no traffic.
 * Brackets hide while the model is hidden (isOccluded: buildings, terrain, the chased aircraft), and behind the camera.
 * A click in a square opens the aircraft's popup (open); one at most.
 * ponytail: no hysteresis at the range edge. Upgrade: leave at 10.5 nm.
 */
export class Traffic {
  readonly #viewer: Viewer
  readonly #m: ModelManifestEntry
  readonly #layer: HTMLElement
  readonly #load: () => Promise<Model>
  readonly #flagOf: (hex: string) => string
  readonly #onChase: (hex: string) => void
  readonly #slots: Slot[] = []
  readonly #byHex = new Map<string, Slot>()
  readonly #models = new Set<string>()
  readonly #want = new Set<string>()
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
  readonly #p = new Cartesian3()
  #nBoxes = 0
  #probe = 0
  #loading = 0
  #failed = false
  #destroyed = false
  #popup: HTMLDivElement | null = null
  #openHex: string | null = null
  #popupH = 0
  #insetR = EDGE_PX // the rail or tab bar to keep the popup clear of: layout.css's padding on the layer, read per open
  #insetB = EDGE_PX

  constructor(viewer: Viewer, m: ModelManifestEntry, layer: HTMLElement, opts: TrafficOpts = {}) {
    this.#viewer = viewer
    this.#m = m
    this.#layer = layer
    this.#load = opts.load ?? ((): Promise<Model> => loadTrafficModel(m))
    this.#flagOf = opts.flagOf ?? ((): string => '')
    this.#onChase = opts.onChase ?? ((): void => {})
  }

  /**
   * This frame's traffic around the chased aircraft at `at`, for FleetLayer.update: the hexes drawn as models, the first
   * MAX_MODELS of nearestInRange's order that have a ready model. null at (not chasing, or no position yet): an empty
   * set, and every model, bracket and the popup hide.
   */
  select(entries: readonly FleetEntry[], chasedHex: string | null, at: { lat: number; lon: number } | null): ReadonlySet<string> {
    this.#models.clear()
    this.#want.clear()
    const near = at === null ? [] : nearestInRange(entries, chasedHex, at.lat, at.lon, RANGE_NM)
    for (let i = 0; i < near.length && i < MAX_MODELS; i++) this.#want.add(near[i].e.hex)
    for (const s of this.#slots) if (s.hex !== null && !this.#want.has(s.hex)) this.#free(s)
    this.#grow(this.#want.size)
    for (let i = 0; i < near.length && i < MAX_MODELS; i++) {
      const e = near[i].e
      let s = this.#byHex.get(e.hex)
      if (s === undefined) {
        s = this.#slots.find((x) => x.hex === null && x.model.ready)
        if (s === undefined) continue // none free and ready yet: not drawn this frame
        s.hex = e.hex
        s.headingDeg = e.trackDeg ?? 0
        s.occluded = false
        this.#byHex.set(e.hex, s)
      }
      s.e = e
      this.#models.add(e.hex)
    }
    if (this.#openHex !== null && !this.#byHex.has(this.#openHex)) this.close() // it left the traffic
    if (at === null) this.#hideBoxes(0)
    return this.#models
  }

  /**
   * After the camera moved this frame: each selected model goes where FleetLayer placed its aircraft, and its brackets
   * around it. ibl: the chased model's image-based light (the Sun dims it at night), copied so the traffic dims too.
   * chasedWC: the chased aircraft, for the distances under the brackets.
   */
  update(placed: { positionOf(hex: string): Cartesian3 | undefined }, ibl?: Cartesian2, chasedWC?: Cartesian3): void {
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
      // The square's radius at true size; a far model and its square are enlarged together to MIN_PX (depth taken at
      // the wheels: the centre is a few metres off).
      const k = scaleFor(e.info?.category)
      const rM = BOX_HALF * this.#m.scale * k
      const depth0 = Cartesian3.dot(Cartesian3.subtract(pos, cam.positionWC, this.#v), cam.directionWC)
      const g = depth0 > 1 ? minScale(rM, depth0, fovy, hPx) : 1
      const mm = trafficMatrix(pos, trafficHpr(e, this.#m, s.headingDeg, this.#hpr), this.#m, k * g, s.model.modelMatrix)
      if (ibl) s.model.imageBasedLighting.imageBasedLightingFactor = ibl // the setter copies it
      s.model.show = true
      const c = Matrix4.multiplyByPoint(mm, BOX_CENTRE, this.#c)
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
    shownLabels(this.#boxes, n, this.#labelShown)
    for (let i = 0; i < n; i++) this.#place(i, this.#boxes[i], this.#labelShown[i])
    this.#hideBoxes(n)
    this.#placePopup(n)
  }

  /** The traffic aircraft whose bracket square holds (x, y) (canvas CSS px), nearest first; null when none. */
  hitAt(x: number, y: number): string | null {
    return hitAt(this.#boxes, this.#nBoxes, x, y)
  }

  /** Opens the popup on this traffic aircraft (moving it from another one: one at most). */
  open(hex: string): void {
    this.#openHex = hex
    this.#popupH = 0 // re-measured at its first placement
  }

  /** Closes the popup; true if one was open. */
  close(): boolean {
    if (this.#openHex === null) return false
    this.#openHex = null
    if (this.#popup) this.#popup.hidden = true
    return true
  }

  /** Whether a DOM node is inside the popup (a click there must not close it). */
  popupContains(node: Node | null): boolean {
    return this.#popup !== null && node !== null && this.#popup.contains(node)
  }

  destroy(): void {
    this.#destroyed = true
    for (const s of this.#slots) this.#viewer.scene.primitives.remove(s.model)
    this.#slots.length = 0
    this.#byHex.clear()
    for (const el of this.#els) el.remove()
    this.#els.length = 0
    this.#nBoxes = 0
    this.#popup?.remove()
    this.#popup = null
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

  #free(s: Slot): void {
    s.model.show = false
    if (s.hex !== null) this.#byHex.delete(s.hex)
    s.hex = null
    s.e = null
  }

  #grow(want: number): void {
    while (!this.#failed && !this.#destroyed && this.#slots.length + this.#loading < want) {
      this.#loading++
      this.#load().then(
        (model) => {
          this.#loading--
          if (this.#destroyed) return void model.destroy()
          model.show = false
          this.#viewer.scene.primitives.add(model)
          this.#slots.push({ model, hex: null, e: null, headingDeg: 0, occluded: false })
        },
        (err: unknown) => {
          this.#loading--
          if (!this.#failed) console.warn('FlightHopper: traffic model not loaded; chase shows no traffic:', err)
          this.#failed = true
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
    const side = Math.round(b.side)
    el.style.width = el.style.height = `${side}px`
    el.style.transform = `translate(${(b.x - side / 2).toFixed(1)}px, ${(b.y - side / 2).toFixed(1)}px)`
    el.hidden = false
  }

  #hideBoxes(n: number): void {
    for (let i = n; i < this.#nBoxes; i++) this.#els[i].hidden = true
    this.#nBoxes = n
  }

  /** The open popup beside its aircraft's square; hidden while the square is (behind the camera, or the model hidden). */
  #placePopup(n: number): void {
    const hex = this.#openHex
    if (hex === null) return
    let i = 0
    while (i < n && this.#boxes[i].hex !== hex) i++
    const pop = this.#popup ?? this.#makePopup()
    const e = this.#byHex.get(hex)?.e ?? null
    if (i === n || e === null) {
      pop.hidden = true
      return
    }
    const b = this.#boxes[i]
    const [head, stats] = pop.children as unknown as [HTMLElement, HTMLElement]
    const [flag, id, type] = head.children as unknown as HTMLElement[]
    const [alt, gs, dist] = stats.children as unknown as HTMLElement[]
    setText(flag, this.#flagOf(hex))
    setText(id, flightId(e))
    setText(type, e.info?.typeCode ?? '')
    type.hidden = !e.info?.typeCode
    setText(alt, e.onGround ? 'GND' : e.altFt === null ? '— ft' : `${e.altFt.toLocaleString('en-US')} ft`)
    setText(gs, e.gsKt === null ? '— kt' : `${Math.round(e.gsKt)} kt`)
    setText(dist, formatDistanceM(b.distM))
    pop.hidden = false
    if (this.#popupH === 0) {
      // Once per open: its content keeps its lines, and the rail only moves with the window.
      this.#popupH = pop.offsetHeight
      const cs = getComputedStyle(this.#layer)
      this.#insetR = parseFloat(cs.paddingRight) || EDGE_PX
      this.#insetB = parseFloat(cs.paddingBottom) || EDGE_PX
    }
    const scene = this.#viewer.scene
    const p = popupPlacement(b, pop.offsetWidth, this.#popupH, scene.canvas.clientWidth, scene.canvas.clientHeight, this.#insetR, this.#insetB)
    pop.classList.toggle('fh-tpop-flip', p.flip)
    pop.style.transform = `translate(${p.left.toFixed(1)}px, ${p.top.toFixed(1)}px)`
    pop.style.setProperty('--tick-y', `${p.tickY.toFixed(1)}px`)
  }

  #makePopup(): HTMLDivElement {
    const pop = (this.#popup = document.createElement('div'))
    pop.className = 'fh-tpop'
    pop.hidden = true
    pop.innerHTML =
      '<div class="fh-tpop-head"><span class="fh-tpop-flag"></span><b class="fh-tpop-id"></b><span class="fh-tpop-type"></span></div>' +
      '<div class="fh-tpop-stats"><span></span><span></span><span></span></div>' +
      '<button type="button" class="fh-tpop-chase">Chase</button>'
    pop.querySelector('button')!.addEventListener('click', () => {
      const hex = this.#openHex
      this.close()
      if (hex !== null) this.#onChase(hex)
    })
    this.#layer.append(pop)
    return pop
  }
}

/** Writes a text only when it changed (no DOM write, no style recalculation, in the steady state). */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text
}

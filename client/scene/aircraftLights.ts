// client/scene/aircraftLights.ts
// Exterior lights on the 3-D aircraft, the chased one and the chase traffic, as a real aircraft shows them:
// - position lights, steady: red on the left wing tip, green on the right, white on the tail cone, each brightest in
//   its own sector (FAR 25.1385–25.1391: red and green from dead ahead to 110° their own side, white 70° either side of
//   dead astern) with a dim spill of the lamp outside it;
// - red anti-collision beacons over and under the fuselage, one short flash a second (the two alternate), whenever the
//   engines run: airborne or moving;
// - white strobes on the wing tips and the tail, a double flash every 1.2 s, airborne and on the take-off roll;
// - landing lights at the wing roots and the nose gear, beamed ahead, below 10,000 ft (fading in from 10,000 to
//   8,000 ft) and on the runway at speed; the nose gear's taxi light also on the ground while moving.
// Each light is a glow billboard at its model's own anchor (manifest `lights`, tools/models/light-anchors.ts), placed
// every frame from the matrix the model is drawn with, so it follows heading, pitch and bank exactly. By night they glow
// in halos sized so that a far aircraft is still a pattern of coloured points; by day only the strobes, the beacons
// and a landing light aimed at the camera show, as small flashes. Flashes run on the wall clock (steady rhythm, also
// in a paused scenario), each aircraft out of step with the others.
// The glows are depth-tested (terrain, buildings and other aircraft hide them), pulled towards the camera by a few
// per cent of the aircraft's length so the light's own wing tip or fuselage does not cut its halo.
import { BillboardCollection, BlendOption, Cartesian3, Cartesian4, Color, Matrix3, Matrix4 } from 'cesium'
import type { Billboard, CustomShader, Scene, Viewer } from 'cesium'
import type { FleetEntry, LightAnchors, ModelManifestEntry, RenderState } from '../types.ts'
import { smoothstep } from './exaggeration.ts'
import { LiveryShaders } from './livery.ts'
import { fixMatrix } from './model.ts'

// ---------- when each light is on ----------

/** What the lights of one aircraft depend on. altFt: its altitude (baro or MSL, ft), null when unknown. */
export interface LightState {
  onGround: boolean
  altFt: number | null
  gsKt: number | null
  damaged: boolean // a scenario's damage: lights in its paint map's cut (the lost fin and tail cone) are gone
}

const TAKEOFF_KT = 40 // on the ground at or above this: a take-off or landing roll
const MOVING_KT = 1
export const LANDING_OFF_FT = 10_000
export const LANDING_FULL_FT = 8_000

/** 1 below LANDING_FULL_FT, 0 above LANDING_OFF_FT, smooth between; unknown altitude: 0 (a cruising aircraft's). */
export function belowTenThousand(altFt: number | null): number {
  return altFt === null || !Number.isFinite(altFt) ? 0 : smoothstep((LANDING_OFF_FT - altFt) / (LANDING_OFF_FT - LANDING_FULL_FT))
}

/** Landing lights, 0…1: low (belowTenThousand) and airborne, or on a take-off or landing roll. */
export function landingOn(s: LightState): number {
  if (s.onGround) return (s.gsKt ?? 0) >= TAKEOFF_KT ? 1 : 0
  return belowTenThousand(s.altFt)
}

/** The nose gear's light, 0…1: the landing lights airborne, the taxi light on the ground while moving. */
export function taxiOn(s: LightState): number {
  return s.onGround ? ((s.gsKt ?? 0) >= 3 ? 1 : 0) : landingOn(s)
}

/** Strobes: airborne, or on the runway at take-off speed. */
export function strobesOn(s: LightState): boolean {
  return !s.onGround || (s.gsKt ?? 0) >= TAKEOFF_KT
}

/** Beacons: whenever the engines run, which ADS-B shows as airborne or moving. */
export function beaconsOn(s: LightState): boolean {
  return !s.onGround || (s.gsKt ?? 0) >= MOVING_KT
}

// ---------- flashes (seconds of wall-clock time) ----------

export const STROBE_PERIOD_S = 1.2
export const BEACON_PERIOD_S = 1
const STROBE_FLASH_S = 0.07
const STROBE_GAP_S = 0.16 // from the first flash's start to the second's

const frac = (x: number): number => x - Math.floor(x)

/** Strobe intensity 0…1 at tS: a double flash every STROBE_PERIOD_S, each at full brightness and fading a little. */
export function strobeAt(tS: number): number {
  const u = frac(tS / STROBE_PERIOD_S) * STROBE_PERIOD_S
  const x = u < STROBE_GAP_S ? u : u - STROBE_GAP_S
  return x >= 0 && x < STROBE_FLASH_S ? 1 - 0.4 * (x / STROBE_FLASH_S) ** 2 : 0
}

/** Beacon intensity 0…1 at tS: one flash per BEACON_PERIOD_S, rising in 30 ms, held 60 ms, fading over 70 ms. */
export function beaconAt(tS: number): number {
  const u = frac(tS / BEACON_PERIOD_S) * BEACON_PERIOD_S
  if (u < 0.03) return u / 0.03
  if (u < 0.09) return 1
  if (u < 0.16) return 1 - (u - 0.09) / 0.07
  return 0
}

/** A steady 0…1 fraction from a key (the hex): FNV-1a. Sets an aircraft's flashes out of step with the others'. */
export function phaseOf(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193)
  return (h >>> 0) / 0x1_0000_0000
}

// ---------- where each light is seen from ----------

const NAV_SECTOR_DEG = 110 // red and green: dead ahead to 110° their own side; white: the rest, astern
const EDGE_DEG = 6 // soft sector edges, no pop
export const NAV_SPILL = 0.3 // outside its sector a position light still shows its lit lamp, dimly
const RAD = Math.PI / 180

const band = (a: number, lo: number, hi: number): number =>
  smoothstep((a - lo) / EDGE_DEG + 0.5) * smoothstep((hi - a) / EDGE_DEG + 0.5)

/**
 * How much of a position light a viewer sees, NAV_SPILL…1. fwd, left: two components of the unit direction from the
 * light to the viewer in the aircraft's frame (along the nose and the left wing). The sectors are in the aircraft's
 * horizontal plane; seen from high above or below (within ~30° of its vertical) every position light shows.
 */
export function navSector(kind: 'left' | 'right' | 'tail', fwd: number, left: number): number {
  const horiz = Math.hypot(fwd, left)
  const az = Math.atan2(left, fwd) / RAD // 0 dead ahead, +90 left, ±180 astern
  const w = kind === 'left' ? band(az, 0, NAV_SECTOR_DEG) : kind === 'right' ? band(az, -NAV_SECTOR_DEG, 0) : smoothstep((Math.abs(az) - NAV_SECTOR_DEG) / EDGE_DEG + 0.5)
  const inSector = 1 + (w - 1) * smoothstep(horiz / 0.5) // straight above or below: 1
  return NAV_SPILL + (1 - NAV_SPILL) * inSector
}

const BEAM_DOWN = 3 * RAD // landing lights aim a little below the fuselage axis

/**
 * A landing light's glare, 0…1, from the cosine of the angle between its beam and the direction to the viewer: the
 * beam's core (~24° wide to half strength) and the lit lamp, dimly, from anywhere ahead of it.
 */
export function beamFactor(cosToViewer: number): number {
  const c = Math.min(1, Math.max(-1, cosToViewer))
  const deg = Math.acos(c) / RAD
  return Math.min(1, Math.exp(-((deg / 24) ** 2)) + 0.1 * Math.max(0, c))
}

// ---------- how big and how bright ----------

const REF_M = 150 // glow sizes are given at the chase camera's usual range
/** The glow's size factor at dM from the camera: shrinks with the square root of distance, clamped. */
export function glowScale(dM: number): number {
  return Math.min(1.7, Math.max(0.14, Math.sqrt(REF_M / Math.max(1, dM))))
}

interface Kind { id: string; hex: string; nightPx: number; dayPx: number }
const KINDS = {
  red: { id: 'fh-light-red', hex: '#ff3524', nightPx: 44, dayPx: 9 },
  green: { id: 'fh-light-green', hex: '#2dff93', nightPx: 44, dayPx: 9 },
  white: { id: 'fh-light-white', hex: '#fff3e2', nightPx: 40, dayPx: 8 },
  beacon: { id: 'fh-light-beacon', hex: '#ff1c12', nightPx: 76, dayPx: 24 },
  strobe: { id: 'fh-light-strobe', hex: '#eef4ff', nightPx: 120, dayPx: 38 },
  landing: { id: 'fh-light-landing', hex: '#fff1d8', nightPx: 170, dayPx: 56 },
} as const satisfies Record<string, Kind>
type KindName = keyof typeof KINDS
const KIND_NAMES = Object.keys(KINDS) as KindName[]
const DAY_NAV_ALPHA = 0.22

/** Radial glow, 128 px: a white-hot core in a halo of the light's colour that fades out to the edge. Browser only. */
export function glowCanvas(hex: string, px = 128): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = cv.height = px
  const ctx = cv.getContext('2d')!
  const img = ctx.createImageData(px, px)
  const c = Color.fromCssColorString(hex)
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const r = Math.hypot(x + 0.5 - px / 2, y + 0.5 - px / 2) / (px / 2)
      const core = Math.exp(-((r / 0.07) ** 2))
      const halo = 0.85 * Math.exp(-((r / 0.2) ** 2)) + 0.3 * Math.exp(-((r / 0.5) ** 2)) * Math.max(0, 1 - r * r)
      const white = Math.exp(-((r / 0.12) ** 2))
      const i = 4 * (y * px + x)
      img.data[i] = 255 * (c.red + (1 - c.red) * white)
      img.data[i + 1] = 255 * (c.green + (1 - c.green) * white)
      img.data[i + 2] = 255 * (c.blue + (1 - c.blue) * white)
      img.data[i + 3] = 255 * Math.min(1, core + halo)
    }
  }
  ctx.putImageData(img, 0, 0)
  return cv
}

// ---------- the scene ----------

/** One aircraft placed this frame. Reused between frames. */
interface Placed {
  key: string
  mm: Matrix4
  k: number // Cesium's own enlargement (the chased model's minimumPixelSize), about the model origin
  entry: ModelManifestEntry
  s: LightState
  shader: CustomShader | null // the chased model's paint: its lamps light its own skin (livery.ts)
}

/** What forChase needs of the chased Cesium Model. */
export interface ChasedModel {
  modelMatrix: Matrix4
  customShader?: CustomShader
}

type Sector = 0 | 1 | 2 | 3 | 4
const ALL_ROUND = 0
const LEFT = 1
const RIGHT = 2
const TAIL = 3
const BEAM = 4
const EYE_PULL = 0.03 // of the aircraft's drawn length: the glow is moved this far towards the camera
const MIN_ALPHA = 0.01

const scratchP = new Cartesian3()
const scratchV = new Cartesian3()
const scratchA = new Cartesian3()
const scratchEye = new Cartesian3()
const scratchColor = new Color()
const scratchLamp = new Cartesian4()
const FAR = 1e4 // mesh units: a lamp here lights nothing

/**
 * The lights of every aircraft drawn this frame, in one BillboardCollection (one draw call), a pool of billboards per
 * kind of light so none ever changes its image. Per frame: forChase and forTraffic for each drawn model, after it has
 * its matrix, then endFrame once, after the Sun has set night. An aircraft not given this frame shows no lights.
 */
export class AircraftLights {
  readonly #scene: Scene
  readonly #bbs: BillboardCollection
  readonly #pools = new Map<KindName, Billboard[]>()
  readonly #used = new Map<KindName, number>()
  readonly #placed: Placed[] = []
  #n = 0
  readonly #fixInv = new Map<ModelManifestEntry, Matrix3>()
  readonly #nose = new Cartesian3()
  readonly #left = new Cartesian3()
  readonly #up = new Cartesian3()

  constructor(viewer: Viewer) {
    this.#scene = viewer.scene
    // Cesium draws a TRANSLUCENT collection in the opaque pass, writing depth: a halo drawn before an aircraft punched
    // a hole in its fuselage (the sky showed through). OPAQUE_AND_TRANSLUCENT: only the white-hot core is opaque; the
    // halo is drawn after every opaque thing, depth-tested, writing no depth.
    this.#bbs = viewer.scene.primitives.add(new BillboardCollection({ blendOption: BlendOption.OPAQUE_AND_TRANSLUCENT }))
    for (const k of KIND_NAMES) {
      this.#pools.set(k, [])
      this.#used.set(k, 0)
    }
  }

  /**
   * The chased aircraft this frame, drawn with model.modelMatrix (ChaseModel.update) and enlarged by Cesium to
   * minimumPixelSize when far (Model.computedScale, last frame's). damaged: the scenario's damage is shown.
   */
  forChase(model: ChasedModel, entry: ModelManifestEntry, s: RenderState, damaged: boolean): void {
    const k = (model as { computedScale?: number }).computedScale
    const p = this.#next(s.hex, model.modelMatrix, entry, Number.isFinite(k) && k! > 0 ? k! : 1)
    if (p === null) return
    p.shader = model.customShader ?? null
    p.s.onGround = s.onGround
    p.s.altFt = s.altBaroFt ?? s.hM / 0.3048
    p.s.gsKt = s.gsKt
    p.s.damaged = damaged
  }

  /** One traffic aircraft this frame, drawn with mm (Traffic.forEachDrawn's callback). */
  readonly forTraffic = (hex: string, mm: Matrix4, m: ModelManifestEntry, e: FleetEntry): void => {
    const p = this.#next(hex, mm, m, 1)
    if (p === null) return
    p.shader = null
    p.s.onGround = e.onGround
    p.s.altFt = e.altFt
    p.s.gsKt = e.gsKt
    p.s.damaged = false
  }

  /**
   * Writes this frame's lights and hides the rest; forgets the frame's aircraft. night: 0 day … 1 night (the Sun's;
   * 0 while the Sun toggle is off, which lights the scene as by day). nowMs: performance.now().
   */
  endFrame(night: number, nowMs: number): void {
    const n = Number.isFinite(night) ? Math.min(1, Math.max(0, night)) : 0
    LiveryShaders.setNight(n) // the cabin windows and the logo lights of every model
    const tS = nowMs / 1000
    const cam = this.#scene.camera.positionWC
    for (const k of KIND_NAMES) this.#used.set(k, 0)
    for (let i = 0; i < this.#n; i++) this.#draw(this.#placed[i], n, tS, cam)
    for (const k of KIND_NAMES) {
      const pool = this.#pools.get(k)!
      for (let i = this.#used.get(k)!; i < pool.length; i++) if (pool[i].show) pool[i].show = false
    }
    this.#n = 0
  }

  destroy(): void {
    this.#scene.primitives.remove(this.#bbs)
    this.#pools.clear()
  }

  #next(key: string, mm: Matrix4, entry: ModelManifestEntry, k: number): Placed | null {
    if (entry.lights === undefined) return null
    let p = this.#placed[this.#n]
    if (p === undefined) {
      p = this.#placed[this.#n] = { key, mm: new Matrix4(), k, entry, s: { onGround: false, altFt: null, gsKt: null, damaged: false }, shader: null }
    }
    this.#n++
    p.key = key
    Matrix4.clone(mm, p.mm)
    p.k = k
    p.entry = entry
    return p
  }

  /** The aircraft's nose, left wing and up as unit world vectors (its matrix · fixMatrix⁻¹). */
  #axes(p: Placed): void {
    let inv = this.#fixInv.get(p.entry)
    if (inv === undefined) this.#fixInv.set(p.entry, (inv = Matrix3.transpose(fixMatrix(p.entry), new Matrix3())))
    const axis = (col: number, out: Cartesian3): void => {
      Matrix3.getColumn(inv!, col, out)
      Cartesian3.normalize(Matrix4.multiplyByPointAsVector(p.mm, out, out), out)
    }
    axis(0, this.#nose)
    axis(1, this.#left)
    axis(2, this.#up)
  }

  #draw(p: Placed, n: number, tS: number, cam: Cartesian3): void {
    const L = p.entry.lights as LightAnchors
    const s = p.s
    this.#axes(p)
    const pull = EYE_PULL * (p.entry.lengthM / p.entry.scale) * Matrix4.getMaximumScale(p.mm) * p.k
    const ph = phaseOf(p.key)
    // Position lights: steady; by day a faint lit lamp only.
    const nav = DAY_NAV_ALPHA + (1 - DAY_NAV_ALPHA) * n
    this.#light(p, L.navLeft, 'red', nav, 1, LEFT, n, cam, pull)
    this.#light(p, L.navRight, 'green', nav, 1, RIGHT, n, cam, pull)
    this.#light(p, L.tail, 'white', nav, 1, TAIL, n, cam, pull)
    const beacons = beaconsOn(s)
    const b0 = beacons && L.beacons.length > 0 ? beaconAt(tS + ph * BEACON_PERIOD_S) : 0
    const b1 = beacons && L.beacons.length > 1 ? beaconAt(tS + (ph + 0.5) * BEACON_PERIOD_S) : 0 // the two alternate
    if (b0 > 0) this.#light(p, L.beacons[0], 'beacon', b0, 0.6 + 0.4 * b0, ALL_ROUND, n, cam, pull)
    if (b1 > 0) this.#light(p, L.beacons[1], 'beacon', b1, 0.6 + 0.4 * b1, ALL_ROUND, n, cam, pull)
    const strobe = strobesOn(s) ? strobeAt(tS + ph * STROBE_PERIOD_S) : 0
    if (strobe > 0) {
      this.#light(p, L.navLeft, 'strobe', strobe, strobe, ALL_ROUND, n, cam, pull)
      this.#light(p, L.navRight, 'strobe', strobe, strobe, ALL_ROUND, n, cam, pull)
      this.#light(p, L.tail, 'strobe', strobe, strobe, ALL_ROUND, n, cam, pull)
    }
    if (p.shader !== null) this.#skin(p, p.shader, n, b0, b1, strobe)
    const land = landingOn(s)
    const taxi = taxiOn(s)
    for (let i = 0; i < L.landing.length; i++) {
      const on = i === 2 || L.landing.length === 1 ? taxi : land // the nose gear's is also the taxi light
      if (on > 0) this.#light(p, L.landing[i], 'landing', on * (0.85 + 0.15 * n), 1, BEAM, n, cam, pull)
    }
  }

  /**
   * One glow at anchor a (model frame): alpha 0…1 and size factor sz before the sector's (the direction to the camera
   * in the aircraft's frame). Skipped when too dim, or cut away with a damaged fin or tail cone.
   */
  #light(p: Placed, a: readonly number[], kind: KindName, alpha: number, sz: number, sector: Sector, n: number, cam: Cartesian3, pull: number): void {
    const cut = p.s.damaged ? p.entry.paint?.cut : undefined
    if (cut !== undefined && lost(p.entry, a, cut)) return
    const pos = Matrix4.multiplyByPoint(p.mm, Cartesian3.fromElements(a[0] * p.k, a[1] * p.k, a[2] * p.k, scratchP), scratchP)
    const v = Cartesian3.subtract(cam, pos, scratchV)
    const d = Cartesian3.magnitude(v)
    if (!(d > 0)) return
    Cartesian3.divideByScalar(v, d, v)
    let w = 1
    if (sector !== ALL_ROUND) {
      const f = Cartesian3.dot(v, this.#nose)
      w = sector === BEAM
        ? beamFactor(f * Math.cos(BEAM_DOWN) - Cartesian3.dot(v, this.#up) * Math.sin(BEAM_DOWN))
        : navSector(sector === LEFT ? 'left' : sector === RIGHT ? 'right' : 'tail', f, Cartesian3.dot(v, this.#left))
    }
    if (alpha * w < MIN_ALPHA) return
    const K = KINDS[kind]
    const b = this.#claim(kind)
    b.position = pos
    b.scale = ((K.dayPx + (K.nightPx - K.dayPx) * n) * sz * Math.sqrt(w) * glowScale(d)) / GLOW_PX
    b.color = Color.fromAlpha(Color.WHITE, Math.min(1, alpha * w), scratchColor)
    b.eyeOffset = Cartesian3.fromElements(0, 0, -Math.min(pull, 0.4 * d), scratchEye)
    if (!b.show) b.show = true
  }

  /**
   * The chased aircraft's lamps on its own skin (livery.ts lamp()): a steady wash of red, green and white at night, the
   * beacons' and the strobes' flashes (dimmer by day, against the daylight), and u_env on, as it reflects its sky map.
   */
  #skin(p: Placed, sh: CustomShader, n: number, b0: number, b1: number, strobe: number): void {
    const L = p.entry.lights as LightAnchors
    const cut = p.s.damaged ? p.entry.paint?.cut : undefined
    // The mesh frame (glTF) from the model frame: x ← y, y ← z, z ← x. The strobes flash from the position lights'
    // places, so those are written even while dark; a lamp cut away (or absent) goes far off.
    const set = (name: string, a: readonly number[] | undefined, w: number): void => {
      const gone = a === undefined || (cut !== undefined && lost(p.entry, a, cut))
      sh.setUniform(name, gone ? Cartesian4.fromElements(FAR, FAR, FAR, 0, scratchLamp) : Cartesian4.fromElements(a[1], a[2], a[0], Math.max(0, w), scratchLamp))
    }
    const day = 0.25 + 0.75 * n
    sh.setUniform('u_env', 1)
    set('u_navL', L.navLeft, 0.6 * n)
    set('u_navR', L.navRight, 0.6 * n)
    set('u_navT', L.tail, 0.5 * n)
    set('u_bcn0', L.beacons[0], b0 * day)
    set('u_bcn1', L.beacons[1], b1 * day)
    sh.setUniform('u_strobe', strobe * day)
  }

  #claim(kind: KindName): Billboard {
    const pool = this.#pools.get(kind)!
    const i = this.#used.get(kind)!
    this.#used.set(kind, i + 1)
    let b = pool[i]
    if (b === undefined) {
      b = this.#bbs.add({ position: Cartesian3.ZERO, show: false, width: GLOW_PX, height: GLOW_PX })
      b.setImage(KINDS[kind].id, glow(kind))
      pool.push(b)
    }
    return b
  }
}

const GLOW_PX = 64 // a billboard's size at scale 1
const glows = new Map<KindName, HTMLCanvasElement>()
const glow = (kind: KindName): HTMLCanvasElement => {
  let c = glows.get(kind)
  if (c === undefined) glows.set(kind, (c = glowCanvas(KINDS[kind].hex)))
  return c
}

/** An anchor (model frame) inside a paint map's cut: the fin above its kept stump, or the tail cone aft of the break. */
export function lost(e: ModelManifestEntry, a: readonly number[], cut: NonNullable<NonNullable<ModelManifestEntry['paint']>['cut']>): boolean {
  const f = fixMatrix(e)
  const b = Matrix3.multiplyByVector(f, Cartesian3.fromElements(a[0], a[1], a[2], scratchA), scratchA) // body: nose, left, up
  const fin = e.paint!.fin
  if (b.x < cut.tailConeZ && Math.abs(b.y) < cut.tailHalfWidth) return true
  return b.x < fin.behindZ && b.z > cut.finKeepY && Math.abs(b.y) < fin.halfWidth
}

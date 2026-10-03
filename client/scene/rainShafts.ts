// client/scene/rainShafts.ts
// Rain falling out of the chase's heavy rain clouds, as the radar shows it (cloudField.ts radarClouds draws the clouds): a
// shaft of grey streaks from each cloud's base to the ground under a block of 35 dBZ or more of rain (never snow), 2 to 4 km
// wide, more opaque the heavier, at most 40, the nearest. Where the rain is one continuous region the shafts stand farther
// apart and each is wider until they fit (radarCells.ts thin), so they are spread over it, not all round the nearest block.
// A shaft is one Cesium Billboard in one BillboardCollection (one draw call): sized in metres, aligned to the local up, so it
// turns only about the vertical to face the camera, and its middle half way between the base and the ground. All share one
// image, drawn once on a canvas (shaftCanvas): a veil with thin vertical streaks, soft at its sides, its top (inside the cloud:
// it reaches RADAR_LOOK.shaft.overlapM up into it) and its foot.
// Like the clouds it follows the relief drawn (frame: a flattened ground moves it with its foot on it), the Sun's night, and
// is faded by its distance from the aircraft (fade: it has faded out where it looks small, as a cloud does, and by the radius the
// radar is read to, so none pops at its edge).
// The base and the ground are estimates (cloudField.ts radarBases). Translucent billboards write no depth, so the ground fog
// (groundFog.ts) fogs a shaft by what is behind it.
// ponytail: a billboard is a flat card that faces the camera: from straight above or below a shaft is a rectangle, not a
// column. A shaft the camera is inside fills the view until its middle passes behind the camera. Upgrade: fade a shaft out as
// the camera comes within its size (as for the clouds, cloudLayer.ts).
import { BillboardCollection, BlendOption, Cartesian3, Color, Ellipsoid, VerticalOrigin, type Billboard, type PrimitiveCollection } from 'cesium'
import { geoidN } from '../../shared/geoid.ts'
import type { TerrainFrame } from '../types.ts'
import { RADAR_LOOK, between, fadeAlpha, farKmOf, lerp, ramp, sequence, sunBrightness, type BaseOf } from './cloudField.ts'
import { drawnHeightM } from './exaggeration.ts'
import { thin, type RadarCell } from './radarCells.ts'

export const SHAFT_ID = 'fh-rain-shaft' // the image's id in the collection's atlas: one copy for every billboard
const MIN_LENGTH_M = 100 // a shaft is at least this tall (a ceiling just over the ground)
const NIGHT_STEP = 0.02 // the colour is written again when the night has changed by this
const FADE_STEP = 0.05 // a shaft's fade is written again when it has changed by this
const STRIDE = 7 // per shaft in #at: its middle at its true height (x, y, z), the ellipsoid's up there (x, y, z), its ground above the ellipsoid

/** The image's look (applies when it is drawn, so after a reload): pixels, the veil, and the streaks (light and dark, rgb; share of the height; px wide; opacity). */
const IMAGE = {
  w: 64, h: 256, veil: '118, 130, 150', veilAlpha: 0.75, streaks: 28, seed: 23,
  light: '224, 232, 246', dark: '70, 82, 100', lightShare: 0.6, length: [0.35, 0.95] as const, width: [1, 2.6] as const, alpha: [0.35, 0.8] as const,
  top: 0.18, foot: 0.8, // where the top's fade-in ends and the foot's fade-out starts, of the height
}

/** One shaft of rain: where it falls, from what base to what ground (metres above sea level; estimates), how wide, and how opaque. */
export interface RainShaft {
  lon: number
  lat: number
  baseM: number
  groundM: number
  widthM: number
  alpha: number // 0–1
  farKm: number // where it has faded out, km from the aircraft
}

/** A shaft's length: from the ground up into its cloud. */
const lengthOf = (baseM: number, groundM: number): number => Math.max(MIN_LENGTH_M, baseM + RADAR_LOOK.shaft.overlapM - groundM)

/**
 * The shafts under the radar's cells: a shaft for each rain block of RADAR_LOOK.shaft.dbz and more, the strongest kept apart
 * (at most RADAR_LOOK.shaft.max, the nearest; wider where they were thinned), on the base and the ground of its place (base).
 */
export function pickShafts(cells: readonly RadarCell[], base: BaseOf): RainShaft[] {
  const S = RADAR_LOOK.shaft
  const width = (c: RadarCell): number => lerp(S.width, ramp(c.dbz, S.dbz, RADAR_LOOK.fullDbz))
  const rain = cells.filter((c) => !c.snow && c.dbz >= S.dbz)
  const { kept, m } = thin(rain, (c) => (S.spacing * width(c)) / 1000, S.max, RADAR_LOOK.grow)
  return kept.map((c) => {
    const b = base(c.lat, c.lon)
    const widthM = width(c) * m
    return {
      lon: c.lon, lat: c.lat, baseM: b.baseM, groundM: b.groundM, widthM, alpha: lerp(S.alpha, ramp(c.dbz, S.dbz, RADAR_LOOK.fullDbz)),
      farKm: Math.min(RADAR_LOOK.radiusKm, farKmOf(Math.max(widthM, lengthOf(b.baseM, b.groundM)))),
    }
  })
}

let drawn: HTMLCanvasElement | null = null

/** The shaft's image, drawn once: a veil of grey with light and dark streaks, each fading in at its top and out at its foot; then cut to a soft shape (the sides, the top inside the cloud, the foot). */
export function shaftCanvas(): HTMLCanvasElement {
  if (drawn !== null) return drawn
  const { w, h } = IMAGE
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  g.fillStyle = `rgba(${IMAGE.veil}, ${IMAGE.veilAlpha})`
  g.fillRect(0, 0, w, h)
  const r = sequence(IMAGE.seed) // the same image every time
  for (let i = 0; i < IMAGE.streaks; i++) {
    const [x, lw, y0, len, a] = [r() * w, between(r, IMAGE.width), r() * h * 0.5, between(r, IMAGE.length) * h, between(r, IMAGE.alpha)]
    const rgb = r() < IMAGE.lightShare ? IMAGE.light : IMAGE.dark
    const grad = g.createLinearGradient(0, y0, 0, y0 + len)
    grad.addColorStop(0, `rgba(${rgb}, 0)`)
    grad.addColorStop(0.3, `rgba(${rgb}, ${a})`)
    grad.addColorStop(0.75, `rgba(${rgb}, ${a})`)
    grad.addColorStop(1, `rgba(${rgb}, 0)`)
    g.fillStyle = grad
    g.fillRect(x, y0, lw, len)
  }
  g.globalCompositeOperation = 'destination-in'
  const side = g.createLinearGradient(0, 0, w, 0)
  for (let i = 0; i <= 10; i++) side.addColorStop(i / 10, `rgba(0, 0, 0, ${(Math.sin((Math.PI * i) / 10) ** 2).toFixed(3)})`) // plain decimals: no 1e-32
  g.fillStyle = side
  g.fillRect(0, 0, w, h)
  const long = g.createLinearGradient(0, 0, 0, h)
  long.addColorStop(0, 'rgba(0, 0, 0, 0)')
  long.addColorStop(IMAGE.top, 'rgba(0, 0, 0, 1)')
  long.addColorStop(IMAGE.foot, 'rgba(0, 0, 0, 1)')
  long.addColorStop(1, 'rgba(0, 0, 0, 0)')
  g.fillStyle = long
  g.fillRect(0, 0, w, h)
  return (drawn = c)
}

const scratch = new Cartesian3()
const tint = new Color()

export interface RainShaftsOptions {
  image?: () => HTMLCanvasElement // the shaft's image, made once for all: default shaftCanvas
  geoid?: (lat: number, lon: number) => number
}

/** The shafts drawn: one billboard each (draw replaces them all); frame() every frame and fade() at each look write only what changed. */
export class RainShafts {
  readonly #primitives: PrimitiveCollection
  readonly #coll = new BillboardCollection({ show: false, blendOption: BlendOption.TRANSLUCENT })
  readonly #image: () => HTMLCanvasElement
  readonly #geoid: (lat: number, lon: number) => number
  #bbs: Billboard[] = []
  #shafts: readonly RainShaft[] = []
  #at = new Float64Array(0)
  #fade = new Float64Array(0) // each shaft's fade as written (in steps)
  #from: Cartesian3 | null = null // where the shafts are faded from (the aircraft at the last look); none: not faded
  #f = 1 // the factor and relH the shafts are placed for: the true relief until the first frame()
  #relHM = 0
  #night = 0 // the night their colour is written for, in steps
  #destroyed = false

  constructor(primitives: PrimitiveCollection, opts: RainShaftsOptions = {}) {
    this.#primitives = primitives
    this.#image = opts.image ?? shaftCanvas
    this.#geoid = opts.geoid ?? geoidN
    primitives.add(this.#coll)
  }

  get show(): boolean {
    return !this.#destroyed && this.#coll.show
  }

  set show(on: boolean) {
    if (!this.#destroyed) this.#coll.show = on
  }

  /** The shafts drawn. */
  get count(): number {
    return this.#bbs.length
  }

  /** These shafts in place of those drawn before. */
  draw(shafts: readonly RainShaft[]): void {
    if (this.#destroyed) return
    this.#coll.removeAll()
    const at = new Float64Array(shafts.length * STRIDE)
    for (let i = 0; i < shafts.length; i++) {
      const s = shafts[i]
      const n = this.#geoid(s.lat, s.lon)
      const length = lengthOf(s.baseM, s.groundM)
      const p = Cartesian3.fromDegrees(s.lon, s.lat, s.groundM + length / 2 + n, Ellipsoid.WGS84, scratch)
      const k = i * STRIDE
      at[k] = p.x
      at[k + 1] = p.y
      at[k + 2] = p.z
      const up = Ellipsoid.WGS84.geodeticSurfaceNormal(p, scratch)
      at[k + 3] = up.x
      at[k + 4] = up.y
      at[k + 5] = up.z
      at[k + 6] = s.groundM + n
    }
    this.#at = at
    this.#shafts = shafts
    this.#fade = new Float64Array(shafts.length)
    this.#bbs = shafts.map((s, i) => {
      const a = (this.#fade[i] = this.#fadeAt(i))
      const k = i * STRIDE
      const b = this.#coll.add({
        position: this.#placed(i), show: a > 0, sizeInMeters: true, alignedAxis: new Cartesian3(at[k + 3], at[k + 4], at[k + 5]), width: s.widthM,
        height: lengthOf(s.baseM, s.groundM), color: this.#colour(i, a), verticalOrigin: VerticalOrigin.CENTER,
      })
      b.setImage(SHAFT_ID, this.#image)
      return b
    })
  }

  /** Each look: every shaft faded by its distance from `from` (the aircraft), written only when it has changed by a step. */
  fade(from: Cartesian3): void {
    if (this.#destroyed) return
    this.#from = Cartesian3.clone(from, this.#from ?? new Cartesian3())
    for (let i = 0; i < this.#bbs.length; i++) {
      const a = this.#fadeAt(i)
      if (a === this.#fade[i]) continue
      this.#fade[i] = a
      this.#bbs[i].color = this.#colour(i, a)
      this.#bbs[i].show = a > 0
    }
  }

  /** Every frame: the shafts moved with the relief drawn when its factor or plane changed, darkened or lightened when the night did. */
  frame(tf: TerrainFrame, night: number): void {
    if (this.#destroyed) return
    if ((tf.fNow !== this.#f || tf.relHM !== this.#relHM) && Number.isFinite(tf.fNow) && Number.isFinite(tf.relHM)) {
      this.#f = tf.fNow
      this.#relHM = tf.relHM
      for (let i = 0; i < this.#bbs.length; i++) this.#bbs[i].position = this.#placed(i) // the setter copies it
    }
    const q = Number.isFinite(night) ? Math.round(Math.min(1, Math.max(0, night)) / NIGHT_STEP) * NIGHT_STEP : 0
    if (q !== this.#night) {
      this.#night = q
      for (let i = 0; i < this.#bbs.length; i++) this.#bbs[i].color = this.#colour(i, this.#fade[i])
    }
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#bbs = []
    this.#primitives.remove(this.#coll) // and destroys it
  }

  /** Shaft i's colour for its fade and the night: white by day (the image is its colour), dim by night, its own opacity times the fade (the module's scratch: read it at once). */
  #colour(i: number, fade: number): Color {
    const b = sunBrightness(this.#night)
    tint.red = tint.green = tint.blue = b
    tint.alpha = this.#shafts[i].alpha * fade
    return tint
  }

  /** How much of shaft i shows from where it is faded from, in steps (all of it before any fade). */
  #fadeAt(i: number): number {
    const from = this.#from
    if (from === null) return 1
    const a = this.#at
    const k = i * STRIDE
    const km = Math.hypot(a[k] - from.x, a[k + 1] - from.y, a[k + 2] - from.z) / 1000
    return Math.round(fadeAlpha(this.#shafts[i], km) / FADE_STEP) * FADE_STEP
  }

  /** Shaft i where it is drawn: its true place moved along up by as much as its ground is moved (scratch: read it at once). */
  #placed(i: number): Cartesian3 {
    const a = this.#at
    const k = i * STRIDE
    const g = a[k + 6]
    const shift = drawnHeightM(g, this.#f, this.#relHM) - g
    scratch.x = a[k] + a[k + 3] * shift
    scratch.y = a[k + 1] + a[k + 4] * shift
    scratch.z = a[k + 2] + a[k + 5] * shift
    return scratch
  }
}

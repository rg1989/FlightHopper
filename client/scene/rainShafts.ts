// client/scene/rainShafts.ts
// Rain falling out of the chase's heavy rain clouds, as the radar shows it (cloudField.ts radarClouds draws the clouds): a
// shaft of grey streaks from each cloud's base to the ground under a block of 35 dBZ or more of rain (never snow), 2 to 4 km
// wide (each a little wider or narrower, and more or less opaque, than the next), more opaque the heavier, at most 40 within the
// radius the clouds fade out by, the nearest, and the ring beyond it on top, hidden until the aircraft comes. Where the rain is
// one continuous region the shafts stand farther apart and each is wider until they fit (radarCells.ts thin), so they are
// spread over it, not all round the nearest block.
// A shaft is one Cesium Billboard in one BillboardCollection (one draw call): sized in metres, aligned to the local up, so it
// turns only about the vertical to face the camera, and its middle half way between its top and the ground. It hangs from the
// cloud: its top is where the drawn bottom of a tower of its echo stands (cloudField.ts towerRiseM; a puff's lump shows well
// above the base the cloud is placed by) and RADAR_LOOK.shaft.overlapM above that, inside the cloud, which is drawn over it.
// The image is made once for each of a few variants (shaftPixels, shaftCanvas): no edge to see anywhere, alpha falling off
// smoothly from the middle to the sides (whose reach wanders down the shaft), a top that feathers in raggedly, a foot that
// dissolves, thin streaks (light and dark) all through it, and mottling; each shaft draws one variant, so shafts side by side
// do not repeat each other.
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
import { RADAR_LOOK, between, fadeAlpha, farKmOf, lerp, ramp, sequence, sunBrightness, towerRiseM, type BaseOf } from './cloudField.ts'
import { drawnHeightM } from './exaggeration.ts'
import { thin, type RadarCell } from './radarCells.ts'

export const SHAFT_ID = 'fh-rain-shaft' // an image's id in the collection's atlas is this and its variant: one copy for every billboard that draws it
const MIN_LENGTH_M = 100 // a shaft is at least this tall (a ceiling just over the ground)
const NIGHT_STEP = 0.02 // the colour is written again when the night has changed by this
const FADE_STEP = 0.05 // a shaft's fade is written again when it has changed by this
const STRIDE = 7 // per shaft in #at: its middle at its true height (x, y, z), the ellipsoid's up there (x, y, z), its ground above the ellipsoid
const SALT = 0x5bd1e995 // a shaft's variant, width and opacity are drawn from its cell's seed mixed with this, apart from the clouds' draws from the seed itself

/**
 * The image's look (applies when it is drawn, so after a reload). Its pixels. The veil: its colour (rgb) and opacity. The streaks:
 * how many; light and dark (rgb) and the share that is light; their length (of the height), width (pixels) and opacity. The
 * sides: the half width the shaft reaches (of the image), how far that wanders down it, how much it narrows toward the foot. The
 * top: how far down it takes to feather in, and how much longer than that it wanders along the width; the foot: where it starts
 * to dissolve (of the height) and how far that wanders. How much lighter the foot is than the top; the mottling of the veil, the grain.
 */
const IMAGE = {
  w: 128, h: 256, seed: 23, veil: [118, 130, 150] as const, veilAlpha: 0.62,
  streaks: 30, light: [224, 232, 246] as const, dark: [70, 82, 100] as const, lightShare: 0.6, length: [0.35, 0.95] as const, width: [1.2, 3.2] as const, alpha: [0.3, 0.75] as const,
  side: 0.8, wander: 0.16, narrowing: 0.12, top: [0.1, 0.16] as const, foot: [0.55, 0.12] as const, lighter: 0.3, mottle: 0.3, grain: 0.06,
}

/** One shaft of rain: where it falls, from the base of its cloud (an estimate) down to the ground, how far up into the cloud it reaches, how wide, how opaque, and which image it draws. */
export interface RainShaft {
  lon: number
  lat: number
  baseM: number // the cloud's base, metres above sea level
  topM: number // where it ends, inside the cloud, over the drawn bottom of the cloud (towerRiseM)
  groundM: number
  widthM: number
  alpha: number // 0–1
  variant: number // the image, 0 … RADAR_LOOK.shaft.variants − 1
  farKm: number // where it has faded out, km from the aircraft
}

/** A shaft's length: from the ground up to its top. */
const lengthOf = (s: Pick<RainShaft, 'topM' | 'groundM'>): number => Math.max(MIN_LENGTH_M, s.topM - s.groundM)

/**
 * The shafts under the radar's cells: a shaft for each rain block of RADAR_LOOK.shaft.dbz and more, the strongest kept apart
 * (at most RADAR_LOOK.shaft.max within RADAR_LOOK.radiusKm, the nearest, and the ring beyond it on top; wider where they were
 * thinned), on the base and the ground of its place (base), hung from where a tower of its echo is drawn to. Each has a width, an
 * opacity and an image of its own, drawn from its cell's seed: the same cell, the same shaft, wherever the aircraft is.
 */
export function pickShafts(cells: readonly RadarCell[], base: BaseOf): RainShaft[] {
  const S = RADAR_LOOK.shaft
  const width = (c: RadarCell): number => lerp(S.width, ramp(c.dbz, S.dbz, RADAR_LOOK.fullDbz))
  const rain = cells.filter((c) => !c.snow && c.dbz >= S.dbz)
  const { kept, m } = thin(rain, (c) => (S.spacing * width(c)) / 1000, S.max, RADAR_LOOK.grow, RADAR_LOOK.radiusKm)
  const variants = Math.max(1, Math.floor(S.variants))
  return kept.map((c) => {
    const b = base(c.lat, c.lon)
    const r = sequence((c.seed ^ SALT) >>> 0)
    const variant = Math.min(variants - 1, Math.floor(r() * variants))
    const widthM = width(c) * m * (1 + S.widthJitter * (2 * r() - 1))
    const alpha = Math.min(1, lerp(S.alpha, ramp(c.dbz, S.dbz, RADAR_LOOK.fullDbz)) * (1 + S.alphaJitter * (2 * r() - 1)))
    const topM = b.baseM + towerRiseM(c.dbz) + S.overlapM
    return {
      lon: c.lon, lat: c.lat, baseM: b.baseM, topM, groundM: b.groundM, widthM, alpha, variant,
      farKm: Math.min(RADAR_LOOK.radiusKm, farKmOf(Math.max(widthM, lengthOf({ topM, groundM: b.groundM })))),
    }
  })
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Smooth noise, 0 … 1, along x from 0 to n: a random value at each whole number, eased between them. */
function wave(r: () => number, n: number): (x: number) => number {
  const v = Array.from({ length: n + 2 }, () => r())
  return (x) => {
    const i = Math.min(n, Math.floor(x))
    const f = smooth(0, 1, x - i)
    return v[i] + (v[i + 1] - v[i]) * f
  }
}

/** Smooth noise, 0 … 1, over x from 0 to gx and y from 0 to gy, the same way. */
function blot(r: () => number, gx: number, gy: number): (x: number, y: number) => number {
  const v = Array.from({ length: (gx + 2) * (gy + 2) }, () => r())
  const at = (i: number, j: number): number => v[j * (gx + 2) + i]
  return (x, y) => {
    const [i, j] = [Math.min(gx, Math.floor(x)), Math.min(gy, Math.floor(y))]
    const [fx, fy] = [smooth(0, 1, x - i), smooth(0, 1, y - j)]
    const top = at(i, j) + (at(i + 1, j) - at(i, j)) * fx
    const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * fx
    return top + (bottom - top) * fy
  }
}

/** A variant's look, drawn from its own sequence: its envelope (0 … 1 at u across and v down, each 0 … 1), its mottling, its streaks, and the sequence for the grain. */
function lookOf(variant: number) {
  const { w } = IMAGE
  const r = sequence((IMAGE.seed + 7919 * Math.trunc(variant)) >>> 0)
  const [leftSide, rightSide, topEdge, footEdge, coarse, fine] = [wave(r, 4), wave(r, 4), wave(r, 6), wave(r, 5), blot(r, 5, 12), blot(r, 12, 30)]
  const streaks = Array.from({ length: IMAGE.streaks }, () => {
    const cx = 0.5 + (r() + r() - 1) * 0.45 // more of them near the middle
    const [sigma, y0, len, a] = [between(r, IMAGE.width) / w, r() * 0.4, between(r, IMAGE.length), between(r, IMAGE.alpha)]
    return { cx, sigma, y0, y1: y0 + len, a, rgb: r() < IMAGE.lightShare ? IMAGE.light : IMAGE.dark }
  })
  const envelope = (u: number, v: number): number => {
    const reach = (IMAGE.side + IMAGE.wander * 2 * ((u < 0.5 ? leftSide(v * 4) : rightSide(v * 4)) - 0.5)) * (1 - IMAGE.narrowing * v)
    const s = Math.abs(2 * u - 1) / reach
    const across = s >= 1 ? 0 : (1 - s * s) ** 2 // 1 in the middle, 0 at the reach with no step: a slope of 0 there too
    const along = smooth(0, IMAGE.top[0] + IMAGE.top[1] * topEdge(u * 6), v) * (1 - smooth(IMAGE.foot[0] + IMAGE.foot[1] * footEdge(u * 5), 1, v)) * (1 - IMAGE.lighter * v)
    return across * along
  }
  const mottle = (u: number, v: number): number => 1 - IMAGE.mottle * (1 - (0.65 * coarse(u * 5, v * 12) + 0.35 * fine(u * 12, v * 30)))
  return { r, envelope, mottle, streaks }
}

/** A variant's envelope: how much of the veil and the streaks shows at each pixel, 0 … 1, row by row (the pixels' own shape, before the veil's mottling and the streaks). */
export function shaftEnvelope(variant: number): Float32Array {
  const { w, h } = IMAGE
  const { envelope } = lookOf(variant)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = envelope((x + 0.5) / w, (y + 0.5) / h)
  return out
}

/**
 * One image of rain, IMAGE.w × IMAGE.h pixels of RGBA, not premultiplied; the same for the same variant, another look for another.
 * A veil of grey, mottled, with thin streaks (light and dark, soft at their sides and ends) over it; all of it taken to nothing
 * by the envelope: 1 in the middle, falling smoothly (no step anywhere) to 0 at the sides, which wander down the shaft and narrow
 * toward the foot, at the top, which feathers in raggedly along its width, and at the foot, which dissolves. The pixels at its
 * edges are clear.
 */
export function shaftPixels(variant: number): Uint8ClampedArray {
  const { w, h } = IMAGE
  const { r, envelope, mottle, streaks } = lookOf(variant)
  const env = new Float32Array(w * h)
  const [pr, pg, pb, pa] = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)] // premultiplied colour and alpha
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h
    for (let x = 0; x < w; x++) {
      const [u, k] = [(x + 0.5) / w, y * w + x]
      const e = (env[k] = envelope(u, v))
      const a = IMAGE.veilAlpha * e * mottle(u, v) * (1 + IMAGE.grain * (2 * r() - 1))
      pr[k] = IMAGE.veil[0] * a
      pg[k] = IMAGE.veil[1] * a
      pb[k] = IMAGE.veil[2] * a
      pa[k] = a
    }
  }
  for (const st of streaks) {
    const [reach, len] = [Math.ceil(3 * st.sigma * w), st.y1 - st.y0]
    for (let y = Math.max(0, Math.floor(st.y0 * h)); y < Math.min(h, Math.ceil(st.y1 * h)); y++) {
      const v = (y + 0.5) / h
      const along = smooth(st.y0, st.y0 + 0.3 * len, v) * (1 - smooth(st.y1 - 0.25 * len, st.y1, v))
      for (let x = Math.max(0, Math.floor(st.cx * w) - reach); x <= Math.min(w - 1, Math.floor(st.cx * w) + reach); x++) {
        const k = y * w + x
        const d = ((x + 0.5) / w - st.cx) / st.sigma
        const a = st.a * Math.exp(-d * d) * along * env[k]
        pr[k] = st.rgb[0] * a + pr[k] * (1 - a)
        pg[k] = st.rgb[1] * a + pg[k] * (1 - a)
        pb[k] = st.rgb[2] * a + pb[k] * (1 - a)
        pa[k] = a + pa[k] * (1 - a)
      }
    }
  }
  const out = new Uint8ClampedArray(w * h * 4)
  for (let k = 0; k < w * h; k++) {
    const a = pa[k]
    out[4 * k] = a > 0 ? pr[k] / a : IMAGE.veil[0]
    out[4 * k + 1] = a > 0 ? pg[k] / a : IMAGE.veil[1]
    out[4 * k + 2] = a > 0 ? pb[k] / a : IMAGE.veil[2]
    out[4 * k + 3] = Math.round(a * 255)
  }
  return out
}

const drawn = new Map<number, HTMLCanvasElement>()

/** A variant's image on a canvas, drawn once. */
export function shaftCanvas(variant = 0): HTMLCanvasElement {
  const kept = drawn.get(variant)
  if (kept !== undefined) return kept
  const { w, h } = IMAGE
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  const img = g.createImageData(w, h)
  img.data.set(shaftPixels(variant))
  g.putImageData(img, 0, 0)
  drawn.set(variant, c)
  return c
}

const scratch = new Cartesian3()
const tint = new Color()

export interface RainShaftsOptions {
  image?: (variant: number) => HTMLCanvasElement // a variant's image, made once for the shafts that draw it: default shaftCanvas
  geoid?: (lat: number, lon: number) => number
}

/** The shafts drawn: one billboard each (draw replaces them all); frame() every frame and fade() at each look write only what changed. */
export class RainShafts {
  readonly #primitives: PrimitiveCollection
  readonly #coll = new BillboardCollection({ show: false, blendOption: BlendOption.TRANSLUCENT })
  readonly #image: (variant: number) => HTMLCanvasElement
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
      const length = lengthOf(s)
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
        height: lengthOf(s), color: this.#colour(i, a), verticalOrigin: VerticalOrigin.CENTER,
      })
      b.setImage(`${SHAFT_ID}-${s.variant}`, () => this.#image(s.variant))
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

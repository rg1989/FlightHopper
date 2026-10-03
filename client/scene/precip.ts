// client/scene/precip.ts
// Rain or snow round the camera in the chase, while the camera is under the cloud it falls from. Weather3D decides at its
// once-a-second look what falls and how hard: the radar under the camera (RainViewer's newest frame, its decoded zoom-7
// tile: 15 dBZ and up, its own snow flag), else the nearest station's present weather within 30 km (-RA light, RA moderate,
// +RA or a thunderstorm with rain heavy; snow for SN, but not snow blown or drifting off the ground), and only below that
// station's cloud base + 300 m (3 km above the ground when no base is known).
// Precipitation draws it as a light screen overlay on the 3-D view, under the place names: a texture of thin streaks or
// soft flakes, drawn once on a canvas, in layers that fall at their own speeds, the near ones larger and faster; snow slower,
// swaying sideways. CSS moves the layers (transforms only: the compositor's work, no script per frame; layout.css). The
// script sets each layer's texture, size, speed and opacity (OVERLAY: the look constants), the overlay's opacity by the
// intensity, and a few times a second the lean of the fall with the station's surface wind across the camera's view. Over
// the canvas, it is not washed out by the ground fog. Reduced motion: a faint still texture.
import { distanceNm } from '../../shared/geo.ts'
import type { Metar } from '../../shared/wx.ts'
import { sequence } from './cloudField.ts'
import { FIRST_DBZ, NONE, RADAR_SRC_MAX, type SourceTile } from './radar.ts'
import { wrapLon } from './wxGeo.ts'

const FT = 0.3048
const KT = 0.514444 // m/s
export const STATION_KM = 30 // the station whose weather and wind are taken, at most this far
const RAIN_FULL_DBZ = 45 // heavy rain from here (Marshall–Palmer: about 24 mm/h)
const SNOW_FULL_DBZ = 35 // snow reflects less: heavy from here
const STRENGTH = { '-': 0.25, '': 0.55, '+': 1 } as const // light, moderate, heavy
const DRIZZLE = 0.5 // drizzle as rain this much lighter
const SNOW_CODES = new Set(['SN', 'SG', 'IC'])
const RAIN_CODES = new Set(['RA', 'DZ', 'PL', 'GR', 'GS', 'UP'])
const DESCRIPTORS = /^(?:MI|PR|BC|SH|TS|FZ)/

export type PrecipKind = 'rain' | 'snow'
/** What falls and how hard: intensity 0 (15 dBZ, a light shower) … 1 (heavy). */
export interface Precip {
  kind: PrecipKind
  intensity: number
}

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0)

/** What a radar echo of dbz brings: rain from 15 dBZ, heavy at 45; snow (RainViewer's own flag) heavy at 35. Null: nothing. */
export function precipFromDbz(dbz: number, snow: boolean): Precip | null {
  if (!(dbz >= FIRST_DBZ)) return null
  return { kind: snow ? 'snow' : 'rain', intensity: clamp01((dbz - FIRST_DBZ) / ((snow ? SNOW_FULL_DBZ : RAIN_FULL_DBZ) - FIRST_DBZ)) }
}

/**
 * What a report's present weather says falls at the station (not nearby, VC, nor recent, RE, nor blown or drifting off the
 * ground, BL and DR): by its strength (-, none, +), heavy in a thunderstorm with anything falling; snow when snow is in the
 * group (rain and snow: the flakes show); drizzle lighter than rain. The strongest group wins. Null: nothing falls.
 */
export function precipFromWx(wx: string | null): Precip | null {
  let best: Precip | null = null
  for (const tok of (wx ?? '').split(' ')) {
    const sign = tok[0] === '-' || tok[0] === '+' ? tok[0] : ''
    let t = tok.slice(sign.length)
    if (/^(?:VC|RE|BL|DR)/.test(t)) continue
    const storm = t.startsWith('TS')
    if (DESCRIPTORS.test(t)) t = t.slice(2)
    const codes: string[] = []
    for (let i = 0; i + 2 <= t.length; i += 2) codes.push(t.slice(i, i + 2))
    const snow = codes.some((c) => SNOW_CODES.has(c))
    if (!snow && !codes.some((c) => RAIN_CODES.has(c))) continue
    const drizzle = codes.every((c) => c === 'DZ' || !RAIN_CODES.has(c)) && !snow
    const intensity = storm ? 1 : STRENGTH[sign] * (drizzle ? DRIZZLE : 1)
    if (best === null || intensity > best.intensity) best = { kind: snow ? 'snow' : 'rain', intensity }
  }
  return best
}

/** The radar's deepest (zoom 7) tile under a place and the pixel in it (Web Mercator, north row first; 180° is −180°). */
export function radarPixel(lat: number, lon: number): { x: number; y: number; px: number; py: number } {
  const n = 256 * 2 ** RADAR_SRC_MAX
  const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180
  const ix = ((Math.floor(((wrapLon(lon) + 180) / 360) * n) % n) + n) % n
  const iy = Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)))
  return { x: ix >> 8, y: iy >> 8, px: ix & 255, py: iy & 255 }
}

/** The strongest echo among the 3 × 3 pixels round px, py that are in the tile, and whether it is snow; null: no echo. */
export function radarSample(tile: SourceTile, px: number, py: number): { dbz: number; snow: boolean } | null {
  let best = -1
  for (let y = Math.max(0, py - 1); y <= Math.min(255, py + 1); y++) {
    for (let x = Math.max(0, px - 1); x <= Math.min(255, px + 1); x++) {
      const i = y * 256 + x
      if (tile.dbz[i] !== NONE && (best < 0 || tile.dbz[i] > tile.dbz[best])) best = i
    }
  }
  return best < 0 ? null : { dbz: tile.dbz[best], snow: tile.snow[best] !== 0 }
}

/** The nearest report within 30 km of a place; null: none. */
export function nearestStation(metars: readonly Metar[], lat: number, lon: number, maxKm = STATION_KM): Metar | null {
  let best: Metar | null = null
  let bestKm = maxKm
  for (const m of metars) {
    const km = distanceNm(lat, lon, m.lat, m.lon) * 1.852
    if (km <= bestKm) [best, bestKm] = [m, km]
  }
  return best
}

/** The cloud base rain falls from, metres above sea level: the lowest broken, overcast or hidden-sky base, else the lowest layer's; null: no layer (or no station height). */
export function cloudBaseM(m: Metar): number | null {
  if (m.elevM === null) return null
  const lowest = (covers: readonly string[]): number | null => {
    const bases = m.clouds.filter((c) => covers.includes(c.cover) && c.baseFt !== null).map((c) => c.baseFt!)
    return bases.length === 0 ? null : Math.min(...bases)
  }
  const ft = lowest(['BKN', 'OVC', 'VV', 'OVX']) ?? lowest(['FEW', 'SCT'])
  return ft === null ? null : m.elevM + ft * FT
}

/** The station's surface wind as it blows (towards), m/s east and north; none when calm, variable or unknown. */
export function windOf(m: Metar | null): { east: number; north: number } {
  if (m === null || m.wdir === null || !(m.wspd >= 1)) return { east: 0, north: 0 }
  const v = m.wspd * KT
  const a = (m.wdir * Math.PI) / 180
  return { east: -v * Math.sin(a), north: -v * Math.cos(a) }
}

type Range = readonly [number, number]
interface OverlayLayer {
  scale: number // the texture's size on screen, times its own
  fallS: number // seconds to fall one tile
  alpha: number
  swayPx: number // sideways each way (snow), px; 0: none
  swayS: number // seconds a sway
}
interface Overlay {
  tile: readonly [number, number] // the texture's width and height, px
  marks: number // streaks or flakes in it
  layers: readonly OverlayLayer[] // near (large, fast) to far (small, slow, faint)
  opacity: readonly [number, number] // the overlay's at intensity 0 and 1
  fallMs: number // how fast it falls, for its lean in the wind
  maxTiltDeg: number // it leans no more than this
}

/** The look constants of the overlay, tuned by eye. */
export const OVERLAY: Readonly<Record<PrecipKind, Overlay>> = {
  rain: {
    tile: [128, 256], marks: 40, fallMs: 8, maxTiltDeg: 30, opacity: [0.35, 0.9],
    layers: [
      { scale: 1.6, fallS: 0.3, alpha: 0.65, swayPx: 0, swayS: 0 },
      { scale: 1, fallS: 0.42, alpha: 0.5, swayPx: 0, swayS: 0 },
      { scale: 0.6, fallS: 0.6, alpha: 0.35, swayPx: 0, swayS: 0 },
    ],
  },
  snow: {
    tile: [256, 256], marks: 46, fallMs: 1.2, maxTiltDeg: 50, opacity: [0.45, 1],
    layers: [
      { scale: 1.5, fallS: 7, alpha: 0.9, swayPx: 36, swayS: 4.5 },
      { scale: 1, fallS: 10, alpha: 0.75, swayPx: 24, swayS: 6 },
      { scale: 0.6, fallS: 14, alpha: 0.55, swayPx: 14, swayS: 8 },
    ],
  },
}
const NIGHT_DIM = 0.6 // the overlay loses this share of its opacity at full night
const STREAK = { len: [14, 34] as Range, alpha: [0.45, 0.9] as Range, width: [1, 1.6] as Range, rgb: '214, 224, 240' } // in the rain texture, px
const FLAKE = { r: [1.2, 3.4] as Range, alpha: [0.6, 1] as Range } // in the snow texture, px

/** What falls, the surface wind it drifts with (m/s, as it blows) and the Sun's night (0 day … 1 night) it is seen by. */
export interface Fall extends Precip {
  wind: { east: number; north: number }
  night: number
}

/** The overlay's opacity: by intensity, from the kind's faint to its full; dimmer by night. */
export function overlayOpacity(f: Fall): number {
  const [lo, hi] = OVERLAY[f.kind].opacity
  return (lo + (hi - lo) * clamp01(f.intensity)) * (1 - NIGHT_DIM * clamp01(f.night))
}

/**
 * The fall's lean for the wind across a camera looking along headingRad (clockwise from north): a CSS rotation in
 * degrees, negative turning the layers so the drops go right; as far as the wind over the fall speed says, at most the
 * kind's most.
 */
export function tiltDeg(kind: PrecipKind, wind: { east: number; north: number }, headingRad: number): number {
  const look = OVERLAY[kind]
  const across = wind.east * Math.cos(headingRad) - wind.north * Math.sin(headingRad) // to the camera's right
  const deg = (Math.atan2(across, look.fallMs) * 180) / Math.PI
  return 0 - Math.max(-look.maxTiltDeg, Math.min(look.maxTiltDeg, deg)) // 0 −: never −0
}

/** The width and height a layer turned by deg must span to cover a w × h view, px. */
export function coverSize(w: number, h: number, deg: number): [number, number] {
  const a = (Math.abs(deg) * Math.PI) / 180
  const [c, s] = [Math.cos(a), Math.sin(a)]
  return [Math.ceil(w * c + h * s) + 2, Math.ceil(w * s + h * c) + 2]
}

const between = (r: () => number, [lo, hi]: Range): number => lo + (hi - lo) * r()

// The textures as data URLs, drawn once: CSS backgrounds.
const textures: Partial<Record<PrecipKind, string>> = {}
/** The overlay's texture: thin streaks, fading in from their tops, for rain; soft flakes for snow; each drawn across the tile's edges too, so it repeats seamlessly. */
function textureOf(kind: PrecipKind): string {
  const done = textures[kind]
  if (done !== undefined) return done
  const look = OVERLAY[kind]
  const [w, h] = look.tile
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  const r = sequence(kind === 'rain' ? 7 : 11) // the same texture every time
  for (let i = 0; i < look.marks; i++) {
    if (kind === 'rain') {
      const [x, y, len, a, lw] = [r() * (w - 2), r() * h, between(r, STREAK.len), between(r, STREAK.alpha), between(r, STREAK.width)]
      for (const dy of [0, -h]) {
        const grad = g.createLinearGradient(0, y + dy, 0, y + dy + len)
        grad.addColorStop(0, `rgba(${STREAK.rgb}, 0)`)
        grad.addColorStop(1, `rgba(${STREAK.rgb}, ${a})`)
        g.fillStyle = grad
        g.fillRect(x, y + dy, lw, len)
      }
    } else {
      const [x, y, rr, a] = [r() * w, r() * h, between(r, FLAKE.r), between(r, FLAKE.alpha)]
      for (const dx of [-w, 0, w]) {
        for (const dy of [-h, 0, h]) {
          const grad = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rr)
          grad.addColorStop(0, `rgba(255, 255, 255, ${a})`)
          grad.addColorStop(1, 'rgba(255, 255, 255, 0)')
          g.fillStyle = grad
          g.beginPath()
          g.arc(x + dx, y + dy, rr, 0, 2 * Math.PI)
          g.fill()
        }
      }
    }
  }
  return (textures[kind] = c.toDataURL('image/png'))
}

export interface PrecipitationOptions {
  image?: (kind: PrecipKind) => string // the texture's URL; default drawn once on a canvas
}

/**
 * The overlay (set what falls; null: nothing, hidden). In parent (the globe's element): .fh-precip > .fh-precip-tilt (turned
 * by --tilt, sized to cover the view) > a .fh-precip-sway per layer > its .fh-precip-layer. Another kind builds the layers
 * anew; the same kind harder or lighter changes only the opacity.
 */
export class Precipitation {
  readonly #parent: HTMLElement
  readonly #el: HTMLElement
  readonly #tilt: HTMLElement
  readonly #image: (kind: PrecipKind) => string
  #kind: PrecipKind | null = null // the layers built for
  #fall: Fall | null = null
  #deg: number | null = null // the lean written, and the view it was sized for
  #w = -1
  #h = -1
  #destroyed = false

  constructor(parent: HTMLElement, opts: PrecipitationOptions = {}) {
    this.#parent = parent
    this.#image = opts.image ?? textureOf
    const doc = parent.ownerDocument
    this.#el = doc.createElement('div')
    this.#el.className = 'fh-precip'
    this.#el.hidden = true
    this.#tilt = doc.createElement('div')
    this.#tilt.className = 'fh-precip-tilt'
    this.#el.append(this.#tilt)
    parent.append(this.#el)
  }

  set(f: Fall | null): void {
    if (this.#destroyed) return
    this.#fall = f
    if (f === null) {
      this.#el.hidden = true
      return
    }
    if (f.kind !== this.#kind) this.#build(f.kind)
    this.#el.style.setProperty('opacity', String(overlayOpacity(f)))
    this.#el.hidden = false
  }

  /** A few times a second while something falls: the lean for a camera looking along headingRad (radians clockwise from north), written on a change of a whole degree or of the view's size. */
  aim(headingRad: number): void {
    const f = this.#fall
    if (this.#destroyed || f === null) return
    const deg = Math.round(tiltDeg(f.kind, f.wind, headingRad))
    const w = this.#parent.clientWidth
    const h = this.#parent.clientHeight
    if (deg === this.#deg && w === this.#w && h === this.#h) return
    this.#deg = deg
    this.#w = w
    this.#h = h
    const [cw, ch] = coverSize(w, h, deg)
    const s = this.#tilt.style
    s.setProperty('--tilt', `${deg}deg`)
    s.setProperty('width', `${cw}px`)
    s.setProperty('height', `${ch}px`)
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#el.remove()
  }

  #build(kind: PrecipKind): void {
    this.#kind = kind
    this.#el.dataset.kind = kind
    const look = OVERLAY[kind]
    const url = this.#image(kind)
    const doc = this.#parent.ownerDocument
    this.#tilt.replaceChildren(...look.layers.map((l) => {
      const sway = doc.createElement('div')
      sway.className = 'fh-precip-sway'
      if (l.swayPx > 0) {
        sway.style.setProperty('--sway', `${l.swayPx}px`)
        sway.style.setProperty('--sway-s', `${l.swayS}s`)
      } else sway.style.setProperty('animation-name', 'none')
      const layer = doc.createElement('div')
      layer.className = 'fh-precip-layer'
      const [tw, th] = [look.tile[0] * l.scale, look.tile[1] * l.scale]
      layer.style.setProperty('background-image', `url("${url}")`)
      layer.style.setProperty('background-size', `${tw}px ${th}px`)
      layer.style.setProperty('--fall', `${th}px`)
      layer.style.setProperty('--fall-s', `${l.fallS}s`)
      layer.style.setProperty('opacity', String(l.alpha))
      sway.append(layer)
      return sway
    }))
  }
}

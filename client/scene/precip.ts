// client/scene/precip.ts
// Rain or snow round the camera in the chase, while the camera is under the cloud it falls from. Weather3D decides at its
// once-a-second look what falls and how hard: the radar under the camera (RainViewer's newest frame, its decoded zoom-7
// tile: 15 dBZ and up, its own snow flag), else the nearest station's present weather within 30 km (-RA light, RA moderate,
// +RA or a thunderstorm with rain heavy; snow for SN), and only below that station's cloud base + 300 m (3 km above the
// ground when no base is known). Precipitation draws it: Cesium particles in the air round the camera, falling at their
// terminal speed and drifting with the station's surface wind: rain as streaks, 1,200 to 3,000 of them by intensity;
// snow as soft flakes, slower, 800 to 2,400. Each frame the particles are emitted round where the camera is now, so they
// stay round it; each lives a second or a few, so those left behind go.
// The particles keep time by the wall clock (the scene's clock is the sun's: a fixed ?sun= would stand them still), in
// steps of at most 0.1 s, so a frame after a stall emits no flood of them.
// ponytail: Cesium's ParticleSystem moves every particle and rewrites its billboard each frame, on the main thread (3,000
// at most). Upgrade: a rain box drawn by the GPU, each drop's place worked out from the time in the vertex shader.
import { Cartesian2, Cartesian3, Color, Ellipsoid, JulianDate, Matrix4, ParticleSystem, type Particle, type PrimitiveCollection } from 'cesium'
import { distanceNm } from '../../shared/geo.ts'
import type { Metar } from '../../shared/wx.ts'
import { FIRST_DBZ, RADAR_SRC_MAX, type SourceTile } from './radar.ts'
import { wrapLon } from './wxGeo.ts'

const FT = 0.3048
const KT = 0.514444 // m/s
export const STATION_KM = 30 // the station whose weather and wind are taken, at most this far
const RAIN_FULL_DBZ = 45 // heavy rain from here (Marshall–Palmer: about 24 mm/h)
const SNOW_FULL_DBZ = 35 // snow reflects less: heavy from here
const NONE = -128 // a decoded tile's "no echo" (radar.ts)
const STRENGTH = { '-': 0.25, '': 0.55, '+': 1 } as const // light, moderate, heavy
const DRIZZLE = 0.5 // drizzle as rain this much lighter
const SNOW_CODES = new Set(['SN', 'SG', 'IC'])
const RAIN_CODES = new Set(['RA', 'DZ', 'PL', 'GR', 'GS', 'UP'])
const DESCRIPTORS = /^(?:MI|PR|BC|DR|BL|SH|TS|FZ)/

export type PrecipKind = 'rain' | 'snow'
/** What falls and how hard: intensity 0 (15 dBZ, a light shower) … 1 (heavy). */
export interface Precip {
  kind: PrecipKind
  intensity: number
}

interface Look {
  count: readonly [number, number] // particles at intensity 0 and 1 (the plan's)
  fallMs: readonly [number, number] // terminal speed at intensity 0 and 1 (bigger drops fall faster)
  lifeS: number // each particle's
  radiusM: readonly [number, number] // they are emitted between these distances round the emitter
  aheadM: number // the emitter this far ahead of the camera (those behind it go unseen)
  sizeM: readonly [number, number] // each image's width and height in metres (rain: a streak drawn longer than a drop, its blur)
  color: readonly [number, number, number, number] // by day; dimmed by night
}

/** The look constants, tuned by eye: what each kind of precipitation draws. */
export const LOOKS: Readonly<Record<PrecipKind, Look>> = {
  rain: { count: [1200, 3000], fallMs: [7, 9], lifeS: 1.2, radiusM: [4, 120], aheadM: 60, sizeM: [0.08, 2], color: [0.75, 0.8, 0.88, 0.35] },
  snow: { count: [800, 2400], fallMs: [0.9, 1.5], lifeS: 4, radiusM: [4, 100], aheadM: 40, sizeM: [0.14, 0.14], color: [1, 1, 1, 0.85] },
}
const NIGHT_DIM = 0.8 // the particles' colour loses this share at full night

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0)

/** What a radar echo of dbz brings: rain from 15 dBZ, heavy at 45; snow (RainViewer's own flag) heavy at 35. Null: nothing. */
export function precipFromDbz(dbz: number, snow: boolean): Precip | null {
  if (!(dbz >= FIRST_DBZ)) return null
  return { kind: snow ? 'snow' : 'rain', intensity: clamp01((dbz - FIRST_DBZ) / ((snow ? SNOW_FULL_DBZ : RAIN_FULL_DBZ) - FIRST_DBZ)) }
}

/**
 * What a report's present weather says falls at the station (not nearby, VC, nor recent, RE): by its strength (-, none, +),
 * heavy in a thunderstorm with anything falling; snow when snow is in the group (rain and snow: the flakes show); drizzle
 * lighter than rain. The strongest group wins. Null: nothing falls.
 */
export function precipFromWx(wx: string | null): Precip | null {
  let best: Precip | null = null
  for (const tok of (wx ?? '').split(' ')) {
    const sign = tok[0] === '-' || tok[0] === '+' ? tok[0] : ''
    let t = tok.slice(sign.length)
    if (t.startsWith('VC') || t.startsWith('RE')) continue
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

/** How many particles: rain 1,200 to 3,000 by intensity, snow 800 to 2,400. */
export function particleCount(p: Precip): number {
  const [lo, hi] = LOOKS[p.kind].count
  return Math.round(lo + (hi - lo) * clamp01(p.intensity))
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

const MAX_STEP_S = 0.1 // the particles' clock moves at most this much a frame
const SPEED_SPREAD = 0.1 // each particle falls within this share of the kind's speed

/** A Cesium primitive's frame state, as much of it as this reads. */
interface Frame {
  camera: { positionWC: Cartesian3; directionWC: Cartesian3 }
  time: JulianDate
  passes: { render: boolean } // false: a pick or depth pass (Cesium updates the primitives for those too)
}

/** What Precipitation drives: a Cesium ParticleSystem (its update(frameState) is left out of Cesium's typings). */
export type Particles = Pick<ParticleSystem, 'show' | 'modelMatrix' | 'emissionRate' | 'minimumSpeed' | 'maximumSpeed' | 'startColor' | 'endColor' | 'destroy'> & {
  update(frameState: object): void
}
type ParticleOptions = NonNullable<ConstructorParameters<typeof ParticleSystem>[0]>

/** What falls, the surface wind it drifts with (m/s, as it blows) and the Sun's night (0 day … 1 night) it is lit by. */
export interface Fall extends Precip {
  wind: { east: number; north: number }
  night: number
}

export interface PrecipitationOptions {
  makeSystem?: (o: ParticleOptions) => Particles // default: a Cesium ParticleSystem
  image?: (kind: PrecipKind) => string // default: drawn once on a canvas
  now?: () => number // ms; default performance.now
  epoch?: JulianDate // where the particles' clock starts
}

/** Emits evenly through the shell between rMin and rMax round the emitter, each particle moving along dir (a unit vector, world axes). */
export class ShellEmitter {
  rMin = 1
  rMax = 2
  readonly dir = new Cartesian3(0, 0, -1)

  emit(particle: Particle): void {
    const z = 2 * Math.random() - 1
    const a = 2 * Math.PI * Math.random()
    const r = Math.cbrt(this.rMin ** 3 + Math.random() * (this.rMax ** 3 - this.rMin ** 3))
    const s = r * Math.sqrt(1 - z * z)
    particle.position = Cartesian3.fromElements(s * Math.cos(a), s * Math.sin(a), r * z, particle.position)
    particle.velocity = Cartesian3.clone(this.dir, particle.velocity)
  }
}

// Data URLs: Cesium's billboard atlas keeps one copy of an image named by its URL, where it would take a canvas once a particle.
const images: Partial<Record<PrecipKind, string>> = {}
/** A particle's image, drawn once: a soft vertical streak for rain, a soft round flake for snow; white, tinted by its colour. */
function imageOf(kind: PrecipKind): string {
  const done = images[kind]
  if (done !== undefined) return done
  const c = document.createElement('canvas')
  ;[c.width, c.height] = kind === 'rain' ? [4, 64] : [32, 32]
  const g = c.getContext('2d')!
  const grad = kind === 'rain' ? g.createLinearGradient(0, 0, 0, 64) : g.createRadialGradient(16, 16, 0, 16, 16, 16)
  if (kind === 'rain') {
    grad.addColorStop(0, 'rgba(255,255,255,0)')
    grad.addColorStop(0.5, 'rgba(255,255,255,1)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
  } else {
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.4, 'rgba(255,255,255,0.8)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
  }
  g.fillStyle = grad
  if (kind === 'rain') g.fillRect(1, 0, 2, 64) // clear edges each side: the streak stays soft when filtered
  else g.fillRect(0, 0, 32, 32)
  return (images[kind] = c.toDataURL('image/png'))
}

const scratch = new Cartesian3()
const scratchUp = new Cartesian3()
const scratchEast = new Cartesian3()
const scratchNorth = new Cartesian3()

/**
 * Rain or snow round the camera (set what falls; null: nothing, and nothing is updated). One primitive in the scene drives a
 * Cesium ParticleSystem on its own clock; another kind of precipitation is a new system, the same kind harder or lighter
 * the same system with another rate.
 */
export class Precipitation {
  readonly #primitives: PrimitiveCollection
  readonly #primitive = { update: (fs: Frame): void => this.#update(fs), isDestroyed: (): boolean => false, destroy: (): void => {} }
  readonly #make: (o: ParticleOptions) => Particles
  readonly #image: (kind: PrecipKind) => string
  readonly #now: () => number
  readonly #time: JulianDate
  readonly #emitter = new ShellEmitter()
  readonly #model = new Matrix4()
  #system: Particles | null = null
  #kind: PrecipKind = 'rain'
  #fallMs = 0
  #windEast = 0
  #windNorth = 0
  #on = false
  #lastMs: number | null = null // the clock's last frame; null: none since it came on
  #destroyed = false

  constructor(primitives: PrimitiveCollection, opts: PrecipitationOptions = {}) {
    this.#primitives = primitives
    this.#make = opts.makeSystem ?? ((o) => new ParticleSystem(o) as unknown as Particles)
    this.#image = opts.image ?? imageOf
    this.#now = opts.now ?? (() => performance.now())
    this.#time = JulianDate.clone(opts.epoch ?? new JulianDate())
    primitives.add(this.#primitive)
  }

  set(f: Fall | null): void {
    if (this.#destroyed) return
    if (f === null) {
      this.#on = false
      this.#lastMs = null
      if (this.#system !== null) this.#system.show = false
      return
    }
    const look = LOOKS[f.kind]
    this.#fallMs = look.fallMs[0] + (look.fallMs[1] - look.fallMs[0]) * clamp01(f.intensity)
    this.#windEast = f.wind.east
    this.#windNorth = f.wind.north
    const speed = Math.hypot(this.#fallMs, f.wind.east, f.wind.north)
    const dim = 1 - NIGHT_DIM * clamp01(f.night)
    const color = new Color(look.color[0] * dim, look.color[1] * dim, look.color[2] * dim, look.color[3])
    const rate = particleCount(f) / look.lifeS
    this.#emitter.rMin = look.radiusM[0]
    this.#emitter.rMax = look.radiusM[1]
    let s = this.#system
    if (s === null || f.kind !== this.#kind) {
      s?.destroy()
      this.#kind = f.kind
      const [w, h] = look.sizeM
      s = this.#system = this.#make({
        image: this.#image(f.kind), emitter: this.#emitter, modelMatrix: this.#model, emissionRate: rate,
        minimumParticleLife: look.lifeS, maximumParticleLife: look.lifeS, minimumSpeed: speed * (1 - SPEED_SPREAD), maximumSpeed: speed * (1 + SPEED_SPREAD),
        minimumImageSize: new Cartesian2(w * 0.8, h * 0.8), maximumImageSize: new Cartesian2(w * 1.2, h * 1.2), sizeInMeters: true, startColor: color, endColor: color,
      })
    } else {
      s.emissionRate = rate
      s.minimumSpeed = speed * (1 - SPEED_SPREAD)
      s.maximumSpeed = speed * (1 + SPEED_SPREAD)
      s.startColor = color
      s.endColor = color
    }
    s.show = true
    this.#on = true
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#on = false
    this.#system?.destroy()
    this.#system = null
    this.#primitives.remove(this.#primitive)
  }

  /**
   * Each frame, from the scene: the emitter ahead of the camera and aimed down its fall, then the system on its own clock.
   * Render passes only: in a pick the particles would catch the click (or the traffic's depth probes) meant for what is behind.
   */
  #update(fs: Frame): void {
    const s = this.#system
    if (!this.#on || s === null || !fs.passes.render) return
    const now = this.#now()
    const step = this.#lastMs === null ? 0 : Math.min(MAX_STEP_S, Math.max(0, (now - this.#lastMs) / 1000))
    this.#lastMs = now
    JulianDate.addSeconds(this.#time, step, this.#time)
    const cam = fs.camera
    this.#aim(cam.positionWC)
    Cartesian3.add(cam.positionWC, Cartesian3.multiplyByScalar(cam.directionWC, LOOKS[this.#kind].aheadM, scratch), scratch)
    s.modelMatrix = Matrix4.fromTranslation(scratch, this.#model) // the setter copies it, and notes a change
    s.update(Object.assign(Object.create(fs) as object, { time: this.#time })) // the scene's frame, on the particles' clock
  }

  /** The emitter's direction at a place: down at the fall speed, plus the wind, in world axes. */
  #aim(at: Cartesian3): void {
    const up = Ellipsoid.WGS84.geodeticSurfaceNormal(at, scratchUp)
    const east = Cartesian3.normalize(Cartesian3.cross(Cartesian3.UNIT_Z, up, scratchEast), scratchEast)
    const north = Cartesian3.cross(up, east, scratchNorth)
    const d = this.#emitter.dir
    d.x = east.x * this.#windEast + north.x * this.#windNorth - up.x * this.#fallMs
    d.y = east.y * this.#windEast + north.y * this.#windNorth - up.y * this.#fallMs
    d.z = east.z * this.#windEast + north.z * this.#windNorth - up.z * this.#fallMs
    Cartesian3.normalize(d, d)
  }
}

// client/scene/groundFog.ts
// Ground fog in the chase: the murk an airport's report describes, drawn in the air round it as a pilot would see it.
// Weather3D turns it on while the aircraft is within 40 km of a station that sees less than 8 km or reports fog, mist,
// haze, smoke or dust (fogNear), and off otherwise: then no post-process pass runs at all.
// The fog is a layer from the ground to a top above the station by the word (fog 300 m, mist 800 m, haze, smoke and dust
// 1,500 m; low visibility with no word, as from rain or snow, as haze). In it the air dims what is seen through it by
// 1 − exp(−σ·d), σ = 3.912 / the visibility (Koschmieder: contrast falls to 2 % at the visibility) and d the length of the
// ray inside the layer. The layer's top is a sphere round the Earth's centre, so a level ray leaves it as the Earth
// curves away. The fog is full within 10 km of the station and thins to nothing at 40 km; the whole of it fades as the
// aircraft goes from 25 to 40 km away, so it never pops out of view. Colour: a pale haze by day (bluish for haze,
// brownish for smoke, tan for dust), dark at night.
// GroundFog draws it: one Cesium PostProcessStage that reads the depth buffer back into each pixel's ray (to what it hits,
// or the sky) and takes 8 samples of the fog's density along its part in the layer.
// ponytail: one station's fog at a time (the strongest round the aircraft); clouds and rain, which write no depth, are
// fogged as the ground behind them. Upgrade: an array of stations in the shader.
import { Cartesian3, Ellipsoid, PostProcessStage, type Camera, type PostProcessStageCollection } from 'cesium'
import { distanceNm } from '../../shared/geo.ts'
import { geoidN } from '../../shared/geoid.ts'
import type { Metar } from '../../shared/wx.ts'
import type { TerrainFrame } from '../types.ts'
import { drawnHeightM, smoothstep } from './exaggeration.ts'

export const KOSCHMIEDER = 3.912 // −ln 0.02
export const FOG_KM = 40 // a station's fog is drawn while the aircraft is this near it
const FULL_KM = 10 // full this near the station, thinning to nothing at FOG_KM
const FADE_KM = 25 // the whole fog fades from here to FOG_KM as the aircraft leaves
const VIS_KM = 8 // a station that sees less than this has its murk drawn
type Murk = 'FG' | 'BR' | 'HZ' | 'FU' | 'DU'
const TOP_M: Record<Murk, number> = { FG: 300, BR: 800, HZ: 1500, FU: 1500, DU: 1500 } // above the station (the plan's)
const VIS_M: Record<Murk, number> = { FG: 500, BR: 3000, HZ: 5000, FU: 5000, DU: 5000 } // a report with the word and no visibility (estimates)
const MURK_TOP_M = 1500 // low visibility with no word for it (rain, snow, spray): as haze
const SHALLOW = 0.1 // MI, shallow fog: this share of the top (estimate)
const PATCHY = 0.5 // BC, PR, patches: this share of the density (estimate)
const RANK: readonly Murk[] = ['FG', 'BR', 'FU', 'DU', 'HZ'] // the word that wins in a report with several
const WORDS: Record<string, Murk> = { FG: 'FG', BR: 'BR', HZ: 'HZ', FU: 'FU', DU: 'DU', SA: 'DU', DS: 'DU', SS: 'DU' } // sand and its storms as dust
type Rgb = readonly [number, number, number]
/** By day, by word: the look constants of the fog's colour. */
export const FOG_DAY: Readonly<Record<Murk | 'murk', Rgb>> = {
  FG: [0.8, 0.82, 0.84], BR: [0.8, 0.82, 0.84], HZ: [0.72, 0.77, 0.85], FU: [0.6, 0.58, 0.55], DU: [0.8, 0.7, 0.55], murk: [0.72, 0.74, 0.76],
}
export const FOG_NIGHT: Rgb = [0.03, 0.035, 0.05]
const FOG_STRENGTH = 1 // σ is drawn times this: 1 as the visibility says (a look knob)
const NIGHT_STEP = 0.02 // the colour is worked out again when the night has changed by this

/** The fog round one station, for GroundFog. */
export interface Fog {
  lat: number // the station
  lon: number
  groundM: number // its height above sea level
  topM: number // the layer's top above sea level
  sigma: number // its extinction near the station, 1/m
  fade: number // 0–1: the whole fog's strength for the aircraft's distance from the station
  day: Rgb // its colour by day
}

/** Extinction (1/m) for a visibility in metres: 3.912 / visibility; 0 for no number. */
export function fogSigma(visM: number): number {
  return Number.isFinite(visM) ? KOSCHMIEDER / Math.max(1, visM) : 0
}

/** The density's share at km from the station: 1 within 10 km, 0 from 40 km, smooth between. */
export function fogWeight(km: number): number {
  return 1 - smoothstep((km - FULL_KM) / (FOG_KM - FULL_KM))
}

/**
 * Where a ray is inside the layer: [t0, t1] metres along it (empty unless t1 > t0). The camera is rho from the Earth's centre,
 * delta = the layer's top less its height (> 0: inside), mu = the cosine of the angle between the ray and the up there;
 * tHit: where the ray meets what it sees (Infinity: the sky). The top is the sphere of radius rho + delta: the points t along
 * the ray inside it solve t² + 2t·rho·mu − delta(2rho + delta) < 0, its roots taken the stable way (no cancellation in
 * float32, the shader's sums). The ground is no bound: the ray ends where it hits it.
 */
export function layerSpan(rho: number, delta: number, mu: number, tHit: number): [number, number] {
  const b = rho * mu
  const c = -delta * (2 * rho + delta)
  const disc = b * b - c
  if (!(disc > 0)) return [0, 0]
  const q = -(b + (b >= 0 ? 1 : -1) * Math.sqrt(disc))
  const r0 = q
  const r1 = c / q
  return [Math.max(0, Math.min(r0, r1)), Math.min(tHit, Math.max(r0, r1))]
}

/** The murk a report's present weather names (not nearby, VC, nor recent, RE): its word, the share of its top and of its density. */
function murkOf(wx: string | null): { murk: Murk; depth: number; thick: number } | null {
  let best: { murk: Murk; depth: number; thick: number } | null = null
  for (const tok of (wx ?? '').split(' ')) {
    let t = tok.replace(/^[+-]/, '')
    if (t.startsWith('VC') || t.startsWith('RE')) continue
    let depth = 1
    let thick = 1
    if (t.startsWith('MI')) [depth, t] = [SHALLOW, t.slice(2)]
    else if (t.startsWith('BC') || t.startsWith('PR')) [thick, t] = [PATCHY, t.slice(2)]
    else if (/^(?:DR|BL|SH|TS|FZ)/.test(t)) t = t.slice(2)
    for (let i = 0; i + 2 <= t.length; i += 2) {
      const murk = WORDS[t.slice(i, i + 2)]
      if (murk !== undefined && (best === null || RANK.indexOf(murk) < RANK.indexOf(best.murk))) best = { murk, depth, thick }
    }
  }
  return best
}

/**
 * The fog to draw round lat, lon: of the stations within 40 km that see less than 8 km or name a murk, the one whose fog is
 * thickest where the aircraft is (σ by the weight at its distance). Null: none.
 */
export function fogNear(metars: readonly Metar[], lat: number, lon: number): Fog | null {
  let best: Fog | null = null
  let most = 0
  for (const m of metars) {
    if (m.elevM === null) continue // the top is above a height not known
    const km = distanceNm(lat, lon, m.lat, m.lon) * 1.852
    if (!(km <= FOG_KM)) continue
    const w = murkOf(m.wx)
    const visM = m.visKm !== null ? m.visKm * 1000 : w !== null ? VIS_M[w.murk] : null
    if (visM === null || (w === null && !(visM < VIS_KM * 1000))) continue
    const sigma = fogSigma(visM) * (w?.thick ?? 1)
    const here = sigma * fogWeight(km)
    if (!(here > most)) continue
    most = here
    best = {
      lat: m.lat, lon: m.lon, groundM: m.elevM, topM: m.elevM + (w === null ? MURK_TOP_M : TOP_M[w.murk] * w.depth), sigma,
      fade: 1 - smoothstep((km - FADE_KM) / (FOG_KM - FADE_KM)), day: FOG_DAY[w?.murk ?? 'murk'],
    }
  }
  return best
}

/** The fog's colour for the Sun's night (0 day … 1 night): its day colour towards the night's. */
export function fogColor(day: Rgb, night: number): [number, number, number] {
  const n = Number.isFinite(night) ? Math.min(1, Math.max(0, night)) : 0
  return [day[0] + (FOG_NIGHT[0] - day[0]) * n, day[1] + (FOG_NIGHT[1] - day[1]) * n, day[2] + (FOG_NIGHT[2] - day[2]) * n]
}

const SAMPLES = 8 // density samples along a ray's part in the layer
const glsl = (n: number): string => (Number.isInteger(n) ? `${n}.0` : String(n))

/**
 * The fog pass. Each pixel's ray comes back from the depth buffer (czm_windowToEyeCoordinates undoes Cesium's log depth;
 * the sky, at depth 1, is a ray that hits nothing); its span in the layer is layerSpan's, in the camera's frame (no big
 * numbers in float32); the density along it is fogWeight's at each sample's distance from the station, level with it.
 */
export const FOG_SHADER = `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform float u_rho; // the camera's distance from the Earth's centre, m
uniform float u_delta; // the layer's top less the camera's height, m
uniform float u_sigma; // extinction near the station, by the fade, 1/m
uniform vec3 u_station; // the station's ground from the camera, m
uniform vec3 u_color;
in vec2 v_textureCoordinates;

float weight(float d) {
  float u = clamp((d - ${glsl(FULL_KM * 1000)}) / ${glsl((FOG_KM - FULL_KM) * 1000)}, 0.0, 1.0);
  return 1.0 - u * u * (3.0 - 2.0 * u);
}

void main() {
  vec4 color = texture(colorTexture, v_textureCoordinates);
  out_FragColor = color;
  float depth = texture(depthTexture, v_textureCoordinates).r;
  vec4 eye = czm_windowToEyeCoordinates(gl_FragCoord.xy, depth);
  vec3 p = eye.xyz / eye.w;
  float tHit = depth >= 1.0 ? 1.0e9 : length(p);
  vec3 dir = czm_inverseViewRotation * normalize(p);
  vec3 up = normalize(czm_viewerPositionWC);
  float b = u_rho * dot(dir, up);
  float c = -u_delta * (2.0 * u_rho + u_delta);
  float disc = b * b - c;
  if (disc <= 0.0) return;
  float q = -(b + (b >= 0.0 ? 1.0 : -1.0) * sqrt(disc));
  float t0 = max(0.0, min(q, c / q));
  float t1 = min(tHit, max(q, c / q));
  if (t1 <= t0) return;
  float dt = (t1 - t0) / ${glsl(SAMPLES)};
  float tau = 0.0;
  for (int i = 0; i < ${SAMPLES}; i++) {
    vec3 x = dir * (t0 + (float(i) + 0.5) * dt) - u_station;
    tau += weight(length(x - dot(x, up) * up));
  }
  out_FragColor = vec4(mix(color.rgb, u_color, 1.0 - exp(-u_sigma * tau * dt)), color.a);
}
`

/**
 * Draws the fog set (none: no stage in the scene, so no pass). Cesium destroys a stage it removes, so fog after a clear
 * spell is a new stage. The shader's numbers are read from the camera each frame as Cesium draws (its uniforms are
 * functions); frame() keeps the top on the ground as the relief is drawn and the colour on the night.
 */
export class GroundFog {
  readonly #stages: PostProcessStageCollection
  readonly #camera: Camera
  readonly #geoid: (lat: number, lon: number) => number
  readonly #station = new Cartesian3() // its ground, world
  readonly #rel = new Cartesian3()
  readonly #color = new Cartesian3()
  #stage: PostProcessStage | null = null
  #fog: Fog | null = null
  #groundM = 0 // above the ellipsoid
  #topM = 0
  #topDrawnM = 0 // the top as drawn: with its station's ground, flattened or grown
  #f = 1
  #relHM = 0
  #night = 0 // in steps
  #destroyed = false

  constructor(scene: { postProcessStages: PostProcessStageCollection; camera: Camera }, opts: { geoid?: (lat: number, lon: number) => number } = {}) {
    this.#stages = scene.postProcessStages
    this.#camera = scene.camera
    this.#geoid = opts.geoid ?? geoidN
  }

  /** The fog to draw, or none. */
  set(fog: Fog | null): void {
    if (this.#destroyed) return
    this.#fog = fog
    if (fog === null) {
      if (this.#stage !== null) this.#stages.remove(this.#stage) // and destroys it
      this.#stage = null
      return
    }
    const n = this.#geoid(fog.lat, fog.lon)
    this.#groundM = fog.groundM + n
    this.#topM = fog.topM + n
    Cartesian3.fromDegrees(fog.lon, fog.lat, this.#groundM, Ellipsoid.WGS84, this.#station)
    this.#place()
    this.#tint()
    if (this.#stage !== null) return
    this.#stage = new PostProcessStage({ fragmentShader: FOG_SHADER, uniforms: this.#uniforms() })
    this.#stages.add(this.#stage)
  }

  /** Every frame while the weather shows: the relief drawn and the Sun's night (the colour worked out again only by a step). */
  frame(tf: TerrainFrame, night: number): void {
    if (this.#destroyed) return
    if ((tf.fNow !== this.#f || tf.relHM !== this.#relHM) && Number.isFinite(tf.fNow) && Number.isFinite(tf.relHM)) {
      this.#f = tf.fNow
      this.#relHM = tf.relHM
      this.#place()
    }
    const q = Number.isFinite(night) ? Math.round(Math.min(1, Math.max(0, night)) / NIGHT_STEP) * NIGHT_STEP : 0
    if (q !== this.#night) {
      this.#night = q
      this.#tint()
    }
  }

  destroy(): void {
    this.set(null)
    this.#destroyed = true
  }

  #place(): void {
    this.#topDrawnM = this.#topM + drawnHeightM(this.#groundM, this.#f, this.#relHM) - this.#groundM
  }

  #tint(): void {
    if (this.#fog === null) return
    const [r, g, b] = fogColor(this.#fog.day, this.#night)
    this.#color.x = r
    this.#color.y = g
    this.#color.z = b
  }

  #uniforms(): Record<string, () => number | Cartesian3> {
    return {
      u_rho: () => Cartesian3.magnitude(this.#camera.positionWC),
      u_delta: () => this.#topDrawnM - this.#camera.positionCartographic.height,
      u_sigma: () => (this.#fog === null ? 0 : this.#fog.sigma * this.#fog.fade * FOG_STRENGTH),
      u_station: () => Cartesian3.subtract(this.#station, this.#camera.positionWC, this.#rel),
      u_color: () => this.#color,
    }
  }
}

// client/scene/sun.ts
// WP-E2: sunlight in the chase view (design D8–D10, D12, §4). The sun comes from Cesium's own ephemeris; the app owns
// the light, the night blend and the aircraft's ambient light. Cesium's SunLight lights slopes and the aircraft from
// below the horizon, and its day/night imagery blend (dayAlpha/nightAlpha) does nothing once the terrain has normals.
import {
  Cartesian2,
  Cartesian3,
  Color,
  DirectionalLight,
  DynamicAtmosphereLightingType,
  Ellipsoid,
  JulianDate,
  Math as CesiumMath,
  Matrix3,
  Matrix4,
  Simon1994PlanetaryPositions,
  Transforms,
} from 'cesium'
import type { ImageryLayer, Model, Viewer } from 'cesium'
import { smoothstep } from './exaggeration.ts'

const RAD = Math.PI / 180
/** The light never comes from lower: a low sun must not light slopes that face it from below the horizon. */
const MIN_LIGHT_ELEV_DEG = 2
const MIN_LIGHT_TAN = Math.tan(MIN_LIGHT_ELEV_DEG * RAD)
const DAY_INTENSITY = 2 // SunLight's default: czm_lightColorHdr = colour × intensity
const NIGHT_INTENSITY = 0.45
const WARM_GREEN = 0.8 // warm low sun (1.0, 0.8, 0.62)
const WARM_BLUE = 0.62
/** Below 1, so the day layer's APPLY_BRIGHTNESS shader variant is compiled from the start, not at the first dusk. */
const DAY_BRIGHTNESS = 0.9999
/**
 * Below 1, so full night keeps the APPLY_ALPHA variant of the dusk. At alpha 1 Cesium drops APPLY_ALPHA and compiles
 * another globe program. The night layer's first draw still compiles one (a second texture): hidden by day, it cannot
 * be pre-warmed.
 */
const NIGHT_MAX_ALPHA = 0.9999
const NIGHT_SHOW_ALPHA = 0.01
/**
 * The city lights (VIIRS, z8 ≈ 500 m/px) are one flat blob from a camera low over a big city (Tel Aviv, 2026-09-23), so
 * near the ground they fade to a faint glow and the day imagery shows through.
 * ponytail: the camera's height above the ellipsoid, not the ground. A valley city keeps its glow seen from a ridge
 * (Innsbruck from the Nordkette: ~44 %), but a city 2 km up (Mexico City) keeps ~40 % at 700 m above it. Upgrade: the
 * chase camera's clearance, minus a ridge-vs-valley test, if a high city shows the blob.
 */
const LIGHTS_NEAR = 0.12 // the user's pick from 0, 0.12, 0.2 and 0.3
const LIGHTS_NEAR_M = 1500 // at or below: LIGHTS_NEAR
const LIGHTS_FULL_M = 5000 // at or above: all the lights
/** The model's environment map is rebuilt after this much movement (Cesium: 1 km, every ~4 s at airliner speed). */
const ENV_MAP_EPSILON_M = 20_000
/** Sun off: a light from 60° above the southern horizon. Where it travels, in east-north-up: north and down. */
const OFF_TRAVEL_ENU = new Cartesian3(0, Math.cos(60 * RAD), -Math.sin(60 * RAD))

const scratchM3 = new Matrix3()
const scratchUp = new Cartesian3()
const scratchH = new Cartesian3()

/**
 * Unit vector Earth → Sun in the Earth-fixed frame, computed as Cesium's UniformState computes czm_sunDirectionWC
 * (Simon 1994). ICRF → fixed needs Cesium's IAU 2006 XYS table, which it fetches from its Assets on first use; until
 * then, and always in Node, the TEME → pseudo-fixed fallback is used, 0.37° off.
 */
export function sunDirectionWC(jd: JulianDate, result: Cartesian3): Cartesian3 {
  const toFixed = Transforms.computeIcrfToFixedMatrix(jd, scratchM3) ?? Transforms.computeTemeToPseudoFixedMatrix(jd, scratchM3)
  Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(jd, result)
  return Cartesian3.normalize(Matrix3.multiplyByVector(toFixed, result, result), result)
}

/** Degrees of the sun above the geodetic horizon at posWC (no refraction; parallax is 9″). */
export function sunElevationDeg(sunWC: Cartesian3, posWC: Cartesian3): number {
  const up = Ellipsoid.WGS84.geodeticSurfaceNormal(posWC, scratchUp)
  return CesiumMath.toDegrees(Math.asin(CesiumMath.clamp(Cartesian3.dot(up, sunWC), -1, 1)))
}

/** Everything the sun elevation sets (design §4). golden is the warmth applied: golden01·(1 − night). */
export interface SunLook {
  night: number // 0 at +2°, 1 at −8°
  golden: number // 0 above +15° and at full night
  intensity: number // scene light
  red: number // scene light colour
  green: number
  blue: number
  vertexShadowDarkness: number // globe ambient floor
  dayBrightness: number // day imagery layer
  nightAlpha: number // city-lights layer
  iblFactor: number // chased model's image-based lighting
}

/** The look at a sun elevation. Pure; writes into result when given (Sun reuses one). NaN looks like day. */
export function sunLook(elevDeg: number, result?: SunLook): SunLook {
  const night = smoothstep((2 - elevDeg) / 10)
  const golden = smoothstep((15 - elevDeg) / 15) * (1 - night)
  const r = result ?? ({} as SunLook)
  r.night = night
  r.golden = golden
  r.intensity = DAY_INTENSITY + (NIGHT_INTENSITY - DAY_INTENSITY) * night
  r.red = 1
  r.green = 1 + (WARM_GREEN - 1) * golden
  r.blue = 1 + (WARM_BLUE - 1) * golden
  r.vertexShadowDarkness = 0.3 + 0.2 * golden // a warm, lifted floor at golden hour instead of black shade
  r.dayBrightness = Math.min(DAY_BRIGHTNESS, 1 - 0.7 * night)
  r.nightAlpha = Math.min(NIGHT_MAX_ALPHA, night)
  r.iblFactor = 1 - 0.85 * night // never 0: crossing 0 regenerates the model's shaders
  return r
}

/** Share of the city lights kept with the camera at heightM: LIGHTS_NEAR low, 1 from LIGHTS_FULL_M, smooth between. */
export function lightsFactor(heightM: number): number {
  return LIGHTS_NEAR + (1 - LIGHTS_NEAR) * smoothstep((heightM - LIGHTS_NEAR_M) / (LIGHTS_FULL_M - LIGHTS_NEAR_M))
}

/**
 * The scene light's travel direction (DirectionalLight.direction, unit): from the sun, raised to at least 2° above the
 * horizon on the sun's own azimuth, then blended towards a light from straight overhead by night (dim relief at night,
 * design §7.1). Normalised once after the blend: at the antisolar point the raised vector is 0, but night is 1 there.
 */
export function aimLight(sunWC: Cartesian3, upWC: Cartesian3, night: number, result: Cartesian3): Cartesian3 {
  const v = Cartesian3.dot(sunWC, upWC)
  const h = Cartesian3.subtract(sunWC, Cartesian3.multiplyByScalar(upWC, v, scratchH), scratchH) // horizontal part
  Cartesian3.multiplyByScalar(upWC, Math.max(v, MIN_LIGHT_TAN * Cartesian3.magnitude(h)), result)
  Cartesian3.lerp(Cartesian3.add(h, result, result), upWC, night, result)
  return Cartesian3.negate(Cartesian3.normalize(result, result), result)
}

/** ?sun= from the page URL: a fixed instant, or an offset from the render time. */
export interface SunParam {
  fixedMs: number | null
  offsetMs: number
}

const SUN_OFFSET = /^([+-])(\d+)([hm])$/
const SUN_ISO = /^(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?)(Z|[+-]\d\d:\d\d)?$/

/**
 * ?sun=2026-06-21T06:30:00Z fixes the sun time (no zone = UTC); ?sun=+6h, -2h or +30m offsets it. Anything else: none.
 * URLSearchParams turns a '+' typed into the URL into a space, so a space reads as '+'.
 */
export function parseSunParam(search: string): SunParam {
  const s = (new URLSearchParams(search).get('sun') ?? '').replaceAll(' ', '+')
  const o = SUN_OFFSET.exec(s)
  if (o) return { fixedMs: null, offsetMs: (o[1] === '-' ? -1 : 1) * Number(o[2]) * (o[3] === 'h' ? 3_600_000 : 60_000) }
  const m = SUN_ISO.exec(s)
  const fixedMs = m ? Date.parse(m[1] + (m[2] ?? 'Z')) : Number.NaN
  return { fixedMs: Number.isFinite(fixedMs) ? fixedMs : null, offsetMs: 0 }
}

/**
 * The instant that lights the scene (D12): the render time (server clock) moved back onto the upstream clock, which for
 * a replay is the recording's, then the ?sun= override. upstreamOffsetMs is StatusBrief.upstreamOffsetMs (WP-E5):
 * 0 until the server reports it, so until then a replay is lit at wall-clock time.
 */
export function sunTimeMs(tRenderMs: number, p: SunParam, upstreamOffsetMs = 0): number {
  return p.fixedMs ?? tRenderMs - upstreamOffsetMs + p.offsetMs
}

/** What update() reports. One reused object: read it during the frame. */
export interface SunState {
  elevDeg: number
  night: number
  golden: number
}

/**
 * The scene's sun: Cesium's clock, the one scene light, the day/night imagery blend and the chased model's ambient light.
 * Starts off. Allocates nothing per frame.
 */
export class Sun {
  #viewer: Viewer
  #day: ImageryLayer | null
  #night: ImageryLayer | null
  #model: Model | null = null
  #enabled = false
  #light = new DirectionalLight({ direction: new Cartesian3(0, 0, -1), intensity: DAY_INTENSITY })
  #date = new Date(0)
  #jd = new JulianDate()
  #sun = new Cartesian3()
  #up = new Cartesian3()
  #at = new Cartesian3() // the last update() position: where the off light stands
  #enu = new Matrix4()
  #ibl = new Cartesian2(1, 1)
  #look = sunLook(90)
  #state: SunState = { elevDeg: 90, night: 0, golden: 0 }

  constructor(viewer: Viewer, layers: { day: ImageryLayer | null; night: ImageryLayer | null }) {
    this.#viewer = viewer
    this.#day = layers.day
    this.#night = layers.night
    const { scene } = viewer
    scene.light = this.#light
    // The sky, the fog and the model's environment map follow the real sun (below the horizon too), not this light.
    scene.atmosphere.dynamicLighting = DynamicAtmosphereLightingType.SUNLIGHT
    scene.globe.dynamicAtmosphereLightingFromSun = true
    viewer.clock.shouldAnimate = false // the Viewer's default: update() writes currentTime every frame
    // D10: no cast shadows, so viewer.shadows stays false (the Viewer's default). In the PoC they cost 65 → 46–52 fps
    // and drew acne stripes on the aircraft for a small visual gain. Measure again before anyone turns them on.
    Cartesian3.clone(viewer.camera.positionWC, this.#at)
    this.setEnabled(false)
  }

  /** On: chase with the Sun toggle on. Off (browse, or the toggle off): unlit globe, day imagery, a fixed high light. */
  setEnabled(on: boolean): void {
    this.#enabled = on
    this.#viewer.scene.globe.enableLighting = on
    if (on) return // the next update() applies the look
    if (this.#night) this.#night.show = false
    if (this.#day) this.#day.brightness = DAY_BRIGHTNESS
    this.#light.intensity = DAY_INTENSITY
    Color.clone(Color.WHITE, this.#light.color)
    this.#setIbl(1)
    this.#aimOff()
  }

  /** A new base imagery layer (Esri → EOX fallback): dim this one from now on. */
  setDay(day: ImageryLayer | null): void {
    this.#day = day
    if (day && !this.#enabled) day.brightness = DAY_BRIGHTNESS
  }

  /** The chased model (null: none). Sun dims its image-based light at night and slows its environment-map rebuilds. */
  attachModel(model: Model | null): void {
    this.#model = model
    // ponytail: maximumSecondsDifference stays 3,600 s, so a slow aircraft can reflect a sky up to an hour old at dusk
    // (the IBL factor hides it at night). Upgrade: ~300 s here if the golden-hour screenshots show it.
    if (model) model.environmentMapManager.maximumPositionEpsilon = ENV_MAP_EPSILON_M
  }

  /**
   * Every frame, in both modes: tSunMs from sunTimeMs, atWC the chased aircraft (browse: the camera). Writes the clock,
   * which Cesium's sun, sky and environment maps take one frame later. On, applies sunLook at atWC; off, keeps the fixed
   * light above atWC. null, writing nothing, for a time that is no Date or a non-finite position. The camera's height
   * fades the city lights (lightsFactor).
   */
  update(tSunMs: number, atWC: Cartesian3): SunState | null {
    if (!Number.isFinite(this.#date.setTime(tSunMs)) || !Number.isFinite(Cartesian3.magnitudeSquared(atWC))) return null
    this.#viewer.clock.currentTime = JulianDate.fromDate(this.#date, this.#jd) // the Clock clones it on its next tick
    Cartesian3.clone(atWC, this.#at)
    const sun = sunDirectionWC(this.#jd, this.#sun)
    // ponytail: one elevation for the whole view, at atWC, with no horizon dip for a high aircraft (3.2° at 10 km).
    // Upgrade: a direct-sun factor on model.lightColor (research C7) if dusk shows a dark airliner in a sunlit sky.
    const elevDeg = sunElevationDeg(sun, atWC)
    const look = sunLook(elevDeg, this.#look)
    const st = this.#state
    st.elevDeg = elevDeg
    st.night = look.night
    st.golden = look.golden
    if (!this.#enabled) {
      this.#aimOff()
      return st
    }
    const light = this.#light
    aimLight(sun, Ellipsoid.WGS84.geodeticSurfaceNormal(atWC, this.#up), look.night, light.direction)
    light.intensity = look.intensity
    light.color.red = look.red
    light.color.green = look.green
    light.color.blue = look.blue
    this.#viewer.scene.globe.vertexShadowDarkness = look.vertexShadowDarkness
    if (this.#day) this.#day.brightness = look.dayBrightness
    if (this.#night) {
      const alpha = look.nightAlpha * lightsFactor(this.#viewer.camera.positionCartographic.height)
      this.#night.alpha = alpha
      this.#night.show = alpha > NIGHT_SHOW_ALPHA // hidden layers request no tiles: none by day
    }
    this.#setIbl(look.iblFactor)
    return st
  }

  #setIbl(f: number): void {
    if (!this.#model) return
    this.#ibl.x = this.#ibl.y = f
    this.#model.imageBasedLighting.imageBasedLightingFactor = this.#ibl // the setter copies it
  }

  #aimOff(): void {
    Transforms.eastNorthUpToFixedFrame(this.#at, Ellipsoid.WGS84, this.#enu)
    Matrix4.multiplyByPointAsVector(this.#enu, OFF_TRAVEL_ENU, this.#light.direction)
  }
}

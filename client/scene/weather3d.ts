// client/scene/weather3d.ts
// The weather round the chased aircraft, in 3-D (the Layers panel's Weather switch, in the chase). Weather3D keeps what the
// aircraft flies through, for the parts that draw it:
// - the airports' reports (METARs) of the whole-degree box 2° round it, asked again every 5 min and at once when it leaves the box;
// - the hazard areas (SIGMETs) and RainViewer's newest radar frame (a RadarSource: its tiles are fetched when something
//   samples them, as the top-down map's radar does), each every 10 min.
// It draws the hazard areas that have a top and whose ring passes within 800 km of the aircraft (wxGeo.ts picks them): each
// ring a translucent volume from the area's base (none: the ground) to its top, and the area's name and heights a label at
// the ring's middle at the top height, placed with the place names (placeLabels.ts keeps them clear of each other and of the
// flight-data frame). A list of SIGMETs that brings the same areas draws nothing again.
// And the sky a pilot would see (a Sky: Cesium's parts in the app):
// - clouds from the airports' reports (cloudField.ts) within 150 km, built when new reports come or the aircraft has moved
//   30 km, and drawn the frame after (the work spread over two frames) by the one cloud layer (cloudLayer.ts). Clouds of
//   other sources join the same list after the observed ones (#buildClouds);
// - rain clouds and rain shafts from the radar's newest frame: towers where it rains hard, flat decks where it rains lightly
//   (cloudField.ts radarClouds), shafts of rain under the heaviest (rainShafts.ts). They fade out by 100 km; the frame is read
//   30 km farther (the ring stands at alpha 0 and fades in as the aircraft comes, so none pops in at a rebuild). Built from the
//   frame's zoom-7 tiles (radarCells.ts) at the same time as the observed clouds (the look builds those; where the tiles hold an
//   echo the radar's part, the heavier, is built the frame after, and both are drawn the frame after that), and again when
//   the aircraft has moved 30 km, or when a tile or a newer frame has come (the tiles that come one by one are waited for: one
//   build, when the last has come, at most 3 s after the first); until a newer frame's tile has come the last frame's stands in
//   for it. They stand on the nearest station's ceiling (cloudField.ts radarBases), and RADAR_LOOK.reserve of the 700 clouds are
//   kept for them;
// - ground fog round a station near the aircraft that sees little (groundFog.ts);
// - rain or snow round the camera, from the radar under it or the nearest station's weather, below the cloud: a light
//   screen overlay (precip.ts), leaned with the wind across the camera's view a few times a second.
// Every frame the clouds, the shafts and the fog follow the relief drawn and the Sun's night (setNight); the rest is looked at
// once a second, when the clouds and the shafts are also faded by their distance from the aircraft.
// Live only: app.ts shows it in a live chase, not in History or a scenario (it is today's sky). Hidden it asks for nothing and
// draws nothing, and update() returns at once; shown, it looks at its clocks and the aircraft once a second.
// ?wxat=<lat>,<lon> is a check aid (the UI does not mention it): a replay's aircraft flies where the sky may be clear, so the
// weather is taken from round that place and moved by the one shift that puts the place under the aircraft's first position.
// From then on the aircraft flies through that sky. Everything it holds is where it is drawn (shifted); the radar's tiles are
// RainViewer's own, so a sample at a drawn place is taken at that place less the shift.
import { Cartesian3, Color, CustomDataSource, Ellipsoid, Math as CesiumMath, type Cartographic, type Viewer } from 'cesium'
import { distanceNm } from '../../shared/geo.ts'
import { geoidN } from '../../shared/geoid.ts'
import type { Metar, Sigmet } from '../../shared/wx.ts'
import type { TerrainFrame } from '../types.ts'
import { DEFAULT_UNITS, type Units } from '../ui/units.ts'
import { MAX_CLOUDS, RADAR_LOOK, REBUILD_KM, nearestClouds, observedClouds, overcastShade, radarBases, radarClouds, type CloudSpec } from './cloudField.ts'
import { CloudLayer } from './cloudLayer.ts'
import { drawnHeightM } from './exaggeration.ts'
import { GroundFog, fogNear } from './groundFog.ts'
import type { LayerLabel, PlaceLabels } from './placeLabels.ts'
import { Precipitation, cloudBaseM, nearestStation, precipFromDbz, precipFromWx, radarPixel, radarSample, windOf, type Fall } from './precip.ts'
import { RADAR_INDEX, RADAR_SRC_MAX, RadarSource, type RadarIndex, type SourceTile } from './radar.ts'
import { radarCells, tilesAcross } from './radarCells.ts'
import { RainShafts, pickShafts, type RainShaft } from './rainShafts.ts'
import { hazardsNear, ringCentre, shiftMetars, shiftSigmets, viewBox, wrapLon, type Hazard } from './wxGeo.ts'
import { sigmetColor, sigmetLabel } from './wxText.ts'

const BOX_DEG = 2 // the METAR box reaches this far from the aircraft each way, rounded out to whole degrees
const METAR_EVERY_MS = 5 * 60_000
const SLOW_EVERY_MS = 10 * 60_000 // SIGMETs and the radar frame
const RETRY_MS = 30_000 // a failed ask is made again after this
const LOOK_MS = 1000 // update() looks at its clocks and the aircraft this often
export const HAZARD_KM = 800 // hazard areas are drawn when their ring passes this near the aircraft
const PICK_KM = 10 // the hazard areas are picked again once the aircraft has moved this far
const FILL_ALPHA = 0.1
const LINE_ALPHA = 0.3
const LABEL_KEY = 'hazards' // this layer in the names overlay
const LABEL_RANK = 1.5 // after the seas (1), before every city (2)
const NOTE = 'some weather unavailable'
const KM_PER_NM = 1.852
const PRECIP_OVER_BASE_M = 300 // rain or snow shows round a camera up to this far over its cloud's base,
const PRECIP_OVER_GROUND_M = 3000 // or this far over the ground when no base is known
const TRUE_RELIEF: TerrainFrame = { fSampled: 1, fNow: 1, relHM: 0 }
const AIM_MS = 250 // the rain or snow overlay is leaned for the camera's heading at most this often
const TILES_FLOOR = 16 // decoded radar tiles kept at least (128 KB each): those the box the radar is read in can touch, and a row and a column more, are kept too
const TILE_WAIT_MS = 3000 // tiles that have come are built from once none is still on its way, or this long after the first
// Under a broken or overcast layer the sky greys (Cesium's sky atmosphere): its colour and light drop by these at full
// shade (cloudField.ts overcastShade), easing over SHADE_EASE_S: an estimate, by eye.
const SKY_DESATURATE = 0.75
const SKY_DARKEN = 0.3
const SHADE_EASE_S = 2
/** How grey rain on the radar over the camera makes the sky: none under 15 dBZ, light rain 0.5, heavy 0.9 (an estimate, by eye). */
export const echoShade = (dbz: number): number => (dbz < 15 ? 0 : dbz >= 40 ? 0.9 : dbz >= 30 ? 0.75 : 0.5)

/** The chased aircraft: degrees, and metres above the ellipsoid as it is drawn. */
export interface Aircraft {
  lat: number
  lon: number
  altM: number
}

export interface WxAt {
  lat: number
  lon: number
}

/** ?wxat=47.46,8.55: the place the weather is taken from instead (a check aid); none when absent or not a place. */
export function parseWxAt(search: string): WxAt | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(new URLSearchParams(search).get('wxat') ?? '')
  if (m === null) return null
  const [lat, lon] = [Number(m[1]), Number(m[2])]
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null
}

/** The panel's one-line summary: "Clouds from 3 airports · 2 hazard areas". */
export function statusText3d(s: { airports: number; areas: number; note: string }): string {
  const count = (n: number, what: string): string => `${n} ${what}${n === 1 ? '' : 's'}`
  return [`Clouds from ${count(s.airports, 'airport')}`, count(s.areas, 'hazard area'), ...(s.note ? [s.note] : [])].join(' · ')
}

type Box = readonly [south: number, west: number, north: number, east: number]
type Feed = 'metar' | 'sigmet' | 'radar'

/** What draws the sky round the aircraft: Cesium's parts in the app (cesiumSky), fakes in tests. */
export interface Sky {
  clouds: Pick<CloudLayer, 'show' | 'draw' | 'frame' | 'fade' | 'destroy'>
  shafts: Pick<RainShafts, 'show' | 'draw' | 'frame' | 'fade' | 'destroy'>
  fog: Pick<GroundFog, 'set' | 'frame' | 'destroy'>
  precip: Pick<Precipitation, 'set' | 'aim' | 'destroy'>
}

/**
 * The sky's parts in the viewer: the shafts, the clouds and the fog in its scene, the rain or snow overlay in its element (the
 * globe's). The shafts are added before the clouds, so that where translucent primitives are drawn in the order they were added
 * the clouds, which hide a shaft's top, are drawn over the shafts (unchecked: Cesium may blend them without order).
 */
const cesiumSky = (viewer: Viewer): Sky => ({
  shafts: new RainShafts(viewer.scene.primitives), clouds: new CloudLayer(viewer.scene.primitives), fog: new GroundFog(viewer.scene),
  precip: new Precipitation(viewer.container as HTMLElement),
})

export interface Weather3DOptions {
  apiBase: string // the app's /api
  labels: Pick<PlaceLabels, 'setLayer'> // the names overlay: the hazard areas' labels go through it
  onStatus?: (text: string | null) => void // the Layers panel's one-line summary
  units?: () => Units // what heights are worded in (the flight-data frame's); default feet
  at?: WxAt | null // ?wxat
  getJson?: (url: string) => Promise<unknown>
  sky?: Sky // default: Cesium's, in the viewer's scene
  tile?: (radar: RadarSource, z: number, x: number, y: number) => Promise<SourceTile | null> // a decoded radar tile; default the source's own
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function listOf<T>(json: unknown, usable: (x: T) => boolean): T[] {
  if (!Array.isArray(json)) throw new Error('not a list')
  return (json as T[]).filter(usable)
}

const metarsOf = (json: unknown): Metar[] => listOf<Metar>(json, (m) => Number.isFinite(m?.lat) && Number.isFinite(m?.lon))
const sigmetsOf = (json: unknown): Sigmet[] => listOf<Sigmet>(json, (s) => Array.isArray(s?.rings))

function frameOf(json: unknown): { host: string; path: string } {
  const idx = json as Partial<RadarIndex> | null
  const last = idx?.radar?.past?.at(-1)
  if (typeof idx?.host !== 'string' || typeof last?.path !== 'string') throw new Error('no radar frame')
  return { host: idx.host, path: last.path }
}

export class Weather3D {
  readonly #viewer: Viewer
  readonly #apiBase: string
  readonly #labels: Pick<PlaceLabels, 'setLayer'>
  readonly #onStatus: (text: string | null) => void
  readonly #units: () => Units
  readonly #getJson: (url: string) => Promise<unknown>
  readonly #at: WxAt | null
  readonly #sky: Sky
  readonly #tile: (radar: RadarSource, z: number, x: number, y: number) => Promise<SourceTile | null>
  readonly #volumes = new CustomDataSource('hazard-volumes')
  readonly #here: Aircraft = { lat: 0, lon: 0, altM: 0 }
  readonly #hereWC = new Cartesian3()
  readonly #shift = { dLat: 0, dLon: 0 }
  readonly #down = new Set<Feed>() // the sources whose last ask failed
  #seen = false // #here holds an aircraft (and the shift, if there is one, is set)
  #show = false
  #destroyed = false
  #lookedMs = -Infinity
  #box: Box | null = null // the METAR box last asked for
  #metarsDue = -Infinity
  #sigmetsDue = -Infinity
  #radarDue = -Infinity
  #metars: readonly Metar[] = []
  #sigmets: readonly Sigmet[] = []
  #radar: RadarSource | null = null
  #gen = 0 // the SIGMET list held: the hazard areas are picked from it again when it changes
  #hazards: Hazard[] = []
  #pickedGen = -1
  #pickedLat = Number.NaN // where the aircraft was when the hazards were last picked
  #pickedLon = Number.NaN
  #volumeKey = ''
  #labelKey = ''
  #line: string | null = null // the last summary written
  #metarGen = 0 // the METAR list held: the clouds are built again from it when it changes
  #builtGen = -1
  #builtLat = Number.NaN // where the aircraft was when the clouds were built
  #builtLon = Number.NaN
  #stations = 0 // the stations the clouds were built from
  #pending: { clouds: CloudSpec[]; shafts: RainShaft[] } | null = null // built, drawn at the next frame
  #staged: CloudSpec[] | null = null // the observed clouds built at a look, to be joined by the radar's, which are built at the next frame
  #radarGen = 0 // the radar data held (its newest frame, its tiles): the radar's clouds are built again from it when it changes
  #builtRadar = -1
  #made = new WeakMap<Metar, CloudSpec[]>() // each report's clouds (observedClouds' cache)
  #fNow = 1 // the relief drawn, as the last frame gave it (its object is reused: copied)
  #relHM = 0
  #night = 0 // the Sun's night, as setNight gave it
  #shadeTarget = 0 // the overcast's grey over the camera, from the last look
  #shade = 0 // as the sky has it now, easing to the target
  #shadeMs = Number.NaN
  #written = 0 // the grey last written to the sky
  #falling = false // the overlay shows rain or snow
  #aimedMs = -Infinity
  readonly #tiles = new Map<string, { url: string; tile: SourceTile | null }>() // decoded zoom-7 tiles by 'x/y', the first to come first, each with the URL of the frame it is of (not the source: that holds every tile of its frame)
  readonly #asked = new Set<string>() // the tiles asked for from #askedFrom
  #askedFrom: string | null = null // the URL of the frame they were asked from
  #loading = 0 // tiles asked for that have not come
  #landed = false // a tile has come that reads differently, and the radar's clouds are not built from it yet
  #landedMs = 0 // the look it was seen at

  constructor(viewer: Viewer, opts: Weather3DOptions) {
    this.#viewer = viewer
    this.#apiBase = opts.apiBase
    this.#labels = opts.labels
    this.#onStatus = opts.onStatus ?? (() => {})
    this.#units = opts.units ?? (() => DEFAULT_UNITS)
    this.#getJson = opts.getJson ?? getJson
    this.#at = opts.at ?? null
    this.#sky = opts.sky ?? cesiumSky(viewer)
    this.#tile = opts.tile ?? ((radar, z, x, y) => radar.get(z, x, y))
    this.#volumes.show = false
    void viewer.dataSources.add(this.#volumes)
  }

  get show(): boolean {
    return this.#show
  }

  set show(on: boolean) {
    if (this.#destroyed || on === this.#show) return
    this.#show = on
    this.#volumes.show = on
    this.#sky.clouds.show = on
    this.#sky.shafts.show = on
    if (on) {
      this.#refresh() // its labels, its sky and the line again, from what it holds
      this.#status()
    } else {
      this.#labelKey = ''
      this.#line = null
      this.#labels.setLayer(LABEL_KEY, LABEL_RANK, [])
      this.#sky.fog.set(null)
      this.#sky.precip.set(null)
      this.#falling = false
      this.#greySky(0)
    }
  }

  /** The airports' reports of the box round the aircraft, as they are drawn (shifted by ?wxat). */
  get metars(): readonly Metar[] {
    return this.#metars
  }

  /** The hazard areas, all of them, as drawn (shifted by ?wxat). */
  get sigmets(): readonly Sigmet[] {
    return this.#sigmets
  }

  /** RainViewer's newest frame, unshifted; null until the first answer. */
  get radar(): RadarSource | null {
    return this.#radar
  }

  /** The aircraft as last given to update(); null before the first. */
  get aircraft(): Readonly<Aircraft> | null {
    return this.#seen ? this.#here : null
  }

  /** What ?wxat moved the weather by, degrees (zero without it): a place in the drawn sky is the weather's own place plus this. */
  get shift(): Readonly<{ dLat: number; dLon: number }> {
    return this.#shift
  }

  /** The hazard areas drawn. */
  get hazards(): readonly Hazard[] {
    return this.#hazards
  }

  /** What draws the sky (for checks in the console). */
  get sky(): Sky {
    return this.#sky
  }

  /** The Sun's night (0 day … 1 night) the sky is lit by: app.ts gives it every frame, 0 while the Sun toggle is off. */
  setNight(n: number): void {
    this.#night = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0
  }

  /** The sky built again from what it holds, every report's clouds and the radar's worked out anew (a check aid: after changing a look constant, LOOKS or RADAR_LOOK, in the console). */
  rebuildSky(): void {
    this.#made = new WeakMap()
    this.#builtGen = -1
    this.#refresh()
  }

  /**
   * Every frame, with the chased aircraft (null: none) and the relief drawn: hidden it does nothing; shown, the clouds built
   * at the last look are drawn (or, one frame before, their radar part is built), the clouds and the fog follow the relief and
   * the night, and once a second it looks.
   */
  update(aircraft: Aircraft | null, nowMs: number, tf: TerrainFrame = TRUE_RELIEF): void {
    if (!this.#show) return
    this.#fNow = tf.fNow
    this.#relHM = tf.relHM
    if (this.#pending !== null) {
      this.#sky.clouds.draw(this.#pending.clouds)
      this.#sky.shafts.draw(this.#pending.shafts)
      this.#pending = null
    } else if (this.#staged !== null) this.#buildRadar() // one heavy piece of work a frame: the look, this, the draw
    this.#sky.clouds.frame(tf, this.#night)
    this.#sky.shafts.frame(tf, this.#night)
    this.#sky.fog.frame(tf, this.#night)
    this.#easeShade(nowMs)
    if (this.#falling && nowMs - this.#aimedMs >= AIM_MS) {
      this.#aimedMs = nowMs
      this.#sky.precip.aim(this.#viewer.camera.heading)
    }
    if (aircraft === null || !Number.isFinite(aircraft.lat) || !Number.isFinite(aircraft.lon)) return
    const a = this.#here
    a.lat = aircraft.lat
    a.lon = aircraft.lon
    a.altM = aircraft.altM
    if (!this.#seen) {
      this.#seen = true
      if (this.#at !== null) {
        this.#shift.dLat = a.lat - this.#at.lat
        this.#shift.dLon = a.lon - this.#at.lon
      }
    }
    if (nowMs - this.#lookedMs < LOOK_MS) return
    this.#lookedMs = nowMs
    this.#settleTiles(nowMs)
    this.#ask(nowMs)
    this.#refresh()
  }

  destroy(): void {
    if (this.#destroyed) return
    const alive = !this.#viewer.isDestroyed() // gone first: nothing of its to touch
    if (alive) this.show = false
    this.#show = false
    this.#destroyed = true
    this.#sky.precip.destroy() // the overlay is the page's
    if (!alive) return
    void this.#viewer.dataSources.remove(this.#volumes, true)
    this.#sky.clouds.destroy()
    this.#sky.shafts.destroy()
    this.#sky.fog.destroy()
  }

  /** Asks for what is due: the SIGMETs and the radar frame by the clock, the METARs by the clock or when the aircraft is out of its box. */
  #ask(nowMs: number): void {
    if (nowMs >= this.#sigmetsDue) {
      this.#sigmetsDue = nowMs + SLOW_EVERY_MS
      void this.#loadSigmets(nowMs)
    }
    if (nowMs >= this.#radarDue) {
      this.#radarDue = nowMs + SLOW_EVERY_MS
      void this.#loadRadar(nowMs)
    }
    const lat = this.#here.lat - this.#shift.dLat // where the aircraft is in the weather's own place
    const lon = wrapLon(this.#here.lon - this.#shift.dLon)
    const b = this.#box
    if (b === null || nowMs >= this.#metarsDue || lat < b[0] || lat > b[2] || lon < b[1] || lon > b[3]) {
      // ponytail: the box stops at ±180° and the poles: stations across the antimeridian are not asked for. Upgrade: a second box there.
      const key = viewBox({ west: lon - BOX_DEG, south: lat - BOX_DEG, east: lon + BOX_DEG, north: lat + BOX_DEG })
      if (key === null) return
      const box = key.split(',').map(Number) as unknown as Box
      this.#box = box
      this.#metarsDue = nowMs + METAR_EVERY_MS
      void this.#loadMetars(box, nowMs)
    }
  }

  /**
   * One source's ask: the answer read (a failure is one warning), then, unless it is out of date by now (`current`: the app is
   * gone, or another ask has taken its place), the source noted down or up and the answer (null: it failed) handed on. An answer
   * out of date is not heard at all: a late failure cannot put the note up over an ask that has since been answered.
   */
  async #fetch<T>(feed: Feed, url: string, read: (json: unknown) => T, current: () => boolean, apply: (got: T | null) => void): Promise<void> {
    let got: T | null = null
    try {
      got = read(await this.#getJson(url))
    } catch (e) {
      if (current()) console.warn(`FlightHopper: 3-D weather ${url}:`, e)
    }
    if (!current()) return
    if (got === null) this.#down.add(feed)
    else this.#down.delete(feed)
    apply(got)
  }

  #loadMetars(box: Box, askedMs: number): Promise<void> {
    return this.#fetch('metar', `${this.#apiBase}/wx/metar?bbox=${box.join(',')}`, metarsOf, () => !this.#destroyed && box === this.#box, (list) => {
      if (list === null) this.#metarsDue = Math.min(this.#metarsDue, askedMs + RETRY_MS)
      else {
        this.#metars = shiftMetars(list, this.#shift.dLat, this.#shift.dLon)
        this.#metarGen++
      }
      this.#refresh() // the clouds built from them, and the line
    })
  }

  #loadSigmets(askedMs: number): Promise<void> {
    return this.#fetch('sigmet', `${this.#apiBase}/wx/sigmet`, sigmetsOf, () => !this.#destroyed, (list) => {
      if (list === null) this.#sigmetsDue = Math.min(this.#sigmetsDue, askedMs + RETRY_MS)
      else {
        this.#sigmets = shiftSigmets(list, this.#shift.dLat, this.#shift.dLon)
        this.#gen++
      }
      this.#refresh()
    })
  }

  #loadRadar(askedMs: number): Promise<void> {
    return this.#fetch('radar', RADAR_INDEX, frameOf, () => !this.#destroyed, (frame) => {
      if (frame === null) this.#radarDue = Math.min(this.#radarDue, askedMs + RETRY_MS)
      else {
        const source = new RadarSource(frame.host, frame.path)
        if (this.#radar?.url !== source.url) {
          this.#radar = source // the frame held keeps its decoded tiles
          this.#radarGen++
        }
      }
      this.#status()
    })
  }

  /**
   * The hazard areas picked (again when the SIGMETs changed or the aircraft moved far enough), and what shows them drawn when
   * it changed; the sky looked at.
   */
  #refresh(): void {
    if (!this.#show || !this.#seen) return
    const a = this.#here
    if (this.#pickedGen !== this.#gen || !(distanceNm(a.lat, a.lon, this.#pickedLat, this.#pickedLon) * KM_PER_NM < PICK_KM)) {
      this.#hazards = hazardsNear(this.#sigmets, a.lat, a.lon, HAZARD_KM)
      this.#pickedGen = this.#gen
      this.#pickedLat = a.lat
      this.#pickedLon = a.lon
    }
    const volumes = this.#hazards.map((h) => h.key).join('|') // '': nothing to draw
    if (volumes !== this.#volumeKey) {
      this.#volumeKey = volumes
      this.#drawVolumes()
    }
    const u = this.#units()
    const labels = volumes === '' ? '' : `${volumes}:${u.alt}`
    if (labels !== this.#labelKey) {
      this.#labelKey = labels
      this.#labels.setLayer(LABEL_KEY, LABEL_RANK, this.#hazards.map((h) => this.#label(h, u)))
    }
    if (this.#builtGen !== this.#metarGen || this.#builtRadar !== this.#radarGen || !(distanceNm(a.lat, a.lon, this.#builtLat, this.#builtLon) * KM_PER_NM < REBUILD_KM)) this.#buildClouds()
    const from = Cartesian3.fromDegrees(a.lon, a.lat, a.altM, Ellipsoid.WGS84, this.#hereWC)
    this.#sky.clouds.fade(from)
    this.#sky.shafts.fade(from)
    this.#sky.fog.set(fogNear(this.#metars, a.lat, a.lon))
    const fall = this.#fall()
    this.#sky.precip.set(fall)
    if (fall !== null && !this.#falling) this.#aimedMs = -Infinity // aimed at the next frame
    this.#falling = fall !== null
    this.#shadeTarget = this.#overcast()
    this.#status()
  }

  /**
   * The clouds and rain shafts round the aircraft: the observed clouds built now, then the radar's, within one cap; the radar's
   * keep RADAR_LOOK.reserve of it when it has so many, the observed ones giving way, the farthest first. Where the tiles held
   * have an echo the radar's part (the heavier) is built at the next frame (#buildRadar), else it is nothing but the asking for
   * its tiles and is done here. Drawn at the frame after.
   */
  #buildClouds(): void {
    const a = this.#here
    const observed = observedClouds(this.#metars, a.lat, a.lon, { cache: this.#made })
    this.#stations = observed.stations
    this.#builtGen = this.#metarGen
    this.#builtLat = a.lat
    this.#builtLon = a.lon
    this.#staged = observed.specs
    if (!this.#echoes()) this.#buildRadar()
  }

  /** The sky from the observed clouds staged and the radar's, at the aircraft's place now: to be drawn at the next frame. */
  #buildRadar(): void {
    const a = this.#here
    const observed = this.#staged!
    this.#staged = null
    const radar = this.#radarSky()
    const clouds = radar.clouds.length === 0
      ? nearestClouds([observed], a.lat, a.lon)
      : nearestClouds([nearestClouds([observed], a.lat, a.lon, MAX_CLOUDS - Math.min(radar.clouds.length, RADAR_LOOK.reserve)), radar.clouds], a.lat, a.lon)
    this.#pending = { clouds, shafts: radar.shafts }
    this.#builtRadar = this.#radarGen
  }

  /** Whether any tile held has an echo (else the radar has no clouds to build). */
  #echoes(): boolean {
    for (const t of this.#tiles.values()) if (t.tile !== null) return true
    return false
  }

  /**
   * The radar's clouds and rain shafts within RADAR_LOOK.radiusKm of the aircraft, and the ring beyond it that a rebuild reads
   * (REBUILD_KM: it stands hidden and fades in as the aircraft comes), from the frame's tiles that have come (a tile not come is
   * asked for, and the clouds are built again when it has), on the bases the nearest stations' reports give. The radar is read at
   * the aircraft's place less the ?wxat shift, and the cells come out at their place plus it.
   */
  #radarSky(): { clouds: CloudSpec[]; shafts: RainShaft[] } {
    const a = this.#here
    const { dLat, dLon } = this.#shift
    const cells = radarCells((x, y) => this.#tileAt(x, y), a.lat - dLat, wrapLon(a.lon - dLon), this.#shift, RADAR_LOOK.radiusKm + REBUILD_KM)
    if (cells.length === 0) return { clouds: [], shafts: [] }
    const base = radarBases(this.#metars)
    return { clouds: radarClouds(cells, base), shafts: pickShafts(cells, base) }
  }

  /** The overcast's grey over the camera: the nearest station's (within its 30 km) broken or overcast layer above it. */
  #overcast(): number {
    const c = this.#viewer.camera.positionCartographic
    const lat = CesiumMath.toDegrees(c.latitude)
    const lon = CesiumMath.toDegrees(c.longitude)
    const station = overcastShade(nearestStation(this.#metars, lat, lon), c.height)
    // Rain on the radar over the camera is cloud overhead too, whatever the nearest report says (an estimate, by eye).
    const echo = this.#echo(lat - this.#shift.dLat, wrapLon(lon - this.#shift.dLon))
    return Math.max(station, echo === null ? 0 : echoShade(echo.dbz))
  }

  /** The sky's grey eased toward the look's; written to the sky in steps of 1 % and at the target. */
  #easeShade(nowMs: number): void {
    const dt = Number.isFinite(this.#shadeMs) ? Math.min(0.25, Math.max(0, (nowMs - this.#shadeMs) / 1000)) : 0
    this.#shadeMs = nowMs
    if (this.#shade === this.#shadeTarget) return
    const next = this.#shade + (this.#shadeTarget - this.#shade) * Math.min(1, dt / SHADE_EASE_S)
    this.#shade = Math.abs(this.#shadeTarget - next) < 0.001 ? this.#shadeTarget : next
    if (Math.abs(this.#shade - this.#written) >= 0.01 || this.#shade === this.#shadeTarget) this.#writeSky(this.#shade)
  }

  /** The sky's grey at once (hidden: none). */
  #greySky(shade: number): void {
    this.#shade = this.#shadeTarget = shade
    this.#writeSky(shade)
  }

  #writeSky(shade: number): void {
    this.#written = shade
    const sky = this.#viewer.isDestroyed?.() ? undefined : this.#viewer.scene?.skyAtmosphere
    if (sky === undefined) return
    sky.saturationShift = -SKY_DESATURATE * shade
    sky.brightnessShift = -SKY_DARKEN * shade
  }

  /**
   * What falls round the camera, or nothing: the radar under it (at its place less the ?wxat shift), else the nearest
   * station's weather within 30 km; nothing above that station's cloud base + 300 m, or 3 km above the ground with no base.
   */
  #fall(): Fall | null {
    const c = this.#viewer.camera.positionCartographic
    const lat = CesiumMath.toDegrees(c.latitude)
    const lon = CesiumMath.toDegrees(c.longitude)
    const st = nearestStation(this.#metars, lat, lon)
    const echo = this.#echo(lat - this.#shift.dLat, wrapLon(lon - this.#shift.dLon))
    const p = (echo === null ? null : precipFromDbz(echo.dbz, echo.snow)) ?? (st === null ? null : precipFromWx(st.wx))
    if (p === null || !(c.height <= this.#precipTop(st, c))) return null
    return { ...p, wind: windOf(st), night: this.#night }
  }

  /** How high rain or snow shows, metres above the ellipsoid as drawn: 300 m over the station's cloud base (moved with its ground), else 3 km over the ground. */
  #precipTop(st: Metar | null, c: Cartographic): number {
    const base = st === null ? null : cloudBaseM(st)
    if (st === null || base === null || st.elevM === null) return (this.#viewer.scene.globe.getHeight(c) ?? 0) + PRECIP_OVER_GROUND_M
    const n = geoidN(st.lat, st.lon)
    const ground = st.elevM + n
    return base + n + drawnHeightM(ground, this.#fNow, this.#relHM) - ground + PRECIP_OVER_BASE_M
  }

  /** The radar's strongest echo round a place (RainViewer's own), from its decoded zoom-7 tile; null until the tile has come, or no echo. */
  #echo(lat: number, lon: number): { dbz: number; snow: boolean } | null {
    const { x, y, px, py } = radarPixel(lat, lon)
    const tile = this.#tileAt(x, y)
    return tile === null ? null : radarSample(tile, px, py)
  }

  /**
   * The decoded zoom-7 tile x, y of the radar's newest frame, asked for once: null until it has come, or when it has no echo. Until
   * the newest frame's tile has come, the last frame's stands in for it, so a swap of frames leaves no gap. When a tile comes that
   * reads differently the radar's clouds are built again (#settleTiles). The rain overlay (#echo) and the radar's clouds read their
   * tiles here. About as many are kept as the box the radar is read in touches (#held), the first to have come going first (and
   * asked for again if wanted: the source has it).
   */
  #tileAt(x: number, y: number): SourceTile | null {
    const radar = this.#radar
    if (radar === null) return null
    const url = radar.url
    if (url !== this.#askedFrom) {
      this.#askedFrom = url
      this.#asked.clear()
    }
    const key = `${x}/${y}`
    if (!this.#asked.has(key)) {
      this.#asked.add(key)
      this.#loading++
      void this.#tile(radar, RADAR_SRC_MAX, x, y).then((tile) => {
        this.#loading--
        if (url !== this.#askedFrom && this.#tiles.get(key)?.url === this.#askedFrom) return // a frame gone by does not replace the newest's tile
        const before = this.#tiles.get(key)?.tile ?? null
        this.#tiles.delete(key)
        this.#tiles.set(key, { url, tile })
        while (this.#tiles.size > this.#held()) {
          const oldest = this.#tiles.keys().next().value!
          this.#tiles.delete(oldest)
          this.#asked.delete(oldest)
        }
        if (tile !== before && !this.#landed) { // an empty tile where there was none changes nothing
          this.#landed = true
          this.#landedMs = this.#lookedMs
        }
      })
    }
    return this.#tiles.get(key)?.tile ?? null
  }

  /** How many decoded tiles to keep: those the box the radar is read in can touch, and a row and a column more for the way on (never fewer than TILES_FLOOR). */
  #held(): number {
    const n = tilesAcross(this.#here.lat - this.#shift.dLat, RADAR_LOOK.radiusKm + REBUILD_KM) + 1
    return Math.max(TILES_FLOOR, n * n)
  }

  /**
   * Tiles that have come are new radar data once none is still on its way (one build for them all: a build at each look while they
   * came one by one would be a hitch each time), or TILE_WAIT_MS after the first, so a tile that is slow is not waited for long.
   */
  #settleTiles(nowMs: number): void {
    if (this.#landed && (this.#loading === 0 || nowMs - this.#landedMs >= TILE_WAIT_MS)) {
      this.#landed = false
      this.#radarGen++
    }
  }

  #drawVolumes(): void {
    const ents = this.#volumes.entities
    ents.suspendEvents()
    ents.removeAll()
    for (const h of this.#hazards) {
      const color = Color.fromCssColorString(sigmetColor(h.sigmet.hazard))
      for (const ring of h.rings) {
        ents.add({
          polygon: {
            hierarchy: Cartesian3.fromDegreesArray(ring.flat()), height: h.baseM, extrudedHeight: h.topM,
            material: color.withAlpha(FILL_ALPHA), outline: true, outlineColor: color.withAlpha(LINE_ALPHA),
          },
        })
      }
    }
    ents.resumeEvents()
  }

  #label(h: Hazard, u: Units): LayerLabel {
    const c = ringCentre(h.nearest)
    return { text: sigmetLabel(h.sigmet, u), position: Cartesian3.fromDegrees(c.lon, c.lat, h.topM), color: sigmetColor(h.sigmet.hazard) }
  }

  /** The panel's line, written when it changes; hidden, the app owns it. */
  #status(): void {
    if (!this.#show) return
    const text = statusText3d({ airports: this.#stations, areas: this.#hazards.length, note: this.#down.size > 0 ? NOTE : '' })
    if (text === this.#line) return
    this.#line = text
    this.#onStatus(text)
  }
}

// client/scene/weather3d.ts
// The weather round the chased aircraft, in 3-D (the Layers panel's Weather switch, in the chase). Weather3D keeps what the
// aircraft flies through, for the parts that draw it:
// - the airports' reports (METARs) of the whole-degree box 2° round it, asked again every 5 min and at once when it leaves the box;
// - the hazard areas (SIGMETs) and RainViewer's newest radar frame (a RadarSource: its tiles are fetched when something
//   samples them, as the top-down map's radar does), each every 10 min;
// - a weather model's forecast (Open-Meteo, through the server): a grid of 7 × 7 places 0.25° apart round the 0.5° cell the aircraft
//   is in, asked again every 30 min and when the aircraft leaves the inner half of the grid held (not within 30 s of the last ask),
//   and not before the aircraft has stayed MODEL_DWELL_MS in its place: a hop or an auto-follow to a distant aircraft that moves on
//   within seconds costs nothing, and the grid held goes on drawing. A failed ask is made again in 30 s, or, when the server says
//   when it will ask Open-Meteo again (a 503's retryAfterS), then, at most 30 min on: one warning for a whole outage.
//   A forecast, not an observation: it draws only what nothing else says, and the wind it gives is an estimate. A grid whose hour is
//   more than 3 h old is not used (its server serves the places it holds when Open-Meteo cannot be asked), and is asked for again.
//   While one is held the panel's line carries Open-Meteo's credit (CC BY 4.0).
// It draws the hazard areas that have a top and whose ring passes within 800 km of the aircraft (wxGeo.ts picks them): the cloud
// volume draws each ring's edge from the area's base (none: the ground) to its top, in the style chosen (hazardStyle: a curtain, a
// fence or a box), so that the edge sorts with the cloud; under a curtain or a fence the ring's footprint lies on the ground (its
// outline and a striped fill, Cesium's: the ground has depth, so cloud covers it rightly); and the area's name and heights are a label
// at the ring's middle at the top height, placed with the place names (placeLabels.ts keeps them clear of each other and of the
// flight-data frame). A list of SIGMETs that brings the same areas draws nothing again.
// And the sky a pilot would see (a Sky: Cesium's parts in the app):
// - clouds from the airports' reports (cloudField.ts) within 150 km, built when new reports come or the aircraft has moved
//   30 km, and drawn the frame after (the work spread over two frames) by the one cloud volume (cloudVolume.ts: it lays every
//   source's cloud specs into a weather field round the aircraft and draws that as volumes, in the look chosen). Clouds of
//   other sources join the same list after the observed ones (#buildClouds);
// - rain clouds from the radar's newest frame: towers where it rains hard, flat decks where it rains lightly (cloudField.ts
//   radarClouds); the volume draws the rain under them. The frame is read to 180 km (RADAR_READ_KM): as far as the volume shows a
//   cloud (150 km: its reach, which fades over the last 20) and the 30 km to the next build past that, so that what a build adds is
//   out of reach and comes in through the fade as the aircraft closes, not at once at full strength. Built from the
//   frame's zoom-7 tiles (radarCells.ts) at the same time as the observed clouds (the look builds those; where the tiles hold an
//   echo the radar's part, the heavier, is built the frame after, and both are drawn the frame after that), and again when
//   the aircraft has moved 30 km, or when a tile or a newer frame has come (the tiles that come one by one are waited for: one
//   build, when the last has come, at most 3 s after the first); until a newer frame's tile has come the last frame's stands in
//   for it. They stand on the nearest station's ceiling (cloudField.ts radarBases), and RADAR_LOOK.reserve of the 700 clouds are
//   kept for them;
// - the model's clouds (cloudField.ts modelClouds), the lowest priority: after the observed and the radar's clouds, they fill what is
//   left of the 700 (none where those fill it). Worked out once for a grid and the reports held, so a rebuild for a radar tile or 30 km
//   of flight reuses them; a grid's arrival builds the sky again. windAt gives the model's wind at a place and pressure altitude: the
//   flight-data frame's when the aircraft sends none (app.ts, live chase only);
// - ground fog round a station near the aircraft that sees little (groundFog.ts);
// - rain or snow round the camera, from the radar under it or the nearest station's weather, below the cloud: a light
//   screen overlay (precip.ts), leaned with the wind across the camera's view a few times a second.
// Every frame the clouds and the fog are given the relief drawn and the Sun's night (setNight); the rest is looked at
// once a second, when the clouds' reach is also centred on the aircraft.
// It also hands the cloud volume the way ahead of the chased aircraft (wxAhead.ts aheadPath, given every frame by app.ts: setAhead)
// with which of its two aids show, the track line and the level slice: the volume draws them.
// Every frame it also gives the frames' times to a pace (marchPace.ts), which says how fine the volume's march is walked: coarser
// when the frames have been slow for a while, never to and fro.
// Should the volume's pass fail (cloudVolume.ts: a render error takes it out for good, a shader this graphics card will not compile
// among them), the rest goes on: the panel's line says "3-D clouds stopped after a drawing error", the app is told once
// (onCloudsFailed: it takes the Weather menu away and says the note), and the hazard areas, whose edges the pass drew, are marked by
// their footprints on the ground in every style. ?wxbreak=1 is a check aid for this: it makes the pass's shader not compile.
// `known` says whether any source of clouds has answered yet: until one has, an empty sky is not a clear one (the status line's).
// ponytail: what a build adds can still appear at once in two cases. The field is a square of 160 km each way, so due east, west,
// north and south of a build's place it holds only 10 km of the 30 km beyond the reach: a band 120 to 150 km off on those lines
// appears at a build, inside the reach's fade. And the observed and the model's clouds are kept by their puffs' own fade (farKm and
// 30 km), not by the reach: small cumulus 66 to 96 km out appear at full strength at a build. Upgrade: end the reach 30 km inside the
// field's rim (or a larger field), and keep every source's clouds by the one reach.
// Live only: app.ts shows it in a live chase, not in History or a scenario (it is today's sky). Hidden it asks for nothing and
// draws nothing, and update() returns at once; shown, it looks at its clocks and the aircraft once a second.
// ?wxat=<lat>,<lon> is a check aid (the UI does not mention it): a replay's aircraft flies where the sky may be clear, so the
// weather is taken from round that place and moved by the one shift that puts the place under the aircraft's first position.
// From then on the aircraft flies through that sky. Everything it holds is where it is drawn (shifted); the radar's tiles are
// RainViewer's own, so a sample at a drawn place is taken at that place less the shift.
// ?wxdemo=<km> is another (parseWxDemo): no weather is asked for at all; the sky is wxDemo.ts's made-up one (cumulus, a rain layer, two
// storms in a hazard area), laid out once along the aircraft's track from its first place, the aircraft that many km into it.
// ?wxbreak=1 is a third (parseWxBreak): the cloud pass is given a shader that does not compile, so that its failure is seen handled
// on any machine (with ?wxdemo=1 the pass, and so the failure, comes at once). ?wxscale=0.5, 0.35 or 0.25 is a fourth (parseWxScale):
// the cloud march held at that size, the frames' times not asked.
import { Cartesian3, ClassificationType, Color, CustomDataSource, Ellipsoid, Math as CesiumMath, StripeMaterialProperty, StripeOrientation, type Cartographic, type Viewer } from 'cesium'
import { distanceNm } from '../../shared/geo.ts'
import { geoidN } from '../../shared/geoid.ts'
import { MODEL_CELL_DEG, type Metar, type ModelGrid, type Sigmet } from '../../shared/wx.ts'
import type { TerrainFrame } from '../types.ts'
import { DEFAULT_UNITS, type Units } from '../ui/units.ts'
import { MAX_CLOUDS, RADAR_LOOK, REBUILD_KM, modelClouds, nearestClouds, observedClouds, overcastShade, radarBases, radarClouds, type CloudSpec } from './cloudField.ts'
import { CloudVolume, REACH_KM, resumeRendering, type CloudLook, type HazardStyle } from './cloudVolume.ts'
import { MARCH_SCALES, MarchPace } from './marchPace.ts'
import { drawnHeightM } from './exaggeration.ts'
import { GroundFog, fogNear } from './groundFog.ts'
import { inInnerHalf, modelWindAt, type ModelWind } from './modelWind.ts'
import type { LayerLabel, PlaceLabels } from './placeLabels.ts'
import { Precipitation, cloudBaseM, nearestStation, precipFromDbz, precipFromWx, radarPixel, radarSample, windOf, type Fall } from './precip.ts'
import { RADAR_INDEX, RADAR_SRC_MAX, RadarSource, type RadarIndex, type SourceTile } from './radar.ts'
import { radarCells, tilesAcross } from './radarCells.ts'
import { hazardsNear, ringCentre, shiftMetars, shiftModel, shiftSigmets, viewBox, wrapLon, type Hazard } from './wxGeo.ts'
import type { AheadPath } from './wxAhead.ts'
import { demoSky } from './wxDemo.ts'
import type { WxField } from './wxField.ts'
import { MODEL_CREDIT, sigmetColor, sigmetLabel } from './wxText.ts'

const BOX_DEG = 2 // the METAR box reaches this far from the aircraft each way, rounded out to whole degrees
const METAR_EVERY_MS = 5 * 60_000
const SLOW_EVERY_MS = 10 * 60_000 // SIGMETs and the radar frame
const MODEL_EVERY_MS = 30 * 60_000 // the model's values are hourly; the server keeps a place this long
const MODEL_N_MAX = 15 // a grid of more places a side than this is not the server's
const MODEL_MAX_AGE_MS = 3 * 60 * 60_000 // a grid whose hour is older than this is not used
/** The model is asked for once the aircraft has stayed this long: a grid is up to 157 of Open-Meteo's calls, and a hop that moves on within seconds should cost none. */
export const MODEL_DWELL_MS = 10_000
const RETRY_MS = 30_000 // a failed ask is made again after this
const LOOK_MS = 1000 // update() looks at its clocks and the aircraft this often
export const HAZARD_KM = 800 // hazard areas are drawn when their ring passes this near the aircraft
const PICK_KM = 10 // the hazard areas are picked again once the aircraft has moved this far
// A hazard area's footprint on the ground, under a curtain or a fence (the mock's hatch): its fill's stripes, alike wide whatever
// the ring's size, their two alphas, and its outline.
const STRIPE_KM = 3
const STRIPE_ALPHA: readonly [number, number] = [0.26, 0.09]
const STRIPE_TURN = Math.PI / 4 // the fill's texture is turned so that its upward axis points north-east: the stripes, laid across that axis, are a diagonal hatch (the mock's)
const OUTLINE_ALPHA = 0.9
const OUTLINE_PX = 2.5
const LABEL_KEY = 'hazards' // this layer in the names overlay
const LABEL_RANK = 1.5 // after the seas (1), before every city (2)
const NOTE = 'some weather unavailable'
const NO_CLOUDS = '3-D clouds stopped after a drawing error' // the cloud volume's pass failed (cloudVolume.ts): any render error while it was in the scene, a shader this graphics card will not compile among them
const KM_PER_NM = 1.852
const KM_PER_DEG = 111.195 // of latitude, on a sphere of 6,371 km
/**
 * The radar is read this far from the aircraft: as far as the cloud volume shows a cloud, and the way to the next build past that.
 * What a build adds then stands out of the volume's reach and comes in through its fade as the aircraft closes. (The field is a square
 * of 160 km each way, so due east, west, north and south of a build's place it holds only 10 km of that way.)
 */
const RADAR_READ_KM = REACH_KM[1] + REBUILD_KM
/** A hazard area's colour: its edges', its footprint's and its label's. */
const hazardColor = (h: Hazard): string => sigmetColor(h.sigmet.hazard)
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

/** The chased aircraft: degrees, and metres above the ellipsoid as it is drawn; the way it flies, degrees true (the demo sky is laid along it). */
export interface Aircraft {
  lat: number
  lon: number
  altM: number
  trackDeg?: number
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

/** The panel's one-line summary: "Clouds from 3 airports · 2 hazard areas · Weather data by Open-Meteo.com" (the credit while the forecast model's grid is in use). */
export function statusText3d(s: { airports: number; areas: number; model: boolean; note: string }): string {
  const count = (n: number, what: string): string => `${n} ${what}${n === 1 ? '' : 's'}`
  const from = s.airports === 0 && s.model ? 'the forecast' : count(s.airports, 'airport') // over the sea the forecast draws them all
  return [`Clouds from ${from}`, count(s.areas, 'hazard area'), ...(s.model ? [MODEL_CREDIT] : []), ...(s.note ? [s.note] : [])].join(' · ')
}

/**
 * ?wxdemo: the demo sky in place of the real weather (a check aid), and how many km along it the aircraft starts. ?wxdemo=1 is its
 * start (0 km); ?wxdemo=60 starts in its rain layer, ?wxdemo=98 at its storm. None when absent or not a number.
 */
export function parseWxDemo(search: string): number | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*$/.exec(new URLSearchParams(search).get('wxdemo') ?? '')
  if (m === null) return null
  const km = Number(m[1])
  return km === 1 ? 0 : km
}

/** ?wxbreak=1: the cloud pass's shader is made not to compile (a check aid: the failure's handling is then seen on any machine). */
export const parseWxBreak = (search: string): boolean => new URLSearchParams(search).get('wxbreak') === '1'

/** ?wxscale=0.5, 0.35 or 0.25: the cloud march held at that size, whatever the frames' times (a check aid); none when absent or another number. */
export function parseWxScale(search: string): number | null {
  const scale = Number(new URLSearchParams(search).get('wxscale') ?? '')
  return MARCH_SCALES.includes(scale) ? scale : null
}

type Box = readonly [south: number, west: number, north: number, east: number]
type Feed = 'metar' | 'sigmet' | 'radar' | 'model'

/** What draws the sky round the aircraft: Cesium's parts in the app (cesiumSky), fakes in tests. */
export interface Sky {
  clouds: Pick<CloudVolume, 'show' | 'draw' | 'frame' | 'fade' | 'destroy' | 'setHazards' | 'setAhead'> & Partial<Pick<CloudVolume, 'look' | 'field' | 'failed' | 'scale'>>
  fog: Pick<GroundFog, 'set' | 'frame' | 'destroy'>
  precip: Pick<Precipitation, 'set' | 'aim' | 'destroy'>
}

/**
 * The sky's parts in the viewer: the cloud volume and the fog in its scene, the rain or snow overlay in its element (the globe's).
 * Should the volume's pass fail (a render error while it is in the scene: Cesium has then stopped rendering), the viewer's render
 * loop is started again without it, and onCloudsFailed is told. broken: ?wxbreak, the pass's shader made not to compile.
 * ponytail: cloudLayer.ts (the clouds as Cesium's puffs) and rainShafts.ts stay in the tree, unused, until the user has accepted the
 * volumes. Upgrade: delete them, their tests, and what of cloudField.ts only they read.
 */
const cesiumSky = (viewer: Viewer, onCloudsFailed: () => void, broken: boolean): Sky => ({
  clouds: new CloudVolume(viewer.scene, {
    broken,
    onFailed: () => {
      resumeRendering(viewer)
      onCloudsFailed()
    },
  }),
  fog: new GroundFog(viewer.scene), precip: new Precipitation(viewer.container as HTMLElement),
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
  epochMs?: () => number // the wall clock the model's grid is dated by; default Date.now
  onShade?: (shade: number) => void // the sky's grey (0 … 1) as it is written, 0 when hidden: the Sun dims its light by it
  dwellMs?: number // how long the aircraft stays before the model is asked for; default MODEL_DWELL_MS
  demo?: number | null // ?wxdemo: the km along the demo sky the aircraft starts at; null or absent: the real weather
  broken?: boolean // ?wxbreak=1: the cloud pass's shader is made not to compile, to see the failure handled
  scale?: number | null // ?wxscale: the cloud march held at this size; null or absent: by the frames' times (marchPace.ts)
  onCloudsFailed?: (note: string) => void // told once, with the words for it, when the cloud pass has failed for good (the Weather menu's choices then do nothing)
}

/** A non-OK answer: its status, and the seconds the server said to wait (a 503's retryAfterS), if it did. */
export class HttpError extends Error {
  readonly status: number
  readonly retryAfterS: number | undefined
  constructor(status: number, retryAfterS?: unknown) {
    super(`HTTP ${status}`)
    this.status = status
    this.retryAfterS = typeof retryAfterS === 'number' && retryAfterS > 0 && Number.isFinite(retryAfterS) ? retryAfterS : undefined
  }
}

/** The wait after a failed model ask: 30 s, or what a 503 says if that is longer, but never more than the usual 30 min. */
function retryAfterMs(why: unknown): number {
  const asked = why instanceof HttpError && why.retryAfterS !== undefined ? why.retryAfterS * 1000 : 0
  return Math.min(MODEL_EVERY_MS, Math.max(RETRY_MS, asked))
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { retryAfterS?: unknown } | null // a 503 of the model's says how long to wait
    throw new HttpError(res.status, body?.retryAfterS)
  }
  return res.json()
}

function listOf<T>(json: unknown, usable: (x: T) => boolean): T[] {
  if (!Array.isArray(json)) throw new Error('not a list')
  return (json as T[]).filter(usable)
}

const metarsOf = (json: unknown): Metar[] => listOf<Metar>(json, (m) => Number.isFinite(m?.lat) && Number.isFinite(m?.lon))
const sigmetsOf = (json: unknown): Sigmet[] => listOf<Sigmet>(json, (s) => Array.isArray(s?.rings))

/** The server's grid, or a thrown error: places and levels are read warily afterwards (a missing value is none), but not a grid of another shape. */
function modelOf(json: unknown): ModelGrid {
  const g = json as Partial<ModelGrid> | null
  const level = (l: unknown, a: string, b: string): boolean => {
    const x = l as Record<string, unknown> | null
    return Number.isFinite(x?.hPa) && Array.isArray(x?.[a]) && Array.isArray(x?.[b])
  }
  const ok = g !== null && typeof g === 'object' && [g.lat0, g.lon0, g.step].every(Number.isFinite) && g.step! > 0 && Number.isInteger(g.n) && g.n! >= 1 && g.n! <= MODEL_N_MAX
    && Array.isArray(g.elevM) && Array.isArray(g.clouds) && g.clouds.every((l) => level(l, 'cover', 'zM')) && Array.isArray(g.winds) && g.winds.every((l) => level(l, 'kt', 'deg'))
  if (!ok) throw new Error('not a model grid')
  return g as ModelGrid
}

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
  readonly #epochMs: () => number
  readonly #onShade: (shade: number) => void
  readonly #dwellMs: number
  readonly #demo: number | null
  readonly #onCloudsFailed: (note: string) => void
  readonly #scale: number | null // ?wxscale: the march's size, held
  readonly #pace = new MarchPace() // how fine the cloud march is walked, by the frames' times
  #frameMs = Number.NaN // the last frame's time, for the pace
  #cloudsFailed = false // the cloud pass's failure has been seen and told
  #known = false // a source of clouds has answered: the sky is not a guess
  #demoSpecs: CloudSpec[] | null = null // the demo sky's clouds, once it is laid out
  #look: CloudLook
  #hazardStyle: HazardStyle = 'box'
  #ahead: AheadPath | null = null
  readonly #aheadShow = { track: false, slice: false }
  readonly #footprints = new CustomDataSource('hazard-footprints') // each ring's outline and striped fill on the ground, under a curtain or a fence
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
  #hazardKey = '' // the hazard areas the cloud volume and the footprints were last given
  #labelKey = ''
  #line: string | null = null // the last summary written
  #model: ModelGrid | null = null // the model's grid, as drawn (shifted by ?wxat)
  #modelDue = -Infinity
  #modelAskedMs = -Infinity // when the grid was last asked for
  #modelRetryMs = RETRY_MS // how soon after an ask a grid that is wanted is asked for again: 30 s, after a failure what a 503 says if longer
  #cell = '' // the 0.5° cell the aircraft was in at the last look ('' before the first, and again when the weather is shown)
  #wanted = false // the grid held did not serve the aircraft at the last look
  #stoodMs = -Infinity // the dwell's clock: since the weather was shown, the aircraft came into its cell, or the grid held stopped serving it
  #modelAsk = 0 // the ask in hand: an answer to an earlier one is not heard
  #modelGen = 0 // the grid held: the clouds are built again from it when it changes (or when it grows too old to use)
  #modelOld = false // the grid held was too old to use at the last look
  #builtModel = -1
  #modelMade: { grid: ModelGrid; metars: readonly Metar[]; specs: CloudSpec[] } | null = null // the model's clouds, kept for the grid and the reports they were made from
  #metarGen = 0 // the METAR list held: the clouds are built again from it when it changes
  #builtGen = -1
  #builtLat = Number.NaN // where the aircraft was when the clouds were built
  #builtLon = Number.NaN
  #stations = 0 // the stations the clouds were built from
  #pending: { clouds: CloudSpec[]; at: { lat: number; lon: number } } | null = null // built round a place, drawn at the next frame
  #drawMs = 0 // how long the last draw took
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
    this.#onCloudsFailed = opts.onCloudsFailed ?? (() => {})
    this.#scale = opts.scale ?? null
    this.#sky = opts.sky ?? cesiumSky(viewer, () => this.#seeFailed(), opts.broken === true)
    this.#tile = opts.tile ?? ((radar, z, x, y) => radar.get(z, x, y))
    this.#epochMs = opts.epochMs ?? Date.now
    this.#onShade = opts.onShade ?? (() => {})
    this.#dwellMs = opts.dwellMs ?? MODEL_DWELL_MS
    this.#demo = opts.demo ?? null
    this.#look = this.#sky.clouds.look ?? 'severity'
    this.#footprints.show = false
    void viewer.dataSources.add(this.#footprints)
  }

  get show(): boolean {
    return this.#show
  }

  set show(on: boolean) {
    if (this.#destroyed || on === this.#show) return
    this.#show = on
    this.#footprints.show = on
    this.#sky.clouds.show = on
    if (on) {
      this.#cell = '' // the first look after it starts the dwell again
      this.#refresh() // its labels, its sky and the line again, from what it holds
      this.#status()
    } else {
      this.#labelKey = ''
      this.#line = null
      this.#labels.setLayer(LABEL_KEY, LABEL_RANK, [])
      this.#sky.clouds.setAhead(null, this.#aheadShow) // the app gives the way ahead again at the first frame it shows
      this.#pace.reset() // shown again, the march starts at half size
      this.#frameMs = Number.NaN
      if (this.#sky.clouds.scale !== undefined) this.#sky.clouds.scale = this.#scale ?? this.#pace.scale
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

  /** The model's grid, as drawn (shifted by ?wxat); null until the first answer. */
  get model(): ModelGrid | null {
    return this.#model
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

  /** The clouds' look: natural, severity colours or blocks (cloudVolume.ts). Changed on the fly. */
  get look(): CloudLook {
    return this.#look
  }

  set look(l: CloudLook) {
    this.#look = l
    this.#sky.clouds.look = l
  }

  /**
   * How the hazard areas' edges are drawn: curtain, fence or box (cloudVolume.ts draws them); the box until set. Changed on the fly:
   * the cloud volume is told, and the footprints are drawn under a curtain or a fence and taken away for a box.
   */
  get hazardStyle(): HazardStyle {
    return this.#hazardStyle
  }

  set hazardStyle(s: HazardStyle) {
    if (this.#destroyed || s === this.#hazardStyle) return
    this.#hazardStyle = s
    this.#drawHazards()
  }

  /**
   * The way ahead of the chased aircraft (wxAhead.ts aheadPath: heights above mean sea level) and which of the two aids drawn from it show:
   * the track line along it, and the level slice at its height. Every frame, from the app; null: no way ahead (the aircraft is slow).
   * Kept, and while the weather shows handed to the cloud volume, which draws them; hidden, nothing is handed on (the volume was told
   * that there is no way ahead when the weather was hidden).
   */
  setAhead(path: AheadPath | null, show: { track: boolean; slice: boolean }): void {
    this.#ahead = path
    this.#aheadShow.track = show.track
    this.#aheadShow.slice = show.slice
    if (this.#show) this.#sky.clouds.setAhead(path, this.#aheadShow)
  }

  /** The way ahead as last given to setAhead; null before the first, or when there is none. */
  get ahead(): AheadPath | null {
    return this.#ahead
  }

  /** Which aids setAhead asked for: the track line, the level slice. Nothing until told. */
  get aheadShow(): Readonly<{ track: boolean; slice: boolean }> {
    return this.#aheadShow
  }

  /** The weather field the clouds are drawn from (wxField.ts): built round the aircraft at the last draw; null before the first. */
  get field(): WxField | null {
    return this.#sky.clouds.field ?? null
  }

  /**
   * Whether the sky is known: a source of clouds has answered at least once (reports with a station in them, the radar's frame, the
   * forecast's grid; the demo sky as soon as it is laid). Until then the field is empty for want of an answer, not for a clear sky,
   * and the status line must not call it clear. (The hazard areas are a list of their own: they say nothing of cloud.)
   */
  get known(): boolean {
    return this.#known
  }

  /** Whether the cloud pass has failed for good (a render error took it out: cloudVolume.ts), as told to onCloudsFailed. */
  get cloudsFailed(): boolean {
    return this.#cloudsFailed
  }

  /** What draws the sky (for checks in the console). */
  get sky(): Sky {
    return this.#sky
  }

  /** How long the last draw took, ms: the field built from the cloud specs and its images made for the pass (the bench's line says it). */
  get drawMs(): number {
    return this.#drawMs
  }

  /**
   * The model's wind at a place (as drawn) and pressure altitude (ft): the forecast's, for the flight-data frame when the aircraft sends
   * none. Null when hidden (the grid is only asked for while shown), before it has come, or where it does not reach.
   */
  windAt(lat: number, lon: number, pressureAltFt: number): ModelWind | null {
    const grid = this.#grid()
    return this.#show && grid !== null ? modelWindAt(grid, lat, lon, pressureAltFt) : null
  }

  /** Whether the grid's hour is more than 3 h gone (none known: not): the grid is then used for nothing and asked for again. */
  #tooOld(g: ModelGrid): boolean {
    return g.timeMs !== null && this.#epochMs() - g.timeMs > MODEL_MAX_AGE_MS
  }

  /** The grid held, or null when there is none or it is too old to use. */
  #grid(): ModelGrid | null {
    return this.#model !== null && !this.#tooOld(this.#model) ? this.#model : null
  }

  /** The Sun's night (0 day … 1 night) the sky is lit by: app.ts gives it every frame, 0 while the Sun toggle is off. */
  setNight(n: number): void {
    this.#night = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0
  }

  /** The sky built again from what it holds, every report's clouds, the radar's and the model's worked out anew (a check aid: after changing a look constant, LOOKS, RADAR_LOOK or MODEL_LOOK, in the console). */
  rebuildSky(): void {
    this.#made = new WeakMap()
    this.#modelMade = null
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
    const scale = this.#scale ?? this.#pace.frame(nowMs - this.#frameMs) // (the first frame's time is no number: not counted)
    this.#frameMs = nowMs
    if (this.#sky.clouds.scale !== undefined && this.#sky.clouds.scale !== scale) this.#sky.clouds.scale = scale
    if (this.#pending !== null) {
      const t0 = performance.now()
      this.#sky.clouds.draw(this.#pending.clouds, this.#pending.at)
      this.#drawMs = performance.now() - t0
      this.#pending = null
    } else if (this.#staged !== null) this.#buildRadar() // one heavy piece of work a frame: the look, this, the draw
    this.#sky.clouds.frame(tf, this.#night)
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
      if (this.#demo !== null) this.#layDemo(aircraft.trackDeg)
      else if (this.#at !== null) {
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
    void this.#viewer.dataSources.remove(this.#footprints, true)
    this.#sky.clouds.destroy()
    this.#sky.fog.destroy()
  }

  /**
   * ?wxdemo: the demo sky laid out from where the aircraft is now, along its track (none known: north), the aircraft #demo km into it
   * and its rain layer round the aircraft's height above the sea; its clouds are kept to be drawn, its hazard area is held as the
   * SIGMETs are.
   */
  #layDemo(trackDeg: number | undefined): void {
    const a = this.#here
    const sky = demoSky(a.lat, a.lon, Number.isFinite(trackDeg) ? trackDeg! : 0, { altM: a.altM - geoidN(a.lat, a.lon), startKm: this.#demo! })
    this.#demoSpecs = sky.specs
    this.#sigmets = sky.sigmets
    this.#gen++
    this.#known = true // the demo sky is the whole sky
  }

  /** Asks for what is due: the SIGMETs and the radar frame by the clock, the METARs by the clock or when the aircraft is out of its box. With ?wxdemo, nothing. */
  #ask(nowMs: number): void {
    if (this.#demo !== null) return
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
    this.#askModel(nowMs, lat, lon)
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
   * The model's grid when it is due (every 30 min), or when the aircraft is out of the inner half of the grid held or the grid is
   * too old, but not within 30 s of the last ask (a 503's wait, if longer, after a failure: #modelRetryMs): a grid the server cannot
   * centre on the aircraft (near a pole), or has no newer than 3 h to give, would be asked for at every look. And not before the
   * aircraft has stayed MODEL_DWELL_MS: the clock restarts when the weather is shown, when the aircraft is in another cell (the
   * server's) and when the grid held stops serving it. So a hop that moves on within seconds asks nothing, and a jet that crosses
   * into the next cell is asked for that long after it leaves the inner half, the grid held drawing meanwhile.
   */
  #askModel(nowMs: number, lat: number, lon: number): void {
    const grid = this.#model
    const wanted = grid !== null && (!inInnerHalf(grid, this.#here.lat, this.#here.lon) || this.#tooOld(grid)) // out of its inner half, or too old
    const cell = `${Math.floor(lat / MODEL_CELL_DEG)},${Math.floor(lon / MODEL_CELL_DEG)}`
    if (cell !== this.#cell || (wanted && !this.#wanted)) this.#stoodMs = nowMs
    this.#cell = cell
    this.#wanted = wanted
    if (nowMs < this.#modelDue && !(wanted && nowMs - this.#modelAskedMs >= this.#modelRetryMs)) return
    if (nowMs - this.#stoodMs < this.#dwellMs) return
    this.#modelDue = nowMs + MODEL_EVERY_MS
    this.#modelAskedMs = nowMs
    void this.#loadModel(`${this.#apiBase}/wx/model?lat=${+lat.toFixed(3)}&lon=${+lon.toFixed(3)}`, ++this.#modelAsk, nowMs)
  }

  /**
   * One source's ask: the answer read (a failure is a warning, one for a whole outage: the source is down until an ask of it is
   * answered), then, unless it is out of date by now (`current`: the app is gone, or another ask has taken its place), the source
   * noted down or up and the answer (null: it failed, and why) handed on. An answer out of date is not heard at all: a late failure
   * cannot put the note up over an ask that has since been answered.
   */
  async #fetch<T>(feed: Feed, url: string, read: (json: unknown) => T, current: () => boolean, apply: (got: T | null, why?: unknown) => void): Promise<void> {
    let got: T | null = null
    let why: unknown
    try {
      got = read(await this.#getJson(url))
    } catch (e) {
      why = e
      if (current() && !this.#down.has(feed)) console.warn(`FlightHopper: 3-D weather ${url}:`, e)
    }
    if (!current()) return
    if (got === null) this.#down.add(feed)
    else this.#down.delete(feed)
    apply(got, why)
  }

  #loadMetars(box: Box, askedMs: number): Promise<void> {
    return this.#fetch('metar', `${this.#apiBase}/wx/metar?bbox=${box.join(',')}`, metarsOf, () => !this.#destroyed && box === this.#box, (list) => {
      if (list === null) this.#metarsDue = Math.min(this.#metarsDue, askedMs + RETRY_MS)
      else {
        this.#metars = shiftMetars(list, this.#shift.dLat, this.#shift.dLon)
        this.#metarGen++
        if (list.length > 0) this.#known = true // (an answer with no station in it, over the open sea, says nothing of the sky)
      }
      this.#refresh() // the clouds built from them, and the line
    })
  }

  #loadModel(url: string, ask: number, askedMs: number): Promise<void> {
    return this.#fetch('model', url, modelOf, () => !this.#destroyed && ask === this.#modelAsk, (grid, why) => {
      if (grid === null) {
        this.#modelRetryMs = retryAfterMs(why)
        this.#modelDue = Math.min(this.#modelDue, askedMs + this.#modelRetryMs)
      } else {
        this.#modelRetryMs = RETRY_MS
        this.#model = shiftModel(grid, this.#shift.dLat, this.#shift.dLon)
        this.#modelGen++
        this.#known = true
      }
      this.#refresh() // the clouds built from it, and the line
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
        this.#known = true
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
    this.#seeFailed()
    const a = this.#here
    if (this.#pickedGen !== this.#gen || !(distanceNm(a.lat, a.lon, this.#pickedLat, this.#pickedLon) * KM_PER_NM < PICK_KM)) {
      this.#hazards = hazardsNear(this.#sigmets, a.lat, a.lon, HAZARD_KM)
      this.#pickedGen = this.#gen
      this.#pickedLat = a.lat
      this.#pickedLon = a.lon
    }
    const areas = this.#hazards.map((h) => h.key).join('|') // '': nothing to draw
    if (areas !== this.#hazardKey) {
      this.#hazardKey = areas
      this.#drawHazards()
    }
    const u = this.#units()
    const labels = areas === '' ? '' : `${areas}:${u.alt}`
    if (labels !== this.#labelKey) {
      this.#labelKey = labels
      this.#labels.setLayer(LABEL_KEY, LABEL_RANK, this.#hazards.map((h) => this.#label(h, u)))
    }
    const old = this.#model !== null && this.#tooOld(this.#model)
    if (old !== this.#modelOld) {
      this.#modelOld = old
      this.#modelGen++ // the sky is built again without it, or with it
    }
    if (this.#builtGen !== this.#metarGen || this.#builtRadar !== this.#radarGen || this.#builtModel !== this.#modelGen || !(distanceNm(a.lat, a.lon, this.#builtLat, this.#builtLon) * KM_PER_NM < REBUILD_KM)) this.#buildClouds()
    const from = Cartesian3.fromDegrees(a.lon, a.lat, a.altM, Ellipsoid.WGS84, this.#hereWC)
    this.#sky.clouds.fade(from)
    this.#sky.fog.set(fogNear(this.#metars, a.lat, a.lon))
    const fall = this.#fall()
    this.#sky.precip.set(fall)
    if (fall !== null && !this.#falling) this.#aimedMs = -Infinity // aimed at the next frame
    this.#falling = fall !== null
    this.#shadeTarget = this.#overcast()
    this.#status()
  }

  /**
   * The clouds round the aircraft: the observed clouds built now, then the radar's, then the model's, within one cap;
   * the radar's keep RADAR_LOOK.reserve of it when it has so many, the observed ones giving way, the farthest first; the model's
   * come last, a forecast: they fill what is left. Where the tiles held have an echo the radar's part (the heavier) is built at the
   * next frame (#buildRadar), else it is nothing but the asking for its tiles and is done here. Drawn at the frame after, round where
   * the aircraft is now. With ?wxdemo they are the demo sky's, every time.
   */
  #buildClouds(): void {
    const a = this.#here
    if (this.#demoSpecs !== null) {
      this.#builtGen = this.#metarGen
      this.#builtRadar = this.#radarGen
      this.#builtModel = this.#modelGen
      this.#builtLat = a.lat
      this.#builtLon = a.lon
      this.#pending = { clouds: this.#demoSpecs, at: { lat: a.lat, lon: a.lon } }
      return
    }
    const observed = observedClouds(this.#metars, a.lat, a.lon, { cache: this.#made })
    this.#stations = observed.stations
    this.#builtGen = this.#metarGen
    this.#builtLat = a.lat
    this.#builtLon = a.lon
    this.#staged = observed.specs
    if (!this.#echoes()) this.#buildRadar()
  }

  /** The sky from the observed clouds staged, the radar's and the model's, at the aircraft's place now: to be drawn at the next frame. */
  #buildRadar(): void {
    const a = this.#here
    const observed = this.#staged!
    this.#staged = null
    const radar = this.#radarSky()
    // The observed clouds first, giving way to the radar's reserve; then the radar's; then the model's: a forecast, the lowest priority,
    // it fills what is left of the 700. The radar's are kept as far as they were read, whatever their puffs' own fade (100 km): the
    // volume fades every cloud by its one reach.
    const room = radar.length === 0 ? MAX_CLOUDS : MAX_CLOUDS - Math.min(radar.length, RADAR_LOOK.reserve)
    const clouds = nearestClouds([observed], a.lat, a.lon, room)
    clouds.push(...nearestClouds([radar], a.lat, a.lon, MAX_CLOUDS - clouds.length, RADAR_READ_KM, () => REACH_KM[1]))
    clouds.push(...nearestClouds([this.#modelSky()], a.lat, a.lon, MAX_CLOUDS - clouds.length))
    this.#pending = { clouds, at: { lat: a.lat, lon: a.lon } }
    this.#builtRadar = this.#radarGen
    this.#builtModel = this.#modelGen
  }

  /**
   * The model's clouds from the grid and the reports held, made again only when either has changed: a rebuild for a radar tile or 30 km
   * of flight finds them as they were. None before the grid has come.
   */
  #modelSky(): CloudSpec[] {
    const grid = this.#grid()
    if (grid === null) return []
    const made = this.#modelMade
    if (made !== null && made.grid === grid && made.metars === this.#metars) return made.specs
    const specs = modelClouds(grid, this.#metars)
    this.#modelMade = { grid, metars: this.#metars, specs }
    return specs
  }

  /** Whether any tile held has an echo (else the radar has no clouds to build). */
  #echoes(): boolean {
    for (const t of this.#tiles.values()) if (t.tile !== null) return true
    return false
  }

  /**
   * The radar's clouds within RADAR_READ_KM of the aircraft (its towers and deck puffs counted to their caps within RADAR_LOOK.radiusKm,
   * those of the ring beyond it on top), from the
   * frame's tiles that have come (a tile not come is asked for, and the clouds are built again when it has), on the bases the nearest
   * stations' reports give. The radar is read at the aircraft's place less the ?wxat shift, and the cells come out at their place plus it.
   */
  #radarSky(): CloudSpec[] {
    const a = this.#here
    const { dLat, dLon } = this.#shift
    const cells = radarCells((x, y) => this.#tileAt(x, y), a.lat - dLat, wrapLon(a.lon - dLon), this.#shift, RADAR_READ_KM)
    return cells.length === 0 ? [] : radarClouds(cells, radarBases(this.#metars))
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
    this.#onShade(shade)
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
    const n = tilesAcross(this.#here.lat - this.#shift.dLat, RADAR_READ_KM) + 1
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

  /**
   * The cloud pass has failed for good (seen at a look; Cesium's own sky tells at once): its clouds and the hazard areas' edges are
   * gone from the view. The areas are then marked by their footprints in every style, the line says so, and the app is told, once
   * (it takes the Weather menu away: its choices do nothing now, and says the note). The rest goes on: the field is still built, so
   * the status line and the ahead strip still speak.
   */
  #seeFailed(): void {
    if (this.#cloudsFailed || this.#sky.clouds.failed !== true) return
    this.#cloudsFailed = true
    this.#drawHazards()
    this.#status()
    this.#onCloudsFailed(NO_CLOUDS)
  }

  /**
   * The hazard areas picked, drawn: their edges by the cloud volume, in the style chosen; and under a curtain or a fence each ring's
   * footprint on the ground, by Cesium (a box has none, unless the cloud pass has failed: then nothing else marks an area): the
   * outline clamped to the ground, and a fill in stripes STRIPE_KM wide that
   * follow each other north-eastward. The stripes are counted over the ring's extent that way: the texture Cesium gives a polygon on
   * the ground spans the ring as it is turned (Cesium's Geometry.js, _textureCoordinateRotationPoints: read, not seen drawn).
   */
  #drawHazards(): void {
    this.#sky.clouds.setHazards(this.#hazards, this.#hazardStyle, hazardColor)
    const ents = this.#footprints.entities
    ents.suspendEvents()
    ents.removeAll()
    if (this.#hazardStyle !== 'box' || this.#cloudsFailed) {
      for (const h of this.#hazards) {
        const color = Color.fromCssColorString(hazardColor(h))
        for (const ring of h.rings) {
          const [lon0, lat0] = ring[0]
          const along = ring.map(([lon, lat]) => (wrapLon(lon - lon0) * KM_PER_DEG * Math.cos(lat0 * CesiumMath.RADIANS_PER_DEGREE) + (lat - lat0) * KM_PER_DEG) / Math.SQRT2)
          const positions = Cartesian3.fromDegreesArray(ring.flat())
          ents.add({
            polygon: {
              hierarchy: positions, stRotation: STRIPE_TURN, classificationType: ClassificationType.TERRAIN,
              material: new StripeMaterialProperty({
                evenColor: color.withAlpha(STRIPE_ALPHA[0]), oddColor: color.withAlpha(STRIPE_ALPHA[1]), orientation: StripeOrientation.HORIZONTAL,
                repeat: (Math.max(...along) - Math.min(...along)) / STRIPE_KM,
              }),
            },
          })
          const closed = Cartesian3.equals(positions[0], positions[positions.length - 1])
          ents.add({
            polyline: {
              positions: closed ? positions : [...positions, positions[0]], clampToGround: true, classificationType: ClassificationType.TERRAIN, width: OUTLINE_PX,
              material: color.withAlpha(OUTLINE_ALPHA),
            },
          })
        }
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
    const note = [this.#down.size > 0 ? NOTE : '', this.#sky.clouds.failed ? NO_CLOUDS : ''].filter((n) => n !== '').join(' · ')
    const text = statusText3d({ airports: this.#stations, areas: this.#hazards.length, model: this.#grid() !== null, note })
    if (text === this.#line) return
    this.#line = text
    this.#onStatus(text)
  }
}

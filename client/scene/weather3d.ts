// client/scene/weather3d.ts
// The weather round the chased aircraft, in 3-D (the Layers panel's Weather switch, in the chase). Weather3D keeps what the
// aircraft flies through, for the parts that draw it:
// - the airports' reports (METARs) of the whole-degree box 2° round it, asked again every 5 min and at once when it leaves the box;
// - the hazard areas (SIGMETs) and RainViewer's newest radar frame (a RadarSource: its tiles are fetched when something
//   samples them, as the top-down map's radar does), each every 10 min.
// It draws the hazard areas that have a top and whose ring passes within 800 km of the aircraft: each ring a translucent volume
// from the area's base (none: the ground) to its top, and the area's name and heights a label at the ring's middle at the top
// height, placed with the place names (placeLabels.ts keeps them clear of each other and of the flight-data frame).
// Live only: app.ts shows it in a live chase, not in History or a scenario (it is today's sky). Hidden it asks for nothing and
// draws nothing, and update(), called every frame, returns at once; shown, it looks at its clocks and the aircraft once a second.
// ?wxat=<lat>,<lon> is a check aid (the UI does not mention it): a replay's aircraft flies where the sky may be clear, so the
// weather is taken from round that place and moved by the one shift that puts the place under the aircraft's first position.
// From then on the aircraft flies through that sky. Everything it holds is where it is drawn (shifted); the radar's tiles are
// RainViewer's own, so a sample at a drawn place is taken at that place less the shift.
import { Cartesian3, Color, CustomDataSource, type Viewer } from 'cesium'
import { distanceNm } from '../../shared/geo.ts'
import type { Metar, Sigmet } from '../../shared/wx.ts'
import { DEFAULT_UNITS, type Units } from '../ui/units.ts'
import type { LayerLabel, PlaceLabels } from './placeLabels.ts'
import { RADAR_INDEX, RadarSource, type RadarIndex } from './radar.ts'
import { inRing, viewBox } from './weather.ts'
import { sigmetColor, sigmetLabel } from './wxText.ts'

const BOX_DEG = 2 // the METAR box reaches this far from the aircraft each way, rounded out to whole degrees
const METAR_EVERY_MS = 5 * 60_000
const SLOW_EVERY_MS = 10 * 60_000 // SIGMETs and the radar frame
const RETRY_MS = 30_000 // a failed ask is made again after this
const LOOK_MS = 1000 // update() looks at its clocks and the aircraft this often
export const HAZARD_KM = 800 // hazard areas are drawn when their ring passes this near the aircraft
const PICK_KM = 10 // the hazard areas are picked again once the aircraft has moved this far
const FILL_ALPHA = 0.1
const LINE_ALPHA = 0.6
const LABEL_KEY = 'hazards' // this layer in the names overlay
const LABEL_RANK = 1.5 // after the seas (1), before every city (2)
const NOTE = 'some weather unavailable'
const FT = 0.3048
const KM_PER_NM = 1.852
const EARTH_KM = 6371

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

// Spherical geometry on unit vectors (the SIGMET rings are great-circle edges, as Cesium draws a polygon's).
type Vec = [number, number, number]
const rad = (d: number): number => (d * Math.PI) / 180
const deg = (r: number): number => (r * 180) / Math.PI
const toVec = (lat: number, lon: number): Vec => {
  const [φ, λ] = [rad(lat), rad(lon)]
  return [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)]
}
const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const length = (a: Vec): number => Math.hypot(a[0], a[1], a[2])
const angle = (a: Vec, b: Vec): number => Math.atan2(length(cross(a, b)), dot(a, b))

/** A longitude in −180…180 (one already there is kept as it is). */
const wrapLon = (lon: number): number => (lon >= -180 && lon <= 180 ? lon : ((((lon + 180) % 360) + 360) % 360) - 180)

/** The angle (radians) from p to the great-circle arc a → b: to the circle where p's foot falls between a and b, else to the nearer end. */
function arcAngle(p: Vec, a: Vec, b: Vec): number {
  const ends = Math.min(angle(p, a), angle(p, b))
  const n = cross(a, b)
  const len = length(n)
  if (len < 1e-12) return ends // a and b are one point
  const u: Vec = [n[0] / len, n[1] / len, n[2] / len]
  const off = dot(p, u)
  const foot: Vec = [p[0] - off * u[0], p[1] - off * u[1], p[2] - off * u[2]]
  return dot(cross(a, foot), u) >= 0 && dot(cross(foot, b), u) >= 0 ? Math.asin(Math.min(1, Math.abs(off))) : ends
}

/**
 * Km from a point to a ring: 0 inside it, else to its nearest edge (a great circle) or corner. Longitudes are read relative to
 * the point, so a ring across the antimeridian is the one ring it is.
 */
export function ringDistanceKm(ring: [number, number][], lat: number, lon: number): number {
  if (inRing(ring.map(([x, y]) => [wrapLon(x - lon), y]), 0, lat)) return 0
  const p = toVec(lat, lon)
  const v = ring.map(([x, y]) => toVec(y, x))
  let best = Infinity
  for (let i = 0, j = v.length - 1; i < v.length; j = i++) best = Math.min(best, arcAngle(p, v[j], v[i]))
  return best * EARTH_KM
}

/** The middle of a ring's corners, each once (a GeoJSON ring repeats its first at its end). */
export function ringCentre(ring: [number, number][]): { lat: number; lon: number } {
  const last = ring[ring.length - 1]
  const n = ring.length > 1 && ring[0][0] === last[0] && ring[0][1] === last[1] ? ring.length - 1 : ring.length
  let [x, y, z] = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    const v = toVec(ring[i][1], ring[i][0])
    x += v[0]
    y += v[1]
    z += v[2]
  }
  return { lat: deg(Math.atan2(z, Math.hypot(x, y))), lon: deg(Math.atan2(y, x)) }
}

/** A hazard area to draw: its SIGMET, the rings of it within reach (a volume each), the nearest of them (its label's), and its heights in metres. */
export interface Hazard {
  sigmet: Sigmet
  rings: [number, number][][]
  nearest: [number, number][]
  baseM: number
  topM: number
  key: string // which SIGMET and which of its rings: what changes when what is drawn does
}

/**
 * The SIGMETs with a top (above their base) that have a ring passing within maxKm of the point: each with the rings that do.
 * ponytail: a flight level is a pressure altitude and the volumes stand at that many metres above the ellipsoid: off by up to a
 * few hundred metres on a day far from the standard atmosphere. Upgrade: correct by the QNH and the air's temperature.
 * ponytail: every corner of every SIGMET in the world is tested (about 3 ms for 150 areas, at most once per 10 km flown).
 * Upgrade: a quick reject by the cap round each ring (its middle and its farthest corner).
 */
export function hazardsNear(sigmets: readonly Sigmet[], lat: number, lon: number, maxKm = HAZARD_KM): Hazard[] {
  const out: Hazard[] = []
  sigmets.forEach((s, i) => {
    if (s.top === null) return
    const baseM = Math.max(0, s.base ?? 0) * FT // no base: from the ground
    const topM = s.top * FT
    if (!(topM > baseM)) return
    const near = s.rings.map((ring, r) => ({ ring, r, km: ringDistanceKm(ring, lat, lon) })).filter((x) => x.km <= maxKm)
    if (near.length === 0) return
    const nearest = near.reduce((a, b) => (b.km < a.km ? b : a)).ring
    out.push({ sigmet: s, rings: near.map((x) => x.ring), nearest, baseM, topM, key: `${i}:${near.map((x) => x.r).join(',')}` })
  })
  return out
}

type Box = readonly [south: number, west: number, north: number, east: number]
type Feed = 'metar' | 'sigmet' | 'radar'

export interface Weather3DOptions {
  apiBase: string // the app's /api
  labels: Pick<PlaceLabels, 'setLayer'> // the names overlay: the hazard areas' labels go through it
  onStatus?: (text: string | null) => void // the Layers panel's one-line summary
  units?: () => Units // what heights are worded in (the flight-data frame's); default feet
  at?: WxAt | null // ?wxat
  getJson?: (url: string) => Promise<unknown>
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
  readonly #volumes = new CustomDataSource('hazard-volumes')
  readonly #here: Aircraft = { lat: 0, lon: 0, altM: 0 }
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
  #metars: Metar[] = []
  #sigmets: Sigmet[] = []
  #radar: RadarSource | null = null
  #gen = 0 // the SIGMET list held (the labels and volumes are drawn for one)
  #hazards: Hazard[] = []
  #pickedGen = -1
  #pickedLat = Number.NaN // where the aircraft was when the hazards were last picked
  #pickedLon = Number.NaN
  #volumeKey = ''
  #labelKey = ''
  #line: string | null = null // the last summary written

  constructor(viewer: Viewer, opts: Weather3DOptions) {
    this.#viewer = viewer
    this.#apiBase = opts.apiBase
    this.#labels = opts.labels
    this.#onStatus = opts.onStatus ?? (() => {})
    this.#units = opts.units ?? (() => DEFAULT_UNITS)
    this.#getJson = opts.getJson ?? getJson
    this.#at = opts.at ?? null
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
    if (on) {
      this.#refresh() // its labels and the line again, from what it holds
      this.#status()
    } else {
      this.#labelKey = ''
      this.#line = null
      this.#labels.setLayer(LABEL_KEY, LABEL_RANK, [])
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

  /** Every frame, with the chased aircraft (null: none): hidden it does nothing; shown, it looks once a second. */
  update(aircraft: Aircraft | null, nowMs: number): void {
    if (!this.#show || aircraft === null || !Number.isFinite(aircraft.lat) || !Number.isFinite(aircraft.lon)) return
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
    this.#ask(nowMs)
    this.#refresh()
  }

  destroy(): void {
    if (this.#destroyed) return
    this.show = false
    this.#destroyed = true
    if (!this.#viewer.isDestroyed()) void this.#viewer.dataSources.remove(this.#volumes, true)
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

  /** The answer, or null after one warning (the source is noted down until it answers). */
  async #get<T>(feed: Feed, url: string, read: (json: unknown) => T): Promise<T | null> {
    try {
      const got = read(await this.#getJson(url))
      this.#down.delete(feed)
      return got
    } catch (e) {
      console.warn(`FlightHopper: 3-D weather ${url}:`, e)
      this.#down.add(feed)
      return null
    }
  }

  async #loadMetars(box: Box, askedMs: number): Promise<void> {
    const list = await this.#get('metar', `${this.#apiBase}/wx/metar?bbox=${box.join(',')}`, (j) =>
      listOf<Metar>(j, (m) => Number.isFinite(m?.lat) && Number.isFinite(m?.lon)))
    if (this.#destroyed || box !== this.#box) return // gone, or the aircraft left the box and another was asked for
    if (list === null) this.#metarsDue = Math.min(this.#metarsDue, askedMs + RETRY_MS)
    else this.#metars = this.#at === null ? list : list.map((m) => ({ ...m, lat: m.lat + this.#shift.dLat, lon: wrapLon(m.lon + this.#shift.dLon) }))
    this.#status()
  }

  async #loadSigmets(askedMs: number): Promise<void> {
    const list = await this.#get('sigmet', `${this.#apiBase}/wx/sigmet`, (j) => listOf<Sigmet>(j, (s) => Array.isArray(s?.rings)))
    if (this.#destroyed) return
    if (list === null) this.#sigmetsDue = Math.min(this.#sigmetsDue, askedMs + RETRY_MS)
    else {
      const { dLat, dLon } = this.#shift
      this.#sigmets = this.#at === null ? list : list.map((s) => ({ ...s, rings: s.rings.map((r) => r.map(([x, y]): [number, number] => [wrapLon(x + dLon), y + dLat])) }))
      this.#gen++
    }
    this.#refresh()
  }

  async #loadRadar(askedMs: number): Promise<void> {
    const frame = await this.#get('radar', RADAR_INDEX, frameOf)
    if (this.#destroyed) return
    if (frame === null) this.#radarDue = Math.min(this.#radarDue, askedMs + RETRY_MS)
    else {
      const source = new RadarSource(frame.host, frame.path)
      if (this.#radar?.url !== source.url) this.#radar = source // the frame held keeps its decoded tiles
    }
    this.#status()
  }

  /** The hazard areas picked (again when the SIGMETs changed or the aircraft moved far enough), and what shows them drawn when it changed. */
  #refresh(): void {
    if (!this.#show || !this.#seen) return
    const a = this.#here
    if (this.#pickedGen !== this.#gen || !(distanceNm(a.lat, a.lon, this.#pickedLat, this.#pickedLon) * KM_PER_NM < PICK_KM)) {
      this.#hazards = hazardsNear(this.#sigmets, a.lat, a.lon)
      this.#pickedGen = this.#gen
      this.#pickedLat = a.lat
      this.#pickedLon = a.lon
    }
    const volumes = this.#hazards.length === 0 ? '' : `${this.#gen}:${this.#hazards.map((h) => h.key).join('|')}` // '': nothing to draw
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
    this.#status()
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
    const text = statusText3d({ airports: this.#metars.length, areas: this.#hazards.length, note: this.#down.size > 0 ? NOTE : '' })
    if (text === this.#line) return
    this.#line = text
    this.#onStatus(text)
  }
}

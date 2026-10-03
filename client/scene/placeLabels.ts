// client/scene/placeLabels.ts
// Place names in the chase, upright for the camera: an HTML overlay of screen text over the 3-D view (app.ts puts its
// layer over the canvas, under the traffic brackets and every panel), where Esri's places raster lays the names on the
// ground, blurred and turned with the map. Shown while Borders & places is on (mapLayer.ts draws the borders):
// - cities (public/search/places.json, the search box's file: the browser's cache shares it), each within a reach of its
//   size, 1,500 km for 5 M+ people down to 25 km (cityReachKm); countries (public/map/countries.json, at Natural Earth's
//   label points) from 150 to 3,000 km, the largest to 4,000; seas (public/map/seas.json) from 50 km to 4,000 km
//   (Natural Earth's scalerank ≤ 2) or 800 km. A name fades out over the last 20 % of its reach.
// - every SELECT_MS the candidates in reach of the camera; every frame those in front of the camera, above the globe's
//   horizon and on screen, placed in rank order (countries, seas, then cities, biggest first), each left out where it
//   would come within GAP_PX of one placed before it or of an area kept off (the flight-data frame's cards); at most
//   MAX_LABELS, their nodes reused. One within GAP_PX of the chased aircraft's outline is left out first, and keeps no
//   room: the aircraft is drawn over the names, the rest of the square its brackets mark is ground like any other.
//   A name stands on the ground as globe.getHeight has it, read a few a frame under a time budget (at the ellipsoid
//   until then).
// Other layers add labels of their own (setLayer), placed with the names by a rank of their own.
// Text drawn by the browser at device resolution, at whole device pixels: crisp, and upright by construction.
import { Cartesian2, Cartesian3, Cartographic, Ellipsoid, EllipsoidalOccluder, Math as CesiumMath, SceneTransforms } from 'cesium'
import type { Scene, Viewer } from 'cesium'
import { distanceNm } from '../../shared/geo.ts'
import type { CountriesJson, SeasJson } from '../../shared/mapOverlays.ts'
import type { Places } from '../../shared/places.ts'
import type { TerrainFrame } from '../types.ts'
import { drawnHeightM, trueHeightM } from './exaggeration.ts'
import type { Rect } from './flightFrame.ts'
import { NO_DISCS, overDiscs, type Discs } from './modelOutline.ts'

declare module 'cesium' {
  /** The globe's own horizon test (Core/EllipsoidalOccluder.js): Cesium exports it but leaves it out of its typings. */
  export class EllipsoidalOccluder {
    constructor(ellipsoid: Ellipsoid, cameraPosition?: Cartesian3)
    cameraPosition: Cartesian3
    isPointVisible(occludee: Cartesian3): boolean
  }
}

export const MAX_LABELS = 60
export const GAP_PX = 4 // the least room between two names
const SELECT_MS = 500 // the candidates are looked up this often
const FADE = 0.2 // of a reach: the far end, over which a name fades out
const MIN_ALPHA = 0.1 // fainter than this a name is not placed: it would keep legible ones out for next to nothing
// Ground heights: globe.getHeight's first pick on a tile scans its whole mesh (again while a worker sorts the tile's
// triangles, and after each exaggeration change), a millisecond or more. So a frame reads a few at most, and none once
// READ_MS has gone; the names on screen first.
const READ_MS = 1
const READS_PER_FRAME = 4
const REREAD = 4 // a height read from far away (a coarse tile) is read again once the place is this many times nearer
const TRUE_MIN_F = 0.5 // below this factor a drawn height says nothing of the true one (exaggeration.ts' INVERT_MIN_F, unexported)
/** The order names are placed in, lowest first; cities within theirs by population. Another layer's labels take a rank of their own (setLayer). */
export const RANK = { country: 0, sea: 1, city: 2 } as const
const CITY_TIERS: readonly (readonly [minPop: number, reachKm: number])[] = [[5e6, 1500], [1e6, 600], [3e5, 250], [1e5, 120], [3e4, 60], [0, 25]]
const COUNTRY_MIN_KM = 150 // nearer, the name would stand under the camera: you are in it
const COUNTRY_KM = 3000
const LARGE_COUNTRY_KM = 4000 // Natural Earth's label rank ≤ LARGE_COUNTRY
const LARGE_COUNTRY = 2
const SEA_MIN_KM = 50
const SEA_KM = 800
const MAJOR_SEA_KM = 4000 // the oceans and the big seas: scalerank ≤ MAJOR_SEA
const MAJOR_SEA = 2
const KM_PER_DEG = 110 // of latitude, a little under (111.2): a city's latitude band is a cheap first look, not the test
const BANDS_PER_DEG = 10 // the cities are filed by latitude in bands this fine
const BANDS = 180 * BANDS_PER_DEG
const KM_PER_NM = 1.852

// The look, as layout.css draws it (.fh-place): the boxes the declutter compares are the text's.
const LINE = 1.2 // line height, of the font size
const DOT_GAP_PX = 3 // a city's name stands this far above its place, its dot
const DOT_R_PX = 2
const AREA_PX = 12 // countries, seas and other layers' labels
const COUNTRY_SPACING = 0.14 // em, after each letter

export type Kind = 'country' | 'sea' | 'city'

/**
 * The cities by reach tier, each tier's filed by latitude band: band k's cities are ids[start[k]] up to ids[start[k + 1]],
 * so a look reads only the bands its reach can touch. Filed in one pass, with no sort: the index is built while the
 * chase runs.
 */
export interface PlaceIndex {
  cities: Places['cities']
  countries: CountriesJson['countries']
  seas: SeasJson['seas']
  tiers: { reachKm: number; ids: Int32Array; start: Int32Array }[]
}

/** A place within reach of the camera: its kind and index in the PlaceIndex's list, its distance and its fade (0–1). */
export interface Candidate {
  kind: Kind
  i: number
  km: number
  alpha: number
}

/** A label another layer draws through the overlay: its text centred on a point in the world, in a colour. */
export interface LayerLabel {
  text: string
  position: Cartesian3 // world (ECEF), as drawn
  color: string // CSS
}

const tierOf = (pop: number): number => {
  const i = CITY_TIERS.findIndex(([min]) => pop >= min)
  return i < 0 ? CITY_TIERS.length - 1 : i
}

/** How far from the camera a city's name shows, by its population (km). */
export const cityReachKm = (pop: number): number => CITY_TIERS[tierOf(pop)][1]

const bandOf = (lat: number): number => Math.min(BANDS - 1, Math.max(0, Math.floor((lat + 90) * BANDS_PER_DEG)))

export function indexPlaces(cities: Places['cities'], countries: CountriesJson['countries'], seas: SeasJson['seas']): PlaceIndex {
  const tierOfCity = Uint8Array.from(cities, (c) => tierOf(c[5]))
  const bandOfCity = Uint16Array.from(cities, (c) => bandOf(c[3]))
  // A counting sort per tier: count each band, add up the starts, then deal the cities out.
  const tiers = CITY_TIERS.map(([, reachKm]) => ({ reachKm, ids: new Int32Array(0), start: new Int32Array(BANDS + 1) }))
  for (let i = 0; i < cities.length; i++) tiers[tierOfCity[i]].start[bandOfCity[i] + 1]++
  for (const t of tiers) {
    for (let k = 0; k < BANDS; k++) t.start[k + 1] += t.start[k]
    t.ids = new Int32Array(t.start[BANDS])
  }
  const next = tiers.map((t) => t.start.slice(0, BANDS))
  for (let i = 0; i < cities.length; i++) tiers[tierOfCity[i]].ids[next[tierOfCity[i]][bandOfCity[i]]++] = i
  return { cities, countries, seas, tiers }
}

const kmBetween = (lat1: number, lon1: number, lat2: number, lon2: number): number => distanceNm(lat1, lon1, lat2, lon2) * KM_PER_NM
const fade = (km: number, reachKm: number): number => Math.min(1, (reachKm - km) / (FADE * reachKm))

/** The places whose names show from (lat, lon): each within its reach (and beyond its least distance), with its fade. */
export function placeCandidates(ix: PlaceIndex, lat: number, lon: number, out: Candidate[] = []): Candidate[] {
  out.length = 0
  ix.countries.forEach((c, i) => {
    const reach = c[3] <= LARGE_COUNTRY ? LARGE_COUNTRY_KM : COUNTRY_KM
    const km = kmBetween(lat, lon, c[2], c[1])
    if (km >= COUNTRY_MIN_KM && km <= reach) out.push({ kind: 'country', i, km, alpha: fade(km, reach) })
  })
  ix.seas.forEach((s, i) => {
    const reach = s[3] <= MAJOR_SEA ? MAJOR_SEA_KM : SEA_KM
    const km = kmBetween(lat, lon, s[2], s[1])
    if (km >= SEA_MIN_KM && km <= reach) out.push({ kind: 'sea', i, km, alpha: fade(km, reach) })
  })
  for (const t of ix.tiers) {
    const dLat = t.reachKm / KM_PER_DEG
    for (let j = t.start[bandOf(lat - dLat)], end = t.start[bandOf(lat + dLat) + 1]; j < end; j++) {
      const c = ix.cities[t.ids[j]]
      const km = kmBetween(lat, lon, c[3], c[4])
      if (km <= t.reachKm) out.push({ kind: 'city', i: t.ids[j], km, alpha: fade(km, t.reachKm) })
    }
  }
  return out
}

/** Whether a point can be seen from the camera: ahead of it along its view, and not behind the globe (occluder: at the camera's position). */
export function inSight(p: Cartesian3, cam: { positionWC: Cartesian3; directionWC: Cartesian3 }, occluder: EllipsoidalOccluder): boolean {
  const o = cam.positionWC
  const d = cam.directionWC
  return (p.x - o.x) * d.x + (p.y - o.y) * d.y + (p.z - o.z) * d.z > 0 && occluder.isPointVisible(p)
}

let kept = new Int32Array(MAX_LABELS * 2) // declutter's scratch: the boxes kept so far

/**
 * The greedy declutter over n boxes (x0, y0, x1, y1 each, px) in priority order: the first `fixed` are areas kept off,
 * always there; each later box is kept unless it comes within gap px of one kept before it, until max are. Writes keep[i]
 * (1 or 0) for each box after the fixed ones; returns how many it kept.
 */
export function declutter(boxes: Float64Array, n: number, fixed: number, keep: Uint8Array, max = MAX_LABELS, gap = GAP_PX): number {
  if (kept.length < n) kept = new Int32Array(n * 2)
  let k = 0
  for (let i = 0; i < fixed; i++) kept[k++] = i
  let count = 0
  for (let i = fixed; i < n; i++) {
    const x0 = boxes[i * 4] - gap
    const y0 = boxes[i * 4 + 1] - gap
    const x1 = boxes[i * 4 + 2] + gap
    const y1 = boxes[i * 4 + 3] + gap
    let clear = count < max
    for (let q = 0; q < k && clear; q++) {
      const j = kept[q] * 4
      if (x0 < boxes[j + 2] && boxes[j] < x1 && y0 < boxes[j + 3] && boxes[j + 1] < y1) clear = false
    }
    keep[i] = clear ? 1 : 0
    if (clear) {
      kept[k++] = i
      count++
    }
  }
  return count
}

/** One name, kept from its first look on: its measured box, its ground height once read, its node while placed. */
interface Label {
  kind: Kind | 'layer'
  text: string
  rank: number
  weight: number // within its rank, more goes first
  size: '' | 's' | 'l' // a city's type size (layout.css: 12, 13, 15 px)
  color: string // another layer's; '' for the stylesheet's
  lon: number
  lat: number
  w: number // px, measured once
  h: number
  km: number // from the camera, at the last look it was in
  groundM: number | undefined // the true ground height, once read
  groundKm: number // how far away it was read
  readFrame: number // the frame it was last read in
  pos: Cartesian3 // where it is drawn in the world
  f: number // the exaggeration it was placed for (NaN: not yet)
  relHM: number
  alpha: number
  x: number // this frame's point on screen
  y: number
  seen: number // the frame it was last placed in
  el: HTMLDivElement | null
  tx: number // what its node holds (NaN: nothing yet)
  ty: number
  ta: number
}

const byRank = (a: Label, b: Label): number => a.rank - b.rank || b.weight - a.weight
const snap = (v: number, dpr: number): number => Math.round(v * dpr) / dpr
const NO_RECTS: readonly Rect[] = []

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.json()
}

let measureCtx: CanvasRenderingContext2D | null | undefined
/** A text's width in a CSS font, from a canvas (no layout read); NaN without one. */
function canvasMeasure(text: string, font: string): number {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (measureCtx === null) return NaN
  measureCtx.font = font
  return measureCtx.measureText(text).width
}

export interface PlaceLabelsOptions {
  placesUrl: string // public/search/places.json
  countriesUrl: string // public/map/countries.json
  seasUrl: string // public/map/seas.json
  getJson?: (url: string) => Promise<unknown>
  measure?: (text: string, font: string) => number // a text's width (px) in a CSS font; default a canvas's measureText
  project?: (scene: Scene, p: Cartesian3, out: Cartesian2) => Cartesian2 | undefined // default SceneTransforms.worldToWindowCoordinates
  now?: () => number // ms, for the reads' budget; default performance.now
}

/**
 * The names overlay. show: the place names (the chase with Borders & places on; their data is fetched at the first show).
 * update() every frame after the camera moved: hidden, with no other layer's labels, it does nothing.
 * ponytail: a name's record stays once made (its measured box, its height), so a long flight across continents keeps
 * thousands of small records. Upgrade: drop those not seen for minutes.
 */
export class PlaceLabels {
  readonly #viewer: Viewer
  readonly #layer: HTMLElement
  readonly #placesUrl: string
  readonly #countriesUrl: string
  readonly #seasUrl: string
  readonly #getJson: (url: string) => Promise<unknown>
  readonly #measure: (text: string, font: string) => number
  readonly #project: (scene: Scene, p: Cartesian3, out: Cartesian2) => Cartesian2 | undefined
  readonly #now: () => number
  readonly #occluder = new EllipsoidalOccluder(Ellipsoid.WGS84)
  readonly #labels = new Map<string, Label>() // the places' names, by kind and index
  readonly #layers = new Map<string, Label[]>()
  readonly #widths = new Map<string, number>() // other layers' texts, measured (they set theirs again on each change)
  readonly #cands: Candidate[] = []
  readonly #list: Label[] = [] // the last look's names and the layers' labels, in rank order
  readonly #vis: Label[] = []
  readonly #nodes: HTMLDivElement[] = []
  readonly #free: HTMLDivElement[] = []
  readonly #win = new Cartesian2()
  readonly #carto = new Cartographic()
  #shown: Label[] = [] // placed in the last frame
  #next: Label[] = []
  #boxes = new Float64Array(0)
  #keep = new Uint8Array(0)
  #ix: PlaceIndex | null = null
  #show = false
  #loading = false
  #failed = false
  #dirty = true
  #selectedAt = -Infinity
  #frame = 0
  #family: string | null = null
  #destroyed = false

  constructor(viewer: Viewer, layer: HTMLElement, opts: PlaceLabelsOptions) {
    this.#viewer = viewer
    this.#layer = layer
    this.#placesUrl = opts.placesUrl
    this.#countriesUrl = opts.countriesUrl
    this.#seasUrl = opts.seasUrl
    this.#getJson = opts.getJson ?? getJson
    this.#measure = opts.measure ?? canvasMeasure
    this.#project = opts.project ?? SceneTransforms.worldToWindowCoordinates
    this.#now = opts.now ?? (() => performance.now())
  }

  get show(): boolean {
    return this.#show
  }

  set show(v: boolean) {
    if (v === this.#show) return
    this.#show = v
    this.#dirty = true
    if (v) this.#failed = false // a failed fetch is tried again at the next show
  }

  /** Whether update() has anything to do: the names shown, or another layer's labels set. */
  get active(): boolean {
    return this.#show || this.#layers.size > 0
  }

  /**
   * One layer's labels (key: its name), in place of those it set before; [] takes them away. rank: where they go in the
   * placing order (RANK: countries 0, seas 1, cities 2; 1.5 puts them after the seas and before every city). They show
   * whether or not the place names do: the layer takes them away when it hides.
   */
  setLayer(key: string, rank: number, labels: readonly LayerLabel[]): void {
    if (labels.length === 0) this.#layers.delete(key)
    else this.#layers.set(key, labels.map((l) => this.#layerLabel(l, rank)))
    this.#dirty = true
  }

  /**
   * This frame's names, after the camera moved: tf the frame's exaggeration; keepOff the areas no name goes over (canvas
   * px), aircraft the chased aircraft's outline, which none goes over either.
   */
  update(tf: TerrainFrame, nowMs: number, keepOff: readonly Rect[] = NO_RECTS, aircraft: Discs = NO_DISCS): void {
    if (this.#destroyed) return
    if (!this.active) {
      if (this.#shown.length > 0) this.#hideAll()
      return
    }
    if (this.#show && this.#ix === null) this.#load()
    if (this.#dirty || nowMs - this.#selectedAt >= SELECT_MS) {
      this.#dirty = false
      this.#selectedAt = nowMs
      this.#select()
    }
    this.#draw(tf, keepOff, aircraft)
  }

  destroy(): void {
    this.#destroyed = true
    for (const el of this.#nodes) el.remove()
    this.#nodes.length = this.#free.length = this.#shown.length = this.#list.length = 0
    this.#labels.clear()
    this.#layers.clear()
  }

  /** The three files, once; a failed fetch or a file of the wrong shape is one warning, and asked again at the next show. */
  #load(): void {
    if (this.#loading || this.#failed) return
    this.#loading = true
    Promise.all([this.#getJson(this.#placesUrl), this.#getJson(this.#countriesUrl), this.#getJson(this.#seasUrl)])
      .then(([places, countries, seas]) => {
        if (this.#destroyed) return
        const cities = (places as Partial<Places> | null)?.cities
        const named = (countries as Partial<CountriesJson> | null)?.countries
        const sea = (seas as Partial<SeasJson> | null)?.seas
        if (!Array.isArray(cities) || !Array.isArray(named) || !Array.isArray(sea)) throw new Error('not the place files')
        this.#ix = indexPlaces(cities, named, sea)
        this.#dirty = true
      })
      .catch((e: unknown) => {
        console.warn('FlightHopper: no place names:', e)
        this.#failed = true
      })
      .finally(() => (this.#loading = false))
  }

  /** The look: the candidates from the camera's position and the layers' labels, in rank order. */
  #select(): void {
    const list = this.#list
    list.length = 0
    if (this.#show && this.#ix !== null) {
      const c = this.#viewer.scene.camera.positionCartographic
      placeCandidates(this.#ix, CesiumMath.toDegrees(c.latitude), CesiumMath.toDegrees(c.longitude), this.#cands)
      for (const k of this.#cands) {
        const l = this.#placeLabel(k)
        l.alpha = k.alpha
        l.km = k.km
        list.push(l)
      }
    }
    for (const ls of this.#layers.values()) for (const l of ls) list.push(l)
    list.sort(byRank)
  }

  /**
   * Some ground heights, under READS_PER_FRAME and READ_MS: the names on screen this frame first, then the others in rank
   * order. Each is read once, and again only once the place is REREAD times nearer: globe.getHeight answers from the most
   * detailed tile it has, a coarse one for a place far away. None while the relief is flat (the drawn ground says nothing
   * of the true one), nor while it grows or sinks (each frame resets the tiles' pickers: every read would scan a mesh).
   */
  #readGrounds(tf: TerrainFrame, onScreen: readonly Label[]): void {
    if (tf.fSampled < TRUE_MIN_F || tf.fSampled !== tf.fNow) return
    const frame = this.#frame
    const start = this.#now()
    let reads = 0
    const read = (l: Label): boolean => { // false: this frame's reads are spent
      if (l.kind === 'layer' || l.readFrame === frame || (l.groundM !== undefined && l.km * REREAD >= l.groundKm)) return true
      if (reads >= READS_PER_FRAME || this.#now() - start >= READ_MS) return false
      l.readFrame = frame
      reads++
      const h = this.#viewer.scene.globe.getHeight(Cartographic.fromDegrees(l.lon, l.lat, 0, this.#carto))
      const t = h === undefined ? null : trueHeightM(h, tf.fSampled, tf.relHM)
      if (t !== null) {
        l.groundM = t
        l.groundKm = l.km
        l.f = NaN // placed on it from the next frame
      }
      return true
    }
    for (const l of onScreen) if (!read(l)) return
    for (const l of this.#list) if (!read(l)) return
  }

  /** Where a place's name stands this frame: on its ground as the terrain is drawn (exaggerated, or flat). */
  #at(l: Label, tf: TerrainFrame): void {
    Cartesian3.fromDegrees(l.lon, l.lat, drawnHeightM(l.groundM ?? 0, tf.fNow, tf.relHM), Ellipsoid.WGS84, l.pos)
    l.f = tf.fNow
    l.relHM = tf.relHM
  }

  #draw(tf: TerrainFrame, keepOff: readonly Rect[], aircraft: Discs): void {
    const scene = this.#viewer.scene
    const cam = scene.camera
    const list = this.#list
    this.#occluder.cameraPosition = cam.positionWC
    const w = scene.canvas.clientWidth
    const h = scene.canvas.clientHeight
    const n0 = keepOff.length + list.length
    if (this.#keep.length < n0) {
      this.#boxes = new Float64Array(n0 * 8)
      this.#keep = new Uint8Array(n0 * 2)
    }
    const b = this.#boxes
    let n = 0
    for (const r of keepOff) {
      b[n * 4] = r.x
      b[n * 4 + 1] = r.y
      b[n * 4 + 2] = r.x + r.w
      b[n * 4 + 3] = r.y + r.h
      n++
    }
    const fixed = n
    const vis = this.#vis
    vis.length = 0
    for (const l of list) {
      if (l.alpha < MIN_ALPHA) continue
      if (l.kind !== 'layer' && (l.f !== tf.fNow || l.relHM !== tf.relHM)) this.#at(l, tf)
      if (!inSight(l.pos, cam, this.#occluder)) continue
      const p = this.#project(scene, l.pos, this.#win)
      if (p === undefined || !(p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h)) continue
      const top = l.kind === 'city' ? p.y - DOT_GAP_PX - l.h : p.y - l.h / 2
      const bottom = l.kind === 'city' ? p.y + DOT_R_PX : top + l.h
      if (overDiscs(p.x - l.w / 2, top, p.x + l.w / 2, bottom, aircraft, GAP_PX)) continue
      l.x = p.x
      l.y = p.y
      b[n * 4] = p.x - l.w / 2
      b[n * 4 + 1] = top
      b[n * 4 + 2] = p.x + l.w / 2
      b[n * 4 + 3] = bottom
      vis.push(l)
      n++
    }
    declutter(b, n, fixed, this.#keep)
    const frame = ++this.#frame
    const next = this.#next
    next.length = 0
    for (let i = 0; i < vis.length; i++) {
      if (this.#keep[fixed + i] === 0) continue
      vis[i].seen = frame
      next.push(vis[i])
    }
    for (const l of this.#shown) if (l.seen !== frame) this.#release(l) // first: their nodes go to the names that came
    const dpr = globalThis.devicePixelRatio || 1
    for (const l of next) this.#write(l, dpr)
    this.#next = this.#shown
    this.#shown = next
    this.#readGrounds(tf, vis)
  }

  /** A placed name's node: dressed when it takes one, then only its place and fade written, when they change. */
  #write(l: Label, dpr: number): void {
    let el = l.el
    if (el === null) {
      el = l.el = this.#free.pop() ?? this.#node()
      el.dataset.kind = l.kind
      if (l.size === '') delete el.dataset.size
      else el.dataset.size = l.size
      el.textContent = l.text
      el.style.color = l.color
      el.hidden = false
      l.tx = l.ty = l.ta = NaN
    }
    const tx = snap(l.x - l.w / 2, dpr)
    const ty = snap(l.kind === 'city' ? l.y - DOT_GAP_PX - l.h : l.y - l.h / 2, dpr)
    if (tx !== l.tx || ty !== l.ty) {
      el.style.transform = `translate(${tx}px, ${ty}px)`
      l.tx = tx
      l.ty = ty
    }
    const a = Math.min(1, Math.round(l.alpha * 50) / 50) // in steps of 2 %: no write every frame for a change no one sees
    if (a !== l.ta) {
      el.style.opacity = a >= 1 ? '' : String(a)
      l.ta = a
    }
  }

  #node(): HTMLDivElement {
    const el = document.createElement('div')
    el.className = 'fh-place'
    this.#layer.append(el)
    this.#nodes.push(el)
    return el
  }

  #release(l: Label): void {
    if (l.el === null) return
    l.el.hidden = true
    this.#free.push(l.el)
    l.el = null
  }

  #hideAll(): void {
    for (const l of this.#shown) this.#release(l)
    this.#shown.length = 0
  }

  /** A CSS font in the app's family (theme.css --fh-font), as layout.css sets it on .fh-place. */
  #font(px: number, italic = false): string {
    this.#family ??= (typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement).getPropertyValue('--fh-font').trim() : '') || 'sans-serif'
    return `${italic ? 'italic 400' : '600'} ${px}px ${this.#family}`
  }

  #width(text: string, px: number, italic = false): number {
    const w = this.#measure(text, this.#font(px, italic))
    return Number.isFinite(w) ? w : text.length * px * 0.6 // no canvas: about the average letter
  }

  #placeLabel(k: Candidate): Label {
    const key = `${k.kind}${k.i}`
    let l = this.#labels.get(key)
    if (l !== undefined) return l
    const ix = this.#ix!
    if (k.kind === 'city') {
      const [name, , , lat, lon, pop] = ix.cities[k.i]
      const px = pop >= 5e6 ? 15 : pop < 1e5 ? 12 : 13
      l = this.#label('city', name, RANK.city, pop, lat, lon, px, this.#width(name, px))
      l.size = px === 15 ? 'l' : px === 12 ? 's' : ''
    } else if (k.kind === 'country') {
      const [name, lon, lat, rank] = ix.countries[k.i]
      const text = name.toUpperCase() // layout.css spaces the letters; the text comes in capitals
      l = this.#label('country', text, RANK.country, -rank, lat, lon, AREA_PX, this.#width(text, AREA_PX) + COUNTRY_SPACING * AREA_PX * text.length)
    } else {
      const [name, lon, lat, scalerank] = ix.seas[k.i]
      l = this.#label('sea', name, RANK.sea, -scalerank, lat, lon, AREA_PX, this.#width(name, AREA_PX, true))
    }
    this.#labels.set(key, l)
    return l
  }

  #layerLabel(x: LayerLabel, rank: number): Label {
    let w = this.#widths.get(x.text)
    if (w === undefined) this.#widths.set(x.text, (w = this.#width(x.text, AREA_PX)))
    const l = this.#label('layer', x.text, rank, 0, 0, 0, AREA_PX, w)
    Cartesian3.clone(x.position, l.pos)
    l.color = x.color
    return l
  }

  #label(kind: Label['kind'], text: string, rank: number, weight: number, lat: number, lon: number, px: number, w: number): Label {
    return {
      kind, text, rank, weight, size: '', color: '', lon, lat, w, h: px * LINE, km: 0, groundM: undefined, groundKm: Infinity,
      readFrame: 0, pos: new Cartesian3(), f: NaN, relHM: NaN, alpha: 1, x: 0, y: 0, seen: 0, el: null, tx: NaN, ty: NaN, ta: NaN,
    }
  }
}

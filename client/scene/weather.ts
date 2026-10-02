// client/scene/weather.ts
// Aviation weather on the top-down map (the Layers panel's Weather switch; in the chase it is hidden: drawing real
// clouds there is a later piece of work):
// - rain radar: RainViewer's newest past frame (keyless tiles, CORS *; its free API serves zoom ≤ 7, deeper tiles are a
//   "zoom not supported" picture, so Cesium upsamples z7). Checked 2026-09-30: https://www.rainviewer.com/api.html
// - airports: each METAR a marker, north up: a dark disc ringed in its flight-rules colour (good green, marginal blue, poor
//   red, very poor magenta) holding the wind speed in the flight-data frame's unit, and an arrow out of it pointing where
//   the wind blows to (none when calm or variable), for the view's whole-degree box when it spans ≤ 40° (server/wx.ts).
// - hazard areas (SIGMETs: thunderstorms, turbulence, icing, volcanic ash…) outlined and faintly filled, labelled with
//   their name and heights.
// Hover (or tap) a marker for the airport's weather, an area for its hazard: a card in plain words (wxText.ts), never the
// raw report. Everything refreshes while shown: METARs every 5 min or when the view leaves its box, hazard areas and radar
// every 10 min. Hidden, it asks for nothing.
import {
  BillboardCollection,
  Cartesian2,
  Cartesian3,
  Color,
  CustomDataSource,
  DistanceDisplayCondition,
  ImageryLayer,
  LabelStyle,
  Math as CesiumMath,
  NearFarScalar,
  SceneTransforms,
  UrlTemplateImageryProvider,
  VerticalOrigin,
  type Billboard,
  type Viewer,
} from 'cesium'
import type { FlightCategory, Metar, Sigmet } from '../../shared/wx.ts'
import { DEFAULT_UNITS, speedIn, type Units } from '../ui/units.ts'
import {
  CONDITION, cloudText, hhmm, pressureText, sigmetLabel, sigmetLevels, sigmetTitle, stationName, tempText, visibilityText, weatherText,
  windText,
} from './wxText.ts'

const RADAR_INDEX = 'https://api.rainviewer.com/public/weather-maps.json'
const RADAR_MAX_LEVEL = 7
const RADAR_ALPHA = 0.7
const METAR_EVERY_MS = 5 * 60_000
const SLOW_EVERY_MS = 10 * 60_000 // SIGMETs and radar
const VIEW_CHECK_MS = 2_000
const MAX_SPAN_DEG = 40 // as server/wx.ts
const HOVER_PX = 16
const MARKER_PX = 48 // an airport's marker as shown; its canvas is drawn at twice that, for sharp edges
const FONT = '-apple-system, "Segoe UI", sans-serif'

export const CATEGORY_COLOR: Record<FlightCategory, string> = { VFR: '#3ddc84', MVFR: '#4f9dff', IFR: '#ff5a5a', LIFR: '#e05cff' }
const NO_CATEGORY = '#b8c2cf'

export function sigmetColor(hazard: string): string {
  if (/TS|CB/.test(hazard)) return '#ff5a5a'
  if (/TURB|MTW/.test(hazard)) return '#ffb020'
  if (/ICE/.test(hazard)) return '#4fd1ff'
  if (/VA|RDOACT/.test(hazard)) return '#c080ff'
  if (/TC/.test(hazard)) return '#ff3df0'
  if (/DS|SS/.test(hazard)) return '#d8b070'
  return '#dddddd'
}

/** Ray casting on [lon, lat] rings (degrees; areas this small need no great-circle edges). */
export function inRing(ring: [number, number][], lon: number, lat: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** The whole-degree box around a view (degrees), or null when it is too wide for airports (or no ground is in view). */
export function viewBox(r: { west: number; south: number; east: number; north: number } | null): string | null {
  if (r === null) return null
  const [s, w, n, e] = [Math.floor(r.south), Math.floor(r.west), Math.ceil(r.north), Math.ceil(r.east)]
  if (e <= w || n - s > MAX_SPAN_DEG || e - w > MAX_SPAN_DEG) return null // e ≤ w: the view crosses the antimeridian
  return `${Math.max(-90, s)},${Math.max(-180, w)},${Math.min(90, n)},${Math.min(180, e)}`
}

/** The panel's one-line summary: "Radar 18:50 · 6 airports · 1 hazard area". */
export function statusText(s: { radarTime: string; zoomedOut: boolean; airports: number; areas: number; note: string }): string {
  const count = (n: number, what: string): string => `${n} ${what}${n === 1 ? '' : 's'}`
  const parts = [
    ...(s.radarTime ? [`Radar ${s.radarTime}`] : []),
    s.zoomedOut ? 'zoom in for airports' : count(s.airports, 'airport'),
    count(s.areas, 'hazard area'),
    ...(s.note ? [s.note] : []),
  ]
  return parts.join(' · ')
}

type Pt = [number, number]

/** What an airport's marker shows: its ring's category, the wind speed in the frame's unit, and the arrow's direction. */
export interface Look {
  cat: FlightCategory | null
  shown: number
  dir: number | null // where the wind blows TO, degrees clockwise from north, to 10°; null: no arrow (calm or variable)
}

export function lookOf(m: Pick<Metar, 'cat' | 'wdir' | 'wspd'>, u: Units): Look {
  const dir = m.wdir !== null && m.wspd >= 1 ? (Math.round(((m.wdir + 180) % 360) / 10) * 10) % 360 : null
  return { cat: m.cat, shown: Math.round(speedIn(m.wspd, u.speed)), dir }
}

export const lookKey = (l: Look): string => `wx:${l.cat}:${l.shown}:${l.dir ?? '-'}`

/**
 * The wind arrow in marker pixels from the marker's centre (x right, y down), pointing `dir` degrees clockwise from north:
 * a shaft from r 12 to 19 and a head from r 17 (4.5 either side) to its tip at r 23.
 */
export function windArrow(dir: number): { shaft: [Pt, Pt]; head: [Pt, Pt, Pt] } {
  const t = (dir * Math.PI) / 180
  const [dx, dy] = [Math.sin(t), -Math.cos(t)]
  const at = (r: number, side = 0): Pt => [dx * r - dy * side, dy * r + dx * side]
  return { shaft: [at(12), at(19)], head: [at(17, -4.5), at(23), at(17, 4.5)] }
}

/** The airport marker, north up: the arrow out from under a dark disc, the disc ringed in the category's colour, the speed in it. */
function marker(look: Look): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = MARKER_PX * 2
  const g = c.getContext('2d')!
  g.scale(2, 2)
  g.translate(MARKER_PX / 2, MARKER_PX / 2) // the origin at its centre
  g.lineCap = 'round'
  g.lineJoin = 'round'
  if (look.dir !== null) {
    const { shaft, head } = windArrow(look.dir)
    const line = (): void => {
      g.beginPath()
      g.moveTo(...shaft[0])
      g.lineTo(...shaft[1])
    }
    const tip = (): void => {
      g.beginPath()
      g.moveTo(...head[0])
      g.lineTo(...head[1])
      g.lineTo(...head[2])
      g.closePath()
    }
    // a dark halo under the white: legible on the street map and on the satellite
    g.strokeStyle = 'rgba(10, 14, 22, 0.85)'
    g.lineWidth = 5
    line()
    g.stroke()
    tip()
    g.stroke()
    g.strokeStyle = '#ffffff'
    g.lineWidth = 2
    line()
    g.stroke()
    g.fillStyle = '#ffffff'
    tip()
    g.fill()
  }
  g.beginPath()
  g.arc(0, 0, 10.5, 0, Math.PI * 2)
  g.fillStyle = 'rgba(13, 17, 25, 0.92)'
  g.fill()
  g.lineWidth = 2.5
  g.strokeStyle = look.cat ? CATEGORY_COLOR[look.cat] : NO_CATEGORY
  g.stroke()
  const px = look.shown >= 100 ? 9.5 : 11 // three digits still fit inside the ring
  g.font = `${look.shown >= 100 ? 600 : 700} ${px}px ${FONT}`
  g.fillStyle = '#ffffff'
  g.textAlign = 'center'
  g.textBaseline = 'alphabetic'
  g.fillText(String(look.shown), 0, px * 0.36) // the digits' middle on the disc's: they stand about 0.72 em tall
  return c
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = className
  if (text !== '') el.textContent = text
  return el
}

/** A card's head line: the name (a hazard's with its colour as a dot), then the small id and the time, pushed right. */
function cardHead(name: string, hazardColor: string | null, id: string | null, time: string | null): HTMLElement {
  const row = h('div', 'fh-wx-h')
  const n = h('span', hazardColor === null ? 'fh-wx-name' : 'fh-wx-name fh-wx-hazard', name)
  if (hazardColor !== null) n.style.setProperty('--c', hazardColor)
  row.append(n)
  if (id !== null) row.append(h('span', 'fh-wx-id', id))
  if (time !== null) row.append(h('span', 'fh-wx-t fh-num', time))
  return row
}

/** A two-column list of the rows that have a text; null when none has. */
function cardRows(rows: [string, string | null][]): HTMLElement | null {
  const dl = h('dl', 'fh-wx-rows')
  for (const [term, text] of rows) if (text !== null) dl.append(h('dt', '', term), h('dd', '', text))
  return dl.children.length > 0 ? dl : null
}

/** An airport's card: name, id and time of the report; the condition in its colour; wind, visibility, cloud, weather, temperature, pressure. */
export function metarCard(m: Metar, u: Units): HTMLElement[] {
  const name = stationName(m.name, m.id)
  const out = [cardHead(name, null, name === m.id ? null : m.id, m.obsMs === null ? null : hhmm(m.obsMs))]
  if (m.cat !== null) {
    const cond = h('div', 'fh-wx-cond')
    cond.style.setProperty('--c', CATEGORY_COLOR[m.cat])
    cond.append(`${CONDITION[m.cat]} conditions `, h('span', 'fh-wx-code', m.cat))
    out.push(cond)
  }
  const rows = cardRows([
    ['Wind', windText(m, u)],
    ['Visibility', visibilityText(m.visKm, m.visPlus)],
    ['Cloud', cloudText(m, u)],
    ['Weather', weatherText(m.wx)],
    ['Temperature', tempText(m.tempC, m.dewC)],
    ['Pressure', pressureText(m.qnhHpa)],
  ])
  if (rows !== null) out.push(rows)
  return out
}

/** The hazard areas over a point: a card each (its name in its colour, until when, the heights), a hairline between. */
export function sigmetCards(list: Sigmet[], u: Units): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const s of list) {
    if (out.length > 0) out.push(h('div', 'fh-wx-sep'))
    const until = Date.parse(s.until)
    out.push(cardHead(sigmetTitle(s), sigmetColor(s.hazard), null, Number.isNaN(until) ? null : `until ${hhmm(until)}`))
    const rows = cardRows([['Height', sigmetLevels(s, u)]])
    if (rows !== null) out.push(rows)
  }
  return out
}

export interface WeatherOptions {
  units?: () => Units // what speeds and heights are worded in (the flight-data frame's); default knots and feet
}

export class Weather {
  private shown = false
  private radar: ImageryLayer | null = null
  private radarTime = ''
  private readonly stations = new BillboardCollection()
  private metars: Metar[] = []
  // ponytail: a look is kept for the session (a 96 px canvas, and its place in the billboards' atlas): a few dozen in a view, a few
  // hundred over a long Europe-wide session. Upgrade: round the speed to 5 kt, or evict the looks no marker shows.
  private readonly looks = new Map<string, HTMLCanvasElement>()
  private sigmets: Sigmet[] = []
  private readonly areas = new CustomDataSource('sigmets')
  private box: string | null = null
  private boxMs = -Infinity
  private slowMs = -Infinity
  private timer: ReturnType<typeof setInterval> | null = null
  private note = ''
  private readonly tip: HTMLDivElement
  private tipKey = '' // what the card holds, so a pointer move over the same thing does not rebuild it
  private hoverAt: { x: number; y: number } | null = null
  private hoverRaf = 0

  private readonly viewer: Viewer
  private readonly apiBase: string
  private readonly onStatus: (text: string | null) => void
  private readonly units: () => Units

  /** apiBase: the app's /api; the hover card goes in tipParent; onStatus hears a one-line summary for the panel. */
  constructor(viewer: Viewer, apiBase: string, tipParent: HTMLElement, onStatus: (text: string | null) => void = () => {}, opts: WeatherOptions = {}) {
    this.viewer = viewer
    this.apiBase = apiBase
    this.onStatus = onStatus
    this.units = opts.units ?? (() => DEFAULT_UNITS)
    viewer.scene.primitives.add(this.stations)
    this.stations.show = false
    void viewer.dataSources.add(this.areas)
    this.areas.show = false
    this.tip = document.createElement('div')
    this.tip.className = 'fh-wx-tip fh-glass'
    this.tip.hidden = true
    tipParent.append(this.tip)
    viewer.canvas.addEventListener('pointermove', this.onPointer)
    viewer.canvas.addEventListener('pointerdown', this.onPointer)
    viewer.canvas.addEventListener('pointerleave', this.onLeave)
  }

  get show(): boolean {
    return this.shown
  }

  set show(on: boolean) {
    if (on === this.shown) return
    this.shown = on
    this.stations.show = on
    this.areas.show = on
    if (this.radar) this.radar.show = on
    if (!on) {
      this.onLeave()
      if (this.timer !== null) clearInterval(this.timer)
      this.timer = null
      return
    }
    this.tick()
    this.status()
    this.timer = setInterval(() => this.tick(), VIEW_CHECK_MS)
  }

  private status(): void {
    if (!this.shown) return
    this.onStatus(statusText({ radarTime: this.radarTime, zoomedOut: this.box === null, airports: this.metars.length, areas: this.sigmets.length, note: this.note }))
  }

  private tick(): void {
    const now = Date.now()
    if (now - this.slowMs >= SLOW_EVERY_MS) {
      this.slowMs = now
      void this.loadRadar()
      void this.loadSigmets()
    }
    const r = this.viewer.camera.computeViewRectangle()
    const box = viewBox(r ? { west: CesiumMath.toDegrees(r.west), south: CesiumMath.toDegrees(r.south), east: CesiumMath.toDegrees(r.east), north: CesiumMath.toDegrees(r.north) } : null)
    if (box !== this.box || (box !== null && now - this.boxMs >= METAR_EVERY_MS)) {
      this.box = box
      this.boxMs = now
      if (box === null) this.setMetars([])
      else void this.loadMetars(box)
      this.status()
    }
  }

  private async get<T>(url: string): Promise<T | null> {
    try {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return (await r.json()) as T
    } catch (e) {
      console.warn(`FlightHopper: weather ${url}:`, e)
      this.note = 'some weather unavailable'
      return null
    }
  }

  private async loadRadar(): Promise<void> {
    const idx = await this.get<{ host: string; radar: { past: { time: number; path: string }[] } }>(RADAR_INDEX)
    const last = idx?.radar.past.at(-1)
    if (!idx || !last) return this.status()
    const layers = this.viewer.imageryLayers
    const next = new ImageryLayer(
      new UrlTemplateImageryProvider({ url: `${idx.host}${last.path}/256/{z}/{x}/{y}/2/1_1.png`, maximumLevel: RADAR_MAX_LEVEL }),
      { alpha: RADAR_ALPHA, show: this.shown },
    )
    layers.add(next) // on top of the map, the satellite and the roads
    if (this.radar) layers.remove(this.radar, true)
    this.radar = next
    this.radarTime = hhmm(last.time * 1000)
    this.status()
  }

  private async loadSigmets(): Promise<void> {
    const list = await this.get<Sigmet[]>(`${this.apiBase}/wx/sigmet`)
    if (list === null) return this.status()
    this.sigmets = list
    this.tipKey = ''
    const u = this.units()
    const ents = this.areas.entities
    ents.suspendEvents()
    ents.removeAll()
    for (const s of list) {
      const color = Color.fromCssColorString(sigmetColor(s.hazard))
      for (const ring of s.rings) {
        const pos = Cartesian3.fromDegreesArray(ring.flat())
        ents.add({ polygon: { hierarchy: pos, material: color.withAlpha(0.12) } })
        ents.add({ polyline: { positions: [...pos, pos[0]], width: 2, material: color.withAlpha(0.9), clampToGround: true } })
      }
      const ring = s.rings[0]
      const [lon, lat] = ring.reduce(([a, b], [x, y]) => [a + x / ring.length, b + y / ring.length], [0, 0])
      ents.add({
        position: Cartesian3.fromDegrees(lon, lat),
        label: {
          text: sigmetLabel(s, u), font: '600 12px -apple-system, "Segoe UI", sans-serif', fillColor: color,
          outlineColor: Color.fromCssColorString('#0a0e16'), outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          translucencyByDistance: new NearFarScalar(2e6, 1, 8e6, 0),
        },
      })
    }
    ents.resumeEvents()
    this.status()
  }

  private async loadMetars(box: string): Promise<void> {
    const list = await this.get<Metar[]>(`${this.apiBase}/wx/metar?bbox=${box}`)
    if (list === null || box !== this.box) return this.status() // the view moved on while it loaded
    this.note = ''
    this.setMetars(list)
    this.status()
  }

  private setMetars(list: Metar[]): void {
    this.metars = list
    this.tipKey = ''
    const u = this.units()
    this.stations.removeAll()
    for (const m of list) {
      const b: Billboard = this.stations.add({
        position: Cartesian3.fromDegrees(m.lon, m.lat),
        width: MARKER_PX,
        height: MARKER_PX,
        verticalOrigin: VerticalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new DistanceDisplayCondition(0, 6e6),
      })
      const look = lookOf(m, u)
      const key = lookKey(look) // one texture per look, not per airport
      let img = this.looks.get(key)
      if (img === undefined) this.looks.set(key, (img = marker(look)))
      b.setImage(key, img)
      b.id = m
    }
  }

  private readonly onPointer = (e: PointerEvent): void => {
    if (!this.shown) return
    this.hoverAt = { x: e.offsetX, y: e.offsetY }
    this.hoverRaf ||= requestAnimationFrame(() => {
      this.hoverRaf = 0
      this.hover()
    })
  }

  private readonly onLeave = (): void => {
    this.hoverAt = null
    this.tip.hidden = true
    this.tipKey = ''
  }

  /** The card of the marker nearest the pointer (≤ 16 px), else of the hazard areas over the ground under it. */
  private hover(): void {
    const at = this.hoverAt
    if (at === null) return
    const scene = this.viewer.scene
    const win = new Cartesian2()
    let best: Metar | null = null
    let bestD = HOVER_PX
    for (const m of this.metars) {
      if (!SceneTransforms.worldToWindowCoordinates(scene, Cartesian3.fromDegrees(m.lon, m.lat), win)) continue
      const d = Math.hypot(win.x - at.x, win.y - at.y)
      if (d < bestD) [best, bestD] = [m, d]
    }
    let over: Sigmet[] = []
    if (best === null) {
      const ground = this.viewer.camera.pickEllipsoid(new Cartesian2(at.x, at.y))
      if (ground) {
        const c = scene.globe.ellipsoid.cartesianToCartographic(ground)
        const [lon, lat] = [CesiumMath.toDegrees(c.longitude), CesiumMath.toDegrees(c.latitude)]
        over = this.sigmets.filter((s) => s.rings.some((r) => inRing(r, lon, lat)))
      }
    }
    const u = this.units()
    const what = best !== null ? `m:${best.id}` : over.length > 0 ? `s:${over.map((s) => this.sigmets.indexOf(s)).join(',')}` : null
    this.tip.hidden = what === null
    if (what === null) return
    const key = `${what}|${u.alt}|${u.speed}`
    if (this.tipKey !== key) {
      this.tipKey = key
      this.tip.replaceChildren(...(best !== null ? metarCard(best, u) : sigmetCards(over, u)))
    }
    const r = this.viewer.canvas.getBoundingClientRect()
    const left = Math.min(at.x + 16, r.width - this.tip.offsetWidth - 8)
    const top = at.y + 16 + this.tip.offsetHeight > r.height ? at.y - 16 - this.tip.offsetHeight : at.y + 16
    this.tip.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`
  }

  destroy(): void {
    this.show = false
    cancelAnimationFrame(this.hoverRaf)
    const c = this.viewer.canvas
    c.removeEventListener('pointermove', this.onPointer)
    c.removeEventListener('pointerdown', this.onPointer)
    c.removeEventListener('pointerleave', this.onLeave)
    this.tip.remove()
    if (this.radar) this.viewer.imageryLayers.remove(this.radar, true)
    this.viewer.scene.primitives.remove(this.stations)
    void this.viewer.dataSources.remove(this.areas, true)
  }
}

// client/scene/weather.ts
// Aviation weather on the top-down map (the Layers panel's Weather switch; in the chase it is hidden: drawing real
// clouds there is a later piece of work):
// - rain radar: RainViewer's newest past frame (keyless tiles, CORS *; its free API serves zoom ≤ 7). Checked 2026-09-30:
//   https://www.rainviewer.com/api.html. radar.ts draws it smooth to zoom 12, in a palette for the map under it (theme), and
//   it lies under the map's names and lines (radarIndex; mapLayer.ts lifts their ink over it).
// - airports: each METAR a marker, north up: a dark disc ringed in its flight-rules colour (good green, marginal blue, poor
//   red, very poor magenta) holding the wind speed in the flight-data frame's unit, and an arrow out of it pointing where
//   the wind blows to (none when calm or variable), for the view's whole-degree box when it spans ≤ 40° (server/wx.ts).
// - hazard areas (SIGMETs: thunderstorms, turbulence, icing, volcanic ash…) outlined and faintly filled, labelled with
//   their name and heights.
// Hover (or tap) a marker for the airport's weather, an area for its hazard: a card in plain words (wxCard.ts), never the
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
  RequestState,
  SceneTransforms,
  UrlTemplateImageryProvider,
  VerticalOrigin,
  type Billboard,
  type ImageryTypes,
  type Request,
  type Viewer,
} from 'cesium'
import type { FlightCategory, Metar, Sigmet } from '../../shared/wx.ts'
import { DEFAULT_UNITS, speedIn, type Units } from '../ui/units.ts'
import { queueDraw } from './drawQueue.ts'
import { whenTilesLoaded } from './mapLayer.ts'
import { RADAR_MAX_LEVEL, RADAR_SRC_MAX, RAIN_PALETTE, RadarSource, renderTile, sourceTiles, type Palette } from './radar.ts'
import { metarCard, sigmetCards } from './wxCard.ts'
import { CATEGORY_COLOR, hhmm, sigmetColor, sigmetLabel } from './wxText.ts'

const RADAR_INDEX = 'https://api.rainviewer.com/public/weather-maps.json'
const METAR_EVERY_MS = 5 * 60_000
const SLOW_EVERY_MS = 10 * 60_000 // SIGMETs and radar
const VIEW_CHECK_MS = 2_000
const MAX_SPAN_DEG = 40 // as server/wx.ts
const HOVER_PX = 16
export const MARKER_PX = 48 // an airport's marker as shown; its canvas is drawn at twice that, for sharp edges
const FONT = '-apple-system, "Segoe UI", sans-serif'

const NO_CATEGORY = '#b8c2cf' // the ring of a report with no flight category

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
 * a shaft from r 12 to 16 and a head from r 15.5 (4.5 either side) to its tip at r 21.5, so its 5 px halo ends at the canvas edge.
 */
export function windArrow(dir: number): { shaft: [Pt, Pt]; head: [Pt, Pt, Pt] } {
  const t = (dir * Math.PI) / 180
  const [dx, dy] = [Math.sin(t), -Math.cos(t)]
  const at = (r: number, side = 0): Pt => [dx * r - dy * side, dy * r + dx * side]
  return { shaft: [at(12), at(16)], head: [at(15.5, -4.5), at(21.5), at(15.5, 4.5)] }
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

export interface WeatherOptions {
  units?: () => Units // what speeds and heights are worded in (the flight-data frame's); default knots and feet
  radarIndex?: () => number // where in the imagery stack each radar layer goes, asked as it is added; default, or below 0: on top
}

let blankTile: ImageData | null = null
/** One clear pixel for every tile that draws nothing: Cesium stretches it over the tile (a 4-byte texture, not 256 KB). */
const blank = (): ImageData => (blankTile ??= new ImageData(1, 1))

/**
 * RainViewer's frame drawn smooth (radar.ts' renderTile) in a palette: Cesium asks for tiles up to RADAR_MAX_LEVEL. Each
 * is ImageData, north-up, in straight alpha. Cesium's Texture uploads it as it does an image (texImage2D, flipped, alpha
 * not premultiplied; its types leave ImageData out), where a canvas would premultiply it and lose the colour of clear
 * pixels, so filtering would darken the rain's edges.
 */
export class RadarProvider extends UrlTemplateImageryProvider {
  readonly source: RadarSource
  readonly palette: Palette
  private gone = false

  constructor(source: RadarSource, palette: Palette) {
    super({ url: source.url, maximumLevel: RADAR_MAX_LEVEL })
    this.source = source
    this.palette = palette
  }

  /** Its layer is gone: tiles still waiting to be drawn are not. */
  drop(): void {
    this.gone = true
  }

  get dropped(): boolean {
    return this.gone
  }

  override requestImage(x: number, y: number, level: number, request?: Request): Promise<ImageryTypes> {
    const z = Math.min(level, RADAR_SRC_MAX)
    const need = sourceTiles(level, x, y)
    const image = Promise.all(need.map(([sx, sy]) => this.source.get(z, sx, sy))).then((got) => {
      if (got.every((t) => t === null)) return blank()
      const at = new Map(need.map(([sx, sy], i) => [`${sx}/${sy}`, got[i]]))
      return queueDraw(() => {
        const px = renderTile(level, x, y, (sx, sy) => at.get(`${sx}/${sy}`) ?? null, this.palette)
        return px === null ? blank() : new ImageData(px, 256, 256)
      }, () => !this.gone)
    })
    return image.catch((e: unknown) => {
      // Cesium takes a cancelled request as "ask again later" and logs nothing; any other failure it logs, tile by tile.
      if (this.gone && request !== undefined) (request as { state: RequestState }).state = RequestState.CANCELLED
      throw e
    }) as unknown as Promise<ImageryTypes>
  }
}

/**
 * The rain radar's imagery layer: a RainViewer frame (one RadarSource, so a palette change fetches nothing again) drawn
 * in a palette, on top of all imagery, or from index() up when one is given (not negative). A new frame or palette loads
 * unseen on top (a shown layer loads its tiles; at alpha 0 Cesium draws none of it) and takes over once they are in: drawn,
 * and the old layer gone, in the same frame. So the rain never blinks out and two frames are never drawn at once. While
 * hidden it takes over at once.
 */
export class RadarLayer {
  private readonly viewer: Viewer
  private readonly index: (() => number) | undefined
  private pal: Palette
  private shown = false
  private source: RadarSource | null = null
  private path = ''
  private layer: ImageryLayer | null = null // the one drawn
  private next: ImageryLayer | null = null // its replacement while that loads
  private stopWait: (() => void) | null = null
  private gone = false

  /** index: where in the imagery stack a layer goes, asked as it is added (default, or below 0: on top). */
  constructor(viewer: Viewer, palette: Palette, index?: () => number) {
    this.viewer = viewer
    this.pal = palette
    this.index = index
  }

  get show(): boolean {
    return this.shown
  }

  set show(on: boolean) {
    this.shown = on
    if (!on) this.settle()
    if (this.layer) this.layer.show = on
  }

  get palette(): Palette {
    return this.pal
  }

  set palette(p: Palette) {
    if (p === this.pal) return
    this.pal = p
    if (this.source) this.put()
  }

  /** RainViewer's frame at host + path; the frame already drawn is not loaded again. */
  frame(host: string, path: string): void {
    if (path === this.path) return
    this.path = path
    this.source = new RadarSource(host, path)
    this.put()
  }

  private put(): void {
    if (this.gone || this.source === null) return
    this.stopWait?.()
    this.stopWait = null
    if (this.next !== null) this.retire(this.next) // nobody saw it
    this.next = null
    const drawn = this.layer === null ? null : (this.layer.imageryProvider as RadarProvider)
    if (drawn !== null && drawn.source === this.source && drawn.palette === this.pal) return // back to what is drawn
    const swap = this.shown && this.layer !== null
    const layer = new ImageryLayer(new RadarProvider(this.source, this.pal), { show: this.shown, alpha: swap ? 0 : 1 })
    const at = this.index?.() ?? -1 // the map's liftIndex is -1 once it is destroyed: on top then, as add(layer, -1) throws
    this.viewer.imageryLayers.add(layer, at < 0 ? undefined : at)
    if (!swap) {
      if (this.layer !== null) this.retire(this.layer)
      this.layer = layer
      return
    }
    this.next = layer
    this.stopWait = whenTilesLoaded(this.viewer.scene, () => {
      this.stopWait = null
      this.settle()
    })
  }

  /** The replacement, if any, is drawn and the layer it replaces goes. */
  private settle(): void {
    this.stopWait?.()
    this.stopWait = null
    if (this.next === null) return
    this.next.alpha = 1
    if (this.layer !== null) this.retire(this.layer)
    this.layer = this.next
    this.next = null
  }

  private retire(l: ImageryLayer): void {
    ;(l.imageryProvider as RadarProvider).drop()
    this.viewer.imageryLayers.remove(l, true)
  }

  destroy(): void {
    this.gone = true
    this.stopWait?.()
    this.stopWait = null
    for (const l of [this.next, this.layer]) if (l !== null) this.retire(l)
    this.next = this.layer = null
  }
}

export class Weather {
  private shown = false
  private readonly radar: RadarLayer
  private mapTheme: 'light' | 'dark' = 'dark'
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
    this.radar = new RadarLayer(viewer, RAIN_PALETTE[this.mapTheme], opts.radarIndex)
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
    this.radar.show = on
    if (!on) {
      this.onLeave()
      if (this.timer !== null) clearInterval(this.timer)
      this.timer = null
      return
    }
    this.setMetars(this.metars) // the frame's units change in the chase, where this is hidden: re-word what was drawn (looks are cached)
    this.drawAreas()
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

  /** The map under the rain, which picks the radar's palette: light for the light street map, else dark (the default). */
  get theme(): 'light' | 'dark' {
    return this.mapTheme
  }

  set theme(t: 'light' | 'dark') {
    this.mapTheme = t
    this.radar.palette = RAIN_PALETTE[t]
  }

  private async loadRadar(): Promise<void> {
    const idx = await this.get<{ host: string; radar: { past: { time: number; path: string }[] } }>(RADAR_INDEX)
    const last = idx?.radar.past.at(-1)
    if (!idx || !last) return this.status()
    this.radar.frame(idx.host, last.path)
    this.radarTime = hhmm(last.time * 1000)
    this.status()
  }

  private async loadSigmets(): Promise<void> {
    const list = await this.get<Sigmet[]>(`${this.apiBase}/wx/sigmet`)
    if (list === null) return this.status()
    this.sigmets = list
    this.tipKey = ''
    this.drawAreas()
    this.status()
  }

  /** The hazard areas as outlines on a faint fill, each with its label, worded in the frame's units. */
  private drawAreas(): void {
    const u = this.units()
    const ents = this.areas.entities
    ents.suspendEvents()
    ents.removeAll()
    for (const s of this.sigmets) {
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
          text: sigmetLabel(s, u), font: `600 12px ${FONT}`, fillColor: color,
          outlineColor: Color.fromCssColorString('#0a0e16'), outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          translucencyByDistance: new NearFarScalar(2e6, 1, 8e6, 0),
        },
      })
    }
    ents.resumeEvents()
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
    this.radar.destroy()
    this.viewer.scene.primitives.remove(this.stations)
    void this.viewer.dataSources.remove(this.areas, true)
  }
}

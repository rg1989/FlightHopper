// client/scene/weather.ts
// Aviation weather on the top-down map (the Layers panel's Weather switch; in the chase it is hidden: drawing real
// clouds there is a later piece of work):
// - rain radar: RainViewer's newest past frame (keyless tiles, CORS *; its free API serves zoom ≤ 7, deeper tiles are a
//   "zoom not supported" picture, so Cesium upsamples z7). Checked 2026-09-30: https://www.rainviewer.com/api.html
// - airports: each METAR a dot in its flight-rules colour (VFR green, MVFR blue, IFR red, LIFR magenta) with a wind barb
//   (staff into the wind, a half barb 5 kt, a full 10 kt, a pennant 50 kt; a ring when calm), for the view's whole-degree
//   box when it spans ≤ 40° (server/wx.ts).
// - SIGMETs: hazard areas (thunderstorms, turbulence, icing, volcanic ash…) outlined and faintly filled, labelled with
//   hazard and levels.
// Hover (or tap) a dot for its METAR, an area for its SIGMET. Everything refreshes while shown: METARs every 5 min or when
// the view leaves its box, SIGMETs and radar every 10 min. Hidden, it asks for nothing.
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

const RADAR_INDEX = 'https://api.rainviewer.com/public/weather-maps.json'
const RADAR_MAX_LEVEL = 7
const RADAR_ALPHA = 0.7
const METAR_EVERY_MS = 5 * 60_000
const SLOW_EVERY_MS = 10 * 60_000 // SIGMETs and radar
const VIEW_CHECK_MS = 2_000
const MAX_SPAN_DEG = 40 // as server/wx.ts
const HOVER_PX = 16

export const CATEGORY_COLOR: Record<FlightCategory, string> = { VFR: '#3ddc84', MVFR: '#4f9dff', IFR: '#ff5a5a', LIFR: '#e05cff' }
const NO_CATEGORY = '#b8c2cf'

/** Barbs for a wind speed, rounded to 5 kt: pennants (50), full barbs (10), a half barb (5). */
export function barbs(kt: number): { pennants: number; full: number; half: boolean } {
  let r = Math.round(kt / 5) * 5
  const pennants = Math.floor(r / 50)
  r -= pennants * 50
  return { pennants, full: Math.floor(r / 10), half: r % 10 === 5 }
}

export function sigmetColor(hazard: string): string {
  if (/TS|CB/.test(hazard)) return '#ff5a5a'
  if (/TURB|MTW/.test(hazard)) return '#ffb020'
  if (/ICE/.test(hazard)) return '#4fd1ff'
  if (/VA|RDOACT/.test(hazard)) return '#c080ff'
  if (/TC/.test(hazard)) return '#ff3df0'
  if (/DS|SS/.test(hazard)) return '#d8b070'
  return '#dddddd'
}

/** "TS EMBD FL350", "TURB SEV SFC–FL055": the area's label. */
export function sigmetLabel(s: Sigmet): string {
  const fl = (ft: number): string => (ft <= 0 ? 'SFC' : `FL${String(Math.round(ft / 100)).padStart(3, '0')}`)
  const levels = s.top === null ? '' : s.base === null ? ` ${fl(s.top)}` : ` ${fl(s.base)}–${fl(s.top)}`
  return `${s.hazard}${s.qualifier ? ` ${s.qualifier}` : ''}${levels}`
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

/** The station symbol, north up: a dot in its category's colour, the wind's staff up from it with barbs on the right. */
function symbol(cat: FlightCategory | null, kt: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  g.lineCap = 'round'
  g.lineJoin = 'round'
  const stroke = (draw: () => void): void => {
    // a dark halo under a white line: legible on the street map and on the satellite
    g.strokeStyle = 'rgba(10, 14, 22, 0.85)'
    g.lineWidth = 6
    draw()
    g.stroke()
    g.strokeStyle = '#ffffff'
    g.lineWidth = 2.75
    draw()
    g.stroke()
  }
  const b = barbs(kt)
  if (b.pennants + b.full === 0 && !b.half) {
    stroke(() => {
      g.beginPath()
      g.arc(32, 32, 12, 0, Math.PI * 2) // calm
    })
  } else {
    const top = 6
    stroke(() => {
      g.beginPath()
      g.moveTo(32, 32)
      g.lineTo(32, top)
      let y = top
      for (let i = 0; i < b.pennants; i++, y += 7) {
        g.moveTo(32, y)
        g.lineTo(45, y + 2)
        g.lineTo(32, y + 6)
      }
      for (let i = 0; i < b.full; i++, y += 5) {
        g.moveTo(32, y)
        g.lineTo(45, y - 4)
      }
      if (b.half) {
        if (y === top) y += 5 // a lone half barb sits a step in from the end, so it is not read as a full one
        g.moveTo(32, y)
        g.lineTo(38.5, y - 2)
      }
    })
    if (b.pennants > 0) {
      g.fillStyle = '#ffffff'
      for (let i = 0, y = top; i < b.pennants; i++, y += 7) {
        g.beginPath()
        g.moveTo(32, y)
        g.lineTo(45, y + 2)
        g.lineTo(32, y + 6)
        g.fill()
      }
    }
  }
  g.beginPath()
  g.arc(32, 32, 7.5, 0, Math.PI * 2)
  g.fillStyle = cat ? CATEGORY_COLOR[cat] : NO_CATEGORY
  g.fill()
  g.lineWidth = 2
  g.strokeStyle = 'rgba(10, 14, 22, 0.9)'
  g.stroke()
  return c
}

export class Weather {
  private shown = false
  private radar: ImageryLayer | null = null
  private radarTime = ''
  private readonly stations = new BillboardCollection()
  private metars: Metar[] = []
  private readonly looks = new Map<string, HTMLCanvasElement>()
  private sigmets: Sigmet[] = []
  private readonly areas = new CustomDataSource('sigmets')
  private box: string | null = null
  private boxMs = -Infinity
  private slowMs = -Infinity
  private timer: ReturnType<typeof setInterval> | null = null
  private note = ''
  private readonly tip: HTMLDivElement
  private hoverAt: { x: number; y: number } | null = null
  private hoverRaf = 0

  private readonly viewer: Viewer
  private readonly apiBase: string
  private readonly onStatus: (text: string | null) => void

  /** apiBase: the app's /api; the hover readout goes in tipParent; onStatus hears a one-line summary for the panel. */
  constructor(viewer: Viewer, apiBase: string, tipParent: HTMLElement, onStatus: (text: string | null) => void = () => {}) {
    this.viewer = viewer
    this.apiBase = apiBase
    this.onStatus = onStatus
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
    const parts: string[] = []
    if (this.radarTime) parts.push(`Radar ${this.radarTime}`)
    parts.push(this.box === null ? 'zoom in for airports' : `${this.metars.length} airports`)
    parts.push(`${this.sigmets.length} SIGMET${this.sigmets.length === 1 ? '' : 's'}`)
    this.onStatus(this.note ? `${parts.join(' · ')} · ${this.note}` : parts.join(' · '))
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
    this.radarTime = `${new Date(last.time * 1000).toISOString().slice(11, 16)}Z`
    this.status()
  }

  private async loadSigmets(): Promise<void> {
    const list = await this.get<Sigmet[]>(`${this.apiBase}/wx/sigmet`)
    if (list === null) return this.status()
    this.sigmets = list
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
          text: sigmetLabel(s), font: '600 12px -apple-system, "Segoe UI", sans-serif', fillColor: color,
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
    this.stations.removeAll()
    for (const m of list) {
      const kt = Math.round(m.wspd / 5) * 5
      const b: Billboard = this.stations.add({
        position: Cartesian3.fromDegrees(m.lon, m.lat),
        width: 44,
        height: 44,
        verticalOrigin: VerticalOrigin.CENTER,
        alignedAxis: Cartesian3.UNIT_Z, // rotation measured from north
        rotation: m.wdir === null || kt === 0 ? 0 : -CesiumMath.toRadians(m.wdir),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new DistanceDisplayCondition(0, 6e6),
      })
      const look = `wx:${m.cat}:${kt}` // one texture per look, not per airport
      let img = this.looks.get(look)
      if (img === undefined) this.looks.set(look, (img = symbol(m.cat, kt)))
      b.setImage(look, img)
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
  }

  /** The METAR of the dot nearest the pointer (≤ 16 px), else the SIGMETs over the ground under it. */
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
    let text: string | null = best?.raw ?? null
    if (text === null) {
      const ground = this.viewer.camera.pickEllipsoid(new Cartesian2(at.x, at.y))
      if (ground) {
        const c = scene.globe.ellipsoid.cartesianToCartographic(ground)
        const [lon, lat] = [CesiumMath.toDegrees(c.longitude), CesiumMath.toDegrees(c.latitude)]
        const over = this.sigmets.filter((s) => s.rings.some((r) => inRing(r, lon, lat)))
        if (over.length > 0) text = over.map((s) => `${sigmetLabel(s)} until ${s.until.slice(11, 16)}Z\n${s.raw}`).join('\n\n')
      }
    }
    this.tip.hidden = text === null
    if (text === null) return
    if (this.tip.textContent !== text) this.tip.textContent = text
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

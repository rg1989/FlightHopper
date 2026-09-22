// client/app.ts
// The client app: one Cesium viewer in two modes, fed by 1 Hz polls of the server.
// - Browse (nothing selected): a north-up, top-down street map. Every aircraft is an icon turned to its track and
//   coloured by altitude, with the table of the aircraft on screen on the right and the altitude legend at the bottom.
// - Chase (an aircraft selected by a table row, a click on its icon or ?hex=): the 3-D model and the chase camera over
//   the satellite imagery, the detail panel on the left and the HUD. The other aircraft stay on screen as icons.
// Every aircraft goes into the Fleet (newest sample, dead-reckoned: cheap enough for thousands a frame). Only the
// selected one also goes into the TrackRegistry, whose full estimator the chase camera follows.
// This file only wires the parts in scene/, track/, browse/, ui/, bench/ and api.ts together.
import { Cartesian2, Cartesian3, Cartographic, Math as CesiumMath, ScreenSpaceEventHandler, ScreenSpaceEventType } from 'cesium'
import type { Viewer } from 'cesium'
import { AIRLINES_CREDIT, airlineOf } from '../shared/airlines.ts'
import type { Airport } from '../shared/airports.ts'
import type { ChaseResponse, StatusBrief } from '../shared/api.ts'
import { distanceNm } from '../shared/geo.ts'
import { countryOf, flagEmoji } from '../shared/icaoCountry.ts'
import type { AircraftInfo } from '../shared/info.ts'
import type { ReadsbAircraft } from '../shared/types.ts'
import { ApiClient } from './api.ts'
import { BenchRecorder } from './bench/overlay.ts'
import { Fleet } from './browse/fleet.ts'
import { containsDeg, enterBrowse, exitBrowse, viewRectangleDeg } from './scene/browseCamera.ts'
import type { RectDeg } from './scene/browseCamera.ts'
import { ChaseCamera } from './scene/chaseCamera.ts'
import { FleetLayer } from './scene/fleetLayer.ts'
import { makeMapLayer } from './scene/mapLayer.ts'
import { ChaseModel } from './scene/model.ts'
import { addRunways } from './scene/runways.ts'
import { createViewer } from './scene/viewer.ts'
import { MIN_DELAY_S, RenderClock } from './track/delay.ts'
import { TrackRegistry } from './track/registry.ts'
import type { ClientConfig, FleetEntry, ModelManifest, ModelManifestEntry, RenderState } from './types.ts'
import { mountAttribution, mountBanner } from './ui/banner.ts'
import { mountDetail } from './ui/detail.ts'
import type { Lookup } from './ui/detail.ts'
import { mountHud } from './ui/hud.ts'
import { mountLegend } from './ui/legend.ts'
import { PhotoCache } from './ui/photo.ts'
import { mountTable } from './ui/table.ts'
import './ui/layout.css'

const POLL_MS = 1000 // view and chase both poll at 1 Hz; TrackRegistry's pollPeriodS says the same
const PRUNE_AGE_S = 60 // forget an aircraft one minute after its newest sample (FleetLayer hides it at that age too)
const FAILS_DOWN = 3 // failed polls in a row before the banner reports it
const START_HEIGHT_M = 60_000 // ?hex= start: straight down on the hero airport until the chase camera takes over
const MIN_VIEW_NM = 20
const MAX_VIEW_NM = 250 // the server's cap: it polls an area source (adsb.lol) out to this radius
const HOVER_PICK_MS = 100 // at most ten hover picks a second while the mouse moves (each pick is a small render pass)
const HEX = /^~?[0-9a-f]{6}$/
// Until the first reply. Nothing is drawn before it, so the source named here is never shown.
const NO_STATUS: StatusBrief = { source: 'adsblol', degraded: null, cellPeriodP95S: null, chasePeriodP95S: null }
const NO_ENTRIES: readonly FleetEntry[] = []

/** Radius in whole 10 nm steps (so the ApiClient's per-view `since` key survives small changes), clamped to 20–250 nm. */
function viewNm(nm: number): number {
  const r = Math.ceil(nm / 10) * 10
  return Number.isFinite(r) ? Math.min(MAX_VIEW_NM, Math.max(MIN_VIEW_NM, r)) : MAX_VIEW_NM
}

/**
 * Radius of the chase view poll: the camera height in nm (a top-down view shows about ±0.6 h), in 10 nm steps, 20–250 nm.
 * ponytail: a tilted camera sees further than its height; the far part of such a view stays empty until the user looks
 * down. Upgrade: size the circle from the frustum's ground footprint (browseCircle does, for the top-down view).
 */
export function viewRadiusNm(cameraHeightM: number): number {
  return viewNm(cameraHeightM / 1852)
}

const round2 = (deg: number): number => Math.round(deg * 100) / 100
const wrap180 = (lon: number): number => ((((lon + 180) % 360) + 360) % 360) - 180

/**
 * The browse view poll: the circle around the visible rectangle, centred on it (to 0.01°, the ApiClient's key) and
 * reaching its farthest corner (a lat/lon rectangle's farthest point from inside it is a corner), 20–250 nm.
 * A view wider than 500 nm gets the 250 nm around its centre. A rectangle with west > east spans the antimeridian.
 * ponytail: every pan moves the centre, so the first poll after it is a new view key and a full (since=0) reply
 * (~200 KB gzipped for 5,000 aircraft). Upgrade: snap the centre to a grid so small pans keep their key.
 */
export function browseCircle(r: RectDeg): { lat: number; lon: number; nm: number } {
  const spanDeg = r.west <= r.east ? r.east - r.west : r.east + 360 - r.west
  const lat = round2((r.south + r.north) / 2)
  const lon = round2(wrap180(r.west + spanDeg / 2))
  const farNm = Math.max(
    distanceNm(lat, lon, r.south, r.west),
    distanceNm(lat, lon, r.south, r.east),
    distanceNm(lat, lon, r.north, r.west),
    distanceNm(lat, lon, r.north, r.east),
  )
  return { lat, lon, nm: viewNm(farNm) }
}

/**
 * The entries inside r (r null: the globe is out of view), plus the one with keepHex, written into out, which is
 * returned. Allocates nothing. keepHex is the selected aircraft: chasing, it flies in front of the camera but above the
 * ground rectangle the camera sees, which starts beyond it.
 */
export function entriesIn(entries: readonly FleetEntry[], r: RectDeg | null, out: FleetEntry[], keepHex: string | null = null): FleetEntry[] {
  out.length = 0
  if (r === null && keepHex === null) return out
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e.hex === keepHex || (r !== null && containsDeg(r, e.lat, e.lon))) out.push(e)
  }
  return out
}

/** Flag emoji of the country the ICAO address is allocated to; '' when none (non-ICAO '~' address, unallocated block). */
export function flagOf(hex: string): string {
  const c = countryOf(hex)
  return c === null ? '' : flagEmoji(c.iso2)
}

/** Country (from the address) and airline (from the callsign) for the detail panel. countryOf's object is shared: copied. */
export function lookupFor(hex: string, callsign: string | null): Lookup {
  const c = countryOf(hex)
  return { country: c === null ? null : { iso2: c.iso2, name: c.name, flag: flagEmoji(c.iso2) }, airline: airlineOf(callsign) }
}

/**
 * Height for the chased model and camera. hM is the wheels' height (see modelMatrixFor). On the ground the wheels sit on
 * the loaded terrain; in the air they never go below it. terrainM null = tile not loaded yet: keep the estimate.
 * ponytail: terrain, not the runway plane; M4's geometric touchdown replaces this clamp.
 */
export function placedHeightM(hM: number, onGround: boolean, terrainM: number | null): number {
  if (terrainM === null) return hM
  return onGround ? terrainM : Math.max(hM, terrainM)
}

export interface AppParams {
  hex: string | null // ?hex=a1b2c3: chase this aircraft from the start (G3; the detail panel's "Copy link")
  bench: boolean // ?bench=1: bench overlay and User Timing measures, 'b' downloads the report
  airport: string | null // ?airport=LLBG: first view over this hero (default: the first in heroes.json)
}

export function readParams(search: string): AppParams {
  const q = new URLSearchParams(search)
  const hex = (q.get('hex') ?? '').trim().toLowerCase()
  const airport = (q.get('airport') ?? '').trim().toUpperCase()
  return { hex: HEX.test(hex) ? hex : null, bench: q.get('bench') === '1', airport: airport === '' ? null : airport }
}

/**
 * Credit lines for the attribution box. mountAttribution adds "Not for navigation"; Cesium shows the terrain, imagery and
 * street-map credits on the map itself (the OpenStreetMap one linked, as its tile policy asks). The detail panel credits
 * each photo ("Image © name", linked to its page on planespotters.net).
 */
export function attributionFor(model: ModelManifestEntry | null): string[] {
  const lines = [
    'Flight data © adsb.lol contributors, ODbL 1.0',
    'Airports: OurAirports (public domain)',
    AIRLINES_CREDIT,
    'Map: © OpenStreetMap contributors, ODbL',
    'Photos: planespotters.net, © each photographer',
  ]
  // Manifest licences read "<SPDX id>: <note>"; the id is enough on screen.
  if (model) lines.push(`3D model: ${model.author}, ${model.license.split(':')[0].trim()}`)
  return lines
}

/** The server's status, except that FAILS_DOWN failed polls in a row mean we have no live data at all. */
export function statusShown(status: StatusBrief, failedPolls: number): StatusBrief {
  return failedPolls >= FAILS_DOWN ? { ...status, degraded: 'upstream-down' } : status
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return (await res.json()) as T
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function div(className: string, parent: HTMLElement): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className
  parent.append(el)
  return el
}

/**
 * Builds the viewer in root and runs the app until stop(). Loops:
 * - every second: view(browse: the circle around the visible map; chase: around the chased aircraft) and, while an
 *   aircraft is selected, chase(hex). Every sample goes into the Fleet; the selected aircraft's samples also go into the
 *   TrackRegistry, between frames, so re-join blends stay continuous.
 * - every frame (scene.preUpdate: after Cesium applies mouse input to the camera, before it updates primitives and
 *   renders, so camera and model move in the same frame): Fleet → FleetLayer and table (all aircraft, dead-reckoned
 *   to server now); RenderClock → the selected aircraft's state → model, chase camera, HUD, detail panel, banner, bench.
 * A table row or a click on an icon selects; Esc or the panel's × goes back to browse over the last chased position.
 * Runways and the model are optional: if their files fail to load, the app runs without them. createViewer failing
 * (terrain unreachable) rejects.
 */
export async function startApp(root: HTMLElement, cfg: ClientConfig): Promise<{ stop(): void }> {
  const params = readParams(location.search)
  const base = import.meta.env.BASE_URL
  const [viewer, airports, manifest] = await Promise.all([
    createViewer(root, cfg),
    getJson<Airport[]>(`${base}airports/heroes.json`).catch((e: unknown): Airport[] => {
      console.warn('FlightHopper: no runways:', e)
      return []
    }),
    getJson<ModelManifest>(`${base}models/manifest.json`).catch((e: unknown): null => {
      console.warn('FlightHopper: no model manifest:', e)
      return null
    }),
  ])
  const entry = manifest?.models.find((m) => m.id === manifest.default) ?? null
  const model = entry
    ? await ChaseModel.load(viewer, entry).catch((e: unknown): null => {
        console.warn('FlightHopper: chase model not loaded:', e)
        return null
      })
    : null

  let selected: string | null = params.hex // ?hex= is chased from the start; the camera engages at its first state
  let chased: RenderState | null = null // the selected aircraft as drawn in the last frame that had it
  let chaseRaw: ReadsbAircraft | null = null // newest full upstream object and info of the selected aircraft
  let chaseInfo: AircraftInfo | null = null
  let tableHover: string | null = null
  let mapHover: string | null = null
  let status = NO_STATUS
  let failedPolls = 0
  let stopped = false
  let lastFrameMs: number | null = null
  const carto = new Cartographic()
  const onScreen: FleetEntry[] = [] // reused every frame

  // Overlays live in one element so stop() removes them together (mountAttribution returns no handle). layout.css
  // places them; data-mode switches what browse and chase show.
  const ui = div('fh-ui', root)
  ui.dataset.mode = selected === null ? 'browse' : 'chase'
  const right = div('fh-right', ui) // the table above the credits
  const hud = mountHud(ui)
  const banner = mountBanner(ui)
  const detail = mountDetail(ui, { onClose: () => select(null), photos: new PhotoCache(), lookup: lookupFor })
  const table = mountTable(right, { onSelect: (hex) => select(hex), onHover: (hex) => (tableHover = hex), flagOf })
  mountAttribution(right, attributionFor(entry))
  const legend = mountLegend(div('fh-legend-root', ui))
  const runways = addRunways(viewer, airports)
  // VITE_MAP_URL: another tile server ({z}/{x}/{y}.png is appended), as the OpenStreetMap tile policy asks to allow.
  const mapUrl: string | undefined = import.meta.env.VITE_MAP_URL?.trim() || undefined
  const map = makeMapLayer(viewer, mapUrl)
  const fleetLayer = new FleetLayer(viewer)
  const chaseCam = new ChaseCamera(viewer)
  const api = new ApiClient(cfg.apiBase)
  const fleet = new Fleet()
  let registry = new TrackRegistry({ pollPeriodS: POLL_MS / 1000 })
  const clock = new RenderClock(MIN_DELAY_S)
  const bench = params.bench ? new BenchRecorder(viewer, { label: params.hex ?? 'browse' }) : null
  bench?.mountOverlay(div('fh-bench', ui))
  // ?bench=1: User Timing measures fh:frame, fh:fleet, fh:table (each frame) and fh:ingest (each poll), read with
  // performance.getEntriesByName(name) or in DevTools. ponytail: entries pile up (~200 per second) until
  // performance.clearMeasures(); fine for bench runs of minutes.
  const measure = bench === null ? null : (name: string, startMs: number): void => void performance.measure(name, { start: startMs })
  ;(window as unknown as { viewer?: Viewer }).viewer = viewer // console access for debugging and G3, as in WP-00

  const home = airports.find((a) => a.ident === params.airport) ?? airports[0]
  const homeCenter = home ? { lat: home.lat, lon: home.lon } : null
  if (selected === null) enterBrowse(viewer, homeCenter, { flyS: 0 })
  else {
    map.show = false
    if (home) viewer.camera.setView({ destination: Cartesian3.fromDegrees(home.lon, home.lat, START_HEIGHT_M) })
  }

  /** Browse ↔ chase. The camera leaves browse at once and engages behind the aircraft at its first state. */
  function select(hex: string | null): void {
    if (hex === selected) return
    const last = chased
    chaseCam.release() // hands the mouse back to Cesium's controls; the next chase starts behind its aircraft
    selected = hex
    chased = null
    chaseRaw = null
    chaseInfo = null
    // Only the selected aircraft is estimated: a fresh registry, seeded with the newest sample the fleet has of it.
    registry = new TrackRegistry({ pollPeriodS: POLL_MS / 1000 })
    if (hex !== null) {
      const seed = fleet.newest(hex)
      if (seed) registry.ingest([seed])
      exitBrowse(viewer) // restores tilt and zoom limits; nothing when already chasing
      map.show = false
    } else {
      map.show = true
      enterBrowse(viewer, last) // over the last chased position, else where the camera is
    }
    ui.dataset.mode = hex === null ? 'browse' : 'chase'
  }

  function frame(): void {
    const now = performance.now()
    const dtS = lastFrameMs === null ? 0 : Math.min(1, (now - lastFrameMs) / 1000)
    lastFrameMs = now
    const shown = statusShown(status, failedPolls)
    let all = NO_ENTRIES
    let s: RenderState | null = null
    if (api.ready) {
      const tServerMs = api.serverNowMs()
      const tRenderMs = clock.tick(tServerMs, registry.delayTargetS(selected), dtS)
      // ponytail: the fleet is drawn at server now, the chased aircraft at the delayed render time (≥ 3 s earlier), so
      // traffic around it runs a few seconds ahead of it. Upgrade: draw the fleet at tRenderMs, which needs Fleet to
      // interpolate between samples instead of only dead-reckoning past the newest.
      all = fleet.entries(tServerMs)
      if (selected !== null) s = registry.get(selected)?.stateAt(tRenderMs) ?? null
    }
    fleetLayer.update(all, selected, tableHover ?? mapHover)
    const tTable = measure === null ? 0 : performance.now()
    measure?.('fh:fleet', now)
    table.update(all, entriesIn(all, viewRectangleDeg(viewer), onScreen, selected), selected) // re-sorts ≤ 1 Hz itself
    measure?.('fh:table', tTable)
    let clearanceM: number | null = null
    if (s !== null) {
      const terrainM = viewer.scene.globe.getHeight(Cartographic.fromDegrees(s.lon, s.lat, 0, carto)) ?? null
      const placed: RenderState = { ...s, hM: placedHeightM(s.hM, s.onGround, terrainM) }
      model?.update(placed)
      clearanceM = chaseCam.update(placed, dtS).clearanceM
      chased = placed
    }
    // No state (before the first samples, pruned, or a gap > 2 min): the model goes; the camera stays put.
    if (model) model.show = s !== null
    hud.update(s, shown)
    // The panel shows as soon as something is known: identity from the fleet before the chase reply and first state.
    detail.update(s, chaseRaw, chaseInfo ?? (selected === null ? null : (fleet.get(selected)?.info ?? null))) // ≤ 4 Hz
    banner.update(shown, s)
    bench?.frame(s, clearanceM)
    measure?.('fh:frame', now)
  }
  const removeFrame = viewer.scene.preUpdate.addEventListener(frame)

  /** Centre and radius of the view poll: browse, around the visible map; else the chased aircraft, else the globe point at the canvas centre, else below the camera. */
  function viewCircle(): { lat: number; lon: number; nm: number } {
    if (selected === null) {
      const r = viewRectangleDeg(viewer)
      if (r !== null) return browseCircle(r)
    }
    const cam = viewer.camera.positionCartographic
    const nm = viewRadiusNm(cam.height)
    const round = (deg: number): number => Math.round(deg * 1e4) / 1e4
    if (chased !== null) return { lat: round(chased.lat), lon: round(chased.lon), nm }
    const c = viewer.canvas
    const hit = viewer.camera.pickEllipsoid(new Cartesian2(c.clientWidth / 2, c.clientHeight / 2))
    const g = (hit && Cartographic.fromCartesian(hit)) ?? cam
    return { lat: round(CesiumMath.toDegrees(g.latitude)), lon: round(CesiumMath.toDegrees(g.longitude)), nm }
  }

  async function poll(): Promise<void> {
    const hex = selected
    const v = viewCircle()
    const noChase: Promise<ChaseResponse | null> = Promise.resolve(null)
    const [view, chase] = await Promise.allSettled([api.view(v.lat, v.lon, v.nm), hex === null ? noChase : api.chase(hex)])
    if (stopped) return
    const t0 = measure === null ? 0 : performance.now()
    const current = hex !== null && hex === selected // a reply for an earlier selection only feeds the fleet
    let ok = false
    if (view.status === 'fulfilled') {
      const r = view.value
      fleet.ingest(r.samples, r.info)
      if (current) registry.ingest(r.samples.filter((x) => x.hex === hex))
      status = r.status
      ok = true
    }
    if (chase.status === 'fulfilled' && chase.value !== null) {
      const r = chase.value
      fleet.ingest(r.samples, r.info ? [r.info] : undefined)
      if (current) {
        registry.ingest(r.samples)
        chaseRaw = r.raw ?? chaseRaw
        chaseInfo = r.info ?? chaseInfo
      }
      status = r.status
      ok = true
    }
    measure?.('fh:ingest', t0)
    if (ok) failedPolls = 0
    else if (failedPolls++ === 0) console.warn('FlightHopper: poll failed:', (view as PromiseRejectedResult).reason)
    if (api.ready) {
      const t = api.serverNowMs()
      fleet.prune(t, PRUNE_AGE_S)
      registry.prune(t, PRUNE_AGE_S)
    }
  }

  void (async () => {
    while (!stopped) {
      const t0 = performance.now()
      await poll().catch((e: unknown) => console.error('FlightHopper: poll crashed:', e))
      await sleep(Math.max(0, POLL_MS - (performance.now() - t0)))
    }
  })()

  // Cesium's default double-click tracks an entity (the runway markers are entities), which would fight the chase camera.
  viewer.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
  const mouse = new ScreenSpaceEventHandler(viewer.scene.canvas)
  mouse.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
    const hex = fleetLayer.pick(e.position)
    if (hex !== null) select(hex)
  }, ScreenSpaceEventType.LEFT_CLICK)
  // Hover over an icon: its callsign label and a pointer cursor. Picks at most every HOVER_PICK_MS, at the newest position.
  const mousePos = new Cartesian2()
  let hoverTimer: ReturnType<typeof setTimeout> | null = null
  let lastPickMs = -Infinity
  const pickHover = (): void => {
    hoverTimer = null
    lastPickMs = performance.now()
    const hex = fleetLayer.pick(mousePos)
    if (hex === mapHover) return
    mapHover = hex
    viewer.canvas.style.cursor = hex === null ? '' : 'pointer'
  }
  mouse.setInputAction((m: ScreenSpaceEventHandler.MotionEvent) => {
    Cartesian2.clone(m.endPosition, mousePos)
    hoverTimer ??= setTimeout(pickHover, Math.max(0, lastPickMs + HOVER_PICK_MS - performance.now()))
  }, ScreenSpaceEventType.MOUSE_MOVE)
  const onLeave = (): void => {
    if (hoverTimer !== null) clearTimeout(hoverTimer)
    hoverTimer = null
    mapHover = null
    viewer.canvas.style.cursor = ''
  }
  viewer.canvas.addEventListener('pointerleave', onLeave) // onto the table or panel, or out of the window
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') select(null)
    else if ((e.key === 'b' || e.key === 'B') && bench) bench.download()
  }
  window.addEventListener('keydown', onKey)

  return {
    stop(): void {
      if (stopped) return
      stopped = true
      removeFrame()
      window.removeEventListener('keydown', onKey)
      viewer.canvas.removeEventListener('pointerleave', onLeave)
      if (hoverTimer !== null) clearTimeout(hoverTimer)
      mouse.destroy()
      bench?.destroy()
      hud.destroy()
      banner.destroy()
      detail.destroy()
      table.destroy()
      legend.destroy()
      ui.remove()
      chaseCam.release()
      exitBrowse(viewer)
      model?.destroy()
      fleetLayer.destroy()
      map.destroy()
      runways.destroy()
      viewer.destroy()
      delete (window as unknown as { viewer?: Viewer }).viewer
    },
  }
}

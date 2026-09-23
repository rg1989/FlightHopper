// client/app.ts
// The client app: one Cesium viewer in two modes, fed by 1 Hz polls of the server.
// - Browse: a north-up, top-down street map. Every aircraft is an icon turned to its track and coloured by altitude.
//   Clicking one (or a list row) focuses it: its flight card shows and the map stays as it is.
// - Chase (the card's "Chase in 3-D", ?chase=1, or a bare ?hex= link): the 3-D model and the chase camera over the
//   satellite imagery, with the card. The other aircraft within 10 nm show as 3-D models framed by corner brackets
//   (scene/traffic.ts); chase shows no flat icons. The sun lights the chase view, and
//   the relief can sink into the map and grow back (the Scene panel's switches, keys T and L).
// The tools (status, aircraft list, scene, altitude colours, about) sit behind a rail of icon buttons (ui/rail.ts).
// Every aircraft goes into the Fleet (newest sample, dead-reckoned: cheap enough for thousands a frame). Only the
// selected one also goes into the TrackRegistry, whose full estimator the chase camera follows.
// This file only wires the parts in scene/, track/, browse/, ui/, bench/ and api.ts together.
import { Cartesian2, Cartesian3, Cartographic, Ellipsoid, Math as CesiumMath, ScreenSpaceEventHandler, ScreenSpaceEventType } from 'cesium'
import type { Viewer } from 'cesium'
import { AIRLINES_CREDIT, airlineOf } from '../shared/airlines.ts'
import type { Airport } from '../shared/airports.ts'
import type { ChaseResponse, StatusBrief } from '../shared/api.ts'
import { distanceNm } from '../shared/geo.ts'
import { countryOf, flagEmoji } from '../shared/icaoCountry.ts'
import type { AircraftInfo } from '../shared/info.ts'
import type { ReadsbAircraft, Sample, SourceKind } from '../shared/types.ts'
import { ApiClient } from './api.ts'
import { BenchRecorder } from './bench/overlay.ts'
import { Fleet } from './browse/fleet.ts'
import { BROWSE_HEIGHT_M, containsDeg, enterBrowse, exitBrowse, heightToFit, isBrowsing, viewRectangleDeg } from './scene/browseCamera.ts'
import type { RectDeg } from './scene/browseCamera.ts'
import { ChaseCamera } from './scene/chaseCamera.ts'
import { FleetLayer } from './scene/fleetLayer.ts'
import { makeMapLayer } from './scene/mapLayer.ts'
import { makePendingLayer } from './scene/pendingLayer.ts'
import { ChaseModel } from './scene/model.ts'
import { Traffic } from './scene/traffic.ts'
import { makeNightLayer } from './scene/nightLights.ts'
import { BUILDINGS_CREDIT, Buildings } from './scene/buildings.ts'
import { addRunways } from './scene/runways.ts'
import { Sun, parseSunParam, sunLook, sunTimeMs } from './scene/sun.ts'
import { Topography, groundMemo, pickRelHM } from './scene/topography.ts'
import { createViewer } from './scene/viewer.ts'
import { eoxOnEsriFailure, imageryCredits, imageryStatus } from './scene/imagery.ts'
import { MAX_DELAY_S, MIN_DELAY_S, RenderClock, p90 } from './track/delay.ts'
import { TrackRegistry } from './track/registry.ts'
import type { ClientConfig, FleetEntry, ModelManifest, ModelManifestEntry, RenderState, ScenePrefs, TerrainFrame } from './types.ts'
import { mountBanner } from './ui/banner.ts'
import type { Lookup } from './ui/detail.ts'
import { mountFlightCard } from './ui/flightCard.ts'
import { icon } from './ui/icons.ts'
import { mountInfoPanel, type InfoPanelHandle } from './ui/info.ts'
import { mountLegend } from './ui/legend.ts'
import { mountRail } from './ui/rail.ts'
import { PhotoCache } from './ui/photo.ts'
import { PREFS_KEY, readScenePrefs, writeScenePrefs } from './ui/scenePrefs.ts'
import { mountSceneToggles } from './ui/sceneToggles.ts'
import { badgeView } from './ui/imageryBadge.ts'
import { flightCredit, mountStatusPanel, statusDot, type StatusPanelHandle } from './ui/sourceBadge.ts'
import { readView, writeUrl } from './ui/urlState.ts'
import { mountTable, type TableHandle } from './ui/table.ts'
import type { SceneTogglesHandle } from './ui/sceneToggles.ts'
import './ui/theme.css'
import './ui/layout.css'

const POLL_MS = 1000 // view and chase both poll at 1 Hz; TrackRegistry's pollPeriodS says the same
const PRUNE_AGE_S = 60 // forget an aircraft at least this long after its newest sample (Fleet: its own staleS if longer)
const FAILS_DOWN = 3 // failed polls in a row before the banner reports it
const START_HEIGHT_M = 60_000 // ?hex= start: straight down on the hero airport until the chase camera takes over
const MIN_VIEW_NM = 20
// The visible hemisphere. The server polls a view up to 250 nm as one circle and a wider one as grid cells, each at a
// period that grows with the view (Poller.viewPeriodMs): the globe view asks each area about every 30 min.
const MAX_VIEW_NM = 5400
const DEFAULT_AIRPORT = 'LLBG' // a ?hex= link without ?at= starts over it (the author's home)
// The first view without ?at=, ?airport= or ?hex=: all of Israel (the author's home), so its traffic loads first; a
// reload keeps ?at=.
const HOME_BOX: RectDeg = { south: 29.45, north: 33.35, west: 34.2, east: 35.9 }
const URL_EVERY_MS = 1000 // how often the address bar follows the view (history.replaceState)
// After a selection snaps the render delay, the delay shrinks at 0.05 s/s: at the default 0.2 s/s a small shrink (the
// arrival age's p90 moving by tenths of a second) showed as a 20 % speed-up lurch. It grows at the default 0.2 s/s, so an
// aircraft reporting only every ~40 s (thin coverage) reaches a delay that covers its gaps within ~2 min, not ~9.
const CHASE_SHRINK_S_PER_S = 0.05
const FOCUS_ASK_MS = 10_000 // a focused (not chased) aircraft: how often its chase reply (raw fields, info) is asked
const HOVER_PICK_MS = 100 // at most ten hover picks a second while the mouse moves (each pick is a small render pass)
const HEX = /^~?[0-9a-f]{6}$/
// Until the first reply. Nothing is drawn before it, so the source named here is never shown.
const NO_HEXES: ReadonlySet<string> = new Set()
const NO_STATUS: StatusBrief = { source: 'adsblol', degraded: null, cellPeriodP95S: null, chasePeriodP95S: null }
const NO_ENTRIES: readonly FleetEntry[] = []

/** Radius in whole 10 nm steps (so the ApiClient's per-view `since` key survives small changes), clamped to 20–5,400 nm. */
function viewNm(nm: number): number {
  const r = Math.ceil(nm / 10) * 10
  return Number.isFinite(r) ? Math.min(MAX_VIEW_NM, Math.max(MIN_VIEW_NM, r)) : MAX_VIEW_NM
}

/**
 * Radius of the chase view poll: the camera height in nm (a top-down view shows about ±0.6 h), in 10 nm steps, 20–5,400 nm.
 * ponytail: a tilted camera sees further than its height; the far part of such a view stays empty until the user looks
 * down. Upgrade: size the circle from the frustum's ground footprint (browseCircle does, for the top-down view).
 */
export function viewRadiusNm(cameraHeightM: number): number {
  return viewNm(cameraHeightM / 1852)
}

const round2 = (deg: number): number => Math.round(deg * 100) / 100
const wrap180 = (lon: number): number => ((((lon + 180) % 360) + 360) % 360) - 180

/**
 * The browse view poll: the circle around the visible rectangle, centred on at (the screen centre: the server fills a
 * wide view outwards from it), else on the rectangle, to 0.01° (the ApiClient's key), and reaching its farthest corner (a lat/lon rectangle's farthest point from inside it is a corner), 20–5,400 nm (the
 * visible hemisphere). A rectangle with west > east spans the antimeridian.
 * ponytail: every pan moves the centre, so the first poll after it is a new view key and a full (since=0) reply
 * (~200 KB gzipped for 5,000 aircraft). Upgrade: snap the centre to a grid so small pans keep their key.
 */
export function browseCircle(r: RectDeg, at?: { lat: number; lon: number }): { lat: number; lon: number; nm: number } {
  const spanDeg = r.west <= r.east ? r.east - r.west : r.east + 360 - r.west
  const lat = round2(at?.lat ?? (r.south + r.north) / 2)
  const lon = round2(wrap180(at?.lon ?? r.west + spanDeg / 2))
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

/** A count short enough for a badge: 7, 842, 1.2k, 12k. */
export function compactCount(n: number): string {
  if (n < 1000) return String(n)
  return n < 10_000 ? `${(Math.floor(n / 100) / 10).toFixed(1)}k` : `${Math.floor(n / 1000)}k`
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

/**
 * The flat plane's height (design D4) for a flatten, or for a new selection while flat: the runway height of a hero airport
 * within 30 km of the aircraft, else the ground under it (groundM: the drawn ground, true at rest), else the plane as it is
 * (relHM). While flat the drawn ground is the old plane everywhere, so a new selection passes groundM null.
 * ponytail: away from the heroes a selection while flat keeps the old plane. Upgrade: sampleTerrainMostDetailed (true
 * heights, async) under the new aircraft, then relatch when it resolves.
 */
export function relHFor(at: { lat: number; lon: number } | null, groundM: number | null, relHM: number, airports: readonly Airport[]): number {
  return at === null ? relHM : pickRelHM(at.lat, at.lon, groundM ?? relHM, airports)
}

/** Where a typed T or L is text, not a toggle (the table's search box). */
const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/**
 * The scene toggle a keydown asks for (design D11): T topography, L sun, X see-through buildings. null with a modifier (Cmd/Ctrl+L and Ctrl+T are
 * the browser's), on auto-repeat and while typing in a field.
 */
export function sceneKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; repeat: boolean; target: unknown }): keyof ScenePrefs | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return null
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null
  if (t?.isContentEditable || TYPING.has(t?.tagName ?? '')) return null
  const k = e.key.toLowerCase()
  return k === 't' ? 'topo' : k === 'l' ? 'light' : k === 'x' ? 'glass' : null
}

export interface AppParams {
  hex: string | null // ?hex=a1b2c3: this aircraft from the start: focused (with ?at=, a reload) or chased (a bare link, G3)
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
 * Credit lines for the About panel (a personal-use app: no credit bar or disclaimer on the map, viewer.ts). The flight
 * card credits each photo ("© name", linked to its page on planespotters.net).
 */
export function attributionFor(model: ModelManifestEntry | null, source: SourceKind | null = 'adsblol', imagery: ClientConfig['imagery'] = 'eox'): string[] {
  const lines = [
    ...(source === null ? [] : [flightCredit(source)]), // null until the server says which source it is
    'Airports: OurAirports (public domain)',
    AIRLINES_CREDIT,
    'Map: © OpenStreetMap contributors, ODbL',
    ...imageryCredits(imagery),
    'Photos: planespotters.net, © each photographer',
    'Night lights: NASA GIBS, VIIRS Black Marble', // D13; the short form of NIGHT_CREDIT (nightLights.ts)
    BUILDINGS_CREDIT,
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
 *   renders, so camera and model move in the same frame): Topography first (the relief's factor and flat plane for this
 *   frame); Fleet → FleetLayer and table (all aircraft, dead-reckoned to server now); RenderClock → the selected
 *   aircraft's state → model, chase camera; the Sun (clock and light) and the runways; HUD, detail panel, banner, bench.
 * A table row or a click on an icon selects; Esc or the panel's × goes back to browse over the last chased position.
 * The scene toggles (buttons, keys T and L) apply in chase and persist: URL > localStorage > defaults (both on).
 * Runways and the model are optional: if their files fail to load, the app runs without them. createViewer failing
 * (terrain unreachable) rejects.
 */
export async function startApp(root: HTMLElement, cfg: ClientConfig, hooks: { onFirstData?(): void } = {}): Promise<{ stop(): void }> {
  const params = readParams(location.search)
  const sunParam = parseSunParam(location.search) // ?sun=<ISO> fixes the sun's time, ?sun=+6h shifts it (demos)
  // The localStorage getter and getItem both throw where storage is blocked: then only the URL and the defaults count.
  let store: Storage | null = null
  let stored: string | null = null
  try {
    store = window.localStorage
    stored = store.getItem(PREFS_KEY)
  } catch {
    // blocked: nothing stored, nothing kept
  }
  let prefs = readScenePrefs(location.search, stored)
  // Stored at once: the address bar keeps only toggles that differ from the defaults (urlState.ts), so a ?topo=1 read
  // here must be what a reload finds in storage once the bar has dropped it.
  writeScenePrefs(prefs, store)
  const base = import.meta.env.BASE_URL
  // Topography takes the scene in the task that builds the viewer, before its first frame: moving the factor off 1
  // with tiles loaded rebuilds every tile (PoC: up to 2 s).
  const viewerWithTopography = async (): Promise<[Viewer, Topography]> => {
    const v = await createViewer(root, cfg)
    return [v, new Topography(v.scene, prefs.topo)]
  }
  const [[viewer, topo], airports, manifest] = await Promise.all([
    viewerWithTopography(),
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

  // Selected = focused: its flight card shows, the map stays top-down. Chasing = the 3-D chase view of the selected
  // aircraft (the card's Chase button; ?chase=1). The chase camera engages at its first state.
  let selected: string | null = params.hex
  // A reload keeps what was on screen (?at= with ?chase=1 or not); a bare ?hex= link (G3, shared links) chases.
  const view0 = readView(location.search)
  let chasing = selected !== null && (view0.chase || view0.at === null)
  let chased: RenderState | null = null // the selected aircraft as drawn in the last frame that had it
  let groundM: number | null = null // the ground drawn under it (lag-corrected), null while unknown
  // The last terrain readings under the aircraft and under the chase camera, with the points they were read at.
  // Topography.ground rescales them for an undefined reading (Cesium's picker race, in runs during an animation) within
  // 50 m of that point: about the first 0.5 s of a run at 180 kt. Reset on each selection.
  const acGround = groundMemo()
  const camGround = groundMemo()
  let relatchPending = chasing // a new chase moves a flat map's plane at its first state (D4)
  let tf: TerrainFrame // this frame's exaggeration: topo.update() writes it first in every frame
  let chaseRaw: ReadsbAircraft | null = null // newest full upstream object and info of the selected aircraft
  let chaseInfo: AircraftInfo | null = null
  let tableHover: string | null = null
  let mapHover: string | null = null
  let status = NO_STATUS
  let failedPolls = 0
  let stopped = false
  let lastFrameMs: number | null = null
  const carto = new Cartographic()
  const sunAt = new Cartesian3() // the chased aircraft, where the sun's elevation is taken
  const runwayLook = sunLook(90) // the runways' light, rewritten every frame
  const onScreen: FleetEntry[] = [] // reused every frame

  // Overlays live in one element so stop() removes them together (mountAttribution returns no handle). layout.css
  // places them; data-mode switches what browse and chase show.
  // Chase traffic: 3-D models around the chased aircraft, their brackets in a layer under the overlays.
  const traffic = entry ? new Traffic(viewer, entry, div('fh-traffic', root)) : null
  const ui = div('fh-ui', root)
  ui.dataset.mode = chasing ? 'chase' : 'browse'
  // Every tool sits behind a small icon on the rail (right edge); all panels start closed. layout.css places the rest.
  let toggles!: SceneTogglesHandle
  let table!: TableHandle
  let statusPanel!: StatusPanelHandle
  let info!: InfoPanelHandle
  let legend!: { destroy(): void }
  const rail = mountRail(ui, [
    { id: 'status', icon: 'status', label: 'Live status', short: 'Live', panel: { title: 'Status', mount: (b) => (statusPanel = mountStatusPanel(b)) } },
    { id: 'aircraft', icon: 'list', label: 'Aircraft in view', short: 'Aircraft', group: 1, panel: {
      title: 'Aircraft', wide: true,
      mount: (b, head) => (table = mountTable(b, head, { onSelect: pickFromList, onHover: (hex) => (tableHover = hex), flagOf })),
    } },
    { id: 'scene', icon: 'layers', label: 'Scene: terrain, sun, buildings', short: 'Scene', group: 1, panel: {
      title: 'Scene', mount: (b) => (toggles = mountSceneToggles(b, { prefs, onChange: (next) => setPrefs(next) })),
    } },
    { id: 'legend', icon: 'altitude', label: 'Altitude colours', short: 'Colours', group: 1, panel: { title: 'Altitude colours', mount: (b) => (legend = mountLegend(b)) } },
    { id: 'info', icon: 'info', label: 'Controls and credits', short: 'About', group: 2, panel: { title: 'About', mount: (b) => (info = mountInfoPanel(b)) } },
    // Not where the page cannot go full screen (iPhone Safari).
    ...(document.fullscreenEnabled ? [{ id: 'fullscreen', icon: 'maximize', label: 'Full screen', short: 'Full', group: 2, action: () => toggleFullscreen() } as const] : []),
  ], (id) => {
    if (id === 'aircraft') table.refresh() // opening the list shows it fresh
  })
  const imagery0 = badgeView(imageryStatus(cfg))
  statusPanel.setImagery(imagery0.text, imagery0.state)
  const card = mountFlightCard(ui, { onClose: () => select(null), onChase: (on) => setChase(on), photos: new PhotoCache(), lookup: lookupFor })
  const banner = mountBanner(ui)
  let creditSource: SourceKind | null = null
  info.setCredits(attributionFor(entry, null, cfg.imagery))
  let firstData = false
  let lastBadgeMs = -Infinity
  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen?.()
  }
  const onFullscreen = (): void => {
    const b = rail.button('fullscreen')
    const full = document.fullscreenElement !== null
    b.querySelector('svg')?.replaceWith(icon(full ? 'minimize' : 'maximize'))
    b.dataset.tip = full ? 'Exit full screen' : 'Full screen'
    b.setAttribute('aria-label', b.dataset.tip)
  }
  document.addEventListener('fullscreenchange', onFullscreen)
  const runways = addRunways(viewer, airports)
  const buildings = new Buildings(viewer) // chase only: update() gets no focus in browse
  buildings.setGlass(prefs.glass)
  // The city lights go right above the satellite base layer, under the street map added next (browse shows it on top).
  const day = viewer.imageryLayers.length > 0 ? viewer.imageryLayers.get(0) : null
  const night = makeNightLayer()
  viewer.imageryLayers.add(night)
  const sun = new Sun(viewer, { day, night })
  if (cfg.imagery === 'esri' && day) {
    eoxOnEsriFailure(viewer.imageryLayers, day, (eox, why) => {
      sun.setDay(eox)
      const v = badgeView({ source: 'eox', fallback: why })
      statusPanel.setImagery(v.text, v.state)
    })
  }
  sun.attachModel(model?.model ?? null)
  sun.setEnabled(chasing && prefs.light)
  // VITE_MAP_URL: another tile server ({z}/{x}/{y}.png is appended), as the OpenStreetMap tile policy asks to allow.
  const mapUrl: string | undefined = import.meta.env.VITE_MAP_URL?.trim() || undefined
  const map = makeMapLayer(viewer, mapUrl)
  const fleetLayer = new FleetLayer(viewer)
  const pendingLayer = makePendingLayer(viewer) // the view's areas not loaded yet, veiled on the map
  const globe = viewer.scene.globe
  // Clearance above the ground drawn this frame: globe.getHeight answers last frame's while the relief grows or sinks.
  const chaseCam = new ChaseCamera(viewer, { groundAt: (c) => topo.ground(globe.getHeight(c), tf, camGround, c) })
  const api = new ApiClient(cfg.apiBase)
  const fleet = new Fleet()
  let registry = new TrackRegistry({ pollPeriodS: POLL_MS / 1000 })
  let clock = new RenderClock(MIN_DELAY_S)
  // A new selection is a camera cut: its first chase reply sets the render delay at once. Slewing there at 0.2 s/s would
  // take ~2 min on a sparse live feed (25 s between samples → 26 s delay).
  let snapClock = selected !== null
  let seedSample: Sample | null = null // the fleet's newest sample of the selection, drawn until the first chase reply
  // How old the chased aircraft's newest position already is when it arrives (the upstream's own latency plus the trip),
  // over the last ARRIVALS replies: the delay must cover it plus a refresh, or the newest sample is behind render time.
  const ARRIVALS = 30
  const arrivalAgesS: number[] = []
  let lastFocusAskMs = -Infinity // select() resets it: a new focus asks at once
  let browseHeightM: number | null = null // the map's camera height when the chase began
  /** The track's target, but at least one server refresh of the chased aircraft + its arrival age (p90) + 0.5 s. */
  const delayTargetS = (): number =>
    Math.min(MAX_DELAY_S, Math.max(registry.delayTargetS(selected), (status.chaseEveryS ?? 0) + p90(arrivalAgesS) + 0.5))
  const bench = params.bench ? new BenchRecorder(viewer, { label: params.hex ?? 'browse' }) : null
  bench?.mountOverlay(div('fh-bench', ui))
  // ?bench=1: User Timing measures fh:frame, fh:fleet, fh:table (each frame) and fh:ingest (each poll), and two marks
  // under the chased aircraft for gate GE: fh:no-ground for each undefined terrain reading, and fh:ground-unknown for
  // each frame whose ground is still unknown after the memo. Read them with performance.getEntriesByName(name) or in
  // DevTools. ponytail: entries pile up (~200 per second) until performance.clearMeasures(); fine for runs of minutes.
  const measure = bench === null ? null : (name: string, startMs: number): void => void performance.measure(name, { start: startMs })
  ;(window as unknown as { viewer?: Viewer }).viewer = viewer // console access for debugging and G3, as in WP-00

  // The first view: ?at= (a reload or a shared link), else ?airport=, else all of Israel (a chase: over the home airport).
  const urlView = readView(location.search)
  const home = airports.find((a) => a.ident === (params.airport ?? DEFAULT_AIRPORT)) ?? airports[0]
  const homeBox = params.airport === null && !chasing
    ? { lat: (HOME_BOX.south + HOME_BOX.north) / 2, lon: (HOME_BOX.west + HOME_BOX.east) / 2, heightKm: heightToFit(HOME_BOX, viewer.canvas.clientWidth, viewer.canvas.clientHeight) / 1000 }
    : null
  const start = urlView.at ?? homeBox ?? (home ? { lat: home.lat, lon: home.lon, heightKm: BROWSE_HEIGHT_M / 1000 } : null)
  if (!chasing) enterBrowse(viewer, start, { flyS: 0, heightM: start === null ? undefined : start.heightKm * 1000 })
  else {
    map.show = false
    // Over the chased aircraft's last position (?at=) so the first view poll already holds it and its traffic.
    if (start) viewer.camera.setView({ destination: Cartesian3.fromDegrees(start.lon, start.lat, urlView.at ? Math.max(START_HEIGHT_M / 6, start.heightKm * 1000) : START_HEIGHT_M) })
    if (urlView.cam) chaseCam.orbit.set(urlView.cam.headingDeg, urlView.cam.pitchDeg, urlView.cam.rangeM)
  }
  let lastUrlMs = -Infinity

  /** The address bar follows what is on screen (see urlState.ts), so a reload shows the same view. */
  function syncUrl(now: number): void {
    if (now - lastUrlMs < URL_EVERY_MS) return
    lastUrlMs = now
    const cam = viewer.camera.positionCartographic
    const heightKm = cam.height / 1000
    // Browse: the point under the (top-down) camera. Chase: the chased aircraft; before its first state, the camera.
    const here = { lat: CesiumMath.toDegrees(cam.latitude), lon: CesiumMath.toDegrees(cam.longitude), heightKm }
    const at = !chasing ? (isBrowsing(viewer) ? here : null) : chased !== null ? { lat: chased.lat, lon: chased.lon, heightKm } : here
    const o = chaseCam.orbit
    const orbit = chasing ? { headingDeg: o.headingOffsetDeg, pitchDeg: o.pitchDeg, rangeM: o.rangeM } : null
    const next = writeUrl(location.search, { at, hex: selected, chase: chasing, cam: orbit, prefs })
    if (next !== location.search) history.replaceState(history.state, '', `${location.pathname}${next}${location.hash}`)
  }

  /**
   * Focus an aircraft (its card; the map stays as it is), switch to another one (a chase stays a chase, on the new
   * aircraft), or clear the selection (null: a chase goes back to the map first).
   */
  function select(hex: string | null): void {
    if (hex === selected) return
    if (hex === null && chasing) setChase(false) // back to the map over the last chased position
    chaseCam.release() // the next chase starts behind its aircraft
    selected = hex
    chased = null
    groundM = null
    acGround.ok = camGround.ok = false // the next readings are under another aircraft
    relatchPending = chasing && hex !== null
    chaseRaw = null
    chaseInfo = null
    // Only the selected aircraft is estimated: a fresh registry, seeded with the newest sample the fleet has of it.
    registry = new TrackRegistry({ pollPeriodS: POLL_MS / 1000 })
    snapClock = hex !== null
    arrivalAgesS.length = 0
    lastFocusAskMs = -Infinity
    seedSample = null
    if (hex !== null) {
      const seed = fleet.newest(hex)
      seedSample = seed ?? null
      if (seed) registry.ingest([seed])
    }
  }

  /**
   * A row of the list: focus that aircraft and, on the map, fly over it at the same zoom (it may be off-screen). Where
   * the card and the panel do not fit side by side (flightCard.css), the list closes so the card shows.
   */
  function pickFromList(hex: string): void {
    select(hex)
    if (matchMedia('(max-width: 860px)').matches) rail.close()
    const e = fleet.get(hex)
    if (!chasing && e !== undefined) enterBrowse(viewer, e, { heightM: viewer.camera.positionCartographic.height })
  }

  /** The selected aircraft in the 3-D chase view (on), or back to the top-down map over it (off). */
  function setChase(on: boolean): void {
    if (on === chasing || (on && selected === null)) return
    chasing = on
    chaseCam.release() // hands the mouse back to Cesium's controls; a chase starts behind its aircraft
    if (on) {
      browseHeightM = viewer.camera.positionCartographic.height // the map's zoom, for coming back
      exitBrowse(viewer) // restores tilt and zoom limits
      map.show = false
      relatchPending = true
      acGround.ok = camGround.ok = false
      arrivalAgesS.length = 0 // a focus asked rarely: its arrival ages say nothing about the chase's
    } else {
      map.show = true
      const e = selected === null ? undefined : fleet.get(selected)
      // Over the aircraft (else where the camera is), at the zoom the map had before the chase (a chased reload: the default).
      enterBrowse(viewer, chased ?? (e === undefined ? null : e), { heightM: browseHeightM ?? undefined })
    }
    sun.setEnabled(on && prefs.light) // chase only (D9): browse stays the unlit street map
    ui.dataset.mode = on ? 'chase' : 'browse'
  }

  /** Every scene-toggle change, from a button or a key: apply it, store it, show it. */
  function setPrefs(next: ScenePrefs): void {
    if (next.topo !== prefs.topo) topo.set(next.topo, performance.now(), relHFor(chased, groundM, topo.relHM, airports))
    prefs = next
    sun.setEnabled(chasing && next.light)
    buildings.setGlass(next.glass)
    writeScenePrefs(next, store)
    toggles.update(next)
  }

  function frame(): void {
    const now = performance.now()
    tf = topo.update(now) // first: the factor and plane drawn this frame, before any terrain reading
    const dtS = lastFrameMs === null ? 0 : Math.min(1, (now - lastFrameMs) / 1000)
    lastFrameMs = now
    const shown = statusShown(status, failedPolls)
    let all = NO_ENTRIES
    let s: RenderState | null = null
    let tSunMs = Date.now() // until the first reply; then the render time (server clock)
    if (api.ready) {
      const tServerMs = api.serverNowMs()
      const tRenderMs = clock.tick(tServerMs, delayTargetS(), dtS)
      tSunMs = tRenderMs
      // Chasing, the fleet is drawn at the chased aircraft's (delayed) render time, so the traffic around it is where
      // it was at that moment (dead-reckoned back from newer samples); browse draws it at server now.
      // ponytail: dead reckoning, not interpolation between samples: a turning aircraft is off by its turn. Upgrade:
      // keep two samples per hex in Fleet.
      all = fleet.entries(chasing ? tRenderMs : tServerMs)
      if (selected !== null) {
        const track = registry.get(selected)
        s = track?.stateAt(tRenderMs) ?? null
        // A large delay (a sparse feed: ~26 s) can put render time before the first sample known: hold the aircraft
        // at that sample until render time reaches it, rather than show nothing.
        const first = track?.oldestTMs ?? null
        if (s === null && track !== undefined && first !== null && tRenderMs < first) s = track.stateAt(first)
      }
    }
    fleetLayer.setTerrain(tf) // ground icons follow the grow and sink
    // Chase shows the traffic in range as 3-D models and no flat icons (none at all without the traffic model).
    const chaseModels = traffic?.select(all, selected, chasing && s !== null ? s : null) ?? NO_HEXES
    fleetLayer.update(all, selected, tableHover ?? mapHover, chasing && s !== null && model !== null, chasing ? chaseModels : null)
    const tTable = measure === null ? 0 : performance.now()
    measure?.('fh:fleet', now)
    const inView = entriesIn(all, viewRectangleDeg(viewer), onScreen, selected)
    table.update(all, inView, selected, status !== NO_STATUS) // refreshes every 10 s itself
    if (now - lastBadgeMs > 1000) {
      lastBadgeMs = now
      rail.setBadge('aircraft', status === NO_STATUS ? null : compactCount(inView.length))
    }
    if (!firstData && status !== NO_STATUS) {
      firstData = true
      hooks.onFirstData?.()
    }
    measure?.('fh:table', tTable)
    let clearanceM: number | null = null
    let sunWC = viewer.camera.positionWC // browse, or no state yet: the sun where the camera is
    if (s !== null && !chasing) chased = s // focused: where it is, for the table and a chase that starts
    if (s !== null && chasing) {
      if (relatchPending && !topo.animating) {
        relatchPending = false
        topo.relatch(relHFor(s, null, topo.relHM, airports)) // takes effect only while the map is flat
      }
      const sampled = globe.getHeight(Cartographic.fromDegrees(s.lon, s.lat, 0, carto))
      if (sampled === undefined && bench !== null) performance.mark('fh:no-ground')
      // undefined (Cesium's picker race, during an animation and before the nudge): the last reading, rescaled to this
      // frame's factor, while the aircraft is within 50 m of where it was read. null before the first reading (tiles
      // not loaded), after a new plane, farther than 50 m, and in a grow while the last reading is a flat one (it holds
      // no relief): the estimate stays.
      groundM = topo.ground(sampled, tf, acGround, carto)
      if (groundM === null && bench !== null) performance.mark('fh:ground-unknown')
      const placed: RenderState = { ...s, hM: placedHeightM(s.hM, s.onGround, groundM) }
      model?.update(placed)
      clearanceM = chaseCam.update(placed, dtS).clearanceM
      traffic?.update(fleetLayer, model?.model.imageBasedLighting.imageBasedLightingFactor) // after the camera: brackets match this frame
      chased = placed
      sunWC = Cartesian3.fromDegrees(placed.lon, placed.lat, placed.hM, Ellipsoid.WGS84, sunAt)
    }
    // Every frame, in both modes (off, it keeps the fixed light above the camera). Replays are lit at their recording
    // time (D12): the server reports how far its clock is ahead of the upstream's.
    const st = sun.update(sunTimeMs(tSunMs, sunParam, status.upstreamOffsetMs ?? 0), sunWC)
    buildings.setNight(chasing && prefs.light && st !== null ? st.night : 0) // the Sun's night, not the moon's
    runways.update(tf)
    buildings.update(chasing ? chased : null, tf) // around the chased aircraft; hidden in browse
    // The planes darken with the terrain under the Sun (WP-E3); off (browse, the toggle off) they stay as built. Three
    // numbers written in place, so it runs every frame.
    runways.setLight(chasing && prefs.light && st !== null ? sunLook(st.elevDeg, runwayLook) : null)
    // No state (before the first samples, pruned, or a gap > 2 min): the model goes; the camera stays put.
    if (model) model.show = chasing && s !== null
    toggles.setBusy(topo.animating)
    toggles.setChasing(chasing)
    // The panel shows as soon as something is known: identity from the fleet before the chase reply and first state.
    card.update(selected, s, chaseRaw, chaseInfo ?? (selected === null ? null : (fleet.get(selected)?.info ?? null)), shown, chasing) // ≤ 4 Hz
    banner.update(shown)
    const known = status === NO_STATUS ? null : shown
    statusPanel.update(known, api.ready ? api.serverNowMs() : null)
    rail.setDot('status', statusDot(known))
    rail.setBusy('status', known === null || (known.degraded === null && (known.pendingAreas ?? 0) > 0)) // in trouble no answers come
    // In trouble too (they are still not loaded), but none shown as loading: no answer is coming.
    pendingLayer.update(status.pendingBoxes, !chasing, known !== null && known.degraded === null)
    syncUrl(now)
    bench?.frame(s, clearanceM)
    measure?.('fh:frame', now)
  }
  const removeFrame = viewer.scene.preUpdate.addEventListener(frame)

  /** Centre and radius of the view poll: browse, around the visible map; else the chased aircraft, else the globe point at the canvas centre, else below the camera. */
  function viewCircle(): { lat: number; lon: number; nm: number } {
    if (!chasing) {
      const r = viewRectangleDeg(viewer)
      const under = viewer.camera.positionCartographic // browse looks straight down: the screen centre
      const c = r === null ? null : browseCircle(r, { lat: CesiumMath.toDegrees(under.latitude), lon: CesiumMath.toDegrees(under.longitude) })
      // A rectangle spanning every longitude (the globe, or a pole in view) says nothing by its centre: then the point
      // under the camera.
      const allLons = r !== null && (r.west <= r.east ? r.east - r.west : r.east + 360 - r.west) >= 359
      if (c !== null && c.nm < MAX_VIEW_NM && !allLons) return c
    }
    const cam = viewer.camera.positionCartographic
    const nm = viewRadiusNm(cam.height)
    const round = (deg: number): number => Math.round(deg * 1e4) / 1e4
    if (chasing && chased !== null) return { lat: round(chased.lat), lon: round(chased.lon), nm } // a focus alone keeps the view
    const c = viewer.canvas
    const hit = viewer.camera.pickEllipsoid(new Cartesian2(c.clientWidth / 2, c.clientHeight / 2))
    const g = (hit && Cartographic.fromCartesian(hit)) ?? cam
    return { lat: round(CesiumMath.toDegrees(g.latitude)), lon: round(CesiumMath.toDegrees(g.longitude)), nm }
  }

  async function poll(): Promise<void> {
    const hex = selected
    const v = viewCircle()
    const noChase: Promise<ChaseResponse | null> = Promise.resolve(null)
    // Chased: every poll (the server then refreshes it at its chase period). Only focused: every FOCUS_ASK_MS, for the
    // card's details; its position comes with the view, at the view's own zoom-scaled period like everything on screen.
    const nowMs = performance.now()
    const ask = hex !== null && (chasing || nowMs - lastFocusAskMs >= FOCUS_ASK_MS)
    if (ask && !chasing) lastFocusAskMs = nowMs
    const [view, chase] = await Promise.allSettled([api.view(v.lat, v.lon, v.nm), ask ? api.chase(hex) : noChase])
    if (stopped) return
    const t0 = measure === null ? 0 : performance.now()
    const current = hex !== null && hex === selected // a reply for an earlier selection only feeds the fleet
    let ok = false
    const mine: Sample[] = [] // this poll's samples of the selected aircraft, from both replies
    if (view.status === 'fulfilled') {
      const r = view.value
      fleet.ingest(r.samples, r.info)
      if (current) for (const x of r.samples) if (x.hex === hex) mine.push(x)
      status = r.status
      ok = true
    }
    let chased0 = false // this is the selection's first chase reply
    if (chase.status === 'fulfilled' && chase.value !== null) {
      const r = chase.value
      fleet.ingest(r.samples, r.info ? [r.info] : undefined)
      if (current) {
        mine.push(...r.samples)
        chaseRaw = r.raw ?? chaseRaw
        chaseInfo = r.info ?? chaseInfo
        chased0 = snapClock
        // How old its newest position is on arrival. Not from the first reply: that one is the stored history, whose
        // newest came from the browse view's slower refresh, not from the chase path.
        let newest = -Infinity
        for (const x of r.samples) if (x.tMs > newest) newest = x.tMs
        if (!chased0 && newest > -Infinity) {
          arrivalAgesS.push(Math.max(0, (r.serverNowMs - newest) / 1000))
          if (arrivalAgesS.length > ARRIVALS) arrivalAgesS.shift()
        }
      }
      status = r.status
      ok = true
    }
    if (chased0) {
      // The first chase reply carries the stored history (since=0). A track takes samples in time order only, so the
      // seed and the view's sample, newer than that history, would make it drop it: rebuild the track from all of them.
      registry = new TrackRegistry({ pollPeriodS: POLL_MS / 1000 })
      registry.ingest(seedSample === null ? mine : [seedSample, ...mine])
      if (registry.get(hex!) !== undefined) {
        clock = new RenderClock(delayTargetS(), undefined, CHASE_SHRINK_S_PER_S)
        snapClock = false
      }
    } else if (mine.length > 0) registry.ingest(mine)
    measure?.('fh:ingest', t0)
    // An aircraft may go 2.5 expected refreshes of this view without a sample before it is hidden (at least 60 s).
    fleet.setHintS(2.5 * (status.viewEveryS ?? 0))
    if (status.source !== creditSource) info.setCredits(attributionFor(entry, (creditSource = status.source), cfg.imagery))
    if (ok) failedPolls = 0
    else if (failedPolls++ === 0) console.warn('FlightHopper: poll failed:', (view as PromiseRejectedResult).reason)
    if (api.ready) {
      const t = api.serverNowMs()
      fleet.prune(t, PRUNE_AGE_S)
      // The chased aircraft is never pruned: on a lost signal it stays frozen at its last position under "Signal lost
      // Ns ago" (the track goes stale 8 s past its newest sample) until data returns or Esc. Pruning it made the model,
      // HUD and banner vanish with no word. The registry holds only this aircraft and is replaced on each selection.
    }
  }

  void (async () => {
    while (!stopped) {
      const t0 = performance.now()
      // A hidden tab asks for nothing: the server's interest in its view lapses 15 s later and it stops polling upstream.
      if (document.hidden) {
        await sleep(POLL_MS)
        continue
      }
      await poll().catch((e: unknown) => console.error('FlightHopper: poll crashed:', e))
      await sleep(Math.max(0, POLL_MS - (performance.now() - t0)))
    }
  })()

  // Cesium's default double-click tracks an entity (the runway markers are entities), which would fight the chase camera.
  viewer.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
  const mouse = new ScreenSpaceEventHandler(viewer.scene.canvas)
  const tapPx = matchMedia('(pointer: coarse)').matches ? 36 : 3 // a fingertip covers far more than a small icon
  mouse.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
    // A traffic model's bracket square (chase) takes the click first. ponytail: caught with no action yet; the
    // aircraft's own menu comes later.
    if (traffic !== null && traffic.hitAt(e.position.x, e.position.y) !== null) return
    const hex = fleetLayer.pick(e.position, tapPx)
    if (hex !== null) select(hex)
    else if (!chasing && selected !== null) select(null) // a click on the empty map clears the focus
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
    // Esc steps back one level: an open panel, then the chase (to the map), then the focus.
    if (e.key === 'Escape') {
      if (!rail.close()) {
        if (chasing) setChase(false)
        else select(null)
      }
    } else if ((e.key === 'b' || e.key === 'B') && bench) bench.download()
    else {
      const k = sceneKey(e) // T, L, X: they apply in the chase view (D9, D11), and can be set beforehand
      if (k !== null) setPrefs({ ...prefs, [k]: !prefs[k] })
    }
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
      document.removeEventListener('fullscreenchange', onFullscreen)
      toggles.destroy()
      banner.destroy()
      card.destroy()
      table.destroy()
      legend.destroy()
      rail.destroy()
      ui.remove()
      chaseCam.release()
      exitBrowse(viewer)
      model?.destroy()
      traffic?.destroy()
      fleetLayer.destroy()
      pendingLayer.destroy()
      map.destroy()
      viewer.imageryLayers.remove(night) // and destroys it
      runways.destroy()
      buildings.destroy()
      viewer.destroy()
      delete (window as unknown as { viewer?: Viewer }).viewer
    },
  }
}

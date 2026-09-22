// client/app.ts
// The client app: one Cesium viewer with aircraft dots, runways and a chase model, fed by 1 Hz polls of the server and
// drawn on a delayed render clock. This file only wires the parts in scene/, track/, ui/, bench/ and api.ts together.
import { Cartesian2, Cartesian3, Cartographic, Math as CesiumMath, ScreenSpaceEventHandler, ScreenSpaceEventType } from 'cesium'
import type { Viewer } from 'cesium'
import type { Airport } from '../shared/airports.ts'
import type { ChaseResponse, StatusBrief, ViewResponse } from '../shared/api.ts'
import { ApiClient } from './api.ts'
import { BenchRecorder } from './bench/overlay.ts'
import { AircraftLayer } from './scene/aircraftLayer.ts'
import { ChaseCamera } from './scene/chaseCamera.ts'
import { ChaseModel } from './scene/model.ts'
import { addRunways } from './scene/runways.ts'
import { createViewer } from './scene/viewer.ts'
import { MIN_DELAY_S, RenderClock } from './track/delay.ts'
import { TrackRegistry } from './track/registry.ts'
import type { ClientConfig, ModelManifest, ModelManifestEntry, RenderState } from './types.ts'
import { mountAttribution, mountBanner } from './ui/banner.ts'
import { mountHud } from './ui/hud.ts'

const POLL_MS = 1000 // view and chase both poll at 1 Hz; TrackRegistry's pollPeriodS says the same
const PRUNE_AGE_S = 60 // forget an aircraft one minute after its newest sample
const FAILS_DOWN = 3 // failed polls in a row before the banner reports it
const START_HEIGHT_M = 60_000 // first view: straight down on the hero airport
const HEX = /^~?[0-9a-f]{6}$/
// Until the first reply. Nothing is drawn before it, so the source named here is never shown.
const NO_STATUS: StatusBrief = { source: 'adsblol', degraded: null, cellPeriodP95S: null, chasePeriodP95S: null }

/**
 * Radius of the view poll: the camera height in nm (a top-down view shows about ±0.6 h), rounded up to 10 nm so the
 * ApiClient's per-view `since` key survives small zooms, clamped to 20–250 nm (250 is the server's cap).
 * ponytail: a tilted camera sees further than its height; the far part of such a view stays empty until the user looks
 * down. Upgrade: size the circle from the frustum's ground footprint.
 */
export function viewRadiusNm(cameraHeightM: number): number {
  const nm = Math.ceil(cameraHeightM / 1852 / 10) * 10
  return Number.isFinite(nm) ? Math.min(250, Math.max(20, nm)) : 250
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
  hex: string | null // ?hex=a1b2c3: chase this aircraft from the start (G3)
  bench: boolean // ?bench=1: bench overlay, 'b' downloads the report
  airport: string | null // ?airport=LLBG: first view over this hero (default: the first in heroes.json)
}

export function readParams(search: string): AppParams {
  const q = new URLSearchParams(search)
  const hex = (q.get('hex') ?? '').trim().toLowerCase()
  const airport = (q.get('airport') ?? '').trim().toUpperCase()
  return { hex: HEX.test(hex) ? hex : null, bench: q.get('bench') === '1', airport: airport === '' ? null : airport }
}

/** Credit lines for the attribution box. mountAttribution adds "Not for navigation"; Cesium shows terrain and imagery credits. */
export function attributionFor(model: ModelManifestEntry | null): string[] {
  const lines = ['Flight data © adsb.lol contributors, ODbL 1.0', 'Airports: OurAirports (public domain)']
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

/**
 * Builds the viewer in root and runs the app until stop(). Loops:
 * - every second: view(camera centre, viewRadiusNm(camera height)) and, while an aircraft is selected, chase(hex);
 *   every reply goes straight into the TrackRegistry (between frames, so re-join blends stay continuous).
 * - every frame (scene.preUpdate: after Cesium applies mouse input to the camera, before it updates primitives and
 *   renders, so camera and model move in the same frame): RenderClock → states → layer; for the selected aircraft
 *   also model, chase camera, HUD, banner and bench.
 * Click a dot to chase it (click it again or press Esc to let go). Runways and the model are optional: if their
 * files fail to load, the app runs without them. createViewer failing (terrain unreachable) rejects.
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

  // Overlays live in one element so stop() removes them together (mountAttribution returns no handle).
  const ui = document.createElement('div')
  root.append(ui)
  const hud = mountHud(ui)
  const banner = mountBanner(ui)
  mountAttribution(ui, attributionFor(entry))
  const runways = addRunways(viewer, airports)
  const layer = new AircraftLayer(viewer)
  const chaseCam = new ChaseCamera(viewer)
  const api = new ApiClient(cfg.apiBase)
  const registry = new TrackRegistry({ pollPeriodS: POLL_MS / 1000 })
  const clock = new RenderClock(MIN_DELAY_S)
  const bench = params.bench ? new BenchRecorder(viewer, { label: params.hex ?? 'free' }) : null
  bench?.mountOverlay(ui)
  ;(window as unknown as { viewer?: Viewer }).viewer = viewer // console access for debugging and G3, as in WP-00

  const home = airports.find((a) => a.ident === params.airport) ?? airports[0]
  if (home) viewer.camera.setView({ destination: Cartesian3.fromDegrees(home.lon, home.lat, START_HEIGHT_M) })

  let selected: string | null = params.hex // ?hex= is chased from the start; the camera engages at its first state
  let chased: RenderState | null = null // the selected aircraft as drawn in the last frame that had it
  let status = NO_STATUS
  let failedPolls = 0
  let stopped = false
  let lastFrameMs: number | null = null
  const carto = new Cartographic()

  function select(hex: string | null): void {
    if (hex === selected) return
    chaseCam.release() // also resets its heading, so the next chase starts behind the new aircraft
    selected = hex
    chased = null
  }

  function frame(): void {
    const now = performance.now()
    const dtS = lastFrameMs === null ? 0 : Math.min(1, (now - lastFrameMs) / 1000)
    lastFrameMs = now
    const shown = statusShown(status, failedPolls)
    const states = api.ready ? registry.states(clock.tick(api.serverNowMs(), registry.delayTargetS(selected), dtS)) : []
    layer.update(states, selected)
    const s = selected === null ? null : (states.find((x) => x.hex === selected) ?? null)
    let clearanceM: number | null = null
    if (s !== null) {
      const terrainM = viewer.scene.globe.getHeight(Cartographic.fromDegrees(s.lon, s.lat, 0, carto)) ?? null
      const placed: RenderState = { ...s, hM: placedHeightM(s.hM, s.onGround, terrainM) }
      model?.update(placed)
      clearanceM = chaseCam.update(placed, dtS).clearanceM
      chased = placed
    }
    // No state (before the first sample, pruned, or a gap > 2 min): the model goes like the dot; the camera stays put.
    if (model) model.show = s !== null
    hud.update(s, shown)
    banner.update(shown, s)
    bench?.frame(s, clearanceM)
  }
  const removeFrame = viewer.scene.preUpdate.addEventListener(frame)

  /** Centre and radius of the view poll: the chased aircraft, else the globe point at the canvas centre, else below the camera. */
  function viewCircle(): { lat: number; lon: number; nm: number } {
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
    const v = viewCircle()
    const jobs: Promise<ViewResponse | ChaseResponse>[] = [api.view(v.lat, v.lon, v.nm)]
    if (selected !== null) jobs.push(api.chase(selected))
    const results = await Promise.allSettled(jobs)
    if (stopped) return
    let ok = false
    for (const r of results) {
      if (r.status === 'rejected') continue
      registry.ingest(r.value.samples)
      status = r.value.status
      ok = true
    }
    if (ok) failedPolls = 0
    else if (failedPolls++ === 0) console.warn('FlightHopper: poll failed:', (results[0] as PromiseRejectedResult).reason)
    if (api.ready) registry.prune(api.serverNowMs(), PRUNE_AGE_S)
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
  const clicks = new ScreenSpaceEventHandler(viewer.scene.canvas)
  clicks.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
    const hex = layer.pick(e.position)
    if (hex !== null) select(hex === selected ? null : hex)
  }, ScreenSpaceEventType.LEFT_CLICK)
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
      clicks.destroy()
      bench?.destroy()
      hud.destroy()
      banner.destroy()
      ui.remove()
      chaseCam.release()
      model?.destroy()
      layer.destroy()
      runways.destroy()
      viewer.destroy()
      delete (window as unknown as { viewer?: Viewer }).viewer
    },
  }
}

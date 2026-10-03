// client/app.ts
// The client app: one Cesium viewer in two modes, fed by 1 Hz polls of the server.
// - Browse: a north-up, top-down street map. Every aircraft is an icon turned to its track and coloured by altitude.
//   Clicking one (or a list row) focuses it: its flight card shows and the map stays as it is.
// - Chase (the card's "Chase in 3-D", ?chase=1, or a bare ?hex= link): the 3-D model and the chase camera over the
//   satellite imagery, with the card. The other aircraft within 10 nm show as 3-D models framed by corner brackets
//   (scene/traffic.ts); chase shows no flat icons. The sun lights the chase view, and
//   the relief can sink into the map and grow back (the Scene panel's switches, keys T and L). A frame of flight data
//   hugs the chased aircraft (scene/flightFrame.ts); the flight card stays.
// - Scenario (the Scenarios panel's Play, or ?scenario=<id>&t=<s>): a recorded flight played from static files
//   (scenario/run.ts) in the chase view: only its aircraft, no polls, no card (the frame carries the data), no 3-D
//   buildings (they are modern), its era imagery, the sun at its instant. Esc or exit goes back to the map over it.
// - History (the rail's History button, or ?hist=<unix s>): the map in the past (history/), from adsb.lol's half-hour
//   files, every aircraft in view at a replay clock's time, played through the same Fleet, track, card and chase as live;
//   a time bar at the bottom (play, scrub over the day, speed, Go to, Live). Live polls wait meanwhile.
// A selected aircraft's flown path (its trace from adsb.lol, then its live samples) shows behind it on the map.
// The tools (status, aircraft list, scene, altitude colours, scenarios, events worldwide, about) sit behind a rail of icon
// buttons (ui/rail.ts);
// the search (places, flights in view, recordings, scenarios) is a box at the top centre (ui/searchBox.ts).
// With ?tv=1 a TV remote (arrows, OK, Back, Menu) drives all of it (ui/remote.ts), with preset views for the chase
// camera (ui/chasePresets.ts); without it nothing of that runs.
// Every aircraft goes into the Fleet (newest sample, dead-reckoned: cheap enough for thousands a frame). Only the
// selected one also goes into the TrackRegistry, whose full estimator the chase camera follows.
// This file only wires the parts in scene/, track/, browse/, ui/, bench/ and api.ts together.
import { Cartesian2, Cartesian3, Cartographic, Ellipsoid, Math as CesiumMath, SceneTransforms, ScreenSpaceEventHandler, ScreenSpaceEventType } from 'cesium'
import type { Viewer } from 'cesium'
import type { AlertEvent } from '../shared/alerts.ts'
import { airlineOf } from '../shared/airlines.ts'
import type { Airport } from '../shared/airports.ts'
import type { ChaseResponse, HistoryStatus, StatusBrief, TraceReply } from '../shared/api.ts'
import { distanceNm } from '../shared/geo.ts'
import { SLOT_MS, newestSlotMs, slotOf } from '../shared/history.ts'
import { countryOf, flagEmoji } from '../shared/icaoCountry.ts'
import type { AircraftInfo, RoutePlace } from '../shared/info.ts'
import type { ReadsbAircraft, Sample } from '../shared/types.ts'
import { ApiClient } from './api.ts'
import { BenchRecorder } from './bench/overlay.ts'
import { Fleet, heightM } from './browse/fleet.ts'
import { BROWSE_HEIGHT_M, browseDrag, browsePinch, containsDeg, enterBrowse, exitBrowse, heightToFit, isBrowsing, viewRectangleDeg } from './scene/browseCamera.ts'
import type { RectDeg } from './scene/browseCamera.ts'
import { ChaseCamera } from './scene/chaseCamera.ts'
import { FleetLayer } from './scene/fleetLayer.ts'
import { FlightFrame, boxCentre, liveFlightData, type Rect, type Room } from './scene/flightFrame.ts'
import { makeMapLayer, makeReferenceLayers } from './scene/mapLayer.ts'
import { Weather } from './scene/weather.ts'
import { makePendingLayer } from './scene/pendingLayer.ts'
import { RouteLine, type PathPoint } from './scene/routeLine.ts'
import { dayState, legSpans, type DayState } from './history/aircraftDay.ts'
import { localDay, mountHistoryBar, type AircraftLine, type HistoryBarHandle, type LocalDay } from './history/bar.ts'
import { HistoryClock } from './history/clock.ts'
import { HistoryFeed, type Circle } from './history/feed.ts'
import { KnownHexes, SlotBlock, SlotFailure, askNm, backMs, lookaheadMs, prefetchMs, wantedSlots } from './history/policy.ts'
import {
  MapMoves, aheadOf, aircraftLine, areaMiddle, cameraTarget, chaseAskAt, dayAsk, daySpan, estimateState, firstDayAsked, historyWait, inArea,
  inSight, keepLegs, placeSelected, replayStatus, restartsTrack, selectedInfo, trackSource, viewMove,
} from './history/selected.ts'
import { tracePath, traceSamples } from './history/trace.ts'
import { liveryCode, liveryFromSpec, liveryOf, type Livery } from './scene/livery.ts'
import { ChaseModel } from './scene/model.ts'
import { ModelPicker } from './scene/modelFor.ts'
import { Traffic } from './scene/traffic.ts'
import { AircraftLights } from './scene/aircraftLights.ts'
import { makeNightLayer } from './scene/nightLights.ts'
import { Buildings } from './scene/buildings.ts'
import { addRunways } from './scene/runways.ts'
import { FlatTerrainProvider, areasFor, stripsFor, type AirfieldAirport } from './scene/flatTerrain.ts'
import { gearWanted } from './scene/gear.ts'
import { Sun, parseSunParam, sunTimeMs } from './scene/sun.ts'
import { Topography, groundMemo, pickRelHM } from './scene/topography.ts'
import { createViewer } from './scene/viewer.ts'
import { eoxOnEsriFailure, imageryStatus } from './scene/imagery.ts'
import { listScenarios, loadScenario } from './scenario/format.ts'
import { recordingFile, recordingScenario } from './scenario/fromRecording.ts'
import { Dresser, ScenarioRun } from './scenario/run.ts'
import { damageOf } from './scenario/timeline.ts'
import type { Scenario } from './scenario/types.ts'
import { MAX_DELAY_S, MIN_DELAY_S, RenderClock, p90 } from './track/delay.ts'
import { TrackRegistry } from './track/registry.ts'
import type { ClientConfig, FleetEntry, ModelManifest, RenderState, ScenePrefs, TerrainFrame } from './types.ts'
import { FAILS_DOWN, mountOutage, outageFor } from './ui/outage.ts'
import { followTarget, mayAutoFollow, mountAlerts, type AlertsHandle } from './ui/alerts.ts'
import type { Lookup } from './ui/detail.ts'
import { FOCUS_ASK_MS, entryState, mountFlightCard } from './ui/flightCard.ts'
import { icon } from './ui/icons.ts'
import { mountMapKey } from './ui/mapKey.ts'
import { SHEET_MEDIA, mountRail } from './ui/rail.ts'
import { PICK_PX, cameraStep, mountRemote, tvMode } from './ui/remote.ts'
import { mountChasePresets } from './ui/chasePresets.ts'
import { PhotoCache } from './ui/photo.ts'
import { mountScenarioPanel, type ScenarioPanelHandle } from './ui/scenarioPanel.ts'
import { mountSettings } from './ui/settings.ts'
import { PREFS_KEY, readScenePrefs, writeScenePrefs } from './ui/scenePrefs.ts'
import { FRAME_PREFS_KEY, readFramePrefs, writeFramePrefs } from './ui/framePrefs.ts'
import { baseKey, mountSceneToggles, rainTheme } from './ui/sceneToggles.ts'
import { badgeView } from './ui/imageryBadge.ts'
import { mountStatusPanel, sourceName, statusDot, type StatusPanelHandle } from './ui/sourceBadge.ts'
import { readHist, readScenario, readView, writeUrl, type Orbit } from './ui/urlState.ts'
import { mountTable, type TableHandle } from './ui/table.ts'
import { mountSearchBox, type SearchBoxHandle } from './ui/searchBox.ts'
import type { Item as SearchItem } from './search/search.ts'
import type { SceneTogglesHandle } from './ui/sceneToggles.ts'
import './ui/theme.css'
import './ui/layout.css'

const POLL_MS = 1000 // view and chase both poll at 1 Hz; TrackRegistry's pollPeriodS says the same
const PRUNE_AGE_S = 60 // forget an aircraft at least this long after its newest sample (Fleet: its own staleS if longer)
// Chase traffic runs the chased aircraft's physics too (TrackRegistry.applyTo): a track per aircraft this close to it
// (the 3-D traffic shows 10 nm), dropped 30 s after its newest sample.
const TRAFFIC_TRACK_NM = 12
const TRAFFIC_TRACK_KEEP_S = 30
const START_HEIGHT_M = 60_000 // ?hex= start: straight down on the hero airport until the chase camera takes over
const MIN_VIEW_NM = 20
// The visible hemisphere. The server polls a view up to 250 nm as one circle and a wider one as grid cells, each at a
// period that grows with the view (Poller.viewPeriodMs): the globe view asks each area about every 30 min.
const MAX_VIEW_NM = 5400
const DEFAULT_AIRPORT = 'LLBG' // a ?hex= link without ?at= starts over it (the author's home)
// The first view without ?at=, ?airport= or ?hex=: all of Israel (the author's home), so its traffic loads first; a
// reload keeps ?at=.
const HOME_BOX: RectDeg = { south: 29.45, north: 33.35, west: 34.2, east: 35.9 }
const COUNTRY_MIN_HEIGHT_M = 60_000 // a search pick of a small country (Singapore) still shows its surroundings
const URL_EVERY_MS = 1000 // how often the address bar follows the view (history.replaceState)
// After a selection snaps the render delay, the delay shrinks at 0.05 s/s: at the default 0.2 s/s a small shrink (the
// arrival age's p90 moving by tenths of a second) showed as a 20 % speed-up lurch. It grows at the default 0.2 s/s, so an
// aircraft reporting only every ~40 s (thin coverage) reaches a delay that covers its gaps within ~2 min, not ~9.
const CHASE_SHRINK_S_PER_S = 0.05
const HOVER_PICK_MS = 100 // at most ten hover picks a second while the mouse moves (each pick is a small render pass)
const HEX = /^~?[0-9a-f]{6}$/
// Until the first reply. Nothing is drawn before it, so the source named here is never shown.
const NO_HEXES: ReadonlySet<string> = new Set()
const NO_STATUS: StatusBrief = { source: 'adsblol', degraded: null, cellPeriodP95S: null, chasePeriodP95S: null }
const NO_ENTRIES: readonly FleetEntry[] = []
const FT = 0.3048
// What covers the canvas where the flight-data frame must not go, measured at most every SAFE_EVERY_MS (a layout read).
// Not a traffic aircraft's card: opened and closed by a click, it keeps off the frame instead (keepClear), which stays put.
// A new overlay goes in MAP_COVERS too (History's top-down map keeps its aircraft clear of the same).
const FRAME_COVERS = '.fh-rail, .fh-corner-b, .fh-panel, .fh-card:not(.fh-tcard), .fh-outage-pill, .fh-playbar, .fh-captions, .fh-event-title, .fh-search, .fh-presets'
// What covers the top-down map in History, where its aircraft must not come to rest: FRAME_COVERS less what History never shows
// (captions, event title, TV presets, the outage pill) and with the search box's bar, not its list (that slides open and shut
// over most of the map: it must not move the map under the person typing). The History bar is a .fh-playbar, an open rail
// panel a .fh-panel. Then the map key, which the chase hides (its box is empty there), so the frame has no use for it: cut
// last, as safeArea cuts each cover from the side that keeps the most room, and a small one before the bar can take a strip of
// the whole height.
// ponytail: the clear part is that one rectangle, so ground beside a small cover that was cut away counts as covered.
// Upgrade: the largest empty rectangle.
const MAP_COVERS = '.fh-rail, .fh-corner-b, .fh-panel, .fh-card:not(.fh-tcard), .fh-playbar, .fh-search-bar'
const MAP_KEY_COVER = '.fh-mapkey'
const SAFE_EVERY_MS = 100
const TRAFFIC_CLEAR_PX = 48 // round a clicked traffic aircraft, its card keeps clear of: its square and labels, mostly
const NO_ROOM: Room = { safe: { x: 0, y: 0, w: 0, h: 0 }, covers: [] }
// History (history/): the past from adsb.lol's half-hour files, replayed through the live pipeline.
// What exists until the server's status says (it reports the oldest day adsb.lol keeps, ~42): 30 days back, as the time
// bar guesses too. A time asked for further back (a ?hist= link, a reload) waits in the clock (HistoryClock.asked), the
// address bar keeping it, until a status reaches it: every status is checked, as a server just started reports its own
// 30-day guess until it has found the oldest day (seconds).
// ponytail: a time older than everything adsb.lol keeps waits until the person seeks, the replay meanwhile at the guess's
// oldest moment and the address bar at the time asked. Upgrade: a status that says whether its oldest day was found or
// guessed, so such a time goes to the oldest moment there is.
const HISTORY_GUESS_MS = 30 * 86_400_000
const HISTORY_RATE = 10 // a replay starts at 10×: a half hour in three minutes
const HISTORY_JUMP_MS = 120_000 // the replay clock moving further than this between frames is a seek
const HISTORY_STATUS_MS = 5000 // how often the time bar learns what exists and what adsb.lol lacks
const SEEK_REST_MS = 300 // a scrubber seek asks for its half hours (and brings the aircraft into view) once it rests this long
const DAY_AGAIN_MS = 15_000 // the selected aircraft's day: a failed ask, or an answer short of the replay time, again after this
// An answer for its day decides the replay times inside the span it answered, and this far past its end: a replay playing
// on over midnight keeps its legs while the next day is asked (a jump elsewhere waits for that day's, as at first).
const DAY_PAST_MS = 30 * 60_000
const BRING_FLY_S = 0.8 // the map's flight over the selected aircraft after a jump in time
const FOLLOW_FLY_S = 0.6 // …and to follow it out of the view while playing
const ASK_EVERY_MS = 250 // History asks for the half hours its view lacks from the frame, at most this often
const NO_LEGS: readonly TraceReply[] = []

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
 * The scene toggle a keydown asks for (design D11): T topography, L sun, X see-through buildings; and the map layers: M
 * map or satellite, R roads, P borders and places, W weather. null with a modifier (Cmd/Ctrl+L and Ctrl+T are
 * the browser's), on auto-repeat and while typing in a field.
 */
export function sceneKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; repeat: boolean; target: unknown }): keyof ScenePrefs | 'base' | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return null
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null
  if (t?.isContentEditable || TYPING.has(t?.tagName ?? '')) return null
  const k = e.key.toLowerCase()
  return ({ t: 'topo', l: 'light', x: 'glass', m: 'base', r: 'roads', p: 'places', w: 'wx' } as const)[k as 't'] ?? null
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
 * Where the flight-data frame may go (design §5): the w × h canvas, pad in from its edges and from every cover (the
 * rail and its panel, the flight card, the play bar, the captions; CSS px from the canvas's top-left), each cut away
 * along the side that keeps the most room. Empty covers (hidden) and covers outside the room change nothing.
 */
export function safeArea(w: number, h: number, covers: readonly Rect[], pad = 8): Rect {
  let x0 = pad
  let y0 = pad
  let x1 = w - pad
  let y1 = h - pad
  for (const c of covers) {
    if (c.w <= 0 || c.h <= 0 || c.x >= x1 || c.x + c.w <= x0 || c.y >= y1 || c.y + c.h <= y0) continue
    const cuts = [
      { x0: Math.max(x0, c.x + c.w + pad), y0, x1, y1 }, // keep what is right of it
      { x0, y0, x1: Math.min(x1, c.x - pad), y1 }, // left of it
      { x0, y0: Math.max(y0, c.y + c.h + pad), x1, y1 }, // below it
      { x0, y0, x1, y1: Math.min(y1, c.y - pad) }, // above it
    ]
    const room = (r: (typeof cuts)[number]): number => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0)
    const best = cuts.reduce((a, b) => (room(b) > room(a) ? b : a))
    ;({ x0, y0, x1, y1 } = best)
  }
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
}

// Development only: ?scenarioBase=/harness/fixtures/ loads scenarios from there (the synthetic demo package).
const SCENARIO_BASE = /^\/(?:[\w-]+\/)*$/

/** The folder scenarios load from (loadScenario's base): the app's own, or in development a ?scenarioBase= path. */
export function scenarioBaseFor(search: string, base: string, dev: boolean): string {
  const b = dev ? new URLSearchParams(search).get('scenarioBase') : null
  return b !== null && SCENARIO_BASE.test(b) ? b : base
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

/** A sample as a point of the flown path (scene/routeLine.ts). */
function pathPointOf(x: Sample): PathPoint {
  return { tMs: x.tMs, lat: x.lat, lon: x.lon, hM: heightM(x), altFt: x.altBaroFt ?? x.altGeomFt, onGround: x.onGround }
}

/** The samples (time order) with from < tMs ≤ to. */
function between(xs: readonly Sample[], from: number, to: number): Sample[] {
  let lo = 0
  let hi = xs.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (xs[m].tMs <= from) lo = m + 1
    else hi = m
  }
  const out: Sample[] = []
  for (let i = lo; i < xs.length && xs[i].tMs <= to; i++) out.push(xs[i])
  return out
}

/** The local time zone's short name for the clocks ('GMT+3' where the browser knows no abbreviation). */
function zoneName(): string {
  return new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? ''
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
 * The scene toggles (Layers panel, keys T, L, X) apply in chase; the map layers (M, R, P, W) as applyLayers says. All
 * persist: URL > localStorage > defaults (scenePrefs.ts).
 * Runways and the model are optional: if their files fail to load, the app runs without them. createViewer failing
 * (terrain unreachable) rejects.
 */
export async function startApp(root: HTMLElement, cfg: ClientConfig, hooks: { onFirstData?(): void } = {}): Promise<{ stop(): void }> {
  const params = readParams(location.search)
  const sunParam = parseSunParam(location.search) // ?sun=<ISO> fixes the sun's time, ?sun=+6h shifts it (demos)
  // The localStorage getter and getItem both throw where storage is blocked: then only the URL and the defaults count.
  let store: Storage | null = null
  let stored: string | null = null
  let storedFrame: string | null = null
  try {
    store = window.localStorage
    stored = store.getItem(PREFS_KEY)
    storedFrame = store.getItem(FRAME_PREFS_KEY)
  } catch {
    // blocked: nothing stored, nothing kept
  }
  let prefs = readScenePrefs(location.search, stored)
  // Stored at once: the address bar keeps only toggles that differ from the defaults (urlState.ts), so a ?topo=1 read
  // here must be what a reload finds in storage once the bar has dropped it.
  writeScenePrefs(prefs, store)
  const base = import.meta.env.BASE_URL
  const scenarioBase = scenarioBaseFor(location.search, base, import.meta.env.DEV)
  const urlScenario = readScenario(location.search) // ?scenario=<id>&t=<s>: that scenario, paused at t, once loaded
  // Topography takes the scene in the task that builds the viewer, before its first frame: moving the factor off 1
  // with tiles loaded rebuilds every tile (PoC: up to 2 s).
  // Cesium ion failing at start (its token refused, or ion down): the keyless terrain or imagery took its place.
  const ionFell: { what: 'terrain' | 'imagery'; why: string }[] = []
  const tv = tvMode(location.search)
  const viewerWithTopography = async (): Promise<[Viewer, Topography]> => {
    const v = await createViewer(root, cfg, { onIonFallback: (what, why) => ionFell.push({ what, why }) })
    // The TV (?tv=1) draws the 3-D view at device pixels, as sharp as its overlays at any device scale: Cesium's
    // default draws at CSS pixels and stretches them.
    if (tv) v.useBrowserRecommendedResolution = false
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
  const pick = manifest ? new ModelPicker(manifest) : null
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
  let liveGear: boolean | null = null // the chased aircraft's gear as a crew would have it (gear.ts); null: a first look
  // The last terrain readings under the aircraft and under the chase camera, with the points they were read at.
  // Topography.ground rescales them for an undefined reading (Cesium's picker race, in runs during an animation) within
  // 50 m of that point: about the first 0.5 s of a run at 180 kt. Reset on each selection.
  const acGround = groundMemo()
  const camGround = groundMemo()
  let relatchPending = chasing // a new chase moves a flat map's plane at its first state (D4)
  let tf: TerrainFrame // this frame's exaggeration: topo.update() writes it first in every frame
  let chaseRaw: ReadsbAircraft | null = null // newest full upstream object and info of the selected aircraft
  let chaseInfo: AircraftInfo | null = null
  // The top-down map's line for the selected aircraft (routeLine.ts): its flown path (its trace from adsb.lol, then its
  // live samples since it was selected) and its route's ends (from its chase replies, or the trace's).
  let chaseDest: RoutePlace | null = null
  let chaseOrigin: RoutePlace | null = null
  let selTrace: TraceReply | null = null // its leg: live, up to now; History, the leg of its day it is heard on
  let selSamples: Sample[] = [] // History: selTrace as samples, for its track (denser than the half-hour files)
  let selPath: PathPoint[] = [] // what the line draws: the trace's points, then trail's newer ones
  const trail: PathPoint[] = []
  let trailTMs = -Infinity // tMs of trail's newest point
  let tableHover: string | null = null
  let mapHover: string | null = null
  let status = NO_STATUS
  let failedPolls = 0
  // The events worldwide (ui/alerts.ts asks for them): at start, and when the server says they changed (the status's
  // alertsRev, last acted on here). Follow automatically gives way to the person (ui/alerts.ts mayAutoFollow): when they
  // last moved the map, and last picked an aircraft by hand (performance.now()).
  let alertsRev: number | undefined
  let mapMovedMs = -Infinity
  let handPickMs = -Infinity
  let stopped = false
  let lastFrameMs: number | null = null
  const carto = new Cartographic()
  const sunAt = new Cartesian3() // the chased aircraft, where the sun's elevation is taken
  const aimAt = new Cartesian3() // the chased aircraft's middle, where the chase camera looks
  const onScreen: FleetEntry[] = [] // reused every frame
  // History, every frame (history/selected.ts placeSelected): the fleet's entries with the selected aircraft's own as its
  // day says (its track's state, or a ghost where it was last heard or is estimated to be in a hole of its leg, written into
  // histOwn), that entry, its card's numbers.
  const histAll: FleetEntry[] = []
  const histOwn: FleetEntry = {
    hex: '', lat: 0, lon: 0, hM: 0, altFt: null, onGround: false, trackDeg: null, gsKt: null, vsFpm: null, ageS: 0, staleS: 0,
    gapS: 0, quality: 'other', info: null,
  }
  let histAt: FleetEntry | undefined
  let histCardS: RenderState | null = null
  const moves = new MapMoves() // the person moving the map: History's map does not follow its aircraft meanwhile
  // A scenario playing (run) or being fetched (loadingScenario): either way the polls wait.
  let run: ScenarioRun | null = null
  let dress: Dresser | null = null // the scenario's aircraft on the chase model
  let loadingScenario: string | null = urlScenario?.id ?? null // set before the poll loop's first turn
  // History (the rail button, ?hist=): the past on its own clock, through a Fleet of its own; null: live.
  interface HistoryMode {
    clock: HistoryClock
    feed: HistoryFeed
    bar: HistoryBarHandle
    fedMs: number // the fleet holds the feed's samples up to here
    regMs: number // the selected aircraft's track holds its samples up to here
    regFrom: TraceReply | 'feed' | 'none' | null // they came from this leg of its day, the feed, or none (not heard); null: none yet
    known: KnownHexes // the aircraft whose info the fleet was given in the half hour under the clock
    loading: Set<number> // half hours being fetched
    block: SlotBlock // half hours not to ask for now: missing at adsb.lol, or failed a moment ago
    missing: Set<number> // half hours adsb.lol answered it does not have (with the status's: the bar's red hatch)
    missingShown: string // the missing half hours on the bar, as a key
    failure: SlotFailure // the half hour under the clock failed to load: the bar says so until it loads, or another is under it
    status: HistoryStatus | null
    statusAtMs: number // performance.now() of the last status asked for
    reload: boolean // a half hour arrived: the next frame refills the fleet from the minute before
    seekRestMs: number | null // a scrubber seek: its half hours are asked once performance.now() reaches this
    // The selected aircraft's day of flights (history/aircraftDay.ts) for the bar's local day of the replay time.
    dayOfT: LocalDay // that day
    day: SelectedDay | null // the last answer (another aircraft's says nothing of the selected one)
    dayAsk: { hex: string; startMs: number } | null // the ask in flight: a reply for any other is dropped
    dayAgain: { hex: string; startMs: number; atMs: number } | null // that day is not asked again before atMs (performance.now())
    legsShown: readonly TraceReply[] // the legs on the bar (amber)
    pathLeg: TraceReply | null | undefined // the leg the flown path shows (null none; undefined: the feed's samples meanwhile)
    bring: boolean // bring the selected aircraft into view (a jump), until its day for that time is known
    inside: boolean // in view last frame (the clear part of the map, inset), or a flight over it began: playing, followed out of it
    flyUntilMs: number // the map is flying over it until then (performance.now(); -Infinity: not): no other flight meanwhile
    hadAt: boolean // it was drawn last frame (a first position after none brings it into view)
    askedMs: number // performance.now() of the frame's last ask for half hours (-Infinity: ask at the next frame)
  }
  /** The selected aircraft's flights over a local day and the 12 h before it (GET /api/trace?hex&from&to). */
  interface SelectedDay {
    hex: string
    startMs: number // the local day asked for (LocalDay.startMs)
    fromMs: number // the span answered (to: the server's now at most)
    toMs: number
    legs: TraceReply[]
    reg: string | null
    typeCode: string | null
  }
  let hist: HistoryMode | null = null
  let room = NO_ROOM // the flight-data frame's safe area and what covers the canvas, as last measured
  let safeAtMs = -Infinity
  let mapSafe = NO_ROOM.safe // History's top-down map: the part of the canvas nothing covers, as last measured
  let mapSafeAtMs = -Infinity

  // Overlays live in one element so stop() removes them together (mountAttribution returns no handle). layout.css
  // places them; data-mode switches what browse and chase show.
  // Chase traffic: 3-D models around the chased aircraft, their brackets in a layer under the overlays; the open one's
  // (its card showing) in one over the flight-data frame's cards.
  const traffic = pick ? new Traffic(viewer, pick, div('fh-traffic', root), { openLayer: div('fh-traffic fh-traffic-open', root) }) : null
  const lights = new AircraftLights(viewer) // nav, beacon, strobe and landing lights on the chased model and the traffic
  // The flight-data frame around the chased aircraft: over the traffic brackets, under the overlays (flightFrame.css).
  // Its cards as the viewer arranged them (edit mode: the layout button in the corner), kept in this browser.
  const frameLayer = div('fh-frame', root)
  const framePrefs = readFramePrefs(storedFrame)
  let frameUnits = framePrefs.units // the weather card's speeds and heights are in these too
  const flightFrame = new FlightFrame(frameLayer, {
    prefs: framePrefs,
    onPrefs: (p) => {
      frameUnits = p.units
      writeFramePrefs(p, store)
    },
    onEdit: (on) => rail.button('layout').setAttribute('aria-pressed', String(on)),
  })
  const ui = div('fh-ui', root)
  ui.dataset.mode = chasing ? 'chase' : 'browse'
  // Every tool sits behind a small icon on the rail (right edge), or on a button of its own (rail.ts spots): Layers under
  // the rail, the instrument layout at the bottom centre, settings and full screen at the bottom right. All panels start closed. layout.css places the rest.
  let toggles!: SceneTogglesHandle
  let table!: TableHandle
  let statusPanel!: StatusPanelHandle
  let scenarioPanel!: ScenarioPanelHandle
  let alertsUi!: AlertsHandle
  let searchBox!: SearchBoxHandle
  // The Scenarios panel asks for its list at mount; it gets it once the panel is first opened, not at start.
  let openedScenarios!: () => void
  const scenariosOpened = new Promise<void>((resolve) => (openedScenarios = resolve))
  let scenariosSeen = false
  const rail = mountRail(ui, [
    // Phones only: the search box's tab (wider screens have the box itself at the top centre).
    { id: 'search', icon: 'search', label: 'Search', short: 'Search', spot: 'phone', action: () => searchBox.open() },
    // The live status (source, refresh, coverage, imagery) in a line over the list of the aircraft in view; the button
    // carries the count, the feed's dot and its loading light.
    { id: 'aircraft', icon: 'list', label: 'Aircraft in view and live status', short: 'Aircraft', panel: {
      title: 'Aircraft', wide: true,
      mount: (b, head) => {
        const line = div('fh-status-line', b)
        statusPanel = mountStatusPanel(line, { onPick: pickFromList })
        table = mountTable(b, head, { onSelect: pickFromList, onHover: (hex) => (tableHover = hex), flagOf })
      },
    } },
    // On the rail under the list, so the flight card has the top left corner to itself.
    // The packaged scenarios and the flights recorded with the card's Record button, each replayed in the chase view.
    { id: 'scenarios', icon: 'film', label: 'Scenarios and recorded flights', short: 'Scenes', panel: {
      title: 'Scenarios and recordings',
      mount: (b) => (scenarioPanel = mountScenarioPanel(b, {
        list: () => scenariosOpened.then(() => listScenarios(base)),
        recordings: () => scenariosOpened.then(() => api.recordings()),
        onPlay: (id) => void startScenario(id, { play: true }),
        onRename: (file, name) => api.renameRecording(file, name),
        onDelete: (file) => api.deleteRecording(file),
      })),
    } },
    // The map in the past (history/): a time bar over the days adsb.lol keeps. Pressed again (or the bar's Live): back to now.
    { id: 'history', icon: 'history', label: 'History: the map in the past', short: 'History', action: () => (hist === null ? enterHistory(null) : exitHistory()) },
    // Emergencies and steep descents worldwide (ui/alerts.ts): the server's watch, the week's events, toasts for new ones;
    // the bell counts those not seen. An event's aircraft is followed live (followEvent) or replayed in History (replayEvent).
    { id: 'events', icon: 'bell', label: 'Events worldwide: emergencies and steep descents', short: 'Events', panel: {
      title: 'Events',
      mount: (b) => (alertsUi = mountAlerts(b, ui, {
        store,
        nowMs: () => (api.ready ? api.serverNowMs() : Date.now()),
        // The first answer stands for its count: the first status that says the same asks nothing more.
        get: () => api.events().then((r) => {
          alertsRev ??= r?.rev
          return r
        }),
        onSwitch: (on) => api.setAlerts(on),
        onFollow: (e) => followEvent(e, false),
        onReplay: replayEvent,
        onAuto: (e) => {
          const now = performance.now()
          const may = mayAutoFollow({
            history: hist !== null, scenario: run !== null || loadingScenario !== null,
            mapMovedAgoMs: now - mapMovedMs, handPickAgoMs: now - handPickMs, chasing,
            otherSheet: rail.openId !== null && rail.openId !== 'events' && matchMedia(SHEET_MEDIA).matches,
          })
          if (may) followEvent(e, true) // else the toast alone
        },
        onBadge: (t) => rail.setBadge('events', t),
      })),
    } },
    // A square of its own under the rail: map or satellite, roads, weather, and the 3-D scene's switches.
    { id: 'scene', icon: 'layers', label: 'Layers: map, roads, weather, 3-D scene', short: 'Layers', spot: 'under', panel: {
      title: 'Layers', mount: (b) => (toggles = mountSceneToggles(b, { prefs, onChange: (next) => setPrefs(next) })),
    } },
    // Chase only (flightFrame.css): the frame's cards, to move, hide and show; an open panel closes to show them.
    // A traffic aircraft's card closes too (it and its brackets would sit over the cards), and none opens while editing.
    { id: 'layout', icon: 'layout', label: 'Edit instrument layout', short: 'Layout', spot: 'bottom', action: () => {
      if (!flightFrame.editing) rail.close()
      if (!flightFrame.editing) traffic?.close()
      flightFrame.edit(!flightFrame.editing)
    } },
    { id: 'settings', icon: 'settings', label: 'Settings', short: 'Settings', spot: 'corner', action: () => settings.open() },
    // Not where the page cannot go full screen (iPhone Safari).
    ...(document.fullscreenEnabled ? [{ id: 'fullscreen', icon: 'maximize', label: 'Full screen', short: 'Full', spot: 'corner', action: () => toggleFullscreen() } as const] : []),
  ], (id) => {
    if (id === 'aircraft') table.refresh() // opening the list shows it fresh
    if (id === 'events') alertsUi.opened() // what it lists counts as seen; asked afresh
    if (id === 'scenarios') {
      // The first opening lets the mount's asks go; each later one asks for the recordings again (new ones, ended ones).
      if (scenariosSeen) scenarioPanel.refresh('recordings')
      scenariosSeen = true
      openedScenarios()
    }
  })
  const layoutBtn = rail.button('layout')
  layoutBtn.setAttribute('aria-pressed', 'false') // a toggle: edit mode
  rail.button('history').setAttribute('aria-pressed', 'false') // a toggle: History
  const ionImagery = ionFell.find((f) => f.what === 'imagery') // EOX in place of ion's Bing
  const imagery0 = badgeView(ionImagery ? { source: 'eox', fallback: ionImagery.why } : imageryStatus(cfg))
  statusPanel.setImagery(imagery0.text, imagery0.state)
  // The API keys (the rail's gear): saved in this browser, they win over .env.local at the next load.
  // Its Controls tab lists the keyboard shortcuts; not where there are none (a touch screen).
  const settings = mountSettings(ui, {
    env: import.meta.env, store, controls: !matchMedia('(pointer: coarse)').matches,
    dark: prefs.dark, onDark: (dark) => setPrefs({ ...prefs, dark }),
  })
  rail.button('settings').setAttribute('aria-haspopup', 'dialog')
  for (const f of ionFell) settings.setFallback('ion', f.what, f.why)
  // Airports, cities, countries, the flights in view, recordings and scenarios (ui/searchBox.ts): top centre, / to focus.
  searchBox = mountSearchBox(ui, {
    placesUrl: `${base}search/places.json`,
    flights: () => onScreen,
    recordings: () => api.recordings().then((r) => r ?? []),
    scenarios: () => listScenarios(base),
    store,
    onPick: (item) => goTo(item),
  })
  const photos = new PhotoCache() // shared: a traffic aircraft's photo is there when it is chased
  const card = mountFlightCard(ui, {
    onClose: () => {
      byHand()
      select(null)
    },
    onChase: (on) => {
      byHand()
      setChase(on)
    },
    photos, lookup: lookupFor,
    onRecord: (hex, on) => api.record(hex, on).then((r) => r.rec),
  })
  // A click in a traffic aircraft's brackets opens its card: live from the fleet, its full object asked for as a focused
  // aircraft's is (poll). Its Chase chases it instead (select: a chase stays a chase, on the new aircraft).
  const trafficCard = mountFlightCard(ui, {
    traffic: true, onClose: () => traffic?.close(), onChase: () => chaseTraffic(), photos, lookup: lookupFor,
  })
  let trafficRaw: ReadsbAircraft | null = null // the open traffic aircraft's newest full upstream object
  let trafficAsked: { hex: string; ms: number } | null = null
  let trafficClick: Cartesian2 | null = null // where its brackets were clicked: the card keeps clear of it, once shown
  const chaseTraffic = (): void => {
    const hex = traffic?.openHex ?? null
    traffic?.close()
    if (hex === null) return
    byHand()
    select(hex)
  }
  // Live data stopped (offline, our server, the source): a card over the greyed map, or a pill (outage.ts).
  const outage = mountOutage(ui)
  let lastOkMs: number | null = null // the last good answer from our server (Date.now clock)
  const mapKey = mountMapKey(ui) // bottom left, top-down only: altitude colours and the scale
  let scaleAtMs = -Infinity
  const keyA = new Cartesian2()
  const keyB = new Cartesian2()
  const keyGa = new Cartesian3()
  const keyGb = new Cartesian3()
  const seenWC = new Cartesian3() // History: the selected aircraft's place in the world and where it is drawn on the canvas (screenOf)
  const seenAt = new Cartesian2()
  const pixel = new Cartesian2() // a canvas pixel whose ground groundAt asks for
  const pixelGround = new Cartesian3()
  /** Metres per CSS pixel on the ground at the screen's centre (the scale the key shows), or null where that is sky. */
  const groundScale = (): number | null => {
    const r = viewer.canvas.getBoundingClientRect()
    keyA.x = r.width / 2 - 50
    keyB.x = r.width / 2 + 50
    keyA.y = keyB.y = r.height / 2
    const a = viewer.camera.pickEllipsoid(keyA, undefined, keyGa)
    const b = a && viewer.camera.pickEllipsoid(keyB, undefined, keyGb)
    return a && b ? Cartesian3.distance(a, b) / 100 : null
  }
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
  // Runways lie flat in the terrain itself (flatTerrain.ts): the hero airports' always, a scenario's airfield (its
  // package's airport.json, as it was then) while it plays.
  const baseTerrain = viewer.terrainProvider
  const heroStrips = stripsFor(airports)
  viewer.terrainProvider = new FlatTerrainProvider(baseTerrain, heroStrips, [])
  let airfield: ReturnType<typeof addRunways> | null = null // the playing scenario's runways
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
      settings.setFallback('arcgis', 'imagery', why)
    })
  }
  sun.attachModel(model?.model ?? null)
  sun.setEnabled(chasing && prefs.light)
  // VITE_MAP_URL: another tile server ({z}/{x}/{y}.png is appended), as the OpenStreetMap tile policy asks to allow.
  const mapUrl: string | undefined = import.meta.env.VITE_MAP_URL?.trim() || undefined
  const map = makeMapLayer(viewer, mapUrl)
  const { roads, places } = makeReferenceLayers(viewer) // over the map, the satellite and the night lights
  const weather = new Weather(viewer, cfg.apiBase, ui, (text) => toggles.setWeather(text), { units: () => frameUnits, radarIndex: () => map.liftIndex })
  /**
   * The layers the prefs and the view ask for: the street map or the satellite, roads and borders & places each over the
   * satellite, weather top-down and live only (it is today's: it says nothing of the past), its rain in the colours for
   * the top-down map's base (the satellite is dark under the rain) and under the map's names (lift) or the satellite's
   * roads and places.
   */
  const applyLayers = (): void => {
    const onMap = prefs[baseKey(chasing)]
    map.show = onMap
    map.dark = prefs.dark
    roads.show = prefs.roads && !onMap
    places.show = prefs.places && !onMap
    weather.theme = rainTheme(prefs)
    weather.show = prefs.wx && !chasing && hist === null
    map.lift = weather.show
    if (hist !== null && prefs.wx) toggles.setWeather('Live only') // the chase has no weather row to say anything on
    else if (!prefs.wx) toggles.setWeather(null)
  }
  applyLayers()
  const fleetLayer = new FleetLayer(viewer)
  const pendingLayer = makePendingLayer(viewer) // the view's areas not loaded yet, veiled on the map
  const routeLine = new RouteLine(viewer)
  const globe = viewer.scene.globe
  // Clearance above the ground drawn this frame: globe.getHeight answers last frame's while the relief grows or sinks.
  const chaseCam = new ChaseCamera(viewer, { groundAt: (c) => topo.ground(globe.getHeight(c), tf, camGround, c) })
  // ?tv=1: the chase camera's preset views and their Auto tour, through its orbit (?cam=); frame() steps them. They hang
  // under the rail's Layers square: the frame's room loses least there, beside the rail it already keeps off.
  const presets = !tv ? null : mountChasePresets(ui.querySelector<HTMLElement>('.fh-under') ?? ui, {
    get: () => ({ headingDeg: chaseCam.orbit.headingOffsetDeg, pitchDeg: chaseCam.orbit.pitchDeg, rangeM: chaseCam.orbit.rangeM }),
    set: (o) => chaseCam.orbit.set(o.headingDeg, o.pitchDeg, o.rangeM),
  })
  const api = new ApiClient(cfg.apiBase)
  const liveFleet = new Fleet()
  let fleet = liveFleet // History swaps in a Fleet of its own; Live swaps this one back
  let registry = new TrackRegistry({ pollPeriodS: POLL_MS / 1000 })
  let trafficTracks = new TrackRegistry({ pollPeriodS: POLL_MS / 1000 })
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
    applyLayers()
    // Over the chased aircraft's last position (?at=) so the first view poll already holds it and its traffic.
    if (start) viewer.camera.setView({ destination: Cartesian3.fromDegrees(start.lon, start.lat, urlView.at ? Math.max(START_HEIGHT_M / 6, start.heightKm * 1000) : START_HEIGHT_M) })
    if (urlView.cam) chaseCam.orbit.set(urlView.cam.headingDeg, urlView.cam.pitchDeg, urlView.cam.rangeM)
  }
  let lastUrlMs = -Infinity

  /** The address bar follows what is on screen (see urlState.ts), so a reload shows the same view. */
  function syncUrl(now: number): void {
    if (now - lastUrlMs < URL_EVERY_MS || loadingScenario !== null) return // a reload while it loads still asks for it
    lastUrlMs = now
    const cam = viewer.camera.positionCartographic
    const heightKm = cam.height / 1000
    // Browse: the point under the (top-down) camera. Chase: the chased aircraft; before its first state, the camera.
    const here = { lat: CesiumMath.toDegrees(cam.latitude), lon: CesiumMath.toDegrees(cam.longitude), heightKm }
    const at = !chasing ? (isBrowsing(viewer) ? here : null) : chased !== null ? { lat: chased.lat, lon: chased.lon, heightKm } : here
    const o = chaseCam.orbit
    const orbit = chasing ? { headingDeg: o.headingOffsetDeg, pitchDeg: o.pitchDeg, rangeM: o.rangeM } : null
    const scenario = run === null ? null : { id: run.scenario.id, t: run.player.clock.t } // replaces at, hex and chase
    // History: the replay time; a time asked for that the clock waits for (HistoryClock.asked) stays, not the one it waits at.
    const histMs = hist === null ? null : (hist.clock.asked ?? hist.clock.now(now))
    const next = writeUrl(location.search, { at, hex: selected, chase: chasing, cam: orbit, prefs, scenario, hist: histMs })
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
    chaseDest = null
    trail.length = 0
    trailTMs = -Infinity
    selTrace = null
    selSamples = []
    selPath = []
    chaseOrigin = null
    liveGear = null // another aircraft: its gear as first seen, not swinging there
    // Only the selected aircraft is estimated: a fresh registry, seeded with the newest sample the fleet has of it.
    registry = new TrackRegistry({ pollPeriodS: POLL_MS / 1000 })
    snapClock = hex !== null
    arrivalAgesS.length = 0
    lastFocusAskMs = -Infinity
    seedSample = null
    if (hex !== null) {
      if (hist !== null) {
        restartSelectedTrack(hist, hist.clock.now(performance.now())) // before the seed, which it would drop
        card.setRecording(hex, undefined, 0) // no Record button in the past
      }
      const seed = fleet.newest(hex)
      seedSample = seed ?? null
      if (seed) registry.ingest([seed])
      if (hist === null) fetchTrace(hex) // History asks for its day instead
    }
    if (hist !== null) selectedInHistory(hist)
  }

  /**
   * Live: the selected aircraft's flight leg (its trace), for its flown path. A reply for another selection, or once
   * History began, is dropped; none (404): the path is the live samples'.
   */
  function fetchTrace(hex: string): void {
    api.trace(hex).then((tr) => {
      if (hex !== selected || hist !== null || tr === null) return
      selTrace = tr
      chaseOrigin = tr.origin ?? null
      rebuildPath()
    }, (e: unknown) => console.warn('FlightHopper: no trace:', e))
  }

  /**
   * selPath: live, the trace's points then the trail's newer ones; in History, until the selected aircraft's day is
   * known, the feed's samples of it (then its day's leg: showSelectedDay).
   */
  function rebuildPath(): void {
    const h = hist
    if (h !== null) {
      selPath = selected === null ? [] : h.feed.samplesOf(selected, -Infinity, Infinity).map(pathPointOf)
      return
    }
    const base = selTrace === null ? [] : tracePath(selTrace)
    const first = trail.length > 0 ? trail[0].tMs : Infinity
    selPath = trail.length === 0 ? base : base.filter((p) => p.tMs < first).concat(trail)
  }

  /** History: the seconds between the slices of the half hour at t (10 before it is loaded). */
  const stepAt = (h: HistoryMode, t: number): number => h.feed.stepOf(slotOf(Math.min(t, h.clock.maxMs - 1))) ?? 10

  /** History: the selected aircraft's track afresh from back(step) before t (a seek, or its source changed). */
  function restartSelectedTrack(h: HistoryMode, t: number): void {
    registry = new TrackRegistry({ pollPeriodS: POLL_MS / 1000 })
    h.regMs = t - backMs(stepAt(h, t))
    h.regFrom = null
  }

  /**
   * History: a fresh fleet from back(step) before t: a seek, the start, or the half hour under the clock arrived. The
   * selected aircraft's track goes too, unless that half hour only arrived and the aircraft is heard on its leg at t
   * (heard: its track runs on the leg, not on the files).
   */
  function restartHistory(h: HistoryMode, t: number, seek: boolean, heard: boolean): void {
    const step = stepAt(h, t)
    fleet = new Fleet()
    fleet.setHintS(2.5 * step) // before the first prune: lifetimes for the files' slices, not the 60 s floor
    h.known.clear()
    h.fedMs = t - backMs(step)
    h.reload = false
    if (seek || !heard) restartSelectedTrack(h, t)
    if (seek && chasing) chaseCam.snapHeading() // a jump is a cut: behind the aircraft at once, not a swing round
  }

  /**
   * History, every frame: the feed's samples up to t into the fleet (after a seek, from back(step) before t), each
   * aircraft's info with its first sample in the half hour under the clock (policy.ts KnownHexes: the fleet forgets an
   * info an hour after its last sample), and the selected aircraft's samples up to t + lookahead(step) into its track, as
   * its day says (ds): heard, its leg's (its trace: 1–4 s points with track, rate and roll, where the files have 10 s
   * points without them); not heard (a hole in its leg too), none (no track: it is drawn where it was last heard, or
   * estimated to be); its day not known yet, the feed's.
   * The chase traffic is drawn from the fleet (its samples already point at their next position): no tracks of its own,
   * which on 10 s samples would stop between them.
   */
  function feedHistory(h: HistoryMode, t: number, ds: DayState | null): void {
    const seek = t < h.fedMs || t - h.fedMs > HISTORY_JUMP_MS
    if (seek || h.reload) restartHistory(h, t, seek, ds?.kind === 'heard')
    const fresh = h.feed.take(h.fedMs, t)
    h.fedMs = t
    if (fresh.length > 0) {
      const slot = slotOf(Math.min(t, h.clock.maxMs - 1))
      let infos: AircraftInfo[] | undefined
      for (const x of fresh) {
        if (!h.known.first(x.hex, slot)) continue
        const i = x.hex === selected && chaseInfo !== null ? chaseInfo : h.feed.info(x.hex)
        if (i !== null) (infos ??= []).push(i)
      }
      fleet.ingest(fresh, infos)
    }
    if (selected === null) return
    const from = trackSource(ds)
    if (restartsTrack(h.regFrom, from)) restartSelectedTrack(h, t) // another source: a fresh track
    h.regFrom = from
    if (from === 'none') return
    if (from !== 'feed' && from !== selTrace) {
      selTrace = from
      selSamples = traceSamples(from)
    }
    const to = t + lookaheadMs(stepAt(h, t))
    if (to <= h.regMs) return
    const mine = from === 'feed' ? h.feed.samplesOf(selected, h.regMs, to) : between(selSamples, h.regMs, to)
    h.regMs = to
    if (mine.length > 0) registry.ingest(mine)
  }

  /**
   * History: the selected aircraft's day as last answered, when it speaks for t (inside the span it answered, to
   * DAY_PAST_MS past it); null: none yet, or none for t (as before the first: the feed's samples until it comes).
   */
  function selectedDay(h: HistoryMode, t: number): SelectedDay | null {
    const d = h.day
    return selected !== null && d !== null && d.hex === selected && t >= d.fromMs && t <= d.toMs + DAY_PAST_MS ? d : null
  }

  /**
   * History: the selected aircraft at tMs in a few words (selected.ts aircraftLine), for the time bar's tip over the rail:
   * from its day as the frame has it (selectedDay); null with none selected, or its day not known for tMs.
   */
  function describeSelected(tMs: number): AircraftLine | null {
    const day = hist === null ? null : selectedDay(hist, tMs)
    return day === null ? null : aircraftLine(dayState(day.legs, tMs), tMs)
  }

  /**
   * History: the selected aircraft's day of flights (GET /api/trace?hex&from&to over selected.ts daySpan) for the bar's
   * local day of t, asked when it is not answered: on selecting, on entering History with a selection, when the replay
   * reaches another day, and at a time past what an answer for today covered. One ask a day at a time; a reply for
   * another selection, day or mode is dropped; a failure is asked again after DAY_AGAIN_MS.
   */
  function askDayWhenDue(h: HistoryMode, t: number): void {
    if (t < h.dayOfT.startMs || t >= h.dayOfT.endMs) h.dayOfT = localDay(t)
    const hex = selected
    if (hex === null) return
    const { startMs, endMs } = h.dayOfT
    const ask = { hex, startMs }
    const due = dayAsk(ask, t, h.day, h.dayAsk, h.dayAgain, performance.now()) // answered, in flight, or failed a moment ago: no
    h.dayAsk = due.inFlight // an ask for another day is dropped
    if (!due.ask) return
    h.dayAsk = ask
    const span = daySpan(startMs, endMs, h.status?.oldestSlotMs ?? null, Date.now())
    const settle = (): boolean => {
      if (hist !== h || h.dayAsk !== ask) return false // another selection, day or mode by now
      h.dayAsk = null
      h.dayAgain = { hex, startMs, atMs: performance.now() + DAY_AGAIN_MS }
      return true
    }
    api.traceDay(hex, span.fromMs, span.toMs).then((r) => {
      // None at adsb.lol at all (404): no flight that day.
      if (!settle()) return
      // A fresh answer for the day held keeps the legs it repeats (the track and path go by the leg itself).
      const old = h.day
      const legs = r?.legs ?? []
      h.day = {
        hex, startMs, fromMs: r?.fromMs ?? span.fromMs, toMs: r?.toMs ?? span.toMs, reg: r?.reg ?? null, typeCode: r?.typeCode ?? null,
        legs: old !== null && old.hex === hex && old.startMs === startMs ? keepLegs(old.legs, legs) : legs,
      }
    }, (e: unknown) => {
      if (settle()) console.warn('FlightHopper: no day of flights:', e)
    })
  }

  /** History: a new selection (or none): the ask for the last one's day is dropped, this one's goes, and it comes into view. */
  function selectedInHistory(h: HistoryMode): void {
    h.dayAsk = null
    h.pathLeg = undefined
    h.inside = false
    h.hadAt = false
    h.bring = selected !== null
    askDayWhenDue(h, h.clock.now(performance.now()))
  }

  /**
   * History, every frame: the selected aircraft's flights on the bar (amber; none selected: none), and its flown path:
   * the leg it is heard on, is in a hole of, or was last on (cut at the replay time by the line), none before its first
   * or on a day it did not fly; until its day is known, the feed's samples (historyTick).
   */
  function showSelectedDay(h: HistoryMode, day: SelectedDay | null, ds: DayState | null): void {
    const legs = day?.legs ?? NO_LEGS
    if (legs !== h.legsShown) {
      h.legsShown = legs
      h.bar.setLegs(legSpans(legs))
    }
    const leg = ds === null ? undefined : ds.kind === 'heard' || ds.kind === 'gap' || ds.kind === 'quiet' ? ds.leg : null
    if (leg === h.pathLeg) return
    h.pathLeg = leg
    if (leg === undefined) rebuildPath() // the feed's samples at once (historyTick keeps them fresh), not the old leg's
    else selPath = leg === null ? [] : tracePath(leg)
  }

  /**
   * History, top-down: the selected aircraft into view after a jump (h.bring: once its position at the replay time is
   * known, and again when its day for that time comes, which may put it elsewhere) or at its first position after none,
   * and followed while playing when it leaves the view (selected.ts viewMove). In view is where the person can see it: drawn
   * inside the part of the canvas that no card, panel, bar or button covers (mapClear), less a tenth of that part on each
   * side (selected.ts inArea). The map flies over it at the height it has, to the middle of that part (centredOn), aimed
   * where it will be as the flight lands (selected.ts aheadOf: the replay goes on meanwhile), and asks for the half hours
   * of where it lands as it takes off (v: this frame's view, whose size it keeps). Not in the chase, which needs no help,
   * nor while a scrubber seek rests or a flight is under way (in view stays what it was then: viewMove).
   */
  function keepInView(h: HistoryMode, now: number, t: number, day: SelectedDay | null, ds: DayState | null, v: Circle): void {
    const at = histAt
    const had = h.hadAt
    h.hadAt = at !== undefined
    if (chasing || selected === null) {
      h.bring = false
      h.inside = false
      return
    }
    const area = mapClear(now)
    const inside = at !== undefined && inArea(screenOf(at), area)
    const m = viewMove({
      busy: now < h.flyUntilMs || h.seekRestMs !== null, bring: h.bring, had, at: at !== undefined, playing: h.clock.playing,
      wasInside: h.inside, inside, moved: moves.recent(now), dayKnown: ds !== null && day !== null && day.startMs === h.dayOfT.startMs,
      nowhere: ds?.kind === 'before' || ds?.kind === 'none',
    })
    h.bring = m.bring
    h.inside = m.inside
    if (m.fly === null || at === undefined) return
    const flyS = m.fly === 'bring' ? BRING_FLY_S : FOLLOW_FLY_S
    const runs = h.clock.playing && !h.clock.stalled // the replay the flight takes: none while paused or waiting for data
    const to = centredOn(aheadOf(at, ds, t, runs ? flyS * 1000 * h.clock.rate : 0), area)
    enterBrowse(viewer, to, { heightM: viewer.camera.positionCartographic.height, flyS })
    h.flyUntilMs = now + flyS * 1000
    askSlots(h, t, { lat: to.lat, lon: to.lon, nm: v.nm })
  }

  /**
   * Where e, History's selected aircraft, is drawn on the canvas (CSS px from its top-left); undefined where it is not seen:
   * behind the camera, or behind the globe's curve (selected.ts inSight: its projection would still land on the canvas).
   * ponytail: projected at hM, which on the ground is the geoid; the layer draws a ground aircraft on the terrain, up to ~3 km
   * higher: a little off from a zoom a few km above a high airport. Upgrade: the layer's own drawn position.
   */
  function screenOf(e: FleetEntry): Cartesian2 | undefined {
    const cam = viewer.camera
    const p = Cartesian3.fromDegrees(e.lon, e.lat, e.hM, Ellipsoid.WGS84, seenWC)
    if (!inSight(cam.positionCartographic.height, e.hM, Cartesian3.angleBetween(cam.positionWC, p))) return undefined
    return SceneTransforms.worldToWindowCoordinates(viewer.scene, p, seenAt)
  }

  /** The ground (degrees) under the canvas pixel (x, y) (CSS px from its top-left); null where the globe is not under it. */
  function groundAt(x: number, y: number): { lat: number; lon: number } | null {
    pixel.x = x
    pixel.y = y
    const hit = viewer.camera.pickEllipsoid(pixel, undefined, pixelGround)
    const g = hit === undefined ? undefined : Cartographic.fromCartesian(hit)
    return g === undefined ? null : { lat: CesiumMath.toDegrees(g.latitude), lon: CesiumMath.toDegrees(g.longitude) }
  }

  /**
   * Where the map looks to draw e at the middle of the clear area (selected.ts cameraTarget): the ground under that pixel
   * against the ground at the canvas's centre, both read from the camera as it is. The aircraft's own place where there is none.
   */
  function centredOn(e: { lat: number; lon: number; hM: number }, area: Rect): { lat: number; lon: number } {
    const c = viewer.canvas
    const m = areaMiddle(area)
    const under = groundAt(c.clientWidth / 2, c.clientHeight / 2)
    const middle = m === null ? null : groundAt(m.x, m.y)
    return under === null ? { lat: e.lat, lon: e.lon } : cameraTarget(e, viewer.camera.positionCartographic.height, under, middle)
  }

  /**
   * Opens History at tMs (null: the start of the newest published half hour), paused unless play. A tMs further back than
   * the guess of what exists waits in the clock for a status that reaches it (HistoryClock.asked; see HISTORY_GUESS_MS).
   */
  function enterHistory(tMs: number | null, play = false): void {
    if (run !== null || loadingScenario !== null) exitScenario()
    const nowP = performance.now()
    const wall = Date.now()
    // Until the server's status says: HISTORY_GUESS_MS back, and the end of the newest half hour published (the bar's own
    // guess, too).
    const minMs = wall - HISTORY_GUESS_MS
    const maxMs = newestSlotMs(wall) + SLOT_MS
    const asked = tMs ?? maxMs - SLOT_MS
    if (hist !== null) {
      hist.clock.seek(asked, nowP) // inside the bounds as the clock knows them
      return jumped(hist)
    }
    const bar = mountHistoryBar(ui, {
      zone: zoneName(), nowMs: () => Date.now(),
      onToggle: () => hist?.clock.toggle(performance.now()),
      onSeek: (t) => seekHistory(t, false),
      onRate: () => void hist?.clock.nextRate(performance.now()),
      onLive: () => exitHistory(),
      onGoTo: (t) => seekHistory(t, true),
      describe: (t) => describeSelected(t),
    })
    bar.setBounds(minMs, maxMs) // the clock's guess, until the server's status
    const clock = new HistoryClock(asked, { minMs, maxMs, playing: play, rate: HISTORY_RATE }, nowP)
    const t0 = clock.now(nowP) // inside the guess
    const h: HistoryMode = {
      clock, feed: new HistoryFeed(), bar,
      fedMs: t0, regMs: t0, regFrom: null, known: new KnownHexes(), loading: new Set(), block: new SlotBlock(), missing: new Set(),
      missingShown: '', failure: new SlotFailure(), status: null, statusAtMs: -Infinity,
      reload: false, seekRestMs: null, dayOfT: localDay(t0), day: null, dayAsk: null, dayAgain: null, legsShown: NO_LEGS,
      pathLeg: undefined, bring: false, inside: false, flyUntilMs: -Infinity, hadAt: false, askedMs: -Infinity,
    }
    hist = h
    selTrace = null // before restartHistory: a live leg must not keep the live track
    selSamples = []
    selPath = []
    restartHistory(h, t0, false, false)
    chaseRaw = null
    trafficRaw = null
    // Today's route and identity say nothing of the past: its day of flights brings its own.
    chaseDest = null
    chaseOrigin = null
    chaseInfo = null
    trail.length = 0
    trailTMs = -Infinity
    ui.dataset.history = '1'
    rail.button('history').setAttribute('aria-pressed', 'true')
    applyLayers() // the weather is today's: live only
    if (selected !== null) card.setRecording(selected, undefined, 0)
    selectedInHistory(h) // its day asked for
    jumped(h) // the half hours at once, and the selected aircraft into view
    lastUrlMs = -Infinity
    if (!firstData) {
      firstData = true
      hooks.onFirstData?.()
    }
  }

  /** Live again: the bar goes, the live Fleet comes back (its polls resume), the selected aircraft is taken up live. */
  function exitHistory(): void {
    if (hist === null) return
    hist.bar.destroy()
    hist = null
    fleet = liveFleet
    trafficTracks = new TrackRegistry({ pollPeriodS: POLL_MS / 1000 })
    trafficRaw = null
    histAt = undefined
    histCardS = null
    delete ui.dataset.history
    rail.button('history').setAttribute('aria-pressed', 'false')
    card.setReplay(null)
    trafficCard.setReplay(null)
    statusPanel.setHistory(null)
    applyLayers() // the weather again, as the prefs say
    const hex = selected
    if (hex !== null) {
      selected = null // select() ignores the same hex: this one starts afresh, live (a chase stays a chase)
      select(hex)
    }
    lastUrlMs = -Infinity
  }

  /**
   * The time bar moved the replay: a jump (Go to, a day arrow: its half hours asked at once) or a scrubber seek (asked once
   * it rests SEEK_REST_MS: a drag across the day downloads nothing on its way). The map follows the clock meanwhile.
   */
  function seekHistory(t: number, jump: boolean): void {
    const h = hist
    if (h === null) return
    const p = performance.now()
    h.clock.seek(t, p)
    if (jump) jumped(h)
    else h.seekRestMs = p + SEEK_REST_MS
  }

  /**
   * History: a jump in time (Go to, a day arrow, a scrubber seek at rest, entering): its half hours asked at once (the
   * next frame asks), the last half hour's failure forgotten (its note and loader are the new time's to say), and the
   * selected aircraft brought into view.
   */
  function jumped(h: HistoryMode): void {
    h.seekRestMs = null
    h.failure.clear()
    h.askedMs = -Infinity
    h.bring = selected !== null
  }

  /**
   * History: asks for the half hours the replay needs at t (policy.ts): the one under the clock and the next one early
   * enough for the speed (prefetchMs), each for a circle wider than c (the view, or where it is going) at its slice step,
   * unless the feed holds it for c, it is being fetched, or it is blocked (missing at adsb.lol, failed a moment ago). A
   * half hour under the clock other than the last asked for starts with no failure (policy.ts SlotFailure).
   */
  function askSlots(h: HistoryMode, t: number, c: Circle): void {
    const wall = Date.now()
    const want = wantedSlots(t, h.clock.maxMs, prefetchMs(h.clock.rate))
    h.failure.asked(want[0])
    for (const s of want) {
      if (!h.feed.covers(s, c) && !h.loading.has(s) && !h.block.blocked(s, wall)) void loadSlot(h, s, { lat: c.lat, lon: c.lon, nm: askNm(c.nm, chasing) })
    }
  }

  /**
   * History, every frame: the half hours the view lacks, asked at once (askSlots), at most every ASK_EVERY_MS; not while
   * a scrubber seek rests nor while the map flies over the aircraft (it asked where it lands as it took off). In the
   * chase for where the chased aircraft will be about two minutes on (selected.ts chaseAskAt), its view's size: asked
   * before its view outruns what is loaded.
   */
  function askWhenDue(h: HistoryMode, now: number, t: number, v: Circle, ds: DayState | null): void {
    if (now - h.askedMs < ASK_EVERY_MS || h.seekRestMs !== null || now < h.flyUntilMs) return
    h.askedMs = now
    const ahead = chasing ? chaseAskAt(ds, t) : null
    askSlots(h, t, ahead === null ? v : { lat: ahead.lat, lon: ahead.lon, nm: v.nm })
  }

  /**
   * History: whether the replay waits for data at t in view v (selected.ts historyWait): the clock stalls only where
   * nothing of the half hour under it is loaded (around the view's centre; in the chase, anywhere), or for the selection's
   * first day of flights; the bar's loader turns then and while that half hour loads.
   */
  function waitFor(h: HistoryMode, t: number, v: Circle): { stall: boolean; ring: boolean } {
    const slot = slotOf(Math.min(t, h.clock.maxMs - 1))
    return historyWait({
      held: h.feed.has(slot), centre: h.feed.reaches(slot, v.lat, v.lon), chasing, missing: h.block.isMissing(slot, Date.now()),
      failing: h.failure.failing, loading: h.loading.has(slot), firstDay: firstDayAsked(selected, h.dayAsk, h.day, h.dayAgain),
    })
  }

  /** History: the half hours adsb.lol does not have, as far as known (the status's, and those it answered so here), on the bar. */
  function showMissing(h: HistoryMode): void {
    const wall = Date.now()
    for (const s of h.missing) if (!h.block.isMissing(s, wall)) h.missing.delete(s) // its block ran out: asked again by now
    const all = new Set(h.missing)
    for (const s of h.status?.slots ?? []) if (s.state === 'missing') all.add(s.slotMs)
    const slots = [...all].sort((a, b) => a - b)
    const key = slots.join()
    if (key === h.missingShown) return
    h.missingShown = key
    h.bar.setMissing(slots)
  }

  /**
   * History, every second: pruning, the selected aircraft's path from the feed until its day is known, the bar's note,
   * and every HISTORY_STATUS_MS what exists (the clock's and the bar's bounds: the oldest moment adsb.lol keeps, the
   * newest published) and what adsb.lol lacks (the bar's missing half hours). The half hours are asked from the frame.
   */
  async function historyTick(h: HistoryMode): Promise<void> {
    const nowP = performance.now()
    const wall = Date.now()
    const t = h.clock.now(nowP)
    const slot = slotOf(Math.min(t, h.clock.maxMs - 1))
    h.feed.retain(new Set([slot - SLOT_MS, slot, slot + SLOT_MS]))
    fleet.setHintS(2.5 * stepAt(h, t))
    fleet.prune(t, PRUNE_AGE_S)
    if (selected !== null && selectedDay(h, t) === null) rebuildPath() // the feed's samples until its day for t is known
    h.bar.setNote(h.block.isMissing(slot, wall) ? 'No data for this time' : h.failure.failing ? 'Could not load this time · retrying' : null)
    if (nowP - h.statusAtMs < HISTORY_STATUS_MS) return
    h.statusAtMs = nowP
    // Not awaited: the next tick does not wait for it.
    api.historyStatus().then((st) => {
      if (hist !== h) return
      h.status = st
      h.block.fromStatus(st.slots, Date.now())
      const minMs = st.oldestSlotMs
      const maxMs = st.newestSlotMs + SLOT_MS
      if (Number.isFinite(minMs) && Number.isFinite(maxMs) && minMs <= maxMs) { // a server older than the field: the guess stays
        // Every status: the clock goes to a time asked for further back than the guess once one reaches it (a jump).
        if (h.clock.setBounds(minMs, maxMs, performance.now())) jumped(h)
        h.bar.setBounds(minMs, maxMs)
      }
      showMissing(h)
    }, (e: unknown) => console.warn('FlightHopper: no history status:', e))
  }

  /** Fetches one half hour for circle c into the feed. None at adsb.lol: not asked for a while; a failure: retried soon. */
  async function loadSlot(h: HistoryMode, slot: number, c: Circle): Promise<void> {
    h.loading.add(slot)
    try {
      const r = await api.history(slot, c.lat, c.lon, c.nm)
      if (hist !== h) return
      if (r === null) {
        h.block.missing(slot, Date.now())
        h.missing.add(slot)
        h.failure.answered(slot)
        showMissing(h)
      } else if (r.slotMs === slot) {
        h.feed.add(r, c)
        h.failure.answered(slot)
        // The half hour under the clock: its aircraft before the replay time are placed at once. (The next one, asked
        // ahead of time, is taken up as the clock reaches it.)
        if (slot === slotOf(Math.min(h.clock.now(performance.now()), h.clock.maxMs - 1))) h.reload = true
      }
    } catch (e) {
      if (hist === h) {
        h.block.failed(slot, Date.now()) // the server busy or unreachable: again in a few seconds
        h.failure.failed(slot) // the bar's note, if it is the half hour under the clock
      }
      console.warn('FlightHopper: the past not loaded:', e)
    } finally {
      h.loading.delete(slot)
    }
  }

  /**
   * A row of the list: focus that aircraft and, on the map, fly over it at the same zoom (it may be off-screen). Where
   * the card and the panel do not fit side by side (flightCard.css), the list closes so the card shows.
   */
  function pickFromList(hex: string): void {
    byHand()
    exitScenario() // the list is live traffic
    select(hex)
    if (matchMedia('(max-width: 860px)').matches) rail.close()
    const e = fleet.get(hex)
    if (!chasing && e !== undefined) enterBrowse(viewer, e, { heightM: viewer.camera.positionCartographic.height })
  }

  /** The person picked an aircraft by hand (or let it go): Follow automatically waits a while (ui/alerts.ts mayAutoFollow). */
  function byHand(): void {
    handPickMs = performance.now()
  }

  /**
   * An event's aircraft, live: by hand (an event's row, toast or notification) or by itself (Follow automatically, let
   * through only when mayAutoFollow says so). History and a scenario end, a traffic card closes, and the aircraft is
   * selected; in the chase the chase moves to it, on the map the map flies over it (followTarget: the live map's position or
   * the event's, whichever is newer: the map's can be from before History). By hand, where the card and the panel do not fit
   * side by side (flightCard.css), the panel closes; by itself, an open panel stays: it never takes what the person uses.
   */
  function followEvent(e: AlertEvent, auto: boolean): void {
    if (!auto) byHand()
    exitHistory()
    exitScenario()
    traffic?.close()
    select(e.hex)
    const s = fleet.newest(e.hex)
    const entry = fleet.get(e.hex) // dead-reckoned at the last frame
    const at = followTarget(e, s === undefined ? null : { tMs: s.tMs, lat: entry?.lat ?? s.lat, lon: entry?.lon ?? s.lon })
    if (!chasing && at !== null) enterBrowse(viewer, at, { heightM: BROWSE_HEIGHT_M })
    if (!auto && matchMedia('(max-width: 860px)').matches) rail.close()
  }

  /**
   * An event in History: a minute before it opened, its aircraft selected (the panel offers it once History has it:
   * ui/alerts.ts replayableAt). History brings the selected aircraft into view whether select() changes it or not:
   * entering selects it there afresh (selectedInHistory), a seek in History is a jump (jumped), and either sets bring.
   */
  function replayEvent(e: AlertEvent): void {
    byHand()
    traffic?.close()
    enterHistory(e.openedMs - 60_000)
    select(e.hex)
    if (matchMedia('(max-width: 860px)').matches) rail.close()
  }

  /**
   * A search pick: a replay plays; a flight in view is focused as a list row is; a place leaves a scenario, the chase
   * and the focus for the top-down map over it (a country: its box fitted to the screen).
   */
  function goTo(item: SearchItem): void {
    const g = item.go
    if (g.to === 'play') return void startScenario(g.id, { play: true })
    if (g.to === 'flight') return pickFromList(g.hex)
    byHand() // a place: the person takes the map there
    exitScenario()
    traffic?.close()
    select(null)
    const c = viewer.canvas
    chaseCam.release()
    if (g.to === 'place') enterBrowse(viewer, g, { heightM: g.heightM })
    else enterBrowse(viewer, { lat: (g.south + g.north) / 2, lon: (g.west + g.east) / 2 }, { heightM: Math.max(COUNTRY_MIN_HEIGHT_M, heightToFit(g, c.clientWidth, c.clientHeight, 1.15)) })
    if (matchMedia('(max-width: 860px)').matches) rail.close() // the map, not a panel over it
  }

  /**
   * The person moving the map (history/selected.ts MapMoves): History's map does not follow its aircraft meanwhile, and a
   * jump's bring-into-view gives way to it. Caught on the window, before Cesium's handlers and the trackpad's (which stops
   * the wheel on the canvas's parent).
   */
  function mapPressed(e: PointerEvent): void {
    if (e.target !== viewer.canvas) return
    mapMovedMs = performance.now()
    moves.down(e.pointerId, mapMovedMs)
    if (hist !== null) hist.bring = false
  }
  function mapReleased(e: PointerEvent): void {
    const now = performance.now()
    if (moves.recent(now)) mapMovedMs = now // the end of a drag on the map
    moves.up(e.pointerId, now)
  }
  function mapWheeled(e: WheelEvent): void {
    if (e.target !== viewer.canvas) return
    mapMovedMs = performance.now()
    moves.wheel(mapMovedMs)
    if (hist !== null) hist.bring = false
  }
  function mapLetGo(): void {
    moves.clear(performance.now())
  }

  /** The selected aircraft in the 3-D chase view (on), or back to the top-down map over it (off). */
  function setChase(on: boolean): void {
    if (on === chasing || (on && selected === null)) return
    chasing = on
    chaseCam.release() // hands the mouse back to Cesium's controls; a chase starts behind its aircraft
    if (on) {
      browseHeightM = viewer.camera.positionCartographic.height // the map's zoom, for coming back
      exitBrowse(viewer) // restores tilt and zoom limits
      applyLayers()
      relatchPending = true
      acGround.ok = camGround.ok = false
      arrivalAgesS.length = 0 // a focus asked rarely: its arrival ages say nothing about the chase's
    } else {
      applyLayers()
      const e = selected === null ? undefined : fleet.get(selected)
      // Over the aircraft (else where the camera is), at the zoom the map had before the chase (a chased reload: the default).
      enterBrowse(viewer, chased ?? (e === undefined ? null : e), { heightM: browseHeightM ?? undefined })
    }
    sun.setEnabled(on && prefs.light) // chase only (D9): browse stays the unlit street map
    if (!on) flightFrame.edit(false)
    ui.dataset.mode = on ? 'chase' : 'browse'
    // The TV: the 3-D view clear of panels (a remote cannot push one aside), the focus on its camera views.
    if (on && presets !== null) {
      rail.close()
      presets.focus()
    }
  }

  /** Every scene-toggle change, from a button or a key: apply it, store it, show it. */
  function setPrefs(next: ScenePrefs): void {
    if (next.topo !== prefs.topo) topo.set(next.topo, performance.now(), relHFor(chased, groundM, topo.relHM, airports))
    prefs = next
    sun.setEnabled(chasing && next.light)
    buildings.setGlass(next.glass)
    applyLayers()
    writeScenePrefs(next, store)
    toggles.update(next)
    settings.setDark(next.dark)
  }

  /**
   * Fetches a scenario and plays it in the chase view: from the panel (play), or from the URL at load (paused at t,
   * with the orbit of ?cam=). A failed load leaves the app as it was.
   * ponytail: a failed load only reaches the console (the packages ship with the app and a test validates them).
   */
  async function startScenario(id: string, o: { t?: number; play?: boolean; cam?: Orbit | null; fromUrl?: boolean } = {}): Promise<void> {
    loadingScenario = id
    let scn: Scenario
    let recLivery: Livery | null = null // a recording flies in its airline's livery (or grey, military), as live
    const file = recordingFile(id)
    // A package may carry its airfields as they were (airport.json: one airport, or a list of them: runways, flat rings);
    // most have none (404). A recording flew today's.
    const field = file !== null ? Promise.resolve(null) : getJson<AirfieldAirport | AirfieldAirport[]>(`${scenarioBase}scenarios/${id}/airport.json`).catch(() => null)
    try {
      if (file !== null) {
        const rec = await api.recording(file)
        const m = pick?.for(rec.info.typeCode, rec.info.category) ?? null
        const built = recordingScenario(rec, m?.id ?? '')
        if (built === null) throw new Error('too short to replay')
        scn = built
        recLivery = liveryOf(liveryCode(rec.info.callsign, rec.info.reg, rec.info.military))
      } else scn = await loadScenario(scenarioBase, id)
    } catch (e) {
      console.error(`FlightHopper: scenario "${id}" not loaded:`, e)
      if (loadingScenario === id) loadingScenario = null
      return
    }
    const got = await field // fetched alongside the package: settled by now
    const aps = got === null ? [] : Array.isArray(got) ? got : [got]
    if (stopped || loadingScenario !== id) return // stopped, or Esc while it loaded
    loadingScenario = null
    exitHistory() // a scenario takes the screen
    if (run !== null) endRun()
    if (!chasing) {
      browseHeightM = o.fromUrl ? null : viewer.camera.positionCartographic.height // the map's zoom, for coming back
      exitBrowse(viewer)
    }
    chasing = false // no flight back to the map: the scenario takes the camera at once
    select(null)
    viewer.camera.cancelFlight()
    chaseCam.release() // the first frame puts the camera behind the aircraft
    if (o.cam) chaseCam.orbit.set(o.cam.headingDeg, o.cam.pitchDeg, o.cam.rangeM)
    chasing = true
    applyLayers()
    relatchPending = true
    chased = null
    groundM = null
    acGround.ok = camGround.ok = false
    const e = pick?.models.find((m) => m.id === scn.aircraft.model) ?? null
    // A package without its own colours flies its callsign's airline livery, as a recording and a live flight do.
    const livery = scn.aircraft.livery ? liveryFromSpec(`scenario:${scn.id}`, scn.aircraft.livery, scn.base, scn.present)
      : recLivery ?? (scn.aircraft.callsign ? liveryOf(liveryCode(scn.aircraft.callsign, scn.aircraft.registration || null)) : null)
    liveGear = null
    dress = new Dresser(e, livery, scn.aircraft.shape?.halfSpanM ?? null)
    run = ScenarioRun.start({ viewer, ui, scenario: scn, t: o.t, play: o.play, under: night, onExit: exitScenario })
    if (aps.length > 0) {
      airfield = addRunways(viewer, aps, { markers: false }) // a replay's airfields: no live-map threshold dots
      viewer.terrainProvider = new FlatTerrainProvider(baseTerrain, [...heroStrips, ...stripsFor(aps)], areasFor(aps))
    }
    sun.setEnabled(prefs.light)
    ui.dataset.mode = 'chase'
    ui.dataset.scenario = scn.id
    scenarioPanel.setPlaying(scn.id)
    rail.close()
    if (!firstData) {
      firstData = true
      hooks.onFirstData?.()
    }
  }

  /** The scenario's own parts go (its overlays, imagery, keys; the model's scenario look); the view stays. */
  function endRun(): void {
    run?.destroy()
    run = null
    if (airfield !== null) {
      airfield.destroy()
      airfield = null
      viewer.terrainProvider = new FlatTerrainProvider(baseTerrain, heroStrips, [])
    }
    dress = null
    if (model) Dresser.undress(model)
    delete ui.dataset.scenario
    scenarioPanel.setPlaying(null)
  }

  /** Esc, the play bar's exit or the ending's Close: back to the top-down map over the aircraft, live data again. */
  function exitScenario(): void {
    loadingScenario = null // one still loading is dropped when it arrives
    if (run === null) return
    endRun()
    chasing = false
    chaseCam.release()
    applyLayers()
    enterBrowse(viewer, chased, { heightM: browseHeightM ?? undefined })
    chased = null
    groundM = null
    sun.setEnabled(false)
    flightFrame.edit(false)
    ui.dataset.mode = 'browse'
    lastUrlMs = -Infinity // the address bar drops the scenario at once
  }

  function frame(): void {
    const now = performance.now()
    tf = topo.update(now) // first: the factor and plane drawn this frame, before any terrain reading
    const dtS = lastFrameMs === null ? 0 : Math.min(1, (now - lastFrameMs) / 1000)
    lastFrameMs = now
    presets?.update(now, chasing) // the TV's preset glide or tour: the orbit before the chase camera reads it
    const shown = statusShown(status, failedPolls)
    let all = NO_ENTRIES
    let s: RenderState | null = null
    let tSunMs = Date.now() // until the first reply; then the render time (server clock)
    let histLoading = false // History: the data of its time loads (the bar's loader; the clock may wait for it)
    let viewRect: RectDeg | null | undefined // History: the view as this frame sees it (undefined: not read)
    // A scenario: its aircraft at its clock's time, lit at that instant; no traffic around it.
    const sf = run?.frame(dtS) ?? null
    if (sf !== null) s = sf.state
    else if (hist !== null) {
      // History: everything at the replay clock's time with no render delay (the selected aircraft's track has its
      // samples ahead of it), lit at that instant. A playing clock holds (stalls) only while nothing of its time is loaded
      // where the view is (waitFor); a view partly out of what is loaded is asked for and plays on.
      const h = hist
      if (h.clock.atEnd(now)) h.clock.pause(now) // the newest published moment: there is no further
      if (h.seekRestMs !== null && now >= h.seekRestMs) jumped(h) // a scrubber seek at rest
      viewRect = viewRectangleDeg(viewer) // once a frame: the wait, the asks and the list read it
      const v = viewCircle(viewRect)
      const wait = waitFor(h, h.clock.now(now), v)
      histLoading = wait.ring
      h.clock.stall(wait.stall, now)
      const t = h.clock.now(now)
      askDayWhenDue(h, t)
      // The selected aircraft at t as its day says (history/aircraftDay.ts); null until its day is known: as the feed has it.
      const day = selectedDay(h, t)
      const ds = day === null ? null : dayState(day.legs, t)
      feedHistory(h, t, ds)
      tSunMs = t
      all = fleet.entries(t)
      if (selected !== null) {
        const track = registry.get(selected)
        let ts = track?.stateAt(t) ?? null
        const first = track?.oldestTMs ?? null
        if (ts === null && track !== undefined && first !== null && t < first) ts = track.stateAt(first)
        chaseInfo = day === null ? null : selectedInfo(day, ds, t, h.feed.info(selected), chaseInfo)
        histAt = placeSelected(all, selected, ds, t, ts, chaseInfo, histAll, histOwn)
        all = histAll
        if (ds === null || ds.kind === 'heard') {
          s = ts
          histCardS = ts
        } else {
          // No track. A chase that is on flies the estimate through a hole of its leg, else stays where it was (as live's
          // "Signal lost"); Esc leaves it.
          s = !chasing ? null : ds.kind === 'gap' && histAt !== undefined ? estimateState(histAt) : chased
          // Its last known numbers, or in a hole of its leg the estimate's (both dimmed: the card says not heard).
          histCardS = (ds.kind === 'quiet' || ds.kind === 'gap') && histAt !== undefined ? entryState(histAt) : null
        }
      } else {
        histAt = undefined
        histCardS = null
      }
      showSelectedDay(h, day, ds)
      h.bar.update({ tMs: t, playing: h.clock.playing, rate: h.clock.rate, loading: histLoading })
      const quietS = Math.max(60, 2.5 * stepAt(h, t)) // a coarse file's aircraft is heard once a slice
      card.setReplay(replayStatus(ds, t, quietS))
      trafficCard.setReplay(replayStatus(null, t, quietS))
      statusPanel.setHistory({ loading: histLoading })
      keepInView(h, now, t, day, ds, v)
      askWhenDue(h, now, t, v, ds) // after keepInView: a flight it starts asks where it lands
    } else if (api.ready) {
      const tServerMs = api.serverNowMs()
      const tRenderMs = clock.tick(tServerMs, delayTargetS(), dtS)
      tSunMs = tRenderMs
      // Chasing, the fleet is drawn at the chased aircraft's (delayed) render time, so the traffic around it is where
      // it was at that moment (dead-reckoned back from newer samples); browse draws it at server now.
      // ponytail: dead reckoning, not interpolation between samples: a turning aircraft is off by its turn. Upgrade:
      // keep two samples per hex in Fleet.
      all = fleet.entries(chasing ? tRenderMs : tServerMs)
      if (chasing) trafficTracks.applyTo(all, tRenderMs)
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
    if (sf === null) { // a scenario leaves the list as it was
      const inView = entriesIn(all, viewRect === undefined ? viewRectangleDeg(viewer) : viewRect, onScreen, selected)
      const anyData = status !== NO_STATUS || hist !== null
      table.update(all, inView, selected, anyData) // refreshes every 10 s itself
      if (now - lastBadgeMs > 1000) {
        lastBadgeMs = now
        rail.setBadge('aircraft', anyData ? compactCount(inView.length) : null)
      }
    }
    if (!firstData && status !== NO_STATUS) {
      firstData = true
      hooks.onFirstData?.()
    }
    measure?.('fh:table', tTable)
    let clearanceM: number | null = null
    let framed = false
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
      if (sf !== null) {
        // A recording has no gear events: the gear as a crew would have it, from the height over the ground drawn, as live.
        const byHeight = run?.scenario.gearFromHeight === true
        const aglFt = groundM === null ? null : (s.hM - groundM) / FT
        const gear = byHeight ? gearWanted(sf.jumped ? null : liveGear, { onGround: placed.onGround, aglFt, vsFpm: placed.vsFpm, gsKt: placed.gsKt }) : sf.event.gear
        if (model !== null && dress?.apply(model, damageOf(sf.event.damage), gear)) sun.attachModel(model.model)
        if (sf.jumped || (byHeight && liveGear === null)) model?.snapGear(gear) // a seek or a first look: as it was then, not swinging there
        liveGear = byHeight ? gear : null
      } else {
        const ci = chaseInfo ?? (selected === null ? null : fleet.get(selected)?.info) ?? null
        if (model !== null && pick !== null && model.use(pick.for(ci?.typeCode ?? null, ci?.category ?? null))) sun.attachModel(model.model)
        model?.paint(liveryCode(ci?.callsign ?? null, ci?.reg ?? null, ci?.military))
        // The gear as a crew would have it (gear.ts), from the height over the ground drawn under the aircraft.
        const want = gearWanted(liveGear, { onGround: placed.onGround, aglFt: groundM === null ? null : (s.hM - groundM) / FT, vsFpm: placed.vsFpm, gsKt: placed.gsKt })
        if (liveGear === null) model?.snapGear(want)
        else model?.setGear(want)
        liveGear = want
      }
      model?.update(placed, dtS)
      if (model !== null) lights.forChase(model.model, model.entry, placed, sf?.event.damage.has('fin') ?? false)
      if (sf?.jumped) chaseCam.snapHeading() // a seek: behind the aircraft at once, not a swing round to it
      // The camera orbits the aircraft's middle, not its wheels: at any range it keeps its place on screen, and so do the
      // frame's cards round it.
      const aim = model === null ? undefined : boxCentre(model.model.modelMatrix, model.entry, aimAt)
      clearanceM = chaseCam.update(placed, dtS, aim).clearanceM
      sunWC = Cartesian3.fromDegrees(placed.lon, placed.lat, placed.hM, Ellipsoid.WGS84, sunAt) // the chased aircraft
      // After the camera, so the brackets match this frame; sunWC gives the distances under them. Their labels keep off
      // the chased aircraft's flight ID (as drawn last frame).
      if (traffic !== null) traffic.keepOff = flightFrame.idRect
      traffic?.update(fleetLayer, model?.model.imageBasedLighting.imageBasedLightingFactor, dtS, sunWC)
      traffic?.forEachDrawn(lights.forTraffic)
      if (model !== null) {
        // The flight-data frame, after the camera (it projects the model). Height above the ground only over the true
        // relief: flattened or growing, the ground drawn is not the ground.
        const aglFt = groundM === null || !prefs.topo || topo.animating ? null : Math.max(0, placed.hM - groundM) / FT
        const data = sf !== null ? { ...sf.data, aglFt } : liveFlightData(placed, chaseRaw, aglFt, model.gearPos >= 1 ? 'down' : 'up')
        // Its flight ID over its brackets, as over the traffic's: the callsign, else the hex (a scenario has its own).
        const id = placed.callsign ?? (sf === null ? placed.hex.toUpperCase() : '')
        flightFrame.update(viewer, model.model, model.entry, data, frameRoom(now), sf?.t, id)
        framed = true
      }
      chased = placed
    }
    if (!framed) flightFrame.draw(null, null, NO_ROOM) // hidden: no chased state (or no model)
    // No cards drawn, nothing to arrange: the layout button waits (editing, it stays on, to end the mode).
    const noCards = !framed && !flightFrame.editing
    if (layoutBtn.disabled !== noCards) layoutBtn.disabled = noCards
    // Every frame, in both modes (off, it keeps the fixed light above the camera). Replays are lit at their recording
    // time (D12): the server reports how far its clock is ahead of the upstream's. A scenario, at its own instant.
    const st = sun.update(sf !== null ? sf.tUtcMs : hist !== null ? tSunMs : sunTimeMs(tSunMs, sunParam, status.upstreamOffsetMs ?? 0), sunWC)
    buildings.setNight(chasing && prefs.light && st !== null ? st.night : 0) // the Sun's night, not the moon's
    lights.endFrame(chasing && prefs.light && st !== null ? st.night : 0, now) // the aircraft this frame gave it
    runways.update(tf)
    airfield?.update(tf)
    buildings.update(chasing && sf === null ? chased : null, tf) // around the chased aircraft; hidden in browse and scenarios
    // The planes darken with the terrain under the Sun (WP-E3); off (browse, the toggle off) they stay as built. Three
    // numbers written in place, so it runs every frame.
    runways.setLight(chasing && prefs.light && st !== null ? st : null) // the light as set: the Moon's too
    airfield?.setLight(chasing && prefs.light && st !== null ? st : null)
    // No state (before the first samples, pruned, or a gap > 2 min): the model goes; the camera stays put.
    if (model) model.show = chasing && s !== null
    toggles.setBusy(topo.animating)
    toggles.setChasing(chasing)
    // The panel shows as soon as something is known: identity from the fleet before the chase reply and first state. In
    // History its numbers are its state at the replay time as its day says (none before its first leg, or that day).
    card.update(selected, hist !== null ? histCardS : s, chaseRaw, chaseInfo ?? (selected === null ? null : (fleet.get(selected)?.info ?? null)), shown, chasing) // ≤ 4 Hz
    const th = traffic?.openHex ?? null // open only while chasing (Traffic.select closes it otherwise)
    const te = th === null ? undefined : fleet.get(th)
    const dist = traffic?.openDistM ?? null
    const from = chaseInfo?.callsign ?? s?.callsign ?? selected?.toUpperCase() ?? ''
    trafficCard.update(te === undefined ? null : th, te === undefined ? null : entryState(te), trafficRaw, te?.info ?? null, shown, false,
      dist === null ? null : { distM: dist, from })
    if (trafficClick !== null) {
      // Clear of the clicked aircraft and of the flight-data frame, which does not make way for it.
      const c = viewer.canvas.getBoundingClientRect()
      const frame = flightFrame.occupied().map((r) => ({ ...r, x: c.left + r.x, y: c.top + r.y }))
      trafficCard.keepClear(c.left + trafficClick.x, c.top + trafficClick.y, TRAFFIC_CLEAR_PX, frame)
      trafficClick = null
    }
    // Live-feed trouble says nothing about a scenario; before the first answer the splash speaks for it.
    const kind = outageFor({ online: navigator.onLine, failedPolls, degraded: status === NO_STATUS ? null : status.degraded, inScenario: sf !== null || hist !== null })
    outage.update(kind, sourceName(status === NO_STATUS ? 'adsbfi' : status.source), lastOkMs, Date.now())
    const known = status === NO_STATUS ? null : shown
    statusPanel.update(known, api.ready ? api.serverNowMs() : null)
    rail.setDot('aircraft', statusDot(known))
    // In trouble no answers come; in a scenario none are asked for.
    rail.setBusy('aircraft', sf === null && hist === null && (known === null || (known.degraded === null && (known.pendingAreas ?? 0) > 0)))
    rail.setBusy('history', hist !== null && histLoading)
    // In trouble too (they are still not loaded), but none shown as loading: no answer is coming.
    pendingLayer.update(hist === null ? status.pendingBoxes : undefined, !chasing, known !== null && known.degraded === null)
    // Top-down only: the chase has its own view of where it goes. In History the path is cut at the replay time, and it
    // joins the aircraft as drawn (none before its first leg, or that day: no line).
    const at = chasing || sf !== null || selected === null ? undefined : hist !== null ? histAt : fleet.get(selected)
    // The lead-in from the origin and its "First heard" only with the whole leg (the trace): live samples alone start at
    // the selection, not at the first reception. Live only: the past's day of flights knows no route.
    const wholeLeg = hist === null && selTrace !== null
    routeLine.update(at === undefined ? null : at, selPath, hist === null ? chaseDest : null, wholeLeg ? chaseOrigin : null, hist === null ? Infinity : tSunMs)
    if (!chasing && now - scaleAtMs > 200) {
      scaleAtMs = now
      mapKey.setScale(groundScale())
    }
    syncUrl(now)
    bench?.frame(s, clearanceM)
    measure?.('fh:frame', now)
  }
  const removeFrame = viewer.scene.preUpdate.addEventListener(frame)

  /** The canvas's safe area (safeArea) and what covers it (CSS px from its top-left): the elements the selectors find, in turn, as laid out now. */
  function measureRoom(...selectors: string[]): Room {
    const c = viewer.canvas.getBoundingClientRect()
    const covers = selectors.flatMap((s) => [...ui.querySelectorAll(s)]).map((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height }
    })
    return { safe: safeArea(c.width, c.height, covers), covers }
  }

  /** The flight-data frame's safe area (safeArea) and its covers: re-measured at most every SAFE_EVERY_MS, as it reads the layout. */
  function frameRoom(now: number): Room {
    if (now - safeAtMs < SAFE_EVERY_MS) return room
    safeAtMs = now
    return (room = measureRoom(FRAME_COVERS))
  }

  /** History's top-down map: the part of the canvas no overlay covers (safeArea over MAP_COVERS, the key last), re-measured as often as the frame's. */
  function mapClear(now: number): Rect {
    if (now - mapSafeAtMs < SAFE_EVERY_MS) return mapSafe
    mapSafeAtMs = now
    return (mapSafe = measureRoom(MAP_COVERS, MAP_KEY_COVER).safe)
  }

  /** Centre and radius of the view poll: browse, around the visible map; else the chased aircraft, else the globe point at the canvas centre, else below the camera. */
  function viewCircle(rect?: RectDeg | null): { lat: number; lon: number; nm: number } {
    if (!chasing) {
      const r = rect === undefined ? viewRectangleDeg(viewer) : rect
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

  /**
   * A poll's status: the events again when the server says they changed (its alertsRev), or its alerts came or went. The
   * panel asks (one request at a time) and asks by itself as it opens and in a hidden tab (ui/alerts.ts).
   */
  function noteAlertsRev(): void {
    if (status.alertsRev === alertsRev) return
    alertsRev = status.alertsRev
    alertsUi.refresh()
  }

  async function poll(): Promise<void> {
    const hex = selected
    const v = viewCircle()
    const noChase: Promise<ChaseResponse | null> = Promise.resolve(null)
    // Chased, or focused and on screen: every poll, so the server refreshes it at its chase period (the fastest its
    // budget allows) whatever the zoom: the view circle holding it, or hex requests while the view is grid cells.
    // Focused off screen: every FOCUS_ASK_MS, for the card's details and a hex request or two upstream.
    const nowMs = performance.now()
    const at = hex === null || chasing ? undefined : fleet.get(hex)
    const onScreen = at !== undefined && distanceNm(v.lat, v.lon, at.lat, at.lon) <= v.nm
    const ask = hex !== null && (chasing || onScreen || nowMs - lastFocusAskMs >= FOCUS_ASK_MS)
    if (ask && !chasing) lastFocusAskMs = nowMs
    // The open traffic card's aircraft, as a focused one: at once, then every FOCUS_ASK_MS. Within 10 nm of the chased
    // aircraft it is inside the view circle, so the server asks upstream nothing more for it.
    const th = traffic?.openHex ?? null
    const askTraffic = th !== null && (trafficAsked?.hex !== th || nowMs - trafficAsked.ms >= FOCUS_ASK_MS)
    if (askTraffic) trafficAsked = { hex: th, ms: nowMs }
    const [view, chase, trafficChase] = await Promise.allSettled([
      api.view(v.lat, v.lon, v.nm), ask ? api.chase(hex) : noChase, askTraffic ? api.chase(th) : noChase,
    ])
    if (stopped || hist !== null) return // History began meanwhile: live answers are not its
    const t0 = measure === null ? 0 : performance.now()
    const current = hex !== null && hex === selected // a reply for an earlier selection only feeds the fleet
    let ok = false
    const mine: Sample[] = [] // this poll's samples of the selected aircraft, from both replies
    if (view.status === 'fulfilled') {
      const r = view.value
      fleet.ingest(r.samples, r.info)
      if (current) for (const x of r.samples) if (x.hex === hex) mine.push(x)
      if (chasing && chased !== null) trafficTracks.ingestNear(r.samples, chased.lat, chased.lon, TRAFFIC_TRACK_NM, hex)
      else if (!chasing) trafficTracks = new TrackRegistry({ pollPeriodS: POLL_MS / 1000 })
      status = r.status
      noteAlertsRev()
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
        if (r.dest !== undefined) chaseDest = r.dest
        // The route's origin is the trace's leg's only while that leg flies now under the route's callsign (a parked
        // aircraft's trace is its last leg; its callsign may already name the next flight).
        const tr = selTrace
        if (r.origin && tr !== null && tr.callsign !== null && tr.callsign === (r.info?.callsign ?? chaseInfo?.callsign)
          && tr.t0Ms + (tr.t.at(-1) ?? 0) * 1000 >= r.serverNowMs - 10 * 60_000) chaseOrigin = r.origin
        card.setRecording(hex!, r.rec, r.serverNowMs)
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
      noteAlertsRev()
      ok = true
    }
    if (trafficChase.status === 'fulfilled' && trafficChase.value !== null) {
      const r = trafficChase.value
      fleet.ingest(r.samples, r.info ? [r.info] : undefined)
      if (th === (traffic?.openHex ?? null)) trafficRaw = r.raw ?? null // a reply for the card's last aircraft only feeds the fleet
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
    if (current) {
      // ponytail: the newest 5,000 positions (hours at the rates a focus gets); older ones fall off the line's start.
      const had = trailTMs
      for (const x of [...mine].sort((a, b) => a.tMs - b.tMs)) {
        if (x.tMs <= trailTMs) continue
        trailTMs = x.tMs
        trail.push(pathPointOf(x))
      }
      if (trail.length > 5000) trail.splice(0, trail.length - 5000)
      if (trailTMs !== had) rebuildPath()
    }
    measure?.('fh:ingest', t0)
    // An aircraft may go 2.5 expected refreshes of this view without a sample before it is hidden (at least 60 s).
    fleet.setHintS(2.5 * (status.viewEveryS ?? 0))
    if (ok) {
      failedPolls = 0
      lastOkMs = Date.now()
    }
    else if (failedPolls++ === 0) console.warn('FlightHopper: poll failed:', (view as PromiseRejectedResult).reason)
    if (api.ready) {
      const t = api.serverNowMs()
      fleet.prune(t, PRUNE_AGE_S)
      trafficTracks.prune(t, TRAFFIC_TRACK_KEEP_S)
      // The chased aircraft is never pruned: on a lost signal it stays frozen at its last position under "Signal lost
      // Ns ago" (the track goes stale 8 s past its newest sample) until data returns or Esc. Pruning it made the model,
      // HUD and banner vanish with no word. The registry holds only this aircraft and is replaced on each selection.
    }
  }

  alertsUi.refresh() // the panel's first answer: the switch, and the week's events counted on the bell

  void (async () => {
    while (!stopped) {
      const t0 = performance.now()
      // A hidden tab asks for nothing: the server's interest in its view lapses 15 s later and it stops polling upstream.
      // A scenario (playing or loading) needs no live data either.
      if (document.hidden || run !== null || loadingScenario !== null) {
        await sleep(POLL_MS)
        continue
      }
      if (hist !== null) { // History asks the past, not live
        await historyTick(hist).catch((e: unknown) => console.error('FlightHopper: history tick crashed:', e))
        await sleep(Math.max(0, POLL_MS - (performance.now() - t0)))
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
  /**
   * A chase traffic model's bracket square at p (CSS px on the canvas) opens its card (in place of another: one at most)
   * and closes a panel, which would cover it. False when no square is there. Not while the frame's cards are arranged.
   */
  const openTrafficAt = (p: Cartesian2): boolean => {
    const hit = traffic === null || flightFrame.editing ? null : traffic.hitAt(p.x, p.y)
    if (hit === null) return false
    if (hit !== traffic!.openHex) trafficRaw = null // the last aircraft's object, until this one's arrives
    traffic!.open(hit)
    rail.close()
    trafficClick = Cartesian2.clone(p)
    return true
  }
  mouse.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
    // Chase traffic first (openTrafficAt); a click anywhere else closes an open one, and does nothing more.
    if (openTrafficAt(e.position)) return
    if (!flightFrame.editing && traffic?.close()) return
    const hex = fleetLayer.pick(e.position, tapPx)
    // A runway end spells itself out (a tap on a phone, where nothing hovers) until the next click elsewhere.
    const onRunway = runways.hover(hex === null ? e.position : null, tapPx)
    if (hex !== null) {
      byHand()
      select(hex)
    } else if (!onRunway && !chasing && selected !== null) {
      byHand()
      select(null) // a click on the empty map clears the focus
    }
  }, ScreenSpaceEventType.LEFT_CLICK)
  // Hover over an icon: its callsign label and a pointer cursor; over a traffic bracket, the pointer; over a runway end's
  // arrow or number, its words (runways.hover) and the pointer. Picks at most every HOVER_PICK_MS, at the newest position.
  const mousePos = new Cartesian2()
  let hoverTimer: ReturnType<typeof setTimeout> | null = null
  let lastPickMs = -Infinity
  const pickHover = (): void => {
    hoverTimer = null
    lastPickMs = performance.now()
    mapHover = fleetLayer.pick(mousePos)
    const bracket = flightFrame.editing ? null : (traffic?.hitAt(mousePos.x, mousePos.y) ?? null)
    const onRunway = runways.hover(mapHover === null && bracket === null ? mousePos : null)
    viewer.canvas.style.cursor = mapHover === null && bracket === null && !onRunway ? '' : 'pointer'
  }
  mouse.setInputAction((m: ScreenSpaceEventHandler.MotionEvent) => {
    Cartesian2.clone(m.endPosition, mousePos)
    hoverTimer ??= setTimeout(pickHover, Math.max(0, lastPickMs + HOVER_PICK_MS - performance.now()))
  }, ScreenSpaceEventType.MOUSE_MOVE)
  const onLeave = (): void => {
    if (hoverTimer !== null) clearTimeout(hoverTimer)
    hoverTimer = null
    mapHover = null
    runways.hover(null)
    viewer.canvas.style.cursor = ''
  }
  viewer.canvas.addEventListener('pointerleave', onLeave) // onto the table or panel, or out of the window
  window.addEventListener('pointerdown', mapPressed, true)
  window.addEventListener('pointerup', mapReleased, true)
  window.addEventListener('pointercancel', mapReleased, true)
  window.addEventListener('wheel', mapWheeled, { capture: true, passive: true })
  window.addEventListener('blur', mapLetGo)
  /**
   * Esc (and the TV remote's Back) steps back one level: an open panel, then a traffic card, edit mode, then a scenario
   * or the chase (to the map), then the focus. (The Settings dialog keeps every key while open: Esc closes it alone.)
   */
  const back = (): void => {
    if (hist?.bar.closeGoTo() || rail.close() || traffic?.close()) return
    if (flightFrame.editing) flightFrame.edit(false)
    else if (run !== null || loadingScenario !== null) exitScenario()
    else if (chasing) {
      byHand()
      setChase(false)
    } else if (selected !== null || hist === null) {
      byHand()
      select(null)
    } else exitHistory() // nothing else open: History closes too
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') back()
    else if (e.key === ' ' && hist !== null && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target instanceof HTMLInputElement
      || e.target instanceof HTMLButtonElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) {
      e.preventDefault() // Space plays and pauses the replay (as a scenario's)
      hist.clock.toggle(performance.now())
    }
    else if ((e.key === 'b' || e.key === 'B') && bench) bench.download()
    else {
      // T, L, X: they apply in the chase view (D9, D11), and can be set beforehand. M: map or satellite, for the view on
      // screen. R: roads, P: borders and places, each over the satellite. W: weather.
      const k = sceneKey(e)
      const key = k === 'base' ? (run === null ? baseKey(chasing) : null) : k // in a scenario M mutes (run.ts)
      if (key !== null) setPrefs({ ...prefs, [key]: !prefs[key] })
    }
  }
  window.addEventListener('keydown', onKey)
  // ?tv=1: the TV remote drives it all (ui/remote.ts): its map mode moves the camera as a mouse would (the map by
  // browseDrag and browsePinch round the centre, the chase by its orbit), and its OK picks at the crosshair as a click
  // there would: a traffic bracket, else an aircraft (not the one already selected: then OK zooms in).
  const remote = tv ? mountRemote(ui, {
    chasing: () => chasing,
    move: (m, dtS) => {
      const c = viewer.canvas
      const s = cameraStep(m, dtS, c.clientWidth, c.clientHeight, chasing)
      const o = chaseCam.orbit
      if (chasing) {
        presets?.cancel() // a camera key ends a preset's glide and the Auto tour
        o.set(o.headingOffsetDeg + s.headingDeg, o.pitchDeg + s.pitchDeg, o.rangeM / s.zoom)
        return
      }
      if (s.zoom !== 1) browsePinch(viewer, s.zoom, c.clientWidth / 2, c.clientHeight / 2)
      else browseDrag(viewer, -s.dx, -s.dy) // the map follows a drag: the view goes the other way
      mapMovedMs = performance.now()
      moves.wheel(mapMovedMs) // the person moves the map (History does not follow its aircraft meanwhile)
      if (hist !== null) hist.bring = false
    },
    pick: () => {
      const at = new Cartesian2(viewer.canvas.clientWidth / 2, viewer.canvas.clientHeight / 2)
      if (openTrafficAt(at)) return true
      const hex = fleetLayer.pick(at, PICK_PX)
      if (hex === null || hex === selected) return false
      byHand()
      select(hex)
      return true
    },
    back,
  }) : null
  const urlHist = readHist(location.search) // ?hist=<unix s>: History at that time, paused
  if (urlScenario !== null) void startScenario(urlScenario.id, { t: urlScenario.t ?? undefined, cam: urlView.cam, fromUrl: true })
  else if (urlHist !== null) enterHistory(urlHist) // fetches the selected aircraft's leg itself
  else if (selected !== null) fetchTrace(selected) // ?hex= selects without select(): its flown path all the same

  return {
    stop(): void {
      if (stopped) return
      stopped = true
      removeFrame()
      window.removeEventListener('keydown', onKey)
      remote?.destroy()
      presets?.destroy()
      viewer.canvas.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('pointerdown', mapPressed, true)
      window.removeEventListener('pointerup', mapReleased, true)
      window.removeEventListener('pointercancel', mapReleased, true)
      window.removeEventListener('wheel', mapWheeled, true)
      window.removeEventListener('blur', mapLetGo)
      if (hoverTimer !== null) clearTimeout(hoverTimer)
      mouse.destroy()
      bench?.destroy()
      document.removeEventListener('fullscreenchange', onFullscreen)
      run?.destroy()
      hist?.bar.destroy()
      flightFrame.destroy()
      frameLayer.remove()
      scenarioPanel.destroy()
      alertsUi.destroy()
      searchBox.destroy()
      toggles.destroy()
      outage.destroy()
      card.destroy()
      trafficCard.destroy()
      settings.destroy()
      table.destroy()
      mapKey.destroy()
      rail.destroy()
      ui.remove()
      chaseCam.release()
      exitBrowse(viewer)
      model?.destroy()
      traffic?.destroy()
      lights.destroy()
      fleetLayer.destroy()
      pendingLayer.destroy()
      routeLine.destroy()
      map.destroy()
      roads.destroy()
      places.destroy()
      weather.destroy()
      viewer.imageryLayers.remove(night) // and destroys it
      runways.destroy()
      airfield?.destroy()
      buildings.destroy()
      viewer.destroy()
      delete (window as unknown as { viewer?: Viewer }).viewer
    },
  }
}

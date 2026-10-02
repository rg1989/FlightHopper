// client/history/selected.ts
// The selected aircraft in History (design D2), as app.ts draws and words it at a replay time t, from its day of flights
// (aircraftDay.ts): the entry the map draws for it (its track's state while heard, a faded ghost where it was last heard
// while quiet, the same moving along a hole of its leg where it is estimated to be, none before its first flight or on a
// day it did not fly; until its day is known, the fleet's own), what it is called then, the card's status line, the span
// of its day asked for, and when the map brings it into view or follows it. Pure: the app owns the camera, the clock and
// the requests.
import type { TraceReply } from '../../shared/api.ts'
import { bearingDeg, destination, distanceNm } from '../../shared/geo.ts'
import type { AircraftInfo } from '../../shared/info.ts'
import type { RectDeg } from '../scene/browseCamera.ts'
import type { FleetEntry, RenderState } from '../types.ts'
import type { ReplayStatus } from '../ui/flightCard.ts'
import { callsignAt, legEndMs, pointsUpTo, type DayState } from './aircraftDay.ts'
import { heightM, traceInfo } from './trace.ts'

const BEFORE_MS = 12 * 3_600_000 // a day is asked with this much before it: where the aircraft stood when it began
const VIEW_INSET = 0.1 // an aircraft within this share of the view's height or width from an edge is out of view
const MOVED_MS = 1500 // the map does not follow an aircraft while the person moves it, nor this long after
// ponytail: English weekdays, as the time bar's day labels (bar.ts). Upgrade: Intl when the UI is translated.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const pad2 = (n: number): string => String(n).padStart(2, '0')
const hhmm = (d: Date): string => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`

/**
 * The span asked for the selected aircraft's day (GET /api/trace?hex&from&to): the time bar's local day with the 12 h
 * before it, never before the oldest moment adsb.lol keeps (null: not known yet; the server raises it then) nor after
 * now (the server answers a span outside those with a 400).
 */
export function daySpan(dayStartMs: number, dayEndMs: number, oldestMs: number | null, nowMs: number): { fromMs: number; toMs: number } {
  return { fromMs: Math.max(dayStartMs - BEFORE_MS, oldestMs ?? -Infinity), toMs: Math.min(dayEndMs, nowMs) }
}

/** ms on the local clock, 'HH:MM' as the time bar's (localClock); its weekday first when it is on another day than t. */
export function atClock(ms: number, t: number): string {
  const a = new Date(ms)
  const b = new Date(t)
  const sameDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  return sameDay ? hhmm(a) : `${WEEKDAYS[a.getDay()]} ${hhmm(a)}`
}

/**
 * The card's status line at t (flightCard.ts setReplay). Heard, or its day not known yet: the replay's clock, and the
 * files' quiet rule for a sample (quietS). Quiet: since when it was not heard ("On the ground since" when its leg ended
 * there); so in a hole of its leg (its numbers there are the estimate's). Before its first leg: until when. No leg that
 * day: that.
 */
export function replayStatus(ds: DayState | null, t: number, quietS: number): ReplayStatus {
  if (ds === null || ds.kind === 'heard') return { text: `Replay · ${hhmm(new Date(t))}`, state: 'replay', quietS }
  if (ds.kind === 'gap') return { text: `Last heard ${atClock(ds.sinceMs, t)}`, state: 'quiet' }
  if (ds.kind === 'quiet') return { text: `${ds.ground ? 'On the ground' : 'Not heard'} since ${atClock(ds.sinceMs, t)}`, state: 'quiet' }
  if (ds.kind === 'before') return { text: `Not heard until ${atClock(ds.untilMs, t)}`, state: 'none' }
  return { text: 'Not heard this day', state: 'none' }
}

const sameInfo = (a: AircraftInfo, b: AircraftInfo): boolean =>
  a.hex === b.hex && a.callsign === b.callsign && a.reg === b.reg && a.typeCode === b.typeCode && a.category === b.category &&
  a.squawk === b.squawk && a.emergency === b.emergency && a.military === b.military && a.route === b.route

/**
 * What the selected aircraft is called at t (the card, its label and list row, the chase model's type and livery): its
 * leg's identity (traceInfo) with the callsign it sent then (callsignAt: quiet, the leg's last; before, the first it will
 * send) and, from the half-hour files (feed: HistoryFeed.info), its squawk and its category (the icon); a leg with no type
 * takes the files'. On a day it did not fly: the day's registration and type with the files' callsign. Null until its day
 * is known (ds null: the fleet's info stands). prev when nothing in it changed, so the object stays the same.
 */
export function selectedInfo(day: { hex: string; reg: string | null; typeCode: string | null }, ds: DayState | null, t: number,
  feed: AircraftInfo | null, prev: AircraftInfo | null): AircraftInfo | null {
  if (ds === null) return null
  const squawk = feed?.squawk ?? null
  const category = feed?.category ?? null
  const next: AircraftInfo = ds.kind === 'none'
    ? { hex: day.hex, callsign: feed?.callsign ?? null, reg: day.reg, typeCode: day.typeCode ?? feed?.typeCode ?? null, category, squawk,
        emergency: null, military: false, route: null }
    : { ...traceInfo(ds.leg), callsign: callsignAt(ds.leg, t), reg: ds.leg.reg ?? day.reg, typeCode: ds.leg.typeCode ?? feed?.typeCode ?? null,
        category, squawk }
  return prev !== null && sameInfo(prev, next) ? prev : next
}

/** e as the track's state s: where it is drawn at the replay time, never aged out by the fleet's rule (its day decides). */
function fromState(e: FleetEntry, hex: string, s: RenderState, info: AircraftInfo | null): FleetEntry {
  e.hex = hex
  e.lat = s.lat
  e.lon = s.lon
  e.hM = s.hM
  e.altFt = s.altBaroFt
  e.onGround = s.onGround
  e.trackDeg = s.trackDeg
  e.gsKt = s.gsKt
  e.vsFpm = s.vsFpm
  e.ageS = s.ageS > 0 ? s.ageS : 0 // its samples run ahead of the replay time
  e.staleS = Infinity
  e.gapS = 0
  e.quality = s.quality
  e.info = info
  e.att = null
  e.ghost = false
  return e
}

/** e as a ghost at the leg's last point (as tracePath places it), aged from then to t; undefined for a leg with no point. */
function ghostAt(e: FleetEntry, hex: string, leg: TraceReply, t: number, info: AircraftInfo | null): FleetEntry | undefined {
  const i = leg.t.length - 1
  if (i < 0) return undefined
  const alt = leg.alt[i]
  e.hex = hex
  e.lat = leg.lat[i]
  e.lon = leg.lon[i]
  e.hM = heightM(alt, leg.nM[i])
  e.altFt = typeof alt === 'number' ? alt : null
  e.onGround = alt === 'g'
  e.trackDeg = leg.trk[i]
  e.gsKt = leg.gs[i]
  e.vsFpm = leg.vs[i]
  e.ageS = Math.max(0, (t - legEndMs(leg)) / 1000)
  e.staleS = Infinity
  e.gapS = 0
  e.quality = 'adsb2'
  e.info = info
  e.att = null
  e.ghost = true
  return e
}

/**
 * e as a ghost where the aircraft is estimated to be at t inside a hole of its leg (ds: between the points either side):
 * that share of the time along the great circle from one to the other (where the flown path draws the hole dotted),
 * its track the bearing from one to the other, its altitude that share of the way (unknown when either end's is not a
 * number; on the ground when both are), its speed the distance over the time, its vertical rate the climb over it. Its
 * height as drawn goes from one point's to the other's as the dotted line does. Aged from the point before the hole.
 */
function gapAt(e: FleetEntry, hex: string, ds: Extract<DayState, { kind: 'gap' }>, t: number, info: AircraftInfo | null): FleetEntry {
  const leg = ds.leg
  const i = pointsUpTo(leg, ds.sinceMs) - 1 // the point before the hole; the next one ends it
  const j = i + 1
  const ms = ds.untilMs - ds.sinceMs // more than a minute: a hole
  const f = (t - ds.sinceMs) / ms
  const nm = distanceNm(leg.lat[i], leg.lon[i], leg.lat[j], leg.lon[j])
  const trk = bearingDeg(leg.lat[i], leg.lon[i], leg.lat[j], leg.lon[j])
  const at = destination(leg.lat[i], leg.lon[i], trk, f * nm)
  const a = leg.alt[i]
  const b = leg.alt[j]
  const hA = heightM(a, leg.nM[i])
  e.hex = hex
  e.lat = at.lat
  e.lon = at.lon
  e.hM = hA + (heightM(b, leg.nM[j]) - hA) * f
  e.altFt = typeof a === 'number' && typeof b === 'number' ? a + (b - a) * f : null
  e.onGround = a === 'g' && b === 'g'
  e.trackDeg = trk
  e.gsKt = nm / (ms / 3_600_000)
  e.vsFpm = typeof a === 'number' && typeof b === 'number' ? (b - a) / (ms / 60_000) : null
  e.ageS = (t - ds.sinceMs) / 1000
  e.staleS = Infinity
  e.gapS = 0
  e.quality = 'adsb2'
  e.info = info
  e.att = null
  e.ghost = true
  return e
}

/**
 * The entries the map draws in History, written into out (cleared first; entries, the Fleet's reused array, is never
 * changed): every one but the selected aircraft's (hex), then its own as its day says at t (ds; null: not known yet, the
 * fleet's stays). Heard: its track's state s, written into own (no state yet: the fleet's). Quiet: a ghost at its leg's
 * last point, written into own (fleetLayer.ts places it at any age, faded; it must be the only entry of its hex). In a
 * hole of its leg: the same ghost where it is estimated to be (gapAt). Before its first leg, or no leg that day: not
 * drawn. Returns its entry as drawn, else undefined. Allocates nothing but, in a hole, geo.ts destination's place.
 */
export function placeSelected(entries: readonly FleetEntry[], hex: string, ds: DayState | null, t: number, s: RenderState | null,
  info: AircraftInfo | null, out: FleetEntry[], own: FleetEntry): FleetEntry | undefined {
  out.length = 0
  let fleet: FleetEntry | undefined
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e.hex === hex) fleet = e
    else out.push(e)
  }
  let mine: FleetEntry | undefined
  if (ds === null) mine = fleet
  else if (ds.kind === 'heard') mine = s === null ? fleet : fromState(own, hex, s, info)
  else if (ds.kind === 'quiet') mine = ghostAt(own, hex, ds.leg, t, info)
  else if (ds.kind === 'gap') mine = gapAt(own, hex, ds, t, info)
  if (mine !== undefined) out.push(mine)
  return mine
}

/**
 * Whether (lat, lon) is inside the view r less VIEW_INSET of its height and width on each side (r null: the globe is out
 * of view, so no). A view that spans every longitude (the globe, a pole) holds them all.
 */
export function insetContains(r: RectDeg | null, lat: number, lon: number, inset = VIEW_INSET): boolean {
  if (r === null) return false
  const dLat = (r.north - r.south) * inset
  if (!(lat >= r.south + dLat && lat <= r.north - dLat)) return false
  const span = r.west <= r.east ? r.east - r.west : r.east + 360 - r.west
  if (span >= 359) return Number.isFinite(lon)
  const x = (((lon - r.west) % 360) + 360) % 360 // east of the view's west edge
  return x >= span * inset && x <= span * (1 - inset)
}

/**
 * The person moving the map: a pointer held on it (each finger, by its pointerId) and for MOVED_MS after the last lifts,
 * a wheel or trackpad gesture for MOVED_MS. The app tells it the events, with performance.now().
 */
export class MapMoves {
  readonly #held = new Set<number>()
  #lastMs = -Infinity

  down(id: number, ms: number): void {
    this.#held.add(id)
    this.#lastMs = ms
  }

  up(id: number, ms: number): void {
    if (!this.#held.delete(id)) return // a press that began elsewhere (a button, the bar)
    this.#lastMs = ms
  }

  wheel(ms: number): void {
    this.#lastMs = ms
  }

  /** Every pointer lets go (the window lost the focus: their lifts will not come). */
  clear(ms: number): void {
    if (this.#held.size === 0) return
    this.#held.clear()
    this.#lastMs = ms
  }

  recent(ms: number): boolean {
    return this.#held.size > 0 || ms - this.#lastMs < MOVED_MS
  }
}

/**
 * Whether the map flies over the selected aircraft this frame (top-down; the app knows its position). A jump in time,
 * entering History or selecting (bring): when it is out of view. While playing: when it was in view last frame and is not
 * now, and the person is not moving the map (moved: MapMoves.recent). One they panned away from stays away.
 */
export function flyOver(o: { bring: boolean; playing: boolean; wasInside: boolean; inside: boolean; moved: boolean }): boolean {
  if (o.inside) return false
  return o.bring || (o.playing && o.wasInside && !o.moved)
}

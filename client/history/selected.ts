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
import { callsignAt, dayState, legEndMs, pointsUpTo, type DayState } from './aircraftDay.ts'
import { heightM, traceInfo } from './trace.ts'

const BEFORE_MS = 12 * 3_600_000 // a day is asked with this much before it: where the aircraft stood when it began
const VIEW_INSET = 0.1 // an aircraft within this share of the view's height or width from an edge is out of view
const MOVED_MS = 1500 // the map does not follow an aircraft while the person moves it, nor this long after
const AHEAD_MS = 120_000 // the chase asks for where its aircraft will be this far on, before its view outruns what is loaded
const KT_MS = 1852 / 3600
const FPM_MS = 0.3048 / 60
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
 * The card's status line at t (flightCard.ts setReplay), short enough for the card's foot. Heard, or its day not known
 * yet: the replay's clock, and the files' quiet rule for a sample (quietS). Quiet, or in a hole of its leg: when it was
 * last heard (on the ground or not: its ALT says GND; in a hole its numbers are the estimate's). Before its first leg:
 * when it is first heard. No leg that day: that. A time on another day than t carries its weekday ("Thu 22:58").
 */
export function replayStatus(ds: DayState | null, t: number, quietS: number): ReplayStatus {
  if (ds === null || ds.kind === 'heard') return { text: `Replay · ${hhmm(new Date(t))}`, state: 'replay', quietS }
  if (ds.kind === 'quiet' || ds.kind === 'gap') return { text: `Last heard ${atClock(ds.sinceMs, t)}`, state: 'quiet' }
  if (ds.kind === 'before') return { text: `First heard ${atClock(ds.untilMs, t)}`, state: 'none' }
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

type Gap = Extract<DayState, { kind: 'gap' }>

/**
 * Inside a hole of a leg (ds) at t: the point before it (i; the next one ends it), the share of its time gone (f), that
 * share of the way along the great circle from one to the other (lat, lon: where the flown path draws the hole dotted),
 * the bearing from one to the other (trk) and the distance (nm).
 */
function inHole(ds: Gap, t: number): { i: number; f: number; lat: number; lon: number; trk: number; nm: number } {
  const leg = ds.leg
  const i = pointsUpTo(leg, ds.sinceMs) - 1
  const f = (t - ds.sinceMs) / (ds.untilMs - ds.sinceMs) // more than a minute: a hole
  const nm = distanceNm(leg.lat[i], leg.lon[i], leg.lat[i + 1], leg.lon[i + 1])
  const trk = bearingDeg(leg.lat[i], leg.lon[i], leg.lat[i + 1], leg.lon[i + 1])
  const at = destination(leg.lat[i], leg.lon[i], trk, f * nm)
  return { i, f, lat: at.lat, lon: at.lon, trk, nm }
}

/**
 * e as a ghost where the aircraft is estimated to be at t inside a hole of its leg (ds: between the points either side):
 * that share of the time along the great circle from one to the other (inHole), its track the bearing from one to the
 * other, its altitude that share of the way (unknown when either end's is not a number; on the ground when both are),
 * its speed the distance over the time, its vertical rate the climb over it. Its height as drawn goes from one point's
 * to the other's as the dotted line does. Aged from the point before the hole.
 */
function gapAt(e: FleetEntry, hex: string, ds: Gap, t: number, info: AircraftInfo | null): FleetEntry {
  const leg = ds.leg
  const { i, f, lat, lon, trk, nm } = inHole(ds, t)
  const ms = ds.untilMs - ds.sinceMs
  const a = leg.alt[i]
  const b = leg.alt[i + 1]
  const hA = heightM(a, leg.nM[i])
  e.hex = hex
  e.lat = lat
  e.lon = lon
  e.hM = hA + (heightM(b, leg.nM[i + 1]) - hA) * f
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
 * drawn. Returns its entry as drawn, else undefined. Allocates nothing but, in a hole, the estimate's place (inHole).
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

/**
 * The ghost in a hole of its leg (placeSelected's entry) as the chased aircraft's state: the chase flies the estimate
 * rather than freezing where it was last heard. Its nose along the bearing, pitched by its climb over its speed, wings
 * level; aged from the point before the hole.
 */
export function estimateState(e: FleetEntry): RenderState {
  const gs = (e.gsKt ?? 0) * KT_MS
  const vs = (e.vsFpm ?? 0) * FPM_MS
  return {
    hex: e.hex, lat: e.lat, lon: e.lon, hM: e.hM, headingDeg: e.trackDeg ?? 0, pitchDeg: gs > 0 ? (Math.atan2(vs, gs) * 180) / Math.PI : 0,
    rollDeg: 0, gsKt: e.gsKt, trackDeg: e.trackDeg, altBaroFt: e.altFt, vsFpm: e.vsFpm, mode: 'interp', altSource: 'baro-bias',
    onGround: e.onGround, ageS: e.ageS, quality: e.quality, callsign: e.info?.callsign ?? null, typeCode: e.info?.typeCode ?? null,
  }
}

/**
 * Where History's asks are centred in the chase (app.ts): where the chased aircraft will be about AHEAD_MS of replay after
 * t, on its leg (heard or in a hole of it: its last point by then, or along a hole as the estimate goes; past the leg's
 * end, where it ends), so its view is asked for before it outruns what is loaded. Null off a leg (its day not known,
 * quiet, before, none): where it is stands.
 */
export function chaseAskAt(ds: DayState | null, t: number): { lat: number; lon: number } | null {
  if (ds === null || (ds.kind !== 'heard' && ds.kind !== 'gap')) return null
  const at = t + AHEAD_MS
  const then = dayState([ds.leg], at)
  if (then.kind === 'gap') {
    const p = inHole(then, at)
    return { lat: p.lat, lon: p.lon }
  }
  const n = pointsUpTo(ds.leg, at)
  return n === 0 ? null : { lat: ds.leg.lat[n - 1], lon: ds.leg.lon[n - 1] }
}

/**
 * Whether History waits for data at the replay time (app.ts, every frame), for the half hour under the clock: stall (the
 * clock holds, the bar's loader turns) only when nothing of it is loaded around the view's centre (centre false: a jump,
 * the start, a pan or zoom to an area never loaded) or, in the chase, when none of it is loaded at all (held false: its
 * view moves with its aircraft, which flies its own leg, so loaded ground it outruns never stops it), and that half hour
 * is neither missing at adsb.lol nor failing; or while the selection's first day of flights is asked for (firstDay).
 * Otherwise a view partly out of what is loaded is asked for at once and plays on: the loader turns while its half hour
 * loads (loading), the clock does not hold.
 */
export function historyWait(o: { held: boolean; centre: boolean; chasing: boolean; missing: boolean; failing: boolean;
  loading: boolean; firstDay: boolean }): { stall: boolean; ring: boolean } {
  const empty = !(o.chasing ? o.held : o.centre) && !o.missing && !o.failing
  const stall = empty || o.firstDay
  return { stall, ring: stall || o.loading }
}

/** A selected aircraft's local day (its day of flights asked, answered or failed). */
export interface DayKey {
  hex: string
  startMs: number
}

const sameDay = <T extends DayKey>(a: T | null, b: DayKey): a is T => a !== null && a.hex === b.hex && a.startMs === b.startMs

/**
 * The selected aircraft's day of flights at t (app.ts askDayWhenDue; want: its local day): whether to ask for it now, and
 * the ask in flight to keep. An ask in flight for another day is dropped (its reply would replace this day's answer: a
 * day answered, the day before asked, back again before that reply came). Answered (the day held is want's and reaches
 * t), or want's ask in flight: nothing to ask. A failure or an answer short of t a moment ago: not before again.atMs.
 */
export function dayAsk(want: DayKey, t: number, day: (DayKey & { toMs: number }) | null, inFlight: DayKey | null,
  again: (DayKey & { atMs: number }) | null, nowMs: number): { ask: boolean; inFlight: DayKey | null } {
  const flying = sameDay(inFlight, want) ? inFlight : null
  if ((sameDay(day, want) && t <= day.toMs) || flying !== null) return { ask: false, inFlight: flying }
  return { ask: !(sameDay(again, want) && nowMs < again.atMs), inFlight: null }
}

/**
 * Whether the selection's first day of flights is being asked for (History waits for it: where the aircraft is hangs on
 * it): an ask for hex in flight, no answer for it held, and no failure for it (a retry waits for nothing, as a failed half
 * hour does not).
 */
export function firstDayAsked(hex: string | null, ask: DayKey | null, day: DayKey | null, again: DayKey | null): boolean {
  return hex !== null && ask !== null && ask.hex === hex && day?.hex !== hex && again?.hex !== hex
}

/**
 * The legs of a fresh answer for the day already held (held), each the held one where it is the same leg (its first
 * point's time and its number of points): the selected aircraft's track and path go by the leg itself, and an answer
 * that only repeats them must not start them again. The held array itself when every leg is (the bar's stay too).
 */
export function keepLegs(held: TraceReply[], fresh: TraceReply[]): TraceReply[] {
  const out = fresh.map((l) => held.find((o) => o.t0Ms === l.t0Ms && o.t.length === l.t.length) ?? l)
  return out.length === held.length && out.every((l, i) => l === held[i]) ? held : out
}

/**
 * Where the selected aircraft's track is fed from at t (app.ts feedHistory): its day not known yet, the feed's samples;
 * heard, its leg's; otherwise none (not heard, in a hole too: no track).
 */
export function trackSource(ds: DayState | null): TraceReply | 'feed' | 'none' {
  return ds === null ? 'feed' : ds.kind === 'heard' ? ds.leg : 'none'
}

/** Another source starts the track afresh, but the first one when it is the feed (it keeps the selection's seed sample). */
export function restartsTrack(was: TraceReply | 'feed' | 'none' | null, next: TraceReply | 'feed' | 'none'): boolean {
  return next !== was && (was !== null || next !== 'feed')
}

/**
 * keepInView's rule for this frame (top-down, with a selection; app.ts flies): over the selected aircraft ('bring' or
 * 'follow') or not (null), and whether a pending bring stays pending. Nothing while the map flies already or a scrubber
 * seek rests (busy). Bring: a jump, entering History or selecting (bring), and its first position after none (had false,
 * at true: before its first leg to heard, a day answer placing it), unless the person moved the map in the last 1.5 s;
 * flyOver says when (out of view; while playing, followed out of it). A pending bring ends once its day for that time
 * says where it was (dayKnown and at) or that it was nowhere (nowhere: before its first leg, none that day).
 */
export function viewMove(o: { busy: boolean; bring: boolean; had: boolean; at: boolean; playing: boolean; wasInside: boolean;
  inside: boolean; moved: boolean; dayKnown: boolean; nowhere: boolean }): { fly: 'bring' | 'follow' | null; bring: boolean } {
  if (o.busy) return { fly: null, bring: o.bring }
  const bring = o.bring || (!o.had && o.at && !o.moved)
  const fly = o.at && flyOver({ bring, playing: o.playing, wasInside: o.wasInside, inside: o.inside, moved: o.moved })
  return { fly: fly ? (bring ? 'bring' : 'follow') : null, bring: o.bring && !(o.dayKnown && (o.at || o.nowhere)) }
}

// server/alerts.ts
// The alerts' switch, their events and their log (docs/superpowers/specs/2026-10-03-alerts-design.md). The poller feeds
// it: observe() gets every aircraft of every good answer, the worldwide squawk sweep's included, and sample() each new
// stored sample. scanSlot() reads each new adsb.lol half-hour file (the late check). Nothing here runs a timer; the only
// request is the push, which the caller gives (ntfyPush).
//   EVENTS_DIR/state.json        {"on":true}: the switch, kept across restarts (default off)
//   EVENTS_DIR/YYYY-MM-DD.jsonl  one AlertEvent per line, written when it opens or changes (the UTC day of the write); the
//                                newest line of an id wins. The last 8 days are read at start.
// ponytail: older day files are kept, never deleted: they are the user's archive, tens of KB a day. Delete the files to clear them.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMERGENCY_SQUAWKS, EMERGENCY_STATUSES, pushBody, pushTitle, type AlertDrop, type AlertEvent, type EventsReply } from '../shared/alerts.ts'
import { SLOT_MS } from '../shared/history.ts'
import { callsignOf } from '../shared/readsb.ts'
import type { ReadsbAircraft, Sample } from '../shared/types.ts'
import { D1_OTHER, D2, D2_OTHER, D3, clean, diveThenLost, steepDescent, type AltSeries, type Drop } from './descent.ts'
import { scanSlot, type ScanAircraft, type SlotScan } from './heatmap.ts'

const DAY_MS = 86_400_000
// A cause counts once it is seen again this long after it was first seen (glitches are brief), by the times of its messages. The
// sweep asks each code every 30 s: 20 s, so that the second sweep confirms even when its newest message is up to 10 s old.
const CONFIRM_MS = 20_000
// A first sighting not seen again within this is forgotten. 10 min is two rounds of the sweep (an answer that fails skips its
// code for a round) down to 0.08 req/s; at adsb.fi's 0.9 req/s after three 429s (0.1125) each of 3 codes is asked every 213 s.
// ponytail: slower still (a fourth 429, a lower MAX_RPS, more ALERT_SQUAWKS codes), an emergency that only the sweep sees, once
// a round, may never be confirmed.
const PENDING_MS = 10 * 60_000
const EPISODE_MS = 30 * 60_000 // an event takes in sightings this close to it; later, a new one opens
const TAIL_S = 150 // the end of a half hour that the late check carries into the next: a 120 s descent (D1) and the point before it
const SLOT_S = SLOT_MS / 1000
const REV_EVERY_MS = 30_000 // a sighting with nothing new changes the rev only this long after it last changed
const WRITE_EVERY_MS = 5 * 60_000 // a sighting with nothing new is written this often at most
const DROP_WRITE_MS = 30_000 // a bigger fall is written this long after the last write at the earliest, not on the 5 min above
const LOG_EVERY_MS = 60_000 // a failure is logged this often at most (each kind)
const KEEP_DAYS = 7 // the reply's events
const READ_DAYS = 8 // the day files read at start
const MAX_REPLY = 300
const LIVE_RATE_FPM = -3000 // a live sample is checked for a descent only at this baro_rate or steeper
const MILITARY = 1 // dbFlags bit
const ICAO = /^[0-9a-f]{6}$/
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/
const NOT_AIRCRAFT = new Set(['000000', '000001']) // placeholders some transponders send (docs/anomaly-alerts.md §4)
const SURFACE = new Set(['C1', 'C2', 'C3']) // emergency and service vehicles, obstacles
const LIGHT = new Set(['A1', 'B1', 'B2', 'B3', 'B4', 'B6', 'B7']) // light aircraft, gliders, balloons, parachutists, ultralights, drones, space
const MINOR = new Set(['7600', 'nordo', 'minfuel']) // causes that are quiet on a light aircraft (most 7600s are on approach)
// ICAO type designators of fighters and military trainers: no fall events for them (their squawks and statuses are read).
// ponytail: fighters and trainers dive as routine; add a type when one shows up as a false alarm
const FAST_JETS = new Set([
  'A4', 'A10', 'AJET', 'AMX', 'AV8B', 'BT7', 'EUFI', 'F1', 'F4', 'F5', 'F14', 'F15', 'F16', 'F18', 'F18H', 'F18S', 'F22', 'F35', 'F104', 'F117',
  'GRIF', 'HAWK', 'HUNT', 'J8', 'JF17', 'K8', 'KFIR', 'L39', 'L59', 'L159', 'LCA', 'M339', 'M345', 'M346', 'MG29', 'MG31', 'MIR2', 'MRF1', 'RFAL',
  'S211', 'SU24', 'SU25', 'SU27', 'SU30', 'SU34', 'SU35', 'SU57', 'T2', 'T38', 'T4', 'T45', 'T50', 'TEX2', 'TOR', 'PC7', 'PC9', 'PC21', 'TUCA',
])
// ICAO type designators of airliners and freighters: aircraft that never dive in ordinary flight, so a smaller fall is an event
// for them (descent.ts D1, D2, D3); any other civil type needs D1_OTHER's 20,000 ft, or D2_OTHER's 10,000 fpm from FL150 (jump
// planes, business jets and their drills dive as routine: descent.ts has the measured values).
// ponytail: a list by hand, as FAST_JETS is; a type not here is only less watched. Add a new airliner when one enters service.
const AIRLINERS = new Set([
  'A19N', 'A20N', 'A21N', 'A318', 'A319', 'A320', 'A321', 'A306', 'A30B', 'A310', 'A332', 'A333', 'A337', 'A338', 'A339', 'A342', 'A343', 'A345',
  'A346', 'A359', 'A35K', 'A388', 'A3ST', 'BCS1', 'BCS3', 'B37M', 'B38M', 'B39M', 'B3XM', 'B461', 'B462', 'B463', 'B712', 'B721', 'B722', 'B732',
  'B733', 'B734', 'B735', 'B736', 'B737', 'B738', 'B739', 'B741', 'B742', 'B743', 'B744', 'B748', 'B74R', 'B74S', 'B752', 'B753', 'B762', 'B763',
  'B764', 'B772', 'B773', 'B778', 'B779', 'B77L', 'B77W', 'B788', 'B789', 'B78X', 'BLCF', 'CRJ1', 'CRJ2', 'CRJ7', 'CRJ9', 'CRJX', 'E135', 'E145',
  'E45X', 'E170', 'E75L', 'E75S', 'E190', 'E195', 'E290', 'E295', 'F70', 'F100', 'RJ1H', 'RJ70', 'RJ85', 'SU95', 'AJ27', 'C919', 'MD11', 'MD81',
  'MD82', 'MD83', 'MD87', 'MD88', 'MD90', 'DC10', 'IL62', 'IL76', 'IL96', 'T204', 'T214', 'A124', 'A148', 'A158', 'YK42', 'AT43', 'AT45', 'AT46',
  'AT72', 'AT73', 'AT75', 'AT76', 'DH8A', 'DH8B', 'DH8C', 'DH8D', 'SF34', 'SB20', 'E120', 'F50', 'JS41', 'D328',
])
const NO_TYPE = Object.freeze({ type: null, category: null })

// An aircraft's type designator, emitter category and military flag (typeDb.ts lookup); a missing military is false.
type Typed = { type: string | null; category: string | null; military?: boolean }
type Who = Pick<AlertEvent, 'callsign' | 'reg' | 'type' | 'lat' | 'lon' | 'altFt'>
type Patch = Who & { squawk?: string | null; emergency?: string | null; drop?: AlertDrop | null }

/** An aircraft of a half hour as the late check judges it: its altitudes (t in s into the half hour), newest place and callsign. */
type Heard = Pick<ScanAircraft, 'alt' | 'lat' | 'lon' | 'callsign'>
/** The ends of the newest half hour read (scanSlot), by hex: each aircraft's points in its last 150 s, t in s into the NEXT half hour. */
type Tails = ReadonlyMap<string, Heard>
const NO_TAILS: Tails = new Map()

export interface AlertsOpts {
  dir: string // EVENTS_DIR
  nowMs?: () => number
  codes?: readonly string[] // the squawks swept and read as emergencies (ALERT_SQUAWKS); default 7700, 7600, 7500
  sweep: boolean // the source sweeps them worldwide (adsb.fi)
  push?: (e: AlertEvent) => void // a new event that is not quiet, or a new cause on one (ntfyPush)
  typeOf?: (hex: string) => Typed // the type table's lookup (typeDb.ts): a late finding's type, category and military flag; a live fall's military flag
  append?: (path: string, text: string) => void // appends to a day file (default appendFileSync; a test cuts a write short)
}

export class Alerts {
  #dir: string
  #now: () => number
  #codes: ReadonlySet<string>
  #codeList: readonly string[]
  #sweep: boolean
  #push: (e: AlertEvent) => void
  #typeOf: (hex: string) => Typed
  #append: (path: string, text: string) => void
  #on = false
  #rev: number // changes with the switch and the events; from the clock at start, so a restart's is above the last run's
  #revMs = -Infinity // when the rev last changed (server clock)
  #events = new Map<string, AlertEvent>() // by id
  #byHex = new Map<string, AlertEvent[]>() // by hex: its events, oldest first (by openedMs)
  #pending = new Map<string, { firstMs: number; lastMs: number }>() // by hex: a first sighting waiting to be seen again
  #writtenMs = new Map<string, number>() // by id: when its last line was written
  #torn = false // the last write failed, perhaps part way through a line: the next one starts on a line of its own
  #scanned: number[] = [] // the half hours read, the newest last
  #tails: { slotMs: number; byHex: Tails } | null = null // the ends of the newest half hour read, for the one after it
  #failedMs = new Map<string, number>() // by kind of failure: when it was last logged

  constructor(o: AlertsOpts) {
    this.#dir = o.dir
    this.#now = o.nowMs ?? Date.now
    this.#rev = Math.floor(this.#now())
    this.#codeList = [...(o.codes ?? EMERGENCY_SQUAWKS)]
    this.#codes = new Set(this.#codeList)
    this.#sweep = o.sweep
    this.#push = o.push ?? (() => {})
    this.#typeOf = o.typeOf ?? (() => NO_TYPE)
    this.#append = o.append ?? appendFileSync
    mkdirSync(this.#dir, { recursive: true })
    this.#load()
  }

  get on(): boolean {
    return this.#on
  }

  /** Changes with the switch and with events: the client asks for them again when it does (StatusBrief.alertsRev). */
  get rev(): number {
    return this.#rev
  }

  /** Turns the watch on or off, kept in state.json. Off, nothing is swept, read or logged; the events stay. */
  setOn(on: boolean): void {
    if (on === this.#on) return
    this.#on = on
    this.#bump()
    this.#pending.clear()
    try {
      writeFileSync(join(this.#dir, 'state.json'), `${JSON.stringify({ on })}\n`)
    } catch (e) {
      this.#fail('write failed', e)
    }
  }

  /** The squawks to sweep worldwide now (Poller opts.squawks): all of them while on, none while off. */
  squawks(): readonly string[] {
    return this.#on ? this.#codeList : []
  }

  /**
   * One aircraft object of a good answer (Poller opts.onAircraft), rxMs its receipt. An emergency squawk or status counts
   * once it is seen again 20 s or more after it was first seen: its event opens then, or the aircraft's event within 30 min
   * takes it in. Each sighting's time is its last message's (rxMs − seen): readsb serves a squawk for 60 s after it, so two
   * answers can hold one message. Not read: aircraft on the ground, surface vehicles, addresses that are not ICAO, 000000 and
   * 000001. Military aircraft and fast jets are read: their squawks and statuses are emergencies.
   * ponytail: the 20 s is for opening only; a new cause on an open event counts at once.
   */
  observe(ac: ReadsbAircraft, rxMs: number): void {
    if (!this.#on) return
    const hex = ac.hex.toLowerCase()
    if (ignored(hex, ac.category ?? null) || ac.alt_baro === 'ground') return
    const squawk = ac.squawk !== undefined && this.#codes.has(ac.squawk) ? ac.squawk : null
    const emergency = ac.emergency !== undefined && EMERGENCY_STATUSES.includes(ac.emergency) ? ac.emergency : null
    if (squawk === null && emergency === null) return
    const t = rxMs - ageS(ac.seen) * 1000
    const at = positionOf(ac)
    const who: Who = {
      callsign: callsignOf(ac.flight), reg: str(ac.r), type: str(ac.t),
      lat: at?.lat ?? null, lon: at?.lon ?? null, altFt: typeof ac.alt_baro === 'number' ? ac.alt_baro : null,
    }
    const open = this.#near(hex, t, t)
    if (open !== null) return this.#merge(open, t, { ...who, squawk, emergency }, false)
    for (const [h, p] of this.#pending) if (t - p.lastMs > PENDING_MS) this.#pending.delete(h)
    const p = this.#pending.get(hex)
    if (p === undefined) return void this.#pending.set(hex, { firstMs: t, lastMs: t })
    p.lastMs = Math.max(p.lastMs, t)
    if (t - p.firstMs < CONFIRM_MS) return
    this.#pending.delete(hex)
    this.#open({
      id: `${hex}-${p.firstMs}`, hex, kind: squawk !== null ? 'squawk' : 'status', ...who, squawk, emergency, drop: null,
      openedMs: p.firstMs, lastMs: p.lastMs, late: false, quiet: quietFor(ac.category ?? null, squawk, emergency),
    })
  }

  /**
   * A new stored sample of a polled aircraft (Poller opts.onSample). At a baro_rate of −3,000 fpm or steeper, its recent
   * track (asked for only then) is checked for a fall (descent.ts: D1, then D3, for an airliner by its broadcast type code;
   * D1_OTHER for any other). Not for military aircraft (dbFlags, or the
   * type table's flag), fighter and trainer types (FAST_JETS, by the broadcast type code), light aircraft or gliders, surface
   * vehicles, addresses that are not ICAO, 000000 and 000001.
   */
  sample(s: Sample, track: () => readonly Sample[], dbFlags = 0): void {
    if (!this.#on || s.onGround || s.altBaroFt === null || !((s.baroRateFpm ?? 0) <= LIVE_RATE_FPM)) return
    const category = s.category ?? null
    if (LIGHT.has(category ?? '') || ignored(s.hex, category) || this.#noFalls(s.hex, s.typeCode, dbFlags)) return
    const series: AltSeries = { t: [], ft: [] }
    for (const x of track()) {
      if (x.onGround || x.altBaroFt === null) continue
      series.t.push(x.tMs / 1000)
      series.ft.push(x.altBaroFt)
    }
    const d = descentIn(clean(series), AIRLINERS.has(s.typeCode ?? ''))
    if (d === null) return
    this.#fell(s.hex, 'descent', d, 0, { callsign: s.callsign, reg: s.reg, type: s.typeCode, lat: s.lat, lon: s.lon, altFt: s.altBaroFt }, false)
  }

  /**
   * The late check of one half-hour file (slotMs its start; each half hour is read once). An aircraft with two or more ident
   * records carrying an emergency squawk while airborne, and each descent (D1, D3 or D1_OTHER, by its type: descentIn) or dive
   * then lost (D2 or D2_OTHER) in its altitudes, opens a late event, or joins the aircraft's event that its span is within
   * 30 min of. When this half hour follows the newest one read, each aircraft's points in that one's last 150 s go before its points here, so a fall across the boundary
   * is found; an aircraft heard there and not here was lost at the boundary, and its end is judged alone, up to this half
   * hour's last slice. A fall that both half hours hold joins one event (no second push). Not read: addresses that are not
   * ICAO, 000000 and 000001 (the type table is not asked for them), and surface vehicles (the type table's C1 to C3). No fall
   * is looked for in an aircraft the type table calls military or whose type is in FAST_JETS; its squawks are read. A late
   * 7600 on a type the table calls light (A1, B1…) is quiet.
   * ponytail: the half hours should come in time order (the caller scans the older first): a merge never moves an event's
   * openedMs earlier, so an older half hour scanned after a newer leaves the event opening later than the episode began. An
   * older half hour read late (its download failed once) is judged alone and does not take the newer one's end, which the half
   * hour after the newer still follows; a fall across the older one's own boundary with the newer is lost.
   * ponytail: nothing is carried across a gap in the reads (the server down over a half hour, the switch off), so a fall across
   * that boundary is still lost; and only altitudes are carried, so an emergency squawk with one ident on each side of a boundary
   * is not an event.
   */
  scanSlot(buf: Uint8Array, slotMs: number): void {
    if (!this.#on || this.#scanned.includes(slotMs)) return
    this.#scanned.push(slotMs)
    if (this.#scanned.length > 4) this.#scanned.shift()
    const scan = scanSlot(buf, slotMs, this.#codes)
    // The ends of the newest half hour read go before this one's points only when this one follows it: after a gap, none.
    const tails = this.#tails !== null && this.#tails.slotMs + SLOT_MS === slotMs ? this.#tails.byHex : NO_TAILS
    // Those kept are the newest half hour's: an older one read late (its download failed once) does not take them.
    if (this.#tails === null || slotMs > this.#tails.slotMs) this.#tails = { slotMs, byHex: scan === null ? NO_TAILS : tailsOf(scan) }
    if (scan === null) return
    for (const [hex, a] of scan.aircraft) {
      const tail = tails.get(hex)
      this.#late(hex, a.squawks, tail === undefined ? a : { ...a, callsign: a.callsign ?? tail.callsign }, tail?.alt, slotMs, scan.endS)
    }
    // Heard at the end of the half hour before and not in this one: lost at the boundary, its end is judged alone.
    for (const [hex, tail] of tails) if (!scan.aircraft.has(hex)) this.#late(hex, [], tail, undefined, slotMs, scan.endS)
  }

  /**
   * One aircraft of the late check of the half hour at slotMs: its emergency idents there, and a fall (a descent by the rules
   * of its kind, else a dive then lost up to endS) in its altitudes, with `before`, its end of the half hour before (t in this one's), put first. `at` is its newest.
   */
  #late(hex: string, squawks: ScanAircraft['squawks'], at: Heard, before: AltSeries | undefined, slotMs: number, endS: number): void {
    const idents = squawks.length >= 2
    const [hi, lo] = extent(before, at.alt)
    if (!idents && hi - lo < D2.fallFt) return // the cheap test first: level, it holds no fall
    if (badAddress(hex)) return // before the type table is asked: nothing is read of it
    const typed = this.#typed(hex)
    if (ignored(hex, typed.category)) return // the full test, a surface vehicle by the table's category
    // ponytail: the type table's category makes a late 7600 quiet on a light type, but it gives every piston, turboprop and
    // electric type A1, so the ATR 72 and the Dash 8 are quiet too: accepted, radio failures are the least urgent cause (live
    // sightings use the broadcast category). It is not used to skip a fall: one that is no airliner's needs a top at or above
    // FL200 (D1_OTHER) or FL150 (D2_OTHER), which leaves light aircraft out in practice, and the Dash 8, an airliner, is found.
    // ponytail: a late event's place and level are the aircraft's newest of the half hour, not where its cause was.
    const who: Who = { callsign: at.callsign, reg: null, type: typed.type, lat: at.lat, lon: at.lon, altFt: at.alt.ft.at(-1) ?? null }
    if (idents) {
      const first = slotMs + squawks[0].tS * 1000
      const last = slotMs + squawks[squawks.length - 1].tS * 1000
      const squawk = squawks[squawks.length - 1].squawk
      const open = this.#near(hex, first, last)
      if (open !== null) this.#merge(open, last, { ...who, squawk }, true)
      else {
        this.#open({
          id: `${hex}-${first}`, hex, kind: 'squawk', ...who, squawk, emergency: null, drop: null,
          openedMs: first, lastMs: last, late: true, quiet: quietFor(typed.category, squawk, null),
        })
      }
    }
    // No fall is 3,000 ft (D2, the loosest rule) from top to bottom; one that is no airliner's has its top at FL150 or above.
    const liner = AIRLINERS.has(typed.type ?? '')
    if (hi - lo < D2.fallFt || (!liner && hi < D2_OTHER.topFt) || this.#noFalls(hex, typed.type, 0, typed)) return
    const s = clean(before === undefined ? at.alt : { t: before.t.concat(at.alt.t), ft: before.ft.concat(at.alt.ft) })
    const d1 = descentIn(s, liner)
    const d = d1 ?? diveThenLost(s, endS, liner ? D2 : D2_OTHER)
    if (d !== null) this.#fell(hex, d1 !== null ? 'descent' : 'dive', d, slotMs, who, true)
  }

  /** The switch and the events of the last 7 days, newest first (GET /api/events). */
  reply(): EventsReply {
    const from = this.#now() - KEEP_DAYS * DAY_MS
    const events = [...this.#events.values()].filter((e) => e.lastMs >= from).sort((a, b) => b.openedMs - a.openedMs).slice(0, MAX_REPLY)
    return { on: this.#on, sweep: this.#sweep, rev: this.#rev, events }
  }

  /** A fall found, its times in s from baseMs (0 for live samples: their s are UTC): a descent or dive event, or a cause on one. */
  #fell(hex: string, kind: 'descent' | 'dive', d: Drop, baseMs: number, who: Who, late: boolean): void {
    const startMs = baseMs + d.startS * 1000
    const endMs = baseMs + d.endS * 1000
    const drop: AlertDrop = { fromFt: d.fromFt, toFt: d.toFt, overS: Math.round(d.endS - d.startS), lost: kind === 'dive' }
    const open = this.#near(hex, startMs, endMs)
    if (open !== null) return this.#merge(open, endMs, { ...who, drop }, late)
    this.#open({
      id: `${hex}-${startMs}`, hex, kind, ...who, squawk: null, emergency: null, drop,
      openedMs: startMs, lastMs: endMs, late, quiet: false,
    })
  }

  /**
   * The aircraft's event that a sighting's span (fromMs to toMs; one time for a live sighting) is within 30 min of: the span
   * does not end over 30 min before the event's start, nor start over 30 min after its newest sighting (an overlap counts).
   * Of several, the one seen last. ponytail: two events of an aircraft are never joined, even when a later finding bridges them.
   */
  #near(hex: string, fromMs: number, toMs: number): AlertEvent | null {
    let found: AlertEvent | null = null
    for (const e of this.#byHex.get(hex) ?? []) {
      if (toMs >= e.openedMs - EPISODE_MS && fromMs <= e.lastMs + EPISODE_MS && (found === null || e.lastMs >= found.lastMs)) found = e
    }
    return found
  }

  #open(e: AlertEvent): void {
    const old = this.#now() - READ_DAYS * DAY_MS
    for (const [id, x] of this.#events) {
      if (x.lastMs >= old) continue
      this.#events.delete(id)
      this.#writtenMs.delete(id)
      this.#unlist(x)
    }
    this.#events.set(e.id, e)
    this.#list(e)
    this.#bump()
    this.#write(e)
    if (!e.quiet) this.#notify(e)
  }

  /** An event into its aircraft's list, which stays in order of openedMs (a late finding can be older than the others). */
  #list(e: AlertEvent): void {
    const list = this.#byHex.get(e.hex)
    if (list === undefined) {
      this.#byHex.set(e.hex, [e])
      return
    }
    let i = list.length
    while (i > 0 && list[i - 1].openedMs > e.openedMs) i--
    list.splice(i, 0, e)
  }

  #unlist(e: AlertEvent): void {
    const list = this.#byHex.get(e.hex)
    const i = list?.indexOf(e) ?? -1
    if (list === undefined || i < 0) return
    list.splice(i, 1)
    if (list.length === 0) this.#byHex.delete(e.hex)
  }

  #bump(): void {
    this.#rev++
    this.#revMs = this.#now()
  }

  /**
   * Its aircraft seen again at t, live or found late. A new cause (a squawk or status it did not have, a fall) changes the
   * rev and is written and pushed at once. A bigger fall replaces the old one, changes the rev and is written 30 s or more
   * after the last write, with no push. A newer place and time change the rev 30 s at most after it last changed (so a client
   * keeps "ongoing" right) and are written every 5 min at most. A quiet event with a cause that is not minor is quiet no more,
   * an older sighting's too (a 7700 from before a 7600): the event is written and pushed once, with its newer code as it is.
   * A sighting older than the event's newest only fills a squawk or status the event has none of: it never overwrites a newer
   * one, and a code that differs is no new cause. A live sighting of a late event clears late (it is heard again); a late
   * finding never sets it. ponytail: the older code that differs is not kept, a worse one included: only its effect on quiet.
   */
  #merge(e: AlertEvent, t: number, p: Patch, late: boolean): void {
    const newer = t >= e.lastMs
    const squawk = p.squawk != null && (newer || e.squawk === null) ? p.squawk : null
    const emergency = p.emergency != null && (newer || e.emergency === null) ? p.emergency : null
    const cause = (squawk !== null && squawk !== e.squawk) || (emergency !== null && emergency !== e.emergency) || (p.drop != null && e.drop === null)
    const grew = p.drop != null && e.drop !== null && p.drop.fromFt - p.drop.toFt > e.drop.fromFt - e.drop.toFt
    const heard = !late && e.late // a late event, now heard live
    // A quiet event turns loud at a worse cause, an older one too: p, not the squawk and status kept above.
    const loud = e.quiet && ((p.squawk != null && !MINOR.has(p.squawk)) || (p.emergency != null && !MINOR.has(p.emergency)) || p.drop != null)
    if (squawk !== null) e.squawk = squawk
    if (emergency !== null) e.emergency = emergency
    if (p.drop != null && (e.drop === null || grew)) e.drop = p.drop
    if (heard) e.late = false
    e.callsign ??= p.callsign
    e.reg ??= p.reg
    e.type ??= p.type
    if (newer) {
      e.lastMs = t
      if (p.lat !== null && p.lon !== null) {
        e.lat = p.lat
        e.lon = p.lon
      }
      if (p.altFt !== null) e.altFt = p.altFt
    }
    if (loud) e.quiet = false
    const now = this.#now()
    if (cause || loud || grew || heard || now - this.#revMs >= REV_EVERY_MS) this.#bump()
    if (cause || loud) {
      this.#write(e)
      if (!e.quiet) this.#notify(e)
    } else if (heard || now - (this.#writtenMs.get(e.id) ?? -Infinity) >= (grew ? DROP_WRITE_MS : WRITE_EVERY_MS)) this.#write(e)
  }

  /**
   * One line in today's file (UTC). A failure is logged once a minute at most and the event stays in memory; the next change
   * tries again. After a failure the next line starts with a newline: a line cut short (a full disk) cannot join it.
   */
  #write(e: AlertEvent): void {
    const now = this.#now()
    try {
      this.#append(join(this.#dir, `${new Date(now).toISOString().slice(0, 10)}.jsonl`), `${this.#torn ? '\n' : ''}${JSON.stringify(e)}\n`)
      this.#torn = false
      this.#writtenMs.set(e.id, now)
    } catch (err) {
      this.#torn = true
      this.#fail('write failed', err)
    }
  }

  /** The push of an event (opts.push). It cannot break the caller: a failure is logged once a minute at most. */
  #notify(e: AlertEvent): void {
    try {
      this.#push(e)
    } catch (err) {
      this.#fail('push failed', err)
    }
  }

  /**
   * Whether no fall is looked for in this aircraft, live or late: it is military (dbFlags bit 1, or the type table's flag) or a
   * fast jet or trainer type (FAST_JETS). The table is asked last, and not at all when `typed`, its answer, is given.
   */
  #noFalls(hex: string, type: string | null | undefined, dbFlags: number, typed?: Typed): boolean {
    return (dbFlags & MILITARY) !== 0 || FAST_JETS.has(type ?? '') || (typed ?? this.#typed(hex)).military === true
  }

  /** The type table's answer for an address (opts.typeOf); a lookup that throws counts as no type. */
  #typed(hex: string): Typed {
    try {
      return this.#typeOf(hex)
    } catch (err) {
      this.#fail('type lookup failed', err)
      return NO_TYPE
    }
  }

  /** A failure to say: each kind once a minute at most. */
  #fail(what: string, err: unknown): void {
    const now = this.#now()
    if (now - (this.#failedMs.get(what) ?? -Infinity) < LOG_EVERY_MS) return
    this.#failedMs.set(what, now)
    console.error(`alerts: ${what}:`, err instanceof Error ? err.message : String(err))
  }

  /**
   * The switch and the events of the last 8 day files; a line that does not read (a write cut short) or is not an event is
   * skipped, as is an empty one. A file that ends in a cut line gets a newline, or the next line written would join it and be
   * lost with it.
   */
  #load(): void {
    try {
      this.#on = (JSON.parse(readFileSync(join(this.#dir, 'state.json'), 'utf8')) as { on?: unknown }).on === true
    } catch {
      this.#on = false
    }
    const from = new Date(this.#now() - READ_DAYS * DAY_MS).toISOString().slice(0, 10)
    let names: string[] = []
    try {
      names = readdirSync(this.#dir).filter((n) => DAY_FILE.test(n) && n.slice(0, 10) >= from).sort()
    } catch {
      names = []
    }
    for (const name of names) {
      let text: string
      try {
        text = readFileSync(join(this.#dir, name), 'utf8')
      } catch {
        continue
      }
      if (text !== '' && !text.endsWith('\n')) {
        try {
          this.#append(join(this.#dir, name), '\n')
        } catch (err) {
          this.#torn = true
          this.#fail('write failed', err)
        }
      }
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        try {
          const e: unknown = JSON.parse(line)
          if (isEvent(e)) this.#events.set(e.id, e)
        } catch {
          // a line cut short
        }
      }
    }
    for (const e of [...this.#events.values()].sort((a, b) => a.openedMs - b.openedMs)) this.#list(e)
  }
}

const isText = (v: unknown): boolean => v === null || typeof v === 'string'
const isNum = (v: unknown): boolean => v === null || typeof v === 'number'

/** Whether a parsed log line has an event's shape: the file can be cut short, edited or from another version. */
function isEvent(v: unknown): v is AlertEvent {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  const d = e.drop as Record<string, unknown> | null | undefined
  return (
    typeof e.id === 'string' && typeof e.hex === 'string' && typeof e.kind === 'string' &&
    typeof e.openedMs === 'number' && typeof e.lastMs === 'number' && typeof e.late === 'boolean' && typeof e.quiet === 'boolean' &&
    isText(e.callsign) && isText(e.reg) && isText(e.type) && isText(e.squawk) && isText(e.emergency) &&
    isNum(e.lat) && isNum(e.lon) && isNum(e.altFt) &&
    (d === null || (typeof d === 'object' && typeof d.fromFt === 'number' && typeof d.toFt === 'number' && typeof d.overS === 'number'))
  )
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

/** How old an aircraft's last message is, s (readsb's seen); 0 when it does not say. */
const ageS = (seen: unknown): number => (typeof seen === 'number' && Number.isFinite(seen) && seen > 0 ? seen : 0)

/** Its position, else the one readsb kept when GNSS failed (lastPosition: over 60 s old). */
function positionOf(ac: ReadsbAircraft): { lat: number; lon: number } | null {
  if (typeof ac.lat === 'number' && typeof ac.lon === 'number') return { lat: ac.lat, lon: ac.lon }
  const lp = (ac as { lastPosition?: { lat?: unknown; lon?: unknown } }).lastPosition
  return typeof lp?.lat === 'number' && typeof lp.lon === 'number' ? { lat: lp.lat, lon: lp.lon } : null
}

/** An address that is not an aircraft's: not ICAO (a '~' one), or a placeholder some transponders send. */
const badAddress = (hex: string): boolean => !ICAO.test(hex) || NOT_AIRCRAFT.has(hex)

/** Never read: a bad address, or a surface vehicle (C1 to C3). */
const ignored = (hex: string, category: string | null): boolean => badAddress(hex) || SURFACE.has(category ?? '')

/**
 * Quiet: a light aircraft (or glider…) by its category (the broadcast one, or the type table's for a late finding), whose only
 * causes are minor (a radio failure, no radio, minimum fuel).
 */
function quietFor(category: string | null, squawk: string | null, emergency: string | null): boolean {
  return LIGHT.has(category ?? '') && (squawk === null || MINOR.has(squawk)) && (emergency === null || MINOR.has(emergency))
}

/** The highest and lowest of an aircraft's altitudes (its end of the half hour before, then this one's): [-Infinity, Infinity] for none. */
function extent(...parts: (AltSeries | undefined)[]): [number, number] {
  let hi = -Infinity
  let lo = Infinity
  for (const s of parts) {
    for (const ft of s?.ft ?? []) {
      if (ft > hi) hi = ft
      if (ft < lo) lo = ft
    }
  }
  return [hi, lo]
}

/** The descent in a clean series by the rules of its kind of aircraft: an airliner's D1, else its D3; any other's D1_OTHER. */
function descentIn(s: AltSeries, liner: boolean): Drop | null {
  return liner ? (steepDescent(s) ?? steepDescent(s, D3)) : steepDescent(s, D1_OTHER)
}

/**
 * The ends of a half hour, for the late check of the next (scanSlot): each aircraft with a point in its last 150 s (an airliner's
 * fall has its top at any level), with its points of those 150 s, their times moved into the next half hour (t − 1800 s, so
 * negative), and its newest place and callsign.
 */
function tailsOf(scan: SlotScan): Tails {
  const out = new Map<string, Heard>()
  const from = scan.endS - TAIL_S
  for (const [hex, a] of scan.aircraft) {
    const { t, ft } = a.alt
    let i = t.length
    while (i > 0 && t[i - 1] >= from) i--
    if (i === t.length) continue
    out.set(hex, { alt: { t: t.slice(i).map((x) => x - SLOT_S), ft: ft.slice(i) }, lat: a.lat, lon: a.lon, callsign: a.callsign })
  }
  return out
}

/**
 * Pushes to an ntfy topic (NTFY_URL: ntfy.sh or your own server; docs.ntfy.sh/publish): one POST for each new event that is
 * not quiet and each new cause on one, its title and priority in headers (urgent for 7700, 7500, a fall, and the general,
 * unlawful and downed statuses). A failure is logged; there is no retry.
 */
export function ntfyPush(url: string, fetchFn: typeof fetch = (input, init) => fetch(input, init)): (e: AlertEvent) => void {
  return (e) => {
    const urgent = e.drop !== null || e.squawk === '7700' || e.squawk === '7500' || ['general', 'unlawful', 'downed'].includes(e.emergency ?? '')
    fetchFn(url, {
      method: 'POST',
      body: pushBody(e),
      headers: { Title: pushTitle(e), Priority: urgent ? 'urgent' : 'high', Tags: 'airplane' },
      signal: AbortSignal.timeout(10_000),
    }).then(
      (res) => {
        if (!res.ok) console.error(`alerts: ntfy answered ${res.status}`)
        void res.body?.cancel().catch(() => {})
      },
      (err: unknown) => console.error('alerts: ntfy failed:', (err as Error).message),
    )
  }
}

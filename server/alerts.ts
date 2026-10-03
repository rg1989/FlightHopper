// server/alerts.ts
// The alerts' switch, their events and their log (docs/superpowers/specs/2026-10-03-alerts-design.md). The poller feeds
// it: observe() gets every aircraft of every good answer, the worldwide squawk sweep's included, and sample() each new
// stored sample. scanSlot() reads each new adsb.lol half-hour file (the late check). Nothing here runs a timer; the only
// request is the push, which the caller gives (ntfyPush).
//   EVENTS_DIR/state.json        {"on":true}: the switch, kept across restarts (default off)
//   EVENTS_DIR/YYYY-MM-DD.jsonl  one AlertEvent per line, written when it opens or changes (the UTC day of the write); the
//                                newest line of an id wins. The last 8 days are read at start.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMERGENCY_SQUAWKS, EMERGENCY_STATUSES, pushBody, pushTitle, type AlertDrop, type AlertEvent, type EventsReply } from '../shared/alerts.ts'
import { callsignOf } from '../shared/readsb.ts'
import type { ReadsbAircraft, Sample } from '../shared/types.ts'
import { D2, clean, diveThenLost, steepDescent, type AltSeries, type Drop } from './descent.ts'
import { scanSlot } from './heatmap.ts'

const DAY_MS = 86_400_000
const CONFIRM_MS = 25_000 // a cause counts once it is seen again this long after it was first seen (glitches are brief)
const PENDING_MS = 2 * 60_000 // a first sighting not seen again within this is forgotten
const EPISODE_MS = 30 * 60_000 // an event takes in sightings this close to it; later, a new one opens
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
const NO_TYPE = Object.freeze({ type: null, category: null })

// An aircraft's type designator, emitter category and military flag (typeDb.ts lookup); a missing military is false.
type Typed = { type: string | null; category: string | null; military?: boolean }
type Who = Pick<AlertEvent, 'callsign' | 'reg' | 'type' | 'lat' | 'lon' | 'altFt'>
type Patch = Who & { squawk?: string | null; emergency?: string | null; drop?: AlertDrop | null }

export interface AlertsOpts {
  dir: string // EVENTS_DIR
  nowMs?: () => number
  codes?: readonly string[] // the squawks swept and read as emergencies (ALERT_SQUAWKS); default 7700, 7600, 7500
  sweep: boolean // the source sweeps them worldwide (adsb.fi)
  push?: (e: AlertEvent) => void // a new event that is not quiet, or a new cause on one (ntfyPush)
  typeOf?: (hex: string) => Typed // the type table's lookup (typeDb.ts): a late finding's type, category and military flag; a live fall's military flag
}

export class Alerts {
  #dir: string
  #now: () => number
  #codes: ReadonlySet<string>
  #codeList: readonly string[]
  #sweep: boolean
  #push: (e: AlertEvent) => void
  #typeOf: (hex: string) => Typed
  #on = false
  #rev = 0
  #revMs = -Infinity // when the rev last changed (server clock)
  #events = new Map<string, AlertEvent>() // by id
  #byHex = new Map<string, AlertEvent[]>() // by hex: its events, oldest first (by openedMs)
  #pending = new Map<string, { firstMs: number; lastMs: number }>() // by hex: a first sighting waiting to be seen again
  #writtenMs = new Map<string, number>() // by id: when its last line was written
  #scanned: number[] = [] // the half hours read, the newest last
  #failedMs = new Map<string, number>() // by kind of failure: when it was last logged

  constructor(o: AlertsOpts) {
    this.#dir = o.dir
    this.#now = o.nowMs ?? Date.now
    this.#codeList = [...(o.codes ?? EMERGENCY_SQUAWKS)]
    this.#codes = new Set(this.#codeList)
    this.#sweep = o.sweep
    this.#push = o.push ?? (() => {})
    this.#typeOf = o.typeOf ?? (() => NO_TYPE)
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
   * once it is seen again 25 s or more after it was first seen: its event opens then, or the aircraft's event within 30 min
   * takes it in. Not read: aircraft on the ground, surface vehicles, addresses that are not ICAO, 000000 and 000001. Military
   * aircraft and fast jets are read: their squawks and statuses are emergencies.
   * ponytail: the 25 s is for opening only; a new cause on an open event counts at once.
   */
  observe(ac: ReadsbAircraft, rxMs: number): void {
    if (!this.#on) return
    const hex = ac.hex.toLowerCase()
    if (ignored(hex, ac.category ?? null) || ac.alt_baro === 'ground') return
    const squawk = ac.squawk !== undefined && this.#codes.has(ac.squawk) ? ac.squawk : null
    const emergency = ac.emergency !== undefined && EMERGENCY_STATUSES.includes(ac.emergency) ? ac.emergency : null
    if (squawk === null && emergency === null) return
    const at = positionOf(ac)
    const who: Who = {
      callsign: callsignOf(ac.flight), reg: str(ac.r), type: str(ac.t),
      lat: at?.lat ?? null, lon: at?.lon ?? null, altFt: typeof ac.alt_baro === 'number' ? ac.alt_baro : null,
    }
    const open = this.#near(hex, rxMs, rxMs)
    if (open !== null) return this.#merge(open, rxMs, { ...who, squawk, emergency }, false)
    for (const [h, p] of this.#pending) if (rxMs - p.lastMs > PENDING_MS) this.#pending.delete(h)
    const p = this.#pending.get(hex)
    if (p === undefined) return void this.#pending.set(hex, { firstMs: rxMs, lastMs: rxMs })
    p.lastMs = rxMs
    if (rxMs - p.firstMs < CONFIRM_MS) return
    this.#pending.delete(hex)
    this.#open({
      id: `${hex}-${p.firstMs}`, hex, kind: squawk !== null ? 'squawk' : 'status', ...who, squawk, emergency, drop: null,
      openedMs: p.firstMs, lastMs: rxMs, late: false, quiet: quietFor(ac.category ?? null, squawk, emergency),
    })
  }

  /**
   * A new stored sample of a polled aircraft (Poller opts.onSample). At a baro_rate of −3,000 fpm or steeper, its recent
   * track (asked for only then) is checked for an emergency descent (descent.ts D1). Not for military aircraft (dbFlags, or the
   * type table's flag), fighter and trainer types (FAST_JETS, by the broadcast type code), light aircraft or gliders, surface
   * vehicles, addresses that are not ICAO, 000000 and 000001.
   */
  sample(s: Sample, track: () => readonly Sample[], dbFlags = 0): void {
    if (!this.#on || s.onGround || s.altBaroFt === null || !((s.baroRateFpm ?? 0) <= LIVE_RATE_FPM)) return
    const category = s.category ?? null
    if ((dbFlags & MILITARY) !== 0 || FAST_JETS.has(s.typeCode ?? '') || LIGHT.has(category ?? '') || ignored(s.hex, category)) return
    if (this.#typed(s.hex).military === true) return
    const series: AltSeries = { t: [], ft: [] }
    for (const x of track()) {
      if (x.onGround || x.altBaroFt === null) continue
      series.t.push(x.tMs / 1000)
      series.ft.push(x.altBaroFt)
    }
    const d = steepDescent(clean(series))
    if (d === null) return
    this.#fell(s.hex, 'descent', d, 0, { callsign: s.callsign, reg: s.reg, type: s.typeCode, lat: s.lat, lon: s.lon, altFt: s.altBaroFt }, false)
  }

  /**
   * The late check of one half-hour file (slotMs its start; each half hour is read once). An aircraft with two or more ident
   * records carrying an emergency squawk while airborne, and each emergency descent (D1) or dive then lost (D2) in its
   * altitudes, opens a late event, or joins the aircraft's event that its span is within 30 min of. Not read: surface vehicles
   * (the type table's C1 to C3), 000000 and 000001. No fall is looked for in an aircraft the type table calls military or whose
   * type is in FAST_JETS; its squawks are read. A late 7600 on a type the table calls light (A1, B1…) is quiet.
   * ponytail: the half hours must come in time order (the caller scans the older first): a merge never moves an event's
   * openedMs earlier, so an older half hour scanned after a newer leaves the event opening later than the episode began.
   */
  scanSlot(buf: Uint8Array, slotMs: number): void {
    if (!this.#on || this.#scanned.includes(slotMs)) return
    this.#scanned.push(slotMs)
    if (this.#scanned.length > 4) this.#scanned.shift()
    const scan = scanSlot(buf, slotMs, this.#codes)
    if (scan === null) return
    for (const [hex, a] of scan.aircraft) {
      const idents = a.squawks.length >= 2
      const mayDrop = mayFall(a.alt)
      if (!idents && !mayDrop) continue // the cheap test first: most aircraft are neither
      const typed = this.#typed(hex)
      if (ignored(hex, typed.category)) continue
      // ponytail: the type table's category makes a late 7600 quiet on a light type, but it gives every piston, turboprop and
      // electric type A1, so the ATR 72 and the Dash 8 are quiet too: accepted, radio failures are the least urgent cause (live
      // sightings use the broadcast category). It is not used to skip a fall: that needs a top at or above FL200 (D1) or FL150
      // (D2), which leaves light aircraft out in practice, and the Dash 8 is found.
      // ponytail: a late event's place and level are the aircraft's newest of the half hour, not where its cause was.
      const who: Who = { callsign: a.callsign, reg: null, type: typed.type, lat: a.lat, lon: a.lon, altFt: a.alt.ft.at(-1) ?? null }
      if (idents) {
        const first = slotMs + a.squawks[0].tS * 1000
        const last = slotMs + a.squawks[a.squawks.length - 1].tS * 1000
        const squawk = a.squawks[a.squawks.length - 1].squawk
        const open = this.#near(hex, first, last)
        if (open !== null) this.#merge(open, last, { ...who, squawk }, true)
        else {
          this.#open({
            id: `${hex}-${first}`, hex, kind: 'squawk', ...who, squawk, emergency: null, drop: null,
            openedMs: first, lastMs: last, late: true, quiet: quietFor(typed.category, squawk, null),
          })
        }
      }
      if (!mayDrop || typed.military === true || FAST_JETS.has(typed.type ?? '')) continue
      const s = clean(a.alt)
      const d1 = steepDescent(s)
      const d = d1 ?? diveThenLost(s, scan.endS)
      if (d !== null) this.#fell(hex, d1 !== null ? 'descent' : 'dive', d, slotMs, who, true)
    }
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

  /** One line in today's file (UTC). A failure is logged once a minute at most and the event stays in memory; the next change tries again. */
  #write(e: AlertEvent): void {
    const now = this.#now()
    try {
      appendFileSync(join(this.#dir, `${new Date(now).toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(e)}\n`)
      this.#writtenMs.set(e.id, now)
    } catch (err) {
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
   * skipped. A file that ends in a cut line gets a newline, or the next line written would join it and be lost with it.
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
          appendFileSync(join(this.#dir, name), '\n')
        } catch (err) {
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

/** Its position, else the one readsb kept when GNSS failed (lastPosition: over 60 s old). */
function positionOf(ac: ReadsbAircraft): { lat: number; lon: number } | null {
  if (typeof ac.lat === 'number' && typeof ac.lon === 'number') return { lat: ac.lat, lon: ac.lon }
  const lp = (ac as { lastPosition?: { lat?: unknown; lon?: unknown } }).lastPosition
  return typeof lp?.lat === 'number' && typeof lp.lon === 'number' ? { lat: lp.lat, lon: lp.lon } : null
}

/** Never read: an address that is not ICAO (a '~' one), a placeholder some transponders send, a surface vehicle (C1 to C3). */
const ignored = (hex: string, category: string | null): boolean => !ICAO.test(hex) || NOT_AIRCRAFT.has(hex) || SURFACE.has(category ?? '')

/**
 * Quiet: a light aircraft (or glider…) by its category (the broadcast one, or the type table's for a late finding), whose only
 * causes are minor (a radio failure, no radio, minimum fuel).
 */
function quietFor(category: string | null, squawk: string | null, emergency: string | null): boolean {
  return LIGHT.has(category ?? '') && (squawk === null || MINOR.has(squawk)) && (emergency === null || MINOR.has(emergency))
}

/** Whether a half hour's altitudes could hold a fall at all: D2 is the loosest rule, FL150 and 3,000 ft between the highest and lowest. */
function mayFall(s: AltSeries): boolean {
  let hi = -Infinity
  let lo = Infinity
  for (const ft of s.ft) {
    if (ft > hi) hi = ft
    if (ft < lo) lo = ft
  }
  return hi >= D2.topFt && hi - lo >= D2.fallFt
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

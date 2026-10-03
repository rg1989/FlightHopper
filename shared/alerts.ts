// shared/alerts.ts
// Events found worldwide (server/alerts.ts) and shown in the Events panel (client/ui/alerts.ts): an emergency squawk or
// ADS-B emergency status, or a steep descent (server/descent.ts). Shared so that the phone push and the panel word an
// event alike. Research: docs/anomaly-alerts.md; design: docs/superpowers/specs/2026-10-03-alerts-design.md.

/** The squawks swept worldwide and read as emergencies by default (ALERT_SQUAWKS): emergency, radio failure, hijack. */
export const EMERGENCY_SQUAWKS: readonly string[] = ['7700', '7600', '7500']
/** readsb's ADS-B emergency statuses that are events. Not lifeguard (a medical flight's priority), reserved or none. */
export const EMERGENCY_STATUSES: readonly string[] = ['general', 'minfuel', 'nordo', 'unlawful', 'downed']
/** An event is ongoing while its aircraft was seen with its cause this recently. */
export const ONGOING_MS = 2 * 60_000

export type AlertKind = 'squawk' | 'status' | 'descent' | 'dive'

export interface AlertDrop {
  fromFt: number
  toFt: number
  overS: number // from the top of the fall to its bottom
  lost: boolean // true for a dive then lost (D2): no position followed the fall
}

export interface AlertEvent {
  id: string // `${hex}-${openedMs}`
  hex: string
  kind: AlertKind // what opened it; later causes only fill the fields below
  callsign: string | null
  reg: string | null
  type: string | null // ICAO type designator
  squawk: string | null // the newest emergency squawk seen
  emergency: string | null // the newest emergency status seen
  drop: AlertDrop | null // a descent or a dive: the fall
  lat: number | null // where it was last seen with a cause (a fall found late: its newest position in the half hour)
  lon: number | null
  altFt: number | null
  openedMs: number // UTC ms: first seen with a cause, or the top of the fall
  lastMs: number // UTC ms: the newest sighting with a cause
  late: boolean // found in an adsb.lol half-hour file, 1 to 31 min after the fact
  quiet: boolean // listed only: no toast, notification, push or follow (a light aircraft's radio failure)
}

export interface EventsReply {
  on: boolean // the switch: the server watches the world
  sweep: boolean // the source sweeps the emergency squawks worldwide (adsb.fi); without it, polled aircraft and the late check only
  rev: number // changes with the switch and with events (StatusBrief.alertsRev): ask again when it does
  events: AlertEvent[] // the last 7 days, newest first
}

/** Seen with its cause in the last 2 min and not found after the fact: its aircraft can be followed live. */
export function ongoing(e: AlertEvent, nowMs: number): boolean {
  return !e.late && nowMs - e.lastMs < ONGOING_MS
}

const SQUAWK_TEXT: Record<string, string> = { '7700': 'Emergency', '7600': 'Radio failure', '7500': 'Hijack code' }
const STATUS_TEXT: Record<string, string> = {
  general: 'Emergency',
  minfuel: 'Minimum fuel',
  nordo: 'No radio',
  unlawful: 'Unlawful interference',
  downed: 'Downed aircraft',
}

/** A table's own entry for the key: not an inherited name such as 'constructor'. */
const text = (table: Record<string, string>, key: string): string | undefined => (Object.hasOwn(table, key) ? table[key] : undefined)

const feet = (ft: number): string => `${Math.round(ft).toLocaleString('en-US')} ft`
const level = (ft: number): string => `FL${String(Math.max(0, Math.round(ft / 100))).padStart(3, '0')}` // FL000 below sea level

/** "30 s", "2 min", "1 min 50 s". */
function span(s: number): string {
  const r = Math.round(s)
  if (r < 60) return `${r} s`
  const rest = r % 60
  return rest === 0 ? `${Math.floor(r / 60)} min` : `${Math.floor(r / 60)} min ${rest} s`
}

/** The aircraft: callsign, else registration, else address; then the type. "FDB1073 · B38M". */
export function who(e: AlertEvent): string {
  const name = e.callsign ?? e.reg ?? e.hex.toUpperCase()
  return e.type === null ? name : `${name} · ${e.type}`
}

/**
 * What happened, in a few words: a fall first when there is one, then the status (else the squawk's meaning), then the code.
 * "Emergency · 7700", "Unlawful interference · 7500", "Fell 12,300 ft in 1 min 50 s from FL350", "Dived 4,633 ft in 30 s, then lost · 7700".
 */
export function what(e: AlertEvent): string {
  const status = e.emergency === null ? null : (text(STATUS_TEXT, e.emergency) ?? e.emergency)
  const parts: string[] = []
  if (e.drop !== null) {
    const fell = e.drop.fromFt - e.drop.toFt
    parts.push(e.drop.lost ? `Dived ${feet(fell)} in ${span(e.drop.overS)}, then lost` : `Fell ${feet(fell)} in ${span(e.drop.overS)} from ${level(e.drop.fromFt)}`)
    if (status !== null) parts.push(status)
  } else if (status !== null) parts.push(status)
  else if (e.squawk !== null) parts.push(text(SQUAWK_TEXT, e.squawk) ?? 'Squawk')
  if (e.squawk !== null) parts.push(e.squawk)
  return parts.join(' · ')
}

/** ASCII only (an HTTP header carries the push's title): ' · ' becomes ' - ', anything else outside ASCII goes. */
const ascii = (s: string): string => s.replace(/ · /g, ' - ').replace(/[^\x20-\x7e]/g, '')

/** The push's title: "Emergency - 7700: FDB1073 - B38M". */
export function pushTitle(e: AlertEvent): string {
  return ascii(`${what(e)}: ${who(e)}`)
}

/** The push's text: its level, where and when (UTC). "FL300 at 29.95 N 38.12 E, 05:31 UTC", "FL300, position unknown, 05:31 UTC". */
export function pushBody(e: AlertEvent): string {
  const at = new Date(e.lastMs).toISOString().slice(11, 16)
  const place = e.lat === null || e.lon === null
    ? null
    : `${Math.abs(e.lat).toFixed(2)} ${e.lat >= 0 ? 'N' : 'S'} ${Math.abs(e.lon).toFixed(2)} ${e.lon >= 0 ? 'E' : 'W'}`
  const where = place === null ? 'position unknown' : `at ${place}`
  const alt = e.altFt === null ? '' : `${level(e.altFt)}${place === null ? ', ' : ' '}`
  return `${alt}${where}, ${at} UTC${e.late ? ' (found after the fact)' : ''}`
}

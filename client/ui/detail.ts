// client/ui/detail.ts
// The selected aircraft's details as pure text: callsign and hex, identity, then Spatial, Signal, FMS SEL and Wind
// sections. flightCard.ts shows them (expanded) under its photo.
import type { AircraftInfo } from '../../shared/info.ts'
import type { Quality, ReadsbAircraft } from '../../shared/types.ts'
import type { RenderState } from '../types.ts'

/** Country and airline for one aircraft, found by the caller (B-A wires countryOf/flagEmoji and airlineOf). */
export interface Lookup {
  country: { iso2: string; name: string; flag: string } | null
  airline: string | null
}

export type SectionId = 'header' | 'identity' | 'spatial' | 'signal' | 'fms' | 'wind'

export interface DetailRow {
  key: string // stable id, e.g. 'gs'; the same rows come back on every call
  label: string
  value: string // '—' when unknown
  alert: boolean // emergency squawk: shown highlighted
  hint: string | null // tooltip with a caveat, e.g. why a value may be off
}

export interface DetailSection {
  id: SectionId
  title: string // '' for the header and the identity block (not collapsible)
  rows: DetailRow[]
}

export const UPDATE_MS = 250 // at most 4 text updates a second; a new selection shows at once
const DASH = '—'
const TREND_FPM = 250 // |vertical rate| below this is level flight: no ▲/▼ after the altitude

// ICAO special-purpose codes (ICAO Doc 4444 / Annex 10).
const SQUAWK_MEANING: Record<string, string> = { '7500': 'hijack', '7600': 'radio failure', '7700': 'emergency' }
// adsb.lol / readsb database flags (bit → meaning).
const DB_FLAGS: [number, string][] = [[1, 'military'], [2, 'interesting'], [4, 'PIA'], [8, 'LADD']]
const QUALITY_LABEL: Record<Quality, string> = { adsb2: 'ADS-B v2', adsb01: 'ADS-B v0/1', mlat: 'MLAT', other: 'other' }

const num = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v)
const str = (v: string | null | undefined): string | null => {
  const t = typeof v === 'string' ? v.trim() : ''
  return t === '' ? null : t
}
// One formatter for the module: Number#toLocaleString builds a new one per call (~8 µs each in Chrome).
const GROUPED = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const int = (v: number): string => GROUPED.format(Math.round(v) || 0) // `|| 0` turns -0 into 0
const deg3 = (d: number): string => `${String((((Math.round(d) % 360) + 360) % 360)).padStart(3, '0')}°`
const signed = (v: number): string => `${v > 0 ? '+' : ''}${int(v)}`

/** "ADS-B v2", "MLAT", "TIS-B"… from readsb's message type (best), else from the track's quality. */
export function sourceLabel(raw: ReadsbAircraft | null, quality: Quality | null): string | null {
  const t = raw?.type
  if (t !== undefined) {
    if (t.startsWith('adsb')) return num(raw?.version) ? `ADS-B v${raw.version}` : 'ADS-B'
    if (t.startsWith('adsr')) return 'ADS-R'
    if (t.startsWith('tisb')) return 'TIS-B'
    if (t === 'mlat') return 'MLAT'
    if (t === 'mode_s') return 'Mode S'
    if (t === 'adsc') return 'ADS-C'
    return 'other'
  }
  return quality === null ? null : QUALITY_LABEL[quality]
}

/** Link that opens the app chasing this aircraft (client/app.ts reads ?hex=). */
export function shareLink(origin: string, hex: string): string {
  return `${origin}/?hex=${encodeURIComponent(hex)}`
}

/** The selected hex (lower case) from whichever of the three the caller has. */
function hexOf(s: RenderState | null, raw: ReadsbAircraft | null, info: AircraftInfo | null): string | null {
  return s?.hex ?? info?.hex ?? raw?.hex.toLowerCase() ?? null
}

function callsignOf(s: RenderState | null, raw: ReadsbAircraft | null, info: AircraftInfo | null): string | null {
  return info?.callsign ?? s?.callsign ?? str(raw?.flight)
}

/**
 * Every section and row of the panel, always in the same shape; unknown values are '—'.
 * s (render state) wins for what moves (speed, altitude, track, position); info wins for identity; raw (the newest
 * upstream object) supplies the rest. A raw object or info for another hex is ignored.
 * ponytail: signal ages (last position, last seen) are as reported in the newest upstream object and do not tick
 * between polls. Upgrade: add the object's age when the caller passes it.
 */
export function detailRows(s: RenderState | null, raw: ReadsbAircraft | null, info: AircraftInfo | null, lookup: Lookup): DetailSection[] {
  const hex = hexOf(s, raw, info)
  if (raw !== null && raw.hex.toLowerCase() !== hex) raw = null
  if (info !== null && info.hex !== hex) info = null

  const row = (key: string, label: string, value: string | null, alert = false, hint: string | null = null): DetailRow => ({
    key, label, value: value ?? DASH, alert, hint,
  })

  // Identity
  const country = lookup.country === null ? null : `${lookup.country.flag} ${lookup.country.name}`.trim()
  const dbFlags = raw?.dbFlags ?? (info?.military ? 1 : 0)
  const flags = DB_FLAGS.filter(([bit]) => (dbFlags & bit) !== 0).map(([, name]) => name)
  const squawk = info ? info.squawk : str(raw?.squawk)
  const rawEmergency = str(raw?.emergency)
  const emergency = info ? info.emergency : rawEmergency === 'none' ? null : rawEmergency
  const meaning = emergency ?? (squawk === null ? undefined : SQUAWK_MEANING[squawk])
  const squawkText = squawk === null ? (emergency ?? null) : meaning ? `${squawk} · ${meaning}` : squawk
  const route = info?.route ? info.route.split('-').join(' – ') : null

  // Spatial
  const gs = s?.gsKt ?? raw?.gs
  const onGround = s ? s.onGround : raw?.alt_baro === 'ground'
  const altBaro = s?.altBaroFt ?? (typeof raw?.alt_baro === 'number' ? raw.alt_baro : null)
  const rate = raw?.baro_rate ?? raw?.geom_rate ?? (num(s?.vsFpm) ? Math.round(s.vsFpm / 10) * 10 : null)
  const trend = num(rate) && Math.abs(rate) >= TREND_FPM ? (rate > 0 ? ' ▲' : ' ▼') : ''
  const altBaroText = onGround ? 'ground' : num(altBaro) ? `${int(altBaro)} ft${trend}` : null
  const geomHint = num(raw?.alt_geom) && raw.version !== 2 ? 'GNSS height: its datum is certain only for ADS-B v2' : null
  const track = s?.trackDeg ?? raw?.track
  const lat = s ? s.lat : raw?.lat
  const lon = s ? s.lon : raw?.lon

  // Signal
  const quality = s?.quality ?? null

  // FMS
  const selAlt = raw?.nav_altitude_mcp ?? raw?.nav_altitude_fms
  const modes = raw?.nav_modes?.length ? raw.nav_modes.join(' ') : null

  return [
    { id: 'header', title: '', rows: [
      row('callsign', 'Callsign', callsignOf(s, raw, info)),
      row('hex', 'Hex', hex === null ? null : hex.toUpperCase()),
    ] },
    { id: 'identity', title: '', rows: [
      row('reg', 'Reg.', info?.reg ?? str(raw?.r)),
      row('country', 'Country', country),
      row('airline', 'Airline', lookup.airline),
      row('dbFlags', 'DB flags', flags.length ? flags.join(' · ') : null),
      row('type', 'Type', info?.typeCode ?? s?.typeCode ?? str(raw?.t)),
      row('squawk', 'Squawk', squawkText, emergency !== null || meaning !== undefined),
      row('route', 'Route', route),
    ] },
    { id: 'spatial', title: 'Spatial', rows: [
      row('gs', 'Groundspeed', num(gs) ? `${int(gs)} kt` : null),
      row('altBaro', 'Baro. altitude', altBaroText),
      row('altGeom', 'WGS84 altitude', num(raw?.alt_geom) ? `${int(raw.alt_geom)} ft` : null, false, geomHint),
      row('vs', 'Vertical rate', num(rate) ? `${signed(rate)} ft/min` : null),
      row('track', 'Track', num(track) ? deg3(track) : null),
      row('pos', 'Position', num(lat) && num(lon) ? `${lat.toFixed(3)}°, ${lon.toFixed(3)}°` : null),
    ] },
    { id: 'signal', title: 'Signal', rows: [
      row('source', 'Source', sourceLabel(raw, quality)),
      row('rssi', 'RSSI', num(raw?.rssi) ? `${raw.rssi.toFixed(1)} dBFS` : null),
      row('messages', 'Messages', num(raw?.messages) ? int(raw.messages) : null),
      row('posAge', 'Last position', num(raw?.seen_pos) ? `${raw.seen_pos.toFixed(1)} s` : null),
      row('seen', 'Last seen', num(raw?.seen) ? `${raw.seen.toFixed(1)} s` : null),
    ] },
    { id: 'fms', title: 'FMS SEL', rows: [
      row('selAlt', 'Sel. altitude', num(selAlt) ? `${int(selAlt)} ft` : null),
      row('selHdg', 'Sel. heading', num(raw?.nav_heading) ? deg3(raw.nav_heading) : null),
      row('qnh', 'QNH', num(raw?.nav_qnh) ? `${raw.nav_qnh.toFixed(1)} hPa` : null),
      row('modes', 'Modes', modes),
    ] },
    { id: 'wind', title: 'Wind', rows: [
      row('wind', 'Wind', num(raw?.ws) && num(raw?.wd) ? `${int(raw.ws)} kt / ${deg3(raw.wd)}` : null),
      row('oat', 'OAT', num(raw?.oat) ? `${int(raw.oat)} °C` : null),
      row('tat', 'TAT', num(raw?.tat) ? `${int(raw.tat)} °C` : null),
    ] },
  ]
}

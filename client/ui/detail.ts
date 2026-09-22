// client/ui/detail.ts
// Left-hand detail panel for the selected aircraft: callsign and hex, photo with credit, identity, then Spatial,
// Signal, FMS SEL and Wind sections. detailRows() is the pure text; mountDetail() builds the DOM once and then only
// rewrites the value texts, at most 4 times a second.
import type { AircraftInfo } from '../../shared/info.ts'
import type { Quality, ReadsbAircraft } from '../../shared/types.ts'
import type { RenderState } from '../types.ts'
import type { PhotoCache } from './photo.ts'
import './detail.css'

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

export interface DetailOpts {
  onClose(): void
  photos?: PhotoCache
  lookup(hex: string, callsign: string | null): Lookup
}

export interface DetailHandle {
  update(s: RenderState | null, raw: ReadsbAircraft | null, info: AircraftInfo | null): void
  destroy(): void
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

const NO_LOOKUP: Lookup = { country: null, airline: null }

function h(tag: string, className = '', text = ''): HTMLElement {
  const el = document.createElement(tag)
  el.className = className
  el.textContent = text
  return el
}

/**
 * Mounts the (hidden) panel. update() may be called every frame: the text is rewritten at most every UPDATE_MS, with a
 * trailing render so the newest state always lands. A new selection renders at once and asks photos (once per hex).
 * Values go in with textContent only: callsigns and photo credits come from upstream and are never parsed as HTML.
 */
export function mountDetail(root: HTMLElement, opts: DetailOpts): DetailHandle {
  const panel = h('aside', 'fh-detail')
  panel.hidden = true
  panel.setAttribute('aria-label', 'Selected aircraft')

  const head = h('div', 'fh-detail-head')
  const callsign = h('span', 'fh-detail-callsign')
  const hexEl = h('span', 'fh-detail-hex')
  const copy = h('button', 'fh-detail-btn fh-detail-copy', 'Copy link')
  copy.setAttribute('type', 'button')
  copy.title = 'Copy a link that opens this aircraft'
  const close = h('button', 'fh-detail-btn fh-detail-close', '×')
  close.setAttribute('type', 'button')
  close.setAttribute('aria-label', 'Close')
  close.title = 'Close (back to the map)'
  head.append(callsign, hexEl, h('span', 'fh-detail-spacer'), copy, close)

  // Photo: a 3:2 box (the API's thumbnails are 3:2) so the layout does not jump when the image arrives.
  const figure = h('figure', 'fh-detail-photo')
  const imgLink = h('a', 'fh-detail-imglink')
  const img = h('img', 'fh-detail-img')
  img.setAttribute('alt', 'Aircraft photo')
  img.hidden = true
  imgLink.append(img)
  const note = h('span', 'fh-detail-note')
  const credit = h('a', 'fh-detail-credit')
  credit.hidden = true
  for (const a of [imgLink, credit]) {
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener')
  }
  figure.append(imgLink, note, credit)
  figure.hidden = opts.photos === undefined
  panel.append(head, figure)

  // Sections and rows, built once from the fixed shape of detailRows().
  const slots = new Map<string, { row: HTMLElement; value: HTMLElement; text: string; alert: boolean; hint: string | null }>()
  slots.set('callsign', { row: callsign, value: callsign, text: '', alert: false, hint: null })
  slots.set('hex', { row: hexEl, value: hexEl, text: '', alert: false, hint: null })
  for (const sec of detailRows(null, null, null, NO_LOOKUP)) {
    if (sec.id === 'header') continue
    let box: HTMLElement
    if (sec.title === '') box = h('div', 'fh-detail-section')
    else {
      box = h('details', 'fh-detail-section')
      ;(box as HTMLDetailsElement).open = true
      box.append(h('summary', 'fh-detail-title', sec.title))
    }
    for (const r of sec.rows) {
      const rowEl = h('div', 'fh-detail-row')
      rowEl.setAttribute('data-key', r.key)
      const value = h('span', 'fh-detail-value')
      rowEl.append(h('span', 'fh-detail-label', r.label), value)
      box.append(rowEl)
      slots.set(r.key, { row: rowEl, value, text: '', alert: false, hint: null })
    }
    panel.append(box)
  }
  root.append(panel)

  let curS: RenderState | null = null // newest arguments of update(); kept in three variables so a frame allocates nothing
  let curRaw: ReadsbAircraft | null = null
  let curInfo: AircraftInfo | null = null
  let shown: string | null = null // hex on screen
  let lastMs = -Infinity
  let timer: ReturnType<typeof setTimeout> | null = null
  let lk: Lookup = NO_LOOKUP
  let lkKey = ''
  let destroyed = false

  function showPhoto(hex: string): void {
    img.hidden = true
    img.removeAttribute('src')
    credit.hidden = true
    note.textContent = 'Loading photo…'
    opts.photos?.get(hex).then((p) => {
      if (destroyed || shown !== hex) return // the selection moved on
      if (p === null) {
        note.textContent = opts.photos?.failed(hex) ? 'Photo unavailable' : 'No photo'
        return
      }
      note.textContent = ''
      img.setAttribute('src', p.thumbUrl)
      img.hidden = false
      imgLink.setAttribute('href', p.link)
      credit.setAttribute('href', p.link)
      credit.textContent = `Image © ${p.photographer}`
      credit.hidden = false
    })
  }
  img.addEventListener('error', () => {
    img.hidden = true
    credit.hidden = true
    note.textContent = 'Photo unavailable'
  })

  function render(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
    lastMs = Date.now()
    const s = curS
    const raw = curRaw
    const info = curInfo
    const hex = hexOf(s, raw, info)
    if (hex === null) {
      panel.hidden = true
      shown = null
      return
    }
    panel.hidden = false
    if (hex !== shown) {
      shown = hex
      showPhoto(hex)
    }
    const cs = callsignOf(s, raw, info)
    const key = `${hex}/${cs}`
    if (key !== lkKey) {
      lk = opts.lookup(hex, cs)
      lkKey = key
    }
    for (const sec of detailRows(s, raw, info, lk)) {
      for (const r of sec.rows) {
        const slot = slots.get(r.key)
        if (slot === undefined) continue
        if (slot.text !== r.value) slot.value.textContent = slot.text = r.value
        if (slot.alert !== r.alert) slot.row.classList.toggle('fh-alert', (slot.alert = r.alert))
        if (slot.hint !== r.hint) slot.row.title = (slot.hint = r.hint) ?? ''
      }
    }
  }

  close.addEventListener('click', () => opts.onClose())
  copy.addEventListener('click', () => {
    if (shown === null) return
    const url = shareLink(location.origin, shown)
    const done = (): void => {
      copy.textContent = 'Copied'
      setTimeout(() => (copy.textContent = 'Copy link'), 1500)
    }
    // The async clipboard needs a secure context (https or localhost); elsewhere the user copies from a prompt.
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => window.prompt('Copy this link', url))
    else window.prompt('Copy this link', url)
  })

  return {
    update(s, raw, info) {
      if (destroyed) return
      curS = s
      curRaw = raw
      curInfo = info
      const hex = hexOf(s, raw, info)
      if (hex !== shown) return render() // selection changed (or cleared): at once
      if (hex === null) return
      const wait = lastMs + UPDATE_MS - Date.now()
      if (wait <= 0) render()
      else if (timer === null) timer = setTimeout(render, wait)
    },
    destroy() {
      destroyed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      panel.remove()
    },
  }
}

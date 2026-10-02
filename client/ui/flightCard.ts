// client/ui/flightCard.ts
// The focused aircraft's card, top-left: who it is (flag, callsign, type, airline), four live numbers (altitude, speed,
// vertical rate, track) under its photo (none: a struck-through camera by the registration), and a status line (Live ·
// Predicting · Signal lost · Locating) with the expand toggle beside it, which shows every detail section below
// (detail.ts detailRows). It replaces the old detail panel, HUD and chase
// banner. cardView() is the pure text; mountFlightCard() builds the DOM once and rewrites texts at most 4 times a second.
// The same card, mounted with `traffic`, shows a chase-traffic aircraft (a click in its brackets): top right, with its
// distance from the chased aircraft, and Chase to fly behind it instead.
// With onRecord (the server records flights: FLIGHTS_DIR), a Record button in the header records the aircraft to a
// file; while it records, a strip under the numbers shows for how long and how many points, with Stop.
import type { RecordingState, StatusBrief } from '../../shared/api.ts'
import type { AircraftInfo } from '../../shared/info.ts'
import type { ReadsbAircraft } from '../../shared/types.ts'
import type { FleetEntry, RenderState } from '../types.ts'
import { UPDATE_MS, detailRows, shareLink, sourceLabel, type Lookup } from './detail.ts'
import { STALE_AGE_S, formatDistanceM, hudFields, isStale } from './format.ts'
import { icon } from './icons.ts'
import type { PhotoCache } from './photo.ts'
import './flightCard.css'

/** Seconds after a selection with no position during which the card says "Locating…" (then "No recent position"). */
export const LOCATING_S = 12
const REPLAY_QUIET_S = 60 // History: a position older than this at the replay time reads "not heard"
/** A focused aircraft is asked (/api/chase) at least this often whatever the zoom: every poll while it is on screen. */
export const FOCUS_ASK_MS = 10_000

export type CardState = 'live' | 'predict' | 'lost' | 'locating' | 'none' | 'replay'

export interface CardStat {
  key: 'alt' | 'gs' | 'vs' | 'hdg'
  label: string
  value: string // '—' when unknown
  unit: string
  dim: boolean // stale or unknown: drawn muted
}

export interface CardView {
  hex: string | null
  callsign: string
  sub: string // "Airline · A321 · G-EZGY", the parts known
  flag: string
  type: string
  stats: CardStat[]
  state: CardState
  status: string
  range: { dist: string; from: string } | null // a traffic aircraft's card: "7,371 m", "from UAL2478"
}

/** A traffic aircraft's distance from the chased one (m), and the chased one's flight ID. */
export interface CardRange {
  distM: number
  from: string
}

const DASH = '—'
const NO_LOOKUP: Lookup = { country: null, airline: null }

function stat(fields: ReturnType<typeof hudFields>, label: string, lost: boolean): { value: string; dim: boolean } {
  const f = fields.find((x) => x.label === label)
  if (f === undefined || f.tag === 'unknown') return { value: DASH, dim: true }
  return { value: f.value, dim: lost } // computed values (VS) are fine; only a lost signal fades them
}

/** Splits "12,925 ft baro" → ["12,925", "ft"], "+1,020 fpm" → ["+1,020", "fpm"], "270°" → ["270", "°"]. */
function split(v: string): [string, string] {
  if (v === DASH) return [DASH, '']
  const m = /^([+\-−]?[\d,.]+)\s*(°|[a-z]+)?/.exec(v)
  return m === null ? [v, ''] : [m[1], m[2] ?? '']
}

/**
 * What the card shows. sinceSelectS: seconds since this aircraft was selected (for "Locating…" before its first
 * position). Chasing, the status line follows the track: interpolating → Live; extrapolating → Predicting; stale →
 * Signal lost. Only focused, the aircraft is refreshed with the view (every status.viewEveryS, zoom-scaled) and asked
 * itself at least every FOCUS_ASK_MS, so it is Live until 2.5 of the shorter go by without a position: a zoomed-out
 * view's long period no longer keeps a minutes-old position "Live". So is a traffic aircraft (entryState), which also
 * has its range. Still heard without a position (GPS jammed or spoofed, daily around Israel: the upstream drops those
 * positions), lost reads "GPS lost", not "Signal lost".
 */
export function cardView(
  selHex: string | null, s: RenderState | null, raw: ReadsbAircraft | null, info: AircraftInfo | null, status: StatusBrief, lookup: Lookup,
  sinceSelectS: number, chasing = true, range: CardRange | null = null, replay: string | null = null,
): CardView {
  const sections = detailRows(s, raw, info, lookup)
  const get = (key: string): string | null => {
    for (const sec of sections) for (const r of sec.rows) if (r.key === key) return r.value === DASH ? null : r.value
    return null
  }
  const hex = get('hex')?.toLowerCase() ?? selHex
  const fields = hudFields(s, status)
  const lostAfterS = Math.max(STALE_AGE_S, 2.5 * Math.min(status.viewEveryS ?? 0, FOCUS_ASK_MS / 1000))
  const lost = s !== null && (chasing ? isStale(s) : Number.isFinite(s.ageS) && s.ageS > lostAfterS)
  // Another aircraft's object (the card has just moved on, its own not in yet) says nothing of this one.
  const own = raw !== null && raw.hex.toLowerCase() === hex ? raw : null
  const alt = s?.onGround ? { value: 'GND', dim: lost } : stat(fields, 'ALT', lost)
  const [altV] = split(alt.value)
  const gs = stat(fields, 'GS', lost)
  const vs = stat(fields, 'VS', lost)
  const hdg = stat(fields, 'TRK', lost) // the reported direction of travel (HDG is a computed nose heading)
  const type = get('type') ?? ''
  const sub = [lookup.airline, get('reg')].filter((x): x is string => x !== null && x !== '').join(' · ')

  let state: CardState
  let text: string
  if (s === null) {
    state = sinceSelectS < LOCATING_S ? 'locating' : 'none'
    text = state === 'locating' ? 'Locating aircraft…' : 'No recent position'
  } else if (replay !== null) {
    // History: the status is the replay clock; a position over a minute old was not heard then (the files hold gaps).
    const quiet = Number.isFinite(s.ageS) && s.ageS > REPLAY_QUIET_S
    state = quiet ? 'lost' : 'replay'
    text = quiet ? `${replay} · not heard` : replay
  } else if (lost) {
    state = 'lost'
    // ponytail: `seen` is as of the last chase reply (≤ FOCUS_ASK_MS old), so "GPS" may outlast a real silence by that.
    const what = own?.seen !== undefined && own.seen < lostAfterS ? 'GPS lost' : 'Signal lost'
    text = Number.isFinite(s.ageS) ? `${what} ${Math.round(Math.max(0, s.ageS))} s ago` : what
  } else if (chasing && s.mode === 'extrap') {
    state = 'predict'
    text = 'Predicting · waiting for data'
  } else {
    state = 'live'
    text = ['Live', sourceLabel(own, s.quality)].filter(Boolean).join(' · ')
  }

  return {
    hex,
    callsign: get('callsign') ?? (hex === null ? '' : hex.toUpperCase()),
    sub,
    flag: lookup.country?.flag ?? '',
    type,
    stats: [
      { key: 'alt', label: 'Alt', value: altV, unit: alt.value === 'GND' || altV === DASH ? '' : 'ft', dim: alt.dim },
      { key: 'gs', label: 'Speed', value: split(gs.value)[0], unit: gs.value === DASH ? '' : 'kt', dim: gs.dim },
      { key: 'vs', label: 'V/S', value: split(vs.value)[0], unit: vs.value === DASH ? '' : 'fpm', dim: vs.dim },
      { key: 'hdg', label: 'Track', value: split(hdg.value)[0], unit: hdg.value === DASH ? '' : '°', dim: hdg.dim },
    ],
    state,
    status: text,
    range: range === null ? null : { dist: formatDistanceM(range.distM), from: `from ${range.from}` },
  }
}

/**
 * A traffic aircraft's fleet entry as the card's state (cardView with chasing false): its newest sample dead-reckoned
 * to the chase's render time, smoothed by its own track while it has one (TrackRegistry.applyTo). Copied: the Fleet
 * reuses its entries every frame. Its height's source is unknown here: the least-trusted one, as a new Track's.
 */
export function entryState(e: FleetEntry): RenderState {
  return {
    hex: e.hex, lat: e.lat, lon: e.lon, hM: e.hM,
    headingDeg: e.att?.headingDeg ?? e.trackDeg ?? 0, pitchDeg: e.att?.pitchDeg ?? 0, rollDeg: e.att?.rollDeg ?? 0,
    gsKt: e.gsKt, trackDeg: e.trackDeg, altBaroFt: e.altFt, vsFpm: e.vsFpm, mode: 'interp', altSource: 'baro-bias',
    onGround: e.onGround, ageS: e.ageS, quality: e.quality, callsign: e.info?.callsign ?? null, typeCode: e.info?.typeCode ?? null,
  }
}

// ---- DOM ----------------------------------------------------------------------------------------------------------

export interface FlightCardOpts {
  onClose(): void
  onChase(on: boolean): void // the Chase / Map button: into the 3-D chase view, or back to the top-down map
  photos?: PhotoCache
  lookup(hex: string, callsign: string | null): Lookup
  /** A chase-traffic aircraft's card (flightCard.css places it apart): its pill always reads Chase, and a range line shows. */
  traffic?: boolean
  /** Start (on) or stop recording this aircraft; resolves to its recording (null: none), or rejects. */
  onRecord?(hex: string, on: boolean): Promise<RecordingState | null>
}

export interface FlightCardHandle {
  /**
   * hex: the selected aircraft (null: none, the card hides); the rest may be null while unknown. range: a traffic
   * aircraft's distance from the chased one (null while unknown).
   */
  update(
    hex: string | null, s: RenderState | null, raw: ReadsbAircraft | null, info: AircraftInfo | null, status: StatusBrief, chasing: boolean,
    range?: CardRange | null,
  ): void
  /**
   * Places the shown card clear of (x, y) (viewport CSS px, padded by padPx: a clicked aircraft) and of avoid (the
   * flight-data frame's cards and aircraft, which stay put): the first of its places (flightCard.css) that clears both,
   * in order its own, the other end of its column (.fh-card-flip), the chased card's (.fh-card-home: that card waits
   * hidden). None does: of those clear of the point, the one covering the least of avoid; else its own. Until the next
   * call.
   */
  keepClear(x: number, y: number, padPx: number, avoid?: readonly { x: number; y: number; w: number; h: number }[]): void
  /**
   * The shown aircraft's recording, from the server (a chase reply of hex): null when it is not being recorded,
   * undefined when the server records nothing (no Record button). serverNowMs dates it.
   */
  setRecording(hex: string, rec: RecordingState | null | undefined, serverNowMs: number): void
  /** History: the status line reads text ("Replay · 17:43", amber) instead of Live; null: live again. */
  setReplay(text: string | null): void
  destroy(): void
}

/** "4:05" or "1:02:09" for a recording's length. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const mm = String(Math.floor(s / 60) % 60)
  const ss = String(s % 60).padStart(2, '0')
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = className
  if (text !== '') el.textContent = text
  return el
}

function iconButton(name: Parameters<typeof icon>[0], label: string): HTMLButtonElement {
  const b = h('button', 'fh-ibtn fh-sm')
  b.type = 'button'
  b.setAttribute('aria-label', label)
  b.title = label
  b.append(icon(name, 16))
  return b
}

// A traffic card's places (flightCard.css), in order of preference: its own, the other end of its column, the chased
// card's. How far it keeps from the flight-data frame's cards: under the frame's own 8 px from the chased card, whose
// place it may take.
const PLACES = ['', 'fh-card-flip', 'fh-card-home'] as const
const AVOID_PX = 4

/**
 * Mounts the (hidden) card. update() may be called every frame: texts are rewritten at most every UPDATE_MS, with a
 * trailing render so the newest state always lands. A new selection renders at once and asks for its photo (once per selection).
 * Values go in with textContent only: callsigns and photo credits come from upstream and are never parsed as HTML.
 */
export function mountFlightCard(root: HTMLElement, opts: FlightCardOpts): FlightCardHandle {
  const traffic = opts.traffic === true
  const card = h('aside', traffic ? 'fh-card fh-tcard fh-glass fh-blur' : 'fh-card fh-glass fh-blur')
  card.hidden = true
  card.setAttribute('aria-label', traffic ? 'Traffic aircraft' : 'Selected aircraft')

  const head = h('header', 'fh-card-head')
  const ident = h('div', 'fh-card-ident')
  const top = h('div', 'fh-card-top')
  const flag = h('span', 'fh-card-flag')
  const callsign = h('span', 'fh-card-callsign')
  const type = h('span', 'fh-card-type')
  top.append(flag, callsign, type)
  const sub = h('div', 'fh-card-sub')
  const subText = h('span', 'fh-card-sub-t')
  // No photo of this aircraft: a small mark by the registration instead of an empty box.
  const noPhoto = h('span', 'fh-card-nophoto')
  noPhoto.setAttribute('role', 'img')
  noPhoto.append(icon('cameraOff', 14))
  noPhoto.hidden = true
  sub.append(subText, noPhoto)
  ident.append(top, sub)
  const actions = h('div', 'fh-card-actions')
  const linkBtn = iconButton('link', traffic ? 'Copy a link to chase this aircraft' : 'Copy a link to this view')
  const closeBtn = iconButton('x', 'Close (Esc)')
  const recBtn = iconButton('record', 'Record this flight')
  recBtn.classList.add('fh-card-recbtn')
  recBtn.hidden = true
  recBtn.setAttribute('aria-pressed', 'false')
  actions.append(recBtn, linkBtn, closeBtn)
  // Beside the status line, above what it opens.
  const expandBtn = iconButton('chevronDown', 'Show details')
  expandBtn.classList.add('fh-card-expand')
  expandBtn.setAttribute('aria-expanded', 'false')
  head.append(ident, actions)

  // The primary action: Chase (into the 3-D view) while focused; Map (back to top-down) while chasing, in the same place.
  // A traffic aircraft's: Chase (it instead of the chased one).
  const chaseBtn = h('button', 'fh-pill')
  chaseBtn.type = 'button'
  const chaseIcon = h('span', 'fh-pill-icon')
  const chaseText = h('span', '')
  chaseBtn.append(chaseIcon, chaseText)
  let chaseShown: boolean | null = null
  const paintChase = (chasing: boolean): void => {
    if (chaseShown === chasing) return
    chaseShown = chasing
    chaseIcon.replaceChildren(icon(chasing ? 'map' : 'plane', 16))
    chaseText.textContent = chasing ? 'Map' : traffic ? 'Chase' : 'Chase in 3-D' // short: the status line and the toggle share the row
    chaseBtn.title = chasing ? 'Back to the top-down map (Esc)' : traffic ? 'Fly behind this aircraft instead' : 'Fly behind this aircraft in 3-D'
    chaseBtn.classList.toggle('fh-pill-secondary', chasing)
  }

  const stats = h('div', 'fh-card-stats')
  const statEls = new Map<string, { value: HTMLElement; unit: HTMLElement; box: HTMLElement }>()
  for (const [key, label] of [['alt', 'Alt'], ['gs', 'Speed'], ['vs', 'V/S'], ['hdg', 'Track']] as const) {
    const box = h('div', 'fh-card-stat')
    const v = h('div', 'fh-card-stat-v fh-num')
    const value = h('span', '', '—')
    const unit = h('span', 'fh-card-unit')
    const l = h('div', 'fh-card-stat-l', label)
    // The degree sign stays on the number; ft/kt/fpm go on the label line, so four values fit side by side.
    if (key === 'hdg') v.append(value, unit)
    else (v.append(value), l.append(unit))
    box.append(v, l)
    stats.append(box)
    statEls.set(key, { value, unit, box })
  }

  // A traffic aircraft's distance from the chased one, by the traffic brackets' mark.
  const range = h('div', 'fh-card-range')
  const rangeDist = h('span', 'fh-card-range-d fh-num')
  const rangeFrom = h('span', 'fh-card-range-f')
  range.append(icon('bracket', 14), rangeDist, rangeFrom)
  range.hidden = true

  // While recording: "● REC 4:05 · 318 points   Stop". After it ends: "Recording ended" for a few seconds.
  const recRow = h('div', 'fh-card-rec')
  recRow.hidden = true
  recRow.setAttribute('role', 'status')
  const recDot = h('span', 'fh-card-rec-dot')
  const recText = h('span', 'fh-card-rec-t fh-num')
  const stopBtn = h('button', 'fh-card-rec-stop')
  stopBtn.type = 'button'
  stopBtn.title = 'Stop recording (it also stops by itself once the aircraft has landed)'
  stopBtn.append(icon('stop', 14), h('span', '', 'Stop'))
  recRow.append(recDot, recText, stopBtn)

  const statusRow = h('div', 'fh-card-status')
  const dot = h('span', 'fh-dot')
  const spin = h('span', 'fh-spin')
  const statusText = h('span', 'fh-card-status-t')
  statusRow.append(dot, spin, statusText)

  // The photo, above the stats, collapsed or not: a 3:2 skeleton with a spinner until it arrives; none, and it goes.
  const figure = h('figure', 'fh-card-photo fh-skel')
  const imgLink = h('a', 'fh-card-imglink')
  const img = h('img', 'fh-card-img')
  img.alt = 'Aircraft photo'
  img.hidden = true
  imgLink.append(img)
  const credit = h('a', 'fh-card-credit')
  // The same credit as a line under the callsign, where the photo is a thumbnail beside it (a phone in the chase:
  // flightCard.css); the terms want it shown with any thumbnail.
  const creditLine = h('a', 'fh-card-credit-line')
  const credits = [credit, creditLine]
  for (const a of [imgLink, ...credits]) {
    a.target = '_blank'
    a.rel = 'noopener'
  }
  for (const c of credits) c.hidden = true
  figure.append(imgLink, h('span', 'fh-spin'), credit)
  ident.append(creditLine)
  figure.hidden = opts.photos === undefined

  // Expanded: the detail sections.
  const more = h('div', 'fh-card-more')
  more.hidden = true
  const rowEls = new Map<string, { row: HTMLElement; value: HTMLElement; text: string; alert: boolean; hint: string | null }>()
  for (const sec of detailRows(null, null, null, NO_LOOKUP)) {
    if (sec.id === 'header') continue
    const box = h('section', 'fh-card-section')
    if (sec.title !== '') box.append(h('h3', 'fh-card-section-t', sec.title))
    for (const r of sec.rows) {
      const rowEl = h('div', 'fh-card-row')
      const value = h('span', 'fh-card-row-v')
      rowEl.append(h('span', 'fh-card-row-l', r.label), value)
      box.append(rowEl)
      rowEls.set(r.key, { row: rowEl, value, text: '', alert: false, hint: null })
    }
    more.append(box)
  }

  const foot = h('div', 'fh-card-foot')
  foot.append(statusRow, expandBtn, chaseBtn)
  card.append(head, figure, stats, recRow, range, foot, more)
  root.append(card)

  let curHex: string | null = null
  let curS: RenderState | null = null
  let curRaw: ReadsbAircraft | null = null
  let curInfo: AircraftInfo | null = null
  let curStatus: StatusBrief | null = null
  let curChasing = false
  let curRange: CardRange | null = null
  let curReplay: string | null = null // History: "Replay · 17:43", else null (live)
  let shown: string | null = null
  let selectedAtMs = 0
  let lastMs = -Infinity
  let timer: ReturnType<typeof setTimeout> | null = null
  let lk: Lookup = NO_LOOKUP
  let lkKey = ''
  let expanded = false
  let destroyed = false
  // The recording of the shown aircraft: rec and when the server said so (local clock), for a ticking length.
  let rec: { hex: string; state: RecordingState | null | undefined; atMs: number; serverNowMs: number } | null = null
  let recBusy = false
  let savedUntilMs = 0 // "Recording ended" shows until then
  let recTimer: ReturnType<typeof setInterval> | null = null

  const hexOf = (): string | null => curHex
  const set = (node: HTMLElement, text: string): void => {
    if (node.textContent !== text) node.textContent = text
  }

  const syncSub = (): void => {
    sub.hidden = subText.textContent === '' && noPhoto.hidden
  }
  /** The photo box goes; the struck-through camera says why on hover. Shorter, the card may fit a place it did not. */
  function noPhotoFor(why: string): void {
    figure.hidden = true
    noPhoto.hidden = false
    noPhoto.title = why
    noPhoto.setAttribute('aria-label', why)
    syncSub()
    place()
  }

  // keepClear's last arguments: placed again when the photo box goes.
  let clearOf: { x: number; y: number; padPx: number; avoid: readonly { x: number; y: number; w: number; h: number }[] } | null = null
  function place(): void {
    if (clearOf === null) return
    const { x, y, padPx, avoid } = clearOf
    const put = (at: string): void => {
      for (const p of PLACES) if (p !== '') card.classList.toggle(p, p === at)
    }
    put('')
    if (card.hidden) return
    let best: { at: string; covered: number } | null = null
    for (const at of PLACES) {
      put(at)
      const r = card.getBoundingClientRect() // a layout read: a few per placing
      if (x > r.left - padPx && x < r.right + padPx && y > r.top - padPx && y < r.bottom + padPx) continue
      // How much of avoid it covers, AVOID_PX round it.
      const covered = avoid.reduce((sum, a) => sum +
        Math.max(0, Math.min(r.right + AVOID_PX, a.x + a.w) - Math.max(r.left - AVOID_PX, a.x)) *
        Math.max(0, Math.min(r.bottom + AVOID_PX, a.y + a.h) - Math.max(r.top - AVOID_PX, a.y)), 0)
      if (covered === 0) return
      if (best === null || covered < best.covered) best = { at, covered }
    }
    put(best?.at ?? '')
  }

  function showPhoto(hex: string): void {
    if (opts.photos === undefined) return
    img.hidden = true
    img.removeAttribute('src')
    for (const c of credits) c.hidden = true
    figure.hidden = false
    noPhoto.hidden = true
    syncSub()
    figure.classList.add('fh-skel')
    opts.photos.get(hex).then((p) => {
      if (destroyed || shown !== hex) return // the selection moved on
      if (p === null) return noPhotoFor(opts.photos?.failed(hex) ? 'Photo unavailable (could not load it)' : 'No photo available')
      img.src = p.thumbUrl
      imgLink.href = p.link
      for (const c of credits) {
        c.href = p.link
        c.textContent = `© ${p.photographer}`
      }
    })
  }
  img.addEventListener('load', () => {
    figure.classList.remove('fh-skel')
    img.hidden = false
    for (const c of credits) c.hidden = false
  })
  img.addEventListener('error', () => {
    img.hidden = true
    for (const c of credits) c.hidden = true
    noPhotoFor('Photo unavailable (could not load it)')
  })

  function render(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
    lastMs = Date.now()
    const hex = hexOf()
    if (hex === null || curStatus === null) {
      card.hidden = true
      shown = null
      return
    }
    card.hidden = false
    if (hex !== shown) {
      shown = hex
      selectedAtMs = Date.now()
      savedUntilMs = 0
      showPhoto(hex)
      paintRec()
    }
    const cs = curInfo?.callsign ?? curS?.callsign ?? null
    const key = `${hex}/${cs}`
    if (key !== lkKey) {
      lk = opts.lookup(hex, cs)
      lkKey = key
    }
    const v = cardView(hex, curS, curRaw, curInfo, curStatus, lk, (Date.now() - selectedAtMs) / 1000, curChasing, curRange, curReplay)
    paintChase(curChasing)
    set(flag, v.flag)
    set(callsign, v.callsign)
    set(type, v.type)
    type.hidden = v.type === ''
    set(subText, v.sub)
    syncSub()
    for (const st of v.stats) {
      const e = statEls.get(st.key)!
      set(e.value, st.value)
      set(e.unit, st.unit)
      e.box.classList.toggle('fh-dim', st.dim)
    }
    if (dot.dataset.state !== v.state) {
      dot.dataset.state = v.state === 'live' ? 'live' : v.state === 'predict' || v.state === 'replay' ? 'replay' : v.state === 'lost' || v.state === 'none' ? 'trouble' : 'wait'
      statusRow.dataset.state = v.state
    }
    spin.hidden = v.state !== 'locating'
    dot.hidden = v.state === 'locating'
    set(statusText, v.status)
    range.hidden = v.range === null
    if (v.range !== null) {
      set(rangeDist, v.range.dist)
      set(rangeFrom, v.range.from)
    }
    if (statusRow.title !== v.status) statusRow.title = v.status // the whole line, should it not fit
    if (!expanded) return
    for (const sec of detailRows(curS, curRaw, curInfo, lk)) {
      for (const r of sec.rows) {
        const slot = rowEls.get(r.key)
        if (slot === undefined) continue
        if (slot.text !== r.value) slot.value.textContent = slot.text = r.value
        if (slot.alert !== r.alert) slot.row.classList.toggle('fh-alert', (slot.alert = r.alert))
        if (slot.hint !== r.hint) slot.row.title = (slot.hint = r.hint) ?? ''
      }
    }
  }

  function paintRec(): void {
    const mine = rec !== null && rec.hex === shown ? rec.state : undefined
    recBtn.hidden = traffic || opts.onRecord === undefined || shown === null || mine === undefined
    const on = mine !== null && mine !== undefined
    recBtn.setAttribute('aria-pressed', String(on))
    recBtn.classList.toggle('fh-on', on)
    const label = on ? 'Stop recording this flight' : 'Record this flight (until it lands)'
    recBtn.setAttribute('aria-label', label)
    recBtn.title = label
    recBtn.disabled = recBusy
    stopBtn.disabled = recBusy
    const saved = !on && Date.now() < savedUntilMs
    recRow.hidden = recBtn.hidden || (!on && !saved)
    recRow.classList.toggle('fh-saved', saved)
    stopBtn.hidden = !on
    if (on && rec !== null) {
      const elapsed = rec.serverNowMs + (Date.now() - rec.atMs) - mine.startedMs
      set(recText, `REC ${formatElapsed(elapsed)} · ${mine.samples.toLocaleString('en-US')} point${mine.samples === 1 ? '' : 's'}`)
    } else if (saved) set(recText, 'Recording ended')
    const tick = on || saved
    if (tick && recTimer === null) recTimer = setInterval(paintRec, 1000)
    else if (!tick && recTimer !== null) (clearInterval(recTimer), (recTimer = null))
  }

  async function toggleRec(on: boolean): Promise<void> {
    const hex = shown
    if (hex === null || opts.onRecord === undefined || recBusy) return
    recBusy = true
    paintRec()
    try {
      const state = await opts.onRecord(hex, on)
      if (destroyed) return
      if (!on) savedUntilMs = Date.now() + 4000
      rec = { hex, state, atMs: Date.now(), serverNowMs: state?.startedMs ?? Date.now() }
      if (state !== null) rec.serverNowMs = Math.max(state.startedMs, state.lastMs ?? state.startedMs)
    } catch (e) {
      console.warn('flightCard: record failed:', e)
    } finally {
      recBusy = false
      if (!destroyed) paintRec()
    }
  }
  recBtn.addEventListener('click', () => void toggleRec(recBtn.getAttribute('aria-pressed') !== 'true'))
  stopBtn.addEventListener('click', () => void toggleRec(false))

  expandBtn.addEventListener('click', () => {
    expanded = !expanded
    more.hidden = !expanded
    card.classList.toggle('fh-expanded', expanded)
    expandBtn.replaceChildren(icon(expanded ? 'chevronUp' : 'chevronDown', 16))
    expandBtn.setAttribute('aria-expanded', String(expanded))
    const label = expanded ? 'Hide details' : 'Show details'
    expandBtn.setAttribute('aria-label', label)
    expandBtn.title = label
    render()
  })
  closeBtn.addEventListener('click', () => opts.onClose())
  chaseBtn.addEventListener('click', () => opts.onChase(!curChasing))
  linkBtn.addEventListener('click', () => {
    if (shown === null) return
    // The address bar holds the whole view (camera, orbit, toggles: urlState.ts) once it names this aircraft.
    const url = new URLSearchParams(location.search).get('hex') === shown ? location.href : shareLink(location.origin, shown)
    const done = (): void => {
      linkBtn.replaceChildren(icon('check', 16))
      linkBtn.classList.add('fh-done')
      setTimeout(() => {
        linkBtn.replaceChildren(icon('link', 16))
        linkBtn.classList.remove('fh-done')
      }, 1500)
    }
    // The async clipboard needs a secure context (https or localhost); elsewhere the user copies from a prompt.
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => window.prompt('Copy this link', url))
    else window.prompt('Copy this link', url)
  })

  return {
    update(hex0, s, raw, info, status, chasing, range = null) {
      if (destroyed) return
      const modeChanged = chasing !== curChasing
      curChasing = chasing
      curHex = hex0
      curS = s
      curRaw = raw
      curInfo = info
      curStatus = status
      curRange = range
      const hex = hexOf()
      if (hex !== shown || modeChanged) return render() // selection or mode changed: at once
      if (hex === null) return
      const wait = lastMs + UPDATE_MS - Date.now()
      if (wait <= 0) render()
      else if (timer === null) timer = setTimeout(render, wait)
    },
    setReplay(text) {
      if (destroyed || text === curReplay) return
      curReplay = text
      if (hexOf() !== null) render()
    },
    setRecording(hex, state, serverNowMs) {
      if (destroyed || recBusy) return
      const was = rec !== null && rec.hex === hex && rec.state !== null && rec.state !== undefined
      if (was && state === null) savedUntilMs = Date.now() + 4000 // it ended by itself: landed, or out of range
      rec = { hex, state, atMs: Date.now(), serverNowMs }
      paintRec()
    },
    keepClear(x, y, padPx, avoid = []) {
      clearOf = { x, y, padPx, avoid }
      place()
    },
    destroy() {
      destroyed = true
      if (recTimer !== null) clearInterval(recTimer)
      if (timer !== null) clearTimeout(timer)
      timer = null
      card.remove()
    },
  }
}

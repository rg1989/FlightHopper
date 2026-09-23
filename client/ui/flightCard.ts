// client/ui/flightCard.ts
// The focused aircraft's card, top-left: who it is (flag, callsign, type, airline), four live numbers (altitude, speed,
// vertical rate, track) and a status line (Live · Predicting · Signal lost · Locating). Collapsed by default; expand
// shows the photo and every detail section (detail.ts detailRows). It replaces the old detail panel, HUD and chase
// banner. cardView() is the pure text; mountFlightCard() builds the DOM once and rewrites texts at most 4 times a second.
import type { StatusBrief } from '../../shared/api.ts'
import type { AircraftInfo } from '../../shared/info.ts'
import type { ReadsbAircraft } from '../../shared/types.ts'
import type { RenderState } from '../types.ts'
import { UPDATE_MS, detailRows, shareLink, sourceLabel, type Lookup } from './detail.ts'
import { hudFields, isStale } from './format.ts'
import { icon } from './icons.ts'
import type { PhotoCache } from './photo.ts'
import './flightCard.css'

/** Seconds after a selection with no position during which the card says "Locating…" (then "No recent position"). */
export const LOCATING_S = 12

export type CardState = 'live' | 'predict' | 'lost' | 'locating' | 'none'

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
}

const DASH = '—'
const NO_LOOKUP: Lookup = { country: null, airline: null }

function stat(fields: ReturnType<typeof hudFields>, label: string): { value: string; dim: boolean } {
  const f = fields.find((x) => x.label === label)
  if (f === undefined || f.tag === 'unknown') return { value: DASH, dim: true }
  return { value: f.value, dim: f.tag === 'stale' } // computed values (VS, HDG) are fine; only stale ones fade
}

/** Splits "12,925 ft baro" → ["12,925", "ft"], "+1,020 fpm" → ["+1,020", "fpm"], "270°" → ["270", "°"]. */
function split(v: string): [string, string] {
  if (v === DASH) return [DASH, '']
  const m = /^([+\-−]?[\d,.]+)\s*(°|[a-z]+)?/.exec(v)
  return m === null ? [v, ''] : [m[1], m[2] ?? '']
}

/**
 * What the card shows. sinceSelectS: seconds since this aircraft was selected (for "Locating…" before its first
 * position). The status line follows the track: interpolating → Live; extrapolating → Predicting; stale → Signal lost.
 */
export function cardView(
  selHex: string | null, s: RenderState | null, raw: ReadsbAircraft | null, info: AircraftInfo | null, status: StatusBrief, lookup: Lookup,
  sinceSelectS: number,
): CardView {
  const sections = detailRows(s, raw, info, lookup)
  const get = (key: string): string | null => {
    for (const sec of sections) for (const r of sec.rows) if (r.key === key) return r.value === DASH ? null : r.value
    return null
  }
  const hex = get('hex')?.toLowerCase() ?? selHex
  const fields = hudFields(s, status)
  const alt = s?.onGround ? { value: 'GND', dim: false } : stat(fields, 'ALT')
  const [altV] = split(alt.value)
  const gs = stat(fields, 'GS')
  const vs = stat(fields, 'VS')
  const hdg = stat(fields, 'TRK') // the reported direction of travel (HDG is a computed nose heading)
  const type = get('type') ?? ''
  const sub = [lookup.airline, get('reg')].filter((x): x is string => x !== null && x !== '').join(' · ')

  let state: CardState
  let text: string
  if (s === null) {
    state = sinceSelectS < LOCATING_S ? 'locating' : 'none'
    text = state === 'locating' ? 'Locating aircraft…' : 'No recent position'
  } else if (isStale(s)) {
    state = 'lost'
    text = Number.isFinite(s.ageS) ? `Signal lost ${Math.round(Math.max(0, s.ageS))} s ago` : 'Signal lost'
  } else if (s.mode === 'extrap') {
    state = 'predict'
    text = 'Predicting · waiting for data'
  } else {
    state = 'live'
    text = ['Live', sourceLabel(raw, s.quality)].filter(Boolean).join(' · ')
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
  }
}

// ---- DOM ----------------------------------------------------------------------------------------------------------

export interface FlightCardOpts {
  onClose(): void
  onChase(on: boolean): void // the Chase / Map button: into the 3-D chase view, or back to the top-down map
  photos?: PhotoCache
  lookup(hex: string, callsign: string | null): Lookup
}

export interface FlightCardHandle {
  /** hex: the selected aircraft (null: none, the card hides); the rest may be null while unknown. */
  update(hex: string | null, s: RenderState | null, raw: ReadsbAircraft | null, info: AircraftInfo | null, status: StatusBrief, chasing: boolean): void
  destroy(): void
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

/**
 * Mounts the (hidden) card. update() may be called every frame: texts are rewritten at most every UPDATE_MS, with a
 * trailing render so the newest state always lands. A new selection renders at once and asks for its photo (once).
 * Values go in with textContent only: callsigns and photo credits come from upstream and are never parsed as HTML.
 */
export function mountFlightCard(root: HTMLElement, opts: FlightCardOpts): FlightCardHandle {
  const card = h('aside', 'fh-card fh-glass fh-blur')
  card.hidden = true
  card.setAttribute('aria-label', 'Chased aircraft')

  const head = h('header', 'fh-card-head')
  const ident = h('div', 'fh-card-ident')
  const top = h('div', 'fh-card-top')
  const flag = h('span', 'fh-card-flag')
  const callsign = h('span', 'fh-card-callsign')
  const type = h('span', 'fh-card-type')
  top.append(flag, callsign, type)
  const sub = h('div', 'fh-card-sub')
  ident.append(top, sub)
  const actions = h('div', 'fh-card-actions')
  const expandBtn = iconButton('chevronDown', 'Show details')
  expandBtn.setAttribute('aria-expanded', 'false')
  const linkBtn = iconButton('link', 'Copy a link to this view')
  const closeBtn = iconButton('x', 'Close (Esc)')
  actions.append(expandBtn, linkBtn, closeBtn)
  head.append(ident, actions)

  // The primary action: Chase (into the 3-D view) while focused; Map (back to top-down) while chasing, in the same place.
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
    chaseText.textContent = chasing ? 'Top-down map' : 'Chase in 3-D'
    chaseBtn.title = chasing ? 'Back to the top-down map (Esc)' : 'Fly behind this aircraft in 3-D'
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

  const statusRow = h('div', 'fh-card-status')
  const dot = h('span', 'fh-dot')
  const spin = h('span', 'fh-spin')
  const statusText = h('span', 'fh-card-status-t')
  statusRow.append(dot, spin, statusText)

  // Expanded: photo (3:2 box, so the layout does not jump when it arrives) and the detail sections.
  const more = h('div', 'fh-card-more')
  more.hidden = true
  const figure = h('figure', 'fh-card-photo fh-skel')
  const imgLink = h('a', 'fh-card-imglink')
  const img = h('img', 'fh-card-img')
  img.alt = 'Aircraft photo'
  img.hidden = true
  imgLink.append(img)
  const note = h('span', 'fh-card-note')
  const credit = h('a', 'fh-card-credit')
  credit.hidden = true
  for (const a of [imgLink, credit]) {
    a.target = '_blank'
    a.rel = 'noopener'
  }
  figure.append(imgLink, note, credit)
  figure.hidden = opts.photos === undefined
  more.append(figure)
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
  foot.append(statusRow, chaseBtn)
  card.append(head, stats, foot, more)
  root.append(card)

  let curHex: string | null = null
  let curS: RenderState | null = null
  let curRaw: ReadsbAircraft | null = null
  let curInfo: AircraftInfo | null = null
  let curStatus: StatusBrief | null = null
  let curChasing = false
  let shown: string | null = null
  let selectedAtMs = 0
  let lastMs = -Infinity
  let timer: ReturnType<typeof setTimeout> | null = null
  let lk: Lookup = NO_LOOKUP
  let lkKey = ''
  let expanded = false
  let destroyed = false

  const hexOf = (): string | null => curHex
  const set = (node: HTMLElement, text: string): void => {
    if (node.textContent !== text) node.textContent = text
  }

  function showPhoto(hex: string): void {
    img.hidden = true
    img.removeAttribute('src')
    credit.hidden = true
    note.textContent = ''
    figure.classList.add('fh-skel')
    opts.photos?.get(hex).then((p) => {
      if (destroyed || shown !== hex) return // the selection moved on
      if (p === null) {
        figure.classList.remove('fh-skel')
        note.textContent = opts.photos?.failed(hex) ? 'Photo unavailable' : 'No photo'
        return
      }
      img.src = p.thumbUrl
      imgLink.href = p.link
      credit.href = p.link
      credit.textContent = `© ${p.photographer}`
    })
  }
  img.addEventListener('load', () => {
    figure.classList.remove('fh-skel')
    img.hidden = false
    credit.hidden = false
  })
  img.addEventListener('error', () => {
    figure.classList.remove('fh-skel')
    img.hidden = true
    credit.hidden = true
    note.textContent = 'Photo unavailable'
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
      if (expanded) showPhoto(hex)
      else figure.dataset.pending = hex
    }
    const cs = curInfo?.callsign ?? curS?.callsign ?? null
    const key = `${hex}/${cs}`
    if (key !== lkKey) {
      lk = opts.lookup(hex, cs)
      lkKey = key
    }
    const v = cardView(hex, curS, curRaw, curInfo, curStatus, lk, (Date.now() - selectedAtMs) / 1000)
    paintChase(curChasing)
    set(flag, v.flag)
    set(callsign, v.callsign)
    set(type, v.type)
    type.hidden = v.type === ''
    set(sub, v.sub)
    sub.hidden = v.sub === ''
    for (const st of v.stats) {
      const e = statEls.get(st.key)!
      set(e.value, st.value)
      set(e.unit, st.unit)
      e.box.classList.toggle('fh-dim', st.dim)
    }
    if (dot.dataset.state !== v.state) {
      dot.dataset.state = v.state === 'live' ? 'live' : v.state === 'predict' ? 'replay' : v.state === 'lost' || v.state === 'none' ? 'trouble' : 'wait'
      statusRow.dataset.state = v.state
    }
    spin.hidden = v.state !== 'locating'
    dot.hidden = v.state === 'locating'
    set(statusText, v.status)
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

  expandBtn.addEventListener('click', () => {
    expanded = !expanded
    more.hidden = !expanded
    card.classList.toggle('fh-expanded', expanded)
    expandBtn.replaceChildren(icon(expanded ? 'chevronUp' : 'chevronDown', 16))
    expandBtn.setAttribute('aria-expanded', String(expanded))
    const label = expanded ? 'Hide details' : 'Show details'
    expandBtn.setAttribute('aria-label', label)
    expandBtn.title = label
    if (expanded && shown !== null && figure.dataset.pending === shown) {
      delete figure.dataset.pending
      showPhoto(shown)
    }
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
    update(hex0, s, raw, info, status, chasing) {
      if (destroyed) return
      const modeChanged = chasing !== curChasing
      curChasing = chasing
      curHex = hex0
      curS = s
      curRaw = raw
      curInfo = info
      curStatus = status
      const hex = hexOf()
      if (hex !== shown || modeChanged) return render() // selection or mode changed: at once
      if (hex === null) return
      const wait = lastMs + UPDATE_MS - Date.now()
      if (wait <= 0) render()
      else if (timer === null) timer = setTimeout(render, wait)
    },
    destroy() {
      destroyed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      card.remove()
    },
  }
}

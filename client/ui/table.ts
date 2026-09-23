// client/ui/table.ts
// The aircraft list (the rail's "Aircraft" panel): flag, callsign, type, altitude, speed of the aircraft in view.
// Sortable by any column, searchable (callsign, hex, registration, type, squawk); a row click selects the aircraft.
// It refreshes every REFRESH_MS (10 s), so rows do not move under the cursor; a ring around the refresh button counts
// down, a click refreshes now, and while a refresh runs the list dims and ignores clicks.
// Built for thousands of rows with update() called every frame:
// - on each refresh the on-screen entries are copied into table-owned objects, then filtered and sorted.
//   Fleet reuses its FleetEntry objects every frame, so the table never keeps a reference to one. The sort starts
//   from the last display order, which V8's adaptive sort finishes in about one pass;
// - a header click or a search re-sorts that copy at once;
// - only the rows in the scroll viewport plus OVERSCAN exist in the DOM. Row i always uses row element i % poolSize,
//   so scrolling rewrites only the rows that come into view, and a cell is written only when its text changes.
import type { FleetEntry } from '../types.ts'
import { STALE_AGE_S } from './format.ts'
import { icon } from './icons.ts'
import './table.css'

/** What a column sorts by. The flag column sorts by ICAO address: address blocks are allocated per country. */
export type TableKey = 'hex' | 'callsign' | 'route' | 'type' | 'squawk' | 'alt' | 'speed'

export interface TableColumn {
  key: TableKey
  label: string
  title: string
  num: boolean // right-aligned number
}

/** The columns shown, in order. The route and squawk columns went (routes are rarely known; squawk stays searchable and
 * an emergency squawk marks the row). */
export const COLUMNS: readonly TableColumn[] = [
  { key: 'hex', label: '', title: 'Country of registration (sorts by ICAO address, which groups countries)', num: false },
  { key: 'callsign', label: 'Callsign', title: 'Callsign (ICAO address when there is none)', num: false },
  { key: 'type', label: 'Type', title: 'ICAO aircraft type designator', num: false },
  { key: 'alt', label: 'Alt ft', title: 'Barometric altitude in feet; ▲ climbing / ▼ descending faster than 300 ft/min', num: true },
  { key: 'speed', label: 'Kt', title: 'Ground speed in knots', num: true },
]

export const ROW_H = 30 // px; fixed, the virtual scroll depends on it (table.css .fh-row height, via --fh-row-h)
export const TOUCH_ROW_H = 44 // on touch screens: a finger-sized row
export const OVERSCAN = 8 // rows kept above and below the viewport so a fast scroll never shows a gap
export const REFRESH_MS = 10_000 // the list's own rhythm: stable rows between refreshes
export const REFRESHING_MS = 380 // how long a refresh shows (dimmed, clicks ignored) before the new rows land
const VS_ARROW_FPM = 300
const GROUND = -1e9 // sort key: below every airborne altitude
const noFlag = (): string => ''

const finite = (v: number | null): v is number => v !== null && Number.isFinite(v)

/** 35000 → "35,000". Not toLocaleString: that builds a number formatter per call. */
const grouped = (n: number): string => String(Math.round(n) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

function keyOf(e: FleetEntry, key: TableKey): string | number | null {
  const i = e.info
  switch (key) {
    case 'hex': return e.hex
    case 'callsign': return i?.callsign ?? null
    case 'route': return i?.route ?? null
    case 'type': return i?.typeCode ?? null
    case 'squawk': return i?.squawk ?? null
    case 'alt': return e.onGround ? GROUND : finite(e.altFt) ? e.altFt : null
    case 'speed': return finite(e.gsKt) ? e.gsKt : null
  }
}

/**
 * The rows sorted by key (ascending, or descending when desc). Unknown values go last in both directions; equal keys
 * are ordered by hex so the order is stable from one re-sort to the next. Returns a new array; the input is untouched.
 */
export function sortRows(rows: readonly FleetEntry[], key: TableKey, desc: boolean): FleetEntry[] {
  const n = rows.length
  const keys: (string | number | null)[] = []
  const idx: number[] = []
  for (let i = 0; i < n; i++) {
    keys.push(keyOf(rows[i], key))
    idx.push(i)
  }
  const sign = desc ? -1 : 1
  idx.sort((i, j) => {
    const a = keys[i]
    const b = keys[j]
    if (a !== b) {
      if (a === null) return 1
      if (b === null) return -1
      if (a < b) return -sign
      if (a > b) return sign
    }
    const ha = rows[i].hex
    const hb = rows[j].hex
    return ha < hb ? -1 : ha > hb ? 1 : 0
  })
  const out: FleetEntry[] = []
  for (let k = 0; k < n; k++) out.push(rows[idx[k]])
  return out
}

const has = (v: string | null | undefined, q: string): boolean => v != null && v.toLowerCase().includes(q)

/** The rows whose callsign, hex, registration, type or squawk contains the query (trimmed, any case). New array. */
export function filterRows(rows: readonly FleetEntry[], query: string): FleetEntry[] {
  const q = query.trim().toLowerCase()
  if (q === '') return rows.slice()
  const out: FleetEntry[] = []
  for (const e of rows) {
    const i = e.info
    if (has(e.hex, q) || has(i?.callsign, q) || has(i?.reg, q) || has(i?.typeCode, q) || has(i?.squawk, q)) out.push(e)
  }
  return out
}

export function isEmergencySquawk(squawk: string | null): boolean {
  return squawk === '7500' || squawk === '7600' || squawk === '7700'
}

/** Text of the column with this key for one row; '' when unknown. */
export function cellText(e: FleetEntry, key: TableKey, flagOf: (hex: string) => string = noFlag): string {
  const i = e.info
  switch (key) {
    case 'hex': return flagOf(e.hex)
    case 'callsign': return i?.callsign ?? e.hex.toUpperCase()
    case 'route': return i?.route == null ? '' : i.route.replace(/\s*-\s*/g, ' - ')
    case 'type': return i?.typeCode ?? ''
    case 'squawk': return i?.squawk ?? ''
    case 'alt': {
      if (e.onGround) return 'ground'
      if (!finite(e.altFt)) return ''
      const vs = e.vsFpm
      return grouped(e.altFt) + (finite(vs) && vs > VS_ARROW_FPM ? ' ▲' : finite(vs) && vs < -VS_ARROW_FPM ? ' ▼' : '')
    }
    case 'speed': return finite(e.gsKt) ? String(Math.round(e.gsKt)) : ''
  }
}

/** Rows [first, end) to keep in the DOM for a viewport at scrollTop of height viewH (px). */
export function windowRange(scrollTop: number, viewH: number, rowH: number, count: number, overscan: number): { first: number; end: number } {
  const first = Math.max(0, Math.floor(scrollTop / rowH) - overscan)
  const end = Math.min(count, Math.ceil((scrollTop + viewH) / rowH) + overscan)
  return { first: Math.min(first, end), end }
}

// ---- DOM ----------------------------------------------------------------------------------------------------------

export interface TableOpts {
  onSelect(hex: string): void
  onHover(hex: string | null): void
  flagOf?: (hex: string) => string // emoji flag of the hex's country ('' when unknown); injected by the app (B-A)
}

export interface TableHandle {
  /**
   * all = every aircraft known, onScreen = the ones in the view; ready = the first data has arrived (skeleton rows
   * before). Cheap to call every frame: the rows change only on a refresh (see the file comment).
   */
  update(all: readonly FleetEntry[], onScreen: readonly FleetEntry[], selectedHex: string | null, ready: boolean): void
  /** Refresh at the next update() (e.g. when the panel opens). */
  refresh(): void
  destroy(): void
}

/** The table's own copy of one on-screen aircraft (Fleet's objects are reused every frame, so none are kept). */
interface Row extends FleetEntry {
  gen: number // copy() generation that last saw this hex on screen
}

/** One recycled row element and what it currently shows, so unchanged cells are never written. */
interface Slot {
  el: HTMLDivElement
  cells: HTMLSpanElement[]
  text: Text[]
  shown: string[]
  row: number // index into the sorted list, -1 = hidden
  hex: string
  sel: boolean
  emerg: boolean
  stale: boolean
}

const NCOL = COLUMNS.length
const RING_R = 12.5
const RING_C = 2 * Math.PI * RING_R

function blankRow(): Row {
  return { hex: '', lat: 0, lon: 0, hM: 0, altFt: null, onGround: false, trackDeg: null, gsKt: null, vsFpm: null, ageS: 0, staleS: 60, gapS: 0, quality: 'other', info: null, gen: 0 }
}

function copyEntry(d: FleetEntry, s: FleetEntry): void {
  d.hex = s.hex
  d.lat = s.lat
  d.lon = s.lon
  d.hM = s.hM
  d.altFt = s.altFt
  d.onGround = s.onGround
  d.trackDeg = s.trackDeg
  d.gsKt = s.gsKt
  d.vsFpm = s.vsFpm
  d.ageS = s.ageS
  d.staleS = s.staleS
  d.gapS = s.gapS
  d.quality = s.quality
  d.info = s.info // AircraftInfo is replaced, never mutated, when it changes
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = className
  if (text !== '') el.textContent = text
  return el
}

const SVG = 'http://www.w3.org/2000/svg'

/** The refresh button: a countdown ring around a refresh arrow. */
function refreshButton(): { btn: HTMLButtonElement; ring: SVGCircleElement } {
  const btn = h('button', 'fh-ibtn fh-sm fh-refresh')
  btn.type = 'button'
  btn.setAttribute('aria-label', 'Refresh the list now')
  btn.dataset.tip = 'Refresh now'
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 28 28')
  svg.setAttribute('width', '28')
  svg.setAttribute('height', '28')
  svg.setAttribute('aria-hidden', 'true')
  const track = document.createElementNS(SVG, 'circle')
  const ring = document.createElementNS(SVG, 'circle')
  for (const c of [track, ring]) {
    c.setAttribute('cx', '14')
    c.setAttribute('cy', '14')
    c.setAttribute('r', String(RING_R))
    c.setAttribute('fill', 'none')
    c.setAttribute('stroke-width', '1.75')
  }
  track.setAttribute('class', 'fh-ring-track')
  ring.setAttribute('class', 'fh-ring')
  ring.setAttribute('stroke-dasharray', String(RING_C))
  ring.setAttribute('transform', 'rotate(-90 14 14)')
  const arrow = document.createElementNS(SVG, 'path')
  // The refresh arrows, scaled into the ring.
  arrow.setAttribute('d', 'M19 13.5a5 5 0 0 0-9-2.6L9 12.2M9 9.3v2.9h2.9M9 14.5a5 5 0 0 0 9 2.6l1-1.3M19 18.7v-2.9h-2.9')
  arrow.setAttribute('fill', 'none')
  arrow.setAttribute('stroke', 'currentColor')
  arrow.setAttribute('stroke-width', '1.6')
  arrow.setAttribute('stroke-linecap', 'round')
  arrow.setAttribute('stroke-linejoin', 'round')
  svg.append(track, ring, arrow)
  btn.append(svg)
  return { btn, ring }
}

/**
 * Mounts the list into `body` (the panel body) and its counts and refresh button into `head` (the panel header).
 */
export function mountTable(body: HTMLElement, head: HTMLElement, opts: TableOpts): TableHandle {
  const flagOf = opts.flagOf ?? noFlag

  const el = h('div', 'fh-table')
  el.setAttribute('aria-label', 'Aircraft in view')
  const rowH = globalThis.matchMedia?.('(pointer: coarse)').matches ? TOUCH_ROW_H : ROW_H
  el.style.setProperty('--fh-row-h', `${rowH}px`)
  const counts = h('span', 'fh-table-counts fh-num')
  const { btn: refreshBtn, ring } = refreshButton()
  head.append(counts, refreshBtn)

  const searchBox = h('label', 'fh-table-search')
  const search = h('input', 'fh-field')
  search.type = 'search'
  search.placeholder = 'Search callsign, hex, reg, type, squawk'
  search.spellcheck = false
  search.autocomplete = 'off'
  search.setAttribute('aria-label', 'Search aircraft')
  searchBox.append(icon('search', 15), search)

  const bar = h('div', 'fh-progress fh-table-progress')
  const cols = h('div', 'fh-table-cols fh-grid')
  const colButtons = COLUMNS.map((c) => {
    const b = h('button', c.num ? 'fh-num' : '', c.label)
    b.type = 'button'
    b.title = c.title
    b.onclick = () => sortBy(c.key)
    return b
  })
  cols.append(...colButtons)
  const empty = h('div', 'fh-table-empty')
  const emptyTitle = h('div', 'fh-table-empty-title')
  const emptyHint = h('div', 'fh-table-empty-hint')
  empty.append(emptyTitle, emptyHint)
  const skeleton = h('div', 'fh-table-skeleton')
  for (let i = 0; i < 9; i++) {
    const r = h('div', 'fh-skel-row')
    r.append(h('span', 'fh-skel'), h('span', 'fh-skel'), h('span', 'fh-skel'))
    skeleton.append(r)
  }
  const scroll = h('div', 'fh-table-scroll')
  const spacer = h('div', 'fh-table-spacer')
  scroll.append(spacer)
  el.append(searchBox, bar, cols, skeleton, empty, scroll)
  body.append(el)

  let sortKey: TableKey = 'callsign'
  let desc = false
  let query = ''
  let selected: string | null = null
  let nextRefreshMs = -Infinity // refresh at the first update()
  let applyAtMs: number | null = null // a refresh is showing; the new rows land at this time
  let isReady = false
  let total = 0
  let viewH = 0
  let list: FleetEntry[] = [] // filtered + sorted Rows
  let count = -1
  const rowsByHex = new Map<string, Row>() // the copy of each aircraft on screen at the last copy()
  // The on-screen copies in the last display order, then the new ones. Sorting starts from this order, and V8's sort
  // (TimSort) is adaptive: on nearly sorted input it does about n comparisons instead of n·log2(n) (5,000 → ~61,000).
  let snap: Row[] = []
  let gen = 0
  const slots: Slot[] = []
  let hoverSlot = -1
  let hoverHex: string | null = null
  let shownCounts = ''

  function setText(node: HTMLElement, text: string): void {
    if (node.textContent !== text) node.textContent = text
  }

  function paintCounts(): void {
    const q = query.trim() === '' ? '' : ` · ${grouped(Math.max(count, 0))} match`
    const t = isReady ? `${grouped(snap.length)} in view · ${grouped(total)} tracked${q}` : ''
    if (t !== shownCounts) counts.textContent = shownCounts = t
  }

  function paintHeader(): void {
    COLUMNS.forEach((c, k) => {
      const b = colButtons[k]
      const on = c.key === sortKey
      b.dataset.sort = on ? (desc ? 'desc' : 'asc') : ''
      b.setAttribute('aria-pressed', String(on))
    })
  }

  function newSlot(j: number): Slot {
    const row = h('div', 'fh-row fh-grid')
    row.dataset.slot = String(j)
    row.hidden = true
    const cells: HTMLSpanElement[] = []
    const text: Text[] = []
    for (const c of COLUMNS) {
      const cell = h('span', c.num ? 'fh-num' : c.key === 'callsign' ? 'fh-cs' : c.key === 'type' ? 'fh-type' : '')
      const t = document.createTextNode('')
      cell.append(t)
      row.append(cell)
      cells.push(cell)
      text.push(t)
    }
    spacer.append(row)
    return { el: row, cells, text, shown: new Array<string>(NCOL).fill(''), row: -1, hex: '', sel: false, emerg: false, stale: false }
  }

  function write(s: Slot, c: number, t: string): void {
    if (s.shown[c] === t) return
    s.shown[c] = t
    s.text[c].data = t // textContent-equivalent: upstream strings are never parsed as HTML
  }

  function hide(s: Slot): void {
    if (s.row === -1) return
    s.row = -1
    s.el.hidden = true
  }

  function paint(s: Slot, i: number): void {
    const e = list[i]
    if (s.row !== i) {
      if (s.row === -1) s.el.hidden = false
      s.row = i
      s.el.style.transform = `translateY(${i * rowH}px)`
    }
    if (s.hex !== e.hex) {
      s.hex = e.hex
      write(s, 0, flagOf(e.hex))
    }
    for (let c = 1; c < NCOL; c++) write(s, c, cellText(e, COLUMNS[c].key))
    const sel = e.hex === selected
    if (sel !== s.sel) s.el.classList.toggle('fh-sel', (s.sel = sel))
    const emerg = isEmergencySquawk(e.info?.squawk ?? null)
    if (emerg !== s.emerg) s.el.classList.toggle('fh-emerg', (s.emerg = emerg))
    // Signal lost: two of its usual update gaps without a position, never under the card's 10 s.
    const stale = e.ageS > Math.max(STALE_AGE_S, 2 * e.gapS)
    if (stale !== s.stale) s.el.classList.toggle('fh-stale', (s.stale = stale))
  }

  function render(): void {
    const { first, end } = windowRange(scroll.scrollTop, viewH, rowH, count, OVERSCAN)
    if (end - first > slots.length) {
      // More rows fit than there are elements: grow, and forget the old row → element mapping (it was i % old size).
      for (const s of slots) hide(s)
      while (slots.length < end - first) slots.push(newSlot(slots.length))
    }
    const n = slots.length
    for (let i = first; i < end; i++) paint(slots[i % n], i)
    for (const s of slots) if (s.row !== -1 && (s.row < first || s.row >= end)) hide(s)
    emitHover()
  }

  function paintSelection(): void {
    for (const s of slots) {
      const sel = s.row !== -1 && s.hex === selected
      if (sel !== s.sel) s.el.classList.toggle('fh-sel', (s.sel = sel))
    }
  }

  /** Filter + sort the last copy and redraw. Runs on each refresh and at once on a sort or search change. */
  function refilter(): void {
    list = sortRows(filterRows(snap, query), sortKey, desc)
    if (query.trim() === '') snap = list as Row[] // same rows, now in display order
    if (list.length !== count) {
      count = list.length
      spacer.style.height = `${count * rowH}px`
    }
    skeleton.hidden = isReady
    const none = isReady && count === 0
    empty.hidden = !none
    if (none) {
      const searching = query.trim() !== ''
      setText(emptyTitle, searching ? 'No match' : 'No aircraft in view')
      setText(emptyHint, searching ? 'Try a callsign, registration, type or squawk.' : 'Zoom out or move the map to find traffic.')
    }
    paintCounts()
    render()
  }

  function copy(all: readonly FleetEntry[], onScreen: readonly FleetEntry[]): void {
    total = all.length
    gen++
    const fresh: Row[] = []
    for (const e of onScreen) {
      let r = rowsByHex.get(e.hex)
      if (r === undefined) {
        rowsByHex.set(e.hex, (r = blankRow()))
        fresh.push(r)
      }
      copyEntry(r, e)
      r.gen = gen
    }
    const next: Row[] = []
    for (const r of snap) {
      if (r.gen === gen) next.push(r)
      else rowsByHex.delete(r.hex) // left the screen
    }
    for (const r of fresh) next.push(r)
    snap = next
  }

  function sortBy(key: TableKey): void {
    if (key === sortKey) desc = !desc
    else {
      sortKey = key
      desc = key === 'alt' || key === 'speed' // numbers: highest first
    }
    paintHeader()
    refilter()
  }

  /** Restart the countdown ring (a CSS animation over REFRESH_MS). */
  function restartRing(): void {
    ring.style.animation = 'none'
    void ring.getBoundingClientRect() // reflow, so the animation starts over
    ring.style.animation = ''
  }

  function slotOf(target: EventTarget | null): Slot | null {
    const row = target instanceof Element ? target.closest<HTMLElement>('.fh-row') : null
    const s = row === null ? undefined : slots[Number(row.dataset.slot)]
    return s === undefined || s.row === -1 ? null : s
  }

  function emitHover(): void {
    const s = hoverSlot === -1 ? null : slots[hoverSlot]
    const hex = s === null || s.row === -1 ? null : s.hex
    if (hex === hoverHex) return
    hoverHex = hex
    opts.onHover(hex)
  }

  refreshBtn.addEventListener('click', () => (nextRefreshMs = -Infinity))
  search.addEventListener('input', () => {
    query = search.value
    refilter()
  })
  // Keys typed into the search box are not app shortcuts. Esc clears the box, then leaves it.
  search.addEventListener('keydown', (ev) => {
    ev.stopPropagation()
    if (ev.key !== 'Escape') return
    if (search.value !== '') {
      search.value = ''
      query = ''
      refilter()
    } else search.blur()
  })
  scroll.addEventListener('scroll', render, { passive: true })
  // ponytail: rows are mouse-only (header buttons and the search box are keyboard-reachable). Upgrade: a roving
  // tabindex on the recycled rows plus Up/Down/Enter handling, scrolling the list to keep the focused row in view.
  scroll.addEventListener('click', (ev) => {
    if (applyAtMs !== null) return // refreshing: the row under the cursor is about to change
    const s = slotOf(ev.target)
    if (s !== null) opts.onSelect(s.hex)
  })
  // Hover is a mouse thing: a tap would leave it stuck on a row whose aircraft changes at the next refresh.
  scroll.addEventListener('pointerover', (ev) => {
    if (ev.pointerType !== 'mouse') return
    const s = slotOf(ev.target)
    hoverSlot = s === null ? -1 : slots.indexOf(s)
    emitHover()
  })
  scroll.addEventListener('pointerleave', () => {
    hoverSlot = -1
    emitHover()
  })
  // The viewport height changes with the window and when the panel opens; reading it here keeps layout reads out of render().
  const resize = new ResizeObserver(() => {
    viewH = scroll.clientHeight
    if (viewH === 0 && hoverSlot !== -1) {
      hoverSlot = -1 // a closed panel drives no map label
      emitHover()
    }
    render()
  })
  resize.observe(scroll)

  paintHeader()
  refilter()

  return {
    update(all, onScreen, selectedHex, ready) {
      if (selectedHex !== selected) {
        selected = selectedHex
        paintSelection()
      }
      const now = performance.now()
      if (applyAtMs !== null) {
        if (now < applyAtMs) return
        applyAtMs = null
        el.classList.remove('fh-refreshing')
        isReady = ready
        copy(all, onScreen)
        refilter()
        return
      }
      if (ready && !isReady) nextRefreshMs = -Infinity // the first data: at once
      if (now < nextRefreshMs) return
      nextRefreshMs = now + REFRESH_MS
      restartRing()
      if (!ready) return
      // Show the refresh (dimmed, clicks ignored) for a moment, then land the new rows (above, at applyAtMs).
      applyAtMs = now + (isReady ? REFRESHING_MS : 0)
      el.classList.add('fh-refreshing')
    },
    refresh() {
      nextRefreshMs = -Infinity
    },
    destroy() {
      resize.disconnect()
      if (hoverHex !== null) opts.onHover(null)
      el.remove()
      counts.remove()
      refreshBtn.remove()
    },
  }
}

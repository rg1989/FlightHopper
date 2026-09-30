// client/ui/searchBox.ts
// The search box: airports, cities, countries, the flights in view, recordings and scenarios in one list, best first,
// each row with its kind (search/search.ts ranks them). Wide screens: a glass bar at the top centre that drops its list
// open while it has the focus (/ or Cmd/Ctrl+K). Phones (rail.ts SHEET_MEDIA): the Search tab of the bottom bar opens it
// as a full-screen sheet, the field at the top, over the keyboard's reach. Picks are kept in this browser (RECENTS_KEY)
// and come back marked in later searches; an empty box lists them.
// The places file is fetched at the first focus (~2 MB), the scenarios once, the recordings at every opening (new ones
// come). A failed fetch says so in the list, with Retry; what did load still searches.
import type { RecordingInfo } from '../../shared/api.ts'
import { flagEmoji } from '../../shared/icaoCountry.ts'
import type { AircraftInfo } from '../../shared/info.ts'
import type { Places } from '../../shared/places.ts'
import type { ScenarioCard } from '../scenario/types.ts'
import {
  addRecent, flightCandidates, highlight, placeCandidates, readRecents, recordingCandidates, scenarioCandidates, search,
  type Candidate, type Hit, type Item, type Kind, type Recent,
} from '../search/search.ts'
import { icon, type IconName } from './icons.ts'
import { SHEET_MEDIA } from './rail.ts'
import './searchBox.css'

export const RECENTS_KEY = 'fh.search.v1'

export interface SearchBoxOpts {
  placesUrl: string
  flights(): readonly { hex: string; info: AircraftInfo | null }[] // the flights in view now
  recordings(): Promise<RecordingInfo[]>
  scenarios(): Promise<ScenarioCard[]>
  store: Storage | null // localStorage; null where it is blocked (nothing is remembered)
  onPick(item: Item): void
}

export interface SearchBoxHandle {
  open(): void // focus it; on phones, open the sheet
  close(): void
  destroy(): void
}

const KIND: Record<Kind, { label: string; icon: IconName }> = {
  airport: { label: 'Airport', icon: 'tower' },
  city: { label: 'City', icon: 'building' },
  country: { label: 'Country', icon: 'flag' },
  flight: { label: 'Flight', icon: 'plane' },
  recording: { label: 'Recording', icon: 'record' },
  scenario: { label: 'Scenario', icon: 'film' },
}
const EXAMPLES = ['TLV', 'London', 'Germany', 'JAL123']
const SKELETON_ROWS = 3
const ENTER_MS = 420 // rows slide in this long after the list opens

type Load = 'idle' | 'loading' | 'ok' | 'error'
interface Source {
  what: string // for the error line: "airports and cities"
  state: Load
  cands: Candidate[]
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = className
  if (text !== '') e.textContent = text
  return e
}

/** The label with its matched parts in <mark>. */
function marked(label: string, typed: string): HTMLElement {
  const span = h('span', 'fh-search-label')
  let at = 0
  for (const [a, b] of highlight(label, typed)) {
    if (a > at) span.append(label.slice(at, a))
    span.append(h('mark', '', label.slice(a, b)))
    at = b
  }
  if (at < label.length) span.append(label.slice(at))
  return span
}

let uid = 0

export function mountSearchBox(root: HTMLElement, opts: SearchBoxOpts): SearchBoxHandle {
  const id = `fh-search-${++uid}`
  const phone = matchMedia(SHEET_MEDIA)
  const box = h('div', 'fh-search fh-glass fh-blur')
  box.setAttribute('role', 'search')

  const bar = h('div', 'fh-search-bar')
  const glyph = h('span', 'fh-search-glyph')
  glyph.append(icon('search', 17))
  const input = h('input', 'fh-search-input')
  input.type = 'text'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.setAttribute('autocapitalize', 'off')
  input.setAttribute('autocorrect', 'off')
  input.setAttribute('enterkeyhint', 'search')
  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-label', 'Search airports, cities, countries, flights in view, recordings and scenarios')
  input.setAttribute('aria-autocomplete', 'list')
  input.setAttribute('aria-expanded', 'false')
  input.setAttribute('aria-controls', `${id}-list`)
  const spin = h('span', 'fh-spin fh-search-spin')
  spin.hidden = true
  const clear = h('button', 'fh-ibtn fh-sm fh-search-clear')
  clear.type = 'button'
  clear.setAttribute('aria-label', 'Clear the search')
  clear.append(icon('x', 15))
  clear.hidden = true
  const key = h('kbd', 'fh-kbd fh-search-key', '/')
  key.setAttribute('aria-hidden', 'true')
  const cancel = h('button', 'fh-search-cancel', 'Cancel')
  cancel.type = 'button'
  const field = h('div', 'fh-search-field') // on phones a pill of its own, Cancel beside it
  field.append(glyph, input, spin, clear, key)
  bar.append(field, cancel)

  // The list opens by growing its grid row from 0 to its height (searchBox.css), so it slides down rather than pops.
  const drop = h('div', 'fh-search-drop')
  const dropIn = h('div', 'fh-search-drop-in')
  const scroll = h('div', 'fh-search-scroll')
  const notice = h('div', 'fh-search-notice')
  notice.hidden = true
  const head = h('div', 'fh-search-head')
  const headText = h('span', '', 'Recent')
  const clearRecents = h('button', 'fh-search-link', 'Clear')
  clearRecents.type = 'button'
  head.append(headText, clearRecents)
  const list = h('ul', 'fh-search-list')
  list.id = `${id}-list`
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', 'Results')
  const glow = h('div', 'fh-search-glow') // the active row's highlight: one element that glides from row to row
  glow.setAttribute('aria-hidden', 'true')
  const state = h('div', 'fh-search-state')
  scroll.append(notice, head, glow, list, state)
  const foot = h('div', 'fh-search-foot')
  const keys = h('span', 'fh-search-keys')
  for (const [k, what] of [['↑↓', 'move'], ['↵', 'open'], ['esc', 'close']] as const) {
    const g = h('span')
    g.append(h('kbd', 'fh-kbd', k), ` ${what}`)
    keys.append(g)
  }
  foot.append(keys, h('span', 'fh-search-scope', 'Flights: those in view'))
  dropIn.append(scroll, foot)
  drop.append(dropIn)
  const live = h('span', 'fh-search-live') // "5 results", for screen readers
  live.setAttribute('aria-live', 'polite')
  box.append(bar, drop, live)
  root.append(box)

  const places: Source = { what: 'places', state: 'idle', cands: [] }
  const scenarios: Source = { what: 'scenarios', state: 'idle', cands: [] }
  const recordings: Source = { what: 'recordings', state: 'idle', cands: [] }
  let recents: Recent[] = []
  try {
    recents = readRecents(opts.store?.getItem(RECENTS_KEY) ?? null)
  } catch {
    // blocked: none
  }
  let hits: Hit[] = []
  let active = -1
  let isOpen = false
  let frame: number | null = null
  let enterTimer: ReturnType<typeof setTimeout> | null = null
  let destroyed = false

  const fetchInto = (src: Source, get: () => Promise<Candidate[]>): void => {
    if (src.state === 'loading') return
    src.state = 'loading'
    get().then(
      (c) => {
        src.cands = c
        src.state = 'ok'
      },
      (e: unknown) => {
        console.warn(`FlightHopper: search: no ${src.what}:`, e)
        src.state = 'error' // what loaded before stays searchable
      },
    ).finally(() => {
      if (!destroyed) schedule()
    })
  }
  /** Fetches what is missing; the recordings again at every opening (new ones, renamed or deleted ones). */
  const load = (): void => {
    if (places.state === 'idle' || places.state === 'error') {
      fetchInto(places, async () => {
        const r = await fetch(opts.placesUrl)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return placeCandidates((await r.json()) as Places)
      })
    }
    if (scenarios.state === 'idle' || scenarios.state === 'error') fetchInto(scenarios, async () => scenarioCandidates(await opts.scenarios()))
    fetchInto(recordings, async () => recordingCandidates(await opts.recordings()))
  }

  const saveRecents = (): void => {
    try {
      opts.store?.setItem(RECENTS_KEY, JSON.stringify(recents))
    } catch {
      // full or blocked: they last this visit only
    }
  }

  const schedule = (): void => {
    if (frame === null) frame = requestAnimationFrame(render)
  }

  function row(hit: Hit, i: number): HTMLLIElement {
    const li = h('li', 'fh-search-row')
    li.id = `${id}-o${i}`
    li.setAttribute('role', 'option')
    li.setAttribute('aria-selected', String(i === active))
    li.dataset.kind = hit.kind
    li.style.setProperty('--i', String(Math.min(i, 10)))
    const tile = h('span', 'fh-search-tile')
    tile.append(icon(KIND[hit.kind].icon, 17))
    const flag = hit.iso2 === null ? '' : flagEmoji(hit.iso2)
    if (flag !== '') tile.append(h('span', 'fh-search-flag', flag))
    const text = h('span', 'fh-search-text')
    text.append(marked(hit.label, input.value))
    if (hit.sub !== '') text.append(h('span', 'fh-search-sub', hit.sub))
    const meta = h('span', 'fh-search-meta')
    if (hit.recent) {
      const r = h('span', 'fh-search-recent')
      r.title = 'Searched before'
      r.setAttribute('aria-label', 'searched before')
      r.append(icon('clock', 13))
      meta.append(r)
    }
    meta.append(h('span', 'fh-search-kind', KIND[hit.kind].label))
    li.append(tile, text, meta)
    li.addEventListener('pointermove', () => {
      if (active !== i) setActive(i, false)
    })
    li.addEventListener('pointerdown', (e) => e.preventDefault()) // the field keeps the focus
    li.addEventListener('click', () => pick(hit))
    return li
  }

  /** The glow under row i (none: -1), which scrolls into view when the keys moved it. */
  function setActive(i: number, reveal: boolean): void {
    active = i
    const rows = list.children
    for (let k = 0; k < rows.length; k++) rows[k]!.setAttribute('aria-selected', String(k === i))
    const el = i >= 0 ? (rows[i] as HTMLElement | undefined) : undefined
    if (el === undefined) {
      glow.classList.remove('fh-on')
      input.removeAttribute('aria-activedescendant')
      return
    }
    input.setAttribute('aria-activedescendant', el.id)
    glow.dataset.kind = el.dataset.kind // tinted as its row's kind
    glow.style.transform = `translateY(${list.offsetTop + el.offsetTop}px)` // the rows sit in the list, the glow beside it
    glow.style.height = `${el.offsetHeight}px`
    glow.classList.add('fh-on')
    if (reveal) el.scrollIntoView({ block: 'nearest' })
  }

  function skeleton(): HTMLElement {
    const wrap = h('div', 'fh-search-skel')
    for (let k = 0; k < SKELETON_ROWS; k++) {
      const r = h('div', 'fh-search-skel-row')
      r.append(h('span', 'fh-skel fh-search-skel-tile'), h('span', 'fh-search-skel-lines'))
      r.lastElementChild!.append(h('span', 'fh-skel'), h('span', 'fh-skel'))
      wrap.append(r)
    }
    return wrap
  }

  function render(): void {
    frame = null
    const typed = input.value
    const q = typed.trim()
    clear.hidden = typed === ''
    key.hidden = typed !== '' || isOpen
    const loading = [places, scenarios, recordings].filter((s) => s.state === 'loading')
    const failed = [places, scenarios, recordings].filter((s) => s.state === 'error')
    spin.hidden = !isOpen || loading.length === 0
    hits = search(typed, [places.cands, flightCandidates(opts.flights()), recordings.cands, scenarios.cands], recents)

    // Network trouble: what failed, with Retry. Offline says so.
    notice.hidden = failed.length === 0 || !isOpen
    if (!notice.hidden) {
      const offline = !navigator.onLine
      const what = failed.map((s) => s.what).join(', ').replace(/, ([^,]*)$/, ' and $1')
      const retry = h('button', 'fh-search-link', 'Retry')
      retry.type = 'button'
      retry.addEventListener('pointerdown', (e) => e.preventDefault())
      retry.addEventListener('click', () => {
        load()
        schedule()
      })
      const msg = h('span', 'fh-search-notice-t')
      msg.append(h('b', '', offline ? 'You are offline. ' : `Could not load ${what}. `), offline ? `No ${what} until the connection is back.` : 'The FlightHopper server did not answer.')
      notice.replaceChildren(icon('alert', 16), msg, retry)
    }

    head.hidden = !(q === '' && hits.length > 0)
    // Typing puts the best row under Enter; an empty box's past picks wait for the arrows.
    active = Math.min(active, hits.length - 1)
    if (q !== '' && active < 0 && hits.length > 0) active = 0
    list.replaceChildren(...hits.map(row))
    setActive(active, false)

    // What shows when there are no rows: loading places (a skeleton), no match, or the hint with examples.
    state.replaceChildren()
    state.className = 'fh-search-state'
    if (hits.length === 0 && q !== '' && places.state === 'loading') {
      state.append(skeleton(), h('div', 'fh-search-state-line', 'Loading airports, cities and countries…'))
    } else if (hits.length === 0 && q !== '') {
      state.classList.add('fh-search-empty')
      const art = h('span', 'fh-search-empty-art')
      art.append(icon('search', 22))
      state.append(art, h('div', 'fh-search-empty-t', `No matches for “${q}”`), h('div', 'fh-search-empty-s', places.state === 'error'
        ? 'Airports, cities and countries did not load: Retry above to search them too.'
        : 'Try an airport code, a city or country, a callsign in view, or a recording’s name. Flights are searched in the current view only.'))
    } else if (hits.length === 0) {
      state.classList.add('fh-search-hint')
      state.append(h('div', 'fh-search-hint-t', 'Airports, cities, countries, the flights in view, recordings and scenarios.'))
      const chips = h('div', 'fh-search-chips')
      for (const ex of EXAMPLES) {
        const c = h('button', 'fh-search-chip', ex)
        c.type = 'button'
        c.addEventListener('pointerdown', (e) => e.preventDefault())
        c.addEventListener('click', () => {
          input.value = ex
          active = 0
          schedule()
        })
        chips.append(c)
      }
      state.append(chips)
    } else if (q !== '' && places.state === 'loading') {
      const more = h('div', 'fh-search-state-line')
      more.append(h('span', 'fh-spin'), 'Loading airports, cities and countries…')
      state.append(more)
    }
    live.textContent = !isOpen ? '' : q === '' ? '' : hits.length === 0 ? 'No results' : `${hits.length} result${hits.length === 1 ? '' : 's'}`
  }

  function pick(hit: Hit): void {
    recents = addRecent(recents, hit, Date.now())
    saveRecents()
    input.value = ''
    close()
    opts.onPick(hit)
  }

  function setOpen(on: boolean): void {
    if (on === isOpen) return
    isOpen = on
    box.classList.toggle('fh-open', on)
    input.setAttribute('aria-expanded', String(on))
    if (on) {
      active = input.value.trim() === '' ? -1 : 0
      load()
      box.classList.add('fh-enter')
      if (enterTimer !== null) clearTimeout(enterTimer)
      enterTimer = setTimeout(() => box.classList.remove('fh-enter'), ENTER_MS)
      scroll.scrollTop = 0
    }
    render()
  }

  function open(): void {
    setOpen(true)
    input.focus()
  }

  function close(): void {
    setOpen(false)
    if (document.activeElement === input) input.blur()
  }

  input.addEventListener('focus', () => setOpen(true))
  // Wide screens close with the focus; the phone sheet stays until Cancel or a pick (the keyboard's Done blurs it).
  input.addEventListener('blur', () => {
    if (!phone.matches) setOpen(false)
  })
  input.addEventListener('input', () => {
    active = input.value.trim() === '' ? -1 : 0
    scroll.scrollTop = 0
    schedule()
  })
  input.addEventListener('keydown', (e) => {
    // The app's own keys (Esc steps back, T L X M R W toggle the scene) stay out of the field.
    e.stopPropagation()
    if (e.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (hits.length === 0) return
      const n = hits.length
      setActive(active < 0 ? (e.key === 'ArrowDown' ? 0 : n - 1) : (active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n, true)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = active >= 0 ? hits[active] : input.value.trim() !== '' ? hits[0] : undefined
      if (hit !== undefined) pick(hit)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (input.value !== '') {
        input.value = ''
        schedule()
      } else close()
    }
  })
  clear.addEventListener('pointerdown', (e) => e.preventDefault())
  clear.addEventListener('click', () => {
    input.value = ''
    input.focus()
    schedule()
  })
  cancel.addEventListener('click', () => {
    input.value = ''
    close()
  })
  clearRecents.addEventListener('pointerdown', (e) => e.preventDefault())
  clearRecents.addEventListener('click', () => {
    recents = []
    saveRecents()
    schedule()
  })

  // "/" or Cmd/Ctrl+K from anywhere but a field: to the box.
  const onKey = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null
    const typing = t !== null && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')
    const slash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey
    const cmdK = (e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey
    if ((!slash && !cmdK) || (typing && !cmdK) || (box.offsetParent === null && !phone.matches)) return // hidden: a scenario plays
    e.preventDefault()
    open()
  }
  window.addEventListener('keydown', onKey)
  const onMedia = (): void => {
    input.placeholder = phone.matches ? 'Search' : 'Search airports, cities, flights, recordings' // a phone's field is short
    if (isOpen && !phone.matches && document.activeElement !== input) setOpen(false)
  }
  onMedia()
  phone.addEventListener('change', onMedia)
  render()

  return {
    open,
    close,
    destroy() {
      destroyed = true
      if (frame !== null) cancelAnimationFrame(frame)
      if (enterTimer !== null) clearTimeout(enterTimer)
      window.removeEventListener('keydown', onKey)
      phone.removeEventListener('change', onMedia)
      box.remove()
    },
  }
}

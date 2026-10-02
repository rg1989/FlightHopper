// client/history/bar.ts
// The history time bar: the scenario play bar (ui/playbar.ts) over one local day, with the hours under the scrubber,
// the half hours the server holds on it (bright: here; striped: loading; red hatch: missing), the part not published
// yet hatched, a calendar button with the "Go to" popover, and Live to return. When the replay leaves the day, the bar
// is mounted again for the new one. It only asks (onToggle, onSeek, onRate, onLive, onGoTo); the app answers through
// update(), every frame. The helpers work in the browser's time zone.
// Keys: the play bar's own on the scrubber; Esc closes the popover (and only that: the app does not see it).
import type { HistoryStatus } from '../../shared/api.ts'
import { SLOT_MS } from '../../shared/history.ts'
import { icon } from '../ui/icons.ts'
import { mountPlaybar, type PlaybarHandle, type PlaybarSegment } from '../ui/playbar.ts'
import './bar.css'

const H_MS = 3_600_000
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** One local day: midnight to the next midnight (23 or 25 h on the days the clocks change). */
export interface LocalDay {
  startMs: number
  endMs: number
  label: string // 'Tue 22 Sep'
}

/** The local time y-m-d h:min:s as ms (any year: new Date(y, …) reads 0-99 as 19xx). */
function localMs(y: number, m: number, d: number, h = 0, min = 0, s = 0): number {
  const at = new Date(2000, 0, 1)
  at.setFullYear(y, m, d)
  at.setHours(h, min, s, 0)
  return at.getTime()
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** The local day holding tMs. */
export function localDay(tMs: number): LocalDay {
  const at = new Date(tMs)
  const [y, m, d] = [at.getFullYear(), at.getMonth(), at.getDate()]
  return { startMs: localMs(y, m, d), endMs: localMs(y, m, d + 1), label: `${WEEKDAYS[at.getDay()]} ${d} ${MONTHS[m]}` }
}

/** Labels every everyH hours of the clock, '00' to '24', at their seconds after the day's start (an hour the clocks
 *  skip stands where they jump past it). */
export function hourScale(day: LocalDay, everyH: number): { t: number; label: string }[] {
  if (!(everyH > 0)) return []
  const s = new Date(day.startMs)
  const out: { t: number; label: string }[] = []
  for (let h = 0; h <= 24; h += everyH) {
    const ms = h === 24 ? day.endMs : localMs(s.getFullYear(), s.getMonth(), s.getDate(), h)
    out.push({ t: (ms - day.startMs) / 1000, label: pad2(h) })
  }
  return out
}

/** The Go to popover's quick jumps back from now. */
export function quickTimes(nowMs: number): { label: string; tMs: number }[] {
  return [
    { label: '1 h ago', tMs: nowMs - H_MS },
    { label: '6 h ago', tMs: nowMs - 6 * H_MS },
    { label: 'Yesterday', tMs: nowMs - 24 * H_MS },
    { label: 'A week ago', tMs: nowMs - 7 * 24 * H_MS },
  ]
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/

/** A date input's value ('YYYY-MM-DD') and a time input's ('HH:MM', or 'HH:MM:SS') as local ms; null when either is
 *  empty, malformed or no such date. */
export function parseLocal(date: string, time: string): number | null {
  const d = DATE_RE.exec(date)
  const t = TIME_RE.exec(time)
  if (d === null || t === null) return null
  const [y, m, day] = [Number(d[1]), Number(d[2]) - 1, Number(d[3])]
  const [h, min, s] = [Number(t[1]), Number(t[2]), Number(t[3] ?? 0)]
  if (m < 0 || m > 11 || day < 1 || h > 23 || min > 59 || s > 59) return null
  const check = new Date(localMs(y, m, day))
  if (check.getFullYear() !== y || check.getMonth() !== m || check.getDate() !== day) return null // 30 Feb rolls over
  return localMs(y, m, day, h, min, s)
}

/** A date input's value for tMs: 'YYYY-MM-DD', local. */
export function inputDate(tMs: number): string {
  const at = new Date(tMs)
  return `${String(at.getFullYear()).padStart(4, '0')}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`
}

/** A time input's value for tMs: 'HH:MM', local. */
export function inputTime(tMs: number): string {
  const at = new Date(tMs)
  return `${pad2(at.getHours())}:${pad2(at.getMinutes())}`
}

/** The bar's clock: 'HH:MM:SS', local, the second floored. */
export function localClock(tMs: number): string {
  const at = new Date(tMs)
  return `${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}`
}

/** The half hours in the day as spans of seconds after its start, clipped to it, in time order; a slot the client is
 *  loading is 'loading' whatever the server says; neighbours in one state merge into one span. */
export function daySegments(day: LocalDay, slots: HistoryStatus['slots'], loading: readonly number[]): PlaybarSegment[] {
  const lenS = (day.endMs - day.startMs) / 1000
  const state = new Map<number, PlaybarSegment['state']>()
  for (const s of slots) state.set(s.slotMs, s.state)
  for (const slotMs of loading) state.set(slotMs, 'loading')
  const out: PlaybarSegment[] = []
  for (const slotMs of [...state.keys()].sort((a, b) => a - b)) {
    const from = Math.max(0, (slotMs - day.startMs) / 1000)
    const to = Math.min(lenS, (slotMs + SLOT_MS - day.startMs) / 1000)
    if (to <= from) continue
    const last = out.at(-1)
    if (last !== undefined && last.to === from && last.state === state.get(slotMs)) last.to = to
    else out.push({ from, to, state: state.get(slotMs)! })
  }
  return out
}

export interface HistoryBarOpts {
  zone: string // the clock's zone, short: 'IDT'
  minMs: number // the earliest time the picker offers (now − 30 days)
  nowMs(): number
  onToggle(): void
  onSeek(tMs: number): void
  onRate(): void
  onLive(): void
  onGoTo(tMs: number): void
}

export interface HistoryBarHandle {
  update(v: { tMs: number; playing: boolean; rate: number }): void // every frame; a new day mounts the bar again
  setSlots(slots: HistoryStatus['slots'], loading: readonly number[]): void // loading: the half hours the client awaits
  setLimit(maxMs: number): void // the newest published time: hatched past it, and out of reach
  openGoTo(): void // opens the popover with the focus on it, for the keyboard (Tab goes on into it)
  destroy(): void
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = className
  if (text !== '') e.textContent = text
  return e
}

function button(className: string, text: string, label = ''): HTMLButtonElement {
  const b = el('button', className, text)
  b.type = 'button'
  if (label !== '') {
    b.setAttribute('aria-label', label)
    b.title = label
  }
  return b
}

/** The bar's controls a day change must hand on to the new bar, when one of them has the focus. */
const FOCUSABLE = ['fh-playbar-range', 'fh-playbar-play', 'fh-playbar-rate', 'fh-playbar-exit']

let popovers = 0 // ids for the popover's aria wiring

export function mountHistoryBar(root: HTMLElement, o: HistoryBarOpts): HistoryBarHandle {
  // The calendar button and the popover go in as the play bar's tools: they move to the new bar when the day changes,
  // and the popover stands on the bar wherever the layout puts it (absolute, the bar its containing block).
  const id = `fh-goto-${++popovers}`
  const cal = button('fh-ibtn fh-history-cal', '', 'Go to a date and time')
  cal.setAttribute('aria-haspopup', 'dialog')
  cal.setAttribute('aria-expanded', 'false')
  cal.setAttribute('aria-controls', id)
  cal.append(icon('calendar', 18))

  // The popover: a form, so Enter in a field is Go and the browser checks the date against min/max (its own bubble).
  const pop = el('form', 'fh-goto fh-glass')
  pop.id = id
  pop.hidden = true
  pop.tabIndex = -1
  pop.setAttribute('role', 'dialog')
  pop.setAttribute('aria-labelledby', `${id}-title`)
  const head = el('div', 'fh-goto-head')
  const heading = el('span', 'fh-goto-title', 'Go to')
  heading.id = `${id}-title`
  const close = button('fh-ibtn fh-sm fh-goto-close', '', 'Close')
  close.append(icon('x', 16))
  head.append(heading, close)
  const chips = el('div', 'fh-goto-chips')
  const jumps = quickTimes(o.nowMs()).map((q, i) => {
    const chip = button('fh-goto-chip', q.label)
    chip.addEventListener('click', (e) => pick(quickTimes(o.nowMs())[i].tMs, e.detail > 0)) // from now, not from opening
    return chip
  })
  chips.append(...jumps)
  const date = el('input', 'fh-goto-input fh-num')
  date.type = 'date'
  date.required = true
  const time = el('input', 'fh-goto-input fh-num')
  time.type = 'time'
  time.step = '60'
  time.required = true
  const fields = el('div', 'fh-goto-fields')
  for (const [label, input] of [['Date', date], [`Time · ${o.zone}`, time]] as const) {
    const field = el('label', 'fh-goto-field')
    field.append(el('span', 'fh-goto-label', label), input)
    fields.append(field)
  }
  const go = el('button', 'fh-goto-go', 'Go')
  go.type = 'submit'
  pop.append(head, chips, fields, el('p', 'fh-goto-note', 'The last 30 days open in seconds.'), go)

  let slots: HistoryStatus['slots'] = []
  let loading: readonly number[] = []
  let limitMs: number | null = null
  let lastMs: number | null = null // the replay time of the last update: the fields' first value
  let destroyed = false

  // Esc closes the popover, and only that: caught on its way down, before the app's own Esc (back one level) sees it.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    closeGoTo(true)
  }
  // A press anywhere else (the map, the scrubber, the other buttons) closes it.
  const onDown = (e: PointerEvent): void => {
    const t = e.target
    if (t instanceof Node && (pop.contains(t) || cal.contains(t))) return
    closeGoTo(false)
  }
  const openGoTo = (focus: HTMLElement | null): void => {
    if (destroyed || !pop.hidden) return
    const t = lastMs ?? o.nowMs()
    date.min = inputDate(o.minMs)
    date.max = inputDate(o.nowMs())
    date.value = inputDate(t)
    time.value = inputTime(t)
    pop.hidden = false
    cal.setAttribute('aria-expanded', 'true')
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onDown, true)
    focus?.focus({ preventScroll: true })
  }
  /** refocus: a key closed it, so the keyboard goes back to the calendar; after a mouse or finger nothing keeps the
   *  focus (a later Space plays/pauses, as on the rest of the bar). */
  const closeGoTo = (refocus: boolean): void => {
    if (pop.hidden) return
    const inside = pop.contains(document.activeElement)
    pop.hidden = true
    cal.setAttribute('aria-expanded', 'false')
    window.removeEventListener('keydown', onKey, true)
    document.removeEventListener('pointerdown', onDown, true)
    if (!inside) return
    if (refocus) cal.focus({ preventScroll: true })
    else (document.activeElement as HTMLElement | null)?.blur()
  }
  const pick = (tMs: number, byPointer: boolean): void => {
    closeGoTo(!byPointer)
    o.onGoTo(tMs)
  }

  cal.addEventListener('click', (e) => {
    const byKey = e.detail === 0
    if (pop.hidden) openGoTo(byKey ? jumps[0] : null)
    else closeGoTo(byKey)
    if (!byKey) cal.blur() // as the play bar's speed: a mouse or finger leaves no focus on it
  })
  close.addEventListener('click', (e) => closeGoTo(e.detail === 0))
  let goByPointer = false
  go.addEventListener('click', (e) => (goByPointer = e.detail > 0)) // Enter in a field clicks it too, with detail 0
  pop.addEventListener('submit', (e) => {
    e.preventDefault()
    const tMs = parseLocal(date.value, time.value)
    if (tMs !== null) pick(tMs, goByPointer)
    goByPointer = false
  })

  // The play bar for one day: its seconds after the day's start.
  let day = localDay(o.nowMs())
  let mounts = 0
  const limitT = (d: LocalDay): number | null =>
    limitMs === null || limitMs >= d.endMs ? null : Math.max(0, (limitMs - d.startMs) / 1000)
  const mount = (d: LocalDay): PlaybarHandle => {
    const lenS = (d.endMs - d.startMs) / 1000
    const b = mountPlaybar(root, {
      start: 0, stop: lenS, end: lenS, marks: [], clockLabel: o.zone, title: `Replay · ${d.label}`,
      onToggle: () => o.onToggle(),
      onSeek: (t) => o.onSeek(Math.round(d.startMs + t * 1000)),
      onRate: () => o.onRate(),
      onExit: () => o.onLive(),
      className: mounts++ === 0 ? 'fh-playbar-history' : 'fh-playbar-history fh-playbar-again', // again: no entrance
      exitLabel: 'Back to live', exitText: 'Live', tools: [cal, pop], scale: hourScale(d, 3), timeLabel: 'Replay time',
    })
    b.setSegments(daySegments(d, slots, loading))
    b.setLimit(limitT(d))
    return b
  }
  let bar = mount(day)

  /** The replay left the day: the bar for the new one, the keyboard focus kept on the same control. */
  const remount = (next: LocalDay): void => {
    const active = document.activeElement
    const old = cal.closest('.fh-playbar')
    const had = active instanceof HTMLElement && old !== null && old.contains(active) ? active : null
    const same = had !== null && (cal.contains(had) || pop.contains(had)) ? had : null // these move to the new bar
    const cls = had === null || same !== null ? null : (FOCUSABLE.find((c) => had.classList.contains(c)) ?? null)
    const was = bar
    day = next
    bar = mount(next)
    was.destroy()
    const to = same ?? (cls === null ? null : (cal.closest('.fh-playbar')?.querySelector<HTMLElement>(`.${cls}`) ?? null))
    to?.focus({ preventScroll: true })
  }

  return {
    update(v) {
      if (destroyed) return
      lastMs = v.tMs
      if (Number.isFinite(v.tMs) && (v.tMs < day.startMs || v.tMs >= day.endMs)) remount(localDay(v.tMs))
      bar.update({ t: (v.tMs - day.startMs) / 1000, playing: v.playing, rate: v.rate, clock: localClock(v.tMs), phase: null })
    },
    setSlots(s, l) {
      slots = [...s]
      loading = [...l]
      if (!destroyed) bar.setSegments(daySegments(day, slots, loading))
    },
    setLimit(maxMs) {
      limitMs = maxMs
      if (!destroyed) bar.setLimit(limitT(day))
    },
    openGoTo() {
      openGoTo(pop)
    },
    destroy() {
      if (destroyed) return
      closeGoTo(false)
      destroyed = true
      bar.destroy()
    },
  }
}

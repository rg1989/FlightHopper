// client/history/bar.ts
// The history time bar: the scenario play bar (ui/playbar.ts) over one local day, with the hours under the scrubber. Each
// colour on its rail means one thing: amber, the selected aircraft's flights; red hatch, half hours adsb.lol does not
// have; grey hatch, before the oldest moment and past the newest, which cannot be reached (a drag, a key or a click
// there seeks to the bound). A ring turns round the thumb while the time under it loads. Over the rail a tip says the
// minute under the pointer (while the thumb is dragged, the one sought, above it) and what the rail shows there: the
// selected aircraft's state (describe) or why a hatch is there; a click on the rail goes to that minute. Beside the
// speed: the calendar button with the "Go to" popover, flanked by ‹ › for the day before and after, and Live to return.
// When the replay leaves the day, the bar is mounted again for the new one. It only asks (onToggle, onSeek, onRate,
// onLive, onGoTo, describe); the app answers through update(), every frame. The helpers work in the browser's time zone.
// Keys: the play bar's own on the scrubber; Esc closes the popover (and only that: the app does not see it).
import { newestSlotMs, SLOT_MS, slotOf } from '../../shared/history.ts'
import { icon } from '../ui/icons.ts'
import { mountPlaybar, type PlaybarHandle, type PlaybarSegment } from '../ui/playbar.ts'
import './bar.css'

const H_MS = 3_600_000
const MIN_MS = 60_000
const TIP_EDGE = 18 // px: the tip's caret keeps this far from its ends (its 12 px corner and half the caret)
const TIP_GAP = 9 // px from the tip to the bar: its 6 px caret in between
// A press on the scrubber that moves less than this is a click (it goes to the tip's minute), a finger's too: on a phone
// 10 px is most of an hour of the day, and a drag's tip says the true minute anyway.
const TAP_PX = 3
// ponytail: until the app says what exists (setBounds), the oldest moment is 30 days back: a guess, short of what adsb.lol
// keeps; the server's first answer replaces it. Upgrade: none, while the app calls setBounds as soon as it has that answer.
const DEFAULT_SPAN_MS = 30 * 24 * H_MS
// ponytail: English day and month names, as the rest of the UI ('Tue 22 Sep'; Intl's en-GB would say 'Sept'). Upgrade:
// Intl.DateTimeFormat parts for the label when the UI is translated.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** One local day: midnight to the next midnight (23 or 25 h on the days the clocks change). */
export interface LocalDay {
  startMs: number
  endMs: number
  label: string // 'Tue 22 Sep'
}

/** A flight of the selected aircraft: the time of its first point to its last, ms. */
export interface LegSpan {
  fromMs: number
  toMs: number
}

/** The selected aircraft at a moment in a few words (HistoryBarOpts.describe), in the rail's colour for it: heard amber,
 *  gap (in a hole of its flight) an amber ring, quiet (not heard) grey. */
export interface AircraftLine {
  label: string // 'ELY541 · flying'
  tone: 'heard' | 'gap' | 'quiet'
}

/** The tip's line under the time: the aircraft's, or what the rail shows there (missing: the red hatch of a half hour
 *  adsb.lol lacks; beyond: the grey hatch before the oldest moment and past the newest). */
export interface TipLine {
  label: string
  tone: AircraftLine['tone'] | 'missing' | 'beyond'
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

/** The scrubber's t (seconds after the day's start) as ms, whole. Its right edge is the day's last ms (23:59:59), not
 *  the next midnight: End or a drag to the edge stays in the day (only playing crosses midnight, and moves the bar on). */
export function dayMs(day: LocalDay, t: number): number {
  return Math.max(day.startMs, Math.min(Math.round(day.startMs + t * 1000), day.endMs - 1))
}

/** The whole minute at f, a share of the day's rail (0 its start, 1 its end; outside, the end it is past), as ms: floored
 *  as the clock is, and inside the day (the right edge is 23:59). The tip says it, and a click on the rail goes to it. */
export function railMinute(day: LocalDay, f: number): number {
  const share = Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0
  const ms = dayMs(day, (share * (day.endMs - day.startMs)) / 1000)
  return day.startMs + Math.floor((ms - day.startMs) / MIN_MS) * MIN_MS // from local midnight: a whole minute of the clock
}

/** Where the tip stands, x the pointer's (or the thumb's) px from the bar's left edge: its left edge (px from the bar's),
 *  centred on x and held inside the bar's ends (from the left end, when wider than the bar); its caret (px from the tip's
 *  left edge) on x, clear of the tip's rounded corners. Whole pixels, so its text stays crisp. */
export function tipPlace(x: number, tipW: number, barW: number): { left: number; caret: number } {
  const left = Math.round(Math.max(0, Math.min(x - tipW / 2, barW - tipW)))
  return { left, caret: Math.round(Math.max(TIP_EDGE, Math.min(x - left, tipW - TIP_EDGE))) }
}

/**
 * The tip's line under the time at tMs (the minute it says), as the rail shows it there. Past the newest moment and before
 * the oldest, why it cannot be reached (no aircraft line: nothing exists there). Else the selected aircraft's line
 * (aircraft: the app's describe; null, none), except over a half hour adsb.lol lacks where the aircraft's flight is not
 * drawn over the red hatch (amber: heard, or a hole of it): "No data".
 */
export function railLine(tMs: number, minMs: number, maxMs: number, missing: readonly number[],
  aircraft: (tMs: number) => AircraftLine | null): TipLine | null {
  if (tMs > maxMs) return { label: 'Not published yet', tone: 'beyond' }
  if (tMs < minMs) return { label: 'Older than adsb.lol keeps', tone: 'beyond' }
  const line = aircraft(tMs)
  if (line !== null && line.tone !== 'quiet') return line
  return missing.includes(slotOf(tMs)) ? { label: 'No data', tone: 'missing' } : line
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

/** Spans of ms as spans of seconds after the day's start, clipped to it and in time order; spans that touch or overlap
 *  merge into one (so two translucent bars do not darken where they meet). */
function clipSpans(day: LocalDay, state: PlaybarSegment['state'], ms: readonly (readonly [number, number])[]): PlaybarSegment[] {
  const lenS = (day.endMs - day.startMs) / 1000
  const out: PlaybarSegment[] = []
  for (const [fromMs, toMs] of ms.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b)).sort((a, b) => a[0] - b[0])) {
    const from = Math.max(0, (fromMs - day.startMs) / 1000)
    const to = Math.min(lenS, (toMs - day.startMs) / 1000)
    if (!(to > from)) continue
    const last = out.at(-1)
    if (last !== undefined && from <= last.to) last.to = Math.max(last.to, to)
    else out.push({ from, to, state })
  }
  return out
}

/** The rail's spans for the day, as seconds after its start, clipped to it: the half hours adsb.lol does not have (slot
 *  starts, red hatch), then the selected aircraft's legs (amber) over them. */
export function daySegments(day: LocalDay, legs: readonly LegSpan[], missing: readonly number[]): PlaybarSegment[] {
  return [
    ...clipSpans(day, 'missing', missing.map((slotMs) => [slotMs, slotMs + SLOT_MS] as const)),
    ...clipSpans(day, 'leg', legs.map((l) => [l.fromMs, l.toMs] as const)),
  ]
}

/** Where the day's rail leaves what exists, as seconds after its start: floorS, before which it is hatched (null: the
 *  oldest moment is on an earlier day), limitS, past which it is (null: the newest is on a later day). A day wholly
 *  before the oldest moment is all floor; one wholly after the newest, all limit. */
export function dayReach(day: LocalDay, minMs: number, maxMs: number): { floorS: number | null; limitS: number | null } {
  const lenS = (day.endMs - day.startMs) / 1000
  return {
    floorS: minMs <= day.startMs ? null : Math.min(lenS, (minMs - day.startMs) / 1000),
    limitS: maxMs >= day.endMs ? null : Math.max(0, (maxMs - day.startMs) / 1000),
  }
}

/** tMs held inside [minMs, maxMs]. */
export function clampMs(tMs: number, minMs: number, maxMs: number): number {
  return Math.min(maxMs, Math.max(minMs, tMs))
}

/** Whether tMs is a moment that exists: inside [minMs, maxMs], both ends included. */
export function inBounds(tMs: number, minMs: number, maxMs: number): boolean {
  return tMs >= minMs && tMs <= maxMs
}

/** The day arrows (dir −1: the day before, 1: the day after): the clock time of tMs on that day, to the second, held
 *  inside [minMs, maxMs]; null where there is no such day (tMs is on the first day that exists, or on the last: the arrow
 *  is off). Local clock fields, not ± 24 h: across a change of the clocks it is still the same time on the wall. */
export function dayStep(tMs: number, dir: -1 | 1, minMs: number, maxMs: number): number | null {
  const first = localDay(minMs).startMs
  const last = localDay(maxMs).startMs
  const today = localDay(tMs).startMs
  if (dir < 0 ? today <= first : today >= last) return null
  const at = new Date(tMs)
  const to = localMs(at.getFullYear(), at.getMonth(), at.getDate() + dir, at.getHours(), at.getMinutes(), at.getSeconds())
  return clampMs(to, minMs, maxMs)
}

/** The Go to chips: each with whether its moment exists (so it can be chosen). */
export function quickJumps(nowMs: number, minMs: number, maxMs: number): { label: string; tMs: number; enabled: boolean }[] {
  return quickTimes(nowMs).map((q) => ({ ...q, enabled: inBounds(q.tMs, minMs, maxMs) }))
}

/** The time input's min and max for the chosen date: on the first day the first whole minute that exists, on the last
 *  the last one; none ('') on any day between. Whole minutes: the field steps by 60 s, and Go's own check (goMoment) is
 *  to the millisecond. */
export function timeLimits(date: string, minMs: number, maxMs: number): { min: string; max: string } {
  // ponytail: in the first day's last minute the next whole minute is the next day's 00:00, so the field's own check lets
  // every time of that day pass and only goMoment holds it (Go stays off, the field is not red). Upgrade: the time
  // field's setCustomValidity from goMoment, if that minute ever matters.
  return {
    min: date === inputDate(minMs) ? inputTime(Math.ceil(minMs / MIN_MS) * MIN_MS) : '',
    max: date === inputDate(maxMs) ? inputTime(maxMs) : '',
  }
}

/** What Go goes to: the date and time inputs' moment when it is real and exists (inside [minMs, maxMs]); else null, and
 *  Go is off. */
export function goMoment(date: string, time: string, minMs: number, maxMs: number): number | null {
  const tMs = parseLocal(date, time)
  return tMs !== null && inBounds(tMs, minMs, maxMs) ? tMs : null
}

export interface HistoryBarOpts {
  zone: string // the clock's zone, short: 'GMT+3'
  nowMs(): number
  onToggle(): void
  onSeek(tMs: number): void // a click or a drag on the scrubber, a key on it
  onRate(): void
  onLive(): void
  onGoTo(tMs: number): void // Go to (the chips, the form) and the day arrows: a jump
  describe?(tMs: number): AircraftLine | null // the selected aircraft at tMs, for the tip; null (or none given): no line
}

export interface HistoryBarHandle {
  /** Every frame; a new day mounts the bar again. loading: the time under the clock is being fetched (a ring on the
   *  thumb, the clock dimmed, the bar aria-busy). */
  update(v: { tMs: number; playing: boolean; rate: number; loading: boolean }): void
  setBounds(minMs: number, maxMs: number): void // the oldest and newest moments that exist: hatched beyond both, out of reach
  setMissing(slots: readonly number[]): void // half hours (UTC slot starts, SLOT_MS long) upstream does not have: red hatch
  setLegs(spans: readonly LegSpan[]): void // the selected aircraft's flights, amber on the rail; [] none
  setNote(text: string | null): void // a short note after the title ('No data for this time'); null: none. Kept by day
  openGoTo(): void // opens the popover with the focus on it, for the keyboard (Tab goes on into it)
  closeGoTo(): boolean // closes the popover; whether it was open (the app's Back asks it first: Esc, the TV remote)
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
  // What exists: until the app says (setBounds), the last 30 days up to the newest published half hour's end, so the bar
  // is never unbounded.
  let minMs = o.nowMs() - DEFAULT_SPAN_MS
  let maxMs = newestSlotMs(o.nowMs()) + SLOT_MS

  // The day arrows, the calendar button and the popover go in as the play bar's tools: they move to the new bar when the
  // day changes, and the popover stands on the bar wherever the layout puts it (absolute, the bar its containing block).
  const id = `fh-goto-${++popovers}`
  const prev = button('fh-ibtn fh-history-day fh-history-prev', '', 'The day before')
  prev.append(icon('chevronLeft', 18))
  const cal = button('fh-ibtn fh-history-cal', '', 'Go to a date and time')
  cal.setAttribute('aria-haspopup', 'dialog')
  cal.setAttribute('aria-expanded', 'false')
  cal.setAttribute('aria-controls', id)
  cal.append(icon('calendar', 18))
  const next = button('fh-ibtn fh-history-day fh-history-next', '', 'The day after')
  next.append(icon('chevronRight', 18))

  // The popover: a form, so Enter in a field is Go. Go is off while the moment is not real or does not exist (syncFields),
  // so the browser's own bubble never has to say so.
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
  pop.append(head, chips, fields, go)

  let legs: readonly LegSpan[] = []
  let missing: readonly number[] = []
  let loading = false
  let lastMs: number | null = null // the replay time of the last update: the fields' first value, the arrows' clock
  let note: string | null = null
  let destroyed = false
  const shownMs = (): number => lastMs ?? o.nowMs()

  /** Each chip on only while its moment (from now) exists. */
  const syncChips = (): void => {
    quickJumps(o.nowMs(), minMs, maxMs).forEach((q, i) => (jumps[i].disabled = !q.enabled))
  }
  /** The fields' limits for the chosen date, and Go on only for a moment that is real and exists: the form's own check
   *  (the browser's min and max, to the minute) and the bounds to the millisecond. */
  const syncFields = (): void => {
    date.min = inputDate(minMs)
    date.max = inputDate(maxMs)
    const lim = timeLimits(date.value, minMs, maxMs)
    time.min = lim.min
    time.max = lim.max
    go.disabled = goMoment(date.value, time.value, minMs, maxMs) === null || !pop.checkValidity()
  }
  for (const input of [date, time]) for (const type of ['input', 'change']) input.addEventListener(type, syncFields)
  /** Each day arrow on only while there is such a day to go to. */
  const syncArrows = (): void => {
    const ms = shownMs()
    for (const [b, dir] of [[prev, -1], [next, 1]] as const) {
      const off = dayStep(ms, dir, minMs, maxMs) === null
      if (b.disabled === off) continue
      b.disabled = off
      if (off && document.activeElement === b) cal.focus({ preventScroll: true }) // a disabled button keeps no focus
    }
  }

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
  /** focus: 'first' puts it on the first chip that can be chosen (the date when none can), 'form' on the popover itself. */
  const openGoTo = (focus: 'first' | 'form' | null): void => {
    if (destroyed || !pop.hidden) return
    hideTip() // opened by a key while the pointer rests on the rail: the popover rises where the tip stood
    const t = shownMs()
    date.value = inputDate(t)
    time.value = inputTime(t)
    syncFields()
    syncChips()
    pop.hidden = false
    cal.setAttribute('aria-expanded', 'true')
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onDown, true)
    if (focus === 'first') (jumps.find((c) => !c.disabled) ?? date).focus({ preventScroll: true })
    else if (focus === 'form') pop.focus({ preventScroll: true })
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
  /** A jump from the popover: never to a moment that does not exist (a chip counted from now may have slipped past the
   *  oldest while the popover stood open). */
  const pick = (tMs: number, byPointer: boolean): void => {
    closeGoTo(!byPointer)
    o.onGoTo(clampMs(tMs, minMs, maxMs))
  }

  cal.addEventListener('click', (e) => {
    const byKey = e.detail === 0
    if (pop.hidden) openGoTo(byKey ? 'first' : null)
    else closeGoTo(byKey)
    if (!byKey) cal.blur() // as the play bar's speed: a mouse or finger leaves no focus on it
  })
  for (const [b, dir] of [[prev, -1], [next, 1]] as const) {
    b.addEventListener('click', (e) => {
      const to = dayStep(shownMs(), dir, minMs, maxMs)
      closeGoTo(false) // a key may have come here from the popover
      if (to !== null) o.onGoTo(to)
      if (e.detail > 0) b.blur() // as the calendar: a mouse or finger leaves no focus, so a later Space plays/pauses
    })
  }
  close.addEventListener('click', (e) => closeGoTo(e.detail === 0))
  let goByPointer = false
  go.addEventListener('click', (e) => (goByPointer = e.detail > 0)) // Enter in a field clicks it too, with detail 0
  pop.addEventListener('submit', (e) => {
    e.preventDefault()
    const tMs = goMoment(date.value, time.value, minMs, maxMs)
    if (tMs !== null) pick(tMs, goByPointer)
    goByPointer = false
  })

  // The play bar for one day: its seconds after the day's start.
  // ponytail: the scrubber keeps the play bar's keys, ←/→ 10 s and Shift or PgUp/PgDn 60 s: small steps across 24 h (Home,
  // End and the mouse cover the rest). Upgrade: a step option on the play bar (10 min, 1 h) if keyboard use asks for it.
  const tools = [prev, cal, next, pop]
  let day = localDay(o.nowMs())
  let mounts = 0

  // The tip over the rail: the minute under the pointer (a mouse or pen over it) or, while the scrubber is pressed (any
  // pointer; a finger only then), the moment sought, above the thumb; under it what the rail shows there (railLine). It
  // stands above the bar, so it covers none of its controls, held inside the bar's ends. Beside the bar in root, not in
  // it: over what the bar is under (the flight card on phones, a tall panel), with no change to the bar's own stacking.
  // A press is a click until it moves TAP_PX: a click goes to the minute the tip says; a drag seeks finely, as the
  // scrubber always has.
  const tip = el('div', 'fh-history-tip fh-glass')
  tip.hidden = true
  tip.setAttribute('aria-hidden', 'true') // for the eye: the scrubber says the time
  const tipTime = el('span', 'fh-history-tip-time fh-num')
  const tipText = el('span', 'fh-history-tip-line')
  tip.append(tipTime, tipText)
  type TipAt = { x: number } | { tMs: number } // the pointer's clientX, or the moment sought (above the thumb)
  let tipAt: TipAt | null = null // where it stands; null: hidden
  let tipSays = '' // what it says, so a move writes only what changed
  // The press on the scrubber (pointer id, from clientX x): moved once it went TAP_PX from there; minute, where its release
  // goes when the scrubber sought nothing meanwhile (sought: it did).
  let press: { id: number; x: number; minute: number; moved: boolean; sought: boolean } | null = null
  let shell: HTMLElement | null = null // the bar's element: the tip stands on it
  let rail: HTMLElement | null = null // its rail: the minute under a pointer is read from where it is drawn
  const aircraftAt = (tMs: number): AircraftLine | null => o.describe?.(tMs) ?? null

  /** The minute under clientX on the rail (railMinute); null while the rail has no size. */
  const minuteAt = (clientX: number): number | null => {
    const r = rail?.getBoundingClientRect()
    return r === undefined || !(r.width > 0) ? null : railMinute(day, (clientX - r.left) / r.width)
  }
  /** The tip at the pointer (its minute) or above the thumb (the moment sought, its minute as the clock shows it). */
  const showTip = (at: TipAt): void => {
    const r = rail?.getBoundingClientRect()
    if (destroyed || shell === null || r === undefined || !(r.width > 0)) return
    const tMs = 'x' in at ? railMinute(day, (at.x - r.left) / r.width) : at.tMs
    const x = 'x' in at ? at.x : r.left + Math.min(1, Math.max(0, (tMs - day.startMs) / (day.endMs - day.startMs))) * r.width
    const time = inputTime(tMs)
    const line = railLine(tMs, minMs, maxMs, missing, aircraftAt)
    const says = `${time} ${line?.tone ?? ''} ${line?.label ?? ''}`
    if (says !== tipSays) {
      tipSays = says
      tipTime.textContent = time
      tipText.hidden = line === null
      if (line !== null) {
        tipText.textContent = line.label
        tipText.setAttribute('data-tone', line.tone)
      }
    }
    tipAt = at
    tip.hidden = false // shown before it is measured
    const b = shell.getBoundingClientRect()
    const u = root.getBoundingClientRect() // the overlay, borderless: the tip's containing block
    const p = tipPlace(x - b.left, tip.offsetWidth, b.width)
    tip.style.setProperty('left', `${Math.round(b.left - u.left + p.left)}px`)
    tip.style.setProperty('bottom', `${Math.round(u.bottom - b.top) + TIP_GAP}px`)
    tip.style.setProperty('--fh-caret', `${p.caret}px`)
  }
  const hideTip = (): void => {
    tipAt = null
    tip.hidden = true
  }
  /** What the tip says, again where it stands: the legs, the missing half hours or the bounds changed under it. */
  const refreshTip = (): void => {
    if (tipAt !== null) showTip(tipAt)
  }
  /** A seek from the scrubber (a drag, a key, a press on the rail), never past what exists. A press that has not moved (a
   *  click: the browser seeks where it was pressed, finely) goes to the minute the tip said; while one is down the tip
   *  stands above the thumb, saying where it is. */
  const seek = (ms: number): void => {
    const p = press
    const tMs = clampMs(p === null || p.moved ? ms : p.minute, minMs, maxMs)
    if (p !== null) {
      p.sought = true
      showTip({ tMs })
    }
    o.onSeek(tMs)
  }
  /** The tip's and the click's listeners on a new bar's scrubber. */
  const wireTip = (): void => {
    shell = cal.closest<HTMLElement>('.fh-playbar')
    rail = shell?.querySelector<HTMLElement>('.fh-playbar-rail') ?? null
    const range = shell?.querySelector<HTMLInputElement>('.fh-playbar-range') ?? null
    if (range === null) return
    range.addEventListener('pointerdown', (e) => {
      // One press at a time (another finger's is not one), by the main button (a finger, a pen's tip); the same pointer
      // pressing again means its last release never came here.
      if ((press !== null && press.id !== e.pointerId) || e.button !== 0) return
      const minute = minuteAt(e.clientX)
      if (minute === null) return
      press = { id: e.pointerId, x: e.clientX, minute, moved: false, sought: false }
      showTip({ tMs: clampMs(minute, minMs, maxMs) }) // where a click goes: the thumb will be there
    })
    range.addEventListener('pointermove', (e) => {
      const p = press
      if (p === null) {
        // A mouse or pen over the rail; not a finger (only while it presses), nor a press from elsewhere passing over (the
        // map dragged), nor over the open popover.
        if (e.pointerType !== 'touch' && e.buttons === 0 && pop.hidden) showTip({ x: e.clientX })
        return
      }
      if (e.pointerId !== p.id) return
      if (!p.moved && Math.abs(e.clientX - p.x) >= TAP_PX) p.moved = true
      if (!p.moved || p.sought) return // a click so far; or a drag, whose seeks move the tip
      // A drag the scrubber does not make (iOS Safari drags a range only by its thumb): the tip follows the pointer, and
      // the release goes there.
      p.minute = minuteAt(e.clientX) ?? p.minute
      showTip({ x: e.clientX })
    })
    range.addEventListener('pointerleave', () => {
      if (press === null) hideTip()
    })
    range.addEventListener('pointerup', (e) => {
      const p = press
      if (p === null || e.pointerId !== p.id) return
      press = null
      hideTip()
      if (!p.sought) o.onSeek(clampMs(p.minute, minMs, maxMs)) // a click on the thumb itself, or a drag it did not make
    })
    const cancel = (e: PointerEvent): void => {
      if (press === null || e.pointerId !== press.id) return
      press = null
      hideTip()
    }
    range.addEventListener('pointercancel', cancel)
    range.addEventListener('lostpointercapture', cancel)
  }

  /** The hatch before the oldest moment and past the newest, on this day's rail (none where they are on other days). */
  const applyReach = (b: PlaybarHandle, d: LocalDay): void => {
    const { floorS, limitS } = dayReach(d, minMs, maxMs)
    b.setFloor(floorS)
    b.setLimit(limitS)
  }
  const mount = (d: LocalDay): PlaybarHandle => {
    const lenS = (d.endMs - d.startMs) / 1000
    const b = mountPlaybar(root, {
      start: 0, stop: lenS, end: lenS, marks: [], clockLabel: o.zone, title: `Replay · ${d.label}`,
      onToggle: () => o.onToggle(),
      // Its right edge is 23:59:59, not the next day's bar; and never past what exists (the bar's own floor and limit
      // already hold a drag, a key and a click there: seek holds a day that lies wholly outside).
      onSeek: (t) => seek(dayMs(d, t)),
      onRate: () => o.onRate(),
      onExit: () => o.onLive(),
      className: mounts++ === 0 ? 'fh-playbar-history' : 'fh-playbar-history fh-playbar-again', // again: no entrance
      exitLabel: 'Back to live', exitText: 'Live', tools, scale: hourScale(d, 3), timeLabel: 'Replay time',
    })
    b.setSegments(daySegments(d, legs, missing))
    applyReach(b, d)
    b.setBusy(loading)
    b.setNote(note)
    wireTip()
    return b
  }
  let bar = mount(day)
  root.append(tip) // after the bar
  syncArrows()

  /** The replay left the day: the bar for the new one, the keyboard focus kept on the same control; the tip goes (and
   *  with it a press on the old scrubber). */
  const remount = (nextDay: LocalDay): void => {
    const active = document.activeElement
    const old = cal.closest('.fh-playbar')
    const had = active instanceof HTMLElement && old !== null && old.contains(active) ? active : null
    const same = had !== null && tools.some((t) => t.contains(had)) ? had : null // these move to the new bar
    const cls = had === null || same !== null ? null : (FOCUSABLE.find((c) => had.classList.contains(c)) ?? null)
    const was = bar
    press = null
    hideTip()
    day = nextDay
    bar = mount(nextDay)
    syncArrows()
    const fresh = cal.closest<HTMLElement>('.fh-playbar')
    if (old !== null && fresh !== null) old.replaceWith(fresh) // where the old one was: the tab order holds
    was.destroy()
    let to = same ?? (cls === null ? null : (fresh?.querySelector<HTMLElement>(`.${cls}`) ?? null))
    if (to instanceof HTMLButtonElement && to.disabled) to = cal // an arrow the new day switched off
    to?.focus({ preventScroll: true })
  }

  return {
    update(v) {
      if (destroyed) return
      if (Number.isFinite(v.tMs)) {
        lastMs = v.tMs
        if (v.tMs < day.startMs || v.tMs >= day.endMs) remount(localDay(v.tMs))
      }
      if (v.loading !== loading) {
        loading = v.loading
        bar.setBusy(loading)
      }
      bar.update({ t: (v.tMs - day.startMs) / 1000, playing: v.playing, rate: v.rate, clock: localClock(v.tMs), phase: null })
    },
    setBounds(min, max) {
      if (!(Number.isFinite(min) && Number.isFinite(max) && min <= max)) return // not a range: keep what exists now
      minMs = min
      maxMs = max
      if (destroyed) return
      applyReach(bar, day)
      syncArrows()
      refreshTip()
      if (!pop.hidden) {
        syncFields()
        syncChips()
      }
    },
    setMissing(slots) {
      missing = [...slots]
      if (destroyed) return
      bar.setSegments(daySegments(day, legs, missing))
      refreshTip()
    },
    setLegs(spans) {
      legs = [...spans]
      if (destroyed) return
      bar.setSegments(daySegments(day, legs, missing))
      refreshTip() // a new selection, or its day of flights came: the aircraft's line under the pointer
    },
    setNote(text) {
      note = text
      if (!destroyed) bar.setNote(text)
    },
    openGoTo() {
      openGoTo('form')
    },
    closeGoTo() {
      const open = !pop.hidden
      closeGoTo(true) // as Esc: the keyboard goes back to the calendar when it was in the popover
      return open
    },
    destroy() {
      if (destroyed) return
      closeGoTo(false)
      press = null
      hideTip()
      destroyed = true
      bar.destroy()
      tip.remove()
    },
  }
}

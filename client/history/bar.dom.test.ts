// client/history/bar.dom.test.ts
// The time bar as mounted: bar.ts with ui/playbar.ts on a fake DOM rich enough for both (bar.test.ts has its pure parts):
// its tools, bounds and hatches, the day arrows, the scrubber held inside what exists, the loader, the rail's legs and
// missing half hours, the Go to popover, the focus across a day change, destroy, and the tip over the rail (the minute
// under the pointer or the dragged thumb, the aircraft's line, a click going to that minute).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import type { AircraftLine } from './bar.ts'

// bar.ts and playbar.ts import their CSS for Vite. Node cannot load CSS, so this test process loads every .css as an empty
// module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})

interface Ev { type: string; key?: string; detail?: number; target: FNode; defaultPrevented: boolean; stopped: boolean; preventDefault(): void; stopPropagation(): void; pointerId?: number; clientX?: number; pointerType?: string; button?: number; buttons?: number }
type EvInit = Partial<Pick<Ev, 'key' | 'detail' | 'pointerId' | 'clientX' | 'pointerType' | 'button' | 'buttons'>>

const doc: { activeElement: FNode | null; listeners: Map<string, ((e: Ev) => void)[]> } = { activeElement: null, listeners: new Map() }
const win: { listeners: Map<string, ((e: Ev) => void)[]> } = { listeners: new Map() }

class FNode {
  tag: string
  children: FNode[] = []
  parent: FNode | null = null
  className = ''
  hidden = false
  disabled = false
  type = ''
  title = ''
  id = ''
  tabIndex = 0
  required = false
  min = ''
  max = ''
  step = ''
  value = ''
  writes = 0
  attrs: Record<string, string> = {}
  // Layout, as the test sets it (a fake lays nothing out): getBoundingClientRect's box, the left border, the width.
  rect = { left: 0, top: 0, width: 0, height: 0 }
  clientLeft = 0
  offsetWidth = 0
  #text = ''
  style = { props: {} as Record<string, string>, setProperty: (k: string, v: string): void => void (this.style.props[k] = v) }
  #classes = new Set<string>()
  classList = {
    add: (c: string): void => void this.#classes.add(c),
    remove: (c: string): void => void this.#classes.delete(c),
    toggle: (c: string, on?: boolean): boolean => {
      if (on ?? !this.#classes.has(c)) this.#classes.add(c)
      else this.#classes.delete(c)
      return this.#classes.has(c)
    },
    contains: (c: string): boolean => this.has(c),
  }
  listeners = new Map<string, ((e: Ev) => void)[]>()
  constructor(tag: string) {
    this.tag = tag
  }
  get textContent(): string {
    return this.#text
  }
  set textContent(v: string) {
    this.#text = v
  }
  set innerHTML(_v: string) {
    throw new Error('innerHTML')
  }
  has(cls: string): boolean {
    return this.className.split(/\s+/).includes(cls) || this.#classes.has(cls)
  }
  #detach(): void {
    if (doc.activeElement !== null && this.contains(doc.activeElement)) doc.activeElement = null // a removed focus goes to the body
  }
  append(...cs: FNode[]): void {
    for (const c of cs) {
      c.remove()
      c.parent = this
      this.children.push(c)
    }
  }
  prepend(...cs: FNode[]): void {
    for (const c of [...cs].reverse()) {
      c.remove()
      c.parent = this
      this.children.unshift(c)
    }
  }
  after(...cs: FNode[]): void {
    const p = this.parent!
    for (const [i, c] of cs.entries()) {
      c.remove()
      c.parent = p
      p.children.splice(p.children.indexOf(this) + 1 + i, 0, c)
    }
  }
  replaceChildren(...cs: FNode[]): void {
    for (const c of this.children) c.parent = null
    this.children = []
    this.append(...cs)
  }
  remove(): void {
    if (!this.parent) return
    this.#detach()
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }
  replaceWith(n: FNode): void {
    const p = this.parent!
    const i = p.children.indexOf(this)
    n.remove()
    this.#detach()
    p.children[p.children.indexOf(this)] = n
    n.parent = p
    this.parent = null
    void i
  }
  contains(n: FNode | null): boolean {
    for (let x: FNode | null = n; x !== null; x = x.parent) if (x === this) return true
    return false
  }
  closest<T = FNode>(sel: string): T | null {
    const cls = sel.slice(1)
    for (let x: FNode | null = this; x !== null; x = x.parent) if (x.has(cls)) return x as unknown as T
    return null
  }
  querySelector<T = FNode>(sel: string): T | null {
    const cls = sel.slice(1)
    for (const c of this.children) {
      if (c.has(cls)) return c as unknown as T
      const d = c.querySelector<T>(sel)
      if (d !== null) return d
    }
    return null
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number; right: number; bottom: number } {
    return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }
  }
  addEventListener(type: string, f: (e: Ev) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), f])
  }
  fire(type: string, init: EvInit = {}): Ev {
    const e: Ev = {
      type, ...init, target: this, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true },
      stopPropagation() { this.stopped = true },
    }
    for (let el: FNode | null = this; el !== null && !e.stopped; el = el.parent) for (const f of el.listeners.get(type) ?? []) f(e)
    return e
  }
  click(detail = 0): void {
    if (this.disabled) return
    this.fire('click', { detail })
    if (this.tag === 'button' && this.type === 'submit') {
      const form = this.closest<FNode>('.fh-goto')
      if (form !== null && form.checkValidity()) form.fire('submit')
    }
  }
  focus(): void {
    if (!this.disabled) doc.activeElement = this
  }
  blur(): void {
    if (doc.activeElement === this) doc.activeElement = null
  }
  inputs(): FNode[] {
    return this.children.flatMap((c) => (c.tag === 'input' ? [c] : c.inputs()))
  }
  // A form's own validity: required, and min / max (same-format strings compare as text).
  checkValidity(): boolean {
    return this.inputs().every((i) => {
      if (i.required && i.value === '') return false
      if (i.value !== '' && i.min !== '' && i.value < i.min) return false
      if (i.value !== '' && i.max !== '' && i.value > i.max) return false
      return true
    })
  }
}
class FButton extends FNode {}
const all = (n: FNode): FNode[] => [n, ...n.children.flatMap(all)]
const one = (root: FNode, cls: string): FNode => {
  const hits = all(root).filter((e) => e.has(cls))
  assert.equal(hits.length, 1, `one .${cls}, found ${hits.length}`)
  return hits[0]
}
const text = (n: FNode): string => n.textContent + n.children.map(text).join('')

Object.assign(globalThis, {
  document: {
    createElement: (tag: string) => (tag === 'button' ? new FButton(tag) : new FNode(tag)),
    createElementNS: (_ns: string, tag: string) => new FNode(tag),
    get activeElement() {
      return doc.activeElement
    },
    addEventListener: (t: string, f: (e: Ev) => void) => doc.listeners.set(t, [...(doc.listeners.get(t) ?? []), f]),
    removeEventListener: (t: string, f: (e: Ev) => void) => doc.listeners.set(t, (doc.listeners.get(t) ?? []).filter((g) => g !== f)),
  },
  window: {
    addEventListener: (t: string, f: (e: Ev) => void) => win.listeners.set(t, [...(win.listeners.get(t) ?? []), f]),
    removeEventListener: (t: string, f: (e: Ev) => void) => win.listeners.set(t, (win.listeners.get(t) ?? []).filter((g) => g !== f)),
  },
  HTMLElement: FNode,
  HTMLButtonElement: FButton,
  Node: FNode,
})
const stored = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) } })

// Loaded only now, after the CSS hook and the fake DOM (static imports would be loaded before either).
const { mountHistoryBar, localDay } = await import('./bar.ts')
const { newestSlotMs, SLOT_MS, slotOf } = await import('../../shared/history.ts')

const at = (y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0): number => new Date(y, m, d, h, min, s, ms).getTime()
const H = 3_600_000
const keyOnWindow = (key: string): Ev => {
  const e: Ev = { type: 'keydown', key, target: null as unknown as FNode, defaultPrevented: false, stopped: false, preventDefault() {}, stopPropagation() { this.stopped = true } }
  for (const f of win.listeners.get('keydown') ?? []) f(e)
  return e
}
const pointerDown = (target: FNode): void => {
  const e = { type: 'pointerdown', target } as unknown as Ev
  for (const f of doc.listeners.get('pointerdown') ?? []) f(e)
}

const NOW = at(2026, 8, 22, 17, 43, 55)

function mount(extra: { now?: number; describe?: (tMs: number) => AircraftLine | null } = {}) {
  doc.activeElement = null
  doc.listeners.clear()
  win.listeners.clear()
  const root = new FNode('div')
  const calls: string[] = []
  const now = extra.now ?? NOW
  const bar = mountHistoryBar(root as never, {
    zone: 'GMT+3', nowMs: () => now,
    onToggle: () => calls.push('toggle'), onSeek: (t: number) => calls.push(`seek ${t}`), onRate: () => calls.push('rate'),
    onLive: () => calls.push('live'), onGoTo: (t: number) => calls.push(`goto ${t}`),
    describe: extra.describe,
  })
  const view = () => {
    const barEl = one(root, 'fh-playbar')
    return {
      barEl,
      prev: one(root, 'fh-history-prev'), next: one(root, 'fh-history-next'), cal: one(root, 'fh-history-cal'), pop: one(root, 'fh-goto'),
      range: all(root).find((e) => e.tag === 'input' && e.has('fh-playbar-range'))!,
      rail: one(root, 'fh-playbar-rail'),
      tip: one(root, 'fh-history-tip'), tipTime: one(root, 'fh-history-tip-time'), tipLine: one(root, 'fh-history-tip-line'),
    }
  }
  return { root, bar, calls, view }
}

test('mount: tools are ‹ calendar › and the popover; the arrows have the labels; nothing busy; chevrons drawn', () => {
  const { root, view } = mount()
  const v = view()
  const tools = one(root, 'fh-playbar-tools')
  assert.deepEqual(tools.children.map((c) => (c.has('fh-goto') ? 'fh-goto' : c.className.split(' ').at(-1))), ['fh-history-prev', 'fh-history-cal', 'fh-history-next', 'fh-goto'])
  assert.deepEqual([v.prev.attrs['aria-label'], v.prev.title, v.next.attrs['aria-label'], v.next.title], ['The day before', 'The day before', 'The day after', 'The day after'])
  assert.equal(v.prev.children.length, 1)
  assert.equal(v.prev.children[0].children[0].attrs.d, 'm15 6-6 6 6 6')
  assert.equal(v.next.children[0].children[0].attrs.d, 'm9 6 6 6-6 6')
  assert.equal(v.barEl.attrs['aria-busy'], undefined)
  assert.deepEqual([v.prev.disabled, v.next.disabled], [false, true], 'the day of now holds the default newest moment (the newest half hour\'s end): › is off, ‹ is on (30 days back)')
  assert.equal(v.pop.hidden, true)
  assert.equal(all(root).filter((e) => e.has('fh-goto-note')).length, 0, 'the note is gone')
  assert.equal(text(v.pop).includes('30 days'), false)
})

test('default bounds: 30 days back to the newest published half hour end; the rail is hatched past it on today only', () => {
  const { bar, view, root } = mount()
  bar.update({ tMs: NOW, playing: false, rate: 1, loading: false })
  const maxMs = newestSlotMs(NOW) + SLOT_MS
  const day = localDay(NOW)
  const v = view()
  const lim = (maxMs - day.startMs) / 1000 / 864
  assert.equal(v.rail.style.props['--fh-lim'], `${lim.toFixed(3)}%`)
  assert.ok(v.rail.classList.contains('fh-has-limit'))
  assert.ok(!v.rail.classList.contains('fh-has-floor'), 'the oldest moment is 30 days back: not on today')
  assert.equal(one(root, 'fh-playbar-time').textContent, '17:43:55')
})

test('setBounds: the oldest day hatched before the oldest moment, ‹ off; today › off; in between both on', () => {
  const { bar, view, calls } = mount()
  const oldest = at(2026, 8, 20, 14, 7, 31)
  const newest = at(2026, 8, 24, 12, 30)
  bar.setBounds(oldest, newest)
  bar.update({ tMs: at(2026, 8, 22, 12), playing: false, rate: 1, loading: false })
  let v = view()
  assert.deepEqual([v.prev.disabled, v.next.disabled], [false, false])
  assert.ok(!v.rail.classList.contains('fh-has-floor') && !v.rail.classList.contains('fh-has-limit'))
  // the oldest day: a new bar
  bar.update({ tMs: at(2026, 8, 20, 18), playing: false, rate: 1, loading: false })
  v = view()
  assert.deepEqual([v.prev.disabled, v.next.disabled], [true, false])
  assert.equal(v.rail.style.props['--fh-floor'], `${(50_851 / 864).toFixed(3)}%`)
  assert.ok(v.rail.classList.contains('fh-has-floor') && !v.rail.classList.contains('fh-has-limit'))
  v.next.click(1)
  assert.deepEqual(calls.splice(0), [`goto ${at(2026, 8, 21, 18)}`])
  // today
  bar.update({ tMs: at(2026, 8, 24, 9, 30), playing: false, rate: 1, loading: false })
  v = view()
  assert.deepEqual([v.prev.disabled, v.next.disabled], [false, true])
  assert.equal(v.rail.style.props['--fh-lim'], `${(45_000 / 864).toFixed(3)}%`)
  assert.ok(!v.rail.classList.contains('fh-has-floor') && v.rail.classList.contains('fh-has-limit'))
  v.prev.click(1)
  assert.deepEqual(calls.splice(0), [`goto ${at(2026, 8, 23, 9, 30)}`])
  // a disabled arrow does nothing
  v.next.click(1)
  assert.deepEqual(calls, [])
})

test('the arrows: a target clamped into the bounds; a mouse click leaves no focus; a key keeps it', () => {
  const { bar, view, calls } = mount()
  bar.setBounds(at(2026, 8, 20, 14, 7, 31), at(2026, 8, 24, 12, 30))
  bar.update({ tMs: at(2026, 8, 21, 9), playing: false, rate: 1, loading: false })
  let v = view()
  v.prev.focus()
  v.prev.click(0) // a key
  assert.deepEqual(calls.splice(0), [`goto ${at(2026, 8, 20, 14, 7, 31)}`], '09:00 on the oldest day is before the oldest moment: held at it')
  assert.equal(doc.activeElement, v.prev, 'the keyboard keeps the focus on the arrow')
  v.prev.click(1)
  assert.equal(doc.activeElement, null, 'a mouse click leaves none')
  // the app follows: the replay is on the oldest day now, ‹ is off, and a focused ‹ hands the focus to the calendar
  v.prev.focus()
  bar.update({ tMs: at(2026, 8, 20, 14, 7, 31), playing: false, rate: 1, loading: false })
  v = view()
  assert.equal(v.prev.disabled, true)
  assert.equal(doc.activeElement, v.cal, 'a disabled button keeps no focus: the calendar has it')
})

test('a seek on the scrubber is held inside what exists: before the oldest moment and past the newest it is the bound', () => {
  const { bar, view, calls } = mount()
  const [oldest, newest] = [at(2026, 8, 20, 14, 7, 31), at(2026, 8, 24, 12, 30)]
  bar.setBounds(oldest, newest)
  bar.update({ tMs: at(2026, 8, 20, 18), playing: false, rate: 1, loading: false })
  const v = view()
  v.range.fire('pointerdown')
  v.range.value = '100'
  v.range.fire('input')
  assert.deepEqual(calls.splice(0), [`seek ${oldest}`], 'a drag before the oldest moment')
  v.range.fire('keydown', { key: 'Home' })
  assert.deepEqual(calls.splice(0), [`seek ${oldest}`], 'Home')
  v.range.value = '86000'
  v.range.fire('input')
  assert.deepEqual(calls.splice(0), [`seek ${at(2026, 8, 20) + 86_000_000}`], 'inside the day, past the oldest moment: as it is')
  bar.update({ tMs: at(2026, 8, 24, 9), playing: false, rate: 1, loading: false })
  const w = view()
  w.range.value = '86000'
  w.range.fire('input')
  assert.deepEqual(calls.splice(0), [`seek ${newest}`], 'past the newest on its day')
  w.range.fire('keydown', { key: 'End' })
  assert.deepEqual(calls.splice(0), [`seek ${newest}`])
})

test('the loader: aria-busy on the bar, kept over a day change, off when loading ends; the same state writes nothing new', () => {
  const { bar, view, root } = mount()
  bar.update({ tMs: at(2026, 8, 22, 12), playing: false, rate: 1, loading: false })
  assert.equal(view().barEl.attrs['aria-busy'], undefined)
  bar.update({ tMs: at(2026, 8, 22, 12), playing: false, rate: 1, loading: true })
  assert.equal(view().barEl.attrs['aria-busy'], 'true')
  assert.equal(one(root, 'fh-playbar-busy').parent, view().rail)
  bar.update({ tMs: at(2026, 8, 23, 0, 0, 1), playing: true, rate: 10, loading: true }) // past midnight: a new bar
  assert.equal(one(root, 'fh-playbar-busy').parent, view().rail, 'one bar, one ring')
  assert.equal(view().barEl.attrs['aria-busy'], 'true', 'the new bar is busy at once')
  assert.equal(text(one(root, 'fh-playbar-title')), 'Replay · Wed 23 Sep')
  bar.update({ tMs: at(2026, 8, 23, 0, 0, 2), playing: true, rate: 10, loading: false })
  assert.equal(view().barEl.attrs['aria-busy'], 'false')
})

test('the rail: legs amber, missing half hours hatched; kept over a day change; [] clears the legs', () => {
  const { bar, view, root } = mount()
  bar.update({ tMs: at(2026, 8, 22, 12), playing: false, rate: 1, loading: false })
  const day = localDay(at(2026, 8, 22, 12))
  const slot = Math.floor((day.startMs + 5 * H) / SLOT_MS) * SLOT_MS
  bar.setMissing([slot])
  bar.setLegs([{ fromMs: day.startMs + 6 * H, toMs: day.startMs + 8 * H }, { fromMs: day.startMs - H, toMs: day.startMs + H }])
  const states = (): string[][] => all(root).filter((e) => e.has('fh-playbar-segs')).flatMap((b) => b.children.map((s) => [s.attrs['data-state'], s.style.props.left, s.style.props.width]))
  assert.deepEqual(states().map((s) => s[0]), ['missing', 'leg', 'leg'])
  bar.update({ tMs: at(2026, 8, 23, 1), playing: false, rate: 1, loading: false }) // next day: the legs cross midnight into it? no: they end before
  assert.deepEqual(states(), [], 'legs and missing are of the day before: none on the next')
  bar.update({ tMs: at(2026, 8, 22, 1), playing: false, rate: 1, loading: false })
  assert.deepEqual(states().map((s) => s[0]), ['missing', 'leg', 'leg'], 'back: they are there again')
  bar.setLegs([])
  assert.deepEqual(states().map((s) => s[0]), ['missing'])
  void view
})

test('Go to: opens with the shown moment, the fields limited to what exists, the chips counted from now; Go on only for a moment that exists', () => {
  const { bar, view, calls, root } = mount()
  const oldest = at(2026, 8, 20, 14, 7, 31)
  const newest = at(2026, 8, 24, 12, 30)
  bar.setBounds(oldest, newest)
  bar.update({ tMs: at(2026, 8, 22, 17, 43), playing: false, rate: 1, loading: false })
  const v = view()
  const [date, time] = all(v.pop).filter((e) => e.tag === 'input')
  const go = one(v.pop, 'fh-goto-go')
  const chips = all(v.pop).filter((e) => e.has('fh-goto-chip'))
  v.cal.click(0) // a key
  assert.equal(v.pop.hidden, false)
  assert.equal(v.cal.attrs['aria-expanded'], 'true')
  assert.deepEqual([date.min, date.max, date.value, time.value, time.min, time.max], ['2026-09-20', '2026-09-24', '2026-09-22', '17:43', '', ''])
  assert.equal(go.disabled, false)
  // now is 22 Sep 17:43:55: 1 h ago and 6 h ago exist; Yesterday (21 Sep 17:43) too; a week ago (15 Sep) is before the oldest moment
  assert.deepEqual(chips.map((c) => [text(c), c.disabled]), [['1 h ago', false], ['6 h ago', false], ['Yesterday', false], ['A week ago', true]])
  assert.equal(doc.activeElement, chips[0], 'a key opened it: the first chip that can be chosen has the focus')
  // the first day: the time field's min; the shown 17:43 is fine, 14:00 is not
  date.value = '2026-09-20'
  date.fire('change')
  assert.deepEqual([time.min, time.max, go.disabled], ['14:08', '', false])
  time.value = '14:00'
  time.fire('input')
  assert.equal(go.disabled, true, 'before the oldest moment')
  time.value = '14:08'
  time.fire('input')
  assert.equal(go.disabled, false)
  // the last day
  date.value = '2026-09-24'
  date.fire('change')
  assert.deepEqual([time.min, time.max, go.disabled], ['', '12:30', true], '14:08 is past the newest 12:30')
  time.value = '12:30'
  time.fire('input')
  assert.equal(go.disabled, false)
  time.value = '12:31'
  time.fire('input')
  assert.equal(go.disabled, true)
  // outside the days: the date field itself is invalid
  time.value = '12:00'
  date.value = '2026-09-25'
  date.fire('change')
  assert.deepEqual([time.min, time.max, go.disabled], ['', '', true])
  date.value = ''
  date.fire('input')
  assert.equal(go.disabled, true, 'empty')
  // Go: submit the form (Enter in a field clicks Go with detail 0)
  date.value = '2026-09-21'
  date.fire('change')
  go.click(0)
  assert.deepEqual(calls.splice(0), [`goto ${at(2026, 8, 21, 12)}`])
  assert.equal(v.pop.hidden, true, 'closed by the jump')
  // disabled Go: a click does nothing
  v.cal.click(0)
  date.value = '2026-09-26'
  date.fire('change')
  go.click(0)
  assert.deepEqual(calls, [])
  // a chip
  chips[2].click(1)
  assert.deepEqual(calls.splice(0), [`goto ${NOW - 24 * H}`])
  void root
})

test('Go to: a disabled chip cannot be pressed; Esc closes the popover and only that; closeGoTo says whether it was open', () => {
  const { bar, view, calls } = mount()
  bar.setBounds(at(2026, 8, 22, 12), at(2026, 8, 22, 17, 30))
  bar.update({ tMs: at(2026, 8, 22, 15), playing: false, rate: 1, loading: false })
  const v = view()
  const chips = all(v.pop).filter((e) => e.has('fh-goto-chip'))
  v.cal.click(1)
  assert.equal(v.pop.hidden, false)
  assert.deepEqual(chips.map((c) => c.disabled), [false, true, true, true], 'only 1 h ago (16:43:55) exists in 12:00–17:30')
  chips[1].click(1)
  assert.deepEqual(calls, [])
  assert.equal(doc.activeElement, null, 'a mouse opened it: nothing focused')
  const esc = keyOnWindow('Escape')
  assert.equal(esc.stopped, true)
  assert.equal(v.pop.hidden, true)
  assert.equal(bar.closeGoTo(), false)
  bar.openGoTo()
  assert.equal(doc.activeElement, v.pop, 'opened for the keyboard: the popover itself')
  assert.equal(bar.closeGoTo(), true)
  assert.equal(doc.activeElement, v.cal, 'the keyboard goes back to the calendar')
  v.cal.click(0)
  pointerDown(v.prev) // a press elsewhere closes it
  assert.equal(v.pop.hidden, true)
})

test('Go to: all chips off and the date focused when none can be chosen; setBounds while open refreshes the fields and chips', () => {
  const { bar, view } = mount()
  bar.setBounds(NOW - 600_000, NOW - 300_000) // a ten-minute window: no chip exists
  bar.update({ tMs: NOW - 400_000, playing: false, rate: 1, loading: false })
  const v = view()
  const [date, time] = all(v.pop).filter((e) => e.tag === 'input')
  const chips = all(v.pop).filter((e) => e.has('fh-goto-chip'))
  const go = one(v.pop, 'fh-goto-go')
  v.cal.click(0)
  assert.deepEqual(chips.map((c) => c.disabled), [true, true, true, true])
  assert.equal(doc.activeElement, date)
  assert.deepEqual([date.min, date.max, time.min, time.max], ['2026-09-22', '2026-09-22', '17:34', '17:38'])
  void go
  bar.setBounds(NOW - 7 * H, NOW - 300_000) // the window grows while the popover is open
  assert.deepEqual(chips.map((c) => c.disabled), [false, false, true, true], 'recomputed: 1 h and 6 h ago exist now')
  assert.deepEqual([time.min, time.max], ['10:44', '17:38'], 'one day holds both ends now: the field is limited at both')
})

test('a day change hands the focus on: the calendar and the arrows move with the tools; Play, the scrubber and Live are found in the new bar', () => {
  const { bar, view, root } = mount()
  bar.setBounds(at(2026, 8, 1), at(2026, 8, 30))
  bar.update({ tMs: at(2026, 8, 22, 23, 59, 58), playing: true, rate: 1, loading: false })
  let v = view()
  const play = one(root, 'fh-playbar-play')
  play.focus()
  const first = v.barEl
  bar.update({ tMs: at(2026, 8, 23, 0, 0, 1), playing: true, rate: 1, loading: false })
  v = view()
  assert.notEqual(v.barEl, first)
  assert.equal(all(root).filter((e) => e.has('fh-playbar')).length, 1)
  assert.equal(doc.activeElement, one(root, 'fh-playbar-play'), 'the same control of the new bar')
  v.next.focus()
  bar.update({ tMs: at(2026, 8, 24, 0, 0, 1), playing: true, rate: 1, loading: false })
  v = view()
  assert.equal(doc.activeElement, v.next, 'an arrow keeps the focus across the new bar')
  assert.equal(v.barEl.classList.contains('fh-playbar-again'), true)
  // the oldest day
  bar.update({ tMs: at(2026, 8, 2, 0, 0, 1), playing: false, rate: 1, loading: false })
  v.prev.focus()
  bar.update({ tMs: at(2026, 8, 1, 23, 59, 58), playing: false, rate: 1, loading: false })
  v = view()
  assert.equal(v.prev.disabled, true)
  assert.equal(doc.activeElement, v.cal, 'the day arrow the new day switched off: the calendar has the focus')
})

test('destroy: the bar goes, the popover listeners go; later calls do nothing', () => {
  const { bar, root, view } = mount()
  view().cal.click(0)
  assert.equal((win.listeners.get('keydown') ?? []).length, 1)
  bar.destroy()
  assert.equal(root.children.length, 0)
  assert.equal((win.listeners.get('keydown') ?? []).length, 0)
  assert.equal((doc.listeners.get('pointerdown') ?? []).length, 0)
  bar.update({ tMs: NOW, playing: false, rate: 1, loading: true })
  bar.setBounds(0, 1)
  bar.setLegs([])
  bar.setMissing([])
  bar.setNote('x')
  bar.openGoTo()
  assert.equal(bar.closeGoTo(), false)
  bar.destroy()
})

test('setBounds ignores what is not a range; a note is kept over a day change', () => {
  const { bar, view, root } = mount()
  bar.update({ tMs: at(2026, 8, 21, 12), playing: false, rate: 1, loading: false })
  bar.setBounds(Number.NaN, 5)
  bar.setBounds(10, 5)
  bar.setBounds(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)
  assert.deepEqual([view().prev.disabled, view().next.disabled], [false, false], 'the default bounds stand: 21 Sep is between 23 Aug and 22 Sep')
  assert.ok(!view().rail.classList.contains('fh-has-limit'))
  bar.setNote('No data for this time')
  assert.equal(text(one(root, 'fh-playbar-notice')), 'No data for this time')
  bar.update({ tMs: at(2026, 8, 23, 1), playing: false, rate: 1, loading: false })
  assert.equal(text(one(root, 'fh-playbar-notice')), 'No data for this time')
})

// The tip's geometry, as a browser would lay it out: the overlay (root) 1280 × 720, the bar's box 1,100 px wide from
// x = 40, its top at y = 570, the rail on it 864 px long from x = 100 (a 24 h day: 100 s a px), the tip 120 px wide.
type View = ReturnType<ReturnType<typeof mount>['view']>
function place(v: View): void {
  v.barEl.parent!.rect = { left: 0, top: 0, width: 1280, height: 720 }
  v.barEl.rect = { left: 40, top: 570, width: 1100, height: 72 }
  v.rail.rect = { left: 100, top: 603, width: 864, height: 6 }
  v.tip.offsetWidth = 120
}
/** The pointer's clientX over the rail at h:min:s of a 24 h day. */
const xAt = (h: number, min: number, s = 0): number => 100 + (h * 3600 + min * 60 + s) / 100
const hover = (v: View, x: number): void => void v.range.fire('pointermove', { clientX: x, pointerType: 'mouse', buttons: 0 })
const press = (v: View, x: number, id = 1, pointerType = 'mouse', button = 0): void =>
  void v.range.fire('pointerdown', { clientX: x, pointerId: id, pointerType, button })
const drag = (v: View, x: number, id = 1, pointerType = 'mouse'): void =>
  void v.range.fire('pointermove', { clientX: x, pointerId: id, pointerType, buttons: 1 })
const release = (v: View, x: number, id = 1): void => void v.range.fire('pointerup', { clientX: x, pointerId: id })
/** The browser moving the scrubber under the pointer (s after the day's start) and saying so. */
const scrub = (v: View, s: number): void => {
  v.range.value = String(s)
  v.range.fire('input')
}
/** The tip's words: its time, and its line with the line's tone when it has one. */
const says = (v: View): string[] => (v.tipLine.hidden ? [text(v.tipTime)] : [text(v.tipTime), text(v.tipLine), v.tipLine.attrs['data-tone']])

test('the tip: the minute under the pointer, above the bar centred on it, held inside its ends; it follows the pointer and goes as it leaves', () => {
  const { bar, view } = mount()
  bar.setBounds(at(2026, 8, 20), at(2026, 8, 24))
  bar.update({ tMs: at(2026, 8, 22, 9), playing: false, rate: 1, loading: false })
  const v = view()
  place(v)
  assert.equal(v.tip.hidden, true, 'none until the pointer comes')
  assert.equal(v.tip.parent, v.barEl.parent, 'beside the bar, so it can stand over what the bar is under')
  assert.equal(v.tip.attrs['aria-hidden'], 'true', 'for the eye: the scrubber says the time')
  hover(v, xAt(14, 30, 50))
  assert.deepEqual([v.tip.hidden, ...says(v)], [false, '14:30'], 'floored as the clock; nothing selected, nothing hatched: no line')
  // 582.5 px into the bar's box: the tip from 523 px on it (563 px in the overlay), the caret on the pointer 60 px in; 9 px
  // above the bar's top (720 − 570 + 9)
  assert.deepEqual([v.tip.style.props.left, v.tip.style.props['--fh-caret'], v.tip.style.props.bottom], ['563px', '60px', '159px'])
  hover(v, xAt(15, 30, 50))
  assert.deepEqual([says(v), v.tip.style.props.left], [['15:30'], '599px'], 'it follows (36 px on)')
  hover(v, xAt(0, 0) - 5) // the scrubber reaches half a thumb past the rail
  assert.deepEqual([...says(v), v.tip.style.props.left, v.tip.style.props['--fh-caret']], ['00:00', '40px', '55px'], 'the day’s start, at the bar’s end')
  hover(v, xAt(24, 0) + 5)
  assert.deepEqual(says(v), ['23:59'], 'the right end: the day’s last minute')
  v.range.fire('pointerleave')
  assert.equal(v.tip.hidden, true)
  v.range.fire('pointermove', { clientX: xAt(12, 0), pointerType: 'touch', buttons: 0 })
  assert.equal(v.tip.hidden, true, 'a finger shows it only while it presses')
  v.range.fire('pointermove', { clientX: xAt(12, 0), pointerType: 'mouse', buttons: 1 })
  assert.equal(v.tip.hidden, true, 'nor a press from elsewhere passing over (the map dragged)')
  v.range.fire('pointermove', { clientX: xAt(12, 0), pointerType: 'pen', buttons: 0 })
  assert.deepEqual([v.tip.hidden, ...says(v)], [false, '12:00'], 'a pen over it')
})

test('the tip: the selected aircraft at that minute (describe) under the time; the hatches say why; "No data" unless its flight is drawn over it', () => {
  const asked: number[] = []
  const describe = (t: number): AircraftLine => {
    asked.push(t)
    if (t < at(2026, 8, 22, 8)) return { label: 'Not heard', tone: 'quiet' }
    if (t < at(2026, 8, 22, 10)) return { label: 'ELY541 · flying', tone: 'heard' }
    if (t < at(2026, 8, 22, 10, 30)) return { label: 'ELY541 · out of coverage', tone: 'gap' }
    return { label: 'Not heard · on the ground', tone: 'quiet' }
  }
  const { bar, view } = mount({ describe })
  bar.setBounds(at(2026, 8, 22, 6), at(2026, 8, 22, 18, 30))
  bar.update({ tMs: at(2026, 8, 22, 9), playing: false, rate: 1, loading: false })
  const v = view()
  place(v)
  hover(v, xAt(9, 15, 30))
  assert.deepEqual(says(v), ['09:15', 'ELY541 · flying', 'heard'])
  assert.deepEqual(asked.splice(0), [at(2026, 8, 22, 9, 15)], 'asked for the minute itself, where a click goes')
  hover(v, xAt(10, 10))
  assert.deepEqual(says(v), ['10:10', 'ELY541 · out of coverage', 'gap'])
  hover(v, xAt(13, 0))
  assert.deepEqual(says(v), ['13:00', 'Not heard · on the ground', 'quiet'])
  asked.length = 0
  hover(v, xAt(20, 0))
  assert.deepEqual(says(v), ['20:00', 'Not published yet', 'beyond'])
  hover(v, xAt(5, 0))
  assert.deepEqual(says(v), ['05:00', 'Older than adsb.lol keeps', 'beyond'])
  assert.deepEqual(asked, [], 'no aircraft line where nothing exists')
  // the red hatch: half hours adsb.lol lacks
  const [morning, noon] = [slotOf(at(2026, 8, 22, 8, 40)), slotOf(at(2026, 8, 22, 12, 10))]
  bar.setMissing([morning, noon])
  hover(v, xAt(12, 10))
  assert.deepEqual(says(v), ['12:10', 'No data', 'missing'])
  hover(v, xAt(8, 40))
  assert.deepEqual(says(v), ['08:40', 'ELY541 · flying', 'heard'], 'its flight is drawn over the hatch: its line')
  // what changes under a pointer at rest shows at once
  hover(v, xAt(12, 10))
  bar.setMissing([morning])
  assert.deepEqual(says(v), ['12:10', 'Not heard · on the ground', 'quiet'], 'the half hour is there now')
  bar.setBounds(at(2026, 8, 22, 6), at(2026, 8, 22, 12))
  assert.deepEqual(says(v), ['12:10', 'Not published yet', 'beyond'], 'the newest moment as the status says')
  bar.setLegs([])
  assert.equal(v.tip.hidden, false, 'still shown')
})

test('a click on the rail goes to the minute the tip says, not where the browser put the thumb; on the thumb itself too; held inside what exists', () => {
  const { bar, view, calls } = mount()
  const newest = at(2026, 8, 22, 18, 30)
  bar.setBounds(at(2026, 8, 20), newest)
  bar.update({ tMs: at(2026, 8, 22, 9), playing: false, rate: 1, loading: false })
  const v = view()
  place(v)
  hover(v, xAt(14, 30, 50))
  assert.deepEqual(says(v), ['14:30'])
  press(v, xAt(14, 30, 50))
  assert.deepEqual([v.tip.hidden, ...says(v)], [false, '14:30'], 'shown while pressed')
  scrub(v, 52_250) // the browser: 14:30:50
  assert.deepEqual(calls.splice(0), [`seek ${at(2026, 8, 22, 14, 30)}`])
  drag(v, xAt(14, 30, 50) + 2) // a hand's tremor: still a click
  scrub(v, 52_450)
  assert.deepEqual(calls.splice(0), [`seek ${at(2026, 8, 22, 14, 30)}`])
  release(v, xAt(14, 30, 50) + 2)
  assert.deepEqual(calls, [], 'sought already: nothing more on release')
  assert.equal(v.tip.hidden, true, 'gone on release')
  hover(v, xAt(14, 30, 50) + 2)
  assert.equal(v.tip.hidden, false, 'and back with the next move')
  // a click on the thumb itself: the browser seeks nothing, the release goes to the minute
  press(v, xAt(8, 20, 20), 2)
  release(v, xAt(8, 20, 20), 2)
  assert.deepEqual(calls.splice(0), [`seek ${at(2026, 8, 22, 8, 20)}`])
  // past the newest moment: to it, the tip above the thumb held there
  press(v, xAt(20, 0), 3)
  assert.deepEqual([...says(v), v.tip.style.props['--fh-caret']], ['18:30', '60px'])
  assert.equal(v.tip.style.props.left, `${40 + Math.round(xAt(18, 30) - 40 - 60)}px`, 'above the thumb, at the newest moment')
  scrub(v, 66_600) // the bar's own limit holds the thumb at 18:30
  release(v, xAt(20, 0), 3)
  assert.deepEqual(calls.splice(0), [`seek ${newest}`])
  // another button, or a second pointer while one presses: nothing
  press(v, xAt(10, 0), 4, 'mouse', 2)
  release(v, xAt(10, 0), 4)
  press(v, xAt(10, 0), 5)
  press(v, xAt(11, 0), 6, 'touch')
  release(v, xAt(11, 0), 6)
  assert.deepEqual(calls, [], 'a right click, and the second finger')
  release(v, xAt(10, 0), 5)
  assert.deepEqual(calls.splice(0), [`seek ${at(2026, 8, 22, 10)}`])
  // a release that never came here (no pointer capture): the same pointer's next press is a press all the same
  press(v, xAt(10, 30, 20), 5)
  press(v, xAt(11, 30, 20), 5)
  release(v, xAt(11, 30, 20), 5)
  assert.deepEqual(calls.splice(0), [`seek ${at(2026, 8, 22, 11, 30)}`])
  // a key on the scrubber seeks as before
  v.range.fire('keydown', { key: 'Home' })
  assert.deepEqual(calls.splice(0), [`seek ${at(2026, 8, 22)}`])
})

test('a drag seeks finely as ever, the tip above the thumb saying the minute sought; a finger shows it only while it presses', () => {
  const { bar, view, calls } = mount()
  bar.setBounds(at(2026, 8, 20), at(2026, 8, 24))
  bar.update({ tMs: at(2026, 8, 22, 9), playing: false, rate: 1, loading: false })
  const v = view()
  place(v)
  press(v, xAt(10, 0, 50))
  scrub(v, 36_050)
  assert.deepEqual(calls.splice(0), [`seek ${at(2026, 8, 22, 10)}`], 'a click so far')
  drag(v, xAt(13, 20, 50))
  scrub(v, 48_010.3) // the thumb, grabbed a little off its centre
  assert.deepEqual(calls.splice(0), [`seek ${at(2026, 8, 22, 13, 20, 10, 300)}`], 'moved: the drag’s own fine seek')
  assert.deepEqual(says(v), ['13:20'], 'the minute sought, as the clock shows it')
  assert.equal(v.tip.style.props.left, '520px', 'above the thumb (580.103 px on the rail), not the pointer')
  drag(v, xAt(10, 0, 50) + 1)
  scrub(v, 36_150)
  assert.deepEqual(calls.splice(0), [`seek ${at(2026, 8, 22, 10, 2, 30)}`], 'back within 3 px of the press: a drag still')
  release(v, xAt(10, 0, 50) + 1)
  assert.deepEqual(calls, [], 'released: no seek of its own')
  assert.equal(v.tip.hidden, true)
  // a finger: none from its moves alone; one while it presses; a tap goes to its minute
  v.range.fire('pointermove', { clientX: xAt(16, 0), pointerType: 'touch', buttons: 0 })
  assert.equal(v.tip.hidden, true)
  press(v, xAt(16, 40, 50), 7, 'touch')
  assert.deepEqual([v.tip.hidden, ...says(v)], [false, '16:40'])
  drag(v, xAt(16, 40, 50) + 2, 7, 'touch')
  release(v, xAt(16, 40, 50) + 2, 7)
  assert.deepEqual(calls.splice(0), [`seek ${at(2026, 8, 22, 16, 40)}`])
  assert.equal(v.tip.hidden, true)
  // a drag the scrubber does not make (iOS Safari moves a range only by its thumb): the tip follows the finger, the release
  // goes there
  press(v, xAt(16, 40, 50), 8, 'touch')
  drag(v, xAt(18, 20, 50), 8, 'touch')
  assert.deepEqual(says(v), ['18:20'])
  release(v, xAt(18, 20, 50) + 1, 8)
  assert.deepEqual(calls.splice(0), [`seek ${at(2026, 8, 22, 18, 20)}`])
  // a press the browser takes over (pointercancel): no seek, no tip
  press(v, xAt(12, 0), 9, 'touch')
  v.range.fire('pointercancel', { pointerId: 9 })
  release(v, xAt(12, 0), 9)
  assert.deepEqual([calls, v.tip.hidden], [[], true])
})

test('the tip goes when the bar is mounted for a new day, and stands on the new bar; none over the open popover; destroy takes it', () => {
  const { bar, view, root } = mount()
  bar.setBounds(at(2026, 8, 1), at(2026, 8, 30))
  bar.update({ tMs: at(2026, 8, 22, 23, 59, 58), playing: true, rate: 1, loading: false })
  let v = view()
  place(v)
  hover(v, xAt(12, 0))
  assert.equal(v.tip.hidden, false)
  bar.update({ tMs: at(2026, 8, 23, 0, 0, 1), playing: true, rate: 1, loading: false }) // past midnight: a new bar
  v = view()
  assert.deepEqual([v.tip.hidden, all(root).filter((e) => e.has('fh-history-tip')).length], [true, 1])
  place(v)
  v.barEl.rect = { left: 60, top: 560, width: 1000, height: 72 } // the new bar's own box
  hover(v, xAt(12, 0))
  assert.deepEqual([v.tip.hidden, v.tip.style.props.left, v.tip.style.props.bottom], [false, '472px', '169px'], 'on the new bar: centred on 532 px, 9 px above its top')
  v.cal.click(0) // Go to by a key, the pointer at rest on the rail
  assert.equal(v.tip.hidden, true, 'the popover rises where it stood')
  hover(v, xAt(12, 5))
  assert.equal(v.tip.hidden, true, 'none while the popover is open')
  bar.closeGoTo()
  hover(v, xAt(12, 5))
  assert.equal(v.tip.hidden, false)
  bar.destroy()
  assert.equal(root.children.length, 0, 'with the bar')
  hover(v, xAt(12, 10))
  assert.equal(v.tip.hidden, true, 'and shows no more')
})

// client/ui/alerts.test.ts
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import type { AlertEvent, EventsReply } from '../../shared/alerts.ts'
import { SLOT_MS, newestSlotMs } from '../../shared/history.ts'

// alerts.ts imports its CSS for Vite. Node cannot load CSS, so this test process loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const {
  ago, eventsFeed, followTarget, freshEvents, mayAutoFollow, primaryAction, replayAtText, replayableAt, rowLabel, secondaryAction, tagOf,
  unseenCount, watchText,
} = await import('./alerts.ts')

const T = Date.UTC(2026, 9, 3, 12, 0) // the end of a half hour: the one before it is published at 12:00:20
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "HH:MM" in local time. */
const hm = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const ev = (id: string, o: Partial<AlertEvent> = {}): AlertEvent => ({
  id, hex: id.slice(0, 6), kind: 'squawk', callsign: null, reg: null, type: null, squawk: '7700', emergency: null, drop: null,
  lat: 1, lon: 2, altFt: 30_000, openedMs: T, lastMs: T, late: false, quiet: false, ...o,
})

test('freshEvents: the alerting events not known before, newest first; quiet ones never', () => {
  const known = new Set(['aaaaaa-1'])
  const next = [ev('cccccc-3', { openedMs: T + 2 }), ev('bbbbbb-2', { openedMs: T + 1, quiet: true }), ev('aaaaaa-1')]
  assert.deepEqual(freshEvents(known, next).map((e) => e.id), ['cccccc-3'])
})

test('freshEvents: newest first whatever the order given; the known set is not changed', () => {
  const known = new Set<string>()
  const next = [ev('aaaaaa-1', { openedMs: T }), ev('cccccc-3', { openedMs: T + 2 }), ev('bbbbbb-2', { openedMs: T + 1 })]
  assert.deepEqual(freshEvents(known, next).map((e) => e.id), ['cccccc-3', 'bbbbbb-2', 'aaaaaa-1'])
  assert.equal(known.size, 0)
})

test('unseenCount: the events opened after the panel was last opened', () => {
  assert.equal(unseenCount([ev('a', { openedMs: T + 5 }), ev('b', { openedMs: T - 5 })], T), 1)
  assert.equal(unseenCount([ev('a', { openedMs: T + 5, quiet: true })], T), 0)
})

test('unseenCount: also those that came in since, though they opened before (found late, or confirmed after the look)', () => {
  const events = [ev('a', { openedMs: T + 5 }), ev('b', { openedMs: T - 20 * 60_000, late: true }), ev('c', { openedMs: T - 5 })]
  assert.equal(unseenCount(events, T, new Set(['b'])), 2)
  assert.equal(unseenCount(events, T, new Set(['a', 'b'])), 2, 'counted once')
  assert.equal(unseenCount([ev('b', { quiet: true })], T, new Set(['b'])), 0)
})

test('ago: now, minutes, hours, then the day', () => {
  assert.equal(ago(T - 20_000, T), 'now')
  assert.equal(ago(T - 5 * 60_000, T), '5 min ago')
  assert.equal(ago(T - 3 * 3_600_000, T), '3 h ago')
  assert.match(ago(T - 3 * 86_400_000, T), /^[A-Z][a-z]{2} \d{2}:\d{2}$/) // e.g. "Wed 14:05", local time
})

test('ago: whole minutes and hours, rounded down; a time ahead of the clock is now; the day in local time', () => {
  assert.equal(ago(T - 59_999, T), 'now')
  assert.equal(ago(T - 60_000, T), '1 min ago')
  assert.equal(ago(T - 3_599_999, T), '59 min ago')
  assert.equal(ago(T - 3_600_000, T), '1 h ago')
  assert.equal(ago(T - 86_399_999, T), '23 h ago')
  assert.equal(ago(T + 5000, T), 'now', 'a little ahead of the clock (another clock): now')
  const d = new Date(T - 86_400_000)
  assert.equal(ago(T - 86_400_000, T), `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${hm(T - 86_400_000)}`)
})

test('ago: over 6 days old, the date (a weekday a week ago would read as today)', () => {
  const at = T - 6 * 86_400_000 - 60_000
  const d = new Date(at)
  assert.equal(ago(at, T), `${d.getDate()} ${MONTHS[d.getMonth()]} ${hm(at)}`) // e.g. "26 Sep 13:00", local time
  assert.match(ago(T - 7 * 86_400_000, T), /^\d{1,2} [A-Z][a-z]{2} \d{2}:\d{2}$/)
  assert.match(ago(T - 6 * 86_400_000, T), /^[A-Z][a-z]{2} \d{2}:\d{2}$/, 'six days: still the weekday, which is not today’s')
})

test('replayableAt: the end of the event’s half hour and the publish delay; History reaches the event from then, not before', () => {
  const e = ev('a', { openedMs: Date.UTC(2026, 9, 3, 11, 55) })
  assert.equal(replayableAt(e), Date.UTC(2026, 9, 3, 12, 0, 20))
  const end = (now: number): number => newestSlotMs(now) + SLOT_MS // History's newest moment at now
  assert.ok(end(replayableAt(e) - 1) < e.openedMs, 'just before: its half hour is not published')
  assert.ok(end(replayableAt(e)) >= e.openedMs, 'just after: it is')
  assert.ok(e.openedMs - 60_000 <= end(replayableAt(e)), 'and the replay’s start, a minute before it')
  // In the first minute of a half hour, the replay's start is in the half hour before: the event's own still decides.
  const early = ev('b', { openedMs: Date.UTC(2026, 9, 3, 12, 0, 30) })
  assert.equal(replayableAt(early), Date.UTC(2026, 9, 3, 12, 30, 20))
})

test('replayAtText: when Replay opens, in local time, to the next whole minute (never before it opens)', () => {
  const e = ev('a', { openedMs: Date.UTC(2026, 9, 3, 11, 55) }) // opens at 12:00:20
  assert.equal(replayAtText(e), `Replay at ${hm(Date.UTC(2026, 9, 3, 12, 1))}`)
})

test('primaryAction: an ongoing live event is followed; any other is replayed once History has it', () => {
  const past = T - 40 * 60_000 // 11:20: its half hour was published at 11:30:20
  assert.equal(primaryAction(ev('a', { openedMs: past, lastMs: T - 60_000 }), T), 'follow')
  assert.equal(primaryAction(ev('a', { openedMs: past, lastMs: T - 3 * 60_000 }), T), 'replay')
  assert.equal(primaryAction(ev('a', { openedMs: past, lastMs: past, late: true }), T), 'replay')
})

test('primaryAction: not ongoing and not in History yet: followed while seen within the hour, else replayed', () => {
  const e = ev('a', { openedMs: T - 10 * 60_000, lastMs: T - 3 * 60_000 }) // 11:50: History has it from 12:00:20
  assert.equal(primaryAction(e, T), 'follow', 'probably still flying')
  assert.equal(primaryAction(e, replayableAt(e) - 1), 'follow')
  assert.equal(primaryAction(e, replayableAt(e)), 'replay')
  assert.equal(primaryAction({ ...e, lastMs: T - 61 * 60_000 }, T), 'replay', 'not seen for an hour: replay (the row says when)')
})

test('secondaryAction: Replay beside a followed row; Live beside a replayed one seen within the hour; else the wait for History', () => {
  const past = T - 2 * 3_600_000 // 10:00: in History
  assert.equal(secondaryAction(ev('a', { openedMs: past, lastMs: T - 60_000 }), T), 'replay')
  assert.equal(secondaryAction(ev('a', { openedMs: past, lastMs: T - 3 * 60_000 }), T), 'follow')
  assert.equal(secondaryAction(ev('a', { openedMs: past, late: true, lastMs: T - 20 * 60_000 }), T), 'follow', 'found late, perhaps still flying')
  assert.equal(secondaryAction(ev('a', { openedMs: past, lastMs: T - 59 * 60_000 }), T), 'follow')
  assert.equal(secondaryAction(ev('a', { openedMs: past, lastMs: T - 60 * 60_000 }), T), null)
  assert.equal(secondaryAction(ev('a', { openedMs: T - 3 * 86_400_000, lastMs: T - 3 * 86_400_000 }), T), null)
  const soon = ev('a', { openedMs: T - 10 * 60_000, lastMs: T - 30_000 }) // ongoing; in History from 12:00:20
  assert.equal(secondaryAction(soon, T), 'later')
  assert.equal(secondaryAction({ ...soon, lastMs: T - 5 * 60_000 }, T), 'later', 'followed meanwhile: the wait beside it')
  assert.equal(secondaryAction(soon, replayableAt(soon)), 'replay', 'ongoing still: Replay beside Follow')
})

test('tagOf: the squawk, else EMG for a status, else an arrow for a fall; red for 7700, 7500 and falls, amber otherwise', () => {
  const fall = { fromFt: 35_000, toFt: 22_700, overS: 110, lost: false }
  assert.deepEqual(tagOf(ev('a')), { text: '7700', tone: 'danger' })
  assert.deepEqual(tagOf(ev('a', { squawk: '7500', emergency: 'unlawful' })), { text: '7500', tone: 'danger' })
  assert.deepEqual(tagOf(ev('a', { squawk: '7600' })), { text: '7600', tone: 'warn' })
  assert.deepEqual(tagOf(ev('a', { kind: 'status', squawk: null, emergency: 'minfuel' })), { text: 'EMG', tone: 'warn' })
  assert.deepEqual(tagOf(ev('a', { kind: 'descent', squawk: null, drop: fall })), { text: '↓', tone: 'danger' })
  assert.deepEqual(tagOf(ev('a', { kind: 'dive', squawk: '7600', drop: { ...fall, lost: true } })), { text: '7600', tone: 'danger' }, 'a fall is red whatever the code')
  assert.deepEqual(tagOf(ev('a', { kind: 'status', squawk: null, emergency: 'nordo', drop: fall })), { text: 'EMG', tone: 'danger' })
  assert.deepEqual(tagOf(ev('a', { squawk: '2000' })), { text: '2000', tone: 'warn' }, 'a code swept for a test (ALERT_SQUAWKS)')
})

test('watchText: what the server watches, from its switch and its source (no sweep period: it is longer at a low rate)', () => {
  assert.equal(watchText({ on: true, sweep: true, rev: 1, events: [] }), 'Watching: emergency squawks worldwide, and falls in each half hour of adsb.lol')
  assert.equal(watchText({ on: true, sweep: false, rev: 1, events: [] }), 'Watching what this app polls, and each half hour of adsb.lol')
  assert.equal(watchText({ on: false, sweep: true, rev: 1, events: [] }), 'Off')
  assert.equal(watchText(null), 'This server has no alerts: run it with make live')
})

test('rowLabel: the action, the aircraft, what happened and when, for a screen reader; and when Replay opens', () => {
  const e = ev('a', { callsign: 'FDB1073', type: 'B38M', openedMs: T - 40 * 60_000, lastMs: T - 30_000 })
  assert.equal(rowLabel(e, T), 'Follow FDB1073 · B38M live: Emergency · 7700, 40 min ago')
  assert.equal(rowLabel({ ...e, lastMs: T - 10 * 60_000 }, T), 'Replay FDB1073 · B38M in History: Emergency · 7700, 40 min ago')
  assert.equal(rowLabel({ ...e, late: true }, T), 'Replay FDB1073 · B38M in History: Emergency · 7700, 40 min ago, found late')
  const soon = { ...e, openedMs: T - 5 * 60_000 }
  assert.equal(rowLabel(soon, T), `Follow FDB1073 · B38M live: Emergency · 7700, 5 min ago, replay at ${hm(Date.UTC(2026, 9, 3, 12, 1))}`)
})

test('followTarget: where Follow flies the map: the newer of the live map’s position and the event’s', () => {
  const e = ev('a', { lat: 10, lon: 20, lastMs: T - 60_000 })
  assert.deepEqual(followTarget(e, { tMs: T - 5000, lat: 11, lon: 21 }), { lat: 11, lon: 21 }, 'the map’s is newer')
  assert.deepEqual(followTarget(e, { tMs: T - 3_600_000, lat: 11, lon: 21 }), { lat: 10, lon: 20 }, 'the map’s is from before History')
  assert.deepEqual(followTarget(e, null), { lat: 10, lon: 20 })
  assert.deepEqual(followTarget({ ...e, lat: null, lon: null }, { tMs: T - 3_600_000, lat: 11, lon: 21 }), { lat: 11, lon: 21 }, 'the event has none')
  assert.equal(followTarget({ ...e, lat: null, lon: null }, null), null)
})

test('mayAutoFollow: never in History or a scenario, nor against the person', () => {
  const calm = { history: false, scenario: false, mapMovedAgoMs: Infinity, handPickAgoMs: Infinity, chasing: false, otherSheet: false }
  assert.equal(mayAutoFollow(calm), true)
  assert.equal(mayAutoFollow({ ...calm, history: true }), false)
  assert.equal(mayAutoFollow({ ...calm, scenario: true }), false)
  assert.equal(mayAutoFollow({ ...calm, mapMovedAgoMs: 59_999 }), false, '(a) the map moved within the minute')
  assert.equal(mayAutoFollow({ ...calm, mapMovedAgoMs: 60_000 }), true)
  assert.equal(mayAutoFollow({ ...calm, handPickAgoMs: 119_999 }), false, '(b) an aircraft picked by hand within 2 min')
  assert.equal(mayAutoFollow({ ...calm, handPickAgoMs: 120_000 }), true)
  assert.equal(mayAutoFollow({ ...calm, chasing: true }), false, '(c) a chase, which the person started')
  assert.equal(mayAutoFollow({ ...calm, otherSheet: true }), false, '(d) another tool’s sheet open on a phone')
})

const reply = (rev: number, events: AlertEvent[] = [], on = true): EventsReply => ({ on, sweep: true, rev, events })
const settle = (): Promise<void> => new Promise((r) => setImmediate(r))
/** console.warn silenced for a test that fails on purpose. */
const quiet = (t: TestContext): void => void t.mock.method(console, 'warn', () => {})

test('eventsFeed: one request at a time; asks meanwhile ask once more after it; the answers in order', async () => {
  const asked: { resolve(r: EventsReply | null): void }[] = []
  const applied: (number | null)[] = []
  const feed = eventsFeed(() => new Promise((resolve) => asked.push({ resolve })), (r) => applied.push(r?.rev ?? null))
  feed.refresh()
  feed.refresh()
  feed.refresh()
  assert.equal(asked.length, 1)
  asked[0].resolve(reply(1))
  await settle()
  assert.equal(asked.length, 2, 'once more, not twice')
  asked[1].resolve(null)
  await settle()
  assert.equal(asked.length, 2)
  assert.deepEqual(applied, [1, null])
  feed.destroy()
})

test('eventsFeed: a failed ask is asked again once, 10 s later, with never two timers; an ask meanwhile takes its place', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  quiet(t)
  let n = 0
  let fail = true
  const applied: number[] = []
  const feed = eventsFeed(async () => {
    n++
    if (fail) throw new Error('HTTP 502')
    return reply(n)
  }, (r) => applied.push(r!.rev))
  feed.refresh()
  await settle()
  assert.equal(n, 1)
  t.mock.timers.tick(9999)
  await settle()
  assert.equal(n, 1)
  t.mock.timers.tick(1)
  await settle()
  assert.equal(n, 2, 'again 10 s on')
  t.mock.timers.tick(60_000)
  await settle()
  assert.equal(n, 2, 'once: a retry that fails waits for the next ask')
  feed.refresh() // fails: a retry due
  await settle()
  feed.refresh() // fails too: its retry takes the place of the first
  await settle()
  assert.equal(n, 4)
  t.mock.timers.tick(10_000)
  await settle()
  assert.equal(n, 5, 'one retry, not two')
  feed.refresh() // fails: a retry due…
  await settle()
  fail = false
  feed.refresh() // …and an ask that answers takes its place
  await settle()
  assert.deepEqual(applied, [7])
  t.mock.timers.tick(60_000)
  await settle()
  assert.equal(n, 7, 'no retry after an answer')
  feed.refresh()
  feed.destroy()
  t.mock.timers.tick(60_000)
  await settle()
  assert.deepEqual(applied, [7], 'nothing applied after destroy')
})

// ---- the panel and its toasts as mounted, on a fake DOM just rich enough for alerts.ts (and icons.ts) ----

interface FEvent {
  type: string
  target: FEl
  relatedTarget: FEl | null
  key?: string
  stopped: boolean
  defaultPrevented: boolean
  stopPropagation(): void
  preventDefault(): void
}
type Listener = (e: FEvent) => void

// The page: whether it is hidden or has the focus, its listeners, and the focused element (the body when none).
const doc = { activeElement: null as FEl | null, hidden: false, focused: true, listeners: new Map<string, Listener[]>() }

class FEl {
  tag: string
  children: FEl[] = []
  parent: FEl | null = null
  className = ''
  id = ''
  type = ''
  title = ''
  hidden = false
  disabled = false
  dataset: Record<string, string> = {}
  attrs: Record<string, string> = {}
  listeners = new Map<string, Listener[]>()
  #text = ''
  #classes = new Set<string>()
  classList = {
    add: (c: string): void => void this.#classes.add(c),
    toggle: (c: string, on?: boolean): boolean => {
      if (on ?? !this.#classes.has(c)) this.#classes.add(c)
      else this.#classes.delete(c)
      return this.#classes.has(c)
    },
    contains: (c: string): boolean => this.has(c),
  }
  constructor(tag: string) {
    this.tag = tag
  }
  get textContent(): string {
    return this.#text + this.children.map((c) => c.textContent).join('')
  }
  set textContent(v: string) {
    for (const c of this.children) c.parent = null
    this.children = []
    this.#text = v
  }
  get isConnected(): boolean {
    let x: FEl = this
    while (x.parent !== null) x = x.parent
    return x === page
  }
  has(c: string): boolean {
    return this.className.split(/\s+/).includes(c) || this.#classes.has(c)
  }
  append(...cs: FEl[]): void {
    for (const c of cs) {
      c.remove()
      c.parent = this
      this.children.push(c)
    }
  }
  prepend(...cs: FEl[]): void {
    for (const c of [...cs].reverse()) {
      c.remove()
      c.parent = this
      this.children.unshift(c)
    }
  }
  insertBefore(c: FEl, ref: FEl): void {
    c.remove()
    c.parent = this
    this.children.splice(this.children.indexOf(ref), 0, c)
  }
  replaceChildren(...cs: FEl[]): void {
    for (const c of this.children) c.parent = null
    this.children = []
    this.append(...cs)
  }
  remove(): void {
    if (this.parent === null) return
    if (doc.activeElement !== null && this.contains(doc.activeElement)) doc.activeElement = pageBody // the focus falls to the body, no event
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }
  contains(n: FEl | null): boolean {
    for (let x = n; x !== null; x = x.parent) if (x === this) return true
    return false
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null
  }
  addEventListener(type: string, f: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), f])
  }
  removeEventListener(type: string, f: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((g) => g !== f))
  }
  /** Dispatches from here up the parents (every event bubbles here); the event, to read what the listeners did. */
  fire(type: string, init: { relatedTarget?: FEl | null; key?: string } = {}): FEvent {
    const e: FEvent = {
      type, target: this, relatedTarget: init.relatedTarget ?? null, key: init.key, stopped: false, defaultPrevented: false,
      stopPropagation() { this.stopped = true },
      preventDefault() { this.defaultPrevented = true },
    }
    for (let el: FEl | null = this; el !== null && !e.stopped; el = el.parent) for (const f of el.listeners.get(type) ?? []) f(e)
    return e
  }
  click(): void {
    if (!this.disabled) this.fire('click')
  }
  focus(): void {
    const was = doc.activeElement
    if (was === this) return
    doc.activeElement = this
    was?.fire('focusout', { relatedTarget: this })
    this.fire('focusin', { relatedTarget: was === pageBody ? null : was })
  }
  blur(): void {
    if (doc.activeElement !== this) return
    doc.activeElement = pageBody
    this.fire('focusout')
  }
}

const page = new FEl('html')
const pageBody = new FEl('body')
page.append(pageBody)
doc.activeElement = pageBody

const all = (n: FEl): FEl[] => [n, ...n.children.flatMap(all)]
const find = (root: FEl, cls: string): FEl[] => all(root).filter((e) => e.has(cls))
const one = (root: FEl, cls: string): FEl => {
  const hits = find(root, cls)
  assert.equal(hits.length, 1, `one .${cls}, found ${hits.length}`)
  return hits[0]
}
/** Not hidden itself, nor inside a hidden part of the panel or the toasts (the rail's closed body around them does not count). */
const shown = (el: FEl): boolean => {
  for (let x: FEl | null = el; x !== null; x = x.parent) {
    if (x.hidden) return false
    if (x.has('fh-alerts') || x.has('fh-toasts')) return true
  }
  return true
}
const rowNamed = (root: FEl, row: string): FEl => all(root).find((e) => e.dataset.row === row)!
const sw = (root: FEl, row: string): FEl => one(rowNamed(root, row), 'fh-switch')
const rowOf = (root: FEl, id: string): FEl => all(root).find((e) => e.has('fh-alerts-item') && e.dataset.id === id)!

class FakeNotification {
  static permission: NotificationPermission = 'granted'
  static answer: NotificationPermission = 'granted' // what requestPermission settles on
  static asked = 0
  static made: { title: string; opts: NotificationOptions; n: FakeNotification }[] = []
  static requestPermission(): Promise<NotificationPermission> {
    FakeNotification.asked++
    FakeNotification.permission = FakeNotification.answer
    return Promise.resolve(FakeNotification.answer)
  }
  onclick: (() => void) | null = null
  closed = false
  constructor(title: string, opts: NotificationOptions) {
    FakeNotification.made.push({ title, opts, n: this })
  }
  close(): void {
    this.closed = true
  }
}

const win = { Notification: FakeNotification, isSecureContext: true, focused: 0, focus: () => void win.focused++ }
Object.assign(globalThis, {
  document: {
    createElement: (tag: string) => new FEl(tag),
    createElementNS: (_ns: string, tag: string) => new FEl(tag),
    get activeElement() {
      return doc.activeElement
    },
    get hidden() {
      return doc.hidden
    },
    get body() {
      return pageBody
    },
    hasFocus: () => doc.focused,
    addEventListener: (type: string, f: Listener) => void doc.listeners.set(type, [...(doc.listeners.get(type) ?? []), f]),
    removeEventListener: (type: string, f: Listener) => void doc.listeners.set(type, (doc.listeners.get(type) ?? []).filter((g) => g !== f)),
  },
  window: win,
  HTMLElement: FEl,
  Node: FEl,
  matchMedia: () => ({ matches: false }),
})
const { mountAlerts } = await import('./alerts.ts')

/** The tab goes to the background (hidden) or comes back, as a browser says it. */
function hide(t: TestContext, hidden: boolean): void {
  doc.hidden = hidden
  for (const f of doc.listeners.get('visibilitychange') ?? []) f({} as FEvent)
  t.after(() => void (doc.hidden = false))
}

function storage(init: Record<string, string> = {}): Storage & { m: Map<string, string> } {
  const m = new Map(Object.entries(init))
  return {
    m,
    get length() {
      return m.size
    },
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
  }
}

interface MountOpts {
  store?: Storage | null
  onSwitch?: (on: boolean) => Promise<EventsReply>
  get?: () => Promise<EventsReply | null> // GET /api/events; by default an answer that never comes
}

/** The panel mounted in a closed panel body (the rail hides it) on the page, with the app's side recorded; destroyed after the test. */
function mount(t: TestContext, o: MountOpts = {}) {
  doc.activeElement = pageBody
  const body = new FEl('div')
  body.hidden = true
  const ui = new FEl('div')
  pageBody.append(body, ui)
  const calls = { follow: [] as string[], replay: [] as string[], auto: [] as string[], badge: [] as (string | null)[], switch: [] as boolean[], get: 0 }
  const clock = { now: T, mounted: false }
  const handle = mountAlerts(body as unknown as HTMLElement, ui as unknown as HTMLElement, {
    store: o.store === undefined ? storage() : o.store,
    // The app's reads its ApiClient, not made yet while the rail mounts the panel: mounting must not ask the time.
    nowMs: () => {
      if (!clock.mounted) throw new Error('nowMs called while mounting')
      return clock.now
    },
    get: () => {
      if (!clock.mounted) throw new Error('get called while mounting')
      calls.get++
      return o.get?.() ?? new Promise(() => {})
    },
    onSwitch: o.onSwitch ?? (async (on) => {
      calls.switch.push(on)
      return { on, sweep: true, rev: 9, events: [] }
    }),
    onFollow: (e) => calls.follow.push(e.id),
    onReplay: (e) => calls.replay.push(e.id),
    onAuto: (e) => calls.auto.push(e.id),
    onBadge: (text) => calls.badge.push(text),
  })
  clock.mounted = true
  t.after(() => {
    handle.destroy() // its timers too, whatever the test asserted
    body.remove()
    ui.remove()
  })
  return { body, ui, calls, clock, handle, toasts: () => find(ui, 'fh-alerts-toast') }
}

const live = (id: string, o: Partial<AlertEvent> = {}): AlertEvent => ev(id, { callsign: `CS${id.slice(0, 3)}`, openedMs: T - 60_000, lastMs: T - 10_000, ...o })
const old = (id: string, o: Partial<AlertEvent> = {}): AlertEvent => ev(id, { openedMs: T - 2 * 86_400_000, lastMs: T - 2 * 86_400_000 + 600_000, ...o })
const fall = { fromFt: 35_000, toFt: 22_000, overS: 100, lost: false }

test('mountAlerts: nothing known yet: the switch waits, the list is loading; and nothing asks the app at mount', (t) => {
  const m = mount(t)
  assert.equal(sw(m.body, 'watch').disabled, true)
  assert.equal(one(m.body, 'fh-alerts').dataset.state, 'loading')
  assert.equal(shown(one(m.body, 'fh-alerts-skel')), true)
  assert.equal(shown(one(m.body, 'fh-alerts-line')), false)
  assert.deepEqual(m.calls, { follow: [], replay: [], auto: [], badge: [], switch: [], get: 0 }, 'mounted inside the rail: the app is not ready yet')
  m.handle.refresh()
  assert.equal(m.calls.get, 1, 'the app asks once it is')
})

test('mountAlerts: the first answer toasts nothing (the bell counts the week); a new event then toasts, notifies and is followed', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  FakeNotification.made = []
  FakeNotification.permission = 'granted'
  const m = mount(t, { store: storage({ 'fh.alerts.follow': '1', 'fh.alerts.notify': '1' }) })
  const first = [live('aaaaaa-1'), old('bbbbbb-2'), live('cccccc-3', { quiet: true, squawk: '7600' })]
  m.handle.update(reply(1, first))
  assert.equal(m.toasts().length, 0)
  assert.equal(FakeNotification.made.length, 0)
  assert.deepEqual(m.calls.auto, [])
  assert.equal(m.calls.badge.at(-1), '2', 'never opened: the whole week counts, quiet events not')
  assert.equal(sw(m.body, 'watch').disabled, false)
  assert.equal(sw(m.body, 'watch').getAttribute('aria-checked'), 'true')
  assert.equal(one(m.body, 'fh-alerts-line').textContent, 'Watching: emergency squawks worldwide, and falls in each half hour of adsb.lol')
  assert.equal(find(m.body, 'fh-alerts-item').length, 3)
  assert.equal(rowOf(m.body, 'cccccc-3').has('fh-alerts-quiet'), true, 'quiet: dimmed')

  doc.hidden = true // in the background: the notification's turn
  t.after(() => void (doc.hidden = false))
  const fresh = live('dddddd-4', { openedMs: T - 20_000, callsign: 'FDB1073', type: 'B38M' })
  m.handle.update(reply(2, [fresh, ...first]))
  const [toast] = m.toasts()
  assert.equal(m.toasts().length, 1)
  assert.equal(toast.dataset.id, 'dddddd-4')
  assert.equal(toast.dataset.tone, 'danger')
  assert.equal(one(toast, 'fh-alerts-toast-who').textContent, 'FDB1073 · B38M')
  assert.equal(one(toast, 'fh-alerts-toast-what').textContent, 'Emergency · 7700')
  assert.equal(one(toast, 'fh-alerts-toast-go').textContent, 'Follow')
  assert.equal(one(m.ui, 'fh-toasts').getAttribute('role'), 'status')
  assert.deepEqual(FakeNotification.made.map((x) => [x.title, x.opts]), [['FDB1073 · B38M', { body: 'Emergency · 7700', tag: 'dddddd-4' }]])
  assert.deepEqual(m.calls.auto, ['dddddd-4'])
  assert.equal(m.calls.badge.at(-1), '3')
  assert.equal(rowOf(m.body, 'dddddd-4').parent?.children[0], rowOf(m.body, 'dddddd-4'), 'newest first')

  // The notification's click: the window comes forward, the event is acted on as it is then, the notification closes.
  const n = FakeNotification.made[0].n
  n.onclick!()
  assert.equal(win.focused, 1)
  assert.deepEqual(m.calls.follow, ['dddddd-4'])
  assert.equal(n.closed, true)

  m.handle.update(reply(3, [fresh, ...first]))
  assert.equal(m.toasts().length, 1, 'an event toasts once')
  m.handle.destroy()
  assert.equal(m.toasts().length, 0)
})

test('mountAlerts: a late event toasts Replay and is not followed; with the options off, no notification and no follow', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  FakeNotification.made = []
  doc.focused = false // a notification would be due, were the option on
  t.after(() => void (doc.focused = true))
  const m = mount(t)
  m.handle.update({ on: true, sweep: false, rev: 1, events: [] })
  assert.equal(one(m.body, 'fh-alerts-line').textContent, 'Watching what this app polls, and each half hour of adsb.lol')
  assert.equal(shown(one(m.body, 'fh-alerts-empty')), true)
  // Found in the 11:00 half hour, published at 11:30.
  const found = ev('aaaaaa-1', { kind: 'descent', squawk: null, drop: fall, late: true, openedMs: T - 40 * 60_000, lastMs: T - 38 * 60_000 })
  m.handle.update({ on: true, sweep: false, rev: 2, events: [found] })
  assert.equal(one(m.toasts()[0], 'fh-alerts-toast-go').textContent, 'Replay')
  assert.equal(one(m.toasts()[0], 'fh-alerts-tag').textContent, '↓')
  m.handle.update({ on: true, sweep: false, rev: 3, events: [live('bbbbbb-2'), found] })
  assert.equal(m.toasts().length, 2)
  assert.equal(FakeNotification.made.length, 0)
  assert.deepEqual(m.calls.auto, [], 'Follow automatically is off')
})

test('mountAlerts: Follow automatically takes the newest new event that is followed, not the newest of all', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const m = mount(t, { store: storage({ 'fh.alerts.follow': '1' }) })
  m.handle.update(reply(1))
  m.clock.now = T + 60_000
  // Found late in the half hour to 12:00 (published): the newest, but replayed; the other is ongoing.
  const found = ev('aaaaaa-1', { kind: 'descent', squawk: null, drop: fall, late: true, openedMs: T - 20 * 60_000, lastMs: T - 19 * 60_000 })
  const ongoingOne = live('bbbbbb-2', { openedMs: T - 25 * 60_000, lastMs: T + 50_000 })
  m.handle.update(reply(2, [found, ongoingOne]))
  assert.deepEqual(m.toasts().map((x) => [x.dataset.id, x.dataset.action]), [['aaaaaa-1', 'replay'], ['bbbbbb-2', 'follow']])
  assert.deepEqual(m.calls.auto, ['bbbbbb-2'])
  m.handle.update(reply(3, [ev('cccccc-3', { kind: 'descent', squawk: null, drop: fall, late: true, openedMs: T - 15 * 60_000, lastMs: T - 14 * 60_000 }), found, ongoingOne]))
  assert.deepEqual(m.calls.auto, ['bbbbbb-2'], 'none to follow: no call')
})

test('mountAlerts: a notification only while the page is hidden or not focused; a visible, focused page has the toast', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  FakeNotification.made = []
  FakeNotification.permission = 'granted'
  const m = mount(t, { store: storage({ 'fh.alerts.notify': '1' }) })
  m.handle.update(reply(1))
  m.handle.update(reply(2, [live('aaaaaa-1')]))
  assert.equal(m.toasts().length, 1)
  assert.equal(FakeNotification.made.length, 0, 'visible and focused: the toast is enough')
  doc.focused = false
  t.after(() => void (doc.focused = true))
  m.handle.update(reply(3, [live('bbbbbb-2'), live('aaaaaa-1')]))
  assert.deepEqual(FakeNotification.made.map((x) => x.opts.tag), ['bbbbbb-2'], 'another window in front')
  doc.focused = true
  doc.hidden = true
  t.after(() => void (doc.hidden = false))
  m.handle.update(reply(4, [live('cccccc-3'), live('bbbbbb-2'), live('aaaaaa-1')]))
  assert.deepEqual(FakeNotification.made.map((x) => x.opts.tag), ['bbbbbb-2', 'cccccc-3'], 'a tab in the background')
})

test('mountAlerts: a hidden page with notifications on asks for the events every 30 s; a visible one leaves it to the polls', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  FakeNotification.permission = 'granted'
  const step = async (ms: number): Promise<void> => {
    t.mock.timers.tick(ms)
    await settle()
  }
  const m = mount(t, { store: storage({ 'fh.alerts.notify': '1' }), get: async () => reply(1) })
  await step(120_000)
  assert.equal(m.calls.get, 0, 'visible: the polls say when')
  hide(t, true)
  await step(29_999)
  assert.equal(m.calls.get, 0)
  await step(1)
  assert.equal(m.calls.get, 1)
  await step(30_000)
  assert.equal(m.calls.get, 2)
  hide(t, false)
  await step(120_000)
  assert.equal(m.calls.get, 2, 'visible again: the polls take over')
  // Notifications off: nothing to say in the background, nothing asked.
  const off = mount(t, { store: storage(), get: async () => reply(1) })
  hide(t, true)
  for (let i = 0; i < 4; i++) await step(30_000)
  assert.equal(off.calls.get, 0)
  assert.equal(m.calls.get, 6, 'the first one asks again meanwhile')
  hide(t, false)
  // A page opened in a background tab: hidden from the start.
  doc.hidden = true
  const bg = mount(t, { store: storage({ 'fh.alerts.notify': '1' }), get: async () => reply(1) })
  await step(30_000)
  assert.equal(bg.calls.get, 1)
  doc.hidden = false
})

test('mountAlerts: an answer with a lower rev than the one shown is dropped, however late it comes; a restarted server\'s rev is higher', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  let answer!: (r: EventsReply) => void
  const m = mount(t, { onSwitch: () => new Promise((res) => (answer = res)) })
  m.handle.update(reply(5, [], false))
  const s = sw(m.body, 'watch')
  s.click() // on: the POST goes
  m.handle.update(reply(7, [], true)) // a GET sent after it answers first
  answer(reply(6, [], true)) // the POST's own answer, older
  await settle()
  assert.equal(s.getAttribute('aria-checked'), 'true')
  assert.equal(s.disabled, false, 'its wait ends all the same')
  assert.equal(shown(one(m.body, 'fh-alerts-spin')), false)
  m.handle.update(reply(6, [], false)) // a GET sent before the POST, come late
  assert.equal(s.getAttribute('aria-checked'), 'true', 'not rolled back')
  m.handle.update(reply(7, [live('aaaaaa-1')], true)) // the same rev again: taken
  assert.equal(find(m.body, 'fh-alerts-item').length, 1)
  t.mock.timers.tick(20_000)
  m.handle.update(reply(6, [], false)) // later than any request takes, and still older
  assert.equal(s.getAttribute('aria-checked'), 'true')
  assert.equal(find(m.body, 'fh-alerts-item').length, 1)
  m.handle.update(reply(T, [], false)) // a restarted server: its rev starts at its clock, above any it gave before
  assert.equal(s.getAttribute('aria-checked'), 'false')
  assert.equal(find(m.body, 'fh-alerts-item').length, 0)
})

test('mountAlerts: a server without alerts is not asked on the timer; once it has them, it is again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  FakeNotification.permission = 'granted'
  const step = async (ms: number): Promise<void> => {
    t.mock.timers.tick(ms)
    await settle()
  }
  const m = mount(t, { store: storage({ 'fh.alerts.notify': '1' }), get: async () => null })
  hide(t, true) // in the background with notifications on: the timer's turn
  await step(30_000)
  assert.equal(m.calls.get, 1, 'not known yet: asked')
  await step(120_000)
  assert.equal(m.calls.get, 1, 'no alerts on this server (a 404 each time): not asked again')
  m.handle.update(reply(1)) // a server with them now (its next answer to the app)
  await step(30_000)
  assert.equal(m.calls.get, 2)
})

test('mountAlerts: in History or a scenario (no live polls) the panel asks every 30 s itself and toasts what is new; hidden, only with notifications on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const step = async (ms: number): Promise<void> => {
    t.mock.timers.tick(ms)
    await settle()
  }
  let answer = reply(1)
  const m = mount(t, { store: storage({ 'fh.alerts.follow': '1' }), get: async () => answer })
  m.handle.update(reply(1))
  await step(60_000)
  assert.equal(m.calls.get, 0, 'live: the polls say when')
  m.handle.setLivePolling(false) // History, or a scenario
  answer = reply(2, [live('aaaaaa-1')])
  await step(29_999)
  assert.equal(m.calls.get, 0)
  await step(1)
  assert.equal(m.calls.get, 1)
  assert.deepEqual(m.toasts().map((x) => x.dataset.id), ['aaaaaa-1'], 'its toast shows there too')
  assert.deepEqual(m.calls.auto, ['aaaaaa-1'], 'the app is asked, and decides (mayAutoFollow: never in History or a scenario)')
  await step(30_000)
  assert.equal(m.calls.get, 2)
  m.handle.setLivePolling(true) // live again
  await step(120_000)
  assert.equal(m.calls.get, 2)
  m.handle.setLivePolling(false)
  hide(t, true) // and in the background, notifications off: nothing could reach the person
  await step(120_000)
  assert.equal(m.calls.get, 2)
  hide(t, false)
  await step(30_000)
  assert.equal(m.calls.get, 3, 'shown again, still in History')
  m.handle.update(null) // a server without alerts: not even in History
  await step(120_000)
  assert.equal(m.calls.get, 3)
})

test('mountAlerts: at most 3 toasts, the newest on top; each closes after 30 s, by ×, or by its button, which acts', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const m = mount(t)
  m.handle.update(reply(1))
  const five = [1, 2, 3, 4, 5].map((i) => live(`a${i}a${i}a${i}-${i}`, { openedMs: T - 60_000 + i }))
  m.handle.update(reply(2, five))
  assert.deepEqual(m.toasts().map((x) => x.dataset.id), ['a5a5a5-5', 'a4a4a4-4', 'a3a3a3-3'])
  const sixth = live('a6a6a6-6', { openedMs: T })
  m.handle.update(reply(3, [sixth, ...five]))
  assert.deepEqual(m.toasts().map((x) => x.dataset.id), ['a6a6a6-6', 'a5a5a5-5', 'a4a4a4-4'], 'the oldest went')
  one(m.toasts()[1], 'fh-alerts-toast-x').click()
  t.mock.timers.tick(200) // its fade
  assert.deepEqual(m.toasts().map((x) => x.dataset.id), ['a6a6a6-6', 'a4a4a4-4'])
  one(m.toasts()[0], 'fh-alerts-toast-go').click()
  assert.deepEqual(m.calls.follow, ['a6a6a6-6'])
  t.mock.timers.tick(200)
  assert.deepEqual(m.toasts().map((x) => x.dataset.id), ['a4a4a4-4'])
  // Kept while the pointer is on it; the rest of its time once it leaves.
  const last = m.toasts()[0]
  last.fire('pointerenter')
  t.mock.timers.tick(60_000)
  assert.equal(m.toasts().length, 1)
  last.fire('pointerleave')
  t.mock.timers.tick(29_000)
  assert.equal(m.toasts().length, 1)
  t.mock.timers.tick(1200)
  t.mock.timers.tick(200) // its fade (a timer set during a tick counts from the tick's end)
  assert.equal(m.toasts().length, 0, 'gone 30 s after it came, the time under the pointer not counted')
})

test('mountAlerts: a closed toast is never armed again (the pointer or the focus leaving it as it goes)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const m = mount(t)
  m.handle.update(reply(1))
  m.handle.update(reply(2, [live('aaaaaa-1')]))
  const [toast] = m.toasts()
  const x = one(toast, 'fh-alerts-toast-x')
  toast.fire('pointerenter')
  x.focus()
  const mocked = globalThis.setTimeout
  let made = 0
  globalThis.setTimeout = ((...a: Parameters<typeof setTimeout>) => {
    made++
    return mocked(...a)
  }) as typeof setTimeout
  try {
    x.click() // closes: its fade is the one timer
    toast.fire('pointerleave')
    toast.fire('focusout')
  } finally {
    globalThis.setTimeout = mocked
  }
  assert.equal(made, 1)
})

test('mountAlerts: closing a focused toast gives the focus to the next one’s ×, else back where it was; Esc in a toast closes it alone', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const m = mount(t)
  const before = new FEl('button')
  pageBody.append(before)
  t.after(() => before.remove())
  m.handle.update(reply(1))
  m.handle.update(reply(2, [live('aaaaaa-1', { openedMs: T - 2000 }), live('bbbbbb-2', { openedMs: T - 1000 })]))
  const [top, below] = m.toasts()
  before.focus()
  one(top, 'fh-alerts-toast-x').focus()
  one(top, 'fh-alerts-toast-x').click()
  assert.equal(doc.activeElement, one(below, 'fh-alerts-toast-x'), 'the next toast’s ×')
  const esc = one(below, 'fh-alerts-toast-go').fire('keydown', { key: 'Escape' })
  assert.equal(esc.stopped, true, 'the app’s Esc (close the panel, leave the chase) does not run')
  assert.equal(esc.defaultPrevented, true)
  t.mock.timers.tick(200)
  assert.equal(m.toasts().length, 0)
  assert.equal(doc.activeElement, before, 'back where it was before the toasts')
  // Where that is gone, the body.
  m.handle.update(reply(3, [live('cccccc-3')]))
  before.focus()
  one(m.toasts()[0], 'fh-alerts-toast-x').focus()
  before.remove()
  one(m.toasts()[0], 'fh-alerts-toast-x').click()
  assert.equal(doc.activeElement, pageBody)
  t.mock.timers.tick(200)
  // Another key, or Esc outside the toasts, is not theirs.
  m.handle.update(reply(4, [live('dddddd-4'), live('cccccc-3')]))
  assert.equal(one(m.toasts()[0], 'fh-alerts-toast-x').fire('keydown', { key: 'Enter' }).stopped, false)
  assert.equal(m.toasts().length, 1)
})

test('mountAlerts: the switch asks the server, waits disabled, then shows its answer; a failure says so', async (t) => {
  quiet(t)
  let answer!: (r: EventsReply) => void
  let fail!: (e: Error) => void
  const asked: boolean[] = []
  const m = mount(t, {
    onSwitch: (on) => {
      asked.push(on)
      return new Promise((res, rej) => {
        answer = res
        fail = rej
      })
    },
  })
  m.handle.update({ on: false, sweep: true, rev: 1, events: [] })
  const s = sw(m.body, 'watch')
  assert.equal(s.getAttribute('aria-checked'), 'false')
  assert.equal(one(m.body, 'fh-alerts-line').textContent, 'Off')
  rowNamed(m.body, 'watch').click() // the whole row is the target
  assert.deepEqual(asked, [true])
  assert.equal(s.disabled, true)
  assert.equal(shown(one(m.body, 'fh-alerts-spin')), true)
  s.click()
  assert.deepEqual(asked, [true], 'one request at a time')
  answer({ on: true, sweep: true, rev: 2, events: [] })
  await settle()
  assert.equal(s.disabled, false)
  assert.equal(s.getAttribute('aria-checked'), 'true')
  assert.equal(shown(one(m.body, 'fh-alerts-spin')), false)
  s.click()
  fail(new Error('HTTP 502'))
  await settle()
  assert.deepEqual(asked, [true, false])
  assert.equal(s.disabled, false)
  assert.equal(s.getAttribute('aria-checked'), 'true', 'as the server last said')
  assert.equal(one(m.body, 'fh-alerts-line').textContent, 'Could not change it. Try again.')
})

test('mountAlerts: a server without alerts: the switch is off and disabled, the line says why, no list', (t) => {
  const m = mount(t)
  m.handle.update(null)
  const s = sw(m.body, 'watch')
  assert.equal(s.disabled, true)
  assert.equal(s.getAttribute('aria-checked'), 'false')
  assert.equal(one(m.body, 'fh-alerts-line').textContent, 'This server has no alerts: run it with make live')
  assert.equal(shown(one(m.body, 'fh-alerts-section')), false)
  assert.equal(shown(one(m.body, 'fh-alerts-list')), false)
  assert.equal(shown(one(m.body, 'fh-alerts-empty')), false)
  assert.equal(m.calls.badge.at(-1), null)
})

test('mountAlerts: a row follows an ongoing event and replays any other; its small button does the other, its row untouched', (t) => {
  const m = mount(t)
  const a0 = live('aaaaaa-1', { openedMs: T - 40 * 60_000 })
  const b0 = live('bbbbbb-2', { openedMs: T - 40 * 60_000, lastMs: T - 10 * 60_000 })
  m.handle.update(reply(1, [a0, b0, old('cccccc-3'), ev('dddddd-4', { kind: 'descent', squawk: null, drop: fall, late: true, openedMs: T - 50 * 60_000, lastMs: T - 45 * 60_000 })]))
  const [a, b, c, d] = ['aaaaaa-1', 'bbbbbb-2', 'cccccc-3', 'dddddd-4'].map((id) => rowOf(m.body, id))
  assert.equal(a.dataset.action, 'follow')
  assert.equal(one(a, 'fh-alerts-main').tag, 'button')
  assert.equal(one(a, 'fh-alerts-main').getAttribute('aria-label'), 'Follow CSaaa live: Emergency · 7700, 40 min ago')
  assert.equal(shown(one(a, 'fh-alerts-live')), true)
  assert.equal(one(a, 'fh-alerts-ago').textContent, '40 min ago')
  assert.equal(one(a, 'fh-alerts-alt').textContent, 'Replay')
  assert.equal(one(a, 'fh-alerts-alt').parent, a, 'a sibling of the row’s button, not inside it')
  assert.equal(shown(one(a, 'fh-alerts-at')), false)
  assert.equal(b.dataset.action, 'replay')
  assert.equal(shown(one(b, 'fh-alerts-live')), false)
  assert.equal(one(b, 'fh-alerts-alt').textContent, 'Live', 'seen within the hour')
  assert.equal(shown(one(c, 'fh-alerts-alt')), false, 'two days ago: replay only')
  assert.equal(shown(one(d, 'fh-alerts-late')), true)
  assert.equal(shown(one(a, 'fh-alerts-late')), false)
  one(a, 'fh-alerts-main').click()
  one(b, 'fh-alerts-main').click()
  one(a, 'fh-alerts-alt').click()
  one(b, 'fh-alerts-alt').click()
  one(c, 'fh-alerts-when').click() // the time is the row's too
  assert.deepEqual(m.calls.follow, ['aaaaaa-1', 'bbbbbb-2'])
  assert.deepEqual(m.calls.replay, ['bbbbbb-2', 'aaaaaa-1', 'cccccc-3'])
})

test('mountAlerts: a row whose event History lacks yet says when Replay opens, and turns as the half hour is published', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const m = mount(t)
  m.body.hidden = false // the panel is open: its 15 s redraw runs
  const e = live('aaaaaa-1', { openedMs: T - 10 * 60_000, lastMs: T - 5 * 60_000 }) // 11:50, not ongoing: History has it at 12:00:20
  m.handle.update(reply(1, [e]))
  const r = rowOf(m.body, 'aaaaaa-1')
  assert.equal(r.dataset.action, 'follow', 'probably still flying')
  assert.equal(shown(one(r, 'fh-alerts-alt')), false)
  const at = one(r, 'fh-alerts-at')
  assert.equal(shown(at), true)
  assert.equal(at.tag, 'span', 'a note, not a button')
  assert.equal(at.textContent, `Replay at ${hm(Date.UTC(2026, 9, 3, 12, 1))}`)
  at.click()
  assert.deepEqual(m.calls.follow, ['aaaaaa-1'], 'the row’s own action')
  m.clock.now = replayableAt(e)
  t.mock.timers.tick(15_000)
  assert.equal(r.dataset.action, 'replay')
  assert.equal(shown(at), false)
  assert.equal(one(r, 'fh-alerts-alt').textContent, 'Live')
})

test('mountAlerts: opened() counts what is listed as seen (kept in the store) and asks afresh; an open panel counts new ones as seen too', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const store = storage({ 'fh.alerts.seen': String(T - 30_000) })
  const m = mount(t, { store })
  m.handle.update(reply(1, [live('aaaaaa-1', { openedMs: T - 10_000 }), live('bbbbbb-2', { openedMs: T - 60_000 })]))
  assert.equal(m.calls.badge.at(-1), '1', 'opened after the last look')
  m.clock.now = T + 5000
  m.body.hidden = false // the rail shows the panel
  m.handle.opened()
  assert.equal(m.calls.get, 1, 'History and scenarios poll nothing: the panel asks as it opens')
  assert.equal(store.m.get('fh.alerts.seen'), String(T + 5000))
  assert.equal(m.calls.badge.at(-1), null)
  m.clock.now = T + 9000
  m.handle.update(reply(2, [live('cccccc-3', { openedMs: T + 8000 }), live('aaaaaa-1', { openedMs: T - 10_000 })]))
  assert.equal(m.calls.badge.at(-1), null, 'listed in the open panel: seen')
  m.body.hidden = true
  m.clock.now = T + 20_000
  m.handle.update(reply(3, [live('dddddd-4', { openedMs: T + 19_000 }), live('cccccc-3', { openedMs: T + 8000 })]))
  assert.equal(m.calls.badge.at(-1), '1')
  // Found late, after the last look, though it opened before it: on the bell too, until the panel is opened.
  const found = live('eeeeee-5', { openedMs: T - 40 * 60_000, late: true })
  m.handle.update(reply(4, [live('dddddd-4', { openedMs: T + 19_000 }), live('cccccc-3', { openedMs: T + 8000 }), found]))
  assert.equal(m.calls.badge.at(-1), '2')
  m.body.hidden = false
  m.handle.opened()
  m.body.hidden = true
  m.handle.update(reply(5, [live('dddddd-4', { openedMs: T + 19_000 }), found]))
  assert.equal(m.calls.badge.at(-1), null)
})

test('mountAlerts: the browser options are kept in the store; notifications ask the permission in the click, and say when blocked', async (t) => {
  FakeNotification.permission = 'default'
  FakeNotification.answer = 'denied'
  FakeNotification.asked = 0
  const store = storage()
  const m = mount(t, { store })
  const follow = sw(m.body, 'follow')
  assert.equal(follow.getAttribute('aria-checked'), 'false')
  follow.click()
  assert.equal(follow.getAttribute('aria-checked'), 'true')
  assert.equal(store.m.get('fh.alerts.follow'), '1')
  const notify = sw(m.body, 'notify')
  assert.equal(one(rowNamed(m.body, 'notify'), 'fh-scene-label').textContent, 'Notifications', 'a phone’s are not desktop ones')
  assert.equal(notify.getAttribute('aria-label'), 'Notifications')
  const hint = one(rowNamed(m.body, 'notify'), 'fh-alerts-hint')
  assert.equal(hint.textContent, 'A notification for each new event')
  notify.click()
  assert.equal(FakeNotification.asked, 1, 'asked in the click itself')
  await settle()
  assert.equal(notify.getAttribute('aria-checked'), 'false')
  assert.equal(hint.textContent, 'Blocked in this browser’s settings')
  FakeNotification.permission = 'default'
  FakeNotification.answer = 'granted'
  notify.click()
  await settle()
  assert.equal(notify.getAttribute('aria-checked'), 'true')
  assert.equal(hint.textContent, 'A notification for each new event')
  assert.equal(store.m.get('fh.alerts.notify'), '1')
  notify.click()
  assert.equal(notify.getAttribute('aria-checked'), 'false')
  assert.equal(store.m.get('fh.alerts.notify'), '0')
  // A blocked store: the options work for this page, nothing throws.
  const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } } as unknown as Storage
  const b = mount(t, { store: blocked })
  sw(b.body, 'follow').click()
  assert.equal(sw(b.body, 'follow').getAttribute('aria-checked'), 'true')
  b.handle.update(reply(1, [live('aaaaaa-1')]))
  b.handle.opened()
  // No notifications in this browser: no row for them.
  const keepN = win.Notification
  delete (win as Partial<typeof win>).Notification
  try {
    const c = mount(t)
    assert.equal(rowNamed(c.body, 'notify').hidden, true)
  } finally {
    win.Notification = keepN
  }
})

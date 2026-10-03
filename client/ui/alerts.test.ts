// client/ui/alerts.test.ts
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import type { AlertEvent, EventsReply } from '../../shared/alerts.ts'

// alerts.ts imports its CSS for Vite. Node cannot load CSS, so this test process loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { ago, freshEvents, primaryAction, rowLabel, secondaryAction, tagOf, unseenCount, watchText } = await import('./alerts.ts')

const T = Date.UTC(2026, 9, 3, 12, 0)
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
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  assert.equal(ago(T - 86_400_000, T), `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${hm}`)
})

test('primaryAction: an ongoing live event is followed; any other is replayed', () => {
  assert.equal(primaryAction(ev('a', { lastMs: T - 60_000 }), T), 'follow')
  assert.equal(primaryAction(ev('a', { lastMs: T - 3 * 60_000 }), T), 'replay')
  assert.equal(primaryAction(ev('a', { late: true }), T), 'replay')
})

test('secondaryAction: Replay beside a followed row; Live beside a replayed one while it was seen within the hour', () => {
  assert.equal(secondaryAction(ev('a', { lastMs: T - 60_000 }), T), 'replay')
  assert.equal(secondaryAction(ev('a', { lastMs: T - 3 * 60_000 }), T), 'follow')
  assert.equal(secondaryAction(ev('a', { late: true, lastMs: T - 20 * 60_000 }), T), 'follow', 'found late, perhaps still flying')
  assert.equal(secondaryAction(ev('a', { lastMs: T - 59 * 60_000 }), T), 'follow')
  assert.equal(secondaryAction(ev('a', { lastMs: T - 60 * 60_000 }), T), null)
  assert.equal(secondaryAction(ev('a', { lastMs: T - 3 * 86_400_000 }), T), null)
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

test('watchText: what the server watches, from its switch and its source', () => {
  assert.equal(watchText({ on: true, sweep: true, rev: 1, events: [] }), 'Watching: squawks every 30 s, descents from each half hour of adsb.lol')
  assert.equal(watchText({ on: true, sweep: false, rev: 1, events: [] }), 'Watching what this app polls, and each half hour of adsb.lol')
  assert.equal(watchText({ on: false, sweep: true, rev: 1, events: [] }), 'Off')
  assert.equal(watchText(null), 'This server has no alerts: run it with make live')
})

test('rowLabel: the action, the aircraft, what happened and when, for a screen reader', () => {
  const e = ev('a', { callsign: 'FDB1073', type: 'B38M', openedMs: T - 5 * 60_000, lastMs: T - 30_000 })
  assert.equal(rowLabel(e, T), 'Follow FDB1073 · B38M live: Emergency · 7700, 5 min ago')
  assert.equal(rowLabel({ ...e, lastMs: T - 10 * 60_000 }, T), 'Replay FDB1073 · B38M in History: Emergency · 7700, 5 min ago')
  assert.equal(rowLabel({ ...e, late: true }, T), 'Replay FDB1073 · B38M in History: Emergency · 7700, 5 min ago, found late')
})

// ---- the panel and its toasts as mounted, on a fake DOM just rich enough for alerts.ts (and icons.ts) ----

interface FEvent { type: string; target: FEl; relatedTarget: FEl | null; stopped: boolean; stopPropagation(): void }
const doc = { activeElement: null as FEl | null }

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
  listeners = new Map<string, ((e: FEvent) => void)[]>()
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
    if (doc.activeElement !== null && this.contains(doc.activeElement)) doc.activeElement = null
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
  addEventListener(type: string, f: (e: FEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), f])
  }
  fire(type: string, relatedTarget: FEl | null = null): void {
    const e: FEvent = { type, target: this, relatedTarget, stopped: false, stopPropagation() { this.stopped = true } }
    for (let el: FEl | null = this; el !== null && !e.stopped; el = el.parent) for (const f of el.listeners.get(type) ?? []) f(e)
  }
  click(): void {
    if (!this.disabled) this.fire('click')
  }
  focus(): void {
    doc.activeElement = this
  }
}

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
const sw = (root: FEl, row: string): FEl => one(all(root).find((e) => e.dataset.row === row)!, 'fh-switch')
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
  },
  window: win,
  HTMLElement: FEl,
  Node: FEl,
  matchMedia: () => ({ matches: false }),
})
const { mountAlerts } = await import('./alerts.ts')

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

/** The panel mounted in a closed panel body (the rail hides it), with the app's side recorded; destroyed after the test. */
function mount(t: TestContext, store: Storage | null = storage(), onSwitch?: (on: boolean) => Promise<EventsReply>) {
  const body = new FEl('div')
  body.hidden = true
  const ui = new FEl('div')
  const calls = { follow: [] as string[], replay: [] as string[], auto: [] as string[], badge: [] as (string | null)[], switch: [] as boolean[] }
  const clock = { now: T, mounted: false }
  const handle = mountAlerts(body as unknown as HTMLElement, ui as unknown as HTMLElement, {
    store,
    // The app's reads its ApiClient, not made yet while the rail mounts the panel: mounting must not ask the time.
    nowMs: () => {
      if (!clock.mounted) throw new Error('nowMs called while mounting')
      return clock.now
    },
    onSwitch: onSwitch ?? (async (on) => {
      calls.switch.push(on)
      return { on, sweep: true, rev: 9, events: [] }
    }),
    onFollow: (e) => calls.follow.push(e.id),
    onReplay: (e) => calls.replay.push(e.id),
    onAuto: (e) => calls.auto.push(e.id),
    onBadge: (text) => calls.badge.push(text),
  })
  clock.mounted = true
  t.after(() => handle.destroy()) // its timers too, whatever the test asserted
  return { body, ui, calls, clock, handle, toasts: () => find(ui, 'fh-alerts-toast') }
}

const settle = (): Promise<void> => new Promise((r) => setImmediate(r))
const live = (id: string, o: Partial<AlertEvent> = {}): AlertEvent => ev(id, { callsign: `CS${id.slice(0, 3)}`, openedMs: T - 60_000, lastMs: T - 10_000, ...o })
const old = (id: string, o: Partial<AlertEvent> = {}): AlertEvent => ev(id, { openedMs: T - 2 * 86_400_000, lastMs: T - 2 * 86_400_000 + 600_000, ...o })

test('mountAlerts: nothing known yet: the switch waits, the list is loading; and nothing asks the app at mount', (t) => {
  const m = mount(t)
  assert.equal(sw(m.body, 'watch').disabled, true)
  assert.equal(one(m.body, 'fh-alerts').dataset.state, 'loading')
  assert.equal(shown(one(m.body, 'fh-alerts-skel')), true)
  assert.equal(shown(one(m.body, 'fh-alerts-line')), false)
  assert.deepEqual(m.calls, { follow: [], replay: [], auto: [], badge: [], switch: [] }, 'mounted inside the rail: the app is not ready yet')
  m.handle.destroy()
})

test('mountAlerts: the first answer toasts nothing (the bell counts the week); a new event then toasts, notifies and is followed', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  FakeNotification.made = []
  FakeNotification.permission = 'granted'
  const m = mount(t, storage({ 'fh.alerts.follow': '1', 'fh.alerts.notify': '1' }))
  const first = [live('aaaaaa-1'), old('bbbbbb-2'), live('cccccc-3', { quiet: true, squawk: '7600' })]
  m.handle.update({ on: true, sweep: true, rev: 1, events: first })
  assert.equal(m.toasts().length, 0)
  assert.equal(FakeNotification.made.length, 0)
  assert.deepEqual(m.calls.auto, [])
  assert.equal(m.calls.badge.at(-1), '2', 'never opened: the whole week counts, quiet events not')
  assert.equal(sw(m.body, 'watch').disabled, false)
  assert.equal(sw(m.body, 'watch').getAttribute('aria-checked'), 'true')
  assert.equal(one(m.body, 'fh-alerts-line').textContent, 'Watching: squawks every 30 s, descents from each half hour of adsb.lol')
  assert.equal(find(m.body, 'fh-alerts-item').length, 3)
  assert.equal(rowOf(m.body, 'cccccc-3').has('fh-alerts-quiet'), true, 'quiet: dimmed')

  const fresh = live('dddddd-4', { openedMs: T - 20_000, callsign: 'FDB1073', type: 'B38M' })
  m.handle.update({ on: true, sweep: true, rev: 2, events: [fresh, ...first] })
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

  m.handle.update({ on: true, sweep: true, rev: 3, events: [fresh, ...first] })
  assert.equal(m.toasts().length, 1, 'an event toasts once')
  m.handle.destroy()
  assert.equal(m.toasts().length, 0)
})

test('mountAlerts: a late event toasts Replay and is not followed; with the options off, no notification and no follow', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  FakeNotification.made = []
  const m = mount(t, storage())
  m.handle.update({ on: true, sweep: false, rev: 1, events: [] })
  assert.equal(one(m.body, 'fh-alerts-line').textContent, 'Watching what this app polls, and each half hour of adsb.lol')
  assert.equal(shown(one(m.body, 'fh-alerts-empty')), true)
  m.handle.update({ on: true, sweep: false, rev: 2, events: [live('aaaaaa-1', { late: true, kind: 'descent', squawk: null, drop: { fromFt: 35_000, toFt: 22_000, overS: 100, lost: false } })] })
  assert.equal(one(m.toasts()[0], 'fh-alerts-toast-go').textContent, 'Replay')
  assert.equal(one(m.toasts()[0], 'fh-alerts-tag').textContent, '↓')
  m.handle.update({ on: true, sweep: false, rev: 3, events: [live('bbbbbb-2'), live('aaaaaa-1', { late: true })] })
  assert.equal(m.toasts().length, 2)
  assert.equal(FakeNotification.made.length, 0)
  assert.deepEqual(m.calls.auto, [], 'Follow automatically is off')
  m.handle.destroy()
})

test('mountAlerts: at most 3 toasts, the newest on top; each closes after 30 s, by ×, or by its button, which acts', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const m = mount(t)
  m.handle.update({ on: true, sweep: true, rev: 1, events: [] })
  const five = [1, 2, 3, 4, 5].map((i) => live(`a${i}a${i}a${i}-${i}`, { openedMs: T - 60_000 + i }))
  m.handle.update({ on: true, sweep: true, rev: 2, events: five })
  assert.deepEqual(m.toasts().map((x) => x.dataset.id), ['a5a5a5-5', 'a4a4a4-4', 'a3a3a3-3'])
  const sixth = live('a6a6a6-6', { openedMs: T })
  m.handle.update({ on: true, sweep: true, rev: 3, events: [sixth, ...five] })
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
  m.handle.destroy()
})

test('mountAlerts: the switch asks the server, waits disabled, then shows its answer; a failure says so', async (t) => {
  let answer!: (r: EventsReply) => void
  let fail!: (e: Error) => void
  const asked: boolean[] = []
  const m = mount(t, storage(), (on) => {
    asked.push(on)
    return new Promise((res, rej) => {
      answer = res
      fail = rej
    })
  })
  m.handle.update({ on: false, sweep: true, rev: 1, events: [] })
  const s = sw(m.body, 'watch')
  assert.equal(s.getAttribute('aria-checked'), 'false')
  assert.equal(one(m.body, 'fh-alerts-line').textContent, 'Off')
  all(m.body).find((e) => e.dataset.row === 'watch')!.click() // the whole row is the target
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
  const warn = console.warn
  console.warn = () => {}
  try {
    s.click()
    fail(new Error('HTTP 502'))
    await settle()
  } finally {
    console.warn = warn
  }
  assert.deepEqual(asked, [true, false])
  assert.equal(s.disabled, false)
  assert.equal(s.getAttribute('aria-checked'), 'true', 'as the server last said')
  assert.equal(one(m.body, 'fh-alerts-line').textContent, 'Could not change it. Try again.')
  m.handle.destroy()
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
  m.handle.destroy()
})

test('mountAlerts: a row follows an ongoing event and replays any other; its small button does the other, its row untouched', (t) => {
  const m = mount(t)
  m.handle.update({ on: true, sweep: true, rev: 1, events: [live('aaaaaa-1'), live('bbbbbb-2', { lastMs: T - 10 * 60_000 }), old('cccccc-3')] })
  const [a, b, c] = ['aaaaaa-1', 'bbbbbb-2', 'cccccc-3'].map((id) => rowOf(m.body, id))
  assert.equal(a.dataset.action, 'follow')
  assert.equal(one(a, 'fh-alerts-main').getAttribute('aria-label'), 'Follow CSaaa live: Emergency · 7700, 1 min ago')
  assert.equal(shown(one(a, 'fh-alerts-live')), true)
  assert.equal(one(a, 'fh-alerts-alt').textContent, 'Replay')
  assert.equal(b.dataset.action, 'replay')
  assert.equal(shown(one(b, 'fh-alerts-live')), false)
  assert.equal(one(b, 'fh-alerts-alt').textContent, 'Live', 'seen within the hour')
  assert.equal(shown(one(c, 'fh-alerts-alt')), false, 'two days ago: replay only')
  one(a, 'fh-alerts-main').click()
  one(b, 'fh-alerts-main').click()
  one(a, 'fh-alerts-alt').click()
  one(b, 'fh-alerts-alt').click()
  assert.deepEqual(m.calls.follow, ['aaaaaa-1', 'bbbbbb-2'])
  assert.deepEqual(m.calls.replay, ['bbbbbb-2', 'aaaaaa-1'])
  m.handle.destroy()
})

test('mountAlerts: opened() counts what is listed as seen (kept in the store); an open panel counts new ones as seen too', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const store = storage({ 'fh.alerts.seen': String(T - 30_000) })
  const m = mount(t, store)
  m.handle.update({ on: true, sweep: true, rev: 1, events: [live('aaaaaa-1', { openedMs: T - 10_000 }), live('bbbbbb-2', { openedMs: T - 60_000 })] })
  assert.equal(m.calls.badge.at(-1), '1', 'opened after the last look')
  m.clock.now = T + 5000
  m.body.hidden = false // the rail shows the panel
  m.handle.opened()
  assert.equal(store.m.get('fh.alerts.seen'), String(T + 5000))
  assert.equal(m.calls.badge.at(-1), null)
  m.clock.now = T + 9000
  m.handle.update({ on: true, sweep: true, rev: 2, events: [live('cccccc-3', { openedMs: T + 8000 }), live('aaaaaa-1', { openedMs: T - 10_000 })] })
  assert.equal(m.calls.badge.at(-1), null, 'listed in the open panel: seen')
  m.body.hidden = true
  m.clock.now = T + 20_000
  m.handle.update({ on: true, sweep: true, rev: 3, events: [live('dddddd-4', { openedMs: T + 19_000 }), live('cccccc-3', { openedMs: T + 8000 })] })
  assert.equal(m.calls.badge.at(-1), '1')
  // Found late, after the last look, though it opened before it: on the bell too, until the panel is opened.
  const found = live('eeeeee-5', { openedMs: T - 10 * 60_000, late: true })
  m.handle.update({ on: true, sweep: true, rev: 4, events: [live('dddddd-4', { openedMs: T + 19_000 }), live('cccccc-3', { openedMs: T + 8000 }), found] })
  assert.equal(m.calls.badge.at(-1), '2')
  m.body.hidden = false
  m.handle.opened()
  m.body.hidden = true
  m.handle.update({ on: true, sweep: true, rev: 5, events: [live('dddddd-4', { openedMs: T + 19_000 }), found] })
  assert.equal(m.calls.badge.at(-1), null)
  m.handle.destroy()
})

test('mountAlerts: the browser options are kept in the store; notifications ask the permission in the click, and say when blocked', async (t) => {
  FakeNotification.permission = 'default'
  FakeNotification.answer = 'denied'
  FakeNotification.asked = 0
  const store = storage()
  const m = mount(t, store)
  const follow = sw(m.body, 'follow')
  assert.equal(follow.getAttribute('aria-checked'), 'false')
  follow.click()
  assert.equal(follow.getAttribute('aria-checked'), 'true')
  assert.equal(store.m.get('fh.alerts.follow'), '1')
  const notify = sw(m.body, 'notify')
  const hint = one(all(m.body).find((e) => e.dataset.row === 'notify')!, 'fh-alerts-hint')
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
  m.handle.destroy()
  // A blocked store: the options work for this page, nothing throws.
  const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } } as unknown as Storage
  const b = mount(t, blocked)
  sw(b.body, 'follow').click()
  assert.equal(sw(b.body, 'follow').getAttribute('aria-checked'), 'true')
  b.handle.update({ on: true, sweep: true, rev: 1, events: [live('aaaaaa-1')] })
  b.handle.opened()
  b.handle.destroy()
  // No desktop notifications in this browser: no row for them.
  const keepN = win.Notification
  delete (win as Partial<typeof win>).Notification
  try {
    const c = mount(t)
    assert.equal(all(c.body).find((e) => e.dataset.row === 'notify')!.hidden, true)
    c.handle.destroy()
  } finally {
    win.Notification = keepN
  }
})

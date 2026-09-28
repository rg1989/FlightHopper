// client/ui/playbar.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// playbar.ts imports its CSS for Vite. Node cannot load CSS, so this test process loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { mountPlaybar, clockText, REENACTED } = await import('./playbar.ts')

interface Ev { type: string; key?: string; shiftKey?: boolean; detail?: number; target: El; defaultPrevented: boolean; stopped: boolean; preventDefault(): void; stopPropagation(): void }

// Node has no DOM: just enough of one for playbar.ts and icons.ts. Events bubble; every write to text, value or an
// attribute is counted, so a test can check that an unchanged update() writes nothing.
class El {
  tag: string
  children: El[] = []
  parent: El | null = null
  className = ''
  hidden = false
  type = ''
  title = ''
  min = ''
  max = ''
  step = ''
  writes = 0
  blurred = 0
  #text = ''
  #value = ''
  attrs: Record<string, string> = {}
  style = { props: {} as Record<string, string>, setProperty: (k: string, v: string): void => void ((this.writes++, this.style.props[k] = v)) }
  #classes = new Set<string>()
  classList = {
    add: (c: string): void => void this.#classes.add(c),
    remove: (c: string): void => void this.#classes.delete(c),
    toggle: (c: string, on?: boolean): boolean => {
      if (on ?? !this.#classes.has(c)) this.#classes.add(c)
      else this.#classes.delete(c)
      return this.#classes.has(c)
    },
    contains: (c: string): boolean => this.#classes.has(c),
  }
  listeners = new Map<string, ((e: Ev) => void)[]>()
  constructor(tag: string) {
    this.tag = tag
  }
  get textContent(): string {
    return this.#text
  }
  set textContent(v: string) {
    this.writes++
    this.#text = v
  }
  get value(): string {
    return this.#value
  }
  set value(v: string) {
    this.writes++
    this.#value = v
  }
  set innerHTML(_v: string) {
    throw new Error('innerHTML is not allowed: data goes in with textContent')
  }
  append(...cs: El[]): void {
    for (const c of cs) {
      c.remove()
      c.parent = this
      this.children.push(c)
    }
  }
  replaceChildren(...cs: El[]): void {
    this.writes++
    for (const c of this.children) c.parent = null
    this.children = []
    this.append(...cs)
  }
  remove(): void {
    if (!this.parent) return
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }
  setAttribute(k: string, v: string): void {
    this.writes++
    this.attrs[k] = v
  }
  addEventListener(type: string, f: (e: Ev) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), f])
  }
  /** Dispatches a bubbling event from this element; returns it (defaultPrevented, stopped). */
  fire(type: string, init: { key?: string; shiftKey?: boolean; detail?: number } = {}): Ev {
    const e: Ev = {
      type, ...init, target: this, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true },
      stopPropagation() { this.stopped = true },
    }
    for (let el: El | null = this; el !== null && !e.stopped; el = el.parent) for (const f of el.listeners.get(type) ?? []) f(e)
    return e
  }
  /** A click as a keyboard (or script) makes it: detail 0. A mouse or finger click has detail ≥ 1. */
  click(detail = 0): void {
    this.fire('click', { detail })
  }
  blur(): void {
    this.blurred++
  }
  has(cls: string): boolean {
    return this.className.split(' ').includes(cls) || this.#classes.has(cls)
  }
}
const outside: string[] = [] // listeners added to window or document: keys belong to the app
Object.assign(globalThis, {
  document: {
    createElement: (tag: string) => new El(tag),
    createElementNS: (_ns: string, tag: string) => new El(tag),
    addEventListener: (t: string) => outside.push(`document:${t}`),
  },
  window: { addEventListener: (t: string) => outside.push(`window:${t}`) },
})

const all = (el: El): El[] => [el, ...el.children.flatMap(all)]
const text = (el: El): string => el.textContent + el.children.map(text).join('')
const one = (root: El, cls: string): El => {
  const hits = all(root).filter((e) => e.has(cls))
  assert.equal(hits.length, 1, `one .${cls}, found ${hits.length}`)
  return hits[0]
}

const START = 65475 // 18:11:15
const END = 68188 // 18:56:28
const MARKS = [
  { t: 66275, label: 'Failure' }, // 18:24:35
  { t: 67172, label: 'Gear down' }, // 18:39:32
  { t: 60000, label: 'Before the start' }, // outside the timeline: no tick
]
const VIEW = { t: 66275.4, playing: false, rate: 1, clock: '18:24:35', phase: 'Failure: loss of hydraulics' }

// This browser's storage for the remembered volume: a Map, emptied by each test that needs it.
const stored = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) },
})

function mount(over: { stop?: number; marks?: { t: number; label: string }[]; sound?: { reenacted: boolean; onGain(g: number): void } } = {}) {
  const root = new El('div')
  const calls: string[] = []
  const bar = mountPlaybar(root as unknown as HTMLElement, {
    start: START, stop: over.stop ?? END, end: END, marks: over.marks ?? MARKS, clockLabel: 'JST', title: 'Japan Air Lines Flight 123',
    onToggle: () => calls.push('toggle'),
    onSeek: (t) => calls.push(`seek ${t}`),
    onRate: () => calls.push('rate'),
    onExit: () => calls.push('exit'),
    sound: over.sound,
  })
  const range = all(root).find((e) => e.tag === 'input')!
  const play = one(root, 'fh-playbar-play')
  const ticks = all(root).filter((e) => e.has('fh-playbar-tick'))
  return { root, bar, calls, range, play, ticks }
}

test('the bar: glass, the title, play (Play), a 0.1 s scrubber from start to stop, speed and exit', () => {
  const { root, range, play } = mount()
  const bar = one(root, 'fh-playbar')
  assert.ok(bar.has('fh-glass'))
  assert.equal(text(one(root, 'fh-playbar-title')), 'Japan Air Lines Flight 123')
  assert.equal(play.tag, 'button')
  assert.equal(play.attrs['aria-label'], 'Play')
  assert.deepEqual([range.type, range.min, range.max, range.step], ['range', String(START), String(END), '0.1'])
  assert.ok(range.attrs['aria-label'])
  assert.equal(one(root, 'fh-playbar-exit').attrs['aria-label'], 'Exit scenario')
  for (const b of all(root).filter((e) => e.tag === 'button')) assert.equal(b.type, 'button')
})

test('dragging the scrubber seeks on every input event', () => {
  const { range, calls } = mount()
  range.fire('pointerdown')
  for (const v of ['66000.5', '66010', '66020.3']) {
    range.value = v
    range.fire('input')
  }
  assert.deepEqual(calls, ['seek 66000.5', 'seek 66010', 'seek 66020.3'])
})

test('update renders the clock with its label, the phase, the speed and play/pause', () => {
  const { root, bar, play, range } = mount()
  bar.update(VIEW)
  assert.equal(text(one(root, 'fh-playbar-time')), '18:24:35')
  assert.equal(text(one(root, 'fh-playbar-zone')), 'JST')
  assert.equal(range.attrs['aria-valuetext'], '18:24:35 JST')
  const phase = one(root, 'fh-playbar-phase')
  assert.equal(text(phase), 'Failure: loss of hydraulics')
  assert.equal(phase.hidden, false)
  assert.equal(text(one(root, 'fh-playbar-rate')), '1×')
  assert.equal(play.attrs['aria-label'], 'Play')
  bar.update({ ...VIEW, playing: true, rate: 16, phase: null })
  assert.equal(play.attrs['aria-label'], 'Pause')
  assert.equal(text(one(root, 'fh-playbar-rate')), '16×')
  assert.equal(phase.hidden, true)
})

test('update moves the scrubber to t, but not under a dragging finger', () => {
  const { bar, range } = mount()
  bar.update(VIEW)
  assert.equal(range.value, '66275.4')
  assert.match(range.style.props['--fh-p'], /^29\.50\d*%$/) // (66275.4 − 65475) / 2713
  range.fire('pointerdown')
  bar.update({ ...VIEW, t: 66300 })
  assert.equal(range.value, '66275.4')
  range.fire('pointerup')
  bar.update({ ...VIEW, t: 66300 })
  assert.equal(range.value, '66300.0')
})

test('an unchanged update writes nothing (it runs every frame)', () => {
  const { root, bar } = mount()
  bar.update(VIEW)
  const writes = (): number => all(root).reduce((n, e) => n + e.writes, 0)
  const before = writes()
  for (let i = 0; i < 50; i++) bar.update({ ...VIEW })
  assert.equal(writes(), before)
})

test('marks: a tick for each mark on the timeline, placed by time, labelled with the clock; a press seeks to it', () => {
  const { ticks, calls } = mount()
  assert.equal(ticks.length, 2)
  assert.deepEqual(ticks.map((t) => [t.tag, t.attrs['data-label'], t.attrs['aria-label']]), [
    ['button', 'Failure · 18:24:35 JST', 'Failure · 18:24:35 JST'],
    ['button', 'Gear down · 18:39:32 JST', 'Gear down · 18:39:32 JST'],
  ])
  assert.match(ticks[0].style.props.left, /^29\.48\d*%$/) // (66275 − 65475) / 2713
  ticks[1].click()
  assert.deepEqual(calls, ['seek 67172'])
})

test('buttons: play/pause toggles, speed asks for the next rate, × exits', () => {
  const { root, play, calls } = mount()
  play.click()
  one(root, 'fh-playbar-rate').click()
  one(root, 'fh-playbar-exit').click()
  assert.deepEqual(calls, ['toggle', 'rate', 'exit'])
})

test('keys on the focused scrubber: arrows ±10 s (Shift ±60 s), PgUp/PgDn ±60 s, Home/End, Space plays; clamped', () => {
  const { bar, range, calls } = mount()
  bar.update({ ...VIEW, t: 65500 })
  const keys: [string, boolean][] = [
    ['ArrowRight', false], ['ArrowLeft', false], ['ArrowLeft', true], ['ArrowRight', true],
    ['ArrowUp', false], ['ArrowDown', false], ['ArrowUp', true], ['ArrowDown', true],
    ['PageUp', false], ['PageDown', false],
    ['Home', false], ['End', false], [' ', false],
  ]
  for (const [key, shiftKey] of keys) assert.equal(range.fire('keydown', { key, shiftKey }).defaultPrevented, true, key)
  assert.deepEqual(calls, [
    'seek 65510', 'seek 65490', `seek ${START}`, 'seek 65560',
    'seek 65510', 'seek 65490', 'seek 65560', `seek ${START}`,
    'seek 65560', `seek ${START}`,
    `seek ${START}`, `seek ${END}`, 'toggle',
  ])
  assert.equal(range.fire('keydown', { key: 'Tab' }).defaultPrevented, false)
  bar.update({ ...VIEW, t: END - 5 })
  calls.length = 0
  for (const key of ['ArrowRight', 'PageUp']) range.fire('keydown', { key })
  assert.deepEqual(calls, [`seek ${END}`, `seek ${END}`], 'clamped at the end')
})

test('when the ending card waits past the last data second (stop > end), the scrubber, keys and ticks all run to stop', () => {
  const STOP = END + 20
  const { bar, range, calls, ticks } = mount({ stop: STOP, marks: [{ t: END + 10, label: 'Card' }, { t: STOP + 1, label: 'Past the stop' }] })
  assert.equal(range.max, String(STOP), 'a drag reaches every second the clock can')
  assert.equal(ticks.length, 1)
  assert.equal(ticks[0].style.props.left, `${((10 + END - START) / (STOP - START) * 100).toFixed(3)}%`)
  bar.update({ ...VIEW, t: END + 10 })
  assert.equal(range.value, (END + 10).toFixed(1), 'the thumb follows t past end')
  assert.notEqual(range.style.props['--fh-p'], '100.00%')
  range.fire('keydown', { key: 'End' })
  range.fire('keydown', { key: 'PageUp' })
  assert.deepEqual(calls, [`seek ${STOP}`, `seek ${STOP}`])
})

test('clock text: tick labels and the clock use format.ts sToClock on whole seconds (floored), so they agree', () => {
  const { ticks } = mount({ marks: [{ t: 66275.8, label: 'Failure' }] })
  assert.equal(ticks[0].attrs['data-label'], 'Failure · 18:24:35 JST', '18:24:35.8 is still 18:24:35 on the clock')
  assert.deepEqual([clockText(66275), clockText(66275.8), clockText(66275.99), clockText(90061)], ['18:24:35', '18:24:35', '18:24:35', '25:01:01'])
})

test('a mouse or finger click leaves no focus on speed or a tick, so a later Space plays/pauses instead of pressing them again', () => {
  const { root, play, ticks } = mount()
  const rate = one(root, 'fh-playbar-rate')
  rate.click(1)
  ticks[0].click(1)
  assert.deepEqual([rate.blurred, ticks[0].blurred], [1, 1])
  rate.click(0) // Enter or Space on a keyboard-focused button: the focus stays where the user put it
  ticks[0].click(0)
  assert.deepEqual([rate.blurred, ticks[0].blurred], [1, 1])
  play.click(1) // play keeps it: Space on it plays/pauses, which is what Space means anyway
  assert.equal(play.blurred, 0)
})

test('Space on a focused bar button stays with that button: it does not also reach the app\'s key handler', () => {
  const { root, play } = mount()
  const heard: string[] = []
  root.addEventListener('keydown', (e) => heard.push(e.key!))
  play.fire('keydown', { key: ' ' })
  play.fire('keydown', { key: 'ArrowLeft' })
  assert.deepEqual(heard, ['ArrowLeft'])
})

test('keys belong to the app: no listeners outside the bar; destroy removes it', () => {
  outside.length = 0
  const { root, bar } = mount()
  bar.update(VIEW)
  assert.deepEqual(outside, [])
  bar.destroy()
  assert.equal(root.children.length, 0)
  bar.destroy()
})

test('with audio: mute and a volume slider, remembered in this browser; M (toggleMute) mutes; the note for a reenactment', () => {
  stored.clear()
  const gains: number[] = []
  const { root, bar, calls } = mount({ sound: { reenacted: true, onGain: (g) => gains.push(g) } })
  assert.ok(one(root, 'fh-playbar').has('fh-has-sound'))
  const note = one(root, 'fh-playbar-note')
  assert.equal(text(note), 'Reenacted voices')
  assert.equal(note.title, REENACTED)
  const mute = one(root, 'fh-playbar-mute')
  const vol = one(root, 'fh-playbar-vol')
  assert.deepEqual([vol.type, vol.min, vol.max, vol.value], ['range', '0', '1', '0.8'])
  assert.deepEqual(gains, [0.8], 'the default, at once')

  mute.click(1)
  assert.equal(gains.at(-1), 0)
  assert.equal(mute.attrs['aria-label'], 'Unmute the voices')
  assert.equal(mute.blurred, 1, 'a mouse click leaves no focus on it')
  bar.toggleMute()
  assert.equal(gains.at(-1), 0.8)
  assert.equal(mute.attrs['aria-label'], 'Mute the voices')

  vol.value = '0.3'
  vol.fire('input')
  assert.equal(gains.at(-1), 0.3)
  vol.value = '0'
  vol.fire('input')
  assert.equal(gains.at(-1), 0)
  assert.equal(mute.attrs['aria-label'], 'Unmute the voices', 'at zero the button offers sound back')
  bar.toggleMute()
  bar.toggleMute()
  assert.equal(gains.at(-1), 0.8, 'unmuting from zero comes back at the default')
  vol.value = '0.4'
  vol.fire('input')
  bar.toggleMute()

  const space = vol.fire('keydown', { key: ' ' })
  assert.ok(space.defaultPrevented)
  assert.deepEqual(calls, ['toggle'], 'Space on the slider plays or pauses')

  const again: number[] = []
  mount({ sound: { reenacted: true, onGain: (g) => again.push(g) } })
  assert.deepEqual(again, [0], 'remembered: muted, at 0.4')
  bar.destroy()
})

test('with a recording: no note; without audio: no sound controls, and M does nothing', () => {
  stored.clear()
  const rec = mount({ sound: { reenacted: false, onGain: () => {} } })
  assert.equal(all(rec.root).filter((e) => e.has('fh-playbar-note')).length, 0)
  one(rec.root, 'fh-playbar-mute')
  const none = mount()
  assert.equal(all(none.root).filter((e) => e.has('fh-playbar-sound')).length, 0)
  assert.ok(!one(none.root, 'fh-playbar').has('fh-has-sound'))
  none.bar.toggleMute()
})

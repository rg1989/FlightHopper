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
    add: (c: string): void => {
      if (c === '' || /\s/.test(c)) throw new Error(`classList.add('${c}'): a browser throws on an empty or spaced token`)
      this.#classes.add(c)
    },
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
  prepend(...cs: El[]): void {
    for (const c of [...cs].reverse()) {
      c.remove()
      c.parent = this
      this.children.unshift(c)
    }
  }
  /** Inserts cs right after this element, in its parent. */
  after(...cs: El[]): void {
    const p = this.parent!
    for (const [i, c] of cs.entries()) {
      c.remove()
      c.parent = p
      p.children.splice(p.children.indexOf(this) + 1 + i, 0, c)
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

// The history time bar's options (history/bar.ts): a day of 86,400 s, no marks unless given.
const DAY = 86_400
const none = (root: El, cls: string): void => assert.equal(all(root).filter((e) => e.has(cls)).length, 0, `no .${cls}`)
const writesIn = (root: El): number => all(root).reduce((n, e) => n + e.writes, 0)
type Opts = Parameters<typeof mountPlaybar>[1]
function mountDay(over: Partial<Opts> = {}) {
  const root = new El('div')
  const calls: string[] = []
  const bar = mountPlaybar(root as unknown as HTMLElement, {
    start: 0, stop: DAY, end: DAY, marks: [], clockLabel: 'IDT', title: 'Replay · Tue 22 Sep',
    onToggle: () => calls.push('toggle'),
    onSeek: (t) => calls.push(`seek ${t}`),
    onRate: () => calls.push('rate'),
    onExit: () => calls.push('exit'),
    ...over,
  })
  const range = all(root).find((e) => e.tag === 'input')!
  return { root, bar, calls, range, rail: one(root, 'fh-playbar-rail'), barEl: one(root, 'fh-playbar') }
}

test('without the options it is the scenario bar: no extra class, the × exit, no tools, scale, spans, hatch or note', () => {
  const { root, rail, barEl, range } = mountDay()
  const exit = one(root, 'fh-playbar-exit')
  assert.ok(exit.has('fh-ibtn') && !exit.has('fh-playbar-exit-text'))
  assert.deepEqual([exit.attrs['aria-label'], exit.title, exit.children.length], ['Exit scenario', 'Exit scenario', 1])
  for (const c of ['fh-playbar-tools', 'fh-playbar-scale', 'fh-playbar-segs', 'fh-playbar-limit', 'fh-playbar-notice', 'fh-has-tools', 'fh-has-scale']) none(root, c)
  assert.deepEqual(barEl.children.map((c) => c.className), ['fh-ibtn fh-playbar-play', 'fh-playbar-meta', 'fh-playbar-track', 'fh-playbar-rate fh-num', 'fh-ibtn fh-playbar-exit'])
  assert.deepEqual(rail.children.map((c) => c.className), ['fh-playbar-fill'])
  assert.equal(range.attrs['aria-label'], 'Scenario time')
  assert.equal(barEl.className, 'fh-playbar fh-glass')
})

test('className (one class or several), timeLabel', () => {
  const { barEl, range } = mountDay({ className: ' fh-playbar-history  fh-playbar-again ', timeLabel: 'Replay time' })
  assert.ok(barEl.has('fh-playbar-history') && barEl.has('fh-playbar-again') && barEl.has('fh-glass'))
  assert.equal(range.attrs['aria-label'], 'Replay time')
})

test('exitText: the exit is a text pill (no icon) named by exitLabel, and still exits; exitLabel alone renames the ×', () => {
  const { root, calls } = mountDay({ exitLabel: 'Back to live', exitText: 'Live' })
  const exit = one(root, 'fh-playbar-exit')
  assert.deepEqual([exit.tag, exit.type, text(exit), exit.children.length], ['button', 'button', 'Live', 0])
  assert.ok(exit.has('fh-playbar-exit-text') && !exit.has('fh-ibtn'))
  assert.deepEqual([exit.attrs['aria-label'], exit.title], ['Back to live', 'Back to live'])
  exit.click(1)
  assert.deepEqual(calls, ['exit'])
  const renamed = one(mountDay({ exitLabel: 'Leave' }).root, 'fh-playbar-exit')
  assert.ok(renamed.has('fh-ibtn'))
  assert.equal(renamed.attrs['aria-label'], 'Leave')
})

test('tools: in one box between the speed and the exit (after the voices when there are some)', () => {
  const a = new El('button')
  const b = new El('div')
  const { barEl } = mountDay({ tools: [a, b] as unknown as HTMLElement[] })
  assert.ok(barEl.has('fh-has-tools'))
  assert.deepEqual(barEl.children.map((c) => c.className.split(' ').at(-1)), ['fh-playbar-play', 'fh-playbar-meta', 'fh-playbar-track', 'fh-num', 'fh-playbar-tools', 'fh-playbar-exit'])
  assert.deepEqual(one(barEl, 'fh-playbar-tools').children, [a, b])
  stored.clear()
  const withSound = mountDay({ tools: [new El('button')] as unknown as HTMLElement[], sound: { reenacted: false, onGain: () => {} } })
  assert.deepEqual(withSound.barEl.children.map((c) => c.className.split(' ')[0]), ['fh-ibtn', 'fh-playbar-meta', 'fh-playbar-track', 'fh-playbar-sound', 'fh-playbar-rate', 'fh-playbar-tools', 'fh-ibtn'])
})

test('scale: labels under the rail at their place, hidden from screen readers; outside the timeline none', () => {
  const { root, barEl } = mountDay({ scale: [{ t: 0, label: '00' }, { t: 21_600, label: '06' }, { t: DAY, label: '24' }, { t: DAY + 1, label: 'x' }, { t: -1, label: 'y' }] })
  assert.ok(barEl.has('fh-has-scale'))
  const scale = one(root, 'fh-playbar-scale')
  assert.equal(scale.attrs['aria-hidden'], 'true')
  assert.equal(scale.parent, one(root, 'fh-playbar-track'))
  assert.deepEqual(scale.children.map((s) => [s.textContent, s.style.props.left]), [['00', '0.000%'], ['06', '25.000%'], ['24', '100.000%']])
})

test('setSegments: spans first in the rail (under the played part and the dots), placed, sized and clipped; the same ones write nothing', () => {
  const { root, bar, rail } = mountDay()
  const segs = [
    { from: 61_200, to: 66_600, state: 'ready' as const },
    { from: 66_600, to: 68_400, state: 'loading' as const },
    { from: 70_000, to: 72_000, state: 'missing' as const },
    { from: -1800, to: 900, state: 'ready' as const }, // clipped at the start
    { from: 86_000, to: 90_000, state: 'ready' as const }, // clipped at the stop
    { from: 90_000, to: 91_000, state: 'ready' as const }, // past it: none
    { from: 500, to: 500, state: 'ready' as const }, // empty: none
  ]
  bar.setSegments(segs)
  const box = one(root, 'fh-playbar-segs')
  assert.equal(rail.children[0], box)
  assert.deepEqual(box.children.map((s) => [s.attrs['data-state'], s.style.props.left, s.style.props.width]), [
    ['ready', '70.833%', '6.250%'], ['loading', '77.083%', '2.083%'], ['missing', '81.019%', '2.315%'],
    ['ready', '0.000%', '1.042%'], ['ready', '99.537%', '0.463%'],
  ])
  const before = writesIn(root)
  bar.setSegments(segs.map((s) => ({ ...s })))
  assert.equal(writesIn(root), before, 'the same spans: nothing written')
  bar.setSegments([{ from: 0, to: 1800, state: 'loading' }])
  assert.deepEqual(one(root, 'fh-playbar-segs').children.map((s) => s.attrs['data-state']), ['loading'])
  bar.setSegments([])
  assert.equal(one(root, 'fh-playbar-segs').children.length, 0)
})

test('setLimit: hatched past it; a drag past it holds the thumb there and seeks there', () => {
  const { bar, range, rail, calls, root } = mountDay()
  bar.setLimit(63_000)
  assert.equal(one(root, 'fh-playbar-limit').hidden, false)
  assert.ok(rail.classList.contains('fh-has-limit'))
  assert.equal(rail.style.props['--fh-lim'], '72.917%')
  range.fire('pointerdown')
  for (const v of ['62000', '64000.5']) {
    range.value = v
    range.fire('input')
  }
  assert.deepEqual(calls, ['seek 62000', 'seek 63000'])
  assert.equal(range.value, '63000', 'the thumb held at the limit')
})

test('setLimit: keys and marks past it seek to it; null takes it away; at or past stop is none; before start is start', () => {
  const { bar, range, calls, root } = mountDay({ marks: [{ t: 70_000, label: 'Late' }] })
  bar.setLimit(63_000)
  bar.update({ t: 62_995, playing: false, rate: 1, clock: '17:29:55', phase: null })
  for (const key of ['ArrowRight', 'PageUp', 'End']) range.fire('keydown', { key })
  one(root, 'fh-playbar-tick').click()
  range.fire('keydown', { key: 'Home' })
  assert.deepEqual(calls, ['seek 63000', 'seek 63000', 'seek 63000', 'seek 63000', 'seek 0'])
  calls.length = 0
  bar.setLimit(null)
  assert.equal(one(root, 'fh-playbar-limit').hidden, true)
  assert.ok(!one(root, 'fh-playbar-rail').classList.contains('fh-has-limit'))
  range.fire('keydown', { key: 'End' })
  one(root, 'fh-playbar-tick').click()
  assert.deepEqual(calls, [`seek ${DAY}`, 'seek 70000'])
  calls.length = 0
  for (const lim of [DAY, -50, Number.NaN]) {
    bar.setLimit(lim)
    range.fire('keydown', { key: 'End' })
  }
  assert.deepEqual(calls, [`seek ${DAY}`, 'seek 0', `seek ${DAY}`])
  bar.setLimit(40_000)
  const before = writesIn(root)
  bar.setLimit(40_000)
  assert.equal(writesIn(root), before, 'the same limit: nothing written')
})

test('setLimit(null) on a bar never given a limit makes no hatch', () => {
  const { bar, root } = mountDay()
  bar.setLimit(null)
  none(root, 'fh-playbar-limit')
})

test('setTitle: the title and the bar\'s name; the same title writes nothing', () => {
  const { bar, barEl, root } = mountDay()
  bar.setTitle('Replay · Wed 23 Sep')
  assert.equal(text(one(root, 'fh-playbar-title')), 'Replay · Wed 23 Sep')
  assert.equal(barEl.attrs['aria-label'], 'Playback: Replay · Wed 23 Sep')
  const before = writesIn(root)
  bar.setTitle('Replay · Wed 23 Sep')
  assert.equal(writesIn(root), before)
})

test('setNote: a note right after the title, made on first use, announced; null hides it; the same note writes nothing', () => {
  const { bar, barEl, root } = mountDay()
  bar.setNote(null)
  none(root, 'fh-playbar-notice')
  bar.setNote('No data for this time')
  const note = one(root, 'fh-playbar-notice')
  const meta = one(root, 'fh-playbar-meta')
  assert.equal(meta.children.indexOf(note), meta.children.indexOf(one(root, 'fh-playbar-title')) + 1)
  assert.deepEqual([text(note), note.hidden, note.attrs.role], ['No data for this time', false, 'status'])
  assert.ok(barEl.has('fh-has-notice'))
  const before = writesIn(root)
  bar.setNote('No data for this time')
  assert.equal(writesIn(root), before, 'the same note: nothing written')
  bar.setNote(null)
  assert.equal(note.hidden, true)
  assert.ok(!barEl.has('fh-has-notice'))
  bar.setNote('Loading')
  assert.deepEqual([text(one(root, 'fh-playbar-notice')), note.hidden], ['Loading', false])
})

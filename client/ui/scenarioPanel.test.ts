// client/ui/scenarioPanel.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import type { ScenarioCard } from '../scenario/types.ts'

// scenarioPanel.ts imports its CSS for Vite. Node cannot load CSS, so this test process loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { mountScenarioPanel } = await import('./scenarioPanel.ts')

// Node has no DOM: just enough of one for scenarioPanel.ts and icons.ts. innerHTML throws: data goes in as text only.
class El {
  tag: string
  children: El[] = []
  parent: El | null = null
  className = ''
  textContent = ''
  hidden = false
  disabled = false
  open = false
  type = ''
  attrs: Record<string, string> = {}
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
  listeners = new Map<string, (() => void)[]>()
  constructor(tag: string) {
    this.tag = tag
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
    this.attrs[k] = v
  }
  addEventListener(type: string, f: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), f])
  }
  click(): void {
    for (const f of this.listeners.get('click') ?? []) f()
  }
  has(cls: string): boolean {
    return this.className.split(' ').includes(cls) || this.#classes.has(cls)
  }
}
Object.assign(globalThis, {
  document: { createElement: (tag: string) => new El(tag), createElementNS: (_ns: string, tag: string) => new El(tag) },
})

const all = (el: El): El[] => [el, ...el.children.flatMap(all)]
const text = (el: El): string => el.textContent + el.children.map(text).join('')
const find = (root: El, cls: string): El[] => all(root).filter((e) => e.has(cls))
const one = (root: El, cls: string): El => {
  const hits = find(root, cls)
  assert.equal(hits.length, 1, `one .${cls}, found ${hits.length}`)
  return hits[0]
}
const visible = (root: El, cls: string): El[] => find(root, cls).filter((e) => !all(root).some((a) => a.hidden && all(a).includes(e)))
const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const JAL: ScenarioCard = {
  id: 'jal123',
  title: 'Japan Air Lines Flight 123',
  subtitle: 'Tokyo Haneda to Osaka Itami',
  date: '1985-08-12',
  clockLabel: 'JST',
  note: 'Reconstructed from the official accident report.',
  summary: ['First line of the summary.', 'Second line of the summary.'],
  crew: [
    { role: 'Captain', name: 'A. Captain', detail: 'right seat, instructor' },
    { role: 'First Officer', name: 'B. Officer' },
  ],
  aircraft: { registration: 'JA8119', type: 'Boeing 747SR-46', callsign: 'JAL123', operator: 'Japan Air Lines', model: 'b744' },
  start: 65475, // 18:11:15
  end: 68188, // 18:56:28
}
const OTHER: ScenarioCard = { ...JAL, id: 'other', title: 'Another flight', crew: [], summary: [] }

function mount(list: () => Promise<ScenarioCard[]>) {
  const body = new El('div')
  const plays: string[] = []
  let calls = 0
  const panel = mountScenarioPanel(body as unknown as HTMLElement, {
    list: () => {
      calls++
      return list()
    },
    onPlay: (id) => plays.push(id),
  })
  return { body, panel, plays, calls: () => calls }
}

test('a skeleton while list() runs, then a card per scenario', async () => {
  const d = deferred<ScenarioCard[]>()
  const { body, calls } = mount(() => d.promise)
  assert.equal(calls(), 1, 'loads at mount')
  assert.equal(visible(body, 'fh-scn-skel').length, 1)
  assert.ok(visible(body, 'fh-skel').length >= 3, 'shimmer bars')
  assert.equal(find(body, 'fh-scn-card').length, 0)
  d.resolve([JAL, OTHER])
  await flush()
  assert.equal(visible(body, 'fh-scn-skel').length, 0)
  const cards = visible(body, 'fh-scn-card')
  assert.equal(cards.length, 2)
  assert.deepEqual(cards.map((c) => text(one(c, 'fh-scn-title'))), ['Japan Air Lines Flight 123', 'Another flight'])
})

test('a card shows subtitle, date and clock span, registration · type, summary, collapsed crew, the note, and Play', async () => {
  const { body } = mount(async () => [JAL])
  await flush()
  const card = one(body, 'fh-scn-card')
  assert.equal(card.tag, 'article')
  assert.equal(card.attrs['aria-label'], 'Japan Air Lines Flight 123', 'named, so its Play button has a context')
  assert.equal(text(one(card, 'fh-scn-sub')), 'Tokyo Haneda to Osaka Itami')
  assert.equal(text(one(card, 'fh-scn-date')), '12 August 1985 · 18:11–18:56 JST')
  assert.equal(text(one(card, 'fh-scn-ac')), 'JA8119 · Boeing 747SR-46')
  assert.deepEqual(one(card, 'fh-scn-summary').children.map(text), ['First line of the summary.', 'Second line of the summary.'])
  const crew = one(card, 'fh-scn-crew')
  assert.equal(crew.tag, 'details')
  assert.equal(crew.open, false, 'collapsed')
  assert.equal(text(crew.children[0]), 'Crew')
  assert.equal(crew.children[0].tag, 'summary')
  const rows = all(crew).filter((e) => e.tag === 'li')
  assert.deepEqual(rows.map(text), ['CaptainA. Captainright seat, instructor', 'First OfficerB. Officer'])
  assert.equal(text(one(card, 'fh-scn-note')), 'Reconstructed from the official accident report.')
  const play = one(card, 'fh-scn-play')
  assert.equal(play.tag, 'button')
  assert.equal(play.type, 'button')
  assert.ok(play.has('fh-pill'))
  assert.equal(text(play), 'Play')
})

test('no crew: no Crew list; no summary: no empty block', async () => {
  const { body } = mount(async () => [OTHER])
  await flush()
  assert.equal(find(body, 'fh-scn-card').length, 1)
  assert.equal(find(body, 'fh-scn-crew').length, 0)
  assert.equal(find(body, 'fh-scn-summary').length, 0)
})

test('Play calls onPlay with that card\'s id', async () => {
  const { body, plays } = mount(async () => [JAL, OTHER])
  await flush()
  const [a, b] = find(body, 'fh-scn-play')
  b.click()
  a.click()
  assert.deepEqual(plays, ['other', 'jal123'])
})

test('setPlaying: that card\'s button reads Playing and is disabled; null restores Play', async () => {
  const { body, panel, plays } = mount(async () => [JAL, OTHER])
  await flush()
  const [a, b] = find(body, 'fh-scn-play')
  panel.setPlaying('jal123')
  assert.deepEqual([text(a), a.disabled, text(b), b.disabled], ['Playing', true, 'Play', false])
  panel.setPlaying(null)
  assert.deepEqual([text(a), a.disabled, text(b), b.disabled], ['Play', false, 'Play', false])
  panel.setPlaying('other')
  assert.deepEqual([text(a), a.disabled, text(b), b.disabled], ['Play', false, 'Playing', true])
  assert.deepEqual(plays, [])
})

test('setPlaying before the list arrives still applies to the cards', async () => {
  const d = deferred<ScenarioCard[]>()
  const { body, panel } = mount(() => d.promise)
  panel.setPlaying('jal123')
  d.resolve([JAL])
  await flush()
  const play = one(body, 'fh-scn-play')
  assert.deepEqual([text(play), play.disabled], ['Playing', true])
})

test('list() fails: an error line and Try again, which loads again', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  let fail = true
  const { body, calls } = mount(async () => {
    if (fail) throw new Error('404')
    return [JAL]
  })
  await flush()
  assert.equal(visible(body, 'fh-scn-skel').length, 0)
  const err = visible(body, 'fh-scn-error')
  assert.equal(err.length, 1)
  assert.match(text(err[0]), /Could not load the scenarios/)
  assert.equal(warn.mock.callCount(), 1, 'the reason goes to the console (a package author needs it)')
  fail = false
  const retry = all(err[0]).find((e) => e.tag === 'button')!
  retry.click()
  assert.equal(calls(), 2)
  await flush()
  assert.equal(visible(body, 'fh-scn-error').length, 0)
  assert.equal(visible(body, 'fh-scn-card').length, 1)
})

test('an empty list says so', async () => {
  const { body } = mount(async () => [])
  await flush()
  assert.match(text(one(body, 'fh-scn-empty')), /No scenarios/)
})

test('refresh() reloads, and an older answer arriving late is dropped', async () => {
  const answers = [deferred<ScenarioCard[]>(), deferred<ScenarioCard[]>()]
  let i = 0
  const { body, panel } = mount(() => answers[i++].promise)
  panel.refresh()
  answers[1].resolve([OTHER])
  await flush()
  answers[0].resolve([JAL, OTHER])
  await flush()
  assert.deepEqual(visible(body, 'fh-scn-card').map((c) => text(one(c, 'fh-scn-title'))), ['Another flight'])
})

test('data goes in as text only', async () => {
  const { body } = mount(async () => [{ ...JAL, title: '<img src=x onerror=alert(1)>', note: '<b>n</b>' }])
  await flush()
  assert.equal(text(one(body, 'fh-scn-title')), '<img src=x onerror=alert(1)>')
  assert.equal(text(one(body, 'fh-scn-note')), '<b>n</b>')
})

test('destroy removes the panel, and a late answer adds nothing', async () => {
  const d = deferred<ScenarioCard[]>()
  const { body, panel } = mount(() => d.promise)
  assert.equal(body.children.length, 1)
  panel.destroy()
  assert.equal(body.children.length, 0)
  d.resolve([JAL])
  await flush()
  assert.equal(all(body).length, 1)
  panel.destroy()
})

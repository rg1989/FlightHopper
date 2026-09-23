// client/ui/captions.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import type { CaptionView } from './captions.ts'

// captions.ts imports its CSS for Vite. Node cannot load CSS, so this test process loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { mountCaptions } = await import('./captions.ts')

// Node has no DOM: just enough of one for captions.ts. Every element gets a serial number (a re-created line gets a new
// one) and counts writes; innerHTML throws: data goes in as text only.
let serial = 0
class El {
  tag: string
  id = ++serial
  children: El[] = []
  parent: El | null = null
  className = ''
  hidden = false
  writes = 0
  #text = ''
  attrs: Record<string, string> = {}
  dataset: Record<string, string> = {}
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
  set innerHTML(_v: string) {
    throw new Error('innerHTML is not allowed: data goes in with textContent')
  }
  insertAdjacentHTML(): void {
    throw new Error('insertAdjacentHTML is not allowed')
  }
  append(...cs: El[]): void {
    this.writes++
    for (const c of cs) {
      c.remove()
      c.parent = this
      this.children.push(c)
    }
  }
  insertBefore(c: El, ref: El | null): El {
    c.remove()
    this.writes++
    c.parent = this
    const i = ref === null ? -1 : this.children.indexOf(ref)
    if (i < 0) this.children.push(c)
    else this.children.splice(i, 0, c)
    return c
  }
  remove(): void {
    if (!this.parent) return
    this.parent.writes++
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }
  setAttribute(k: string, v: string): void {
    this.writes++
    this.attrs[k] = v
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

const A: CaptionView = { key: 'a', who: 'Captain', to: 'First Officer', channel: 'cockpit', translated: false, unintelligible: false, text: 'Line A.', original: null }
const B: CaptionView = { key: 'b', who: 'Captain', to: 'Tokyo Control', channel: 'radio', translated: false, unintelligible: false, text: 'Line B.', original: null }
const C: CaptionView = { key: 'c', who: 'Flight Engineer', to: 'Captain', channel: 'cockpit', translated: true, unintelligible: false, text: 'Line C.', original: 'ライン C' }
const PA: CaptionView = { key: 'pa', who: 'Purser', to: null, channel: 'cabin', translated: true, unintelligible: false, text: 'Cabin line.', original: null }
const U: CaptionView = { key: 'u', who: 'Captain', to: null, channel: 'cockpit', translated: false, unintelligible: true, text: '[unintelligible]', original: null }

function mount() {
  const root = new El('div')
  const c = mountCaptions(root as unknown as HTMLElement)
  const box = one(root, 'fh-captions')
  const lines = (): El[] => box.children
  return { root, c, box, lines }
}

test('a polite live region, empty until lines arrive', () => {
  const { box, lines } = mount()
  assert.equal(box.attrs['aria-live'], 'polite')
  assert.equal(lines().length, 0)
})

test('each line: who → to, the channel after a dot, the text; lines in the order given', () => {
  const { c, lines } = mount()
  c.update([A, B, PA])
  assert.deepEqual(lines().map((l) => text(one(l, 'fh-cap-head'))), ['Captain → First Officer', 'Captain → Tokyo Control · radio', 'Purser · cabinJA→EN'])
  assert.deepEqual(lines().map((l) => text(one(l, 'fh-cap-text'))), ['Line A.', 'Line B.', 'Cabin line.'])
  assert.deepEqual(lines().map((l) => l.dataset.channel), ['cockpit', 'radio', 'cabin'])
  c.update([{ ...B, key: 'co', channel: 'company' }])
  assert.equal(text(one(lines()[0], 'fh-cap-head')), 'Captain → Tokyo Control · radio')
})

test('a translated line carries the JA→EN mark and its original under the text', () => {
  const { c, lines } = mount()
  c.update([C, A])
  assert.equal(text(one(lines()[0], 'fh-cap-tr')), 'JA→EN')
  assert.equal(text(one(lines()[0], 'fh-cap-orig')), 'ライン C')
  assert.equal(find(lines()[1], 'fh-cap-tr').length, 0)
  assert.equal(find(lines()[1], 'fh-cap-orig').length, 0)
})

test('an unintelligible line is marked for the muted italic style', () => {
  const { c, lines } = mount()
  c.update([U, A])
  assert.deepEqual(lines().map((l) => l.has('fh-cap-u')), [true, false])
  assert.equal(text(one(lines()[0], 'fh-cap-text')), '[unintelligible]')
})

test('keyed: a line that stays keeps its element; gone lines go; new lines are added in order', () => {
  const { c, lines } = mount()
  c.update([A, B])
  const [a, b] = lines()
  c.update([B, C])
  assert.equal(lines().length, 2)
  assert.equal(lines()[0], b, 'B is the same element')
  assert.equal(lines()[0].id, b.id)
  assert.notEqual(lines()[1], a)
  assert.equal(text(one(lines()[1], 'fh-cap-text')), 'Line C.')
  assert.equal(a.parent, null, 'A was removed')
  c.update([C, B]) // a seek can reorder: moved, not re-created
  assert.deepEqual(lines().map((l) => text(one(l, 'fh-cap-text'))), ['Line C.', 'Line B.'])
  assert.equal(lines()[1], b)
  c.update([])
  assert.equal(lines().length, 0)
})

test('an unchanged update writes nothing (it runs every frame)', () => {
  const { root, c } = mount()
  c.update([A, B, C])
  const writes = (): number => all(root).reduce((n, e) => n + e.writes, 0)
  const before = writes()
  for (let i = 0; i < 50; i++) c.update([{ ...A }, { ...B }, { ...C }])
  assert.equal(writes(), before)
})

test('data goes in as text only', () => {
  const { c, lines } = mount()
  c.update([{ ...A, who: '<b>Captain</b>', text: '<img src=x onerror=alert(1)>', original: '<i>o</i>' }])
  assert.equal(text(one(lines()[0], 'fh-cap-text')), '<img src=x onerror=alert(1)>')
  assert.equal(text(one(lines()[0], 'fh-cap-head')), '<b>Captain</b> → First Officer')
  assert.equal(text(one(lines()[0], 'fh-cap-orig')), '<i>o</i>')
})

test('destroy removes the region; twice is harmless', () => {
  const { root, c } = mount()
  c.update([A])
  c.destroy()
  assert.equal(root.children.length, 0)
  c.destroy()
})

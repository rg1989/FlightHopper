// client/ui/ending.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

// ending.ts imports its CSS for Vite. Node cannot load CSS, so this test process loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { mountEnding } = await import('./ending.ts')

// Node has no DOM: just enough of one for ending.ts. Writes are counted; innerHTML throws: data goes in as text only.
class El {
  tag: string
  children: El[] = []
  parent: El | null = null
  className = ''
  type = ''
  writes = 0
  focused = 0
  #text = ''
  #hidden = false
  attrs: Record<string, string> = {}
  style = { opacity: '' }
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
  get textContent(): string {
    return this.#text
  }
  set textContent(v: string) {
    this.writes++
    this.#text = v
  }
  get hidden(): boolean {
    return this.#hidden
  }
  set hidden(v: boolean) {
    this.writes++
    this.#hidden = v
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
  addEventListener(type: string, f: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), f])
  }
  click(): void {
    for (const f of this.listeners.get('click') ?? []) f()
  }
  focus(): void {
    this.focused++
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
const one = (root: El, cls: string): El => {
  const hits = all(root).filter((e) => e.has(cls))
  assert.equal(hits.length, 1, `one .${cls}, found ${hits.length}`)
  return hits[0]
}

const CARD = { title: 'Japan Air Lines Flight 123 · 12 August 1985', lines: ['First paragraph.', 'Second paragraph.', 'Third paragraph.'] }

function mount() {
  const root = new El('div')
  let closes = 0
  const e = mountEnding(root as unknown as HTMLElement, { onClose: () => closes++ })
  const wrap = one(root, 'fh-ending')
  const veil = one(root, 'fh-ending-veil')
  const card = one(root, 'fh-ending-card')
  return { root, e, wrap, veil, card, closes: () => closes }
}

test('before the fade: nothing shows', () => {
  const { e, wrap, card } = mount()
  e.update(0, null)
  assert.equal(wrap.hidden, true)
  assert.equal(card.hidden, true)
})

test('the veil\'s opacity is the fade; it takes the pointer only once fully dark', () => {
  const { e, wrap, veil, card } = mount()
  e.update(0.5, null)
  assert.equal(wrap.hidden, false)
  assert.equal(veil.style.opacity, '0.5')
  assert.equal(wrap.has('fh-ending-solid'), false, 'the camera stays free while it fades')
  assert.equal(card.hidden, true)
  e.update(0.98, null)
  assert.equal(wrap.has('fh-ending-solid'), false)
  e.update(0.99, null)
  assert.equal(wrap.has('fh-ending-solid'), true)
  e.update(1.4, null)
  assert.equal(veil.style.opacity, '1')
  e.update(0.3, null) // a drag back
  assert.equal(wrap.has('fh-ending-solid'), false)
  e.update(-1, null)
  assert.equal(wrap.hidden, true)
})

test('the card shows only when given: its title, its lines as paragraphs and one Close button', () => {
  const { e, card, closes } = mount()
  e.update(1, null)
  assert.equal(card.hidden, true)
  e.update(1, CARD)
  assert.equal(card.hidden, false)
  assert.ok(card.has('fh-glass'))
  assert.equal(text(one(card, 'fh-ending-title')), CARD.title)
  const ps = all(card).filter((x) => x.tag === 'p')
  assert.deepEqual(ps.map(text), CARD.lines)
  const buttons = all(card).filter((x) => x.tag === 'button')
  assert.equal(buttons.length, 1, 'no other controls')
  assert.deepEqual([buttons[0].type, text(buttons[0])], ['button', 'Close'])
  assert.equal(buttons[0].focused, 1, 'Close takes the focus when the card appears')
  buttons[0].click()
  assert.equal(closes(), 1)
  e.update(1, null) // a drag back before the card
  assert.equal(card.hidden, true)
})

test('an unchanged update writes nothing, and the card is not rebuilt every frame', () => {
  const { root, e } = mount()
  e.update(1, CARD)
  const writes = (): number => all(root).reduce((n, x) => n + x.writes, 0)
  const before = writes()
  for (let i = 0; i < 50; i++) e.update(1, { title: CARD.title, lines: [...CARD.lines] })
  assert.equal(writes(), before)
})

test('data goes in as text only', () => {
  const { e, card } = mount()
  e.update(1, { title: '<b>t</b>', lines: ['<img src=x onerror=alert(1)>'] })
  assert.equal(text(one(card, 'fh-ending-title')), '<b>t</b>')
  assert.equal(text(all(card).find((x) => x.tag === 'p')!), '<img src=x onerror=alert(1)>')
})

// Spec §7: dragging into the dark seconds shows dark and the clock only. The veil (z 30) covers the rail and the scene,
// and once solid it takes the pointer; the play bar must stand above it while it shows, or a paused t in the dark before
// the card (or a reload of ?t= there) leaves a black screen with nothing to press. CSS, so checked as text.
test('while the ending shows, the play bar stands above the veil (its clock, pause, scrubber and exit stay in reach)', () => {
  const css = readFileSync(new URL('./ending.css', import.meta.url), 'utf8')
  const veilZ = Number(/\.fh-ending \{[^}]*?z-index: (\d+);/.exec(css)?.[1])
  const lift = /\.fh-ui:has\(\.fh-ending:not\(\[hidden\]\)\) \.fh-playbar \{[^}]*?z-index: (\d+);/.exec(css)
  assert.equal(veilZ, 30)
  assert.ok(lift, 'a rule lifts .fh-playbar while .fh-ending is not hidden')
  assert.ok(Number(lift[1]) > veilZ, `bar z ${lift[1]} > veil z ${veilZ}`)
  assert.match(css, /\.fh-ending \{[^}]*?padding:[^;]*var\(--fh-playbar-space/, 'the card is centred above the bar, never under it')
})

test('destroy removes it; twice is harmless', () => {
  const { root, e } = mount()
  e.destroy()
  assert.equal(root.children.length, 0)
  e.destroy()
})

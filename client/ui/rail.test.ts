// client/ui/rail.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// rail.ts imports its CSS for Vite. Node cannot load CSS, so this test process loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})

// Node has no DOM: just enough of one for mountRail (elements, classes, attributes, clicks) and its ResizeObserver.
class El {
  children: El[] = []
  parent: El | null = null
  attrs: Record<string, string> = {}
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  classes = new Set<string>()
  hidden = false
  textContent = ''
  #clicks: (() => void)[] = []
  classList = {
    add: (c: string): void => void this.classes.add(c),
    toggle: (c: string, on = !this.classes.has(c)): boolean => (on ? this.classes.add(c) : this.classes.delete(c), on),
  }
  tagName: string
  constructor(tagName: string) {
    this.tagName = tagName
  }
  get className(): string {
    return [...this.classes].join(' ')
  }
  set className(v: string) {
    this.classes = new Set(v.split(' ').filter(Boolean))
  }
  append(...cs: El[]): void {
    for (const c of cs) {
      c.parent = this
      this.children.push(c)
    }
  }
  remove(): void {
    this.parent?.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v
  }
  addEventListener(type: string, fn: () => void): void {
    if (type === 'click') this.#clicks.push(fn)
  }
  click(): void {
    for (const fn of this.#clicks) fn()
  }
}
const g = globalThis as Record<string, unknown>
g.document = { createElement: (t: string) => new El(t), createElementNS: (_ns: string, t: string) => new El(t) }
g.ResizeObserver = class {
  observe(): void {}
  disconnect(): void {}
}
const { mountRail } = await import('./rail.ts')

const find = (e: El, pred: (x: El) => boolean): El[] => [...(pred(e) ? [e] : []), ...e.children.flatMap((c) => find(c, pred))]
const ids = (e: El): (string | undefined)[] => find(e, (x) => x.tagName === 'button' && 'id' in x.dataset).map((b) => b.dataset.id)

test('mountRail: a corner item is a button of its own in the corner, not on the rail; button() finds it, a click runs it', () => {
  const root = new El('div')
  let full = 0
  const rail = mountRail(root as unknown as HTMLElement, [
    { id: 'list', icon: 'list', label: 'Aircraft', short: 'Aircraft', panel: { title: 'Aircraft', mount: () => {} } },
    { id: 'layout', icon: 'layout', label: 'Edit instrument layout', short: 'Layout', group: 1, corner: true, action: () => {} },
    { id: 'settings', icon: 'settings', label: 'Settings', short: 'Settings', group: 1, action: () => {} },
    { id: 'fullscreen', icon: 'maximize', label: 'Full screen', short: 'Full', group: 2, corner: true, action: () => full++ },
  ])
  const [nav] = find(root, (e) => e.classes.has('fh-rail'))
  const [corner] = find(root, (e) => e.classes.has('fh-corner'))
  assert.deepEqual(ids(nav), ['list', 'settings'])
  assert.deepEqual(ids(corner), ['layout', 'fullscreen'], 'in the corner, in order')
  assert.equal(corner.children.length, 2, 'each in a glass square of its own')
  assert.ok(corner.children.every((c) => c.classes.has('fh-glass')))
  assert.equal(find(nav, (e) => e.classes.has('fh-rail-sep')).length, 1, 'the rail\'s dividers as if the corner items were not there')
  assert.equal(find(corner, (e) => e.classes.has('fh-ibtn-label')).length, 0, 'no tab-bar label: they are not tabs')
  ;(rail.button('fullscreen') as unknown as El).click()
  assert.equal(full, 1)
  rail.destroy()
  assert.equal(root.children.length, 0)
})

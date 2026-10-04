// client/ui/rail.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
  replaceChildren(...cs: El[]): void {
    this.children = []
    this.append(...cs)
  }
  append(...cs: El[]): void {
    for (const c of cs) {
      const at = c.parent?.children.indexOf(c) ?? -1
      if (at >= 0) c.parent!.children.splice(at, 1) // moved, as the DOM does
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
let phone = false
const phoneListeners: (() => void)[] = []
g.matchMedia = () => ({
  get matches() {
    return phone
  },
  addEventListener: (_t: string, f: () => void) => phoneListeners.push(f),
  removeEventListener: () => {},
})
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
    { id: 'layout', icon: 'layout', label: 'Edit instrument layout', short: 'Layout', group: 1, spot: 'corner', action: () => {} },
    { id: 'settings', icon: 'settings', label: 'Settings', short: 'Settings', group: 1, action: () => {} },
    { id: 'fullscreen', icon: 'maximize', label: 'Full screen', short: 'Full', group: 2, spot: 'corner', action: () => full++ },
  ])
  const [nav] = find(root, (e) => e.classes.has('fh-rail'))
  const [corner] = find(root, (e) => e.classes.has('fh-corner'))
  assert.deepEqual(ids(nav), ['list', 'settings'])
  assert.deepEqual(ids(corner), ['layout', 'fullscreen'], 'in the corner, in order')
  assert.equal(corner.children.length, 2, 'each in a glass square of its own')
  assert.ok(corner.children.every((c) => c.classes.has('fh-glass')))
  assert.equal(find(nav, (e) => e.classes.has('fh-rail-sep')).length, 1, 'the rail\'s dividers as if the corner items were not there')
  assert.ok(find(corner, (e) => e.classes.has('fh-ibtn-label')).length > 0, 'a label for the phone strip (hidden here by rail.css)')
  ;(rail.button('fullscreen') as unknown as El).click()
  assert.equal(full, 1)
  rail.destroy()
  assert.equal(root.children.length, 0)
})

test('mountRail: an under item is a panel button in a square of its own under the rail; it opens its panel', () => {
  const root = new El('div')
  const rail = mountRail(root as unknown as HTMLElement, [
    { id: 'status', icon: 'status', label: 'Live status', short: 'Live', panel: { title: 'Status', mount: () => {} } },
    { id: 'scene', icon: 'layers', label: 'Layers', short: 'Layers', spot: 'under', panel: { title: 'Layers', mount: () => {} } },
  ])
  const [nav] = find(root, (e) => e.tagName === 'nav')
  const [under] = find(root, (e) => e.classes.has('fh-under'))
  assert.deepEqual(ids(nav), ['status'], 'not on the rail')
  assert.deepEqual(ids(under), ['scene'])
  assert.ok(under.children[0].classes.has('fh-glass'))
  ;(rail.button('scene') as unknown as El).click()
  assert.equal(rail.openId, 'scene')
  assert.equal((rail.button('scene') as unknown as El).attrs['aria-expanded'], 'true')
  rail.destroy()
  assert.equal(root.children.length, 0)
})

test('mountRail: a bottom spot; a spot item\'s panel opens at the rail like the others', () => {
  const root = new El('div')
  const rail = mountRail(root as unknown as HTMLElement, [
    { id: 'status', icon: 'status', label: 'Live status', short: 'Live', panel: { title: 'Status', mount: () => {} } },
    { id: 'scenarios', icon: 'film', label: 'Scenarios', short: 'Scenes', panel: { title: 'Scenarios', mount: () => {} } },
    { id: 'layout', icon: 'layout', label: 'Layout', short: 'Layout', spot: 'bottom', action: () => {} },
  ])
  const at = (cls: string): (string | undefined)[] => ids(find(root, (e) => e.classes.has(cls))[0])
  assert.deepEqual([at('fh-rail'), at('fh-spot-bottom')], [['status', 'scenarios'], ['layout']])
  rail.destroy()
  assert.equal(root.children.length, 0)
})

test('mountRail: on phones every button is a tab in the one strip, in item order; wider, back in their squares', () => {
  const root = new El('div')
  const rail = mountRail(root as unknown as HTMLElement, [
    { id: 'status', icon: 'status', label: 'Live status', short: 'Live', panel: { title: 'Status', mount: () => {} } },
    { id: 'scene', icon: 'layers', label: 'Layers', short: 'Layers', spot: 'under', panel: { title: 'Layers', mount: () => {} } },
    { id: 'aircraft', icon: 'list', label: 'Aircraft', short: 'Aircraft', group: 1, panel: { title: 'Aircraft', mount: () => {} } },
    { id: 'layout', icon: 'layout', label: 'Layout', short: 'Layout', spot: 'bottom', action: () => {} },
    { id: 'settings', icon: 'settings', label: 'Settings', short: 'Settings', spot: 'corner', action: () => {} },
  ])
  const [nav] = find(root, (e) => e.tagName === 'nav')
  assert.deepEqual(ids(nav), ['status', 'aircraft'])
  phone = true
  for (const f of phoneListeners) f()
  assert.deepEqual(ids(nav), ['status', 'scene', 'aircraft', 'layout', 'settings'])
  phone = false
  for (const f of phoneListeners) f()
  assert.deepEqual(ids(nav), ['status', 'aircraft'])
  assert.equal(find(nav, (e) => e.classes.has('fh-rail-sep')).length, 1)
  assert.deepEqual(ids(find(root, (e) => e.classes.has('fh-spot-bottom'))[0]), ['layout'])
  rail.destroy()
})

test('mountRail: setHidden takes a button away, and the square it stands in; shown again it is back, in its place under the one before', () => {
  const root = new El('div')
  const rail = mountRail(root as unknown as HTMLElement, [
    { id: 'status', icon: 'status', label: 'Live status', short: 'Live', panel: { title: 'Status', mount: () => {} } },
    { id: 'scene', icon: 'layers', label: 'Layers', short: 'Layers', spot: 'under', panel: { title: 'Layers', mount: () => {} } },
    { id: 'weather', icon: 'cloud', label: 'Weather', short: 'Weather', spot: 'under', panel: { title: 'Weather', mount: () => {} } },
  ])
  const [under] = find(root, (e) => e.classes.has('fh-under'))
  assert.deepEqual(ids(under), ['scene', 'weather'], 'two squares under the rail, in item order')
  const square = (id: string): El => under.children.find((s) => s.dataset.id === id)!
  const shown = (): boolean[] => ['scene', 'weather'].map((id) => !square(id).hidden && !(rail.button(id) as unknown as El).hidden)
  assert.deepEqual(shown(), [true, true])
  rail.setHidden('weather', true)
  assert.deepEqual(shown(), [true, false], 'the Layers square stays')
  assert.equal(square('weather').hidden, true)
  assert.equal((rail.button('weather') as unknown as El).hidden, true)
  rail.setHidden('weather', true) // again: nothing more to do
  rail.setHidden('weather', false)
  assert.deepEqual(shown(), [true, true])
  assert.deepEqual(ids(under), ['scene', 'weather'])
  assert.throws(() => rail.setHidden('nothing', true), /no item nothing/)
  rail.destroy()
})

test('mountRail: a hidden button is a hidden tab on phones, and stays hidden going back to the wide rail', () => {
  const root = new El('div')
  const rail = mountRail(root as unknown as HTMLElement, [
    { id: 'status', icon: 'status', label: 'Live status', short: 'Live', panel: { title: 'Status', mount: () => {} } },
    { id: 'scene', icon: 'layers', label: 'Layers', short: 'Layers', spot: 'under', panel: { title: 'Layers', mount: () => {} } },
    { id: 'weather', icon: 'cloud', label: 'Weather', short: 'Weather', spot: 'under', panel: { title: 'Weather', mount: () => {} } },
  ])
  const [nav] = find(root, (e) => e.tagName === 'nav')
  const [under] = find(root, (e) => e.classes.has('fh-under'))
  const tab = (id: string): El => find(nav, (e) => e.dataset.id === id)[0]
  rail.setHidden('weather', true)
  phone = true
  for (const f of phoneListeners) f()
  assert.deepEqual(ids(nav), ['status', 'scene', 'weather'], 'its tab is in the strip, after Layers')
  assert.equal(tab('weather').hidden, true, 'hidden there')
  assert.equal(tab('scene').hidden, false)
  rail.setHidden('weather', false)
  assert.equal(tab('weather').hidden, false, 'a tab again')
  rail.setHidden('weather', true)
  phone = false
  for (const f of phoneListeners) f()
  assert.deepEqual(ids(nav), ['status'])
  assert.deepEqual(ids(under), ['scene', 'weather'])
  assert.equal(under.children.find((s) => s.dataset.id === 'weather')!.hidden, true, 'its square is hidden still')
  rail.destroy()
})

test('mountRail: hiding the button of the open panel closes the panel; hiding another one leaves it open', () => {
  const root = new El('div')
  const opened: (string | null)[] = []
  const rail = mountRail(root as unknown as HTMLElement, [
    { id: 'status', icon: 'status', label: 'Live status', short: 'Live', panel: { title: 'Status', mount: () => {} } },
    { id: 'weather', icon: 'cloud', label: 'Weather', short: 'Weather', spot: 'under', panel: { title: 'Weather', mount: () => {} } },
  ], (id) => opened.push(id))
  const [panel] = find(root, (e) => e.classes.has('fh-panel'))
  rail.open('status')
  rail.setHidden('weather', true)
  assert.equal(rail.openId, 'status', 'another button going away leaves the panel')
  rail.setHidden('weather', false)
  rail.open('weather')
  assert.equal(panel.hidden, false)
  rail.setHidden('weather', true)
  assert.equal(rail.openId, null)
  assert.equal(panel.hidden, true)
  assert.deepEqual(opened, ['status', 'weather', null], 'the app is told, as for any close')
  assert.equal((rail.button('weather') as unknown as El).attrs['aria-expanded'], 'false')
  rail.destroy()
})

test('mountRail: the panel of a hidden button does not open (no panel shows without its button); shown again, it does', () => {
  const root = new El('div')
  const opened: (string | null)[] = []
  const rail = mountRail(root as unknown as HTMLElement, [
    { id: 'status', icon: 'status', label: 'Live status', short: 'Live', panel: { title: 'Status', mount: () => {} } },
    { id: 'weather', icon: 'cloud', label: 'Weather', short: 'Weather', spot: 'under', panel: { title: 'Weather', mount: () => {} } },
  ], (id) => opened.push(id))
  const [panel] = find(root, (e) => e.classes.has('fh-panel'))
  rail.setHidden('weather', true)
  rail.open('weather')
  assert.deepEqual([rail.openId, panel.hidden, opened.length], [null, true, 0])
  rail.open('status')
  rail.open('weather')
  assert.equal(rail.openId, 'status', 'the open panel stays')
  rail.setHidden('weather', false)
  rail.open('weather')
  assert.equal(rail.openId, 'weather')
  rail.destroy()
})

// .fh-ibtn and .fh-rail .fh-ibtn (the phone tab) set a display, which beats the hidden attribute's own. CSS, so checked as text.
test('rail.css: a hidden button and its square really go, in the wide rail and the phone tab bar', () => {
  const css = readFileSync(new URL('./rail.css', import.meta.url), 'utf8')
  assert.match(css, /\.fh-ibtn\[hidden\],\s*\.fh-corner-b\[hidden\] \{\s*display: none !important;\s*\}/)
})

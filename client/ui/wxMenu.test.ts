// client/ui/wxMenu.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { SEV_COLOR } from '../scene/wxAhead.ts'
import type { WxPrefs } from './wxPrefs.ts'

// wxMenu.ts imports its CSS for Vite. Node cannot load CSS, so this test process loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { mountWxMenu } = await import('./wxMenu.ts')
const { DEFAULT_WX_PREFS } = await import('./wxPrefs.ts')

// Node has no DOM: just enough of one for mountWxMenu (and icons.ts). A click goes to the element's listeners, then up its parents', as in a page.
interface ClickEvent { target: El }
class El {
  tag: string
  children: El[] = []
  parent: El | null = null
  className = ''
  #text = ''
  type = ''
  vars: Record<string, string> = {}
  style = { setProperty: (k: string, v: string): void => void (this.vars[k] = v) }
  classList = { add: (): void => {} } // icons.ts marks its svg
  attrs: Record<string, string> = {}
  attrWrites = 0
  listeners: ((e: ClickEvent) => void)[] = []
  constructor(tag: string) {
    this.tag = tag
  }
  get textContent(): string {
    return this.#text
  }
  set textContent(v: string) {
    this.#text = v
  }
  append(...cs: El[]): void {
    for (const c of cs) {
      c.parent = this
      this.children.push(c)
    }
  }
  remove(): void {
    if (!this.parent) return
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }
  setAttribute(k: string, v: string): void {
    this.attrWrites++
    this.attrs[k] = v
  }
  addEventListener(type: string, f: (e: ClickEvent) => void): void {
    if (type === 'click') this.listeners.push(f)
  }
  click(e: ClickEvent = { target: this }): void {
    for (const f of this.listeners) f(e)
    this.parent?.click(e)
  }
}
Object.assign(globalThis, {
  document: { createElement: (tag: string) => new El(tag), createElementNS: (_ns: string, tag: string) => new El(tag) },
})

const all = (el: El): El[] => [el, ...el.children.flatMap(all)]
const text = (el: El): string => el.textContent + el.children.map(text).join('')

function mount(prefs: WxPrefs = DEFAULT_WX_PREFS) {
  const root = new El('div')
  const changes: WxPrefs[] = []
  const menu = mountWxMenu(root as unknown as HTMLElement, { prefs, onChange: (next) => changes.push(next) })
  const group = (label: string): El => all(root).find((e) => e.attrs.role === 'group' && e.attrs['aria-label'] === label)!
  const button = (label: string, name: string): El => group(label).children.find((b) => b.textContent === name)!
  const sw = (label: string): El => all(root).find((e) => e.attrs.role === 'switch' && e.attrs['aria-label'] === label)!
  const pressed = (label: string): string[] => group(label).children.filter((b) => b.attrs['aria-pressed'] === 'true').map((b) => b.textContent)
  const aids = (): string[] => ['Track line', 'Level slice', 'Ahead strip'].map((l) => sw(l).attrs['aria-checked'])
  return { root, menu, changes, group, button, sw, pressed, aids }
}

test('the panel: Clouds with its legend, Hazard areas, Looking ahead with a switch row and a hint each', () => {
  const { root, group } = mount()
  assert.deepEqual(all(root).filter((e) => e.className === 'fh-scene-title').map(text), ['Clouds', 'Hazard areas', 'Looking ahead'])
  assert.deepEqual(group('Clouds').children.map(text), ['Natural', 'Severity colours', 'Blocks'])
  assert.deepEqual(group('Hazard area style').children.map(text), ['Curtain', 'Fence', 'Box'])
  const rows = all(root).filter((e) => e.className === 'fh-scene-row')
  assert.deepEqual(rows.map((r) => text(r.children[1])), [
    "Track lineThe next six minutes on this heading",
    "Level sliceThe weather at the aircraft's own altitude",
    'Ahead stripSide view of the next 80 km',
  ])
  const switches = all(root).filter((e) => e.attrs.role === 'switch')
  assert.deepEqual(switches.map((s) => s.attrs['aria-label']), ['Track line', 'Level slice', 'Ahead strip'])
  for (const s of switches) {
    assert.equal(s.tag, 'button')
    assert.equal(s.type, 'button') // never a form submit; Enter and Space work as on any button
    assert.equal(s.className, 'fh-switch')
  }
  for (const b of all(root).filter((e) => e.className === 'fh-seg-b')) assert.equal(b.type, 'button')
})

test('the four-colour legend under the clouds: Cloud, Light rain, Heavy rain, Thunderstorm, in the severity scale\'s colours', () => {
  const { root, group } = mount()
  const legend = all(root).find((e) => e.className === 'fh-wx-legend fh-wxm-legend')!
  assert.deepEqual(legend.children.map(text), ['Cloud', 'Light rain', 'Heavy rain', 'Thunderstorm'])
  assert.deepEqual(legend.children.map((k) => k.vars['--c']), [...SEV_COLOR])
  assert.deepEqual(SEV_COLOR, ['#f2f5f8', '#58a6ff', '#ffbe3d', '#ff4d3d'])
  // Under the clouds' buttons, in the same section.
  const section = group('Clouds').parent!
  assert.ok(section.children.includes(legend))
  assert.ok(section.children.indexOf(legend) > section.children.indexOf(group('Clouds')))
})

test('it is the Layers panel\'s look: its classes for the section heads, button groups, rows and switches', () => {
  const { root } = mount()
  const classes = new Set(all(root).map((e) => e.className))
  for (const c of ['fh-scene', 'fh-scene-head', 'fh-scene-title', 'fh-seg', 'fh-seg-b', 'fh-scene-row', 'fh-scene-icon', 'fh-scene-text', 'fh-scene-label', 'fh-scene-hint', 'fh-switch']) {
    assert.ok([...classes].some((k) => k.split(' ').includes(c)), c)
  }
  assert.equal(root.children.length, 3)
  assert.ok(root.children.every((s) => s.className === 'fh-scene'))
})

test('mounted with the prefs it is given: the pressed buttons and the switches show them', () => {
  const a = mount() // the defaults
  assert.deepEqual([a.pressed('Clouds'), a.pressed('Hazard area style'), a.aids()], [['Severity colours'], ['Curtain'], ['true', 'false', 'true']])
  const b = mount({ look: 'blocks', hazard: 'box', track: false, slice: true, strip: false })
  assert.deepEqual([b.pressed('Clouds'), b.pressed('Hazard area style'), b.aids()], [['Blocks'], ['Box'], ['false', 'true', 'false']])
  const c = mount({ look: 'natural', hazard: 'fence', track: true, slice: true, strip: true })
  assert.deepEqual([c.pressed('Clouds'), c.pressed('Hazard area style'), c.aids()], [['Natural'], ['Fence'], ['true', 'true', 'true']])
})

test('a look or a style button asks for it and keeps the others; the one already pressed asks nothing', () => {
  const p: WxPrefs = { look: 'severity', hazard: 'curtain', track: true, slice: false, strip: true }
  const { button, changes } = mount(p)
  button('Clouds', 'Natural').click()
  button('Clouds', 'Blocks').click()
  button('Clouds', 'Severity colours').click() // pressed already
  button('Hazard area style', 'Fence').click()
  button('Hazard area style', 'Box').click()
  button('Hazard area style', 'Curtain').click() // pressed already
  assert.deepEqual(changes, [
    { ...p, look: 'natural' },
    { ...p, look: 'blocks' },
    { ...p, hazard: 'fence' },
    { ...p, hazard: 'box' },
  ])
})

test('a switch asks for its own field toggled and keeps the others; the whole row is the target, and a click on the switch asks once', () => {
  const p: WxPrefs = { look: 'blocks', hazard: 'fence', track: true, slice: false, strip: true }
  const { sw, changes } = mount(p)
  sw('Track line').click()
  sw('Level slice').click()
  sw('Ahead strip').click()
  assert.deepEqual(changes, [{ ...p, track: false }, { ...p, slice: true }, { ...p, strip: false }]) // one ask each, though a click rises to its row
  const row = sw('Level slice').parent!
  assert.equal(row.className, 'fh-scene-row')
  row.click() // on the row, not on its switch (a finger's)
  assert.deepEqual(changes.at(-1), { ...p, slice: true })
  assert.equal(changes.length, 4)
})

test('a click changes nothing itself: the app answers with update(); the caller\'s prefs are not touched', () => {
  const p: WxPrefs = { look: 'severity', hazard: 'curtain', track: true, slice: false, strip: true }
  const { button, sw, pressed, aids, changes } = mount(p)
  button('Clouds', 'Blocks').click()
  sw('Level slice').click()
  assert.deepEqual(pressed('Clouds'), ['Severity colours'])
  assert.deepEqual(aids(), ['true', 'false', 'true'])
  assert.deepEqual(p, { look: 'severity', hazard: 'curtain', track: true, slice: false, strip: true })
  assert.notEqual(changes[0], p)
  button('Hazard area style', 'Box').click()
  assert.deepEqual(changes[2], { ...p, hazard: 'box' }) // still from what it was given, not from the clicks
})

test('update() moves the pressed buttons and the switches, asks nothing, and the next click goes from the new prefs', () => {
  const { menu, button, sw, pressed, aids, changes } = mount()
  menu.update({ look: 'natural', hazard: 'box', track: false, slice: true, strip: false })
  assert.deepEqual([pressed('Clouds'), pressed('Hazard area style'), aids()], [['Natural'], ['Box'], ['false', 'true', 'false']])
  assert.deepEqual(changes, [])
  button('Clouds', 'Blocks').click()
  sw('Track line').click()
  assert.deepEqual(changes, [
    { look: 'blocks', hazard: 'box', track: false, slice: true, strip: false },
    { look: 'natural', hazard: 'box', track: true, slice: true, strip: false },
  ])
  button('Clouds', 'Natural').click() // the one pressed now
  assert.equal(changes.length, 2)
  menu.update(DEFAULT_WX_PREFS)
  assert.deepEqual([pressed('Clouds'), pressed('Hazard area style'), aids()], [['Severity colours'], ['Curtain'], ['true', 'false', 'true']])
})

test('update() writes only what changed (it runs for every choice made)', () => {
  const p: WxPrefs = { look: 'severity', hazard: 'curtain', track: true, slice: false, strip: true }
  const { root, menu } = mount(p)
  const writes = (): number => all(root).reduce((n, e) => n + e.attrWrites, 0)
  const before = writes()
  menu.update({ ...p })
  assert.equal(writes(), before, 'the same prefs: nothing written')
  menu.update({ ...p, look: 'blocks' })
  assert.equal(writes(), before + 3, 'a look: its three buttons')
  menu.update({ ...p, look: 'blocks', slice: true })
  assert.equal(writes(), before + 4, 'a switch: that switch')
})

test('destroy() takes the panel\'s parts out of its root', () => {
  const { root, menu } = mount()
  assert.equal(root.children.length, 3)
  menu.destroy()
  assert.equal(root.children.length, 0)
})

// .fh-seg-b's thirds are 95 px each in the 320 px panel and "Severity colours" needs about 110: the buttons share the row by their text.
// CSS, so checked as text.
test('wxMenu.css: the look buttons share the row by their text, and the legend has the panel\'s margins', () => {
  const css = readFileSync(new URL('./wxMenu.css', import.meta.url), 'utf8')
  assert.match(css, /\.fh-wxm-seg \.fh-seg-b \{[^}]*flex: 1 1 auto;[^}]*white-space: nowrap;[^}]*\}/)
  assert.match(css, /\.fh-wxm-legend \{[^}]*padding: 0 14px 10px;[^}]*\}/)
})

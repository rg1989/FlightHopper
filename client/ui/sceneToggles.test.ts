// client/ui/sceneToggles.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import type { ScenePrefs } from '../types.ts'

// sceneToggles.ts imports its CSS for Vite. Node cannot load CSS, so this test process loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { mountSceneToggles } = await import('./sceneToggles.ts')

// Node has no DOM: just enough of one for mountSceneToggles, plus recorders for listeners outside the group.
class El {
  tag: string
  children: El[] = []
  parent: El | null = null
  className = ''
  textContent = ''
  title = ''
  type = ''
  attrs: Record<string, string> = {}
  attrWrites = 0
  listeners = new Map<string, (() => void)[]>()
  constructor(tag: string) {
    this.tag = tag
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
  addEventListener(type: string, f: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), f])
  }
  click(): void {
    for (const f of this.listeners.get('click') ?? []) f()
  }
}
const outside: string[] = [] // listeners added to window or document: keys belong to the app
Object.assign(globalThis, {
  document: { createElement: (tag: string) => new El(tag), addEventListener: (t: string) => outside.push(`document:${t}`) },
  window: { addEventListener: (t: string) => outside.push(`window:${t}`) },
})

function mount(prefs: ScenePrefs) {
  const root = new El('div')
  const changes: ScenePrefs[] = []
  const t = mountSceneToggles(root as unknown as HTMLElement, { prefs, onChange: (next) => changes.push(next) })
  const group = root.children[0]
  const [topo, light] = group.children
  const pressed = (): [string, string] => [topo.attrs['aria-pressed'], light.attrs['aria-pressed']]
  return { root, group, topo, light, t, changes, pressed }
}

test('one group of two real buttons: "3-D terrain" and "Sun", titles naming the keys', () => {
  const { root, group, topo, light } = mount({ topo: true, light: true })
  assert.equal(root.children.length, 1)
  assert.equal(group.className, 'fh-toggles')
  assert.equal(group.attrs.role, 'group')
  assert.equal(group.attrs['aria-label'], 'Terrain and sun')
  assert.equal(group.children.length, 2)
  for (const b of [topo, light]) {
    assert.equal(b.tag, 'button')
    assert.equal(b.type, 'button') // never a form submit; Enter and Space work as on any button
    assert.equal(b.className, 'fh-toggle')
  }
  assert.deepEqual([topo.textContent, topo.title], ['3-D terrain', 'Topography — T'])
  assert.deepEqual([light.textContent, light.title], ['Sun', 'Sun lighting — L'])
})

test('aria-pressed shows the prefs it was mounted with', () => {
  assert.deepEqual(mount({ topo: true, light: true }).pressed(), ['true', 'true'])
  assert.deepEqual(mount({ topo: false, light: true }).pressed(), ['false', 'true'])
  assert.deepEqual(mount({ topo: true, light: false }).pressed(), ['true', 'false'])
  assert.deepEqual(mount({ topo: false, light: false }).pressed(), ['false', 'false'])
})

test('a click asks for the toggled copy and changes nothing itself: the app answers with update()', () => {
  const prefs = { topo: true, light: true }
  const { topo, light, changes, pressed } = mount(prefs)
  topo.click()
  assert.deepEqual(changes, [{ topo: false, light: true }])
  assert.notEqual(changes[0], prefs)
  assert.deepEqual(prefs, { topo: true, light: true }) // the caller's object is not touched
  assert.deepEqual(pressed(), ['true', 'true']) // not until update()
  light.click()
  assert.deepEqual(changes[1], { topo: true, light: false }) // still from the mounted prefs
})

test('update() only re-renders: no onChange, and the next click toggles from the new prefs', () => {
  const { topo, light, t, changes, pressed } = mount({ topo: true, light: true })
  t.update({ topo: false, light: true })
  assert.deepEqual(pressed(), ['false', 'true'])
  assert.equal(changes.length, 0)
  topo.click()
  assert.deepEqual(changes, [{ topo: true, light: true }])
  const p = { topo: false, light: false }
  t.update(p)
  assert.deepEqual(pressed(), ['false', 'false'])
  p.topo = true // a caller reusing its object later does not change what the group holds
  light.click()
  assert.deepEqual(changes[1], { topo: false, light: true })
})

test('update() with unchanged prefs writes nothing (cheap to call every frame)', () => {
  const { topo, light, t } = mount({ topo: true, light: false })
  const writes = (): number => topo.attrWrites + light.attrWrites
  const before = writes()
  for (let i = 0; i < 100; i++) t.update({ topo: true, light: false })
  assert.equal(writes(), before)
  t.update({ topo: true, light: true })
  assert.equal(writes(), before + 1) // only the button that changed
})

test('keys and storage belong to the app: no listeners outside the group', () => {
  outside.length = 0
  const { topo, t } = mount({ topo: true, light: true })
  topo.click()
  t.update({ topo: false, light: true })
  assert.deepEqual(outside, [])
})

test('destroy removes the group; twice is harmless', () => {
  const { root, t } = mount({ topo: true, light: true })
  t.destroy()
  assert.equal(root.children.length, 0)
  t.destroy()
  assert.equal(root.children.length, 0)
})

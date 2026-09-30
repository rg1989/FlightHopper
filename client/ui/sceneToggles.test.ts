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
const { DEFAULT_PREFS } = await import('./scenePrefs.ts')

// Node has no DOM: just enough of one for mountSceneToggles (and icons.ts), plus recorders for listeners outside it.
class El {
  tag: string
  children: El[] = []
  parent: El | null = null
  className = ''
  textContent = ''
  title = ''
  type = ''
  hidden = false
  classList = { add: (): void => {} } // icons.ts marks its svg
  style = { setProperty: (): void => {} }
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
  document: {
    createElement: (tag: string) => new El(tag),
    createElementNS: (_ns: string, tag: string) => new El(tag),
    addEventListener: (t: string) => outside.push(`document:${t}`),
  },
  window: { addEventListener: (t: string) => outside.push(`window:${t}`) },
})

const all = (el: El): El[] => [el, ...el.children.flatMap(all)]
const text = (el: El): string => el.textContent + el.children.map(text).join('')

function mount(prefs: ScenePrefs) {
  const root = new El('div')
  const changes: ScenePrefs[] = []
  const t = mountSceneToggles(root as unknown as HTMLElement, { prefs, onChange: (next) => changes.push(next) })
  const sw = (label: string): El => all(root).find((e) => e.attrs.role === 'switch' && e.attrs['aria-label'] === label)!
  const [topo, light, glass] = ['3-D terrain', 'Sun', 'See-through buildings'].map(sw)
  const checked = (): [string, string, string] => [topo.attrs['aria-checked'], light.attrs['aria-checked'], glass.attrs['aria-checked']]
  const note = all(root).find((e) => e.className === 'fh-scene-note')!
  const spinner = all(root).find((e) => e.className === 'fh-spin')!
  const [roads, wx] = ['Roads & places', 'Weather'].map(sw)
  const [mapB, satB, lightB, darkB] = all(root).filter((e) => e.className === 'fh-seg-b')
  const theme = all(root).find((e) => e.attrs['aria-label'] === 'Map theme')!
  const wxLine = all(root).find((e) => e.className === 'fh-wx-line')!
  const wxMore = all(root).find((e) => e.className === 'fh-wx-more')!
  const view = all(root).find((e) => e.className === 'fh-scene-view')!
  return { root, topo, light, glass, roads, wx, mapB, satB, lightB, darkB, theme, wxLine, wxMore, view, t, changes, checked, note, spinner }
}

test('switch rows: Roads (R), Weather (W), 3-D terrain (T), Sun (L), See-through buildings (X), real buttons with a label each', () => {
  const { root, topo, light, glass } = mount({ ...DEFAULT_PREFS, topo: true, light: true, glass: false })
  const rows = all(root).filter((e) => e.className === 'fh-scene-row')
  assert.deepEqual(rows.map((r) => text(r.children[1])), [
    'Roads & placesRRoads, streets and city names over the satellite',
    'WeatherWRain radar, airport flight rules and wind, SIGMETs',
    '3-D terrainTMountains and valleys in relief',
    'SunLReal sun and moon light, day and night',
    'See-through buildingsXBuildings glassy, so they never hide the aircraft',
  ])
  for (const b of [topo, light, glass]) {
    assert.equal(b.tag, 'button')
    assert.equal(b.type, 'button') // never a form submit; Enter and Space work as on any button
    assert.equal(b.className, 'fh-switch')
  }
  assert.deepEqual([topo, light, glass].map((b) => b.attrs['aria-label']), ['3-D terrain', 'Sun', 'See-through buildings'])
})

test('See-through asks for glass toggled and keeps the others', () => {
  const { glass, changes } = mount({ ...DEFAULT_PREFS, topo: false, light: true, glass: false })
  glass.click()
  assert.deepEqual(changes, [{ ...DEFAULT_PREFS, topo: false, light: true, glass: true }])
})

test('aria-checked shows the prefs it was mounted with', () => {
  assert.deepEqual(mount({ ...DEFAULT_PREFS, topo: true, light: true, glass: false }).checked(), ['true', 'true', 'false'])
  assert.deepEqual(mount({ ...DEFAULT_PREFS, topo: false, light: true, glass: true }).checked(), ['false', 'true', 'true'])
  assert.deepEqual(mount({ ...DEFAULT_PREFS, topo: true, light: false, glass: false }).checked(), ['true', 'false', 'false'])
})

test('a click asks for the toggled copy and changes nothing itself: the app answers with update()', () => {
  const prefs = { ...DEFAULT_PREFS, topo: true, light: true, glass: false }
  const { topo, light, changes, checked } = mount(prefs)
  topo.click()
  assert.deepEqual(changes, [{ ...DEFAULT_PREFS, topo: false, light: true, glass: false }])
  assert.notEqual(changes[0], prefs)
  assert.deepEqual(prefs, { ...DEFAULT_PREFS, topo: true, light: true, glass: false }) // the caller's object is not touched
  assert.deepEqual(checked(), ['true', 'true', 'false']) // not until update()
  light.click()
  assert.deepEqual(changes[1], { ...DEFAULT_PREFS, topo: true, light: false, glass: false }) // still from the mounted prefs
})

test('update() only re-renders: no onChange, and the next click toggles from the new prefs', () => {
  const { topo, light, t, changes, checked } = mount({ ...DEFAULT_PREFS, topo: true, light: true, glass: false })
  t.update({ ...DEFAULT_PREFS, topo: false, light: true, glass: false })
  assert.deepEqual(checked(), ['false', 'true', 'false'])
  assert.equal(changes.length, 0)
  topo.click()
  assert.deepEqual(changes, [{ ...DEFAULT_PREFS, topo: true, light: true, glass: false }])
  const p = { ...DEFAULT_PREFS, topo: false, light: false, glass: false }
  t.update(p)
  assert.deepEqual(checked(), ['false', 'false', 'false'])
  p.topo = true // a caller reusing its object later does not change what the panel holds
  light.click()
  assert.deepEqual(changes[1], { ...DEFAULT_PREFS, topo: false, light: true, glass: false })
})

test('update() with unchanged prefs writes nothing (cheap to call every frame)', () => {
  const { topo, light, glass, t } = mount({ ...DEFAULT_PREFS, topo: true, light: false, glass: false })
  const writes = (): number => topo.attrWrites + light.attrWrites + glass.attrWrites
  const before = writes()
  for (let i = 0; i < 100; i++) t.update({ ...DEFAULT_PREFS, topo: true, light: false, glass: false })
  assert.equal(writes(), before)
  t.update({ ...DEFAULT_PREFS, topo: true, light: true, glass: false })
  assert.equal(writes(), before + 1) // only the switch that changed
})

test('setBusy shows the spinner on the terrain row; setChasing hides the "applies in the chase" note', () => {
  const { t, spinner, note } = mount({ ...DEFAULT_PREFS, topo: true, light: true, glass: false })
  assert.equal(spinner.hidden, true)
  t.setBusy(true)
  assert.equal(spinner.hidden, false)
  t.setBusy(false)
  assert.equal(spinner.hidden, true)
  assert.equal(note.hidden, false)
  assert.match(note.textContent, /3-D chase view/)
  t.setChasing(true)
  assert.equal(note.hidden, true)
  t.setChasing(false)
  assert.equal(note.hidden, false)
})

test('keys and storage belong to the app: no listeners outside the panel', () => {
  outside.length = 0
  const { topo, t } = mount({ ...DEFAULT_PREFS, topo: true, light: true, glass: false })
  topo.click()
  t.update({ ...DEFAULT_PREFS, topo: false, light: true, glass: false })
  assert.deepEqual(outside, [])
})

test('destroy removes the rows and the note; twice is harmless', () => {
  const { root, t } = mount({ ...DEFAULT_PREFS, topo: true, light: true, glass: false })
  t.destroy()
  assert.equal(root.children.length, 0)
  t.destroy()
  assert.equal(root.children.length, 0)
})

test('the base picker sets the pref of the view on screen: mapTop top-down, mapChase in the chase', () => {
  const { mapB, satB, view, t, changes } = mount({ ...DEFAULT_PREFS })
  assert.deepEqual([mapB.attrs['aria-pressed'], satB.attrs['aria-pressed'], view.textContent], ['true', 'false', 'Top-down view'])
  mapB.click() // already the map: nothing to ask
  assert.equal(changes.length, 0)
  satB.click()
  assert.deepEqual(changes.at(-1), { ...DEFAULT_PREFS, mapTop: false })
  t.setChasing(true) // the chase has the satellite by default
  assert.deepEqual([mapB.attrs['aria-pressed'], satB.attrs['aria-pressed'], view.textContent], ['false', 'true', 'Chase view'])
  mapB.click()
  assert.deepEqual(changes.at(-1), { ...DEFAULT_PREFS, mapChase: true })
  t.update({ ...DEFAULT_PREFS, mapChase: true })
  assert.equal(mapB.attrs['aria-pressed'], 'true')
})

test('the map theme, Light or Dark, shows under Map only and sets dark for both views', () => {
  const { lightB, darkB, theme, satB, t, changes } = mount({ ...DEFAULT_PREFS })
  assert.deepEqual([theme.hidden, lightB.attrs['aria-pressed'], darkB.attrs['aria-pressed']], [false, 'true', 'false'])
  lightB.click() // already light
  assert.equal(changes.length, 0)
  darkB.click()
  assert.deepEqual(changes.at(-1), { ...DEFAULT_PREFS, dark: true })
  t.update({ ...DEFAULT_PREFS, dark: true })
  assert.deepEqual([lightB.attrs['aria-pressed'], darkB.attrs['aria-pressed']], ['false', 'true'])
  satB.click()
  t.update({ ...DEFAULT_PREFS, dark: true, mapTop: false })
  assert.equal(theme.hidden, true) // the satellite has no theme
  t.setChasing(true)
  t.update({ ...DEFAULT_PREFS, dark: true, mapTop: false, mapChase: true })
  assert.equal(theme.hidden, false)
})

test('weather: its legend shows while on, and setWeather writes the status line', () => {
  const { wx, wxMore, wxLine, t, changes } = mount({ ...DEFAULT_PREFS })
  assert.equal(wxMore.hidden, true)
  wx.click()
  assert.deepEqual(changes.at(-1), { ...DEFAULT_PREFS, wx: true })
  t.update({ ...DEFAULT_PREFS, wx: true })
  assert.equal(wxMore.hidden, false)
  assert.equal(wxLine.hidden, true)
  t.setWeather('Radar 12:00Z · 3 airports')
  assert.deepEqual([wxLine.hidden, wxLine.textContent], [false, 'Radar 12:00Z · 3 airports'])
  t.setWeather(null)
  assert.equal(wxLine.hidden, true)
})

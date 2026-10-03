// client/ui/sceneToggles.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { RAIN_PALETTE } from '../scene/radar.ts'
import { CATEGORY_COLOR, MODEL_CREDIT } from '../scene/wxText.ts'
import type { ScenePrefs } from '../types.ts'

// sceneToggles.ts imports its CSS for Vite. Node cannot load CSS, so this test process loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { mountSceneToggles, rainTheme } = await import('./sceneToggles.ts')
const { DEFAULT_PREFS } = await import('./scenePrefs.ts')

// Node has no DOM: just enough of one for mountSceneToggles (and icons.ts), plus recorders for listeners outside it.
class El {
  tag: string
  children: El[] = []
  parent: El | null = null
  className = ''
  #text = ''
  textWrites = 0
  title = ''
  type = ''
  href = ''
  target = ''
  rel = ''
  #hidden = false
  classList = { add: (): void => {} } // icons.ts marks its svg
  vars: Record<string, string> = {}
  styleWrites = 0
  style = {
    setProperty: (k: string, v: string): void => {
      this.styleWrites++
      this.vars[k] = v
    },
  }
  attrs: Record<string, string> = {}
  attrWrites = 0
  hiddenWrites = 0
  listeners = new Map<string, (() => void)[]>()
  constructor(tag: string) {
    this.tag = tag
  }
  get textContent(): string {
    return this.#text
  }
  set textContent(v: string) {
    this.textWrites++
    this.#clear() // as in the DOM: the text replaces what the element held
    this.#text = v
  }
  get hidden(): boolean {
    return this.#hidden
  }
  set hidden(v: boolean) {
    this.hiddenWrites++
    this.#hidden = v
  }
  append(...cs: El[]): void {
    for (const c of cs) {
      c.parent = this
      this.children.push(c)
    }
  }
  replaceChildren(...cs: (El | string)[]): void {
    this.#clear()
    this.append(...cs.map((c) => (typeof c === 'string' ? Object.assign(new El('#text'), { textContent: c }) : c)))
  }
  #clear(): void {
    this.#text = ''
    for (const c of this.children) c.parent = null
    this.children = []
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
/** What is on screen: the tree without its hidden parts. */
const visible = (el: El): El[] => (el.hidden ? [] : [el, ...el.children.flatMap(visible)])
/** The panel as it shows: section titles, button groups, switches and the weather's rain scale, legend and line, top to bottom. */
const PARTS: Record<string, string> = { 'fh-wx-rain': 'rain scale', 'fh-wx-legend': 'weather legend', 'fh-wx-line': 'weather line' }
const screen = (root: El): string[] => visible(root).flatMap((e) => {
  if (e.className === 'fh-scene-title') return [e.textContent]
  if (e.attrs.role === 'group' || e.attrs.role === 'switch') return [e.attrs['aria-label']]
  return PARTS[e.className] === undefined ? [] : [PARTS[e.className]]
})
const MAP = ['Map', 'Base map']
const SCENE = ['3-D scene', '3-D terrain', 'Sun', 'See-through buildings']

function mount(prefs: ScenePrefs) {
  const root = new El('div')
  const changes: ScenePrefs[] = []
  const t = mountSceneToggles(root as unknown as HTMLElement, { prefs, onChange: (next) => changes.push(next) })
  const sw = (label: string): El => all(root).find((e) => e.attrs.role === 'switch' && e.attrs['aria-label'] === label)!
  const [topo, light, glass] = ['3-D terrain', 'Sun', 'See-through buildings'].map(sw)
  const checked = (): [string, string, string] => [topo.attrs['aria-checked'], light.attrs['aria-checked'], glass.attrs['aria-checked']]
  const spinner = all(root).find((e) => e.className === 'fh-spin')!
  const [roads, places, wx] = ['Roads', 'Borders & places', 'Weather'].map(sw)
  const [mapB, satB, lightB, darkB] = all(root).filter((e) => e.className === 'fh-seg-b')
  const theme = all(root).find((e) => e.attrs['aria-label'] === 'Map theme')!
  const wxLine = all(root).find((e) => e.className === 'fh-wx-line')!
  const wxMore = all(root).find((e) => e.className === 'fh-wx-more')!
  const view = all(root).find((e) => e.className === 'fh-scene-view')!
  return { root, topo, light, glass, roads, places, wx, mapB, satB, lightB, darkB, theme, wxLine, wxMore, view, t, changes, checked, spinner }
}

test('switch rows: Roads (R), Borders & places (P), Weather (W), 3-D terrain (T), Sun (L), See-through buildings (X), real buttons with a label each', () => {
  const { root, topo, light, glass, roads, places, wx } = mount({ ...DEFAULT_PREFS, topo: true, light: true, glass: false })
  const rows = all(root).filter((e) => e.className === 'fh-scene-row')
  assert.deepEqual(rows.map((r) => text(r.children[1])), [
    'RoadsRStreets and highways over the satellite',
    'Borders & placesPCountry lines and city names over the satellite',
    'WeatherWRain radar, airport weather, hazard areas',
    '3-D terrainTMountains and valleys in relief',
    'SunLReal sun and moon light, day and night',
    'See-through buildingsXBuildings glassy, so they never hide the aircraft',
  ])
  for (const b of [roads, places, wx, topo, light, glass]) {
    assert.equal(b.tag, 'button')
    assert.equal(b.type, 'button') // never a form submit; Enter and Space work as on any button
    assert.equal(b.className, 'fh-switch')
  }
  assert.deepEqual([topo, light, glass].map((b) => b.attrs['aria-label']), ['3-D terrain', 'Sun', 'See-through buildings'])
})

test('only what applies to the view on screen: top-down or chase, on the map or the satellite', () => {
  const cases: [string, boolean, Partial<ScenePrefs>, string[]][] = [
    ['top-down, map', false, { mapTop: true }, [...MAP, 'Map theme', 'Weather']],
    ['top-down, satellite', false, { mapTop: false }, [...MAP, 'Roads', 'Borders & places', 'Weather']],
    ['chase, map', true, { mapChase: true }, [...MAP, 'Map theme', 'Weather', ...SCENE]],
    ['chase, satellite', true, { mapChase: false }, [...MAP, 'Roads', 'Borders & places', 'Weather', ...SCENE]],
  ]
  for (const [name, chasing, base, want] of cases) {
    const { root, t } = mount({ ...DEFAULT_PREFS, ...base })
    t.setChasing(chasing)
    assert.deepEqual(screen(root), want, name)
    assert.ok(all(root).every((e) => e.className !== 'fh-scene-note'), `${name}: no note`) // the 3-D scene shows in the chase only
  }
})

test('the rows follow the base and the view as they change: Satellite, the chase, Map there, and back', () => {
  const { root, satB, t, changes } = mount({ ...DEFAULT_PREFS })
  assert.deepEqual(screen(root), [...MAP, 'Map theme', 'Weather'])
  satB.click()
  assert.deepEqual(screen(root), [...MAP, 'Map theme', 'Weather'], 'not until the app answers')
  t.update(changes.at(-1)!)
  assert.deepEqual(screen(root), [...MAP, 'Roads', 'Borders & places', 'Weather'])
  t.setChasing(true) // the chase keeps its own base: the satellite by default
  assert.deepEqual(screen(root), [...MAP, 'Roads', 'Borders & places', 'Weather', ...SCENE])
  t.update({ ...DEFAULT_PREFS, mapTop: false, mapChase: true })
  assert.deepEqual(screen(root), [...MAP, 'Map theme', 'Weather', ...SCENE])
  t.setChasing(false)
  assert.deepEqual(screen(root), [...MAP, 'Roads', 'Borders & places', 'Weather'])
})

test('Roads and Borders & places: each switch shows and asks for its own pref', () => {
  const { roads, places, t, changes } = mount({ ...DEFAULT_PREFS, mapTop: false })
  assert.deepEqual([roads.attrs['aria-checked'], places.attrs['aria-checked']], ['false', 'true']) // the defaults
  roads.click()
  assert.deepEqual(changes.at(-1), { ...DEFAULT_PREFS, mapTop: false, roads: true })
  places.click()
  assert.deepEqual(changes.at(-1), { ...DEFAULT_PREFS, mapTop: false, places: false })
  t.update({ ...DEFAULT_PREFS, mapTop: false, roads: true, places: false })
  assert.deepEqual([roads.attrs['aria-checked'], places.attrs['aria-checked']], ['true', 'false'])
  places.click()
  assert.deepEqual(changes.at(-1), { ...DEFAULT_PREFS, mapTop: false, roads: true, places: true })
})

// .fh-seg and the rows are flex boxes, whose display beats the hidden attribute's own: the Light | Dark row stayed on the
// satellite until the panel's [hidden] won. CSS, so checked as text.
test('a hidden part of the panel really goes: there, [hidden] wins over the display of its rows and button groups', () => {
  const css = readFileSync(new URL('./sceneToggles.css', import.meta.url), 'utf8')
  assert.match(css, /\.fh-scene\[hidden\],\s*\.fh-scene \[hidden\] \{\s*display: none !important;\s*\}/)
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

test('update() and setChasing() with nothing changed write nothing (both run every frame)', () => {
  const { root, light, t } = mount({ ...DEFAULT_PREFS, topo: true, light: false, glass: false })
  const writes = (): number => all(root).reduce((n, e) => n + e.attrWrites + e.hiddenWrites + e.styleWrites + e.textWrites, 0)
  const before = writes()
  for (let i = 0; i < 100; i++) {
    t.update({ ...DEFAULT_PREFS, topo: true, light: false, glass: false })
    t.setChasing(false)
  }
  assert.equal(writes(), before)
  t.update({ ...DEFAULT_PREFS, topo: true, light: true, glass: false })
  assert.equal(writes(), before + 1) // only the switch that changed
  assert.equal(light.attrs['aria-checked'], 'true')
  t.setChasing(true)
  const chased = writes()
  for (let i = 0; i < 100; i++) t.setChasing(true)
  assert.equal(writes(), chased)
})

test('setBusy shows the spinner on the terrain row', () => {
  const { t, spinner } = mount({ ...DEFAULT_PREFS, topo: true, light: true, glass: false })
  assert.equal(spinner.hidden, true)
  t.setBusy(true)
  assert.equal(spinner.hidden, false)
  t.setBusy(false)
  assert.equal(spinner.hidden, true)
})

test('keys and storage belong to the app: no listeners outside the panel', () => {
  outside.length = 0
  const { topo, t } = mount({ ...DEFAULT_PREFS, topo: true, light: true, glass: false })
  topo.click()
  t.update({ ...DEFAULT_PREFS, topo: false, light: true, glass: false })
  assert.deepEqual(outside, [])
})

test('destroy removes both sections; twice is harmless', () => {
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
  t.setWeather('Radar 12:00 · 3 airports')
  assert.deepEqual([wxLine.hidden, wxLine.textContent], [false, 'Radar 12:00 · 3 airports'])
  t.setWeather(null)
  assert.equal(wxLine.hidden, true)
})

test('weather: Open-Meteo\'s credit in the line is a link to its site (its licence asks for one) while the credit is in the line; the rest of the line is text', () => {
  const { wxLine, t } = mount({ ...DEFAULT_PREFS, wx: true })
  const links = (): El[] => all(wxLine).filter((e) => e.tag === 'a')
  t.setWeather('Clouds from 3 airports · 2 hazard areas')
  assert.deepEqual(links(), [], 'no credit, no link')
  assert.equal(text(wxLine), 'Clouds from 3 airports · 2 hazard areas')
  const line = `Clouds from the forecast · 1 hazard area · ${MODEL_CREDIT} · some weather unavailable`
  t.setWeather(line)
  const [link] = links()
  assert.equal(links().length, 1)
  assert.deepEqual([link.href, link.target, link.rel, link.className, link.textContent], ['https://open-meteo.com/', '_blank', 'noopener noreferrer', 'fh-wx-credit', 'Weather data by Open-Meteo.com'])
  assert.deepEqual(wxLine.children.map((c) => [c.tag, c.textContent]), [['#text', 'Clouds from the forecast · 1 hazard area · '], ['a', 'Weather data by Open-Meteo.com'], ['#text', ' · some weather unavailable']])
  assert.equal(text(wxLine), line, 'it reads as the one line')
  t.setWeather(line)
  assert.equal(links()[0], link, 'the same line again writes nothing')
  t.setWeather('Clouds from 3 airports · 2 hazard areas · some weather unavailable') // the grid is gone, and its credit
  assert.deepEqual(links(), [])
  assert.equal(text(wxLine), 'Clouds from 3 airports · 2 hazard areas · some weather unavailable')
  t.setWeather(MODEL_CREDIT)
  assert.deepEqual(links().map((l) => [l.href, l.textContent]), [['https://open-meteo.com/', 'Weather data by Open-Meteo.com']], 'the credit alone is the link')
  assert.equal(text(wxLine), 'Weather data by Open-Meteo.com')
  t.setWeather(null)
  assert.deepEqual(visible(wxLine), [], 'no line: no link on screen')
})

// The class the link carries (checked above) is styled in the panel's CSS, so checked as text, as the [hidden] rule is.
test('the credit link looks like the rest of the line: its colour, underlined on hover only', () => {
  const css = readFileSync(new URL('./sceneToggles.css', import.meta.url), 'utf8')
  assert.match(css, /\.fh-wx-credit \{\s*color: inherit;\s*text-decoration: none;\s*\}/)
  assert.match(css, /\.fh-wx-credit:hover \{\s*text-decoration: underline;\s*\}/)
})

test('weather legend: the word Airports, then how the flight rules read, each in its colour', () => {
  const { root, wxMore } = mount({ ...DEFAULT_PREFS, wx: true })
  const legend = all(wxMore).find((e) => e.className === 'fh-wx-legend')!
  assert.deepEqual(legend.children.map((e) => [e.className, e.textContent]), [
    ['fh-wx-legend-title', 'Airports'], ['fh-wx-cat', 'Good'], ['fh-wx-cat', 'Marginal'], ['fh-wx-cat', 'Poor'], ['fh-wx-cat', 'Very poor'],
  ])
  const colors = all(root).filter((e) => e.className === 'fh-wx-cat').map((e) => e.vars['--c'])
  assert.deepEqual(colors, [CATEGORY_COLOR.VFR, CATEGORY_COLOR.MVFR, CATEGORY_COLOR.IFR, CATEGORY_COLOR.LIFR]) // as the markers' rings
})

test('weather has a row in both views; its rain scale and airports legend are the top-down map\'s, its status line is both\'s', () => {
  const { root, t } = mount({ ...DEFAULT_PREFS, wx: true })
  t.setWeather('Live only')
  assert.deepEqual(screen(root), [...MAP, 'Map theme', 'Weather', 'rain scale', 'weather legend', 'weather line'])
  t.setChasing(true) // on the satellite, the chase's default
  assert.deepEqual(screen(root), [...MAP, 'Roads', 'Borders & places', 'Weather', 'weather line', ...SCENE]) // the line stays: the chase's weather writes it
  t.setWeather('Clouds from 3 airports · 2 hazard areas')
  assert.equal(all(root).find((e) => e.className === 'fh-wx-line')!.textContent, 'Clouds from 3 airports · 2 hazard areas')
  t.setWeather(null)
  assert.deepEqual(screen(root), [...MAP, 'Roads', 'Borders & places', 'Weather', ...SCENE])
  t.setChasing(false)
  assert.deepEqual(screen(root), [...MAP, 'Map theme', 'Weather', 'rain scale', 'weather legend'])
})

test('weather off: nothing under its row in either view', () => {
  const { root, t } = mount({ ...DEFAULT_PREFS, wx: false })
  t.setWeather('Live only')
  assert.deepEqual(screen(root), [...MAP, 'Map theme', 'Weather'])
  t.setChasing(true)
  assert.deepEqual(screen(root), [...MAP, 'Roads', 'Borders & places', 'Weather', ...SCENE])
})

test('the weather row\'s hint follows the view: radar and airports top-down, clouds, rain and hazard areas round the aircraft in the chase', () => {
  const { root, wx, t, changes } = mount({ ...DEFAULT_PREFS })
  const row = (): El => all(root).filter((e) => e.className === 'fh-scene-row')[2]
  const hint = (): string => text(row().children[1])
  assert.equal(hint(), 'WeatherWRain radar, airport weather, hazard areas')
  t.setChasing(true)
  assert.equal(hint(), 'WeatherWClouds, rain and hazard areas around the aircraft')
  assert.equal(row().children.at(-1), wx) // the same switch: nothing was rebuilt, so the focus stays
  wx.click() // key W and the switch ask for the same pref in the chase as on the map
  assert.deepEqual(changes.at(-1), { ...DEFAULT_PREFS, wx: true })
  t.setChasing(false)
  assert.equal(hint(), 'WeatherWRain radar, airport weather, hazard areas')
})

test('weather: a rain scale above the airports legend, Light to Heavy, in the radar\'s colours for the map on screen', () => {
  const { wxMore, t } = mount({ ...DEFAULT_PREFS, wx: true })
  assert.deepEqual(wxMore.children.map((e) => e.className), ['fh-wx-rain', 'fh-wx-legend', 'fh-wx-line'])
  const [rain] = wxMore.children
  assert.deepEqual(rain.children.map((e) => [e.className, e.textContent]), [['fh-wx-rain-end', 'Light'], ['fh-wx-scale', ''], ['fh-wx-rain-end', 'Heavy']])
  const scale = rain.children[1]
  const gradient = (theme: 'light' | 'dark'): string => `linear-gradient(90deg, ${RAIN_PALETTE[theme].rain.map(([r, g, b]) => `rgb(${r}, ${g}, ${b})`).join(', ')})`
  assert.equal(scale.vars['--scale'], gradient('light')) // the light street map
  t.update({ ...DEFAULT_PREFS, wx: true, dark: true })
  assert.equal(scale.vars['--scale'], gradient('dark'))
  t.update({ ...DEFAULT_PREFS, wx: true, mapTop: false })
  assert.equal(scale.vars['--scale'], gradient('dark'), 'the satellite: dark under the rain')
  t.update({ ...DEFAULT_PREFS, wx: true })
  assert.equal(scale.vars['--scale'], gradient('light'))
  assert.equal(RAIN_PALETTE.light.rain.length, 11)
  t.setChasing(true) // the chase's base (the satellite) is not the weather's
  assert.equal(scale.vars['--scale'], gradient('light'))
})

test('rainTheme: the top-down map\'s base decides (the radar is drawn there only): light over the light street map, else dark', () => {
  assert.equal(rainTheme(DEFAULT_PREFS), 'light')
  assert.equal(rainTheme({ ...DEFAULT_PREFS, dark: true }), 'dark')
  assert.equal(rainTheme({ ...DEFAULT_PREFS, mapTop: false }), 'dark')
  assert.equal(rainTheme({ ...DEFAULT_PREFS, mapChase: true }), 'light') // the chase's base changes nothing
  assert.equal(rainTheme({ ...DEFAULT_PREFS, mapTop: false, mapChase: true }), 'dark')
})

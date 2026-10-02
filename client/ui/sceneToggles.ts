// client/ui/sceneToggles.ts
// The Layers panel (the square under the rail): only what applies to the view on screen. Map: the base for that view,
// Map or Satellite (M; the top-down view and the chase each keep their own); under Map its theme, Light or Dark (both
// views; Settings › Display too); under Satellite, Roads (R) and Borders & places (P) over it; on the top-down map,
// Weather (W). In the chase, the 3-D scene (design D11): a switch row each for 3-D terrain (T), Sun (L) and See-through
// buildings (X). Each row has its icon and key. A click asks the app for the toggled prefs through onChange and changes
// nothing itself; update() only re-renders. A view or base change hides and shows rows (none is rebuilt, so the focus
// stays put). setBusy(true) shows a spinner on the terrain row while the relief grows or sinks; setWeather() shows what
// the weather layer holds. The app owns the keys, the stored prefs and the panel.
import { icon, type IconName } from './icons.ts'
import { CATEGORY_COLOR } from '../scene/wxText.ts'
import type { ScenePrefs } from '../types.ts'
import './sceneToggles.css'

export interface SceneTogglesOpts {
  prefs: ScenePrefs
  onChange(next: ScenePrefs): void
}

export interface SceneTogglesHandle {
  update(prefs: ScenePrefs): void
  setBusy(busy: boolean): void // the relief is animating
  setChasing(chasing: boolean): void // the base picker and the rows follow the view
  setWeather(text: string | null): void // a line under the weather row: what it shows, or why not
  destroy(): void
}

type Key = Exclude<keyof ScenePrefs, 'mapTop' | 'mapChase' | 'dark'>
interface Row { key: Key; icon: IconName; label: string; hint: string; shortcut: string }
const LAYER_ROWS: Row[] = [
  { key: 'roads', icon: 'road', label: 'Roads', hint: 'Streets and highways over the satellite', shortcut: 'R' },
  { key: 'places', icon: 'flag', label: 'Borders & places', hint: 'Country lines and city names over the satellite', shortcut: 'P' },
  { key: 'wx', icon: 'cloud', label: 'Weather', hint: 'Rain radar, airport weather, hazard areas', shortcut: 'W' },
]
const SCENE_ROWS: Row[] = [
  { key: 'topo', icon: 'mountain', label: '3-D terrain', hint: 'Mountains and valleys in relief', shortcut: 'T' },
  { key: 'light', icon: 'sun', label: 'Sun', hint: 'Real sun and moon light, day and night', shortcut: 'L' },
  { key: 'glass', icon: 'building', label: 'See-through buildings', hint: 'Buildings glassy, so they never hide the aircraft', shortcut: 'X' },
]
const ROWS = [...LAYER_ROWS, ...SCENE_ROWS]
// How the weather reads at an airport (VFR to LIFR), in the colours of its markers' rings (wxText.ts).
const CATEGORIES: [string, string][] = [['Good', CATEGORY_COLOR.VFR], ['Marginal', CATEGORY_COLOR.MVFR], ['Poor', CATEGORY_COLOR.IFR], ['Very poor', CATEGORY_COLOR.LIFR]]

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = className
  if (text !== '') el.textContent = text
  return el
}

/** The base-map pref the view on screen uses. */
export const baseKey = (chasing: boolean): 'mapTop' | 'mapChase' => (chasing ? 'mapChase' : 'mapTop')

export function mountSceneToggles(root: HTMLElement, opts: SceneTogglesOpts): SceneTogglesHandle {
  let prefs = { ...opts.prefs }
  let chasing = false
  const switches = new Map<Key, HTMLButtonElement>()
  let spinner: HTMLElement | null = null

  const row = (r: Row): HTMLElement => {
    const el = h('div', 'fh-scene-row')
    const ic = h('span', 'fh-scene-icon')
    ic.append(icon(r.icon, 18))
    const text = h('div', 'fh-scene-text')
    const label = h('span', 'fh-scene-label', r.label)
    label.append(h('kbd', 'fh-kbd', r.shortcut))
    text.append(label, h('span', 'fh-scene-hint', r.hint))
    const sw = h('button', 'fh-switch')
    sw.type = 'button'
    sw.setAttribute('role', 'switch')
    sw.setAttribute('aria-checked', String(prefs[r.key]))
    sw.setAttribute('aria-label', r.label)
    sw.addEventListener('click', () => opts.onChange({ ...prefs, [r.key]: !prefs[r.key] }))
    el.addEventListener('click', (e) => e.target !== sw && sw.click()) // the whole row is the target (a finger's too)
    if (r.key === 'topo') {
      spinner = h('span', 'fh-spin')
      spinner.hidden = true
      el.append(ic, text, spinner, sw)
    } else el.append(ic, text, sw)
    switches.set(r.key, sw)
    return el
  }

  // Map: the base picker, then the layer rows.
  const layers = h('div', 'fh-scene')
  const baseHead = h('div', 'fh-scene-head')
  const baseTitle = h('span', 'fh-scene-title', 'Map')
  const baseView = h('span', 'fh-scene-view')
  baseTitle.append(h('kbd', 'fh-kbd', 'M'))
  baseHead.append(baseTitle, baseView)
  const seg = h('div', 'fh-seg')
  seg.setAttribute('role', 'group')
  seg.setAttribute('aria-label', 'Base map')
  const segBtn = (into: HTMLElement, text: string, key: () => 'mapTop' | 'mapChase' | 'dark', on: boolean): HTMLButtonElement => {
    const b = h('button', 'fh-seg-b', text)
    b.type = 'button'
    b.addEventListener('click', () => prefs[key()] !== on && opts.onChange({ ...prefs, [key()]: on }))
    into.append(b)
    return b
  }
  const mapBtn = segBtn(seg, 'Map', () => baseKey(chasing), true)
  const satBtn = segBtn(seg, 'Satellite', () => baseKey(chasing), false)
  // The street map's theme, only while the view shows the map.
  const theme = h('div', 'fh-seg')
  theme.setAttribute('role', 'group')
  theme.setAttribute('aria-label', 'Map theme')
  const lightBtn = segBtn(theme, 'Light', () => 'dark', false)
  const darkBtn = segBtn(theme, 'Dark', () => 'dark', true)
  const showBase = (): void => {
    const map = prefs[baseKey(chasing)]
    mapBtn.setAttribute('aria-pressed', String(map))
    satBtn.setAttribute('aria-pressed', String(!map))
    lightBtn.setAttribute('aria-pressed', String(!prefs.dark))
    darkBtn.setAttribute('aria-pressed', String(prefs.dark))
    baseView.textContent = chasing ? 'Chase view' : 'Top-down view'
  }
  showBase()
  // The overlays, only while the view shows the satellite; the weather, only on the top-down map (the chase draws none).
  const [roadsRow, placesRow, wxRow] = LAYER_ROWS.map(row)
  const wxMore = h('div', 'fh-wx-more')
  const legend = h('div', 'fh-wx-legend')
  legend.append(h('span', 'fh-wx-legend-title', 'Airports'))
  for (const [cat, color] of CATEGORIES) {
    const k = h('span', 'fh-wx-cat', cat)
    k.style.setProperty('--c', color)
    legend.append(k)
  }
  const wxLine = h('p', 'fh-wx-line')
  wxLine.hidden = true
  wxMore.append(legend, wxLine)
  layers.append(baseHead, seg, theme, roadsRow, placesRow, wxRow, wxMore)

  // 3-D scene: the chase's only.
  const scene = h('div', 'fh-scene')
  const sceneHead = h('div', 'fh-scene-head')
  sceneHead.append(h('span', 'fh-scene-title', '3-D scene'))
  scene.append(sceneHead, ...SCENE_ROWS.map(row))
  root.append(layers, scene)

  /** Shows el or hides it, writing only a change (update and setChasing run every frame). */
  const show = (el: HTMLElement, on: boolean): void => {
    if (el.hidden === on) el.hidden = !on
  }
  /** The rows that apply to the view on screen and its base. */
  const fit = (): void => {
    const map = prefs[baseKey(chasing)]
    show(theme, map)
    show(roadsRow, !map)
    show(placesRow, !map)
    show(wxRow, !chasing)
    show(wxMore, !chasing && prefs.wx)
    show(scene, chasing)
  }
  fit()

  return {
    update(next) {
      for (const r of ROWS) {
        if (next[r.key] !== prefs[r.key]) switches.get(r.key)!.setAttribute('aria-checked', String(next[r.key]))
      }
      const base = next[baseKey(chasing)] !== prefs[baseKey(chasing)] || next.dark !== prefs.dark
      prefs = { ...next }
      if (base) showBase()
      fit()
    },
    setBusy(busy) {
      if (spinner && spinner.hidden === busy) spinner.hidden = !busy
    },
    setChasing(on) {
      if (on === chasing) return
      chasing = on
      showBase()
      fit()
    },
    setWeather(text) {
      if (wxLine.hidden !== (text === null)) wxLine.hidden = text === null
      if (text !== null && wxLine.textContent !== text) wxLine.textContent = text
    },
    destroy() {
      layers.remove()
      scene.remove()
    },
  }
}

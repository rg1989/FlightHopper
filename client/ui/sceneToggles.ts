// client/ui/sceneToggles.ts
// The Layers panel (the square under the rail). Map: the base for the view on screen, Map or Satellite (M; the top-down
// view and the chase each keep their own), Roads & places over the satellite (R), Weather on the top-down map (W).
// 3-D scene (design D11): a switch row each for 3-D terrain (T), Sun (L) and See-through buildings (X). Each row has
// its icon and key. A click asks the app for the toggled prefs through onChange and changes nothing itself; update()
// only re-renders. setBusy(true) shows a spinner on the terrain row while the relief grows or sinks; setWeather() shows
// what the weather layer holds. The app owns the keys, the stored prefs and the panel.
import { icon, type IconName } from './icons.ts'
import type { ScenePrefs } from '../types.ts'
import './sceneToggles.css'

export interface SceneTogglesOpts {
  prefs: ScenePrefs
  onChange(next: ScenePrefs): void
}

export interface SceneTogglesHandle {
  update(prefs: ScenePrefs): void
  setBusy(busy: boolean): void // the relief is animating
  setChasing(chasing: boolean): void // the base picker follows the view; the 3-D rows' hint shows in the top-down view
  setWeather(text: string | null): void // a line under the weather row: what it shows, or why not
  destroy(): void
}

type Key = Exclude<keyof ScenePrefs, 'mapTop' | 'mapChase'>
interface Row { key: Key; icon: IconName; label: string; hint: string; shortcut: string }
const LAYER_ROWS: Row[] = [
  { key: 'roads', icon: 'road', label: 'Roads & places', hint: 'Roads, streets and city names over the satellite', shortcut: 'R' },
  { key: 'wx', icon: 'cloud', label: 'Weather', hint: 'Rain radar, airport flight rules and wind, SIGMETs', shortcut: 'W' },
]
const SCENE_ROWS: Row[] = [
  { key: 'topo', icon: 'mountain', label: '3-D terrain', hint: 'Mountains and valleys in relief', shortcut: 'T' },
  { key: 'light', icon: 'sun', label: 'Sun', hint: 'Real sun and moon light, day and night', shortcut: 'L' },
  { key: 'glass', icon: 'building', label: 'See-through buildings', hint: 'Buildings glassy, so they never hide the aircraft', shortcut: 'X' },
]
const ROWS = [...LAYER_ROWS, ...SCENE_ROWS]
// Flight rules at an airport (weather.ts draws the dots in these colours).
const CATEGORIES: [string, string][] = [['VFR', '#3ddc84'], ['MVFR', '#4f9dff'], ['IFR', '#ff5a5a'], ['LIFR', '#e05cff']]

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
  const segBtn = (text: string, map: boolean): HTMLButtonElement => {
    const b = h('button', 'fh-seg-b', text)
    b.type = 'button'
    b.addEventListener('click', () => prefs[baseKey(chasing)] !== map && opts.onChange({ ...prefs, [baseKey(chasing)]: map }))
    seg.append(b)
    return b
  }
  const mapBtn = segBtn('Map', true)
  const satBtn = segBtn('Satellite', false)
  const showBase = (): void => {
    const map = prefs[baseKey(chasing)]
    mapBtn.setAttribute('aria-pressed', String(map))
    satBtn.setAttribute('aria-pressed', String(!map))
    baseView.textContent = chasing ? 'Chase view' : 'Top-down view'
  }
  showBase()
  const roadsRow = row(LAYER_ROWS[0])
  const wxRow = row(LAYER_ROWS[1])
  const wxMore = h('div', 'fh-wx-more')
  const legend = h('div', 'fh-wx-legend')
  for (const [cat, color] of CATEGORIES) {
    const k = h('span', 'fh-wx-cat', cat)
    k.style.setProperty('--c', color)
    legend.append(k)
  }
  const wxLine = h('p', 'fh-wx-line')
  wxLine.hidden = true
  wxMore.append(legend, wxLine)
  wxMore.hidden = !prefs.wx
  layers.append(baseHead, seg, roadsRow, wxRow, wxMore)

  // 3-D scene.
  const scene = h('div', 'fh-scene')
  const sceneHead = h('div', 'fh-scene-head')
  sceneHead.append(h('span', 'fh-scene-title', '3-D scene'))
  const note = h('p', 'fh-scene-note')
  note.textContent = 'These apply in the 3-D chase view: pick an aircraft, then press Chase.'
  scene.append(sceneHead, note, ...SCENE_ROWS.map(row))
  root.append(layers, scene)

  return {
    update(next) {
      for (const r of ROWS) {
        if (next[r.key] !== prefs[r.key]) switches.get(r.key)!.setAttribute('aria-checked', String(next[r.key]))
      }
      const base = next[baseKey(chasing)] !== prefs[baseKey(chasing)]
      if (next.wx !== prefs.wx) wxMore.hidden = !next.wx
      prefs = { ...next }
      if (base) showBase()
    },
    setBusy(busy) {
      if (spinner && spinner.hidden === busy) spinner.hidden = !busy
    },
    setChasing(on) {
      if (note.hidden !== on) note.hidden = on
      if (on === chasing) return
      chasing = on
      showBase()
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

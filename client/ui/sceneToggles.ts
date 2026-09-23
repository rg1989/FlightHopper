// client/ui/sceneToggles.ts
// The Scene panel (design D11): a switch row each for 3-D terrain (T), Sun (L) and See-through buildings (X), with its
// icon and key. A click asks the app for the toggled prefs through onChange and changes nothing itself; update() only
// re-renders. setBusy(true) shows a spinner on the terrain row while the relief grows or sinks. The app owns the keys,
// the stored prefs and the panel.
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
  setChasing(chasing: boolean): void // the switches apply in the 3-D view; the hint says so in browse
  destroy(): void
}

type Key = keyof ScenePrefs
const ROWS: { key: Key; icon: IconName; label: string; hint: string; shortcut: string }[] = [
  { key: 'topo', icon: 'mountain', label: '3-D terrain', hint: 'Mountains and valleys in relief', shortcut: 'T' },
  { key: 'light', icon: 'sun', label: 'Sun', hint: 'Real sun and moon light, day and night', shortcut: 'L' },
  { key: 'glass', icon: 'building', label: 'See-through buildings', hint: 'Buildings glassy, so they never hide the aircraft', shortcut: 'X' },
]

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = className
  if (text !== '') el.textContent = text
  return el
}

export function mountSceneToggles(root: HTMLElement, opts: SceneTogglesOpts): SceneTogglesHandle {
  let prefs = { ...opts.prefs }
  const list = h('div', 'fh-scene')
  const note = h('p', 'fh-scene-note')
  note.textContent = 'These apply in the 3-D chase view: pick an aircraft, then press Chase.'
  const switches = new Map<Key, HTMLButtonElement>()
  let spinner: HTMLElement | null = null
  for (const r of ROWS) {
    const row = h('div', 'fh-scene-row')
    const ic = h('span', 'fh-scene-icon')
    ic.append(icon(r.icon, 18))
    const text = h('div', 'fh-scene-text')
    const label = h('span', 'fh-scene-label', r.label)
    const kbd = h('kbd', 'fh-kbd', r.shortcut)
    label.append(kbd)
    text.append(label, h('span', 'fh-scene-hint', r.hint))
    const sw = h('button', 'fh-switch')
    sw.type = 'button'
    sw.setAttribute('role', 'switch')
    sw.setAttribute('aria-checked', String(prefs[r.key]))
    sw.setAttribute('aria-label', r.label)
    sw.addEventListener('click', () => opts.onChange({ ...prefs, [r.key]: !prefs[r.key] }))
    if (r.key === 'topo') {
      spinner = h('span', 'fh-spin')
      spinner.hidden = true
      row.append(ic, text, spinner, sw)
    } else row.append(ic, text, sw)
    list.append(row)
    switches.set(r.key, sw)
  }
  root.append(note, list)

  return {
    update(next) {
      for (const r of ROWS) {
        if (next[r.key] !== prefs[r.key]) switches.get(r.key)!.setAttribute('aria-checked', String(next[r.key]))
      }
      prefs = { ...next }
    },
    setBusy(busy) {
      if (spinner && spinner.hidden === busy) spinner.hidden = !busy
    },
    setChasing(chasing) {
      if (note.hidden !== chasing) note.hidden = chasing
    },
    destroy() {
      list.remove()
      note.remove()
    },
  }
}

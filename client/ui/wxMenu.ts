// client/ui/wxMenu.ts
// The Weather panel (a square of its own under the Layers square, there while the chase's weather is drawn): Clouds, in three looks
// (natural, severity colours, blocks) with the severity scale's four colours under them; Hazard areas, in three styles (curtain, fence,
// box); Looking ahead, a switch row each for the track line, the level slice and the ahead strip. It is the Layers panel's look
// (sceneToggles.css: its segments, rows and switches). A click asks the app for the changed prefs through onChange and changes nothing
// itself; update() only re-renders, so the app is the one place the choices are applied and stored (wxPrefs.ts).
import { icon, type IconName } from './icons.ts'
import { SEV_COLOR } from '../scene/wxAhead.ts'
import type { CloudLook, HazardStyle } from '../scene/cloudVolume.ts'
import type { WxPrefs } from './wxPrefs.ts'
import './sceneToggles.css'
import './wxMenu.css'

export interface WxMenuOpts {
  prefs: WxPrefs
  onChange(next: WxPrefs): void
}

export interface WxMenuHandle {
  update(prefs: WxPrefs): void
  destroy(): void
}

const LOOKS: [CloudLook, string][] = [['natural', 'Natural'], ['severity', 'Severity colours'], ['blocks', 'Blocks']]
const HAZARDS: [HazardStyle, string][] = [['curtain', 'Curtain'], ['fence', 'Fence'], ['box', 'Box']]
// The severity scale's names (wxAhead.ts SEV_COLOR is in this order), as a legend says them.
const LEGEND = ['Cloud', 'Light rain', 'Heavy rain', 'Thunderstorm']
interface Aid { key: 'track' | 'slice' | 'strip'; icon: IconName; label: string; hint: string }
const AIDS: Aid[] = [
  { key: 'track', icon: 'plane', label: 'Track line', hint: 'The next six minutes on this heading' },
  { key: 'slice', icon: 'layers', label: 'Level slice', hint: "The weather at the aircraft's own altitude" },
  { key: 'strip', icon: 'altitude', label: 'Ahead strip', hint: 'Side view of the next 80 km' },
]

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = className
  if (text !== '') el.textContent = text
  return el
}

export function mountWxMenu(root: HTMLElement, opts: WxMenuOpts): WxMenuHandle {
  let prefs = { ...opts.prefs }
  const segs: { key: 'look' | 'hazard'; value: string; b: HTMLButtonElement }[] = []
  const switches = new Map<Aid['key'], HTMLButtonElement>()

  const section = (title: string): HTMLElement => {
    const el = h('div', 'fh-scene')
    const head = h('div', 'fh-scene-head')
    head.append(h('span', 'fh-scene-title', title))
    el.append(head)
    return el
  }
  /** A button group: one choice of a field, asked for by its button (none when it is the one on). */
  const segment = <K extends 'look' | 'hazard'>(key: K, label: string, options: [WxPrefs[K], string][]): HTMLElement => {
    const el = h('div', 'fh-seg fh-wxm-seg')
    el.setAttribute('role', 'group')
    el.setAttribute('aria-label', label)
    for (const [value, text] of options) {
      const b = h('button', 'fh-seg-b', text)
      b.type = 'button'
      b.setAttribute('aria-pressed', String(prefs[key] === value))
      b.addEventListener('click', () => prefs[key] !== value && opts.onChange({ ...prefs, [key]: value }))
      el.append(b)
      segs.push({ key, value, b })
    }
    return el
  }
  const row = (a: Aid): HTMLElement => {
    const el = h('div', 'fh-scene-row')
    const ic = h('span', 'fh-scene-icon')
    ic.append(icon(a.icon, 18))
    const text = h('div', 'fh-scene-text')
    text.append(h('span', 'fh-scene-label', a.label), h('span', 'fh-scene-hint', a.hint))
    const sw = h('button', 'fh-switch')
    sw.type = 'button'
    sw.setAttribute('role', 'switch')
    sw.setAttribute('aria-checked', String(prefs[a.key]))
    sw.setAttribute('aria-label', a.label)
    sw.addEventListener('click', () => opts.onChange({ ...prefs, [a.key]: !prefs[a.key] }))
    el.addEventListener('click', (e) => e.target !== sw && sw.click()) // the whole row is the target (a finger's too)
    el.append(ic, text, sw)
    switches.set(a.key, sw)
    return el
  }

  const clouds = section('Clouds')
  const legend = h('div', 'fh-wx-legend fh-wxm-legend')
  LEGEND.forEach((name, i) => {
    const k = h('span', 'fh-wx-cat', name)
    k.style.setProperty('--c', SEV_COLOR[i])
    legend.append(k)
  })
  clouds.append(segment('look', 'Clouds', LOOKS), legend)
  const hazards = section('Hazard areas')
  hazards.append(segment('hazard', 'Hazard area style', HAZARDS))
  const ahead = section('Looking ahead')
  ahead.append(...AIDS.map(row))
  root.append(clouds, hazards, ahead)

  return {
    update(next) {
      for (const s of segs) if (next[s.key] !== prefs[s.key]) s.b.setAttribute('aria-pressed', String(next[s.key] === s.value))
      for (const [key, sw] of switches) if (next[key] !== prefs[key]) sw.setAttribute('aria-checked', String(next[key]))
      prefs = { ...next }
    },
    destroy() {
      clouds.remove()
      hazards.remove()
      ahead.remove()
    },
  }
}

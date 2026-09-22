// client/ui/hud.ts
// Bottom-left readout for the chased aircraft. The text and honesty tags come from format.ts; this file only builds DOM.
import type { StatusBrief } from '../../shared/api.ts'
import type { RenderState } from '../types.ts'
import { hudFields, hudTitle } from './format.ts'
import './ui.css'

const div = (className: string, text = ''): HTMLDivElement => {
  const el = document.createElement('div')
  el.className = className
  el.textContent = text
  return el
}

const span = (className: string, text: string): HTMLSpanElement => {
  const el = document.createElement('span')
  el.className = className
  el.textContent = text
  return el
}

export function mountHud(root: HTMLElement): { update(s: RenderState | null, status: StatusBrief): void; destroy(): void } {
  const el = div('fh-hud')
  el.hidden = true
  root.append(el)
  const legend = div('fh-hud-legend')
  legend.append(span('fh-observed', 'observed'), span('fh-derived', 'derived'), span('fh-stale', 'stale'))
  let last = ''

  return {
    update(s, status) {
      const title = s === null ? '' : hudTitle(s)
      const fields = hudFields(s, status)
      const key = title + JSON.stringify(fields)
      if (key === last) return // called every frame: touch the DOM only when the text changes
      last = key
      el.hidden = s === null
      // textContent only: callsigns come from upstream data and must never be parsed as HTML.
      const rows = fields.map((f) => {
        const r = div('fh-hud-row')
        r.append(span('fh-hud-label', f.label), span(`fh-hud-value fh-${f.tag}`, f.value))
        return r
      })
      el.replaceChildren(div('fh-hud-title', title), ...rows, legend)
    },
    destroy() {
      el.remove()
    },
  }
}

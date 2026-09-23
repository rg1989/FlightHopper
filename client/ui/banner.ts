// client/ui/banner.ts
// Top-centre status banner (provider trouble, lost signal, prediction) and the bottom-right attribution box.
import type { StatusBrief } from '../../shared/api.ts'
import type { RenderState } from '../types.ts'
import { attributionLines, bannerText } from './format.ts'
import './ui.css'

export function mountBanner(root: HTMLElement): { update(status: StatusBrief, s: RenderState | null): void; destroy(): void } {
  const el = document.createElement('div')
  el.className = 'fh-banner'
  el.setAttribute('role', 'status')
  el.hidden = true
  root.append(el)

  return {
    update(status, s) {
      const text = bannerText(status, s)
      el.hidden = text === null
      if (text !== null && el.textContent !== text) el.textContent = text
    },
    destroy() {
      el.remove()
    },
  }
}

/** Credit lines, bottom right. Always carries the "Not for navigation" line (added when the caller's lines lack it). */
export function mountAttribution(root: HTMLElement, lines: string[]): { set(lines: string[]): void } {
  const el = document.createElement('div')
  el.className = 'fh-attribution'
  root.append(el)
  const set = (next: string[]): void => {
    el.replaceChildren(
      ...attributionLines(next).map((line) => {
        const row = document.createElement('div')
        row.textContent = line
        return row
      }),
    )
  }
  set(lines)
  return { set }
}

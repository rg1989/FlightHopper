// client/ui/banner.ts
// A toast at the top centre for provider trouble only (rate-limited, blocked, down): the chased aircraft's own state
// (predicting, signal lost) lives in its flight card.
import type { StatusBrief } from '../../shared/api.ts'
import { bannerText } from './format.ts'
import './ui.css'

export function mountBanner(root: HTMLElement): { update(status: StatusBrief): void; destroy(): void } {
  const el = document.createElement('div')
  el.className = 'fh-toast fh-glass fh-blur'
  el.setAttribute('role', 'status')
  el.hidden = true
  const dot = document.createElement('span')
  dot.className = 'fh-dot'
  dot.dataset.state = 'trouble'
  const text = document.createElement('span')
  el.append(dot, text)
  root.append(el)

  return {
    update(status) {
      const t = bannerText(status, null)
      el.hidden = t === null
      if (t !== null && text.textContent !== t) text.textContent = t
    },
    destroy() {
      el.remove()
    },
  }
}

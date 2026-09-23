// client/ui/imageryBadge.ts
// Which imagery the globe shows, at the end of the scene toggles: green for Esri, amber when EOX stands in for it
// (no key, or Esri failed at runtime), grey for a source chosen on purpose. Text too, so the state is not colour alone.
import type { ImageryStatus } from '../scene/imagery.ts'
import './imageryBadge.css'

const NAMES: Record<ImageryStatus['source'], string> = { esri: 'Esri', eox: 'EOX', ion: 'Bing', none: 'none' }

export function badgeView(s: ImageryStatus): { text: string; title: string; state: 'ok' | 'fallback' | 'plain' } {
  const name = NAMES[s.source]
  if (s.fallback) return { text: `Imagery: ${name} · ${s.fallback}`, title: `Esri imagery is off (${s.fallback}), so this is EOX Sentinel-2 at 10 m`, state: 'fallback' }
  if (s.source === 'esri') return { text: `Imagery: ${name}`, title: 'Esri World Imagery (0.3 m at big airports)', state: 'ok' }
  return { text: `Imagery: ${name}`, title: `Imagery chosen by VITE_IMAGERY=${s.source}`, state: 'plain' }
}

export function mountImageryBadge(root: HTMLElement, s: ImageryStatus): { set(s: ImageryStatus): void } {
  const el = document.createElement('span')
  el.className = 'fh-imagery'
  el.setAttribute('role', 'status')
  const set = (next: ImageryStatus): void => {
    const v = badgeView(next)
    el.textContent = v.text
    el.title = v.title
    el.dataset.state = v.state
  }
  set(s)
  root.append(el)
  return { set }
}

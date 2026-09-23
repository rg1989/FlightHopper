// client/ui/imageryBadge.ts
// Which imagery the globe shows, for the Status panel: Esri, EOX standing in for it (no key, or Esri failed at
// runtime, with the reason), or a source chosen on purpose.
import type { ImageryStatus } from '../scene/imagery.ts'

const NAMES: Record<ImageryStatus['source'], string> = { esri: 'Esri', eox: 'EOX', ion: 'Bing', none: 'none' }

export function badgeView(s: ImageryStatus): { text: string; title: string; state: 'ok' | 'fallback' | 'plain' } {
  const name = NAMES[s.source]
  if (s.fallback) return { text: `Imagery: ${name} · ${s.fallback}`, title: `Esri imagery is off (${s.fallback}), so this is EOX Sentinel-2 at 10 m`, state: 'fallback' }
  if (s.source === 'esri') return { text: `Imagery: ${name}`, title: 'Esri World Imagery (0.3 m at big airports)', state: 'ok' }
  return { text: `Imagery: ${name}`, title: `Imagery chosen by VITE_IMAGERY=${s.source}`, state: 'plain' }
}

// client/ui/legend.ts
import { altitudeColor } from '../scene/altitudeColor.ts'

/** Tick altitudes, evenly spaced along the bar (the low end, where most colour change happens, gets more room). */
export const LEGEND_TICKS_FT: readonly number[] = [0, 1_000, 2_000, 4_000, 6_000, 8_000, 10_000, 20_000, 30_000, 40_000]
const SAMPLES_PER_GAP = 8 // CSS interpolates in RGB; sampling the HSL path keeps the bar true to the icons

/** '0', '1 000', …, '40 000+' (narrow no-break space between thousands). */
export function tickLabel(ft: number): string {
  const s = ft >= 1_000 ? `${Math.floor(ft / 1_000)} ${String(ft % 1_000).padStart(3, '0')}` : String(ft)
  return ft === LEGEND_TICKS_FT[LEGEND_TICKS_FT.length - 1] ? `${s}+` : s
}

/** The bar's CSS background: every tick at i/(n−1) of the width in its altitude colour, 8 samples per gap. */
export function legendGradient(): string {
  const n = LEGEND_TICKS_FT.length - 1
  const stops: string[] = []
  for (let i = 0; i < n; i++) {
    const a = LEGEND_TICKS_FT[i]
    const b = LEGEND_TICKS_FT[i + 1]
    for (let k = 0; k < SAMPLES_PER_GAP; k++) {
      const f = k / SAMPLES_PER_GAP
      stops.push(`${altitudeColor(a + (b - a) * f, false)} ${(((i + f) / n) * 100).toFixed(2)}%`)
    }
  }
  stops.push(`${altitudeColor(LEGEND_TICKS_FT[n], false)} 100.00%`)
  return `linear-gradient(to right, ${stops.join(', ')})`
}

function el(tag: string, className: string, style: Partial<CSSStyleDeclaration>, text = ''): HTMLElement {
  const e = document.createElement(tag)
  e.className = className
  Object.assign(e.style, style)
  if (text) e.textContent = text
  return e
}

/**
 * The altitude colour key (ground swatch + gradient bar + ft ticks) appended to `root`. Inline styles, so it needs no
 * stylesheet; the caller positions `root`. It ignores the pointer, so the map under it stays draggable.
 */
export function mountLegend(root: HTMLElement): { destroy(): void } {
  const box = el('div', 'fh-legend', {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    boxSizing: 'border-box',
    width: '100%',
    maxWidth: '520px',
    padding: '4px 8px 2px',
    background: 'rgba(255, 255, 255, 0.88)',
    color: '#1d1f24',
    borderRadius: '4px',
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.3)',
    font: '10px/1.2 system-ui, sans-serif',
    pointerEvents: 'none',
    userSelect: 'none',
  })
  box.setAttribute('role', 'img')
  box.setAttribute('aria-label', 'Altitude colours: grey on the ground, then orange at 0 ft through yellow, green, cyan, blue and violet to magenta at 40,000 ft and above')
  const gnd = el('span', 'fh-legend-gnd', {
    flex: 'none',
    padding: '1px 4px',
    borderRadius: '2px',
    background: altitudeColor(null, true),
    color: '#fff',
    fontWeight: '600',
  }, 'GND')
  const scale = el('div', 'fh-legend-scale', { flex: '1', minWidth: '0', padding: '0 16px 0 6px' })
  const bar = el('div', 'fh-legend-bar', { height: '8px', borderRadius: '2px', background: legendGradient() })
  const ticks = el('div', 'fh-legend-ticks', { position: 'relative', height: '13px', marginTop: '2px' })
  const n = LEGEND_TICKS_FT.length - 1
  LEGEND_TICKS_FT.forEach((ft, i) => {
    ticks.append(el('span', 'fh-legend-tick', {
      position: 'absolute',
      left: `${((i / n) * 100).toFixed(2)}%`,
      transform: 'translateX(-50%)',
      whiteSpace: 'nowrap',
    }, tickLabel(ft)))
  })
  scale.append(bar, ticks)
  box.append(gnd, scale, el('span', 'fh-legend-unit', { flex: 'none', alignSelf: 'flex-end', opacity: '0.7' }, 'ft'))
  root.append(box)
  return { destroy: () => box.remove() }
}

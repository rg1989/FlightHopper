// client/ui/legend.ts
import { altitudeColor } from '../scene/altitudeColor.ts'

/** Tick altitudes, evenly spaced along the bar (the low end, where most colour change happens, gets more room). */
export const LEGEND_TICKS_FT: readonly number[] = [0, 1_000, 2_000, 4_000, 6_000, 8_000, 10_000, 20_000, 30_000, 40_000]
const SAMPLES_PER_GAP = 8 // CSS interpolates in RGB; sampling the HSL path keeps the bar true to the icons

/** '0', '1k', …, '40k+': short enough for ten ticks on a phone-wide bar (~30 px each at 375 px). */
export function tickLabel(ft: number): string {
  const s = ft >= 1_000 ? `${ft / 1_000}k` : String(ft)
  return ft === LEGEND_TICKS_FT[LEGEND_TICKS_FT.length - 1] ? `${s}+` : s
}

/** The bar's CSS background: every tick at i/(n−1) of its length in its altitude colour, 8 samples per gap. */
export function legendGradient(direction = 'to right'): string {
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
  return `linear-gradient(${direction}, ${stops.join(', ')})`
}

function el(tag: string, className: string, style: Partial<CSSStyleDeclaration>, text = ''): HTMLElement {
  const e = document.createElement(tag)
  e.className = className
  Object.assign(e.style, style)
  if (text) e.textContent = text
  return e
}

/**
 * The altitude colour key, for its panel: a vertical scale (40,000+ ft at the top, 0 at the bottom) with the tick
 * labels beside it, the ground swatch under it and one line of explanation. Inline styles, so it needs no stylesheet.
 */
export function mountLegend(root: HTMLElement): { destroy(): void } {
  const n = LEGEND_TICKS_FT.length - 1
  const box = el('div', 'fh-legend', {
    display: 'grid',
    gridTemplateColumns: '12px 1fr',
    columnGap: '12px',
    boxSizing: 'border-box',
    padding: '18px 16px 8px',
    color: 'var(--fh-text)',
    font: '12px/1 var(--fh-font)',
    pointerEvents: 'none',
    userSelect: 'none',
  })
  box.setAttribute('role', 'img')
  box.setAttribute('aria-label', 'Altitude colours: grey on the ground, then orange at 0 ft through yellow, green, cyan, blue and violet to magenta at 40,000 ft and above')
  const bar = el('div', 'fh-legend-bar', { height: '240px', borderRadius: '6px', background: legendGradient('to top') })
  const ticks = el('div', 'fh-legend-ticks', { position: 'relative', height: '240px', color: 'var(--fh-muted)' })
  LEGEND_TICKS_FT.forEach((ft, i) => {
    ticks.append(el('span', 'fh-legend-tick', {
      position: 'absolute',
      left: '0',
      bottom: `${((i / n) * 100).toFixed(2)}%`,
      transform: 'translateY(50%)',
      whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums',
    }, `${tickLabel(ft)} ft`))
  })
  const gnd = el('span', 'fh-legend-gnd', {
    width: '12px',
    height: '12px',
    marginTop: '14px',
    borderRadius: '4px',
    background: altitudeColor(null, true),
  })
  const gndText = el('span', 'fh-legend-unit', { marginTop: '14px', color: 'var(--fh-muted)', alignSelf: 'center' }, 'On the ground')
  box.append(bar, ticks, gnd, gndText)
  const caption = el('p', 'fh-legend-caption', { margin: '6px 16px 16px', color: 'var(--fh-muted)', fontSize: '12px', lineHeight: '1.4' },
    'Each aircraft icon is coloured by its altitude.')
  root.append(box, caption)
  return {
    destroy: () => {
      box.remove()
      caption.remove()
    },
  }
}

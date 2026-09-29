// client/ui/mapKey.ts
// The top-down map's key, at the bottom left (mapKey.css; hidden in the chase): the altitude colours as a thin bar with
// the ground swatch (legend.ts), and a scale ruler in nautical miles over kilometres that follows the zoom (the app
// passes the metres per pixel where the key sits).
import { altitudeColor } from '../scene/altitudeColor.ts'
import { LEGEND_TICKS_FT, legendGradient, tickLabel } from './legend.ts'
import './mapKey.css'

export const NM_M = 1852
const RULER_PX = 120 // the longest a ruler grows
const LABELLED = [2, 6, 9] // ticks labelled under the bar: 2k, 10k, 40k+ (GND and the bar's orange start say 0)

/** The longest round length (1, 2 or 5 × 10ⁿ units of unitM metres) within maxPx at mPerPx: its width and value. */
export function niceLength(mPerPx: number, unitM: number, maxPx = RULER_PX): { px: number; n: number } | null {
  if (!(mPerPx > 0) || !Number.isFinite(mPerPx)) return null
  const max = (mPerPx * maxPx) / unitM
  const p = 10 ** Math.floor(Math.log10(max))
  const n = Number(([5, 2, 1].map((k) => k * p).find((v) => v <= max) ?? p).toPrecision(1))
  return { px: (n * unitM) / mPerPx, n }
}

export interface MapKeyHandle {
  setScale(mPerPx: number | null): void // null: no ground under the key (hides the ruler)
  destroy(): void
}

export function mountMapKey(root: HTMLElement): MapKeyHandle {
  const h = (className: string, text = ''): HTMLDivElement => {
    const e = document.createElement('div')
    e.className = className
    if (text !== '') e.textContent = text
    return e
  }
  const box = h('fh-mapkey fh-glass fh-blur')
  const alt = h('fh-mapkey-alt')
  alt.setAttribute('role', 'img')
  alt.setAttribute('aria-label', 'Altitude colours: grey on the ground, then orange at 0 ft through yellow, green, cyan, blue and violet to magenta at 40,000 ft and above')
  const gnd = h('fh-mapkey-gnd')
  gnd.style.background = altitudeColor(null, true)
  const bar = h('fh-mapkey-bar')
  bar.style.background = legendGradient('to right')
  const ticks = h('fh-mapkey-ticks')
  ticks.append(h('fh-mapkey-t fh-mapkey-t-gnd', 'GND'))
  const n = LEGEND_TICKS_FT.length - 1
  for (const i of LABELLED) {
    const t = h('fh-mapkey-t', `${tickLabel(LEGEND_TICKS_FT[i])}${i === n ? ' ft' : ''}`)
    t.style.left = `${(i / n) * 100}%`
    if (i === n) t.classList.add('fh-mapkey-t-end')
    ticks.append(t)
  }
  alt.append(gnd, bar, ticks)

  const scale = h('fh-mapkey-scale')
  const ruler = (unit: string): ((m: number | null) => void) => {
    const row = h('fh-mapkey-ruler')
    const seg = h('fh-mapkey-seg')
    const label = h('fh-mapkey-rl')
    row.append(seg, label)
    scale.append(row)
    let last = ''
    return (mPerPx) => {
      const r = mPerPx === null ? null : niceLength(mPerPx, unit === 'nm' ? NM_M : 1000)
      const key = r === null ? '' : `${r.px.toFixed(1)}|${r.n}`
      if (key === last) return
      last = key
      row.hidden = r === null
      if (r === null) return
      seg.style.width = `${r.px}px`
      label.textContent = `${r.n} ${unit}`
    }
  }
  const nm = ruler('nm')
  const km = ruler('km')
  box.append(alt, scale)
  root.append(box)
  return {
    setScale(mPerPx) {
      nm(mPerPx)
      km(mPerPx)
    },
    destroy: () => box.remove(),
  }
}

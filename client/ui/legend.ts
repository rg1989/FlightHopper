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

// client/scene/aircraftLayer.ts
import type { Quality } from '../../shared/types.ts'
import type { RenderState } from '../types.ts'

const RGB: Record<Quality, string> = {
  adsb2: '56, 189, 248', //   sky blue: ADS-B v2, best position and geometric (HAE) altitude
  adsb01: '132, 204, 22', //  green: ADS-B v0/v1
  mlat: '245, 158, 11', //    amber: MLAT, noisier and further behind
  other: '161, 161, 170', //  grey: TIS-B, ADS-R, unknown
}

/** CSS fill colour of one aircraft: hue by position quality; a stale (frozen) track is dimmed, less so when selected. */
export function colorFor(quality: Quality, selected: boolean, mode: RenderState['mode']): string {
  const alpha = mode !== 'stale' ? 1 : selected ? 0.6 : 0.35
  return `rgba(${RGB[quality]}, ${alpha})`
}

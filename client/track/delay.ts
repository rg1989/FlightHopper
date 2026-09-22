// client/track/delay.ts
// Playback delay: how far behind the server clock we render, so we interpolate between samples instead of guessing.
import type { Quality } from '../../shared/types.ts'

export const MIN_DELAY_S = 3
export const MAX_DELAY_S = 10

const FLOOR_S: Record<Quality, number> = { adsb2: 3, adsb01: 4, mlat: 6, other: 6 }

export function delayFloorS(q: Quality): number {
  return FLOOR_S[q]
}

/** 1 s of headroom over one poll period and over the p90 sample gap. A NaN term counts as absent. */
const term = (s: number): number => (Number.isNaN(s) ? 0 : s + 1)

/** clamp(max(floor, poll + 1, p90 gap + 1), 3, 10) seconds. */
export function targetDelayS(q: Quality, pollPeriodS: number, gapP90S: number): number {
  const d = Math.max(delayFloorS(q), term(pollPeriodS), term(gapP90S))
  return Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, d))
}

/**
 * 90th percentile by nearest rank: the ceil(0.9·n)-th smallest value, always an observed value, never
 * interpolated below a real gap. With few samples it rounds up (n < 10 → the max), which is the safe
 * direction for a delay. Empty → 0. Non-finite values are skipped.
 * ponytail: sorts a copy on every call; fine for the ≤ ~200 gaps a 180 s track holds. If it ever shows in a
 * profile, cache the result in Track and recompute only when a sample arrives.
 */
export function p90(xs: number[]): number {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  return s.length === 0 ? 0 : s[Math.ceil(0.9 * s.length) - 1]
}

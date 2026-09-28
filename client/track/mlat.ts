// client/track/mlat.ts
// Finite-difference velocities from positions: what Track checks a reported velocity against.
import type { KinPoint, PosT } from './types.ts'

/**
 * Velocity at each point from the positions around it: from the earliest to the latest point within ±halfS (at least
 * the neighbours: central inside, one-sided at the ends), 0 for a lone point. baseS: the time the difference spans.
 * A longer baseline averages out time-stamp jitter (adsb.fi: ±0.1 s, 1 % beyond 0.9 s).
 */
export function velocitiesFromPositions(pts: PosT[], halfS = 0): Array<KinPoint & { baseS: number }> {
  return pts.map((p, i) => {
    let ia = Math.max(0, i - 1)
    let ib = Math.min(pts.length - 1, i + 1)
    while (ia > 0 && pts[ia - 1].t >= p.t - halfS) ia--
    while (ib < pts.length - 1 && pts[ib + 1].t <= p.t + halfS) ib++
    const a = pts[ia]
    const b = pts[ib]
    const dt = b.t - a.t
    return { t: p.t, e: p.e, n: p.n, ve: dt > 0 ? (b.e - a.e) / dt : 0, vn: dt > 0 ? (b.n - a.n) / dt : 0, baseS: dt }
  })
}

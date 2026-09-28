// client/track/mlat.ts
// Finite-difference velocities from positions: what Track checks a reported velocity against.
import type { KinPoint, PosT } from './types.ts'

/** Velocity at each point: central difference inside, one-sided at the ends, 0 for a lone point. */
export function velocitiesFromPositions(pts: PosT[]): KinPoint[] {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(pts.length - 1, i + 1)]
    const dt = b.t - a.t
    return { t: p.t, e: p.e, n: p.n, ve: dt > 0 ? (b.e - a.e) / dt : 0, vn: dt > 0 ? (b.n - a.n) / dt : 0 }
  })
}

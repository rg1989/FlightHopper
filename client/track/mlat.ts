// client/track/mlat.ts
// Clean-up for MLAT tracks (noisy, irregular positions with no reliable velocity): gate → smooth → differentiate.
import type { KinPoint, PosT } from './types.ts'

/**
 * Drops every point that does not move forward in time from, or implies a speed above maxSpeedMs from,
 * the last kept point. The first point is always kept.
 * ponytail: speed-only gate trusting the first point. Ceilings: if the first point is itself an outlier
 * the rest of the window is dropped, and position noise inflates the implied speed at short spacing, so
 * callers need a generous maxSpeedMs (≈ 1000 m/s for MLAT). Upgrade: re-seed after 3 consecutive
 * rejections and gate on distance > maxSpeedMs·dt + 3σ.
 */
export function gateOutliers(pts: PosT[], maxSpeedMs: number): PosT[] {
  const out: PosT[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (last) {
      const dt = p.t - last.t
      if (!(dt > 0) || Math.hypot(p.e - last.e, p.n - last.n) > maxSpeedMs * dt) continue
    }
    out.push(p)
  }
  return out
}

/**
 * Centered moving average over indices i−k … i+k, with k = min(halfWindow, i, len−1−i) so the window
 * shrinks symmetrically at the ends (the first and last points pass through unsmoothed rather than
 * lagging). t is averaged too: it equals t_i for evenly spaced input and keeps constant-velocity motion
 * unbiased when MLAT timing is irregular.
 */
export function smoothPositions(pts: PosT[], halfWindow: number): PosT[] {
  return pts.map((_, i) => {
    const k = Math.min(halfWindow, i, pts.length - 1 - i)
    let t = 0
    let e = 0
    let n = 0
    for (let j = i - k; j <= i + k; j++) {
      t += pts[j].t
      e += pts[j].e
      n += pts[j].n
    }
    const m = 2 * k + 1
    return { t: t / m, e: e / m, n: n / m }
  })
}

/** Velocity at each point: central difference inside, one-sided at the ends, 0 for a lone point. */
export function velocitiesFromPositions(pts: PosT[]): KinPoint[] {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(pts.length - 1, i + 1)]
    const dt = b.t - a.t
    return { t: p.t, e: p.e, n: p.n, ve: dt > 0 ? (b.e - a.e) / dt : 0, vn: dt > 0 ? (b.n - a.n) / dt : 0 }
  })
}

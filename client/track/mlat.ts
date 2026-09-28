// client/track/mlat.ts
// Checks of positions against each other: finite-difference velocities (what Track checks a reported velocity
// against), and mis-stamped positions (what it leaves out).
import type { KinPoint, PosT } from './types.ts'

/**
 * Velocity at each point from the positions around it: from the earliest to the latest point within ±halfS (at least
 * the neighbours: central inside, one-sided at the ends), 0 for a lone point. baseS: the time the difference spans.
 * A longer baseline averages out time-stamp jitter (adsb.fi: ±0.1 s, 1 % beyond 0.9 s). skip: points left out.
 */
export function velocitiesFromPositions(pts: PosT[], halfS = 0, skip?: readonly boolean[]): Array<KinPoint & { baseS: number }> {
  const use = pts.flatMap((_, i) => (skip?.[i] ? [] : [i]))
  return pts.map((p) => {
    // the used points round p: the last at or before it and the first after it, widened to ±halfS
    let hi = use.findIndex((j) => pts[j].t > p.t)
    if (hi < 0) hi = use.length
    let ia = Math.max(0, hi - (hi > 0 && pts[use[hi - 1]].t === p.t ? 2 : 1))
    let ib = Math.min(use.length - 1, hi)
    while (ia > 0 && pts[use[ia - 1]].t >= p.t - halfS) ia--
    while (ib < use.length - 1 && pts[use[ib + 1]].t <= p.t + halfS) ib++
    if (use.length === 0) return { t: p.t, e: p.e, n: p.n, ve: 0, vn: 0, baseS: 0 }
    const a = pts[use[ia]]
    const b = pts[use[ib]]
    const dt = b.t - a.t
    return { t: p.t, e: p.e, n: p.n, ve: dt > 0 ? (b.e - a.e) / dt : 0, vn: dt > 0 ? (b.n - a.n) / dt : 0, baseS: dt }
  })
}

const OUT_SIGMA = 4 // a position this many σ from both its neighbours' prediction…
const AGREE_SIGMA = 2 // …while they are within this of each other, is mis-stamped

/**
 * Positions whose time stamp is wrong: point i is further than OUT_SIGMA from where the points either side of it (the
 * next two at the start, the last two at the end) put it, each predicted with the mean of the two reported velocities,
 * while those two points agree with each other. A real manoeuvre moves all three alike. sigmaM: a position's error per
 * axis (with its time jitter). Without a velocity, or with fewer than three points: none.
 */
export function positionOutliers(pts: PosT[], vel: ReadonlyArray<{ ve: number; vn: number } | null>, sigmaM: (i: number) => number): boolean[] {
  const miss = (i: number, j: number): number => {
    const a = vel[i]
    const b = vel[j]
    if (a === null || b === null) return Number.NaN
    const dt = pts[j].t - pts[i].t
    const de = pts[i].e + ((a.ve + b.ve) / 2) * dt - pts[j].e
    const dn = pts[i].n + ((a.vn + b.vn) / 2) * dt - pts[j].n
    return Math.hypot(de, dn) / Math.hypot(sigmaM(i), sigmaM(j))
  }
  return pts.map((_, i) => {
    if (pts.length < 3) return false
    const [j, k] = i === 0 ? [1, 2] : i === pts.length - 1 ? [i - 1, i - 2] : [i - 1, i + 1]
    return miss(i, j) > OUT_SIGMA && miss(i, k) > OUT_SIGMA && miss(j, k) < AGREE_SIGMA // NaN compares false
  })
}

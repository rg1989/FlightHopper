// server/descent.ts
// Steep descents in a series of barometric altitudes (docs/anomaly-alerts.md §3.2), as two rules:
//   D1, descent: from FL200 or above, 10,000 ft or more lost within 120 s, over 4 points or more.
//   D2, dive then lost: 3,000 ft or more lost within 30 s from above FL150, over 3 points or more, then no position for 60 s.
// Each step of a fall goes down, or up by 300 ft at most (noise), at 30,000 fpm or less (faster is a bad decode or spoofed
// GNSS), with at most 60 s between its points (a longer gap is a coverage hole, not a fall). Pure: server/alerts.ts runs the
// rules on live samples and on adsb.lol's half-hour files (server/heatmap.ts scanSlot).

/** Barometric altitudes in time order: t in s (any origin), ft. Airborne points only. */
export interface AltSeries {
  t: number[]
  ft: number[]
}

/** A fall, from its top to its bottom, in the series' times. */
export interface Drop {
  startS: number
  endS: number
  fromFt: number
  toFt: number
}

export const D1 = { windowS: 120, topFt: 20_000, fallFt: 10_000, points: 4 } as const
export const D2 = { windowS: 30, topFt: 15_000, fallFt: 3_000, points: 3, lostS: 60 } as const
const CEILING_FT = 50_000 // higher is a bad decode or spoofed GNSS (the heatmap files carry GNSS when there is no baro)
const MAX_FPM = 30_000 // a step faster than this is not flown
const NOISE_FT = 300 // a fall may rise this much between two points
const MAX_GAP_S = 60

/** The rate between points a and b, fpm. */
const fpm = (s: AltSeries, a: number, b: number): number => ((s.ft[b] - s.ft[a]) / Math.max(1e-6, s.t[b] - s.t[a])) * 60

/**
 * Without impossible points: none above 50,000 ft, and no spike, a point whose steps to both neighbours are over
 * 30,000 fpm in opposite directions. The first and last points have one neighbour each and are kept: a fall cannot use a
 * step over 30,000 fpm anyway.
 */
export function clean(s: AltSeries): AltSeries {
  const kept: number[] = []
  for (let i = 0; i < s.t.length; i++) if (s.ft[i] <= CEILING_FT) kept.push(i)
  const out: AltSeries = { t: [], ft: [] }
  for (let k = 0; k < kept.length; k++) {
    if (k > 0 && k < kept.length - 1) {
      const r1 = fpm(s, kept[k - 1], kept[k])
      const r2 = fpm(s, kept[k], kept[k + 1])
      if (Math.abs(r1) > MAX_FPM && Math.abs(r2) > MAX_FPM && Math.sign(r1) !== Math.sign(r2)) continue
    }
    out.t.push(s.t[kept[k]])
    out.ft.push(s.ft[kept[k]])
  }
  return out
}

/** Whether the step from point a to a + 1 can be part of a fall: no hole, no rise over 300 ft, not faster than 30,000 fpm. */
function falls(s: AltSeries, a: number): boolean {
  const dt = s.t[a + 1] - s.t[a]
  const dft = s.ft[a + 1] - s.ft[a]
  return dt > 0 && dt <= MAX_GAP_S && dft <= NOISE_FT && (-dft / dt) * 60 <= MAX_FPM
}

/**
 * D1: the first emergency descent in the series, from its top to its bottom (followed on while it keeps falling); null
 * when there is none. ponytail: O(points × points in 120 s), about 2,000 steps for a half hour of 10 s points.
 */
export function steepDescent(s: AltSeries): Drop | null {
  let run = 0 // the first point of the run of falling steps that ends at j
  for (let j = 1; j < s.t.length; j++) {
    if (!falls(s, j - 1)) {
      run = j
      continue
    }
    let k = run
    while (s.t[j] - s.t[k] > D1.windowS) k++
    let top = k // the highest point in the window, the latest of equals: a fall starts where level flight ends
    for (let m = k + 1; m < j; m++) if (s.ft[m] >= s.ft[top]) top = m
    if (j - top + 1 < D1.points || s.ft[top] < D1.topFt || s.ft[top] - s.ft[j] < D1.fallFt) continue
    let low = j
    for (let m = j; m + 1 < s.t.length && falls(s, m); m++) if (s.ft[m + 1] < s.ft[low]) low = m + 1
    return { startS: s.t[top], endS: s.t[low], fromFt: s.ft[top], toFt: s.ft[low] }
  }
  return null
}

/**
 * D2: a dive in the last 30 s of the series, then nothing for 60 s or more up to endS (the end of the data, e.g. a half-hour
 * file's last slice). From its top (above FL150) to the last point; null when it is not there.
 */
export function diveThenLost(s: AltSeries, endS: number): Drop | null {
  const last = s.t.length - 1
  if (last + 1 < D2.points || endS - s.t[last] < D2.lostS) return null
  let top = last
  for (let m = last - 1; m >= 0 && s.t[last] - s.t[m] <= D2.windowS && falls(s, m); m--) if (s.ft[m] > s.ft[top]) top = m
  if (last - top + 1 < D2.points || s.ft[top] < D2.topFt || s.ft[top] - s.ft[last] < D2.fallFt) return null
  return { startS: s.t[top], endS: s.t[last], fromFt: s.ft[top], toFt: s.ft[last] }
}

// server/descent.ts
// Steep descents in a series of barometric altitudes (docs/anomaly-alerts.md §3.2), as three rules:
//   D1, descent: from FL200 or above, 15,000 ft or more lost within 120 s, over 4 points or more (D1_OTHER, for an aircraft
//     that is no airliner: 20,000 ft).
//   D2, dive then lost: the fall into the last point, from a top within the last 60 s: 2,000 ft or more lost over 3 points or
//     more, at 6,000 fpm or more on average, then no position for 60 s (D2_OTHER, for an aircraft that is no airliner: 3,000 ft
//     or more from FL150 or above, at 10,000 fpm or more).
//   D3, plunge (airliners only): 8,000 ft or more lost within 60 s, over 3 points or more, at any level.
// What an airliner does in ordinary flight sets these (164,362 airliner half hours of 18 real half-hour files, 2026-09-28 to
// 10-03): at most 5,875 ft in 60 s and 10,725 ft in 120 s, and into silence at most 4,975 fpm over its last minute. Its ordinary
// steep descent and an emergency descent overlap (16,500 ft in 240 s is ordinary; Southwest 1380's peak was 5,228 fpm), and it
// leaves the receivers' reach at up to 3,960 fpm below 10,000 ft (Germanwings 9525 flew at 3,500), so no rule looks for a
// slower fall: the squawk tells. Other civil aircraft dive as routine (jump planes 12,000 ft in 120 s from FL130, business
// jets and their drills 18,000 ft from FL250, and one at 5,070 fpm into the edge of coverage): the type decides
// (server/alerts.ts AIRLINERS). Known emergencies replayed against these rules: server/alerts.cases.ts.
// Each step of a fall goes down, or up by 300 ft at most (noise), at 45,000 fpm or less (faster is a bad decode or spoofed
// GNSS), with at most 60 s between its points (a longer gap is a coverage hole, not a fall), and two of its steps or more go
// down by 200 ft or more (one jump between two level stretches is an altitude encoder's stuck bit). Pure: server/alerts.ts runs the
// rules on live samples and on adsb.lol's half-hour files (server/heatmap.ts scanSlot).

/** Barometric altitudes in time order: t in s (any origin), ft. Airborne points only. After clean, t is strictly increasing. */
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

/** A fall of fallFt or more within windowS, over `points` points or more, from a top at topFt or above. */
export interface FallRule {
  windowS: number
  topFt: number
  fallFt: number
  points: number
}
export const D1: FallRule = { windowS: 120, topFt: 20_000, fallFt: 15_000, points: 4 }
export const D1_OTHER: FallRule = { ...D1, fallFt: 20_000 }
export const D3: FallRule = { windowS: 60, topFt: 0, fallFt: 8_000, points: 3 }
/** The fall into the last point: as a FallRule, at minFpm or more on average, then no position for lostS. */
export interface DiveRule extends FallRule {
  lostS: number
  minFpm: number
}
export const D2: DiveRule = { windowS: 60, topFt: 0, fallFt: 2_000, points: 3, lostS: 60, minFpm: 6_000 }
export const D2_OTHER: DiveRule = { ...D2, topFt: 15_000, fallFt: 3_000, minFpm: 10_000 }
const CEILING_FT = 50_000 // higher is a bad decode or spoofed GNSS (the heatmap files carry GNSS when there is no baro)
const OUTLIER_FT = 1000 // off the line between its neighbours by more than this: a GNSS altitude among baro ones, or a bad decode
// A step faster than this is not flown. The last seconds of real dives passed 30,000 fpm (Sriwijaya 182 10,650 ft in 21 s, Lion
// Air 610, Ethiopian 302, China Eastern 5735), so the limit is half as much again.
const MAX_FPM = 45_000
// A fall has this many steps down by STEP_FT or more. One jump is no fall, however many level points follow it: N6262W, a
// PA-28 at 6,600 ft on 2026-10-03, sent 38,900 ft every few messages, twice in a row once (clean takes single ones).
const STEPS = 2
const STEP_FT = 200
const SPIKE_FPM = 30_000 // a point between two steps in opposite directions, both faster than this, is a spike
const NOISE_FT = 300 // a fall may rise this much between two points
const MAX_GAP_S = 60

/** The rate between points a and b, fpm. */
const fpm = (s: AltSeries, a: number, b: number): number => ((s.ft[b] - s.ft[a]) / Math.max(1e-6, s.t[b] - s.t[a])) * 60

/**
 * Without impossible points: none above 50,000 ft, none at or before the time of the point kept before it (a repeated
 * row would cut a fall in two), and no outlier. A candidate is an inner point whose steps to its two neighbours go in
 * opposite directions (both non-zero) and that either lies over 1,000 ft off the straight line between them, interpolated
 * in time, or is a spike, both steps faster than 30,000 fpm. A point is judged only against close neighbours: both its steps
 * must be at most 60 s, as in a fall, so a point across a coverage hole is kept. A candidate goes only when its deviation (how
 * far off that line it is) is at least that of each neighbour (0 for a neighbour that is no candidate): the good point beside
 * a spike is off the line to the spike, and stays. It is one pass over the points that the first two rules leave, and it
 * drops a subset of what dropping every candidate would, so it never cascades.
 * ponytail: the first and last points have one neighbour each and are never judged, so a series cut just after a GNSS point
 * keeps it (the baro point before it may go instead) and can hide a dive.
 * ponytail: a dive that recovers can lose its bottom point to the rule (a V, over 1,000 ft off the line between its
 * neighbours): a fall that levels off is found, one that climbs back at once may not be.
 * ponytail: a run of two or more outliers is not caught whole.
 */
export function clean(s: AltSeries): AltSeries {
  const kept: number[] = []
  let lastT = -Infinity // the time of the point kept last
  for (let i = 0; i < s.t.length; i++) {
    if (s.ft[i] <= CEILING_FT && s.t[i] > lastT) {
      kept.push(i)
      lastT = s.t[i]
    }
  }
  const dev = kept.map((p, k) => (k > 0 && k < kept.length - 1 ? outlierFt(s, kept[k - 1], p, kept[k + 1]) : 0)) // 0: not a candidate
  const out: AltSeries = { t: [], ft: [] }
  for (let k = 0; k < kept.length; k++) {
    if (dev[k] > 0 && dev[k] >= dev[k - 1] && dev[k] >= dev[k + 1]) continue
    out.t.push(s.t[kept[k]])
    out.ft.push(s.ft[kept[k]])
  }
  return out
}

/** How far point b, between a and c, lies off the line between them, ft, when it is an outlier candidate (see clean); 0 when it is not. */
function outlierFt(s: AltSeries, a: number, b: number, c: number): number {
  if (s.t[b] - s.t[a] > MAX_GAP_S || s.t[c] - s.t[b] > MAX_GAP_S) return 0 // across a coverage hole: not judged
  if ((s.ft[b] - s.ft[a]) * (s.ft[c] - s.ft[b]) >= 0) return 0 // a zero step, or both steps the same way
  const line = s.ft[a] + ((s.ft[c] - s.ft[a]) * (s.t[b] - s.t[a])) / (s.t[c] - s.t[a])
  const off = Math.abs(s.ft[b] - line)
  return off > OUTLIER_FT || (Math.abs(fpm(s, a, b)) > SPIKE_FPM && Math.abs(fpm(s, b, c)) > SPIKE_FPM) ? off : 0
}

/** Whether the step from point a to a + 1 can be part of a fall: no hole, no rise over 300 ft, not faster than 45,000 fpm. */
function falls(s: AltSeries, a: number): boolean {
  const dt = s.t[a + 1] - s.t[a]
  const dft = s.ft[a + 1] - s.ft[a]
  return dt > 0 && dt <= MAX_GAP_S && dft <= NOISE_FT && (-dft / dt) * 60 <= MAX_FPM
}

/** Whether the points from a to b hold two steps or more down by 200 ft or more: a fall, not one jump. */
function stepped(s: AltSeries, a: number, b: number): boolean {
  let n = 0
  for (let m = a; m < b && n < STEPS; m++) if (s.ft[m] - s.ft[m + 1] >= STEP_FT) n++
  return n >= STEPS
}

/**
 * The first fall in the series that fits the rule (D1 by default), from its top to its bottom; null when there is none. The bottom is the first
 * lowest point when the fall is found. When that is the newest point the fall follows on: each next point joins while the step
 * into it is a fall, each new low resets the clock, and it stops when over 60 s pass with no new low (60 s is bridged, as a
 * gap is), or at a step that is not a fall. That bridges a repeated or slightly higher sample in a live track, and level flight
 * or a climb back still ends it.
 * ponytail: costs O(points × points in the 120 s window), about 2,000 steps for a half hour of 10 s points: the window's
 * start only moves forward, and its top is looked for in the window at every point.
 */
export function steepDescent(s: AltSeries, rule: FallRule = D1): Drop | null {
  let run = 0 // the first point of the run of falling steps that ends at j
  let k = 0 // the first point of the window that ends at j, never before the run
  for (let j = 1; j < s.t.length; j++) {
    if (!falls(s, j - 1)) {
      run = j
      continue
    }
    if (k < run) k = run
    while (s.t[j] - s.t[k] > rule.windowS) k++
    let top = k // the highest point in the window, the latest of equals: a fall starts where level flight ends
    for (let m = k + 1; m < j; m++) if (s.ft[m] >= s.ft[top]) top = m
    if (j - top + 1 < rule.points || s.ft[top] < rule.topFt || s.ft[top] - s.ft[j] < rule.fallFt || !stepped(s, top, j)) continue
    // The bottom: the first lowest point so far (the point that completed the fall may be a small rise after it). When that
    // is j, on while each step is a fall and at most 60 s have passed since the last low: a repeat or a small rise is bridged.
    let low = top
    for (let m = top + 1; m <= j; m++) if (s.ft[m] < s.ft[low]) low = m
    if (low === j) {
      for (let m = j + 1; m < s.t.length && falls(s, m - 1) && s.t[m] - s.t[low] <= MAX_GAP_S; m++) if (s.ft[m] < s.ft[low]) low = m
    }
    return { startS: s.t[top], endS: s.t[low], fromFt: s.ft[top], toFt: s.ft[low] }
  }
  return null
}

/**
 * The fall into the last point of the series that fits the rule (D2 by default), when no position follows it for 60 s or more
 * up to endS (the end of the data, e.g. a half-hour file's last slice). Its top is a point within the last 60 s at the rule's
 * topFt or above, every step from it to the last point a fall, over 3 points or more, the rule's fallFt or more lost, at its
 * minFpm or more on average. Of the tops that fit, the biggest
 * fall is taken (the latest of equals: a fall starts where level flight ends); null when none fits.
 */
export function diveThenLost(s: AltSeries, endS: number, rule: DiveRule = D2): Drop | null {
  const last = s.t.length - 1
  if (last + 1 < rule.points || endS - s.t[last] < rule.lostS) return null
  let top = -1
  for (let m = last - 1; m >= 0 && s.t[last] - s.t[m] <= rule.windowS && falls(s, m); m--) {
    const fall = s.ft[m] - s.ft[last]
    const fits = last - m + 1 >= rule.points && s.ft[m] >= rule.topFt && fall >= rule.fallFt && fall * 60 >= rule.minFpm * (s.t[last] - s.t[m]) && stepped(s, m, last)
    if (fits && (top < 0 || fall > s.ft[top] - s.ft[last])) top = m
  }
  return top < 0 ? null : { startS: s.t[top], endS: s.t[last], fromFt: s.ft[top], toFt: s.ft[last] }
}

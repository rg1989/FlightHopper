// tools/metrics.ts
/**
 * G2 motion metrics over rendered frames. Pure functions; tools/bench-track.ts (WP-A3) feeds them the 60 Hz
 * Frame[] of a causal replay. Frame: t in seconds, e/n/u in metres in one local ENU frame.
 *
 * Conventions:
 * - Frames are in time order. A pair or triple whose t does not strictly increase is skipped.
 * - Every mode counts ('interp' | 'extrap' | 'stale': it is what the viewer sees) except in frameDiscontinuity,
 *   which scores interpolation only. Pass a filtered array to score a subset.
 * - No data → NaN, so a gate fed nothing fails instead of passing (NaN <= x is false; JSON writes it as null).
 * - Derivatives are plain finite differences. At 60 Hz their truncation error is O(a·dt²), far below every G2 bar.
 */
import type { Frame, RateAt } from './types.ts'

/** Largest value; NaN for an empty list. A loop, not Math.max(...xs), so an hour of 60 Hz frames cannot overflow the stack. */
function max(xs: number[]): number {
  let m = -Infinity
  for (const x of xs) if (x > m) m = x
  return xs.length === 0 ? NaN : m
}

/**
 * p-th percentile, p in 0..100 (clamped), by linear interpolation between the closest ranks of the ascending sort:
 * rank = p/100 · (n − 1) (Hyndman–Fan type 7, the default of numpy and Excel PERCENTILE.INC).
 * So p50 of [1, 2, 3, 4] is 2.5 and p95 of 1..100 is 95.05. The input is not mutated. Empty → NaN.
 */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN
  const s = xs.toSorted((a, b) => a - b)
  const r = (Math.min(Math.max(p, 0), 100) / 100) * (s.length - 1)
  const lo = Math.floor(r)
  const hi = Math.ceil(r)
  return s[lo] + (r - lo) * (s[hi] - s[lo])
}

/**
 * Frame-to-frame discontinuity while interpolating. For three consecutive 'interp' frames a, b, c the velocity
 * over the previous interval is v̂ = (b − a)/(b.t − a.t), and the score is the 3D miss |(c − b) − v̂·(c.t − b.t)| in metres.
 * Constant velocity scores 0 (also with irregular frame spacing). Smooth acceleration a scores a·dt²
 * (1.4 mm at 5 m/s² and 60 Hz). A position step of s metres scores ≈ s on its frame and on the next one.
 */
export function frameDiscontinuity(frames: Frame[]): { maxM: number; p99M: number } {
  const d: number[] = []
  for (let i = 2; i < frames.length; i++) {
    const a = frames[i - 2]
    const b = frames[i - 1]
    const c = frames[i]
    if (a.mode !== 'interp' || b.mode !== 'interp' || c.mode !== 'interp') continue
    const dt1 = b.t - a.t
    const dt2 = c.t - b.t
    if (!(dt1 > 0 && dt2 > 0)) continue
    const k = dt2 / dt1
    d.push(Math.hypot(c.e - b.e - k * (b.e - a.e), c.n - b.n - k * (b.n - a.n), c.u - b.u - k * (b.u - a.u)))
  }
  return { maxM: max(d), p99M: percentile(d, 99) }
}

interface Kin {
  t: number
  ae: number
  an: number
  au: number
  ve: number
  vn: number
}

/**
 * Acceleration (second difference, exact for constant acceleration) and horizontal velocity (central difference)
 * at the middle frame b of every three consecutive frames a, b, c with increasing t.
 */
function kinematics(frames: Frame[]): Kin[] {
  const out: Kin[] = []
  for (let i = 1; i + 1 < frames.length; i++) {
    const a = frames[i - 1]
    const b = frames[i]
    const c = frames[i + 1]
    const dt1 = b.t - a.t
    const dt2 = c.t - b.t
    if (!(dt1 > 0 && dt2 > 0)) continue
    const h = (dt1 + dt2) / 2
    const acc = (x: 'e' | 'n' | 'u'): number => ((c[x] - b[x]) / dt2 - (b[x] - a[x]) / dt1) / h
    out.push({ t: b.t, ae: acc('e'), an: acc('n'), au: acc('u'), ve: (c.e - a.e) / (dt1 + dt2), vn: (c.n - a.n) / (dt1 + dt2) })
  }
  return out
}

/**
 * Lateral acceleration |a⊥| in m/s²: the horizontal second-difference acceleration minus its component along the
 * horizontal velocity, |a_e·v_n − a_n·v_e| / |v|. A circle of radius r flown at speed v gives v²/r; speeding up or
 * braking along the track gives 0. At zero speed the direction is undefined, so the whole horizontal |a| counts.
 */
export function lateralAccel(frames: Frame[]): { p99: number; max: number } {
  const lat = kinematics(frames).map((k) => {
    const v = Math.hypot(k.ve, k.vn)
    return v > 0 ? Math.abs(k.ae * k.vn - k.an * k.ve) / v : Math.hypot(k.ae, k.an)
  })
  return { p99: percentile(lat, 99), max: max(lat) }
}

/**
 * Jerk |Δa|/Δt in m/s³ between the 3D second-difference accelerations of consecutive frames.
 * A circle of radius r at speed v gives v³/r²; a straight line or constant acceleration gives 0.
 */
export function jerk(frames: Frame[]): { p99: number } {
  const k = kinematics(frames)
  const j: number[] = []
  for (let i = 1; i < k.length; i++) {
    const dt = k[i].t - k[i - 1].t
    if (dt > 0) j.push(Math.hypot(k[i].ae - k[i - 1].ae, k[i].an - k[i - 1].an, k[i].au - k[i - 1].au) / dt)
  }
  return { p99: percentile(j, 99) }
}

/** Indices and weight for linear interpolation at t in a list sorted by t: value = x[i] + w·(x[j] − x[i]). Null outside [first.t, last.t]. */
function bracket(xs: { t: number }[], t: number): { i: number; j: number; w: number } | null {
  const n = xs.length
  if (n === 0 || !(t >= xs[0].t && t <= xs[n - 1].t)) return null
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1 // invariant: xs[lo].t <= t <= xs[hi].t
    if (xs[mid].t <= t) lo = mid
    else hi = mid
  }
  const dt = xs[hi].t - xs[lo].t
  return { i: lo, j: hi, w: dt > 0 ? (t - xs[lo].t) / dt : 1 }
}

/**
 * Vertical fidelity. For each consecutive frame pair the rendered VS is Δu/Δt (m/s). It is compared with the reported
 * rate (sorted by t, m/s) linearly interpolated at the pair's midpoint, the instant a finite difference measures.
 * Pairs outside the reported span are skipped. vsErrP95 = p95 of |rendered − reported|; maxStepM = max |Δu| between
 * consecutive frames over all pairs (a 25 ft quantisation step renders as a 7.62 m jump).
 * Frame.u must be height above one reference: an ENU "up" drops d²/2R below it at distance d from the origin
 * (7.8 m at 10 km), which reads as a spurious VS of d·v/R.
 */
export function verticalMetrics(frames: Frame[], reported: RateAt[]): { vsErrP95: number; maxStepM: number } {
  const err: number[] = []
  const steps: number[] = []
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]
    const b = frames[i]
    steps.push(Math.abs(b.u - a.u))
    const dt = b.t - a.t
    const r = dt > 0 ? bracket(reported, (a.t + b.t) / 2) : null
    if (!r) continue
    const vs = reported[r.i].vsMs + r.w * (reported[r.j].vsMs - reported[r.i].vsMs)
    err.push(Math.abs((b.u - a.u) / dt - vs))
  }
  return { vsErrP95: percentile(err, 95), maxStepM: max(steps) }
}

/**
 * Horizontal distance (m) from each truth point to the rendered position at the same t, linearly interpolated
 * between the bracketing frames. Truth points outside the rendered span are skipped, so the result can be shorter
 * than `truth`. This time-aligned distance includes along-track error, so it bounds the pure cross-track error from above.
 * ponytail: no projection onto the path normal, so a render that is only late along the track also scores here. That is
 * the conservative side for the G2 turn bars; if timing error ever dominates, project the miss onto the rendered track normal.
 */
export function crossTrackErrors(frames: Frame[], truth: { t: number; e: number; n: number }[]): number[] {
  const out: number[] = []
  for (const p of truth) {
    const r = bracket(frames, p.t)
    if (!r) continue
    const f = frames[r.i]
    const g = frames[r.j]
    out.push(Math.hypot(f.e + r.w * (g.e - f.e) - p.e, f.n + r.w * (g.n - f.n) - p.n))
  }
  return out
}

/** Largest render-delay slew max |Δd/Δt| over consecutive samples with increasing t; t and d both in seconds → s/s. */
export function delaySlew(delays: { t: number; d: number }[]): number {
  const s: number[] = []
  for (let i = 1; i < delays.length; i++) {
    const dt = delays[i].t - delays[i - 1].t
    if (dt > 0) s.push(Math.abs(delays[i].d - delays[i - 1].d) / dt)
  }
  return max(s)
}

// client/track/smoother.ts
// One axis of an aircraft's motion as a physically smooth path: a Kalman filter and a Rauch–Tung–Striebel smoother over
// a white-jerk model (state: position, velocity, acceleration). Real aircraft change acceleration gradually (a roll-in
// takes seconds), so the smoothed path passes near the noisy samples, not through them, and its speed, vertical speed
// and turn rate are continuous. Between the smoothed states, quintic() is the same model's path (C2).

/** One measurement time: a position and/or a velocity, each with its variance (null: not measured). */
export interface Obs {
  t: number // s
  p: number | null
  rp: number // variance of p, m²
  v: number | null
  rv: number // variance of v, (m/s)²
}

/** The smoothed state at a measurement time. */
export interface Knot3 {
  t: number
  p: number
  v: number
  a: number
}

const GATE = 16 // a measurement more than 4σ from the prediction is ignored…
const RESYNC = 3 // …unless it is the third in a row: then the aircraft really is there (the path jumps to it)…
const GATE_GAP_S = 4 // …and only at the normal cadence: after a longer gap the aircraft may have done anything,
const GAP_Q = 20 // so across the gap its jerk may have been that much larger (a roll-in, a level-off); likewise after
// a rejected position: it may have been the start of a manoeuvre the model did not expect, so the next prediction
// allows one (a lone outlier is still ignored; a real turn is followed within a sample or two, without a restart)

type V3 = [number, number, number]
/** Know nothing: the prior of the first measurement, and of a restart. */
const VAGUE = [1e10, 0, 0, 0, 1e6, 0, 0, 0, 100] as const
type M3 = [number, number, number, number, number, number, number, number, number] // row-major

/** x ← F(dt)·x for the constant-acceleration transition. */
const predictX = (x: V3, dt: number): V3 => [x[0] + dt * x[1] + 0.5 * dt * dt * x[2], x[1] + dt * x[2], x[2]]

/** F·P·Fᵀ + Q for the white-jerk model with spectral density q. */
function predictP(P: M3, dt: number, q: number): M3 {
  const d2 = dt * dt
  const h = 0.5 * d2
  // A = F·P (rows of F: [1, dt, h], [0, 1, dt], [0, 0, 1])
  const a0 = P[0] + dt * P[3] + h * P[6], a1 = P[1] + dt * P[4] + h * P[7], a2 = P[2] + dt * P[5] + h * P[8]
  const a3 = P[3] + dt * P[6], a4 = P[4] + dt * P[7], a5 = P[5] + dt * P[8]
  const a6 = P[6], a7 = P[7], a8 = P[8]
  // A·Fᵀ (columns of Fᵀ are the rows of F)
  const d3 = d2 * dt
  const d4 = d3 * dt
  const d5 = d4 * dt
  const q00 = (q * d5) / 20, q01 = (q * d4) / 8, q02 = (q * d3) / 6, q11 = (q * d3) / 3, q12 = (q * d2) / 2, q22 = q * dt
  return [
    a0 + dt * a1 + h * a2 + q00, a1 + dt * a2 + q01, a2 + q02,
    a3 + dt * a4 + h * a5 + q01, a4 + dt * a5 + q11, a5 + q12,
    a6 + dt * a7 + h * a8 + q02, a7 + dt * a8 + q12, a8 + q22,
  ]
}

/** Physical limits of the state: speed and acceleration along the axis. A measurement implying more is not believed. */
export interface Limits {
  v: number
  a: number
}

/** How old a velocity report is compared with its position (s: typical, sd: spread), seconds. */
export interface Lag {
  s: number
  sd: number
}

/**
 * Scalar update with measurement row H (z ≈ H·x). Returns false when gated out: more than 4σ from the prediction, or
 * implying a speed or acceleration beyond `lim`. force: accept it anyway; if it is that far off or that impossible,
 * the state starts over (as at the first measurement), and the smoother reads the vague prior pp there, so the path
 * before and after do not pull on each other.
 */
function update(x: V3, P: M3, pp: M3, H: V3, z: number, r: number, force: boolean, lim: Limits | null): boolean {
  // P·Hᵀ and H·P·Hᵀ
  let ph0 = P[0] * H[0] + P[1] * H[1] + P[2] * H[2]
  let ph1 = P[3] * H[0] + P[4] * H[1] + P[5] * H[2]
  let ph2 = P[6] * H[0] + P[7] * H[1] + P[8] * H[2]
  const y = z - (H[0] * x[0] + H[1] * x[1] + H[2] * x[2])
  let s = H[0] * ph0 + H[1] * ph1 + H[2] * ph2 + r
  const far = (y * y) / s > GATE
  const impossible = lim !== null && (Math.abs(x[1] + (ph1 / s) * y) > lim.v || Math.abs(x[2] + (ph2 / s) * y) > lim.a)
  if ((far || impossible) && !force) return false
  if (far || impossible) {
    VAGUE.forEach((v, j) => (P[j] = pp[j] = v))
    if (lim !== null) x[1] = Math.max(-lim.v, Math.min(lim.v, x[1]))
    x[2] = 0
    ph0 = P[0] * H[0] + P[1] * H[1] + P[2] * H[2]
    ph1 = P[3] * H[0] + P[4] * H[1] + P[5] * H[2]
    ph2 = P[6] * H[0] + P[7] * H[1] + P[8] * H[2]
    s = H[0] * ph0 + H[1] * ph1 + H[2] * ph2 + r
  }
  const k = [ph0 / s, ph1 / s, ph2 / s]
  x[0] += k[0] * y
  x[1] += k[1] * y
  x[2] += k[2] * y
  // P −= K·(H·P); H·P is (P·Hᵀ)ᵀ as P is symmetric
  for (let a = 0; a < 3; a++) {
    P[a * 3] -= k[a] * ph0
    P[a * 3 + 1] -= k[a] * ph1
    P[a * 3 + 2] -= k[a] * ph2
  }
  return true
}

const POS: V3 = [1, 0, 0]

/** Inverse of a symmetric positive-definite 3×3 matrix. */
function inv3(m: M3): M3 {
  const [a, b, c, , e, f, , , i] = m
  const d = m[3], g = m[6], h = m[7]
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ]
}

/**
 * The smoothed (position, velocity, acceleration) at every measurement time, in the order given (times must not
 * decrease). q: jerk spectral density, m²/s⁵ (how quickly acceleration may change); lim: the physical limits a
 * measurement must not push the state beyond; lag: how much older than its position a velocity report is (in a
 * manoeuvre it then reads v − lag·a). Each update takes the velocity first, then the position, so a manoeuvre the
 * velocity reports is not mistaken for a position outlier.
 */
export function smooth(obs: readonly Obs[], q: number, lim: Limits | null = null, lag: Lag | null = null): Knot3[] {
  const n = obs.length
  if (n === 0) return []
  const xf: V3[] = new Array(n)
  const Pf: M3[] = new Array(n)
  const xp: V3[] = new Array(n)
  const Pp: M3[] = new Array(n)
  // Vague, centred on the first measurements: they set the state (exactly, when they are exact).
  let x: V3 = [obs[0].p ?? 0, obs[0].v ?? 0, 0]
  let P: M3 = [...VAGUE]
  let missP = 0
  let missV = 0
  for (let k = 0; k < n; k++) {
    const o = obs[k]
    if (k > 0) {
      const dt = Math.max(0, o.t - obs[k - 1].t)
      x = predictX(x, dt)
      P = predictP(P, dt, dt > GATE_GAP_S || missP > 0 ? q * GAP_Q : q)
    }
    xp[k] = [...x] as V3
    Pp[k] = [...P] as M3
    const gap = k > 0 && o.t - obs[k - 1].t > GATE_GAP_S
    if (o.v !== null) {
      // A velocity report shows the velocity lag.s ago: v − lag.s·a, give or take lag.sd (times the acceleration).
      const rv = o.rv + (x[2] * (lag?.sd ?? 0)) ** 2
      if (update(x, P, Pp[k], [0, 1, -(lag?.s ?? 0)], o.v, rv, gap || missV + 1 >= RESYNC, lim)) missV = 0
      else missV++
    }
    if (o.p !== null) {
      if (update(x, P, Pp[k], POS, o.p, o.rp, gap || missP + 1 >= RESYNC, lim)) missP = 0
      else missP++
    }
    xf[k] = [...x] as V3
    Pf[k] = [...P] as M3
  }
  // Rauch–Tung–Striebel: x_s(k) = x_f(k) + C·(x_s(k+1) − x_p(k+1)), C = P_f(k)·Fᵀ·P_p(k+1)⁻¹.
  const out: Knot3[] = new Array(n)
  let xs = xf[n - 1]
  out[n - 1] = { t: obs[n - 1].t, p: xs[0], v: xs[1], a: xs[2] }
  for (let k = n - 2; k >= 0; k--) {
    const dt = Math.max(0, obs[k + 1].t - obs[k].t)
    const h = 0.5 * dt * dt
    const f = Pf[k]
    // Pf·Fᵀ
    const b: M3 = [
      f[0] + dt * f[1] + h * f[2], f[1] + dt * f[2], f[2],
      f[3] + dt * f[4] + h * f[5], f[4] + dt * f[5], f[5],
      f[6] + dt * f[7] + h * f[8], f[7] + dt * f[8], f[8],
    ]
    const pi = inv3(Pp[k + 1])
    const d0 = xs[0] - xp[k + 1][0], d1 = xs[1] - xp[k + 1][1], d2 = xs[2] - xp[k + 1][2]
    const w0 = pi[0] * d0 + pi[1] * d1 + pi[2] * d2
    const w1 = pi[3] * d0 + pi[4] * d1 + pi[5] * d2
    const w2 = pi[6] * d0 + pi[7] * d1 + pi[8] * d2
    const xk = xf[k]
    xs = [xk[0] + b[0] * w0 + b[1] * w1 + b[2] * w2, xk[1] + b[3] * w0 + b[4] * w1 + b[5] * w2, xk[2] + b[6] * w0 + b[7] * w1 + b[8] * w2]
    out[k] = { t: obs[k].t, p: xs[0], v: xs[1], a: xs[2] }
  }
  return out
}

/**
 * The white-jerk model's path between two smoothed states: the quintic Hermite through both positions, velocities and
 * accelerations. t is clamped to [a.t, b.t]; a degenerate segment returns b.
 */
export function quintic(a: Knot3, b: Knot3, t: number): { p: number; v: number; a: number } {
  const h = b.t - a.t
  if (!(h > 0)) return { p: b.p, v: b.v, a: b.a }
  const s = (Math.min(b.t, Math.max(a.t, t)) - a.t) / h
  const s2 = s * s
  const s3 = s2 * s
  const s4 = s3 * s
  const s5 = s4 * s
  const va = a.v * h
  const vb = b.v * h
  const aa = a.a * h * h
  const ab = b.a * h * h
  const p =
    (1 - 10 * s3 + 15 * s4 - 6 * s5) * a.p + (s - 6 * s3 + 8 * s4 - 3 * s5) * va + (0.5 * s2 - 1.5 * s3 + 1.5 * s4 - 0.5 * s5) * aa +
    (10 * s3 - 15 * s4 + 6 * s5) * b.p + (-4 * s3 + 7 * s4 - 3 * s5) * vb + (0.5 * s3 - s4 + 0.5 * s5) * ab
  const dp =
    (-30 * s2 + 60 * s3 - 30 * s4) * (a.p - b.p) + (1 - 18 * s2 + 32 * s3 - 15 * s4) * va + (s - 4.5 * s2 + 6 * s3 - 2.5 * s4) * aa +
    (-12 * s2 + 28 * s3 - 15 * s4) * vb + (1.5 * s2 - 4 * s3 + 2.5 * s4) * ab
  const ddp =
    (-60 * s + 180 * s2 - 120 * s3) * (a.p - b.p) + (-36 * s + 96 * s2 - 60 * s3) * va + (1 - 9 * s + 18 * s2 - 10 * s3) * aa +
    (-24 * s + 84 * s2 - 60 * s3) * vb + (3 * s - 12 * s2 + 10 * s3) * ab
  return { p, v: dp / h, a: ddp / (h * h) }
}

/**
 * Least-squares slope of (ts, hs) over the points within ±halfWindowS of each point: the height trend a reported
 * vertical rate is checked against. 0 where fewer than two points (or no time spread) fall in the window.
 */
export function trendSlopes(ts: readonly number[], hs: readonly number[], halfWindowS: number): number[] {
  const out: number[] = new Array(ts.length)
  let lo = 0
  let hi = 0
  for (let i = 0; i < ts.length; i++) {
    while (ts[lo] < ts[i] - halfWindowS) lo++
    while (hi < ts.length && ts[hi] <= ts[i] + halfWindowS) hi++
    let st = 0
    let sh = 0
    const m = hi - lo
    for (let j = lo; j < hi; j++) {
      st += ts[j]
      sh += hs[j]
    }
    const tm = st / m
    const hm = sh / m
    let num = 0
    let den = 0
    for (let j = lo; j < hi; j++) {
      num += (ts[j] - tm) * (hs[j] - hm)
      den += (ts[j] - tm) ** 2
    }
    out[i] = m >= 2 && den > 0 ? num / den : 0
  }
  return out
}

// client/track/hermite.ts
// Horizontal motion between and after samples, in a local ENU frame (t s, e/n m, ve/vn m/s).
import type { KinPoint } from './types.ts'

export interface HState {
  e: number
  n: number
  ve: number
  vn: number
}

/**
 * Cubic Hermite interpolation on e and n. Tangents are the sampled velocities scaled by the segment
 * length (b.t − a.t), so the curve passes through both positions with both velocities, and a
 * constant-velocity line is reproduced exactly. t is clamped to [a.t, b.t].
 */
export function hermite(a: KinPoint, b: KinPoint, t: number): HState {
  const h = b.t - a.t
  if (!(h > 0)) return { e: b.e, n: b.n, ve: b.ve, vn: b.vn } // degenerate segment: the newest point wins
  const s = (Math.min(b.t, Math.max(a.t, t)) - a.t) / h
  const s2 = s * s
  const s3 = s2 * s
  const h00 = 2 * s3 - 3 * s2 + 1
  const h01 = -2 * s3 + 3 * s2
  const h10 = s3 - 2 * s2 + s
  const h11 = s3 - s2
  // d/ds of the basis; dh01 = −dh00. Written so s = 0 and s = 1 return a's and b's values bit-exactly.
  const d00 = 6 * s2 - 6 * s
  const d10 = 3 * s2 - 4 * s + 1
  const d11 = 3 * s2 - 2 * s
  return {
    e: h00 * a.e + h01 * b.e + h * (h10 * a.ve + h11 * b.ve),
    n: h00 * a.n + h01 * b.n + h * (h10 * a.vn + h11 * b.vn),
    ve: (d00 * (a.e - b.e)) / h + d10 * a.ve + d11 * b.ve,
    vn: (d00 * (a.n - b.n)) / h + d10 * a.vn + d11 * b.vn,
  }
}

/**
 * Dead reckoning after the newest sample: constant speed and constant turn rate, on the exact circular arc.
 * turnRateDegS > 0 turns right (clockwise seen from above, track angle increasing); 0 is a straight line.
 */
export function extrapolate(last: KinPoint, turnRateDegS: number, dtS: number): HState {
  const x = (turnRateDegS * Math.PI * dtS) / 360 // half of the heading change, radians
  const k = x === 0 ? dtS : (dtS * Math.sin(x)) / x // chord length / speed (sinc form: no cancellation for tiny turns)
  const c = Math.cos(x)
  const s = Math.sin(x)
  // The chord points along the velocity turned clockwise by x; the final velocity is turned by 2x.
  const c2 = c * c - s * s
  const s2 = 2 * s * c
  return {
    e: last.e + k * (last.ve * c + last.vn * s),
    n: last.n + k * (last.vn * c - last.ve * s),
    ve: last.ve * c2 + last.vn * s2,
    vn: last.vn * c2 - last.ve * s2,
  }
}

/**
 * Hides the jump when a fresh sample corrects an extrapolated or stale path. start() takes the error
 * (previously rendered position − new estimate) at tS; add offset(t) to the new estimate. The offset
 * decays with a raised cosine, (1 + cos πu)/2 for u = (t − tS)/durationS: it starts and ends with zero
 * slope, so rendered velocity never jumps, and it is exactly 0 from tS + durationS on. Before any
 * start(), and for t < tS, the offset is 0.
 */
export class RejoinBlend {
  #durationS: number
  #t0 = NaN
  #e = 0
  #n = 0

  constructor(durationS = 1.5) {
    this.#durationS = durationS
  }

  start(errE: number, errN: number, tS: number): void {
    this.#e = errE
    this.#n = errN
    this.#t0 = tS
  }

  offset(tS: number): { e: number; n: number } {
    if (!(tS >= this.#t0) || tS >= this.#t0 + this.#durationS) return { e: 0, n: 0 }
    const w = (1 + Math.cos((Math.PI * (tS - this.#t0)) / this.#durationS)) / 2
    return { e: this.#e * w, n: this.#n * w }
  }
}

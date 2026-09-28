// client/track/hermite.ts
// Horizontal motion after the newest sample, and the blend that hides a correction (local ENU: t s, e/n m, ve/vn m/s).
import type { KinPoint } from './types.ts'

export interface HState {
  e: number
  n: number
  ve: number
  vn: number
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

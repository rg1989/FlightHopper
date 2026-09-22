// client/track/attitude.ts
import type { Att, Phase } from './types.ts'

const G = 9.80665
const DEG = 180 / Math.PI
const AOA_DEG: Record<Phase, number> = { ground: 0, takeoff: 6, climb: 6, cruise: 2, descent: 2, approach: 4, landing: 4 }
const LEVEL_MS = 1.5 // |vs| under ≈ 300 fpm counts as level when the phase is unknown

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const wrap360 = (d: number): number => ((d % 360) + 360) % 360
const wrap180 = (d: number): number => wrap360(d + 180) - 180

export interface AttitudeInput {
  gsMs: number
  vsMs: number
  headingDeg: number
  broadcastRollDeg: number | null
  turnRateDegS: number // + = right turn
  onGround: boolean
  phase: Phase | null
  mlat: boolean
}

/**
 * Synthesised attitude (ADS-B carries no pitch and rarely roll).
 * pitch = flight-path angle atan2(vs, gs) + AoA(phase), clamped to [−15, 25]. AoA: ground 0, takeoff/climb 6,
 * cruise/descent 2, approach/landing 4. phase null → climb above +1.5 m/s, descent below −1.5 m/s, else cruise.
 * roll = broadcast ?? coordinated turn atan(V·ω/g), clamped ±35; 0 on the ground or for MLAT.
 * On the ground pitch is 0 too.
 */
export function targetAttitude(i: AttitudeInput): Att {
  const headingDeg = wrap360(i.headingDeg)
  if (i.onGround) return { headingDeg, pitchDeg: 0, rollDeg: 0 }
  // ponytail: phase from vs alone cannot tell approach from descent (pitch −1° instead of +1° on a glide);
  // upgrade path is the M4 phase detector passing `phase`.
  const phase = i.phase ?? (i.vsMs > LEVEL_MS ? 'climb' : i.vsMs < -LEVEL_MS ? 'descent' : 'cruise')
  const pitchDeg = clamp(Math.atan2(i.vsMs, i.gsMs) * DEG + AOA_DEG[phase], -15, 25)
  const roll = i.mlat ? 0 : i.broadcastRollDeg ?? Math.atan((i.gsMs * (i.turnRateDegS / DEG)) / G) * DEG
  return { headingDeg, pitchDeg, rollDeg: clamp(roll, -35, 35) }
}

/** First-order lag on each axis, exact for any dt: x += (target − x)·(1 − e^(−dt/τ)). Heading takes the short way. */
export class AttitudeSmoother {
  private readonly tauS: number
  private cur: Att | null = null

  /** tauS default 1 s: damps the ~1 Hz jitter of per-sample turn rates without a visible lag in roll-in. */
  constructor(tauS = 1) {
    this.tauS = tauS
  }

  step(target: Att, dtS: number): Att {
    const c = this.cur
    if (c === null) {
      this.cur = { headingDeg: wrap360(target.headingDeg), pitchDeg: target.pitchDeg, rollDeg: target.rollDeg }
    } else if (dtS > 0) {
      const k = 1 - Math.exp(-dtS / this.tauS)
      this.cur = {
        headingDeg: wrap360(c.headingDeg + k * wrap180(target.headingDeg - c.headingDeg)),
        pitchDeg: c.pitchDeg + k * (target.pitchDeg - c.pitchDeg),
        rollDeg: c.rollDeg + k * (target.rollDeg - c.rollDeg),
      }
    }
    return { ...this.cur! }
  }
}

/** Signed track change rate in °/s, + = right turn, wrap-safe across north. 0 when dtS ≤ 0. */
export function turnRateDegS(prevTrackDeg: number, trackDeg: number, dtS: number): number {
  return dtS > 0 ? wrap180(trackDeg - prevTrackDeg) / dtS : 0
}

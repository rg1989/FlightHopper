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

/** Signed track change rate in °/s, + = right turn, wrap-safe across north. 0 when dtS ≤ 0. */
export function turnRateDegS(prevTrackDeg: number, trackDeg: number, dtS: number): number {
  return dtS > 0 ? wrap180(trackDeg - prevTrackDeg) / dtS : 0
}

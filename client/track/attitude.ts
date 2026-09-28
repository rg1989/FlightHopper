// client/track/attitude.ts
// Attitude from flight mechanics (.planning/flight-physics-design.md §3). ADS-B carries no pitch and its roll is a
// sparse, often stale radar reply, so the attitude is what the smoothed path requires of a real aircraft:
//   pitch = flight-path angle γ + angle of attack α, α from the lift the aircraft needs at its speed and load factor;
//   bank = the coordinated-turn bank for the path's turn rate.
// AttitudeFilter then gives it the inertia of a real airframe (critically damped, rate-limited).
import type { Att } from './types.ts'

const G = 9.80665
const DEG = 180 / Math.PI
const KT = 1852 / 3600

// The lift model, calibrated on a medium jet (A320/B737) as flown. With landing flap at the reference (approach) speed
// the body angle of attack is 6°; between V_ref and ~1.6 V_ref crews set the flaps for the speed, which holds it near
// 5–6°; above that the wing is clean and follows the lift law (≈ 2° in cruise). Below V_ref it rises as 1/V².
const CL_REF = 1.55 // lift coefficient at V_ref, 1 g, landing flap
const CL_PER_DEG = 0.09 // lift-curve slope, per degree of body angle of attack
const ALPHA0_CLEAN = -3.2 // body angle of attack at zero lift, flaps up
const ALPHA0_FULL = -11.2 // …with landing flap
const ALPHA_REF = ALPHA0_FULL + CL_REF / CL_PER_DEG // 6.0°: at V_ref, 1 g, landing flap
const FLAP_SLOPE = 1 // ° less per V_ref of extra speed while the flaps follow the speed
const CLEAN_FROM_X = 1.45 // the flaps are fully in between these speeds (EAS / V_ref)
const CLEAN_TO_X = 1.7
const MIN_X = 0.85 // an airspeed under this would be a stall: bad data or a wrong category
const MIN_X_GUESSED = 1 // from the ground speed (unknown wind), never slower than the approach speed…
const MAX_X_GUESSED = 2.1 // …nor faster than a fast descent
const V_REF: Readonly<Record<string, number>> = { A1: 65, A2: 115, A3: 140, A4: 140, A5: 150, A6: 150 }
// Airborne, drag with speedbrakes out slows an airliner by under ~1 m/s²; brakes and reversers on the runway by 2–3.
// Braking harder than BRAKE_FROM (and nearly level) is a rollout the ground flag has not caught up with yet.
const BRAKE_FROM_MS2 = 0.8
const BRAKE_TO_MS2 = 1.8
const ROTOR_PITCH_DEG = -5 // a helicopter's nose-down attitude at ROTOR_KT, in proportion below it
const ROTOR_KT = 120

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const wrap360 = (d: number): number => ((d % 360) + 360) % 360
const wrap180 = (d: number): number => wrap360(d + 180) - 180
const smoothstep = (e0: number, e1: number, x: number): number => {
  const u = clamp((x - e0) / (e1 - e0), 0, 1)
  return u * u * (3 - 2 * u)
}

/** ISA air density relative to sea level at geometric height altM (troposphere, then the isothermal stratosphere). */
export function densityRatio(altM: number): number {
  const h = Math.max(0, altM)
  return h <= 11_000 ? (1 - 2.25577e-5 * h) ** 4.25588 : 0.29708 * Math.exp(-(h - 11_000) / 6341.62)
}

/** Reference (approach) speed by ADS-B emitter category; null where no fixed-wing model applies (rotorcraft, gliders, balloons, vehicles). */
export function vRefKt(category: string | null): number | null {
  if (category === null || category === '' || category === 'A0') return V_REF.A3
  return V_REF[category] ?? null
}

/** What the attitude depends on, all from the smoothed path at render time. */
export interface FlightState {
  gsMs: number // ground speed
  vsMs: number // vertical speed, + up
  turnRateDegS: number // track turn rate, + right
  alongMs2: number // acceleration along the track (− braking)
  easKt: number | null // equivalent airspeed (IAS when broadcast); null: estimated from gsMs and the density
  altM: number // height for the density
  onGround: boolean
  category: string | null // ADS-B emitter category
}

/**
 * Pitch and bank a real aircraft needs to fly this state: pitch = flight-path angle + body angle of attack, the angle
 * of attack being what the lift needs at this speed (relative to V_ref) and load factor, with the flaps where crews set
 * them. No thresholds anywhere: the attitude is continuous in every input.
 */
export function aeroPitchRoll(s: FlightState): { pitchDeg: number; rollDeg: number } {
  if (s.onGround) return { pitchDeg: 0, rollDeg: 0 }
  const rollDeg = clamp(Math.atan((s.gsMs * (s.turnRateDegS / DEG)) / G) * DEG, -45, 45)
  const vRef = vRefKt(s.category)
  if (vRef === null) {
    // No wing to fly: a rotorcraft tilts forward with speed; the rest (balloons, gliders on tow, vehicles) stay level.
    const pitchDeg = s.category === 'A7' ? ROTOR_PITCH_DEG * Math.min(1, s.gsMs / KT / ROTOR_KT) : 0
    return { pitchDeg, rollDeg }
  }
  const gammaDeg = Math.atan2(s.vsMs, Math.max(s.gsMs, 1)) * DEG
  // ponytail: without a broadcast airspeed the ground speed stands in (±wind); upgrade: the wind other aircraft report nearby.
  const x = s.easKt !== null
    ? Math.max(s.easKt / vRef, MIN_X)
    : clamp(((s.gsMs / KT) * Math.sqrt(densityRatio(s.altM))) / vRef, MIN_X_GUESSED, MAX_X_GUESSED)
  const clean = smoothstep(CLEAN_FROM_X, CLEAN_TO_X, x)
  const flapAlpha = x < 1 ? ALPHA0_FULL + CL_REF / (x * x * CL_PER_DEG) : ALPHA_REF - FLAP_SLOPE * (x - 1)
  const cleanAlpha = ALPHA0_CLEAN + CL_REF / (x * x * CL_PER_DEG)
  const alpha1g = flapAlpha + (cleanAlpha - flapAlpha) * clean
  const alpha0 = ALPHA0_FULL + (ALPHA0_CLEAN - ALPHA0_FULL) * clean
  // The load factor of the turn scales the lift, so the angle of attack above zero lift. (A pull-up's would too, but
  // from 25 ft altitude steps its estimate is mostly noise: measured, it made the pitch wobble 30 % more on final.)
  const n = 1 / Math.cos(rollDeg / DEG)
  const alphaDeg = alpha0 + (alpha1g - alpha0) * n
  const rolling = smoothstep(BRAKE_FROM_MS2, BRAKE_TO_MS2, -s.alongMs2) * (1 - smoothstep(1, 2, Math.abs(s.vsMs)))
  return { pitchDeg: clamp(gammaDeg + alphaDeg, -15, 25) * (1 - rolling), rollDeg: rollDeg * (1 - rolling) }
}

const PITCH_RATE = 5 // °/s: a rotation is about 3°/s
const ROLL_RATE = 15 // °/s: airliners roll at 5–10°/s
const YAW_RATE = 10 // °/s

/**
 * A real airframe's inertia on each axis: a critically damped second-order response (ω = 4 rad/s: no overshoot, ~1 s to
 * settle, C1 even when the target has a corner), solved exactly for any step, then rate-limited. Heading takes the
 * short way. dt ≤ 0 holds the attitude.
 */
export class AttitudeFilter {
  readonly #w: number
  #x: Att | null = null
  #v = { headingDeg: 0, pitchDeg: 0, rollDeg: 0 }

  constructor(omega = 4) {
    this.#w = omega
  }

  step(target: Att, dtS: number): Att {
    const x = this.#x
    if (x === null) {
      this.#x = { headingDeg: wrap360(target.headingDeg), pitchDeg: target.pitchDeg, rollDeg: target.rollDeg }
      return { ...this.#x }
    }
    if (dtS > 0) {
      const w = this.#w
      const k = Math.exp(-w * dtS)
      const axis = (cur: number, err0: number, key: keyof Att, rate: number): number => {
        // e(t) = (e0 + (v0 + ω e0) t) e^(−ωt), e the distance from the target
        const v0 = this.#v[key]
        const b = v0 + w * err0
        const e = (err0 + b * dtS) * k
        const v = (v0 - w * b * dtS) * k
        const step = clamp(e - err0, -rate * dtS, rate * dtS)
        this.#v[key] = clamp(v, -rate, rate)
        return cur + step
      }
      this.#x = {
        headingDeg: wrap360(axis(x.headingDeg, -wrap180(target.headingDeg - x.headingDeg), 'headingDeg', YAW_RATE)),
        pitchDeg: axis(x.pitchDeg, x.pitchDeg - target.pitchDeg, 'pitchDeg', PITCH_RATE),
        rollDeg: axis(x.rollDeg, x.rollDeg - target.rollDeg, 'rollDeg', ROLL_RATE),
      }
    }
    return { ...this.#x! }
  }
}

/** Signed track change rate in °/s, + = right turn, wrap-safe across north. 0 when dtS ≤ 0. */
export function turnRateDegS(prevTrackDeg: number, trackDeg: number, dtS: number): number {
  return dtS > 0 ? wrap180(trackDeg - prevTrackDeg) / dtS : 0
}

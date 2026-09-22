// client/track/vertical.ts
import type { Sample } from '../../shared/types.ts'
import type { AltSource } from './types.ts'

const FT = 0.3048
const GEOM_GATE_M = 60 // v0/v1 alt_geom must sit within this of the baro chain to be trusted
const SLEW_MS = 0.5 // a rung-switch offset bleeds off at this rate, m/s
const BIAS_GAIN = 0.1 // per-sample EMA gain of (geom − raw baro), ≈ 10 s memory at 1 Hz
const ORDER: AltSource[] = ['geom', 'baro-qnh', 'baro-bias'] // ladder priority, best first

type Rungs = Partial<Record<AltSource, number>>

/**
 * Picks the best height for each sample, in WGS84 ellipsoidal metres. One instance per aircraft;
 * call height() in sample-time order. Rungs, best first:
 *  - geom: alt_geom when version === 2 (HAE by spec); v0/v1/unknown only within 60 m of the baro chain
 *    (or when there is no baro at all).
 *  - baro-qnh: (altBaroFt + (qnh − 1013.25)·27 ft/hPa)·0.3048 + N, when 950 ≤ qnh ≤ 1050 and altBaroFt < 18000.
 *  - baro-bias: altBaroFt·0.3048 + N + learned bias, the bias being an EMA of (trusted geom − raw baro).
 * A rung switch keeps the output continuous: the jump becomes an offset that bleeds to 0 at 0.5 m/s.
 * Returns null on the ground (and resets the continuity state) or when no rung is usable.
 */
export class AltitudeLadder {
  private bias: number | null = null
  private offset = 0
  private prev: { tMs: number; source: AltSource; rungs: Rungs } | null = null

  height(s: Sample): { hM: number; source: AltSource } | null {
    if (s.onGround) {
      this.prev = null
      this.offset = 0
      return null
    }
    const rungs: Rungs = {}
    const rawBaro = s.altBaroFt === null ? null : s.altBaroFt * FT + s.nM
    if (s.altBaroFt !== null && rawBaro !== null) {
      const q = s.navQnhHpa
      if (q !== null && q >= 950 && q <= 1050 && s.altBaroFt < 18000) rungs['baro-qnh'] = (s.altBaroFt + (q - 1013.25) * 27) * FT + s.nM
      rungs['baro-bias'] = rawBaro + (this.bias ?? 0)
    }
    const chain = rungs['baro-qnh'] ?? rungs['baro-bias']
    if (s.altGeomFt !== null) {
      const g = s.altGeomFt * FT
      if (s.version === 2 || chain === undefined || Math.abs(g - chain) <= GEOM_GATE_M) rungs.geom = g
    }
    const source = ORDER.find((k) => rungs[k] !== undefined)
    if (source === undefined) return null

    if (rungs.geom !== undefined && rawBaro !== null) {
      const d = rungs.geom - rawBaro
      this.bias = this.bias === null ? d : this.bias + BIAS_GAIN * (d - this.bias)
    }

    const p = this.prev
    if (p) {
      const dtS = Math.max(0, (s.tMs - p.tMs) / 1000)
      this.offset = Math.sign(this.offset) * Math.max(0, Math.abs(this.offset) - SLEW_MS * dtS)
      if (source !== p.source) {
        // Measure the jump between the two rungs at one instant: now if the old rung is still valid,
        // else at the previous sample (the old rung's current value is missing or untrusted).
        const now = rungs[p.source]
        const was = p.rungs[source]
        const jump = now !== undefined ? rungs[source]! - now
          : was !== undefined ? was - p.rungs[p.source]!
          : rungs[source]! - p.rungs[p.source]! // ponytail: includes dt of real motion; only when the rungs never overlapped
        this.offset -= jump
      }
    }
    this.prev = { tMs: s.tMs, source, rungs }
    return { hM: rungs[source]! + this.offset, source }
  }
}

interface State {
  t: number
  h: number
  v: number
}

const RATE_GAIN = 0.5 // how far a reported vertical rate pulls the velocity estimate per sample
const MAX_STATES = 600 // ponytail: ~10 min at 1 Hz; at() before the oldest kept state returns null. Render delay is ≤ 10 s.

/**
 * α-β filter over irregularly timed heights. t is in SECONDS (any epoch, consistent across calls), hM metres,
 * rateMs the reported vertical rate in m/s (geom_rate or baro_rate converted) or null.
 * Update per sample (dt = t − t_prev): predict h⁻ = h + v·dt; r = z − h⁻;
 *   h = h⁻ + α·r;  v = v + (β/dt)·r;  then, with a reported rate, v += RATE_GAIN·(rate − v).
 * at(t): null before the first state; cubic Hermite through the filtered (h, v) states between them;
 * h + v·(t − t_last) after the last.
 * Defaults α = 0.2, β = 0.02: the critically damped pair (β = α²/(2 − α)) that turns 25 ft (7.6 m) quantisation
 * into ≈ 1–2 m height noise while the β term still absorbs a biased or missing rate within ~20 samples.
 */
export class VerticalFilter {
  private readonly alpha: number
  private readonly beta: number
  private readonly states: State[] = []

  constructor(opts: { alpha?: number; beta?: number } = {}) {
    this.alpha = opts.alpha ?? 0.2
    this.beta = opts.beta ?? 0.02
  }

  add(t: number, hM: number, rateMs: number | null): void {
    const last = this.states.at(-1)
    if (last === undefined) {
      this.states.push({ t, h: hM, v: rateMs ?? 0 })
      return
    }
    const dt = t - last.t
    if (!(dt > 0)) return
    const hPred = last.h + last.v * dt
    const r = hM - hPred
    let v = last.v + (this.beta / dt) * r
    if (rateMs !== null) v += RATE_GAIN * (rateMs - v)
    this.states.push({ t, h: hPred + this.alpha * r, v })
    if (this.states.length > MAX_STATES) this.states.shift()
  }

  at(t: number): { hM: number; vsMs: number } | null {
    const st = this.states
    if (st.length === 0 || t < st[0].t) return null
    const last = st[st.length - 1]
    if (t >= last.t) return { hM: last.h + last.v * (t - last.t), vsMs: last.v }
    let i = st.length - 2
    while (st[i].t > t) i-- // render time sits near the newest states, so scan from the end
    return hermite(st[i], st[i + 1], t)
  }
}

function hermite(a: State, b: State, t: number): { hM: number; vsMs: number } {
  const dt = b.t - a.t
  const s = (t - a.t) / dt
  const s2 = s * s
  const s3 = s2 * s
  const hM = (2 * s3 - 3 * s2 + 1) * a.h + (s3 - 2 * s2 + s) * dt * a.v + (-2 * s3 + 3 * s2) * b.h + (s3 - s2) * dt * b.v
  const vsMs = ((6 * s2 - 6 * s) * a.h + (-6 * s2 + 6 * s) * b.h) / dt + (3 * s2 - 4 * s + 1) * a.v + (3 * s2 - 2 * s) * b.v
  return { hM, vsMs }
}

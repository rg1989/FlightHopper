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

// tools/bench-track.ts
// Gate G2 motion bench (PLAN.md §6). Step 1: the metric set and the G2 bars. The causal replay that fills the
// metrics, and the CLI that writes the report, come in the next step.
import type { Quality } from '../shared/types.ts'

const G = 9.80665
const TURN_BAR_M: Record<number, number> = { 3: 5, 5: 15 } // G2: decimated to 3 s / 5 s (1 Hz recordings, so k = seconds)

export interface CrossTrack {
  k: number
  nTurn: number
  nStraight: number
  turnP95M: number
  straightP95M: number
  linearTurnP95M: number // the same held-out turn points scored against straight lines between kept samples
}

export interface G2Metrics {
  hex: string
  quality: Quality // the session's most common quality
  samples: number // deduped samples in the session
  frames: number
  delayS: { start: number; p50: number; max: number }
  starvationFrames: number // not 'interp' although the bracketing samples are ≤ 10 s apart
  gapFrames: number // not 'interp' inside a coverage gap (> 10 s between samples): reported, not gated
  frameDiscontinuity: { maxM: number; p99M: number }
  lateralAccel: { p99: number; max: number }
  jerk: { p99: number }
  vertical: { vsErrP95: number; maxStepM: number }
  delaySlew: number
  rejoin: { count: number; errP95M: number; blendMaxS: number }
  crossTrack: CrossTrack[]
  dedupe: { served: number; unique: number; duplicateFraction: number; jerkP99NoDedupe: number | null }
}

export interface G2Check {
  name: string
  value: number
  threshold: number
  pass: boolean
}

/**
 * G2 motion bars (PLAN.md §6). ADS-B (the v2 table): interpolation discontinuity ≤ 2 m, 0 starvation frames, held-out
 * turn cross-track p95 ≤ 5 m at k = 3 and ≤ 15 m at k = 5 and ≤ 50 % of linear, lateral acceleration p99 ≤ 5.7 m/s²,
 * VS error p95 ≤ 2 m/s, height step ≤ 1 m per frame, delay slew ≤ 0.2 s/s, re-join blended ≤ 1.5 s. An MLAT hex is held
 * to its separate bar only: lateral acceleration p99 ≤ 0.5 g. NaN (no data) fails; 1e-9 absorbs float noise at a bar.
 */
export function evaluateG2(m: G2Metrics): { pass: boolean; checks: G2Check[] } {
  const check = (name: string, value: number, threshold: number): G2Check => ({ name, value, threshold, pass: value <= threshold + 1e-9 })
  const done = (checks: G2Check[]): { pass: boolean; checks: G2Check[] } => ({ pass: checks.every((c) => c.pass), checks })
  if (m.quality === 'mlat') return done([check('lateralAccelP99', m.lateralAccel.p99, 0.5 * G)])
  return done([
    check('frameDiscontinuityMaxM', m.frameDiscontinuity.maxM, 2),
    check('starvationFrames', m.starvationFrames, 0),
    ...[3, 5].flatMap((k) => {
      const c = m.crossTrack.find((x) => x.k === k)
      return [
        check(`crossTrackTurnP95M@${k}`, c?.turnP95M ?? NaN, TURN_BAR_M[k]),
        check(`crossTrackTurnVsLinear@${k}`, c ? c.turnP95M / c.linearTurnP95M : NaN, 0.5),
      ]
    }),
    check('lateralAccelP99', m.lateralAccel.p99, 5.7),
    check('vsErrP95', m.vertical.vsErrP95, 2),
    check('verticalMaxStepM', m.vertical.maxStepM, 1),
    check('delaySlew', m.delaySlew, 0.2),
    check('rejoinBlendMaxS', m.rejoin.blendMaxS, 1.5),
  ])
}

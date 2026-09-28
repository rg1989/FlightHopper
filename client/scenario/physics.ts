// client/scenario/physics.ts
// Whether a scenario's track is one an airliner could fly: the checks every package must pass (physics.test.ts runs
// them over public/scenarios/*), so that a package whose sources disagree (an altitude on one clock, an airspeed on
// another; a pitch that is not the path's) is caught when it is built, not by a viewer who sees an aircraft fall while
// it slows down. Each limit is the airframe's, plus an allowance for what recorder charts and radar can resolve:
//   - the path is never steeper than ~64° (|V/S| ≤ 0.9 TAS: a vertical speed past the airspeed is no flight at all);
//   - the attitude is the path's: pitch − the path's angle through the air (the angle of attack) within −10…+20°
//     (an airliner stalls at ~15°, and flies at 2–8°);
//   - energy: height + TAS²/2g changes no faster than engines and drag allow (|Ps| ≲ 40 m/s, an airliner at full
//     thrust or at idle in a 3-g pull), plus the data's own slack: ≤ 110 m/s over 12 s, ≤ 75 m/s over 30 s;
//   - where the track gives the wind, it moves over the ground at its airspeed plus that wind: 99 % of rows within 80 kt.
// Rows airborne, with an airspeed; heights and positions between rows linear.
import { specificEnergyM, trueAirspeedKt } from '../track/airspeed.ts'
import type { TrackRow } from './types.ts'

const FT = 0.3048
const KT = 1852 / 3600
const DEG = 180 / Math.PI
const M_PER_DEG = 111_195

export const PHYSICS_LIMITS = { steep: 0.9, alphaMin: -10, alphaMax: 20, ps12: 110, ps30: 75, airP99Kt: 80 } as const

export interface PhysicsReport {
  rows: number // airborne rows with an airspeed
  steep: number // the largest |V/S| / TAS
  alpha: [number, number] // the smallest and largest pitch − flight-path angle, °
  ps12: number // the largest |d(specific energy)/dt| over 12 s, m/s
  ps30: number // …over 30 s
  airP99Kt: number | null // 99th percentile of | |ground − wind| − horizontal TAS |, kt; null without a wind
  problems: string[] // one line per limit broken, with where
}

const clock = (t: number): string => {
  const s = Math.round(t)
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function physicsReport(track: readonly TrackRow[]): PhysicsReport {
  const t = track.map((r) => r.t)
  const lerp = (xs: readonly number[], at: number): number => {
    if (at <= t[0]) return xs[0]
    if (at >= t[t.length - 1]) return xs[xs.length - 1]
    let lo = 0
    let hi = t.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (t[mid] <= at) lo = mid
      else hi = mid
    }
    return xs[lo] + ((at - t[lo]) / (t[hi] - t[lo])) * (xs[hi] - xs[lo])
  }
  const hM = track.map((r) => r.altFt * FT)
  const lat0 = track[0].lat
  const eM = track.map((r) => (r.lon - track[0].lon) * M_PER_DEG * Math.cos(lat0 / DEG))
  const nM = track.map((r) => (r.lat - lat0) * M_PER_DEG)
  const tasMs = track.map((r) => (r.iasKt !== null && r.iasKt > 0 ? trueAirspeedKt(r.iasKt, r.altFt) * KT : Number.NaN))
  const energy = hM.map((h, i) => specificEnergyM(h, tasMs[i]))
  const known = t.filter((_, i) => Number.isFinite(energy[i]))
  const [kt0, kt1] = [known[0] ?? Infinity, known[known.length - 1] ?? -Infinity]
  const eKnown = t.map((_, i) => i).filter((i) => Number.isFinite(energy[i]))
  const energyAt = (at: number): number => {
    let j = eKnown.findIndex((i) => t[i] >= at)
    if (j <= 0) return energy[eKnown[Math.max(0, j)]]
    const [a, b] = [eKnown[j - 1], eKnown[j]]
    return energy[a] + ((at - t[a]) / (t[b] - t[a])) * (energy[b] - energy[a])
  }
  const worst = { steep: [0, 0], aLo: [Infinity, 0], aHi: [-Infinity, 0], ps12: [0, 0], ps30: [0, 0] }
  const air: number[] = []
  let rows = 0
  for (let i = 0; i < track.length; i++) {
    const r = track[i]
    const v = tasMs[i]
    if (r.gnd || !Number.isFinite(v) || r.t - 1 < t[0] || r.t + 1 > t[t.length - 1]) continue // (rates over ±1 s)
    rows++
    const vs = (lerp(hM, r.t + 1) - lerp(hM, r.t - 1)) / 2
    const steep = Math.abs(vs) / v
    if (steep > worst.steep[0]) worst.steep = [steep, r.t]
    const alpha = r.pitch - Math.asin(Math.max(-1, Math.min(1, vs / v))) * DEG
    if (alpha < worst.aLo[0]) worst.aLo = [alpha, r.t]
    if (alpha > worst.aHi[0]) worst.aHi = [alpha, r.t]
    for (const [half, key] of [[6, 'ps12'], [15, 'ps30']] as const) {
      if (r.t - half < kt0 || r.t + half > kt1) continue
      const ps = Math.abs(energyAt(r.t + half) - energyAt(r.t - half)) / (2 * half)
      if (ps > worst[key][0]) worst[key] = [ps, r.t]
    }
    if (r.windFromDeg !== null && r.windKt !== null) {
      const ge = (lerp(eM, r.t + 1) - lerp(eM, r.t - 1)) / 2
      const gn = (lerp(nM, r.t + 1) - lerp(nM, r.t - 1)) / 2
      const [wx, wy] = [-r.windKt * KT * Math.sin(r.windFromDeg / DEG), -r.windKt * KT * Math.cos(r.windFromDeg / DEG)]
      const horizontal = Math.sqrt(Math.max(0, v * v - vs * vs))
      air.push(Math.abs(Math.hypot(ge - wx, gn - wy) - horizontal) / KT)
    }
  }
  const L = PHYSICS_LIMITS
  const airP99Kt = air.length > 0 ? [...air].sort((a, b) => a - b)[Math.min(air.length - 1, Math.floor(0.99 * air.length))] : null
  const problems: string[] = []
  if (worst.steep[0] > L.steep) problems.push(`the vertical speed reaches ${worst.steep[0].toFixed(2)} × the true airspeed at ${clock(worst.steep[1])} (≤ ${L.steep})`)
  if (worst.aLo[0] < L.alphaMin) problems.push(`the nose is ${(-worst.aLo[0]).toFixed(0)}° below the path at ${clock(worst.aLo[1])} (angle of attack ≥ ${L.alphaMin}°)`)
  if (worst.aHi[0] > L.alphaMax) problems.push(`the nose is ${worst.aHi[0].toFixed(0)}° above the path at ${clock(worst.aHi[1])} (angle of attack ≤ ${L.alphaMax}°)`)
  if (worst.ps12[0] > L.ps12) problems.push(`energy changes at ${worst.ps12[0].toFixed(0)} m/s over 12 s at ${clock(worst.ps12[1])} (≤ ${L.ps12})`)
  if (worst.ps30[0] > L.ps30) problems.push(`energy changes at ${worst.ps30[0].toFixed(0)} m/s over 30 s at ${clock(worst.ps30[1])} (≤ ${L.ps30})`)
  if (airP99Kt !== null && airP99Kt > L.airP99Kt) problems.push(`over the ground, 1 % of rows are more than ${airP99Kt.toFixed(0)} kt off the airspeed plus the wind (≤ ${L.airP99Kt})`)
  return { rows, steep: worst.steep[0], alpha: [worst.aLo[0], worst.aHi[0]], ps12: worst.ps12[0], ps30: worst.ps30[0], airP99Kt, problems }
}

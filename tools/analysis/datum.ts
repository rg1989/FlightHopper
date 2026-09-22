// tools/analysis/datum.ts
// G2 datum check: is ADS-B v2 alt_geom really WGS84 ellipsoidal height (HAE)?
// On short final an arrival flies the 3° glidepath, so alt_geom·0.3048 ≈ thrHaeM + 15 m + d·tan 3°.
// If alt_geom were MSL instead, the residual would sit at −N: ≈ +32 m at KSFO, ≈ −20 m at LLBG.
import type { RunwayEnd } from '../../shared/airports.ts'
import { bearingDeg, distanceNm } from '../../shared/geo.ts'
import type { Sample } from '../../shared/types.ts'

const FT = 0.3048
const TCH_M = 15 // nominal threshold crossing height
const TAN_GLIDE = Math.tan((3 * Math.PI) / 180)
const ARRIVAL_GAP_MS = 10 * 60_000 // same hex seen again after this long = a new arrival
const MAX_TRACK_ERR_DEG = 30

export interface Residual {
  hex: string
  tMs: number
  dNm: number // distance before the threshold along the extended centreline
  rM: number // alt_geom (m) − nominal glidepath HAE (m)
  version: number | null // only version 2 counts toward the gate
}

/** q-quantile (0…1) with linear interpolation between order statistics; NaN for an empty list. */
export function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return Number.NaN
  const s = [...xs].sort((a, b) => a - b)
  const i = (s.length - 1) * q
  const lo = Math.floor(i)
  return lo + 1 < s.length ? s[lo] + (s[lo + 1] - s[lo]) * (i - lo) : s[lo]
}

/** Absolute difference between two directions, degrees in [0, 180]. */
export function angleDiffDeg(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360)
  return d > 180 ? 360 - d : d
}

/**
 * Position relative to a runway end's threshold: alongNm > 0 before the threshold (approach side),
 * crossM = lateral offset from the extended centreline, + = right of the landing direction.
 */
export function alongCross(lat: number, lon: number, end: RunwayEnd): { alongNm: number; crossM: number } {
  const d = distanceNm(end.thrLat, end.thrLon, lat, lon)
  const rel = ((bearingDeg(end.thrLat, end.thrLon, lat, lon) - end.hdgTrueDeg) * Math.PI) / 180
  return { alongNm: -d * Math.cos(rel), crossM: d * Math.sin(rel) * 1852 }
}

/**
 * Glidepath residuals for one runway end: airborne samples with alt_geom, 0.3–2 nm before the threshold,
 * within 100 m of the extended centreline and tracking within 30° of the landing heading
 * (the heading check keeps reciprocal-runway departures out). Every version is returned; the gate uses v2 only.
 */
export function approachResiduals(samples: Sample[], rwy: RunwayEnd): Residual[] {
  const out: Residual[] = []
  for (const s of samples) {
    if (s.onGround || s.altGeomFt === null || s.trackDeg === null) continue
    if (angleDiffDeg(s.trackDeg, rwy.hdgTrueDeg) > MAX_TRACK_ERR_DEG) continue
    const { alongNm, crossM } = alongCross(s.lat, s.lon, rwy)
    if (alongNm < 0.3 || alongNm > 2 || Math.abs(crossM) > 100) continue
    const glideM = rwy.thrHaeM + TCH_M + alongNm * 1852 * TAN_GLIDE
    out.push({ hex: s.hex, tMs: s.tMs, dNm: alongNm, rM: s.altGeomFt * FT - glideM, version: s.version })
  }
  return out
}

/** Distinct approaches: per hex, a new one starts after a gap > 10 min. */
function countArrivals(res: Residual[]): number {
  const byHex = new Map<string, number[]>()
  for (const r of res) {
    const ts = byHex.get(r.hex)
    if (ts) ts.push(r.tMs)
    else byHex.set(r.hex, [r.tMs])
  }
  let n = 0
  for (const ts of byHex.values()) {
    ts.sort((a, b) => a - b)
    n += 1 + ts.filter((t, i) => i > 0 && t - ts[i - 1] > ARRIVAL_GAP_MS).length
  }
  return n
}

/**
 * Datum verdict over ADS-B v2 residuals only (v0/v1 alt_geom may be MSL by design).
 * pass = ≥ minArrivals v2 arrivals and |median| ≤ 10 m. The median pools all v2 samples.
 * ponytail: pooled median, so a densely sampled arrival weighs more; per-arrival medians if one airframe dominates.
 */
export function summarizeDatum(res: Residual[], minArrivals = 3): { arrivals: number; n: number; medianM: number; pass: boolean } {
  const v2 = res.filter((r) => r.version === 2)
  const arrivals = countArrivals(v2)
  const medianM = quantile(v2.map((r) => r.rM), 0.5)
  return { arrivals, n: v2.length, medianM, pass: arrivals >= minArrivals && Math.abs(medianM) <= 10 }
}

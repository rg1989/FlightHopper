// tools/analysis/census.ts
// G2 coverage census: how low do recorded arrivals stay tracked at an airport?
// A landing hero needs ≥ 80 % of its arrivals tracked below 200 ft above the airport.
import type { Airport } from '../../shared/airports.ts'
import { distanceNm } from '../../shared/geo.ts'
import type { Sample } from '../../shared/types.ts'
import { alongCross, angleDiffDeg, quantile } from './datum.ts'

const FT = 0.3048
export const RADIUS_NM = 15 // samples farther from the airport reference point are ignored
const VISIT_GAP_MS = 10 * 60_000 // same hex seen again after this long = a new visit
const FINAL_MAX_NM = 12
const FINAL_HALF_WIDTH_M = 1852
const FINAL_MAX_AGL_FT = 5000
const FINAL_MAX_TRACK_ERR_DEG = 30
const LOW_FT = 1000
const BAD_NIC = 6
const JUMP_MIN_NM = 0.25

export interface Arrival {
  hex: string
  callsign: string | null
  minAglFt: number // lowest height above the airport while tracked; 0 once on the ground
  reachedGround: boolean // tracked through touchdown (an on-ground sample ends the arrival)
  p90GapBelow1000S: number | null // p90 of airborne sample gaps with an end below 1,000 ft AGL; null if never that low
  geomShare: number // airborne samples with alt_geom / airborne samples
  badNicShare: number // samples with nic < 6 / samples (GNSS interference)
  jumps: number // consecutive pairs implying > 1.5 × reported ground speed; a lone false position counts twice
}

/**
 * Height above the airport in feet: 0 on the ground; ADS-B v2 alt_geom (HAE) minus the airport's HAE;
 * otherwise baro corrected with the aircraft's own QNH setting; otherwise raw baro minus field elevation.
 * Raw pressure altitude is off by 27 ft per hPa of weather (±300 ft is normal), too coarse for a 200 ft test,
 * so the rungs follow the client's AltitudeLadder order (WP-C4).
 * ponytail: if the datum check shows v2 alt_geom is not HAE, this is off by N (≈ 106 ft at KSFO); drop rung 2 then.
 */
export function aglFt(s: Sample, ap: Airport): number | null {
  if (s.onGround) return 0
  if (s.version === 2 && s.altGeomFt !== null) return s.altGeomFt - (ap.elevFt + ap.nM / FT)
  if (s.altBaroFt === null) return null
  const q = s.navQnhHpa
  const qnhFt = q !== null && q >= 950 && q <= 1050 && s.altBaroFt < 18_000 ? (q - 1013.25) * 27 : 0
  return s.altBaroFt + qnhFt - ap.elevFt
}

/**
 * Established on final for one of the airport's runway ends: airborne, ≤ 5,000 ft AGL, ≤ 12 nm before a threshold,
 * ≤ 1 nm off its extended centreline and tracking within 30° of its landing heading.
 * ponytail: curved or offset approaches (LOWI) only count once aligned; widen the corridor if the census misses them.
 */
function onFinal(s: Sample, ap: Airport): boolean {
  const agl = aglFt(s, ap)
  const track = s.trackDeg
  if (s.onGround || track === null || agl === null || agl > FINAL_MAX_AGL_FT) return false
  return ap.runways.some((r) =>
    r.ends.some((e) => {
      if (angleDiffDeg(track, e.hdgTrueDeg) > FINAL_MAX_TRACK_ERR_DEG) return false
      const { alongNm, crossM } = alongCross(s.lat, s.lon, e)
      return alongNm > 0 && alongNm <= FINAL_MAX_NM && Math.abs(crossM) <= FINAL_HALF_WIDTH_M
    }),
  )
}

function measure(arr: Sample[], ap: Airport): Arrival {
  const agl = arr.map((s) => aglFt(s, ap))
  const low = (i: number): boolean => agl[i] !== null && agl[i]! < LOW_FT
  const airborne = arr.filter((s) => !s.onGround)
  const gaps: number[] = []
  let jumps = 0
  for (let i = 1; i < arr.length; i++) {
    const a = arr[i - 1]
    const b = arr[i]
    const dtS = (b.tMs - a.tMs) / 1000
    if (!a.onGround && (low(i - 1) || low(i))) gaps.push(dtS)
    const dNm = distanceNm(a.lat, a.lon, b.lat, b.lon)
    const refKt = Math.max(a.gsKt ?? 0, b.gsKt ?? 0) || 250
    if (dNm > JUMP_MIN_NM && dNm / (dtS / 3600) > 1.5 * refKt) jumps++
  }
  return {
    hex: arr[0].hex,
    callsign: arr.find((s) => s.callsign !== null)?.callsign ?? null,
    minAglFt: agl.reduce<number>((m, x) => (x === null ? m : Math.min(m, x)), Infinity),
    reachedGround: arr[arr.length - 1].onGround,
    p90GapBelow1000S: gaps.length > 0 ? quantile(gaps, 0.9) : null,
    geomShare: airborne.length > 0 ? airborne.filter((s) => s.altGeomFt !== null).length / airborne.length : 0,
    badNicShare: arr.filter((s) => s.nic !== null && s.nic < BAD_NIC).length / arr.length,
    jumps,
  }
}

/** Arrivals in one visit (time-sorted samples of one hex): from the last ground sample before final to touchdown. */
function arrivalsInVisit(v: Sample[], ap: Airport): { t: number; a: Arrival }[] {
  const out: { t: number; a: Arrival }[] = []
  let from = 0
  for (;;) {
    let i0 = from
    while (i0 < v.length && !onFinal(v[i0], ap)) i0++
    if (i0 === v.length) return out
    let start = i0
    while (start > from && !v[start - 1].onGround) start--
    let end = i0
    while (end < v.length - 1 && !v[end].onGround) end++
    out.push({ t: v[start].tMs, a: measure(v.slice(start, end + 1), ap) })
    from = end + 1
  }
}

/** Every arrival at `ap` in the samples (any hexes, any order), ordered by the time it was first seen. */
export function findArrivals(samples: Sample[], ap: Airport): Arrival[] {
  const byHex = new Map<string, Sample[]>()
  for (const s of samples) {
    if (distanceNm(ap.lat, ap.lon, s.lat, s.lon) > RADIUS_NM) continue
    const list = byHex.get(s.hex)
    if (list) list.push(s)
    else byHex.set(s.hex, [s])
  }
  const found: { t: number; a: Arrival }[] = []
  for (const list of byHex.values()) {
    list.sort((a, b) => a.tMs - b.tMs)
    let v0 = 0
    for (let i = 1; i <= list.length; i++) {
      if (i < list.length && list[i].tMs - list[i - 1].tMs <= VISIT_GAP_MS) continue
      found.push(...arrivalsInVisit(list.slice(v0, i), ap))
      v0 = i
    }
  }
  return found.sort((x, y) => x.t - y.t).map((x) => x.a)
}

/**
 * Airport-level census. Percentages are means over arrivals; p90GapBelow1000S is the p90 of the per-arrival p90s.
 * ponytail: no minimum sample size; the CLI flags fewer than 10 arrivals as indicative only.
 */
export function summarizeCensus(a: Arrival[]): {
  arrivals: number
  trackedBelow200Pct: number
  p90GapBelow1000S: number | null
  geomSharePct: number
  badNicPct: number
  landingHeroOk: boolean
} {
  const n = a.length
  const pct = (k: number): number => (n === 0 ? 0 : (100 * k) / n)
  const gaps = a.map((x) => x.p90GapBelow1000S).filter((g): g is number => g !== null)
  const trackedBelow200Pct = pct(a.filter((x) => x.minAglFt < 200).length)
  return {
    arrivals: n,
    trackedBelow200Pct,
    p90GapBelow1000S: gaps.length > 0 ? quantile(gaps, 0.9) : null,
    geomSharePct: pct(a.reduce((m, x) => m + x.geomShare, 0)),
    badNicPct: pct(a.reduce((m, x) => m + x.badNicShare, 0)),
    landingHeroOk: n > 0 && trackedBelow200Pct >= 80,
  }
}

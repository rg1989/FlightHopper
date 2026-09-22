// tools/record-arrivals.ts
// Arrival recorder (replaces tools/record-cells.ts). Task 1: which aircraft are landing at a hero airport.
import { distanceNm } from '../shared/geo.ts'
import type { Sample } from '../shared/types.ts'

export interface Hero {
  ident: string
  lat: number
  lon: number
  elevFt: number
}

/** Airport reference points and field elevations from OurAirports (data/fixtures/golden/airports-sample.json). */
export const HEROES: Hero[] = [
  { ident: 'KSFO', lat: 37.619806, lon: -122.374821, elevFt: 13 },
  { ident: 'LLBG', lat: 32.011398, lon: 34.8867, elevFt: 135 },
  { ident: 'LOWI', lat: 47.260201, lon: 11.344, elevFt: 1907 },
]

const PICK_NM = 25
const MAX_ABOVE_FIELD_FT = 10_000
const DESCENT_FPM = -300
const ROLL_KT = 30

/**
 * Hexes worth following to the runway. Per hex only its latest sample (largest tMs) counts: within 25 nm of a
 * hero, and either airborne below 10,000 ft above that field and descending faster than 300 fpm (baro rate, else
 * geometric rate; baro altitude, else geometric), or on the ground rolling faster than 30 kt (landing roll).
 */
export function pickArrivals(samples: Sample[], heroes: { ident: string; lat: number; lon: number; elevFt: number }[]): string[] {
  const latest = new Map<string, Sample>()
  for (const s of samples) {
    const p = latest.get(s.hex)
    if (!p || s.tMs > p.tMs) latest.set(s.hex, s)
  }
  const out: string[] = []
  for (const s of latest.values()) {
    const alt = s.altBaroFt ?? s.altGeomFt
    const rate = s.baroRateFpm ?? s.geomRateFpm
    const near = heroes.filter((h) => distanceNm(h.lat, h.lon, s.lat, s.lon) <= PICK_NM)
    const rolling = s.onGround && (s.gsKt ?? 0) > ROLL_KT
    const descending = !s.onGround && rate !== null && rate < DESCENT_FPM && alt !== null && near.some((h) => alt - h.elevFt < MAX_ABOVE_FIELD_FT)
    if (near.length > 0 && (rolling || descending)) out.push(s.hex)
  }
  return out
}

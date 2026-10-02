// client/scene/pathGap.ts
// The flown path's rule for a hole no receiver heard: routeLine.ts draws such a step dotted, and History places the
// selected aircraft along it while the replay time is inside one (history/aircraftDay.ts 'gap'), so the estimate is
// shown exactly where the line is dotted. No Cesium here: the history modules and their tests need not load the globe.
import { distanceNm } from '../../shared/geo.ts'

// A step longer than both was not heard: a gap. One of them alone is not: a parked or taxiing aircraft goes quiet for
// minutes a few hundred metres on, and a cruising jet covers 5 nm between two fixes 40 s apart.
export const GAP_S = 60
export const GAP_NM = 2

/** The step from a to b (in time order, tMs in whole ms) was not heard: longer than GAP_S and longer than GAP_NM. */
export function isGap(a: { tMs: number; lat: number; lon: number }, b: { tMs: number; lat: number; lon: number }): boolean {
  return b.tMs - a.tMs > GAP_S * 1000 && distanceNm(a.lat, a.lon, b.lat, b.lon) > GAP_NM
}

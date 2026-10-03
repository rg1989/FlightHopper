// client/scene/modelWind.ts
// The wind aloft from the weather model's grid (shared/wx.ts ModelGrid, Open-Meteo's forecast): the wind at an aircraft's place and
// pressure altitude, for the flight-data frame when the aircraft sends none of its own. It is a forecast, so the frame draws it as
// an estimate. It is the grid's nearest place's: the model's winds at its six pressure levels (850 to 200 hPa), the aircraft's height
// taken to a pressure by the standard atmosphere, the wind between two levels interpolated linearly in the log of the pressure, as
// vectors (east and north parts, never the angles: 270° and 90° must not make a south wind); above and below the levels, the
// nearest level's.
// ponytail: below the 850 hPa level (about 1,500 m) the wind is that level's, which near the ground is too strong and too far round
// (friction). Upgrade: ask the model for its 10 m wind as well and take it down to the ground.
import type { ModelGeo, ModelGrid } from '../../shared/wx.ts'
import { pressureHPa } from '../track/airspeed.ts'
import { wrapLon } from './wxGeo.ts'

/** The wind as the flight-data frame shows it: where it blows from (degrees true) and how hard (kt). */
export interface ModelWind {
  fromDeg: number
  kt: number
}

/** The index of the grid's place nearest lat, lon; -1 when that is more than a step beyond the grid's edge (the grid says nothing of it). */
export function nearestPlace(g: ModelGeo, lat: number, lon: number): number {
  const y = (lat - g.lat0) / g.step
  const x = wrapLon(lon - g.lon0) / g.step
  if (!(y >= -1 && y <= g.n && x >= -1 && x <= g.n)) return -1 // NaN too
  const clamp = (v: number): number => Math.min(g.n - 1, Math.max(0, Math.round(v)))
  return clamp(y) * g.n + clamp(x)
}

/** Whether lat, lon is in the middle half of the grid: within a quarter of its width of the middle, each way. Weather3D asks for a new grid when the aircraft is not. */
export function inInnerHalf(g: ModelGeo, lat: number, lon: number): boolean {
  const half = ((g.n - 1) / 2) * g.step // the grid's half width
  return Math.abs(lat - (g.lat0 + half)) <= half / 2 && Math.abs(wrapLon(lon - (g.lon0 + half))) <= half / 2
}

const RAD = Math.PI / 180

/**
 * The wind at a place and pressure altitude (ft), or null when the grid does not cover the place, the model has no wind there, or
 * a number is not one. A level with no wind at that place is left out: the others are interpolated across it.
 */
export function modelWindAt(g: ModelGrid, lat: number, lon: number, altFt: number): ModelWind | null {
  const p = Number.isFinite(altFt) ? nearestPlace(g, lat, lon) : -1
  if (p < 0) return null
  const levels: { hPa: number; east: number; north: number }[] = []
  for (const l of g.winds) {
    const kt = l.kt[p]
    const deg = l.deg[p]
    if (kt === null || deg === null || kt === undefined || deg === undefined) continue
    levels.push({ hPa: l.hPa, east: -kt * Math.sin(deg * RAD), north: -kt * Math.cos(deg * RAD) }) // the wind blows toward deg + 180
  }
  if (levels.length === 0) return null
  const hPa = pressureHPa(altFt)
  let east = levels[0].east
  let north = levels[0].north
  if (hPa < levels[0].hPa) {
    const i = levels.findIndex((l) => l.hPa <= hPa)
    if (i < 0) {
      east = levels[levels.length - 1].east
      north = levels[levels.length - 1].north
    } else {
      const [a, b] = [levels[i - 1], levels[i]]
      const t = Math.log(a.hPa / hPa) / Math.log(a.hPa / b.hPa) // 0 at a (the lower level), 1 at b
      east = a.east + t * (b.east - a.east)
      north = a.north + t * (b.north - a.north)
    }
  }
  const kt = Math.hypot(east, north)
  return kt < 1e-6 ? { fromDeg: 0, kt: 0 } : { fromDeg: (Math.atan2(-east, -north) / RAD + 360) % 360, kt }
}

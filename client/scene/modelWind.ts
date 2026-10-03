// client/scene/modelWind.ts
// The wind aloft from the weather model's grid (shared/wx.ts ModelGrid, Open-Meteo's forecast): the wind at an aircraft's place and
// pressure altitude, for the flight-data frame when the aircraft sends none of its own. It is a forecast, so the frame draws it as
// an estimate. At each of the model's six pressure levels (850 to 200 hPa) the wind at the aircraft's place is that of the four
// places of the grid round it, by how near each is (so it does not step as the aircraft crosses from one place to the next); the
// aircraft's height is taken to a pressure by the standard atmosphere and the wind between two levels interpolated linearly in the
// log of the pressure. Both interpolations are of vectors (east and north parts, never the angles: 270° and 90° must not make a
// south wind); above and below the levels, the nearest level's.
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

/**
 * The cell of the grid round lat, lon: the row and column of its south-west place and how far on (0 … 1) the point is toward the next
 * place north (ty) and east (tx). A point up to a step beyond the grid's edge is on the edge; one farther (or not a number): null,
 * the grid says nothing of it.
 */
export function cellAt(g: ModelGeo, lat: number, lon: number): { row: number; col: number; ty: number; tx: number } | null {
  const y = (lat - g.lat0) / g.step
  const x = wrapLon(lon - g.lon0) / g.step
  if (!(y >= -1 && y <= g.n && x >= -1 && x <= g.n)) return null // NaN too
  const last = g.n - 1
  const [cy, cx] = [Math.min(last, Math.max(0, y)), Math.min(last, Math.max(0, x))]
  const [row, col] = [Math.min(Math.floor(cy), Math.max(0, last - 1)), Math.min(Math.floor(cx), Math.max(0, last - 1))]
  return { row, col, ty: last === 0 ? 0 : cy - row, tx: last === 0 ? 0 : cx - col }
}

/** Whether lat, lon is in the middle half of the grid: within a quarter of its width of the middle, each way. Weather3D asks for a new grid when the aircraft is not. */
export function inInnerHalf(g: ModelGeo, lat: number, lon: number): boolean {
  const half = ((g.n - 1) / 2) * g.step // the grid's half width
  return Math.abs(lat - (g.lat0 + half)) <= half / 2 && Math.abs(wrapLon(lon - (g.lon0 + half))) <= half / 2
}

const RAD = Math.PI / 180

/**
 * The wind at a place and pressure altitude (ft), or null when the grid does not cover the place, the model has no wind there, or
 * a number is not one. A place round the point with no wind at a level is left out of that level (the others weigh as they did); a
 * level with none is left out, and the others are interpolated across it.
 */
export function modelWindAt(g: ModelGrid, lat: number, lon: number, altFt: number): ModelWind | null {
  const c = Number.isFinite(altFt) ? cellAt(g, lat, lon) : null
  if (c === null) return null
  const corners = [
    { p: c.row * g.n + c.col, w: (1 - c.ty) * (1 - c.tx) },
    { p: c.row * g.n + c.col + 1, w: (1 - c.ty) * c.tx },
    { p: (c.row + 1) * g.n + c.col, w: c.ty * (1 - c.tx) },
    { p: (c.row + 1) * g.n + c.col + 1, w: c.ty * c.tx },
  ]
  const levels: { hPa: number; east: number; north: number }[] = []
  for (const l of g.winds) {
    let east = 0
    let north = 0
    let weight = 0
    for (const { p, w } of corners) {
      const kt = l.kt[p]
      const deg = l.deg[p]
      if (kt === null || deg === null || kt === undefined || deg === undefined || w <= 0) continue // none there, or no weight: a corner beyond the grid when the point is on its edge
      east += w * -kt * Math.sin(deg * RAD) // the wind blows toward deg + 180
      north += w * -kt * Math.cos(deg * RAD)
      weight += w
    }
    if (weight > 0) levels.push({ hPa: l.hPa, east: east / weight, north: north / weight })
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

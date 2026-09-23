// server/cells.ts
import { distanceNm } from '../shared/geo.ts'

/**
 * One fixed upstream query circle. The globe is tiled into ≈ 2,560 cells so that every client view maps to a few
 * shared queries (many viewers of one area cost the upstream nothing extra).
 */
export interface Cell {
  id: string
  lat: number
  lon: number
  radiusNm: number
}

const BAND_DEG = 4
const BANDS = 180 / BAND_DEG
const MARGIN_NM = 10
const MAX_RADIUS_NM = 250 // adsb.lol /v2/point limit

/** Columns in a band: lon step = 360 / floor(360·cos φc / 4), so cells stay ≈ 4° × 4° of arc. */
function bandCols(band: number): number {
  const φc = -90 + (band + 0.5) * BAND_DEG
  return Math.max(1, Math.floor((360 * Math.cos((φc * Math.PI) / 180)) / BAND_DEG))
}

function makeCell(band: number, col: number): Cell {
  const step = 360 / bandCols(band)
  const lat = -90 + (band + 0.5) * BAND_DEG
  const lon = -180 + (col + 0.5) * step
  const west = lon - step / 2
  // The farthest points of a lat/lon rectangle from its centre are its corners; the equatorward ones are farther.
  const halfDiag = Math.max(distanceNm(lat, lon, lat - BAND_DEG / 2, west), distanceNm(lat, lon, lat + BAND_DEG / 2, west))
  // ceil: the upstream URL carries whole nm, and rounding down would shave the margin.
  return Object.freeze({ id: `b${band}:${col}`, lat, lon, radiusNm: Math.min(MAX_RADIUS_NM, Math.ceil(halfDiag + MARGIN_NM)) })
}

const ALL: Cell[] = []
const BY_ID = new Map<string, Cell>()
for (let band = 0; band < BANDS; band++) {
  for (let col = 0; col < bandCols(band); col++) {
    const cell = makeCell(band, col)
    ALL.push(cell)
    BY_ID.set(cell.id, cell)
  }
}

/** Cells whose query circle intersects the view circle. Together they cover every point of the view. */
export function cellsForView(lat: number, lon: number, radiusNm: number): Cell[] {
  // ponytail: brute force over all ≈ 2,560 cells (≈ 0.1 ms per call), which also makes poles and the antimeridian
  // free of special cases. Upgrade to a band/column range scan if it ever shows up in a profile.
  return ALL.filter((c) => distanceNm(lat, lon, c.lat, c.lon) <= c.radiusNm + radiusNm)
}

/** The cell's own lat/lon box, [south, north, west, east] in degrees: the cells tile the globe, each circle covers its box. */
export function cellBox(c: Cell): [number, number, number, number] {
  const half = 180 / bandCols(Math.floor((c.lat + 90) / BAND_DEG))
  const r = (v: number): number => Math.round(v * 1e4) / 1e4 // 4 decimals: ~10 m, and a short JSON number
  return [c.lat - BAND_DEG / 2, c.lat + BAND_DEG / 2, r(c.lon - half), r(c.lon + half)]
}

export function cellById(id: string): Cell {
  const c = BY_ID.get(id)
  if (!c) throw new Error(`unknown cell id: ${id}`)
  return c
}

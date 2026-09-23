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

export function cellById(id: string): Cell {
  const c = BY_ID.get(id)
  if (!c) throw new Error(`unknown cell id: ${id}`)
  return c
}

/**
 * Where most of the world's terrestrial ADS-B traffic is, as [south, north, west, east] boxes: a wide view asks for
 * these areas first, so a zoomed-out globe fills where the aircraft are before the oceans (ground-station coverage
 * ends ~200 nm offshore). ponytail: hand-drawn; upgrade: learn each cell's count and keep it across runs.
 */
const BUSY: readonly (readonly [number, number, number, number])[] = [
  [35, 61, -11, 32], // Europe
  [36, 46, 26, 45], // Türkiye, the Caucasus
  [12, 38, 32, 60], // Middle East, the Gulf
  [6, 32, 67, 92], // India
  [18, 46, 100, 146], // China, Korea, Japan
  [-10, 18, 95, 126], // South-East Asia
  [-40, -25, 138, 155], // south-east Australia
  [24, 50, -125, -66], // United States, southern Canada
  [14, 25, -106, -86], // Mexico
  [-30, -5, -55, -34], // south-east Brazil
  [-35, -22, 16, 33], // South Africa
]

/** Is the cell's centre inside one of the busy boxes? */
export function isBusy(c: Cell): boolean {
  return BUSY.some(([s, n, w, e]) => c.lat >= s && c.lat <= n && c.lon >= w && c.lon <= e)
}

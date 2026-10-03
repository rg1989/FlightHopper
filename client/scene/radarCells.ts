// client/scene/radarCells.ts
// The radar's frame as cells, for the chase's rain clouds and rain shafts (cloudField.ts radarClouds, rainShafts.ts). Pure (no
// Cesium, no DOM), so Node tests cover it. RainViewer's decoded zoom-7 source tiles (radar.ts, 256 × 256 pixels, a pixel about
// 1.2 km at the equator and 1.0 km at 32° N) are read in blocks of 3 × 3 pixels, each block as strong as its strongest pixel
// (a real cell is about 2 pixels wide, so an average would lose its core, as radar.ts found), within a radius of the
// aircraft: every block of 15 dBZ or more is a RadarCell, nearest first, at its place as it is drawn (moved by ?wxat's shift;
// the tiles are RainViewer's own, so the aircraft's place is given in theirs). A tile's 256 pixels are cut into 84 blocks of 3
// and a last of 4, so no block crosses into the next tile; a block 3 pixels wide is 3.7 km at the equator, 3.1 km at 32° N,
// 1.8 km at 60° N.
// thin() keeps the strongest cells apart from each other. Heavy rain is often one continuous region of hundreds of blocks and
// the sky has room for a few dozen clouds, so the spacing, and with it the size of the cloud drawn at each cell, grows until
// they fit (cloudField.ts radarClouds, rainShafts.ts pickShafts), in steps of 1.25 (so a window that changes a little as the
// aircraft flies leaves it, and the cloud sizes, as they were). Cells past the radius that is drawn (a ring the rebuild reads, so
// that a storm is built before it fades in) are kept on top, at the same spacing, and take no place from the cells within.
// ponytail: the blocks are read in the aircraft's own frame; a radar mosaic's edges and gaps (RainViewer draws none beyond a
// radar's reach) show as no echo. A tile of the newest frame that has not come yet reads as none.
import type { SourceTile } from './radar.ts'
import { FIRST_DBZ, RADAR_SRC_MAX } from './radar.ts'
import { wrapLon } from './wxGeo.ts'

const KM_PER_DEG = 111.195 // of latitude, on a sphere of 6,371 km
const RAD = Math.PI / 180
const SIZE = 256 // a tile's pixels each way
const TILES = 2 ** RADAR_SRC_MAX // tiles round the world at zoom 7
const WORLD = SIZE * TILES // pixels round the world
const BLOCK = 3 // pixels a block
const BLOCKS = Math.floor(SIZE / BLOCK) // blocks each way in a tile: the last takes the pixels left over
const MAX_LAT = 80 // no radar nearer the poles (and Mercator's pixels there are a tenth of a kilometre)
const SPACING_STEP = 1.25 // thin: the spacing is 1, then this, this squared, … up to its grow: a few steps

/** A block of the radar's frame with an echo, where it is drawn. */
export interface RadarCell {
  lat: number
  lon: number
  east: number // km from the aircraft, on the plane round it
  north: number
  fromKm: number
  dbz: number // its strongest pixel's
  snow: boolean // that pixel's flag
  seed: number // from the block's place in the frame: the same block gets the same look wherever the aircraft is
}

export interface Shift {
  dLat: number
  dLon: number
}

const lonOf = (gx: number): number => (gx / WORLD) * 360 - 180
const latOf = (gy: number): number => (Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / WORLD))) * 180) / Math.PI
const gxOf = (lon: number): number => ((lon + 180) / 360) * WORLD
const gyOf = (lat: number): number => ((1 - Math.log(Math.tan(lat * RAD) + 1 / Math.cos(lat * RAD)) / Math.PI) / 2) * WORLD

/**
 * The blocks of 15 dBZ or more within radiusKm of lat, lon (the aircraft, in the radar's own place), nearest first, each at
 * its place plus shift. tile(x, y) answers the decoded zoom-7 tile at x (0 … 127) and y: null when it has none (not come, or no
 * echo); it is asked once for each tile the radius reaches.
 */
export function radarCells(tile: (x: number, y: number) => SourceTile | null, lat: number, lon: number, shift: Shift = { dLat: 0, dLon: 0 }, radiusKm = 100): RadarCell[] {
  const out: RadarCell[] = []
  if (!(Math.abs(lat) <= MAX_LAT)) return out
  const dLat = radiusKm / KM_PER_DEG
  const dLon = Math.min(180, radiusKm / (KM_PER_DEG * Math.cos(lat * RAD)))
  const [x0, x1] = [gxOf(lon - dLon), gxOf(lon + dLon)] // the pixels the radius reaches (x not wrapped: it may pass the antimeridian)
  const [y0, y1] = [gyOf(Math.min(MAX_LAT, lat + dLat)), gyOf(Math.max(-MAX_LAT, lat - dLat))]
  for (let ty = Math.max(0, Math.floor(y0 / SIZE)); ty <= Math.min(TILES - 1, Math.floor(y1 / SIZE)); ty++) {
    for (let tu = Math.floor(x0 / SIZE); tu <= Math.floor(x1 / SIZE); tu++) {
      const tx = ((tu % TILES) + TILES) % TILES
      const t = tile(tx, ty)
      if (t === null) continue
      const [ox, oy] = [tu * SIZE, ty * SIZE] // this tile's corner in the unwrapped frame
      const [bi0, bi1] = [Math.max(0, Math.floor((x0 - ox) / BLOCK)), Math.min(BLOCKS - 1, Math.floor((x1 - ox) / BLOCK))]
      const [bj0, bj1] = [Math.max(0, Math.floor((y0 - oy) / BLOCK)), Math.min(BLOCKS - 1, Math.floor((y1 - oy) / BLOCK))]
      for (let bj = bj0; bj <= bj1; bj++) {
        const [ys, ye] = [bj * BLOCK, bj === BLOCKS - 1 ? SIZE : bj * BLOCK + BLOCK]
        const blat = latOf(oy + (ys + ye) / 2) // the same along the row
        const north = (blat - lat) * KM_PER_DEG
        if (Math.abs(north) > radiusKm) continue
        const kx = KM_PER_DEG * Math.cos(((blat + lat) / 2) * RAD)
        for (let bi = bi0; bi <= bi1; bi++) {
          const [xs, xe] = [bi * BLOCK, bi === BLOCKS - 1 ? SIZE : bi * BLOCK + BLOCK]
          const blon = lonOf(ox + (xs + xe) / 2)
          const east = (blon - lon) * kx // x is not wrapped here, so across the antimeridian the longitudes run on
          const fromKm = Math.hypot(east, north)
          if (fromKm > radiusKm) continue
          let at = -1 // the strongest pixel of the block that is an echo
          for (let y = ys; y < ye; y++) {
            for (let x = xs; x < xe; x++) {
              const i = y * SIZE + x
              if (t.dbz[i] >= FIRST_DBZ && (at < 0 || t.dbz[i] > t.dbz[at])) at = i
            }
          }
          if (at < 0) continue
          out.push({
            lat: blat + shift.dLat, lon: wrapLon(blon + shift.dLon), east, north, fromKm, dbz: t.dbz[at], snow: t.snow[at] !== 0,
            seed: Math.imul(((tx * TILES + ty) * BLOCKS + bi) * BLOCKS + bj + 1, 0x9e3779b1) >>> 0,
          })
        }
      }
    }
  }
  return out.sort((a, b) => a.fromKm - b.fromKm || a.seed - b.seed)
}

/**
 * One greedy pass over the cells in order (east, north and reach, km, each by index): the indices kept, each unless it lies within
 * m × reach of one kept before it. The kept ones are found by bucket of bucketKm (the widest reach of any, times m): a linked list
 * of the kept in each bucket of a grid over the cells' extent (at most about 256 buckets across: a bucket larger than it need be
 * is only slower).
 */
function spread(east: Float64Array, north: Float64Array, reach: Float64Array, m: number, minBucketKm: number): number[] {
  const n = east.length
  let [e0, n0, e1, n1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (let i = 0; i < n; i++) {
    e0 = Math.min(e0, east[i])
    e1 = Math.max(e1, east[i])
    n0 = Math.min(n0, north[i])
    n1 = Math.max(n1, north[i])
  }
  const bucketKm = Math.max(minBucketKm, (e1 - e0) / 256, (n1 - n0) / 256, 1e-6)
  const ny = Math.floor((n1 - n0) / bucketKm) + 3 // a bucket of margin each side: the neighbours of an edge bucket are in the grid
  const head = new Int32Array((Math.floor((e1 - e0) / bucketKm) + 3) * ny).fill(-1) // per bucket: the last kept in it (a position in kept), or −1
  const kept: number[] = []
  const link: number[] = [] // per kept: the one kept before it in its bucket
  for (let i = 0; i < n; i++) {
    const [bx, by] = [Math.floor((east[i] - e0) / bucketKm) + 1, Math.floor((north[i] - n0) / bucketKm) + 1]
    let free = true
    for (let dx = -1; dx <= 1 && free; dx++) {
      for (let dy = -1; dy <= 1 && free; dy++) {
        for (let k = head[(bx + dx) * ny + by + dy]; k >= 0; k = link[k]) {
          const p = kept[k]
          const r = m * reach[p]
          if ((east[p] - east[i]) ** 2 + (north[p] - north[i]) ** 2 < r * r) {
            free = false
            break
          }
        }
      }
    }
    if (!free) continue
    const b = bx * ny + by
    link.push(head[b])
    head[b] = kept.push(i) - 1
  }
  return kept
}

const stepOf = (k: number, grow: number): number => Math.min(grow, SPACING_STEP ** k)

/**
 * The strongest cells, each at least m × its reach (km) from every stronger one kept: m is 1 when at most max stay, else the
 * spacing grows, in steps of 1.25 up to grow, until at most max do (each pass aims for the step the count says: it falls about as
 * the square of m). If still more stay at grow, the nearest max of them. Nearest first. Equal strengths go to the nearer cell,
 * then by seed, so the same cells give the same answer in any order.
 * Cells farther than innerKm from the aircraft (the ring read beyond what is drawn) are not counted against max and do not set m:
 * they are kept after the inner ones, strongest first, wherever no cell kept is within m × its reach, so the inner cells' picks
 * are the same with or without them.
 */
export function thin(cells: readonly RadarCell[], reachKm: (c: RadarCell) => number, max: number, grow = 4, innerKm = Infinity): { kept: RadarCell[]; m: number } {
  if (cells.length === 0) return { kept: [], m: 1 }
  const strongest = (a: RadarCell, b: RadarCell): number => b.dbz - a.dbz || a.fromKm - b.fromKm || a.seed - b.seed
  const nearest = (a: RadarCell, b: RadarCell): number => a.fromKm - b.fromKm || a.seed - b.seed
  const inner = cells.filter((c) => c.fromKm <= innerKm).sort(strongest)
  const order = inner.concat(cells.filter((c) => c.fromKm > innerKm).sort(strongest))
  const [east, north, reach] = [Float64Array.from(order, (c) => c.east), Float64Array.from(order, (c) => c.north), Float64Array.from(order, reachKm)]
  const widest = reach.reduce((w, r) => Math.max(w, r), 0)
  for (let k = 0; ; ) {
    const m = stepOf(k, grow)
    const kept = spread(east, north, reach, m, m * widest) // ascending: the inner ones first
    let inside = kept.findIndex((i) => i >= inner.length) // those inside: the kept are in the order of `order`
    if (inside < 0) inside = kept.length
    if (inside <= max || m >= grow) {
      const got = kept.map((i) => order[i])
      return { kept: got.slice(0, inside).sort(nearest).slice(0, max).concat(got.slice(inside).sort(nearest)), m }
    }
    const want = m * Math.sqrt(inside / Math.max(1, max)) // the count falls about as the square of m: the step that would just fit
    k++
    while (stepOf(k, grow) < want && stepOf(k, grow) < grow) k++
  }
}

/**
 * The zoom-7 tiles along one side of a box of radiusKm each way round a place at lat, at most (a tile is 313 km × cos latitude wide,
 * and as tall: Mercator): the box can straddle one tile more than its width in tiles. No radar past MAX_LAT, so none is counted
 * there.
 */
export function tilesAcross(lat: number, radiusKm: number): number {
  const tileKm = ((360 * KM_PER_DEG) / TILES) * Math.cos(Math.min(Math.abs(lat), MAX_LAT) * RAD)
  return Math.floor((2 * radiusKm) / tileKm) + 2
}

// client/scene/terrainHeights.ts
// True terrain heights for many points at once, without stalling frames. sampleTerrainMostDetailed re-requests each tile
// on every call and scans all of a tile's triangles for every point: a city tile's ~15,000 building corners on ~10,000
// triangles cost 200–300 ms of main thread (harness: 11–18 long tasks while a mountain city loads). This reads each
// most-detailed tile once, buckets its triangles into a 32 × 32 grid and interpolates each point from its bucket with the
// same barycentric arithmetic as Cesium, so the heights are Cesium's own (terrainHeights.test.ts compares them).
import {
  Cartesian3,
  Cartographic,
  EllipsoidTerrainProvider,
  Intersections2D,
  Math as CesiumMath,
  QuantizedMeshTerrainData,
  type Rectangle,
  type TerrainData,
  type TerrainProvider,
} from 'cesium'

const MAX_SHORT = 32767
const GRID = 32
const CACHE_TILES = 48 // ~1–2 MB of tiles; a 10 km square of buildings touches ~20 level-14 terrain tiles
const RETRY_MS = 100 // the provider answers undefined while too many requests are in flight

/**
 * The fields Cesium's own interpolation reads (QuantizedMeshTerrainData.js, interpolateHeight). Private.
 * ponytail: tied to Cesium 1.145's field names; an upgrade that renames them falls back to data.interpolateHeight (slow, correct).
 */
interface QuantizedFields { _uValues: Uint16Array; _vValues: Uint16Array; _heightValues: Uint16Array; _indices: Uint16Array | Uint32Array; _minimumHeight: number; _maximumHeight: number }

interface Tile {
  rect: Rectangle
  data: TerrainData
  q: QuantizedFields | null // null: not quantized mesh (heightmap): its interpolateHeight is already O(1)
  start: Uint32Array // bucket b's triangles are tris[start[b] .. start[b + 1]) (triangle = its first index in _indices)
  tris: Uint32Array
}

const bucket = (w: number): number => Math.min(GRID - 1, Math.floor((w * GRID) / (MAX_SHORT + 1)))

function indexTile(rect: Rectangle, data: TerrainData): Tile {
  const f = data as unknown as QuantizedFields
  if (!(data instanceof QuantizedMeshTerrainData) || !f._uValues || !f._vValues || !f._heightValues || !f._indices) {
    return { rect, data, q: null, start: new Uint32Array(0), tris: new Uint32Array(0) }
  }
  const { _uValues: u, _vValues: v, _indices: idx } = f
  const count = new Uint32Array(GRID * GRID + 1)
  const span = (i: number): [number, number, number, number] => {
    const [a, b, c] = [idx[i], idx[i + 1], idx[i + 2]]
    return [bucket(Math.min(u[a], u[b], u[c])), bucket(Math.max(u[a], u[b], u[c])), bucket(Math.min(v[a], v[b], v[c])), bucket(Math.max(v[a], v[b], v[c]))]
  }
  for (let i = 0; i < idx.length; i += 3) {
    const [u0, u1, v0, v1] = span(i)
    for (let bv = v0; bv <= v1; bv++) for (let bu = u0; bu <= u1; bu++) count[bv * GRID + bu + 1]++
  }
  for (let b = 1; b <= GRID * GRID; b++) count[b] += count[b - 1]
  const start = count.slice()
  const fill = count.slice(0, GRID * GRID)
  const tris = new Uint32Array(start[GRID * GRID])
  for (let i = 0; i < idx.length; i += 3) {
    const [u0, u1, v0, v1] = span(i)
    for (let bv = v0; bv <= v1; bv++) for (let bu = u0; bu <= u1; bu++) tris[fill[bv * GRID + bu]++] = i
  }
  return { rect, data, q: f, start, tris }
}

const bary = new Cartesian3()
/** Cesium's interpolateHeight (no-mesh path), restricted to the point's bucket. */
function heightIn(t: Tile, lon: number, lat: number): number | undefined {
  if (t.q === null) return t.data.interpolateHeight(t.rect, lon, lat)
  const uu = CesiumMath.clamp((lon - t.rect.west) / t.rect.width, 0, 1) * MAX_SHORT
  const vv = CesiumMath.clamp((lat - t.rect.south) / t.rect.height, 0, 1) * MAX_SHORT
  const { _uValues: u, _vValues: v, _heightValues: h, _indices: idx } = t.q
  const b = bucket(vv) * GRID + bucket(uu)
  for (let k = t.start[b]; k < t.start[b + 1]; k++) {
    const i = t.tris[k]
    const [i0, i1, i2] = [idx[i], idx[i + 1], idx[i + 2]]
    const [u0, u1, u2, v0, v1, v2] = [u[i0], u[i1], u[i2], v[i0], v[i1], v[i2]]
    if (uu < Math.min(u0, u1, u2) || uu > Math.max(u0, u1, u2) || vv < Math.min(v0, v1, v2) || vv > Math.max(v0, v1, v2)) continue
    const c = Intersections2D.computeBarycentricCoordinates(uu, vv, u0, v0, u1, v1, u2, v2, bary)
    if (c.x >= -1e-15 && c.y >= -1e-15 && c.z >= -1e-15) {
      return CesiumMath.lerp(t.q._minimumHeight, t.q._maximumHeight, (c.x * h[i0] + c.y * h[i1] + c.z * h[i2]) / MAX_SHORT)
    }
  }
  return t.data.interpolateHeight(t.rect, lon, lat) // not in any bucketed triangle (never seen): Cesium's full scan
}

/** True (unexaggerated) terrain heights from the provider's most detailed tiles, as sampleTerrainMostDetailed gives. */
export class TerrainHeights {
  readonly #provider: TerrainProvider
  readonly #tiles = new Map<string, Promise<Tile | null>>() // insertion order = LRU order

  constructor(provider: TerrainProvider) {
    this.#provider = provider
  }

  /** Heights for these points, undefined where the provider has none (a tile failed). Does not modify them. */
  async heights(at: Cartographic[]): Promise<(number | undefined)[]> {
    const p = this.#provider
    const availability = p.availability
    if (p instanceof EllipsoidTerrainProvider || availability === undefined) return at.map(() => 0)
    const out: (number | undefined)[] = new Array(at.length).fill(undefined)
    let todo = at.map((_, i) => i)
    // As in sampleTerrainMostDetailed: loading a tile can reveal deeper availability, so re-read those points (≤ 4 rounds).
    for (let round = 0; round < 4 && todo.length > 0; round++) {
      const levels = todo.map((i) => availability.computeMaximumLevelAtPosition(at[i]))
      const byTile = new Map<string, { x: number; y: number; level: number; pts: number[] }>()
      todo.forEach((i, k) => {
        const level = levels[k]
        const xy = p.tilingScheme.positionToTileXY(at[i], level)
        if (!xy) return
        const key = `${xy.x}/${xy.y}/${level}`
        let g = byTile.get(key)
        if (!g) byTile.set(key, (g = { x: xy.x, y: xy.y, level, pts: [] }))
        g.pts.push(i)
      })
      await Promise.all(
        [...byTile].map(async ([key, g]) => {
          const t = await this.#tile(key, g.x, g.y, g.level)
          if (t) for (const i of g.pts) out[i] = heightIn(t, at[i].longitude, at[i].latitude)
        }),
      )
      todo = todo.filter((i, k) => availability.computeMaximumLevelAtPosition(at[i]) > levels[k])
    }
    return out
  }

  #tile(key: string, x: number, y: number, level: number): Promise<Tile | null> {
    const hit = this.#tiles.get(key)
    if (hit) {
      this.#tiles.delete(key)
      this.#tiles.set(key, hit)
      return hit
    }
    const p = this.#provider
    const load = (async (): Promise<Tile | null> => {
      for (let tries = 0; tries < 50; tries++) {
        const req = p.requestTileGeometry(x, y, level)
        if (req) return indexTile(p.tilingScheme.tileXYToRectangle(x, y, level), await req)
        await new Promise((r) => setTimeout(r, RETRY_MS))
      }
      return null
    })().catch((): null => {
      this.#tiles.delete(key) // asked again next time
      return null
    })
    this.#tiles.set(key, load)
    if (this.#tiles.size > CACHE_TILES) this.#tiles.delete(this.#tiles.keys().next().value!)
    return load
  }
}

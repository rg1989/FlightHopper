// client/scene/flatTerrain.ts
// Flat airfields in the terrain itself. The elevation model (Re:Earth: Mapterhorn DEM) is today's ground, and in places a
// surface model: buildings and structures stand in it as hills. Under a runway that is plainly wrong (a runway is flat),
// and where the airfield is a past one it is worse: JAL 123's 1985 runway 15L lies where Haneda's west side is built over
// today, 13.5 m of relief within 400 m of its threshold (Heathrow, JFK and Ben Gurion: 2–4 m, 0.2–0.4 m off a plane).
// FlatTerrainProvider wraps the terrain source and, in every tile it serves, lays the ground flat:
// - along each known runway (stripsFor): the plane through its two threshold heights (runways.ts draws the paving on
//   the same plane), within halfWidthM of the centre line and past each end, then back to the ground over blendM;
// - over an airfield's outline (areasFor, a scenario's `flat` rings): one height, blended out the same way.
// Only the heights of the tiles' own vertices change (and their normals, blended to the ellipsoid's up), so triangles,
// edges and skirts stay, and neighbouring tiles agree at their edges; Cesium's picking and sampleTerrain read the same
// flattened tiles. A tile away from every patch is passed through untouched.
import { BoundingSphere, Cartesian3, Ellipsoid, OrientedBoundingBox, QuantizedMeshTerrainData, Rectangle } from 'cesium'
import type { Credit, Event, Request, TerrainData, TerrainProvider, TileAvailability, TilingScheme } from 'cesium'
import type { Airport } from '../../shared/airports.ts'
import { smoothstep } from './exaggeration.ts'

/** A runway's flat strip: its centre line from a to b (degrees; HAE m at each end). */
export interface FlatStrip {
  aLat: number
  aLon: number
  aH: number
  bLat: number
  bLon: number
  bH: number
  halfWidthM: number // flat within this of the centre line, and this far past each end…
  blendM: number // …then back to the ground over this much more
}

/** An airfield's flat outline: a ring of [lat, lon] (degrees), flat at h (HAE m) inside, blended out over blendM. */
export interface FlatArea {
  ring: ReadonlyArray<readonly [number, number]>
  h: number
  blendM: number
}

/** A scenario airport may carry flat rings: its airfield as it was, flat at elevFt (MSL) inside. */
export type AirfieldAirport = Airport & { flat?: ReadonlyArray<{ ring: ReadonlyArray<readonly [number, number]>; elevFt: number; blendM?: number }> }

export const STRIP_HALF_M = 100 // the runway, its shoulders and graded strip (ICAO: 75 m either side for code 3–4)
export const STRIP_BLEND_M = 120
export const AREA_BLEND_M = 200
const FT = 0.3048
const Q = 32767 // quantized-mesh coordinate range
const M_PER_DEG = 111_320 // equatorial metres per degree: local flat-Earth metres (≤ 0.3 % off over a few km)
const RAD = Math.PI / 180

/** The strips of every runway of these airports: through the physical ends, at their threshold heights. */
export function stripsFor(airports: readonly Airport[]): FlatStrip[] {
  return airports.flatMap((ap) =>
    ap.runways.map((r) => {
      const [a, b] = r.ends
      return { aLat: a.lat, aLon: a.lon, aH: a.thrHaeM, bLat: b.lat, bLon: b.lon, bH: b.thrHaeM, halfWidthM: Math.max(STRIP_HALF_M, (r.widthFt * FT) / 2 + 50), blendM: STRIP_BLEND_M }
    }),
  )
}

/** The flat outlines of these airports (a scenario's `flat` rings), at elevFt + the airport's geoid height. */
export function areasFor(airports: readonly AirfieldAirport[]): FlatArea[] {
  return airports.flatMap((ap) => (ap.flat ?? []).map((f) => ({ ring: f.ring, h: f.elevFt * FT + ap.nM, blendM: f.blendM ?? AREA_BLEND_M })))
}

// ---------- the height at a point ----------

/** Local east/north metres of (lat, lon) from (lat0, lon0). */
const enOf = (lat0: number, lon0: number, lat: number, lon: number): [number, number] => [(lon - lon0) * M_PER_DEG * Math.cos(lat0 * RAD), (lat - lat0) * M_PER_DEG]

/** A strip's weight (1 flat … 0 ground) and target height at (lat, lon). */
function stripAt(s: FlatStrip, lat: number, lon: number): { w: number; h: number } {
  const [bx, by] = enOf(s.aLat, s.aLon, s.bLat, s.bLon)
  const [px, py] = enOf(s.aLat, s.aLon, lat, lon)
  const len = Math.hypot(bx, by)
  const u = len > 0 ? (px * bx + py * by) / len : 0 // along, from a
  const t = Math.min(1, Math.max(0, len > 0 ? u / len : 0))
  const d = Math.hypot(px - bx * t, py - by * t) // to the centre line segment
  return { w: 1 - smoothstep((d - s.halfWidthM) / s.blendM), h: s.aH + (s.bH - s.aH) * t }
}

/** An area's weight at (lat, lon): 1 inside its ring, falling to 0 at blendM outside. */
function areaAt(a: FlatArea, lat: number, lon: number): number {
  const [lat0, lon0] = a.ring[0]
  const p = enOf(lat0, lon0, lat, lon)
  const pts = a.ring.map(([la, lo]) => enOf(lat0, lon0, la, lo))
  let inside = false
  let d = Infinity
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]
    const [xj, yj] = pts[j]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside
    const ex = xj - xi
    const ey = yj - yi
    const l2 = ex * ex + ey * ey
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((p[0] - xi) * ex + (p[1] - yi) * ey) / l2)) : 0
    d = Math.min(d, Math.hypot(p[0] - xi - ex * t, p[1] - yi - ey * t))
  }
  return inside ? 1 : 1 - smoothstep(d / a.blendM)
}

/**
 * The ground at (lat, lon) whose true height is h, laid flat: the most fully flattened patch there sets it (a runway
 * strip wins a tie with an area), h·(1 − w) + target·w. Away from every patch: h, exactly.
 */
export function flattenedHeight(strips: readonly FlatStrip[], areas: readonly FlatArea[], lat: number, lon: number, h: number): number {
  const at = flatAt(strips, areas, lat, lon)
  return at.w > 0 ? h + (at.h - h) * at.w : h
}

function flatAt(strips: readonly FlatStrip[], areas: readonly FlatArea[], lat: number, lon: number): { w: number; h: number } {
  let best = { w: 0, h: 0 }
  for (const s of strips) {
    const x = stripAt(s, lat, lon)
    if (x.w > best.w) best = x
  }
  for (const a of areas) {
    const w = areaAt(a, lat, lon)
    if (w > best.w) best = { w, h: a.h }
  }
  return best
}

/** The patches' extent in radians, grown by their widths and blends: a tile outside it is left alone. */
function extentOf(strips: readonly FlatStrip[], areas: readonly FlatArea[]): Array<[w: number, s: number, e: number, n: number]> {
  const box = (pts: ReadonlyArray<readonly [number, number]>, m: number): [number, number, number, number] => {
    const lat = pts.map((p) => p[0])
    const lon = pts.map((p) => p[1])
    const dLat = m / M_PER_DEG
    const dLon = m / (M_PER_DEG * Math.cos(lat[0] * RAD))
    return [(Math.min(...lon) - dLon) * RAD, (Math.min(...lat) - dLat) * RAD, (Math.max(...lon) + dLon) * RAD, (Math.max(...lat) + dLat) * RAD]
  }
  return [
    ...strips.map((s) => box([[s.aLat, s.aLon], [s.bLat, s.bLon]], s.halfWidthM + s.blendM)),
    ...areas.map((a) => box(a.ring, a.blendM)),
  ]
}

const touches = (r: Rectangle, ext: ReadonlyArray<[number, number, number, number]>): boolean =>
  ext.some(([w, s, e, n]) => r.west <= e && r.east >= w && r.south <= n && r.north >= s)

// ---------- normals (oct-encoded, as quantized-mesh and Cesium's czm_octDecode have them) ----------

const sgn = (v: number): number => (v < 0 ? -1 : 1)
const toSNorm = (v: number): number => Math.round((Math.min(1, Math.max(-1, v)) * 0.5 + 0.5) * 255)
const fromSNorm = (v: number): number => (Math.min(255, Math.max(0, v)) / 255) * 2 - 1

/** A unit vector as two bytes (octahedral, 0–255: AttributeCompression.octEncode's encoding). */
export function octEncode(v: Cartesian3): [number, number] {
  const s = Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z)
  let x = v.x / s
  let y = v.y / s
  if (v.z < 0) [x, y] = [(1 - Math.abs(y)) * sgn(x), (1 - Math.abs(x)) * sgn(y)]
  return [toSNorm(x), toSNorm(y)]
}

/** octEncode's inverse, normalised. */
export function octDecode(ex: number, ey: number, result = new Cartesian3()): Cartesian3 {
  let x = fromSNorm(ex)
  let y = fromSNorm(ey)
  const z = 1 - (Math.abs(x) + Math.abs(y))
  if (z < 0) [x, y] = [(1 - Math.abs(y)) * sgn(x), (1 - Math.abs(x)) * sgn(y)]
  return Cartesian3.normalize(Cartesian3.fromElements(x, y, z, result), result)
}

// ---------- one tile ----------

interface QmPrivate {
  _uValues: Uint16Array
  _vValues: Uint16Array
  _heightValues: Uint16Array
  _minimumHeight: number
  _maximumHeight: number
  _encodedNormals?: Uint8Array
  _indices: Uint16Array | Uint32Array
  _boundingSphere: BoundingSphere
  _orientedBoundingBox?: OrientedBoundingBox
  _horizonOcclusionPoint: Cartesian3
  _westIndices: number[]
  _southIndices: number[]
  _eastIndices: number[]
  _northIndices: number[]
  _westSkirtHeight: number
  _southSkirtHeight: number
  _eastSkirtHeight: number
  _northSkirtHeight: number
  _childTileMask: number
  _waterMask?: Uint8Array
  _credits?: Credit[]
  _createdByUpsampling: boolean
}

const scratchUp = new Cartesian3()
const scratchN = new Cartesian3()

/**
 * The tile (rect: its rectangle, radians) with its vertices' heights flattened (flattenedHeight) and their normals
 * turned towards the ellipsoid's up as much; null when no vertex moves. Heights are re-quantized over the new range;
 * a range wider than the tile's own gets new bounding volumes (the horizon point is kept: flattening moves the ground
 * by metres, a far tile's horizon test by nothing that shows).
 */
export function flattenTile(data: QuantizedMeshTerrainData, rect: Rectangle, strips: readonly FlatStrip[], areas: readonly FlatArea[]): QuantizedMeshTerrainData | null {
  const p = data as unknown as QmPrivate
  const n = p._uValues.length
  const lo = p._minimumHeight
  const span = p._maximumHeight - lo
  const hs = new Float64Array(n)
  const ws = new Float64Array(n)
  let moved = false
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < n; i++) {
    const lat = (rect.south + (p._vValues[i] / Q) * rect.height) / RAD
    const lon = (rect.west + (p._uValues[i] / Q) * rect.width) / RAD
    const h0 = lo + (p._heightValues[i] / Q) * span
    const at = flatAt(strips, areas, lat, lon)
    const h = at.w > 0 ? h0 + (at.h - h0) * at.w : h0
    if (Math.abs(h - h0) > 0.005) moved = true
    hs[i] = h
    ws[i] = at.w
    min = Math.min(min, h)
    max = Math.max(max, h)
  }
  if (!moved) return null
  if (max - min < 1e-3) max = min + 1e-3
  const q = new Uint16Array(3 * n)
  q.set(p._uValues, 0)
  q.set(p._vValues, n)
  for (let i = 0; i < n; i++) q[2 * n + i] = Math.round(((hs[i] - min) / (max - min)) * Q)
  let normals = p._encodedNormals
  if (normals !== undefined) {
    normals = normals.slice()
    for (let i = 0; i < n; i++) {
      if (ws[i] <= 0) continue
      const lat = rect.south + (p._vValues[i] / Q) * rect.height
      const lon = rect.west + (p._uValues[i] / Q) * rect.width
      const up = Ellipsoid.WGS84.geodeticSurfaceNormalCartographic({ longitude: lon, latitude: lat, height: 0 } as never, scratchUp)
      const was = octDecode(normals[2 * i], normals[2 * i + 1], scratchN)
      const v = Cartesian3.normalize(Cartesian3.lerp(was, up, ws[i], scratchN), scratchN)
      ;[normals[2 * i], normals[2 * i + 1]] = octEncode(v)
    }
  }
  const wider = min < lo - 0.01 || max > p._maximumHeight + 0.01
  const obb = wider ? OrientedBoundingBox.fromRectangle(rect, min, max, Ellipsoid.WGS84) : p._orientedBoundingBox
  return new QuantizedMeshTerrainData({
    quantizedVertices: q,
    indices: p._indices,
    encodedNormals: normals,
    minimumHeight: min,
    maximumHeight: max,
    boundingSphere: wider ? BoundingSphere.fromOrientedBoundingBox(obb!) : p._boundingSphere,
    orientedBoundingBox: obb,
    horizonOcclusionPoint: p._horizonOcclusionPoint,
    westIndices: p._westIndices,
    southIndices: p._southIndices,
    eastIndices: p._eastIndices,
    northIndices: p._northIndices,
    westSkirtHeight: p._westSkirtHeight,
    southSkirtHeight: p._southSkirtHeight,
    eastSkirtHeight: p._eastSkirtHeight,
    northSkirtHeight: p._northSkirtHeight,
    childTileMask: p._childTileMask,
    waterMask: p._waterMask,
    credits: p._credits,
    createdByUpsampling: p._createdByUpsampling,
  })
}

// ---------- the provider ----------

/**
 * inner, with its tiles near a runway or an airfield laid flat (flattenTile). Everything else is inner's. A new set of
 * patches is a new provider: assigning it to viewer.terrainProvider reloads the globe's tiles.
 * ponytail: only quantized-mesh tiles (Re:Earth, Cesium World Terrain) are flattened; heightmap sources pass through.
 */
export class FlatTerrainProvider implements TerrainProvider {
  readonly inner: TerrainProvider
  readonly #strips: readonly FlatStrip[]
  readonly #areas: readonly FlatArea[]
  readonly #ext: Array<[number, number, number, number]>

  constructor(inner: TerrainProvider, strips: readonly FlatStrip[], areas: readonly FlatArea[]) {
    this.inner = inner
    this.#strips = strips
    this.#areas = areas
    this.#ext = extentOf(strips, areas)
  }

  get errorEvent(): Event<TerrainProvider.ErrorEvent> {
    return this.inner.errorEvent
  }
  get credit(): Credit {
    return this.inner.credit
  }
  get tilingScheme(): TilingScheme {
    return this.inner.tilingScheme
  }
  get hasWaterMask(): boolean {
    return this.inner.hasWaterMask
  }
  get hasVertexNormals(): boolean {
    return this.inner.hasVertexNormals
  }
  get availability(): TileAvailability | undefined {
    return this.inner.availability
  }

  requestTileGeometry(x: number, y: number, level: number, request?: Request): Promise<TerrainData> | undefined {
    const tile = this.inner.requestTileGeometry(x, y, level, request)
    if (tile === undefined || this.#ext.length === 0) return tile
    const rect = this.tilingScheme.tileXYToRectangle(x, y, level)
    if (!touches(rect, this.#ext)) return tile
    return tile.then((d) => (d instanceof QuantizedMeshTerrainData ? (flattenTile(d, rect, this.#strips, this.#areas) ?? d) : d))
  }

  getLevelMaximumGeometricError(level: number): number {
    return this.inner.getLevelMaximumGeometricError(level)
  }

  getTileDataAvailable(x: number, y: number, level: number): boolean | undefined {
    return this.inner.getTileDataAvailable(x, y, level)
  }

  loadTileDataAvailability(x: number, y: number, level: number): undefined | Promise<void> {
    return this.inner.loadTileDataAvailability(x, y, level)
  }
}

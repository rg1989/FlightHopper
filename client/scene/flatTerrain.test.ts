// client/scene/flatTerrain.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BoundingSphere, Cartesian3, Ellipsoid, GeographicTilingScheme, QuantizedMeshTerrainData, Rectangle } from 'cesium'
import type { TerrainProvider } from 'cesium'
import type { Airport } from '../../shared/airports.ts'
import { FlatTerrainProvider, areasFor, flattenTile, flattenedHeight, octDecode, octEncode, stripsFor, type FlatArea, type FlatStrip } from './flatTerrain.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${msg} got ${a}, expected ${b} ± ${tol}`)
const M_LAT = 110_950 // metres per degree of latitude at 35.5°
const M_LON = 90_667 // …and of longitude
const at = (lat0: number, lon0: number, north: number, east: number): [number, number] => [lat0 + north / M_LAT, lon0 + east / M_LON]

// A 3,000 m runway heading 145°, its ends 1 m apart in height; flat 100 m either side, back to the ground over 120 m.
const A: [number, number] = [35.56189, 139.76002]
const B = at(A[0], A[1], 3000 * Math.cos((145 * Math.PI) / 180), 3000 * Math.sin((145 * Math.PI) / 180))
const strip: FlatStrip = { aLat: A[0], aLon: A[1], aH: 40, bLat: B[0], bLon: B[1], bH: 41, halfWidthM: 100, blendM: 120 }
/** A point off the runway: s metres along it from A, d metres to its right. */
const along = (s: number, d: number): [number, number] => {
  const t = (145 * Math.PI) / 180
  return at(A[0], A[1], s * Math.cos(t) - d * Math.sin(t), s * Math.sin(t) + d * Math.cos(t))
}

test('a runway strip: the plane through its ends within halfWidth of the centre line and past each end; the ground beyond the blend', () => {
  near(flattenedHeight([strip], [], ...along(1500, 0), 55), 40.5, 0.01, 'mid-runway, on a 55 m bump')
  near(flattenedHeight([strip], [], ...along(0, 90), 30), 40, 0.01, 'at the threshold, 90 m aside, in a 30 m dip')
  near(flattenedHeight([strip], [], ...along(-95, 0), 47), 40, 0.01, '95 m before the threshold')
  near(flattenedHeight([strip], [], ...along(3000 + 95, 0), 47), 41, 0.01, '95 m past the far end')
  assert.equal(flattenedHeight([strip], [], ...along(1500, 221), 55), 55, 'beyond halfWidth + blend: untouched')
  assert.equal(flattenedHeight([strip], [], 36.5, 140.5, 12.25), 12.25, 'far away: untouched, exactly')
})

test('a runway strip: the blend is smooth and monotonic from the strip to the ground', () => {
  let prev = flattenedHeight([strip], [], ...along(1500, 100), 60)
  for (let d = 100; d <= 225; d += 1) {
    const h = flattenedHeight([strip], [], ...along(1500, d), 60)
    assert.ok(h >= prev - 1e-9 && h - prev < 1.5, `at ${d} m: ${prev} -> ${h}`)
    prev = h
  }
  near(prev, 60, 1e-9)
})

test('an airfield area: flat at its height inside the ring, back to the ground over blendM outside it', () => {
  const ring: Array<[number, number]> = [at(35.55, 139.77, -500, -500), at(35.55, 139.77, -500, 500), at(35.55, 139.77, 500, 500), at(35.55, 139.77, 500, -500)]
  const area: FlatArea = { ring, h: 40.4, blendM: 200 }
  near(flattenedHeight([], [area], ...at(35.55, 139.77, 0, 0), 52), 40.4, 1e-9, 'inside')
  near(flattenedHeight([], [area], ...at(35.55, 139.77, 480, -480), 30), 40.4, 1e-9, 'inside, by a corner')
  const mid = flattenedHeight([], [area], ...at(35.55, 139.77, 0, 600), 50.4)
  assert.ok(mid > 40.4 && mid < 50.4, `100 m outside: between (${mid})`)
  assert.equal(flattenedHeight([], [area], ...at(35.55, 139.77, 0, 701), 50.4), 50.4, 'beyond the blend')
})

test('where a strip and an area overlap, the more fully flattened one sets the height', () => {
  const ring: Array<[number, number]> = [along(1400, -300), along(1400, 300), along(1600, 300), along(1600, -300)]
  const area: FlatArea = { ring, h: 45, blendM: 100 }
  near(flattenedHeight([strip], [area], ...along(1500, 0), 60), 40.5, 0.01, 'both full: the runway plane')
  near(flattenedHeight([strip], [area], ...along(1500, 250), 60), 45, 0.01, 'only the area is full there')
})

test('stripsFor: one strip per runway, through its physical ends at their threshold heights', () => {
  const end = (ident: string, lat: number, lon: number, thrHaeM: number): Airport['runways'][number]['ends'][number] =>
    ({ ident, lat, lon, thrLat: lat, thrLon: lon, displacedFt: 0, elevFt: 12, hdgTrueDeg: 145, thrHaeM })
  const ap: Airport = { ident: 'RJTT', name: 'Haneda', lat: 35.55, lon: 139.77, elevFt: 12, nM: 36.7, runways: [{ lengthFt: 9843, widthFt: 197, surface: 'ASP', ends: [end('15L', A[0], A[1], 40.4), end('33R', B[0], B[1], 40.7)] }] }
  const [s] = stripsFor([ap])
  assert.deepEqual([s.aLat, s.aLon, s.aH, s.bLat, s.bLon, s.bH], [A[0], A[1], 40.4, B[0], B[1], 40.7])
  assert.ok(s.halfWidthM >= 197 * 0.3048 / 2 + 50, 'wider than the pavement')
  assert.equal(areasFor([ap]).length, 0, 'no area without a flat ring')
  const flat = { ...ap, flat: [{ ring: [[35.5, 139.7], [35.5, 139.8], [35.6, 139.8]] as Array<[number, number]>, elevFt: 12 }] }
  const [a] = areasFor([flat])
  near(a.h, 12 * 0.3048 + 36.7, 0.01, 'MSL feet + the airport geoid height')
})

test('octEncode/octDecode: round trip within 1°, and what Cesium decodes for up', () => {
  for (const v of [new Cartesian3(0, 0, 1), new Cartesian3(0.6, -0.8, 0), new Cartesian3(-0.3, 0.2, -0.93), Cartesian3.normalize(new Cartesian3(1, 2, 3), new Cartesian3())]) {
    const [x, y] = octEncode(v)
    const d = octDecode(x, y)
    assert.ok(Cartesian3.angleBetween(Cartesian3.normalize(v, new Cartesian3()), d) < Math.PI / 180, `${v} -> ${d}`)
  }
  assert.deepEqual(octEncode(new Cartesian3(0, 0, 1)), [128, 128])
})

// ---------- a quantized-mesh tile ----------

const tiling = new GeographicTilingScheme()
/** The level-14 tile over the runway's middle, as a 17 × 17 grid of vertices on bumps (±6 m) with slanted normals. */
function bumpyTile(): { data: QuantizedMeshTerrainData; rect: Rectangle; x: number; y: number; level: number } {
  const level = 14
  const mid = along(1500, 0)
  const xy = tiling.positionToTileXY({ longitude: (mid[1] * Math.PI) / 180, latitude: (mid[0] * Math.PI) / 180, height: 0 } as never, level)!
  const rect = tiling.tileXYToRectangle(xy.x, xy.y, level)
  const n = 17
  const N = n * n
  const q = new Uint16Array(3 * N)
  const normals = new Uint8Array(2 * N)
  const minH = 34
  const maxH = 46
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i
      q[k] = Math.round((i / (n - 1)) * 32767)
      q[N + k] = Math.round((j / (n - 1)) * 32767)
      const h = 40 + 6 * Math.sin(i * 1.3) * Math.cos(j * 0.9)
      q[2 * N + k] = Math.round(((h - minH) / (maxH - minH)) * 32767)
      const [ox, oy] = octEncode(Cartesian3.normalize(new Cartesian3(0.3, -0.2, 1), new Cartesian3()))
      normals[2 * k] = ox
      normals[2 * k + 1] = oy
    }
  }
  const idx: number[] = []
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const k = j * n + i
    idx.push(k, k + 1, k + n, k + 1, k + n + 1, k + n)
  }
  const col = (i: number): number[] => Array.from({ length: n }, (_, j) => j * n + i)
  const row = (j: number): number[] => Array.from({ length: n }, (_, i) => j * n + i)
  const data = new QuantizedMeshTerrainData({
    quantizedVertices: q, indices: new Uint16Array(idx), encodedNormals: normals, minimumHeight: minH, maximumHeight: maxH,
    boundingSphere: BoundingSphere.fromRectangle3D(rect, Ellipsoid.WGS84, maxH), horizonOcclusionPoint: new Cartesian3(1, 1, 1),
    westIndices: col(0), southIndices: row(0), eastIndices: col(n - 1), northIndices: row(n - 1),
    westSkirtHeight: 5, southSkirtHeight: 5, eastSkirtHeight: 5, northSkirtHeight: 5, childTileMask: 15,
  })
  return { data, rect, x: xy.x, y: xy.y, level }
}

type Priv = { _uValues: Uint16Array; _vValues: Uint16Array; _heightValues: Uint16Array; _minimumHeight: number; _maximumHeight: number; _encodedNormals: Uint8Array }
const heightsOf = (d: QuantizedMeshTerrainData): number[] => {
  const p = d as unknown as Priv
  return Array.from(p._heightValues, (h) => p._minimumHeight + (h / 32767) * (p._maximumHeight - p._minimumHeight))
}
const lonLatOf = (d: QuantizedMeshTerrainData, rect: Rectangle, k: number): [number, number] => {
  const p = d as unknown as Priv
  return [((rect.south + (p._vValues[k] / 32767) * rect.height) * 180) / Math.PI, ((rect.west + (p._uValues[k] / 32767) * rect.width) * 180) / Math.PI]
}

test('flattenTile: every vertex at its flattened height (to the quantization), the flat ones facing up; untouched tiles: null', () => {
  const { data, rect } = bumpyTile()
  const out = flattenTile(data, rect, [strip], [])
  assert.ok(out !== null)
  const before = heightsOf(data)
  const after = heightsOf(out)
  const p = out as unknown as Priv
  let flat = 0
  for (let k = 0; k < after.length; k++) {
    const [lat, lon] = lonLatOf(out, rect, k)
    near(after[k], flattenedHeight([strip], [], lat, lon, before[k]), 0.01, `vertex ${k}`)
    if (Math.abs(after[k] - flattenedHeight([strip], [], lat, lon, 1e6)) < 0.01) {
      flat++
      const up = Ellipsoid.WGS84.geodeticSurfaceNormal(Cartesian3.fromDegrees(lon, lat), new Cartesian3())
      assert.ok(Cartesian3.angleBetween(octDecode(p._encodedNormals[2 * k], p._encodedNormals[2 * k + 1]), up) < (1.5 * Math.PI) / 180, `normal ${k}`)
    }
  }
  assert.ok(flat > 20, `${flat} vertices on the runway plane`)
  assert.equal(flattenTile(data, rect, [{ ...strip, aLat: strip.aLat + 1, bLat: strip.bLat + 1 }], []), null, 'a strip a degree away')
})

test('flattenTile: the tile keeps its triangles, edges and skirts; new heights, new bounds when they widen', () => {
  const { data, rect } = bumpyTile()
  const low = { ...strip, aH: 20, bH: 20 } // the plane 14 m below the tile's lowest point
  const out = flattenTile(data, rect, [low], [])!
  const p = out as unknown as Priv & { _indices: Uint16Array; _westIndices: number[]; _westSkirtHeight: number; _boundingSphere: BoundingSphere }
  assert.deepEqual(Array.from(p._indices), Array.from((data as unknown as { _indices: Uint16Array })._indices))
  assert.equal(p._westSkirtHeight, 5)
  near(p._minimumHeight, 20, 0.01)
  const bs = p._boundingSphere
  for (let k = 0; k < p._heightValues.length; k++) {
    const [lat, lon] = lonLatOf(out, rect, k)
    const h = heightsOf(out)[k]
    assert.ok(Cartesian3.distance(Cartesian3.fromDegrees(lon, lat, h), bs.center) <= bs.radius + 0.5, `vertex ${k} inside the bounding sphere`)
  }
})

test('FlatTerrainProvider: the inner provider for everything, tiles near a strip flattened, the rest passed through as they are', async () => {
  const { data, x, y, level } = bumpyTile()
  const far = { tag: 'far' }
  const inner = {
    tilingScheme: tiling, hasWaterMask: false, hasVertexNormals: true, availability: undefined, credit: undefined, errorEvent: { tag: 'ev' },
    getLevelMaximumGeometricError: (l: number) => 1000 / 2 ** l,
    getTileDataAvailable: () => true,
    loadTileDataAvailability: () => undefined,
    requestTileGeometry: (tx: number, ty: number) => Promise.resolve(tx === x && ty === y ? data : far),
  } as unknown as TerrainProvider
  const flat = new FlatTerrainProvider(inner, [strip], [])
  assert.equal(flat.tilingScheme, tiling)
  assert.equal(flat.hasVertexNormals, true)
  assert.equal(flat.getLevelMaximumGeometricError(3), 125)
  assert.equal(flat.errorEvent, inner.errorEvent)
  const t = await flat.requestTileGeometry(x, y, level)!
  assert.ok(t !== data && t instanceof QuantizedMeshTerrainData, 'flattened')
  assert.equal(await flat.requestTileGeometry(0, 0, 3)!, far, 'untouched: the very same object')
  assert.equal(flat.inner, inner)
})

// client/scene/terrainHeights.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BoundingSphere, Cartesian3, Cartographic, EllipsoidTerrainProvider, GeographicTilingScheme, QuantizedMeshTerrainData, type TerrainProvider } from 'cesium'
import { TerrainHeights } from './terrainHeights.ts'

/** A quantized-mesh tile: an n × n vertex grid with pseudo-random heights, two triangles per cell, the diagonal alternating. */
function meshTile(n: number, seed: number): QuantizedMeshTerrainData {
  const count = n * n
  const q = new Uint16Array(count * 3)
  let s = seed
  const rnd = (): number => ((s = (s * 16807) % 2147483647) / 2147483647)
  const edge = { w: [] as number[], e: [] as number[], s: [] as number[], n: [] as number[] }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i
      q[k] = Math.round((i / (n - 1)) * 32767)
      q[count + k] = Math.round((j / (n - 1)) * 32767)
      q[2 * count + k] = Math.round(rnd() * 32767)
      if (i === 0) edge.w.push(k)
      if (i === n - 1) edge.e.push(k)
      if (j === 0) edge.s.push(k)
      if (j === n - 1) edge.n.push(k)
    }
  }
  const idx: number[] = []
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i
      const [b, c, d] = [a + 1, a + n, a + n + 1]
      if ((i + j) % 2 === 0) idx.push(a, b, d, a, d, c)
      else idx.push(a, b, c, b, d, c)
    }
  }
  return new QuantizedMeshTerrainData({
    quantizedVertices: q, indices: new Uint16Array(idx), minimumHeight: 120, maximumHeight: 2480,
    boundingSphere: new BoundingSphere(Cartesian3.ZERO, 1), horizonOcclusionPoint: Cartesian3.ZERO,
    westIndices: edge.w, southIndices: edge.s, eastIndices: edge.e, northIndices: edge.n,
    westSkirtHeight: 10, southSkirtHeight: 10, eastSkirtHeight: 10, northSkirtHeight: 10,
  })
}

const LEVEL = 12
const tiling = new GeographicTilingScheme()

function provider(asked: string[]): TerrainProvider {
  const tiles = new Map<string, QuantizedMeshTerrainData>()
  return {
    tilingScheme: tiling,
    availability: { computeMaximumLevelAtPosition: () => LEVEL },
    requestTileGeometry: (x: number, y: number, level: number) => {
      const k = `${x}/${y}/${level}`
      asked.push(k)
      if (!tiles.has(k)) tiles.set(k, meshTile(33, x * 7919 + y))
      return Promise.resolve(tiles.get(k))
    },
    loadTileDataAvailability: () => undefined,
  } as unknown as TerrainProvider
}

test('TerrainHeights: the same heights as Cesium\'s own interpolation, every point, across tile edges', async () => {
  const asked: string[] = []
  const p = provider(asked)
  const th = new TerrainHeights(p)
  const pts: Cartographic[] = []
  let s = 42
  const rnd = (): number => ((s = (s * 16807) % 2147483647) / 2147483647)
  const west = tiling.tileXYToRectangle(4096, 1000, LEVEL) // a block of 2 × 2 tiles from here
  for (let i = 0; i < 2000; i++) pts.push(new Cartographic(west.west + rnd() * 2 * west.width, west.north - rnd() * 2 * west.height))
  const got = await th.heights(pts)
  let checked = 0
  for (let i = 0; i < pts.length; i++) {
    const xy = tiling.positionToTileXY(pts[i], LEVEL)!
    const data = (await p.requestTileGeometry(xy.x, xy.y, LEVEL)) as QuantizedMeshTerrainData
    const want = data.interpolateHeight(tiling.tileXYToRectangle(xy.x, xy.y, LEVEL), pts[i].longitude, pts[i].latitude)
    assert.equal(got[i], want, `point ${i}`)
    checked++
  }
  assert.equal(checked, 2000)
  const tilesAsked = new Set(asked).size
  assert.equal(tilesAsked, 4)
})

test('TerrainHeights: each tile is fetched once across calls', async () => {
  const asked: string[] = []
  const th = new TerrainHeights(provider(asked))
  const r = tiling.tileXYToRectangle(100, 200, LEVEL)
  const at = (): Cartographic[] => [new Cartographic(r.west + r.width / 3, r.south + r.height / 3), new Cartographic(r.west + r.width / 2, r.south + r.height / 4)]
  await th.heights(at())
  await th.heights(at())
  assert.equal(asked.length, 1)
})

test('TerrainHeights: the ellipsoid (no terrain) is 0 everywhere', async () => {
  const th = new TerrainHeights(new EllipsoidTerrainProvider())
  assert.deepEqual(await th.heights([Cartographic.fromDegrees(34.8, 32.0), Cartographic.fromDegrees(11.3, 47.2)]), [0, 0])
})

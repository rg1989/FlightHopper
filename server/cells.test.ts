// server/cells.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { destination, distanceNm } from '../shared/geo.ts'
import { cellById, cellsForView } from './cells.ts'

/** Deterministic PRNG (mulberry32) so the property test is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WHOLE_EARTH_NM = 10_900 // > half the circumference: every cell intersects

test('grid: 4° bands, lon step 360/floor(360·cos φc/4), ids b{band}:{col}', () => {
  // KSFO (37.62, −122.38): band floor((37.62+90)/4) = 31, φc = 36°, 72 columns of 5°, column 11
  const c = cellById('b31:11')
  assert.equal(c.id, 'b31:11')
  assert.equal(c.lat, 36)
  assert.equal(c.lon, -122.5)
  // equator band: 90 columns of 4°; polar bands: 3 columns of 120°
  assert.equal(cellById('b22:0').lat, 0)
  assert.equal(cellById('b22:0').lon, -178)
  assert.doesNotThrow(() => cellById('b22:89'))
  assert.throws(() => cellById('b22:90'), /unknown cell/)
  assert.equal(cellById('b44:0').lat, 88)
  assert.equal(cellById('b44:0').lon, -120)
  assert.doesNotThrow(() => cellById('b0:2'))
  assert.throws(() => cellById('b0:3'), /unknown cell/)
  assert.throws(() => cellById('b45:0'), /unknown cell/)
  assert.throws(() => cellById('nonsense'), /unknown cell/)
})

test('every cell: query radius = half-diagonal + 10 nm, at most 250 nm; cellById round-trips', () => {
  const all = cellsForView(0, 0, WHOLE_EARTH_NM)
  assert.equal(all.length, 2558)
  assert.equal(new Set(all.map((c) => c.id)).size, all.length)
  for (const c of all) {
    assert.ok(c.radiusNm > 0 && c.radiusNm <= 250, `${c.id} radius ${c.radiusNm}`)
    assert.deepEqual(cellById(c.id), c)
  }
  // b31:11 spans 34–38° N, 125–120° W; the far (equatorward) corner is ≈ 170 nm from its centre
  const k = cellById('b31:11')
  const halfDiag = distanceNm(k.lat, k.lon, 34, -125)
  assert.ok(k.radiusNm >= halfDiag + 10 && k.radiusNm < halfDiag + 11, `radius ${k.radiusNm}, half-diagonal ${halfDiag}`)
})

test('a small view in the middle of a cell needs only that cell', () => {
  for (const id of ['b31:11', 'b22:0', 'b38:10', 'b10:40']) {
    const c = cellById(id)
    assert.deepEqual(cellsForView(c.lat, c.lon, 20).map((x) => x.id), [id])
  }
})

test('returned cells are exactly those whose query circle intersects the view circle', () => {
  const view = { lat: 37.6188, lon: -122.3758, nm: 40 }
  const got = new Set(cellsForView(view.lat, view.lon, view.nm).map((c) => c.id))
  assert.ok(got.has('b31:11'))
  for (const c of cellsForView(0, 0, WHOLE_EARTH_NM)) {
    const hits = distanceNm(view.lat, view.lon, c.lat, c.lon) <= c.radiusNm + view.nm
    assert.equal(got.has(c.id), hits, c.id)
  }
})

test('coverage: every point of the view lies inside some returned query circle (poles, ±80°, antimeridian)', () => {
  const views: [number, number, number][] = [
    [37.6188, -122.3758, 40], // KSFO
    [32.0114, 34.8867, 150], // LLBG
    [47.2602, 11.3439, 5], // LOWI, tiny view
    [0, 179.9, 200], // equator, antimeridian
    [65, -179.95, 250], // high latitude, antimeridian
    [79.7, 20, 150], // near +80°
    [-79.9, -60, 120], // near −80°
    [89.5, 45, 100], // contains the north pole
    [-88, 170, 250], // near the south pole, antimeridian
    [2, 0, 1], // band edge, tiny view
  ]
  const rand = rng(42)
  for (const [lat, lon, nm] of views) {
    const cells = cellsForView(lat, lon, nm)
    assert.ok(cells.length > 0)
    for (let i = 0; i < 400; i++) {
      const p = destination(lat, lon, rand() * 360, nm * Math.sqrt(rand()))
      const covered = cells.some((c) => distanceNm(p.lat, p.lon, c.lat, c.lon) <= c.radiusNm)
      assert.ok(covered, `view (${lat}, ${lon}, ${nm}): point (${p.lat}, ${p.lon}) not covered`)
    }
  }
})

test('cells are shared, read-only objects', () => {
  const c = cellById('b31:11')
  assert.throws(() => {
    ;(c as { radiusNm: number }).radiusNm = 1
  }, TypeError)
})

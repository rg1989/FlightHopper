// client/scene/radarCells.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { radarPixel } from './precip.ts'
import { NONE, type SourceTile } from './radar.ts'
import { radarCells, thin, type RadarCell } from './radarCells.ts'

const WORLD = 256 * 128 // zoom-7 pixels round the world
const lonAt = (gx: number): number => (gx / WORLD) * 360 - 180
const latAt = (gy: number): number => (Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / WORLD))) * 180) / Math.PI
/** The middle of pixel (x, y) of zoom-7 tile (tx, ty). */
const place = (tx: number, ty: number, x: number, y: number): { lat: number; lon: number } => ({ lat: latAt(ty * 256 + y + 0.5), lon: lonAt(tx * 256 + x + 0.5) })
const KM_PER_DEG = 111.195
const kmPerPixel = (lat: number): number => ((360 * KM_PER_DEG) / WORLD) * Math.cos((lat * Math.PI) / 180)
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol

const blank = (): SourceTile => ({ dbz: new Int8Array(256 * 256).fill(NONE), snow: new Uint8Array(256 * 256) })
const put = (t: SourceTile, x: number, y: number, dbz: number, snow = false): void => {
  t.dbz[y * 256 + x] = dbz
  t.snow[y * 256 + x] = snow ? 1 : 0
}
/** A tile getter over zoom-7 tiles by 'x/y' that records what it is asked for. */
function tiles(have: Record<string, SourceTile>) {
  const asked: string[] = []
  return { asked, get: (x: number, y: number): SourceTile | null => (asked.push(`${x}/${y}`), have[`${x}/${y}`] ?? null) }
}
const byDbz = (cs: RadarCell[]): number[] => cs.map((c) => c.dbz).sort((a, b) => a - b)

const A = place(76, 51, 100, 100) // the aircraft, in the middle of pixel (100, 100) of tile 76/51 (about 32°N, 34.9°E)

test('radarCells: a block is 3 × 3 pixels, as strong as its strongest pixel (and its flag); under 15 dBZ is no echo', () => {
  const t = blank()
  put(t, 99, 99, 20)
  put(t, 101, 101, 33)
  put(t, 100, 100, 14) // too faint to count
  put(t, 102, 99, 15) // the next block east
  put(t, 96, 99, 40, true) // the next block west, snow
  put(t, 98, 98, 31, true) // the block north-west: its own
  const cells = radarCells(tiles({ '76/51': t }).get, A.lat, A.lon)
  assert.deepEqual(byDbz(cells), [15, 31, 33, 40], 'one cell a block, each as strong as its strongest pixel')
  const mid = cells.find((c) => c.dbz === 33)!
  assert.equal(mid.snow, false, 'the strongest pixel of its block is rain')
  assert.equal(cells.find((c) => c.dbz === 40)!.snow, true)
  assert.equal(cells.find((c) => c.dbz === 31)!.snow, true)
  assert.equal(cells.find((c) => c.dbz === 15)!.snow, false)
  // a cell stands in the middle of its block: this one is the middle of pixel (100, 100), where the aircraft is
  assert.ok(near(mid.lat, A.lat, 1e-9) && near(mid.lon, A.lon, 1e-9), `${mid.lat}, ${mid.lon}`)
  assert.ok(mid.fromKm < 1e-6 && near(mid.east, 0, 1e-6) && near(mid.north, 0, 1e-6))
  const east = cells.find((c) => c.dbz === 15)!
  assert.ok(near(east.east, 3 * kmPerPixel(A.lat), 0.05) && near(east.north, 0, 0.05), `three pixels east: ${east.east} km`)
  const nw = cells.find((c) => c.dbz === 31)!
  assert.ok(nw.east < 0 && nw.north > 0, 'north-west of the aircraft (north is up the tile)')
  for (const c of cells) {
    const p = radarPixel(c.lat, c.lon)
    assert.equal(`${p.x}/${p.y}`, '76/51')
    assert.ok(p.px >= 96 && p.px <= 104 && p.py >= 96 && p.py <= 104, `inside its block: ${p.px}, ${p.py}`)
  }
})

test('radarCells: no echo, no tile or only faint echo: no cells', () => {
  assert.deepEqual(radarCells(() => null, A.lat, A.lon), [])
  const t = blank()
  put(t, 100, 100, 14)
  assert.deepEqual(radarCells(tiles({ '76/51': t }).get, A.lat, A.lon), [])
})

test('radarCells: a tile is cut into 84 blocks of 3 pixels and a last block of 4; no block crosses into the next tile', () => {
  const row = place(76, 51, 250, 128)
  const next = blank()
  put(next, 0, 128, 22) // the first pixel of the next tile east: its own block
  const t = blank()
  put(t, 255, 128, 20)
  put(t, 252, 128, 30) // the same last block: 252 … 255
  put(t, 251, 128, 25) // the one before it: 249 … 251
  put(t, 255, 131, 21) // alone in the last block of its row of blocks (129 … 131)
  assert.deepEqual(byDbz(radarCells(tiles({ '76/51': t, '77/51': next }).get, row.lat, row.lon)), [21, 22, 25, 30])
  const column = place(76, 51, 128, 250)
  const below = blank()
  put(below, 128, 0, 24) // the first row of the tile below: its own block
  const u = blank()
  put(u, 128, 255, 18)
  put(u, 128, 252, 27) // the same last block: rows 252 … 255
  put(u, 128, 251, 26) // the one above it: rows 249 … 251
  put(u, 131, 255, 16) // alone in the last row of blocks, in the next block along
  assert.deepEqual(byDbz(radarCells(tiles({ '76/51': u, '76/52': below }).get, column.lat, column.lon)), [16, 24, 26, 27])
})

test('radarCells: only echoes within the radius (100 km), nearest first, each with its distance and its east and north', () => {
  const t = blank()
  put(t, 190, 100, 30) // 90 pixels east of the aircraft: about 93 km
  put(t, 80, 100, 33) // 21 pixels west: about 22 km
  put(t, 100, 40, 36) // 60 pixels north: about 62 km
  put(t, 199, 100, 39) // 99 pixels east: about 103 km: out
  put(t, 190, 160, 42) // 90 east and 60 south: about 112 km: out
  const cells = radarCells(tiles({ '76/51': t }).get, A.lat, A.lon)
  assert.deepEqual(cells.map((c) => c.dbz), [33, 36, 30], 'nearest first')
  const kmPx = kmPerPixel(A.lat)
  assert.ok(near(cells[0].fromKm, 21 * kmPx, 0.6) && cells[0].east < 0)
  assert.ok(near(cells[1].fromKm, 60 * kmPx, 0.9) && cells[1].north > 0 && near(cells[1].east, 0, 0.9))
  assert.ok(near(cells[2].fromKm, 90 * kmPx, 1.2))
  for (const c of cells) assert.ok(near(c.fromKm, Math.hypot(c.east, c.north), 1e-9) && c.fromKm <= 100)
  assert.deepEqual(radarCells(tiles({ '76/51': t }).get, A.lat, A.lon, undefined, 50).map((c) => c.dbz), [33], 'the radius is a parameter')
})

test('radarCells: asks only for the tiles the radius reaches (x round the world), once each; no radar near the poles; reads across tiles', () => {
  const s = tiles({})
  radarCells(s.get, 32, 34.9) // pixel (104, 250) of tile 76/51: the radius reaches the tile below, not the sides
  assert.deepEqual([...s.asked].sort(), ['76/51', '76/52'], 'each once')
  const w = tiles({})
  radarCells(w.get, 0, 179.95)
  assert.deepEqual([...w.asked].sort(), ['0/63', '0/64', '127/63', '127/64'], 'x wraps at the antimeridian')
  const p = tiles({})
  assert.deepEqual(radarCells(p.get, 85, 10), [])
  assert.deepEqual(radarCells(p.get, -81, 10), [])
  assert.equal(p.asked.length, 0)
  assert.ok(tiles({}).asked.length === 0 && radarCells(tiles({}).get, 79.9, 10).length === 0)
  const lower = blank()
  put(lower, 104, 3, 38) // the tile below: its row 3, so 9 pixels under the aircraft's row 250
  const cells = radarCells(tiles({ '76/52': lower }).get, 32, 34.9)
  assert.equal(cells.length, 1)
  assert.ok(cells[0].north < 0 && near(cells[0].fromKm, 9 * kmPerPixel(32), 1.5), `${cells[0].north}, ${cells[0].fromKm}`)
})

test('radarCells: across the antimeridian a cell has the longitude it is at (wrapped) and its east is the short way round', () => {
  const west = blank()
  put(west, 3, 128, 35) // just east of the antimeridian: tile 0
  const east = blank()
  put(east, 250, 128, 41) // just west of it: tile 127
  const at = place(127, 64, 253, 128)
  const cells = radarCells(tiles({ '0/64': west, '127/64': east }).get, at.lat, at.lon)
  assert.deepEqual(byDbz(cells), [35, 41])
  const w = cells.find((c) => c.dbz === 35)!
  assert.ok(w.east > 0 && w.east < 20 && w.lon < -179.9 && w.lon >= -180, `${w.east} km east, at ${w.lon}°`)
  const e = cells.find((c) => c.dbz === 41)!
  assert.ok(e.east < 0 && e.east > -10 && e.lon > 179.9 && e.lon <= 180, `${e.east} km, at ${e.lon}°`)
})

test('radarCells: the radar\'s own place is read and the cells come out shifted (where the weather is drawn: ?wxat)', () => {
  const t = blank()
  put(t, 100, 100, 33)
  const shifted = radarCells(tiles({ '76/51': t }).get, A.lat, A.lon, { dLat: 14.7, dLon: -26.4 })
  assert.equal(shifted.length, 1)
  assert.ok(near(shifted[0].lat, A.lat + 14.7, 1e-9) && near(shifted[0].lon, A.lon - 26.4, 1e-9))
  assert.ok(near(shifted[0].east, 0, 1e-6) && near(shifted[0].north, 0, 1e-6), 'its distance from the aircraft is the same')
  const across = radarCells(tiles({ '76/51': t }).get, A.lat, A.lon, { dLat: 0, dLon: 170 })
  assert.ok(across[0].lon >= -180 && across[0].lon <= 180, `${across[0].lon}: wrapped`)
})

test('radarCells: a block\'s seed is its own, the same whatever else is in the frame or where the aircraft is', () => {
  const t = blank()
  put(t, 100, 100, 33)
  put(t, 103, 100, 33)
  const a = radarCells(tiles({ '76/51': t }).get, A.lat, A.lon)
  assert.equal(new Set(a.map((c) => c.seed)).size, 2, 'a seed a block')
  const more = blank()
  put(more, 100, 100, 33)
  put(more, 103, 100, 33)
  put(more, 130, 130, 50)
  const moved = radarCells(tiles({ '76/51': more }).get, A.lat + 0.1, A.lon)
  assert.equal(moved.length, 3)
  for (const c of a) assert.ok(moved.some((m) => m.seed === c.seed && near(m.lat, c.lat, 1e-9) && near(m.lon, c.lon, 1e-9)), 'the same block, the same seed')
})

// ---- thin ----------------------------------------------------------------------------------------------------------------

/** A cell east and north km of the aircraft. */
function cell(east: number, north: number, dbz: number, seed = Math.round(east * 1000 + north)): RadarCell {
  return { lat: 32 + north / KM_PER_DEG, lon: 34.9 + east / (KM_PER_DEG * Math.cos((32 * Math.PI) / 180)), east, north, fromKm: Math.hypot(east, north), dbz, snow: false, seed }
}
const grid = (n: number, step: number, dbz: (i: number, j: number) => number): RadarCell[] =>
  Array.from({ length: n * n }, (_, k) => cell(((k % n) - n / 2) * step, (Math.floor(k / n) - n / 2) * step, dbz(k % n, Math.floor(k / n))))
const apart = (a: RadarCell, b: RadarCell): number => Math.hypot(a.east - b.east, a.north - b.north)

test('thin: the strongest cells first, none closer than m times the stronger one\'s reach, m = 1 when they fit', () => {
  const cells = [cell(0, 0, 40), cell(2, 0, 50), cell(0, 5, 35), cell(9, 9, 30)]
  const { kept, m } = thin(cells, () => 4, 10)
  assert.equal(m, 1)
  assert.deepEqual(kept.map((c) => c.dbz), [50, 35, 30], 'the 50 beats the 40 beside it; nearest first')
  assert.ok(kept.every((c, i) => kept.every((d, j) => i === j || apart(c, d) >= 4)))
  assert.deepEqual(thin(cells, () => 4, 10).kept, kept, 'the same cells, the same answer')
  assert.deepEqual(thin([...cells].reverse(), () => 4, 10).kept, kept, 'whatever their order')
  assert.deepEqual(thin([], () => 4, 10), { kept: [], m: 1 })
  const reach = (c: RadarCell): number => (c.dbz >= 50 ? 8 : 1)
  assert.deepEqual(thin(cells, reach, 10).kept.map((c) => c.dbz), [50, 30], 'each cell\'s own reach: the 50 keeps the 40 and the 35 (5 km off) away')
  const weak = (c: RadarCell): number => (c.dbz >= 50 ? 1 : 8)
  assert.deepEqual(thin([cell(0, 0, 50), cell(5, 0, 40), cell(9, 0, 35)], weak, 10).kept.map((c) => c.dbz), [50, 40], 'a weaker cell\'s reach keeps the weaker ones round it away')
  const a = cell(3, 4, 40, 1)
  const b = cell(4, 3, 40, 2) // the same strength, the same distance, 1.4 km from each other
  assert.deepEqual(thin([a, b], () => 4, 10).kept, [a])
  assert.deepEqual(thin([b, a], () => 4, 10).kept, [a], 'the lower seed, in either order')
})

test('thin: when more than max would stay, the spacing grows until at most max do (not much past it); then the nearest max', () => {
  const cells = grid(20, 3, () => 40) // 400 cells 3 km apart, the reach 3 km
  const { kept, m } = thin(cells, () => 3, 40, 4)
  assert.ok(m > 1 && m <= 4)
  assert.ok(kept.length <= 40 && kept.length >= 20, `${kept.length} kept at m = ${m}: room used, not overfilled`)
  for (let i = 0; i < kept.length; i++) for (let j = i + 1; j < kept.length; j++) assert.ok(apart(kept[i], kept[j]) >= m * 3 - 1e-9, `${apart(kept[i], kept[j])} km apart at m = ${m}`)
  assert.deepEqual(kept, [...kept].sort((a, b) => a.fromKm - b.fromKm), 'nearest first')
  const roomy = thin(cells, () => 3, 80, 4)
  assert.ok(roomy.m < m && roomy.kept.length <= 80 && roomy.kept.length > kept.length, `more room: a closer spacing (${roomy.m}) and more cells (${roomy.kept.length})`)
  const strict = thin(cells, () => 3, 2, 1.25) // it cannot grow past 1.25: the nearest 2 of what stays
  assert.equal(strict.kept.length, 2)
  assert.equal(strict.m, 1.25)
  assert.ok(strict.kept.every((c) => c.fromKm < 5), 'the nearest: next to the aircraft')
  assert.deepEqual(strict.kept, [...strict.kept].sort((a, b) => a.fromKm - b.fromKm), 'nearest first')
  const free = thin(cells, () => 3, 400, 4)
  assert.equal(free.m, 1)
  assert.equal(free.kept.length, 400, 'cells exactly the reach apart are not too close')
})

test('thin: a reach of next to nothing keeps every cell (up to max, the nearest) and does not build a grid the size of the map', () => {
  const cells = grid(20, 3, () => 40)
  const { kept, m } = thin(cells, () => 1e-9, 1000, 4)
  assert.equal(kept.length, 400)
  assert.equal(m, 1)
  assert.equal(thin(cells, () => 1e-9, 10, 4).kept.length, 10)
  assert.equal(thin(cells, () => 0, 1000, 4).kept.length, 400, 'no reach: no cell too close')
})

test('thin: strength decides before distance: a core is kept, the cells round it give way; max 0 keeps none', () => {
  const cells = grid(9, 3, (i, j) => (i === 8 && j === 8 ? 60 : 32)) // a core in the far corner of a field of 32 dBZ
  const { kept } = thin(cells, () => 6, 12, 4)
  assert.ok(kept.some((c) => c.dbz === 60), 'the core stays, however far')
  assert.ok(kept.length <= 12)
  assert.equal(thin(cells, () => 6, 0, 4).kept.length, 0)
})

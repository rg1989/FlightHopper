// client/scene/mvt.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { area, clip, decodeLayer, decodeLines, rings } from './mvt.ts'

test('rings: MoveTo/LineTo/ClosePath with zigzag deltas', () => {
  // MoveTo(1) (2,2); LineTo(3) +8,0 0,+8 -8,0; ClosePath — the square 2..10, clockwise on screen = exterior
  const g = [9, 4, 4, 26, 16, 0, 0, 16, 15, 0, 15]
  const [r] = rings(g)
  assert.deepEqual(r, [[2, 2], [10, 2], [10, 10], [2, 10]])
  assert.ok(area(r) > 0)
  assert.ok(area([...r].reverse()) < 0)
})

test('clip: a square over the right edge is cut at x = extent', () => {
  const c = clip([[90, 10], [110, 10], [110, 20], [90, 20]], 100)
  assert.equal(Math.max(...c.map((p) => p[0])), 100)
  assert.equal(Math.abs(area(c)), 100)
  assert.deepEqual(clip([[200, 10], [210, 10], [210, 20]], 100), [])
})

// A minimal protobuf writer for hand-made tiles: varints, and length-delimited fields.
const varint = (n: number): number[] => {
  const out: number[] = []
  do {
    out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0))
    n = Math.floor(n / 128)
  } while (n > 0)
  return out
}
const zig = (n: number): number => (n < 0 ? -2 * n - 1 : 2 * n)
const field = (num: number, bytes: number[]): number[] => [...varint((num << 3) | 2), ...varint(bytes.length), ...bytes]
const uint = (num: number, n: number): number[] => [...varint(num << 3), ...varint(n)]
const str = (num: number, t: string): number[] => field(num, [...new TextEncoder().encode(t)])
const packed = (num: number, ns: number[]): number[] => field(num, ns.flatMap(varint))
const feature = (type: number, tags: number[], geom: number[]): number[] => field(2, [...uint(1, 1), ...packed(2, tags), ...uint(3, type), ...packed(4, geom)])
const layer = (name: string, keys: string[], vals: string[], feats: number[][]): number[] =>
  field(3, [...uint(15, 2), ...str(1, name), ...feats.flat(), ...keys.flatMap((k) => str(3, k)), ...vals.flatMap((v) => field(4, str(1, v))), ...uint(5, 4096)])

test("decodeLines: a layer's lines (MoveTo starts each), with their properties; polygons and other layers left out", () => {
  // a road: MoveTo (10, 20), LineTo (+100, 0) (0, +50); then a second part: MoveTo (+5, +5), LineTo (+1, +1)
  const road = [9, zig(10), zig(20), 18, zig(100), 0, 0, zig(50), 9, zig(5), zig(5), 10, zig(1), zig(1)]
  const square = [9, 4, 4, 26, 16, 0, 0, 16, 15, 0, 15]
  const tile = new Uint8Array([
    ...layer('building', ['render_height'], ['9'], [feature(3, [0, 0], square)]),
    ...layer('transportation', ['class'], ['primary', 'minor'], [feature(2, [0, 0], road), feature(3, [0, 1], square)]),
  ])
  const t = decodeLines(tile, 'transportation')!
  assert.equal(t.extent, 4096)
  assert.equal(t.features.length, 1)
  assert.deepEqual(t.features[0].props, { class: 'primary' })
  assert.deepEqual(t.features[0].lines, [[[10, 20], [110, 20], [110, 70]], [[115, 75], [116, 76]]])
  assert.equal(decodeLines(tile, 'water'), null)
  // the polygon path still reads its layer (one walk, shared)
  const b = decodeLayer(tile, 'building')!
  assert.equal(b.features.length, 1)
  assert.deepEqual(b.features[0].polys[0][0], [[2, 2], [10, 2], [10, 10], [2, 10]])
})

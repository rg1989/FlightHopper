// client/scene/mvt.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { area, clip, rings } from './mvt.ts'

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

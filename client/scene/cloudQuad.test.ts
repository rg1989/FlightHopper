// client/scene/cloudQuad.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EDGE_ALPHA, SLICE_MAX, edgeAlpha, ndDotAt, quadReach, softSlice, staysInside, type Size } from './cloudQuad.ts'

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol

/** The reach of the region of hits along x, found by walking out from the middle of the quad (offsets in quad units, 0.5 = its edge). */
function scannedReach(m: Size, slice: number, along: 'x' | 'y' = 'x'): number {
  let last = 0
  for (let j = 1; j <= 1600; j++) {
    const u = (j / 1600) * 0.9
    if (ndDotAt(m, slice, along === 'x' ? u : 0, along === 'y' ? u : 0) < 0) break
    last = u
  }
  return 2 * last
}

/** The most alpha the shader can draw (no noise: 1.3 ndDot³) on the edge of what it draws, by walking every direction out to the last hit inside the quad. */
function scannedEdge(m: Size, slice: number): number {
  let best = 0
  for (let k = 0; k <= 90; k++) {
    const a = (k / 90) * (Math.PI / 2)
    const uQuad = 0.5 / Math.max(Math.cos(a), Math.sin(a))
    let last = 0
    for (let j = 1; j <= 1600; j++) {
      const u = (j / 1600) * Math.min(uQuad, 0.9)
      if (ndDotAt(m, slice, u * Math.cos(a), u * Math.sin(a)) < 0) break
      last = u
    }
    if (last > 0) best = Math.max(best, Math.min(1, 1.3 * ndDotAt(m, slice, last * Math.cos(a), last * Math.sin(a)) ** 3))
  }
  return best
}

const SHAPES: Size[] = [[20, 12, 12], [30, 15, 14], [46, 9, 10], [17, 16, 16], [22, 12, 10], [27, 15, 15], [14, 14, 18], [52, 8, 8], [10, 8, 10], [12, 20, 14], [9, 26, 12], [14.5, 18.8, 16]] // the last three taller than wide: a tower's puff can be

test('ndDotAt: 1 in the middle of the quad, falling outwards, none where the ray misses the cloud or the slice cuts it away', () => {
  for (const m of SHAPES) {
    assert.ok(near(ndDotAt(m, 0.3, 0, 0), 1, 1e-9), `${m}: the middle faces the eye`)
    let prev = 1
    for (let u = 0.02; u < 0.25; u += 0.02) {
      const nd = ndDotAt(m, 0.3, u, 0)
      assert.ok(nd >= 0 && nd <= prev + 1e-12, `${m} at ${u}: ${nd} after ${prev}`)
      prev = nd
    }
    assert.equal(ndDotAt(m, 0.3, 0.5, 0.5), -1, 'the corner of the quad is no hit')
  }
  assert.equal(ndDotAt([20, 12, 12], 0.2, 0.47, 0), -1, 'the slice cuts the cloud away beyond its disc (it ends at 0.446)')
  assert.ok(ndDotAt([20, 12, 12], 0.2, 0.43, 0) >= 0)
  assert.ok(ndDotAt([20, 12, 12], -1, 0.5, 0) >= 0, 'no slice: the whole sphere, to its silhouette')
})

test('quadReach: where the cloud ends in its quad, the same along x and y, by maximumSize.z and the slice: not by the quad\'s aspect nor maximumSize.x and .y', () => {
  for (const m of SHAPES) {
    for (const slice of [-1, 0.18, 0.25, 0.32, 0.4, 0.5, 0.6, 0.8]) {
      const r = quadReach(m, slice)
      assert.ok(near(scannedReach(m, slice, 'x'), r, 0.004) || (r > 1.8 && scannedReach(m, slice, 'x') > 1.75), `${m} slice ${slice}: ${r} against ${scannedReach(m, slice, 'x')} along x`)
      assert.ok(near(scannedReach(m, slice, 'y'), r, 0.004) || (r > 1.8 && scannedReach(m, slice, 'y') > 1.75), `${m} slice ${slice}: ${r} against ${scannedReach(m, slice, 'y')} along y`)
    }
  }
  for (const slice of [0.2, 0.3, 0.45]) {
    const base = quadReach([20, 12, 14], slice)
    for (const [mx, my] of [[8, 5], [30, 12], [50, 25], [12, 40]]) assert.ok(near(quadReach([mx, my, 14], slice), base, 1e-12), `${mx} × ${my} reaches as far as 20 × 12`)
  }
})

test('quadReach: the figures behind it: Cesium\'s own default cloud (20 × 12 × 12, no slice) just fills its quad; a slice that cuts near the front of the cloud ends it well inside', () => {
  assert.ok(near(quadReach([20, 12, 12], -1), 1.036, 0.002))
  assert.ok(near(quadReach([30, 15, 14], 0.34), 0.9994, 0.002), 'an overcast puff (slice 0.34) reaches the quad\'s edge')
  assert.ok(near(quadReach([30, 15, 10], 0.24), 0.851, 0.003))
  assert.ok(quadReach([17, 16, 16], 0.2) < quadReach([17, 16, 16], 0.3), 'a lower slice cuts a smaller disc')
  assert.ok(quadReach([20, 12, 8], 0.3) < quadReach([20, 12, 14], 0.3), 'a shallower cloud ends sooner')
})

test('edgeAlpha: the most a puff can draw where it ends (its cut, or the quad\'s edge if it gets there): a hard rim for a low slice and a narrow cloud, none for a high slice', () => {
  assert.ok(edgeAlpha([46, 9, 8], 0.26) > 0.1, `a flat anvil cut low: ${edgeAlpha([46, 9, 8], 0.26)}`)
  assert.ok(edgeAlpha([14, 14, 14], 0.18) > 0.1, 'a tower puff cut low')
  assert.ok(edgeAlpha([30, 15, 14], 0.34) < 0.01, 'an overcast puff that reaches the quad: ndDot is nothing there')
  assert.ok(edgeAlpha([20, 12, 12], -1) < 0.03, 'a whole ellipsoid ends at its silhouette, where it faces away')
  assert.ok(edgeAlpha([14, 14, 14], 0.9) < 0.01)
  for (const m of SHAPES) {
    for (const slice of [0.18, 0.25, 0.3, 0.4, 0.5]) {
      const cf = edgeAlpha(m, slice)
      const scan = scannedEdge(m, slice)
      assert.ok(cf <= scan * 1.001 + 1e-3 && cf >= scan * 0.9 - 1e-3, `${m} slice ${slice}: ${cf} against a scan's ${scan} (the scan stops just short of the edge, so it reads a little high)`)
    }
  }
})

test('edgeAlpha: falls as the slice rises, for every shape (so softSlice can search it)', () => {
  for (const mx of [8, 14, 22, 30, 46, 52]) {
    for (const my of [7, 9, 13, 16, 19]) {
      for (const mz of [8, 10, 12, 14, 16, 18, 22]) {
        let prev = Infinity
        for (let s = 0.1; s <= SLICE_MAX + 1e-9; s += 0.02) {
          const e = edgeAlpha([mx, my, mz], s)
          assert.ok(e <= prev + 1e-9, `${mx},${my},${mz} slice ${s}: ${e} after ${prev}`)
          prev = e
        }
      }
    }
  }
})

test('softSlice: a slice that already ends soft stays; a harder one is raised just far enough that the most the shader can draw at the end of the puff is EDGE_ALPHA; never lowered, never past SLICE_MAX', () => {
  assert.equal(EDGE_ALPHA, 0.03)
  for (const m of SHAPES) {
    for (const slice of [0.18, 0.22, 0.26, 0.3, 0.34, 0.4, 0.45, 0.6]) {
      const s = softSlice(m, slice)
      assert.ok(s >= slice && s <= SLICE_MAX, `${m} ${slice} → ${s}`)
      if (edgeAlpha(m, slice) <= EDGE_ALPHA) assert.equal(s, slice, `${m} ${slice} is soft already`)
      else {
        assert.ok(edgeAlpha(m, s) <= EDGE_ALPHA + 1e-9 || s === SLICE_MAX, `${m} ${slice} → ${s}: ${edgeAlpha(m, s)}`)
        assert.ok(edgeAlpha(m, s - 0.002) > EDGE_ALPHA || s === SLICE_MAX, `${m} ${slice} → ${s}: no further than it takes`)
      }
    }
  }
  assert.ok(near(softSlice([46, 9, 8], 0.26), 0.402, 0.003), 'a flat anvil needs a slice of about 0.4')
  assert.ok(near(softSlice([17, 16, 16], 0.22), 0.291, 0.003), 'a tower puff about 0.29')
  assert.equal(softSlice([30, 15, 12], 0.3), 0.3, 'an overcast puff is soft already')
  for (const m of [[1, 0.5, 100], [2, 2, 2], [8, 8, 8]] as const) { // narrow clouds: hard at 0.2, soft only well above it
    const s = softSlice(m, 0.2)
    assert.ok(s > 0.2 && s < SLICE_MAX && staysInside({ maxSize: m, slice: s }), `${m}: ${s}`)
    assert.ok(edgeAlpha(m, SLICE_MAX) < 0.001, `${m}: the highest slice is soft`)
  }
})

test('staysInside: a puff does where the most the shader can draw at its end is EDGE_ALPHA or less', () => {
  assert.equal(staysInside({ maxSize: [46, 9, 8], slice: 0.26 }), false)
  assert.equal(staysInside({ maxSize: [46, 9, 8], slice: softSlice([46, 9, 8], 0.26) }), true)
  assert.equal(staysInside({ maxSize: [30, 15, 14], slice: 0.34 }), true)
  assert.equal(staysInside({ maxSize: [20, 12, 12], slice: -1 }), true)
})

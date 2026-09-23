// client/scene/exaggeration.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TerrainFrame } from '../types.ts'
import { TOPO_ON, drawnHeightM, rescaleSampledM, smoothstep, trueHeightM } from './exaggeration.ts'

// LOWI: runway HAE (the relH Topography latches within 30 km) and a point high on the Nordkette, true HAE.
const LOWI_RWY = 628.4
const NORDKETTE = 2_317.9
// KSFO: the runway is below the ellipsoid, and the bay (at the geoid) lower still.
const KSFO_RWY = -28
const BAY = -32.3

function near(actual: number | null, expected: number, tolM = 1e-9): void {
  assert.ok(actual !== null && Math.abs(actual - expected) <= tolM, `${actual} ≠ ${expected} ± ${tolM}`)
}

test('drawnHeightM is Cesium’s (h − relH)·f + relH: unchanged at 1, relH everywhere at 0', () => {
  near(drawnHeightM(NORDKETTE, 1, LOWI_RWY), NORDKETTE)
  near(drawnHeightM(NORDKETTE, 0, LOWI_RWY), LOWI_RWY)
  near(drawnHeightM(BAY, 0, KSFO_RWY), KSFO_RWY)
  near(drawnHeightM(NORDKETTE, 0.5, LOWI_RWY), 1_473.15) // halfway between runway and peak
  near(drawnHeightM(BAY, 0.5, KSFO_RWY), -30.15) // below relH, relH below the ellipsoid
  near(drawnHeightM(LOWI_RWY, 0.37, LOWI_RWY), LOWI_RWY) // relH itself never moves
})

test('TOPO_ON is 1 + 1e-5, never exactly 1, and moves the Nordkette by less than 2 cm', () => {
  assert.equal(TOPO_ON, 1 + 1e-5)
  assert.notEqual(TOPO_ON, 1)
  const moveM = drawnHeightM(NORDKETTE, TOPO_ON, LOWI_RWY) - NORDKETTE
  assert.ok(moveM > 0 && moveM < 0.02, `peak moved ${moveM} m`)
})

test('trueHeightM inverts drawnHeightM (LOWI at 0.5, KSFO below the ellipsoid, round trips)', () => {
  near(trueHeightM(1_473.15, 0.5, LOWI_RWY), NORDKETTE)
  near(trueHeightM(-30.15, 0.5, KSFO_RWY), BAY)
  for (const f of [TOPO_ON, 1, 0.75, 0.5]) {
    for (const [h, rel] of [[NORDKETTE, LOWI_RWY], [BAY, KSFO_RWY], [LOWI_RWY, LOWI_RWY], [8_848, 0]]) {
      near(trueHeightM(drawnHeightM(h, f, rel), f, rel), h)
    }
  }
})

test('trueHeightM is null while the ground is flat or nearly so (0, the 1e-7 nudge, 0.25)', () => {
  assert.equal(trueHeightM(LOWI_RWY, 0, LOWI_RWY), null)
  // A flat triangle under the curved Earth reads ~3 cm low in its middle; divided by 1e-7 that would be −300 km.
  assert.equal(trueHeightM(LOWI_RWY - 0.03, 1e-7, LOWI_RWY), null)
  assert.equal(trueHeightM(drawnHeightM(NORDKETTE, 0.25, LOWI_RWY), 0.25, LOWI_RWY), null)
})

test('rescaleSampledM turns a reading of any age into this frame’s drawn ground (LOWI, steepest grow step)', () => {
  const fr: TerrainFrame = { fSampled: 0.4, fNow: 0.41, relHM: LOWI_RWY } // Δf 0.01: smoothstep’s peak at 60 fps
  const sampled = drawnHeightM(NORDKETTE, fr.fSampled, fr.relHM) // what globe.getHeight read in preUpdate
  const drawn = drawnHeightM(NORDKETTE, fr.fNow, fr.relHM)
  assert.ok(drawn - sampled > 15, `raw lag ${drawn - sampled} m`) // more than the chase camera’s 15 m clearance
  near(rescaleSampledM(sampled, fr.fSampled, fr.fNow, fr.relHM), drawn)
  near(rescaleSampledM(drawnHeightM(BAY, 0.6, KSFO_RWY), 0.6, 0.59, KSFO_RWY), drawnHeightM(BAY, 0.59, KSFO_RWY))
  near(rescaleSampledM(2_000, TOPO_ON, TOPO_ON, LOWI_RWY), 2_000) // steady: the reading as it is
  near(rescaleSampledM(drawnHeightM(NORDKETTE, 0.02, LOWI_RWY), 0.02, 0, LOWI_RWY), LOWI_RWY) // last frame of a sink
  // A kept reading (WP-E1's GroundMemo) passes the factor it was read at: f(1) of a 60 fps grow, used at f(37).
  const kept = drawnHeightM(NORDKETTE, 1.34e-4, LOWI_RWY)
  near(rescaleSampledM(kept, 1.34e-4, 0.1525, LOWI_RWY), drawnHeightM(NORDKETTE, 0.1525, LOWI_RWY))
})

test('rescaleSampledM from a flat ground returns relH (0, the 1e-7 nudge, a re-latched relH, a kept reading)', () => {
  near(rescaleSampledM(LOWI_RWY, 0, 1.34e-4, LOWI_RWY), LOWI_RWY) // first frame of a grow at 60 fps
  // After the nudge the flat ground rests at 1e-7. A reading 3 cm low must not be multiplied by 1,340 (40 m).
  near(rescaleSampledM(LOWI_RWY - 0.03, 1e-7, 1.34e-4, LOWI_RWY), LOWI_RWY)
  near(rescaleSampledM(LOWI_RWY, 1e-7, 1e-7, 700), 700) // re-latched while flat: the reading holds the old plane
  // Read while flat and kept to f(37) of the grow: still relH, off by fNow·relief (258 m under the drawn Nordkette).
  const flatKept = rescaleSampledM(LOWI_RWY, 1e-7, 0.1525, LOWI_RWY)
  near(drawnHeightM(NORDKETTE, 0.1525, LOWI_RWY) - flatKept, 0.1525 * (NORDKETTE - LOWI_RWY), 1e-6)
  // The second frame of the grow already rescales.
  const sampled = drawnHeightM(NORDKETTE, 1.34e-4, LOWI_RWY)
  near(rescaleSampledM(sampled, 1.34e-4, 5.35e-4, LOWI_RWY), drawnHeightM(NORDKETTE, 5.35e-4, LOWI_RWY))
})

test('smoothstep: 0 → 1 with flat ends, symmetric, clamped for inputs in any order', () => {
  assert.equal(smoothstep(0), 0)
  assert.equal(smoothstep(1), 1)
  assert.equal(smoothstep(0.5), 0.5)
  near(smoothstep(0.25) + smoothstep(0.75), 1)
  assert.ok(smoothstep(0.001) < 1e-5) // zero slope at the start: the first frame of a grow is nearly flat
  // A reversed or restarted animation feeds u backwards and out of range: each value stands on its own.
  const us = [0.9, -0.2, 0.3, 1.7, 0.3, 0, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, 0.6]
  const want = [0.972, 0, 0.216, 1, 0.216, 0, 0, 0, 1, 0.648]
  us.forEach((u, i) => near(smoothstep(u), want[i], 1e-12))
  let prev = 0
  for (let u = -0.5; u <= 1.5; u += 0.01) {
    const s = smoothstep(u)
    assert.ok(s >= prev && s <= 1, `smoothstep(${u}) = ${s}`)
    prev = s
  }
})

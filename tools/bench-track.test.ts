// tools/bench-track.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateG2, type G2Metrics } from './bench-track.ts'

// ---- evaluateG2 on hand-made metrics ----

function good(): G2Metrics {
  return {
    hex: 'abc123', quality: 'adsb2', samples: 200, frames: 12_000,
    delayS: { start: 3, p50: 3, max: 3 },
    starvationFrames: 0, gapFrames: 0,
    frameDiscontinuity: { maxM: 0.5, p99M: 0.01 },
    lateralAccel: { p99: 3.5, max: 4 },
    jerk: { p99: 1 },
    vertical: { vsErrP95: 1, maxStepM: 0.2 },
    delaySlew: 0.2,
    rejoin: { count: 1, errP95M: 200, blendMaxS: 1.45 },
    crossTrack: [
      { k: 3, nTurn: 60, nStraight: 80, turnP95M: 1, straightP95M: 0.5, linearTurnP95M: 3.5 },
      { k: 5, nTurn: 70, nStraight: 90, turnP95M: 4, straightP95M: 1, linearTurnP95M: 10 },
    ],
    dedupe: { served: 250, unique: 200, duplicateFraction: 0.2, jerkP99NoDedupe: null },
  }
}

const failing = (m: G2Metrics): string[] => evaluateG2(m).checks.filter((c) => !c.pass).map((c) => c.name)

test('evaluateG2: a metric set inside every ADS-B v2 bar passes', () => {
  const r = evaluateG2(good())
  assert.equal(r.pass, true)
  assert.deepEqual(r.checks.map((c) => [c.name, c.threshold]), [
    ['frameDiscontinuityMaxM', 2], ['starvationFrames', 0],
    ['crossTrackTurnP95M@3', 5], ['crossTrackTurnVsLinear@3', 0.5], ['crossTrackTurnP95M@5', 15], ['crossTrackTurnVsLinear@5', 0.5],
    ['lateralAccelP99', 5.7], ['vsErrP95', 2], ['verticalMaxStepM', 1], ['delaySlew', 0.2], ['rejoinBlendMaxS', 1.5],
  ])
})

test('evaluateG2: each bar fails on its own', () => {
  const cases: [string, (m: G2Metrics) => void][] = [
    ['frameDiscontinuityMaxM', (m) => (m.frameDiscontinuity.maxM = 2.5)],
    ['starvationFrames', (m) => (m.starvationFrames = 1)],
    ['crossTrackTurnP95M@3', (m) => Object.assign(m.crossTrack[0], { turnP95M: 6, linearTurnP95M: 20 })],
    ['crossTrackTurnVsLinear@3', (m) => Object.assign(m.crossTrack[0], { turnP95M: 2, linearTurnP95M: 3 })],
    ['crossTrackTurnP95M@5', (m) => Object.assign(m.crossTrack[1], { turnP95M: 16, linearTurnP95M: 40 })],
    ['crossTrackTurnVsLinear@5', (m) => Object.assign(m.crossTrack[1], { turnP95M: 6, linearTurnP95M: 10 })],
    ['lateralAccelP99', (m) => (m.lateralAccel.p99 = 5.8)],
    ['vsErrP95', (m) => (m.vertical.vsErrP95 = 2.1)],
    ['verticalMaxStepM', (m) => (m.vertical.maxStepM = 1.2)],
    ['delaySlew', (m) => (m.delaySlew = 0.25)],
    ['rejoinBlendMaxS', (m) => (m.rejoin.blendMaxS = 1.6)],
  ]
  for (const [name, spoil] of cases) {
    const m = good()
    spoil(m)
    assert.deepEqual(failing(m), [name])
    assert.equal(evaluateG2(m).pass, false)
  }
})

test('evaluateG2: no data fails, float noise at a bar does not, no re-join passes', () => {
  const nan = good()
  nan.frameDiscontinuity.maxM = NaN
  assert.deepEqual(failing(nan), ['frameDiscontinuityMaxM'])
  const no5 = good()
  no5.crossTrack = no5.crossTrack.slice(0, 1)
  assert.deepEqual(failing(no5), ['crossTrackTurnP95M@5', 'crossTrackTurnVsLinear@5'])
  const edge = good()
  edge.delaySlew = 0.2 + 1e-12
  edge.lateralAccel.p99 = 5.7
  assert.deepEqual(failing(edge), [])
  const calm = good()
  calm.rejoin = { count: 0, errP95M: NaN, blendMaxS: 0 }
  assert.equal(evaluateG2(calm).pass, true)
  const inf = good()
  inf.rejoin.blendMaxS = Infinity
  assert.deepEqual(failing(inf), ['rejoinBlendMaxS'])
})

test('evaluateG2: an MLAT hex is held to the separate bar, lateral acceleration p99 ≤ 0.5 g', () => {
  const m = good()
  m.quality = 'mlat'
  m.lateralAccel.p99 = 4.8
  m.crossTrack = [] // not gated for MLAT
  const r = evaluateG2(m)
  assert.equal(r.pass, true)
  assert.deepEqual(r.checks.map((c) => c.name), ['lateralAccelP99'])
  assert.ok(Math.abs(r.checks[0].threshold - 4.903325) < 1e-9)
  m.lateralAccel.p99 = 5 // inside the ADS-B bar, outside the MLAT one
  assert.equal(evaluateG2(m).pass, false)
})

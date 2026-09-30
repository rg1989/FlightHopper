// client/ui/chasePresets.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// chasePresets.ts imports its CSS for Vite. Node cannot load CSS, so this test process loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})

const { AUTO_ORDER, PRESETS, ease, glide, presetAt } = await import('./chasePresets.ts')

const near = (a: number, b: number, eps = 1e-9): void => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`)
const wrap = (deg: number): number => ((deg % 360) + 360) % 360

test('PRESETS: inside the orbit\'s limits (OrbitControl: pitch -89..10, range 25..3000 m); Behind is the chase\'s start', () => {
  for (const p of Object.values(PRESETS)) {
    assert.ok(p.pitchDeg >= -89 && p.pitchDeg <= 10, p.label)
    assert.ok(p.rangeM >= 25 && p.rangeM <= 3000, p.label)
  }
  assert.deepEqual({ ...PRESETS.behind, label: '' }, { label: '', headingDeg: 0, pitchDeg: -12, rangeM: 150 })
  // The sides as the orbit turns: a positive offset puts the camera on the aircraft's left.
  assert.ok(PRESETS.left.headingDeg > 0 && PRESETS.right.headingDeg < 0)
  assert.deepEqual([...AUTO_ORDER].sort(), Object.keys(PRESETS).sort(), 'the tour visits every preset')
})

test('ease: 0 → 0, 1 → 1, half way at the middle, slow at both ends, clamped outside', () => {
  near(ease(0), 0)
  near(ease(1), 1)
  near(ease(0.5), 0.5)
  assert.ok(ease(0.1) < 0.1 && ease(0.9) > 0.9, 'slow start and end')
  for (let k = 0; k < 1; k += 0.05) assert.ok(ease(k + 0.05) >= ease(k), 'never back')
  near(ease(-1), 0)
  near(ease(2), 1)
})

test('glide: from at 0, to at 1; the heading the short way round, the range by the same ratio each step', () => {
  const a = { headingDeg: 350, pitchDeg: -10, rangeM: 150 }
  const b = { headingDeg: 10, pitchDeg: -30, rangeM: 1200 }
  assert.deepEqual(glide(a, b, 0), a)
  const end = glide(a, b, 1)
  near(wrap(end.headingDeg), 10)
  near(end.pitchDeg, -30)
  near(end.rangeM, 1200)
  const mid = glide(a, b, 0.5)
  near(wrap(mid.headingDeg), 0) // through the nose's line, not round the back
  near(mid.pitchDeg, -20)
  near(mid.rangeM, Math.sqrt(150 * 1200))
  // Behind to the right side turns 90° right, not 270° left.
  near(glide(PRESETS.behind, PRESETS.right, 0.5).headingDeg, PRESETS.right.headingDeg / 2)
})

test('presetAt: the preset an orbit is at (as ?cam= rounds it), null elsewhere', () => {
  for (const [id, p] of Object.entries(PRESETS)) assert.equal(presetAt(p), id)
  assert.equal(presetAt({ headingDeg: 270, pitchDeg: -6, rangeM: 120 }), 'right', 'the heading wrapped')
  assert.equal(presetAt({ headingDeg: 0.4, pitchDeg: -12, rangeM: 151 }), 'behind')
  assert.equal(presetAt({ headingDeg: 15, pitchDeg: -12, rangeM: 150 }), null, 'one orbit press away')
  assert.equal(presetAt({ headingDeg: 0, pitchDeg: -12, rangeM: 225 }), null, 'one zoom away')
})

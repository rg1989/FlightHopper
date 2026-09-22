// client/track/attitude.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AttitudeSmoother, targetAttitude, turnRateDegS } from './attitude.ts'
import type { Att, Phase } from './types.ts'

const KT = 1852 / 3600
const G = 9.80665
const DEG = 180 / Math.PI

type In = Parameters<typeof targetAttitude>[0]
const base: In = { gsMs: 140 * KT, vsMs: 0, headingDeg: 90, broadcastRollDeg: null, turnRateDegS: 0, onGround: false, phase: null, mlat: false }
const att = (p: Partial<In>): Att => targetAttitude({ ...base, ...p })

const near = (a: number, b: number, tol: number, msg?: string): void =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} got ${a}, expected ${b} ± ${tol}`)

// ---------- targetAttitude ----------

test('level cruise: pitch ≈ 2° (cruise AoA), wings level, heading passes through', () => {
  const a = att({ gsMs: 450 * KT })
  near(a.pitchDeg, 2, 1e-9)
  near(a.rollDeg, 0, 1e-9)
  assert.equal(a.headingDeg, 90)
})

test('1500 fpm climb at 160 kt: pitch ≈ atan(7.62/82.3) + 6', () => {
  const a = att({ gsMs: 160 * KT, vsMs: (1500 * 0.3048) / 60 })
  near(a.pitchDeg, Math.atan(7.62 / 82.3) * DEG + 6, 0.02) // ≈ 11.29°
})

test('phase sets the AoA: ground 0, takeoff/climb 6, cruise/descent 2, approach/landing 4', () => {
  const aoa: [Phase, number][] = [['ground', 0], ['takeoff', 6], ['climb', 6], ['cruise', 2], ['descent', 2], ['approach', 4], ['landing', 4]]
  for (const [phase, deg] of aoa) near(att({ phase }).pitchDeg, deg, 1e-9, phase)
  // a 3° approach: flight path −3° + AoA 4° → nose 1° up
  const gs = 140 * KT
  near(att({ phase: 'approach', gsMs: gs, vsMs: -gs * Math.tan(3 / DEG) }).pitchDeg, 1, 1e-9)
})

test('phase null → inferred from vs: climb above +1.5 m/s, descent below −1.5 m/s, else cruise', () => {
  const gs = base.gsMs
  near(att({ vsMs: 3 }).pitchDeg, Math.atan2(3, gs) * DEG + 6, 1e-9, 'climb')
  near(att({ vsMs: -3 }).pitchDeg, Math.atan2(-3, gs) * DEG + 2, 1e-9, 'descent')
  near(att({ vsMs: 1 }).pitchDeg, Math.atan2(1, gs) * DEG + 2, 1e-9, 'level band')
  near(att({ vsMs: -1 }).pitchDeg, Math.atan2(-1, gs) * DEG + 2, 1e-9, 'level band')
})

test('coordinated turn 3°/s at 140 kt: roll = atan(V·ω/g), right turn = right wing down', () => {
  const V = 140 * KT
  const expected = Math.atan((V * (3 / DEG)) / G) * DEG // ≈ 21.0°
  near(att({ turnRateDegS: 3 }).rollDeg, expected, 1e-9)
  near(att({ turnRateDegS: -3 }).rollDeg, -expected, 1e-9)
  assert.ok(expected > 20 && expected < 22)
})

test('broadcast roll overrides the coordinated-turn estimate', () => {
  near(att({ turnRateDegS: 3, broadcastRollDeg: -12 }).rollDeg, -12, 1e-9)
  near(att({ turnRateDegS: 3, broadcastRollDeg: 0 }).rollDeg, 0, 1e-9)
})

test('on ground: roll 0 and pitch 0 whatever the inputs say', () => {
  const a = att({ onGround: true, vsMs: 2, broadcastRollDeg: 5, turnRateDegS: 3, phase: 'takeoff', headingDeg: 280 })
  assert.equal(a.pitchDeg, 0)
  assert.equal(a.rollDeg, 0)
  assert.equal(a.headingDeg, 280)
})

test('MLAT: roll 0 (turn rate from MLAT positions is noise); pitch still computed', () => {
  const a = att({ mlat: true, turnRateDegS: 3, broadcastRollDeg: 10, vsMs: 3 })
  assert.equal(a.rollDeg, 0)
  near(a.pitchDeg, Math.atan2(3, base.gsMs) * DEG + 6, 1e-9)
})

test('clamps: pitch to [−15, 25], roll to ±35', () => {
  near(att({ gsMs: 10, vsMs: 100 }).pitchDeg, 25, 1e-9)
  near(att({ gsMs: 10, vsMs: -100 }).pitchDeg, -15, 1e-9)
  near(att({ broadcastRollDeg: 50 }).rollDeg, 35, 1e-9)
  near(att({ broadcastRollDeg: -50 }).rollDeg, -35, 1e-9)
  near(att({ gsMs: 250 * KT, turnRateDegS: 20 }).rollDeg, 35, 1e-9)
  near(att({ gsMs: 250 * KT, turnRateDegS: -20 }).rollDeg, -35, 1e-9)
})

test('heading is normalised to [0, 360)', () => {
  near(att({ headingDeg: -10 }).headingDeg, 350, 1e-9)
  near(att({ headingDeg: 370 }).headingDeg, 10, 1e-9)
  near(att({ headingDeg: 360 }).headingDeg, 0, 1e-9)
})

// ---------- turnRateDegS ----------

test('turnRateDegS: plain difference over dt', () => {
  near(turnRateDegS(90, 120, 10), 3, 1e-9)
  near(turnRateDegS(120, 90, 10), -3, 1e-9)
})

test('turnRateDegS: wrap-safe across north both ways', () => {
  near(turnRateDegS(350, 10, 10), 2, 1e-9)
  near(turnRateDegS(10, 350, 10), -2, 1e-9)
  near(turnRateDegS(359, 1, 1), 2, 1e-9)
  near(turnRateDegS(1, 359, 1), -2, 1e-9)
})

test('turnRateDegS: dt ≤ 0 → 0', () => {
  assert.equal(turnRateDegS(10, 20, 0), 0)
  assert.equal(turnRateDegS(10, 20, -1), 0)
})

// ---------- AttitudeSmoother ----------

test('smoother: the first step returns the target', () => {
  const s = new AttitudeSmoother(2)
  assert.deepEqual(s.step({ headingDeg: 45, pitchDeg: 3, rollDeg: -5 }, 0.016), { headingDeg: 45, pitchDeg: 3, rollDeg: -5 })
})

test('smoother: converges with time constant tau, independent of step size', () => {
  const target: Att = { headingDeg: 0, pitchDeg: 10, rollDeg: 20 }
  const fine = new AttitudeSmoother(2)
  fine.step({ headingDeg: 0, pitchDeg: 0, rollDeg: 0 }, 0)
  let a: Att = { headingDeg: 0, pitchDeg: 0, rollDeg: 0 }
  for (let i = 0; i < 120; i++) a = fine.step(target, 2 / 120) // 60 Hz for tau seconds
  const k = 1 - Math.exp(-1)
  near(a.pitchDeg, 10 * k, 1e-9)
  near(a.rollDeg, 20 * k, 1e-9)
  const coarse = new AttitudeSmoother(2)
  coarse.step({ headingDeg: 0, pitchDeg: 0, rollDeg: 0 }, 0)
  near(coarse.step(target, 2).pitchDeg, 10 * k, 1e-9)
  for (let i = 0; i < 1200; i++) a = fine.step(target, 1 / 60) // 20 s more: residual e^−11
  near(a.pitchDeg, 10, 1e-3)
  near(a.rollDeg, 20, 1e-3)
})

test('smoother: default tau is 1 s', () => {
  const s = new AttitudeSmoother()
  s.step({ headingDeg: 0, pitchDeg: 0, rollDeg: 0 }, 0)
  near(s.step({ headingDeg: 0, pitchDeg: 10, rollDeg: 0 }, 1).pitchDeg, 10 * (1 - Math.exp(-1)), 1e-9)
})

test('smoother: heading 359 → 1 goes the short way through north', () => {
  const s = new AttitudeSmoother(1)
  s.step({ headingDeg: 359, pitchDeg: 0, rollDeg: 0 }, 0)
  for (let i = 0; i < 300; i++) {
    const h = s.step({ headingDeg: 1, pitchDeg: 0, rollDeg: 0 }, 1 / 60).headingDeg
    assert.ok(h >= 0 && h < 360, `normalised: ${h}`)
    assert.ok(h >= 359 || h <= 1, `stayed on the 2° arc through north: ${h}`)
  }
  const t = new AttitudeSmoother(1)
  t.step({ headingDeg: 359, pitchDeg: 0, rollDeg: 0 }, 0)
  near(t.step({ headingDeg: 1, pitchDeg: 0, rollDeg: 0 }, 1).headingDeg, (359 + 2 * (1 - Math.exp(-1))) % 360, 1e-9) // ≈ 0.26
})

test('smoother: dt ≤ 0 holds the current attitude; returned objects are copies', () => {
  const s = new AttitudeSmoother(1)
  const first = s.step({ headingDeg: 10, pitchDeg: 1, rollDeg: 2 }, 0)
  first.pitchDeg = 99
  assert.deepEqual(s.step({ headingDeg: 50, pitchDeg: 5, rollDeg: 9 }, 0), { headingDeg: 10, pitchDeg: 1, rollDeg: 2 })
})

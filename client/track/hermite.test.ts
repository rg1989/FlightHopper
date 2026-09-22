// client/track/hermite.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RejoinBlend, extrapolate, hermite } from './hermite.ts'
import type { KinPoint } from './types.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)
const rad = (d: number): number => (d * Math.PI) / 180

/** True constant-turn arc: speed v m/s, initial track psi0Deg, turn rate wDegS (+ = right), starting at the origin at t = 0. */
function arc(v: number, psi0Deg: number, wDegS: number) {
  const w = rad(wDegS)
  const psi0 = rad(psi0Deg)
  const r = v / w
  return (t: number): KinPoint => {
    const psi = psi0 + w * t
    return { t, e: r * (Math.cos(psi0) - Math.cos(psi)), n: r * (Math.sin(psi) - Math.sin(psi0)), ve: v * Math.sin(psi), vn: v * Math.cos(psi) }
  }
}

/** Max position error of hermite (and of the straight chord) against the true arc, sampled every stepS over nSeg segments. */
function arcErrors(stepS: number, nSeg: number): { hermiteM: number; chordM: number; hermiteVelMs: number } {
  const truth = arc(250, 30, 1.5)
  let hermiteM = 0
  let chordM = 0
  let hermiteVelMs = 0
  for (let k = 0; k < nSeg; k++) {
    const a = truth(k * stepS)
    const b = truth((k + 1) * stepS)
    for (let i = 0; i <= 100; i++) {
      const t = a.t + (i / 100) * stepS
      const x = truth(t)
      const h = hermite(a, b, t)
      const s = (t - a.t) / stepS
      hermiteM = Math.max(hermiteM, Math.hypot(h.e - x.e, h.n - x.n))
      hermiteVelMs = Math.max(hermiteVelMs, Math.hypot(h.ve - x.ve, h.vn - x.vn))
      chordM = Math.max(chordM, Math.hypot(a.e + s * (b.e - a.e) - x.e, a.n + s * (b.n - a.n) - x.n))
    }
  }
  return { hermiteM, chordM, hermiteVelMs }
}

test('hermite: endpoints and endpoint velocities are exact', () => {
  const a: KinPoint = { t: 10, e: 123.4, n: -56.7, ve: 180.3, vn: -91.2 }
  const b: KinPoint = { t: 13, e: 650.1, n: -330.9, ve: 170.8, vn: -99.9 }
  assert.deepEqual(hermite(a, b, a.t), { e: a.e, n: a.n, ve: a.ve, vn: a.vn })
  assert.deepEqual(hermite(a, b, b.t), { e: b.e, n: b.n, ve: b.ve, vn: b.vn })
})

test('hermite: t is clamped to [a.t, b.t]', () => {
  const a: KinPoint = { t: 0, e: 0, n: 0, ve: 100, vn: 0 }
  const b: KinPoint = { t: 2, e: 200, n: 10, ve: 100, vn: 10 }
  assert.deepEqual(hermite(a, b, -5), hermite(a, b, 0))
  assert.deepEqual(hermite(a, b, 99), hermite(a, b, 2))
})

test('hermite: a degenerate segment (b.t <= a.t) returns b', () => {
  const a: KinPoint = { t: 5, e: 1, n: 2, ve: 3, vn: 4 }
  const b: KinPoint = { t: 5, e: 5, n: 6, ve: 7, vn: 8 }
  assert.deepEqual(hermite(a, b, 5), { e: 5, n: 6, ve: 7, vn: 8 })
})

test('hermite: a straight constant-velocity line is reproduced exactly', () => {
  const ve = 212.5
  const vn = -143.25
  const a: KinPoint = { t: 100, e: 1000, n: -2000, ve, vn }
  const b: KinPoint = { t: 104.5, e: 1000 + ve * 4.5, n: -2000 + vn * 4.5, ve, vn }
  for (let i = 0; i <= 45; i++) {
    const t = 100 + i * 0.1
    const p = hermite(a, b, t)
    near(p.e, 1000 + ve * (t - 100), 1e-9, `e at ${t}`)
    near(p.n, -2000 + vn * (t - 100), 1e-9, `n at ${t}`)
    near(p.ve, ve, 1e-9, `ve at ${t}`)
    near(p.vn, vn, 1e-9, `vn at ${t}`)
  }
})

test('hermite: 250 m/s arc turning 1.5°/s, sampled every 3 s, stays within 1 m of the true arc; chord error is far larger', (t) => {
  const three = arcErrors(3, 20)
  const five = arcErrors(5, 12)
  t.diagnostic(`3 s: hermite max ${three.hermiteM.toExponential(2)} m, vel ${three.hermiteVelMs.toExponential(2)} m/s, chord max ${three.chordM.toFixed(2)} m`)
  t.diagnostic(`5 s: hermite max ${five.hermiteM.toExponential(2)} m, vel ${five.hermiteVelMs.toExponential(2)} m/s, chord max ${five.chordM.toFixed(2)} m`)
  assert.ok(three.hermiteM < 1, `3 s hermite ${three.hermiteM} m`)
  assert.ok(five.hermiteM < 1, `5 s hermite ${five.hermiteM} m`)
  assert.ok(three.hermiteVelMs < 0.01, `3 s hermite velocity ${three.hermiteVelMs} m/s`)
  assert.ok(three.chordM > 5, `3 s chord ${three.chordM} m`)
  assert.ok(three.chordM > 100 * three.hermiteM, 'chord error should dwarf hermite error at 3 s')
  assert.ok(five.chordM > 100 * five.hermiteM, 'chord error should dwarf hermite error at 5 s')
})

test('extrapolate: zero turn rate is a straight line at constant velocity', () => {
  const last: KinPoint = { t: 50, e: 10, n: 20, ve: 150, vn: -80 }
  assert.deepEqual(extrapolate(last, 0, 0), { e: 10, n: 20, ve: 150, vn: -80 })
  const p = extrapolate(last, 0, 4)
  near(p.e, 10 + 150 * 4, 1e-9)
  near(p.n, 20 - 80 * 4, 1e-9)
  assert.equal(p.ve, 150)
  assert.equal(p.vn, -80)
})

test('extrapolate: constant speed and turn rate follow the exact arc', () => {
  const truth = arc(250, 30, 1.5)
  const last = truth(0)
  for (const dt of [0.5, 1, 3, 8, 20]) {
    const p = extrapolate(last, 1.5, dt)
    const x = truth(dt)
    near(p.e, x.e, 1e-6, `e at ${dt}`)
    near(p.n, x.n, 1e-6, `n at ${dt}`)
    near(p.ve, x.ve, 1e-9, `ve at ${dt}`)
    near(p.vn, x.vn, 1e-9, `vn at ${dt}`)
    near(Math.hypot(p.ve, p.vn), 250, 1e-9, `speed at ${dt}`)
  }
})

test('extrapolate: a full 360° turn returns to the start', () => {
  const last: KinPoint = { t: 0, e: 500, n: -300, ve: 0, vn: 200 }
  const p = extrapolate(last, 3, 120)
  near(p.e, 500, 1e-6)
  near(p.n, -300, 1e-6)
  near(p.ve, 0, 1e-9)
  near(p.vn, 200, 1e-9)
})

test('extrapolate: positive turn rate turns right (clockwise), negative turns left', () => {
  const north: KinPoint = { t: 0, e: 0, n: 0, ve: 0, vn: 200 }
  const right = extrapolate(north, 3, 5)
  const left = extrapolate(north, -3, 5)
  assert.ok(right.e > 0 && right.ve > 0, `right: e=${right.e} ve=${right.ve}`)
  assert.ok(left.e < 0 && left.ve < 0, `left: e=${left.e} ve=${left.ve}`)
  near(right.n, left.n, 1e-9)
  near(right.e, -left.e, 1e-9)
})

test('RejoinBlend: offset is 0 before start, the full error at start, and exactly 0 after durationS', () => {
  const b = new RejoinBlend()
  assert.deepEqual(b.offset(0), { e: 0, n: 0 })
  b.start(40, -30, 100)
  assert.deepEqual(b.offset(99.9), { e: 0, n: 0 })
  assert.deepEqual(b.offset(100), { e: 40, n: -30 })
  assert.deepEqual(b.offset(101.5), { e: 0, n: 0 })
  assert.deepEqual(b.offset(250), { e: 0, n: 0 })
})

test('RejoinBlend: cosine decay — half at mid-time, monotone, flat at both ends', () => {
  const b = new RejoinBlend(2)
  b.start(100, 0, 10)
  near(b.offset(11).e, 50, 1e-9)
  let prev = Infinity
  for (let i = 0; i <= 200; i++) {
    const e = b.offset(10 + i * 0.01).e
    assert.ok(e <= prev, `not monotone at step ${i}`)
    prev = e
  }
  // Flat ends: the first and last 1/60 s frames move the offset by far less than a mid-blend frame does.
  const firstStep = b.offset(10).e - b.offset(10 + 1 / 60).e
  const midStep = b.offset(11).e - b.offset(11 + 1 / 60).e
  const lastStep = b.offset(12 - 1 / 60).e - b.offset(12).e
  assert.ok(firstStep < midStep / 50, `first ${firstStep} mid ${midStep}`)
  assert.ok(lastStep < midStep / 50, `last ${lastStep} mid ${midStep}`)
})

test('RejoinBlend: a new start replaces the previous blend', () => {
  const b = new RejoinBlend()
  b.start(10, 10, 0)
  b.start(-4, 2, 1)
  assert.deepEqual(b.offset(1), { e: -4, n: 2 })
  assert.deepEqual(b.offset(0.5), { e: 0, n: 0 })
  assert.deepEqual(b.offset(2.5), { e: 0, n: 0 })
})

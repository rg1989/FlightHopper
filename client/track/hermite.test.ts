// client/track/hermite.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RejoinBlend, extrapolate } from './hermite.ts'
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


// client/scene/chaseCamera.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chaseOffsetEnu } from './chaseCamera.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)
const DEG = 180 / Math.PI

test('chaseOffsetEnu: heading 0 → camera due south of the target, above it when looking down', () => {
  const [e, n, u] = chaseOffsetEnu(0, -12, 150)
  near(e, 0, 1e-9)
  assert.ok(n < 0)
  assert.ok(u > 0)
  near(Math.hypot(e, n, u), 150, 1e-9)
  near(u, 150 * Math.sin(12 / DEG), 1e-9)
})

test('chaseOffsetEnu: heading 90 → west; heading 225 → north-east', () => {
  const [e, n] = chaseOffsetEnu(90, -12, 150)
  assert.ok(e < 0)
  near(n, 0, 1e-9)
  const [e2, n2, u2] = chaseOffsetEnu(225, -30, 100)
  assert.ok(e2 > 0 && n2 > 0)
  near(e2, n2, 1e-9)
  near(u2, 50, 1e-9)
})

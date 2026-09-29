// client/scene/trackpad.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pinchRatio, wheelKind } from './trackpad.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)
const wheel = (o: Partial<{ ctrlKey: boolean; deltaMode: number; deltaX: number; deltaY: number }>) =>
  ({ ctrlKey: false, deltaMode: 0, deltaX: 0, deltaY: 0, ...o })

test('wheelKind: a trackpad pinch (Chrome, Edge and Firefox send it as a wheel with ctrlKey) is a pinch', () => {
  assert.equal(wheelKind(wheel({ ctrlKey: true, deltaY: -3.2 })), 'pinch')
  assert.equal(wheelKind(wheel({ ctrlKey: true, deltaY: 4.000244140625 })), 'pinch')
})

test('wheelKind: a mouse wheel\'s notches (whole multiples of 4.000244140625 px on macOS; lines in Firefox) stay a wheel', () => {
  for (const deltaY of [4.000244140625, -4.000244140625, 12.000732421875, -40.00244140625]) {
    assert.equal(wheelKind(wheel({ deltaY })), 'wheel', `${deltaY}`)
  }
  assert.equal(wheelKind(wheel({ deltaMode: 1, deltaY: 3 })), 'wheel')
})

test('wheelKind: fingers moving on a trackpad (other pixel deltas, or any sideways part) are a scroll', () => {
  for (const [deltaX, deltaY] of [[0, 1], [0, -7.5], [3, 0], [-2, 5], [4.000244140625, 4.000244140625], [0, 100]]) {
    assert.equal(wheelKind(wheel({ deltaX, deltaY })), 'scroll', `${deltaX}, ${deltaY}`)
  }
})

test('pinchRatio: the fingers\' spread as Chromium encodes it (deltaY = −100·ln scale): spreading them zooms in', () => {
  near(pinchRatio(wheel({ ctrlKey: true, deltaY: -100 * Math.log(2) })), 2, 1e-12)
  near(pinchRatio(wheel({ ctrlKey: true, deltaY: 100 * Math.log(2) })), 0.5, 1e-12)
  assert.equal(pinchRatio(wheel({ ctrlKey: true, deltaY: 0 })), 1)
})

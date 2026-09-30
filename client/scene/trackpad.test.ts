// client/scene/trackpad.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pinchRatio, wheelKind } from './trackpad.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)
const wheel = (o: Partial<{ ctrlKey: boolean; deltaMode: number; deltaX: number; deltaY: number; wheelDeltaY: number }>) =>
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

test('wheelKind: a mouse wheel at another page zoom (macOS: the notch divided by the zoom) stays a wheel', () => {
  for (const z of [0.5, 2 / 3, 0.8, 0.9, 1.1, 1.25, 1.5, 2]) {
    for (const k of [1, -1, 3]) assert.equal(wheelKind(wheel({ deltaY: (k * 4.000244140625) / z })), 'wheel', `${z} ${k}`)
  }
})

test('wheelKind: a mouse wheel on Windows or Linux (a notch is 120 in wheelDeltaY, deltaY 100 or 120 times the display scale) stays a wheel', () => {
  for (const [deltaY, wheelDeltaY] of [[100, -120], [-100, 120], [125, -120], [150, -120], [120, -120], [53, -120], [300, -360]]) {
    assert.equal(wheelKind(wheel({ deltaY, wheelDeltaY })), 'wheel', `${deltaY}, ${wheelDeltaY}`)
  }
})

test('wheelKind: a trackpad (wheelDeltaY −3 × deltaY; whole pixels, at any zoom) is a scroll, even where 120 divides it', () => {
  for (const [deltaY, wheelDeltaY] of [[40, -120], [-80, 240], [4, -12], [7.5, -22], [4 / 1.1, -12], [8 / 1.25, -24]]) {
    assert.equal(wheelKind(wheel({ deltaY, wheelDeltaY })), 'scroll', `${deltaY}, ${wheelDeltaY}`)
  }
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

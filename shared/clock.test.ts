import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MinOffset } from './clock.ts'

test('offset is the minimum of recv − remote over the window', () => {
  const o = new MinOffset(60_000)
  o.update(10_150, 10_000)  // 150
  o.update(11_120, 11_000)  // 120
  o.update(12_300, 12_000)  // 300
  assert.equal(o.get(), 120)
})

test('old minima age out of the window', () => {
  const o = new MinOffset(1_000)
  o.update(10_050, 10_000)  // 50
  o.update(12_200, 12_000)  // 200, first is now 2150 ms old
  assert.equal(o.get(), 200)
})

test('get before any update throws; ready tells', () => {
  const o = new MinOffset(1000)
  assert.equal(o.ready, false)
  assert.throws(() => o.get())
  o.update(1, 0)
  assert.equal(o.ready, true)
})

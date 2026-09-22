import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextInterval } from './record-cells.ts'

test('401/403 stop for good', () => {
  assert.equal(nextInterval(2000, 2000, 403, null), 'stop')
  assert.equal(nextInterval(2000, 2000, 401, null), 'stop')
})

test('429 doubles and honours Retry-After (default 30 s)', () => {
  assert.equal(nextInterval(2000, 2000, 429, null), 30_000)
  assert.equal(nextInterval(40_000, 2000, 429, 5), 80_000)
  assert.equal(nextInterval(2000, 2000, 429, 120), 120_000)
})

test('5xx / network error doubles, capped at 5 min', () => {
  assert.equal(nextInterval(2000, 2000, 503, null), 4000)
  assert.equal(nextInterval(200_000, 2000, 0, null), 300_000)
})

test('success recovers toward base, never below 1 s', () => {
  assert.equal(nextInterval(10_000, 2000, 200, null), 9000)
  assert.equal(nextInterval(2000, 2000, 200, null), 2000)
  assert.equal(nextInterval(1000, 500, 200, null), 1000)
})

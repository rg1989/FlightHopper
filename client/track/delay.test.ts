// client/track/delay.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { delayFloorS, p90, targetDelayS } from './delay.ts'

test('delay floor per quality: adsb2 3 s, adsb01 4 s, mlat 6 s, other 6 s', () => {
  assert.equal(delayFloorS('adsb2'), 3)
  assert.equal(delayFloorS('adsb01'), 4)
  assert.equal(delayFloorS('mlat'), 6)
  assert.equal(delayFloorS('other'), 6)
})

test('target = floor when polls are fast and gaps are small', () => {
  assert.equal(targetDelayS('adsb2', 1, 1), 3)
  assert.equal(targetDelayS('adsb01', 1, 1), 4)
  assert.equal(targetDelayS('mlat', 1, 2), 6)
})

test('poll-period term: poll + 1 s wins when it exceeds the floor', () => {
  assert.equal(targetDelayS('adsb2', 3, 0), 4)
  assert.equal(targetDelayS('adsb01', 5, 0), 6)
})

test('gap term: p90 gap + 1 s wins when it exceeds floor and poll term', () => {
  assert.equal(targetDelayS('adsb2', 1, 4.5), 5.5)
  assert.equal(targetDelayS('mlat', 1, 6.5), 7.5)
})

test('clamped to [3, 10] s', () => {
  assert.equal(targetDelayS('adsb2', 1, 30), 10)
  assert.equal(targetDelayS('mlat', 20, 0), 10)
  assert.equal(targetDelayS('adsb2', -5, -5), 3)
})

test('a NaN term is ignored rather than poisoning the clock', () => {
  assert.equal(targetDelayS('adsb2', Number.NaN, 4), 5)
  assert.equal(targetDelayS('adsb01', 1, Number.NaN), 4)
})

test('p90 is nearest-rank: the ceil(0.9·n)-th smallest observed value', () => {
  assert.equal(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9)
  assert.equal(p90([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]), 9)
  assert.equal(p90(Array.from({ length: 20 }, (_, i) => i + 1)), 18)
  assert.equal(p90([1, 1, 1, 1, 30]), 30)  // n = 5 → rank 5: one long gap in few samples counts
  assert.equal(p90([2.5]), 2.5)
})

test('p90 of nothing is 0 (no gap term); non-finite values are skipped; input is not mutated', () => {
  assert.equal(p90([]), 0)
  assert.equal(p90([Number.NaN, 2, 1]), 2)
  const xs = [3, 1, 2]
  p90(xs)
  assert.deepEqual(xs, [3, 1, 2])
})

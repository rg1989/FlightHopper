// client/scenario/clock.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RATES, ScenarioClock } from './clock.ts'

test('tick advances t by dt·rate while playing', () => {
  const c = new ScenarioClock(0, 100)
  c.play()
  c.tick(2)
  assert.equal(c.t, 2)
  c.setRate(4)
  c.tick(2)
  assert.equal(c.t, 10) // 2 + 2·4
})

test('tick does nothing while paused', () => {
  const c = new ScenarioClock(0, 100)
  c.tick(5)
  assert.equal(c.t, 0)
  assert.equal(c.playing, false)
})

test('tick clamps to stop and stops playback there', () => {
  const c = new ScenarioClock(0, 10)
  c.play()
  c.tick(15)
  assert.equal(c.t, 10)
  assert.equal(c.playing, false)
  // a further tick (still not playing) does not move t past stop
  c.tick(1)
  assert.equal(c.t, 10)
})

test('play at stop restarts from start', () => {
  const c = new ScenarioClock(5, 10)
  c.seek(10)
  c.play()
  assert.equal(c.t, 5)
  assert.equal(c.playing, true)
})

test('play before stop keeps the current t', () => {
  const c = new ScenarioClock(0, 10, 3)
  c.play()
  assert.equal(c.t, 3)
  assert.equal(c.playing, true)
})

test('seek clamps to [start, stop] and keeps playing state', () => {
  const c = new ScenarioClock(5, 20)
  c.seek(-100)
  assert.equal(c.t, 5)
  c.seek(1000)
  assert.equal(c.t, 20)
  assert.equal(c.playing, false)

  c.play()
  c.seek(12)
  assert.equal(c.t, 12)
  assert.equal(c.playing, true) // seeking never changes playing
})

test('pause stops tick from advancing t', () => {
  const c = new ScenarioClock(0, 10)
  c.play()
  c.tick(1)
  c.pause()
  assert.equal(c.playing, false)
  c.tick(5)
  assert.equal(c.t, 1)
})

test('setRate accepts a RATES member', () => {
  const c = new ScenarioClock(0, 10)
  c.setRate(8)
  assert.equal(c.rate, 8)
})

test('setRate rejects a value not in RATES', () => {
  const c = new ScenarioClock(0, 10)
  assert.throws(() => c.setRate(3))
  assert.equal(c.rate, 1) // rejected: unchanged
})

test('nextRate cycles 1→2→4→8→16→1', () => {
  const c = new ScenarioClock(0, 10)
  assert.equal(c.rate, 1)
  const seen: number[] = [c.rate]
  for (let i = 0; i < RATES.length; i++) seen.push(c.nextRate())
  assert.deepEqual(seen, [1, 2, 4, 8, 16, 1])
})

// client/history/clock.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HistoryClock, RATES } from './clock.ts'

const T = Date.UTC(2026, 8, 30, 4, 0) // the replay time a clock starts at
const MIN = T - 3_600_000
const MAX = T + 3_600_000
// perfMs of the constructor is 0 unless a test says otherwise: tests drive the clock with plain numbers.
const clock = (o: { playing?: boolean; rate?: number } = {}, t = T, perfMs = 0): HistoryClock =>
  new HistoryClock(t, { minMs: MIN, maxMs: MAX, ...o }, perfMs)

test('the rates are 1x, 10x and 60x', () => {
  assert.deepEqual([...RATES], [1, 10, 60])
})

test('a new clock is paused at 1x and shows the time it was given', () => {
  const c = clock()
  assert.equal(c.playing, false)
  assert.equal(c.rate, 1)
  assert.equal(c.maxMs, MAX)
  assert.equal(c.now(0), T)
  assert.equal(c.now(60_000), T) // paused: the wall clock does not move it
})

test('playing at 10x for 2 s moves 20 s', () => {
  const c = clock({ playing: true, rate: 10 }, T, 1000)
  assert.equal(c.now(1000), T)
  assert.equal(c.now(3000), T + 20_000)
})

test('pause freezes the time; play goes on from where it stopped, not from where the wall clock went', () => {
  const c = clock({ playing: true, rate: 10 })
  c.pause(2000) // 20 s of replay in
  assert.equal(c.playing, false)
  assert.equal(c.now(2000), T + 20_000)
  assert.equal(c.now(9000), T + 20_000)
  c.play(9000)
  assert.equal(c.playing, true)
  assert.equal(c.now(9000), T + 20_000)
  assert.equal(c.now(10_000), T + 30_000)
})

test('play and pause on a clock already in that state change nothing', () => {
  const c = clock({ playing: true })
  c.play(5000)
  assert.equal(c.now(6000), T + 6000, 'play while playing must not restart the count')
  const p = clock()
  p.pause(5000)
  assert.equal(p.now(6000), T)
})

test('toggle pauses a playing clock and plays a paused one', () => {
  const c = clock({ playing: true })
  c.toggle(1000)
  assert.equal(c.playing, false)
  assert.equal(c.now(5000), T + 1000)
  c.toggle(5000)
  assert.equal(c.playing, true)
  assert.equal(c.now(6000), T + 2000)
})

test('seek clamps to the bounds and keeps playing', () => {
  const c = clock({ playing: true, rate: 10 })
  c.seek(MAX + 99_999, 1000)
  assert.equal(c.now(1000), MAX)
  assert.equal(c.playing, true)
  c.seek(MIN - 99_999, 1000)
  assert.equal(c.now(1000), MIN)
  c.seek(T + 5000, 2000)
  assert.equal(c.now(2000), T + 5000)
  assert.equal(c.now(3000), T + 5000 + 10_000, 'it runs on from the new time at the same rate')
  assert.equal(c.playing, true)
})

test('seek on a paused clock moves the time and stays paused', () => {
  const c = clock()
  c.seek(T + 90_000, 1000)
  assert.equal(c.playing, false)
  assert.equal(c.now(1000), T + 90_000)
  assert.equal(c.now(50_000), T + 90_000)
})

test('nextRate cycles 1, 10, 60, 1 and the time does not jump', () => {
  const c = clock({ playing: true })
  assert.equal(c.now(1000), T + 1000)
  assert.equal(c.nextRate(1000), 10)
  assert.equal(c.rate, 10)
  assert.equal(c.now(1000), T + 1000, 'the same instant shows the same time')
  assert.equal(c.now(2000), T + 1000 + 10_000)
  assert.equal(c.nextRate(2000), 60)
  assert.equal(c.now(2000), T + 11_000)
  assert.equal(c.now(3000), T + 11_000 + 60_000)
  assert.equal(c.nextRate(3000), 1) // wraps
  assert.equal(c.now(3000), T + 71_000)
  assert.equal(c.now(4000), T + 72_000)
})

test('nextRate on a paused clock changes the rate only', () => {
  const c = clock()
  assert.equal(c.nextRate(1000), 10)
  assert.equal(c.playing, false)
  assert.equal(c.now(9000), T)
  c.play(9000)
  assert.equal(c.now(10_000), T + 10_000)
})

test('a rate that is not one of RATES goes to the next larger one, and past the largest to the first', () => {
  const c = clock({ rate: 5 })
  assert.equal(c.now(0), T)
  assert.equal(c.nextRate(0), 10)
  const d = clock({ rate: 100 })
  assert.equal(d.nextRate(0), 1)
})

test('the time stops at maxMs, and a clock playing there is at the end', () => {
  const c = clock({ playing: true, rate: 60 }, MAX - 60_000)
  assert.equal(c.atEnd(0), false)
  assert.equal(c.now(1000), MAX) // 1 s × 60 = the last minute
  assert.equal(c.atEnd(1000), true)
  assert.equal(c.now(5000), MAX, 'it waits there')
  assert.equal(c.atEnd(5000), true)
  c.pause(5000)
  assert.equal(c.now(5000), MAX)
  assert.equal(c.atEnd(5000), false, 'paused at the end is not playing at the end')
})

test('setBounds extends maxMs: a clock that waited at the end goes on from the old end', () => {
  const c = clock({ playing: true, rate: 10 }, MAX - 10_000)
  assert.equal(c.atEnd(5000), true) // reached the end after 1 s and waited
  c.setBounds(MIN, MAX + 1_800_000, 5000)
  assert.equal(c.maxMs, MAX + 1_800_000)
  assert.equal(c.atEnd(5000), false)
  assert.equal(c.now(5000), MAX, 'no jump to where the wall clock would have taken it')
  assert.equal(c.now(6000), MAX + 10_000)
})

test('setBounds pulls the time inside smaller bounds, at either end', () => {
  const c = clock()
  c.setBounds(T + 1000, T + 9000, 0)
  assert.equal(c.now(0), T + 1000)
  c.seek(T + 5000, 0)
  c.setBounds(MIN, T + 2000, 0)
  assert.equal(c.now(0), T + 2000)
  assert.equal(c.maxMs, T + 2000)
})

test('a start before minMs begins at minMs', () => {
  const c = clock({}, MIN - 5000)
  assert.equal(c.now(0), MIN)
})

test('a perfMs earlier than the last change does not run the clock backwards', () => {
  // A frame timestamp can be a few ms older than the performance.now() of a click handled just before it.
  const c = clock({ playing: true, rate: 60 })
  c.seek(T + 1000, 5000)
  assert.equal(c.now(4990), T + 1000)
  assert.equal(c.now(5010), T + 1000 + 600)
})

test('a time that is not a number goes to minMs and never poisons the clock', () => {
  const c = clock({ playing: true })
  c.seek(NaN, 0)
  assert.equal(c.now(1000), MIN + 1000)
  const d = new HistoryClock(NaN, { minMs: MIN, maxMs: MAX }, 0)
  assert.equal(d.now(0), MIN)
})

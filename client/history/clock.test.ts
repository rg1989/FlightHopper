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

test('a start before minMs waits as asked: bounds short of it leave the time; the first that reach it take the clock there, once', () => {
  const c = clock({}, MIN - 5000) // a ?hist= link older than the 30 days guessed until the server's status
  assert.deepEqual([c.now(0), c.asked], [MIN, MIN - 5000])
  assert.equal(c.setBounds(MIN - 1000, MAX, 1000), false, 'still short of it (a server just started reports its own guess)')
  assert.deepEqual([c.now(1000), c.asked], [MIN, MIN - 5000], 'the time stays where it is, the start still asked')
  assert.equal(c.setBounds(MIN - 10_000, MAX, 2000), true, 'the oldest day found: a jump')
  assert.deepEqual([c.now(2000), c.asked, c.playing], [MIN - 5000, null, false])
  assert.equal(c.setBounds(MIN - 20_000, MAX, 3000), false, 'taken once: later bounds leave the time')
  assert.equal(c.now(3000), MIN - 5000)
})

test('a start asked for: a seek before the bounds reach it wins; a playing clock plays on meanwhile and is taken there still playing', () => {
  const c = clock({ playing: true, rate: 10 }, MIN - 5000)
  c.seek(T, 1000)
  assert.equal(c.asked, null)
  assert.equal(c.setBounds(MIN - 10_000, MAX, 2000), false)
  assert.equal(c.now(2000), T + 10_000, 'the seek stands')
  const d = clock({ playing: true, rate: 10 }, MIN - 5000)
  assert.equal(d.now(1000), MIN + 10_000, 'played on from minMs')
  assert.equal(d.setBounds(MIN - 5000, MAX, 2000), true)
  assert.deepEqual([d.now(2000), d.now(3000), d.playing], [MIN - 5000, MIN + 5000, true])
})

test('a start inside the bounds, past maxMs or not a number asks for nothing', () => {
  assert.equal(clock().asked, null)
  assert.equal(clock({}, MAX + 5000).asked, null, 'the newest end is known from the start: past it is not there yet')
  assert.equal(clock({}, NaN).asked, null)
  const c = clock({}, MAX + 5000)
  assert.equal(c.setBounds(MIN, MAX + 10_000, 0), false)
  assert.equal(c.now(0), MAX, 'a longer clock does not move it')
})

test('a perfMs earlier than the last change does not run the clock backwards', () => {
  // A frame timestamp can be a few ms older than the performance.now() of a click handled just before it.
  const c = clock({ playing: true, rate: 60 })
  c.seek(T + 1000, 5000)
  assert.equal(c.now(4990), T + 1000)
  assert.equal(c.now(5010), T + 1000 + 600)
})

test('a call stamped before the last change counts the overlap once: nothing moves the base back', () => {
  // The last change is at 5000. Each call below is stamped 4990, 10 ms older (a frame timestamp against a click's
  // performance.now()); 10 ms after the change, at 5010, the clock must be 10 ms × 10 on from where the call left it.
  const cases: [string, { playing: boolean; rate: number }, (c: HistoryClock) => void, number][] = [
    ['seek', { playing: true, rate: 10 }, (c) => c.seek(T + 60_000, 4990), T + 60_000],
    ['setBounds', { playing: true, rate: 10 }, (c) => c.setBounds(MIN, MAX + 1000, 4990), T],
    ['nextRate (1x to 10x)', { playing: true, rate: 1 }, (c) => assert.equal(c.nextRate(4990), 10), T],
    ['pause then play', { playing: true, rate: 10 }, (c) => { c.pause(4990); c.play(4990) }, T],
    ['play', { playing: false, rate: 10 }, (c) => c.play(4990), T],
    ['toggle', { playing: false, rate: 10 }, (c) => c.toggle(4990), T],
  ]
  for (const [name, start, call, from] of cases) {
    const c = clock(start)
    c.seek(T, 5000)
    call(c)
    assert.equal(c.now(5000), from, `${name}: at the change`)
    assert.equal(c.now(5010), from + 100, `${name}: 10 ms later, at 10x`)
  }
})

test('stalled, a playing clock holds its time and stays playing; un-stalled it goes on from that time, no jump', () => {
  const c = clock({ playing: true, rate: 10 })
  assert.equal(c.stalled, false)
  assert.equal(c.now(1000), T + 10_000)
  c.stall(true, 1000)
  assert.equal(c.stalled, true)
  assert.equal(c.playing, true, 'waiting, not paused')
  assert.equal(c.now(1000), T + 10_000)
  assert.equal(c.now(9000), T + 10_000, 'the wall clock does not move it')
  c.stall(false, 9000)
  assert.equal(c.stalled, false)
  assert.equal(c.now(9000), T + 10_000, 'no jump over the wait')
  assert.equal(c.now(10_000), T + 20_000, 'it runs on at the same rate')
})

test('stalling a stalled clock, or un-stalling a running one, changes nothing', () => {
  const c = clock({ playing: true, rate: 10 })
  c.stall(false, 500)
  assert.equal(c.now(1000), T + 10_000, 'not stalled: nothing was held')
  c.stall(true, 1000)
  c.stall(true, 5000)
  assert.equal(c.now(5000), T + 10_000, 'held from the first stall, not the second')
  c.stall(false, 6000)
  c.stall(false, 9000)
  assert.equal(c.now(7000), T + 20_000, 'it runs from the first un-stall (6000), not the second')
})

test('a seek while stalled moves the held time (inside the bounds); un-stalled it runs on from there', () => {
  const c = clock({ playing: true, rate: 10 })
  c.stall(true, 1000)
  c.seek(T + 600_000, 2000)
  assert.equal(c.now(3000), T + 600_000, 'held at the new time')
  assert.equal(c.playing, true)
  c.seek(MAX + 99_999, 3000)
  assert.equal(c.now(3000), MAX, 'clamped as ever')
  c.seek(T + 600_000, 3500)
  c.stall(false, 4000)
  assert.equal(c.now(4000), T + 600_000, 'no jump')
  assert.equal(c.now(5000), T + 610_000)
})

test('a rate change while stalled keeps the held time; the new rate runs from the un-stall', () => {
  const c = clock({ playing: true, rate: 10 })
  c.stall(true, 1000)
  assert.equal(c.nextRate(2000), 60)
  assert.equal(c.now(3000), T + 10_000)
  c.stall(false, 4000)
  assert.equal(c.now(5000), T + 10_000 + 60_000)
})

test('pause and play while stalled work: a paused clock holds anyway, a played one waits for the stall to end', () => {
  const c = clock({ playing: true, rate: 10 })
  c.stall(true, 1000)
  c.pause(2000)
  assert.deepEqual([c.playing, c.stalled], [false, true])
  assert.equal(c.now(9000), T + 10_000)
  c.stall(false, 9000)
  assert.equal(c.now(12_000), T + 10_000, 'paused: the end of the stall moves nothing')
  c.stall(true, 12_000)
  c.play(13_000) // played while waiting for data: playing, and still holding
  assert.deepEqual([c.playing, c.stalled], [true, true])
  assert.equal(c.now(20_000), T + 10_000)
  c.stall(false, 20_000)
  assert.equal(c.now(21_000), T + 20_000, 'it runs on once the data is there')
})

test('a paused clock can be stalled: only the flag changes, and a play then waits', () => {
  const c = clock()
  c.stall(true, 0)
  assert.deepEqual([c.playing, c.stalled, c.now(5000)], [false, true, T])
  c.play(1000)
  assert.equal(c.now(5000), T, 'playing, held')
  c.stall(false, 5000)
  assert.equal(c.now(6000), T + 1000)
})

test('bounds hold while stalled: new bounds pull the held time inside them, and a clock held at the end is at the end', () => {
  const c = clock({ playing: true, rate: 60 }, MAX - 120_000)
  assert.equal(c.now(1000), MAX - 60_000)
  c.stall(true, 1000)
  c.setBounds(MIN, MAX - 90_000, 2000)
  assert.equal(c.now(2000), MAX - 90_000)
  assert.equal(c.atEnd(2000), true, 'held at the end of the new bounds')
  c.setBounds(MIN, MAX, 3000)
  assert.equal(c.now(3000), MAX - 90_000, 'a longer clock does not move it by itself')
  assert.equal(c.atEnd(3000), false)
})

test('a stall stamped before the last change counts nothing twice and never moves the base back', () => {
  const c = clock({ playing: true, rate: 10 })
  c.seek(T, 5000)
  c.stall(true, 4990) // a frame timestamp 10 ms behind the click's performance.now()
  assert.equal(c.now(5000), T)
  assert.equal(c.now(9000), T)
  c.stall(false, 4990)
  assert.equal(c.now(5000), T)
  assert.equal(c.now(5010), T + 100, 'the 10 ms are counted once, at 10x')
})

test('a stall stamped with a perfMs that is not a number holds the time as of the last change', () => {
  const c = clock({ playing: true, rate: 10 })
  c.stall(true, NaN)
  assert.deepEqual([c.stalled, c.now(1000)], [true, T])
  c.stall(false, NaN)
  assert.equal(c.now(1000), T + 10_000, 'as if stamped at the last change, like every other call')
})

test('a perfMs that is not a number moves nothing and cannot stall the clock', () => {
  const c = clock({ playing: true, rate: 10 })
  c.setBounds(MIN, MAX, NaN)
  assert.equal(c.now(1000), T + 10_000, 'it runs on as if the call had been stamped at the last change')
  c.seek(T + 5000, NaN)
  assert.equal(c.now(2000), T + 5000 + 20_000)
})

test('a time that is not a number goes to minMs and never poisons the clock', () => {
  const c = clock({ playing: true })
  c.seek(NaN, 0)
  assert.equal(c.now(1000), MIN + 1000)
  const d = new HistoryClock(NaN, { minMs: MIN, maxMs: MAX }, 0)
  assert.equal(d.now(0), MIN)
})

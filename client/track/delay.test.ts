// client/track/delay.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { delayFloorS, p90, RenderClock, targetDelayS } from './delay.ts'

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

test('clamped to [3, 30] s', () => {
  assert.equal(targetDelayS('adsb2', 1, 24), 25) // live at 0.04 req/s: samples ~24 s apart
  assert.equal(targetDelayS('adsb2', 1, 60), 30)
  assert.equal(targetDelayS('mlat', 40, 0), 30)
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

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)

test('RenderClock at its target returns serverNowMs − delay·1000', () => {
  const c = new RenderClock(4)
  assert.equal(c.delayS, 4)
  assert.equal(c.tick(100_000, 4, 1 / 60), 96_000)
  assert.equal(c.delayS, 4)
})

test('RenderClock slews at most 0.2 s per second by default, both directions', () => {
  const up = new RenderClock(3)
  near(up.tick(50_000, 10, 1), 50_000 - 3200, 1e-9)
  near(up.delayS, 3.2, 1e-12)
  up.tick(50_000, 10, 0.5)
  near(up.delayS, 3.3, 1e-12)
  const down = new RenderClock(10)
  down.tick(50_000, 3, 2)
  near(down.delayS, 9.6, 1e-12)
})

test('RenderClock honours a custom maxSlewSPerS', () => {
  const c = new RenderClock(3, 1)
  c.tick(0, 10, 2)
  near(c.delayS, 5, 1e-12)
})

test('RenderClock over many 60 Hz ticks: slew-limited, render time keeps moving forward, converges without overshoot', () => {
  const c = new RenderClock(3)
  const dt = 1 / 60
  let server = 1_000_000
  let prevRender = c.tick(server, 10, 0)
  let prevDelay = c.delayS
  let reachedAtS: number | null = null
  for (let i = 1; i <= 60 * 40; i++) {
    server += dt * 1000
    const render = c.tick(server, 10, dt)
    const step = c.delayS - prevDelay
    assert.ok(Math.abs(step) <= 0.2 * dt + 1e-12, `tick ${i}: slew ${step / dt} s/s`)
    assert.ok(c.delayS <= 10, `overshoot ${c.delayS}`)
    const rate = (render - prevRender) / (dt * 1000)
    assert.ok(rate >= 0.8 - 1e-9 && rate <= 1.2 + 1e-9, `tick ${i}: render rate ${rate}`)
    if (reachedAtS === null && c.delayS === 10) reachedAtS = i * dt
    prevRender = render
    prevDelay = c.delayS
  }
  assert.ok(reachedAtS !== null, 'never reached the target')
  near(reachedAtS, 35, 2 * dt)  // (10 − 3) / 0.2
  assert.equal(c.delayS, 10)
  assert.equal(c.tick(server, 10, dt), server - 10_000)
})

test('RenderClock retargeted mid-slew turns around at once, still rate-limited', () => {
  const c = new RenderClock(3)
  for (let i = 0; i < 60 * 5; i++) c.tick(0, 10, 1 / 60)   // 5 s up → 4
  near(c.delayS, 4, 1e-9)
  for (let i = 0; i < 60 * 2; i++) c.tick(0, 3, 1 / 60)    // 2 s down → 3.6
  near(c.delayS, 3.6, 1e-9)
  for (let i = 0; i < 60 * 10; i++) c.tick(0, 3, 1 / 60)
  assert.equal(c.delayS, 3)
})

test('RenderClock: a long frame (tab hidden 10 s) moves the delay at most 2 s; zero, negative or NaN dt moves nothing', () => {
  const c = new RenderClock(3)
  c.tick(0, 10, 10)
  near(c.delayS, 5, 1e-12)
  for (const dt of [0, -1, Number.NaN]) {
    assert.equal(c.tick(20_000, 3, dt), 20_000 - c.delayS * 1000)
    near(c.delayS, 5, 1e-12)
  }
})

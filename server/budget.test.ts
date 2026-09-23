// server/budget.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TokenBucket } from './budget.ts'

/** A bucket on a fake clock: tests move time by assigning c.t (ms). */
function setup(maxRps: number, random?: () => number): { b: TokenBucket; c: { t: number } } {
  const c = { t: 0 }
  return { b: new TokenBucket(maxRps, () => c.t, random), c }
}

const near = (a: number, b: number, msg = ''): void => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b} ${msg}`)

test('burst 2, then one token per 1/rps', () => {
  const { b, c } = setup(1)
  assert.equal(b.tryTake(), true)
  assert.equal(b.tryTake(), true)
  assert.equal(b.tryTake(), false)
  c.t = 999
  assert.equal(b.tryTake(), false)
  c.t = 1000
  assert.equal(b.tryTake(), true)
  assert.equal(b.tryTake(), false)
})

test('steady rate: a caller asking every 10 ms gets maxRps on average, plus at most the burst', () => {
  for (const maxRps of [1, 0.5, 5]) {
    const { b, c } = setup(maxRps)
    let n = 0
    for (c.t = 0; c.t <= 600_000; c.t += 10) if (b.tryTake()) n++
    assert.ok(n >= 600 * maxRps && n <= 600 * maxRps + 2, `maxRps ${maxRps}: ${n} takes in 600 s`)
  }
})

test('idle time never banks more than the burst', () => {
  const { b, c } = setup(1)
  c.t = 3_600_000
  assert.equal(b.tryTake(), true)
  assert.equal(b.tryTake(), true)
  assert.equal(b.tryTake(), false)
  assert.equal(b.state().tokens, 0)
})

test('every 429 halves the rate; no floor holds it at a rate that was refused', () => {
  const { b } = setup(1)
  const rates: number[] = []
  for (let i = 0; i < 4; i++) {
    b.onResult(429, null)
    rates.push(b.state().rps)
  }
  assert.deepEqual(rates, [0.5, 0.25, 0.125, 0.0625])
})

test('429 pauses for Retry-After, then allows one probe and continues at the halved rate', () => {
  const { b, c } = setup(1)
  c.t = 10_000
  b.onResult(429, 30)
  assert.equal(b.state().pausedUntilMs, 40_000)
  c.t = 39_999
  assert.equal(b.tryTake(), false)
  c.t = 40_000
  assert.equal(b.tryTake(), true)
  assert.equal(b.tryTake(), false)
  c.t = 41_999
  assert.equal(b.tryTake(), false)
  c.t = 42_000
  assert.equal(b.tryTake(), true)
})

test('429 without Retry-After pauses 5 s', () => {
  const { b, c } = setup(1)
  b.onResult(429, null)
  assert.equal(b.state().pausedUntilMs, 5000)
  c.t = 4999
  assert.equal(b.tryTake(), false)
  c.t = 5000
  assert.equal(b.tryTake(), true)
})

test('after a 429 at rate r the rate never exceeds r/2, even after hours without a 429', () => {
  const { b, c } = setup(1)
  b.onResult(429, null)
  for (const t of [60_000, 3_600_000, 10 * 3_600_000]) {
    c.t = t
    assert.ok(b.state().rps <= 0.5, `rps ${b.state().rps} at t=${t}`)
  }
  // tokens are issued at that rate too: ~0.5 × 36,000 s after the pause, plus at most the burst
  let taken = 0
  for (let t = 5000; t <= 36_005_000; t += 1000) {
    c.t = t
    if (b.tryTake()) taken++
  }
  assert.ok(taken <= 0.5 * 36_000 + 2, `taken ${taken}`)
})

test('two 429s give r/4, and it stays there', () => {
  const { b, c } = setup(1)
  b.onResult(429, null)
  c.t = 10 * 60_000
  b.onResult(429, null)
  near(b.state().rps, 0.25)
  c.t = 10 * 3_600_000
  near(b.state().rps, 0.25)
})

test('degraded is rate-limited while the last 429 is < 60 s old', () => {
  const { b, c } = setup(1)
  assert.equal(b.degraded, null)
  c.t = 1000
  b.onResult(429, 1)
  assert.equal(b.degraded, 'rate-limited')
  c.t = 60_999
  assert.equal(b.degraded, 'rate-limited')
  c.t = 61_000
  assert.equal(b.degraded, null)
})

test('401 and 403 block forever', () => {
  for (const status of [401, 403]) {
    const { b, c } = setup(1)
    b.onResult(status, null)
    assert.equal(b.degraded, 'blocked')
    assert.equal(b.tryTake(), false)
    c.t = 86_400_000
    b.onResult(200, null)
    assert.equal(b.tryTake(), false)
    assert.equal(b.state().blocked, true)
    assert.equal(b.degraded, 'blocked')
  }
})

test('5xx and network errors back off 2^k s + jitter, capped at 60 s', () => {
  const { b, c } = setup(1, () => 0.5)
  const pauses: number[] = []
  for (let i = 0; i < 7; i++) {
    b.onResult(i % 2 === 1 ? 0 : 503, null)
    pauses.push(b.state().pausedUntilMs - c.t)
    c.t = b.state().pausedUntilMs
    assert.equal(b.tryTake(), true, `probe allowed when pause ${i} ends`)
  }
  assert.deepEqual(pauses, [2500, 4500, 8500, 16_500, 32_500, 60_000, 60_000])
})

test('default jitter is within [0, 1) s', () => {
  for (let i = 0; i < 50; i++) {
    const { b } = setup(1)
    b.onResult(502, null)
    const p = b.state().pausedUntilMs
    assert.ok(p >= 2000 && p < 3000, `pause ${p}`)
  }
})

test('3 consecutive 5xx/0 → upstream-down; any other answer resets the streak and the backoff', () => {
  const { b, c } = setup(1, () => 0)
  b.onResult(500, null)
  b.onResult(0, null)
  assert.equal(b.degraded, null)
  b.onResult(504, null)
  assert.equal(b.degraded, 'upstream-down')
  c.t = 100_000
  b.onResult(200, null)
  assert.equal(b.degraded, null)
  b.onResult(503, null)
  assert.equal(b.state().pausedUntilMs, 102_000)
})

test('blocked outranks rate-limited, which outranks upstream-down', () => {
  const { b } = setup(1, () => 0)
  b.onResult(500, null)
  b.onResult(500, null)
  b.onResult(500, null)
  assert.equal(b.degraded, 'upstream-down')
  b.onResult(429, null)
  b.onResult(500, null)
  b.onResult(500, null)
  b.onResult(500, null)
  assert.equal(b.degraded, 'rate-limited')
  b.onResult(403, null)
  assert.equal(b.degraded, 'blocked')
})

test('a pause is never shortened by a later, shorter one', () => {
  const { b } = setup(1, () => 0)
  b.onResult(429, 30)
  b.onResult(503, null)
  assert.equal(b.state().pausedUntilMs, 30_000)
})

test('counts every outcome', () => {
  const { b } = setup(1, () => 0)
  for (const s of [200, 204, 429, 404, 403, 500, 503, 0]) b.onResult(s, null)
  assert.deepEqual(b.state().counts, { ok: 2, r429: 1, r4xx: 2, r5xx: 2, err: 1 })
})

test('state() reports rate, ceiling, accrued tokens and pause', () => {
  const { b, c } = setup(0.5)
  b.tryTake()
  c.t = 1000
  assert.deepEqual(b.state(), {
    rps: 0.5,
    maxRps: 0.5,
    tokens: 1.5,
    blocked: false,
    pausedUntilMs: 0,
    counts: { ok: 0, r429: 0, r4xx: 0, r5xx: 0, err: 0 },
  })
})

test('defaults to the wall clock', () => {
  const b = new TokenBucket(1)
  assert.equal(b.tryTake(), true)
  assert.equal(b.degraded, null)
})

test('a 400 or 404 backs off like a 5xx (adsb.fi restricts IPs that keep sending bad requests)', () => {
  const c = { t: 0 }
  const b = new TokenBucket(0.9, () => c.t, () => 0, 1)
  assert.equal(b.tryTake(), true)
  b.onResult(404, null)
  assert.ok(b.state().pausedUntilMs >= 2000, 'paused ≥ 2 s')
  c.t = 1500
  assert.equal(b.tryTake(), false)
  c.t = 2000
  assert.equal(b.tryTake(), true, 'one probe after the pause')
  b.onResult(400, null)
  assert.ok(b.state().pausedUntilMs - c.t >= 4000, 'the second failure waits longer')
  assert.equal(b.state().counts.r4xx, 2)
})

test('burst 1: never two requests less than 1/rps apart, even after idling', () => {
  const c = { t: 0 }
  const b = new TokenBucket(0.9, () => c.t, () => 0, 1)
  const sent: number[] = []
  for (; c.t < 60_000; c.t += 100) {
    if (b.tryTake()) {
      sent.push(c.t)
      b.onResult(200, null)
    }
    if (c.t === 20_000) c.t += 30_000 // idle: tokens must not pile up past 1
  }
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i] - sent[i - 1] >= 1100, `${sent[i - 1]} → ${sent[i]}`)
})

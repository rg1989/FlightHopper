// tools/metrics.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crossTrackErrors, delaySlew, frameDiscontinuity, jerk, lateralAccel, percentile, verticalMetrics } from './metrics.ts'
import type { Frame, RateAt } from './types.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)
const HZ = 60

/** Synthetic 60 Hz frames for `seconds` of motion: pos(t) → [e, n, u]. */
function framesOf(pos: (t: number) => [number, number, number], seconds: number, mode: Frame['mode'] = 'interp'): Frame[] {
  const out: Frame[] = []
  for (let i = 0; i <= seconds * HZ; i++) {
    const t = i / HZ
    const [e, n, u] = pos(t)
    out.push({ t, e, n, u, mode, headingDeg: 0, pitchDeg: 0, rollDeg: 0 })
  }
  return out
}

const straight = (t: number): [number, number, number] => [120 * t - 3000, -80 * t + 1500, 5 * t + 900]
/** Circle of radius r (m) at speed v (m/s), counter-clockwise from due east of the centre, 1000 m up. */
const circle = (r: number, v: number) => (t: number): [number, number, number] => [r * Math.cos((v / r) * t), r * Math.sin((v / r) * t), 1000]

test('percentile: linear interpolation between closest ranks (type 7), input untouched, empty → NaN', () => {
  const xs = [4, 1, 3, 2]
  assert.equal(percentile(xs, 50), 2.5)
  assert.equal(percentile(xs, 0), 1)
  assert.equal(percentile(xs, 100), 4)
  assert.deepEqual(xs, [4, 1, 3, 2])
  near(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95), 95.05, 1e-9)
  assert.equal(percentile([7], 99), 7)
  assert.equal(percentile(xs, 150), 4, 'p is clamped to 0..100')
  assert.ok(Number.isNaN(percentile([], 50)))
})

test('frameDiscontinuity: constant velocity scores 0, also with irregular frame spacing', () => {
  const r = frameDiscontinuity(framesOf(straight, 10))
  near(r.maxM, 0, 1e-9)
  near(r.p99M, 0, 1e-9)
  let t = 0
  const jittered: Frame[] = []
  for (let i = 0; i < 600; i++) {
    t += i % 2 ? 1 / 50 : 1 / 70
    const [e, n, u] = straight(t)
    jittered.push({ t, e, n, u, mode: 'interp', headingDeg: 0, pitchDeg: 0, rollDeg: 0 })
  }
  near(frameDiscontinuity(jittered).maxM, 0, 1e-9)
})

test('frameDiscontinuity: a 5 m position jump scores ≈ 5 m; a smooth circle scores a·dt²', () => {
  const frames = framesOf(straight, 10).map((f, i) => (i >= 300 ? { ...f, e: f.e + 3, n: f.n + 4 } : f))
  near(frameDiscontinuity(frames).maxM, 5, 1e-6)
  const turn = frameDiscontinuity(framesOf(circle(2000, 100), 20))
  near(turn.maxM, 5 / HZ / HZ, 1e-6, 'a = v²/r = 5 m/s² → 1.39 mm per 60 Hz frame')
})

test('frameDiscontinuity: only triples of interp frames count; none → NaN', () => {
  const frames = framesOf(straight, 10).map((f, i) => (i >= 300 ? { ...f, e: f.e + 3, n: f.n + 4 } : f))
  frames[300] = { ...frames[300], mode: 'extrap' }
  frames[301] = { ...frames[301], mode: 'extrap' }
  near(frameDiscontinuity(frames).maxM, 0, 1e-9, 'the jump sits inside extrap frames')
  const none = frameDiscontinuity(framesOf(straight, 1, 'extrap'))
  assert.ok(Number.isNaN(none.maxM) && Number.isNaN(none.p99M))
})

test('lateralAccel: circle of radius r at speed v gives v²/r; straight line and along-track acceleration give 0', () => {
  const r = lateralAccel(framesOf(circle(2000, 100), 30))
  near(r.max, 5, 1e-4)
  near(r.p99, 5, 1e-4)
  const fast = lateralAccel(framesOf(circle(500, 60), 10))
  near(fast.max, 7.2, 1e-4, '60²/500')
  near(lateralAccel(framesOf(straight, 10)).max, 0, 1e-6)
  const braking = lateralAccel(framesOf((t) => [70 * t - 1.5 * t * t, 0, 0], 20))
  near(braking.max, 0, 1e-6, 'deceleration along the track is not lateral')
})

test('lateralAccel: a stopped aircraft counts its whole horizontal acceleration; too few frames → NaN', () => {
  const frames = framesOf(() => [10, 20, 5], 1)
  frames[30] = { ...frames[30], e: 10.01 }
  near(lateralAccel(frames).max, 0.02 * HZ * HZ, 1e-6, 'second difference of a 1 cm one-frame spike')
  assert.ok(Number.isNaN(lateralAccel(frames.slice(0, 2)).max))
})

test('jerk: |Δa|/Δt is v³/r² on a circle and 0 on a straight line', () => {
  near(jerk(framesOf(circle(2000, 100), 30)).p99, 0.25, 1e-3)
  near(jerk(framesOf(straight, 10)).p99, 0, 1e-5)
  near(jerk(framesOf((t) => [70 * t - 1.5 * t * t, 0, 0], 20)).p99, 0, 1e-5, 'constant acceleration has no jerk')
})

test('verticalMetrics: smooth climb matches the reported rate; 25 ft quantisation shows as steps', () => {
  const reported: RateAt[] = [{ t: 0, vsMs: 5 }, { t: 30, vsMs: 5 }]
  const smooth = verticalMetrics(framesOf((t) => [0, 0, 1000 + 5 * t], 30), reported)
  near(smooth.vsErrP95, 0, 1e-6)
  near(smooth.maxStepM, 5 / HZ, 1e-9)
  const step = 25 * 0.3048
  const quantised = verticalMetrics(framesOf((t) => [0, 0, Math.floor((1000 + 5 * t) / step) * step], 30), reported)
  near(quantised.maxStepM, step, 1e-9)
  near(quantised.vsErrP95, 5, 1e-9, 'most frames render 0 m/s against a reported 5 m/s')
})

test('verticalMetrics: reported rate is linearly interpolated at the frame-pair midpoint; frames outside it are skipped', () => {
  const reported: RateAt[] = [{ t: 0, vsMs: 0 }, { t: 10, vsMs: 10 }]
  near(verticalMetrics(framesOf((t) => [0, 0, 0.5 * t * t], 10), reported).vsErrP95, 0, 1e-6)
  const late = verticalMetrics(framesOf((t) => [0, 0, 0.5 * t * t], 10).map((f) => ({ ...f, t: f.t + 20 })), reported)
  assert.ok(Number.isNaN(late.vsErrP95))
  near(late.maxStepM, 10 / HZ, 1e-3, 'steps do not need a reported rate')
})

test('crossTrackErrors: distance to the rendered position at the same t, interpolated between frames', () => {
  const frames = framesOf((t) => [100 * t, 0, 500], 10)
  const errs = crossTrackErrors(frames, [
    { t: -1, e: -100, n: 0 },
    { t: 0.5, e: 50, n: 3 },
    { t: 1.2345, e: 123.45, n: -3 },
    { t: 2, e: 204, n: 0 },
    { t: 10, e: 1000, n: 0 },
    { t: 11, e: 1100, n: 0 },
  ])
  assert.equal(errs.length, 4, 'truth outside the rendered span is skipped')
  near(errs[0], 3, 1e-9)
  near(errs[1], 3, 1e-9)
  near(errs[2], 4, 1e-9, 'along-track error counts too (time-aligned distance)')
  near(errs[3], 0, 1e-9)
  assert.deepEqual(crossTrackErrors([], [{ t: 0, e: 0, n: 0 }]), [])
})

test('delaySlew: max |Δd/Δt| over consecutive samples', () => {
  const ramp = Array.from({ length: 121 }, (_, i) => ({ t: i / HZ, d: 3 + 0.2 * (i / HZ) }))
  near(delaySlew(ramp), 0.2, 1e-9)
  assert.equal(delaySlew(Array.from({ length: 10 }, (_, i) => ({ t: i, d: 4 }))), 0)
  near(delaySlew([{ t: 0, d: 3 }, { t: 1 / HZ, d: 3.5 }, { t: 1 / HZ, d: 9 }]), 30, 1e-9, 'a 0.5 s jump in one frame; the zero-Δt pair is skipped')
  assert.ok(Number.isNaN(delaySlew([{ t: 0, d: 3 }])))
})

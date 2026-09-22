// client/track/mlat.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gateOutliers, smoothPositions, velocitiesFromPositions } from './mlat.ts'
import type { PosT } from './types.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)

/** Deterministic PRNG (mulberry32) + Box–Muller, so the noisy tracks are identical on every run. */
function gauss(seed: number): () => number {
  let a = seed >>> 0
  const uni = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return () => Math.sqrt(-2 * Math.log(1 - uni())) * Math.cos(2 * Math.PI * uni())
}

// Straight track: 230 m/s on track 060°, starting at (−5000, 2000) at t = 1000 s.
const VE = 230 * Math.sin(Math.PI / 3)
const VN = 230 * Math.cos(Math.PI / 3)
const truthAt = (t: number): PosT => ({ t, e: -5000 + VE * (t - 1000), n: 2000 + VN * (t - 1000) })

/** n points with irregular MLAT-like spacing (0.6–2.4 s) and Gaussian position noise sigmaM. */
function noisyTrack(n: number, sigmaM: number, seed: number): { truth: PosT[]; meas: PosT[] } {
  const g = gauss(seed)
  const truth: PosT[] = []
  const meas: PosT[] = []
  let t = 1000
  for (let i = 0; i < n; i++) {
    const x = truthAt(t)
    truth.push(x)
    meas.push({ t, e: x.e + sigmaM * g(), n: x.n + sigmaM * g() })
    t += 1.5 + 0.9 * Math.sin(i * 1.7)
  }
  return { truth, meas }
}

const rmsPos = (pts: PosT[]): number => Math.sqrt(pts.reduce((s, p) => s + (p.e - truthAt(p.t).e) ** 2 + (p.n - truthAt(p.t).n) ** 2, 0) / pts.length)

test('gateOutliers: an injected 5 km outlier is removed and nothing else is', () => {
  const { meas } = noisyTrack(40, 30, 1)
  const bad = { ...meas[17], e: meas[17].e + 3000, n: meas[17].n - 4000 }
  const withOutlier = [...meas.slice(0, 17), bad, ...meas.slice(18)]
  const kept = gateOutliers(withOutlier, 600)
  assert.equal(kept.length, 39)
  assert.ok(!kept.includes(bad))
  assert.deepEqual(kept, withOutlier.filter((p) => p !== bad))
})

test('gateOutliers: a clean track passes untouched; speed exactly at the limit is kept', () => {
  const { meas } = noisyTrack(40, 30, 2)
  assert.deepEqual(gateOutliers(meas, 600), meas)
  const line: PosT[] = [{ t: 0, e: 0, n: 0 }, { t: 2, e: 600, n: 800 }, { t: 3, e: 600, n: 1300 }]
  assert.deepEqual(gateOutliers(line, 500), line)
  // Just under the limit, line[1] is dropped and line[2] is judged from line[0], the last kept point (1432 m in 3 s).
  assert.deepEqual(gateOutliers(line, 499.99), [line[0], line[2]])
})

test('gateOutliers: points that do not move forward in time are dropped; empty in, empty out', () => {
  const pts: PosT[] = [{ t: 5, e: 0, n: 0 }, { t: 5, e: 1, n: 1 }, { t: 4, e: 2, n: 2 }, { t: 6, e: 100, n: 0 }]
  assert.deepEqual(gateOutliers(pts, 300), [pts[0], pts[3]])
  assert.deepEqual(gateOutliers([], 300), [])
})

test('smoothPositions: reduces RMS position error of a noisy straight track', (t) => {
  const { meas } = noisyTrack(80, 60, 3)
  const smooth = smoothPositions(meas, 3)
  const raw = rmsPos(meas)
  const sm = rmsPos(smooth)
  t.diagnostic(`RMS raw ${raw.toFixed(1)} m → smoothed ${sm.toFixed(1)} m (halfWindow 3)`)
  assert.equal(smooth.length, meas.length)
  assert.ok(sm < 0.6 * raw, `raw ${raw} smoothed ${sm}`)
})

test('smoothPositions: noiseless constant-velocity motion is unbiased even with irregular timing', () => {
  const { truth } = noisyTrack(30, 0, 4)
  const smooth = smoothPositions(truth, 4)
  for (const p of smooth) {
    const x = truthAt(p.t)
    near(p.e, x.e, 1e-6, `e at ${p.t}`)
    near(p.n, x.n, 1e-6, `n at ${p.t}`)
  }
})

test('smoothPositions: centered window shrinks at the ends; halfWindow 0 is the identity', () => {
  const pts: PosT[] = [0, 1, 2, 3, 4].map((i) => ({ t: i, e: i * i, n: 3 - i }))
  const s = smoothPositions(pts, 2)
  assert.deepEqual(s[0], pts[0])
  assert.deepEqual(s[4], pts[4])
  assert.deepEqual(s[1], { t: 1, e: (0 + 1 + 4) / 3, n: 2 })
  assert.deepEqual(s[2], { t: 2, e: (0 + 1 + 4 + 9 + 16) / 5, n: 1 })
  assert.deepEqual(smoothPositions(pts, 0), pts)
  assert.deepEqual(smoothPositions([], 3), [])
})

test('velocitiesFromPositions: central differences inside, one-sided at the ends, exact on a line', () => {
  const { truth } = noisyTrack(12, 0, 5)
  const k = velocitiesFromPositions(truth)
  assert.equal(k.length, truth.length)
  for (let i = 0; i < k.length; i++) {
    assert.equal(k[i].t, truth[i].t)
    assert.equal(k[i].e, truth[i].e)
    assert.equal(k[i].n, truth[i].n)
    near(k[i].ve, VE, 1e-6, `ve[${i}]`)
    near(k[i].vn, VN, 1e-6, `vn[${i}]`)
  }
  const pts: PosT[] = [{ t: 0, e: 0, n: 0 }, { t: 1, e: 10, n: 0 }, { t: 3, e: 50, n: 4 }]
  assert.deepEqual(velocitiesFromPositions(pts).map((p) => [p.ve, p.vn]), [[10, 0], [50 / 3, 4 / 3], [20, 2]])
})

test('velocitiesFromPositions: one point has zero velocity; empty in, empty out', () => {
  assert.deepEqual(velocitiesFromPositions([{ t: 7, e: 1, n: 2 }]), [{ t: 7, e: 1, n: 2, ve: 0, vn: 0 }])
  assert.deepEqual(velocitiesFromPositions([]), [])
})

test('pipeline: gate → smooth → velocities beats raw differences on a noisy track with an outlier', (t) => {
  const { meas } = noisyTrack(80, 60, 6)
  meas[40] = { ...meas[40], e: meas[40].e + 5000 }
  const raw = velocitiesFromPositions(meas)
  const clean = velocitiesFromPositions(smoothPositions(gateOutliers(meas, 600), 3))
  const velRms = (k: { ve: number; vn: number }[]): number => Math.sqrt(k.reduce((s, p) => s + (p.ve - VE) ** 2 + (p.vn - VN) ** 2, 0) / k.length)
  t.diagnostic(`velocity RMS raw ${velRms(raw).toFixed(1)} m/s → cleaned ${velRms(clean).toFixed(1)} m/s`)
  assert.equal(clean.length, 79)
  assert.ok(velRms(clean) < 0.3 * velRms(raw), `raw ${velRms(raw)} clean ${velRms(clean)}`)
})

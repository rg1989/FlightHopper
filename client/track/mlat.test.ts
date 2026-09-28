// client/track/mlat.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { velocitiesFromPositions } from './mlat.ts'
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
  assert.deepEqual(velocitiesFromPositions([{ t: 7, e: 1, n: 2 }]), [{ t: 7, e: 1, n: 2, ve: 0, vn: 0, baseS: 0 }])
  assert.deepEqual(velocitiesFromPositions([]), [])
})


test('velocitiesFromPositions: with halfS, each difference spans the points within ±halfS (a longer baseline averages out time-stamp jitter); baseS says how long', () => {
  const pts: PosT[] = [0, 1, 2, 3, 4, 5, 6].map((t) => ({ t, e: 10 * t, n: 0 }))
  pts[3] = { t: 3, e: 45, n: 0 } // a late time stamp: 15 m off
  const narrow = velocitiesFromPositions(pts)
  const wide = velocitiesFromPositions(pts, 3)
  near(narrow[2].ve, 17.5, 1e-9, 'neighbours only: 75 % off')
  near(wide[2].ve, 10, 1e-9, 'from t = 0 to t = 5')
  assert.equal(wide[2].baseS, 5)
  assert.equal(wide[0].baseS, 3, 'at the start: 0 … 3 s')
  assert.equal(narrow[0].baseS, 1)
  assert.equal(velocitiesFromPositions([{ t: 7, e: 1, n: 2 }], 3)[0].baseS, 0)
})

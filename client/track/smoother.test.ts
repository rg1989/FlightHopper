// client/track/smoother.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quintic, smooth, trendSlopes, type Obs } from './smoother.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)

/** Deterministic N(0, 1) (Box–Muller on a small LCG), so the noisy tests never flake. */
function gauss(seed: number): () => number {
  let s = seed >>> 0
  const u = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 4294967296
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u())
}

const rms = (xs: number[]): number => Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / xs.length)

test('smooth: exact constant-velocity data comes back exactly, at irregular times', () => {
  const ts = [0, 1.7, 3.9, 5.1, 7.4, 9.0, 11.3]
  const obs: Obs[] = ts.map((t) => ({ t, p: 10 + 50 * t, rp: 225, v: 50, rv: 0.36 }))
  const k = smooth(obs, 0.3)
  assert.equal(k.length, ts.length)
  for (const [i, t] of ts.entries()) {
    near(k[i].t, t, 0)
    near(k[i].p, 10 + 50 * t, 1e-6)
    near(k[i].v, 50, 1e-7)
    near(k[i].a, 0, 1e-7)
  }
})

test('smooth: 15 m position noise with good velocities → path within a few metres', () => {
  const g = gauss(7)
  const ts = Array.from({ length: 61 }, (_, i) => 2 * i + 0.3 * g())
  const obs: Obs[] = ts.map((t) => ({ t, p: 70 * t + 15 * g(), rp: 225, v: 70 + 0.5 * g(), rv: 0.36 }))
  const k = smooth(obs, 0.15)
  const errs = k.map((x) => x.p - 70 * x.t)
  assert.ok(rms(errs) < 5, `rms ${rms(errs)}`)
  assert.ok(rms(k.map((x) => x.v - 70)) < 0.35, 'velocity')
  // ≤ 0.35 m/s² of made-up acceleration: under 2° of bank, and no speed swings
  assert.ok(Math.max(...k.map((x) => Math.abs(x.a))) < 0.35, 'no invented acceleration')
})

test('smooth: a position 1 s late (80 m behind) is ignored; the path stays on the truth', () => {
  const obs: Obs[] = Array.from({ length: 30 }, (_, i) => {
    const t = 2 * i
    return { t, p: 80 * t - (i === 15 ? 80 : 0), rp: 150, v: 80, rv: 0.36 }
  })
  const k = smooth(obs, 0.3)
  for (const x of k) near(x.p, 80 * x.t, 2, `at t=${x.t}`)
  for (const x of k) near(x.v, 80, 0.1, `v at t=${x.t}`)
})

test('smooth: a physically impossible jump is rejected even before the speed is known (second sample 3 km off)', () => {
  const obs: Obs[] = Array.from({ length: 40 }, (_, i) => {
    const t = 1.5 * i
    return { t, p: 200 * t + (i === 1 ? 3000 : 0), rp: 3600, v: null, rv: 0 }
  })
  const k = smooth(obs, 0.03, { v: 400, a: 20 })
  for (const x of k.slice(3)) near(x.p, 200 * x.t, 60, `at t=${x.t}`)
  for (const x of k) assert.ok(Math.abs(x.a) <= 20 + 1e-9, `a ${x.a} at ${x.t}`)
})

test('smooth: a real jump is followed after three rejections (re-synchronised)', () => {
  const obs: Obs[] = Array.from({ length: 30 }, (_, i) => {
    const t = 2 * i
    return { t, p: 60 * t + (i >= 10 ? 400 : 0), rp: 150, v: 60, rv: 0.36 }
  })
  const k = smooth(obs, 0.3)
  for (const x of k.slice(15)) near(x.p, 60 * x.t + 400, 5, `at t=${x.t}`)
})

test('smooth: after a data gap a manoeuvre is believed at once (the model cannot know what happened in the gap)', () => {
  // Straight at 100 m/s, a 6 s gap, then 150 m off to the side with a new velocity: no outlier, the new state.
  const obs: Obs[] = [0, 2, 4, 6, 8].map((t) => ({ t, p: 100 * t, rp: 150, v: 100, rv: 0.36 }))
  obs.push({ t: 14, p: 1400 + 150, rp: 150, v: 80, rv: 0.36 }, { t: 16, p: 1550 + 160, rp: 150, v: 80, rv: 0.36 })
  const k = smooth(obs, 0.15)
  near(k[5].p, 1550, 5)
  near(k[5].v, 80, 1)
})

test('smooth: a roll-in (acceleration building faster than the model expects) follows the velocity reports — no snap', () => {
  // Straight at 100 m/s, then within 2 s a steady 4 m/s² sideways (25° of bank): the velocity reports are believed.
  const acc = (t: number): number => (t < 20 ? 0 : t < 22 ? 2 * (t - 20) : 4)
  const vel = (t: number): number => (t < 20 ? 0 : t < 22 ? (t - 20) ** 2 : 4 + 4 * (t - 22))
  const pos = (t: number): number => (t < 20 ? 0 : t < 22 ? (t - 20) ** 3 / 3 : 8 / 3 + 4 * (t - 22) + 2 * (t - 22) ** 2)
  const obs: Obs[] = Array.from({ length: 30 }, (_, i) => ({ t: 2 * i, p: pos(2 * i), rp: 150, v: vel(2 * i), rv: 0.36 }))
  const k = smooth(obs, 0.15)
  for (const x of k) near(x.v, vel(x.t), 1.5, `v at ${x.t}`)
  for (const x of k.slice(14)) near(x.a, acc(x.t), 1.2, `a at ${x.t}`)
})

test('smooth: velocity reports that lag the positions in a turn do not drag the path away (lag-aware trust)', () => {
  // A steady turn (one axis: a = −Rω² sin ωt), the velocity reported 1 s late; the positions are exact to ±10 m.
  const w = (2.4 * Math.PI) / 180
  const R = 100 / w
  const g = gauss(11)
  const obs: Obs[] = Array.from({ length: 50 }, (_, i) => {
    const t = 2 * i
    return { t, p: R * Math.sin(w * t) + 10 * g(), rp: 100, v: R * w * Math.cos(w * (t - 1)), rv: 0.36 }
  })
  const k = smooth(obs, 0.15, null, { s: 1, sd: 0.5 })
  for (const x of k.slice(5, -2)) near(x.p, R * Math.sin(w * x.t), 12, `p at ${x.t}`)
})

test('smooth: a roll-in the velocity reports show late (1.4 s, the upper quartile at Heathrow) is followed — no snap', () => {
  // Straight at 97 m/s, then a 3°/s turn from t = 20 (one axis: sideways a = 5.1 m/s²); velocity reports 1.4 s late.
  const w = (3 * Math.PI) / 180
  const V = 97
  const vAt = (t: number): number => (t < 20 ? 0 : V * Math.sin(w * (t - 20)))
  const pAt = (t: number): number => (t < 20 ? 0 : (V / w) * (1 - Math.cos(w * (t - 20))))
  const obs: Obs[] = Array.from({ length: 30 }, (_, i) => ({ t: 2 * i, p: pAt(2 * i), rp: 150, v: vAt(2 * i - 1.4), rv: 0.36 }))
  const k = smooth(obs, 0.15, { v: 400, a: 20 }, { s: 0.75, sd: 0.55 }) // the lag measured at Heathrow (median 0.73 s)
  for (const x of k) assert.ok(Math.abs(x.v - vAt(x.t)) < 10, `v ${x.v} vs ${vAt(x.t)} at ${x.t}`)
  for (const x of k) near(x.p, pAt(x.t), 30, `p at ${x.t}`)
  for (let i = 1; i < k.length; i++) assert.ok(Math.abs(k[i].v - k[i - 1].v) < 25, `no velocity snap at ${k[i].t}`)
})

test('smooth: a turn is followed — acceleration recovered from velocity reports', () => {
  // One axis of a 3°/s turn at 70 m/s: e = R sin ωt, v = Rω cos ωt, a = −Rω² sin ωt (|a| ≈ 3.7 m/s²).
  const w = (3 * Math.PI) / 180
  const R = 70 / w
  const obs: Obs[] = Array.from({ length: 50 }, (_, i) => {
    const t = 2 * i
    return { t, p: R * Math.sin(w * t), rp: 225, v: R * w * Math.cos(w * t), rv: 0.36 }
  })
  const k = smooth(obs, 0.3)
  for (const x of k.slice(3, -3)) {
    near(x.p, R * Math.sin(w * x.t), 3, `p at ${x.t}`)
    near(x.a, -R * w * w * Math.sin(w * x.t), 0.4, `a at ${x.t}`)
  }
})

test('smooth: measurements may lack a position or a velocity; the first seeds the state', () => {
  const obs: Obs[] = [
    { t: 0, p: 0, rp: 9, v: null, rv: 0 },
    { t: 2, p: null, rp: 0, v: 5, rv: 0.25 },
    { t: 4, p: 20, rp: 9, v: 5, rv: 0.25 },
    { t: 6, p: 30, rp: 9, v: null, rv: 0 },
  ]
  const k = smooth(obs, 0.05)
  near(k[3].p, 30, 1)
  near(k[3].v, 5, 0.5)
})

test('smooth: quantised height (25 ft steps) with the rate → smooth vertical speed', () => {
  const g = gauss(3)
  const vs = -3.8 // ≈ −750 fpm
  const ts = Array.from({ length: 60 }, (_, i) => 2 * i + 0.1 * g())
  const q = 7.62
  const obs: Obs[] = ts.map((t) => ({ t, p: Math.round((600 + vs * t) / q) * q, rp: 9, v: vs + 0.3 * g(), rv: 0.25 }))
  const k = smooth(obs, 0.05)
  assert.ok(Math.max(...k.slice(3, -3).map((x) => Math.abs(x.v - vs))) < 0.25, 'vs within 50 fpm')
  assert.ok(rms(k.map((x) => x.p - (600 + vs * x.t))) < 2, 'height')
})

test('quintic: position, velocity and acceleration are exact at both ends', () => {
  const a = { t: 10, p: 5, v: -2, a: 0.3 }
  const b = { t: 12.5, p: 1, v: 1.5, a: -0.8 }
  for (const [t, k] of [[10, a], [12.5, b]] as const) {
    const s = quintic(a, b, t)
    near(s.p, k.p, 1e-12)
    near(s.v, k.v, 1e-12)
    near(s.a, k.a, 1e-12)
  }
})

test('quintic: constant acceleration is reproduced exactly between the ends', () => {
  const at = (t: number): { t: number; p: number; v: number; a: number } => ({ t, p: 3 + 4 * t + 0.25 * t * t, v: 4 + 0.5 * t, a: 0.5 })
  for (const t of [0.3, 1.1, 1.9]) {
    const s = quintic(at(0), at(2), t)
    near(s.p, at(t).p, 1e-9)
    near(s.v, at(t).v, 1e-9)
    near(s.a, 0.5, 1e-9)
  }
})

test('quintic: t is clamped to the segment', () => {
  const a = { t: 0, p: 0, v: 1, a: 0 }
  const b = { t: 1, p: 1, v: 1, a: 0 }
  near(quintic(a, b, -5).p, 0, 1e-12)
  near(quintic(a, b, 9).p, 1, 1e-12)
})

test('trendSlopes: least-squares slope of the heights within ±halfWindow', () => {
  const ts = [0, 2, 4, 6, 8, 10, 12]
  const hs = ts.map((t) => 100 - 3 * t)
  for (const s of trendSlopes(ts, hs, 6)) near(s, -3, 1e-9)
  const level = trendSlopes(ts, ts.map(() => 500), 6)
  for (const s of level) near(s, 0, 1e-12)
  assert.deepEqual(trendSlopes([5], [1], 6), [0]) // one height: no trend
})

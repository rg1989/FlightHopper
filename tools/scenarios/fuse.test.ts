// tools/scenarios/fuse.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Obs } from '../../client/track/smoother.ts'
import { fuseGround, fuseHeight, knotAt, smoothSparse, type HeightObs } from './fuse.ts'

const FT = 0.3048
const OPTS = { q: 1, lim: { v: 120, a: 35 } }
const maxRate = (ks: ReturnType<typeof fuseHeight>, t0: number, t1: number): number => {
  let m = 0
  for (let t = t0; t <= t1; t += 0.25) m = Math.max(m, Math.abs(knotAt(ks, t).v))
  return m
}

// A dive at 80 m/s (15,700 ft/min) from 3,000 m, entered and pulled out of at 1 g (8 s each), level either side.
function truth(t: number): number {
  const vs = (u: number): number => (u < 100 ? 0 : u < 108 ? -10 * (u - 100) : u < 125 ? -80 : u < 133 ? -80 + 10 * (u - 125) : 0)
  let h = 3000
  for (let u = 0; u < t; u += 0.01) h += vs(u) * 0.01
  return h
}

test('a fix whose time stamp is a few seconds off does not draw a spike through a dive', () => {
  // Fixes every 9 s at the true height, but every other one stamped 3 s late (a multilateration server's delay).
  const fixes: HeightObs[] = []
  for (let k = 0, t = 50; t <= 180; t += 9, k++) fixes.push({ t: t + (k % 2) * 3, hFt: truth(t) / FT, sdFt: 25, sdT: 0 })
  const naive = fuseHeight(fixes, [], OPTS)
  const real = fuseHeight(fixes.map((f) => ({ ...f, sdT: 3 })), [], OPTS)
  const n = maxRate(naive, 60, 170)
  const r = maxRate(real, 60, 170)
  assert.ok(r < n - 15, `with the timing error modelled the steepest rate ${r.toFixed(0)} m/s should be well under the naive ${n.toFixed(0)}`)
  assert.ok(r < 105, `${r.toFixed(0)} m/s: no steeper than the dive itself, give or take`)
})

test('energy: the airspeed rising 200 → 300 kt and falling back puts a dive and a zoom in a gap with no altitudes', () => {
  // Level at 3,000 m either side of a 70-s gap; the airspeed says the aircraft dived and zoomed back up in it.
  const heights: HeightObs[] = []
  for (let t = 0; t <= 60; t += 10) heights.push({ t, hFt: 3000 / FT, sdFt: 25, sdT: 1 })
  for (let t = 130; t <= 200; t += 10) heights.push({ t, hFt: 3000 / FT, sdFt: 25, sdT: 1 })
  const casAt = (t: number): number => (t < 70 ? 200 : t < 90 ? 200 + 5 * (t - 70) : t < 120 ? 300 - (10 / 3) * (t - 90) : 200)
  const flat = fuseHeight(heights, [], OPTS)
  const ks = fuseHeight(heights, [], { ...OPTS, casAt })
  let low = Infinity
  for (let t = 60; t <= 130; t += 1) low = Math.min(low, knotAt(ks, t).p)
  assert.ok(knotAt(flat, 90).p > 2950, 'without the airspeed nothing says it left 3,000 m')
  assert.ok(low < 3000 - 300, `lowest ${low.toFixed(0)} m: a 100-kt gain at ~3 km is ~800 m of height traded`)
})

test('a full circle flown between fixes 20 s apart is flown again at the airspeed, not cut short', () => {
  // North at 130 m/s, a 360° left turn in 40 s (64° of bank) from 100 s, north again. Fixes every 20 s, still air:
  // at the circle's start, its far side and its end, which show an out-and-back, not a loop.
  const V = 130
  const heading = (t: number): number => (t < 100 ? 0 : t < 140 ? (-2 * Math.PI * (t - 100)) / 40 : 0)
  const fixes: Array<{ t: number; e: number; n: number }> = []
  let [e, n] = [0, 0]
  for (let k = 0; k <= 24_000; k++) {
    const t = k / 100
    if (k % 2000 === 0) fixes.push({ t, e, n })
    e += V * Math.sin(heading(t)) * 0.01
    n += V * Math.cos(heading(t)) * 0.01
  }
  const obs = (k: 'e' | 'n'): Obs[] => fixes.map((f) => ({ t: f.t, p: f[k], rp: 60 ** 2, v: null, rv: 0 }))
  const lim = { v: 400, a: 35 }
  const cut = { e: smoothSparse(obs('e'), 0.3, lim), n: smoothSparse(obs('n'), 0.3, lim) }
  const r = fuseGround(obs('e'), obs('n'), () => ({ air: V, hM: 1000 }), 0.3, lim)
  const slowest = (p: typeof cut): number => {
    let m = Infinity
    for (let t = 90; t <= 150; t += 0.5) m = Math.min(m, Math.hypot(knotAt(p.e, t).v, knotAt(p.n, t).v))
    return m
  }
  assert.ok(slowest(cut) < 0.7 * V, `the positions alone cut the circle: ${slowest(cut).toFixed(0)} m/s`)
  assert.equal(r.turns.length, 1)
  assert.equal(r.turns[0].circles, -1, 'one circle to the left')
  assert.ok(slowest(r) > 0.85 * V, `flown at the airspeed: slowest ${slowest(r).toFixed(0)} m/s`)
  assert.ok(r.turns[0].maxBankDeg > 50 && r.turns[0].maxBankDeg < 70, `bank ${r.turns[0].maxBankDeg.toFixed(0)}°`)
  for (const f of fixes.filter((x) => x.t > 100 && x.t < 140)) {
    const d = Math.hypot(knotAt(r.e, f.t).p - f.e, knotAt(r.n, f.t).p - f.n)
    assert.ok(d < 250, `the fix at ${f.t} s is ${d.toFixed(0)} m off the circle`)
  }
})

// server/descent.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { clean, diveThenLost, steepDescent, type AltSeries } from './descent.ts'

/** A series from [s, ft] pairs. */
const series = (pts: [number, number][]): AltSeries => ({ t: pts.map((p) => p[0]), ft: pts.map((p) => p[1]) })
/** Every `stepS` from t0 to t1 at the altitude f(t). */
const line = (t0: number, t1: number, stepS: number, f: (t: number) => number): [number, number][] => {
  const out: [number, number][] = []
  for (let t = t0; t <= t1; t += stepS) out.push([t, Math.round(f(t))])
  return out
}

test('clean: altitudes above 50,000 ft and spikes go; a real fall stays', () => {
  const s = series([[0, 35_000], [10, 35_000], [20, 69_400], [30, 35_000], [40, 12_000], [50, 35_000], [60, 34_000], [70, 33_000]])
  assert.deepEqual(clean(s), series([[0, 35_000], [10, 35_000], [30, 35_000], [50, 35_000], [60, 34_000], [70, 33_000]]))
  const fall = series(line(0, 120, 10, (t) => 35_000 - 100 * t))
  assert.deepEqual(clean(fall), fall)
})

test('steepDescent (D1): FL350 to FL227 in 2 min is one, from its top (the last point at FL350) to its bottom', () => {
  const s = series([...line(0, 50, 10, () => 35_000), ...line(60, 170, 10, (t) => 35_000 - (12_300 * (t - 50)) / 120), ...line(180, 300, 10, () => 22_700)])
  const d = steepDescent(clean(s))
  assert.ok(d !== null)
  assert.equal(d.fromFt, 35_000)
  assert.equal(d.startS, 50)
  assert.ok(d.toFt <= 22_800, `to ${d.toFt}`)
})

test('steepDescent (D1): too small, too low, too slow, too few points, or a gap is none', () => {
  assert.equal(steepDescent(series(line(0, 120, 10, (t) => 35_000 - 75 * t))), null) // 9,000 ft in 120 s
  assert.equal(steepDescent(series(line(0, 120, 10, (t) => 19_000 - 100 * t))), null) // from FL190
  assert.equal(steepDescent(series(line(0, 300, 10, (t) => 35_000 - 40 * t))), null) // 12,000 ft over 5 min: a normal descent
  assert.equal(steepDescent(series([[0, 35_000], [40, 30_000], [80, 24_000]])), null) // 3 points
  assert.equal(steepDescent(series([[0, 35_000], [10, 34_000], [100, 24_000], [110, 23_000]])), null) // a 90 s hole
  assert.equal(steepDescent(clean(series([[0, 35_000], [10, 35_000], [20, 10_000], [30, 35_000], [40, 35_000]]))), null) // a spike
})

test('diveThenLost (D2): FZ1073 as the open networks heard it', () => {
  const rows = readFileSync(new URL('../public/scenarios/fz1073/track.csv', import.meta.url), 'utf8').trim().split('\n').slice(1)
  const sec = (hms: string): number => { const [h, m, s] = hms.split(':').map(Number); return h * 3600 + m * 60 + s }
  const pts: [number, number][] = []
  for (const r of rows) {
    const c = r.split(',')
    const t = sec(c[0])
    if (c[12] === 'ADSBLOL' && t >= sec('05:00:00') && t <= sec('05:22:13') && t % 10 === 3) pts.push([t, Number(c[3])])
  }
  const s = clean(series(pts))
  const d = diveThenLost(s, sec('05:29:50'))
  assert.ok(d !== null, 'the dive then the 9-minute silence')
  assert.equal(d.endS, sec('05:22:13'))
  assert.ok(d.fromFt - d.toFt >= 4000, `fell ${d.fromFt - d.toFt}`)
  assert.equal(diveThenLost(s, sec('05:22:53')), null, 'lost for 40 s only')
  assert.equal(steepDescent(s), null, 'not 10,000 ft in 2 min')
})

test('diveThenLost (D2): a slow or low fall, or one that goes on, is none', () => {
  assert.equal(diveThenLost(series(line(0, 30, 10, (t) => 35_000 - 50 * t)), 200), null) // 1,500 ft
  assert.equal(diveThenLost(series(line(0, 30, 10, (t) => 14_000 - 120 * t)), 200), null) // below FL150
  assert.equal(diveThenLost(series([[0, 35_000], [30, 31_000]]), 200), null) // 2 points
})

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
/** Level at 35,000 ft to t = 50 s, then 12,300 ft down in 120 s: 22,700 ft at t = 170 s. Every 10 s. */
const fl350Fall = (): [number, number][] => [...line(0, 50, 10, () => 35_000), ...line(60, 170, 10, (t) => 35_000 - (12_300 * (t - 50)) / 120)]
/** 35,000 ft down to 31,000 ft in 30 s. Every 10 s. */
const dive = (): [number, number][] => line(0, 30, 10, (t) => 35_000 - (4_000 * t) / 30)

test('clean: altitudes above 50,000 ft and spikes go; a real fall stays', () => {
  const s = series([[0, 35_000], [10, 35_000], [20, 69_400], [30, 35_000], [40, 12_000], [50, 35_000], [60, 34_000], [70, 33_000]])
  assert.deepEqual(clean(s), series([[0, 35_000], [10, 35_000], [30, 35_000], [50, 35_000], [60, 34_000], [70, 33_000]]))
  const fall = series(line(0, 120, 10, (t) => 35_000 - 100 * t))
  assert.deepEqual(clean(fall), fall)
})

test('clean: a point at the time of the one kept before it, or earlier, goes, so t is strictly increasing', () => {
  const s = series([[0, 35_000], [10, 35_000], [10, 34_900], [20, 34_800], [15, 34_850], [30, 34_700]])
  assert.deepEqual(clean(s), series([[0, 35_000], [10, 35_000], [20, 34_800], [30, 34_700]]))
})

test('clean: a spike is judged against the neighbours that are left when the repeated times are gone', () => {
  // 41,000 ft is a spike between 35,000 and 35,200. The row after it at the same time is a repeat, not a neighbour.
  assert.deepEqual(clean(series([[0, 35_000], [10, 41_000], [10, 40_000], [20, 35_200]])), series([[0, 35_000], [20, 35_200]]))
})

test('an empty series and a single point: clean leaves them, and there is no descent and no dive', () => {
  for (const s of [series([]), series([[0, 35_000]])]) {
    assert.deepEqual(clean(s), s)
    assert.equal(steepDescent(s), null)
    assert.equal(diveThenLost(s, 1_000), null)
  }
  assert.deepEqual(clean(series([[0, 69_400]])), series([])) // a single impossible point goes
})

test('steepDescent (D1): FL350 to FL227 in 2 min is one, from its top (the last point at FL350) to its bottom', () => {
  const s = series([...fl350Fall(), ...line(180, 300, 10, () => 22_700)])
  const d = steepDescent(clean(s))
  assert.ok(d !== null)
  assert.equal(d.fromFt, 35_000)
  assert.equal(d.startS, 50)
  assert.ok(d.toFt <= 22_800, `to ${d.toFt}`)
})

test('steepDescent (D1): the fall ends at its first bottom, not in a descent that follows 10 min of level flight', () => {
  const s = series([...fl350Fall(), ...line(180, 770, 10, () => 22_700), ...line(780, 1_110, 10, (t) => 22_700 - (19_700 * (t - 770)) / 340)]) // then down to 3,000 ft
  assert.deepEqual(steepDescent(clean(s)), { startS: 50, endS: 170, fromFt: 35_000, toFt: 22_700 })
})

test('steepDescent (D1): a slow climb back ends the fall, and a second descent below its bottom is not part of it', () => {
  const s = series([...fl350Fall(), ...line(180, 230, 10, (t) => 22_700 + 10 * (t - 170)), ...line(240, 330, 10, (t) => 23_300 - 50 * (t - 230))])
  assert.deepEqual(steepDescent(clean(s)), { startS: 50, endS: 170, fromFt: 35_000, toFt: 22_700 })
})

test('steepDescent (D1): a row repeated in the middle of a fall does not hide it', () => {
  const rows = [...fl350Fall(), ...line(180, 300, 10, () => 22_700)]
  const at = rows.findIndex(([t]) => t === 110)
  const repeated = [...rows.slice(0, at + 1), ...rows.slice(at)] // the row at 110 s twice
  assert.deepEqual(steepDescent(clean(series(repeated))), { startS: 50, endS: 170, fromFt: 35_000, toFt: 22_700 })
})

test('steepDescent (D1): too small, too low, too slow, too few points, or a gap is none', () => {
  assert.equal(steepDescent(series(line(0, 120, 10, (t) => 35_000 - 75 * t))), null) // 9,000 ft in 120 s
  assert.equal(steepDescent(series(line(0, 120, 10, (t) => 19_000 - 100 * t))), null) // from FL190
  assert.equal(steepDescent(series(line(0, 300, 10, (t) => 35_000 - 40 * t))), null) // 12,000 ft over 5 min: a normal descent
  assert.equal(steepDescent(series([[0, 35_000], [40, 30_000], [80, 24_000]])), null) // 3 points
  assert.equal(steepDescent(series([[0, 35_000], [10, 34_000], [100, 24_000], [110, 23_000]])), null) // a 90 s hole
  assert.equal(steepDescent(clean(series([[0, 35_000], [10, 35_000], [20, 10_000], [30, 35_000], [40, 35_000]]))), null) // a spike
})

test('steepDescent (D1): exactly 10,000 ft in exactly 120 s over 4 points is one; 9,999 ft, 121 s or 3 points is not', () => {
  assert.deepEqual(steepDescent(series([[0, 35_000], [40, 32_000], [80, 28_000], [120, 25_000]])), { startS: 0, endS: 120, fromFt: 35_000, toFt: 25_000 })
  assert.equal(steepDescent(series([[0, 35_000], [40, 32_000], [80, 28_000], [120, 25_001]])), null) // 9,999 ft
  assert.equal(steepDescent(series([[0, 35_000], [40, 32_000], [80, 28_000], [121, 25_000]])), null) // 121 s
  assert.equal(steepDescent(series([[0, 35_000], [40, 29_000], [80, 25_000]])), null) // 3 points
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

test('diveThenLost (D2): 35,000 ft down to 31,000 in 30 s, then no position for 2 min, is one', () => {
  assert.deepEqual(diveThenLost(series(dive()), 30 + 120), { startS: 0, endS: 30, fromFt: 35_000, toFt: 31_000 })
})

test('diveThenLost (D2): exactly 3,000 ft in exactly 30 s over 3 points, then exactly 60 s lost, is one; 2,999 ft, 31 s or 59 s is not', () => {
  const edge = series([[0, 35_000], [15, 33_500], [30, 32_000]])
  assert.deepEqual(diveThenLost(edge, 90), { startS: 0, endS: 30, fromFt: 35_000, toFt: 32_000 })
  assert.equal(diveThenLost(series([[0, 35_000], [15, 33_500], [30, 32_001]]), 90), null) // 2,999 ft
  assert.equal(diveThenLost(series([[0, 35_000], [15, 33_500], [31, 32_000]]), 91), null) // 31 s
  assert.equal(diveThenLost(edge, 89), null) // lost for 59 s
})

test('diveThenLost (D2): a last row repeated does not hide the dive', () => {
  const rows = dive()
  const s = series([...rows, rows[rows.length - 1]])
  assert.deepEqual(diveThenLost(clean(s), 150), { startS: 0, endS: 30, fromFt: 35_000, toFt: 31_000 })
})

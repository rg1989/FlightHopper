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
/** Level at 35,000 ft to t = 50 s, then 16,000 ft down in 120 s: 19,000 ft at t = 170 s. Every 10 s. */
const fl350Fall = (): [number, number][] => [...line(0, 50, 10, () => 35_000), ...line(60, 170, 10, (t) => 35_000 - (16_000 * (t - 50)) / 120)]
/** 35,000 ft down to 31,000 ft in 30 s. Every 10 s. */
const dive = (): [number, number][] => line(0, 30, 10, (t) => 35_000 - (4_000 * t) / 30)

test('clean: altitudes above 50,000 ft and spikes go; a real fall stays', () => {
  const s = series([[0, 35_000], [10, 35_000], [20, 69_400], [30, 35_000], [40, 41_000], [50, 35_000], [60, 34_000], [70, 33_000]])
  assert.deepEqual(clean(s), series([[0, 35_000], [10, 35_000], [30, 35_000], [50, 35_000], [60, 34_000], [70, 33_000]]))
  const fall = series(line(0, 120, 10, (t) => 35_000 - 100 * t))
  assert.deepEqual(clean(fall), fall)
})

test('clean: a point over 1,000 ft off the line between its neighbours, its steps to them going opposite ways, goes; 1,000 ft stays', () => {
  // A GNSS altitude among baro ones, or a bad decode. Level neighbours first, above and below.
  for (const up of [1, -1]) {
    const edge = series([[0, 30_000], [10, 30_000 + up * 1_000], [20, 30_000]])
    assert.deepEqual(clean(edge), edge, `${up * 1_000} ft off the line: stays`)
    assert.deepEqual(clean(series([[0, 30_000], [10, 30_000 + up * 1_001], [20, 30_000]])), series([[0, 30_000], [20, 30_000]]), `${up * 1_001} ft: goes`)
  }
  // Neighbours that fall, the line interpolated in time: at 10 s of 100 s it is 34,600 ft, at 90 s of 100 s 31,400 ft.
  const early = series([[0, 35_000], [10, 35_600], [100, 31_000]]) // 1,000 ft above the line
  assert.deepEqual(clean(early), early)
  assert.deepEqual(clean(series([[0, 35_000], [10, 35_601], [100, 31_000]])), series([[0, 35_000], [100, 31_000]]))
  const late = series([[0, 35_000], [90, 30_400], [100, 31_000]]) // 1,000 ft below the line
  assert.deepEqual(clean(late), late)
  assert.deepEqual(clean(series([[0, 35_000], [90, 30_399], [100, 31_000]])), series([[0, 35_000], [100, 31_000]]))
})

test('clean: a step change, a plateau and a fall that slows are not outliers: a zero step, or both steps the same way', () => {
  for (const pts of [
    [[0, 30_000], [10, 33_000], [20, 33_000]], // up, then level
    [[0, 30_000], [10, 30_000], [20, 33_000]], // level, then up
    [[0, 35_000], [10, 30_000], [20, 29_000]], // down, then down more slowly
    [[0, 40_000], [1, 39_000], [2, 38_000]], // 60,000 fpm each way, but both down
  ] as [number, number][][]) {
    assert.deepEqual(clean(series(pts)), series(pts), JSON.stringify(pts))
  }
})

test('clean: a spike whose steps are both over 30,000 fpm goes, 30,000 fpm stays, and one step over is not enough', () => {
  // 1 s apart, 500 ft is 30,000 fpm. Under 1,000 ft off the line, so only the speed can drop these.
  const edge = series([[0, 35_000], [1, 35_500], [2, 35_000]])
  assert.deepEqual(clean(edge), edge, '30,000 fpm each way')
  assert.deepEqual(clean(series([[0, 35_000], [1, 35_501], [2, 35_000]])), series([[0, 35_000], [2, 35_000]]), '30,060 fpm each way')
  const one = series([[0, 35_000], [1, 35_501], [3, 35_001]]) // in at 30,060 fpm, out at 15,000
  assert.deepEqual(clean(one), one)
  // One step at exactly 30,000 fpm and the other at 60,000: the one that is not over is enough to keep it, on either side.
  const slowIn = series([[0, 35_000], [1, 35_500], [1.5, 35_000]])
  assert.deepEqual(clean(slowIn), slowIn)
  const slowOut = series([[0, 35_000], [0.5, 35_500], [1.5, 35_000]])
  assert.deepEqual(clean(slowOut), slowOut)
})

test('clean: the ceiling is 50,000 ft: 50,000 stays, 50,001 goes', () => {
  const edge = series([[0, 49_500], [10, 50_000], [20, 50_000]])
  assert.deepEqual(clean(edge), edge)
  assert.deepEqual(clean(series([[0, 49_500], [10, 50_001], [20, 50_000]])), series([[0, 49_500], [20, 50_000]]))
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

test('steepDescent (D1): FL350 to FL190 in 2 min is one, from its top (the last point at FL350) to its bottom', () => {
  const s = series([...fl350Fall(), ...line(180, 300, 10, () => 19_000)])
  const d = steepDescent(clean(s))
  assert.ok(d !== null)
  assert.equal(d.fromFt, 35_000)
  assert.equal(d.startS, 50)
  assert.ok(d.toFt <= 19_100, `to ${d.toFt}`)
})

test('steepDescent (D1): the fall ends at its first bottom, not in a descent that follows 10 min of level flight', () => {
  const s = series([...fl350Fall(), ...line(180, 770, 10, () => 19_000), ...line(780, 1_110, 10, (t) => 19_000 - (16_000 * (t - 770)) / 340)]) // then down to 3,000 ft
  assert.deepEqual(steepDescent(clean(s)), { startS: 50, endS: 170, fromFt: 35_000, toFt: 19_000 })
})

test('steepDescent (D1): a slow climb back ends the fall, and a second descent below its bottom is not part of it', () => {
  const s = series([...fl350Fall(), ...line(180, 230, 10, (t) => 19_000 + 10 * (t - 170)), ...line(240, 330, 10, (t) => 19_600 - 50 * (t - 230))])
  assert.deepEqual(steepDescent(clean(s)), { startS: 50, endS: 170, fromFt: 35_000, toFt: 19_000 })
})

test('steepDescent (D1): a row repeated in the middle of a fall does not hide it', () => {
  const rows = [...fl350Fall(), ...line(180, 300, 10, () => 19_000)]
  const at = rows.findIndex(([t]) => t === 110)
  const repeated = [...rows.slice(0, at + 1), ...rows.slice(at)] // the row at 110 s twice
  assert.deepEqual(steepDescent(clean(series(repeated))), { startS: 50, endS: 170, fromFt: 35_000, toFt: 19_000 })
})

test('steepDescent (D1): a dive at 9,000 fpm sampled every 2 s, with an altitude repeated after the fall is found, still reaches its true bottom', () => {
  // Level at 35,000 ft to 20 s, then 150 ft/s (9,000 fpm) down to 5,000 ft at 220 s, then level. 15,000 ft are lost at 120 s: the
  // point that finds the fall, at 20,000 ft. The sample at 122 s reads 20,000 ft again (a repeat; the true altitude is 19,700 ft).
  // The fall goes on for 100 s after it is found, a new low every 2 s: each one resets the clock.
  const alt = (t: number): number => Math.max(5_000, 35_000 - 150 * Math.max(0, t - 20))
  const rows: [number, number][] = []
  for (let t = 0; t <= 300; t += 2) rows.push([t, t === 122 ? 20_000 : alt(t)])
  assert.deepEqual(steepDescent(clean(series(rows))), { startS: 20, endS: 220, fromFt: 35_000, toFt: 5_000 })
  // Live: the series grows a sample at a time, and the fall is not stuck at the repeat.
  const live = (toS: number) => steepDescent(clean(series(rows.filter(([t]) => t <= toS))))
  assert.equal(live(118), null)
  assert.deepEqual(live(120), { startS: 20, endS: 120, fromFt: 35_000, toFt: 20_000 })
  assert.deepEqual(live(122), { startS: 20, endS: 120, fromFt: 35_000, toFt: 20_000 }, 'the repeat')
  assert.deepEqual(live(124), { startS: 20, endS: 124, fromFt: 35_000, toFt: 19_400 })
  assert.deepEqual(live(200), { startS: 20, endS: 200, fromFt: 35_000, toFt: 8_000 })
  assert.deepEqual(live(260), { startS: 20, endS: 220, fromFt: 35_000, toFt: 5_000 })
})

test('steepDescent (D1): after the fall is found, its bottom follows on while each step is a fall, and ends when 60 s pass with no new low', () => {
  // fl350Fall ends at 19,000 ft at 170 s, the point that finds the fall.
  const then = (rows: [number, number][]) => steepDescent(series([...fl350Fall(), ...rows]))
  const bottom = (endS: number, toFt: number) => ({ startS: 50, endS, fromFt: 35_000, toFt })
  assert.deepEqual(then([[180, 19_000], [230, 18_900]]), bottom(230, 18_900), 'a new low 60 s after the last one')
  assert.deepEqual(then([[180, 19_000], [231, 18_900]]), bottom(170, 19_000), 'a new low 61 s after it: too late')
  assert.deepEqual(then([[180, 19_000], [190, 19_000], [200, 18_900]]), bottom(200, 18_900), 'level, then lower: bridged')
  assert.deepEqual(then([[180, 19_300], [190, 18_000]]), bottom(190, 18_000), 'a rise of 300 ft is bridged')
  assert.deepEqual(then([[180, 19_301], [190, 18_000]]), bottom(170, 19_000), 'a rise of 301 ft ends the fall')
  assert.deepEqual(then([[230, 18_900]]), bottom(230, 18_900), 'a hole of 60 s is bridged')
  assert.deepEqual(then([[231, 18_900]]), bottom(170, 19_000), 'a hole of 61 s ends the fall')
})

test('steepDescent (D1): too small, too low, too slow, too few points, or a gap is none', () => {
  assert.equal(steepDescent(series(line(0, 120, 10, (t) => 35_000 - (14_000 * t) / 120))), null) // 14,000 ft in 120 s
  assert.equal(steepDescent(series(line(0, 120, 10, (t) => 19_000 - 130 * t))), null) // 15,600 ft, but from FL190
  assert.equal(steepDescent(series(line(0, 300, 10, (t) => 35_000 - 55 * t))), null) // 16,500 ft over 5 min, 6,600 ft in any 2 min: a normal descent
  assert.equal(steepDescent(series([[0, 35_000], [40, 28_000], [80, 19_000]])), null) // 3 points
  assert.equal(steepDescent(series([[0, 35_000], [10, 33_000], [100, 21_000], [110, 19_000]])), null) // a 90 s hole
  assert.equal(steepDescent(clean(series([[0, 35_000], [10, 35_000], [20, 10_000], [30, 35_000], [40, 35_000]]))), null) // a spike
})

test('steepDescent (D1): exactly 15,000 ft in exactly 120 s over 4 points is one; 14,999 ft, 121 s or 3 points is not', () => {
  assert.deepEqual(steepDescent(series([[0, 35_000], [40, 30_000], [80, 25_000], [120, 20_000]])), { startS: 0, endS: 120, fromFt: 35_000, toFt: 20_000 })
  assert.equal(steepDescent(series([[0, 35_000], [40, 30_000], [80, 25_000], [120, 20_001]])), null) // 14,999 ft
  assert.equal(steepDescent(series([[0, 35_000], [40, 30_000], [80, 25_000], [121, 20_000]])), null) // 121 s
  assert.equal(steepDescent(series([[0, 35_000], [60, 27_000], [120, 20_000]])), null) // 3 points
})

test('steepDescent (D1): a top of exactly 20,000 ft is one; 19,999 ft is not', () => {
  assert.deepEqual(steepDescent(series([[0, 20_000], [40, 14_000], [80, 8_000], [120, 5_000]])), { startS: 0, endS: 120, fromFt: 20_000, toFt: 5_000 })
  assert.equal(steepDescent(series([[0, 19_999], [40, 13_999], [80, 7_999], [120, 4_999]])), null)
})

test('steepDescent (D1): the limits of a step, shared with D2: a hole of 60 s, a rise of 300 ft and 30,000 fpm are in a fall; 61 s, 301 ft and 30,001 fpm are not', () => {
  const hole = (s: number) => steepDescent(series([[0, 35_000], [70 - s, 33_000], [70, 25_000], [120, 19_000]])) // 15,000 ft or more in 120 s, one step s seconds long
  assert.deepEqual(hole(60), { startS: 0, endS: 120, fromFt: 35_000, toFt: 19_000 })
  assert.equal(hole(61), null)
  const rise = (ft: number) => steepDescent(series([[0, 35_000], [30, 30_000], [60, 30_000 + ft], [90, 25_000], [120, 20_000]])) // exactly 15,000 ft, one step up by ft
  assert.deepEqual(rise(300), { startS: 0, endS: 120, fromFt: 35_000, toFt: 20_000 })
  assert.equal(rise(301), null)
  const fast = (ft: number) => steepDescent(series([[0, 35_000], [10, 35_000 - ft], [60, 25_000], [120, 19_000]])) // the first step ft in 10 s, at 6 × ft fpm
  assert.deepEqual(fast(5_000), { startS: 0, endS: 120, fromFt: 35_000, toFt: 19_000 }, '30,000 fpm')
  assert.equal(fast(5_001), null, '30,006 fpm')
  const slow = (ft: number) => steepDescent(series([[0, 49_000], [60, 49_000 - ft], [90, 18_500], [120, 18_000]])) // the first step ft in 60 s: ft fpm
  assert.deepEqual(slow(30_000), { startS: 0, endS: 120, fromFt: 49_000, toFt: 18_000 }, '30,000 fpm')
  assert.equal(slow(30_001), null, '30,001 fpm')
})

// The real points of FZ1073 (aircraft 8965d1, A6-FKF, a B38M) in adsb.lol's 2026-09-30 05:00 half-hour file, globe_history/2026/09/30/
// heatmap/10.bin.ttf: seconds into the slot, ft. The point at 1320 s is a GNSS altitude among baro ones (readsb writes GNSS when it
// has no baro). The slice at 1310 s is missing. The file's last slice is at 1790 s.
const FZ1073_FILE: [number, number][] = [
  [1140, 34_000], [1160, 34_000], [1170, 34_000], [1190, 34_000], [1210, 34_000], [1230, 34_000], [1250, 34_000],
  [1260, 33_975], [1270, 33_950], [1280, 33_375], [1290, 33_075], [1300, 32_850], [1320, 35_550], [1330, 27_950],
]

test('diveThenLost (D2): the real FZ1073 points: clean drops the GNSS altitude, and the fall into the last point is found', () => {
  const raw = series(FZ1073_FILE)
  const s = clean(raw)
  assert.equal(s.t.includes(1320), false, 'the GNSS altitude goes')
  assert.deepEqual(diveThenLost(s, 1790), { startS: 1270, endS: 1330, fromFt: 33_950, toFt: 27_950 })
  assert.deepEqual(diveThenLost(s, 1390), { startS: 1270, endS: 1330, fromFt: 33_950, toFt: 27_950 }, 'lost for 60 s')
  assert.equal(diveThenLost(s, 1380), null, 'lost for 50 s')
  assert.equal(diveThenLost(raw, 1790), null, 'with the GNSS altitude in, the step into the last point is over 30,000 fpm')
  assert.equal(steepDescent(s), null, 'not 15,000 ft in 2 min')
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
  assert.equal(steepDescent(s), null, 'not 15,000 ft in 2 min')
})

test('diveThenLost (D2): a slow or low fall, or one that goes on, is none', () => {
  assert.equal(diveThenLost(series(line(0, 30, 10, (t) => 35_000 - 50 * t)), 200), null) // 1,500 ft
  assert.equal(diveThenLost(series(line(0, 30, 10, (t) => 14_000 - 120 * t)), 200), null) // below FL150
  assert.equal(diveThenLost(series([[0, 35_000], [30, 31_000]]), 200), null) // 2 points
  assert.equal(diveThenLost(series([[0, 35_000], [30, 33_000], [60, 31_000]]), 200), null) // 4,000 ft in 60 s: 4,000 fpm
})

test('diveThenLost (D2): 35,000 ft down to 31,000 in 30 s, then no position for 2 min, is one', () => {
  assert.deepEqual(diveThenLost(series(dive()), 30 + 120), { startS: 0, endS: 30, fromFt: 35_000, toFt: 31_000 })
})

test('diveThenLost (D2): exactly 3,000 ft over 3 points, then exactly 60 s lost, is one; 2,999 ft, 2 points or 59 s is not', () => {
  const edge = series([[0, 35_000], [15, 33_500], [30, 32_000]]) // 6,000 fpm
  assert.deepEqual(diveThenLost(edge, 90), { startS: 0, endS: 30, fromFt: 35_000, toFt: 32_000 })
  assert.equal(diveThenLost(series([[0, 35_000], [15, 33_500], [30, 32_001]]), 90), null, '2,999 ft')
  assert.equal(diveThenLost(series([[0, 35_000], [30, 32_000]]), 90), null, '2 points')
  assert.equal(diveThenLost(edge, 89), null, 'lost for 59 s')
})

test('diveThenLost (D2): a top of exactly 15,000 ft is one; 14,999 ft is not', () => {
  assert.deepEqual(diveThenLost(series([[0, 15_000], [15, 13_500], [30, 12_000]]), 90), { startS: 0, endS: 30, fromFt: 15_000, toFt: 12_000 })
  assert.equal(diveThenLost(series([[0, 14_999], [15, 13_499], [30, 11_999]]), 90), null)
})

test('diveThenLost (D2): an average of exactly 5,000 fpm is one; 4,999 fpm is not', () => {
  assert.deepEqual(diveThenLost(series([[0, 35_000], [30, 32_500], [60, 30_000]]), 120), { startS: 0, endS: 60, fromFt: 35_000, toFt: 30_000 }, '5,000 ft in 60 s')
  assert.equal(diveThenLost(series([[0, 35_000], [30, 32_500], [60, 30_001]]), 120), null, '4,999 ft in 60 s')
  assert.deepEqual(diveThenLost(series([[0, 35_000], [18, 33_500], [36, 32_000]]), 100), { startS: 0, endS: 36, fromFt: 35_000, toFt: 32_000 }, '3,000 ft in 36 s')
  assert.equal(diveThenLost(series([[0, 35_000], [19, 33_500], [37, 32_000]]), 100), null, '3,000 ft in 37 s: 4,865 fpm')
})

test('diveThenLost (D2): the top is within the last 60 s: exactly 60 s is in, 61 s is out', () => {
  assert.deepEqual(diveThenLost(series([[0, 35_000], [30, 32_000], [60, 29_000]]), 120), { startS: 0, endS: 60, fromFt: 35_000, toFt: 29_000 })
  assert.equal(diveThenLost(series([[0, 35_000], [30, 32_000], [61, 29_000]]), 121), null, 'the top at 30 s has only 2 points')
})

test('diveThenLost (D2): every step from the top to the last point is a fall, and of the tops that fit the biggest fall is taken', () => {
  const dip = (rise: number) => series([[0, 35_000], [10, 33_000], [20, 33_000 + rise], [30, 31_000], [40, 29_000]])
  // A rise of 300 ft is noise in a fall: the top at 0 s is the biggest fall. A rise of 301 ft is a step that is no fall: only the point after it can be a top.
  assert.deepEqual(diveThenLost(dip(300), 100), { startS: 0, endS: 40, fromFt: 35_000, toFt: 29_000 })
  assert.deepEqual(diveThenLost(dip(301), 100), { startS: 20, endS: 40, fromFt: 33_301, toFt: 29_000 })
})

test('diveThenLost (D2): of tops with an equal fall, the later is taken: a fall starts where level flight ends', () => {
  assert.deepEqual(diveThenLost(series([[0, 35_000], [10, 35_000], [20, 33_000], [30, 31_000]]), 100), { startS: 10, endS: 30, fromFt: 35_000, toFt: 31_000 })
})

test('diveThenLost (D2): the limits of a step: the last step at exactly 30,000 fpm is in the fall, 30,001 fpm is not', () => {
  assert.deepEqual(diveThenLost(series([[0, 35_000], [20, 33_000], [30, 28_000]]), 100), { startS: 0, endS: 30, fromFt: 35_000, toFt: 28_000 }, '5,000 ft in 10 s')
  assert.equal(diveThenLost(series([[0, 35_000], [20, 33_000], [30, 27_999]]), 100), null, '5,001 ft in 10 s')
})

test('diveThenLost (D2): a last row repeated does not hide the dive', () => {
  const rows = dive()
  const s = series([...rows, rows[rows.length - 1]])
  assert.deepEqual(diveThenLost(clean(s), 150), { startS: 0, endS: 30, fromFt: 35_000, toFt: 31_000 })
})

test('steepDescent (D1): when the point that completes the fall is a small rise after the bottom, the fall ends at the bottom', () => {
  const d = steepDescent(series([[0, 35_000], [30, 27_000], [60, 19_000], [90, 19_200]]))
  assert.deepEqual(d, { startS: 0, endS: 60, fromFt: 35_000, toFt: 19_000 })
})

test('steepDescent (D1): when the point that completes the fall is level with the bottom, the fall ends at the first of them', () => {
  assert.deepEqual(steepDescent(series([[0, 35_000], [30, 27_000], [60, 20_000], [90, 20_000]])), { startS: 0, endS: 60, fromFt: 35_000, toFt: 20_000 })
})

// client/scene/modelWind.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODEL_CLOUD_HPA, MODEL_WIND_HPA, type ModelGeo, type ModelGrid } from '../../shared/wx.ts'
import { pressureHPa } from '../track/airspeed.ts'
import { inInnerHalf, modelWindAt, nearestPlace } from './modelWind.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${msg} got ${a}, expected ${b} ± ${tol}`)
/** The pressure altitude (ft) of a pressure: pressureHPa turned round (it falls with height), by halving. */
function ftAt(hPa: number): number {
  let [lo, hi] = [-1000, 70_000]
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (pressureHPa(mid) > hPa) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}
const GEO: ModelGeo = { lat0: 31.5, lon0: 34, step: 0.25, n: 7 } // 31.5 … 33 north, 34 … 35.5 east; the middle at 32.25, 34.75

/** From (degrees) and speed (kt) at each level, 850 … 200 hPa, the same at every place unless `at` says another place's. */
function grid(winds: [number, number][], at: Record<number, [number, number][]> = {}, geo: ModelGeo = GEO): ModelGrid {
  const n = geo.n * geo.n
  return {
    ...geo, timeMs: 1791014400_000, elevM: Array.from({ length: n }, () => 0),
    clouds: MODEL_CLOUD_HPA.map((hPa) => ({ hPa, cover: Array.from({ length: n }, () => 0), zM: Array.from({ length: n }, () => 1000) })),
    winds: MODEL_WIND_HPA.map((hPa, l) => ({
      hPa,
      kt: Array.from({ length: n }, (_, p) => (at[p] ?? winds)[l][1]),
      deg: Array.from({ length: n }, (_, p) => (at[p] ?? winds)[l][0]),
    })),
  }
}
const SAME: [number, number][] = [[270, 10], [270, 20], [270, 40], [270, 80], [270, 90], [270, 100]] // 850, 700, 500, 300, 250, 200

test('nearestPlace: the index of the grid\'s nearest place (row × 7 + column); a place up to a step beyond the grid\'s edge takes the edge\'s; farther, none', () => {
  assert.equal(nearestPlace(GEO, 31.5, 34), 0, 'the south-west corner')
  assert.equal(nearestPlace(GEO, 33, 35.5), 48, 'the north-east')
  assert.equal(nearestPlace(GEO, 32.25, 34.75), 24, 'the middle')
  assert.equal(nearestPlace(GEO, 31.5, 35.5), 6)
  assert.equal(nearestPlace(GEO, 33, 34), 42)
  assert.equal(nearestPlace(GEO, 32.37, 34.86), 24, 'within half a step of the middle')
  assert.equal(nearestPlace(GEO, 32.38, 34.86), 31, 'past half a step: the row north (3 × 7 + 3 = 24; 4 × 7 + 3 = 31)')
  assert.equal(nearestPlace(GEO, 31.3, 34), 0, 'under the edge by less than a step: the edge place')
  assert.equal(nearestPlace(GEO, 33.2, 35.7), 48)
  assert.equal(nearestPlace(GEO, 31.2, 34), -1, 'more than a step (0.25°) beyond: the grid says nothing of it')
  assert.equal(nearestPlace(GEO, 32, 33.7), -1)
  assert.equal(nearestPlace(GEO, 32, 35.8), -1)
  assert.equal(nearestPlace(GEO, 33.3, 35), -1)
  assert.equal(nearestPlace(GEO, Number.NaN, 35), -1)
  assert.equal(nearestPlace(GEO, 32, Number.NaN), -1)
})

test('nearestPlace: across the antimeridian a grid runs on past 180', () => {
  const geo: ModelGeo = { lat0: 0, lon0: 179.5, step: 0.25, n: 7 } // 179.5 … 181 (−179)
  assert.equal(nearestPlace(geo, 0, 179.5), 0)
  assert.equal(nearestPlace(geo, 0, 180), 2)
  assert.equal(nearestPlace(geo, 0, -179.8), 3, '−179.8 is 180.2: 2.8 steps on')
  assert.equal(nearestPlace(geo, 0.75, -179), 3 * 7 + 6, 'row 3, the last column (181 is −179)')
})

test('inInnerHalf: the middle half of the grid\'s extent each way (within 0.375° of its middle), edges included', () => {
  assert.equal(inInnerHalf(GEO, 32.25, 34.75), true)
  assert.equal(inInnerHalf(GEO, 32.25 + 0.375, 34.75 - 0.375), true)
  assert.equal(inInnerHalf(GEO, 32.25 + 0.376, 34.75), false)
  assert.equal(inInnerHalf(GEO, 32.25, 34.75 - 0.376), false)
  assert.equal(inInnerHalf(GEO, 33, 34.75), false, 'on the grid\'s north edge')
  assert.equal(inInnerHalf(GEO, 32.25, Number.NaN), false)
  const across: ModelGeo = { lat0: 0, lon0: 179.5, step: 0.25, n: 7 } // the middle at 180.25 = −179.75
  assert.equal(inInnerHalf(across, 0.75, -179.75), true)
  assert.equal(inInnerHalf(across, 0.75, 179.9), true, '0.35° west of the middle')
  assert.equal(inInnerHalf(across, 0.75, 179.8), false)
})

test('modelWindAt: at a level\'s own pressure the level\'s wind; the wind as the model has it, from and kt', () => {
  const g = grid([[200, 12], [230, 18], [250, 45], [265, 85], [270, 95], [260, 110]])
  for (const [l, hPa] of MODEL_WIND_HPA.entries()) {
    const w = modelWindAt(g, 32.25, 34.75, ftAt(hPa))!
    near(w.fromDeg, g.winds[l].deg[0]!, 0.2, `${hPa} hPa from`)
    near(w.kt, g.winds[l].kt[0]!, 0.05, `${hPa} hPa kt`)
  }
})

test('modelWindAt: between two levels in the log of the pressure, as vectors: 700 hPa 20 kt from the west and 500 hPa 40 kt from the south, half way in log-p, is 22 kt from the south-south-west', () => {
  const g = grid([[270, 10], [270, 20], [180, 40], [180, 80], [180, 90], [180, 100]])
  const w = modelWindAt(g, 32.25, 34.75, ftAt(Math.sqrt(700 * 500)))!
  near(w.kt, Math.hypot(10, 20), 0.05, 'the mean of (20, 0) and (0, 40): (10, 20)')
  near(w.fromDeg, 206.57, 0.1, 'it blows toward the north-north-east: (10, 20); angles would have said 225° and 30 kt')
  const justBelow = modelWindAt(g, 32.25, 34.75, ftAt(700) - 1)! // a foot under the 700 hPa level: its pressure a little more
  near(justBelow.kt, 20, 0.2)
  assert.ok(justBelow.fromDeg > 268 && justBelow.fromDeg < 272)
  // linear in log-p, not in the pressure or the height: a quarter of the way from 300 hPa (80 kt) to 250 hPa (90 kt) down in pressure
  const q = modelWindAt(g, 32.25, 34.75, ftAt(300 * (250 / 300) ** 0.25))!
  near(q.kt, 82.5, 0.05)
})

test('modelWindAt: above the top level and below the lowest, the nearest level\'s wind', () => {
  const g = grid([[200, 12], [230, 18], [250, 45], [265, 85], [270, 95], [260, 110]])
  const top = modelWindAt(g, 32.25, 34.75, 45_000)! // about 147 hPa
  near(top.kt, 110, 0.05)
  near(top.fromDeg, 260, 0.2)
  const low = modelWindAt(g, 32.25, 34.75, 2_000)! // about 942 hPa
  near(low.kt, 12, 0.05)
  near(low.fromDeg, 200, 0.2)
  near(modelWindAt(g, 32.25, 34.75, -500)!.kt, 12, 0.05, 'below sea level')
})

test('modelWindAt: the nearest place of the grid, whichever place the aircraft is over', () => {
  const g = grid(SAME, { 24: [[90, 30], [90, 31], [90, 32], [90, 33], [90, 34], [90, 35]], 0: [[10, 5], [10, 5], [10, 5], [10, 5], [10, 5], [10, 5]] })
  // 10,000 ft is 697 hPa: a hundredth of the way from 700 hPa (the middle place 31 kt, the corner 5, elsewhere 20 kt) to 500 hPa
  const middle = modelWindAt(g, 32.25, 34.75, 10_000)!
  near(middle.kt, 31.0, 0.1, 'the middle place: from the east')
  near(middle.fromDeg, 90, 0.5)
  near(modelWindAt(g, 31.51, 34.01, 10_000)!.kt, 5, 0.01, 'the south-west corner')
  near(modelWindAt(g, 31.51, 34.01, 10_000)!.fromDeg, 10, 0.5)
  const other = modelWindAt(g, 32.25, 35.2, 10_000)! // the place at row 3, column 5
  near(other.kt, 20.3, 0.1, 'another place: the same wind from the west everywhere else')
  near(other.fromDeg, 270, 0.5)
})

test('modelWindAt: a level the model has no value for at that place is left out and the others are used; none at all: null', () => {
  const g = grid(SAME)
  g.winds[1].kt[24] = null // 700 hPa speed
  g.winds[2].deg[24] = null // 500 hPa direction
  const w = modelWindAt(g, 32.25, 34.75, ftAt(Math.sqrt(850 * 300)))!
  near(w.kt, 10 + (80 - 10) * (Math.log(850 / Math.sqrt(850 * 300)) / Math.log(850 / 300)), 0.1, 'between 850 and 300 hPa, the two that remain (the log-p of the mid-point)')
  const none = grid(SAME)
  for (const l of none.winds) l.kt[24] = null
  assert.equal(modelWindAt(none, 32.25, 34.75, 10_000), null)
})

test('modelWindAt: calm is 0 kt (no direction to speak of); a place the grid does not cover, or not a number: null', () => {
  const calm = modelWindAt(grid(MODEL_WIND_HPA.map(() => [0, 0] as [number, number])), 32.25, 34.75, 10_000)!
  assert.equal(calm.kt, 0)
  assert.equal(calm.fromDeg, 0)
  const opposite = modelWindAt(grid([[90, 20], [90, 20], [270, 20], [270, 20], [270, 20], [270, 20]]), 32.25, 34.75, ftAt(Math.sqrt(700 * 500)))!
  near(opposite.kt, 0, 0.05, 'two equal opposite winds cancel')
  assert.ok(opposite.fromDeg >= 0 && opposite.fromDeg < 360)
  assert.equal(modelWindAt(grid(SAME), 40, 34.75, 10_000), null, 'far north of the grid')
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(modelWindAt(grid(SAME), 32.25, 34.75, bad), null)
    assert.equal(modelWindAt(grid(SAME), bad, 34.75, 10_000), null)
    assert.equal(modelWindAt(grid(SAME), 32.25, bad, 10_000), null)
  }
})

test('modelWindAt: the direction is where the wind blows from, 0 to 360: north 0, east 90, whatever the height', () => {
  for (const from of [0, 45, 90, 180, 270, 359]) {
    for (const ft of [3_000, 20_000, 38_000]) {
      const w = modelWindAt(grid(MODEL_WIND_HPA.map(() => [from, 10] as [number, number])), 32.25, 34.75, ft)!
      near(w.kt, 10, 0.01)
      assert.ok(w.fromDeg >= 0 && w.fromDeg < 360, String(w.fromDeg))
      near(((w.fromDeg - from + 540) % 360) - 180, 0, 0.01, `from ${from}`)
    }
  }
})

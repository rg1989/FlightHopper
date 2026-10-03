// client/scene/modelWind.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODEL_CLOUD_HPA, MODEL_WIND_HPA, type ModelGeo, type ModelGrid } from '../../shared/wx.ts'
import { pressureHPa } from '../track/airspeed.ts'
import { cellAt, inInnerHalf, modelWindAt } from './modelWind.ts'

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

test('cellAt: the cell round a point: its south-west place\'s row and column and how far on (0 … 1) toward the next place north and east; a point up to a step beyond the grid\'s edge is on its edge, farther, none', () => {
  assert.deepEqual(cellAt(GEO, 31.5, 34), { row: 0, col: 0, ty: 0, tx: 0 }, 'the south-west corner')
  assert.deepEqual(cellAt(GEO, 32.25, 34.75), { row: 3, col: 3, ty: 0, tx: 0 }, 'on a place')
  const mid = cellAt(GEO, 32.375, 34.875)!
  assert.deepEqual([mid.row, mid.col], [3, 3])
  near(mid.ty, 0.5, 1e-9)
  near(mid.tx, 0.5, 1e-9)
  const q = cellAt(GEO, 32.3, 34.95)!
  near(q.ty, 0.2, 1e-9)
  near(q.tx, 0.8, 1e-9)
  assert.deepEqual(cellAt(GEO, 33, 35.5), { row: 5, col: 5, ty: 1, tx: 1 }, 'the north-east corner is the far corner of the last cell')
  assert.deepEqual(cellAt(GEO, 31.3, 34), { row: 0, col: 0, ty: 0, tx: 0 }, 'under the edge by less than a step: on it')
  assert.deepEqual(cellAt(GEO, 33.2, 35.7), { row: 5, col: 5, ty: 1, tx: 1 })
  for (const [lat, lon] of [[31.2, 34], [32, 33.7], [32, 35.8], [33.3, 35], [Number.NaN, 35], [32, Number.NaN], [Number.POSITIVE_INFINITY, 35], [32, Number.POSITIVE_INFINITY]]) {
    assert.equal(cellAt(GEO, lat, lon), null, `${lat}, ${lon}: more than a step (0.25°) beyond: the grid says nothing of it`)
  }
})

test('cellAt: across the antimeridian a grid runs on past 180', () => {
  const geo: ModelGeo = { lat0: 0, lon0: 179.5, step: 0.25, n: 7 } // 179.5 … 181 (−179)
  assert.deepEqual(cellAt(geo, 0, 179.5), { row: 0, col: 0, ty: 0, tx: 0 })
  assert.deepEqual(cellAt(geo, 0, 180), { row: 0, col: 2, ty: 0, tx: 0 })
  const west = cellAt(geo, 0, -179.8)!
  assert.deepEqual([west.row, west.col], [0, 2])
  near(west.tx, 0.8, 1e-9)
  assert.deepEqual(cellAt(geo, 0.75, -179), { row: 3, col: 5, ty: 0, tx: 1 }, 'the last column (181 is −179)')
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

test('modelWindAt: exactly a place\'s wind on the place; between places the four round it, by how near, as vectors', () => {
  const west: [number, number][] = MODEL_WIND_HPA.map(() => [270, 20]) // from the west: toward (+20, 0)
  const south: [number, number][] = MODEL_WIND_HPA.map(() => [180, 20]) // from the south: toward (0, +20)
  const east: [number, number][] = MODEL_WIND_HPA.map(() => [90, 20]) // toward (−20, 0)
  const north: [number, number][] = MODEL_WIND_HPA.map(() => [0, 40]) // toward (0, −40)
  // the cell of places 24 (row 3, column 3), 25 (column 4), 31 (row 4) and 32: 32.25 … 32.5 N, 34.75 … 35 E
  const g = grid(SAME, { 24: west, 25: south, 31: east, 32: north })
  const at = (lat: number, lon: number) => modelWindAt(g, lat, lon, ftAt(500))! // 500 hPa: the level's own
  const on = at(32.25, 34.75)
  near(on.kt, 20, 0.05, 'on place 24')
  near(on.fromDeg, 270, 0.3)
  const east1 = at(32.25, 35)
  near(east1.kt, 20, 0.05, 'on place 25')
  near(east1.fromDeg, 180, 0.3)
  const half = at(32.25, 34.875) // half way from 24 to 25: (20, 0) and (0, 20) make (10, 10)
  near(half.kt, Math.hypot(10, 10), 0.05)
  near(half.fromDeg, 225, 0.3)
  const centre = at(32.375, 34.875) // the four: (20, 0) + (0, 20) + (−20, 0) + (0, −40) over 4 = (0, −5)
  near(centre.kt, 5, 0.05)
  near(centre.fromDeg, 0, 0.3)
  const quarter = at(32.3125, 34.8125) // 0.25 each way: weights 9/16, 3/16, 3/16, 1/16
  const east_ = (9 * 20 + 3 * 0 + 3 * -20 + 1 * 0) / 16
  const north_ = (9 * 0 + 3 * 20 + 3 * 0 + 1 * -40) / 16
  near(quarter.kt, Math.hypot(east_, north_), 0.05)
  near(quarter.fromDeg, (Math.atan2(-east_, -north_) * 180 / Math.PI + 360) % 360, 0.3)
})

test('modelWindAt: the wind does not step as the aircraft crosses the middle between two places: a hair either side is the same wind, and along the row it changes by small steps', () => {
  const g = grid(SAME, { 24: [[90, 60], [90, 60], [90, 60], [90, 60], [90, 60], [90, 60]], 25: [[270, 20], [270, 20], [270, 20], [270, 20], [270, 20], [270, 20]] })
  const before = modelWindAt(g, 32.25, 34.874999, ftAt(500))!
  const after = modelWindAt(g, 32.25, 34.875001, ftAt(500))!
  near(after.kt, before.kt, 0.01, 'half way: (−60, 0) and (20, 0): 20 kt toward the west')
  near(after.fromDeg, before.fromDeg, 0.5)
  near(before.kt, 20, 0.1)
  near(before.fromDeg, 90, 0.5)
  // and across a whole row of places the wind changes by steps of the same size, none larger than the places differ
  let prev = modelWindAt(g, 32.25, 34.75, ftAt(500))!.kt
  for (let x = 34.76; x <= 35.0001; x += 0.01) {
    const kt = modelWindAt(g, 32.25, x, ftAt(500))!.kt
    assert.ok(Math.abs(kt - prev) < 4, `${x}: ${kt} after ${prev}`)
    prev = kt
  }
})

test('modelWindAt: at the grid\'s edge, and up to a step beyond it, the edge places\' wind; farther none', () => {
  const g = grid(SAME, { 48: [[90, 30], [90, 30], [90, 30], [90, 30], [90, 30], [90, 30]] }) // the north-east corner
  near(modelWindAt(g, 33, 35.5, ftAt(500))!.kt, 30, 0.05, 'on it')
  near(modelWindAt(g, 33.2, 35.7, ftAt(500))!.kt, 30, 0.05, 'a little beyond: the corner\'s')
  assert.equal(modelWindAt(g, 33.3, 35.5, ftAt(500)), null)
  const along = modelWindAt(g, 33, 35.375, ftAt(500))! // half way along the north edge from place 47 (the 500 hPa wind is 40 kt from the west) to 48 (30 kt from the east): (40, 0) and (−30, 0)
  near(along.kt, 5, 0.1)
  near(along.fromDeg, 270, 0.5)
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

test('modelWindAt: a place round the point with no wind at a level is left out and the others are weighted as they were; every one of them without: the level is left out', () => {
  // places 24 and 25 side by side, speeds at 850, 700, 500, 300, 250, 200 hPa from the west; half way between them: 10, 30, 40, 80, 90, 100 kt
  const kts = (v: number[]): [number, number][] => v.map((kt) => [270, kt])
  const g = grid(SAME, { 24: kts([10, 20, 30, 80, 90, 100]), 25: kts([10, 40, 50, 80, 90, 100]) })
  const half = (): number => modelWindAt(g, 32.25, 34.875, ftAt(500))!.kt
  near(half(), 40, 0.05, 'both places: the mean at 500 hPa')
  g.winds[2].kt[25] = null // 500 hPa: place 25 has none
  near(half(), 30, 0.05, 'only place 24 has it: its 30 kt, not half of it')
  g.winds[2].kt[24] = null // neither has: the level is left out and 500 hPa is between 700 (30 kt here) and 300 (80 kt), in log-p
  near(half(), 30 + (80 - 30) * (Math.log(700 / 500) / Math.log(700 / 300)), 0.1)
  for (const l of g.winds) l.kt[24] = l.kt[25] = null
  assert.equal(modelWindAt(g, 32.25, 34.875, ftAt(500)), null, 'no wind at either: none')
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

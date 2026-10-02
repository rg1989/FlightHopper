// client/scene/routeLine.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cartesian3, Cartographic } from 'cesium'
import { distanceNm } from '../../shared/geo.ts'
import { altitudeRgba, GROUND_INDEX, UNKNOWN_INDEX } from './altitudeColor.ts'
import { arc, countUpTo, cutInGap, decimate, firstHeardText, GAP_NM, GAP_S, greatCircle, groundHeights, indexRgba, PATH_LIFT_M, pathRuns } from './routeLine.ts'
import type { PathPoint, PathRun } from './routeLine.ts'

test('greatCircle: both ends, ~20 nm steps, every point on the shortest way (TLV → LHR passes over the Alps, not Turkey)', () => {
  const tlv = { lat: 32.0114, lon: 34.8867 }
  const lhr = { lat: 51.47, lon: -0.4543 }
  const pts = greatCircle(tlv, lhr)
  const total = distanceNm(tlv.lat, tlv.lon, lhr.lat, lhr.lon)
  assert.deepEqual(pts[0], tlv)
  assert.ok(distanceNm(pts.at(-1)!.lat, pts.at(-1)!.lon, lhr.lat, lhr.lon) < 0.01)
  assert.equal(pts.length, Math.ceil(total / 20) + 1)
  let sum = 0
  for (let i = 1; i < pts.length; i++) sum += distanceNm(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon)
  assert.ok(Math.abs(sum - total) < 0.5, `${sum} vs ${total}: no detour`)
  const mid = pts[Math.floor(pts.length / 2)]
  assert.ok(mid.lat > 40 && mid.lat < 46 && mid.lon > 14 && mid.lon < 20, `midpoint ${mid.lat}, ${mid.lon}: over the Adriatic`)
  assert.equal(greatCircle(tlv, tlv).length, 2, 'no leg: its two ends')
  assert.ok(greatCircle({ lat: 0, lon: 0 }, { lat: 0, lon: 179 }).length <= 400, 'capped')
})

const NM_DEG = 1 / 60 // ° of latitude per nm, near enough (1° = 60.04 nm)

/** A point heard tS after 0, nm north of 32° N 34° E, at alt ft (null: unknown, 'g': on the ground). */
function pt(tS: number, nm: number, alt: number | null | 'g'): PathPoint {
  const onGround = alt === 'g'
  const altFt = alt === 'g' ? null : alt
  return { tMs: tS * 1000, lat: 32 + nm * NM_DEG, lon: 34, hM: (altFt ?? 0) * 0.3048, altFt, onGround }
}

/** Runs in short: flown or gap, the colour (gaps: null, it is not theirs to say), the points' times in s. */
const short = (runs: PathRun[]): { gap: boolean; color: number | null; t: number[] }[] =>
  runs.map((r) => ({ gap: r.gap, color: r.gap ? null : r.color, t: r.points.map((p) => p.tMs / 1000) }))

/** Every run starts at the point the one before it ended at (the same object). */
function assertJoined(runs: PathRun[]): void {
  for (let i = 1; i < runs.length; i++) assert.equal(runs[i].points[0], runs[i - 1].points.at(-1), `run ${i} starts where run ${i - 1} ends`)
}

test('pathRuns: nothing to draw → []', () => {
  assert.deepEqual(pathRuns([], Infinity), [])
  assert.deepEqual(pathRuns([pt(10, 0, 5000), pt(20, 1, 5000)], 9_999), [], 'all of it after the cut')
})

test('pathRuns: one 1,000 ft band → one run, in the band\'s colour (FL370 ± 50 ft: the icons\' 37,000 ft)', () => {
  const pts = [pt(0, 0, 37_000), pt(10, 0.6, 37_025), pt(20, 1.2, 36_975), pt(30, 1.8, 37_000), pt(40, 2.4, 37_050)]
  const runs = pathRuns(pts, Infinity)
  assert.deepEqual(short(runs), [{ gap: false, color: 370, t: [0, 10, 20, 30, 40] }])
  assert.deepEqual(runs[0].points, pts)
})

test('pathRuns: a climb across 1,000 ft bands → a run per band, each starting where the one before ended', () => {
  const alts = [3_200, 3_500, 3_800, 4_100, 4_400, 4_700, 5_000, 5_300]
  const runs = pathRuns(alts.map((a, i) => pt(i * 10, i * 0.6, a)), Infinity)
  assert.deepEqual(short(runs), [
    { gap: false, color: 30, t: [0, 10, 20] },
    { gap: false, color: 40, t: [20, 30, 40, 50] },
    { gap: false, color: 50, t: [50, 60, 70] },
  ])
  assertJoined(runs)
})

test('pathRuns: a step takes the colour of the point it leads to (a lone first point takes the next one\'s)', () => {
  assert.deepEqual(short(pathRuns([pt(0, 0, 500), pt(10, 0.6, 1_500)], Infinity)), [{ gap: false, color: 10, t: [0, 10] }])
})

test('pathRuns: a 90 s, 5 nm hole → a gap run of its two ends between the flown runs', () => {
  assert.equal(GAP_S, 60)
  assert.equal(GAP_NM, 2)
  const pts = [pt(0, 0, 30_000), pt(10, 1, 30_000), pt(20, 2, 30_000), pt(110, 7, 30_000), pt(120, 8, 30_000)]
  const runs = pathRuns(pts, Infinity)
  assert.deepEqual(short(runs), [
    { gap: false, color: 300, t: [0, 10, 20] },
    { gap: true, color: null, t: [20, 110] },
    { gap: false, color: 300, t: [110, 120] },
  ])
  assertJoined(runs)
})

test('pathRuns: not a gap unless the step is both longer than GAP_S and longer than GAP_NM', () => {
  // Parked: 90 s without a position, 0.5 nm on (a slow taxi between two receivers' reach).
  const parked = [pt(0, 0, 'g'), pt(10, 0.01, 'g'), pt(100, 0.51, 'g'), pt(110, 0.52, 'g')]
  assert.deepEqual(short(pathRuns(parked, Infinity)), [{ gap: false, color: GROUND_INDEX, t: [0, 10, 100, 110] }])
  // Fast: 5 nm in 30 s is a jet heard every 30 s, not a hole.
  const fast = [pt(0, 0, 36_000), pt(30, 5, 36_000), pt(60, 10, 36_000)]
  assert.deepEqual(short(pathRuns(fast, Infinity)), [{ gap: false, color: 360, t: [0, 30, 60] }])
})

test('pathRuns: a last point alone after a gap is a run of its own (its colour joins the aircraft)', () => {
  const runs = pathRuns([pt(0, 0, 30_000), pt(10, 1, 30_000), pt(200, 20, 25_000)], Infinity)
  assert.deepEqual(short(runs), [
    { gap: false, color: 300, t: [0, 10] },
    { gap: true, color: null, t: [10, 200] },
    { gap: false, color: 250, t: [200] },
  ])
})

test('pathRuns: one point → a run of it, in its own band', () => {
  assert.deepEqual(short(pathRuns([pt(0, 0, 12_345)], Infinity)), [{ gap: false, color: 120, t: [0] }])
})

test('pathRuns: two gaps in a row → a lone point before, between and after them, every run joined', () => {
  const runs = pathRuns([pt(0, 0, 20_000), pt(100, 10, 20_000), pt(200, 20, 20_000)], Infinity)
  assert.deepEqual(short(runs), [
    { gap: false, color: 200, t: [0] },
    { gap: true, color: null, t: [0, 100] },
    { gap: false, color: 200, t: [100] },
    { gap: true, color: null, t: [100, 200] },
    { gap: false, color: 200, t: [200] },
  ])
  assertJoined(runs)
})

test('pathRuns: a cut inside a gap\'s step leaves the gap out (its far end is not heard yet)', () => {
  const pts = [pt(0, 0, 30_000), pt(10, 1, 30_000), pt(200, 20, 30_000), pt(210, 21, 30_000)]
  assert.deepEqual(short(pathRuns(pts, 100_000)), [{ gap: false, color: 300, t: [0, 10] }])
  assert.deepEqual(short(pathRuns(pts, 200_000)), [
    { gap: false, color: 300, t: [0, 10] },
    { gap: true, color: null, t: [10, 200] },
    { gap: false, color: 300, t: [200] },
  ])
})

test('cutInGap: a cut inside a hole’s step joins the aircraft dotted; not in a heard step, nor once the far end is reached', () => {
  const pts = [pt(0, 0, 30_000), pt(10, 1, 30_000), pt(200, 20, 30_000), pt(210, 21, 30_000)]
  const inGap = (cutMs: number): boolean => cutInGap(pts, countUpTo(pts, cutMs))
  assert.equal(inGap(5_000), false, 'a heard step')
  assert.equal(inGap(100_000), true, 'inside the hole: its far end is not drawn yet')
  assert.equal(inGap(200_000), false, 'its far end reached: the hole is a gap run of the path')
  assert.equal(inGap(205_000), false)
  assert.equal(inGap(-1), false, 'before the first point: nothing to join')
  assert.equal(inGap(Infinity), false, 'live: the whole path, no step after it')
})

test('pathRuns: a gap is more than GAP_S and more than GAP_NM; exactly either is not one', () => {
  // Exactly 60 s, 5 nm on.
  assert.deepEqual(short(pathRuns([pt(0, 0, 30_000), pt(60, 5, 30_000)], Infinity)), [{ gap: false, color: 300, t: [0, 60] }])
  // 90 s, exactly 2 nm on: a pair distanceNm puts 2 nm apart to the last bit (along a meridian no pair lands on it).
  const a = { ...pt(0, 0, 30_000), lat: 32, lon: 34 }
  const b = { ...pt(90, 0, 30_000), lat: 32.02355509527381, lon: 34.02777745276302 }
  assert.equal(distanceNm(a.lat, a.lon, b.lat, b.lon), GAP_NM)
  assert.deepEqual(short(pathRuns([a, b], Infinity)), [{ gap: false, color: 300, t: [0, 90] }])
  // Just over both.
  assert.equal(pathRuns([pt(0, 0, 30_000), pt(60.001, 2.1, 30_000)], Infinity)[1]?.gap, true)
})

test('groundHeights: a ground run stands on the ground read once at its first point on it, + PATH_LIFT_M', () => {
  // Landing: the ground run starts at the last point in the air (shared), which keeps its own height.
  const runs = pathRuns([pt(0, 0, 900), pt(4, 0.3, 300), pt(8, 0.6, 'g'), pt(12, 0.8, 'g'), pt(16, 0.9, 'g')], Infinity)
  const reads: number[] = []
  const lifted = groundHeights(runs, (p) => (reads.push(p.tMs / 1000), 60))
  assert.deepEqual(reads, [8], 'one read, at the first point on the ground')
  assert.deepEqual([...lifted].map(([p, h]) => [p.tMs / 1000, h]), [[8, 60 + PATH_LIFT_M], [12, 60 + PATH_LIFT_M], [16, 60 + PATH_LIFT_M]])
  assert.equal(PATH_LIFT_M, 3)
})

test('groundHeights: take-off keeps the ground run\'s height (no second read); past a gap a ground run reads its own; unloaded ground stays unlifted', () => {
  // Taxi, take-off, climb, a hole, then heard on the ground again where the tiles are not loaded yet.
  const pts = [pt(0, 0, 'g'), pt(10, 0.05, 'g'), pt(20, 0.5, 400), pt(30, 1.2, 1_200), pt(400, 80, 'g'), pt(410, 80.05, 'g')]
  const reads: number[] = []
  const lifted = groundHeights(pathRuns(pts, Infinity), (p) => (reads.push(p.tMs / 1000), p.tMs < 100_000 ? 40 : undefined))
  assert.deepEqual(reads, [0, 400])
  assert.deepEqual([...lifted].map(([p, h]) => [p.tMs / 1000, h]), [[0, 40 + PATH_LIFT_M], [10, 40 + PATH_LIFT_M]])
})

test('groundHeights: a lone point on the ground after a gap, carried on by a climb, is lifted too', () => {
  const pts = [pt(0, 0, 3_000), pt(200, 30, 'g'), pt(210, 30.5, 400)]
  const lifted = groundHeights(pathRuns(pts, Infinity), () => 25)
  assert.deepEqual([...lifted].map(([p, h]) => [p.tMs / 1000, h]), [[200, 25 + PATH_LIFT_M]])
})

test('pathRuns: the points after cutMs are left out (one at cutMs stays)', () => {
  const pts = [0, 10, 20, 30, 40, 50].map((t, i) => pt(t, i, 12_000))
  assert.deepEqual(short(pathRuns(pts, 25_000)), [{ gap: false, color: 120, t: [0, 10, 20] }])
  assert.deepEqual(short(pathRuns(pts, 30_000)), [{ gap: false, color: 120, t: [0, 10, 20, 30] }])
  assert.deepEqual(short(pathRuns(pts, Infinity)), [{ gap: false, color: 120, t: [0, 10, 20, 30, 40, 50] }])
})

test('pathRuns: on the ground is a band of its own (not 0 ft, not 40,000 ft and above)', () => {
  // Taxi, take-off, climb.
  const runs = pathRuns([pt(0, 0, 'g'), pt(10, 0.05, 'g'), pt(20, 0.3, 'g'), pt(30, 0.8, 300), pt(40, 1.5, 900), pt(50, 2.3, 1_400)], Infinity)
  assert.deepEqual(short(runs), [
    { gap: false, color: GROUND_INDEX, t: [0, 10, 20] },
    { gap: false, color: 0, t: [20, 30, 40] },
    { gap: false, color: 10, t: [40, 50] },
  ])
  assertJoined(runs)
  // GROUND_INDEX / 10 rounds down to the 40,000 ft band: it must not join it.
  assert.deepEqual(short(pathRuns([pt(0, 0, 41_000), pt(10, 0, 41_000), pt(20, 0, 'g')], Infinity)).map((r) => r.color), [400, GROUND_INDEX])
})

test('pathRuns: an unknown altitude is a band of its own (light grey, as the icons draw it)', () => {
  const runs = pathRuns([pt(0, 0, 40_500), pt(10, 1, 40_500), pt(20, 2, null), pt(30, 3, null), pt(40, 4, 40_500), pt(50, 5, 40_500)], Infinity)
  assert.deepEqual(short(runs), [
    { gap: false, color: 400, t: [0, 10] },
    { gap: false, color: UNKNOWN_INDEX, t: [10, 20, 30] },
    { gap: false, color: 400, t: [30, 40, 50] },
  ])
})

test('indexRgba: a run is drawn in the icons\' colour of its band\'s floor, ground and unknown as the icons', () => {
  const rgba = () => ({ red: 0, green: 0, blue: 0, alpha: 0 })
  assert.deepEqual(indexRgba(370, rgba()), altitudeRgba(37_000, false, rgba()))
  assert.deepEqual(indexRgba(0, rgba()), altitudeRgba(0, false, rgba()))
  assert.deepEqual(indexRgba(GROUND_INDEX, rgba()), altitudeRgba(null, true, rgba()))
  assert.deepEqual(indexRgba(UNKNOWN_INDEX, rgba()), altitudeRgba(null, false, rgba()))
})

test('arc: a gap\'s line follows the great circle (a chord across an ocean runs under the globe), its height even end to end', () => {
  const a = { lat: 40, lon: -50, hM: 11_000 } // heard last mid-Atlantic at FL360…
  const b = { lat: 50, lon: -20, hM: 10_400 } // …and next 1,400 nm on
  const pos = arc(a, b)
  const ref = greatCircle(a, b)
  assert.equal(pos.length, ref.length)
  const c = new Cartographic()
  for (let i = 0; i < pos.length; i++) {
    Cartographic.fromCartesian(pos[i], undefined, c)
    assert.ok(Math.abs((c.latitude * 180) / Math.PI - ref[i].lat) < 1e-6 && Math.abs((c.longitude * 180) / Math.PI - ref[i].lon) < 1e-6, `point ${i} on the great circle`)
    assert.ok(Math.abs(c.height - (a.hM + ((b.hM - a.hM) * i) / (pos.length - 1))) < 0.01, `point ${i}: height in proportion`)
    if (i === 0) continue
    // The straight bit Cesium draws between two of them stays up there.
    Cartographic.fromCartesian(Cartesian3.midpoint(pos[i - 1], pos[i], new Cartesian3()), undefined, c)
    assert.ok(c.height > 10_400 - 50, `segment ${i} sags ${10_400 - c.height} m below the lower end`)
  }
  assert.equal(arc(a, { lat: 40.05, lon: -50, hM: 11_000 }).length, 2, 'a short one: its two ends')
})

test('countUpTo: how many points in time order are at or before the cut', () => {
  const pts = [{ tMs: 10 }, { tMs: 20 }, { tMs: 30 }]
  assert.equal(countUpTo([], Infinity), 0)
  assert.equal(countUpTo(pts, 5), 0)
  assert.equal(countUpTo(pts, 10), 1)
  assert.equal(countUpTo(pts, 25), 2)
  assert.equal(countUpTo(pts, 30), 3)
  assert.equal(countUpTo(pts, Infinity), 3)
})

test('decimate: both ends, and between them a point at least minNm from the last one kept', () => {
  const pts = [0, 0.1, 0.2, 0.35, 0.5, 0.7, 0.75].map((nm, i) => pt(i, nm, 20_000))
  assert.deepEqual(decimate(pts, 0.3).map((p) => p.tMs / 1000), [0, 3, 5, 6])
  assert.deepEqual(decimate(pts.slice(0, 2), 0.3), pts.slice(0, 2), 'two points: both ends')
  assert.deepEqual(decimate([pt(0, 0, 'g'), pt(1, 0, 'g'), pt(2, 0, 'g')], 0.3).map((p) => p.tMs / 1000), [0, 2], 'parked: its ends')
})

test('firstHeardText: local time, 24 h, HH:MM', () => {
  assert.equal(firstHeardText(new Date(2026, 8, 30, 17, 13, 59).getTime()), 'First heard 17:13')
  assert.equal(firstHeardText(new Date(2026, 8, 30, 7, 5).getTime()), 'First heard 07:05')
  assert.equal(firstHeardText(new Date(2026, 8, 30, 0, 0).getTime()), 'First heard 00:00')
})

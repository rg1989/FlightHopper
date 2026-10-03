// shared/landing.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bearingDeg, destination, distanceNm } from './geo.ts'
import { Runways, landingEnd, landingPose, type LandingEnd, type LastHeard, type RunwayTable } from './landing.ts'

const NM = 1852
// A runway of 2,000 m at 350 ft, landed on heading 303° true (Saint John's 32 is close to it).
const END: LandingEnd = { airport: 'CYSJ', name: 'Saint John Airport', ident: '32', thrLat: 45.31, thrLon: -65.88, hdgDeg: 303, elevFt: 350, lengthM: 2000 }
/** A place `m` metres along the landing direction from the threshold (negative: on the approach) and `rightM` beside it. */
function at(end: LandingEnd, m: number, rightM = 0): { lat: number; lon: number } {
  const p = destination(end.thrLat, end.thrLon, end.hdgDeg, m / NM)
  return destination(p.lat, p.lon, end.hdgDeg + 90, rightM / NM)
}
/** On a 3° path to the aiming point (300 m in), `outM` metres before the threshold, at 62 kt along the runway. */
const onFinal = (outM: number, o: Partial<LastHeard> = {}): LastHeard => ({
  ...at(END, -outM), altMslFt: END.elevFt + ((outM + 300) * Math.tan((3 * Math.PI) / 180)) / 0.3048, trackDeg: 303, gsKt: 62, vsFpm: -330, ...o,
})
const metres = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): number => distanceNm(a.lat, a.lon, b.lat, b.lon) * NM

test('landingEnd: an aircraft on final, a mile out on a 3° path, was landing on that runway', () => {
  assert.equal(landingEnd(onFinal(1852), [END]), END)
  assert.equal(landingEnd(onFinal(1852, { vsFpm: null }), [END]), END, 'no vertical rate known')
  assert.equal(landingEnd(onFinal(1852, { trackDeg: 290 }), [END]), END, 'crabbing 13° into the wind')
  assert.equal(landingEnd(onFinal(6 * 1852 - 10), [END]), END, 'six miles out')
  assert.equal(landingEnd({ ...at(END, 200), altMslFt: END.elevFt + 20, trackDeg: 303, gsKt: 60, vsFpm: -200 }, [END]), END, 'over the runway, 20 ft up')
  assert.equal(landingEnd(onFinal(1852, { altMslFt: END.elevFt - 250 }), [END]), END, 'an altimeter 250 ft low')
})

test('landingEnd: not a landing: off the centreline, across it, too high, climbing, hovering, fast, too far out, or past the runway', () => {
  const far = onFinal(1852)
  assert.equal(landingEnd({ ...far, ...at(END, -1852, 400) }, [END]), null, '400 m beside it a mile out (the cone is 230 m there)')
  assert.equal(landingEnd({ ...far, trackDeg: 303 + 21 }, [END]), null, '21° across it')
  assert.equal(landingEnd({ ...far, trackDeg: 123 }, [END]), null, 'flying the other way')
  assert.equal(landingEnd({ ...far, altMslFt: END.elevFt + 1100 }, [END]), null, '1,100 ft at a mile: above a 6° path and 300 ft')
  assert.equal(landingEnd({ ...onFinal(5 * 1852), altMslFt: END.elevFt + 2600 }, [END]), null, 'over 2,500 ft')
  assert.equal(landingEnd({ ...far, vsFpm: 301 }, [END]), null, 'climbing')
  assert.equal(landingEnd({ ...far, gsKt: 29 }, [END]), null, 'hovering')
  assert.equal(landingEnd({ ...far, gsKt: 251 }, [END]), null, 'fast')
  assert.equal(landingEnd(onFinal(6 * 1852 + 10), [END]), null, 'over six miles out')
  assert.equal(landingEnd({ ...at(END, 1300), altMslFt: END.elevFt + 20, trackDeg: 303, gsKt: 60, vsFpm: 0 }, [END]), null, 'in the air past 60 % of the runway')
  assert.equal(landingEnd({ ...far, altMslFt: END.elevFt - 301 }, [END]), null, '301 ft under the runway')
  assert.equal(landingEnd(far, []), null, 'no runway near')
})

test('landingEnd: of two parallel runways, the one whose centreline it was nearer; never the opposite direction', () => {
  const left = { ...END, ident: '32L' }
  const right = { ...END, ident: '32R', ...((p) => ({ thrLat: p.lat, thrLon: p.lon }))(at(END, 0, 150)) }
  const back = { ...END, ident: '14', hdgDeg: 123, ...((p) => ({ thrLat: p.lat, thrLon: p.lon }))(at(END, 2000)) }
  assert.equal(landingEnd({ ...onFinal(1852), ...at(END, -1852, 110) }, [left, right, back])?.ident, '32R')
  assert.equal(landingEnd({ ...onFinal(1852), ...at(END, -1852, 40) }, [right, back, left])?.ident, '32L')
})

test('landingPose: from where it was heard, down its path to the aiming point 300 m in, at its ground speed', () => {
  const last = onFinal(1852)
  const start = landingPose(last, END, 0)
  assert.ok(metres(start, last) < 0.5, 'it starts where it was heard')
  assert.deepEqual([Math.round(start.aboveFt), start.gsKt, start.onGround, start.stopped], [Math.round(last.altMslFt - END.elevFt), 62, false, false])
  const t1 = (1852 + 300) / (62 * (1852 / 3600)) // 67.5 s to the touchdown
  const half = landingPose(last, END, t1 / 2)
  assert.ok(Math.abs(half.aboveFt - (last.altMslFt - END.elevFt) / 2) < 0.5, 'half-way down half-way there')
  assert.ok(Math.abs(metres(half, at(END, -776)) ) < 1, 'on the centreline')
  assert.ok(Math.abs(half.vsFpm - -330) < 5, 'about −330 fpm: a 3° path at 62 kt')
  assert.ok(Math.abs(half.headingDeg - 303) < 0.1)
  const before = landingPose(last, END, t1 - 0.01)
  const after = landingPose(last, END, t1 + 0.01)
  assert.deepEqual([before.onGround, after.onGround], [false, true])
  assert.ok(metres(before, after) < 1 && before.aboveFt < 0.1, 'it meets the runway where it touches down')
  assert.ok(metres(after, at(END, 300)) < 1, 'at the aiming point')
})

test('landingPose: on the runway it brakes at 1.8 m/s² along the centreline and stops; later it is still there', () => {
  const last = onFinal(1852)
  const v = 62 * (1852 / 3600)
  const t1 = (1852 + 300) / v
  const mid = landingPose(last, END, t1 + 5)
  assert.ok(Math.abs(mid.gsKt * (1852 / 3600) - (v - 1.8 * 5)) < 0.01)
  assert.deepEqual([mid.onGround, mid.stopped, mid.aboveFt, mid.vsFpm, mid.headingDeg], [true, false, 0, 0, 303])
  const end = landingPose(last, END, t1 + v / 1.8)
  const stopAt = 300 + (v * v) / (2 * 1.8) // 583 m in
  assert.deepEqual([end.gsKt, end.stopped], [0, true])
  assert.ok(metres(end, at(END, stopAt)) < 1)
  assert.deepEqual(landingPose(last, END, 28 * 60), end, '28 min later')
})

test('landingPose: a runway too short for 1.8 m/s² is braked on harder: it stops 60 m before the far end', () => {
  const short = { ...END, lengthM: 900 }
  const jet = { ...onFinal(1852), gsKt: 140 } // 72 m/s: 1,440 m at 1.8 m/s²
  const stop = landingPose(jet, short, 3600)
  assert.equal(stop.stopped, true)
  assert.ok(metres(stop, at(short, 840)) < 1)
})

test('landingPose: heard close in and high for the aiming point, it touches down further along, on a 6° path', () => {
  const last = { ...at(END, 100), altMslFt: END.elevFt + 100, trackDeg: 303, gsKt: 62, vsFpm: -300 } // 100 ft up, 100 m in
  assert.equal(landingEnd(last, [END]), END)
  const down = 100 + (100 * 0.3048) / Math.tan((6 * Math.PI) / 180) // 390 m in
  const t1 = (down - 100) / (62 * (1852 / 3600))
  assert.ok(metres(landingPose(last, END, t1 + 0.001), at(END, down)) < 1)
})

test('landingPose: heard beside the centreline, it flies to it: straight at the touchdown', () => {
  const last = { ...onFinal(1852), ...at(END, -1852, 100) }
  const p = landingPose(last, END, 30)
  const to = at(END, 300)
  assert.ok(Math.abs(p.headingDeg - bearingDeg(p.lat, p.lon, to.lat, to.lon)) < 0.01)
  assert.ok(Math.abs(p.headingDeg - 303) < 3)
})

test('Runways: both landing directions of each runway near a place, with their thresholds, headings and lengths', () => {
  const far = at(END, 2000)
  const table: RunwayTable = {
    airports: [['CYSJ', 'Saint John Airport'], ['KSFO', 'San Francisco International Airport']],
    runways: [
      [0, '32', END.thrLat, END.thrLon, 350, 0, '14', far.lat, far.lon, 357, 500],
      [1, '28R', 37.6135, -122.3571, 13, 300, '10L', 37.6287, -122.3932, 13, 0],
    ],
  }
  const rw = new Runways(table)
  const ends = rw.near(45.3, -65.9)
  assert.deepEqual(ends.map((e) => [e.airport, e.ident]), [['CYSJ', '32'], ['CYSJ', '14']])
  const [a, b] = ends
  assert.deepEqual([a.name, a.elevFt, b.elevFt], ['Saint John Airport', 350, 357])
  assert.ok(Math.abs(a.hdgDeg - 303) < 0.05 && Math.abs(b.hdgDeg - 123) < 0.05)
  assert.ok(Math.abs(a.lengthM - 2000) < 1, 'from its threshold to the far end')
  assert.ok(Math.abs(b.lengthM - (2000 - 500 * 0.3048)) < 1, 'a threshold 500 ft in leaves that much less')
  assert.ok(metres({ lat: b.thrLat, lon: b.thrLon }, at(END, 2000 - 500 * 0.3048)) < 1, 'the displaced threshold')
  assert.deepEqual(rw.near(46.9, -64.1).length, 2, 'from the next degree cell')
  assert.deepEqual(rw.near(48, -65.9), [], 'two cells away')
  assert.equal(landingEnd(onFinal(1852), rw.near(45.3, -65.9))?.ident, '32')
})

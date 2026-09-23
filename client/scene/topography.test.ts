// client/scene/topography.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Airport } from '../../shared/airports.ts'
import { destination } from '../../shared/geo.ts'
import { TOPO_ON, drawnHeightM, smoothstep } from './exaggeration.ts'
import { HERO_RELH_KM, NUDGE, NUDGE_DELAY_MS, TOPO_ANIM_MS, Topography, groundMemo, pickRelHM } from './topography.ts'

const heroes: Airport[] = JSON.parse(readFileSync(new URL('../../public/airports/heroes.json', import.meta.url), 'utf8'))
const hero = (ident: string): Airport => heroes.find((a) => a.ident === ident)!
const [LOWI, KSFO, LLBG] = [hero('LOWI'), hero('KSFO'), hero('LLBG')]
const LOWI_RWY = 627.72 // mean of the runway 08 and 26 threshold heights, HAE (629.72, 625.72)
const NORDKETTE = 2_317.9 // true HAE of a point high on the ridge north of LOWI
const KM_PER_NM = 1.852
const RAD = Math.PI / 180
const RIDGE = { latitude: 47.3104 * RAD, longitude: 11.3787 * RAD } // where a memo is read: radians, as a Cartographic

function near(actual: number | null, expected: number, tol: number): void {
  assert.ok(actual !== null && Math.abs(actual - expected) <= tol, `${actual} ≠ ${expected} ± ${tol}`)
}

/** The two Scene fields Topography owns, recording every write (Cesium's debug build throws on a non-finite one). */
function fakeScene() {
  const writes: number[] = []
  let f = 1 // Cesium's defaults
  let rel = 0
  return {
    writes,
    get verticalExaggeration(): number { return f },
    set verticalExaggeration(v: number) { writes.push(v); f = v },
    get verticalExaggerationRelativeHeight(): number { return rel },
    set verticalExaggerationRelativeHeight(v: number) { writes.push(v); rel = v },
  }
}

test('constructor sets the factor at once: TOPO_ON (never exactly 1) or 0 (flat), around relH 0', () => {
  const s = fakeScene()
  const topo = new Topography(s, true)
  assert.equal(s.verticalExaggeration, TOPO_ON)
  assert.equal(s.verticalExaggerationRelativeHeight, 0)
  assert.deepEqual([topo.on, topo.animating, topo.relHM], [true, false, 0])
  const flat = fakeScene()
  const off = new Topography(flat, false)
  assert.equal(flat.verticalExaggeration, 0)
  assert.equal(off.on, false)
  assert.deepEqual({ ...off.update(0) }, { fSampled: 0, fNow: 0, relHM: 0 })
  assert.equal(TOPO_ANIM_MS, 2500)
})

test('a flatten: smoothstep over 2.5 s around the latched relH, exactly 0 at the end; fSampled is the previous fNow', () => {
  const s = fakeScene()
  const topo = new Topography(s, true)
  const idle = topo.update(0)
  topo.set(false, 1_000, LOWI_RWY)
  assert.deepEqual([topo.on, topo.animating, topo.relHM], [false, true, LOWI_RWY])
  let prev = TOPO_ON
  for (const t of [1_000, 1_625, 2_250, 2_875, 3_499]) {
    const fr = topo.update(t)
    assert.equal(fr, idle, 'one reused object')
    assert.equal(fr.fSampled, prev)
    near(fr.fNow, TOPO_ON * (1 - smoothstep((t - 1_000) / TOPO_ANIM_MS)), 1e-12)
    assert.equal(fr.relHM, LOWI_RWY)
    assert.equal(s.verticalExaggeration, fr.fNow)
    assert.equal(s.verticalExaggerationRelativeHeight, LOWI_RWY)
    prev = fr.fNow
  }
  assert.ok(prev > 0 && prev < 1e-6, `${prev}`)
  const end = topo.update(3_500)
  assert.deepEqual([end.fSampled, end.fNow, topo.animating], [prev, 0, false])
})

test('the nudge: 0.5 s after an animation ends the factor gains 1e-7, once (the TerrainPicker race)', () => {
  assert.deepEqual([NUDGE, NUDGE_DELAY_MS], [1e-7, 500])
  const s = fakeScene()
  const topo = new Topography(s, true)
  topo.set(false, 0, LOWI_RWY)
  assert.equal(topo.update(2_500).fNow, 0)
  assert.equal(topo.update(2_999).fNow, 0)
  const nudged = topo.update(3_000)
  assert.deepEqual([nudged.fSampled, nudged.fNow], [0, NUDGE])
  for (const t of [3_001, 4_000, 60_000]) assert.equal(topo.update(t).fNow, NUDGE)
  // Growing back ends exactly on TOPO_ON, around the same plane, and is nudged the same way.
  topo.set(true, 70_000, 5)
  assert.equal(topo.relHM, LOWI_RWY, 'growing never moves relH')
  assert.equal(topo.update(72_499).relHM, LOWI_RWY)
  assert.equal(topo.update(72_500).fNow, TOPO_ON)
  assert.equal(topo.update(72_999).fNow, TOPO_ON)
  assert.equal(topo.update(73_000).fNow, TOPO_ON + NUDGE)
  assert.equal(topo.update(90_000).fNow, TOPO_ON + NUDGE)
  assert.equal(s.verticalExaggeration, TOPO_ON + NUDGE)
})

test('set is a no-op when unchanged; a new animation cancels a pending nudge', () => {
  const s = fakeScene()
  const topo = new Topography(s, true)
  topo.set(true, 0, 999)
  assert.deepEqual({ ...topo.update(10) }, { fSampled: TOPO_ON, fNow: TOPO_ON, relHM: 0 })
  topo.set(false, 100, LOWI_RWY)
  topo.set(false, 1_100, 700) // T again while sinking: nothing restarts, the plane stays
  near(topo.update(1_350).fNow, TOPO_ON / 2, 1e-12)
  assert.equal(topo.relHM, LOWI_RWY)
  assert.equal(topo.update(2_600).fNow, 0)
  topo.set(true, 2_700, 0) // before the nudge due at 3,100
  near(topo.update(3_100).fNow, TOPO_ON * smoothstep(400 / TOPO_ANIM_MS), 1e-15)
  assert.equal(topo.update(5_200).fNow, TOPO_ON)
  assert.equal(topo.update(5_700).fNow, TOPO_ON + NUDGE)
})

test('a reversal mid-animation continues from the current factor and keeps relH', () => {
  const topo = new Topography(fakeScene(), true)
  topo.set(false, 0, LOWI_RWY)
  const half = topo.update(1_250).fNow
  near(half, TOPO_ON / 2, 1e-12)
  topo.set(true, 1_250, 5_000)
  assert.deepEqual([topo.on, topo.animating, topo.relHM], [true, true, LOWI_RWY])
  assert.equal(topo.update(1_250).fNow, half, 'no jump')
  near(topo.update(2_500).fNow, half + (TOPO_ON - half) / 2, 1e-12)
  assert.equal(topo.update(3_750).fNow, TOPO_ON)
  // Reversing a grow keeps the plane too.
  const flat = new Topography(fakeScene(), false)
  flat.relatch(LOWI_RWY)
  flat.set(true, 0, 1)
  const partial = flat.update(1_000).fNow
  flat.set(false, 1_000, 42)
  assert.equal(flat.relHM, LOWI_RWY)
  assert.equal(flat.update(1_000).fNow, partial)
  assert.equal(flat.update(3_500).fNow, 0)
})

test('relatch: only while fully flat and idle; it moves the plane and re-arms the pickers 0.5 s later', () => {
  const s = fakeScene()
  const topo = new Topography(s, true)
  topo.relatch(LOWI_RWY) // on: ignored
  assert.equal(topo.update(0).relHM, 0)
  topo.set(false, 0, 100)
  topo.relatch(LOWI_RWY) // sinking: ignored
  assert.equal(topo.update(2_500).relHM, 100)
  assert.equal(topo.update(3_000).fNow, NUDGE)
  topo.relatch(LOWI_RWY) // a new selection while flat
  assert.equal(topo.relHM, LOWI_RWY)
  const fr = topo.update(4_000)
  assert.deepEqual([fr.fNow, fr.relHM, s.verticalExaggerationRelativeHeight], [NUDGE, LOWI_RWY, LOWI_RWY])
  assert.equal(topo.update(4_499).fNow, NUDGE)
  assert.equal(topo.update(4_500).fNow, 0, 'the re-arm flips the nudge back: the factor never creeps')
  assert.equal(topo.update(9_000).fNow, 0)
  topo.relatch(Number.NaN)
  topo.relatch(Number.POSITIVE_INFINITY)
  assert.equal(topo.relHM, LOWI_RWY)
  topo.relatch(LOWI_RWY) // unchanged: nothing to re-arm
  assert.equal(topo.update(10_000).fNow, 0)
  assert.equal(topo.update(20_000).fNow, 0)
  topo.set(true, 30_000, 0)
  topo.relatch(1) // growing: ignored
  assert.equal(topo.update(31_000).relHM, LOWI_RWY)
  topo.update(40_000)
  topo.relatch(2) // on: ignored
  assert.equal(topo.update(41_000).relHM, LOWI_RWY)
})

test('never writes a non-finite value: a NaN relH is ignored, a NaN clock ends the animation on its end value', () => {
  const s = fakeScene()
  const topo = new Topography(s, true)
  topo.set(false, 0, Number.NaN)
  assert.equal(topo.relHM, 0)
  assert.ok(topo.update(1_000).fNow > 0)
  assert.equal(topo.update(Number.NaN).fNow, 0)
  assert.equal(topo.animating, false)
  topo.set(true, Number.NaN, 0)
  assert.equal(topo.update(5_000).fNow, TOPO_ON)
  topo.set(false, 6_000, Number.POSITIVE_INFINITY)
  topo.update(7_000)
  assert.equal(topo.relHM, 0)
  assert.ok(s.writes.length > 0 && s.writes.every(Number.isFinite), `${s.writes}`)
})

test('ground: undefined → null; a globe.getHeight reading → the ground drawn this frame', () => {
  const topo = new Topography(fakeScene(), true)
  assert.equal(topo.ground(undefined, { fSampled: 1, fNow: 1, relHM: 0 }), null)
  topo.set(false, 0, LOWI_RWY)
  topo.update(0)
  for (const t of [600, 1_250, 1_900]) {
    const fr = topo.update(t)
    const sampled = drawnHeightM(NORDKETTE, fr.fSampled, fr.relHM) // what the tiles held when getHeight ran
    near(topo.ground(sampled, fr), drawnHeightM(NORDKETTE, fr.fNow, fr.relHM), 1e-9)
  }
  // Flat: the plane, whatever the picker's few-cm error.
  assert.equal(topo.ground(LOWI_RWY - 0.03, { fSampled: NUDGE, fNow: NUDGE, relHM: LOWI_RWY }), LOWI_RWY)
})

test('ground with a memo: undefined readings (the picker race) follow the grow from the last one; no memo → null', () => {
  const topo = new Topography(fakeScene(), false)
  topo.relatch(LOWI_RWY)
  topo.set(true, 0, 0)
  const memo = groundMemo()
  assert.equal(topo.ground(undefined, topo.update(0), memo, RIDGE), null, 'nothing read yet')
  topo.update(600)
  let fr = topo.update(616)
  near(topo.ground(drawnHeightM(NORDKETTE, fr.fSampled, LOWI_RWY), fr, memo, RIDGE), drawnHeightM(NORDKETTE, fr.fNow, LOWI_RWY), 1e-9)
  // Gate GE: runs of up to 37 undefined frames inside the animation and nudge windows. A fixed point's drawn height
  // follows the factor, so the memo stays exact through the grow, its end and the nudge.
  for (let t = 632; t <= 3_200; t += 16) {
    fr = topo.update(t)
    near(topo.ground(undefined, fr, memo, RIDGE), drawnHeightM(NORDKETTE, fr.fNow, LOWI_RWY), 1e-9)
    assert.equal(topo.ground(undefined, fr), null, 'no memo: null, as before')
  }
  assert.equal(fr.fNow, TOPO_ON + NUDGE)
})

test('ground with a memo: a new plane (relH) drops it, the next reading refills it, ok = false forgets it', () => {
  const topo = new Topography(fakeScene(), true)
  const memo = groundMemo()
  near(topo.ground(NORDKETTE, topo.update(0), memo, RIDGE), NORDKETTE, 1e-9) // on, at rest, around relH 0
  topo.set(false, 100, LOWI_RWY) // the flatten latches LOWI's runway height
  let fr = topo.update(116)
  assert.equal(topo.ground(undefined, fr, memo, RIDGE), null, 'read around the old plane')
  topo.update(1_000)
  fr = topo.update(1_016)
  topo.ground(drawnHeightM(NORDKETTE, fr.fSampled, LOWI_RWY), fr, memo, RIDGE)
  for (const t of [1_032, 2_000, 2_600, 3_100]) { // through the end of the sink (relH) and the nudge (1e-7)
    fr = topo.update(t)
    near(topo.ground(undefined, fr, memo, RIDGE), drawnHeightM(NORDKETTE, fr.fNow, LOWI_RWY), 1e-9)
  }
  assert.equal(fr.fNow, NUDGE)
  memo.ok = false // a new selection
  assert.equal(topo.ground(undefined, fr, memo, RIDGE), null)
})

test('ground with a memo: a flat reading holds no relief: the plane while flat, null once the relief grows', () => {
  const topo = new Topography(fakeScene(), false)
  topo.relatch(LOWI_RWY)
  const memo = groundMemo()
  let fr = topo.update(0)
  assert.equal(topo.ground(LOWI_RWY - 0.03, fr, memo, RIDGE), LOWI_RWY) // read while flat: the last one before any grow
  assert.equal(topo.ground(undefined, topo.update(1_000), memo, RIDGE), LOWI_RWY, 'still flat (the nudge): the plane')
  topo.set(true, 2_000, 0)
  assert.equal(topo.ground(undefined, topo.update(2_000), memo, RIDGE), LOWI_RWY, "the grow's first frame is still flat")
  // Gate GE's longest run, 37 frames: the relief is unknown. relH would be 239 m low under the Nordkette by the last.
  for (let t = 2_016; t <= 2_592; t += 16) assert.equal(topo.ground(undefined, topo.update(t), memo, RIDGE), null, `${t}`)
  fr = topo.update(2_608) // the next reading refills the memo, which follows the grow again
  near(topo.ground(drawnHeightM(NORDKETTE, fr.fSampled, LOWI_RWY), fr, memo, RIDGE), drawnHeightM(NORDKETTE, fr.fNow, LOWI_RWY), 1e-9)
  fr = topo.update(2_624)
  near(topo.ground(undefined, fr, memo, RIDGE), drawnHeightM(NORDKETTE, fr.fNow, LOWI_RWY), 1e-9)
})

test('ground with a memo: it answers only within 50 m of where it was read (the chase camera reads several points)', () => {
  // ChaseCamera reads the ground once per clearance pass. At its default 150 m range it starts 147 m south of a
  // northbound aircraft; over the valley approach's slope (chaseCamera.test.ts) it ends almost above it, and the next
  // frame starts again 147 m south. One memo serves all of these points.
  const south = (m: number, eastM = 0) => {
    const s = destination(LOWI.lat, LOWI.lon, 180, m / 1000 / KM_PER_NM)
    const p = destination(s.lat, s.lon, 90, eastM / 1000 / KM_PER_NM)
    return { latitude: p.lat * RAD, longitude: p.lon * RAD }
  }
  const slope = (m: number): number => 990 + 3 * m // the terrain m metres south
  const topo = new Topography(fakeScene(), true)
  const memo = groundMemo()
  let fr = topo.update(0)
  near(topo.ground(slope(147), fr, memo, south(147)), slope(147), 1e-9) // the first pass
  near(topo.ground(slope(3), fr, memo, south(3)), slope(3), 1e-9) // the last pass: the camera is now clear
  fr = topo.update(16) // the picker race: every reading undefined
  assert.equal(topo.ground(undefined, fr, memo, south(147)), null, 'the first pass: 144 m from the reading')
  near(topo.ground(undefined, fr, memo, south(52)), slope(3), 1e-9) // 49 m
  near(topo.ground(undefined, fr, memo, south(3, 40)), slope(3), 1e-9) // 40 m east: the orbit swings round
  assert.equal(topo.ground(undefined, fr, memo, south(54)), null, '51 m')
  assert.equal(topo.ground(undefined, fr, memo), null, 'no point: the memo is not used')
  // The first pass reads, the second does not: the first pass's ground is not the second's.
  topo.ground(slope(147), fr, memo, south(147))
  assert.equal(topo.ground(undefined, fr, memo, south(3)), null)
  topo.ground(slope(3), fr, memo, south(3))
  topo.ground(slope(147), fr, memo) // a reading without its point leaves the memo alone
  near(topo.ground(undefined, fr, memo, south(3)), slope(3), 1e-9)
})

test('pickRelHM: within 30 km of a hero → the mean of its runway threshold heights (HAE)', () => {
  assert.equal(HERO_RELH_KM, 30)
  const ridge = destination(LOWI.lat, LOWI.lon, 0, 6 / KM_PER_NM) // the harness circle's northern point
  near(pickRelHM(ridge.lat, ridge.lon, 2_100, heroes), LOWI_RWY, 1e-9)
  near(pickRelHM(KSFO.lat, KSFO.lon, -32, heroes), -29.3175, 1e-9) // below the ellipsoid
  near(pickRelHM(LLBG.lat, LLBG.lon, null, heroes), 56.57, 1e-9)
  const inside = destination(LOWI.lat, LOWI.lon, 90, 29.9 / KM_PER_NM)
  near(pickRelHM(inside.lat, inside.lon, 900, heroes), LOWI_RWY, 1e-9)
  const outside = destination(LOWI.lat, LOWI.lon, 90, 30.1 / KM_PER_NM)
  assert.equal(pickRelHM(outside.lat, outside.lon, 900, heroes), 900)
})

test('pickRelHM elsewhere: the drawn ground under the aircraft, else 0 (the ellipsoid); never NaN', () => {
  const EDDM = { lat: 48.3538, lon: 11.7861 } // Munich: 125 km from LOWI, no hero
  assert.equal(pickRelHM(EDDM.lat, EDDM.lon, 493.2, heroes), 493.2)
  assert.equal(pickRelHM(EDDM.lat, EDDM.lon, null, heroes), 0)
  assert.equal(pickRelHM(EDDM.lat, EDDM.lon, Number.NaN, heroes), 0)
  assert.equal(pickRelHM(Number.NaN, Number.NaN, 493.2, heroes), 493.2)
  assert.equal(pickRelHM(LOWI.lat, LOWI.lon, 600, []), 600)
})

test('pickRelHM: the nearest airport wins; one without runways is skipped', () => {
  const at = (km: number) => destination(LOWI.lat, LOWI.lon, 90, km / KM_PER_NM)
  const [e0, e1] = LOWI.runways[0].ends
  const east: Airport = { ...LOWI, ident: 'XEST', ...at(20), runways: [{ ...LOWI.runways[0], ends: [{ ...e0, thrHaeM: 700 }, { ...e1, thrHaeM: 710 }] }] }
  const heliport: Airport = { ...LOWI, ident: 'XHEL', ...at(14), runways: [] }
  const list = [...heroes, east, heliport]
  near(pickRelHM(at(15).lat, at(15).lon, null, list), 705, 1e-9)
  near(pickRelHM(at(5).lat, at(5).lon, null, list), LOWI_RWY, 1e-9)
})

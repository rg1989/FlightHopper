// client/scenario/pose.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bearingDeg, destination } from '../../shared/geo.ts'
import { geoidN } from '../../shared/geoid.ts'
import type { RenderState } from '../types.ts'
import { PoseTrack } from './pose.ts'
import type { TrackRow } from './types.ts'

const FT = 0.3048
const ZERO_N = { geoid: (): number => 0 }

const row = (p: Partial<TrackRow> & { t: number }): TrackRow => ({
  lat: 35,
  lon: 139,
  altFt: 10000,
  hdg: 90,
  pitch: 0,
  roll: 0,
  gnd: false,
  iasKt: null,
  gsKt: null,
  vsFpm: null,
  g: null,
  windFromDeg: null,
  windKt: null,
  epr: null,
  q: null,
  src: null,
  ...p,
})

const near = (a: number | null | undefined, b: number, tol: number, msg = ''): void =>
  assert.ok(typeof a === 'number' && Math.abs(a - b) <= tol, `${msg} got ${a}, expected ${b} ± ${tol}`)
const wrap360 = (d: number): number => ((d % 360) + 360) % 360
const angDiff = (a: number, b: number): number => wrap360(a - b + 180) - 180

/** A straight 1-Hz track at `kt` along `course` from (35.5, 139.5): positions on the same sphere as shared/geo.ts. */
function straight(kt: number, course: number, n: number, climbFpm = 0): TrackRow[] {
  return Array.from({ length: n }, (_, t) => {
    const p = destination(35.5, 139.5, course, (kt * t) / 3600)
    return row({ t, lat: p.lat, lon: p.lon, altFt: 10000 + (climbFpm * t) / 60, hdg: course })
  })
}

// Irregular rows, every channel moving, the heading crossing north.
const T = [0, 1, 2, 2.5, 3.5, 6, 7, 8, 12, 13]
const VARIED = T.map((t, k) =>
  row({
    t,
    lat: 35 + 0.002 * k + 0.0005 * Math.sin(k),
    lon: 139 + 0.003 * k,
    altFt: 8000 + 300 * Math.sin(k),
    hdg: wrap360(350 + 7 * k),
    pitch: 5 * Math.cos(k),
    roll: 30 * Math.sin(1.3 * k),
  }),
)

type Ch = [name: string, fromState: (s: RenderState) => number, fromRow: (r: TrackRow) => number, angle: boolean]
const CHANNELS: Ch[] = [
  ['lat', (s) => s.lat, (r) => r.lat, false],
  ['lon', (s) => s.lon, (r) => r.lon, false],
  ['alt', (s) => s.altBaroFt!, (r) => r.altFt, false],
  ['hM', (s) => s.hM, (r) => r.altFt * FT, false],
  ['hdg', (s) => s.headingDeg, (r) => r.hdg, true],
  ['pitch', (s) => s.pitchDeg, (r) => r.pitch, false],
  ['roll', (s) => s.rollDeg, (r) => r.roll, false],
]
const diff = (a: number, b: number, angle: boolean): number => (angle ? angDiff(a, b) : a - b)

// ---------- exact at the rows ----------

test('exact at row times: pose, speeds and the optional scalars are the row values', () => {
  const rows = [
    row({ t: 100, lat: 35.1, lon: 139.2, altFt: 500, hdg: 359, pitch: 2, roll: -3, gnd: true, iasKt: 120, gsKt: 118, vsFpm: 0, g: 1, windFromDeg: 350, windKt: 12, epr: [1.2, 1.3, 1.25, 1.4], q: 'A' }),
    row({ t: 101, lat: 35.1005, lon: 139.2012, altFt: 520, hdg: 2, pitch: 8, roll: 1, gnd: false, iasKt: 150, gsKt: 148, vsFpm: 1200, g: 1.2, windFromDeg: 10, windKt: 14, epr: [1.5, 1.5, 1.5, 1.5], q: 'M' }),
    row({ t: 103.5, lat: 35.102, lon: 139.204, altFt: 610, hdg: 5, pitch: 12, roll: 6, iasKt: 165, gsKt: 160, vsFpm: 2400, g: 1.1, windFromDeg: 20, windKt: 15, epr: [1.6, 1.6, 1.6, 1.6], q: 'R' }),
    row({ t: 104, lat: 35.1025, lon: 139.205, altFt: 640, hdg: 7, pitch: 13, roll: 7, iasKt: 170, gsKt: 164, vsFpm: 2500, g: 1.05, windFromDeg: 25, windKt: 16, epr: [1.6, 1.6, 1.6, 1.6], q: 'R' }),
  ]
  const p = new PoseTrack(rows, ZERO_N)
  for (const r of rows) {
    const s = { ...p.stateAt(r.t) }
    near(s.lat, r.lat, 1e-12, `lat@${r.t}`)
    near(s.lon, r.lon, 1e-12, `lon@${r.t}`)
    near(s.altBaroFt, r.altFt, 1e-9, `alt@${r.t}`)
    near(s.hM, r.altFt * FT, 1e-9, `hM@${r.t}`)
    near(angDiff(s.headingDeg, r.hdg), 0, 1e-9, `hdg@${r.t}`)
    near(s.pitchDeg, r.pitch, 1e-12, `pitch@${r.t}`)
    near(s.rollDeg, r.roll, 1e-12, `roll@${r.t}`)
    near(s.gsKt, r.gsKt!, 1e-12, `gs@${r.t}`)
    near(s.vsFpm, r.vsFpm!, 1e-12, `vs@${r.t}`)
    assert.equal(s.onGround, r.gnd, `gnd@${r.t}`)
    const d = p.dataAt(r.t)
    near(d.altFt, r.altFt, 1e-9)
    near(d.iasKt, r.iasKt!, 1e-12, `ias@${r.t}`)
    near(d.gsKt, r.gsKt!, 1e-12)
    near(d.vsFpm, r.vsFpm!, 1e-12)
    near(d.g, r.g!, 1e-12, `g@${r.t}`)
    near(angDiff(d.windFromDeg!, r.windFromDeg!), 0, 1e-9, `wind dir@${r.t}`)
    near(d.windKt, r.windKt!, 1e-12, `wind kt@${r.t}`)
    assert.deepEqual(d.epr, r.epr, `epr@${r.t}`)
    near(d.pitchDeg, r.pitch, 1e-12)
    near(d.rollDeg, r.roll, 1e-12)
    near(angDiff(d.hdgDeg!, r.hdg), 0, 1e-9)
  }
})

// ---------- continuity ----------

test('continuous: at every row the left and right limits are within 1e-6 of the row value', () => {
  const p = new PoseTrack(VARIED, ZERO_N)
  for (const r of VARIED.slice(1, -1)) {
    for (const eps of [-1e-9, 1e-9]) {
      const s = p.stateAt(r.t + eps)
      for (const [name, fromState, fromRow, angle] of CHANNELS) {
        near(diff(fromState(s), fromRow(r), angle), 0, 1e-6, `${name} at ${r.t}${eps < 0 ? '−' : '+'}`)
      }
    }
  }
})

test('continuous: a 1 ms sweep over irregular rows never jumps (each step within 4× the steepest row-to-row rate)', () => {
  const p = new PoseTrack(VARIED, ZERO_N)
  const step = 1e-3
  for (const [name, fromState, fromRow, angle] of CHANNELS) {
    let maxRate = 0
    for (let k = 1; k < VARIED.length; k++) {
      const a = VARIED[k - 1]
      const b = VARIED[k]
      maxRate = Math.max(maxRate, Math.abs(diff(fromRow(b), fromRow(a), angle)) / (b.t - a.t))
    }
    const bound = 4 * maxRate * step + 1e-9
    let prev = fromState(p.stateAt(0))
    for (let i = 1; i <= 13 / step; i++) {
      const cur = fromState(p.stateAt(i * step))
      const d = Math.abs(diff(cur, prev, angle))
      assert.ok(d <= bound, `${name} jumps ${d} at t=${i * step} (bound ${bound})`)
      prev = cur
    }
  }
})

// ---------- heading ----------

test('heading across 359 → 1 goes through 0, not 180, and stays in [0, 360)', () => {
  const rows = [355, 357, 359, 1, 3, 5].map((hdg, t) => row({ t, hdg }))
  const p = new PoseTrack(rows, ZERO_N)
  near(angDiff(p.stateAt(2.5).headingDeg, 0), 0, 0.01, 'midway between 359 and 1')
  for (let t = 0; t <= 5; t += 0.01) {
    const h = p.stateAt(t).headingDeg
    assert.ok(h >= 0 && h < 360, `heading ${h} out of [0, 360) at ${t}`)
    assert.ok(Math.abs(angDiff(h, 0)) <= 5.001, `heading ${h} strays from north at ${t}`)
  }
})

// ---------- Dutch roll ----------

test('a 1-Hz Dutch roll (11 s period, ±40°) keeps ≥ 90 % of its amplitude at mid-row times, within 1 % of the true curve', () => {
  const roll = (t: number): number => 40 * Math.sin((2 * Math.PI * t) / 11)
  const rows = Array.from({ length: 61 }, (_, t) => row({ t, roll: roll(t) }))
  const p = new PoseTrack(rows, ZERO_N)
  let peak = 0
  for (let k = 1; k < 59; k++) {
    const t = k + 0.5
    const r = p.stateAt(t).rollDeg
    near(r, roll(t), 0.4, `roll at ${t}`) // linear interpolation misses by up to 1.6°
    peak = Math.max(peak, Math.abs(r))
  }
  assert.ok(peak >= 0.9 * 40, `peak ${peak} < 90 % of 40°`)
})

// ---------- clamping ----------

test('clamps before start and after end; start and end are the first and last row times', () => {
  const p = new PoseTrack(VARIED, ZERO_N)
  assert.equal(p.start, 0)
  assert.equal(p.end, 13)
  const first = { ...p.stateAt(0) }
  const last = { ...p.stateAt(13) }
  assert.deepEqual({ ...p.stateAt(-500) }, first)
  assert.deepEqual({ ...p.stateAt(Number.NEGATIVE_INFINITY) }, first)
  assert.deepEqual({ ...p.stateAt(1e9) }, last)
  assert.deepEqual({ ...p.stateAt(Number.NaN) }, first)
  near(last.lat, VARIED[VARIED.length - 1].lat, 1e-12)
  assert.deepEqual(p.dataAt(-5), p.dataAt(0))
})

// ---------- speeds from the path ----------

test('gsKt derived for a 1-Hz straight track at 300 kt within 0.5 kt; track along the course; marked derived', () => {
  const rows = straight(300, 60, 61)
  const p = new PoseTrack(rows, ZERO_N)
  for (const t of [3, 10, 10.25, 10.5, 30.7, 57]) {
    const s = { ...p.stateAt(t) }
    const ahead = { ...p.stateAt(t + 0.1) }
    near(s.gsKt, 300, 0.5, `gs at ${t}`)
    near(angDiff(s.trackDeg!, bearingDeg(s.lat, s.lon, ahead.lat, ahead.lon)), 0, 0.05, `track at ${t}`)
    near(s.vsFpm, 0, 1e-6, `vs at ${t}`)
  }
  const d = p.dataAt(20)
  near(d.gsKt, 300, 0.5)
  assert.ok(d.derived.has('gsKt') && d.derived.has('trackDeg') && d.derived.has('vsFpm'), [...d.derived].join())
})

test('vsFpm derived from a steady 1500 fpm climb', () => {
  const p = new PoseTrack(straight(250, 200, 31, 1500), ZERO_N)
  for (const t of [2, 9.5, 15.2, 28]) near(p.stateAt(t).vsFpm, 1500, 1, `vs at ${t}`)
})

test('irregular rows: a constant rate is reproduced (knots at the row times), so the derived speed does not jump', () => {
  // lat linear in time at 200 kt due north, rows 10 s apart, then 1 s, then 8 s, then 1 s
  const degPerS = 200 / 3600 / 60
  const rows = [0, 10, 11, 12, 20, 21, 22].map((t) => row({ t, lat: 35 + degPerS * t, hdg: 0 }))
  const p = new PoseTrack(rows, ZERO_N)
  for (const t of [10.5, 11, 11.5, 12, 15, 19.5, 20.5]) {
    near(p.stateAt(t).lat, 35 + degPerS * t, 1e-10, `lat at ${t}`)
    near(p.stateAt(t).gsKt, 200, 0.5, `gs at ${t}`)
  }
})

test('ends: the end row counts as duplicated, so a steady track eases out of the first row and into the last', () => {
  // Hermite with end tangent = half the chord slope: at mid-interval the first segment has covered 7/16 of it.
  const rows = [0, 1, 2, 3].map((t) => row({ t, lat: 35 + 0.001 * t }))
  const p = new PoseTrack(rows, ZERO_N)
  near(p.stateAt(0.5).lat, 35 + 0.001 * 0.4375, 1e-12, 'first segment')
  near(p.stateAt(2.5).lat, 35 + 0.001 * (3 - 0.4375), 1e-12, 'last segment')
  near(p.stateAt(1.5).lat, 35 + 0.001 * 1.5, 1e-12, 'inner segment: straight')
})

test('row gsKt and vsFpm are used (linear between rows) and not marked derived; track still is', () => {
  const rows = straight(300, 90, 5).map((r, k) => ({ ...r, gsKt: 280 + 10 * k, vsFpm: -1000 * k }))
  const p = new PoseTrack(rows, ZERO_N)
  near(p.stateAt(1.5).gsKt, 295, 1e-9)
  near(p.stateAt(1.5).vsFpm, -1500, 1e-9)
  const d = p.dataAt(2.25)
  near(d.gsKt, 302.5, 1e-9)
  near(d.vsFpm, -2250, 1e-9)
  assert.ok(!d.derived.has('gsKt') && !d.derived.has('vsFpm'))
  assert.ok(d.derived.has('trackDeg'))
})

test('at rest the derived speed is 0 and the track is the heading', () => {
  const rows = [0, 1, 2, 3].map((t) => row({ t, hdg: 123, gnd: true }))
  const s = new PoseTrack(rows, ZERO_N).stateAt(1.5)
  near(s.gsKt, 0, 1e-9)
  near(s.trackDeg, 123, 1e-9)
})

// ---------- ground ----------

test('onGround follows gnd of the row at or before t', () => {
  const rows = [true, true, true, false, false].map((gnd, t) => row({ t, gnd }))
  const p = new PoseTrack(rows, ZERO_N)
  assert.equal(p.stateAt(0).onGround, true)
  assert.equal(p.stateAt(2).onGround, true)
  assert.equal(p.stateAt(2.999).onGround, true)
  assert.equal(p.stateAt(3).onGround, false)
  assert.equal(p.stateAt(4).onGround, false)
  const back = new PoseTrack([false, true].map((gnd, t) => row({ t, gnd })), ZERO_N)
  assert.equal(back.stateAt(0.99).onGround, false)
  assert.equal(back.stateAt(1).onGround, true, 'the last row at t = end')
})

// ---------- geoid ----------

test('hM = altFt·0.3048 + the injected geoid', () => {
  const p = new PoseTrack(VARIED, { geoid: () => 37.5 })
  near(p.stateAt(2.5).hM, VARIED[3].altFt * FT + 37.5, 1e-9)
})

test('the default geoid is EGM96 (geoidN)', () => {
  const r = VARIED[4]
  const s = new PoseTrack(VARIED).stateAt(r.t)
  near(s.hM - r.altFt * FT, geoidN(r.lat, r.lon), 1e-9)
})

test('the geoid is read at most every 0.5 km of travel, and again after a seek', () => {
  let calls = 0
  const n = (lat: number, lon: number): number => 30 + (lat - 35) * 10 + (lon - 139)
  const geoid = (lat: number, lon: number): number => (calls++, n(lat, lon))
  const rows = straight(300, 60, 61) // 9.26 km in 60 s
  const p = new PoseTrack(rows, { geoid })
  for (let f = 0; f <= 60 * 60; f++) p.stateAt(f / 60)
  assert.ok(calls >= 18 && calls <= 20, `${calls} geoid reads for 9.26 km`)
  const before = calls
  const s = p.stateAt(0)
  assert.equal(calls, before + 1, 'a seek back 9 km reads it again')
  near(s.hM, rows[0].altFt * FT + n(rows[0].lat, rows[0].lon), 1e-9)
  p.stateAt(0.5) // 77 m on
  assert.equal(calls, before + 1, 'no read within 0.5 km')
})

// ---------- optional scalars ----------

test('optional scalars are linear between rows; wind direction goes through its unit vector', () => {
  const rows = [
    row({ t: 0, iasKt: 250, g: 1, windFromDeg: 350, windKt: 20 }),
    row({ t: 2, iasKt: 260, g: 1.4, windFromDeg: 10, windKt: 30 }),
    row({ t: 3, iasKt: 240, g: 1.2, windFromDeg: 90, windKt: 30 }),
  ]
  const d = new PoseTrack(rows, ZERO_N).dataAt(1)
  near(d.iasKt, 255, 1e-12)
  near(d.g, 1.2, 1e-12)
  near(angDiff(d.windFromDeg!, 0), 0, 1e-9, 'between 350 and 10: north, not south')
  near(d.windKt, 25, 1e-12)
  const e = new PoseTrack(rows, ZERO_N).dataAt(2.5)
  near(e.windFromDeg, 50, 1e-9, 'unit-vector midpoint of 10 and 90')
  assert.ok(d.windFromDeg! >= 0 && d.windFromDeg! < 360)
})

test('a gap in an optional column holds the row at or before t; nothing is shown before the first known row', () => {
  const rows = [
    row({ t: 0, iasKt: null, g: 1.1 }),
    row({ t: 1, iasKt: 200, g: null }),
    row({ t: 2, iasKt: 210, g: null }),
  ]
  const p = new PoseTrack(rows, ZERO_N)
  assert.equal(p.dataAt(0.5).iasKt, null)
  near(p.dataAt(1).iasKt, 200, 0)
  near(p.dataAt(0.5).g, 1.1, 0, 'held into the gap')
  assert.equal(p.dataAt(1).g, null)
  assert.equal(p.dataAt(2).g, null)
  near(p.dataAt(2).iasKt, 210, 0)
})

test('wind is marked derived where the surrounding rows are q=R', () => {
  const rows = ['A', 'R', 'A', 'A'].map((q, t) => row({ t, windFromDeg: 270, windKt: 40, q: q as TrackRow['q'] }))
  const p = new PoseTrack(rows, ZERO_N)
  const derivedWind = (t: number): boolean => {
    const d = p.dataAt(t).derived
    assert.equal(d.has('windFromDeg'), d.has('windKt'))
    return d.has('windKt')
  }
  assert.equal(derivedWind(0), false)
  assert.equal(derivedWind(0.5), true)
  assert.equal(derivedWind(1), true)
  assert.equal(derivedWind(1.5), true)
  assert.equal(derivedWind(2), false)
  assert.equal(derivedWind(2.5), false)
})

test('epr: per-engine linear; an empty cell (NaN) is unknown; no epr columns → null', () => {
  const rows = [row({ t: 0, epr: [1.2, Number.NaN, 1.4] }), row({ t: 1, epr: [1.4, 1.5, Number.NaN] })]
  const epr = new PoseTrack(rows, ZERO_N).dataAt(0.5).epr!
  assert.equal(epr.length, 3)
  near(epr[0], 1.3, 1e-12)
  assert.ok(Number.isNaN(epr[1]), 'unknown at the row before')
  near(epr[2], 1.4, 1e-12, 'held into the gap')
  assert.equal(new PoseTrack(VARIED, ZERO_N).dataAt(3).epr, null)
})

// ---------- RenderState contract ----------

test('RenderState: one reused object; interp, age 0, adsb2, true altitude; hex, callsign and type from opts', () => {
  const p = new PoseTrack(VARIED, ZERO_N)
  const a = p.stateAt(1)
  const copy = { ...a }
  const b = p.stateAt(5)
  assert.equal(a, b, 'the same scratch object')
  assert.notEqual(copy.lat, b.lat, 'a spread copy keeps its values')
  assert.equal(b.hex, 'scn000')
  assert.equal(b.mode, 'interp')
  assert.equal(b.ageS, 0)
  assert.equal(b.quality, 'adsb2')
  assert.equal(b.altSource, 'baro-qnh')
  assert.equal(b.callsign, null)
  assert.equal(b.typeCode, null)
  const q = new PoseTrack(VARIED, { geoid: () => 0, hex: 'jal123', callsign: 'JAL123', typeCode: 'B74S' }).stateAt(1)
  assert.equal(q.hex, 'jal123')
  assert.equal(q.callsign, 'JAL123')
  assert.equal(q.typeCode, 'B74S')
})

test('seeking in any order gives the same pose as fresh tracks (the cached row index never goes stale)', () => {
  const p = new PoseTrack(VARIED, ZERO_N)
  const times = [12.9, 0.3, 7, 6.999, 2.5, 13, 0, 3.49, 3.5, 11.1, 2.49]
  for (const t of times) {
    const got = { ...p.stateAt(t) }
    const want = { ...new PoseTrack(VARIED, ZERO_N).stateAt(t) }
    assert.deepEqual(got, want, `t=${t}`)
    assert.deepEqual(p.dataAt(t), new PoseTrack(VARIED, ZERO_N).dataAt(t), `data t=${t}`)
  }
})

test('a single row: start = end and the pose is that row, at rest', () => {
  const r = row({ t: 50, lat: 36, lon: 138, altFt: 3000, hdg: 45, pitch: 3, roll: 2 })
  const p = new PoseTrack([r], ZERO_N)
  assert.equal(p.start, 50)
  assert.equal(p.end, 50)
  const s = p.stateAt(99)
  near(s.lat, 36, 0)
  near(s.lon, 138, 0)
  near(s.headingDeg, 45, 1e-12)
  near(s.gsKt, 0, 0)
  near(s.vsFpm, 0, 0)
  near(s.trackDeg, 45, 1e-12)
})

test('no rows, or times that do not increase, are refused', () => {
  assert.throws(() => new PoseTrack([]), RangeError)
  assert.throws(() => new PoseTrack([row({ t: 1 }), row({ t: 1 })]), RangeError)
})

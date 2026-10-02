// client/history/feed.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import v8 from 'node:v8'
import vm from 'node:vm'
import type { HistorySlot, HistoryTrack } from '../../shared/api.ts'
import { bearingDeg, destination, distanceNm } from '../../shared/geo.ts'
import { EVERYTHING_NM, SLOT_MS } from '../../shared/history.ts'
import type { Sample } from '../../shared/types.ts'
import { Fleet } from '../browse/fleet.ts'
import { HistoryFeed } from './feed.ts'

const near = (a: number | null, b: number, tol: number, msg = ''): void =>
  assert.ok(a !== null && Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)

// mulberry32: the same numbers on every run.
function prng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let z = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296
  }
}
// A gc() for the memory test, without a command line flag.
v8.setFlagsFromString('--expose-gc')
const gc = vm.runInNewContext('gc') as () => void

const T0 = Date.UTC(2026, 8, 30, 4, 0) // a half hour: 2026-09-30 04:00Z
const T1 = T0 + SLOT_MS // the next one
const T2 = T1 + SLOT_MS
const HOME = { lat: 32, lon: 34.8, nm: 100 } // the circle the slots are held for

type Pt = [t: number, lat: number, lon: number, alt: number | 'g' | null, gs: number | null]
/** A track from rows of [t, lat, lon, alt, gs]. */
function track(hex: string, rows: Pt[], o: Partial<HistoryTrack> = {}): HistoryTrack {
  return {
    hex, callsign: null, squawk: null, type: null, nM: 19.6,
    t: rows.map((r) => r[0]), lat: rows.map((r) => r[1]), lon: rows.map((r) => r[2]),
    alt: rows.map((r) => r[3]), gs: rows.map((r) => r[4]),
    ...o,
  }
}
const slot = (aircraft: HistoryTrack[], slotMs = T0, stepS = 10): HistorySlot => ({ slotMs, stepS, aircraft })
const ids = (ss: Sample[]): string[] => ss.map((s) => `${s.hex}@${(s.tMs - T0) / 1000}`)
const all = [-Infinity, Infinity] as const

// ELY397 flies east for 20 s, then turns right to the south; 0.4 nm every 10 s, climbing 250 ft per 10 s (1,500 fpm).
const P0 = { lat: 32, lon: 34.8 }
const P1 = destination(P0.lat, P0.lon, 90, 0.4)
const P2 = destination(P1.lat, P1.lon, 90, 0.4)
const P3 = destination(P2.lat, P2.lon, 180, 0.4)
const P4 = destination(P3.lat, P3.lon, 180, 0.4)
const ELY = track('a1b2c3', [
  [0, P0.lat, P0.lon, 3000, 150],
  [10, P1.lat, P1.lon, 3250, 150],
  [20, P2.lat, P2.lon, 3500, 150],
  [30, P3.lat, P3.lon, 3750, 150],
  [40, P4.lat, P4.lon, 4000, 150],
], { callsign: 'ELY397', squawk: '7500' })
// An aircraft parked on the apron, heard from the second slice to the fourth.
const GND = track('def456', [
  [10, 32.0094, 34.8895, 'g', 0],
  [20, 32.0094, 34.8895, 'g', 0],
  [30, 32.0094, 34.8895, 'g', 0],
], { squawk: '2000' })

test('a position becomes an ordinary sample: its time, place, altitude and speed, and nothing the files do not know', () => {
  const f = new HistoryFeed()
  f.add(slot([ELY, GND]), HOME)
  const got = f.samplesOf('a1b2c3', T0 - 1, T0)
  assert.equal(got.length, 1)
  assert.deepEqual(got[0], {
    hex: 'a1b2c3', tMs: T0, rxMs: T0, lat: P0.lat, lon: P0.lon, onGround: false,
    altBaroFt: 3000, altGeomFt: null, gsKt: 150, trackDeg: bearingDeg(P0.lat, P0.lon, P1.lat, P1.lon),
    trueHeadingDeg: null, rollDeg: null, baroRateFpm: 1500, geomRateFpm: null, navQnhHpa: null, version: null, nic: null,
    quality: 'adsb2', nM: 19.6, callsign: 'ELY397', typeCode: null, reg: null,
  })
  assert.equal(f.samplesOf('a1b2c3', ...all).at(-1)!.tMs, T0 + 40_000, 'tMs is the slot start plus t seconds')
})

test('take(from, to) covers (from, to]: a sample at from is out, one at to is in', () => {
  const f = new HistoryFeed()
  f.add(slot([ELY, GND]), HOME)
  assert.deepEqual(ids(f.take(T0 + 10_000, T0 + 30_000)), ['a1b2c3@20', 'def456@20', 'a1b2c3@30', 'def456@30'])
  assert.deepEqual(ids(f.take(T0 + 10_000 - 1, T0 + 10_000)), ['a1b2c3@10', 'def456@10'])
  assert.deepEqual(ids(f.take(T0 - 1, T0)), ['a1b2c3@0'])
  assert.deepEqual(ids(f.take(T0 + 40_000, T0 + 50_000)), [], 'the newest sample was at 40 s, and from is exclusive')
})

test('take gives the samples of all aircraft in time order, not aircraft by aircraft', () => {
  const f = new HistoryFeed()
  f.add(slot([ELY, GND]), HOME)
  assert.deepEqual(ids(f.take(...all)), [
    'a1b2c3@0', 'a1b2c3@10', 'def456@10', 'a1b2c3@20', 'def456@20', 'a1b2c3@30', 'def456@30', 'a1b2c3@40',
  ])
})

test('take of a window with nothing in it, or an empty or backwards one, is empty', () => {
  const f = new HistoryFeed()
  assert.deepEqual(f.take(...all), [], 'nothing held')
  f.add(slot([ELY, GND]), HOME)
  assert.deepEqual(f.take(T0 - 5000, T0 - 1000), [], 'before everything')
  assert.deepEqual(f.take(T0 + 41_000, T0 + 99_000), [], 'after everything')
  assert.deepEqual(f.take(T0 + 15_000, T0 + 19_000), [], 'between two slices')
  assert.deepEqual(f.take(T0 + 20_000, T0 + 20_000), [], 'empty')
  assert.deepEqual(f.take(T0 + 30_000, T0 + 10_000), [], 'backwards')
})

test('a window with a bound that is not a number is empty, not everything up to the other bound', () => {
  const f = new HistoryFeed()
  f.add(slot([ELY, GND]), HOME)
  assert.deepEqual(f.take(NaN, T0 + 30_000), [])
  assert.deepEqual(f.take(T0, NaN), [])
  assert.deepEqual(f.samplesOf('a1b2c3', NaN, Infinity), [])
  assert.deepEqual(f.samplesOf('a1b2c3', -Infinity, NaN), [])
})

test('samplesOf gives one aircraft’s samples in the window, in time order; an unknown hex has none', () => {
  const f = new HistoryFeed()
  f.add(slot([ELY, GND]), HOME)
  assert.deepEqual(ids(f.samplesOf('a1b2c3', T0 + 10_000, T0 + 30_000)), ['a1b2c3@20', 'a1b2c3@30'])
  assert.deepEqual(ids(f.samplesOf('def456', ...all)), ['def456@10', 'def456@20', 'def456@30'])
  assert.deepEqual(f.samplesOf('999999', ...all), [])
})

test('trackDeg points at the next point: east is 90, the turn follows, the last point keeps the one before it', () => {
  const f = new HistoryFeed()
  f.add(slot([ELY, GND]), HOME)
  const trk = f.samplesOf('a1b2c3', ...all).map((s) => s.trackDeg)
  near(trk[0], 90, 1e-6, 'east')
  near(trk[1], 90, 1e-6, 'east')
  near(trk[2], 180, 1e-6, 'south after the turn')
  near(trk[3], 180, 1e-6)
  assert.equal(trk[0], bearingDeg(P0.lat, P0.lon, P1.lat, P1.lon), 'the bearing to the next point, as shared/geo.ts')
  assert.equal(trk[4], trk[3], 'the last point has no next: it takes the one before it')
})

test('a step under 0.005 nm has no direction of its own: it keeps the one before it, none at the start', () => {
  const a0 = { lat: 32, lon: 34.8 }
  const a1 = destination(a0.lat, a0.lon, 45, 0.5)
  const a2 = destination(a1.lat, a1.lon, 200, 0.003) // under 0.005 nm
  const a3 = destination(a2.lat, a2.lon, 200, 0.002) // and again: a run of two
  const a4 = destination(a3.lat, a3.lon, 135, 0.5)
  const a5 = destination(a4.lat, a4.lon, 80, 0.007) // over 0.005 nm: it has one, and a heading of its own
  const b0 = { lat: 33, lon: 35 }
  const b1 = destination(b0.lat, b0.lon, 10, 0.001) // the start: parked
  const b2 = destination(b1.lat, b1.lon, 10, 0.002)
  const b3 = destination(b2.lat, b2.lon, 90, 0.5)
  const f = new HistoryFeed()
  f.add(slot([
    track('aaaaaa', [[0, a0.lat, a0.lon, 1000, 100], [10, a1.lat, a1.lon, 1000, 100], [20, a2.lat, a2.lon, 1000, 100],
      [30, a3.lat, a3.lon, 1000, 100], [40, a4.lat, a4.lon, 1000, 100], [50, a5.lat, a5.lon, 1000, 100]]),
    track('bbbbbb', [[0, b0.lat, b0.lon, 1000, 100], [10, b1.lat, b1.lon, 1000, 100], [20, b2.lat, b2.lon, 1000, 100],
      [30, b3.lat, b3.lon, 1000, 100]]),
  ]), HOME)
  const a = f.samplesOf('aaaaaa', ...all).map((s) => s.trackDeg)
  near(a[0], 45, 1e-6)
  assert.equal(a[1], a[0], 'its next is 0.003 nm away: the previous point’s track')
  assert.equal(a[2], a[0], 'a run of two short steps keeps it')
  near(a[3], 135, 1e-6)
  near(a[4], 80, 1e-6, 'the 0.007 nm step has its own bearing')
  assert.equal(a[5], a[4], 'the last')
  const b = f.samplesOf('bbbbbb', ...all).map((s) => s.trackDeg)
  assert.deepEqual(b.slice(0, 2), [null, null], 'nothing before them to take')
  near(b[2], 90, 1e-6)
  assert.equal(b[3], b[2])
})

test('a taxiing aircraft keeps a heading: 15 kt for 10 s is 0.04 nm, far over what counts as a step', () => {
  const g0 = { lat: 32.0094, lon: 34.8895 }
  const g1 = destination(g0.lat, g0.lon, 90, 0.0417)
  const g2 = destination(g1.lat, g1.lon, 135, 0.0417) // turns
  const g3 = destination(g2.lat, g2.lon, 135, 0.0417)
  const f = new HistoryFeed()
  f.add(slot([track('a5a5a5', [
    [0, g0.lat, g0.lon, 'g', 15], [10, g1.lat, g1.lon, 'g', 15],
    [20, g2.lat, g2.lon, 'g', 15], [30, g3.lat, g3.lon, 'g', 15],
  ])]), HOME)
  const trk = f.samplesOf('a5a5a5', ...all).map((s) => s.trackDeg)
  near(trk[0], 90, 1e-6)
  near(trk[1], 135, 1e-6)
  near(trk[2], 135, 1e-6)
  near(trk[3], 135, 1e-6, 'the last point')
})

test('a reported speed stays; a missing one is the distance to the next point over the time; the last has none', () => {
  const d0 = { lat: 32, lon: 34.8 }
  const d1 = destination(d0.lat, d0.lon, 90, 0.5)
  const d2 = destination(d1.lat, d1.lon, 90, 0.5)
  const e0 = { lat: 31, lon: 34.5 }
  const e1 = destination(e0.lat, e0.lon, 0, 1.5) // 1.5 nm in 30 s
  const f = new HistoryFeed()
  f.add(slot([
    track('aaaaaa', [[0, d0.lat, d0.lon, 3000, null], [10, d1.lat, d1.lon, 3000, 100], [20, d2.lat, d2.lon, 3000, null]]),
    track('bbbbbb', [[0, e0.lat, e0.lon, 3000, null], [30, e1.lat, e1.lon, 3000, null]]),
  ]), HOME)
  const a = f.samplesOf('aaaaaa', ...all).map((s) => s.gsKt)
  near(a[0], 180, 1e-6, '0.5 nm in 10 s')
  assert.equal(a[1], 100, 'reported, although the next point says 180')
  assert.equal(a[2], null, 'the last point has no next to measure to')
  near(f.samplesOf('bbbbbb', ...all)[0].gsKt, 180, 1e-6, '1.5 nm in 30 s')
})

test('in the Fleet the newest sample dead-reckons along its segment: half a step on is the midpoint', () => {
  // 0.4 nm in 10 s is 144 kt, the speed the file reports, so the reckoning from a point runs along the line to the next.
  const q0 = { lat: 32, lon: 34.8 }
  const q1 = destination(q0.lat, q0.lon, 90, 0.4)
  const q2 = destination(q1.lat, q1.lon, 180, 0.4) // then south
  const f = new HistoryFeed()
  f.add(slot([track('a1b2c3', [
    [0, q0.lat, q0.lon, 3000, 144], [10, q1.lat, q1.lon, 3000, 144], [20, q2.lat, q2.lon, 3000, 144],
  ])]), HOME)
  for (const [t, from, to] of [[0, q0, q1], [10, q1, q2]] as const) {
    const fleet = new Fleet()
    fleet.ingest(f.take(T0 + t * 1000 - 1, T0 + t * 1000)) // the sample at t, as the replay clock passes it
    const [e] = fleet.entries(T0 + t * 1000 + 5000) // 5 s on
    near(distanceNm(e.lat, e.lon, from.lat, from.lon), 0.2, 1e-6, `from ${t}`)
    near(distanceNm(e.lat, e.lon, to.lat, to.lon), 0.2, 1e-6, `to the next, from ${t}`)
  }
})

test('baroRateFpm is the climb to the next point per minute: 1,000 ft in 60 s is 1,000 fpm', () => {
  const f = new HistoryFeed()
  f.add(slot([
    track('aaaaaa', [[0, 32, 34.8, 5000, 200], [60, 32, 34.9, 6000, 200], [120, 32, 35, 4800, 200]]),
    track('bbbbbb', [[0, 32, 34.8, 1000, 200], [120, 32, 34.9, 2000, 200], [250, 32, 35, 3300, 200]]),
  ]), HOME)
  assert.deepEqual(f.samplesOf('aaaaaa', ...all).map((s) => s.baroRateFpm), [1000, -1200, null])
  assert.deepEqual(f.samplesOf('bbbbbb', ...all).map((s) => s.baroRateFpm), [500, null, null],
    '1,000 ft in 120 s counts; 130 s is too long a step to call it a rate')
  assert.deepEqual(f.samplesOf('aaaaaa', ...all).map((s) => s.altGeomFt), [null, null, null])
})

test('baroRateFpm is null unless both altitudes are numbers', () => {
  const f = new HistoryFeed()
  f.add(slot([
    track('aaaaaa', [[0, 32, 34.8, 500, 100], [10, 32, 34.8, 'g', 100], [20, 32, 34.8, 'g', 100], [30, 32, 34.8, 400, 100]]),
    track('bbbbbb', [[0, 32, 34.8, 500, 100], [10, 32, 34.8, null, 100], [20, 32, 34.8, 700, 100]]),
  ]), HOME)
  assert.deepEqual(f.samplesOf('aaaaaa', ...all).map((s) => s.baroRateFpm), [null, null, null, null],
    'landing, on the ground, taking off')
  assert.deepEqual(f.samplesOf('bbbbbb', ...all).map((s) => s.baroRateFpm), [null, null, null], 'an unknown altitude')
})

test('on the ground: onGround and no barometric altitude; an unknown altitude is neither', () => {
  const f = new HistoryFeed()
  f.add(slot([GND, track('bbbbbb', [[0, 32, 34.8, null, 100], [10, 32, 34.8, 25, 100]])]), HOME)
  for (const s of f.samplesOf('def456', ...all)) {
    assert.equal(s.onGround, true)
    assert.equal(s.altBaroFt, null)
    assert.equal(s.gsKt, 0)
    assert.equal(s.trackDeg, null, 'parked: no direction')
  }
  const [unknown, low] = f.samplesOf('bbbbbb', ...all)
  assert.equal(unknown.onGround, false)
  assert.equal(unknown.altBaroFt, null)
  assert.equal(low.onGround, false)
  assert.equal(low.altBaroFt, 25)
})

test('info is what the files know of an aircraft: its callsign and squawk, nothing more', () => {
  const f = new HistoryFeed()
  f.add(slot([ELY, GND]), HOME)
  assert.deepEqual(f.info('a1b2c3'), {
    hex: 'a1b2c3', callsign: 'ELY397', reg: null, typeCode: null, category: null, squawk: '7500',
    emergency: null, military: false, route: null,
  })
  assert.deepEqual(f.info('def456'), {
    hex: 'def456', callsign: null, reg: null, typeCode: null, category: null, squawk: '2000',
    emergency: null, military: false, route: null,
  })
  assert.equal(f.info('999999'), null)
})

test('info takes the newest held slot’s callsign and squawk, each from an older slot when the newer has none', () => {
  const row: Pt[] = [[0, 32, 34.8, 1000, 100], [10, 32, 34.81, 1000, 100]]
  const f = new HistoryFeed()
  // The newer slot goes in first: the order of adding must not matter.
  f.add(slot([track('a1b2c3', row, { callsign: 'NEW2', squawk: null })], T1), HOME)
  f.add(slot([track('a1b2c3', row, { callsign: 'OLD1', squawk: '7000' })], T0), HOME)
  const i = f.info('a1b2c3')!
  assert.equal(i.callsign, 'NEW2')
  assert.equal(i.squawk, '7000')
})

test('info gives the type the server knows: the newest held slot’s, whatever order the slots were added in; null when none has one', () => {
  const row: Pt[] = [[0, 32, 34.8, 1000, 100], [10, 32, 34.81, 1000, 100]]
  const f = new HistoryFeed()
  f.add(slot([track('a1b2c3', row, { type: 'A20N' }), track('def456', row)], T1), HOME) // the newer slot first
  f.add(slot([track('a1b2c3', row, { type: 'A320' }), track('def456', row)], T0), HOME)
  assert.equal(f.info('a1b2c3')!.typeCode, 'A20N', 'the newest wins')
  assert.equal(f.info('def456')!.typeCode, null, 'no slot knows it')
  assert.equal(f.info('def456')!.callsign, null, 'and nothing else changed with it')
})

test('info’s type comes from an older slot when the newer one has none (an address the table lacked then), though it has the rest', () => {
  const row: Pt[] = [[0, 32, 34.8, 1000, 100], [10, 32, 34.81, 1000, 100]]
  const f = new HistoryFeed()
  f.add(slot([track('a1b2c3', row, { type: 'B738', callsign: 'OLD1', squawk: '7000' })], T0), HOME)
  f.add(slot([track('a1b2c3', row, { type: null, callsign: 'NEW2', squawk: '2000' })], T1), HOME)
  const i = f.info('a1b2c3')!
  assert.deepEqual([i.typeCode, i.callsign, i.squawk], ['B738', 'NEW2', '2000'], 'each from the newest slot that has one')
})

test('a track from a server older than the type field has no type: null, not undefined', () => {
  const old = { ...track('a1b2c3', [[0, 32, 34.8, 1000, 100]]), type: undefined } as unknown as HistoryTrack
  const f = new HistoryFeed()
  f.add(slot([old]), HOME)
  assert.equal(f.info('a1b2c3')!.typeCode, null)
})

test('covers: a slot held for a circle covers a circle that lies wholly inside it', () => {
  const f = new HistoryFeed()
  f.add(slot([]), HOME) // 32, 34.8, 100 nm
  const covers = (lat: number, lon: number, nm: number, slotMs = T0): boolean => f.covers(slotMs, { lat, lon, nm })
  assert.equal(covers(32, 34.8, 100), true, 'the same circle')
  assert.equal(covers(32, 34.8, 40), true, 'a smaller one, same centre')
  assert.equal(covers(32.8, 34.8, 40), true, 'a smaller one off to the side: 48 nm out, its edge reaches 88')
  assert.equal(covers(32.98, 34.8, 40), true, 'its edge reaches 99 of 100')
  assert.equal(covers(33.02, 34.8, 40), false, 'its edge reaches 101 of 100: it spills out')
  assert.equal(covers(33.4, 34.8, 40), false, 'its centre is inside (84 nm out) but its edge is not')
  assert.equal(covers(32, 34.8, 101), false, 'wider')
  assert.equal(covers(34, 34.8, 40), false, 'its centre is 120 nm out')
  assert.equal(covers(32, 34.8, 100, T1), false, 'a slot that is not held')
})

test('covers also needs slices as fine as the view wants: a wide fetch does not serve a zoomed-in view', () => {
  const f = new HistoryFeed()
  const here = { lat: 32, lon: 34.8 }
  f.add(slot([], T0, 30), { ...here, nm: 800 }) // a wide fetch: 30 s slices
  assert.equal(f.covers(T0, { ...here, nm: 800 }), true, 'what it was fetched for')
  assert.equal(f.covers(T0, { ...here, nm: 301 }), true, 'a view that still wants 30 s slices')
  assert.equal(f.covers(T0, { ...here, nm: 300 }), false, 'a view that wants 10 s slices')
  assert.equal(f.covers(T0, { ...here, nm: 100 }), false, 'zoomed in, well inside the circle: ask again for finer slices')
  f.add(slot([], T0, 10), { ...here, nm: 800 }) // finer slices than the view needs are fine
  assert.equal(f.covers(T0, { ...here, nm: 100 }), true)
  assert.equal(f.covers(T0, { ...here, nm: 800 }), true)
})

test('covers: a circle of EVERYTHING_NM holds the whole world (the server keeps every position), any centre', () => {
  const f = new HistoryFeed()
  f.add(slot([], T0, 300), { lat: 0, lon: 0, nm: EVERYTHING_NM })
  assert.equal(f.covers(T0, { lat: 0, lon: 0, nm: EVERYTHING_NM }), true)
  assert.equal(f.covers(T0, { lat: -33, lon: 151, nm: EVERYTHING_NM }), true, 'the widest view, panned across the earth')
  assert.equal(f.covers(T0, { lat: -33, lon: 151, nm: 3000 }), true)
  assert.equal(f.covers(T0, { lat: -33, lon: 151, nm: 2500 }), false, 'but it wants 60 s slices, not 300 s')
  f.add(slot([], T0, 300), { lat: 0, lon: 0, nm: EVERYTHING_NM - 1 })
  assert.equal(f.covers(T0, { lat: -33, lon: 151, nm: 3000 }), false, 'one nm less: a circle like any other (8,200 nm away)')
})

test('an aircraft with no positions in the slot is not held at all', () => {
  const f = new HistoryFeed()
  f.add(slot([track('eeeeee', [], { callsign: 'GHOST1', squawk: '7700' }), ELY]), HOME)
  assert.equal(f.info('eeeeee'), null)
  assert.deepEqual(f.samplesOf('eeeeee', ...all), [])
  assert.equal(f.info('a1b2c3')!.callsign, 'ELY397', 'the others are held')
  assert.equal(f.take(...all).length, 5)
})

test('has says which half hours are held, including one with no aircraft in it', () => {
  const f = new HistoryFeed()
  assert.equal(f.has(T0), false)
  f.add(slot([]), HOME)
  assert.equal(f.has(T0), true)
  assert.equal(f.has(T1), false)
  assert.deepEqual(f.take(...all), [])
})

test('adding a slot again replaces what was held for that half hour, circle and all', () => {
  const f = new HistoryFeed()
  f.add(slot([ELY, GND]), HOME)
  const other = track('bbbbbb', [[0, 33, 35, 1000, 100], [10, 33, 35.01, 1000, 100]], { callsign: 'NEW1' })
  f.add(slot([other]), { lat: 33, lon: 35, nm: 50 })
  assert.deepEqual(ids(f.take(...all)), ['bbbbbb@0', 'bbbbbb@10'])
  assert.equal(f.info('a1b2c3'), null)
  assert.equal(f.info('bbbbbb')!.callsign, 'NEW1')
  assert.equal(f.covers(T0, HOME), false, 'the new circle is the smaller one')
  assert.equal(f.covers(T0, { lat: 33, lon: 35, nm: 50 }), true)
})

test('slots do not derive anything from each other: the last point of a half hour ignores the first of the next', () => {
  const x0 = { lat: 32, lon: 34.8 }
  const x1 = destination(x0.lat, x0.lon, 90, 0.4)
  const y0 = { lat: 40, lon: 10 } // far away, 10 s later
  const y1 = destination(y0.lat, y0.lon, 45, 0.4)
  const f = new HistoryFeed()
  f.add(slot([track('a1b2c3', [[1780, x0.lat, x0.lon, 1000, null], [1790, x1.lat, x1.lon, 1500, null]])], T0), HOME)
  f.add(slot([track('a1b2c3', [[0, y0.lat, y0.lon, 5000, null], [10, y1.lat, y1.lon, 5000, null]])], T1), HOME)
  const [, last] = f.samplesOf('a1b2c3', T0, T1 - 1)
  assert.equal(last.tMs, T1 - 10_000)
  near(last.trackDeg, 90, 1e-6, 'the one before it, not towards the next half hour')
  assert.equal(last.gsKt, null, 'no gs reported and no next point in its own slot')
  assert.equal(last.baroRateFpm, null)
  const [first] = f.samplesOf('a1b2c3', T1 - 1, T1)
  near(first.trackDeg, 45, 1e-6, 'its own next point')
  near(first.gsKt, 144, 1e-6, '0.4 nm in 10 s')
})

test('take and samplesOf run on across two half hours, in time order, whichever was added first', () => {
  const row = (t0: number): Pt[] => [[t0, 32, 34.8, 1000, 100], [t0 + 10, 32, 34.81, 1000, 100]]
  for (const order of [[T0, T1], [T1, T0]]) {
    const f = new HistoryFeed()
    for (const ms of order) {
      const rows = ms === T0 ? row(1780) : row(0)
      f.add(slot([track('a1b2c3', rows), track('def456', rows)], ms), HOME)
    }
    const across = f.take(T1 - 10_001, T1 + 10_000).map((s) => `${s.hex}@${s.tMs - T1}`)
    assert.deepEqual(across, ['a1b2c3@-10000', 'def456@-10000', 'a1b2c3@0', 'def456@0', 'a1b2c3@10000', 'def456@10000'])
    assert.deepEqual(f.samplesOf('def456', T1 - 20_001, T1 + 5000).map((s) => s.tMs - T1), [-20_000, -10_000, 0])
  }
})

test('retain drops every half hour not in the set; clear drops all', () => {
  const at = (ms: number, hex: string): HistorySlot =>
    slot([track(hex, [[0, 32, 34.8, 1000, 100], [10, 32, 34.81, 1000, 100]], { callsign: hex.toUpperCase() })], ms)
  const f = new HistoryFeed()
  f.add(at(T0, 'aaaaaa'), HOME)
  f.add(at(T1, 'bbbbbb'), HOME)
  f.add(at(T2, 'cccccc'), HOME)
  f.retain(new Set([T1, T2 + SLOT_MS])) // a slot that is not held does no harm
  assert.deepEqual([f.has(T0), f.has(T1), f.has(T2)], [false, true, false])
  assert.deepEqual(f.take(...all).map((s) => s.hex), ['bbbbbb', 'bbbbbb'])
  assert.deepEqual(f.samplesOf('aaaaaa', ...all), [])
  assert.equal(f.info('aaaaaa'), null)
  assert.equal(f.covers(T0, HOME), false)
  assert.equal(f.info('bbbbbb')!.callsign, 'BBBBBB')
  f.clear()
  assert.deepEqual([f.has(T0), f.has(T1), f.has(T2)], [false, false, false])
  assert.deepEqual(f.take(...all), [])
  assert.equal(f.info('bbbbbb'), null)
})

test('take and samplesOf agree with a scan of everything over random windows (several aircraft, two half hours)', () => {
  const rnd = prng(12345)
  const hexes = Array.from({ length: 40 }, (_, i) => (0xa00000 + i * 977).toString(16))
  const f = new HistoryFeed()
  const truth: { hex: string; tMs: number; order: number }[] = []
  let order = 0
  for (const slotMs of [T0, T1]) {
    const aircraft = hexes.map((hex) => {
      const first = Math.floor(rnd() * 100) * 10 // heard from some slice on, for some slices
      const n = 1 + Math.floor(rnd() * 80)
      const rows: Pt[] = Array.from({ length: n }, (_, i) => [first + i * 10, 32 + i * 0.001, 34.8, 2000 + i * 10, 150])
      for (const r of rows) truth.push({ hex, tMs: slotMs + r[0] * 1000, order: order++ })
      return track(hex, rows)
    })
    f.add(slot(aircraft, slotMs), HOME)
  }
  const want = (from: number, to: number, hex?: string): string[] =>
    truth.filter((x) => x.tMs > from && x.tMs <= to && (hex === undefined || x.hex === hex))
      .sort((a, b) => a.tMs - b.tMs || a.order - b.order).map((x) => `${x.hex}@${x.tMs}`)
  const got = (ss: Sample[]): string[] => ss.map((s) => `${s.hex}@${s.tMs}`)
  for (let k = 0; k < 300; k++) {
    const from = T0 - 60_000 + Math.floor(rnd() * (2 * SLOT_MS + 120_000))
    const to = from + Math.floor(rnd() * (k % 3 === 0 ? 3_000_000 : 40_000)) // some wide, mostly a frame or a second
    assert.deepEqual(got(f.take(from, to)), want(from, to), `take(${from - T0}, ${to - T0})`)
    const hex = hexes[Math.floor(rnd() * hexes.length)]
    assert.deepEqual(got(f.samplesOf(hex, from, to)), want(from, to, hex), `samplesOf ${hex}`)
  }
})

// The derivation rules written out plainly, all at once and per position: what the feed must give, however it builds it.
function reference(slotMs: number, tr: HistoryTrack): Sample[] {
  const n = tr.t.length
  const stepNm = (i: number): number => distanceNm(tr.lat[i], tr.lon[i], tr.lat[i + 1], tr.lon[i + 1])
  const out: Sample[] = []
  let direction: number | null = null // of the latest step that has one
  for (let i = 0; i < n; i++) {
    const hasNext = i + 1 < n
    const dt = hasNext ? tr.t[i + 1] - tr.t[i] : NaN
    if (hasNext && stepNm(i) >= 0.005) direction = bearingDeg(tr.lat[i], tr.lon[i], tr.lat[i + 1], tr.lon[i + 1])
    const alt = tr.alt[i]
    const next = hasNext ? tr.alt[i + 1] : null
    const tMs = slotMs + tr.t[i] * 1000
    out.push({
      hex: tr.hex, tMs, rxMs: tMs, lat: tr.lat[i], lon: tr.lon[i], onGround: alt === 'g',
      altBaroFt: typeof alt === 'number' ? alt : null, altGeomFt: null,
      gsKt: tr.gs[i] ?? (dt > 0 ? (stepNm(i) / dt) * 3600 : null), trackDeg: direction,
      trueHeadingDeg: null, rollDeg: null,
      baroRateFpm:
        typeof alt === 'number' && typeof next === 'number' && dt > 0 && dt <= 120 ? ((next - alt) * 60) / dt : null,
      geomRateFpm: null, navQnhHpa: null, version: null, nic: null, quality: 'adsb2', nM: tr.nM, callsign: tr.callsign,
      typeCode: null, reg: null,
    })
  }
  return out
}

/** A track with the awkward things: stops (short and long), slow taxiing, gaps, ground and unknown altitudes, no speed. */
function randomTrack(rnd: () => number, hex: string): HistoryTrack {
  const n = 1 + Math.floor(rnd() * 200)
  const stopFrom = rnd() < 0.25 ? Math.floor(rnd() * n) : Infinity // a long stop of 60 steps from here
  let pos = { lat: 30 + rnd() * 10, lon: 10 + rnd() * 20 }
  let t = Math.floor(rnd() * 100) * 10
  const rows: Pt[] = []
  for (let i = 0; i < n; i++) {
    const a = rnd()
    const alt = a < 0.12 ? 'g' : a < 0.2 ? null : 25 * Math.floor(rnd() * 1600)
    rows.push([t, pos.lat, pos.lon, alt, rnd() < 0.2 ? null : Math.round(rnd() * 5000) / 10])
    const k = rnd()
    const stopped = (i >= stopFrom && i < stopFrom + 60) || k < 0.15
    const nm = stopped ? rnd() * 0.004 : k < 0.3 ? 0.005 + rnd() * 0.045 : 0.1 + rnd() * 0.5
    pos = destination(pos.lat, pos.lon, rnd() * 360, nm)
    t += [10, 10, 10, 10, 20, 30, 60, 90, 120, 121, 130, 300][Math.floor(rnd() * 12)]
  }
  return track(hex, rows, { callsign: `TST${hex}`, squawk: '1200', nM: Math.round(rnd() * 500) / 10 })
}

test('the samples built on demand are those of the plain all-at-once derivation, over random tracks', () => {
  const rnd = prng(2026)
  const tracks = Array.from({ length: 80 }, (_, i) => randomTrack(rnd, (0xb00000 + i * 7919).toString(16)))
  const f = new HistoryFeed()
  f.add(slot(tracks), HOME)
  let positions = 0
  for (const tr of tracks) {
    const want = reference(T0, tr)
    const got = f.samplesOf(tr.hex, ...all)
    assert.equal(got.length, want.length, `${tr.hex}: how many samples`)
    positions += want.length
    for (let i = 0; i < want.length; i++) {
      assert.deepEqual(Object.keys(got[i]).sort(), Object.keys(want[i]).sort(), `${tr.hex}[${i}]: the fields`)
      for (const k of Object.keys(want[i]) as (keyof Sample)[]) {
        const a = got[i][k]
        const b = want[i][k]
        if (typeof a === 'number' && typeof b === 'number') {
          assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${tr.hex}[${i}].${k}: ${a} vs ${b}`)
        } else assert.equal(a, b, `${tr.hex}[${i}].${k}`)
      }
    }
  }
  assert.equal(f.take(...all).length, positions, 'take gives every one of them once')
})

/** A reply as the app gets it: parsed from JSON, so the arrays are the kind the engine makes for parsed JSON. */
function parsedSlot(aircraftN: number, points: number): HistorySlot {
  const aircraft: HistoryTrack[] = []
  for (let a = 0; a < aircraftN; a++) {
    const t: number[] = []
    const lat: number[] = []
    const lon: number[] = []
    const alt: (number | 'g' | null)[] = []
    const gs: (number | null)[] = []
    for (let i = 0; i < points; i++) {
      t.push(i * 10)
      lat.push(Math.round((30 + a * 0.003 + i * 0.002) * 1e5) / 1e5)
      lon.push(Math.round((10 + a * 0.002 + i * 0.003) * 1e5) / 1e5)
      alt.push(a % 25 === 0 && i < 10 ? 'g' : 25 * Math.round((5000 + i * 20) / 25))
      gs.push(i === 0 ? null : Math.round((300 + (i % 50) * 1.3) * 10) / 10) // no speed at the first fix, as often happens
    }
    aircraft.push({ hex: (0xa00000 + a).toString(16), callsign: `TST${a}`, squawk: '1200', type: null, nM: 19.6, t, lat, lon, alt, gs })
  }
  return JSON.parse(JSON.stringify({ slotMs: T0, stepS: 10, aircraft })) as HistorySlot
}

test('a held position costs under 70 bytes (~59 in Node, worst mix): the columns as they arrived, no object each', () => {
  const AIRCRAFT = 700
  const POINTS = 150
  const used = (): number => {
    const m = process.memoryUsage()
    return m.heapUsed + m.arrayBuffers
  }
  gc()
  gc()
  const before = used()
  const f = new HistoryFeed()
  f.add(parsedSlot(AIRCRAFT, POINTS), HOME)
  gc()
  gc()
  const perPosition = (used() - before) / (AIRCRAFT * POINTS)
  assert.equal(f.take(T0 + 100_000, T0 + 110_000).length, AIRCRAFT, 'it still serves them (and the feed lives to here)')
  assert.ok(perPosition < 70, `${perPosition.toFixed(1)} bytes per held position (an object per position was ~370)`)
})

test('stepOf: the slice step of a held half hour, null when it is not held', () => {
  const f = new HistoryFeed()
  f.add({ slotMs: 1_790_740_800_000, stepS: 30, aircraft: [] }, { lat: 32, lon: 34.8, nm: 500 })
  assert.equal(f.stepOf(1_790_740_800_000), 30)
  assert.equal(f.stepOf(1_790_742_600_000), null)
})

// client/history/aircraftDay.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TraceReply } from '../../shared/api.ts'
import { isGap } from '../scene/pathGap.ts'
import { callsignAt, dayState, legEndMs, legMs, legSpans, onGroundAt, pointsUpTo } from './aircraftDay.ts'
import { legFeeds } from './policy.ts'

const MIN = 60_000
const H = Date.parse('2026-10-01T10:00:00Z')

/** A leg from t0Ms with a point at each of secs (s after t0Ms), all over Israel at 3,000 ft unless o says otherwise. */
function leg(t0Ms: number, secs: number[], o: Partial<TraceReply> = {}): TraceReply {
  const col = <T>(v: T): T[] => secs.map(() => v)
  return {
    hex: '738abc', callsign: 'ISR595', calls: [[0, 'ISR595']], reg: '4X-EKA', typeCode: 'B738', t0Ms, t: secs,
    lat: col(32), lon: col(34.8), alt: col(3000), gs: col(150), trk: col(90), vs: col(0), roll: col(0), nM: col(19.6),
    ...o,
  }
}

const A = leg(H, [0, 600, 1200]) // 10:00 to 10:20
const B = leg(H + 60 * MIN, [0, 900, 1800]) // 11:00 to 11:30

test('an aircraft with no legs is none, at any time', () => {
  assert.deepEqual(dayState([], H), { kind: 'none' })
  assert.deepEqual(dayState([], -Infinity), { kind: 'none' })
})

test('one leg: not heard before its first point, heard from it to a minute after its last, quiet where it ended after that', () => {
  assert.deepEqual(dayState([A], H - 1), { kind: 'before', leg: A, untilMs: H })
  for (const t of [H, H + 10 * MIN, H + 20 * MIN, H + 21 * MIN]) {
    assert.deepEqual(dayState([A], t), { kind: 'heard', leg: A }, `${(t - H) / 1000} s in`)
  }
  assert.deepEqual(dayState([A], H + 21 * MIN + 1), { kind: 'quiet', leg: A, sinceMs: H + 20 * MIN })
  assert.deepEqual(dayState([A], H + 12 * 60 * MIN), { kind: 'quiet', leg: A, sinceMs: H + 20 * MIN }, 'for the rest of the day')
})

test('before its first leg of several: not heard until that leg starts, the first one named whatever the time', () => {
  assert.deepEqual(dayState([A, B], H - 3 * MIN), { kind: 'before', leg: A, untilMs: H })
  assert.deepEqual(dayState([A, B], -Infinity), { kind: 'before', leg: A, untilMs: H })
})

test('between two legs it is quiet since the earlier one ended; the later one is heard from its first point', () => {
  const day = [A, B]
  const quiet = { kind: 'quiet', leg: A, sinceMs: H + 20 * MIN }
  assert.deepEqual(dayState(day, H + 21 * MIN + 1), quiet, 'the minute after A is over')
  assert.deepEqual(dayState(day, H + 40 * MIN), quiet)
  assert.deepEqual(dayState(day, B.t0Ms - 1), quiet, 'a moment before B starts')
  assert.deepEqual(dayState(day, B.t0Ms), { kind: 'heard', leg: B }, 'B: its first point')
  assert.deepEqual(dayState(day, H + 90 * MIN), { kind: 'heard', leg: B }, 'B: its last point')
  assert.deepEqual(dayState(day, H + 91 * MIN), { kind: 'heard', leg: B }, 'B: a minute after it')
  assert.deepEqual(dayState(day, H + 91 * MIN + 1), { kind: 'quiet', leg: B, sinceMs: H + 90 * MIN }, 'B ended: quiet since then')
})

test('quiet since its last point whether the leg ended on the ground or in the air (the ghost’s own numbers say which)', () => {
  const t = H + 30 * MIN
  for (const alt of [[3000, 100, 'g'], [3000, 100, 400], [3000, 100, null], ['g', 'g', 3000]] as (number | 'g' | null)[][]) {
    const l = leg(H, [0, 600, 1200], { alt })
    assert.deepEqual(dayState([l], t), { kind: 'quiet', leg: l, sinceMs: H + 20 * MIN }, JSON.stringify(alt))
  }
})

test('legs that touch or overlap by a few seconds hand over at the later one’s first point', () => {
  const a = leg(H, [0, 600, 1803]) // ends 10:30:03
  const b = leg(H + 30 * MIN, [0, 600]) // starts 10:30:00: 3 s before a ends (a file's edge)
  const day = [a, b]
  assert.deepEqual(dayState(day, b.t0Ms - 1), { kind: 'heard', leg: a })
  assert.deepEqual(dayState(day, b.t0Ms), { kind: 'heard', leg: b }, 'the later leg wins from its first point…')
  assert.deepEqual(dayState(day, b.t0Ms + 2000), { kind: 'heard', leg: b }, '…while a still feeds (to a minute after its last)')
  assert.deepEqual(dayState(day, H + 30 * MIN + 3000 + MIN), { kind: 'heard', leg: b }, 'a ends its minute: still b')
  assert.deepEqual(dayState(day, H + 40 * MIN + MIN + 1), { kind: 'quiet', leg: b, sinceMs: H + 40 * MIN })
  const c = leg(H + 1_803_000, [0, 60]) // starts at the very ms a's last point is
  assert.deepEqual(dayState([a, c], H + 1_803_000), { kind: 'heard', leg: c }, 'touching: the later one')
  assert.deepEqual(dayState([a, c], H + 1_802_999), { kind: 'heard', leg: a })
})

test('heard is exactly where policy’s legFeeds says a leg feeds the track, ms by ms around every edge', () => {
  const day = [A, leg(H + 20 * MIN + 5000, [0, 100, 205.3]), B, leg(B.t0Ms + 30 * MIN + 1000, [0])] // one overlaps A's minute
  const edges = day.flatMap((l) => [l.t0Ms, legEndMs(l), legEndMs(l) + MIN])
  for (const e of edges) {
    for (const d of [-1_000, -1, 0, 1, 1_000]) {
      const t = e + d
      assert.equal(dayState(day, t).kind === 'heard', day.some((l) => legFeeds(l, t)), `at ${t - H} ms`)
    }
  }
})

// Heard every 10 s, then not from 20 s in until 1,220 s (20 min on, 1.68° north: about 100 nm), then every 10 s again:
// a receiver's hole, as south of Crete.
const HOLE = leg(H, [0, 10, 20, 1220, 1230], { lat: [32, 32.01, 32.02, 33.7, 33.71] })
const SINCE = H + 20_000
const UNTIL = H + 1_220_000

test('a hole in a leg: gap strictly inside it, with the points either side; heard at both of them and around it', () => {
  const gap = { kind: 'gap', leg: HOLE, sinceMs: SINCE, untilMs: UNTIL }
  assert.deepEqual(dayState([HOLE], SINCE), { kind: 'heard', leg: HOLE }, 'at the point before the hole')
  assert.deepEqual(dayState([HOLE], SINCE + 1), gap, 'just after it')
  assert.deepEqual(dayState([HOLE], H + 10 * MIN), gap)
  assert.deepEqual(dayState([HOLE], UNTIL - 1), gap, 'just before the point after it')
  assert.deepEqual(dayState([HOLE], UNTIL), { kind: 'heard', leg: HOLE }, 'at the point after the hole')
  for (const t of [H, H + 15_000, UNTIL + 5_000, UNTIL + 10_000 + MIN]) {
    assert.deepEqual(dayState([HOLE], t), { kind: 'heard', leg: HOLE }, `${(t - H) / 1000} s in`)
  }
  assert.equal(dayState([HOLE], UNTIL + 10_000 + MIN + 1).kind, 'quiet', 'after the leg as ever')
})

test('heard keeps every moment of a leg with a hole that legFeeds gives it, but the hole', () => {
  for (let t = H - 2_000; t <= UNTIL + 10_000 + MIN + 2_000; t += 997) {
    const kind = dayState([HOLE], t).kind
    const inside = t > SINCE && t < UNTIL
    assert.equal(kind, inside ? 'gap' : legFeeds(HOLE, t) ? 'heard' : t < H ? 'before' : 'quiet', `${t - H} ms in`)
  }
})

test('a short step is never a gap, however far it goes; a long one that hardly moves is not either (parked, taxiing)', () => {
  const at = (l: TraceReply, s: number): string => dayState([l], H + s * 1000).kind
  assert.equal(at(leg(H, [0, 60], { lat: [32, 32.17] }), 30), 'heard', 'exactly a minute, 10 nm on')
  assert.equal(at(leg(H, [0, 59], { lat: [32, 32.8] }), 30), 'heard', 'under a minute, 48 nm on')
  assert.equal(at(leg(H, [0, 900], { alt: ['g', 'g'], lat: [32, 32.003] }), 450), 'heard', '15 min on the ground, 0.2 nm on')
  assert.equal(at(leg(H, [0, 900], { lat: [32, 32.0316] }), 450), 'heard', '15 min in the air, 1.9 nm on (a holding pattern)')
  assert.equal(at(leg(H, [0, 60.1], { lat: [32, 32.035] }), 30), 'gap', 'just over a minute and 2 nm: a hole')
})

test('two holes in a row: a gap in each, heard only at the point between them', () => {
  const l = leg(H, [0, 100, 200], { lat: [32, 32.1, 32.2] }) // 6 nm each 100 s
  assert.deepEqual(dayState([l], H + 50_000), { kind: 'gap', leg: l, sinceMs: H, untilMs: H + 100_000 })
  assert.deepEqual(dayState([l], H + 100_000), { kind: 'heard', leg: l })
  assert.deepEqual(dayState([l], H + 150_000), { kind: 'gap', leg: l, sinceMs: H + 100_000, untilMs: H + 200_000 })
})

test('a gap is exactly a step the flown path draws dotted (pathGap.ts isGap, on the points’ whole ms)', () => {
  const l = leg(H, [0, 30.4, 95.5, 160.6, 400, 1000.3], { lat: [32, 32.01, 32.05, 32.06, 32.2, 32.21], alt: [3000, 3000, 3000, 'g', 'g', 'g'] })
  for (let i = 0; i + 1 < l.t.length; i++) {
    const p = (k: number) => ({ tMs: legMs(l.t0Ms, l.t[k]), lat: l.lat[k], lon: l.lon[k] })
    const t = Math.floor((p(i).tMs + p(i + 1).tMs) / 2)
    assert.equal(dayState([l], t).kind === 'gap', isGap(p(i), p(i + 1)), `step ${i}`)
  }
})

test('a leg’s points at or before a time, as their whole ms place them', () => {
  const x = leg(0, [0, 16.1, 32.2]) // 32.2 × 1000 is 32200.000000000004 in floating point
  assert.deepEqual([-1, 0, 16_099, 16_100, 32_199, 32_200, 99_999].map((t) => pointsUpTo(x, t)), [0, 1, 1, 2, 2, 3, 3])
  assert.equal(pointsUpTo(leg(H, []), H), 0)
  assert.equal(legMs(0, 32.2), 32_200)
})

test('on the ground at a time when its last point at or before it is (the first before any), as the points’ whole ms place them', () => {
  const x = leg(H, [0, 16.1, 32.2, 600, 1200], { alt: ['g', 'g', 400, 3000, 'g'] }) // takes off, lands
  const on = (ms: number): boolean => onGroundAt(x, H + ms)
  assert.deepEqual([-5_000, 0, 16_100, 32_199, 32_200, 599_999, 600_000, 1_199_999, 1_200_000, 9_999_999].map(on),
    [true, true, true, true, false, false, false, false, true, true])
  assert.equal(onGroundAt(leg(H, [0, 60], { alt: [null, null] }), H + 30_000), false, 'unknown is not on the ground')
  assert.equal(onGroundAt(leg(H, []), H), false, 'a leg with no points')
})

test('a leg’s span runs from its first point to its last, in whole ms', () => {
  const x = leg(0, [0, 16.1, 32.2]) // 32.2 × 1000 is 32200.000000000004 in floating point
  assert.equal(legEndMs(x), 32_200)
  assert.deepEqual(legSpans([x, A]), [{ fromMs: 0, toMs: 32_200 }, { fromMs: H, toMs: H + 20 * MIN }])
  assert.deepEqual(legSpans([]), [])
  assert.equal(legEndMs(leg(H, [])), H, 'a leg with no points ends where it starts')
})

test('the callsign at a time is the last one sent at or before it', () => {
  const x = leg(H, [0, 600, 1200], { callsign: 'ISR044', calls: [[0, 'ISR595'], [300, 'ISR044']] }) // renamed 5 min in
  assert.equal(callsignAt(x, H), 'ISR595')
  assert.equal(callsignAt(x, H + 300_000 - 1), 'ISR595', 'a moment before the change')
  assert.equal(callsignAt(x, H + 300_000), 'ISR044', 'at the change: the new one')
  assert.equal(callsignAt(x, H + 12 * 60 * MIN), 'ISR044', 'after the last change')
})

test('before the first change the first callsign (not the leg’s last): also when it is first heard a while into the leg', () => {
  const x = leg(H, [0, 600, 1200], { callsign: 'ELY2', calls: [[120, 'ELY1'], [400, 'ELY2']] }) // no name for the first 2 min
  assert.equal(callsignAt(x, H - 5 * MIN), 'ELY1', 'before the leg')
  assert.equal(callsignAt(x, H + 60_000), 'ELY1', 'before its first call')
  assert.equal(callsignAt(x, H + 120_000), 'ELY1')
  assert.equal(callsignAt(x, H + 400_000), 'ELY2')
})

test('a change is placed in whole ms, as the points are: a point at the very time of a change has the new callsign', () => {
  const x = leg(0, [0, 16.1, 32.2, 40], { callsign: 'C', calls: [[0, 'A'], [16.1, 'B'], [32.2, 'C']] }) // 32.2 s is 32200.000000000004 ms
  assert.deepEqual([0, 16_099, 16_100, 32_199, 32_200, 40_000].map((t) => callsignAt(x, t)), ['A', 'A', 'B', 'B', 'C', 'C'])
})

test('with no calls the leg’s own callsign, which may be none', () => {
  assert.equal(callsignAt(leg(H, [0, 600], { callsign: 'ISR044', calls: [] }), H + 300_000), 'ISR044')
  assert.equal(callsignAt(leg(H, [0, 600], { callsign: null, calls: [] }), H + 300_000), null)
  const old = { ...leg(H, [0, 600], { callsign: 'ISR044' }), calls: undefined } as unknown as TraceReply // a server older than the field
  assert.equal(callsignAt(old, H), 'ISR044')
})

test('a leg that changed callsign many times: the right one at every time (a binary search, no off by one)', () => {
  const calls: [number, string][] = Array.from({ length: 1000 }, (_, i) => [i * 10, `C${i}`])
  const x = leg(H, [0, 9990], { callsign: 'C999', calls })
  for (const i of [0, 1, 2, 499, 500, 998, 999]) {
    const at = H + i * 10_000
    assert.equal(callsignAt(x, at), `C${i}`, `at change ${i}`)
    assert.equal(callsignAt(x, at + 9_999), `C${i}`, `just before change ${i + 1}`)
    if (i > 0) assert.equal(callsignAt(x, at - 1), `C${i - 1}`, `just before change ${i}`)
  }
})

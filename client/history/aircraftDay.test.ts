// client/history/aircraftDay.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TraceReply } from '../../shared/api.ts'
import { callsignAt, dayState, legEndMs, legSpans } from './aircraftDay.ts'
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
  assert.deepEqual(dayState([A], H + 21 * MIN + 1), { kind: 'quiet', leg: A, sinceMs: H + 20 * MIN, ground: false })
  assert.deepEqual(dayState([A], H + 12 * 60 * MIN), { kind: 'quiet', leg: A, sinceMs: H + 20 * MIN, ground: false }, 'for the rest of the day')
})

test('before its first leg of several: not heard until that leg starts, the first one named whatever the time', () => {
  assert.deepEqual(dayState([A, B], H - 3 * MIN), { kind: 'before', leg: A, untilMs: H })
  assert.deepEqual(dayState([A, B], -Infinity), { kind: 'before', leg: A, untilMs: H })
})

test('between two legs it is quiet since the earlier one ended; the later one is heard from its first point', () => {
  const day = [A, B]
  const quiet = { kind: 'quiet', leg: A, sinceMs: H + 20 * MIN, ground: false }
  assert.deepEqual(dayState(day, H + 21 * MIN + 1), quiet, 'the minute after A is over')
  assert.deepEqual(dayState(day, H + 40 * MIN), quiet)
  assert.deepEqual(dayState(day, B.t0Ms - 1), quiet, 'a moment before B starts')
  assert.deepEqual(dayState(day, B.t0Ms), { kind: 'heard', leg: B }, 'B: its first point')
  assert.deepEqual(dayState(day, H + 90 * MIN), { kind: 'heard', leg: B }, 'B: its last point')
  assert.deepEqual(dayState(day, H + 91 * MIN), { kind: 'heard', leg: B }, 'B: a minute after it')
  assert.deepEqual(dayState(day, H + 91 * MIN + 1), { kind: 'quiet', leg: B, sinceMs: H + 90 * MIN, ground: false }, 'B ended: quiet since then')
})

test('quiet on the ground when the leg ended on the ground (transponder on), in the air otherwise: its last point decides', () => {
  const t = H + 30 * MIN
  const ended = (alt: (number | 'g' | null)[]) => dayState([leg(H, [0, 600, 1200], { alt })], t)
  assert.deepEqual(ended([3000, 100, 'g']), { kind: 'quiet', leg: leg(H, [0, 600, 1200], { alt: [3000, 100, 'g'] }), sinceMs: H + 20 * MIN, ground: true })
  for (const alt of [[3000, 100, 400], [3000, 100, null], ['g', 'g', 3000], ['g', 3000, null]] as (number | 'g' | null)[][]) {
    const s = ended(alt)
    assert.deepEqual([s.kind, s.kind === 'quiet' && s.ground], ['quiet', false], JSON.stringify(alt))
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
  assert.deepEqual(dayState(day, H + 40 * MIN + MIN + 1), { kind: 'quiet', leg: b, sinceMs: H + 40 * MIN, ground: false })
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

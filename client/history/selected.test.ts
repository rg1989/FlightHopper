// client/history/selected.test.ts
// The selected aircraft in History: the entry the map draws for it, what it is called, the card's line, the span of its
// day asked for, and when the map brings it into view or follows it. Clock texts are in this machine's time zone, so
// their moments are built with new Date(y, m, d, …) in that zone too: the tests pass in any zone (TZ=… to try one).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TraceReply } from '../../shared/api.ts'
import type { AircraftInfo } from '../../shared/info.ts'
import type { FleetEntry, RenderState } from '../types.ts'
import { dayState, type DayState } from './aircraftDay.ts'
import { MapMoves, atClock, daySpan, flyOver, insetContains, placeSelected, replayStatus, selectedInfo } from './selected.ts'

const MIN = 60_000
const H = 3_600_000
const T = Date.parse('2026-10-01T10:00:00Z')
const at = (y: number, m: number, d: number, h = 0, min = 0): number => new Date(y, m, d, h, min).getTime()

/** A leg from t0Ms with a point at each of secs (s after t0Ms), over Israel at 3,000 ft unless o says otherwise. */
function leg(t0Ms: number, secs: number[], o: Partial<TraceReply> = {}): TraceReply {
  const col = <V>(v: V): V[] => secs.map(() => v)
  return {
    hex: '738abc', callsign: 'ISR595', calls: [[0, 'ISR595']], reg: '4X-EKA', typeCode: 'B738', t0Ms, t: secs,
    lat: col(32), lon: col(34.8), alt: col(3000), gs: col(150), trk: col(90), vs: col(0), roll: col(0), nM: col(19.6),
    ...o,
  }
}

const entry = (hex: string, o: Partial<FleetEntry> = {}): FleetEntry => ({
  hex, lat: 32, lon: 35, hM: 1000, altFt: 3000, onGround: false, trackDeg: 90, gsKt: 150, vsFpm: 0, ageS: 2, staleS: 60,
  gapS: 10, quality: 'adsb2', info: null, ...o,
})

const state = (o: Partial<RenderState> = {}): RenderState => ({
  hex: '738abc', lat: 32.1, lon: 34.9, hM: 933.5, headingDeg: 45, pitchDeg: 2, rollDeg: 0, gsKt: 250, trackDeg: 47,
  altBaroFt: 3000, vsFpm: 1200, mode: 'interp', altSource: 'baro-bias', onGround: false, ageS: -3, quality: 'adsb2',
  callsign: 'ISR595', typeCode: 'B738', ...o,
})

const FEED: AircraftInfo = {
  hex: '738abc', callsign: 'XYZ1', reg: null, typeCode: 'B38M', category: 'A3', squawk: '7500', emergency: null, military: false, route: null,
}
const DAY = { hex: '738abc', reg: '4X-EKA', typeCode: 'B738' }

test('daySpan: the bar’s day with the 12 h before it (where the aircraft stood at midnight), never before the oldest moment nor after now', () => {
  const start = T
  const end = T + 24 * H
  assert.deepEqual(daySpan(start, end, null, end + H), { fromMs: start - 12 * H, toMs: end }, 'a past day; the oldest not known yet')
  assert.deepEqual(daySpan(start, end, start - 3 * H, end + H), { fromMs: start - 3 * H, toMs: end }, 'the oldest day: from the oldest moment')
  assert.deepEqual(daySpan(start, end, start - 20 * H, start + 5 * H), { fromMs: start - 12 * H, toMs: start + 5 * H }, 'today: up to now')
})

test('atClock: the local time of a moment, its weekday first when it falls on another day than the replay time', () => {
  const t = at(2026, 9, 2, 9, 15) // Fri 2 Oct
  assert.equal(atClock(at(2026, 9, 2, 7, 5), t), '07:05')
  assert.equal(atClock(at(2026, 9, 2, 0, 0), t), '00:00', 'its own midnight')
  assert.equal(atClock(at(2026, 9, 1, 22, 58), t), 'Thu 22:58')
  assert.equal(atClock(at(2026, 9, 3, 0, 0), t), 'Sat 00:00')
  assert.equal(atClock(at(2026, 9, 9, 9, 15), t), 'Fri 09:15', 'a week on: the same weekday, another day')
})

test('replayStatus: heard, or its day not known yet, is the replay’s clock with the files’ quiet rule', () => {
  const t = at(2026, 9, 2, 13, 10)
  assert.deepEqual(replayStatus(null, t, 75), { text: 'Replay · 13:10', state: 'replay', quietS: 75 })
  const l = leg(at(2026, 9, 2, 13, 0), [0, 1200])
  assert.deepEqual(replayStatus(dayState([l], t), t, 60), { text: 'Replay · 13:10', state: 'replay', quietS: 60 })
})

test('replayStatus: quiet says since when (on the ground when it ended there), before until when, none this day', () => {
  const morning = leg(at(2026, 9, 2, 8, 0), [0, 600, 1200]) // 08:00 to 08:20, airborne at its end
  const noon = leg(at(2026, 9, 2, 12, 0), [0, 1800, 3600], { alt: [3000, 'g', 'g'] }) // 12:00 to 13:00, then on the ground
  const legs = [morning, noon]
  const say = (t: number): ReturnType<typeof replayStatus> => replayStatus(dayState(legs, t), t, 60)
  assert.deepEqual(say(at(2026, 9, 2, 10, 0)), { text: 'Not heard since 08:20', state: 'quiet' })
  assert.deepEqual(say(at(2026, 9, 2, 13, 10)), { text: 'On the ground since 13:00', state: 'quiet' })
  assert.deepEqual(say(at(2026, 9, 2, 7, 0)), { text: 'Not heard until 08:00', state: 'none' })
  assert.deepEqual(replayStatus(dayState([], T), T, 60), { text: 'Not heard this day', state: 'none' })
})

test('replayStatus: a moment on another day than the replay time carries its weekday (parked since last night)', () => {
  const evening = leg(at(2026, 9, 1, 22, 0), [0, 58 * 60]) // Thu 22:00 to 22:58
  const t = at(2026, 9, 2, 6, 30) // Fri 06:30
  assert.equal(replayStatus(dayState([evening], t), t, 60).text, 'Not heard since Thu 22:58')
})

test('selectedInfo: null until its day is known (the fleet’s info stands)', () => {
  assert.equal(selectedInfo(DAY, null, T, FEED, null), null)
})

test('selectedInfo: the leg’s identity with the callsign it sent at the time, and the files’ squawk and category', () => {
  const l = leg(T, [0, 600, 1200], { callsign: 'ISR044', calls: [[0, 'ISR595'], [900, 'ISR044']] })
  const at10 = T + 10 * MIN
  assert.deepEqual(selectedInfo(DAY, dayState([l], at10), at10, FEED, null), {
    hex: '738abc', callsign: 'ISR595', reg: '4X-EKA', typeCode: 'B738', category: 'A3', squawk: '7500', emergency: null,
    military: false, route: null,
  })
  const at16 = T + 16 * MIN
  assert.equal(selectedInfo(DAY, dayState([l], at16), at16, FEED, null)!.callsign, 'ISR044', 'after it changed')
  const later = T + 3 * H
  assert.equal(selectedInfo(DAY, dayState([l], later), later, FEED, null)!.callsign, 'ISR044', 'quiet: the last it sent')
  assert.equal(selectedInfo(DAY, dayState([l], T - 1), T - 1, FEED, null)!.callsign, 'ISR595', 'before: the first it will send')
  const none = selectedInfo(DAY, dayState([l], at10), at10, null, null)!
  assert.deepEqual([none.squawk, none.category], [null, null], 'the files do not hold it here')
})

test('selectedInfo: a leg with no type takes the files’ (the server’s address table)', () => {
  const l = leg(T, [0, 600], { typeCode: null })
  assert.equal(selectedInfo(DAY, dayState([l], T), T, FEED, null)!.typeCode, 'B38M')
  assert.equal(selectedInfo(DAY, dayState([l], T), T, null, null)!.typeCode, null)
})

test('selectedInfo: on a day it did not fly, the day’s registration and type with the files’ callsign', () => {
  const none: DayState = { kind: 'none' }
  assert.deepEqual(selectedInfo(DAY, none, T, FEED, null), {
    hex: '738abc', callsign: 'XYZ1', reg: '4X-EKA', typeCode: 'B738', category: 'A3', squawk: '7500', emergency: null,
    military: false, route: null,
  })
  assert.deepEqual(selectedInfo({ hex: '738abc', reg: null, typeCode: null }, none, T, null, null), {
    hex: '738abc', callsign: null, reg: null, typeCode: null, category: null, squawk: null, emergency: null, military: false, route: null,
  })
})

test('selectedInfo: the same object while nothing in it changes (the card, label and list keep it), a new one when something does', () => {
  const l = leg(T, [0, 600, 1200], { calls: [[0, 'ISR595'], [900, 'ISR044']] })
  const a = selectedInfo(DAY, dayState([l], T), T, FEED, null)
  assert.equal(selectedInfo(DAY, dayState([l], T + MIN), T + MIN, { ...FEED }, a), a)
  assert.notEqual(selectedInfo(DAY, dayState([l], T + 16 * MIN), T + 16 * MIN, FEED, a), a, 'another callsign')
  assert.notEqual(selectedInfo(DAY, dayState([l], T), T, { ...FEED, squawk: '2000' }, a), a, 'another squawk')
})

test('placeSelected: its day not known yet, the fleet’s entries as they are, its own drawn last', () => {
  const mine = entry('738abc')
  const others = [entry('aaaaaa'), mine, entry('bbbbbb')]
  const out: FleetEntry[] = []
  const got = placeSelected(others, '738abc', null, T, state(), null, out, entry('xxxxxx'))
  assert.equal(got, mine)
  assert.deepEqual(out.map((e) => e.hex), ['aaaaaa', 'bbbbbb', '738abc'])
  assert.equal(out[2], mine, 'the fleet’s own object')
  assert.equal(placeSelected([entry('aaaaaa')], '738abc', null, T, null, null, out, entry('x')), undefined, 'not in the fleet: none')
  assert.deepEqual(out.map((e) => e.hex), ['aaaaaa'])
})

test('placeSelected: heard, its entry is its track’s state in place of the fleet’s, named by info', () => {
  const l = leg(T, [0, 600])
  const info: AircraftInfo = { ...FEED, callsign: 'ISR595' }
  const own = entry('xxxxxx', { ghost: true, att: { headingDeg: 1, pitchDeg: 2, rollDeg: 3 } })
  const out: FleetEntry[] = []
  const got = placeSelected([entry('738abc', { lat: 1, lon: 1 }), entry('aaaaaa')], '738abc', dayState([l], T + MIN), T + MIN, state(), info, out, own)
  assert.equal(got, own, 'written into own')
  assert.deepEqual(out.map((e) => e.hex), ['aaaaaa', '738abc'], 'the fleet’s entry gone')
  assert.deepEqual({ ...own }, {
    hex: '738abc', lat: 32.1, lon: 34.9, hM: 933.5, altFt: 3000, onGround: false, trackDeg: 47, gsKt: 250, vsFpm: 1200,
    ageS: 0, staleS: Infinity, gapS: 0, quality: 'adsb2', info, att: null, ghost: false,
  }, 'its samples run ahead of the replay time: age 0; never stale by the fleet’s rule (its day says it is heard)')
})

test('placeSelected: heard but its track has no state yet, the fleet’s entry stays', () => {
  const l = leg(T, [0, 600])
  const fleetOwn = entry('738abc')
  const out: FleetEntry[] = []
  assert.equal(placeSelected([fleetOwn], '738abc', dayState([l], T), T, null, null, out, entry('x')), fleetOwn)
  assert.deepEqual(out, [fleetOwn])
})

test('placeSelected: quiet, a ghost at its leg’s last point: there, its height, altitude colour, track and age; the only entry of its hex', () => {
  const l = leg(T, [0, 600, 1200], {
    lat: [32, 32.1, 32.2], lon: [34.8, 34.9, 35], alt: [3000, 2000, 1500], trk: [90, 100, 110], gs: [150, 140, 130], vs: [0, -800, -700], nM: [19.6, 19.7, 19.8],
  })
  const t = T + 2 * H
  const info: AircraftInfo = { ...FEED, callsign: 'ISR595' }
  const own = entry('xxxxxx')
  const out: FleetEntry[] = []
  const got = placeSelected([entry('738abc'), entry('aaaaaa')], '738abc', dayState([l], t), t, null, info, out, own)
  assert.equal(got, own)
  assert.deepEqual(out.map((e) => e.hex), ['aaaaaa', '738abc'])
  assert.deepEqual({ ...own }, {
    hex: '738abc', lat: 32.2, lon: 35, hM: 1500 * 0.3048 + 19.8, altFt: 1500, onGround: false, trackDeg: 110, gsKt: 130, vsFpm: -700,
    ageS: (2 * H - 1_200_000) / 1000, staleS: Infinity, gapS: 0, quality: 'adsb2', info, att: null, ghost: true,
  })
})

test('placeSelected: a ghost on the ground stands on the geoid (the layer puts it on the terrain), with no altitude', () => {
  const l = leg(T, [0, 600], { alt: [1000, 'g'], nM: [19.6, 18.2] })
  const t = T + H
  const own = entry('xxxxxx')
  placeSelected([], '738abc', dayState([l], t), t, null, null, [], own)
  assert.deepEqual([own.onGround, own.altFt, own.hM, own.ghost], [true, null, 18.2, true])
})

test('placeSelected: before its first leg, or no leg this day, it is not drawn (the fleet’s entry goes too)', () => {
  const l = leg(T, [0, 600])
  for (const ds of [dayState([l], T - MIN), dayState([], T)]) {
    const out: FleetEntry[] = []
    assert.equal(placeSelected([entry('738abc'), entry('aaaaaa')], '738abc', ds, T, state(), FEED, out, entry('x')), undefined, ds.kind)
    assert.deepEqual(out.map((e) => e.hex), ['aaaaaa'], ds.kind)
  }
})

test('placeSelected: out is reused (cleared, then written), the fleet’s array is never touched', () => {
  const fleet = [entry('aaaaaa'), entry('738abc')]
  const out: FleetEntry[] = [entry('stale1'), entry('stale2'), entry('stale3')]
  placeSelected(fleet, '738abc', null, T, null, null, out, entry('x'))
  assert.deepEqual(out.map((e) => e.hex), ['aaaaaa', '738abc'])
  assert.deepEqual(fleet.map((e) => e.hex), ['aaaaaa', '738abc'])
})

test('insetContains: inside the view less a tenth of its height and width on each side', () => {
  const r = { west: 34, south: 31, east: 36, north: 33 }
  assert.equal(insetContains(r, 32, 35), true)
  assert.equal(insetContains(r, 31.25, 35.75), true, 'just inside the inset')
  assert.equal(insetContains(r, 31.15, 35), false, 'in the outer tenth (south)')
  assert.equal(insetContains(r, 32.9, 35), false, 'north')
  assert.equal(insetContains(r, 32, 34.1), false, 'west')
  assert.equal(insetContains(r, 32, 35.9), false, 'east')
  assert.equal(insetContains(r, 34, 35), false, 'outside the view')
  assert.equal(insetContains(null, 32, 35), false, 'the globe out of view')
  assert.equal(insetContains(r, Number.NaN, 35), false)
})

test('insetContains: a view across the antimeridian, and one that spans every longitude', () => {
  const r = { west: 170, south: -10, east: -170, north: 10 } // 20° wide across 180°
  assert.equal(insetContains(r, 0, 180), true)
  assert.equal(insetContains(r, 0, -175), true)
  assert.equal(insetContains(r, 0, 171), false, 'in the west tenth')
  assert.equal(insetContains(r, 0, -171), false, 'in the east tenth')
  assert.equal(insetContains(r, 0, 0), false)
  const world = { west: -180, south: -80, east: 180, north: 80 }
  assert.equal(insetContains(world, 0, -179), true, 'every longitude is in view')
  assert.equal(insetContains(world, 75, 0), false, 'its latitudes still count')
})

test('MapMoves: a pointer held on the map is moving it, and for 1.5 s after it lifts; a wheel or trackpad gesture for 1.5 s', () => {
  const m = new MapMoves()
  assert.equal(m.recent(0), false)
  m.down(1, 1000)
  assert.equal(m.recent(60_000), true, 'held, however long')
  m.up(1, 61_000)
  assert.equal(m.recent(62_499), true)
  assert.equal(m.recent(62_500), false)
  m.wheel(70_000)
  assert.equal(m.recent(71_499), true)
  assert.equal(m.recent(71_500), false)
})

test('MapMoves: two fingers move it until the last lifts; a lift it never saw go down changes nothing; clear lets go of all', () => {
  const m = new MapMoves()
  m.down(1, 0)
  m.down(2, 10)
  m.up(1, 100)
  assert.equal(m.recent(5000), true, 'one still down')
  m.up(2, 6000)
  assert.equal(m.recent(7499), true)
  assert.equal(m.recent(7500), false)
  m.up(3, 10_000) // a press that began on a button
  assert.equal(m.recent(10_001), false)
  m.down(4, 20_000)
  m.clear(20_100) // the window lost the focus: that lift will not come
  assert.equal(m.recent(21_599), true)
  assert.equal(m.recent(21_600), false)
})

test('flyOver: a jump brings it in when it is outside; playing follows one that just left the view; never one already outside, nor while the map is moved', () => {
  const left = { bring: false, playing: true, wasInside: true, inside: false, moved: false }
  assert.equal(flyOver(left), true, 'playing, it just left the view')
  assert.equal(flyOver({ ...left, inside: true }), false, 'still inside')
  assert.equal(flyOver({ ...left, wasInside: false }), false, 'outside already: panned away from, it is left alone')
  assert.equal(flyOver({ ...left, moved: true }), false, 'the person is moving the map')
  assert.equal(flyOver({ ...left, playing: false }), false, 'paused: only a jump moves the map')
  assert.equal(flyOver({ bring: true, playing: false, wasInside: false, inside: false, moved: false }), true, 'a jump: wherever it was')
  assert.equal(flyOver({ bring: true, playing: false, wasInside: false, inside: true, moved: false }), false, 'a jump: in view already')
})

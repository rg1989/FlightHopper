// client/history/selected.test.ts
// The selected aircraft in History: the entry the map draws for it, what it is called, the card's line, the span of its
// day asked for, and when the map brings it into view or follows it. Clock texts are in this machine's time zone, so
// their moments are built with new Date(y, m, d, …) in that zone too: the tests pass in any zone (TZ=… to try one).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TraceReply } from '../../shared/api.ts'
import { bearingDeg, destination, distanceNm } from '../../shared/geo.ts'
import type { AircraftInfo } from '../../shared/info.ts'
import type { FleetEntry, RenderState } from '../types.ts'
import { dayState, type DayState } from './aircraftDay.ts'
import {
  MapMoves, areaMiddle, atClock, cameraTarget, chaseAskAt, dayAsk, daySpan, estimateState, firstDayAsked, flyOver, historyWait, inArea, inSight,
  keepLegs, placeSelected, replayStatus, restartsTrack, selectedInfo, trackSource, viewMove,
} from './selected.ts'

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

test('replayStatus: quiet says when it was last heard (on the ground or not), before when it is first heard, none this day', () => {
  const morning = leg(at(2026, 9, 2, 8, 0), [0, 600, 1200]) // 08:00 to 08:20, airborne at its end
  const noon = leg(at(2026, 9, 2, 12, 0), [0, 1800, 3600], { alt: [3000, 'g', 'g'] }) // 12:00 to 13:00, then on the ground
  const legs = [morning, noon]
  const say = (t: number): ReturnType<typeof replayStatus> => replayStatus(dayState(legs, t), t, 60)
  assert.deepEqual(say(at(2026, 9, 2, 10, 0)), { text: 'Last heard 08:20', state: 'quiet' })
  assert.deepEqual(say(at(2026, 9, 2, 13, 10)), { text: 'Last heard 13:00', state: 'quiet' }, 'on the ground: its ALT says GND')
  assert.deepEqual(say(at(2026, 9, 2, 7, 0)), { text: 'First heard 08:00', state: 'none' })
  assert.deepEqual(replayStatus(dayState([], T), T, 60), { text: 'Not heard this day', state: 'none' })
})

test('replayStatus: a moment on another day than the replay time carries its weekday (parked since last night)', () => {
  const evening = leg(at(2026, 9, 1, 22, 0), [0, 58 * 60]) // Thu 22:00 to 22:58
  const t = at(2026, 9, 2, 6, 30) // Fri 06:30
  assert.equal(replayStatus(dayState([evening], t), t, 60).text, 'Last heard Thu 22:58')
})

test('replayStatus: no line is longer than 20 characters, whatever the weekday (the card’s foot holds that beside the Chase icon)', () => {
  const texts = [replayStatus(null, T, 60).text, replayStatus(dayState([], T), T, 60).text]
  const late = leg(at(2026, 9, 2, 23, 0), [0, 60])
  texts.push(replayStatus(dayState([late], at(2026, 9, 2, 1, 0)), at(2026, 9, 2, 1, 0), 60).text)
  for (let d = 0; d < 7; d++) { // parked since the evening before, on each day of a week
    const t = at(2026, 9, 2 + d, 6, 30)
    texts.push(replayStatus(dayState([leg(at(2026, 9, 1 + d, 22, 0), [0, 58 * 60])], t), t, 60).text)
  }
  assert.equal(new Set(texts.slice(3)).size, 7, 'seven weekdays')
  for (const x of texts) assert.ok(x.length <= 20, `${x}: ${x.length} characters`)
})

test('replayStatus: in a hole of its leg, when it was last heard (the point before the hole), its weekday on another day', () => {
  const l = leg(at(2026, 9, 2, 5, 0), [0, 10, 3550, 3560], { lat: [32, 32.01, 33.5, 33.51] }) // a hole 05:00:10 to 05:59:10
  const t = at(2026, 9, 2, 5, 30)
  assert.deepEqual(replayStatus(dayState([l], t), t, 60), { text: 'Last heard 05:00', state: 'quiet' })
  const late = leg(at(2026, 9, 1, 23, 58), [0, 10, 900], { lat: [32, 32.01, 33] }) // Thu 23:58:10 to Fri 00:13
  const t2 = at(2026, 9, 2, 0, 5)
  assert.deepEqual(replayStatus(dayState([late], t2), t2, 60), { text: 'Last heard Thu 23:58', state: 'quiet' })
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

// A hole of 20 min (10 s to 1,210 s in) from 32° N 34° E at 30,000 ft to 34° N 36° E at 20,000 ft: about 150 nm.
const GAP = leg(T, [0, 10, 1210, 1220], {
  lat: [31.99, 32, 34, 34.01], lon: [33.99, 34, 36, 36.01], alt: [30_000, 30_000, 20_000, 20_000], trk: [45, 45, 40, 40],
  gs: [480, 480, 440, 440], vs: [0, 0, 0, 0], nM: [19, 20, 22, 23],
})
const GAP_NM_ALL = distanceNm(32, 34, 34, 36)

test('placeSelected: in a hole of its leg, a ghost where it is estimated to be, moving with the replay; the only entry of its hex', () => {
  const info: AircraftInfo = { ...FEED, callsign: 'ISR595' }
  const own = entry('xxxxxx')
  const out: FleetEntry[] = []
  const t = T + 10_000 + 10 * MIN // half way through the hole
  const got = placeSelected([entry('738abc'), entry('aaaaaa')], '738abc', dayState([GAP], t), t, state(), info, out, own)
  assert.equal(got, own, 'its track’s state, should one be held, does not count: there is none in a hole')
  assert.deepEqual(out.map((e) => e.hex), ['aaaaaa', '738abc'])
  assert.ok(Math.abs(distanceNm(32, 34, own.lat, own.lon) - GAP_NM_ALL / 2) < 1e-6, 'half the way from the point before…')
  assert.ok(Math.abs(distanceNm(own.lat, own.lon, 34, 36) - GAP_NM_ALL / 2) < 1e-6, '…and half to the point after: on the great circle')
  assert.equal(own.trackDeg, bearingDeg(32, 34, 34, 36), 'the bearing from one to the other')
  assert.equal(own.altFt, 25_000)
  assert.equal(own.vsFpm, -500, '10,000 ft down in 20 min')
  assert.ok(Math.abs(own.gsKt! - GAP_NM_ALL * 3) < 1e-9, 'the distance over the time')
  assert.ok(Math.abs(own.hM - (30_000 * 0.3048 + 20 + 20_000 * 0.3048 + 22) / 2) < 1e-9, 'on the dotted line’s height')
  assert.deepEqual([own.onGround, own.ageS, own.staleS, own.gapS, own.info, own.att, own.ghost, own.quality], [false, 600, Infinity, 0, info, null, true, 'adsb2'])
  const t2 = T + 10_000 + 5 * MIN // a quarter: it moves as the replay plays
  placeSelected([], '738abc', dayState([GAP], t2), t2, null, info, [], own)
  assert.ok(Math.abs(distanceNm(32, 34, own.lat, own.lon) - GAP_NM_ALL / 4) < 1e-6)
  assert.equal(own.altFt, 27_500)
  assert.equal(own.ageS, 300)
})

test('placeSelected: in a hole, its altitude unknown when either end’s is, on the ground only when both ends are', () => {
  const t = T + 10_000 + 10 * MIN
  const est = (alt: (number | 'g' | null)[]): FleetEntry => {
    const own = entry('xxxxxx')
    const l = { ...GAP, alt }
    placeSelected([], '738abc', dayState([l], t), t, null, null, [], own)
    return own
  }
  for (const alt of [[30_000, 30_000, null, null], [30_000, 'g', 20_000, 20_000], [null, null, null, null]] as (number | 'g' | null)[][]) {
    const e = est(alt)
    assert.deepEqual([e.altFt, e.vsFpm, e.onGround], [null, null, false], JSON.stringify(alt))
  }
  const ground = est(['g', 'g', 'g', 'g']) // both ends on the ground (a hole while it taxied)
  assert.deepEqual([ground.altFt, ground.vsFpm, ground.onGround, ground.ghost], [null, null, true, true])
  assert.ok(Math.abs(ground.hM - 21) < 1e-9, 'the geoid between the two points (the layer puts it on the ground)')
})

/** Where a canvas 1,000 × 700 px that shows box draws (lat, lon): a flat stand-in for the camera. */
const drawn = (box: { west: number; south: number; east: number; north: number }, lat: number, lon: number): { x: number; y: number } => ({
  x: ((lon - box.west) / (box.east - box.west)) * 1000,
  y: ((box.north - lat) / (box.north - box.south)) * 700,
})
const CANVAS = { x: 0, y: 0, w: 1000, h: 700 }

test('bring into view and follow use the estimate in a hole: a jump into it flies there; playing through it keeps following', () => {
  const placed = (t: number): FleetEntry => {
    const own = entry('xxxxxx')
    placeSelected([], '738abc', dayState([GAP], t), t, null, null, [], own)
    return own
  }
  const israel = { west: 33, south: 29, east: 36, north: 32.5 }
  const jump = placed(T + 10_000 + 10 * MIN)
  const inside = inArea(drawn(israel, jump.lat, jump.lon), CANVAS)
  assert.equal(inside, false)
  assert.equal(flyOver({ bring: true, playing: false, wasInside: false, inside, moved: false }), true, 'flies over the estimate')
  const a = placed(T + 10_000 + 2 * MIN)
  const view = { west: a.lon - 0.5, south: a.lat - 0.5, east: a.lon + 0.5, north: a.lat + 0.5 } // about 60 nm across
  assert.equal(inArea(drawn(view, a.lat, a.lon), CANVAS), true)
  const b = placed(T + 10_000 + 8 * MIN) // ~46 nm on: out of the view less its inset
  const left = inArea(drawn(view, b.lat, b.lon), CANVAS)
  assert.equal(left, false)
  assert.equal(flyOver({ bring: false, playing: true, wasInside: true, inside: left, moved: false }), true, 'followed through the hole')
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

test('inArea: inside the clear area less a tenth of its width and height on each side', () => {
  const area = { x: 340, y: 190, w: 1000, h: 600 } // right of the card, under the search box, above the bar: inset 100 px across, 60 down
  assert.equal(inArea({ x: 840, y: 490 }, area), true, 'the middle')
  assert.equal(inArea({ x: 440, y: 250 }, area), true, 'the inset’s top-left corner')
  assert.equal(inArea({ x: 1240, y: 730 }, area), true, 'and its bottom-right')
  for (const p of [{ x: 439.9, y: 490 }, { x: 1240.1, y: 490 }, { x: 840, y: 249.9 }, { x: 840, y: 730.1 }]) {
    assert.equal(inArea(p, area), false, `${JSON.stringify(p)}: in the outer tenth`)
  }
  assert.equal(inArea({ x: 1700, y: 490 }, area), false, 'off the canvas')
  assert.equal(inArea(undefined, area), false, 'not seen at all (behind the camera, or the globe’s curve)')
  assert.equal(inArea({ x: Number.NaN, y: 490 }, area), false)
  assert.equal(inArea({ x: 5, y: 5 }, { x: 5, y: 5, w: 0, h: 0 }), false, 'nothing clear: nothing inside')
  assert.equal(inArea({ x: 340, y: 190 }, area, 0), true, 'no inset: the edge counts')
  assert.equal(inArea({ x: 339.9, y: 190 }, area, 0), false)
  assert.equal(inArea({ x: 840, y: 490 }, area, 0.5), true, 'the inset reaching the middle leaves the middle')
  assert.equal(inArea({ x: 841, y: 490 }, area, 0.5), false)
})

test('inArea: an aircraft that flew under the card is not in view, though the canvas, less its tenth, still holds it', () => {
  const canvas = { x: 0, y: 0, w: 1440, h: 900 }
  const clear = { x: 340, y: 8, w: 1016, h: 800 } // what the card (12–332 px across, 12–180 down), the bar and the rail leave
  const flying = { x: 600, y: 300 }
  const underCard = { x: 200, y: 130 } // 60× later: the card hides it
  assert.deepEqual([inArea(flying, canvas), inArea(underCard, canvas)], [true, true], 'the canvas alone: it stays "in view" under the card')
  assert.deepEqual([inArea(flying, clear), inArea(underCard, clear)], [true, false], 'the clear area: it left')
  const base = { busy: false, bring: false, had: true, at: true, playing: true, moved: false, dayKnown: true, nowhere: false }
  assert.deepEqual(viewMove({ ...base, wasInside: inArea(flying, clear), inside: inArea(underCard, clear) }), { fly: 'follow', bring: false }, 'followed out from under it')
  assert.deepEqual(viewMove({ ...base, wasInside: inArea(flying, clear), inside: inArea(flying, clear) }), { fly: null, bring: false })
})

test('areaMiddle: the middle of the clear area; none when nothing is clear', () => {
  assert.deepEqual(areaMiddle({ x: 340, y: 190, w: 1000, h: 600 }), { x: 840, y: 490 })
  assert.equal(areaMiddle({ x: 8, y: 8, w: 0, h: 500 }), null)
  assert.equal(areaMiddle({ x: 8, y: 8, w: 500, h: 0 }), null)
})

test('inSight: over the globe’s curve, not behind it: a camera sees to its horizon, and past it as far as the aircraft’s own reaches', () => {
  const rad = (d: number): number => (d * Math.PI) / 180
  // 300 km up, the horizon is 17.2° of arc away (1,900 km); an aircraft at 11 km adds 3.4°.
  assert.equal(inSight(300_000, 11_000, 0), true, 'straight below')
  assert.equal(inSight(300_000, 11_000, rad(20)), true, 'beyond the camera’s horizon, but the aircraft is up there')
  assert.equal(inSight(300_000, 11_000, rad(21)), false)
  assert.equal(inSight(300_000, 0, rad(17)), true, 'on the ground: only the camera’s own horizon')
  assert.equal(inSight(300_000, 0, rad(18)), false)
  // Its far side projects onto the canvas (the antipode at its centre), from a global view as from a regional one: hidden.
  for (const m of [300_000, 2_000_000, 10_000_000]) assert.equal(inSight(m, 11_000, Math.PI), false, `the antipode, seen from ${m} m`)
  assert.equal(inSight(10_000_000, 11_000, rad(60)), true, 'a global view sees 60° round')
  assert.equal(inSight(10_000_000, 11_000, rad(100)), false)
  assert.equal(inSight(300_000, 11_000, Number.NaN), false)
  assert.equal(inSight(-5, -5, 0), true, 'below the ellipsoid counts as on it')
})

// A straight-down pinhole camera on a 1,440 × 900 px canvas whose wider side spans 60° (Cesium's default), flat over the few
// hundred km a screen holds: the ground under a pixel, and where an aircraft hM up is drawn.
type Eye = { lat: number; lon: number; m: number }
const M_DEG = (3440.065 * 1852 * Math.PI) / 180 // m per degree of latitude (shared/geo.ts's sphere)
const cosLat = (lat: number): number => Math.cos((lat * Math.PI) / 180)
const mPerPx = (depthM: number): number => (2 * depthM * Math.tan(Math.PI / 6)) / 1440
const groundAt = (eye: Eye, px: { x: number; y: number }): { lat: number; lon: number } => ({
  lat: eye.lat - ((px.y - 450) * mPerPx(eye.m)) / M_DEG,
  lon: eye.lon + ((px.x - 720) * mPerPx(eye.m)) / (M_DEG * cosLat(eye.lat)),
})
const drawnAt = (eye: Eye, at: { lat: number; lon: number; hM: number }): { x: number; y: number } => ({
  x: 720 + ((at.lon - eye.lon) * M_DEG * cosLat(eye.lat)) / mPerPx(eye.m - at.hM),
  y: 450 - ((at.lat - eye.lat) * M_DEG) / mPerPx(eye.m - at.hM),
})

test('cameraTarget: the camera looks where the aircraft is drawn at the middle of the clear area, its height allowed for', () => {
  const eye: Eye = { lat: 32, lon: 35, m: 60_000 }
  const area = { x: 340, y: 190, w: 1000, h: 600 } // its middle is 120 px right of the canvas’s centre and 40 px under it
  const mid = areaMiddle(area)!
  const under = groundAt(eye, { x: 720, y: 450 })
  const middle = groundAt(eye, mid)
  const jet = { lat: 32.6, lon: 35.9, hM: 11_000 }
  const to = cameraTarget(jet, eye.m, under, middle)
  const seen = drawnAt({ ...to, m: eye.m }, jet)
  assert.ok(Math.hypot(seen.x - mid.x, seen.y - mid.y) < 1, `drawn at ${JSON.stringify(seen)}, not at ${JSON.stringify(mid)}`)
  // Left out (the ground's own distance), the aircraft would rest 22 % of that offset too far out: ~28 px.
  const plain = cameraTarget({ ...jet, hM: 0 }, eye.m, under, middle)
  const out = drawnAt({ ...plain, m: eye.m }, jet)
  assert.ok(Math.hypot(out.x - mid.x, out.y - mid.y) > 20, `${JSON.stringify(out)}`)
  // An aircraft on the ground, or high over a high camera: the ground’s own distance, to a pixel.
  for (const [hM, m] of [[0, 60_000], [11_000, 300_000], [0, 2_000]] as const) {
    const e: Eye = { ...eye, m }
    const t = cameraTarget({ ...jet, hM }, m, groundAt(e, { x: 720, y: 450 }), groundAt(e, mid))
    const d = drawnAt({ ...t, m }, { ...jet, hM })
    assert.ok(Math.hypot(d.x - mid.x, d.y - mid.y) < 1, `${hM} m up, camera at ${m} m: ${JSON.stringify(d)}`)
  }
})

test('cameraTarget: no ground at the area’s middle, or none clear: the aircraft’s own place, the canvas’s centre as before', () => {
  const jet = { lat: 32.6, lon: 35.9, hM: 11_000 }
  const here = { lat: 32, lon: 35 }
  assert.deepEqual(cameraTarget(jet, 60_000, here, null), { lat: 32.6, lon: 35.9 })
  const same = cameraTarget(jet, 60_000, here, here) // the middle is the centre: nothing to move by
  assert.ok(Math.abs(same.lat - jet.lat) < 1e-9 && Math.abs(same.lon - jet.lon) < 1e-9, JSON.stringify(same))
})

test('cameraTarget: an aircraft above the camera is not drawn: the camera goes under it; no camera height: the ground’s distance', () => {
  const jet = { lat: 32.6, lon: 35.9, hM: 70_000 }
  const under = { lat: 32, lon: 35 }
  const middle = destination(32, 35, 90, 3)
  const above = cameraTarget(jet, 60_000, under, middle)
  assert.ok(Math.abs(above.lat - jet.lat) < 1e-9 && Math.abs(above.lon - jet.lon) < 1e-9, JSON.stringify(above))
  const flat = cameraTarget(jet, 0, under, middle)
  assert.ok(Math.abs(distanceNm(flat.lat, flat.lon, jet.lat, jet.lon) - 3) < 1e-6, 'a view with no height: the distance as it is')
})

test('cameraTarget: the offset is kept as a distance across the antimeridian and towards a pole', () => {
  const under = { lat: 10, lon: 179.5 }
  const east = destination(under.lat, under.lon, 90, 12) // the area’s middle: 12 nm east of the centre, over the antimeridian
  const at = { lat: 10.2, lon: -179.9, hM: 0 }
  const to = cameraTarget(at, 100_000, under, east)
  assert.ok(Math.abs(distanceNm(to.lat, to.lon, at.lat, at.lon) - 12) < 1e-6, 'as far from the aircraft as the middle is from the centre')
  assert.ok(Math.abs(bearingDeg(to.lat, to.lon, at.lat, at.lon) - 90) < 0.5, 'the aircraft stands east of it')
  assert.ok(to.lon > 179.8 && to.lon < 180, `west of the aircraft, on the other side of 180°: ${to.lon}`)
  const north = destination(85, 0, 0, 20) // 20 nm north of the centre, near the pole
  const pole = cameraTarget({ lat: 80, lon: 40, hM: 0 }, 100_000, { lat: 85, lon: 0 }, north)
  assert.ok(Math.abs(distanceNm(pole.lat, pole.lon, 80, 40) - 20) < 1e-6)
  assert.ok(pole.lat < 80 && Math.abs(pole.lon - 40) < 1e-6, `due south of the aircraft: ${JSON.stringify(pole)}`)
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

// ---------- the app's gates (app.ts acts on them) ----------

test('estimateState: the chase flies the estimate in a hole: nose along the bearing, pitched by the climb, wings level', () => {
  const own = entry('xxxxxx')
  const info: AircraftInfo = { ...FEED, callsign: 'ISR595' }
  const t = T + 10_000 + 10 * MIN
  placeSelected([], '738abc', dayState([GAP], t), t, null, info, [], own)
  const s = estimateState(own)
  assert.deepEqual([s.lat, s.lon, s.hM, s.headingDeg, s.trackDeg, s.rollDeg, s.altBaroFt, s.vsFpm, s.gsKt, s.onGround],
    [own.lat, own.lon, own.hM, own.trackDeg, own.trackDeg, 0, 25_000, -500, own.gsKt, false])
  const fall = (-500 * 0.3048) / 60 // m/s
  const fwd = (own.gsKt! * 1852) / 3600
  assert.ok(Math.abs(s.pitchDeg - (Math.atan2(fall, fwd) * 180) / Math.PI) < 1e-9 && s.pitchDeg < 0, 'nose a little down')
  assert.deepEqual([s.mode, s.callsign, s.typeCode, s.ageS], ['interp', 'ISR595', 'B38M', 600])
  assert.equal(estimateState({ ...own, gsKt: 0, vsFpm: null }).pitchDeg, 0, 'no speed: level')
})

test('chaseAskAt: the chase asks for where its aircraft will be two minutes on, along its leg; off a leg, where it is', () => {
  const l = leg(T, [0, 60, 120, 180, 240], { lat: [32, 32.1, 32.2, 32.3, 32.4] }) // 6 nm a minute north
  assert.deepEqual(chaseAskAt(dayState([l], T), T), { lat: 32.2, lon: 34.8 }, 'two minutes on: its point then')
  assert.deepEqual(chaseAskAt(dayState([l], T + 30_000), T + 30_000), { lat: 32.2, lon: 34.8 }, 'its last point by then')
  assert.deepEqual(chaseAskAt(dayState([l], T + 200_000), T + 200_000), { lat: 32.4, lon: 34.8 }, 'past the leg’s end: where it ends')
  const t = T + 10_000 + 2 * MIN // in the hole of GAP: two minutes on is still in it
  const ahead = chaseAskAt(dayState([GAP], t), t)!
  assert.ok(Math.abs(distanceNm(32, 34, ahead.lat, ahead.lon) - GAP_NM_ALL * (4 / 20)) < 1e-6, 'along the hole, as the estimate goes')
  assert.equal(chaseAskAt(null, T), null, 'its day not known')
  assert.equal(chaseAskAt(dayState([l], T + 3 * H), T + 3 * H), null, 'quiet')
  assert.equal(chaseAskAt(dayState([], T), T), null, 'none that day')
})

test('historyWait: the clock stalls only where nothing of its half hour is loaded around the view’s centre, or for the first day', () => {
  const base = { held: true, centre: true, chasing: false, missing: false, failing: false, loading: false, firstDay: false }
  assert.deepEqual(historyWait(base), { stall: false, ring: false }, 'loaded')
  assert.deepEqual(historyWait({ ...base, loading: true }), { stall: false, ring: true }, 'partly out of what is loaded: asked, playing on, the loader turns')
  assert.deepEqual(historyWait({ ...base, centre: false }), { stall: true, ring: true }, 'nothing around its centre: a jump, a pan to an area never loaded')
  assert.deepEqual(historyWait({ ...base, held: false, centre: false }), { stall: true, ring: true }, 'nothing at all')
  assert.deepEqual(historyWait({ ...base, centre: false, chasing: true }), { stall: false, ring: false }, 'the chase outran what is loaded: never a stall')
  assert.deepEqual(historyWait({ ...base, held: false, centre: false, chasing: true }), { stall: true, ring: true }, 'the chase, nothing of the half hour at all')
  assert.deepEqual(historyWait({ ...base, held: false, centre: false, missing: true }), { stall: false, ring: false }, 'missing at adsb.lol: nothing to wait for')
  assert.deepEqual(historyWait({ ...base, held: false, centre: false, failing: true }), { stall: false, ring: false }, 'failing: its note says so')
  assert.deepEqual(historyWait({ ...base, firstDay: true }), { stall: true, ring: true }, 'the selection’s first day of flights')
})

test('dayAsk: asks a day not answered, once; waits after a failure; answered, nothing', () => {
  const want = { hex: '738abc', startMs: T }
  const day = { ...want, toMs: T + 24 * H }
  assert.deepEqual(dayAsk(want, T + H, null, null, null, 0), { ask: true, inFlight: null })
  const flying = { ...want }
  assert.deepEqual(dayAsk(want, T + H, null, flying, null, 0), { ask: false, inFlight: flying }, 'its ask in flight')
  assert.equal(dayAsk(want, T + H, null, flying, null, 0).inFlight, flying, 'the same ask (its reply is matched by it)')
  assert.deepEqual(dayAsk(want, T + H, day, null, null, 0), { ask: false, inFlight: null }, 'answered')
  assert.deepEqual(dayAsk(want, T + 25 * H, day, null, null, 0), { ask: true, inFlight: null }, 'an answer short of t: again')
  const again = { ...want, atMs: 15_000 }
  assert.deepEqual(dayAsk(want, T + H, null, null, again, 14_999), { ask: false, inFlight: null }, 'failed a moment ago')
  assert.deepEqual(dayAsk(want, T + H, null, null, again, 15_000), { ask: true, inFlight: null })
  assert.deepEqual(dayAsk({ ...want, hex: 'aaaaaa' }, T + H, day, null, again, 0), { ask: true, inFlight: null }, 'another aircraft')
})

test('dayAsk: an ask in flight for another day is dropped, so its reply cannot replace this day’s answer', () => {
  const day2 = { hex: '738abc', startMs: T + 24 * H }
  const day1 = { hex: '738abc', startMs: T }
  const answered = { ...day2, toMs: T + 48 * H }
  // Day 2 answered; ‹ asks day 1; › back to day 2 before day 1's reply came:
  const back = dayAsk(day2, T + 30 * H, answered, day1, null, 0)
  assert.deepEqual(back, { ask: false, inFlight: null }, 'day 2 stands; day 1’s ask is dropped')
  assert.deepEqual(dayAsk(day2, T + 30 * H, null, day1, null, 0), { ask: true, inFlight: null }, 'not answered: day 2 is asked instead')
})

test('firstDayAsked: the selection’s first ask in flight, nothing answered or failed for it yet', () => {
  const ask = { hex: '738abc', startMs: T }
  assert.equal(firstDayAsked('738abc', ask, null, null), true)
  assert.equal(firstDayAsked('738abc', null, null, null), false, 'nothing asked')
  assert.equal(firstDayAsked('738abc', ask, { hex: '738abc', startMs: T - 24 * H }, null), false, 'another day of it answered: no wait')
  assert.equal(firstDayAsked('738abc', ask, { hex: 'aaaaaa', startMs: T }, null), true, 'another aircraft’s answer says nothing')
  assert.equal(firstDayAsked('738abc', ask, null, { hex: '738abc', startMs: T }), false, 'a retry waits for nothing')
  assert.equal(firstDayAsked(null, ask, null, null), false, 'nothing selected')
  assert.equal(firstDayAsked('738abc', { hex: 'aaaaaa', startMs: T }, null, null), false, 'an ask for another one')
})

test('keepLegs: a fresh answer keeps the held legs it repeats (the track goes by the leg itself)', () => {
  const a = leg(T, [0, 600])
  const b = leg(T + H, [0, 600, 1200])
  const held = [a, b]
  assert.equal(keepLegs(held, [leg(T, [0, 600]), leg(T + H, [0, 600, 1200])]), held, 'the same legs: the held array')
  const grown = leg(T + H, [0, 600, 1200, 1800]) // today's leg, heard further since
  const out = keepLegs(held, [leg(T, [0, 600]), grown])
  assert.deepEqual([out[0] === a, out[1] === grown, out.length], [true, true, 2], 'the one it repeats kept, the grown one new')
  const c = leg(T + 3 * H, [0, 60])
  const more = keepLegs(held, [leg(T, [0, 600]), leg(T + H, [0, 600, 1200]), c])
  assert.deepEqual([more[0] === a, more[1] === b, more[2] === c], [true, true, true], 'a leg added after them')
  assert.deepEqual(keepLegs(held, []), [], 'none now')
})

test('trackSource and restartsTrack: the feed until its day is known, its leg while heard, none otherwise; another source restarts', () => {
  const l = leg(T, [0, 600, 1210, 1220], { lat: [32, 32.01, 33, 33.01] })
  assert.equal(trackSource(null), 'feed')
  assert.equal(trackSource(dayState([l], T + 60_000)), l)
  assert.equal(trackSource(dayState([l], T + 900_000)), 'none', 'in a hole of its leg: no track')
  assert.equal(trackSource(dayState([l], T + 3 * H)), 'none')
  assert.equal(restartsTrack(null, 'feed'), false, 'the first source, the feed: it keeps the selection’s seed')
  assert.equal(restartsTrack(null, l), true)
  assert.equal(restartsTrack('feed', l), true)
  assert.equal(restartsTrack(l, 'none'), true, 'into a hole')
  assert.equal(restartsTrack('none', l), true, 'heard again after it')
  assert.equal(restartsTrack(l, l), false)
  assert.equal(restartsTrack(l, leg(T, [0, 600, 1210, 1220])), true, 'another object is another leg (keepLegs keeps the same one)')
})

test('viewMove: a jump brings it in, playing follows it out of the view; nothing while the map flies or a seek rests', () => {
  const base = { busy: false, bring: false, had: true, at: true, playing: false, wasInside: false, inside: false, moved: false, dayKnown: true, nowhere: false }
  assert.deepEqual(viewMove({ ...base, bring: true }), { fly: 'bring', bring: false }, 'a jump, its day known: brought in, done')
  assert.deepEqual(viewMove({ ...base, bring: true, dayKnown: false }), { fly: 'bring', bring: true }, 'brought in again when its day comes')
  assert.deepEqual(viewMove({ ...base, bring: true, inside: true }), { fly: null, bring: false }, 'in view already')
  assert.deepEqual(viewMove({ ...base, bring: true, at: false, nowhere: true }), { fly: null, bring: false }, 'nowhere that day: done')
  assert.deepEqual(viewMove({ ...base, bring: true, at: false }), { fly: null, bring: true }, 'not placed yet: pending')
  assert.deepEqual(viewMove({ ...base, playing: true, wasInside: true }), { fly: 'follow', bring: false }, 'playing, it just left the view')
  assert.deepEqual(viewMove({ ...base, playing: true, wasInside: true, moved: true }), { fly: null, bring: false }, 'the person moves the map')
  assert.deepEqual(viewMove({ ...base, bring: true, busy: true }), { fly: null, bring: true }, 'the map flies already, or a seek rests')
})

test('viewMove: its first position after none brings it in (before its first leg to heard, a day answer placing it), unless the map was moved', () => {
  const first = { busy: false, bring: false, had: false, at: true, playing: true, wasInside: false, inside: false, moved: false, dayKnown: true, nowhere: false }
  assert.deepEqual(viewMove(first), { fly: 'bring', bring: false })
  assert.deepEqual(viewMove({ ...first, inside: true }), { fly: null, bring: false }, 'in view: nothing to do')
  assert.deepEqual(viewMove({ ...first, moved: true }), { fly: null, bring: false }, 'the person moved the map in the last 1.5 s')
  assert.deepEqual(viewMove({ ...first, had: true }), { fly: null, bring: false }, 'it had one: outside already, left alone')
})

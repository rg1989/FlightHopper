import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SLOT_MS, slotOf } from '../../shared/history.ts'
import type { AircraftInfo } from '../../shared/info.ts'
import type { Sample } from '../../shared/types.ts'
import { Fleet } from '../browse/fleet.ts'
import { KnownHexes, SlotBlock, SlotFailure, askNm, backMs, legCovers, legFeeds, lookaheadMs, prefetchMs, wantedSlots } from './policy.ts'

const H = Date.parse('2026-10-01T10:00:00Z') // a slot start
const MIN = 60_000

test('the half hour asked for holds the replay time, never the one still in progress; the next one ahead of time', () => {
  const maxMs = H + SLOT_MS // 10:00–10:30 is the newest published: 10:30 is where the replay ends
  assert.deepEqual(wantedSlots(H + 5 * MIN, maxMs, 5 * MIN), [H])
  assert.deepEqual(wantedSlots(maxMs, maxMs, 5 * MIN), [H], 'at the very end: still the newest published one')
  assert.deepEqual(wantedSlots(H - 3 * MIN, maxMs, 5 * MIN), [H - SLOT_MS, H], 'near its end: the next one too')
  assert.deepEqual(wantedSlots(H + 27 * MIN, maxMs, 5 * MIN), [H], 'no next one past the newest published')
})

test('the next half hour is asked for 5 minutes ahead, or 20 s of wall time at the replay rate when that is more', () => {
  assert.deepEqual([prefetchMs(1), prefetchMs(10), prefetchMs(60)], [5 * MIN, 5 * MIN, 20 * MIN], '1x and 10x: the 5 minutes; 60x: 20 s × 60')
  assert.equal(prefetchMs(NaN), 5 * MIN, 'a rate that is not a number gets the least')
})

test('at 60x the next half hour is asked for 20 minutes before the end, so its download never stalls the replay', () => {
  const maxMs = H + 10 * SLOT_MS // published far ahead: the next half hour is always there to ask for
  const asked = (rate: number, minLeft: number): boolean => wantedSlots(H + SLOT_MS - minLeft * MIN, maxMs, prefetchMs(rate)).length === 2
  assert.deepEqual([25, 19, 6, 4].map((left) => asked(1, left)), [false, false, false, true], '1x: from 5 minutes before')
  assert.deepEqual([25, 19, 6, 4].map((left) => asked(10, left)), [false, false, false, true], '10x: the same 5 minutes')
  assert.deepEqual([25, 19, 6, 4].map((left) => asked(60, left)), [false, true, true, true], '60x: from 20 minutes before')
})

test('a fresh fleet starts far enough back, and the track is fed far enough ahead, for the slice step', () => {
  assert.deepEqual([backMs(10), backMs(60), backMs(300)], [60_000, 90_000, 450_000])
  assert.deepEqual([lookaheadMs(10), lookaheadMs(30), lookaheadMs(300)], [20_000, 60_000, 600_000])
})

test("a missing half hour is not asked again for 10 minutes, a failed one for 15 s; the server's list rebuilds the missing ones", () => {
  const b = new SlotBlock()
  b.missing(H, 0)
  b.failed(H + SLOT_MS, 0)
  assert.deepEqual([b.blocked(H, 14_999), b.blocked(H + SLOT_MS, 14_999), b.isMissing(H, 14_999)], [true, true, true])
  assert.deepEqual([b.blocked(H + SLOT_MS, 15_000), b.isMissing(H + SLOT_MS, 15_000)], [false, false], 'failed: retried')
  assert.equal(b.blocked(H, 10 * MIN), false, 'missing: asked again after 10 min, as the server forgets too')
  b.missing(H, 0)
  b.fromStatus([{ slotMs: H, state: 'ready' }, { slotMs: H - SLOT_MS, state: 'missing' }], 1000)
  assert.deepEqual([b.isMissing(H, 1000), b.isMissing(H - SLOT_MS, 1000)], [false, true], 'the server has it now; the other is missing')
})

test('the half hour under the clock failing: only its own answers set and clear it; a prefetch failing or arriving says nothing of it', () => {
  const f = new SlotFailure()
  f.asked(H) // the one under the clock, and the next one ahead of time
  f.failed(H + SLOT_MS)
  assert.equal(f.failing, false, 'the next one failing: the one under the clock may well load')
  f.failed(H)
  assert.equal(f.failing, true)
  f.answered(H + SLOT_MS)
  assert.equal(f.failing, true, 'the next one arriving: the one under the clock is still not loaded')
  f.failed(H + SLOT_MS)
  f.asked(H)
  assert.equal(f.failing, true, 'asked again for the same half hour: failing until it answers')
  f.answered(H)
  assert.equal(f.failing, false, 'it loaded (or adsb.lol answered it has none: its own note)')
})

test('the half hour under the clock failing: the next one under the clock, or a jump, starts with none', () => {
  const f = new SlotFailure()
  f.asked(H)
  f.failed(H)
  f.asked(H + SLOT_MS)
  assert.equal(f.failing, false, 'played on into the next half hour (loaded ahead of time): not failing')
  f.failed(H)
  assert.equal(f.failing, false, 'the half hour left behind failing late says nothing')
  f.failed(H + SLOT_MS)
  assert.equal(f.failing, true)
  f.clear()
  assert.equal(f.failing, false, 'a jump: the new time says')
})

test('a leg covers the replay time from a minute before its first point to a minute after its last', () => {
  const leg = { t0Ms: H, t: [0, 600, 1200] } // 10:00 to 10:20
  assert.deepEqual([H - MIN, H + 10 * MIN, H + 21 * MIN].map((t) => legCovers(leg, t)), [true, true, true])
  assert.deepEqual([H - MIN - 1, H + 21 * MIN + 1].map((t) => legCovers(leg, t)), [false, false])
})

test("a half hour is asked for a wider circle than the view, within the view's slice step; a chase asks at least 100 nm", () => {
  assert.equal(askNm(100, false), 130)
  assert.equal(askNm(280, false), 300, 'capped at the band: a wider circle would be cut coarser')
  assert.equal(askNm(500, false), 650)
  assert.equal(askNm(20, false), 26)
  assert.equal(askNm(20, true), 100, 'the chase view moves with its aircraft: a small circle would be asked again every few seconds')
  assert.equal(askNm(5400, false), 5400)
})

test('a leg feeds the track only from its first point, to a minute after its last', () => {
  const leg = { t0Ms: H, t: [0, 600, 1200] } // 10:00 to 10:20
  assert.deepEqual([H - 1, H, H + 21 * MIN, H + 21 * MIN + 1].map((t) => legFeeds(leg, t)), [false, true, true, false])
})

test("an aircraft's info goes with its first sample in each half hour under the clock, and again after clear (a fresh fleet)", () => {
  const k = new KnownHexes()
  assert.deepEqual([k.first('738abc', H), k.first('738abc', H), k.first('aaaaaa', H)], [true, false, true])
  assert.deepEqual([k.first('738abc', H + SLOT_MS), k.first('738abc', H + SLOT_MS)], [true, false], 'the next half hour: once more')
  k.clear()
  assert.equal(k.first('738abc', H + SLOT_MS), true)
})

/** A sample of hex at tMs over Israel, as the feed makes one (the files carry no type). */
const sample = (hex: string, tMs: number): Sample => ({
  hex, tMs, rxMs: tMs, lat: 32, lon: 34.8, onGround: false, altBaroFt: 3000, altGeomFt: null, gsKt: 150, trackDeg: 90,
  trueHeadingDeg: null, rollDeg: null, baroRateFpm: null, geomRateFpm: null, navQnhHpa: null, version: null, nic: null,
  quality: 'adsb2', nM: 19.6, callsign: 'ISR595', typeCode: null, reg: null,
})
const INFO: AircraftInfo = {
  hex: '738abc', callsign: 'ISR595', reg: null, typeCode: 'B738', category: 'A3', squawk: null, emergency: null, military: false, route: null,
}

test('an aircraft heard again after the fleet forgot its info (an hour after its last sample) is given it again, not drawn as a triangle', () => {
  // app.ts feedHistory, as the clock plays: its info with the samples the gate lets it go with.
  const play = (fleet: Fleet, gate: (hex: string, clockMs: number) => boolean, tMs: number): void =>
    fleet.ingest([sample('738abc', tMs)], gate('738abc', tMs) ? [INFO] : undefined)
  const run = (gate: (hex: string, clockMs: number) => boolean): AircraftInfo | null => {
    const fleet = new Fleet()
    play(fleet, gate, H + 5 * MIN) // heard at 10:05
    fleet.prune(H + 10 * MIN, 60) // gone from the circle: dropped
    fleet.prune(H + 66 * MIN, 60) // an hour after its last sample the fleet forgets its info too
    play(fleet, gate, H + 70 * MIN) // back at 11:10
    return fleet.get('738abc')?.info ?? null
  }
  const seen = new Set<string>() // the old rule: an aircraft given its info once was known until a seek
  const once = (hex: string): boolean => {
    if (seen.has(hex)) return false
    seen.add(hex)
    return true
  }
  assert.equal(run(once), null, 'the old rule: no info, the generic arrow with no callsign or type')
  const known = new KnownHexes()
  assert.equal(run((hex, clockMs) => known.first(hex, slotOf(clockMs))), INFO, 'given again in the half hour it came back in')
})

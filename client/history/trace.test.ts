import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TraceReply } from '../../shared/api.ts'
import { legEndMs } from './aircraftDay.ts'
import { traceInfo, tracePath, traceSamples } from './trace.ts'

const TR: TraceReply = {
  hex: '4691c4', callsign: 'AEE4266', calls: [[0, 'AEE4266']], reg: 'SX-DND', typeCode: 'A320', t0Ms: 1_790_086_432_000,
  t: [0, 4.5, 9],
  lat: [34.14418, 34.13, 34.11], lon: [31.18918, 31.21, 31.25],
  alt: ['g', 37000, null], gs: [12, 451.2, null], trk: [90, 112.5, null], vs: [null, -64, 0], roll: [null, 0.4, null],
  nM: [20.1, 20.3, 20.4],
}

test('a trace becomes samples in time order, with its identity and the geoid N of each point', () => {
  const s = traceSamples(TR)
  assert.equal(s.length, 3)
  assert.deepEqual(s.map((x) => x.tMs), [1_790_086_432_000, 1_790_086_436_500, 1_790_086_441_000])
  assert.deepEqual([s[0].onGround, s[0].altBaroFt, s[1].onGround, s[1].altBaroFt, s[2].altBaroFt], [true, null, false, 37000, null])
  assert.deepEqual([s[1].gsKt, s[1].trackDeg, s[1].baroRateFpm, s[1].rollDeg, s[1].nM], [451.2, 112.5, -64, 0.4, 20.3])
  assert.deepEqual([s[1].hex, s[1].callsign, s[1].reg, s[1].typeCode, s[1].rxMs], ['4691c4', 'AEE4266', 'SX-DND', 'A320', s[1].tMs])
})

test('each sample carries the callsign the aircraft sent at its time, not the leg’s last', () => {
  const renamed: TraceReply = { ...TR, callsign: 'AEE4267', calls: [[0, 'AEE4266'], [4.5, 'AEE4267']] }
  assert.deepEqual(traceSamples(renamed).map((x) => x.callsign), ['AEE4266', 'AEE4267', 'AEE4267'], 'the point at the change has the new one')
  const late: TraceReply = { ...TR, callsign: 'AEE4267', calls: [[4.5, 'AEE4266'], [9, 'AEE4267']] } // heard first 4.5 s in
  assert.deepEqual(traceSamples(late).map((x) => x.callsign), ['AEE4266', 'AEE4266', 'AEE4267'], 'before the first call: the first')
  assert.deepEqual(traceSamples({ ...TR, callsign: 'AEE4267', calls: [] }).map((x) => x.callsign), ['AEE4267', 'AEE4267', 'AEE4267'], 'no calls: the leg’s')
})

test('the path points carry the time, the altitude for the colour and the height drawn (baro + N, ground: N)', () => {
  const p = tracePath(TR)
  assert.deepEqual(p.map((x) => [x.tMs, x.altFt, x.onGround]), [[1_790_086_432_000, null, true], [1_790_086_436_500, 37000, false], [1_790_086_441_000, null, false]])
  assert.equal(p[0].hM, 20.1)
  assert.ok(Math.abs(p[1].hM - (37000 * 0.3048 + 20.3)) < 1e-6)
})

test('its identity as the card shows it', () => {
  assert.deepEqual(traceInfo(TR), { hex: '4691c4', callsign: 'AEE4266', reg: 'SX-DND', typeCode: 'A320', category: null, squawk: null, emergency: null, military: false, route: null })
})

test('the samples’ and path points’ times are the leg’s whole ms (legMs): the last is the leg’s end, a change lands on its point', () => {
  const x: TraceReply = { ...TR, callsign: 'C', t: [0, 16.1, 32.2], calls: [[0, 'A'], [16.1, 'B'], [32.2, 'C']] } // 32.2 × 1000 is not whole
  assert.deepEqual(traceSamples(x).map((p) => p.tMs - x.t0Ms), [0, 16_100, 32_200])
  assert.deepEqual(tracePath(x).map((p) => p.tMs - x.t0Ms), [0, 16_100, 32_200])
  assert.equal(traceSamples(x).at(-1)!.tMs, legEndMs(x))
  assert.equal(tracePath(x).at(-1)!.tMs, legEndMs(x))
  assert.deepEqual(traceSamples(x).map((p) => p.callsign), ['A', 'B', 'C'])
})

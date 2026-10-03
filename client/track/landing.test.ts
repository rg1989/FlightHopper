// client/track/landing.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { distanceNm } from '../../shared/geo.ts'
import type { RunwayTable } from '../../shared/landing.ts'
import type { RenderState } from '../types.ts'
import { LandingEstimate } from './landing.ts'

// Saint John (CYSJ) as OurAirports has it; C-FRSJ, an Ercoupe on 7600, was last heard there on 2026-10-03 at 18:30:33 UTC:
// 450 ft, 62 kt, track 303°, 1,000 m before runway 32. The app held it there, in the air, under "Signal lost".
const CYSJ: RunwayTable = {
  airports: [['CYSJ', 'Saint John Airport']],
  runways: [[0, '05', 45.3025, -65.8942, 296, 0, '23', 45.3192, -65.8806, 304, 0], [0, '14', 45.3294, -65.9, 357, 0, '32', 45.3222, -65.8831, 314, 0]],
}
const CFRSJ: RenderState = {
  hex: 'c02ec2', lat: 45.318054, lon: -65.871473, hM: 120, headingDeg: 303, pitchDeg: 3, rollDeg: -4, gsKt: 62, trackDeg: 303, altBaroFt: 450, vsFpm: 0,
  mode: 'stale', altSource: 'baro-qnh', onGround: false, ageS: 8, quality: 'adsb2', callsign: 'CFRSJ', typeCode: 'ERCO', altMslFt: 450,
}
const metres = (a: { lat: number; lon: number }, lat: number, lon: number): number => distanceNm(a.lat, a.lon, lat, lon) * 1852
/** An estimate whose runways are in (the load is asked for by the first stale state, and answers at once). */
async function ready(table: RunwayTable = CYSJ): Promise<LandingEstimate> {
  const est = new LandingEstimate(() => Promise.resolve(table))
  est.apply(CFRSJ)
  await Promise.resolve()
  return est
}

test('a stale state on final to a runway flies on: C-FRSJ comes down to Saint John\'s runway 32, rolls out and stops', async () => {
  const est = await ready()
  const start = est.apply(CFRSJ) // the moment it froze: 8 s after its newest sample
  assert.ok(metres(start, CFRSJ.lat, CFRSJ.lon) < 0.5, 'from where it froze')
  assert.deepEqual([start.hM, start.onGround, start.landing], [120, false, { airport: 'Saint John Airport', runway: '32', landed: false }])
  const mid = est.apply({ ...CFRSJ, ageS: 8 + 20 })
  assert.deepEqual([mid.onGround, mid.gsKt, mid.rollDeg, mid.landing?.landed], [false, 62, 0, false])
  assert.equal(est.apply({ ...CFRSJ, ageS: 8 + 20, iasKt: 70 }).iasKt, null, 'the airspeed it last sent is not its airspeed now')
  assert.ok(mid.hM < 120 && mid.altBaroFt! < 450 && mid.vsFpm! < 0, 'coming down')
  assert.ok(Math.abs(mid.altMslFt! - mid.altBaroFt!) < 0.001 && mid.altMslFt! > 314)
  const later = est.apply({ ...CFRSJ, ageS: 1664 }) // 28 min: what the user's screen held in the air
  assert.deepEqual([later.onGround, later.gsKt, later.vsFpm, later.pitchDeg, later.altMslFt, later.landing], [true, 0, 0, 0, null, { airport: 'Saint John Airport', runway: '32', landed: true }])
  assert.ok(Math.abs(later.hM - (120 - (450 - 314) * 0.3048)) < 0.01, 'down by its height over the threshold')
  assert.equal(Math.round(later.altBaroFt!), 314)
  // On runway 32: between its ends, on the line through them.
  const toEnds = metres(later, 45.3222, -65.8831) + metres(later, 45.3294, -65.9)
  assert.ok(toEnds - metres({ lat: 45.3222, lon: -65.8831 }, 45.3294, -65.9) < 0.5, 'on the centreline')
  assert.ok(Math.abs(metres(later, 45.3222, -65.8831) - (300 + (62 * 0.514444) ** 2 / 3.6)) < 2, '300 m in, then 283 m of braking')
  assert.ok(Math.abs(later.headingDeg - 301.2) < 0.5 && later.trackDeg === later.headingDeg, 'along the runway')
  assert.deepEqual([later.hex, later.mode, later.ageS, later.callsign], ['c02ec2', 'stale', 1664, 'CFRSJ'], 'the rest is the state\'s')
})

test('the frozen pose stands: before the runways are in, when it was not landing, and with no speed, track or altitude known', async () => {
  const est = new LandingEstimate(() => Promise.resolve(CYSJ))
  assert.equal(est.apply(CFRSJ), CFRSJ, 'the runways are asked for by this state')
  await Promise.resolve()
  assert.notEqual(est.apply(CFRSJ), CFRSJ)
  const off = await ready()
  for (const s of [
    { ...CFRSJ, altBaroFt: 3500, altMslFt: 3500 }, // too high
    { ...CFRSJ, vsFpm: 900 }, // climbing: a go-around
    { ...CFRSJ, lat: 45.5 }, // no runway ahead
    { ...CFRSJ, gsKt: null }, { ...CFRSJ, trackDeg: null }, { ...CFRSJ, altBaroFt: null, altMslFt: null },
    { ...CFRSJ, onGround: true }, // heard on the ground: it is where it is
  ] as RenderState[]) assert.equal(off.apply(s), s)
  assert.equal((await ready({ airports: [], runways: [] })).apply(CFRSJ), CFRSJ, 'no runway in the table')
  const failed = new LandingEstimate(() => Promise.reject(new Error('404')))
  failed.apply(CFRSJ)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(failed.apply(CFRSJ), CFRSJ, 'the table did not load')
})

test('a state that is not stale is never changed, and ends the estimate: the next freeze is judged afresh', async () => {
  const est = await ready()
  assert.ok(est.apply({ ...CFRSJ, ageS: 100 }).landing !== undefined)
  const live = { ...CFRSJ, mode: 'interp' as const, ageS: 1 }
  assert.equal(est.apply(live), live)
  const extrap = { ...CFRSJ, mode: 'extrap' as const, ageS: 5 }
  assert.equal(est.apply(extrap), extrap)
  const climbing = { ...CFRSJ, vsFpm: 900, lat: 45.3181 } // heard again, going round; then lost again
  assert.equal(est.apply(climbing), climbing)
  assert.ok(est.apply(CFRSJ).landing !== undefined, 'and the first freeze again is a landing again')
})

test('a stale state is left alone until the signal counts as lost: the map\'s aircraft are stale between two answers of a wide view', async () => {
  const est = await ready()
  const between = { ...CFRSJ, ageS: 12 }
  assert.equal(est.apply(between, 25), between)
  assert.equal(est.apply({ ...CFRSJ, ageS: 26 }, 25).landing?.runway, '32')
  assert.equal(est.apply(between).landing?.runway, '32', 'chasing: from the freeze on')
})

test('the table is asked for once, and only when a stale state comes', async () => {
  let asks = 0
  const est = new LandingEstimate(() => (asks++, Promise.resolve(CYSJ)))
  est.apply({ ...CFRSJ, mode: 'interp' })
  assert.equal(asks, 0)
  est.apply(CFRSJ)
  est.apply(CFRSJ)
  await Promise.resolve()
  est.apply(CFRSJ)
  assert.equal(asks, 1)
})

test('the built table (public/airports/runways.json) holds Saint John, and C-FRSJ lands on its runway 32', async () => {
  const table = JSON.parse(readFileSync(new URL('../../public/airports/runways.json', import.meta.url), 'utf8')) as RunwayTable
  assert.ok(table.runways.length > 10_000)
  const est = await ready(table)
  assert.deepEqual(est.apply({ ...CFRSJ, ageS: 1664 }).landing, { airport: 'Saint John Airport', runway: '32', landed: true })
})

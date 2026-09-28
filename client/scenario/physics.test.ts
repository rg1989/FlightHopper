// client/scenario/physics.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { trueAirspeedKt } from '../track/airspeed.ts'
import { parseScenario } from './format.ts'
import { physicsReport } from './physics.ts'
import type { TrackRow } from './types.ts'

const KT = 1852 / 3600
const FT = 0.3048
const DEG = 180 / Math.PI

/** 1-Hz rows flying north: height (ft) and airspeed (kt) as functions of t; pitch = the path's angle through the air + 4°. */
function fly(n: number, altFt: (t: number) => number, iasKt: (t: number) => number, pitch?: (t: number) => number): TrackRow[] {
  let lat = 38.8
  return Array.from({ length: n }, (_, t) => {
    const vs = (altFt(t + 0.5) - altFt(t - 0.5)) * FT
    const tas = trueAirspeedKt(iasKt(t), altFt(t)) * KT
    const h = Math.sqrt(Math.max(0, tas * tas - vs * vs))
    const row: TrackRow = {
      t, lat, lon: -8.6, altFt: altFt(t), hdg: 0, pitch: pitch?.(t) ?? Math.asin(Math.min(1, Math.max(-1, vs / tas))) * DEG + 4,
      roll: 0, gnd: false, iasKt: iasKt(t), gsKt: null, vsFpm: null, g: null, windFromDeg: 0, windKt: 0, epr: null, q: 'R', src: null,
    }
    lat += h / 111_195
    return row
  })
}
// A dive from 10,000 ft: 5,000 ft down over 30 s from 60 s on, then level.
const dive = (t: number): number => (t < 60 ? 10_000 : t < 90 ? 10_000 - 5_000 * ((1 - Math.cos((Math.PI * (t - 60)) / 30)) / 2) : 5_000)
const ramp = (t: number, a: number, b: number): number => (t < 60 ? a : t < 90 ? a + (b - a) * ((t - 60) / 30) : b)

test('a dive that trades its height for speed passes', () => {
  const r = physicsReport(fly(160, dive, (t) => ramp(t, 200, 290)))
  assert.deepEqual(r.problems, [])
  assert.ok(r.alpha[0] > 3.5 && r.alpha[1] < 4.6, `the nose 4° above the path: ${r.alpha}`)
})

test('a dive in which the airspeed falls (two sources on two clocks) breaks the energy limit', () => {
  const r = physicsReport(fly(160, dive, (t) => ramp(t, 290, 180)))
  assert.ok(r.problems.some((p) => p.startsWith('energy changes')), r.problems.join('; '))
})

test('a pitch that is not the path\'s (a nose held level in a dive) breaks the angle-of-attack limit', () => {
  const r = physicsReport(fly(160, dive, (t) => ramp(t, 200, 290), () => 0))
  assert.ok(r.problems.some((p) => p.includes('above the path')), r.problems.join('; '))
})

test('a vertical speed faster than the airspeed is no flight', () => {
  const r = physicsReport(fly(160, (t) => (t < 60 ? 10_000 : Math.max(0, 10_000 - 300 * (t - 60))), () => 150))
  assert.ok(r.problems.some((p) => p.startsWith('the vertical speed reaches')), r.problems.join('; '))
})

test('over the ground at its airspeed plus the wind the track gives, else flagged', () => {
  const rows = fly(160, () => 8_000, () => 250)
  assert.deepEqual(physicsReport(rows).problems, [])
  const wrongWind = rows.map((r) => ({ ...r, windFromDeg: 180, windKt: 120 })) // a 120-kt tailwind it does not show
  assert.ok(physicsReport(wrongWind).problems.some((p) => p.startsWith('over the ground')))
})

// ---- every real package (npm test fails if a shipped package is not physically possible) ----------------------------

test('every package under public/scenarios flies like an airliner', async (t) => {
  const root = path.resolve(import.meta.dirname, '../../public/scenarios')
  const index = JSON.parse(await readFile(path.join(root, 'index.json'), 'utf8')) as { scenarios: string[] }
  for (const id of index.scenarios) {
    const dir = path.join(root, id)
    const s = parseScenario({
      base: `${dir}/`,
      manifest: JSON.parse(await readFile(path.join(dir, 'scenario.json'), 'utf8')),
      track: await readFile(path.join(dir, 'track.csv'), 'utf8'),
      events: await readFile(path.join(dir, 'events.csv'), 'utf8').catch(() => null),
      transcript: await readFile(path.join(dir, 'transcript.csv'), 'utf8').catch(() => null),
      present: { body: false, finLogo: false, audio: false },
    })
    const r = physicsReport(s.track)
    t.diagnostic(`${id}: ${r.rows} rows; steepest ${r.steep.toFixed(2)} TAS; α ${r.alpha[0].toFixed(1)}…${r.alpha[1].toFixed(1)}°; Ps ${r.ps12.toFixed(0)}/${r.ps30.toFixed(0)} m/s (12/30 s); air ${r.airP99Kt?.toFixed(0) ?? '—'} kt p99`)
    assert.deepEqual(r.problems, [], id)
  }
})

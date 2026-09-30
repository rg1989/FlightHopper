// client/scenario/fromRecording.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RecordingInfo } from '../../shared/api.ts'
import type { Sample } from '../../shared/types.ts'
import { destination } from '../../shared/geo.ts'
import { recordingFile, recordingId, recordingScenario } from './fromRecording.ts'
import { physicsReport } from './physics.ts'

const T0 = Date.UTC(2026, 8, 30, 10, 0, 0)
const FILE = '2026-09-30/100000Z-ELY315-738abc.jsonl'
const INFO: RecordingInfo = {
  file: FILE, hex: '738abc', callsign: 'ELY315', reg: '4X-EKA', typeCode: 'B738', category: 'A3', military: false,
  route: 'LLBG-EGLL', source: 'adsbfi', startedMs: T0, firstMs: T0, lastMs: null, samples: 0, ended: null, active: false,
}

/** A take-off from Ben Gurion on 300°: 40 s rolling to 150 kt, then a climb at 160 kt and 2,000 fpm, a sample every 2 s. */
function takeOff(): Sample[] {
  const out: Sample[] = []
  let at = { lat: 32.0, lon: 34.87 }
  for (let i = 0; i <= 100; i++) {
    const t = i * 2
    const ground = t < 40
    const gs = ground ? Math.min(150, t * 4) : 160
    if (i > 0) at = destination(at.lat, at.lon, 300, (gs * 2) / 3600)
    const alt = ground ? null : Math.round(((t - 40) * 2000) / 60 / 25) * 25 + 135
    out.push({
      hex: '738abc', tMs: T0 + t * 1000, rxMs: T0 + t * 1000 + 800, lat: at.lat, lon: at.lon, onGround: ground,
      altBaroFt: alt, altGeomFt: alt === null ? null : alt + 150, gsKt: gs, trackDeg: 300, trueHeadingDeg: null, rollDeg: null,
      baroRateFpm: ground ? 0 : 2000, geomRateFpm: null, navQnhHpa: null, version: 2, nic: 8, quality: 'adsb2', nM: 18,
      callsign: 'ELY315', typeCode: 'B738', reg: '4X-EKA',
    } as Sample)
  }
  return out
}

test('recordingId / recordingFile: a recording\'s scenario id and back; a package id names no file', () => {
  assert.equal(recordingId(FILE), 'rec:2026-09-30/100000Z-ELY315-738abc')
  assert.equal(recordingFile(recordingId(FILE)), FILE)
  assert.equal(recordingFile('jal123'), null)
})

test('recordingScenario: a row a second over the whole recording, UTC, on the live estimator; take-off marked; gear by height', () => {
  const samples = takeOff()
  const s = recordingScenario({ info: INFO, samples: [...samples].reverse() }, 'b738')!
  assert.equal(s.id, 'rec:2026-09-30/100000Z-ELY315-738abc')
  assert.deepEqual([s.title, s.subtitle, s.date, s.clockLabel, s.aircraft.model, s.aircraft.registration], ['ELY315', 'LLBG → EGLL', '2026-09-30', 'UTC', 'b738', '4X-EKA'])
  assert.equal(s.gearFromHeight, true)
  assert.equal(s.t0UtcMs + s.start * 1000, T0)
  assert.equal(s.end - s.start, 200)
  assert.equal(s.track.length, 201)
  for (let i = 1; i < s.track.length; i++) assert.equal(s.track[i].t - s.track[i - 1].t, 1)
  const lift = s.events.find((e) => e.label === 'Take-off')
  assert.ok(lift && Math.abs(s.t0UtcMs + lift.t * 1000 - (T0 + 40_000)) <= 2000, 'take-off marked when the wheels leave')
  const end = s.track.at(-1)!
  assert.ok(Math.abs(end.altFt - (135 + (160 * 2000) / 60 + 150 - 18 / 0.3048)) < 150, `climbs: ${end.altFt} ft MSL at the end`)
  assert.ok(Math.abs(end.hdg - 300) < 5, `nose on the track: ${end.hdg}`)
  assert.ok(end.pitch > 3 && end.pitch < 15, `climbing nose-up: ${end.pitch}°`)
  assert.deepEqual(physicsReport(s.track).problems, [], 'the packages\' physics gate passes')
})

test('recordingScenario: too little to play is null', () => {
  assert.equal(recordingScenario({ info: INFO, samples: [] }, 'b738'), null)
  assert.equal(recordingScenario({ info: INFO, samples: takeOff().slice(0, 1) }, 'b738'), null)
})

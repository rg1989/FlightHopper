// server/flightLog.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AircraftInfo } from '../shared/info.ts'
import type { Sample } from '../shared/types.ts'
import { FlightLog, LANDED_HOLD_MS, LOST_MS } from './flightLog.ts'

const T0 = Date.UTC(2026, 8, 30, 14, 30, 12)
const INFO: AircraftInfo = { hex: '738abc', callsign: 'ELY315', reg: '4X-EKA', typeCode: 'B738', category: 'A3', squawk: null, emergency: null, military: false, route: 'LLBG-EGLL' }

const sample = (rxMs: number, o: Partial<Sample> = {}): Sample =>
  ({ hex: '738abc', tMs: rxMs, rxMs, lat: 32, lon: 34.9, onGround: false, altBaroFt: 3000, gsKt: 160, ...o }) as Sample

function setup() {
  const clock = { t: T0 }
  const dir = mkdtempSync(join(tmpdir(), 'fh-flights-'))
  const log = new FlightLog({ dir, source: 'adsbfi', nowMs: () => clock.t })
  const lines = (file: string) => readFileSync(join(dir, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  return { clock, dir, log, lines }
}

test('a recording: header, the backfill, each new sample of that aircraft only, and an end line', () => {
  const { clock, log, lines } = setup()
  const rec = log.start('738ABC', INFO, [sample(T0 - 2000), sample(T0 - 1000)])
  assert.equal(rec.file, '2026-09-30/143012Z-ELY315-738abc.jsonl')
  assert.deepEqual(log.hexes(), ['738abc'])
  assert.equal(log.start('738abc', INFO, []).samples, 2, 'starting again changes nothing')
  log.add(sample(T0 + 1000))
  log.add(sample(T0 + 1000, { hex: '111111' }))
  clock.t += 5000
  assert.equal(log.get('738abc')?.samples, 3)
  assert.equal(log.stop('738abc')?.lastMs, T0 + 1000)
  assert.equal(log.stop('738abc'), null)
  const l = lines(rec.file)
  assert.deepEqual(l[0].flight, { v: 1, hex: '738abc', callsign: 'ELY315', reg: '4X-EKA', typeCode: 'B738', route: 'LLBG-EGLL', source: 'adsbfi', by: 'hand', startedMs: T0 })
  assert.deepEqual(l.slice(1, 4).map((x) => x.s.rxMs), [T0 - 2000, T0 - 1000, T0 + 1000])
  assert.deepEqual(l[4], { end: { why: 'stopped', endedMs: T0 + 5000, samples: 3 } })
  assert.deepEqual(log.active(), [])
})

test('ends by itself: landed (slow on the ground for a minute after flying), or silent for 15 min', () => {
  const { clock, log, lines } = setup()
  // Taxiing out when recording starts: slow on the ground, but it has not flown yet, so it has not landed.
  log.start('738abc', INFO, [sample(T0, { onGround: true, gsKt: 15 })])
  clock.t += LANDED_HOLD_MS + 1000
  log.tick()
  assert.equal(log.active().length, 1)
  log.add(sample(clock.t, { onGround: false, gsKt: 150 }))
  log.add(sample(clock.t + 1000, { onGround: true, gsKt: 120 })) // touchdown, rolling out: not yet
  log.add(sample(clock.t + 20_000, { onGround: true, gsKt: 30 }))
  clock.t += 20_000 + LANDED_HOLD_MS - 1
  log.tick()
  assert.equal(log.active().length, 1)
  clock.t += 1
  log.tick()
  assert.equal(log.active().length, 0)
  assert.equal(lines(log.get('738abc')?.file ?? '2026-09-30/143012Z-ELY315-738abc.jsonl').at(-1).end.why, 'landed')

  const b = setup()
  b.log.start('738abc', INFO, [sample(T0)])
  b.clock.t = T0 + LOST_MS - 1
  b.log.tick()
  assert.equal(b.log.active().length, 1)
  b.clock.t = T0 + LOST_MS
  b.log.tick()
  assert.equal(b.lines('2026-09-30/143012Z-ELY315-738abc.jsonl').at(-1).end.why, 'lost')
})

test('a restarted server carries on the recordings under way, in the same files', () => {
  const { clock, dir, log, lines } = setup()
  const rec = log.start('738abc', INFO, [sample(T0)])
  const again = new FlightLog({ dir, source: 'adsbfi', nowMs: () => clock.t })
  assert.deepEqual(again.get('738abc'), rec)
  again.add(sample(T0 + 1000))
  again.stop('738abc')
  assert.deepEqual(lines(rec.file).map((x) => Object.keys(x)[0]), ['flight', 's', 's', 'end'])
  assert.deepEqual(new FlightLog({ dir, source: 'adsbfi' }).active(), [])
})

// tools/datum-check.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RecordLine } from '../server/recording.ts'
import type { Airport } from '../shared/airports.ts'
import { destination } from '../shared/geo.ts'
import { geoidN } from '../shared/geoid.ts'
import { loadInputs, run, samplesNear } from './datum-check.ts'

const AIRPORTS = fileURLToPath(new URL('../data/fixtures/golden/airports-sample.json', import.meta.url))
const ksfo = (JSON.parse(readFileSync(AIRPORTS, 'utf8')) as Airport[]).find((a) => a.ident === 'KSFO')!
const e28r = ksfo.runways.flatMap((r) => r.ends).find((e) => e.ident === '28R')!
const URL_KSFO = 'https://api.adsb.lol/v2/point/37.6188/-122.3758/40'
const T0 = 1_790_000_000_000

/** adsb.lol aircraft object dNm before 28R on the 3° path; alt_geom is HAE (or MSL when msl). */
function aircraft(hex: string, dNm: number, msl = false): Record<string, unknown> {
  const p = destination(e28r.thrLat, e28r.thrLon, e28r.hdgTrueDeg + 180, dNm)
  const haeM = e28r.thrHaeM + 15 + dNm * 1852 * Math.tan((3 * Math.PI) / 180)
  const geomM = msl ? haeM - geoidN(p.lat, p.lon) : haeM
  const baroFt = Math.round((haeM - geoidN(p.lat, p.lon)) / 0.3048 / 25) * 25
  return { hex, type: 'adsb_icao', flight: 'TST1    ', version: 2, lat: p.lat, lon: p.lon, alt_baro: baroFt, alt_geom: Math.round(geomM / 0.3048), gs: 140, track: e28r.hdgTrueDeg, nic: 8, seen_pos: 0.2 }
}

const line = (nowMs: number, ac: unknown[], status = 200): string => {
  const body = status === 200 ? JSON.stringify({ ac, now: nowMs, msg: 'No error' }) : ''
  const r: RecordLine = { v: 1, source: 'adsblol', url: URL_KSFO, status, tSendMs: nowMs - 100, tRecvMs: nowMs + 150, bytes: body.length, body }
  return JSON.stringify(r)
}

/** One arrival polled every 2 s from 3 nm to 0.2 nm, starting t0Ms; every 5th poll is re-served 1 s later. */
function arrivalLines(hex: string, t0Ms: number, msl = false): string[] {
  const out: string[] = []
  for (let k = 0; ; k++) {
    const d = 3 - k * 0.0778
    if (d < 0.2) return out
    const l = line(t0Ms + k * 2000, [aircraft(hex, d, msl)])
    out.push(l)
    if (k % 5 === 0) out.push(l.replace(/"tRecvMs":(\d+)/, (_, t) => `"tRecvMs":${Number(t) + 1000}`))
  }
}

/** Two day files: arrival 1 (+ a 429) in the first, arrivals 2 and 3 in the second. */
function recordingDir(msl = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'fh-datum-'))
  writeFileSync(join(dir, '2026-09-22.jsonl'), [...arrivalLines('a00001', T0, msl), line(T0 + 200_000, [], 429)].join('\n') + '\n')
  writeFileSync(join(dir, '2026-09-23.jsonl'), [...arrivalLines('a00002', T0 + 86_400_000, msl), ...arrivalLines('a00003', T0 + 90_000_000, msl)].join('\n') + '\n')
  return dir
}

test('loadInputs: a quoted glob, or shell-expanded files after --recordings, give the same sorted inputs', async () => {
  const dir = recordingDir()
  const a = await loadInputs(['--recordings', join(dir, '*.jsonl'), '--airports', AIRPORTS, '--airport', 'ksfo'])
  const b = await loadInputs(['--recordings', join(dir, '2026-09-23.jsonl'), join(dir, '2026-09-22.jsonl'), '--airports', AIRPORTS, '--airport', 'KSFO'])
  assert.deepEqual(a.files, [join(dir, '2026-09-22.jsonl'), join(dir, '2026-09-23.jsonl')])
  assert.deepEqual(b, a)
  assert.equal(a.airport.ident, 'KSFO')
  assert.equal(a.out, '.planning/reports')
})

test('loadInputs: missing airport or recordings are errors', async () => {
  const dir = recordingDir()
  await assert.rejects(loadInputs(['--recordings', join(dir, '*.jsonl'), '--airports', AIRPORTS]), /--airport/)
  await assert.rejects(loadInputs(['--recordings', join(dir, '*.jsonl'), '--airports', AIRPORTS, '--airport', 'EGLL']), /EGLL/)
  await assert.rejects(loadInputs(['--recordings', join(dir, '*.nothing'), '--airports', AIRPORTS, '--airport', 'KSFO']), /no recordings/)
})

test('samplesNear: chunked decoding gives exactly the single-pass samples (re-serves across chunk edges dropped)', async () => {
  const dir = recordingDir()
  const files = readdirSync(dir).sort().map((f) => join(dir, f))
  const whole = await samplesNear(files, ksfo, 15)
  assert.equal(whole.length, 3 * 36) // 36 distinct positions per arrival (3 nm → 0.28 nm)
  assert.deepEqual(await samplesNear(files, ksfo, 15, 3), whole)
  assert.deepEqual(await samplesNear(files, ksfo, 15, 1), whole)
  assert.equal((await samplesNear(files, { ...ksfo, lat: ksfo.lat + 1 }, 15)).length, 0)
})

test('run: HAE alt_geom passes, prints and writes datum-KSFO-<date>.json', async () => {
  const dir = recordingDir()
  const out = join(dir, 'reports')
  const r = await run(['--recordings', join(dir, '*.jsonl'), '--airports', AIRPORTS, '--airport', 'KSFO', '--out', out])
  assert.equal(r.summary.pass, true)
  assert.equal(r.summary.arrivals, 3)
  assert.ok(Math.abs(r.summary.medianM) < 1, `median ${r.summary.medianM}`) // alt_geom is rounded to 1 ft on the wire
  assert.equal(r.runwayEnds.find((e) => e.ident === '28R')!.arrivals, 3)
  assert.equal(r.notV2.n, 0)
  const [file] = readdirSync(out)
  assert.match(file, /^datum-KSFO-\d{4}-\d{2}-\d{2}\.json$/)
  assert.deepEqual(JSON.parse(readFileSync(join(out, file), 'utf8')).summary, r.summary)
})

test('run: MSL alt_geom fails with median ≈ +32 m at KSFO', async () => {
  const dir = recordingDir(true)
  const r = await run(['--recordings', join(dir, '*.jsonl'), '--airports', AIRPORTS, '--airport', 'KSFO', '--out', join(dir, 'reports')])
  assert.equal(r.summary.pass, false)
  assert.ok(Math.abs(r.summary.medianM - 32.2) < 1, `median ${r.summary.medianM}`)
})

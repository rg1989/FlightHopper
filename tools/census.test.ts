// tools/census.test.ts
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
import { run } from './census.ts'

const AIRPORTS = fileURLToPath(new URL('../data/fixtures/golden/airports-sample.json', import.meta.url))
const ksfo = (JSON.parse(readFileSync(AIRPORTS, 'utf8')) as Airport[]).find((a) => a.ident === 'KSFO')!
const e28r = ksfo.runways.flatMap((r) => r.ends).find((e) => e.ident === '28R')!
const T0 = 1_790_000_000_000
const MPS = (140 * 1852) / 3600

/** RecordLines for one 28R arrival from 12 nm, polled every 2 s; lostBelowFt ends coverage early, else 5 ground polls. */
function arrivalLines(hex: string, t0Ms: number, lostBelowFt?: number): string[] {
  const out: string[] = []
  const poll = (tS: number, ac: Record<string, unknown>): void => {
    const now = t0Ms + tS * 1000
    const body = JSON.stringify({ ac: [{ hex, type: 'adsb_icao', flight: 'TST1    ', version: 2, nic: 8, seen_pos: 0.3, ...ac }], now })
    const r: RecordLine = { v: 1, source: 'adsblol', url: 'https://api.adsb.lol/v2/point/37.6188/-122.3758/40', status: 200, tSendMs: now - 90, tRecvMs: now + 120, bytes: body.length, body }
    out.push(JSON.stringify(r))
  }
  let t = 0
  for (; ; t += 2) {
    const d = 12 - (t * MPS) / 1852
    if (d <= 0) break
    const aglFt = (15 + d * 1852 * Math.tan((3 * Math.PI) / 180)) / 0.3048
    if (lostBelowFt !== undefined && aglFt < lostBelowFt) return out
    const p = destination(e28r.thrLat, e28r.thrLon, e28r.hdgTrueDeg + 180, d)
    const mslFt = e28r.elevFt + aglFt
    poll(t, { lat: p.lat, lon: p.lon, alt_baro: Math.round(mslFt / 25) * 25, alt_geom: Math.round(mslFt + geoidN(p.lat, p.lon) / 0.3048), gs: 140, track: e28r.hdgTrueDeg })
  }
  for (let k = 0; k < 5; k++, t += 2) {
    const p = destination(e28r.thrLat, e28r.thrLon, e28r.hdgTrueDeg, 0.1 + k * 0.05)
    poll(t, { lat: p.lat, lon: p.lon, alt_baro: 'ground', gs: 100 - 15 * k, track: e28r.hdgTrueDeg })
  }
  return out
}

function recording(arrivals: [hex: string, lostBelowFt?: number][]): string {
  const dir = mkdtempSync(join(tmpdir(), 'fh-census-'))
  const lines = arrivals.flatMap(([hex, lost], i) => arrivalLines(hex, T0 + i * 1_800_000, lost))
  writeFileSync(join(dir, '2026-09-22.jsonl'), lines.join('\n') + '\n')
  return dir
}

test('run: one arrival to the ground, one lost at 2,500 ft → 50 % tracked, not a landing hero', async () => {
  const dir = recording([['a00001'], ['a00002', 2500]])
  const out = join(dir, 'reports')
  const r = await run(['--recordings', join(dir, '*.jsonl'), '--airports', AIRPORTS, '--airport', 'KSFO', '--out', out])
  assert.equal(r.summary.arrivals, 2)
  assert.equal(r.summary.trackedBelow200Pct, 50)
  assert.equal(r.summary.landingHeroOk, false)
  assert.deepEqual(r.arrivals.map((a) => [a.hex, a.callsign, a.reachedGround]), [['a00001', 'TST1', true], ['a00002', 'TST1', false]])
  assert.equal(r.summary.p90GapBelow1000S, 2)
  assert.equal(r.summary.geomSharePct, 100)
  const [file] = readdirSync(out)
  assert.match(file, /^census-KSFO-\d{4}-\d{2}-\d{2}\.json$/)
  assert.deepEqual(JSON.parse(readFileSync(join(out, file), 'utf8')).summary, r.summary)
})

test('run: four of five arrivals tracked to the ground → landing hero ok', async () => {
  const dir = recording([['a00001'], ['a00002'], ['a00003', 2500], ['a00004'], ['a00005']])
  const r = await run([join(dir, '2026-09-22.jsonl'), '--airport', 'KSFO', '--airports', AIRPORTS, '--out', join(dir, 'reports')])
  assert.equal(r.summary.arrivals, 5)
  assert.equal(r.summary.trackedBelow200Pct, 80)
  assert.equal(r.summary.landingHeroOk, true)
  assert.equal(r.arrivalsWithJumps, 0)
})

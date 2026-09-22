// tools/record-arrivals.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TokenBucket } from '../server/budget.ts'
import { Recorder } from '../server/recorder.ts'
import { readRecording } from '../server/recording.ts'
import type { FetchResult, Source } from '../server/sources/types.ts'
import { SampleStore } from '../server/store.ts'
import { destination, distanceNm } from '../shared/geo.ts'
import { normalizeAdsblol } from '../shared/readsb.ts'
import type { ReadsbAircraft, Sample } from '../shared/types.ts'
import { arrivalLoop, HEROES, pickArrivals, type Hero } from './record-arrivals.ts'

const hero = (ident: string): Hero => HEROES.find((h) => h.ident === ident)!
const KSFO = hero('KSFO')
const LOWI = hero('LOWI')

/** A sample `nm` from the hero on bearing 120°, descending through 3,000 ft unless overridden. */
function smp(hex: string, h: Hero, nm: number, over: Partial<Sample> = {}): Sample {
  const p = destination(h.lat, h.lon, 120, nm)
  return {
    hex, tMs: 1000, rxMs: 1000, lat: p.lat, lon: p.lon, onGround: false, altBaroFt: 3000, altGeomFt: null, gsKt: 160,
    trackDeg: 300, trueHeadingDeg: null, rollDeg: null, baroRateFpm: -800, geomRateFpm: null, navQnhHpa: null,
    version: 2, nic: 8, quality: 'adsb2', nM: 0, callsign: null, typeCode: null, reg: null, ...over,
  }
}

test('pickArrivals: low, descending, within 25 nm of a hero', () => {
  assert.deepEqual(pickArrivals([smp('a00001', KSFO, 10)], HEROES), ['a00001'])
  assert.deepEqual(pickArrivals([smp('a00002', KSFO, 24.5)], HEROES), ['a00002'])
  assert.deepEqual(pickArrivals([smp('a00003', KSFO, 26)], HEROES), [])
})

test('pickArrivals: below 10,000 ft above the field', () => {
  assert.deepEqual(pickArrivals([smp('a00001', KSFO, 10, { altBaroFt: 10_500 })], HEROES), [])
  assert.deepEqual(pickArrivals([smp('a00002', KSFO, 10, { altBaroFt: 9900 })], HEROES), ['a00002'])
  // LOWI's field is at 1,907 ft: 11,000 ft MSL in the Inn valley is 9,093 ft above it
  assert.deepEqual(pickArrivals([smp('a00003', LOWI, 15, { altBaroFt: 11_000 })], HEROES), ['a00003'])
  assert.deepEqual(pickArrivals([smp('a00004', LOWI, 15, { altBaroFt: 12_000 })], HEROES), [])
})

test('pickArrivals: must be descending faster than 300 fpm (baro rate, else geometric rate)', () => {
  assert.deepEqual(pickArrivals([smp('a00001', KSFO, 10, { baroRateFpm: -200 })], HEROES), [])
  assert.deepEqual(pickArrivals([smp('a00002', KSFO, 10, { baroRateFpm: 1500 })], HEROES), [])
  assert.deepEqual(pickArrivals([smp('a00003', KSFO, 10, { baroRateFpm: null, geomRateFpm: -704 })], HEROES), ['a00003'])
  assert.deepEqual(pickArrivals([smp('a00004', KSFO, 10, { baroRateFpm: null })], HEROES), [])
})

test('pickArrivals: no baro altitude falls back to geometric altitude', () => {
  assert.deepEqual(pickArrivals([smp('a00001', KSFO, 10, { altBaroFt: null, altGeomFt: 2500 })], HEROES), ['a00001'])
  assert.deepEqual(pickArrivals([smp('a00002', KSFO, 10, { altBaroFt: null })], HEROES), [])
})

test('pickArrivals: on the ground only while rolling faster than 30 kt', () => {
  const ground = { onGround: true, altBaroFt: null, baroRateFpm: null }
  assert.deepEqual(pickArrivals([smp('a00001', KSFO, 0.5, { ...ground, gsKt: 120 })], HEROES), ['a00001'])
  assert.deepEqual(pickArrivals([smp('a00002', KSFO, 0.5, { ...ground, gsKt: 12 })], HEROES), [])
  assert.deepEqual(pickArrivals([smp('a00003', KSFO, 0.5, { ...ground, gsKt: null })], HEROES), [])
})

test('pickArrivals: the latest sample of each hex decides, whatever the array order', () => {
  const landed = smp('a00001', KSFO, 0.5, { tMs: 9000, onGround: true, altBaroFt: null, baroRateFpm: null, gsKt: 15 })
  const approach = smp('a00001', KSFO, 8, { tMs: 5000 })
  assert.deepEqual(pickArrivals([landed, approach], HEROES), [])
  assert.deepEqual(pickArrivals([approach, landed], HEROES), [])
  const later = smp('a00002', KSFO, 8, { tMs: 9000 })
  const climbing = smp('a00002', KSFO, 4, { tMs: 5000, baroRateFpm: 2000 })
  assert.deepEqual(pickArrivals([later, climbing], HEROES), ['a00002'])
})

test('pickArrivals: one entry per hex even when near two heroes', () => {
  const twin: Hero = { ident: 'TWIN', lat: KSFO.lat + 0.1, lon: KSFO.lon, elevFt: 0 }
  assert.deepEqual(pickArrivals([smp('a00001', KSFO, 5), smp('a00001', KSFO, 5)], [KSFO, twin]), ['a00001'])
})

test('HEROES: the three hero airports with field elevations', () => {
  assert.deepEqual(HEROES.map((h) => h.ident), ['KSFO', 'LLBG', 'LOWI'])
  assert.deepEqual(HEROES.map((h) => h.elevFt), [13, 135, 1907])
})

// ---- the polling loop, driven by a fake adsb.lol and a fake clock ----

interface Call {
  t: number
  m: 'circle' | 'hexes'
  args: unknown[]
}

/** Aircraft seen by the fake upstream. seen_pos 0: the positions are current at every poll. */
function aircraft(hex: string, h: Hero, nm: number, over: Partial<ReadsbAircraft> = {}): ReadsbAircraft {
  const p = destination(h.lat, h.lon, 120, nm)
  return { hex, type: 'adsb_icao', version: 2, lat: p.lat, lon: p.lon, alt_baro: 3000, gs: 160, baro_rate: -800, seen_pos: 0, ...over }
}

function fakeAdsblol(clock: { t: number }, world: ReadsbAircraft[]) {
  const calls: Call[] = []
  const replies: { status: number; retryAfterS?: number }[] = []
  const reply = (m: Call['m'], args: unknown[], ac: ReadsbAircraft[]): Promise<FetchResult> => {
    calls.push({ t: clock.t, m, args })
    const { status, retryAfterS } = replies.shift() ?? { status: 200 }
    const body = status === 200 ? JSON.stringify({ ac, msg: 'No error', now: clock.t - 250 }) : ''
    return Promise.resolve({
      url: `fake:${m}`, status, tSendMs: clock.t, tRecvMs: clock.t, bytes: body.length, body,
      retryAfterS: retryAfterS ?? null, snapshot: status === 200 ? normalizeAdsblol(body) : null,
    })
  }
  const source: Source = {
    caps: { kind: 'adsblol', fullSnapshot: false, maxRps: 1, coverage: null, attribution: 'test' },
    circle: (lat, lon, nm) => reply('circle', [lat, lon, nm], world.filter((a) => distanceNm(lat, lon, a.lat!, a.lon!) <= nm)),
    hexes: (hexes) => reply('hexes', [hexes], world.filter((a) => hexes.includes(a.hex))),
    all: () => Promise.reject(new Error('unsupported')),
  }
  return { source, calls, replies }
}

const T0 = 1_790_000_000_000

function setup(o: { world?: ReadsbAircraft[]; maxRps?: number; recorder?: Recorder } = {}) {
  const clock = { t: T0 }
  const f = fakeAdsblol(clock, o.world ?? [])
  const bucket = new TokenBucket(o.maxRps ?? 10, () => clock.t, () => 0)
  const logs: string[] = []
  const loop = arrivalLoop({
    source: f.source, bucket, store: new SampleStore(), recorder: o.recorder ?? null, heroes: HEROES,
    nowMs: () => clock.t, log: (l) => logs.push(l),
  })
  return { clock, bucket, loop, logs, ...f }
}

/** Steps every 100 ms up to and including T0 + untilMs; returns the step results. */
async function runUntil(s: ReturnType<typeof setup>, untilMs: number): Promise<string[]> {
  const out: string[] = []
  for (; s.clock.t <= T0 + untilMs; s.clock.t += 100) out.push(await s.loop.step())
  return out
}

const rel = (calls: Call[], m?: Call['m']): number[] => calls.filter((c) => m === undefined || c.m === m).map((c) => c.t - T0)

test('loop: hero cells round-robin, each every 6 s at 40 nm; no hex batch without arrivals', async () => {
  const s = setup()
  await runUntil(s, 12_500)
  assert.deepEqual(rel(s.calls), [0, 100, 200, 6000, 6100, 6200, 12_000, 12_100, 12_200])
  assert.deepEqual(s.calls.slice(0, 3).map((c) => c.args), HEROES.map((h) => [h.lat, h.lon, 40]))
  assert.deepEqual(s.loop.picked(), [])
})

test('loop: an arrival seen in a cell is followed with a batched hex poll every second', async () => {
  const world = [
    aircraft('a00001', KSFO, 12), // arriving
    aircraft('a00002', KSFO, 12, { baro_rate: 2500 }), // departing
    aircraft('a00003', KSFO, 30, { alt_baro: 35_000, baro_rate: 0 }), // cruising overhead
    aircraft('a00004', LOWI, 10, { alt_baro: 8000 }), // arriving at LOWI
  ]
  const s = setup({ world })
  await runUntil(s, 5000)
  // KSFO cell at 0 finds a00001 → hex batch at 100; LLBG, LOWI cells next; then a00001 + a00004 every second
  assert.deepEqual(s.calls.slice(0, 4).map((c) => [c.t - T0, c.m]), [[0, 'circle'], [100, 'hexes'], [200, 'circle'], [300, 'circle']])
  assert.deepEqual(s.calls[1].args, [['a00001']])
  assert.deepEqual(rel(s.calls, 'hexes'), [100, 1100, 2100, 3100, 4100])
  assert.deepEqual(s.calls[4].args, [['a00001', 'a00004']])
  assert.deepEqual(s.loop.picked(), ['a00001', 'a00004'])
  assert.ok(s.logs.some((l) => l.includes('a00001')), s.logs.join('\n'))
})

test('loop: LADD/PIA aircraft are never followed', async () => {
  const s = setup({ world: [aircraft('000001', KSFO, 12, { dbFlags: 8 })] })
  await runUntil(s, 3000)
  assert.deepEqual(rel(s.calls, 'hexes'), [])
  assert.deepEqual(s.loop.picked(), [])
})

test('loop: never more than --max-rps, even when cells and arrivals want more', async () => {
  const s = setup({ world: [aircraft('a00001', KSFO, 12)], maxRps: 1 })
  await runUntil(s, 120_000)
  assert.ok(s.calls.length <= 121, `${s.calls.length} requests in 120 s`)
  for (let i = 1; i < s.calls.length; i++) assert.ok(s.calls[i].t - s.calls[i - 1].t >= 1000, 'one request per second at most')
  // both kinds keep flowing: the earliest-due request goes first
  assert.ok(rel(s.calls, 'hexes').length >= 60)
  for (const h of HEROES) assert.ok(s.calls.filter((c) => c.m === 'circle' && c.args[0] === h.lat).length >= 12, h.ident)
})

test('loop: a 429 pauses for Retry-After and permanently doubles the spacing', async () => {
  const s = setup({ maxRps: 1 })
  s.replies.push({ status: 429, retryAfterS: 3 })
  await runUntil(s, 12_000)
  assert.deepEqual(rel(s.calls), [0, 3000, 5000, 7000, 9000, 11_000])
  assert.equal(s.bucket.state().counts.r429, 1)
  assert.ok(s.logs.some((l) => l.includes('429')), s.logs.join('\n'))
})

test('loop: 401/403 means blocked: one request, then stop', async () => {
  const s = setup()
  s.replies.push({ status: 403 })
  const results = await runUntil(s, 10_000)
  assert.equal(s.calls.length, 1)
  assert.equal(results[0], 'sent')
  assert.ok(results.slice(1).every((r) => r === 'blocked'))
})

test('loop: every response is recorded, failures included', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fh-arrivals-'))
  const s = setup({ world: [aircraft('a00001', KSFO, 12)], recorder: new Recorder(dir) })
  s.replies.push({ status: 200 }, { status: 503 })
  await runUntil(s, 4000)
  const files = readdirSync(dir)
  assert.equal(files.length, 1)
  const lines = readRecording(join(dir, files[0]))
  assert.equal(lines.length, s.calls.length)
  assert.deepEqual(lines.slice(0, 2).map((l) => l.status), [200, 503])
  assert.equal(lines[1].body, '')
  assert.ok(lines.every((l) => l.source === 'adsblol'))
})

test('CLI: polls a local fake adsb.lol with our User-Agent, records it, exits 1 on 403', async () => {
  const seen: { url: string; ua: string | undefined }[] = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', ua: req.headers['user-agent'] })
    if (seen.length >= 2) return void res.writeHead(403).end('forbidden')
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ac: [], msg: 'No error', now: Date.now() }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const dir = mkdtempSync(join(tmpdir(), 'fh-arrivals-cli-'))
  const cli = fileURLToPath(new URL('./record-arrivals.ts', import.meta.url))
  const child = spawn(process.execPath, [cli, '--base-url', base, '--max-rps', '1', '--out', dir], {
    env: { ...process.env, CONTACT: 'test@example.invalid' },
  })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  const timer = setTimeout(() => child.kill(), 10_000)
  const [code] = await once(child, 'exit')
  clearTimeout(timer)
  server.close()
  assert.equal(code, 1, stderr)
  assert.match(stderr, /blocked/)
  assert.deepEqual(seen.map((x) => x.url), ['/v2/point/37.6198/-122.3748/40', '/v2/point/32.0114/34.8867/40'])
  assert.ok(seen.every((x) => x.ua === 'FlightHopper/0.1 (+test@example.invalid)'))
  const lines = readRecording(join(dir, readdirSync(dir)[0]))
  assert.deepEqual(lines.map((l) => [l.status, l.url]), [[200, `${base}/v2/point/37.6198/-122.3748/40`], [403, `${base}/v2/point/32.0114/34.8867/40`]])
})

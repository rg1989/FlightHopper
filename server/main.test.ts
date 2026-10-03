// server/main.test.ts
// End-to-end: the real server on port 0 against a recording. No network beyond 127.0.0.1. The alerts' wiring (the end of the
// file) runs it on a stub live source and a fake adsb.lol, since a replay has no alerts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { ChaseResponse, HistoryStatus, RecordResponse, StatusReport, ViewResponse } from '../shared/api.ts'
import { pushBody, pushTitle, type EventsReply } from '../shared/alerts.ts'
import { distanceNm } from '../shared/geo.ts'
import { SLOT_MS, newestSlotMs } from '../shared/history.ts'
import type { ReadsbAircraft, SourceKind } from '../shared/types.ts'
import { startFakeReadsb } from '../tools/fake-readsb.ts'
import { Alerts } from './alerts.ts'
import { readServerConfig } from './config.ts'
import { encodeHeatmap } from './heatmap.ts'
import { HistoryStore, heatmapUrl } from './historyStore.ts'
import { createServer } from './main.ts'
import { readRecording } from './recording.ts'
import { makeReplay } from './sources/replay.ts'
import type { FetchResult, Source } from './sources/types.ts'
import { TYPE_DB_URL, TypeDb, buildTypeTable, encodeZip } from './typeDb.ts'

const FILE = fileURLToPath(new URL('../data/fixtures/golden/recording-sample.jsonl', import.meta.url))
const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))
const KSFO = { lat: 37.6188, lon: -122.3758 }
const CHASED = 'a067ec' // airborne ADS-B v2 near KSFO; moves between the recording's two real polls (2.5 s apart)
const HIDDEN = '000002' // dbFlags 8 (LADD)
const T0 = 2_000_000_000_000 // injected server clock, far from the recording's (1.79e12): proves the rebase

const tmp = (): string => mkdtempSync(join(tmpdir(), 'fh-main-'))

/** A fetch for the past (adsb.lol's files) that records the URLs it is asked and answers 404: a test must not reach adsb.lol. */
function pastFetch(): { urls: string[]; fetchFn: typeof fetch } {
  const urls: string[] = []
  const fetchFn = (async (input: string | URL | Request) => {
    urls.push(String(input))
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { urls, fetchFn }
}

async function get<T>(url: string): Promise<{ status: number; type: string | null; body: T }> {
  const res = await fetch(url)
  return { status: res.status, type: res.headers.get('content-type'), body: (await res.json()) as T }
}

async function getText(url: string, method = 'GET'): Promise<{ status: number; type: string | null; body: string }> {
  const res = await fetch(url, { method })
  return { status: res.status, type: res.headers.get('content-type'), body: await res.text() }
}

/** GET with the path sent byte for byte (fetch would resolve '..' before sending). */
function rawGet(base: string, path: string): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(base)
  return new Promise((resolve, reject) => {
    request({ hostname, port, path }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
      .on('error', reject)
      .end()
  })
}

async function waitFor<T>(what: string, fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 8000): Promise<T> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

const viewUrl = (base: string, since: number, nm = 10): string => `${base}/api/view?lat=${KSFO.lat}&lon=${KSFO.lon}&nm=${nm}&since=${since}`

/**
 * What a client sees, identical for every source. Run once per source, this is the flip test.
 * advance() lets the upstream move past the recording's second real poll.
 */
async function assertApi(base: string, kind: SourceKind, advance: () => void): Promise<void> {
  // 1. First view (since=0): the latest sample per aircraft inside the circle, stamped in server clock.
  const v1 = await waitFor('first samples', () => get<ViewResponse>(viewUrl(base, 0)), (r) => r.body.samples.length > 0)
  assert.equal(v1.status, 200)
  assert.equal(v1.type, 'application/json')
  assert.equal(v1.body.status.source, kind)
  assert.equal(v1.body.status.degraded, null)
  const first = v1.body.samples
  assert.equal(new Set(first.map((s) => s.hex)).size, first.length, 'since=0 gives one sample per aircraft')
  assert.ok(first.some((s) => s.hex === CHASED))
  assert.ok(!first.some((s) => s.hex === HIDDEN), 'LADD aircraft are hidden by default')
  for (const s of first) {
    assert.ok(distanceNm(KSFO.lat, KSFO.lon, s.lat, s.lon) <= 10, s.hex)
    assert.ok(s.tMs <= v1.body.serverNowMs && s.tMs > v1.body.serverNowMs - 60_000, `${s.hex} tMs ${s.tMs} vs server ${v1.body.serverNowMs}`)
    assert.ok(s.rxMs <= v1.body.serverNowMs)
  }

  // 2. Poll again with since = the newest rxMs seen: only samples that arrived later, each newer than before.
  const since = Math.max(...first.map((s) => s.rxMs))
  advance()
  const v2 = await waitFor('newer samples', () => get<ViewResponse>(viewUrl(base, since)), (r) => r.body.samples.length > 0)
  const before = new Map(first.map((s) => [s.hex, s]))
  for (const s of v2.body.samples) {
    assert.ok(s.rxMs > since, `${s.hex} rxMs ${s.rxMs} ≤ since ${since}`)
    const old = before.get(s.hex)
    if (old) assert.ok(s.tMs > old.tMs, `${s.hex} is newer than its first sample`)
  }
  assert.ok(v2.body.samples.some((s) => s.hex === CHASED))

  // 3. Chase: the stored track of one aircraft, oldest first; hex case does not matter.
  const c1 = await get<ChaseResponse>(`${base}/api/chase?hex=${CHASED.toUpperCase()}&since=0`)
  assert.equal(c1.status, 200)
  assert.equal(c1.type, 'application/json')
  assert.equal(c1.body.status.source, kind)
  const track = c1.body.samples
  assert.ok(track.length >= 2, `track has ${track.length} samples`)
  assert.ok(track.every((s) => s.hex === CHASED))
  for (let i = 1; i < track.length; i++) assert.ok(track[i].tMs > track[i - 1].tMs)
  const c2 = await get<ChaseResponse>(`${base}/api/chase?hex=${CHASED}&since=${track.at(-1)!.rxMs}`)
  assert.deepEqual(c2.body.samples, [], 'the recording has no later position')

  // 4. Status: the poller's report.
  const st = await get<StatusReport>(`${base}/api/status`)
  assert.equal(st.status, 200)
  assert.equal(st.type, 'application/json')
  const keys = [
    'budget', 'bytesPerHourEstimate', 'cellPeriodP95S', 'cells', 'chaseEveryS', 'chasePeriodP95S', 'chasedHexes', 'degraded', 'pendingAreas',
    'requestsTotal', 'source', 'upstreamOffsetMs', 'viewEveryS',
  ]
  assert.deepEqual(Object.keys(st.body).sort(), keys)
  assert.equal(st.body.source, kind)
  assert.equal(st.body.degraded, null)
  assert.deepEqual(st.body.cells, [], 'full-snapshot sources poll no cells')
  assert.deepEqual(st.body.chasedHexes, [CHASED])
  assert.equal(st.body.budget.maxRps, 1)
  assert.equal(st.body.budget.blocked, false)
  assert.ok(st.body.requestsTotal >= 2)
  assert.ok(st.body.bytesPerHourEstimate > 0)
  assert.equal(typeof st.body.cellPeriodP95S, 'number')

  // 5. Bad parameters: 400 with a JSON error.
  const bad = [
    '/api/view?lon=0&nm=10',
    '/api/view?lat=&lon=0&nm=10',
    '/api/view?lat=91&lon=0&nm=10',
    '/api/view?lat=0&lon=-181&nm=10',
    '/api/view?lat=0&lon=0&nm=0',
    '/api/view?lat=0&lon=0&nm=ten',
    '/api/view?lat=0&lon=0&nm=10&since=-1',
    '/api/chase',
    '/api/chase?hex=a067e',
    '/api/chase?hex=xyz123',
    '/api/chase?hex=a067ec&since=soon',
  ]
  for (const path of bad) {
    const r = await get<{ error: string }>(base + path)
    assert.equal(r.status, 400, path)
    assert.equal(r.type, 'application/json', path)
    assert.equal(typeof r.body.error, 'string', path)
  }
}

test('replay on an injected server clock: view, since, chase, status, 400s; replay is never recorded', async (t) => {
  const clock = { t: T0 }
  const nowMs = (): number => clock.t
  const dir = tmp()
  const recordDir = join(dir, 'rec')
  const cfg = { ...readServerConfig({ REPLAY_FILES: FILE, RECORD_DIR: recordDir }), staticDir: join(dir, 'dist') }
  const app = createServer(cfg, { source: makeReplay({ files: cfg.replayFiles, nowMs }), nowMs })
  const base = await app.listen(0)
  t.after(() => app.close())
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/)

  await assertApi(base, 'replay', () => {
    clock.t += 2500
  })

  // Every sample was received at one of the two injected instants, and serverNowMs is the injected clock.
  const v = await get<ViewResponse>(viewUrl(base, 0))
  assert.equal(v.body.serverNowMs, T0 + 2500)
  // The replay tells the client how long ago it was recorded: server clock − the recording's clock (sun time, D12).
  assert.equal(v.body.status.upstreamOffsetMs, T0 - readRecording(FILE)[0].tRecvMs)
  const chase = await get<ChaseResponse>(`${base}/api/chase?hex=${CHASED}&since=0`)
  assert.deepEqual([...new Set(chase.body.samples.map((s) => s.rxMs))], [T0, T0 + 2500])
  assert.equal(existsSync(recordDir), false, 'RECORD_DIR is ignored for replay')
  // No dist/ here: the client is simply missing.
  const home = await getText(`${base}/`)
  assert.equal(home.status, 404)
  assert.match(home.body, /npm run build/)
})

test('flip: the same API from ADSB_SOURCE=readsb against a fake receiver serving the same recording', async (t) => {
  const fake = await startFakeReadsb({ files: [FILE], port: 0 })
  t.after(() => fake.close())
  const dir = tmp()
  const recordDir = join(dir, 'rec')
  const env = { ADSB_SOURCE: 'readsb', READSB_URL: fake.url, READSB_COVERAGE: '37.6188,-122.3758,200', RECORD_DIR: recordDir }
  const cfg = { ...readServerConfig(env), staticDir: join(dir, 'dist') }
  const past = pastFetch()
  const app = createServer(cfg, { historyFetch: past.fetchFn }) // source from makeSource(cfg), real clock: what `npm run server` builds
  const base = await app.listen(0)
  t.after(() => app.close())

  await assertApi(base, 'readsb', () => {}) // real time: the fake receiver reaches the second poll 2.5 s after start
  assert.deepEqual(past.urls, [], 'a live source does not fetch the past by itself: nothing was asked of adsb.lol')

  const lines = readdirSync(recordDir).flatMap((f) => readRecording(join(recordDir, f)))
  assert.ok(lines.length >= 2, `${lines.length} recorded polls`)
  assert.ok(lines.every((l) => l.source === 'readsb' && l.url.startsWith(`${fake.url}/?`)))
})

test('SHOW_PIA_LADD=1 serves PIA/LADD aircraft too', async (t) => {
  const clock = { t: T0 }
  const nowMs = (): number => clock.t
  const cfg = { ...readServerConfig({ REPLAY_FILES: FILE, SHOW_PIA_LADD: '1' }), staticDir: join(tmp(), 'dist') }
  const app = createServer(cfg, { source: makeReplay({ files: cfg.replayFiles, nowMs }), nowMs })
  const base = await app.listen(0)
  t.after(() => app.close())
  const v = await waitFor('first samples', () => get<ViewResponse>(viewUrl(base, 0)), (r) => r.body.samples.length > 0)
  assert.ok(v.body.samples.some((s) => s.hex === HIDDEN))
})

test('a view wider than 250 nm is served, not rejected', async (t) => {
  const clock = { t: T0 }
  const nowMs = (): number => clock.t
  const cfg = { ...readServerConfig({ REPLAY_FILES: FILE }), staticDir: join(tmp(), 'dist') }
  const app = createServer(cfg, { source: makeReplay({ files: cfg.replayFiles, nowMs }), nowMs })
  const base = await app.listen(0)
  t.after(() => app.close())
  const v = await waitFor('first samples', () => get<ViewResponse>(viewUrl(base, 0, 3000)), (r) => r.body.samples.length > 0)
  assert.equal(v.status, 200)
})

test('static: dist/ files with content types, index.html for client routes, 404 for missing assets and traversal', async (t) => {
  const dir = tmp()
  const dist = join(dir, 'dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>FlightHopper</title>')
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(dist, 'assets', 'app.css'), 'body{}')
  writeFileSync(join(dist, 'assets', 'data.bin'), 'x')
  writeFileSync(join(dir, 'secret.txt'), 'TOP SECRET')
  const app = createServer({ ...readServerConfig({ REPLAY_FILES: FILE }), staticDir: dist })
  const base = await app.listen(0)
  t.after(() => app.close())

  const home = await getText(`${base}/`)
  assert.equal(home.status, 200)
  assert.equal(home.type, 'text/html; charset=utf-8')
  assert.match(home.body, /FlightHopper/)
  assert.deepEqual(await getText(`${base}/assets/app.js`), { status: 200, type: 'text/javascript; charset=utf-8', body: 'console.log(1)' })
  assert.equal((await getText(`${base}/assets/app.css`)).type, 'text/css; charset=utf-8')
  assert.equal((await getText(`${base}/assets/data.bin`)).type, 'application/octet-stream')
  for (const route of ['/?hex=a067ec&bench=1', '/chase/a067ec', '/assets/']) {
    const r = await getText(base + route)
    assert.equal(r.status, 200, route)
    assert.match(r.body, /FlightHopper/, route)
  }
  assert.equal((await getText(`${base}/assets/missing.js`)).status, 404)
  const api = await getText(`${base}/api/nope`)
  assert.equal(api.status, 404)
  assert.equal(api.type, 'application/json')
  assert.equal((await getText(`${base}/api/status`, 'POST')).status, 405)

  const attacks = [
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/..%2fsecret.txt',
    '/assets/..%2f..%2fsecret.txt',
    '/assets/%2e%2e%2f%2e%2e%2fsecret.txt',
    '/..%5csecret.txt',
    '/%00',
    '/%zz',
  ]
  for (const path of attacks) {
    const r = await rawGet(base, path)
    assert.equal(r.status, 404, path)
    assert.doesNotMatch(r.body, /TOP SECRET/, path)
  }
})

test('static: new MIME types for scenario audio/captions/data files', async (t) => {
  const dist = join(tmp(), 'dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>FlightHopper</title>')
  const files: [string, string][] = [
    ['track.csv', 'text/csv; charset=utf-8'],
    ['cvr.m4a', 'audio/mp4'],
    ['clip.mp3', 'audio/mpeg'],
    ['clip.ogg', 'audio/ogg'],
    ['clip.opus', 'audio/ogg'],
    ['clip.wav', 'audio/wav'],
    ['captions.vtt', 'text/vtt; charset=utf-8'],
  ]
  for (const [name] of files) writeFileSync(join(dist, name), 'x')
  const app = createServer({ ...readServerConfig({ REPLAY_FILES: FILE }), staticDir: dist })
  const base = await app.listen(0)
  t.after(() => app.close())

  for (const [name, type] of files) {
    const r = await getText(`${base}/${name}`)
    assert.equal(r.status, 200, name)
    assert.equal(r.type, type, name)
  }
})

test('static: HTTP Range on a 1000-byte file — 206 slices (a-b, a-, -n), 416 unsatisfiable, 200 always advertises accept-ranges', async (t) => {
  const dist = join(tmp(), 'dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>FlightHopper</title>')
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256))
  writeFileSync(join(dist, 'data.bin'), bytes)
  const app = createServer({ ...readServerConfig({ REPLAY_FILES: FILE }), staticDir: dist })
  const base = await app.listen(0)
  t.after(() => app.close())

  const whole = await fetch(`${base}/data.bin`)
  assert.equal(whole.status, 200)
  assert.equal(whole.headers.get('accept-ranges'), 'bytes')
  assert.equal(Buffer.from(await whole.arrayBuffer()).length, 1000)

  // bytes=a-b
  const r1 = await fetch(`${base}/data.bin`, { headers: { range: 'bytes=0-99' } })
  assert.equal(r1.status, 206)
  assert.equal(r1.headers.get('content-range'), 'bytes 0-99/1000')
  assert.equal(r1.headers.get('accept-ranges'), 'bytes')
  assert.equal(r1.headers.get('content-length'), '100')
  assert.deepEqual(Buffer.from(await r1.arrayBuffer()), bytes.subarray(0, 100))

  // bytes=a-
  const r2 = await fetch(`${base}/data.bin`, { headers: { range: 'bytes=900-' } })
  assert.equal(r2.status, 206)
  assert.equal(r2.headers.get('content-range'), 'bytes 900-999/1000')
  assert.deepEqual(Buffer.from(await r2.arrayBuffer()), bytes.subarray(900, 1000))

  // bytes=-n (last n bytes)
  const r3 = await fetch(`${base}/data.bin`, { headers: { range: 'bytes=-100' } })
  assert.equal(r3.status, 206)
  assert.equal(r3.headers.get('content-range'), 'bytes 900-999/1000')
  assert.deepEqual(Buffer.from(await r3.arrayBuffer()), bytes.subarray(900, 1000))

  // unsatisfiable: start beyond the end of the file
  const r4 = await fetch(`${base}/data.bin`, { headers: { range: 'bytes=2000-3000' } })
  assert.equal(r4.status, 416)
  assert.equal(r4.headers.get('content-range'), 'bytes */1000')

  // multiple ranges → whole file 200 (multipart is not implemented)
  const r5 = await fetch(`${base}/data.bin`, { headers: { range: 'bytes=0-9,20-29' } })
  assert.equal(r5.status, 200)
  assert.equal(Buffer.from(await r5.arrayBuffer()).length, 1000)
})

test('CLI: `node server/main.ts` reads the environment and serves', async (t) => {
  const child = spawn(process.execPath, [MAIN], {
    env: { ADSB_SOURCE: 'replay', REPLAY_FILES: FILE, PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  t.after(() => child.kill())
  let out = ''
  child.stdout.setEncoding('utf8')
  const base = await new Promise<string>((resolve, reject) => {
    child.stdout.on('data', (c: string) => {
      out += c
      const m = /http:\/\/127\.0\.0\.1:\d+/.exec(out)
      if (m) resolve(m[0])
    })
    child.on('exit', (code) => reject(new Error(`exited ${code}: ${out}`)))
  })
  assert.match(out, /source replay/)
  const st = await get<StatusReport>(`${base}/api/status`)
  assert.equal(st.status, 200)
  assert.equal(st.body.source, 'replay')
})

test('CLI: a config error exits 1 with the message (adsblol without CONTACT; nothing is fetched)', async () => {
  const child = spawn(process.execPath, [MAIN], { env: { ADSB_SOURCE: 'adsblol' }, stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (c: string) => (err += c))
  const [code] = await once(child, 'exit')
  assert.equal(code, 1)
  assert.match(err, /^server: CONTACT is required for ADSB_SOURCE=adsblol/)
})

test('FLIGHTS_DIR: POST /api/record starts and stops one aircraft; chase reports it; off without FLIGHTS_DIR', async (t) => {
  const clock = { t: T0 }
  const nowMs = (): number => clock.t
  const flights = tmp()
  const cfg = { ...readServerConfig({ REPLAY_FILES: FILE, FLIGHTS_DIR: flights }), staticDir: join(tmp(), 'dist') }
  const app = createServer(cfg, { source: makeReplay({ files: cfg.replayFiles, nowMs }), nowMs })
  const base = await app.listen(0)
  t.after(() => app.close())
  const post = async (q: string) => (await fetch(`${base}/api/record?${q}`, { method: 'POST' })).json()
  await waitFor('the chased aircraft', () => get<ChaseResponse>(`${base}/api/chase?hex=${CHASED}`), (r) => r.body.samples.length > 0)
  assert.equal((await get<ChaseResponse>(`${base}/api/chase?hex=${CHASED}`)).body.rec, null)

  const on = await post(`hex=${CHASED}&on=1`)
  assert.equal(on.rec.hex, CHASED)
  assert.ok(on.rec.samples > 0, 'starts with the samples the store holds')
  assert.deepEqual((await get<ChaseResponse>(`${base}/api/chase?hex=${CHASED}`)).body.rec?.file, on.rec.file)
  assert.equal((await get<{ active: unknown[] }>(`${base}/api/record`)).body.active.length, 1)
  assert.ok(existsSync(join(flights, on.rec.file)))

  const off = await post(`hex=${CHASED}&on=0`)
  assert.deepEqual(off, { rec: null, active: [] })
  assert.equal((await fetch(`${base}/api/record?hex=zz&on=1`, { method: 'POST' })).status, 400)
  assert.equal((await fetch(`${base}/api/view`, { method: 'POST' })).status, 405)

  const plain = createServer({ ...readServerConfig({ REPLAY_FILES: FILE }), staticDir: join(tmp(), 'dist') })
  const b2 = await plain.listen(0)
  t.after(() => plain.close())
  assert.equal((await fetch(`${b2}/api/record?hex=${CHASED}&on=1`, { method: 'POST' })).status, 400)
  assert.equal((await get<ChaseResponse>(`${b2}/api/chase?hex=${CHASED}`)).body.rec, undefined, 'no rec field: the card shows no Record button')
})

test('POST /api/recordings/rename and /delete: name one, delete one; unknown files 404; GET is not allowed', async (t) => {
  const clock = { t: T0 }
  const nowMs = (): number => clock.t
  const flights = tmp()
  const cfg = { ...readServerConfig({ REPLAY_FILES: FILE, FLIGHTS_DIR: flights }), staticDir: join(tmp(), 'dist') }
  const app = createServer(cfg, { source: makeReplay({ files: cfg.replayFiles, nowMs }), nowMs })
  const base = await app.listen(0)
  t.after(() => app.close())
  await waitFor('the chased aircraft', () => get<ChaseResponse>(`${base}/api/chase?hex=${CHASED}`), (r) => r.body.samples.length > 0)
  const post = (path: string) => fetch(`${base}${path}`, { method: 'POST' })
  const { rec } = await (await post(`/api/record?hex=${CHASED}&on=1`)).json()
  const f = encodeURIComponent(rec.file)
  const named = await (await post(`/api/recordings/rename?file=${f}&name=${encodeURIComponent('Final approach')}`)).json()
  assert.equal(named.recordings[0].name, 'Final approach')
  assert.equal((await post(`/api/recordings/rename?file=${f}`)).status, 400, 'a name is required')
  assert.equal((await fetch(`${base}/api/recordings/delete?file=${f}`)).status, 404, 'GET does not delete')
  assert.deepEqual(await (await post(`/api/recordings/delete?file=${f}`)).json(), { recordings: [] })
  assert.equal((await get<{ active: unknown[] }>(`${base}/api/record`)).body.active.length, 0, 'it stopped recording')
  assert.equal((await post(`/api/recordings/delete?file=${f}`)).status, 404)
  assert.equal((await post(`/api/recordings/rename?file=..%2Fx&name=a`)).status, 404)
})

// ---- the alerts (server/alerts.ts): the server's wiring of them ----

/**
 * A live source on the injected clock that records what it is asked and answers each request with the aircraft it holds:
 * `heard` for the area, hex and full-snapshot requests, `onSquawk[code]` for that code's sweep. Kind adsbfi is an area source with
 * squawk() (a server on it sweeps); readsb is a full snapshot without it. Both are live: only a replay has no alerts.
 */
function liveStub(clock: { t: number }, kind: 'adsbfi' | 'readsb' = 'adsbfi') {
  const world = { heard: [] as ReadsbAircraft[], onSquawk: {} as Record<string, ReadsbAircraft[]>, asked: [] as string[] }
  const answer = (what: string, aircraft: ReadsbAircraft[]): Promise<FetchResult> => {
    world.asked.push(what)
    return Promise.resolve({ url: `fake:${kind}`, status: 200, tSendMs: clock.t, tRecvMs: clock.t, bytes: 100, body: '', retryAfterS: null, snapshot: { nowMs: clock.t, aircraft } })
  }
  const area = kind === 'adsbfi'
  const source: Source = {
    caps: { kind, fullSnapshot: !area, maxRps: 5, coverage: null, attribution: 'test' },
    circle: () => (area ? answer('circle', world.heard) : Promise.reject(new Error('unsupported'))),
    hexes: () => (area ? answer('hexes', world.heard) : Promise.reject(new Error('unsupported'))),
    all: () => (area ? Promise.reject(new Error('unsupported')) : answer('all', world.heard)),
  }
  if (area) source.squawk = (code) => answer(`squawk ${code}`, world.onSquawk[code] ?? [])
  return { source, world }
}

/** An airborne aircraft at 32 N 35 E as an upstream sends it: its position and the position's age make a sample. */
const plane = (hex: string, o: Partial<ReadsbAircraft> = {}): ReadsbAircraft => ({
  hex, type: 'adsb_icao', flight: 'ELY1    ', r: '4X-EKA', t: 'B738', category: 'A3', alt_baro: 36_000, lat: 32, lon: 35, gs: 450, track: 90, seen_pos: 0.4, version: 2, ...o,
})

/**
 * A server on a live stub (alerts need a live source) with EVENTS_DIR in a fresh temp directory, on the injected clock.
 * `on` leaves the switch on in state.json, as an earlier run would have. `env` and `deps` add to the settings and to createServer's
 * deps. It is closed when the test ends.
 */
async function liveServer(
  t: { after: (fn: () => Promise<void>) => void },
  o: { kind?: 'adsbfi' | 'readsb'; on?: boolean; env?: Record<string, string>; deps?: Parameters<typeof createServer>[1] } = {},
) {
  const clock = { t: T0 }
  const stub = liveStub(clock, o.kind)
  const eventsDir = join(tmp(), 'events')
  if (o.on === true) {
    mkdirSync(eventsDir, { recursive: true })
    writeFileSync(join(eventsDir, 'state.json'), '{"on":true}\n')
  }
  // cfg.source stays the default (replay): the alerts follow the source passed in, which is live.
  const cfg = { ...readServerConfig({ REPLAY_FILES: FILE, EVENTS_DIR: eventsDir, ...o.env }), staticDir: join(tmp(), 'dist') }
  const app = createServer(cfg, { source: stub.source, nowMs: () => clock.t, ...o.deps })
  const base = await app.listen(0)
  t.after(() => app.close())
  return { app, base, clock, eventsDir, ...stub }
}

const postEvents = (base: string, q: string): Promise<Response> => fetch(`${base}/api/events?${q}`, { method: 'POST' })

async function getEvents(base: string): Promise<EventsReply> {
  const r = await get<EventsReply>(`${base}/api/events`)
  assert.equal(r.status, 200)
  return r.body
}

/** Moves the injected clock on and waits for the poller to take the next answer (its ingest runs in one go, so it is done by then). */
async function nextAnswer(s: { app: ReturnType<typeof createServer>; clock: { t: number } }, ms: number): Promise<void> {
  const before = s.app.poller.report().requestsTotal
  s.clock.t += ms
  await waitFor('the next answer', async () => s.app.poller.report().requestsTotal, (n) => n > before)
}

test('alerts: GET /api/events starts off and empty; POST ?on=1|0 switches the watch and keeps it in state.json; a GET or a bad value does not switch', async (t) => {
  const { base, eventsDir } = await liveServer(t)
  const state = (): unknown => JSON.parse(readFileSync(join(eventsDir, 'state.json'), 'utf8'))

  const first = await get<EventsReply>(`${base}/api/events`)
  assert.equal(first.status, 200)
  assert.equal(first.type, 'application/json')
  assert.deepEqual(first.body, { on: false, sweep: true, rev: T0, events: [] }, 'the rev starts at the server clock')

  const on = await postEvents(base, 'on=1')
  assert.equal(on.status, 200)
  const reply = (await on.json()) as EventsReply
  assert.deepEqual([reply.on, reply.sweep, reply.events], [true, true, []])
  assert.ok(reply.rev > 0)
  assert.deepEqual(state(), { on: true })
  assert.deepEqual(await getEvents(base), reply)

  assert.equal((await get<EventsReply>(`${base}/api/events?on=0`)).body.on, true, 'a GET does not switch')
  for (const bad of ['on=2', 'on=', 'on=true', '']) assert.equal((await postEvents(base, bad)).status, 400, bad)
  assert.deepEqual(await (await postEvents(base, 'on=2')).json(), { error: 'on must be 1 or 0' })
  assert.deepEqual(await getEvents(base), reply, 'a refused request changed nothing')

  const off = (await (await postEvents(base, 'on=0')).json()) as EventsReply
  assert.equal(off.on, false)
  assert.ok(off.rev > reply.rev)
  assert.deepEqual(state(), { on: false })
})

test('alerts: the status of a view or chase answer has alertsRev, which changes with the switch', async (t) => {
  const { base } = await liveServer(t)
  const rev = async (): Promise<number | undefined> => (await get<ViewResponse>(viewUrl(base, 0))).body.status.alertsRev
  const r0 = await rev()
  assert.equal(typeof r0, 'number')
  await postEvents(base, 'on=1')
  const r1 = await rev()
  assert.ok(r1! > r0!, 'on')
  await postEvents(base, 'on=0')
  const r2 = await rev()
  assert.ok(r2! > r1!, 'off')
  assert.equal((await get<ChaseResponse>(`${base}/api/chase?hex=${CHASED}&since=0`)).body.status.alertsRev, r2, 'the chase answer carries it too')
})

test('alerts: without EVENTS_DIR there are none: /api/events is 404 for GET and POST, and the status has no alertsRev', async (t) => {
  const clock = { t: T0 }
  const cfg = { ...readServerConfig({ REPLAY_FILES: FILE }), staticDir: join(tmp(), 'dist') }
  const app = createServer(cfg, { source: liveStub(clock).source, nowMs: () => clock.t })
  const base = await app.listen(0)
  t.after(() => app.close())
  const none = await get<{ error: string }>(`${base}/api/events`)
  assert.equal(none.status, 404)
  assert.equal(none.type, 'application/json')
  assert.match(none.body.error, /EVENTS_DIR/)
  assert.equal((await postEvents(base, 'on=1')).status, 404)
  const v = await get<ViewResponse>(viewUrl(base, 0))
  assert.equal(v.status, 200)
  assert.equal('alertsRev' in v.body.status, false)
})

test('alerts: a replay never has them, whatever EVENTS_DIR says: 404, no alertsRev, and the directory is not made', async (t) => {
  const clock = { t: T0 }
  const nowMs = (): number => clock.t
  const eventsDir = join(tmp(), 'events')
  const cfg = { ...readServerConfig({ REPLAY_FILES: FILE, EVENTS_DIR: eventsDir }), staticDir: join(tmp(), 'dist') }
  assert.equal(cfg.eventsDir, eventsDir)
  const app = createServer(cfg, { source: makeReplay({ files: cfg.replayFiles, nowMs }), nowMs })
  const base = await app.listen(0)
  t.after(() => app.close())
  assert.equal((await get(`${base}/api/events`)).status, 404)
  assert.equal((await postEvents(base, 'on=1')).status, 404)
  const v = await get<ViewResponse>(viewUrl(base, 0))
  assert.equal(v.status, 200)
  assert.equal('alertsRev' in v.body.status, false)
  assert.equal(existsSync(eventsDir), false)
})

test('alerts: a source that cannot sweep (readsb) is live and has them, with sweep false', async (t) => {
  const { base, world } = await liveServer(t, { kind: 'readsb' })
  assert.deepEqual(await getEvents(base), { on: false, sweep: false, rev: T0, events: [] })
  assert.equal((await (await postEvents(base, 'on=1')).json() as EventsReply).on, true)
  await waitFor('the poller to ask', async () => world.asked.length, (n) => n > 0)
  await sleep(350) // a few more poller ticks: a sweep would be asked by now
  assert.ok(world.asked.length > 0, 'the poller asked at least once')
  assert.ok(world.asked.every((a) => a === 'all'), `only snapshots are asked: ${world.asked.join(', ')}`)
})

test('alerts: the poller sweeps the codes in ALERT_SQUAWKS while the switch is on; a squawk seen again 25 s later opens an event, logged and pushed to NTFY_URL', async (t) => {
  const pushed: { url: string; init: RequestInit }[] = []
  const pushFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    pushed.push({ url: String(url), init: init ?? {} })
    return new Response('ok')
  }) as typeof fetch
  // 7000 and 2000, not the default 7700, 7600 and 7500: the codes asked are the setting's.
  const s = await liveServer(t, { env: { NTFY_URL: 'https://ntfy.example/secret-topic', ALERT_SQUAWKS: '7000,2000' }, deps: { pushFetch } })
  s.world.onSquawk['7000'] = [plane('89645a', { flight: 'FDB1073 ', r: 'A6-FNC', t: 'B38M', squawk: '7000', alt_baro: 30_000 })]
  const sweeps = (): string[] => s.world.asked.filter((a) => a.startsWith('squawk '))

  await sleep(350) // a few poller ticks
  assert.deepEqual(sweeps(), [], 'switched off: nothing is swept')

  assert.equal((await postEvents(s.base, 'on=1')).status, 200)
  await waitFor('the first sweep', async () => sweeps(), (a) => a.length === 1)
  s.clock.t += 15_000 // two codes: one request every 15 s
  await waitFor('the second sweep', async () => sweeps(), (a) => a.length === 2)
  s.clock.t += 15_000
  await waitFor('the third sweep', async () => sweeps(), (a) => a.length === 3)
  assert.deepEqual(sweeps(), ['squawk 7000', 'squawk 2000', 'squawk 7000'], 'each code in turn')

  const reply = await waitFor('the event', () => getEvents(s.base), (r) => r.events.length === 1)
  const [e] = reply.events
  assert.deepEqual([e.hex, e.kind, e.squawk, e.callsign, e.reg, e.type, e.openedMs, e.lastMs, e.late], ['89645a', 'squawk', '7000', 'FDB1073', 'A6-FNC', 'B38M', T0, T0 + 30_000, false])
  assert.equal((await get<ViewResponse>(viewUrl(s.base, 0))).body.status.alertsRev, reply.rev, 'the clients are told to ask again')
  const day = new Date(T0).toISOString().slice(0, 10)
  const log = readFileSync(join(s.eventsDir, `${day}.jsonl`), 'utf8').trim().split('\n')
  assert.deepEqual(log.map((l) => (JSON.parse(l) as { id: string }).id), [e.id], 'logged in the day of the injected clock')
  assert.equal(pushed.length, 1)
  assert.equal(pushed[0].url, 'https://ntfy.example/secret-topic')
  assert.equal(pushed[0].init.method, 'POST')
  assert.equal(pushed[0].init.body, pushBody(e))
  assert.deepEqual(pushed[0].init.headers, { Title: pushTitle(e), Priority: 'high', Tags: 'airplane' })

  await postEvents(s.base, 'on=0')
  s.clock.t += 30_000
  await sleep(350)
  assert.equal(sweeps().length, 3, 'switched off again: no more sweeps')
})

test('alerts: a polled aircraft\'s emergency descent opens an event; a military one\'s (dbFlags from the info store) does not', async (t) => {
  const s = await liveServer(t, { kind: 'readsb' })
  assert.equal((await postEvents(s.base, 'on=1')).status, 200)
  // 36,000 ft, then 250 ft/s (15,000 fpm) from the 20th second down to 18,000 ft; a sample every 10 s, each with its baro_rate.
  const alt = (sec: number): number => (sec < 20 ? 36_000 : Math.max(18_000, 36_000 - 250 * (sec - 20)))
  for (let sec = 0; sec <= 100; sec += 10) {
    const rate = (alt(sec + 10) - alt(sec)) * 6
    s.world.heard = [plane('738a10', { alt_baro: alt(sec), baro_rate: rate }), plane('43c001', { alt_baro: alt(sec), baro_rate: rate, dbFlags: 1 })]
    await nextAnswer(s, 10_000)
  }
  const { events } = await getEvents(s.base)
  assert.deepEqual(events.map((e) => [e.hex, e.kind, e.drop?.fromFt, e.drop?.lost, e.late, e.type]), [['738a10', 'descent', 36_000, false, false, 'B738']])
})

test('alerts: a recorded aircraft\'s flight log still gets each new sample, with the alerts there or not', async (t) => {
  for (const alerts of [true, false]) {
    const env: Record<string, string> = { FLIGHTS_DIR: join(tmp(), 'flights') }
    if (!alerts) env.EVENTS_DIR = '' // blank is unset: no alerts
    const s = await liveServer(t, { kind: 'readsb', env })
    assert.equal((await get(`${s.base}/api/events`)).status, alerts ? 200 : 404)
    const hear = async (lon: number): Promise<void> => {
      s.world.heard = [plane('738a10', { lon })]
      await nextAnswer(s, 10_000)
    }
    await hear(35)
    const started = ((await (await fetch(`${s.base}/api/record?hex=738a10&on=1`, { method: 'POST' })).json()) as RecordResponse).rec!
    await hear(35.01)
    await hear(35.02)
    const [rec] = (await get<RecordResponse>(`${s.base}/api/record`)).body.active
    assert.equal(rec.samples, started.samples + 2, alerts ? 'with the alerts' : 'without them')
  }
})

// ---- the late scan: each new half hour held by the past's rolling fetch ----

/** A half-hour file of aircraft at 31,000 ft: each hex sends 7700 at the seconds given. */
function heatWith(slotMs: number, sent: Record<string, number[]>): Uint8Array {
  const slices: Parameters<typeof encodeHeatmap>[0] = []
  for (let s = 0; s < 1800; s += 10) {
    const records: Parameters<typeof encodeHeatmap>[0][number]['records'] = []
    for (const [hex, at] of Object.entries(sent)) {
      records.push({ hex, lat: 40, lon: -70, alt: 31_000, gs: 450 })
      if (at.includes(s)) records.push({ hex, callsign: 'AAL1', squawk: '7700' })
    }
    slices.push({ tMs: slotMs + s * 1000, records })
  }
  return encodeHeatmap(slices)
}

/** adsb.lol's heatmap files as a fake fetch: these half hours, anything else 404. */
const heatFetch = (files: Map<number, Uint8Array>): typeof fetch =>
  (async (input: string | URL | Request) => {
    for (const [slotMs, file] of files) if (String(input) === heatmapUrl('https://adsb.lol', slotMs)) return new Response(file.buffer as ArrayBuffer)
    return new Response('not found', { status: 404 })
  }) as typeof fetch

test('alerts: each half hour the rolling fetch holds is read for late events, the older first, with the type table\'s types; the switch kept in state.json is on at start', async (t) => {
  const newest = newestSlotMs(T0)
  const older = newest - SLOT_MS
  // The A320 of the type table sends 7700 at minutes 25 and 26 of the older half hour and at 1 and 2 of the newest: one episode,
  // which opens at the older's minute 25 only if the older half hour is read first. a00001 sends it at minutes 10 and 11 of the older.
  const files = new Map([
    [older, heatWith(older, { '4691c4': [1500, 1560], a00001: [600, 660] })],
    [newest, heatWith(newest, { '4691c4': [60, 120] })],
  ])
  const types = new TypeDb({ userAgent: 'test', table: buildTypeTable({ '4691C4': { t: 'A320' } }, { A320: { desc: 'L2J', wtc: 'M' } }) })
  const pushed: string[] = []
  const pushFetch = (async (url: string | URL | Request) => (pushed.push(String(url)), new Response('ok'))) as typeof fetch
  const s = await liveServer(t, { on: true, deps: { rollHistory: true, historyFetch: heatFetch(files), types, pushFetch } })

  const { events } = await waitFor('the late events', () => getEvents(s.base), (r) => r.events.length === 2)
  assert.deepEqual(events.map((e) => [e.hex, e.kind, e.squawk, e.late, e.type, e.openedMs, e.lastMs]), [
    ['4691c4', 'squawk', '7700', true, 'A320', older + 1_500_000, newest + 120_000],
    ['a00001', 'squawk', '7700', true, null, older + 600_000, older + 660_000],
  ])
  assert.deepEqual(pushed, [], 'no NTFY_URL: nothing is pushed')
})

/** Mictronics' zip as the type table's download serves it: 4691c4 is an A320. */
const typeZip = (): Uint8Array<ArrayBuffer> =>
  encodeZip([
    { name: 'types.json', data: new TextEncoder().encode(JSON.stringify({ A320: { desc: 'L2J', wtc: 'M' } })), method: 8 },
    { name: 'aircrafts.json', data: new TextEncoder().encode(JSON.stringify({ '4691C4': { r: 'SX-DND', t: 'A320', f: '00', d: '' } })), method: 8 },
  ])

test('the late scan: the first scan after the start waits for the type table, so the late event has its type for good', async (t) => {
  const newest = newestSlotMs(T0)
  const older = newest - SLOT_MS
  // The command line loads the table as the server starts, while the two half hours come in. Here the table's download is held
  // back until both half hours are in: a scan that does not wait finds the late event then and leaves it without a type, and each
  // half hour is read once.
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  t.after(release) // a failed test must not leave the download hanging
  const heat = heatFetch(new Map([[older, heatWith(older, { '4691c4': [600, 660] })], [newest, heatWith(newest, {})]]))
  const asked: string[] = []
  const historyFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push(String(input))
    if (String(input) !== TYPE_DB_URL) return heat(input, init)
    await held
    return new Response(typeZip())
  }) as typeof fetch
  const s = await liveServer(t, { on: true, deps: { rollHistory: true, historyMeta: true, historyFetch } })

  const slots = async (): Promise<HistoryStatus['slots']> => (await get<HistoryStatus>(`${s.base}/api/history/status`)).body.slots
  await waitFor('both half hours held', slots, (l) => l.filter((x) => x.state === 'ready').length === 2)
  assert.ok(asked.includes(TYPE_DB_URL), 'the table is being downloaded')
  await sleep(50) // the scan would have run by now
  assert.deepEqual((await getEvents(s.base)).events, [], 'nothing is read before the table is in')

  release()
  const { events } = await waitFor('the late event', () => getEvents(s.base), (r) => r.events.length === 1)
  assert.deepEqual(events.map((e) => [e.hex, e.kind, e.late, e.type, e.openedMs]), [['4691c4', 'squawk', true, 'A320', older + 600_000]])
})

test('the late scan: a failure of the scan is logged as the late check\'s, not as the history tick\'s', async (t) => {
  const logged: string[] = []
  t.mock.method(console, 'error', (...args: unknown[]) => void logged.push(String(args[0])))
  t.mock.method(Alerts.prototype, 'scanSlot', () => {
    throw new Error('boom')
  })
  const newest = newestSlotMs(T0)
  const files = new Map([[newest - SLOT_MS, heatWith(newest - SLOT_MS, {})], [newest, heatWith(newest, {})]])
  await liveServer(t, { on: true, deps: { rollHistory: true, historyFetch: heatFetch(files) } })
  await waitFor('the scan to fail', async () => logged, (l) => l.includes('alerts: late check failed:'), 3000)
  assert.ok(!logged.includes('history: tick failed:'), logged.join(' | '))
})

test('the late scan: a history tick that fails is logged as the tick\'s, and nothing is scanned', async (t) => {
  const logged: string[] = []
  t.mock.method(console, 'error', (...args: unknown[]) => void logged.push(String(args[0])))
  const scan = t.mock.method(Alerts.prototype, 'scanSlot', () => {})
  t.mock.method(HistoryStore.prototype, 'tick', () => Promise.reject(new Error('down')))
  await liveServer(t, { on: true, deps: { rollHistory: true, historyFetch: heatFetch(new Map()) } })
  await waitFor('the tick to fail', async () => logged, (l) => l.includes('history: tick failed:'), 3000)
  await sleep(50)
  assert.equal(scan.mock.callCount(), 0)
  assert.ok(!logged.includes('alerts: late check failed:'), logged.join(' | '))
})

// server/main.test.ts
// End-to-end: the real server on port 0 against a recording. No network beyond 127.0.0.1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { ChaseResponse, StatusReport, ViewResponse } from '../shared/api.ts'
import { distanceNm } from '../shared/geo.ts'
import type { SourceKind } from '../shared/types.ts'
import { startFakeReadsb } from '../tools/fake-readsb.ts'
import { readServerConfig } from './config.ts'
import { createServer } from './main.ts'
import { readRecording } from './recording.ts'
import { makeReplay } from './sources/replay.ts'

const FILE = fileURLToPath(new URL('../data/fixtures/golden/recording-sample.jsonl', import.meta.url))
const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))
const KSFO = { lat: 37.6188, lon: -122.3758 }
const CHASED = 'a067ec' // airborne ADS-B v2 near KSFO; moves between the recording's two real polls (2.5 s apart)
const HIDDEN = '000002' // dbFlags 8 (LADD)
const T0 = 2_000_000_000_000 // injected server clock, far from the recording's (1.79e12): proves the rebase

const tmp = (): string => mkdtempSync(join(tmpdir(), 'fh-main-'))

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
  const app = createServer(cfg) // source from makeSource(cfg), real clock: what `npm run server` builds
  const base = await app.listen(0)
  t.after(() => app.close())

  await assertApi(base, 'readsb', () => {}) // real time: the fake receiver reaches the second poll 2.5 s after start

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

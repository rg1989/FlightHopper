// server/main.browse.test.ts
// The browse additions to the server: `info` on /api/view, `raw` + `info` on /api/chase, gzip, the route timer, and
// the 5,000-aircraft view budget. The real server on port 0 with an in-memory source; no network beyond 127.0.0.1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { gunzipSync } from 'node:zlib'
import type { ChaseResponse, ViewResponse } from '../shared/api.ts'
import { destination } from '../shared/geo.ts'
import type { ReadsbAircraft } from '../shared/types.ts'
import { readServerConfig } from './config.ts'
import { createServer } from './main.ts'
import { ROUTESET_URL } from './routes.ts'
import type { FetchResult, Source } from './sources/types.ts'

const FILE = new URL('../data/fixtures/golden/recording-sample.jsonl', import.meta.url).pathname
const CENTER = { lat: 32.0114, lon: 34.8867 } // LLBG
const T0 = 2_000_000_000_000

/** An in-memory upstream on an injected clock: every answer is `aircraft` as it is now, received at clock.t. */
function fakeSource(clock: { t: number }, kind: 'readsb' | 'adsblol') {
  const state = { aircraft: [] as ReadsbAircraft[], calls: 0 }
  const answer = (): Promise<FetchResult> => {
    state.calls++
    const snapshot = { nowMs: clock.t, aircraft: state.aircraft }
    return Promise.resolve({ url: `fake:${kind}`, status: 200, tSendMs: clock.t, tRecvMs: clock.t, bytes: 1000, body: '', retryAfterS: null, snapshot })
  }
  const full = kind === 'readsb'
  const source: Source = {
    caps: { kind, fullSnapshot: full, maxRps: 5, coverage: null, attribution: 'test' },
    circle: () => (full ? Promise.reject(new Error('unsupported')) : answer()),
    hexes: () => (full ? Promise.reject(new Error('unsupported')) : answer()),
    all: () => (full ? answer() : Promise.reject(new Error('unsupported'))),
  }
  return { source, state }
}

/** An airborne aircraft `nm` from the centre on bearing `brg`, with the detail fields a real adsb.lol object carries. */
function plane(hex: string, flight: string, brg: number, nm: number, extra: Partial<ReadsbAircraft> = {}): ReadsbAircraft {
  const p = destination(CENTER.lat, CENTER.lon, brg, nm)
  return {
    hex, type: 'adsb_icao', flight: `${flight}  `, r: '4X-EKA', t: 'B738', alt_baro: 24_000, alt_geom: 24_650, gs: 420.3, track: 271.4,
    baro_rate: -832, squawk: '4521', emergency: 'none', category: 'A3', nav_qnh: 1013.2, nav_altitude_mcp: 20_000, nav_heading: 270,
    lat: p.lat, lon: p.lon, nic: 8, rc: 186, seen_pos: 0.4, version: 2, nic_baro: 1, nac_p: 10, nac_v: 2, sil: 3, sil_type: 'perhour',
    gva: 2, sda: 2, alert: 0, spi: 0, mlat: [], tisb: [], messages: 21_345, seen: 0.2, rssi: -18.2, wd: 285, ws: 42, oat: -21, tat: 3,
    ...extra,
  } as ReadsbAircraft
}

async function start(env: Record<string, string>, kind: 'readsb' | 'adsblol', deps: { routesFetch?: typeof fetch } = {}) {
  const clock = { t: T0 }
  const fake = fakeSource(clock, kind)
  const cfg = { ...readServerConfig({ REPLAY_FILES: FILE, ...env }), staticDir: join(mkdtempSync(join(tmpdir(), 'fh-browse-')), 'dist') }
  const app = createServer(cfg, { source: fake.source, nowMs: () => clock.t, ...deps })
  const base = await app.listen(0)
  return { clock, fake, app, base }
}

async function waitFor(what: string, ok: () => boolean, timeoutMs = 8000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!ok()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

/** Moves the clock one poll on and waits until the poller has fetched it. */
async function nextPoll(s: Awaited<ReturnType<typeof start>>, aircraft: ReadsbAircraft[], stepMs = 1000): Promise<void> {
  s.fake.state.aircraft = aircraft
  const n = s.fake.state.calls
  s.clock.t += stepMs
  await waitFor('the next poll', () => s.fake.state.calls > n)
  await sleep(5) // let the ingest finish (it follows the fetch's promise)
}

const viewUrl = (base: string, since: number, nm = 50): string => `${base}/api/view?lat=${CENTER.lat}&lon=${CENTER.lon}&nm=${nm}&since=${since}`
const getJson = async <T>(url: string): Promise<T> => (await fetch(url)).json() as Promise<T>
const infoHexes = (v: ViewResponse): string[] => (v.info ?? []).map((i) => i.hex).sort()
const newest = (v: ViewResponse, since: number): number => v.samples.reduce((m, s) => Math.max(m, s.rxMs), since)

test('view: info for every aircraft on the first poll; later only for aircraft new to the circle, silent ≥ 60 s, or changed', async (t) => {
  const s = await start({}, 'readsb')
  t.after(() => s.app.close())
  const a = (nm: number, x = {}) => plane('aaa001', 'ELY1', 0, nm, x)
  const b = (nm: number, x = {}) => plane('aaa002', 'ELY2', 90, nm, x)
  const c = (nm: number, x = {}) => plane('aaa003', 'ELY3', 180, nm, x) // starts outside the 50 nm view
  const d = (nm: number, x = {}) => plane('aaa004', 'ELY4', 270, nm, x)

  s.fake.state.aircraft = [a(10), b(10), c(60), d(10)]
  await waitFor('the first poll', () => s.fake.state.calls > 0)
  await sleep(5)
  const v1 = await getJson<ViewResponse>(viewUrl(s.base, 0))
  assert.deepEqual(v1.samples.map((x) => x.hex).sort(), ['aaa001', 'aaa002', 'aaa004'])
  assert.deepEqual(infoHexes(v1), ['aaa001', 'aaa002', 'aaa004'])
  assert.deepEqual(v1.info?.find((i) => i.hex === 'aaa001'), {
    hex: 'aaa001', callsign: 'ELY1', reg: '4X-EKA', typeCode: 'B738', category: 'A3', squawk: '4521', emergency: null, military: false, route: null,
  })
  let since = newest(v1, 0)

  // a moves; b squawks 7700; c flies into the view; d is not in this answer.
  await nextPoll(s, [a(11), b(11, { squawk: '7700' }), c(40)])
  const v2 = await getJson<ViewResponse>(viewUrl(s.base, since))
  assert.deepEqual(v2.samples.map((x) => x.hex).sort(), ['aaa001', 'aaa002', 'aaa003'])
  assert.deepEqual(infoHexes(v2), ['aaa002', 'aaa003'])
  assert.equal(v2.info?.find((i) => i.hex === 'aaa002')?.squawk, '7700')
  since = newest(v2, since)

  // Nothing changes: no info.
  await nextPoll(s, [a(12), b(12, { squawk: '7700' }), c(39)])
  const v3 = await getJson<ViewResponse>(viewUrl(s.base, since))
  assert.equal(v3.samples.length, 3)
  assert.deepEqual(v3.info, [])
  since = newest(v3, since)

  // A route arrives between two samples of a (in the same millisecond as a's last answer): it goes out with a's next sample.
  s.app.info.setRoute('ELY1', 'LLBG-EGLL')
  await nextPoll(s, [a(13), b(13, { squawk: '7700' }), c(38)])
  const v4 = await getJson<ViewResponse>(viewUrl(s.base, since))
  assert.deepEqual(v4.info?.map((i) => [i.hex, i.route]), [['aaa001', 'LLBG-EGLL']])
  since = newest(v4, since)

  // Polls 35 s apart are no reason to resend; d comes back after 74 s of silence: the client may have dropped it.
  await nextPoll(s, [a(14), b(14, { squawk: '7700' }), c(37)], 35_000)
  const v5 = await getJson<ViewResponse>(viewUrl(s.base, since))
  assert.deepEqual(v5.info, [])
  since = newest(v5, since)
  await nextPoll(s, [a(15), b(15, { squawk: '7700' }), c(36), d(11)], 35_000)
  const v6 = await getJson<ViewResponse>(viewUrl(s.base, since))
  assert.deepEqual(v6.samples.map((x) => x.hex).sort(), ['aaa001', 'aaa002', 'aaa003', 'aaa004'])
  assert.deepEqual(infoHexes(v6), ['aaa004'])
})

test('chase: raw is the newest full object with seen / seen_pos counted to serverNowMs; info rides along', async (t) => {
  const s = await start({}, 'readsb')
  t.after(() => s.app.close())
  s.fake.state.aircraft = [plane('aaa001', 'ELY1', 0, 10)]
  await waitFor('the first poll', () => s.fake.state.calls > 0)
  await sleep(5)
  s.clock.t += 500 // half a poll period later: no new answer yet
  const c = await getJson<ChaseResponse>(`${s.base}/api/chase?hex=AAA001&since=0`)
  assert.equal(c.serverNowMs, T0 + 500)
  assert.equal(c.samples.length, 1)
  assert.equal(c.info?.callsign, 'ELY1')
  const raw = c.raw!
  assert.equal(raw.hex, 'aaa001')
  assert.equal(raw.nav_altitude_mcp, 20_000)
  assert.equal(raw.ws, 42)
  assert.equal(raw.seen, 0.7)
  assert.equal(raw.seen_pos, 0.9)

  const none = await getJson<ChaseResponse>(`${s.base}/api/chase?hex=abcdef&since=0`)
  assert.equal(none.raw, null)
  assert.equal(none.info, null)
  assert.deepEqual(none.samples, [])
})

/** GET with explicit headers and the body left compressed (fetch would inflate it). */
function rawGet(url: string, headers: Record<string, string>): Promise<{ headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    request(url, { headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }))
    })
      .on('error', reject)
      .end()
  })
}

test('gzip: JSON over 1 KB is gzipped when Accept-Encoding allows it; small or unaccepted bodies are not', async (t) => {
  const s = await start({}, 'readsb')
  t.after(() => s.app.close())
  s.fake.state.aircraft = Array.from({ length: 30 }, (_, i) => plane(`aab${String(i).padStart(3, '0')}`, `ELY${i + 1}`, i * 12, 20))
  await waitFor('the first poll', () => s.fake.state.calls > 0)
  await sleep(5)
  const url = viewUrl(s.base, 0)

  const gz = await rawGet(url, { 'accept-encoding': 'gzip, deflate, br' })
  assert.equal(gz.headers['content-encoding'], 'gzip')
  assert.equal(gz.headers['content-type'], 'application/json')
  assert.equal(gz.headers.vary, 'accept-encoding')
  assert.equal(Number(gz.headers['content-length']), gz.body.length)
  const view = JSON.parse(gunzipSync(gz.body).toString('utf8')) as ViewResponse
  assert.equal(view.samples.length, 30)
  assert.equal(view.info?.length, 30)

  const plain = await rawGet(url, {})
  assert.equal(plain.headers['content-encoding'], undefined)
  assert.equal(Number(plain.headers['content-length']), plain.body.length)
  assert.ok(plain.body.length > 4 * gz.body.length, `${plain.body.length} B plain vs ${gz.body.length} B gzip`)
  assert.equal((JSON.parse(plain.body.toString('utf8')) as ViewResponse).samples.length, 30)

  for (const refuse of ['identity', 'gzip;q=0', 'br']) {
    assert.equal((await rawGet(url, { 'accept-encoding': refuse })).headers['content-encoding'], undefined, refuse)
  }
  assert.equal((await rawGet(url, { 'accept-encoding': 'GZIP;q=0.5' })).headers['content-encoding'], 'gzip')

  const small = await rawGet(`${s.base}/api/nope`, { 'accept-encoding': 'gzip' })
  assert.equal(small.headers['content-encoding'], undefined)
  assert.match(small.body.toString('utf8'), /no such endpoint/)
})

/** A fake routeset endpoint: records every request and answers each callsign with a fixed route. */
function fakeRoutes() {
  const calls: { url: string; planes: { callsign: string }[] }[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const { planes } = JSON.parse(String(init?.body)) as { planes: { callsign: string }[] }
    calls.push({ url: String(input), planes })
    const body = planes.map((p) => ({ callsign: p.callsign, airport_codes: 'LLBG-EGLL', _airport_codes_iata: 'TLV-LHR', _airports: [], plausible: true }))
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  return { calls, fn }
}

test('routes: fetched only with ADSB_SOURCE=adsblol and ROUTES=1, through the poller budget, and served in info', async (t) => {
  const routes = fakeRoutes()
  const env = { ADSB_SOURCE: 'adsblol', CONTACT: 'me@example.invalid', ROUTES: '1', MAX_RPS: '0.02' }
  const s = await start(env, 'adsblol', { routesFetch: routes.fn })
  t.after(() => s.app.close())
  s.fake.state.aircraft = [plane('aaa001', 'ELY1', 0, 10), plane('aaa002', 'N123AB', 90, 10)]
  const v0 = await getJson<ViewResponse>(viewUrl(s.base, 0)) // touches the view's two cells
  assert.deepEqual(v0.samples, [])
  await waitFor('the route answer', () => s.app.info.get('aaa001')?.route != null)
  assert.equal(routes.calls[0].url, ROUTESET_URL)
  assert.deepEqual(routes.calls[0].planes.map((p) => p.callsign), ['ELY1'])
  const v1 = await getJson<ViewResponse>(viewUrl(s.base, 0))
  assert.equal(v1.info?.find((i) => i.hex === 'aaa001')?.route, 'LLBG-EGLL')
  assert.equal(v1.info?.find((i) => i.hex === 'aaa002')?.route, null)
  // The static clock gives only the bucket's two burst tokens: the first cell took one and the route request the other.
  assert.equal(s.fake.state.calls, 1)
  assert.equal(s.app.poller.report().budget.counts.ok, 2, 'the route request used a poller token')

  // A race for one token: 60 s later (1.2 tokens at 0.02 req/s) a new callsign needs a route and both cells are due.
  // The route timer fires first, so the route request wins; the cells wait for the next token.
  s.app.info.update(plane('aaa003', 'ELY3', 180, 10), s.clock.t)
  s.clock.t += 60_000
  s.app.poller.touchView(CENTER.lat, CENTER.lon, 50)
  await waitFor('the second route answer', () => s.app.info.get('aaa003')?.route != null)
  await sleep(300)
  assert.equal(routes.calls.length, 2)
  assert.deepEqual(routes.calls[1].planes.map((p) => p.callsign), ['ELY3'])
  assert.equal(s.fake.state.calls, 1, 'no cell got the token')

  for (const [label, e, kind] of [
    ['ROUTES unset', { ADSB_SOURCE: 'adsblol', CONTACT: 'me@example.invalid' }, 'adsblol'],
    ['ROUTES=0', { ADSB_SOURCE: 'adsblol', CONTACT: 'me@example.invalid', ROUTES: '0' }, 'adsblol'],
    ['readsb', { ADSB_SOURCE: 'readsb', READSB_COVERAGE: '32,34.9,200', ROUTES: '1' }, 'readsb'],
    ['replay', { ROUTES: '1' }, 'readsb'],
  ] as const) {
    const never = fakeRoutes()
    const o = await start(e, kind, { routesFetch: never.fn })
    o.fake.state.aircraft = [plane('aaa001', 'ELY1', 0, 10)]
    await getJson<ViewResponse>(viewUrl(o.base, 0))
    await waitFor('a poll', () => o.fake.state.calls > 0)
    await sleep(300)
    await o.app.close()
    assert.equal(never.calls.length, 0, label)
  }
})

test('budget: /api/view of a 250 nm circle with 5,000 aircraft answers in ≤ 50 ms (server side, gzip)', async (t) => {
  const s = await start({}, 'readsb')
  t.after(() => s.app.close())
  const fleet = (step: number): ReadsbAircraft[] =>
    Array.from({ length: 5000 }, (_, i) => plane(`b${i.toString(16).padStart(5, '0')}`, `ELY${i}`, (i * 137.5) % 360, 5 + ((i * 7.3 + step) % 240)))
  s.fake.state.aircraft = fleet(0)
  await waitFor('the first poll', () => s.fake.state.calls > 0, 20_000)
  for (let step = 1; step <= 10; step++) await nextPoll(s, fleet(step)) // 11 samples per aircraft in the store
  const since = s.clock.t - 1000 // a client one poll behind: every aircraft has one new sample

  /** Request → last byte, as the server sends it (gzip); the client's gunzip and JSON parse are not timed. */
  const timed = async (url: string): Promise<{ ms: number; body: ViewResponse; bytes: number }> => {
    const t0 = performance.now()
    const r = await rawGet(url, { 'accept-encoding': 'gzip' })
    const ms = performance.now() - t0
    assert.equal(r.headers['content-encoding'], 'gzip')
    return { ms, body: JSON.parse(gunzipSync(r.body).toString('utf8')) as ViewResponse, bytes: r.body.length }
  }
  const median = (xs: number[]): number => xs.sort((x, y) => x - y)[xs.length >> 1]
  const first: number[] = []
  const next: number[] = []
  let bytes = [0, 0]
  for (let i = 0; i < 5; i++) {
    const a = await timed(viewUrl(s.base, 0, 250))
    assert.equal(a.body.samples.length, 5000)
    assert.equal(a.body.info?.length, 5000)
    first.push(a.ms)
    const b = await timed(viewUrl(s.base, since, 250))
    assert.equal(b.body.samples.length, 5000)
    assert.deepEqual(b.body.info, [])
    next.push(b.ms)
    bytes = [a.bytes, b.bytes]
  }
  t.diagnostic(`5,000 aircraft, 250 nm: since=0 median ${median(first).toFixed(1)} ms (${bytes[0]} B gzip); since=last median ${median(next).toFixed(1)} ms (${bytes[1]} B gzip)`)
  assert.ok(median(first) <= 50, `since=0 median ${median(first).toFixed(1)} ms`)
  assert.ok(median(next) <= 50, `since>0 median ${median(next).toFixed(1)} ms`)
})

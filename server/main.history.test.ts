// server/main.history.test.ts
// The past over HTTP: /api/history, /api/history/status and /api/trace on the real server (port 0), with adsb.lol's
// files and the type table from a fake fetch. Nothing here reaches adsb.lol or GitHub. A server fetches the past by itself
// only when asked to: to roll it, or to look up its types and oldest day.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { HistorySlot, HistoryStatus, TraceDay, TraceReply } from '../shared/api.ts'
import { SLOT_MS, newestSlotMs } from '../shared/history.ts'
import type { ReadsbAircraft } from '../shared/types.ts'
import { readServerConfig } from './config.ts'
import { encodeHeatmap } from './heatmap.ts'
import { heatmapUrl } from './historyStore.ts'
import { commandLineDeps, createServer, rollsHistory } from './main.ts'
import { makeReplay } from './sources/replay.ts'
import type { FetchResult, Source } from './sources/types.ts'
import { TYPE_DB_URL, TypeDb, buildTypeTable, encodeZip } from './typeDb.ts'

const FILE = fileURLToPath(new URL('../data/fixtures/golden/recording-sample.jsonl', import.meta.url))
const T0 = 2_000_000_000_000 // the injected server clock (2033)
const SLOT = newestSlotMs(T0) - SLOT_MS // a published half hour: the second newest
const HOUR = 3_600_000
const DAY_MS = 24 * HOUR
const TODAY = Math.floor(T0 / DAY_MS) * DAY_MS // 00:00 UTC of the clock's day
const GUESS = TODAY - 30 * DAY_MS // the oldest day until a search finds it
const heatUrl = (slotMs: number): string => heatmapUrl('https://adsb.lol', slotMs)

/** A heatmap file of one half hour: 4691c4 near Ben Gurion in two slices, and a far one. */
const heatFile = (slotMs: number): Uint8Array =>
  encodeHeatmap([
    { tMs: slotMs, records: [{ hex: '4691c4', lat: 32.3, lon: 34.6, alt: 6000, gs: 280 }, { hex: '4691c4', callsign: 'AEE4266', squawk: '1234' }, { hex: 'a1b2c3', lat: 40, lon: 10, alt: 'g', gs: null }] },
    { tMs: slotMs + 10_000, records: [{ hex: '4691c4', lat: 32.29, lon: 34.63, alt: 5900, gs: 279 }] },
  ])
const heatResponse = (slotMs: number): Response => new Response(heatFile(slotMs).buffer as ArrayBuffer)

/** A readsb trace file of one A320 leg, its last point `lastAgoS` seconds before the server clock: AEE4266, 5 minutes long. */
const traceFile = (hex: string, lastAgoS: number) => ({
  icao: hex, r: 'SX-DND', t: 'A320', timestamp: T0 / 1000 - lastAgoS - 300,
  trace: [[0, 32.4, 34.3, 9000, 300, 110, 2, -800, { flight: 'AEE4266 ' }], [300, 32.3, 34.6, 6000, 280, 112, 0, -700, null]],
})
// Two legs of one aircraft in a live file: yesterday's, 20 h ago, and today's, whose last point was 5 minutes ago.
const twoLegs = {
  icao: '4691ca', r: 'SX-DND', t: 'A320', timestamp: T0 / 1000 - 20 * 3600,
  trace: [
    [0, 32.4, 34.3, 9000, 300, 110, 2, -800, { flight: 'AEE4266 ' }], [300, 32.3, 34.6, 6000, 280, 112, 0, -700, null],
    [20 * 3600 - 600, 37.9, 23.9, 5000, 250, 90, 2, 0, { flight: 'AEE4266 ' }], [20 * 3600 - 300, 38, 24, 6000, 250, 90, 0, 0, null],
  ],
}
const TRACES: Record<string, { trace: unknown[] }> = {
  '4691c4': traceFile('4691c4', 300), // flying now: its last point was 5 minutes ago
  '4691c5': traceFile('4691c5', 900), // 15 minutes ago
  '4691c6': traceFile('4691c6', 600), // exactly 10 minutes ago
  '4691c7': traceFile('4691c7', 600.1), // 10 minutes and 100 ms ago
  '4691ca': twoLegs,
}

/**
 * adsb.lol as a fake fetch: one heatmap file (SLOT) and a few live traces; everything else 404. `custom` answers a URL its
 * own way. A HEAD of a day's first half hour (the oldest-day search) is 200 from state.oldest on, 404 before it.
 */
function upstream() {
  const urls: string[] = []
  const state = { heat: 'ok' as 'ok' | 'down' | 'html' | 'error', oldest: TODAY - 42 * DAY_MS }
  const custom = new Map<string, (init?: RequestInit) => Response | Promise<Response>>()
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    urls.push(url)
    const own = custom.get(url)
    if (own !== undefined) return own(init)
    const day = /\/globe_history\/(\d{4})\/(\d{2})\/(\d{2})\/heatmap\/00\.bin\.ttf$/.exec(url)
    if (init?.method === 'HEAD' && day !== null) {
      return new Response(null, { status: Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])) >= state.oldest ? 200 : 404 })
    }
    if (url === heatUrl(SLOT)) {
      if (state.heat === 'error') throw new Error('ECONNRESET')
      if (state.heat === 'down') return new Response('Service Unavailable', { status: 503 })
      if (state.heat === 'html') return new Response('<html><body>Maintenance</body></html>')
      return heatResponse(SLOT)
    }
    const hex = /\/data\/traces\/[0-9a-f]{2}\/trace_full_([0-9a-f]{6})\.json$/.exec(url)?.[1]
    if (hex !== undefined && TRACES[hex] !== undefined) return new Response(JSON.stringify(TRACES[hex]))
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { urls, fetchFn, state, custom }
}

/** A live source (kind readsb) that answers with no aircraft, on an injected clock: a server on it is not a replay. */
function liveSource(clock: { t: number }): Source {
  const answer = (): Promise<FetchResult> =>
    Promise.resolve({ url: 'fake:readsb', status: 200, tSendMs: clock.t, tRecvMs: clock.t, bytes: 0, body: '', retryAfterS: null, snapshot: { nowMs: clock.t, aircraft: [] } })
  return {
    caps: { kind: 'readsb', fullSnapshot: true, maxRps: 5, coverage: null, attribution: 'test' },
    circle: () => Promise.reject(new Error('unsupported')),
    hexes: () => Promise.reject(new Error('unsupported')),
    all: answer,
  }
}

const config = () => ({ ...readServerConfig({ REPLAY_FILES: FILE }), staticDir: join(mkdtempSync(join(tmpdir(), 'fh-hist-')), 'dist') })

async function get<T>(url: string): Promise<{ status: number; body: T; retryAfter: string | null }> {
  const res = await fetch(url)
  return { status: res.status, body: (await res.json()) as T, retryAfter: res.headers.get('retry-after') }
}

async function waitFor(what: string, ok: () => boolean, timeoutMs = 4000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!ok()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

const slotUrl = (base: string, slotMs: number, nm = 60): string => `${base}/api/history?slot=${slotMs}&lat=32&lon=34.8&nm=${nm}`

/** A replay server on the injected clock with the fake adsb.lol; it fetches the past only when asked. `deps` adds to its deps. */
async function start(t: { after: (fn: () => Promise<void>) => void }, deps: Parameters<typeof createServer>[1] = {}) {
  const nowMs = (): number => T0
  const cfg = config()
  const up = upstream()
  const app = createServer(cfg, { source: makeReplay({ files: cfg.replayFiles, nowMs }), nowMs, historyFetch: up.fetchFn, ...deps })
  const base = await app.listen(0)
  t.after(() => app.close())
  return { app, base, up }
}

const TYPES = { A320: { desc: 'L2J', wtc: 'M' }, R44: { desc: 'H1P', wtc: 'L' } }
/** Mictronics' zip, as the type table's download serves it: 4691c4 is an A320. */
const typeZip = (): Uint8Array<ArrayBuffer> =>
  encodeZip([
    { name: 'types.json', data: new TextEncoder().encode(JSON.stringify(TYPES)), method: 8 },
    { name: 'aircrafts.json', data: new TextEncoder().encode(JSON.stringify({ '4691C4': { r: 'SX-DND', t: 'A320', f: '00', d: '' } })), method: 8 },
  ])

test('the past over HTTP: a half hour in a circle, what is held, an aircraft\'s leg; 404 where there is none, 400 for bad asks', async (t) => {
  const { base, up } = await start(t)
  assert.equal(up.urls.length, 0, 'a server fetches no past by itself')

  const slot = await get<HistorySlot>(slotUrl(base, SLOT))
  assert.equal(slot.status, 200)
  assert.equal(slot.retryAfter, null)
  assert.equal(slot.body.slotMs, SLOT)
  assert.equal(slot.body.stepS, 10)
  assert.deepEqual(slot.body.aircraft.map((a) => [a.hex, a.callsign, a.squawk, a.t, a.alt, a.type, a.category]), [['4691c4', 'AEE4266', '1234', [0, 10], [6000, 5900], null, null]], 'no type table: no types')
  const missing = await get<{ error: string }>(slotUrl(base, SLOT - SLOT_MS))
  assert.equal(missing.status, 404)
  assert.equal(missing.retryAfter, null, 'a 404 is final: nothing to retry')

  const st = await get<HistoryStatus>(`${base}/api/history/status`)
  assert.equal(st.status, 200)
  assert.equal(st.body.newestSlotMs, newestSlotMs(T0))
  assert.equal(st.body.oldestSlotMs, GUESS, 'no search: 30 days back, 00:00 UTC')
  assert.deepEqual(st.body.slots.map((s) => [s.slotMs, s.state]), [[SLOT - SLOT_MS, 'missing'], [SLOT, 'ready']])

  const leg = await get<TraceReply>(`${base}/api/trace?hex=4691c4`)
  assert.equal(leg.status, 200)
  assert.deepEqual([leg.body.callsign, leg.body.reg, leg.body.typeCode, leg.body.t, leg.body.alt, leg.body.origin], ['AEE4266', 'SX-DND', 'A320', [0, 300], [9000, 6000], null])
  assert.deepEqual(leg.body.calls, [[0, 'AEE4266']], 'the at mode has its calls too')
  assert.equal((await get(`${base}/api/trace?hex=abcdef`)).status, 404)

  for (const bad of [`/api/history?slot=${SLOT + 1}&lat=32&lon=34.8&nm=60`, `/api/history?slot=${SLOT}&lat=91&lon=0&nm=60`, `/api/history?slot=${SLOT}&lat=0&lon=0&nm=0`,
    `/api/history?slot=${SLOT}&lat=0&lon=0&nm=6000`, '/api/history?lat=0&lon=0&nm=60', '/api/trace?hex=xyz', '/api/trace?hex=4691c4&at=soon']) {
    assert.equal((await get(base + bad)).status, 400, bad)
  }
})

test('only a half hour adsb.lol has not got is 404: trouble upstream, or not published yet, is 503 with Retry-After 15 and is not remembered', async (t) => {
  const { base, up } = await start(t)
  const url = slotUrl(base, SLOT)
  for (const trouble of ['down', 'html', 'error'] as const) {
    up.state.heat = trouble
    const r = await get<{ error: string }>(url)
    assert.equal(r.status, 503, trouble)
    assert.equal(r.retryAfter, '15', trouble)
    assert.equal(typeof r.body.error, 'string', trouble)
  }
  assert.equal(up.urls.length, 3, 'each was asked again at once: none was remembered')
  assert.deepEqual((await get<HistoryStatus>(`${base}/api/history/status`)).body.slots, [], 'not held, not missing')
  up.state.heat = 'ok'
  const ok = await get<HistorySlot>(url)
  assert.equal(ok.status, 200)
  assert.equal(ok.retryAfter, null)

  // The half hour after the newest published one has no file yet: say so without asking adsb.lol.
  const before = up.urls.length
  const early = await get(slotUrl(base, newestSlotMs(T0) + SLOT_MS))
  assert.equal(early.status, 503)
  assert.equal(early.retryAfter, '15')
  assert.equal(up.urls.length, before)

  // The newest published one answering 404 is late, not missing: 503 too, and not asked again for 15 s.
  const late = await get(slotUrl(base, newestSlotMs(T0)))
  assert.equal(late.status, 503)
  assert.equal(late.retryAfter, '15')
  assert.equal((await get(slotUrl(base, newestSlotMs(T0)))).status, 503)
  assert.equal(up.urls.length, before + 1, 'asked once')
  assert.ok(!(await get<HistoryStatus>(`${base}/api/history/status`)).body.slots.some((s) => s.state === 'missing'), 'not marked missing')
})

test('a third half hour downloaded at once is 503; a held one and a missing one still answer', async (t) => {
  const { base, up } = await start(t)
  const [a, b, c] = [SLOT - 2 * SLOT_MS, SLOT - 3 * SLOT_MS, SLOT - 4 * SLOT_MS]
  const gates = [deferred(), deferred()]
  up.custom.set(heatUrl(a), () => gates[0].promise.then(() => heatResponse(a)))
  up.custom.set(heatUrl(b), () => gates[1].promise.then(() => heatResponse(b)))
  assert.equal((await get(slotUrl(base, SLOT))).status, 200, 'held from now on')
  assert.equal((await get(slotUrl(base, SLOT - SLOT_MS))).status, 404, 'remembered missing from now on')
  const pa = get<HistorySlot>(slotUrl(base, a))
  const pb = get<HistorySlot>(slotUrl(base, b))
  await waitFor('two downloads under way', () => up.urls.includes(heatUrl(a)) && up.urls.includes(heatUrl(b)))
  const before = up.urls.length
  const third = await get(slotUrl(base, c))
  assert.equal(third.status, 503)
  assert.equal(third.retryAfter, '15')
  assert.equal((await get(slotUrl(base, SLOT))).status, 200)
  assert.equal((await get(slotUrl(base, SLOT - SLOT_MS))).status, 404)
  assert.equal(up.urls.length, before, 'nothing more was asked')
  gates[0].resolve()
  gates[1].resolve()
  assert.equal((await pa).status, 200)
  assert.equal((await pb).status, 200)
})

test('a half hour before the oldest day adsb.lol keeps is 404 with no request: 30 days back until a search finds it, or the day put in', async (t) => {
  const { base, up } = await start(t)
  for (const slot of [GUESS - SLOT_MS, GUESS - 100 * SLOT_MS]) assert.equal((await get(slotUrl(base, slot))).status, 404, String(slot))
  assert.equal(up.urls.length, 0)
  assert.equal((await get(slotUrl(base, GUESS))).status, 404, 'the oldest day\'s first half hour is asked, and adsb.lol has none')
  assert.deepEqual(up.urls, [heatUrl(GUESS)])

  const oldest = TODAY - 42 * DAY_MS
  const told = await start(t, { oldestSlotMs: oldest })
  assert.equal((await get<HistoryStatus>(`${told.base}/api/history/status`)).body.oldestSlotMs, oldest)
  assert.equal((await get(slotUrl(told.base, oldest - SLOT_MS))).status, 404)
  assert.equal(told.up.urls.length, 0)
  assert.equal((await get(slotUrl(told.base, GUESS - SLOT_MS))).status, 404, 'past the guess, within the day put in: asked')
  assert.deepEqual(told.up.urls, [heatUrl(GUESS - SLOT_MS)])
})

test('/api/history: each aircraft with its type and the category it implies from the type table put in; an address it does not know has none', async (t) => {
  const types = new TypeDb({ userAgent: 'test', table: buildTypeTable({ '4691C4': { t: 'A320' }, A1B2C4: { t: 'R44' } }, TYPES) })
  const { base } = await start(t, { types })
  const slot = await get<HistorySlot>(slotUrl(base, SLOT, 5400)) // the whole world: the aircraft at 40 N 10 E too
  assert.equal(slot.status, 200)
  assert.deepEqual(slot.body.aircraft.map((a) => [a.hex, a.type, a.category]), [['4691c4', 'A320', 'A3'], ['a1b2c3', null, null]])
})

test('the command line\'s lookups: the type table and the oldest day come through the past\'s fetch; the first ask for the past waits for the table', async (t) => {
  const nowMs = (): number => T0
  const cfg = config()
  const up = upstream()
  const gate = deferred()
  up.custom.set(TYPE_DB_URL, () => gate.promise.then(() => new Response(typeZip(), { headers: { etag: '"w40"' } })))
  const app = createServer(cfg, { source: makeReplay({ files: cfg.replayFiles, nowMs }), nowMs, historyFetch: up.fetchFn, historyMeta: true })
  const base = await app.listen(0)
  t.after(() => app.close())

  let answered = false
  const first = get<HistorySlot>(slotUrl(base, SLOT)).then((r) => ((answered = true), r))
  await waitFor('the half hour and the type table asked for', () => up.urls.includes(heatUrl(SLOT)) && up.urls.includes(TYPE_DB_URL))
  await sleep(100)
  assert.equal(answered, false, 'the first ask waits for the table')
  gate.resolve()
  const r = await first
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.aircraft.map((a) => [a.hex, a.type, a.category]), [['4691c4', 'A320', 'A3']])

  let oldest = 0
  for (let i = 0; i < 200 && oldest !== TODAY - 42 * DAY_MS; i++) {
    oldest = (await get<HistoryStatus>(`${base}/api/history/status`)).body.oldestSlotMs
    await sleep(5)
  }
  assert.equal(oldest, TODAY - 42 * DAY_MS, 'the search found the oldest day the fake keeps')
  const heads = up.urls.filter((u) => u.endsWith('/heatmap/00.bin.ttf'))
  assert.ok(heads.length >= 1 && heads.length <= 6, `${heads.length} HEADs`)
  assert.equal((await get(slotUrl(base, oldest - SLOT_MS))).status, 404, 'before it: 404')
})

test('/api/trace?hex&from&to: every leg of the span, each with its calls and no origin; to capped at now, from raised to the oldest day', async (t) => {
  const oldest = TODAY - 42 * DAY_MS
  const { base, up } = await start(t, { oldestSlotMs: oldest })
  const span = async (q: string): Promise<{ status: number; body: TraceDay; retryAfter: string | null }> => get<TraceDay>(`${base}/api/trace?${q}`)

  const both = await span(`hex=4691ca&from=${T0 - 24 * HOUR}&to=${T0 + HOUR}`)
  assert.equal(both.status, 200)
  assert.deepEqual([both.body.hex, both.body.reg, both.body.typeCode, both.body.fromMs, both.body.toMs], ['4691ca', 'SX-DND', 'A320', T0 - 24 * HOUR, T0], 'to capped at now')
  assert.deepEqual(both.body.legs.map((l) => [l.t0Ms, l.t, l.calls]), [[T0 - 20 * HOUR, [0, 300], [[0, 'AEE4266']]], [T0 - 600_000, [0, 300], [[0, 'AEE4266']]]])
  assert.ok(both.body.legs.every((l) => !('origin' in l)))
  assert.deepEqual((await span(`hex=4691ca&from=${T0 - 10 * HOUR}&to=${T0}`)).body.legs.map((l) => l.t0Ms), [T0 - 600_000], 'only the legs overlapping the span')

  const none = await span(`hex=4691c8&from=${T0 - HOUR}&to=${T0}`)
  assert.deepEqual([none.status, none.body.legs], [200, []], 'no trace at all: no legs, not a 404')

  const before = up.urls.length
  const raised = await span(`hex=4691c4&from=${oldest - 10 * HOUR}&to=${oldest + 2 * HOUR}`)
  assert.deepEqual([raised.status, raised.body.fromMs, raised.body.toMs, raised.body.legs], [200, oldest, oldest + 2 * HOUR, []], 'from raised to the oldest day')
  const day = new Date(oldest).toISOString().slice(0, 10).replaceAll('-', '/')
  assert.deepEqual(up.urls.slice(before), [`https://adsb.lol/globe_history/${day}/traces/c4/trace_full_4691c4.json`], 'not the day before it')

  assert.equal((await span(`hex=4691ca&from=${T0 - 48 * HOUR}&to=${T0}`)).status, 200, '48 h is the most')
  const capped = await span(`hex=4691ca&from=${T0 - 48 * HOUR}&to=${T0 + 6 * HOUR}`)
  assert.deepEqual([capped.status, capped.body.toMs], [200, T0], '54 h asked, 48 h once to is capped at now: the span is measured after')
  for (const bad of [
    `hex=4691ca&from=${T0 - 48 * HOUR - 1}&to=${T0}`, // over 48 h
    `hex=4691ca&from=${T0}&to=${T0 - 1}`, // from after to
    `hex=4691ca&from=${T0 + 1}&to=${T0 + HOUR}`, // in the future
    `hex=4691ca&from=${oldest - 3 * HOUR}&to=${oldest - 1}`, // before the oldest day
    `hex=4691ca&from=${T0 - HOUR}`, `hex=4691ca&to=${T0}`, `hex=4691ca&from=soon&to=${T0}`, // not both, not a time
    `hex=4691ca&at=${T0}&from=${T0 - HOUR}&to=${T0}`, // two modes at once
    `hex=xyz&from=${T0 - HOUR}&to=${T0}`,
  ]) {
    assert.equal((await span(bad)).status, 400, bad)
  }
})

test('/api/trace?hex&from&to: a file of the span that cannot be had is 503 with Retry-After 15, not a day without flights', async (t) => {
  const { base, up } = await start(t)
  const from = TODAY - 3 * DAY_MS
  const day = new Date(from).toISOString().slice(0, 10).replaceAll('-', '/')
  up.custom.set(`https://adsb.lol/globe_history/${day}/traces/c4/trace_full_4691c4.json`, () => new Response('Bad Gateway', { status: 502 }))
  const r = await get<{ error: string }>(`${base}/api/trace?hex=4691c4&from=${from}&to=${from + 6 * HOUR}`)
  assert.equal(r.status, 503)
  assert.equal(r.retryAfter, '15')
  assert.equal(typeof r.body.error, 'string')
})

test('trace: origin only for a flight that is flying now: the leg ended within 10 minutes and its callsign is the aircraft\'s now', async (t) => {
  const { app, base, up } = await start(t)
  const flying = (hex: string, flight: string): ReadsbAircraft => ({ hex, flight, lat: 32.3, lon: 34.6, alt_baro: 6000 }) as ReadsbAircraft
  app.info.setPlaces([{ code: 'LGAV', lat: 37.9364, lon: 23.9445 }, { code: 'LLBG', lat: 32.0114, lon: 34.8867 }])
  app.info.setRoute('AEE4266', 'LGAV-LLBG')
  app.info.setRoute('AEE4277', 'LGAV-LLBG')
  for (const hex of ['4691c4', '4691c5', '4691c6', '4691c7', '4691ca']) app.info.update(flying(hex, 'AEE4266 '), T0)
  const LGAV = { code: 'LGAV', lat: 37.9364, lon: 23.9445 }
  const leg = async (hex: string, at?: number): Promise<TraceReply> => {
    const r = await get<TraceReply>(`${base}/api/trace?hex=${hex}${at === undefined ? '' : `&at=${at}`}`)
    assert.equal(r.status, 200, hex)
    return r.body
  }

  assert.deepEqual((await leg('4691c4')).origin, LGAV, 'its last point 5 min ago, the same callsign')
  assert.deepEqual((await leg('4691c6')).origin, LGAV, 'exactly 10 min ago is within')
  assert.equal((await leg('4691c7')).origin, null, '10 min and 100 ms ago is not')
  assert.equal((await leg('4691c5')).origin, null, '15 min ago: not flying now')
  // Yesterday's leg and today's of one aircraft, one callsign: only today's, the one flying, has the origin.
  assert.deepEqual((await leg('4691ca')).origin, LGAV)
  const yesterday = await leg('4691ca', T0 - 20 * 3_600_000 + 60_000)
  assert.equal(yesterday.t0Ms, T0 - 20 * 3_600_000, 'it is the leg of 20 h ago')
  assert.equal(yesterday.origin, null, 'which had landed long before now: today\'s origin is not its')

  app.info.update(flying('4691c4', 'AEE4277 '), T0) // the aircraft is on another flight now
  const other = await leg('4691c4')
  assert.equal(other.callsign, 'AEE4266')
  assert.equal(other.origin, null, 'the leg is flight AEE4266, the aircraft flies AEE4277: that flight\'s origin is not its')
  assert.equal((await get(`${base}/api/trace?hex=4691c8`)).status, 404, 'no trace at all: 404')
  assert.ok(up.urls.length > 0)
})

test('a server on a live source asks adsb.lol for nothing unless it is asked to roll the past; rolling holds the newest two half hours', async (t) => {
  const clock = { t: T0 }
  const nowMs = (): number => clock.t
  const idle = upstream()
  const quiet = createServer(config(), { source: liveSource(clock), nowMs, historyFetch: idle.fetchFn })
  await quiet.listen(0)
  t.after(() => quiet.close())
  await sleep(120)
  assert.deepEqual(idle.urls, [], 'rolling is off by default: not a request')

  const rolling = upstream()
  const newest = newestSlotMs(T0)
  rolling.custom.set(heatUrl(newest), () => heatResponse(newest))
  rolling.custom.set(heatUrl(newest - SLOT_MS), () => heatResponse(newest - SLOT_MS))
  const roller = createServer(config(), { source: liveSource(clock), nowMs, historyFetch: rolling.fetchFn, rollHistory: true })
  const base = await roller.listen(0)
  t.after(() => roller.close())
  await waitFor('the newest two half hours', () => rolling.urls.length >= 2)
  assert.deepEqual(rolling.urls, [heatUrl(newest), heatUrl(newest - SLOT_MS)], 'the newest, then the one before')
  let slots: HistoryStatus['slots'] = []
  for (let i = 0; i < 200 && slots.filter((s) => s.state === 'ready').length < 2; i++) {
    slots = (await get<HistoryStatus>(`${base}/api/history/status`)).body.slots
    await sleep(5)
  }
  assert.deepEqual(slots.map((s) => [s.slotMs, s.state]), [[newest - SLOT_MS, 'ready'], [newest, 'ready']])
})

test('the command line rolls the past for a live source and not for a replay; it looks up the types and the oldest day for both', () => {
  const replay = readServerConfig({ ADSB_SOURCE: 'replay', REPLAY_FILES: FILE })
  const live = readServerConfig({ ADSB_SOURCE: 'readsb', READSB_URL: 'http://127.0.0.1:1', READSB_COVERAGE: '37.6,-122.4,200' })
  assert.equal(rollsHistory(readServerConfig({ REPLAY_FILES: FILE })), false)
  assert.equal(rollsHistory(replay), false)
  assert.equal(rollsHistory(live), true)
  assert.deepEqual(commandLineDeps(replay), { rollHistory: false, historyMeta: true })
  assert.deepEqual(commandLineDeps(live), { rollHistory: true, historyMeta: true })
})

test('closing the server aborts the downloads under way', async (t) => {
  const { app, base, up } = await start(t)
  const signals: AbortSignal[] = []
  up.custom.set(heatUrl(SLOT), (init) => {
    signals.push(init!.signal!)
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)))
  })
  const waiting = fetch(slotUrl(base, SLOT)).then((r) => r.status, () => 'dropped')
  await waitFor('the download', () => signals.length === 1)
  assert.equal(signals[0].aborted, false)
  await app.close()
  assert.equal(signals[0].aborted, true)
  await waiting
})

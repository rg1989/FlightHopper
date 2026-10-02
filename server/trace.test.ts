// server/trace.test.ts
// traceUrl, traceReply and TraceStore on small synthetic trace files and a fake fetch on a fake clock. Nothing here
// touches the network. The file layout is adsb.lol's readsb "trace json", checked on a real live file and a real day
// file (2026-10-02): { icao, r, t, timestamp, trace: [[dtS, lat, lon, alt | "ground" | null, gs, track, flags, vrate,
// acObj | null, source, geomAlt, geomRate, ias, roll], …] }; `flight` in an acObj is padded to 8 characters.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import type { TraceReply } from '../shared/api.ts'
import { TraceStore, traceReply, traceUrl } from './trace.ts'

const BASE = 'https://adsb.lol'
const HOUR = 3_600_000
const NOW = Date.UTC(2026, 9, 2, 5, 0, 0) // 2026-10-02T05:00:00Z
const HEX = '4691c4'

// A day file's timestamp is its UTC midnight (s); each point is at timestamp + dtS.
const DAY_S = Date.UTC(2026, 8, 22) / 1000
const LEG1_MS = 1_790_050_650_110 // 2026-09-22T04:17:30.110Z: the first point of leg 1
const LEG2_MS = 1_790_066_466_900 // 08:41:06.900Z: the first point of leg 2 (flags 3: stale and new leg)
const LEG2_END_MS = 1_790_066_477_400 // 08:41:17.400Z: its last point

interface RowOpts { gs?: number | null; trk?: number | null; flags?: number; vr?: number | null; ac?: object | null; roll?: number | null }
/** One trace row with readsb's 14 columns; what is not given is null, as readsb writes it. */
function row(dt: number, lat: number, lon: number, alt: number | 'ground' | null, o: RowOpts = {}): unknown[] {
  return [dt, lat, lon, alt, o.gs ?? null, o.trk ?? null, o.flags ?? 0, o.vr ?? null, o.ac ?? null, 'adsb_icao', null, null, null, o.roll ?? null]
}

// Two legs of one A320 (the shape of a real day file, trimmed): leg 1 takes off from LLBG; leg 2 starts 4 h 24 min later on
// the ground, flagged 3 (stale and new leg). Its second row has only the first nine columns and no altitude or speed.
const FILE = {
  icao: HEX, r: 'SX-DND', t: 'A320', desc: 'AIRBUS A-320', timestamp: DAY_S,
  trace: [
    row(15450.11, 32.014728, 34.865836, 'ground', { gs: 3.2, trk: 120, flags: 1, ac: { flight: 'AEE490  ' }, roll: 0 }),
    row(15460.27, 32.02, 34.88, 1200, { gs: 150.04, trk: 121.3, vr: 1500, roll: -2.26 }),
    row(15470.5, 32.03, 34.9, 2400, { gs: 180, trk: 122, flags: 4, vr: 1800, ac: { flight: 'AEE4266 ', squawk: '1000' } }),
    row(31266.9, 37.9, 23.9, 'ground', { flags: 3, gs: 5, trk: 90, ac: { squawk: '2000' } }),
    row(31276.9, 37.91, 23.91, null).slice(0, 9),
    row(31277.4, 37.92, 23.92, 300, { gs: 140, trk: 91, vr: -64, roll: 1.5 }),
  ],
}

/** The leg at atMs, which the test expects to exist. */
function leg(json: unknown, atMs: number): TraceReply {
  const r = traceReply(json, HEX, atMs)
  assert.ok(r !== null, `a leg at ${new Date(atMs).toISOString()}`)
  return r
}

test('traceUrl: the live file within the last 24 h, else the day file of the UTC date', () => {
  const live = 'https://adsb.lol/data/traces/d1/trace_full_8965d1.json'
  assert.equal(traceUrl(BASE, '8965d1', NOW - HOUR, NOW), live)
  assert.equal(traceUrl(BASE, '8965d1', NOW - 24 * HOUR + 1, NOW), live, '1 ms inside the window')
  assert.equal(traceUrl(BASE, '8965d1', NOW - 24 * HOUR, NOW), 'https://adsb.lol/globe_history/2026/10/01/traces/d1/trace_full_8965d1.json')
  assert.equal(traceUrl(BASE, '8965d1', NOW - 30 * 24 * HOUR, NOW), 'https://adsb.lol/globe_history/2026/09/02/traces/d1/trace_full_8965d1.json')
})

test('traceUrl: the day is the UTC day, to the millisecond', () => {
  const last = Date.UTC(2026, 8, 22, 23, 59, 59, 999)
  assert.equal(traceUrl(BASE, '4691c4', last, NOW), 'https://adsb.lol/globe_history/2026/09/22/traces/c4/trace_full_4691c4.json')
  assert.equal(traceUrl(BASE, '4691c4', last + 1, NOW), 'https://adsb.lol/globe_history/2026/09/23/traces/c4/trace_full_4691c4.json')
})

test('traceUrl: a ~ address keeps its ~ in the file name, the folder is its last two digits', () => {
  assert.equal(traceUrl(BASE, '~abc123', NOW - HOUR, NOW), 'https://adsb.lol/data/traces/23/trace_full_~abc123.json')
  assert.equal(traceUrl(BASE, '~abc123', Date.UTC(2026, 8, 22, 12), NOW), 'https://adsb.lol/globe_history/2026/09/22/traces/23/trace_full_~abc123.json')
})

test('traceReply: the leg flying at atMs, the last one starting at or before it', () => {
  assert.equal(leg(FILE, LEG1_MS + 5000).t0Ms, LEG1_MS)
  assert.equal(leg(FILE, LEG2_MS + 1000).t0Ms, LEG2_MS)
  assert.equal(leg(FILE, LEG1_MS).t0Ms, LEG1_MS, 'at its first point')
  assert.equal(leg(FILE, LEG2_MS - 1).t0Ms, LEG1_MS, 'leg 2 has not started')
  assert.equal(leg(FILE, LEG2_MS).t0Ms, LEG2_MS, 'at its first point')
  assert.equal(leg(FILE, LEG2_MS - HOUR).t0Ms, LEG1_MS, 'in the gap: leg 1, parked since 04:17:50')
  assert.equal(traceReply(FILE, HEX, LEG1_MS - 1), null, 'before the first point')
  assert.equal(traceReply(FILE, HEX, 0), null)
  assert.equal(traceReply(FILE, HEX, Number.NaN), null, 'not a time: no leg, not the last one')
})

test('traceReply: the whole leg comes back, the points after atMs too (the client cuts)', () => {
  assert.equal(leg(FILE, LEG1_MS).t.length, 3)
  assert.equal(leg(FILE, LEG2_MS + 1000).t.length, 3)
})

test('traceReply: columns of a leg: t, 5-decimal lat/lon, alt g/number/null, 0.1 speeds, vs whichever kind, roll', () => {
  const r = leg(FILE, LEG1_MS)
  assert.equal(r.hex, HEX)
  assert.deepEqual(r.t, [0, 10.2, 20.4])
  assert.deepEqual(r.lat, [32.01473, 32.02, 32.03])
  assert.deepEqual(r.lon, [34.86584, 34.88, 34.9])
  assert.deepEqual(r.alt, ['g', 1200, 2400])
  assert.deepEqual(r.gs, [3.2, 150, 180])
  assert.deepEqual(r.trk, [120, 121.3, 122])
  assert.deepEqual(r.vs, [null, 1500, 1800], 'the third row says flags 4: its rate is geometric, it passes through')
  assert.deepEqual(r.roll, [0, -2.3, null])
  const r2 = leg(FILE, LEG2_MS)
  assert.deepEqual(r2.alt, ['g', null, 300])
  assert.deepEqual(r2.gs, [5, null, 140])
  assert.deepEqual(r2.trk, [90, null, 91])
  assert.deepEqual(r2.vs, [null, null, -64])
  assert.deepEqual(r2.roll, [null, null, 1.5], 'a row without the trailing columns has no roll')
})

test('traceReply: nM is the geoid N at each point, to 0.1 m', () => {
  // LLBG is +19.6 m (pinned in shared/geoid.test.ts); the next two points are a little north-east of it.
  assert.deepEqual(leg(FILE, LEG1_MS).nM, [19.6, 19.7, 19.8])
  assert.equal(leg(FILE, LEG2_MS).nM.length, 3)
})

test('traceReply: t0Ms is the first point to the millisecond, however the float falls, and t counts from it', () => {
  // A live file's timestamp is its first point (dt 0); real value 1790664601.41 s. Its second leg starts at dt 38410.13,
  // where (timestamp + dt) × 1000 comes out as 1790703011540.0002 in floating point.
  const live = {
    timestamp: 1790664601.41,
    trace: [
      row(0, 25.265511, 55.354449, 'ground'), row(12.61, 25.265517, 55.35429, 'ground'), row(553.53, 25.2644, 55.356318, 'ground'),
      row(38410.13, 25.2, 55.3, 'ground', { flags: 3 }), row(38420.51, 25.21, 55.31, 'ground'),
    ],
  }
  const first = leg(live, 1_790_664_601_410)
  assert.equal(first.t0Ms, 1_790_664_601_410)
  assert.deepEqual(first.t, [0, 12.6, 553.5])
  const second = leg(live, 1_790_703_011_540)
  assert.equal(second.t0Ms, 1_790_703_011_540, 'found at exactly its first point')
  assert.deepEqual(second.t, [0, 10.4])
  assert.equal(leg(FILE, LEG1_MS).t0Ms, 1_790_050_650_110, 'a day file: midnight + 15450.11 s')
})

test('traceReply: reg and typeCode come from the file, null when it has none', () => {
  const r = leg(FILE, LEG1_MS)
  assert.equal(r.reg, 'SX-DND')
  assert.equal(r.typeCode, 'A320')
  const bare = leg({ timestamp: DAY_S, trace: [row(15450.11, 32, 34.8, 1000)] }, LEG1_MS)
  assert.equal(bare.reg, null)
  assert.equal(bare.typeCode, null)
})

test('traceReply: callsign is the newest non-empty flight of the leg, trimmed', () => {
  assert.equal(leg(FILE, LEG1_MS).callsign, 'AEE4266', 'the newer of AEE490 and AEE4266')
  assert.equal(leg(FILE, LEG2_MS).callsign, null, 'leg 2 has no flight: leg 1\'s does not leak in')
})

test('traceReply: a blank flight or the all-zero identification (@@@@@@@@) is no callsign', () => {
  // Real: the last flight of a leg of a day file was '@@@@@@@@' (an all-zero ident), after AEE4266.
  const ids = ['AEE4266 ', '@@@@@@@@', '        ', '']
  const rows = ids.map((flight, i) => row(100 + i * 10, 37.9, 23.9, 5000, { ac: { flight } }))
  assert.equal(leg({ timestamp: DAY_S, trace: rows }, DAY_S * 1000 + 100_000).callsign, 'AEE4266')
  assert.equal(leg({ timestamp: DAY_S, trace: rows.slice(1) }, DAY_S * 1000 + 110_000).callsign, null)
})

test('traceReply: null once the leg ended more than 6 h before atMs, even if a later leg has not started', () => {
  assert.equal(leg(FILE, LEG2_END_MS + 6 * HOUR).t0Ms, LEG2_MS, 'exactly 6 h after its last point')
  assert.equal(traceReply(FILE, HEX, LEG2_END_MS + 6 * HOUR + 1), null)
  const apart = { timestamp: DAY_S, trace: [row(0, 32, 34.8, 'ground'), row(7 * 3600, 32.1, 34.9, 'ground', { flags: 2 })] }
  const t1 = DAY_S * 1000
  assert.equal(leg(apart, t1 + 6 * HOUR).t0Ms, t1, 'leg 1 is a single point; 6 h on it is still the leg')
  assert.equal(traceReply(apart, HEX, t1 + 6 * HOUR + 1), null, 'and a ms later it has landed long since')
  assert.equal(leg(apart, t1 + 7 * HOUR).t0Ms, t1 + 7 * HOUR, 'leg 2 starts')
})

test('traceReply: anything that is not a trace file is null', () => {
  for (const junk of [null, 'x', 42, [], {}, { timestamp: DAY_S }, { timestamp: DAY_S, trace: 'x' }, { timestamp: 'x', trace: [row(1, 32, 34, 0)] }, { timestamp: DAY_S, trace: [] }]) {
    assert.equal(traceReply(junk, HEX, LEG1_MS), null, JSON.stringify(junk))
  }
})

test('traceReply: a row that is not a point is skipped, a position off the globe too (geoidN would throw)', () => {
  const messy = { timestamp: DAY_S, trace: [row(15450.11, 32, 34.8, 1000), 'junk', null, [1, 2], [3, null, 5], row(15455, 95, 34.8, 1000), row(15456, 32, -181, 1000), row(15460.27, 32.1, 34.9, 1100)] }
  assert.deepEqual(leg(messy, LEG1_MS).lat, [32, 32.1])
})

// ---- TraceStore: a fake adsb.lol on a fake clock ----

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/** A fetch that records each call (url and headers) and answers with what `reply` returns or throws. */
function fakeHost(reply: (url: string) => Response | Promise<Response>) {
  const calls: { url: string; headers: Headers }[] = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: new Headers(init?.headers) })
    return reply(url)
  }) as unknown as typeof fetch
  return { calls, fetchFn }
}

function storeOn(fetchFn: typeof fetch, clock: { t: number }, base?: string) {
  return new TraceStore({ base, userAgent: 'test-agent', fetchFn, nowMs: () => clock.t })
}

test('TraceStore: the live file for a time within 24 h, the day file for an older one; its user-agent and gzip', async () => {
  const { calls, fetchFn } = fakeHost(() => json(FILE))
  const store = storeOn(fetchFn, { t: NOW })
  await store.get('4691C4', NOW - HOUR) // upper case is fine
  await store.get(HEX, LEG1_MS)
  assert.deepEqual(calls.map((c) => c.url), [
    'https://adsb.lol/data/traces/c4/trace_full_4691c4.json',
    'https://adsb.lol/globe_history/2026/09/22/traces/c4/trace_full_4691c4.json',
  ])
  for (const c of calls) {
    assert.equal(c.headers.get('user-agent'), 'test-agent')
    assert.equal(c.headers.get('accept-encoding'), 'gzip')
  }
})

test('TraceStore: another host can be given, a trailing slash does not double', async () => {
  const { calls, fetchFn } = fakeHost(() => json(FILE))
  await storeOn(fetchFn, { t: NOW }, 'http://localhost:9/').get(HEX, NOW - HOUR)
  assert.deepEqual(calls.map((c) => c.url), ['http://localhost:9/data/traces/c4/trace_full_4691c4.json'])
})

test('TraceStore: the reply is traceReply of the file at atMs; the two legs of a day file cost one fetch', async () => {
  const { calls, fetchFn } = fakeHost(() => json(FILE))
  const store = storeOn(fetchFn, { t: NOW })
  assert.deepEqual(await store.get(HEX, LEG1_MS + 1000), traceReply(FILE, HEX, LEG1_MS + 1000))
  assert.deepEqual(await store.get(HEX, LEG2_MS + 1000), traceReply(FILE, HEX, LEG2_MS + 1000))
  assert.equal((await store.get(HEX, LEG2_MS + 1000))?.t0Ms, LEG2_MS)
  assert.equal(await store.get(HEX, LEG1_MS - 1), null, 'no leg then: null')
  assert.equal(calls.length, 1)
})

test('TraceStore: a live file is kept 30 s, a day file 1 h', async () => {
  const clock = { t: NOW }
  const { calls, fetchFn } = fakeHost(() => json(FILE))
  const store = storeOn(fetchFn, clock)
  await store.get(HEX, NOW - HOUR)
  clock.t += 29_000
  await store.get(HEX, NOW - HOUR)
  assert.equal(calls.length, 1, 'live, 29 s on')
  clock.t += 2_000
  await store.get(HEX, NOW - HOUR)
  assert.equal(calls.length, 2, 'live, 31 s on')
  await store.get(HEX, LEG1_MS)
  clock.t += 59 * 60_000
  await store.get(HEX, LEG1_MS)
  assert.equal(calls.length, 3, 'day file, 59 min on')
  clock.t += 2 * 60_000
  await store.get(HEX, LEG1_MS)
  assert.equal(calls.length, 4, 'day file, 61 min on')
})

test('TraceStore: a 404 is null, and remembered as long as a file would be', async () => {
  const clock = { t: NOW }
  let found = false
  const { calls, fetchFn } = fakeHost(() => (found ? json(FILE) : new Response('404 Not Found', { status: 404 })))
  const store = storeOn(fetchFn, clock)
  assert.equal(await store.get(HEX, LEG1_MS), null)
  clock.t += 59 * 60_000
  assert.equal(await store.get(HEX, LEG1_MS), null)
  assert.equal(calls.length, 1, 'a day file that is not there: asked once an hour')
  found = true
  clock.t += 2 * 60_000
  assert.equal((await store.get(HEX, LEG1_MS))?.t0Ms, LEG1_MS)
  assert.equal(calls.length, 2, 'after the hour it asks again')
  found = false
  clock.t += 3_600_000
  const hourAgo = clock.t - HOUR // a live file
  assert.equal(await store.get('738abc', hourAgo), null)
  clock.t += 29_000
  await store.get('738abc', hourAgo)
  assert.equal(calls.length, 3, 'a live file that is not there: asked once in 30 s')
  clock.t += 2_000
  await store.get('738abc', hourAgo)
  assert.equal(calls.length, 4)
})

test('TraceStore: a network error, a bad status (even with a JSON body) or a body that is not JSON is null and not remembered', async () => {
  let mode: 'down' | 'busy' | 'junk' | 'ok' = 'down'
  const { calls, fetchFn } = fakeHost(() => {
    if (mode === 'down') throw new Error('ECONNRESET')
    if (mode === 'busy') return json({ error: 'Too Many Requests' }, 429)
    if (mode === 'junk') return new Response('<html>not a trace</html>', { status: 200 })
    return json(FILE)
  })
  const store = storeOn(fetchFn, { t: NOW })
  assert.equal(await store.get(HEX, LEG1_MS), null)
  mode = 'busy'
  assert.equal(await store.get(HEX, LEG1_MS), null)
  mode = 'junk'
  assert.equal(await store.get(HEX, LEG1_MS), null)
  mode = 'ok'
  assert.equal((await store.get(HEX, LEG1_MS))?.t0Ms, LEG1_MS)
  assert.equal(calls.length, 4, 'each failure was asked again at once')
  await store.get(HEX, LEG1_MS)
  assert.equal(calls.length, 4, 'the good answer is kept')
})

test('TraceStore: a body that is still gzip (no Content-Encoding to undo) is unzipped', async () => {
  const { fetchFn } = fakeHost(() => new Response(gzipSync(JSON.stringify(FILE)), { status: 200 }))
  assert.equal((await storeOn(fetchFn, { t: NOW }).get(HEX, LEG1_MS))?.t0Ms, LEG1_MS)
})

test('TraceStore: gets for one file at the same moment share one fetch', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const { calls, fetchFn } = fakeHost(async () => {
    await gate
    return json(FILE)
  })
  const store = storeOn(fetchFn, { t: NOW })
  const both = Promise.all([store.get(HEX, LEG1_MS), store.get(HEX, LEG2_MS)])
  release()
  const [a, b] = await both
  assert.equal(calls.length, 1)
  assert.equal(a?.t0Ms, LEG1_MS)
  assert.equal(b?.t0Ms, LEG2_MS)
})

test('TraceStore: keeps at most 50 files, the oldest goes first', async () => {
  const { calls, fetchFn } = fakeHost(() => json(FILE))
  const store = storeOn(fetchFn, { t: NOW })
  const hexes = Array.from({ length: 51 }, (_, i) => (0x738000 + i).toString(16))
  for (const hex of hexes.slice(0, 50)) await store.get(hex, LEG1_MS)
  await store.get(hexes[0], LEG1_MS)
  assert.equal(calls.length, 50, '50 files fit')
  await store.get(hexes[50], LEG1_MS)
  await store.get(hexes[50], LEG1_MS)
  assert.equal(calls.length, 51, 'the newest is kept')
  await store.get(hexes[0], LEG1_MS)
  assert.equal(calls.length, 52, 'the 51st pushed the oldest out')
})

test('TraceStore: a file fetched again after it expired counts as the newest when the cap is reached', async () => {
  const clock = { t: NOW }
  const { calls, fetchFn } = fakeHost(() => json(FILE))
  const store = storeOn(fetchFn, clock)
  const hexes = Array.from({ length: 51 }, (_, i) => (0x738000 + i).toString(16))
  for (const hex of hexes.slice(0, 50)) await store.get(hex, LEG1_MS)
  clock.t += 2 * HOUR // all 50 have expired
  await store.get(hexes[0], LEG1_MS) // fetched again: now the newest
  await store.get(hexes[50], LEG1_MS) // the 51st: the oldest of the rest, hexes[1], goes
  assert.equal(calls.length, 52)
  await store.get(hexes[0], LEG1_MS)
  assert.equal(calls.length, 52, 'the refreshed one stayed')
  await store.get(hexes[1], LEG1_MS)
  assert.equal(calls.length, 53, 'the oldest left')
})

test('TraceStore: a hex that is not 6 hex digits (optionally after ~), or a time that is not a number, is null with no request', async () => {
  const { calls, fetchFn } = fakeHost(() => json(FILE))
  const store = storeOn(fetchFn, { t: NOW })
  for (const hex of ['', 'abc', '4691c45', 'g691c4', '4691c4 ', '4691c4/../x', '../../etc/passwd', '4691c4.json', '~~4691c4']) {
    assert.equal(await store.get(hex, LEG1_MS), null, JSON.stringify(hex))
  }
  assert.equal(await store.get(HEX, Number.NaN), null)
  assert.equal(await store.get(HEX, Number.POSITIVE_INFINITY), null)
  assert.equal(calls.length, 0)
  await store.get('~ABC123', LEG1_MS)
  assert.deepEqual(calls.map((c) => c.url), ['https://adsb.lol/globe_history/2026/09/22/traces/23/trace_full_~abc123.json'])
})

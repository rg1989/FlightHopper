// server/trace.test.ts
// traceUrl, traceReply, traceDay and TraceStore on small synthetic trace files and a fake fetch on a fake clock. Nothing here
// touches the network. The file layout is adsb.lol's readsb "trace json", checked on a real live file and a real day
// file (2026-10-02): { icao, r, t, timestamp, trace: [[dtS, lat, lon, alt | "ground" | null, gs, track, flags, vrate,
// acObj | null, source, geomAlt, geomRate, ias, roll], …] }; `flight` in an acObj is padded to 8 characters.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import type { TraceDay, TraceReply } from '../shared/api.ts'
import { TraceStore, traceDay, traceReply, traceUrl } from './trace.ts'

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

test('traceUrl: the live file within the last 25 h (it keeps 24 h + 60 min), else the day file of the UTC date', () => {
  const live = 'https://adsb.lol/data/traces/d1/trace_full_8965d1.json'
  assert.equal(traceUrl(BASE, '8965d1', NOW - HOUR, NOW), live)
  assert.equal(traceUrl(BASE, '8965d1', NOW - 24 * HOUR, NOW), live, 'a day ago: still in the live file')
  assert.equal(traceUrl(BASE, '8965d1', NOW - 25 * HOUR + 1, NOW), live, '1 ms inside the window')
  assert.equal(traceUrl(BASE, '8965d1', NOW - 25 * HOUR, NOW), 'https://adsb.lol/globe_history/2026/10/01/traces/d1/trace_full_8965d1.json')
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

test('traceReply: only flag 2 starts a leg; stale (1), geometric altitude (8) and both (9) in the middle of one do not', () => {
  const flagged = {
    timestamp: DAY_S,
    trace: [
      row(100, 32, 34.8, 1000),
      row(110, 32.01, 34.81, 1100, { flags: 1 }),
      row(120, 32.02, 34.82, 1200, { flags: 9 }),
      row(130, 32.03, 34.83, 1300, { flags: 8 }),
      row(140, 32.04, 34.84, 1400, { flags: 11 }), // new leg (2) with stale (1) and geometric altitude (8) set too
    ],
  }
  assert.deepEqual(leg(flagged, DAY_S * 1000 + 100_000).lat, [32, 32.01, 32.02, 32.03], 'leg 1 keeps all four points')
  assert.deepEqual(leg(flagged, DAY_S * 1000 + 140_000).lat, [32.04], 'flag 2 among other bits still starts leg 2')
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

test('traceReply: a geometric altitude (flags & 8) is turned into the baro-like MSL feet the client expects: ft - nM / 0.3048', () => {
  // The client shows alt × 0.3048 + nM as the height above the ellipsoid, which is right for a baro altitude (MSL) only.
  const rows = [
    row(100, 32.014728, 34.865836, 1000), // baro: as it is
    row(110, 32.02, 34.88, 5000, { flags: 8 }), // geometric: nM 19.7 here
    row(120, 32.03, 34.9, 5000, { flags: 9 }), // geometric and stale: nM 19.8
    row(130, 32.03, 34.9, 'ground', { flags: 8 }), // on the ground it stays 'g'
    row(140, 32.03, 34.9, null, { flags: 8 }), // no altitude stays null
    row(150, 32.03, 34.9, 3000, { flags: 4 }), // flag 4 is the vertical rate: the altitude is baro
  ]
  const r = leg({ timestamp: DAY_S, trace: rows }, DAY_S * 1000 + 100_000)
  assert.deepEqual(r.nM, [19.6, 19.7, 19.8, 19.8, 19.8, 19.8])
  assert.deepEqual(r.alt, [1000, 4935, 4935, 'g', null, 3000])
  for (const i of [1, 2]) assert.ok(Math.abs((r.alt[i] as number) * 0.3048 + r.nM[i] - 5000 * 0.3048) < 0.2, `the client's alt × ft + N gives the geometric height again at ${i}`)
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

test('traceReply: calls are the callsigns of the leg from the point each starts, s after t0Ms; the callsign is the last of them', () => {
  assert.deepEqual(leg(FILE, LEG1_MS).calls, [[0, 'AEE490'], [20.4, 'AEE4266']])
  assert.equal(leg(FILE, LEG1_MS).callsign, 'AEE4266')
  assert.deepEqual(leg(FILE, LEG2_MS).calls, [], 'leg 2 sent none')
})

test('traceReply: calls skip blanks and readsb\'s @@@@@@@@, and a repeat of the one before; a callsign that comes back is a change', () => {
  const flights = ['ISR884  ', 'ISR884  ', '@@@@@@@@', '        ', 'ISR884', 'ISR345  ', 'ISR345  ', '', 'ISR884  ', null]
  const rows = flights.map((flight, i) => row(100 + i * 10, 32, 34.8, 30000, { ac: flight === null ? null : { flight } }))
  const r = leg({ timestamp: DAY_S, trace: rows }, DAY_S * 1000 + 100_000)
  assert.deepEqual(r.calls, [[0, 'ISR884'], [50, 'ISR345'], [80, 'ISR884']])
  assert.equal(r.callsign, 'ISR884')
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
  const calls: { url: string; headers: Headers; signal: AbortSignal | null | undefined }[] = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: new Headers(init?.headers), signal: init?.signal })
    return reply(url)
  }) as unknown as typeof fetch
  return { calls, fetchFn }
}

function storeOn(fetchFn: typeof fetch, clock: { t: number }, base?: string) {
  return new TraceStore({ base, userAgent: 'test-agent', fetchFn, nowMs: () => clock.t })
}

test('TraceStore: the live file for a time within 25 h, the day file for an older one; its user-agent, gzip and a time limit', async () => {
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
    assert.ok(c.signal instanceof AbortSignal && !c.signal.aborted, 'a stuck download ends by itself')
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

test('TraceStore: a network error, a bad status (even with a JSON body), a body that is not JSON or a gzip that is cut is null and not remembered', async () => {
  let mode: 'down' | 'busy' | 'junk' | 'cut' | 'ok' = 'down'
  const { calls, fetchFn } = fakeHost(() => {
    if (mode === 'down') throw new Error('ECONNRESET')
    if (mode === 'busy') return json({ error: 'Too Many Requests' }, 429)
    if (mode === 'junk') return new Response('<html>not a trace</html>', { status: 200 })
    if (mode === 'cut') return new Response(gzipSync(JSON.stringify(FILE)).subarray(0, 40), { status: 200 }) // gzip, but cut short
    return json(FILE)
  })
  const store = storeOn(fetchFn, { t: NOW })
  assert.equal(await store.get(HEX, LEG1_MS), null)
  mode = 'busy'
  assert.equal(await store.get(HEX, LEG1_MS), null)
  mode = 'junk'
  assert.equal(await store.get(HEX, LEG1_MS), null)
  mode = 'cut'
  assert.equal(await store.get(HEX, LEG1_MS), null)
  mode = 'ok'
  assert.equal((await store.get(HEX, LEG1_MS))?.t0Ms, LEG1_MS)
  assert.equal(calls.length, 5, 'each failure was asked again at once')
  await store.get(HEX, LEG1_MS)
  assert.equal(calls.length, 5, 'the good answer is kept')
})

test('TraceStore: the body of an answer that is not 200 is not read, it is cancelled', async () => {
  for (const status of [404, 429, 500, 201]) {
    const seen = { cancelled: false }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{}'))
        // It ends by itself, so a store that reads it fails the check below instead of waiting for ever.
        setTimeout(() => { try { controller.close() } catch { /* cancelled first, as it should be */ } }, 20)
      },
      cancel() { seen.cancelled = true },
    })
    const { fetchFn } = fakeHost(() => new Response(body, { status }))
    assert.equal(await storeOn(fetchFn, { t: NOW }).get(HEX, LEG1_MS), null, String(status))
    assert.equal(seen.cancelled, true, `status ${status}`)
  }
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

test('TraceStore: expired files are dropped when a new one is kept, so a valid old file is not pushed out in their place', async () => {
  const clock = { t: NOW }
  const { calls, fetchFn } = fakeHost(() => json(FILE))
  const store = storeOn(fetchFn, clock)
  await store.get(HEX, LEG1_MS) // a day file: kept an hour, the oldest entry
  const hexes = Array.from({ length: 50 }, (_, i) => (0x738000 + i).toString(16))
  for (const hex of hexes.slice(0, 49)) await store.get(hex, NOW - HOUR) // 49 live files: kept 30 s. 50 entries.
  clock.t += 31_000 // the live ones have expired, the day file has not
  await store.get(hexes[49], NOW) // the 51st: the expired go, not the day file
  assert.equal(calls.length, 51)
  await store.get(HEX, LEG1_MS)
  assert.equal(calls.length, 51, 'the day file is still there')
})

test('TraceStore: close aborts the downloads under way (null), and nothing is asked after it', async () => {
  const signals: AbortSignal[] = []
  const fetchFn = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init!.signal!
      signals.push(signal)
      signal.addEventListener('abort', () => reject(signal.reason))
    })) as unknown as typeof fetch
  const store = storeOn(fetchFn, { t: NOW })
  const pending = store.get(HEX, LEG1_MS)
  assert.equal(signals.length, 1)
  assert.equal(signals[0].aborted, false)
  store.close()
  assert.equal(signals[0].aborted, true)
  assert.equal(await pending, null)
  assert.equal(await store.get('738abc', LEG1_MS), null)
  assert.equal(signals.length, 1, 'closed: nothing new is asked')
})

test('TraceStore: a hex that is not 6 hex digits (optionally after ~) is null with no request', async () => {
  const { calls, fetchFn } = fakeHost(() => json(FILE))
  const store = storeOn(fetchFn, { t: NOW })
  for (const hex of ['', 'abc', '4691c45', 'g691c4', '4691c4 ', '4691c4/../x', '../../etc/passwd', '4691c4.json', '~~4691c4']) {
    assert.equal(await store.get(hex, LEG1_MS), null, JSON.stringify(hex))
  }
  assert.equal(calls.length, 0)
  await store.get('~ABC123', LEG1_MS)
  assert.deepEqual(calls.map((c) => c.url), ['https://adsb.lol/globe_history/2026/09/22/traces/23/trace_full_~abc123.json'])
})

test('TraceStore: a time that is no date from the year 2000 to 9999 is null with no request', async () => {
  const { calls, fetchFn } = fakeHost(() => json(FILE))
  const store = storeOn(fetchFn, { t: NOW })
  const outside = [
    Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
    -1e16, // beyond what a Date holds: toISOString throws
    Date.UTC(-1, 0, 1), // year -1: "-000001" in an ISO string, a malformed URL
    Date.UTC(1999, 11, 31, 23, 59, 59, 999),
    Date.UTC(10000, 0, 1), // "+010000"
  ]
  for (const at of outside) assert.equal(await store.get(HEX, at), null, String(at))
  assert.equal(calls.length, 0)
  await store.get(HEX, Date.UTC(2000, 0, 1))
  await store.get(HEX, Date.UTC(9999, 11, 31, 23, 59, 59, 999))
  assert.deepEqual(calls.map((c) => c.url), [
    'https://adsb.lol/globe_history/2000/01/01/traces/c4/trace_full_4691c4.json',
    'https://adsb.lol/data/traces/c4/trace_full_4691c4.json', // the far future is "within 25 h" of now
  ])
})

// ---- a span of up to 48 h: the day files and the live file merged (TraceStore.day, traceDay) ----

const at = (iso: string): number => Date.parse(iso)
const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z')
const CUT = NOW - 25 * HOUR // 2026-10-01T04:00:00Z: before it the day files, from it the live file
const LIVE_URL = 'https://adsb.lol/data/traces/c4/trace_full_4691c4.json'
const dayUrlOf = (ymd: string): string => `https://adsb.lol/globe_history/${ymd}/traces/c4/trace_full_4691c4.json`

interface Pt { at: string; alt: number | 'ground' | null; flags?: number; flight?: string }
/** A trace file of HEX stamped stampMs (a day file: its UTC midnight; a live file: its first point), one row per Pt at its time. */
function traceAt(stampMs: number, pts: Pt[], names: { r?: string; t?: string } = { r: 'SX-DND', t: 'A320' }) {
  return {
    icao: HEX, ...names, timestamp: stampMs / 1000,
    trace: pts.map((p, i) => row((at(p.at) - stampMs) / 1000, 32 + i * 0.01, 34.8, p.alt, { flags: p.flags, ac: p.flight === undefined ? null : { flight: p.flight } })),
  }
}
const dayOf = (ymd: string, pts: Pt[], names?: { r?: string; t?: string }) => traceAt(Date.parse(`${ymd.replaceAll('/', '-')}T00:00:00Z`), pts, names)
const liveOf = (pts: Pt[], names?: { r?: string; t?: string }) => traceAt(at(pts[0].at), pts, names)
/** Points every `stepS` from `from` to `to` (inclusive) at one altitude. */
function every(from: string, to: string, stepS: number, alt: number | 'ground', flight?: string): Pt[] {
  const out: Pt[] = []
  for (let t = at(from); t <= at(to); t += stepS * 1000) out.push({ at: iso(t), alt, flight })
  return out
}

/** A store on a host serving these files by URL (a number: that status; an Error: thrown); anything else 404. */
function spanHost(files: Record<string, unknown>, clock = { t: NOW }) {
  const { calls, fetchFn } = fakeHost((url) => {
    const f = files[url]
    if (f instanceof Error) throw f
    if (typeof f === 'number') return new Response('trouble', { status: f })
    return f === undefined ? new Response('not found', { status: 404 }) : json(f)
  })
  return { calls, store: storeOn(fetchFn, clock), clock }
}
async function daySpan(store: TraceStore, fromMs: number, toMs: number): Promise<TraceDay> {
  const r = await store.day(HEX, fromMs, toMs)
  assert.ok(r !== null && r !== 'unavailable', `a span, not ${String(r)}`)
  return r
}
/** Each leg as [its first point, its last point]. */
const spans = (d: TraceDay): [string, string][] => d.legs.map((l) => [iso(l.t0Ms), iso(l.t0Ms + l.t[l.t.length - 1] * 1000)])

test('TraceStore.day: the live file for the part at or after now − 25 h, the day file of every UTC date the part before it overlaps', async () => {
  const urls = async (from: string, to: string): Promise<string[]> => {
    const { calls, store } = spanHost({})
    await store.day(HEX, at(from), at(to))
    return calls.map((c) => c.url).sort()
  }
  assert.equal(iso(CUT), '2026-10-01T04:00:00Z')
  assert.deepEqual(await urls('2026-10-01T04:00:00Z', '2026-10-02T05:00:00Z'), [LIVE_URL], 'from the cut on: the live file only')
  assert.deepEqual(await urls('2026-10-01T03:59:59.999Z', '2026-10-02T05:00:00Z'), [LIVE_URL, dayUrlOf('2026/10/01')].sort(), 'a ms before it: that day too')
  assert.deepEqual(await urls('2026-10-01T00:00:00Z', '2026-10-01T03:59:59.999Z'), [dayUrlOf('2026/10/01')], 'ending before the cut: no live file')
  assert.deepEqual(await urls('2026-10-01T00:00:00Z', '2026-10-01T04:00:00Z'), [LIVE_URL, dayUrlOf('2026/10/01')].sort(), 'ending at the cut: the live file too')
  assert.deepEqual(await urls('2026-09-30T12:00:00Z', '2026-10-01T12:00:00Z'), [LIVE_URL, dayUrlOf('2026/09/30'), dayUrlOf('2026/10/01')].sort())
  assert.deepEqual(await urls('2026-09-29T00:00:00Z', '2026-09-30T23:59:59.999Z'), [dayUrlOf('2026/09/29'), dayUrlOf('2026/09/30')], '48 h of two whole days')
  assert.deepEqual(await urls('2026-09-28T23:59:59.999Z', '2026-09-30T23:59:59.999Z'), [dayUrlOf('2026/09/28'), dayUrlOf('2026/09/29'), dayUrlOf('2026/09/30')], 'three dates at most')
  assert.deepEqual(await urls('2026-09-29T23:59:59.999Z', '2026-09-30T00:00:00Z'), [dayUrlOf('2026/09/29'), dayUrlOf('2026/09/30')], 'a ms either side of midnight')
  assert.deepEqual(await urls('2026-09-30T00:00:00Z', '2026-09-30T00:00:00Z'), [dayUrlOf('2026/09/30')], 'midnight belongs to its own day')
})

test('TraceStore.day: rows taken by time, day files before the cut, the live file at and after it: nothing twice, one leg across the cut', async () => {
  // The same flight in both files around the cut: the day file has it to 04:10, the live file from 03:55.
  const { store } = spanHost({
    [dayUrlOf('2026/10/01')]: dayOf('2026/10/01', every('2026-10-01T03:50:00Z', '2026-10-01T04:10:00Z', 20, 35000, 'AEE4266 ')),
    [LIVE_URL]: liveOf(every('2026-10-01T03:55:00Z', '2026-10-01T04:20:00Z', 20, 35000, 'AEE4266 ')),
  })
  const d = await daySpan(store, at('2026-10-01T03:30:00Z'), NOW)
  assert.deepEqual(spans(d), [['2026-10-01T03:50:00Z', '2026-10-01T04:20:00Z']], 'one leg: the live file\'s first kept row is no file\'s first')
  const times = d.legs[0].t.map((t) => d.legs[0].t0Ms + t * 1000)
  assert.equal(times.length, 91, '30 rows from the day file (03:50 to 03:59:40), 61 from the live file (04:00 to 04:20)')
  assert.ok(times.every((t, i) => i === 0 || t - times[i - 1] === 20_000), 'every 20 s, in order, none twice')
  assert.deepEqual(d.legs[0].calls, [[0, 'AEE4266']])
  assert.deepEqual([d.hex, d.reg, d.typeCode, d.fromMs, d.toMs], [HEX, 'SX-DND', 'A320', at('2026-10-01T03:30:00Z'), NOW])
})

test('TraceStore.day: from at or after the cut, the live file whole: a leg begun before the cut starts where it did', async () => {
  // A flight from 03:50 to 04:20: the live file still holds its first rows from before the cut (04:00).
  const { calls, store } = spanHost({ [LIVE_URL]: liveOf(every('2026-10-01T03:50:00Z', '2026-10-01T04:20:00Z', 20, 35000)) })
  const d = await daySpan(store, at('2026-10-01T04:10:00Z'), NOW)
  assert.deepEqual(calls.map((c) => c.url), [LIVE_URL], 'no day file')
  assert.deepEqual(spans(d), [['2026-10-01T03:50:00Z', '2026-10-01T04:20:00Z']], 'not cut at 04:00')
  assert.equal(d.legs[0].t.length, 91)
})

test('TraceStore.day: a span ending before the cut, the last day file to its day’s end: a leg running past the cut ends where it did', async () => {
  const { calls, store } = spanHost({ [dayUrlOf('2026/10/01')]: dayOf('2026/10/01', every('2026-10-01T03:20:00Z', '2026-10-01T04:30:00Z', 60, 35000)) })
  const d = await daySpan(store, at('2026-10-01T00:00:00Z'), at('2026-10-01T03:30:00Z'))
  assert.deepEqual(calls.map((c) => c.url), [dayUrlOf('2026/10/01')], 'no live file')
  assert.deepEqual(spans(d), [['2026-10-01T03:20:00Z', '2026-10-01T04:30:00Z']], 'not cut at 04:00')
})

test('traceDay: a leg crossing midnight stays one: rows on through it, or a coverage hole at cruise', () => {
  const files = (before: Pt[], after: Pt[]) => [
    { json: dayOf('2026/09/29', before), fromMs: at('2026-09-29T00:00:00Z'), toMs: at('2026-09-30T00:00:00Z') },
    { json: dayOf('2026/09/30', after), fromMs: at('2026-09-30T00:00:00Z'), toMs: at('2026-10-01T00:00:00Z') },
  ]
  const span = [at('2026-09-29T12:00:00Z'), at('2026-09-30T12:00:00Z')] as const
  const through = traceDay(HEX, files(every('2026-09-29T23:50:00Z', '2026-09-29T23:59:50Z', 10, 37000), every('2026-09-30T00:00:00Z', '2026-09-30T00:10:00Z', 10, 37000)), ...span)
  assert.deepEqual(spans(through), [['2026-09-29T23:50:00Z', '2026-09-30T00:10:00Z']])
  const hole = traceDay(HEX, files([{ at: '2026-09-29T23:20:00Z', alt: 37000 }], [{ at: '2026-09-30T01:20:00Z', alt: 36000 }, { at: '2026-09-30T01:20:20Z', alt: 36000 }]), ...span)
  assert.deepEqual(spans(hole), [['2026-09-29T23:20:00Z', '2026-09-30T01:20:20Z']], '2 h unheard at cruise: one flight')
  const climbing = traceDay(HEX, files([{ at: '2026-09-29T23:20:00Z', alt: 9000 }], [{ at: '2026-09-30T01:20:00Z', alt: 36000 }]), ...span)
  assert.equal(climbing.legs.length, 1, 'low at one end, cruising at the other: still one flight')
  const short = traceDay(HEX, files([{ at: '2026-09-29T23:50:00Z', alt: 'ground' }], [{ at: '2026-09-30T00:14:59Z', alt: 'ground' }]), ...span)
  assert.equal(short.legs.length, 1, 'on the ground, but 25 min or less unheard: one leg')
})

test('traceDay: a file\'s first point starts a leg after a gap over 25 min on the ground at either end or low at both (readsb could not mark it)', () => {
  const two = (before: Pt[], after: Pt[]) =>
    traceDay(HEX, [
      { json: dayOf('2026/09/29', before), fromMs: at('2026-09-29T00:00:00Z'), toMs: at('2026-09-30T00:00:00Z') },
      { json: dayOf('2026/09/30', after), fromMs: at('2026-09-30T00:00:00Z'), toMs: at('2026-10-01T00:00:00Z') },
    ], at('2026-09-29T12:00:00Z'), at('2026-09-30T12:00:00Z'))
  // Parked overnight with the transponder off: landed 19:00, first heard again at the gate at 05:30.
  const parked = two([...every('2026-09-29T18:00:00Z', '2026-09-29T18:59:00Z', 60, 20000), ...every('2026-09-29T19:00:00Z', '2026-09-29T19:10:00Z', 60, 'ground')],
    [...every('2026-09-30T05:30:00Z', '2026-09-30T05:40:00Z', 60, 'ground'), ...every('2026-09-30T05:41:00Z', '2026-09-30T06:00:00Z', 60, 8000)])
  assert.deepEqual(spans(parked), [['2026-09-29T18:00:00Z', '2026-09-29T19:10:00Z'], ['2026-09-30T05:30:00Z', '2026-09-30T06:00:00Z']])
  const offGround = two([{ at: '2026-09-29T23:00:00Z', alt: 'ground' }], [{ at: '2026-09-30T00:30:00Z', alt: 30000 }])
  assert.equal(offGround.legs.length, 2, 'on the ground at one end')
  const uncovered = two([{ at: '2026-09-29T21:00:00Z', alt: 3000 }], [{ at: '2026-09-30T07:00:00Z', alt: 2000 }])
  assert.equal(uncovered.legs.length, 2, 'landed and took off out of coverage: low at both ends')
  const noAlt = two([{ at: '2026-09-29T21:00:00Z', alt: null }], [{ at: '2026-09-30T07:00:00Z', alt: 9999 }])
  assert.equal(noAlt.legs.length, 2, 'no altitude counts as low')
  const marked = two([{ at: '2026-09-29T23:59:00Z', alt: 37000 }], [{ at: '2026-09-30T00:01:00Z', alt: 37000, flags: 2 }])
  assert.equal(marked.legs.length, 2, 'a first point readsb did mark is a new leg, gap or not')
})

test('TraceStore.day: at the cut too, the live file\'s first point after a parked night starts a leg', async () => {
  const { store } = spanHost({
    [dayUrlOf('2026/10/01')]: dayOf('2026/10/01', [...every('2026-10-01T00:30:00Z', '2026-10-01T01:00:00Z', 60, 5000), { at: '2026-10-01T01:05:00Z', alt: 'ground' }]),
    [LIVE_URL]: liveOf([{ at: '2026-10-01T06:00:00Z', alt: 'ground' }, ...every('2026-10-01T06:10:00Z', '2026-10-01T06:30:00Z', 60, 4000)]),
  })
  const d = await daySpan(store, at('2026-10-01T00:00:00Z'), NOW)
  assert.deepEqual(spans(d), [['2026-10-01T00:30:00Z', '2026-10-01T01:05:00Z'], ['2026-10-01T06:00:00Z', '2026-10-01T06:30:00Z']])
})

test('traceDay: every leg overlapping the span, each whole (its points outside the span too), in time order; none in it is no legs', () => {
  const marks = (from: string, to: string, alt: number): Pt[] => every(from, to, 300, alt).map((p, i) => (i === 0 ? { ...p, flags: 2 } : p))
  const file = dayOf('2026/09/30', [
    ...marks('2026-09-30T06:00:00Z', '2026-09-30T07:00:00Z', 30000), // before the span
    ...marks('2026-09-30T09:30:00Z', '2026-09-30T10:30:00Z', 30000), // across its start
    ...marks('2026-09-30T11:00:00Z', '2026-09-30T12:00:00Z', 30000), // inside
    ...marks('2026-09-30T13:30:00Z', '2026-09-30T15:00:00Z', 30000), // across its end
    ...marks('2026-09-30T16:00:00Z', '2026-09-30T17:00:00Z', 30000), // after it
  ])
  const files = [{ json: file, fromMs: at('2026-09-30T00:00:00Z'), toMs: at('2026-10-01T00:00:00Z') }]
  const d = traceDay(HEX, files, at('2026-09-30T10:00:00Z'), at('2026-09-30T14:00:00Z'))
  assert.deepEqual(spans(d), [
    ['2026-09-30T09:30:00Z', '2026-09-30T10:30:00Z'],
    ['2026-09-30T11:00:00Z', '2026-09-30T12:00:00Z'],
    ['2026-09-30T13:30:00Z', '2026-09-30T15:00:00Z'],
  ])
  assert.deepEqual(spans(traceDay(HEX, files, at('2026-09-30T07:00:00Z'), at('2026-09-30T07:00:00Z'))), [['2026-09-30T06:00:00Z', '2026-09-30T07:00:00Z']], 'a span of one instant on a leg\'s last point')
  assert.deepEqual(traceDay(HEX, files, at('2026-09-30T07:00:00.001Z'), at('2026-09-30T09:29:59.999Z')).legs, [], 'between two legs: none')
  assert.deepEqual(traceDay(HEX, [{ json: null, fromMs: 0, toMs: Infinity }], 0, NOW), { hex: HEX, reg: null, typeCode: null, fromMs: 0, toMs: NOW, legs: [] }, 'no file: no legs')
})

test('traceDay: each leg is the TraceReply the at mode builds for it', () => {
  const files = [{ json: FILE, fromMs: Date.UTC(2026, 8, 22), toMs: Date.UTC(2026, 8, 23) }]
  const d = traceDay(HEX, files, Date.UTC(2026, 8, 22), Date.UTC(2026, 8, 22, 23, 59))
  assert.deepEqual(d.legs, [traceReply(FILE, HEX, LEG1_MS), traceReply(FILE, HEX, LEG2_MS)])
  assert.ok(d.legs.every((l) => !('origin' in l)), 'no origin in this mode')
})

test('traceDay: reg and typeCode from the newest file that names them; the calls of a leg across files in time order', () => {
  const day = (names?: { r?: string; t?: string }) => ({ json: dayOf('2026/09/30', [{ at: '2026-09-30T23:59:00Z', alt: 30000, flight: 'ELY001  ' }], names), fromMs: at('2026-09-30T00:00:00Z'), toMs: at('2026-10-01T00:00:00Z') })
  const next = (names?: { r?: string; t?: string }) => ({ json: dayOf('2026/10/01', [{ at: '2026-10-01T00:00:20Z', alt: 30000, flight: 'ELY002  ' }, { at: '2026-10-01T00:00:40Z', alt: 30000, flight: 'ELY002' }], names), fromMs: at('2026-10-01T00:00:00Z'), toMs: at('2026-10-02T00:00:00Z') })
  const span = [at('2026-09-30T12:00:00Z'), at('2026-10-01T12:00:00Z')] as const
  const d = traceDay(HEX, [day({ r: '4X-EKA', t: 'B738' }), next({})], ...span)
  assert.deepEqual([d.reg, d.typeCode], ['4X-EKA', 'B738'], 'the newer names none: the older\'s')
  assert.deepEqual([d.legs[0].reg, d.legs[0].typeCode], ['4X-EKA', 'B738'])
  assert.deepEqual(d.legs[0].calls, [[0, 'ELY001'], [80, 'ELY002']])
  assert.equal(d.legs[0].callsign, 'ELY002')
  assert.deepEqual([traceDay(HEX, [day({ r: '4X-EKA', t: 'B738' }), next({ r: '4X-EKB', t: 'B38M' })], ...span).reg], ['4X-EKB'])
})

test('TraceStore.day: a file that is not there adds nothing; one that cannot be had makes the span unavailable', async () => {
  const live = liveOf(every('2026-10-01T10:00:00Z', '2026-10-01T10:10:00Z', 60, 30000))
  const notThere = spanHost({ [LIVE_URL]: live })
  assert.deepEqual(spans(await daySpan(notThere.store, at('2026-09-30T12:00:00Z'), NOW)), [['2026-10-01T10:00:00Z', '2026-10-01T10:10:00Z']], 'the day files 404: the live file\'s legs')
  assert.deepEqual((await daySpan(spanHost({}).store, at('2026-09-30T12:00:00Z'), NOW)).legs, [], 'nothing anywhere: no legs, not an error')
  for (const trouble of [500, 503, 429, 403, new Error('ECONNRESET')]) {
    const { store } = spanHost({ [LIVE_URL]: live, [dayUrlOf('2026/09/30')]: trouble })
    assert.equal(await store.day(HEX, at('2026-09-30T12:00:00Z'), NOW), 'unavailable', String(trouble))
  }
  const junk = fakeHost((url) => (url === LIVE_URL ? new Response('<html>busy</html>') : new Response('not found', { status: 404 })))
  assert.equal(await storeOn(junk.fetchFn, { t: NOW }).day(HEX, at('2026-10-01T12:00:00Z'), NOW), 'unavailable', 'a body that is not JSON')
})

test('TraceStore.day: through the same cache as the at mode: a day file kept 1 h, the live file 30 s; asking again costs nothing', async () => {
  const { calls, store, clock } = spanHost({
    [LIVE_URL]: liveOf(every('2026-10-01T10:00:00Z', '2026-10-01T10:10:00Z', 60, 30000)),
    [dayUrlOf('2026/09/30')]: dayOf('2026/09/30', every('2026-09-30T10:00:00Z', '2026-09-30T10:10:00Z', 60, 30000)),
  })
  await store.get(HEX, NOW - HOUR) // the at mode reads the live file
  await daySpan(store, at('2026-09-30T00:00:00Z'), NOW)
  await daySpan(store, at('2026-09-30T00:00:00Z'), NOW)
  assert.deepEqual(calls.map((c) => c.url).sort(), [LIVE_URL, dayUrlOf('2026/09/30'), dayUrlOf('2026/10/01')].sort(), 'each file once')
  clock.t += 31_000
  await daySpan(store, at('2026-09-30T00:00:00Z'), clock.t)
  assert.deepEqual(calls.slice(3).map((c) => c.url), [LIVE_URL], 'the live file again after 30 s, the day files are kept')
})

test('TraceStore.day: no request for a hex that is no address or a span that is no span; after close, unavailable', async () => {
  const { calls, store } = spanHost({})
  for (const [hex, from, to] of [['xyz', CUT, NOW], ['4691c45', CUT, NOW], [HEX, NOW, CUT], [HEX, Number.NaN, NOW], [HEX, CUT, Number.POSITIVE_INFINITY], [HEX, Date.UTC(1999, 0, 1), NOW]] as const) {
    assert.equal(await store.day(hex, from, to), null, `${hex} ${from} ${to}`)
  }
  assert.equal(calls.length, 0)
  assert.equal((await daySpan(store, NOW - HOUR, NOW)).hex, HEX)
  assert.equal((await store.day('4691C4', NOW - HOUR, NOW) as TraceDay).hex, '4691c4', 'upper case is fine, answered lower')
  store.close()
  assert.equal(await store.day(HEX, at('2026-09-01T00:00:00Z'), at('2026-09-01T01:00:00Z')), 'unavailable')
})

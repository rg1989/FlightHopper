// server/historyStore.test.ts
// HistoryStore against a fake fetch on a fake clock. Nothing here touches the network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { encodeHeatmap, readSlot } from './heatmap.ts'
import type { HistorySlot } from '../shared/api.ts'
import { HistoryStore, heatmapUrl, type HistoryMiss, type HistoryStoreOpts } from './historyStore.ts'
import { PUBLISH_DELAY_MS, SLOT_MS, newestSlotMs, stepFor } from '../shared/history.ts'

const BASE = 'https://adsb.lol'
const MIN = 60_000
const NOW = Date.UTC(2026, 9, 1, 12, 20) // 12:20Z: the 11:30 half hour is the newest published, 12:00 is still being flown
const NEWEST = newestSlotMs(NOW)
const AGO = (slots: number): number => NEWEST - slots * SLOT_MS

/** What the upstream answers: a status and a body, or a network error. */
type Reply = { status: number; body?: Uint8Array } | Error
/** A heatmap file that differs from slot to slot (its header time), so a test can tell which slot it was given. */
const heat = (slotMs: number): Uint8Array =>
  encodeHeatmap([
    { tMs: slotMs, records: [{ hex: '738a10', lat: 32.0114, lon: 34.8867, alt: 1500, gs: 150 }] },
    { tMs: slotMs + 10_000, records: [{ hex: '738a10', lat: 32.0121, lon: 34.8869, alt: 1525, gs: 151.5 }] },
  ])
const ok = (slotMs: number): Reply => ({ status: 200, body: heat(slotMs) })

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
const settle = (): Promise<void> => new Promise((r) => setImmediate(r))
/** The slot a query gave, which the test expects to be one. */
async function asSlot(answer: Promise<HistorySlot | HistoryMiss>): Promise<HistorySlot> {
  const r = await answer
  assert.ok(typeof r !== 'string', `a slot, not '${r}'`)
  return r
}

function setup(opts: Partial<HistoryStoreOpts> = {}) {
  const clock = { t: NOW }
  const replies = new Map<string, Reply | Promise<Reply>>() // by URL; none: 404, like the real server
  const calls: { url: string; headers: Headers; signal: AbortSignal | null | undefined }[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, headers: new Headers(init?.headers), signal: init?.signal })
    const r = (await replies.get(url)) ?? { status: 404 }
    if (r instanceof Error) throw r
    return new Response((r.body ?? null) as BodyInit | null, { status: r.status })
  }) as typeof fetch
  const store = new HistoryStore({ userAgent: 'FlightHopper-test', fetchFn, nowMs: () => clock.t, ...opts })
  const serve = (slotMs: number, reply: Reply | Promise<Reply>): void => void replies.set(heatmapUrl(opts.base ?? BASE, slotMs), reply)
  return { store, clock, calls, serve }
}

test('heatmapUrl: globe_history/YYYY/MM/DD/heatmap/NN.bin.ttf, NN = 2 × UTC hour + (minute ≥ 30) on two digits', () => {
  assert.equal(heatmapUrl(BASE, Date.UTC(2026, 8, 30, 4, 0)), 'https://adsb.lol/globe_history/2026/09/30/heatmap/08.bin.ttf')
  assert.ok(heatmapUrl('https://mirror.test', Date.UTC(2026, 8, 30, 4, 0)).endsWith('globe_history/2026/09/30/heatmap/08.bin.ttf'))
  assert.ok(heatmapUrl(BASE, Date.UTC(2026, 8, 30, 4, 30)).endsWith('/2026/09/30/heatmap/09.bin.ttf'))
  assert.ok(heatmapUrl(BASE, Date.UTC(2027, 0, 5, 0, 0)).endsWith('/2027/01/05/heatmap/00.bin.ttf'))
  assert.ok(heatmapUrl(BASE, Date.UTC(2026, 11, 31, 23, 30)).endsWith('/2026/12/31/heatmap/47.bin.ttf'))
})

test('file: asks with the user agent and gzip, from adsb.lol unless told otherwise, and decodes a body that is still gzip and one that is plain', async () => {
  const { store, calls, serve } = setup()
  serve(NEWEST, { status: 200, body: new Uint8Array(gzipSync(heat(NEWEST))) }) // a body that starts 1f 8b
  serve(AGO(1), ok(AGO(1)))
  assert.deepEqual(await store.file(NEWEST), heat(NEWEST))
  assert.deepEqual(await store.file(AGO(1)), heat(AGO(1)))
  assert.deepEqual(calls.map((c) => c.url), [heatmapUrl(BASE, NEWEST), heatmapUrl(BASE, AGO(1))])
  assert.ok(calls[0].url.startsWith('https://adsb.lol/globe_history/'))
  assert.equal(calls[0].headers.get('user-agent'), 'FlightHopper-test')
  assert.equal(calls[0].headers.get('accept-encoding'), 'gzip')
  assert.ok(calls[0].signal instanceof AbortSignal && !calls[0].signal.aborted, 'a stuck download ends by itself')

  const other = setup({ base: 'https://mirror.test' })
  other.serve(NEWEST, ok(NEWEST))
  assert.deepEqual(await other.store.file(NEWEST), heat(NEWEST))
  assert.ok(other.calls[0].url.startsWith('https://mirror.test/globe_history/'))
})

test('file: a held file is not fetched again; concurrent calls for one slot share one fetch', async () => {
  const { store, calls, serve } = setup()
  const gate = deferred<Reply>()
  serve(NEWEST, gate.promise)
  const a = store.file(NEWEST)
  const b = store.file(NEWEST)
  gate.resolve(ok(NEWEST))
  const [x, y] = await Promise.all([a, b])
  assert.equal(calls.length, 1)
  assert.deepEqual(x, heat(NEWEST))
  assert.equal(y, x)
  assert.equal(await store.file(NEWEST), x)
  assert.equal(calls.length, 1, 'held')
})

test('file: a 404 or a 410 of a half hour before the newest is remembered for 10 minutes, then asked again', async () => {
  const { store, clock, calls, serve } = setup()
  serve(AGO(1), { status: 404 })
  serve(AGO(2), { status: 410 })
  assert.equal(await store.file(AGO(1)), 'missing')
  assert.equal(await store.file(AGO(2)), 'missing')
  assert.equal(calls.length, 2)
  clock.t += 10 * MIN - 1
  assert.equal(await store.file(AGO(1)), 'missing')
  assert.equal(await store.file(AGO(2)), 'missing')
  assert.equal(calls.length, 2, 'remembered')
  clock.t += 1
  serve(AGO(1), ok(AGO(1))) // it is there by now
  assert.deepEqual(await store.file(AGO(1)), heat(AGO(1)))
  assert.equal(calls.length, 3)
  assert.equal(await store.file(AGO(2)), 'missing')
  assert.equal(calls.length, 4, 'asked again')
})

test('file: a 404 or 410 of the newest half hour is "not yet": unavailable, not listed as missing, asked again after 15 s', async () => {
  const { store, clock, calls, serve } = setup()
  serve(NEWEST, { status: 404 })
  assert.equal(await store.file(NEWEST), 'unavailable', 'late, not missing: worth asking again')
  assert.deepEqual(store.status().slots, [], 'not missing')
  clock.t += 15_000 - 1
  assert.equal(await store.file(NEWEST), 'unavailable')
  assert.equal(calls.length, 1, 'remembered 15 s: not asked again yet')
  clock.t += 1
  serve(NEWEST, { status: 410 })
  assert.equal(await store.file(NEWEST), 'unavailable')
  assert.equal(calls.length, 2, 'forgotten after 15 s: asked again')
  clock.t += 15_000
  serve(NEWEST, ok(NEWEST)) // there now
  assert.deepEqual(await store.file(NEWEST), heat(NEWEST))
  assert.equal(calls.length, 3)

  // Once a newer half hour is published, a 404 of this one is an old one's: missing, for 10 minutes.
  const later = setup()
  later.serve(NEWEST, { status: 404 })
  assert.equal(await later.store.file(NEWEST), 'unavailable')
  later.clock.t += SLOT_MS
  assert.equal(await later.store.file(NEWEST), 'missing', 'now the second newest: a 404 is final')
  later.clock.t += 9 * MIN
  assert.equal(await later.store.file(NEWEST), 'missing')
  assert.equal(later.calls.length, 2)
})

test('file: any other failure is unavailable, not missing, and not held or remembered: 5xx, 429, 403, a network error, a timeout, a 200 that is not a heatmap, a body that is gzip but broken', async () => {
  const { store, calls, serve } = setup()
  const html = '<html><body>502 Bad Gateway</body></html>'
  const failures: Reply[] = [
    { status: 500 },
    { status: 429 },
    { status: 403 },
    new Error('ECONNRESET'),
    new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    { status: 200, body: new Uint8Array(0) },
    { status: 200, body: new TextEncoder().encode(html) }, // no slice header
    { status: 200, body: new Uint8Array(gzipSync(html)) }, // gzip of one, also checked after gunzip
    { status: 200, body: new Uint8Array(16 * 40) }, // zeros: records, but no slice header
    { status: 200, body: new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3]) },
  ]
  for (const [i, failure] of failures.entries()) {
    serve(NEWEST, failure)
    assert.equal(await store.file(NEWEST), 'unavailable', `failure ${i}`)
    assert.equal(calls.length, i + 1)
    assert.deepEqual(store.status().slots, [], 'not remembered as missing')
  }
  serve(NEWEST, ok(NEWEST))
  assert.deepEqual(await store.file(NEWEST), heat(NEWEST))
  assert.equal(calls.length, failures.length + 1)
})

test('file: a heatmap with a slice header and no aircraft in it is a file', async () => {
  const { store, calls, serve } = setup()
  const empty = encodeHeatmap([{ tMs: NEWEST, records: [] }])
  serve(NEWEST, { status: 200, body: empty })
  assert.deepEqual(await store.file(NEWEST), empty)
  assert.deepEqual(store.status().slots, [{ slotMs: NEWEST, state: 'ready' }])
  assert.deepEqual(await store.query(NEWEST, { lat: 32, lon: 34.8, nm: 30 }), { slotMs: NEWEST, stepS: 10, aircraft: [] })
  assert.equal(calls.length, 1)
})

test('file: a slot not published yet is unavailable (try again later), one that is no half hour is missing; no request for either', async () => {
  const { store, clock, calls, serve } = setup()
  serve(NEWEST + SLOT_MS, ok(NEWEST + SLOT_MS)) // even if the upstream had it
  for (const slotMs of [NEWEST + SLOT_MS, NEWEST + 5 * SLOT_MS]) assert.equal(await store.file(slotMs), 'unavailable', String(slotMs))
  for (const slotMs of [NEWEST + 1, NEWEST - 1000, NaN, Infinity]) assert.equal(await store.file(slotMs), 'missing', String(slotMs))
  assert.equal(calls.length, 0)
  // a half hour is published PUBLISH_DELAY_MS after it ends
  clock.t = NEWEST + 2 * SLOT_MS + PUBLISH_DELAY_MS - 1
  assert.equal(await store.file(NEWEST + SLOT_MS), 'unavailable')
  assert.equal(calls.length, 0)
  clock.t += 1
  assert.deepEqual(await store.file(NEWEST + SLOT_MS), heat(NEWEST + SLOT_MS))
  assert.equal(calls.length, 1)
})

const DAY = 24 * 60 * MIN
const TODAY = Date.UTC(2026, 9, 1) // NOW's UTC day

test('file: a half hour before the oldest day kept is missing with no request; until a search finds that day it is today − 30 days, 00:00 UTC', async () => {
  const { store, clock, calls, serve } = setup()
  const guess = TODAY - 30 * DAY // 2026-09-01 00:00Z
  assert.equal(store.oldestSlotMs(), guess)
  serve(guess - SLOT_MS, ok(guess - SLOT_MS)) // even if the upstream had it
  assert.equal(await store.file(guess - SLOT_MS), 'missing', '23:30Z the day before')
  assert.equal(await store.file(guess - 100 * SLOT_MS), 'missing')
  assert.equal(calls.length, 0)
  assert.deepEqual(store.status().slots, [], 'not remembered: nothing was asked')
  serve(guess, { status: 404 }) // 00:00Z: inside, so it is asked
  assert.equal(await store.file(guess), 'missing')
  assert.equal(calls.length, 1)
  clock.t = TODAY + DAY + 30 * MIN // the next day: the guess moves with it
  assert.equal(store.oldestSlotMs(), guess + DAY)
  clock.t += 11 * MIN
  assert.equal(await store.file(guess), 'missing', 'now before the oldest day')
  assert.equal(calls.length, 1)

  const told = setup({ oldestMs: TODAY - 42 * DAY })
  assert.equal(told.store.oldestSlotMs(), TODAY - 42 * DAY, 'as a search would have found it')
  assert.equal(await told.store.file(TODAY - 42 * DAY - SLOT_MS), 'missing')
  assert.equal(told.calls.length, 0)
  assert.equal(await told.store.file(TODAY - 42 * DAY), 'missing', '404 from the fake host')
  assert.equal(told.calls.length, 1, 'the oldest day itself is asked')
})

/**
 * A store whose host has the days from `oldest` up to today (HEAD of a day's 00.bin.ttf or 47.bin.ttf: 200) and none before
 * (404); `gone` lists files that answer 404 though their day is there.
 */
function daysHost(oldest: number | null, fail?: (url: string) => Response | Error | null, gone: ReadonlySet<string> = new Set()) {
  const clock = { t: NOW }
  const heads: { url: string; method: string | undefined; headers: Headers; signal: AbortSignal | null | undefined }[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    heads.push({ url, method: init?.method, headers: new Headers(init?.headers), signal: init?.signal })
    const trouble = fail?.(url) ?? null
    if (trouble instanceof Error) throw trouble
    if (trouble !== null) return trouble
    const m = /\/globe_history\/(\d{4})\/(\d{2})\/(\d{2})\/heatmap\/(00|47)\.bin\.ttf$/.exec(url)
    assert.ok(m !== null, url)
    const day = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    return new Response(null, { status: oldest !== null && day >= oldest && !gone.has(url) ? 200 : 404 })
  }) as typeof fetch
  const store = new HistoryStore({ userAgent: 'FlightHopper-test', fetchFn, nowMs: () => clock.t })
  return { store, clock, heads }
}

/** The days a search asked about: its HEADs of a first half hour (a day not there is asked for its last too). */
const daysAsked = (heads: { url: string }[]): number => heads.filter((h) => h.url.endsWith('/00.bin.ttf')).length

test('findOldest: a binary search with HEAD over the days from 60 back to yesterday finds the oldest one there, asking 6 days at most', async () => {
  const { store, heads } = daysHost(TODAY - 42 * DAY) // 2026-08-20, as adsb.lol had it on 2026-10-02 (42 days)
  assert.equal(await store.findOldest(), TODAY - 42 * DAY)
  assert.equal(store.oldestSlotMs(), TODAY - 42 * DAY)
  assert.equal(store.status().oldestSlotMs, TODAY - 42 * DAY)
  assert.ok(daysAsked(heads) <= 6 && heads.length <= 12, `${heads.length} requests`)
  for (const h of heads) {
    assert.equal(h.method, 'HEAD')
    assert.match(h.url, /^https:\/\/adsb\.lol\/globe_history\/2026\/(07|08|09)\/\d\d\/heatmap\/(00|47)\.bin\.ttf$/)
    assert.equal(h.headers.get('user-agent'), 'FlightHopper-test')
    assert.ok(h.signal instanceof AbortSignal && !h.signal.aborted, 'a stuck request ends by itself')
  }
  for (let back = 1; back <= 60; back++) {
    const host = daysHost(TODAY - back * DAY)
    assert.equal(await host.store.findOldest(), TODAY - back * DAY, `${back} days back`)
    assert.ok(daysAsked(host.heads) <= 6, `${back} days back: ${daysAsked(host.heads)} days asked`)
  }
  const deeper = daysHost(TODAY - 90 * DAY)
  assert.equal(await deeper.store.findOldest(), TODAY - 60 * DAY, 'older than the search looks: the farthest day it looks at')
})

test('findOldest: none of the days there, or a request that fails, is null and changes nothing', async () => {
  const none = daysHost(null)
  assert.equal(await none.store.findOldest(), null)
  assert.equal(none.store.oldestSlotMs(), TODAY - 30 * DAY, 'still the guess')
  assert.ok(daysAsked(none.heads) <= 6)
  for (const trouble of [new Response(null, { status: 503 }), new Response(null, { status: 429 }), new Error('ECONNRESET')]) {
    const host = daysHost(TODAY - 42 * DAY, () => trouble)
    assert.equal(await host.store.findOldest(), null, String(trouble))
    assert.equal(host.heads.length, 1, 'it stops at the first failure')
    assert.equal(host.store.oldestSlotMs(), TODAY - 30 * DAY)
  }
  let failing = false
  const found = daysHost(TODAY - 42 * DAY, () => (failing ? new Error('ECONNRESET') : null))
  await found.store.findOldest()
  failing = true
  assert.equal(await found.store.findOldest(), null)
  assert.equal(found.store.oldestSlotMs(), TODAY - 42 * DAY, 'a failed search keeps what the last one found')
})

test('findOldest: a day whose first half hour answers 404 is asked for its last before it counts as gone (one late or rebuilt file hides no history)', async () => {
  const day30 = new Date(TODAY - 30 * DAY).toISOString().slice(0, 10).replaceAll('-', '/') // the search's first day asked
  const first = `https://adsb.lol/globe_history/${day30}/heatmap/00.bin.ttf`
  const last = `https://adsb.lol/globe_history/${day30}/heatmap/47.bin.ttf`
  const lateFile = daysHost(TODAY - 42 * DAY, undefined, new Set([first]))
  assert.equal(await lateFile.store.findOldest(), TODAY - 42 * DAY, 'not 29 days back: the day is there')
  assert.deepEqual(lateFile.heads.slice(0, 2).map((h) => h.url), [first, last])
  const gone = daysHost(TODAY - 42 * DAY, undefined, new Set([first, last])) // both: the day counts as gone
  assert.equal(await gone.store.findOldest(), TODAY - 29 * DAY)
  const trouble = daysHost(TODAY - 42 * DAY, (url) => (url === last ? new Response(null, { status: 503 }) : null), new Set([first]))
  assert.equal(await trouble.store.findOldest(), null, 'the last half hour cannot say: no answer, nothing changed')
  assert.equal(trouble.store.oldestSlotMs(), TODAY - 30 * DAY)
})

test('tickOldest: searches at once, again 6 h after a search that found the day, 10 minutes after one that did not', async () => {
  let failing = true
  const { store, clock, heads } = daysHost(TODAY - 42 * DAY, () => (failing ? new Response(null, { status: 500 }) : null))
  await store.tickOldest()
  assert.equal(heads.length, 1, 'the first tick searches (and fails at once)')
  clock.t += 10 * MIN - 1
  await store.tickOldest()
  assert.equal(heads.length, 1, 'not again before 10 minutes')
  clock.t += 1
  failing = false
  await store.tickOldest()
  assert.equal(store.oldestSlotMs(), TODAY - 42 * DAY)
  const searched = heads.length
  clock.t += 6 * 60 * MIN - 1
  await store.tickOldest()
  assert.equal(heads.length, searched, 'not again before 6 h')
  clock.t += 1
  await store.tickOldest()
  assert.ok(heads.length > searched, '6 h on: searched again')
})

test('findOldest: after close, nothing is asked', async () => {
  const { store, heads } = daysHost(TODAY - 42 * DAY)
  store.close()
  assert.equal(await store.findOldest(), null)
  assert.equal(heads.length, 0)
})

test('file: at most maxSlots held, the least recently used goes first, the newest two published stay', async () => {
  const { store, calls, serve } = setup({ maxSlots: 3 })
  const old = [AGO(2), AGO(3), AGO(4), AGO(5)]
  for (const s of [NEWEST, AGO(1), ...old]) serve(s, ok(s))
  await store.tick()
  for (const s of old) assert.deepEqual(await store.file(s), heat(s))
  // The newest two, and the last one used (which is also the oldest in time).
  assert.deepEqual(store.status().slots, [AGO(5), AGO(1), NEWEST].map((slotMs) => ({ slotMs, state: 'ready' })))
  assert.equal(calls.length, 2 + 4)
  assert.deepEqual(await store.file(old[0]), heat(old[0]), 'dropped, so fetched again')
  assert.equal(calls.length, 2 + 4 + 1)
  assert.deepEqual(store.status().slots, [AGO(2), AGO(1), NEWEST].map((slotMs) => ({ slotMs, state: 'ready' })))
})

test('file: a hit is a use; maxSlots is 4 unless told', async () => {
  const { store, serve } = setup()
  const [a, b, c, d, e] = [AGO(2), AGO(3), AGO(4), AGO(5), AGO(6)]
  for (const s of [NEWEST, AGO(1), a, b, c, d, e]) serve(s, ok(s))
  await store.tick()
  await store.file(a)
  await store.file(b) // held: the newest two, a, b
  await store.file(a) // a is used again, so b is the one to go
  await store.file(c)
  assert.deepEqual(store.status().slots.map((s) => s.slotMs), [c, a, AGO(1), NEWEST])
  await store.file(d)
  await store.file(e)
  assert.deepEqual(store.status().slots.map((s) => s.slotMs), [e, d, AGO(1), NEWEST])
})

test('file: at most 2 downloads at once: a third slot is unavailable with no request; the same slot is shared; held and missing ones still answer', async () => {
  const { store, calls, serve } = setup()
  const [held, gone, x, y, z] = [AGO(1), AGO(2), AGO(3), AGO(4), AGO(5)]
  serve(held, ok(held))
  serve(gone, { status: 404 })
  assert.deepEqual(await store.file(held), heat(held))
  assert.equal(await store.file(gone), 'missing')
  const gateX = deferred<Reply>()
  const gateY = deferred<Reply>()
  serve(x, gateX.promise)
  serve(y, gateY.promise)
  serve(z, ok(z))
  const px = store.file(x)
  const py = store.file(y)
  assert.equal(calls.length, 4, 'two held or missing before, two downloads now')
  assert.equal(await store.file(z), 'unavailable', 'a third download: not now')
  assert.equal(calls.length, 4, 'and it asked nothing')
  const again = store.file(x) // already under way: shared, not a third
  assert.equal(calls.length, 4)
  assert.deepEqual(await store.file(held), heat(held), 'a held file answers')
  assert.equal(await store.file(gone), 'missing', 'a remembered miss answers')
  assert.deepEqual(store.status().slots.filter((s) => s.state === 'loading').map((s) => s.slotMs), [y, x])
  gateX.resolve(ok(x))
  assert.deepEqual(await px, heat(x))
  assert.equal(await again, await px)
  assert.deepEqual(await store.file(z), heat(z), 'one download ended: room for another')
  gateY.resolve(ok(y))
  assert.deepEqual(await py, heat(y))
  assert.equal(calls.length, 5)
})

test('file: downloads under way count toward maxSlots when files are dropped', async () => {
  const { store, serve } = setup({ maxSlots: 4 })
  const [a, b, c] = [AGO(2), AGO(3), AGO(4)]
  for (const s of [NEWEST, AGO(1), a]) serve(s, ok(s))
  await store.tick()
  await store.file(a) // held: the newest two and a
  const gateB = deferred<Reply>()
  const gateC = deferred<Reply>()
  serve(b, gateB.promise)
  serve(c, gateC.promise)
  const pb = store.file(b)
  const pc = store.file(c)
  gateB.resolve(ok(b))
  await pb
  // b is held and c is still coming: room for c is made now, so a, the least recently used, is gone.
  assert.deepEqual(store.status().slots, [
    { slotMs: c, state: 'loading' },
    { slotMs: b, state: 'ready' },
    { slotMs: AGO(1), state: 'ready' },
    { slotMs: NEWEST, state: 'ready' },
  ])
  gateC.resolve(ok(c))
  await pc
  assert.deepEqual(store.status().slots.map((s) => s.slotMs), [c, b, AGO(1), NEWEST])
})

test('close: the downloads under way are aborted and end as unavailable, and no new one starts', async () => {
  const signals: AbortSignal[] = []
  const fetchFn = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init!.signal!
      signals.push(signal)
      signal.addEventListener('abort', () => reject(signal.reason))
    })) as unknown as typeof fetch
  const store = new HistoryStore({ userAgent: 'FlightHopper-test', fetchFn, nowMs: () => NOW })
  const pending = store.file(NEWEST)
  assert.equal(signals.length, 1)
  assert.equal(signals[0].aborted, false)
  store.close()
  assert.equal(signals[0].aborted, true)
  assert.equal(await pending, 'unavailable')
  assert.equal(await store.file(AGO(1)), 'unavailable')
  assert.equal(signals.length, 1, 'closed: nothing new is asked')
  assert.deepEqual(store.status().slots, [])
})

test('tick: the newest two published slots, the second after the first, and only what is not held', async () => {
  const { store, clock, calls, serve } = setup()
  const gate = deferred<Reply>()
  serve(NEWEST, gate.promise)
  serve(AGO(1), ok(AGO(1)))
  const ticking = store.tick()
  await settle()
  assert.deepEqual(calls.map((c) => c.url), [heatmapUrl(BASE, NEWEST)], 'the second waits for the first')
  gate.resolve(ok(NEWEST))
  await ticking
  assert.deepEqual(calls.map((c) => c.url), [heatmapUrl(BASE, NEWEST), heatmapUrl(BASE, AGO(1))])
  await store.tick()
  assert.equal(calls.length, 2, 'both are held')
  clock.t += SLOT_MS // the next half hour is published: one new file, the one before it is held
  serve(NEWEST + SLOT_MS, ok(NEWEST + SLOT_MS))
  await store.tick()
  assert.deepEqual(calls.slice(2).map((c) => c.url), [heatmapUrl(BASE, NEWEST + SLOT_MS)])
})

test('status: the newest published slot and every slot held, loading or missing, oldest first', async () => {
  const { store, clock, serve } = setup()
  const gate = deferred<Reply>()
  serve(AGO(1), ok(AGO(1)))
  serve(AGO(2), gate.promise)
  serve(AGO(3), { status: 404 })
  assert.deepEqual(store.status(), { newestSlotMs: NEWEST, oldestSlotMs: TODAY - 30 * DAY, slots: [] })
  await store.file(AGO(1))
  await store.file(AGO(3))
  const loading = store.file(AGO(2))
  assert.deepEqual(store.status(), {
    newestSlotMs: NEWEST,
    oldestSlotMs: TODAY - 30 * DAY,
    slots: [
      { slotMs: AGO(3), state: 'missing' },
      { slotMs: AGO(2), state: 'loading' },
      { slotMs: AGO(1), state: 'ready' },
    ],
  })
  gate.resolve(ok(AGO(2)))
  await loading
  assert.deepEqual(store.status().slots.map((s) => s.state), ['missing', 'ready', 'ready'])
  clock.t += 10 * MIN
  assert.deepEqual(store.status().slots, [{ slotMs: AGO(2), state: 'ready' }, { slotMs: AGO(1), state: 'ready' }], 'a miss is forgotten after 10 minutes')
})

test('query: readSlot of the file for the circle, the step from its radius; missing or unavailable when there is no file', async () => {
  const { store, calls, serve } = setup()
  serve(NEWEST, ok(NEWEST))
  const circle = { lat: 32.0114, lon: 34.8867, nm: 30 }
  const got = await asSlot(store.query(NEWEST, circle))
  assert.equal(got.aircraft.length, 1)
  assert.deepEqual(got, readSlot(heat(NEWEST), { ...circle, slotMs: NEWEST, stepS: stepFor(30) }))
  assert.equal(got.slotMs, NEWEST)
  assert.equal(got.stepS, 10)
  assert.equal((await asSlot(store.query(NEWEST, { ...circle, nm: 500 }))).stepS, 30)
  assert.deepEqual((await asSlot(store.query(NEWEST, { lat: 40.6, lon: -73.8, nm: 30 }))).aircraft, [])
  assert.equal(await store.query(AGO(1), circle), 'missing', '404')
  assert.equal(await store.query(NEWEST + SLOT_MS, circle), 'unavailable', 'too new')
  assert.equal(calls.length, 2, 'one fetch of the newest, one of the missing')
})

test('held: a held slot is answered without a fetch; one not held is null, and asking for it fetches nothing', async () => {
  const { store, calls, serve } = setup()
  serve(NEWEST, ok(NEWEST))
  assert.equal(store.held(NEWEST), null)
  assert.equal(calls.length, 0)
  const f = await store.file(NEWEST)
  assert.equal(store.held(NEWEST), f)
  assert.equal(calls.length, 1)
})

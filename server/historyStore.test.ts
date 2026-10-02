// server/historyStore.test.ts
// HistoryStore against a fake fetch on a fake clock. Nothing here touches the network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { encodeHeatmap, readSlot } from './heatmap.ts'
import { HistoryStore, heatmapUrl, type HistoryStoreOpts } from './historyStore.ts'
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

test('file: a 404 or a 410 is remembered for 10 minutes, then asked again', async () => {
  const { store, clock, calls, serve } = setup()
  serve(NEWEST, { status: 404 })
  serve(AGO(1), { status: 410 })
  assert.equal(await store.file(NEWEST), null)
  assert.equal(await store.file(AGO(1)), null)
  assert.equal(calls.length, 2)
  clock.t += 10 * MIN - 1
  assert.equal(await store.file(NEWEST), null)
  assert.equal(await store.file(AGO(1)), null)
  assert.equal(calls.length, 2, 'remembered')
  clock.t += 1
  serve(NEWEST, ok(NEWEST)) // it is there by now
  assert.deepEqual(await store.file(NEWEST), heat(NEWEST))
  assert.equal(calls.length, 3)
  assert.equal(await store.file(AGO(1)), null)
  assert.equal(calls.length, 4, 'asked again')
})

test('file: any other failure is null, not held and not remembered: 5xx, 429, a network error, a 200 that is not a heatmap, a body that is gzip but broken', async () => {
  const { store, calls, serve } = setup()
  const html = '<html><body>502 Bad Gateway</body></html>'
  const failures: Reply[] = [
    { status: 500 },
    { status: 429 },
    { status: 403 },
    new Error('ECONNRESET'),
    { status: 200, body: new Uint8Array(0) },
    { status: 200, body: new TextEncoder().encode(html) }, // no slice header
    { status: 200, body: new Uint8Array(gzipSync(html)) }, // gzip of one, also checked after gunzip
    { status: 200, body: new Uint8Array(16 * 40) }, // zeros: records, but no slice header
    { status: 200, body: new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3]) },
  ]
  for (const [i, failure] of failures.entries()) {
    serve(NEWEST, failure)
    assert.equal(await store.file(NEWEST), null, `failure ${i}`)
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

test('file: a slot newer than the newest published, one not on a half hour: null, no request', async () => {
  const { store, clock, calls, serve } = setup()
  serve(NEWEST + SLOT_MS, ok(NEWEST + SLOT_MS)) // even if the upstream had it
  for (const slotMs of [NEWEST + SLOT_MS, NEWEST + 5 * SLOT_MS, NEWEST + 1, NEWEST - 1000, NaN, Infinity]) assert.equal(await store.file(slotMs), null, String(slotMs))
  assert.equal(calls.length, 0)
  // a half hour is published PUBLISH_DELAY_MS after it ends
  clock.t = NEWEST + 2 * SLOT_MS + PUBLISH_DELAY_MS - 1
  assert.equal(await store.file(NEWEST + SLOT_MS), null)
  assert.equal(calls.length, 0)
  clock.t += 1
  assert.deepEqual(await store.file(NEWEST + SLOT_MS), heat(NEWEST + SLOT_MS))
  assert.equal(calls.length, 1)
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
  assert.deepEqual(store.status(), { newestSlotMs: NEWEST, slots: [] })
  await store.file(AGO(1))
  await store.file(AGO(3))
  const loading = store.file(AGO(2))
  assert.deepEqual(store.status(), {
    newestSlotMs: NEWEST,
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

test('query: readSlot of the file for the circle, the step from its radius; null when there is no file', async () => {
  const { store, calls, serve } = setup()
  serve(NEWEST, ok(NEWEST))
  const circle = { lat: 32.0114, lon: 34.8867, nm: 30 }
  const got = await store.query(NEWEST, circle)
  assert.equal(got?.aircraft.length, 1)
  assert.deepEqual(got, readSlot(heat(NEWEST), { ...circle, stepS: stepFor(30) }))
  assert.equal(got?.stepS, 10)
  assert.equal((await store.query(NEWEST, { ...circle, nm: 500 }))?.stepS, 30)
  assert.deepEqual((await store.query(NEWEST, { lat: 40.6, lon: -73.8, nm: 30 }))?.aircraft, [])
  assert.equal(await store.query(AGO(1), circle), null, '404')
  assert.equal(await store.query(NEWEST + SLOT_MS, circle), null, 'too new')
  assert.equal(calls.length, 2, 'one fetch of the newest, one of the missing')
})

// server/poller.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { normalizeAdsblol, normalizeReadsb } from '../shared/readsb.ts'
import { TokenBucket } from './budget.ts'
import { distanceNm } from '../shared/geo.ts'
import { cellsForView, isBusy } from './cells.ts'
import { Poller, viewPeriodMs, type PollerOpts } from './poller.ts'
import { Recorder } from './recorder.ts'
import { readRecording } from './recording.ts'
import { SampleStore } from './store.ts'
import type { FetchResult, Source } from './sources/types.ts'

const golden = (f: string): string => readFileSync(new URL(`../data/fixtures/golden/${f}`, import.meta.url), 'utf8')

type Method = 'circle' | 'hexes' | 'all'
const BODIES: Record<Method, string> = {
  circle: golden('adsblol-point-ksfo.json'), // adsb.lol envelope, 7 aircraft incl. 000001 (dbFlags 8)
  hexes: golden('adsblol-hex.json'), // adsb.lol envelope: 71bd79, a448f2, a1c7e4
  all: golden('readsb-circle.json'), // readsb envelope, same 7 aircraft as the KSFO point
}

const KSFO = [37.6188, -122.3758] as const
const LLBG = [32.0114, 34.8867] as const // a 5 nm view here is exactly one cell
const DAY_MS = 86_400_000
// When the golden bodies were recorded: their own upstream `now`, in ms (2026-09-22).
const ALL_NOW_MS = normalizeReadsb(BODIES.all).nowMs // 1_790_081_633_500
const HEXES_NOW_MS = normalizeAdsblol(BODIES.hexes).nowMs // 1_790_081_641_500

interface Call {
  t: number
  m: Method
  args: unknown[]
}

/** Fake upstream on a fake clock: records calls, answers golden bodies; queued replies override the status. */
function fakeSource(clock: { t: number }, fullSnapshot: boolean) {
  const calls: Call[] = []
  const replies: { status: number; retryAfterS?: number }[] = []
  const reply = (m: Method, args: unknown[]): Promise<FetchResult> => {
    calls.push({ t: clock.t, m, args })
    const { status, retryAfterS } = replies.shift() ?? { status: 200 }
    const body = status === 200 ? BODIES[m] : ''
    const snapshot = status === 200 ? (m === 'all' ? normalizeReadsb(body) : normalizeAdsblol(body)) : null
    const r = { url: `fake:${m}`, status, tSendMs: clock.t, tRecvMs: clock.t, bytes: body.length || 100, body, retryAfterS: retryAfterS ?? null, snapshot }
    return Promise.resolve(r)
  }
  const source: Source = {
    caps: { kind: fullSnapshot ? 'readsb' : 'adsblol', fullSnapshot, maxRps: fullSnapshot ? 5 : 1, coverage: null, attribution: 'test' },
    circle: (lat, lon, radiusNm) => reply('circle', [lat, lon, radiusNm]),
    hexes: (hexes) => reply('hexes', [hexes]),
    all: () => (fullSnapshot ? reply('all', []) : Promise.reject(new Error('unsupported'))),
  }
  return { source, calls, replies }
}

const T0 = 1_000_000

function setup(o: { fullSnapshot?: boolean; maxRps?: number; hideFlagged?: boolean; recorder?: Recorder; opts?: Partial<PollerOpts> } = {}) {
  const clock = { t: T0 }
  const f = fakeSource(clock, o.fullSnapshot ?? false)
  const store = new SampleStore()
  const bucket = new TokenBucket(o.maxRps ?? 100, () => clock.t, () => 0)
  const poller = new Poller(f.source, store, bucket, {
    cellPeriodMs: 3000,
    chasePeriodMs: 1000,
    fullSnapshotPeriodMs: 1000,
    interestTtlMs: 15_000,
    chaseTtlMs: 10_000,
    recorder: o.recorder ?? null,
    hideFlagged: o.hideFlagged ?? true,
    nowMs: () => clock.t,
    ...o.opts,
  })
  return { clock, store, bucket, poller, ...f }
}

/** Ticks every 100 ms from the current fake time up to and including T0 + untilMs. */
async function runUntil(s: ReturnType<typeof setup>, untilMs: number, each?: () => void): Promise<void> {
  for (; s.clock.t <= T0 + untilMs; s.clock.t += 100) {
    each?.()
    await s.poller.tick()
  }
}

const rel = (calls: Call[], m?: Method): number[] => calls.filter((c) => m === undefined || c.m === m).map((c) => c.t - T0)

test('touchView: a view up to 250 nm is one circle of its own; a wider one, the grid cells covering it', () => {
  const s = setup()
  assert.deepEqual(s.poller.touchView(KSFO[0], KSFO[1], 40), [{ id: 'view', lat: KSFO[0], lon: KSFO[1], radiusNm: 40 }])
  const wide = s.poller.touchView(KSFO[0], KSFO[1], 400)
  assert.deepEqual(wide, cellsForView(KSFO[0], KSFO[1], 400))
  assert.ok(wide.length > 10)
  const r = s.poller.report()
  // The newest view wins: the older view's circle, never asked, is gone.
  assert.deepEqual(r.cells.map((c) => c.id).sort(), wide.map((c) => c.id).sort())
  assert.ok(r.cells.every((c) => c.lastOkMs === null && c.periodP95S === null))
  assert.equal(r.pendingAreas, wide.length)
})

test('viewPeriodMs: 0.12 s per nm up to 500 nm, then as r² (so wide views cost alike), 5 s to 30 min', () => {
  assert.equal(viewPeriodMs(20), 5000)
  assert.equal(viewPeriodMs(130), 15_600)
  assert.equal(viewPeriodMs(500), 60_000)
  assert.equal(viewPeriodMs(1000), 240_000)
  assert.equal(viewPeriodMs(5400), 1_800_000)
})

test('a globe-wide view asks only for the areas within 2,500 nm of its centre', () => {
  const s = setup()
  assert.deepEqual(s.poller.touchView(48, 10, 5400), cellsForView(48, 10, 2500))
})

test('chase batch goes before a due area; the area gets the next token', async () => {
  const s = setup()
  s.poller.touchView(LLBG[0], LLBG[1], 5)
  s.poller.touchChase('A1C7E4')
  assert.equal(await s.poller.tick(), true)
  assert.deepEqual(s.calls[0], { t: T0, m: 'hexes', args: [['a1c7e4']] })
  s.clock.t += 100
  assert.equal(await s.poller.tick(), true)
  assert.equal(s.calls[1].m, 'circle')
})

test('while chasing, the view circle is asked every chasePeriodMs and carries the chased aircraft: no hex requests', async () => {
  const hex = normalizeAdsblol(BODIES.circle).aircraft.find((a) => a.hex !== '000001' && distanceNm(KSFO[0], KSFO[1], a.lat!, a.lon!) < 15)!.hex
  const s = setup({ maxRps: 1, opts: { chasePeriodMs: 1400 } })
  await runUntil(s, 20_000, () => {
    if ((s.clock.t - T0) % 1000 !== 0) return // the client polls every second
    s.poller.touchView(KSFO[0], KSFO[1], 20)
    s.poller.touchChase(hex)
  })
  assert.deepEqual(rel(s.calls, 'hexes'), [0], 'only before the circle has delivered it')
  const circles = rel(s.calls, 'circle')
  assert.ok(circles.length >= 13, `${circles}`)
  for (let i = 1; i < circles.length; i++) assert.ok(circles[i] - circles[i - 1] <= 1500, `${circles}`)
  assert.equal(s.poller.brief().chaseEveryS, 1.4)
})

test('a chased aircraft outside the view circle gets a hex request every chasePeriodMs; one that is not found, every 30 s', async () => {
  const s = setup({ opts: { chasePeriodMs: 1400 } })
  await runUntil(s, 5000, () => {
    if ((s.clock.t - T0) % 1000 !== 0) return
    s.poller.touchView(LLBG[0], LLBG[1], 5) // a1c7e4 (in the golden hex body) flies elsewhere
    s.poller.touchChase('a1c7e4')
  })
  assert.deepEqual(rel(s.calls, 'hexes'), [0, 1400, 2800, 4200])

  const t = setup({ opts: { chasePeriodMs: 1400 } })
  t.replies.push({ status: 200 }) // the golden hex body…
  t.poller.touchChase('abcdef')
  await t.poller.tick()
  assert.equal(t.calls.length, 1)
})

test('singleCircle: every view, however wide, is one circle of ≤ 250 nm; a new view replaces the old one', async () => {
  const s = setup({ opts: { singleCircle: true } })
  assert.deepEqual(s.poller.touchView(KSFO[0], KSFO[1], 60.2), [{ id: 'view', lat: KSFO[0], lon: KSFO[1], radiusNm: 61 }])
  assert.equal(await s.poller.tick(), true)
  assert.deepEqual(s.calls[0], { t: T0, m: 'circle', args: [KSFO[0], KSFO[1], 61] })
  s.clock.t += 100
  assert.equal(await s.poller.tick(), false, 'not due again before its period')
  s.clock.t += viewPeriodMs(3000)
  s.poller.touchView(LLBG[0], LLBG[1], 3000) // the globe: still one circle, at the upstream's 250 nm limit
  assert.equal(await s.poller.tick(), true)
  assert.deepEqual(s.calls[1].args, [LLBG[0], LLBG[1], 250])
  assert.deepEqual(s.poller.report().cells.map((c) => c.id), ['view'])
})

test('a globe view over the Atlantic asks for busy airspace (Europe, America) before the empty ocean at its centre', async () => {
  const s = setup()
  const cells = s.poller.touchView(45, -30, 5400)
  await runUntil(s, 20_000, () => {
    if ((s.clock.t - T0) % 1000 === 0) s.poller.touchView(45, -30, 5400)
  })
  const busy = cells.filter(isBusy).length
  assert.ok(busy > 50 && busy < cells.length - 50, `${busy} of ${cells.length}`)
  const asked = s.calls.map((c) => ({ lat: c.args[0] as number, lon: c.args[1] as number, id: '', radiusNm: 0 }))
  assert.ok(asked.length > busy)
  assert.ok(asked.slice(0, busy).every(isBusy), 'busy airspace first')
  assert.ok(!asked.slice(busy).some(isBusy), 'then the rest')
})

test('a wide view: never-asked areas nearest its centre first, then each once per its view period', async () => {
  const s = setup()
  const cells = s.poller.touchView(KSFO[0], KSFO[1], 400)
  const period = viewPeriodMs(400) // 48 s
  await runUntil(s, period + 5000, () => {
    if ((s.clock.t - T0) % 1000 === 0) s.poller.touchView(KSFO[0], KSFO[1], 400)
  })
  const firstRound = s.calls.slice(0, cells.length).map((c) => ({ lat: c.args[0] as number, lon: c.args[1] as number, id: '', radiusNm: 0 }))
  const nBusy = cells.filter(isBusy).length // the US box; the Pacific part comes after it
  for (const group of [firstRound.slice(0, nBusy), firstRound.slice(nBusy)]) {
    const d = group.map((c) => distanceNm(KSFO[0], KSFO[1], c.lat, c.lon))
    assert.deepEqual(d, [...d].sort((a, b) => a - b), 'centre-out within busy, then within the rest')
  }
  assert.ok(firstRound.slice(0, nBusy).every(isBusy))
  assert.equal(new Set(s.calls.slice(0, cells.length).map((c) => `${c.args[0]},${c.args[1]}`)).size, cells.length)
  const second = s.calls.slice(cells.length)
  assert.ok(second.length > 0 && second.every((c) => c.t - T0 >= period), 'nothing is asked twice within its period')
})

test('an area whose last answer was empty is asked 4× less often', async () => {
  const s = setup()
  const empty = JSON.stringify({ ac: [], msg: 'No error', now: 1_790_000_000_000, total: 0 })
  s.source.circle = (lat, lon, radiusNm) => {
    s.calls.push({ t: s.clock.t, m: 'circle', args: [lat, lon, radiusNm] })
    return Promise.resolve({ url: 'fake', status: 200, tSendMs: s.clock.t, tRecvMs: s.clock.t, bytes: empty.length, body: empty, retryAfterS: null, snapshot: normalizeAdsblol(empty) })
  }
  await runUntil(s, 25_000, () => {
    if ((s.clock.t - T0) % 1000 === 0) s.poller.touchView(LLBG[0], LLBG[1], 20) // period 5 s → 20 s when empty
  })
  assert.deepEqual(rel(s.calls), [0, 20_000])
})

test('interest expires after interestTtlMs; touching again extends it', async () => {
  const s = setup()
  s.poller.touchView(LLBG[0], LLBG[1], 5)
  await runUntil(s, 20_000)
  assert.deepEqual(rel(s.calls), [0, 5000, 10_000])
  assert.deepEqual(s.poller.report().cells, [])

  const s2 = setup()
  s2.poller.touchView(LLBG[0], LLBG[1], 5)
  await runUntil(s2, 30_000, () => {
    if (s2.clock.t === T0 + 10_000) s2.poller.touchView(LLBG[0], LLBG[1], 5)
  })
  assert.deepEqual(rel(s2.calls), [0, 5000, 10_000, 15_000, 20_000])
})

test('a chase expires after chaseTtlMs', async () => {
  const s = setup()
  s.poller.touchChase('a1c7e4')
  assert.deepEqual(s.poller.report().chasedHexes, ['a1c7e4'])
  await runUntil(s, 12_000)
  assert.deepEqual(rel(s.calls, 'hexes'), [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000])
  assert.deepEqual(s.poller.report().chasedHexes, [])
})

test('the chase batch holds at most 100 hexes, most recently touched first', async () => {
  const s = setup()
  for (let i = 0; i < 150; i++) {
    s.poller.touchChase(i.toString(16).padStart(6, '0'))
    s.clock.t += 1
  }
  await s.poller.tick()
  const batch = s.calls[0].args[0] as string[]
  assert.equal(batch.length, 100)
  assert.equal(batch[0], (149).toString(16).padStart(6, '0'))
  assert.ok(!batch.includes('000000'))
})

test('429: no request until Retry-After has passed, then one probe; degraded rate-limited', async () => {
  const s = setup({ maxRps: 1 })
  s.poller.touchChase('a1c7e4')
  s.replies.push({ status: 429, retryAfterS: 5 })
  assert.equal(await s.poller.tick(), true)
  assert.equal(s.poller.brief().degraded, 'rate-limited')
  for (s.clock.t = T0 + 100; s.clock.t < T0 + 5000; s.clock.t += 100) assert.equal(await s.poller.tick(), false)
  assert.equal(s.calls.length, 1)
  s.poller.touchChase('a1c7e4')
  assert.equal(await s.poller.tick(), true)
  assert.deepEqual(rel(s.calls), [0, 5000])
  assert.equal(s.poller.report().budget.counts.r429, 1)
})

test('403: blocked for good, degraded blocked', async () => {
  const s = setup()
  s.poller.touchView(LLBG[0], LLBG[1], 5)
  s.replies.push({ status: 403 })
  assert.equal(await s.poller.tick(), true)
  for (let i = 0; i < 20; i++) {
    s.clock.t += 60_000
    s.poller.touchView(LLBG[0], LLBG[1], 5)
    s.poller.touchChase('a1c7e4')
    assert.equal(await s.poller.tick(), false)
  }
  assert.equal(s.calls.length, 1)
  assert.equal(s.poller.brief().degraded, 'blocked')
  assert.equal(s.poller.report().budget.blocked, true)
})

test('fullSnapshot source: all() once per fullSnapshotPeriodMs, never circle or hexes', async () => {
  const s = setup({ fullSnapshot: true })
  assert.deepEqual(s.poller.touchView(KSFO[0], KSFO[1], 40), [])
  s.poller.touchChase('a1c7e4')
  await runUntil(s, 3500)
  assert.deepEqual(s.calls.map((c) => c.m), ['all', 'all', 'all', 'all'])
  assert.deepEqual(rel(s.calls), [0, 1000, 2000, 3000])
  assert.equal(s.store.latest('a1c7e4')?.lat, 39.788635)
  const b = s.poller.brief()
  assert.deepEqual(b, {
    source: 'readsb', degraded: null, cellPeriodP95S: 1, chasePeriodP95S: 1, viewEveryS: 1, chaseEveryS: 1, pendingAreas: 0, upstreamOffsetMs: T0 - ALL_NOW_MS,
  })
})

test('samples land in the store in server clock: upstream now − seen_pos + (tRecv − now)', async () => {
  const s = setup()
  s.poller.touchChase('71bd79')
  await s.poller.tick()
  const snap = normalizeAdsblol(BODIES.hexes)
  const ac = snap.aircraft.find((a) => a.hex === '71bd79')!
  const got = s.store.latest('71bd79')!
  assert.equal(got.tMs, T0 - Math.round(ac.seen_pos! * 1000))
  assert.equal(got.rxMs, T0)
  assert.equal(s.store.size, 3)
  // a later, slower answer does not move the offset (windowed minimum): the re-served body adds nothing
  s.clock.t += 1000
  await s.poller.tick()
  assert.equal(s.store.size, 3)
})

test('hidden (PIA/LADD) aircraft are dropped unless hideFlagged is false', async () => {
  const hide = setup()
  hide.poller.touchView(LLBG[0], LLBG[1], 5)
  await hide.poller.tick()
  assert.equal(hide.store.latest('000001'), null)
  assert.notEqual(hide.store.latest('71bd79'), null)
  assert.equal(hide.store.size, 6)

  const show = setup({ hideFlagged: false })
  show.poller.touchView(LLBG[0], LLBG[1], 5)
  await show.poller.tick()
  assert.notEqual(show.store.latest('000001'), null)
  assert.equal(show.store.size, 7)
})

test('the recorder receives every result, failures included', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fh-poller-'))
  const s = setup({ recorder: new Recorder(dir) })
  s.poller.touchView(LLBG[0], LLBG[1], 5)
  s.poller.touchChase('a1c7e4')
  s.replies.push({ status: 200 }, { status: 429, retryAfterS: 2 })
  await runUntil(s, 3000) // chase 200 at 0, cell 429 at 100, pause, chase 200 at 2100
  const files = readdirSync(dir)
  assert.deepEqual(files, ['1970-01-01.jsonl'])
  const lines = readRecording(join(dir, files[0]))
  assert.equal(lines.length, s.calls.length)
  assert.deepEqual(lines.map((l) => l.status), [200, 429, 200])
  assert.deepEqual(lines.map((l) => l.url), ['fake:hexes', 'fake:circle', 'fake:hexes'])
  assert.equal(lines[1].body, '')
  assert.equal(lines[0].source, 'adsblol')
})

test('report: periods, counters and bytes per hour', async () => {
  const s = setup()
  s.poller.touchView(LLBG[0], LLBG[1], 5)
  s.poller.touchChase('a1c7e4')
  await runUntil(s, 9950, () => {
    if ((s.clock.t - T0) % 5000 !== 0) return
    s.poller.touchView(LLBG[0], LLBG[1], 5)
    s.poller.touchChase('a1c7e4')
  })
  const r = s.poller.report()
  assert.equal(r.source, 'adsblol')
  assert.equal(r.degraded, null)
  assert.equal(r.requestsTotal, s.calls.length)
  // a1c7e4 flies outside the 5 nm view circle: hex requests at 0..9000; the circle at its own 5 s period, 100 and 5100
  assert.equal(r.requestsTotal, 10 + 2)
  assert.equal(r.chasePeriodP95S, 1)
  assert.equal(r.cellPeriodP95S, 5)
  assert.equal(r.cells.length, 1)
  assert.equal(r.cells[0].lastOkMs, T0 + 5100)
  assert.equal(r.cells[0].periodP95S, 5)
  assert.deepEqual(r.chasedHexes, ['a1c7e4'])
  assert.equal(r.budget.counts.ok, 12)
  assert.equal(r.viewEveryS, 5)
  assert.equal(r.pendingAreas, 0)
  // under a minute of data is scaled up from a one-minute floor
  const bytes = 10 * BODIES.hexes.length + 2 * BODIES.circle.length
  assert.equal(r.bytesPerHourEstimate, bytes * 60)

  // bytes older than an hour no longer count
  s.clock.t += 2 * 3_600_000
  assert.equal(s.poller.report().bytesPerHourEstimate, 0)
})

test('brief before any response: nulls, not zeros', () => {
  const s = setup()
  assert.deepEqual(s.poller.brief(), {
    source: 'adsblol', degraded: null, cellPeriodP95S: null, chasePeriodP95S: null, viewEveryS: 0, chaseEveryS: 1, pendingAreas: 0,
  })
})

test('upstreamOffsetMs: a recording served 3 days later reports 3 days; tMs − upstreamOffsetMs is the recorded time', async () => {
  const s = setup({ fullSnapshot: true }) // a replay-like upstream: its answers say "now" = when they were recorded
  s.clock.t = ALL_NOW_MS + 3 * DAY_MS
  assert.equal(await s.poller.tick(), true)
  const b = s.poller.brief()
  assert.equal(b.upstreamOffsetMs, 3 * DAY_MS)
  const ac = normalizeReadsb(BODIES.all).aircraft.find((a) => a.hex === 'a1c7e4')!
  assert.equal(s.store.latest('a1c7e4')!.tMs - b.upstreamOffsetMs!, ALL_NOW_MS - Math.round(ac.seen_pos! * 1000))
  // a later, slower answer does not move it (windowed minimum); report() extends brief() and carries it too
  s.clock.t += 1000
  assert.equal(await s.poller.tick(), true)
  assert.equal(s.poller.report().upstreamOffsetMs, 3 * DAY_MS)
})

test('upstreamOffsetMs: live, about the latency, in whole ms; absent until a good answer', async () => {
  const s = setup()
  s.poller.touchChase('71bd79')
  s.replies.push({ status: 503 })
  assert.equal(await s.poller.tick(), true)
  assert.equal('upstreamOffsetMs' in s.poller.brief(), false, 'a failed answer gives no offset')
  s.clock.t = HEXES_NOW_MS + 180.6 // this answer arrives 180.6 ms after the upstream's now
  s.poller.touchChase('71bd79')
  assert.equal(await s.poller.tick(), true)
  assert.equal(s.poller.brief().upstreamOffsetMs, 181)
})

test('start() ticks every 100 ms without overlapping ticks; stop() ends it', async () => {
  let inFlight = 0
  let maxInFlight = 0
  let calls = 0
  const body = BODIES.all
  const source: Source = {
    caps: { kind: 'readsb', fullSnapshot: true, maxRps: 5, coverage: null, attribution: 'test' },
    circle: () => Promise.reject(new Error('unexpected')),
    hexes: () => Promise.reject(new Error('unexpected')),
    all: async () => {
      calls++
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await sleep(250) // a slow upstream: each request spans several 100 ms timer ticks
      inFlight--
      const t = Date.now()
      return { url: 'fake:all', status: 200, tSendMs: t, tRecvMs: t, bytes: body.length, body, retryAfterS: null, snapshot: normalizeReadsb(body) }
    },
  }
  const opts: PollerOpts = { cellPeriodMs: 3000, chasePeriodMs: 1000, fullSnapshotPeriodMs: 0, interestTtlMs: 15_000, chaseTtlMs: 10_000, recorder: null, hideFlagged: true }
  const p = new Poller(source, new SampleStore(), new TokenBucket(100), opts)
  p.start()
  p.start() // idempotent
  await sleep(1000)
  p.stop()
  const atStop = calls
  await sleep(500)
  assert.equal(maxInFlight, 1)
  assert.ok(atStop >= 2 && atStop <= 4, `calls=${atStop}`)
  assert.equal(calls, atStop)
  assert.equal(inFlight, 0)
})

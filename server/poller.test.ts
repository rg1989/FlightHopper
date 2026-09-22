// server/poller.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { normalizeAdsblol, normalizeReadsb } from '../shared/readsb.ts'
import { TokenBucket } from './budget.ts'
import { cellsForView } from './cells.ts'
import { Poller, type PollerOpts } from './poller.ts'
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

test('touchView registers the cells of cellsForView and returns them', () => {
  const s = setup()
  const cells = s.poller.touchView(KSFO[0], KSFO[1], 40)
  assert.deepEqual(cells, cellsForView(KSFO[0], KSFO[1], 40))
  assert.equal(cells.length, 3)
  assert.deepEqual(s.poller.report().cells.map((c) => c.id), cells.map((c) => c.id))
  assert.ok(s.poller.report().cells.every((c) => c.lastOkMs === null && c.periodP95S === null))
})

test('chase batch goes before a due cell; the cell gets the next token', async () => {
  const s = setup()
  s.poller.touchView(LLBG[0], LLBG[1], 5)
  s.poller.touchChase('A1C7E4')
  assert.equal(await s.poller.tick(), true)
  assert.deepEqual(s.calls[0], { t: T0, m: 'hexes', args: [['a1c7e4']] })
  s.clock.t += 100
  assert.equal(await s.poller.tick(), true)
  assert.equal(s.calls[1].m, 'circle')
})

test('while chasing, a cell only gets a token when one is left for the next chase', async () => {
  // 1 req/s with a 1 s chase: the chase uses every token; the cell never makes the chase wait
  const s = setup({ maxRps: 1 })
  s.poller.touchView(LLBG[0], LLBG[1], 5)
  s.poller.touchChase('a1c7e4')
  await runUntil(s, 6000)
  // (The bucket accrues 0.1 token per 100 ms tick in floating point, so a token can show up one tick late.)
  const chase = rel(s.calls, 'hexes')
  assert.equal(chase[0], 0)
  assert.ok(chase.length >= 5)
  for (let i = 1; i < chase.length; i++) assert.ok(chase[i] - chase[i - 1] <= 1100, `${chase}`)
  assert.deepEqual(rel(s.calls, 'circle'), [])

  // 1 req/s with a 1.4 s chase: the cell gets the spare 0.29 token/s and the chase keeps its period
  const t = setup({ maxRps: 1, opts: { chasePeriodMs: 1400 } })
  await runUntil(t, 60_000, () => {
    if ((t.clock.t - T0) % 5000 !== 0) return
    t.poller.touchView(LLBG[0], LLBG[1], 5)
    t.poller.touchChase('a1c7e4')
  })
  const r = t.poller.report()
  assert.equal(r.chasePeriodP95S, 1.4)
  assert.ok(r.cellPeriodP95S !== null && r.cellPeriodP95S >= 3 && r.cellPeriodP95S <= 4.5, `cell p95 ${r.cellPeriodP95S}`)
  assert.ok(r.requestsTotal <= 62, `${r.requestsTotal} requests in 60 s at 1 req/s`)
})

test('each cell is polled once per cellPeriodMs, most overdue first', async () => {
  const s = setup()
  const cells = s.poller.touchView(KSFO[0], KSFO[1], 40)
  await runUntil(s, 6500)
  const at = (i: number): number[] => s.calls.filter((c) => c.args[0] === cells[i].lat && c.args[1] === cells[i].lon).map((c) => c.t - T0)
  assert.deepEqual(at(0), [0, 3000, 6000])
  assert.deepEqual(at(1), [100, 3100, 6100])
  assert.deepEqual(at(2), [200, 3200, 6200])
  assert.deepEqual(s.calls[0].args, [cells[0].lat, cells[0].lon, cells[0].radiusNm])
  assert.equal(s.calls.length, 9)
})

test('interest expires after interestTtlMs; touching again extends it', async () => {
  const s = setup()
  s.poller.touchView(LLBG[0], LLBG[1], 5)
  await runUntil(s, 20_000)
  assert.deepEqual(rel(s.calls), [0, 3000, 6000, 9000, 12_000])
  assert.deepEqual(s.poller.report().cells, [])

  const s2 = setup()
  s2.poller.touchView(LLBG[0], LLBG[1], 5)
  await runUntil(s2, 25_000, () => {
    if (s2.clock.t === T0 + 10_000) s2.poller.touchView(LLBG[0], LLBG[1], 5)
  })
  assert.deepEqual(rel(s2.calls), [0, 3000, 6000, 9000, 12_000, 15_000, 18_000, 21_000, 24_000])
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
  assert.deepEqual(b, { source: 'readsb', degraded: null, cellPeriodP95S: 1, chasePeriodP95S: 1 })
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
  assert.equal(r.requestsTotal, 10 + 4) // chase at 0..9000, cell at 100, 3100, 6100, 9100
  assert.equal(r.chasePeriodP95S, 1)
  assert.equal(r.cellPeriodP95S, 3)
  assert.equal(r.cells.length, 1)
  assert.equal(r.cells[0].lastOkMs, T0 + 9100)
  assert.equal(r.cells[0].periodP95S, 3)
  assert.deepEqual(r.chasedHexes, ['a1c7e4'])
  assert.equal(r.budget.counts.ok, 14)
  // under a minute of data is scaled up from a one-minute floor
  const bytes = 10 * BODIES.hexes.length + 4 * BODIES.circle.length
  assert.equal(r.bytesPerHourEstimate, bytes * 60)

  // bytes older than an hour no longer count
  s.clock.t += 2 * 3_600_000
  assert.equal(s.poller.report().bytesPerHourEstimate, 0)
})

test('brief before any response: nulls, not zeros', () => {
  const s = setup()
  assert.deepEqual(s.poller.brief(), { source: 'adsblol', degraded: null, cellPeriodP95S: null, chasePeriodP95S: null })
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

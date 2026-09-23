// server/poller.info.test.ts
// The poller hands every non-hidden upstream aircraft to the InfoStore, stamped with the answer's receive time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeAdsblol } from '../shared/readsb.ts'
import { TokenBucket } from './budget.ts'
import { InfoStore } from './infoStore.ts'
import { INFO_HORIZON_MS, Poller } from './poller.ts'
import type { FetchResult, Source } from './sources/types.ts'
import { SampleStore } from './store.ts'

// adsb.lol envelope, 7 aircraft incl. 000001 (dbFlags 8 = LADD) and ~a330e6 (TIS-B)
const BODY = readFileSync(new URL('../data/fixtures/golden/adsblol-point-ksfo.json', import.meta.url), 'utf8')
const T0 = 1_000_000
const LLBG = [32.0114, 34.8867] as const

function setup(hideFlagged: boolean, body = BODY) {
  const clock = { t: T0 }
  const answer = { body }
  const reply = (): Promise<FetchResult> => {
    const b = answer.body
    return Promise.resolve({ url: 'fake:circle', status: 200, tSendMs: clock.t - 40, tRecvMs: clock.t, bytes: b.length, body: b, retryAfterS: null, snapshot: normalizeAdsblol(b) })
  }
  const source: Source = {
    caps: { kind: 'adsblol', fullSnapshot: false, maxRps: 1, coverage: null, attribution: 'test' },
    circle: reply,
    hexes: reply,
    all: () => Promise.reject(new Error('unsupported')),
  }
  const store = new SampleStore()
  const info = new InfoStore({ nowMs: () => clock.t })
  const poller = new Poller(source, store, new TokenBucket(100, () => clock.t, () => 0), {
    cellPeriodMs: 3000,
    chasePeriodMs: 1000,
    fullSnapshotPeriodMs: 1000,
    interestTtlMs: 600_000,
    chaseTtlMs: 10_000,
    recorder: null,
    hideFlagged,
    nowMs: () => clock.t,
    info,
  })
  poller.touchView(LLBG[0], LLBG[1], 5) // one cell
  return { clock, answer, store, info, poller }
}

test('every non-hidden aircraft goes to the InfoStore with rxMs = the answer receive time', async () => {
  const s = setup(true)
  s.clock.t = T0 + 250
  assert.equal(await s.poller.tick(), true)
  assert.equal(s.info.size, 6)
  assert.equal(s.info.get('000001'), null, 'LADD stays hidden')
  assert.equal(s.info.get('~a330e6')?.hex, '~a330e6')
  assert.equal(s.info.get('a1c7e4')?.callsign, 'UAL872')
  assert.equal(s.info.raw('a1c7e4')?.t, 'B77W')
  assert.equal(s.info.rxMs('a1c7e4'), T0 + 250)

  const shown = setup(false)
  await shown.poller.tick()
  assert.equal(shown.info.size, 7)
  assert.equal(shown.info.get('000001')?.hex, '000001')
})

test('an aircraft without a position still gets its info (the table can show it once a position arrives)', async () => {
  const body = JSON.stringify({ now: 1_790_000_000_000, ac: [{ hex: 'abc123', type: 'adsb_icao', flight: 'ELY1  ', t: 'B738', squawk: '1000', seen: 0.5, messages: 12, mlat: [], tisb: [], rssi: -20 }] })
  const s = setup(true, body)
  await s.poller.tick()
  assert.equal(s.store.size, 0)
  assert.equal(s.info.get('abc123')?.callsign, 'ELY1')
})

test('the InfoStore is pruned on each good answer with the sample horizon', async () => {
  assert.equal(INFO_HORIZON_MS, 180_000)
  const s = setup(true)
  await s.poller.tick()
  assert.equal(s.info.size, 6)
  s.answer.body = JSON.stringify({ now: 1_790_000_000_000, ac: [] })
  s.clock.t = T0 + INFO_HORIZON_MS
  await s.poller.tick()
  assert.equal(s.info.size, 6, 'exactly at the horizon is kept')
  s.clock.t += 20_000 // the area answered empty: next asked after 4 × its 5 s period
  await s.poller.tick()
  assert.equal(s.info.size, 0)
})

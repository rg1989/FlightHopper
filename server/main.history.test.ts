// server/main.history.test.ts
// The past over HTTP: /api/history, /api/history/status and /api/trace on the real server (port 0), with adsb.lol's
// files from a fake fetch. A replay server never fetches the past by itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HistorySlot, HistoryStatus, TraceReply } from '../shared/api.ts'
import { SLOT_MS, newestSlotMs } from '../shared/history.ts'
import { readServerConfig } from './config.ts'
import { encodeHeatmap } from './heatmap.ts'
import { createServer } from './main.ts'
import { makeReplay } from './sources/replay.ts'

const FILE = fileURLToPath(new URL('../data/fixtures/golden/recording-sample.jsonl', import.meta.url))
const T0 = 2_000_000_000_000 // the injected server clock (2033)
const SLOT = newestSlotMs(T0) - SLOT_MS // a published half hour, not one of the newest two
const DAY = new Date(SLOT).toISOString().slice(0, 10).replaceAll('-', '/')

/** adsb.lol as a fake fetch: one heatmap file and one aircraft's live trace; everything else 404. */
function upstream() {
  const urls: string[] = []
  const heat = encodeHeatmap([
    { tMs: SLOT, records: [{ hex: '4691c4', lat: 32.3, lon: 34.6, alt: 6000, gs: 280 }, { hex: '4691c4', callsign: 'AEE4266', squawk: '1234' }, { hex: 'a1b2c3', lat: 40, lon: 10, alt: 'g', gs: null }] },
    { tMs: SLOT + 10_000, records: [{ hex: '4691c4', lat: 32.29, lon: 34.63, alt: 5900, gs: 279 }] },
  ])
  const trace = { icao: '4691c4', r: 'SX-DND', t: 'A320', timestamp: T0 / 1000 - 600, trace: [[0, 32.4, 34.3, 9000, 300, 110, 2, -800, { flight: 'AEE4266 ' }], [300, 32.3, 34.6, 6000, 280, 112, 0, -700, null]] }
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input)
    urls.push(url)
    if (url.endsWith(`/globe_history/${DAY}/heatmap/${String(new Date(SLOT).getUTCHours() * 2 + (new Date(SLOT).getUTCMinutes() >= 30 ? 1 : 0)).padStart(2, '0')}.bin.ttf`)) return new Response(heat.buffer as ArrayBuffer)
    if (url.endsWith('/data/traces/c4/trace_full_4691c4.json')) return new Response(JSON.stringify(trace))
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { urls, fetchFn }
}

async function get<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url)
  return { status: res.status, body: (await res.json()) as T }
}

test('the past over HTTP: a half hour in a circle, what is held, an aircraft\'s leg; 404 where there is none, 400 for bad asks', async (t) => {
  const nowMs = (): number => T0
  const cfg = { ...readServerConfig({ REPLAY_FILES: FILE }), staticDir: join(mkdtempSync(join(tmpdir(), 'fh-hist-')), 'dist') }
  const up = upstream()
  const app = createServer(cfg, { source: makeReplay({ files: cfg.replayFiles, nowMs }), nowMs, historyFetch: up.fetchFn })
  const base = await app.listen(0)
  t.after(() => app.close())
  assert.equal(up.urls.length, 0, 'a replay server fetches no past by itself')

  const slot = await get<HistorySlot>(`${base}/api/history?slot=${SLOT}&lat=32&lon=34.8&nm=60`)
  assert.equal(slot.status, 200)
  assert.equal(slot.body.slotMs, SLOT)
  assert.equal(slot.body.stepS, 10)
  assert.deepEqual(slot.body.aircraft.map((a) => [a.hex, a.callsign, a.squawk, a.t, a.alt]), [['4691c4', 'AEE4266', '1234', [0, 10], [6000, 5900]]])
  const missing = await get<{ error: string }>(`${base}/api/history?slot=${SLOT - SLOT_MS}&lat=32&lon=34.8&nm=60`)
  assert.equal(missing.status, 404)

  const st = await get<HistoryStatus>(`${base}/api/history/status`)
  assert.equal(st.status, 200)
  assert.equal(st.body.newestSlotMs, newestSlotMs(T0))
  assert.deepEqual(st.body.slots.map((s) => [s.slotMs, s.state]), [[SLOT - SLOT_MS, 'missing'], [SLOT, 'ready']])

  const leg = await get<TraceReply>(`${base}/api/trace?hex=4691c4`)
  assert.equal(leg.status, 200)
  assert.deepEqual([leg.body.callsign, leg.body.reg, leg.body.typeCode, leg.body.t, leg.body.alt, leg.body.origin], ['AEE4266', 'SX-DND', 'A320', [0, 300], [9000, 6000], null])
  assert.equal((await get(`${base}/api/trace?hex=abcdef`)).status, 404)

  for (const bad of [`/api/history?slot=${SLOT + 1}&lat=32&lon=34.8&nm=60`, `/api/history?slot=${SLOT}&lat=91&lon=0&nm=60`, `/api/history?slot=${SLOT}&lat=0&lon=0&nm=0`,
    `/api/history?slot=${SLOT}&lat=0&lon=0&nm=6000`, '/api/history?lat=0&lon=0&nm=60', '/api/trace?hex=xyz', '/api/trace?hex=4691c4&at=soon']) {
    assert.equal((await get(base + bad)).status, 400, bad)
  }
})

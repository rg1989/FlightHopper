// client/ui/sourceBadge.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import type { StatusBrief } from '../../shared/api.ts'

// sourceBadge.ts imports its CSS for Vite; Node loads every .css as an empty module (this test's process only).
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { flightCredit, sourceView } = await import('./sourceBadge.ts')

const st = (o: Partial<StatusBrief>): StatusBrief => ({ source: 'adsbfi', degraded: null, cellPeriodP95S: null, chasePeriodP95S: null, ...o })

test('live: source name linked, loading areas counted', () => {
  assert.deepEqual(sourceView(st({}), 0), { text: 'LIVE · adsb.fi', title: 'Live flight data from adsb.fi', state: 'live', href: 'https://adsb.fi' })
  assert.equal(sourceView(st({ pendingAreas: 12 }), 0).text, 'LIVE · adsb.fi · loading 12 areas')
  assert.equal(sourceView(st({ pendingAreas: 1 }), 0).text, 'LIVE · adsb.fi · loading 1 area')
  assert.equal(sourceView(st({ source: 'readsb' }), 0).href, null)
  assert.equal(sourceView(st({ degraded: 'rate-limited' }), 0).state, 'trouble')
  assert.equal(sourceView(st({ degraded: 'rate-limited', pendingAreas: 5 }), 0).text, 'SLOWED · adsb.fi', 'no frozen loading count')
  assert.equal(sourceView(st({ degraded: 'upstream-down', pendingAreas: 5 }), 0).text, 'NO DATA · adsb.fi', 'not LIVE when nothing comes')
})

test('replay: says REPLAY with the recording time, never LIVE', () => {
  const v = sourceView(st({ source: 'replay', upstreamOffsetMs: 3_600_000 }), Date.UTC(2026, 8, 23, 7, 12))
  assert.equal(v.text, 'REPLAY · 2026-09-23 06:12 UTC')
  assert.equal(v.state, 'replay')
  assert.equal(sourceView(st({ source: 'replay' }), null).text, 'REPLAY')
})

test('credit line per source', () => {
  assert.match(flightCredit('adsbfi'), /adsb\.fi/)
  assert.match(flightCredit('adsblol'), /adsb\.lol.*ODbL/)
})

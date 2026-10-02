// client/ui/sourceBadge.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import type { StatusBrief } from '../../shared/api.ts'

// sourceBadge.ts imports its CSS for Vite; Node loads every .css as an empty module (this test's process only).
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { panelView, sourceView } = await import('./sourceBadge.ts')

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

test('panelView, live: the mode, the linked source, the refresh and the coverage, as the panel always said them', () => {
  assert.deepEqual(panelView(null, null), {
    dot: 'wait', mode: 'Connecting…', source: null, refresh: '—', coverage: { text: '—', loading: false },
  })
  assert.deepEqual(panelView(st({}), 0), {
    dot: 'live', mode: 'Live traffic', source: { name: 'adsb.fi', href: 'https://adsb.fi', title: '' }, refresh: '—',
    coverage: { text: 'Up to date', loading: false },
  })
  assert.deepEqual(panelView(st({ source: 'readsb' }), 0).source, { name: 'own receiver', href: null, title: '' }, 'named, not linked')
  assert.equal(panelView(st({ viewEveryS: 13.4 }), 0).refresh, 'every 13 s')
  assert.equal(panelView(st({ viewEveryS: 59 }), 0).refresh, 'every 59 s')
  assert.equal(panelView(st({ viewEveryS: 600 }), 0).refresh, 'every 10 min')
  assert.deepEqual(panelView(st({ pendingAreas: 12 }), 0).coverage, { text: 'Loading 12 areas', loading: true })
  assert.deepEqual(panelView(st({ pendingAreas: 1 }), 0).coverage, { text: 'Loading 1 area', loading: true })
})

test('panelView, live: trouble says what is wrong and drops the frozen loading count; a recording says Replay with its time', () => {
  const slowed = panelView(st({ degraded: 'rate-limited', pendingAreas: 5 }), 0)
  assert.deepEqual([slowed.dot, slowed.mode, slowed.coverage], ['trouble', 'The flight-data source is rate-limited', { text: 'Waiting for the source', loading: false }])
  const rec = panelView(st({ source: 'replay', upstreamOffsetMs: 3_600_000 }), Date.UTC(2026, 8, 23, 7, 12))
  assert.deepEqual([rec.dot, rec.mode, rec.source], ['replay', 'Replay · 2026-09-23 06:12 UTC', { name: 'recording', href: null, title: '' }])
  assert.equal(panelView(st({ source: 'replay' }), null).mode, 'Replay')
})

test('panelView, History: Replay from adsb.lol, linked with its licence, no refresh period, the replay\'s amber dot', () => {
  const v = panelView(st({}), 0, { loading: false })
  // The tooltip's wording may grow (more credits); it must keep naming the source and the ODbL 1.0 it is owed under.
  assert.match(v.source?.title ?? '', /adsb\.lol.*ODbL 1\.0/)
  assert.deepEqual(v, {
    dot: 'replay',
    mode: 'Replay',
    source: { name: 'adsb.lol', href: 'https://adsb.lol', title: v.source?.title ?? '' },
    refresh: '—',
    coverage: { text: '—', loading: false },
  })
})

test('panelView, History: the loader and "Loading" while it loads, dashes otherwise', () => {
  assert.deepEqual(panelView(st({}), 0, { loading: true }).coverage, { text: 'Loading', loading: true })
  assert.deepEqual(panelView(st({}), 0, { loading: false }).coverage, { text: '—', loading: false })
})

test('panelView, History: the live status, still coming, changes nothing; null is live again', () => {
  const quiet = panelView(null, null, { loading: false })
  const comings = [
    st({}),
    st({ pendingAreas: 12, viewEveryS: 13 }),
    st({ degraded: 'upstream-down', pendingAreas: 5 }),
    st({ source: 'readsb', viewEveryS: 600 }),
    st({ source: 'replay', upstreamOffsetMs: 3_600_000 }),
  ]
  for (const s of comings) assert.deepEqual(panelView(s, Date.UTC(2026, 8, 23, 7, 12), { loading: false }), quiet, JSON.stringify(s))
  for (const s of comings) assert.deepEqual(panelView(s, 0, { loading: true }), panelView(null, null, { loading: true }), JSON.stringify(s))
  assert.equal(panelView(st({}), 0, null).mode, 'Live traffic', 'the next update paints the live feed again')
  assert.deepEqual(panelView(st({}), 0), panelView(st({}), 0, null))
})

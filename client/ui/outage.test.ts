// client/ui/outage.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { FAILS_DOWN, OUTAGE_COPY, agoText, outageFor } = await import('./outage.ts')

const ok = { online: true, failedPolls: 0, degraded: null, inScenario: false } as const

test('outageFor: the most basic cause first; nothing in a scenario or when all is well', () => {
  assert.equal(outageFor(ok), null)
  assert.equal(outageFor({ ...ok, online: false, failedPolls: 9, degraded: 'blocked' }), 'offline')
  assert.equal(outageFor({ ...ok, failedPolls: FAILS_DOWN - 1 }), null) // a failed poll or two is a blip
  assert.equal(outageFor({ ...ok, failedPolls: FAILS_DOWN, degraded: 'blocked' }), 'server')
  assert.equal(outageFor({ ...ok, degraded: 'blocked' }), 'blocked')
  assert.equal(outageFor({ ...ok, degraded: 'upstream-down' }), 'down')
  assert.equal(outageFor({ ...ok, degraded: 'rate-limited' }), 'slowed')
  assert.equal(outageFor({ ...ok, online: false, inScenario: true }), null)
})

test('the copy names the source where it matters, and every kind has all of it', () => {
  assert.equal(OUTAGE_COPY.down.title('adsb.fi'), 'adsb.fi isn’t answering')
  for (const c of Object.values(OUTAGE_COPY)) for (const t of [c.title('x'), c.body('x'), c.pill('x')]) assert.ok(t.length > 5)
})

test('agoText: just now, seconds, minutes, hours', () => {
  assert.equal(agoText(2000), 'just now')
  assert.equal(agoText(42_000), '42 s ago')
  assert.equal(agoText(5 * 60_000), '5 min ago')
  assert.equal(agoText(3 * 3_600_000), '3 h ago')
  assert.equal(agoText(-5), 'just now')
})

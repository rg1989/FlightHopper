// client/ui/imageryBadge.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// imageryBadge.ts imports its CSS for Vite; Node loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { badgeView } = await import('./imageryBadge.ts')

test('badgeView: Esri green, EOX standing in for Esri amber with the reason, a chosen source grey', () => {
  assert.deepEqual(
    { ...badgeView({ source: 'esri', fallback: null }), title: undefined },
    { text: 'Imagery: Esri', state: 'ok', title: undefined },
  )
  const fb = badgeView({ source: 'eox', fallback: 'Esri HTTP 498' })
  assert.equal(fb.text, 'Imagery: EOX · Esri HTTP 498')
  assert.equal(fb.state, 'fallback')
  assert.match(fb.title, /10 m/)
  assert.equal(badgeView({ source: 'eox', fallback: 'no key' }).text, 'Imagery: EOX · no key')
  assert.deepEqual([badgeView({ source: 'eox', fallback: null }).state, badgeView({ source: 'eox', fallback: null }).text], ['plain', 'Imagery: EOX'])
  assert.equal(badgeView({ source: 'ion', fallback: null }).text, 'Imagery: Bing')
})

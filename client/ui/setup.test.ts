// client/ui/setup.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// setup.ts imports its CSS for Vite. Node cannot load CSS, so this test process loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { GUIDES, SETUP_KEY, setupDue, setupSummary, withoutSetup } = await import('./setup.ts')

function storage(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init))
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } as Storage
}
const NONE = { arcgis: 'none', ion: 'none' } as const

test('setupDue: once in a browser that still lacks a key', () => {
  assert.equal(setupDue(storage(), NONE, ''), true)
  assert.equal(setupDue(storage(), { arcgis: 'env', ion: 'none' }, '?hex=4b1806&chase=1'), true)
  assert.equal(setupDue(storage({ [SETUP_KEY]: '1' }), NONE, ''), false, 'already seen')
  assert.equal(setupDue(storage(), { arcgis: 'env', ion: 'saved' }, ''), false, 'nothing left to set')
})

test('setupDue: never on the TV kiosk, nor where storage is blocked (it could not be remembered)', () => {
  assert.equal(setupDue(storage(), NONE, '?tv=1'), false)
  assert.equal(setupDue(null, NONE, ''), false)
  const blocked = { getItem: () => { throw new Error('blocked') } } as unknown as Storage
  assert.equal(setupDue(blocked, NONE, ''), false)
})

test('setupDue: ?setup=1 opens it whatever was seen, ?setup=0 keeps it shut', () => {
  assert.equal(setupDue(storage({ [SETUP_KEY]: '1' }), { arcgis: 'env', ion: 'saved' }, '?setup=1'), true)
  assert.equal(setupDue(null, NONE, '?tv=1&setup=1'), true)
  assert.equal(setupDue(storage(), NONE, '?setup=0'), false)
})

test('setupSummary: what each key gives, and the keyless source without it', () => {
  assert.deepEqual(setupSummary(NONE), { imagery: 'EOX Sentinel-2, 10 m (no key)', terrain: 'Re:Earth terrain (no key)' })
  assert.deepEqual(setupSummary({ arcgis: 'saved', ion: 'none' }), { imagery: 'Esri World Imagery', terrain: 'Re:Earth terrain (no key)' })
  assert.deepEqual(setupSummary({ arcgis: 'none', ion: 'env' }), { imagery: 'Bing imagery via Cesium ion', terrain: 'Cesium World Terrain' })
  assert.deepEqual(setupSummary({ arcgis: 'env', ion: 'saved' }), { imagery: 'Esri World Imagery', terrain: 'Cesium World Terrain' })
})

test('GUIDES: every link is https and on its provider\'s own site', () => {
  const host = { arcgis: /(^|\.)arcgis\.com$/, ion: /(^|\.)cesium\.com$/ } as const
  for (const id of ['arcgis', 'ion'] as const) {
    const links = GUIDES[id].steps.filter((s) => s.href !== undefined)
    assert.ok(links.length >= 2, `${id}: a sign-up link and a link to where the key is made`)
    for (const s of links) {
      const u = new URL(s.href!)
      assert.equal(u.protocol, 'https:')
      assert.match(u.hostname, host[id])
      assert.ok(s.link, 'a link has its text')
    }
  }
})

test('withoutSetup: the closed guide takes ?setup= out of the address, so a reload does not open it again', () => {
  assert.equal(withoutSetup('?setup=1'), '')
  assert.equal(withoutSetup('?hex=4b1806&setup=1&chase=1'), '?hex=4b1806&chase=1')
  assert.equal(withoutSetup('?hex=4b1806'), '?hex=4b1806')
  assert.equal(withoutSetup(''), '')
})

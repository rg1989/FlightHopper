// client/ui/scenePrefs.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ScenePrefs } from '../types.ts'
import { DEFAULT_PREFS, PREFS_KEY, readScenePrefs, writeScenePrefs } from './scenePrefs.ts'

const OFF_ON: ScenePrefs = { topo: false, light: true, glass: false }

test('nothing stored, nothing in the URL → both on; the key is fh.scene.v1', () => {
  assert.equal(PREFS_KEY, 'fh.scene.v1')
  assert.deepEqual(DEFAULT_PREFS, { topo: true, light: true, glass: false })
  assert.deepEqual(readScenePrefs('', null), { topo: true, light: true, glass: false })
  assert.deepEqual(readScenePrefs('?hex=4691c4&bench=1', null), { topo: true, light: true, glass: false })
  const a = readScenePrefs('', null)
  a.topo = false // the caller owns what it gets back
  assert.deepEqual(readScenePrefs('', null), { topo: true, light: true, glass: false })
  assert.throws(() => (DEFAULT_PREFS.topo = false), TypeError) // shared: frozen
  assert.deepEqual(DEFAULT_PREFS, { topo: true, light: true, glass: false })
})

test('the stored JSON wins over the defaults', () => {
  assert.deepEqual(readScenePrefs('', '{"topo":false,"light":true}'), OFF_ON)
  assert.deepEqual(readScenePrefs('', '{"topo":true,"light":false}'), { topo: true, light: false, glass: false })
  assert.deepEqual(readScenePrefs('', '{"topo":false,"light":false}'), { topo: false, light: false, glass: false })
})

test('?topo=0|1 and ?light=0|1 win over the stored JSON, with or without the leading ?', () => {
  const stored = '{"topo":false,"light":false}'
  assert.deepEqual(readScenePrefs('?topo=1', stored), { topo: true, light: false, glass: false })
  assert.deepEqual(readScenePrefs('?light=1', stored), { topo: false, light: true, glass: false })
  assert.deepEqual(readScenePrefs('topo=1&light=1', stored), { topo: true, light: true, glass: false })
  assert.deepEqual(readScenePrefs('?hex=4691c4&topo=0', null), OFF_ON)
  assert.deepEqual(readScenePrefs('?light=0&airport=LOWI', '{"topo":true,"light":true}'), { topo: true, light: false, glass: false })
  assert.deepEqual(readScenePrefs('?topo=0&topo=1', null), OFF_ON) // the first one counts, as URLSearchParams.get
})

test('URL values other than 0 and 1 are ignored: the stored value or the default stands', () => {
  for (const v of ['', 'false', 'true', 'off', 'no', ' 0', '00', 'TRUE']) {
    assert.deepEqual(readScenePrefs(`?topo=${v}&light=${v}`, '{"topo":false,"light":true}'), OFF_ON, `?topo=${v}`)
    assert.deepEqual(readScenePrefs(`?topo=${v}`, null), { topo: true, light: true, glass: false }, `?topo=${v}`)
  }
  assert.deepEqual(readScenePrefs('?TOPO=0&Light=0', null), { topo: true, light: true, glass: false }) // names are case-sensitive
})

test('corrupt or partial stored JSON falls back per field, never throws', () => {
  for (const bad of ['', 'not json', '{"topo":', 'null', '42', '"topo"', 'true', '[false,false]', '{}']) {
    assert.deepEqual(readScenePrefs('', bad), { topo: true, light: true, glass: false }, bad)
  }
  assert.deepEqual(readScenePrefs('', '{"topo":false}'), OFF_ON)
  assert.deepEqual(readScenePrefs('', '{"light":false}'), { topo: true, light: false, glass: false })
  // Only real booleans count: 0, "false" or null from an older or hand-edited value are not "off".
  assert.deepEqual(readScenePrefs('', '{"topo":0,"light":"false"}'), { topo: true, light: true, glass: false })
  assert.deepEqual(readScenePrefs('', '{"topo":null,"light":false,"shadow":true}'), { topo: true, light: false, glass: false })
  assert.deepEqual(readScenePrefs('?topo=0', 'not json'), OFF_ON) // the URL still applies over a corrupt value
})

test('writeScenePrefs stores the three fields as JSON under fh.scene.v1, and readScenePrefs reads them back', () => {
  const store = new Map<string, string>()
  const storage = { setItem: (k: string, v: string): void => void store.set(k, v) }
  writeScenePrefs({ ...OFF_ON, extra: 1 } as ScenePrefs, storage)
  assert.deepEqual([...store.keys()], [PREFS_KEY])
  assert.equal(store.get(PREFS_KEY), '{"topo":false,"light":true,"glass":false}')
  for (const topo of [false, true]) {
    for (const light of [false, true]) {
      writeScenePrefs({ topo, light, glass: topo }, storage)
      assert.deepEqual(readScenePrefs('', store.get(PREFS_KEY) ?? null), { topo, light, glass: topo })
    }
  }
})

test('writeScenePrefs never throws: no storage, private mode, a full quota', () => {
  assert.doesNotThrow(() => writeScenePrefs(OFF_ON, null))
  let calls = 0
  const failing = (name: string) => ({
    setItem: (): void => {
      calls++
      throw new DOMException('refused', name)
    },
  })
  assert.doesNotThrow(() => writeScenePrefs(OFF_ON, failing('QuotaExceededError')))
  assert.doesNotThrow(() => writeScenePrefs(OFF_ON, failing('SecurityError')))
  assert.equal(calls, 2) // it did try
})

test('glass (see-through buildings): off by default, ?glass=1 or the stored field turns it on, and it is stored', () => {
  assert.equal(readScenePrefs('', null).glass, false)
  assert.equal(readScenePrefs('?glass=1', null).glass, true)
  assert.equal(readScenePrefs('', '{"topo":true,"light":true,"glass":true}').glass, true)
  assert.equal(readScenePrefs('?glass=0', '{"glass":true}').glass, false)
  let saved = ''
  writeScenePrefs({ topo: true, light: false, glass: true }, { setItem: (_k: string, v: string) => void (saved = v) })
  assert.deepEqual(JSON.parse(saved), { topo: true, light: false, glass: true })
})

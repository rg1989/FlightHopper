// client/ui/scenePrefs.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ScenePrefs } from '../types.ts'
import { DEFAULT_PREFS, PREFS_KEY, readScenePrefs, writeScenePrefs } from './scenePrefs.ts'

const OFF_ON: ScenePrefs = { ...DEFAULT_PREFS, topo: false, light: true, glass: false }

test('nothing stored, nothing in the URL → both on; the key is fh.scene.v1', () => {
  assert.equal(PREFS_KEY, 'fh.scene.v1')
  assert.deepEqual(DEFAULT_PREFS, { ...DEFAULT_PREFS, topo: true, light: true, glass: false })
  assert.deepEqual(readScenePrefs('', null), { ...DEFAULT_PREFS, topo: true, light: true, glass: false })
  assert.deepEqual(readScenePrefs('?hex=4691c4&bench=1', null), { ...DEFAULT_PREFS, topo: true, light: true, glass: false })
  const a = readScenePrefs('', null)
  a.topo = false // the caller owns what it gets back
  assert.deepEqual(readScenePrefs('', null), { ...DEFAULT_PREFS, topo: true, light: true, glass: false })
  assert.throws(() => (DEFAULT_PREFS.topo = false), TypeError) // shared: frozen
  assert.deepEqual(DEFAULT_PREFS, { ...DEFAULT_PREFS, topo: true, light: true, glass: false })
})

test('the stored JSON wins over the defaults', () => {
  assert.deepEqual(readScenePrefs('', '{"topo":false,"light":true}'), OFF_ON)
  assert.deepEqual(readScenePrefs('', '{"topo":true,"light":false}'), { ...DEFAULT_PREFS, topo: true, light: false, glass: false })
  assert.deepEqual(readScenePrefs('', '{"topo":false,"light":false}'), { ...DEFAULT_PREFS, topo: false, light: false, glass: false })
})

test('?topo=0|1 and ?light=0|1 win over the stored JSON, with or without the leading ?', () => {
  const stored = '{"topo":false,"light":false}'
  assert.deepEqual(readScenePrefs('?topo=1', stored), { ...DEFAULT_PREFS, topo: true, light: false, glass: false })
  assert.deepEqual(readScenePrefs('?light=1', stored), { ...DEFAULT_PREFS, topo: false, light: true, glass: false })
  assert.deepEqual(readScenePrefs('topo=1&light=1', stored), { ...DEFAULT_PREFS, topo: true, light: true, glass: false })
  assert.deepEqual(readScenePrefs('?hex=4691c4&topo=0', null), OFF_ON)
  assert.deepEqual(readScenePrefs('?light=0&airport=LOWI', '{"topo":true,"light":true}'), { ...DEFAULT_PREFS, topo: true, light: false, glass: false })
  assert.deepEqual(readScenePrefs('?topo=0&topo=1', null), OFF_ON) // the first one counts, as URLSearchParams.get
})

test('URL values other than 0 and 1 are ignored: the stored value or the default stands', () => {
  for (const v of ['', 'false', 'true', 'off', 'no', ' 0', '00', 'TRUE']) {
    assert.deepEqual(readScenePrefs(`?topo=${v}&light=${v}`, '{"topo":false,"light":true}'), OFF_ON, `?topo=${v}`)
    assert.deepEqual(readScenePrefs(`?topo=${v}`, null), { ...DEFAULT_PREFS, topo: true, light: true, glass: false }, `?topo=${v}`)
  }
  assert.deepEqual(readScenePrefs('?TOPO=0&Light=0', null), { ...DEFAULT_PREFS, topo: true, light: true, glass: false }) // names are case-sensitive
})

test('corrupt or partial stored JSON falls back per field, never throws', () => {
  for (const bad of ['', 'not json', '{"topo":', 'null', '42', '"topo"', 'true', '[false,false]', '{}']) {
    assert.deepEqual(readScenePrefs('', bad), { ...DEFAULT_PREFS, topo: true, light: true, glass: false }, bad)
  }
  assert.deepEqual(readScenePrefs('', '{"topo":false}'), OFF_ON)
  assert.deepEqual(readScenePrefs('', '{"light":false}'), { ...DEFAULT_PREFS, topo: true, light: false, glass: false })
  // Only real booleans count: 0, "false" or null from an older or hand-edited value are not "off".
  assert.deepEqual(readScenePrefs('', '{"topo":0,"light":"false"}'), { ...DEFAULT_PREFS, topo: true, light: true, glass: false })
  assert.deepEqual(readScenePrefs('', '{"topo":null,"light":false,"shadow":true}'), { ...DEFAULT_PREFS, topo: true, light: false, glass: false })
  assert.deepEqual(readScenePrefs('?topo=0', 'not json'), OFF_ON) // the URL still applies over a corrupt value
})

test('writeScenePrefs stores the three fields as JSON under fh.scene.v1, and readScenePrefs reads them back', () => {
  const store = new Map<string, string>()
  const storage = { setItem: (k: string, v: string): void => void store.set(k, v) }
  writeScenePrefs({ ...OFF_ON, extra: 1 } as ScenePrefs, storage)
  assert.deepEqual([...store.keys()], [PREFS_KEY])
  assert.deepEqual(JSON.parse(store.get(PREFS_KEY) ?? ''), { ...DEFAULT_PREFS, topo: false })
  for (const topo of [false, true]) {
    for (const light of [false, true]) {
      writeScenePrefs({ ...DEFAULT_PREFS, topo, light, glass: topo }, storage)
      assert.deepEqual(readScenePrefs('', store.get(PREFS_KEY) ?? null), { ...DEFAULT_PREFS, topo, light, glass: topo })
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
  writeScenePrefs({ ...DEFAULT_PREFS, topo: true, light: false, glass: true }, { setItem: (_k: string, v: string) => void (saved = v) })
  assert.deepEqual(JSON.parse(saved), { ...DEFAULT_PREFS, topo: true, light: false, glass: true })
})

test('map layers: street map top-down, satellite in the chase, no roads, no weather; the URL and storage set each', () => {
  assert.deepEqual(readScenePrefs('', null), { topo: true, light: true, glass: false, mapTop: true, mapChase: false, roads: false, wx: false })
  const p = readScenePrefs('?mapTop=0&mapChase=1&wx=1', '{"roads":true}')
  assert.deepEqual([p.mapTop, p.mapChase, p.roads, p.wx], [false, true, true, true])
})

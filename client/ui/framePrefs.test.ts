// client/ui/framePrefs.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FRAME_PREFS_KEY, MAX_SCALE, MIN_SCALE, NO_FRAME_PREFS, readFramePrefs, writeFramePrefs } from './framePrefs.ts'
import { DEFAULT_UNITS } from './units.ts'

const REST = { scale: {}, units: DEFAULT_UNITS }

test('nothing stored: every card in its place and shown; the key is fh.hudLayout.v1', () => {
  assert.equal(FRAME_PREFS_KEY, 'fh.hudLayout.v1')
  assert.deepEqual(readFramePrefs(null), { moved: {}, hidden: [], order: [], ...REST })
  assert.deepEqual(NO_FRAME_PREFS, { moved: {}, hidden: [], order: [], ...REST })
  assert.throws(() => ((NO_FRAME_PREFS.hidden as string[]).push('left')), TypeError) // shared: frozen
})

test('the stored layout reads back: the moved cards\' offsets and the hidden cards', () => {
  const p = readFramePrefs('{"moved":{"left":{"x":-0.9,"y":0.25},"top":{"x":0,"y":1.4}},"hidden":["bottom"]}')
  assert.deepEqual(p, { moved: { left: { x: -0.9, y: 0.25 }, top: { x: 0, y: 1.4 } }, hidden: ['bottom'], order: [], ...REST })
})

test('a moved card keeps the variant it had (v, its index); a foreign one is dropped, the offset kept', () => {
  const p = readFramePrefs('{"moved":{"left":{"x":-0.9,"y":0.25,"v":1},"right":{"x":1,"y":0,"v":0}}}')
  assert.deepEqual(p.moved, { left: { x: -0.9, y: 0.25, v: 1 }, right: { x: 1, y: 0, v: 0 } })
  for (const v of [-1, 1.5, 9, '1', null]) {
    assert.deepEqual(readFramePrefs(JSON.stringify({ moved: { top: { x: 0, y: 1, v } } })).moved, { top: { x: 0, y: 1 } }, String(v))
  }
})

test('the cards\' stacking, the last moved on top, reads back in order; unknown or repeated ids are dropped', () => {
  assert.deepEqual(readFramePrefs('{"order":["bottom","left"]}').order, ['bottom', 'left'])
  assert.deepEqual(readFramePrefs('{"order":["left","wing","left",3,"top"]}').order, ['left', 'top'])
  assert.deepEqual(readFramePrefs('{"order":"left"}').order, [])
  assert.deepEqual(readFramePrefs(null).order, [])
})

test('corrupt or foreign values fall back card by card, never throw', () => {
  for (const bad of ['', 'not json', '{"moved":', 'null', '42', '"left"', '[]', '{}', '{"moved":[],"hidden":{}}']) {
    assert.deepEqual(readFramePrefs(bad), { moved: {}, hidden: [], order: [], ...REST }, bad)
  }
  const p = readFramePrefs(JSON.stringify({
    moved: { left: { x: 'a', y: 0 }, right: { x: 0.8 }, top: { x: NaN, y: 1 }, bottom: { x: 99, y: 0 }, wing: { x: 1, y: 1 } },
    hidden: ['left', 'left', 'nose', 3, 'top'],
  }))
  assert.deepEqual(p, { moved: {}, hidden: ['left', 'top'], order: [], ...REST }, 'only known cards, finite offsets within reach, once')
  assert.deepEqual(readFramePrefs('{"moved":{"right":{"x":1.2,"y":-0.1,"z":4}}}').moved, { right: { x: 1.2, y: -0.1 } })
})

test('writeFramePrefs stores JSON under the key, and it reads back; storage errors are swallowed', () => {
  const store = new Map<string, string>()
  const storage = { setItem: (k: string, v: string): void => void store.set(k, v) }
  const p = { moved: { right: { x: 1.25, y: -0.5 } }, hidden: ['top' as const], order: ['right' as const], scale: { right: 1.4 }, units: { alt: 'ft+m' as const, speed: 'kmh' as const, vs: 'ms' as const } }
  writeFramePrefs(p, storage)
  assert.deepEqual(readFramePrefs(store.get(FRAME_PREFS_KEY) ?? null), p)
  writeFramePrefs(NO_FRAME_PREFS, storage)
  assert.deepEqual(readFramePrefs(store.get(FRAME_PREFS_KEY) ?? null), { moved: {}, hidden: [], order: [], ...REST })
  assert.doesNotThrow(() => writeFramePrefs(p, { setItem: () => { throw new Error('QuotaExceededError') } }))
  assert.doesNotThrow(() => writeFramePrefs(p, null))
})

test('scale: kept per card within MIN_SCALE…MAX_SCALE, 1 and junk dropped; units: each field checked', () => {
  const p = readFramePrefs(JSON.stringify({ scale: { left: 1.3, right: 9, top: 1, bottom: 'big', wing: 2 }, units: { alt: 'm', speed: 'furlongs' } }))
  assert.deepEqual(p.scale, { left: 1.3, right: MAX_SCALE })
  assert.deepEqual(p.units, { alt: 'm', speed: 'kt', vs: 'fpm' })
  assert.equal(readFramePrefs('{"scale":{"top":0.1}}').scale.top, MIN_SCALE)
})

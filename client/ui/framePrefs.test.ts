// client/ui/framePrefs.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FRAME_PREFS_KEY, NO_FRAME_PREFS, readFramePrefs, writeFramePrefs } from './framePrefs.ts'

test('nothing stored: every card in its place and shown; the key is fh.hudLayout.v1', () => {
  assert.equal(FRAME_PREFS_KEY, 'fh.hudLayout.v1')
  assert.deepEqual(readFramePrefs(null), { moved: {}, hidden: [] })
  assert.deepEqual(NO_FRAME_PREFS, { moved: {}, hidden: [] })
  assert.throws(() => ((NO_FRAME_PREFS.hidden as string[]).push('left')), TypeError) // shared: frozen
})

test('the stored layout reads back: the moved cards\' offsets and the hidden cards', () => {
  const p = readFramePrefs('{"moved":{"left":{"x":-0.9,"y":0.25},"top":{"x":0,"y":1.4}},"hidden":["bottom"]}')
  assert.deepEqual(p, { moved: { left: { x: -0.9, y: 0.25 }, top: { x: 0, y: 1.4 } }, hidden: ['bottom'] })
})

test('a moved card keeps the variant it had (v, its index); a foreign one is dropped, the offset kept', () => {
  const p = readFramePrefs('{"moved":{"left":{"x":-0.9,"y":0.25,"v":1},"right":{"x":1,"y":0,"v":0}}}')
  assert.deepEqual(p.moved, { left: { x: -0.9, y: 0.25, v: 1 }, right: { x: 1, y: 0, v: 0 } })
  for (const v of [-1, 1.5, 9, '1', null]) {
    assert.deepEqual(readFramePrefs(JSON.stringify({ moved: { top: { x: 0, y: 1, v } } })).moved, { top: { x: 0, y: 1 } }, String(v))
  }
})

test('corrupt or foreign values fall back card by card, never throw', () => {
  for (const bad of ['', 'not json', '{"moved":', 'null', '42', '"left"', '[]', '{}', '{"moved":[],"hidden":{}}']) {
    assert.deepEqual(readFramePrefs(bad), { moved: {}, hidden: [] }, bad)
  }
  const p = readFramePrefs(JSON.stringify({
    moved: { left: { x: 'a', y: 0 }, right: { x: 0.8 }, top: { x: NaN, y: 1 }, bottom: { x: 99, y: 0 }, wing: { x: 1, y: 1 } },
    hidden: ['left', 'left', 'nose', 3, 'top'],
  }))
  assert.deepEqual(p, { moved: {}, hidden: ['left', 'top'] }, 'only known cards, finite offsets within reach, once')
  assert.deepEqual(readFramePrefs('{"moved":{"right":{"x":1.2,"y":-0.1,"z":4}}}').moved, { right: { x: 1.2, y: -0.1 } })
})

test('writeFramePrefs stores JSON under the key, and it reads back; storage errors are swallowed', () => {
  const store = new Map<string, string>()
  const storage = { setItem: (k: string, v: string): void => void store.set(k, v) }
  const p = { moved: { right: { x: 1.25, y: -0.5 } }, hidden: ['top' as const] }
  writeFramePrefs(p, storage)
  assert.deepEqual(readFramePrefs(store.get(FRAME_PREFS_KEY) ?? null), p)
  writeFramePrefs(NO_FRAME_PREFS, storage)
  assert.deepEqual(readFramePrefs(store.get(FRAME_PREFS_KEY) ?? null), { moved: {}, hidden: [] })
  assert.doesNotThrow(() => writeFramePrefs(p, { setItem: () => { throw new Error('QuotaExceededError') } }))
  assert.doesNotThrow(() => writeFramePrefs(p, null))
})

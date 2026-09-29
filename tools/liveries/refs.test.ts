// tools/liveries/refs.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commonsMeta, mergeRefs } from './refs.ts'

test('refs: new photos are appended, a known file keeps its filled-in view', () => {
  const old = [{ file: 'a.jpg', view: 'left side', source: 's', author: 'x', licence: 'l' }]
  const added = [{ file: 'a.jpg', view: '?', source: 's', author: 'x', licence: 'l' }, { file: 'b.jpg', view: '?', source: 't', author: 'y', licence: 'm' }]
  assert.deepEqual(mergeRefs(old, added).map((r) => [r.file, r.view]), [['a.jpg', 'left side'], ['b.jpg', '?']])
})

test('refs: Commons metadata to plain text', () => {
  assert.deepEqual(commonsMeta({ LicenseShortName: { value: 'CC BY-SA 4.0' }, Artist: { value: '<a href="x">Anna  B</a>' }, DateTimeOriginal: { value: '2024-05-01 10:00' } }), ['CC BY-SA 4.0', 'Anna B', '2024-05-01'])
  assert.deepEqual(commonsMeta({}), ['unknown', 'unknown', ''])
})

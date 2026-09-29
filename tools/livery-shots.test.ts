// tools/livery-shots.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { labUrl, parsePair } from './livery-shots.ts'

test('pairs and lab URLs', () => {
  assert.deepEqual(parsePair('a21n:wzz'), ['a21n', 'WZZ'])
  assert.deepEqual(parsePair('b738:'), ['b738', null])
  assert.deepEqual(parsePair('b738:ely~A1'), ['b738', 'ELY~A1'])
  assert.throws(() => parsePair(':ELY'))
  assert.equal(labUrl('http://localhost:5182/', 'a21n', 'WZZ', 'refs'), 'http://localhost:5182/tools/livery-lab/?model=a21n&livery=WZZ&views=refs')
  assert.equal(labUrl('http://h', 'b738', null, 'all'), 'http://h/tools/livery-lab/?model=b738')
})

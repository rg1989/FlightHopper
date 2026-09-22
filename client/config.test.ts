// client/config.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readConfig } from './config.ts'

test('no env at all → keyless defaults (Re:Earth terrain, EOX imagery, /api)', () => {
  assert.deepEqual(readConfig({}), { terrain: 'reearth', imagery: 'eox', ionToken: null, apiBase: '/api' })
})

test('an ion token switches both defaults to ion', () => {
  assert.deepEqual(readConfig({ VITE_CESIUM_ION_TOKEN: 'tok' }), { terrain: 'ion', imagery: 'ion', ionToken: 'tok', apiBase: '/api' })
})

test('explicit choices win over the token-based defaults', () => {
  const c = readConfig({ VITE_CESIUM_ION_TOKEN: 'tok', VITE_TERRAIN: 'reearth', VITE_IMAGERY: 'none' })
  assert.equal(c.terrain, 'reearth')
  assert.equal(c.imagery, 'none')
  assert.equal(c.ionToken, 'tok')
  assert.equal(readConfig({ VITE_TERRAIN: 'ellipsoid' }).terrain, 'ellipsoid')
})

test('empty or blank values count as unset (Vite turns `VITE_X=` into "")', () => {
  assert.deepEqual(readConfig({ VITE_TERRAIN: '', VITE_IMAGERY: ' ', VITE_CESIUM_ION_TOKEN: '  ', VITE_API_BASE: '' }), readConfig({}))
  assert.equal(readConfig({ VITE_CESIUM_ION_TOKEN: ' tok ' }).ionToken, 'tok')
})

test('invalid values throw and name the variable', () => {
  assert.throws(() => readConfig({ VITE_TERRAIN: 'terrarium' }), /VITE_TERRAIN=terrarium/)
  assert.throws(() => readConfig({ VITE_IMAGERY: 'bing' }), /VITE_IMAGERY=bing/)
  assert.throws(() => readConfig({ VITE_TERRAIN: 'Ion', VITE_CESIUM_ION_TOKEN: 'tok' }), /ion \| reearth \| ellipsoid/)
})

test('ion without a token throws instead of silently using the Cesium evaluation token', () => {
  assert.throws(() => readConfig({ VITE_TERRAIN: 'ion' }), /VITE_CESIUM_ION_TOKEN/)
  assert.throws(() => readConfig({ VITE_IMAGERY: 'ion' }), /VITE_CESIUM_ION_TOKEN/)
})

test('apiBase: custom value kept, trailing slashes dropped', () => {
  assert.equal(readConfig({ VITE_API_BASE: 'https://fh.example.net/api/' }).apiBase, 'https://fh.example.net/api')
  assert.equal(readConfig({ VITE_API_BASE: '/api' }).apiBase, '/api')
})

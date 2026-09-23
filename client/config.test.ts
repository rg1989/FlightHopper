// client/config.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CesiumTerrainProvider, EllipsoidTerrainProvider, Ion, Resource, UrlTemplateImageryProvider } from 'cesium'
import { readConfig } from './config.ts'
import { EOX_ATTRIBUTION, makeImagery } from './scene/imagery.ts'
import { REEARTH_TERRAIN_URL, makeTerrain } from './scene/terrain.ts'

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

// Provider wiring for the branches that need no network. ion and reearth load in harness/viewer.html; the tests below
// check what they ask for, with Cesium's provider factories mocked (no request is made).
test('offline branches: ellipsoid terrain, no imagery', async () => {
  const cfg = readConfig({ VITE_TERRAIN: 'ellipsoid', VITE_IMAGERY: 'none' })
  assert.ok((await makeTerrain(cfg)) instanceof EllipsoidTerrainProvider)
  assert.equal(await makeImagery(cfg), null)
})

test('EOX imagery: Sentinel-2 cloudless WebMercator template, native zoom cap, attribution on screen', async () => {
  const p = await makeImagery(readConfig({}))
  assert.ok(p instanceof UrlTemplateImageryProvider)
  assert.equal(p.url, 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg')
  assert.equal(p.maximumLevel, 14)
  assert.equal(p.credit.showOnScreen, true)
  assert.match(p.credit.html, /by EOX IT Services GmbH \(Contains modified Copernicus Sentinel data 2025\)/)
  assert.equal(EOX_ATTRIBUTION, 'EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025)')
})

test('Re:Earth terrain: vertex normals, also in the URL query (their own browser-cache key), no water mask', async (t) => {
  const fake = new EllipsoidTerrainProvider()
  const fromUrl = t.mock.method(CesiumTerrainProvider, 'fromUrl', async () => fake)
  assert.equal(await makeTerrain(readConfig({})), fake)
  assert.equal(fromUrl.mock.callCount(), 1)
  const [url, options] = fromUrl.mock.calls[0].arguments
  assert.deepEqual(options, { requestVertexNormals: true })
  assert.ok(url instanceof Resource)
  // What CesiumTerrainProvider does with it: append a slash, derive layer.json, then each tile from its template.
  url.appendForwardSlash()
  assert.equal(url.getDerivedResource({ url: 'layer.json' }).url, `${REEARTH_TERRAIN_URL}/layer.json?extensions=octvertexnormals`)
  const tile = url.getDerivedResource({ url: '{z}/{x}/{y}.terrain', templateValues: { z: 14, x: 17416, y: 12493 } })
  assert.equal(tile.url, `${REEARTH_TERRAIN_URL}/14/17416/12493.terrain?extensions=octvertexnormals`)
})

test('ion terrain: Cesium World Terrain (asset 1) with vertex normals and no water mask, on the configured token', async (t) => {
  const fake = new EllipsoidTerrainProvider()
  const fromIon = t.mock.method(CesiumTerrainProvider, 'fromIonAssetId', async () => fake)
  const token = Ion.defaultAccessToken
  t.after(() => void (Ion.defaultAccessToken = token))
  assert.equal(await makeTerrain(readConfig({ VITE_CESIUM_ION_TOKEN: 'tok' })), fake)
  assert.equal(Ion.defaultAccessToken, 'tok')
  const [assetId, options] = fromIon.mock.calls[0].arguments
  assert.equal(assetId, 1)
  assert.equal(options?.requestVertexNormals, true)
  assert.equal(options?.requestWaterMask, false)
})

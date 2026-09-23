// client/config.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CesiumTerrainProvider, EllipsoidTerrainProvider, Ion, Resource, UrlTemplateImageryProvider } from 'cesium'
import { readConfig } from './config.ts'
import { ESRI_URL, EOX_ATTRIBUTION, makeImagery } from './scene/imagery.ts'
import { REEARTH_TERRAIN_URL, makeTerrain } from './scene/terrain.ts'

test('no env at all → keyless defaults (Re:Earth terrain, EOX imagery, /api)', () => {
  assert.deepEqual(readConfig({}), { terrain: 'reearth', imagery: 'eox', ionToken: null, arcgisKey: null, apiBase: '/api' })
})

test('an ion token switches both defaults to ion', () => {
  assert.deepEqual(readConfig({ VITE_CESIUM_ION_TOKEN: 'tok' }), { terrain: 'ion', imagery: 'ion', ionToken: 'tok', arcgisKey: null, apiBase: '/api' })
})

test('an ArcGIS key makes Esri the default imagery, ahead of ion (Bing via ion bans tracking use)', () => {
  assert.deepEqual(readConfig({ VITE_ARCGIS_KEY: 'key' }), { terrain: 'reearth', imagery: 'esri', ionToken: null, arcgisKey: 'key', apiBase: '/api' })
  const both = readConfig({ VITE_ARCGIS_KEY: 'key', VITE_CESIUM_ION_TOKEN: 'tok' })
  assert.equal(both.imagery, 'esri')
  assert.equal(both.terrain, 'ion')
  assert.equal(readConfig({ VITE_ARCGIS_KEY: 'key', VITE_IMAGERY: 'eox' }).imagery, 'eox')
})

test('esri without a key throws, like ion without a token', () => {
  assert.throws(() => readConfig({ VITE_IMAGERY: 'esri' }), /VITE_ARCGIS_KEY/)
})

test('explicit choices win over the token-based defaults', () => {
  const c = readConfig({ VITE_CESIUM_ION_TOKEN: 'tok', VITE_TERRAIN: 'reearth', VITE_IMAGERY: 'none' })
  assert.equal(c.terrain, 'reearth')
  assert.equal(c.imagery, 'none')
  assert.equal(c.ionToken, 'tok')
  assert.equal(readConfig({ VITE_TERRAIN: 'ellipsoid' }).terrain, 'ellipsoid')
})

test('empty or blank values count as unset (Vite turns `VITE_X=` into "")', () => {
  assert.deepEqual(readConfig({ VITE_TERRAIN: '', VITE_IMAGERY: ' ', VITE_CESIUM_ION_TOKEN: '  ', VITE_ARCGIS_KEY: ' ', VITE_API_BASE: '' }), readConfig({}))
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

test('Esri imagery: keyed World Imagery tiles, zoom 19 cap (0.3 m at LLBG), "Powered by Esri" + source on screen', async () => {
  const p = await makeImagery(readConfig({ VITE_ARCGIS_KEY: 'AAPT-k_1' }))
  assert.ok(p instanceof UrlTemplateImageryProvider)
  assert.equal(p.url, `${ESRI_URL}?token=AAPT-k_1`)
  assert.equal(p.maximumLevel, 19)
  assert.equal(p.credit.showOnScreen, true)
  assert.match(p.credit.html, /Powered by <a href="https:\/\/www\.esri\.com"[^>]*>Esri<\/a>/)
  assert.match(p.credit.html, /Source: Esri, Vantor, .*and the GIS User Community/)
})

test('Esri imagery: 404s (no deeper imagery there; Cesium keeps the parent tile) stay quiet, other tile errors are logged', async (t) => {
  const p = (await makeImagery(readConfig({ VITE_ARCGIS_KEY: 'key' })))!
  const warn = t.mock.method(console, 'warn', () => {})
  p.errorEvent.raiseEvent({ message: 'Failed to obtain image tile X: 1 Y: 2 Level: 19.', error: { statusCode: 404 } })
  assert.equal(warn.mock.callCount(), 0)
  p.errorEvent.raiseEvent({ message: 'Failed to obtain image tile X: 1 Y: 2 Level: 12.', error: { statusCode: 498 } })
  assert.equal(warn.mock.callCount(), 1)
  assert.match(String(warn.mock.calls[0].arguments[0]), /Level: 12/)
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

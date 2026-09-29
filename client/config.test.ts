// client/config.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CesiumTerrainProvider, EllipsoidTerrainProvider, ImageryLayer, ImageryLayerCollection, Ion, IonImageryProvider, Resource, UrlTemplateImageryProvider } from 'cesium'
import { KEYS_KEY, keySources, readConfig, readSavedKeys, writeSavedKeys } from './config.ts'
import { ESRI_URL, EOX_ATTRIBUTION, EOX_URL, eoxOnEsriFailure, imageryStatus, makeImagery } from './scene/imagery.ts'
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

test('saved keys (Settings) win over the env, key by key: saved > env > keyless', () => {
  const env = { VITE_ARCGIS_KEY: 'env-arcgis', VITE_CESIUM_ION_TOKEN: 'env-ion' }
  assert.deepEqual(readConfig(env, { arcgisKey: 'saved-arcgis', ionToken: 'saved-ion' }), {
    terrain: 'ion', imagery: 'esri', ionToken: 'saved-ion', arcgisKey: 'saved-arcgis', apiBase: '/api',
  })
  const one = readConfig(env, { ionToken: 'saved-ion' }) // the other key still comes from the env
  assert.deepEqual([one.arcgisKey, one.ionToken], ['env-arcgis', 'saved-ion'])
  assert.deepEqual(readConfig(env, {}), readConfig(env), 'none saved: the env as before')
  assert.deepEqual(readConfig({}, {}), readConfig({}), 'neither: keyless (Re:Earth terrain, EOX imagery)')
  assert.deepEqual(readConfig(env, { arcgisKey: '  ', ionToken: '' }), readConfig(env), 'blank saved values are unset')
})

test('a saved key alone switches the defaults as an env key would; explicit choices still win', () => {
  assert.deepEqual(readConfig({}, { arcgisKey: 'k' }), { terrain: 'reearth', imagery: 'esri', ionToken: null, arcgisKey: 'k', apiBase: '/api' })
  assert.deepEqual(readConfig({}, { ionToken: 't' }), { terrain: 'ion', imagery: 'ion', ionToken: 't', arcgisKey: null, apiBase: '/api' })
  assert.equal(readConfig({ VITE_IMAGERY: 'eox' }, { arcgisKey: 'k' }).imagery, 'eox')
  assert.equal(readConfig({ VITE_TERRAIN: 'ion' }, { ionToken: 't' }).terrain, 'ion', 'a saved token satisfies VITE_TERRAIN=ion')
})

test('keySources: where each key comes from, for the Settings dialog (saved > env > none)', () => {
  const env = { VITE_ARCGIS_KEY: 'env-arcgis', VITE_CESIUM_ION_TOKEN: ' ' }
  assert.deepEqual(keySources(env, {}), { arcgis: 'env', ion: 'none' })
  assert.deepEqual(keySources(env, { arcgisKey: 'a', ionToken: 't' }), { arcgis: 'saved', ion: 'saved' })
  assert.deepEqual(keySources({}, {}), { arcgis: 'none', ion: 'none' })
})

test('readSavedKeys: the stored JSON; corrupt, missing, blank or non-string values are unset, never a throw', () => {
  assert.deepEqual(readSavedKeys(JSON.stringify({ arcgisKey: ' a ', ionToken: 't' })), { arcgisKey: 'a', ionToken: 't' })
  assert.deepEqual(readSavedKeys(JSON.stringify({ arcgisKey: 'a' })), { arcgisKey: 'a' })
  for (const bad of [null, '', '{', 'null', '5', '"x"', '[1]', JSON.stringify({ arcgisKey: 7, ionToken: '  ' })]) {
    assert.deepEqual(readSavedKeys(bad), {}, String(bad))
  }
})

test('writeSavedKeys: JSON under fh.keys.v1, the entry removed when none is left; false where storage throws or is absent', () => {
  const store = new Map<string, string>()
  const storage = { setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }
  assert.equal(writeSavedKeys({ arcgisKey: 'a' }, storage), true)
  assert.deepEqual(readSavedKeys(store.get(KEYS_KEY) ?? null), { arcgisKey: 'a' })
  assert.equal(writeSavedKeys({}, storage), true)
  assert.equal(store.has(KEYS_KEY), false)
  const blocked = { setItem: () => { throw new Error('SecurityError') }, removeItem: () => { throw new Error('SecurityError') } }
  assert.equal(writeSavedKeys({ ionToken: 't' }, blocked), false)
  assert.equal(writeSavedKeys({ ionToken: 't' }, null), false)
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
  p.errorEvent.raiseEvent({ message: 'Failed to obtain image tile X: 1 Y: 2 Level: 19.', level: 19, error: { statusCode: 404 } })
  assert.equal(warn.mock.callCount(), 0)
  p.errorEvent.raiseEvent({ message: 'Failed to obtain image tile X: 1 Y: 2 Level: 12.', level: 12, error: { statusCode: 498 } })
  assert.equal(warn.mock.callCount(), 1)
  assert.match(String(warn.mock.calls[0].arguments[0]), /Level: 12/)
})

test('imageryStatus: EOX without a key is a fallback; Esri, or EOX chosen with a key, is not', () => {
  assert.deepEqual(imageryStatus(readConfig({ VITE_ARCGIS_KEY: 'key' })), { source: 'esri', fallback: null })
  assert.deepEqual(imageryStatus(readConfig({})), { source: 'eox', fallback: 'no key' })
  assert.deepEqual(imageryStatus(readConfig({ VITE_ARCGIS_KEY: 'key', VITE_IMAGERY: 'eox' })), { source: 'eox', fallback: null })
  assert.deepEqual(imageryStatus(readConfig({ VITE_IMAGERY: 'none' })), { source: 'none', fallback: null })
})

test('eoxOnEsriFailure: a 404 changes nothing; any other tile error puts EOX in Esri\'s place, once', async () => {
  const layers = new ImageryLayerCollection()
  const esri = layers.addImageryProvider((await makeImagery(readConfig({ VITE_ARCGIS_KEY: 'key' })))!)
  const street = layers.addImageryProvider(new UrlTemplateImageryProvider({ url: 'https://street.invalid/{z}/{x}/{y}.png' }))
  const swaps: [ImageryLayer, string][] = []
  eoxOnEsriFailure(layers, esri, (eox, why) => swaps.push([eox, why]))
  const provider = esri.imageryProvider
  const console_ = { warn: console.warn }
  console.warn = () => {} // makeImagery logs the non-404s
  try {
    provider.errorEvent.raiseEvent({ message: 'no tile', level: 19, error: { statusCode: 404 } })
    assert.equal(swaps.length, 0)
    assert.equal(layers.get(0), esri)
    provider.errorEvent.raiseEvent({ message: '5xx', level: 15, error: { statusCode: 503 } })
    provider.errorEvent.raiseEvent({ message: 'again', level: 15, error: { statusCode: 503 } })
  } finally {
    console.warn = console_.warn
  }
  assert.equal(swaps.length, 1)
  assert.equal(swaps[0][1], 'Esri HTTP 503')
  assert.equal(layers.length, 2)
  assert.equal(layers.get(0), swaps[0][0])
  assert.equal((layers.get(0).imageryProvider as UrlTemplateImageryProvider).url, EOX_URL)
  assert.equal(layers.get(1), street)
  assert.equal(layers.contains(esri), false)
})

test('eoxOnEsriFailure: no status (network down, or a JSON error where an image should be) reads "Esri unreachable"', async () => {
  for (const [error, level, want] of [[undefined, 5, 'Esri unreachable'], [{ statusCode: 500 }, 3, 'Esri HTTP 500']] as const) {
    const layers = new ImageryLayerCollection()
    const esri = layers.addImageryProvider((await makeImagery(readConfig({ VITE_ARCGIS_KEY: 'key' })))!)
    let why = ''
    eoxOnEsriFailure(layers, esri, (_eox, w) => (why = w))
    const warn = console.warn
    console.warn = () => {}
    try {
      esri.imageryProvider.errorEvent.raiseEvent({ message: 'x', level, error })
    } finally {
      console.warn = warn
    }
    assert.equal(why, want)
  }
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

test('ion terrain refused (a bad saved token) or unreachable: Re:Earth in its place, the reason told, the token never logged', async (t) => {
  const fake = new EllipsoidTerrainProvider()
  t.mock.method(CesiumTerrainProvider, 'fromIonAssetId', async () => Promise.reject(Object.assign(new Error('ion'), { statusCode: 401 })))
  const fromUrl = t.mock.method(CesiumTerrainProvider, 'fromUrl', async () => fake)
  const warn = t.mock.method(console, 'warn', () => {})
  const token = Ion.defaultAccessToken
  t.after(() => void (Ion.defaultAccessToken = token))
  const why: string[] = []
  assert.equal(await makeTerrain(readConfig({}, { ionToken: 'test-invalid-ion-token-000' }), (w) => why.push(w)), fake)
  assert.equal((fromUrl.mock.calls[0].arguments[0] as Resource).url, `${REEARTH_TERRAIN_URL}?extensions=octvertexnormals`)
  assert.deepEqual(why, ['ion HTTP 401'])
  assert.match(String(warn.mock.calls[0].arguments[0]), /Cesium World Terrain unavailable \(ion HTTP 401\); using Re:Earth terrain/)
  assert.doesNotMatch(String(warn.mock.calls[0].arguments[0]), /test-invalid-ion-token-000/)
  t.mock.method(CesiumTerrainProvider, 'fromIonAssetId', async () => Promise.reject(new TypeError('Failed to fetch')))
  await makeTerrain(readConfig({}, { ionToken: 'test-invalid-ion-token-000' }), (w) => why.push(w))
  assert.equal(why[1], 'ion unreachable')
})

test('ion imagery refused: EOX in its place, the reason told', async (t) => {
  t.mock.method(IonImageryProvider, 'fromAssetId', async () => Promise.reject(Object.assign(new Error('ion'), { statusCode: 401 })))
  const warn = t.mock.method(console, 'warn', () => {})
  const token = Ion.defaultAccessToken
  t.after(() => void (Ion.defaultAccessToken = token))
  let why = ''
  const p = await makeImagery(readConfig({}, { ionToken: 'test-invalid-ion-token-000' }), (w) => (why = w))
  assert.ok(p instanceof UrlTemplateImageryProvider)
  assert.equal(p.url, EOX_URL)
  assert.equal(why, 'ion HTTP 401')
  assert.doesNotMatch(String(warn.mock.calls[0].arguments[0]), /test-invalid-ion-token-000/)
})


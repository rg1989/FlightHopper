// client/scene/nightLights.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UrlTemplateImageryProvider, WebMercatorTilingScheme } from 'cesium'
import { NIGHT_CREDIT, NIGHT_MAX_LEVEL, NIGHT_URL, makeNightLayer } from './nightLights.ts'

test('NIGHT_URL: GIBS VIIRS Black Marble 2016, Web Mercator Level8 PNG tiles, z/y/x', () => {
  assert.equal(
    NIGHT_URL,
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png',
  )
  assert.equal(NIGHT_MAX_LEVEL, 8) // GIBS answers z9 with HTTP 400
})

test('NIGHT_CREDIT carries the GIBS acknowledgment and names the layer', () => {
  assert.match(NIGHT_CREDIT, /We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services \(GIBS\), part of NASA's Earth Science Data and Information System \(ESDIS\)\./)
  assert.match(NIGHT_CREDIT, /VIIRS Black Marble 2016/)
})

test('makeNightLayer: hidden, transparent, bright; the provider stops at level 8 and credits GIBS', () => {
  const layer = makeNightLayer()
  assert.equal(layer.show, false) // no tile requests until Sun shows it at dusk
  assert.equal(layer.alpha, 0)
  assert.equal(layer.brightness, 1.6)
  const p = layer.imageryProvider as UrlTemplateImageryProvider
  assert.ok(p instanceof UrlTemplateImageryProvider)
  assert.equal(p.url, NIGHT_URL)
  assert.equal(p.maximumLevel, NIGHT_MAX_LEVEL)
  assert.ok(p.tilingScheme instanceof WebMercatorTilingScheme) // EPSG:3857, as the tile matrix set
  assert.equal(p.credit.html, NIGHT_CREDIT)
  assert.notEqual(makeNightLayer(), layer) // one per call: a layer belongs to one collection
})

test('makeNightLayer makes no request (Cesium fetches tiles only for a shown layer while it renders)', () => {
  const urls: string[] = []
  const real = globalThis.fetch
  globalThis.fetch = ((url: string) => (urls.push(String(url)), Promise.reject(new Error('offline')))) as typeof fetch
  try {
    makeNightLayer()
  } finally {
    globalThis.fetch = real
  }
  assert.deepEqual(urls, [])
})

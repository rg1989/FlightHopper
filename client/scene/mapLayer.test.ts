// client/scene/mapLayer.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ImageryLayer, ImageryLayerCollection, OpenStreetMapImageryProvider, UrlTemplateImageryProvider } from 'cesium'
import type { Viewer } from 'cesium'
import { OSM_CREDIT_HTML, OSM_URL, makeMapLayer } from './mapLayer.ts'

/** Just the imagery collection, with a satellite-like base layer already in it. Nothing here touches the network. */
function fakeViewer() {
  const imageryLayers = new ImageryLayerCollection()
  const base = imageryLayers.addImageryProvider(new UrlTemplateImageryProvider({ url: 'https://satellite.invalid/{z}/{x}/{y}.jpg' }))
  return { imageryLayers, base, viewer: { imageryLayers } as unknown as Viewer }
}

test('makeMapLayer: one OpenStreetMap layer on top of the base layer, standard tile URL, zoom ≤ 19', () => {
  const { imageryLayers, base, viewer } = fakeViewer()
  makeMapLayer(viewer)
  assert.equal(imageryLayers.length, 2)
  assert.equal(imageryLayers.get(0), base, 'the satellite layer stays underneath')
  const provider = imageryLayers.get(1).imageryProvider as OpenStreetMapImageryProvider
  assert.ok(provider instanceof OpenStreetMapImageryProvider)
  assert.equal(OSM_URL, 'https://tile.openstreetmap.org/')
  assert.equal(provider.url, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png')
  assert.equal(provider.maximumLevel, 19)
})

test('makeMapLayer: the credit is OSMF’s required attribution, linked to the copyright page, shown on screen', () => {
  const { imageryLayers, viewer } = fakeViewer()
  makeMapLayer(viewer)
  const credit = imageryLayers.get(1).imageryProvider.credit
  assert.equal(credit.html, OSM_CREDIT_HTML)
  assert.match(credit.html, /© <a href="https:\/\/www\.openstreetmap\.org\/copyright"[^>]*>OpenStreetMap<\/a> contributors/)
  assert.equal(credit.showOnScreen, true)
})

test('show: starts shown (the app starts in browse) and switches the layer; a hidden layer loads no tiles', () => {
  const { imageryLayers, viewer } = fakeViewer()
  const map = makeMapLayer(viewer)
  const layer = imageryLayers.get(1)
  assert.equal(map.show, true)
  assert.equal(layer.show, true)
  map.show = false
  assert.equal(map.show, false)
  assert.equal(layer.show, false)
  map.show = true
  assert.equal(layer.show, true)
})

test('the street map is muted a little so the altitude colours stand out; the base layer is untouched', () => {
  const { imageryLayers, base, viewer } = fakeViewer()
  makeMapLayer(viewer)
  const layer = imageryLayers.get(1)
  assert.ok(layer.brightness < 1 && layer.brightness > 0.5, `${layer.brightness}`)
  assert.ok(layer.saturation < 1 && layer.saturation > 0.3, `${layer.saturation}`)
  assert.equal(base.brightness, ImageryLayer.DEFAULT_BRIGHTNESS)
})

test('destroy removes only the street map and is idempotent; another tile server can be passed in', () => {
  const { imageryLayers, base, viewer } = fakeViewer()
  const map = makeMapLayer(viewer)
  const layer = imageryLayers.get(1)
  map.destroy()
  map.destroy()
  assert.equal(imageryLayers.length, 1)
  assert.equal(imageryLayers.get(0), base)
  assert.equal(layer.isDestroyed(), true)
  makeMapLayer(viewer, 'https://tiles.example.org/osm')
  assert.equal((imageryLayers.get(1).imageryProvider as OpenStreetMapImageryProvider).url, 'https://tiles.example.org/osm/{z}/{x}/{y}.png')
})

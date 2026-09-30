// client/scene/mapLayer.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Event, ImageryLayer, ImageryLayerCollection, OpenStreetMapImageryProvider, UrlTemplateImageryProvider } from 'cesium'
import type { Viewer } from 'cesium'
import { DARK_URLS, OSM_CREDIT_HTML, OSM_URL, makeMapLayer } from './mapLayer.ts'

/** Just the imagery collection, with a satellite-like base layer already in it, and a scene to render. No network. */
function fakeViewer() {
  const imageryLayers = new ImageryLayerCollection()
  const base = imageryLayers.addImageryProvider(new UrlTemplateImageryProvider({ url: 'https://satellite.invalid/{z}/{x}/{y}.jpg' }))
  const scene = { postRender: new Event(), globe: { tilesLoaded: true } }
  const render = (): void => void scene.postRender.raiseEvent()
  return { imageryLayers, base, scene, render, viewer: { imageryLayers, scene } as unknown as Viewer }
}

test('makeMapLayer: the OpenStreetMap layer (and the dark one) on top of the base layer, standard tile URL, zoom ≤ 19', () => {
  const { imageryLayers, base, viewer } = fakeViewer()
  makeMapLayer(viewer)
  assert.equal(imageryLayers.length, 4)
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
  const darkLayers = [imageryLayers.get(2), imageryLayers.get(3)]
  map.destroy()
  map.destroy()
  assert.equal(imageryLayers.length, 1)
  assert.ok(darkLayers.every((l) => l.isDestroyed()))
  assert.equal(imageryLayers.get(0), base)
  assert.equal(layer.isDestroyed(), true)
  makeMapLayer(viewer, 'https://tiles.example.org/osm')
  assert.equal((imageryLayers.get(1).imageryProvider as OpenStreetMapImageryProvider).url, 'https://tiles.example.org/osm/{z}/{x}/{y}.png')
})

test('dark: Esri Dark Gray base + the places labels, greyed; while hidden a theme change loads nothing', () => {
  const { imageryLayers, viewer } = fakeViewer()
  const map = makeMapLayer(viewer)
  const light = imageryLayers.get(1)
  const [dark, labels] = [imageryLayers.get(2), imageryLayers.get(3)]
  assert.deepEqual([dark, labels].map((l) => (l.imageryProvider as UrlTemplateImageryProvider).url), DARK_URLS)
  assert.equal(labels.saturation, 0, 'the cream labels go grey-white')
  map.show = false
  map.dark = true
  assert.deepEqual([light.show, dark.show, labels.show], [false, false, false])
  map.show = true // off screen before: no old theme to keep
  assert.deepEqual([light.show, dark.show, labels.show], [false, true, true])
  map.show = false
  assert.deepEqual([light.show, dark.show], [false, false])
})

test('a theme swap on screen puts the new theme on top and keeps the old under it until the tiles are in', () => {
  const { imageryLayers, viewer, scene, render } = fakeViewer()
  const map = makeMapLayer(viewer)
  const light = imageryLayers.get(1)
  const [dark, labels] = [imageryLayers.get(2), imageryLayers.get(3)]
  const order = (): number[] => [light, dark, labels].map((l) => imageryLayers.indexOf(l))
  map.dark = true
  assert.deepEqual(order(), [1, 2, 3], 'dark on top')
  assert.deepEqual([light.show, dark.show, labels.show], [true, true, true], 'the light stays under while dark loads')
  scene.globe.tilesLoaded = true
  render() // the frame that queues the new tiles
  assert.equal(light.show, true)
  scene.globe.tilesLoaded = false
  render()
  assert.equal(light.show, true, 'still loading')
  scene.globe.tilesLoaded = true
  render()
  assert.deepEqual([light.show, dark.show, labels.show], [false, true, true])
  map.dark = false // and back
  assert.deepEqual(order(), [3, 1, 2], 'light on top')
  assert.deepEqual([light.show, dark.show], [true, true])
  map.show = false // a switch to the satellite mid-swap hides both at once
  render()
  render()
  assert.deepEqual([light.show, dark.show, labels.show], [false, false, false])
  assert.equal(scene.postRender.numberOfListeners, 0)
})

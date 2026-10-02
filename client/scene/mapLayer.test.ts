// client/scene/mapLayer.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Event, ImageryLayer, ImageryLayerCollection, OpenStreetMapImageryProvider, UrlTemplateImageryProvider } from 'cesium'
import type { Viewer } from 'cesium'
import { NIGHT_FILTER, NightOsmProvider, OSM_CREDIT_HTML, OSM_URL, makeMapLayer, nightPixels } from './mapLayer.ts'

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
  assert.equal(imageryLayers.length, 3)
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
  const darkLayers = [imageryLayers.get(2)]
  map.destroy()
  map.destroy()
  assert.equal(imageryLayers.length, 1)
  assert.ok(darkLayers.every((l) => l.isDestroyed()))
  assert.equal(imageryLayers.get(0), base)
  assert.equal(layer.isDestroyed(), true)
  makeMapLayer(viewer, 'https://tiles.example.org/osm')
  assert.equal((imageryLayers.get(1).imageryProvider as OpenStreetMapImageryProvider).url, 'https://tiles.example.org/osm/{z}/{x}/{y}.png')
})

test('dark: the same OpenStreetMap tiles recoloured (one layer, same URL and credit); while hidden a theme change loads nothing', () => {
  const { imageryLayers, viewer } = fakeViewer()
  const map = makeMapLayer(viewer)
  const light = imageryLayers.get(1)
  const dark = imageryLayers.get(2)
  const night = dark.imageryProvider as NightOsmProvider
  assert.ok(night instanceof NightOsmProvider)
  assert.equal(night.url, (light.imageryProvider as OpenStreetMapImageryProvider).url)
  assert.equal(night.maximumLevel, 19)
  assert.equal(night.credit.html, OSM_CREDIT_HTML)
  assert.match(NIGHT_FILTER, /^invert\(1\) hue-rotate\(180deg\)/)
  map.show = false
  map.dark = true
  assert.deepEqual([light.show, dark.show], [false, false])
  map.show = true // off screen before: no old theme to keep
  assert.deepEqual([light.show, dark.show], [false, true])
  map.show = false
  assert.deepEqual([light.show, dark.show], [false, false])
})

test('a theme swap on screen puts the new theme on top and keeps the old under it until the tiles are in', () => {
  const { imageryLayers, viewer, scene, render } = fakeViewer()
  const map = makeMapLayer(viewer)
  const light = imageryLayers.get(1)
  const dark = imageryLayers.get(2)
  const order = (): number[] => [light, dark].map((l) => imageryLayers.indexOf(l))
  map.dark = true
  assert.deepEqual(order(), [1, 2], 'dark on top')
  assert.deepEqual([light.show, dark.show], [true, true], 'the light stays under while dark loads')
  scene.globe.tilesLoaded = true
  render() // the frame that queues the new tiles
  assert.equal(light.show, true)
  scene.globe.tilesLoaded = false
  render()
  assert.equal(light.show, true, 'still loading')
  scene.globe.tilesLoaded = true
  render()
  assert.deepEqual([light.show, dark.show], [false, true])
  map.dark = false // and back
  assert.deepEqual(order(), [2, 1], 'light on top')
  assert.deepEqual([light.show, dark.show], [true, true])
  map.show = false // a switch to the satellite mid-swap hides both at once
  render()
  render()
  assert.deepEqual([light.show, dark.show], [false, false])
  assert.equal(scene.postRender.numberOfListeners, 0)
})

test('nightPixels: the light map’s colours go dark and its dark text light, hues kept, alpha untouched', () => {
  const px = (rgba: number[]): number[] => {
    const a = new Uint8ClampedArray(rgba)
    nightPixels(a)
    return [...a]
  }
  const [lr, lg, lb, la] = px([242, 239, 233, 255]) // OSM land
  assert.ok(lr < 30 && lg < 30 && lb < 30, `land ${[lr, lg, lb]}`)
  assert.equal(la, 255)
  const [tr, tg, tb] = px([51, 51, 51, 255]) // label text
  assert.ok(tr > 140 && tg > 140 && tb > 140, `text ${[tr, tg, tb]}`)
  const [wr, wg, wb] = px([170, 211, 223, 255]) // OSM water
  assert.ok(wb > wr && wr < 90, `water stays blue-ish and dark: ${[wr, wg, wb]}`)
  const [pr, pg, pb] = px([200, 250, 204, 255]) // a park
  assert.ok(pg > pr && pg > pb, `a park stays green: ${[pr, pg, pb]}`)
  assert.deepEqual(px([0, 0, 0, 0]).slice(3), [0], 'a transparent pixel stays transparent')
})

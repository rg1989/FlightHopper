// client/scene/mapLayer.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Event, ImageryLayer, ImageryLayerCollection, OpenStreetMapImageryProvider, UrlTemplateImageryProvider } from 'cesium'
import type { Viewer } from 'cesium'
import { InkOsmProvider, NIGHT_FILTER, NightOsmProvider, OSM_CREDIT_HTML, OSM_URL, PLACES_URL, ROADS_URL, inkAlpha, makeMapLayer, makeReferenceLayers, nightPixels } from './mapLayer.ts'

/** Just the imagery collection, with a satellite-like base layer already in it, and a scene to render. No network. */
function fakeViewer() {
  const imageryLayers = new ImageryLayerCollection()
  const base = imageryLayers.addImageryProvider(new UrlTemplateImageryProvider({ url: 'https://satellite.invalid/{z}/{x}/{y}.jpg' }))
  const scene = { postRender: new Event(), globe: { tilesLoaded: true } }
  const render = (): void => void scene.postRender.raiseEvent()
  return { imageryLayers, base, scene, render, viewer: { imageryLayers, scene } as unknown as Viewer }
}

test('makeMapLayer: the OpenStreetMap layer (and the dark one, and the ink of each) on top of the base layer, standard tile URL, zoom ≤ 19', () => {
  const { imageryLayers, base, viewer } = fakeViewer()
  makeMapLayer(viewer)
  assert.equal(imageryLayers.length, 5)
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
  const darkLayers = [2, 3, 4].map((i) => imageryLayers.get(i)) // the dark map and the ink of each theme
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

test('the ink copies sit right after the dark map, light then dark, and a layer added at liftIndex lies over the map and under them', () => {
  const { imageryLayers, base, viewer } = fakeViewer()
  const map = makeMapLayer(viewer)
  const [light, dark, lightInk, darkInk] = [1, 2, 3, 4].map((i) => imageryLayers.get(i))
  assert.equal(map.liftIndex, 3, 'the light ink\'s place')
  makeReferenceLayers(viewer)
  const rain = new ImageryLayer(new UrlTemplateImageryProvider({ url: 'https://rain.invalid/{z}/{x}/{y}.png' }))
  imageryLayers.add(rain, map.liftIndex)
  const [roads, places] = [imageryLayers.get(6), imageryLayers.get(7)]
  const order = (): number[] => [base, light, dark, rain, lightInk, darkInk, roads, places].map((l) => imageryLayers.indexOf(l))
  assert.deepEqual(order(), [0, 1, 2, 3, 4, 5, 6, 7], 'base < light map < dark map < rain < light ink < dark ink < roads < places')
  assert.equal(map.liftIndex, 4, 'it follows the ink up: the next layer goes over that rain')
  map.dark = true // the map\'s own swap moves its two layers, never the ink
  map.dark = false
  assert.ok(imageryLayers.indexOf(rain) > Math.max(imageryLayers.indexOf(light), imageryLayers.indexOf(dark)), 'the rain stays over both maps')
  assert.deepEqual([imageryLayers.indexOf(lightInk), map.liftIndex], [4, 4])
})

test('the ink copies: the same OpenStreetMap tiles (URL, zoom, credit) as the map; the light one dressed as the light map, the dark one as the dark', () => {
  const { imageryLayers, viewer } = fakeViewer()
  makeMapLayer(viewer)
  const [light, dark, lightInk, darkInk] = [1, 2, 3, 4].map((i) => imageryLayers.get(i))
  const inks = [lightInk, darkInk].map((l) => l.imageryProvider as InkOsmProvider)
  assert.ok(inks.every((p) => p instanceof InkOsmProvider && p instanceof OpenStreetMapImageryProvider))
  assert.deepEqual(inks.map((p) => p.dark), [false, true])
  for (const p of inks) {
    assert.equal(p.url, (light.imageryProvider as OpenStreetMapImageryProvider).url)
    assert.equal(p.maximumLevel, 19)
    assert.equal(p.credit.html, OSM_CREDIT_HTML)
    assert.equal(p.credit.showOnScreen, true)
  }
  assert.deepEqual([lightInk.brightness, lightInk.saturation], [light.brightness, light.saturation], 'the ink and the map under it are one picture where no rain falls')
  assert.notEqual(lightInk.brightness, ImageryLayer.DEFAULT_BRIGHTNESS)
  assert.deepEqual([darkInk.brightness, darkInk.saturation], [dark.brightness, dark.saturation])
})

test('lift: off, the ink is hidden (a hidden layer loads nothing); lifted it shows the current theme\'s ink alone, and only while the map shows', () => {
  const { imageryLayers, viewer } = fakeViewer()
  const map = makeMapLayer(viewer)
  const [lightInk, darkInk] = [3, 4].map((i) => imageryLayers.get(i))
  const inks = (): boolean[] => [lightInk.show, darkInk.show]
  assert.equal(map.lift, false)
  assert.deepEqual(inks(), [false, false])
  map.lift = true
  assert.equal(map.lift, true)
  assert.deepEqual(inks(), [true, false])
  map.show = false
  assert.deepEqual(inks(), [false, false], 'over the satellite there is no map to copy')
  map.show = true
  assert.deepEqual(inks(), [true, false])
  map.lift = false
  assert.deepEqual(inks(), [false, false])
  map.show = false
  map.dark = true
  map.lift = true
  assert.deepEqual(inks(), [false, false], 'lifted, but the map is not shown')
  map.show = true
  assert.deepEqual(inks(), [false, true], 'the dark theme\'s ink alone: no light ink on screen to keep')
})

test('lift: a theme swap on screen keeps the old ink until the new one\'s tiles are in, as the map under it does', () => {
  const { imageryLayers, viewer, scene, render } = fakeViewer()
  const map = makeMapLayer(viewer)
  const [light, dark, lightInk, darkInk] = [1, 2, 3, 4].map((i) => imageryLayers.get(i))
  const shown = (): boolean[] => [light, dark, lightInk, darkInk].map((l) => l.show)
  map.lift = true
  map.dark = true
  assert.deepEqual(shown(), [true, true, true, true], 'both themes on screen while the new one loads')
  render() // the frame that queues the new tiles
  scene.globe.tilesLoaded = false
  render()
  assert.deepEqual(shown(), [true, true, true, true], 'still loading')
  scene.globe.tilesLoaded = true
  render()
  assert.deepEqual(shown(), [false, true, false, true], 'in one frame: the new theme, map and ink')
  assert.equal(scene.postRender.numberOfListeners, 0)
  map.dark = false // and back
  assert.deepEqual(shown(), [true, true, true, true])
  render()
  render()
  assert.deepEqual(shown(), [true, false, true, false])
  assert.equal(scene.postRender.numberOfListeners, 0)
})

test('lift: switched off mid-swap it hides the ink at once and leaves the map\'s swap, and its wait, as they were', () => {
  const { imageryLayers, viewer, scene, render } = fakeViewer()
  const map = makeMapLayer(viewer)
  const [light, dark, lightInk, darkInk] = [1, 2, 3, 4].map((i) => imageryLayers.get(i))
  const shown = (): boolean[] => [light, dark, lightInk, darkInk].map((l) => l.show)
  map.lift = true
  map.dark = true
  render() // the map has waited one frame
  map.lift = false // the weather goes off
  assert.deepEqual(shown(), [true, true, false, false])
  render()
  assert.deepEqual(shown(), [false, true, false, false], 'the map\'s wait went on: not restarted by lift')
  assert.equal(scene.postRender.numberOfListeners, 0)
})

test('lift: switched on while the map swaps, only the new ink shows, and the map\'s own swap is not disturbed', () => {
  const { imageryLayers, viewer, scene, render } = fakeViewer()
  const map = makeMapLayer(viewer)
  const [light, dark, lightInk, darkInk] = [1, 2, 3, 4].map((i) => imageryLayers.get(i))
  const shown = (): boolean[] => [light, dark, lightInk, darkInk].map((l) => l.show)
  map.dark = true
  render()
  map.lift = true // no old ink on screen to keep
  assert.deepEqual(shown(), [true, true, false, true])
  render()
  assert.deepEqual(shown(), [false, true, false, true], 'the map\'s swap finished on its own schedule')
  assert.equal(scene.postRender.numberOfListeners, 0)
})

test('lift: the map hidden mid-swap hides every layer at once and stops every wait; destroy stops them too', () => {
  const { imageryLayers, viewer, scene, render } = fakeViewer()
  const map = makeMapLayer(viewer)
  const [light, dark, lightInk, darkInk] = [1, 2, 3, 4].map((i) => imageryLayers.get(i))
  const shown = (): boolean[] => [light, dark, lightInk, darkInk].map((l) => l.show)
  map.lift = true
  map.dark = true
  assert.equal(scene.postRender.numberOfListeners, 2, 'one wait for the map, one for the ink')
  map.show = false // to the satellite
  assert.deepEqual(shown(), [false, false, false, false])
  render()
  render()
  assert.equal(scene.postRender.numberOfListeners, 0)
  map.show = true
  map.dark = false
  assert.equal(scene.postRender.numberOfListeners, 2)
  map.destroy()
  assert.equal(scene.postRender.numberOfListeners, 0)
  assert.equal(imageryLayers.length, 1)
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

/** w × h RGBA bytes all in one colour (#rrggbb), with the given pixels [x, y, colour] set. */
function tile(w: number, h: number, fill: string, set: [number, number, string][] = []): Uint8ClampedArray {
  const rgba = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(255)
  const px = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) px.set(rgba(fill), i * 4)
  for (const [x, y, hex] of set) px.set(rgba(hex), (y * w + x) * 4)
  return px
}
const LAND = '#f2efe9'

test('inkAlpha: dark text is ink and a halo one pixel round it is 85% of it; land and water are not', () => {
  const px = tile(5, 5, LAND, [[2, 2, '#222222']])
  const before = px.slice()
  const a = inkAlpha(px, 5, 5)
  const at = (x: number, y: number): number => a[y * 5 + x]
  assert.deepEqual(px, before, 'the tile is only read')
  assert.equal(a.length, 25)
  assert.equal(at(2, 2), 255, 'text')
  assert.equal(at(2, 1), Math.round(0.85 * 255), 'beside it: the halo (217)')
  assert.equal(at(3, 3), 217, 'and diagonally')
  assert.equal(at(0, 2), 0, 'two pixels away: land')
  assert.equal(at(0, 0), 0)
  assert.deepEqual([...inkAlpha(tile(3, 3, '#aad3df'), 3, 3)], new Array(9).fill(0), 'water with no ink near')
})

test('inkAlpha: a grey between the thresholds is partly ink and its halo follows; a halo takes its strongest neighbour', () => {
  const grey = inkAlpha(tile(3, 1, LAND, [[0, 0, '#8f8f8f']]), 3, 1) // luminance 0.56, between 0.42 (ink) and 0.62 (not)
  assert.ok(grey[0] >= 75 && grey[0] <= 76, `the grey itself ${grey[0]}`) // (0.62 - 0.56) / 0.2 of 255
  assert.ok(grey[1] >= 64 && grey[1] <= 65, `its halo ${grey[1]}`) // 85% of that
  assert.equal(grey[2], 0)
  const both = inkAlpha(tile(5, 1, LAND, [[0, 0, '#8f8f8f'], [2, 0, '#222222']]), 5, 1)
  assert.deepEqual([...both.slice(1)], [217, 255, 217, 0], 'between the grey and the text: the text\'s halo')
})

test('inkAlpha: ink at a tile\'s corner haloes only inside it; a real-size tile is read whole', () => {
  assert.deepEqual([...inkAlpha(tile(3, 3, LAND, [[0, 0, '#222222']]), 3, 3)], [255, 217, 0, 217, 217, 0, 0, 0, 0])
  const line: [number, number, string][] = Array.from({ length: 100 }, (_, i) => [50 + i, 100, '#222222'])
  const a = inkAlpha(tile(256, 256, LAND, line), 256, 256)
  const counts = new Map<number, number>()
  for (const v of a) counts.set(v, (counts.get(v) ?? 0) + 1)
  assert.deepEqual([...counts].sort((p, q) => p[0] - q[0]), [[0, 256 * 256 - 306], [217, 206], [255, 100]], 'the line, and one pixel of halo all round it')
})

/** Just enough of the browser for a tile's ink: a canvas that takes one image and gives its pixels back, ImageData and ImageBitmap. */
class FakeImageData {
  data: Uint8ClampedArray
  width: number
  height: number
  constructor(a: Uint8ClampedArray | number, w: number, h?: number) {
    this.data = typeof a === 'number' ? new Uint8ClampedArray(a * w * 4) : a
    this.width = typeof a === 'number' ? a : w
    this.height = typeof a === 'number' ? w : (h ?? a.length / 4 / w)
  }
}
interface Decoded { pixels: Uint8ClampedArray; width: number; height: number }
class FakeBitmap implements Decoded {
  pixels: Uint8ClampedArray
  width: number
  height: number
  closed = false
  constructor(pixels: Uint8ClampedArray, width: number, height: number) {
    this.pixels = pixels
    this.width = width
    this.height = height
  }
  close(): void {
    this.closed = true
  }
}
function fakeCanvas(): { width: number; height: number; getContext: () => unknown } {
  let drawn: Decoded | null = null
  const ctx = {
    drawImage: (img: Decoded): void => void (drawn = img),
    getImageData: (_x: number, _y: number, w: number, h: number): FakeImageData => new FakeImageData(drawn!.pixels.slice(), w, h),
  }
  return { width: 0, height: 0, getContext: () => ctx }
}
/** Runs with the browser fakes in place and `served` as the tile server's answer to every request, then puts everything back. */
async function withTiles(served: () => Promise<Decoded> | undefined, run: () => Promise<void>): Promise<void> {
  const g = globalThis as unknown as Record<string, unknown>
  const saved = (['document', 'ImageData', 'ImageBitmap'] as const).map((k) => [k, g[k]] as const)
  const proto = UrlTemplateImageryProvider.prototype as unknown as { requestImage: () => unknown }
  const requestImage = proto.requestImage
  Object.assign(g, { document: { createElement: fakeCanvas }, ImageData: FakeImageData, ImageBitmap: FakeBitmap })
  proto.requestImage = served
  try {
    await run()
  } finally {
    proto.requestImage = requestImage
    for (const [k, v] of saved) g[k] = v
  }
}
const ink = (dark: boolean): InkOsmProvider => new InkOsmProvider({ url: OSM_URL, maximumLevel: 19 }, dark)
const inkOf = async (p: InkOsmProvider): Promise<FakeImageData> => (await p.requestImage(0, 0, 3)) as unknown as FakeImageData
const alphas = (t: FakeImageData): number[] => [...t.data].filter((_, i) => i % 4 === 3)

test('InkOsmProvider: a tile comes back as straight-alpha pixels, its own colours with alpha the ink; the dark one recoloured as the dark map is, the same alpha', async () => {
  const image: Decoded = { pixels: tile(4, 3, LAND, [[1, 1, '#222222']]), width: 4, height: 3 }
  const want = [217, 217, 217, 0, 217, 255, 217, 0, 217, 217, 217, 0] // the text, and a pixel of halo all round it
  await withTiles(() => Promise.resolve(image), async () => {
    const light = await inkOf(ink(false))
    assert.ok(light instanceof FakeImageData)
    assert.deepEqual([light.width, light.height], [4, 3])
    assert.deepEqual(alphas(light), want)
    const rgb = (t: Uint8ClampedArray): number[] => [...t].filter((_, i) => i % 4 !== 3)
    assert.deepEqual(rgb(light.data), rgb(image.pixels), 'every pixel keeps the map\'s colour, the clear ones too: the layer is the map where nothing lies under it')
    const night = image.pixels.slice()
    nightPixels(night)
    const dark = await inkOf(ink(true))
    assert.deepEqual(rgb(dark.data), rgb(night), 'recoloured as the dark map is')
    assert.deepEqual(alphas(dark), want, 'the ink is read from the original colours, not the recoloured ones')
    assert.deepEqual([...image.pixels], [...tile(4, 3, LAND, [[1, 1, '#222222']])], 'the decoded tile is left as it was')
  })
})

test('InkOsmProvider: Cesium\'s bitmaps are flipped for WebGL: one is closed once drawn and comes back north-up (Cesium flips ImageData as it uploads it); an image is not turned', async () => {
  const flipped = new FakeBitmap(tile(3, 3, LAND, [[1, 0, '#222222']]), 3, 3) // the text in the bitmap's first row: the picture's last
  await withTiles(() => Promise.resolve(flipped), async () => {
    const got = await inkOf(ink(false))
    assert.equal(flipped.closed, true)
    assert.deepEqual(alphas(got), [0, 0, 0, 217, 217, 217, 217, 255, 217])
    assert.deepEqual([...got.data.slice((2 * 3 + 1) * 4, (2 * 3 + 2) * 4)], [34, 34, 34, 255], 'the text, and its colour, in the last row')
  })
  const image: Decoded = { pixels: tile(3, 3, LAND, [[1, 0, '#222222']]), width: 3, height: 3 }
  await withTiles(() => Promise.resolve(image), async () => {
    assert.deepEqual(alphas(await inkOf(ink(false))), [217, 255, 217, 217, 217, 217, 0, 0, 0], 'an image is north-up already')
  })
})

test('InkOsmProvider: a request Cesium throttles stays undefined, and a failed tile fails as it expects', async () => {
  await withTiles(() => undefined, async () => {
    assert.equal(ink(false).requestImage(0, 0, 3), undefined)
  })
  await withTiles(() => Promise.reject(new Error('HTTP 404')), async () => {
    await assert.rejects(ink(true).requestImage(0, 0, 3) as Promise<unknown>, /HTTP 404/)
  })
})

test('InkOsmProvider: with no 2-D canvas it draws nothing, not the whole map over the rain', async () => {
  const image = new FakeBitmap(tile(4, 3, LAND), 4, 3)
  await withTiles(() => Promise.resolve(image), async () => {
    Object.assign(globalThis, { document: { createElement: () => ({ getContext: () => null }) } })
    const got = await inkOf(ink(false))
    assert.deepEqual([got.width, got.height, ...got.data], [1, 1, 0, 0, 0, 0])
    assert.equal(image.closed, true, 'the bitmap is not handed on: closed all the same')
  })
})

test('the reference overlays: roads, and borders and places above them, over every layer before them; each starts hidden', () => {
  const { imageryLayers, base, viewer } = fakeViewer()
  makeMapLayer(viewer)
  makeReferenceLayers(viewer)
  assert.equal(imageryLayers.length, 7)
  assert.equal(imageryLayers.get(0), base)
  const [roads, places] = [imageryLayers.get(5), imageryLayers.get(6)]
  const url = (l: ImageryLayer): string => (l.imageryProvider as UrlTemplateImageryProvider).url
  assert.match(ROADS_URL, /^https:\/\/services\.arcgisonline\.com\/.*\/Reference\/World_Transportation\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}$/)
  assert.match(PLACES_URL, /^https:\/\/services\.arcgisonline\.com\/.*\/Reference\/World_Boundaries_and_Places\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}$/)
  assert.deepEqual([url(roads), url(places)], [ROADS_URL, PLACES_URL])
  assert.deepEqual([roads.imageryProvider.maximumLevel, places.imageryProvider.maximumLevel], [19, 19])
  assert.deepEqual([roads.show, places.show], [false, false], 'a hidden layer loads nothing')
})

test('the reference overlays each have their own show: roads alone, places alone, both', () => {
  const { imageryLayers, viewer } = fakeViewer()
  const over = makeReferenceLayers(viewer)
  const [roads, places] = [imageryLayers.get(1), imageryLayers.get(2)]
  const shown = (): boolean[] => [over.roads.show, over.places.show, roads.show, places.show]
  assert.deepEqual(shown(), [false, false, false, false])
  over.roads.show = true
  assert.deepEqual(shown(), [true, false, true, false])
  over.places.show = true
  assert.deepEqual(shown(), [true, true, true, true])
  over.roads.show = false
  assert.deepEqual(shown(), [false, true, false, true])
})

test('the reference overlays: destroy removes each alone, and twice is harmless', () => {
  const { imageryLayers, base, viewer } = fakeViewer()
  const over = makeReferenceLayers(viewer)
  const [roads, places] = [imageryLayers.get(1), imageryLayers.get(2)]
  over.roads.destroy()
  over.roads.destroy()
  assert.equal(roads.isDestroyed(), true)
  assert.deepEqual([imageryLayers.length, imageryLayers.get(1)], [2, places])
  over.places.destroy()
  over.places.destroy()
  assert.equal(places.isDestroyed(), true)
  assert.deepEqual([imageryLayers.length, imageryLayers.get(0)], [1, base])
})

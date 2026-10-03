// client/scene/mapLayer.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Event, ImageryLayer, ImageryLayerCollection, OpenStreetMapImageryProvider, Request, RequestState, UrlTemplateImageryProvider } from 'cesium'
import type { Viewer } from 'cesium'
import { BordersProvider } from './borders.ts'
import {
  CHASE_ROADS_MIN_TERRAIN_LEVEL, InkOsmProvider, NIGHT_FILTER, NightOsmProvider, OSM_CREDIT_HTML, OSM_URL, PLACES_URL, ROADS_URL, inkAlpha, makeMapLayer,
  makeReferenceLayers, nightPixels, type StreetMap,
} from './mapLayer.ts'

/** Just the imagery collection, with a satellite-like base layer already in it, and a scene to render. No network. */
function fakeViewer() {
  const imageryLayers = new ImageryLayerCollection()
  const base = imageryLayers.addImageryProvider(new UrlTemplateImageryProvider({ url: 'https://satellite.invalid/{z}/{x}/{y}.jpg' }))
  const scene = { postRender: new Event(), globe: { tilesLoaded: true } }
  const render = (): void => void scene.postRender.raiseEvent()
  return { imageryLayers, base, scene, render, viewer: { imageryLayers, scene } as unknown as Viewer }
}

const BORDERS_URL = 'https://app.invalid/map/borders.json'
/** Cesium keeps an imagery layer's minimumTerrainLevel to itself: no getter, so the constructor option is read where it put it. */
const minTerrainLevel = (l: ImageryLayer): number | undefined => (l as unknown as { _minimumTerrainLevel?: number })._minimumTerrainLevel

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
  assert.equal(map.liftIndex, -1, 'no ink layer left to lie under: a caller adds on top (Cesium throws on a negative index)')
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
  assert.equal(scene.postRender.numberOfListeners, 0, 'and stops waiting at once, not at the next frame')
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
  makeReferenceLayers(viewer, BORDERS_URL)
  const rain = new ImageryLayer(new UrlTemplateImageryProvider({ url: 'https://rain.invalid/{z}/{x}/{y}.png' }))
  imageryLayers.add(rain, map.liftIndex)
  const [roads, places] = [imageryLayers.get(6), imageryLayers.get(8)]
  const order = (): number[] => [base, light, dark, rain, lightInk, darkInk, roads, places].map((l) => imageryLayers.indexOf(l))
  assert.deepEqual(order(), [0, 1, 2, 3, 4, 5, 6, 8], 'base < light map < dark map < rain < light ink < dark ink < roads < places')
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
  assert.deepEqual(inks(), [false, true], 'the dark theme\'s ink alone')
})

test('lift: a theme swap on screen switches the ink at once, while the map under it swaps on its own schedule', () => {
  const { imageryLayers, viewer, scene, render } = fakeViewer()
  const map = makeMapLayer(viewer)
  const [light, dark, lightInk, darkInk] = [1, 2, 3, 4].map((i) => imageryLayers.get(i))
  const shown = (): boolean[] => [light, dark, lightInk, darkInk].map((l) => l.show)
  map.lift = true
  map.dark = true
  assert.deepEqual(shown(), [true, true, false, true], 'the new theme\'s ink alone, at once; both maps until the new one\'s tiles are in')
  assert.equal(scene.postRender.numberOfListeners, 1, 'the map\'s wait: the ink has none')
  render() // the frame that queues the new tiles
  scene.globe.tilesLoaded = false
  render()
  assert.deepEqual(shown(), [true, true, false, true], 'the map still loading, the ink as it was')
  scene.globe.tilesLoaded = true
  render()
  assert.deepEqual(shown(), [false, true, false, true], 'in one frame the map\'s old theme goes too')
  assert.equal(scene.postRender.numberOfListeners, 0)
  map.dark = false // and back
  assert.deepEqual(shown(), [true, true, true, false])
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
  map.lift = true
  assert.deepEqual(shown(), [true, true, false, true])
  render()
  assert.deepEqual(shown(), [false, true, false, true], 'the map\'s swap finished on its own schedule')
  assert.equal(scene.postRender.numberOfListeners, 0)
})

test('lift: the map hidden mid-swap hides every layer at once and stops its wait; destroy stops it too', () => {
  const { imageryLayers, viewer, scene, render } = fakeViewer()
  const map = makeMapLayer(viewer)
  const [light, dark, lightInk, darkInk] = [1, 2, 3, 4].map((i) => imageryLayers.get(i))
  const shown = (): boolean[] => [light, dark, lightInk, darkInk].map((l) => l.show)
  map.lift = true
  map.dark = true
  assert.equal(scene.postRender.numberOfListeners, 1, 'the map\'s wait')
  map.show = false // to the satellite
  assert.deepEqual(shown(), [false, false, false, false])
  assert.equal(scene.postRender.numberOfListeners, 0, 'stopped at once, not at the next frame')
  render()
  render()
  assert.equal(scene.postRender.numberOfListeners, 0)
  map.show = true
  map.dark = false
  assert.equal(scene.postRender.numberOfListeners, 1)
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
  const base = rgba(fill)
  for (let i = 0; i < w * h; i++) px.set(base, i * 4)
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

/** inkAlpha as first written: one 3 × 3 window per pixel. The two-pass version must give its answer. */
function inkAlphaWindows(px: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const t = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const lum = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255
    t[i] = lum <= 0.42 ? 1 : lum >= 0.62 ? 0 : (0.62 - lum) / (0.62 - 0.42)
  }
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let halo = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const [xx, yy] = [x + dx, y + dy]
          if (xx >= 0 && xx < w && yy >= 0 && yy < h && t[yy * w + xx] > halo) halo = t[yy * w + xx]
        }
      }
      out[y * w + x] = Math.round(Math.max(t[y * w + x], 0.85 * halo) * 255)
    }
  }
  return out
}

/** Land with greys of every darkness scattered over it (some ink, some between, some light) by a fixed sequence. */
function scattered(w: number, h: number, seed: number): Uint8ClampedArray {
  const px = tile(w, h, LAND)
  let s = seed
  const next = (): number => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32
  for (let i = 0; i < w * h; i++) {
    if (next() >= 0.2) continue
    const v = Math.floor(next() * 256)
    px.set([v, v, v, 255], i * 4)
  }
  return px
}

test('inkAlpha: the halo taken in two passes of three is the 3 × 3 window\'s answer, on tiles that are not square either', () => {
  for (const [w, h, seed] of [[7, 4, 1], [4, 7, 2], [1, 5, 3], [5, 1, 4], [2, 2, 5], [13, 9, 6], [64, 48, 7]]) {
    const px = scattered(w, h, seed)
    assert.deepEqual(inkAlpha(px, w, h), inkAlphaWindows(px, w, h), `${w} × ${h}`)
  }
})

test('inkAlpha: the scratch it reuses leaves nothing behind (a small tile after a big inky one), and each answer is its own array', () => {
  const small = scattered(5, 4, 11)
  const alone = inkAlpha(small, 5, 4)
  inkAlpha(scattered(64, 64, 12), 64, 64) // fills a bigger scratch with ink
  assert.deepEqual(inkAlpha(small, 5, 4), alone)
  assert.deepEqual(alone, inkAlphaWindows(small, 5, 4))
  assert.deepEqual(inkAlpha(tile(5, 4, LAND), 5, 4), new Uint8Array(20), 'land after ink: nothing of it left')
  const first = inkAlpha(scattered(8, 8, 13), 8, 8)
  const kept = first.slice()
  inkAlpha(scattered(8, 8, 14), 8, 8)
  assert.deepEqual(first, kept, 'a second call does not write over the first\'s answer')
})

/** Just enough of the browser for a tile's ink: canvases that take images and give their pixels back, ImageData, ImageBitmap, frames. */
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
/** The filter each draw of the fake canvases came with since withTiles began, in order. */
const drawn: string[] = []
/** What a browser's NIGHT_FILTER stands for here: the colours inverted, not nightPixels' sums, so a test can tell where a colour came from. */
const invert = (px: Uint8ClampedArray): Uint8ClampedArray => px.map((v, i) => (i % 4 === 3 ? v : 255 - v))
function fakeCanvas(): { width: number; height: number; getContext: () => unknown } {
  let pixels: Uint8ClampedArray | null = null
  const ctx = {
    filter: 'none',
    clearRect: (): void => void (pixels = null),
    drawImage: (img: Decoded & { closed?: boolean }): void => {
      if (img.closed) throw new Error('InvalidStateError: the bitmap is closed') // as a browser's drawImage does
      if (pixels !== null) throw new Error('drawn over earlier pixels: a tile may be translucent, and this fake does not blend') // clearRect first
      drawn.push(ctx.filter)
      pixels = ctx.filter === NIGHT_FILTER ? invert(img.pixels) : img.pixels.slice()
    },
    getImageData: (_x: number, _y: number, w: number, h: number): FakeImageData => new FakeImageData(pixels!.slice(), w, h),
  }
  return { width: 0, height: 0, getContext: () => ctx }
}
/**
 * Runs with the browser fakes in place and `served` as the tile server's answer to every request, then puts everything back.
 * Frames come at once. The canvas has a filter when `filter` says so; else its context has none, as in Safari.
 */
async function withTiles(served: () => Promise<Decoded> | undefined, run: () => Promise<void>, filter = false): Promise<void> {
  const g = globalThis as unknown as Record<string, unknown>
  const saved = (['document', 'ImageData', 'ImageBitmap', 'CanvasRenderingContext2D', 'requestAnimationFrame'] as const).map((k) => [k, g[k]] as const)
  const proto = UrlTemplateImageryProvider.prototype as unknown as { requestImage: () => unknown }
  const requestImage = proto.requestImage
  const context = class {} // a CanvasRenderingContext2D: whether it has a filter is told from its prototype
  if (filter) Object.defineProperty(context.prototype, 'filter', { value: 'none', writable: true })
  drawn.length = 0
  Object.assign(g, {
    document: { createElement: fakeCanvas }, ImageData: FakeImageData, ImageBitmap: FakeBitmap, CanvasRenderingContext2D: context,
    requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
  })
  proto.requestImage = served
  try {
    await run()
  } finally {
    proto.requestImage = requestImage
    for (const [k, v] of saved) g[k] = v
  }
}
const ink = (dark: boolean, live = (): boolean => true): InkOsmProvider => new InkOsmProvider({ url: OSM_URL, maximumLevel: 19 }, dark, live)
const inkOf = async (p: InkOsmProvider): Promise<FakeImageData> => (await p.requestImage(0, 0, 3)) as unknown as FakeImageData
const alphas = (t: FakeImageData): number[] => [...t.data].filter((_, i) => i % 4 === 3)
const rgb = (t: Uint8ClampedArray): number[] => [...t].filter((_, i) => i % 4 !== 3)
const TEXT_AT_1_1 = [217, 217, 217, 0, 217, 255, 217, 0, 217, 217, 217, 0] // 4 × 3: the text at (1, 1), and a pixel of halo all round it

test('InkOsmProvider: a tile comes back as straight-alpha pixels, its own colours with alpha the ink; the dark one recoloured as the dark map is (nightPixels: this canvas has no filter), the same alpha', async () => {
  const image: Decoded = { pixels: tile(4, 3, LAND, [[1, 1, '#222222']]), width: 4, height: 3 }
  await withTiles(() => Promise.resolve(image), async () => {
    const light = await inkOf(ink(false))
    assert.ok(light instanceof FakeImageData)
    assert.deepEqual([light.width, light.height], [4, 3])
    assert.deepEqual(alphas(light), TEXT_AT_1_1)
    assert.deepEqual(rgb(light.data), rgb(image.pixels), 'every pixel keeps the map\'s colour, the clear ones too: the layer is the map where nothing lies under it')
    const night = image.pixels.slice()
    nightPixels(night)
    const dark = await inkOf(ink(true))
    assert.deepEqual(rgb(dark.data), rgb(night), 'recoloured as the dark map is')
    assert.deepEqual(alphas(dark), TEXT_AT_1_1, 'the ink is read from the original colours, not the recoloured ones')
    assert.deepEqual([...image.pixels], [...tile(4, 3, LAND, [[1, 1, '#222222']])], 'the decoded tile is left as it was')
    assert.deepEqual(drawn, ['none', 'none'], 'each drawn once, no filter asked of a canvas that has none')
  })
})

test('InkOsmProvider: where the canvas has a filter, the dark ink\'s colours come from a second draw through NIGHT_FILTER (what the dark map shows there), its alpha from the original colours', async () => {
  const image: Decoded = { pixels: tile(4, 3, LAND, [[1, 1, '#222222']]), width: 4, height: 3 }
  await withTiles(() => Promise.resolve(image), async () => {
    const light = await inkOf(ink(false))
    assert.deepEqual(drawn, ['none'], 'the light ink is the original: one draw, no filter')
    assert.deepEqual(rgb(light.data), rgb(image.pixels))
    drawn.length = 0
    const dark = await inkOf(ink(true))
    assert.deepEqual(drawn, ['none', NIGHT_FILTER], 'the original, for the ink; then through the filter, for the colours')
    assert.deepEqual(rgb(dark.data), rgb(invert(image.pixels)), 'the filtered draw\'s colours, not nightPixels\'')
    assert.deepEqual(alphas(dark), TEXT_AT_1_1, 'the alpha from the original colours: read from the filtered ones, all of it would be ink')
    assert.deepEqual([...image.pixels], [...tile(4, 3, LAND, [[1, 1, '#222222']])], 'the decoded tile is left as it was')
  }, true)
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

test('InkOsmProvider: the dark ink of a bitmap, as Chrome makes it: both draws from the open bitmap, closed after, north-up, the filter\'s colours under the original\'s alpha', async () => {
  const flipped = new FakeBitmap(tile(3, 3, LAND, [[1, 0, '#222222']]), 3, 3) // the text in the bitmap's first row: the picture's last
  await withTiles(() => Promise.resolve(flipped), async () => {
    const got = await inkOf(ink(true))
    assert.deepEqual(drawn, ['none', NIGHT_FILTER], 'a closed bitmap cannot be drawn: it stayed open for both')
    assert.equal(flipped.closed, true)
    assert.deepEqual(alphas(got), [0, 0, 0, 217, 217, 217, 217, 255, 217])
    assert.deepEqual([...got.data.slice(0, 4)], [13, 16, 22, 0], 'land, filtered, in the first row (the bitmap\'s last)')
    assert.deepEqual([...got.data.slice((2 * 3 + 1) * 4, (2 * 3 + 2) * 4)], [221, 221, 221, 255], 'the text, filtered, in the last row')
  }, true)
})

test('InkOsmProvider: a request Cesium throttles stays undefined, and a failed tile fails as it expects (not as cancelled: Cesium logs it)', async () => {
  await withTiles(() => undefined, async () => {
    assert.equal(ink(false).requestImage(0, 0, 3), undefined)
  })
  await withTiles(() => Promise.reject(new Error('HTTP 404')), async () => {
    const request = new Request()
    await assert.rejects(ink(true).requestImage(0, 0, 3, request) as Promise<unknown>, /HTTP 404/)
    assert.notEqual(request.state, RequestState.CANCELLED)
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

test('InkOsmProvider: a tile that has come in is drawn in its turn in drawQueue\'s frames, not as it arrives', async () => {
  const image: Decoded = { pixels: tile(4, 3, LAND, [[1, 1, '#222222']]), width: 4, height: 3 }
  await withTiles(() => Promise.resolve(image), async () => {
    const frames: (() => void)[] = []
    Object.assign(globalThis, { requestAnimationFrame: (f: () => void) => frames.push(f) })
    const pending = ink(false).requestImage(0, 0, 3) as Promise<unknown>
    await new Promise((resolve) => setImmediate(resolve)) // the tile server has answered
    assert.deepEqual([frames.length, drawn.length], [1, 0], 'a frame asked for, nothing drawn yet')
    frames[0]()
    assert.ok((await pending) instanceof FakeImageData)
    assert.equal(drawn.length, 1)
  })
})

test('the ink: a tile waiting for its turn when its layer hides or the map is destroyed is dropped undrawn, its bitmap closed, and Cesium hears it cancelled (it logs nothing); one still shown is drawn', async () => {
  const hides: [string, (map: StreetMap) => void][] = [
    ['lift off', (m) => { m.lift = false }],
    ['the satellite', (m) => { m.show = false }],
    ['destroy', (m) => m.destroy()],
  ]
  for (const [name, hide] of hides) {
    const { imageryLayers, viewer } = fakeViewer()
    const map = makeMapLayer(viewer)
    const provider = imageryLayers.get(3).imageryProvider as InkOsmProvider
    const bitmaps = [1, 2].map(() => new FakeBitmap(tile(4, 3, LAND), 4, 3))
    let served = 0
    await withTiles(() => Promise.resolve(bitmaps[served++]), async () => {
      const frames: (() => void)[] = []
      Object.assign(globalThis, { requestAnimationFrame: (f: () => void) => frames.push(f) })
      const answered = (): Promise<void> => new Promise((resolve) => setImmediate(resolve)) // the tile server has answered
      map.lift = true
      const first = provider.requestImage(0, 0, 3) as Promise<unknown>
      await answered()
      frames.shift()!()
      assert.ok((await first) instanceof FakeImageData, `${name}: still shown at its turn, so drawn`)
      const request = new Request()
      const second = provider.requestImage(1, 0, 3, request) as Promise<unknown>
      await answered()
      hide(map)
      frames.shift()!()
      await assert.rejects(second, /dropped/, name)
      assert.equal(drawn.length, 1, `${name}: only the first was drawn`)
      assert.equal(request.state, RequestState.CANCELLED, `${name}: cancelled, not a failure for Cesium to log`)
      assert.ok(bitmaps.every((b) => b.closed), `${name}: both bitmaps closed, drawn or not`)
    })
  }
})

test('the reference overlays: roads, the chase\'s roads, then places and the chase\'s borders above them, over every layer before them; each starts hidden', () => {
  const { imageryLayers, base, viewer } = fakeViewer()
  makeMapLayer(viewer)
  makeReferenceLayers(viewer, BORDERS_URL)
  assert.equal(imageryLayers.length, 9)
  assert.equal(imageryLayers.get(0), base)
  const [roads, chaseRoads, places, borders] = [5, 6, 7, 8].map((i) => imageryLayers.get(i))
  const url = (l: ImageryLayer): string => (l.imageryProvider as UrlTemplateImageryProvider).url
  assert.match(ROADS_URL, /^https:\/\/services\.arcgisonline\.com\/.*\/Reference\/World_Transportation\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}$/)
  assert.match(PLACES_URL, /^https:\/\/services\.arcgisonline\.com\/.*\/Reference\/World_Boundaries_and_Places\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}$/)
  assert.deepEqual([url(roads), url(chaseRoads), url(places)], [ROADS_URL, ROADS_URL, PLACES_URL])
  assert.deepEqual([roads, chaseRoads, places].map((l) => l.imageryProvider.maximumLevel), [19, 19, 19])
  assert.ok(borders.imageryProvider instanceof BordersProvider)
  assert.equal((borders.imageryProvider as BordersProvider).url, BORDERS_URL)
  assert.deepEqual([roads, chaseRoads, places, borders].map((l) => l.show), [false, false, false, false], 'a hidden layer loads nothing')
})

test('the chase\'s roads lie only on near terrain tiles (Esri\'s raster, drawn for top-down zooms, is wide bands on the far ones); the top-down roads on every tile', () => {
  const { imageryLayers, viewer } = fakeViewer()
  makeReferenceLayers(viewer, BORDERS_URL)
  assert.equal(CHASE_ROADS_MIN_TERRAIN_LEVEL, 12)
  assert.deepEqual([1, 2, 3, 4].map((i) => minTerrainLevel(imageryLayers.get(i))), [undefined, 12, undefined, undefined])
})

test('the reference overlays each have their own show: roads alone, places alone, both', () => {
  const { imageryLayers, viewer } = fakeViewer()
  const over = makeReferenceLayers(viewer, BORDERS_URL)
  const [roads, places] = [imageryLayers.get(1), imageryLayers.get(3)]
  const shown = (): boolean[] => [over.roads.show, over.places.show, roads.show, places.show]
  assert.deepEqual(shown(), [false, false, false, false])
  over.roads.show = true
  assert.deepEqual(shown(), [true, false, true, false])
  over.places.show = true
  assert.deepEqual(shown(), [true, true, true, true])
  over.roads.show = false
  assert.deepEqual(shown(), [false, true, false, true])
})

test('chase: the Roads switch shows the chase\'s roads in place of the top-down ones, Borders & places our borders in place of Esri\'s places raster', () => {
  const { imageryLayers, viewer } = fakeViewer()
  const over = makeReferenceLayers(viewer, BORDERS_URL)
  const [roads, chaseRoads, places, borders] = [1, 2, 3, 4].map((i) => imageryLayers.get(i))
  const shown = (): boolean[] => [roads, chaseRoads, places, borders].map((l) => l.show)
  assert.equal(over.chase, false)
  over.roads.show = true
  over.places.show = true
  assert.deepEqual(shown(), [true, false, true, false], 'top-down: Esri\'s two')
  over.chase = true
  assert.deepEqual(shown(), [false, true, false, true], 'the chase: near roads and our borders')
  assert.deepEqual([over.roads.show, over.places.show, over.chase], [true, true, true], 'the switches read as set')
  over.places.show = false
  assert.deepEqual(shown(), [false, true, false, false])
  over.roads.show = false
  assert.deepEqual(shown(), [false, false, false, false])
  over.places.show = true
  over.chase = false
  assert.deepEqual(shown(), [false, false, true, false], 'back top-down: the places raster again')
})

test('the borders\' data is fetched at their first show in the chase, once; not top-down, not while hidden', async () => {
  const { viewer } = fakeViewer()
  const g = globalThis as unknown as { fetch: unknown }
  const saved = g.fetch
  const asked: string[] = []
  g.fetch = async (url: string) => {
    asked.push(url)
    return { ok: true, json: async () => ({ lines: [] }) }
  }
  try {
    const over = makeReferenceLayers(viewer, BORDERS_URL)
    over.places.show = true // top-down: Esri's raster, not ours
    over.places.show = false
    over.chase = true // the chase with Borders & places off
    over.roads.show = true
    assert.deepEqual(asked, [], 'never shown yet')
    over.places.show = true
    over.places.show = false
    over.places.show = true
    over.chase = false
    over.chase = true
    await new Promise((r) => setTimeout(r, 0))
    assert.deepEqual(asked, [BORDERS_URL], 'once, at the first show')
  } finally {
    g.fetch = saved
  }
})

test('the reference overlays: destroy removes each alone (roads: both roads; places: the places raster and the borders), and twice is harmless', () => {
  const { imageryLayers, base, viewer } = fakeViewer()
  const over = makeReferenceLayers(viewer, BORDERS_URL)
  const [roads, chaseRoads, places, borders] = [1, 2, 3, 4].map((i) => imageryLayers.get(i))
  over.roads.destroy()
  over.roads.destroy()
  assert.deepEqual([roads.isDestroyed(), chaseRoads.isDestroyed()], [true, true])
  assert.deepEqual([imageryLayers.length, imageryLayers.get(1), imageryLayers.get(2)], [3, places, borders])
  over.places.destroy()
  over.places.destroy()
  assert.deepEqual([places.isDestroyed(), borders.isDestroyed()], [true, true])
  assert.deepEqual([imageryLayers.length, imageryLayers.get(0)], [1, base])
  over.chase = true // after destroy: nothing left to show, nothing thrown
})

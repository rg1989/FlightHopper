// client/scene/weather.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Event, ImageryLayerCollection, Request, RequestState, UrlTemplateImageryProvider, type ImageryLayer, type Viewer } from 'cesium'
import type { Metar } from '../../shared/wx.ts'
import { DEFAULT_UNITS, type Units } from '../ui/units.ts'
import { RAIN_PALETTE, RADAR_MAX_LEVEL, RadarSource, type SourceTile } from './radar.ts'
import { MARKER_PX, RadarLayer, RadarProvider, Weather, inRing, lookKey, lookOf, statusText, viewBox, windArrow } from './weather.ts'

const metric: Units = { alt: 'm', speed: 'kmh', vs: 'ms' }
const wind = (wdir: number | null, wspd: number, cat: Metar['cat'] = 'VFR'): Pick<Metar, 'cat' | 'wdir' | 'wspd'> => ({ cat, wdir, wspd })

test('viewBox: whole degrees outward; null when wider than 40°, crossing the antimeridian, or no view', () => {
  assert.equal(viewBox({ west: 34.2, south: 29.5, east: 35.9, north: 33.1 }), '29,34,34,36')
  assert.equal(viewBox({ west: -10, south: 20, east: 31, north: 30 }), null)
  assert.equal(viewBox({ west: 170, south: 0, east: -170, north: 10 }), null)
  assert.equal(viewBox(null), null)
})

test('point-in-area', () => {
  const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]]
  assert.equal(inRing(sq, 5, 5), true)
  assert.equal(inRing(sq, 15, 5), false)
})

test('statusText: radar time, airports, hazard areas, a note; singular for one; zoom in when no airports are asked for', () => {
  const s = { radarTime: '18:50', zoomedOut: false, airports: 6, areas: 3, note: '' }
  assert.equal(statusText(s), 'Radar 18:50 · 6 airports · 3 hazard areas')
  assert.equal(statusText({ ...s, airports: 1, areas: 1 }), 'Radar 18:50 · 1 airport · 1 hazard area')
  assert.equal(statusText({ ...s, airports: 0, areas: 0 }), 'Radar 18:50 · 0 airports · 0 hazard areas')
  assert.equal(statusText({ ...s, radarTime: '', zoomedOut: true }), 'zoom in for airports · 3 hazard areas')
  assert.equal(statusText({ ...s, note: 'some weather unavailable' }), 'Radar 18:50 · 6 airports · 3 hazard areas · some weather unavailable')
})

test('lookOf and lookKey: colour, the speed in the frame\'s unit, and the arrow where the wind goes to, to 10°', () => {
  assert.deepEqual(lookOf(wind(250, 5), DEFAULT_UNITS), { cat: 'VFR', shown: 5, dir: 70 }) // from WSW blows towards ENE
  assert.equal(lookKey(lookOf(wind(250, 5), DEFAULT_UNITS)), 'wx:VFR:5:70')
  assert.equal(lookOf(wind(254, 5), DEFAULT_UNITS).dir, 70) // near directions share a texture
  assert.equal(lookOf(wind(256, 5), DEFAULT_UNITS).dir, 80)
  assert.equal(lookOf(wind(175, 5), DEFAULT_UNITS).dir, 0) // 355 + 5 → 360 reads 0
  assert.equal(lookOf(wind(180, 5), DEFAULT_UNITS).dir, 0)
  assert.equal(lookOf(wind(360, 5), DEFAULT_UNITS).dir, 180)
  assert.equal(lookKey(lookOf(wind(null, 3, 'IFR'), DEFAULT_UNITS)), 'wx:IFR:3:-') // variable: no arrow
  assert.equal(lookKey(lookOf(wind(250, 0), DEFAULT_UNITS)), 'wx:VFR:0:-') // calm: no arrow
  assert.equal(lookKey(lookOf(wind(250, 1), DEFAULT_UNITS)), 'wx:VFR:1:70') // 1 kt is the least that has one
  assert.equal(lookKey(lookOf(wind(90, 12, null), DEFAULT_UNITS)), 'wx:null:12:270')
  assert.equal(lookOf(wind(250, 5), metric).shown, 9) // km/h
  assert.equal(lookOf(wind(250, 5), { ...DEFAULT_UNITS, speed: 'mph' }).shown, 6)
  assert.equal(lookOf(wind(250, 5), { ...DEFAULT_UNITS, speed: 'kt+kmh' }).shown, 5) // the first unit
  assert.notEqual(lookKey(lookOf(wind(250, 5), DEFAULT_UNITS)), lookKey(lookOf(wind(250, 5), metric))) // a unit change is a new look
})

test('windArrow: from r 12 to 16 and a head from r 15.5 (half-width 4.5) to the tip at r 21.5, pointing clockwise from north', () => {
  const close = (got: number[][], want: number[][]): void => {
    assert.equal(got.length, want.length)
    got.forEach((p, i) => assert.ok(Math.hypot(p[0] - want[i][0], p[1] - want[i][1]) < 1e-9, `${JSON.stringify(got)} vs ${JSON.stringify(want)}`))
  }
  const [n, e, s, w] = [0, 90, 180, 270].map(windArrow)
  close(n.shaft, [[0, -12], [0, -16]])
  close(n.head, [[-4.5, -15.5], [0, -21.5], [4.5, -15.5]])
  close(e.shaft, [[12, 0], [16, 0]])
  close(e.head, [[15.5, -4.5], [21.5, 0], [15.5, 4.5]])
  close(s.shaft, [[0, 12], [0, 16]])
  close(s.head, [[4.5, 15.5], [0, 21.5], [-4.5, 15.5]])
  close(w.shaft, [[-12, 0], [-16, 0]])
  close(w.head, [[-15.5, 4.5], [-21.5, 0], [-15.5, -4.5]])
  const d = windArrow(70) // wind from 250°: right and a little up
  assert.ok(d.head[1][0] > 20 && d.head[1][1] < 0 && d.head[1][1] > -10, JSON.stringify(d.head[1]))
  for (const deg of [0, 33, 70, 135, 250, 340]) {
    const a = windArrow(deg)
    assert.ok(Math.abs(Math.hypot(...a.head[1]) - 21.5) < 1e-9)
    assert.ok(Math.abs(Math.hypot(...a.shaft[0]) - 12) < 1e-9 && Math.abs(Math.hypot(...a.shaft[1]) - 16) < 1e-9)
    assert.ok(Math.abs(Math.hypot(...a.head[0]) - Math.hypot(15.5, 4.5)) < 1e-9)
  }
})

test('windArrow: in every direction the arrow and its 5 px halo stay inside the marker\'s canvas', () => {
  for (let deg = 0; deg < 360; deg++) {
    const a = windArrow(deg)
    for (const [x, y] of [...a.shaft, ...a.head]) assert.ok(Math.max(Math.abs(x), Math.abs(y)) + 2.5 <= MARKER_PX / 2 + 1e-9, `${deg}°: ${x}, ${y}`)
  }
})

/** The imagery collection with a satellite-like base layer, and a scene to render. No network. */
function fakeViewer() {
  const imageryLayers = new ImageryLayerCollection()
  imageryLayers.addImageryProvider(new UrlTemplateImageryProvider({ url: 'https://satellite.invalid/{z}/{x}/{y}.jpg' }))
  const scene = { postRender: new Event(), globe: { tilesLoaded: true } }
  const render = (): void => void scene.postRender.raiseEvent()
  const radar = (): ImageryLayer[] => [...Array(imageryLayers.length).keys()].map((i) => imageryLayers.get(i)).filter((l) => l.imageryProvider instanceof RadarProvider)
  return { imageryLayers, scene, render, radar, viewer: { imageryLayers, scene } as unknown as Viewer }
}
const HOST = 'https://tilecache.rainviewer.com'
const drawer = (l: ImageryLayer): RadarProvider => l.imageryProvider as RadarProvider
/** Drawn on screen: shown and not at alpha 0 (a layer shown at alpha 0 loads its tiles but Cesium draws nothing of it). */
const onScreen = (l: ImageryLayer): boolean => l.show && l.alpha > 0

test('radar layer: a frame goes on top of the imagery, drawn smooth to level 12 from its RainViewer tiles; the palette carries the alpha', () => {
  const { imageryLayers, viewer, radar } = fakeViewer()
  const r = new RadarLayer(viewer, RAIN_PALETTE.dark)
  r.palette = RAIN_PALETTE.light // no frame yet: nothing to draw
  assert.equal(imageryLayers.length, 1)
  r.frame(HOST, '/v2/radar/abc')
  assert.equal(imageryLayers.length, 2)
  const [l] = radar()
  assert.equal(imageryLayers.indexOf(l), 1, 'on top')
  assert.equal(drawer(l).source.url, `${HOST}/v2/radar/abc/256/{z}/{x}/{y}/2/0_1.png`)
  assert.equal(drawer(l).palette, RAIN_PALETTE.light)
  assert.equal(drawer(l).maximumLevel, RADAR_MAX_LEVEL)
  assert.equal(l.alpha, 1)
  assert.equal(l.show, false, 'hidden until shown')
  r.show = true
  assert.equal(l.show, true)
})

test('radar layer: the same frame is not loaded again; a new one loads unseen and takes over in one frame once its tiles are in', () => {
  const { viewer, scene, render, radar } = fakeViewer()
  const r = new RadarLayer(viewer, RAIN_PALETTE.dark)
  r.show = true
  r.frame(HOST, '/v2/radar/a')
  const [a] = radar()
  r.frame(HOST, '/v2/radar/a')
  assert.deepEqual(radar(), [a])
  r.frame(HOST, '/v2/radar/b')
  const [, b] = radar()
  assert.deepEqual(radar(), [a, b], 'the new frame on top')
  assert.notEqual(drawer(b).source, drawer(a).source)
  assert.match(drawer(b).source.url, /\/v2\/radar\/b\//)
  assert.deepEqual([b.show, b.alpha], [true, 0], 'shown, so Cesium loads it, at alpha 0, so it draws nothing yet')
  assert.deepEqual(radar().filter(onScreen), [a], 'one frame on screen')
  render() // the frame that queues the new tiles
  scene.globe.tilesLoaded = false
  render()
  assert.deepEqual(radar().filter(onScreen), [a], 'still loading')
  scene.globe.tilesLoaded = true
  render()
  assert.deepEqual(radar(), [b], 'in the same frame: the new one drawn, the old gone')
  assert.equal(b.alpha, 1)
  assert.ok(a.isDestroyed())
  assert.ok(drawer(a).dropped)
  assert.equal(scene.postRender.numberOfListeners, 0)
})

test('radar layer: a frame arriving while one loads replaces the one nobody saw: never more than two layers', () => {
  const { viewer, render, radar } = fakeViewer()
  const r = new RadarLayer(viewer, RAIN_PALETTE.dark)
  r.show = true
  r.frame(HOST, '/v2/radar/a')
  r.frame(HOST, '/v2/radar/b')
  const [a, b] = radar()
  r.frame(HOST, '/v2/radar/c')
  const [, c] = radar()
  assert.deepEqual(radar(), [a, c])
  assert.ok(b.isDestroyed() && drawer(b).dropped)
  assert.deepEqual(radar().filter(onScreen), [a])
  render()
  render()
  assert.deepEqual(radar(), [c])
  assert.equal(c.alpha, 1)
})

test('radar layer: a palette change draws the same source in the other palette and takes over once in; changed back first, nothing new', () => {
  const { viewer, render, radar, scene } = fakeViewer()
  const r = new RadarLayer(viewer, RAIN_PALETTE.dark)
  r.show = true
  r.frame(HOST, '/v2/radar/a')
  const [dark] = radar()
  r.palette = RAIN_PALETTE.light
  const [, light] = radar()
  assert.equal(drawer(light).palette, RAIN_PALETTE.light)
  assert.equal(drawer(light).source, drawer(dark).source, 'no tile fetched again')
  assert.equal(light.alpha, 0)
  r.palette = RAIN_PALETTE.light // unchanged: nothing new
  assert.deepEqual(radar(), [dark, light])
  r.palette = RAIN_PALETTE.dark // back before the light one is in: what is on screen already is it
  assert.deepEqual(radar(), [dark])
  assert.ok(light.isDestroyed() && drawer(light).dropped)
  assert.equal(scene.postRender.numberOfListeners, 0)
  r.palette = RAIN_PALETTE.light
  const [, again] = radar()
  render()
  render()
  assert.deepEqual(radar(), [again])
  assert.equal(again.alpha, 1)
  assert.equal(scene.postRender.numberOfListeners, 0)
})

test('radar layer: hidden, a new one takes over at once; hiding mid-swap puts the newest in at once', () => {
  const { viewer, radar, scene } = fakeViewer()
  const r = new RadarLayer(viewer, RAIN_PALETTE.dark)
  r.frame(HOST, '/v2/radar/a')
  r.frame(HOST, '/v2/radar/b')
  const [b] = radar()
  assert.equal(radar().length, 1)
  assert.match(drawer(b).source.url, /\/b\//)
  assert.deepEqual([b.show, b.alpha], [false, 1])
  assert.equal(scene.postRender.numberOfListeners, 0)
  r.show = true
  r.palette = RAIN_PALETTE.light
  const [, light] = radar()
  r.show = false
  assert.deepEqual(radar(), [light])
  assert.deepEqual([light.show, light.alpha], [false, 1])
  assert.ok(b.isDestroyed() && drawer(b).dropped)
  assert.equal(scene.postRender.numberOfListeners, 0)
  r.show = true
  assert.deepEqual(radar().filter(onScreen), [light])
})

test('radar layer: destroy removes its layers, drops their drawing and stops waiting; twice is harmless; a frame after it adds nothing', () => {
  const { imageryLayers, viewer, scene, radar } = fakeViewer()
  const r = new RadarLayer(viewer, RAIN_PALETTE.dark)
  r.show = true
  r.frame(HOST, '/v2/radar/a')
  r.frame(HOST, '/v2/radar/b')
  const both = radar()
  r.destroy()
  r.destroy()
  assert.equal(imageryLayers.length, 1)
  assert.ok(both.every((l) => drawer(l).dropped))
  assert.equal(scene.postRender.numberOfListeners, 0)
  r.frame(HOST, '/v2/radar/c')
  assert.equal(imageryLayers.length, 1)
})

/** Just enough of the browser for RadarProvider: ImageData and frames. */
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
async function withBrowser(run: () => Promise<void>): Promise<void> {
  const g = globalThis as unknown as Record<string, unknown>
  const saved = (['ImageData', 'requestAnimationFrame'] as const).map((k) => [k, g[k]] as const)
  Object.assign(g, { ImageData: FakeImageData, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) })
  try {
    await run()
  } finally {
    for (const [k, v] of saved) g[k] = v
  }
}
/** A source holding one 40 dBZ pixel at (100, 120) of tile 7/76/50, and what it was asked for. */
function stubSource(asked: string[]): RadarSource {
  const dbz = new Int8Array(256 * 256).fill(-128)
  dbz[120 * 256 + 100] = 40
  const echo: SourceTile = { dbz, snow: new Uint8Array(256 * 256) }
  return new (class extends RadarSource {
    override get(z: number, x: number, y: number): Promise<SourceTile | null> {
      asked.push(`${z}/${x}/${y}`)
      return Promise.resolve(z === 7 && x === 76 && y === 50 ? echo : null)
    }
  })('https://h', '/p')
}

test('RadarProvider: tiles to level 12 as straight-alpha ImageData; each asks only the source tiles it reads; nothing drawn → one shared 1-pixel image', async () => {
  await withBrowser(async () => {
    const asked: string[] = []
    const p = new RadarProvider(stubSource(asked), RAIN_PALETTE.dark)
    assert.equal(p.url, 'https://h/p/256/{z}/{x}/{y}/2/0_1.png')
    assert.equal(p.maximumLevel, RADAR_MAX_LEVEL)
    const image = async (x: number, y: number, level: number): Promise<FakeImageData> => (await p.requestImage(x, y, level)) as unknown as FakeImageData
    const middle = await image(76 * 32 + 16, 50 * 32 + 16, 12) // its source has echo, but not near this square
    assert.deepEqual(asked, ['7/76/50'])
    assert.deepEqual([middle.width, middle.height], [1, 1])
    assert.deepEqual([...middle.data], [0, 0, 0, 0])
    asked.length = 0
    assert.equal(await image(10, 10, 9), middle, 'no source has echo: the same blank')
    assert.deepEqual(asked, ['7/2/2'])
    const drawn = await image(305, 201, 9)
    assert.deepEqual([drawn.width, drawn.height], [256, 256])
    const at = (225 * 256 + 145) * 4
    const [r, g, b, a] = RAIN_PALETTE.dark.rain[5]
    assert.deepEqual([...drawn.data.subarray(at, at + 4)], [...new Uint8ClampedArray([r, g, b, a * 255])])
  })
})

test('RadarProvider: dropped, its tiles still waiting are not drawn, and Cesium hears them as cancelled (it logs nothing)', async () => {
  await withBrowser(async () => {
    const p = new RadarProvider(stubSource([]), RAIN_PALETTE.dark)
    const request = new Request()
    const pending = p.requestImage(305, 201, 9, request)
    p.drop()
    await assert.rejects(pending)
    assert.equal(request.state, RequestState.CANCELLED)
  })
})

test('Weather: the radar in the dark palette until told the theme; a theme change redraws the frame it has in the other', async () => {
  const { viewer, radar } = fakeViewer()
  const v = Object.assign(viewer, {
    canvas: { addEventListener() {}, removeEventListener() {} },
    camera: { computeViewRectangle: () => undefined },
    dataSources: { add: async () => {}, remove: async () => {} },
  })
  Object.assign(v.scene, { primitives: { add() {}, remove() {} } })
  const g = globalThis as unknown as Record<string, unknown>
  const saved = [['document', g.document], ['fetch', g.fetch], ['cancelAnimationFrame', g.cancelAnimationFrame]] as const
  const asked: string[] = []
  g.document = { createElement: () => ({ className: '', hidden: false, remove() {} }) }
  g.cancelAnimationFrame = () => {}
  g.fetch = async (url: string): Promise<Response> => {
    asked.push(url)
    const body = url.includes('weather-maps.json') ? { host: HOST, radar: { past: [{ time: 1759420200, path: '/v2/radar/abc' }] } } : []
    return new Response(JSON.stringify(body))
  }
  const lines: (string | null)[] = []
  const w = new Weather(v, '/api', { append() {} } as unknown as HTMLElement, (t) => lines.push(t))
  try {
    assert.equal(w.theme, 'dark')
    w.show = true
    await new Promise((resolve) => setTimeout(resolve, 0))
    const [frame] = radar()
    assert.equal(drawer(frame).palette, RAIN_PALETTE.dark)
    assert.match(drawer(frame).source.url, /\/v2\/radar\/abc\//)
    assert.equal(frame.show, true)
    assert.match(String(lines.at(-1)), /^Radar \d\d:\d\d/)
    w.theme = 'light'
    assert.equal(w.theme, 'light')
    const [, light] = radar()
    assert.equal(light.alpha, 0)
    assert.equal(drawer(light).palette, RAIN_PALETTE.light)
    assert.equal(drawer(light).source, drawer(frame).source)
    assert.equal(asked.filter((u) => u.includes('weather-maps.json')).length, 1)
  } finally {
    w.destroy()
    for (const [k, val] of saved) g[k] = val
  }
  assert.deepEqual(radar(), [])
})

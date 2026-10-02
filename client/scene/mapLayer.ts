// client/scene/mapLayer.ts
// Browse mode's street map: standard OpenStreetMap raster tiles as an imagery layer above the satellite base layer.
//
// Tile usage policy (https://operations.osmfoundation.org/policies/tiles/, read 2026-09-22): normal interactive viewing
// by a human, where the client requests only the tiles for the current viewport, is allowed. Browsers with default
// settings already send the User-Agent and Referer it requires, and keep the tile cache headers. What we must do:
// (1) show "© OpenStreetMap contributors" linked to https://www.openstreetmap.org/copyright, visible on the map, and
// (2) never bulk-download or prefetch. Cesium requests only the tiles in view, and a hidden layer loads none, so chase
// mode costs OSM nothing. Do not set a no-referrer Referrer-Policy on the page. Access is best-effort and can be
// withdrawn: pass another tile server's URL (the policy asks that the URL can be changed without a code change).
import { Credit, OpenStreetMapImageryProvider, UrlTemplateImageryProvider } from 'cesium'
import type { ImageryLayer, Request, Scene, Viewer } from 'cesium'

export const OSM_URL = 'https://tile.openstreetmap.org/'
export const OSM_CREDIT_HTML = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
const OSM_MAX_ZOOM = 19 // the standard layer's deepest zoom; browse never zooms past ~z15 (MIN_ZOOM_M)
// Muted a little so the altitude-coloured icons (orange … magenta) stand out on the white and yellow streets.
const BRIGHTNESS = 0.85
const SATURATION = 0.6

// The dark theme: the same OpenStreetMap tiles, recoloured once per tile as each arrives (NIGHT_FILTER: inverted, the hues
// turned back so the sea stays blue and the parks green, muted and darkened). Labels, borders and roads are the light
// map's, crisp at every zoom; nothing is drawn twice and no second tile server is asked. Recolouring costs a canvas
// draw per tile when it loads, nothing per frame. Where the canvas has no filter (Safari), nightPixels does the same
// sums. (An earlier dark theme, Esri's Dark Gray Canvas under its places labels, drew labels twice and borders thin.)
//
// Labels over the weather: the map's names, lines and icons are baked into its tiles, so rain drawn over the map covers
// them. A second copy of each theme's tiles keeps only their ink (inkAlpha) and is transparent elsewhere. Lifted
// (StreetMap.lift) it lies over the radar: where no rain falls it draws what the map under it already shows, so it cannot be
// seen, and under rain the names stay crisp. It asks for the map's own tile URLs (the browser's cache has them), only while
// lifted: no prefetch.
export const NIGHT_FILTER = 'invert(1) hue-rotate(180deg) saturate(0.45) brightness(0.8) contrast(1.1)'

// NIGHT_FILTER's sums (Filter Effects 1, the shorthand functions on sRGB values, clamped after each): hue-rotate(180deg)
// and saturate(0.45) as their colour matrices.
const HUE_180 = [-0.574, 1.43, 0.144, 0.426, 0.43, 0.144, 0.426, 1.43, -0.856]
const SAT = 0.45
const SATURATE = [
  0.213 + 0.787 * SAT, 0.715 - 0.715 * SAT, 0.072 - 0.072 * SAT,
  0.213 - 0.213 * SAT, 0.715 + 0.285 * SAT, 0.072 - 0.072 * SAT,
  0.213 - 0.213 * SAT, 0.715 - 0.715 * SAT, 0.072 + 0.928 * SAT,
]
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** NIGHT_FILTER on RGBA bytes, in place (alpha untouched): what the canvas filter draws, for a canvas without one. */
export function nightPixels(px: Uint8ClampedArray): void {
  const [a, b, c, d, e, f, g, h, i] = HUE_180
  const [k, l, m, n, o, p, q, r, s] = SATURATE
  for (let j = 0; j < px.length; j += 4) {
    const r0 = 1 - px[j] / 255
    const g0 = 1 - px[j + 1] / 255
    const b0 = 1 - px[j + 2] / 255
    const r1 = clamp01(a * r0 + b * g0 + c * b0)
    const g1 = clamp01(d * r0 + e * g0 + f * b0)
    const b1 = clamp01(g * r0 + h * g0 + i * b0)
    const r2 = clamp01(k * r1 + l * g1 + m * b1) * 0.8
    const g2 = clamp01(n * r1 + o * g1 + p * b1) * 0.8
    const b2 = clamp01(q * r1 + r * g1 + s * b1) * 0.8
    px[j] = clamp01((r2 - 0.5) * 1.1 + 0.5) * 255
    px[j + 1] = clamp01((g2 - 0.5) * 1.1 + 0.5) * 255
    px[j + 2] = clamp01((b2 - 0.5) * 1.1 + 0.5) * 255
  }
}

// Ink: dark pixels of the light (original) tile, and a halo one pixel round them.
const INK_DARK = 0.42 // luminance at or below: ink
const INK_LIGHT = 0.62 // at or above: not ink (fills: land 0.94, water 0.80, parks 0.93, forest 0.78, buildings 0.82)
const HALO = 0.85

/**
 * The ink share (0–255) of each pixel of a w × h RGBA tile in the light map's own colours.
 * ponytail: a halo stops at its tile's edge, so a name crossing a seam has a pixel's gap in its halo there. Upgrade: read the
 * neighbouring tiles' edge rows.
 */
export function inkAlpha(px: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const n = w * h
  const t = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const lum = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255
    t[i] = lum <= INK_DARK ? 1 : lum >= INK_LIGHT ? 0 : (INK_LIGHT - lum) / (INK_LIGHT - INK_DARK)
  }
  const out = new Uint8Array(n)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let halo = 0
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx >= 0 && xx < w && t[yy * w + xx] > halo) halo = t[yy * w + xx]
        }
      }
      out[y * w + x] = Math.round(Math.max(t[y * w + x], HALO * halo) * 255)
    }
  }
  return out
}

type Tile = Awaited<NonNullable<ReturnType<OpenStreetMapImageryProvider['requestImage']>>>
// Checked on the prototype: a context without the property (Safari) would keep a string assigned to it all the same.
const canvasFilter = typeof CanvasRenderingContext2D !== 'undefined' && 'filter' in CanvasRenderingContext2D.prototype

/** A tile drawn in NIGHT_FILTER's colours. Cesium asks for ImageBitmaps already flipped for WebGL and flips a canvas as it
 *  uploads it: a bitmap goes back as a bitmap (else the tile would be upside down), an image as a canvas. */
async function night(img: Tile): Promise<Tile> {
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const ctx = c.getContext('2d', { willReadFrequently: !canvasFilter })
  if (ctx === null) return img
  if (canvasFilter) {
    ctx.filter = NIGHT_FILTER
    ctx.drawImage(img, 0, 0)
  } else {
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, c.width, c.height)
    nightPixels(data.data)
    ctx.putImageData(data, 0, 0)
  }
  if (!(typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap)) return c
  img.close() // drawn: Cesium never closes the bitmaps it decoded, and this one is not handed on
  const out = await createImageBitmap(c)
  c.width = c.height = 0 // its pixels are in the bitmap: free the canvas now, not at the next collection
  return out
}

/** The OpenStreetMap tiles in the dark theme's colours (see NIGHT_FILTER). */
export class NightOsmProvider extends OpenStreetMapImageryProvider {
  override requestImage(x: number, y: number, level: number, request?: Request): Promise<Tile> | undefined {
    return super.requestImage(x, y, level, request)?.then(night)
  }
}

/** The rows of a w-pixel-wide RGBA image in reverse order, in place. */
function flipRows(px: Uint8ClampedArray, w: number, h: number): void {
  const row = w * 4
  const tmp = new Uint8ClampedArray(row)
  for (let y = 0; y < h >> 1; y++) {
    const top = px.subarray(y * row, (y + 1) * row)
    const bottom = px.subarray((h - 1 - y) * row, (h - y) * row)
    tmp.set(top)
    top.set(bottom)
    bottom.set(tmp)
  }
}

/**
 * A tile reduced to its ink, as straight-alpha ImageData: every pixel in the map's own colour (the clear ones too: a canvas
 * would premultiply theirs away, and Cesium's filtering would then draw a dark rim where the ink fades out), its alpha from
 * inkAlpha of the original colours, and in the dark theme recoloured by nightPixels (never the canvas filter: one set of
 * sums in every browser). Cesium flips ImageData as it uploads it, so it goes back north-up: its bitmaps come already
 * flipped for WebGL (see night), so a bitmap is turned back, and closed once drawn.
 * ponytail: a view's tiles arriving together from the cache cost a few milliseconds of the main thread each (inkAlpha, and
 * nightPixels in the dark theme). Upgrade: draw them through radar.ts' queueDraw, a few milliseconds a frame.
 */
function ink(img: Tile, dark: boolean): ImageData {
  const { width: w, height: h } = img
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx?.drawImage(img, 0, 0)
  const bitmap = typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap
  if (bitmap) img.close() // drawn, or not wanted: Cesium never closes the bitmaps it decoded, and this one is not handed on
  if (ctx === null) return new ImageData(1, 1) // nothing drawn: the map's own tile here would cover the rain
  const tile = ctx.getImageData(0, 0, w, h)
  c.width = c.height = 0 // its pixels are in tile: free the canvas now, not at the next collection
  const px = tile.data
  const alpha = inkAlpha(px, w, h)
  if (dark) nightPixels(px)
  for (let i = 0; i < alpha.length; i++) px[i * 4 + 3] = alpha[i]
  if (bitmap) flipRows(px, w, h)
  return tile
}

/** The OpenStreetMap tiles reduced to their ink (see ink), in the light map's colours or the dark theme's. */
export class InkOsmProvider extends OpenStreetMapImageryProvider {
  readonly dark: boolean

  constructor(options: OpenStreetMapImageryProvider.ConstructorOptions, dark: boolean) {
    super(options)
    this.dark = dark
  }

  // ImageData is not among Cesium's ImageryTypes, but its Texture takes it (RadarProvider hands it over the same way).
  override requestImage(x: number, y: number, level: number, request?: Request): Promise<Tile> | undefined {
    return super.requestImage(x, y, level, request)?.then((img) => ink(img, this.dark) as unknown as Tile)
  }
}

export interface MapLayer {
  show: boolean
  destroy(): void
}

/**
 * Calls done once the globe's tiles are all in, at least one rendered frame from now: a layer just shown has no tiles
 * yet, and only that frame queues them. For a swap that keeps the old layer until the new one can stand alone. Returns
 * the call that stops waiting.
 */
export function whenTilesLoaded(scene: Scene, done: () => void): () => void {
  let frames = 0
  const stop = scene.postRender.addEventListener(() => {
    if (frames++ < 1 || !scene.globe.tilesLoaded) return
    stop()
    done()
  })
  return stop
}

/**
 * The street map: show, and dark picks its theme. Only the shown theme's layers load tiles. lift draws the map's ink (see
 * the header) again, over the layers added at liftIndex: the weather radar lies there, under the names. Over the satellite
 * (show false) there is no map, so no ink.
 */
export interface StreetMap extends MapLayer {
  dark: boolean
  lift: boolean
  /** Where a layer goes to lie over the map and under its ink: the light ink layer's place. */
  readonly liftIndex: number
}

/**
 * Adds the street map on top of the viewer's imagery (the satellite base layer stays underneath). It starts shown, because
 * the app starts in browse: set show = false for chase. url replaces the OSM tile server ({z}/{x}/{y}.png is appended).
 */
export function makeMapLayer(viewer: Viewer, url: string = OSM_URL): StreetMap {
  const osm = { url, maximumLevel: OSM_MAX_ZOOM, credit: new Credit(OSM_CREDIT_HTML, true) }
  const layer = viewer.imageryLayers.addImageryProvider(new OpenStreetMapImageryProvider(osm))
  layer.brightness = BRIGHTNESS
  layer.saturation = SATURATION
  const layers = viewer.imageryLayers
  const shown = (ls: ImageryLayer[], v: boolean): void => ls.forEach((l) => (l.show = v))
  const darkLayers = [layers.addImageryProvider(new NightOsmProvider(osm))]
  shown(darkLayers, false) // shown by default: that would read as a swap from dark
  // The ink of each theme right after the dark map, light first: a layer added at liftIndex lies over the map and under them.
  const lightInk = layers.addImageryProvider(new InkOsmProvider(osm, false))
  lightInk.brightness = BRIGHTNESS // the map's own, so that the two are one picture where no rain falls
  lightInk.saturation = SATURATION
  const darkInk = layers.addImageryProvider(new InkOsmProvider(osm, true))
  shown([lightInk, darkInk], false) // lift shows one
  const light = [layer]
  let show = true
  let dark = false
  let lift = false
  let stopWait: (() => void) | null = null
  let stopInkWait: (() => void) | null = null
  const apply = (): void => {
    stopWait?.()
    stopWait = null
    const [on, off] = dark ? [darkLayers, light] : [light, darkLayers]
    if (!show || !off[0].show) { // the other theme is not on screen: nothing to keep
      shown(off, false)
      return shown(on, show)
    }
    // A swap on screen: a newly shown layer has no tiles yet, so the old theme stays under it until they are in, or
    // the satellite shows through. The new theme goes on top (the two layers are adjacent). ponytail: while the camera
    // keeps moving the queue never empties and both themes load; the new one is on top, so it only costs tiles.
    if (dark) while (layers.indexOf(layer) > layers.indexOf(darkLayers[0])) layers.lower(layer)
    else while (layers.indexOf(layer) < layers.indexOf(darkLayers[0])) layers.raise(layer)
    shown(on, true)
    stopWait = whenTilesLoaded(viewer.scene, () => {
      stopWait = null
      shown(off, false)
    })
  }
  // The ink swaps themes as the map does: the old ink stays until the new one's tiles are in, or the names would fall under
  // the rain for as long as they load. A wait of its own, so that lift never restarts the map's.
  const applyInk = (): void => {
    stopInkWait?.()
    stopInkWait = null
    const [on, off] = dark ? [darkInk, lightInk] : [lightInk, darkInk]
    const wanted = show && lift
    if (!wanted || !off.show) { // the other theme's ink is not on screen: nothing to keep
      off.show = false
      on.show = wanted
      return
    }
    on.show = true
    stopInkWait = whenTilesLoaded(viewer.scene, () => {
      stopInkWait = null
      off.show = false
    })
  }
  apply()
  return {
    get show(): boolean {
      return show
    },
    set show(v: boolean) {
      show = v
      apply()
      applyInk()
    },
    get dark(): boolean {
      return dark
    },
    set dark(v: boolean) {
      dark = v
      apply()
      applyInk()
    },
    get lift(): boolean {
      return lift
    },
    set lift(v: boolean) {
      lift = v
      applyInk()
    },
    get liftIndex(): number {
      return layers.indexOf(lightInk)
    },
    destroy(): void {
      stopWait?.()
      stopWait = null
      stopInkWait?.()
      stopInkWait = null
      layers.remove(layer, true) // a second call finds nothing to remove
      for (const l of [...darkLayers, lightInk, darkInk]) layers.remove(l, true)
    },
  }
}

// Over the satellite: Esri's two reference overlays (transparent PNG), each with a switch of its own: roads
// (World_Transportation) and borders and place names (World_Boundaries_and_Places). Keyless on services.arcgisonline.com
// with CORS * (checked 2026-09-30; the keyed ibasemaps endpoint has no reference layers). Their detail follows the zoom:
// motorways and countries far out, every street and neighbourhood up close.
// Copyright (their MapServer?f=json): Esri, HERE, Garmin, (c) OpenStreetMap contributors. No credit on screen (the user's call).
export const ROADS_URL = 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}'
export const PLACES_URL = 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'
const REFERENCE_MAX_ZOOM = 19 // street detail ends here; Cesium upsamples past it

/** The two overlays, apart. */
export interface ReferenceLayers {
  roads: MapLayer
  places: MapLayer
}

/**
 * The reference overlays on top of every imagery layer added before them, the places above the roads (names over the
 * streets). Each starts hidden (a hidden layer loads nothing).
 */
export function makeReferenceLayers(viewer: Viewer): ReferenceLayers {
  const overlay = (url: string): MapLayer => {
    const l = viewer.imageryLayers.addImageryProvider(new UrlTemplateImageryProvider({ url, maximumLevel: REFERENCE_MAX_ZOOM }))
    l.show = false
    return {
      get show(): boolean {
        return l.show
      },
      set show(v: boolean) {
        l.show = v
      },
      destroy(): void {
        viewer.imageryLayers.remove(l, true) // a second call finds nothing to remove
      },
    }
  }
  return { roads: overlay(ROADS_URL), places: overlay(PLACES_URL) }
}

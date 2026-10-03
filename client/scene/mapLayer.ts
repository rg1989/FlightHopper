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
import { Credit, ImageryLayer, OpenStreetMapImageryProvider, RequestState, UrlTemplateImageryProvider } from 'cesium'
import type { ImageryProvider, Request, Scene, Viewer } from 'cesium'
import { BordersProvider } from './borders.ts'
import { queueDraw } from './drawQueue.ts'

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

// Labels over the weather: the map's names, lines and icons are baked into its tiles, so rain drawn over the map covers
// them. A second copy of each theme's tiles keeps only their ink (inkAlpha) and is transparent elsewhere. Lifted
// (StreetMap.lift) it lies over the radar: where no rain falls it draws what the map under it already shows, so it cannot be
// seen, and under rain the names stay crisp. It asks for the map's own tile URLs (the browser's cache has them), only while
// lifted: no prefetch. A tile's drawing is one job in drawQueue's frame budget, so a view's tiles arriving together fill in
// over a few frames instead of stalling one; and the ink follows the map's theme at once: it lies over a complete map, so at
// worst its names are missing for a moment, where holding the old theme's ink would show it over the new map.
//
// Ink: dark pixels of the light (original) tile, and a halo one pixel round them.
const INK_DARK = 0.42 // luminance at or below: ink
const INK_LIGHT = 0.62 // at or above: not ink (fills: land 0.94, water 0.80, parks 0.93, forest 0.78, buildings 0.82)
const HALO = 0.85

// Scratch for inkAlpha, grown as tiles need it and reused: a call fills what it reads.
let share = new Float32Array(0) // each pixel's own ink, 0–1
let across = new Float32Array(0) // the most of it in each pixel and its left and right neighbours

/**
 * The ink share (0–255) of each pixel of a w × h RGBA tile in the light map's own colours. The halo is the most ink in the
 * 3 × 3 round a pixel, taken as the most of each three along the rows (across), then of three of those down the columns: the
 * whole window's answer in six reads a pixel instead of nine.
 * ponytail: a halo stops at its tile's edge, so a name crossing a seam has a pixel's gap in its halo there. Upgrade: read the
 * neighbouring tiles' edge rows.
 */
export function inkAlpha(px: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const n = w * h
  if (share.length < n) {
    share = new Float32Array(n)
    across = new Float32Array(n)
  }
  const t = share
  for (let i = 0; i < n; i++) {
    const lum = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255
    t[i] = lum <= INK_DARK ? 1 : lum >= INK_LIGHT ? 0 : (INK_LIGHT - lum) / (INK_LIGHT - INK_DARK)
  }
  for (let y = 0; y < h; y++) {
    const r = y * w
    for (let x = 0; x < w; x++) {
      let m = t[r + x]
      if (x > 0 && t[r + x - 1] > m) m = t[r + x - 1]
      if (x < w - 1 && t[r + x + 1] > m) m = t[r + x + 1]
      across[r + x] = m
    }
  }
  const out = new Uint8Array(n)
  for (let y = 0; y < h; y++) {
    const r = y * w
    for (let x = 0; x < w; x++) {
      let halo = across[r + x]
      if (y > 0 && across[r + x - w] > halo) halo = across[r + x - w]
      if (y < h - 1 && across[r + x + w] > halo) halo = across[r + x + w]
      out[r + x] = Math.round(Math.max(t[r + x], HALO * halo) * 255)
    }
  }
  return out
}

type Tile = Awaited<NonNullable<ReturnType<OpenStreetMapImageryProvider['requestImage']>>>
const isBitmap = (img: Tile): img is ImageBitmap => typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap
// Checked on the prototype: a context without the property (Safari) would keep a string assigned to it all the same. Asked as
// each tile comes in, so that a test can give the page a canvas with a filter.
const canvasFilter = (): boolean => typeof CanvasRenderingContext2D !== 'undefined' && 'filter' in CanvasRenderingContext2D.prototype

/** A tile drawn in NIGHT_FILTER's colours. Cesium asks for ImageBitmaps already flipped for WebGL and flips a canvas as it
 *  uploads it: a bitmap goes back as a bitmap (else the tile would be upside down), an image as a canvas. */
async function night(img: Tile): Promise<Tile> {
  const filtered = canvasFilter()
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const ctx = c.getContext('2d', { willReadFrequently: !filtered })
  if (ctx === null) return img
  if (filtered) {
    ctx.filter = NIGHT_FILTER
    ctx.drawImage(img, 0, 0)
  } else {
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, c.width, c.height)
    nightPixels(data.data)
    ctx.putImageData(data, 0, 0)
  }
  if (!isBitmap(img)) return c
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
 * inkAlpha of the original colours. The dark theme's colours are the dark map's: where the canvas has a filter, the tile is
 * drawn a second time through NIGHT_FILTER and its colours taken from that, exactly what the dark map shows in that browser;
 * where it has none (Safari), nightPixels does the same sums on the original's. The alpha is the original's either way.
 * Cesium flips ImageData as it uploads it, so it goes back north-up: its bitmaps come already flipped for WebGL (see night),
 * so a bitmap's rows are turned back. It takes the bitmap open and leaves it open: the provider closes it.
 */
function ink(img: Tile, dark: boolean): ImageData {
  const { width: w, height: h } = img
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (ctx === null) return new ImageData(1, 1) // nothing drawn: the map's own tile here would cover the rain
  ctx.drawImage(img, 0, 0)
  let tile = ctx.getImageData(0, 0, w, h)
  const alpha = inkAlpha(tile.data, w, h)
  if (dark && canvasFilter()) {
    ctx.clearRect(0, 0, w, h)
    ctx.filter = NIGHT_FILTER
    ctx.drawImage(img, 0, 0)
    tile = ctx.getImageData(0, 0, w, h)
  } else if (dark) {
    nightPixels(tile.data)
  }
  c.width = c.height = 0 // its pixels are in tile: free the canvas now, not at the next collection
  const px = tile.data
  for (let i = 0; i < alpha.length; i++) px[i * 4 + 3] = alpha[i]
  if (isBitmap(img)) flipRows(px, w, h)
  return tile
}

/**
 * The OpenStreetMap tiles reduced to their ink (see ink), in the light map's colours or the dark theme's. A tile is drawn in
 * its turn in drawQueue's frames, unless live() (its layer is still shown) is false by then: it is dropped undrawn.
 */
export class InkOsmProvider extends OpenStreetMapImageryProvider {
  readonly dark: boolean
  private readonly live: () => boolean

  constructor(options: OpenStreetMapImageryProvider.ConstructorOptions, dark: boolean, live: () => boolean) {
    super(options)
    this.dark = dark
    this.live = live
  }

  override requestImage(x: number, y: number, level: number, request?: Request): Promise<Tile> | undefined {
    const got = super.requestImage(x, y, level, request)
    return got === undefined ? undefined : this.inked(got, request)
  }

  // The tile's drawing is a drawQueue job. A dropped one is a cancelled request to Cesium, which asks again later and logs
  // nothing, as for RadarProvider's; any other failure it logs.
  private async inked(got: Promise<Tile>, request?: Request): Promise<Tile> {
    const img = await got
    try {
      // ImageData is not among Cesium's ImageryTypes, but its Texture takes it (RadarProvider hands it over the same way).
      return (await queueDraw(() => ink(img, this.dark), this.live)) as unknown as Tile
    } catch (e) {
      if (!this.live() && request !== undefined) (request as { state: RequestState }).state = RequestState.CANCELLED
      throw e
    } finally {
      if (isBitmap(img)) img.close() // drawn, or not wanted: Cesium never closes the bitmaps it decoded, and this one is not handed on
    }
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
  /**
   * Where a layer goes to lie over the map and under its ink: the light ink layer's place. -1 once the map is destroyed
   * (that layer is gone): a caller then adds on top, as Cesium's add throws on a negative index in a debug build.
   */
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
  // A tile of one still waiting to be drawn when it is hidden or destroyed is dropped.
  const inkLayer = (isDark: boolean): ImageryLayer => {
    const l: ImageryLayer = layers.addImageryProvider(new InkOsmProvider(osm, isDark, () => l.show && !l.isDestroyed()))
    l.show = false // lift shows one
    return l
  }
  const lightInk = inkLayer(false)
  lightInk.brightness = BRIGHTNESS // the map's own, so that the two are one picture where no rain falls
  lightInk.saturation = SATURATION
  const darkInk = inkLayer(true)
  const light = [layer]
  let show = true
  let dark = false
  let lift = false
  let stopWait: (() => void) | null = null
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
  // The current theme's ink while the weather lifts it over a map on screen, else none; a swap is at once (see the header).
  const applyInk = (): void => {
    const wanted = show && lift
    lightInk.show = wanted && !dark
    darkInk.show = wanted && dark
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
// In the chase (ReferenceLayers.chase) each switch shows a version made for a 3-D view. Esri's rasters are drawn for
// top-down zooms: on the far, low-detail terrain tiles their roads are wide bands, and their names lie on the ground, blurred
// and turned with the map. So the chase's roads are the same raster on near terrain tiles only, its borders our own thin
// lines (borders.ts), and its names upright screen text (placeLabels.ts, shown by app.ts).
export const ROADS_URL = 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}'
export const PLACES_URL = 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'
const REFERENCE_MAX_ZOOM = 19 // street detail ends here; Cesium upsamples past it
// The chase's roads lie on terrain tiles at least this detailed (a level-12 tile is ~5 km a side): near the camera. Tuned by eye.
export const CHASE_ROADS_MIN_TERRAIN_LEVEL = 12

/** The two overlays, apart. */
export interface ReferenceLayers {
  roads: MapLayer
  places: MapLayer
  /** The chase's versions in place of the top-down ones (app.ts sets it from the view): near roads, our borders, no places raster. */
  chase: boolean
}

/**
 * The reference overlays on top of every imagery layer added before them: the roads (top-down, then the chase's), and the
 * places raster and the chase's borders above them (lines and names over the streets). Each starts hidden (a hidden layer
 * loads nothing). bordersUrl: public/map/borders.json, fetched at the borders' first show.
 */
export function makeReferenceLayers(viewer: Viewer, bordersUrl: string): ReferenceLayers {
  const layers = viewer.imageryLayers
  const add = (provider: ImageryProvider, options?: ImageryLayer.ConstructorOptions): ImageryLayer => {
    const l = new ImageryLayer(provider, options)
    l.show = false
    layers.add(l)
    return l
  }
  const esri = (url: string): UrlTemplateImageryProvider => new UrlTemplateImageryProvider({ url, maximumLevel: REFERENCE_MAX_ZOOM })
  const roads = add(esri(ROADS_URL))
  const chaseRoads = add(esri(ROADS_URL), { minimumTerrainLevel: CHASE_ROADS_MIN_TERRAIN_LEVEL })
  const places = add(esri(PLACES_URL))
  // A tile still waiting to be drawn when the borders hide or go is dropped.
  const drawn = new BordersProvider(bordersUrl, () => borders.show && !borders.isDestroyed())
  const borders = add(drawn)
  let chase = false
  let wantRoads = false
  let wantPlaces = false
  const show = (l: ImageryLayer, v: boolean): void => {
    if (!l.isDestroyed()) l.show = v
  }
  const apply = (): void => {
    show(roads, wantRoads && !chase)
    show(chaseRoads, wantRoads && chase)
    show(places, wantPlaces && !chase)
    show(borders, wantPlaces && chase)
    if (wantPlaces && chase && !borders.isDestroyed()) void drawn.load() // the data at the first show; a no-op after
  }
  return {
    roads: {
      get show(): boolean {
        return wantRoads
      },
      set show(v: boolean) {
        wantRoads = v
        apply()
      },
      destroy(): void {
        layers.remove(roads, true) // a second call finds nothing to remove
        layers.remove(chaseRoads, true)
      },
    },
    places: {
      get show(): boolean {
        return wantPlaces
      },
      set show(v: boolean) {
        wantPlaces = v
        apply()
      },
      destroy(): void {
        layers.remove(places, true)
        layers.remove(borders, true)
      },
    },
    get chase(): boolean {
      return chase
    },
    set chase(v: boolean) {
      chase = v
      apply()
    },
  }
}

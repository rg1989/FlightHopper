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
import type { ImageryLayer, Request, Viewer } from 'cesium'

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
  return typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap ? createImageBitmap(c) : c
}

/** The OpenStreetMap tiles in the dark theme's colours (see NIGHT_FILTER). */
export class NightOsmProvider extends OpenStreetMapImageryProvider {
  override requestImage(x: number, y: number, level: number, request?: Request): Promise<Tile> | undefined {
    return super.requestImage(x, y, level, request)?.then(night)
  }
}

export interface MapLayer {
  show: boolean
  destroy(): void
}

/** The street map: show, and dark picks its theme. Only the shown theme's layers load tiles. */
export interface StreetMap extends MapLayer {
  dark: boolean
}

/**
 * Adds the street map on top of the viewer's imagery (the satellite base layer stays underneath). It starts shown, because
 * the app starts in browse: set show = false for chase. url replaces the OSM tile server ({z}/{x}/{y}.png is appended).
 */
export function makeMapLayer(viewer: Viewer, url: string = OSM_URL): StreetMap {
  const provider = new OpenStreetMapImageryProvider({ url, maximumLevel: OSM_MAX_ZOOM, credit: new Credit(OSM_CREDIT_HTML, true) })
  const layer = viewer.imageryLayers.addImageryProvider(provider)
  layer.brightness = BRIGHTNESS
  layer.saturation = SATURATION
  const layers = viewer.imageryLayers
  const shown = (ls: ImageryLayer[], v: boolean): void => ls.forEach((l) => (l.show = v))
  const darkLayers = [layers.addImageryProvider(new NightOsmProvider({ url, maximumLevel: OSM_MAX_ZOOM, credit: new Credit(OSM_CREDIT_HTML, true) }))]
  shown(darkLayers, false) // shown by default: that would read as a swap from dark
  const light = [layer]
  let show = true
  let dark = false
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
    let frames = 0
    stopWait = viewer.scene.postRender.addEventListener(() => {
      if (frames++ < 1 || !viewer.scene.globe.tilesLoaded) return
      shown(off, false)
      stopWait?.()
      stopWait = null
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
    },
    get dark(): boolean {
      return dark
    },
    set dark(v: boolean) {
      dark = v
      apply()
    },
    destroy(): void {
      stopWait?.()
      stopWait = null
      layers.remove(layer, true) // a second call finds nothing to remove
      for (const l of darkLayers) layers.remove(l, true)
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

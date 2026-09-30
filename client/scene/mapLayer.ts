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
import type { ImageryLayer, Viewer } from 'cesium'

export const OSM_URL = 'https://tile.openstreetmap.org/'
export const OSM_CREDIT_HTML = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
const OSM_MAX_ZOOM = 19 // the standard layer's deepest zoom; browse never zooms past ~z15 (MIN_ZOOM_M)
// Muted a little so the altitude-coloured icons (orange … magenta) stand out on the white and yellow streets.
const BRIGHTNESS = 0.85
const SATURATION = 0.6

// The dark theme: Esri's Dark Gray Canvas base, keyless on services.arcgisonline.com with CORS * like the roads overlays
// (checked 2026-09-30; CARTO's Dark Matter now watermarks keyless tiles), lifted a little off the sea. Its own labels
// are dim grey and skip towns at region zooms, so the places overlay (below) labels it instead, greyed and dimmed so its
// borders do not glare. Copyright: Esri, HERE, Garmin, (c) OpenStreetMap contributors.
const PLACES_URL = 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'
export const DARK_URLS = [
  'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  PLACES_URL,
]
const DARK_MAX_ZOOM = 16 // the canvas has no detail past it; Cesium upsamples (browse stops near z15)
const DARK_BASE_BRIGHTNESS = 1.2
const DARK_LABEL_BRIGHTNESS = 0.8
const DARK_LABEL_SATURATION = 0 // cream → grey-white

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
  const darkLayers = DARK_URLS.map((u, i) =>
    layers.addImageryProvider(new UrlTemplateImageryProvider({ url: u, maximumLevel: i === 0 ? DARK_MAX_ZOOM : ROADS_MAX_ZOOM })))
  shown(darkLayers, false) // shown by default: that would read as a swap from dark
  darkLayers[0].brightness = DARK_BASE_BRIGHTNESS
  darkLayers[1].brightness = DARK_LABEL_BRIGHTNESS
  darkLayers[1].saturation = DARK_LABEL_SATURATION
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
    // the satellite shows through. The new theme goes on top (the three layers are adjacent: the light one moves past
    // the dark two). ponytail: while the camera keeps moving the queue never empties and both themes load; the new one
    // is on top, so it only costs tiles.
    if (dark) while (layers.indexOf(layer) > layers.indexOf(darkLayers[0])) layers.lower(layer)
    else while (layers.indexOf(layer) < layers.indexOf(darkLayers[1])) layers.raise(layer)
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

// Roads and place names over the satellite: Esri's two reference overlays (transparent PNG), keyless on
// services.arcgisonline.com with CORS * (checked 2026-09-30; the keyed ibasemaps endpoint has no reference layers).
// Their detail follows the zoom: motorways and countries far out, every street and neighbourhood up close.
// Copyright (their MapServer?f=json): Esri, HERE, Garmin, (c) OpenStreetMap contributors. No credit on screen (the user's call).
export const ROADS_URLS = [
  'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
  PLACES_URL,
]
const ROADS_MAX_ZOOM = 19 // street detail ends here; Cesium upsamples past it

/** The roads-and-places overlay, on top of every imagery layer added before it. Starts hidden (a hidden layer loads nothing). */
export function makeRoadsLayer(viewer: Viewer): MapLayer {
  const layers = ROADS_URLS.map((url) => {
    const l = viewer.imageryLayers.addImageryProvider(new UrlTemplateImageryProvider({ url, maximumLevel: ROADS_MAX_ZOOM }))
    l.show = false
    return l
  })
  return {
    get show(): boolean {
      return layers[0].show
    },
    set show(v: boolean) {
      for (const l of layers) l.show = v
    },
    destroy(): void {
      for (const l of layers) viewer.imageryLayers.remove(l, true)
    },
  }
}

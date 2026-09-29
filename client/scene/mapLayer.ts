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
import type { Viewer } from 'cesium'

export const OSM_URL = 'https://tile.openstreetmap.org/'
export const OSM_CREDIT_HTML = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
const OSM_MAX_ZOOM = 19 // the standard layer's deepest zoom; browse never zooms past ~z15 (MIN_ZOOM_M)
// Muted a little so the altitude-coloured icons (orange … magenta) stand out on the white and yellow streets.
const BRIGHTNESS = 0.85
const SATURATION = 0.6

export interface MapLayer {
  show: boolean
  destroy(): void
}

/**
 * Adds the street map on top of the viewer's imagery (the satellite base layer stays underneath). It starts shown, because
 * the app starts in browse: set show = false for chase. url replaces the OSM tile server ({z}/{x}/{y}.png is appended).
 */
export function makeMapLayer(viewer: Viewer, url: string = OSM_URL): MapLayer {
  const provider = new OpenStreetMapImageryProvider({ url, maximumLevel: OSM_MAX_ZOOM, credit: new Credit(OSM_CREDIT_HTML, true) })
  const layer = viewer.imageryLayers.addImageryProvider(provider)
  layer.brightness = BRIGHTNESS
  layer.saturation = SATURATION
  return {
    get show(): boolean {
      return layer.show
    },
    set show(v: boolean) {
      layer.show = v
    },
    destroy(): void {
      viewer.imageryLayers.remove(layer, true) // a second call finds nothing to remove
    },
  }
}

// Roads and place names over the satellite: Esri's two reference overlays (transparent PNG), keyless on
// services.arcgisonline.com with CORS * (checked 2026-09-30; the keyed ibasemaps endpoint has no reference layers).
// Their detail follows the zoom: motorways and countries far out, every street and neighbourhood up close.
// Copyright (their MapServer?f=json): Esri, HERE, Garmin, (c) OpenStreetMap contributors. No credit on screen (the user's call).
export const ROADS_URLS = [
  'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
  'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
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

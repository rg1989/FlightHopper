// client/scene/imagery.ts
import {
  Credit,
  ImageryLayer,
  Ion,
  UrlTemplateImageryProvider,
  createWorldImageryAsync,
  type ImageryLayerCollection,
  type ImageryProvider,
  type TileProviderError,
} from 'cesium'
import type { ClientConfig } from '../types.ts'

// EOxCloudless (Sentinel-2 cloudless) by EOX: keyless WMTS in WebMercator (tile matrix set 'g').
// Layers and attribution text: https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml (checked 2026-09-22).
// Licence: https://cloudless.eox.at/license-non-commercial — the 2018–2025 layers are CC BY-NC-SA 4.0
// (non-commercial only). The 2016 layer `s2cloudless_3857` is CC BY 4.0. The attribution must be legible
// and near the map, so the credit is shown on screen.
// ponytail: newest non-commercial layer; the commercial path is the 2016 CC BY layer or an EOX commercial licence.
export const EOX_YEAR = 2025
export const EOX_URL = `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${EOX_YEAR}_3857/default/g/{z}/{y}/{x}.jpg`
export const EOX_ATTRIBUTION = `EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data ${EOX_YEAR})`

// Esri World Imagery through ArcGIS Location Platform: an API key with the "Basemap styles service" privilege.
// 2M basemap tiles/month free, then $0.15 per 1,000 (https://location.arcgis.com/pricing/, checked 2026-09-23).
// Attribution: "Powered by Esri" + the service's copyrightText (…/World_Imagery/MapServer?f=json, same date), on screen.
// Where Esri has no deeper tile the keyed endpoint answers 404, and Cesium keeps drawing the parent tile.
// ponytail: zoom 19 = 0.3 m at LLBG, where z20+ is 404. Some metros go deeper: raise the cap if that matters there.
export const ESRI_URL = 'https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
export const ESRI_ATTRIBUTION =
  'Powered by Esri | Source: Esri, Vantor, GeoEye, Earthstar Geographics, CNES/Airbus DS, USDA, USGS, AeroGRID, IGN, and the GIS User Community'

/** EOX Sentinel-2: the keyless imagery, and Esri's fallback. */
export function eoxProvider(): UrlTemplateImageryProvider {
  return new UrlTemplateImageryProvider({
    url: EOX_URL,
    // Sentinel-2 is 10 m/px ≈ zoom 14. EOX serves deeper tiles, but they are only upsampled,
    // so stopping here saves requests; Cesium upsamples on the client.
    maximumLevel: 14,
    credit: new Credit(EOX_ATTRIBUTION.replace('https://cloudless.eox.at', '<a href="https://cloudless.eox.at" target="_blank">$&</a>'), true),
  })
}

/** What the base imagery is and, when it is EOX in place of Esri, why: for the on-screen badge. */
export interface ImageryStatus {
  source: ClientConfig['imagery']
  fallback: string | null
}

export function imageryStatus(cfg: ClientConfig): ImageryStatus {
  return { source: cfg.imagery, fallback: cfg.imagery === 'eox' && !cfg.arcgisKey ? 'no key' : null }
}

const statusOf = (e: TileProviderError): number | undefined => (e.error as { statusCode?: number } | undefined)?.statusCode

/**
 * Esri failing, as opposed to a 404 for "no deeper tile here". Checked 2026-09-23: the tile endpoint serves any
 * non-empty token (so a wrong key alone does not fail), and a missing token gets HTTP 200 with a JSON error, which
 * Cesium reports as an undecodable image with no status. Both that and a network failure count as failing.
 */
const esriBroken = (e: TileProviderError): boolean => statusOf(e) !== 404

/**
 * Esri → EOX when Esri fails (esriBroken): a bad or expired key, a used-up quota, the service or the network down. Puts EOX where the Esri layer was and reports the new layer and why, once.
 * ponytail: one strike for the rest of the session, so a passing 5xx switches too. Reload to try Esri again.
 */
export function eoxOnEsriFailure(layers: ImageryLayerCollection, esri: ImageryLayer, onSwap: (eox: ImageryLayer, why: string) => void): void {
  const events = esri.imageryProvider.errorEvent
  const onError = (e: TileProviderError): void => {
    if (!esriBroken(e)) return
    const code = statusOf(e)
    events.removeEventListener(onError)
    const eox = new ImageryLayer(eoxProvider())
    const at = Math.max(0, layers.indexOf(esri))
    layers.remove(esri)
    layers.add(eox, at)
    onSwap(eox, code ? `Esri HTTP ${code}` : 'Esri unreachable')
  }
  events.addEventListener(onError)
}

/**
 * Base imagery for the configured source, or null for none.
 * ion = Bing Maps Aerial via ion (Community plan: 1,000 imagery sessions/month).
 */
export async function makeImagery(cfg: ClientConfig): Promise<ImageryProvider | null> {
  if (cfg.imagery === 'ion') {
    if (cfg.ionToken) Ion.defaultAccessToken = cfg.ionToken
    return createWorldImageryAsync()
  }
  if (cfg.imagery === 'esri') {
    const p = new UrlTemplateImageryProvider({
      url: `${ESRI_URL}?token=${cfg.arcgisKey}`,
      maximumLevel: 19,
      credit: new Credit(ESRI_ATTRIBUTION.replace('Esri', '<a href="https://www.esri.com" target="_blank">Esri</a>'), true),
    })
    // A listener replaces Cesium's console.log of every failed tile: keep the 404s quiet, show the rest (a bad key is 498/499).
    p.errorEvent.addEventListener((e) => {
      if (esriBroken(e)) console.warn(e.message)
    })
    return p
  }
  if (cfg.imagery === 'eox') return eoxProvider()
  return null
}

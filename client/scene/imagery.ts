// client/scene/imagery.ts
import { Credit, Ion, UrlTemplateImageryProvider, createWorldImageryAsync, type ImageryProvider } from 'cesium'
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

/**
 * Base imagery for the configured source, or null for none.
 * ion = Bing Maps Aerial via ion (Community plan: 1,000 imagery sessions/month).
 */
export async function makeImagery(cfg: ClientConfig): Promise<ImageryProvider | null> {
  if (cfg.imagery === 'ion') {
    if (cfg.ionToken) Ion.defaultAccessToken = cfg.ionToken
    return createWorldImageryAsync()
  }
  if (cfg.imagery === 'eox') {
    return new UrlTemplateImageryProvider({
      url: EOX_URL,
      // Sentinel-2 is 10 m/px ≈ zoom 14. EOX serves deeper tiles, but they are only upsampled,
      // so stopping here saves requests; Cesium upsamples on the client.
      maximumLevel: 14,
      credit: new Credit(EOX_ATTRIBUTION.replace('https://cloudless.eox.at', '<a href="https://cloudless.eox.at" target="_blank">$&</a>'), true),
    })
  }
  return null
}

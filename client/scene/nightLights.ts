// client/scene/nightLights.ts
import { Credit, ImageryLayer, UrlTemplateImageryProvider } from 'cesium'

// NASA GIBS WMTS: keyless, CORS *. VIIRS Black Marble (city lights), the 2016 composite, EPSG:3857, tile matrix set
// GoogleMapsCompatible_Level8 (z ≤ 8, z9 → HTTP 400). Checked 2026-09-22:
// https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml
// ponytail: level 8 is ~600 m/px at the equator, so at chase range the lights are a soft glow. No sharper keyless source.
export const NIGHT_URL =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png'
export const NIGHT_MAX_LEVEL = 8
// The acknowledgment GIBS asks clients to show: https://nasa-gibs.github.io/gibs-api-docs/
export const NIGHT_CREDIT =
  "VIIRS Black Marble 2016. We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS)."

/**
 * The city-lights layer, hidden and transparent: Sun fades it in at dusk (alpha = night) and shows it only while it is
 * visible, so daytime makes no GIBS requests. Brightness 1.6 lifts the lights over the darkened day layer.
 * Add it right above the day layer. Constructing it requests nothing.
 */
export function makeNightLayer(): ImageryLayer {
  const provider = new UrlTemplateImageryProvider({ url: NIGHT_URL, maximumLevel: NIGHT_MAX_LEVEL, credit: new Credit(NIGHT_CREDIT) })
  return new ImageryLayer(provider, { alpha: 0, show: false, brightness: 1.6 })
}

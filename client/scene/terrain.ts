// client/scene/terrain.ts
import { CesiumTerrainProvider, EllipsoidTerrainProvider, Ion, createWorldTerrainAsync, type TerrainProvider } from 'cesium'
import type { ClientConfig } from '../types.ts'

/**
 * Re:Earth Terrain: keyless quantized-mesh-1.0 with heights on the WGS84 ellipsoid
 * (Mapterhorn DEM + EGM2008 geoid, blended server-side). Its layer.json carries the attribution,
 * which Cesium shows as a credit. Source: https://github.com/reearth/reearth-terrain
 * Checked 2026-09-22: GET <url>/layer.json → 200, format quantized-mesh-1.0, maxzoom 14,
 * extensions octvertexnormals + watermask, CORS *.
 */
export const REEARTH_TERRAIN_URL = 'https://terrain.reearth.land/cesium-mesh/ellipsoid'

/**
 * Terrain for the configured source. All three put heights on the WGS84 ellipsoid (HAE), like RenderState.hM.
 * ion = Cesium World Terrain (asset 1; Community plan, 15 GB/month streaming).
 * Rejects when the terrain service cannot be reached: a scene on the wrong datum is worse than none.
 */
export async function makeTerrain(cfg: ClientConfig): Promise<TerrainProvider> {
  if (cfg.terrain === 'ion') {
    if (cfg.ionToken) Ion.defaultAccessToken = cfg.ionToken
    return createWorldTerrainAsync()
  }
  if (cfg.terrain === 'reearth') return CesiumTerrainProvider.fromUrl(REEARTH_TERRAIN_URL)
  return new EllipsoidTerrainProvider()
}

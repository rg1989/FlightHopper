// client/scene/terrain.ts
import { CesiumTerrainProvider, EllipsoidTerrainProvider, Ion, Resource, createWorldTerrainAsync, type TerrainProvider } from 'cesium'
import type { ClientConfig } from '../types.ts'

/**
 * Re:Earth Terrain: keyless quantized-mesh-1.0 with heights on the WGS84 ellipsoid
 * (Mapterhorn DEM + EGM2008 geoid, blended server-side). Its layer.json carries the attribution,
 * which Cesium shows as a credit. Source: https://github.com/reearth/reearth-terrain
 * Checked 2026-09-22: GET <url>/layer.json → 200, format quantized-mesh-1.0, maxzoom 14,
 * extensions octvertexnormals + watermask, CORS *.
 */
export const REEARTH_TERRAIN_URL = 'https://terrain.reearth.land/cesium-mesh/ellipsoid'

/** Why a Cesium ion request failed, for a fallback's warning: its HTTP status, never the error (its URL has the token). */
export function ionWhy(e: unknown): string {
  const code = (e as { statusCode?: unknown } | null)?.statusCode
  return typeof code === 'number' ? `ion HTTP ${code}` : 'ion unreachable'
}

/**
 * Terrain for the configured source. All three put heights on the WGS84 ellipsoid (HAE), like RenderState.hM.
 * ion = Cesium World Terrain (asset 1; Community plan, 15 GB/month streaming). ion failing (a token refused: bad,
 * expired, revoked; or ion down) falls back to Re:Earth, on the same datum, and onFallback hears why.
 * Both remote sources send per-vertex normals, which sun lighting needs to shade slopes. No water mask: it adds 64 KB
 * to every tile with both land and water. A provider's normals are fixed when it is built, and nothing rebuilds it
 * (the topography toggle animates scene.verticalExaggeration instead).
 * Rejects when Re:Earth cannot be reached: a scene on the wrong datum is worse than none.
 */
export async function makeTerrain(cfg: ClientConfig, onFallback?: (why: string) => void): Promise<TerrainProvider> {
  if (cfg.terrain === 'ion') {
    if (cfg.ionToken) Ion.defaultAccessToken = cfg.ionToken
    try {
      return await createWorldTerrainAsync({ requestVertexNormals: true }) // ion requests extensions in the URL query itself
    } catch (e) {
      const why = ionWhy(e)
      console.warn(`FlightHopper: Cesium World Terrain unavailable (${why}); using Re:Earth terrain`)
      onFallback?.(why)
      return reearthTerrain()
    }
  }
  if (cfg.terrain === 'reearth') return reearthTerrain()
  return new EllipsoidTerrainProvider()
}

function reearthTerrain(): Promise<TerrainProvider> {
  // Cesium requests extensions from other servers in the Accept header. Re:Earth varies the tile body by it but
  // sends no Vary header and lets browsers cache tiles for 30 days, so a browser could hand back tiles it cached
  // without normals. The query (which Re:Earth honours too) gives the normals tiles their own URLs: Cesium keeps
  // it on layer.json and on every tile it derives.
  const url = new Resource({ url: REEARTH_TERRAIN_URL, queryParameters: { extensions: 'octvertexnormals' } })
  return CesiumTerrainProvider.fromUrl(url, { requestVertexNormals: true })
}

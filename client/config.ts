// client/config.ts
import type { ClientConfig } from './types.ts'

const TERRAINS: readonly ClientConfig['terrain'][] = ['ion', 'reearth', 'ellipsoid']
const IMAGERIES: readonly ClientConfig['imagery'][] = ['ion', 'esri', 'eox', 'none']

/** Vite turns `VITE_X=` into '', so blank counts as unset. */
const val = (v: string | undefined): string | null => (v === undefined || v.trim() === '' ? null : v.trim())

function oneOf<T extends string>(name: string, v: string | null, allowed: readonly T[], fallback: T): T {
  if (v === null) return fallback
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`${name}=${v}: expected ${allowed.join(' | ')}`)
  return v as T
}

/**
 * Client settings from Vite env (pass `import.meta.env`) or any string map.
 * Without VITE_CESIUM_ION_TOKEN the defaults are keyless: Re:Earth terrain + EOX Sentinel-2 imagery.
 * VITE_ARCGIS_KEY makes Esri World Imagery the default imagery, ahead of ion: Bing via ion bans tracking use.
 * Invalid values throw, and so does `ion` without a token: Cesium would otherwise fall back to its
 * built-in evaluation token, which is not ours to use. `esri` without a key throws too.
 */
export function readConfig(env: Record<string, string | undefined>): ClientConfig {
  const ionToken = val(env.VITE_CESIUM_ION_TOKEN)
  const terrain = oneOf('VITE_TERRAIN', val(env.VITE_TERRAIN), TERRAINS, ionToken ? 'ion' : 'reearth')
  const arcgisKey = val(env.VITE_ARCGIS_KEY)
  const imagery = oneOf('VITE_IMAGERY', val(env.VITE_IMAGERY), IMAGERIES, arcgisKey ? 'esri' : ionToken ? 'ion' : 'eox')
  if (!ionToken && (terrain === 'ion' || imagery === 'ion')) {
    throw new Error('VITE_TERRAIN/VITE_IMAGERY=ion needs VITE_CESIUM_ION_TOKEN (free Community token); or use reearth / eox')
  }
  if (!arcgisKey && imagery === 'esri') {
    throw new Error('VITE_IMAGERY=esri needs VITE_ARCGIS_KEY (free ArcGIS Location Platform API key); or use eox')
  }
  const apiBase = (val(env.VITE_API_BASE) ?? '/api').replace(/\/+$/, '')
  return { terrain, imagery, ionToken, arcgisKey, apiBase }
}

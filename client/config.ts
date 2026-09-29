// client/config.ts
import type { ClientConfig } from './types.ts'

/** Where the Settings dialog (ui/settings.ts) keeps the API keys saved in this browser: JSON { arcgisKey?, ionToken? }. */
export const KEYS_KEY = 'fh.keys.v1'

/** API keys saved in this browser; each wins over its build-time variable (readConfig). */
export interface SavedKeys {
  arcgisKey?: string
  ionToken?: string
}

/** Where readConfig takes a key from: this browser (Settings), the build's env (.env.local), or nowhere (keyless). */
export type KeySource = 'saved' | 'env' | 'none'

const TERRAINS: readonly ClientConfig['terrain'][] = ['ion', 'reearth', 'ellipsoid']
const IMAGERIES: readonly ClientConfig['imagery'][] = ['ion', 'esri', 'eox', 'none']

/** Vite turns `VITE_X=` into '', so blank counts as unset. */
const val = (v: string | undefined): string | null => (v === undefined || v.trim() === '' ? null : v.trim())

function oneOf<T extends string>(name: string, v: string | null, allowed: readonly T[], fallback: T): T {
  if (v === null) return fallback
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`${name}=${v}: expected ${allowed.join(' | ')}`)
  return v as T
}

/** The stored JSON (null: none) as SavedKeys: corrupt JSON, or a field that is not a non-blank string, counts as unset. */
export function readSavedKeys(stored: string | null): SavedKeys {
  let o: { arcgisKey?: unknown; ionToken?: unknown } | null = null
  try {
    o = stored === null ? null : JSON.parse(stored) // a number, string or array has no such fields: none saved
  } catch {
    // corrupt: none saved
  }
  const str = (v: unknown): string | null => (typeof v === 'string' ? val(v) : null)
  const arcgisKey = str(o?.arcgisKey)
  const ionToken = str(o?.ionToken)
  return { ...(arcgisKey === null ? {} : { arcgisKey }), ...(ionToken === null ? {} : { ionToken }) }
}

/** Stores the keys as JSON (none: the entry goes). false where storage is blocked or full: nothing was stored. */
export function writeSavedKeys(keys: SavedKeys, storage: Pick<Storage, 'setItem' | 'removeItem'> | null): boolean {
  try {
    if (storage === null) return false
    if (keys.arcgisKey === undefined && keys.ionToken === undefined) storage.removeItem(KEYS_KEY)
    else storage.setItem(KEYS_KEY, JSON.stringify(keys))
    return true
  } catch {
    return false
  }
}

/** Where readConfig(env, saved) takes each key from (saved > env > none). */
export function keySources(env: Record<string, string | undefined>, saved: SavedKeys): { arcgis: KeySource; ion: KeySource } {
  const from = (s: string | undefined, e: string | undefined): KeySource => (val(s) !== null ? 'saved' : val(e) !== null ? 'env' : 'none')
  return { arcgis: from(saved.arcgisKey, env.VITE_ARCGIS_KEY), ion: from(saved.ionToken, env.VITE_CESIUM_ION_TOKEN) }
}

/**
 * Client settings from Vite env (pass `import.meta.env`) or any string map, and the keys saved in this browser, which
 * win over the env's: saved > env > keyless, key by key.
 * Without an ion token the defaults are keyless: Re:Earth terrain + EOX Sentinel-2 imagery.
 * An ArcGIS key makes Esri World Imagery the default imagery, ahead of ion: Bing via ion bans tracking use.
 * Invalid values throw, and so does `ion` without a token: Cesium would otherwise fall back to its
 * built-in evaluation token, which is not ours to use. `esri` without a key throws too.
 */
export function readConfig(env: Record<string, string | undefined>, saved: SavedKeys = {}): ClientConfig {
  const ionToken = val(saved.ionToken) ?? val(env.VITE_CESIUM_ION_TOKEN)
  const terrain = oneOf('VITE_TERRAIN', val(env.VITE_TERRAIN), TERRAINS, ionToken ? 'ion' : 'reearth')
  const arcgisKey = val(saved.arcgisKey) ?? val(env.VITE_ARCGIS_KEY)
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

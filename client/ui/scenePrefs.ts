// client/ui/scenePrefs.ts
/**
 * The user's scene toggles (design D11) and map layers: the URL (?topo=0|1, ?light, ?glass, ?mapTop, ?mapChase, ?roads,
 * ?wx) wins over localStorage['fh.scene.v1'], which wins over the defaults (terrain and sun on, buildings solid, the street
 * map top-down and the satellite in the chase, no roads overlay, no weather). Pure: the app passes location.search, the stored string and the storage, so Node
 * tests need no DOM. Reading localStorage itself can throw (storage blocked), so the app guards that read.
 */
import type { ScenePrefs } from '../types.ts'

export const PREFS_KEY = 'fh.scene.v1'
export const DEFAULT_PREFS: ScenePrefs = Object.freeze({
  topo: true, light: true, glass: false, mapTop: true, mapChase: false, roads: false, wx: false,
})
export const PREF_KEYS = Object.keys(DEFAULT_PREFS) as (keyof ScenePrefs)[]

/** Only a real boolean counts; anything else (missing, 0, "false", null) keeps the fallback. */
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
/** ?k=0 → false, ?k=1 → true, any other value or none → the fallback. */
const flag = (v: string | null, fallback: boolean): boolean => (v === '0' ? false : v === '1' ? true : fallback)

/** URL > stored JSON > defaults, field by field. Corrupt or partial JSON falls back per field; never throws. */
export function readScenePrefs(search: string, stored: string | null): ScenePrefs {
  let saved: Partial<Record<keyof ScenePrefs, unknown>> | null = null
  try {
    saved = stored === null ? null : JSON.parse(stored) // a number, string or array has no such fields: defaults
  } catch {
    // corrupt: the defaults stand
  }
  const q = new URLSearchParams(search)
  const out = { ...DEFAULT_PREFS }
  for (const k of PREF_KEYS) out[k] = flag(q.get(k), bool(saved?.[k], DEFAULT_PREFS[k]))
  return out
}

/** Stores the fields as JSON. Storage errors (private mode, quota, blocked) are swallowed: the toggles still work. */
export function writeScenePrefs(prefs: ScenePrefs, storage: Pick<Storage, 'setItem'> | null): void {
  try {
    storage?.setItem(PREFS_KEY, JSON.stringify(Object.fromEntries(PREF_KEYS.map((k) => [k, prefs[k]]))))
  } catch {
    // not persisted; the page keeps the prefs in memory
  }
}

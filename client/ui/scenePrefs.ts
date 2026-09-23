// client/ui/scenePrefs.ts
/**
 * The user's scene toggles (design D11): the URL (?topo=0|1, ?light=0|1) wins over localStorage['fh.scene.v1'], which
 * wins over the defaults (both on). Pure: the app passes location.search, the stored string and the storage, so Node
 * tests need no DOM. Reading localStorage itself can throw (storage blocked), so the app guards that read.
 */
import type { ScenePrefs } from '../types.ts'

export const PREFS_KEY = 'fh.scene.v1'
export const DEFAULT_PREFS: ScenePrefs = Object.freeze({ topo: true, light: true })

/** Only a real boolean counts; anything else (missing, 0, "false", null) keeps the fallback. */
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
/** ?k=0 → false, ?k=1 → true, any other value or none → the fallback. */
const flag = (v: string | null, fallback: boolean): boolean => (v === '0' ? false : v === '1' ? true : fallback)

/** URL > stored JSON > defaults, field by field. Corrupt or partial JSON falls back per field; never throws. */
export function readScenePrefs(search: string, stored: string | null): ScenePrefs {
  let saved: { topo?: unknown; light?: unknown } | null = null
  try {
    saved = stored === null ? null : JSON.parse(stored) // a number, string or array has no such fields: defaults
  } catch {
    // corrupt: the defaults stand
  }
  const q = new URLSearchParams(search)
  return {
    topo: flag(q.get('topo'), bool(saved?.topo, DEFAULT_PREFS.topo)),
    light: flag(q.get('light'), bool(saved?.light, DEFAULT_PREFS.light)),
  }
}

/** Stores the two fields as JSON. Storage errors (private mode, quota, blocked) are swallowed: the toggles still work. */
export function writeScenePrefs(prefs: ScenePrefs, storage: Pick<Storage, 'setItem'> | null): void {
  try {
    storage?.setItem(PREFS_KEY, JSON.stringify({ topo: prefs.topo, light: prefs.light }))
  } catch {
    // not persisted; the page keeps the prefs in memory
  }
}

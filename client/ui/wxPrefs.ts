// client/ui/wxPrefs.ts
/**
 * The Weather menu's choices (ui/wxMenu.ts): the clouds' look, the hazard areas' style and the three looking-ahead aids. The URL aids (?wxlook=natural|severity|blocks,
 * ?wxhaz=curtain|fence|box, ?wxtrack, ?wxslice, ?wxstrip = 0|1) win over localStorage['fh.wx3d.v1'], which wins over the defaults (severity colours, curtains,
 * the track line and the ahead strip on, the level slice off). A URL aid is for the load it comes with: what is saved is kept apart from what is in force, and a choice
 * made in the menu saves that choice alone (savedAfter). Pure: the app passes location.search, the stored string and the storage, so Node tests need no DOM.
 * Reading localStorage itself can throw (storage blocked), so the app guards that read.
 */
import type { CloudLook, HazardStyle } from '../scene/cloudVolume.ts'

export interface WxPrefs {
  look: CloudLook
  hazard: HazardStyle
  track: boolean // the track line: the next six minutes on this heading
  slice: boolean // the level slice: the weather at the aircraft's own altitude
  strip: boolean // the ahead strip: a side view of the next 80 km
}

export const WX_PREFS_KEY = 'fh.wx3d.v1'
export const DEFAULT_WX_PREFS: WxPrefs = Object.freeze({ look: 'severity', hazard: 'curtain', track: true, slice: false, strip: true })
export const WX_KEYS = Object.keys(DEFAULT_WX_PREFS) as (keyof WxPrefs)[]
/** The URL aid of each choice. */
export const WX_URL_KEYS: Readonly<Record<keyof WxPrefs, string>> = Object.freeze({ look: 'wxlook', hazard: 'wxhaz', track: 'wxtrack', slice: 'wxslice', strip: 'wxstrip' })
export const WX_LOOKS: readonly CloudLook[] = ['natural', 'severity', 'blocks']
export const WX_HAZARDS: readonly HazardStyle[] = ['curtain', 'fence', 'box']

/** Only one of the choices counts; anything else (missing, another type, another word) keeps the fallback. */
const choice = <T extends string>(v: unknown, choices: readonly T[], fallback: T): T => (choices.includes(v as T) ? (v as T) : fallback)
/** Only a real boolean counts. */
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
/** ?k=0 → false, ?k=1 → true, any other value or none → the fallback. */
const flag = (v: string | null, fallback: boolean): boolean => (v === '0' ? false : v === '1' ? true : fallback)

/** URL > stored JSON > defaults, field by field. Corrupt or partial JSON falls back per field; never throws. */
export function readWxPrefs(search: string, stored: string | null): WxPrefs {
  let saved: Record<string, unknown> = {}
  try {
    const parsed: unknown = stored === null ? null : JSON.parse(stored)
    if (typeof parsed === 'object' && parsed !== null) saved = parsed as Record<string, unknown> // a number, string or null has no such fields: defaults
  } catch {
    // corrupt: the defaults stand
  }
  const q = new URLSearchParams(search)
  const d = DEFAULT_WX_PREFS
  const look = choice(saved.look, WX_LOOKS, d.look)
  const hazard = choice(saved.hazard, WX_HAZARDS, d.hazard)
  return {
    look: choice(q.get(WX_URL_KEYS.look), WX_LOOKS, look),
    hazard: choice(q.get(WX_URL_KEYS.hazard), WX_HAZARDS, hazard),
    track: flag(q.get(WX_URL_KEYS.track), bool(saved.track, d.track)),
    slice: flag(q.get(WX_URL_KEYS.slice), bool(saved.slice, d.slice)),
    strip: flag(q.get(WX_URL_KEYS.strip), bool(saved.strip, d.strip)),
  }
}

/** Stores the fields as JSON. Storage errors (private mode, quota, blocked) are swallowed: the choices still work. */
export function writeWxPrefs(p: WxPrefs, storage: Pick<Storage, 'setItem'> | null): void {
  try {
    storage?.setItem(WX_PREFS_KEY, JSON.stringify(Object.fromEntries(WX_KEYS.map((k) => [k, p[k]]))))
  } catch {
    // not persisted; the page keeps the choices in memory
  }
}

/**
 * What is saved after a choice in the menu: of the choices in force before it (`was`) and after it (`next`), the fields that changed are written onto the saved set, and no
 * other. A URL aid is in force for the load it came with, and so differs from what is saved; a click on another choice must not save it.
 */
export function savedAfter(saved: WxPrefs, was: WxPrefs, next: WxPrefs): WxPrefs {
  const changed = Object.fromEntries(WX_KEYS.filter((k) => next[k] !== was[k]).map((k) => [k, next[k]])) as Partial<WxPrefs>
  return { ...saved, ...changed }
}

/**
 * The search without the URL aids of the choices that changed: a choice made since the link asked is the one a reload keeps. Every other parameter stays
 * (written as urlState.ts writes them); with none of these aids in it, the very same string comes back, so the app leaves the address alone.
 */
export function dropWxAids(search: string, changed: readonly (keyof WxPrefs)[]): string {
  const q = new URLSearchParams(search)
  const asked = changed.filter((k) => q.has(WX_URL_KEYS[k]))
  if (asked.length === 0) return search
  for (const k of asked) q.delete(WX_URL_KEYS[k])
  const out = q.toString().replaceAll('%2C', ',')
  return out === '' ? '' : `?${out}`
}

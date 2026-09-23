// client/ui/urlState.ts
// What is on screen, in the URL, so a reload (or a shared link) shows the same thing: the camera (?at=lat,lon,km:
// browse centre and height, or the chased aircraft's position), the focused aircraft (?hex=), the 3-D chase view of it
// (?chase=1), the chase orbit
// (?cam=heading,pitch,range: offset from the nose °, look pitch °, distance m) and the scene toggles that differ from
// the defaults (?topo=0 …, read by scenePrefs). Other parameters (?bench, ?sun, ?airport) are kept as they are.
// Pure: the app passes location.search and writes the result with history.replaceState.
import { DEFAULT_PREFS } from './scenePrefs.ts'
import type { ScenePrefs } from '../types.ts'

export interface ViewAt {
  lat: number
  lon: number
  heightKm: number
}

export interface Orbit {
  headingDeg: number
  pitchDeg: number
  rangeM: number
}

export interface UrlState {
  at: ViewAt | null
  hex: string | null // the focused aircraft
  chase: boolean // in the 3-D chase view (?chase=1)
  cam: Orbit | null
  prefs: ScenePrefs
}

const nums = (v: string | null, n: number): number[] | null => {
  if (v === null) return null
  const p = v.split(',').map((x) => (x.trim() === '' ? Number.NaN : Number(x)))
  return p.length === n && p.every(Number.isFinite) ? p : null
}

/**
 * ?at= (|lat| ≤ 90, |lon| ≤ 180, height > −1 km: a chase camera near the ground where the geoid is below the
 * ellipsoid has a negative ellipsoidal height; browse clamps its own) and ?cam=; anything malformed is null.
 */
export function readView(search: string): { at: ViewAt | null; cam: Orbit | null; chase: boolean } {
  const q = new URLSearchParams(search)
  const a = nums(q.get('at'), 3)
  const c = nums(q.get('cam'), 3)
  return {
    at: a !== null && Math.abs(a[0]) <= 90 && Math.abs(a[1]) <= 180 && a[2] > -1 ? { lat: a[0], lon: a[1], heightKm: a[2] } : null,
    cam: c !== null && c[2] > 0 ? { headingDeg: c[0], pitchDeg: c[1], rangeM: c[2] } : null,
    chase: q.get('chase') === '1' && /^~?[0-9a-f]{6}$/i.test(q.get('hex') ?? ''),
  }
}

/** The search string for s, keeping every parameter this module does not own. Rounded so small moves do not churn history. */
export function writeUrl(search: string, s: UrlState): string {
  const q = new URLSearchParams(search)
  for (const k of ['at', 'hex', 'chase', 'cam', 'topo', 'light', 'glass']) q.delete(k)
  if (s.at) q.set('at', `${s.at.lat.toFixed(4)},${s.at.lon.toFixed(4)},${Number(s.at.heightKm.toPrecision(3))}`)
  if (s.hex) q.set('hex', s.hex)
  if (s.hex && s.chase) q.set('chase', '1')
  if (s.hex && s.chase && s.cam) q.set('cam', `${Math.round(s.cam.headingDeg)},${Math.round(s.cam.pitchDeg)},${Math.round(s.cam.rangeM)}`)
  for (const k of ['topo', 'light', 'glass'] as const) if (s.prefs[k] !== DEFAULT_PREFS[k]) q.set(k, s.prefs[k] ? '1' : '0')
  const out = q.toString().replaceAll('%2C', ',')
  return out === '' ? '' : `?${out}`
}

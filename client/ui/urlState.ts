// client/ui/urlState.ts
// What is on screen, in the URL, so a reload (or a shared link) shows the same thing: the camera (?at=lat,lon,km:
// browse centre and height, or the chased aircraft's position), the focused aircraft (?hex=), the 3-D chase view of it
// (?chase=1), the chase orbit
// (?cam=heading,pitch,range: offset from the nose °, look pitch °, distance m) and the scene toggles that differ from
// the defaults (?topo=0 …, read by scenePrefs). A running scenario replaces at, hex and chase with ?scenario=<id>&t=<s>
// (t: the scenario clock in whole seconds since its local midnight, as in the package files, so a link survives a
// package whose start moves) and keeps ?cam=. A replay of the past (History) adds ?hist=<unix s> to the view, so a
// reload returns to that moment, paused. Other parameters (?bench, ?sun, ?airport, ?scenarioBase) are kept as they
// are. Pure: the app passes location.search and writes the result with history.replaceState.
import { DEFAULT_PREFS, PREF_KEYS } from './scenePrefs.ts'
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
  scenario?: { id: string; t: number } | null // a running scenario and its clock
  hist?: number | null // History: the replay time, UTC ms (written in whole seconds)
}

/**
 * A scenario id as the URL may name it: a package's becomes a path segment (public/scenarios/<id>/); a recording's is
 * rec:<its file under FLIGHTS_DIR, without .jsonl> (fromRecording.ts).
 */
const SCENARIO_ID = /^(?:[a-z0-9][a-z0-9_-]{0,63}|rec:\d{4}-\d{2}-\d{2}\/\d{6}Z-[a-z0-9]*-[0-9a-fx]{6,7})$/i

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

/** ?scenario=<id>&t=<s>: the scenario to start on load and where (t null: its start); null without a valid id. */
export function readScenario(search: string): { id: string; t: number | null } | null {
  const q = new URLSearchParams(search)
  const id = q.get('scenario') ?? ''
  if (!SCENARIO_ID.test(id)) return null
  const t = q.get('t')
  const n = t === null || t.trim() === '' ? Number.NaN : Number(t)
  return { id, t: Number.isFinite(n) && n >= 0 ? n : null }
}

const HIST_MIN_S = 1_672_531_200 // 2023-01-01: adsb.lol's archive starts in 2023; anything earlier is a typo

/** ?hist=<unix s>: the replay time to open History at, UTC ms; null when absent or not a whole second after 2023. */
export function readHist(search: string): number | null {
  const v = new URLSearchParams(search).get('hist') ?? ''
  return /^\d+$/.test(v) && Number(v) >= HIST_MIN_S ? Number(v) * 1000 : null
}

/** The search string for s, keeping every parameter this module does not own. Rounded so small moves do not churn history. */
export function writeUrl(search: string, s: UrlState): string {
  const q = new URLSearchParams(search)
  for (const k of ['at', 'hex', 'chase', 'cam', 'scenario', 't', 'hist', ...PREF_KEYS]) q.delete(k)
  const cam = s.cam && `${Math.round(s.cam.headingDeg)},${Math.round(s.cam.pitchDeg)},${Math.round(s.cam.rangeM)}`
  if (s.scenario) {
    q.set('scenario', s.scenario.id)
    q.set('t', String(Math.floor(s.scenario.t)))
    if (cam) q.set('cam', cam)
  } else {
    if (s.at) q.set('at', `${s.at.lat.toFixed(4)},${s.at.lon.toFixed(4)},${Number(s.at.heightKm.toPrecision(3))}`)
    if (s.hex) q.set('hex', s.hex)
    if (s.hex && s.chase) q.set('chase', '1')
    if (s.hex && s.chase && cam) q.set('cam', cam)
    if (s.hist != null) q.set('hist', String(Math.floor(s.hist / 1000)))
  }
  for (const k of PREF_KEYS) if (s.prefs[k] !== DEFAULT_PREFS[k]) q.set(k, s.prefs[k] ? '1' : '0')
  const out = q.toString().replaceAll('%2C', ',')
  return out === '' ? '' : `?${out}`
}

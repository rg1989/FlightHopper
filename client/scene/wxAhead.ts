// client/scene/wxAhead.ts
// What is ahead on this heading, pure (no Cesium, no DOM, so Node tests cover it): the path the aircraft flies if it changes neither track,
// speed nor climb (aheadPath), what the weather field and the hazard areas hold along it (aheadStatus: the status line's; aheadProfile: the
// ahead strip's side view), and the words for it (statusWords). The 3-D view draws the path (Weather3D.setAhead) and the HUD (ui/wxHud.ts)
// shows the rest. Heights are metres above mean sea level, the weather field's own and the pilot's: a hazard area's base and top are read as
// that too (they are flight levels; weather3d.ts draws them at the same number of metres above the ellipsoid, a ponytail of wxGeo.ts).
// The severity scale, its names and colours are here, once, for everything that shows it (the status line, the strip, the menu's legend).
import type { Sigmet } from '../../shared/wx.ts'
import type { Units } from '../ui/units.ts'
import { coverAt, type Cover, type WxField } from './wxField.ts'
import { ringContains, wrapLon, type Hazard } from './wxGeo.ts'
import { sigmetLabel } from './wxText.ts'

export const AHEAD_MIN = 6 // the path: the aircraft now, then each minute to this many
export const AHEAD_KM = 80 // how far the status and the strip look, whatever the speed
export const MIN_GS_KT = 40 // under this there is no way ahead (an aircraft taxiing or hovering has none)
export const IN_COVER = 0.3 // the field's cover above which the aircraft is in weather, and weather is on the path (the mock's)
export const STRIP_COVER = 0.25 // and above which the strip draws a cell
export const PROFILE_COLS = 160 // the strip's cells: along the path (AHEAD_KM / PROFILE_COLS = 0.5 km each) …
export const PROFILE_ROWS = 50 // … and up (PROFILE_TOP_M / PROFILE_ROWS = 250 m each)
export const PROFILE_TOP_M = 12_500
const WORST_KM = 8 // the severity named for the first weather is the worst of this much of it
const STEP_KM = AHEAD_KM / PROFILE_COLS // the status looks along the path this often
const R_KM = 6371 // the sphere the field and the hazard areas are laid on (wxGeo.ts, wxField.ts)
const RAD = Math.PI / 180
const FT = 0.3048
const KM_PER_NM = 1.852

/** The severity scale (cloudField.ts SEV): 0 cloud, 1 light rain or snow, 2 heavy rain, 3 thunderstorm. */
export const SEV_COLOR: readonly string[] = ['#f2f5f8', '#58a6ff', '#ffbe3d', '#ff4d3d']
export const SEV_NAME: readonly string[] = ['cloud', 'light rain', 'heavy rain', 'a thunderstorm']
/** The whole step of the scale a field's severity (0 … 3, mixed between texels) falls on. */
export const sevOf = (s: number): number => Math.min(3, Math.max(0, Math.round(s)))

/** A place on the path: degrees, and metres above mean sea level. */
export interface AheadPoint {
  lat: number
  lon: number
  altM: number
}

/** The aircraft now, then where it is after each minute up to AHEAD_MIN; kmPerMin is one minute's way along the great circle. */
export interface AheadPath {
  points: AheadPoint[]
  kmPerMin: number
}

/** The way ahead on a great circle along trackDeg at gsKt, the height changing by vsFpm each minute (never below 0). Null under MIN_GS_KT, or for a number that is no number. */
export function aheadPath(a: AheadPoint, trackDeg: number, gsKt: number, vsFpm: number): AheadPath | null {
  if (!(gsKt >= MIN_GS_KT) || ![a.lat, a.lon, a.altM, trackDeg, vsFpm].every(Number.isFinite)) return null
  const kmPerMin = (gsKt * KM_PER_NM) / 60
  const [sinLat, cosLat] = [Math.sin(a.lat * RAD), Math.cos(a.lat * RAD)]
  const points: AheadPoint[] = [{ lat: a.lat, lon: a.lon, altM: a.altM }]
  for (let i = 1; i <= AHEAD_MIN; i++) {
    const p = destination(sinLat, cosLat, a.lon, trackDeg * RAD, (i * kmPerMin) / R_KM, { lat: 0, lon: 0, altM: 0 })
    p.altM = Math.max(0, a.altM + vsFpm * FT * i)
    points.push(p)
  }
  return { points, kmPerMin }
}

/** The place the great circle from (lat, lon) leaves along `bearing` reaches after the angle `arc` (radians), written into out (its height left alone). */
function destination(sinLat: number, cosLat: number, lon: number, bearing: number, arc: number, out: AheadPoint): AheadPoint {
  const [sinArc, cosArc] = [Math.sin(arc), Math.cos(arc)]
  const sinLat2 = sinLat * cosArc + cosLat * sinArc * Math.cos(bearing)
  out.lat = Math.asin(Math.max(-1, Math.min(1, sinLat2))) / RAD
  out.lon = wrapLon(lon + Math.atan2(Math.sin(bearing) * sinArc * cosLat, cosArc - sinLat * sinLat2) / RAD)
  return out
}

/** Where the path stands km along it: its great circle (the way from its first point to its second) carried on past the last minute; its height straight between the minutes, and beyond the last the last minute's change, never below 0. */
function walker(path: AheadPath): (km: number, out: AheadPoint) => AheadPoint {
  const { points, kmPerMin } = path
  const [a, b] = [points[0], points[1]]
  const [lat1, lat2, dLon] = [a.lat * RAD, b.lat * RAD, (b.lon - a.lon) * RAD]
  const bearing = Math.atan2(Math.sin(dLon) * Math.cos(lat2), Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon))
  const [sinLat, cosLat] = [Math.sin(lat1), Math.cos(lat1)]
  const last = points.length - 2
  return (km, out) => {
    const m = Math.max(0, km) / kmPerMin
    const k = Math.min(Math.floor(m), last)
    destination(sinLat, cosLat, a.lon, bearing, Math.max(0, km) / R_KM, out)
    out.altM = Math.max(0, points[k].altM + (points[k + 1].altM - points[k].altM) * (m - k))
    return out
  }
}

/** The path's place and height km along it (into `out` when one is given). */
export function pathPointAt(path: AheadPath, km: number, out: AheadPoint = { lat: 0, lon: 0, altM: 0 }): AheadPoint {
  return walker(path)(km, out)
}

/** What the status line says of the weather and the hazard areas on the path. */
export interface AheadStatus {
  cloud: { inside: boolean; sev: number; inMin: number | null } // inMin: minutes to the first weather on the path (0 inside it); null: none within reach. sev: inside, the weather the aircraft is in; else the worst of the first WORST_KM km of what is ahead
  hazard: { inside: boolean; inMin: number | null; text: string } | null // the hazard area the aircraft is in, else the nearest on the path; null: none. Inside: from its base to under its top
}

/** Whether the point is in the hazard area's volume: within one of its rings, from its base up to under its top. */
const within = (h: Hazard, lat: number, lon: number, altM: number): boolean => altM >= h.baseM && altM < h.topM && h.rings.some((r) => ringContains(r, lat, lon))

/**
 * What the aircraft is in and what lies ahead: the field's cover at the aircraft (above IN_COVER: in weather), else the first place along
 * the path, looked at every half km to AHEAD_KM, where it is; and the hazard area the aircraft is in (above its base, under its top), else
 * the first one the path enters. `label` gives a hazard area's words.
 */
export function aheadStatus(path: AheadPath, field: WxField | null, hazards: readonly Hazard[], label: (h: Hazard) => string): AheadStatus {
  const walk = walker(path)
  const [here, p, cell] = [path.points[0], { lat: 0, lon: 0, altM: 0 }, { cover: 0, sev: 0 }]
  let cloud: AheadStatus['cloud'] = { inside: false, sev: 0, inMin: null }
  if (field !== null && !field.empty) {
    if (coverAt(field, here.lat, here.lon, here.altM, cell).cover > IN_COVER) cloud = { inside: true, sev: sevOf(cell.sev), inMin: 0 }
    else {
      let [first, worst] = [-1, 0] // the first weather on the way, and the worst of its first WORST_KM km
      for (let i = 1; i <= PROFILE_COLS; i++) {
        const d = i * STEP_KM
        walk(d, p)
        if (coverAt(field, p.lat, p.lon, p.altM, cell).cover > IN_COVER) {
          if (first < 0) first = d
          if (d - first > WORST_KM) break
          worst = Math.max(worst, sevOf(cell.sev))
        } else if (first >= 0) break
      }
      if (first >= 0) cloud = { inside: false, sev: worst, inMin: first / path.kmPerMin }
    }
  }
  let hazard: AheadStatus['hazard'] = null
  const now = hazards.find((h) => within(h, here.lat, here.lon, here.altM))
  if (now !== undefined) hazard = { inside: true, inMin: 0, text: label(now) }
  else if (hazards.length > 0) {
    for (let i = 1; i <= PROFILE_COLS && hazard === null; i++) {
      const d = i * STEP_KM
      walk(d, p)
      const next = hazards.find((h) => within(h, p.lat, p.lon, p.altM))
      if (next !== undefined) hazard = { inside: false, inMin: d / path.kmPerMin, text: label(next) }
    }
  }
  return { cloud, hazard }
}

/** The ahead strip's side view: PROFILE_COLS × PROFILE_ROWS cells; cell (i, j) is at index j × cols + i, i counting from the aircraft out and j from sea level up. */
export interface AheadProfile {
  cols: number
  rows: number
  kmAhead: number
  topM: number
  cover: Float32Array // the field's cover at each cell's middle, on the path (wxField.ts coverAt)
  sev: Float32Array // and its severity
  hazards: { fromKm: number; toKm: number; baseM: number; topM: number }[] // each stretch of the path inside a hazard area's rings, nearest first, with the area's heights
}

/** The field along the path, in cells of 0.5 km by 250 m up to 80 km and 12,500 m; and where the path is inside a hazard area. */
export function aheadProfile(path: AheadPath, field: WxField | null, hazards: readonly Hazard[]): AheadProfile {
  const [cols, rows] = [PROFILE_COLS, PROFILE_ROWS]
  const [cover, sev] = [new Float32Array(cols * rows), new Float32Array(cols * rows)]
  const out: AheadProfile['hazards'] = []
  const walk = walker(path)
  const p = { lat: 0, lon: 0, altM: 0 }
  const cell: Cover = { cover: 0, sev: 0 }
  const live = field !== null && !field.empty
  const rowM = PROFILE_TOP_M / rows
  const open = hazards.map(() => -1) // each hazard area: the column its run in progress began at
  const close = (k: number, end: number): void => {
    out.push({ fromKm: open[k] * STEP_KM, toKm: end * STEP_KM, baseM: hazards[k].baseM, topM: hazards[k].topM })
  }
  for (let i = 0; i < cols; i++) {
    walk((i + 0.5) * STEP_KM, p)
    if (live) {
      for (let j = 0; j < rows; j++) {
        coverAt(field, p.lat, p.lon, (j + 0.5) * rowM, cell)
        cover[j * cols + i] = cell.cover
        sev[j * cols + i] = cell.sev
      }
    }
    hazards.forEach((h, k) => {
      const on = h.rings.some((r) => ringContains(r, p.lat, p.lon))
      if (on && open[k] < 0) open[k] = i
      else if (!on && open[k] >= 0) {
        close(k, i)
        open[k] = -1
      }
    })
  }
  for (let k = 0; k < hazards.length; k++) if (open[k] >= 0) close(k, cols) // still on at 80 km
  out.sort((a, b) => a.fromKm - b.fromKm)
  return { cols, rows, kmAhead: AHEAD_KM, topM: PROFILE_TOP_M, cover, sev, hazards: out }
}

/** The status line in words: the weather ("In light rain", "Clear air · a thunderstorm in 3 min", "Clear air ahead") with its severity's step (null: none ahead), and the hazard area ("Inside hazard area · …", "Hazard area in 2 min · …"), or null. */
export function statusWords(s: AheadStatus): { cloud: string; sev: number | null; hazard: string | null } {
  const { inside, inMin } = s.cloud
  const sev = sevOf(s.cloud.sev)
  let cloud = 'Clear air ahead'
  let step: number | null = null
  if (inside) [cloud, step] = [`In ${SEV_NAME[sev]}`, sev]
  else if (inMin !== null) [cloud, step] = [`Clear air · ${SEV_NAME[sev]} in ${inMin < 1 ? 'under a minute' : `${Math.round(inMin)} min`}`, sev]
  const h = s.hazard
  const hazard = h === null ? null : h.inside ? `Inside hazard area · ${h.text}` : `Hazard area ${h.inMin === null ? 'ahead' : `in ${Math.max(1, Math.round(h.inMin))} min`} · ${h.text}`
  return { cloud, sev: step, hazard }
}

/**
 * A hazard area's name and heights as a phrase to follow "Inside hazard area ·": the map label's words ("Embedded thunderstorms · up to
 * 35,000 ft") with the first one lowercase (a code that has no words, "SQL", keeps its capitals) and a comma for the dot.
 */
export function hazardWords(s: Sigmet, u: Units): string {
  const label = sigmetLabel(s, u)
  return label.replace(/^(\p{Lu})(?=\p{Ll})/u, (c) => c.toLowerCase()).replace(' · ', ', ')
}

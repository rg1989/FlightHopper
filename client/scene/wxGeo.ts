// client/scene/wxGeo.ts
// The weather's geometry, pure (no Cesium, no DOM, so Node tests cover it), shared by the top-down map (weather.ts) and the
// chase (weather3d.ts): the whole-degree box a view asks airports for, which point is inside a hazard area's ring, how far a
// ring is from a point and where its middle is, the hazard areas within reach of a point, and a sky moved to another place.
// A ring is a SIGMET's outer ring: [lon, lat] corners (degrees) whose edges are great circles, as Cesium draws a polygon's.
// Longitudes are read continuously round a ring, so one across the antimeridian is the one ring it is.
// What is worked out for a ring (its corners as vectors, its longitudes made continuous, its cap) is kept for the ring
// object, which is read-only data from the server: a changed ring is a new object.
// ponytail: a ring round a pole is read wrongly (its longitudes do not close, so its inside test is off). SIGMET areas are
// small polygons; upgrade, if one is not: test the inside by winding on the sphere.
import type { Metar, Sigmet } from '../../shared/wx.ts'

const MAX_SPAN_DEG = 40 // as server/wx.ts
const FT = 0.3048
const EARTH_KM = 6371

type Ring = [number, number][]

/** Ray casting on [lon, lat] rings (degrees; areas this small need no great-circle edges). */
export function inRing(ring: [number, number][], lon: number, lat: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** The whole-degree box around a view (degrees), or null when it is too wide for airports (or no ground is in view). */
export function viewBox(r: { west: number; south: number; east: number; north: number } | null): string | null {
  if (r === null) return null
  const [s, w, n, e] = [Math.floor(r.south), Math.floor(r.west), Math.ceil(r.north), Math.ceil(r.east)]
  if (e <= w || n - s > MAX_SPAN_DEG || e - w > MAX_SPAN_DEG) return null // e ≤ w: the view crosses the antimeridian
  return `${Math.max(-90, s)},${Math.max(-180, w)},${Math.min(90, n)},${Math.min(180, e)}`
}

/** A longitude in −180…180 (one already there is kept as it is). */
export const wrapLon = (lon: number): number => (lon >= -180 && lon <= 180 ? lon : ((((lon + 180) % 360) + 360) % 360) - 180)

// Spherical geometry on unit vectors.
type Vec = [number, number, number]
const rad = (d: number): number => (d * Math.PI) / 180
const deg = (r: number): number => (r * 180) / Math.PI
const toVec = (lat: number, lon: number): Vec => {
  const φ = rad(lat)
  const λ = rad(lon)
  const c = Math.cos(φ)
  return [c * Math.cos(λ), c * Math.sin(λ), Math.sin(φ)]
}
const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const length = (a: Vec): number => Math.hypot(a[0], a[1], a[2])
const angle = (a: Vec, b: Vec): number => Math.atan2(length(cross(a, b)), dot(a, b))

/** The angle (radians) from p to the great-circle arc a → b: to the circle where p's foot falls between a and b, else to the nearer end. */
function arcAngle(p: Vec, a: Vec, b: Vec): number {
  const ends = Math.min(angle(p, a), angle(p, b))
  const n = cross(a, b)
  const len = length(n)
  if (len < 1e-12) return ends // a and b are one point
  const u: Vec = [n[0] / len, n[1] / len, n[2] / len]
  const off = dot(p, u)
  const foot: Vec = [p[0] - off * u[0], p[1] - off * u[1], p[2] - off * u[2]]
  return dot(cross(a, foot), u) >= 0 && dot(cross(foot, b), u) >= 0 ? Math.asin(Math.min(1, Math.abs(off))) : ends
}

/**
 * What is worked out once for a ring, for a pick to use again and again. Its cap: c is the direction of its corners' mean and
 * rho the angle from c to the farthest corner. A cap smaller than a hemisphere is convex, so the arcs between corners stay
 * in it: the ring lies within rho of c, and a point farther from c than rho plus a reach is farther than the reach from the
 * ring. rho is Infinity when there is no such cap (corners round the globe, or past a hemisphere): nothing can be said.
 * ponytail: the first pick of a new list reads every corner of every ring once (about 5 ms for 150 areas, in Node on efficiency
 * cores). Upgrade: a cheaper first stage, so that rings far off are skipped unread.
 */
interface Shape {
  v: Vec[] // the corners as unit vectors
  flat: Ring // the corners with each longitude continued from the one before (within 180° of it): a ring across the antimeridian is one strip
  mid: number // the middle of those longitudes: the branch a point is read on
  mean: Vec // the corners' vectors added up, the closing corner (a repeat of the first) once
  c: Vec
  rho: number
  sig: string // the corners' count and two sums over them: tells a ring that changed from the same one sent again
}

const shapes = new WeakMap<Ring, Shape>()

function shapeOf(ring: Ring): Shape {
  let s = shapes.get(ring)
  if (s !== undefined) return s
  const n = ring.length
  const v: Vec[] = []
  const flat: Ring = []
  let x = ring[0][0]
  let lo = x
  let hi = x
  let a = 0
  let b = 0
  for (let i = 0; i < n; i++) {
    const lon = ring[i][0]
    const lat = ring[i][1]
    if (i > 0) x += wrapLon(lon - ring[i - 1][0])
    flat.push([x, lat])
    if (x < lo) lo = x
    if (x > hi) hi = x
    v.push(toVec(lat, lon))
    a += (lon + 180) * (i + 1)
    b += (lat + 90) * (i + 7)
  }
  const last = ring[n - 1]
  const m = n > 1 && ring[0][0] === last[0] && ring[0][1] === last[1] ? n - 1 : n
  const mean: Vec = [0, 0, 0]
  for (let i = 0; i < m; i++) {
    mean[0] += v[i][0]
    mean[1] += v[i][1]
    mean[2] += v[i][2]
  }
  const len = length(mean)
  const c: Vec = len > 1e-9 ? [mean[0] / len, mean[1] / len, mean[2] / len] : [0, 0, 0]
  let rho = Infinity
  if (len > 1e-9) {
    let nearest = 1
    for (let i = 0; i < m; i++) {
      const d = dot(c, v[i])
      if (d < nearest) nearest = d
    }
    const r = Math.acos(Math.max(-1, nearest)) + 1e-9
    if (r < Math.PI / 2) rho = r
  }
  s = { v, flat, mid: (lo + hi) / 2, mean, c, rho, sig: `${n}:${a.toFixed(3)}:${b.toFixed(3)}` }
  shapes.set(ring, s)
  return s
}

/** Km from the point p (at lat, lon) to a ring: 0 inside it, else to its nearest edge or corner. */
function distanceKm(s: Shape, p: Vec, lat: number, lon: number): number {
  if (inRing(s.flat, s.mid + wrapLon(lon - s.mid), lat)) return 0
  let best = Infinity
  for (let i = 0, j = s.v.length - 1; i < s.v.length; j = i++) best = Math.min(best, arcAngle(p, s.v[j], s.v[i]))
  return best * EARTH_KM
}

/** Km from a point to a ring: 0 inside it, else to its nearest edge (a great circle) or corner. */
export function ringDistanceKm(ring: Ring, lat: number, lon: number): number {
  return ring.length < 3 ? Infinity : distanceKm(shapeOf(ring), toVec(lat, lon), lat, lon)
}

/** The middle of a ring's corners, the closing corner counted once. */
export function ringCentre(ring: Ring): { lat: number; lon: number } {
  const [x, y, z] = shapeOf(ring).mean
  return { lat: deg(Math.atan2(z, Math.hypot(x, y))), lon: deg(Math.atan2(y, x)) }
}

/** A hazard area to draw: its SIGMET, the rings of it within reach (a volume each), the nearest of them (its label's), and its heights in metres. */
export interface Hazard {
  sigmet: Sigmet
  rings: Ring[]
  nearest: Ring
  baseM: number
  topM: number
  key: string // what is drawn for it: its words, its heights and its rings' corners; the same when the same area comes in a new list
}

/**
 * The SIGMETs with a top (above their base) that have a ring passing within maxKm of the point: each with the rings that do.
 * A ring whose cap is farther than that from the point is passed over without looking at its edges: `distance` (a ring's, as
 * ringDistanceKm gives it) is asked of the others only.
 * ponytail: a flight level is a pressure altitude and the volumes stand at that many metres above the ellipsoid: off by up to a
 * few hundred metres on a day far from the standard atmosphere. Upgrade: correct by the QNH and the air's temperature.
 */
export function hazardsNear(sigmets: readonly Sigmet[], lat: number, lon: number, maxKm: number, distance = ringDistanceKm): Hazard[] {
  const out: Hazard[] = []
  const p = toVec(lat, lon)
  const reach = maxKm / EARTH_KM
  for (const s of sigmets) {
    if (s.top === null) continue
    const baseM = Math.max(0, s.base ?? 0) * FT // no base: from the ground
    const topM = s.top * FT
    if (!(topM > baseM)) continue
    const near: { ring: Ring; sig: string; km: number }[] = []
    for (const ring of s.rings) {
      if (ring.length < 3) continue
      const shape = shapeOf(ring)
      if (angle(p, shape.c) - shape.rho > reach) continue
      const km = distance(ring, lat, lon)
      if (km <= maxKm) near.push({ ring, sig: shape.sig, km })
    }
    if (near.length === 0) continue
    const nearest = near.reduce((a, b) => (b.km < a.km ? b : a)).ring
    out.push({
      sigmet: s, rings: near.map((x) => x.ring), nearest, baseM, topM,
      key: `${s.hazard}|${s.qualifier ?? ''}|${s.base ?? ''}|${s.top}|${near.map((x) => x.sig).join(',')}`,
    })
  }
  return out
}

/** The reports moved by dLat, dLon degrees (longitudes kept within ±180°); no move gives the list itself. */
export function shiftMetars(list: readonly Metar[], dLat: number, dLon: number): readonly Metar[] {
  return dLat === 0 && dLon === 0 ? list : list.map((m) => ({ ...m, lat: m.lat + dLat, lon: wrapLon(m.lon + dLon) }))
}

/** The hazard areas moved by dLat, dLon degrees (longitudes kept within ±180°); no move gives the list itself. */
export function shiftSigmets(list: readonly Sigmet[], dLat: number, dLon: number): readonly Sigmet[] {
  if (dLat === 0 && dLon === 0) return list
  return list.map((s) => ({ ...s, rings: s.rings.map((r) => r.map(([x, y]): [number, number] => [wrapLon(x + dLon), y + dLat])) }))
}

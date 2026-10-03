// client/scene/routeLine.ts
// The selected aircraft's way on the top-down map. Behind it, the path it has flown (its trace and samples), coloured by
// altitude in 1,000 ft bands with the icons' palette, dotted grey across the holes no receiver heard, and dotted from its
// origin airport when it was first heard far from there ("First heard HH:MM" at that first point). Ahead of it, a dashed
// great circle to its destination airport (the route's last airport, when the server knows where it is), with a dot and
// the airport's code there. As flight trackers draw it: the line ahead is the shortest way, not the filed route (airways and
// procedures bend it, most near the airports); so is the lead-in from the origin.
import { Cartesian2, Cartesian3, Cartographic, Color, HorizontalOrigin, LabelCollection, LabelStyle, Material, NearFarScalar, PointPrimitiveCollection, PolylineCollection, VerticalOrigin } from 'cesium'
import type { Label, PointPrimitive, Polyline, Viewer } from 'cesium'
import { distanceNm } from '../../shared/geo.ts'
import type { RoutePlace } from '../../shared/info.ts'
import { altitudeIndex, altitudeRgba, GROUND_INDEX, STEP_FT, UNKNOWN_INDEX } from './altitudeColor.ts'
import { isGap } from './pathGap.ts'

export { GAP_NM, GAP_S } from './pathGap.ts' // the rule for a hole (a step longer than both), drawn dotted here

export interface LinePoint {
  lat: number
  lon: number
  hM: number // WGS84 ellipsoidal metres, as the aircraft icons are drawn
}

/** Where the aircraft was heard, and how high (for the colour). */
export interface PathPoint {
  tMs: number
  lat: number
  lon: number
  hM: number // WGS84 ellipsoidal metres, as LinePoint
  altFt: number | null // null: unknown
  onGround: boolean
}

/** A stretch of the path drawn one way: flown, in one colour, or a gap no receiver heard (dotted). */
export interface PathRun {
  gap: boolean
  color: number // the altitudeIndex it is drawn in: its 1,000 ft band's floor, GROUND_INDEX or UNKNOWN_INDEX (a gap: UNKNOWN_INDEX, unused)
  points: PathPoint[]
}

/** The colour a step to p is drawn in: p's altitudeIndex down to its 1,000 ft band's floor; ground and unknown are bands of their own. */
function bandOf(p: PathPoint): number {
  const i = altitudeIndex(p.altFt, p.onGround)
  return i === GROUND_INDEX || i === UNKNOWN_INDEX ? i : Math.floor(i / 10) * 10
}

/** How many of points (in time order) are at or before cutMs. */
export function countUpTo(points: readonly { tMs: number }[], cutMs: number): number {
  let lo = 0
  let hi = points.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (points[mid].tMs <= cutMs) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * The path up to cutMs (points in time order) as runs: a new run where the colour band (1,000 ft; ground and unknown
 * their own) changes; a step longer than GAP_S and GAP_NM is a gap run of its two ends. Consecutive runs share their
 * joining point (the same object). A step takes the colour of the point it leads to, so a run's points after its first
 * are all in its band. A run of one point has no step of its own: the only point of the path, a first point a gap
 * follows, a point between two gaps, or the last point after a gap (its colour goes on to the aircraft).
 */
export function pathRuns(points: readonly PathPoint[], cutMs: number): PathRun[] {
  const runs: PathRun[] = []
  const n = countUpTo(points, cutMs)
  let run: PathRun | null = null
  for (let i = 0; i < n; i++) {
    const p = points[i]
    const color = bandOf(p)
    if (run === null) {
      runs.push((run = { gap: false, color, points: [p] }))
      continue
    }
    const q = points[i - 1]
    if (isGap(q, p)) {
      runs.push({ gap: true, color: UNKNOWN_INDEX, points: [q, p] })
      runs.push((run = { gap: false, color, points: [p] }))
    } else if (color === run.color) run.points.push(p)
    else if (run.points.length === 1) {
      run.color = color // a lone first point has no step of its own: the run takes the colour of the one it leads to
      run.points.push(p)
    } else runs.push((run = { gap: false, color, points: [q, p] }))
  }
  return runs
}

/**
 * The cut is inside a hole of the path (points in time order, n of them at or before the cut: countUpTo): the step from
 * the last of those to the next is a gap. History's replay time there finds the aircraft between two points no receiver
 * heard between: the line from the last one to it is that hole's.
 */
export function cutInGap(points: readonly PathPoint[], n: number): boolean {
  return n > 0 && n < points.length && isGap(points[n - 1], points[n])
}

/** On the ground the path stands this far above the drawn ground: at hM (the geoid's) it is under it, and hidden. */
export const PATH_LIFT_M = 3

/**
 * The drawn height of the runs' points on the ground: read(p), the drawn ground (undefined while its tile is not loaded),
 * at each run's first point on the ground, + PATH_LIFT_M, for all of that run's points on the ground (an airport is flat
 * enough). A point two runs share keeps the first run's. Points in the air, and on ground not read yet, are not in it.
 */
export function groundHeights(runs: readonly PathRun[], read: (p: PathPoint) => number | undefined): Map<PathPoint, number> {
  const out = new Map<PathPoint, number>()
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]
    if (r.gap) continue
    const shared = i > 0 && !runs[i - 1].gap // its first point is the last of the run before, which placed it
    let h: number | undefined | null = null // null: not read yet
    for (let k = shared ? 1 : 0; k < r.points.length; k++) {
      const p = r.points[k]
      if (!p.onGround) continue
      if (h === null) h = read(p)
      if (h === undefined) break
      out.set(p, h + PATH_LIFT_M)
    }
  }
  return out
}

/** points thinned for drawing: both ends, and between them each point at least minNm from the one kept before it. */
export function decimate<T extends { lat: number; lon: number }>(points: readonly T[], minNm: number): readonly T[] {
  if (points.length <= 2) return points
  let kept = points[0]
  const out = [kept]
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]
    if (distanceNm(kept.lat, kept.lon, p.lat, p.lon) >= minNm) out.push((kept = p))
  }
  out.push(points[points.length - 1])
  return out
}

/** The colour of a run's altitudeIndex (the icons' palette), written into out (a Cesium Color works). */
export function indexRgba<T extends { red: number; green: number; blue: number; alpha: number }>(i: number, out: T): T {
  if (i === GROUND_INDEX) return altitudeRgba(null, true, out)
  return altitudeRgba(i === UNKNOWN_INDEX ? null : i * STEP_FT, false, out)
}

const two = (n: number): string => String(n).padStart(2, '0')

/** The label at the first point of a path heard far from its origin: 'First heard 17:13' (local time, 24 h). */
export function firstHeardText(tMs: number): string {
  const d = new Date(tMs)
  return `First heard ${two(d.getHours())}:${two(d.getMinutes())}`
}

const RAD = Math.PI / 180
const EARTH_NM = 3440.065
const STEP_NM = 20 // a 20 nm chord sags ~27 m below the arc: invisible from above
const MAX_POINTS = 400 // ≥ 8,000 nm at STEP_NM; longer legs get longer steps
const REDRAW_MS = 250 // the lines follow the aircraft 4 times a second
const STILL_DEG = 1e-4 // the aircraft moved less than this (~11 m) and STILL_M since the last drawing: its lines stay
const STILL_M = 1
const KEEP_NM = 0.3 // a flown point is drawn this far from the last one drawn (a standard-rate turn's chords stay within ~30 m of it)
const KEEP_GROUND_NM = 0.01 // ~20 m on the ground, so a taxi route keeps its corners
const LEAD_IN_NM = 10 // first heard this far from the origin airport or more: dotted from it
const GROUND_READ_MS = 1000 // the ground under a ground run is read again at most once a second, so it settles as tiles load
const GROUND_MOVED_M = 0.5 // …and the run redrawn when it moved more than this
const CARTO = new Cartographic()
// The flown path: its altitude colour inside a dark edge that keeps it apart from the pale street map. Cesium's
// outlineWidth is both edges together: 4 px of colour, a 1 px edge each side.
const PATH_PX = 6
const EDGE_PX = 2
const EDGE = Color.fromCssColorString('rgba(13,17,25,0.5)')
// Not heard: grey dots, 3 px on and 3 px off, over faint light gaps that keep them on the dark map too.
const DOTS = Color.fromCssColorString('#3f4955').withAlpha(0.9)
const DOTS_GAP = Color.WHITE.withAlpha(0.25)
// Dark dashes with light gaps: they read over the pale street map and the dark satellite alike.
const AHEAD = Color.fromCssColorString('#1b2433').withAlpha(0.9)
const AHEAD_GAP = Color.fromCssColorString('#ffffff').withAlpha(0.75)
const LABEL_BG = Color.fromCssColorString('#16181d').withAlpha(0.85)
const LABEL: Label.ConstructorOptions = {
  position: Cartesian3.ZERO, font: '600 12px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif',
  fillColor: Color.WHITE, style: LabelStyle.FILL, showBackground: true, backgroundColor: LABEL_BG,
  backgroundPadding: new Cartesian2(6, 3), scaleByDistance: new NearFarScalar(3e5, 1, 8e6, 0.7),
  disableDepthTestDistance: Number.POSITIVE_INFINITY, show: false,
}

/** Points along the great circle from a to b (both included), about every stepNm. */
export function greatCircle(a: { lat: number; lon: number }, b: { lat: number; lon: number }, stepNm = STEP_NM): { lat: number; lon: number }[] {
  const [la1, lo1, la2, lo2] = [a.lat * RAD, a.lon * RAD, b.lat * RAD, b.lon * RAD]
  const d = 2 * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2))
  if (!(d > 1e-9)) return [{ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }]
  const n = Math.min(MAX_POINTS - 1, Math.max(1, Math.ceil((d * EARTH_NM) / stepNm)))
  const out: { lat: number; lon: number }[] = []
  for (let i = 0; i <= n; i++) {
    const f = i / n
    const A = Math.sin((1 - f) * d) / Math.sin(d)
    const B = Math.sin(f * d) / Math.sin(d)
    const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2)
    const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2)
    const z = A * Math.sin(la1) + B * Math.sin(la2)
    out.push({ lat: Math.atan2(z, Math.hypot(x, y)) / RAD, lon: Math.atan2(y, x) / RAD })
  }
  return out
}

/**
 * A gap's line: along the great circle (a straight line between ends an ocean apart would run under the globe), its
 * height going evenly from a's to b's.
 */
export function arc(a: LinePoint, b: LinePoint): Cartesian3[] {
  const pts = greatCircle(a, b)
  return pts.map((g, i) => Cartesian3.fromDegrees(g.lon, g.lat, a.hM + ((b.hM - a.hM) * i) / (pts.length - 1)))
}

/** What PolylineCollection.add takes, as far as these lines use it (Cesium types it any: it has no Polyline.ConstructorOptions). */
interface LineOptions {
  width: number
  show: boolean
  material: Material
}

/** A flown run's line: its colour (written in place per run) inside the dark edge. */
const flownLine = (): LineOptions => ({
  width: PATH_PX, show: false,
  material: Material.fromType(Material.PolylineOutlineType, { color: new Color(), outlineColor: EDGE, outlineWidth: EDGE_PX }),
})

/** A line nobody heard: dotted grey. */
const dottedLine = (): LineOptions => ({
  width: 3, show: false,
  material: Material.fromType(Material.PolylineDashType, { color: DOTS, gapColor: DOTS_GAP, dashLength: 6 }),
})

/** The drawn ground under a ground run, read at one point of it; h undefined until its tile is loaded. */
interface GroundRead {
  lat: number
  lon: number
  h: number | undefined
  readMs: number
}

/** Lines from..to of a pool, no longer used: hidden, and emptied so Cesium leaves them out of its batches. */
function retire(pool: readonly Polyline[], from: number, to: number): void {
  for (let i = from; i < to; i++) {
    pool[i].show = false
    pool[i].positions = []
  }
}

/** The same point, by value: a path rebuilt from the same data is the same path. */
const samePoint = (a: PathPoint | null, b: PathPoint | null): boolean =>
  a === b || (a !== null && b !== null && a.tMs === b.tMs && a.lat === b.lat && a.lon === b.lon)

const samePlace = (a: RoutePlace | null, b: RoutePlace | null): boolean =>
  a === b || (a !== null && b !== null && a.code === b.code && a.lat === b.lat && a.lon === b.lon)

export class RouteLine {
  #viewer: Viewer
  #runs: PolylineCollection // the flown path: rewritten when a point is added or cut
  #lines: PolylineCollection // the join, the lead-in and the line ahead: they move with the aircraft or the route
  #points: PointPrimitiveCollection
  #labels: LabelCollection
  #flown: Polyline[] = [] // pools of run lines: the first #nFlown and #nGaps are in use, the rest hidden
  #gaps: Polyline[] = []
  #nFlown = 0
  #nGaps = 0
  #join: Polyline // the last flown point → the aircraft, in the last run's colour
  #joinGap: Polyline // …dotted instead when the aircraft is inside a hole (History: the replay time is in one)
  #leadIn: Polyline // the origin airport → the first point
  #ahead: Polyline
  #dot: PointPrimitive
  #label: Label
  #firstDot: PointPrimitive
  #firstLabel: Label
  #lastMs = -Infinity
  // As drawn: the path's first and last point up to the cut and how many, the aircraft, the route's ends.
  #first: PathPoint | null = null
  #last: PathPoint | null = null
  #n = 0
  #atLat = NaN
  #atLon = NaN
  #atH = NaN
  #dest: RoutePlace | null = null
  #origin: RoutePlace | null = null
  // The drawn ground under this path's ground runs, by the tMs of the point it was read at; the reads the drawn runs use;
  // the last point's height when it stands on read ground (the join's then).
  #grounds = new Map<number, GroundRead>()
  #groundsUsed: GroundRead[] = []
  #lastLift: number | undefined = undefined

  constructor(viewer: Viewer) {
    this.#viewer = viewer
    const p = viewer.scene.primitives
    this.#runs = p.add(new PolylineCollection())
    this.#lines = p.add(new PolylineCollection())
    this.#points = p.add(new PointPrimitiveCollection())
    this.#labels = p.add(new LabelCollection())
    this.#join = this.#lines.add(flownLine())
    this.#joinGap = this.#lines.add(dottedLine())
    this.#leadIn = this.#lines.add(dottedLine())
    this.#ahead = this.#lines.add({ width: 3, material: Material.fromType(Material.PolylineDashType, { color: AHEAD, gapColor: AHEAD_GAP, dashLength: 16 }), show: false })
    this.#dot = this.#points.add({ pixelSize: 9, color: AHEAD, outlineColor: Color.WHITE, outlineWidth: 2, show: false, disableDepthTestDistance: Number.POSITIVE_INFINITY })
    this.#label = this.#labels.add({ ...LABEL, verticalOrigin: VerticalOrigin.BOTTOM, pixelOffset: new Cartesian2(0, -10) })
    this.#firstDot = this.#points.add({ pixelSize: 8, color: Color.WHITE, outlineColor: AHEAD, outlineWidth: 2, show: false, disableDepthTestDistance: Number.POSITIVE_INFINITY })
    this.#firstLabel = this.#labels.add({ ...LABEL, horizontalOrigin: HorizontalOrigin.LEFT, verticalOrigin: VerticalOrigin.TOP, pixelOffset: new Cartesian2(10, 6) })
  }

  /**
   * at: the selected aircraft where it is drawn (null: nothing to show, e.g. none selected or the 3-D chase); a fleet
   * entry will do (its altFt is not needed: the join keeps the last run's colour). path: its points in time order; the
   * part after cutMs is not drawn (cutMs: Infinity live, the replay time in history); a cut inside a hole (cutInGap)
   * joins the aircraft dotted, along the great circle where the hole's line runs once its far end is reached. dest,
   * origin: where its route ends and starts (null: unknown, no line ahead, no lead-in).
   * Redrawn at most every REDRAW_MS (at once for another path or route), and only when something moved: a point added
   * or cut, the aircraft by STILL_DEG, the route. Otherwise nothing is allocated.
   * ponytail: the line ahead keeps the aircraft's height all the way, the lead-in the first point's (a descent or climb
   * profile would need the airports' elevations); a hill higher than that under the line hides that bit of it.
   */
  update(at: { lat: number; lon: number; hM: number; altFt?: number | null } | null, path: readonly PathPoint[],
    dest: RoutePlace | null, origin: RoutePlace | null, cutMs: number, nowMs = performance.now()): void {
    const show = at !== null
    this.#runs.show = this.#lines.show = this.#points.show = this.#labels.show = show
    if (!show) return
    const n = countUpTo(path, cutMs)
    const first = n > 0 ? path[0] : null
    const last = n > 0 ? path[n - 1] : null
    const newPath = !samePoint(first, this.#first) // another aircraft or leg, or none of it before the cut
    const newDest = !samePlace(dest, this.#dest)
    const newOrigin = !samePlace(origin, this.#origin)
    if (!newPath && !newDest && !newOrigin && nowMs - this.#lastMs < REDRAW_MS) return
    const newPoints = newPath || n !== this.#n || !samePoint(last, this.#last)
    const moved = !(Math.abs(at.lat - this.#atLat) <= STILL_DEG && Math.abs(at.lon - this.#atLon) <= STILL_DEG && Math.abs(at.hM - this.#atH) <= STILL_M)
    const newGround = !newPoints && this.#groundMoved(nowMs) // its tiles loaded, or the relief grew or sank
    if (!newPoints && !moved && !newDest && !newOrigin && !newGround) return
    this.#lastMs = nowMs
    if (newPath) this.#grounds.clear()
    if (newPoints || newGround) this.#drawPath(path, cutMs, nowMs)
    if (newPath || newOrigin) this.#drawLeadIn(first, origin)
    if (newPoints || newGround || moved) this.#drawJoin(last, at, cutInGap(path, n))
    if (moved || newDest) this.#drawAhead(at, dest)
    this.#first = first
    this.#last = last
    this.#n = n
    this.#dest = dest
    this.#origin = origin
    this.#atLat = at.lat
    this.#atLon = at.lon
    this.#atH = at.hM
    this.#viewer.scene.requestRender()
  }

  /** The runs into the pools (flown ones in their colour, gaps dotted), the rest of the pools hidden; the join's colour. */
  #drawPath(path: readonly PathPoint[], cutMs: number, nowMs: number): void {
    // ponytail: the whole path is rewritten when a point is added or cut, ≤ 4 times a second (a few ms for a long leg's
    // trace), and every run is a line of its own: tens on an airliner's leg, a few hundred for circuits all afternoon.
    // Altitude jittering across a band's edge for hours would make thousands (Cesium then spends ms a frame on them).
    // The pools never shrink: after a one-off leg of thousands of runs, thousands of emptied lines and their materials
    // stay hidden for the session (out of Cesium's batches: memory, and a little in each rebuild).
    const runs = pathRuns(path, cutMs)
    // ponytail: one ground height per run, read at its first point on the ground (an airport is flat to a few metres; a
    // long taxi across a sloping one dips under it), and read again at most once a second: the drawn ground it reads
    // grows and sinks with the topography toggle, and the run sits off it for that second.
    this.#groundsUsed.length = 0
    const lifted = groundHeights(runs, (p) => this.#groundAt(p, nowMs))
    const hOf = (p: PathPoint): number => lifted.get(p) ?? p.hM
    const flown: { color: number; pts: readonly PathPoint[] }[] = []
    let gaps = 0
    for (const r of runs) {
      if (r.gap) {
        const [a, b] = r.points
        this.#put(this.#gaps, gaps++, dottedLine, arc({ lat: a.lat, lon: a.lon, hM: hOf(a) }, { lat: b.lat, lon: b.lon, hM: hOf(b) }))
        continue
      }
      const pts = decimate(r.points, r.color === GROUND_INDEX ? KEEP_GROUND_NM : KEEP_NM)
      if (pts.length >= 2) flown.push({ color: r.color, pts }) // a lone point has no step to draw (the join may start there)
    }
    // Same colours side by side in the pool: Cesium draws neighbours of one look in one call (≤ 43 calls, not one a run).
    flown.sort((a, b) => a.color - b.color)
    for (let i = 0; i < flown.length; i++) {
      const line = this.#put(this.#flown, i, flownLine, flown[i].pts.map((p) => Cartesian3.fromDegrees(p.lon, p.lat, hOf(p))))
      indexRgba(flown[i].color, line.material.uniforms.color)
    }
    retire(this.#flown, flown.length, this.#nFlown)
    retire(this.#gaps, gaps, this.#nGaps)
    this.#nFlown = flown.length
    this.#nGaps = gaps
    const end = runs.at(-1) // flown: a gap is always followed by the run it leads to
    if (end !== undefined) indexRgba(end.color, this.#join.material.uniforms.color)
    const last = end?.points.at(-1)
    this.#lastLift = last === undefined ? undefined : lifted.get(last)
  }

  /** The drawn ground at p, a ground run's first point on it: from the cache, read again when GROUND_READ_MS old. */
  #groundAt(p: PathPoint, nowMs: number): number | undefined {
    let g = this.#grounds.get(p.tMs)
    if (g === undefined) this.#grounds.set(p.tMs, (g = { lat: p.lat, lon: p.lon, h: undefined, readMs: -Infinity }))
    this.#read(g, nowMs)
    this.#groundsUsed.push(g)
    return g.h
  }

  /** globe.getHeight: the ground as drawn (exaggerated or flattened with the relief), undefined where no tile is loaded. */
  #read(g: GroundRead, nowMs: number): void {
    if (nowMs - g.readMs < GROUND_READ_MS) return
    g.readMs = nowMs
    const h = this.#viewer.scene.globe?.getHeight(Cartographic.fromDegrees(g.lon, g.lat, 0, CARTO))
    if (h !== undefined) g.h = h // a tile dropped since keeps the height read before
  }

  /** The ground under the drawn ground runs read again (each at most every GROUND_READ_MS): true when it moved. */
  #groundMoved(nowMs: number): boolean {
    let moved = false
    for (const g of this.#groundsUsed) {
      const was = g.h
      this.#read(g, nowMs)
      if (g.h !== undefined && (was === undefined || Math.abs(g.h - was) > GROUND_MOVED_M)) moved = true
    }
    return moved
  }

  /** Pool line i (made when the pool is that short) shown through positions. */
  #put(pool: Polyline[], i: number, make: () => LineOptions, positions: Cartesian3[]): Polyline {
    const line = pool[i] ?? (pool[i] = this.#runs.add(make()))
    line.positions = positions
    line.show = true
    return line
  }

  /** The origin airport to the first point, when that was heard airborne LEAD_IN_NM or more from it: dotted, and its time. */
  #drawLeadIn(p: PathPoint | null, origin: RoutePlace | null): void {
    const on = p !== null && origin !== null && !p.onGround && distanceNm(origin.lat, origin.lon, p.lat, p.lon) >= LEAD_IN_NM
    this.#leadIn.show = this.#firstDot.show = this.#firstLabel.show = on
    if (p === null || origin === null || !on) return
    this.#leadIn.positions = greatCircle(origin, p).map((q) => Cartesian3.fromDegrees(q.lon, q.lat, p.hM))
    const there = Cartesian3.fromDegrees(p.lon, p.lat, p.hM)
    this.#firstDot.position = there
    this.#firstLabel.position = there
    const text = firstHeardText(p.tMs)
    if (this.#firstLabel.text !== text) this.#firstLabel.text = text
  }

  /**
   * The last flown point to the aircraft. From a point on read ground both ends stand on it (the aircraft's hM there is
   * the geoid's). Inside a hole (unheard) dotted, along the great circle as the hole's own line.
   */
  #drawJoin(p: PathPoint | null, at: LinePoint, unheard: boolean): void {
    this.#join.show = p !== null && !unheard
    this.#joinGap.show = p !== null && unheard
    if (p === null) return
    const h = this.#lastLift
    if (unheard) this.#joinGap.positions = arc({ lat: p.lat, lon: p.lon, hM: h ?? p.hM }, { lat: at.lat, lon: at.lon, hM: h ?? at.hM })
    else this.#join.positions = [Cartesian3.fromDegrees(p.lon, p.lat, h ?? p.hM), Cartesian3.fromDegrees(at.lon, at.lat, h ?? at.hM)]
  }

  /** The dashed great circle to the destination, with its dot and code. */
  #drawAhead(at: LinePoint, dest: RoutePlace | null): void {
    this.#ahead.show = this.#dot.show = this.#label.show = dest !== null
    if (dest === null) return
    this.#ahead.positions = greatCircle(at, dest).map((p) => Cartesian3.fromDegrees(p.lon, p.lat, at.hM))
    const there = Cartesian3.fromDegrees(dest.lon, dest.lat, at.hM)
    this.#dot.position = there
    this.#label.position = there
    if (this.#label.text !== dest.code) this.#label.text = dest.code
  }

  destroy(): void {
    const p = this.#viewer.scene.primitives
    p.remove(this.#runs)
    p.remove(this.#lines)
    p.remove(this.#points)
    p.remove(this.#labels)
  }
}

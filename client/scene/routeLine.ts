// client/scene/routeLine.ts
// The selected aircraft's way on the top-down map: the path it has flown since it was selected (solid amber, from its
// samples) and a dashed great circle from it to its destination airport (the route's last airport, when the server
// knows where it is), with a dot and the airport's code there. Flightradar24-style: the line ahead is the shortest way,
// not the filed route (airways and procedures bend it, most near the airports).
import { Cartesian2, Cartesian3, Color, LabelCollection, LabelStyle, Material, NearFarScalar, PointPrimitiveCollection, PolylineCollection, VerticalOrigin } from 'cesium'
import type { Label, PointPrimitive, Polyline, Viewer } from 'cesium'
import type { RoutePlace } from '../../shared/info.ts'

export interface LinePoint {
  lat: number
  lon: number
  hM: number // WGS84 ellipsoidal metres, as the aircraft icons are drawn
}

const RAD = Math.PI / 180
const EARTH_NM = 3440.065
const STEP_NM = 20 // a 20 nm chord sags ~27 m below the arc: invisible from above
const MAX_POINTS = 400 // ≥ 8,000 nm at STEP_NM; longer legs get longer steps
const REDRAW_MS = 250 // the line follows the aircraft 4 times a second
const TRAIL = Color.fromCssColorString('#ffb020').withAlpha(0.95)
// Dark dashes with light gaps: they read over the pale street map and the dark satellite alike.
const AHEAD = Color.fromCssColorString('#1b2433').withAlpha(0.9)
const AHEAD_GAP = Color.fromCssColorString('#ffffff').withAlpha(0.75)
const LABEL_BG = Color.fromCssColorString('#16181d').withAlpha(0.85)

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

export class RouteLine {
  #lines: PolylineCollection
  #points: PointPrimitiveCollection
  #labels: LabelCollection
  #trail: Polyline
  #ahead: Polyline
  #dot: PointPrimitive
  #label: Label
  #viewer: Viewer
  #lastMs = -Infinity

  constructor(viewer: Viewer) {
    this.#viewer = viewer
    this.#lines = viewer.scene.primitives.add(new PolylineCollection())
    this.#points = viewer.scene.primitives.add(new PointPrimitiveCollection())
    this.#labels = viewer.scene.primitives.add(new LabelCollection())
    this.#trail = this.#lines.add({ width: 3, material: Material.fromType('Color', { color: TRAIL }), show: false })
    this.#ahead = this.#lines.add({ width: 3, material: Material.fromType('PolylineDash', { color: AHEAD, gapColor: AHEAD_GAP, dashLength: 16 }), show: false })
    this.#dot = this.#points.add({ pixelSize: 9, color: AHEAD, outlineColor: Color.WHITE, outlineWidth: 2, show: false, disableDepthTestDistance: Number.POSITIVE_INFINITY })
    this.#label = this.#labels.add({
      position: Cartesian3.ZERO, font: '600 12px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif',
      fillColor: Color.WHITE, style: LabelStyle.FILL, showBackground: true, backgroundColor: LABEL_BG,
      backgroundPadding: new Cartesian2(6, 3), verticalOrigin: VerticalOrigin.BOTTOM, pixelOffset: new Cartesian2(0, -10),
      scaleByDistance: new NearFarScalar(3e5, 1, 8e6, 0.7), disableDepthTestDistance: Number.POSITIVE_INFINITY, show: false,
    })
  }

  /**
   * at: the selected aircraft where it is drawn (null: nothing to show, e.g. none selected or the 3-D chase). trail: its
   * positions since it was selected, oldest first. dest: where
   * its route ends (null: unknown, no line ahead).
   * ponytail: the line ahead keeps the aircraft's height all the way (a descent profile would need the airport's
   * elevation); a hill higher than that under the line hides that bit of it.
   */
  update(at: LinePoint | null, trail: readonly LinePoint[], dest: RoutePlace | null, nowMs = performance.now()): void {
    const show = at !== null
    this.#trail.show = show && trail.length > 0
    this.#ahead.show = this.#dot.show = this.#label.show = show && dest !== null
    if (!show || nowMs - this.#lastMs < REDRAW_MS) return
    this.#lastMs = nowMs
    if (trail.length > 0) {
      // ponytail: the whole trail is rewritten 4 times a second (its last point is the aircraft); ≤ a few thousand points.
      const pts = trail.map((p) => Cartesian3.fromDegrees(p.lon, p.lat, p.hM))
      pts.push(Cartesian3.fromDegrees(at.lon, at.lat, at.hM))
      this.#trail.positions = pts
    }
    if (dest !== null) {
      this.#ahead.positions = greatCircle(at, dest).map((p) => Cartesian3.fromDegrees(p.lon, p.lat, at.hM))
      const there = Cartesian3.fromDegrees(dest.lon, dest.lat, at.hM)
      this.#dot.position = there
      this.#label.position = there
      if (this.#label.text !== dest.code) this.#label.text = dest.code
    }
    this.#viewer.scene.requestRender()
  }

  destroy(): void {
    const p = this.#viewer.scene.primitives
    p.remove(this.#lines)
    p.remove(this.#points)
    p.remove(this.#labels)
  }
}

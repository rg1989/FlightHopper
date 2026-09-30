// client/scene/runways.ts
import {
  CallbackPositionProperty,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  DistanceDisplayCondition,
  Ellipsoid,
  GeometryInstance,
  HorizontalOrigin,
  LabelStyle,
  Material,
  MaterialAppearance,
  Matrix4,
  PolygonGeometry,
  PolygonHierarchy,
  Primitive,
  VerticalOrigin,
  type Entity,
  type Viewer,
} from 'cesium'
import type { Airport, Runway, RunwayEnd } from '../../shared/airports.ts'
import { bearingDeg, destination } from '../../shared/geo.ts'
import type { TerrainFrame } from '../types.ts'
import { drawnHeightM } from './exaggeration.ts'
import { northAt } from './fleetLayer.ts'
import { runwayGeometry, runwayGeometryData, runwayMaterial } from './runwayPaint.ts'

/**
 * The paved rectangle of a runway: the two PHYSICAL ends (ends[i].lat/lon) ± half the width,
 * perpendicular to the end-to-end bearing. Order: left, right of ends[0], then right, left of ends[1]
 * ("left" = looking from ends[0] towards ends[1]), so the ring is a rectangle, not a bow tie.
 * h is WGS84 ellipsoidal metres. One bearing serves both ends: over a 4 km runway the great-circle
 * bearing turns < 0.03°, which moves a corner < 2 cm.
 * ponytail: each physical end takes its own THRESHOLD height (thrHaeM). At a displaced threshold the
 * plane is then off by (displacement / length) × (height difference): 6 cm at KSFO 28R, 21 cm at LOWI 08,
 * 1.4 m at LLBG 26 (1,969 ft displaced). Upgrade (M4): extrapolate the end heights so that the plane
 * passes through both thresholds.
 */
export function runwayCorners(r: Runway): { lat: number; lon: number; h: number }[] {
  const [a, b] = r.ends
  const brg = bearingDeg(a.lat, a.lon, b.lat, b.lon)
  const halfNm = (r.widthFt * 0.3048) / 2 / 1852
  const corner = (end: Runway['ends'][number], side: -90 | 90): { lat: number; lon: number; h: number } => ({
    ...destination(end.lat, end.lon, brg + side, halfNm),
    h: end.thrHaeM,
  })
  return [corner(a, -90), corner(a, 90), corner(b, 90), corner(b, -90)]
}

/**
 * Drawn this far above the runway HAE so the plane wins against terrain that matches it exactly.
 * ponytail: a fixed lift, not polygon offset (Cesium's log depth writes gl_FragDepth, which bypasses
 * polygon offset). Where terrain is more than this above the plane, the terrain hides it: that
 * residual is what M4 measures and fixes (plane vs globe.clippingPolygons).
 */
export const RUNWAY_LIFT_M = 0.2

const ASPHALT = Color.fromCssColorString('#3a3a3a')
const PAINT = Color.fromCssColorString('#e4e4dc') // the markings' white, a little worn
// Markers only near an airport, and not up close: within 3 km the painted runway shows its own designators.
const MARKER_NEAR_M = 3_000
const MARKER_FAR_M = 30_000
const MARKER_RANGE = new DistanceDisplayCondition(MARKER_NEAR_M, MARKER_FAR_M)
const RAD = Math.PI / 180
const MARKER_YELLOW = '#ffd23f'
// Each end's marker is an arrow from its threshold down the runway: the way planes go on it. It runs from the image's
// centre to its top edge, because a billboard turns about its centre; drawn at twice its size, for sharp Retina edges.
const ARROW_IMAGE = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 60 60" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M30 30V13" stroke="#000" stroke-width="6"/><path d="M30 2 21.5 15h17z" fill="#000" stroke="#000" stroke-width="2.5"/>' +
    `<path d="M30 30V13" stroke="${MARKER_YELLOW}" stroke-width="3.4"/><path d="M30 2 21.5 15h17z" fill="${MARKER_YELLOW}"/></svg>`,
)}`
const ARROW_BOX_PX = 60 // the billboard's size on screen
const ARROW_PX = 28 // the arrow's length on screen: threshold to tip
const AHEAD_M = 100 // a point this far down the runway gives the arrow's direction on screen
const LABEL_GAP_PX = 5 // the label's near edge this far behind the threshold
const SIDE = 0.38 // ≈ sin 22.5°: a label within 22.5° of straight behind stays centred on that axis
const HIT_BEHIND_PX = 24 // hover and tap reach this far behind the threshold (over the number) …
const HIT_SLOP_PX = 6 // … and this far beside the arrow
const TIP_BG = Color.fromCssColorString('#16181d') // as the aircraft hover label (fleetLayer.ts)
const TIP_PAD = new Cartesian2(7, 4)
// ponytail: the spelled-out label's size is estimated (Cesium measures it only when it draws it): 600 13px averages under
// 7.4 px a character. Upgrade: measureText with the label's font, if a long airport name ever overflows.
const TIP_CHAR_PX = 7.4
const TIP_LINE_PX = 16
const EDGE_PX = 8 // a spelled-out label stays this far inside the screen
const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest']
const PARALLEL: Record<string, string> = { L: 'Left', R: 'Right', C: 'Centre' }

/** The 8-point compass word of a heading in degrees (any number of turns). */
export function compassWord(deg: number): string {
  return COMPASS[((Math.round(deg / 45) % 8) + 8) % 8]
}

/**
 * What hovering or tapping a runway end says, from the data alone (any airport): its designator, which way planes go on
 * it (its true heading as a compass word: the designator is the magnetic heading ÷ 10, and degrees beside it would not
 * match), its length, and which of the side-by-side runways an L, R or C one is.
 */
export function runwayTip(ap: Airport, r: Runway, e: RunwayEnd): string {
  const lines = [`Runway ${e.ident}`, `Planes head ${compassWord(e.hdgTrueDeg)} · ${((r.lengthFt * 0.3048) / 1000).toFixed(1)} km`]
  const m = /^(\d+)([LRC])$/.exec(e.ident)
  if (m !== null) {
    const n = ap.runways.filter((x) => x.ends.some((y) => y.ident.slice(0, -1) === m[1] && /[LRC]$/.test(y.ident))).length
    if (n >= 2) lines.push(`${PARALLEL[m[2]]} of ${n} parallel runways`)
  }
  return lines.join('\n')
}

/** Where a runway end's label sits, as Cesium's label origin and pixel offset. */
export interface LabelSide {
  x: number
  y: number
  h: HorizontalOrigin
  v: VerticalOrigin
}

/**
 * The label behind the arrow, whose screen direction is (dx, dy) (a unit vector, y down), and growing away from it: it
 * never covers the arrow, whatever the runway's heading, the camera's, or the label's length. Writes out.
 */
export function labelSide(dx: number, dy: number, out: LabelSide): LabelSide {
  out.x = -dx * LABEL_GAP_PX
  out.y = -dy * LABEL_GAP_PX
  out.h = -dx > SIDE ? HorizontalOrigin.LEFT : -dx < -SIDE ? HorizontalOrigin.RIGHT : HorizontalOrigin.CENTER
  out.v = -dy > SIDE ? VerticalOrigin.TOP : -dy < -SIDE ? VerticalOrigin.BOTTOM : VerticalOrigin.CENTER
  return out
}

/**
 * A label w × h px, anchored at (sx, sy) on a W × H screen with its origin and offset in side, moved (side.x, side.y)
 * just enough to lie EDGE_PX inside the screen: a spelled-out one near an edge, e.g. on a phone. Writes side.
 */
export function keepOnScreen(side: LabelSide, sx: number, sy: number, w: number, h: number, W: number, H: number): LabelSide {
  const left = sx + side.x - (side.h === HorizontalOrigin.LEFT ? 0 : side.h === HorizontalOrigin.RIGHT ? w : w / 2)
  const top = sy + side.y - (side.v === VerticalOrigin.TOP ? 0 : side.v === VerticalOrigin.BOTTOM ? h : h / 2)
  if (left + w > W - EDGE_PX) side.x -= left + w - (W - EDGE_PX)
  else if (left < EDGE_PX) side.x += EDGE_PX - left
  if (top + h > H - EDGE_PX) side.y -= top + h - (H - EDGE_PX)
  else if (top < EDGE_PX) side.y += EDGE_PX - top
  return side
}

/** One runway end's marker: its arrow and label, and where the camera last saw them. */
interface Marker {
  at: Cartesian3 // the threshold, built (true height + the lift): its airport's model places it
  ahead: Cartesian3 // AHEAD_M down the runway, built
  model: Matrix4 // its airport's
  short: string // the designator
  tip: string // runwayTip
  tipW: number // its estimated size on screen, px, background included
  tipH: number
  dx: number // the arrow's direction on screen, a unit vector (y down); until the first aim: as seen north up
  dy: number
  sx: number // the threshold on screen, canvas px; NaN: hidden (out of MARKER_RANGE) or not in front of the camera
  sy: number
  side: LabelSide
  offset: Cartesian2 // side.x, side.y: what the label's pixelOffset reads
}

/** Distance from (px, py) to the segment (ax, ay)–(bx, by). */
function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax
  const vy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)))
  return Math.hypot(px - ax - t * vx, py - ay - t * vy)
}
/** The smallest scale along up in a modelMatrix: at 0 it is singular, and Cesium inverts it (Matrix4.inverse throws). */
const MIN_SCALE = 1e-3
const COLS = Matrix4.toArray(Matrix4.IDENTITY) // followExaggeration's scratch (column-major): it allocates nothing

/**
 * The modelMatrix that moves geometry built at true heights to where the terrain is drawn at factor f around relHM: along
 * up (n), a scale by max(f, 1e-3) about base (the point hM above the reference, n · base = upDotBase), then a shift by
 * drawnHeightM(hM, f, relHM) − hM. The drawn height is affine in the true one, so every height near the reference lands on
 * its drawn height, not only hM; what one n cannot follow is the Earth's curvature, (1 − f)·d²/2R at d from the reference.
 * Writes result (and a module scratch): allocates nothing. f = 1: the identity.
 */
export function followExaggeration(up: Cartesian3, upDotBase: number, hM: number, f: number, relHM: number, result: Matrix4): Matrix4 {
  // x ↦ x + k·n·(n·x − n·base) + n·(drawn(h) − h): I + k·n·nᵀ, then a translation along n.
  const k = Math.max(f, MIN_SCALE) - 1
  const { x, y, z } = up
  const t = drawnHeightM(hM, f, relHM) - hM - k * upDotBase
  COLS[0] = 1 + k * x * x
  COLS[1] = k * y * x
  COLS[2] = k * z * x
  COLS[4] = k * x * y
  COLS[5] = 1 + k * y * y
  COLS[6] = k * z * y
  COLS[8] = k * x * z
  COLS[9] = k * y * z
  COLS[10] = 1 + k * z * z
  COLS[12] = t * x
  COLS[13] = t * y
  COLS[14] = t * z
  return Matrix4.fromColumnMajorArray(COLS, result)
}

/** One airport's planes and markers: they move together with the terrain exaggeration (design D7). */
interface Placed {
  planes: Primitive[] // one per runway: each its own markings (runwayPaint.ts)
  model: Matrix4 // where update() puts them: copied into planes.modelMatrix, and applied by the markers
  hM: number // the airport's runway height: mean of its thresholds' thrHaeM
  up: Cartesian3 // n: ellipsoid normal at the airport reference point
  upDotBase: number // n · base, base = the point hM + RUNWAY_LIFT_M above the reference point: update() scales about it
}

/**
 * Runway planes + threshold markers for these airports. The planes are one unpickable Primitive per
 * airport, so that each airport can follow the terrain exaggeration (update). PolygonGeometry with
 * perPositionHeight draws two flat triangles through the corners, i.e. a plane between the two end heights
 * (mid-runway it sits ≈ L²/8R ≈ 0.26 m below a surface parallel to the ellipsoid for KSFO 28R's 3.6 km).
 * The planes are lit (normals: each plane's own, within its slope of the ellipsoid normal: 0.16° at LLBG
 * 08/26), and their colour follows WP-E2's light (setLight), so they darken with the terrain at night. They
 * cast and receive no shadows (Primitive's default; design D10). Markers are entities at thrLat/thrLon/thrHaeM that stay
 * visible through terrain: an arrow down the runway (the way planes go on it, turned by the end's true heading from
 * north, like the aircraft icons) with the designator behind it; hover(), or a tap, spells one out (runwayTip).
 */
export function addRunways(
  viewer: Viewer,
  airports: Airport[],
  opts: { markers?: boolean } = {}, // markers: the threshold arrows and idents (default on; a scenario's airfield: off)
): {
  update(frame: TerrainFrame): void
  setLight(look: { dayBrightness: number; intensity: number } | null): void
  hover(pos: Cartesian2 | null, px?: number): boolean
  destroy(): void
} {
  const placed: Placed[] = []
  const markers: Entity[] = []
  const ends: Marker[] = []
  let open: Marker | null = null // the one hover() spells out
  const asphalt = ASPHALT.clone() // every runway's material reads both: setLight() writes them in place
  const paint = PAINT.clone()
  for (const ap of airports) {
    if (ap.runways.length === 0) continue
    const planes: Primitive[] = []
    const model = Matrix4.clone(Matrix4.IDENTITY)
    let sumH = 0
    for (const r of ap.runways) {
      const d = runwayGeometryData(r, RUNWAY_LIFT_M)
      planes.push(
        viewer.scene.primitives.add(
          new Primitive({
            geometryInstances: new GeometryInstance({ geometry: runwayGeometry(d) }),
            appearance: new MaterialAppearance({
              material: runwayMaterial(d, r, asphalt, paint),
              materialSupport: MaterialAppearance.MaterialSupport.TEXTURED, // position, normal, st (metres)
              flat: false,
              translucent: false,
            }),
            asynchronous: false,
            allowPicking: false,
            compressVertices: false, // st is in metres: compression packs it as two 12-bit fractions of 1
          }),
        ),
      )
      for (const e of r.ends) {
        sumH += e.thrHaeM
        if (opts.markers === false) continue
        const at = Cartesian3.fromDegrees(e.thrLon, e.thrLat, e.thrHaeM + RUNWAY_LIFT_M)
        const fwd = destination(e.thrLat, e.thrLon, e.hdgTrueDeg, AHEAD_M / 1852)
        const dx = Math.sin(e.hdgTrueDeg * RAD)
        const dy = -Math.cos(e.hdgTrueDeg * RAD)
        const side = labelSide(dx, dy, { x: 0, y: 0, h: HorizontalOrigin.CENTER, v: VerticalOrigin.CENTER })
        const tip = runwayTip(ap, r, e)
        const lines = tip.split('\n')
        const m: Marker = {
          at, ahead: Cartesian3.fromDegrees(fwd.lon, fwd.lat, e.thrHaeM + RUNWAY_LIFT_M), model, short: e.ident, tip,
          tipW: Math.max(...lines.map((l) => l.length)) * TIP_CHAR_PX + 2 * TIP_PAD.x, tipH: lines.length * TIP_LINE_PX + 2 * TIP_PAD.y,
          dx, dy, sx: NaN, sy: NaN, side, offset: new Cartesian2(side.x, side.y),
        }
        ends.push(m)
        markers.push(
          viewer.entities.add({
            // evaluated by Cesium every frame anyway; callbacks follow the planes and the camera without entity change events
            position: new CallbackPositionProperty((_t, result) => Matrix4.multiplyByPoint(model, at, result ?? new Cartesian3()), false),
            billboard: {
              image: ARROW_IMAGE,
              width: ARROW_BOX_PX,
              height: ARROW_BOX_PX,
              alignedAxis: northAt(e.thrLat, e.thrLon, new Cartesian3()), // rotation from north: −heading points it down the runway
              rotation: -e.hdgTrueDeg * RAD,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              distanceDisplayCondition: MARKER_RANGE,
            },
            label: {
              text: new CallbackProperty(() => (open === m ? m.tip : m.short), false),
              font: '600 13px system-ui, sans-serif',
              style: LabelStyle.FILL_AND_OUTLINE,
              fillColor: Color.WHITE,
              outlineColor: Color.BLACK,
              outlineWidth: 3,
              showBackground: new CallbackProperty(() => open === m, false),
              backgroundColor: TIP_BG,
              backgroundPadding: TIP_PAD,
              horizontalOrigin: new CallbackProperty(() => m.side.h, false),
              verticalOrigin: new CallbackProperty(() => m.side.v, false),
              pixelOffset: new CallbackProperty(() => m.offset, false),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              distanceDisplayCondition: MARKER_RANGE,
            },
          }),
        )
      }
    }
    const hM = sumH / (2 * ap.runways.length)
    const up = Ellipsoid.WGS84.geodeticSurfaceNormalCartographic(Cartographic.fromDegrees(ap.lon, ap.lat))
    placed.push({
      planes,
      model,
      hM,
      up,
      upDotBase: Cartesian3.dot(up, Cartesian3.fromDegrees(ap.lon, ap.lat, hM + RUNWAY_LIFT_M)),
    })
  }
  // Each frame, where the camera sees each end and which way its runway runs on screen, so the label sits behind the
  // arrow in any view (a turned map, the tilted chase). One frame late: Cesium reads the labels before it renders.
  // ponytail: every end every frame (2 projections each: 16 at the hero airports); thousands of airports: aim only the
  // ends within MARKER_FAR_M.
  const scene = viewer.scene
  const placedAt = new Cartesian3()
  const aheadAt = new Cartesian3()
  const onScreen = new Cartesian2()
  const aheadOnScreen = new Cartesian2()
  const aim = (): void => {
    for (const m of ends) {
      m.sx = m.sy = NaN
      Matrix4.multiplyByPoint(m.model, m.at, placedAt)
      const d = Cartesian3.distance(scene.camera.positionWC, placedAt)
      if (!(d >= MARKER_NEAR_M && d <= MARKER_FAR_M)) continue
      const a = scene.cartesianToCanvasCoordinates(placedAt, onScreen)
      const b = scene.cartesianToCanvasCoordinates(Matrix4.multiplyByPoint(m.model, m.ahead, aheadAt), aheadOnScreen)
      if (a === undefined || b === undefined) continue
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      if (!(len > 1e-9)) continue
      m.dx = (b.x - a.x) / len
      m.dy = (b.y - a.y) / len
      m.sx = a.x
      m.sy = a.y
      labelSide(m.dx, m.dy, m.side)
      if (m === open) keepOnScreen(m.side, a.x, a.y, m.tipW, m.tipH, scene.canvas.clientWidth, scene.canvas.clientHeight)
      m.offset.x = m.side.x
      m.offset.y = m.side.y
    }
  }
  const stopAim = ends.length > 0 ? scene.preRender.addEventListener(aim) : null
  let f = 1 // the factor and relH the planes are placed for; as built: the terrain as loaded
  let relHM = 0
  return {
    /**
     * Puts each airport's planes and markers where the terrain around it is drawn: along its up n, a scale by
     * s = max(f, 1e-3) about base (the airport's runway height h + the lift), then a shift by drawnHeightM(h, f, relH) − h.
     * The scale flattens each runway's own slope with the terrain: a point built at h′ ends up off the drawn terrain
     * (+ the lift) by (s − f)(h′ − h), ≤ 7 mm (LLBG's 7.4 m span × 1e-3), plus the Earth's curvature under the plane
     * through base, (1 − s)·d²/2R at d from the reference point: at f = 0 the planes float up to 0.48 m (LLBG's 08 end,
     * 2.5 km out; KSFO 0.29 m, LOWI 0.08 m) and are never under the drawn terrain. s stays ≥ 1e-3 because Cesium inverts
     * the modelMatrix (czm_normal, the camera's model-space position); the normals flatten with the planes.
     * Only when fNow or relHM changed: idle frames cost one comparison. A non-finite frame is ignored (it would reach
     * Cesium's matrices).
     */
    update(frame: TerrainFrame): void {
      if (frame.fNow === f && frame.relHM === relHM) return
      if (!Number.isFinite(frame.fNow) || !Number.isFinite(frame.relHM)) return
      f = frame.fNow
      relHM = frame.relHM
      for (const p of placed) {
        followExaggeration(p.up, p.upDotBase, p.hM, f, relHM, p.model)
        for (const pl of p.planes) Matrix4.clone(p.model, pl.modelMatrix) // in place: Primitive compares it every frame
      }
    },
    /**
     * The planes' colour under WP-E2's light: sunLook's dayBrightness and intensity while the Sun is on, null while it
     * is off (as built). They are lit by czm_phong, which keeps half the colour as unlit ambient: on its own a plane
     * never drops below 0.5× its colour (0.73× at E2's night intensity 0.45), while the terrain around it goes to
     * 0.3 × 0.45 of its imagery. So the colour is scaled by k = dayBrightness × 2L / (1 + L), L = min(1, intensity)
     * (czm_lightColor: a white light, normalised above 1). Seen from above, a plane is then as dark as the day imagery
     * under the same light: k is 0.9999 by day and 0.19 at night. It writes the one Color every airport's material
     * reads, every frame if need be: nothing is allocated and no vertex is touched. A non-finite k is ignored.
     */
    setLight(look: { dayBrightness: number; intensity: number } | null): void {
      const l = look === null ? 1 : Math.min(1, look.intensity)
      const k = look === null ? 1 : (2 * look.dayBrightness * l) / (1 + l)
      if (!Number.isFinite(k)) return
      asphalt.red = ASPHALT.red * k
      asphalt.green = ASPHALT.green * k
      asphalt.blue = ASPHALT.blue * k
      paint.red = PAINT.red * k
      paint.green = PAINT.green * k
      paint.blue = PAINT.blue * k
    },
    /**
     * The end whose arrow or number is under pos (canvas px, within px + a few) spells itself out, the nearest if several;
     * any other goes back to its designator. null, or nothing there: all do. Whether one is under pos.
     */
    hover(pos: Cartesian2 | null, px = 3): boolean {
      let hit: Marker | null = null
      let best = px + HIT_SLOP_PX
      if (pos !== null) {
        for (const m of ends) {
          if (Number.isNaN(m.sx)) continue
          const d = segmentDistance(pos.x, pos.y, m.sx - m.dx * HIT_BEHIND_PX, m.sy - m.dy * HIT_BEHIND_PX, m.sx + m.dx * ARROW_PX, m.sy + m.dy * ARROW_PX)
          if (d <= best) {
            hit = m
            best = d
          }
        }
      }
      open = hit
      return hit !== null
    },
    destroy(): void {
      if (viewer.isDestroyed()) return
      stopAim?.()
      for (const p of placed) for (const pl of p.planes) viewer.scene.primitives.remove(pl)
      for (const m of markers) viewer.entities.remove(m)
    },
  }
}

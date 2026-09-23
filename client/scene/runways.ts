// client/scene/runways.ts
import {
  CallbackPositionProperty,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  DistanceDisplayCondition,
  Ellipsoid,
  GeometryInstance,
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
import type { Airport, Runway } from '../../shared/airports.ts'
import { bearingDeg, destination } from '../../shared/geo.ts'
import type { TerrainFrame } from '../types.ts'
import { drawnHeightM } from './exaggeration.ts'

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
const MARKER_RANGE = new DistanceDisplayCondition(0, 30_000) // markers only near an airport
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
  planes: Primitive
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
 * cast and receive no shadows (Primitive's default; design D10). Markers are entities (a point + the end's
 * ident at thrLat/thrLon/thrHaeM) that stay visible through terrain.
 */
export function addRunways(
  viewer: Viewer,
  airports: Airport[],
): {
  update(frame: TerrainFrame): void
  setLight(look: { dayBrightness: number; intensity: number } | null): void
  destroy(): void
} {
  const placed: Placed[] = []
  const markers: Entity[] = []
  const paint = ASPHALT.clone() // every airport's material reads it: setLight() writes it in place
  for (const ap of airports) {
    if (ap.runways.length === 0) continue
    const instances: GeometryInstance[] = []
    const model = Matrix4.clone(Matrix4.IDENTITY)
    let sumH = 0
    for (const r of ap.runways) {
      const corners = runwayCorners(r).map((c) => Cartesian3.fromDegrees(c.lon, c.lat, c.h + RUNWAY_LIFT_M))
      instances.push(
        new GeometryInstance({
          geometry: new PolygonGeometry({
            polygonHierarchy: new PolygonHierarchy(corners),
            perPositionHeight: true,
            vertexFormat: MaterialAppearance.MaterialSupport.BASIC.vertexFormat,
          }),
        }),
      )
      for (const e of r.ends) {
        sumH += e.thrHaeM
        const at = Cartesian3.fromDegrees(e.thrLon, e.thrLat, e.thrHaeM + RUNWAY_LIFT_M)
        markers.push(
          viewer.entities.add({
            // evaluated by Cesium every frame anyway; a callback follows the planes without entity change events
            position: new CallbackPositionProperty((_t, result) => Matrix4.multiplyByPoint(model, at, result ?? new Cartesian3()), false),
            point: {
              pixelSize: 7,
              color: Color.YELLOW,
              outlineColor: Color.BLACK,
              outlineWidth: 1,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              distanceDisplayCondition: MARKER_RANGE,
            },
            label: {
              text: e.ident,
              font: '13px sans-serif',
              style: LabelStyle.FILL_AND_OUTLINE,
              fillColor: Color.WHITE,
              outlineColor: Color.BLACK,
              outlineWidth: 3,
              verticalOrigin: VerticalOrigin.BOTTOM,
              pixelOffset: new Cartesian2(0, -8),
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
      planes: viewer.scene.primitives.add(
        new Primitive({
          geometryInstances: instances,
          appearance: new MaterialAppearance({
            material: Material.fromType('Color', { color: paint }),
            materialSupport: MaterialAppearance.MaterialSupport.BASIC, // position + normal
            flat: false,
            translucent: false,
          }),
          asynchronous: false,
          allowPicking: false,
        }),
      ),
      model,
      hM,
      up,
      upDotBase: Cartesian3.dot(up, Cartesian3.fromDegrees(ap.lon, ap.lat, hM + RUNWAY_LIFT_M)),
    })
  }
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
        Matrix4.clone(p.model, p.planes.modelMatrix) // in place: Primitive compares it every frame
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
      paint.red = ASPHALT.red * k
      paint.green = ASPHALT.green * k
      paint.blue = ASPHALT.blue * k
    },
    destroy(): void {
      if (viewer.isDestroyed()) return
      for (const p of placed) viewer.scene.primitives.remove(p.planes)
      for (const m of markers) viewer.entities.remove(m)
    },
  }
}

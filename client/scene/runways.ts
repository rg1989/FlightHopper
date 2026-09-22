// client/scene/runways.ts
import {
  Cartesian2,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  DistanceDisplayCondition,
  GeometryInstance,
  LabelStyle,
  PerInstanceColorAppearance,
  PolygonGeometry,
  PolygonHierarchy,
  Primitive,
  VerticalOrigin,
  type Entity,
  type Viewer,
} from 'cesium'
import type { Airport, Runway } from '../../shared/airports.ts'
import { bearingDeg, destination } from '../../shared/geo.ts'

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

/**
 * Runway planes + threshold markers for these airports. The planes are one batched, unpickable
 * Primitive: PolygonGeometry with perPositionHeight draws two flat triangles through the corners,
 * i.e. a plane between the two end heights (mid-runway it sits ≈ L²/8R ≈ 0.26 m below a surface
 * parallel to the ellipsoid for KSFO 28R's 3.6 km). Markers are entities (a point + the end's ident
 * at thrLat/thrLon/thrHaeM) that stay visible through terrain.
 */
export function addRunways(viewer: Viewer, airports: Airport[]): { destroy(): void } {
  const instances: GeometryInstance[] = []
  const markers: Entity[] = []
  for (const ap of airports) {
    for (const r of ap.runways) {
      const corners = runwayCorners(r).map((c) => Cartesian3.fromDegrees(c.lon, c.lat, c.h + RUNWAY_LIFT_M))
      instances.push(
        new GeometryInstance({
          geometry: new PolygonGeometry({
            polygonHierarchy: new PolygonHierarchy(corners),
            perPositionHeight: true,
            vertexFormat: PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
          }),
          attributes: { color: ColorGeometryInstanceAttribute.fromColor(ASPHALT) },
        }),
      )
      for (const e of r.ends) {
        markers.push(
          viewer.entities.add({
            position: Cartesian3.fromDegrees(e.thrLon, e.thrLat, e.thrHaeM + RUNWAY_LIFT_M),
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
  }
  const planes =
    instances.length === 0
      ? null
      : viewer.scene.primitives.add(
          new Primitive({
            geometryInstances: instances,
            appearance: new PerInstanceColorAppearance({ flat: true, translucent: false }),
            asynchronous: false,
            allowPicking: false,
          }),
        )
  return {
    destroy(): void {
      if (viewer.isDestroyed()) return
      if (planes) viewer.scene.primitives.remove(planes)
      for (const m of markers) viewer.entities.remove(m)
    },
  }
}

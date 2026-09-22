// client/scene/runways.ts
import type { Runway } from '../../shared/airports.ts'
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

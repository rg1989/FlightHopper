// shared/enu.ts
// Exact WGS84 geodetic ↔ ECEF. Degrees in and out, metres of ellipsoidal height (HAE).
// Spherical shortcuts for distances and bearings live in shared/geo.ts.

export const WGS84_A = 6378137
export const WGS84_F = 1 / 298.257223563
const E2 = WGS84_F * (2 - WGS84_F) // first eccentricity squared

const rad = (d: number): number => (d * Math.PI) / 180
const deg = (r: number): number => (r * 180) / Math.PI

export function geodeticToEcef(latDeg: number, lonDeg: number, hM: number): [number, number, number] {
  const φ = rad(latDeg)
  const λ = rad(lonDeg)
  const sφ = Math.sin(φ)
  const cφ = Math.cos(φ)
  const n = WGS84_A / Math.sqrt(1 - E2 * sφ * sφ) // prime-vertical radius of curvature
  return [(n + hM) * cφ * Math.cos(λ), (n + hM) * cφ * Math.sin(λ), (n * (1 - E2) + hM) * sφ]
}

/**
 * Fixed-point iteration on latitude; each pass shrinks the error by ≈ e² (0.0067), so 5 passes reach
 * double precision for any point within tens of km of the surface. Height uses the form that stays
 * exact at the poles (no division by cos φ).
 * ponytail: not valid near the Earth's centre (|h| ≳ 1000 km below surface); upgrade to Vermeille (2011) closed form if ever needed.
 */
export function ecefToGeodetic(x: number, y: number, z: number): { lat: number; lon: number; h: number } {
  const p = Math.hypot(x, y)
  let φ = Math.atan2(z, p * (1 - E2))
  for (let i = 0; i < 5; i++) {
    const sφ = Math.sin(φ)
    φ = Math.atan2(z + (E2 * WGS84_A * sφ) / Math.sqrt(1 - E2 * sφ * sφ), p)
  }
  const sφ = Math.sin(φ)
  const h = p * Math.cos(φ) + z * sφ - WGS84_A * Math.sqrt(1 - E2 * sφ * sφ)
  return { lat: deg(φ), lon: deg(Math.atan2(y, x)), h }
}

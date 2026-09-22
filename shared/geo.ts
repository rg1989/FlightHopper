// Spherical-earth helpers for distances and bearings (≤ 0.5 % error — fine for cells, hop and runway offsets).
// Precise ellipsoidal ECEF/ENU math lives in shared/enu.ts.

const R_NM = 3440.065
const rad = (d: number): number => (d * Math.PI) / 180
const deg = (r: number): number => (r * 180) / Math.PI

export function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1)
  const dLon = rad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** Initial true bearing from point 1 to point 2, degrees in [0, 360). */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = rad(lat1)
  const φ2 = rad(lat2)
  const dλ = rad(lon2 - lon1)
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (deg(Math.atan2(y, x)) + 360) % 360
}

/** Point reached from (lat, lon) after distNm along initial true bearing brgDeg. */
export function destination(lat: number, lon: number, brgDeg: number, distNm: number): { lat: number; lon: number } {
  const δ = distNm / R_NM
  const θ = rad(brgDeg)
  const φ1 = rad(lat)
  const λ1 = rad(lon)
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return { lat: deg(φ2), lon: ((deg(λ2) + 540) % 360) - 180 }
}

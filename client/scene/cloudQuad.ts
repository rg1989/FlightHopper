// client/scene/cloudQuad.ts
// Where one of Cesium's clouds (CloudCollection) ends inside its billboard, so that no puff shows a hard edge. Pure (no Cesium,
// no DOM): it follows the geometry of Cesium 1.145's fragment shader (Shaders/CloudCollectionFS.glsl), read 2026-10-03.
// The shader ray-casts a sphere of radius 0.5, scaled by 0.82 × maximumSize, from an eye 10 + max(0.82 z − 10, 0) in front of the
// billboard, through each of its pixels: the pixel's offset in the billboard (−0.5 … 0.5) times maximumSize.xy. Because the
// offset is scaled by maximumSize.xy, neither the billboard's aspect nor maximumSize.x and .y decide where the cloud ends in its
// quad: maximumSize.z and the slice do (quadReach: a disc, a share of the quad's half size, the same along x and y). A slice cuts
// the sphere by a plane; only rays whose hit lies inside the plane's disc draw anything, and where that region ends, and at the
// quad's own edge if it gets there, the alpha is whatever the geometry says: 1.3 × ndDot³ less the noise, ndDot being the
// cosine between the surface normal and the ray. A cloud cut low and narrow, as a tower's puff or an anvil is, has a hard
// rim there (or a hard cut by the quad's edge); the noise only takes alpha away, never adds it, so the noise-free value is the
// most the shader can draw whatever the noise texture holds, which the browser's, or its GPU's, may make low.
// edgeAlpha is that value; staysInside says it is no more than EDGE_ALPHA; softSlice raises a slice just far enough that it is.

/** A cloud's maximumSize: x, y, z, in the units of Cesium's cloud noise. */
export type Size = readonly [number, number, number]

export const EDGE_ALPHA = 0.03 // the most a puff may draw at its end, noise-free: 3 % is no edge to see
export const SLICE_MAX = 0.95
const FIT = 0.82 // the shader's ellipsoid is this much of maximumSize
const FAN = [0, Math.PI / 2] // the directions an edge is read along: along the axes, where the rim's ndDot is least and most (a fan of 19 directions, over 40,000 shapes and slices, never found a worse one)

/** How far in front of the cloud's centre the shader puts the eye: 10 or more (the quad's plane, through which the rays pass, is 1 behind the centre). */
const eyeOf = (mz: number): number => 10 + Math.max(FIT * mz - 10, 0)

/**
 * ndDot at the pixel offset (vx, vy) of the quad (−0.5 … 0.5): the cosine of the angle between the cloud's surface and the
 * ray, 0 … 1; −1 where the ray draws nothing (it misses the sphere, or its hit is outside the slice's disc).
 */
export function ndDotAt(m: Size, slice: number, vx: number, vy: number): number {
  const sx = FIT * m[0]
  const sy = FIT * m[1]
  const sz = FIT * m[2]
  const eyeZ = -eyeOf(m[2])
  const cx = m[0] * vx
  const cy = m[1] * vy
  const dz0 = 1 - eyeZ
  const len = Math.sqrt(cx * cx + cy * cy + dz0 * dz0)
  const rx = cx / len // the ray's direction, in the space the shader casts it in
  const ry = cy / len
  const rz = dz0 / len
  const oz = eyeZ / sz // the sphere's own space: the origin on its z axis, the direction scaled by 1 / (the ellipsoid)
  const dx = rx / sx
  const dy = ry / sy
  const dz = rz / sz
  const a = dx * dx + dy * dy + dz * dz
  const b = oz * dz
  const disc = b * b - a * (oz * oz - 0.25)
  if (disc < 0) return -1
  const root = Math.sqrt(disc)
  let t = (-b - root) / a
  if (t < 0) t = (-b + root) / a
  const px = t * dx
  const py = t * dy
  let pz = oz + t * dz
  if (slice >= 0) pz = slice / 2 - 0.5 // the slice: the hit's z is the plane's
  const p2 = px * px + py * py + pz * pz
  if (slice >= 0 && p2 > 0.25) return -1 // and the plane's disc is the sphere cut by it
  const nd = -(px * rx + py * ry + pz * rz) / Math.sqrt(p2) // the normal is the point's direction; the ray's own direction is the unscaled one
  return Math.min(1, Math.max(0, nd))
}

/**
 * How far the cloud reaches in its quad, as a share of the quad's half size (1: its edge; more: the quad cuts it): the hit region
 * ends where the ray passes through the circle in which the slice's plane meets the sphere, or, when the plane lies beyond the
 * sphere's silhouette (a high slice, or none), where it grazes the sphere.
 */
export function quadReach(m: Size, slice: number): number {
  const D = eyeOf(m[2])
  const q = D / (FIT * m[2]) // the eye's distance from the sphere's centre, in the sphere's own radius-0.5 space
  const zt = -0.25 / q // where the rays that graze the sphere touch it
  const zs = slice >= 0 ? slice / 2 - 0.5 : Infinity
  const z = zs <= zt ? zs : zt
  const rho = Math.sqrt(0.25 - z * z)
  return (2 * rho * (1 + D)) / (m[2] * (z + q))
}

/**
 * The most alpha the shader can draw on the edge of what it draws, whatever the noise (it can only take away from 1.3 ndDot³): at
 * the end of the hit region where that is inside the quad, at the quad's edge where the region reaches it.
 */
export function edgeAlpha(m: Size, slice: number): number {
  const uReach = quadReach(m, slice) / 2
  let worst = 0
  for (const a of FAN) {
    const uQuad = 0.5 / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)))
    const u = Math.min(uReach, uQuad) * (1 - 1e-7)
    const nd = ndDotAt(m, slice, u * Math.cos(a), u * Math.sin(a))
    if (nd >= 0) worst = Math.max(worst, Math.min(1, 1.3 * nd ** 3))
  }
  return worst
}

/** Whether a puff fades out inside its quad: what it can draw at its end is no more than EDGE_ALPHA. */
export function staysInside(c: { maxSize: Size; slice: number }): boolean {
  return edgeAlpha(c.maxSize, c.slice) <= EDGE_ALPHA
}

/**
 * The slice itself if its puff stays inside its quad; else the lowest slice above it at which it does: the edge's alpha falls as
 * the slice rises (a higher slice cuts the sphere nearer its middle, where the surface faces away), and at SLICE_MAX it is
 * under 0.001 for every shape (checked for sizes from 0.5 to 200), so the search always has an end that is soft.
 */
export function softSlice(m: Size, slice: number): number {
  if (edgeAlpha(m, slice) <= EDGE_ALPHA) return slice
  let [lo, hi] = [slice, SLICE_MAX]
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2
    if (edgeAlpha(m, mid) <= EDGE_ALPHA) hi = mid
    else lo = mid
  }
  return hi
}

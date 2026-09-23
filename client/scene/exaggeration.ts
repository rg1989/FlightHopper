// client/scene/exaggeration.ts
/**
 * Terrain vertical exaggeration arithmetic for the topography toggle (design D2–D5, D7). Pure: no Cesium import.
 * Cesium draws a terrain point of true height h (HAE m) at (h − relH)·f + relH, where f = scene.verticalExaggeration
 * and relH = scene.verticalExaggerationRelativeHeight (Core/VerticalExaggeration.getHeight, GlobeVS.glsl). f = 0 is a
 * flat map at relH. globe.getHeight returns this drawn surface; sampleTerrain returns the true one.
 */

/**
 * The factor while topography is on. Never exactly 1: when the factor leaves 1, Cesium adds geodetic surface normals to
 * every loaded tile (a new vertex buffer each) and strips them again when it returns to 1. In the PoC that made the
 * first frame of a sink 686–2,008 ms; with 1 + 1e-5 the worst animation frame was 36–44 ms. The peaks move by 1e-5 of
 * their height above relH (2 cm at LOWI). Cost: the normals stay, ~30 % more terrain-mesh memory.
 */
export const TOPO_ON = 1 + 1e-5

/** Below this factor the ground is flat: 0, or 1e-7 after Topography's nudge (D3). */
const FLAT_F = 1e-4

/**
 * A globe.getHeight reading carries the picker's own error: a flat triangle under the curved Earth reads low in its
 * middle (3.5 cm for a 1 km triangle, 0.9 m for 5 km). Inverting multiplies that by (1 − f)/f, more than 1 below 0.5.
 */
const INVERT_MIN_F = 0.5

/** Where Cesium draws a terrain point of true height trueM, at factor f around relHM. */
export function drawnHeightM(trueM: number, f: number, relHM: number): number {
  return (trueM - relHM) * f + relHM
}

/** The true height of a drawn reading (globe.getHeight at factor f). null while f < 0.5: flat, or too flat to invert. */
export function trueHeightM(drawnM: number, f: number, relHM: number): number | null {
  return f < INVERT_MIN_F ? null : (drawnM - relHM) / f + relHM
}

/**
 * A globe.getHeight reading → the ground drawn this frame, at fNow. fSampled is the factor the tiles held when the
 * reading was taken: for one taken this frame in scene.preUpdate, the previous render's (Cesium hands a new factor to
 * the tiles only inside render()); for a kept one of any age (WP-E1's GroundMemo), the fSampled of the frame that read
 * it, around the same relHM. A fixed point's drawn height follows the factor exactly, so age adds no error of its own.
 * Mid-animation the raw reading is off by up to 1 % of the relief per frame at 60 fps (17 m at LOWI), more than the
 * camera's 15 m clearance.
 * A reading taken while flat (fSampled < 1e-4) holds no relief: returns relHM, off by fNow·relief. That is ~0 for this
 * frame's reading on a grow's first frame, but 258 m at the Nordkette if kept to a 60 fps grow's 37th (f = 0.15).
 * ponytail: fNow / fSampled is not capped (up to 1e4) and multiplies the picker's own error: 4× for last frame's
 * reading on a 60 fps grow's second frame, ~1,150× for a reading from there kept to the 37th (3 mm → 3.6 m).
 * Upgrade: cap the ratio, or the age of a kept reading, if a check against the true ground (sampleTerrain at fNow)
 * shows it. A clearance computed from this result cannot show it.
 */
export function rescaleSampledM(sampledM: number, fSampled: number, fNow: number, relHM: number): number {
  return fSampled < FLAT_F ? relHM : (sampledM - relHM) * (fNow / fSampled) + relHM
}

/** 3u² − 2u³ clamped: 0 for u ≤ 0 (and NaN), 1 for u ≥ 1. Zero slope at both ends. */
export function smoothstep(u: number): number {
  return u > 0 ? (u < 1 ? u * u * (3 - 2 * u) : 1) : 0
}

// client/scene/moon.ts
import { Cartesian3, Matrix3, Simon1994PlanetaryPositions, Transforms } from 'cesium'
import type { JulianDate } from 'cesium'
import { smoothstep } from './exaggeration.ts'

const RISE_FROM_DEG = -1 // moonlight fades in from here…
const RISE_FULL_DEG = 10 // …to full: a moon on the horizon lights little (long path through the air)

const scratchM3 = new Matrix3()

/**
 * The Moon's geocentric position in metres, Earth-fixed, computed as Cesium's UniformState does for its Moon (Simon
 * 1994, ICRF → fixed; TEME → pseudo-fixed until Cesium's IAU table is loaded, and always in Node). The Moon that Cesium
 * draws in the sky reads the same clock, so the light and the disc agree.
 */
export function moonPositionWC(jd: JulianDate, result: Cartesian3): Cartesian3 {
  const toFixed = Transforms.computeIcrfToFixedMatrix(jd, scratchM3) ?? Transforms.computeTemeToPseudoFixedMatrix(jd, scratchM3)
  Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(jd, result)
  return Matrix3.multiplyByVector(toFixed, result, result)
}

/** Lit share of the Moon's disc seen from Earth: 0 new, 1 full. moonWC geocentric, sunWC any vector toward the Sun. */
export function moonLitFraction(moonWC: Cartesian3, sunWC: Cartesian3): number {
  return (1 - Math.cos(Cartesian3.angleBetween(moonWC, sunWC))) / 2
}

/** How much the Moon lights the night (0–1): its lit fraction, faded in as it rises from −1° to +10°. */
export function moonWeight(elevDeg: number, lit: number): number {
  return lit * smoothstep((elevDeg - RISE_FROM_DEG) / (RISE_FULL_DEG - RISE_FROM_DEG))
}

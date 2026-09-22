import { meanSeaLevel } from 'egm96-universal'

/** EGM96 geoid undulation N in metres. Ellipsoidal height h = orthometric (MSL) height H + N. */
export function geoidN(latDeg: number, lonDeg: number): number {
  return meanSeaLevel(latDeg, lonDeg)
}

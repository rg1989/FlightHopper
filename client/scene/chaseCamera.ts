// client/scene/chaseCamera.ts
const RAD = Math.PI / 180

/**
 * Camera position relative to the target, in the target's local east-north-up frame (metres).
 * Same convention as Cesium's lookAt(HeadingPitchRange): the camera looks along headingDeg, so it sits behind
 * the nose direction; pitchDeg is the camera's look angle, negative = looking down, so it sits above.
 */
export function chaseOffsetEnu(headingDeg: number, pitchDeg: number, rangeM: number): [number, number, number] {
  const h = headingDeg * RAD
  const p = pitchDeg * RAD
  const horizontal = rangeM * Math.cos(p)
  return [-horizontal * Math.sin(h), -horizontal * Math.cos(h), -rangeM * Math.sin(p)]
}

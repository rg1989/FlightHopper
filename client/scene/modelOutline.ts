// client/scene/modelOutline.ts
// The chased aircraft's outline on screen, for what must keep off the aircraft itself and not off the whole square its
// brackets mark (the place names, placeLabels.ts): the manifest's `outline` (spheres over the mesh, measured by
// tools/models/outline.ts) projected into discs.
import { Cartesian2, Cartesian3, Math as CesiumMath, Matrix4, SceneTransforms } from 'cesium'
import type { PerspectiveFrustum, Scene } from 'cesium'
import type { ModelManifestEntry } from '../types.ts'
import { BOX_CENTRE, BOX_HALF } from './traffic.ts'

/** n discs on screen: x, y, r for each in d (CSS px from the canvas's top-left). */
export interface Discs { n: number; d: Float64Array }
export const NO_DISCS: Discs = { n: 0, d: new Float64Array(0) }

const scratchP = new Cartesian3()
const scratchV = new Cartesian3()
const scratchW = new Cartesian2()

/**
 * entry's outline as drawn through modelMatrix (which carries the scale it is drawn at: the manifest's, and a far
 * model's enlargement, modelMatrixFor), written into out. A sphere behind the camera is left out. A model with no
 * outline measured gets the sphere of its bracket box.
 */
export function outlineDiscs(
  scene: Scene, modelMatrix: Matrix4, entry: ModelManifestEntry, out: Discs,
  project: (scene: Scene, p: Cartesian3, out: Cartesian2) => Cartesian2 | undefined = SceneTransforms.worldToWindowCoordinates,
): Discs {
  const cam = scene.camera
  const fovy = (cam.frustum as PerspectiveFrustum).fovy ?? CesiumMath.PI_OVER_THREE // undefined before the first render
  const pxPerM = scene.canvas.clientHeight / (2 * Math.tan(fovy / 2)) // at 1 m along the view
  const scale = Matrix4.getMaximumScale(modelMatrix)
  const box = entry.box
  const spheres = entry.outline ?? [box ? [...box.centre, box.half] : [BOX_CENTRE.x, BOX_CENTRE.y, BOX_CENTRE.z, BOX_HALF]]
  if (out.d.length < spheres.length * 3) out.d = new Float64Array(spheres.length * 3)
  let n = 0
  for (const s of spheres) {
    const p = Matrix4.multiplyByPoint(modelMatrix, Cartesian3.fromElements(s[0], s[1], s[2], scratchP), scratchP)
    const depthM = Cartesian3.dot(Cartesian3.subtract(p, cam.positionWC, scratchV), cam.directionWC)
    if (!(depthM > 1)) continue
    const w = project(scene, p, scratchW)
    if (w === undefined) continue
    out.d[n * 3] = w.x
    out.d[n * 3 + 1] = w.y
    out.d[n * 3 + 2] = (s[3] * scale * pxPerM) / depthM
    n++
  }
  out.n = n
  return out
}

/** Whether the box (px) comes within gap px of one of the discs. */
export function overDiscs(x0: number, y0: number, x1: number, y1: number, discs: Discs, gap = 0): boolean {
  const d = discs.d
  for (let i = 0; i < discs.n * 3; i += 3) {
    const dx = Math.max(x0 - d[i], 0, d[i] - x1)
    const dy = Math.max(y0 - d[i + 1], 0, d[i + 1] - y1)
    const r = d[i + 2] + gap
    if (dx * dx + dy * dy < r * r) return true
  }
  return false
}

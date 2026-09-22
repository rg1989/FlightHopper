// client/scene/model.ts
// WP-V3 model calibration: place the chase model so that its nose points along RenderState.headingDeg.
// The aircraft must never fly sideways. model.test.ts proves it from the GLB's own geometry.
import { Axis, Cartesian3, Matrix4, Quaternion } from 'cesium'

// ---------- glTF geometry in Cesium's model frame ----------

// Model applies this rotation to every glTF 2.0 asset before modelMatrix
// (ModelUtility.getAxisCorrectionMatrix(Axis.Y, Axis.Z) = Axis.Y_UP_TO_Z_UP · Axis.Z_UP_TO_X_UP):
// glTF +Z (the front, per the glTF spec) → +X, glTF +Y (up) → +Z, glTF +X → +Y.
// The Axis matrices exist at runtime but Cesium.d.ts does not declare them, hence the cast.
const axis = Axis as unknown as { Y_UP_TO_Z_UP: Matrix4; Z_UP_TO_X_UP: Matrix4 }
export const GLTF_TO_CESIUM: Matrix4 = Matrix4.multiplyTransformation(axis.Y_UP_TO_Z_UP, axis.Z_UP_TO_X_UP, new Matrix4())

/** A GLB measured in Cesium's model frame (after GLTF_TO_CESIUM, before scale). Axes are unit vectors. */
export interface GlbAxes {
  nose: Cartesian3
  up: Cartesian3
  right: Cartesian3 // nose × up
  lengthM: number // extent along nose
  spanM: number // extent along right
  belowOriginM: number // origin → lowest vertex (wheel bottom)
}

/**
 * Finds the nose from the geometry alone. Up is glTF +Y (the glTF spec). The vertical fin (every vertex in the top
 * quarter of the height) sits at the tail, so the nose is the horizontal direction from the fin's centroid to the
 * bounding-box centre.
 * ponytail: reads dense float VEC3 POSITION from the GLB's BIN chunk only, and refuses any extensionsRequired
 * (Draco, meshopt). Upgrade: decode through Cesium's GltfLoader if a compressed model is ever added.
 */
export function measureGlb(glb: Uint8Array): GlbAxes {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  if (glb.byteLength < 28 || dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(4, true) !== 2) {
    throw new Error('not a glTF 2.0 GLB')
  }
  const jsonLen = dv.getUint32(12, true)
  const gltf = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)))
  if (gltf.extensionsRequired?.length) throw new Error(`unsupported glTF extensions: ${gltf.extensionsRequired.join(', ')}`)
  const binStart = 20 + jsonLen + 8

  const pts: Cartesian3[] = []
  const visit = (i: number, parent: Matrix4): void => {
    const n = gltf.nodes[i]
    const local = n.matrix
      ? Matrix4.fromArray(n.matrix)
      : Matrix4.fromTranslationQuaternionRotationScale(
          Cartesian3.fromArray(n.translation ?? [0, 0, 0]),
          Quaternion.unpack(n.rotation ?? [0, 0, 0, 1]),
          Cartesian3.fromArray(n.scale ?? [1, 1, 1]),
        )
    const world = Matrix4.multiply(parent, local, new Matrix4())
    for (const prim of n.mesh === undefined ? [] : gltf.meshes[n.mesh].primitives) {
      const a = gltf.accessors[prim.attributes.POSITION]
      if (a.componentType !== 5126 || a.type !== 'VEC3' || a.sparse) throw new Error('POSITION must be dense float VEC3')
      const bv = gltf.bufferViews[a.bufferView]
      const stride = bv.byteStride ?? 12
      const base = binStart + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0)
      for (let k = 0; k < a.count; k++) {
        const o = base + k * stride
        const p = new Cartesian3(dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true))
        pts.push(Matrix4.multiplyByPoint(world, p, p))
      }
    }
    for (const c of n.children ?? []) visit(c, world)
  }
  for (const i of gltf.scenes[gltf.scene ?? 0].nodes) visit(i, GLTF_TO_CESIUM)

  let [xMin, xMax, yMin, yMax, zMin, zMax] = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity]
  for (const p of pts) {
    xMin = Math.min(xMin, p.x); xMax = Math.max(xMax, p.x)
    yMin = Math.min(yMin, p.y); yMax = Math.max(yMax, p.y)
    zMin = Math.min(zMin, p.z); zMax = Math.max(zMax, p.z)
  }
  const finZ = zMax - 0.25 * (zMax - zMin)
  let [fx, fy, nf] = [0, 0, 0]
  for (const p of pts) if (p.z >= finZ) { fx += p.x; fy += p.y; nf++ }
  const tailToCentre = new Cartesian3((xMin + xMax) / 2 - fx / nf, (yMin + yMax) / 2 - fy / nf, 0)
  const nose = Cartesian3.normalize(tailToCentre, new Cartesian3())
  const up = Cartesian3.clone(Cartesian3.UNIT_Z)
  const right = Cartesian3.cross(nose, up, new Cartesian3())
  const extent = (v: Cartesian3): number => {
    let [lo, hi] = [Infinity, -Infinity]
    for (const p of pts) { const d = Cartesian3.dot(p, v); lo = Math.min(lo, d); hi = Math.max(hi, d) }
    return hi - lo
  }
  return { nose, up, right, lengthM: extent(nose), spanM: extent(right), belowOriginM: -zMin }
}

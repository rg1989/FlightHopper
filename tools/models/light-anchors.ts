// tools/models/light-anchors.ts
// Measures where each manifest model's exterior lights sit (client/scene/aircraftLights.ts) from its GLB, and prints
// or writes the manifest's `lights` entries. Measured in the body frame (nose +X, left +Y, up +Z; unscaled mesh units),
// written in the model frame the manifest keeps (Cesium's, before forwardAxisFix, like `box`), rounded to 1 cm.
//
//   node tools/models/light-anchors.ts            print one `"lights": {…}` line per model
//   node tools/models/light-anchors.ts --write    replace (or add after "box"/"scale") each model's line in the manifest
//
// Where, from the mesh (triangles, ray casts and a plane slice, so a sparse vertex layout does not matter):
// - navLeft / navRight (red / green, and the wing-tip strobes): the outermost 0.6 m of span, at the wing's own level
//   there (below a winglet), its forward-most point, 5 cm outboard. The helicopter's are its tailplane tips.
// - tail (white, and the tail strobe): the aftmost point on the centre line below the fin (the tail cone).
// - beacons (red anti-collision): over and under the middle of the wing root chord (a slice just outboard of the
//   fuselage), 8 cm off the skin; the belly is the highest of five hits from below across the keel (the landing gear
//   is modelled down, and narrower). Light aircraft and the ATR carry the upper one on the fin tip.
// - landing: the wing root leading edges (the same slice) and the nose gear (13 % of the length aft of the nose).
// It also measures each airliner's cabin window row for the paint map (`windows`, the paint's turned frame; see
// windowsFor), from 13 % of the length behind the nose to the fin's root.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Cartesian3, Matrix3, Matrix4, Quaternion } from 'cesium'
import { GLTF_TO_CESIUM, fixMatrix } from '../../client/scene/model.ts'
import type { LightAnchors, ModelManifest, ModelManifestEntry } from '../../client/types.ts'

export const MANIFEST = fileURLToPath(new URL('../../public/models/manifest.json', import.meta.url))
const PUBLIC = new URL('../../public/', import.meta.url)

type V3 = [number, number, number]

/** A GLB's triangles in the body frame: p = xyz per vertex, tri = three vertex indices per triangle. */
export interface Mesh { p: Float64Array; tri: Uint32Array }

/** Reads e's GLB (dense float POSITION, optional indices, node transforms) into the body frame: fixMatrix · Cesium frame. */
export function loadBody(e: ModelManifestEntry): Mesh {
  const glb = readFileSync(new URL(e.uri, PUBLIC))
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  const jsonLen = dv.getUint32(12, true)
  const gltf = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)))
  const binStart = 20 + jsonLen + 8
  const fix = fixMatrix(e)
  const pts: number[] = []
  const tris: number[] = []
  const c = new Cartesian3()
  const visit = (i: number, parent: Matrix4): void => {
    const n = gltf.nodes[i]
    const local = n.matrix
      ? Matrix4.fromArray(n.matrix)
      : Matrix4.fromTranslationQuaternionRotationScale(
          Cartesian3.fromArray(n.translation ?? [0, 0, 0]), Quaternion.unpack(n.rotation ?? [0, 0, 0, 1]), Cartesian3.fromArray(n.scale ?? [1, 1, 1]))
    const world = Matrix4.multiply(parent, local, new Matrix4())
    for (const prim of n.mesh === undefined ? [] : gltf.meshes[n.mesh].primitives) {
      const a = gltf.accessors[prim.attributes.POSITION]
      if (a.componentType !== 5126 || a.type !== 'VEC3' || a.sparse) throw new Error(`${e.id}: POSITION must be dense float VEC3`)
      const bv = gltf.bufferViews[a.bufferView]
      const stride = bv.byteStride ?? 12
      const base = binStart + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0)
      const first = pts.length / 3
      for (let k = 0; k < a.count; k++) {
        const o = base + k * stride
        Cartesian3.fromElements(dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true), c)
        Matrix3.multiplyByVector(fix, Matrix4.multiplyByPoint(world, c, c), c)
        pts.push(c.x, c.y, c.z)
      }
      if (prim.indices === undefined) {
        for (let k = 0; k < a.count; k++) tris.push(first + k)
        continue
      }
      const ia = gltf.accessors[prim.indices]
      const ibv = gltf.bufferViews[ia.bufferView]
      const ib = binStart + (ibv.byteOffset ?? 0) + (ia.byteOffset ?? 0)
      const wide = ia.componentType === 5125
      for (let k = 0; k < ia.count; k++) tris.push(first + (wide ? dv.getUint32(ib + 4 * k, true) : ia.componentType === 5123 ? dv.getUint16(ib + 2 * k, true) : dv.getUint8(ib + k)))
    }
    for (const ch of n.children ?? []) visit(ch, world)
  }
  for (const i of gltf.scenes[gltf.scene ?? 0].nodes) visit(i, GLTF_TO_CESIUM)
  return { p: Float64Array.from(pts), tri: Uint32Array.from(tris) }
}

/** Distance along the ray o + t·d (t > 0) to the nearest triangle, or null (Möller–Trumbore). */
export function ray(m: Mesh, o: V3, d: V3): number | null {
  let best: number | null = null
  const { p, tri } = m
  for (let i = 0; i < tri.length; i += 3) {
    const a = tri[i] * 3, b = tri[i + 1] * 3, c = tri[i + 2] * 3
    const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2]
    const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2]
    const hx = d[1] * e2z - d[2] * e2y, hy = d[2] * e2x - d[0] * e2z, hz = d[0] * e2y - d[1] * e2x
    const det = e1x * hx + e1y * hy + e1z * hz
    if (Math.abs(det) < 1e-12) continue
    const f = 1 / det
    const sx = o[0] - p[a], sy = o[1] - p[a + 1], sz = o[2] - p[a + 2]
    const u = f * (sx * hx + sy * hy + sz * hz)
    if (u < 0 || u > 1) continue
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x
    const v = f * (d[0] * qx + d[1] * qy + d[2] * qz)
    if (v < 0 || u + v > 1) continue
    const t = f * (e2x * qx + e2y * qy + e2z * qz)
    if (t > 1e-6 && (best === null || t < best)) best = t
  }
  return best
}

/** Where the triangle edges cross the plane y = c, as [x, z]. */
export function sliceY(m: Mesh, c: number): [number, number][] {
  const out: [number, number][] = []
  const { p, tri } = m
  for (let i = 0; i < tri.length; i += 3) {
    for (const [u, v] of [[tri[i], tri[i + 1]], [tri[i + 1], tri[i + 2]], [tri[i + 2], tri[i]]]) {
      const yu = p[3 * u + 1] - c, yv = p[3 * v + 1] - c
      if (yu < 0 === yv < 0) continue
      const t = yu / (yu - yv)
      out.push([p[3 * u] + t * (p[3 * v] - p[3 * u]), p[3 * u + 2] + t * (p[3 * v + 2] - p[3 * u + 2])])
    }
  }
  return out
}

const FIN_BEACON = new Set(['c182', 'c550', 'ec135', 'at75']) // the upper beacon on the fin tip
const NO_BELLY_BEACON = new Set(['c182', 'ec135'])
const ROOT_OFFSET_M: Record<string, number> = { 'cesium-air': 0.35 } // its engines sit 1.2 m outboard of the fuselage

/** The anchors in the body frame (see the header). */
export function anchorsBody(e: ModelManifestEntry, m: Mesh): LightAnchors {
  const P = e.paint
  if (P === undefined) throw new Error(`${e.id}: no paint map (its fuselage width and fin are needed)`)
  const n = m.p.length / 3
  const all: V3[] = Array.from({ length: n }, (_, i) => [m.p[3 * i], m.p[3 * i + 1], m.p[3 * i + 2]])
  const xs = all.map((q) => q[0])
  const [xMin, xMax] = [Math.min(...xs), Math.max(...xs)]
  const tip = (sign: 1 | -1): V3 => {
    const pts = e.id === 'ec135' ? all.filter((q) => q[0] < 0.4 * xMin) : all // the tailplane, not the rotor
    const ext = Math.max(...pts.map((q) => sign * q[1]))
    const region = pts.filter((q) => sign * q[1] > ext - 0.6)
    const zLow = Math.min(...region.map((q) => q[2]))
    const low = region.filter((q) => q[2] < zLow + 0.35)
    const yTip = Math.max(...low.map((q) => sign * q[1]))
    const edge = low.filter((q) => sign * q[1] > yTip - 0.3)
    return [Math.max(...edge.map((q) => q[0])) - 0.15, sign * (yTip + 0.05), edge.reduce((s, q) => s + q[2], 0) / edge.length]
  }
  const cone = all.filter((q) => Math.abs(q[1]) < 0.35 && q[2] < P.fin.aboveY).reduce((a, b) => (b[0] < a[0] ? b : a))
  const yRoot = P.bodyHalfWidth + (ROOT_OFFSET_M[e.id] ?? 0.8)
  const chord = sliceY(m, yRoot).filter((q) => q[0] > xMin + 0.3 * (xMax - xMin)) // the wing, not the tailplane
  const le = chord.reduce((a, b) => (b[0] > a[0] ? b : a))
  const xRoot = e.id === 'ec135' ? 0 : (le[0] + Math.min(...chord.map((q) => q[0]))) / 2
  const top = (x: number): number => 60 - ray(m, [x, 0.1, 60], [0, 0, -1])!
  const belly = (x: number): number =>
    Math.max(...[-0.6, -0.3, 0.1, 0.3, 0.6].flatMap((y) => { const t = ray(m, [x, y, -60], [0, 0, 1]); return t === null ? [] : [t - 60] }))
  const fin = all.filter((q) => q[0] < P.fin.behindZ).reduce((a, b) => (b[2] > a[2] ? b : a))
  const beacons: V3[] = [FIN_BEACON.has(e.id) ? [fin[0], 0, fin[2] + 0.08] : [xRoot, 0, top(xRoot) + 0.08]]
  if (!NO_BELLY_BEACON.has(e.id)) beacons.push([xRoot, 0, belly(xRoot) - 0.08])
  const xNose = xMax - 0.13 * (xMax - xMin)
  const landing: V3[] = e.id === 'ec135'
    ? [[3.2, 0, belly(3.2) - 0.05]] // under the nose
    : [[le[0] + 0.1, yRoot, le[1]], [le[0] + 0.1, -yRoot, le[1]], [xNose, 0, belly(xNose) - 0.1]]
  return { navLeft: tip(1), navRight: tip(-1), tail: [cone[0] - 0.1, 0, cone[2]], beacons, landing }
}

const NO_WINDOWS = new Set(['cesium-air', 'c182', 'ec135']) // its own texture; glazed cabins, not a window row
const PITCH_M: Record<string, number> = { c550: 0.9, at75: 0.76 } // else an airliner's 0.51 m

/**
 * The paint map's window row, [y, zAft, zFore, pitch] in the turned frame (y up, z nose), or null for none. Most meshes
 * model their windows: a dense band of skin vertices a little above the fuselage's centre line, whose middle is the
 * row. Without one (the decimated wide-bodies), a fifth of the radius above the centre line (what the modelled rows of
 * the 777 and A350 show).
 */
export function windowsFor(e: ModelManifestEntry, m: Mesh): [number, number, number, number] | null {
  if (NO_WINDOWS.has(e.id) || e.paint === undefined) return null
  const n = m.p.length / 3
  let [xMin, xMax] = [Infinity, -Infinity]
  for (let i = 0; i < n; i++) { xMin = Math.min(xMin, m.p[3 * i]); xMax = Math.max(xMax, m.p[3 * i]) }
  const [aft, fore] = [e.paint.fin.behindZ - 0.5, xMax - 0.13 * (xMax - xMin)]
  const mids: number[] = []
  const radii: number[] = []
  for (let k = 0; k <= 12; k++) { // the aft 60 % of the cabin: behind a 747's upper deck
    const x = aft + (0.6 * (fore - aft) * k) / 12
    const top = ray(m, [x, 0.1, 60], [0, 0, -1])
    const bottom = ray(m, [x, 0.1, -60], [0, 0, 1])
    if (top === null || bottom === null) continue
    mids.push((bottom - top) / 2) // ((60 − top) + (bottom − 60)) / 2
    radii.push((120 - top - bottom) / 2)
  }
  const median = (v: number[]): number => v.toSorted((a, b) => a - b)[Math.floor(v.length / 2)]
  const [yc, r] = [median(mids), median(radii)]
  const bins = new Map<number, number>()
  let side = 0
  const hw = e.paint.bodyHalfWidth
  for (let i = 0; i < n; i++) {
    const [x, y, z] = [m.p[3 * i], m.p[3 * i + 1], m.p[3 * i + 2]]
    if (x < aft || x > fore || Math.abs(y) < 0.55 * hw || Math.abs(y) > 1.05 * hw) continue
    side++
    if (z < yc || z > yc + 0.7 * r) continue
    const b = Math.round(z * 10)
    bins.set(b, (bins.get(b) ?? 0) + 1)
  }
  let [best, at] = [0, 0]
  for (const b of bins.keys()) {
    let c = 0
    for (let j = b; j < b + 5; j++) c += bins.get(j) ?? 0
    if (c > best) [best, at] = [c, b]
  }
  const y = best >= Math.max(60, 0.3 * side) ? (at + 2) / 10 : yc + 0.2 * r
  return [cm(y), cm(aft), cm(fore), PITCH_M[e.id] ?? 0.51]
}

const cm = (x: number): number => Math.round(x * 100) / 100 + 0 // + 0: no −0 in the JSON

/** A body-frame point in the manifest's model frame (fixMatrix⁻¹ · v), rounded to 1 cm. */
export function toModelFrame(e: ModelManifestEntry, v: V3): V3 {
  const c = Matrix3.multiplyByVector(Matrix3.transpose(fixMatrix(e), new Matrix3()), Cartesian3.fromArray(v), new Cartesian3())
  return [cm(c.x), cm(c.y), cm(c.z)]
}

/** e's `lights` entry, measured from its GLB. */
export function lightsFor(e: ModelManifestEntry): LightAnchors {
  const b = anchorsBody(e, loadBody(e))
  const f = (v: V3): V3 => toModelFrame(e, v)
  return { navLeft: f(b.navLeft), navRight: f(b.navRight), tail: f(b.tail), beacons: b.beacons.map(f), landing: b.landing.map(f) }
}

/** The manifest line: `"lights": { … }`, the manifest's one-line-per-field style. */
export function lightsLine(l: LightAnchors): string {
  const v = (a: V3): string => `[${a.join(', ')}]`
  return `"lights": { "navLeft": ${v(l.navLeft)}, "navRight": ${v(l.navRight)}, "tail": ${v(l.tail)}, "beacons": [${l.beacons.map(v).join(', ')}], "landing": [${l.landing.map(v).join(', ')}] }`
}

if (import.meta.main) {
  const text = readFileSync(MANIFEST, 'utf8')
  const manifest: ModelManifest = JSON.parse(text)
  const lines = text.split('\n')
  for (const e of manifest.models) {
    const line = lightsLine(lightsFor(e))
    const win = windowsFor(e, loadBody(e))
    if (!process.argv.includes('--write')) {
      console.log(`${e.id}: ${line}${win === null ? '' : `\n  "windows": [${win.join(', ')}]`}`)
      continue
    }
    const at = lines.findIndex((l) => l.includes(`"id": "${e.id}"`))
    const end = lines.findIndex((l, i) => i > at && /^ {4}\}/.test(l))
    const old = lines.findIndex((l, i) => i > at && i < end && l.trim().startsWith('"lights"'))
    if (old >= 0) lines[old] = lines[old].replace(/"lights".*?(,?)$/, `${line}$1`)
    else {
      const after = lines.findLastIndex((l, i) => i > at && i < end && /^ {6}"(box|scale|gearHeightM)"/.test(l))
      lines.splice(after + 1, 0, `      ${line},`)
    }
    if (win !== null) { // after the paint map's title, on its line
      const t = lines.findIndex((l, i) => i > at && l.includes('"title": ['))
      lines[t] = lines[t].replace(/("title": \[[^\]]*\])(, "windows": \[[^\]]*\])?/, `$1, "windows": [${win.join(', ')}]`)
    }
  }
  if (process.argv.includes('--write')) {
    writeFileSync(MANIFEST, lines.join('\n'))
    JSON.parse(readFileSync(MANIFEST, 'utf8')) // still JSON
    console.log(`wrote ${MANIFEST}`)
  }
}

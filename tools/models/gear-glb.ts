// tools/models/gear-glb.ts
// Writes public/models/b744-gear.glb: the Boeing 747's landing gear, down, as boxes and eight-sided wheels in the raw
// frame of public/models/b744.glb (glTF: +X right wing, +Y up, −Z nose; metres). b744.glb has no gear; ChaseModel.setGear
// draws this one with the aircraft's matrix. No dependencies: a glTF 2.0 GLB with POSITION and NORMAL, no indices.
//
//   node tools/models/gear-glb.ts [out.glb]
//
// Layout from public 747 dimensions (scenarios model report §4), approximate: nose gear at z −28 (7.5 m behind the
// nose); main wheels within z −2.5…+3.3, the wing gear (x ±5.5) 3.0 m ahead of the body gear (x ±1.9); 4-wheel bogies
// (1.47 m axle spacing, 1.12 m track, 49 in tyres), 2 nose wheels (46 in). Wheel bottoms 3.0 m below the belly (y −8.6).
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const GEAR_GLB = fileURLToPath(new URL('../../public/models/b744-gear.glb', import.meta.url))
export const WHEEL_BOTTOM_Y = -11.6

type V = [number, number, number]

/** One primitive: a triangle soup (three vertices per triangle) and its material. */
export interface Part {
  name: string
  color: V // linear RGB
  metallic: number
  roughness: number
  pos: number[]
  nrm: number[]
}

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Adds a triangle, wound counter-clockwise as seen from the side its normals point to (glTF front faces). */
function tri(p: Part, a: V, b: V, c: V, na: V, nb: V = na, nc: V = na): void {
  const g = cross(sub(b, a), sub(c, a))
  const [v, n] = dot(g, [na[0] + nb[0] + nc[0], na[1] + nb[1] + nc[1], na[2] + nb[2] + nc[2]]) >= 0 ? [[a, b, c], [na, nb, nc]] : [[a, c, b], [na, nc, nb]]
  for (const k of [0, 1, 2]) {
    p.pos.push(...v[k])
    p.nrm.push(...n[k])
  }
}

/** A box around (cx, cy, cz) with half sizes h; openAxis: without its two faces across that axis (a tube whose ends are hidden). */
function box(p: Part, [cx, cy, cz]: V, [hx, hy, hz]: V, openAxis?: 0 | 1 | 2): void {
  for (const axis of [0, 1, 2]) {
    if (axis === openAxis) continue
    for (const s of [-1, 1]) {
      const n: V = [0, 0, 0]
      n[axis] = s
      const [u, w] = [(axis + 1) % 3, (axis + 2) % 3]
      const h: V = [hx, hy, hz]
      const corner = (du: number, dw: number): V => {
        const q: V = [cx, cy, cz]
        q[axis] += s * h[axis]
        q[u] += du * h[u]
        q[w] += dw * h[w]
        return q
      }
      tri(p, corner(-1, -1), corner(1, -1), corner(1, 1), n)
      tri(p, corner(-1, -1), corner(1, 1), corner(-1, 1), n)
    }
  }
}

/** A wheel on an axle along x: an eight-sided prism with a vertex at the bottom, smooth tread, flat sides. */
function wheel(p: Part, [cx, cy, cz]: V, r: number, halfW: number): void {
  const N = 8
  const at = (k: number): { y: number; z: number; n: V } => {
    const t = -Math.PI / 2 + (2 * Math.PI * k) / N
    return { y: cy + r * Math.sin(t), z: cz + r * Math.cos(t), n: [0, Math.sin(t), Math.cos(t)] }
  }
  for (let k = 0; k < N; k++) {
    const [a, b] = [at(k), at(k + 1)]
    const [a0, a1, b0, b1]: V[] = [[cx - halfW, a.y, a.z], [cx + halfW, a.y, a.z], [cx - halfW, b.y, b.z], [cx + halfW, b.y, b.z]]
    tri(p, a0, a1, b1, a.n, a.n, b.n)
    tri(p, a0, b1, b0, a.n, b.n, b.n)
    if (k === 0 || k === N - 1) continue
    for (const s of [-1, 1]) tri(p, [cx + s * halfW, at(0).y, at(0).z], [cx + s * halfW, a.y, a.z], [cx + s * halfW, b.y, b.z], [s, 0, 0])
  }
}

/** The gear: struts (grey metal) and tyres (dark rubber), ≤ 600 triangles. */
export function b744Gear(): Part[] {
  const strut: Part = { name: 'strut', color: [0.55, 0.57, 0.6], metallic: 0.6, roughness: 0.45, pos: [], nrm: [] }
  const tyre: Part = { name: 'tyre', color: [0.05, 0.05, 0.055], metallic: 0, roughness: 0.9, pos: [], nrm: [] }
  // A strut is open at both ends: its top inside the skin, its bottom inside the bogie beam or the nose axle.
  const tube = (x: number, z: number, top: number, bottom: number, half: number): void =>
    box(strut, [x, (top + bottom) / 2, z], [half, (top - bottom) / 2, half], 1)

  // Mains: [x, bogie centre z, strut top inside the skin (belly −8.47 at x 1.9, wing −7.35 at x 5.5)]
  // ponytail: no main axles (8 axles × 8 triangles would pass the 600 budget), so each wheel's inner face stands 0.2 m
  // off the beam, seen only from close below. Upgrade: an open axle box per wheel pair if the budget grows.
  const R = 0.62 // 49 × 17 in tyres
  const axleY = WHEEL_BOTTOM_Y + R
  for (const [x, z, top] of [[-5.5, -1.1, -7.1], [5.5, -1.1, -7.1], [-1.9, 1.9, -8.2], [1.9, 1.9, -8.2]]) {
    tube(x, z, top, axleY, 0.14)
    box(strut, [x, axleY, z], [0.15, 0.15, 0.98]) // bogie beam, wider than the strut so it closes the strut's end
    for (const dz of [-0.735, 0.735]) for (const dx of [-0.56, 0.56]) wheel(tyre, [x + dx, axleY, z + dz], R, 0.215)
  }
  // Nose: two 46 × 16 in wheels either side of the strut (the belly is at −8.14 there), on one axle whose open ends
  // stop inside the wheels.
  const Rn = 0.59
  tube(0, -28, -7.9, WHEEL_BOTTOM_Y + Rn, 0.12)
  box(strut, [0, WHEEL_BOTTOM_Y + Rn, -28], [0.45, 0.13, 0.13], 0)
  for (const dx of [-0.45, 0.45]) wheel(tyre, [dx, WHEEL_BOTTOM_Y + Rn, -28], Rn, 0.205)
  return [strut, tyre]
}

const pad = (b: Uint8Array, fill: number): Uint8Array => {
  const out = new Uint8Array(Math.ceil(b.length / 4) * 4).fill(fill)
  out.set(b)
  return out
}

/** A glTF 2.0 binary: one node, one mesh, one primitive per part (POSITION with min/max, NORMAL). */
export function glb(parts: Part[]): Uint8Array {
  const arrays: Float32Array[] = []
  const bufferViews: object[] = []
  const accessors: object[] = []
  let offset = 0
  const add = (data: number[], bounds: boolean): number => {
    const a = new Float32Array(data)
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: a.byteLength, target: 34962 })
    const acc: Record<string, unknown> = { bufferView: bufferViews.length - 1, componentType: 5126, count: a.length / 3, type: 'VEC3' }
    if (bounds) {
      acc.min = [0, 1, 2].map((c) => Math.min(...a.filter((_, i) => i % 3 === c)))
      acc.max = [0, 1, 2].map((c) => Math.max(...a.filter((_, i) => i % 3 === c)))
    }
    accessors.push(acc)
    arrays.push(a)
    offset += a.byteLength
    return accessors.length - 1
  }
  const primitives = parts.map((p, i) => ({ attributes: { POSITION: add(p.pos, true), NORMAL: add(p.nrm, false) }, material: i }))
  const gltf = {
    asset: { version: '2.0', generator: 'FlightHopper tools/models/gear-glb.ts' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'gear', mesh: 0 }],
    meshes: [{ name: 'gear', primitives }],
    materials: parts.map((p) => ({ name: p.name, pbrMetallicRoughness: { baseColorFactor: [...p.color, 1], metallicFactor: p.metallic, roughnessFactor: p.roughness } })),
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  }
  const json = pad(new TextEncoder().encode(JSON.stringify(gltf)), 0x20)
  const bin = new Uint8Array(offset)
  let o = 0
  for (const a of arrays) {
    bin.set(new Uint8Array(a.buffer), o)
    o += a.byteLength
  }
  const out = new Uint8Array(12 + 8 + json.length + 8 + bin.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true) // 'glTF'
  dv.setUint32(4, 2, true)
  dv.setUint32(8, out.length, true)
  dv.setUint32(12, json.length, true)
  dv.setUint32(16, 0x4e4f534a, true) // 'JSON'
  out.set(json, 20)
  dv.setUint32(20 + json.length, bin.length, true)
  dv.setUint32(24 + json.length, 0x004e4942, true) // 'BIN'
  out.set(bin, 28 + json.length)
  return out
}

if (import.meta.main) {
  const out = process.argv[2] ?? GEAR_GLB
  const parts = b744Gear()
  const bytes = glb(parts)
  writeFileSync(out, bytes)
  console.log(`wrote ${out}: ${parts.reduce((n, p) => n + p.pos.length / 9, 0)} triangles, ${bytes.length} bytes`)
}

// tools/models/glb.ts
// A minimal glTF 2.0 binary reader and writer for the type models: one mesh with one indexed triangle primitive
// (POSITION, NORMAL, COLOR_0 as normalised unsigned bytes). Everything else in the JSON (nodes and their transforms,
// the scene, the material, asset.copyright) is kept as read; the writer rebuilds the accessors (POSITION min/max),
// buffer views and the one buffer. tools/models/variants.ts edits models through it.
// ponytail: refuses anything else (several primitives, strides, sparse or compressed data): the type models are all
// livetaiwan's single-primitive layout. Upgrade: read through Cesium's GltfLoader if a model ever differs.

/** A single-primitive GLB: the JSON (kept) and the primitive's vertex data, in the mesh's own (glTF) frame. */
export interface Glb {
  json: any
  pos: Float32Array // xyz per vertex
  nrm: Float32Array // xyz per vertex
  col: Uint8Array // RGBA per vertex
  idx: Uint32Array // three vertex indices per triangle
}

const MAGIC = 0x46546c67 // 'glTF'
const JSON_CHUNK = 0x4e4f534a
const BIN_CHUNK = 0x004e4942

export function readGlb(bytes: Uint8Array): Glb {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength < 28 || dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== 2) throw new Error('not a glTF 2.0 GLB')
  const jsonLen = dv.getUint32(12, true)
  if (dv.getUint32(16, true) !== JSON_CHUNK) throw new Error('GLB: the first chunk is not JSON')
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)))
  const bin = 20 + jsonLen + 8
  if (json.meshes?.length !== 1 || json.meshes[0].primitives.length !== 1) throw new Error('GLB: one mesh with one primitive expected')
  const prim = json.meshes[0].primitives[0]
  if ((prim.mode ?? 4) !== 4 || prim.indices === undefined) throw new Error('GLB: indexed triangles expected')
  const read = (i: number, type: string, ct: number): { o: number; count: number } => {
    const a = json.accessors[i]
    const bv = json.bufferViews[a.bufferView]
    if (a.type !== type || a.componentType !== ct || a.sparse || (bv.byteStride !== undefined && bv.byteStride !== { 5126: 12, 5121: 4 }[ct as 5126 | 5121])) {
      throw new Error(`GLB: accessor ${i} must be dense ${type} of component type ${ct}`)
    }
    return { o: bin + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0), count: a.count }
  }
  const floats = (i: number): Float32Array => {
    const { o, count } = read(i, 'VEC3', 5126)
    return Float32Array.from({ length: 3 * count }, (_, k) => dv.getFloat32(o + 4 * k, true))
  }
  const at = prim.attributes
  const pos = floats(at.POSITION)
  const nrm = floats(at.NORMAL)
  const c = read(at.COLOR_0, 'VEC4', 5121)
  const col = bytes.slice(c.o, c.o + 4 * c.count)
  const ia = json.accessors[prim.indices]
  const ibv = json.bufferViews[ia.bufferView]
  const io = bin + (ibv.byteOffset ?? 0) + (ia.byteOffset ?? 0)
  const size = { 5121: 1, 5123: 2, 5125: 4 }[ia.componentType as 5121 | 5123 | 5125]
  if (size === undefined || ia.type !== 'SCALAR') throw new Error('GLB: indices must be unsigned scalars')
  const idx = Uint32Array.from({ length: ia.count }, (_, k) => (size === 4 ? dv.getUint32(io + 4 * k, true) : size === 2 ? dv.getUint16(io + 2 * k, true) : dv.getUint8(io + k)))
  return { json, pos, nrm, col, idx }
}

const pad4 = (n: number): number => Math.ceil(n / 4) * 4

/** The GLB bytes: g.json with the primitive's accessors, views and buffer rebuilt from g's arrays (16-bit indices when they fit). */
export function writeGlb(g: Glb): Uint8Array {
  const n = g.pos.length / 3
  if (g.nrm.length !== 3 * n || g.col.length !== 4 * n || g.idx.length % 3 !== 0) throw new Error('GLB: attribute lengths disagree')
  const wide = n > 65535
  const idx = wide ? new Uint8Array(new Uint32Array(g.idx).buffer) : new Uint8Array(Uint16Array.from(g.idx).buffer)
  const blobs = [new Uint8Array(new Float32Array(g.pos).buffer), new Uint8Array(new Float32Array(g.nrm).buffer), g.col, idx]
  const views: object[] = []
  let offset = 0
  for (const [k, b] of blobs.entries()) {
    views.push({ buffer: 0, byteOffset: offset, byteLength: b.byteLength, target: k === 3 ? 34963 : 34962 })
    offset += pad4(b.byteLength)
  }
  const [min, max] = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]]
  for (let i = 0; i < 3 * n; i++) [min[i % 3], max[i % 3]] = [Math.min(min[i % 3], g.pos[i]), Math.max(max[i % 3], g.pos[i])]
  const f32 = (v: number): number => Math.fround(v)
  const json = structuredClone(g.json)
  json.accessors = [
    { bufferView: 0, componentType: 5126, count: n, type: 'VEC3', min: min.map(f32), max: max.map(f32) },
    { bufferView: 1, componentType: 5126, count: n, type: 'VEC3' },
    { bufferView: 2, componentType: 5121, count: n, type: 'VEC4', normalized: true },
    { bufferView: 3, componentType: wide ? 5125 : 5123, count: g.idx.length, type: 'SCALAR' },
  ]
  json.bufferViews = views
  json.buffers = [{ byteLength: offset }]
  const prim = json.meshes[0].primitives[0]
  prim.attributes = { POSITION: 0, NORMAL: 1, COLOR_0: 2 }
  prim.indices = 3
  const text = new TextEncoder().encode(JSON.stringify(json))
  const jsonLen = pad4(text.length)
  const out = new Uint8Array(28 + jsonLen + offset)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, MAGIC, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, out.length, true)
  dv.setUint32(12, jsonLen, true)
  dv.setUint32(16, JSON_CHUNK, true)
  out.fill(0x20, 20, 20 + jsonLen)
  out.set(text, 20)
  dv.setUint32(20 + jsonLen, offset, true)
  dv.setUint32(24 + jsonLen, BIN_CHUNK, true)
  let o = 28 + jsonLen
  for (const b of blobs) {
    out.set(b, o)
    o += pad4(b.byteLength)
  }
  return out
}

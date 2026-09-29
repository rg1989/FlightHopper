// tools/models/glb.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readGlb, writeGlb } from './glb.ts'

const file = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../public/models/${name}`, import.meta.url)))

test('readGlb → writeGlb → readGlb keeps the mesh, the nodes and the asset notice', () => {
  const a = readGlb(file('a320.glb'))
  assert.equal(a.pos.length, 3 * 9388)
  assert.equal(a.idx.length % 3, 0)
  const b = readGlb(writeGlb(a))
  assert.deepEqual(b.pos, a.pos)
  assert.deepEqual(b.nrm, a.nrm)
  assert.deepEqual(b.col, a.col)
  assert.deepEqual(b.idx, a.idx)
  assert.deepEqual(b.json.nodes, a.json.nodes)
  assert.deepEqual(b.json.asset, a.json.asset)
  assert.deepEqual(b.json.materials, a.json.materials)
})

test('writeGlb: POSITION min/max, normalised colours, 4-byte chunks, 16-bit indices while they fit, else 32-bit', () => {
  const a = readGlb(file('b738.glb'))
  const out = writeGlb(a)
  const dv = new DataView(out.buffer)
  assert.equal(dv.getUint32(8, true), out.length)
  assert.equal(dv.getUint32(12, true) % 4, 0)
  const b = readGlb(out)
  const [p, c, i] = [b.json.accessors[0], b.json.accessors[2], b.json.accessors[3]]
  for (let k = 0; k < 3; k++) {
    let [lo, hi] = [Infinity, -Infinity]
    for (let v = k; v < a.pos.length; v += 3) [lo, hi] = [Math.min(lo, a.pos[v]), Math.max(hi, a.pos[v])]
    assert.equal(p.min[k], lo)
    assert.equal(p.max[k], hi)
  }
  assert.equal(c.normalized, true)
  assert.equal(i.componentType, 5123)
  const n = 70000 // more vertices than 16 bits index
  const big = { json: a.json, pos: new Float32Array(3 * n), nrm: new Float32Array(3 * n).fill(0.5), col: new Uint8Array(4 * n), idx: Uint32Array.from([0, 1, n - 1]) }
  const back = readGlb(writeGlb(big))
  assert.equal(back.json.accessors[3].componentType, 5125)
  assert.deepEqual(back.idx, big.idx)
})

test('readGlb refuses what the writer cannot keep: not a GLB, several meshes', () => {
  assert.throws(() => readGlb(new TextEncoder().encode('{"asset":{}}')), /GLB/)
  assert.throws(() => readGlb(file('Cesium_Air.glb')), /one mesh/)
})

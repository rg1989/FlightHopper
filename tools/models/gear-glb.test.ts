// tools/models/gear-glb.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { measureGlb } from '../../client/scene/model.ts'
import { b744Gear, GEAR_GLB, glb, WHEEL_BOTTOM_Y } from './gear-glb.ts'

const bytes = glb(b744Gear())
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${msg} got ${a}, expected ${b} ± ${tol}`)

/** The JSON chunk and every primitive's POSITION and NORMAL as [x, y, z] triples (raw glTF frame). */
function parse(b: Uint8Array): { gltf: any; prims: { pos: number[][]; nrm: number[][] }[] } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const jsonLen = dv.getUint32(12, true)
  const gltf = JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + jsonLen)))
  const bin = 20 + jsonLen + 8
  const read = (i: number): number[][] => {
    const a = gltf.accessors[i]
    const o = bin + (gltf.bufferViews[a.bufferView].byteOffset ?? 0) + (a.byteOffset ?? 0)
    return Array.from({ length: a.count }, (_, k) => [0, 1, 2].map((c) => dv.getFloat32(o + 12 * k + 4 * c, true)))
  }
  const prims = gltf.meshes[0].primitives.map((p: any) => ({ pos: read(p.attributes.POSITION), nrm: read(p.attributes.NORMAL) }))
  return { gltf, prims }
}

const { gltf, prims } = parse(bytes)
const all = prims.flatMap((p) => p.pos)

test('b744 gear: a glTF 2.0 GLB that measureGlb reads; the wheels touch y = −11.6 (belly −8.6 less 3.0 m)', () => {
  assert.equal(WHEEL_BOTTOM_Y, -11.6)
  near(measureGlb(bytes).belowOriginM, 11.6, 0.001)
  near(Math.min(...all.map((p) => p[1])), -11.6, 0.001)
  assert.equal(gltf.asset.version, '2.0')
  assert.equal(gltf.extensionsRequired, undefined)
})

test('≤ 600 triangles; POSITION and NORMAL only (with min/max); every normal a unit vector on the counter-clockwise side', () => {
  const tris = prims.reduce((n, p) => n + p.pos.length / 3, 0)
  assert.ok(tris <= 600, `${tris} triangles`)
  for (const p of gltf.meshes[0].primitives) {
    assert.deepEqual(Object.keys(p.attributes).sort(), ['NORMAL', 'POSITION'])
    assert.equal(p.indices, undefined)
    const a = gltf.accessors[p.attributes.POSITION]
    assert.equal(a.min.length, 3)
    assert.equal(a.max.length, 3)
  }
  for (const { pos, nrm } of prims) {
    assert.equal(pos.length % 3, 0)
    for (let t = 0; t < pos.length; t += 3) {
      const [a, b, c] = [pos[t], pos[t + 1], pos[t + 2]]
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
      const g = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
      for (const n of nrm.slice(t, t + 3)) {
        near(Math.hypot(...n), 1, 1e-5, 'unit normal')
        assert.ok(g[0] * n[0] + g[1] * n[1] + g[2] * n[2] > 0, `triangle ${t / 3} winds against its normal`)
      }
    }
  }
})

test('layout: nose gear at z ≈ −28; main wheels within z −2.5…+3.3 under legs at x ±1.9 (body) and ±5.5 (wing)', () => {
  const nose = all.filter((p) => p[2] < -20)
  near((Math.min(...nose.map((p) => p[2])) + Math.max(...nose.map((p) => p[2]))) / 2, -28, 0.05, 'nose gear z')
  const mains = all.filter((p) => p[2] > -20)
  assert.ok(Math.min(...mains.map((p) => p[2])) >= -2.5 && Math.max(...mains.map((p) => p[2])) <= 3.3, 'mains within z −2.5…+3.3')
  for (const x of [-5.5, -1.9, 1.9, 5.5]) {
    const leg = mains.filter((p) => Math.abs(p[0] - x) < 0.9)
    near((Math.min(...leg.map((p) => p[0])) + Math.max(...leg.map((p) => p[0]))) / 2, x, 0.01, 'leg x')
    near(Math.min(...leg.map((p) => p[1])), -11.6, 0.001, `wheels under x ${x}`)
  }
  assert.equal(all.filter((p) => Math.abs(p[0]) > 6.5).length, 0, 'nothing outboard of the wing gear')
  assert.ok(Math.max(...all.map((p) => p[1])) < -7, 'struts end inside the belly and wing (≥ −8.6 / −7.3)')
})

test('no see-through tube ends: every open rim is inside the skin (y > −8.6) or inside a closed part (beam, wheel, axle)', () => {
  // Parts are the connected pieces of the triangle soup (vertices shared by position); a rim edge has one triangle.
  // A part closes the space inside its bounding box when it has no rim below the skin, or when each such rim is inside
  // a part that does (the nose axle: open ends inside the wheels, the strut's end inside it).
  const key = (p: number[]): string => p.map((c) => c.toFixed(4)).join(',')
  const tris = prims.flatMap(({ pos }) => Array.from({ length: pos.length / 3 }, (_, t) => pos.slice(3 * t, 3 * t + 3)))
  const up = new Map<string, string>()
  const root = (k: string): string => (up.has(k) && up.get(k) !== k ? root(up.get(k)!) : k)
  const edges = new Map<string, number>()
  for (const t of tris) {
    const [a, b, c] = t.map(key)
    for (const k of [b, c]) up.set(root(k), root(a))
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const e = u < v ? `${u}|${v}` : `${v}|${u}`
      edges.set(e, (edges.get(e) ?? 0) + 1)
    }
  }
  const parts = new Map<string, { lo: number[]; hi: number[]; rims: number[][] }>()
  for (const p of tris.flat()) {
    const r = root(key(p))
    const b = parts.get(r) ?? { lo: [...p], hi: [...p], rims: [] }
    for (const c of [0, 1, 2]) [b.lo[c], b.hi[c]] = [Math.min(b.lo[c], p[c]), Math.max(b.hi[c], p[c])]
    parts.set(r, b)
  }
  for (const [e, n] of edges) {
    if (n !== 1) continue
    for (const v of e.split('|')) if (Number(v.split(',')[1]) <= -8.6) parts.get(root(v))!.rims.push(v.split(',').map(Number))
  }
  assert.ok([...parts.values()].some((b) => b.rims.length > 0), 'the struts are open tubes')
  const closed = new Set([...parts.values()].filter((b) => b.rims.length === 0))
  const inside = (p: number[]): boolean => [...closed].some((b) => [0, 1, 2].every((c) => p[c] > b.lo[c] + 1e-3 && p[c] < b.hi[c] - 1e-3))
  for (let grew = true; grew; ) {
    grew = false
    for (const b of parts.values()) if (!closed.has(b) && b.rims.every(inside)) grew = Boolean(closed.add(b))
  }
  for (const b of parts.values()) {
    if (!closed.has(b)) assert.fail(`open rim at ${b.rims.find((p) => !inside(p))} is not inside a closed part`)
  }
})

test('public/models/b744-gear.glb is up to date (regenerate: node tools/models/gear-glb.ts)', () => {
  assert.deepEqual(new Uint8Array(readFileSync(GEAR_GLB)), bytes)
})

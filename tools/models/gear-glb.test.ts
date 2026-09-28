// tools/models/gear-glb.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Cartesian3, Matrix3, Matrix4, Quaternion } from 'cesium'
import { GLTF_TO_CESIUM, fixMatrix } from '../../client/scene/model.ts'
import type { ModelManifest } from '../../client/types.ts'
import { GEAR, allGear, gearFor, rootMatrix } from './gear-glb.ts'
import { MANIFEST, loadBody } from './light-anchors.ts'

const manifest: ModelManifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${msg} got ${a}, expected ${b} ± ${tol}`)
const built = allGear(manifest)

/** The JSON chunk and, per node, its primitives' POSITIONs and NORMALs as [x, y, z] (its own frame). */
function parse(b: Uint8Array): { gltf: any; nodes: { name: string; pos: number[][]; nrm: number[][] }[] } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const jsonLen = dv.getUint32(12, true)
  const gltf = JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + jsonLen)))
  const bin = 20 + jsonLen + 8
  const read = (i: number): number[][] => {
    const a = gltf.accessors[i]
    const o = bin + (gltf.bufferViews[a.bufferView].byteOffset ?? 0) + (a.byteOffset ?? 0)
    return Array.from({ length: a.count }, (_, k) => [0, 1, 2].map((c) => dv.getFloat32(o + 12 * k + 4 * c, true)))
  }
  const nodes = gltf.nodes.slice(1).map((n: any) => ({
    name: n.name,
    pos: gltf.meshes[n.mesh].primitives.flatMap((p: any) => read(p.attributes.POSITION)),
    nrm: gltf.meshes[n.mesh].primitives.flatMap((p: any) => read(p.attributes.NORMAL)),
  }))
  return { gltf, nodes }
}

test('every airliner and business jet gets a gear; light aircraft, the helicopter and the Cesium demo model do not', () => {
  assert.deepEqual(built.map((b) => b.e.id).sort(), Object.keys(GEAR).sort())
  for (const id of ['c182', 'ec135', 'cesium-air']) assert.equal(GEAR[id], undefined, id)
})

test('the root node turns the body frame into the glTF frame: GLTF_TO_CESIUM · root = fixMatrix⁻¹', () => {
  for (const { e } of built) {
    const m = Matrix4.multiply(GLTF_TO_CESIUM, Matrix4.fromArray(rootMatrix(e)), new Matrix4())
    const want = Matrix3.transpose(fixMatrix(e), new Matrix3())
    const got = Matrix4.getMatrix3(m, new Matrix3())
    for (let i = 0; i < 9; i++) near(got[i], want[i], 1e-8, `${e.id} [${i}]`)
  }
})

test('each gear: its wheels touch heightM below the origin; its struts start inside the skin; nose ahead of the mains', () => {
  for (const { e, bytes, entry } of built) {
    const g = gearFor(e, GEAR[e.id], loadBody(e))
    const { gltf, nodes } = parse(bytes)
    assert.equal(gltf.asset.version, '2.0')
    assert.deepEqual(nodes.map((n) => n.name), g.legs.map((l) => l.node))
    assert.deepEqual(entry.legs!.map((l) => l.node), g.legs.map((l) => l.node))
    let low = Infinity
    for (const [i, n] of nodes.entries()) {
      const h = gltf.nodes[i + 1].translation
      for (const p of n.pos) low = Math.min(low, p[2] + h[2])
      assert.ok(Math.max(...n.pos.map((p) => p[2])) <= 1e-6, `${e.id} ${n.name}: nothing above its hinge`)
    }
    near(-low, entry.heightM, 0.01, `${e.id} wheels at −heightM`)
    const nose = gltf.nodes.find((n: any) => n.name === 'nose').translation
    const mainL = gltf.nodes.find((n: any) => n.name === 'mainL').translation
    near(nose[0] - mainL[0], GEAR[e.id].wheelbaseM, 1e-6, `${e.id} wheelbase`)
    assert.ok(mainL[1] > 0.6 * GEAR[e.id].trackM / 2 && mainL[1] <= GEAR[e.id].trackM / 2 + 1e-9, `${e.id} left main on the left, at most the published track`)
    // the hinge sits just inside the skin: above the lowest skin within 3 m of it, by no more than 2 m
    const m = loadBody(e)
    for (const node of gltf.nodes.slice(1)) {
      const [x, y, z] = node.translation
      let skin = Infinity
      for (let k = 0; k < m.p.length; k += 3) if (Math.hypot(m.p[k] - x, m.p[k + 1] - y) < 3) skin = Math.min(skin, m.p[k + 2])
      assert.ok(skin < Infinity && z >= skin - 0.05 && z <= skin + 2, `${e.id} ${node.name}: hinge ${z.toFixed(2)} vs the skin ${skin.toFixed(2)}`)
    }
  }
})

test('≤ 800 triangles a gear; every normal a unit vector on the counter-clockwise side', () => {
  for (const { e, bytes } of built) {
    const { nodes } = parse(bytes)
    const tris = nodes.reduce((n, x) => n + x.pos.length / 3, 0)
    assert.ok(tris <= 800, `${e.id}: ${tris} triangles`)
    for (const { pos, nrm } of nodes) {
      for (let t = 0; t < pos.length; t += 3) {
        const [a, b, c] = [pos[t], pos[t + 1], pos[t + 2]]
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
        const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
        const g = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
        for (const n of nrm.slice(t, t + 3)) {
          near(Math.hypot(...n), 1, 1e-5, 'unit normal')
          assert.ok(g[0] * n[0] + g[1] * n[1] + g[2] * n[2] > 0, `${e.id}: triangle ${t / 3} winds against its normal`)
        }
      }
    }
  }
})

test('retraction: the nose swings forward and up, the mains inboard (or forward), each by 90°', () => {
  for (const { e, entry } of built) {
    const legs = entry.legs!
    const swing = (node: string): Cartesian3 => {
      const l = legs.find((x) => x.node === node)!
      const r = Matrix3.fromQuaternion(
        // right-handed rotation of the leg's downward axis
        Quaternion.fromAxisAngle(Cartesian3.fromArray(l.axis), (l.upDeg * Math.PI) / 180),
      )
      return Matrix3.multiplyByVector(r, new Cartesian3(0, 0, -1), new Cartesian3())
    }
    const n = swing('nose')
    assert.ok(n.x > 0.99, `${e.id} nose gear folds forward: ${n}`)
    const l = swing('mainL')
    const r = swing('mainR')
    if (GEAR[e.id].mainsRetract === 'inboard') {
      assert.ok(l.y < -0.99 && r.y > 0.99, `${e.id} mains fold inboard: ${l} ${r}`)
    } else {
      assert.ok(l.x > 0.99 && r.x > 0.99, `${e.id} mains fold forward`)
    }
  }
})

test('the E190 stands on its published gear (Embraer APM-1901): 13.83 m wheelbase, both mains under the wing 5.94 m apart, 0.5 m under its nacelles', () => {
  const { e } = built.find((b) => b.e.id === 'e190')!
  const m = loadBody(e)
  const g = gearFor(e, GEAR.e190, m)
  const hinge = (node: string): number[] => g.legs.find((l) => l.node === node)!.hinge
  near(hinge('nose')[0] - hinge('mainL')[0], 13.83, 1e-9, 'wheelbase')
  near(hinge('mainL')[1] - hinge('mainR')[1], 5.94, 1e-9, 'track: neither main moved inboard off the wing')
  let low = Infinity
  for (let k = 2; k < m.p.length; k += 3) low = Math.min(low, m.p[k])
  near(g.heightM, 0.5 - low, 1e-9, 'the wheels 0.5 m below the nacelles')
})

test('public/models/<id>-gear.glb and the manifest are up to date (regenerate: node tools/models/gear-glb.ts --write)', () => {
  for (const { e, bytes, entry } of built) {
    assert.deepEqual(new Uint8Array(readFileSync(new URL(`../../public/${entry.uri}`, import.meta.url))), bytes, e.id)
    assert.deepEqual(e.gear, entry, `${e.id} manifest gear`)
    assert.equal(e.gearHeightM, entry.heightM, `${e.id} stands on its wheels`)
  }
})


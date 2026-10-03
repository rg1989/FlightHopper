// client/scene/modelOutline.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cartesian2, Cartesian3, Matrix4 } from 'cesium'
import type { Scene } from 'cesium'
import type { ModelManifestEntry } from '../types.ts'
import { outlineDiscs, overDiscs } from './modelOutline.ts'

// A camera at the origin looking along +x, 60° tall on a 1000 × 600 canvas; a flat projection: 10 px per metre across.
const scene = {
  camera: { positionWC: Cartesian3.ZERO, directionWC: Cartesian3.UNIT_X, frustum: { fovy: Math.PI / 3 } },
  canvas: { clientWidth: 1000, clientHeight: 600 },
} as unknown as Scene
const project = (_s: Scene, p: Cartesian3, out: Cartesian2): Cartesian2 => Cartesian2.fromElements(500 + 10 * p.y, 300 - 10 * p.z, out)
const entry = (o: Partial<ModelManifestEntry>): ModelManifestEntry => ({ scale: 1, ...o }) as ModelManifestEntry
const at = (x: number): Matrix4 => Matrix4.fromTranslation(new Cartesian3(x, 0, 0))
const pxPerM = (depthM: number): number => 600 / (2 * depthM * Math.tan(Math.PI / 6))

test('outlineDiscs: each sphere of the outline where it is drawn, as wide as it looks from there', () => {
  const e = entry({ outline: [[0, 0, 0, 2], [0, 5, 1, 1]] })
  const d = outlineDiscs(scene, at(100), e, { n: 0, d: new Float64Array(0) }, project)
  assert.equal(d.n, 2)
  assert.deepEqual([...d.d.subarray(0, 2)], [500, 300])
  assert.ok(Math.abs(d.d[2] - 2 * pxPerM(100)) < 1e-9, `r ${d.d[2]}`)
  assert.deepEqual([...d.d.subarray(3, 5)], [550, 290])
  assert.ok(Math.abs(d.d[5] - pxPerM(100)) < 1e-9)
})

test('outlineDiscs: the model drawn larger (its scale, a far one\'s least size: both in its matrix) has its outline larger', () => {
  const m = Matrix4.multiplyByUniformScale(at(100), 2 * 3, new Matrix4()) // the manifest's scale × 3, as modelMatrixFor bakes them in
  const d = outlineDiscs(scene, m, entry({ scale: 2, outline: [[0, 5, 0, 1]] }), { n: 0, d: new Float64Array(0) }, project)
  assert.equal(d.d[0], 500 + 10 * 5 * 2 * 3)
  assert.ok(Math.abs(d.d[2] - 6 * pxPerM(100)) < 1e-9)
})

test('outlineDiscs: a sphere behind the camera is left out; a model with no outline gets its bracket box\'s sphere', () => {
  const d = outlineDiscs(scene, at(100), entry({ outline: [[-150, 0, 0, 2], [0, 0, 0, 2]] }), { n: 0, d: new Float64Array(0) }, project)
  assert.equal(d.n, 1)
  const b = outlineDiscs(scene, at(100), entry({ box: { centre: [0, 1, 0], half: 20 } }), d, project)
  assert.equal(b, d, 'written into the one it was given')
  assert.deepEqual([b.n, b.d[0], b.d[1]], [1, 510, 300])
  assert.ok(Math.abs(b.d[2] - 20 * pxPerM(100)) < 1e-9)
})

test('overDiscs: a box touches a disc when its nearest point is inside it (with a gap, within the gap of it)', () => {
  const discs = { n: 2, d: Float64Array.of(0, 0, 10, 100, 100, 5) }
  assert.equal(overDiscs(-3, -3, 3, 3, discs), true, 'the centre inside the box')
  assert.equal(overDiscs(8, -50, 60, 50, discs), true, 'an edge through the disc')
  assert.equal(overDiscs(8, 8, 60, 60, discs), false, 'the corner past the rim: 11.3 from the centre')
  assert.equal(overDiscs(8, 8, 60, 60, discs, 2), true, 'within 2 px of it')
  assert.equal(overDiscs(96, 106, 104, 120, discs), false)
  assert.equal(overDiscs(96, 104, 104, 120, discs), true, 'the second disc')
  assert.equal(overDiscs(0, 0, 1, 1, { n: 0, d: discs.d }), false, 'none set')
})

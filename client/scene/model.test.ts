// client/scene/model.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { Cartesian3, Matrix4 } from 'cesium'
import type { ModelManifest } from '../types.ts'
import { GLTF_TO_CESIUM, measureGlb } from './model.ts'

const root = new URL('../../', import.meta.url)
const manifest: ModelManifest = JSON.parse(readFileSync(new URL('public/models/manifest.json', root), 'utf8'))
const m = manifest.models.find((x) => x.id === manifest.default)!
const glbUrl = new URL(`public/${m.uri}`, root)
const axes = measureGlb(readFileSync(glbUrl))

const DEG = Math.PI / 180
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${msg} got ${a}, expected ${b} ± ${tol}`)

// ---------- the asset: where is the nose? ----------

test("Cesium's glTF axis correction: glTF +Z (front) → +X, +Y (up) → +Z, +X → +Y", () => {
  const map = (x: number, y: number, z: number): Cartesian3 => Matrix4.multiplyByPointAsVector(GLTF_TO_CESIUM, new Cartesian3(x, y, z), new Cartesian3())
  assert.ok(Cartesian3.equalsEpsilon(map(0, 0, 1), Cartesian3.UNIT_X, 1e-12))
  assert.ok(Cartesian3.equalsEpsilon(map(0, 1, 0), Cartesian3.UNIT_Z, 1e-12))
  assert.ok(Cartesian3.equalsEpsilon(map(1, 0, 0), Cartesian3.UNIT_Y, 1e-12))
})

test('measureGlb: Cesium_Air noses +X (fin at the tail), up +Z, right wing −Y', () => {
  assert.ok(Cartesian3.angleBetween(axes.nose, Cartesian3.UNIT_X) / DEG < 0.5, `nose ${axes.nose}`)
  assert.ok(Cartesian3.equalsEpsilon(axes.up, Cartesian3.UNIT_Z, 1e-12))
  assert.ok(Cartesian3.angleBetween(axes.right, new Cartesian3(0, -1, 0)) / DEG < 0.5, `right ${axes.right}`)
  near(axes.lengthM, 21.4, 0.01, 'length')
  near(axes.spanM, 25.74, 0.01, 'span')
  near(axes.belowOriginM, 2.296, 0.001, 'origin → wheels')
})

test('measureGlb rejects bytes that are not a GLB', () => {
  assert.throws(() => measureGlb(new TextEncoder().encode('{"asset":{"version":"2.0"},"nodes":[]}')), /GLB/)
})

test('manifest: default model exists, ≤ 5 MB, has provenance; scale, lengthM and gearHeightM match the geometry', () => {
  assert.ok(m, `default "${manifest.default}" is not in models`)
  assert.ok(statSync(glbUrl).size <= 5 * 1024 * 1024)
  for (const k of ['license', 'author', 'source'] as const) assert.ok(m[k].length > 0, k)
  near(axes.lengthM * m.scale, m.lengthM, 0.05, 'lengthM')
  near(axes.belowOriginM * m.scale, m.gearHeightM, 0.05, 'gearHeightM')
})

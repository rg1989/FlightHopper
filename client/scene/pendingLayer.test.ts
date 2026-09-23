// client/scene/pendingLayer.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Cesium from 'cesium'
import { GroundPrimitive, ShowGeometryInstanceAttribute } from 'cesium'
import type { Viewer } from 'cesium'
import { makePendingLayer, type Box } from './pendingLayer.ts'

// No WebGL in Node: GroundPolylinePrimitive checks its 1 px line width against the context's limit, which is 0 here.
;(Cesium as unknown as { ContextLimits: { _maximumAliasedLineWidth: number } }).ContextLimits._maximumAliasedLineWidth = 1
// Material sorts its uniforms by type with instanceof checks against these DOM classes.
for (const name of ['HTMLCanvasElement', 'HTMLImageElement', 'HTMLVideoElement', 'ImageBitmap', 'OffscreenCanvas']) {
  if (!(name in globalThis)) Object.assign(globalThis, { [name]: class {} })
}

/**
 * Ground primitives in a list; frame() runs postRender. drawn() marks every batch as built (a real scene builds them on
 * workers) and records the cells each one shows.
 */
function fakeViewer() {
  let list: object[] = []
  const after: (() => void)[] = []
  const viewer = {
    scene: {
      groundPrimitives: { add: <T extends object>(p: T): T => (list.push(p), p), remove: (p: object) => ((list = list.filter((x) => x !== p)), true) },
      postRender: { addEventListener: (f: () => void) => (after.push(f), () => after.splice(after.indexOf(f), 1)) },
    },
  }
  const attrs = new Map<object, Map<string, { show?: Uint8Array; color?: Uint8Array }>>()
  const drawn = (): void => {
    for (const p of list) {
      if (attrs.has(p)) continue
      const m = new Map<string, { show?: Uint8Array; color?: Uint8Array }>()
      attrs.set(p, m)
      Object.defineProperty(p, 'ready', { value: true })
      Object.defineProperty(p, 'getGeometryInstanceAttributes', { value: (id: string) => m.get(id) ?? (m.set(id, {}), m.get(id)!) })
    }
  }
  /** Per fill batch: its cell count, and the cells it shows now (the edges follow the same flags). */
  const fills = (): [number, string[]][] => list.filter((p) => p instanceof GroundPrimitive).map((p) => [
    (p as unknown as { geometryInstances: unknown[] }).geometryInstances.length,
    [...(attrs.get(p) ?? new Map()).entries()].filter(([, a]) => a.show?.[0] === 1).map(([k]) => k).sort(),
  ])
  /** The colour alpha (0–255) each drawn fill batch was given per cell, where it was set. */
  const alphas = (): Record<string, number>[] => list.filter((p) => p instanceof GroundPrimitive && attrs.has(p)).map((p) =>
    Object.fromEntries([...attrs.get(p)!.entries()].filter(([, a]) => a.color !== undefined).map(([k, a]) => [k, a.color![3]])))
  return { viewer: viewer as unknown as Viewer, drawn, fills, alphas, frame: () => after.forEach((f) => f()), count: () => list.length, listeners: () => after.length }
}

const A: Box[] = [[0, 4, 0, 4], [4, 8, 0, 4]]
const B: Box[] = [[4, 8, 0, 4]]
const C: Box[] = [[4, 8, 0, 4], [8, 12, 0, 4]]

test('pendingLayer: a loaded cell is hidden in place (no rebuild); new cells get a batch swapped in once drawn; clears at once', () => {
  assert.deepEqual([...ShowGeometryInstanceAttribute.toValue(true)], [1])
  const f = fakeViewer()
  const layer = makePendingLayer(f.viewer)
  layer.update(A, true, false)
  f.frame()
  assert.deepEqual(f.fills(), [[2, []]], 'A building, nothing drawn yet')
  f.drawn()
  f.frame()
  assert.deepEqual(f.fills(), [[2, ['0,4,0,4', '4,8,0,4']]], 'A drawn')
  layer.update(B, true, true) // a cell loaded; the next one is loading
  assert.deepEqual(f.fills(), [[2, ['4,8,0,4']]], 'hidden in place, no new batch')
  assert.deepEqual(f.alphas(), [{ '4,8,0,4': Math.floor(0.12 * 255) }], 'the loading one half veiled, in place')
  f.frame()
  assert.equal(f.count(), 3, 'and a light round it')
  layer.update(B, true, false) // in trouble: none loading
  assert.deepEqual(f.alphas(), [{ '4,8,0,4': Math.floor(0.28 * 255) }])
  f.frame()
  assert.equal(f.count(), 2, 'no light')
  layer.update(C, true, false) // a new cell: a new batch, hidden until drawn; A keeps drawing meanwhile
  f.frame()
  assert.deepEqual(f.fills(), [[2, ['4,8,0,4']], [2, []]])
  layer.update([[8, 12, 0, 4], [12, 16, 0, 4]], true, false) // newer cells while it builds: they wait for it
  f.frame()
  assert.equal(f.count(), 4)
  f.drawn()
  f.frame() // C swapped in (showing what is wanted of it now), then the newest set starts building
  assert.deepEqual(f.fills(), [[2, ['8,12,0,4']], [2, []]])
  layer.update(C, false, false) // the chase: hidden at once, the half-built batch too
  assert.equal(f.count(), 0)
  layer.update(A, true, false)
  f.frame()
  layer.update(undefined, true, false) // all loaded
  assert.equal(f.count(), 0)
  f.frame()
  assert.equal(f.count(), 0)
  layer.destroy()
  assert.equal(f.listeners(), 0)
})

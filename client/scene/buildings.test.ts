// client/scene/buildings.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Appearance, Cartesian3, Cartographic, Ellipsoid, Matrix4, Primitive, type Viewer } from 'cesium'
import type { TerrainFrame } from '../types.ts'
import { TOPO_ON, drawnHeightM } from './exaggeration.ts'
import type { Layer } from './mvt.ts'
import { followExaggeration } from './runways.ts'
import { Buildings, extentM, footprints, groundPoints, tileLatDeg, tileLonDeg, tileOf, tilesAround, type Footprint } from './buildings.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)
const LLBG = { lat: 32.0114, lon: 34.8867 }

test('tileOf: z14 slippy-map tile of a point; the tile bounds contain it', () => {
  assert.deepEqual(tileOf(0, 0), [8192, 8192])
  assert.deepEqual(tileOf(85.05, -180), [0, 0])
  for (const p of [LLBG, { lat: 47.2602, lon: 11.3439 }, { lat: -22.95, lon: -43.18 }, { lat: 22.28, lon: 114.16 }]) {
    const [x, y] = tileOf(p.lat, p.lon)
    assert.ok(tileLonDeg(x) <= p.lon && p.lon < tileLonDeg(x + 1), `lon ${p.lon}`)
    assert.ok(tileLatDeg(y + 1) < p.lat && p.lat <= tileLatDeg(y), `lat ${p.lat}`)
  }
})

test('tilesAround: every tile touching the square of half-side r, nearest first', () => {
  const ts = tilesAround(LLBG.lat, LLBG.lon, 5000)
  assert.deepEqual(ts[0], tileOf(LLBG.lat, LLBG.lon))
  const dLat = 5000 / 111_320
  const dLon = 5000 / (111_320 * Math.cos((LLBG.lat * Math.PI) / 180))
  const has = (t: [number, number]): boolean => ts.some(([x, y]) => x === t[0] && y === t[1])
  for (const [a, b] of [[dLat, dLon], [dLat, -dLon], [-dLat, dLon], [-dLat, -dLon]]) assert.ok(has(tileOf(LLBG.lat + a, LLBG.lon + b)), 'corner')
  assert.ok(ts.length >= 25 && ts.length <= 42, `${ts.length} tiles`) // z14 is ~2.07 km wide at 32°N: 5–6 per 10 km
  const [cx, cy] = ts[0]
  const d = ts.map(([x, y]) => Math.hypot(x - cx, y - cy))
  assert.deepEqual(d, [...d].sort((a, b) => a - b))
})

const square = (x0: number, y0: number, s: number): [number, number][] => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]]
const layer: Layer = {
  extent: 4096,
  features: [
    { id: 1, props: { render_height: 12, render_min_height: 0, colour: 'white' }, polys: [[square(1024, 1024, 1024), square(1280, 1280, 256)]] },
    { id: 2, props: { render_height: 40, render_min_height: 0, hide_3d: true }, polys: [[square(0, 0, 100)]] }, // an outline with parts
    { id: 3, props: { render_height: 1, render_min_height: 0 }, polys: [[square(3000, 3000, 50)]] }, // a shed or a wall
    { id: 4, props: { render_height: 30, render_min_height: 10 }, polys: [[square(100, 3000, 64)], [square(300, 3000, 64)]] },
  ],
}

test('footprints: rings in degrees with their holes; hide_3d outlines and anything under 2 m are left out', () => {
  const [x, y] = tileOf(LLBG.lat, LLBG.lon)
  const fs = footprints(layer, x, y)
  assert.equal(fs.length, 3) // feature 1, and feature 4's two polygons
  const [a, b, c] = fs
  assert.equal(a.rings.length, 2)
  near(a.rings[0][0][0], tileLonDeg(x + 0.25), 1e-12)
  near(a.rings[0][0][1], tileLatDeg(y + 0.25), 1e-12)
  near(a.rings[1][0][0], tileLonDeg(x + 0.3125), 1e-12) // the hole
  assert.deepEqual([a.heightM, a.minHeightM, b.heightM, b.minHeightM, c.minHeightM], [12, 0, 30, 10, 10])
  for (const f of fs) assert.ok(f.rnd >= 0 && f.rnd < 1)
  assert.notEqual(b.rnd, c.rnd)
})

const fp = (heightM: number, minHeightM: number, rings: [number, number][][] = []): Footprint => ({ rings, heightM, minHeightM, rnd: 0 })

test('extentM: OSM height counts from the lowest ground the building touches; a 20 m foundation under it; a podium part starts at its min height', () => {
  // on a slope: corners read 100–108 m
  assert.deepEqual(extentM(fp(12, 0), [100, 104, 108, 103]), { baseM: 80, topM: 112, groundM: 103.75 })
  // steeper than the building is tall: one storey (3 m) stays above the uphill corner, the downhill side shows more floors
  assert.deepEqual(extentM(fp(8, 0), [100, 115]), { baseM: 80, topM: 118, groundM: 107.5 })
  assert.deepEqual(extentM(fp(2.5, 0), [100, 101]), { baseM: 80, topM: 103.5, groundM: 100.5 }) // never more than its own height
  assert.deepEqual(extentM(fp(30, 10), [100, 106]), { baseM: 110, topM: 130, groundM: 103 })
  assert.deepEqual(extentM(fp(12, 0), [50]), { baseM: 30, topM: 62, groundM: 50 })
})

test('groundPoints: every corner of the outer ring, plus a point every 10 m along long walls, at most 24', () => {
  const mLat = 111_320
  const mLon = mLat * Math.cos((32 * Math.PI) / 180)
  // a 30 m × 8 m block at 32°N: the long walls get points at 10 and 20 m, the short ones none
  const rect: [number, number][] = [[35, 32], [35 + 30 / mLon, 32], [35 + 30 / mLon, 32 + 8 / mLat], [35, 32 + 8 / mLat]]
  const pts = groundPoints(fp(10, 0, [rect, [[35.00001, 32.00001], [35.00002, 32.00001], [35.00002, 32.00002]]]))
  assert.equal(pts.length, 8)
  for (const c of rect) assert.ok(pts.some((p) => p[0] === c[0] && p[1] === c[1]), 'every corner')
  near((pts[1][0] - 35) * mLon, 10, 0.01)
  near((pts[2][0] - 35) * mLon, 20, 0.01)
  // a round tower of 40 corners 1 m apart: evenly thinned to 24
  const ring = Array.from({ length: 40 }, (_, i): [number, number] => [35 + Math.cos(i / 6.4) * 6.4 / mLon, 32 + Math.sin(i / 6.4) * 6.4 / mLat])
  const thin = groundPoints(fp(10, 0, [ring]))
  assert.equal(thin.length, 24)
  assert.deepEqual(thin[0], ring[0])
})

test('followExaggeration: any height in the tile lands where the terrain is drawn, not only the base', () => {
  const up = Ellipsoid.WGS84.geodeticSurfaceNormalCartographic(Cartographic.fromDegrees(LLBG.lon, LLBG.lat))
  const baseM = 100
  const upDotBase = Cartesian3.dot(up, Cartesian3.fromDegrees(LLBG.lon, LLBG.lat, baseM))
  const M = new Matrix4()
  for (const [f, relHM] of [[TOPO_ON, 0], [0.5, 50], [0.1, 60], [0, 60]]) {
    followExaggeration(up, upDotBase, baseM, f, relHM, M)
    for (const [dLon, h] of [[0, 100], [0.01, 350], [-0.008, 20]]) { // a roof ~1 km away and 250 m above the base
      const c = Cartographic.fromCartesian(Matrix4.multiplyByPoint(M, Cartesian3.fromDegrees(LLBG.lon + dLon, LLBG.lat, h), new Cartesian3()))
      near(c.height, drawnHeightM(h, Math.max(f, 1e-3), relHM), 0.1, `f ${f} h ${h}`)
    }
  }
})

// ---- the layer itself, with a fake viewer and loader (no WebGL, no network) ----

// A Material types its uniforms with instanceof checks against these DOM classes (Material.js getUniformType); Node has none.
Object.assign(globalThis, { HTMLCanvasElement: class {}, HTMLImageElement: class {}, ImageBitmap: class {}, OffscreenCanvas: class {} })

function fakeViewer(): { viewer: Viewer; added: Primitive[]; removed: Primitive[] } {
  const added: Primitive[] = []
  const removed: Primitive[] = []
  const primitives = { add: (p: Primitive) => (added.push(p), p), remove: (p: Primitive) => (removed.push(p), true) }
  return { viewer: { scene: { primitives }, isDestroyed: () => false } as unknown as Viewer, added, removed }
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}
const tf = (fNow: number, relHM = 0): TerrainFrame => ({ fSampled: fNow, fNow, relHM })

function rig(): { b: Buildings; added: Primitive[]; removed: Primitive[]; asked: string[]; release: () => void } {
  const { viewer, added, removed } = fakeViewer()
  const asked: string[] = []
  const gates: (() => void)[] = []
  const b = new Buildings(viewer, {
    loadLayer: async (x, y) => {
      asked.push(`${x}/${y}`)
      await new Promise<void>((r) => gates.push(r))
      return layer
    },
    groundM: async (cs) => cs.map(() => 40),
  })
  return { b, added, removed, asked, release: () => gates.splice(0).forEach((r) => r()) }
}

test('Buildings: nothing loads or shows without a focus (browse); a focus loads the nearest tiles, 4 at a time', async () => {
  const { b, added, asked, release } = rig()
  b.update(null, tf(TOPO_ON))
  await flush()
  assert.equal(asked.length, 0)
  b.update(LLBG, tf(TOPO_ON))
  await flush()
  assert.equal(asked.length, 4)
  const [x, y] = tileOf(LLBG.lat, LLBG.lon)
  assert.equal(asked[0], `${x}/${y}`)
  release()
  await flush()
  b.update(LLBG, tf(TOPO_ON))
  await flush()
  assert.equal(added.length, 4)
  assert.equal(asked.length, 8) // the next four
  for (const p of added) {
    assert.ok(p instanceof Primitive)
    assert.equal(p.allowPicking, false)
    assert.ok(p.appearance instanceof Appearance)
    assert.equal(p.appearance.translucent, false)
    assert.equal(p.show, true)
  }
  b.update(null, tf(TOPO_ON))
  for (const p of added) assert.equal(p.show, false, 'browse hides them')
})

test('Buildings: see-through swaps every tile to the translucent appearance and back, new tiles included', async () => {
  const { b, added, release } = rig()
  b.update(LLBG, tf(TOPO_ON))
  await flush()
  release()
  await flush()
  b.setGlass(true)
  for (const p of added) assert.equal(p.appearance.translucent, true)
  b.update(LLBG, tf(TOPO_ON))
  await flush()
  release()
  await flush()
  assert.equal(added.length, 8)
  for (const p of added) assert.equal(p.appearance.translucent, true, 'a tile built while see-through')
  b.setGlass(false)
  for (const p of added) assert.equal(p.appearance.translucent, false)
})

test('Buildings: tiles follow the exaggeration, hide when flat, and far tiles are dropped', async () => {
  const { b, added, removed, release } = rig()
  b.update(LLBG, tf(TOPO_ON))
  await flush()
  release()
  await flush()
  const p = added[0]
  const before = Matrix4.clone(p.modelMatrix)
  b.update(LLBG, tf(0.5, 50))
  assert.ok(!Matrix4.equals(before, p.modelMatrix), 'the sink moves them')
  b.update(LLBG, tf(0, 50))
  assert.equal(p.show, false, 'nothing to draw on a flat map')
  b.update(LLBG, tf(TOPO_ON))
  assert.equal(p.show, true)
  b.update({ lat: LLBG.lat + 1, lon: LLBG.lon }, tf(TOPO_ON)) // 111 km north
  assert.equal(removed.length, added.length, 'every old tile went')
  b.destroy()
})

test('Buildings: setNight feeds one night value to every tile, solid and see-through, clamped to 0–1', async () => {
  const { b, added, release } = rig()
  b.update(LLBG, tf(TOPO_ON))
  await flush()
  release()
  await flush()
  const night = (p: Primitive): unknown => (p.appearance as Appearance).material.uniforms.night
  assert.equal(night(added[0]), 0, 'day until told otherwise')
  b.setNight(0.7)
  for (const p of added) assert.equal(night(p), 0.7)
  b.setGlass(true)
  for (const p of added) {
    assert.equal(night(p), 0.7, 'the see-through look reads the same value')
    assert.equal((p.appearance as Appearance).isTranslucent(), true, 'and Cesium draws it translucent')
  }
  b.setNight(3)
  assert.equal(night(added[0]), 1)
  b.setNight(Number.NaN)
  assert.equal(night(added[0]), 0)
})

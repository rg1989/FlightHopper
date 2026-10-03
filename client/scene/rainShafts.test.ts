// client/scene/rainShafts.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BillboardCollection, BlendOption, Cartesian3, Cartographic, Ellipsoid, Math as CesiumMath, VerticalOrigin, type Billboard, type PrimitiveCollection } from 'cesium'
import { geoidN } from '../../shared/geoid.ts'
import { CLOUD_KM, FADE_ANGLE, RADAR_LOOK, fadeAlpha, sunBrightness, type RadarBase } from './cloudField.ts'
import type { RadarCell } from './radarCells.ts'
import { RainShafts, SHAFT_ID, pickShafts, shaftCanvas, type RainShaft } from './rainShafts.ts'

const KM_PER_DEG = 111.195
const KM_PER_LON = KM_PER_DEG * Math.cos((32 * Math.PI) / 180)
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol
const TRUE = { fSampled: 1, fNow: 1, relHM: 0 }

/** A radar cell east and north km of the aircraft (32°N, 34.9°E). */
function cell(east: number, north: number, dbz: number, o: Partial<RadarCell> = {}): RadarCell {
  return {
    lat: 32 + north / KM_PER_DEG, lon: 34.9 + east / KM_PER_LON, east, north, fromKm: Math.hypot(east, north), dbz, snow: false,
    seed: Math.round((east + 500) * 1000 + north + 500) + dbz, ...o,
  }
}
const base1500 = (): RadarBase => ({ baseM: 1500, groundM: 300 })
const spaced = (dbz: number, n: number, o: Partial<RadarCell> = {}): RadarCell[] => Array.from({ length: n }, (_, i) => cell(30 * i - 45, 0, dbz, { seed: 100 + i, ...o }))

test('pickShafts: a shaft under each rain block of 35 dBZ and more; not under lighter rain, nor under snow', () => {
  assert.equal(pickShafts([cell(0, 0, 34)], base1500).length, 0)
  assert.equal(pickShafts([cell(0, 0, 35)], base1500).length, 1)
  assert.equal(pickShafts([cell(0, 0, 60, { snow: true })], base1500).length, 0)
  assert.deepEqual(pickShafts([], base1500), [])
  assert.equal(pickShafts([cell(0, 0, 20), cell(10, 0, 36), cell(-30, 0, 70, { snow: true }), cell(60, 0, 45)], base1500).length, 2)
})

test('pickShafts: from the base of its place to the ground, where its cell is; 2 km wide at 35 dBZ to 4 km at 55 and more; more opaque the heavier', () => {
  const asked: [number, number][] = []
  const base = (lat: number, lon: number): RadarBase => (asked.push([lat, lon]), { baseM: 1500, groundM: 300 })
  const [s] = pickShafts([cell(12, -7, 40)], base)
  assert.ok(asked.length >= 1 && near(asked[0][0], 32 - 7 / KM_PER_DEG, 1e-9) && near(asked[0][1], 34.9 + 12 / KM_PER_LON, 1e-9))
  assert.ok(near(s.lat, 32 - 7 / KM_PER_DEG, 1e-9) && near(s.lon, 34.9 + 12 / KM_PER_LON, 1e-9))
  assert.deepEqual([s.baseM, s.groundM], [1500, 300])
  const w = (dbz: number): number => pickShafts([cell(0, 0, dbz)], base1500)[0].widthM
  const a = (dbz: number): number => pickShafts([cell(0, 0, dbz)], base1500)[0].alpha
  assert.deepEqual([w(35), w(45), w(55), w(70)], [2000, 3000, 4000, 4000])
  assert.ok(near(a(35), RADAR_LOOK.shaft.alpha[0], 1e-9) && near(a(55), RADAR_LOOK.shaft.alpha[1], 1e-9) && near(a(70), RADAR_LOOK.shaft.alpha[1], 1e-9))
  assert.ok(a(35) < a(40) && a(40) < a(50) && a(50) < a(55), 'more opaque the heavier')
  assert.ok(RADAR_LOOK.shaft.alpha[0] > 0 && RADAR_LOOK.shaft.alpha[1] <= 1)
  const bases = pickShafts([cell(0, 0, 40), cell(40, 0, 40)], (_lat, lon) => (lon > 34.95 ? { baseM: 900, groundM: 100 } : { baseM: 2500, groundM: 50 }))
  assert.deepEqual(bases.map((b) => [b.baseM, b.groundM]).sort((x, y) => x[0] - y[0]), [[900, 100], [2500, 50]], 'each its own place\'s')
})

test('pickShafts: at most 40, the nearest; a continuous region has them spread out and each wider (up to 4 ×), not all round the nearest block', () => {
  const dense = Array.from({ length: 400 }, (_, k) => cell(((k % 20) - 10) * 3, (Math.floor(k / 20) - 10) * 3, 45, { seed: k + 1 })) // 400 blocks, 3 km apart
  const shafts = pickShafts(dense, base1500)
  assert.ok(shafts.length <= RADAR_LOOK.shaft.max && shafts.length >= 15, `${shafts.length} shafts`)
  const w = shafts.map((s) => s.widthM)
  assert.ok(Math.min(...w) > 3000 && Math.max(...w) <= 12_000 + 1e-6, `${Math.min(...w)}–${Math.max(...w)} m: wider than 3 km, up to 4 ×`)
  const span = Math.max(...shafts.map((s) => Math.hypot(s.lat - 32, (s.lon - 34.9) * Math.cos((32 * Math.PI) / 180)) * KM_PER_DEG))
  assert.ok(span > 12, `across the region: ${span} km from the aircraft`)
  const few = pickShafts(spaced(45, 6), base1500)
  assert.equal(few.length, 6, 'room: every one')
  assert.ok(few.every((s) => s.widthM === 3000), 'as wide as the plan says')
  const field = Array.from({ length: 100 }, (_, k) => cell(((k % 10) - 5) * 20 + 7, (Math.floor(k / 10) - 5) * 20 + 13, 45, { seed: k + 1 })) // 100 blocks 20 km apart
  const nearest = pickShafts(field, base1500)
  assert.equal(nearest.length, 40)
  const want = field.toSorted((a, b) => a.fromKm - b.fromKm).slice(0, 40).map((c) => `${c.lat.toFixed(6)},${c.lon.toFixed(6)}`).sort()
  assert.deepEqual(nearest.map((s) => `${s.lat.toFixed(6)},${s.lon.toFixed(6)}`).sort(), want, 'the nearest 40')
})

test('pickShafts: the stronger a block the sooner it is kept; the same cells give the same shafts; it fades out where it looks small', () => {
  const cells = [cell(0, 0, 40), cell(2, 0, 50), cell(0, 40, 36)]
  assert.deepEqual(pickShafts(cells, base1500), pickShafts([...cells].reverse(), base1500))
  for (const dbz of [35, 45, 55]) {
    const s = pickShafts(spaced(dbz, 3), base1500)
    assert.equal(s.length, 3)
    assert.ok(s.every((x) => near(x.farKm, Math.min(RADAR_LOOK.radiusKm, CLOUD_KM, Math.max(x.widthM, 1500 + RADAR_LOOK.shaft.overlapM - 300) / 1000 / FADE_ANGLE), 1e-9)), `${dbz}: ${s.map((x) => x.farKm)}`)
  }
  assert.ok(near(pickShafts([cell(0, 0, 35)], base1500)[0].farKm, 2 / FADE_ANGLE, 1e-9), 'a narrow shaft is gone by where it looks 1.7° across')
  assert.equal(pickShafts([cell(0, 0, 55)], base1500)[0].farKm, 100, 'a wide one by the radius the radar is read to')
})

test('pickShafts: the look constants are read as the shafts are picked (Weather3D.rebuildSky)', () => {
  const was = RADAR_LOOK.shaft.width
  try {
    ;(RADAR_LOOK.shaft as { width: readonly [number, number] }).width = [500, 700]
    assert.equal(pickShafts([cell(0, 0, 35)], base1500)[0].widthM, 500)
  } finally {
    ;(RADAR_LOOK.shaft as { width: readonly [number, number] }).width = was
  }
})

// ---- RainShafts --------------------------------------------------------------------------------------------------------------

const shaft = (o: Partial<RainShaft> = {}): RainShaft => ({ lon: 34.9, lat: 32, baseM: 1500, groundM: 300, widthM: 3000, alpha: 0.5, farKm: 100, ...o })
const fakeCanvas = (): HTMLCanvasElement => ({ width: 64, height: 256 }) as unknown as HTMLCanvasElement

function rig(opts: { image?: () => HTMLCanvasElement } = {}) {
  const added: unknown[] = []
  const removed: unknown[] = []
  const primitives = { add: (p: unknown) => (added.push(p), p), remove: (p: unknown) => (removed.push(p), true) } as unknown as PrimitiveCollection
  let made = 0
  const layer = new RainShafts(primitives, { image: opts.image ?? ((): HTMLCanvasElement => (made++, fakeCanvas())) })
  const coll = added[0] as BillboardCollection
  const shafts = (): Billboard[] => Array.from({ length: coll.length }, (_, i) => coll.get(i))
  return { layer, coll, shafts, added, removed, made: () => made }
}
const placeOf = (b: Billboard): { lon: number; lat: number; h: number } => {
  const p = Cartographic.fromCartesian(b.position)
  return { lon: CesiumMath.toDegrees(p.longitude), lat: CesiumMath.toDegrees(p.latitude), h: p.height }
}

test('RainShafts: one translucent BillboardCollection, hidden until shown', () => {
  const r = rig()
  assert.ok(r.coll instanceof BillboardCollection)
  assert.equal(r.coll.blendOption, BlendOption.TRANSLUCENT)
  assert.equal(r.coll.show, false)
  assert.equal(r.layer.show, false)
  r.layer.show = true
  assert.equal(r.coll.show, true)
  assert.equal(r.layer.show, true)
  assert.equal(r.added.length, 1)
})

test('RainShafts: a billboard a shaft, sized in metres, aligned to the local up, its middle between the cloud base and the ground, one shared image', () => {
  const r = rig()
  r.layer.show = true
  const a = shaft()
  const b = shaft({ lon: 35.3, lat: 31.8, baseM: 900, groundM: 40, widthM: 4000, alpha: 0.7 })
  r.layer.draw([a, b])
  r.layer.frame(TRUE, 0)
  const bs = r.shafts()
  assert.equal(bs.length, 2)
  assert.equal(r.layer.count, 2)
  for (const [bb, s] of [[bs[0], a], [bs[1], b]] as const) {
    assert.equal(bb.sizeInMeters, true)
    assert.equal(bb.verticalOrigin, VerticalOrigin.CENTER)
    const top = s.baseM + RADAR_LOOK.shaft.overlapM
    const p = placeOf(bb)
    assert.ok(near(p.lon, s.lon, 1e-9) && near(p.lat, s.lat, 1e-9))
    assert.ok(near(p.h, (top + s.groundM) / 2 + geoidN(s.lat, s.lon), 1e-3), `${p.h} m above the ellipsoid: halfway up`)
    assert.equal(bb.width, s.widthM)
    assert.ok(near(bb.height!, top - s.groundM, 1e-9), `${bb.height} m tall: from the ground into the cloud`)
    const up = Ellipsoid.WGS84.geodeticSurfaceNormal(bb.position, new Cartesian3())
    assert.ok(Cartesian3.equalsEpsilon(bb.alignedAxis, up, 1e-9), `${bb.alignedAxis} is the local up ${up}`)
    assert.ok(Math.abs(Cartesian3.magnitude(bb.alignedAxis) - 1) < 1e-9)
    assert.equal(bb.image, SHAFT_ID)
    assert.ok(near(bb.color.alpha, s.alpha, 0.01) && near(bb.color.red, 1, 1e-12) && near(bb.color.green, 1, 1e-12), 'by day: white, its own opacity')
    assert.equal(bb.show, true)
  }
  assert.equal(r.made(), 1, 'the image is made once for all')
})

test('RainShafts: a shaft is never shorter than 100 m (a ceiling just over the ground)', () => {
  const r = rig()
  r.layer.draw([shaft({ baseM: 320, groundM: 300 }), shaft({ baseM: 100, groundM: 300 })]) // a ceiling under the ground it is reported over: bad data
  assert.ok(near(r.shafts()[0].height!, 170, 1e-9), 'the overlap, over the ground')
  assert.equal(r.shafts()[1].height, 100)
})

test('RainShafts: a flattened relief moves each shaft with its ground, keeping its foot on it; a new draw is placed for the relief as drawn', () => {
  const r = rig()
  const s = shaft({ baseM: 2000, groundM: 900 })
  r.layer.draw([s])
  const n = geoidN(s.lat, s.lon)
  r.layer.frame(TRUE, 0)
  const foot = (): number => placeOf(r.shafts()[0]).h - r.shafts()[0].height! / 2
  assert.ok(near(foot(), 900 + n, 1e-3), 'the foot on the ground')
  r.layer.frame({ fSampled: 0, fNow: 0, relHM: 100 }, 0) // flat at 100 m above the ellipsoid
  assert.ok(near(foot(), 100, 1e-3), 'the ground drawn at 100 m: the foot with it')
  r.layer.frame({ fSampled: 0.5, fNow: 0.5, relHM: 100 }, 0)
  assert.ok(near(foot(), (900 + n - 100) * 0.5 + 100, 1e-3), 'half grown')
  r.layer.draw([s])
  assert.ok(near(foot(), (900 + n - 100) * 0.5 + 100, 1e-3))
  const before = r.shafts()[0].position.clone()
  r.layer.frame({ fSampled: Number.NaN, fNow: Number.NaN, relHM: 0 }, 0)
  assert.ok(Cartesian3.equals(r.shafts()[0].position, before), 'a frame that is not a number is ignored')
})

test('RainShafts: darker by the Sun\'s night, written again only when it has changed by a step', () => {
  const r = rig()
  r.layer.draw([shaft({ alpha: 0.6 }), shaft({ alpha: 0.3 })])
  r.layer.frame(TRUE, 1)
  for (const [bb, a] of [[r.shafts()[0], 0.6], [r.shafts()[1], 0.3]] as const) {
    assert.ok(near(bb.color.red, sunBrightness(1), 1e-12) && near(bb.color.blue, sunBrightness(1), 1e-12), `${bb.color}`)
    assert.ok(near(bb.color.alpha, a, 0.01), 'its opacity as it was')
  }
  r.layer.frame(TRUE, 0.5)
  assert.ok(near(r.shafts()[0].color.red, sunBrightness(0.5), 0.85 * 0.01))
  r.layer.frame(TRUE, 0.3)
  assert.ok(near(r.shafts()[0].color.red, sunBrightness(0.3), 0.85 * 0.011), `${r.shafts()[0].color.red}: in steps of a hundredth, not coarser`)
  r.layer.frame(TRUE, 0.5)
  const written = r.shafts()[0].color.clone()
  r.layer.frame(TRUE, 0.505)
  assert.ok(r.shafts()[0].color.equals(written), 'a hundredth of the night: no rewrite')
  r.layer.frame(TRUE, Number.NaN)
  assert.ok(near(r.shafts()[0].color.red, 1, 1e-12), 'not a number: day')
  r.layer.frame(TRUE, 1)
  r.layer.draw([shaft()])
  assert.ok(near(r.shafts()[0].color.red, sunBrightness(1), 1e-12), 'a draw at night is drawn for the night')
})

test('RainShafts: faded by the distance from the place given (each look), all of a shaft near, none past its farKm (hidden); a draw after it is faded too', () => {
  const r = rig()
  const kmNorth = (km: number): number => 32 + km / KM_PER_DEG
  const here = Cartesian3.fromDegrees(34.9, 32, 1000)
  r.layer.draw([shaft({ lat: kmNorth(0), farKm: 100 }), shaft({ lat: kmNorth(85), farKm: 100 }), shaft({ lat: kmNorth(120), farKm: 100 })])
  assert.deepEqual(r.shafts().map((b) => b.show), [true, true, true], 'before any fade: all')
  r.layer.fade(here)
  const [a, b, c] = r.shafts()
  assert.ok(near(a.color.alpha, 0.5, 1e-9))
  assert.ok(b.color.alpha > 0 && b.color.alpha < 0.5 && b.show, `${b.color.alpha}: part of the way`)
  assert.equal(c.show, false)
  assert.ok(near(b.color.alpha, 0.5 * fadeAlpha({ farKm: 100 }, Math.hypot(85, 1)), 0.5 * 0.05 + 0.01), 'by fadeAlpha, in steps of 0.05')
  const before = b.color.clone()
  r.layer.fade(Cartesian3.fromDegrees(34.9, kmNorth(-0.4), 1000)) // 0.4 km farther: a fade of 0.02 less, under a step: not written
  assert.ok(b.color.equals(before), `${b.color.alpha} against ${before.alpha}`)
  r.layer.fade(here)
  r.layer.draw([shaft({ lat: kmNorth(120), farKm: 100 })])
  assert.equal(r.shafts()[0].show, false, 'drawn faded')
  r.layer.fade(Cartesian3.fromDegrees(34.9, kmNorth(100), 1000))
  assert.equal(r.shafts()[0].show, true, 'and back as the aircraft comes')
})

test('RainShafts: a new draw replaces the shafts; none draws none; destroy takes the collection out; after it, nothing', () => {
  const r = rig()
  r.layer.show = true
  r.layer.draw([shaft(), shaft(), shaft()])
  r.layer.draw([shaft({ baseM: 2500 })])
  assert.equal(r.shafts().length, 1)
  r.layer.draw([])
  assert.equal(r.layer.count, 0)
  r.layer.destroy()
  assert.deepEqual(r.removed, [r.coll])
  r.layer.destroy()
  assert.equal(r.removed.length, 1, 'once')
  r.layer.draw([shaft()])
  r.layer.frame(TRUE, 0)
  r.layer.fade(Cartesian3.ZERO)
  assert.equal(r.removed.length, 1, 'destroyed: does nothing')
  assert.equal(r.layer.count, 0, 'and draws nothing')
  assert.equal(r.layer.show, false, 'nor is it shown')
})

// ---- the image ---------------------------------------------------------------------------------------------------------------

/** A canvas context that takes any call and answers with another (gradients, and what they answer), recording what it was told. */
function recorder(): { ctx: unknown; calls: string[]; sets: Record<string, unknown> } {
  const calls: string[] = []
  const sets: Record<string, unknown> = {}
  const node = (): unknown => new Proxy(() => {}, { get: (_t, k) => (k === 'then' ? undefined : node()), apply: () => node(), set: () => true })
  const ctx = new Proxy({}, {
    get: (_t, k) => (typeof k === 'string' && /^(?:fillRect|createLinearGradient|createRadialGradient|clearRect|fill|beginPath)$/.test(k) ? (..._a: unknown[]) => (calls.push(k), node()) : sets[String(k)]),
    set: (_t, k, v) => ((sets[String(k)] = v), true),
  })
  return { ctx, calls, sets }
}

test('shaftCanvas: the shaft\'s image, drawn once on a canvas: a veil with vertical streaks, soft at its sides, its top (inside the cloud) and its foot', () => {
  const { ctx, calls, sets } = recorder()
  const made: { width: number; height: number; getContext: () => unknown }[] = []
  Object.assign(globalThis, { document: { createElement: (tag: string) => (assert.equal(tag, 'canvas'), made[made.push({ width: 0, height: 0, getContext: () => ctx }) - 1]) } })
  try {
    const c = shaftCanvas() as unknown as { width: number; height: number }
    assert.deepEqual([c.width, c.height], [64, 256])
    assert.equal(made.length, 1)
    assert.ok(calls.filter((k) => k === 'fillRect').length > 20, 'a veil and its streaks')
    assert.ok(calls.filter((k) => k === 'createLinearGradient').length >= 20, 'streaks fade in and out')
    assert.equal(sets.globalCompositeOperation, 'destination-in', 'then cut to its soft shape')
    assert.equal(shaftCanvas() as unknown, made[0], 'one canvas, kept')
    assert.equal(made.length, 1)
  } finally {
    Reflect.deleteProperty(globalThis, 'document')
  }
})

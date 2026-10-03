// client/scene/rainShafts.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BillboardCollection, BlendOption, Cartesian3, Cartographic, Ellipsoid, Math as CesiumMath, VerticalOrigin, type Billboard, type PrimitiveCollection } from 'cesium'
import { geoidN } from '../../shared/geoid.ts'
import { CLOUD_KM, FADE_ANGLE, RADAR_LOOK, fadeAlpha, sunBrightness, towerRiseM, type RadarBase } from './cloudField.ts'
import type { RadarCell } from './radarCells.ts'
import { RainShafts, SHAFT_ID, pickShafts, shaftCanvas, shaftEnvelope, shaftPixels, type RainShaft } from './rainShafts.ts'

const KM_PER_DEG = 111.195
const KM_PER_LON = KM_PER_DEG * Math.cos((32 * Math.PI) / 180)
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
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

test('pickShafts: from the base of its place to the ground, where its cell is; 2 km wide at 35 dBZ to 4 km at 55 and more, a little different each; more opaque the heavier; its top in the cloud', () => {
  const asked: [number, number][] = []
  const base = (lat: number, lon: number): RadarBase => (asked.push([lat, lon]), { baseM: 1500, groundM: 300 })
  const [s] = pickShafts([cell(12, -7, 40)], base)
  assert.ok(asked.length >= 1 && near(asked[0][0], 32 - 7 / KM_PER_DEG, 1e-9) && near(asked[0][1], 34.9 + 12 / KM_PER_LON, 1e-9))
  assert.ok(near(s.lat, 32 - 7 / KM_PER_DEG, 1e-9) && near(s.lon, 34.9 + 12 / KM_PER_LON, 1e-9))
  assert.deepEqual([s.baseM, s.groundM], [1500, 300])
  const J = RADAR_LOOK.shaft
  const withSeed = (dbz: number, seed: number): RainShaft => pickShafts([cell(0, 0, dbz, { seed })], base1500)[0]
  for (const [dbz, w] of [[35, 2000], [45, 3000], [55, 4000], [70, 4000]] as const) {
    for (let seed = 1; seed <= 25; seed++) assert.ok(near(withSeed(dbz, seed).widthM, w, w * J.widthJitter + 1e-6), `${dbz} dBZ seed ${seed}: ${withSeed(dbz, seed).widthM} m, ${w} give or take ${J.widthJitter * 100} %`)
  }
  const meanOf = (dbz: number, f: (x: RainShaft) => number): number => mean(Array.from({ length: 60 }, (_, i) => f(withSeed(dbz, i + 1))))
  assert.ok(near(meanOf(45, (x) => x.widthM), 3000, 80), 'about the width the plan says, on the whole')
  for (const [dbz, a] of [[35, RADAR_LOOK.shaft.alpha[0]], [55, RADAR_LOOK.shaft.alpha[1]], [70, RADAR_LOOK.shaft.alpha[1]]] as const) {
    for (let seed = 1; seed <= 25; seed++) assert.ok(near(withSeed(dbz, seed).alpha, a, a * J.alphaJitter + 1e-9) || withSeed(dbz, seed).alpha === 1, `${dbz} dBZ: ${withSeed(dbz, seed).alpha}`)
  }
  const alphas = [35, 40, 45, 50, 55].map((dbz) => meanOf(dbz, (x) => x.alpha))
  assert.ok(alphas.every((a, i) => i === 0 || a > alphas[i - 1] + 0.05), `more opaque the heavier, on the whole: ${alphas.map((a) => a.toFixed(2))}`)
  assert.ok(RADAR_LOOK.shaft.alpha[0] > 0 && RADAR_LOOK.shaft.alpha[1] <= 1)
  for (const dbz of [35, 45, 55]) assert.ok(near(withSeed(dbz, 3).topM, 1500 + towerRiseM(dbz) + J.overlapM, 1e-9), `${dbz} dBZ: its top ${J.overlapM} m inside its cloud, over where the cloud\'s bottom is drawn`)
  const bases = pickShafts([cell(0, 0, 40), cell(40, 0, 40)], (_lat, lon) => (lon > 34.95 ? { baseM: 900, groundM: 100 } : { baseM: 2500, groundM: 50 }))
  assert.deepEqual(bases.map((b) => [b.baseM, b.groundM]).sort((x, y) => x[0] - y[0]), [[900, 100], [2500, 50]], 'each its own place\'s')
  assert.ok(bases.every((b) => b.topM > b.baseM + 400), 'each its own top')
})

test('pickShafts: each shaft is a little different from the next (width, opacity, image), from its own cell\'s seed: the same cell the same shaft wherever the aircraft is, another cell another', () => {
  const cells = Array.from({ length: 24 }, (_, i) => cell(30 * (i % 6) - 75, 30 * Math.floor(i / 6) - 45, 45, { seed: 300 + i * 17 }))
  const shafts = pickShafts(cells, base1500)
  assert.equal(shafts.length, 24)
  const V = RADAR_LOOK.shaft.variants
  assert.ok(shafts.every((x) => Number.isInteger(x.variant) && x.variant >= 0 && x.variant < V))
  assert.ok(new Set(shafts.map((x) => x.variant)).size >= Math.min(V, 3), `${new Set(shafts.map((x) => x.variant)).size} of ${V} images in use`)
  assert.ok(new Set(shafts.map((x) => x.widthM)).size >= 20 && new Set(shafts.map((x) => x.alpha)).size >= 20, 'widths and opacities all their own')
  assert.ok(shafts.some((x) => x.widthM < 3000 - 100) && shafts.some((x) => x.widthM > 3000 + 100), 'some narrower, some wider than the plan')
  assert.ok(shafts.some((x) => x.alpha < 0.575 - 0.03) && shafts.some((x) => x.alpha > 0.575 + 0.03))
  const again = pickShafts(cells.map((c) => ({ ...c, east: c.east + 5, lon: c.lon + 0.05 })), base1500) // the aircraft elsewhere: the same blocks (seeds), their places moved
  assert.deepEqual(again.map((x) => [x.variant, x.widthM, x.alpha]), shafts.map((x) => [x.variant, x.widthM, x.alpha]))
  const other = pickShafts([cell(0, 0, 45, { seed: 1 }), cell(40, 0, 45, { seed: 2 })], base1500)
  assert.notDeepEqual([other[0].variant, other[0].widthM, other[0].alpha], [other[1].variant, other[1].widthM, other[1].alpha])
  const was = RADAR_LOOK.shaft.variants
  try {
    ;(RADAR_LOOK.shaft as { variants: number }).variants = 1
    assert.ok(pickShafts(cells, base1500).every((x) => x.variant === 0), 'one image: all of them')
    ;(RADAR_LOOK.shaft as { variants: number }).variants = 9
    assert.ok(new Set(pickShafts(cells, base1500).map((x) => x.variant)).size >= 5, 'the look constant is read as they are picked')
  } finally {
    ;(RADAR_LOOK.shaft as { variants: number }).variants = was
  }
})

test('pickShafts: at most 40 within 100 km, the nearest; a continuous region has them spread out and each wider, not all round the nearest block', () => {
  const dense = Array.from({ length: 400 }, (_, k) => cell(((k % 20) - 10) * 3, (Math.floor(k / 20) - 10) * 3, 45, { seed: k + 1 })) // 400 blocks, 3 km apart
  const shafts = pickShafts(dense, base1500)
  assert.ok(shafts.length <= RADAR_LOOK.shaft.max && shafts.length >= 15, `${shafts.length} shafts`)
  const w = shafts.map((s) => s.widthM)
  assert.ok(Math.min(...w) > 3000 && Math.max(...w) <= 12_000 * (1 + RADAR_LOOK.shaft.widthJitter) + 1e-6, `${Math.min(...w)}–${Math.max(...w)} m: wider than 3 km`)
  const span = Math.max(...shafts.map((s) => Math.hypot(s.lat - 32, (s.lon - 34.9) * Math.cos((32 * Math.PI) / 180)) * KM_PER_DEG))
  assert.ok(span > 12, `across the region: ${span} km from the aircraft`)
  const few = pickShafts(spaced(45, 6), base1500)
  assert.equal(few.length, 6, 'room: every one')
  assert.ok(few.every((s) => near(s.widthM, 3000, 3000 * RADAR_LOOK.shaft.widthJitter + 1e-6)), 'as wide as the plan says')
  const field = Array.from({ length: 100 }, (_, k) => cell(((k % 10) - 5) * 15 + 7, (Math.floor(k / 10) - 5) * 15 + 4, 45, { seed: k + 1 })) // 100 blocks 15 km apart, all within 100 km
  const nearest = pickShafts(field, base1500)
  assert.equal(nearest.length, 40)
  const want = field.toSorted((a, b) => a.fromKm - b.fromKm).slice(0, 40).map((c) => `${c.lat.toFixed(6)},${c.lon.toFixed(6)}`).sort()
  assert.deepEqual(nearest.map((s) => `${s.lat.toFixed(6)},${s.lon.toFixed(6)}`).sort(), want, 'the nearest 40')
})

test('pickShafts: the ring past 100 km (read so that a shaft is there before it fades in) is kept on top: hidden where it stands, none of the 40 within given up for it, and what is within the same with or without it', () => {
  const dense = Array.from({ length: 400 }, (_, k) => cell(((k % 20) - 10) * 3, (Math.floor(k / 20) - 10) * 3, 45, { seed: k + 1 }))
  const ring = [cell(104, 5, 52, { seed: 9001 }), cell(-110, -12, 44, { seed: 9002 }), cell(20, 121, 47, { seed: 9003 }), cell(-8, -126, 38, { seed: 9004 })]
  const alone = pickShafts(dense, base1500)
  const both = pickShafts([...ring, ...dense], base1500)
  assert.equal(both.length, alone.length + ring.length, 'on top of the shafts within')
  assert.deepEqual(both.filter((s) => s.farKm <= 100 && Math.hypot((s.lon - 34.9) * KM_PER_LON, (s.lat - 32) * KM_PER_DEG) <= 100), alone, 'those within are as they were')
  const out = both.filter((s) => Math.hypot((s.lon - 34.9) * KM_PER_LON, (s.lat - 32) * KM_PER_DEG) > 100)
  assert.equal(out.length, 4)
  for (const s of out) assert.ok(s.farKm <= 100 && fadeAlpha(s, Math.hypot((s.lon - 34.9) * KM_PER_LON, (s.lat - 32) * KM_PER_DEG)) === 0, 'hidden where it stands: it fades in as the aircraft comes')
})

test('pickShafts: the stronger a block the sooner it is kept; the same cells give the same shafts; it fades out where it looks small', () => {
  const cells = [cell(0, 0, 40), cell(2, 0, 50), cell(0, 40, 36)]
  assert.deepEqual(pickShafts(cells, base1500), pickShafts([...cells].reverse(), base1500))
  for (const dbz of [35, 45, 55]) {
    const s = pickShafts(spaced(dbz, 3), base1500)
    assert.equal(s.length, 3)
    assert.ok(s.every((x) => near(x.farKm, Math.min(RADAR_LOOK.radiusKm, CLOUD_KM, Math.max(x.widthM, x.topM - 300) / 1000 / FADE_ANGLE), 1e-9)), `${dbz}: ${s.map((x) => x.farKm)}`)
  }
  const narrow = pickShafts([cell(0, 0, 35)], base1500)[0]
  assert.ok(near(narrow.farKm, Math.max(narrow.widthM, narrow.topM - narrow.groundM) / 1000 / FADE_ANGLE, 1e-9) && narrow.farKm < 100, 'a narrow shaft is gone by where it looks 1.7° across')
  assert.equal(pickShafts([cell(0, 0, 55)], base1500)[0].farKm, 100, 'a wide one by the radius the radar is read to')
})

test('pickShafts: the look constants are read as the shafts are picked (Weather3D.rebuildSky)', () => {
  const was = [RADAR_LOOK.shaft.width, RADAR_LOOK.shaft.widthJitter, RADAR_LOOK.shaft.overlapM] as const
  try {
    ;(RADAR_LOOK.shaft as { width: readonly [number, number] }).width = [500, 700]
    ;(RADAR_LOOK.shaft as { widthJitter: number }).widthJitter = 0
    ;(RADAR_LOOK.shaft as { overlapM: number }).overlapM = 1000
    const s = pickShafts([cell(0, 0, 35)], base1500)[0]
    assert.equal(s.widthM, 500)
    assert.ok(near(s.topM, 1500 + towerRiseM(35) + 1000, 1e-9))
  } finally {
    ;(RADAR_LOOK.shaft as { width: readonly [number, number] }).width = was[0]
    ;(RADAR_LOOK.shaft as { widthJitter: number }).widthJitter = was[1]
    ;(RADAR_LOOK.shaft as { overlapM: number }).overlapM = was[2]
  }
})

// ---- RainShafts --------------------------------------------------------------------------------------------------------------

const shaft = (o: Partial<RainShaft> = {}): RainShaft => ({ lon: 34.9, lat: 32, baseM: 1500, topM: 2000, groundM: 300, widthM: 3000, alpha: 0.5, variant: 0, farKm: 100, ...o })
const fakeCanvas = (): HTMLCanvasElement => ({ width: 128, height: 256 }) as unknown as HTMLCanvasElement

function rig(opts: { image?: (variant: number) => HTMLCanvasElement } = {}) {
  const added: unknown[] = []
  const removed: unknown[] = []
  const primitives = { add: (p: unknown) => (added.push(p), p), remove: (p: unknown) => (removed.push(p), true) } as unknown as PrimitiveCollection
  const made: number[] = [] // the variants whose image was made, in order
  const layer = new RainShafts(primitives, { image: opts.image ?? ((variant: number): HTMLCanvasElement => (made.push(variant), fakeCanvas())) })
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

test('RainShafts: a billboard a shaft, sized in metres, aligned to the local up, its middle between its top in the cloud and the ground, the image of its variant: one copy of each for all', () => {
  const r = rig()
  r.layer.show = true
  const a = shaft()
  const b = shaft({ lon: 35.3, lat: 31.8, baseM: 900, topM: 1650, groundM: 40, widthM: 4000, alpha: 0.7, variant: 2 })
  const c = shaft({ lon: 35.1, lat: 31.9, variant: 2 })
  r.layer.draw([a, b, c])
  r.layer.frame(TRUE, 0)
  const bs = r.shafts()
  assert.equal(bs.length, 3)
  assert.equal(r.layer.count, 3)
  for (const [bb, s] of [[bs[0], a], [bs[1], b], [bs[2], c]] as const) {
    assert.equal(bb.sizeInMeters, true)
    assert.equal(bb.verticalOrigin, VerticalOrigin.CENTER)
    const p = placeOf(bb)
    assert.ok(near(p.lon, s.lon, 1e-9) && near(p.lat, s.lat, 1e-9))
    assert.ok(near(p.h, (s.topM + s.groundM) / 2 + geoidN(s.lat, s.lon), 1e-3), `${p.h} m above the ellipsoid: halfway up`)
    assert.equal(bb.width, s.widthM)
    assert.ok(near(bb.height!, s.topM - s.groundM, 1e-9), `${bb.height} m tall: from the ground into the cloud`)
    const up = Ellipsoid.WGS84.geodeticSurfaceNormal(bb.position, new Cartesian3())
    assert.ok(Cartesian3.equalsEpsilon(bb.alignedAxis, up, 1e-9), `${bb.alignedAxis} is the local up ${up}`)
    assert.ok(Math.abs(Cartesian3.magnitude(bb.alignedAxis) - 1) < 1e-9)
    assert.equal(bb.image, `${SHAFT_ID}-${s.variant}`)
    assert.ok(near(bb.color.alpha, s.alpha, 0.01) && near(bb.color.red, 1, 1e-12) && near(bb.color.green, 1, 1e-12), 'by day: white, its own opacity')
    assert.equal(bb.show, true)
  }
  assert.notEqual(bs[0].image, bs[1].image)
  assert.equal(bs[1].image, bs[2].image)
  assert.deepEqual(r.made().toSorted(), [0, 2], 'each variant\'s image made once, however many shafts draw it')
  r.layer.draw([a, c, a])
  assert.deepEqual(r.made().toSorted(), [0, 2], 'and kept across draws')
})

test('RainShafts: a shaft is never shorter than 100 m (a ceiling just over the ground)', () => {
  const r = rig()
  r.layer.draw([shaft({ topM: 350, groundM: 300 }), shaft({ topM: 100, groundM: 300 }), shaft({ topM: 600, groundM: 300 })]) // a top under the ground it is reported over: bad data
  assert.equal(r.shafts()[0].height, 100)
  assert.equal(r.shafts()[1].height, 100)
  assert.equal(r.shafts()[2].height, 300)
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

const W = 128
const H = 256

test('shaftEnvelope: 1 in the middle and falling smoothly to 0 at the sides, the top and the foot (a step nowhere), the sides wandering down the shaft, the top ragged', () => {
  for (const variant of [0, 1, 2, 3]) {
    const e = shaftEnvelope(variant)
    assert.equal(e.length, W * H)
    assert.ok(e.every((v) => v >= 0 && v <= 1))
    let edge = 0
    for (let y = 0; y < H; y++) edge = Math.max(edge, e[y * W], e[y * W + W - 1])
    for (let x = 0; x < W; x++) edge = Math.max(edge, e[x], e[(H - 1) * W + x])
    assert.ok(edge < 0.002, `variant ${variant}: clear at its edges (${edge})`)
    let step = 0
    for (let y = 0; y < H; y++) for (let x = 1; x < W; x++) step = Math.max(step, Math.abs(e[y * W + x] - e[y * W + x - 1]))
    for (let y = 1; y < H; y++) for (let x = 0; x < W; x++) step = Math.max(step, Math.abs(e[y * W + x] - e[(y - 1) * W + x]))
    assert.ok(step < 0.06, `variant ${variant}: no pixel differs from its neighbour by more than ${step} (a hard edge would be 1)`)
    assert.ok(e[(H / 2) * W + W / 2] > 0.7, 'about full in the middle')
    const reach = (y: number): [number, number] => {
      let [l, r] = [-1, -1]
      for (let x = 0; x < W; x++) if (e[y * W + x] >= 0.05) [l, r] = [l < 0 ? x : l, x]
      return [l, r]
    }
    const rows = Array.from({ length: 20 }, (_, i) => Math.round(H * 0.15) + i * 5).map(reach)
    const wander = Math.max(Math.max(...rows.map((p) => p[0])) - Math.min(...rows.map((p) => p[0])), Math.max(...rows.map((p) => p[1])) - Math.min(...rows.map((p) => p[1])))
    assert.ok(wander >= 4, `variant ${variant}: a side moves ${wander} columns down the shaft`)
    const half: number[] = []
    for (let x = Math.round(W * 0.35); x <= Math.round(W * 0.65); x++) {
      let top = 0
      for (let y = 0; y < H; y++) top = Math.max(top, e[y * W + x])
      for (let y = 0; y < H; y++) if (e[y * W + x] >= 0.5 * top) {
        half.push(y)
        break
      }
    }
    assert.ok(Math.min(...half) >= 8 && Math.max(...half) <= 45, `the top is half there at rows ${Math.min(...half)} to ${Math.max(...half)}: a soft ramp, not a line`)
    assert.ok(Math.max(...half) - Math.min(...half) >= 5, `variant ${variant}: ragged along its width (${Math.max(...half) - Math.min(...half)} rows)`)
    const band = (i: number): number => mean(Array.from({ length: Math.round(H / 10) * Math.round(W * 0.4) }, (_, k) => e[(Math.round(H * i / 10) + Math.floor(k / Math.round(W * 0.4))) * W + Math.round(W * 0.3) + (k % Math.round(W * 0.4))]))
    const bands = Array.from({ length: 10 }, (_, i) => band(i))
    assert.ok(bands[0] < 0.3 && bands[9] < 0.06, `fed in at the top (${bands[0].toFixed(2)}), gone at the foot (${bands[9].toFixed(2)})`)
    for (let i = 7; i < 10; i++) assert.ok(bands[i] < bands[i - 1], 'the foot dissolves a band at a time')
  }
  const [a, b] = [shaftEnvelope(0), shaftEnvelope(1)]
  assert.ok(mean(Array.from(a, (v, k) => Math.abs(v - b[k]))) > 0.01, 'another variant, another shape')
  assert.deepEqual(shaftEnvelope(2), shaftEnvelope(2))
})

test('shaftPixels: RGBA bytes of the veil and streaks, shaped by the envelope; the same for a variant every time, another look for another; soft, grey-blue, streaky', () => {
  const px = [0, 1, 2, 3].map(shaftPixels)
  px.forEach((p, v) => {
    assert.ok(p instanceof Uint8ClampedArray && p.length === W * H * 4)
    assert.deepEqual(shaftPixels(v), p, 'the same image again')
    const e = shaftEnvelope(v)
    let [lit, sum, sum2, n, dark] = [0, 0, 0, 0, 0]
    for (let k = 0; k < W * H; k++) {
      const a = p[4 * k + 3]
      assert.ok(a / 255 <= 3 * e[k] + 2 / 255, `variant ${v} pixel ${k}: opacity ${a / 255} where the envelope says ${e[k]}`)
      if (a >= 60) {
        lit++
        const [r, g, b] = [p[4 * k], p[4 * k + 1], p[4 * k + 2]]
        assert.ok(b >= r && b >= g - 1 && r >= 60 && b <= 250, `grey-blue or white: ${r}, ${g}, ${b}`)
        if (r < 100) dark++
      }
    }
    for (let y = Math.round(H * 0.3); y < Math.round(H * 0.6); y++) for (let x = Math.round(W * 0.3); x < Math.round(W * 0.7); x++) {
      const a = p[4 * (y * W + x) + 3]
      sum += a
      sum2 += a * a
      n++
    }
    const [m, sd] = [sum / n, Math.sqrt(sum2 / n - (sum / n) ** 2)]
    assert.ok(m > 90 && m < 200, `variant ${v}: the middle is a veil, neither empty nor solid (${m.toFixed(0)} of 255)`)
    assert.ok(sd > 25, `variant ${v}: streaks all through it (the opacity varies by ${sd.toFixed(0)})`)
    assert.ok(lit > 3000 && dark > 50, `variant ${v}: light and dark streaks over the veil (${lit} pixels, ${dark} dark)`)
    for (let y = 0; y < H; y++) assert.ok(p[4 * (y * W) + 3] <= 2 && p[4 * (y * W + W - 1) + 3] <= 2, 'clear at the sides')
    for (let x = 0; x < W; x++) assert.ok(p[4 * x + 3] <= 2 && p[4 * ((H - 1) * W + x) + 3] <= 2, 'clear at the top and the foot')
  })
  let differ = 0
  for (let k = 0; k < W * H; k++) if (Math.abs(px[0][4 * k + 3] - px[1][4 * k + 3]) > 8) differ++
  assert.ok(differ > 0.3 * W * H, `${((100 * differ) / (W * H)).toFixed(0)} % of the pixels differ between variants`)
})

test('shaftCanvas: a variant\'s pixels on a canvas, drawn once; each variant its own canvas', () => {
  const put: { data: Uint8ClampedArray; width: number; height: number }[] = []
  const made: { width: number; height: number; getContext: () => unknown }[] = []
  const ctx = { createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }), putImageData: (img: { data: Uint8ClampedArray; width: number; height: number }) => void put.push({ data: Uint8ClampedArray.from(img.data), width: img.width, height: img.height }) }
  Object.assign(globalThis, { document: { createElement: (tag: string) => (assert.equal(tag, 'canvas'), made[made.push({ width: 0, height: 0, getContext: () => ctx }) - 1]) } })
  try {
    const c = shaftCanvas() as unknown as { width: number; height: number }
    assert.deepEqual([c.width, c.height], [W, H])
    assert.equal(made.length, 1)
    assert.equal(put.length, 1)
    assert.deepEqual([put[0].width, put[0].height], [W, H])
    assert.deepEqual(put[0].data, shaftPixels(0), 'variant 0\'s pixels')
    assert.equal(shaftCanvas(0) as unknown, made[0], 'one canvas, kept')
    assert.equal(made.length, 1)
    const d = shaftCanvas(3) as unknown
    assert.notEqual(d, made[0])
    assert.equal(made.length, 2)
    assert.deepEqual(put[1].data, shaftPixels(3))
  } finally {
    Reflect.deleteProperty(globalThis, 'document')
  }
})

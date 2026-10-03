// client/scene/cloudVolume.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cartesian3, Event, Matrix4, PostProcessStage, PostProcessStageComposite, Transforms, type Camera, type PostProcessStageCollection } from 'cesium'
import { geoidN } from '../../shared/geoid.ts'
import { PUFF_FILL, SEV, sunBrightness, type CloudSpec } from './cloudField.ts'
import {
  CloudVolume, EDGE_KM, EDGE_TEXELS, EDGE_TOP_KM, MARCH_SHADER, MAX_EDGES, MIX_SHADER, POST_KM, REACH_KM, eyeToLocal, hazardEdges, localFrame, localToMap, mapScale, noiseAtlas, packEdges,
  resumeRendering, survey, tileUv, unpackEdge, type HazardEdge,
} from './cloudVolume.ts'
import { AHEAD_MIN, aheadPath } from './wxAhead.ts'
import { BANDS, FIELD_KM, FIELD_N, HEIGHT_MAX_M, TOWER_BAND, buildField, fieldAtlas, sampleField, type WxField } from './wxField.ts'
import { hazardsNear, type Hazard } from './wxGeo.ts'

const KM_PER_DEG = 111.195
const TEXEL_KM = FIELD_KM / FIELD_N
const LAT = 37.6
const LON = -122.4
const RAD = Math.PI / 180
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol
/** The place eastKm and northKm of (lat, lon), on the field's flat map round it. */
const at = (eastKm: number, northKm: number, lat = LAT, lon = LON): { lat: number; lon: number } =>
  ({ lat: lat + northKm / KM_PER_DEG, lon: lon + eastKm / (KM_PER_DEG * Math.cos(lat * RAD)) })
/** A puff whose base and top are given; wide: its billboard's width, m. */
function puff(baseM: number, topM: number, o: Partial<CloudSpec> & { eastKm?: number; northKm?: number; wide?: number } = {}): CloudSpec {
  const { eastKm = 0, northKm = 0, wide = 3000, ...rest } = o
  return {
    ...at(eastKm, northKm), heightM: (baseM + topM) / 2, groundM: 0, scale: [wide, (topM - baseM) / PUFF_FILL], maxSize: [20, 12, 12], slice: 0.3,
    brightness: 1, tint: 0, farKm: 100, ...rest,
  }
}
/** Where the middle of the field's texel (i, j) is, km east and north of its middle. */
const middleOf = (i: number, j: number): [number, number] => [(i - (FIELD_N - 1) / 2) * TEXEL_KM, (j - (FIELD_N - 1) / 2) * TEXEL_KM]

// ---- the pure helpers the shader mirrors -------------------------------------------------------------------------------------

test('tileUv: a place of the map as the atlas\'s texture coordinate: band b\'s tile at column b % 3 and row ⌊b / 3⌋, the image\'s first row at the top of the texture (Cesium flips an image it uploads), the middle of a texel at its middle', () => {
  const atlas = fieldAtlas(buildField([puff(1500, 2500, { eastKm: 20, northKm: -30 }), puff(1000, 9000, { eastKm: -50, northKm: 70, wide: 8000, tower: 1, sev: SEV.storm })], LAT, LON))
  /** The image's pixel under a texture coordinate, as the GPU finds it in the flipped image. */
  const pixel = ([u, v]: [number, number]): [number, number] => [u * atlas.width - 0.5, (1 - v) * atlas.height - 0.5]
  for (const [band, i, j] of [[0, 0, 0], [0, 287, 207], [1, 100, 400], [2, 511, 0], [3, 0, 511], [TOWER_BAND, 176, 367], [TOWER_BAND, 511, 511]]) {
    const [x, y] = pixel(tileUv(band, ...middleOf(i, j)))
    assert.ok(near(x, (band % 3) * FIELD_N + i, 1e-6) && near(y, Math.floor(band / 3) * FIELD_N + j, 1e-6), `band ${band} texel ${i},${j}: pixel ${x},${y}`)
  }
  // the cumulus, 20 km east and 30 km south, is in band 0's tile where the field has it; the tower in the towers'
  const byte = (band: number, eastKm: number, northKm: number): number[] => {
    const [x, y] = pixel(tileUv(band, eastKm, northKm)).map(Math.round)
    return [...atlas.data.subarray((y * atlas.width + x) * 4, (y * atlas.width + x) * 4 + 4)]
  }
  const cu = byte(0, 20, -30)
  assert.ok(cu[0] > 200 && near(cu[1], (1500 / HEIGHT_MAX_M) * 255, 1) && near(cu[2], (2500 / HEIGHT_MAX_M) * 255, 1) && cu[3] === 0, `${cu}`)
  assert.deepEqual(byte(0, 20, 30), [0, 0, 0, 0], 'north is not south')
  const cb = byte(TOWER_BAND, -50, 70)
  assert.ok(cb[0] > 200 && cb[3] === 255, `${cb}`)
  assert.deepEqual(byte(TOWER_BAND, 20, -30), [0, 0, 0, 0])
})

test('tileUv: beyond the outer texels\' middles a place has their coordinate (no bilinear mix reaches into the next tile)', () => {
  const edge = middleOf(FIELD_N - 1, 0)
  assert.deepEqual(tileUv(1, 500, -500), tileUv(1, ...edge))
  assert.deepEqual(tileUv(1, FIELD_KM / 2, -FIELD_KM / 2), tileUv(1, ...edge), 'the square\'s own corner is half a texel past the last middle')
  const [u, v] = tileUv(1, ...edge)
  assert.ok(near(u * 3 * FIELD_N, 2 * FIELD_N - 0.5, 1e-9) && near((1 - v) * 2 * FIELD_N, 0.5, 1e-9), `${u}, ${v}`)
})

test('localFrame: world metres to the frame at a place: km east, north and up from it', () => {
  const frame = localFrame(LAT, LON, 25)
  const to = (lat: number, lon: number, h: number): Cartesian3 => Matrix4.multiplyByPoint(frame, Cartesian3.fromDegrees(lon, lat, h), new Cartesian3())
  assert.ok(Cartesian3.equalsEpsilon(to(LAT, LON, 25), Cartesian3.ZERO, 0, 1e-9))
  assert.ok(Cartesian3.equalsEpsilon(to(LAT, LON, 10_025), new Cartesian3(0, 0, 10), 0, 1e-6), '10 km up')
  const n = to(LAT + 1, LON, 25)
  assert.ok(near(n.x, 0, 1e-6) && near(n.y, 111, 0.2) && near(n.z, -(111 * 111) / (2 * 6371), 0.02), `a degree north: ${n}: the Earth has curved away by 0.97 km`)
  const e = to(LAT, LON + 1, 25)
  assert.ok(near(e.x, 111.3 * Math.cos(LAT * RAD), 0.2) && e.y > 0 && e.y < 1, `a degree east: ${e}`)
})

test('eyeToLocal: eye metres to the frame through the camera\'s inverse view: the camera\'s own place and a point 1 km in front of it, to the millimetre', () => {
  const frame = localFrame(LAT, LON, 25)
  const cameraWC = Cartesian3.fromDegrees(LON + 0.6, LAT - 0.4, 9000)
  const inverseView = Transforms.eastNorthUpToFixedFrame(cameraWC) // a camera looking straight down: its x east, its y north, its −z down
  const m = eyeToLocal(inverseView, frame, new Matrix4())
  const want = (world: Cartesian3): Cartesian3 => Matrix4.multiplyByPoint(frame, world, new Cartesian3())
  const here = Matrix4.multiplyByPoint(m, Cartesian3.ZERO, new Cartesian3())
  assert.ok(Cartesian3.equalsEpsilon(here, want(cameraWC), 0, 1e-6))
  const ahead = Matrix4.multiplyByPoint(m, new Cartesian3(0, 0, -1000), new Cartesian3())
  assert.ok(Cartesian3.equalsEpsilon(ahead, want(Matrix4.multiplyByPoint(inverseView, new Cartesian3(0, 0, -1000), new Cartesian3())), 0, 1e-6), `${ahead}`)
  assert.ok(Cartesian3.equalsEpsilon(ahead, want(Cartesian3.fromDegrees(LON + 0.6, LAT - 0.4, 8000)), 0, 1e-4), 'which is 1 km under the camera')
  assert.ok(near(Cartesian3.distance(ahead, here), 1, 1e-9), 'a kilometre is 1')
  assert.ok(near(here.x, 53.3, 0.3) && near(here.y, -44.3, 0.3) && near(here.z, 8.6, 0.1), `${here}: the camera, 53 km east and 44 km south of the frame's middle`)
  assert.ok(Math.max(...Matrix4.toArray(m).map(Math.abs)) < 200, 'no large number for the shader\'s floats')
})

test('localToMap: a place of the frame as the field maps it (km east and north on its flat map, km over the sea): within 40 m out to 150 km from the field\'s middle and 100 m at the square\'s corners, up to 12 km', () => {
  for (const [lat0, lon0] of [[LAT, LON], [32, 34.9], [60, 10], [-33.9, 151.2], [0.2, -78.5]]) {
    const n0 = geoidN(lat0, lon0)
    const frame = localFrame(lat0, lon0, n0)
    const scale = mapScale(lat0, lon0, n0)
    let [within, worst] = [0, 0]
    for (const eastKm of [-150, -100, -40, 0, 75, 106, 150]) {
      for (const northKm of [-150, -106, -60, 0, 40, 100, 150]) {
        for (const hM of [0, 3000, 12_000]) {
          const p = at(eastKm, northKm, lat0, lon0)
          const l = Matrix4.multiplyByPoint(frame, Cartesian3.fromDegrees(p.lon, p.lat, hM + n0), new Cartesian3())
          const m = localToMap(l.x, l.y, l.z, scale)
          const off = Math.max(Math.abs(m[0] - eastKm), Math.abs(m[1] - northKm), Math.abs(m[2] - hM / 1000))
          worst = Math.max(worst, off)
          if (Math.hypot(eastKm, northKm) <= 150) within = Math.max(within, off)
        }
      }
    }
    assert.ok(within < 0.04 && worst < 0.1, `round ${lat0}, ${lon0}: ${(within * 1000).toFixed(1)} m off at worst within 150 km, ${(worst * 1000).toFixed(1)} m in the corners`)
  }
})

test('localToMap: where the shader samples is where sampleField does: a cloud 100 km off is found at its own place and height', () => {
  const spec = puff(3000, 5000, { eastKm: 90, northKm: -60, wide: 6000 })
  const f = buildField([spec], LAT, LON)
  const n0 = geoidN(LAT, LON)
  const l = Matrix4.multiplyByPoint(localFrame(LAT, LON, n0), Cartesian3.fromDegrees(spec.lon, spec.lat, 4000 + n0), new Cartesian3())
  const [eastKm, northKm, hKm] = localToMap(l.x, l.y, l.z, mapScale(LAT, LON, n0))
  const there = at(eastKm, northKm)
  assert.ok(near(sampleField(f, there.lat, there.lon, hKm * 1000).cover, sampleField(f, spec.lat, spec.lon, 4000).cover, 0.02))
  assert.ok(sampleField(f, there.lat, there.lon, hKm * 1000).cover > 0.9)
})

test('noiseAtlas: 64 slices of a smooth random volume that tiles (the mock\'s 32³, made twice as fine by a spline), in 8 × 8 tiles of 66 × 66: each slice with a rim of the far side\'s texels (so a bilinear mix wraps), R the slice and G the next', () => {
  const a = noiseAtlas()
  assert.deepEqual([a.width, a.height, a.data.length], [528, 528, 528 * 528 * 4])
  /** Slice z's texel (x, y), each −1 … 64 (the rim), channel c. */
  const px = (z: number, x: number, y: number, c: number): number => a.data[((Math.floor(z / 8) * 66 + 1 + y) * a.width + (z % 8) * 66 + 1 + x) * 4 + c]
  for (const z of [0, 7, 8, 19, 40, 63]) {
    for (const k of [0, 5, 31, 63]) {
      assert.equal(px(z, -1, k, 0), px(z, 63, k, 0))
      assert.equal(px(z, 64, k, 0), px(z, 0, k, 0))
      assert.equal(px(z, k, -1, 0), px(z, k, 63, 0))
      assert.equal(px(z, k, 64, 0), px(z, k, 0, 0))
      assert.equal(px(z, k, 3, 1), px((z + 1) % 64, k, 3, 0), 'G is the next slice')
      assert.equal(px(z, -1, 64, 1), px((z + 1) % 64, 63, 0, 0), 'in the rim too')
      assert.equal(px(z, k, 9, 3), 255)
    }
  }
  let [lo, hi, step, bend] = [255, 0, 0, 0]
  for (let z = 0; z < 64; z++) {
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const v = px(z, x, y, 0)
        lo = Math.min(lo, v)
        hi = Math.max(hi, v)
        step += Math.abs(v - px(z, x + 1, y, 0)) + Math.abs(v - px(z, x, y + 1, 0)) + Math.abs(v - px(z, x, y, 1))
        bend = Math.max(bend, Math.abs(px(z, x - 1, y, 0) - 2 * v + px(z, x + 1, y, 0)))
      }
    }
  }
  assert.deepEqual([lo, hi], [0, 255], 'stretched over the whole range')
  assert.ok(step / (3 * 64 ** 3) < 15, `smooth: a texel differs from its neighbour by ${(step / (3 * 64 ** 3)).toFixed(1)} of 255 on average`)
  assert.ok(bend <= 24, `no crease: three texels in a row are ${bend} of 255 off a straight line at most `)
  assert.deepEqual(noiseAtlas().data, a.data, 'the same every time')
})

test('survey: where each band has weather, coarsely (cells of 5 km, each also set when a neighbour has weather: R, G the two low layer bands, B the two high, A the towers), and which bands rain', () => {
  const f = buildField([
    puff(1500, 2500, { eastKm: 22, northKm: -31 }), puff(7000, 8700, { eastKm: -80, northKm: 60, wide: 10_000, sev: SEV.light }),
    puff(1000, 9000, { eastKm: 100, northKm: 100, wide: 8000, tower: 1, sev: SEV.storm }), puff(3000, 4000, { eastKm: -120, northKm: -120 }), puff(9000, 10_000, { eastKm: -80, northKm: -20 }),
  ], LAT, LON)
  const s = survey(f)
  assert.deepEqual([s.near.width, s.near.height, s.near.data.length], [64, 64, 64 * 64 * 4])
  /** The cell of a place, R, G, B, A: the first row is the south. */
  const cell = (eastKm: number, northKm: number): number[] => {
    const o = (Math.floor((northKm + 160) / 5) * 64 + Math.floor((eastKm + 160) / 5)) * 4
    return [...s.near.data.subarray(o, o + 4)]
  }
  assert.deepEqual(cell(22, -31), [255, 0, 0, 0], 'the cumulus: the lowest band')
  assert.deepEqual(cell(27, -26), [255, 0, 0, 0], 'one cell round')
  assert.deepEqual(cell(17, -36), [255, 0, 0, 0])
  assert.deepEqual(cell(34, -31), [0, 0, 0, 0], 'two cells off')
  assert.deepEqual(cell(22, 31), [0, 0, 0, 0], 'north is not south')
  assert.deepEqual(cell(-80, 60), [0, 0, 255, 0], 'the rain deck, based at 7,000 m: a high band')
  assert.deepEqual(cell(-80, -20), [0, 0, 255, 0], 'cirrus at 9,000 m: the other high band, the same channel')
  assert.deepEqual(cell(-120, -120), [0, 255, 0, 0], 'based at 3,000 m: the second band')
  assert.deepEqual(cell(100, 100), [0, 0, 0, 255], 'the tower')
  assert.deepEqual(cell(0, 0), [0, 0, 0, 0])
  assert.deepEqual(s.wet, [false, false, true, false, true], 'the deck of light rain and the storm')
  assert.deepEqual(survey(buildField([], LAT, LON)).wet, [false, false, false, false, false])
})

// ---- CloudVolume -------------------------------------------------------------------------------------------------------------

const CU = puff(1500, 2500, { eastKm: 6, northKm: 2 })
const RAIN = puff(7000, 8700, { eastKm: -40, northKm: 20, wide: 10_000, sev: SEV.light })
const CB = puff(1000, 11_000, { eastKm: 60, northKm: 60, wide: 9000, tower: 1, sev: SEV.storm })
const HERE = { lat: LAT, lon: LON }
type Uniforms = Record<string, unknown>
interface Image { data: Uint8ClampedArray; width: number; height: number }

function rig(opts: { geoid?: (lat: number, lon: number) => number; onFailed?: () => void } = {}) {
  const added: PostProcessStageComposite[] = []
  const removed: PostProcessStageComposite[] = []
  const stages = { add: (s: PostProcessStageComposite) => (added.push(s), s), remove: (s: PostProcessStageComposite) => (removed.push(s), true) } as unknown as PostProcessStageCollection
  const cameraWC = Cartesian3.fromDegrees(LON + 0.1, LAT + 0.2, 5000)
  const camera = { inverseViewMatrix: Transforms.eastNorthUpToFixedFrame(cameraWC) } as unknown as Camera
  const renderError = new Event() // the scene's: raised when a frame fails
  const vol = new CloudVolume({ postProcessStages: stages, camera, renderError }, opts)
  /** The composites in the scene now. */
  const live = (): PostProcessStageComposite[] => added.filter((s) => !removed.includes(s))
  const stage = (i: number): PostProcessStage => live()[0].get(i) as PostProcessStage
  const call = <T>(i: number, name: string): T => ((stage(i).uniforms as Uniforms)[name] as () => T)()
  return { vol, added, removed, live, stage, call, cameraWC, renderError, march: (): Uniforms => stage(0).uniforms as Uniforms, mix: (): Uniforms => stage(1).uniforms as Uniforms }
}

test('CloudVolume: no stage while hidden, while the field is empty, or once destroyed; shown with weather, one pass in the scene', () => {
  const r = rig()
  const field = (): WxField | null => r.vol.field
  assert.equal(r.vol.show, false)
  assert.equal(field(), null)
  r.vol.draw([CU], HERE)
  assert.equal(r.added.length, 0, 'hidden')
  r.vol.show = true
  assert.equal(r.live().length, 1)
  r.vol.show = true
  assert.equal(r.added.length, 1, 'shown twice is shown once')
  r.vol.show = false
  assert.deepEqual(r.removed, r.added, 'hidden: removed (Cesium destroys it)')
  r.vol.show = true
  assert.deepEqual([r.added.length, r.live().length], [2, 1], 'a new pass')
  r.vol.draw([], HERE)
  assert.equal(r.live().length, 0, 'no weather: no pass')
  assert.equal(field()?.empty, true)
  r.vol.draw([puff(1500, 2500, { eastKm: 400 })], HERE)
  assert.equal(r.live().length, 0, 'weather outside the square: none either')
  r.vol.draw([CU], HERE)
  assert.equal(r.live().length, 1)
  r.vol.destroy()
  assert.equal(r.live().length, 0)
  r.vol.show = true
  r.vol.draw([CU], HERE)
  assert.equal(r.live().length, 0, 'destroyed: does nothing')
  assert.equal(r.vol.show, false)
})

test('CloudVolume: shown before the first draw, the pass comes with the weather', () => {
  const r = rig()
  r.vol.show = true
  assert.equal(r.added.length, 0)
  r.vol.draw([CU], HERE)
  assert.equal(r.live().length, 1)
})

test('CloudVolume: the pass is a composite of two stages on the scene\'s own colour: the march at half the size, and the mix, at full size, which reads the march by its name', () => {
  const r = rig()
  r.vol.show = true
  r.vol.draw([CU], HERE)
  const pass = r.live()[0]
  assert.ok(pass instanceof PostProcessStageComposite)
  assert.equal(pass.length, 2)
  assert.equal(pass.inputPreviousStageTexture, false)
  const [march, mix] = [r.stage(0), r.stage(1)]
  assert.ok(march instanceof PostProcessStage && mix instanceof PostProcessStage)
  assert.equal(march.textureScale, 0.5)
  assert.equal(mix.textureScale, 1)
  assert.equal(march.fragmentShader, MARCH_SHADER)
  assert.equal(mix.fragmentShader, MIX_SHADER)
  assert.equal(r.mix().u_march, march.name)
  assert.notEqual(march.name, mix.name)
})

test('CloudVolume: each draw is a new pass in place of the last (a field given to a pass that runs would be gone for a frame), its stages named anew', () => {
  const r = rig()
  r.vol.show = true
  r.vol.draw([CU], HERE)
  const first = r.live()[0]
  const names = [r.stage(0).name, r.stage(1).name]
  r.vol.draw([CU, RAIN], HERE)
  assert.deepEqual(r.removed, [first])
  assert.equal(r.live().length, 1)
  assert.ok(!names.includes(r.stage(0).name) && !names.includes(r.stage(1).name))
})

test('CloudVolume: each shader is given every uniform it declares, and no other', () => {
  const r = rig()
  r.vol.show = true
  r.vol.draw([CU, RAIN, CB], HERE)
  const declared = (src: string): string[] => [...src.matchAll(/^uniform\s+\w+\s+(\w+)/gm)].map((m) => m[1]).filter((n) => n !== 'colorTexture' && n !== 'depthTexture').sort()
  assert.deepEqual(Object.keys(r.march()).sort(), declared(MARCH_SHADER))
  assert.deepEqual(Object.keys(r.mix()).sort(), declared(MIX_SHADER))
  assert.ok(declared(MARCH_SHADER).length >= 10 && declared(MIX_SHADER).includes('u_march'))
  for (const src of [MARCH_SHADER, MIX_SHADER]) assert.match(src, /uniform\s+sampler2D\s+depthTexture/, 'each reads the depth')
})

test('CloudVolume: draw builds the field round the place and hands its atlas to both stages as it is (bytes, not through a canvas); the noise and the coarse map to the march', () => {
  const r = rig()
  r.vol.show = true
  r.vol.draw([CU, RAIN, CB], HERE)
  const f = r.vol.field!
  assert.deepEqual([f.lat, f.lon, f.empty], [LAT, LON, false])
  assert.ok(sampleField(f, CU.lat, CU.lon, 2000).cover > 0.9, 'the field the HUD asks')
  const want = fieldAtlas(buildField([CU, RAIN, CB], LAT, LON))
  for (const u of [r.march(), r.mix()]) {
    const image = u.u_field as Image
    assert.deepEqual([image.width, image.height], [want.width, want.height])
    assert.deepEqual(image.data, want.data)
  }
  assert.deepEqual((r.march().u_noise as Image).data, noiseAtlas().data)
  assert.deepEqual((r.march().u_near as Image).data, survey(f).near.data)
})

test('CloudVolume: the shader is told each band\'s heights in km (an empty band: none), the floor it is read down to (the sea under a band that rains, else the band\'s lowest base), and the highest top of all', () => {
  const r = rig()
  r.vol.show = true
  r.vol.draw([CU, RAIN, CB], HERE)
  const f = r.vol.field!
  const [lo, hi, floor] = [r.call<number[]>(0, 'u_lo'), r.call<number[]>(0, 'u_hi'), r.call<number[]>(0, 'u_floor')]
  assert.equal(lo.length, BANDS)
  for (let b = 0; b < BANDS; b++) assert.ok(near(lo[b], f.lo[b] / 1000, 1e-12) && near(hi[b], f.hi[b] / 1000, 1e-12), `band ${b}`)
  assert.deepEqual([lo[0], hi[0]], [1.5, 2.5])
  assert.ok(lo[1] > hi[1] && lo[3] > hi[3], 'bands 1 and 3 are empty')
  assert.deepEqual(floor, [1.5, lo[1], 0, lo[3], 0], 'rain falls from the deck (band 2) and the storm')
  assert.deepEqual([r.call<number[]>(1, 'u_lo'), r.call<number[]>(1, 'u_hi')], [lo, hi], 'the mix has the heights too, for the shadows')
  assert.equal(r.call<number>(0, 'u_top'), 11)
  r.vol.draw([CU], HERE)
  assert.equal(r.call<number>(0, 'u_top'), 2.5)
})

test('CloudVolume: the frame is at the field\'s middle at sea level (the geoid there): the camera\'s matrix, the map\'s scale and the noise, which is fixed to the Earth so that a field built round another place has the same detail', () => {
  const r = rig()
  r.vol.show = true
  r.vol.draw([CU], HERE)
  const n0 = geoidN(LAT, LON)
  const frame = localFrame(LAT, LON, n0)
  const m = r.call<Matrix4>(0, 'u_eyeToLocal')
  const eye = Matrix4.multiplyByPoint(m, Cartesian3.ZERO, new Cartesian3())
  assert.ok(Cartesian3.equalsEpsilon(eye, Matrix4.multiplyByPoint(frame, r.cameraWC, new Cartesian3()), 0, 1e-6), `${eye}`)
  assert.ok(near(eye.x, 0.1 * 111.3 * Math.cos((LAT + 0.2) * RAD), 0.1) && near(eye.y, 22.2, 0.1) && near(eye.z, 5 - n0 / 1000 - 0.04, 0.01), `${eye}: 8.8 km east, 22 km north, 5 km up`)
  assert.ok(Matrix4.equalsEpsilon(r.call<Matrix4>(1, 'u_eyeToLocal'), m, 1e-12), 'the mix has it too')
  const s = mapScale(LAT, LON, n0)
  const map = r.call<{ x: number; y: number; z: number }>(0, 'u_map')
  assert.deepEqual([map.x, map.y, map.z], [s.sx, s.sy, s.t])
  // a point of the Earth has the same place in the noise (whole periods of 32 km apart) whichever field's frame it is seen from
  const world = Cartesian3.fromDegrees(LON + 0.3, LAT + 0.1, 4000)
  const inNoise = (): Cartesian3 => {
    const f = r.vol.field!
    const local = Matrix4.multiplyByPoint(localFrame(f.lat, f.lon, geoidN(f.lat, f.lon)), world, new Cartesian3())
    return Matrix4.multiplyByPoint(r.call<Matrix4>(0, 'u_noiseFrame'), local, new Cartesian3())
  }
  const a = inNoise()
  r.vol.draw([CU], at(21, 22))
  const b = inNoise()
  for (const d of [b.x - a.x, b.y - a.y, b.z - a.z]) assert.ok(near(d, Math.round(d), 1e-6), `${d} periods apart`)
  assert.ok(Math.max(...Matrix4.toArray(r.call<Matrix4>(0, 'u_noiseFrame')).map(Math.abs)) <= 1, 'no large number')
})

test('CloudVolume: the look as a number (0 natural, 1 severity colours, 2 blocks), changed on the fly; the light by the Sun\'s night, as the puffs\' was; the ground shadows gone by night', () => {
  const r = rig()
  r.vol.show = true
  r.vol.draw([CU], HERE)
  const look = (): number => r.call<number>(0, 'u_look')
  assert.equal(r.vol.look, 'severity')
  assert.equal(look(), 1)
  r.vol.look = 'natural'
  assert.equal(look(), 0)
  r.vol.look = 'blocks'
  assert.equal(look(), 2)
  const tf = { fSampled: 1, fNow: 1, relHM: 0 }
  assert.equal(r.call<number>(0, 'u_light'), 1)
  assert.equal(r.call<number>(1, 'u_shadow'), 0.5)
  r.vol.frame(tf, 0.5)
  assert.equal(r.call<number>(0, 'u_light'), sunBrightness(0.5))
  assert.equal(r.call<number>(1, 'u_shadow'), 0.25)
  r.vol.frame(tf, 1)
  assert.deepEqual([r.call<number>(0, 'u_light'), r.call<number>(1, 'u_shadow')], [sunBrightness(1), 0])
  r.vol.frame(tf, Number.NaN)
  assert.equal(r.call<number>(0, 'u_light'), 1, 'no night known: day')
  r.vol.draw([CU, RAIN], HERE)
  r.vol.frame({ fSampled: 0, fNow: 0, relHM: 300 }, 0.5)
  assert.deepEqual([look(), r.call<number>(0, 'u_light')], [2, sunBrightness(0.5)], 'a new pass keeps the look and the night')
  assert.deepEqual(r.call<number[]>(1, 'u_lo').slice(0, 1), [1.5], 'the clouds stand at their true heights, whatever the relief drawn')
})

test('CloudVolume: the reach\'s fade is centred on the aircraft: its place on the field\'s map, the field\'s middle until it is given, and again its own place in a field built round another', () => {
  const r = rig()
  r.vol.show = true
  r.vol.draw([CU], HERE)
  const plane = (): [number, number] => {
    const p = r.call<{ x: number; y: number }>(0, 'u_plane')
    return [p.x, p.y]
  }
  assert.deepEqual(plane(), [0, 0])
  const p = at(12, -20)
  r.vol.fade(Cartesian3.fromDegrees(p.lon, p.lat, 9000))
  assert.ok(near(plane()[0], 12, 0.03) && near(plane()[1], -20, 0.03), `${plane()}`)
  assert.deepEqual(r.call<{ x: number; y: number }>(1, 'u_plane'), r.call<{ x: number; y: number }>(0, 'u_plane'))
  r.vol.draw([CU], at(12, -20))
  assert.ok(near(plane()[0], 0, 0.03) && near(plane()[1], 0, 0.03), `${plane()}`)
})

// ---- the hazard areas' edges ---------------------------------------------------------------------------------------------------

type Ring = [number, number][]
const N0 = geoidN(LAT, LON)
const FRAME = localFrame(LAT, LON, N0)
const EDGE_Q = (2 * EDGE_KM) / 65536
const RED = (): string => '#ff5a5a'
/** A ring through places km east and north of the field's middle, closed as GeoJSON closes it. */
const ringKm = (corners: [number, number][]): Ring => {
  const r = corners.map(([e, n]): [number, number] => [at(e, n).lon, at(e, n).lat])
  return [...r, r[0]]
}
/** A ring of n corners on a circle of r km round a place eastKm east of the field's middle. */
const circle = (eastKm: number, r: number, n = 20): Ring => ringKm(Array.from({ length: n }, (_, i): [number, number] => [eastKm + r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)]))
/** The hazard area of these rings, as wxGeo.ts picks it. */
const hazardOf = (rings: Ring[], o: { baseFt?: number | null; topFt?: number } = {}): Hazard =>
  hazardsNear([{ hazard: 'TS', qualifier: 'EMBD', base: o.baseFt ?? null, top: o.topFt ?? 35000, until: '', raw: '', rings }], LAT, LON, 5000)[0]
/** A corner of a ring in the field's frame, at sea level. */
const inFrame = ([lon, lat]: [number, number]): Cartesian3 => Matrix4.multiplyByPoint(FRAME, Cartesian3.fromDegrees(lon, lat, N0), new Cartesian3())
/** Km from a place of the frame to an edge. */
const kmTo = (e: HazardEdge, x = 0, y = 0): number => {
  const [dx, dy] = [e.bx - e.ax, e.by - e.ay]
  const t = Math.min(1, Math.max(0, ((x - e.ax) * dx + (y - e.ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(e.ax + t * dx - x, e.ay + t * dy - y)
}

test('packEdges: the edges as an image of one row, five texels each, two bytes a number (the high byte first); read back as the shader reads it, each is itself to within half its quantum (12.5 m for a place, 25 cm for a height)', () => {
  const edges: HazardEdge[] = [
    { ax: -123.4567, ay: 0.0125, bx: 600.2, by: -819.2, baseKm: 0, topKm: 10.668, rgb: [255, 90, 90], alongKm: 0, first: true, whole: true },
    { ax: 819.17, ay: 12, bx: -0.01, by: 77.7777, baseKm: 5.4864, topKm: 18.288, rgb: [79, 209, 255], alongKm: 3.999, first: false, whole: true },
    { ax: 5000, ay: -5000, bx: 1, by: 2, baseKm: -1, topKm: 99, rgb: [1, 2, 3], alongKm: 1.25, first: true, whole: false },
  ]
  const image = packEdges(edges)
  assert.deepEqual([MAX_EDGES, EDGE_TEXELS, EDGE_KM, EDGE_TOP_KM, POST_KM], [48, 5, 819.2, 32.768, 4])
  assert.deepEqual([image.width, image.height, image.data.length], [240, 1, 960], 'one row: the texture\'s flip (Cesium flips an image it uploads) changes nothing')
  assert.equal(EDGE_Q, 0.025)
  edges.slice(0, 2).forEach((e, k) => {
    const d = unpackEdge(image, k)
    for (const c of ['ax', 'ay', 'bx', 'by'] as const) assert.ok(near(d[c], e[c], EDGE_Q / 2 + 1e-9), `edge ${k} ${c}: ${d[c]} for ${e[c]}`)
    for (const c of ['baseKm', 'topKm'] as const) assert.ok(near(d[c], e[c], EDGE_TOP_KM / 65536 / 2 + 1e-9), `edge ${k} ${c}: ${d[c]} for ${e[c]}`)
    assert.ok(near(d.alongKm, e.alongKm, POST_KM / 65536 / 2 + 1e-9), `edge ${k}: ${d.alongKm} km along`)
    assert.deepEqual([d.rgb, d.first, d.whole], [e.rgb, e.first, e.whole])
  })
  const out = unpackEdge(image, 2) // beyond what the image holds: held at its ends
  assert.ok(near(out.ax, EDGE_KM - EDGE_Q, 1e-9) && near(out.ay, -EDGE_KM, 1e-9) && out.baseKm === 0 && near(out.topKm, EDGE_TOP_KM - EDGE_TOP_KM / 65536, 1e-9), JSON.stringify(out))
  assert.deepEqual([out.rgb, out.first, out.whole], [[1, 2, 3], true, false])
  const v = Math.round((-123.4567 + EDGE_KM) / EDGE_Q)
  assert.deepEqual([image.data[0], image.data[1]], [v >> 8, v & 255], 'the high byte first')
  assert.deepEqual([3, 8, 13].map((texel) => image.data[texel * 4 + 3]), [3, 2, 1], 'the fourth texel\'s alpha: 1 the first edge of its area, 2 the area is whole')
  assert.ok(image.data.subarray(3 * EDGE_TEXELS * 4).every((b) => b === 0), 'nothing after the last edge')
  assert.ok(packEdges([]).data.every((b) => b === 0))
  assert.equal(packEdges(Array.from({ length: 60 }, () => edges[0])).data.length, 960, 'never more than 48')
})

test('hazardEdges: a hazard area\'s ring as walls in the field\'s frame: each corner at its own place (km east and north of the field\'s middle), the area\'s base and top in km and its colour; a ring is closed whether its last corner repeats the first or not', () => {
  const ring = ringKm([[100, 50], [140, 50], [140, 90], [100, 90]])
  const h = hazardOf([ring], { baseFt: 18000, topFt: 35000 })
  const edges = hazardEdges([h], FRAME, N0, RED)
  assert.equal(edges.length, 4)
  edges.forEach((e, i) => {
    const [a, b] = [inFrame(ring[i]), inFrame(ring[i + 1])]
    assert.ok(near(e.ax, a.x, 1e-9) && near(e.ay, a.y, 1e-9) && near(e.bx, b.x, 1e-9) && near(e.by, b.y, 1e-9), `edge ${i}`)
  })
  assert.ok(near(edges[0].ax, 100, 0.6) && near(edges[0].ay, 50.5, 0.3) && near(edges[0].bx, 140, 0.8) && near(edges[0].by, 51.1, 0.3), `${JSON.stringify(edges[0])}: from 100 km east and 50 km north to 140 km east (on a plane that touches the Earth at the field's middle, a parallel bends north: by 0.6 and 1.2 km there)`)
  assert.ok(edges.every((e) => near(e.baseKm, 5.4864, 1e-9) && near(e.topKm, 10.668, 1e-9)), '18,000 and 35,000 ft')
  assert.ok(edges.every((e) => e.rgb.join() === '255,90,90' && e.alongKm === 0 && e.whole))
  assert.deepEqual(edges.map((e) => e.first), [true, false, false, false])
  assert.deepEqual(hazardEdges([{ ...h, rings: [ring.slice(0, 4)] }], FRAME, N0, RED), edges, 'the ring left open')
  const two = hazardEdges([hazardOf([ring, ringKm([[-60, -60], [-40, -60], [-50, -40]])])], FRAME, N0, () => '#4fd1ff')
  assert.deepEqual([two.length, two.filter((e) => e.first).length, two[0].rgb], [7, 1, [79, 209, 255]], 'an area of two rings is one area: its top face is inside either')
  assert.deepEqual(hazardEdges([], FRAME, N0, RED), [])
})

test('hazardEdges: at most 48, the nearest to the aircraft; an area\'s edges stay together, the nearest area first; an area that lost an edge is not whole (its top face cannot be found)', () => {
  const areas = [hazardOf([circle(250, 40)], { topFt: 30000 }), hazardOf([circle(30, 20)], { topFt: 31000 }), hazardOf([circle(120, 30)], { topFt: 32000 })]
  const ft = (e: HazardEdge): number => Math.round(e.topKm / 0.0003048)
  const edges = hazardEdges(areas, FRAME, N0, RED)
  assert.equal(edges.length, 48)
  assert.deepEqual(edges.map(ft), [...Array(20).fill(31000), ...Array(20).fill(32000), ...Array(8).fill(30000)], 'the area the aircraft is in, the one 90 km off, and 8 edges of the one 210 km off')
  assert.deepEqual(edges.map((e) => e.first), edges.map((_, k) => k === 0 || k === 20 || k === 40))
  assert.deepEqual(edges.map((e) => e.whole), edges.map((_, k) => k < 40))
  const far = hazardEdges([areas[0]], FRAME, N0, RED)
  assert.equal(far.length, 20)
  const kept = edges.slice(40)
  const left = far.filter((e) => !kept.some((k) => k.ax === e.ax && k.ay === e.ay))
  assert.equal(left.length, 12)
  assert.ok(Math.max(...kept.map((e) => kmTo(e))) <= Math.min(...left.map((e) => kmTo(e))), 'the 8 kept are its nearest')
  assert.deepEqual(kept, far.filter((e) => kept.some((k) => k.ax === e.ax && k.ay === e.ay)).map((e) => ({ ...e, first: e === far.find((f) => kept.some((k) => k.ax === f.ax && k.ay === f.ay)), whole: false })), 'in the ring\'s own order')
  const from = inFrame([at(250, 0).lon, at(250, 0).lat]) // the aircraft in the far area
  const there = hazardEdges(areas, FRAME, N0, RED, from)
  assert.deepEqual(there.map(ft), [...Array(20).fill(30000), ...Array(20).fill(32000), ...Array(8).fill(31000)], 'nearest to where the aircraft is')
  assert.deepEqual(hazardEdges(areas, FRAME, N0, RED, undefined, 100).length, 60, 'room for all: all, and whole')
  assert.ok(hazardEdges(areas, FRAME, N0, RED, undefined, 100).every((e) => e.whole))
})

test('hazardEdges: an edge that leaves what the image can hold (819 km each way) is cut there, and counts its posts from the corner it began at; one wholly beyond is left out, and so is one with an end past where the frame holds (the Earth has curved away); the area is then not whole', () => {
  const ring = ringKm([[700, -20], [1100, -20], [1100, 20], [700, 20]])
  const edges = hazardEdges([hazardOf([ring])], FRAME, N0, RED)
  const c = ring.map(inFrame)
  assert.ok(c[1].x > 900 && c[2].x > 900 && c[0].x < 819 && c[3].x < 819)
  assert.equal(edges.length, 3, 'the far side is left out')
  const [out, back, near0] = edges
  assert.ok(near(out.ax, c[0].x, 1e-9) && near(out.ay, c[0].y, 1e-9) && near(out.bx, 819, 1e-9), 'cut at 819 km')
  assert.ok(near((out.by - c[0].y) / (c[1].y - c[0].y), (819 - c[0].x) / (c[1].x - c[0].x), 1e-9), 'on the edge')
  assert.equal(out.alongKm, 0)
  assert.ok(near(back.ax, 819, 1e-9) && near(back.bx, c[3].x, 1e-9) && near(back.by, c[3].y, 1e-9))
  const cut = Math.hypot(819 - c[2].x, back.ay - c[2].y) // km from the corner the edge began at to where it is cut
  assert.ok(cut > 50 && near(back.alongKm, cut % POST_KM, 1e-9), `${back.alongKm} km of a post\'s 4 along, ${cut} km from the corner`)
  assert.ok(near(near0.ax, c[3].x, 1e-9) && near(near0.bx, c[0].x, 1e-9) && near0.alongKm === 0)
  assert.deepEqual(edges.map((e) => [e.first, e.whole]), [[true, false], [false, false], [false, false]])
  // a corner 3,000 km off: its two edges are left out (a cut would not be on the edge: the frame folds there)
  const long = ringKm([[100, 0], [3000, 0], [100, 30]])
  assert.ok(inFrame(long[1]).z < -300)
  const kept = hazardEdges([hazardOf([long])], FRAME, N0, RED)
  assert.equal(kept.length, 1)
  assert.ok(near(kept[0].ax, inFrame(long[2]).x, 1e-9) && near(kept[0].bx, inFrame(long[0]).x, 1e-9) && !kept[0].whole)
  // an area whose base and top are one height in the image is no wall
  assert.deepEqual(hazardEdges([{ ...hazardOf([circle(30, 20)]), baseM: 9000, topM: 9000.2 }], FRAME, N0, RED), [])
})

// ---- CloudVolume: the hazard areas, the way ahead, the render error ---------------------------------------------------------------

test('CloudVolume: hazard areas alone keep a pass in the scene: the march is given their edges as an image, how many, and the style as a number (0 curtain, 1 fence, 2 box), which changes on the fly with no new pass; a changed list is a new pass, the same again is not; no area and no cloud: no pass', () => {
  const r = rig()
  const h = hazardOf([ringKm([[100, 50], [140, 50], [140, 90], [100, 90]])], { topFt: 34000 })
  r.vol.show = true
  r.vol.setHazards([h], 'box', RED)
  assert.equal(r.added.length, 0, 'before the first draw there is no frame to lay them in')
  r.vol.draw([], HERE)
  assert.equal(r.live().length, 1, 'no cloud, but a hazard area')
  const edges = (): Image => r.march().u_edges as Image
  assert.deepEqual(edges().data, packEdges(hazardEdges([h], FRAME, N0, RED)).data)
  assert.deepEqual([edges().width, edges().height], [240, 1])
  assert.equal(r.call<number>(0, 'u_edgeCount'), 4)
  assert.equal(r.call<number>(0, 'u_hazard'), 2)
  r.vol.setHazards([h], 'curtain', RED)
  assert.equal(r.call<number>(0, 'u_hazard'), 0)
  r.vol.setHazards([h], 'fence', RED)
  assert.equal(r.call<number>(0, 'u_hazard'), 1)
  assert.equal(r.added.length, 1, 'the style and the same areas again: the pass stands')
  const other = hazardOf([circle(30, 20)], { topFt: 30000 })
  const first = r.live()[0]
  r.vol.setHazards([h, other], 'fence', RED)
  assert.deepEqual([r.added.length, r.removed.length, r.removed[0] === first], [2, 1, true], 'other areas: a new pass (an image given to a pass that runs would be gone for a frame)')
  assert.deepEqual(edges().data, packEdges(hazardEdges([h, other], FRAME, N0, RED)).data)
  assert.deepEqual([r.call<number>(0, 'u_edgeCount'), r.call<number>(0, 'u_hazard')], [24, 1])
  r.vol.setHazards([h, other], 'fence', () => '#4fd1ff')
  assert.equal(r.added.length, 3, 'another colour is another image')
  r.vol.setHazards([], 'fence', RED)
  assert.equal(r.live().length, 0, 'none left, and no cloud')
  r.vol.draw([CU], HERE)
  assert.equal(r.call<number>(0, 'u_edgeCount'), 0)
  assert.ok(edges().data.every((b) => b === 0) && edges().width === 240, 'with cloud and no area the march still has an image to read')
  // a field built round another place: the edges in its frame; the nearest by where the aircraft is
  r.vol.setHazards([h, other], 'curtain', RED)
  const there = at(21, 22)
  r.vol.draw([CU], there)
  const frame = localFrame(there.lat, there.lon, geoidN(there.lat, there.lon))
  assert.deepEqual(edges().data, packEdges(hazardEdges([h, other], frame, geoidN(there.lat, there.lon), RED)).data)
  const many = [hazardOf([circle(250, 40)], { topFt: 30000 }), hazardOf([circle(30, 20)], { topFt: 31000 }), hazardOf([circle(120, 30)], { topFt: 32000 })]
  const ac = at(250, 0)
  r.vol.fade(Cartesian3.fromDegrees(ac.lon, ac.lat, 9000))
  r.vol.setHazards(many, 'curtain', RED)
  const from = Matrix4.multiplyByPoint(frame, Cartesian3.fromDegrees(ac.lon, ac.lat, 9000), new Cartesian3())
  assert.deepEqual(edges().data, packEdges(hazardEdges(many, frame, geoidN(there.lat, there.lon), RED, from)).data, 'the 48 nearest the aircraft, not the field\'s middle')
  assert.equal(r.call<number>(0, 'u_edgeCount'), 48)
  r.vol.show = false
  assert.equal(r.live().length, 0, 'hidden: no pass, whatever it holds')
})

test('CloudVolume: with no cloud the march is given blank images in place of the field, the coarse map and the noise (it reads none of them), and a top under the ground, so that no ray is walked', () => {
  const r = rig()
  r.vol.show = true
  r.vol.setHazards([hazardOf([circle(30, 20)])], 'box', RED)
  r.vol.draw([], HERE)
  for (const name of ['u_field', 'u_near', 'u_noise']) assert.deepEqual([(r.march()[name] as Image).width, (r.march()[name] as Image).data.length], [1, 4], name)
  assert.ok(r.call<number>(0, 'u_top') < -1)
  assert.deepEqual([r.call<number[]>(0, 'u_lo'), r.call<number[]>(0, 'u_hi'), r.call<number[]>(0, 'u_floor')], [[16, 16, 16, 16, 16], [0, 0, 0, 0, 0], [16, 16, 16, 16, 16]], 'every band empty')
  r.vol.draw([CU], HERE)
  assert.equal((r.march().u_noise as Image).width, 528)
  assert.equal(r.call<number>(0, 'u_top'), 2.5)
})

test('CloudVolume: the way ahead is given to the mix, which draws the track line, in the frame (the aircraft, then each minute; its heights are above the sea, so the geoid of each place is added), and its first place to the march, for the level slice; both are told which aids show; an aid alone keeps a pass in the scene, and with none it goes', () => {
  const geoid = (lat: number, lon: number): number => 40 + (lat - LAT) * 10 + (lon - LON) * 5 // not the real one: so that the test sees it used, place by place
  const r = rig({ geoid })
  r.vol.show = true
  r.vol.draw([], HERE)
  assert.equal(r.live().length, 0)
  const path = aheadPath({ lat: LAT + 0.05, lon: LON - 0.1, altM: 9000 }, 70, 420, -1500)!
  assert.equal(path.points.length, AHEAD_MIN + 1)
  r.vol.setAhead(path, { track: true, slice: false })
  assert.equal(r.live().length, 1, 'the track line alone')
  const aids = (): [number, number] => [r.call<{ x: number; y: number }>(0, 'u_aids').x, r.call<{ x: number; y: number }>(0, 'u_aids').y]
  /** The path's points in the frame at a place. */
  const inFrameOf = (lat: number, lon: number): number[] => {
    const frame = localFrame(lat, lon, geoid(lat, lon))
    return path.points.flatMap((p) => { const l = Matrix4.multiplyByPoint(frame, Cartesian3.fromDegrees(p.lon, p.lat, p.altM + geoid(p.lat, p.lon)), new Cartesian3()); return [l.x, l.y, l.z] })
  }
  const got = r.call<number[]>(1, 'u_path')
  assert.equal(got.length, 3 * (AHEAD_MIN + 1))
  const want = inFrameOf(LAT, LON)
  got.forEach((v, i) => assert.ok(near(v, want[i], 1e-9), `number ${i}: ${v} for ${want[i]}`))
  const ac = r.call<{ x: number; y: number; z: number }>(0, 'u_aircraft')
  assert.deepEqual([ac.x, ac.y, ac.z], got.slice(0, 3), 'the march has the aircraft\'s place')
  assert.deepEqual(r.call<{ x: number; y: number }>(1, 'u_aids'), r.call<{ x: number; y: number }>(0, 'u_aids'), 'one word on the aids for both')
  assert.ok(near(got[0], -8.8, 0.1) && near(got[1], 5.56, 0.05) && near(got[2], 9, 0.02), `${got.slice(0, 3)}: the aircraft, 8.8 km west and 5.6 km north of the field\'s middle, 9 km up`)
  assert.ok(near(Math.hypot(got[3] - got[0], got[4] - got[1], got[5] - got[2]), Math.hypot((420 * 1.852) / 60, 0.4572), 0.05), 'a minute on: 13 km along and 457 m down')
  assert.deepEqual(aids(), [1, 0])
  r.vol.setAhead(path, { track: true, slice: true })
  assert.deepEqual(aids(), [1, 1])
  assert.equal(r.added.length, 1, 'given every frame: the pass stands')
  r.vol.setAhead(path, { track: false, slice: false })
  assert.equal(r.live().length, 0, 'no aid: no pass')
  r.vol.setAhead(path, { track: false, slice: true })
  assert.equal(r.live().length, 1, 'the level slice alone')
  assert.deepEqual(aids(), [0, 1])
  r.vol.setAhead(null, { track: true, slice: true })
  assert.equal(r.live().length, 0, 'no way ahead (the aircraft is slow): nothing to draw')
  r.vol.draw([CU], HERE)
  assert.deepEqual(aids(), [0, 0], 'with cloud the pass stands, and draws no aid')
  r.vol.setAhead(path, { track: true, slice: false })
  const there = at(21, 22)
  r.vol.draw([CU], there)
  const moved = inFrameOf(there.lat, there.lon)
  r.call<number[]>(1, 'u_path').forEach((v, i) => assert.ok(near(v, moved[i], 1e-9), `in the frame of a field built round another place: number ${i}`))
  assert.ok(near(r.call<{ x: number }>(0, 'u_aircraft').x, moved[0], 1e-9))
})

test('CloudVolume: each shader is given the reach the radar is read by (REACH_KM), the image\'s numbers and the loops\' bounds as the packing has them; its braces and brackets close', () => {
  assert.deepEqual(REACH_KM, [130, 150])
  assert.ok(MARCH_SHADER.includes('smoothstep(130.0, 150.0, length(m - u_plane))') && MIX_SHADER.includes('smoothstep(130.0, 150.0, length(m - u_plane))'))
  for (const text of ['const float EDGE_KM = 819.2;', 'const float EDGE_Q = 0.025;', `const float HEIGHT_Q = ${EDGE_TOP_KM / 65536};`, `const float ALONG_Q = ${POST_KM / 65536};`, 'const float POST_KM = 4.0;', 'k < 48;', 'int x = k * 5;']) {
    assert.ok(MARCH_SHADER.includes(text), text)
  }
  for (const text of ['uniform float u_path[21];', 'i < 6;']) assert.ok(MIX_SHADER.includes(text) && !MARCH_SHADER.includes(text), `${text}: the track line is the mix's`)
  for (const src of [MARCH_SHADER, MIX_SHADER]) {
    const code = src.replace(/\/\/.*$/gm, '')
    for (const [open, close] of ['{}', '()', '[]']) assert.equal(code.split(open).length, code.split(close).length, `${open}${close}`)
    assert.ok(!/[^\x00-\x7f]/.test(code), 'outside its comments, plain ASCII')
  }
})

test('CloudVolume: a render error while its pass is in the scene takes the pass out for good (a shader another graphics card will not compile must not stop the viewer): told once, the field still built, and no pass again for cloud, hazard area or aid; an error while it has no pass in the scene is not its own', () => {
  const warn = console.warn
  const warned: unknown[][] = []
  console.warn = (...a: unknown[]) => void warned.push(a)
  try {
    let told = 0
    const r = rig({ onFailed: () => told++ })
    r.vol.show = true
    r.renderError.raiseEvent({}, new Error('another part of the scene'))
    assert.deepEqual([r.vol.failed, told, warned.length], [false, 0, 0], 'no pass in the scene yet')
    r.vol.draw([CU], HERE)
    assert.equal(r.live().length, 1)
    r.renderError.raiseEvent({}, new Error('Fragment shader failed to compile'))
    assert.deepEqual([r.vol.failed, told, r.live().length], [true, 1, 0])
    assert.deepEqual(r.removed, r.added, 'removed (Cesium destroys it)')
    assert.equal(warned.length, 1)
    assert.match(String(warned[0][0]), /FlightHopper: .*cloud pass/)
    r.vol.draw([CU, RAIN], HERE)
    r.vol.show = false
    r.vol.show = true
    r.vol.setHazards([hazardOf([circle(30, 20)])], 'curtain', RED)
    r.vol.setAhead(aheadPath({ lat: LAT, lon: LON, altM: 9000 }, 70, 420, 0), { track: true, slice: true })
    assert.deepEqual([r.added.length, r.live().length], [1, 0], 'no pass again')
    assert.ok(sampleField(r.vol.field, RAIN.lat, RAIN.lon, 8000).cover > 0.5, 'the field is still built: the status line and the ahead strip ask it')
    r.renderError.raiseEvent({}, new Error('again'))
    assert.deepEqual([told, warned.length], [1, 1], 'told once')
    const hidden = rig()
    hidden.vol.draw([CU], HERE)
    hidden.renderError.raiseEvent({}, new Error('while it is hidden'))
    hidden.vol.show = true
    assert.deepEqual([hidden.vol.failed, hidden.live().length], [false, 1])
    assert.equal(hidden.renderError.numberOfListeners, 1)
    hidden.vol.destroy()
    assert.equal(hidden.renderError.numberOfListeners, 0, 'destroyed: it listens no more')
    assert.equal(warned.length, 1)
  } finally {
    console.warn = warn
  }
})

test('resumeRendering: after a render error Cesium has stopped its loop and put up its panel: the panel is closed by its own button, and the loop is started again two frames on (by then the loop that ran has seen that it is stopped: one loop, not two); not when the viewer is gone, nor when the loop already runs', () => {
  const queue: (() => void)[] = []
  const later = (f: () => void): void => void queue.push(f)
  const frame = (): void => queue.splice(0).forEach((f) => f())
  const fake = (o: { loop?: boolean; gone?: boolean } = {}) => {
    const s = { loop: o.loop ?? false, sets: 0, clicks: 0, panel: true, gone: o.gone ?? false }
    const viewer = {
      get useDefaultRenderLoop() { return s.loop },
      set useDefaultRenderLoop(on: boolean) { s.loop = on; s.sets++ },
      isDestroyed: () => s.gone,
      container: { querySelector: (q: string) => (q === '.cesium-widget-errorPanel button' && s.panel ? { click: () => { s.clicks++; s.panel = false } } : null) },
    }
    return { s, viewer: viewer as unknown as Parameters<typeof resumeRendering>[0] }
  }
  const a = fake()
  resumeRendering(a.viewer, later)
  assert.deepEqual([a.s.clicks, a.s.panel, a.s.loop], [1, false, false], 'the panel at once; the loop not yet')
  frame()
  assert.equal(a.s.loop, false, 'one frame on: the loop that ran is seeing that it is stopped')
  frame()
  assert.deepEqual([a.s.loop, a.s.sets, queue.length], [true, 1, 0])
  const late = fake() // the panel put up after (Cesium's listener heard the error second)
  late.s.panel = false
  resumeRendering(late.viewer, later)
  late.s.panel = true
  frame()
  frame()
  assert.deepEqual([late.s.clicks, late.s.panel, late.s.loop], [1, false, true])
  const gone = fake()
  resumeRendering(gone.viewer, later)
  gone.s.gone = true
  frame()
  frame()
  assert.deepEqual([gone.s.loop, gone.s.sets], [false, 0], 'the viewer destroyed meanwhile')
  const running = fake({ loop: true })
  resumeRendering(running.viewer, later)
  frame()
  frame()
  assert.equal(running.s.sets, 0, 'it runs: not started again')
})

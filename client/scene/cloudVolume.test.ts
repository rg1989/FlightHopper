// client/scene/cloudVolume.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cartesian3, Matrix4, PostProcessStage, PostProcessStageComposite, Transforms, type Camera, type PostProcessStageCollection } from 'cesium'
import { geoidN } from '../../shared/geoid.ts'
import { PUFF_FILL, SEV, sunBrightness, type CloudSpec } from './cloudField.ts'
import { CloudVolume, MARCH_SHADER, MIX_SHADER, eyeToLocal, localFrame, localToMap, mapScale, noiseAtlas, survey, tileUv } from './cloudVolume.ts'
import { BANDS, FIELD_KM, FIELD_N, HEIGHT_MAX_M, TOWER_BAND, buildField, fieldAtlas, sampleField, type WxField } from './wxField.ts'

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

function rig() {
  const added: PostProcessStageComposite[] = []
  const removed: PostProcessStageComposite[] = []
  const stages = { add: (s: PostProcessStageComposite) => (added.push(s), s), remove: (s: PostProcessStageComposite) => (removed.push(s), true) } as unknown as PostProcessStageCollection
  const cameraWC = Cartesian3.fromDegrees(LON + 0.1, LAT + 0.2, 5000)
  const camera = { inverseViewMatrix: Transforms.eastNorthUpToFixedFrame(cameraWC) } as unknown as Camera
  const vol = new CloudVolume({ postProcessStages: stages, camera })
  /** The composites in the scene now. */
  const live = (): PostProcessStageComposite[] => added.filter((s) => !removed.includes(s))
  const stage = (i: number): PostProcessStage => live()[0].get(i) as PostProcessStage
  const call = <T>(i: number, name: string): T => ((stage(i).uniforms as Uniforms)[name] as () => T)()
  return { vol, added, removed, live, stage, call, cameraWC, march: (): Uniforms => stage(0).uniforms as Uniforms, mix: (): Uniforms => stage(1).uniforms as Uniforms }
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

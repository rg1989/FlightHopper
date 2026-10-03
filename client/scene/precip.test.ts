// client/scene/precip.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cartesian3, Color, JulianDate, Matrix4, Particle, Transforms, type PrimitiveCollection } from 'cesium'
import type { Metar } from '../../shared/wx.ts'
import type { SourceTile } from './radar.ts'
import { LOOKS, Precipitation, cloudBaseM, nearestStation, particleCount, precipFromDbz, precipFromWx, radarPixel, radarSample, windOf } from './precip.ts'

const FT = 0.3048
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol
const metar = (o: Partial<Metar> = {}): Metar => ({
  id: 'LLBG', name: null, lat: 32, lon: 34.9, elevM: 40, obsMs: null, cat: 'VFR', wdir: null, wspd: 0, wgst: null, visKm: 10,
  visPlus: true, tempC: null, dewC: null, qnhHpa: null, wx: null, clouds: [], vertVisFt: null, raw: '', ...o,
})

test('precipFromDbz: nothing under 15 dBZ (RainViewer\'s faintest colour); rain stronger to 45 dBZ, snow to 35', () => {
  assert.equal(precipFromDbz(14, false), null)
  assert.equal(precipFromDbz(-128, false), null, 'no echo')
  assert.deepEqual(precipFromDbz(15, false), { kind: 'rain', intensity: 0 })
  assert.deepEqual(precipFromDbz(30, false), { kind: 'rain', intensity: 0.5 })
  assert.deepEqual(precipFromDbz(45, false), { kind: 'rain', intensity: 1 })
  assert.deepEqual(precipFromDbz(60, false), { kind: 'rain', intensity: 1 })
  assert.deepEqual(precipFromDbz(25, true), { kind: 'snow', intensity: 0.5 })
  assert.deepEqual(precipFromDbz(35, true), { kind: 'snow', intensity: 1 })
  assert.equal(precipFromDbz(Number.NaN, false), null)
})

test('precipFromWx: -RA light, RA moderate, +RA or a thunderstorm with rain heavy; showers as rain; snow; drizzle lighter', () => {
  assert.deepEqual(precipFromWx('-RA'), { kind: 'rain', intensity: 0.25 })
  assert.deepEqual(precipFromWx('RA'), { kind: 'rain', intensity: 0.55 })
  assert.deepEqual(precipFromWx('+RA'), { kind: 'rain', intensity: 1 })
  assert.deepEqual(precipFromWx('TSRA'), { kind: 'rain', intensity: 1 })
  assert.deepEqual(precipFromWx('-TSRA'), { kind: 'rain', intensity: 1 })
  assert.deepEqual(precipFromWx('-SHRA'), { kind: 'rain', intensity: 0.25 })
  assert.deepEqual(precipFromWx('SN'), { kind: 'snow', intensity: 0.55 })
  assert.deepEqual(precipFromWx('-SN BR'), { kind: 'snow', intensity: 0.25 })
  assert.deepEqual(precipFromWx('+SHSN'), { kind: 'snow', intensity: 1 })
  assert.deepEqual(precipFromWx('-RASN'), { kind: 'snow', intensity: 0.25 }, 'rain and snow: the flakes show')
  assert.deepEqual(precipFromWx('DZ'), { kind: 'rain', intensity: 0.275 })
  assert.deepEqual(precipFromWx('FZRA'), { kind: 'rain', intensity: 0.55 })
  assert.deepEqual(precipFromWx('-RA +SHRA'), { kind: 'rain', intensity: 1 }, 'the strongest group')
})

test('precipFromWx: nothing for no weather, a thunderstorm with nothing falling, showers or rain nearby (VC) or recent (RE), fog alone', () => {
  for (const wx of [null, '', 'TS', 'VCSH', 'VCTS', 'RERA', 'BR', 'FG', 'HZ', 'NSW']) assert.equal(precipFromWx(wx), null, String(wx))
})

test('particleCount: rain 1,200 to 3,000 particles by intensity, snow 800 to 2,400', () => {
  assert.equal(particleCount({ kind: 'rain', intensity: 0 }), 1200)
  assert.equal(particleCount({ kind: 'rain', intensity: 0.5 }), 2100)
  assert.equal(particleCount({ kind: 'rain', intensity: 1 }), 3000)
  assert.equal(particleCount({ kind: 'snow', intensity: 0 }), 800)
  assert.equal(particleCount({ kind: 'snow', intensity: 1 }), 2400)
  assert.equal(particleCount({ kind: 'rain', intensity: 7 }), 3000, 'never past 3,000')
})

test('radarPixel: the zoom-7 tile and the pixel in it (Web Mercator, north row first)', () => {
  assert.deepEqual(radarPixel(0, 0), { x: 64, y: 64, px: 0, py: 0 })
  assert.deepEqual(radarPixel(32, 34.9), { x: 76, y: 51, px: 104, py: 250 }) // world pixel 19560.7, 13306.9 of 32,768
  assert.deepEqual(radarPixel(-33.9, -180), { x: 0, y: 76, px: 0, py: 211 })
  assert.deepEqual(radarPixel(89.9, 0), { x: 64, y: 0, px: 0, py: 0 }, 'kept on the map')
  assert.deepEqual(radarPixel(0, 180), radarPixel(0, -180), '180° is −180°')
})

test('radarSample: the strongest echo of the 3 × 3 pixels round the pixel (inside the tile), and whether it is snow', () => {
  const tile: SourceTile = { dbz: new Int8Array(256 * 256).fill(-128), snow: new Uint8Array(256 * 256) }
  assert.equal(radarSample(tile, 10, 10), null, 'no echo')
  tile.dbz[11 * 256 + 9] = 32
  tile.dbz[10 * 256 + 10] = 20
  tile.snow[11 * 256 + 9] = 1
  assert.deepEqual(radarSample(tile, 10, 10), { dbz: 32, snow: true })
  assert.deepEqual(radarSample(tile, 10, 13), null, 'two rows off: out of reach')
  assert.deepEqual(radarSample(tile, 9, 9), { dbz: 20, snow: false }, 'the 32 two rows under it: out of reach')
  tile.dbz[0] = 40
  assert.deepEqual(radarSample(tile, 0, 0), { dbz: 40, snow: false }, 'a corner reads what of its 3 × 3 is in the tile')
  tile.dbz[255 * 256 + 255] = 18
  assert.deepEqual(radarSample(tile, 255, 255), { dbz: 18, snow: false })
})

test('nearestStation: the nearest report within 30 km', () => {
  const a = metar({ id: 'A', lat: 32, lon: 34.9 })
  const b = metar({ id: 'B', lat: 32.1, lon: 34.9 })
  assert.equal(nearestStation([a, b], 32.08, 34.9)?.id, 'B')
  assert.equal(nearestStation([a, b], 31.95, 34.9)?.id, 'A')
  assert.equal(nearestStation([a], 32.28, 34.9), null, '31 km')
  assert.equal(nearestStation([a], 32.26, 34.9)?.id, 'A', '28.9 km')
  assert.equal(nearestStation([], 32, 34.9), null)
})

test('cloudBaseM: the lowest broken, overcast or hidden-sky base above sea level, else the lowest layer\'s; none without a layer or a height', () => {
  assert.equal(cloudBaseM(metar({ clouds: [{ cover: 'FEW', baseFt: 1500, type: null }, { cover: 'BKN', baseFt: 4000, type: null }] })), 40 + 4000 * FT)
  assert.equal(cloudBaseM(metar({ clouds: [{ cover: 'SCT', baseFt: 2500, type: null }, { cover: 'FEW', baseFt: 1800, type: null }] })), 40 + 1800 * FT)
  assert.equal(cloudBaseM(metar({ clouds: [{ cover: 'OVX', baseFt: 300, type: null }], vertVisFt: 300 })), 40 + 300 * FT)
  assert.equal(cloudBaseM(metar({ clouds: [{ cover: 'OVC', baseFt: null, type: null }] })), null)
  assert.equal(cloudBaseM(metar()), null)
  assert.equal(cloudBaseM(metar({ elevM: null, clouds: [{ cover: 'BKN', baseFt: 4000, type: null }] })), null)
})

test('windOf: the surface wind as it blows, metres a second east and north; none when calm, variable or unknown', () => {
  const w = windOf(metar({ wdir: 270, wspd: 10 })) // from the west at 10 kt: blows east
  assert.ok(near(w.east, 5.144, 1e-3) && near(w.north, 0, 1e-9), `${w.east}, ${w.north}`)
  const n = windOf(metar({ wdir: 0, wspd: 20 }))
  assert.ok(near(n.north, -10.289, 1e-3) && near(n.east, 0, 1e-9))
  assert.deepEqual(windOf(metar({ wdir: null, wspd: 6 })), { east: 0, north: 0 })
  assert.deepEqual(windOf(null), { east: 0, north: 0 })
})

// ---- Precipitation -----------------------------------------------------------------------------------------------------

interface FakeSystem {
  options: Record<string, unknown>
  show: boolean
  modelMatrix: Matrix4
  emissionRate: number
  minimumSpeed: number
  maximumSpeed: number
  startColor: Color
  endColor: Color
  times: number[] // the seconds of each update's frameState.time from T0
  destroyed: boolean
  update(fs: { time: JulianDate }): void
  destroy(): void
}
const T0 = JulianDate.fromIso8601('2026-10-03T12:00:00Z')

function precipRig() {
  const added: { update(fs: object): void }[] = []
  const removed: unknown[] = []
  const primitives = { add: (p: { update(fs: object): void }) => (added.push(p), p), remove: (p: unknown) => (removed.push(p), true) } as unknown as PrimitiveCollection
  let now = 1000
  const systems: FakeSystem[] = []
  const makeSystem = (o: Record<string, unknown>): FakeSystem => {
    const s: FakeSystem = {
      options: o, show: (o.show as boolean) ?? true, modelMatrix: Matrix4.clone(o.modelMatrix as Matrix4 ?? Matrix4.IDENTITY), emissionRate: o.emissionRate as number,
      minimumSpeed: o.minimumSpeed as number, maximumSpeed: o.maximumSpeed as number, startColor: o.startColor as Color, endColor: o.endColor as Color,
      times: [], destroyed: false,
      update(fs) { this.times.push(JulianDate.secondsDifference(fs.time, T0)) },
      destroy() { this.destroyed = true },
    }
    systems.push(s)
    return s
  }
  const p = new Precipitation(primitives, { makeSystem: makeSystem as never, image: (k) => `${k}.png`, now: () => now, epoch: T0 })
  const camPos = Cartesian3.fromDegrees(34.9, 32, 800)
  const camDir = Cartesian3.normalize(new Cartesian3(1, 2, -0.5), new Cartesian3())
  const frame = (time = T0, render = true): void => added[0].update({ camera: { positionWC: camPos, directionWC: camDir }, time, frameNumber: 1, passes: { render, pick: !render } })
  return { p, systems, added, removed, frame, camPos, camDir, tick: (ms: number) => void (now += ms) }
}
const CALM = { east: 0, north: 0 }

test('Precipitation: nothing falling makes nothing; rain makes one particle system, its rate keeping the count alive, its images in metres', () => {
  const r = precipRig()
  assert.equal(r.added.length, 1, 'one primitive in the scene, idle until something falls')
  r.p.set(null)
  r.frame()
  assert.equal(r.systems.length, 0)
  r.p.set({ kind: 'rain', intensity: 0.5, wind: CALM, night: 0 })
  assert.equal(r.systems.length, 1)
  const o = r.systems[0].options
  assert.equal(o.emissionRate, particleCount({ kind: 'rain', intensity: 0.5 }) / LOOKS.rain.lifeS)
  assert.equal(o.minimumParticleLife, LOOKS.rain.lifeS)
  assert.equal(o.maximumParticleLife, LOOKS.rain.lifeS)
  assert.equal(o.sizeInMeters, true)
  assert.equal(o.image, 'rain.png')
  assert.ok((o.startColor as Color).equals(new Color(...LOOKS.rain.color)) && (o.endColor as Color).equals(o.startColor as Color), 'one colour all its life: no per-frame colour writes')
})

test('Precipitation: each frame the particles are emitted ahead of the camera, and timed by the wall clock in steps of at most 0.1 s', () => {
  const r = precipRig()
  r.p.set({ kind: 'rain', intensity: 0.5, wind: CALM, night: 0 })
  const s = r.systems[0]
  r.frame()
  const ahead = Cartesian3.add(r.camPos, Cartesian3.multiplyByScalar(r.camDir, LOOKS.rain.aheadM, new Cartesian3()), new Cartesian3())
  assert.ok(Cartesian3.equalsEpsilon(Matrix4.getTranslation(s.modelMatrix, new Cartesian3()), ahead, 0, 1e-6))
  r.tick(16)
  r.frame() // the scene's clock stands still (a fixed ?sun=): the particles' does not
  r.tick(5000) // a stalled tab
  r.frame()
  r.tick(-50) // a clock that went back
  r.frame()
  assert.deepEqual(s.times.map((t) => Math.round(t * 1000)), [0, 16, 116, 116])
  r.tick(16)
  r.frame(T0, false) // a pick (Cesium updates the primitives again for it): rain must not catch the clicks, nor take time
  assert.equal(s.times.length, 4)
})

test('Precipitation: they fall along their terminal speed plus the wind, emitted through the shell round the emitter', () => {
  const r = precipRig()
  r.p.set({ kind: 'rain', intensity: 0.5, wind: { east: 6, north: 0 }, night: 0 })
  r.frame()
  const s = r.systems[0]
  const fall = 8 // 7 to 9 m/s by intensity
  const speed = Math.hypot(fall, 6)
  assert.ok(near(s.minimumSpeed, speed * 0.9, 1e-9) && near(s.maximumSpeed, speed * 1.1, 1e-9), `${s.minimumSpeed}–${s.maximumSpeed}`)
  const enu = Transforms.eastNorthUpToFixedFrame(r.camPos)
  const east = Matrix4.multiplyByPointAsVector(enu, Cartesian3.UNIT_X, new Cartesian3())
  const up = Matrix4.multiplyByPointAsVector(enu, Cartesian3.UNIT_Z, new Cartesian3())
  const want = Cartesian3.normalize(Cartesian3.add(Cartesian3.multiplyByScalar(east, 6, new Cartesian3()), Cartesian3.multiplyByScalar(up, -fall, new Cartesian3()), new Cartesian3()), new Cartesian3())
  const emitter = s.options.emitter as { emit(p: Particle): void }
  for (let i = 0; i < 200; i++) {
    const particle = new Particle({})
    emitter.emit(particle)
    const d = Cartesian3.magnitude(particle.position)
    assert.ok(d >= LOOKS.rain.radiusM[0] - 1e-9 && d <= LOOKS.rain.radiusM[1] + 1e-9, `${d} m from the emitter`)
    assert.ok(Cartesian3.equalsEpsilon(particle.velocity, want, 0, 1e-9))
  }
})

test('Precipitation: harder rain raises the rate in place; snow makes a new system (the old destroyed); the night dims the colour; nothing falling hides it, unupdated', () => {
  const r = precipRig()
  r.p.set({ kind: 'rain', intensity: 0, wind: CALM, night: 0 })
  r.p.set({ kind: 'rain', intensity: 1, wind: CALM, night: 1 })
  assert.equal(r.systems.length, 1)
  assert.equal(r.systems[0].emissionRate, 3000 / LOOKS.rain.lifeS)
  const c = r.systems[0].startColor
  assert.ok(near(c.red, LOOKS.rain.color[0] * 0.2, 1e-9) && near(c.alpha, LOOKS.rain.color[3], 1e-9), `${c}`)
  r.p.set({ kind: 'snow', intensity: 0.5, wind: CALM, night: 0 })
  assert.equal(r.systems.length, 2)
  assert.equal(r.systems[0].destroyed, true)
  assert.equal(r.systems[1].options.image, 'snow.png')
  r.frame()
  r.p.set(null)
  assert.equal(r.systems[1].show, false)
  r.tick(16)
  r.frame()
  assert.equal(r.systems[1].times.length, 1, 'not updated while nothing falls')
  r.p.set({ kind: 'snow', intensity: 0.5, wind: CALM, night: 0 })
  r.tick(3000)
  r.frame()
  assert.deepEqual(r.systems[1].times.length, 2)
  assert.equal(r.systems[1].times[1], r.systems[1].times[0], 'back on: its clock starts again from where it was')
  r.p.destroy()
  assert.deepEqual(r.removed, [r.added[0]])
  assert.equal(r.systems[1].destroyed, true)
})

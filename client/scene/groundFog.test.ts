// client/scene/groundFog.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cartesian3, Cartographic, PostProcessStage, type Camera, type PostProcessStageCollection } from 'cesium'
import { geoidN } from '../../shared/geoid.ts'
import type { Metar } from '../../shared/wx.ts'
import { FOG_KM, GroundFog, fogColor, fogNear, fogSigma, fogWeight, layerSpan, type Fog } from './groundFog.ts'

const R = 6_371_000
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol
const metar = (o: Partial<Metar> = {}): Metar => ({
  id: 'EGLL', name: null, lat: 51.47, lon: -0.45, elevM: 25, obsMs: null, cat: 'VFR', wdir: null, wspd: 0, wgst: null, visKm: 10,
  visPlus: true, tempC: null, dewC: null, qnhHpa: null, wx: null, clouds: [], vertVisFt: null, raw: '', ...o,
})
/** A place kmEast of the station, on its parallel. */
const east = (m: Metar, kmEast: number): { lat: number; lon: number } => ({ lat: m.lat, lon: m.lon + kmEast / (111.195 * Math.cos((m.lat * Math.PI) / 180)) })

test('fogSigma: 3.912 over the visibility (Koschmieder: contrast down to 2 % at the visibility)', () => {
  assert.ok(near(fogSigma(1000), 0.003912, 1e-12))
  assert.ok(near(fogSigma(200), 0.01956, 1e-12))
  assert.ok(near(1 - Math.exp(-fogSigma(3000) * 3000), 0.98, 1e-5), 'at the visibility, 98 % fog (3.912 is −ln 0.02 rounded)')
  assert.equal(fogSigma(0), fogSigma(1), 'at least a metre')
  assert.equal(fogSigma(Number.NaN), 0)
})

test('layerSpan: in the layer, a level ray runs to what it hits, or to where the curved layer\'s top drops under it', () => {
  assert.deepEqual(layerSpan(R + 100, 200, 0, 5000), [0, 5000])
  const [t0, t1] = layerSpan(R + 100, 200, 0, Infinity)
  assert.equal(t0, 0)
  assert.ok(near(t1, Math.sqrt(200 * (2 * (R + 100) + 200)), 1e-6), `${t1} m: about 50.5 km`)
})

test('layerSpan: straight up from inside leaves at the top; straight down from above enters at the top and runs to the ground', () => {
  const up = layerSpan(R + 100, 200, 1, Infinity)
  assert.ok(near(up[0], 0, 1e-9) && near(up[1], 200, 1e-6), `${up}`)
  const down = layerSpan(R + 1000, -700, -1, 1000)
  assert.ok(near(down[0], 700, 1e-6) && near(down[1], 1000, 1e-9), `${down}`)
})

test('layerSpan: from above, a ray looking up, one that hits a hill above the layer, or one that passes over the layer\'s curve misses it', () => {
  const empty = (s: [number, number]): boolean => !(s[1] > s[0])
  assert.ok(empty(layerSpan(R + 1000, -700, 0.5, Infinity)), 'up')
  assert.ok(empty(layerSpan(R + 1000, -700, -1, 500)), 'a hill 500 m below the camera, 200 m above the layer')
  assert.ok(empty(layerSpan(R + 1000, -700, -0.001, Infinity)), 'grazing: over the curve')
  assert.ok(!empty(layerSpan(R + 1000, -700, -0.05, Infinity)), 'steeper: it goes in')
})

test('layerSpan: a slant ray down from above enters where its height reaches the top, the Earth curving away under it', () => {
  const mu = -Math.sin((10 * Math.PI) / 180)
  const [t0] = layerSpan(R + 2000, -1500, mu, Infinity)
  const height = (t: number): number => Math.sqrt((R + 2000) ** 2 + 2 * t * (R + 2000) * mu + t * t) - R
  assert.ok(near(height(t0), 500, 1e-3), `${height(t0)} m at the entry`)
})

test('fogWeight: full within 10 km of the station, thinning to nothing at 40 km', () => {
  assert.equal(fogWeight(0), 1)
  assert.equal(fogWeight(10), 1)
  assert.ok(near(fogWeight(25), 0.5, 1e-12))
  assert.equal(fogWeight(FOG_KM), 0)
  assert.equal(fogWeight(100), 0)
})

test('fogNear: fog round a station that sees less than 8 km or reports fog, mist, haze, smoke or dust; the top by the word', () => {
  const at = { lat: 51.47, lon: -0.45 }
  const cases: [Partial<Metar>, number, number][] = [
    [{ wx: 'FG', visKm: 0.2, visPlus: false }, 300, 200],
    [{ wx: 'BR', visKm: 3, visPlus: false }, 800, 3000],
    [{ wx: 'HZ', visKm: 6, visPlus: false }, 1500, 6000],
    [{ wx: 'FU', visKm: 5, visPlus: false }, 1500, 5000],
    [{ wx: 'DU', visKm: 4, visPlus: false }, 1500, 4000],
    [{ wx: '-RA BR', visKm: 4, visPlus: false }, 800, 4000],
    [{ wx: '-SN', visKm: 2, visPlus: false }, 1500, 2000], // no word for the murk: as haze
    [{ wx: 'FG', visKm: null }, 300, 500], // fog with no visibility given: 500 m (an estimate)
    [{ wx: 'MIFG', visKm: 9, visPlus: true }, 30, 9000], // shallow fog
  ]
  for (const [o, top, vis] of cases) {
    const f = fogNear([metar({ elevM: 120, ...o })], at.lat, at.lon)
    assert.ok(f !== null, JSON.stringify(o))
    assert.equal(f.topM, 120 + top, JSON.stringify(o))
    assert.equal(f.groundM, 120)
    assert.ok(near(f.sigma, 3.912 / vis, 1e-12), `${JSON.stringify(o)}: ${f.sigma}`)
    assert.deepEqual([f.lat, f.lon], [51.47, -0.45])
  }
  assert.ok(near(fogNear([metar({ wx: 'BCFG', visKm: 0.4, visPlus: false })], at.lat, at.lon)!.sigma, 3.912 / 400 / 2, 1e-12), 'patches: half as thick')
})

test('fogNear: none for a clear station, fog only nearby (VC), recent fog (RE), an unknown station height, or beyond 40 km', () => {
  const at = { lat: 51.47, lon: -0.45 }
  assert.equal(fogNear([metar()], at.lat, at.lon), null)
  assert.equal(fogNear([metar({ visKm: 9, visPlus: false, wx: '-RA' })], at.lat, at.lon), null, '9 km of light rain')
  assert.equal(fogNear([metar({ wx: 'VCFG' })], at.lat, at.lon), null)
  assert.equal(fogNear([metar({ wx: 'REFG' })], at.lat, at.lon), null)
  assert.equal(fogNear([metar({ wx: 'FG', visKm: 0.1, visPlus: false, elevM: null })], at.lat, at.lon), null)
  const m = metar({ wx: 'FG', visKm: 0.1, visPlus: false })
  assert.equal(fogNear([m], east(m, FOG_KM + 0.5).lat, east(m, FOG_KM + 0.5).lon), null)
  assert.ok(fogNear([m], east(m, FOG_KM - 0.5).lat, east(m, FOG_KM - 0.5).lon) !== null)
  assert.equal(fogNear([], at.lat, at.lon), null)
})

test('fogNear: the whole fog fades out as the aircraft goes from 25 to 40 km from the station; the strongest station near it wins', () => {
  const m = metar({ wx: 'FG', visKm: 0.2, visPlus: false })
  const fadeAt = (km: number): number => fogNear([m], east(m, km).lat, east(m, km).lon)!.fade
  assert.equal(fadeAt(0), 1)
  assert.equal(fadeAt(25), 1)
  assert.ok(near(fadeAt(32.5), 0.5, 1e-3))
  assert.ok(fadeAt(39.9) < 0.01)
  const mist = metar({ id: 'A', wx: 'BR', visKm: 3, visPlus: false })
  const fog = metar({ id: 'B', lat: 51.47, lon: east(m, 30).lon, wx: 'FG', visKm: 0.2, visPlus: false })
  assert.equal(fogNear([mist, fog], m.lat, m.lon)?.topM, 25 + 300, 'dense fog 30 km off over thin mist here: 0.0196 × 0.26 against 0.0013 × 1')
  const thin = metar({ id: 'C', lat: 51.47, lon: east(m, 30).lon, wx: 'HZ', visKm: 7, visPlus: false })
  assert.equal(fogNear([mist, thin], m.lat, m.lon)?.topM, 25 + 800, 'mist here over haze 30 km off')
  const edge = metar({ id: 'D', lat: 51.47, lon: east(m, 38).lon, wx: 'FG', visKm: 0.2, visPlus: false })
  assert.equal(fogNear([mist, edge], m.lat, m.lon)?.topM, 25 + 800, 'mist here over dense fog at 38 km: 0.0013 × 1 against 0.0196 × 0.013')
})

test('fogColor: a pale haze by day (grey-white fog, bluish haze, brownish smoke, tan dust), dark at night', () => {
  const day = (wx: string): [number, number, number] => fogColor(fogNear([metar({ wx, visKm: 2, visPlus: false })], 51.47, -0.45)!.day, 0)
  const [fg, hz, fu, du] = ['FG', 'HZ', 'FU', 'DU'].map(day)
  for (const c of [fg, hz, fu, du]) assert.ok(Math.min(...c) > 0.45 && Math.max(...c) <= 1, `${c}`)
  assert.ok(hz[2] > hz[0], 'haze bluish')
  assert.ok(fu[0] > fu[2] && du[0] > du[2] && du[0] - du[2] > fu[0] - fu[2], 'smoke brownish, dust more so')
  const night = fogColor(fg, 1)
  assert.ok(Math.max(...night) < 0.1, `${night}`)
  const dusk = fogColor(fg, 0.5)
  assert.ok(dusk[0] < fg[0] && dusk[0] > night[0])
})

// ---- GroundFog ---------------------------------------------------------------------------------------------------------

const FOG: Fog = { lat: 51.47, lon: -0.45, groundM: 25, topM: 325, sigma: 0.0196, fade: 0.5, day: [0.8, 0.82, 0.84] }

function fogRig() {
  const added: PostProcessStage[] = []
  const removed: PostProcessStage[] = []
  const stages = { add: (s: PostProcessStage) => (added.push(s), s), remove: (s: PostProcessStage) => (removed.push(s), true) } as unknown as PostProcessStageCollection
  const camera = { positionWC: Cartesian3.fromDegrees(-0.4, 51.5, 900), positionCartographic: Cartographic.fromDegrees(-0.4, 51.5, 900) } as unknown as Camera
  const fog = new GroundFog({ postProcessStages: stages, camera })
  type Uniforms = Record<string, () => unknown>
  return { fog, added, removed, camera, u: (): Uniforms => added.at(-1)!.uniforms as Uniforms }
}

test('GroundFog: no stage without fog; one stage while there is fog, whatever comes; removed when it clears (Cesium destroys it), a new one next time', () => {
  const r = fogRig()
  r.fog.set(null)
  assert.equal(r.added.length, 0)
  r.fog.set(FOG)
  r.fog.set({ ...FOG, sigma: 0.01 })
  assert.equal(r.added.length, 1)
  assert.ok(r.added[0] instanceof PostProcessStage)
  r.fog.set(null)
  assert.deepEqual(r.removed, [r.added[0]])
  r.fog.set(null)
  assert.equal(r.removed.length, 1)
  r.fog.set(FOG)
  assert.equal(r.added.length, 2)
  r.fog.destroy()
  assert.deepEqual(r.removed, r.added)
  r.fog.set(FOG)
  assert.equal(r.added.length, 2, 'destroyed: does nothing')
})

test('GroundFog: the shader is given the camera\'s distance from the Earth\'s centre, the top less its height, σ × fade, the station from it, the colour', () => {
  const r = fogRig()
  r.fog.set(FOG)
  const n = geoidN(FOG.lat, FOG.lon)
  const u = r.u()
  assert.ok(near(u.u_rho() as number, Cartesian3.magnitude(r.camera.positionWC), 1e-6))
  assert.ok(near(u.u_delta() as number, 325 + n - 900, 1e-6), 'top above the ellipsoid less the camera\'s 900 m')
  assert.ok(near(u.u_sigma() as number, 0.0196 * 0.5, 1e-12))
  const station = Cartesian3.fromDegrees(FOG.lon, FOG.lat, 25 + n)
  assert.ok(Cartesian3.equalsEpsilon(u.u_station() as Cartesian3, Cartesian3.subtract(station, r.camera.positionWC, new Cartesian3()), 0, 1e-6))
  assert.deepEqual(Cartesian3.pack(u.u_color() as Cartesian3, []), [0.8, 0.82, 0.84])
  for (const name of Object.keys(u)) assert.match(r.added[0].fragmentShader, new RegExp(`uniform\\s+\\w+\\s+${name}\\b`), `the shader declares ${name}`)
})

test('GroundFog: frame moves the top with the station\'s ground as the relief is drawn, and darkens the colour by night', () => {
  const r = fogRig()
  r.fog.set(FOG)
  const n = geoidN(FOG.lat, FOG.lon)
  r.fog.frame({ fSampled: 0, fNow: 0, relHM: 100 }, 0)
  assert.ok(near(r.u().u_delta() as number, 100 + 300 - 900, 1e-6), 'flat at 100 m: the top 300 m above it')
  r.fog.frame({ fSampled: 1, fNow: 1, relHM: 100 }, 1)
  assert.ok(near(r.u().u_delta() as number, 325 + n - 900, 1e-6))
  assert.deepEqual(Cartesian3.pack(r.u().u_color() as Cartesian3, []), fogColor(FOG.day, 1))
  r.fog.set(null)
  r.fog.frame({ fSampled: 0, fNow: 0, relHM: 0 }, 0)
  r.fog.set(FOG)
  assert.deepEqual(Cartesian3.pack(r.u().u_color() as Cartesian3, []), fogColor(FOG.day, 0), 'a new stage is tinted for the last night given')
  assert.ok(near(r.u().u_delta() as number, 0 + 300 - 900, 1e-6), 'and placed for the last relief')
})

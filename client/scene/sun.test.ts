// client/scene/sun.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cartesian3, Clock, Color, DirectionalLight, DynamicAtmosphereLightingType, ImageBasedLighting, JulianDate } from 'cesium'
import type { ImageryLayer, Model, Viewer } from 'cesium'
import { makeNightLayer } from './nightLights.ts'
import { Sun, aimLight, lightsFactor, parseSunParam, sunDirectionWC, sunElevationDeg, sunLook, sunTimeMs } from './sun.ts'

// Cesium asks for its IAU 2006 XYS table the first time the ICRF frame is needed. Without CESIUM_BASE_URL (Node) that is
// a file: URL next to the engine, so the TEME fallback is used. Record every request and refuse it: no network here.
const fetched: string[] = []
globalThis.fetch = ((url: string) => (fetched.push(String(url)), Promise.reject(new Error('offline')))) as typeof fetch

const DEG = Math.PI / 180
const LOWI = { lat: 47.2602, lon: 11.3439 }
const KSFO = { lat: 37.6189, lon: -122.375 }
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${msg} got ${a}, expected ${b} ± ${tol}`)
const jdOf = (iso: string): JulianDate => JulianDate.fromIso8601(iso)
const at = (p: { lat: number; lon: number }, hM = 0): Cartesian3 => Cartesian3.fromDegrees(p.lon, p.lat, hM)

/** East, north, up unit vectors at a geodetic lat/lon: our own formulas, not Cesium's ENU. */
function enu(p: { lat: number; lon: number }): [Cartesian3, Cartesian3, Cartesian3] {
  const [f, l] = [p.lat * DEG, p.lon * DEG]
  return [
    new Cartesian3(-Math.sin(l), Math.cos(l), 0),
    new Cartesian3(-Math.sin(f) * Math.cos(l), -Math.sin(f) * Math.sin(l), Math.cos(f)),
    new Cartesian3(Math.cos(f) * Math.cos(l), Math.cos(f) * Math.sin(l), Math.sin(f)),
  ]
}
/** Elevation and azimuth (degrees, azimuth clockwise from north) of a world direction seen from p. */
function elAz(v: Cartesian3, p: { lat: number; lon: number }): { el: number; az: number } {
  const [e, n, u] = enu(p)
  const w = Cartesian3.normalize(v, new Cartesian3())
  return { el: Math.asin(Cartesian3.dot(w, u)) / DEG, az: (Math.atan2(Cartesian3.dot(w, e), Cartesian3.dot(w, n)) / DEG + 360) % 360 }
}
/** Unit world direction at elevation/azimuth seen from p. */
function dirAt(elDeg: number, azDeg: number, p: { lat: number; lon: number }): Cartesian3 {
  const [e, n, u] = enu(p)
  const h = Math.cos(elDeg * DEG)
  const v = new Cartesian3()
  Cartesian3.add(Cartesian3.multiplyByScalar(e, h * Math.sin(azDeg * DEG), new Cartesian3()), Cartesian3.multiplyByScalar(n, h * Math.cos(azDeg * DEG), new Cartesian3()), v)
  return Cartesian3.add(v, Cartesian3.multiplyByScalar(u, Math.sin(elDeg * DEG), new Cartesian3()), v)
}

// ---------- ephemeris ----------

test('sunDirectionWC: unit vector; elevations match the reference (LOWI 2026-09-22 05, 10, 19 Z; KSFO 19 Z)', () => {
  // Research C21 (Cesium's own functions). Node uses TEME, the browser ICRF once Cesium's XYS table loads: 0.37° apart.
  const cases: [string, { lat: number; lon: number }, number][] = [
    ['2026-09-22T05:00:00Z', LOWI, -0.7],
    ['2026-09-22T10:00:00Z', LOWI, 41.0],
    ['2026-09-22T19:00:00Z', LOWI, -18.7],
    ['2026-09-22T19:00:00Z', KSFO, 50.1],
  ]
  for (const [iso, p, el] of cases) {
    const r = new Cartesian3()
    assert.equal(sunDirectionWC(jdOf(iso), r), r)
    near(Cartesian3.magnitude(r), 1, 1e-12, 'length')
    near(elAz(r, p).el, el, 0.5, `${iso} elevation`)
  }
  near(elAz(sunDirectionWC(jdOf('2026-09-22T10:00:00Z'), new Cartesian3()), LOWI).az, 158, 1, 'LOWI 10:00Z azimuth (SSE)')
})

test('sunElevationDeg: +90 overhead, −90 underfoot, 0 on the horizon, and the ENU elevation of the real sun', () => {
  const [e, , u] = enu(LOWI)
  const p = at(LOWI)
  near(sunElevationDeg(u, p), 90, 1e-6)
  near(sunElevationDeg(Cartesian3.negate(u, new Cartesian3()), p), -90, 1e-6)
  near(sunElevationDeg(e, p), 0, 1e-9)
  near(sunElevationDeg(dirAt(12.5, 250, KSFO), at(KSFO)), 12.5, 1e-9)
  const sun = sunDirectionWC(jdOf('2026-09-22T10:00:00Z'), new Cartesian3())
  near(sunElevationDeg(sun, p), elAz(sun, LOWI).el, 1e-9)
})

// ---------- the look (design §4) ----------

const LOOKS: [number, Record<string, number>][] = [
  [45, { night: 0, golden: 0, intensity: 2, red: 1, green: 1, blue: 1, vertexShadowDarkness: 0.3, dayBrightness: 0.9999, nightAlpha: 0, iblFactor: 1 }],
  // golden01(4°) = smoothstep(11/15) = 0.824593
  [4, { night: 0, golden: 0.824593, intensity: 2, red: 1, green: 0.835081, blue: 0.686655, vertexShadowDarkness: 0.464919, dayBrightness: 0.9999, nightAlpha: 0, iblFactor: 1 }],
  [-3, { night: 0.5, golden: 0.5, intensity: 1.225, red: 1, green: 0.9, blue: 0.81, vertexShadowDarkness: 0.4, dayBrightness: 0.65, nightAlpha: 0.5, iblFactor: 0.575 }],
  [-15, { night: 1, golden: 0, intensity: 0.45, red: 1, green: 1, blue: 1, vertexShadowDarkness: 0.3, dayBrightness: 0.3, nightAlpha: 0.9999, iblFactor: 0.15 }],
]

test('sunLook at +45° (day), +4° (golden hour), −3° (dusk), −15° (night)', () => {
  for (const [el, want] of LOOKS) {
    const look = sunLook(el) as unknown as Record<string, number>
    assert.deepEqual(Object.keys(look).sort(), Object.keys(want).sort())
    for (const k of Object.keys(want)) near(look[k], want[k], 1e-6, `${el}° ${k}`)
  }
})

test('sunLook over every elevation: monotonic night, day brightness and night alpha never 1, image-based light never 0, all finite', () => {
  const r = sunLook(0)
  assert.equal(sunLook(10, r), r) // writes into result
  let prevNight = 0
  for (let el = 90; el >= -90; el -= 0.25) {
    const l = sunLook(el, r)
    assert.ok(l.night >= prevNight, `night falls at ${el}°`)
    prevNight = l.night
    assert.ok(l.dayBrightness < 1, `${el}°: brightness 1 would switch off APPLY_BRIGHTNESS`)
    assert.ok(l.nightAlpha < 1, `${el}°: night alpha 1 would switch off APPLY_ALPHA`)
    assert.ok(l.iblFactor >= 0.15, `${el}°: an IBL factor of 0 regenerates the model's shaders`)
    assert.ok(l.golden >= 0 && l.golden <= 1 && l.intensity >= 0.45 - 1e-12 && l.intensity <= 2)
  }
  for (const v of Object.values(sunLook(Number.NaN))) assert.ok(Number.isFinite(v))
  assert.equal(sunLook(Number.NaN).night, 0) // a broken sun time looks like day, never NaN in a Cesium setter
})

test('aimLight: straight from a sun above 2°; straight down at full night', () => {
  const [, , up] = enu(LOWI)
  const sun = dirAt(30, 140, LOWI)
  const r = new Cartesian3()
  assert.equal(aimLight(sun, up, 0, r), r)
  assert.ok(Cartesian3.equalsEpsilon(r, Cartesian3.negate(sun, new Cartesian3()), 1e-12), `${r}`)
  assert.ok(Cartesian3.equalsEpsilon(aimLight(sun, up, 1, r), Cartesian3.negate(up, new Cartesian3()), 1e-12))
  // The antisolar point (sun straight underfoot) is full night: light from overhead, no zero-length vector.
  assert.ok(Cartesian3.equalsEpsilon(aimLight(Cartesian3.negate(up, new Cartesian3()), up, 1, r), Cartesian3.negate(up, new Cartesian3()), 1e-12))
})

test('aimLight never comes from below 2°: a low or set sun is raised to 2° on its own azimuth, then blended up by night', () => {
  const r = new Cartesian3()
  const minUp = Math.sin(2 * DEG)
  for (const p of [LOWI, KSFO, { lat: -33.9, lon: 151.2 }]) {
    const [, , up] = enu(p)
    for (let el = -89; el <= 89; el += 1) {
      for (const az of [0, 95, 200, 333]) {
        const sun = dirAt(el, az, p)
        for (const night of [0, 0.3, 0.7, 1]) {
          aimLight(sun, up, night, r)
          near(Cartesian3.magnitude(r), 1, 1e-12, 'unit')
          assert.ok(-Cartesian3.dot(r, up) >= minUp - 1e-12, `sun ${el}° az ${az} night ${night}: light from ${-Cartesian3.dot(r, up)}`)
          const from = elAz(Cartesian3.negate(r, new Cartesian3()), p)
          if (night < 1) near(((from.az - az + 540) % 360) - 180, 0, 1e-6, 'azimuth kept')
          if (night === 0) near(from.el, Math.max(el, 2), 1e-9, 'elevation')
        }
      }
    }
  }
})

// ---------- ?sun= and the sun time ----------

test('parseSunParam: a fixed ISO time (zone optional, UTC by default) or an offset in h / m; anything else is none', () => {
  const none = { fixedMs: null, offsetMs: 0 }
  assert.deepEqual(parseSunParam('?sun=2026-06-21T06:30:00Z'), { fixedMs: Date.UTC(2026, 5, 21, 6, 30), offsetMs: 0 })
  assert.deepEqual(parseSunParam('?hex=abc123&sun=2026-06-21T06:30Z'), { fixedMs: Date.UTC(2026, 5, 21, 6, 30), offsetMs: 0 })
  assert.deepEqual(parseSunParam('?sun=2026-06-21T06:30:00'), { fixedMs: Date.UTC(2026, 5, 21, 6, 30), offsetMs: 0 })
  // A '+' typed into a URL arrives as a space (URLSearchParams); %2B is a real '+'.
  assert.deepEqual(parseSunParam('?sun=2026-06-21T08:30:00+02:00'), { fixedMs: Date.UTC(2026, 5, 21, 6, 30), offsetMs: 0 })
  assert.deepEqual(parseSunParam('?sun=+6h'), { fixedMs: null, offsetMs: 6 * 3_600_000 })
  assert.deepEqual(parseSunParam('?sun=%2B6h'), { fixedMs: null, offsetMs: 6 * 3_600_000 })
  assert.deepEqual(parseSunParam('?sun=-2h'), { fixedMs: null, offsetMs: -2 * 3_600_000 })
  assert.deepEqual(parseSunParam('?sun=+30m'), { fixedMs: null, offsetMs: 30 * 60_000 })
  for (const bad of ['', '?sun=', '?sun=noon', '?sun=6h', '?sun=+6', '?sun=+6d', '?sun=1', '?sun=2026-13-45T00:00Z', '?sun=2026-06-21', '?light=0']) {
    assert.deepEqual(parseSunParam(bad), none, bad)
  }
})

test('sunTimeMs: render time on the recording clock (D12), then the offset; a fixed time wins', () => {
  const t = Date.UTC(2026, 8, 22, 10)
  assert.equal(sunTimeMs(t, { fixedMs: null, offsetMs: 0 }), t)
  assert.equal(sunTimeMs(t, { fixedMs: null, offsetMs: 0 }, 3 * 86_400_000), t - 3 * 86_400_000) // replay served 3 days later
  assert.equal(sunTimeMs(t, { fixedMs: null, offsetMs: 6 * 3_600_000 }, 150), t - 150 + 6 * 3_600_000)
  assert.equal(sunTimeMs(t, { fixedMs: 42, offsetMs: 0 }, 150), 42)
})

// ---------- class Sun ----------

/** The viewer shapes Sun touches, as plain objects; the clock, the model's IBL and the night layer are real (offline). */
function fakeViewer() {
  const globe = { enableLighting: true, dynamicAtmosphereLightingFromSun: false, vertexShadowDarkness: 0.3 }
  const scene = { globe, atmosphere: { dynamicLighting: DynamicAtmosphereLightingType.NONE }, light: null as unknown }
  const clock = new Clock({ shouldAnimate: true })
  const viewer = { scene, clock, camera: { positionWC: at(LOWI, 300_000), positionCartographic: { height: 300_000 } }, shadows: false }
  const day = { brightness: 1, alpha: 1, show: true }
  const night = makeNightLayer()
  const model = { environmentMapManager: { maximumPositionEpsilon: 1000 }, imageBasedLighting: new ImageBasedLighting() }
  const sun = new Sun(viewer as unknown as Viewer, { day: day as unknown as ImageryLayer, night })
  const light = scene.light as DirectionalLight
  const ibl = (): number[] => [model.imageBasedLighting.imageBasedLightingFactor.x, model.imageBasedLighting.imageBasedLightingFactor.y]
  return { sun, viewer, globe, scene, clock, day, night, model, light, ibl, attach: () => sun.attachModel(model as unknown as Model) }
}
const AIRCRAFT = at(LOWI, 2700)
const T10 = Date.parse('2026-09-22T10:00:00Z') // LOWI 12:00 local, sun +41°
const T19 = Date.parse('2026-09-22T19:00:00Z') // LOWI 21:00 local, sun −18.7°

test('new Sun: its own DirectionalLight, sky and model environment from the real sun, clock paused, starts off', () => {
  const s = fakeViewer()
  assert.ok(s.scene.light instanceof DirectionalLight)
  assert.equal(s.scene.atmosphere.dynamicLighting, DynamicAtmosphereLightingType.SUNLIGHT)
  assert.equal(s.globe.dynamicAtmosphereLightingFromSun, true)
  assert.equal(s.clock.shouldAnimate, false)
  assert.equal(s.day.brightness, 0.9999) // APPLY_BRIGHTNESS compiled from the start
  assert.equal(s.globe.enableLighting, false)
  assert.equal(s.night.show, false)
  assert.equal(s.light.intensity, 2)
  assert.ok(s.light.color.equals(Color.WHITE))
  // Above the camera until an update. Cesium's "up" at a point above the ground (Ellipsoid.geodeticSurfaceNormal of the
  // point itself) leans from the geodetic up by ~1e-4° at 2.7 km and ~0.009° at 300 km.
  const from = elAz(Cartesian3.negate(s.light.direction, new Cartesian3()), LOWI)
  near(from.el, 60, 0.01)
  near(from.az, 180, 0.01)
  assert.equal(s.viewer.shadows, false) // D10
})

test('update writes the sun time into the paused clock, reusing one JulianDate and one result object', () => {
  const s = fakeViewer()
  const r1 = s.sun.update(T10, AIRCRAFT)
  const jd = s.clock.currentTime
  assert.equal(JulianDate.toDate(jd).getTime(), T10)
  const r2 = s.sun.update(T19, AIRCRAFT)
  assert.equal(s.clock.currentTime, jd)
  assert.equal(JulianDate.toDate(jd).getTime(), T19)
  assert.equal(r2, r1)
  assert.equal(s.clock.shouldAnimate, false)
  assert.equal(s.scene.light, s.light) // one light, its direction written in place
})

test('lit at LOWI 12:00 local: the light follows the sun, white, full strength; no night layer, so no GIBS requests', () => {
  const s = fakeViewer()
  s.attach()
  s.sun.setEnabled(true)
  const r = s.sun.update(T10, AIRCRAFT)!
  near(r.elevDeg, 41, 0.5)
  assert.equal(r.night, 0)
  assert.equal(r.golden, 0)
  assert.equal(s.globe.enableLighting, true)
  const sun = sunDirectionWC(jdOf('2026-09-22T10:00:00Z'), new Cartesian3())
  assert.ok(Cartesian3.equalsEpsilon(s.light.direction, Cartesian3.negate(sun, new Cartesian3()), 1e-12))
  assert.equal(s.light.intensity, 2)
  assert.deepEqual([s.light.color.red, s.light.color.green, s.light.color.blue], [1, 1, 1])
  assert.equal(s.globe.vertexShadowDarkness, 0.3)
  assert.equal(s.day.brightness, 0.9999)
  assert.equal(s.night.show, false)
  assert.equal(s.night.alpha, 0)
  assert.deepEqual(s.ibl(), [1, 1])
  assert.equal(s.model.environmentMapManager.maximumPositionEpsilon, 20_000)
})

test('lit at LOWI 21:00 local: a dim light from straight overhead, city lights, darker land, dimmed aircraft', () => {
  const s = fakeViewer()
  s.attach()
  s.sun.setEnabled(true)
  const r = s.sun.update(T19, AIRCRAFT)!
  near(r.elevDeg, -18.7, 0.5)
  assert.equal(r.night, 1)
  const [, , up] = enu(LOWI)
  assert.ok(Cartesian3.equalsEpsilon(s.light.direction, Cartesian3.negate(up, new Cartesian3()), 1e-5))
  near(s.light.intensity, 0.45, 1e-12)
  near(s.day.brightness, 0.3, 1e-12)
  assert.equal(s.night.show, true)
  assert.equal(s.night.alpha, 0.9999) // never 1: APPLY_ALPHA stays on at full night
  assert.equal(s.night.brightness, 1)
  near(s.ibl()[0], 0.15, 1e-12)
  near(s.ibl()[1], 0.15, 1e-12)
  assert.equal(s.globe.vertexShadowDarkness, 0.3)
  assert.equal(s.viewer.shadows, false) // D10
})

test('lightsFactor: 12 % of the city lights at or below 1.5 km camera height, all of them from 5 km, smooth between', () => {
  for (const h of [-50, 0, 700, 1500]) assert.equal(lightsFactor(h), 0.12, `${h} m`)
  for (const h of [5000, 10_000, 300_000]) assert.equal(lightsFactor(h), 1, `${h} m`)
  near(lightsFactor(3250), 0.56, 1e-12) // the midpoint: 0.12 + 0.88 × smoothstep(0.5)
  let last = 0
  for (let h = 0; h <= 6000; h += 50) {
    assert.ok(lightsFactor(h) >= last, `${h} m`)
    last = lightsFactor(h)
  }
})

test('night, camera low: the city lights fade to 12 % below 1.5 km camera height, come back from 5 km', () => {
  const s = fakeViewer()
  s.sun.setEnabled(true)
  s.viewer.camera.positionCartographic.height = 500
  s.sun.update(T19, AIRCRAFT)
  near(s.night.alpha, 0.9999 * 0.12, 1e-12)
  assert.equal(s.night.show, true)
  s.viewer.camera.positionCartographic.height = 8000
  s.sun.update(T19, AIRCRAFT)
  assert.equal(s.night.alpha, 0.9999)
})

test('dusk at LOWI: the night layer shows only above 1 % alpha; the light warms and never comes from below 2°', () => {
  const s = fakeViewer()
  s.sun.setEnabled(true)
  const [, , up] = enu(LOWI)
  let hiddenButFading = 0
  let warmest = 1
  for (let t = Date.parse('2026-09-22T16:30:00Z'); t <= Date.parse('2026-09-22T17:30:00Z'); t += 10_000) {
    const r = s.sun.update(t, AIRCRAFT)!
    assert.equal(s.night.alpha, r.night)
    assert.equal(s.night.show, s.night.alpha > 0.01)
    if (s.night.alpha > 0 && !s.night.show) hiddenButFading++
    assert.ok(-Cartesian3.dot(s.light.direction, up) >= Math.sin(2 * DEG) - 1e-12)
    warmest = Math.min(warmest, s.light.color.blue)
    near(s.globe.vertexShadowDarkness, 0.3 + 0.2 * r.golden, 1e-12)
  }
  assert.ok(hiddenButFading > 0, 'a faint fade stays hidden')
  near(warmest, 1 - 0.38 * 0.965, 0.01) // golden·(1 − night) peaks at 0.965, near +1.4°
  const dawn = s.sun.update(Date.parse('2026-09-22T05:30:00Z'), AIRCRAFT)! // +4.4°
  assert.equal(s.night.show, false)
  assert.ok(dawn.golden > 0.5 && s.light.color.blue < 0.8, 'golden hour')
})

test('setEnabled(false) (browse, or the Sun toggle off): unlit, day imagery, white light from 60° above the last position', () => {
  const s = fakeViewer()
  s.attach()
  s.sun.setEnabled(true)
  s.sun.update(Date.parse('2026-09-22T17:15:00Z'), AIRCRAFT) // −1.4°: warm light, lights fading in, dimmed land and IBL
  assert.ok(s.night.show && s.light.color.blue < 0.8 && s.day.brightness < 0.9 && s.ibl()[0] < 0.9)
  s.sun.setEnabled(false)
  assert.equal(s.globe.enableLighting, false)
  assert.equal(s.night.show, false)
  assert.equal(s.day.brightness, 0.9999)
  assert.equal(s.light.intensity, 2)
  assert.deepEqual([s.light.color.red, s.light.color.green, s.light.color.blue], [1, 1, 1])
  assert.deepEqual(s.ibl(), [1, 1])
  let from = elAz(Cartesian3.negate(s.light.direction, new Cartesian3()), LOWI)
  near(from.el, 60, 1e-3)
  near(from.az, 180, 1e-3)
  // Off, update keeps the clock and moves the fixed light with the target; the look stays off.
  const r = s.sun.update(T19, at(KSFO, 500))!
  near(r.elevDeg, 50.1, 0.5)
  assert.equal(JulianDate.toDate(s.clock.currentTime).getTime(), T19)
  from = elAz(Cartesian3.negate(s.light.direction, new Cartesian3()), KSFO)
  near(from.el, 60, 1e-3)
  near(from.az, 180, 1e-3)
  assert.equal(s.light.intensity, 2)
  assert.equal(s.day.brightness, 0.9999)
  assert.equal(s.night.show, false)
  assert.deepEqual(s.ibl(), [1, 1])
  // On again: the next update lights it.
  s.sun.setEnabled(true)
  s.sun.update(T19, AIRCRAFT)
  assert.equal(s.globe.enableLighting, true)
  assert.equal(s.night.show, true)
  assert.equal(s.viewer.shadows, false) // D10
})

test('update rejects a time that is no Date and a non-finite position, and writes nothing', () => {
  const s = fakeViewer()
  s.sun.setEnabled(true)
  s.sun.update(T10, AIRCRAFT)
  const before = Cartesian3.clone(s.light.direction)
  for (const t of [Number.NaN, Number.POSITIVE_INFINITY, 1e16]) assert.equal(s.sun.update(t, AIRCRAFT), null, String(t))
  assert.equal(s.sun.update(T19, new Cartesian3(Number.NaN, 0, 0)), null)
  assert.equal(JulianDate.toDate(s.clock.currentTime).getTime(), T10)
  assert.ok(Cartesian3.equals(s.light.direction, before))
  assert.equal(s.night.show, false)
})

test('attachModel(null) detaches: a later night leaves the old model alone', () => {
  const s = fakeViewer()
  s.attach()
  s.sun.attachModel(null)
  s.sun.setEnabled(true)
  s.sun.update(T19, AIRCRAFT)
  assert.deepEqual(s.ibl(), [1, 1])
})

test('no test touched the network: Cesium asked only for its XYS table, from a file: URL (so Node runs on TEME)', () => {
  assert.ok(fetched.length > 0, 'sunDirectionWC tries the ICRF frame first')
  for (const url of fetched) assert.match(url, /^file:.*IAU2006_XYS/)
})

// client/scene/aircraftLights.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Cartesian3, Matrix3 } from 'cesium'
import type { ModelManifest, ModelManifestEntry } from '../types.ts'
import {
  BEACON_PERIOD_S, NAV_SPILL, STROBE_PERIOD_S, beaconAt, beaconsOn, beamFactor, belowTenThousand, glowScale, landingOn, lost,
  navSector, phaseOf, strobeAt, strobesOn, taxiOn,
} from './aircraftLights.ts'
import { fixMatrix } from './model.ts'

const manifest: ModelManifest = JSON.parse(readFileSync(new URL('../../public/models/manifest.json', import.meta.url), 'utf8'))
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${msg} got ${a}, expected ${b} ± ${tol}`)
const air = { onGround: false, altFt: 3000, gsKt: 160, damaged: false }
const ground = (gsKt: number): typeof air => ({ onGround: true, altFt: null as unknown as number, gsKt, damaged: false })

// ---------- when each light is on ----------

test('landing lights: on below 8,000 ft, off above 10,000 ft, smooth between; unknown altitude: off', () => {
  assert.equal(belowTenThousand(7_000), 1)
  assert.equal(belowTenThousand(12_000), 0)
  assert.equal(belowTenThousand(null), 0)
  let prev = belowTenThousand(7_900)
  for (let ft = 7_900; ft <= 10_100; ft += 10) {
    const x = belowTenThousand(ft)
    assert.ok(x <= prev + 1e-12 && prev - x < 0.02, `step at ${ft}`)
    prev = x
  }
  assert.equal(landingOn({ ...air, altFt: 37_000 }), 0, 'cruise')
  assert.equal(landingOn(air), 1, 'approach')
})

test('on the ground: landing lights on the take-off or landing roll only; the taxi light while moving', () => {
  assert.equal(landingOn(ground(120)), 1)
  assert.equal(landingOn(ground(15)), 0)
  assert.equal(taxiOn(ground(15)), 1)
  assert.equal(taxiOn(ground(0)), 0)
  assert.equal(taxiOn(air), 1, 'airborne: with the landing lights')
})

test('strobes: airborne or rolling for take-off; beacons: whenever the engines run (airborne or moving)', () => {
  assert.equal(strobesOn(air), true)
  assert.equal(strobesOn(ground(15)), false)
  assert.equal(strobesOn(ground(100)), true)
  assert.equal(beaconsOn(ground(0)), false)
  assert.equal(beaconsOn(ground(5)), true)
  assert.equal(beaconsOn(air), true)
})

// ---------- flashes ----------

/** The flashes in one period, sampled every ms: [start, end) in seconds. */
function flashes(f: (t: number) => number, period: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let on: number | null = null
  for (let ms = 0; ms <= period * 1000; ms++) {
    const lit = f(ms / 1000) > 0
    if (lit && on === null) on = ms / 1000
    if (!lit && on !== null) {
      out.push([on, ms / 1000])
      on = null
    }
  }
  return out
}

test('strobes: a double flash every 1.2 s, each about 70 ms, the second 160 ms after the first', () => {
  const f = flashes(strobeAt, STROBE_PERIOD_S)
  assert.equal(f.length, 2)
  near(f[0][1] - f[0][0], 0.07, 0.002, 'first flash')
  near(f[1][0] - f[0][0], 0.16, 0.002, 'gap')
  near(strobeAt(0.01), strobeAt(0.01 + 3 * STROBE_PERIOD_S), 1e-9, 'periodic')
  assert.ok(strobeAt(0) === 1 && strobeAt(0.06) > 0.6, 'bright through the flash')
})

test('beacons: one flash a second, up in 30 ms, held, down by 160 ms; dark the rest', () => {
  const f = flashes(beaconAt, BEACON_PERIOD_S)
  assert.equal(f.length, 1)
  near(f[0][1] - f[0][0], 0.16, 0.002)
  assert.equal(beaconAt(0.05), 1)
  assert.equal(beaconAt(0.5), 0)
})

test('phaseOf: steady per aircraft, in [0, 1), and different aircraft differ (their flashes out of step)', () => {
  assert.equal(phaseOf('4ca7b4'), phaseOf('4ca7b4'))
  const ps = ['4ca7b4', '3c65cf', '406b90', 'a1b2c3', '000001'].map(phaseOf)
  for (const p of ps) assert.ok(p >= 0 && p < 1)
  assert.equal(new Set(ps.map((p) => p.toFixed(3))).size, ps.length)
})

// ---------- where each light is seen from ----------

test('position lights: red seen from dead ahead round to 110° left, green to the right, white astern; a dim lamp elsewhere', () => {
  const dir = (azDeg: number): [number, number] => [Math.cos((azDeg * Math.PI) / 180), Math.sin((azDeg * Math.PI) / 180)] // +az: to the left
  near(navSector('left', ...dir(60)), 1, 1e-6, 'red from the left')
  near(navSector('left', ...dir(-60)), NAV_SPILL, 1e-6, 'red from the right: spill')
  near(navSector('right', ...dir(-60)), 1, 1e-6, 'green from the right')
  near(navSector('right', ...dir(60)), NAV_SPILL, 1e-6, 'green from the left: spill')
  near(navSector('tail', ...dir(180)), 1, 1e-6, 'white from astern')
  near(navSector('tail', ...dir(0)), NAV_SPILL, 1e-6, 'white from ahead: spill')
  near(navSector('left', ...dir(150)), NAV_SPILL, 1e-6, 'red from behind: spill')
  // no pop at the sector edges: continuous in azimuth
  for (const kind of ['left', 'right', 'tail'] as const) {
    let prev = navSector(kind, ...dir(-180))
    for (let az = -180; az <= 180; az += 0.5) {
      const w = navSector(kind, ...dir(az))
      assert.ok(Math.abs(w - prev) < 0.1, `${kind} jumps at ${az}°`)
      prev = w
    }
  }
})

test('position lights: seen from straight above or below, every one shows', () => {
  for (const kind of ['left', 'right', 'tail'] as const) near(navSector(kind, 0, 0), 1, 1e-9, kind)
})

test('landing lights: full glare on the beam, half about 20° off it, a dim lamp from anywhere ahead, none from behind', () => {
  near(beamFactor(1), 1, 1e-9)
  near(beamFactor(Math.cos((20 * Math.PI) / 180)), 0.5 + 0.1 * Math.cos((20 * Math.PI) / 180), 0.02)
  assert.ok(beamFactor(Math.cos((80 * Math.PI) / 180)) < 0.05)
  assert.ok(beamFactor(-1) < 1e-9, 'from behind')
  assert.equal(beamFactor(1.5), 1, 'clamped')
})

test('glowScale: shrinks with the square root of distance, clamped for the very near and the far', () => {
  near(glowScale(150), 1, 1e-9)
  near(glowScale(600), 0.5, 1e-9)
  assert.equal(glowScale(1), 1.7)
  assert.equal(glowScale(1e7), 0.14)
})

// ---------- the anchors every model carries (tools/models/light-anchors.ts) ----------

/** An anchor in the body frame: nose +x, left +y, up +z. */
const body = (e: ModelManifestEntry, a: readonly number[]): Cartesian3 =>
  Matrix3.multiplyByVector(fixMatrix(e), Cartesian3.fromElements(a[0], a[1], a[2]), new Cartesian3())

test('manifest: every model has lights, red on the left wing tip, green mirrored on the right, white aft of both', () => {
  for (const e of manifest.models) {
    const L = e.lights
    assert.ok(L !== undefined, `${e.id}: no lights`)
    const lengthU = e.lengthM / e.scale
    const l = body(e, L.navLeft)
    const r = body(e, L.navRight)
    const t = body(e, L.tail)
    assert.ok(l.y > 0.1 * lengthU && r.y < -0.1 * lengthU, `${e.id}: red ${l.y} left, green ${r.y} right`)
    near(l.y, -r.y, 0.02 * lengthU, `${e.id}: mirrored`)
    near(l.x, r.x, 0.02 * lengthU, `${e.id}: level fore and aft`)
    assert.ok(t.x < Math.min(l.x, r.x), `${e.id}: tail light aft of the wing tips`)
    assert.ok(Math.abs(t.y) < 0.05 * lengthU, `${e.id}: tail light on the centre line`)
    for (const b of L.beacons) assert.ok(Math.abs(body(e, b).y) < 0.05 * lengthU, `${e.id}: beacon on the centre line`)
    if (L.beacons.length === 2) assert.ok(body(e, L.beacons[0]).z > body(e, L.beacons[1]).z, `${e.id}: upper beacon first`)
    for (const a of L.landing) assert.ok(body(e, a).x > t.x, `${e.id}: landing lights ahead of the tail`)
  }
})

test('lost: with the JAL 123 damage, the tail cone light is gone and the wing tips are not', () => {
  const e = manifest.models.find((m) => m.paint?.cut !== undefined)
  assert.ok(e !== undefined, 'a model with a damage cut')
  const cut = e.paint!.cut!
  assert.equal(lost(e, e.lights!.tail, cut), true)
  assert.equal(lost(e, e.lights!.navLeft, cut), false)
  assert.equal(lost(e, e.lights!.navRight, cut), false)
})

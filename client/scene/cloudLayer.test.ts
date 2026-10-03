// client/scene/cloudLayer.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cartographic, CloudCollection, Math as CesiumMath, type CumulusCloud, type PrimitiveCollection } from 'cesium'
import { geoidN } from '../../shared/geoid.ts'
import type { CloudSpec } from './cloudField.ts'
import { sunBrightness } from './cloudField.ts'
import { CloudLayer, tintColor } from './cloudLayer.ts'

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol
const TRUE = { fSampled: 1, fNow: 1, relHM: 0 }

const spec = (o: Partial<CloudSpec> = {}): CloudSpec => ({
  lon: 34.9, lat: 32, heightM: 1500, groundM: 40, scale: [2000, 800], maxSize: [22, 12, 13], slice: 0.42, brightness: 0.9, tint: 0.3, ...o,
})

function rig() {
  const added: unknown[] = []
  const removed: unknown[] = []
  const primitives = { add: (p: unknown) => (added.push(p), p), remove: (p: unknown) => (removed.push(p), true) } as unknown as PrimitiveCollection
  const layer = new CloudLayer(primitives)
  const coll = added[0] as CloudCollection
  const clouds = (): CumulusCloud[] => Array.from({ length: coll.length }, (_, i) => coll.get(i))
  return { layer, coll, clouds, added, removed }
}
const placeOf = (c: CumulusCloud): { lon: number; lat: number; h: number } => {
  const p = Cartographic.fromCartesian(c.position)
  return { lon: CesiumMath.toDegrees(p.longitude), lat: CesiumMath.toDegrees(p.latitude), h: p.height }
}

test('CloudLayer: one CloudCollection, hidden until shown; draw puts one cloud per spec where the spec says, its height above sea level made one above the ellipsoid', () => {
  const r = rig()
  assert.ok(r.coll instanceof CloudCollection)
  assert.equal(r.coll.show, false)
  assert.equal(r.layer.show, false)
  r.layer.show = true
  assert.equal(r.coll.show, true)
  assert.equal(r.layer.show, true)
  const a = spec()
  const b = spec({ lon: 35.2, lat: 31.7, heightM: 7000, groundM: 600, scale: [5000, 600], maxSize: [44, 9, 8], slice: 0.55, brightness: 1, tint: 0 })
  r.layer.draw([a, b])
  r.layer.frame(TRUE, 0)
  const cs = r.clouds()
  assert.equal(cs.length, 2)
  for (const [c, s] of [[cs[0], a], [cs[1], b]] as const) {
    const p = placeOf(c)
    assert.ok(near(p.lon, s.lon, 1e-9) && near(p.lat, s.lat, 1e-9))
    assert.ok(near(p.h, s.heightM + geoidN(s.lat, s.lon), 1e-3), `${p.h} m above the ellipsoid`)
    assert.deepEqual([c.scale.x, c.scale.y], s.scale)
    assert.deepEqual([c.maximumSize.x, c.maximumSize.y, c.maximumSize.z], s.maxSize)
    assert.equal(c.slice, s.slice)
    assert.ok(near(c.brightness, s.brightness, 1e-12), 'by day, its own brightness')
    assert.ok(c.color.equals(tintColor(s.tint)))
  }
  assert.equal(r.layer.count, 2)
})

test('tintColor: white untinted, darker grey (a little blue) the more tinted, opaque', () => {
  const w = tintColor(0)
  assert.deepEqual([w.red, w.green, w.blue, w.alpha], [1, 1, 1, 1])
  const d = tintColor(1)
  assert.ok(d.red < 0.6 && d.red < d.green && d.green < d.blue && d.alpha === 1, `${d}`)
  assert.ok(tintColor(0.5).red > d.red && tintColor(0.5).red < 1)
})

test('CloudLayer: a flattened relief moves each cloud with its station\'s ground, keeping its height above it', () => {
  const r = rig()
  const s = spec({ heightM: 2000, groundM: 900 })
  r.layer.draw([s])
  const n = geoidN(s.lat, s.lon)
  r.layer.frame(TRUE, 0)
  assert.ok(near(placeOf(r.clouds()[0]).h, 2000 + n, 1e-3))
  r.layer.frame({ fSampled: 0, fNow: 0, relHM: 100 }, 0) // flat at 100 m above the ellipsoid
  assert.ok(near(placeOf(r.clouds()[0]).h, 100 + (2000 - 900), 1e-3), 'its station\'s ground drawn at 100 m: the cloud 1,100 m above it')
  r.layer.frame({ fSampled: 0.5, fNow: 0.5, relHM: 100 }, 0)
  const ground = (900 + n - 100) * 0.5 + 100
  assert.ok(near(placeOf(r.clouds()[0]).h, ground + 1100, 1e-3), 'half grown')
  r.layer.draw([s])
  assert.ok(near(placeOf(r.clouds()[0]).h, ground + 1100, 1e-3), 'a new draw is placed for the relief as drawn')
})

test('CloudLayer: brightness by the Sun\'s night, written again only when it has changed by a step', () => {
  const r = rig()
  const s = spec({ brightness: 0.8 })
  r.layer.draw([s, s])
  r.layer.frame(TRUE, 1)
  for (const c of r.clouds()) assert.ok(near(c.brightness, 0.8 * sunBrightness(1), 1e-12))
  r.layer.frame(TRUE, 0.5)
  for (const c of r.clouds()) assert.ok(near(c.brightness, 0.8 * sunBrightness(0.5), 0.8 * 0.85 * 0.01))
  const before = r.clouds()[0].brightness
  r.layer.frame(TRUE, 0.505)
  assert.equal(r.clouds()[0].brightness, before, 'a hundredth of the night: no rewrite')
  r.layer.frame(TRUE, Number.NaN)
  assert.ok(near(r.clouds()[0].brightness, 0.8, 1e-12), 'not a number: day')
  r.layer.frame(TRUE, 1)
  r.layer.draw([s])
  assert.ok(near(r.clouds()[0].brightness, 0.8 * sunBrightness(1), 1e-12), 'a draw at night is drawn for the night')
})

test('CloudLayer: a new draw replaces the clouds; none draws none; destroy takes the collection out', () => {
  const r = rig()
  r.layer.draw([spec(), spec(), spec()])
  r.layer.draw([spec({ heightM: 3000 })])
  assert.equal(r.clouds().length, 1)
  r.layer.draw([])
  assert.equal(r.clouds().length, 0)
  assert.equal(r.layer.count, 0)
  r.layer.destroy()
  assert.deepEqual(r.removed, [r.coll])
  r.layer.destroy()
  assert.equal(r.removed.length, 1, 'once')
  r.layer.draw([spec()])
  r.layer.show = true
  r.layer.frame(TRUE, 0)
  assert.equal(r.removed.length, 1, 'destroyed: does nothing')
})

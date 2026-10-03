// client/scene/cloudLayer.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cartesian3, Cartographic, CloudCollection, Math as CesiumMath, type CumulusCloud, type PrimitiveCollection } from 'cesium'
import { geoidN } from '../../shared/geoid.ts'
import type { CloudSpec } from './cloudField.ts'
import { fadeAlpha, sunBrightness } from './cloudField.ts'
import { CloudLayer, tintColor } from './cloudLayer.ts'

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol
const TRUE = { fSampled: 1, fNow: 1, relHM: 0 }

const spec = (o: Partial<CloudSpec> = {}): CloudSpec => ({
  lon: 34.9, lat: 32, heightM: 1500, groundM: 40, scale: [2000, 800], maxSize: [22, 12, 13], slice: 0.42, brightness: 0.9, tint: 0.3, farKm: 150, ...o,
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

test('CloudLayer: fade by the distance from the place given (each look): all of a cloud near, none past its farKm (hidden), part between; a draw after it is faded too', () => {
  const r = rig()
  const kmNorth = (km: number): number => 32 + km / 111.2
  const near0 = spec({ lat: kmNorth(10), farKm: 60 })
  const mid = spec({ lat: kmNorth(51), farKm: 60 })
  const gone = spec({ lat: kmNorth(70), farKm: 60 })
  r.layer.draw([near0, mid, gone])
  const [a, b, c] = r.clouds()
  assert.deepEqual([a.color.alpha, b.color.alpha, c.color.alpha], [1, 1, 1], 'no place given yet: all shown')
  const from = Cartesian3.fromDegrees(34.9, 32, 1500 + geoidN(32, 34.9))
  r.layer.fade(from)
  assert.equal(a.color.alpha, 1)
  assert.ok(near(b.color.alpha, fadeAlpha(mid, 51), 0.03) && b.color.alpha > 0 && b.color.alpha < 1, `half faded: ${b.color.alpha}`)
  assert.equal(c.color.alpha, 0)
  assert.deepEqual([a.show, b.show, c.show], [true, true, false])
  assert.ok(near(b.color.red, tintColor(0.3).red, 1e-6), 'its grey kept')
  r.layer.draw([gone, near0])
  const [d, e] = r.clouds()
  assert.deepEqual([d.show, d.color.alpha, e.show, e.color.alpha], [false, 0, true, 1])
  const there = Cartesian3.fromDegrees(34.9, kmNorth(70), 1500)
  r.layer.fade(there)
  assert.deepEqual([d.show, d.color.alpha], [true, 1], 'the aircraft came to it')
  Cartesian3.clone(from, there) // the caller's object, reused
  r.layer.draw([gone])
  assert.equal(r.clouds()[0].color.alpha, 1, 'faded from where it was given, not from what the caller\'s object holds later')
})

test('CloudLayer: a puff with clearKm is hidden while the aircraft is at the height it spans and within clearKm of it, back by twice that; one the aircraft is above or below, or far from, is not touched', () => {
  const r = rig()
  const kmNorth = (km: number): number => 32 + km / 111.2
  const puff = (km: number, o: Partial<CloudSpec> = {}): CloudSpec => spec({ lat: kmNorth(km), heightM: 10_000, scale: [12_000, 800], farKm: 150, clearKm: 3, ...o }) // spans 9,700 to 10,300 m
  const specs = [puff(2), puff(4.5), puff(6.5), puff(2, { clearKm: undefined }), puff(2, { clearKm: 5 }), puff(7, { clearKm: 5 }), puff(200, { farKm: 150 })]
  r.layer.draw(specs)
  const cs = r.clouds()
  const at = (heightM: number): Cartesian3 => Cartesian3.fromDegrees(34.9, 32, heightM + geoidN(32, 34.9))
  r.layer.fade(at(10_000))
  assert.equal(cs[0].color.alpha, 0, '2 km off, at its height: hidden')
  assert.equal(cs[0].show, false)
  assert.ok(near(cs[1].color.alpha, 0.5, 0.06), `4.5 km: half way back, ${cs[1].color.alpha}`)
  assert.equal(cs[2].color.alpha, 1, '6.5 km: back')
  assert.equal(cs[3].color.alpha, 1, 'no clearKm: not touched')
  assert.equal(cs[4].color.alpha, 0, 'its own clearKm: 5 km')
  assert.ok(cs[5].color.alpha > 0 && cs[5].color.alpha < 1, `7 km of 5: ${cs[5].color.alpha} on its way back`)
  assert.equal(cs[6].color.alpha, 0, 'and the distance fade still hides what is far')
  r.layer.fade(at(10_000 + 650)) // 650 m over the middle: 350 m over the top of its span, 50 m past the margin (300 m)
  assert.equal(cs[0].color.alpha, 1, '650 m above the middle: beyond the span (300 m) and the margin (300 m): the aircraft is not at its height')
  r.layer.fade(at(10_000 + 550))
  assert.equal(cs[0].color.alpha, 0, '550 m above the middle: within the span and the margin of a camera that is not on the aircraft')
  r.layer.fade(at(10_000 - 550))
  assert.equal(cs[0].color.alpha, 0, 'and below')
  r.layer.fade(at(1_000))
  assert.deepEqual(cs.slice(0, 5).map((c) => c.color.alpha), [1, 1, 1, 1, 1], 'far under it: none is touched')
  r.layer.fade(at(10_000))
  assert.equal(cs[0].show, false)
  r.layer.draw(specs) // a draw after the fade is hidden the same
  assert.equal(r.clouds()[0].color.alpha, 0)
})

test('CloudLayer: the hide for the aircraft comes with the distance fade, not instead of it: a puff the distance has half faded and the aircraft is half way back from is both', () => {
  const r = rig()
  const kmNorth = (km: number): number => 32 + km / 111.2
  const s = spec({ lat: kmNorth(4.5), heightM: 10_000, scale: [12_000, 800], farKm: 6, clearKm: 3 }) // faded by 6 km: the fade starts at 4.2 km
  r.layer.draw([s])
  r.layer.fade(Cartesian3.fromDegrees(34.9, 32, 10_000 + geoidN(32, 34.9)))
  const both = fadeAlpha(s, 4.5) * 0.5
  assert.ok(near(r.clouds()[0].color.alpha, both, 0.06), `${r.clouds()[0].color.alpha} for ${both}`)
  assert.ok(both > 0 && both < 0.5)
})

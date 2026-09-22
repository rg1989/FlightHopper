// client/scene/aircraftLayer.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cartesian2, Cartographic, Color, LabelCollection, PointPrimitiveCollection } from 'cesium'
import type { Label, PointPrimitive, Viewer } from 'cesium'
import type { RenderState } from '../types.ts'
import { AircraftLayer, colorFor } from './aircraftLayer.ts'

// Cesium's Label measures its CSS font through the DOM once per font (Label.js parseFont) and Node has no DOM.
// These are the only DOM calls LabelCollection.add makes; glyphs are drawn later in update(), which only a real scene calls.
Object.assign(globalThis, {
  document: {
    createElement: () => ({ style: {} }),
    body: { appendChild: () => {}, removeChild: () => {} },
    defaultView: { getComputedStyle: () => ({ getPropertyValue: (p: string) => (p === 'font-size' ? '13px' : '') }) },
  },
})

function fakeViewer(groundH?: number) {
  const f = {
    added: [] as unknown[],
    pickResult: undefined as unknown,
    pickedAt: null as Cartesian2 | null,
    viewer: null as unknown as Viewer,
  }
  const scene = {
    primitives: {
      add: <T>(p: T): T => (f.added.push(p), p),
      remove: (p: { destroy(): void }): boolean => {
        const i = f.added.indexOf(p)
        if (i < 0) return false
        f.added.splice(i, 1)
        p.destroy()
        return true
      },
    },
    globe: { getHeight: (_c: Cartographic): number | undefined => groundH },
    pick: (pos: Cartesian2): unknown => ((f.pickedAt = pos), f.pickResult),
  }
  f.viewer = { scene } as unknown as Viewer
  return f
}

const points = (f: { added: unknown[] }): PointPrimitiveCollection => f.added.find((p) => p instanceof PointPrimitiveCollection) as PointPrimitiveCollection
const labels = (f: { added: unknown[] }): LabelCollection => f.added.find((p) => p instanceof LabelCollection) as LabelCollection
const allPoints = (c: PointPrimitiveCollection): PointPrimitive[] => Array.from({ length: c.length }, (_, i) => c.get(i))
const allLabels = (c: LabelCollection): Label[] => Array.from({ length: c.length }, (_, i) => c.get(i))
const pointOf = (f: { added: unknown[] }, hex: string): PointPrimitive => allPoints(points(f)).find((p) => p.id === hex) as PointPrimitive
const labelOf = (f: { added: unknown[] }, hex: string): Label => allLabels(labels(f)).find((l) => l.id === hex) as Label
const heightOf = (p: PointPrimitive): number => Cartographic.fromCartesian(p.position).height

const st = (hex: string, o: Partial<RenderState> = {}): RenderState => ({
  hex, lat: 37.62, lon: -122.38, hM: 1000, headingDeg: 90, pitchDeg: 0, rollDeg: 0,
  gsKt: 250, trackDeg: 90, altBaroFt: 3200, vsFpm: 0, mode: 'interp', altSource: 'geom',
  onGround: false, ageS: 1, quality: 'adsb2', callsign: null, typeCode: 'B738', ...o,
})

test('colorFor: one hue per quality, full opacity while live', () => {
  assert.equal(colorFor('adsb2', false, 'interp'), 'rgba(56, 189, 248, 1)')
  const all = (['adsb2', 'adsb01', 'mlat', 'other'] as const).map((q) => colorFor(q, false, 'interp'))
  assert.equal(new Set(all).size, 4)
  assert.equal(colorFor('mlat', false, 'extrap'), colorFor('mlat', false, 'interp'))
})

test('colorFor: stale is dimmed, less so when selected, and Cesium parses it', () => {
  const alpha = (css: string): number => Color.fromCssColorString(css).alpha
  assert.equal(alpha(colorFor('adsb2', false, 'interp')), 1)
  assert.ok(alpha(colorFor('adsb2', false, 'stale')) < 0.5)
  assert.ok(alpha(colorFor('adsb2', true, 'stale')) > alpha(colorFor('adsb2', false, 'stale')))
  assert.ok(alpha(colorFor('adsb2', true, 'stale')) < 1)
  assert.equal(alpha(colorFor('other', true, 'interp')), 1)
})

test('one point and one label per aircraft, both collections added to the scene, keyed by hex', () => {
  const f = fakeViewer()
  const layer = new AircraftLayer(f.viewer)
  assert.equal(f.added.length, 2)
  layer.update([st('a1b2c3', { callsign: 'UAL123' }), st('4x4x4x')], null)
  assert.equal(points(f).length, 2)
  assert.equal(labels(f).length, 2)
  assert.equal(labelOf(f, 'a1b2c3').text, 'UAL123')
  assert.equal(labelOf(f, '4x4x4x').text, '4x4x4x', 'no callsign → hex')
  assert.ok(pointOf(f, 'a1b2c3'))
})

test('primitives are reused across updates and moved in place', () => {
  const f = fakeViewer()
  const layer = new AircraftLayer(f.viewer)
  layer.update([st('a1b2c3', { lat: 37.6 })], null)
  const p = pointOf(f, 'a1b2c3')
  const l = labelOf(f, 'a1b2c3')
  const before = p.position.clone()
  layer.update([st('a1b2c3', { lat: 37.7 })], null)
  assert.equal(points(f).length, 1)
  assert.equal(pointOf(f, 'a1b2c3'), p, 'same PointPrimitive object')
  assert.equal(labelOf(f, 'a1b2c3'), l, 'same Label object')
  assert.ok(!p.position.equals(before), 'moved')
  assert.ok(l.position.equals(p.position), 'label sits on the point')
})

test('hexes missing from an update are removed from both collections', () => {
  const f = fakeViewer()
  const layer = new AircraftLayer(f.viewer)
  layer.update([st('aaaaaa'), st('bbbbbb'), st('cccccc')], null)
  layer.update([st('bbbbbb')], null)
  assert.equal(points(f).length, 1)
  assert.equal(labels(f).length, 1)
  assert.equal(allPoints(points(f))[0].id, 'bbbbbb')
  layer.update([], null)
  assert.equal(points(f).length, 0)
  assert.equal(labels(f).length, 0)
})

test('selected aircraft is larger and outlined; deselecting restores it', () => {
  const f = fakeViewer()
  const layer = new AircraftLayer(f.viewer)
  layer.update([st('aaaaaa'), st('bbbbbb')], 'bbbbbb')
  const a = pointOf(f, 'aaaaaa')
  const b = pointOf(f, 'bbbbbb')
  assert.ok(b.pixelSize > a.pixelSize)
  assert.ok(b.outlineWidth > 0)
  assert.equal(a.outlineWidth, 0)
  layer.update([st('aaaaaa'), st('bbbbbb')], null)
  assert.equal(b.pixelSize, a.pixelSize)
  assert.equal(b.outlineWidth, 0)
})

test('colour follows quality and stale tracks are dimmed', () => {
  const f = fakeViewer()
  const layer = new AircraftLayer(f.viewer)
  layer.update([st('aaaaaa', { quality: 'mlat' }), st('bbbbbb', { mode: 'stale' })], null)
  assert.ok(pointOf(f, 'aaaaaa').color.equals(Color.fromCssColorString(colorFor('mlat', false, 'interp'))))
  assert.ok(pointOf(f, 'bbbbbb').color.alpha < 0.5)
  assert.ok(labelOf(f, 'bbbbbb').fillColor.alpha < 0.5)
})

test('airborne aircraft sit at hM (ellipsoidal)', () => {
  const f = fakeViewer(7)
  const layer = new AircraftLayer(f.viewer)
  layer.update([st('aaaaaa', { hM: 1234.5 })], null)
  assert.ok(Math.abs(heightOf(pointOf(f, 'aaaaaa')) - 1234.5) < 1e-3)
})

test('aircraft on the ground are clamped to the loaded terrain, or stay at hM until it loads', () => {
  const f = fakeViewer(7)
  const layer = new AircraftLayer(f.viewer)
  layer.update([st('aaaaaa', { hM: -25, onGround: true })], null)
  assert.ok(Math.abs(heightOf(pointOf(f, 'aaaaaa')) - 7) < 1e-3)
  const g = fakeViewer(undefined)
  const layer2 = new AircraftLayer(g.viewer)
  layer2.update([st('aaaaaa', { hM: -25, onGround: true })], null)
  assert.ok(Math.abs(heightOf(pointOf(g, 'aaaaaa')) + 25) < 1e-3)
})

test('pick returns the hex stored on the picked primitive, null otherwise', () => {
  const f = fakeViewer()
  const layer = new AircraftLayer(f.viewer)
  layer.update([st('a1b2c3')], null)
  const at = new Cartesian2(100, 200)
  f.pickResult = { primitive: pointOf(f, 'a1b2c3'), id: 'a1b2c3' }
  assert.equal(layer.pick(at), 'a1b2c3')
  assert.equal(f.pickedAt, at)
  f.pickResult = { primitive: labelOf(f, 'a1b2c3'), id: 'a1b2c3' }
  assert.equal(layer.pick(at), 'a1b2c3', 'clicking the label works too')
  f.pickResult = undefined
  assert.equal(layer.pick(at), null, 'nothing under the cursor')
  f.pickResult = { id: 'ffffff' }
  assert.equal(layer.pick(at), null, 'a hex this layer does not draw')
  f.pickResult = { id: { name: 'an entity' } }
  assert.equal(layer.pick(at), null, 'another layer’s object')
})

test('destroy removes and destroys both collections', () => {
  const f = fakeViewer()
  const layer = new AircraftLayer(f.viewer)
  layer.update([st('a1b2c3')], null)
  const [p, l] = [points(f), labels(f)]
  layer.destroy()
  assert.equal(f.added.length, 0)
  assert.ok(p.isDestroyed())
  assert.ok(l.isDestroyed())
})

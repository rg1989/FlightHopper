// client/scene/fleetLayer.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BillboardCollection, BlendOption, Cartesian2, Cartesian3, Cartesian4, Cartographic, Color, LabelCollection, Matrix4, Transforms } from 'cesium'
import type { Billboard, Viewer } from 'cesium'
import type { AircraftInfo } from '../../shared/info.ts'
import type { FleetEntry } from '../types.ts'
import { altitudeColor } from './altitudeColor.ts'
import { TOPO_ON, drawnHeightM, smoothstep } from './exaggeration.ts'
import { FleetLayer, GROUND_LIFT_M, SELECTED_SCALE, northAt } from './fleetLayer.ts'
import { HALO_ID, ICON_ID } from './icons.ts'

// Node has no DOM. Label measures its CSS font through the DOM once per font (Label.js parseFont); the icons draw on a
// canvas. Both are stubbed; glyphs and textures are only uploaded by a real scene's render, which these tests never run.
Object.assign(globalThis, {
  document: {
    createElement: (tag: string) =>
      tag === 'canvas'
        ? { width: 0, height: 0, getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }
        : { style: {} },
    body: { appendChild: () => {}, removeChild: () => {} },
    defaultView: { getComputedStyle: () => ({ getPropertyValue: (p: string) => (p === 'font-size' ? '13px' : '') }) },
  },
})

/** camera: a perspective camera at `camera` looking with vertical field of view fovy over a 1,000 px high buffer. */
function fakeViewer(groundH?: number, camera?: Cartesian3, fovy = 1) {
  const f = {
    added: [] as unknown[],
    pickResult: undefined as unknown,
    pickedAt: null as Cartesian2 | null,
    heightCalls: 0,
    groundH,
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
    globe: { getHeight: (_c: Cartographic): number | undefined => (f.heightCalls++, f.groundH) },
    pick: (pos: Cartesian2): unknown => ((f.pickedAt = pos), f.pickResult),
    camera: camera && { positionWC: camera, frustum: { fovy } },
    drawingBufferHeight: 1_000,
  }
  f.viewer = { scene } as unknown as Viewer
  return f
}

type F = ReturnType<typeof fakeViewer>
const bbs = (f: F): BillboardCollection => f.added.find((p) => p instanceof BillboardCollection) as BillboardCollection
const labels = (f: F): LabelCollection => f.added.find((p) => p instanceof LabelCollection) as LabelCollection
const all = (f: F): Billboard[] => Array.from({ length: bbs(f).length }, (_, i) => bbs(f).get(i))
const bb = (f: F, hex: string): Billboard => all(f).find((b) => b.id === hex && b.image !== HALO_ID) as Billboard
const halo = (f: F): Billboard => all(f).find((b) => b.image === HALO_ID) as Billboard
const label = (f: F) => labels(f).get(0)
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} ${msg}`)
/** Cesium counts property changes per property index; a frame that changes nothing adds nothing. */
const changes = (f: F): number[] => [...(bbs(f) as unknown as { _propertiesChanged: Uint32Array })._propertiesChanged]
const atlasIds = (f: F): number => (bbs(f) as unknown as { textureAtlas: { _indexById: Map<string, number> } }).textureAtlas._indexById.size

const info = (hex: string, o: Partial<AircraftInfo> = {}): AircraftInfo => ({
  hex, callsign: 'DLH4AB', reg: null, typeCode: 'A320', category: 'A3', squawk: null, emergency: null, military: false, route: null, ...o,
})
const fe = (hex: string, o: Partial<FleetEntry> = {}): FleetEntry => ({
  hex, lat: 50, lon: 10, hM: 10_000, altFt: 33_000, onGround: false, trackDeg: 90, gsKt: 450, vsFpm: 0, ageS: 1, staleS: 60, gapS: 1, quality: 'adsb2',
  info: info(hex), ...o,
})

test('one billboard collection (single translucent pass) and one label collection', () => {
  const f = fakeViewer()
  new FleetLayer(f.viewer)
  assert.equal(f.added.length, 2)
  assert.equal(bbs(f).blendOption, BlendOption.TRANSLUCENT)
  assert.ok(labels(f))
  assert.equal(halo(f).show, false, 'selection ring starts hidden')
  assert.equal(label(f).show, false, 'label starts hidden')
})

test('one billboard per hex at its position, reused and moved in place', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  layer.update([fe('aaaaaa', { lat: 50, lon: 10, hM: 9_000 }), fe('bbbbbb', { lat: 45, lon: 5 })], null, null)
  const a = bb(f, 'aaaaaa')
  assert.ok(a && bb(f, 'bbbbbb'))
  assert.equal(bbs(f).length, 3, 'two aircraft + the selection ring')
  assert.ok(Cartesian3.equalsEpsilon(a.position, Cartesian3.fromDegrees(10, 50, 9_000), 0, 1e-6))
  layer.update([fe('aaaaaa', { lat: 50.1, lon: 10, hM: 9_000 }), fe('bbbbbb', { lat: 45, lon: 5 })], null, null)
  assert.equal(bb(f, 'aaaaaa'), a, 'same Billboard object')
  assert.equal(bbs(f).length, 3)
  assert.ok(Cartesian3.equalsEpsilon(a.position, Cartesian3.fromDegrees(10, 50.1, 9_000), 0, 1e-6))
})

test('rotation = −track, about the local north axis, so the nose points along the track', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  layer.update([fe('aaaaaa', { lat: 47.3, lon: 11.4, trackDeg: 90 })], null, null)
  const b = bb(f, 'aaaaaa')
  near(b.rotation, -Math.PI / 2, 1e-12)
  const enu = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(11.4, 47.3, 0))
  const north = Matrix4.getColumn(enu, 1, new Cartesian4())
  assert.ok(Cartesian3.equalsEpsilon(b.alignedAxis, new Cartesian3(north.x, north.y, north.z), 1e-12), 'aligned axis = ENU north')
  layer.update([fe('aaaaaa', { lat: 47.3, lon: 11.4, trackDeg: 225 })], null, null)
  near(b.rotation, (-225 * Math.PI) / 180, 1e-12)
  layer.update([fe('aaaaaa', { lat: 47.3, lon: 11.4, trackDeg: null })], null, null)
  near(b.rotation, (-225 * Math.PI) / 180, 1e-12, 'no track → keep the last one')
  layer.update([fe('bbbbbb', { trackDeg: null })], null, null)
  assert.equal(bb(f, 'bbbbbb').rotation, 0, 'never had a track → north')
})

test('northAt is the unit ENU north vector', () => {
  for (const [lat, lon] of [[0, 0], [37.6, -122.4], [-33.9, 151.2], [89, 45]]) {
    const n = northAt(lat, lon, new Cartesian3())
    const enu = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(lon, lat, 0))
    const c = Matrix4.getColumn(enu, 1, new Cartesian4())
    assert.ok(Cartesian3.equalsEpsilon(n, new Cartesian3(c.x, c.y, c.z), 1e-12), `${lat}, ${lon}`)
  }
})

test('colour = altitude colour; ground grey; unknown altitude light grey', () => {
  const f = fakeViewer(100)
  const layer = new FleetLayer(f.viewer)
  layer.update([fe('aaaaaa', { altFt: 2_000 }), fe('bbbbbb', { altFt: 38_000 }), fe('cccccc', { onGround: true, altFt: null }), fe('dddddd', { altFt: null })], null, null)
  const css = (hex: string): Color => bb(f, hex).color
  assert.ok(css('aaaaaa').equalsEpsilon(Color.fromCssColorString(altitudeColor(2_000, false)), 1e-6))
  assert.ok(css('bbbbbb').equalsEpsilon(Color.fromCssColorString(altitudeColor(38_000, false)), 1e-6))
  assert.ok(css('cccccc').equalsEpsilon(Color.fromCssColorString(altitudeColor(null, true)), 1e-6))
  assert.ok(css('dddddd').equalsEpsilon(Color.fromCssColorString(altitudeColor(null, false)), 1e-6))
  layer.update([fe('aaaaaa', { altFt: 12_000 })], null, null)
  assert.ok(css('aaaaaa').equalsEpsilon(Color.fromCssColorString(altitudeColor(12_000, false)), 1e-6), 'climbing re-tints')
})

test('silhouette follows category/type; one atlas image per kind however many aircraft', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  const many = Array.from({ length: 60 }, (_, i) =>
    fe(`a${String(i).padStart(5, '0')}`, { info: info('x', { category: i % 3 === 0 ? 'A5' : 'A3' }) }),
  )
  layer.update([...many, fe('eeeeee', { info: null }), fe('ffffff', { info: info('ffffff', { category: null, typeCode: 'EC35' }) })], null, null)
  assert.equal(bb(f, 'a00000').image, ICON_ID.heavy)
  assert.equal(bb(f, 'a00001').image, ICON_ID.jet)
  assert.equal(bb(f, 'eeeeee').image, ICON_ID.unknown, 'no info → unknown')
  assert.equal(bb(f, 'ffffff').image, ICON_ID.heli, 'type-code fallback')
  assert.equal(atlasIds(f), 5, 'heavy, jet, unknown, heli + the ring: 62 aircraft share 4 textures')
  layer.update([fe('eeeeee', { info: info('eeeeee', { category: 'A7' }) })], null, null)
  assert.equal(bb(f, 'eeeeee').image, ICON_ID.heli, 'info arriving later swaps the icon')
})

test('selected: 1.4× with the ring on it, shown at any distance (top-down focus); deselect restores', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  layer.update([fe('aaaaaa'), fe('bbbbbb', { lat: 48 })], 'bbbbbb', null)
  const [a, b] = [bb(f, 'aaaaaa'), bb(f, 'bbbbbb')]
  assert.equal(b.scale, SELECTED_SCALE)
  assert.equal(SELECTED_SCALE, 1.4)
  assert.equal(a.scale, 1)
  assert.equal(halo(f).show, true)
  assert.ok(halo(f).position.equals(b.position), 'ring sits on the selected aircraft')
  assert.equal(halo(f).id, 'bbbbbb', 'clicking the ring picks the aircraft')
  assert.ok(!b.distanceDisplayCondition || b.distanceDisplayCondition.near === 0, 'a map zoomed in close still shows it')
  layer.update([fe('aaaaaa'), fe('bbbbbb', { lat: 48 })], null, null)
  assert.equal(b.scale, 1)
  assert.equal(halo(f).show, false)
})

test('entries older than their staleS are hidden, and shown again when fresh', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  layer.update([fe('aaaaaa', { ageS: 5 }), fe('bbbbbb', { ageS: 61 })], 'bbbbbb', 'bbbbbb')
  assert.equal(bb(f, 'aaaaaa').show, true)
  assert.equal(bb(f, 'bbbbbb').show, false)
  assert.equal(halo(f).show, false, 'no ring on a hidden aircraft')
  assert.equal(label(f).show, false, 'no label on a hidden aircraft')
  layer.update([fe('aaaaaa', { ageS: 5 }), fe('bbbbbb', { ageS: 2 })], null, null)
  assert.equal(bb(f, 'bbbbbb').show, true)
})

test('hexes that leave are hidden and their billboards reused for new hexes (no vertex-array rebuild churn)', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  layer.update([fe('aaaaaa'), fe('bbbbbb'), fe('cccccc')], null, null)
  const b = bb(f, 'bbbbbb')
  layer.update([fe('aaaaaa'), fe('cccccc')], null, null)
  assert.equal(b.show, false)
  assert.equal(bb(f, 'bbbbbb'), undefined, 'id cleared')
  f.pickResult = { id: 'bbbbbb' }
  assert.equal(layer.pick(new Cartesian2(1, 1)), null, 'a gone hex cannot be picked')
  layer.update([fe('aaaaaa'), fe('cccccc'), fe('dddddd', { lat: 40, trackDeg: 10, altFt: 1_000, info: info('dddddd', { category: 'A1' }) })], null, null)
  assert.equal(bbs(f).length, 4, 'three aircraft + ring: the freed billboard was reused')
  const d = bb(f, 'dddddd')
  assert.equal(d, b)
  assert.equal(d.show, true)
  assert.equal(d.image, ICON_ID.light)
  near(d.rotation, (-10 * Math.PI) / 180, 1e-12)
  assert.ok(Cartesian3.equalsEpsilon(d.position, Cartesian3.fromDegrees(10, 40, 10_000), 0, 1e-6))
  layer.update([], null, null)
  assert.equal(all(f).filter((x) => x.show).length, 0)
})

test('while the chased aircraft is drawn as the 3-D model, its icon, ring and label are hidden; the others stay', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  const es = [fe('aaaaaa'), fe('bbbbbb', { lat: 48, info: info('bbbbbb', { callsign: 'AFL729' }) })]
  layer.update(es, 'bbbbbb', null, true)
  assert.equal(bb(f, 'bbbbbb').show, false)
  assert.equal(bb(f, 'aaaaaa').show, true)
  assert.equal(halo(f).show, false)
  assert.equal(label(f).show, false)
  layer.update(es, 'bbbbbb', null, false) // no state yet (or the model failed to load): the icon and ring show where it is
  assert.equal(bb(f, 'bbbbbb').show, true)
  assert.equal(halo(f).show, true)
})

test('label: hover callsign, else the selected one; hex when no callsign; hidden when neither', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  const es = [fe('aaaaaa', { info: info('aaaaaa', { callsign: 'EZY12' }) }), fe('bbbbbb', { lat: 48, info: null })]
  layer.update(es, null, null)
  assert.equal(label(f).show, false)
  layer.update(es, 'aaaaaa', null)
  assert.equal(label(f).show, true)
  assert.equal(label(f).text, 'EZY12')
  assert.equal(label(f).id, 'aaaaaa')
  assert.ok(label(f).position.equals(bb(f, 'aaaaaa').position))
  layer.update(es, 'aaaaaa', 'bbbbbb')
  assert.equal(label(f).text, 'BBBBBB', 'hover wins; no callsign → hex')
  assert.ok(label(f).position.equals(bb(f, 'bbbbbb').position))
  layer.update(es, null, 'cccccc')
  assert.equal(label(f).show, false, 'hovering a hex that is not drawn')
  assert.equal(labels(f).length, 1, 'exactly one label, ever')
})

test('on the ground: placed on the loaded terrain, sampled once and re-sampled only after moving ~200 m', () => {
  const f = fakeViewer(412)
  const layer = new FleetLayer(f.viewer)
  const g = (lat: number): FleetEntry => fe('aaaaaa', { onGround: true, altFt: null, hM: 48, lat })
  layer.update([g(47.26)], null, null)
  assert.equal(f.heightCalls, 1)
  near(Cartographic.fromCartesian(bb(f, 'aaaaaa').position).height, 412 + GROUND_LIFT_M, 1e-3)
  layer.update([g(47.2601)], null, null)
  layer.update([g(47.2602)], null, null)
  assert.equal(f.heightCalls, 1, '11 m of taxiing: cached')
  layer.update([g(47.263)], null, null)
  assert.equal(f.heightCalls, 2, '330 m: re-sampled')
  layer.update([fe('bbbbbb', { hM: 5_000 })], null, null)
  assert.equal(f.heightCalls, 2, 'airborne aircraft never sample terrain')
})

test('on the ground before the terrain tile loads: at hM, retried a little later', () => {
  const f = fakeViewer(undefined)
  const layer = new FleetLayer(f.viewer)
  const g = fe('aaaaaa', { onGround: true, altFt: null, hM: 48 })
  layer.update([g], null, null)
  near(Cartographic.fromCartesian(bb(f, 'aaaaaa').position).height, 48, 1e-3)
  const calls = f.heightCalls
  for (let i = 0; i < 10; i++) layer.update([g], null, null)
  assert.equal(f.heightCalls, calls, 'not every frame')
  f.groundH = 300
  for (let i = 0; i < 60; i++) layer.update([g], null, null)
  near(Cartographic.fromCartesian(bb(f, 'aaaaaa').position).height, 300 + GROUND_LIFT_M, 1e-3)
})

// Terrain exaggeration (design D7). LOWI: runway HAE (the relH Topography latches there) and an apron's true HAE.
const LOWI_RWY = 627.72
const APRON = 580
const heightOf = (f: F, hex: string): number => Cartographic.fromCartesian(bb(f, hex).position).height

test('exaggerated terrain: a ground icon keeps the TRUE height and follows a sink and a grow without sampling', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  const g = fe('aaaaaa', { onGround: true, altFt: null, hM: 48, lat: 47.26, lon: 11.35 })
  const frame = (fSampled: number, fNow: number): void => {
    f.groundH = drawnHeightM(APRON, fSampled, LOWI_RWY) // globe.getHeight: the surface of the last render
    layer.setTerrain({ fSampled, fNow, relHM: LOWI_RWY })
    layer.update([g], null, null)
  }
  frame(TOPO_ON, TOPO_ON)
  near(heightOf(f, 'aaaaaa'), APRON + GROUND_LIFT_M, 0.01)
  const calls = f.heightCalls
  let fPrev = TOPO_ON
  for (let i = 1; i <= 150; i++) { // a 2.5 s sink at 60 fps: 1 + 1e-5 → 0
    const fNow = TOPO_ON * (1 - smoothstep(i / 150))
    frame(fPrev, fNow)
    near(heightOf(f, 'aaaaaa'), drawnHeightM(APRON, fNow, LOWI_RWY) + GROUND_LIFT_M, 1e-3, `sink frame ${i}`)
    fPrev = fNow
  }
  assert.equal(f.heightCalls, calls, 'arithmetic only: no terrain sample during the animation')
  near(heightOf(f, 'aaaaaa'), LOWI_RWY + GROUND_LIFT_M, 1e-3, 'flat: on the plane')
  for (let i = 0; i < 700; i++) frame(0, 0) // frames 152–851
  // the ~10 s refresh (frame 601) reads the flat surface, which holds no relief: kept, and retried every 30 frames
  assert.equal(f.heightCalls - calls, 9, 'frames 601, 631, …, 841')
  near(heightOf(f, 'aaaaaa'), LOWI_RWY + GROUND_LIFT_M, 1e-3, 'still on the plane')
  fPrev = 0
  for (let i = 1; i <= 150; i++) { // grow back: the cached true height is still there
    const fNow = TOPO_ON * smoothstep(i / 150)
    frame(fPrev, fNow)
    near(heightOf(f, 'aaaaaa'), drawnHeightM(APRON, fNow, LOWI_RWY) + GROUND_LIFT_M, 1e-3, `grow frame ${i}`)
    fPrev = fNow
  }
  near(heightOf(f, 'aaaaaa'), APRON + GROUND_LIFT_M, 0.01)
})

test('exaggerated terrain: a sample is un-exaggerated with the factor the tiles held (fSampled), drawn at fNow', () => {
  const f = fakeViewer(drawnHeightM(APRON, 0.7, LOWI_RWY))
  const layer = new FleetLayer(f.viewer)
  layer.setTerrain({ fSampled: 0.7, fNow: 0.69, relHM: LOWI_RWY }) // mid-sink, first sample
  layer.update([fe('aaaaaa', { onGround: true, altFt: null, hM: 48, lat: 47.26, lon: 11.35 })], null, null)
  assert.equal(f.heightCalls, 1)
  near(heightOf(f, 'aaaaaa'), drawnHeightM(APRON, 0.69, LOWI_RWY) + GROUND_LIFT_M, 1e-3)
})

test('exaggerated terrain: while flat, a new ground icon sits on the plane, retries ~2 per s, and finds its height as the relief grows', () => {
  const f = fakeViewer(LOWI_RWY - 0.03) // a flat surface, read a little low (the picker's flat-triangle error)
  const layer = new FleetLayer(f.viewer)
  const g = fe('aaaaaa', { onGround: true, altFt: null, hM: 48, lat: 47.26, lon: 11.35 })
  layer.setTerrain({ fSampled: 1e-7, fNow: 1e-7, relHM: LOWI_RWY }) // flat after Topography's nudge
  for (let i = 0; i < 90; i++) layer.update([g], null, null)
  near(heightOf(f, 'aaaaaa'), LOWI_RWY + GROUND_LIFT_M, 1e-3, 'on the plane, like every sampled icon')
  assert.equal(f.heightCalls, 3, 'frames 1, 31 and 61: not every frame')
  let fPrev = 1e-7
  for (let i = 1; i <= 150; i++) {
    const fNow = TOPO_ON * smoothstep(i / 150)
    f.groundH = drawnHeightM(APRON, fPrev, LOWI_RWY)
    layer.setTerrain({ fSampled: fPrev, fNow, relHM: LOWI_RWY })
    layer.update([g], null, null)
    fPrev = fNow
  }
  near(heightOf(f, 'aaaaaa'), APRON + GROUND_LIFT_M, 0.01, 'sampled once the relief could be recovered')
})

test('exaggerated terrain: airborne icons stay at hM; a non-finite frame is ignored; factor 1 around 0 is the default', () => {
  const f = fakeViewer(412)
  const layer = new FleetLayer(f.viewer)
  const es = [fe('aaaaaa', { hM: 3_000 }), fe('bbbbbb', { onGround: true, altFt: null, hM: 48, lat: 47.3 })]
  layer.update(es, null, null)
  const before = [heightOf(f, 'aaaaaa'), heightOf(f, 'bbbbbb')]
  layer.setTerrain({ fSampled: 1, fNow: 1, relHM: 0 })
  layer.update(es, null, null)
  assert.deepEqual([heightOf(f, 'aaaaaa'), heightOf(f, 'bbbbbb')], before, 'the same as never calling setTerrain')
  layer.setTerrain({ fSampled: 1, fNow: 0.5, relHM: 100 })
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    layer.setTerrain({ fSampled: bad, fNow: 0.5, relHM: 100 })
    layer.setTerrain({ fSampled: 1, fNow: bad, relHM: 100 })
    layer.setTerrain({ fSampled: 1, fNow: 0.5, relHM: bad })
  }
  layer.update(es, null, null)
  near(heightOf(f, 'aaaaaa'), 3_000, 1e-3, 'airborne: true HAE whatever the terrain does')
  near(heightOf(f, 'bbbbbb'), drawnHeightM(412, 0.5, 100) + GROUND_LIFT_M, 1e-3, 'the last finite frame')
})

test('exaggerated terrain: an undefined reading (the picker race during a toggle) keeps the cached height and retries ~2 per s', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  const g = fe('aaaaaa', { onGround: true, altFt: null, hM: 48, lat: 47.26, lon: 11.35 })
  const frame = (fSampled: number, fNow: number, reading: number | undefined): void => {
    f.groundH = reading
    layer.setTerrain({ fSampled, fNow, relHM: LOWI_RWY })
    layer.update([g], null, null)
  }
  for (let i = 1; i <= 590; i++) frame(TOPO_ON, TOPO_ON, drawnHeightM(APRON, TOPO_ON, LOWI_RWY)) // sampled at frame 1
  const calls = f.heightCalls
  let fPrev = TOPO_ON
  for (let i = 1; i <= 150; i++) { // a sink from frame 591: every reading fails, the ~10 s refresh (frame 601) too
    const fNow = TOPO_ON * (1 - smoothstep(i / 150))
    frame(fPrev, fNow, undefined)
    near(heightOf(f, 'aaaaaa'), drawnHeightM(APRON, fNow, LOWI_RWY) + GROUND_LIFT_M, 1e-3, `sink frame ${i}`)
    fPrev = fNow
  }
  assert.equal(f.heightCalls - calls, 5, 'frames 601, 631, …, 721: retried, not every frame')
  near(heightOf(f, 'aaaaaa'), LOWI_RWY + GROUND_LIFT_M, 1e-3, 'flat: on the plane')
})

test('exaggerated terrain: an airborne icon below the flattened relief is drawn on it, not hidden under it; above it, at its true HAE', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  // flattened around LOWI's runway, seen from browse (D9): a KSFO final at 300 m over ground at ≈ −30 m; cruise traffic
  const es = [fe('aaaaaa', { hM: 300, lat: 37.6, lon: -122.3 }), fe('bbbbbb', { hM: 3_000 })]
  const cases: [number, number, string][] = [
    [0, LOWI_RWY + GROUND_LIFT_M, 'flat: on the plane, + the lift, like a ground icon'],
    [0.5, drawnHeightM(300, 0.5, LOWI_RWY) + GROUND_LIFT_M / 2, 'mid-grow: where 300 m is drawn'],
    [1, 300, 'the terrain as loaded: true HAE'],
    [TOPO_ON, 300, 'on: true HAE'],
  ]
  for (const [fNow, want, what] of cases) {
    layer.setTerrain({ fSampled: fNow, fNow, relHM: LOWI_RWY })
    layer.update(es, null, null)
    near(heightOf(f, 'aaaaaa'), want, 1e-3, what)
    assert.ok(heightOf(f, 'aaaaaa') > drawnHeightM(-30, fNow, LOWI_RWY) + 1, `above the drawn ground at f ${fNow}`)
    near(heightOf(f, 'bbbbbb'), 3_000, 1e-3, `above relH at f ${fNow}: true HAE (D4)`)
  }
})

test('an unchanged frame touches no billboard property; a moving aircraft touches only its position', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  const es = [fe('aaaaaa'), fe('bbbbbb', { lat: 48 })]
  layer.update(es, 'aaaaaa', 'bbbbbb')
  const before = changes(f)
  layer.update(es, 'aaaaaa', 'bbbbbb')
  assert.deepEqual(changes(f), before)
  es[1].lat += 0.001
  layer.update(es, 'aaaaaa', 'bbbbbb')
  const diff = changes(f).map((v, i) => v - before[i])
  const POSITION_INDEX = 1
  assert.equal(diff[POSITION_INDEX], 1, 'one position write')
  assert.equal(diff.reduce((s, v) => s + v, 0), 1, 'nothing else')
})

test('moves below a quarter pixel on screen are not written; they add up until they show', () => {
  // 1,000 km above the aircraft, 1 mrad per pixel: a quarter pixel is ~250 m there
  const f = fakeViewer(undefined, Cartesian3.fromDegrees(10, 50, 1_010_000))
  const layer = new FleetLayer(f.viewer)
  const e = fe('aaaaaa', { lat: 50, lon: 10, hM: 10_000 })
  layer.update([e], null, null)
  const b = bb(f, 'aaaaaa')
  const first = b.position.clone()
  const POSITION_INDEX = 1
  const writes = (): number => changes(f)[POSITION_INDEX]
  const w0 = writes()
  e.lat += 0.001 // 111 m
  layer.update([e], null, null)
  e.lat += 0.001 // 222 m in total
  layer.update([e], null, null)
  assert.equal(writes(), w0, 'not written')
  assert.ok(b.position.equals(first))
  e.lat += 0.001 // 333 m since the last write
  layer.update([e], null, null)
  assert.equal(writes(), w0 + 1)
  assert.ok(Cartesian3.equalsEpsilon(b.position, Cartesian3.fromDegrees(10, 50.003, 10_000), 0, 1e-6))
  e.lon += 0.002 // 143 m east at 50° N
  layer.update([e], null, null)
  assert.equal(writes(), w0 + 1, 'not written')
  e.lon += 0.003 // 358 m east since the last write
  layer.update([e], null, null)
  assert.equal(writes(), w0 + 2, 'eastward moves count too')

  const close = fakeViewer(undefined, Cartesian3.fromDegrees(10, 50, 10_500)) // chase range: 500 m away
  const layer2 = new FleetLayer(close.viewer)
  const e2 = fe('bbbbbb', { lat: 50, lon: 10, hM: 10_000 })
  layer2.update([e2], null, null)
  e2.lat += 0.00005 // 5.6 m, ~11 px at 500 m
  layer2.update([e2], null, null)
  assert.ok(Cartesian3.equalsEpsilon(bb(close, 'bbbbbb').position, Cartesian3.fromDegrees(10, 50.00005, 10_000), 0, 1e-6), 'written')
})

test('pick returns the hex under the cursor (icon, ring or label), null otherwise', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  layer.update([fe('a1b2c3')], 'a1b2c3', null)
  const at = new Cartesian2(100, 200)
  f.pickResult = { primitive: bb(f, 'a1b2c3'), id: 'a1b2c3' }
  assert.equal(layer.pick(at), 'a1b2c3')
  assert.equal(f.pickedAt, at)
  f.pickResult = { primitive: halo(f), id: halo(f).id }
  assert.equal(layer.pick(at), 'a1b2c3')
  f.pickResult = { id: label(f).id }
  assert.equal(layer.pick(at), 'a1b2c3')
  f.pickResult = undefined
  assert.equal(layer.pick(at), null, 'nothing under the cursor')
  f.pickResult = { id: 'ffffff' }
  assert.equal(layer.pick(at), null, 'a hex this layer does not draw')
  f.pickResult = { id: { name: 'an entity' } }
  assert.equal(layer.pick(at), null, 'another layer’s object')
})

test('destroy removes and destroys both collections', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  layer.update([fe('a1b2c3')], null, null)
  const [b, l] = [bbs(f), labels(f)]
  layer.destroy()
  assert.equal(f.added.length, 0)
  assert.ok(b.isDestroyed())
  assert.ok(l.isDestroyed())
})

test('chase traffic: only aircraft in range show; model hexes are placed with their icon hidden (positionOf)', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  const view = { near: new Set(['aaaaaa', 'bbbbbb']), models: new Set(['aaaaaa']) }
  const es = [fe('aaaaaa', { lat: 50, lon: 10, hM: 9_000 }), fe('bbbbbb'), fe('cccccc'), fe('dddddd')]
  layer.update(es, 'dddddd', null, false, view)
  assert.equal(bb(f, 'aaaaaa').show, false, 'drawn as a model')
  assert.ok(Cartesian3.equalsEpsilon(layer.positionOf('aaaaaa')!, Cartesian3.fromDegrees(10, 50, 9_000), 0, 1e-6))
  assert.equal(bb(f, 'bbbbbb').show, true, 'in range, no model: its icon')
  assert.equal(bb(f, 'cccccc').show, false, 'out of range')
  assert.equal(layer.positionOf('cccccc'), undefined)
  assert.equal(bb(f, 'dddddd').show, true, 'the selected one is not ranged')
  layer.update(es, 'dddddd', null)
  for (const h of ['aaaaaa', 'bbbbbb', 'cccccc', 'dddddd']) assert.equal(bb(f, h).show, true, `browse: ${h} an icon again`)
})

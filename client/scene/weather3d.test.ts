// client/scene/weather3d.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cartesian3, Cartographic, Color, JulianDate, Math as CesiumMath } from 'cesium'
import type { ColorMaterialProperty, CustomDataSource, Entity, Viewer } from 'cesium'
import { distanceNm } from '../../shared/geo.ts'
import { geoidN } from '../../shared/geoid.ts'
import type { Cloud, Metar, Sigmet } from '../../shared/wx.ts'
import type { TerrainFrame } from '../types.ts'
import { DEFAULT_UNITS, type Units } from '../ui/units.ts'
import { LOOKS, nearestClouds, observedClouds, type CloudSpec } from './cloudField.ts'
import { fogNear, type Fog } from './groundFog.ts'
import type { LayerLabel } from './placeLabels.ts'
import { radarPixel, windOf, type Fall } from './precip.ts'
import { RadarSource, type SourceTile } from './radar.ts'
import { HAZARD_KM, Weather3D, parseWxAt, statusText3d } from './weather3d.ts'
import { sigmetColor, sigmetLabel } from './wxText.ts'

type Ring = [number, number][]
const FT = 0.3048
const KM_PER_DEG = 111.195 // of latitude, on a sphere of 6,371 km
const NOW = JulianDate.now()
const lonlat = (c: Cartesian3): [number, number] => {
  const p = Cartographic.fromCartesian(c)
  return [CesiumMath.toDegrees(p.longitude), CesiumMath.toDegrees(p.latitude)]
}
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol

test('parseWxAt: ?wxat=lat,lon, in degrees; anything else is none', () => {
  assert.deepEqual(parseWxAt('?wxat=47.46,8.55'), { lat: 47.46, lon: 8.55 })
  assert.deepEqual(parseWxAt('?hex=4b1805&wxat=-33.9, 151.2&chase=1'), { lat: -33.9, lon: 151.2 })
  assert.deepEqual(parseWxAt('?wxat=-90,-180'), { lat: -90, lon: -180 })
  for (const bad of ['', '?hex=4b1805', '?wxat=', '?wxat=abc', '?wxat=47', '?wxat=47,8,1', '?wxat=,8', '?wxat=47,', '?wxat=91,0', '?wxat=0,181', '?wxat=NaN,1', '?wxat=1e999,1']) {
    assert.equal(parseWxAt(bad), null, bad)
  }
})

test('statusText3d: clouds from the airports held, the hazard areas, a note; singular for one', () => {
  assert.equal(statusText3d({ airports: 3, areas: 2, note: '' }), 'Clouds from 3 airports · 2 hazard areas')
  assert.equal(statusText3d({ airports: 1, areas: 1, note: '' }), 'Clouds from 1 airport · 1 hazard area')
  assert.equal(statusText3d({ airports: 0, areas: 0, note: '' }), 'Clouds from 0 airports · 0 hazard areas')
  assert.equal(statusText3d({ airports: 3, areas: 0, note: 'some weather unavailable' }), 'Clouds from 3 airports · 0 hazard areas · some weather unavailable')
})

/** The ring a lon/lat box makes, closed as GeoJSON closes it. */
const box = (south: number, west: number, north: number, east: number): Ring => [[west, south], [east, south], [east, north], [west, north], [west, south]]

const sigmet = (o: Partial<Sigmet> & { rings: Ring[] }): Sigmet => ({ hazard: 'TS', qualifier: 'EMBD', base: null, top: 35000, until: '2026-10-03T06:00:00Z', raw: '', ...o })
const AC = { lat: 32.1, lon: 34.9, altM: 10_000 }
/** A box whose south edge is km due north of the aircraft, 2° wide round its meridian, height° tall. */
const northOf = (km: number, height = 1): Ring => box(AC.lat + km / KM_PER_DEG, AC.lon - 1, AC.lat + km / KM_PER_DEG + height, AC.lon + 1)

// ---- Weather3D --------------------------------------------------------------------------------------------------------

const HOST = 'https://tilecache.rainviewer.com'
const INDEX = { host: HOST, radar: { past: [{ time: 1759420200, path: '/v2/radar/old' }, { time: 1759420800, path: '/v2/radar/new' }] } }
/** A report of a clear sky (CAVOK) unless o says otherwise. */
const metar = (id: string, lat: number, lon: number, o: Partial<Metar> = {}): Metar => ({
  id, name: id, lat, lon, elevM: 30, obsMs: null, cat: 'VFR', wdir: null, wspd: 0, wgst: null, visKm: null, visPlus: true, tempC: null, dewC: null,
  qnhHpa: null, wx: null, clouds: [], vertVisFt: null, raw: `METAR ${id} 031200Z 27010KT CAVOK 25/12 Q1015`, ...o,
})
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const MIN = 60_000

type Kind = 'metar' | 'sigmet' | 'radar'
interface LabelCall { key: string; rank: number; labels: LayerLabel[] }

/** What a fake sky was told: every draw, frame and set. */
function fakeSky() {
  return {
    clouds: {
      show: false, draws: [] as CloudSpec[][], frames: [] as [TerrainFrame, number][], fades: [] as Cartesian3[], destroyed: false,
      draw(specs: readonly CloudSpec[]) { this.draws.push([...specs]) },
      frame(tf: TerrainFrame, night: number) { this.frames.push([{ ...tf }, night]) },
      fade(from: Cartesian3) { this.fades.push(Cartesian3.clone(from)) },
      destroy() { this.destroyed = true },
    },
    fog: {
      sets: [] as (Fog | null)[], frames: [] as [TerrainFrame, number][], destroyed: false,
      set(f: Fog | null) { this.sets.push(f) },
      frame(tf: TerrainFrame, night: number) { this.frames.push([{ ...tf }, night]) },
      destroy() { this.destroyed = true },
    },
    precip: {
      sets: [] as (Fall | null)[], aims: [] as number[], destroyed: false,
      set(f: Fall | null) { this.sets.push(f) },
      aim(headingRad: number) { this.aims.push(headingRad) },
      destroy() { this.destroyed = true },
    },
  }
}

/**
 * A Weather3D over a fake viewer (its camera at the aircraft until moved), names overlay, sky, radar tiles and network: what
 * was asked, answered from `answers` (or failed, or held until release()).
 */
function rig(o: { at?: { lat: number; lon: number } } = {}) {
  const asked: string[] = []
  const answers: Record<Kind, unknown> = { metar: [], sigmet: [], radar: INDEX }
  const failing = new Set<Kind>()
  const hold = new Set<Kind>()
  const held: (() => void)[] = []
  const getJson = async (url: string): Promise<unknown> => {
    asked.push(url)
    const kind: Kind = url.includes('/wx/metar') ? 'metar' : url.includes('/wx/sigmet') ? 'sigmet' : 'radar'
    const answer = structuredClone(answers[kind]) // as it is when asked
    if (hold.has(kind)) await new Promise<void>((resolve) => held.push(resolve)) // until release(), when it is answered or fails as `failing` then says
    if (failing.has(kind)) throw new Error(`${kind} down`)
    return answer
  }
  const sources: CustomDataSource[] = []
  const removed: [CustomDataSource, boolean | undefined][] = []
  const camera = { positionCartographic: Cartographic.fromDegrees(AC.lon, AC.lat, AC.altM), heading: 0 }
  let ground: number | undefined
  let gone = false // the viewer destroyed
  const viewer = {
    dataSources: { add: async (ds: CustomDataSource) => void sources.push(ds), remove: async (ds: CustomDataSource, destroy?: boolean) => void removed.push([ds, destroy]) },
    isDestroyed: () => gone,
    camera,
    scene: { globe: { getHeight: (): number | undefined => ground } },
  } as unknown as Viewer
  const labelCalls: LabelCall[] = []
  const labels = { setLayer: (key: string, rank: number, ls: readonly LayerLabel[]) => void labelCalls.push({ key, rank, labels: [...ls] }) }
  const lines: (string | null)[] = []
  let units: Units = DEFAULT_UNITS
  const sky = fakeSky()
  const tiles = new Map<string, SourceTile>() // z/x/y
  const tileAsks: string[] = []
  const tile = async (_r: RadarSource, z: number, x: number, y: number): Promise<SourceTile | null> => {
    tileAsks.push(`${z}/${x}/${y}`)
    return tiles.get(`${z}/${x}/${y}`) ?? null
  }
  const w = new Weather3D(viewer, { apiBase: '/api', labels, getJson, onStatus: (t) => lines.push(t), units: () => units, at: o.at, sky, tile })
  return {
    w, asked, answers, failing, hold, sources, removed, labelCalls, lines, sky, tiles, tileAsks,
    setCamera: (lat: number, lon: number, hM: number): void => void Cartographic.fromDegrees(lon, lat, hM, camera.positionCartographic),
    setGround: (hM: number | undefined): void => void (ground = hM),
    setHeading: (rad: number): void => void (camera.heading = rad),
    destroyViewer: (): void => void (gone = true),
    release: () => held.splice(0).forEach((f) => f()),
    volumes: (): Entity[] => [...sources[0].entities.values], // a copy: the collection's own array changes as it does
    shown: (): LayerLabel[] => labelCalls.at(-1)?.labels ?? [], // the labels the overlay holds for the layer now
    asks: (what: 'metar' | 'sigmet' | 'weather-maps'): string[] => asked.filter((u) => u.includes(what === 'metar' ? '/wx/metar' : what === 'sigmet' ? '/wx/sigmet' : 'weather-maps')),
    setUnits: (u: Units): void => void (units = u),
  }
}
type Rig = ReturnType<typeof rig>

/** Shown, given the aircraft, and its first asks answered. */
async function open(r: Rig, at: { lat: number; lon: number; altM: number } = AC, nowMs = 0): Promise<void> {
  r.w.show = true
  r.w.update(at, nowMs)
  await flush()
}

const polygon = (e: Entity): { baseM: number; topM: number; fill: Color; line: Color; outlined: boolean; ring: [number, number][] } => {
  const g = e.polygon!
  return {
    baseM: g.height!.getValue(NOW) as number,
    topM: g.extrudedHeight!.getValue(NOW) as number,
    fill: (g.material as ColorMaterialProperty).color!.getValue(NOW) as Color,
    line: g.outlineColor!.getValue(NOW) as Color,
    outlined: g.outline!.getValue(NOW) as boolean,
    ring: (g.hierarchy!.getValue(NOW) as { positions: Cartesian3[] }).positions.map(lonlat),
  }
}

test('Weather3D: hidden it asks for nothing and draws nothing, however often it is updated', async () => {
  const r = rig()
  assert.equal(r.w.show, false)
  r.answers.sigmet = [sigmet({ rings: [northOf(100)] })]
  for (let t = 0; t < 20 * MIN; t += 1000) r.w.update(AC, t)
  await flush()
  assert.deepEqual(r.asked, [])
  assert.equal(r.volumes().length, 0)
  assert.deepEqual(r.labelCalls, [])
  assert.deepEqual(r.lines, [])
  assert.equal(r.sources[0].show, false, 'its data source is in the viewer, hidden')
})

test('Weather3D: shown it asks at the first update with an aircraft: METARs of a whole-degree box 2° round it, SIGMETs, RainViewer\'s index', async () => {
  const r = rig()
  r.w.show = true
  assert.deepEqual(r.asked, [], 'showing asks nothing: the aircraft is not known yet')
  r.w.update(null, 0)
  r.w.update({ lat: Number.NaN, lon: 34, altM: 0 }, 0)
  r.w.update({ lat: 32, lon: Number.POSITIVE_INFINITY, altM: 0 }, 0)
  assert.deepEqual(r.asked, [], 'no aircraft, or a place that is not one')
  r.w.update(AC, 0)
  await flush()
  assert.deepEqual(r.asks('metar'), ['/api/wx/metar?bbox=30,32,35,37']) // 30.1 → 30, 32.9 → 32, 34.1 → 35, 36.9 → 37
  assert.deepEqual(r.asks('sigmet'), ['/api/wx/sigmet'])
  assert.deepEqual(r.asks('weather-maps'), ['https://api.rainviewer.com/public/weather-maps.json'])
  assert.equal(r.asked.length, 3)
})

test('Weather3D: the box is cut at the poles and the antimeridian', async () => {
  const north = rig()
  await open(north, { lat: 89.5, lon: 179.5, altM: 0 })
  assert.deepEqual(north.asks('metar'), ['/api/wx/metar?bbox=87,177,90,180'])
  const south = rig()
  await open(south, { lat: -89.5, lon: -179.5, altM: 0 })
  assert.deepEqual(south.asks('metar'), ['/api/wx/metar?bbox=-90,-180,-87,-177'])
})

test('Weather3D: update() runs every frame and looks once a second: the frames between ask, draw and write nothing', async () => {
  const r = rig()
  r.answers.sigmet = [sigmet({ rings: [northOf(100)] })]
  await open(r)
  const [asked, calls, entities] = [r.asked.length, r.labelCalls.length, r.volumes().length]
  assert.ok(asked > 0 && calls > 0 && entities > 0)
  r.answers.sigmet = []
  const last = { ...AC, lat: AC.lat + 0.0999 }
  for (let t = 1; t < 1000; t++) r.w.update({ ...AC, lat: AC.lat + t * 1e-4 }, t) // 999 frames
  r.w.update(last, 999)
  await flush()
  assert.deepEqual([r.asked.length, r.labelCalls.length, r.volumes().length], [asked, calls, entities])
  assert.deepEqual(r.w.aircraft, last, 'the aircraft it holds is the newest frame\'s')
  r.w.update(AC, 5 * MIN - 500) // a look: nothing due yet
  r.w.update(AC, 5 * MIN) // the METARs are due, but half a second after a look is not a look
  await flush()
  assert.equal(r.asks('metar').length, 1)
  r.w.update(AC, 5 * MIN + 500)
  await flush()
  assert.equal(r.asks('metar').length, 2, 'asked at the next look')
})

test('Weather3D: METARs every 5 min, SIGMETs and the radar frame every 10, and METARs at once when the aircraft leaves its box', async () => {
  const r = rig()
  await open(r) // box 30,32,35,37
  const n = (): number[] => [r.asks('metar').length, r.asks('sigmet').length, r.asks('weather-maps').length]
  assert.deepEqual(n(), [1, 1, 1])
  r.w.update(AC, 5 * MIN - 1000)
  await flush()
  assert.deepEqual(n(), [1, 1, 1], 'not yet')
  r.w.update(AC, 5 * MIN)
  await flush()
  assert.deepEqual(n(), [2, 1, 1], 'METARs again, the same box')
  assert.equal(r.asks('metar')[1], r.asks('metar')[0])
  r.w.update({ ...AC, lat: AC.lat + 1 }, 5 * MIN + 1000) // inside the box (to 35°): nothing, though it is a new place
  await flush()
  assert.deepEqual(n(), [2, 1, 1])
  r.w.update({ ...AC, lat: 35.2 }, 5 * MIN + 2000) // out of it by the north: the new box, the 5 min not up
  await flush()
  assert.deepEqual(n(), [3, 1, 1])
  assert.equal(r.asks('metar')[2], '/api/wx/metar?bbox=33,32,38,37')
  r.w.update({ ...AC, lat: 35.2 }, 10 * MIN - 1000)
  await flush()
  assert.deepEqual(n(), [3, 1, 1])
  r.w.update({ ...AC, lat: 35.2 }, 10 * MIN)
  await flush()
  assert.deepEqual(n(), [3, 2, 2], 'SIGMETs and the radar frame at 10 min; the METARs of the new box are not due until 10 min 2 s')
  r.w.update({ ...AC, lat: 35.2 }, 10 * MIN + 2000)
  await flush()
  assert.deepEqual(n(), [4, 2, 2])
})

test('Weather3D: the aircraft on the box\'s edge is in it; one step beyond is out', async () => {
  const r = rig()
  await open(r, { lat: 32.5, lon: 34.5, altM: 0 }) // 30.5 → 30, 32.5 → 32, 34.5 → 35, 36.5 → 37
  assert.deepEqual(r.asks('metar'), ['/api/wx/metar?bbox=30,32,35,37'])
  r.w.update({ lat: 35, lon: 37, altM: 0 }, 1000)
  await flush()
  assert.equal(r.asks('metar').length, 1, 'on its north-east corner')
  r.w.update({ lat: 35, lon: 37.001, altM: 0 }, 2000)
  await flush()
  assert.equal(r.asks('metar').length, 2)
})

test('Weather3D: what it keeps for the pieces that draw: the METARs, the SIGMETs, the radar frame\'s RadarSource, the aircraft', async () => {
  const r = rig()
  assert.deepEqual([r.w.metars, r.w.sigmets, r.w.radar, r.w.aircraft], [[], [], null, null])
  r.answers.metar = [metar('LLBG', 32.01, 34.89), metar('LLHA', 32.81, 35.04)]
  r.answers.sigmet = [sigmet({ rings: [northOf(100)] })]
  await open(r)
  assert.deepEqual(r.w.metars.map((m) => m.id), ['LLBG', 'LLHA'])
  assert.equal(r.w.metars[0].elevM, 30)
  assert.equal(r.w.sigmets.length, 1)
  assert.ok(r.w.radar instanceof RadarSource)
  assert.equal(r.w.radar.url, `${HOST}/v2/radar/new/256/{z}/{x}/{y}/2/0_1.png`, 'the newest past frame')
  assert.deepEqual(r.w.aircraft, AC)
  assert.deepEqual(r.w.shift, { dLat: 0, dLon: 0 })
  const frame = r.w.radar
  r.w.update(AC, 10 * MIN)
  await flush()
  assert.equal(r.w.radar, frame, 'the same frame again: its source, and the tiles it holds, stay')
  r.answers.radar = { host: HOST, radar: { past: [{ time: 1759421400, path: '/v2/radar/newer' }] } }
  r.w.update(AC, 20 * MIN)
  await flush()
  assert.notEqual(r.w.radar, frame)
  assert.match(r.w.radar!.url, /\/v2\/radar\/newer\//)
})

test('Weather3D: hazard areas within 800 km are translucent volumes from base to top: 0.10 fill, 0.6 outline, the hazard\'s colour', async () => {
  const r = rig()
  const ts = sigmet({ rings: [northOf(300, 2)], base: 18000, top: 35000 })
  const turb = sigmet({ hazard: 'TURB', qualifier: 'SEV', rings: [northOf(500, 2), northOf(2000, 2)] }) // base none: from the ground
  r.answers.sigmet = [ts, turb, sigmet({ rings: [northOf(900)] }), sigmet({ rings: [northOf(200)], top: null })]
  await open(r)
  const got = r.volumes().map(polygon)
  assert.equal(got.length, 2, 'the ring at 2,000 km, the area at 900 and the one without a top are not drawn')
  const [a, b] = got
  assert.deepEqual([a.baseM, a.topM, b.baseM, b.topM], [18000 * FT, 35000 * FT, 0, 35000 * FT])
  const red = Color.fromCssColorString(sigmetColor('TS'))
  const amber = Color.fromCssColorString(sigmetColor('TURB'))
  assert.ok(a.fill.equals(red.withAlpha(0.1)), String(a.fill))
  assert.ok(a.line.equals(red.withAlpha(0.6)), String(a.line))
  assert.ok(b.fill.equals(amber.withAlpha(0.1)) && b.line.equals(amber.withAlpha(0.6)))
  assert.deepEqual([a.outlined, b.outlined], [true, true])
  assert.ok(a.ring.some(([lon, lat]) => near(lon, AC.lon - 1, 1e-6) && near(lat, AC.lat + 300 / KM_PER_DEG, 1e-6)), 'the ring as the SIGMET gives it')
  assert.equal(r.w.hazards.length, 2)
  assert.equal(r.sources[0].show, true)
})

test('Weather3D: the reach is 800 km from the aircraft, and a ring across the far meridian is not in it (it was "inside")', async () => {
  assert.equal(HAZARD_KM, 800)
  const r = rig()
  r.answers.sigmet = [sigmet({ rings: [northOf(790)] }), sigmet({ rings: [northOf(810)] }), sigmet({ rings: [box(25, -150, 40, -140)] })] // the last is 150°W to 140°W
  await open(r) // over Tel Aviv
  assert.deepEqual([r.w.hazards.length, r.volumes().length, r.shown().length], [1, 1, 1])
  const across: Ring = [[179, -1], [-179, -1], [-179, 1], [179, 1], [179, -1]]
  const far = rig()
  far.answers.sigmet = [sigmet({ rings: [across] })]
  await open(far, { lat: 0, lon: 0, altM: 0 })
  assert.deepEqual([far.w.hazards.length, far.volumes().length, far.shown().length], [0, 0, 0])
  const inside = rig()
  inside.answers.sigmet = [sigmet({ rings: [across] })]
  await open(inside, { lat: 0, lon: 179.6, altM: 0 })
  assert.deepEqual([inside.w.hazards.length, inside.volumes().length, inside.shown().length], [1, 1, 1])
})

test('Weather3D: each hazard area\'s name and levels is a label at its ring\'s middle, at the top height, through the names overlay (a rank above the cities)', async () => {
  const r = rig()
  const ts = sigmet({ rings: [northOf(300, 2)], base: 18000, top: 35000 })
  const ice = sigmet({ hazard: 'ICE', qualifier: 'MOD', top: 12000, rings: [northOf(500, 1), northOf(100, 1)] })
  r.answers.sigmet = [ts, ice]
  await open(r)
  assert.deepEqual(r.labelCalls.map((c) => [c.key, c.rank]), [['hazards', 1.5]])
  assert.equal(r.shown().length, 2)
  const [a, b] = r.shown()
  assert.equal(a.text, sigmetLabel(ts, DEFAULT_UNITS))
  assert.equal(a.text, 'Embedded thunderstorms · 18,000 to 35,000 ft')
  assert.equal(a.color, sigmetColor('TS'))
  assert.ok(near(Cartographic.fromCartesian(a.position).height, 35000 * FT, 1))
  const [lon, lat] = lonlat(a.position)
  assert.ok(near(lon, AC.lon, 0.01) && near(lat, AC.lat + 300 / KM_PER_DEG + 1, 0.05), `${lon}, ${lat}: the middle of the box`)
  assert.equal(b.text, 'Moderate icing · up to 12,000 ft')
  assert.equal(b.color, sigmetColor('ICE'))
  assert.ok(near(Cartographic.fromCartesian(b.position).height, 12000 * FT, 1))
  assert.ok(near(lonlat(b.position)[1], AC.lat + 100 / KM_PER_DEG + 0.5, 0.05), 'an area with two rings in reach: the label is at the nearer')
})

test('Weather3D: the volumes and labels are drawn again only when what they show changes; picked again once the aircraft has moved 10 km', async () => {
  const r = rig()
  r.answers.sigmet = [sigmet({ rings: [northOf(300, 2)] }), sigmet({ rings: [northOf(797, 2)] })] // the second is 3 km from out of reach
  await open(r)
  const first = r.volumes()
  const calls = r.labelCalls.length
  assert.equal(first.length, 2)
  r.w.update({ ...AC, lat: AC.lat + 0.05 }, 2000) // 5.6 km on, nearer the second: the same picks, nothing drawn again
  assert.ok(r.volumes().length === 2 && r.volumes().every((e, i) => e === first[i]), 'the same entities, not new ones')
  assert.equal(r.labelCalls.length, calls, 'no new labels for the same picks')
  r.w.update({ ...AC, lat: AC.lat - 0.05 }, 3000) // 5.6 km south, so the second is 803 km off; but less than 10 km from where it was picked
  assert.equal(r.volumes().length, 2, 'not picked again yet')
  r.w.update({ ...AC, lat: AC.lat - 0.1 }, 4000) // 11 km south of that place: picked again, and the second is out of reach
  assert.equal(r.volumes().length, 1)
  assert.equal(r.shown().length, 1)
  assert.equal(r.labelCalls.length, calls + 1)
  const [volumes, labelCalls] = [r.volumes(), r.labelCalls.length]
  r.w.update({ ...AC, lat: AC.lat - 0.1 }, 10 * MIN + 1000) // a new list of SIGMETs with the same two areas: nothing drawn again
  await flush()
  assert.equal(r.asks('sigmet').length, 2)
  assert.ok(r.volumes().length === 1 && r.volumes()[0] === volumes[0], 'the same entity')
  assert.equal(r.labelCalls.length, labelCalls)
  r.answers.sigmet = [sigmet({ rings: [northOf(300, 2)], top: 36000 }), sigmet({ rings: [northOf(797, 2)] })] // the next list: one top has changed
  r.w.update({ ...AC, lat: AC.lat - 0.1 }, 20 * MIN + 2000)
  await flush()
  assert.equal(r.asks('sigmet').length, 3)
  assert.ok(r.volumes().length === 1 && r.volumes()[0] !== volumes[0], 'drawn again')
  assert.equal(r.labelCalls.length, labelCalls + 1)
  assert.match(r.shown()[0].text, /up to 36,000 ft/)
  assert.ok(!first.includes(r.volumes()[0]))
})

test('Weather3D: a new list that changes a corner, a base, a word or the hazard is drawn again; one that changes what is not drawn is not', async () => {
  const area = (o: Partial<Sigmet> = {}, ring: Ring = northOf(300, 2)): Sigmet => sigmet({ rings: [ring], ...o })
  const r = rig()
  r.answers.sigmet = [area()]
  await open(r)
  const first = r.volumes()[0]
  let t = 0
  const next = async (list: Sigmet[]): Promise<Entity> => {
    r.answers.sigmet = list
    t += 10 * MIN
    r.w.update(AC, t)
    await flush()
    return r.volumes()[0]
  }
  assert.equal(await next([area({ raw: 'another text', until: '2026-10-04T00:00:00Z' })]), first, 'what is not drawn')
  for (const o of [{ base: 5000 }, { qualifier: 'SEV' }, { hazard: 'TURB' }]) {
    const was = r.volumes()[0]
    assert.notEqual(await next([area(o)]), was, JSON.stringify(o))
  }
  const was = r.volumes()[0]
  const moved = northOf(300, 2).map(([x, y], i) => (i === 2 ? [x + 0.05, y] : [x, y])) as Ring // a corner that is not the first
  assert.notEqual(await next([area({ hazard: 'TURB', qualifier: 'SEV', base: 5000 }, moved)]), was, 'a corner moved')
})

test('Weather3D: a failure that comes late, for a box the aircraft has left, does not put the note up; nor a late answer take it down', async () => {
  const warn = console.warn
  const warned: unknown[][] = []
  console.warn = (...a: unknown[]) => void warned.push(a)
  try {
    const r = rig()
    r.hold.add('metar')
    r.w.show = true
    r.w.update(AC, 0) // box 30,32,35,37: its answer is held
    r.hold.clear()
    r.answers.metar = [metar('NEW', 36, 35)]
    r.w.update({ ...AC, lat: 36 }, 1000) // out of it by the north: another box, answered at once
    await flush()
    assert.equal(r.lines.at(-1), 'Clouds from 1 airport · 0 hazard areas')
    r.failing.add('metar')
    r.release() // the held ask for the box it left fails, late
    await flush()
    r.w.show = false // the line is written again from what is known: with no note
    r.w.show = true
    assert.ok(r.lines.every((line) => !/unavailable/.test(String(line))), 'no note, then or later')
    assert.equal(r.lines.at(-1), 'Clouds from 1 airport · 0 hazard areas')
    assert.equal(warned.length, 0, 'not even a warning')
    // and the other way round: the current ask fails, the late one for the box it left is answered
    const s = rig()
    s.hold.add('metar')
    s.w.show = true
    s.w.update(AC, 0)
    s.hold.clear()
    s.failing.add('metar')
    s.w.update({ ...AC, lat: 36 }, 1000)
    await flush()
    assert.match(String(s.lines.at(-1)), /some weather unavailable$/)
    s.failing.clear()
    s.answers.metar = [metar('OLD', 32, 35)]
    s.release()
    await flush()
    s.w.show = false
    s.w.show = true
    assert.match(String(s.lines.at(-1)), /some weather unavailable$/, 'the note stays')
    assert.deepEqual(s.w.metars, [], 'and the late answer is not heard')
  } finally {
    console.warn = warn
  }
})

test('Weather3D: the labels are worded in the frame\'s units, and again when they change', async () => {
  const r = rig()
  r.answers.sigmet = [sigmet({ rings: [northOf(300, 2)], top: 35000 })]
  await open(r)
  assert.equal(r.shown()[0].text, 'Embedded thunderstorms · up to 35,000 ft')
  r.setUnits({ ...DEFAULT_UNITS, alt: 'm' })
  r.w.update(AC, 1000)
  assert.equal(r.shown()[0].text, 'Embedded thunderstorms · up to 10,650 m')
  const calls = r.labelCalls.length
  const volume = r.volumes()[0]
  r.setUnits({ alt: 'm', speed: 'kmh', vs: 'ms' }) // a speed changes no height
  r.w.update(AC, 2000)
  assert.equal(r.labelCalls.length, calls)
  r.setUnits(DEFAULT_UNITS)
  r.w.update(AC, 3000)
  assert.equal(r.shown()[0].text, 'Embedded thunderstorms · up to 35,000 ft')
  assert.equal(r.volumes()[0], volume, 'the volume is not drawn again for words')
})

test('Weather3D: hiding takes the volumes and the labels away and asks no more; showing again has them back at once, asking only what is due', async () => {
  const r = rig()
  r.answers.sigmet = [sigmet({ rings: [northOf(300, 2)] })]
  await open(r)
  const first = r.volumes()
  assert.equal(r.shown().length, 1)
  r.w.show = false
  assert.equal(r.sources[0].show, false)
  assert.deepEqual(r.shown(), [], 'its labels are taken out of the overlay')
  assert.equal(r.labelCalls.at(-1)!.key, 'hazards')
  const asked = r.asked.length
  r.w.update(AC, 5 * MIN)
  r.w.update(AC, 30 * MIN)
  await flush()
  assert.equal(r.asked.length, asked, 'hidden: nothing asked, however late')
  r.w.show = true
  assert.equal(r.sources[0].show, true)
  assert.equal(r.shown().length, 1, 'the labels are back with it, from what it holds')
  assert.ok(r.volumes().length === 1 && r.volumes()[0] === first[0], 'its volumes were kept')
  r.w.update(AC, 30 * MIN)
  await flush()
  assert.equal(r.asks('metar').length, 2, 'asked again at the first update after: it is due')
  assert.equal(r.asks('sigmet').length, 2)
})

test('Weather3D: an answer that lands while it is hidden is kept, not drawn or written; shown again, it is drawn at once', async () => {
  const r = rig()
  r.answers.metar = [metar('LLBG', 32.01, 34.89)]
  r.answers.sigmet = [sigmet({ rings: [northOf(300, 2)] })]
  r.hold.add('metar')
  r.hold.add('sigmet')
  r.w.show = true
  r.w.update(AC, 0)
  r.w.show = false
  const [lines, calls] = [r.lines.length, r.labelCalls.length]
  r.release()
  await flush()
  assert.deepEqual([r.w.metars.length, r.w.sigmets.length], [1, 1], 'kept')
  assert.deepEqual([r.lines.length, r.labelCalls.length, r.volumes().length], [lines, calls, 0], 'not drawn or written')
  r.w.show = true
  assert.equal(r.volumes().length, 1)
  assert.equal(r.shown().length, 1)
  assert.equal(r.lines.at(-1), 'Clouds from 1 airport · 1 hazard area')
})

test('Weather3D: the panel\'s line: the counts as they come, a note while a source is down, none written while hidden', async () => {
  const r = rig()
  r.w.show = true
  assert.deepEqual(r.lines, ['Clouds from 0 airports · 0 hazard areas'], 'at once: it takes the line from the top-down map\'s')
  r.answers.metar = [metar('LLBG', 32.01, 34.89), metar('LLHA', 32.81, 35.04), metar('LLMG', 32.5, 35.2)]
  r.answers.sigmet = [sigmet({ rings: [northOf(300, 2)] }), sigmet({ rings: [northOf(100)] })]
  r.w.update(AC, 0)
  await flush()
  assert.equal(r.lines.at(-1), 'Clouds from 3 airports · 2 hazard areas')
  const n = r.lines.length
  r.w.update(AC, 1000)
  await flush()
  assert.equal(r.lines.length, n, 'a line is written when it changes')
  r.w.show = false
  r.answers.metar = []
  r.w.update(AC, 5 * MIN)
  await flush()
  assert.equal(r.lines.length, n, 'hidden, the app owns the line')
  r.w.show = true
  assert.equal(r.lines.at(-1), 'Clouds from 3 airports · 2 hazard areas', 'again when shown, from what it holds')
})

test('Weather3D: a failed ask is one warning, a note on the line, the rest still drawn, and asked again in 30 s', async () => {
  const warned: unknown[][] = []
  const warn = console.warn
  console.warn = (...a: unknown[]) => void warned.push(a)
  try {
    const r = rig()
    r.answers.sigmet = [sigmet({ rings: [northOf(300, 2)] })]
    r.failing.add('metar')
    await open(r)
    assert.equal(r.asks('metar').length, 1)
    assert.equal(warned.length, 1)
    assert.match(String(warned[0][0]), /FlightHopper: 3-D weather .*wx\/metar/)
    assert.equal(r.lines.at(-1), 'Clouds from 0 airports · 1 hazard area · some weather unavailable')
    assert.equal(r.volumes().length, 1, 'the hazard areas came')
    r.w.update(AC, 29_000)
    await flush()
    assert.equal(r.asks('metar').length, 1)
    r.w.update(AC, 30_000)
    await flush()
    assert.equal(r.asks('metar').length, 2, 'asked again after 30 s, not 5 min')
    assert.equal(warned.length, 2)
    r.failing.clear()
    r.answers.metar = [metar('LLBG', 32.01, 34.89)]
    r.w.update(AC, 61_000)
    await flush()
    assert.equal(r.asks('metar').length, 3)
    assert.equal(r.lines.at(-1), 'Clouds from 1 airport · 1 hazard area', 'the note goes when it is answered')
    r.w.update(AC, 61_000 + 4 * MIN)
    await flush()
    assert.equal(r.asks('metar').length, 3, 'and then the usual 5 min')
    r.failing.add('sigmet')
    r.failing.add('radar')
    r.w.update(AC, 10 * MIN + 1000)
    await flush()
    assert.match(String(r.lines.at(-1)), /some weather unavailable$/)
    assert.equal(r.volumes().length, 1, 'the hazard areas it had stay')
    assert.equal(r.asks('sigmet').length, 2)
    r.w.update(AC, 10 * MIN + 31_000)
    await flush()
    assert.equal(r.asks('sigmet').length, 3, 'the SIGMETs and the radar are asked again after 30 s too')
    assert.equal(r.asks('weather-maps').length, 3)
  } finally {
    console.warn = warn
  }
})

test('Weather3D: an answer that is not what it should be is a failed ask, not a crash', async () => {
  const warn = console.warn
  console.warn = () => {}
  try {
    const r = rig()
    r.answers.metar = { error: 'x' }
    r.answers.sigmet = 'nope'
    r.answers.radar = { host: HOST }
    await open(r)
    assert.deepEqual([r.w.metars, r.w.sigmets, r.w.radar], [[], [], null])
    assert.match(String(r.lines.at(-1)), /some weather unavailable$/)
    const s = rig()
    s.answers.metar = [{ id: 'NOPOS' }, metar('LLBG', 32.01, 34.89)] // no position: not a station
    s.answers.sigmet = [{ hazard: 'TS' }, sigmet({ rings: [northOf(100)] })] // no rings
    await open(s)
    assert.deepEqual(s.w.metars.map((m) => m.id), ['LLBG'])
    assert.equal(s.w.sigmets.length, 1)
  } finally {
    console.warn = warn
  }
})

test('Weather3D: an answer for a box the aircraft has left is dropped', async () => {
  const r = rig()
  r.hold.add('metar')
  r.answers.metar = [metar('OLD', 32, 35)]
  r.w.show = true
  r.w.update(AC, 0) // box 30,32,35,37: its answer is held
  r.hold.clear()
  r.answers.metar = [metar('NEW', 36, 35)]
  r.w.update({ ...AC, lat: 36 }, 1000) // out of it by the north: another box, answered at once
  await flush()
  assert.deepEqual(r.w.metars.map((m) => m.id), ['NEW'])
  r.release() // the held answer, for the box it left, lands late
  await flush()
  assert.deepEqual(r.w.metars.map((m) => m.id), ['NEW'])
})

test('Weather3D: ?wxat takes its weather from round that place and shifts it onto the aircraft, which then flies through that sky', async () => {
  const zurich = { lat: 47.4, lon: 8.5 }
  const r = rig({ at: zurich })
  r.answers.metar = [metar('LSZH', 47.46, 8.55)]
  r.answers.sigmet = [sigmet({ rings: [box(47, 8, 48, 9)] }), sigmet({ rings: [box(40, 8, 41, 9)] })] // over Zurich; 700 km south of it
  await open(r) // the aircraft is over Haifa
  assert.deepEqual(r.asks('metar'), ['/api/wx/metar?bbox=45,6,50,11'], 'the box is round Zurich: the aircraft is at that place')
  const d = { dLat: AC.lat - zurich.lat, dLon: AC.lon - zurich.lon }
  assert.deepEqual(r.w.shift, d)
  assert.ok(near(r.w.metars[0].lat, 47.46 + d.dLat, 1e-9) && near(r.w.metars[0].lon, 8.55 + d.dLon, 1e-9), 'LSZH where it is drawn: by the aircraft')
  assert.equal(r.w.metars[0].id, 'LSZH')
  assert.equal(r.w.sigmets.length, 2)
  assert.ok(r.w.sigmets[0].rings[0].every(([lon, lat]) => near(lat, 32.1, 1) && near(lon, 34.9, 1)), 'the ring over Zurich is over the aircraft')
  assert.equal(r.w.hazards.length, 2, 'both within 800 km of the aircraft, as they are of Zurich')
  assert.ok(r.volumes().map(polygon)[0].ring.every(([lon, lat]) => near(lat, 32.1, 1) && near(lon, 34.9, 1)), 'drawn over the aircraft')
  const [llon, llat] = lonlat(r.shown()[0].position)
  assert.ok(near(llat, 32.2, 0.05) && near(llon, 34.9, 0.05), `${llon}, ${llat}: the label is in the shifted sky too`)
  assert.equal(r.w.radar!.url, `${HOST}/v2/radar/new/256/{z}/{x}/{y}/2/0_1.png`, 'the radar is RainViewer\'s, unshifted: it is sampled at the place less the shift')
  // the shift stays: an aircraft a degree north is a degree north in Zurich's sky
  r.w.update({ ...AC, lat: AC.lat + 1 }, 5 * MIN)
  await flush()
  assert.deepEqual(r.w.shift, d)
  assert.equal(r.asks('metar').at(-1), '/api/wx/metar?bbox=46,6,51,11') // 48.4 ± 2
})

test('Weather3D: without ?wxat nothing is shifted', async () => {
  const r = rig()
  r.answers.metar = [metar('LLBG', 32.01, 34.89)]
  r.answers.sigmet = [sigmet({ rings: [northOf(100)] })]
  await open(r)
  assert.deepEqual(r.w.shift, { dLat: 0, dLon: 0 })
  assert.deepEqual([r.w.metars[0].lat, r.w.metars[0].lon], [32.01, 34.89])
  assert.deepEqual(r.w.sigmets[0].rings[0], northOf(100))
})

test('Weather3D: destroy hides it, takes its labels and its data source away, ends its asking, and ignores late answers; twice is harmless', async () => {
  const r = rig()
  r.answers.sigmet = [sigmet({ rings: [northOf(300, 2)] })]
  await open(r)
  const asked = r.asked.length
  r.w.destroy()
  r.w.destroy()
  assert.equal(r.w.show, false)
  assert.deepEqual(r.shown(), [])
  assert.deepEqual(r.removed.map(([ds, destroy]) => [ds === r.sources[0], destroy]), [[true, true]])
  r.w.show = true
  assert.equal(r.w.show, false, 'it stays down')
  r.w.update(AC, 30 * MIN)
  await flush()
  assert.equal(r.asked.length, asked)
  const late = rig()
  late.answers.sigmet = [sigmet({ rings: [northOf(300, 2)] })]
  late.answers.metar = [metar('LLBG', 32.01, 34.89)]
  late.hold.add('metar')
  late.hold.add('sigmet')
  late.w.show = true
  late.w.update(AC, 0)
  late.w.destroy() // the answers are still on their way
  late.release()
  await flush()
  assert.deepEqual(late.volumes(), [])
  assert.deepEqual(late.w.metars, [])
  assert.deepEqual(late.w.sigmets, [])
  assert.deepEqual(late.shown(), [])
})

// ---- the sky: clouds, fog, rain and snow --------------------------------------------------------------------------------

const KM_PER_NM = 1.852
const kmFrom = (c: { lat: number; lon: number }, a: { lat: number; lon: number }): number => distanceNm(c.lat, c.lon, a.lat, a.lon) * KM_PER_NM
const layer = (cover: string, baseFt: number, type: 'CB' | 'TCU' | null = null): Cloud => ({ cover, baseFt, type })
const north = (km: number): typeof AC => ({ ...AC, lat: AC.lat + km / KM_PER_DEG })
const TRUE = { fSampled: 1, fNow: 1, relHM: 0 }

test('Weather3D: clouds from the reports round the aircraft, built when they come and drawn the frame after; the line counts the airports they come from', async () => {
  const r = rig()
  r.answers.metar = [
    metar('LLBG', 32.01, 34.89, { clouds: [layer('SCT', 3000)] }),
    metar('LLHA', 32.81, 35.04, { clouds: [layer('BKN', 2500, 'CB')] }),
    metar('LLER', 29.94, 35.0), // CAVOK, 240 km south: out of reach
    metar('SILENT', 32.3, 34.9, { raw: 'METAR SILENT 031200Z AUTO 27010KT 9999 25/12 Q1015' }), // says nothing of the sky
  ]
  await open(r)
  assert.equal(r.sky.clouds.draws.length, 0, 'built at the look, not drawn in it')
  assert.equal(r.sky.clouds.show, true)
  r.w.update(AC, 16)
  assert.equal(r.sky.clouds.draws.length, 1)
  const drawn = r.sky.clouds.draws[0]
  assert.deepEqual(drawn, nearestClouds([observedClouds(r.w.metars, AC.lat, AC.lon).specs], AC.lat, AC.lon))
  assert.ok(drawn.length > 0 && drawn.every((c) => kmFrom(c, AC) <= 150))
  assert.equal(r.lines.at(-1), 'Clouds from 2 airports · 0 hazard areas', 'LLBG and LLHA; LLER is too far, SILENT says nothing of the sky')
  r.w.update(AC, 32)
  assert.equal(r.sky.clouds.draws.length, 1, 'drawn once')
})

test('Weather3D: the clouds are built again for a new list of reports, or once the aircraft has moved 30 km; not before', async () => {
  const r = rig()
  r.answers.metar = [metar('LLBG', 32.01, 34.89, { clouds: [layer('FEW', 3000)] })]
  await open(r)
  r.w.update(AC, 16)
  const draws = (): number => r.sky.clouds.draws.length
  assert.equal(draws(), 1)
  r.w.update(north(29), 1000) // a look
  r.w.update(north(29), 1016)
  assert.equal(draws(), 1, '29 km: not yet')
  r.w.update(north(30.5), 2000)
  r.w.update(north(30.5), 2016)
  assert.equal(draws(), 2, '30 km from where they were built')
  r.w.update(north(30.5), 5 * MIN) // the METARs again: a new list, the same words
  await flush()
  r.w.update(north(30.5), 5 * MIN + 16)
  assert.equal(draws(), 3)
  assert.deepEqual(r.sky.clouds.draws[2], r.sky.clouds.draws[1], 'the same reports draw the same sky')
})

test('Weather3D: every frame the clouds and the fog follow the relief drawn and the Sun\'s night, with or without an aircraft; hidden, nothing', async () => {
  const r = rig()
  await open(r)
  const flat = { fSampled: 0, fNow: 0, relHM: 120 }
  r.w.setNight(0.6)
  r.w.update(AC, 10, flat)
  assert.deepEqual(r.sky.clouds.frames.at(-1), [flat, 0.6])
  assert.deepEqual(r.sky.fog.frames.at(-1), [flat, 0.6])
  r.w.update(null, 20, TRUE)
  assert.deepEqual(r.sky.clouds.frames.at(-1), [TRUE, 0.6])
  r.w.setNight(Number.NaN)
  r.w.update(AC, 30)
  assert.deepEqual(r.sky.clouds.frames.at(-1), [TRUE, 0], 'no relief given: the true one; no night known: day')
  r.w.show = false
  const n = r.sky.clouds.frames.length
  r.w.update(AC, 40, flat)
  assert.equal(r.sky.clouds.frames.length, n)
  assert.equal(r.sky.clouds.show, false)
})

test('Weather3D: fog round a foggy station near the aircraft, none away from it; hidden, none', async () => {
  const r = rig()
  r.answers.metar = [metar('FOGGY', 32.12, 34.95, { wx: 'FG', visKm: 0.2, visPlus: false })]
  await open(r)
  const f = r.sky.fog.sets.at(-1)
  assert.ok(f !== null && f !== undefined)
  assert.deepEqual(f, fogNear(r.w.metars, AC.lat, AC.lon))
  r.w.update(north(60), 1000)
  assert.equal(r.sky.fog.sets.at(-1), null, '60 km off')
  r.w.update(AC, 2000)
  assert.ok(r.sky.fog.sets.at(-1) !== null)
  r.w.show = false
  assert.equal(r.sky.fog.sets.at(-1), null)
})

test('Weather3D: rain from the nearest station\'s weather, only below its cloud base + 300 m; drifting with its wind', async () => {
  const r = rig()
  const wet = metar('WET', 32.12, 34.95, { wx: '+RA', wdir: 270, wspd: 12, clouds: [layer('BKN', 3000)] })
  r.answers.metar = [wet]
  await open(r) // the camera at the aircraft's 10 km
  assert.equal(r.sky.precip.sets.at(-1), null, 'above the cloud')
  const top = 30 + 3000 * FT + geoidN(wet.lat, wet.lon) + 300
  r.setCamera(AC.lat, AC.lon, top - 1)
  r.w.setNight(0.25)
  r.w.update(AC, 1000)
  assert.deepEqual(r.sky.precip.sets.at(-1), { kind: 'rain', intensity: 1, wind: windOf(wet), night: 0.25 })
  r.setCamera(AC.lat, AC.lon, top + 1)
  r.w.update(AC, 2000)
  assert.equal(r.sky.precip.sets.at(-1), null)
  r.setCamera(AC.lat, AC.lon, top - 1)
  r.w.update(AC, 3000, { fSampled: 0, fNow: 0, relHM: 0 }) // flattened: the station's ground drawn at 0
  r.w.update(AC, 4000, { fSampled: 0, fNow: 0, relHM: 0 })
  assert.equal(r.sky.precip.sets.at(-1), null, 'the base came down with its ground')
  r.setCamera(AC.lat + 0.4, AC.lon, 500) // 33 km from the station
  r.w.update(AC, 5000, TRUE)
  assert.equal(r.sky.precip.sets.at(-1), null, 'no station within 30 km of the camera')
})

test('Weather3D: rain or snow from the radar under the camera, its place less the ?wxat shift; 3 km over the ground where no base is known', async () => {
  const zurich = { lat: 47.4, lon: 8.5 }
  const r = rig({ at: zurich })
  r.setGround(400)
  r.setCamera(AC.lat, AC.lon, 3300)
  const { x, y, px, py } = radarPixel(zurich.lat, zurich.lon) // the camera, at the aircraft, is at Zurich in the radar's own sky
  const t: SourceTile = { dbz: new Int8Array(256 * 256).fill(-128), snow: new Uint8Array(256 * 256) }
  t.dbz[py * 256 + px] = 30
  r.tiles.set(`7/${x}/${y}`, t)
  await open(r) // the tile is asked for at the first look with a radar frame, and lands after it
  assert.deepEqual(r.tileAsks, [`7/${x}/${y}`])
  r.w.update(AC, 1000)
  assert.deepEqual(r.sky.precip.sets.at(-1), { kind: 'rain', intensity: 0.5, wind: { east: 0, north: 0 }, night: 0 }, 'no station: no wind')
  t.snow[py * 256 + px] = 1
  r.w.update(AC, 2000)
  assert.equal(r.sky.precip.sets.at(-1)?.kind, 'snow')
  assert.deepEqual(r.tileAsks.length, 1, 'the tile asked once')
  r.setCamera(AC.lat, AC.lon, 3500) // 3 km over the 400 m ground is 3,400 m
  r.w.update(AC, 4000)
  assert.equal(r.sky.precip.sets.at(-1), null)
  r.setCamera(AC.lat, AC.lon, 3300)
  r.w.update(AC, 5000)
  assert.ok(r.sky.precip.sets.at(-1) !== null)
  r.w.show = false
  assert.equal(r.sky.precip.sets.at(-1), null, 'hidden: nothing falls')
})

test('Weather3D: rebuildSky builds the clouds again at once (a check aid for the look constants), drawn the frame after', async () => {
  const r = rig()
  r.answers.metar = [metar('LLBG', 32.01, 34.89, { clouds: [layer('FEW', 3000)] })]
  await open(r)
  r.w.update(AC, 16)
  assert.equal(r.sky.clouds.draws.length, 1)
  r.w.rebuildSky()
  r.w.update(AC, 32)
  assert.equal(r.sky.clouds.draws.length, 2)
  assert.deepEqual(r.sky.clouds.draws[1], r.sky.clouds.draws[0])
  assert.equal(r.w.sky, r.sky, 'the sky\'s parts, for the console')
})

test('Weather3D: destroy destroys the sky\'s parts', async () => {
  const r = rig()
  await open(r)
  r.w.destroy()
  assert.deepEqual([r.sky.clouds.destroyed, r.sky.fog.destroyed, r.sky.precip.destroyed], [true, true, true])
})

test('Weather3D: destroyed after the viewer, it touches nothing of Cesium\'s (no fog set, nothing hidden or destroyed there), but takes its overlay away', async () => {
  const r = rig()
  await open(r)
  const [fogSets, removed] = [r.sky.fog.sets.length, r.removed.length]
  r.destroyViewer()
  r.w.destroy()
  assert.equal(r.sky.fog.sets.length, fogSets)
  assert.equal(r.removed.length, removed)
  assert.deepEqual([r.sky.clouds.destroyed, r.sky.fog.destroyed, r.sky.clouds.show, r.sky.precip.destroyed], [false, false, true, true])
  assert.equal(r.w.show, false)
})

test('Weather3D: the clouds are faded at each look from where the aircraft is', async () => {
  const r = rig()
  await open(r)
  const want = Cartesian3.fromDegrees(AC.lon, AC.lat, AC.altM)
  assert.ok(Cartesian3.equalsEpsilon(r.sky.clouds.fades.at(-1)!, want, 0, 1e-6))
  const n = r.sky.clouds.fades.length
  r.w.update(north(5), 500)
  assert.equal(r.sky.clouds.fades.length, n, 'between looks: no fade')
  r.w.update(north(5), 1000)
  assert.ok(Cartesian3.equalsEpsilon(r.sky.clouds.fades.at(-1)!, Cartesian3.fromDegrees(AC.lon, north(5).lat, AC.altM), 0, 1e-6))
})

test('Weather3D: while something falls the overlay is aimed for the camera\'s heading, at most four times a second; never while nothing falls', async () => {
  const r = rig()
  const wet = metar('WET', 32.12, 34.95, { wx: '+RA', wdir: 270, wspd: 12, clouds: [layer('BKN', 3000)] })
  r.answers.metar = [wet]
  await open(r) // the camera above the cloud: nothing falls
  for (let t = 10; t < 990; t += 16) r.w.update(AC, t)
  assert.deepEqual(r.sky.precip.aims, [])
  r.setCamera(AC.lat, AC.lon, 500)
  r.setHeading(1.2)
  r.w.update(AC, 1000) // a look: it rains
  for (let t = 1016; t < 2000; t += 16) r.w.update(AC, t)
  assert.ok(r.sky.precip.aims.length >= 4 && r.sky.precip.aims.length <= 5, `${r.sky.precip.aims.length} aims in a second`)
  assert.ok(r.sky.precip.aims.every((h) => h === 1.2))
  r.setCamera(AC.lat, AC.lon, 10_000)
  r.w.update(AC, 2000) // a look: above the cloud again
  const n = r.sky.precip.aims.length
  for (let t = 2016; t < 2900; t += 16) r.w.update(AC, t)
  assert.equal(r.sky.precip.aims.length, n)
})

test('Weather3D: rebuildSky works the clouds out again from the reports, so a changed look shows (a check aid)', async () => {
  const r = rig()
  r.answers.metar = [metar('LLBG', 32.01, 34.89, { clouds: [layer('FEW', 3000)] })]
  await open(r)
  r.w.update(AC, 16)
  const saved = LOOKS.FEW.w
  try {
    ;(LOOKS.FEW as { w: readonly [number, number] }).w = [5000, 5000]
    r.w.update(north(1), 1000) // a look, no rebuild due
    r.w.update(north(1), 1016)
    assert.equal(r.sky.clouds.draws.length, 1)
    r.w.rebuildSky()
    r.w.update(north(1), 1032)
    assert.equal(r.sky.clouds.draws.length, 2)
    assert.ok(r.sky.clouds.draws[1].length > 0 && r.sky.clouds.draws[1].every((c) => c.scale[0] === 5000), 'the new look')
  } finally {
    ;(LOOKS.FEW as { w: readonly [number, number] }).w = saved
  }
})

test('Weather3D: the relief is read from each frame, not kept (Topography reuses its object)', async () => {
  const r = rig()
  const wet = metar('WET', 32.12, 34.95, { wx: '+RA', clouds: [layer('BKN', 3000)] })
  r.answers.metar = [wet]
  const top = 30 + 3000 * FT + geoidN(wet.lat, wet.lon) + 300
  r.setCamera(AC.lat, AC.lon, top - 1)
  await open(r)
  assert.ok(r.sky.precip.sets.at(-1) !== null, 'under the cloud: rain')
  const tf = { fSampled: 0, fNow: 0, relHM: 0 } // flat: the station's ground drawn at 0, its cloud base with it
  r.w.update(AC, 100, tf)
  Object.assign(tf, { fSampled: 1, fNow: 1, relHM: 0 }) // the object reused for a later frame
  r.w.rebuildSky()
  assert.equal(r.sky.precip.sets.at(-1), null, 'the flat relief this frame gave')
})

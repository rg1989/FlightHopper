// client/scene/weather3d.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import v8 from 'node:v8'
import vm from 'node:vm'
import { Cartesian3, Cartographic, Color, JulianDate, Math as CesiumMath } from 'cesium'
import type { ColorMaterialProperty, CustomDataSource, Entity, Viewer } from 'cesium'
import { distanceNm } from '../../shared/geo.ts'
import { geoidN } from '../../shared/geoid.ts'
import { MODEL_CLOUD_HPA, MODEL_WIND_HPA, type Cloud, type Metar, type ModelGeo, type ModelGrid, type Sigmet } from '../../shared/wx.ts'
import type { TerrainFrame } from '../types.ts'
import { DEFAULT_UNITS, type Units } from '../ui/units.ts'
import { LOOKS, MAX_CLOUDS, MODEL_LOOK, PUFF_FILL, RADAR_LOOK, REBUILD_KM, fadeAlpha, modelClouds, nearestClouds, observedClouds, radarBases, radarClouds, type CloudSpec } from './cloudField.ts'
import { fogNear, type Fog } from './groundFog.ts'
import type { LayerLabel } from './placeLabels.ts'
import { radarPixel, windOf, type Fall } from './precip.ts'
import { RadarSource, type SourceTile } from './radar.ts'
import { radarCells } from './radarCells.ts'
import { modelWindAt } from './modelWind.ts'
import { pickShafts, type RainShaft } from './rainShafts.ts'
import { HAZARD_KM, Weather3D, echoShade, parseWxAt, statusText3d } from './weather3d.ts'
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

type Kind = 'metar' | 'sigmet' | 'radar' | 'model'
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
    shafts: {
      show: false, draws: [] as RainShaft[][], frames: [] as [TerrainFrame, number][], fades: [] as Cartesian3[], destroyed: false,
      draw(shafts: readonly RainShaft[]) { this.draws.push([...shafts]) },
      frame(tf: TerrainFrame, night: number) { this.frames.push([{ ...tf }, night]) },
      fade(from: Cartesian3) { this.fades.push(Cartesian3.clone(from)) },
      destroy() { this.destroyed = true },
    },
  }
}

const ISA_Z: Readonly<Record<number, number>> = { 1000: 110, 925: 760, 850: 1460, 700: 3010, 600: 4200, 500: 5570, 400: 7180, 300: 9160, 250: 10360, 200: 11800 } // m
const WIND_KT = [10, 20, 40, 80, 90, 100] // from the west at 850, 700, 500, 300, 250 and 200 hPa
interface GridOptions {
  cover?: (hPa: number, place: number) => number
  wind?: (level: number, place: number) => [fromDeg: number, kt: number]
}
/** A model grid at geo: its cover from `cover` (none by default), the levels at the standard atmosphere's heights, sea level, the wind from the west. */
function gridFor(geo: ModelGeo, o: GridOptions = {}): ModelGrid {
  const per = <T>(f: (p: number) => T): T[] => Array.from({ length: geo.n * geo.n }, (_, p) => f(p))
  const wind = o.wind ?? ((l: number): [number, number] => [270, WIND_KT[l]])
  return {
    ...geo, timeMs: 1791014400_000, elevM: per(() => 0),
    clouds: MODEL_CLOUD_HPA.map((hPa) => ({ hPa, cover: per((p) => o.cover?.(hPa, p) ?? 0), zM: per(() => ISA_Z[hPa]) })),
    winds: MODEL_WIND_HPA.map((hPa, l) => ({ hPa, kt: per((p) => wind(l, p)[1]), deg: per((p) => wind(l, p)[0]) })),
  }
}
/** The grid server/wx.ts gives for the place a request asks about: 7 × 7 places 0.25° apart round the middle of its 0.5° cell. */
function geoOf(url: string): ModelGeo {
  const q = new URL(url, 'http://localhost').searchParams
  const middle = (v: number): number => (Math.floor(v / 0.5) + 0.5) * 0.5
  return { lat0: middle(Number(q.get('lat'))) - 0.75, lon0: middle(Number(q.get('lon'))) - 0.75, step: 0.25, n: 7 }
}

/**
 * A Weather3D over a fake viewer (its camera at the aircraft until moved), names overlay, sky, radar tiles and network: what
 * was asked, answered from `answers` (or failed, or held until release()).
 */
function rig(o: { at?: { lat: number; lon: number } } = {}) {
  const asked: string[] = []
  const answers: Record<'metar' | 'sigmet' | 'radar', unknown> = { metar: [], sigmet: [], radar: INDEX }
  const failing = new Set<Kind>()
  const hold = new Set<Kind>()
  const held: (() => void)[] = []
  const model = { make: (geo: ModelGeo): unknown => gridFor(geo) } // what the server would answer for a grid: nothing in the sky, by default
  const getJson = async (url: string): Promise<unknown> => {
    asked.push(url)
    const kind: Kind = url.includes('/wx/metar') ? 'metar' : url.includes('/wx/sigmet') ? 'sigmet' : url.includes('/wx/model') ? 'model' : 'radar'
    const answer = kind === 'model' ? model.make(geoOf(url)) : structuredClone(answers[kind]) // as it is when asked
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
    scene: { globe: { getHeight: (): number | undefined => ground }, skyAtmosphere: { saturationShift: 0, brightnessShift: 0 } },
  } as unknown as Viewer
  const labelCalls: LabelCall[] = []
  const labels = { setLayer: (key: string, rank: number, ls: readonly LayerLabel[]) => void labelCalls.push({ key, rank, labels: [...ls] }) }
  const lines: (string | null)[] = []
  let units: Units = DEFAULT_UNITS
  const sky = fakeSky()
  const tiles = new Map<string, SourceTile>() // z/x/y
  const tileAsks: string[] = []
  const frameTiles = new Map<string, Map<string, SourceTile>>() // tiles of the frame whose URL has this in it, over `tiles`
  const tileHold = { on: false } // while on, a tile is answered only after releaseTiles()
  const tileHeld: (() => void)[] = []
  const tile = async (radar: RadarSource, z: number, x: number, y: number): Promise<SourceTile | null> => {
    const key = `${z}/${x}/${y}`
    tileAsks.push(key)
    if (tileHold.on) await new Promise<void>((resolve) => tileHeld.push(resolve))
    const own = [...frameTiles].find(([path]) => radar.url.includes(path))?.[1]
    return own?.get(key) ?? tiles.get(key) ?? null // as it is when answered
  }
  const w = new Weather3D(viewer, { apiBase: '/api', labels, getJson, onStatus: (t) => lines.push(t), units: () => units, at: o.at, sky, tile })
  return {
    w, asked, answers, model, failing, hold, sources, removed, labelCalls, lines, sky, tiles, tileAsks, tileHold, frameTiles,
    releaseTiles: (newestFirst = false) => (newestFirst ? tileHeld.splice(0).reverse() : tileHeld.splice(0)).forEach((f) => f()),
    releaseSome: (n: number) => tileHeld.splice(0, n).forEach((f) => f()), // the first n tiles held
    held: () => tileHeld.length,
    setCamera: (lat: number, lon: number, hM: number): void => void Cartographic.fromDegrees(lon, lat, hM, camera.positionCartographic),
    setGround: (hM: number | undefined): void => void (ground = hM),
    setHeading: (rad: number): void => void (camera.heading = rad),
    destroyViewer: (): void => void (gone = true),
    release: () => held.splice(0).forEach((f) => f()),
    volumes: (): Entity[] => [...sources[0].entities.values], // a copy: the collection's own array changes as it does
    shown: (): LayerLabel[] => labelCalls.at(-1)?.labels ?? [], // the labels the overlay holds for the layer now
    asks: (what: 'metar' | 'sigmet' | 'weather-maps' | 'model'): string[] => asked.filter((u) => u.includes(what === 'metar' ? '/wx/metar' : what === 'sigmet' ? '/wx/sigmet' : what === 'model' ? '/wx/model' : 'weather-maps')),
    setUnits: (u: Units): void => void (units = u),
    skyShift: (): { saturationShift: number; brightnessShift: number } => (viewer.scene as unknown as { skyAtmosphere: { saturationShift: number; brightnessShift: number } }).skyAtmosphere,
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

test('Weather3D: shown it asks at the first update with an aircraft: METARs of a whole-degree box 2° round it, SIGMETs, RainViewer\'s index, the model\'s grid', async () => {
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
  assert.deepEqual(r.asks('model'), ['/api/wx/model?lat=32.1&lon=34.9'], 'the place the aircraft is at: the server snaps it to its cell')
  assert.equal(r.asked.length, 4)
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

test('Weather3D: hazard areas within 800 km are translucent volumes from base to top: 0.10 fill, 0.3 outline, the hazard\'s colour', async () => {
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
  assert.ok(a.line.equals(red.withAlpha(0.3)), String(a.line))
  assert.ok(b.fill.equals(amber.withAlpha(0.1)) && b.line.equals(amber.withAlpha(0.3)))
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
  assert.equal(r.tileAsks.filter((k) => k === `7/${x}/${y}`).length, 1, 'the camera\'s tile, once (the clouds ask for those the radius reaches too: radar clouds)')
  r.w.update(AC, 1000)
  assert.deepEqual(r.sky.precip.sets.at(-1), { kind: 'rain', intensity: 0.5, wind: { east: 0, north: 0 }, night: 0 }, 'no station: no wind')
  t.snow[py * 256 + px] = 1
  r.w.update(AC, 2000)
  assert.equal(r.sky.precip.sets.at(-1)?.kind, 'snow')
  assert.equal(r.tileAsks.filter((k) => k === `7/${x}/${y}`).length, 1, 'the tile asked once')
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
  assert.deepEqual([r.sky.clouds.destroyed, r.sky.fog.destroyed, r.sky.precip.destroyed, r.sky.shafts.destroyed], [true, true, true, true])
})

test('Weather3D: destroyed after the viewer, it touches nothing of Cesium\'s (no fog set, nothing hidden or destroyed there), but takes its overlay away', async () => {
  const r = rig()
  await open(r)
  const [fogSets, removed] = [r.sky.fog.sets.length, r.removed.length]
  r.destroyViewer()
  r.w.destroy()
  assert.equal(r.sky.fog.sets.length, fogSets)
  assert.equal(r.removed.length, removed)
  assert.deepEqual([r.sky.clouds.destroyed, r.sky.fog.destroyed, r.sky.shafts.destroyed, r.sky.clouds.show, r.sky.shafts.show, r.sky.precip.destroyed], [false, false, false, true, true, true])
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

test('Weather3D: under a nearby station’s overcast the sky greys, easing in; above the deck or hidden it is the sky’s own again', async () => {
  const r = rig()
  r.answers.metar = [metar('LLBG', AC.lat, AC.lon, { elevM: 30, clouds: [{ cover: 'OVC', baseFt: 2000, type: null }] })]
  r.setCamera(AC.lat, AC.lon, 200) // under the deck (base 30 + 610 m)
  await open(r)
  for (let t = 1000; t <= 12_000; t += 100) r.w.update(AC, t) // a look a second, eased every frame
  assert.ok(r.skyShift().saturationShift < -0.6, `${r.skyShift().saturationShift}`) // about 0.75 × 0.85
  assert.ok(r.skyShift().brightnessShift < -0.24, `${r.skyShift().brightnessShift}`)
  r.setCamera(AC.lat, AC.lon, 3000) // above it
  for (let t = 12_100; t <= 30_000; t += 100) r.w.update(AC, t)
  assert.equal(r.skyShift().saturationShift, -0)
  r.setCamera(AC.lat, AC.lon, 200)
  for (let t = 30_100; t <= 45_000; t += 100) r.w.update(AC, t)
  assert.ok(r.skyShift().saturationShift < -0.6)
  r.w.show = false // hidden: the sky's own colours at once
  assert.equal(r.skyShift().saturationShift, -0)
  assert.equal(r.skyShift().brightnessShift, -0)
})


// ---- the radar's clouds and rain shafts ---------------------------------------------------------------------------------------

/** Radar tiles (zoom 7, keyed 'z/x/y') with one pixel of echo for each place given: km east and north of `at`, dBZ, snow. */
function echoTiles(at: { lat: number; lon: number }, echoes: [number, number, number, boolean?][]): Map<string, SourceTile> {
  const out = new Map<string, SourceTile>()
  for (const [east, north, dbz, snow] of echoes) {
    const { x, y, px, py } = radarPixel(at.lat + north / KM_PER_DEG, at.lon + east / (KM_PER_DEG * Math.cos((at.lat * Math.PI) / 180)))
    let t = out.get(`7/${x}/${y}`)
    if (t === undefined) out.set(`7/${x}/${y}`, (t = { dbz: new Int8Array(65536).fill(-128), snow: new Uint8Array(65536) }))
    t.dbz[py * 256 + px] = dbz
    t.snow[py * 256 + px] = snow ? 1 : 0
  }
  return out
}
const giveTiles = (r: Rig, tiles: Map<string, SourceTile>): void => tiles.forEach((t, k) => r.tiles.set(k, t))
const tileGetter = (r: Rig) => (x: number, y: number): SourceTile | null => r.tiles.get(`7/${x}/${y}`) ?? null
const towerPuffs = (cs: readonly CloudSpec[]): CloudSpec[] => cs.filter((c) => c.tower !== undefined)
/** The radar is read this far from the aircraft: where its clouds have faded out, and the ring a rebuild reads past that. */
const READ_KM = RADAR_LOOK.radiusKm + REBUILD_KM
/** What a look builds, as the frames after it draw it: the look builds the observed clouds, the next frame the radar's part, the one after draws them. */
const drawn = (r: Rig, at: typeof AC, t: number): void => [0, 16, 32, 48].forEach((d) => r.w.update(at, t + d)) // a fourth frame in case a draw of the last build came first
/** A tower's height from its base to its top, by its puffs. */
const towerHeight = (cs: readonly CloudSpec[]): number => Math.max(...cs.map((c) => c.heightM + (PUFF_FILL * c.scale[1]) / 2)) - Math.min(...cs.map((c) => c.heightM - (PUFF_FILL * c.scale[1]) / 2))

test('Weather3D: rain clouds and shafts from the radar within 100 km of the aircraft: its tiles asked for once each, built when they have come, drawn the frame after, on the nearest station\'s ceiling', async () => {
  const r = rig()
  giveTiles(r, echoTiles(AC, [[20, 0, 50], [-15, 10, 42], [0, 30, 22], [40, 0, 60, true]])) // heavy rain 20 km east, rain 15 west, light rain 30 north, snow 40 east
  r.answers.metar = [metar('LLBG', 32.01, 34.89, { elevM: 30, clouds: [layer('BKN', 2000)] })]
  await open(r) // the tiles are asked for and have come
  for (const k of r.tiles.keys()) assert.equal(r.tileAsks.filter((a) => a === k).length, 1, `${k} asked once`)
  assert.ok(r.tileAsks.every((k) => k.startsWith('7/')), 'zoom 7: RainViewer\'s deepest')
  r.w.update(AC, 16)
  assert.equal(towerPuffs(r.sky.clouds.draws.at(-1)!).length, 0, 'the first build was before the tiles had come')
  r.w.update(AC, 1000) // a look: new radar data; the observed clouds are built, the radar's part at the next frame
  assert.equal(r.sky.clouds.draws.length, 1, 'built, not yet drawn')
  r.w.update(AC, 1016)
  assert.equal(r.sky.clouds.draws.length, 1, 'the radar\'s part built, not yet drawn')
  r.w.update(AC, 1032)
  assert.equal(r.sky.clouds.draws.length, 2)
  const sky = r.sky.clouds.draws.at(-1)!
  const cells = radarCells(tileGetter(r), AC.lat, AC.lon, undefined, READ_KM)
  const base = radarBases(r.w.metars)
  const expected = radarClouds(cells, base)
  assert.ok(expected.length >= 10)
  for (const e of expected) assert.ok(sky.some((c) => isDeepStrictEqual(c, e)), 'the radar\'s clouds, as radarClouds makes them from the cells and the reports')
  const towers = [...new Set(towerPuffs(sky).map((c) => c.tower))]
  assert.equal(towers.length, 2, 'the 50 and the 42 dBZ blocks are towers; the 22 dBZ rain and the snow are decks')
  const ceiling = 30 + 2000 * FT
  assert.ok(near(Math.min(...towerPuffs(sky).map((c) => c.heightM - (PUFF_FILL * c.scale[1]) / 2)), ceiling, 1e-6), 'on LLBG\'s ceiling')
  assert.equal(expected.filter((c) => c.tower === undefined).length, 2, 'the 22 dBZ rain and the snow: two decks')
  assert.ok(expected.filter((c) => c.tower === undefined).every((c) => near(c.heightM - (PUFF_FILL * c.scale[1]) / 2, ceiling, 1e-6) && c.groundM === 30), 'at the ceiling')
  assert.equal(r.sky.shafts.show, true)
  assert.equal(r.sky.shafts.draws.length, 2, 'drawn with the clouds')
  assert.deepEqual(r.sky.shafts.draws.at(-1), pickShafts(cells, base))
  assert.equal(r.sky.shafts.draws.at(-1)!.length, 2, 'under the two rain blocks of 35 dBZ and more')
  assert.ok(r.sky.shafts.draws.at(-1)!.every((s) => near(s.baseM, ceiling, 1e-9) && s.groundM === 30))
})

test('Weather3D: without the radar\'s tiles yet it builds without its clouds, and builds again when they come (not at every look)', async () => {
  const r = rig()
  giveTiles(r, echoTiles(AC, [[20, 0, 50]]))
  r.tileHold.on = true
  await open(r)
  for (const t of [16, 1000, 1016, 2000, 2016]) r.w.update(AC, t)
  assert.ok(r.sky.clouds.draws.length >= 1 && r.sky.clouds.draws.every((d) => towerPuffs(d).length === 0))
  const waiting = r.sky.clouds.draws.length
  assert.equal(r.sky.shafts.draws.at(-1)!.length, 0)
  assert.equal(new Set(r.tileAsks).size, r.tileAsks.length, 'asked once while it waits')
  assert.equal(waiting, r.sky.clouds.draws.length, 'nothing to build while it waits')
  r.tileHold.on = false
  r.releaseTiles()
  await flush()
  drawn(r, AC, 3000)
  assert.ok(towerPuffs(r.sky.clouds.draws.at(-1)!).length > 0, 'built when the tile came')
  assert.equal(r.sky.shafts.draws.at(-1)!.length, 1)
  const [clouds, shafts] = [r.sky.clouds.draws.length, r.sky.shafts.draws.length]
  for (const t of [4000, 4016, 5000, 5016, 6000, 6016]) r.w.update(AC, t)
  assert.deepEqual([r.sky.clouds.draws.length, r.sky.shafts.draws.length], [clouds, shafts], 'nothing new, nothing built')
})

test('Weather3D: a newer radar frame keeps drawing the old frame\'s clouds until its own tiles come, then swaps (no gap)', async () => {
  const r = rig()
  giveTiles(r, echoTiles(AC, [[20, 0, 50]]))
  await open(r)
  drawn(r, AC, 1000)
  assert.ok(near(towerHeight(towerPuffs(r.sky.clouds.draws.at(-1)!)), 8500, 1e-6), '50 dBZ: 8.5 km')
  r.answers.radar = { host: HOST, radar: { past: [{ time: 1759421400, path: '/v2/radar/newer' }] } }
  giveTiles(r, echoTiles(AC, [[20, 0, 60]])) // what the newer frame says
  r.tileHold.on = true
  r.w.update(AC, 10 * MIN) // the radar frame and the METARs are due again
  await flush()
  assert.equal(r.w.radar!.url, `${HOST}/v2/radar/newer/256/{z}/{x}/{y}/2/0_1.png`)
  drawn(r, AC, 10 * MIN + 1000)
  assert.ok(r.tileAsks.length >= 2, 'the newer frame\'s tile asked for')
  assert.ok(near(towerHeight(towerPuffs(r.sky.clouds.draws.at(-1)!)), 8500, 1e-6), 'still the old frame\'s, not a gap')
  r.tileHold.on = false
  r.releaseTiles()
  await flush()
  drawn(r, AC, 10 * MIN + 2000)
  assert.ok(near(towerHeight(towerPuffs(r.sky.clouds.draws.at(-1)!)), 10_000, 1e-6), 'then the newer: 60 dBZ, 10 km')
})

test('Weather3D: ?wxat reads the radar where the aircraft is in the weather\'s own place and draws the clouds where the sky is drawn (shifted)', async () => {
  const zurich = { lat: 47.4, lon: 8.5 }
  const r = rig({ at: zurich })
  giveTiles(r, echoTiles(zurich, [[20, 0, 50], [0, -25, 40]]))
  await open(r)
  drawn(r, AC, 1000)
  const shift = r.w.shift
  assert.ok(near(shift.dLat, AC.lat - zurich.lat, 1e-12))
  const cells = radarCells(tileGetter(r), AC.lat - shift.dLat, AC.lon - shift.dLon, shift, READ_KM)
  assert.equal(cells.length, 2)
  const sky = r.sky.clouds.draws.at(-1)!
  assert.deepEqual(sky, nearestClouds([radarClouds(cells, radarBases(r.w.metars))], AC.lat, AC.lon))
  assert.ok(towerPuffs(sky).length > 0 && towerPuffs(sky).every((c) => kmFrom(c, AC) < 100), 'round the aircraft: Zurich\'s sky moved onto it')
  assert.ok(r.tileAsks.every((k) => { const [, x] = k.split('/').map(Number); return x >= 60 && x <= 70 }), 'the tiles round Zurich, not round Haifa (x 76)')
})

test('Weather3D: the radar\'s clouds keep a place in the 700 (RADAR_LOOK.reserve): the observed clouds give way, the farthest first; with none kept they come first', async () => {
  const stations = Array.from({ length: 12 }, (_, i) => metar(`S${i}`, 32.1 + ((i % 4) - 1.5) * 0.25, 34.9 + (Math.floor(i / 4) - 1) * 0.3, { elevM: 30, clouds: [layer('OVC', 1500)] }))
  const run = async (): Promise<{ drawn: CloudSpec[]; expected: CloudSpec[] }> => {
    const r = rig()
    giveTiles(r, echoTiles(AC, [[20, 0, 50], [-15, 10, 42], [5, -20, 38]]))
    r.answers.metar = stations
    await open(r)
    drawn(r, AC, 1000)
    const expected = radarClouds(radarCells(tileGetter(r), AC.lat, AC.lon, undefined, READ_KM), radarBases(r.w.metars))
    return { drawn: r.sky.clouds.draws.at(-1)!, expected }
  }
  const kept = await run()
  assert.equal(kept.drawn.length, MAX_CLOUDS)
  assert.ok(kept.expected.length > 10 && kept.expected.every((e) => kept.drawn.some((c) => isDeepStrictEqual(c, e))), 'every cloud of the radar is drawn')
  const was = RADAR_LOOK.reserve
  try {
    RADAR_LOOK.reserve = 0
    const first = await run()
    assert.equal(first.drawn.length, MAX_CLOUDS)
    assert.equal(towerPuffs(first.drawn).length, 0, 'the observed clouds fill the 700: none left for the radar\'s')
  } finally {
    RADAR_LOOK.reserve = was
  }
})

test('Weather3D: rebuildSky builds the radar\'s clouds again as RADAR_LOOK says now (a check aid)', async () => {
  const r = rig()
  giveTiles(r, echoTiles(AC, [[20, 0, 50]]))
  await open(r)
  drawn(r, AC, 1000)
  assert.ok(near(towerHeight(towerPuffs(r.sky.clouds.draws.at(-1)!)), 8500, 1e-6))
  const was = RADAR_LOOK.tops
  try {
    ;(RADAR_LOOK as { tops: readonly (readonly [number, number])[] }).tops = [[30, 1000], [45, 2000], [55, 3000]]
    r.w.rebuildSky()
    drawn(r, AC, 1048) // not a look: the frames after the rebuild
    assert.ok(near(towerHeight(towerPuffs(r.sky.clouds.draws.at(-1)!)), 2500, 1e-6))
  } finally {
    ;(RADAR_LOOK as { tops: readonly (readonly [number, number])[] }).tops = was
  }
})

test('Weather3D: every frame the shafts follow the relief drawn and the Sun\'s night, at each look they are faded from the aircraft; hidden, they are hidden and nothing of the radar is asked', async () => {
  const r = rig()
  giveTiles(r, echoTiles(AC, [[20, 0, 50]]))
  await open(r)
  const flat = { fSampled: 0, fNow: 0, relHM: 120 }
  r.w.setNight(0.6)
  r.w.update(AC, 10, flat)
  assert.deepEqual(r.sky.shafts.frames.at(-1), [flat, 0.6])
  r.w.update(null, 20, TRUE)
  assert.deepEqual(r.sky.shafts.frames.at(-1), [TRUE, 0.6], 'with no aircraft too')
  assert.ok(Cartesian3.equalsEpsilon(r.sky.shafts.fades.at(-1)!, Cartesian3.fromDegrees(AC.lon, AC.lat, AC.altM), 0, 1e-6))
  const n = r.sky.shafts.fades.length
  r.w.update(north(5), 500)
  assert.equal(r.sky.shafts.fades.length, n, 'between looks: no fade')
  r.w.update(north(5), 1000)
  assert.ok(Cartesian3.equalsEpsilon(r.sky.shafts.fades.at(-1)!, Cartesian3.fromDegrees(AC.lon, north(5).lat, AC.altM), 0, 1e-6))
  r.w.show = false
  assert.equal(r.sky.shafts.show, false)
  const [frames, asks] = [r.sky.shafts.frames.length, r.tileAsks.length]
  r.w.update(north(40), 5 * MIN, flat)
  await flush()
  assert.equal(r.sky.shafts.frames.length, frames)
  assert.equal(r.tileAsks.length, asks, 'hidden: nothing asked')
  r.w.show = true
  assert.equal(r.sky.shafts.show, true)
})

test('Weather3D: the radar\'s clouds are built again once the aircraft has moved 30 km, from the tiles it has', async () => {
  const r = rig()
  giveTiles(r, echoTiles(AC, [[20, 0, 50]]))
  await open(r)
  drawn(r, AC, 1000)
  const draws = (): number => r.sky.clouds.draws.length
  const n = draws()
  drawn(r, north(29), 2000)
  assert.equal(draws(), n, '29 km: not yet')
  drawn(r, north(30.5), 3000)
  assert.equal(draws(), n + 1)
  assert.deepEqual(r.sky.shafts.draws.at(-1)!.length, 1, 'the cell is still within 100 km')
})

test('Weather3D: the radar frame answered after the reports: the next look builds the radar\'s clouds from its tiles (here in the tile below the camera\'s, which only the clouds read)', async () => {
  const r = rig()
  giveTiles(r, echoTiles(AC, [[0, -20, 50]]))
  assert.ok(r.tiles.size === 1 && !r.tiles.has(`7/${radarPixel(AC.lat, AC.lon).x}/${radarPixel(AC.lat, AC.lon).y}`), 'not the camera\'s tile')
  r.answers.metar = [metar('LLBG', 32.01, 34.89, { elevM: 30, clouds: [layer('BKN', 2000)] })]
  r.hold.add('radar')
  await open(r) // the reports are in, the radar's answer is held
  r.w.update(AC, 16)
  assert.equal(r.tileAsks.length, 0, 'no frame: no tile to ask for')
  assert.equal(towerPuffs(r.sky.clouds.draws.at(-1)!).length, 0)
  r.hold.clear()
  r.release()
  await flush()
  drawn(r, AC, 1000) // a look: the radar is known; its tiles are asked for
  await flush()
  drawn(r, AC, 2000) // a look: they have come
  assert.ok(towerPuffs(r.sky.clouds.draws.at(-1)!).length > 0)
})

test('Weather3D: over a long flight only the latest 16 radar tiles are kept; one given up is asked for again when it is wanted (the source has it), and its clouds come back', async () => {
  const r = rig()
  const home = { lat: 0, lon: 0 }
  giveTiles(r, echoTiles(home, [[10, 0, 50]]))
  await open(r, { lat: 0, lon: 0, altM: 10_000 })
  drawn(r, { lat: 0, lon: 0, altM: 10_000 }, 1000)
  assert.ok(towerPuffs(r.sky.clouds.draws.at(-1)!).length > 0, 'home: a tower')
  const homeKey = `7/${radarPixel(0, 0).x}/${radarPixel(0, 0).y}`
  const asksOfHome = (): number => r.tileAsks.filter((k) => k === homeKey).length
  assert.equal(asksOfHome(), 1)
  let t = 2000
  for (let lon = 3; lon <= 60; lon += 3) { // 20 steps of 3°: a tile or two each, more than 16 in all
    r.w.update({ lat: 0, lon, altM: 10_000 }, t)
    await flush()
    t += 1000
  }
  assert.ok(new Set(r.tileAsks).size > 16, `${new Set(r.tileAsks).size} tiles asked for`)
  assert.equal(asksOfHome(), 1, 'asked once so far')
  drawn(r, { lat: 0, lon: 0, altM: 10_000 }, t) // back where it began: a look, the radar's part (the tile is asked for again)
  await flush()
  assert.equal(asksOfHome(), 2, 'given up, so asked for again')
  drawn(r, { lat: 0, lon: 0, altM: 10_000 }, t + 1000)
  assert.ok(towerPuffs(r.sky.clouds.draws.at(-1)!).length > 0, 'its tower is back')
})

test('Weather3D: a late tile of an older frame does not replace the newest frame\'s', async () => {
  const r = rig()
  r.frameTiles.set('/v2/radar/new/', echoTiles(AC, [[20, 0, 50]])) // INDEX's newest frame: 50 dBZ, 8.5 km
  r.frameTiles.set('/v2/radar/newer', echoTiles(AC, [[20, 0, 60]])) // the frame after: 60 dBZ, 10 km
  r.tileHold.on = true
  await open(r) // the first frame's tiles are asked for, and held
  r.w.update(AC, 1000)
  r.answers.radar = { host: HOST, radar: { past: [{ time: 1759421400, path: '/v2/radar/newer' }] } }
  r.w.update(AC, 10 * MIN)
  await flush()
  drawn(r, AC, 10 * MIN + 1000) // the newer frame's tiles are asked for, and held
  assert.ok(r.tileAsks.length >= 2)
  r.releaseTiles(true) // the newer frame's first, then the older's, late
  await flush()
  drawn(r, AC, 10 * MIN + 2000)
  assert.ok(near(towerHeight(towerPuffs(r.sky.clouds.draws.at(-1)!)), 10_000, 1e-6), 'the newer frame\'s tile stands')
})

test('Weather3D: the radar is read REBUILD_KM past where its clouds fade out: a storm 115 km off is built, hidden by the fade, and fades in as the aircraft closes (it does not pop in at the next build)', async () => {
  const r = rig()
  const east = (km: number): typeof AC => ({ ...AC, lon: AC.lon + km / (KM_PER_DEG * Math.cos((AC.lat * Math.PI) / 180)) })
  giveTiles(r, echoTiles(AC, [[115, 0, 50], [-112, 15, 42], [0, 20, 40]])) // two storms in the ring, one near
  await open(r)
  drawn(r, AC, 1000)
  const sky = r.sky.clouds.draws.at(-1)!
  const puffs = towerPuffs(sky)
  assert.equal(new Set(puffs.map((c) => c.tower)).size, 3, 'all three storms are built')
  const outer = puffs.filter((c) => kmFrom(c, AC) > 100)
  assert.ok(outer.length >= 8, `${outer.length} puffs of the two storms in the ring`)
  for (const c of outer) assert.ok(c.farKm <= 100 && fadeAlpha(c, kmFrom(c, AC)) === 0, `hidden where it stands (${kmFrom(c, AC).toFixed(0)} km)`)
  assert.ok(puffs.filter((c) => kmFrom(c, AC) < 25).every((c) => fadeAlpha(c, kmFrom(c, AC)) === 1), 'the near one is all there')
  const shafts = r.sky.shafts.draws.at(-1)!
  assert.equal(shafts.length, 3)
  const km = (s: { lat: number; lon: number }, a: typeof AC): number => kmFrom(s, a)
  assert.equal(shafts.filter((s) => km(s, AC) > 100).length, 2)
  for (const s of shafts.filter((s) => km(s, AC) > 100)) assert.equal(fadeAlpha(s, km(s, AC)), 0, 'a shaft in the ring is hidden too')
  const draws = r.sky.clouds.draws.length
  drawn(r, east(28), 2000) // flown 28 km toward the east storm: not far enough for a build
  assert.equal(r.sky.clouds.draws.length, draws, 'no new build')
  const east50 = puffs.filter((c) => c.lon > AC.lon + 0.5)
  assert.ok(east50.length >= 4)
  assert.ok(east50.every((c) => fadeAlpha(c, kmFrom(c, east(28))) > 0), 'showing now')
  assert.ok(east50.some((c) => fadeAlpha(c, kmFrom(c, east(28))) > 0.2) && east50.every((c) => fadeAlpha(c, kmFrom(c, east(28))) < 1), 'and part way through its fade, not at full strength at once')
  const shaft = shafts.find((s) => s.lon > AC.lon + 0.5)!
  assert.ok(fadeAlpha(shaft, km(shaft, east(28))) > 0, 'its shaft too')
})

test('Weather3D: tiles that come one by one are built from once, when the last has come; one that is slow is not waited for past 3 s', async () => {
  const r = rig()
  giveTiles(r, echoTiles(AC, [[0, 0, 40], [0, -35, 45], [-40, 0, 42]])) // three tiles of the box have an echo
  r.tileHold.on = true
  await open(r)
  drawn(r, AC, 1000) // asks the tiles
  const asked = r.held()
  assert.ok(asked >= 4, `${asked} tiles asked for, held`)
  const draws = (): number => r.sky.clouds.draws.length
  r.releaseSome(1)
  await flush()
  const n = draws()
  drawn(r, AC, 2000)
  assert.equal(draws(), n, 'one has come, the others are on their way: no build for it alone')
  r.releaseSome(asked - 2)
  await flush()
  drawn(r, AC, 3000)
  assert.equal(draws(), n, 'one is still on its way: not yet')
  r.tileHold.on = false
  r.releaseTiles()
  await flush()
  drawn(r, AC, 4000)
  assert.equal(draws(), n + 1, 'the last has come: one build, from them all')
  assert.equal(new Set(towerPuffs(r.sky.clouds.draws.at(-1)!).map((c) => c.tower)).size, 3)
  drawn(r, AC, 5000)
  drawn(r, AC, 6000)
  assert.equal(draws(), n + 1, 'and no more')
  // a tile that never comes
  const slow = rig()
  giveTiles(slow, echoTiles(AC, [[0, 0, 40], [0, -35, 45]]))
  slow.tileHold.on = true
  await open(slow)
  drawn(slow, AC, 1000)
  const total = slow.held()
  slow.releaseSome(total - 1) // all but one
  await flush()
  const m = slow.sky.clouds.draws.length
  drawn(slow, AC, 2000)
  drawn(slow, AC, 3000)
  assert.equal(slow.sky.clouds.draws.length, m, 'waiting for the last: 1 s, 2 s')
  drawn(slow, AC, 4500)
  assert.equal(slow.sky.clouds.draws.length, m + 1, 'then built from the ones that came: it is not waited for forever')
  assert.ok(towerPuffs(slow.sky.clouds.draws.at(-1)!).length > 0)
})

test('Weather3D: the box the radar is read in is kept in memory whatever the latitude: at 78°N its 6 tiles across are held, none asked for again, no build at every look', async () => {
  const r = rig()
  const at = { lat: 78, lon: 20, altM: 10_000 }
  const echoes: [number, number, number][] = []
  for (let e = -128; e <= 128; e += 16) for (let n = -128; n <= 128; n += 16) echoes.push([e, n, 40])
  giveTiles(r, echoTiles(at, echoes))
  assert.ok(r.tiles.size > 16, `${r.tiles.size} tiles hold an echo: more than the 16 kept at the very least`)
  await open(r, at)
  for (let t = 1000; t <= 12_000; t += 1000) {
    drawn(r, at, t)
    await flush()
  }
  assert.ok(new Set(r.tileAsks).size > 16, `${new Set(r.tileAsks).size} tiles asked for`)
  assert.equal(r.tileAsks.length, new Set(r.tileAsks).size, 'each once: none given up and asked for again')
  const draws = r.sky.clouds.draws.length
  drawn(r, at, 13_000)
  drawn(r, at, 14_000)
  assert.equal(r.sky.clouds.draws.length, draws, 'settled: nothing built at each look')
})

test('Weather3D: the radar frames it has left do not stay in memory: its tiles hold the frame\'s URL, not the source (which holds every tile of its frame), so a frame whose tiles were not asked again is let go', async () => {
  v8.setFlagsFromString('--expose-gc')
  const gc = vm.runInNewContext('gc') as () => void
  const r = rig()
  giveTiles(r, echoTiles(AC, [[20, 0, 50]]))
  await open(r)
  drawn(r, AC, 1000)
  const old = (() => new WeakRef(r.w.radar!))()
  assert.ok(towerPuffs(r.sky.clouds.draws.at(-1)!).length > 0, 'its tiles are held')
  r.answers.radar = { host: HOST, radar: { past: [{ time: 1759421400, path: '/v2/radar/newer' }] } }
  drawn(r, AC, 5 * MIN + 1000) // the METARs again, so that they are not due with the radar frame at 10 min (their answer would build the sky at the old place)
  await flush()
  drawn(r, AC, 10 * MIN) // the look that asks for the newer frame: nothing of it yet
  await flush()
  const far = { lat: AC.lat, lon: AC.lon + 6, altM: AC.altM } // 570 km on: the newer frame's tiles are others; the old frame's stay in the store until it is full
  drawn(r, far, 10 * MIN + 1000)
  await flush()
  drawn(r, far, 10 * MIN + 2000)
  assert.ok(r.w.radar!.url.includes('newer'))
  for (let i = 0; i < 3; i++) {
    gc() // (not after a deref in the same job: deref keeps its target alive until the job ends)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(old.deref(), undefined, 'the older frame\'s source is gone')
})

test('echoShade: rain on the radar over the camera greys the sky by its strength', () => {
  assert.equal(echoShade(5), 0)
  assert.equal(echoShade(15), 0.5)
  assert.equal(echoShade(32), 0.75)
  assert.equal(echoShade(48), 0.9)
})


// ---- the model: clouds where nothing else says, the wind aloft ---------------------------------------------------------------

const cloudKey = (c: CloudSpec): string => `${c.lon}|${c.lat}|${c.heightM}|${c.scale[0]}`
const keysOf = (cs: readonly CloudSpec[]): Set<string> => new Set(cs.map(cloudKey))
/** A grid of mid and high cloud everywhere. */
const CLOUDY = (geo: ModelGeo): ModelGrid => gridFor(geo, { cover: (hPa) => (hPa === 600 || hPa === 250 ? 70 : 0) })

test('Weather3D: the model\'s grid is asked for at the first look with an aircraft, again after 30 min, and when the aircraft leaves the inner half of the grid it holds, not within 30 s of the last ask', async () => {
  const r = rig()
  await open(r)
  assert.deepEqual(r.asks('model'), ['/api/wx/model?lat=32.1&lon=34.9'])
  const first = r.w.model!
  assert.deepEqual([first.lat0, first.lon0, first.step, first.n], [31.5, 34, 0.25, 7], 'the cell 32 to 32.5°N, 34.5 to 35°E: its grid from 31.5°N 34°E, its middle at 32.25°N 34.75°E')
  for (const [at, t] of [[{ ...AC, lat: 32.62 }, 5000], [{ ...AC, lat: 31.88 }, 6000], [{ ...AC, lon: 35.12 }, 7000], [{ ...AC, lon: 34.38 }, 8000]] as const) r.w.update(at, t) // 0.37° from the middle: inside
  await flush()
  assert.equal(r.asks('model').length, 1)
  r.w.update({ ...AC, lat: 32.63 }, 10_000) // out of the inner half (0.375°), 10 s after the ask
  await flush()
  assert.equal(r.asks('model').length, 1, 'not within 30 s of the last ask')
  r.w.update({ ...AC, lat: 32.63 }, 30_000)
  await flush()
  assert.deepEqual(r.asks('model').slice(1), ['/api/wx/model?lat=32.63&lon=34.9'])
  assert.equal(r.w.model!.lat0, 32, 'the cell north of it: its grid from 32°N')
  for (const t of [31_000, 40_000, 90_000]) r.w.update({ ...AC, lat: 32.63 }, t)
  r.w.update({ ...AC, lat: 32.4 }, 100_000)
  await flush()
  assert.equal(r.asks('model').length, 2, 'inside the new grid\'s inner half: nothing more')
  r.w.update({ ...AC, lat: 32.63 }, 30_000 + 30 * MIN - 1000)
  await flush()
  assert.equal(r.asks('model').length, 2, 'not yet: 30 min from the last ask')
  r.w.update({ ...AC, lat: 32.63 }, 30_000 + 30 * MIN)
  await flush()
  assert.deepEqual(r.asks('model').slice(2), [r.asks('model')[1]], 'after 30 min, the same place')
})

test('Weather3D: a failed model ask is one warning and a note on the line, asked again in 30 s, the rest still drawn; an answer that is not a grid is a failed ask too', async () => {
  const warned: unknown[][] = []
  const warn = console.warn
  console.warn = (...a: unknown[]) => void warned.push(a)
  try {
    const r = rig()
    r.answers.sigmet = [sigmet({ rings: [northOf(300, 2)] })]
    r.failing.add('model')
    await open(r)
    assert.equal(r.asks('model').length, 1)
    assert.equal(warned.length, 1)
    assert.match(String(warned[0][0]), /FlightHopper: 3-D weather .*wx\/model/)
    assert.equal(r.lines.at(-1), 'Clouds from 0 airports · 1 hazard area · some weather unavailable')
    assert.equal(r.w.model, null)
    assert.equal(r.volumes().length, 1, 'the rest came')
    r.w.update(AC, 29_000)
    await flush()
    assert.equal(r.asks('model').length, 1)
    r.w.update(AC, 30_000)
    await flush()
    assert.equal(r.asks('model').length, 2, 'asked again after 30 s, not 30 min')
    r.failing.clear()
    r.w.update(AC, 61_000)
    await flush()
    assert.equal(r.asks('model').length, 3)
    assert.equal(r.lines.at(-1), 'Clouds from 0 airports · 1 hazard area', 'the note goes when it is answered')
    assert.notEqual(r.w.model, null)
    r.w.update(AC, 61_000 + 29 * MIN)
    await flush()
    assert.equal(r.asks('model').length, 3, 'and then the usual 30 min')

    const good = gridFor({ lat0: 31.5, lon0: 34, step: 0.25, n: 7 })
    for (const [name, bad] of Object.entries({
      error: { error: 'nope' }, null: null, text: 'x', list: [], empty: {}, noPlaces: { ...good, n: 0 }, wrongN: { ...good, n: 'x' }, noStep: { ...good, step: 0 },
      noOrigin: { ...good, lat0: null }, noClouds: { ...good, clouds: 'none' }, noWinds: { ...good, winds: null }, noGround: { ...good, elevM: 4 }, badLevel: { ...good, clouds: [{ hPa: 700 }] },
    })) {
      const s = rig()
      s.model.make = () => bad
      await open(s)
      assert.equal(s.w.model, null, name)
      assert.match(String(s.lines.at(-1)), /some weather unavailable$/, name)
    }
  } finally {
    console.warn = warn
  }
})

test('Weather3D: an answer to an ask that has been replaced by a later one is not heard; destroyed, none is', async () => {
  const r = rig()
  await open(r) // the grid from 31.5°N
  r.hold.add('model')
  r.w.update({ ...AC, lat: 32.7 }, 30_000) // out of its inner half: asked for the cell north (32.5 to 33°N), held
  r.hold.clear()
  r.w.update({ ...AC, lat: 33.3 }, 60_000) // the first answer has not come, and the aircraft is farther on: asked for the cell at 33°N, answered at once
  await flush()
  assert.equal(r.asks('model').length, 3)
  assert.equal(r.w.model!.lat0, 32.5)
  r.release() // the second ask's answer lands late
  await flush()
  assert.equal(r.w.model!.lat0, 32.5, 'it does not replace the newer one')
  const late = rig()
  late.hold.add('model')
  late.w.show = true
  late.w.update(AC, 0)
  late.w.destroy()
  late.release()
  await flush()
  assert.equal(late.w.model, null)
})

test('Weather3D: ?wxat asks for the model round that place and keeps its grid where it is drawn, over the aircraft', async () => {
  const zurich = { lat: 47.4, lon: 8.5 }
  const r = rig({ at: zurich })
  r.model.make = CLOUDY
  await open(r) // the aircraft is over Haifa
  assert.deepEqual(r.asks('model'), ['/api/wx/model?lat=47.4&lon=8.5'], 'the place the aircraft is at in Zurich\'s sky')
  const d = r.w.shift
  const g = r.w.model!
  assert.ok(near(g.lat0, 46.5 + d.dLat, 1e-9) && near(g.lon0, 8 + d.dLon, 1e-9), `${g.lat0}, ${g.lon0}: Zurich\'s grid (from 46.5°N 8°E) moved onto the aircraft`)
  assert.notEqual(r.w.windAt(AC.lat, AC.lon, 30_000), null, 'the grid is round the aircraft')
  assert.equal(r.w.windAt(zurich.lat, zurich.lon, 30_000), null, 'not round Zurich: its sky is drawn over Haifa')
  drawn(r, AC, 1000)
  const sky = r.sky.clouds.draws.at(-1)!
  assert.ok(sky.length > 100 && sky.every((c) => kmFrom(c, AC) <= 150), 'its clouds round the aircraft')
})

test('Weather3D: the model\'s clouds are built when the grid comes and drawn the frame after, from the grid and the reports held, after the observed ones', async () => {
  const r = rig()
  r.model.make = CLOUDY
  r.answers.metar = [metar('LLBG', 32.01, 34.89, { clouds: [layer('FEW', 3000)] })]
  await open(r)
  assert.equal(r.sky.clouds.draws.length, 0, 'built at the look, not drawn in it')
  r.w.update(AC, 16)
  assert.equal(r.sky.clouds.draws.length, 1)
  const observed = observedClouds(r.w.metars, AC.lat, AC.lon).specs
  const model = modelClouds(r.w.model!, r.w.metars)
  assert.ok(observed.length > 0 && model.length === MODEL_LOOK.max)
  const sky = r.sky.clouds.draws[0]
  assert.deepEqual(sky, nearestClouds([observed, model], AC.lat, AC.lon))
  const seen = nearestClouds([observed], AC.lat, AC.lon)
  assert.deepEqual(sky.slice(0, seen.length), seen, 'the observed first')
  assert.ok(sky.length === seen.length + model.length && sky.every((c) => kmFrom(c, AC) <= 150), 'then all of the model\'s that are within reach')
  assert.equal(r.lines.at(-1), 'Clouds from 1 airport · 0 hazard areas', 'the line counts airports, as it did')
  r.w.update(AC, 32)
  assert.equal(r.sky.clouds.draws.length, 1, 'drawn once')
})

test('Weather3D: with no grid yet, or one with no cloud, the sky is the observed and the radar\'s as before', async () => {
  const r = rig()
  r.hold.add('model')
  r.answers.metar = [metar('LLBG', 32.01, 34.89, { clouds: [layer('SCT', 3000)] })]
  await open(r)
  r.w.update(AC, 16)
  assert.deepEqual(r.sky.clouds.draws.at(-1), nearestClouds([observedClouds(r.w.metars, AC.lat, AC.lon).specs], AC.lat, AC.lon))
  const n = r.sky.clouds.draws.length
  r.hold.clear()
  r.release() // the grid comes: clear
  await flush()
  r.w.update(AC, 32)
  r.w.update(AC, 48)
  assert.deepEqual(r.sky.clouds.draws.at(-1), r.sky.clouds.draws[0])
  assert.ok(r.sky.clouds.draws.length <= n + 1, 'built again for the grid, the same sky')
  assert.equal(r.w.model!.clouds.every((l) => l.cover.every((c) => c === 0)), true)
})

test('Weather3D: the 700 are the observed clouds first, the radar\'s, then the model\'s, each nearest first: the model fills what is left', async () => {
  const r = rig()
  giveTiles(r, echoTiles(AC, [[20, 0, 50], [-15, 10, 42]]))
  r.model.make = CLOUDY
  r.answers.metar = [metar('LLBG', 32.01, 34.89, { elevM: 30, clouds: [layer('SCT', 2000)] })]
  await open(r)
  drawn(r, AC, 1000)
  const sky = r.sky.clouds.draws.at(-1)!
  const observed = keysOf(observedClouds(r.w.metars, AC.lat, AC.lon).specs)
  const radar = keysOf(radarClouds(radarCells(tileGetter(r), AC.lat, AC.lon, undefined, READ_KM), radarBases(r.w.metars)))
  const model = keysOf(modelClouds(r.w.model!, r.w.metars))
  const group = sky.map((c) => (observed.has(cloudKey(c)) ? 0 : radar.has(cloudKey(c)) ? 1 : model.has(cloudKey(c)) ? 2 : -1))
  assert.ok(!group.includes(-1), 'every cloud is one of the three sources\'')
  assert.deepEqual(group, [...group].sort((a, b) => a - b), 'in order: observed, radar\'s, model\'s')
  assert.deepEqual([...new Set(group)], [0, 1, 2])
  assert.ok(sky.length <= MAX_CLOUDS)
})

test('Weather3D: where the observed clouds fill the 700 the model\'s are not drawn at all', async () => {
  const stations = Array.from({ length: 12 }, (_, i) => metar(`S${i}`, 32.1 + ((i % 4) - 1.5) * 0.25, 34.9 + (Math.floor(i / 4) - 1) * 0.3, { elevM: 30, clouds: [layer('OVC', 1500)] }))
  const r = rig()
  r.model.make = CLOUDY
  r.answers.metar = stations
  await open(r)
  drawn(r, AC, 1000)
  const sky = r.sky.clouds.draws.at(-1)!
  assert.equal(sky.length, MAX_CLOUDS)
  const model = keysOf(modelClouds(r.w.model!, r.w.metars))
  assert.equal(model.size, MODEL_LOOK.max)
  assert.ok(!sky.some((c) => model.has(cloudKey(c))), 'none of the model\'s')
})

test('Weather3D: the model\'s low clouds are left out near the reports it holds (observations win), as modelClouds says; a report that comes later takes them away', async () => {
  const r = rig()
  r.model.make = (geo) => gridFor(geo, { cover: (hPa) => (hPa === 925 ? 70 : 0) })
  const lowNearStation = (): CloudSpec[] => r.sky.clouds.draws.at(-1)!.filter((c) => near(c.heightM - (PUFF_FILL * c.scale[1]) / 2, 760, 1e-6) && Math.abs(c.lat - 32.25) < 0.37 && Math.abs(c.lon - 34.75) < 0.37)
  await open(r)
  drawn(r, AC, 1000)
  assert.ok(lowNearStation().length > 10, 'no report: the model\'s low deck over the block of places round the middle')
  r.answers.metar = [metar('LLBG', 32.25, 34.75, { clouds: [layer('FEW', 3000)] })] // over the middle place of the grid, at the next list
  r.w.update(AC, 5 * MIN)
  await flush()
  drawn(r, AC, 5 * MIN + 1000)
  const model = modelClouds(r.w.model!, r.w.metars)
  assert.notDeepEqual(model, modelClouds(r.w.model!, []), 'the report counts')
  const sky = keysOf(r.sky.clouds.draws.at(-1)!)
  assert.ok(model.length > 100 && model.every((c) => sky.has(cloudKey(c))), 'its clouds are the ones drawn')
  assert.equal(lowNearStation().filter((c) => keysOf(model).has(cloudKey(c))).length, 0, 'none of the model\'s in the block of places within 40 km of the station')
})

test('Weather3D: a new grid builds the sky again from it, with nothing else new (the aircraft has left the inner half of the old one, 14 km on)', async () => {
  const r = rig()
  const at = { ...AC, lat: 32.0 } // the cell 32 to 32.5°N: the aircraft is 0.25° south of its grid's middle
  await open(r, at)
  drawn(r, at, 1000)
  assert.equal(r.sky.clouds.draws.at(-1)!.length, 0, 'a clear grid')
  const draws = r.sky.clouds.draws.length
  r.model.make = CLOUDY
  const south = { ...at, lat: 31.87 } // 0.38° from the middle: out of the inner half, 14 km from where the clouds were built
  r.w.update(south, 30_000)
  await flush()
  assert.equal(r.asks('model').length, 2)
  assert.equal(r.asks('metar').length, 1, 'nothing else asked')
  drawn(r, south, 31_000)
  assert.ok(r.sky.clouds.draws.length > draws && r.sky.clouds.draws.at(-1)!.length > 100, 'built again for the new grid')
  assert.deepEqual(r.sky.clouds.draws.at(-1), nearestClouds([modelClouds(r.w.model!, r.w.metars)], south.lat, south.lon))
})

test('Weather3D: the model\'s clouds are worked out once for a grid and the reports, not at every rebuild: a radar tile or 30 km of flight builds the sky again from the same clouds', async () => {
  const r = rig()
  r.model.make = CLOUDY
  r.answers.metar = [metar('LLBG', 32.01, 34.89, { clouds: [layer('FEW', 3000)] })]
  await open(r)
  r.w.update(AC, 16)
  const model = keysOf(modelClouds(r.w.model!, r.w.metars))
  const first = r.sky.clouds.draws[0].filter((c) => model.has(cloudKey(c)))
  assert.ok(first.length > 100)
  r.w.update(north(30.5), 2000) // 30 km on: built again
  r.w.update(north(30.5), 2016)
  assert.equal(r.sky.clouds.draws.length, 2)
  const second = r.sky.clouds.draws[1].filter((c) => model.has(cloudKey(c)))
  assert.ok(second.length > 100 && second.every((c) => first.includes(c)), 'the same objects')
})

test('Weather3D: rebuildSky works the model\'s clouds out again from the grid, so a changed look shows (a check aid)', async () => {
  const r = rig()
  r.model.make = (geo) => gridFor(geo, { cover: (hPa, p) => (hPa === 925 && p === 24 ? 100 : 0) }) // an overcast low deck over the middle place
  await open(r)
  r.w.update(AC, 16)
  const was = MODEL_LOOK.low.density
  const before = r.sky.clouds.draws[0].length
  assert.ok(before > 100)
  try {
    ;(MODEL_LOOK.low as { density: number }).density = was / 2
    r.w.update(AC, 1000) // a look, no rebuild due
    r.w.update(AC, 1016)
    assert.equal(r.sky.clouds.draws.length, 1)
    r.w.rebuildSky()
    r.w.update(AC, 1032)
    assert.equal(r.sky.clouds.draws.length, 2)
    assert.ok(near(r.sky.clouds.draws[1].length, before / 2, 1), `${r.sky.clouds.draws[1].length} against half of ${before}`)
  } finally {
    ;(MODEL_LOOK.low as { density: number }).density = was
  }
})

test('Weather3D: the model\'s wind at a place and pressure altitude, from the grid as drawn; none while hidden, before the grid has come, or outside it', async () => {
  const r = rig()
  assert.equal(r.w.windAt(AC.lat, AC.lon, 30_000), null, 'hidden, no grid')
  assert.equal(r.w.model, null)
  r.hold.add('model')
  r.w.show = true
  r.w.update(AC, 0)
  assert.equal(r.w.windAt(AC.lat, AC.lon, 30_000), null, 'asked, not answered')
  r.hold.clear()
  r.release()
  await flush()
  const w = r.w.windAt(AC.lat, AC.lon, 30_000)!
  assert.deepEqual(w, modelWindAt(r.w.model!, AC.lat, AC.lon, 30_000))
  assert.ok(near(w.kt, 80, 0.3) && near(w.fromDeg, 270, 0.5), `${w.kt} kt from ${w.fromDeg}: the 300 hPa wind, 30,000 ft being 301 hPa`)
  assert.ok(near(r.w.windAt(AC.lat, AC.lon, 18_289)!.kt, 40, 0.3), 'the 500 hPa wind at 18,289 ft')
  assert.equal(r.w.windAt(40, AC.lon, 30_000), null, 'north of the grid')
  r.w.show = false
  assert.equal(r.w.windAt(AC.lat, AC.lon, 30_000), null, 'hidden: none')
  assert.notEqual(r.w.model, null, 'its grid is kept')
  r.w.show = true
  assert.deepEqual(r.w.windAt(AC.lat, AC.lon, 30_000), w, 'shown again: from what it holds')
})

test('Weather3D: a grid that lands while it is hidden is kept, not drawn; shown again, its clouds are built at once', async () => {
  const r = rig()
  r.model.make = CLOUDY
  r.hold.add('model')
  r.w.show = true
  r.w.update(AC, 0)
  r.w.show = false
  r.hold.clear()
  r.release()
  await flush()
  assert.notEqual(r.w.model, null, 'kept')
  const draws = r.sky.clouds.draws.length
  r.w.update(AC, 16)
  assert.equal(r.sky.clouds.draws.length, draws, 'hidden: nothing built or drawn')
  r.w.show = true
  r.w.update(AC, 32)
  r.w.update(AC, 48)
  assert.ok(r.sky.clouds.draws.length > draws && r.sky.clouds.draws.at(-1)!.length > 100, 'shown: built from what it holds')
})

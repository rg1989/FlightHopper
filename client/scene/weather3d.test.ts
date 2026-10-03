// client/scene/weather3d.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cartesian3, Cartographic, Color, JulianDate, Math as CesiumMath } from 'cesium'
import type { ColorMaterialProperty, CustomDataSource, Entity, Viewer } from 'cesium'
import { distanceNm } from '../../shared/geo.ts'
import type { Metar, Sigmet } from '../../shared/wx.ts'
import { DEFAULT_UNITS, type Units } from '../ui/units.ts'
import type { LayerLabel } from './placeLabels.ts'
import { RadarSource } from './radar.ts'
import { HAZARD_KM, Weather3D, hazardsNear, parseWxAt, ringCentre, ringDistanceKm, statusText3d } from './weather3d.ts'
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

test('ringDistanceKm: 0 inside a ring, else the distance to its nearest edge or corner', () => {
  const r = box(0, 0, 1, 1)
  assert.equal(ringDistanceKm(r, 0.5, 0.5), 0)
  assert.ok(near(ringDistanceKm(r, 0.5, 2), KM_PER_DEG, 0.5), 'a degree east of the east edge')
  assert.ok(near(ringDistanceKm(r, 3, 0.5), 2 * KM_PER_DEG, 1), 'two degrees north of the north edge (the edge bulges north by metres)')
  assert.ok(near(ringDistanceKm(r, -1, 0.5), KM_PER_DEG, 0.5), 'a degree south of the south edge')
  const corner = ringDistanceKm(r, 2, 2) // past the north-east corner: the corner is nearest
  assert.ok(near(corner, distanceNm(2, 2, 1, 1) * 1.852, 1), String(corner))
  assert.ok(near(ringDistanceKm(r, 2, 1), KM_PER_DEG, 0.5), 'straight north of the corner: a degree')
})

test('ringDistanceKm: an edge is a great circle, as Cesium draws it: a long one along 60° N bulges to 73.9° N at its middle', () => {
  const r: Ring = [[-60, 60], [60, 60], [60, 50], [-60, 50], [-60, 60]]
  const bulge = (Math.atan(Math.tan((60 * Math.PI) / 180) / Math.cos((60 * Math.PI) / 180)) * 180) / Math.PI // 73.898°
  const d = ringDistanceKm(r, 73, 0)
  assert.ok(near(d, (bulge - 73) * KM_PER_DEG, 2), `${d} km, where the parallel is ${13 * KM_PER_DEG | 0} km off`)
})

test('ringDistanceKm: a ring across the antimeridian is the one ring it is', () => {
  const r: Ring = [[179, -1], [-179, -1], [-179, 1], [179, 1], [179, -1]]
  assert.equal(ringDistanceKm(r, 0, 180), 0)
  assert.equal(ringDistanceKm(r, 0, -179.5), 0)
  assert.ok(near(ringDistanceKm(r, 0, -177), 2 * KM_PER_DEG, 1), 'two degrees east of its east edge')
  assert.ok(near(ringDistanceKm(r, 0, 177), 2 * KM_PER_DEG, 1), 'and two west of its west one')
})

test('ringCentre: the middle of a ring\'s corners, the closing corner counted once, across the antimeridian too', () => {
  const c = ringCentre(box(30, 34, 34, 36))
  assert.ok(near(c.lat, 32, 0.05) && near(c.lon, 35, 0.01), JSON.stringify(c))
  const across = ringCentre([[179, -1], [-179, -1], [-179, 1], [179, 1], [179, -1]])
  assert.ok(near(across.lat, 0, 1e-9) && near(Math.abs(across.lon), 180, 1e-9), JSON.stringify(across))
  const l = ringCentre([[0, 0], [4, 0], [0, 4], [0, 0]]) // three corners and the first again: the mean of the three
  assert.ok(near(l.lon, 4 / 3, 0.01) && near(l.lat, 4 / 3, 0.01), JSON.stringify(l))
})

const sigmet = (o: Partial<Sigmet> & { rings: Ring[] }): Sigmet => ({ hazard: 'TS', qualifier: 'EMBD', base: null, top: 35000, until: '2026-10-03T06:00:00Z', raw: '', ...o })
const AC = { lat: 32.1, lon: 34.9, altM: 10_000 }
/** A box whose south edge is km due north of the aircraft, 2° wide round its meridian, height° tall. */
const northOf = (km: number, height = 1): Ring => box(AC.lat + km / KM_PER_DEG, AC.lon - 1, AC.lat + km / KM_PER_DEG + height, AC.lon + 1)

test('hazardsNear: a SIGMET with a top whose ring passes within 800 km; the aircraft inside a ring counts', () => {
  assert.equal(HAZARD_KM, 800)
  const list = [
    sigmet({ rings: [northOf(790)] }), // in
    sigmet({ rings: [northOf(810)] }), // out
    sigmet({ rings: [box(AC.lat - 1, AC.lon - 1, AC.lat + 1, AC.lon + 1)] }), // the aircraft is inside it
    sigmet({ rings: [northOf(100)], top: null }), // no top: no volume to draw
    sigmet({ rings: [northOf(100)], top: 0 }),
    sigmet({ rings: [northOf(100)], base: 20000, top: 20000 }), // a top at its base: no volume
    sigmet({ rings: [northOf(100)], base: 30000, top: 20000 }), // under it
  ]
  assert.deepEqual(hazardsNear(list, AC.lat, AC.lon).map((h) => h.sigmet), [list[0], list[2]])
  assert.deepEqual(hazardsNear(list, AC.lat, AC.lon, 850).map((h) => h.sigmet), [list[0], list[1], list[2]], 'the reach is an argument')
  assert.deepEqual(hazardsNear([], AC.lat, AC.lon), [])
})

test('hazardsNear: from the base (none: the ground, 0) to the top, in metres from the feet the SIGMET gives; the rings within reach, the nearest for the label', () => {
  const [far, mid, close, east] = [northOf(900), northOf(500), northOf(200), box(AC.lat - 1, AC.lon + 3, AC.lat + 1, AC.lon + 4)] // the last ~280 km east
  const [a, b] = hazardsNear([sigmet({ rings: [northOf(300)] }), sigmet({ base: 18000, top: 35000, rings: [far, mid, close, east] })], AC.lat, AC.lon)
  assert.deepEqual([a.baseM, a.topM], [0, 35000 * FT])
  assert.deepEqual([b.baseM, b.topM], [18000 * FT, 35000 * FT])
  assert.deepEqual(b.rings, [mid, close, east], 'the ring at 900 km is left out')
  assert.equal(b.nearest, close)
  assert.notEqual(a.key, b.key)
  const key = (rings: Ring[]): string => hazardsNear([sigmet({ rings })], AC.lat, AC.lon)[0].key
  assert.notEqual(key([northOf(900), northOf(500)]), key([northOf(500), northOf(900)]), 'which rings are drawn is part of the key')
})

// ---- Weather3D --------------------------------------------------------------------------------------------------------

const HOST = 'https://tilecache.rainviewer.com'
const INDEX = { host: HOST, radar: { past: [{ time: 1759420200, path: '/v2/radar/old' }, { time: 1759420800, path: '/v2/radar/new' }] } }
const metar = (id: string, lat: number, lon: number): Metar => ({
  id, name: id, lat, lon, elevM: 30, obsMs: null, cat: 'VFR', wdir: null, wspd: 0, wgst: null, visKm: null, visPlus: true, tempC: null, dewC: null,
  qnhHpa: null, wx: null, clouds: [], vertVisFt: null, raw: '',
})
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const MIN = 60_000

type Kind = 'metar' | 'sigmet' | 'radar'
interface LabelCall { key: string; rank: number; labels: LayerLabel[] }

/** A Weather3D over a fake viewer, names overlay and network: what was asked, answered from `answers` (or failed, or held until release()). */
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
    if (failing.has(kind)) throw new Error(`${kind} down`)
    if (hold.has(kind)) await new Promise<void>((resolve) => held.push(resolve))
    return answer
  }
  const sources: CustomDataSource[] = []
  const removed: [CustomDataSource, boolean | undefined][] = []
  const viewer = {
    dataSources: { add: async (ds: CustomDataSource) => void sources.push(ds), remove: async (ds: CustomDataSource, destroy?: boolean) => void removed.push([ds, destroy]) },
    isDestroyed: () => false,
  } as unknown as Viewer
  const labelCalls: LabelCall[] = []
  const labels = { setLayer: (key: string, rank: number, ls: readonly LayerLabel[]) => void labelCalls.push({ key, rank, labels: [...ls] }) }
  const lines: (string | null)[] = []
  let units: Units = DEFAULT_UNITS
  const w = new Weather3D(viewer, { apiBase: '/api', labels, getJson, onStatus: (t) => lines.push(t), units: () => units, at: o.at })
  return {
    w, asked, answers, failing, hold, sources, removed, labelCalls, lines,
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
  r.w.update({ ...AC, lat: AC.lat - 0.1 }, 10 * MIN + 1000) // a new list of SIGMETs, the same two: drawn again (their words may have changed)
  await flush()
  assert.equal(r.volumes().length, 1)
  assert.equal(r.labelCalls.length, calls + 2)
  assert.ok(!first.includes(r.volumes()[0]))
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

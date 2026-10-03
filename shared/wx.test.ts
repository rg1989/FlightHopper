// shared/wx.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODEL_CLOUD_HPA, MODEL_VARIABLES, MODEL_WIND_HPA, assembleModel, slimMetars, slimModel, slimPlaces, type ModelGeo, type ModelPlace } from './wx.ts'

const MI = 1.609344 // km in a statute mile
const near = (a: number | null, b: number): boolean => a !== null && Math.abs(a - b) < 1e-9

// Records as aviationweather.gov sends them (checked 2026-10-02): a key it has nothing for is left out, not null.
const LLHA = {
  icaoId: 'LLHA', name: 'Haifa Intl, HA, IL', obsTime: 1790956200, temp: 26, dewp: 16, wdir: 250, wspd: 5, wgst: null,
  visib: '6+', altim: 1014, wxString: null, clouds: [{ cover: 'FEW', base: 4500 }], fltCat: 'VFR', vertVis: null,
  rawOb: 'METAR LLHA 021550Z AUTO 25005KT 9999 FEW045 26/16 Q1014', lat: 32.81, lon: 35.04, elev: 3,
}

test('slimMetars: Haifa, every field', () => {
  const [m] = slimMetars([LLHA])
  const { visKm, ...rest } = m
  assert.ok(near(visKm, 6 * MI), String(visKm)) // 9.66 km: "6+" is 6 miles or more
  assert.deepEqual(rest, {
    id: 'LLHA', name: 'Haifa Intl, HA, IL', lat: 32.81, lon: 35.04, elevM: 3, obsMs: 1790956200000, cat: 'VFR', wdir: 250, wspd: 5, wgst: null,
    visPlus: true, tempC: 26, dewC: 16, qnhHpa: 1014, wx: null, clouds: [{ cover: 'FEW', baseFt: 4500, type: null }], vertVisFt: null,
    raw: 'METAR LLHA 021550Z AUTO 25005KT 9999 FEW045 26/16 Q1014',
  })
})

test('slimMetars: a variable wind, 1 1/2 miles, weather, and a thundercloud read from the raw report', () => {
  const [m] = slimMetars([{
    icaoId: 'KXYZ', name: 'Example Rgnl, TX, US', lat: 31.5, lon: -97.2, obsTime: 1790956200, temp: -3.4, dewp: -5, wdir: 'VRB', wspd: 3,
    visib: '1 1/2', altim: 1020.7, wxString: '-RA BR', fltCat: 'IFR', elev: 312,
    clouds: [{ cover: 'FEW', base: 3000 }, { cover: 'FEW', base: 3300 }, { cover: 'BKN', base: 8000 }],
    rawOb: 'METAR KXYZ 021550Z VRB03KT 1 1/2SM -RA BR FEW030 FEW033CB BKN080 M03/M05 A3014',
  }])
  const { visKm, ...rest } = m
  assert.ok(near(visKm, 1.5 * MI), String(visKm))
  assert.deepEqual(rest, {
    id: 'KXYZ', name: 'Example Rgnl, TX, US', lat: 31.5, lon: -97.2, elevM: 312, obsMs: 1790956200000, cat: 'IFR', wdir: null, wspd: 3, wgst: null,
    visPlus: false, tempC: -3.4, dewC: -5, qnhHpa: 1020.7, wx: '-RA BR',
    clouds: [{ cover: 'FEW', baseFt: 3000, type: null }, { cover: 'FEW', baseFt: 3300, type: 'CB' }, { cover: 'BKN', baseFt: 8000, type: null }],
    vertVisFt: null, raw: 'METAR KXYZ 021550Z VRB03KT 1 1/2SM -RA BR FEW030 FEW033CB BKN080 M03/M05 A3014',
  })
})

test('slimMetars: visibility in statute miles, as a number or a string; unreadable is null', () => {
  const cases: [unknown, number | null, boolean][] = [
    [4.35, 4.35 * MI, false], [10, 10 * MI, false], ['6+', 6 * MI, true], ['10+', 10 * MI, true], ['1/2', 0.5 * MI, false],
    ['1 1/2', 1.5 * MI, false], ['M1/4', 0.25 * MI, false], ['  2  ', 2 * MI, false],
    ['', null, false], ['abc', null, false], ['1/0', null, false], [null, null, false], [undefined, null, false], [{}, null, false],
  ]
  for (const [visib, km, plus] of cases) {
    const [m] = slimMetars([{ icaoId: 'X', lat: 1, lon: 2, visib }])
    if (km === null) assert.equal(m.visKm, null, JSON.stringify(visib))
    else assert.ok(near(m.visKm, km), `${JSON.stringify(visib)} → ${m.visKm}`)
    assert.equal(m.visPlus, plus, JSON.stringify(visib))
  }
})

test('slimMetars: thunderclouds and towering cumulus come from the report body, matched by cover and base; trend groups do not count', () => {
  const clouds = (rawOb: string, ...layers: [string, number][]) =>
    slimMetars([{ icaoId: 'X', lat: 1, lon: 2, rawOb, clouds: layers.map(([cover, base]) => ({ cover, base })) }])[0].clouds
  assert.deepEqual(clouds('METAR X 021700Z 25009KT 8000 FEW030 FEW033CB SCT040', ['FEW', 3000], ['FEW', 3300], ['SCT', 4000]).map((c) => c.type), [null, 'CB', null])
  assert.deepEqual(clouds('METAR X 021700Z 09005KT 9999 BKN020TCU', ['BKN', 2000]).map((c) => c.type), ['TCU'])
  assert.deepEqual(clouds('METAR X 021700Z 09005KT 9999 FEW030 BECMG FEW030CB RMK SCT040CB', ['FEW', 3000]).map((c) => c.type), [null])
  assert.deepEqual(clouds('METAR X 021700Z 09005KT 9999 FEW030CB BKN030', ['FEW', 3000], ['BKN', 3000]).map((c) => c.type), ['CB', null]) // same base, other cover
})

test('slimMetars: sky hidden: vertVis is in hundreds of feet, the cloud list says OVX; no cloud list is empty', () => {
  const [m] = slimMetars([{
    icaoId: 'ESOK', lat: 59.4, lon: 13.3, vertVis: 2, clouds: [{ cover: 'OVX', base: 200 }], fltCat: 'LIFR', // ESOK 021650Z … FG VV002 …
    rawOb: 'METAR ESOK 021650Z 22004KT 0650 R03/1700N R21/1400U FG VV002 14/14 Q1026',
  }])
  assert.equal(m.vertVisFt, 200)
  assert.deepEqual(m.clouds, [{ cover: 'OVX', baseFt: 200, type: null }])
  assert.deepEqual(slimMetars([{ icaoId: 'LFKJ', lat: 41.9, lon: 8.8, rawOb: 'METAR LFKJ 021700Z AUTO 07006KT 9999 ///TCU 23/18 Q1026' }])[0].clouds, [])
})

test('slimMetars: a bare record gets null, false and empty for everything it lacks; no position or a non-array gives nothing', () => {
  assert.deepEqual(slimMetars([{ icaoId: 'BARE', lat: 1, lon: 2 }]), [{
    id: 'BARE', name: null, lat: 1, lon: 2, elevM: null, obsMs: null, cat: null, wdir: null, wspd: 0, wgst: null, visKm: null, visPlus: false,
    tempC: null, dewC: null, qnhHpa: null, wx: null, clouds: [], vertVisFt: null, raw: '',
  }])
  assert.deepEqual(slimMetars([{ icaoId: 'X', lat: null, lon: 1 }, { lat: 1, lon: 2 }]), [])
  assert.deepEqual(slimMetars({}), [])
  assert.equal(slimMetars([{ icaoId: 'X', lat: 1, lon: 2, wxString: '  ' }])[0].wx, null) // nothing to say is no weather
})

test('slimMetars: elevM is the API\'s elev, the station\'s metres above sea level (below it too); missing or not a number is null', () => {
  const elev = (v: unknown): number | null => slimMetars([{ icaoId: 'X', lat: 1, lon: 2, elev: v }])[0].elevM
  assert.equal(elev(1656), 1656) // Denver
  assert.equal(elev(0), 0) // at sea level is not unknown
  assert.equal(elev(-12), -12)
  for (const bad of ['35', null, undefined, Number.NaN, {}]) assert.equal(elev(bad), null, String(bad))
  assert.equal(slimMetars([{ icaoId: 'X', lat: 1, lon: 2 }])[0].elevM, null)
})

// ---- slimModel --------------------------------------------------------------------------------------------------------------

// One place of Open-Meteo's multi-point answer as it came (api.open-meteo.com/v1/forecast, 2026-10-03 08:40 UTC, forecast_hours=1,
// wind_speed_unit=kn, timeformat=unixtime), without its hourly_units: the model's own nearest point (not the one asked for), its
// height, and arrays of one value each.
const REAL_PLACE = {
  latitude: 32.1875, longitude: 34.8125, generationtime_ms: 418.38550567626953, utc_offset_seconds: 0, timezone: 'GMT', timezone_abbreviation: 'GMT', elevation: 0,
  hourly: {
    time: [1791014400], cloud_cover_1000hPa: [0], cloud_cover_925hPa: [0], cloud_cover_850hPa: [0], cloud_cover_700hPa: [5], cloud_cover_600hPa: [0],
    cloud_cover_500hPa: [0], cloud_cover_400hPa: [0], cloud_cover_300hPa: [0], cloud_cover_250hPa: [0], cloud_cover_200hPa: [0],
    geopotential_height_1000hPa: [158], geopotential_height_925hPa: [834], geopotential_height_850hPa: [1554], geopotential_height_700hPa: [3153],
    geopotential_height_600hPa: [4386], geopotential_height_500hPa: [5802], geopotential_height_400hPa: [7458.03], geopotential_height_300hPa: [9496.77],
    geopotential_height_250hPa: [10731.43], geopotential_height_200hPa: [12172.09], wind_speed_850hPa: [17.1], wind_speed_700hPa: [16.4],
    wind_speed_500hPa: [42.4], wind_speed_300hPa: [83.4], wind_speed_250hPa: [82.5], wind_speed_200hPa: [92], wind_direction_850hPa: [213],
    wind_direction_700hPa: [231], wind_direction_500hPa: [236], wind_direction_300hPa: [237], wind_direction_250hPa: [236], wind_direction_200hPa: [233],
  },
}

const GEO: ModelGeo = { lat0: 31.5, lon0: 34, step: 0.25, n: 7 }

/** A 7 × 7 answer whose values say where they belong: place k, level l. `over` replaces some of one place's arrays. */
function answer(over: Record<number, Record<string, unknown>> = {}, n = 49): unknown[] {
  return Array.from({ length: n }, (_, k) => {
    const hourly: Record<string, unknown> = { time: [1791014400] }
    MODEL_CLOUD_HPA.forEach((p, l) => {
      hourly[`cloud_cover_${p}hPa`] = [(k + l) % 101]
      hourly[`geopotential_height_${p}hPa`] = [100 * l + k + 0.4]
    })
    MODEL_WIND_HPA.forEach((p, l) => {
      hourly[`wind_speed_${p}hPa`] = [10 * l + k + 0.04]
      hourly[`wind_direction_${p}hPa`] = [(10 * l + k) % 360 + 0.4]
    })
    return { latitude: 0, longitude: 0, elevation: 10 + k + 0.4, hourly: { ...hourly, ...over[k] } }
  })
}

test('MODEL_VARIABLES: cloud cover and level height at ten levels, wind speed and direction at six, in the order they are asked', () => {
  assert.equal(MODEL_VARIABLES.length, 32)
  assert.deepEqual(MODEL_VARIABLES.slice(0, 3), ['cloud_cover_1000hPa', 'cloud_cover_925hPa', 'cloud_cover_850hPa'])
  assert.equal(MODEL_VARIABLES[10], 'geopotential_height_1000hPa')
  assert.equal(MODEL_VARIABLES[20], 'wind_speed_850hPa')
  assert.equal(MODEL_VARIABLES[26], 'wind_direction_850hPa')
  assert.equal(MODEL_VARIABLES.at(-1), 'wind_direction_200hPa')
  assert.deepEqual(MODEL_CLOUD_HPA, [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200])
  assert.deepEqual(MODEL_WIND_HPA, [850, 700, 500, 300, 250, 200])
})

test('slimModel: the real place of an Open-Meteo answer: every level by its own name, the ground and the hour', () => {
  const g = slimModel([REAL_PLACE], { lat0: 32.25, lon0: 34.75, step: 0.25, n: 1 })
  assert.deepEqual([g.lat0, g.lon0, g.step, g.n, g.timeMs], [32.25, 34.75, 0.25, 1, 1791014400_000], 'where it was asked for, not where the model answered from')
  assert.deepEqual(g.elevM, [0])
  assert.deepEqual(g.clouds.map((l) => l.hPa), MODEL_CLOUD_HPA)
  assert.deepEqual(g.clouds.map((l) => l.cover[0]), [0, 0, 0, 5, 0, 0, 0, 0, 0, 0])
  assert.deepEqual(g.clouds.map((l) => l.zM[0]), [158, 834, 1554, 3153, 4386, 5802, 7458, 9497, 10731, 12172], 'whole metres')
  assert.deepEqual(g.winds.map((l) => l.hPa), MODEL_WIND_HPA)
  assert.deepEqual(g.winds.map((l) => l.kt[0]), [17.1, 16.4, 42.4, 83.4, 82.5, 92])
  assert.deepEqual(g.winds.map((l) => l.deg[0]), [213, 231, 236, 237, 236, 233])
})

test('slimModel: 49 places in the order asked become arrays by level: index = row × 7 + column, rows north, columns east', () => {
  const g = slimModel(answer(), GEO)
  assert.equal(g.elevM.length, 49)
  assert.equal(g.clouds.length, 10)
  assert.equal(g.winds.length, 6)
  for (const l of g.clouds) assert.ok(l.cover.length === 49 && l.zM.length === 49)
  for (const l of g.winds) assert.ok(l.kt.length === 49 && l.deg.length === 49)
  assert.deepEqual(g.clouds[3].cover.slice(0, 3), [3, 4, 5], 'place k, level 3 (700 hPa)')
  assert.equal(g.clouds[3].cover[48], (48 + 3) % 101)
  assert.equal(g.clouds[2].zM[9], 209, 'level 2, place 9: 100 × 2 + 9 + 0.4, in whole metres')
  assert.equal(g.elevM[7], 17, '10 + 7 + 0.4')
  assert.equal(g.winds[1].kt[5], 15, '10 × 1 + 5 + 0.04, to 0.1 kt')
  assert.equal(g.winds[1].deg[5], 15)
  assert.deepEqual([g.lat0, g.lon0, g.step, g.n], [31.5, 34, 0.25, 7])
  assert.equal(g.timeMs, 1791014400_000)
})

test('slimModel: a value the model has none for is null, wherever it is; so is one that is not a number; the rest of the grid stays', () => {
  const g = slimModel(answer({
    2: { cloud_cover_700hPa: [null], geopotential_height_300hPa: [null], wind_speed_500hPa: [null] },
    5: { wind_direction_500hPa: ['north'], cloud_cover_850hPa: [Number.NaN] },
    8: { cloud_cover_925hPa: [], wind_speed_200hPa: undefined },
  }), GEO)
  assert.equal(g.clouds[3].cover[2], null)
  assert.equal(g.clouds[7].zM[2], null)
  assert.equal(g.winds[2].kt[2], null)
  assert.equal(g.winds[2].deg[5], null)
  assert.equal(g.clouds[2].cover[5], null)
  assert.equal(g.clouds[1].cover[8], null, 'an empty array')
  assert.equal(g.winds[5].kt[8], null, 'a key left out')
  assert.equal(g.clouds[3].cover[1], 4, 'a neighbour is as it was')
  assert.equal(g.clouds[3].cover[3], 6)
  const bare = slimModel(answer({ 0: { time: [] }, 1: { time: [null] }, 2: { time: [1791010800] } }), GEO)
  assert.equal(bare.timeMs, 1791010800_000, 'the hour is the oldest place\'s: a place without one counts for nothing')
  const none = slimModel(answer().map(() => ({ hourly: {} })), GEO)
  assert.equal(none.timeMs, null)
  assert.ok(none.elevM.every((v) => v === null) && none.clouds.every((l) => l.cover.every((v) => v === null)) && none.winds.every((l) => l.kt.every((v) => v === null)))
})

test('slimModel: whole percent, metres and degrees; the wind to 0.1 kt, its direction never 360; a place with no height is null', () => {
  const places = answer({
    0: { cloud_cover_1000hPa: [49.6], geopotential_height_1000hPa: [-120.6], wind_speed_850hPa: [17.26], wind_direction_850hPa: [212.5], wind_direction_700hPa: [359.6] },
  })
  delete (places[1] as { elevation?: number }).elevation
  const g = slimModel(places, GEO)
  assert.equal(g.clouds[0].cover[0], 50)
  assert.equal(g.clouds[0].zM[0], -121, 'below sea level in a deep low')
  assert.equal(g.winds[0].kt[0], 17.3)
  assert.equal(g.winds[0].deg[0], 213)
  assert.equal(g.winds[1].deg[0], 0, 'north')
  assert.equal(g.elevM[1], null)
})

test('slimModel: anything but one object a place is an error: the server serves the last good answer, or says it failed', () => {
  for (const bad of [null, {}, 'x', [], answer({}, 48), answer({}, 50), { error: true, reason: 'Latitude must be in range of -90 to 90°.' }]) {
    assert.throws(() => slimModel(bad, GEO), /expected an object for each of 49 places/, JSON.stringify(bad)?.slice(0, 40))
  }
  assert.throws(() => slimModel(answer().map((p, k) => (k === 3 ? null : p)), GEO), /expected an object for each of 49 places/, 'a place that is not an object')
  assert.throws(() => slimModel(answer().map((p, k) => (k === 3 ? 'x' : p)), GEO), /expected an object/)
})

test('slimPlaces: one ModelPlace for each place asked, by level; many places come as an array, one place as the object itself (or an array of one)', () => {
  const [one] = slimPlaces(REAL_PLACE, 1)
  assert.deepEqual(one, {
    timeMs: 1791014400_000, elevM: 0, cover: [0, 0, 0, 5, 0, 0, 0, 0, 0, 0], zM: [158, 834, 1554, 3153, 4386, 5802, 7458, 9497, 10731, 12172],
    kt: [17.1, 16.4, 42.4, 83.4, 82.5, 92], deg: [213, 231, 236, 237, 236, 233],
  })
  assert.deepEqual(slimPlaces([REAL_PLACE], 1), [one])
  const many = slimPlaces(answer({}, 3), 3)
  assert.equal(many.length, 3)
  assert.deepEqual(many.map((p) => p.cover[0]), [0, 1, 2], 'in the order asked: place k, level 0')
  assert.equal(many[2].zM[3], 302, 'whole metres: 100 × 3 + 2 + 0.4')
  assert.equal(many[1].elevM, 11, '10 + 1 + 0.4')
  assert.deepEqual(many[0].kt, [0.04, 10.04, 20.04, 30.04, 40.04, 50.04].map((v) => Math.round(v * 10) / 10))
  const gaps = slimPlaces([{ hourly: { time: [1791014400], cloud_cover_925hPa: [null], wind_speed_850hPa: ['x'] }, elevation: 'high' }], 1)[0]
  assert.deepEqual([gaps.elevM, gaps.cover[1], gaps.kt[0], gaps.zM[0], gaps.timeMs], [null, null, null, null, 1791014400_000], 'a value that is not a number, or not there, is null')
})

test('slimPlaces: anything but an object with hourly for each place asked is an error: a place that failed is never kept as a place with no values', () => {
  const bad: [unknown, number][] = [
    [null, 1], [{}, 1], [[], 1], [[REAL_PLACE, REAL_PLACE], 1], [{ error: true, reason: 'Latitude must be in range of -90 to 90°.' }, 1], ['x', 1], [{ hourly: null }, 1],
    [answer({}, 48), 49], [answer({}, 50), 49], [REAL_PLACE, 2], [answer({}, 3).map((p, k) => (k === 1 ? { elevation: 3 } : p)), 3], [answer({}, 3).map((p, k) => (k === 1 ? null : p)), 3],
  ]
  for (const [json, count] of bad) assert.throws(() => slimPlaces(json, count), /expected an object for each of \d+ places/, JSON.stringify(json)?.slice(0, 50))
})

/** A place with this cover at level 0, this height at level 1, this wind at level 0, in this hour. */
const place = (cover: number | null, z: number | null, kt: number | null, timeMs: number | null): ModelPlace => ({
  timeMs, elevM: z, cover: MODEL_CLOUD_HPA.map((_, l) => (l === 0 ? cover : null)), zM: MODEL_CLOUD_HPA.map((_, l) => (l === 1 ? z : null)),
  kt: MODEL_WIND_HPA.map((_, l) => (l === 0 ? kt : null)), deg: MODEL_WIND_HPA.map(() => 270),
})

test('assembleModel: places row by row become the grid\'s arrays by level; its hour is the oldest place\'s; the places themselves are not touched', () => {
  const places = Array.from({ length: 49 }, (_, k) => place(k, 1000 + k, k / 10, 1791014400_000 + ((k + 3) % 5) * 600_000)) // the first is 30 min into the hour, the third is the oldest
  const copy = structuredClone(places)
  const g = assembleModel(GEO, places)
  assert.deepEqual([g.lat0, g.lon0, g.step, g.n], [31.5, 34, 0.25, 7])
  assert.equal(g.timeMs, 1791014400_000, 'the oldest')
  assert.deepEqual(g.elevM, places.map((p) => p.elevM))
  assert.deepEqual(g.clouds.map((l) => l.hPa), MODEL_CLOUD_HPA)
  assert.deepEqual(g.clouds[0].cover, Array.from({ length: 49 }, (_, k) => k))
  assert.equal(g.clouds[0].zM[5], null, 'level 0 has no height here')
  assert.deepEqual(g.clouds[1].zM, Array.from({ length: 49 }, (_, k) => 1000 + k))
  assert.deepEqual(g.winds[0].kt, Array.from({ length: 49 }, (_, k) => k / 10))
  assert.deepEqual(g.winds[3].deg, Array.from({ length: 49 }, () => 270))
  assert.deepEqual(places, copy)
  assert.equal(assembleModel(GEO, places.map((p) => ({ ...p, timeMs: null }))).timeMs, null, 'no place knows its hour')
  assert.throws(() => assembleModel(GEO, places.slice(1)), /expected 49 places, got 48/)
  assert.throws(() => assembleModel(GEO, [...places, places[0]]), /expected 49 places, got 50/)
})

test('slimModel is slimPlaces assembled: the same grid, place for place', () => {
  const json = answer({ 7: { cloud_cover_700hPa: [null] } })
  assert.deepEqual(slimModel(json, GEO), assembleModel(GEO, slimPlaces(json, 49)))
})

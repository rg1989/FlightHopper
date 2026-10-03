// client/scene/cloudField.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { distanceNm } from '../../shared/geo.ts'
import type { Cloud, Metar } from '../../shared/wx.ts'
import { CLOUD_KM, MAX_CLOUDS, STATION_CAP, metarClouds, nearestClouds, observedClouds, reportsSky, sunBrightness, type CloudSpec } from './cloudField.ts'

const FT = 0.3048
const DISC_AREA_KM2 = Math.PI * 25 ** 2
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol
const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): number => distanceNm(a.lat, a.lon, b.lat, b.lon) * 1.852
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)
const mean = (xs: number[]): number => sum(xs) / xs.length

const metar = (o: Partial<Metar> = {}): Metar => ({
  id: 'LLBG', name: null, lat: 32, lon: 34.9, elevM: 40, obsMs: null, cat: 'VFR', wdir: null, wspd: 0, wgst: null, visKm: 10,
  visPlus: true, tempC: null, dewC: null, qnhHpa: null, wx: null, clouds: [], vertVisFt: null, raw: '', ...o,
})
const layer = (cover: string, baseFt: number | null, type: 'CB' | 'TCU' | null = null): Cloud => ({ cover, baseFt, type })
const bottom = (c: CloudSpec): number => c.heightM - c.scale[1] / 2
const top = (c: CloudSpec): number => c.heightM + c.scale[1] / 2

/** A tower's puffs stand one over the next at one place: the clouds that share a place with another, by place. */
function towersOf(cs: CloudSpec[]): CloudSpec[][] {
  const by = new Map<string, CloudSpec[]>()
  for (const c of cs) by.set(`${c.lon},${c.lat}`, [...(by.get(`${c.lon},${c.lat}`) ?? []), c])
  return [...by.values()].filter((g) => g.length > 1).map((g) => g.toSorted((a, b) => a.heightM - b.heightM))
}

test('metarClouds: none where the report has no cloud layer (CAVOK, clear, none detected, no significant cloud), a hidden sky, a layer with no base, a station of unknown height', () => {
  for (const raw of ['METAR LLBG 031200Z 27010KT CAVOK 25/12 Q1015', 'METAR KJFK 031151Z 31008KT 10SM CLR 18/06 A3012',
    'METAR EGLL 031150Z AUTO 24012KT 9999 NCD 15/09 Q1021', 'METAR LFPG 031200Z 22008KT 9999 NSC 16/08 Q1020']) {
    assert.deepEqual(metarClouds(metar({ raw })), [], raw)
  }
  for (const cover of ['CLR', 'SKC', 'NCD', 'NSC', 'CAVOK']) assert.deepEqual(metarClouds(metar({ clouds: [layer(cover, null)] })), [], cover)
  assert.deepEqual(metarClouds(metar({ clouds: [layer('VV', 200)], vertVisFt: 200 })), [], 'VV: the sky hidden by fog is no cloud layer')
  assert.deepEqual(metarClouds(metar({ clouds: [layer('OVX', 200)] })), [])
  assert.deepEqual(metarClouds(metar({ clouds: [layer('BKN', null)] })), [], 'no base: no height to put it at')
  assert.deepEqual(metarClouds(metar({ elevM: null, clouds: [layer('BKN', 3000)] })), [], 'bases are feet above a station whose height is unknown')
})

test('metarClouds: about 0.02 clouds per km² for FEW and 0.06 for SCT, in a disc of 25 km round the station', () => {
  const st = metar()
  const few = metarClouds(metar({ clouds: [layer('FEW', 3000)] }))
  const sct = metarClouds(metar({ clouds: [layer('SCT', 3000)] }))
  assert.equal(few.length, Math.round(0.02 * DISC_AREA_KM2)) // 39
  assert.equal(sct.length, Math.round(0.06 * DISC_AREA_KM2)) // 118
  for (const c of [...few, ...sct]) assert.ok(km(c, st) <= 25.01, `${km(c, st)} km from the station`)
  assert.ok(few.some((c) => km(c, st) > 20) && few.some((c) => km(c, st) < 12), 'spread over the disc, not bunched')
  for (const c of few) assert.ok(c.scale[0] >= 1000 && c.scale[0] <= 3000 && c.scale[1] >= 400 && c.scale[1] <= 1200, `cumulus 1–3 km wide, 0.4–1.2 km tall: ${c.scale}`)
})

test('metarClouds: BKN and OVC are capped at 120 a station, each cloud made wider so the layer covers as much', () => {
  for (const [cover, density] of [['BKN', 0.14], ['OVC', 0.25]] as const) {
    const m = metar({ clouds: [layer(cover, 3000)] })
    const all = metarClouds(m, 0, Infinity)
    const capped = metarClouds(m)
    assert.equal(all.length, Math.round(density * DISC_AREA_KM2), `${cover} uncapped`)
    assert.equal(capped.length, STATION_CAP, cover)
    const cover0 = sum(all.map((c) => c.scale[0] ** 2))
    const cover1 = sum(capped.map((c) => c.scale[0] ** 2))
    assert.ok(near(cover1 / cover0, 1, 0.15), `${cover}: ${(cover1 / cover0).toFixed(3)} of the uncapped layer's footprint`)
    assert.deepEqual(capped.map((c) => [c.lon, c.lat]), all.slice(0, STATION_CAP).map((c) => [c.lon, c.lat]), 'the same places, fewer of them')
  }
})

test('metarClouds: BKN wider and flatter than cumulus, OVC flatter still', () => {
  const shape = (cover: string): { w: number; flat: number } => {
    const cs = metarClouds(metar({ clouds: [layer(cover, 3000)] }), 0, Infinity)
    return { w: mean(cs.map((c) => c.scale[0])), flat: mean(cs.map((c) => c.scale[1] / c.scale[0])) }
  }
  const [few, sct, bkn, ovc] = ['FEW', 'SCT', 'BKN', 'OVC'].map(shape)
  assert.ok(bkn.w > sct.w && bkn.w > few.w && ovc.w > bkn.w, `widths ${few.w}, ${sct.w}, ${bkn.w}, ${ovc.w}`)
  assert.ok(bkn.flat < sct.flat && bkn.flat < few.flat && ovc.flat < bkn.flat, `height/width ${few.flat}, ${sct.flat}, ${bkn.flat}, ${ovc.flat}`)
})

test('metarClouds: every cloud\'s base at the station\'s height plus the layer\'s base; the station\'s height is the ground it stands over', () => {
  const m = metar({ elevM: 412, clouds: [layer('FEW', 2500), layer('BKN', 8000)] })
  const cs = metarClouds(m)
  const low = cs.filter((c) => near(bottom(c), 412 + 2500 * FT, 1e-6))
  const high = cs.filter((c) => near(bottom(c), 412 + 8000 * FT, 1e-6))
  assert.equal(low.length + high.length, cs.length, 'every base on one of the two layers')
  assert.equal(cs.length, STATION_CAP, '39 + 275 wanted: capped')
  assert.equal(low.length, 15, 'each layer by its share: 39 × 120/314 = 14.9')
  assert.equal(high.length, 105)
  for (const c of cs) assert.equal(c.groundM, 412)
})

test('metarClouds: a layer under a broken or overcast one is in its shade: less bright', () => {
  const cs = metarClouds(metar({ clouds: [layer('FEW', 2000), layer('OVC', 9000)] }))
  const low = cs.filter((c) => near(bottom(c), 40 + 2000 * FT, 1e-6))
  const alone = metarClouds(metar({ clouds: [layer('FEW', 2000)] }))
  assert.ok(low.length > 0)
  for (const c of low) assert.ok(c.brightness < alone[0].brightness, `${c.brightness} under an overcast, ${alone[0].brightness} alone`)
})

test('metarClouds: CB adds 2 to 4 towers 4 to 9 km tall from the base, darkest at the bottom; TCU 3 to 6 towers 2 to 4 km', () => {
  const counts = { CB: new Set<number>(), TCU: new Set<number>() }
  for (let i = 0; i < 40; i++) {
    for (const [type, lo, hi, nLo, nHi] of [['CB', 4000, 9000, 2, 4], ['TCU', 2000, 4000, 3, 6]] as const) {
      const m = metar({ id: `K${i}`, elevM: 100, clouds: [layer('FEW', 3000, type)] })
      const cs = metarClouds(m)
      const towers = towersOf(cs)
      assert.ok(towers.length >= nLo && towers.length <= nHi, `${type}: ${towers.length} towers`)
      counts[type].add(towers.length)
      assert.equal(cs.length - sum(towers.map((t) => t.length)), 39, 'and the cover\'s own clouds, as for FEW')
      for (const t of towers) {
        const base = bottom(t[0])
        const height = Math.max(...t.map(top)) - base
        assert.ok(near(base, 100 + 3000 * FT, 1e-6), `${type} tower base ${base}`)
        assert.ok(height >= lo - 1e-6 && height <= hi + 1e-6, `${type} tower ${height} m tall`)
        assert.ok(t[0].tint > t.at(-1)!.tint, 'darker at the bottom than the top')
        if (type === 'CB') assert.ok(t[0].tint >= 0.5, `a thundercloud's dark base: ${t[0].tint}`)
        for (let j = 1; j < t.length; j++) assert.ok(t[j].tint <= t[j - 1].tint, 'no lighter puff under a darker one')
      }
    }
  }
  assert.deepEqual([...counts.CB].sort(), [2, 3, 4], 'every count of towers comes up')
  assert.deepEqual([...counts.TCU].sort(), [3, 4, 5, 6])
})

test('metarClouds: at most 120 clouds a station, its towers all kept', () => {
  const cs = metarClouds(metar({ clouds: [layer('BKN', 3000, 'CB'), layer('OVC', 8000)] }))
  assert.equal(cs.length, STATION_CAP)
  const towers = towersOf(cs)
  assert.ok(towers.length >= 2)
  for (const t of towers) assert.ok(Math.max(...t.map(top)) - bottom(t[0]) >= 4000)
})

test('metarClouds: the same report draws the same sky; another station another; a new layer leaves the others where they were; the seed reshuffles', () => {
  const m = metar({ clouds: [layer('FEW', 3000), layer('SCT', 6000, 'TCU')] })
  assert.deepEqual(metarClouds(m), metarClouds(structuredClone(m)))
  const other = metarClouds({ ...m, id: 'LLHA' })
  assert.notDeepEqual(other.map((c) => c.lon), metarClouds(m).map((c) => c.lon))
  const few = metarClouds(metar({ clouds: [layer('FEW', 3000)] }))
  const withMore = metarClouds(metar({ clouds: [layer('FEW', 3000), layer('FEW', 9000)] }))
  assert.deepEqual(withMore.filter((c) => near(bottom(c), 40 + 3000 * FT, 1e-6)), few, 'the FEW030 clouds as they were')
  const high = new Set(withMore.filter((c) => near(bottom(c), 40 + 9000 * FT, 1e-6)).map((c) => `${c.lon},${c.lat}`))
  assert.ok(few.every((c) => !high.has(`${c.lon},${c.lat}`)), 'each layer its own places')
  assert.notDeepEqual(metarClouds(m, 1).map((c) => c.lon), metarClouds(m).map((c) => c.lon))
})

test('reportsSky: layers, a hidden sky or a clear-sky word say what the sky is; nothing said, nothing known', () => {
  assert.equal(reportsSky(metar({ clouds: [layer('FEW', 3000)] })), true)
  assert.equal(reportsSky(metar({ clouds: [layer('VV', 200)] })), true)
  for (const word of ['CAVOK', 'CLR', 'SKC', 'NSC', 'NCD']) assert.equal(reportsSky(metar({ raw: `METAR X 031200Z 27010KT ${word} 25/12 Q1015` })), true, word)
  assert.equal(reportsSky(metar({ raw: 'METAR X 031200Z AUTO 27010KT 9999 25/12 Q1015' })), false)
  assert.equal(reportsSky(metar()), false)
})

test('observedClouds: each station\'s clouds only where it is the nearest station that reports the sky', () => {
  const a = metar({ id: 'A', lat: 32, lon: 34.8, clouds: [layer('SCT', 3000)] })
  const b = metar({ id: 'B', lat: 32, lon: 35.0, clouds: [layer('SCT', 5000)] }) // 18.9 km east of A
  const { specs } = observedClouds([a, b], 32, 34.9)
  const fromA = specs.filter((c) => near(bottom(c), 40 + 3000 * FT, 1e-6))
  const fromB = specs.filter((c) => near(bottom(c), 40 + 5000 * FT, 1e-6))
  assert.equal(fromA.length + fromB.length, specs.length)
  for (const c of fromA) assert.ok(km(c, a) <= km(c, b), 'A\'s clouds on its side')
  for (const c of fromB) assert.ok(km(c, b) <= km(c, a), 'B\'s on its own')
  assert.ok(fromA.length < metarClouds(a).length && fromA.length > 0)
  const clear = metar({ id: 'C', lat: 32, lon: 35.0, raw: 'METAR C 031200Z 27010KT CAVOK 25/12 Q1015' })
  const besideClear = observedClouds([a, clear], 32, 34.9).specs
  assert.ok(besideClear.length < metarClouds(a).length, 'a clear-sky report keeps its side clear')
  for (const c of besideClear) assert.ok(km(c, a) <= km(c, clear))
  const silent = metar({ id: 'D', lat: 32, lon: 35.0 }) // no sky reported
  assert.equal(observedClouds([a, silent], 32, 34.9).specs.length, metarClouds(a).length, 'a station that says nothing of the sky claims none of it')
})

test('observedClouds: the stations whose disc reaches within reach of the aircraft, and how many of them report the sky', () => {
  const at = { lat: 32, lon: 34.9 }
  const east = (kmOff: number, o: Partial<Metar> = {}): Metar => metar({ lat: at.lat, lon: at.lon + kmOff / (111.195 * Math.cos((at.lat * Math.PI) / 180)), ...o })
  const inReach = east(170, { id: 'IN', clouds: [layer('FEW', 3000)] }) // its disc comes to 145 km
  const outOfReach = east(180, { id: 'OUT', clouds: [layer('FEW', 3000)] }) // to 155 km
  const silent = east(20, { id: 'SIL' })
  const clear = east(-30, { id: 'CLR', raw: 'METAR CLR 031200Z 27010KT CAVOK 25/12 Q1015' })
  const r = observedClouds([inReach, outOfReach, silent, clear], at.lat, at.lon)
  assert.equal(r.stations, 2, 'IN and CLR report the sky within reach; SIL says nothing of it, OUT is too far')
  assert.ok(r.specs.length > 0 && r.specs.every((c) => km(c, inReach) <= 25.01))
  assert.equal(observedClouds([], at.lat, at.lon).specs.length, 0)
})

test('observedClouds: stations nearest first, and none farther once nearer ones fill the cap: the nearest 700 are the full sky\'s', () => {
  const ms: Metar[] = []
  for (let i = 0; i < 100; i++) {
    ms.push(metar({ id: `S${i}`, lat: 48 + ((i * 37) % 100) / 25, lon: 8 + ((i * 61) % 100) / 25, clouds: [layer('BKN', 2000, 'CB'), layer('OVC', 8000)] }))
  }
  const capped = observedClouds(ms, 50, 10)
  const full = observedClouds(ms, 50, 10, Infinity)
  assert.equal(capped.stations, full.stations, 'every station within reach counted')
  assert.ok(capped.specs.length < full.specs.length / 2, `${capped.specs.length} of ${full.specs.length} worked out`)
  assert.deepEqual(nearestClouds([capped.specs], 50, 10), nearestClouds([full.specs], 50, 10))
  assert.equal(observedClouds(ms, 50, 10, 0).specs.length, 0)
})

test('nearestClouds: nothing beyond 150 km, the nearest first past 700, the groups in order (observed first)', () => {
  const at = { lat: 32, lon: 34.9 }
  const spec = (kmNorth: number, tag: number): CloudSpec => ({
    lon: at.lon, lat: at.lat + kmNorth / 111.195, heightM: 1000 + tag, groundM: 0, scale: [2000, 800], maxSize: [20, 12, 12], slice: 0.4, brightness: 1, tint: 0,
  })
  const far = spec(151, 0)
  const observed = Array.from({ length: 800 }, (_, i) => spec(149 - (i % 149), i))
  const later = [spec(1, 9000)]
  const out = nearestClouds([[far, ...observed], later], at.lat, at.lon)
  assert.equal(out.length, MAX_CLOUDS)
  assert.ok(!out.includes(far), `nothing beyond ${CLOUD_KM} km`)
  assert.ok(!out.includes(later[0]), 'a later group only when the earlier ones leave room')
  const kept = new Set(out)
  const dropped = observed.filter((c) => !kept.has(c))
  assert.ok(Math.max(...out.map((c) => km(c, at))) <= Math.min(...dropped.map((c) => km(c, at))) + 1e-9, 'the nearest kept')
  assert.deepEqual(nearestClouds([observed.slice(0, 10), later], at.lat, at.lon).length, 11, 'room: every group in')
  assert.deepEqual(nearestClouds([[far, later[0]]], at.lat, at.lon), [later[0]], 'room, and still nothing beyond 150 km')
  assert.deepEqual(nearestClouds([], at.lat, at.lon), [])
})

test('sunBrightness: full by day, about half at dusk, 0.15 at night', () => {
  assert.equal(sunBrightness(0), 1)
  assert.ok(near(sunBrightness(0.5), 0.575, 1e-9))
  assert.ok(near(sunBrightness(1), 0.15, 1e-9))
  assert.equal(sunBrightness(-1), 1)
  assert.ok(near(sunBrightness(2), 0.15, 1e-9))
  assert.equal(sunBrightness(Number.NaN), 1)
})

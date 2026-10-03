// client/scene/cloudField.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { distanceNm } from '../../shared/geo.ts'
import { MODEL_CLOUD_HPA, MODEL_WIND_HPA, type Cloud, type Metar, type ModelGrid } from '../../shared/wx.ts'
import {
  CLOUD_KM, LOOKS, MAX_CLOUDS, MODEL_LOOK, PUFF_FILL, PUFF_SEEN, RADAR_LOOK, REBUILD_KM, STATION_CAP, ceilingM, fadeAlpha, farKmOf, metarClouds, modelClouds, nearestClouds,
  observedClouds, overcastShade, radarBases, radarClouds, reportsSky, sunBrightness, towerRiseM, type CloudSpec, type RadarBase,
} from './cloudField.ts'
import { EDGE_ALPHA, edgeAlpha, staysInside } from './cloudQuad.ts'
import type { RadarCell } from './radarCells.ts'

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
/** Where a cloud's puff starts and ends: it fills PUFF_FILL of its billboard's height. */
const bottom = (c: CloudSpec): number => c.heightM - (PUFF_FILL * c.scale[1]) / 2
const top = (c: CloudSpec): number => c.heightM + (PUFF_FILL * c.scale[1]) / 2

/** Each tower's puffs (and anvil), lowest first. */
function towersOf(cs: CloudSpec[]): CloudSpec[][] {
  const by = new Map<number, CloudSpec[]>()
  for (const c of cs) if (c.tower !== undefined) by.set(c.tower, [...(by.get(c.tower) ?? []), c])
  return [...by.values()].map((g) => g.toSorted((a, b) => a.heightM - b.heightM))
}

/** Metres east and north of a place (on the plane round it). */
const offset = (c: { lat: number; lon: number }, o: { lat: number; lon: number }): [number, number] =>
  [(c.lon - o.lon) * 111_195 * Math.cos((o.lat * Math.PI) / 180), (c.lat - o.lat) * 111_195]

/**
 * A model of the share of the low sky (rays at elev degrees round the horizon) the clouds hide from a place on the ground
 * at the station: each puff a disc-like ellipse PUFF_FILL of its billboard, facing the eye. An estimate, for comparing looks.
 */
function lowSkyCover(cs: CloudSpec[], st: Metar, elevDeg: number): number {
  const e = (elevDeg * Math.PI) / 180
  const puffs = cs.map((c) => {
    const [x, y] = offset(c, st)
    return { d: Math.hypot(x, y), az: Math.atan2(x, y), z: c.heightM - st.elevM!, a: (PUFF_FILL * c.scale[0]) / 2, b: (PUFF_FILL * c.scale[1]) / 2 }
  })
  let hidden = 0
  const RAYS = 720
  for (let k = 0; k < RAYS; k++) {
    const az = (2 * Math.PI * k) / RAYS
    const hit = puffs.some((p) => {
      const da = az - p.az
      if (Math.cos(da) <= 0) return false
      const x = p.d * Math.sin(da)
      const y = p.d * Math.cos(da) * Math.tan(e) - p.z
      return (x / p.a) ** 2 + (y / p.b) ** 2 <= 1
    })
    if (hit) hidden++
  }
  return hidden / RAYS
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

test('metarClouds: BKN and OVC are capped at 120 a station, each cloud made larger so the layer covers as much, from above and from below', () => {
  for (const [cover, density] of [['BKN', 0.14], ['OVC', 0.25]] as const) {
    const m = metar({ clouds: [layer(cover, 3000)] })
    const all = metarClouds(m, 0, Infinity)
    const capped = metarClouds(m)
    assert.equal(all.length, Math.round(density * DISC_AREA_KM2), `${cover} uncapped`)
    assert.equal(capped.length, STATION_CAP, cover)
    const ratio = (f: (c: CloudSpec) => number): number => sum(capped.map(f)) / sum(all.map(f))
    assert.ok(near(ratio((c) => c.scale[0] ** 2), 1, 0.15), `${cover}: ${ratio((c) => c.scale[0] ** 2).toFixed(3)} of the uncapped footprint`)
    assert.ok(near(ratio((c) => c.scale[0] * c.scale[1]), 1, 0.15), `${cover}: ${ratio((c) => c.scale[0] * c.scale[1]).toFixed(3)} of the uncapped face`)
    assert.deepEqual(capped.map((c) => [c.lon, c.lat]), all.slice(0, STATION_CAP).map((c) => [c.lon, c.lat]), 'the same places, fewer of them')
  }
})

test('metarClouds: BKN and OVC puffs wider than cumulus and taller (lumpy tops), still wider than tall; greyer, each a little different', () => {
  const look = (cover: string) => {
    const cs = metarClouds(metar({ clouds: [layer(cover, 3000)] }), 0, Infinity)
    const b = cs.map((c) => c.brightness)
    const t = cs.map((c) => c.tint)
    return { w: mean(cs.map((c) => c.scale[0])), h: mean(cs.map((c) => c.scale[1])), flat: Math.max(...cs.map((c) => c.scale[1] / c.scale[0])), b: mean(b), bSpread: Math.max(...b) - Math.min(...b), tSpread: Math.max(...t) - Math.min(...t) }
  }
  const [few, bkn, ovc] = ['FEW', 'BKN', 'OVC'].map(look)
  assert.ok(bkn.w > few.w && ovc.w > bkn.w, `widths ${few.w}, ${bkn.w}, ${ovc.w}`)
  assert.ok(bkn.h > few.h && ovc.h > few.h, `heights ${few.h}, ${bkn.h}, ${ovc.h}`)
  assert.ok(bkn.flat < 1 && ovc.flat < 1, 'wider than tall')
  assert.ok(ovc.b < bkn.b && bkn.b < few.b, `brightness ${few.b}, ${bkn.b}, ${ovc.b}: a deck not blown out`)
  for (const l of [bkn, ovc]) assert.ok(l.bSpread >= 0.1 && l.tSpread >= 0.05, `puffs vary: brightness by ${l.bSpread}, grey by ${l.tSpread}`)
})

test('metarClouds: seen from the ground at the station (the low sky, 5 to 20° up, the chase camera\'s), FEW hides little, SCT under half, BKN clearly more than half, OVC nearly all', () => {
  const low = (cover: string): number => mean(['LLBG', 'KDOV', 'EDDN', 'LKPR'].flatMap((id) => {
    const st = metar({ id, clouds: [layer(cover, 2100)] })
    const cs = metarClouds(st)
    return [5, 10, 15, 20].map((e) => lowSkyCover(cs, st, e))
  }))
  const [few, sct, bkn, ovc] = ['FEW', 'SCT', 'BKN', 'OVC'].map(low)
  assert.ok(few < 0.2, `FEW ${few}`)
  assert.ok(sct > few && sct < 0.5, `SCT ${sct}`)
  assert.ok(bkn >= 0.65, `BKN ${bkn}`)
  assert.ok(ovc >= 0.88, `OVC ${ovc}`)
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
  assert.ok(Math.max(...low.map((c) => c.brightness)) < Math.min(...alone.map((c) => c.brightness)), 'every puff under an overcast darker than any alone')
})

test('metarClouds: CB adds 2 to 4 towers 4 to 9 km tall, TCU 3 to 6 towers 2 to 4 km: columns of puffs several km wide, dark at the base, white above', () => {
  const counts = { CB: new Set<number>(), TCU: new Set<number>() }
  for (let i = 0; i < 40; i++) {
    for (const [type, lo, hi, nLo, nHi, wide, baseTint] of [['CB', 4000, 9000, 2, 4, 3000, 0.5], ['TCU', 2000, 4000, 3, 6, 2000, 0.2]] as const) {
      const m = metar({ id: `K${i}`, elevM: 100, clouds: [layer('FEW', 3000, type)] })
      const cs = metarClouds(m)
      const towers = towersOf(cs)
      assert.ok(towers.length >= nLo && towers.length <= nHi, `${type}: ${towers.length} towers`)
      counts[type].add(towers.length)
      assert.equal(cs.length - sum(towers.map((t) => t.length)), 39, 'and the cover\'s own clouds, as for FEW')
      for (const t of towers) {
        const base = Math.min(...t.map(bottom))
        const height = Math.max(...t.map(top)) - base
        assert.ok(near(base, 100 + 3000 * FT, 1e-6), `${type} tower base ${base}`)
        assert.ok(height >= lo - 1e-6 && height <= hi + 1e-6, `${type} tower ${height} m tall`)
        const lowest = t.filter((c) => c.heightM === t[0].heightM)
        assert.ok(lowest.length >= 3, `${lowest.length} puffs side by side at its base`)
        const o = { lat: mean(lowest.map((c) => c.lat)), lon: mean(lowest.map((c) => c.lon)) }
        const span = Math.max(...lowest.flatMap((c) => lowest.map((d) => Math.hypot(...offset(c, o).map((v, k) => v - offset(d, o)[k]))))) + mean(lowest.map((c) => c.scale[0]))
        assert.ok(span >= wide, `${type}: the column ${span} m wide at its base`)
        assert.ok(lowest.every((c) => c.tint >= baseTint), `${type}: a dark base (${lowest.map((c) => c.tint)})`)
        const upper = t.filter((c) => c.heightM - base > height / 2)
        assert.ok(upper.length > 0 && upper.every((c) => c.tint <= 0.05 && c.brightness >= 0.95), `${type}: white above halfway`)
        for (let j = 1; j < t.length; j++) assert.ok(t[j].tint <= t[j - 1].tint + 1e-12, 'no lighter puff under a darker one')
        for (const c of t) assert.ok(c.slice >= 0.18 && c.slice <= 0.45, `dense puffs: slice ${c.slice} (0.18 to 0.26 as asked, raised where the edge needs it)`)
        if (type === 'CB') {
          const crown = t.filter((c) => c.heightM === t.at(-1)!.heightM)
          assert.ok(Math.max(...crown.map((c) => c.scale[0])) > Math.max(...lowest.map((c) => c.scale[0])) && crown.every((c) => c.scale[1] < c.scale[0] / 3), 'an anvil: wide flat puffs on top')
        }
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
  for (const t of towers) assert.ok(Math.max(...t.map(top)) - Math.min(...t.map(bottom)) >= 4000)
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
  const full = observedClouds(ms, 50, 10, { max: Infinity })
  assert.equal(capped.stations, full.stations, 'every station within reach counted')
  assert.ok(capped.specs.length < full.specs.length / 2, `${capped.specs.length} of ${full.specs.length} worked out`)
  assert.deepEqual(nearestClouds([capped.specs], 50, 10), nearestClouds([full.specs], 50, 10))
  assert.equal(observedClouds(ms, 50, 10, { max: 0 }).specs.length, 0)
})

test('observedClouds: a cache keeps each report\'s clouds (the same objects again); a new cache works them out again, as the looks say now', () => {
  const m = metar({ clouds: [layer('FEW', 3000)] })
  const cache = new WeakMap<Metar, CloudSpec[]>()
  const first = observedClouds([m], m.lat, m.lon, { cache }).specs
  assert.equal(observedClouds([m], m.lat, m.lon, { cache }).specs[0], first[0])
  const saved = LOOKS.FEW.w
  try {
    ;(LOOKS.FEW as { w: readonly [number, number] }).w = [5000, 5000]
    assert.equal(observedClouds([m], m.lat, m.lon, { cache }).specs[0].scale[0], first[0].scale[0], 'the cache keeps what it worked out')
    assert.ok(observedClouds([m], m.lat, m.lon, { cache: new WeakMap() }).specs.every((c) => c.scale[0] === 5000), 'a new one, the new look')
    assert.ok(observedClouds([m], m.lat, m.lon).specs.every((c) => c.scale[0] === 5000), 'none: always worked out')
  } finally {
    ;(LOOKS.FEW as { w: readonly [number, number] }).w = saved
  }
})

test('nearestClouds: nothing beyond 150 km, the nearest first past 700, the groups in order (observed first)', () => {
  const at = { lat: 32, lon: 34.9 }
  const spec = (kmNorth: number, tag: number, farKm = CLOUD_KM): CloudSpec => ({
    lon: at.lon, lat: at.lat + kmNorth / 111.195, heightM: 1000 + tag, groundM: 0, scale: [2000, 800], maxSize: [20, 12, 12], slice: 0.4, brightness: 1, tint: 0, farKm,
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
  const small = [spec(60, 1, 40), spec(75, 2, 40), spec(69, 3, 40)] // faded out by 40 km
  assert.deepEqual(nearestClouds([small], at.lat, at.lon).map((c) => c.heightM), [1001, 1003], `nor one more than ${REBUILD_KM} km past where it has faded out (it cannot fade in before the next build)`)
})

test('fadeAlpha and farKm: a cloud fades out where it looks small, over the last 30 % of that; small cumulus by 60–80 km, decks and towers to the cap', () => {
  const few = metarClouds(metar({ clouds: [layer('FEW', 3000)] }))
  const mid = few.filter((c) => near(c.scale[0], 2000, 300))
  assert.ok(mid.length > 0 && mid.every((c) => c.farKm >= 55 && c.farKm <= 85), `2 km cumulus out by ${mid.map((c) => c.farKm.toFixed(0))} km`)
  const deck = metarClouds(metar({ clouds: [layer('OVC', 3000)] }))
  assert.ok(deck.every((c) => c.farKm === CLOUD_KM), 'a deck to the cap')
  const towers = towersOf(metarClouds(metar({ clouds: [layer('FEW', 3000, 'CB')] })))
  for (const t of towers) assert.ok(new Set(t.map((c) => c.farKm)).size === 1 && t[0].farKm >= 120, `a tower fades as one, late: ${t[0].farKm}`)
  const c = { ...few[0], farKm: 100 }
  assert.equal(fadeAlpha(c, 0), 1)
  assert.equal(fadeAlpha(c, 70), 1)
  assert.ok(near(fadeAlpha(c, 85), 0.5, 1e-9))
  assert.equal(fadeAlpha(c, 100), 0)
  assert.equal(fadeAlpha(c, 150), 0)
})

test('sunBrightness: full by day, about half at dusk, 0.15 at night', () => {
  assert.equal(sunBrightness(0), 1)
  assert.ok(near(sunBrightness(0.5), 0.575, 1e-9))
  assert.ok(near(sunBrightness(1), 0.15, 1e-9))
  assert.equal(sunBrightness(-1), 1)
  assert.ok(near(sunBrightness(2), 0.15, 1e-9))
  assert.equal(sunBrightness(Number.NaN), 1)
})

test('overcastShade: the thickest broken or overcast layer above the camera greys the sky; none above it, none for few or scattered', () => {
  const cl = (cover: string, baseFt: number): Cloud => ({ cover, baseFt, type: null })
  const m = metar({ elevM: 40, clouds: [cl('SCT', 1500), cl('BKN', 3000), cl('OVC', 6000)] })
  assert.equal(overcastShade(m, 100), 0.85) // under all three: the overcast's
  assert.equal(overcastShade(m, 40 + 4000 * FT), 0.85) // between the broken and the overcast: the overcast above
  assert.equal(overcastShade(m, 40 + 7000 * FT), 0) // above every layer
  assert.equal(overcastShade(metar({ clouds: [cl('BKN', 2000)] }), 100), 0.55)
  assert.equal(overcastShade(metar({ clouds: [cl('FEW', 2000), cl('SCT', 3000)] }), 100), 0)
  assert.equal(overcastShade(metar({ clouds: [], vertVisFt: 200 }), 50), 0.95) // a hidden sky: fog overhead
  assert.equal(overcastShade(metar({ elevM: null, clouds: [cl('OVC', 1000)] }), 0), 0) // unknown height: nothing to compare
  assert.equal(overcastShade(null, 0), 0)
})


// ---- the radar's clouds ----------------------------------------------------------------------------------------------------

const KM_PER_DEG = 111.195
const KM_PER_LON = KM_PER_DEG * Math.cos((32 * Math.PI) / 180) // at the aircraft's 32°N
/** A radar cell east and north km of the aircraft (32°N, 34.9°E), as radarCells gives them. */
function cell(east: number, north: number, dbz: number, o: Partial<RadarCell> = {}): RadarCell {
  return {
    lat: 32 + north / KM_PER_DEG, lon: 34.9 + east / KM_PER_LON, east, north, fromKm: Math.hypot(east, north), dbz, snow: false,
    seed: Math.round((east + 500) * 1000 + north + 500) + dbz, ...o,
  }
}
const base1500 = (): RadarBase => ({ baseM: 1500, groundM: 300 })
/** n cells 30 km apart on a line, each its own tower or deck puff: none thinned. */
const spaced = (dbz: number, n: number, o: Partial<RadarCell> = {}): RadarCell[] => Array.from({ length: n }, (_, i) => cell(30 * i - 45, 0, dbz, { seed: 100 + i, ...o }))
const decksOf = (cs: CloudSpec[]): CloudSpec[] => cs.filter((c) => c.tower === undefined)
/** A tower's height from its base to its top. */
const heightOf = (t: CloudSpec[]): number => Math.max(...t.map(top)) - Math.min(...t.map(bottom))
/** A tower's column width: its lowest puffs are 0.75 of it. */
const columnOf = (t: CloudSpec[]): number => Math.max(...t.filter((c) => c.heightM === t[0].heightM).map((c) => c.scale[0])) / 0.75
/** Where a tower stands: its top puff, when it has no anvil, is on its axis. */
const axisOf = (t: CloudSpec[]): string => `${t.at(-1)!.lat.toFixed(6)},${t.at(-1)!.lon.toFixed(6)}`
const placeOf = (c: RadarCell): string => `${c.lat.toFixed(6)},${c.lon.toFixed(6)}`

test('RADAR_LOOK: the values the plan gives, each named', () => {
  assert.equal(RADAR_LOOK.radiusKm, 100)
  assert.equal(RADAR_LOOK.stationKm, 60)
  assert.equal(RADAR_LOOK.defaultBaseM, 1200)
  assert.deepEqual([RADAR_LOOK.deckDbz, RADAR_LOOK.rainDbz, RADAR_LOOK.shaft.dbz], [15, 30, 35])
  assert.deepEqual(RADAR_LOOK.tops, [[30, 3000], [45, 7000], [55, 10000]])
  assert.deepEqual(RADAR_LOOK.width, [3000, 6000])
  assert.equal(RADAR_LOOK.shaft.max, 40)
  assert.deepEqual(RADAR_LOOK.shaft.width, [2000, 4000])
  const S = RADAR_LOOK.shaft
  assert.ok(S.variants >= 3 && Number.isInteger(S.variants), 'a few images of rain, so shafts side by side differ')
  assert.ok(S.widthJitter > 0 && S.widthJitter < 0.5 && S.alphaJitter > 0 && S.alphaJitter < 0.5, 'a little variation per shaft')
  assert.ok(S.overlapM >= 200, 'a shaft reaches well up into its cloud: the cloud\'s drawn bottom is soft')
})

test('ceilingM: the base of the lowest broken or overcast layer, or of a hidden sky; few and scattered are no ceiling; none when the height is unknown', () => {
  assert.equal(ceilingM(metar({ elevM: 40, clouds: [layer('FEW', 1000), layer('SCT', 1500), layer('BKN', 3000), layer('OVC', 6000)] })), 40 + 3000 * FT)
  assert.equal(ceilingM(metar({ elevM: 40, clouds: [layer('OVC', 800), layer('BKN', 4000)] })), 40 + 800 * FT)
  assert.equal(ceilingM(metar({ elevM: 40, clouds: [layer('FEW', 1000), layer('SCT', 1500)] })), null)
  assert.equal(ceilingM(metar({ elevM: 40, clouds: [layer('VV', 200)], vertVisFt: 200 })), 40 + 200 * FT, 'a hidden sky')
  assert.equal(ceilingM(metar({ elevM: 40, clouds: [layer('OVX', 300)] })), 40 + 300 * FT)
  assert.equal(ceilingM(metar({ elevM: 40, clouds: [], vertVisFt: 300 })), 40 + 300 * FT)
  assert.equal(ceilingM(metar({ elevM: 40, clouds: [layer('BKN', null)] })), null, 'no base given')
  assert.equal(ceilingM(metar({ elevM: null, clouds: [layer('OVC', 800)] })), null, 'feet above a height not known')
  assert.equal(ceilingM(metar()), null)
})

test('radarBases: the nearest station\'s ceiling within 60 km; else 1,200 m above the ground, which is the nearest station\'s height if that is within 60 km, else sea level', () => {
  const at = (east: number, north: number, o: Partial<Metar>): Metar => metar({ lat: 32 + north / KM_PER_DEG, lon: 34.9 + east / KM_PER_LON, ...o })
  const clear = at(5, 0, { id: 'CLEAR', elevM: 20, clouds: [layer('FEW', 3000)] }) // nearest, but no ceiling
  const wet = at(30, 0, { id: 'WET', elevM: 200, clouds: [layer('SCT', 1000), layer('OVC', 800)] })
  const wetter = at(-40, 0, { id: 'WETTER', elevM: 90, clouds: [layer('BKN', 500)] })
  const far = at(0, 90, { id: 'FAR', elevM: 700, clouds: [layer('OVC', 400)] }) // 90 km north
  const bases = radarBases([clear, wet, wetter, far])
  const a = bases(32, 34.9) // 5 km from CLEAR, 30 from WET, 40 from WETTER, 90 from FAR
  assert.ok(near(a.baseM, 200 + 800 * FT, 1e-9) && a.groundM === 200, 'the nearest station that has a ceiling')
  const b = bases(32 - 20 / KM_PER_DEG, 34.9 - 50 / KM_PER_LON) // 22 km from WETTER, 82 from WET
  assert.ok(near(b.baseM, 90 + 500 * FT, 1e-9) && b.groundM === 90)
  const c = bases(32 + 155 / KM_PER_DEG, 34.9 + 70 / KM_PER_LON) // 95 km from FAR, farther from the others: no station within 60 km
  assert.deepEqual(c, { baseM: 1200, groundM: 0 }, 'a station too far to say what the ground is: sea level, not its height')
  const d = bases(32, 34.9 + 100 / KM_PER_LON) // 70 km from WET, 100 from the others
  assert.deepEqual(d, { baseM: 1200, groundM: 0 })
  assert.deepEqual(radarBases([clear])(32, 34.9 + 20 / KM_PER_LON), { baseM: 20 + 1200, groundM: 20 }, 'a station with no ceiling, but within 60 km: 1,200 m over its height')
  assert.deepEqual(radarBases([clear])(32, 34.9 + 70 / KM_PER_LON), { baseM: 1200, groundM: 0 }, 'beyond 60 km its height is not borrowed (the sea may lie between)')
  assert.deepEqual(radarBases([clear, far])(32 + 100 / KM_PER_DEG, 34.9 + 20 / KM_PER_LON), { baseM: 700 + 400 * FT, groundM: 700 }, 'a station with a ceiling 22 km off: its ceiling')
  assert.deepEqual(radarBases([])(32, 34.9), { baseM: 1200, groundM: 0 }, 'no station: over sea level')
  const noElev = at(1, 0, { id: 'NOELEV', elevM: null, clouds: [layer('OVC', 300)] })
  assert.deepEqual(radarBases([noElev])(32, 34.9), { baseM: 1200, groundM: 0 }, 'a station of unknown height tells nothing')
  assert.ok(near(radarBases([wet])(32, 34.9 + 89 / KM_PER_LON).baseM, 200 + 800 * FT, 1e-9), '59 km from it: in reach')
  assert.deepEqual(radarBases([wet])(32, 34.9 + 91 / KM_PER_LON), { baseM: 1200, groundM: 0 }, '61 km: out of reach, and too far to say what the ground is')
})

test('radarBases: distances are on the ground: east-west degrees are shorter at 60°N, and a station across the antimeridian is as near as it is', () => {
  const north = metar({ id: 'BERGEN', lat: 60, lon: 5, elevM: 50, clouds: [layer('OVC', 700)] })
  const at = (km: number): number => 5 + km / (KM_PER_DEG * Math.cos((60 * Math.PI) / 180))
  assert.ok(near(radarBases([north])(60, at(50)).baseM, 50 + 700 * FT, 1e-9), '50 km east of it: in reach (0.9° of longitude)')
  assert.deepEqual(radarBases([north])(60, at(70)), { baseM: 1200, groundM: 0 }, '70 km: not')
  const fiji = metar({ id: 'NFFN', lat: -17.7, lon: -179.9, elevM: 18, clouds: [layer('BKN', 1500)] })
  assert.ok(near(radarBases([fiji])(-17.7, 179.9).baseM, 18 + 1500 * FT, 1e-9), '0.2° across the antimeridian: 21 km')
})

test('radarClouds: a rain block of 30 dBZ and more is a tower; 15 to 30 a deck; snow only a deck; under 15 nothing', () => {
  assert.equal(towersOf(radarClouds([cell(0, 0, 29)], base1500)).length, 0)
  assert.equal(decksOf(radarClouds([cell(0, 0, 29)], base1500)).length, 1)
  const t = radarClouds([cell(0, 0, 30)], base1500)
  assert.equal(towersOf(t).length, 1)
  assert.equal(decksOf(t).length, 0, 'a tower has its own base: no deck under it')
  const s = radarClouds([cell(0, 0, 50, { snow: true })], base1500)
  assert.equal(towersOf(s).length, 0, 'snow falls from layers, not towers')
  assert.equal(decksOf(s).length, 1)
  assert.deepEqual(radarClouds([cell(0, 0, 14)], base1500), [])
  assert.deepEqual(radarClouds([], base1500), [])
})

test('radarClouds: a tower stands on the base the callback gives for its place, over the ground it gives; a deck lies at it', () => {
  const asked: [number, number][] = []
  const base = (lat: number, lon: number): RadarBase => (asked.push([lat, lon]), { baseM: 1500, groundM: 300 })
  const cs = radarClouds([cell(0, 0, 40), cell(40, 0, 20)], base)
  assert.ok(asked.length >= 2 && asked.every(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon)))
  assert.ok(asked.some(([lat, lon]) => near(lat, 32, 1e-9) && near(lon, 34.9, 1e-9)), 'asked where the cell is')
  for (const t of towersOf(cs)) assert.ok(near(Math.min(...t.map(bottom)), 1500, 1e-6), 'the lowest puff\'s bottom on the base')
  const deck = decksOf(cs)
  assert.equal(deck.length, 1)
  assert.ok(near(bottom(deck[0]), 1500, 1e-6))
  for (const c of cs) assert.equal(c.groundM, 300)
  const here = radarClouds([cell(0, 0, 40), cell(40, 0, 40)], (_lat, lon) => (lon > 34.95 ? { baseM: 900, groundM: 100 } : { baseM: 2500, groundM: 50 }))
  const bases = towersOf(here).map((t) => Math.round(Math.min(...t.map(bottom))))
  assert.deepEqual(bases.sort((a, b) => a - b), [900, 2500], 'each tower its own place\'s base')
})

test('radarClouds: tops by intensity above the base: 30 dBZ about 3 km, 45 about 7, 55 and more 10; between them in proportion', () => {
  const topOf = (dbz: number): number => heightOf(towersOf(radarClouds([cell(0, 0, dbz)], base1500))[0])
  for (const [dbz, h] of [[30, 3000], [37.5, 5000], [45, 7000], [50, 8500], [55, 10000], [65, 10000], [75, 10000]] as const) assert.ok(near(topOf(dbz), h, 1e-6), `${dbz} dBZ: ${topOf(dbz)} m`)
})

test('radarClouds: a column 3 to 6 km wide, wider the heavier; its base dark grey, darker the heavier, white from halfway up; dense low puffs', () => {
  const widths = (dbz: number): number[] => towersOf(radarClouds(spaced(dbz, 7), base1500)).map(columnOf)
  for (const dbz of [30, 40, 55, 70]) assert.ok(widths(dbz).every((w) => w >= 3000 - 1e-6 && w <= 6000 + 1e-6), `${dbz} dBZ: ${widths(dbz).map(Math.round)}`)
  assert.ok(widths(30).every((w) => w <= 3500) && widths(55).every((w) => w >= 5500), 'wider the heavier')
  assert.ok(new Set(widths(40).map(Math.round)).size > 3, 'each a little different')
  const tint = (dbz: number): number => towersOf(radarClouds([cell(0, 0, dbz)], base1500))[0][0].tint
  assert.ok(near(tint(30), RADAR_LOOK.tint[0], 1e-9) && near(tint(55), RADAR_LOOK.tint[1], 1e-9) && near(tint(70), RADAR_LOOK.tint[1], 1e-9))
  assert.ok(RADAR_LOOK.tint[0] > 0.2 && RADAR_LOOK.tint[1] <= 1, 'a grey, never past black')
  assert.ok(tint(30) < tint(40) && tint(40) < tint(50) && tint(50) < tint(55), 'darker the heavier')
  for (const dbz of [30, 45, 60]) {
    const t = towersOf(radarClouds([cell(0, 0, dbz)], base1500))[0]
    const half = Math.min(...t.map(bottom)) + heightOf(t) / 2
    assert.ok(t.filter((c) => c.heightM > half).every((c) => c.tint <= 0.05), `${dbz}: white above halfway`)
    for (let j = 1; j < t.length; j++) assert.ok(t[j].tint <= t[j - 1].tint + 1e-12, 'no lighter puff under a darker one')
    assert.ok(t.every((c) => c.slice >= 0.18 && c.slice <= 0.45 && c.brightness >= 0.95), 'dense, bright puffs')
  }
})

test('radarClouds: a tower 6 km tall or more has an anvil: wide flat white puffs on top; a lower one has none', () => {
  const crownOf = (dbz: number): { t: CloudSpec[]; crown: CloudSpec[] } => {
    const t = towersOf(radarClouds([cell(0, 0, dbz)], base1500))[0]
    return { t, crown: t.filter((c) => c.heightM === t.at(-1)!.heightM) }
  }
  assert.ok(crownOf(35).crown.every((c) => c.scale[1] > c.scale[0] / 3), '35 dBZ (4.3 km): the column\'s own top puff')
  const { t, crown } = crownOf(55)
  assert.ok(crown.length >= 3 && crown.every((c) => c.scale[1] < c.scale[0] / 3 && c.tint === 0), `55 dBZ: ${crown.length} flat puffs`)
  assert.ok(2 * crown[0].scale[0] >= 2.5 * columnOf(t) - 1e-6, 'the anvil is at least 2.5 times as wide as the column')
  assert.ok(crownOf(41).crown.every((c) => c.scale[1] > c.scale[0] / 3), '41 dBZ (5.9 km): just short of one')
  assert.ok(crownOf(42).crown.every((c) => c.scale[1] < c.scale[0] / 3), '42 dBZ (6.2 km): one')
})

test('radarClouds: a deck is a flat grey puff at the base, darker the heavier the rain; snow too', () => {
  const decks = (dbz: number, o: Partial<RadarCell> = {}): CloudSpec[] => decksOf(radarClouds(spaced(dbz, 7, o), base1500))
  for (const c of [...decks(15), ...decks(29), ...decks(45, { snow: true })]) {
    assert.ok(near(bottom(c), 1500, 1e-6), 'its base at the base')
    assert.ok(c.scale[1] < c.scale[0] / 4, `flat: ${c.scale}`)
    assert.ok(c.tint >= 0.2 && c.brightness <= 0.8, `grey: ${c.tint}, ${c.brightness}`)
    assert.equal(c.groundM, 300)
    assert.equal(c.tower, undefined)
  }
  assert.equal(decks(20).length, 7)
  assert.ok(mean(decks(29).map((c) => c.tint)) > mean(decks(15).map((c) => c.tint)) + 0.05, 'darker the heavier')
})

test('radarClouds: a deck stands on the base and the ground of its own place', () => {
  const here = radarClouds([cell(0, 0, 20), cell(40, 0, 20)], (_lat, lon) => (lon > 34.95 ? { baseM: 900, groundM: 100 } : { baseM: 2500, groundM: 50 }))
  const decks = decksOf(here).map((c) => [Math.round(bottom(c)), c.groundM]).sort((a, b) => a[0] - b[0])
  assert.deepEqual(decks, [[900, 100], [2500, 50]])
})

test('radarClouds: the same cells draw the same clouds; a cell\'s clouds are its own: other cells far away leave them as they were', () => {
  const cells = [cell(0, 0, 45), cell(0, 40, 35), cell(0, -45, 20)]
  assert.deepEqual(radarClouds(cells, base1500), radarClouds(cells.map((c) => ({ ...c })), base1500))
  assert.deepEqual(radarClouds([...cells].reverse(), base1500).map((c) => c.lon).sort(), radarClouds(cells, base1500).map((c) => c.lon).sort(), 'in any order')
  const mine = (cs: CloudSpec[]): CloudSpec[] => cs.filter((c) => km(c, { lat: 32, lon: 34.9 }) < 12)
  const alone = mine(radarClouds([cell(0, 0, 45)], base1500))
  assert.ok(alone.length >= 6)
  assert.deepEqual(mine(radarClouds([...cells, cell(60, 60, 50), cell(-70, 20, 33)], base1500)), alone)
  assert.notDeepEqual(radarClouds([cell(0, 0, 45, { seed: 7 })], base1500), radarClouds([cell(0, 0, 45, { seed: 8 })], base1500), 'its seed makes it')
  const a = radarClouds([cell(0, 0, 45, { seed: 7 })], base1500)
  const b = radarClouds([cell(30, 0, 45, { seed: 7 })], base1500)
  assert.deepEqual(a.map((c) => c.scale), b.map((c) => c.scale), 'the same seed: the same look wherever it stands')
})

test('radarClouds: towers are numbered from 0 and fade out as one; the radar\'s clouds have faded out by the radius it is read to, so none pops at its edge', () => {
  const cs = radarClouds(spaced(50, 4), base1500)
  assert.deepEqual([...new Set(towersOf(cs).map((t) => t[0].tower))].sort(), [0, 1, 2, 3])
  for (const t of towersOf(cs)) assert.ok(new Set(t.map((c) => c.farKm)).size === 1 && t[0].farKm === 100, `a tower fades as one, by 100 km: ${t.map((c) => c.farKm)}`)
  for (const c of decksOf(radarClouds([cell(0, 0, 20)], base1500))) assert.equal(c.farKm, 100)
  const was = RADAR_LOOK.radiusKm
  try {
    RADAR_LOOK.radiusKm = 130
    assert.ok(radarClouds([cell(0, 0, 50), cell(40, 0, 20)], base1500).every((c) => c.farKm === 130), 'by the radius, whatever it is')
    RADAR_LOOK.radiusKm = 40
    assert.ok(radarClouds([cell(0, 0, 50), cell(40, 0, 20)], base1500).every((c) => c.farKm === 40))
  } finally {
    RADAR_LOOK.radiusKm = was
  }
  const ocean = decksOf(radarClouds([cell(0, 0, 20)], base1500))
  assert.ok(ocean.length === 1 && fadeAlpha(ocean[0], 69) === 1 && fadeAlpha(ocean[0], 100) === 0)
})

test('radarClouds: continuous heavy rain wants more towers than the sky has room for: they stand farther apart and each is wider (up to 4 ×), at most 40', () => {
  const dense = Array.from({ length: 400 }, (_, k) => cell(((k % 20) - 10) * 3, (Math.floor(k / 20) - 10) * 3, 40, { seed: k + 1 })) // 400 blocks 3 km apart
  const towers = towersOf(radarClouds(dense, base1500))
  assert.ok(towers.length <= RADAR_LOOK.towers && towers.length >= 10, `${towers.length} towers`)
  const w = towers.map(columnOf)
  assert.ok(Math.min(...w) > 6000 && Math.max(...w) < 15_000, `${Math.round(Math.min(...w))}–${Math.round(Math.max(...w))} m wide: grown, but no more than it takes (not the 24 km of 4 ×)`)
  assert.ok(Math.max(...towers.map((t) => km(t[0], { lat: 32, lon: 34.9 }))) > 25, 'spread over the region (60 km across), not the nearest 40 blocks round the aircraft')
  for (const t of towers) assert.ok(near(heightOf(t), 5666.67, 1), `${heightOf(t)} m: as tall as 40 dBZ says, not taller for being wider`)
  const few = towersOf(radarClouds(spaced(40, 6), base1500))
  assert.equal(few.length, 6, 'room: every one')
  assert.ok(few.map(columnOf).every((c) => c <= 6000 + 1e-6), 'as wide as the plan says')
})

test('radarClouds: an anvil is as wide as 2.5 to 3.5 columns, but no wider than 28 km, however wide the thinned columns are', () => {
  const dense = Array.from({ length: 400 }, (_, k) => cell(((k % 20) - 10) * 3, (Math.floor(k / 20) - 10) * 3, 55, { seed: k + 1 }))
  const tall = towersOf(radarClouds(dense, base1500))
  assert.ok(tall.length > 5 && tall.every((t) => columnOf(t) > 10_000), 'wide columns')
  for (const t of tall) {
    const crown = t.filter((c) => c.heightM === t.at(-1)!.heightM)
    assert.ok(crown.length === 3 && 2 * crown[0].scale[0] <= 28_000 + 1e-6, `${2 * crown[0].scale[0]} m wide`)
  }
})

test('radarClouds: more towers than 40 even at the widest spacing: the nearest 40', () => {
  const field = Array.from({ length: 100 }, (_, k) => cell(((k % 10) - 5) * 15 + 7, (Math.floor(k / 10) - 5) * 15 + 4, 40, { seed: k + 1 })) // 100 cells 15 km apart, all within 100 km, none as far as another
  const towers = towersOf(radarClouds(field, base1500))
  assert.equal(towers.length, 40)
  const want = field.toSorted((a, b) => a.fromKm - b.fromKm).slice(0, 40).map(placeOf).sort()
  assert.deepEqual(towers.map(axisOf).sort(), want, 'the 40 nearest')
})

test('radarClouds: cells past the radius the clouds fade out by (the ring a rebuild reads) are built too, hidden where they stand and fading in as the aircraft comes: none pops in at the next build', () => {
  const ring = radarClouds([cell(115, 0, 50), cell(0, 118, 20)], base1500)
  assert.equal(towersOf(ring).length, 1, 'a tower 115 km out')
  assert.equal(decksOf(ring).length, 1, 'a deck 118 km out')
  for (const c of ring) assert.ok(c.farKm === 100 && fadeAlpha(c, km(c, { lat: 32, lon: 34.9 })) === 0, `hidden where it stands: ${km(c, { lat: 32, lon: 34.9 })} km`)
  const [tower] = towersOf(ring)
  const closer = (c: CloudSpec): number => km(c, { lat: 32, lon: 34.9 + 28 / KM_PER_LON }) // the aircraft has flown 28 km east: no rebuild yet
  assert.ok(tower.every((c) => fadeAlpha(c, closer(c)) > 0.2), 'showing, part way through its fade')
  assert.ok(tower.some((c) => fadeAlpha(c, closer(c)) < 1), 'fading in, not there at once')
  assert.equal(nearestClouds([ring], 32, 34.9).length, ring.length, 'and the sky\'s cull keeps them (nothing beyond what has faded out + 30 km)')
  assert.deepEqual(radarClouds([cell(150, 0, 50)], base1500), radarClouds([cell(150, 0, 50)], base1500), 'any cell the caller gives is built: it reads no farther than it likes')
})

test('radarClouds: the ring takes no tower and no deck from those within the radius: they are the same with or without it, the ring\'s on top at the same size', () => {
  const dense = Array.from({ length: 400 }, (_, k) => cell(((k % 20) - 10) * 3, (Math.floor(k / 20) - 10) * 3, 40, { seed: k + 1 })) // 400 blocks 3 km apart: thinned
  const light = Array.from({ length: 900 }, (_, k) => cell(((k % 30) - 15) * 3, (Math.floor(k / 30) - 15) * 3, 20, { seed: 5000 + k })) // 900 light blocks: thinned
  const outer = [cell(104, 5, 52, { seed: 9001 }), cell(-110, -12, 44, { seed: 9002 }), cell(20, 121, 47, { seed: 9003 }), cell(-8, -126, 36, { seed: 9004 }), cell(70, 90, 18, { seed: 9005 }), cell(-100, 60, 25, { seed: 9006 })]
  assert.ok(outer.every((c) => c.fromKm > 100 && c.fromKm <= 130))
  const without = radarClouds([...dense, ...light], base1500)
  const withRing = radarClouds([...outer, ...dense, ...light], base1500)
  const inside = (cs: CloudSpec[]): CloudSpec[] => cs.filter((c) => km(c, { lat: 32, lon: 34.9 }) < 60)
  assert.deepEqual(inside(withRing), inside(without), 'what is drawn is as it was')
  assert.equal(towersOf(withRing).length, towersOf(without).length + 4, 'the four rain cells of the ring (30 dBZ and more) on top of the towers within')
  assert.equal(decksOf(withRing).length, decksOf(without).length + 2, 'the two light ones: decks')
  assert.ok(towersOf(without).length >= RADAR_LOOK.towers * 0.6 && towersOf(without).length <= RADAR_LOOK.towers, 'a full sky within, at most 40')
  const wide = (cs: CloudSpec[]): number[] => towersOf(cs).map(columnOf)
  assert.ok(Math.min(...wide(withRing)) > 6000, 'the ring\'s towers as wide as the thinned ones within')
})

test('radarClouds: with the places full within the radius (a small cap here) the ring still stands on top: its cells are not counted against the 40 towers or the 80 deck puffs', () => {
  const was = [RADAR_LOOK.towers, RADAR_LOOK.deck.max] as const
  try {
    ;(RADAR_LOOK as { towers: number }).towers = 6
    ;(RADAR_LOOK.deck as { max: number }).max = 4
    const field = (dbz: number, seed: number): RadarCell[] => Array.from({ length: 12 }, (_, i) => cell(((i % 4) - 1.5) * 40, (Math.floor(i / 4) - 1) * 40, dbz, { seed: seed + i })) // 12 cells 40 km apart, all within 100 km
    const ring = (dbz: number, seed: number): RadarCell[] => [cell(110, 20, dbz, { seed }), cell(-115, -30, dbz, { seed: seed + 1 }), cell(10, 125, dbz, { seed: seed + 2 })]
    const towers = (cs: RadarCell[]): number => towersOf(radarClouds(cs, base1500)).length
    const decks = (cs: RadarCell[]): number => decksOf(radarClouds(cs, base1500)).length
    assert.equal(towers(field(45, 100)), 6, 'full: the nearest 6')
    assert.equal(towers([...field(45, 100), ...ring(45, 900)]), 9, 'and three on top')
    assert.equal(decks(field(20, 300)), 4)
    assert.equal(decks([...field(20, 300), ...ring(20, 800)]), 7, 'four decks within, three in the ring')
  } finally {
    ;(RADAR_LOOK as { towers: number }).towers = was[0]
    ;(RADAR_LOOK.deck as { max: number }).max = was[1]
  }
})

test('towerRiseM: follows the levels of the tower (a narrow tower has more, each lower, so its lowest puff and its drawn bottom are lower)', () => {
  const was = RADAR_LOOK.width
  try {
    ;(RADAR_LOOK as { width: readonly [number, number] }).width = [1500, 2000]
    for (const dbz of [35, 45, 55]) {
      const lowest = towersOf(radarClouds([cell(0, 0, dbz, { seed: 4 })], base1500))[0][0]
      assert.ok(lowest.scale[1] < 2400, `${dbz} dBZ: narrow, so many levels (a lowest puff ${lowest.scale[1].toFixed(0)} m tall)`)
      assert.ok(near(towerRiseM(dbz), (lowest.scale[1] * (PUFF_FILL - PUFF_SEEN)) / 2, 0.15 * towerRiseM(dbz)), `${dbz} dBZ: ${towerRiseM(dbz)}`)
    }
    assert.ok(towerRiseM(55) < 450, 'less than for a wide tower')
  } finally {
    ;(RADAR_LOOK as { width: readonly [number, number] }).width = was
  }
})

test('towerRiseM: how far over its base the drawn bottom of a radar tower stands (a puff\'s lump is about 45 % of its billboard, the base is placed by 75 %): by its echo, as the render of the shader found', () => {
  assert.ok(PUFF_SEEN < PUFF_FILL && PUFF_SEEN > 0.3)
  assert.ok(near(towerRiseM(35), 455, 20) && near(towerRiseM(45), 735, 25) && near(towerRiseM(55), 1050, 30), `${towerRiseM(35)}, ${towerRiseM(45)}, ${towerRiseM(55)}`)
  for (let dbz = 30; dbz < 70; dbz += 2.5) assert.ok(towerRiseM(dbz + 2.5) >= towerRiseM(dbz), 'higher for a heavier echo')
  for (const dbz of [30, 35, 40, 45, 50, 55, 70]) {
    for (let seed = 1; seed <= 8; seed++) {
      const t = towersOf(radarClouds([cell(0, 0, dbz, { seed })], base1500))[0]
      const lowest = t[0] // lowest first
      const drawn = (lowest.scale[1] * (PUFF_FILL - PUFF_SEEN)) / 2
      assert.ok(Math.abs(drawn - towerRiseM(dbz)) <= 0.12 * drawn, `${dbz} dBZ seed ${seed}: the tower's drawn bottom is ${drawn.toFixed(0)} m up, the estimate ${towerRiseM(dbz).toFixed(0)}`)
    }
  }
})

test('radarClouds: a broad light-rain area is a few flat decks, wider and thicker the more there is of it, at most 80', () => {
  const area = (n: number): RadarCell[] => Array.from({ length: n * n }, (_, k) => cell(((k % n) - n / 2) * 3, (Math.floor(k / n) - n / 2) * 3, 20, { seed: k + 1 }))
  const small = decksOf(radarClouds(area(4), base1500))
  const broad = decksOf(radarClouds(area(30), base1500)) // 900 blocks: 90 × 90 km
  assert.ok(small.length >= 1 && small.length <= 4, `${small.length}`)
  assert.ok(broad.length <= RADAR_LOOK.deck.max && broad.length >= 20, `${broad.length} deck puffs`)
  assert.ok(mean(broad.map((c) => c.scale[0])) > 1.5 * mean(small.map((c) => c.scale[0])), 'wider so the few cover the area')
  assert.ok(mean(broad.map((c) => c.scale[1])) > 1.5 * mean(small.map((c) => c.scale[1])), 'and thicker: as seen from below')
  for (const c of broad) assert.ok(near(bottom(c), 1500, 1e-6) && c.scale[1] < c.scale[0] / 3)
})

test('radarClouds: the look constants are read as the clouds are made (the console can tune them: Weather3D.rebuildSky)', () => {
  const was = RADAR_LOOK.tops
  try {
    ;(RADAR_LOOK as { tops: readonly (readonly [number, number])[] }).tops = [[30, 1000], [45, 2000], [55, 3000]]
    assert.ok(near(heightOf(towersOf(radarClouds([cell(0, 0, 45)], base1500))[0]), 2000, 1e-6))
  } finally {
    ;(RADAR_LOOK as { tops: readonly (readonly [number, number])[] }).tops = was
  }
})

// ---- the model's clouds ------------------------------------------------------------------------------------------------------

const ISA_Z: Readonly<Record<number, number>> = { 1000: 110, 925: 760, 850: 1460, 700: 3010, 600: 4200, 500: 5570, 400: 7180, 300: 9160, 250: 10360, 200: 11800 } // m, standard atmosphere
const PLACES = 49
const MIDDLE = 24 // the middle place of a 7 × 7 grid: row 3, column 3
interface GridOptions {
  cover?: (hPa: number, place: number) => number | null
  z?: (hPa: number, place: number) => number | null
  elev?: (place: number) => number | null
  lat0?: number
  lon0?: number
}
/** A model grid, 7 × 7 places 0.25° apart from lat0, lon0 (31.5°N 34°E, so the middle place is at 32.25°N 34.75°E): its cover as `cover` has it (none by default), the levels at the standard atmosphere's heights, the ground at sea level. */
function modelGrid(o: GridOptions = {}): ModelGrid {
  const per = <T>(f: (p: number) => T): T[] => Array.from({ length: PLACES }, (_, p) => f(p))
  return {
    lat0: o.lat0 ?? 31.5, lon0: o.lon0 ?? 34, step: 0.25, n: 7, timeMs: 1791014400_000,
    elevM: per((p) => (o.elev === undefined ? 0 : o.elev(p))),
    clouds: MODEL_CLOUD_HPA.map((hPa) => ({
      hPa, cover: per((p) => (o.cover === undefined ? 0 : o.cover(hPa, p))), zM: per((p) => (o.z === undefined ? ISA_Z[hPa] : o.z(hPa, p))),
    })),
    winds: MODEL_WIND_HPA.map((hPa) => ({ hPa, kt: per(() => 10), deg: per(() => 270) })),
  }
}
/** A grid with cloud at one level of one place only. */
const one = (hPa: number, cover: number, place = MIDDLE, o: GridOptions = {}): ModelGrid => modelGrid({ cover: (h, p) => (h === hPa && p === place ? cover : 0), ...o })
const CELL_KM2 = (lat: number): number => (0.25 * 111.195) ** 2 * Math.cos((lat * Math.PI) / 180) // a place's cell, km²
const MID_LAT = 32.25
const MID_LON = 34.75

test('MODEL_LOOK: the values the plan gives, each named; the densities are modest, under the observed looks\'', () => {
  assert.deepEqual([MODEL_LOOK.minCover, MODEL_LOOK.stationKm, MODEL_LOOK.lowHPa, MODEL_LOOK.highHPa], [20, 40, 850, 300])
  for (const k of ['low', 'mid', 'high'] as const) assert.ok(MODEL_LOOK[k].density > 0 && MODEL_LOOK[k].density < 1, `${k}: ${MODEL_LOOK[k].density}`)
  assert.ok(MODEL_LOOK.sct < MODEL_LOOK.bkn && MODEL_LOOK.bkn < MODEL_LOOK.ovc && MODEL_LOOK.minCover < MODEL_LOOK.sct)
})

test('modelClouds: a level with 20 % cloud or more is drawn, less is not; a clear sky, no cover or no height draws nothing', () => {
  assert.equal(modelClouds(one(700, 19.9), []).length, 0)
  assert.ok(modelClouds(one(700, 20), []).length > 0)
  assert.equal(modelClouds(modelGrid(), []).length, 0, 'a clear sky')
  assert.equal(modelClouds(modelGrid({ cover: () => null }), []).length, 0, 'the model has none')
  assert.equal(modelClouds(one(700, 80, MIDDLE, { z: () => null }), []).length, 0, 'no height: nowhere to stand them')
  const short = modelGrid({ cover: () => 80 })
  short.clouds.forEach((l) => (l.cover.length = 10)) // a grid with places missing
  assert.ok(modelClouds(short, []).length > 0 && modelClouds(short, []).every((c) => c.lat < 32), 'only the places it has')
})

test('modelClouds: puffs by cover as for a report\'s FEW, SCT, BKN and OVC (the observed looks\' density, from 20, 25, 50 and 87.5 %), times the level\'s class: low, mid or high', () => {
  const cell = CELL_KM2(MID_LAT)
  for (const [hPa, density] of [[925, MODEL_LOOK.low.density], [600, MODEL_LOOK.mid.density], [250, MODEL_LOOK.high.density]] as const) {
    for (const [cover, name] of [[20, 'FEW'], [24.9, 'FEW'], [25, 'SCT'], [49.9, 'SCT'], [50, 'BKN'], [87.4, 'BKN'], [87.5, 'OVC'], [100, 'OVC']] as const) {
      assert.equal(modelClouds(one(hPa, cover), []).length, Math.round(LOOKS[name].perKm2 * density * cell), `${hPa} hPa, ${cover} %: ${name}`)
    }
  }
  const counts = [20, 30, 60, 90].map((c) => modelClouds(one(925, c), []).length)
  assert.ok(counts[0] < counts[1] && counts[1] < counts[2] && counts[2] < counts[3], `more cloud, more puffs: ${counts}`)
})

test('modelClouds: a place\'s cell is 0.25° square on the ground: a cell near the pole holds fewer puffs (by the cosine of its latitude)', () => {
  const equator = modelClouds(one(925, 100, MIDDLE, { lat0: -0.5 }), []).length // the place at 0.25°N
  const sixty = modelClouds(one(925, 100, MIDDLE, { lat0: 59.5 }), []).length // at 60.25°N
  assert.ok(near(sixty / equator, Math.cos((60.25 * Math.PI) / 180) / Math.cos((0.25 * Math.PI) / 180), 0.02), `${sixty} against ${equator}`)
})

test('modelClouds: a level\'s puffs stand from its height (their bottoms there), spread over the place\'s cell, on the model\'s ground', () => {
  const g = one(700, 80, MIDDLE, { elev: (p) => (p === MIDDLE ? 640 : 0), z: (hPa) => (hPa === 700 ? 3123 : ISA_Z[hPa]) })
  const cs = modelClouds(g, [])
  assert.ok(cs.length > 30)
  for (const c of cs) {
    assert.ok(near(bottom(c), 3123, 1e-6), `a bottom at ${bottom(c)}`)
    assert.equal(c.groundM, 640)
    assert.ok(Math.abs(c.lat - MID_LAT) <= 0.125 + 1e-9 && Math.abs(c.lon - MID_LON) <= 0.125 + 1e-9, `${c.lat}, ${c.lon}: outside the cell`)
  }
  const lats = cs.map((c) => c.lat)
  const lons = cs.map((c) => c.lon)
  assert.ok(Math.max(...lats) - Math.min(...lats) > 0.2 && Math.max(...lons) - Math.min(...lons) > 0.2, 'spread over the cell, not in a clump')
  assert.ok(Math.min(...lats) < MID_LAT && Math.max(...lats) > MID_LAT && Math.min(...lons) < MID_LON && Math.max(...lons) > MID_LON)
})

test('modelClouds: low levels (850 hPa and lower) look like the observed layers; mid levels are flat altocumulus, high levels thin, flat, pale cirrus', () => {
  const look = (hPa: number) => {
    const cs = modelClouds(one(hPa, 70), [])
    return { cs, w: cs.map((c) => c.scale[0]), h: cs.map((c) => c.scale[1]), flat: mean(cs.map((c) => c.scale[1] / c.scale[0])), b: mean(cs.map((c) => c.brightness)) }
  }
  const within = (xs: number[], [lo, hi]: readonly [number, number]): boolean => Math.min(...xs) >= lo && Math.max(...xs) <= hi
  for (const hPa of [1000, 925, 850]) {
    const l = look(hPa)
    assert.ok(within(l.w, LOOKS.BKN.w) && within(l.h, LOOKS.BKN.h), `${hPa} hPa: a broken layer's puffs`)
    assert.ok(l.cs.every((c) => c.slice >= LOOKS.BKN.slice[0] - 1e-12 && c.brightness >= LOOKS.BKN.brightness[0] && c.brightness <= LOOKS.BKN.brightness[1]))
  }
  const mid = MODEL_LOOK.mid.look!
  const high = MODEL_LOOK.high.look!
  for (const hPa of [700, 600, 500, 400]) {
    const l = look(hPa)
    assert.ok(within(l.w, mid.w) && within(l.h, mid.h), `${hPa} hPa: altocumulus`)
    assert.ok(l.flat < 0.2, `${hPa} hPa: flat, ${l.flat}`)
  }
  for (const hPa of [300, 250, 200]) {
    const l = look(hPa)
    assert.ok(within(l.w, high.w) && within(l.h, high.h), `${hPa} hPa: cirrus`)
    assert.ok(l.flat < 0.1, `${hPa} hPa: flatter still, ${l.flat}`)
    assert.ok(l.b < 1 && l.cs.every((c) => c.tint <= high.tint[1] + 1e-12), `${hPa} hPa: pale, not blazing white`)
  }
  assert.ok(look(925).flat > look(600).flat && look(600).flat > look(250).flat, 'flatter with height')
  assert.ok(look(250).h.every((h) => h < Math.min(...look(925).h)), 'thinner with height')
})

test('modelClouds: a level the model puts under the ground (less than 100 m over it) is not drawn: 1000 hPa over a hill, 925 hPa over a mountain', () => {
  assert.ok(modelClouds(one(1000, 90, MIDDLE, { elev: () => 10 }), []).length > 0, '110 m is 100 m over a ground of 10 m: drawn')
  assert.equal(modelClouds(one(1000, 90, MIDDLE, { elev: () => 11 }), []).length, 0, 'but not 99 m over 11 m')
  assert.equal(modelClouds(one(925, 90, MIDDLE, { elev: () => 700 }), []).length, 0, '760 m over a ground of 700 m')
  assert.ok(modelClouds(one(925, 90, MIDDLE, { elev: () => 600 }), []).length > 0)
  assert.equal(modelClouds(one(700, 90, MIDDLE, { elev: () => 2950 }), []).length, 0, 'any level, not only the low')
  assert.equal(modelClouds(one(1000, 90, MIDDLE, { z: () => -80 }), []).length, 0, 'a deep low: 1000 hPa under the sea')
  const unknown = modelClouds(one(925, 90, MIDDLE, { elev: () => null }), [])
  assert.ok(unknown.length > 0 && unknown.every((c) => c.groundM === 0), 'no ground known: sea level')
})

test('modelClouds: observations win: no low level within 40 km of a station that reports the sky (cloud, a clear sky or a hidden one); a station that says nothing of it, or one farther off, leaves it', () => {
  const north = (km: number) => ({ lat: MID_LAT + km / 111.195, lon: MID_LON })
  const reports = {
    layers: metar({ id: 'LAYERS', ...north(39), clouds: [layer('FEW', 3000)] }),
    clear: metar({ id: 'CLEAR', ...north(20), clouds: [layer('CLR', null)] }),
    cavok: metar({ id: 'CAVOK', ...north(30), raw: 'METAR CAVOK 031200Z 27010KT CAVOK 25/12 Q1015' }),
    fog: metar({ id: 'FOG', ...north(10), clouds: [layer('OVX', null)], vertVisFt: 200 }),
  }
  for (const [name, m] of Object.entries(reports)) assert.ok(reportsSky(m), name)
  for (const hPa of [1000, 925, 850]) {
    const g = one(hPa, 80)
    assert.ok(modelClouds(g, []).length > 0, `${hPa} hPa alone`)
    for (const [name, m] of Object.entries(reports)) assert.equal(modelClouds(g, [m]).length, 0, `${hPa} hPa, ${name} within 40 km`)
  }
  const g = one(925, 80)
  assert.ok(modelClouds(g, [metar({ id: 'FAR', ...north(41), clouds: [layer('FEW', 3000)] })]).length > 0, '41 km: left')
  assert.ok(modelClouds(g, [metar({ id: 'SILENT', ...north(5) })]).length > 0, 'it says nothing of the sky: not an observation of it')
  assert.ok(!reportsSky(metar({ id: 'SILENT' })))
  // a distance on the ground, not in degrees: 0.4° of longitude is 37.6 km here, 0.4° of latitude 44.5 km
  assert.equal(modelClouds(g, [metar({ id: 'W', lat: MID_LAT, lon: MID_LON - 0.4, clouds: [layer('OVC', 800)] })]).length, 0, '0.4° west: 37.6 km')
  assert.ok(modelClouds(g, [metar({ id: 'N', lat: MID_LAT + 0.4, lon: MID_LON, clouds: [layer('OVC', 800)] })]).length > 0, '0.4° north: 44.5 km')
  for (const hPa of [700, 600, 500, 400, 300, 250, 200]) {
    const alone = modelClouds(one(hPa, 80), [])
    assert.ok(alone.length > 0)
    assert.deepEqual(modelClouds(one(hPa, 80), Object.values(reports)), alone, `${hPa} hPa: mid and high levels are drawn whatever the stations say`)
  }
})

test('modelClouds: a station keeps the low levels off the places within 40 km of it and no others (its cell and its neighbours here, not the next ring)', () => {
  const g = modelGrid({ cover: (hPa) => (hPa === 925 ? 40 : 0) }) // 40 % at 925 hPa everywhere
  const st = metar({ id: 'MID', lat: MID_LAT, lon: MID_LON, clouds: [layer('FEW', 3000)] })
  const inBlock = (c: CloudSpec): boolean => Math.abs(c.lat - MID_LAT) < 0.375 - 1e-9 && Math.abs(c.lon - MID_LON) < 0.375 - 1e-9 // the 3 × 3 places within 40 km: 27.8 km north, 23.5 km east, 36.4 km on the diagonal
  const free = modelClouds(g, [])
  const kept = modelClouds(g, [st])
  assert.ok(free.filter(inBlock).length > 10, 'the block has clouds without the station')
  assert.equal(kept.filter(inBlock).length, 0, 'none in the block with it')
  assert.equal(kept.length, free.length, 'the places left out do not use up the cap: the others have it')
})

test('modelClouds: at most MODEL_LOOK.max clouds: what is wanted is thinned evenly over places and levels, and a cloud that stays is made √(wanted ÷ kept) larger, but not past 3 ×', () => {
  const overcast = modelClouds(modelGrid({ cover: () => 100 }), []) // 490 places and levels wanting 35,000 clouds
  assert.equal(overcast.length, MODEL_LOOK.max)
  assert.ok(overcast.every((c) => c.scale[0] >= 3 * Math.min(LOOKS.OVC.w[0], MODEL_LOOK.mid.look!.w[0], MODEL_LOOK.high.look!.w[0]) - 1e-6), 'so much was thinned: every cloud 3 × as wide as its look says')
  assert.ok(overcast.every((c) => c.scale[0] <= 3 * Math.max(LOOKS.OVC.w[1], MODEL_LOOK.high.look!.w[1]) + 1e-6 && c.scale[1] <= 3 * LOOKS.OVC.h[1] + 1e-6), 'and no more')
  // one low, one mid and one high level overcast over the whole grid: 10,800 wanted; each kind keeps its share (51 %, 30 %, 19 %), over the whole grid
  const three = modelClouds(modelGrid({ cover: (hPa) => (hPa === 925 || hPa === 600 || hPa === 250 ? 100 : 0) }), [])
  assert.equal(three.length, MODEL_LOOK.max)
  const share = (z: number): number => three.filter((c) => near(bottom(c), z, 1e-6)).length / three.length
  assert.ok(near(share(760), 0.5, 0.06) && near(share(4200), 0.33, 0.06) && near(share(10360), 0.16, 0.06), `low ${share(760)}, mid ${share(4200)}, high ${share(10360)}`)
  const lats = three.map((c) => c.lat)
  const lons = three.map((c) => c.lon)
  assert.ok(Math.min(...lats) < 31.8 && Math.max(...lats) > 32.7 && Math.min(...lons) < 34.3 && Math.max(...lons) > 35.2, 'over the whole grid, not the nearest corner of it')
  // six places overcast at 925 hPa want 6 × 115 = 690: 300 stay, 50 each, each made √(115 ÷ 50) = 1.5 × larger
  const six = modelGrid({ cover: (hPa, p) => (hPa === 925 && p < 6 ? 100 : 0) })
  const thinned = modelClouds(six, [])
  assert.equal(thinned.length, 300)
  const was = MODEL_LOOK.max
  try {
    ;(MODEL_LOOK as { max: number }).max = 10_000
    const full = modelClouds(six, [])
    assert.equal(full.length, 6 * Math.round(LOOKS.OVC.perKm2 * MODEL_LOOK.low.density * CELL_KM2(31.5)))
    const grew = mean(thinned.map((c) => c.scale[0])) / mean(full.map((c) => c.scale[0]))
    const wanted = full.length / 6
    assert.ok(near(grew, Math.sqrt(wanted / 50), 0.1), `${grew} wider, ${Math.sqrt(wanted / 50)} expected`)
    assert.ok(near(mean(thinned.map((c) => c.scale[1])) / mean(full.map((c) => c.scale[1])), Math.sqrt(wanted / 50), 0.1), 'and taller')
  } finally {
    ;(MODEL_LOOK as { max: number }).max = was
  }
})

test('modelClouds: thinning keeps the clouds it keeps where they were (the first of each place\'s own sequence); a cloud fades out by its size as the others do', () => {
  const six = modelGrid({ cover: (hPa, p) => (hPa === 925 && p < 6 ? 100 : 0) })
  const thinned = modelClouds(six, [])
  const was = MODEL_LOOK.max
  try {
    ;(MODEL_LOOK as { max: number }).max = 10_000
    const full = modelClouds(six, [])
    const places = new Set(full.map((c) => `${c.lat.toFixed(6)}|${c.lon.toFixed(6)}`))
    assert.ok(thinned.length > 0 && thinned.every((c) => places.has(`${c.lat.toFixed(6)}|${c.lon.toFixed(6)}`)), 'every cloud kept is a place the full sky has: thinning moves none')
  } finally {
    ;(MODEL_LOOK as { max: number }).max = was
  }
  for (const c of thinned) assert.equal(c.farKm, farKmOf(Math.max(c.scale[0], c.scale[1])))
  assert.ok(thinned.every((c) => c.farKm > 0 && c.farKm <= CLOUD_KM))
})

test('modelClouds: the same grid and reports draw the same clouds; another seed others; the next grid, a step on, draws a place again just as it was', () => {
  const g = one(700, 70)
  assert.deepEqual(modelClouds(g, []), modelClouds(structuredClone(g), []))
  assert.notDeepEqual(modelClouds(g, [], 1).map((c) => c.lon), modelClouds(g, []).map((c) => c.lon))
  const next = one(700, 70, 16, { lat0: 31.75, lon0: 34.25 }) // the same place, row 2 column 2 of a grid from 31.75°N 34.25°E
  assert.deepEqual(modelClouds(next, []), modelClouds(g, []))
  const more = modelClouds(one(700, 90), [])
  assert.deepEqual(more.slice(0, modelClouds(g, []).length).map((c) => [c.lon, c.lat]), modelClouds(g, []).map((c) => [c.lon, c.lat]), 'more cover: the same first clouds, more of them')
})

test('modelClouds: each level of a place draws puffs of its own, not the same spots again (no columns of stacked puffs)', () => {
  const cs = modelClouds(modelGrid({ cover: (hPa, p) => (p === MIDDLE && (hPa === 925 || hPa === 850) ? 70 : 0) }), [])
  const low = cs.filter((c) => near(bottom(c), 760, 1e-6))
  const lower = cs.filter((c) => near(bottom(c), 1460, 1e-6))
  assert.ok(low.length > 30 && lower.length > 30 && low.length + lower.length === cs.length)
  const spots = new Set(low.map((c) => `${c.lon}|${c.lat}`))
  assert.ok(!lower.some((c) => spots.has(`${c.lon}|${c.lat}`)))
})

test('modelClouds: a place across the antimeridian draws the same puffs whichever way its longitude is written (180.25 or −179.75): the next grid draws it as it was', () => {
  const east = one(700, 70, 3, { lat0: 0, lon0: 179.5 }) // row 0, column 3: 180.25°E
  const west = one(700, 70, 0, { lat0: 0, lon0: -179.75 }) // row 0, column 0
  assert.ok(modelClouds(west, []).length > 20)
  assert.deepEqual(modelClouds(east, []), modelClouds(west, []))
})

test('modelClouds: the look constants are read as the clouds are made (the console can tune them: Weather3D.rebuildSky)', () => {
  const g = one(925, 100)
  const before = modelClouds(g, []).length
  assert.ok(before > 50)
  const was = MODEL_LOOK.low.density
  try {
    ;(MODEL_LOOK.low as { density: number }).density = was / 2
    assert.ok(near(modelClouds(g, []).length, before / 2, 1), `${modelClouds(g, []).length} against ${before / 2}`)
  } finally {
    ;(MODEL_LOOK.low as { density: number }).density = was
  }
})

test('modelClouds: a grid across the antimeridian draws its clouds on both sides of it, longitudes within ±180°', () => {
  const g = modelGrid({ cover: () => 60, lon0: 179.5, lat0: 0 })
  const cs = modelClouds(g, [])
  assert.equal(cs.length, MODEL_LOOK.max)
  assert.ok(cs.every((c) => c.lon >= -180 && c.lon <= 180))
  assert.ok(cs.some((c) => c.lon > 179.5) && cs.some((c) => c.lon < -179), 'both sides')
})

// ---- puffs that end inside their quad ----------------------------------------------------------------------------------------

/** Every puff of every source of clouds, over many reports and cells: the observed layers, a CB's and a TCU's towers and anvils, the radar's towers and decks, the model's levels. */
function generatedSkies(): { name: string; cs: CloudSpec[] }[] {
  const layers: [string, Cloud[]][] = [
    ['FEW', [layer('FEW', 2000)]], ['SCT', [layer('SCT', 3000)]], ['BKN', [layer('BKN', 2500)]], ['OVC', [layer('OVC', 1500)]], ['CB', [layer('FEW', 3000, 'CB')]],
    ['TCU', [layer('SCT', 4000, 'TCU')]], ['BKN+CB, OVC', [layer('BKN', 2000, 'CB'), layer('OVC', 9000)]], ['all', [layer('FEW', 1500), layer('SCT', 3000, 'TCU'), layer('BKN', 6000), layer('OVC', 12000)]],
  ]
  const skies = layers.map(([name, clouds]) => ({ name, cs: Array.from({ length: 24 }, (_, i) => metarClouds(metar({ id: `ST${i}`, lat: 20 + (i % 40), lon: -30 + i * 2, elevM: (i * 37) % 800, clouds }), i % 3)).flat() }))
  const heavy = Array.from({ length: 400 }, (_, k) => cell(((k % 20) - 10) * 3, (Math.floor(k / 20) - 10) * 3, 30 + (k % 26), { seed: k + 1 }))
  const alone = Array.from({ length: 8 }, (_, i) => cell(30 * i - 105, 0, 31 + 3 * i, { seed: 500 + i }))
  const light = Array.from({ length: 900 }, (_, k) => cell(((k % 30) - 15) * 3, (Math.floor(k / 30) - 15) * 3, 15 + (k % 14), { seed: 900 + k }))
  const snow = Array.from({ length: 60 }, (_, k) => cell(((k % 10) - 5) * 8, (Math.floor(k / 10) - 3) * 8, 20 + (k % 30), { seed: 2000 + k, snow: true }))
  skies.push(
    { name: 'radar: heavy region', cs: radarClouds(heavy, base1500) }, { name: 'radar: isolated cells', cs: radarClouds(alone, base1500) },
    { name: 'radar: light rain', cs: radarClouds(light, base1500) }, { name: 'radar: snow', cs: radarClouds(snow, base1500) },
  )
  const levels: [string, (hPa: number, p: number) => number][] = [
    ['every level, 20 to 99 %', (hPa, p) => 20 + ((p * 7 + hPa) % 80)], ['overcast low levels', (hPa) => (hPa >= 850 ? 100 : 0)],
    ['broken mid levels', (hPa) => (hPa < 850 && hPa > 300 ? 70 : 0)], ['scattered cirrus', (hPa) => (hPa <= 300 ? 40 : 0)], ['few, everywhere', () => 22],
  ]
  for (const [name, cover] of levels) for (const seed of [0, 1, 2]) skies.push({ name: `model: ${name}, seed ${seed}`, cs: modelClouds(modelGrid({ cover, lat0: 10 + 20 * seed }), [], seed) })
  return skies
}

test('every puff of every source stays inside its quad: whatever the noise, the most it can draw at its end (its cut, or the quad\'s edge) is EDGE_ALPHA', () => {
  const skies = generatedSkies()
  let n = 0
  for (const { name, cs } of skies) {
    assert.ok(cs.length >= 40, `${name}: ${cs.length} puffs`)
    for (const c of cs) {
      assert.ok(staysInside(c), `${name}: ${c.maxSize.map((v) => v.toFixed(1))} slice ${c.slice.toFixed(3)} can draw ${edgeAlpha(c.maxSize, c.slice).toFixed(3)} at its end`)
      n++
    }
  }
  assert.ok(n > 8000, `${n} puffs checked`)
})

test('the slices are the looks\' own where those end soft already, and are raised, no further than the edge needs, where they do not (towers, anvils; the odd narrow cumulus)', () => {
  const sky = Object.fromEntries(generatedSkies().map((s) => [s.name, s.cs]))
  const raised = (cs: CloudSpec[], max: number): number => cs.filter((c) => c.slice > max + 1e-12).length / cs.length
  for (const [name, [lo, hi]] of [['FEW', LOOKS.FEW.slice], ['SCT', LOOKS.SCT.slice], ['BKN', LOOKS.BKN.slice], ['OVC', LOOKS.OVC.slice]] as const) {
    const cs = sky[name]
    assert.ok(cs.every((c) => c.slice >= lo - 1e-12 && c.slice <= 0.5), `${name}: never lowered, never far up`)
    assert.ok(raised(cs, hi) < 0.25, `${name}: ${(100 * raised(cs, hi)).toFixed(0)} % raised past ${hi}`)
  }
  const towers = sky.CB.filter((c) => c.tower !== undefined)
  assert.ok(towers.every((c) => c.slice >= 0.18 && c.slice <= 0.5))
  assert.ok(raised(towers, 0.32) > 0, 'an anvil is cut low and narrow: raised')
  assert.ok(sky.CB.some((c) => c.slice > 0.26 && c.scale[1] > c.scale[0] / 3), 'a tower\'s puff cut at 0.18 to 0.26 would end in a hard rim: raised')
  assert.equal(staysInside({ maxSize: [17, 16, 16], slice: 0.2 }), false, 'as asked, a tower puff ends in a rim a noise-free sky would show')
  assert.equal(staysInside({ maxSize: [46, 9, 8], slice: 0.26 }), false, 'as asked, an anvil puff too')
  assert.ok(EDGE_ALPHA <= 0.03)
})

test('the slices keep the draws as they were: raising a slice moves no cloud and changes no size or shade', () => {
  const m = metar({ id: 'KDOV', clouds: [layer('BKN', 2500, 'CB'), layer('OVC', 8000)] })
  const a = metarClouds(m)
  const was = LOOKS.OVC.slice
  try {
    ;(LOOKS.OVC as { slice: readonly [number, number] }).slice = [0.5, 0.5]
    const b = metarClouds(m)
    assert.deepEqual(b.map((c) => [c.lon, c.lat, c.heightM, c.scale, c.maxSize, c.brightness, c.tint, c.tower]), a.map((c) => [c.lon, c.lat, c.heightM, c.scale, c.maxSize, c.brightness, c.tint, c.tower]))
  } finally {
    ;(LOOKS.OVC as { slice: readonly [number, number] }).slice = was
  }
})

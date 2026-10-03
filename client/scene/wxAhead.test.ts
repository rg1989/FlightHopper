// client/scene/wxAhead.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Sigmet } from '../../shared/wx.ts'
import { DEFAULT_UNITS } from '../ui/units.ts'
import { PUFF_FILL, type CloudSpec } from './cloudField.ts'
import {
  AHEAD_KM, AHEAD_MIN, IN_COVER, PROFILE_COLS, PROFILE_ROWS, PROFILE_TOP_M, SEV_COLOR, SEV_NAME, aheadPath, aheadProfile, aheadStatus, hazardWords,
  pathPointAt, sevOf, statusWords, type AheadPath, type AheadPoint, type AheadStatus,
} from './wxAhead.ts'
import type { Hazard } from './wxGeo.ts'
import { buildField, sampleField } from './wxField.ts'

type Ring = [number, number][]
const FT = 0.3048
const KM_PER_DEG = 111.195 // of latitude, on a sphere of 6,371 km
const LAT = 32
const LON = 34.9
const GS = 360 // kt: 11.112 km a minute
const KPM = (GS * 1.852) / 60
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol
/** The place eastKm and northKm of the aircraft's start, on the plane round it (the paths here run north). */
const at = (eastKm: number, northKm: number): { lat: number; lon: number } => ({ lat: LAT + northKm / KM_PER_DEG, lon: LON + eastKm / (KM_PER_DEG * Math.cos((LAT * Math.PI) / 180)) })
/** The great-circle distance between two places, km, on the 6,371 km sphere. */
function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}
function bearingDeg(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180
  const dl = (b.lon - a.lon) * r
  const y = Math.sin(dl) * Math.cos(b.lat * r)
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos(dl)
  return ((Math.atan2(y, x) / r) + 360) % 360
}

/** A puff whose base and top are given (as wxField.test's): wide is its billboard's width in metres, its disc 0.36 of that in radius. */
function puff(baseM: number, topM: number, o: Partial<CloudSpec> & { eastKm?: number; northKm?: number; wide?: number } = {}): CloudSpec {
  const { eastKm = 0, northKm = 0, wide = 6000, ...rest } = o
  return {
    ...at(eastKm, northKm), heightM: (baseM + topM) / 2, groundM: 0, scale: [wide, (topM - baseM) / PUFF_FILL], maxSize: [20, 12, 12], slice: 0.3,
    brightness: 1, tint: 0, farKm: 100, ...rest,
  }
}

const START: AheadPoint = { lat: LAT, lon: LON, altM: 3000 }
const path = (o: { alt?: number; track?: number; gs?: number; vs?: number } = {}): AheadPath => aheadPath({ ...START, altM: o.alt ?? 3000 }, o.track ?? 0, o.gs ?? GS, o.vs ?? 0)!

const sigmet = (rings: Ring[], baseM: number, topM: number, o: Partial<Sigmet> = {}): Sigmet =>
  ({ hazard: 'TS', qualifier: 'EMBD', base: baseM / FT, top: topM / FT, until: '2026-10-03T06:00:00Z', raw: '', rings, ...o })
const hazard = (ring: Ring, baseM: number, topM: number, o: Partial<Sigmet> = {}): Hazard =>
  ({ sigmet: sigmet([ring], baseM, topM, o), rings: [ring], nearest: ring, baseM, topM, key: `${baseM}|${topM}|${ring[0]}` })
/** The ring a lon/lat box makes, closed as GeoJSON closes it. */
const box = (south: number, west: number, north: number, east: number): Ring => [[west, south], [east, south], [east, north], [west, north], [west, south]]
/** A box 2° wide on the path's meridian, from fromKm to toKm north of the start (negative: south of it). */
const band = (fromKm: number, toKm: number): Ring => box(LAT + fromKm / KM_PER_DEG, LON - 1, LAT + toKm / KM_PER_DEG, LON + 1)
const words = (h: Hazard): string => `${h.sigmet.hazard} ${h.baseM}-${h.topM}`

// ---- the path ----------------------------------------------------------------------------------------------------------

test('aheadPath: seven points, the aircraft now and then each minute to six; level, they keep the height; a minute is gs·1.852/60 km on the great circle along the track', () => {
  assert.equal(AHEAD_MIN, 6)
  const p = path()
  assert.equal(p.points.length, AHEAD_MIN + 1)
  assert.ok(near(p.kmPerMin, KPM, 1e-12), String(p.kmPerMin))
  assert.deepEqual(p.points[0], START)
  for (let i = 0; i <= AHEAD_MIN; i++) {
    assert.ok(near(haversineKm(START, p.points[i]), i * KPM, 1e-6), `${i} min: ${haversineKm(START, p.points[i])} km`)
    assert.equal(p.points[i].altM, 3000, `${i} min: level`)
    if (i > 0) assert.ok(near(bearingDeg(START, p.points[i]), 0, 1e-6), 'due north all the way')
  }
  const p2 = path({ track: 90, gs: 480 })
  for (let i = 1; i <= AHEAD_MIN; i++) {
    assert.ok(near(haversineKm(START, p2.points[i]), (i * 480 * 1.852) / 60, 1e-6))
    assert.ok(near(bearingDeg(START, p2.points[i]), 90, 1e-6), 'an initial bearing of 90°: the great circle through the points leaves due east')
  }
  assert.ok(p2.points[6].lat < LAT, 'a great circle along an east track curves toward the equator (it is the parallel that bends away)')
})

test('aheadPath: climbing, the height rises by vsFpm each minute; descending into the ground it stops at 0 and stays', () => {
  const up = path({ alt: 1000, vs: 1500 })
  for (let i = 0; i <= AHEAD_MIN; i++) assert.ok(near(up.points[i].altM, 1000 + 1500 * FT * i, 1e-9), `${i} min`)
  const down = path({ alt: 400, vs: -500 })
  assert.ok(near(down.points[1].altM, 400 - 500 * FT, 1e-9) && near(down.points[2].altM, 400 - 1000 * FT, 1e-9))
  assert.deepEqual(down.points.slice(3).map((q) => q.altM), [0, 0, 0, 0], 'on the ground in the third minute, and no lower')
  assert.ok(down.points.every((q) => q.altM >= 0))
})

test('aheadPath: under 40 kt there is no way ahead (null); 40 kt is the least; a missing or broken number is none', () => {
  assert.equal(aheadPath(START, 0, 39.9, 0), null)
  assert.equal(aheadPath(START, 0, 0, 0), null)
  assert.notEqual(aheadPath(START, 0, 40, 0), null)
  assert.ok(near(aheadPath(START, 0, 40, 0)!.kmPerMin, (40 * 1.852) / 60, 1e-12))
  assert.equal(aheadPath(START, Number.NaN, GS, 0), null)
  assert.equal(aheadPath(START, 0, Number.NaN, 0), null)
  assert.equal(aheadPath(START, 0, GS, Number.NaN), null)
  assert.equal(aheadPath({ ...START, lat: Number.NaN }, 0, GS, 0), null)
})

test('aheadPath: across the antimeridian a longitude stays within ±180°; a track of any size is a bearing (−90 is 270)', () => {
  const p = aheadPath({ lat: 0, lon: 179.9, altM: 0 }, 90, 480, 0)!
  assert.ok(p.points.every((q) => q.lon >= -180 && q.lon <= 180), p.points.map((q) => q.lon).join(' '))
  assert.ok(p.points[6].lon < 0, 'it has crossed')
  const a = aheadPath(START, -90, GS, 0)!
  const b = aheadPath(START, 270, GS, 0)!
  assert.ok(near(a.points[3].lat, b.points[3].lat, 1e-9) && near(a.points[3].lon, b.points[3].lon, 1e-9))
})

test('pathPointAt: the points at the minutes; between them straight in height along the great circle; beyond the last, on along it at the last minute\'s climb', () => {
  const p = path({ alt: 1000, vs: 1200 })
  for (let i = 0; i <= AHEAD_MIN; i++) {
    const q = pathPointAt(p, i * KPM)
    assert.ok(near(q.lat, p.points[i].lat, 1e-9) && near(q.lon, p.points[i].lon, 1e-9) && near(q.altM, p.points[i].altM, 1e-6), `${i} min`)
  }
  const half = pathPointAt(p, 2.5 * KPM)
  assert.ok(near(half.altM, 1000 + 1200 * FT * 2.5, 1e-6))
  assert.ok(near(haversineKm(START, half), 2.5 * KPM, 1e-6))
  const far = pathPointAt(p, AHEAD_KM)
  assert.ok(near(haversineKm(START, far), AHEAD_KM, 1e-6), 'on the same great circle, 80 km out')
  assert.ok(near(bearingDeg(START, far), 0, 1e-6))
  assert.ok(near(far.altM, 1000 + 1200 * FT * (AHEAD_KM / KPM), 1e-6), 'the climb goes on')
  assert.ok(near(pathPointAt(p, 0).altM, 1000, 1e-9))
  const sink = path({ alt: 300, vs: -400 })
  assert.equal(pathPointAt(sink, AHEAD_KM).altM, 0, 'not below 0 out there either')
  const out = { lat: 0, lon: 0, altM: 0 }
  assert.equal(pathPointAt(p, 5, out), out, 'into the caller\'s point when it gives one')
})

// ---- what is on the path -----------------------------------------------------------------------------------------------

const CLEAR = { inside: false, sev: 0, inMin: null }

test('aheadStatus: in cloud when the field\'s cover under the aircraft is above 0.3, with the cloud\'s severity', () => {
  const f = buildField([puff(2000, 4000, { sev: 2 })], LAT, LON)
  const s = aheadStatus(path(), f, [], words)
  assert.equal(IN_COVER, 0.3)
  assert.deepEqual(s.cloud, { inside: true, sev: 2, inMin: 0 })
  assert.equal(s.hazard, null)
  const above = aheadStatus(path({ alt: 5000 }), f, [], words)
  assert.equal(above.cloud.inside, false, 'above the top')
  const onBase = aheadStatus(path({ alt: 2000.5 }), f, [], words)
  assert.equal(onBase.cloud.inside, false, 'half a metre over the base: the cloud has not risen yet (its base is rounded over a few hundred metres)')
})

test('aheadStatus: clear air, then cloud on the path: how many minutes to its first edge (cover above 0.3)', () => {
  const f = buildField([puff(2000, 4000, { northKm: 30, sev: 1 })], LAT, LON)
  const s = aheadStatus(path(), f, [], words)
  assert.equal(s.cloud.inside, false)
  assert.equal(s.cloud.sev, 1)
  assert.ok(s.cloud.inMin !== null && near(s.cloud.inMin, (30 - 2) / KPM, 0.15), `the disc's edge is about 28 km out: ${s.cloud.inMin} min`)
  const slow = aheadStatus(path({ gs: 120 }), f, [], words)
  assert.ok(slow.cloud.inMin !== null && near(slow.cloud.inMin, 28 / ((120 * 1.852) / 60), 0.5), 'the minutes follow the speed')
  const high = buildField([puff(3000, 5000, { northKm: 30, wide: 8000 })], LAT, LON)
  assert.equal(aheadStatus(path({ alt: 500 }), high, [], words).cloud.inMin, null, 'level under it: nothing')
  const rising = aheadStatus(path({ alt: 500, vs: 4000 }), high, [], words) // 1,219 m a minute: up to the base, 3,000 m, in 2 min, and into the cloud before its edge
  assert.ok(rising.cloud.inMin !== null && rising.cloud.inMin > 2 && rising.cloud.inMin < 3, `it is the way the path climbs that meets the cloud: ${rising.cloud.inMin} min`)
})

test('aheadStatus: nothing within reach is null minutes: cloud off to the side, cloud over the path, cloud beyond 80 km, no field, an empty one', () => {
  const side = buildField([puff(2000, 4000, { eastKm: 25, northKm: 30 })], LAT, LON)
  assert.deepEqual(aheadStatus(path(), side, [], words).cloud, CLEAR)
  const over = buildField([puff(2000, 4000, { northKm: 30 })], LAT, LON)
  assert.deepEqual(aheadStatus(path({ alt: 6000 }), over, [], words).cloud, CLEAR, 'a level path over it')
  const under = buildField([puff(5000, 7000, { northKm: 30 })], LAT, LON)
  assert.deepEqual(aheadStatus(path({ alt: 1000 }), under, [], words).cloud, CLEAR, 'under it')
  const far = buildField([puff(2000, 4000, { northKm: 100 })], LAT, LON)
  assert.deepEqual(aheadStatus(path(), far, [], words).cloud, CLEAR, '100 km: past the 80 km reach')
  assert.deepEqual(aheadStatus(path(), null, [], words).cloud, CLEAR)
  assert.deepEqual(aheadStatus(path(), buildField([], LAT, LON), [], words).cloud, CLEAR)
})

test('aheadStatus: the severity is the worst of the first 8 km of the cloud on the path, counted to the first gap in it', () => {
  const chain = (sevs: number[]): ReturnType<typeof buildField> => buildField(sevs.map((sev, i) => puff(2000, 4000, { northKm: 30 + 3 * i, sev })), LAT, LON) // one body, 3 km between its middles
  assert.equal(aheadStatus(path(), chain([1, 1, 3]), [], words).cloud.sev, 3, 'a storm 6 km into the body')
  assert.equal(aheadStatus(path(), chain([1, 1, 1, 1, 3]), [], words).cloud.sev, 1, 'a storm 12 km into it is not what the first weather is')
  const gap = buildField([puff(2000, 4000, { northKm: 30, sev: 1 }), puff(2000, 4000, { northKm: 60, sev: 3 })], LAT, LON)
  assert.equal(aheadStatus(path(), gap, [], words).cloud.sev, 1, 'the storm beyond a gap in the cloud is not part of it')
})

test('aheadStatus: a hazard area the aircraft is in and under the top of is inside; above the top, or under its base, it is not', () => {
  const ring = band(-10, 40)
  assert.deepEqual(aheadStatus(path({ alt: 5000 }), null, [hazard(ring, 0, 10_000)], words).hazard, { inside: true, inMin: 0, text: 'TS 0-10000' })
  assert.equal(aheadStatus(path({ alt: 11_000 }), null, [hazard(ring, 0, 10_000)], words).hazard, null, 'above the top, and it stays level: nothing')
  assert.equal(aheadStatus(path({ alt: 3000 }), null, [hazard(ring, 6000, 10_000)], words).hazard, null, 'under its base')
  assert.equal(aheadStatus(path({ alt: 10_000 }), null, [hazard(ring, 0, 10_000)], words).hazard, null, 'a top is not inside it')
  assert.equal(aheadStatus(path({ alt: 6000 }), null, [hazard(ring, 6000, 10_000)], words).hazard?.inside, true, 'a base is')
  const outside = aheadStatus(path({ alt: 5000 }), null, [hazard(band(-80, -40), 0, 10_000)], words) // behind the aircraft
  assert.equal(outside.hazard, null)
})

test('aheadStatus: a hazard area ahead on the path: the minutes to its first edge, at the heights the path has there', () => {
  const ring = band(40, 70)
  const s = aheadStatus(path({ alt: 5000 }), null, [hazard(ring, 0, 10_000)], words)
  assert.equal(s.hazard?.inside, false)
  assert.ok(s.hazard?.inMin != null && near(s.hazard.inMin, 40 / KPM, 0.05), `${s.hazard?.inMin} min`)
  assert.equal(s.hazard?.text, 'TS 0-10000')
  // under its base now, climbing into it: it is ahead from where the path reaches the base
  const rising = aheadStatus(path({ alt: 3000, vs: 3000 }), null, [hazard(band(10, 70), 6000, 10_000)], words)
  assert.equal(rising.hazard?.inside, false)
  assert.ok(rising.hazard?.inMin != null && rising.hazard.inMin > 3 && rising.hazard.inMin < 4, `${rising.hazard?.inMin}: 3,000 ft at 914 m a minute is 3.3 min, 36 km out`)
  // over its top, descending into it
  const falling = aheadStatus(path({ alt: 12_000, vs: -4000 }), null, [hazard(band(10, 70), 0, 10_000)], words)
  assert.ok(falling.hazard?.inMin != null && falling.hazard.inMin > 1.5 && falling.hazard.inMin < 2.2, `${falling.hazard?.inMin}`)
  assert.equal(aheadStatus(path({ alt: 12_000 }), null, [hazard(ring, 0, 10_000)], words).hazard, null, 'level over it: not ahead')
  assert.equal(aheadStatus(path({ alt: 5000 }), null, [hazard(band(120, 160), 0, 10_000)], words).hazard, null, 'beyond 80 km')
})

test('aheadStatus: of several hazard areas the one the aircraft is in; else the nearest on the path; its words are the label given', () => {
  const far = hazard(band(60, 70), 0, 10_000, { hazard: 'TURB' })
  const near1 = hazard(band(25, 30), 0, 10_000, { hazard: 'ICE' })
  const s = aheadStatus(path({ alt: 5000 }), null, [far, near1], words)
  assert.equal(s.hazard?.text, 'ICE 0-10000')
  const here = hazard(band(-5, 5), 0, 10_000, { hazard: 'MTW' })
  assert.deepEqual(aheadStatus(path({ alt: 5000 }), null, [far, near1, here], words).hazard, { inside: true, inMin: 0, text: 'MTW 0-10000' })
  const asked: Hazard[] = []
  aheadStatus(path({ alt: 5000 }), null, [near1], (h) => (asked.push(h), 'x'))
  assert.deepEqual(asked, [near1], 'the label asked for the one it says')
})

test('aheadStatus: a hazard area of several rings is in where any ring is; one across the antimeridian is read as the one area it is', () => {
  const h: Hazard = { ...hazard(band(100, 110), 0, 10_000), rings: [band(100, 110), band(35, 50)] }
  assert.ok(near(aheadStatus(path({ alt: 5000 }), null, [h], words).hazard!.inMin!, 35 / KPM, 0.05))
  const across: Ring = [[179, -1], [-179, -1], [-179, 1], [179, 1], [179, -1]]
  const east = aheadPath({ lat: 0, lon: 179.5, altM: 5000 }, 90, 360, 0)!
  const x = hazard(across, 0, 10_000)
  assert.equal(aheadStatus(east, null, [x], words).hazard?.inside, true, 'in it, east of the line')
  const west = aheadPath({ lat: 0, lon: -179.5, altM: 5000 }, 90, 360, 0)!
  assert.equal(aheadStatus(west, null, [x], words).hazard?.inside, true, 'and west of it')
})

// ---- the profile -------------------------------------------------------------------------------------------------------

test('aheadProfile: 160 × 50 cells over 80 km and 0 … 12,500 m; each cell is the field\'s value at its middle, on the path, as sampleField gives it', () => {
  assert.deepEqual([PROFILE_COLS, PROFILE_ROWS, AHEAD_KM, PROFILE_TOP_M], [160, 50, 80, 12_500])
  const f = buildField([puff(2000, 4000, { northKm: 30, sev: 2 }), puff(5000, 9000, { northKm: 55, wide: 9000, sev: 3, tower: 0 })], LAT, LON)
  const p = path({ alt: 3000, vs: 500 })
  const pr = aheadProfile(p, f, [])
  assert.deepEqual([pr.cols, pr.rows, pr.kmAhead, pr.topM], [160, 50, 80, 12_500])
  assert.equal(pr.cover.length, 160 * 50)
  assert.equal(pr.sev.length, 160 * 50)
  assert.deepEqual(pr.hazards, [])
  let covered = 0
  for (let i = 0; i < 160; i += 1) {
    const d = (i + 0.5) * 0.5
    const q = pathPointAt(p, d)
    for (let j = 0; j < 50; j += 1) {
      const want = sampleField(f, q.lat, q.lon, (j + 0.5) * 250)
      assert.ok(near(pr.cover[j * 160 + i], want.cover, 1e-6) && near(pr.sev[j * 160 + i], want.sev, 1e-6), `cell ${i}, ${j}`)
      if (want.cover > 0.5) covered++
    }
  }
  assert.ok(covered > 40, `the sweep meets cloud: ${covered} cells`)
  const mid = 60 // column 60 is d = 30.25 km, the cumulus
  assert.ok(pr.cover[11 * 160 + mid] > 0.9, 'z = 2,875 m in the cumulus')
  assert.ok(near(pr.sev[11 * 160 + mid], 2, 1e-5))
  assert.equal(pr.cover[30 * 160 + mid], 0, '7,625 m over it: clear')
  assert.equal(pr.cover[2 * 160 + mid], 0, '625 m under its base')
})

test('aheadProfile: no field, or an empty one, is an empty profile; the hazard areas still come', () => {
  for (const f of [null, buildField([], LAT, LON)]) {
    const pr = aheadProfile(path(), f, [hazard(band(40, 60), 0, 10_000)])
    assert.ok(pr.cover.every((v) => v === 0) && pr.sev.every((v) => v === 0))
    assert.equal(pr.hazards.length, 1)
  }
})

test('aheadProfile: a hazard area is a run along the path, from its first column\'s edge to its last\'s, with its heights; one run for each time the path crosses it', () => {
  const pr = aheadProfile(path(), null, [hazard(band(40, 60), 1000, 9000)])
  assert.equal(pr.hazards.length, 1)
  assert.ok(near(pr.hazards[0].fromKm, 40, 0.5) && near(pr.hazards[0].toKm, 60, 0.5), JSON.stringify(pr.hazards))
  assert.deepEqual([pr.hazards[0].baseM, pr.hazards[0].topM], [1000, 9000])
  const two: Hazard = { ...hazard(band(10, 20), 0, 8000), rings: [band(10, 20), band(50, 55)] }
  const runs = aheadProfile(path(), null, [two]).hazards
  assert.equal(runs.length, 2)
  assert.ok(near(runs[0].fromKm, 10, 0.5) && near(runs[0].toKm, 20, 0.5) && near(runs[1].fromKm, 50, 0.5) && near(runs[1].toKm, 55, 0.5))
  const ends = aheadProfile(path(), null, [hazard(band(70, 120), 0, 8000), hazard(band(-20, 5), 0, 8000)]).hazards
  assert.ok(ends[0].fromKm === 0 && near(ends[0].toKm, 5, 0.5), 'one the aircraft is in starts at 0 (the runs come nearest first)')
  assert.ok(near(ends[1].fromKm, 70, 0.5) && ends[1].toKm === 80, 'a run still on at 80 km ends there')
  assert.deepEqual(aheadProfile(path(), null, [hazard(band(-60, -30), 0, 8000)]).hazards, [], 'behind: none')
})

// ---- the words ---------------------------------------------------------------------------------------------------------

const status = (cloud: Partial<AheadStatus['cloud']>, hazardPart: AheadStatus['hazard'] = null): AheadStatus => ({ cloud: { inside: false, sev: 0, inMin: null, ...cloud }, hazard: hazardPart })

test('the severity scale: cloud, light rain, heavy rain, a thunderstorm, with the colours of the plan; a number rounds and stays within it', () => {
  assert.deepEqual([...SEV_COLOR], ['#f2f5f8', '#58a6ff', '#ffbe3d', '#ff4d3d'])
  assert.deepEqual([...SEV_NAME], ['cloud', 'light rain', 'heavy rain', 'a thunderstorm'])
  assert.deepEqual([0, 0.4, 0.5, 1.49, 2.6, 3, 3.4, 9, -1].map(sevOf), [0, 0, 1, 1, 3, 3, 3, 3, 0])
})

test('statusWords: in cloud — "In light rain", with its colour; "In cloud" for plain cloud; "In a thunderstorm"', () => {
  assert.deepEqual(statusWords(status({ inside: true, sev: 1, inMin: 0 })), { cloud: 'In light rain', sev: 1, hazard: null })
  assert.deepEqual(statusWords(status({ inside: true, sev: 0, inMin: 0 })), { cloud: 'In cloud', sev: 0, hazard: null })
  assert.deepEqual(statusWords(status({ inside: true, sev: 2, inMin: 0 })).cloud, 'In heavy rain')
  assert.deepEqual(statusWords(status({ inside: true, sev: 3, inMin: 0 })).cloud, 'In a thunderstorm')
})

test('statusWords: clear air with weather ahead — the worst of it and the minutes, "under a minute" before the first; clear air with none: "Clear air ahead"', () => {
  assert.deepEqual(statusWords(status({ sev: 3, inMin: 3.2 })), { cloud: 'Clear air · a thunderstorm in 3 min', sev: 3, hazard: null })
  assert.equal(statusWords(status({ sev: 1, inMin: 0.6 })).cloud, 'Clear air · light rain in under a minute')
  assert.equal(statusWords(status({ sev: 0, inMin: 1.4 })).cloud, 'Clear air · cloud in 1 min')
  assert.equal(statusWords(status({ sev: 2, inMin: 17.6 })).cloud, 'Clear air · heavy rain in 18 min')
  assert.deepEqual(statusWords(status({})), { cloud: 'Clear air ahead', sev: null, hazard: null })
})

test('statusWords: a hazard area — "Inside hazard area · …", "Hazard area in 2 min · …" (never under a minute), and none', () => {
  assert.equal(statusWords(status({}, { inside: true, inMin: 0, text: 'embedded thunderstorms, up to 35,000 ft' })).hazard, 'Inside hazard area · embedded thunderstorms, up to 35,000 ft')
  assert.equal(statusWords(status({}, { inside: false, inMin: 2.2, text: 'icing' })).hazard, 'Hazard area in 2 min · icing')
  assert.equal(statusWords(status({}, { inside: false, inMin: 0.2, text: 'icing' })).hazard, 'Hazard area in 1 min · icing')
  assert.equal(statusWords(status({}, { inside: false, inMin: null, text: 'icing' })).hazard, 'Hazard area ahead · icing')
  assert.equal(statusWords(status({}, null)).hazard, null)
})

test('hazardWords: the area\'s label as a phrase after the dot: no capital, no second dot', () => {
  const s = sigmet([], 0, 35_000 * FT, { base: null, top: 35_000 })
  assert.equal(hazardWords(s, DEFAULT_UNITS), 'embedded thunderstorms, up to 35,000 ft')
  assert.equal(hazardWords(sigmet([], 0, 0, { hazard: 'TURB', qualifier: 'SEV MTW', base: 18_000, top: 35_000 }), DEFAULT_UNITS), 'severe turbulence (mountain waves), 18,000 to 35,000 ft')
  assert.equal(hazardWords(sigmet([], 0, 0, { hazard: 'TS', qualifier: 'EMBD', base: 0, top: 10_000 }), { ...DEFAULT_UNITS, alt: 'm' }), 'embedded thunderstorms, surface to 3,050 m')
  assert.equal(hazardWords(sigmet([], 0, 0, { hazard: 'VA', qualifier: 'ERUPTION MT SANGAY', base: null, top: 40_000 }), DEFAULT_UNITS), 'volcanic ash (Eruption Mt Sangay), up to 40,000 ft')
  assert.equal(hazardWords(sigmet([], 0, 0, { hazard: 'SQL', qualifier: null, base: null, top: 20_000 }), DEFAULT_UNITS), 'SQL, up to 20,000 ft', 'a code with no words keeps its capitals')
  assert.equal(hazardWords(sigmet([], 0, 0, { hazard: 'TS', qualifier: null, base: null, top: null }), DEFAULT_UNITS), 'thunderstorms', 'no top: the title alone')
})

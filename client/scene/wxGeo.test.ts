// client/scene/wxGeo.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { distanceNm } from '../../shared/geo.ts'
import type { Metar, Sigmet } from '../../shared/wx.ts'
import { hazardsNear, inRing, ringCentre, ringDistanceKm, shiftMetars, shiftSigmets, viewBox, wrapLon } from './wxGeo.ts'

type Ring = [number, number][]
const FT = 0.3048
const KM_PER_DEG = 111.195 // of latitude, on a sphere of 6,371 km
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol

test('viewBox: whole degrees outward; null when wider than 40°, crossing the antimeridian, or no view', () => {
  assert.equal(viewBox({ west: 34.2, south: 29.5, east: 35.9, north: 33.1 }), '29,34,34,36')
  assert.equal(viewBox({ west: -10, south: 20, east: 31, north: 30 }), null)
  assert.equal(viewBox({ west: 170, south: 0, east: -170, north: 10 }), null)
  assert.equal(viewBox(null), null)
})

test('viewBox: cut at the poles and the antimeridian', () => {
  assert.equal(viewBox({ west: 177.5, south: 87.5, east: 181.5, north: 91.5 }), '87,177,90,180')
  assert.equal(viewBox({ west: -181.5, south: -91.5, east: -177.5, north: -87.5 }), '-90,-180,-87,-177')
})

test('point-in-area', () => {
  const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]]
  assert.equal(inRing(sq, 5, 5), true)
  assert.equal(inRing(sq, 15, 5), false)
})

test('wrapLon: into −180…180; a longitude already there is kept as it is', () => {
  for (const lon of [-180, -179.9, 0, 34.95, 180]) assert.equal(wrapLon(lon), lon)
  assert.equal(wrapLon(181), -179)
  assert.equal(wrapLon(-181), 179)
  assert.equal(wrapLon(360), 0)
  assert.equal(wrapLon(540), -180)
  assert.ok(near(wrapLon(34.95 + 360), 34.95, 1e-9))
  assert.ok(Number.isNaN(wrapLon(Number.NaN)))
})

/** The ring a lon/lat box makes, closed as GeoJSON closes it. */
const box = (south: number, west: number, north: number, east: number): Ring => [[west, south], [east, south], [east, north], [west, north], [west, south]]
const across: Ring = [[179, -1], [-179, -1], [-179, 1], [179, 1], [179, -1]] // 179°E to 179°W, 1° each side of the equator

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

test('ringDistanceKm: a ring across the antimeridian is the one ring it is: inside is inside, and the far side of the Earth is 20,000 km off (it was 0)', () => {
  for (const [lat, lon] of [[0, 180], [0, -179.5], [0.5, 179.5], [-0.9, 179.1], [0.9, -179.1]]) assert.equal(ringDistanceKm(across, lat, lon), 0, `${lat}, ${lon}`)
  assert.ok(near(ringDistanceKm(across, 0, -177), 2 * KM_PER_DEG, 1), 'two degrees east of its east edge')
  assert.ok(near(ringDistanceKm(across, 0, 177), 2 * KM_PER_DEG, 1), 'and two west of its west one')
  assert.ok(near(ringDistanceKm(across, 0, 0), 179 * KM_PER_DEG, 50), `${ringDistanceKm(across, 0, 0)} km: on the meridian opposite it`)
  assert.ok(near(ringDistanceKm(across, 0, 90), 89 * KM_PER_DEG, 50))
  // 150°W to 140°W, 25 to 40°N, seen from over Tel Aviv: a latitude band that holds the point's, on the far side of the Earth
  const pacific = ringDistanceKm(box(25, -150, 40, -140), 32, 35)
  assert.ok(pacific > 9000 && pacific < 13000, `${pacific} km`)
  assert.equal(ringDistanceKm(box(25, -150, 40, -140), 32, -145), 0, 'and inside it, inside')
})

test('ringDistanceKm: a ring wider than a half circle in longitude is read on its own branch (its middle\'s), all the way round', () => {
  // corners 60° apart along 10° N and 10° S, from 100°W to 100°E: 200° wide
  const wide: Ring = [[-100, 10], [-40, 10], [20, 10], [80, 10], [100, 10], [100, -10], [80, -10], [20, -10], [-40, -10], [-100, -10], [-100, 10]]
  for (const lon of [-99, -50, 0, 50, 99]) assert.equal(ringDistanceKm(wide, 5, lon), 0, `inside at ${lon}`)
  for (const lon of [101, 150, 180, -150, -101]) assert.ok(ringDistanceKm(wide, 5, lon) > 0, `outside at ${lon}`)
  const far = ringDistanceKm(wide, 5, 180)
  assert.ok(far > 8000 && far < 9000, `${far} km from the back`)
})

test('ringDistanceKm: a ring of fewer than three corners is nowhere; a point that is not one is nowhere near', () => {
  assert.equal(ringDistanceKm([], 0, 0), Infinity)
  assert.equal(ringDistanceKm([[0, 0], [1, 1]], 0, 0), Infinity)
  assert.ok(!(ringDistanceKm(box(0, 0, 1, 1), Number.NaN, 0) <= 800))
})

test('ringCentre: the middle of a ring\'s corners, the closing corner counted once, across the antimeridian too', () => {
  const c = ringCentre(box(30, 34, 34, 36))
  assert.ok(near(c.lat, 32, 0.05) && near(c.lon, 35, 0.01), JSON.stringify(c))
  const a = ringCentre(across)
  assert.ok(near(a.lat, 0, 1e-9) && near(Math.abs(a.lon), 180, 1e-9), JSON.stringify(a))
  const l = ringCentre([[0, 0], [4, 0], [0, 4], [0, 0]]) // three corners and the first again: the mean of the three
  assert.ok(near(l.lon, 4 / 3, 0.01) && near(l.lat, 4 / 3, 0.01), JSON.stringify(l))
})

const sigmet = (o: Partial<Sigmet> & { rings: Ring[] }): Sigmet => ({ hazard: 'TS', qualifier: 'EMBD', base: null, top: 35000, until: '2026-10-03T06:00:00Z', raw: '', ...o })
const AC = { lat: 32.1, lon: 34.9 }
/** A box whose south edge is km due north of the aircraft, 2° wide round its meridian, height° tall. */
const northOf = (km: number, height = 1): Ring => box(AC.lat + km / KM_PER_DEG, AC.lon - 1, AC.lat + km / KM_PER_DEG + height, AC.lon + 1)
const hazards = (list: Sigmet[], at = AC, km = 800): ReturnType<typeof hazardsNear> => hazardsNear(list, at.lat, at.lon, km)

test('hazardsNear: a SIGMET with a top whose ring passes within the reach; the aircraft inside a ring counts', () => {
  const list = [
    sigmet({ rings: [northOf(790)] }), // in
    sigmet({ rings: [northOf(810)] }), // out
    sigmet({ rings: [box(AC.lat - 1, AC.lon - 1, AC.lat + 1, AC.lon + 1)] }), // the aircraft is inside it
    sigmet({ rings: [northOf(100)], top: null }), // no top: no volume to draw
    sigmet({ rings: [northOf(100)], top: 0 }),
    sigmet({ rings: [northOf(100)], base: 20000, top: 20000 }), // a top at its base: no volume
    sigmet({ rings: [northOf(100)], base: 30000, top: 20000 }), // under it
    sigmet({ rings: [[[AC.lon, AC.lat], [AC.lon + 0.1, AC.lat]]] }), // two corners, on the aircraft, are not a ring
  ]
  assert.deepEqual(hazards(list).map((h) => h.sigmet), [list[0], list[2]])
  assert.deepEqual(hazards(list, AC, 850).map((h) => h.sigmet), [list[0], list[1], list[2]], 'the reach is an argument')
  assert.deepEqual(hazards([]), [])
})

test('hazardsNear: a ring across the far meridian is not in reach (it was "inside")', () => {
  assert.deepEqual(hazards([sigmet({ rings: [across] })], { lat: 0, lon: 0 }), [])
  assert.deepEqual(hazards([sigmet({ rings: [box(25, -150, 40, -140)] })], { lat: 32, lon: 35 }), [])
  const near = (lon: number): number => hazards([sigmet({ rings: [across] })], { lat: 0, lon }).length
  assert.equal(near(179.6), 1, 'inside it, it is')
  assert.equal(near(-176), 1, '333 km off, across the meridian')
  assert.equal(near(175), 1, '445 km off, on the other side')
  assert.equal(near(170), 0, '1,000 km off')
})

test('hazardsNear: from the base (none: the ground, 0) to the top, in metres from the feet the SIGMET gives; the rings within reach, the nearest for the label', () => {
  const [far, mid, close, east] = [northOf(900), northOf(500), northOf(200), box(AC.lat - 1, AC.lon + 3, AC.lat + 1, AC.lon + 4)] // the last ~280 km east
  const [a, b] = hazards([sigmet({ rings: [northOf(300)] }), sigmet({ base: 18000, top: 35000, rings: [far, mid, close, east] })])
  assert.deepEqual([a.baseM, a.topM], [0, 35000 * FT])
  assert.deepEqual([b.baseM, b.topM], [18000 * FT, 35000 * FT])
  assert.deepEqual(b.rings, [mid, close, east], 'the ring at 900 km is left out')
  assert.equal(b.nearest, close)
  assert.notEqual(a.key, b.key)
})

test('hazardsNear: the key is what is drawn: the same for the same area sent again, another for any change of its words, heights or any corner', () => {
  const key = (o: Partial<Sigmet> = {}, ring: Ring = northOf(300, 2)): string => hazards([sigmet({ rings: [ring], ...o })])[0].key
  const base = key()
  assert.equal(key(), base, 'a new list, the same area')
  assert.equal(key({ raw: 'another text', until: '2026-10-04T00:00:00Z' }), base, 'what is not drawn does not count')
  for (const o of [{ top: 36000 }, { base: 1000 }, { qualifier: 'SEV' }, { qualifier: null }, { hazard: 'TURB' }]) assert.notEqual(key(o), base, JSON.stringify(o))
  const moved = (i: number): Ring => northOf(300, 2).map(([x, y], j) => (j === i ? [x + 0.01, y] : [x, y])) as Ring
  for (let i = 0; i < 4; i++) assert.notEqual(key({}, moved(i)), base, `corner ${i} moved by 0.01°`)
  assert.notEqual(key({}, [...northOf(300, 2).slice(0, 4), [AC.lon, AC.lat + 3], northOf(300, 2)[0]]), base, 'a corner more')
  const two = hazards([sigmet({ rings: [northOf(300, 2), northOf(500, 2)] })])[0].key
  assert.notEqual(two, base, 'a ring more')
})

/** A seeded run of numbers in [0, 1). */
function random(seed: number): () => number {
  let s = seed
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32
}

test('hazardsNear: the rings it passes over for their cap are the ones ringDistanceKm puts out of reach, whatever their size and place', () => {
  const rnd = random(11)
  let picked = 0
  let passed = 0
  for (let trial = 0; trial < 40; trial++) {
    const list: Sigmet[] = []
    for (let i = 0; i < 30; i++) {
      // a ring round a place, from a fraction of a degree to 40° across but not over a pole, near the antimeridian as anywhere
      const [lat0, lon0] = [rnd() * 150 - 75, rnd() < 0.2 ? 175 + rnd() * 10 : rnd() * 360 - 180]
      const radius = Math.min(0.2 * Math.exp(rnd() * 5.3), 85 - Math.abs(lat0))
      const corners = 4 + Math.floor(rnd() * 9)
      const ring: Ring = []
      for (let k = 0; k < corners; k++) {
        const t = ((k + rnd() * 0.5) / corners) * 2 * Math.PI
        const r = radius * (0.5 + rnd() * 0.5)
        ring.push([wrapLon(lon0 + (r * Math.sin(t)) / Math.cos((lat0 * Math.PI) / 180)), lat0 + r * Math.cos(t)])
      }
      ring.push(ring[0])
      list.push(sigmet({ rings: [ring] }))
      assert.equal(ringDistanceKm(ring, lat0, wrapLon(lon0)), 0, `the place a ring was drawn round is inside it: ${lat0.toFixed(1)}, ${lon0.toFixed(1)}`)
    }
    for (let q = 0; q < 12; q++) {
      const [lat, lon] = q < 6 ? [rnd() * 180 - 90, rnd() * 360 - 180] : [list[q].rings[0][0][1] + rnd() * 10 - 5, list[q].rings[0][0][0] + rnd() * 10 - 5]
      for (const km of [800, 3000]) {
        const want = list.filter((s) => ringDistanceKm(s.rings[0], lat, lon) <= km)
        const got = hazardsNear(list, lat, lon, km).map((h) => h.sigmet)
        assert.deepEqual(got, want, `trial ${trial}, ${lat.toFixed(1)}, ${lon.toFixed(1)}, ${km} km`)
        picked += got.length
        passed += list.length - got.length
      }
    }
  }
  assert.ok(picked > 100 && passed > 5000, `${picked} picked, ${passed} left out: both sides are tried`)
})

test('hazardsNear: the distance of a ring is asked only when its cap comes within reach', () => {
  const [far, closeBy, edge] = [box(-60, 100, -58, 102), northOf(300, 2), northOf(790, 2)] // 12,000 km off; 300; 790
  const asked: Ring[] = []
  const got = hazardsNear([sigmet({ rings: [far] }), sigmet({ rings: [closeBy, far] }), sigmet({ rings: [edge] })], AC.lat, AC.lon, 800, (ring, lat, lon) => {
    asked.push(ring)
    return ringDistanceKm(ring, lat, lon)
  })
  assert.deepEqual(got.map((h) => h.rings), [[closeBy], [edge]])
  assert.deepEqual(asked, [closeBy, edge], 'the ring 12,000 km off was passed over (twice): nothing asked of it')
})

test('hazardsNear: a ring with no cap to speak of (its corners round the globe or past a hemisphere) is never passed over', () => {
  const equator: Ring = [[0, 0], [90, 0], [180, 0], [-90, 0], [0, 0]] // its corners cancel: no middle
  assert.equal(hazards([sigmet({ rings: [equator] })], { lat: 0.5, lon: 30 }).length, 1, 'half a degree off its line')
  assert.equal(hazards([sigmet({ rings: [equator] })], { lat: 40, lon: 30 }).length, 0)
  const big: Ring = [[-170, -60], [-90, -60], [0, -60], [90, -60], [170, -60], [170, 60], [90, 60], [0, 60], [-90, 60], [-170, 60], [-170, -60]] // 340° wide
  assert.equal(hazards([sigmet({ rings: [big] })], { lat: 0, lon: 20 }).length, 1, 'inside')
  assert.equal(hazards([sigmet({ rings: [big] })], { lat: 55, lon: 179 }, 1000).length, 1, 'in the gap between its ends, 570 km from one')
  assert.equal(hazards([sigmet({ rings: [big] })], { lat: 55, lon: 179 }, 400).length, 0)
})

test('hazardsNear and ringDistanceKm give the same answers for a ring asked again: what is worked out for it is kept', () => {
  const ring = northOf(300, 2)
  const first = [ringDistanceKm(ring, 32.1, 34.9), ringCentre(ring), hazards([sigmet({ rings: [ring] })])[0].key]
  assert.deepEqual([ringDistanceKm(ring, 32.1, 34.9), ringCentre(ring), hazards([sigmet({ rings: [ring] })])[0].key], first)
})

const metar = (id: string, lat: number, lon: number): Metar => ({
  id, name: id, lat, lon, elevM: 30, obsMs: null, cat: 'VFR', wdir: 250, wspd: 5, wgst: null, visKm: null, visPlus: true, tempC: null, dewC: null,
  qnhHpa: null, wx: null, clouds: [{ cover: 'FEW', baseFt: 3000, type: null }], vertVisFt: null, raw: 'METAR',
})

test('shiftMetars: each report moved, longitudes kept within ±180°, nothing else changed, the list asked for left alone; no move gives the list', () => {
  const list = [metar('LSZH', 47.46, 8.55), metar('NFFN', -17.76, 177.4)]
  const got = shiftMetars(list, -15.3, 26.4)
  assert.ok(near(got[0].lat, 32.16, 1e-9) && near(got[0].lon, 34.95, 1e-9))
  assert.ok(near(got[1].lat, -33.06, 1e-9) && near(got[1].lon, 177.4 + 26.4 - 360, 1e-9), `${got[1].lon}: across the antimeridian`)
  assert.deepEqual({ ...got[0], lat: 0, lon: 0 }, { ...list[0], lat: 0, lon: 0 })
  assert.equal(list[0].lat, 47.46)
  assert.equal(shiftMetars(list, 0, 0), list)
})

test('shiftSigmets: every corner of every ring moved, longitudes kept within ±180°, nothing else changed, the list asked for left alone; no move gives the list', () => {
  const list = [sigmet({ rings: [box(47, 8, 48, 9), box(10, 178, 11, 179)] })]
  const got = shiftSigmets(list, -15.3, 26.4)
  assert.ok(got[0].rings[0].every(([x, y], i) => near(x, list[0].rings[0][i][0] + 26.4, 1e-9) && near(y, list[0].rings[0][i][1] - 15.3, 1e-9)))
  assert.ok(near(got[0].rings[1][0][0], 178 + 26.4 - 360, 1e-9), 'wrapped')
  assert.deepEqual({ ...got[0], rings: [] }, { ...list[0], rings: [] })
  assert.deepEqual(list[0].rings[0], box(47, 8, 48, 9))
  assert.equal(shiftSigmets(list, 0, 0), list)
})

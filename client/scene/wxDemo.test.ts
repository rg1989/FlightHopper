// client/scene/wxDemo.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_CLOUDS, PUFF_FILL, type CloudSpec } from './cloudField.ts'
import { staysInside } from './cloudQuad.ts'
import { demoSky } from './wxDemo.ts'
import { buildField, sampleField } from './wxField.ts'
import { inRing } from './wxGeo.ts'
import { sigmetColor, sigmetTitle } from './wxText.ts'

const KM_PER_DEG = 111.195
const LAT = 32
const LON = 34.9
const RAD = Math.PI / 180
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol
const sevOf = (c: CloudSpec): number => c.sev ?? 0
const bottom = (c: CloudSpec): number => c.heightM - (PUFF_FILL * c.scale[1]) / 2
const top = (c: CloudSpec): number => c.heightM + (PUFF_FILL * c.scale[1]) / 2

/** Km along the track and to its right of a place, from (LAT, LON), on the plane round it. */
function frame(p: { lat: number; lon: number }, trackDeg: number, lat = LAT, lon = LON): { along: number; right: number } {
  const e = (p.lon - lon) * KM_PER_DEG * Math.cos(lat * RAD)
  const n = (p.lat - lat) * KM_PER_DEG
  const t = trackDeg * RAD
  return { along: e * Math.sin(t) + n * Math.cos(t), right: e * Math.cos(t) - n * Math.sin(t) }
}
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

test('demoSky: the same call gives the same sky', () => {
  assert.deepEqual(demoSky(LAT, LON, 90), demoSky(LAT, LON, 90))
  const a = demoSky(LAT, LON, 90)
  assert.ok(a.specs.length > 100 && a.specs.length < MAX_CLOUDS, `${a.specs.length} specs: a sky the cloud layer can draw`)
})

test('demoSky: laid along the track from the place: the same sky turned and moved (a tower\'s puffs round its axis, and its anvil\'s way, are not turned)', () => {
  const a = demoSky(LAT, LON, 90)
  for (const [lat, lon, track] of [[LAT, LON, 0], [37.6, -122.4, 285], [-33.9, 151.2, 200]] as const) {
    const b = demoSky(lat, lon, track)
    assert.equal(b.specs.length, a.specs.length)
    for (let i = 0; i < a.specs.length; i++) {
      const [p, q] = [frame(a.specs[i], 90), frame(b.specs[i], track, lat, lon)]
      const tol = a.specs[i].tower === undefined ? 0.3 : 19 // a tower puff: the anvil\'s are up to 9 km from the axis, one way or another
      assert.ok(near(p.along, q.along, tol) && near(p.right, q.right, tol), `spec ${i} at ${track}°: ${p.along},${p.right} against ${q.along},${q.right}`)
      assert.equal(a.specs[i].heightM, b.specs[i].heightM)
      assert.equal(sevOf(a.specs[i]), sevOf(b.specs[i]))
    }
  }
})

test('demoSky: a severity-3 storm about 100 km along the track, a second 25 km to its left at about 88 km; sev 2 outside the core', () => {
  const { specs } = demoSky(LAT, LON, 90)
  const core = specs.filter((c) => sevOf(c) === 3 && frame(c, 90).right > -15).map((c) => frame(c, 90))
  assert.ok(core.length >= 6, `${core.length} core puffs`)
  assert.ok(near(mean(core.map((p) => p.along)), 100, 8) && Math.abs(mean(core.map((p) => p.right))) < 8, `core at ${mean(core.map((p) => p.along))}, ${mean(core.map((p) => p.right))}`)
  assert.ok(specs.some((c) => sevOf(c) === 3 && frame(c, 90).right < -15), 'the second storm has a core too')
  const second = specs.filter((c) => sevOf(c) >= 2 && frame(c, 90).right < -15).map((c) => frame(c, 90))
  assert.ok(second.length >= 4)
  assert.ok(near(mean(second.map((p) => p.along)), 88, 8) && near(mean(second.map((p) => p.right)), -25, 6), `second at ${mean(second.map((p) => p.along))}, ${mean(second.map((p) => p.right))}`)
  assert.ok(specs.some((c) => sevOf(c) === 2), 'sev 2 round the core')
  const pillar = specs.filter((c) => sevOf(c) === 3 && frame(c, 90).right > -15).sort((a, b) => a.heightM - b.heightM)
  assert.ok(near(Math.min(...pillar.map(bottom)), 1000, 1e-6), 'from 1,000 m')
  assert.ok(near(Math.max(...pillar.map(top)), 11000, 1e-6), 'to 11,000 m')
  assert.ok(pillar.some((c) => c.scale[1] < c.scale[0] / 3), 'an anvil on top')
})

test('demoSky: small cumulus (bases about 1,500 m, severity 0) from 0 to 40 km ahead and to the sides', () => {
  const { specs } = demoSky(LAT, LON, 90)
  const cu = specs.filter((c) => sevOf(c) === 0 && c.tower === undefined)
  assert.ok(cu.length >= 40, `${cu.length} cumulus`)
  for (const c of cu) {
    assert.ok(near(bottom(c), 1500, 150), `base ${bottom(c)}`)
    assert.ok(c.scale[0] >= 1000 && c.scale[0] <= 5000 && c.scale[1] < c.scale[0], `small: ${c.scale}`)
    const p = frame(c, 90)
    assert.ok(p.along >= 0 && p.along <= 42 && Math.abs(p.right) <= 50, `at ${p.along}, ${p.right}`)
  }
  const ps = cu.map((c) => frame(c, 90))
  assert.ok(ps.some((p) => p.along < 12 && Math.abs(p.right) < 6), 'one or two close to the track to fly through early')
  assert.ok(ps.some((p) => p.right > 20) && ps.some((p) => p.right < -20), 'both sides')
})

test('demoSky: a rain layer 7,000 to 8,700 m from 50 to 76 km ahead: severity 1, overlapping puffs in a deck', () => {
  const { specs } = demoSky(LAT, LON, 90)
  const rain = specs.filter((c) => sevOf(c) === 1)
  assert.ok(rain.length >= 40, `${rain.length} puffs`)
  for (const c of rain) {
    assert.ok(near(bottom(c), 7000, 150) && near(top(c), 8700, 150), `${bottom(c)} to ${top(c)}`)
    assert.equal(c.tower, undefined)
    assert.ok(c.scale[1] < c.scale[0] / 3, 'flat')
  }
  const ps = rain.map((c) => frame(c, 90))
  assert.ok(Math.min(...ps.map((p) => p.along)) >= 46 && Math.max(...ps.map((p) => p.along)) <= 80, `${Math.min(...ps.map((p) => p.along))} … ${Math.max(...ps.map((p) => p.along))}`)
  assert.ok(near(Math.min(...ps.map((p) => p.along)), 50, 4) && near(Math.max(...ps.map((p) => p.along)), 76, 4))
  // overlapping: in the field, the middle of the deck is solid
  const f = buildField(specs, LAT, LON)
  const mid = { along: 63, right: 0 }
  const s = (fr: { along: number; right: number }): { cover: number; sev: number } => {
    const e = fr.along, n = fr.right * -1 // heading east: right is south
    return sampleField(f, LAT + n / KM_PER_DEG, LON + e / (KM_PER_DEG * Math.cos(LAT * RAD)), 7800)
  }
  assert.ok(s(mid).cover > 0.8 && near(s(mid).sev, 1, 1e-6), `${s(mid).cover}`)
})

test('demoSky: one SIGMET, thunderstorms embedded, to 34,000 ft with no base, in a five-corner ring that starts 80 km ahead and holds both storms', () => {
  const { specs, sigmets } = demoSky(LAT, LON, 90)
  assert.equal(sigmets.length, 1)
  const s = sigmets[0]
  assert.equal(s.hazard, 'TS')
  assert.equal(s.qualifier, 'EMBD')
  assert.equal(sigmetTitle(s), 'Embedded thunderstorms', 'as the app words it')
  assert.equal(sigmetColor(s.hazard), '#ff5a5a', 'a thunderstorm\'s red')
  assert.equal(s.top, 34000)
  assert.equal(s.base, null)
  assert.equal(s.rings.length, 1)
  const ring = s.rings[0]
  assert.equal(ring.length, 5)
  const corners = ring.map(([lon, lat]) => frame({ lat, lon }, 90))
  assert.ok(near(Math.min(...corners.map((p) => p.along)), 80, 2), `starts ${Math.min(...corners.map((p) => p.along))} km ahead`)
  assert.ok(Math.max(...corners.map((p) => p.along)) > 125, 'and runs well past the storms')
  const storm = specs.filter((c) => sevOf(c) >= 2)
  assert.ok(storm.length > 10)
  assert.ok(specs.filter((c) => sevOf(c) === 3).every((c) => inRing(ring, c.lon, c.lat)), 'the core')
  const quiet = specs.filter((c) => sevOf(c) < 2)
  assert.ok(quiet.every((c) => !inRing(ring, c.lon, c.lat)), 'none of the cumulus nor the rain deck is in it')
  // whichever way the track runs, the storms\' puffs (a tower\'s anvil spreads along a compass way, not the track) are in the ring
  for (const track of [0, 45, 90, 135, 200, 285, 330]) {
    const sky = demoSky(LAT, LON, track)
    const r = sky.sigmets[0].rings[0]
    for (const c of sky.specs.filter((c) => sevOf(c) >= 2)) assert.ok(inRing(r, c.lon, c.lat), `track ${track}: a storm puff at ${JSON.stringify(frame(c, track))} is in the ring`)
  }
})

test('demoSky: every puff stays inside its billboard (the cloud layer can draw the sky as it is) and is told when to fade', () => {
  const { specs } = demoSky(LAT, LON, 90)
  for (const c of specs) {
    assert.ok(staysInside(c), `${c.maxSize} slice ${c.slice}`)
    assert.ok(c.farKm > 0 && c.farKm <= 150 && c.brightness > 0 && c.brightness <= 1 && c.tint >= 0 && c.tint <= 1)
    assert.ok(Number.isFinite(c.lon) && Number.isFinite(c.lat) && c.lon >= -180 && c.lon <= 180)
  }
})

test('demoSky: over the antimeridian and near a pole its longitudes stay within ±180', () => {
  for (const [lat, lon, track] of [[10, 179.9, 90], [64, -179.5, 270]] as const) {
    const { specs, sigmets } = demoSky(lat, lon, track)
    assert.ok(specs.every((c) => c.lon >= -180 && c.lon <= 180))
    assert.ok(sigmets[0].rings[0].every(([x]) => x >= -180 && x <= 180))
  }
})

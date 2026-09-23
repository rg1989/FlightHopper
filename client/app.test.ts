// client/app.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import type { Airport } from '../shared/airports.ts'
import type { StatusBrief } from '../shared/api.ts'
import { distanceNm } from '../shared/geo.ts'
import { countryOf } from '../shared/icaoCountry.ts'
import type { FleetEntry, ModelManifestEntry } from './types.ts'

// app.ts imports viewer.ts, the ui/ modules and layout.css, which import CSS for Vite. Node cannot load CSS, so this file
// loads every .css as an empty module. The hook lives only in this test's process: node --test runs each file in its own.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { attributionFor, browseCircle, entriesIn, flagOf, lookupFor, placedHeightM, readParams, relHFor, sceneKey, statusShown, viewRadiusNm } =
  await import('./app.ts')

const entry = (hex: string, lat: number, lon: number): FleetEntry => ({
  hex, lat, lon, hM: 0, altFt: null, onGround: false, trackDeg: null, gsKt: null, vsFpm: null, ageS: 0, staleS: 60, quality: 'adsb2', info: null,
})

test('view radius follows the camera height, in 10 nm steps, clamped to 20–5,400 nm', () => {
  assert.equal(viewRadiusNm(0), 20)
  assert.equal(viewRadiusNm(150), 20) // chasing on the runway
  assert.equal(viewRadiusNm(37_040), 20) // 20 nm up
  assert.equal(viewRadiusNm(37_041), 30)
  assert.equal(viewRadiusNm(100_000), 60) // 54 nm → next step
  assert.equal(viewRadiusNm(20_000_000), 5400) // whole-Earth view: the visible hemisphere
  assert.equal(viewRadiusNm(Number.NaN), 5400)
})

test('browse poll circle: centred on the visible rectangle, covering all of it, in 10 nm steps within 20–5,400 nm', () => {
  // The rectangle WP-B-V3's harness measured for the 300 km top-down view over LLBG (800×692 px canvas).
  const r = { west: 32.999, south: 30.628, east: 36.774, north: 33.367 }
  const c = browseCircle(r)
  assert.deepEqual({ lat: c.lat, lon: c.lon }, { lat: 32, lon: 34.89 }) // 2 decimals: the ApiClient's view key
  assert.equal(c.nm % 10, 0)
  for (const [lat, lon] of [[r.south, r.west], [r.south, r.east], [r.north, r.west], [r.north, r.east]]) {
    const d = distanceNm(c.lat, c.lon, lat, lon)
    assert.ok(d <= c.nm && d > c.nm - 10, `corner ${lat},${lon} at ${d.toFixed(1)} nm, circle ${c.nm} nm`)
  }
  assert.equal(c.nm, 130)
})

test('browse poll circle: antimeridian, whole world, tiny views, and a stable key for a camera at rest', () => {
  const across = browseCircle({ west: 179, south: -1, east: -179, north: 1 })
  assert.deepEqual(across, { lat: 0, lon: -180, nm: 90 }) // 2° wide across 180°: centred on it, not on Greenwich
  assert.ok(distanceNm(0, -180, 1, 179) <= 90)
  assert.deepEqual(browseCircle({ west: -180, south: -90, east: 180, north: 90 }), { lat: 0, lon: 0, nm: 5400 }) // capped (the app centres such a view on the camera)
  assert.equal(browseCircle({ west: 11.33, south: 47.25, east: 11.36, north: 47.27 }).nm, 20) // 2 km up: the floor
  const r = { west: 8.1, south: 46.2, east: 14.6, north: 48.3 }
  assert.deepEqual(browseCircle(r), browseCircle({ ...r })) // same view → same key → the server sends only what is new
})

test('on-screen entries: the ones inside the rectangle, written into a reused array', () => {
  const all = [entry('a', 47, 11), entry('b', 50, 11), entry('c', 0, 179.5), entry('d', 0, -179.5), entry('e', 0, 170)]
  const out: FleetEntry[] = [entry('stale', 0, 0)]
  const got = entriesIn(all, { west: 10, south: 46, east: 12, north: 48 }, out)
  assert.equal(got, out) // no new array per frame
  assert.deepEqual(got.map((e) => e.hex), ['a'])
  assert.deepEqual(entriesIn(all, { west: 179, south: -1, east: -179, north: 1 }, out).map((e) => e.hex), ['c', 'd'])
  assert.deepEqual(entriesIn(all, null, out), []) // globe out of view
  assert.equal(out.length, 0)
  // The selected aircraft always counts: chasing, it flies in front of the camera, above the ground the camera sees.
  assert.deepEqual(entriesIn(all, { west: 10, south: 46, east: 12, north: 48 }, out, 'e').map((e) => e.hex), ['a', 'e'])
  assert.deepEqual(entriesIn(all, null, out, 'b').map((e) => e.hex), ['b'])
})

test('flags and lookups: country from the ICAO address block, airline from the callsign designator', () => {
  assert.equal(flagOf('4b1805'), '🇨🇭') // Switzerland 4B0000–4B7FFF
  assert.equal(flagOf('738065'), '🇮🇱')
  assert.equal(flagOf('~4b1805'), '') // non-ICAO (TIS-B) address: no country
  assert.equal(flagOf('b00001'), '') // unallocated block (the synthetic heavy replay uses it)
  const l = lookupFor('4b1805', 'SWR8KL')
  assert.deepEqual(l, { country: { iso2: 'CH', name: 'Switzerland', flag: '🇨🇭' }, airline: 'Swiss International Air Lines' })
  assert.notEqual(l.country, countryOf('4b1805')) // a copy: countryOf's objects are shared and frozen
  assert.deepEqual(lookupFor('b00001', null), { country: null, airline: null })
  assert.deepEqual(lookupFor('3c6444', 'DABCD'), { country: { iso2: 'DE', name: 'Germany', flag: '🇩🇪' }, airline: null }) // a registration, not a flight
})

test('chased model height: wheels on the terrain on the ground, never below it in the air', () => {
  assert.equal(placedHeightM(-20, true, -31.5), -31.5) // ground: the terrain, whatever the estimator says
  assert.equal(placedHeightM(-20, true, null), -20) // tile not loaded yet: the estimate
  assert.equal(placedHeightM(-40, false, -31.5), -31.5) // airborne below the terrain: lifted to it
  assert.equal(placedHeightM(300, false, -31.5), 300) // airborne above: untouched
  assert.equal(placedHeightM(300, false, null), 300)
})

test('URL parameters: ?hex= (lower-cased, validated), ?bench=1, ?airport=', () => {
  assert.deepEqual(readParams('?hex=A1B2C3&bench=1'), { hex: 'a1b2c3', bench: true, airport: null })
  assert.deepEqual(readParams('?hex=~a330e6'), { hex: '~a330e6', bench: false, airport: null })
  assert.deepEqual(readParams('?hex=nope&bench=true&airport=llbg'), { hex: null, bench: false, airport: 'LLBG' })
  assert.deepEqual(readParams(''), { hex: null, bench: false, airport: null })
})

test('attribution: adsb.lol ODbL, OurAirports, OpenFlights ODbL, OpenStreetMap, planespotters, the model licence', () => {
  const m: ModelManifestEntry = {
    id: 'cesium-air',
    uri: 'models/Cesium_Air.glb',
    license: 'Apache-2.0: CesiumJS repository LICENSE.md',
    author: 'CesiumJS Contributors (Cesium GS, Inc.)',
    source: 'https://github.com/CesiumGS/cesium',
    forwardAxisFix: { headingDeg: -90, pitchDeg: 0, rollDeg: 0 },
    gearHeightM: 4.03,
    lengthM: 37.57,
    scale: 1.7555,
  }
  const lines = attributionFor(m)
  assert.ok(lines.some((l) => /adsb\.lol/.test(l) && /ODbL/.test(l)), lines.join(' | '))
  assert.ok(lines.some((l) => /OurAirports/.test(l)))
  assert.ok(lines.includes('Airline names: OpenFlights (ODbL)'), lines.join(' | ')) // ODbL requires the credit
  assert.ok(lines.some((l) => /OpenStreetMap contributors/.test(l) && /ODbL/.test(l)), lines.join(' | '))
  assert.ok(lines.some((l) => /planespotters\.net/.test(l)), lines.join(' | '))
  assert.ok(lines.includes('3D model: CesiumJS Contributors (Cesium GS, Inc.), Apache-2.0'), lines.join(' | '))
  assert.equal(attributionFor(null).length, lines.length - 1)
})

test('status shown: 3 failed polls in a row read as "upstream-down"; fewer change nothing', () => {
  const ok: StatusBrief = { source: 'replay', degraded: null, cellPeriodP95S: null, chasePeriodP95S: null }
  assert.equal(statusShown(ok, 0), ok)
  assert.equal(statusShown(ok, 2), ok)
  assert.deepEqual(statusShown(ok, 3), { ...ok, degraded: 'upstream-down' })
  assert.deepEqual(statusShown({ ...ok, degraded: 'blocked' }, 0), { ...ok, degraded: 'blocked' })
})

const press = (key: string, more: object = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, repeat: false, target: null, ...more })

test('scene keys: T topography and L sun, either case; not with a modifier, on auto-repeat or while typing in a field', () => {
  assert.equal(sceneKey(press('t')), 'topo')
  assert.equal(sceneKey(press('T')), 'topo') // Shift or Caps Lock
  assert.equal(sceneKey(press('l')), 'light')
  assert.equal(sceneKey(press('L')), 'light')
  assert.equal(sceneKey(press('x')), 'glass')
  assert.equal(sceneKey(press('X')), 'glass')
  assert.equal(sceneKey(press('b')), null)
  assert.equal(sceneKey(press('Escape')), null)
  for (const m of ['metaKey', 'ctrlKey', 'altKey', 'repeat']) assert.equal(sceneKey(press('l', { [m]: true })), null, m) // Cmd+L, Ctrl+T: the browser's
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(sceneKey(press('t', { target: { tagName } })), null, tagName) // the table's search box
  assert.equal(sceneKey(press('t', { target: { tagName: 'DIV', isContentEditable: true } })), null)
  assert.equal(sceneKey(press('t', { target: { tagName: 'BUTTON', isContentEditable: false } })), 'topo') // a focused toggle
})

test('flat plane (design D4): a hero airport within 30 km gives its runway height, else the ground under the aircraft, else the plane stays', () => {
  const heroes: Airport[] = JSON.parse(readFileSync(new URL('../public/airports/heroes.json', import.meta.url), 'utf8'))
  const hafelekar = { lat: 47.3125, lon: 11.3864 } // on the Nordkette, 6.6 km from LOWI
  assert.equal(relHFor(hafelekar, 2345, 0, heroes), 627.72) // LOWI: the mean of its threshold heights 629.72 and 625.72
  assert.equal(relHFor(hafelekar, null, 0, heroes), 627.72)
  const zugspitze = { lat: 47.4211, lon: 10.9853 } // 32.4 km from LOWI
  assert.equal(relHFor(zugspitze, 2950, 627.72, heroes), 2950) // flatten from rest: the drawn ground is the true one
  assert.equal(relHFor(zugspitze, null, 627.72, heroes), 627.72) // ground unknown, or a new selection while flat: keep the plane
  assert.equal(relHFor(null, 2950, 56.57, heroes), 56.57) // no aircraft drawn yet
})

test('attribution: the night lights credit NASA GIBS (design D13)', () => {
  assert.ok(attributionFor(null).includes('Night lights: NASA GIBS, VIIRS Black Marble'))
})

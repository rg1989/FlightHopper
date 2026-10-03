// client/app.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import type { Airport } from '../shared/airports.ts'
import type { StatusBrief } from '../shared/api.ts'
import { distanceNm } from '../shared/geo.ts'
import { countryOf } from '../shared/icaoCountry.ts'
import type { FleetEntry } from './types.ts'

// app.ts imports viewer.ts, the ui/ modules and layout.css, which import CSS for Vite. Node cannot load CSS, so this file
// loads every .css as an empty module. The hook lives only in this test's process: node --test runs each file in its own.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { browseCircle, entriesIn, flagOf, lookupFor, placedHeightM, readParams, relHFor, safeArea, scenarioBaseFor, sceneKey, statusShown, viewRadiusNm, weatherMenuOpens, weatherView } =
  await import('./app.ts')

const entry = (hex: string, lat: number, lon: number): FleetEntry => ({
  hex, lat, lon, hM: 0, altFt: null, onGround: false, trackDeg: null, gsKt: null, vsFpm: null, ageS: 0, staleS: 60, gapS: 1, quality: 'adsb2', info: null,
})

test('view radius follows the camera height, in 10 nm steps, clamped to 20–5,400 nm', () => {
  assert.equal(viewRadiusNm(0), 20)
  assert.equal(viewRadiusNm(150), 20) // chasing on the runway
  assert.equal(viewRadiusNm(37_040), 20) // 20 nm up
  assert.equal(viewRadiusNm(37_041), 30)
  assert.equal(viewRadiusNm(100_000), 60) // 54 nm → next step
  assert.equal(viewRadiusNm(20_000_000), 5400) // whole-Earth view: the visible hemisphere
  assert.equal(viewRadiusNm(Number.NaN), 5400)
  // Chasing from far out: at least the 3-D traffic's radius round the aircraft, so what is drawn is asked for.
  assert.equal(viewRadiusNm(32_000, 60), 60) // 100 km behind a cruising aircraft at −12°: the camera is 17 nm up
  assert.equal(viewRadiusNm(32_000, 35), 40)
  assert.equal(viewRadiusNm(150, 10), 20)
  assert.equal(viewRadiusNm(150_000, 60), 90) // straight above: the height says more
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

test('browse poll circle: centred on the screen centre when given (the server fills outwards from it), still covering every corner', () => {
  const r = { west: 100, south: -60, east: 170, north: 5 } // a globe view over Australia: the rectangle's middle is not the screen's
  const c = browseCircle(r, { lat: -25.004, lon: 135.001 })
  assert.deepEqual({ lat: c.lat, lon: c.lon }, { lat: -25, lon: 135 })
  for (const [lat, lon] of [[r.south, r.west], [r.south, r.east], [r.north, r.west], [r.north, r.east]]) assert.ok(distanceNm(c.lat, c.lon, lat, lon) <= c.nm)
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
  assert.equal(sceneKey(press('m')), 'base') // map or satellite, for the view on screen
  assert.equal(sceneKey(press('R')), 'roads')
  assert.equal(sceneKey(press('p')), 'places') // borders and places: a switch apart from the roads
  assert.equal(sceneKey(press('P')), 'places')
  assert.equal(sceneKey(press('w')), 'wx')
  assert.equal(sceneKey(press('b')), null)
  assert.equal(sceneKey(press('Escape')), null)
  for (const m of ['metaKey', 'ctrlKey', 'altKey', 'repeat']) assert.equal(sceneKey(press('l', { [m]: true })), null, m) // Cmd+L, Ctrl+T: the browser's
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(sceneKey(press('t', { target: { tagName } })), null, tagName) // the table's search box
  assert.equal(sceneKey(press('t', { target: { tagName: 'DIV', isContentEditable: true } })), null)
  assert.equal(sceneKey(press('t', { target: { tagName: 'BUTTON', isContentEditable: false } })), 'topo') // a focused toggle
})

test('weatherView: the top-down map\'s weather or the chase\'s, on a live sky only; History and a scenario get "Live only" instead', () => {
  const view = (o: Partial<Parameters<typeof weatherView>[0]>): ReturnType<typeof weatherView> =>
    weatherView({ wx: true, chasing: false, history: false, scenario: false, ...o })
  assert.deepEqual(view({}), { topDown: true, chase: false, liveOnly: false })
  assert.deepEqual(view({ chasing: true }), { topDown: false, chase: true, liveOnly: false })
  for (const chasing of [false, true]) {
    for (const [history, scenario] of [[true, false], [false, true], [true, true]]) {
      assert.deepEqual(view({ chasing, history, scenario }), { topDown: false, chase: false, liveOnly: true }, `${chasing ? 'chase' : 'top-down'}, history ${history}, scenario ${scenario}`)
      assert.deepEqual(view({ wx: false, chasing, history, scenario }), { topDown: false, chase: false, liveOnly: false }, 'switched off: none, and nothing to say')
    }
    assert.deepEqual(view({ wx: false, chasing }), { topDown: false, chase: false, liveOnly: false })
  }
})

test('weatherMenuOpens: the Weather panel opens when Weather is turned on in a live chase, not when a chase or a live view comes with it already on', () => {
  const opens = (o: Partial<Parameters<typeof weatherMenuOpens>[0]>): boolean =>
    weatherMenuOpens({ was: false, now: true, chasing: true, history: false, scenario: false, ...o })
  assert.equal(opens({}), true, 'switched on in a live chase (the Layers switch or the W key)')
  assert.equal(opens({ was: true }), false, 'on already: no change to answer')
  assert.equal(opens({ was: true, now: false }), false, 'switched off')
  assert.equal(opens({ now: false }), false)
  assert.equal(opens({ chasing: false }), false, 'top-down: that weather has no panel')
  assert.equal(opens({ history: true }), false, 'History: the weather is today\'s, none is drawn')
  assert.equal(opens({ scenario: true }), false)
  assert.equal(opens({ history: true, scenario: true }), false)
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

test('safeArea (the flight-data frame): the canvas minus its covers, each cut from the side that keeps the most room', () => {
  // 1400 × 900: the rail at the right, the flight card top-left, the play bar and two caption lines along the bottom.
  const rail = { x: 1324, y: 12, w: 64, h: 380 }
  const card = { x: 12, y: 12, w: 300, h: 420 }
  const bar = { x: 12, y: 824, w: 1300, h: 64 }
  const captions = { x: 12, y: 700, w: 1300, h: 112 }
  const hidden = { x: 0, y: 0, w: 0, h: 0 }
  assert.deepEqual(safeArea(1400, 900, [rail, card, bar, captions, hidden]), { x: 320, y: 8, w: 996, h: 684 })
  assert.deepEqual(safeArea(1400, 900, [rail]), { x: 8, y: 8, w: 1308, h: 884 }, 'live chase, no card: only the rail')
  assert.deepEqual(safeArea(1400, 900, []), { x: 8, y: 8, w: 1384, h: 884 })
  assert.deepEqual(safeArea(1400, 900, [{ x: 2000, y: 0, w: 50, h: 50 }]), { x: 8, y: 8, w: 1384, h: 884 }, 'off the canvas: ignored')
})

test('safeArea: a phone (375 × 812): the tab bar, the play bar and the captions all come off the bottom', () => {
  const tabs = { x: 0, y: 752, w: 375, h: 60 }
  const bar = { x: 0, y: 664, w: 375, h: 88 }
  const captions = { x: 8, y: 560, w: 359, h: 96 }
  assert.deepEqual(safeArea(375, 812, [tabs, bar, captions]), { x: 8, y: 8, w: 359, h: 544 })
})

test('scenarioBaseFor: the app base, or in development ?scenarioBase=/a/path/ (the harness demo); never another origin or ..', () => {
  assert.equal(scenarioBaseFor('?scenario=demo', '/', true), '/')
  assert.equal(scenarioBaseFor('?scenarioBase=/harness/fixtures/', '/', true), '/harness/fixtures/')
  assert.equal(scenarioBaseFor('?scenarioBase=/harness/fixtures/', '/', false), '/', 'a production build ignores it')
  for (const bad of ['//evil.test/', 'https://evil.test/', '/a/../b/', '/no-slash', 'harness/', '/a b/']) {
    assert.equal(scenarioBaseFor(`?scenarioBase=${encodeURIComponent(bad)}`, '/app/', true), '/app/', bad)
  }
})

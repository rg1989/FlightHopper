# WP-B-A — Browse & Detail Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the eight browse & detail packages to the app the user opens (user feedback #2). With nothing selected, the app shows a tar1090-style top-down street map: every aircraft is an icon turned to its track and coloured by altitude, with the aircraft table on the right and the altitude legend at the bottom. With an aircraft selected, the app keeps the chase camera and HUD and adds the detail panel on the left. The app stays fluid with 5,000 aircraft.

**Architecture:** `client/app.ts` is rewritten around two modes. `select(hex | null)` switches between them.
- **Browse** (`selected === null`): `enterBrowse` over the start airport (at start) or over the last chased position (after a chase). The street map is shown. `.fh-ui[data-mode=browse]` shows the table and the legend. The detail panel and the HUD hide themselves (they get `null`), and the model hides.
- **Chase** (`selected` set): `chaseCam.release()`, then `exitBrowse`. The street map is hidden. A new `TrackRegistry` is seeded with `fleet.newest(hex)`. `ChaseModel` and `ChaseCamera` (with WP-V4's mouse orbit, zoom and reset) work as before. The detail panel and the HUD show, and the table stays (collapsible). The legend hides through CSS. The fleet layer keeps drawing every aircraft and marks the selected one (1.4× and a ring; both give way to the model within 5 km of the camera).
- **Data split (the efficiency rule):** every view and chase reply goes into `Fleet.ingest(samples, info)`. Only the selected hex's samples, from both replies, go into the `TrackRegistry`. A reply for an earlier selection feeds only the fleet. The chase reply's `raw` and `info` are kept for the panel and reset at each selection. Until they arrive, the panel shows the fleet entry's `info`, so identity appears at once.
- **Frame** (`scene.preUpdate`): `fleet.entries(serverNow)` → `fleetLayer.update(all, selected, tableHover ?? mapHover)` → `table.update(all, entriesIn(all, viewRectangleDeg(viewer), onScreen, selected), selected)` → the selected state (`registry.get(hex).stateAt(tRender)`) → model, chase camera, HUD, `detail.update(s, raw, info)`, banner, bench. The fleet, the fleet layer and `entriesIn` (one reused array) allocate nothing per frame. `viewRectangleDeg` returns one small object. The table re-sorts at most once a second and the panel rewrites text at most four times a second; both throttle themselves.
- **View poll:** browse uses `browseCircle(viewRectangleDeg(viewer))`: the rectangle's centre to 0.01° (the ApiClient's view key) and the radius to its farthest corner, in 10 nm steps, 20–250 nm. Chase is unchanged: the chased aircraft (else the canvas centre), with the camera height in nm.
- **Selection:** a table row (`onSelect`), a click on an icon (`FleetLayer.pick`) or `?hex=`. `Esc` and the panel's × return to browse. Hover: a table row labels its aircraft on the map (`onHover` → `FleetLayer.update` hover). The mouse over an icon gives the same label and a pointer cursor; it picks at most every 100 ms, at the newest mouse position.
- **Lookups** are injected as the contracts ask: `flagOf(hex)` = `flagEmoji(countryOf(hex).iso2)` for the table; `lookupFor(hex, callsign)` = a copy of the country with its flag, plus `airlineOf(callsign)`, for the panel. `countryOf` returns shared frozen objects, so they are copied. There is one `PhotoCache` for the app's lifetime.
- **Attribution** adds `AIRLINES_CREDIT` ('Airline names: OpenFlights (ODbL)', required by ODbL), the OpenStreetMap map (ODbL) and planespotters.net photos. Cesium also shows the linked OpenStreetMap credit on the map while the street map is shown (tile policy), and the panel credits each photo ("Image © name", linked to its planespotters page).
- **`client/ui/layout.css`** places the overlays. The table and the credit box share one flex column on the right, so the table ends above the credits (this removes the overlap WP-B-U1 reported). The legend is centred in the space left of that column, 32 px up, above Cesium's credit line. The column ends 36 px up, above Cesium's fullscreen button. Chase hides the legend. The `?bench=1` overlay moves right of the panel. Phones (≤ 640 px) stack the column, legend, credits and HUD so nothing overlaps Cesium's three-line credit block. While chasing on a phone, the table hides.
- `VITE_MAP_URL` (optional) passes another tile server to `makeMapLayer`, as the OpenStreetMap tile policy asks.
- `?bench=1` also records User Timing measures `fh:frame`, `fh:fleet`, `fh:table` (each frame) and `fh:ingest` (each poll). Read them in DevTools or with `performance.getEntriesByName(name)`. PLAN §5.3's "`?heavy=1` bench doc" is Task 4 below: the heavy bench is the heavy replay plus `?bench=1`. No `?heavy` flag is needed, because the load comes from the server's data.
- `AircraftLayer` (WP-V2, one point per aircraft) is superseded by `FleetLayer` and removed with its test and harness.

**Tech Stack:** as PLAN.md. CesiumJS 1.145 (`ScreenSpaceEventHandler`, `Scene.pick` through `FleetLayer.pick`, `Camera.computeViewRectangle` through `viewRectangleDeg`), the browser User Timing API, and `node:test` with the `registerHooks` CSS stub (as before). No new dependencies.

**Wave:** B-A, after WP-B0 and all eight B-* packages (B-C1, B-C2, B-S1, B-V1, B-V2, B-V3, B-U1, B-U2). **Estimated:** 3 h.

**Validated:** 2026-09-22 in the integrated tree (WP-00 + 26 WPs + V4 Task 4 + B0 + all eight B-* packages), Node 25.2.1, TypeScript 7.0.2, on a MacBook Air M2.
- `node --test client/app.test.ts`: 9/9. `npx tsc --noEmit`: exit 0. `npm run check`: tsc clean, 604/604 (611 before, minus the 11 AircraftLayer tests, plus 4 new app tests). `vite build`: builds, and `layout.css` comes last in the CSS bundle.
- A script built this plan from the tree files, so every code block is byte-identical to the tested files.
- Replay from the plan alone, in an isolated copy of the tree as it was before this package (tsc clean, 611/611): Task 1 Step 2 failed 5 of 9 with the messages given, Step 5 passed 9/9 with tsc exit 0; Task 2's grep found nothing and `npm run check` passed 604/604; Task 3 wrote the same SHA-256 and counts, and the two scripts type-checked. The replayed tree then matched the integrated tree file for file (`diff -rq`, outside node_modules, data and dist).
- Mutations of `app.ts`: 8 tried and 7 caught (no antimeridian span, output array not reset, `keepHex` ignored, the shared country object passed through, no airline credit, a 300 nm cap, centre not rounded to the view key). The survivor dropped one of the four corner distances. It is equivalent because a lat/lon rectangle is symmetric about its centre meridian: its east and west corners at the same latitude are equally far away.
- **Gate GB, heavy replay** (Task 3's file: 4,948 aircraft, about 4,700 in the 250 nm circle at any time). The browser was the in-app Chrome (ANGLE Metal, Apple M2, DPR 1), with the server and Vite on their own ports.
  - Browse top-down at 1,100 km over LOWI, every aircraft in view (1440×900, 4,660 total, 4,600 on screen, 20 s): FPS p50 100.0 and p5 96.2 (this browser's rAF is capped at 100 Hz), frame p95 10.4 ms, max 11.1 ms, 0 long tasks. The app's own frame work (`fh:frame`) was p50 1.0 ms, p95 1.4 ms. `fh:fleet` (Fleet.entries + FleetLayer.update) was p50 0.9 ms, p95 1.2 ms. `fh:table` was p50 0.1 ms, **p95 0.2 ms**, max 1.6 ms (gate: ≤ 5 ms). `fh:ingest` (incremental) had p95 1.1 ms.
  - Frame capacity, measured as `viewer.render()` plus a 1-pixel `readPixels` GPU sync over 300 frames with the same view: p50 8.9 ms (112 fps), p95 10.4 ms (96 fps), max 17.2 ms.
  - 1024×768 with 4,668 on screen: FPS p50 100.0, p5 92.6, frame p95 10.8 ms, 0 long tasks; `fh:frame` p95 1.7 ms, `fh:table` p95 0.2 ms.
  - Worst case, a continuous pan (the camera moved 40 km/s, back and forth), so 12 of 15 view polls were new view keys with full replies (175–327 KB gzipped, 17–27 ms each in the browser): FPS p50 100.0, p5 92.6, frame max 11.1 ms, 0 long tasks, `fh:ingest` max 0.6 ms. The "snap the view centre" upgrade is therefore not needed now.
  - `/api/view` (`time-view.ts`, loopback, 250 nm): full reply (since=0, 4,663 aircraft, 378,640 B gzipped): median 14.3 ms, p90 17.3 ms, max 23.0 ms. Incremental at 1 Hz (313 samples, 20 KB): median 2.7 ms, p90 6.3 ms, max 29.4 ms (gate: ≤ 50 ms).
- **Gate GB, real recording** (`data/recordings/2026-09-22.jsonl`, 3 h of KSFO, LLBG and LOWI cells, copied without the recorder's unfinished last line):
  - Over KSFO, the table showed country flags: United States, Canada (ACA738, ACA756), Taiwan (CAL5176), the Philippines (PAL112), and none for the TIS-B address `~a59b0f`.
  - UAL643 (a126ed): "🇺🇸 United States", "United Airlines", N17317, B38M, squawk 1053, spatial, signal and FMS SEL rows. The photo request was first refused by planespotters' CORS (the intermittent refusal WP-B-U2 recorded). On the next selection the photo loaded: "Image © CharlieMike23", linked to planespotters photo 1914889 of N17317.
  - JBU416 (ad2095): "🇺🇸 United States", "JetBlue Airways", N945JT, A321, and the photo "Image © Eduardo Seijo" at the first request.
- **Checked by hand**, with screenshots:
  - The browse view over the Alps: the OpenStreetMap map, altitude-coloured icons, the table with counts, the legend above Cesium's credit line, and the credits under the table.
  - A table row click → chase at FL370 (map hidden, legend hidden, satellite imagery, the model, the panel with "Aegean Airlines", the HUD 16 px below the panel).
  - `Esc` → browse at 300 km over the last chased position, north-up, tilt locked, mouse input back.
  - Hover over an icon → "SWR56PY" label and a pointer cursor; a click on it → chase, and the panel showed identity 300 ms later.
  - The panel's × → browse. `?hex=b004d2` → chase from the start, with the 7700 squawk shown red as "7700 · general".
  - Hover over a table row → that aircraft's label on the map.
  - Layout at 1024×768, 1440×900, 375×812 and 375×667: no overlaps and no sideways scroll.
  - No console errors apart from 502s while the check server was restarting.
- **Network:** no request to any adsb.lol host (all runs used `ADSB_SOURCE=replay`, and routes are off). planespotters.net: 6 photo lookups by the panel (b00ebe, b00004, b004d2, a126ed twice, ad2095). OpenStreetMap tiles for the viewed areas. Ports 5173 and 8787 were not touched.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- This package creates, rewrites or removes only the files listed below. It reads every B-* package's files.
- Unit tests need no WebGL, no DOM and no network.
- Gate runs use `ADSB_SOURCE=replay`, so they send nothing to adsb.lol. If you switch to `adsblol`, stop the recorder first: only one process polls adsb.lol at a time.
- `data/recordings/synthetic-heavy.jsonl` (~86 MB) is gitignored. Never commit it; the generator is its source.

## Files owned by this package

| Path | Change |
|---|---|
| `client/app.ts` | rewritten: browse ↔ chase modes, the fleet/track split, lookups, layout wiring; new pure helpers `browseCircle`, `entriesIn`, `flagOf`, `lookupFor` |
| `client/app.test.ts` | rewritten: 9 tests (4 new) |
| `client/ui/layout.css` | new: where the overlays sit in browse, chase and on phones |
| `.planning/plans/assets/WP-B-A/gen-synthetic-heavy.ts` | new: deterministic heavy replay generator for Gate GB (its output is gitignored) |
| `.planning/plans/assets/WP-B-A/time-view.ts` | new: `/api/view` timing for Gate GB |
| `client/scene/aircraftLayer.ts`, `client/scene/aircraftLayer.test.ts`, `harness/aircraft-layer.html`, `harness/aircraft-layer.ts` | removed (superseded by WP-B-V1's `FleetLayer`) |

---

### Task 1: App modes, helpers and layout

**Files:**
- Modify: `client/app.test.ts`, `client/app.ts` (complete new contents below)
- Create: `client/ui/layout.css`
- Test: `client/app.test.ts`

**Interfaces:**
- Consumes:
  - B-C1: `countryOf(hex): { iso2; name } | null` and `flagEmoji(iso2): string`.
  - B-C2: `airlineOf(callsign): string | null` and `AIRLINES_CREDIT`.
  - B-S1: `ViewResponse.info` and `ChaseResponse.raw` / `ChaseResponse.info`.
  - B-V1: `new FleetLayer(viewer)` with `.update(entries, selectedHex, hoverHex)`, `.pick(windowPos)` and `.destroy()`; `mountLegend(root)`.
  - B-V2: `new Fleet()` with `.ingest(samples, info?)`, `.entries(tServerMs)`, `.get(hex)`, `.newest(hex)` and `.prune(tServerMs, maxAgeS)`.
  - B-V3: `enterBrowse(viewer, center, opts?)`, `exitBrowse(viewer)`, `viewRectangleDeg(viewer)`, `containsDeg(r, lat, lon)`, `RectDeg`, and `makeMapLayer(viewer, url?)`.
  - B-U1: `mountTable(root, { onSelect, onHover, flagOf })` with `.update(all, onScreen, selectedHex)` and `.destroy()`.
  - B-U2: `mountDetail(root, { onClose, photos, lookup })` with `.update(s, raw, info)` and `.destroy()`; `PhotoCache`; `Lookup`.
  - Existing: `ApiClient`, `TrackRegistry`, `RenderClock`, `ChaseCamera`, `ChaseModel`, `addRunways`, `createViewer`, `mountHud`, `mountBanner`, `mountAttribution`, `BenchRecorder`.
- Produces:
  - New: `browseCircle(r: RectDeg): { lat: number; lon: number; nm: number }`, `entriesIn(entries: readonly FleetEntry[], r: RectDeg | null, out: FleetEntry[], keepHex?: string | null): FleetEntry[]`, `flagOf(hex: string): string` and `lookupFor(hex: string, callsign: string | null): Lookup`.
  - Unchanged: `viewRadiusNm`, `placedHeightM`, `readParams`/`AppParams`, `statusShown`, and `startApp(root, cfg): Promise<{ stop(): void }>`. `client/main.ts` is unchanged.
  - Changed: `attributionFor(model)` returns 3 more lines.

- [ ] **Step 1: Write the failing tests** (replace the whole file)

File: `client/app.test.ts`
```ts
// client/app.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import type { StatusBrief } from '../shared/api.ts'
import { distanceNm } from '../shared/geo.ts'
import { countryOf } from '../shared/icaoCountry.ts'
import type { FleetEntry, ModelManifestEntry } from './types.ts'

// app.ts imports viewer.ts, the ui/ modules and layout.css, which import CSS for Vite. Node cannot load CSS, so this file
// loads every .css as an empty module. The hook lives only in this test's process: node --test runs each file in its own.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { attributionFor, browseCircle, entriesIn, flagOf, lookupFor, placedHeightM, readParams, statusShown, viewRadiusNm } = await import('./app.ts')

const entry = (hex: string, lat: number, lon: number): FleetEntry => ({
  hex, lat, lon, hM: 0, altFt: null, onGround: false, trackDeg: null, gsKt: null, vsFpm: null, ageS: 0, quality: 'adsb2', info: null,
})

test('view radius follows the camera height, in 10 nm steps, clamped to 20–250 nm', () => {
  assert.equal(viewRadiusNm(0), 20)
  assert.equal(viewRadiusNm(150), 20) // chasing on the runway
  assert.equal(viewRadiusNm(37_040), 20) // 20 nm up
  assert.equal(viewRadiusNm(37_041), 30)
  assert.equal(viewRadiusNm(100_000), 60) // 54 nm → next step
  assert.equal(viewRadiusNm(20_000_000), 250) // whole-Earth view
  assert.equal(viewRadiusNm(Number.NaN), 250)
})

test('browse poll circle: centred on the visible rectangle, covering all of it, in 10 nm steps within 20–250 nm', () => {
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
  assert.deepEqual(browseCircle({ west: -180, south: -90, east: 180, north: 90 }), { lat: 0, lon: 0, nm: 250 }) // capped
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test client/app.test.ts`
Expected: FAIL. `ℹ tests 9`, `ℹ pass 4`, `ℹ fail 5`. The two browse-circle tests fail with `TypeError: browseCircle is not a function`, the on-screen test with `TypeError: entriesIn is not a function`, the lookups test with `TypeError: flagOf is not a function`, and the attribution test because its lines have no OpenFlights credit.

- [ ] **Step 3: Write the layout stylesheet**

```css
/* client/ui/layout.css */
/* Where the overlays sit (WP-B-A). client/app.ts builds:
     .fh-ui[data-mode=browse|chase]
       .fh-right        the aircraft table (table.css) above the credit box (ui.css), one column on the right
       .fh-legend-root  the altitude legend (legend.ts), bottom centre of the space left of that column
       .fh-bench        the ?bench=1 overlay (bench/overlay.ts)
       + the HUD and banner (ui.css) and the detail panel (detail.css), which place themselves.
   Browse shows the table and the legend. Chase shows the detail panel top-left and the HUD bottom-left (the panel stops
   236px above the bottom, so they never meet) and keeps the table. Every box clears Cesium's credit line (bottom-left)
   and its fullscreen button (29px, bottom-right). Loaded after the modules' own CSS; the selectors are also more
   specific, so the order does not matter. */

.fh-right {
  position: absolute;
  z-index: 10;
  top: 8px;
  right: 8px;
  bottom: 36px;
  width: min(420px, calc(100vw - 16px));
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  pointer-events: none; /* the empty part of the column stays map */
}

/* The table fills the column above the credits instead of the whole height (table.css places it alone). */
.fh-right > .fh-table {
  position: relative;
  top: auto;
  right: auto;
  bottom: auto;
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
  pointer-events: auto;
}

.fh-right > .fh-table.fh-collapsed {
  flex: none;
  width: auto;
}

.fh-right > .fh-attribution {
  position: relative;
  right: auto;
  bottom: auto;
  flex: none;
  margin-top: auto; /* stays at the bottom when the table is collapsed */
}

.fh-legend-root {
  position: absolute;
  z-index: 9;
  left: 8px;
  right: calc(min(420px, 100vw - 16px) + 16px);
  bottom: 32px;
  display: flex;
  justify-content: center;
  pointer-events: none;
}

.fh-ui[data-mode='chase'] .fh-legend-root {
  display: none;
}

/* The bench overlay places itself top-left with inline styles, where the detail panel is: move it right of the panel. */
.fh-bench > pre {
  left: 316px !important;
}

/* Phones: Cesium's credit block wraps to about three lines (~64px), so the legend sits 72px up and the column (table
   above the credits, full width: collapse the table to see the map) ends above the legend. The credits use the full
   width (half the lines, ~124px). Chasing (no legend), the panel (top, detail.css) and the HUD need the screen: the table
   hides, the credits drop to the legend's place, the HUD sits above them and the panel stops above the HUD. */
@media (max-width: 640px) {
  .fh-right {
    bottom: 108px;
  }

  .fh-right > .fh-attribution {
    max-width: none;
  }

  .fh-legend-root {
    right: 8px;
    bottom: 72px;
  }

  .fh-ui[data-mode='chase'] .fh-right {
    bottom: 72px;
  }

  .fh-ui[data-mode='chase'] .fh-right > .fh-table {
    display: none;
  }

  .fh-ui[data-mode='chase'] .fh-hud {
    bottom: 204px;
  }

  .fh-ui[data-mode='chase'] .fh-detail {
    max-height: max(120px, calc(100% - 392px));
  }
}
```

- [ ] **Step 4: Write the app** (replace the whole file)

File: `client/app.ts`
```ts
// client/app.ts
// The client app: one Cesium viewer in two modes, fed by 1 Hz polls of the server.
// - Browse (nothing selected): a north-up, top-down street map. Every aircraft is an icon turned to its track and
//   coloured by altitude, with the table of the aircraft on screen on the right and the altitude legend at the bottom.
// - Chase (an aircraft selected by a table row, a click on its icon or ?hex=): the 3-D model and the chase camera over
//   the satellite imagery, the detail panel on the left and the HUD. The other aircraft stay on screen as icons.
// Every aircraft goes into the Fleet (newest sample, dead-reckoned: cheap enough for thousands a frame). Only the
// selected one also goes into the TrackRegistry, whose full estimator the chase camera follows.
// This file only wires the parts in scene/, track/, browse/, ui/, bench/ and api.ts together.
import { Cartesian2, Cartesian3, Cartographic, Math as CesiumMath, ScreenSpaceEventHandler, ScreenSpaceEventType } from 'cesium'
import type { Viewer } from 'cesium'
import { AIRLINES_CREDIT, airlineOf } from '../shared/airlines.ts'
import type { Airport } from '../shared/airports.ts'
import type { ChaseResponse, StatusBrief } from '../shared/api.ts'
import { distanceNm } from '../shared/geo.ts'
import { countryOf, flagEmoji } from '../shared/icaoCountry.ts'
import type { AircraftInfo } from '../shared/info.ts'
import type { ReadsbAircraft } from '../shared/types.ts'
import { ApiClient } from './api.ts'
import { BenchRecorder } from './bench/overlay.ts'
import { Fleet } from './browse/fleet.ts'
import { containsDeg, enterBrowse, exitBrowse, viewRectangleDeg } from './scene/browseCamera.ts'
import type { RectDeg } from './scene/browseCamera.ts'
import { ChaseCamera } from './scene/chaseCamera.ts'
import { FleetLayer } from './scene/fleetLayer.ts'
import { makeMapLayer } from './scene/mapLayer.ts'
import { ChaseModel } from './scene/model.ts'
import { addRunways } from './scene/runways.ts'
import { createViewer } from './scene/viewer.ts'
import { MIN_DELAY_S, RenderClock } from './track/delay.ts'
import { TrackRegistry } from './track/registry.ts'
import type { ClientConfig, FleetEntry, ModelManifest, ModelManifestEntry, RenderState } from './types.ts'
import { mountAttribution, mountBanner } from './ui/banner.ts'
import { mountDetail } from './ui/detail.ts'
import type { Lookup } from './ui/detail.ts'
import { mountHud } from './ui/hud.ts'
import { mountLegend } from './ui/legend.ts'
import { PhotoCache } from './ui/photo.ts'
import { mountTable } from './ui/table.ts'
import './ui/layout.css'

const POLL_MS = 1000 // view and chase both poll at 1 Hz; TrackRegistry's pollPeriodS says the same
const PRUNE_AGE_S = 60 // forget an aircraft one minute after its newest sample (FleetLayer hides it at that age too)
const FAILS_DOWN = 3 // failed polls in a row before the banner reports it
const START_HEIGHT_M = 60_000 // ?hex= start: straight down on the hero airport until the chase camera takes over
const MIN_VIEW_NM = 20
const MAX_VIEW_NM = 250 // the server's cap: it polls an area source (adsb.lol) out to this radius
const HOVER_PICK_MS = 100 // at most ten hover picks a second while the mouse moves (each pick is a small render pass)
const HEX = /^~?[0-9a-f]{6}$/
// Until the first reply. Nothing is drawn before it, so the source named here is never shown.
const NO_STATUS: StatusBrief = { source: 'adsblol', degraded: null, cellPeriodP95S: null, chasePeriodP95S: null }
const NO_ENTRIES: readonly FleetEntry[] = []

/** Radius in whole 10 nm steps (so the ApiClient's per-view `since` key survives small changes), clamped to 20–250 nm. */
function viewNm(nm: number): number {
  const r = Math.ceil(nm / 10) * 10
  return Number.isFinite(r) ? Math.min(MAX_VIEW_NM, Math.max(MIN_VIEW_NM, r)) : MAX_VIEW_NM
}

/**
 * Radius of the chase view poll: the camera height in nm (a top-down view shows about ±0.6 h), in 10 nm steps, 20–250 nm.
 * ponytail: a tilted camera sees further than its height; the far part of such a view stays empty until the user looks
 * down. Upgrade: size the circle from the frustum's ground footprint (browseCircle does, for the top-down view).
 */
export function viewRadiusNm(cameraHeightM: number): number {
  return viewNm(cameraHeightM / 1852)
}

const round2 = (deg: number): number => Math.round(deg * 100) / 100
const wrap180 = (lon: number): number => ((((lon + 180) % 360) + 360) % 360) - 180

/**
 * The browse view poll: the circle around the visible rectangle, centred on it (to 0.01°, the ApiClient's key) and
 * reaching its farthest corner (a lat/lon rectangle's farthest point from inside it is a corner), 20–250 nm.
 * A view wider than 500 nm gets the 250 nm around its centre. A rectangle with west > east spans the antimeridian.
 * ponytail: every pan moves the centre, so the first poll after it is a new view key and a full (since=0) reply
 * (~200 KB gzipped for 5,000 aircraft). Upgrade: snap the centre to a grid so small pans keep their key.
 */
export function browseCircle(r: RectDeg): { lat: number; lon: number; nm: number } {
  const spanDeg = r.west <= r.east ? r.east - r.west : r.east + 360 - r.west
  const lat = round2((r.south + r.north) / 2)
  const lon = round2(wrap180(r.west + spanDeg / 2))
  const farNm = Math.max(
    distanceNm(lat, lon, r.south, r.west),
    distanceNm(lat, lon, r.south, r.east),
    distanceNm(lat, lon, r.north, r.west),
    distanceNm(lat, lon, r.north, r.east),
  )
  return { lat, lon, nm: viewNm(farNm) }
}

/**
 * The entries inside r (r null: the globe is out of view), plus the one with keepHex, written into out, which is
 * returned. Allocates nothing. keepHex is the selected aircraft: chasing, it flies in front of the camera but above the
 * ground rectangle the camera sees, which starts beyond it.
 */
export function entriesIn(entries: readonly FleetEntry[], r: RectDeg | null, out: FleetEntry[], keepHex: string | null = null): FleetEntry[] {
  out.length = 0
  if (r === null && keepHex === null) return out
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e.hex === keepHex || (r !== null && containsDeg(r, e.lat, e.lon))) out.push(e)
  }
  return out
}

/** Flag emoji of the country the ICAO address is allocated to; '' when none (non-ICAO '~' address, unallocated block). */
export function flagOf(hex: string): string {
  const c = countryOf(hex)
  return c === null ? '' : flagEmoji(c.iso2)
}

/** Country (from the address) and airline (from the callsign) for the detail panel. countryOf's object is shared: copied. */
export function lookupFor(hex: string, callsign: string | null): Lookup {
  const c = countryOf(hex)
  return { country: c === null ? null : { iso2: c.iso2, name: c.name, flag: flagEmoji(c.iso2) }, airline: airlineOf(callsign) }
}

/**
 * Height for the chased model and camera. hM is the wheels' height (see modelMatrixFor). On the ground the wheels sit on
 * the loaded terrain; in the air they never go below it. terrainM null = tile not loaded yet: keep the estimate.
 * ponytail: terrain, not the runway plane; M4's geometric touchdown replaces this clamp.
 */
export function placedHeightM(hM: number, onGround: boolean, terrainM: number | null): number {
  if (terrainM === null) return hM
  return onGround ? terrainM : Math.max(hM, terrainM)
}

export interface AppParams {
  hex: string | null // ?hex=a1b2c3: chase this aircraft from the start (G3; the detail panel's "Copy link")
  bench: boolean // ?bench=1: bench overlay and User Timing measures, 'b' downloads the report
  airport: string | null // ?airport=LLBG: first view over this hero (default: the first in heroes.json)
}

export function readParams(search: string): AppParams {
  const q = new URLSearchParams(search)
  const hex = (q.get('hex') ?? '').trim().toLowerCase()
  const airport = (q.get('airport') ?? '').trim().toUpperCase()
  return { hex: HEX.test(hex) ? hex : null, bench: q.get('bench') === '1', airport: airport === '' ? null : airport }
}

/**
 * Credit lines for the attribution box. mountAttribution adds "Not for navigation"; Cesium shows the terrain, imagery and
 * street-map credits on the map itself (the OpenStreetMap one linked, as its tile policy asks). The detail panel credits
 * each photo ("Image © name", linked to its page on planespotters.net).
 */
export function attributionFor(model: ModelManifestEntry | null): string[] {
  const lines = [
    'Flight data © adsb.lol contributors, ODbL 1.0',
    'Airports: OurAirports (public domain)',
    AIRLINES_CREDIT,
    'Map: © OpenStreetMap contributors, ODbL',
    'Photos: planespotters.net, © each photographer',
  ]
  // Manifest licences read "<SPDX id>: <note>"; the id is enough on screen.
  if (model) lines.push(`3D model: ${model.author}, ${model.license.split(':')[0].trim()}`)
  return lines
}

/** The server's status, except that FAILS_DOWN failed polls in a row mean we have no live data at all. */
export function statusShown(status: StatusBrief, failedPolls: number): StatusBrief {
  return failedPolls >= FAILS_DOWN ? { ...status, degraded: 'upstream-down' } : status
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return (await res.json()) as T
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function div(className: string, parent: HTMLElement): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className
  parent.append(el)
  return el
}

/**
 * Builds the viewer in root and runs the app until stop(). Loops:
 * - every second: view(browse: the circle around the visible map; chase: around the chased aircraft) and, while an
 *   aircraft is selected, chase(hex). Every sample goes into the Fleet; the selected aircraft's samples also go into the
 *   TrackRegistry, between frames, so re-join blends stay continuous.
 * - every frame (scene.preUpdate: after Cesium applies mouse input to the camera, before it updates primitives and
 *   renders, so camera and model move in the same frame): Fleet → FleetLayer and table (all aircraft, dead-reckoned
 *   to server now); RenderClock → the selected aircraft's state → model, chase camera, HUD, detail panel, banner, bench.
 * A table row or a click on an icon selects; Esc or the panel's × goes back to browse over the last chased position.
 * Runways and the model are optional: if their files fail to load, the app runs without them. createViewer failing
 * (terrain unreachable) rejects.
 */
export async function startApp(root: HTMLElement, cfg: ClientConfig): Promise<{ stop(): void }> {
  const params = readParams(location.search)
  const base = import.meta.env.BASE_URL
  const [viewer, airports, manifest] = await Promise.all([
    createViewer(root, cfg),
    getJson<Airport[]>(`${base}airports/heroes.json`).catch((e: unknown): Airport[] => {
      console.warn('FlightHopper: no runways:', e)
      return []
    }),
    getJson<ModelManifest>(`${base}models/manifest.json`).catch((e: unknown): null => {
      console.warn('FlightHopper: no model manifest:', e)
      return null
    }),
  ])
  const entry = manifest?.models.find((m) => m.id === manifest.default) ?? null
  const model = entry
    ? await ChaseModel.load(viewer, entry).catch((e: unknown): null => {
        console.warn('FlightHopper: chase model not loaded:', e)
        return null
      })
    : null

  let selected: string | null = params.hex // ?hex= is chased from the start; the camera engages at its first state
  let chased: RenderState | null = null // the selected aircraft as drawn in the last frame that had it
  let chaseRaw: ReadsbAircraft | null = null // newest full upstream object and info of the selected aircraft
  let chaseInfo: AircraftInfo | null = null
  let tableHover: string | null = null
  let mapHover: string | null = null
  let status = NO_STATUS
  let failedPolls = 0
  let stopped = false
  let lastFrameMs: number | null = null
  const carto = new Cartographic()
  const onScreen: FleetEntry[] = [] // reused every frame

  // Overlays live in one element so stop() removes them together (mountAttribution returns no handle). layout.css
  // places them; data-mode switches what browse and chase show.
  const ui = div('fh-ui', root)
  ui.dataset.mode = selected === null ? 'browse' : 'chase'
  const right = div('fh-right', ui) // the table above the credits
  const hud = mountHud(ui)
  const banner = mountBanner(ui)
  const detail = mountDetail(ui, { onClose: () => select(null), photos: new PhotoCache(), lookup: lookupFor })
  const table = mountTable(right, { onSelect: (hex) => select(hex), onHover: (hex) => (tableHover = hex), flagOf })
  mountAttribution(right, attributionFor(entry))
  const legend = mountLegend(div('fh-legend-root', ui))
  const runways = addRunways(viewer, airports)
  // VITE_MAP_URL: another tile server ({z}/{x}/{y}.png is appended), as the OpenStreetMap tile policy asks to allow.
  const mapUrl: string | undefined = import.meta.env.VITE_MAP_URL?.trim() || undefined
  const map = makeMapLayer(viewer, mapUrl)
  const fleetLayer = new FleetLayer(viewer)
  const chaseCam = new ChaseCamera(viewer)
  const api = new ApiClient(cfg.apiBase)
  const fleet = new Fleet()
  let registry = new TrackRegistry({ pollPeriodS: POLL_MS / 1000 })
  const clock = new RenderClock(MIN_DELAY_S)
  const bench = params.bench ? new BenchRecorder(viewer, { label: params.hex ?? 'browse' }) : null
  bench?.mountOverlay(div('fh-bench', ui))
  // ?bench=1: User Timing measures fh:frame, fh:fleet, fh:table (each frame) and fh:ingest (each poll), read with
  // performance.getEntriesByName(name) or in DevTools. ponytail: entries pile up (~200 per second) until
  // performance.clearMeasures(); fine for bench runs of minutes.
  const measure = bench === null ? null : (name: string, startMs: number): void => void performance.measure(name, { start: startMs })
  ;(window as unknown as { viewer?: Viewer }).viewer = viewer // console access for debugging and G3, as in WP-00

  const home = airports.find((a) => a.ident === params.airport) ?? airports[0]
  const homeCenter = home ? { lat: home.lat, lon: home.lon } : null
  if (selected === null) enterBrowse(viewer, homeCenter, { flyS: 0 })
  else {
    map.show = false
    if (home) viewer.camera.setView({ destination: Cartesian3.fromDegrees(home.lon, home.lat, START_HEIGHT_M) })
  }

  /** Browse ↔ chase. The camera leaves browse at once and engages behind the aircraft at its first state. */
  function select(hex: string | null): void {
    if (hex === selected) return
    const last = chased
    chaseCam.release() // hands the mouse back to Cesium's controls; the next chase starts behind its aircraft
    selected = hex
    chased = null
    chaseRaw = null
    chaseInfo = null
    // Only the selected aircraft is estimated: a fresh registry, seeded with the newest sample the fleet has of it.
    registry = new TrackRegistry({ pollPeriodS: POLL_MS / 1000 })
    if (hex !== null) {
      const seed = fleet.newest(hex)
      if (seed) registry.ingest([seed])
      exitBrowse(viewer) // restores tilt and zoom limits; nothing when already chasing
      map.show = false
    } else {
      map.show = true
      enterBrowse(viewer, last) // over the last chased position, else where the camera is
    }
    ui.dataset.mode = hex === null ? 'browse' : 'chase'
  }

  function frame(): void {
    const now = performance.now()
    const dtS = lastFrameMs === null ? 0 : Math.min(1, (now - lastFrameMs) / 1000)
    lastFrameMs = now
    const shown = statusShown(status, failedPolls)
    let all = NO_ENTRIES
    let s: RenderState | null = null
    if (api.ready) {
      const tServerMs = api.serverNowMs()
      const tRenderMs = clock.tick(tServerMs, registry.delayTargetS(selected), dtS)
      // ponytail: the fleet is drawn at server now, the chased aircraft at the delayed render time (≥ 3 s earlier), so
      // traffic around it runs a few seconds ahead of it. Upgrade: draw the fleet at tRenderMs, which needs Fleet to
      // interpolate between samples instead of only dead-reckoning past the newest.
      all = fleet.entries(tServerMs)
      if (selected !== null) s = registry.get(selected)?.stateAt(tRenderMs) ?? null
    }
    fleetLayer.update(all, selected, tableHover ?? mapHover)
    const tTable = measure === null ? 0 : performance.now()
    measure?.('fh:fleet', now)
    table.update(all, entriesIn(all, viewRectangleDeg(viewer), onScreen, selected), selected) // re-sorts ≤ 1 Hz itself
    measure?.('fh:table', tTable)
    let clearanceM: number | null = null
    if (s !== null) {
      const terrainM = viewer.scene.globe.getHeight(Cartographic.fromDegrees(s.lon, s.lat, 0, carto)) ?? null
      const placed: RenderState = { ...s, hM: placedHeightM(s.hM, s.onGround, terrainM) }
      model?.update(placed)
      clearanceM = chaseCam.update(placed, dtS).clearanceM
      chased = placed
    }
    // No state (before the first samples, pruned, or a gap > 2 min): the model goes; the camera stays put.
    if (model) model.show = s !== null
    hud.update(s, shown)
    // The panel shows as soon as something is known: identity from the fleet before the chase reply and first state.
    detail.update(s, chaseRaw, chaseInfo ?? (selected === null ? null : (fleet.get(selected)?.info ?? null))) // ≤ 4 Hz
    banner.update(shown, s)
    bench?.frame(s, clearanceM)
    measure?.('fh:frame', now)
  }
  const removeFrame = viewer.scene.preUpdate.addEventListener(frame)

  /** Centre and radius of the view poll: browse, around the visible map; else the chased aircraft, else the globe point at the canvas centre, else below the camera. */
  function viewCircle(): { lat: number; lon: number; nm: number } {
    if (selected === null) {
      const r = viewRectangleDeg(viewer)
      if (r !== null) return browseCircle(r)
    }
    const cam = viewer.camera.positionCartographic
    const nm = viewRadiusNm(cam.height)
    const round = (deg: number): number => Math.round(deg * 1e4) / 1e4
    if (chased !== null) return { lat: round(chased.lat), lon: round(chased.lon), nm }
    const c = viewer.canvas
    const hit = viewer.camera.pickEllipsoid(new Cartesian2(c.clientWidth / 2, c.clientHeight / 2))
    const g = (hit && Cartographic.fromCartesian(hit)) ?? cam
    return { lat: round(CesiumMath.toDegrees(g.latitude)), lon: round(CesiumMath.toDegrees(g.longitude)), nm }
  }

  async function poll(): Promise<void> {
    const hex = selected
    const v = viewCircle()
    const noChase: Promise<ChaseResponse | null> = Promise.resolve(null)
    const [view, chase] = await Promise.allSettled([api.view(v.lat, v.lon, v.nm), hex === null ? noChase : api.chase(hex)])
    if (stopped) return
    const t0 = measure === null ? 0 : performance.now()
    const current = hex !== null && hex === selected // a reply for an earlier selection only feeds the fleet
    let ok = false
    if (view.status === 'fulfilled') {
      const r = view.value
      fleet.ingest(r.samples, r.info)
      if (current) registry.ingest(r.samples.filter((x) => x.hex === hex))
      status = r.status
      ok = true
    }
    if (chase.status === 'fulfilled' && chase.value !== null) {
      const r = chase.value
      fleet.ingest(r.samples, r.info ? [r.info] : undefined)
      if (current) {
        registry.ingest(r.samples)
        chaseRaw = r.raw ?? chaseRaw
        chaseInfo = r.info ?? chaseInfo
      }
      status = r.status
      ok = true
    }
    measure?.('fh:ingest', t0)
    if (ok) failedPolls = 0
    else if (failedPolls++ === 0) console.warn('FlightHopper: poll failed:', (view as PromiseRejectedResult).reason)
    if (api.ready) {
      const t = api.serverNowMs()
      fleet.prune(t, PRUNE_AGE_S)
      registry.prune(t, PRUNE_AGE_S)
    }
  }

  void (async () => {
    while (!stopped) {
      const t0 = performance.now()
      await poll().catch((e: unknown) => console.error('FlightHopper: poll crashed:', e))
      await sleep(Math.max(0, POLL_MS - (performance.now() - t0)))
    }
  })()

  // Cesium's default double-click tracks an entity (the runway markers are entities), which would fight the chase camera.
  viewer.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
  const mouse = new ScreenSpaceEventHandler(viewer.scene.canvas)
  mouse.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
    const hex = fleetLayer.pick(e.position)
    if (hex !== null) select(hex)
  }, ScreenSpaceEventType.LEFT_CLICK)
  // Hover over an icon: its callsign label and a pointer cursor. Picks at most every HOVER_PICK_MS, at the newest position.
  const mousePos = new Cartesian2()
  let hoverTimer: ReturnType<typeof setTimeout> | null = null
  let lastPickMs = -Infinity
  const pickHover = (): void => {
    hoverTimer = null
    lastPickMs = performance.now()
    const hex = fleetLayer.pick(mousePos)
    if (hex === mapHover) return
    mapHover = hex
    viewer.canvas.style.cursor = hex === null ? '' : 'pointer'
  }
  mouse.setInputAction((m: ScreenSpaceEventHandler.MotionEvent) => {
    Cartesian2.clone(m.endPosition, mousePos)
    hoverTimer ??= setTimeout(pickHover, Math.max(0, lastPickMs + HOVER_PICK_MS - performance.now()))
  }, ScreenSpaceEventType.MOUSE_MOVE)
  const onLeave = (): void => {
    if (hoverTimer !== null) clearTimeout(hoverTimer)
    hoverTimer = null
    mapHover = null
    viewer.canvas.style.cursor = ''
  }
  viewer.canvas.addEventListener('pointerleave', onLeave) // onto the table or panel, or out of the window
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') select(null)
    else if ((e.key === 'b' || e.key === 'B') && bench) bench.download()
  }
  window.addEventListener('keydown', onKey)

  return {
    stop(): void {
      if (stopped) return
      stopped = true
      removeFrame()
      window.removeEventListener('keydown', onKey)
      viewer.canvas.removeEventListener('pointerleave', onLeave)
      if (hoverTimer !== null) clearTimeout(hoverTimer)
      mouse.destroy()
      bench?.destroy()
      hud.destroy()
      banner.destroy()
      detail.destroy()
      table.destroy()
      legend.destroy()
      ui.remove()
      chaseCam.release()
      exitBrowse(viewer)
      model?.destroy()
      fleetLayer.destroy()
      map.destroy()
      runways.destroy()
      viewer.destroy()
      delete (window as unknown as { viewer?: Viewer }).viewer
    },
  }
}
```

- [ ] **Step 5: Run them to verify they pass, and type-check**

Run: `node --test client/app.test.ts`
Expected: PASS. `ℹ tests 9`, `ℹ pass 9`, `ℹ fail 0`.

Run: `npx tsc --noEmit`
Expected: no output, exit 0. (`AircraftLayer` still exists until Task 2, but nothing imports it any more.)

- [ ] **Step 6: Commit**

```bash
git add client/app.ts client/app.test.ts client/ui/layout.css
git commit -m "feat(client): browse and chase modes with the fleet, table, legend and detail panel" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Remove the superseded aircraft layer

**Files:**
- Remove: `client/scene/aircraftLayer.ts`, `client/scene/aircraftLayer.test.ts`, `harness/aircraft-layer.html`, `harness/aircraft-layer.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. `FleetLayer` (WP-B-V1) draws every aircraft now, and `harness/fleet-layer.html` replaces the old harness.

- [ ] **Step 1: Remove the files**

```bash
git rm client/scene/aircraftLayer.ts client/scene/aircraftLayer.test.ts harness/aircraft-layer.html harness/aircraft-layer.ts
```

- [ ] **Step 2: Check that nothing refers to them**

Run: `grep -rn -e aircraftLayer -e aircraft-layer -e AircraftLayer client server shared tools harness index.html vite.config.ts`
Expected: no output (exit status 1).

- [ ] **Step 3: Full check**

Run: `npm run check`
Expected: tsc prints nothing. In the integrated tree: `ℹ tests 604`, `ℹ pass 604`, `ℹ fail 0` (611 before this package, minus the 11 AircraftLayer tests, plus the 4 new app tests).

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(client): remove AircraftLayer, superseded by FleetLayer" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Heavy synthetic replay and view timing (Gate GB tools)

**Files:**
- Create: `.planning/plans/assets/WP-B-A/gen-synthetic-heavy.ts`, `.planning/plans/assets/WP-B-A/time-view.ts`
- Output (gitignored, not committed): `data/recordings/synthetic-heavy.jsonl`

**Interfaces:**
- Consumes: `bearingDeg`, `destination`, `distanceNm` (WP-00 `shared/geo.ts`) and `geoidN` (WP-00 `shared/geoid.ts`). It writes the `RecordLine` format (WP-00 `server/recording.ts`) with adsb.lol v2 bodies (`ac`, `ctime`, `msg`, `now`, `ptime`, `total`), which `makeReplay` (S2) reads through `REPLAY_FILES`. `time-view.ts` reads `GET /api/view` (A1, B-S1).
- Produces: a 5-minute replay of 4,948 invented aircraft, and a timing report.

What the generator models:
- **Where:** 5,000 aircraft (address `b00000`–`b01387`) start within 240 nm of LOWI (47.2602, 11.344), the hero airport in central Europe. The emulated `/v2/point` query is 250 nm, so aircraft that fly out of it leave the recording, like real ones. About 4,700 are in each poll.
- **Mix:** 542 on the ground at 24 real airports (parked, or taxiing at 8–20 kt in slow turns); 828 departures (2–45 nm out, climbing 1,500–3,200 fpm to FL240–FL370); 935 arrivals (15–110 nm out, homing on the airport down a 3° path and slowing to 140–250 kt); 2,032 airliners in cruise (semicircular flight levels FL280–FL410, 400–520 kt, 8 % changing level); 58 business jets; 14 military (dbFlags 1); 397 light aircraft (2,000–10,500 ft, 40 % turning); 194 helicopters. Altitudes run from the ground to 41,000 ft.
- **Identity:** real ICAO airline designators, weighted to central European traffic, with invented flight numbers (`DLH1234`, `EZY84TL`). Their types match the airlines' fleets. Categories follow DO-260B (A1–A7). The squawks are invented octal codes; light aircraft and helicopters squawk 7000. Two aircraft squawk emergencies (7700 "general", 7600 "nordo"). General aviation, helicopters and business jets use invalid N-numbers (`N0…`). There are no registrations.
- **Signal and air data:** 97 % ADS-B v2, some v0 and MLAT. 85 % of the airliners send air data: IAS, TAS and Mach from an ISA model, wind 12–78 kt, OAT and TAT, selected altitude and heading, and nav modes. RSSI falls with distance. Positions are 0.1–2.5 s old (MLAT 0.5–4 s, parked 1–9 s). 5 % of the aircraft appear during the recording and 5 % leave it.
- **Deterministic:** a fixed epoch and an integer hash; there is no randomness. Every run writes the same bytes.
- **Nothing is a real flight:** block B00000–BFFFFF is allocated to no State (ICAO Annex 10 Vol III Table 9-1), so the app shows no country for these aircraft. Airport positions and elevations come from OurAirports (public domain). The airline designators are public ICAO codes; the names shown come from B-C2's OpenFlights data (ODbL).

- [ ] **Step 1: Write the generator**

```ts
// .planning/plans/assets/WP-B-A/gen-synthetic-heavy.ts
// Heavy synthetic replay for Gate GB: 5,000 invented aircraft within 240 nm of Innsbruck (LOWI, the hero airport in
// central Europe), 26 adsb.lol-style /v2/point polls 12 s apart (5 min), as RecordLine JSONL. Run from the repository root:
//   node .planning/plans/assets/WP-B-A/gen-synthetic-heavy.ts [out]      (default data/recordings/synthetic-heavy.jsonl)
//   ADSB_SOURCE=replay REPLAY_FILES=data/recordings/synthetic-heavy.jsonl RECORD_DIR= npm run server
// data/recordings/ is gitignored: the output (~80 MB) is never committed; this script is its source.
// Deterministic: a fixed epoch and an integer hash instead of randomness, so every run writes the same bytes.
// Nothing here is a real flight. Every address is in B00000–B01387, a block ICAO Annex 10 Vol III Table 9-1 allocates to
// no State (the app shows no country for them); there are no registrations; general aviation and helicopters use
// invalid N-numbers (N0…). Airliners use real ICAO airline designators with invented flight numbers, so the table and
// the detail panel have airline names to show. Airport positions and elevations: OurAirports (public domain).
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { bearingDeg, destination, distanceNm } from '../../../../shared/geo.ts'
import { geoidN } from '../../../../shared/geoid.ts'

const T0_MS = Date.UTC(2026, 8, 22, 12, 0, 0)
const POLLS = 26 // t = 0, 12, …, 300 s
const PERIOD_S = 12
const N = 5000
const CENTER = { lat: 47.260201, lon: 11.344 } // LOWI, as in public/airports/heroes.json
const PLACE_NM = 240 // aircraft start within this distance of the centre
const QUERY_NM = 250 // the emulated /v2/point radius: aircraft further out are not in the poll
const HEX0 = 0xb00000
const T_FIRST = -12 // s: integrate from before the first poll (a position is up to 9 s old)
const STEPS = (POLLS - 1) * PERIOD_S - T_FIRST + 2 // one state per second
const OUT = process.argv[2] ?? 'data/recordings/synthetic-heavy.jsonl'

// ---- deterministic values ------------------------------------------------------------------------------------------

/** A value in [0, 1) for (aircraft i, key k): an integer hash (murmur3-style finaliser), no randomness. */
function u(i: number, k: number): number {
  let h = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca77)
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d)
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b)
  h ^= h >>> 16
  return (h >>> 0) / 2 ** 32
}
const between = (i: number, k: number, lo: number, hi: number): number => lo + (hi - lo) * u(i, k)
const pick = <T>(xs: readonly T[], i: number, k: number): T => xs[Math.floor(u(i, k) * xs.length)]
function weighted<T>(xs: readonly (readonly [T, number])[], i: number, k: number): T {
  let total = 0
  for (const [, w] of xs) total += w
  let r = u(i, k) * total
  for (const [x, w] of xs) if ((r -= w) < 0) return x
  return xs[xs.length - 1][0]
}
const wrap360 = (d: number): number => ((d % 360) + 360) % 360
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const step = (x: number, s: number): number => Math.round(x / s) * s
const r1 = (x: number): number => Math.round(x * 10) / 10
const r2 = (x: number): number => Math.round(x * 100) / 100
const r3 = (x: number): number => Math.round(x * 1000) / 1000
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

// ---- reference data --------------------------------------------------------------------------------------------------

interface Airport {
  icao: string
  lat: number
  lon: number
  elevFt: number
}
/** [airport, traffic weight]. OurAirports (public domain). */
const AIRPORTS: readonly (readonly [Airport, number])[] = [
  [{ icao: 'EDDM', lat: 48.353802, lon: 11.7861, elevFt: 1487 }, 5],
  [{ icao: 'LSZH', lat: 47.464699, lon: 8.54917, elevFt: 1416 }, 4],
  [{ icao: 'LOWW', lat: 48.110298, lon: 16.5697, elevFt: 600 }, 4],
  [{ icao: 'EDDF', lat: 50.033333, lon: 8.570556, elevFt: 364 }, 5],
  [{ icao: 'LIMC', lat: 45.630606, lon: 8.728111, elevFt: 768 }, 3],
  [{ icao: 'EDDS', lat: 48.689899, lon: 9.22196, elevFt: 1276 }, 2],
  [{ icao: 'LIPZ', lat: 45.505299, lon: 12.3519, elevFt: 7 }, 2],
  [{ icao: 'LKPR', lat: 50.1008, lon: 14.26, elevFt: 1247 }, 2],
  [{ icao: 'LSGG', lat: 46.238098, lon: 6.10895, elevFt: 1411 }, 2],
  [{ icao: 'LIML', lat: 45.445099, lon: 9.27674, elevFt: 353 }, 2],
  [{ icao: 'LIME', lat: 45.673901, lon: 9.70417, elevFt: 782 }, 2],
  [{ icao: 'LIPE', lat: 44.5354, lon: 11.2887, elevFt: 123 }, 1],
  [{ icao: 'EDDN', lat: 49.498699, lon: 11.078056, elevFt: 1046 }, 1],
  [{ icao: 'LOWI', lat: 47.260201, lon: 11.344, elevFt: 1907 }, 1],
  [{ icao: 'LOWS', lat: 47.793301, lon: 13.0043, elevFt: 1411 }, 1],
  [{ icao: 'LOWG', lat: 46.991100, lon: 15.4396, elevFt: 1115 }, 1],
  [{ icao: 'LOWL', lat: 48.233200, lon: 14.1875, elevFt: 980 }, 1],
  [{ icao: 'LJLJ', lat: 46.223701, lon: 14.4576, elevFt: 1273 }, 1],
  [{ icao: 'LIPX', lat: 45.395699, lon: 10.8885, elevFt: 239 }, 1],
  [{ icao: 'LFSB', lat: 47.59, lon: 7.529167, elevFt: 885 }, 1],
  [{ icao: 'EDJA', lat: 47.988800, lon: 10.2395, elevFt: 2077 }, 1],
  [{ icao: 'LDZA', lat: 45.742901, lon: 16.068800, elevFt: 353 }, 1],
  [{ icao: 'LIPH', lat: 45.648399, lon: 12.1944, elevFt: 59 }, 1],
  [{ icao: 'LIPB', lat: 46.460201, lon: 11.3264, elevFt: 789 }, 0.5],
]

/** ICAO type designator → ADS-B emitter category (DO-260B: A1 light, A2 small, A3 large, A4 B757, A5 heavy, A6 high performance, A7 rotorcraft). */
const CATEGORY: Record<string, string> = {
  A319: 'A3', A320: 'A3', A20N: 'A3', A321: 'A3', A21N: 'A3', B738: 'A3', B38M: 'A3', E190: 'A3', E195: 'A3', E75L: 'A3',
  BCS1: 'A3', BCS3: 'A3', CRJ9: 'A3', DH8D: 'A2', AT76: 'A2', B752: 'A4', A332: 'A5', A333: 'A5', A339: 'A5', A359: 'A5',
  A35K: 'A5', B763: 'A5', B772: 'A5', B77W: 'A5', B77L: 'A5', B788: 'A5', B789: 'A5', B748: 'A5', A388: 'A5',
  A400: 'A5', C30J: 'A3', EUFI: 'A6', C25A: 'A2', C56X: 'A2', CL35: 'A2', E55P: 'A2', PC24: 'A2', GLF6: 'A3',
  C172: 'A1', P28A: 'A1', SR22: 'A1', DA40: 'A1', C182: 'A1', PC12: 'A1', DA42: 'A1',
  EC35: 'A7', EC45: 'A7', A139: 'A7', R44: 'A7', AS50: 'A7', B06: 'A7',
}

/** [ICAO airline designator (real), weight, types it flies here]. The flight numbers are invented. */
const AIRLINES: readonly (readonly [string, number, readonly string[]])[] = [
  ['DLH', 14, ['A319', 'A320', 'A20N', 'A321', 'A21N', 'CRJ9', 'E190', 'A359', 'B748', 'A333']],
  ['EWG', 6, ['A319', 'A320', 'A20N']],
  ['RYR', 8, ['B738', 'B38M']],
  ['EZY', 6, ['A319', 'A320', 'A20N', 'A21N']],
  ['WZZ', 4, ['A320', 'A321', 'A21N']],
  ['SWR', 5, ['BCS1', 'BCS3', 'A320', 'A20N', 'A333', 'B77W']],
  ['AUA', 5, ['A320', 'A20N', 'E195', 'DH8D', 'B763', 'B772']],
  ['KLM', 3, ['B738', 'E75L', 'E190', 'B789']],
  ['AFR', 3, ['A320', 'A20N', 'BCS3', 'A359']],
  ['BAW', 3, ['A320', 'A20N', 'A321', 'B772', 'A35K']],
  ['CFG', 3, ['A320', 'A321', 'A20N', 'A339']],
  ['TRA', 2, ['B738', 'B38M']],
  ['EXS', 1, ['B738']],
  ['DLA', 2, ['E195']],
  ['THY', 4, ['A321', 'A21N', 'B38M', 'A333', 'B77W', 'A359']],
  ['PGT', 2, ['A20N', 'A21N', 'B38M']],
  ['SXS', 2, ['B738', 'B38M']],
  ['AEE', 2, ['A320', 'A20N']],
  ['TAP', 1, ['A20N', 'A21N']],
  ['IBE', 1, ['A320', 'A321', 'A20N']],
  ['VLG', 2, ['A320', 'A20N']],
  ['SAS', 2, ['A320', 'A20N', 'A21N']],
  ['FIN', 1, ['A320', 'A321', 'A359']],
  ['LOT', 2, ['B38M', 'E195', 'DH8D', 'B788']],
  ['CSA', 1, ['A320', 'A20N', 'AT76']],
  ['BTI', 1, ['BCS3']],
  ['LGL', 1, ['DH8D', 'E195', 'B38M']],
  ['EIN', 1, ['A320', 'A20N', 'A321']],
  ['ICE', 0.5, ['B38M']],
  ['NAX', 1, ['B738', 'B38M']],
  ['CTN', 1, ['DH8D', 'A319', 'A20N']],
  ['TVS', 1, ['B738', 'B38M']],
  ['ROT', 0.5, ['B738', 'B38M']],
  ['ELY', 1, ['B738', 'B789', 'B788']],
  ['UAE', 2, ['B77W', 'A388']],
  ['QTR', 2, ['A359', 'B77W', 'B788', 'A35K']],
  ['ETD', 1, ['B789']],
  ['SIA', 1, ['A359', 'B77W']],
  ['CCA', 0.5, ['A359', 'B77W']],
  ['ETH', 0.5, ['B788', 'A359']],
  ['MSR', 1, ['A320', 'A20N', 'B738']],
  ['RAM', 0.5, ['B738', 'B788']],
  ['UAL', 1, ['B763', 'B772', 'B789']],
  ['DAL', 1, ['A333', 'A339', 'B763']],
  ['AAL', 0.5, ['B772', 'B788']],
  ['ACA', 0.5, ['B789', 'A333']],
  ['GEC', 1, ['B77L']],
]
const BIZJETS = ['C25A', 'C56X', 'CL35', 'E55P', 'PC24', 'GLF6']
const MILITARY: readonly (readonly [string, readonly string[]])[] = [['GAF', ['A400', 'EUFI']], ['IAM', ['C30J', 'EUFI']]]
const LIGHT = ['C172', 'P28A', 'SR22', 'DA40', 'C182', 'PC12', 'DA42']
const HELIS = ['EC35', 'EC45', 'A139', 'R44', 'AS50', 'B06']
const NAV_MODES: readonly (readonly string[])[] = [
  ['autopilot', 'althold', 'lnav', 'tcas'],
  ['autopilot', 'vnav', 'lnav', 'tcas'],
  ['autopilot', 'lnav', 'tcas'],
]
const EMERGENCIES: Record<number, [string, string]> = { 1234: ['7700', 'general'], 2468: ['7600', 'nordo'] }

// ---- flight model --------------------------------------------------------------------------------------------------

type Kind = 'ground' | 'departure' | 'arrival' | 'cruise' | 'military' | 'bizjet' | 'light' | 'heli'
type Link = 'adsb2' | 'adsb0' | 'mlat'

/** One aircraft at one second. altFt null = on the ground (baro, ft). */
interface State {
  lat: number
  lon: number
  altFt: number | null
  gs: number // kt
  trk: number // deg
  vs: number // fpm
  turn: number // deg/s
}

interface Plane {
  i: number
  hex: string
  kind: Kind
  flight: string
  t: string
  squawk: string
  emergency: string
  dbFlags: number
  link: Link
  ehs: boolean // reports air data (ias/tas/mach, wind, temperatures, selected altitude/heading)
  navModes: readonly string[] | null
  mcpFt: number | null
  first: number // first and last poll the aircraft is in
  last: number
  rows: State[] // one per second from T_FIRST
}

function callsign(i: number, designator: string): string {
  if (u(i, 21) < 0.45) return designator + String(1 + Math.floor(u(i, 22) * 4999)) // DLH1234
  const n = String(1 + Math.floor(u(i, 23) * 99))
  const a = LETTERS[Math.floor(u(i, 24) * 26)]
  const b = u(i, 25) < 0.6 ? LETTERS[Math.floor(u(i, 26) * 26)] : ''
  return designator + n + a + b // EZY84TL, DLH9L
}

function nNumber(i: number): string {
  const c = '0123456789ABCDEFGHJKLMNPRSTUVWXYZ'
  return 'N0' + c[Math.floor(u(i, 27) * c.length)] + c[Math.floor(u(i, 28) * c.length)] + c[Math.floor(u(i, 29) * 10)]
}

const octal = (i: number, k: number): string => String(1 + Math.floor(u(i, k) * 6)) + [1, 2, 3].map((j) => Math.floor(u(i, k + j) * 8)).join('')

/** Integrates one aircraft second by second. toward: an arrival homes on this airport down a 3° path. */
function fly(s0: State, levelFt: number | null, toward: Airport | null): State[] {
  const rows: State[] = []
  let s = { ...s0 }
  for (let n = 0; n < STEPS; n++) {
    rows.push(s)
    const next = { ...s }
    if (toward !== null && s.altFt !== null) {
      const d = distanceNm(s.lat, s.lon, toward.lat, toward.lon)
      const want = bearingDeg(s.lat, s.lon, toward.lat, toward.lon)
      const turn = clamp(((want - s.trk + 540) % 360) - 180, -3, 3) // standard rate at most
      next.trk = wrap360(s.trk + turn)
      next.turn = turn
      next.gs = s.gs + clamp(clamp(140 + 2.2 * d, 140, s.altFt < 10_000 ? 250 : 300) - s.gs, -1, 1)
      const pathFt = toward.elevFt + 318 * d // 3° glide path: 318 ft per nm
      const vs = d < 2 ? 0 : clamp((pathFt - s.altFt) * 2, -2500, 0) // descend onto the path, never climb
      next.vs = vs
      next.altFt = Math.max(toward.elevFt + 800, s.altFt + vs / 60)
    } else {
      next.trk = wrap360(s.trk + s.turn)
      if (s.altFt !== null) {
        const alt = s.altFt + s.vs / 60
        if (levelFt !== null && (s.vs > 0 ? alt >= levelFt : s.vs < 0 && alt <= levelFt)) {
          next.altFt = levelFt
          next.vs = 0
        } else next.altFt = alt
      }
    }
    const p = destination(s.lat, s.lon, s.trk, s.gs / 3600)
    next.lat = p.lat
    next.lon = p.lon
    s = next
  }
  return rows
}

function plane(i: number): Plane {
  const hex = (HEX0 + i).toString(16)
  const r = u(i, 0)
  const cruiser = EMERGENCIES[i] !== undefined // the two emergencies fly at cruise level
  const kind: Kind = cruiser ? 'cruise'
    : r < 0.11 ? 'ground'
    : r < 0.27 ? 'departure'
    : r < 0.45 ? 'arrival'
    : r < 0.88 ? (u(i, 1) < 0.01 ? 'military' : u(i, 1) < 0.04 ? 'bizjet' : 'cruise')
    : r < 0.96 ? 'light'
    : 'heli'
  const [designator, , types] = weighted(AIRLINES.map((a) => [a, a[1]] as const), i, 2)
  let flight = callsign(i, designator)
  let t = pick(types, i, 3)
  let squawk = octal(i, 4)
  let dbFlags = 0
  let link: Link = u(i, 8) < 0.97 ? 'adsb2' : 'adsb0'
  let ehs = u(i, 9) < 0.85
  const apt = weighted(AIRPORTS, i, 10)
  const brg = between(i, 11, 0, 360)
  const trk = between(i, 12, 0, 360)
  const heavy = CATEGORY[t] === 'A5'
  let s0: State
  let levelFt: number | null = null
  let toward: Airport | null = null
  let mcpFt: number | null = null

  const random = (maxNm: number): { lat: number; lon: number } =>
    destination(CENTER.lat, CENTER.lon, between(i, 13, 0, 360), maxNm * Math.sqrt(u(i, 14)))

  switch (kind) {
    case 'ground': {
      const p = destination(apt.lat, apt.lon, brg, between(i, 15, 0.1, 0.9))
      const taxi = u(i, 16) < 0.3
      s0 = { ...p, altFt: null, gs: taxi ? between(i, 17, 8, 20) : 0, trk, vs: 0, turn: taxi ? between(i, 18, -1.5, 1.5) : 0 }
      ehs = false
      break
    }
    case 'departure': {
      const d = between(i, 15, 2, 45)
      const altFt = apt.elevFt + 1000 + d * 480
      levelFt = 1000 * (24 + Math.floor(u(i, 16) * 14))
      mcpFt = levelFt
      s0 = { ...destination(apt.lat, apt.lon, brg, d), altFt, gs: altFt < 10_000 ? between(i, 17, 220, 250) : 300 + altFt / 250, trk: wrap360(brg + between(i, 18, -8, 8)), vs: between(i, 19, 1500, 3200) * (altFt > 20_000 ? 0.6 : 1), turn: 0 }
      break
    }
    case 'arrival': {
      const d = between(i, 15, 15, 110)
      const altFt = Math.min(37_000, step(apt.elevFt + 318 * d + between(i, 16, 0, 3000), 100))
      toward = apt
      mcpFt = Math.max(3000, step(altFt - 4000, 1000))
      s0 = { ...destination(apt.lat, apt.lon, brg, d), altFt, gs: clamp(140 + 2.2 * d, 140, altFt < 10_000 ? 250 : 300), trk: wrap360(brg + 180), vs: 0, turn: 0 }
      break
    }
    case 'cruise':
    case 'military':
    case 'bizjet': {
      if (kind === 'military') {
        const [mil, milTypes] = pick(MILITARY, i, 30)
        flight = mil + String(10 + Math.floor(u(i, 31) * 990))
        t = pick(milTypes, i, 32)
        dbFlags = 1
        ehs = false
      } else if (kind === 'bizjet') {
        flight = nNumber(i)
        t = pick(BIZJETS, i, 32)
      }
      const east = trk < 180 // semicircular rule: eastbound odd, westbound even flight levels
      const fl = kind === 'military' ? 200 + 10 * Math.floor(u(i, 15) * 15) : pick(east ? [290, 310, 330, 350, 370, 390, 410] : [280, 300, 320, 340, 360, 380, 400], i, 15)
      const changing = u(i, 16) < 0.08
      const vs = changing ? (u(i, 17) < 0.5 ? -1 : 1) * between(i, 18, 1000, 2000) : 0
      levelFt = changing ? clamp(fl * 100 + Math.sign(vs) * 2000, 26_000, 41_000) : null
      mcpFt = levelFt ?? fl * 100
      s0 = { ...random(PLACE_NM), altFt: fl * 100, gs: between(i, 19, 400, 520), trk, vs, turn: 0 }
      break
    }
    case 'light': {
      flight = nNumber(i)
      t = pick(LIGHT, i, 32)
      squawk = '7000'
      link = u(i, 8) < 0.7 ? 'adsb2' : u(i, 8) < 0.85 ? 'adsb0' : 'mlat'
      ehs = false
      const turning = u(i, 16) < 0.4
      s0 = { ...random(200), altFt: step(between(i, 15, 2000, 10_500), 100), gs: between(i, 17, 80, 150), trk, vs: step(between(i, 18, -500, 500), 64), turn: turning ? between(i, 19, -3, 3) : 0 }
      levelFt = s0.altFt! + Math.sign(s0.vs) * 1000
      break
    }
    case 'heli': {
      flight = nNumber(i)
      t = pick(HELIS, i, 32)
      squawk = '7000'
      link = u(i, 8) < 0.6 ? 'adsb2' : u(i, 8) < 0.8 ? 'adsb0' : 'mlat'
      ehs = false
      const turning = u(i, 16) < 0.5
      s0 = { ...destination(apt.lat, apt.lon, brg, between(i, 15, 2, 30)), altFt: step(apt.elevFt + between(i, 17, 500, 2500), 100), gs: between(i, 18, 60, 130), trk, vs: 0, turn: turning ? between(i, 19, -4, 4) : 0 }
      break
    }
  }
  if (heavy && kind === 'departure') s0.vs *= 0.7
  const e = EMERGENCIES[i]
  // Churn: 5 % appear during the recording, 5 % leave it (and leaving the 250 nm query circle adds more).
  const c = u(i, 40)
  const first = c < 0.05 ? 1 + Math.floor(u(i, 41) * 12) : 0
  const last = c >= 0.05 && c < 0.1 ? 12 + Math.floor(u(i, 42) * 12) : POLLS - 1
  return {
    i, hex, kind, flight, t, squawk: e ? e[0] : squawk, emergency: e ? e[1] : 'none', dbFlags, link, ehs,
    navModes: ehs && u(i, 43) < 0.6 ? pick(NAV_MODES, i, 44) : null, mcpFt, first, last, rows: fly(s0, levelFt, toward),
  }
}

// ---- the adsb.lol v2 aircraft object -------------------------------------------------------------------------------

/** The state tS seconds after T0 (linear between whole seconds). */
function at(p: Plane, tS: number): State {
  const x = tS - T_FIRST
  const k = clamp(Math.floor(x), 0, p.rows.length - 2)
  const f = x - k
  const a = p.rows[k]
  const b = p.rows[k + 1]
  const lerp = (m: number, n: number): number => m + (n - m) * f
  return {
    lat: lerp(a.lat, b.lat), lon: lerp(a.lon, b.lon), altFt: a.altFt === null || b.altFt === null ? a.altFt : lerp(a.altFt, b.altFt),
    gs: lerp(a.gs, b.gs), trk: wrap360(a.trk + a.turn * f), vs: a.vs, turn: a.turn,
  }
}

/** ISA density ratio at a pressure altitude (troposphere, then the isothermal layer). */
const sigma = (ft: number): number => (ft <= 36_089 ? (1 - 6.8756e-6 * ft) ** 4.2559 : 0.2971 * Math.exp(-(ft - 36_089) / 20_806))

function object(p: Plane, k: number): Record<string, unknown> | null {
  const i = p.i
  const tPoll = k * PERIOD_S
  const parked = p.kind === 'ground' && p.rows[0].gs === 0
  const seenPos = r3(parked ? between(i, 100 + k, 1, 9) : p.link === 'mlat' ? between(i, 100 + k, 0.5, 4) : between(i, 100 + k, 0.1, 2.5))
  const s = at(p, tPoll - seenPos)
  const dst = distanceNm(CENTER.lat, CENTER.lon, s.lat, s.lon)
  if (dst > QUERY_NM) return null
  const mlat = p.link === 'mlat'
  const o: Record<string, unknown> = { hex: p.hex, type: mlat ? 'mlat' : 'adsb_icao', flight: p.flight.padEnd(8), t: p.t }
  if (p.dbFlags) o.dbFlags = p.dbFlags
  const air = s.altFt !== null
  if (!air) {
    o.alt_baro = 'ground'
    o.gs = r1(s.gs)
    o.track = r2(s.trk)
  } else {
    const baro = step(s.altFt!, 25)
    const dev = between(i, 50, -6, 6) // ISA temperature deviation, °C
    o.alt_baro = baro
    if (!mlat) o.alt_geom = step(baro + geoidN(s.lat, s.lon) / 0.3048 + dev * baro * 0.004, 25)
    o.gs = r1(s.gs)
    if (p.ehs) {
      const wd = wrap360(250 + 40 * Math.sin((s.lat - 45) * 0.9) + 20 * Math.cos(s.lon * 0.7))
      const ws = 12 + (s.altFt! / 1000) * 1.6
      const head = ws * Math.cos(((wd - s.trk) * Math.PI) / 180) // headwind component
      const tas = s.gs + head
      const oat = Math.max(-56.5, 15 - 1.98 * (s.altFt! / 1000)) + dev
      const tK = oat + 273.15
      const mach = tas / (38.967854 * Math.sqrt(tK))
      const wca = (Math.asin(clamp((ws * Math.sin(((wd - s.trk) * Math.PI) / 180)) / tas, -1, 1)) * 180) / Math.PI
      const hdg = wrap360(s.trk + wca)
      o.ias = Math.round(tas * Math.sqrt(sigma(s.altFt!)))
      o.tas = Math.round(tas)
      o.mach = Math.round(mach * 1000) / 1000
      o.wd = Math.round(wd)
      o.ws = Math.round(ws)
      o.oat = Math.round(oat)
      o.tat = Math.round(tK * (1 + 0.2 * mach * mach) - 273.15)
      o.track_rate = r2(s.turn)
      o.roll = r2((Math.atan(((s.turn * Math.PI) / 180) * s.gs * 0.514444 / 9.80665) * 180) / Math.PI)
      o.mag_heading = r2(wrap360(hdg - 4)) // declination ≈ 4° E around the Alps
      o.true_heading = r2(hdg)
    }
    o.track = r2(s.trk)
    o.baro_rate = step(s.vs + between(i, 200 + k, -40, 40), 64)
    if (p.link === 'adsb2' && s.vs !== 0) o.geom_rate = step(s.vs + between(i, 300 + k, -60, 60), 64)
  }
  o.squawk = p.squawk
  if (!mlat) o.emergency = p.emergency
  o.category = CATEGORY[p.t]
  if (air && p.link === 'adsb2') o.nav_qnh = p.kind === 'arrival' || p.kind === 'departure' ? 1016 : 1013.6
  if (air && p.ehs && p.mcpFt !== null) o.nav_altitude_mcp = p.mcpFt
  if (air && p.ehs && u(i, 45) < 0.6) o.nav_heading = r2(wrap360(s.trk + between(i, 46, -3, 3)))
  if (air && p.navModes !== null) o.nav_modes = p.navModes
  o.lat = r6(s.lat)
  o.lon = r6(s.lon)
  o.nic = mlat ? 0 : 8
  o.rc = mlat ? 0 : 186
  o.seen_pos = seenPos
  if (!mlat) {
    const v2 = p.link === 'adsb2'
    o.version = v2 ? 2 : 0
    if (v2) o.nic_baro = 1
    o.nac_p = v2 ? 9 : 8
    o.nac_v = v2 ? 2 : 1
    o.sil = v2 ? 3 : 2
    o.sil_type = v2 ? 'perhour' : 'unknown'
    if (v2) o.gva = 2
    o.sda = v2 ? 2 : 0
  }
  o.alert = 0
  o.spi = 0
  o.mlat = mlat ? ['gs', 'track', 'baro_rate', 'lat', 'lon', 'nic', 'rc'] : []
  o.tisb = []
  o.messages = 2000 + ((i * 37) % 9000) + Math.round(tPoll * between(i, 47, 2, 9))
  o.seen = Math.floor(Math.min(seenPos, between(i, 400 + k, 0.05, 1)) * 10) / 10 // adsb.lol: 0.1 s, ≤ seen_pos
  o.rssi = r1(-12 - 20 * (dst / QUERY_NM) + between(i, 500 + k, -3, 3))
  o.dst = r3(dst)
  o.dir = r1(bearingDeg(CENTER.lat, CENTER.lon, s.lat, s.lon))
  return o
}

// ---- output --------------------------------------------------------------------------------------------------------

const planes: Plane[] = []
for (let i = 0; i < N; i++) planes.push(plane(i))
const lines: string[] = []
let objects = 0
for (let k = 0; k < POLLS; k++) {
  const now = T0_MS + k * PERIOD_S * 1000
  const ac: Record<string, unknown>[] = []
  for (const p of planes) {
    if (k < p.first || k > p.last) continue
    const o = object(p, k)
    if (o !== null) ac.push(o)
  }
  objects += ac.length
  const body = JSON.stringify({ ac, ctime: now, msg: 'No error', now, ptime: 0, total: ac.length })
  const tSendMs = now - 45 - ((k * 17) % 30)
  const tRecvMs = now + 95 + ((k * 29) % 60)
  const url = `synthetic:/v2/point/${CENTER.lat}/${CENTER.lon}/${QUERY_NM}`
  lines.push(JSON.stringify({ v: 1, source: 'adsblol', url, status: 200, tSendMs, tRecvMs, bytes: Buffer.byteLength(body), body }))
}
const text = lines.join('\n') + '\n'
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, text)
const counts: Record<string, number> = {}
for (const p of planes) counts[p.kind] = (counts[p.kind] ?? 0) + 1
console.log(`${OUT}: ${POLLS} polls, ${N} aircraft (${objects} objects), ${Buffer.byteLength(text)} bytes`)
console.log(Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', '))
```

- [ ] **Step 2: Write the timing tool**

```ts
// .planning/plans/assets/WP-B-A/time-view.ts
// Gate GB: times GET /api/view on a running server over loopback, which is the server time (request to the last gzipped
// byte) plus well under a millisecond: 15 full replies (since=0), then 15 incremental ones a second apart (a client one
// poll behind). Run from the repository root while the server replays the heavy file:
//   node .planning/plans/assets/WP-B-A/time-view.ts [base] [lat] [lon] [nm]
// Defaults: http://127.0.0.1:8787, the heavy replay's centre (LOWI) and the 250 nm browse cap.
import { request } from 'node:http'
import { gunzipSync } from 'node:zlib'

const [base = 'http://127.0.0.1:8787', lat = '47.26', lon = '11.34', nm = '250'] = process.argv.slice(2)
const url = `${base}/api/view?lat=${lat}&lon=${lon}&nm=${nm}`

interface Reply {
  ms: number
  gzBytes: number
  samples: { rxMs: number }[]
  info: unknown[]
}

function get(u: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now()
    request(u, { headers: { 'accept-encoding': 'gzip' } }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (c: Buffer) => parts.push(c))
      res.on('end', () => {
        const ms = performance.now() - t0
        const buf = Buffer.concat(parts)
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${buf.toString().slice(0, 200)}`))
        const body = JSON.parse((res.headers['content-encoding'] === 'gzip' ? gunzipSync(buf) : buf).toString())
        resolve({ ms, gzBytes: buf.length, samples: body.samples, info: body.info ?? [] })
      })
    }).on('error', reject).end()
  })
}

const pct = (xs: number[], p: number): number => xs.toSorted((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]
const line = (xs: number[]): string => `median ${pct(xs, 0.5).toFixed(1)} ms, p90 ${pct(xs, 0.9).toFixed(1)} ms, max ${Math.max(...xs).toFixed(1)} ms`

const full: number[] = []
let last: Reply | null = null
for (let i = 0; i < 15; i++) {
  last = await get(`${url}&since=0`)
  full.push(last.ms)
}
console.log(`since=0: ${last!.samples.length} samples, ${last!.info.length} info, ${last!.gzBytes} B gzipped; ${line(full)}`)

let since = 0
for (const s of last!.samples) if (s.rxMs > since) since = s.rxMs
const inc: number[] = []
let n = 0
let bytes = 0
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const r = await get(`${url}&since=${since}`)
  inc.push(r.ms)
  n += r.samples.length
  bytes += r.gzBytes
  for (const s of r.samples) if (s.rxMs > since) since = s.rxMs
}
console.log(`incremental (1 Hz): ${Math.round(n / inc.length)} samples, ${Math.round(bytes / inc.length)} B per reply; ${line(inc)}`)
```

- [ ] **Step 3: Generate the replay**

Run: `node .planning/plans/assets/WP-B-A/gen-synthetic-heavy.ts`
Expected (about 1.3 s):
```
data/recordings/synthetic-heavy.jsonl: 26 polls, 5000 aircraft (123081 objects), 86055651 bytes
departure 828, cruise 2032, light 397, arrival 935, bizjet 58, ground 542, heli 194, military 14
```
Then `shasum -a 256 data/recordings/synthetic-heavy.jsonl` prints `ca1f4c7e58c1d064f50ab0e74e772b9e795c3e44914fe19af45191f3b11e9107`. A second run writes identical bytes. `git status --short data/` prints nothing, because the file is gitignored.

- [ ] **Step 4: Check that the replay path reads it**

Run: `node -e "import('./server/recording.ts').then(({ readRecording, recordingToSamples }) => { const s = recordingToSamples(readRecording('data/recordings/synthetic-heavy.jsonl')); console.log('samples', s.length, 'aircraft', new Set(s.map((x) => x.hex)).size) })"`
Expected: `samples 123081 aircraft 4948`

- [ ] **Step 5: Type-check the two scripts** (they are outside `tsconfig.json`'s `include`)

Run: `printf '{ "extends": "./tsconfig.json", "include": [".planning/plans/assets/WP-B-A/*.ts"] }\n' > tsconfig.b-a.json && npx tsc --noEmit -p tsconfig.b-a.json; echo "exit $?"; rm tsconfig.b-a.json`
Expected: `exit 0`

- [ ] **Step 6: Commit** (the scripts only; the replay stays local)

```bash
git add .planning/plans/assets/WP-B-A/gen-synthetic-heavy.ts .planning/plans/assets/WP-B-A/time-view.ts
git commit -m "test(gate): heavy synthetic replay generator and /api/view timing for Gate GB" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Gate GB (the heavy bench) and a check by hand

These steps measure and look; they change no file. The replay holds 5 minutes of data, and positions expire 60 s after it ends. Restart the server to replay it again (the client keeps polling through a restart).

- [ ] **Step 1: Serve the heavy replay**

Run: `ADSB_SOURCE=replay REPLAY_FILES=data/recordings/synthetic-heavy.jsonl RECORD_DIR= npm run server`
Expected: `FlightHopper server on http://127.0.0.1:8787 (source replay)`. Command-line variables win over `.env.local`. For the next steps, keep this running in one terminal and run `npm run dev` in another.

- [ ] **Step 2: Time `/api/view`** (gate: ≤ 50 ms server-side)

Run: `node .planning/plans/assets/WP-B-A/time-view.ts`
Expected (M2, 2026-09-22):
```
since=0: 4663 samples, 4663 info, 378640 B gzipped; median 14.3 ms, p90 17.3 ms, max 23.0 ms
incremental (1 Hz): 313 samples, 20278 B per reply; median 2.7 ms, p90 6.3 ms, max 29.4 ms
```

- [ ] **Step 3: Browse top-down with every aircraft in view** (gate: FPS p50 ≥ 50, p5 ≥ 30, table update p95 ≤ 5 ms)

Open `http://localhost:5173/?airport=LOWI&bench=1` in Chrome and keep the tab in front. After the first aircraft appear, paste this into the DevTools console. It zooms out to 1,100 km, so the whole 240 nm fleet is on screen, waits 8 s, then measures 20 s:

```js
const v = window.viewer; const d = Math.PI / 180
v.camera.setView({ destination: v.scene.globe.ellipsoid.cartographicToCartesian({ longitude: 11.344 * d, latitude: 47.2602 * d, height: 1_100_000 }), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } })
await new Promise((r) => setTimeout(r, 8000))
performance.clearMeasures()
const iv = []; let last = null; let run = true
const tick = (t) => { if (last !== null) iv.push(t - last); last = t; if (run) requestAnimationFrame(tick) }
requestAnimationFrame(tick)
const lt = []; const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) lt.push(Math.round(e.duration)) }); po.observe({ type: 'longtask' })
await new Promise((r) => setTimeout(r, 20000)); run = false; po.disconnect()
const q = (xs, p) => { const s = xs.toSorted((a, b) => a - b); const r = (p / 100) * (s.length - 1); const lo = Math.floor(r); return s[lo] + (r - lo) * (s[Math.ceil(r)] - s[lo]) }
const m = (n) => { const xs = performance.getEntriesByName(n).map((e) => e.duration); return { p50: +q(xs, 50).toFixed(2), p95: +q(xs, 95).toFixed(2), max: +Math.max(...xs).toFixed(2) } }
console.log({ fpsP50: 1000 / q(iv, 50), fpsP5: 1000 / q(iv, 95), longTasks: lt, frame: m('fh:frame'), fleet: m('fh:fleet'), table: m('fh:table'), ingest: m('fh:ingest'), counts: [...document.querySelectorAll('.fh-table-count')].map((e) => e.textContent) })
```

Expected (M2, 1440×900, rAF capped at 100 Hz in that browser): about 4,600 on screen, `fpsP50` 100, `fpsP5` 96, no long tasks. `frame` p95 about 1.4 ms, `fleet` p95 about 1.2 ms, `table` p95 about 0.2 ms, `ingest` p95 about 1.1 ms.

For the frame capacity without the display's cap, run this with the same view: `const gl = v.scene.context._gl, px = new Uint8Array(4), ts = []; v.useDefaultRenderLoop = false; for (let i = 0; i < 300; i++) { const t0 = performance.now(); v.render(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); ts.push(performance.now() - t0) } v.useDefaultRenderLoop = true; console.log(ts.toSorted((a, b) => a - b)[150], ts.toSorted((a, b) => a - b)[285])`
Expected: about 8.9 ms and 10.4 ms (112 and 96 fps).

- [ ] **Step 4: Check the modes by hand**
  - Browse: north-up street map, with icons turned to their tracks and coloured orange (low) through magenta (high), grey on the ground. The legend is at the bottom, above Cesium's credit line, which shows "© OpenStreetMap contributors". The table is on the right with "Total aircraft" / "On screen", and the credits are under it.
  - Hover an icon: its callsign label and a pointer cursor. Hover a table row: that aircraft's label on the map.
  - Click a row or an icon: chase. The map and the legend hide. The detail panel (top-left) shows the callsign, the airline (e.g. "Aegean Airlines" for AEE…), type, squawk, and the Spatial, Signal, FMS SEL and Wind rows. The HUD sits bottom-left, below the panel. The table stays, with the selected row highlighted. Drag orbits, the wheel zooms and a double-click resets (WP-V4).
  - `Esc` or the panel's ×: back to browse at 300 km over the last chased position.
  - `?hex=b004d2`: chase from the start; the squawk reads "7700 · general" in red.
  - Narrow the window to 375 px: no overlaps. Chasing on a phone, the table hides and the panel, HUD and credits stack.

- [ ] **Step 5: The detail panel with a real aircraft**

Stop the server. Run: `ADSB_SOURCE=replay REPLAY_FILES='data/recordings/*.jsonl' RECORD_DIR= npm run server` (if the recorder is writing today's file, copy it first without its unfinished last line). Open `http://localhost:5173/?airport=KSFO`. Search the table for an airline flight, e.g. `UAL`, and click its row.
Expected: the table shows country flags. The panel shows the photo with "Image © {photographer}" linked to its planespotters.net page, the country with its flag (e.g. "🇺🇸 United States"), the airline (e.g. "United Airlines"), the registration and the type. The planespotters API sometimes refuses a browser request (no CORS header): the panel then says "Photo unavailable", and selecting the aircraft again retries. Routes stay "—" (they come only from `ADSB_SOURCE=adsblol` with `ROUTES=1`).

---

### Task 5: WP gate

- [ ] **Step 1: This package's tests**

Run: `node --test client/app.test.ts`
Expected: `ℹ pass 9`, `ℹ fail 0`

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no output

- [ ] **Step 3: Full check**

Run: `npm run check`
Expected: tsc clean; all tests pass (604 in the integrated tree)

- [ ] **Step 4: Confirm there is nothing left to commit**

Run: `git status --short`
Expected: no output (`data/recordings/synthetic-heavy.jsonl` is gitignored)

---

## Notes for later work

- **Fleet time vs. chase time:** the fleet is drawn at server now, and the chased aircraft at the delayed render time (≥ 3 s earlier). Traffic around the chased aircraft therefore runs a few seconds ahead of it (a `ponytail:` comment in `frame()`). Upgrade: draw the fleet at the render time, which needs Fleet to interpolate between samples.
- **View key per pan:** every pan moves the browse circle's centre, so the first poll after it is a full reply. At 4,700 aircraft this cost no dropped frame (Validated). Upgrade if it ever does: snap the centre to a grid.
- **"On screen" in chase** is the ground rectangle the camera sees. The chased aircraft is always counted, because it flies in front of the camera but above the ground that the rectangle starts beyond.
- **Real recordings:** the recorder polls each cell every 36–82 s (its budget). An aircraft can therefore drop out between polls, because the fleet and the replay both forget positions after 60 s. The chase then shows "Predicting" or "Signal lost". This comes from the data, not the app.
- **`.env.example`** (WP-00) documents neither `ROUTES` (B-S1) nor `VITE_MAP_URL` (this package). Add `ROUTES=0` and `# VITE_MAP_URL=` to it in a WP-00 follow-up.
- **The legend while chasing** is hidden: the chase view is 3-D, and the icons there are orientation cues more than a map.

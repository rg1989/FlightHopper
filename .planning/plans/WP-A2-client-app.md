# WP-A2 — Client App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assemble the Wave 1 client parts into the app a person opens. The app shows a globe with every aircraft in view and runways at the hero airports. One click chases an aircraft in third person down to the runway. The app also shows an honest HUD, a status banner, the attribution box and an optional bench overlay. This package also ships a synthetic KSFO replay, so the whole app (server + client) runs offline with no recordings.

**Architecture:** Two source files and one fixture.
- `client/app.ts` exports `startApp(root, cfg)` and five small pure helpers, which are tested in Node.
  - **Startup:** `startApp` builds the viewer (V1). In parallel it fetches `/airports/heroes.json` (T1) and `/models/manifest.json` (V3). If either JSON fails, the app runs without runways or without the model. If `createViewer` fails (terrain unreachable), `startApp` rejects.
  - **Parts:** the HUD, banner and attribution (V6) go into one overlay element that `startApp` creates in `root`. Then the runways (V5), the aircraft layer (V2), the chase camera (V4) and the chase model (V3, `ChaseModel.load` of the manifest's `default` entry; hidden until something is chased). Then one `ApiClient(cfg.apiBase)` (V7), one `TrackRegistry({ pollPeriodS: 1 })` (I2) and one `RenderClock(3)` (C3). The first view looks straight down on the first hero airport (KSFO) from 60 km.
  - **Poll loop** (1 Hz, self-scheduling, never overlapping). It calls `api.view(lat, lon, viewRadiusNm(camera height))` and, while an aircraft is selected, `api.chase(hex)`. The view centre is the chased aircraft. With nothing chased, it is the globe point at the canvas centre (`camera.pickEllipsoid`), or the point below the camera when the centre ray misses the Earth. Each reply goes straight into `registry.ingest`, between two frames, as I2 asks, and its `status` is kept. Then `registry.prune(serverNow, 60)`. After three failed polls in a row the banner shows "Live data unavailable" (`statusShown`). The first failure of a streak is logged once.
  - **Frame loop** (`scene.preUpdate`, as in the V2 and V4 harnesses). `preUpdate` comes after Cesium applies mouse input to the camera and before it updates primitives, so the camera and the model move in the same frame. Each frame: `tRender = clock.tick(api.serverNowMs(), registry.delayTargetS(selected), dt)` → `registry.states(tRender)` → `layer.update(states, selected)`. For the selected aircraft, the height is first placed with `placedHeightM`: on the ground, the loaded terrain height; in the air, never below it. Then `model.update`, `chaseCamera.update` (its `clearanceM` goes to the bench), `hud.update`, `banner.update` and `bench.frame`. The model is shown only while the chased aircraft has a state. With no state, the camera stays where it was.
  - **Heights:** `modelMatrixFor` (V3) treats `hM` as the height of the wheels and adds `gearHeightM` itself. So on the ground the app passes `hM = terrain`, and the model's origin ends up at terrain + `gearHeightM`.
  - **Input:** a left click → `layer.pick` → chase that aircraft. `Esc` lets go (`ChaseCamera.release()`). So does a click on the chased aircraft's dot, where the model does not cover it (the model itself is not pickable as an aircraft). Cesium's default double-click is removed, because it would start tracking an entity (the runway markers are entities) and fight the chase camera.
  - **URL:** `?hex=<hex>` chases that aircraft from the start (G3). `?bench=1` adds `BenchRecorder`'s overlay, and `b` downloads its report. `?airport=<ident>` picks the first view.
  - **`stop()`** removes the listeners, the poll loop, the overlays and every primitive, then destroys the viewer. `window.viewer` is set while the app runs, as WP-00's placeholder did, for console debugging and G3.
- `client/main.ts` replaces WP-00's placeholder: `startApp(#globe ?? body, readConfig(import.meta.env))`. A startup error, for example `ion` without a token, is shown on the page. `index.html` stays WP-00's.
- **Testing the helpers:** the test imports `app.ts` in Node. Its imports pull in `.css` files (V1, V6), which Node cannot load. So the test registers a synchronous `module.registerHooks` loader that returns any `.css` as an empty module (Node ≥ 23.5 / 22.15). The hook stays inside that test's process, because `node --test` runs each file in its own process.
- **Synthetic fixture** `.planning/plans/assets/WP-A2/synthetic-ksfo.jsonl`: 330 polls at 1 Hz in the `RecordLine` format. Each poll has an adsb.lol v2 envelope (`ac`, `ctime`, `msg`, `now`, `ptime`, `total`) and readsb aircraft objects with the usual fields. The five aircraft are invented. They use unallocated ICAO addresses (000a01–000a05), SYN callsigns and invalid N-numbers (N0…):

| hex | callsign | type | flight | quality |
|---|---|---|---|---|
| 000a01 | SYN101 | A320 | 3° ILS to KSFO 28R from 10 nm (3,150 ft baro), 170 → 138 kt, threshold crossing height 50 ft, flare, touchdown at +250.9 s / 127.6 kt, autobrake to 30 kt, taxi speed 15 kt | ADS-B v2: `alt_geom` HAE, `geom_rate`, `nav_qnh` 1016.0 |
| 000a02 | SYN202 | B738 | lined up on 1R: surface positions every 5 s, `true_heading`. Takeoff roll at +40 s, liftoff at +75.7 s / 150.4 kt, 2,500 fpm, standard-rate right turn to 118° at 1,000 ft, levels at 10,000 ft | ADS-B v2 |
| 000a03 | SYN303 | B77W | FL350 (`alt_geom` 36,125 ft), 480 kt on 135°, over the bay | ADS-B v2 |
| 000a04 | SYN404 | E75L | right-hand hold at 6,000 ft 16 nm south-east, 210 kt, 3°/s turns, inbound 298° | ADS-B v0: baro only |
| 000a05 | SYN505 | C172 | 3,500 ft, 105 kt on 300°, ≤ 20 m position scatter | MLAT |

The generator next to the fixture is deterministic: a fixed epoch (2026-09-22 18:00 UTC) and no randomness. It uses `shared/geo.ts` and `shared/geoid.ts`, so `alt_geom` (HAE) and `alt_baro` (MSL − (QNH − 1013.25)·27 ft) are consistent with the geoid at every point. Run the whole app on it like this (Task 4):

```bash
ADSB_SOURCE=replay REPLAY_FILES=.planning/plans/assets/WP-A2/synthetic-ksfo.jsonl npm run server
npm run dev    # in a second terminal, then open http://localhost:5173/
```

**Tech Stack:** Node ≥ 24.2 (native TypeScript; `node:module` `registerHooks` in the test), `node:test`, TypeScript 7 (type-check only), Vite 8, CesiumJS 1.145 (`Scene.preUpdate`, `Camera.pickEllipsoid`, `Globe.getHeight`, `ScreenSpaceEventHandler`). No new dependencies.

**Wave:** 3 (needs V1–V8 and I2 merged; I2 brings C1–C5; Task 4's run also needs A1). **Estimated:** 1.5 h. **Validated:** on 2026-09-22 in the shared sandbox (Node v25.2.1, TypeScript 7.0.2, Vite 8.3.0, CesiumJS 1.145.0). The sandbox holds WP-00 and the code of every other package in its merged state.
- `node --test client/app.test.ts` first failed with `ERR_MODULE_NOT_FOUND` (Task 1 Step 2), then passed 5/5.
- `npx tsc --noEmit` printed nothing for the whole tree, `client/app.ts` and `client/main.ts` included. `tsconfig.json` does not include the generator, so it was type-checked separately with the same options: clean.
- `npx vite build` → `✓ built`: one 4.2 MB app chunk, and the same chunk-size warning as WP-00.
- `npm test` over the whole sandbox passed 452/452.
- Four mutations of the helpers each made one test fail: ground height not clamped to the terrain, radius floor 10 nm, `?bench` accepted without `=1`, and the banner after 4 failed polls instead of 3.
- The generator ran twice with byte-identical output (330 lines, 982,254 bytes). Read back through `recordingToSamples`, it gave the facts in the table (Task 3 Step 3).
- In the browser, the A1 server served this package's build and replayed the fixture. The chase, touchdown, `Esc`, `?hex=` + `?bench=1` and the server-stop banner all behaved as expected (Task 4 Step 5 has the numbers). The console showed no errors other than the refused connections caused by stopping the server on purpose.
- This plan was generated from the tested files, so its code blocks match them byte for byte.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- **Attribution and safety are visible:** the box names adsb.lol (ODbL 1.0), OurAirports, the model's author and licence, and says "Entertainment only. Not for navigation." (V6 adds that line). Cesium shows the terrain and imagery credits itself, and EOX's credit is on screen as its licence asks.
- **Heights** stay WGS84 ellipsoidal. The ground clamp uses `globe.getHeight`, which is ellipsoidal in every terrain option (V1).
- **Tests never touch the network.** The test imports `app.ts` but never calls `startApp`. The fixture contains no real data, and generating it makes no requests.
- **Upstream politeness** is the server's job (A1, I1, S3). The client polls only its own server: one view request and at most one chase request per second.
- Erasable TypeScript only, `.ts` import extensions. This package creates or edits only the files below.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `client/app.ts` | `startApp(root, cfg)`; helpers `viewRadiusNm`, `placedHeightM`, `readParams`, `attributionFor`, `statusShown` |
| `client/app.test.ts` | the helpers (loads `app.ts` in Node with `.css` stubbed) |
| `client/main.ts` | entry point; replaces WP-00's placeholder |
| `.planning/plans/assets/WP-A2/gen-synthetic-ksfo.ts` | deterministic generator of the fixture |
| `.planning/plans/assets/WP-A2/synthetic-ksfo.jsonl` | the fixture, committed with this plan: 330 lines, 982,254 bytes, SHA-256 `fbea55a1cc497da63caf5b2da0d7b9832e01f772036302427da8ab7bc04eb8ab` |

---

### Task 1: App wiring and its pure helpers

**Files:**
- Create: `client/app.test.ts`, `client/app.ts`
- Test: `client/app.test.ts`

**Interfaces:**
- Consumes:
  - WP-00: `ClientConfig`, `RenderState`, `ModelManifest`, `ModelManifestEntry` (`client/types.ts`); `Airport` (`shared/airports.ts`); `StatusBrief`, `ViewResponse`, `ChaseResponse` (`shared/api.ts`).
  - V1 `createViewer`. V2 `AircraftLayer`. V3 `ChaseModel`. V4 `ChaseCamera`. V5 `addRunways`. V6 `mountHud`, `mountBanner`, `mountAttribution`. V7 `ApiClient`. V8 `BenchRecorder`, including its extra `destroy()`. I2 `TrackRegistry`. C3 `RenderClock` and `MIN_DELAY_S` (`client/track/delay.ts`).
  - Files: `public/airports/heroes.json` (T1) and `public/models/manifest.json` (V3), fetched at `${import.meta.env.BASE_URL}…`.
- Produces:
  - `startApp(root: HTMLElement, cfg: ClientConfig): Promise<{ stop(): void }>` (PLAN.md §4 A2).
  - Extra exports: `viewRadiusNm(cameraHeightM: number): number` · `placedHeightM(hM: number, onGround: boolean, terrainM: number | null): number` · `interface AppParams { hex: string | null; bench: boolean; airport: string | null }` · `readParams(search: string): AppParams` · `attributionFor(model: ModelManifestEntry | null): string[]` · `statusShown(status: StatusBrief, failedPolls: number): StatusBrief`.

The rules the test pins:
- **`viewRadiusNm`:** the camera height in nm, rounded up to a multiple of 10 nm and clamped to 20–250 nm. A NaN height gives 250. The steps keep the ApiClient's per-view `since` key stable during small zooms. 20 nm covers a chase. 250 nm is the server's cap.
- **`placedHeightM`:** on the ground it returns the terrain height. In the air it returns `max(hM, terrain)`. Without a loaded tile it returns `hM`.
- **`readParams`:** `hex` is trimmed, lower-cased and must match `~?[0-9a-f]{6}`, else it is null. `bench` is true only for `bench=1`. `airport` is upper-cased, and empty gives null.
- **`attributionFor`:** returns the adsb.lol ODbL line, the OurAirports line and, with a model, `3D model: <author>, <SPDX id>`. The SPDX id is the manifest licence up to its first colon.
- **`statusShown`:** after 3 or more failed polls in a row it returns `degraded: 'upstream-down'`. Otherwise it returns the server's status object unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// client/app.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import type { StatusBrief } from '../shared/api.ts'
import type { ModelManifestEntry } from './types.ts'

// app.ts imports viewer.ts, hud.ts and banner.ts, which import CSS for Vite. Node cannot load CSS, so this file loads
// every .css as an empty module. The hook lives only in this test's process: node --test runs each file in its own.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { attributionFor, placedHeightM, readParams, statusShown, viewRadiusNm } = await import('./app.ts')

test('view radius follows the camera height, in 10 nm steps, clamped to 20–250 nm', () => {
  assert.equal(viewRadiusNm(0), 20)
  assert.equal(viewRadiusNm(150), 20) // chasing on the runway
  assert.equal(viewRadiusNm(37_040), 20) // 20 nm up
  assert.equal(viewRadiusNm(37_041), 30)
  assert.equal(viewRadiusNm(100_000), 60) // 54 nm → next step
  assert.equal(viewRadiusNm(20_000_000), 250) // whole-Earth view
  assert.equal(viewRadiusNm(Number.NaN), 250)
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

test('attribution: adsb.lol ODbL, OurAirports, the model licence', () => {
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

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/app.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/app.ts' imported from …/client/app.test.ts`, then `ℹ tests 1`, `ℹ fail 1`.

- [ ] **Step 3: Write the implementation**

```ts
// client/app.ts
// The client app: one Cesium viewer with aircraft dots, runways and a chase model, fed by 1 Hz polls of the server and
// drawn on a delayed render clock. This file only wires the parts in scene/, track/, ui/, bench/ and api.ts together.
import { Cartesian2, Cartesian3, Cartographic, Math as CesiumMath, ScreenSpaceEventHandler, ScreenSpaceEventType } from 'cesium'
import type { Viewer } from 'cesium'
import type { Airport } from '../shared/airports.ts'
import type { ChaseResponse, StatusBrief, ViewResponse } from '../shared/api.ts'
import { ApiClient } from './api.ts'
import { BenchRecorder } from './bench/overlay.ts'
import { AircraftLayer } from './scene/aircraftLayer.ts'
import { ChaseCamera } from './scene/chaseCamera.ts'
import { ChaseModel } from './scene/model.ts'
import { addRunways } from './scene/runways.ts'
import { createViewer } from './scene/viewer.ts'
import { MIN_DELAY_S, RenderClock } from './track/delay.ts'
import { TrackRegistry } from './track/registry.ts'
import type { ClientConfig, ModelManifest, ModelManifestEntry, RenderState } from './types.ts'
import { mountAttribution, mountBanner } from './ui/banner.ts'
import { mountHud } from './ui/hud.ts'

const POLL_MS = 1000 // view and chase both poll at 1 Hz; TrackRegistry's pollPeriodS says the same
const PRUNE_AGE_S = 60 // forget an aircraft one minute after its newest sample
const FAILS_DOWN = 3 // failed polls in a row before the banner reports it
const START_HEIGHT_M = 60_000 // first view: straight down on the hero airport
const HEX = /^~?[0-9a-f]{6}$/
// Until the first reply. Nothing is drawn before it, so the source named here is never shown.
const NO_STATUS: StatusBrief = { source: 'adsblol', degraded: null, cellPeriodP95S: null, chasePeriodP95S: null }

/**
 * Radius of the view poll: the camera height in nm (a top-down view shows about ±0.6 h), rounded up to 10 nm so the
 * ApiClient's per-view `since` key survives small zooms, clamped to 20–250 nm (250 is the server's cap).
 * ponytail: a tilted camera sees further than its height; the far part of such a view stays empty until the user looks
 * down. Upgrade: size the circle from the frustum's ground footprint.
 */
export function viewRadiusNm(cameraHeightM: number): number {
  const nm = Math.ceil(cameraHeightM / 1852 / 10) * 10
  return Number.isFinite(nm) ? Math.min(250, Math.max(20, nm)) : 250
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
  hex: string | null // ?hex=a1b2c3: chase this aircraft from the start (G3)
  bench: boolean // ?bench=1: bench overlay, 'b' downloads the report
  airport: string | null // ?airport=LLBG: first view over this hero (default: the first in heroes.json)
}

export function readParams(search: string): AppParams {
  const q = new URLSearchParams(search)
  const hex = (q.get('hex') ?? '').trim().toLowerCase()
  const airport = (q.get('airport') ?? '').trim().toUpperCase()
  return { hex: HEX.test(hex) ? hex : null, bench: q.get('bench') === '1', airport: airport === '' ? null : airport }
}

/** Credit lines for the attribution box. mountAttribution adds "Not for navigation"; Cesium shows terrain and imagery credits. */
export function attributionFor(model: ModelManifestEntry | null): string[] {
  const lines = ['Flight data © adsb.lol contributors, ODbL 1.0', 'Airports: OurAirports (public domain)']
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

/**
 * Builds the viewer in root and runs the app until stop(). Loops:
 * - every second: view(camera centre, viewRadiusNm(camera height)) and, while an aircraft is selected, chase(hex);
 *   every reply goes straight into the TrackRegistry (between frames, so re-join blends stay continuous).
 * - every frame (scene.preUpdate: after Cesium applies mouse input to the camera, before it updates primitives and
 *   renders, so camera and model move in the same frame): RenderClock → states → layer; for the selected aircraft
 *   also model, chase camera, HUD, banner and bench.
 * Click a dot to chase it (click it again or press Esc to let go). Runways and the model are optional: if their
 * files fail to load, the app runs without them. createViewer failing (terrain unreachable) rejects.
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

  // Overlays live in one element so stop() removes them together (mountAttribution returns no handle).
  const ui = document.createElement('div')
  root.append(ui)
  const hud = mountHud(ui)
  const banner = mountBanner(ui)
  mountAttribution(ui, attributionFor(entry))
  const runways = addRunways(viewer, airports)
  const layer = new AircraftLayer(viewer)
  const chaseCam = new ChaseCamera(viewer)
  const api = new ApiClient(cfg.apiBase)
  const registry = new TrackRegistry({ pollPeriodS: POLL_MS / 1000 })
  const clock = new RenderClock(MIN_DELAY_S)
  const bench = params.bench ? new BenchRecorder(viewer, { label: params.hex ?? 'free' }) : null
  bench?.mountOverlay(ui)
  ;(window as unknown as { viewer?: Viewer }).viewer = viewer // console access for debugging and G3, as in WP-00

  const home = airports.find((a) => a.ident === params.airport) ?? airports[0]
  if (home) viewer.camera.setView({ destination: Cartesian3.fromDegrees(home.lon, home.lat, START_HEIGHT_M) })

  let selected: string | null = params.hex // ?hex= is chased from the start; the camera engages at its first state
  let chased: RenderState | null = null // the selected aircraft as drawn in the last frame that had it
  let status = NO_STATUS
  let failedPolls = 0
  let stopped = false
  let lastFrameMs: number | null = null
  const carto = new Cartographic()

  function select(hex: string | null): void {
    if (hex === selected) return
    chaseCam.release() // also resets its heading, so the next chase starts behind the new aircraft
    selected = hex
    chased = null
  }

  function frame(): void {
    const now = performance.now()
    const dtS = lastFrameMs === null ? 0 : Math.min(1, (now - lastFrameMs) / 1000)
    lastFrameMs = now
    const shown = statusShown(status, failedPolls)
    const states = api.ready ? registry.states(clock.tick(api.serverNowMs(), registry.delayTargetS(selected), dtS)) : []
    layer.update(states, selected)
    const s = selected === null ? null : (states.find((x) => x.hex === selected) ?? null)
    let clearanceM: number | null = null
    if (s !== null) {
      const terrainM = viewer.scene.globe.getHeight(Cartographic.fromDegrees(s.lon, s.lat, 0, carto)) ?? null
      const placed: RenderState = { ...s, hM: placedHeightM(s.hM, s.onGround, terrainM) }
      model?.update(placed)
      clearanceM = chaseCam.update(placed, dtS).clearanceM
      chased = placed
    }
    // No state (before the first sample, pruned, or a gap > 2 min): the model goes like the dot; the camera stays put.
    if (model) model.show = s !== null
    hud.update(s, shown)
    banner.update(shown, s)
    bench?.frame(s, clearanceM)
  }
  const removeFrame = viewer.scene.preUpdate.addEventListener(frame)

  /** Centre and radius of the view poll: the chased aircraft, else the globe point at the canvas centre, else below the camera. */
  function viewCircle(): { lat: number; lon: number; nm: number } {
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
    const v = viewCircle()
    const jobs: Promise<ViewResponse | ChaseResponse>[] = [api.view(v.lat, v.lon, v.nm)]
    if (selected !== null) jobs.push(api.chase(selected))
    const results = await Promise.allSettled(jobs)
    if (stopped) return
    let ok = false
    for (const r of results) {
      if (r.status === 'rejected') continue
      registry.ingest(r.value.samples)
      status = r.value.status
      ok = true
    }
    if (ok) failedPolls = 0
    else if (failedPolls++ === 0) console.warn('FlightHopper: poll failed:', (results[0] as PromiseRejectedResult).reason)
    if (api.ready) registry.prune(api.serverNowMs(), PRUNE_AGE_S)
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
  const clicks = new ScreenSpaceEventHandler(viewer.scene.canvas)
  clicks.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
    const hex = layer.pick(e.position)
    if (hex !== null) select(hex === selected ? null : hex)
  }, ScreenSpaceEventType.LEFT_CLICK)
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
      clicks.destroy()
      bench?.destroy()
      hud.destroy()
      banner.destroy()
      ui.remove()
      chaseCam.release()
      model?.destroy()
      layer.destroy()
      runways.destroy()
      viewer.destroy()
      delete (window as unknown as { viewer?: Viewer }).viewer
    },
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/app.test.ts`
Expected: PASS — `ℹ tests 5`, `ℹ pass 5`, `ℹ fail 0`.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit 2>&1 | grep -E '^client/app'`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add client/app.ts client/app.test.ts
git commit -m "feat(client): startApp wires viewer, tracks, chase camera, HUD and 1 Hz polling" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Entry point

**Files:**
- Modify: `client/main.ts` (replaces the WP-00 placeholder)

**Interfaces:**
- Consumes: `startApp` (Task 1), `readConfig` (V1 `client/config.ts`), and the `#globe` element of `index.html` (WP-00, unchanged).
- Produces: the page that Vite serves at `/` and builds into `dist/`. The A1 server serves `dist/` too.

- [ ] **Step 1: Replace `client/main.ts`**

```ts
// client/main.ts
// Entry point loaded by index.html: settings from the Vite env (.env.local), then the app in #globe.
// A startup error (bad setting, terrain unreachable) is shown on the page, not only in the console.
import { startApp } from './app.ts'
import { readConfig } from './config.ts'

const root = document.getElementById('globe') ?? document.body
try {
  await startApp(root, readConfig(import.meta.env))
} catch (e) {
  const box = document.createElement('pre')
  box.style.cssText =
    'position:fixed;left:16px;right:16px;bottom:16px;z-index:20;margin:0;padding:8px 10px;border-radius:4px;' +
    'font:13px/1.4 ui-monospace,Menlo,monospace;white-space:pre-wrap;color:#fff;background:#8b1a1a'
  box.textContent = `FlightHopper could not start: ${e instanceof Error ? e.message : String(e)}`
  document.body.append(box)
  throw e
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit 2>&1 | grep -E '^client/(app|main)'`
Expected: no output.

- [ ] **Step 3: Build**

Run: `npx vite build && ls dist`
Expected: `✓ built in …` with the chunk-size warning, then `airports  assets  cesiumStatic  index.html  models`.

- [ ] **Step 4: Commit**

```bash
git add client/main.ts
git commit -m "feat(client): main entry starts the app and shows startup errors on the page" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Synthetic KSFO replay fixture

**Files:**
- Create: `.planning/plans/assets/WP-A2/gen-synthetic-ksfo.ts`
- The committed `.planning/plans/assets/WP-A2/synthetic-ksfo.jsonl` is its output.

**Interfaces:**
- Consumes: `destination`, `bearingDeg`, `distanceNm` (WP-00 `shared/geo.ts`) and `geoidN` (WP-00 `shared/geoid.ts`). It writes the `RecordLine` format (WP-00 `server/recording.ts`), which `makeReplay` (S2) reads through `REPLAY_FILES` (A1). The runway numbers are copied from `public/airports/heroes.json` (T1): 28R threshold 37.61392406152527, −122.35807660762543, 298°, −28.3 m HAE; 1R threshold 37.60768835105868, −122.38015132095961, 28°, −28.65 m HAE.
- Produces: the fixture described in the Architecture table.

The models behind the numbers:
- **SYN101:** `x` is the distance past the 28R threshold along 298°. The height above the threshold is `15 − x·tan 3°` down to 10 m. A cubic Hermite flare over 400 m then takes it to 0 m, with the slope going from −3° to −0.45° (about 110 fpm at touchdown). Positions are computed on the great circle through the threshold, so the approach is exactly on the extended centreline.
- **SYN202, SYN303, SYN404, SYN505:** integrated with `destination()` steps of 0.02 s.
- **Position times:** each poll's `seen_pos` is a deterministic 0.05–0.95 s, which gives strictly increasing position times. A stationary aircraft on the ground reports every 5 s, as surface positions do. MLAT adds ≤ 20 m of scatter, ±3 kt and ±2°.
- **Envelope:** `now` = epoch + i s. `tSendMs` is 45–74 ms before `now` and `tRecvMs` 95–154 ms after it. `url` starts with `synthetic:`, so nobody mistakes it for a recorded request.

- [ ] **Step 1: Write the generator**

```ts
// .planning/plans/assets/WP-A2/gen-synthetic-ksfo.ts
// Synthetic replay fixture for the whole app: 330 adsb.lol-style polls (RecordLine JSONL, 1 Hz, 40 nm around KSFO)
// holding five invented aircraft, printed to stdout. Run from the repository root:
//   node .planning/plans/assets/WP-A2/gen-synthetic-ksfo.ts > .planning/plans/assets/WP-A2/synthetic-ksfo.jsonl
// Deterministic (fixed epoch, no randomness): every run prints the same bytes.
// The aircraft use unallocated ICAO addresses 000a01–000a05, SYN callsigns and invalid N-numbers (N0…), so nothing
// here can be mistaken for a real flight. Runway numbers are from public/airports/heroes.json (WP-T1, 2026-09-22).
import { bearingDeg, destination, distanceNm } from '../../../../shared/geo.ts'
import { geoidN } from '../../../../shared/geoid.ts'

const T0_MS = Date.UTC(2026, 8, 22, 18, 0, 0) // 11:00 PDT
const POLLS = 330
const DT = 0.02 // s, integration step
const T_MIN = -2 // s: the first poll's positions are up to 1 s old
const KT = 1852 / 3600 // m/s per knot
const FT = 0.3048
const FPM = FT / 60 // m/s per ft/min
const QNH = 1016.0 // hPa (ADS-B reports QNH in 0.8 hPa steps: 1016.0 is one)
const TAN3 = Math.tan((3 * Math.PI) / 180)
const KSFO = { lat: 37.6188, lon: -122.3758 } // the recorder's KSFO centre (tools/record-cells.ts)
const RWY_28R = { lat: 37.61392406152527, lon: -122.35807660762543, hdg: 298, haeM: -28.3 } // landing threshold
const RWY_1R = { lat: 37.60768835105868, lon: -122.38015132095961, hdg: 28, haeM: -28.65 }

/** One point of a flight path. h: WGS84 ellipsoidal metres, null = on the ground. trk null = no valid track (stationary). */
interface Row {
  t: number
  lat: number
  lon: number
  h: number | null
  v: number // ground speed, m/s
  trk: number | null
  vs: number // m/s
}

const frac = (x: number): number => x - Math.floor(x)
const lerp = (a: number, b: number, u: number): number => a + (b - a) * Math.min(1, Math.max(0, u))
const wrap360 = (d: number): number => ((d % 360) + 360) % 360
/** x to a multiple of step; steps below 1 divide by an integer so 0.1 prints as 0.1, not 0.30000000000000004. */
const round = (x: number, step: number): number => (step < 1 ? Math.round(x / step) / Math.round(1 / step) : Math.round(x / step) * step)
/** Deterministic noise in [−1, 1]. */
const noise = (i: number, k: number): number => 2 * frac(Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) - 1

function run(step: (t: number) => Row): Row[] {
  const rows: Row[] = []
  for (let n = 0; T_MIN + n * DT <= POLLS + 2; n++) rows.push(step(T_MIN + n * DT))
  return rows
}

/** Linear interpolation between integration rows (track from the earlier row). */
function at(rows: Row[], t: number): Row {
  const k = Math.min(rows.length - 2, Math.max(0, Math.floor((t - T_MIN) / DT)))
  const [a, b] = [rows[k], rows[k + 1]]
  const u = (t - a.t) / DT
  const h = a.h === null || b.h === null ? (u < 0.5 ? a.h : b.h) : lerp(a.h, b.h, u)
  return { t, lat: lerp(a.lat, b.lat, u), lon: lerp(a.lon, b.lon, u), h, v: lerp(a.v, b.v, u), trk: a.trk, vs: lerp(a.vs, b.vs, u) }
}

// ---------- SYN101: A320 on a 3° ILS to 28R from 10 nm, flare, touchdown, rollout ----------
// x = metres past the 28R threshold along 298° (negative on final). Threshold crossing height 15 m (50 ft), so the
// glide path meets the runway 286 m in; the flare starts at 10 m and touches down 400 m later at ~110 fpm.
const X_FLARE = 5 / TAN3
const X_TD = X_FLARE + 400

function heightAbove28R(x: number): number | null {
  if (x <= X_FLARE) return 15 - x * TAN3
  if (x >= X_TD) return null
  const u = (x - X_FLARE) / 400
  const [m0, m1] = [-TAN3 * 400, -0.15 * TAN3 * 400] // cubic Hermite: 10 m → 0 m, slope −3° → −0.45°
  return 10 * (2 * u ** 3 - 3 * u ** 2 + 1) + m0 * (u ** 3 - 2 * u ** 2 + u) + m1 * (u ** 3 - u ** 2)
}

function speed28R(x: number): number {
  if (x <= -9260) return lerp(170, 145, (x + 18_520) / 9260) * KT // 10 → 5 nm: 170 → 145 kt
  if (x <= -7408) return lerp(145, 138, (x + 9260) / 1852) * KT // 5 → 4 nm: → 138 kt (final approach speed)
  if (x <= X_FLARE) return 138 * KT
  return lerp(138, 132, (x - X_FLARE) / 400) * KT // bleeds 6 kt in the flare
}

const posOn28R = (x: number): { lat: number; lon: number } => destination(RWY_28R.lat, RWY_28R.lon, RWY_28R.hdg, x / 1852)

function arrival(): Row[] {
  let x = -18_520
  let v = speed28R(x)
  return run((t) => {
    const air = heightAbove28R(x)
    if (air !== null) v = speed28R(x)
    else if (v > 30 * KT) v -= 2.0 * DT // autobrake
    else if (v > 15 * KT) v -= 0.8 * DT // to taxi speed, then hold it
    const p = posOn28R(x)
    const hi = heightAbove28R(x + 0.5)
    const lo = heightAbove28R(x - 0.5)
    const row: Row = {
      t,
      ...p,
      h: air === null ? null : RWY_28R.haeM + air,
      v,
      trk: bearingDeg(p.lat, p.lon, posOn28R(x + 50).lat, posOn28R(x + 50).lon),
      vs: air === null || hi === null || lo === null ? 0 : (hi - lo) * v,
    }
    x += v * DT
    return row
  })
}

// ---------- SYN202: B738 lined up on 1R, takeoff at t = 40 s, right turn to 118° at 1,000 ft, climb to 10,000 ft ----------
function departure(): Row[] {
  let { lat, lon } = RWY_1R
  let h: number | null = null
  let v = 0
  let vs = 0
  let trk = RWY_1R.hdg
  return run((t) => {
    if (t >= 40) {
      if (h === null) {
        v += 2.2 * DT
        if (v >= 150 * KT) h = RWY_1R.haeM // rotate
      } else {
        v = Math.min(250 * KT, v + 0.6 * DT)
        const mslFt = (h - geoidN(lat, lon)) / FT
        vs = mslFt < 9800 ? Math.min(2500 * FPM, vs + 3 * DT) : Math.max(0, vs - 1 * DT) // level off at 10,000 ft
        if (h - RWY_1R.haeM > 1000 * FT && trk < 118) trk = Math.min(118, trk + 3 * DT) // standard-rate right turn
      }
    }
    const row: Row = { t, lat, lon, h, v, trk: v > 0 ? trk : null, vs }
    const p = destination(lat, lon, trk, (v * DT) / 1852)
    ;({ lat, lon } = p)
    if (h !== null) h += vs * DT
    return row
  })
}

// ---------- SYN303: B77W cruising FL350 on 135° at 480 kt, from 35 nm north-west of KSFO ----------
function cruise(): Row[] {
  let { lat, lon } = destination(KSFO.lat, KSFO.lon, 315, 35)
  const v = 480 * KT
  return run((t) => {
    const row: Row = { t, lat, lon, h: 36_125 * FT, v, trk: 135, vs: 0 } // alt_geom 36,125 ft with alt_baro FL350
    ;({ lat, lon } = destination(lat, lon, 135, (v * DT) / 1852))
    return row
  })
}

// ---------- SYN404: E75L (ADS-B v0) in a right-hand hold at 6,000 ft, inbound 298°, 16 nm south-east of KSFO ----------
function hold(): Row[] {
  const fix = destination(KSFO.lat, KSFO.lon, 118, 16)
  const v = 210 * KT
  let { lat, lon } = destination(fix.lat, fix.lon, 118, (v * 30) / 1852) // 30 s before the fix
  let trk = 298
  return run((t) => {
    const tau = (t - T_MIN) % 240 // 30 s inbound, 60 s turn, 60 s outbound, 60 s turn, 30 s inbound
    const turning = (tau >= 30 && tau < 90) || (tau >= 150 && tau < 210)
    const row: Row = { t, lat, lon, h: 6000 * FT, v, trk: wrap360(trk), vs: 0 } // h unused: v0 sends baro only
    if (turning) trk += 3 * DT
    else trk = tau < 30 || tau >= 210 ? 298 : 118 // snap the rounding of 60 s × 3°/s
    ;({ lat, lon } = destination(lat, lon, trk, (v * DT) / 1852))
    return row
  })
}

// ---------- SYN505: C172 seen only by MLAT, 3,500 ft, 300° at 105 kt ----------
function mlat(): Row[] {
  let { lat, lon } = destination(KSFO.lat, KSFO.lon, 160, 9)
  const v = 105 * KT
  return run((t) => {
    const row: Row = { t, lat, lon, h: null, v, trk: 300, vs: 0 }
    ;({ lat, lon } = destination(lat, lon, 300, (v * DT) / 1852))
    return row
  })
}

// ---------- readsb / adsb.lol v2 aircraft objects ----------

interface Plane {
  k: number
  hex: string
  flight: string
  r: string
  t: string
  category: string
  squawk: string
  kind: 'v2' | 'v0' | 'mlat'
  mcpFt: number | null
  baroFt?: number // fixed pressure altitude (cruise, hold, MLAT); otherwise from the height
  rows: Row[]
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6

/** The object one poll at now (s since T0, integer i) shows for this aircraft. */
function object(p: Plane, i: number): Record<string, unknown> {
  // Position message times: 1–2 per second in the air; every 5 s for a stationary aircraft on the ground.
  let seenPos = 0.05 + 0.9 * frac(0.6180339887 * i + 0.3183 * p.k)
  let s = at(p.rows, i - seenPos)
  if (s.h === null && s.v === 0) {
    const tPos = 5 * Math.floor((i + 0.3) / 5) - 0.3
    seenPos = i - tPos
    s = at(p.rows, tPos)
  }
  const seen = Math.min(seenPos, 0.05 + 0.5 * frac(0.4142 * i + 0.27 * p.k))
  let { lat, lon } = s
  let gs = s.v / KT
  let trk = s.trk
  if (p.kind === 'mlat') {
    const d = destination(lat, lon, 360 * frac(0.1 * i + p.k), (20 * Math.abs(noise(i, p.k))) / 1852) // ≤ 20 m of scatter
    ;({ lat, lon } = d)
    gs += 3 * noise(i, p.k + 1)
    if (trk !== null) trk = wrap360(trk + 2 * noise(i, p.k + 2))
  }
  const ground = s.h === null && p.kind !== 'mlat'
  const o: Record<string, unknown> = { hex: p.hex, type: p.kind === 'mlat' ? 'mlat' : 'adsb_icao', flight: p.flight, r: p.r, t: p.t }
  if (ground) {
    o.alt_baro = 'ground'
    o.gs = round(gs, 0.1)
    if (trk !== null) o.track = round(trk, 0.01)
    else o.true_heading = RWY_1R.hdg + 0.35
  } else {
    const hae = s.h
    const baroFt = p.baroFt ?? round(((hae! - geoidN(lat, lon)) / FT) - (QNH - 1013.25) * 27, 25)
    o.alt_baro = baroFt
    if (p.kind === 'v2') o.alt_geom = round(hae! / FT, 25)
    o.gs = round(gs, 0.1)
    if (trk !== null) o.track = round(trk, 0.01)
    o.baro_rate = round(s.vs / FPM, 64)
    if (p.kind === 'v2' && s.vs !== 0) o.geom_rate = round(s.vs / FPM + 32 * noise(i, p.k + 3), 64)
  }
  o.squawk = p.squawk
  if (p.kind !== 'mlat') o.emergency = 'none'
  o.category = p.category
  if (p.kind === 'v2' && !ground) o.nav_qnh = QNH
  if (p.mcpFt !== null && !ground) o.nav_altitude_mcp = p.mcpFt
  o.lat = round6(lat)
  o.lon = round6(lon)
  const mlatKind = p.kind === 'mlat'
  o.nic = mlatKind ? 0 : 8
  o.rc = mlatKind ? 0 : 186
  o.seen_pos = Math.round(seenPos * 1000) / 1000
  if (!mlatKind) {
    o.version = p.kind === 'v2' ? 2 : 0
    if (p.kind === 'v2') o.nic_baro = 1
    o.nac_p = p.kind === 'v2' ? 9 : 8
    o.nac_v = p.kind === 'v2' ? 2 : 1
    o.sil = p.kind === 'v2' ? 3 : 2
    o.sil_type = p.kind === 'v2' ? 'perhour' : 'unknown'
    if (p.kind === 'v2') o.gva = 2
    o.sda = p.kind === 'v2' ? 2 : 0
  }
  o.alert = 0
  o.spi = 0
  o.mlat = mlatKind ? ['gs', 'track', 'lat', 'lon', 'nic', 'rc'] : []
  o.tisb = []
  o.messages = 1000 * p.k + 9 * i
  o.seen = Math.floor(seen * 10) / 10 // adsb.lol rounds seen to 0.1 s; floor keeps seen ≤ seen_pos
  o.rssi = Math.round((-24 - 3 * p.k + 2 * noise(i, p.k + 4)) * 10) / 10
  o.dst = Math.round(distanceNm(KSFO.lat, KSFO.lon, lat, lon) * 1000) / 1000
  o.dir = Math.round(bearingDeg(KSFO.lat, KSFO.lon, lat, lon) * 10) / 10
  return o
}

const planes: Plane[] = [
  { k: 1, hex: '000a01', flight: 'SYN101  ', r: 'N0SYN1', t: 'A320', category: 'A3', squawk: '4521', kind: 'v2', mcpFt: 3000, rows: arrival() },
  { k: 2, hex: '000a02', flight: 'SYN202  ', r: 'N0SYN2', t: 'B738', category: 'A3', squawk: '4717', kind: 'v2', mcpFt: 10_000, rows: departure() },
  { k: 3, hex: '000a03', flight: 'SYN303  ', r: 'N0SYN3', t: 'B77W', category: 'A5', squawk: '2206', kind: 'v2', mcpFt: 35_008, baroFt: 35_000, rows: cruise() },
  { k: 4, hex: '000a04', flight: 'SYN404  ', r: 'N0SYN4', t: 'E75L', category: 'A3', squawk: '4462', kind: 'v0', mcpFt: null, baroFt: 6000, rows: hold() },
  { k: 5, hex: '000a05', flight: 'SYN505  ', r: 'N0SYN5', t: 'C172', category: 'A1', squawk: '1200', kind: 'mlat', mcpFt: null, baroFt: 3500, rows: mlat() },
]

const out: string[] = []
for (let i = 0; i < POLLS; i++) {
  const now = T0_MS + i * 1000
  const ac = planes.map((p) => object(p, i)).filter((o) => (o.dst as number) <= 40)
  const body = JSON.stringify({ ac, ctime: now, msg: 'No error', now, ptime: 0, total: ac.length })
  const tSendMs = now - 45 - ((i * 17) % 30)
  const tRecvMs = now + 95 + ((i * 29) % 60)
  const url = `synthetic:/v2/point/${KSFO.lat}/${KSFO.lon}/40`
  out.push(JSON.stringify({ v: 1, source: 'adsblol', url, status: 200, tSendMs, tRecvMs, bytes: Buffer.byteLength(body), body }))
}
process.stdout.write(out.join('\n') + '\n')
```

- [ ] **Step 2: Confirm the committed fixture is this script's output**

Run: `node .planning/plans/assets/WP-A2/gen-synthetic-ksfo.ts | cmp - .planning/plans/assets/WP-A2/synthetic-ksfo.jsonl && echo identical`
Expected: `identical`. If the asset is missing, write it with `node .planning/plans/assets/WP-A2/gen-synthetic-ksfo.ts > .planning/plans/assets/WP-A2/synthetic-ksfo.jsonl`. Then `wc -lc .planning/plans/assets/WP-A2/synthetic-ksfo.jsonl` prints `330 982254`, and `shasum -a 256` prints `fbea55a1cc497da63caf5b2da0d7b9832e01f772036302427da8ab7bc04eb8ab`.

- [ ] **Step 3: Read it back through the server's own recording code**

Run:

```bash
node --input-type=module -e "
import { readRecording, recordingToSamples } from './server/recording.ts'
const s = recordingToSamples(readRecording('.planning/plans/assets/WP-A2/synthetic-ksfo.jsonl'))
for (const hex of new Set(s.map((x) => x.hex))) {
  const xs = s.filter((x) => x.hex === hex)
  const at = (x) => '+' + ((x.tMs - xs[0].tMs) / 1000).toFixed(1) + ' s at ' + x.gsKt + ' kt'
  const down = xs.find((x, i) => i > 0 && x.onGround && !xs[i - 1].onGround)
  const up = xs.find((x, i) => i > 0 && !x.onGround && xs[i - 1].onGround)
  console.log([hex, xs[0].callsign, xs[0].quality, xs.length + ' samples', down && 'touchdown ' + at(down), up && 'liftoff ' + at(up)].filter(Boolean).join(' '))
}
"
```

Expected:

```text
000a01 SYN101 adsb2 330 samples touchdown +250.9 s at 127.6 kt
000a02 SYN202 adsb2 298 samples liftoff +75.7 s at 150.4 kt
000a03 SYN303 adsb2 330 samples
000a04 SYN404 adsb01 330 samples
000a05 SYN505 mlat 330 samples
```

SYN202 has 298 samples, not 330: while it stands still, the 5 s surface positions are re-served, and the deduper drops the repeats.

- [ ] **Step 4: Commit**

```bash
git add .planning/plans/assets/WP-A2/gen-synthetic-ksfo.ts .planning/plans/assets/WP-A2/synthetic-ksfo.jsonl
git commit -m "test(fixtures): synthetic KSFO replay (28R arrival, 1R departure, hold, cruise, MLAT)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Run the whole app on the fixture

**Files:** none. This is a manual check, and nothing is committed.

**Interfaces:**
- Consumes: A1 `npm run server` (`server/main.ts`: `ADSB_SOURCE`, `REPLAY_FILES`, `PORT`, and `dist/` served at `/`); WP-00 `npm run dev` (Vite serves `/` and proxies `/api` to `http://127.0.0.1:8787`).
- Produces: nothing new. This task shows the integrated app works before G3.

- [ ] **Step 1: Start the server on the fixture**

Run: `ADSB_SOURCE=replay REPLAY_FILES=.planning/plans/assets/WP-A2/synthetic-ksfo.jsonl npm run server`
Expected: `FlightHopper server on http://127.0.0.1:8787 (source replay)`.

The replay starts at the recording's first poll when the server starts, and it does not loop: `makeSource` builds the replay without `loop`. SYN101 touches down about 251 s after the server starts. After about 6.5 min (330 s plus the 60 s position age) the sky is empty. Restart the server to watch again.

- [ ] **Step 2: Open the app**

Run `npm run dev` in a second terminal, and open `http://localhost:5173/`. Alternatively, run `npm run build` and open `http://127.0.0.1:8787/`, which the server serves from `dist/`.
Expected:
- The globe looks straight down on KSFO from 60 km. Without `VITE_CESIUM_ION_TOKEN` it uses Re:Earth terrain and EOX imagery, both keyless (V1).
- Yellow threshold markers mark the runways.
- Five labelled dots: SYN101, SYN202 and SYN303 in blue (ADS-B v2), SYN404 in green (v0), SYN505 in amber (MLAT). SYN303 may be outside the first view.
- The attribution box is at the bottom right, and the console has no errors.

- [ ] **Step 3: Chase by clicking**

Click the SYN101 dot on final approach over the bay.
Expected:
- The camera jumps 150 m behind SYN101, 12° above it. The Cesium Air model points at the 28R markers.
- The HUD title reads `SYN101 · A320 · 000a01` with `GS`, `ALT … ft baro`, `VS` about −700 to −900 fpm, `TRK 298°`, `HDG 298°`, `AGE 0.0 s` and `SRC ADS-B v2 (replay)`.

Keep watching:
- The HUD counts down to `ALT GND`, and the model rolls out on the 28R runway plane.
- Press `Esc`: the HUD and the model disappear, and the camera stays where it is but can be moved again. The dot rolls on.

- [ ] **Step 4: The G3 URL form**

Restart the server, then open `http://localhost:5173/?hex=000a02&bench=1`.
Expected:
- With no click, the camera is behind SYN202 standing on 1R. The HUD shows `GS 0 kt`, `ALT GND`, `TRK —` and `HDG 028°`.
- At first the banner may say "Predicting (no fresh data)". The 5 s surface positions give a 6 s delay target, which the render clock reaches at 0.2 s/s.
- At about +40 s the takeoff roll starts. It lifts off at about +76 s and turns right at 1,000 ft.
- The bench box at the top left shows fps, long tasks, clearance and heap. Press `b` to download `bench-000a02-<time>.json`.

- [ ] **Step 5: What the validation run showed**

The run was on 2026-09-22 in the in-app Chromium, at 495 × 428 CSS px. The A1 server (`PORT=8790`) served this package's `vite build` and replayed the fixture. There was no ion token, so the terrain was Re:Earth and the imagery EOX.
- The five aircraft appeared in their colours over the bay.
- A real mouse click on SYN101 chased it. The HUD read `GS 151 kt · ALT 1,975 ft baro · VS −770 fpm · TRK 298° · HDG 298° · AGE 0.0 s · SRC ADS-B v2 (replay)`, and the camera was 31 m above the aircraft. At 325 ft the runway was straight ahead. After touchdown the HUD read `ALT GND`, `GS 121 kt`, with the model on the dark 28R runway plane and the 10R/10L markers ahead.
- `Esc` hid the HUD and the model, and the camera transform went back to identity.
- `/?hex=000a01` chased SYN101 from 3,000 ft with no click.
- `/?hex=000a02&bench=1` chased SYN202 from standstill (`HDG 028°`, `TRK —`) through liftoff, reaching `525 ft baro` and `+2,430 fpm`. The bench showed fps p50 60, p5 58, frame p95 17 ms, clearance min 31 m, 0 violations, and 3 long tasks during load (max 300 ms).

- [ ] **Step 6: Server stop**

Stop the server (Ctrl-C) while the page is open.
Expected:
- Within 3 s the banner reads "Live data unavailable". The validation run showed this.
- The chased aircraft goes on by dead reckoning. Once the render time passes its last sample, its HUD values turn italic "derived". 8 s later they turn orange "stale".
- The console shows `Failed to load resource` for each refused request, and one `FlightHopper: poll failed` warning.

---

### Task 5: WP gate

- [ ] **Step 1: This package's tests**

Run: `node --test client/app.test.ts`
Expected: `ℹ tests 5`, `ℹ pass 5`, `ℹ fail 0`.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit 2>&1 | grep -E '^client/(app|main)'`
Expected: no output. With every package merged, `npx tsc --noEmit` prints nothing at all.

- [ ] **Step 3: Build**

Run: `npx vite build`
Expected: `✓ built in …` (the chunk-size warning is expected).

- [ ] **Step 4: Full check in the worktree**

Run: `npm run check`
Expected: `tsc` prints nothing, and every test passes. The validation sandbox held every package and passed 452/452. On a worktree the count depends on what has been merged.

- [ ] **Step 5: Confirm there is nothing left to commit, and mark the gate**

```bash
git status --short
git commit --allow-empty -m "chore(client): WP-A2 gate passed (5 tests, tsc clean, vite build)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `git status --short` prints nothing before the commit. The branch `wp/A2` is ready to merge.

---

## Notes for G3, M4 and the orchestrator

- **G3:** replay a *recorded* KSFO arrival (`ADSB_SOURCE=replay REPLAY_FILES=<recording>`). Find the hex with `/api/view` or the census output. Open `/?hex=<hex>&bench=1` in a visible window, follow the aircraft from 3,000 ft to rollout, and press `b`. The bench counts every `preUpdate` frame from startup, including the frames before the first state. Browsers pause `requestAnimationFrame` in hidden tabs, so a bench run in a background tab records nothing. The synthetic fixture is for development, not for G3.
- **Attribution box vs Cesium's credit line (V6 layout):** below about 1,000 px of viewport width, Cesium wraps its credit line. The attribution box (bottom right, up to 45 vw) then covers part of the EOX credit and the fullscreen button. This was seen at 495 px. At 1,280 px the box and the credits do not overlap. EOX asks for a legible credit. A V6 follow-up could lift the box above Cesium's credit bar (for example `bottom: 40px`, like the HUD) or move it.
- **Runway plane vs terrain (M4):** the chased model and the ground dots sit on the loaded terrain. At KSFO 28R the terrain is about 1 m below the runway plane (V1 measured terrain − `thrHaeM` = −1.03 m), so on the runway the wheels are hidden under the plane and the dot is half covered. M4's runway-surface work fixes both. Until then `placedHeightM` keeps the model on the terrain, never under it.
- **Vertical (G2):** once, at 325 ft on final, the HUD's VS read −1,150 fpm while the fixture reported −704 fpm (C4's α-β filter on 25 ft `alt_geom` steps). Elsewhere on the approach it read −730 to −900. G2's vertical metric should show whether this matters on real data.
- **Dev server port:** `vite.config.ts` (WP-00) proxies `/api` only to `127.0.0.1:8787`. To check against a server on another port, build and let that server serve `dist/`, as the validation run did.

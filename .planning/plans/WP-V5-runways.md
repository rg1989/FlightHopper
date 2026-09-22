# WP-V5 — Runways Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw every hero runway as a flat plane at its threshold heights (WGS84 ellipsoidal), with a marker at each landing threshold. A landing aircraft then has a visible, correctly placed surface to touch down on, and the gap between that plane and the terrain can be seen and measured (input to M4).

**Architecture:** One module, `client/scene/runways.ts`, and a harness page.
- `runwayCorners(r)` is pure. It returns the paved rectangle from the two PHYSICAL ends (`ends[i].lat/lon`), offset by half the width to each side, perpendicular to the end-to-end bearing. The order is left and right of `ends[0]`, then right and left of `ends[1]` ("left" as seen from `ends[0]` looking at `ends[1]`), so the ring is a rectangle and not a bow tie. Each corner takes the height `thrHaeM` of its end. ponytail: the physical end takes its threshold's height. At a displaced threshold the plane is then off by (displacement / length) × (height difference between the ends): 6 cm at KSFO 28R, 21 cm at LOWI 08 and 1.4 m at LLBG 26 (1,969 ft displaced), always below `thrHaeM` in the golden data. Upgrade path (M4): extrapolate the end heights so that the plane passes through both thresholds.
- `addRunways(viewer, airports)` adds one batched `Primitive`: one `PolygonGeometry` per runway with `perPositionHeight: true`, a flat `PerInstanceColorAppearance` (asphalt grey, opaque) and `allowPicking: false`. With `perPositionHeight`, Cesium draws two flat triangles through the corners (checked in the test and in the Cesium source). That is a true plane between the two end heights. In the middle of a 3.6 km runway it lies L²/8R ≈ 0.26 m below a surface that follows the ellipsoid. Every corner is lifted `RUNWAY_LIFT_M` = 0.2 m, so the plane wins where the terrain matches it exactly. Polygon offset would not help: Cesium's logarithmic depth writes `gl_FragDepth`, which bypasses polygon offset. For each threshold (`thrLat`, `thrLon`, `thrHaeM` + lift) it adds one entity with a yellow point and the end's ident as a label. The markers are visible through terrain and hidden beyond 30 km. `destroy()` removes exactly the primitive and the entities it added.
- Consumer: A2 calls `addRunways(viewer, heroes)` once, with `public/airports/heroes.json` (T1). G3 needs "runway planes drawn; residual terrain − plane along centreline reported", and the harness prints that residual.

**Tech Stack:** Node ≥ 24.2 (native TypeScript), `node:test`, TypeScript 7 (type-check only), CesiumJS 1.145 (`PolygonGeometry`, `Primitive`, `PerInstanceColorAppearance`, entities, `sampleTerrainMostDetailed` in the harness), Vite 8 (JSON import with `with { type: 'json' }`, harness page). No new dependencies.

**Wave:** 1 (parallel; depends only on WP-00). **Estimated:** 1.5 h. **Validated:** on 2026-09-22 (Node v25.2.1, TypeScript 7.0.2, Vite 8.3.0, CesiumJS 1.145.0), every file below was run in the shared Wave 1 sandbox:
- `node --test client/scene/runways.test.ts` passed 8/8. `addRunways` is tested in Node against a stand-in viewer. Cesium labels need a DOM only when they are rendered, and entities create them only then.
- `npx tsc --noEmit` reported no errors in `client/scene/runways*` or `harness/runways.ts`.
- Each RED step below quotes the real output from a clean WP-00 tree.
- `harness/runways.html` was checked in a browser under `vite --port 5301` with Re:Earth terrain and EOX imagery. At KSFO, LLBG and LOWI the planes lie on the runways in the imagery, and every threshold marker sits at the correct end of its runway. The console had no errors. The residuals it printed are listed under "Measured" below.
- The code blocks of this plan were then extracted into a clean WP-00 tree. There `npm test` reported 48/48 and `tsc --noEmit` was clean for the whole tree.

**Measured** (harness, Re:Earth terrain, terrain − plane in metres at 0/25/50/75/100 % of each centreline, without the lift; above +0.2 m the terrain hides the plane):

| Airport | Runway | 0 % | 25 % | 50 % | 75 % | 100 % |
|---|---|---|---|---|---|---|
| KSFO | 10L/28R | −0.43 | −0.42 | −0.69 | −0.16 | −0.69 |
| KSFO | 10R/28L | 0.12 | −0.31 | −0.26 | −0.82 | −0.44 |
| KSFO | 1L/19R | 0.00 | −1.10 | 0.35 | −0.54 | −0.13 |
| KSFO | 1R/19L | −1.00 | −1.56 | −0.44 | −1.19 | 0.02 |
| LLBG | 03/21 | −6.15 | −3.65 | −2.19 | −2.38 | −1.00 |
| LLBG | 08/26 | −1.05 | −0.11 | −0.80 | −1.04 | 1.19 |
| LLBG | 12/30 | −3.73 | −3.59 | −1.65 | −2.69 | −1.00 |
| LOWI | 08/26 | 0.83 | 0.53 | 0.40 | 0.10 | 0.52 |

At LOWI the terrain is 0.1–0.8 m above the plane, so the terrain hides most of the plane. At LLBG the plane floats up to 6 m above the terrain at the 03 end. A small part of these residuals can be the datum (Re:Earth blends in the EGM2008 geoid, while `thrHaeM` uses EGM96). The rest is DEM error and published-elevation error. This table is the M4 input ("plane vs `globe.clippingPolygons`").

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- **Heights** are WGS84 ellipsoidal metres (HAE). `thrHaeM` already includes the geoid (T1/WP-00), so this package never adds N.
- **Tests never touch the network.** `runwayCorners` and `addRunways` are tested in Node. Only the harness fetches terrain and imagery (keyless Re:Earth and EOX).
- **WP independence.** The harness builds its own keyless viewer with the same settings as WP-V1's `createViewer`, so this package depends only on WP-00.
- Erasable TypeScript only, and relative imports have a `.ts` extension. This package creates or edits only the files below.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `client/scene/runways.ts` | `runwayCorners`, `RUNWAY_LIFT_M`, `addRunways` |
| `client/scene/runways.test.ts` | corners against golden KSFO 10L/28R and every golden runway; `addRunways` against a stand-in viewer |
| `harness/runways.html`, `harness/runways.ts` | eyeball page: golden airports over Re:Earth + EOX, `?ap=KSFO\|LLBG\|LOWI`, residual table |

---

### Task 1: `runwayCorners`

**Files:**
- Create: `client/scene/runways.ts`, `client/scene/runways.test.ts`
- Test: `client/scene/runways.test.ts`

**Interfaces:**
- Consumes: `Runway`, `Airport` from `shared/airports.ts`; `bearingDeg`, `destination`, `distanceNm` from `shared/geo.ts` (WP-00); `data/fixtures/golden/airports-sample.json` (KSFO `runways[0]` has `ends` = [10L, 28R], 11,870 × 200 ft, `thrHaeM` −30.79 / −28.3)
- Produces: `runwayCorners(r: Runway): { lat: number; lon: number; h: number }[]` (4 corners, degrees and HAE metres)

- [ ] **Step 1: Write the failing test**

```ts
// client/scene/runways.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Airport } from '../../shared/airports.ts'
import { bearingDeg, distanceNm } from '../../shared/geo.ts'
import { runwayCorners } from './runways.ts'

const airports: Airport[] = JSON.parse(readFileSync(new URL('../../data/fixtures/golden/airports-sample.json', import.meta.url), 'utf8'))
const ksfo = airports.find((a) => a.ident === 'KSFO')!
const rwy = ksfo.runways.find((r) => r.ends[1].ident === '28R')! // ends: [10L, 28R]
const [e10L, e28R] = rwy.ends

const m = (lat1: number, lon1: number, lat2: number, lon2: number): number => distanceNm(lat1, lon1, lat2, lon2) * 1852
const turn = (from: number, to: number): number => ((to - from + 540) % 360) - 180
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)

test('KSFO 10L/28R: four corners, 10L end first, heights from each end', () => {
  const c = runwayCorners(rwy)
  assert.equal(c.length, 4)
  assert.deepEqual(c.map((p) => p.h), [-30.79, -30.79, -28.3, -28.3])
})

test('width: 200 ft across each physical end, centred on it', () => {
  const [a, b, c, d] = runwayCorners(rwy)
  near(m(a.lat, a.lon, b.lat, b.lon), 60.96, 0.01, 'width at 10L')
  near(m(c.lat, c.lon, d.lat, d.lon), 60.96, 0.01, 'width at 28R')
  for (const p of [a, b]) near(m(e10L.lat, e10L.lon, p.lat, p.lon), 30.48, 0.01, 'half width at 10L')
  for (const p of [c, d]) near(m(e28R.lat, e28R.lon, p.lat, p.lon), 30.48, 0.01, 'half width at 28R')
})

test('ring order: left then right of 10L, right then left of 28R (a rectangle, not a bow tie)', () => {
  const [a, b, c, d] = runwayCorners(rwy)
  const brg = bearingDeg(e10L.lat, e10L.lon, e28R.lat, e28R.lon) // 10L → 28R ≈ 117.9° true
  near(turn(brg, bearingDeg(e10L.lat, e10L.lon, a.lat, a.lon)), -90, 0.01, 'a is left of 10L')
  near(turn(brg, bearingDeg(e10L.lat, e10L.lon, b.lat, b.lon)), 90, 0.01, 'b is right of 10L')
  near(turn(brg, bearingDeg(e28R.lat, e28R.lon, c.lat, c.lon)), 90, 0.05, 'c is right of 28R')
  near(turn(brg, bearingDeg(e28R.lat, e28R.lon, d.lat, d.lon)), -90, 0.05, 'd is left of 28R')
})

test('length: both long sides equal the end-to-end distance, within 0.5 % of the published 11,870 ft', () => {
  const [a, b, c, d] = runwayCorners(rwy)
  const centre = m(e10L.lat, e10L.lon, e28R.lat, e28R.lon)
  near(m(b.lat, b.lon, c.lat, c.lon), centre, 0.05, 'right side')
  near(m(a.lat, a.lon, d.lat, d.lon), centre, 0.05, 'left side')
  near(centre, 11870 * 0.3048, 11870 * 0.3048 * 0.005, 'published length')
})

test('every golden runway: rectangle as wide as published, as long as its ends are apart', () => {
  for (const ap of airports) {
    for (const r of ap.runways) {
      const [a, b, c, d] = runwayCorners(r)
      const [x, y] = r.ends
      const name = `${ap.ident} ${x.ident}/${y.ident}`
      near(m(a.lat, a.lon, b.lat, b.lon), r.widthFt * 0.3048, 0.01, name)
      near(m(b.lat, b.lon, c.lat, c.lon), m(x.lat, x.lon, y.lat, y.lon), 0.05, name)
      assert.deepEqual([a.h, b.h, c.h, d.h], [x.thrHaeM, x.thrHaeM, y.thrHaeM, y.thrHaeM], name)
    }
  }
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/scene/runways.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '<repo>/client/scene/runways.ts' imported from <repo>/client/scene/runways.test.ts`, then `ℹ fail 1`.

- [ ] **Step 3: Write the implementation**

```ts
// client/scene/runways.ts
import type { Runway } from '../../shared/airports.ts'
import { bearingDeg, destination } from '../../shared/geo.ts'

/**
 * The paved rectangle of a runway: the two PHYSICAL ends (ends[i].lat/lon) ± half the width,
 * perpendicular to the end-to-end bearing. Order: left, right of ends[0], then right, left of ends[1]
 * ("left" = looking from ends[0] towards ends[1]), so the ring is a rectangle, not a bow tie.
 * h is WGS84 ellipsoidal metres. One bearing serves both ends: over a 4 km runway the great-circle
 * bearing turns < 0.03°, which moves a corner < 2 cm.
 * ponytail: each physical end takes its own THRESHOLD height (thrHaeM). At a displaced threshold the
 * plane is then off by (displacement / length) × (height difference): 6 cm at KSFO 28R, 21 cm at LOWI 08,
 * 1.4 m at LLBG 26 (1,969 ft displaced). Upgrade (M4): extrapolate the end heights so that the plane
 * passes through both thresholds.
 */
export function runwayCorners(r: Runway): { lat: number; lon: number; h: number }[] {
  const [a, b] = r.ends
  const brg = bearingDeg(a.lat, a.lon, b.lat, b.lon)
  const halfNm = (r.widthFt * 0.3048) / 2 / 1852
  const corner = (end: Runway['ends'][number], side: -90 | 90): { lat: number; lon: number; h: number } => ({
    ...destination(end.lat, end.lon, brg + side, halfNm),
    h: end.thrHaeM,
  })
  return [corner(a, -90), corner(a, 90), corner(b, 90), corner(b, -90)]
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/scene/runways.test.ts`
Expected: PASS — `ℹ tests 5`, `ℹ pass 5`, `ℹ fail 0`. The end-to-end distance of KSFO 10L/28R is 3,612.7 m against 3,618.0 m published (0.15 %).

- [ ] **Step 5: Commit**

```bash
git add client/scene/runways.ts client/scene/runways.test.ts
git commit -m "feat(scene): runway rectangle corners from physical ends and threshold heights" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `addRunways`

**Files:**
- Modify: `client/scene/runways.ts`, `client/scene/runways.test.ts` (complete files below)
- Test: `client/scene/runways.test.ts`

**Interfaces:**
- Consumes: `runwayCorners` (Task 1); `Airport` (WP-00); Cesium `Viewer` (`scene.primitives`, `entities`, `isDestroyed`), `Primitive`, `GeometryInstance`, `PolygonGeometry`, `PolygonHierarchy`, `PerInstanceColorAppearance`, `ColorGeometryInstanceAttribute`, entity point and label graphics
- Produces: `addRunways(viewer: Viewer, airports: Airport[]): { destroy(): void }` · extra export `RUNWAY_LIFT_M = 0.2`

- [ ] **Step 1: Write the failing test** (the complete file: Task 1's tests plus three `addRunways` tests)

```ts
// client/scene/runways.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Cartographic, EntityCollection, JulianDate, PolygonGeometry, Primitive, type GeometryInstance, type Viewer } from 'cesium'
import type { Airport } from '../../shared/airports.ts'
import { bearingDeg, distanceNm } from '../../shared/geo.ts'
import { addRunways, RUNWAY_LIFT_M, runwayCorners } from './runways.ts'

const airports: Airport[] = JSON.parse(readFileSync(new URL('../../data/fixtures/golden/airports-sample.json', import.meta.url), 'utf8'))
const ksfo = airports.find((a) => a.ident === 'KSFO')!
const rwy = ksfo.runways.find((r) => r.ends[1].ident === '28R')! // ends: [10L, 28R]
const [e10L, e28R] = rwy.ends

const m = (lat1: number, lon1: number, lat2: number, lon2: number): number => distanceNm(lat1, lon1, lat2, lon2) * 1852
const turn = (from: number, to: number): number => ((to - from + 540) % 360) - 180
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)

test('KSFO 10L/28R: four corners, 10L end first, heights from each end', () => {
  const c = runwayCorners(rwy)
  assert.equal(c.length, 4)
  assert.deepEqual(c.map((p) => p.h), [-30.79, -30.79, -28.3, -28.3])
})

test('width: 200 ft across each physical end, centred on it', () => {
  const [a, b, c, d] = runwayCorners(rwy)
  near(m(a.lat, a.lon, b.lat, b.lon), 60.96, 0.01, 'width at 10L')
  near(m(c.lat, c.lon, d.lat, d.lon), 60.96, 0.01, 'width at 28R')
  for (const p of [a, b]) near(m(e10L.lat, e10L.lon, p.lat, p.lon), 30.48, 0.01, 'half width at 10L')
  for (const p of [c, d]) near(m(e28R.lat, e28R.lon, p.lat, p.lon), 30.48, 0.01, 'half width at 28R')
})

test('ring order: left then right of 10L, right then left of 28R (a rectangle, not a bow tie)', () => {
  const [a, b, c, d] = runwayCorners(rwy)
  const brg = bearingDeg(e10L.lat, e10L.lon, e28R.lat, e28R.lon) // 10L → 28R ≈ 117.9° true
  near(turn(brg, bearingDeg(e10L.lat, e10L.lon, a.lat, a.lon)), -90, 0.01, 'a is left of 10L')
  near(turn(brg, bearingDeg(e10L.lat, e10L.lon, b.lat, b.lon)), 90, 0.01, 'b is right of 10L')
  near(turn(brg, bearingDeg(e28R.lat, e28R.lon, c.lat, c.lon)), 90, 0.05, 'c is right of 28R')
  near(turn(brg, bearingDeg(e28R.lat, e28R.lon, d.lat, d.lon)), -90, 0.05, 'd is left of 28R')
})

test('length: both long sides equal the end-to-end distance, within 0.5 % of the published 11,870 ft', () => {
  const [a, b, c, d] = runwayCorners(rwy)
  const centre = m(e10L.lat, e10L.lon, e28R.lat, e28R.lon)
  near(m(b.lat, b.lon, c.lat, c.lon), centre, 0.05, 'right side')
  near(m(a.lat, a.lon, d.lat, d.lon), centre, 0.05, 'left side')
  near(centre, 11870 * 0.3048, 11870 * 0.3048 * 0.005, 'published length')
})

test('every golden runway: rectangle as wide as published, as long as its ends are apart', () => {
  for (const ap of airports) {
    for (const r of ap.runways) {
      const [a, b, c, d] = runwayCorners(r)
      const [x, y] = r.ends
      const name = `${ap.ident} ${x.ident}/${y.ident}`
      near(m(a.lat, a.lon, b.lat, b.lon), r.widthFt * 0.3048, 0.01, name)
      near(m(b.lat, b.lon, c.lat, c.lon), m(x.lat, x.lon, y.lat, y.lon), 0.05, name)
      assert.deepEqual([a.h, b.h, c.h, d.h], [x.thrHaeM, x.thrHaeM, y.thrHaeM, y.thrHaeM], name)
    }
  }
})

// addRunways against a stand-in viewer: the scene's primitive list and an entity collection are all it touches.
// (Labels only need a DOM once Cesium renders them, so this runs in Node.)
function fakeViewer(): { viewer: Viewer; added: unknown[]; removed: unknown[]; entities: EntityCollection } {
  const added: unknown[] = []
  const removed: unknown[] = []
  const entities = new EntityCollection()
  const primitives = { add: (p: unknown) => (added.push(p), p), remove: (p: unknown) => (removed.push(p), true) }
  const viewer = { scene: { primitives }, entities, isDestroyed: () => false } as unknown as Viewer
  return { viewer, added, removed, entities }
}

const deg = (rad: number): number => (rad * 180) / Math.PI
const now = JulianDate.now()

test('addRunways: one batched polygon primitive for all runways, one marker per threshold', () => {
  const { viewer, added, entities } = fakeViewer()
  addRunways(viewer, airports)
  const runways = airports.flatMap((a) => a.runways)
  assert.equal(added.length, 1)
  const prim = added[0] as Primitive
  assert.ok(prim instanceof Primitive)
  assert.equal((prim.geometryInstances as unknown[]).length, runways.length)
  assert.equal(entities.values.length, runways.length * 2)
  const ksfoLabels = entities.values.slice(0, 8).map((e) => e.label!.text!.getValue(now))
  assert.deepEqual(ksfoLabels, ['10L', '28R', '10R', '28L', '1L', '19R', '1R', '19L'])
})

test('addRunways: the polygon sits on the corners, lifted RUNWAY_LIFT_M; the marker sits on the threshold', () => {
  const { viewer, added, entities } = fakeViewer()
  addRunways(viewer, [{ ...ksfo, runways: [rwy] }])
  const instance = ((added[0] as Primitive).geometryInstances as GeometryInstance[])[0]
  const geom = PolygonGeometry.createGeometry(instance.geometry as unknown as PolygonGeometry)!
  const v = geom.attributes.position!.values as unknown as number[]
  assert.equal(v.length, 4 * 3)
  const corners = runwayCorners(rwy)
  for (let i = 0; i < 4; i++) {
    const c = Cartographic.fromCartesian({ x: v[3 * i], y: v[3 * i + 1], z: v[3 * i + 2] } as never)
    near(deg(c.latitude), corners[i].lat, 1e-7, `corner ${i} lat`)
    near(deg(c.longitude), corners[i].lon, 1e-7, `corner ${i} lon`)
    near(c.height, corners[i].h + RUNWAY_LIFT_M, 0.01, `corner ${i} h`)
  }
  assert.equal(geom.indices!.length, 2 * 3) // two flat triangles: a plane, no subdivision
  const p = Cartographic.fromCartesian(entities.values[1].position!.getValue(now)!)
  near(deg(p.latitude), e28R.thrLat, 1e-7)
  near(deg(p.longitude), e28R.thrLon, 1e-7)
  near(p.height, e28R.thrHaeM + RUNWAY_LIFT_M, 0.01)
})

test('addRunways: destroy removes exactly what it added; no airports adds nothing', () => {
  const { viewer, added, removed, entities } = fakeViewer()
  entities.add({ id: 'someone-else' })
  const h = addRunways(viewer, airports)
  h.destroy()
  assert.deepEqual(removed, added)
  assert.deepEqual(entities.values.map((e) => e.id), ['someone-else'])
  const empty = fakeViewer()
  addRunways(empty.viewer, []).destroy()
  assert.equal(empty.added.length, 0)
  assert.equal(empty.removed.length, 0)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/scene/runways.test.ts`
Expected: FAIL — `SyntaxError: The requested module './runways.ts' does not provide an export named 'RUNWAY_LIFT_M'`, then `ℹ fail 1`.

- [ ] **Step 3: Write the implementation** (the complete file; `runwayCorners` is unchanged)

```ts
// client/scene/runways.ts
import {
  Cartesian2,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  DistanceDisplayCondition,
  GeometryInstance,
  LabelStyle,
  PerInstanceColorAppearance,
  PolygonGeometry,
  PolygonHierarchy,
  Primitive,
  VerticalOrigin,
  type Entity,
  type Viewer,
} from 'cesium'
import type { Airport, Runway } from '../../shared/airports.ts'
import { bearingDeg, destination } from '../../shared/geo.ts'

/**
 * The paved rectangle of a runway: the two PHYSICAL ends (ends[i].lat/lon) ± half the width,
 * perpendicular to the end-to-end bearing. Order: left, right of ends[0], then right, left of ends[1]
 * ("left" = looking from ends[0] towards ends[1]), so the ring is a rectangle, not a bow tie.
 * h is WGS84 ellipsoidal metres. One bearing serves both ends: over a 4 km runway the great-circle
 * bearing turns < 0.03°, which moves a corner < 2 cm.
 * ponytail: each physical end takes its own THRESHOLD height (thrHaeM). At a displaced threshold the
 * plane is then off by (displacement / length) × (height difference): 6 cm at KSFO 28R, 21 cm at LOWI 08,
 * 1.4 m at LLBG 26 (1,969 ft displaced). Upgrade (M4): extrapolate the end heights so that the plane
 * passes through both thresholds.
 */
export function runwayCorners(r: Runway): { lat: number; lon: number; h: number }[] {
  const [a, b] = r.ends
  const brg = bearingDeg(a.lat, a.lon, b.lat, b.lon)
  const halfNm = (r.widthFt * 0.3048) / 2 / 1852
  const corner = (end: Runway['ends'][number], side: -90 | 90): { lat: number; lon: number; h: number } => ({
    ...destination(end.lat, end.lon, brg + side, halfNm),
    h: end.thrHaeM,
  })
  return [corner(a, -90), corner(a, 90), corner(b, 90), corner(b, -90)]
}

/**
 * Drawn this far above the runway HAE so the plane wins against terrain that matches it exactly.
 * ponytail: a fixed lift, not polygon offset (Cesium's log depth writes gl_FragDepth, which bypasses
 * polygon offset). Where terrain is more than this above the plane, the terrain hides it: that
 * residual is what M4 measures and fixes (plane vs globe.clippingPolygons).
 */
export const RUNWAY_LIFT_M = 0.2

const ASPHALT = Color.fromCssColorString('#3a3a3a')
const MARKER_RANGE = new DistanceDisplayCondition(0, 30_000) // markers only near an airport

/**
 * Runway planes + threshold markers for these airports. The planes are one batched, unpickable
 * Primitive: PolygonGeometry with perPositionHeight draws two flat triangles through the corners,
 * i.e. a plane between the two end heights (mid-runway it sits ≈ L²/8R ≈ 0.26 m below a surface
 * parallel to the ellipsoid for KSFO 28R's 3.6 km). Markers are entities (a point + the end's ident
 * at thrLat/thrLon/thrHaeM) that stay visible through terrain.
 */
export function addRunways(viewer: Viewer, airports: Airport[]): { destroy(): void } {
  const instances: GeometryInstance[] = []
  const markers: Entity[] = []
  for (const ap of airports) {
    for (const r of ap.runways) {
      const corners = runwayCorners(r).map((c) => Cartesian3.fromDegrees(c.lon, c.lat, c.h + RUNWAY_LIFT_M))
      instances.push(
        new GeometryInstance({
          geometry: new PolygonGeometry({
            polygonHierarchy: new PolygonHierarchy(corners),
            perPositionHeight: true,
            vertexFormat: PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
          }),
          attributes: { color: ColorGeometryInstanceAttribute.fromColor(ASPHALT) },
        }),
      )
      for (const e of r.ends) {
        markers.push(
          viewer.entities.add({
            position: Cartesian3.fromDegrees(e.thrLon, e.thrLat, e.thrHaeM + RUNWAY_LIFT_M),
            point: {
              pixelSize: 7,
              color: Color.YELLOW,
              outlineColor: Color.BLACK,
              outlineWidth: 1,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              distanceDisplayCondition: MARKER_RANGE,
            },
            label: {
              text: e.ident,
              font: '13px sans-serif',
              style: LabelStyle.FILL_AND_OUTLINE,
              fillColor: Color.WHITE,
              outlineColor: Color.BLACK,
              outlineWidth: 3,
              verticalOrigin: VerticalOrigin.BOTTOM,
              pixelOffset: new Cartesian2(0, -8),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              distanceDisplayCondition: MARKER_RANGE,
            },
          }),
        )
      }
    }
  }
  const planes =
    instances.length === 0
      ? null
      : viewer.scene.primitives.add(
          new Primitive({
            geometryInstances: instances,
            appearance: new PerInstanceColorAppearance({ flat: true, translucent: false }),
            asynchronous: false,
            allowPicking: false,
          }),
        )
  return {
    destroy(): void {
      if (viewer.isDestroyed()) return
      if (planes) viewer.scene.primitives.remove(planes)
      for (const m of markers) viewer.entities.remove(m)
    },
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/scene/runways.test.ts`
Expected: PASS — `ℹ tests 8`, `ℹ pass 8`, `ℹ fail 0`.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/runways|harness/runways'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 6: Commit**

```bash
git add client/scene/runways.ts client/scene/runways.test.ts
git commit -m "feat(scene): runway planes (flat polygon primitive) and threshold markers" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Harness page

**Files:**
- Create: `harness/runways.html`, `harness/runways.ts`
- Test: `npx tsc --noEmit`, then the harness page in a browser

**Interfaces:**
- Consumes: `addRunways` (Task 2); `Airport` (WP-00); `data/fixtures/golden/airports-sample.json` (KSFO, LLBG, LOWI); Cesium `Viewer`, `CesiumTerrainProvider.fromUrl`, `UrlTemplateImageryProvider`, `sampleTerrainMostDetailed`; `CESIUM_BASE_URL` from WP-00's `vite.config.ts`
- Produces: `/harness/runways.html?ap=<KSFO|LLBG|LOWI>` that sets `window.harness = { viewer, runways, residuals }`, where `residuals` is `{ rwy; f; planeH; terrainH; dM }[]` (dM = terrain − plane, metres)

- [ ] **Step 1: Write the harness**

```html
<!-- harness/runways.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Harness: runways</title>
    <style>
      html, body, #globe { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
      #status { position: absolute; top: 8px; left: 8px; z-index: 1; max-width: calc(100% - 32px); max-height: 60%; overflow: auto;
        padding: 6px 8px; font: 12px/1.4 ui-monospace, monospace; color: #fff; background: rgba(0, 0, 0, 0.65); white-space: pre; }
      #status a { color: #9cf; margin-right: 8px; }
    </style>
  </head>
  <body>
    <div id="globe"></div>
    <div id="status">loading…</div>
    <script type="module" src="./runways.ts"></script>
  </body>
</html>
```

```ts
// harness/runways.ts
// WP-V5 harness: /harness/runways.html?ap=KSFO|LLBG|LOWI draws the golden airports' runway planes over
// Re:Earth terrain + EOX imagery, flies to one airport and lists terrain − plane along each centreline
// (positive = terrain above the plane, which then hides it). Eyeball the planes against the terrain.
// ponytail: builds its own keyless viewer (the same settings as WP-V1's createViewer) so that WP-V5
// depends only on WP-00; the app uses createViewer.
import {
  BoundingSphere,
  Cartesian3,
  Cartographic,
  CesiumTerrainProvider,
  Credit,
  HeadingPitchRange,
  ImageryLayer,
  Math as CesiumMath,
  UrlTemplateImageryProvider,
  Viewer,
  sampleTerrainMostDetailed,
} from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import airportsJson from '../data/fixtures/golden/airports-sample.json' with { type: 'json' }
import { addRunways } from '../client/scene/runways.ts'
import type { Airport } from '../shared/airports.ts'

const airports = airportsJson as Airport[]
const status = document.getElementById('status')!
const ident = new URLSearchParams(location.search).get('ap') ?? 'KSFO'
const ap = airports.find((a) => a.ident === ident) ?? airports[0]

const viewer = new Viewer('globe', {
  terrainProvider: await CesiumTerrainProvider.fromUrl('https://terrain.reearth.land/cesium-mesh/ellipsoid'),
  baseLayer: new ImageryLayer(
    new UrlTemplateImageryProvider({
      url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg',
      maximumLevel: 14,
      credit: new Credit('EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025)', true),
    }),
  ),
  timeline: false,
  animation: false,
  geocoder: false,
  baseLayerPicker: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  homeButton: false,
  infoBox: false,
  selectionIndicator: false,
})
viewer.scene.globe.depthTestAgainstTerrain = true
const runways = addRunways(viewer, airports)

viewer.camera.flyToBoundingSphere(new BoundingSphere(Cartesian3.fromDegrees(ap.lon, ap.lat, ap.elevFt * 0.3048 + ap.nM), 1500), {
  offset: new HeadingPitchRange(CesiumMath.toRadians(200), CesiumMath.toRadians(-25), 5000),
  duration: 0,
})

// terrain − plane at 0, 25, 50, 75 and 100 % of each centreline (the plane is linear between the two end heights)
const rows = ap.runways.flatMap((r) =>
  [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const [a, b] = r.ends
    return { rwy: `${a.ident}/${b.ident}`, f, lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon), planeH: a.thrHaeM + f * (b.thrHaeM - a.thrHaeM) }
  }),
)
const heights = await sampleTerrainMostDetailed(viewer.terrainProvider, rows.map((r) => Cartographic.fromDegrees(r.lon, r.lat)))
const residuals = rows.map((r, i) => ({ rwy: r.rwy, f: r.f, planeH: r.planeH, terrainH: +heights[i].height.toFixed(2), dM: +(heights[i].height - r.planeH).toFixed(2) }))
;(window as unknown as { harness: object }).harness = { viewer, runways, residuals }

const links = airports.map((a) => `<a href="?ap=${a.ident}">${a.ident}</a>`).join('')
const table = ap.runways
  .map((r) => {
    const name = `${r.ends[0].ident}/${r.ends[1].ident}`
    return `${name.padEnd(8)}${residuals.filter((x) => x.rwy === name).map((x) => x.dM.toFixed(2).padStart(7)).join('')}`
  })
  .join('\n')
status.innerHTML = `${links}\n${ap.ident} terrain − plane (m) at 0/25/50/75/100 % of the centreline\n${table}`
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/runways|harness/runways'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Eyeball the harness**

Run: `npx vite --port 5305 --strictPort`, then open these pages. Wait about 10 s on each for the terrain samples and tiles.
- `http://localhost:5305/harness/runways.html?ap=KSFO`. Expected: KSFO from the north-north-east. Grey planes lie on all four runways of the imagery, and yellow markers sit at the thresholds: 28L/28R at the east ends, 10L/10R at the west ends, 1L/1R at the south ends and 19L/19R at the north ends. The 28L/28R markers are 300 ft inside the pavement (displaced thresholds). The status box lists terrain − plane per runway, all within about ±1.6 m. The console has no errors.
- `http://localhost:5305/harness/runways.html?ap=LOWI`. Expected: the Inn valley. The 08 marker is at the west end, 339 ft in. The plane shows only in patches, because the residuals are positive (terrain above the plane). That is the known M4 input, not a bug.
- `http://localhost:5305/harness/runways.html?ap=LLBG`. Expected: three planes on the three runways. The 26 marker is 1,969 ft in from the east end.
- In the console, `harness.residuals.length` is 5 × the airport's runway count (KSFO 20, LLBG 15, LOWI 5).
- In the console, set `harness.viewer.scene.primitives.get(1).show = false` and then `true` again. The imagery runways show through, and then the planes cover them again.

Stop the server.

- [ ] **Step 4: Commit**

```bash
git add harness/runways.html harness/runways.ts
git commit -m "test(harness): runway planes over Re:Earth terrain with terrain-minus-plane residuals" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: WP gate

- [ ] **Step 1: This package's tests**

Run: `node --test client/scene/runways.test.ts`
Expected: `ℹ tests 8`, `ℹ pass 8`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/runways|harness/runways'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Full check in the worktree**

Run: `npm run check`
Expected: `tsc` prints nothing. On a worktree branched from `wave-0` the counts are `ℹ tests 49`, `ℹ pass 49`, `ℹ fail 0` (41 from WP-00 + 8 here).

- [ ] **Step 4: Confirm there is nothing left to commit**

Run: `git status --short`
Expected: no output.

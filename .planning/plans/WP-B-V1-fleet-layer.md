# WP-B-V1 — Fleet Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In browse mode, draw every aircraft the way tar1090 users expect: a small top-down silhouette, rotated to its track and coloured by altitude (orange at the surface, then yellow, green, cyan, blue and violet, magenta at 40,000 ft and above, grey on the ground), with an altitude colour key along the bottom. It must stay fluid with thousands of aircraft on screen (target ≥ 50 FPS p50 at 5,000 on the user's Mac).

**Architecture:** Four modules and a harness page. All colours, shapes and mappings are FlightHopper's own. No code, table, icon or colour scale was taken from tar1090, dump1090 or readsb (GPL).
- `client/scene/altitudeColor.ts`: seven HSL stops of our own (0 ft hue 24°, 2,000 ft 50°, 6,000 ft 118°, 12,000 ft 182°, 20,000 ft 222°, 30,000 ft 268°, 40,000 ft 304°). Hue, saturation and lightness are interpolated linearly between the stops. Lightness dips in the green/cyan band so those colours stay readable on a light street map. Every colour is computed once at module load in 100 ft buckets (401 buckets, plus ground grey `rgb(128, 128, 128)` and unknown light grey `rgb(196, 196, 196)`), as CSS strings and as a `Float32Array` of RGBA. `altitudeColor(altFt, onGround)` returns a precomputed string. `altitudeIndex` returns the table index, which the layer uses for change detection. `altitudeRgba(altFt, onGround, out)` writes into a Cesium `Color` (or any `{red, green, blue, alpha}`). None of them allocates.
- `client/scene/icons.ts`: six silhouettes drawn with canvas paths, nose up, 40 × 40 px: `jet` (swept narrow-body, 30 px long), `heavy` (wide-body, 36 px), `light` (straight wing, 22 px), `heli` (tinted rotor disc, body and tail boom), `ground` (14 px box), `unknown` (arrowhead). Each has a white fill and a 1.2 px `rgba(0, 0, 0, 0.85)` outline: a billboard's `color` multiplies the texture, so the fill takes the altitude tint and the outline stays dark. `iconFor(category, typeCode)` checks in this order: (1) a helicopter ICAO type designator (transponders are often set to A1/A2); (2) the ADS-B emitter category (A1 → light, A2/A3/A4/A6 → jet, A5 → heavy, A7 → heli, B1/B4/B6 → light, B2/B3/B7 → unknown, C1–C5 → ground); (3) with no useful category (A0/B0/C0/D*/null), hand-listed ICAO Doc 8643 designators (wide-bodies → heavy; the common piston, turboprop and light families → light; any other → jet); (4) nothing known → unknown. `iconCanvas(kind)` draws each kind once and returns the same canvas every time. `ICON_ID[kind]` is a stable texture-atlas id. `haloCanvas()` is the 64 px selection ring.
- `client/scene/fleetLayer.ts`: `FleetLayer` (PLAN.md §5.3 B-V1, exactly):
  - **One `BillboardCollection`** with `BlendOption.TRANSLUCENT` (one pass instead of opaque + translucent) plus **one `LabelCollection` holding exactly one `Label`**.
  - Billboards are keyed by hex in a `Map`. Each keeps a slot recording what was last written, so a frame writes only what changed. The position is written when it has moved at least 0.25 px on screen (next point), via a reused scratch `Cartesian3`. The aligned axis is written after ≥ 0.05° of movement. The rotation is written when the track changes. The colour is written when the 100 ft bucket changes, and uses one shared `Color` per bucket. The image is written when category or type changes. The scale is written when the selection changes. `update()` allocates nothing per entry per frame.
  - **Sub-pixel moves are not written.** Every position write makes Cesium re-encode that billboard's vertex attributes. Above 10 % dirty billboards per frame it rewrites the whole buffer, and dead-reckoned aircraft move every frame. Once per frame the layer reads the camera position and radians per pixel (`frustum.fovy / drawingBufferHeight`). An aircraft's position is written only when its movement since the last write (metres from the lat/lon/height deltas) exceeds 0.25 px at its distance from the camera. Smaller moves add up until they show. Close to the camera (chase range) every frame writes. At continental zoom a write comes every few seconds. Measured: 5,000 aircraft 11.3 → 8.2 ms per frame, 12,000 16.2 → 10.1 ms. Without a perspective camera (Node tests) every change is written.
  - **Images:** `billboard.setImage(ICON_ID[kind], iconCanvas(kind))`. Cesium 1.145 gives a canvas without `src` a fresh `createGuid()` atlas id when it is assigned through `billboard.image = canvas`, so 5,000 aircraft would upload 5,000 copies. A stable id means the atlas holds each silhouette once (a test counts the atlas ids).
  - **Rotation:** `alignedAxis` = the local ENU north unit vector at the aircraft (`northAt`, checked against `Transforms.eastNorthUpToFixedFrame`), `rotation = −track` in radians. Cesium's example "point the billboard up vector at heading 90°" is `alignedAxis = north, rotation = −π/2`. The nose therefore points along the track in a top-down or tilted view, whatever the camera heading. With no track, the last rotation stays (north if there never was one).
  - **Selection:** the selected aircraft is drawn at 1.4× scale, with a gold ring (a second reused billboard from the same collection). Its icon, ring and label carry `DistanceDisplayCondition(5 km, ∞)`, so in chase mode (camera 25 m – 3 km away) the 3-D model shows through with no 2-D icon on top. Beyond 5 km they reappear.
  - **Label:** one reused label. It shows the hovered aircraft's callsign (the hex in capitals when there is no callsign), else the selected one's, with an opaque dark background and `disableDepthTestDistance = ∞`, above the icon (above the ring when selected). It is drawn in the opaque pass, so no translucent icon paints over it.
  - **Age:** entries with `ageS > 60` are hidden (`show = false`, the cheapest change).
  - **Churn:** hexes missing from a frame are hidden, their id is cleared, and the billboard goes to a free list for the next new hex. Cesium's `add`/`remove` both set `_createVertexArray`, which rebuilds the whole vertex array (O(n) plus a GPU upload). Pooling keeps aircraft arriving and leaving off that path. The sweep runs only when fewer slots were touched than exist.
  - **Heights:** airborne aircraft at `FleetEntry.hM` (HAE). The icons depth-test against the globe, so aircraft on the far side of the Earth stay hidden (`disableDepthTestDistance` would draw them through the planet). `hM` on the ground is about the geoid and can be under the terrain, so ground aircraft use `globe.getHeight` + 2 m, cached per aircraft: re-sampled after ~200 m of movement, every ~600 frames anyway, and every ~30 frames (staggered) while the tile is not loaded.
  - **Size:** `scaleByDistance = NearFarScalar(300 km, 1.0, 8,000 km, 0.5)` shrinks icons in continental views. The GPU computes it, so it costs no CPU.
  - `pick(windowPos)`: `scene.pick(pos)?.id` if it is a hex this layer draws (icon, ring and label all carry the hex), else `null`.
- `client/ui/legend.ts`: `mountLegend(root)` appends a key with a `GND` swatch, a gradient bar and ft ticks `0, 1 000, 2 000, 4 000, 6 000, 8 000, 10 000, 20 000, 30 000, 40 000+`, spaced evenly. The low band, where most of the colour changes, gets more room. The gradient samples `altitudeColor` 8 times per gap, because CSS would interpolate in RGB and drift from the icons' HSL path. It uses inline styles only (no stylesheet to own) and `pointer-events: none`. `destroy()` removes it.

Conventions consumers (B-A) rely on:
- Call `update(fleet.entries(t), selectedHex, hoverHex)` once per frame (e.g. in `scene.preUpdate`) with **all** entries, not only the on-screen ones. Cesium culls on the GPU. `FleetEntry` objects are read during the call and never kept.
- `pick()` is a Cesium pick pass (it renders). Call it on click, and on mouse move at most once per frame (the harness keeps the latest `MOUSE_MOVE` position and picks in `preUpdate`).
- The layer is safe to keep in chase mode: other aircraft stay visible as icons, and the chased one gives way to its model within 5 km (`CHASE_HIDE_M`). To hide the whole fleet in chase, pass `[]` (the billboards are pooled, not destroyed).
- `mountLegend(root)`: the caller positions `root`. B-V3 requires Cesium's bottom credit line to stay visible, so put the legend above it (the harness uses `bottom: 30px`).
- Colours for other UI (table altitude cell, detail panel): `altitudeColor(altFt, onGround)` from `client/scene/altitudeColor.ts`.

**Tech Stack:** CesiumJS 1.145 (`BillboardCollection` with `BlendOption.TRANSLUCENT`, `Billboard.setImage(id, canvas)`, `alignedAxis`/`rotation`, `NearFarScalar`, `DistanceDisplayCondition`; `LabelCollection`; `Globe.getHeight`; `Scene.pick`), Canvas 2D, `node:test`. The Node tests use real Cesium collections on a fake scene (`primitives.add/remove`, `globe.getHeight`, `pick`) and a DOM stub: a recording 2-D context for the icons, Label's one-time font measurement, and a small element tree for the legend. They inspect Cesium's per-property change counters (`_propertiesChanged`) and the texture atlas's id map (`_indexById`), which are private in the pinned 1.145. Facts transcribed: ADS-B emitter category meanings (RTCA DO-260B §2.2.3.2.5.2 / ICAO Annex 10 Vol IV), ICAO Doc 8643 type designators. Nothing is fetched: the harness's only imagery option, `?bg=ne`, is Natural Earth II, bundled with Cesium and served locally.

**Wave:** B1 (parallel with the other seven B-* packages; depends only on WP-B0). Consumed by B-A. **Estimated:** 2 h. **Validated:** 2026-09-22 in the integrated tree (WP-00 + 26 WPs + WP-V4 orbit + WP-B0, installed `node_modules`, Node 25.2.1, Cesium 1.145.0, TypeScript 7.0.2) on the user's Mac (MacBook Air, Apple M2, 16 GB):
- `node --test client/scene/altitudeColor.test.ts client/scene/icons.test.ts client/scene/fleetLayer.test.ts client/ui/legend.test.ts` → 35/35 pass (7 + 8 + 16 + 4). `npx tsc --noEmit` is clean for the whole tree. A full `npm test` in the shared tree, with the other B-* packages' files as they were at that moment, gave 611/611.
- **Mutations** (23 hand-made faults in an isolated copy): wrong rotation sign, no aligned axis, canvas without a stable atlas id, no billboard pool, no sweep, no ground clamp, terrain sampled every frame, no age hiding, no chase-range hiding, label preferring the selection over the hover, no sub-pixel skip, east-west movement ignored, a wrong colour stop, ground not grey, floor instead of round, no helicopter override, A5 not heavy, upside-down jet, icons not cached, unsampled legend gradient and a no-op legend `destroy` were each caught by 1–3 failing tests. Two survivors are expected: "always write position" and "always write colour" behave the same because Cesium's setters also compare values. The layer's own compare only saves the `fromDegrees` trigonometry and the setter call.
- **Harness:** the in-app browser pane was at its tab cap the whole time (9 tabs belonging to other agents, which were left alone). The page therefore ran in Google Chrome's headless mode on the same Mac, driven through the DevTools protocol. It used the real GPU: WebGL reported `ANGLE (Apple, ANGLE Metal Renderer: Apple M2)`. Checks: screenshots of `?test=compass` top-down and tilted (−55°), 5,000 aircraft top-down and tilted, and `?bg=ne`. A real mouse hover on the bearing-030 heavy showed the label `BRG030`. A real click gave `scale` 1.4 and the ring shown. Moving the mouse away kept the selected label. `Esc` gave scale 1, no ring and no label. Console: no errors or warnings.
- **Performance:** see Task 5 Step 4. At 5,000 aircraft: 8.2 ms per frame p50 (122 FPS) and 10.3 ms p95 (97 FPS p5), `update()` 0.4 ms. The target was ≥ 50 FPS p50.
- **Replay:** the plan's code blocks were extracted into an isolated copy holding only WP-B0's type files (`client/types.ts`, `client/track/types.ts`, `shared/info.ts`, `shared/types.ts`). They are byte-identical to the tree. Each task's Step 2 failed as written (`ERR_MODULE_NOT_FOUND`), each Step 4 passed (7, 8, 16, 4), and a full `tsc --noEmit` of the copy was clean.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- This package creates only the ten files below and edits nothing. It reads `client/types.ts` (`FleetEntry`) and `shared/info.ts` (`AircraftInfo`) from WP-B0.
- Unit tests need no WebGL, no real DOM (a small stub is enough) and no network. The harness page makes no network requests either.
- Never request anything from adsb.lol here.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `client/scene/altitudeColor.ts`, `client/scene/altitudeColor.test.ts` | own HSL altitude palette: `altitudeColor`, `altitudeIndex`, `altitudeRgba`, `ALTITUDE_RGBA`, `hslAt` |
| `client/scene/icons.ts`, `client/scene/icons.test.ts` | `IconKind`, `iconFor`, `iconCanvas`, `drawIcon`, `haloCanvas`, `ICON_ID` |
| `client/scene/fleetLayer.ts`, `client/scene/fleetLayer.test.ts` | `class FleetLayer`, `northAt`, constants |
| `client/ui/legend.ts`, `client/ui/legend.test.ts` | `mountLegend`, `legendGradient`, `tickLabel`, `LEGEND_TICKS_FT` |
| `harness/fleet-layer.html`, `harness/fleet-layer.ts` | 1,000–10,000 synthetic aircraft over Europe, top-down, FPS meter and `bench()` |

---

### Task 1: Altitude colours

**Files:**
- Create: `client/scene/altitudeColor.ts`, `client/scene/altitudeColor.test.ts`
- Test: `client/scene/altitudeColor.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `altitudeColor(altFt: number | null, onGround: boolean): string` (PLAN.md §5.3, exactly) · `altitudeIndex(altFt: number | null, onGround: boolean): number` · `altitudeRgba<T extends { red; green; blue; alpha }>(altFt, onGround, out: T): T` · `hslAt(altFt: number): [h, s, l]` · `ALTITUDE_RGBA: Float32Array` · `COLOR_COUNT` (403), `GROUND_INDEX` (401), `UNKNOWN_INDEX` (402), `TOP_FT` (40,000), `STEP_FT` (100)

- [ ] **Step 1: Write the failing test**

```ts
// client/scene/altitudeColor.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Color } from 'cesium'
import { ALTITUDE_RGBA, COLOR_COUNT, GROUND_INDEX, UNKNOWN_INDEX, altitudeColor, altitudeIndex, altitudeRgba, hslAt } from './altitudeColor.ts'

/** 'rgb(r, g, b)' → [r, g, b] 0–255 */
function rgbOf(css: string): [number, number, number] {
  const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(css)
  assert.ok(m, `not an rgb() string: ${css}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** Hue in degrees of an 'rgb()' string (the usual max/min formula). */
function hueOf(css: string): number {
  const [r, g, b] = rgbOf(css).map((v) => v / 255)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (d === 0) return NaN
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}

test('the named anchors: orange, yellow, green, cyan, blue, violet, magenta', () => {
  const band = (ft: number, lo: number, hi: number, name: string): void => {
    const h = hueOf(altitudeColor(ft, false))
    assert.ok(h >= lo && h <= hi, `${ft} ft should be ${name} (hue ${lo}–${hi}°), got ${h.toFixed(1)}°`)
  }
  band(0, 15, 35, 'orange')
  band(2_000, 45, 60, 'yellow')
  band(6_000, 100, 135, 'green')
  band(12_000, 170, 195, 'cyan')
  band(20_000, 210, 235, 'blue')
  band(30_000, 255, 280, 'violet')
  band(40_000, 290, 320, 'magenta')
})

test('hue rises smoothly with altitude and saturates at 40,000 ft', () => {
  let prev = -1
  for (let ft = 0; ft <= 40_000; ft += 100) {
    const h = hslAt(ft)[0]
    assert.ok(h >= prev, `hue must not fall: ${ft} ft → ${h}° after ${prev}°`)
    assert.ok(h - prev < 5 || prev < 0, `no jumps: ${ft} ft → ${h}° after ${prev}°`)
    prev = h
  }
  assert.equal(altitudeColor(45_000, false), altitudeColor(40_000, false))
  assert.equal(altitudeColor(60_000, false), altitudeColor(40_000, false))
  assert.deepEqual(hslAt(50_000), hslAt(40_000))
})

test('below sea level reads as 0 ft; the CSS colour is the rounded 100 ft bucket', () => {
  assert.equal(altitudeColor(-150, false), altitudeColor(0, false))
  assert.equal(altitudeColor(1_240, false), altitudeColor(1_200, false))
  assert.equal(altitudeColor(1_260, false), altitudeColor(1_300, false))
  assert.notEqual(altitudeColor(1_200, false), altitudeColor(1_300, false))
})

test('on the ground → grey whatever the altitude; unknown altitude → a lighter grey', () => {
  const [r, g, b] = rgbOf(altitudeColor(null, true))
  assert.ok(r === g && g === b, 'ground is a neutral grey')
  assert.equal(altitudeColor(35_000, true), altitudeColor(null, true))
  assert.equal(altitudeColor(0, true), altitudeColor(null, true))
  const [ur, ug, ub] = rgbOf(altitudeColor(null, false))
  assert.ok(ur === ug && ug === ub, 'unknown is a neutral grey')
  assert.ok(ur > r, 'unknown is lighter than ground')
  assert.equal(altitudeColor(Number.NaN, false), altitudeColor(null, false))
})

test('altitudeIndex: 100 ft buckets, then ground, then unknown', () => {
  assert.equal(altitudeIndex(0, false), 0)
  assert.equal(altitudeIndex(-50, false), 0)
  assert.equal(altitudeIndex(149, false), 1)
  assert.equal(altitudeIndex(40_000, false), 400)
  assert.equal(altitudeIndex(99_999, false), 400)
  assert.equal(altitudeIndex(12_000, true), GROUND_INDEX)
  assert.equal(altitudeIndex(null, false), UNKNOWN_INDEX)
  assert.equal(GROUND_INDEX, 401)
  assert.equal(UNKNOWN_INDEX, 402)
  assert.equal(COLOR_COUNT, 403)
  assert.equal(ALTITUDE_RGBA.length, COLOR_COUNT * 4)
})

test('altitudeRgba writes the same colour as the CSS string into the object it is given, allocating nothing', () => {
  const out = new Color()
  for (const [ft, gnd] of [[0, false], [7_300, false], [40_000, false], [null, true], [null, false]] as const) {
    const ret = altitudeRgba(ft, gnd, out)
    assert.equal(ret, out, 'returns the same object')
    const [r, g, b] = rgbOf(altitudeColor(ft, gnd))
    assert.ok(Math.abs(out.red - r / 255) < 1e-6 && Math.abs(out.green - g / 255) < 1e-6 && Math.abs(out.blue - b / 255) < 1e-6)
    assert.equal(out.alpha, 1)
  }
})

test('Cesium parses every CSS colour to the same RGBA as the table', () => {
  const cases: [number | null, boolean, number][] = [[null, true, GROUND_INDEX], [null, false, UNKNOWN_INDEX]]
  for (let i = 0; i <= 400; i += 7) cases.push([i * 100, false, i])
  for (const [ft, gnd, i] of cases) {
    const css = altitudeColor(ft, gnd)
    const c = Color.fromCssColorString(css)
    assert.ok(Math.abs(c.red - ALTITUDE_RGBA[i * 4]) < 1e-6, css)
    assert.ok(Math.abs(c.green - ALTITUDE_RGBA[i * 4 + 1]) < 1e-6, css)
    assert.ok(Math.abs(c.blue - ALTITUDE_RGBA[i * 4 + 2]) < 1e-6, css)
  }
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/scene/altitudeColor.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/scene/altitudeColor.ts' imported from …/client/scene/altitudeColor.test.ts`

- [ ] **Step 3: Write the implementation**

```ts
// client/scene/altitudeColor.ts
/**
 * Altitude → colour for the browse view. FlightHopper's own palette (not tar1090's): a smooth HSL gradient over seven
 * stops, orange at the surface → yellow → green → cyan → blue → violet → magenta at 40,000 ft and above.
 * On the ground → mid grey; altitude unknown → light grey.
 * Every colour is precomputed once in 100 ft buckets (403 entries), so a lookup allocates nothing.
 */

/** [altitude ft, hue °, saturation %, lightness %]. Lightness dips in the green/cyan band so it stays readable on a light map. */
const STOPS: readonly (readonly [number, number, number, number])[] = [
  [0, 24, 95, 53], //        orange
  [2_000, 50, 95, 50], //    yellow
  [6_000, 118, 65, 42], //   green
  [12_000, 182, 80, 40], //  cyan
  [20_000, 222, 85, 56], //  blue
  [30_000, 268, 75, 62], //  violet
  [40_000, 304, 78, 58], //  magenta
]

export const TOP_FT = 40_000
export const STEP_FT = 100
const BUCKETS = TOP_FT / STEP_FT + 1 // 0, 100, …, 40,000 ft
export const GROUND_INDEX = BUCKETS
export const UNKNOWN_INDEX = BUCKETS + 1
export const COLOR_COUNT = BUCKETS + 2

const GROUND_RGB: readonly [number, number, number] = [128, 128, 128]
const UNKNOWN_RGB: readonly [number, number, number] = [196, 196, 196]

/** The continuous gradient: [hue °, saturation %, lightness %] at altFt, linear between stops, clamped to 0…40,000 ft. */
export function hslAt(altFt: number): [number, number, number] {
  const ft = Math.min(TOP_FT, Math.max(0, altFt))
  let i = 1
  while (i < STOPS.length - 1 && STOPS[i][0] < ft) i++
  const a = STOPS[i - 1]
  const b = STOPS[i]
  const f = Math.min(1, Math.max(0, (ft - a[0]) / (b[0] - a[0])))
  return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f]
}

/** CSS Color 4 HSL → sRGB, 0–255 integers. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sat = s / 100
  const lig = l / 100
  const a = sat * Math.min(lig, 1 - lig)
  const f = (n: number): number => {
    const k = (n + h / 30) % 12
    return Math.round((lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255)
  }
  return [f(0), f(8), f(4)]
}

/** RGBA 0–1 per colour index, 4 floats each (for Cesium). */
export const ALTITUDE_RGBA = new Float32Array(COLOR_COUNT * 4)
const CSS: string[] = new Array(COLOR_COUNT)

function setColor(i: number, [r, g, b]: readonly [number, number, number]): void {
  CSS[i] = `rgb(${r}, ${g}, ${b})`
  ALTITUDE_RGBA.set([r / 255, g / 255, b / 255, 1], i * 4)
}
for (let i = 0; i < BUCKETS; i++) setColor(i, hslToRgb(...hslAt(i * STEP_FT)))
setColor(GROUND_INDEX, GROUND_RGB)
setColor(UNKNOWN_INDEX, UNKNOWN_RGB)

/** Colour-table index: the nearest 100 ft bucket (0 … 400), GROUND_INDEX when on the ground, UNKNOWN_INDEX without an altitude. */
export function altitudeIndex(altFt: number | null, onGround: boolean): number {
  if (onGround) return GROUND_INDEX
  if (altFt === null || !Number.isFinite(altFt)) return UNKNOWN_INDEX
  if (altFt <= 0) return 0
  if (altFt >= TOP_FT) return BUCKETS - 1
  return Math.round(altFt / STEP_FT)
}

/** CSS colour, e.g. 'rgb(247, 115, 17)'. The strings are precomputed; nothing is allocated per call. */
export function altitudeColor(altFt: number | null, onGround: boolean): string {
  return CSS[altitudeIndex(altFt, onGround)]
}

/** Writes the colour (0–1 channels, alpha 1) into `out` (a Cesium Color works) and returns it. */
export function altitudeRgba<T extends { red: number; green: number; blue: number; alpha: number }>(
  altFt: number | null,
  onGround: boolean,
  out: T,
): T {
  const i = altitudeIndex(altFt, onGround) * 4
  out.red = ALTITUDE_RGBA[i]
  out.green = ALTITUDE_RGBA[i + 1]
  out.blue = ALTITUDE_RGBA[i + 2]
  out.alpha = ALTITUDE_RGBA[i + 3]
  return out
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/scene/altitudeColor.test.ts`
Expected: PASS — `ℹ tests 7`, `ℹ pass 7`, `ℹ fail 0`.

- [ ] **Step 5: Type-check these files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/altitudeColor'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 6: Commit**

```bash
git add client/scene/altitudeColor.ts client/scene/altitudeColor.test.ts
git commit -m "feat(scene): own altitude colour scale (HSL, 100 ft buckets, no per-call allocation)"
```

---

### Task 2: Silhouettes

**Files:**
- Create: `client/scene/icons.ts`, `client/scene/icons.test.ts`
- Test: `client/scene/icons.test.ts`

**Interfaces:**
- Consumes: nothing (the DOM `document.createElement('canvas')` at first use of a kind)
- Produces: `type IconKind = 'jet' | 'heavy' | 'light' | 'heli' | 'ground' | 'unknown'` · `iconFor(category: string | null, typeCode: string | null): IconKind` (PLAN.md §5.3, exactly) · `iconCanvas(kind): HTMLCanvasElement` (same object per kind) · `drawIcon(ctx, kind, px): void` · `haloCanvas(): HTMLCanvasElement` · `ICON_KINDS`, `ICON_ID`, `ICON_PX` (40), `HALO_PX` (64), `HALO_ID`

- [ ] **Step 1: Write the failing test**

```ts
// client/scene/icons.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HALO_PX, ICON_ID, ICON_KINDS, ICON_PX, haloCanvas, iconCanvas, iconFor } from './icons.ts'
import type { IconKind } from './icons.ts'

// Node has no DOM: a canvas whose 2-D context records every call and property write.
type Call = [string, ...unknown[]]
interface FakeCanvas { width: number; height: number; calls: Call[]; getContext(kind: string): unknown }
const made: FakeCanvas[] = []
Object.assign(globalThis, {
  document: {
    createElement(tag: string): FakeCanvas {
      assert.equal(tag, 'canvas')
      const calls: Call[] = []
      const ctx = new Proxy({} as Record<string | symbol, unknown>, {
        get: (t, k) => (k in t ? t[k] : (...a: unknown[]) => void calls.push([String(k), ...a])),
        set: (t, k, v) => ((t[k] = v), calls.push(['set:' + String(k), v]), true),
      })
      const c: FakeCanvas = { width: 300, height: 150, calls, getContext: (kind) => (kind === '2d' ? ctx : null) }
      made.push(c)
      return c
    },
  },
})

test('iconFor: the ADS-B emitter category decides first', () => {
  const cases: [string, IconKind][] = [
    ['A1', 'light'], ['A2', 'jet'], ['A3', 'jet'], ['A4', 'jet'], ['A5', 'heavy'], ['A6', 'jet'], ['A7', 'heli'],
    ['B1', 'light'], ['B2', 'unknown'], ['B3', 'unknown'], ['B4', 'light'], ['B6', 'light'], ['B7', 'unknown'],
    ['C1', 'ground'], ['C2', 'ground'], ['C3', 'ground'], ['C4', 'ground'], ['C5', 'ground'],
  ]
  for (const [cat, kind] of cases) assert.equal(iconFor(cat, null), kind, cat)
  assert.equal(iconFor('A5', 'C172'), 'heavy', 'a broadcast category beats a fixed-wing type code')
  assert.equal(iconFor('A1', 'B77W'), 'light')
})

test('iconFor: without a useful category the ICAO type designator decides', () => {
  const cases: [string, IconKind][] = [
    ['B77W', 'heavy'], ['A388', 'heavy'], ['B789', 'heavy'], ['A359', 'heavy'], ['B744', 'heavy'], ['A332', 'heavy'], ['MD11', 'heavy'],
    ['B738', 'jet'], ['A320', 'jet'], ['A21N', 'jet'], ['E190', 'jet'], ['CRJ9', 'jet'], ['B752', 'jet'], ['C56X', 'jet'], ['ZZZZ', 'jet'],
    ['C172', 'light'], ['P28A', 'light'], ['SR22', 'light'], ['DA40', 'light'], ['AT76', 'light'], ['DH8D', 'light'], ['PC12', 'light'], ['BE20', 'light'],
    ['EC35', 'heli'], ['R44', 'heli'], ['A139', 'heli'], ['S76', 'heli'], ['AS50', 'heli'], ['H60', 'heli'],
  ]
  for (const [type, kind] of cases) {
    assert.equal(iconFor(null, type), kind, `${type} (no category)`)
    assert.equal(iconFor('A0', type), kind, `${type} (A0 = no information)`)
  }
  assert.equal(iconFor('B0', 'B738'), 'jet')
  assert.equal(iconFor('C0', 'B738'), 'jet')
  assert.equal(iconFor('D2', 'A388'), 'heavy', 'reserved categories fall back too')
})

test('iconFor: a helicopter type code wins even over a fixed-wing category (common transponder misconfiguration)', () => {
  assert.equal(iconFor('A1', 'R44'), 'heli')
  assert.equal(iconFor('A2', 'EC45'), 'heli')
})

test('iconFor: nothing known → unknown', () => {
  assert.equal(iconFor(null, null), 'unknown')
  assert.equal(iconFor('A0', null), 'unknown')
  assert.equal(iconFor('', ''), 'unknown')
})

test('iconCanvas: one canvas per kind, drawn once, ICON_PX square', () => {
  const before = made.length
  const canvases = ICON_KINDS.map((k) => iconCanvas(k))
  assert.equal(made.length - before, ICON_KINDS.length, 'one canvas per kind')
  assert.equal(new Set(canvases).size, ICON_KINDS.length)
  for (const k of ICON_KINDS) assert.equal(iconCanvas(k), canvases[ICON_KINDS.indexOf(k)], `${k}: same object every call`)
  assert.equal(made.length - before, ICON_KINDS.length, 'no redraws')
  for (const c of canvases) {
    assert.equal(c.width, ICON_PX)
    assert.equal(c.height, ICON_PX)
  }
  assert.ok(ICON_PX >= 32 && ICON_PX <= 40)
  assert.equal(new Set(Object.values(ICON_ID)).size, ICON_KINDS.length, 'distinct texture-atlas ids')
})

test('silhouettes: white fill and a dark outline (so the altitude tint shows), inside the canvas, nose up', () => {
  for (const k of ICON_KINDS) {
    const { calls } = iconCanvas(k) as unknown as FakeCanvas
    const sets = (name: string): unknown[] => calls.filter((c) => c[0] === 'set:' + name).map((c) => c[1])
    assert.ok(sets('fillStyle').includes('#fff'), `${k}: white fill`)
    assert.ok(sets('strokeStyle').some((s) => String(s).startsWith('rgba(0, 0, 0')), `${k}: dark outline`)
    assert.ok(calls.some((c) => c[0] === 'fill') && calls.some((c) => c[0] === 'stroke'), `${k}: filled and stroked`)
    const pts = calls.filter((c) => c[0] === 'moveTo' || c[0] === 'lineTo').map((c) => [c[1], c[2]] as [number, number])
    assert.ok(pts.length >= 3, `${k}: has an outline`)
    for (const [x, y] of pts) assert.ok(x >= 0 && x <= ICON_PX && y >= 0 && y <= ICON_PX, `${k}: (${x}, ${y}) inside`)
    if (k === 'heli' || k === 'ground') continue // heli: nose is the body ellipse (checked below); ground: symmetric box
    const top = pts.reduce((a, b) => (b[1] < a[1] ? b : a))
    assert.ok(Math.abs(top[0] - ICON_PX / 2) < 1e-9, `${k}: the frontmost point is on the centre line`)
    const bottom = Math.max(...pts.map((p) => p[1]))
    const halfWidth = (ys: [number, number][]): number => Math.max(...ys.map((p) => Math.abs(p[0] - ICON_PX / 2)))
    const nose = pts.filter((p) => p[1] <= top[1] + 0.12 * (bottom - top[1]))
    assert.ok(halfWidth(nose) < 0.25 * halfWidth(pts), `${k}: nose up (narrow at the top, not a tailplane)`)
  }
  const heli = (iconCanvas('heli') as unknown as FakeCanvas).calls
  assert.ok(heli.some((c) => c[0] === 'arc'), 'heli: rotor disc')
  assert.ok(heli.some((c) => c[0] === 'ellipse'), 'heli: body')
})

test('sizes differ by kind: heavy > jet > light > ground', () => {
  const span = (k: IconKind): number => {
    const ys = (iconCanvas(k) as unknown as FakeCanvas).calls.filter((c) => c[0] === 'lineTo').map((c) => c[2] as number)
    return Math.max(...ys) - Math.min(...ys)
  }
  assert.ok(span('heavy') > span('jet'))
  assert.ok(span('jet') > span('light'))
  assert.ok(span('light') > span('ground'))
})

test('haloCanvas: one ring, larger than a selected (1.4×) icon', () => {
  const a = haloCanvas()
  assert.equal(haloCanvas(), a)
  assert.equal(a.width, HALO_PX)
  assert.ok(HALO_PX > ICON_PX * 1.4)
  assert.ok((a as unknown as FakeCanvas).calls.some((c) => c[0] === 'arc'))
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/scene/icons.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/scene/icons.ts' imported from …/client/scene/icons.test.ts`

- [ ] **Step 3: Write the implementation**

```ts
// client/scene/icons.ts
/**
 * Top-down aircraft silhouettes for the fleet layer, drawn here on a canvas (FlightHopper's own shapes, no third-party
 * icon set). White fill + thin dark outline: a Cesium billboard's `color` multiplies the texture, so the fill takes the
 * altitude tint and the outline stays dark on light and dark maps. Nose points up (north before rotation).
 */

export type IconKind = 'jet' | 'heavy' | 'light' | 'heli' | 'ground' | 'unknown'
export const ICON_KINDS: readonly IconKind[] = ['jet', 'heavy', 'light', 'heli', 'ground', 'unknown']
/** Texture-atlas id per kind: a stable id makes Cesium store each canvas once for every billboard that uses it. */
export const ICON_ID: Readonly<Record<IconKind, string>> = {
  jet: 'fh-icon-jet',
  heavy: 'fh-icon-heavy',
  light: 'fh-icon-light',
  heli: 'fh-icon-heli',
  ground: 'fh-icon-ground',
  unknown: 'fh-icon-unknown',
}
export const ICON_PX = 40
export const HALO_PX = 64
export const HALO_ID = 'fh-halo'

// ADS-B emitter category (DO-260B §2.2.3.2.5.2) → silhouette. A0/B0/C0 ("no information") and reserved values are absent.
const BY_CATEGORY = new Map<string, IconKind>([
  ['A1', 'light'], // light, < 15,500 lb
  ['A2', 'jet'], //   small, 15,500–75,000 lb (regional and business jets)
  ['A3', 'jet'], //   large, 75,000–300,000 lb
  ['A4', 'jet'], //   high-vortex large (B757)
  ['A5', 'heavy'], // heavy, > 300,000 lb
  ['A6', 'jet'], //   high performance (> 5 g, > 400 kt)
  ['A7', 'heli'], //  rotorcraft
  ['B1', 'light'], // glider / sailplane
  ['B2', 'unknown'], // lighter-than-air
  ['B3', 'unknown'], // parachutist / skydiver
  ['B4', 'light'], // ultralight / hang-glider / paraglider
  ['B6', 'light'], // unmanned aerial vehicle
  ['B7', 'unknown'], // space / trans-atmospheric vehicle
  ['C1', 'ground'], // surface vehicle, emergency
  ['C2', 'ground'], // surface vehicle, service
  ['C3', 'ground'], // point obstacle (incl. tethered balloons)
  ['C4', 'ground'], // cluster obstacle
  ['C5', 'ground'], // line obstacle
])

// ICAO Doc 8643 type designators (facts, listed by hand). Wide-body / heavy-wake airframes:
const HEAVY = new Set([
  'A306', 'A30B', 'A310', 'A332', 'A333', 'A337', 'A338', 'A339', 'A342', 'A343', 'A345', 'A346', 'A359', 'A35K', 'A388',
  'A3ST', 'A400', 'A124', 'A225', 'AN22', 'B741', 'B742', 'B743', 'B744', 'B748', 'B74R', 'B74S', 'B762', 'B763', 'B764',
  'B772', 'B773', 'B77L', 'B77W', 'B778', 'B779', 'B788', 'B789', 'B78X', 'C5M', 'C17', 'DC10', 'IL76', 'IL86', 'IL96',
  'K35R', 'L101', 'MD11',
])
// Helicopters:
const HELI = new Set([
  'A109', 'A119', 'A129', 'A139', 'A149', 'A169', 'A189', 'AS32', 'AS3B', 'AS50', 'AS55', 'AS65', 'B06', 'B06T', 'B105',
  'B212', 'B407', 'B412', 'B429', 'B430', 'B47G', 'B505', 'BK17', 'EC20', 'EC25', 'EC30', 'EC35', 'EC45', 'EC55', 'EC75',
  'EH10', 'EXPL', 'GAZL', 'H160', 'H269', 'H47', 'H500', 'H53', 'H60', 'H64', 'KA32', 'LYNX', 'MI8', 'MI24', 'MI26',
  'NH90', 'PUMA', 'R22', 'R44', 'R66', 'S61', 'S64', 'S76', 'S92', 'UH1',
])
// Pistons, turboprops and other light / straight-wing types (Cessna, Piper, Cirrus, Diamond, Beech, Mooney, ATR, Dash 8, …).
// ponytail: a hand list of the common families, not the full Doc 8643 table. Misses fall back to 'jet', and C130/C160 draw
// as 'light' (right shape, small). Upgrade: ship the Doc 8643 description codes (L1P/L2T/…) as JSON and map by those.
const LIGHT =
  /^(C1\d\d|C2\d\d|C3[0-4]\d|C4[0-4]\d|P28.|P32.|PA\d\d|SR2[02]|S22T|DA\d\d|DV20|BE\d\d|BE9.|B350|B190|M20.|AT[4-7]\d|DH8.|DHC\d|SF34|SB20|JS\d\d|D228|D328|L410|PC\d{1,2}T?|TBM\d|P180|E110|E120|F27|F50|AN2[468]|AN32|Y12|C212|CN35|C295|BN2.|GA8|G115|AA5)$/

/**
 * Which silhouette to draw. A helicopter type designator wins outright (transponders are often set to A1/A2); otherwise
 * the broadcast emitter category decides; without one the type designator does; with neither → 'unknown'.
 */
export function iconFor(category: string | null, typeCode: string | null): IconKind {
  const type = typeCode || null
  if (type !== null && HELI.has(type)) return 'heli'
  const byCategory = category ? BY_CATEGORY.get(category) : undefined
  if (byCategory) return byCategory
  if (type === null) return 'unknown'
  if (HEAVY.has(type)) return 'heavy'
  if (LIGHT.test(type)) return 'light'
  return 'jet'
}

// Outlines: the right half, nose → tail, as x,y pairs in a 40-unit box centred on the aircraft (y down, nose at −y).
// The left half is the mirror image. pods = engines / nacelles [x, y, rx, ry], drawn on both sides.
interface Shape {
  half: readonly number[]
  pods: readonly (readonly [number, number, number, number])[]
}
const SHAPES: Readonly<Record<Exclude<IconKind, 'heli'>, Shape>> = {
  jet: {
    half: [0, -15, 1.3, -13.8, 2, -11.5, 2, -3, 13.5, 3.2, 13.5, 5, 2, 2.2, 1.7, 9, 6.2, 12.4, 6.2, 14, 1, 13.2, 0, 14.6],
    pods: [[6, 0.2, 1.2, 2.2]],
  },
  heavy: {
    half: [0, -18, 1.7, -16.6, 2.7, -13.5, 2.7, -4, 18, 5, 18, 7, 2.7, 2.6, 2.3, 11.5, 8, 15.2, 8, 17, 1.4, 15.8, 0, 17.6],
    pods: [[8, 0.6, 1.6, 2.9]],
  },
  light: {
    half: [0, -11, 1.2, -10.2, 1.7, -8, 1.7, -3.6, 13, -3.2, 13, -0.4, 1.7, 0, 1.1, 7.2, 5, 7.6, 5, 9.6, 0.8, 9.8, 0, 10.6],
    pods: [],
  },
  ground: { half: [0, -7, 3, -7, 4, -6, 4, 6, 3, 7, 0, 7], pods: [] },
  unknown: { half: [0, -11, 8, 10, 0, 5], pods: [] },
}
const HELI_BOOM = [0, 1.5, 1, 2, 1, 10.8, 4, 11, 4, 12.6, 1, 12.8, 0, 14]
const FILL = '#fff'
const OUTLINE = 'rgba(0, 0, 0, 0.85)'
const OUTLINE_PX = 1.2

type Ctx = CanvasRenderingContext2D

function outline(ctx: Ctx, half: readonly number[], X: (x: number) => number, Y: (y: number) => number): void {
  ctx.beginPath()
  ctx.moveTo(X(half[0]), Y(half[1]))
  for (let i = 2; i < half.length; i += 2) ctx.lineTo(X(half[i]), Y(half[i + 1]))
  for (let i = half.length - 4; i >= 2; i -= 2) ctx.lineTo(X(-half[i]), Y(half[i + 1]))
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
}

/** Draws one silhouette centred in a px × px canvas. */
export function drawIcon(ctx: Ctx, kind: IconKind, px: number): void {
  const k = px / 40
  const X = (x: number): number => px / 2 + x * k
  const Y = (y: number): number => px / 2 + y * k
  ctx.lineJoin = 'round'
  ctx.lineWidth = OUTLINE_PX
  ctx.strokeStyle = OUTLINE
  if (kind === 'heli') {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)' // rotor disc: a faint tinted circle
    ctx.beginPath()
    ctx.arc(X(0), Y(-2), 11 * k, 0, 2 * Math.PI)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = FILL
    outline(ctx, HELI_BOOM, X, Y)
    ctx.beginPath()
    ctx.ellipse(X(0), Y(-2.5), 3.6 * k, 6 * k, 0, 0, 2 * Math.PI)
    ctx.fill()
    ctx.stroke()
    return
  }
  const shape = SHAPES[kind]
  ctx.fillStyle = FILL
  outline(ctx, shape.half, X, Y)
  for (const [x, y, rx, ry] of shape.pods) {
    for (const side of [-1, 1]) {
      ctx.beginPath()
      ctx.ellipse(X(side * x), Y(y), rx * k, ry * k, 0, 0, 2 * Math.PI)
      ctx.fill()
      ctx.stroke()
    }
  }
}

function canvas(px: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas')
  c.width = px
  c.height = px
  return [c, c.getContext('2d') as Ctx]
}

const cache = new Map<IconKind, HTMLCanvasElement>()

/** The silhouette canvas for a kind: drawn on first use, then the same object every call. */
export function iconCanvas(kind: IconKind): HTMLCanvasElement {
  let c = cache.get(kind)
  if (!c) {
    const [cv, ctx] = canvas(ICON_PX)
    drawIcon(ctx, kind, ICON_PX)
    cache.set(kind, (c = cv))
  }
  return c
}

let halo: HTMLCanvasElement | null = null

/** Selection ring (white on a dark edge, so it reads on any map; tint it with the billboard colour). */
export function haloCanvas(): HTMLCanvasElement {
  if (!halo) {
    const [cv, ctx] = canvas(HALO_PX)
    ctx.beginPath()
    ctx.arc(HALO_PX / 2, HALO_PX / 2, HALO_PX / 2 - 5, 0, 2 * Math.PI)
    ctx.lineWidth = 5
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)'
    ctx.stroke()
    ctx.lineWidth = 2.5
    ctx.strokeStyle = FILL
    ctx.stroke()
    halo = cv
  }
  return halo
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/scene/icons.test.ts`
Expected: PASS — `ℹ tests 8`, `ℹ pass 8`, `ℹ fail 0`.

- [ ] **Step 5: Type-check these files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/icons'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 6: Commit**

```bash
git add client/scene/icons.ts client/scene/icons.test.ts
git commit -m "feat(scene): own top-down aircraft silhouettes and category/type mapping"
```

---

### Task 3: FleetLayer

**Files:**
- Create: `client/scene/fleetLayer.ts`, `client/scene/fleetLayer.test.ts`
- Test: `client/scene/fleetLayer.test.ts`

**Interfaces:**
- Consumes: `FleetEntry` (`client/types.ts`, WP-B0), `AircraftInfo` (`shared/info.ts`, WP-B0, tests only), `altitudeIndex`/`ALTITUDE_RGBA`/`COLOR_COUNT` (Task 1), `iconFor`/`iconCanvas`/`haloCanvas`/`ICON_ID`/`HALO_ID`/`ICON_PX` (Task 2); Cesium `Viewer`
- Produces: `class FleetLayer { constructor(viewer: Viewer); update(entries: readonly FleetEntry[], selectedHex: string | null, hoverHex: string | null): void; pick(windowPos: Cartesian2): string | null; destroy(): void }` (PLAN.md §5.3, exactly) · `northAt(latDeg, lonDeg, out: Cartesian3): Cartesian3` · `MAX_AGE_S` (60), `SELECTED_SCALE` (1.4), `CHASE_HIDE_M` (5,000), `GROUND_LIFT_M` (2)

- [ ] **Step 1: Write the failing test**

```ts
// client/scene/fleetLayer.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BillboardCollection, BlendOption, Cartesian2, Cartesian3, Cartesian4, Cartographic, Color, LabelCollection, Matrix4, Transforms } from 'cesium'
import type { Billboard, Viewer } from 'cesium'
import type { AircraftInfo } from '../../shared/info.ts'
import type { FleetEntry } from '../types.ts'
import { altitudeColor } from './altitudeColor.ts'
import { FleetLayer, GROUND_LIFT_M, MAX_AGE_S, SELECTED_SCALE, northAt } from './fleetLayer.ts'
import { HALO_ID, ICON_ID } from './icons.ts'

// Node has no DOM. Label measures its CSS font through the DOM once per font (Label.js parseFont); the icons draw on a
// canvas. Both are stubbed; glyphs and textures are only uploaded by a real scene's render, which these tests never run.
Object.assign(globalThis, {
  document: {
    createElement: (tag: string) =>
      tag === 'canvas'
        ? { width: 0, height: 0, getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }
        : { style: {} },
    body: { appendChild: () => {}, removeChild: () => {} },
    defaultView: { getComputedStyle: () => ({ getPropertyValue: (p: string) => (p === 'font-size' ? '13px' : '') }) },
  },
})

/** camera: a perspective camera at `camera` looking with vertical field of view fovy over a 1,000 px high buffer. */
function fakeViewer(groundH?: number, camera?: Cartesian3, fovy = 1) {
  const f = {
    added: [] as unknown[],
    pickResult: undefined as unknown,
    pickedAt: null as Cartesian2 | null,
    heightCalls: 0,
    groundH,
    viewer: null as unknown as Viewer,
  }
  const scene = {
    primitives: {
      add: <T>(p: T): T => (f.added.push(p), p),
      remove: (p: { destroy(): void }): boolean => {
        const i = f.added.indexOf(p)
        if (i < 0) return false
        f.added.splice(i, 1)
        p.destroy()
        return true
      },
    },
    globe: { getHeight: (_c: Cartographic): number | undefined => (f.heightCalls++, f.groundH) },
    pick: (pos: Cartesian2): unknown => ((f.pickedAt = pos), f.pickResult),
    camera: camera && { positionWC: camera, frustum: { fovy } },
    drawingBufferHeight: 1_000,
  }
  f.viewer = { scene } as unknown as Viewer
  return f
}

type F = ReturnType<typeof fakeViewer>
const bbs = (f: F): BillboardCollection => f.added.find((p) => p instanceof BillboardCollection) as BillboardCollection
const labels = (f: F): LabelCollection => f.added.find((p) => p instanceof LabelCollection) as LabelCollection
const all = (f: F): Billboard[] => Array.from({ length: bbs(f).length }, (_, i) => bbs(f).get(i))
const bb = (f: F, hex: string): Billboard => all(f).find((b) => b.id === hex && b.image !== HALO_ID) as Billboard
const halo = (f: F): Billboard => all(f).find((b) => b.image === HALO_ID) as Billboard
const label = (f: F) => labels(f).get(0)
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} ${msg}`)
/** Cesium counts property changes per property index; a frame that changes nothing adds nothing. */
const changes = (f: F): number[] => [...(bbs(f) as unknown as { _propertiesChanged: Uint32Array })._propertiesChanged]
const atlasIds = (f: F): number => (bbs(f) as unknown as { textureAtlas: { _indexById: Map<string, number> } }).textureAtlas._indexById.size

const info = (hex: string, o: Partial<AircraftInfo> = {}): AircraftInfo => ({
  hex, callsign: 'DLH4AB', reg: null, typeCode: 'A320', category: 'A3', squawk: null, emergency: null, military: false, route: null, ...o,
})
const fe = (hex: string, o: Partial<FleetEntry> = {}): FleetEntry => ({
  hex, lat: 50, lon: 10, hM: 10_000, altFt: 33_000, onGround: false, trackDeg: 90, gsKt: 450, vsFpm: 0, ageS: 1, quality: 'adsb2',
  info: info(hex), ...o,
})

test('one billboard collection (single translucent pass) and one label collection', () => {
  const f = fakeViewer()
  new FleetLayer(f.viewer)
  assert.equal(f.added.length, 2)
  assert.equal(bbs(f).blendOption, BlendOption.TRANSLUCENT)
  assert.ok(labels(f))
  assert.equal(halo(f).show, false, 'selection ring starts hidden')
  assert.equal(label(f).show, false, 'label starts hidden')
})

test('one billboard per hex at its position, reused and moved in place', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  layer.update([fe('aaaaaa', { lat: 50, lon: 10, hM: 9_000 }), fe('bbbbbb', { lat: 45, lon: 5 })], null, null)
  const a = bb(f, 'aaaaaa')
  assert.ok(a && bb(f, 'bbbbbb'))
  assert.equal(bbs(f).length, 3, 'two aircraft + the selection ring')
  assert.ok(Cartesian3.equalsEpsilon(a.position, Cartesian3.fromDegrees(10, 50, 9_000), 0, 1e-6))
  layer.update([fe('aaaaaa', { lat: 50.1, lon: 10, hM: 9_000 }), fe('bbbbbb', { lat: 45, lon: 5 })], null, null)
  assert.equal(bb(f, 'aaaaaa'), a, 'same Billboard object')
  assert.equal(bbs(f).length, 3)
  assert.ok(Cartesian3.equalsEpsilon(a.position, Cartesian3.fromDegrees(10, 50.1, 9_000), 0, 1e-6))
})

test('rotation = −track, about the local north axis, so the nose points along the track', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  layer.update([fe('aaaaaa', { lat: 47.3, lon: 11.4, trackDeg: 90 })], null, null)
  const b = bb(f, 'aaaaaa')
  near(b.rotation, -Math.PI / 2, 1e-12)
  const enu = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(11.4, 47.3, 0))
  const north = Matrix4.getColumn(enu, 1, new Cartesian4())
  assert.ok(Cartesian3.equalsEpsilon(b.alignedAxis, new Cartesian3(north.x, north.y, north.z), 1e-12), 'aligned axis = ENU north')
  layer.update([fe('aaaaaa', { lat: 47.3, lon: 11.4, trackDeg: 225 })], null, null)
  near(b.rotation, (-225 * Math.PI) / 180, 1e-12)
  layer.update([fe('aaaaaa', { lat: 47.3, lon: 11.4, trackDeg: null })], null, null)
  near(b.rotation, (-225 * Math.PI) / 180, 1e-12, 'no track → keep the last one')
  layer.update([fe('bbbbbb', { trackDeg: null })], null, null)
  assert.equal(bb(f, 'bbbbbb').rotation, 0, 'never had a track → north')
})

test('northAt is the unit ENU north vector', () => {
  for (const [lat, lon] of [[0, 0], [37.6, -122.4], [-33.9, 151.2], [89, 45]]) {
    const n = northAt(lat, lon, new Cartesian3())
    const enu = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(lon, lat, 0))
    const c = Matrix4.getColumn(enu, 1, new Cartesian4())
    assert.ok(Cartesian3.equalsEpsilon(n, new Cartesian3(c.x, c.y, c.z), 1e-12), `${lat}, ${lon}`)
  }
})

test('colour = altitude colour; ground grey; unknown altitude light grey', () => {
  const f = fakeViewer(100)
  const layer = new FleetLayer(f.viewer)
  layer.update([fe('aaaaaa', { altFt: 2_000 }), fe('bbbbbb', { altFt: 38_000 }), fe('cccccc', { onGround: true, altFt: null }), fe('dddddd', { altFt: null })], null, null)
  const css = (hex: string): Color => bb(f, hex).color
  assert.ok(css('aaaaaa').equalsEpsilon(Color.fromCssColorString(altitudeColor(2_000, false)), 1e-6))
  assert.ok(css('bbbbbb').equalsEpsilon(Color.fromCssColorString(altitudeColor(38_000, false)), 1e-6))
  assert.ok(css('cccccc').equalsEpsilon(Color.fromCssColorString(altitudeColor(null, true)), 1e-6))
  assert.ok(css('dddddd').equalsEpsilon(Color.fromCssColorString(altitudeColor(null, false)), 1e-6))
  layer.update([fe('aaaaaa', { altFt: 12_000 })], null, null)
  assert.ok(css('aaaaaa').equalsEpsilon(Color.fromCssColorString(altitudeColor(12_000, false)), 1e-6), 'climbing re-tints')
})

test('silhouette follows category/type; one atlas image per kind however many aircraft', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  const many = Array.from({ length: 60 }, (_, i) =>
    fe(`a${String(i).padStart(5, '0')}`, { info: info('x', { category: i % 3 === 0 ? 'A5' : 'A3' }) }),
  )
  layer.update([...many, fe('eeeeee', { info: null }), fe('ffffff', { info: info('ffffff', { category: null, typeCode: 'EC35' }) })], null, null)
  assert.equal(bb(f, 'a00000').image, ICON_ID.heavy)
  assert.equal(bb(f, 'a00001').image, ICON_ID.jet)
  assert.equal(bb(f, 'eeeeee').image, ICON_ID.unknown, 'no info → unknown')
  assert.equal(bb(f, 'ffffff').image, ICON_ID.heli, 'type-code fallback')
  assert.equal(atlasIds(f), 5, 'heavy, jet, unknown, heli + the ring: 62 aircraft share 4 textures')
  layer.update([fe('eeeeee', { info: info('eeeeee', { category: 'A7' }) })], null, null)
  assert.equal(bb(f, 'eeeeee').image, ICON_ID.heli, 'info arriving later swaps the icon')
})

test('selected: 1.4× with the ring on it and hidden inside chase range; deselect restores', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  layer.update([fe('aaaaaa'), fe('bbbbbb', { lat: 48 })], 'bbbbbb', null)
  const [a, b] = [bb(f, 'aaaaaa'), bb(f, 'bbbbbb')]
  assert.equal(b.scale, SELECTED_SCALE)
  assert.equal(SELECTED_SCALE, 1.4)
  assert.equal(a.scale, 1)
  assert.equal(halo(f).show, true)
  assert.ok(halo(f).position.equals(b.position), 'ring sits on the selected aircraft')
  assert.equal(halo(f).id, 'bbbbbb', 'clicking the ring picks the aircraft')
  assert.ok(b.distanceDisplayCondition.near > 1_000, 'icon gives way to the 3-D model when the camera is close')
  assert.ok(!a.distanceDisplayCondition || a.distanceDisplayCondition.near === 0)
  layer.update([fe('aaaaaa'), fe('bbbbbb', { lat: 48 })], null, null)
  assert.equal(b.scale, 1)
  assert.equal(b.distanceDisplayCondition.near, 0)
  assert.equal(halo(f).show, false)
})

test(`entries older than ${MAX_AGE_S} s are hidden, and shown again when fresh`, () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  layer.update([fe('aaaaaa', { ageS: 5 }), fe('bbbbbb', { ageS: MAX_AGE_S + 1 })], 'bbbbbb', 'bbbbbb')
  assert.equal(bb(f, 'aaaaaa').show, true)
  assert.equal(bb(f, 'bbbbbb').show, false)
  assert.equal(halo(f).show, false, 'no ring on a hidden aircraft')
  assert.equal(label(f).show, false, 'no label on a hidden aircraft')
  layer.update([fe('aaaaaa', { ageS: 5 }), fe('bbbbbb', { ageS: 2 })], null, null)
  assert.equal(bb(f, 'bbbbbb').show, true)
})

test('hexes that leave are hidden and their billboards reused for new hexes (no vertex-array rebuild churn)', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  layer.update([fe('aaaaaa'), fe('bbbbbb'), fe('cccccc')], null, null)
  const b = bb(f, 'bbbbbb')
  layer.update([fe('aaaaaa'), fe('cccccc')], null, null)
  assert.equal(b.show, false)
  assert.equal(bb(f, 'bbbbbb'), undefined, 'id cleared')
  f.pickResult = { id: 'bbbbbb' }
  assert.equal(layer.pick(new Cartesian2(1, 1)), null, 'a gone hex cannot be picked')
  layer.update([fe('aaaaaa'), fe('cccccc'), fe('dddddd', { lat: 40, trackDeg: 10, altFt: 1_000, info: info('dddddd', { category: 'A1' }) })], null, null)
  assert.equal(bbs(f).length, 4, 'three aircraft + ring: the freed billboard was reused')
  const d = bb(f, 'dddddd')
  assert.equal(d, b)
  assert.equal(d.show, true)
  assert.equal(d.image, ICON_ID.light)
  near(d.rotation, (-10 * Math.PI) / 180, 1e-12)
  assert.ok(Cartesian3.equalsEpsilon(d.position, Cartesian3.fromDegrees(10, 40, 10_000), 0, 1e-6))
  layer.update([], null, null)
  assert.equal(all(f).filter((x) => x.show).length, 0)
})

test('label: hover callsign, else the selected one; hex when no callsign; hidden when neither', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  const es = [fe('aaaaaa', { info: info('aaaaaa', { callsign: 'EZY12' }) }), fe('bbbbbb', { lat: 48, info: null })]
  layer.update(es, null, null)
  assert.equal(label(f).show, false)
  layer.update(es, 'aaaaaa', null)
  assert.equal(label(f).show, true)
  assert.equal(label(f).text, 'EZY12')
  assert.equal(label(f).id, 'aaaaaa')
  assert.ok(label(f).position.equals(bb(f, 'aaaaaa').position))
  layer.update(es, 'aaaaaa', 'bbbbbb')
  assert.equal(label(f).text, 'BBBBBB', 'hover wins; no callsign → hex')
  assert.ok(label(f).position.equals(bb(f, 'bbbbbb').position))
  layer.update(es, null, 'cccccc')
  assert.equal(label(f).show, false, 'hovering a hex that is not drawn')
  assert.equal(labels(f).length, 1, 'exactly one label, ever')
})

test('on the ground: placed on the loaded terrain, sampled once and re-sampled only after moving ~200 m', () => {
  const f = fakeViewer(412)
  const layer = new FleetLayer(f.viewer)
  const g = (lat: number): FleetEntry => fe('aaaaaa', { onGround: true, altFt: null, hM: 48, lat })
  layer.update([g(47.26)], null, null)
  assert.equal(f.heightCalls, 1)
  near(Cartographic.fromCartesian(bb(f, 'aaaaaa').position).height, 412 + GROUND_LIFT_M, 1e-3)
  layer.update([g(47.2601)], null, null)
  layer.update([g(47.2602)], null, null)
  assert.equal(f.heightCalls, 1, '11 m of taxiing: cached')
  layer.update([g(47.263)], null, null)
  assert.equal(f.heightCalls, 2, '330 m: re-sampled')
  layer.update([fe('bbbbbb', { hM: 5_000 })], null, null)
  assert.equal(f.heightCalls, 2, 'airborne aircraft never sample terrain')
})

test('on the ground before the terrain tile loads: at hM, retried a little later', () => {
  const f = fakeViewer(undefined)
  const layer = new FleetLayer(f.viewer)
  const g = fe('aaaaaa', { onGround: true, altFt: null, hM: 48 })
  layer.update([g], null, null)
  near(Cartographic.fromCartesian(bb(f, 'aaaaaa').position).height, 48, 1e-3)
  const calls = f.heightCalls
  for (let i = 0; i < 10; i++) layer.update([g], null, null)
  assert.equal(f.heightCalls, calls, 'not every frame')
  f.groundH = 300
  for (let i = 0; i < 60; i++) layer.update([g], null, null)
  near(Cartographic.fromCartesian(bb(f, 'aaaaaa').position).height, 300 + GROUND_LIFT_M, 1e-3)
})

test('an unchanged frame touches no billboard property; a moving aircraft touches only its position', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  const es = [fe('aaaaaa'), fe('bbbbbb', { lat: 48 })]
  layer.update(es, 'aaaaaa', 'bbbbbb')
  const before = changes(f)
  layer.update(es, 'aaaaaa', 'bbbbbb')
  assert.deepEqual(changes(f), before)
  es[1].lat += 0.001
  layer.update(es, 'aaaaaa', 'bbbbbb')
  const diff = changes(f).map((v, i) => v - before[i])
  const POSITION_INDEX = 1
  assert.equal(diff[POSITION_INDEX], 1, 'one position write')
  assert.equal(diff.reduce((s, v) => s + v, 0), 1, 'nothing else')
})

test('moves below a quarter pixel on screen are not written; they add up until they show', () => {
  // 1,000 km above the aircraft, 1 mrad per pixel: a quarter pixel is ~250 m there
  const f = fakeViewer(undefined, Cartesian3.fromDegrees(10, 50, 1_010_000))
  const layer = new FleetLayer(f.viewer)
  const e = fe('aaaaaa', { lat: 50, lon: 10, hM: 10_000 })
  layer.update([e], null, null)
  const b = bb(f, 'aaaaaa')
  const first = b.position.clone()
  const POSITION_INDEX = 1
  const writes = (): number => changes(f)[POSITION_INDEX]
  const w0 = writes()
  e.lat += 0.001 // 111 m
  layer.update([e], null, null)
  e.lat += 0.001 // 222 m in total
  layer.update([e], null, null)
  assert.equal(writes(), w0, 'not written')
  assert.ok(b.position.equals(first))
  e.lat += 0.001 // 333 m since the last write
  layer.update([e], null, null)
  assert.equal(writes(), w0 + 1)
  assert.ok(Cartesian3.equalsEpsilon(b.position, Cartesian3.fromDegrees(10, 50.003, 10_000), 0, 1e-6))
  e.lon += 0.002 // 143 m east at 50° N
  layer.update([e], null, null)
  assert.equal(writes(), w0 + 1, 'not written')
  e.lon += 0.003 // 358 m east since the last write
  layer.update([e], null, null)
  assert.equal(writes(), w0 + 2, 'eastward moves count too')

  const close = fakeViewer(undefined, Cartesian3.fromDegrees(10, 50, 10_500)) // chase range: 500 m away
  const layer2 = new FleetLayer(close.viewer)
  const e2 = fe('bbbbbb', { lat: 50, lon: 10, hM: 10_000 })
  layer2.update([e2], null, null)
  e2.lat += 0.00005 // 5.6 m, ~11 px at 500 m
  layer2.update([e2], null, null)
  assert.ok(Cartesian3.equalsEpsilon(bb(close, 'bbbbbb').position, Cartesian3.fromDegrees(10, 50.00005, 10_000), 0, 1e-6), 'written')
})

test('pick returns the hex under the cursor (icon, ring or label), null otherwise', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  layer.update([fe('a1b2c3')], 'a1b2c3', null)
  const at = new Cartesian2(100, 200)
  f.pickResult = { primitive: bb(f, 'a1b2c3'), id: 'a1b2c3' }
  assert.equal(layer.pick(at), 'a1b2c3')
  assert.equal(f.pickedAt, at)
  f.pickResult = { primitive: halo(f), id: halo(f).id }
  assert.equal(layer.pick(at), 'a1b2c3')
  f.pickResult = { id: label(f).id }
  assert.equal(layer.pick(at), 'a1b2c3')
  f.pickResult = undefined
  assert.equal(layer.pick(at), null, 'nothing under the cursor')
  f.pickResult = { id: 'ffffff' }
  assert.equal(layer.pick(at), null, 'a hex this layer does not draw')
  f.pickResult = { id: { name: 'an entity' } }
  assert.equal(layer.pick(at), null, 'another layer’s object')
})

test('destroy removes and destroys both collections', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  layer.update([fe('a1b2c3')], null, null)
  const [b, l] = [bbs(f), labels(f)]
  layer.destroy()
  assert.equal(f.added.length, 0)
  assert.ok(b.isDestroyed())
  assert.ok(l.isDestroyed())
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/scene/fleetLayer.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/scene/fleetLayer.ts' imported from …/client/scene/fleetLayer.test.ts`

- [ ] **Step 3: Write the implementation**

```ts
// client/scene/fleetLayer.ts
import {
  BillboardCollection,
  BlendOption,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  DistanceDisplayCondition,
  Ellipsoid,
  HorizontalOrigin,
  LabelCollection,
  LabelStyle,
  NearFarScalar,
  VerticalOrigin,
} from 'cesium'
import type { Billboard, Label, PerspectiveFrustum, Scene, Viewer } from 'cesium'
import type { FleetEntry } from '../types.ts'
import { ALTITUDE_RGBA, COLOR_COUNT, altitudeIndex } from './altitudeColor.ts'
import { HALO_ID, HALO_PX, ICON_ID, ICON_PX, haloCanvas, iconCanvas, iconFor } from './icons.ts'
import type { IconKind } from './icons.ts'

const RAD = Math.PI / 180
export const MAX_AGE_S = 60 // older entries are hidden (the Fleet prunes them later)
export const SELECTED_SCALE = 1.4
export const CHASE_HIDE_M = 5_000 // the selected icon, ring and label give way to the 3-D model inside this range
export const GROUND_LIFT_M = 2 // above the sampled terrain, so a ground icon never z-fights the surface
const AXIS_STEP_DEG = 0.05 // re-aim a billboard's north axis after moving this far (0.05° of arc is invisible)
const MIN_MOVE_PX = 0.25 // a position change smaller than this on screen is not written (see #draw)
const M_PER_DEG = 111_320
const GROUND_STEP_DEG = 0.002 // re-sample the terrain under a ground aircraft after ~200 m
const GROUND_REFRESH_FRAMES = 600 // … and every ~10 s anyway, as finer terrain tiles load
const GROUND_RETRY_FRAMES = 30 // tile not loaded yet: try again in ~0.5 s (staggered per aircraft)

/** One shared Color per colour-table entry: frames allocate none. */
const COLORS: readonly Color[] = Array.from(
  { length: COLOR_COUNT },
  (_, i) => new Color(ALTITUDE_RGBA[i * 4], ALTITUDE_RGBA[i * 4 + 1], ALTITUDE_RGBA[i * 4 + 2], ALTITUDE_RGBA[i * 4 + 3]),
)
const HALO_COLOR = Color.fromCssColorString('#ffd23f')
const LABEL_BG = Color.fromCssColorString('#16181d')
/** Icons shrink to half size between 300 km and 8,000 km from the camera (continental views stay readable). */
const SIZE_BY_DISTANCE = new NearFarScalar(3e5, 1, 8e6, 0.5)
const ALWAYS = new DistanceDisplayCondition(0, Number.MAX_VALUE)
const CHASE_HIDE = new DistanceDisplayCondition(CHASE_HIDE_M, Number.MAX_VALUE)
const LABEL_OFFSET = new Cartesian2(0, -(ICON_PX / 2 + 2))
const LABEL_OFFSET_SELECTED = new Cartesian2(0, -(HALO_PX / 2 + 2)) // above the selection ring

/** Local east-north-up "north" unit vector at a geodetic lat/lon, written into `out`. */
export function northAt(latDeg: number, lonDeg: number, out: Cartesian3): Cartesian3 {
  const lat = latDeg * RAD
  const lon = lonDeg * RAD
  const s = Math.sin(lat)
  out.x = -s * Math.cos(lon)
  out.y = -s * Math.sin(lon)
  out.z = Math.cos(lat)
  return out
}

/** Per-hex state: what was last written to the billboard, so unchanged properties are never touched. */
interface Slot {
  b: Billboard
  frame: number
  n: number // creation order, staggers terrain re-samples
  show: boolean
  lat: number // last written position (degrees, metres, and the Cartesian)
  lon: number
  h: number
  x: number
  y: number
  z: number
  cosLat: number
  axisLat: number
  axisLon: number
  rot: number
  color: number
  cat: string | null | undefined
  type: string | null | undefined
  kind: IconKind | null
  sel: boolean | null
  groundH: number
  groundLat: number
  groundLon: number
  groundAt: number
}

/**
 * Every aircraft of the browse view as a small silhouette, rotated to its track and tinted by altitude, in ONE
 * BillboardCollection (one draw call; one texture per silhouette kind). Billboards are keyed by hex and kept across
 * frames; each frame only writes the properties that changed. Aircraft that leave are hidden and their billboards
 * pooled for the next new hex (adding or removing a billboard makes Cesium rebuild the whole vertex array).
 * One reused Label shows the hovered (else selected) callsign; one reused ring marks the selected aircraft.
 */
export class FleetLayer {
  #scene: Scene
  #bbs: BillboardCollection
  #labels: LabelCollection
  #halo: Billboard
  #label: Label
  #byHex = new Map<string, Slot>()
  #free: Billboard[] = []
  #frame = 0
  #made = 0
  #labelHex: string | null = null
  #labelCallsign: string | null = null
  #pos = new Cartesian3()
  #axis = new Cartesian3()
  #cam = new Cartesian3()
  #moveK2 = 0 // (MIN_MOVE_PX × radians per pixel)²; 0 = write every change
  #carto = new Cartographic()

  constructor(viewer: Viewer) {
    this.#scene = viewer.scene
    // TRANSLUCENT: one pass instead of opaque + translucent (icons have soft edges; they still depth-test against the globe).
    this.#bbs = this.#scene.primitives.add(new BillboardCollection({ blendOption: BlendOption.TRANSLUCENT }))
    this.#halo = this.#bbs.add({ position: Cartesian3.ZERO, show: false, color: HALO_COLOR, scaleByDistance: SIZE_BY_DISTANCE, distanceDisplayCondition: CHASE_HIDE })
    this.#halo.setImage(HALO_ID, haloCanvas())
    this.#labels = this.#scene.primitives.add(new LabelCollection())
    this.#label = this.#labels.add({
      position: Cartesian3.ZERO,
      show: false,
      font: '600 13px system-ui, sans-serif',
      fillColor: Color.WHITE,
      style: LabelStyle.FILL,
      showBackground: true,
      backgroundColor: LABEL_BG, // opaque: drawn in the opaque pass, so no icon paints over it
      backgroundPadding: new Cartesian2(6, 3),
      verticalOrigin: VerticalOrigin.BOTTOM,
      horizontalOrigin: HorizontalOrigin.CENTER,
      pixelOffset: LABEL_OFFSET,
      pixelOffsetScaleByDistance: SIZE_BY_DISTANCE,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    })
  }

  update(entries: readonly FleetEntry[], selectedHex: string | null, hoverHex: string | null): void {
    const frame = ++this.#frame
    this.#frameMoveThreshold()
    let touched = 0
    let sel: Slot | null = null
    let selE: FleetEntry | null = null
    let hover: Slot | null = null
    let hoverE: FleetEntry | null = null
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      const s = this.#byHex.get(e.hex) ?? this.#add(e.hex)
      if (s.frame !== frame) touched++
      s.frame = frame
      const visible = e.ageS <= MAX_AGE_S
      if (visible !== s.show) {
        s.b.show = visible
        s.show = visible
      }
      if (!visible) continue
      this.#draw(s, e)
      const isSel = e.hex === selectedHex
      if (isSel !== s.sel) {
        s.b.scale = isSel ? SELECTED_SCALE : 1
        s.b.distanceDisplayCondition = isSel ? CHASE_HIDE : ALWAYS
        s.sel = isSel
      }
      if (isSel) {
        sel = s
        selE = e
      }
      if (e.hex === hoverHex) {
        hover = s
        hoverE = e
      }
    }
    if (touched < this.#byHex.size) this.#sweep(frame)

    const halo = this.#halo
    if (sel && selE) {
      halo.position = sel.b.position
      halo.id = selE.hex
      if (!halo.show) halo.show = true
    } else if (halo.show) halo.show = false
    this.#updateLabel(hover ?? sel, hoverE ?? selE, sel !== null && (hover ?? sel) === sel)
  }

  pick(windowPos: Cartesian2): string | null {
    const id: unknown = this.#scene.pick(windowPos)?.id
    return typeof id === 'string' && this.#byHex.has(id) ? id : null
  }

  destroy(): void {
    this.#scene.primitives.remove(this.#bbs)
    this.#scene.primitives.remove(this.#labels)
    this.#byHex.clear()
    this.#free.length = 0
  }

  #add(hex: string): Slot {
    const b = this.#free.pop() ?? this.#bbs.add({ position: Cartesian3.ZERO, scaleByDistance: SIZE_BY_DISTANCE })
    b.id = hex
    const s: Slot = {
      b, frame: 0, n: this.#made++, show: b.show, lat: NaN, lon: NaN, h: NaN, x: 0, y: 0, z: 0, cosLat: NaN, axisLat: NaN, axisLon: NaN, rot: NaN, color: -1,
      cat: undefined, type: undefined, kind: null, sel: null, groundH: NaN, groundLat: NaN, groundLon: NaN, groundAt: 0,
    }
    this.#byHex.set(hex, s)
    return s
  }

  /** Hides the billboards of hexes missing from this frame and pools them for reuse. */
  #sweep(frame: number): void {
    for (const [hex, s] of this.#byHex) {
      if (s.frame === frame) continue
      s.b.show = false
      s.b.id = undefined
      this.#free.push(s.b)
      this.#byHex.delete(hex)
    }
  }

  /**
   * Movement below MIN_MOVE_PX on screen is not written: every position write makes Cesium re-encode that billboard,
   * and above 10 % dirty it rewrites the whole buffer. Screen size of a move ≈ metres / distance ÷ (radians per pixel).
   * Without a perspective camera (e.g. in Node tests) every change is written.
   */
  #frameMoveThreshold(): void {
    const cam = this.#scene.camera
    const fovy = (cam?.frustum as PerspectiveFrustum | undefined)?.fovy
    const hPx = this.#scene.drawingBufferHeight
    if (!cam || !(typeof fovy === 'number' && fovy > 0) || !(hPx > 0)) {
      this.#moveK2 = 0
      return
    }
    Cartesian3.clone(cam.positionWC, this.#cam)
    const k = (MIN_MOVE_PX * fovy) / hPx
    this.#moveK2 = k * k
  }

  #draw(s: Slot, e: FleetEntry): void {
    const b = s.b
    const h = e.onGround ? this.#groundHeight(s, e) : e.hM
    if (e.lat !== s.lat || e.lon !== s.lon || h !== s.h) {
      const dN = (e.lat - s.lat) * M_PER_DEG
      const dE = (e.lon - s.lon) * M_PER_DEG * s.cosLat
      const dH = h - s.h
      const dx = s.x - this.#cam.x
      const dy = s.y - this.#cam.y
      const dz = s.z - this.#cam.z
      // NaN (first write) fails the test and writes
      if (!(dN * dN + dE * dE + dH * dH <= this.#moveK2 * (dx * dx + dy * dy + dz * dz))) {
        const p = Cartesian3.fromDegrees(e.lon, e.lat, h, Ellipsoid.WGS84, this.#pos)
        b.position = p
        s.lat = e.lat
        s.lon = e.lon
        s.h = h
        s.x = p.x
        s.y = p.y
        s.z = p.z
        if (!(Math.abs(e.lat - s.axisLat) <= AXIS_STEP_DEG && Math.abs(e.lon - s.axisLon) <= AXIS_STEP_DEG)) {
          // rotation is measured from this axis: with north as the axis, rotation = −track points the nose along the track
          b.alignedAxis = northAt(e.lat, e.lon, this.#axis)
          s.axisLat = e.lat
          s.axisLon = e.lon
          s.cosLat = Math.cos(e.lat * RAD)
        }
      }
    }
    if (e.trackDeg !== null) {
      const rot = -e.trackDeg * RAD
      if (rot !== s.rot) {
        b.rotation = rot
        s.rot = rot
      }
    } else if (Number.isNaN(s.rot)) {
      b.rotation = 0
      s.rot = 0
    }
    const c = altitudeIndex(e.altFt, e.onGround)
    if (c !== s.color) {
      b.color = COLORS[c]
      s.color = c
    }
    const cat = e.info === null ? null : e.info.category
    const type = e.info === null ? null : e.info.typeCode
    if (cat !== s.cat || type !== s.type) {
      s.cat = cat
      s.type = type
      const kind = iconFor(cat, type)
      if (kind !== s.kind) {
        b.setImage(ICON_ID[kind], iconCanvas(kind)) // stable id → one atlas entry per kind
        s.kind = kind
      }
    }
  }

  /**
   * FleetEntry.hM on the ground is the geoid (≈ sea level), which can be under the terrain; the loaded terrain height is
   * sampled instead, cached per aircraft. ponytail: coarse tiles can sit a little off the true surface until the
   * ~10 s refresh; upgrade: re-sample on the globe's tileLoadProgressEvent reaching 0.
   */
  #groundHeight(s: Slot, e: FleetEntry): number {
    const globe = this.#scene.globe
    if (!globe) return e.hM
    const moved = !(Math.abs(e.lat - s.groundLat) <= GROUND_STEP_DEG && Math.abs(e.lon - s.groundLon) <= GROUND_STEP_DEG)
    if (moved || this.#frame >= s.groundAt) {
      const h = globe.getHeight(Cartographic.fromDegrees(e.lon, e.lat, 0, this.#carto))
      s.groundH = h === undefined ? NaN : h + GROUND_LIFT_M
      s.groundLat = e.lat
      s.groundLon = e.lon
      s.groundAt = this.#frame + (h === undefined ? GROUND_RETRY_FRAMES : GROUND_REFRESH_FRAMES) + (s.n % GROUND_RETRY_FRAMES)
    }
    return Number.isNaN(s.groundH) ? e.hM : s.groundH
  }

  #updateLabel(s: Slot | null, e: FleetEntry | null, selected: boolean): void {
    const l = this.#label
    if (!s || !e) {
      if (l.show) l.show = false
      return
    }
    const callsign = e.info === null ? null : e.info.callsign
    if (e.hex !== this.#labelHex || callsign !== this.#labelCallsign) {
      l.text = callsign ?? e.hex.toUpperCase()
      l.id = e.hex
      this.#labelHex = e.hex
      this.#labelCallsign = callsign
    }
    l.position = s.b.position
    l.pixelOffset = selected ? LABEL_OFFSET_SELECTED : LABEL_OFFSET
    l.distanceDisplayCondition = selected ? CHASE_HIDE : ALWAYS
    if (!l.show) l.show = true
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/scene/fleetLayer.test.ts`
Expected: PASS — `ℹ tests 16`, `ℹ pass 16`, `ℹ fail 0`.

- [ ] **Step 5: Type-check these files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/fleetLayer'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 6: Commit**

```bash
git add client/scene/fleetLayer.ts client/scene/fleetLayer.test.ts
git commit -m "feat(scene): fleet layer — one billboard collection, pooled by hex, rotated to track, tinted by altitude"
```

---

### Task 4: Altitude legend

**Files:**
- Create: `client/ui/legend.ts`, `client/ui/legend.test.ts`
- Test: `client/ui/legend.test.ts`

**Interfaces:**
- Consumes: `altitudeColor` (Task 1)
- Produces: `mountLegend(root: HTMLElement): { destroy(): void }` (PLAN.md §5.3, exactly) · `legendGradient(): string` · `tickLabel(ft: number): string` · `LEGEND_TICKS_FT`

- [ ] **Step 1: Write the failing test**

```ts
// client/ui/legend.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { altitudeColor } from '../scene/altitudeColor.ts'
import { LEGEND_TICKS_FT, legendGradient, mountLegend, tickLabel } from './legend.ts'

// Node has no DOM: just enough of one for mountLegend (createElement, append, remove, style, textContent, attributes).
class El {
  children: El[] = []
  parent: El | null = null
  style: Record<string, string> = {}
  attrs: Record<string, string> = {}
  className = ''
  textContent = ''
  tagName: string
  constructor(tagName: string) {
    this.tagName = tagName
  }
  append(...cs: El[]): void {
    for (const c of cs) {
      c.parent = this
      this.children.push(c)
    }
  }
  remove(): void {
    if (!this.parent) return
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v
  }
  find(cls: string): El | undefined {
    if (this.className === cls) return this
    for (const c of this.children) {
      const f = c.find(cls)
      if (f) return f
    }
    return undefined
  }
}
Object.assign(globalThis, { document: { createElement: (tag: string) => new El(tag) } })
const mount = (): { root: El; legend: { destroy(): void } } => {
  const root = new El('div')
  return { root, legend: mountLegend(root as unknown as HTMLElement) }
}

test('ticks: 0, 1 000, 2 000, 4 000, 6 000, 8 000, 10 000, 20 000, 30 000, 40 000+ ft', () => {
  assert.deepEqual([...LEGEND_TICKS_FT], [0, 1_000, 2_000, 4_000, 6_000, 8_000, 10_000, 20_000, 30_000, 40_000])
  assert.deepEqual(
    LEGEND_TICKS_FT.map(tickLabel),
    ['0', '1 000', '2 000', '4 000', '6 000', '8 000', '10 000', '20 000', '30 000', '40 000+'],
  )
})

test('gradient: evenly spaced ticks, each tick in its altitude colour, sampled in between', () => {
  const g = legendGradient()
  assert.ok(g.startsWith(`linear-gradient(to right, ${altitudeColor(0, false)} 0.00%`), g.slice(0, 80))
  assert.ok(g.endsWith(`${altitudeColor(40_000, false)} 100.00%)`))
  const n = LEGEND_TICKS_FT.length - 1
  LEGEND_TICKS_FT.forEach((ft, i) => assert.ok(g.includes(`${altitudeColor(ft, false)} ${((i / n) * 100).toFixed(2)}%`), `${ft} ft at tick ${i}`))
  assert.ok(g.includes(`${altitudeColor(15_000, false)} ${((6.5 / n) * 100).toFixed(2)}%`), 'half-way between 10 000 and 20 000')
  assert.ok(g.split('%').length - 1 > 60, 'enough stops for the HSL path')
})

test('mountLegend: one element with a ground swatch, the bar and the tick labels at their positions', () => {
  const { root } = mount()
  assert.equal(root.children.length, 1)
  const el = root.children[0]
  assert.match(el.attrs['aria-label'], /altitude/i)
  const gnd = el.find('fh-legend-gnd') as El
  assert.equal(gnd.textContent, 'GND')
  assert.equal(gnd.style.background, altitudeColor(null, true))
  assert.equal((el.find('fh-legend-bar') as El).style.background, legendGradient())
  const ticks = (el.find('fh-legend-ticks') as El).children
  assert.deepEqual(ticks.map((t) => t.textContent), LEGEND_TICKS_FT.map(tickLabel))
  assert.deepEqual(ticks.map((t) => t.style.left), LEGEND_TICKS_FT.map((_, i) => `${((i / 9) * 100).toFixed(2)}%`))
  assert.equal((el.find('fh-legend-unit') as El).textContent, 'ft')
  assert.equal(el.style.pointerEvents, 'none', 'never blocks the map under it')
})

test('destroy removes the legend; twice is harmless', () => {
  const { root, legend } = mount()
  legend.destroy()
  assert.equal(root.children.length, 0)
  legend.destroy()
  assert.equal(root.children.length, 0)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/ui/legend.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/ui/legend.ts' imported from …/client/ui/legend.test.ts`

- [ ] **Step 3: Write the implementation**

```ts
// client/ui/legend.ts
import { altitudeColor } from '../scene/altitudeColor.ts'

/** Tick altitudes, evenly spaced along the bar (the low end, where most colour change happens, gets more room). */
export const LEGEND_TICKS_FT: readonly number[] = [0, 1_000, 2_000, 4_000, 6_000, 8_000, 10_000, 20_000, 30_000, 40_000]
const SAMPLES_PER_GAP = 8 // CSS interpolates in RGB; sampling the HSL path keeps the bar true to the icons

/** '0', '1 000', …, '40 000+' (narrow no-break space between thousands). */
export function tickLabel(ft: number): string {
  const s = ft >= 1_000 ? `${Math.floor(ft / 1_000)} ${String(ft % 1_000).padStart(3, '0')}` : String(ft)
  return ft === LEGEND_TICKS_FT[LEGEND_TICKS_FT.length - 1] ? `${s}+` : s
}

/** The bar's CSS background: every tick at i/(n−1) of the width in its altitude colour, 8 samples per gap. */
export function legendGradient(): string {
  const n = LEGEND_TICKS_FT.length - 1
  const stops: string[] = []
  for (let i = 0; i < n; i++) {
    const a = LEGEND_TICKS_FT[i]
    const b = LEGEND_TICKS_FT[i + 1]
    for (let k = 0; k < SAMPLES_PER_GAP; k++) {
      const f = k / SAMPLES_PER_GAP
      stops.push(`${altitudeColor(a + (b - a) * f, false)} ${(((i + f) / n) * 100).toFixed(2)}%`)
    }
  }
  stops.push(`${altitudeColor(LEGEND_TICKS_FT[n], false)} 100.00%`)
  return `linear-gradient(to right, ${stops.join(', ')})`
}

function el(tag: string, className: string, style: Partial<CSSStyleDeclaration>, text = ''): HTMLElement {
  const e = document.createElement(tag)
  e.className = className
  Object.assign(e.style, style)
  if (text) e.textContent = text
  return e
}

/**
 * The altitude colour key (ground swatch + gradient bar + ft ticks) appended to `root`. Inline styles, so it needs no
 * stylesheet; the caller positions `root`. It ignores the pointer, so the map under it stays draggable.
 */
export function mountLegend(root: HTMLElement): { destroy(): void } {
  const box = el('div', 'fh-legend', {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    boxSizing: 'border-box',
    width: '100%',
    maxWidth: '520px',
    padding: '4px 8px 2px',
    background: 'rgba(255, 255, 255, 0.88)',
    color: '#1d1f24',
    borderRadius: '4px',
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.3)',
    font: '10px/1.2 system-ui, sans-serif',
    pointerEvents: 'none',
    userSelect: 'none',
  })
  box.setAttribute('role', 'img')
  box.setAttribute('aria-label', 'Altitude colours: grey on the ground, then orange at 0 ft through yellow, green, cyan, blue and violet to magenta at 40,000 ft and above')
  const gnd = el('span', 'fh-legend-gnd', {
    flex: 'none',
    padding: '1px 4px',
    borderRadius: '2px',
    background: altitudeColor(null, true),
    color: '#fff',
    fontWeight: '600',
  }, 'GND')
  const scale = el('div', 'fh-legend-scale', { flex: '1', minWidth: '0', padding: '0 16px 0 6px' })
  const bar = el('div', 'fh-legend-bar', { height: '8px', borderRadius: '2px', background: legendGradient() })
  const ticks = el('div', 'fh-legend-ticks', { position: 'relative', height: '13px', marginTop: '2px' })
  const n = LEGEND_TICKS_FT.length - 1
  LEGEND_TICKS_FT.forEach((ft, i) => {
    ticks.append(el('span', 'fh-legend-tick', {
      position: 'absolute',
      left: `${((i / n) * 100).toFixed(2)}%`,
      transform: 'translateX(-50%)',
      whiteSpace: 'nowrap',
    }, tickLabel(ft)))
  })
  scale.append(bar, ticks)
  box.append(gnd, scale, el('span', 'fh-legend-unit', { flex: 'none', alignSelf: 'flex-end', opacity: '0.7' }, 'ft'))
  root.append(box)
  return { destroy: () => box.remove() }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/ui/legend.test.ts`
Expected: PASS — `ℹ tests 4`, `ℹ pass 4`, `ℹ fail 0`.

- [ ] **Step 5: Type-check these files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/ui/legend'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 6: Commit**

```bash
git add client/ui/legend.ts client/ui/legend.test.ts
git commit -m "feat(ui): altitude colour legend"
```

---

### Task 5: Harness page and performance measurement

**Files:**
- Create: `harness/fleet-layer.html`, `harness/fleet-layer.ts`

**Interfaces:**
- Consumes: `FleetLayer` (Task 3), `mountLegend` (Task 4), `FleetEntry`/`AircraftInfo` (WP-B0); the Vite setup from WP-00. No network: `?bg=ne` uses Cesium's bundled `Assets/Textures/NaturalEarthII`.
- Produces: the page `/harness/fleet-layer.html` (`?n=`, `?h=`, `?pitch=`, `?bg=light|dark|ne`, `?churn=`, `?test=compass`) and `window.harness = { viewer, layer, entries, stats(), reset(), bench(frames), select(hex) }`

- [ ] **Step 1: Write the page**

```html
<!-- harness/fleet-layer.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Harness: fleet layer</title>
    <style>
      html, body, #globe { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
      #info { position: absolute; top: 8px; left: 8px; padding: 6px 10px; font: 12px/1.5 ui-monospace, monospace; color: #fff; background: rgba(0, 0, 0, 0.7); border-radius: 4px; white-space: pre; pointer-events: none; }
      #legend { position: absolute; left: 50%; bottom: 30px; transform: translateX(-50%); width: min(520px, calc(100vw - 32px)); display: flex; justify-content: center; }
    </style>
  </head>
  <body>
    <div id="globe"></div>
    <div id="info"></div>
    <div id="legend"></div>
    <script type="module" src="/harness/fleet-layer.ts"></script>
  </body>
</html>
```

```ts
// harness/fleet-layer.ts
// Manual + performance check for WP-B-V1. Open /harness/fleet-layer.html
//   ?n=5000        synthetic aircraft over Europe, moving along their tracks every frame (default 5000)
//   ?h=3000000     camera height in metres, top-down and north-up (default 3,000 km)
//   ?pitch=-90     camera pitch in degrees (e.g. -50 to check the icon rotation in a tilted view)
//   ?bg=light      light land colour like a street map (default) · dark · ne (Natural Earth II bundled with Cesium, no network)
//   ?churn=0.005   fraction of aircraft replaced by new hexes each second (exercises the billboard pool)
//   ?test=compass  12 still aircraft around 50°N 10°E, every nose pointing outward, two of each silhouette
// Hover shows the callsign, click selects (1.4× + ring), Esc clears. window.harness.stats() returns the FPS numbers;
// window.harness.reset() restarts the measurement window.
import {
  Cartesian2,
  Cartesian3,
  Color,
  EllipsoidTerrainProvider,
  ImageryLayer,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  TileMapServiceImageryProvider,
  Viewer,
  buildModuleUrl,
} from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import type { AircraftInfo } from '../shared/info.ts'
import type { FleetEntry } from '../client/types.ts'
import { FleetLayer } from '../client/scene/fleetLayer.ts'
import { mountLegend } from '../client/ui/legend.ts'

const q = new URLSearchParams(location.search)
const N = Number(q.get('n') ?? 5000)
const HEIGHT_M = Number(q.get('h') ?? 3_000_000)
const PITCH_DEG = Number(q.get('pitch') ?? -90)
const BG = q.get('bg') ?? 'light'
const CHURN = Number(q.get('churn') ?? 0.005)
const COMPASS = q.get('test') === 'compass'
const RAD = Math.PI / 180
const CENTER = { lat: 50, lon: 10 }
const WARMUP_MS = 3_000
const WINDOW = 1_200 // frames kept for the percentiles

async function main(): Promise<void> {
  const viewer = new Viewer('globe', {
    terrainProvider: new EllipsoidTerrainProvider(),
    baseLayer: BG === 'ne' ? new ImageryLayer(await TileMapServiceImageryProvider.fromUrl(buildModuleUrl('Assets/Textures/NaturalEarthII'))) : false,
    baseLayerPicker: false,
    geocoder: false,
    timeline: false,
    animation: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
  })
  const scene = viewer.scene
  scene.globe.baseColor = Color.fromCssColorString(BG === 'dark' ? '#1c2331' : '#ece8df')
  scene.globe.showGroundAtmosphere = false
  scene.globe.depthTestAgainstTerrain = true // as the app does
  scene.fog.enabled = false
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false
  viewer.camera.setView({
    destination: Cartesian3.fromDegrees(CENTER.lon, CENTER.lat, HEIGHT_M),
    orientation: { heading: 0, pitch: PITCH_DEG * RAD, roll: 0 },
  })

  // Deterministic synthetic traffic.
  let seed = 42
  const rnd = (): number => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
  const AIRLINES = ['DLH', 'RYR', 'EZY', 'BAW', 'AFR', 'KLM', 'THY', 'UAE', 'WZZ', 'SAS', 'ELY', 'LOT']
  const FALLBACK_TYPES = ['B738', 'A388', 'C172', 'EC35', 'B77W', 'AT76']
  let nextId = 0

  function makeInfo(hex: string, category: string | null, typeCode: string | null, callsign: string | null): AircraftInfo {
    return { hex, callsign, reg: null, typeCode, category, squawk: null, emergency: null, military: false, route: null }
  }

  function makeEntry(): FleetEntry {
    const hex = (0x400000 + nextId++).toString(16)
    const onGround = rnd() < 0.06
    const u = rnd()
    const altFt = onGround ? null : u < 0.25 ? rnd() * 10_000 : u < 0.45 ? 10_000 + rnd() * 15_000 : 25_000 + rnd() * 18_000
    const c = rnd()
    let category: string | null = c < 0.55 ? 'A3' : c < 0.65 ? 'A1' : c < 0.75 ? 'A2' : c < 0.85 ? 'A5' : c < 0.89 ? 'A7' : c < 0.9 ? 'B1' : null
    let typeCode: string | null = category === null && c < 0.97 ? pick(FALLBACK_TYPES) : null
    if (onGround && rnd() < 0.3) [category, typeCode] = ['C2', null]
    const callsign = rnd() < 0.9 ? `${pick(AIRLINES)}${100 + Math.floor(rnd() * 900)}` : null
    return {
      hex,
      lat: 36 + rnd() * 26,
      lon: -10 + rnd() * 40,
      hM: altFt === null ? 45 : altFt * 0.3048 + 45,
      altFt,
      onGround,
      trackDeg: rnd() * 360,
      gsKt: onGround ? rnd() * 20 : 120 + rnd() * 370,
      vsFpm: !onGround && rnd() < 0.2 ? (rnd() < 0.5 ? -1500 : 1500) : 0,
      ageS: rnd() < 0.01 ? 90 : 1 + rnd() * 4,
      quality: 'adsb2',
      info: makeInfo(hex, category, typeCode, callsign),
    }
  }

  function compass(): FleetEntry[] {
    const kinds: [string | null, string | null][] = [['A3', null], ['A5', null], ['A1', null], ['A7', null], ['C2', null], [null, null]]
    return Array.from({ length: 12 }, (_, i) => {
      const [category, typeCode] = kinds[i % kinds.length]
      const brg = i * 30
      const hex = (0x500000 + i).toString(16)
      const onGround = category === 'C2'
      const altFt = onGround ? null : i * 3_500
      return {
        hex,
        lat: CENTER.lat + 1.2 * Math.cos(brg * RAD),
        lon: CENTER.lon + (1.2 * Math.sin(brg * RAD)) / Math.cos(CENTER.lat * RAD),
        hM: altFt === null ? 45 : altFt * 0.3048 + 45,
        altFt,
        onGround,
        trackDeg: brg,
        gsKt: 0,
        vsFpm: 0,
        ageS: 1,
        quality: 'adsb2',
        info: makeInfo(hex, category, typeCode, `BRG${String(brg).padStart(3, '0')}`),
      } satisfies FleetEntry
    })
  }

  const entries: FleetEntry[] = COMPASS ? compass() : Array.from({ length: N }, makeEntry)

  /** Dead-reckon every aircraft along its track (flat-earth step; reflect at the box edges). Mutates in place. */
  function move(dtS: number): void {
    for (const e of entries) {
      if (!e.gsKt || e.trackDeg === null) continue
      const nm = (e.gsKt * dtS) / 3600
      const tr = e.trackDeg * RAD
      e.lat += (nm * Math.cos(tr)) / 60
      e.lon += (nm * Math.sin(tr)) / (60 * Math.cos(e.lat * RAD))
      if (e.lat < 34 || e.lat > 64) e.trackDeg = (540 - e.trackDeg) % 360
      if (e.lon < -14 || e.lon > 36) e.trackDeg = 360 - e.trackDeg
      if (e.vsFpm && e.altFt !== null) {
        e.altFt = Math.min(43_000, Math.max(500, e.altFt + (e.vsFpm * dtS) / 60))
        e.hM = e.altFt * 0.3048 + 45
      }
    }
  }

  const layer = new FleetLayer(viewer)
  mountLegend(document.getElementById('legend') as HTMLElement)
  let selected: string | null = null
  let hover: string | null = null
  let mouse: Cartesian2 | null = null

  const frameMs: number[] = []
  const updateMs: number[] = []
  let t0 = performance.now()
  let lastFrame = 0
  let lastSim = performance.now()
  let lastChurn = performance.now()
  const pct = (xs: number[], p: number): number => {
    if (xs.length === 0) return NaN
    const s = [...xs].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.floor(p * s.length))]
  }
  const push = (xs: number[], v: number): void => {
    xs.push(v)
    if (xs.length > WINDOW) xs.shift()
  }
  const stats = () => ({
    n: entries.length,
    frames: frameMs.length,
    fpsP50: Math.round(10 * (1000 / pct(frameMs, 0.5))) / 10,
    fpsP5: Math.round(10 * (1000 / pct(frameMs, 0.95))) / 10,
    updateMsP50: Math.round(100 * pct(updateMs, 0.5)) / 100,
    updateMsP95: Math.round(100 * pct(updateMs, 0.95)) / 100,
  })
  const reset = (): void => {
    frameMs.length = 0
    updateMs.length = 0
    t0 = performance.now() - WARMUP_MS
  }

  scene.preUpdate.addEventListener(() => {
    const now = performance.now()
    move(Math.min(0.25, (now - lastSim) / 1000))
    lastSim = now
    if (!COMPASS && CHURN > 0 && now - lastChurn >= 1000) {
      lastChurn = now
      for (let k = Math.round(entries.length * CHURN); k > 0; k--) entries[Math.floor(rnd() * entries.length)] = makeEntry()
    }
    if (mouse) {
      hover = layer.pick(mouse) // at most one pick per frame while the mouse moves
      mouse = null
    }
    const a = performance.now()
    layer.update(entries, selected, hover)
    if (now - t0 > WARMUP_MS) push(updateMs, performance.now() - a)
  })

  const info = document.getElementById('info') as HTMLElement
  scene.postRender.addEventListener(() => {
    const now = performance.now()
    if (lastFrame && now - t0 > WARMUP_MS) push(frameMs, now - lastFrame)
    lastFrame = now
    if (frameMs.length % 30 === 0) {
      const s = stats()
      info.textContent =
        `${s.n} aircraft · ${s.frames} frames\n` +
        `fps p50 ${s.fpsP50} · p5 ${s.fpsP5}\n` +
        `update p50 ${s.updateMsP50} ms · p95 ${s.updateMsP95} ms\n` +
        `selected ${selected ?? '—'} · hover ${hover ?? '—'}`
    }
  })

  const handler = new ScreenSpaceEventHandler(scene.canvas)
  handler.setInputAction((ev: ScreenSpaceEventHandler.MotionEvent) => {
    mouse = Cartesian2.clone(ev.endPosition)
  }, ScreenSpaceEventType.MOUSE_MOVE)
  handler.setInputAction((ev: ScreenSpaceEventHandler.PositionedEvent) => {
    selected = layer.pick(ev.position)
  }, ScreenSpaceEventType.LEFT_CLICK)
  addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') selected = null
  })

  /**
   * Frame cost without the display in the loop (a background tab's rAF is throttled): `frames` synchronous
   * viewer.render() calls, each followed by a 1-pixel readPixels so the GPU work is inside the measurement too.
   */
  function bench(frames = 300): { n: number; msP50: number; msP95: number; fpsP50: number; fpsP5: number; updateMsP50: number } {
    const gl = (scene as unknown as { context: { _gl: WebGL2RenderingContext } }).context._gl
    const px = new Uint8Array(4)
    const ms: number[] = []
    viewer.useDefaultRenderLoop = false
    updateMs.length = 0
    t0 = performance.now() - WARMUP_MS
    for (let i = 0; i < frames; i++) {
      const a = performance.now()
      viewer.render()
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
      ms.push(performance.now() - a)
    }
    viewer.useDefaultRenderLoop = true
    const p50 = pct(ms, 0.5)
    const p95 = pct(ms, 0.95)
    const r = (x: number): number => Math.round(x * 100) / 100
    return { n: entries.length, msP50: r(p50), msP95: r(p95), fpsP50: r(1000 / p50), fpsP5: r(1000 / p95), updateMsP50: r(pct(updateMs, 0.5)) }
  }

  ;(window as unknown as { harness: object }).harness = { viewer, layer, entries, stats, reset, bench, select: (hex: string | null) => (selected = hex) }
}

void main()
```

- [ ] **Step 2: Type-check the page**

Run: `npx tsc --noEmit 2>&1 | grep -E 'harness/fleet-layer'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Look at it**

Run: `npx vite --port 5411 --strictPort`, open `http://localhost:5411/harness/fleet-layer.html?test=compass`.
Expected: 12 still icons on a light land colour in a ring around 50° N 10° E. Every nose points outward: bearing 0° points up, 90° right, 180° down and 270° left. There are two each of jet, heavy, light, helicopter (tinted rotor disc), ground vehicle (small grey box) and arrowhead (unknown). Colours run from orange (0 ft, top) through yellow, green, cyan, blue and violet to magenta (38,500 ft, bearing 330°), and the ground vehicles are grey. Hovering an icon shows its callsign (`BRG030` …) in a dark label above it. Clicking selects it: 1.4× with a gold ring, and the label moves above the ring. Moving away keeps the selected aircraft's label. `Esc` clears. At the bottom centre is the legend: a grey `GND` swatch, then the gradient with `0 … 40 000+` and `ft`. The Cesium credit line stays visible under it. `?test=compass&pitch=-55&h=260000`: the noses still point along their bearings in perspective. The console has no errors.

Then open `http://localhost:5411/harness/fleet-layer.html` (5,000 aircraft).
Expected: 5,000 icons, moving, fill the 36–62° N, 10° W–30° E box, which a 3,000 km top-down view shows as a trapezoid. About 6 % are grey (on the ground), some show tinted rotor discs (helicopters), and most are violet/magenta (cruise). The overlay shows `5000 aircraft`, `fps p50` about the display rate, and `update` well under 1 ms. `?pitch=-50&h=1500000` shows them in perspective. `?bg=ne` (Natural Earth II, served locally) shows every icon readable against imagery thanks to the dark outline.

- [ ] **Step 4: Measure**

For each of `?n=1000`, `?n=5000` and `?n=10000`: load the page, wait ~15 s with the tab in front, then read `harness.stats()` in the console (rAF meter over the last 1,200 frames after a 3 s warm-up) and run `harness.bench(300)` (300 synchronous `viewer.render()` + 1-pixel `readPixels` frames, so the frame time includes the GPU and does not depend on the display rate or a throttled background tab).
Expected (user's Mac, MacBook Air, Apple M2, 16 GB; headless Chrome with ANGLE Metal, 1440 × 900 window, DPR 1; top-down 3,000 km over Europe with every aircraft in view, churn 0.5 %/s):

| Aircraft | `bench(300)` frame ms p50 / p95 | → FPS p50 / p5 | `update()` ms p50 | rAF meter FPS p50 / p5 (60 Hz cap) |
|---|---|---|---|---|
| 0 (globe only) | 6.5 / 7.6 | 154 / 132 | — | 59.9 / 57.1 |
| 1,000 | 7.5 / 8.9 | 133 / 112 | 0.1 | 60.2 / 54.1 |
| **5,000** | **8.2 / 10.3** | **122 / 97** | 0.4 | 60.2 / 54.1 |
| 10,000 | 9.4 / 12.8 | 106 / 78 | 0.7 | 60.2 / 53.8 |
| 12,000 (tar1090's worldwide count) | 10.1 / 14.6 | 99 / 68 | 0.9 | 60.2 / 54.1 |

Also measured: 5,000 at the browse default height (300 km, most aircraft off screen) took 7.5 / 9.4 ms (133 / 106 FPS), and 5,000 with no churn took 8.2 / 9.8 ms. Before the sub-pixel skip, every moving aircraft was written every frame: 5,000 → 11.3 / 12.8 ms (88 / 78 FPS), 10,000 → 15.0 / 16.9 ms (67 / 59), 12,000 → 16.2 / 18.2 ms (62 / 55). The same fleet standing still took 8.0 ms (5,000) and 9.5 ms (12,000), so the skip brings a moving fleet close to the cost of a still one. The fleet layer now adds about 1.7 ms per frame to the bare globe at 5,000 aircraft and about 3.6 ms at 12,000. The headless rAF is capped at 60 Hz, so the rAF meter only shows the display rate. The `bench()` numbers are the capacity: on the user's 100 Hz external display, 5,000 aircraft stay display-limited. Note that `bench()` renders frames back to back, about 8 ms apart, so each of its frames carries about half the position writes of a 60 Hz frame.

- [ ] **Step 5: Commit**

```bash
git add harness/fleet-layer.html harness/fleet-layer.ts
git commit -m "test(scene): fleet layer harness — 1k–10k synthetic aircraft, FPS meter and bench"
```

---

### Task 6: WP gate

- [ ] **Step 1: This package's tests**

Run: `node --test client/scene/altitudeColor.test.ts client/scene/icons.test.ts client/scene/fleetLayer.test.ts client/ui/legend.test.ts`
Expected: `ℹ tests 35`, `ℹ pass 35`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/(fleetLayer|icons|altitudeColor)|client/ui/legend|harness/fleet-layer'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Full check**

Run: `npm run check`
Expected: `tsc` prints nothing and `ℹ fail 0`. On the WP-B0 tree the count is 460 + 35 = 495. Each other B-* package adds its own tests.

- [ ] **Step 4: Confirm there is nothing left to commit**

Run: `git status --short`
Expected: no output.

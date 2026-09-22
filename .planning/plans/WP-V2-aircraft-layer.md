# WP-V2 — Aircraft Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw every aircraft the client tracks as one screen-space dot plus a callsign label on the Cesium globe. Colour shows position quality, stale tracks are dimmed, and the selected aircraft is larger and outlined. A click returns the hex under the cursor. 200+ aircraft update every frame without creating or destroying primitives.

**Architecture:** One module, `client/scene/aircraftLayer.ts`, with one pure function and one class.
- `colorFor(quality, selected, mode)` returns a CSS `rgba(r, g, b, a)` string. Hue by quality: `adsb2` sky blue, `adsb01` green, `mlat` amber, `other` grey. Alpha is 1, except `stale`: 0.35, or 0.6 when selected (so a frozen chased aircraft stays findable).
- `AircraftLayer` adds one `PointPrimitiveCollection` and one `LabelCollection` to `scene.primitives` in its constructor. It keeps `Map<hex, { point, label, seen }>`. Each `update()` bumps a frame counter, creates a point and a label only for a hex it has not seen, moves existing ones in place (Cesium's setters copy the value and skip unchanged ones) and removes every entry not stamped this frame. Scratch `Cartesian3`/`Cartographic` objects and one cached `Color` per CSS string mean a steady-state frame allocates no Cesium objects.
- Both primitives carry `id = hex`, so `pick(windowPos)` is `scene.pick(windowPos)?.id` when that id is a string this layer draws; anything else (nothing, another layer's object, an unknown hex) is `null`. Clicking the label works too.
- Label text is `callsign ?? hex`. Selected: 14 px with a 2 px white outline; others 8 px, no outline.
- Heights: airborne aircraft sit at `hM` (WGS84 ellipsoidal, as `RenderState` defines it). Aircraft `onGround` sit on the loaded terrain: `scene.globe.getHeight(Cartographic(lon, lat))`, falling back to `hM` until that tile loads. `PointPrimitive` has **no `heightReference`** in Cesium 1.145 (its properties are `show, position, scaleByDistance, translucencyByDistance, pixelSize, color, outlineColor, outlineWidth, distanceDisplayCondition, disableDepthTestDistance, id, pickId, clusterShow, splitDirection` in `@cesium/engine/Source/Scene/PointPrimitive.js`), and a `CLAMP_TO_GROUND` label re-registers a terrain callback on every position change (`Billboard._updateClamping` → `scene.updateHeight`). So point and label both use the sampled height.

Conventions consumers (A2) rely on: call `update()` once per frame with **all** current states (a hex left out is removed); `selectedHex` may name a hex that is not in `states`; `pick` answers only for this layer's primitives; `destroy()` removes and destroys both collections.

**Tech Stack:** CesiumJS 1.145 (`PointPrimitiveCollection`, `LabelCollection`, `Scene.pick`, `Globe.getHeight`), `node:test`. The Node tests use real Cesium collections with a fake viewer (`scene.primitives.add/remove`, `scene.pick`, `scene.globe.getHeight`). Cesium's `Label` constructor measures its CSS font through the DOM (`parseFont` in `Label.js`), so the test installs a three-call `document` stub. Glyphs are only drawn by `LabelCollection.update`, which only a real WebGL scene calls.

**Wave:** 1 (parallel; depends only on WP-00). Consumed by A2. **Estimated:** 1 h. **Validated:** on 2026-09-22 in the shared Wave 1 sandbox (WP-00 files + installed `node_modules`, Node 25.2.1, TypeScript 7.0.2): `node --test client/scene/aircraftLayer.test.ts` → 11/11 pass; `npx tsc --noEmit` reports no errors in `client/scene/aircraftLayer*` or `harness/aircraft-layer*`. Every task was replayed in an isolated copy holding only WP-00's type files and this package's files: Task 1 failed then passed 2/2, Task 2 failed then passed 11/11, and a full `tsc --noEmit` was clean (no dependency on any other Wave 1 package). The harness ran in Chrome through Vite: 200 dots and labels around KSFO, `update()` took 0.33–0.41 ms per frame for 200 aircraft, the count toggled 200 ↔ 196 as the blinking hexes were removed and re-added, a real mouse click on an isolated dot selected it (`pixelSize` 14, `outlineWidth` 2), and the console had no errors.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- This package creates or edits only the four files below. It reads WP-00's `shared/types.ts` and `client/types.ts`.
- Heights are WGS84 ellipsoidal metres (HAE). `RenderState.hM` is already HAE; this layer never applies the geoid.
- Unit tests need no WebGL and no network.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `client/scene/aircraftLayer.ts` | `colorFor`, `class AircraftLayer` |
| `client/scene/aircraftLayer.test.ts` | colours, reuse/removal, selection, heights, picking, destroy |
| `harness/aircraft-layer.html`, `harness/aircraft-layer.ts` | manual check: 200 synthetic aircraft around KSFO, click to select |

---

### Task 1: Quality colours

**Files:**
- Create: `client/scene/aircraftLayer.ts`, `client/scene/aircraftLayer.test.ts`
- Test: `client/scene/aircraftLayer.test.ts`

**Interfaces:**
- Consumes: `Quality` (`shared/types.ts`, WP-00), `RenderState['mode']` (`client/types.ts`, WP-00)
- Produces: `colorFor(quality: Quality, selected: boolean, mode: RenderState['mode']): string` (CSS `rgba(r, g, b, a)`)

- [ ] **Step 1: Write the failing test**

```ts
// client/scene/aircraftLayer.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Color } from 'cesium'
import { colorFor } from './aircraftLayer.ts'

test('colorFor: one hue per quality, full opacity while live', () => {
  assert.equal(colorFor('adsb2', false, 'interp'), 'rgba(56, 189, 248, 1)')
  const all = (['adsb2', 'adsb01', 'mlat', 'other'] as const).map((q) => colorFor(q, false, 'interp'))
  assert.equal(new Set(all).size, 4)
  assert.equal(colorFor('mlat', false, 'extrap'), colorFor('mlat', false, 'interp'))
})

test('colorFor: stale is dimmed, less so when selected, and Cesium parses it', () => {
  const alpha = (css: string): number => Color.fromCssColorString(css).alpha
  assert.equal(alpha(colorFor('adsb2', false, 'interp')), 1)
  assert.ok(alpha(colorFor('adsb2', false, 'stale')) < 0.5)
  assert.ok(alpha(colorFor('adsb2', true, 'stale')) > alpha(colorFor('adsb2', false, 'stale')))
  assert.ok(alpha(colorFor('adsb2', true, 'stale')) < 1)
  assert.equal(alpha(colorFor('other', true, 'interp')), 1)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/scene/aircraftLayer.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/scene/aircraftLayer.ts' imported from …/client/scene/aircraftLayer.test.ts`

- [ ] **Step 3: Write the implementation**

```ts
// client/scene/aircraftLayer.ts
import type { Quality } from '../../shared/types.ts'
import type { RenderState } from '../types.ts'

const RGB: Record<Quality, string> = {
  adsb2: '56, 189, 248', //   sky blue: ADS-B v2, best position and geometric (HAE) altitude
  adsb01: '132, 204, 22', //  green: ADS-B v0/v1
  mlat: '245, 158, 11', //    amber: MLAT, noisier and further behind
  other: '161, 161, 170', //  grey: TIS-B, ADS-R, unknown
}

/** CSS fill colour of one aircraft: hue by position quality; a stale (frozen) track is dimmed, less so when selected. */
export function colorFor(quality: Quality, selected: boolean, mode: RenderState['mode']): string {
  const alpha = mode !== 'stale' ? 1 : selected ? 0.6 : 0.35
  return `rgba(${RGB[quality]}, ${alpha})`
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/scene/aircraftLayer.test.ts`
Expected: PASS — `ℹ tests 2`, `ℹ pass 2`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add client/scene/aircraftLayer.ts client/scene/aircraftLayer.test.ts
git commit -m "feat(scene): quality colours for the aircraft layer"
```

---

### Task 2: AircraftLayer

**Files:**
- Modify: `client/scene/aircraftLayer.ts`, `client/scene/aircraftLayer.test.ts`
- Test: `client/scene/aircraftLayer.test.ts`

**Interfaces:**
- Consumes: `RenderState` (`client/types.ts`, WP-00), `Quality` (`shared/types.ts`, WP-00), `colorFor` (Task 1); Cesium `Viewer`, `Cartesian2`
- Produces: `class AircraftLayer { constructor(viewer: Viewer); update(states: RenderState[], selectedHex: string | null): void; pick(windowPos: Cartesian2): string | null; destroy(): void }` (PLAN.md §4 V2, exactly)

- [ ] **Step 1: Write the failing test** (replace the whole file)

```ts
// client/scene/aircraftLayer.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cartesian2, Cartographic, Color, LabelCollection, PointPrimitiveCollection } from 'cesium'
import type { Label, PointPrimitive, Viewer } from 'cesium'
import type { RenderState } from '../types.ts'
import { AircraftLayer, colorFor } from './aircraftLayer.ts'

// Cesium's Label measures its CSS font through the DOM once per font (Label.js parseFont) and Node has no DOM.
// These are the only DOM calls LabelCollection.add makes; glyphs are drawn later in update(), which only a real scene calls.
Object.assign(globalThis, {
  document: {
    createElement: () => ({ style: {} }),
    body: { appendChild: () => {}, removeChild: () => {} },
    defaultView: { getComputedStyle: () => ({ getPropertyValue: (p: string) => (p === 'font-size' ? '13px' : '') }) },
  },
})

function fakeViewer(groundH?: number) {
  const f = {
    added: [] as unknown[],
    pickResult: undefined as unknown,
    pickedAt: null as Cartesian2 | null,
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
    globe: { getHeight: (_c: Cartographic): number | undefined => groundH },
    pick: (pos: Cartesian2): unknown => ((f.pickedAt = pos), f.pickResult),
  }
  f.viewer = { scene } as unknown as Viewer
  return f
}

const points = (f: { added: unknown[] }): PointPrimitiveCollection => f.added.find((p) => p instanceof PointPrimitiveCollection) as PointPrimitiveCollection
const labels = (f: { added: unknown[] }): LabelCollection => f.added.find((p) => p instanceof LabelCollection) as LabelCollection
const allPoints = (c: PointPrimitiveCollection): PointPrimitive[] => Array.from({ length: c.length }, (_, i) => c.get(i))
const allLabels = (c: LabelCollection): Label[] => Array.from({ length: c.length }, (_, i) => c.get(i))
const pointOf = (f: { added: unknown[] }, hex: string): PointPrimitive => allPoints(points(f)).find((p) => p.id === hex) as PointPrimitive
const labelOf = (f: { added: unknown[] }, hex: string): Label => allLabels(labels(f)).find((l) => l.id === hex) as Label
const heightOf = (p: PointPrimitive): number => Cartographic.fromCartesian(p.position).height

const st = (hex: string, o: Partial<RenderState> = {}): RenderState => ({
  hex, lat: 37.62, lon: -122.38, hM: 1000, headingDeg: 90, pitchDeg: 0, rollDeg: 0,
  gsKt: 250, trackDeg: 90, altBaroFt: 3200, vsFpm: 0, mode: 'interp', altSource: 'geom',
  onGround: false, ageS: 1, quality: 'adsb2', callsign: null, typeCode: 'B738', ...o,
})

test('colorFor: one hue per quality, full opacity while live', () => {
  assert.equal(colorFor('adsb2', false, 'interp'), 'rgba(56, 189, 248, 1)')
  const all = (['adsb2', 'adsb01', 'mlat', 'other'] as const).map((q) => colorFor(q, false, 'interp'))
  assert.equal(new Set(all).size, 4)
  assert.equal(colorFor('mlat', false, 'extrap'), colorFor('mlat', false, 'interp'))
})

test('colorFor: stale is dimmed, less so when selected, and Cesium parses it', () => {
  const alpha = (css: string): number => Color.fromCssColorString(css).alpha
  assert.equal(alpha(colorFor('adsb2', false, 'interp')), 1)
  assert.ok(alpha(colorFor('adsb2', false, 'stale')) < 0.5)
  assert.ok(alpha(colorFor('adsb2', true, 'stale')) > alpha(colorFor('adsb2', false, 'stale')))
  assert.ok(alpha(colorFor('adsb2', true, 'stale')) < 1)
  assert.equal(alpha(colorFor('other', true, 'interp')), 1)
})

test('one point and one label per aircraft, both collections added to the scene, keyed by hex', () => {
  const f = fakeViewer()
  const layer = new AircraftLayer(f.viewer)
  assert.equal(f.added.length, 2)
  layer.update([st('a1b2c3', { callsign: 'UAL123' }), st('4x4x4x')], null)
  assert.equal(points(f).length, 2)
  assert.equal(labels(f).length, 2)
  assert.equal(labelOf(f, 'a1b2c3').text, 'UAL123')
  assert.equal(labelOf(f, '4x4x4x').text, '4x4x4x', 'no callsign → hex')
  assert.ok(pointOf(f, 'a1b2c3'))
})

test('primitives are reused across updates and moved in place', () => {
  const f = fakeViewer()
  const layer = new AircraftLayer(f.viewer)
  layer.update([st('a1b2c3', { lat: 37.6 })], null)
  const p = pointOf(f, 'a1b2c3')
  const l = labelOf(f, 'a1b2c3')
  const before = p.position.clone()
  layer.update([st('a1b2c3', { lat: 37.7 })], null)
  assert.equal(points(f).length, 1)
  assert.equal(pointOf(f, 'a1b2c3'), p, 'same PointPrimitive object')
  assert.equal(labelOf(f, 'a1b2c3'), l, 'same Label object')
  assert.ok(!p.position.equals(before), 'moved')
  assert.ok(l.position.equals(p.position), 'label sits on the point')
})

test('hexes missing from an update are removed from both collections', () => {
  const f = fakeViewer()
  const layer = new AircraftLayer(f.viewer)
  layer.update([st('aaaaaa'), st('bbbbbb'), st('cccccc')], null)
  layer.update([st('bbbbbb')], null)
  assert.equal(points(f).length, 1)
  assert.equal(labels(f).length, 1)
  assert.equal(allPoints(points(f))[0].id, 'bbbbbb')
  layer.update([], null)
  assert.equal(points(f).length, 0)
  assert.equal(labels(f).length, 0)
})

test('selected aircraft is larger and outlined; deselecting restores it', () => {
  const f = fakeViewer()
  const layer = new AircraftLayer(f.viewer)
  layer.update([st('aaaaaa'), st('bbbbbb')], 'bbbbbb')
  const a = pointOf(f, 'aaaaaa')
  const b = pointOf(f, 'bbbbbb')
  assert.ok(b.pixelSize > a.pixelSize)
  assert.ok(b.outlineWidth > 0)
  assert.equal(a.outlineWidth, 0)
  layer.update([st('aaaaaa'), st('bbbbbb')], null)
  assert.equal(b.pixelSize, a.pixelSize)
  assert.equal(b.outlineWidth, 0)
})

test('colour follows quality and stale tracks are dimmed', () => {
  const f = fakeViewer()
  const layer = new AircraftLayer(f.viewer)
  layer.update([st('aaaaaa', { quality: 'mlat' }), st('bbbbbb', { mode: 'stale' })], null)
  assert.ok(pointOf(f, 'aaaaaa').color.equals(Color.fromCssColorString(colorFor('mlat', false, 'interp'))))
  assert.ok(pointOf(f, 'bbbbbb').color.alpha < 0.5)
  assert.ok(labelOf(f, 'bbbbbb').fillColor.alpha < 0.5)
})

test('airborne aircraft sit at hM (ellipsoidal)', () => {
  const f = fakeViewer(7)
  const layer = new AircraftLayer(f.viewer)
  layer.update([st('aaaaaa', { hM: 1234.5 })], null)
  assert.ok(Math.abs(heightOf(pointOf(f, 'aaaaaa')) - 1234.5) < 1e-3)
})

test('aircraft on the ground are clamped to the loaded terrain, or stay at hM until it loads', () => {
  const f = fakeViewer(7)
  const layer = new AircraftLayer(f.viewer)
  layer.update([st('aaaaaa', { hM: -25, onGround: true })], null)
  assert.ok(Math.abs(heightOf(pointOf(f, 'aaaaaa')) - 7) < 1e-3)
  const g = fakeViewer(undefined)
  const layer2 = new AircraftLayer(g.viewer)
  layer2.update([st('aaaaaa', { hM: -25, onGround: true })], null)
  assert.ok(Math.abs(heightOf(pointOf(g, 'aaaaaa')) + 25) < 1e-3)
})

test('pick returns the hex stored on the picked primitive, null otherwise', () => {
  const f = fakeViewer()
  const layer = new AircraftLayer(f.viewer)
  layer.update([st('a1b2c3')], null)
  const at = new Cartesian2(100, 200)
  f.pickResult = { primitive: pointOf(f, 'a1b2c3'), id: 'a1b2c3' }
  assert.equal(layer.pick(at), 'a1b2c3')
  assert.equal(f.pickedAt, at)
  f.pickResult = { primitive: labelOf(f, 'a1b2c3'), id: 'a1b2c3' }
  assert.equal(layer.pick(at), 'a1b2c3', 'clicking the label works too')
  f.pickResult = undefined
  assert.equal(layer.pick(at), null, 'nothing under the cursor')
  f.pickResult = { id: 'ffffff' }
  assert.equal(layer.pick(at), null, 'a hex this layer does not draw')
  f.pickResult = { id: { name: 'an entity' } }
  assert.equal(layer.pick(at), null, 'another layer’s object')
})

test('destroy removes and destroys both collections', () => {
  const f = fakeViewer()
  const layer = new AircraftLayer(f.viewer)
  layer.update([st('a1b2c3')], null)
  const [p, l] = [points(f), labels(f)]
  layer.destroy()
  assert.equal(f.added.length, 0)
  assert.ok(p.isDestroyed())
  assert.ok(l.isDestroyed())
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/scene/aircraftLayer.test.ts`
Expected: FAIL — `SyntaxError: The requested module './aircraftLayer.ts' does not provide an export named 'AircraftLayer'`

- [ ] **Step 3: Write the implementation** (replace the whole file)

```ts
// client/scene/aircraftLayer.ts
import { Cartesian2, Cartesian3, Cartographic, Color, Ellipsoid, LabelCollection, LabelStyle, PointPrimitiveCollection, VerticalOrigin } from 'cesium'
import type { Label, PointPrimitive, Scene, Viewer } from 'cesium'
import type { Quality } from '../../shared/types.ts'
import type { RenderState } from '../types.ts'

const RGB: Record<Quality, string> = {
  adsb2: '56, 189, 248', //   sky blue: ADS-B v2, best position and geometric (HAE) altitude
  adsb01: '132, 204, 22', //  green: ADS-B v0/v1
  mlat: '245, 158, 11', //    amber: MLAT, noisier and further behind
  other: '161, 161, 170', //  grey: TIS-B, ADS-R, unknown
}

/** CSS fill colour of one aircraft: hue by position quality; a stale (frozen) track is dimmed, less so when selected. */
export function colorFor(quality: Quality, selected: boolean, mode: RenderState['mode']): string {
  const alpha = mode !== 'stale' ? 1 : selected ? 0.6 : 0.35
  return `rgba(${RGB[quality]}, ${alpha})`
}

const PIXEL_SIZE = 8
const PIXEL_SIZE_SELECTED = 14
const OUTLINE_SELECTED_PX = 2
const LABEL_FONT = '13px sans-serif'
const LABEL_OFFSET = new Cartesian2(0, -9)

interface Entry {
  point: PointPrimitive
  label: Label
  seen: number
}

/**
 * Every visible aircraft as one screen-space dot plus a callsign label, keyed by hex.
 * Primitives are created once per hex and moved in place each frame; hexes missing from an update are removed.
 */
export class AircraftLayer {
  #scene: Scene
  #points: PointPrimitiveCollection
  #labels: LabelCollection
  #byHex = new Map<string, Entry>()
  #colors = new Map<string, Color>()
  #frame = 0
  #pos = new Cartesian3()
  #carto = new Cartographic()

  constructor(viewer: Viewer) {
    this.#scene = viewer.scene
    this.#points = this.#scene.primitives.add(new PointPrimitiveCollection())
    this.#labels = this.#scene.primitives.add(new LabelCollection())
  }

  update(states: RenderState[], selectedHex: string | null): void {
    const frame = ++this.#frame
    for (const s of states) {
      const pos = this.#position(s)
      let e = this.#byHex.get(s.hex)
      if (!e) {
        e = {
          point: this.#points.add({ id: s.hex, position: pos, pixelSize: PIXEL_SIZE, outlineColor: Color.WHITE }),
          label: this.#labels.add({
            id: s.hex,
            position: pos,
            font: LABEL_FONT,
            style: LabelStyle.FILL_AND_OUTLINE,
            outlineColor: Color.BLACK,
            outlineWidth: 2,
            verticalOrigin: VerticalOrigin.BOTTOM,
            pixelOffset: LABEL_OFFSET,
          }),
          seen: frame,
        }
        this.#byHex.set(s.hex, e)
      }
      e.seen = frame
      const selected = s.hex === selectedHex
      const color = this.#color(colorFor(s.quality, selected, s.mode))
      e.point.position = pos // setters copy the value and skip unchanged ones
      e.point.color = color
      e.point.pixelSize = selected ? PIXEL_SIZE_SELECTED : PIXEL_SIZE
      e.point.outlineWidth = selected ? OUTLINE_SELECTED_PX : 0
      e.label.position = pos
      e.label.fillColor = color
      e.label.text = s.callsign ?? s.hex
    }
    for (const [hex, e] of this.#byHex) {
      if (e.seen === frame) continue
      this.#points.remove(e.point)
      this.#labels.remove(e.label)
      this.#byHex.delete(hex)
    }
  }

  pick(windowPos: Cartesian2): string | null {
    const id: unknown = this.#scene.pick(windowPos)?.id
    return typeof id === 'string' && this.#byHex.has(id) ? id : null
  }

  destroy(): void {
    this.#scene.primitives.remove(this.#points)
    this.#scene.primitives.remove(this.#labels)
    this.#byHex.clear()
  }

  /** Airborne: at hM. On the ground: on the loaded terrain under the aircraft, hM until that tile loads. */
  #position(s: RenderState): Cartesian3 {
    let h = s.hM
    if (s.onGround) {
      // ponytail: PointPrimitive has no heightReference (Cesium 1.145), so ground dots sample the globe every update.
      // Ceiling: one quadtree lookup per ground aircraft per frame; upgrade: cache per hex until it moves > 10 m.
      const c = Cartographic.fromDegrees(s.lon, s.lat, 0, this.#carto)
      h = this.#scene.globe.getHeight(c) ?? s.hM
    }
    return Cartesian3.fromDegrees(s.lon, s.lat, h, Ellipsoid.WGS84, this.#pos)
  }

  /** One shared Color per CSS string: a dozen at most, so frames allocate none. */
  #color(css: string): Color {
    let c = this.#colors.get(css)
    if (!c) this.#colors.set(css, (c = Color.fromCssColorString(css)))
    return c
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/scene/aircraftLayer.test.ts`
Expected: PASS — `ℹ tests 11`, `ℹ pass 11`, `ℹ fail 0`.

- [ ] **Step 5: Type-check this file**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/aircraftLayer'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 6: Commit**

```bash
git add client/scene/aircraftLayer.ts client/scene/aircraftLayer.test.ts
git commit -m "feat(scene): aircraft layer with reused points and labels, selection and picking"
```

---

### Task 3: Harness page

**Files:**
- Create: `harness/aircraft-layer.html`, `harness/aircraft-layer.ts`

**Interfaces:**
- Consumes: `AircraftLayer` (Task 2), `RenderState` (`client/types.ts`), `Quality` (`shared/types.ts`); the Vite setup from WP-00 Task 10 (serves any `harness/*.html`, Cesium static files at `/cesiumStatic`)
- Produces: the page `/harness/aircraft-layer.html` and, for console checks, `window.harness = { viewer, layer, statesAt, selected() }`

- [ ] **Step 1: Write the page**

```html
<!-- harness/aircraft-layer.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Harness: aircraft layer</title>
    <style>
      html, body, #globe { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
      #info { position: absolute; top: 8px; left: 8px; padding: 6px 10px; font: 13px/1.5 system-ui, sans-serif; color: #fff; background: rgba(0, 0, 0, 0.65); border-radius: 4px; pointer-events: none; }
    </style>
  </head>
  <body>
    <div id="globe"></div>
    <div id="info"></div>
    <script type="module" src="/harness/aircraft-layer.ts"></script>
  </body>
</html>
```

```ts
// harness/aircraft-layer.ts
// Manual check for WP-V2: 200 synthetic aircraft circle KSFO and move every frame. Click a dot to select it, empty space to clear.
// Every 50th aircraft blinks out for 5 s at a time (exercises removal and re-creation). Open /harness/aircraft-layer.html.
import { Cartesian3, EllipsoidTerrainProvider, ScreenSpaceEventHandler, ScreenSpaceEventType, Viewer } from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import type { Quality } from '../shared/types.ts'
import type { RenderState } from '../client/types.ts'
import { AircraftLayer } from '../client/scene/aircraftLayer.ts'

const KSFO = { lat: 37.6188, lon: -122.3754 }
const N = 200
const M_PER_DEG = 111_320
const QUALITIES: Quality[] = ['adsb2', 'adsb2', 'adsb2', 'adsb01', 'mlat', 'other']

const viewer = new Viewer('globe', {
  terrainProvider: new EllipsoidTerrainProvider(),
  baseLayer: false,
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
viewer.camera.setView({
  destination: Cartesian3.fromDegrees(KSFO.lon, KSFO.lat - 0.75, 55_000),
  orientation: { heading: 0, pitch: -Math.PI / 4, roll: 0 },
})

const layer = new AircraftLayer(viewer)
let selected: string | null = null
let updateMsAvg = 0

/** Aircraft i circles KSFO; the first 10 taxi on the ground, a few are stale, extrapolated or have no callsign. */
function statesAt(tS: number): RenderState[] {
  const out: RenderState[] = []
  for (let i = 0; i < N; i++) {
    if (i % 50 === 0 && Math.floor(tS / 5) % 2 === 1) continue
    const onGround = i < 10
    const r = onGround ? 400 + 60 * i : 3000 + (i % 20) * 2500
    const v = onGround ? 8 : 70 + (i % 9) * 20
    const dir = i % 2 === 0 ? 1 : -1 // counter-clockwise / clockwise seen from above
    const th = (i * 2.399) + dir * (v / r) * tS
    const e = r * Math.cos(th)
    const n = r * Math.sin(th)
    const headingDeg = ((Math.atan2(-dir * Math.sin(th), dir * Math.cos(th)) * 180) / Math.PI + 360) % 360
    out.push({
      hex: (0xa00000 + i).toString(16),
      lat: KSFO.lat + n / M_PER_DEG,
      lon: KSFO.lon + e / (M_PER_DEG * Math.cos((KSFO.lat * Math.PI) / 180)),
      hM: onGround ? -30 : 300 + i * 50,
      headingDeg,
      pitchDeg: 0,
      rollDeg: 0,
      gsKt: v / 0.514444,
      trackDeg: headingDeg,
      altBaroFt: onGround ? null : (330 + i * 50) / 0.3048,
      vsFpm: 0,
      mode: i % 17 === 5 ? 'stale' : i % 13 === 3 ? 'extrap' : 'interp',
      altSource: 'geom',
      onGround,
      ageS: 1,
      quality: QUALITIES[i % QUALITIES.length],
      callsign: i % 7 === 0 ? null : `HOP${i}`,
      typeCode: 'A320',
    })
  }
  return out
}

const info = document.getElementById('info') as HTMLElement
viewer.scene.preUpdate.addEventListener(() => {
  const states = statesAt(performance.now() / 1000)
  const t0 = performance.now()
  layer.update(states, selected)
  updateMsAvg += (performance.now() - t0 - updateMsAvg) * 0.05
  info.textContent = `${states.length} aircraft · update ${updateMsAvg.toFixed(2)} ms · selected: ${selected ?? '—'} (click a dot)`
})

new ScreenSpaceEventHandler(viewer.scene.canvas).setInputAction((ev: ScreenSpaceEventHandler.PositionedEvent) => {
  selected = layer.pick(ev.position)
}, ScreenSpaceEventType.LEFT_CLICK)

;(window as unknown as { harness: object }).harness = { viewer, layer, statesAt, selected: () => selected }
```

- [ ] **Step 2: Type-check the page**

Run: `npx tsc --noEmit 2>&1 | grep -E 'harness/aircraft-layer'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Look at it**

Run: `npm run dev -- --port 5173`, open `http://localhost:5173/harness/aircraft-layer.html`.
Expected: on a blue globe (no imagery, ellipsoid terrain, no network needed), about 200 coloured dots with labels (`HOP…`, or a hex for every 7th) circle KSFO, sky blue, green, amber and grey, some dimmed (stale). The overlay reads `200 aircraft · update … ms` (under 2 ms) and drops to `196` for 5 s every 10 s. Click an isolated dot: the overlay shows `selected: a0…` and that dot grows with a white outline; click empty space and the selection clears. The console has no errors. Stop the server.

- [ ] **Step 4: Commit**

```bash
git add harness/aircraft-layer.html harness/aircraft-layer.ts
git commit -m "test(scene): aircraft layer harness page (200 synthetic aircraft at KSFO)"
```

---

### Task 4: WP gate

- [ ] **Step 1: This package's tests**

Run: `node --test client/scene/aircraftLayer.test.ts`
Expected: `ℹ tests 11`, `ℹ pass 11`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/aircraftLayer|harness/aircraft-layer'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Full check in the worktree**

Run: `npm run check`
Expected: `tsc` prints nothing. On a worktree branched from `wave-0` the counts are `ℹ tests 52`, `ℹ pass 52`, `ℹ fail 0` (41 from WP-00 + 11 here).

- [ ] **Step 4: Confirm there is nothing left to commit**

Run: `git status --short`
Expected: no output.

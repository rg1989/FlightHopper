# Chase Traffic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In chase mode, draw the other aircraft within 10 nm as 3-D models (track and climb angle), each framed by two
corner brackets whose square is its click target. Hide the aircraft out of range.

**Architecture:** `Fleet` is drawn at the chase's render time. `client/scene/traffic.ts` selects the nearest 30 in range
and assigns them pooled Cesium `Model`s (one GLB). It places them where `FleetLayer` placed the aircraft (FleetLayer hides
their icons), and it moves one DOM bracket per model over the canvas. The canvas click handler tests the squares
first.

**Tech Stack:** TypeScript (Node's type stripping), CesiumJS 1.145, `node --test`, Vite.

Spec: `.planning/chase-traffic-design.md`.

## Global Constraints

- Range 10 nm, at most 30 models, minimum on-screen size 24 px.
- Scale per category: A1 0.35, A2 0.6, A3 1, A4 1.2, A5 1.8, A7 0.4. Other or unknown categories use 1.
- Roll 0. Pitch from `targetAttitude` (flight-path angle + AoA). Level when slower than 40 kt.
- A click in a square does nothing yet (the handler catches it and returns).
- Browse (top-down) behaviour does not change.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage only explicit paths.
- Run: `npm test` (all), or `node --test client/…/x.test.ts` (one file). `npm run typecheck`.

---

### Task 1: Fleet dead-reckons back to a render time before the newest sample

**Files:**
- Modify: `client/browse/fleet.ts` (`reckon`)
- Test: `client/browse/fleet.test.ts`

**Interfaces:** Produces: `Fleet.entries(tMs)` for a tMs before the newest sample moves a moving aircraft back along
its track, clamped to `staleS`. `ageS` stays 0.

- [ ] **Step 1:** Replace the test 'dead-reckoning stops 60 s after the newest sample; before the sample the sample position is used' with:

```ts
test('dead-reckoning stops 60 s after the newest sample', () => {
  const f = new Fleet()
  f.ingest([smp()])
  const at60 = { ...f.entries(T0 + 60_000)[0] }
  const at90 = f.entries(T0 + 90_000)[0]
  assert.equal(at90.lat, at60.lat)
  assert.equal(at90.lon, at60.lon)
  near(distanceNm(32, 34.8, at90.lat, at90.lon), 6, 1e-9)
  assert.equal(at90.ageS, 90) // the age keeps counting
})

test('before the newest sample (the chase draws the fleet at its delayed time): back along the track, age 0', () => {
  const f = new Fleet()
  f.ingest([smp()])
  const early = f.entries(T0 - 5_000)[0] // 360 kt × 5 s = 0.5 nm back
  const want = destination(32, 34.8, 270, 0.5)
  near(early.lat, want.lat, 1e-9)
  near(early.lon, want.lon, 1e-9)
  assert.equal(early.ageS, 0)
  const far = f.entries(T0 - 90_000)[0] // clamped to staleS (60 s) = 6 nm
  near(distanceNm(32, 34.8, far.lat, far.lon), 6, 1e-9)
  f.ingest([smp({ hex: 'parked', onGround: true, gsKt: 0 })])
  const p = f.get('parked')!
  f.entries(T0 - 5_000)
  assert.equal(p.lat, 32, 'not moving: stays')
})
```

- [ ] **Step 2:** `node --test client/browse/fleet.test.ts`. Expected: FAIL, because `early.lat` is 32.
- [ ] **Step 3:** In `reckon`, update the comment to say "clamped to ±staleS; a tMs before the sample moves it back along the track, its age stays 0". Replace `if (!slot.moving || ageS <= 0)` with `if (!slot.moving || ageS === 0)` and the distance with:

```ts
  const t = ageS < e.staleS ? (ageS > -e.staleS ? ageS : -e.staleS) : e.staleS
  const d = t * slot.radPerS
```

- [ ] **Step 4:** `node --test client/browse/fleet.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(fleet): dead-reckon back along the track to a time before the newest sample`.

### Task 2: FleetLayer takes a TrafficView and exposes positionOf

**Files:**
- Modify: `client/scene/fleetLayer.ts`
- Test: `client/scene/fleetLayer.test.ts`

**Interfaces:** Produces:
```ts
export interface TrafficView { near: ReadonlySet<string>; models: ReadonlySet<string> }
update(entries, selectedHex, hoverHex, modelShown = false, traffic: TrafficView | null = null): void
positionOf(hex: string): Cartesian3 | undefined // this frame's placed position (icon shown or not), read-only
```
The rules for traffic ≠ null: a hex that is not in `near` and is not selected hides. A hex in `models` is placed, and
its icon hides.

- [ ] **Step 1:** Add the test:

```ts
test('chase traffic: only aircraft in range show; model hexes are placed with their icon hidden (positionOf)', () => {
  const f = fakeViewer()
  const layer = new FleetLayer(f.viewer)
  const view = { near: new Set(['aaaaaa', 'bbbbbb']), models: new Set(['aaaaaa']) }
  const es = [fe('aaaaaa', { lat: 50, lon: 10, hM: 9_000 }), fe('bbbbbb'), fe('cccccc'), fe('dddddd')]
  layer.update(es, 'dddddd', null, false, view)
  assert.equal(bb(f, 'aaaaaa').show, false, 'drawn as a model')
  assert.ok(Cartesian3.equalsEpsilon(layer.positionOf('aaaaaa')!, Cartesian3.fromDegrees(10, 50, 9_000), 0, 1e-6))
  assert.equal(bb(f, 'bbbbbb').show, true, 'in range, no model: its icon')
  assert.equal(bb(f, 'cccccc').show, false, 'out of range')
  assert.equal(layer.positionOf('cccccc'), undefined)
  assert.equal(bb(f, 'dddddd').show, true, 'the selected one is not ranged')
  layer.update(es, 'dddddd', null)
  for (const h of ['aaaaaa', 'bbbbbb', 'cccccc', 'dddddd']) assert.equal(bb(f, h).show, true, `browse: ${h} an icon again`)
})
```

- [ ] **Step 2:** `node --test client/scene/fleetLayer.test.ts`. Expected: FAIL, because `positionOf` is not a function.
- [ ] **Step 3:** Implement. Add `placed: boolean` to `Slot` (init `false` in `#add`). In `update`, replace the visibility lines with:

```ts
      // The Fleet's own age limit per aircraft (it prunes them later); the chased one gives way to its 3-D model. In
      // chase (traffic), only the aircraft in range, as icons or, placed for their 3-D model, with the icon hidden.
      s.placed = e.ageS <= e.staleS && !(modelShown && e.hex === selectedHex) &&
        (traffic === null || e.hex === selectedHex || traffic.near.has(e.hex))
      const visible = s.placed && !(traffic !== null && traffic.models.has(e.hex))
      if (visible !== s.show) {
        s.b.show = visible
        s.show = visible
      }
      if (!s.placed) continue
```
Add `positionOf`:
```ts
  /** Where this frame placed the hex (its icon's position, shown or not; do not modify), or undefined if it was not placed. */
  positionOf(hex: string): Cartesian3 | undefined {
    const s = this.#byHex.get(hex)
    return s !== undefined && s.frame === this.#frame && s.placed ? s.b.position : undefined
  }
```
- [ ] **Step 4:** `node --test client/scene/fleetLayer.test.ts`. Expected: PASS (all).
- [ ] **Step 5:** Commit `feat(fleet-layer): chase traffic view — hide out of range, place 3-D model hexes without their icon`.

### Task 3: traffic.ts pure parts

**Files:**
- Create: `client/scene/traffic.ts`
- Modify: `client/scene/model.ts` (export `modelUrl`)
- Test: `client/scene/traffic.test.ts`

**Interfaces:** Produces:
```ts
export const RANGE_NM = 10, MAX_MODELS = 30, MIN_PX = 24
export function scaleFor(category: string | null | undefined): number
export interface Near { e: FleetEntry; nm: number }
export function nearestInRange(entries: readonly FleetEntry[], skipHex: string | null, lat: number, lon: number, rangeNm: number): Near[]
export function squarePx(rM: number, depthM: number, fovyRad: number, viewHeightPx: number): number
export interface Box { hex: string; x: number; y: number; side: number; depthM: number }
export function hitAt(boxes: readonly Box[], n: number, x: number, y: number): string | null
export function trafficHpr(e: FleetEntry, m: ModelManifestEntry, headingDeg: number, out: HeadingPitchRoll): HeadingPitchRoll
export function trafficMatrix(pos: Cartesian3, hpr: HeadingPitchRoll, m: ModelManifestEntry, k: number, out: Matrix4): Matrix4
```

- [ ] **Step 1:** Write `client/scene/traffic.test.ts`:

```ts
// client/scene/traffic.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Cartesian3, Cartographic, HeadingPitchRoll, Matrix4 } from 'cesium'
import { destination } from '../../shared/geo.ts'
import type { FleetEntry, ModelManifest } from '../types.ts'
import { measureGlb, noseAzimuthDeg } from './model.ts'
import { MIN_PX, hitAt, nearestInRange, scaleFor, squarePx, trafficHpr, trafficMatrix } from './traffic.ts'
import type { Box } from './traffic.ts'

const root = new URL('../../', import.meta.url)
const manifest: ModelManifest = JSON.parse(readFileSync(new URL('public/models/manifest.json', root), 'utf8'))
const m = manifest.models.find((x) => x.id === manifest.default)!
const axes = measureGlb(readFileSync(new URL(`public/${m.uri}`, root)))
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} ${msg}`)
const azErr = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180)
const fe = (hex: string, o: Partial<FleetEntry> = {}): FleetEntry => ({
  hex, lat: 51.5, lon: -0.1, hM: 5_000, altFt: 16_000, onGround: false, trackDeg: 90, gsKt: 300, vsFpm: 0, ageS: 1, staleS: 60, gapS: 1,
  quality: 'adsb2', info: null, ...o,
})
const at = (hex: string, nm: number, brg = 45, o: Partial<FleetEntry> = {}): FleetEntry => {
  const p = destination(51.5, -0.1, brg, nm)
  return fe(hex, { lat: p.lat, lon: p.lon, ...o })
}

test('scale by ADS-B emitter category; unknown is 1', () => {
  assert.equal(scaleFor('A1'), 0.35)
  assert.equal(scaleFor('A5'), 1.8)
  assert.equal(scaleFor('A7'), 0.4)
  assert.equal(scaleFor('B2'), 1)
  assert.equal(scaleFor(null), 1)
})

test('nearestInRange: within the range, nearest first, the chased and stale ones skipped', () => {
  const es = [at('far', 12), at('mid', 6, 200), at('me', 0.1), at('close', 2, 300), at('stale', 1, 10, { ageS: 90 }), at('edge', 9.9, 100)]
  const r = nearestInRange(es, 'me', 51.5, -0.1, 10)
  assert.deepEqual(r.map((x) => x.e.hex), ['close', 'mid', 'edge'])
  near(r[0].nm, 2, 1e-9)
})

test('squarePx: the projected diameter, never under MIN_PX, capped when the camera is inside it', () => {
  // 60° fov over 1,000 px: at depth d a pixel is 2·d·tan 30° / 1000 m
  const mPerPx = (d: number): number => (2 * d * Math.tan(Math.PI / 6)) / 1000
  near(squarePx(20, 500, Math.PI / 3, 1000), 40 / mPerPx(500), 1e-9)
  assert.ok(squarePx(20, 250, Math.PI / 3, 1000) > squarePx(20, 500, Math.PI / 3, 1000), 'closer is bigger')
  assert.equal(squarePx(20, 50_000, Math.PI / 3, 1000), MIN_PX)
  assert.equal(squarePx(20, 0, Math.PI / 3, 1000), 4000)
})

test('hitAt: inside a square hits; overlapping squares → the nearest to the camera; outside → null', () => {
  const boxes: Box[] = [
    { hex: 'back', x: 100, y: 100, side: 80, depthM: 900 },
    { hex: 'front', x: 120, y: 110, side: 40, depthM: 300 },
    { hex: 'unused', x: 500, y: 500, side: 80, depthM: 1 },
  ]
  assert.equal(hitAt(boxes, 2, 125, 115), 'front')
  assert.equal(hitAt(boxes, 2, 70, 70), 'back')
  assert.equal(hitAt(boxes, 2, 139, 139), null)
  assert.equal(hitAt(boxes, 2, 500, 500), null, 'only the first n boxes count')
})

test('traffic model: nose along the track, pitched with the climb, wings level, wheels at the placed height', () => {
  const pos = Cartesian3.fromDegrees(-0.1, 51.5, 5_000)
  for (const trk of [0, 90, 237, 359]) {
    const hpr = trafficHpr(fe('x', { trackDeg: trk }), m, 0, new HeadingPitchRoll())
    const mm = trafficMatrix(pos, hpr, m, 1, new Matrix4())
    assert.ok(azErr(noseAzimuthDeg(mm, axes.nose), trk) < 1, `track ${trk}`)
  }
  const climb = trafficHpr(fe('x', { vsFpm: 2_000, gsKt: 250 }), m, 0, new HeadingPitchRoll())
  assert.ok(climb.pitch > 0.1, 'nose up in a climb')
  assert.equal(climb.roll, 0)
  const slow = trafficHpr(fe('x', { vsFpm: 1_500, gsKt: 20 }), m, 0, new HeadingPitchRoll())
  assert.ok(Math.abs(slow.pitch) < 0.05, 'a slow aircraft stays about level')
  const noTrack = trafficHpr(fe('x', { trackDeg: null }), m, 123, new HeadingPitchRoll())
  const mm = trafficMatrix(pos, noTrack, m, 1, new Matrix4())
  assert.ok(azErr(noseAzimuthDeg(mm, axes.nose), 123) < 1, 'no track: the heading given')
  const h = Cartographic.fromCartesian(Matrix4.getTranslation(trafficMatrix(pos, trafficHpr(fe('x'), m, 0, new HeadingPitchRoll()), m, 2, new Matrix4()), new Cartesian3())).height
  near(h - 5_000, m.gearHeightM * 2, 0.2, 'origin a gear height above the wheels, times the factor')
})
```

- [ ] **Step 2:** `node --test client/scene/traffic.test.ts`. Expected: FAIL, because the module was not found.
- [ ] **Step 3:** In `model.ts`, write `export function modelUrl`. Create `client/scene/traffic.ts` with the header comment, constants, and pure functions:

```ts
// client/scene/traffic.ts
// Chase traffic (.planning/chase-traffic-design.md): the other aircraft within RANGE_NM of the chased one as 3-D models
// (the one GLB, sized by ADS-B emitter category), each framed on screen by two corner brackets whose square is also
// its click target.
import { Cartesian3, HeadingPitchRoll, Math as CesiumMath, Matrix4, Transforms } from 'cesium'
import { distanceNm } from '../../shared/geo.ts'
import { targetAttitude } from '../track/attitude.ts'
import type { FleetEntry, ModelManifestEntry } from '../types.ts'

export const RANGE_NM = 10
export const MAX_MODELS = 30
export const MIN_PX = 24 // a far model keeps this size on screen (Model.minimumPixelSize), and so does its square
const KT = 1852 / 3600
const FPM = 0.3048 / 60
const SLOW_KT = 40 // slower than this a vertical rate says little about pitch (a helicopter, a go-around's first seconds): level
/** Length factor per ADS-B emitter category on the one model (37.6 m long: a large airliner). */
const SCALE: Record<string, number> = { A1: 0.35, A2: 0.6, A3: 1, A4: 1.2, A5: 1.8, A7: 0.4 }

export const scaleFor = (category: string | null | undefined): number => (category ? SCALE[category] : undefined) ?? 1

export interface Near { e: FleetEntry; nm: number }

/** The entries within rangeNm of (lat, lon), except skipHex and stale ones, nearest first. */
export function nearestInRange(entries: readonly FleetEntry[], skipHex: string | null, lat: number, lon: number, rangeNm: number): Near[] {
  const dLat = rangeNm / 60 // a nautical mile is a minute of latitude: a cheap reject before the great-circle distance
  const out: Near[] = []
  for (const e of entries) {
    if (e.hex === skipHex || e.ageS > e.staleS || Math.abs(e.lat - lat) > dLat) continue
    const nm = distanceNm(lat, lon, e.lat, e.lon)
    if (nm <= rangeNm) out.push({ e, nm })
  }
  return out.sort((a, b) => a.nm - b.nm)
}

/** Side of the on-screen square around a sphere of radius rM at depthM along the view, in CSS px: its projected diameter, ≥ MIN_PX, ≤ 4 screens. */
export function squarePx(rM: number, depthM: number, fovyRad: number, viewHeightPx: number): number {
  const px = (rM * viewHeightPx) / (depthM * Math.tan(fovyRad / 2))
  return Math.min(Math.max(px, MIN_PX), 4 * viewHeightPx)
}

/** A bracket square: centre (CSS px from the canvas's top-left), side, and depth along the view (m). */
export interface Box { hex: string; x: number; y: number; side: number; depthM: number }

/** The hex whose square (of the first n boxes) holds (x, y); the nearest to the camera when squares overlap; else null. */
export function hitAt(boxes: readonly Box[], n: number, x: number, y: number): string | null {
  let best: Box | null = null
  for (let i = 0; i < n; i++) {
    const b = boxes[i]
    const h = b.side / 2
    if (Math.abs(x - b.x) <= h && Math.abs(y - b.y) <= h && (best === null || b.depthM < best.depthM)) best = b
  }
  return best === null ? null : best.hex
}

/**
 * Cesium HeadingPitchRoll of a traffic aircraft on model m: the nose along its track (headingDeg when it has none),
 * pitch from its climb (targetAttitude: flight-path angle + AoA), wings level (the fleet keeps only the newest sample,
 * so no turn rate). ponytail: roll 0; upgrade: the track change between samples, as the chased Track does.
 */
export function trafficHpr(e: FleetEntry, m: ModelManifestEntry, headingDeg: number, out: HeadingPitchRoll): HeadingPitchRoll {
  const gs = e.gsKt ?? 0
  const att = targetAttitude({
    gsMs: gs * KT, vsMs: gs >= SLOW_KT ? (e.vsFpm ?? 0) * FPM : 0, headingDeg: e.trackDeg ?? headingDeg,
    broadcastRollDeg: 0, turnRateDegS: 0, onGround: e.onGround, phase: null, mlat: false,
  })
  const fix = m.forwardAxisFix
  out.heading = CesiumMath.toRadians(att.headingDeg + fix.headingDeg)
  out.pitch = CesiumMath.toRadians(att.pitchDeg + fix.pitchDeg)
  out.roll = CesiumMath.toRadians(fix.rollDeg)
  return out
}

const lift = new Cartesian3()

/** World matrix of a traffic model: wheels at pos (the origin k × gearHeightM above, along body up), attitude hpr, k × m.scale. */
export function trafficMatrix(pos: Cartesian3, hpr: HeadingPitchRoll, m: ModelManifestEntry, k: number, out: Matrix4): Matrix4 {
  Transforms.headingPitchRollToFixedFrame(pos, hpr, undefined, undefined, out)
  Matrix4.multiplyByTranslation(out, Cartesian3.fromElements(0, 0, m.gearHeightM * k, lift), out)
  return Matrix4.multiplyByUniformScale(out, m.scale * k, out)
}
```

The `squarePx` test: `40 / mPerPx(500)` = `40·1000 / (2·500·tan30°)` = `20·1000 / (500·tan30°)`. This matches the formula.
- [ ] **Step 4:** `node --test client/scene/traffic.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(traffic): range selection, category scale, attitude, bracket square and hit test`.

### Task 4: Traffic class (model pool and brackets) and CSS

**Files:**
- Modify: `client/scene/traffic.ts` (append the class)
- Modify: `client/ui/layout.css` (the bracket layer)

**Interfaces:**
- Consumes: `TrafficView` (Task 2), the pure functions (Task 3), `modelUrl` (model.ts).
- Produces:
```ts
export class Traffic {
  constructor(viewer: Viewer, m: ModelManifestEntry, layer: HTMLElement, load?: () => Promise<Model>)
  select(entries: readonly FleetEntry[], chasedHex: string | null, at: { lat: number; lon: number } | null): TrafficView | null
  update(placed: { positionOf(hex: string): Cartesian3 | undefined }, ibl?: Cartesian2): void
  hitAt(x: number, y: number): string | null
  destroy(): void
}
```

- [ ] **Step 1:** Append the class to `traffic.ts` (the imports grow: `Cartesian2`, `Model`, `SceneTransforms`, types
  `PerspectiveFrustum`, `Viewer`, `TrafficView`, and `modelUrl`):

```ts
/** One traffic model: no dynamic environment map (one per model would render the sky once per model), true height as ChaseModel. */
export function loadTrafficModel(m: ModelManifestEntry): Promise<Model> {
  return Model.fromGltfAsync({
    url: modelUrl(m), minimumPixelSize: MIN_PX, show: false, enableVerticalExaggeration: false, environmentMapOptions: { enabled: false },
  })
}

const HALF_SIZE = 0.65 // bracket square's half side per metre of model length: its wingspan is 1.2 × its length, plus a margin

interface Slot { model: Model; hex: string | null; e: FleetEntry | null; headingDeg: number }

/**
 * The chase traffic. Models come from a pool that grows to the most ever needed (≤ MAX_MODELS), and Cesium shares
 * one GLB's geometry and textures between them. A model loads async; an aircraft shows its icon until a ready
 * model is free. If the GLB fails, the traffic stays as icons.
 * ponytail: brackets do not hide behind terrain or buildings, only behind the camera. Upgrade: a depth test under the
 * square's centre. No hysteresis at the range edge. Upgrade: leave at 10.5 nm.
 */
export class Traffic {
  readonly #viewer: Viewer
  readonly #m: ModelManifestEntry
  readonly #layer: HTMLElement
  readonly #load: () => Promise<Model>
  readonly #slots: Slot[] = []
  readonly #byHex = new Map<string, Slot>()
  readonly #near = new Set<string>()
  readonly #models = new Set<string>()
  readonly #want = new Set<string>()
  readonly #view: TrafficView = { near: this.#near, models: this.#models }
  readonly #boxes: Box[] = []
  readonly #els: HTMLDivElement[] = []
  readonly #hpr = new HeadingPitchRoll()
  readonly #c = new Cartesian3()
  readonly #v = new Cartesian3()
  readonly #w = new Cartesian2()
  #nBoxes = 0
  #loading = 0
  #failed = false
  #destroyed = false

  constructor(viewer: Viewer, m: ModelManifestEntry, layer: HTMLElement, load = (): Promise<Model> => loadTrafficModel(m)) {
    this.#viewer = viewer
    this.#m = m
    this.#layer = layer
    this.#load = load
  }

  /**
   * This frame's traffic around the chased aircraft at `at`, for FleetLayer.update: every aircraft in range (near), and
   * the nearest MAX_MODELS that have a ready model (models). null (not chasing, or no position yet): no traffic, and
   * every model and bracket hides.
   */
  select(entries: readonly FleetEntry[], chasedHex: string | null, at: { lat: number; lon: number } | null): TrafficView | null {
    this.#near.clear()
    this.#models.clear()
    this.#want.clear()
    const near = at === null ? [] : nearestInRange(entries, chasedHex, at.lat, at.lon, RANGE_NM)
    for (let i = 0; i < near.length; i++) {
      this.#near.add(near[i].e.hex)
      if (i < MAX_MODELS) this.#want.add(near[i].e.hex)
    }
    for (const s of this.#slots) if (s.hex !== null && !this.#want.has(s.hex)) this.#free(s)
    this.#grow(this.#want.size)
    for (let i = 0; i < near.length && i < MAX_MODELS; i++) {
      const e = near[i].e
      let s = this.#byHex.get(e.hex)
      if (s === undefined) {
        s = this.#slots.find((x) => x.hex === null && x.model.ready)
        if (s === undefined) continue // none free and ready yet: its icon stays
        s.hex = e.hex
        s.headingDeg = e.trackDeg ?? 0
        this.#byHex.set(e.hex, s)
      }
      s.e = e
      this.#models.add(e.hex)
    }
    if (at === null) this.#hideBoxes(0)
    return at === null ? null : this.#view
  }

  /**
   * After the camera moved this frame: each selected model goes where FleetLayer placed its aircraft, and its brackets
   * around it. ibl: the chased model's image-based light (the Sun dims it at night), copied so the traffic dims too.
   */
  update(placed: { positionOf(hex: string): Cartesian3 | undefined }, ibl?: Cartesian2): void {
    const scene = this.#viewer.scene
    const cam = scene.camera
    const fovy = (cam.frustum as PerspectiveFrustum).fovy
    const hPx = scene.canvas.clientHeight
    let n = 0
    for (const s of this.#slots) {
      if (s.hex === null || s.e === null) continue
      const pos = placed.positionOf(s.hex)
      if (pos === undefined) {
        s.model.show = false
        continue
      }
      const e = s.e
      if (e.trackDeg !== null) s.headingDeg = e.trackDeg
      const k = scaleFor(e.info?.category)
      trafficMatrix(pos, trafficHpr(e, this.#m, s.headingDeg, this.#hpr), this.#m, k, s.model.modelMatrix)
      if (ibl) s.model.imageBasedLighting.imageBasedLightingFactor = ibl // the setter copies it
      s.model.show = true
      const c = Matrix4.getTranslation(s.model.modelMatrix, this.#c)
      const depthM = Cartesian3.dot(Cartesian3.subtract(c, cam.positionWC, this.#v), cam.directionWC)
      if (!(depthM > 1)) continue // behind the camera
      const w = SceneTransforms.worldToWindowCoordinates(scene, c, this.#w)
      if (w === undefined) continue
      const b = this.#boxes[n] ?? (this.#boxes[n] = { hex: '', x: 0, y: 0, side: 0, depthM: 0 })
      b.hex = s.hex
      b.x = w.x
      b.y = w.y
      b.side = squarePx(HALF_SIZE * this.#m.lengthM * k, depthM, fovy, hPx)
      b.depthM = depthM
      this.#place(n++, b)
    }
    this.#hideBoxes(n)
  }

  /** The traffic aircraft whose bracket square holds (x, y) (canvas CSS px), nearest first; null when none. */
  hitAt(x: number, y: number): string | null {
    return hitAt(this.#boxes, this.#nBoxes, x, y)
  }

  destroy(): void {
    this.#destroyed = true
    for (const s of this.#slots) this.#viewer.scene.primitives.remove(s.model)
    this.#slots.length = 0
    this.#byHex.clear()
    for (const el of this.#els) el.remove()
    this.#els.length = 0
    this.#nBoxes = 0
  }

  #free(s: Slot): void {
    s.model.show = false
    if (s.hex !== null) this.#byHex.delete(s.hex)
    s.hex = null
    s.e = null
  }

  #grow(want: number): void {
    while (!this.#failed && !this.#destroyed && this.#slots.length + this.#loading < want) {
      this.#loading++
      this.#load().then(
        (model) => {
          this.#loading--
          if (this.#destroyed) return void model.destroy()
          model.show = false
          this.#viewer.scene.primitives.add(model)
          this.#slots.push({ model, hex: null, e: null, headingDeg: 0 })
        },
        (err: unknown) => {
          this.#loading--
          if (!this.#failed) console.warn('FlightHopper: traffic model not loaded; traffic stays as icons:', err)
          this.#failed = true
        },
      )
    }
  }

  #place(i: number, b: Box): void {
    let el = this.#els[i]
    if (el === undefined) {
      el = this.#els[i] = document.createElement('div')
      el.className = 'fh-bracket'
      this.#layer.append(el)
    }
    const side = Math.round(b.side)
    el.style.width = el.style.height = `${side}px`
    el.style.transform = `translate(${(b.x - side / 2).toFixed(1)}px, ${(b.y - side / 2).toFixed(1)}px)`
    el.hidden = false
  }

  #hideBoxes(n: number): void {
    for (let i = n; i < this.#nBoxes; i++) this.#els[i].hidden = true
    this.#nBoxes = n
  }
}
```

- [ ] **Step 2:** Append to `client/ui/layout.css`:

```css
/* Chase traffic (client/scene/traffic.ts): two corner brackets (top right, bottom left) around each 3-D traffic
   model, sized to it on screen. Under the overlays; the click test is in JS (the canvas keeps the pointer). */
.fh-traffic {
  position: absolute;
  inset: 0;
  z-index: 5;
  overflow: hidden;
  pointer-events: none;
}
.fh-bracket {
  position: absolute;
  left: 0;
  top: 0;
  will-change: transform;
}
.fh-bracket::before,
.fh-bracket::after {
  content: '';
  position: absolute;
  width: clamp(5px, 26%, 16px);
  height: clamp(5px, 26%, 16px);
  border: 1.5px solid rgb(255 255 255 / 0.9);
  filter: drop-shadow(0 0 1.5px rgb(0 0 0 / 0.75));
}
.fh-bracket::before { top: 0; right: 0; border-left: 0; border-bottom: 0; }
.fh-bracket::after { bottom: 0; left: 0; border-right: 0; border-top: 0; }
```

- [ ] **Step 3:** `npm run typecheck`. Expected: clean. `node --test client/scene/traffic.test.ts`. Expected: PASS.
- [ ] **Step 4:** Commit `feat(traffic): pooled 3-D traffic models and corner-bracket squares`.

### Task 5: Wire into the app, then check in the browser

**Files:**
- Modify: `client/app.ts` (header comment, setup, `frame()`, the click handler, `stop()`)

- [ ] **Step 1:** Setup. Right before `const ui = div('fh-ui', root)`:
```ts
  // Chase traffic: 3-D models around the chased aircraft, their brackets in a layer under the overlays.
  const traffic = entry ? new Traffic(viewer, entry, div('fh-traffic', root)) : null
```
- [ ] **Step 2:** In `frame()`, draw the fleet at the render time while chasing. Replace the ponytail comment and `all = fleet.entries(tServerMs)` with:
```ts
      // Chasing, the fleet is drawn at the chased aircraft's (delayed) render time, so the traffic around it is where
      // it was at that moment (dead-reckoned back from newer samples); browse draws it at server now.
      all = fleet.entries(chasing ? tRenderMs : tServerMs)
```
Then replace the `fleetLayer.update(...)` line with:
```ts
    const trafficView = traffic?.select(all, selected, chasing && s !== null ? s : null) ?? null
    fleetLayer.update(all, selected, tableHover ?? mapHover, chasing && s !== null && model !== null, trafficView)
```
After `clearanceM = chaseCam.update(placed, dtS).clearanceM` add:
```ts
      traffic?.update(fleetLayer, model?.model.imageBasedLighting.imageBasedLightingFactor) // after the camera: brackets match this frame
```
- [ ] **Step 3:** Click. At the start of the `LEFT_CLICK` action:
```ts
    // A traffic model's bracket square (chase) takes the click first. ponytail: caught with no action yet; the
    // aircraft's own menu comes later.
    if (traffic !== null && traffic.hitAt(e.position.x, e.position.y) !== null) return
```
- [ ] **Step 4:** `stop()`: `traffic?.destroy()` next to `model?.destroy()`. Header comment (line 6): "The other aircraft
  within 10 nm show as 3-D models with corner brackets (client/scene/traffic.ts); farther ones hide."
- [ ] **Step 5:** `npm run check`. Expected: typecheck clean and every test passes.
- [ ] **Step 6:** Browser check (replay, `.claude/launch.json` replay configs): chase a replay aircraft with traffic
  within 10 nm, and take a timed screenshot series. Check: the models point along their tracks, the brackets fit the
  models and follow them as the camera orbits and zooms, the far icons are gone, a click in a square does not
  change the selection, a click outside still works as before, there are no console errors, and the phone width
  (375×812) looks right. Also check a night view with `?sun=` (the traffic dims).
- [ ] **Step 7:** Commit `feat(chase): 3-D traffic within 10 nm with corner-bracket hitboxes`.

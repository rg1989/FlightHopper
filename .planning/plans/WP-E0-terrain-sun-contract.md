# WP-E0 — Terrain & Sun Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the shared arithmetic and types that the terrain & sun feature (`.planning/terrain-sun-design.md`) needs, so that E1–E4 can be built in parallel. The contract covers: the exaggeration factor while topography is on (`TOPO_ON`), where Cesium draws a terrain height at a given factor and the way back, the correction for a `globe.getHeight` reading taken at an older factor (one frame late, or kept from an earlier frame), the animation curve, and the `ScenePrefs` and `TerrainFrame` types.

**Architecture:** Additive only. No existing file changes behaviour.
- `client/scene/exaggeration.ts` is pure and imports nothing (not even Cesium), so every E package's Node tests can use it. Cesium 1.145 draws a terrain point of true height h (HAE m) at `(h − relH)·f + relH`. Here f is `scene.verticalExaggeration` and relH is `scene.verticalExaggerationRelativeHeight`. `globe.getHeight` returns this drawn surface.
  - `TOPO_ON = 1 + 1e-5` (D2). The factor never returns to exactly 1. When it crosses 1, Cesium adds or strips geodetic surface normals on every loaded tile. In the PoC that made the first sink frame take 686–2,008 ms, against a worst frame of 36–44 ms with the epsilon.
  - `drawnHeightM(trueM, f, relHM)` is Cesium's formula.
  - `trueHeightM(drawnM, f, relHM)` is its inverse. It returns `null` while `f < 0.5`.
  - `rescaleSampledM(sampledM, fSampled, fNow, relHM)` returns `relH + (sampled − relH)·fNow/fSampled`. It returns `relHM` while `fSampled < 1e-4`.
  - `smoothstep(u)` is `3u² − 2u³`, clamped to [0, 1]. NaN gives 0.
- **Why the two thresholds.** A `globe.getHeight` reading has its own error. The picker intersects flat triangles, which sit under the curved Earth, so a reading in a triangle's middle is low. Measured with Cesium's own ray-triangle test: 3.5 cm for a 1 km triangle, 0.87 m for 5 km. D3's nudge leaves a flat ground at f = 1e-7, not 0. Dividing a 3 cm error by 1e-7 would place a ground icon 300 km underground. Multiplying it by the first grow frame's ratio (1.34e-4 / 1e-7) would put the camera's ground 40 m off. So "flat" means `fSampled < 1e-4` (`FLAT_F`, which covers 0 and the nudge). The inverse returns `null` below `f = 0.5` (`INVERT_MIN_F`), where it would multiply that error by `(1 − f)/f > 1`. Neither threshold is exported: consumers go by the results (`relHM`, `null`).
- `client/types.ts` (the WP-00 contract file; WP-B0 set the precedent) gets `ScenePrefs { topo; light }` (D11) and `TerrainFrame { fSampled; fNow; relHM }` appended. Every existing declaration stays byte-identical.

Conventions consumers rely on:
- **E1 `Topography.update()`** runs first in `scene.preUpdate`, before any `globe.getHeight`. It returns one reused `TerrainFrame`. `fSampled` is the factor written in the previous frame, which is what the tiles hold now (`requestRenderMode` is false, so every frame renders). `fNow` is the factor written for this frame: `from + (to − from)·smoothstep(elapsedMs / TOPO_ANIM_MS)`, kept between 0 and `TOPO_ON` (plus D3's nudge). Check `Number.isFinite` before writing it. relH changes only while the ground is flat (the next `rescaleSampledM` then answers with the new plane) or at `TOPO_ON` (the drawn ground then moves by 1e-5 of the change, under 2 cm at LOWI).
- **App and `ChaseCamera` `groundAt`** (through E1's `Topography.ground`): correct every reading with `rescaleSampledM(h, fSampled, fr.fNow, fr.relHM)`. `fSampled` is the factor the tiles held when h was read: `fr.fSampled` for a reading taken this frame, or, for a kept reading of any age (E1's `GroundMemo`), the `fSampled` of the frame that read it, around the same relH. A fixed point's drawn height follows the factor exactly, so age adds no error of its own. Two limits apply to kept readings:
  - A reading taken while flat (`fSampled < 1e-4`) holds no relief. It answers relH, off by `fNow·relief`: 258 m under the Nordkette when kept to a 60 fps grow's 37th frame (f = 0.15).
  - The ratio `fNow / fSampled` has no bound but `TOPO_ON / 1e-4` (about 10,000). It multiplies the reading's own error: about 4× for last frame's reading on a grow's second frame, but about 1,150× for a reading from that frame kept to the 37th.
- **E3.** Runways shift by `drawnHeightM(h, fr.fNow, fr.relHM) − h`. Fleet ground icons cache `trueHeightM(h, fr.fSampled, fr.relHM)`. On `null`, keep the cached value. Draw at `drawnHeightM(cached, fr.fNow, fr.relHM)`. An icon with no cached value yet sits at `fr.relHM` while the ground is flat, because everything is drawn there.

**Tech Stack:** Erasable TypeScript and `node:test`. No Cesium import and no new dependencies. The arithmetic mirrors Cesium 1.145's `VerticalExaggeration.getHeight` and `GlobeVS.glsl` (see "Sources").

**Wave:** E0 (after B-A: the tree already holds the integrated B-A app). Consumed by E1–E4 and E-A. **Estimated:** 20 min. **Validated:** 2026-09-22 in a scratch copy of the integrated B-A tree (Node 25.2.1, TypeScript 7.0.2, Vite 8.3.0, Cesium 1.145.0) on the user's MacBook Air M2:
- `node --test client/scene/exaggeration.test.ts` passed 7/7. `npx tsc --noEmit` is clean for the whole tree. `npm run check` passed 611/611 (604 + 7). The two timing tests that are known to flake under full-suite load ("sortRows and filterRows stay cheap at 12,000 rows" and "budget: /api/view of a 250 nm circle with 5,000 aircraft") passed in this run.
- **RED:** Step 2 quotes the real output: `ERR_MODULE_NOT_FOUND` from the test, and TS2305 + TS2307 from `tsc`.
- **Mutations:** 14 hand-made faults, each caught by 1–5 failing tests:
  - `TOPO_ON` exactly 1;
  - `drawnHeightM` ignoring relH;
  - the inverse returning `null` only at f = 0 (the brief's literal rule), or below 1e-4, or below 0.2;
  - the inverse forgetting relH;
  - `rescaleSampledM` treating the ground as flat only at `fSampled === 0` (the brief's literal rule), or below 1e-3;
  - the ratio inverted;
  - no rescale;
  - the flat branch returning the reading;
  - `smoothstep` unclamped, letting NaN through, or linear.
- **Picker error:** a flat ECEF triangle at constant height near LOWI, read at its centroid with Cesium's `IntersectionTests.rayTriangleParametric` (the routine `TerrainPicker` uses) and the hit's ellipsoidal height, the same way as `globe.getHeight`. It reads low by 0.3 mm (100 m legs), 3.1 mm (300 m), 3.5 cm (1 km), 10 cm (1.7 km) and 0.87 m (5 km).
- **Replay:** the plan's code blocks were extracted into a fresh copy of the B-A tree. Step 2 failed as written, Step 4 passed (7/7), and `tsc --noEmit` of the copy was clean.
- **Harness:** none. E0 has no page. E1's harness and gate GE check the formulas in the browser (browser check pending, run by the orchestrator for gate GE). The check must use a ground that does not come from the correction. Gate GE's clearance comes from it (see Notes, "ponytail").
- **Amendment 2026-09-23 (review: kept readings).** E1 and E-A now pass readings kept for up to 37 frames (`GroundMemo`) to `rescaleSampledM`, with the factor of the frame that read them. The Goal, "Conventions consumers rely on", the `rescaleSampledM` doc and the Notes now cover readings of any age, the flat case and the ratio bounds. They also name a check that does not use the corrected ground. The code was changed in the E-A sandbox, and both `exaggeration` File blocks are byte-identical to it:
  - `exaggeration.ts`: only the `rescaleSampledM` doc comment.
  - `exaggeration.test.ts`: two new assertions. A reading kept from f(1) to f(37) is exact. A flat reading kept to f(37) is off by `fNow·relief`. The two test names say so. There are still 7 tests, and Step 2's RED output is unchanged (the import lines did not move).
  - `node --test client/scene/exaggeration.test.ts`: 7/7. `npx tsc --noEmit`: clean for the whole sandbox tree.
  - The mutations were not run again. The new assertions can only add failures. `npm run check` was not run again (the count stays 611 on the B-A tree).

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- Erasable TypeScript only. Relative imports end in `.ts`. `exaggeration.ts` imports nothing, so it loads in Node without Cesium.
- **Heights** are WGS84 ellipsoidal metres (HAE), including relH (it is below the ellipsoid at KSFO, −28 m).
- Cesium's debug assertions ship in this app, because Vite bundles the unbuilt source: a non-finite factor or relH throws inside `render`. These helpers only compute. The one writer (E1 `Topography`) checks `Number.isFinite` before it writes. `smoothstep` never returns NaN.
- No per-frame allocations: E1, E3 and the app call these helpers every frame, and they return plain numbers.
- `client/types.ts` is changed additively. Every existing declaration stays byte-identical (Task 2 Step 4 checks this).
- Code blocks preceded by `File: \`path\`` contain that file's complete content.

## Files owned by this package

| Path | Change |
|---|---|
| `client/scene/exaggeration.ts`, `client/scene/exaggeration.test.ts` | new: `TOPO_ON`, `drawnHeightM`, `trueHeightM`, `rescaleSampledM`, `smoothstep` |
| `client/types.ts` | `ScenePrefs` and `TerrainFrame` appended (WP-00 contract file, edited as in WP-B0) |

## Sources (checked 2026-09-22)

Paths are relative to `node_modules/@cesium/engine/Source` (Cesium 1.145.0, engine 26.3.0) unless marked `d.ts` (`node_modules/cesium/Source/Cesium.d.ts`).

| Fact | Source |
|---|---|
| Cesium draws terrain at `(height − relativeHeight)·scale + relativeHeight`. Debug builds throw on a non-finite scale or relativeHeight. Vite ships the debug build here, because it bundles the unbuilt source. | `Core/VerticalExaggeration.js:18-28` (checks at :20, :23); `Shaders/GlobeVS.glsl:179`; research VERIFY (the built bundle contains "scale must be a finite number") |
| `Scene.verticalExaggeration` (default 1.0) and `Scene.verticalExaggerationRelativeHeight` (default 0.0) are plain writable numbers. | `Scene/Scene.js:400`, `:409`; d.ts `:44535`, `:44540` |
| Any factor other than exactly 1 needs geodetic surface normals on every loaded tile. Crossing 1 adds or removes them tile by tile. | `Scene/GlobeSurfaceTile.js:426` (`hasExaggerationScale = exaggeration !== 1.0`), `:437-449`; `Scene/GlobeSurfaceTileProvider.js:557-576` (on a change: `forEachLoadedTile` → `updateExaggeration`); PoC timings, design brief §2 |
| The tiles take a new factor only inside `render()`, which runs after `scene.preUpdate`. So a `globe.getHeight` call in `preUpdate` sees the previous render's factor. | `Scene/Scene.js:4621-4627` (`render(time)` raises `preUpdate`), `:4696` → `render()` `:4519`, `:4528` (`updateFrameState()`), `:2079-2081` (factor and relH into `frameState`); `Scene/QuadtreePrimitive.js:363-368`; `Scene/GlobeSurfaceTileProvider.js:500` (`endUpdate`) |
| `globe.getHeight` returns the drawn (exaggerated) surface. It intersects flat triangles built from exaggerated vertex positions and returns the hit's ellipsoidal height. | `Scene/Globe.js:851`, `:957-972`; `Core/TerrainPicker.js:470` (`rayTriangleParametric`), `:533` (`getExaggeratedPosition`); `Core/TerrainEncoding.js:430-458` |
| `sampleTerrain` returns raw provider heights, without exaggeration. | `Core/sampleTerrain.js:258` |
| The normals cost about 30 % more terrain-mesh memory. | Cesium PR #9603 (research A2) |

---

### Task 1: Exaggeration helpers and the terrain types

**Files:**
- Create: `client/scene/exaggeration.ts`
- Modify: `client/types.ts` (complete new contents below)
- Test: `client/scene/exaggeration.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `TOPO_ON: number` (= 1 + 1e-5)
  - `drawnHeightM(trueM: number, f: number, relHM: number): number`
  - `trueHeightM(drawnM: number, f: number, relHM: number): number | null` (`null` while f < 0.5)
  - `rescaleSampledM(sampledM: number, fSampled: number, fNow: number, relHM: number): number` (`relHM` while fSampled < 1e-4)
  - `smoothstep(u: number): number` (in [0, 1]; NaN → 0)
  - `interface ScenePrefs { topo: boolean; light: boolean }`
  - `interface TerrainFrame { fSampled: number; fNow: number; relHM: number }`

- [ ] **Step 1: Write the failing test**

File: `client/scene/exaggeration.test.ts`
```ts
// client/scene/exaggeration.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TerrainFrame } from '../types.ts'
import { TOPO_ON, drawnHeightM, rescaleSampledM, smoothstep, trueHeightM } from './exaggeration.ts'

// LOWI: runway HAE (the relH Topography latches within 30 km) and a point high on the Nordkette, true HAE.
const LOWI_RWY = 628.4
const NORDKETTE = 2_317.9
// KSFO: the runway is below the ellipsoid, and the bay (at the geoid) lower still.
const KSFO_RWY = -28
const BAY = -32.3

function near(actual: number | null, expected: number, tolM = 1e-9): void {
  assert.ok(actual !== null && Math.abs(actual - expected) <= tolM, `${actual} ≠ ${expected} ± ${tolM}`)
}

test('drawnHeightM is Cesium’s (h − relH)·f + relH: unchanged at 1, relH everywhere at 0', () => {
  near(drawnHeightM(NORDKETTE, 1, LOWI_RWY), NORDKETTE)
  near(drawnHeightM(NORDKETTE, 0, LOWI_RWY), LOWI_RWY)
  near(drawnHeightM(BAY, 0, KSFO_RWY), KSFO_RWY)
  near(drawnHeightM(NORDKETTE, 0.5, LOWI_RWY), 1_473.15) // halfway between runway and peak
  near(drawnHeightM(BAY, 0.5, KSFO_RWY), -30.15) // below relH, relH below the ellipsoid
  near(drawnHeightM(LOWI_RWY, 0.37, LOWI_RWY), LOWI_RWY) // relH itself never moves
})

test('TOPO_ON is 1 + 1e-5, never exactly 1, and moves the Nordkette by less than 2 cm', () => {
  assert.equal(TOPO_ON, 1 + 1e-5)
  assert.notEqual(TOPO_ON, 1)
  const moveM = drawnHeightM(NORDKETTE, TOPO_ON, LOWI_RWY) - NORDKETTE
  assert.ok(moveM > 0 && moveM < 0.02, `peak moved ${moveM} m`)
})

test('trueHeightM inverts drawnHeightM (LOWI at 0.5, KSFO below the ellipsoid, round trips)', () => {
  near(trueHeightM(1_473.15, 0.5, LOWI_RWY), NORDKETTE)
  near(trueHeightM(-30.15, 0.5, KSFO_RWY), BAY)
  for (const f of [TOPO_ON, 1, 0.75, 0.5]) {
    for (const [h, rel] of [[NORDKETTE, LOWI_RWY], [BAY, KSFO_RWY], [LOWI_RWY, LOWI_RWY], [8_848, 0]]) {
      near(trueHeightM(drawnHeightM(h, f, rel), f, rel), h)
    }
  }
})

test('trueHeightM is null while the ground is flat or nearly so (0, the 1e-7 nudge, 0.25)', () => {
  assert.equal(trueHeightM(LOWI_RWY, 0, LOWI_RWY), null)
  // A flat triangle under the curved Earth reads ~3 cm low in its middle; divided by 1e-7 that would be −300 km.
  assert.equal(trueHeightM(LOWI_RWY - 0.03, 1e-7, LOWI_RWY), null)
  assert.equal(trueHeightM(drawnHeightM(NORDKETTE, 0.25, LOWI_RWY), 0.25, LOWI_RWY), null)
})

test('rescaleSampledM turns a reading of any age into this frame’s drawn ground (LOWI, steepest grow step)', () => {
  const fr: TerrainFrame = { fSampled: 0.4, fNow: 0.41, relHM: LOWI_RWY } // Δf 0.01: smoothstep’s peak at 60 fps
  const sampled = drawnHeightM(NORDKETTE, fr.fSampled, fr.relHM) // what globe.getHeight read in preUpdate
  const drawn = drawnHeightM(NORDKETTE, fr.fNow, fr.relHM)
  assert.ok(drawn - sampled > 15, `raw lag ${drawn - sampled} m`) // more than the chase camera’s 15 m clearance
  near(rescaleSampledM(sampled, fr.fSampled, fr.fNow, fr.relHM), drawn)
  near(rescaleSampledM(drawnHeightM(BAY, 0.6, KSFO_RWY), 0.6, 0.59, KSFO_RWY), drawnHeightM(BAY, 0.59, KSFO_RWY))
  near(rescaleSampledM(2_000, TOPO_ON, TOPO_ON, LOWI_RWY), 2_000) // steady: the reading as it is
  near(rescaleSampledM(drawnHeightM(NORDKETTE, 0.02, LOWI_RWY), 0.02, 0, LOWI_RWY), LOWI_RWY) // last frame of a sink
  // A kept reading (WP-E1's GroundMemo) passes the factor it was read at: f(1) of a 60 fps grow, used at f(37).
  const kept = drawnHeightM(NORDKETTE, 1.34e-4, LOWI_RWY)
  near(rescaleSampledM(kept, 1.34e-4, 0.1525, LOWI_RWY), drawnHeightM(NORDKETTE, 0.1525, LOWI_RWY))
})

test('rescaleSampledM from a flat ground returns relH (0, the 1e-7 nudge, a re-latched relH, a kept reading)', () => {
  near(rescaleSampledM(LOWI_RWY, 0, 1.34e-4, LOWI_RWY), LOWI_RWY) // first frame of a grow at 60 fps
  // After the nudge the flat ground rests at 1e-7. A reading 3 cm low must not be multiplied by 1,340 (40 m).
  near(rescaleSampledM(LOWI_RWY - 0.03, 1e-7, 1.34e-4, LOWI_RWY), LOWI_RWY)
  near(rescaleSampledM(LOWI_RWY, 1e-7, 1e-7, 700), 700) // re-latched while flat: the reading holds the old plane
  // Read while flat and kept to f(37) of the grow: still relH, off by fNow·relief (258 m under the drawn Nordkette).
  const flatKept = rescaleSampledM(LOWI_RWY, 1e-7, 0.1525, LOWI_RWY)
  near(drawnHeightM(NORDKETTE, 0.1525, LOWI_RWY) - flatKept, 0.1525 * (NORDKETTE - LOWI_RWY), 1e-6)
  // The second frame of the grow already rescales.
  const sampled = drawnHeightM(NORDKETTE, 1.34e-4, LOWI_RWY)
  near(rescaleSampledM(sampled, 1.34e-4, 5.35e-4, LOWI_RWY), drawnHeightM(NORDKETTE, 5.35e-4, LOWI_RWY))
})

test('smoothstep: 0 → 1 with flat ends, symmetric, clamped for inputs in any order', () => {
  assert.equal(smoothstep(0), 0)
  assert.equal(smoothstep(1), 1)
  assert.equal(smoothstep(0.5), 0.5)
  near(smoothstep(0.25) + smoothstep(0.75), 1)
  assert.ok(smoothstep(0.001) < 1e-5) // zero slope at the start: the first frame of a grow is nearly flat
  // A reversed or restarted animation feeds u backwards and out of range: each value stands on its own.
  const us = [0.9, -0.2, 0.3, 1.7, 0.3, 0, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, 0.6]
  const want = [0.972, 0, 0.216, 1, 0.216, 0, 0, 0, 1, 0.648]
  us.forEach((u, i) => near(smoothstep(u), want[i], 1e-12))
  let prev = 0
  for (let u = -0.5; u <= 1.5; u += 0.01) {
    const s = smoothstep(u)
    assert.ok(s >= prev && s <= 1, `smoothstep(${u}) = ${s}`)
    prev = s
  }
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/scene/exaggeration.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/scene/exaggeration.ts' imported from …/client/scene/exaggeration.test.ts`, then `ℹ tests 1`, `ℹ fail 1`.

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/exaggeration'`
Expected:
```
client/scene/exaggeration.test.ts(4,15): error TS2305: Module '"../types.ts"' has no exported member 'TerrainFrame'.
client/scene/exaggeration.test.ts(5,81): error TS2307: Cannot find module './exaggeration.ts' or its corresponding type declarations.
```

- [ ] **Step 3: Write the implementation**

File: `client/scene/exaggeration.ts`
```ts
// client/scene/exaggeration.ts
/**
 * Terrain vertical exaggeration arithmetic for the topography toggle (design D2–D5, D7). Pure: no Cesium import.
 * Cesium draws a terrain point of true height h (HAE m) at (h − relH)·f + relH, where f = scene.verticalExaggeration
 * and relH = scene.verticalExaggerationRelativeHeight (Core/VerticalExaggeration.getHeight, GlobeVS.glsl). f = 0 is a
 * flat map at relH. globe.getHeight returns this drawn surface; sampleTerrain returns the true one.
 */

/**
 * The factor while topography is on. Never exactly 1: when the factor leaves 1, Cesium adds geodetic surface normals to
 * every loaded tile (a new vertex buffer each) and strips them again when it returns to 1. In the PoC that made the
 * first frame of a sink 686–2,008 ms; with 1 + 1e-5 the worst animation frame was 36–44 ms. The peaks move by 1e-5 of
 * their height above relH (2 cm at LOWI). Cost: the normals stay, ~30 % more terrain-mesh memory.
 */
export const TOPO_ON = 1 + 1e-5

/** Below this factor the ground is flat: 0, or 1e-7 after Topography's nudge (D3). */
const FLAT_F = 1e-4

/**
 * A globe.getHeight reading carries the picker's own error: a flat triangle under the curved Earth reads low in its
 * middle (3.5 cm for a 1 km triangle, 0.9 m for 5 km). Inverting multiplies that by (1 − f)/f, more than 1 below 0.5.
 */
const INVERT_MIN_F = 0.5

/** Where Cesium draws a terrain point of true height trueM, at factor f around relHM. */
export function drawnHeightM(trueM: number, f: number, relHM: number): number {
  return (trueM - relHM) * f + relHM
}

/** The true height of a drawn reading (globe.getHeight at factor f). null while f < 0.5: flat, or too flat to invert. */
export function trueHeightM(drawnM: number, f: number, relHM: number): number | null {
  return f < INVERT_MIN_F ? null : (drawnM - relHM) / f + relHM
}

/**
 * A globe.getHeight reading → the ground drawn this frame, at fNow. fSampled is the factor the tiles held when the
 * reading was taken: for one taken this frame in scene.preUpdate, the previous render's (Cesium hands a new factor to
 * the tiles only inside render()); for a kept one of any age (WP-E1's GroundMemo), the fSampled of the frame that read
 * it, around the same relHM. A fixed point's drawn height follows the factor exactly, so age adds no error of its own.
 * Mid-animation the raw reading is off by up to 1 % of the relief per frame at 60 fps (17 m at LOWI), more than the
 * camera's 15 m clearance.
 * A reading taken while flat (fSampled < 1e-4) holds no relief: returns relHM, off by fNow·relief. That is ~0 for this
 * frame's reading on a grow's first frame, but 258 m at the Nordkette if kept to a 60 fps grow's 37th (f = 0.15).
 * ponytail: fNow / fSampled is not capped (up to 1e4) and multiplies the picker's own error: 4× for last frame's
 * reading on a 60 fps grow's second frame, ~1,150× for a reading from there kept to the 37th (3 mm → 3.6 m).
 * Upgrade: cap the ratio, or the age of a kept reading, if a check against the true ground (sampleTerrain at fNow)
 * shows it. A clearance computed from this result cannot show it.
 */
export function rescaleSampledM(sampledM: number, fSampled: number, fNow: number, relHM: number): number {
  return fSampled < FLAT_F ? relHM : (sampledM - relHM) * (fNow / fSampled) + relHM
}

/** 3u² − 2u³ clamped: 0 for u ≤ 0 (and NaN), 1 for u ≥ 1. Zero slope at both ends. */
export function smoothstep(u: number): number {
  return u > 0 ? (u < 1 ? u * u * (3 - 2 * u) : 1) : 0
}
```

File: `client/types.ts`
```ts
import type { AircraftInfo } from '../shared/info.ts'
import type { Quality } from '../shared/types.ts'
import type { AltSource } from './track/types.ts'

/** What the scene draws for one aircraft at render time. Produced by Track.stateAt(). */
export interface RenderState {
  hex: string
  lat: number
  lon: number
  hM: number                                    // WGS84 ellipsoidal metres of the wheels (the chase model adds gearHeightM)
  headingDeg: number                            // true, nose direction
  pitchDeg: number                              // nose-up positive
  rollDeg: number                               // right-wing-down positive
  gsKt: number | null                           // copied from the newest sample
  trackDeg: number | null                       // copied from the newest sample
  altBaroFt: number | null                      // copied from the newest sample
  vsFpm: number | null                          // from the vertical filter (derived)
  mode: 'interp' | 'extrap' | 'stale'           // stale = extrapolated past 8 s → frozen
  altSource: AltSource
  onGround: boolean
  ageS: number                                  // tRender − newest sample tMs, seconds
  quality: Quality
  callsign: string | null
  typeCode: string | null
}

export interface ClientConfig {
  terrain: 'ion' | 'reearth' | 'ellipsoid'
  imagery: 'ion' | 'eox' | 'none'
  ionToken: string | null
  apiBase: string
}

/** public/models/manifest.json entry. Calibration makes the model's nose point along RenderState.headingDeg. */
export interface ModelManifestEntry {
  id: string
  uri: string                                   // relative to public/, e.g. "models/airliner.glb"
  license: string
  author: string
  source: string                                // where it was downloaded from
  forwardAxisFix: { headingDeg: number; pitchDeg: number; rollDeg: number }
  gearHeightM: number                           // model origin → wheel bottom, metres (after scale)
  lengthM: number                               // real-world length the scale targets
  scale: number
}

export interface ModelManifest {
  default: string                               // id of the model used when no type match
  models: ModelManifestEntry[]
}

/**
 * One aircraft in the browse view: newest sample, dead-reckoned to the render time (no Hermite, no filters), for
 * thousands of aircraft per frame. Objects are reused between frames by Fleet; never keep a reference across frames.
 */
export interface FleetEntry {
  hex: string
  lat: number
  lon: number
  hM: number                                    // HAE metres for 3-D placement (geom, else baro + N; ground: N)
  altFt: number | null                          // baro ft (geom when no baro) for colour and table; null = unknown
  onGround: boolean
  trackDeg: number | null
  gsKt: number | null
  vsFpm: number | null
  ageS: number                                  // render time − newest sample tMs, seconds
  quality: Quality
  info: AircraftInfo | null
}

/** The user’s scene toggles (design D11). Persisted: URL > localStorage > defaults (both on). */
export interface ScenePrefs {
  topo: boolean                                 // 3-D terrain: exaggeration TOPO_ON, else flat (0) around relH
  light: boolean                                // sun lighting in chase (browse stays unlit)
}

/**
 * Terrain exaggeration for one frame, returned by Topography.update() and passed to the app, the runways and the fleet
 * layer. Topography reuses one object: read it during the frame, never keep it.
 */
export interface TerrainFrame {
  fSampled: number                              // factor the tiles held when globe.getHeight ran this frame (last render’s)
  fNow: number                                  // factor drawn this frame (scene.verticalExaggeration)
  relHM: number                                 // scene.verticalExaggerationRelativeHeight drawn this frame, HAE metres
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/scene/exaggeration.test.ts`
Expected: PASS — `ℹ tests 7`, `ℹ pass 7`, `ℹ fail 0`.

- [ ] **Step 5: Type-check these files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/exaggeration|client/types'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 6: Commit**

```bash
git add client/scene/exaggeration.ts client/scene/exaggeration.test.ts client/types.ts
git commit -m "feat(contract): terrain exaggeration helpers, ScenePrefs and TerrainFrame" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: WP gate

- [ ] **Step 1: This package's tests**

Run: `node --test client/scene/exaggeration.test.ts`
Expected: `ℹ tests 7`, `ℹ pass 7`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/exaggeration|client/types'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Full check**

Run: `npm run check`
Expected: `tsc` prints nothing, then `ℹ tests 611`, `ℹ fail 0` (604 on the B-A tree + 7). Two timing tests can fail under full-suite load and pass when run alone: "sortRows and filterRows stay cheap at 12,000 rows" (`client/ui/table.test.ts`) and "budget: /api/view of a 250 nm circle with 5,000 aircraft" (`server/main.browse.test.ts`). They are known flakes, not regressions. Any other failure must be fixed.

- [ ] **Step 4: Confirm the `client/types.ts` change is additive**

Run: `git diff --numstat HEAD~1 -- client/types.ts`
Expected: `16`, `0`, `client/types.ts` (tab-separated): 16 lines added, none removed or changed.

- [ ] **Step 5: Confirm there is nothing left to commit**

Run: `git status --short`
Expected: no output.

## Notes for later work

- **Deviations from the design brief** (§5 lists the E0 signatures):
  - `trueHeightM` returns `null` while `f < 0.5`, not only at f = 0.
  - `rescaleSampledM` returns `relHM` while `fSampled < 1e-4`, not only at 0.
  - The reason for both is D3's nudge. The flat ground rests at f = 1e-7, and a reading's own error (centimetres in fine tiles, up to 0.9 m in coarse ones; see "Why the two thresholds") would be multiplied by 1/f or by fNow/fSampled.
  - `smoothstep(NaN)` is 0, so a broken clock can never turn into a NaN factor.
  - `TerrainFrame` is in this contract at the WP brief's request (§5's E0 row names only `ScenePrefs`). Its doc asks `Topography` to reuse one object, following the no-per-frame-allocation rule.
- **ponytail:** `fNow / fSampled` is not capped. Its only bound is `TOPO_ON / 1e-4`, about 10,000.
  - For a reading taken this frame, a regular grow's ratio is at most about 4× (the second frame at 60 fps) and falls towards 1 after that. So the reading's few-cm error stays within about 15 cm.
  - A stall during the first frames of a grow (a hidden tab) spans a large factor step for one frame.
  - A kept reading (E1's `GroundMemo`, which E-A uses for the aircraft and the camera) spans every frame since it was read. Gate GE saw runs of up to 37 `undefined` frames. A reading taken at f(1) of a 60 fps grow and kept to f(37) has a ratio of about 1,150: 3.1 mm becomes 3.6 m (300 m triangles), and 3.5 cm becomes 40 m (1 km triangles).
  - A kept reading taken while flat answers relH for the whole run, off by `fNow·relief`: 258 m under the Nordkette at f(37) = 0.15. The last reading before a grow is a flat one, and the `undefined` runs occur during the animation.
  - Upgrade (E1, in `Topography.ground`): an age limit or a ratio cap for kept readings, `null` for a flat kept reading once the factor is no longer flat, or a clock restart after a stall (research VERIFY, R-recipe (e)).
  - **How to see it:** gate GE's clearance log cannot show it. The app computes that clearance from this same corrected ground, so a wrong estimate moves the ground and the clearance together. E-A's `clearance min` 308 m / 362 m and `violations 0` (its first runs, before the memo) come from that same ground. Compare with a ground that does not come from the correction instead:
    - In E1's harness with `?hold=1`, check `groundM − expectedGroundM` on every frame (E1 Task 5 Step 4, check 5). `expectedGroundM` is `drawnHeightM(sampleTerrainMostDetailed, fNow, relH)`. This shows the problem only when the harness passes a `GroundMemo` to `ground()` (it does not yet) and has the same reference for the camera point.
    - Or compare each kept-reading estimate with the next defined reading, corrected, when it arrives.
- E1 may need the true ground under a newly selected aircraft while the ground is flat (the D4 re-latch). `trueHeightM` cannot supply it there (it returns `null`). The alternatives are `sampleTerrainMostDetailed`, which returns raw heights (`Core/sampleTerrain.js:258`), or the nearest hero airport's runway HAE.

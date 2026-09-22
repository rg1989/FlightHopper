# WP-V3 — Model Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a real 3D aircraft model under the chase camera and prove that its nose always points along `RenderState.headingDeg` (true), that positive pitch raises the nose and that positive roll puts the right wing down. The aircraft must never fly sideways. (This is the old "Spike C". Gate G3 requires this package's calibration test to be green.)

**Architecture:** One module, `client/scene/model.ts`, plus one model and its manifest in `public/models/`.
- `measureGlb(glb)` reads the GLB's own vertices and finds the nose from the geometry: the vertical fin is at the tail, so the nose is the horizontal direction from the fin to the centre of the model. It reports the nose, up and right-wing axes in Cesium's model frame, after the same glTF axis correction that Cesium's `Model` applies (`GLTF_TO_CESIUM`, built from Cesium's own `Axis` matrices). The test uses these measured axes, so it checks the asset, not only the math.
- `hprFor(state, m)` = `HeadingPitchRoll(rad(heading + fix.heading), rad(pitch + fix.pitch), rad(roll + fix.roll))`. Cesium's sign conventions were read from the 1.145 source and need no remapping (see "Calibration facts").
- `modelMatrixFor(state, m, result?)` = `Transforms.headingPitchRollToFixedFrame(position(lat, lon, hM + gearHeightM), hprFor(...))` with the uniform `m.scale` baked in. `hM` is the height of the wheels in every phase, so touchdown has no step.
- `noseAzimuthDeg(modelMatrix, noseAxis = +X)` transforms the nose axis into ENU at the model origin and returns `atan2(E, N)` in [0, 360).
- `ChaseModel.load(viewer, m)` = `Model.fromGltfAsync({ url, minimumPixelSize, show: false })` + `scene.primitives.add`. `update(state)` rewrites `model.modelMatrix` in place. The model stays hidden until the first `update()`, so it never appears at the Earth's centre.

**Tech Stack:** CesiumJS 1.145 (`Model`, `Transforms`, `HeadingPitchRoll`, `Matrix4`), `node:test`. Cesium loads in Node (`import 'cesium'` takes about 0.4 s under Node 25.2.1), so the tests use Cesium's real math. `Viewer` and `Model` are faked in the one `ChaseModel` test because Node has no WebGL. No new dependencies.

**Wave:** 1 (parallel; depends only on WP-00). Consumed by A2 (loads the manifest, drives `ChaseModel`) and gate G3. **Estimated:** 2 h. **Validated:** on 2026-09-22 (Node v25.2.1, TypeScript 7.0.2). In the shared Wave 1 sandbox, `node --test client/scene/model.test.ts` passes 18/18, and `npx tsc --noEmit` prints nothing at all. Every task was then replayed in a clean tree that held only WP-00's files plus `node_modules`: Task 1 failed (module not found), then passed 4/4; Task 2 failed (no export `hprFor`), then passed 17/17; Task 3 failed (no export `ChaseModel`), then passed 18/18. `tsc --noEmit` was clean after each task and after the harness, and the full test glob passed 59/59 (WP-00's 41 + these 18). Mutations, each in an isolated copy: `forwardAxisFix.headingDeg` 0 → 10 tests fail; `forwardAxisFix.headingDeg` +90 (nose backwards) → 10 tests fail; roll sign flipped in `hprFor` → 2 fail; pitch sign flipped → 2 fail. The harness ran in the in-app browser through Vite on port 5303: `PASS` for all 8 cases (largest error 2e-6°) and no console errors. Task 4 Step 4 describes the screenshots. The files below are byte-identical to the tested ones: this plan was generated from them.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- Sign conventions come from `RenderState` in `client/types.ts` (WP-00): heading is true degrees, clockwise from north; pitch is positive nose-up; roll is positive right-wing-down. C5's `Att` uses the same signs.
- Heights are WGS84 ellipsoidal metres (HAE). `modelMatrixFor` puts the wheels at `RenderState.hM`.
- Tests never touch the network. The model is a committed file, copied from `.planning/plans/assets/WP-V3/`. Only the harness page fetches anything, and only from the local Vite server.
- This package creates or edits only the six files below.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `client/scene/model.ts` | `hprFor`, `modelMatrixFor`, `noseAzimuthDeg`, `class ChaseModel`; also `measureGlb`, `GlbAxes`, `GLTF_TO_CESIUM` |
| `client/scene/model.test.ts` | the calibration test that G3 requires (asset axes, headings, KSFO 28L / 1R, pitch, roll, placement, `ChaseModel`) |
| `public/models/manifest.json` | the `ModelManifest`: provenance, `forwardAxisFix`, scale, gear height |
| `public/models/Cesium_Air.glb` | the model, copied from `.planning/plans/assets/WP-V3/Cesium_Air.glb` |
| `harness/model.html`, `harness/model.ts` | visual check at KSFO: thresholds, synthetic headings, pitch and roll views |

## Calibration facts (verified 2026-09-22)

| Fact | Value | Evidence |
|---|---|---|
| Model | Cesium Air, `Apps/SampleData/models/CesiumAir/Cesium_Air.glb` in `github.com/CesiumGS/cesium`, 586,652 bytes, SHA-256 `e72f627c5f0c9dc50726059703df55d74e634a32dbccb25b18f1783f913360b8` | Downloaded from `raw.githubusercontent.com/CesiumGS/cesium/main/...` and from the pinned commit `a6f0337f9fe56557c66cb7f6db0f0be422ed593e` (the last commit to touch the file, 2020-02-03); the two copies are identical. Commit `a28359aa` (2020-01-15) is titled "Updates Cesium_Air.glb to face +Z". |
| License | Apache-2.0, "Copyright 2011-2026 CesiumJS Contributors" | The repository's `LICENSE.md` (https://github.com/CesiumGS/cesium/blob/main/LICENSE.md). Its "Example Applications" section lists the third-party data under `Apps/` (for example Wooden Watch Tower CC BY 3.0 and Perc Lead Mine CC BY 4.0). Cesium Air is not listed, so the repository license applies. |
| glTF axes | nose glTF +Z, up +Y, wings along X | Fuselage mesh bounds x ±12.87 (span 25.74 m), y −2.296…5.464, z −13.40…8.00 (length 21.40 m). The span is longer than the length, so "the longest horizontal extent is the fuselage" is false for this model. The fin is decisive: all vertices above y = 3 m lie at z −13.40…−11.13 (tail at −Z), the tailplane (\|x\| up to 5.5 m) is at z < −9, the nose gear is at z ≈ +4 and the propeller spinners point to +Z. |
| Cesium's glTF correction | glTF +Z → +X, +Y → +Z, +X → +Y | `ModelUtility.getAxisCorrectionMatrix(Axis.Y, Axis.Z)` = `Axis.Y_UP_TO_Z_UP · Axis.Z_UP_TO_X_UP` (`@cesium/engine/Source/Scene/Model/ModelUtility.js`), applied before `modelMatrix` in `ModelSceneGraph.computeModelMatrix`. So in Cesium's model frame, Cesium Air has nose +X, up +Z, left wing +Y and right wing −Y. |
| Cesium's heading/pitch/roll | matrix = ENU · Rz(−heading) · Ry(−pitch) · Rx(roll) | `Quaternion.fromHeadingPitchRoll` and `Transforms.headingPitchRollToFixedFrame` in `@cesium/engine/Source/Core`. For a +X nose: heading 0 points the nose **east** and positive heading turns it clockwise (azimuth = 90° + heading); positive pitch raises the nose; positive roll lifts +Y (the left wing), so the right wing goes down. A test pins heading 0 → 90° and heading 90 → 180°. |
| `forwardAxisFix` | `{ headingDeg: −90, pitchDeg: 0, rollDeg: 0 }` | From the two rows above. Pitch and roll already have `RenderState`'s signs, so `hprFor` flips nothing. |
| Scale | 1.7555 → length 37.57 m (an A320's length), span 45.2 m | A choice: one generic model sized like a typical narrow-body airliner. The native model is 21.40 m long. The test checks that `lengthM` = measured length × scale. |
| `gearHeightM` | 4.03 m | Lowest vertex 2.296 m below the origin (the wheels), × 1.7555. |
| KSFO runway bearings | 28L 297.91°, 1R 27.69° | `bearingDeg` between the thresholds in `data/fixtures/golden/airports-sample.json`. That fixture's `hdgTrueDeg` values are OurAirports' whole degrees (298, 28), so the tests use the threshold geometry. |

---

### Task 1: Model asset, manifest and GLB measurement

**Files:**
- Create: `public/models/Cesium_Air.glb`, `public/models/manifest.json`, `client/scene/model.ts`, `client/scene/model.test.ts`
- Test: `client/scene/model.test.ts`

**Interfaces:**
- Consumes: `ModelManifest`, `ModelManifestEntry` (`client/types.ts`, WP-00)
- Produces:
  - `public/models/manifest.json`: a `ModelManifest` with `default: "cesium-air"` and one entry, `uri: "models/Cesium_Air.glb"`.
  - `GLTF_TO_CESIUM: Matrix4`: the rotation Cesium's `Model` applies to a glTF 2.0 asset before `modelMatrix`.
  - `interface GlbAxes { nose: Cartesian3; up: Cartesian3; right: Cartesian3; lengthM: number; spanM: number; belowOriginM: number }`: unit axes in Cesium's model frame and unscaled sizes.
  - `measureGlb(glb: Uint8Array): GlbAxes`. It throws `Error('not a glTF 2.0 GLB')` for other bytes. It refuses `extensionsRequired` (Draco, meshopt) and non-float positions.

- [ ] **Step 1: Copy the model**

Run from the repository root:

```bash
mkdir -p public/models
cp .planning/plans/assets/WP-V3/Cesium_Air.glb public/models/Cesium_Air.glb
shasum -a 256 public/models/Cesium_Air.glb
```

Expected: `e72f627c5f0c9dc50726059703df55d74e634a32dbccb25b18f1783f913360b8  public/models/Cesium_Air.glb` (586,652 bytes). The source and license are in the manifest and in "Calibration facts" above.

- [ ] **Step 2: Write the manifest**

File: `public/models/manifest.json`
```json
{
  "default": "cesium-air",
  "models": [
    {
      "id": "cesium-air",
      "uri": "models/Cesium_Air.glb",
      "license": "Apache-2.0: CesiumJS repository LICENSE.md (Copyright 2011-2026 CesiumJS Contributors); the model is not listed among that file's third-party example-application data",
      "author": "CesiumJS Contributors (Cesium GS, Inc.)",
      "source": "https://github.com/CesiumGS/cesium/blob/a6f0337f9fe56557c66cb7f6db0f0be422ed593e/Apps/SampleData/models/CesiumAir/Cesium_Air.glb",
      "forwardAxisFix": { "headingDeg": -90, "pitchDeg": 0, "rollDeg": 0 },
      "gearHeightM": 4.03,
      "lengthM": 37.57,
      "scale": 1.7555
    }
  ]
}
```

- [ ] **Step 3: Write the failing test**

```ts
// client/scene/model.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { Cartesian3, Matrix4 } from 'cesium'
import type { ModelManifest } from '../types.ts'
import { GLTF_TO_CESIUM, measureGlb } from './model.ts'

const root = new URL('../../', import.meta.url)
const manifest: ModelManifest = JSON.parse(readFileSync(new URL('public/models/manifest.json', root), 'utf8'))
const m = manifest.models.find((x) => x.id === manifest.default)!
const glbUrl = new URL(`public/${m.uri}`, root)
const axes = measureGlb(readFileSync(glbUrl))

const DEG = Math.PI / 180
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${msg} got ${a}, expected ${b} ± ${tol}`)

// ---------- the asset: where is the nose? ----------

test("Cesium's glTF axis correction: glTF +Z (front) → +X, +Y (up) → +Z, +X → +Y", () => {
  const map = (x: number, y: number, z: number): Cartesian3 => Matrix4.multiplyByPointAsVector(GLTF_TO_CESIUM, new Cartesian3(x, y, z), new Cartesian3())
  assert.ok(Cartesian3.equalsEpsilon(map(0, 0, 1), Cartesian3.UNIT_X, 1e-12))
  assert.ok(Cartesian3.equalsEpsilon(map(0, 1, 0), Cartesian3.UNIT_Z, 1e-12))
  assert.ok(Cartesian3.equalsEpsilon(map(1, 0, 0), Cartesian3.UNIT_Y, 1e-12))
})

test('measureGlb: Cesium_Air noses +X (fin at the tail), up +Z, right wing −Y', () => {
  assert.ok(Cartesian3.angleBetween(axes.nose, Cartesian3.UNIT_X) / DEG < 0.5, `nose ${axes.nose}`)
  assert.ok(Cartesian3.equalsEpsilon(axes.up, Cartesian3.UNIT_Z, 1e-12))
  assert.ok(Cartesian3.angleBetween(axes.right, new Cartesian3(0, -1, 0)) / DEG < 0.5, `right ${axes.right}`)
  near(axes.lengthM, 21.4, 0.01, 'length')
  near(axes.spanM, 25.74, 0.01, 'span')
  near(axes.belowOriginM, 2.296, 0.001, 'origin → wheels')
})

test('measureGlb rejects bytes that are not a GLB', () => {
  assert.throws(() => measureGlb(new TextEncoder().encode('{"asset":{"version":"2.0"},"nodes":[]}')), /GLB/)
})

test('manifest: default model exists, ≤ 5 MB, has provenance; scale, lengthM and gearHeightM match the geometry', () => {
  assert.ok(m, `default "${manifest.default}" is not in models`)
  assert.ok(statSync(glbUrl).size <= 5 * 1024 * 1024)
  for (const k of ['license', 'author', 'source'] as const) assert.ok(m[k].length > 0, k)
  near(axes.lengthM * m.scale, m.lengthM, 0.05, 'lengthM')
  near(axes.belowOriginM * m.scale, m.gearHeightM, 0.05, 'gearHeightM')
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `node --test client/scene/model.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/scene/model.ts' imported from …/client/scene/model.test.ts`, then `ℹ tests 1`, `ℹ fail 1`.

- [ ] **Step 5: Write the implementation**

```ts
// client/scene/model.ts
// WP-V3 model calibration: place the chase model so that its nose points along RenderState.headingDeg.
// The aircraft must never fly sideways. model.test.ts proves it from the GLB's own geometry.
import { Axis, Cartesian3, Matrix4, Quaternion } from 'cesium'

// ---------- glTF geometry in Cesium's model frame ----------

// Model applies this rotation to every glTF 2.0 asset before modelMatrix
// (ModelUtility.getAxisCorrectionMatrix(Axis.Y, Axis.Z) = Axis.Y_UP_TO_Z_UP · Axis.Z_UP_TO_X_UP):
// glTF +Z (the front, per the glTF spec) → +X, glTF +Y (up) → +Z, glTF +X → +Y.
// The Axis matrices exist at runtime but Cesium.d.ts does not declare them, hence the cast.
const axis = Axis as unknown as { Y_UP_TO_Z_UP: Matrix4; Z_UP_TO_X_UP: Matrix4 }
export const GLTF_TO_CESIUM: Matrix4 = Matrix4.multiplyTransformation(axis.Y_UP_TO_Z_UP, axis.Z_UP_TO_X_UP, new Matrix4())

/** A GLB measured in Cesium's model frame (after GLTF_TO_CESIUM, before scale). Axes are unit vectors. */
export interface GlbAxes {
  nose: Cartesian3
  up: Cartesian3
  right: Cartesian3 // nose × up
  lengthM: number // extent along nose
  spanM: number // extent along right
  belowOriginM: number // origin → lowest vertex (wheel bottom)
}

/**
 * Finds the nose from the geometry alone. Up is glTF +Y (the glTF spec). The vertical fin (every vertex in the top
 * quarter of the height) sits at the tail, so the nose is the horizontal direction from the fin's centroid to the
 * bounding-box centre.
 * ponytail: reads dense float VEC3 POSITION from the GLB's BIN chunk only, and refuses any extensionsRequired
 * (Draco, meshopt). Upgrade: decode through Cesium's GltfLoader if a compressed model is ever added.
 */
export function measureGlb(glb: Uint8Array): GlbAxes {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  if (glb.byteLength < 28 || dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(4, true) !== 2) {
    throw new Error('not a glTF 2.0 GLB')
  }
  const jsonLen = dv.getUint32(12, true)
  const gltf = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)))
  if (gltf.extensionsRequired?.length) throw new Error(`unsupported glTF extensions: ${gltf.extensionsRequired.join(', ')}`)
  const binStart = 20 + jsonLen + 8

  const pts: Cartesian3[] = []
  const visit = (i: number, parent: Matrix4): void => {
    const n = gltf.nodes[i]
    const local = n.matrix
      ? Matrix4.fromArray(n.matrix)
      : Matrix4.fromTranslationQuaternionRotationScale(
          Cartesian3.fromArray(n.translation ?? [0, 0, 0]),
          Quaternion.unpack(n.rotation ?? [0, 0, 0, 1]),
          Cartesian3.fromArray(n.scale ?? [1, 1, 1]),
        )
    const world = Matrix4.multiply(parent, local, new Matrix4())
    for (const prim of n.mesh === undefined ? [] : gltf.meshes[n.mesh].primitives) {
      const a = gltf.accessors[prim.attributes.POSITION]
      if (a.componentType !== 5126 || a.type !== 'VEC3' || a.sparse) throw new Error('POSITION must be dense float VEC3')
      const bv = gltf.bufferViews[a.bufferView]
      const stride = bv.byteStride ?? 12
      const base = binStart + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0)
      for (let k = 0; k < a.count; k++) {
        const o = base + k * stride
        const p = new Cartesian3(dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true))
        pts.push(Matrix4.multiplyByPoint(world, p, p))
      }
    }
    for (const c of n.children ?? []) visit(c, world)
  }
  for (const i of gltf.scenes[gltf.scene ?? 0].nodes) visit(i, GLTF_TO_CESIUM)

  let [xMin, xMax, yMin, yMax, zMin, zMax] = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity]
  for (const p of pts) {
    xMin = Math.min(xMin, p.x); xMax = Math.max(xMax, p.x)
    yMin = Math.min(yMin, p.y); yMax = Math.max(yMax, p.y)
    zMin = Math.min(zMin, p.z); zMax = Math.max(zMax, p.z)
  }
  const finZ = zMax - 0.25 * (zMax - zMin)
  let [fx, fy, nf] = [0, 0, 0]
  for (const p of pts) if (p.z >= finZ) { fx += p.x; fy += p.y; nf++ }
  const tailToCentre = new Cartesian3((xMin + xMax) / 2 - fx / nf, (yMin + yMax) / 2 - fy / nf, 0)
  const nose = Cartesian3.normalize(tailToCentre, new Cartesian3())
  const up = Cartesian3.clone(Cartesian3.UNIT_Z)
  const right = Cartesian3.cross(nose, up, new Cartesian3())
  const extent = (v: Cartesian3): number => {
    let [lo, hi] = [Infinity, -Infinity]
    for (const p of pts) { const d = Cartesian3.dot(p, v); lo = Math.min(lo, d); hi = Math.max(hi, d) }
    return hi - lo
  }
  return { nose, up, right, lengthM: extent(nose), spanM: extent(right), belowOriginM: -zMin }
}
```

- [ ] **Step 6: Run it to verify it passes**

Run: `node --test client/scene/model.test.ts`
Expected: PASS — `ℹ tests 4`, `ℹ pass 4`, `ℹ fail 0`.

- [ ] **Step 7: Commit**

```bash
git add public/models/Cesium_Air.glb public/models/manifest.json client/scene/model.ts client/scene/model.test.ts
git commit -m "feat(scene): Cesium Air model, manifest and GLB nose measurement" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Attitude calibration

**Files:**
- Modify: `client/scene/model.ts`, `client/scene/model.test.ts` (replace both whole files)
- Test: `client/scene/model.test.ts`

**Interfaces:**
- Consumes: `measureGlb`, `GlbAxes` (Task 1); `RenderState`, `ModelManifestEntry` (`client/types.ts`, WP-00); `Airport` (`shared/airports.ts`, WP-00); `bearingDeg` (`shared/geo.ts`, WP-00); `data/fixtures/golden/airports-sample.json` (WP-00)
- Produces (locked signatures from PLAN.md §4, plus optional trailing parameters):
  - `hprFor(state: RenderState, m: ModelManifestEntry, result?: HeadingPitchRoll): HeadingPitchRoll`
  - `modelMatrixFor(state: RenderState, m: ModelManifestEntry, result?: Matrix4): Matrix4`. The origin is at `(lat, lon, hM + gearHeightM)`, and `m.scale` is baked into the matrix. It returns `result` when one is given.
  - `noseAzimuthDeg(modelMatrix: Matrix4, noseAxis?: Cartesian3): number`. It returns degrees true in [0, 360). `noseAxis` defaults to +X (Cesium's model convention). Pass `measureGlb(glb).nose` to check one particular asset.
  - Calibration test: azimuth error ≤ 1° at headings 0, 90, 180, 270, 297.9 and 27.7, and at the KSFO 28L and 1R thresholds. Pitch +10° gives a nose ENU up component of sin 10° ± 0.01. Roll +20° gives a right-wing ENU up component < 0. The test measures directions with its own geodetic east/north/up formulas, not with Cesium's ENU helper.

- [ ] **Step 1: Write the failing test** (replace the whole file)

```ts
// client/scene/model.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { Cartesian3, Cartographic, HeadingPitchRoll, Math as CesiumMath, Matrix4, Transforms } from 'cesium'
import type { Airport } from '../../shared/airports.ts'
import { bearingDeg } from '../../shared/geo.ts'
import type { ModelManifest, RenderState } from '../types.ts'
import { GLTF_TO_CESIUM, hprFor, measureGlb, modelMatrixFor, noseAzimuthDeg } from './model.ts'

const root = new URL('../../', import.meta.url)
const manifest: ModelManifest = JSON.parse(readFileSync(new URL('public/models/manifest.json', root), 'utf8'))
const m = manifest.models.find((x) => x.id === manifest.default)!
const glbUrl = new URL(`public/${m.uri}`, root)
const axes = measureGlb(readFileSync(glbUrl))
const airports: Airport[] = JSON.parse(readFileSync(new URL('data/fixtures/golden/airports-sample.json', root), 'utf8'))
const KSFO = airports.find((a) => a.ident === 'KSFO')!

const DEG = Math.PI / 180
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${msg} got ${a}, expected ${b} ± ${tol}`)
const azErr = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180)

function state(lat: number, lon: number, hM: number, headingDeg: number, pitchDeg = 0, rollDeg = 0): RenderState {
  return {
    hex: 'abc123', lat, lon, hM, headingDeg, pitchDeg, rollDeg,
    gsKt: null, trackDeg: null, altBaroFt: null, vsFpm: null, mode: 'interp', altSource: 'geom',
    onGround: false, ageS: 0, quality: 'adsb2', callsign: null, typeCode: null,
  }
}

/** Model-frame direction v under modelMatrix, as unit [east, north, up]. Own geodetic formulas, not Cesium's ENU. */
function enu(mm: Matrix4, v: Cartesian3, latDeg: number, lonDeg: number): [number, number, number] {
  const w = Cartesian3.normalize(Matrix4.multiplyByPointAsVector(mm, v, new Cartesian3()), new Cartesian3())
  const [p, l] = [latDeg * DEG, lonDeg * DEG]
  const e = new Cartesian3(-Math.sin(l), Math.cos(l), 0)
  const n = new Cartesian3(-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p))
  const u = new Cartesian3(Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p))
  return [Cartesian3.dot(w, e), Cartesian3.dot(w, n), Cartesian3.dot(w, u)]
}
const azimuth = ([e, n]: [number, number, number]): number => (Math.atan2(e, n) / DEG + 360) % 360

// ---------- the asset: where is the nose? ----------

test("Cesium's glTF axis correction: glTF +Z (front) → +X, +Y (up) → +Z, +X → +Y", () => {
  const map = (x: number, y: number, z: number): Cartesian3 => Matrix4.multiplyByPointAsVector(GLTF_TO_CESIUM, new Cartesian3(x, y, z), new Cartesian3())
  assert.ok(Cartesian3.equalsEpsilon(map(0, 0, 1), Cartesian3.UNIT_X, 1e-12))
  assert.ok(Cartesian3.equalsEpsilon(map(0, 1, 0), Cartesian3.UNIT_Z, 1e-12))
  assert.ok(Cartesian3.equalsEpsilon(map(1, 0, 0), Cartesian3.UNIT_Y, 1e-12))
})

test('measureGlb: Cesium_Air noses +X (fin at the tail), up +Z, right wing −Y', () => {
  assert.ok(Cartesian3.angleBetween(axes.nose, Cartesian3.UNIT_X) / DEG < 0.5, `nose ${axes.nose}`)
  assert.ok(Cartesian3.equalsEpsilon(axes.up, Cartesian3.UNIT_Z, 1e-12))
  assert.ok(Cartesian3.angleBetween(axes.right, new Cartesian3(0, -1, 0)) / DEG < 0.5, `right ${axes.right}`)
  near(axes.lengthM, 21.4, 0.01, 'length')
  near(axes.spanM, 25.74, 0.01, 'span')
  near(axes.belowOriginM, 2.296, 0.001, 'origin → wheels')
})

test('measureGlb rejects bytes that are not a GLB', () => {
  assert.throws(() => measureGlb(new TextEncoder().encode('{"asset":{"version":"2.0"},"nodes":[]}')), /GLB/)
})

test('manifest: default model exists, ≤ 5 MB, has provenance; scale, lengthM and gearHeightM match the geometry', () => {
  assert.ok(m, `default "${manifest.default}" is not in models`)
  assert.ok(statSync(glbUrl).size <= 5 * 1024 * 1024)
  for (const k of ['license', 'author', 'source'] as const) assert.ok(m[k].length > 0, k)
  near(axes.lengthM * m.scale, m.lengthM, 0.05, 'lengthM')
  near(axes.belowOriginM * m.scale, m.gearHeightM, 0.05, 'gearHeightM')
})

// ---------- calibration: the gate G3 checks this is green ----------

test('Cesium convention: HeadingPitchRoll(0, 0, 0) points model +X east; +90° turns it south', () => {
  const p = Cartesian3.fromDegrees(KSFO.lon, KSFO.lat, 0)
  const at = (hDeg: number): number => azimuth(enu(Transforms.headingPitchRollToFixedFrame(p, new HeadingPitchRoll(hDeg * DEG, 0, 0)), Cartesian3.UNIT_X, KSFO.lat, KSFO.lon))
  near(at(0), 90, 1e-9)
  near(at(90), 180, 1e-9)
})

test('hprFor adds forwardAxisFix (−90° for a +X nose) to the state, in radians, with no sign flips', () => {
  assert.deepEqual(m.forwardAxisFix, { headingDeg: -90, pitchDeg: 0, rollDeg: 0 })
  const h = hprFor(state(0, 0, 0, 297.9, 3, -7), m)
  near(h.heading, (297.9 - 90) * DEG, 1e-12)
  near(h.pitch, 3 * DEG, 1e-12)
  near(h.roll, -7 * DEG, 1e-12)
})

for (const hdg of [0, 90, 180, 270, 297.9, 27.7]) {
  test(`heading ${hdg}°: nose azimuth within 1°`, () => {
    const s = state(KSFO.lat, KSFO.lon, 0, hdg)
    const mm = modelMatrixFor(s, m)
    const az = azimuth(enu(mm, axes.nose, s.lat, s.lon))
    assert.ok(azErr(az, hdg) <= 1, `measured nose at ${az}°`)
    assert.ok(azErr(noseAzimuthDeg(mm, axes.nose), hdg) <= 1)
    assert.ok(azErr(noseAzimuthDeg(mm), hdg) <= 1)
  })
}

for (const [ident, trueDeg] of [['28L', 297.9], ['1R', 27.7]] as const) {
  test(`KSFO ${ident} threshold: nose along the runway (${trueDeg}° true) within 1°`, () => {
    const r = KSFO.runways.find((x) => x.ends.some((e) => e.ident === ident))!
    const [thr, far] = r.ends[0].ident === ident ? r.ends : [r.ends[1], r.ends[0]]
    const brg = bearingDeg(thr.thrLat, thr.thrLon, far.thrLat, far.thrLon)
    near(brg, trueDeg, 0.1, 'fixture runway bearing')
    const s = state(thr.thrLat, thr.thrLon, thr.thrHaeM, brg)
    const mm = modelMatrixFor(s, m)
    const az = azimuth(enu(mm, axes.nose, s.lat, s.lon))
    assert.ok(azErr(az, brg) <= 1, `nose ${az}° vs runway ${brg}°`)
    assert.ok(azErr(noseAzimuthDeg(mm, axes.nose), brg) <= 1)
  })
}

test('pitch +10° → nose ENU up = sin 10° ± 0.01 and azimuth unchanged; −10° → nose down', () => {
  for (const hdg of [0, 90, 297.9]) {
    const mm = modelMatrixFor(state(KSFO.lat, KSFO.lon, 300, hdg, 10), m)
    const nose = enu(mm, axes.nose, KSFO.lat, KSFO.lon)
    near(nose[2], Math.sin(10 * DEG), 0.01, `heading ${hdg}: nose up`)
    assert.ok(azErr(azimuth(nose), hdg) <= 1)
  }
  assert.ok(enu(modelMatrixFor(state(KSFO.lat, KSFO.lon, 300, 90, -10), m), axes.nose, KSFO.lat, KSFO.lon)[2] < 0)
})

test('roll +20° → right wing ENU up < 0 (right wing down), nose level; −20° → right wing up', () => {
  for (const hdg of [0, 90, 297.9]) {
    const mm = modelMatrixFor(state(KSFO.lat, KSFO.lon, 300, hdg, 0, 20), m)
    const wing = enu(mm, axes.right, KSFO.lat, KSFO.lon)[2]
    assert.ok(wing < 0, `heading ${hdg}: right wing up component ${wing}`)
    near(wing, -Math.sin(20 * DEG), 0.01)
    near(enu(mm, axes.nose, KSFO.lat, KSFO.lon)[2], 0, 1e-6, 'nose level')
  }
  assert.ok(enu(modelMatrixFor(state(KSFO.lat, KSFO.lon, 300, 90, 0, -20), m), axes.right, KSFO.lat, KSFO.lon)[2] > 0)
})

test('modelMatrixFor: origin at lat/lon and hM + gearHeightM, scale baked in, result reused', () => {
  const out = new Matrix4()
  const mm = modelMatrixFor(state(37.6, -122.4, -28.3, 45, 5, 5), m, out)
  assert.equal(mm, out)
  const c = Cartographic.fromCartesian(Matrix4.getTranslation(mm, new Cartesian3()))
  near(CesiumMath.toDegrees(c.latitude), 37.6, 1e-9)
  near(CesiumMath.toDegrees(c.longitude), -122.4, 1e-9)
  near(c.height, -28.3 + m.gearHeightM, 1e-4)
  near(Matrix4.getMaximumScale(mm), m.scale, 1e-9)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/scene/model.test.ts`
Expected: FAIL — `SyntaxError: The requested module './model.ts' does not provide an export named 'hprFor'`, then `ℹ tests 1`, `ℹ fail 1`.

- [ ] **Step 3: Write the implementation** (replace the whole file)

```ts
// client/scene/model.ts
// WP-V3 model calibration: place the chase model so that its nose points along RenderState.headingDeg.
// The aircraft must never fly sideways. model.test.ts proves it from the GLB's own geometry.
import { Axis, Cartesian3, HeadingPitchRoll, Math as CesiumMath, Matrix4, Quaternion, Transforms } from 'cesium'
import type { ModelManifestEntry, RenderState } from '../types.ts'

// ---------- glTF geometry in Cesium's model frame ----------

// Model applies this rotation to every glTF 2.0 asset before modelMatrix
// (ModelUtility.getAxisCorrectionMatrix(Axis.Y, Axis.Z) = Axis.Y_UP_TO_Z_UP · Axis.Z_UP_TO_X_UP):
// glTF +Z (the front, per the glTF spec) → +X, glTF +Y (up) → +Z, glTF +X → +Y.
// The Axis matrices exist at runtime but Cesium.d.ts does not declare them, hence the cast.
const axis = Axis as unknown as { Y_UP_TO_Z_UP: Matrix4; Z_UP_TO_X_UP: Matrix4 }
export const GLTF_TO_CESIUM: Matrix4 = Matrix4.multiplyTransformation(axis.Y_UP_TO_Z_UP, axis.Z_UP_TO_X_UP, new Matrix4())

/** A GLB measured in Cesium's model frame (after GLTF_TO_CESIUM, before scale). Axes are unit vectors. */
export interface GlbAxes {
  nose: Cartesian3
  up: Cartesian3
  right: Cartesian3 // nose × up
  lengthM: number // extent along nose
  spanM: number // extent along right
  belowOriginM: number // origin → lowest vertex (wheel bottom)
}

/**
 * Finds the nose from the geometry alone. Up is glTF +Y (the glTF spec). The vertical fin (every vertex in the top
 * quarter of the height) sits at the tail, so the nose is the horizontal direction from the fin's centroid to the
 * bounding-box centre.
 * ponytail: reads dense float VEC3 POSITION from the GLB's BIN chunk only, and refuses any extensionsRequired
 * (Draco, meshopt). Upgrade: decode through Cesium's GltfLoader if a compressed model is ever added.
 */
export function measureGlb(glb: Uint8Array): GlbAxes {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  if (glb.byteLength < 28 || dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(4, true) !== 2) {
    throw new Error('not a glTF 2.0 GLB')
  }
  const jsonLen = dv.getUint32(12, true)
  const gltf = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)))
  if (gltf.extensionsRequired?.length) throw new Error(`unsupported glTF extensions: ${gltf.extensionsRequired.join(', ')}`)
  const binStart = 20 + jsonLen + 8

  const pts: Cartesian3[] = []
  const visit = (i: number, parent: Matrix4): void => {
    const n = gltf.nodes[i]
    const local = n.matrix
      ? Matrix4.fromArray(n.matrix)
      : Matrix4.fromTranslationQuaternionRotationScale(
          Cartesian3.fromArray(n.translation ?? [0, 0, 0]),
          Quaternion.unpack(n.rotation ?? [0, 0, 0, 1]),
          Cartesian3.fromArray(n.scale ?? [1, 1, 1]),
        )
    const world = Matrix4.multiply(parent, local, new Matrix4())
    for (const prim of n.mesh === undefined ? [] : gltf.meshes[n.mesh].primitives) {
      const a = gltf.accessors[prim.attributes.POSITION]
      if (a.componentType !== 5126 || a.type !== 'VEC3' || a.sparse) throw new Error('POSITION must be dense float VEC3')
      const bv = gltf.bufferViews[a.bufferView]
      const stride = bv.byteStride ?? 12
      const base = binStart + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0)
      for (let k = 0; k < a.count; k++) {
        const o = base + k * stride
        const p = new Cartesian3(dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true))
        pts.push(Matrix4.multiplyByPoint(world, p, p))
      }
    }
    for (const c of n.children ?? []) visit(c, world)
  }
  for (const i of gltf.scenes[gltf.scene ?? 0].nodes) visit(i, GLTF_TO_CESIUM)

  let [xMin, xMax, yMin, yMax, zMin, zMax] = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity]
  for (const p of pts) {
    xMin = Math.min(xMin, p.x); xMax = Math.max(xMax, p.x)
    yMin = Math.min(yMin, p.y); yMax = Math.max(yMax, p.y)
    zMin = Math.min(zMin, p.z); zMax = Math.max(zMax, p.z)
  }
  const finZ = zMax - 0.25 * (zMax - zMin)
  let [fx, fy, nf] = [0, 0, 0]
  for (const p of pts) if (p.z >= finZ) { fx += p.x; fy += p.y; nf++ }
  const tailToCentre = new Cartesian3((xMin + xMax) / 2 - fx / nf, (yMin + yMax) / 2 - fy / nf, 0)
  const nose = Cartesian3.normalize(tailToCentre, new Cartesian3())
  const up = Cartesian3.clone(Cartesian3.UNIT_Z)
  const right = Cartesian3.cross(nose, up, new Cartesian3())
  const extent = (v: Cartesian3): number => {
    let [lo, hi] = [Infinity, -Infinity]
    for (const p of pts) { const d = Cartesian3.dot(p, v); lo = Math.min(lo, d); hi = Math.max(hi, d) }
    return hi - lo
  }
  return { nose, up, right, lengthM: extent(nose), spanM: extent(right), belowOriginM: -zMin }
}

// ---------- attitude → Cesium ----------
//
// Cesium's conventions, read from the cesium 1.145 source (@cesium/engine Core/Quaternion.js fromHeadingPitchRoll and
// Core/Transforms.js headingPitchRollToFixedFrame): the matrix is ENU(origin) · Rz(−heading) · Ry(−pitch) · Rx(roll),
// with ENU x = east, y = north, z = up. In the model frame above (nose +X, left wing +Y, up +Z) that means:
// - heading 0 points the nose EAST, and positive heading turns it clockwise seen from above: azimuth = 90° + heading.
//   A model whose nose is +X therefore needs forwardAxisFix.headingDeg = −90.
// - positive pitch raises +X: nose up, the same sign as RenderState.pitchDeg.
// - positive roll lifts +Y (the left wing): right wing down, the same sign as RenderState.rollDeg.
// So hprFor only adds the fix. No sign is flipped.

/** Cesium HeadingPitchRoll (radians) for a RenderState: its attitude plus the model's forwardAxisFix. */
export function hprFor(state: RenderState, m: ModelManifestEntry, result: HeadingPitchRoll = new HeadingPitchRoll()): HeadingPitchRoll {
  const fix = m.forwardAxisFix
  result.heading = CesiumMath.toRadians(state.headingDeg + fix.headingDeg)
  result.pitch = CesiumMath.toRadians(state.pitchDeg + fix.pitchDeg)
  result.roll = CesiumMath.toRadians(state.rollDeg + fix.rollDeg)
  return result
}

const scratchPos = new Cartesian3()
const scratchHpr = new HeadingPitchRoll()

/**
 * World matrix of the chase model: origin at (lat, lon, hM + gearHeightM), attitude from hprFor, uniform m.scale
 * baked in (so ChaseModel leaves Model.scale at 1).
 * ponytail: hM is the wheel-bottom height in every phase, not only on the ground, so touchdown has no gear-height
 * step. Airborne, that bias is smaller than ADS-B's 25 ft altitude step. The offset runs along the ellipsoid normal,
 * not body-up, so at 10° pitch the wheels sit 0.06 m high. Upgrade: offset along body-up when M4 adds ground contact.
 */
export function modelMatrixFor(state: RenderState, m: ModelManifestEntry, result?: Matrix4): Matrix4 {
  const pos = Cartesian3.fromDegrees(state.lon, state.lat, state.hM + m.gearHeightM, undefined, scratchPos)
  const mm = Transforms.headingPitchRollToFixedFrame(pos, hprFor(state, m, scratchHpr), undefined, undefined, result ?? new Matrix4())
  return Matrix4.multiplyByUniformScale(mm, m.scale, mm)
}

const scratchOrigin = new Cartesian3()
const scratchEnu = new Matrix4()
const scratchDir = new Cartesian3()

/** A model-frame direction as a unit vector in ENU (x east, y north, z up) at the model's origin. */
function toEnu(modelMatrix: Matrix4, v: Cartesian3, result: Cartesian3): Cartesian3 {
  const origin = Matrix4.getTranslation(modelMatrix, scratchOrigin)
  const fixedToEnu = Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(origin, undefined, scratchEnu), scratchEnu)
  const world = Matrix4.multiplyByPointAsVector(modelMatrix, v, result)
  return Cartesian3.normalize(Matrix4.multiplyByPointAsVector(fixedToEnu, world, result), result)
}

/**
 * True azimuth of the model's nose in [0, 360), clockwise from north. noseAxis is the nose in Cesium's model frame:
 * +X by Cesium's convention, or measureGlb(glb).nose to check a particular asset.
 */
export function noseAzimuthDeg(modelMatrix: Matrix4, noseAxis: Cartesian3 = Cartesian3.UNIT_X): number {
  const f = toEnu(modelMatrix, noseAxis, scratchDir)
  return (CesiumMath.toDegrees(Math.atan2(f.x, f.y)) + 360) % 360
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/scene/model.test.ts`
Expected: PASS — `ℹ tests 17`, `ℹ pass 17`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add client/scene/model.ts client/scene/model.test.ts
git commit -m "feat(scene): model attitude calibration (hprFor, modelMatrixFor, noseAzimuthDeg)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: ChaseModel

**Files:**
- Modify: `client/scene/model.ts`, `client/scene/model.test.ts` (replace both whole files)
- Test: `client/scene/model.test.ts`

**Interfaces:**
- Consumes: `modelMatrixFor` (Task 2); Cesium `Model.fromGltfAsync`, `Viewer.scene.primitives`
- Produces: `class ChaseModel { constructor(viewer: Viewer, m: ModelManifestEntry, model: Model); static load(viewer: Viewer, m: ModelManifestEntry): Promise<ChaseModel>; update(state: RenderState): void; show: boolean; destroy(): void; readonly model: Model }`
  - `load` resolves `m.uri` against `import.meta.env.BASE_URL` (so `models/Cesium_Air.glb` → `/models/Cesium_Air.glb`) and uses `minimumPixelSize: 32`. It does not pass `scale` or `modelMatrix`: the scale is in `modelMatrixFor`, and `Model` clones its own identity matrix, which `update` then rewrites.
  - The constructor (use `load`; the test calls it with fakes) adds the model to `scene.primitives` hidden. `update` writes `modelMatrixFor(state, m, model.modelMatrix)` in place (Cesium's `Model.update` compares it with a cached copy every frame) and then applies `show`. `show = true` before the first `update` keeps the model hidden. `destroy` removes it, and `PrimitiveCollection` destroys what it removes.

- [ ] **Step 1: Write the failing test** (replace the whole file)

```ts
// client/scene/model.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { Cartesian3, Cartographic, HeadingPitchRoll, Math as CesiumMath, Matrix4, Transforms } from 'cesium'
import type { Model, Viewer } from 'cesium'
import type { Airport } from '../../shared/airports.ts'
import { bearingDeg } from '../../shared/geo.ts'
import type { ModelManifest, RenderState } from '../types.ts'
import { ChaseModel, GLTF_TO_CESIUM, hprFor, measureGlb, modelMatrixFor, noseAzimuthDeg } from './model.ts'

const root = new URL('../../', import.meta.url)
const manifest: ModelManifest = JSON.parse(readFileSync(new URL('public/models/manifest.json', root), 'utf8'))
const m = manifest.models.find((x) => x.id === manifest.default)!
const glbUrl = new URL(`public/${m.uri}`, root)
const axes = measureGlb(readFileSync(glbUrl))
const airports: Airport[] = JSON.parse(readFileSync(new URL('data/fixtures/golden/airports-sample.json', root), 'utf8'))
const KSFO = airports.find((a) => a.ident === 'KSFO')!

const DEG = Math.PI / 180
const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${msg} got ${a}, expected ${b} ± ${tol}`)
const azErr = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180)

function state(lat: number, lon: number, hM: number, headingDeg: number, pitchDeg = 0, rollDeg = 0): RenderState {
  return {
    hex: 'abc123', lat, lon, hM, headingDeg, pitchDeg, rollDeg,
    gsKt: null, trackDeg: null, altBaroFt: null, vsFpm: null, mode: 'interp', altSource: 'geom',
    onGround: false, ageS: 0, quality: 'adsb2', callsign: null, typeCode: null,
  }
}

/** Model-frame direction v under modelMatrix, as unit [east, north, up]. Own geodetic formulas, not Cesium's ENU. */
function enu(mm: Matrix4, v: Cartesian3, latDeg: number, lonDeg: number): [number, number, number] {
  const w = Cartesian3.normalize(Matrix4.multiplyByPointAsVector(mm, v, new Cartesian3()), new Cartesian3())
  const [p, l] = [latDeg * DEG, lonDeg * DEG]
  const e = new Cartesian3(-Math.sin(l), Math.cos(l), 0)
  const n = new Cartesian3(-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p))
  const u = new Cartesian3(Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p))
  return [Cartesian3.dot(w, e), Cartesian3.dot(w, n), Cartesian3.dot(w, u)]
}
const azimuth = ([e, n]: [number, number, number]): number => (Math.atan2(e, n) / DEG + 360) % 360

// ---------- the asset: where is the nose? ----------

test("Cesium's glTF axis correction: glTF +Z (front) → +X, +Y (up) → +Z, +X → +Y", () => {
  const map = (x: number, y: number, z: number): Cartesian3 => Matrix4.multiplyByPointAsVector(GLTF_TO_CESIUM, new Cartesian3(x, y, z), new Cartesian3())
  assert.ok(Cartesian3.equalsEpsilon(map(0, 0, 1), Cartesian3.UNIT_X, 1e-12))
  assert.ok(Cartesian3.equalsEpsilon(map(0, 1, 0), Cartesian3.UNIT_Z, 1e-12))
  assert.ok(Cartesian3.equalsEpsilon(map(1, 0, 0), Cartesian3.UNIT_Y, 1e-12))
})

test('measureGlb: Cesium_Air noses +X (fin at the tail), up +Z, right wing −Y', () => {
  assert.ok(Cartesian3.angleBetween(axes.nose, Cartesian3.UNIT_X) / DEG < 0.5, `nose ${axes.nose}`)
  assert.ok(Cartesian3.equalsEpsilon(axes.up, Cartesian3.UNIT_Z, 1e-12))
  assert.ok(Cartesian3.angleBetween(axes.right, new Cartesian3(0, -1, 0)) / DEG < 0.5, `right ${axes.right}`)
  near(axes.lengthM, 21.4, 0.01, 'length')
  near(axes.spanM, 25.74, 0.01, 'span')
  near(axes.belowOriginM, 2.296, 0.001, 'origin → wheels')
})

test('measureGlb rejects bytes that are not a GLB', () => {
  assert.throws(() => measureGlb(new TextEncoder().encode('{"asset":{"version":"2.0"},"nodes":[]}')), /GLB/)
})

test('manifest: default model exists, ≤ 5 MB, has provenance; scale, lengthM and gearHeightM match the geometry', () => {
  assert.ok(m, `default "${manifest.default}" is not in models`)
  assert.ok(statSync(glbUrl).size <= 5 * 1024 * 1024)
  for (const k of ['license', 'author', 'source'] as const) assert.ok(m[k].length > 0, k)
  near(axes.lengthM * m.scale, m.lengthM, 0.05, 'lengthM')
  near(axes.belowOriginM * m.scale, m.gearHeightM, 0.05, 'gearHeightM')
})

// ---------- calibration: the gate G3 checks this is green ----------

test('Cesium convention: HeadingPitchRoll(0, 0, 0) points model +X east; +90° turns it south', () => {
  const p = Cartesian3.fromDegrees(KSFO.lon, KSFO.lat, 0)
  const at = (hDeg: number): number => azimuth(enu(Transforms.headingPitchRollToFixedFrame(p, new HeadingPitchRoll(hDeg * DEG, 0, 0)), Cartesian3.UNIT_X, KSFO.lat, KSFO.lon))
  near(at(0), 90, 1e-9)
  near(at(90), 180, 1e-9)
})

test('hprFor adds forwardAxisFix (−90° for a +X nose) to the state, in radians, with no sign flips', () => {
  assert.deepEqual(m.forwardAxisFix, { headingDeg: -90, pitchDeg: 0, rollDeg: 0 })
  const h = hprFor(state(0, 0, 0, 297.9, 3, -7), m)
  near(h.heading, (297.9 - 90) * DEG, 1e-12)
  near(h.pitch, 3 * DEG, 1e-12)
  near(h.roll, -7 * DEG, 1e-12)
})

for (const hdg of [0, 90, 180, 270, 297.9, 27.7]) {
  test(`heading ${hdg}°: nose azimuth within 1°`, () => {
    const s = state(KSFO.lat, KSFO.lon, 0, hdg)
    const mm = modelMatrixFor(s, m)
    const az = azimuth(enu(mm, axes.nose, s.lat, s.lon))
    assert.ok(azErr(az, hdg) <= 1, `measured nose at ${az}°`)
    assert.ok(azErr(noseAzimuthDeg(mm, axes.nose), hdg) <= 1)
    assert.ok(azErr(noseAzimuthDeg(mm), hdg) <= 1)
  })
}

for (const [ident, trueDeg] of [['28L', 297.9], ['1R', 27.7]] as const) {
  test(`KSFO ${ident} threshold: nose along the runway (${trueDeg}° true) within 1°`, () => {
    const r = KSFO.runways.find((x) => x.ends.some((e) => e.ident === ident))!
    const [thr, far] = r.ends[0].ident === ident ? r.ends : [r.ends[1], r.ends[0]]
    const brg = bearingDeg(thr.thrLat, thr.thrLon, far.thrLat, far.thrLon)
    near(brg, trueDeg, 0.1, 'fixture runway bearing')
    const s = state(thr.thrLat, thr.thrLon, thr.thrHaeM, brg)
    const mm = modelMatrixFor(s, m)
    const az = azimuth(enu(mm, axes.nose, s.lat, s.lon))
    assert.ok(azErr(az, brg) <= 1, `nose ${az}° vs runway ${brg}°`)
    assert.ok(azErr(noseAzimuthDeg(mm, axes.nose), brg) <= 1)
  })
}

test('pitch +10° → nose ENU up = sin 10° ± 0.01 and azimuth unchanged; −10° → nose down', () => {
  for (const hdg of [0, 90, 297.9]) {
    const mm = modelMatrixFor(state(KSFO.lat, KSFO.lon, 300, hdg, 10), m)
    const nose = enu(mm, axes.nose, KSFO.lat, KSFO.lon)
    near(nose[2], Math.sin(10 * DEG), 0.01, `heading ${hdg}: nose up`)
    assert.ok(azErr(azimuth(nose), hdg) <= 1)
  }
  assert.ok(enu(modelMatrixFor(state(KSFO.lat, KSFO.lon, 300, 90, -10), m), axes.nose, KSFO.lat, KSFO.lon)[2] < 0)
})

test('roll +20° → right wing ENU up < 0 (right wing down), nose level; −20° → right wing up', () => {
  for (const hdg of [0, 90, 297.9]) {
    const mm = modelMatrixFor(state(KSFO.lat, KSFO.lon, 300, hdg, 0, 20), m)
    const wing = enu(mm, axes.right, KSFO.lat, KSFO.lon)[2]
    assert.ok(wing < 0, `heading ${hdg}: right wing up component ${wing}`)
    near(wing, -Math.sin(20 * DEG), 0.01)
    near(enu(mm, axes.nose, KSFO.lat, KSFO.lon)[2], 0, 1e-6, 'nose level')
  }
  assert.ok(enu(modelMatrixFor(state(KSFO.lat, KSFO.lon, 300, 90, 0, -20), m), axes.right, KSFO.lat, KSFO.lon)[2] > 0)
})

test('modelMatrixFor: origin at lat/lon and hM + gearHeightM, scale baked in, result reused', () => {
  const out = new Matrix4()
  const mm = modelMatrixFor(state(37.6, -122.4, -28.3, 45, 5, 5), m, out)
  assert.equal(mm, out)
  const c = Cartographic.fromCartesian(Matrix4.getTranslation(mm, new Cartesian3()))
  near(CesiumMath.toDegrees(c.latitude), 37.6, 1e-9)
  near(CesiumMath.toDegrees(c.longitude), -122.4, 1e-9)
  near(c.height, -28.3 + m.gearHeightM, 1e-4)
  near(Matrix4.getMaximumScale(mm), m.scale, 1e-9)
})

// ---------- ChaseModel (Model and Viewer faked: no WebGL in Node) ----------

function fakes(): { viewer: Viewer; added: unknown[]; model: { modelMatrix: Matrix4; show: boolean } } {
  const added: unknown[] = []
  const viewer = {
    scene: { primitives: { add: <T>(p: T): T => (added.push(p), p), remove: (p: unknown): boolean => added.splice(added.indexOf(p), 1).length === 1 } },
  } as unknown as Viewer
  return { viewer, added, model: { modelMatrix: new Matrix4(), show: true } }
}

test('ChaseModel: added hidden; update rewrites modelMatrix in place and shows it; show=false hides; destroy removes', () => {
  const f = fakes()
  const cm = new ChaseModel(f.viewer, m, f.model as unknown as Model)
  assert.deepEqual(f.added, [f.model])
  assert.equal(f.model.show, false)
  cm.show = true
  assert.equal(f.model.show, false, 'not shown before the first update (it would sit at the Earth centre)')

  const same = f.model.modelMatrix
  const s = state(KSFO.lat, KSFO.lon, 0, 297.9)
  cm.update(s)
  assert.equal(f.model.modelMatrix, same)
  assert.ok(Matrix4.equals(f.model.modelMatrix, modelMatrixFor(s, m)))
  assert.equal(f.model.show, true)

  cm.show = false
  cm.update(s)
  assert.equal(f.model.show, false)
  assert.equal(cm.show, false)
  cm.show = true
  assert.equal(f.model.show, true)

  cm.destroy()
  assert.deepEqual(f.added, [])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/scene/model.test.ts`
Expected: FAIL — `SyntaxError: The requested module './model.ts' does not provide an export named 'ChaseModel'`, then `ℹ tests 1`, `ℹ fail 1`.

- [ ] **Step 3: Write the implementation** (replace the whole file; this is the final version)

```ts
// client/scene/model.ts
// WP-V3 model calibration: place the chase model so that its nose points along RenderState.headingDeg.
// The aircraft must never fly sideways. model.test.ts proves it from the GLB's own geometry.
import { Axis, Cartesian3, HeadingPitchRoll, Math as CesiumMath, Matrix4, Model, Quaternion, Transforms } from 'cesium'
import type { Viewer } from 'cesium'
import type { ModelManifestEntry, RenderState } from '../types.ts'

// ---------- glTF geometry in Cesium's model frame ----------

// Model applies this rotation to every glTF 2.0 asset before modelMatrix
// (ModelUtility.getAxisCorrectionMatrix(Axis.Y, Axis.Z) = Axis.Y_UP_TO_Z_UP · Axis.Z_UP_TO_X_UP):
// glTF +Z (the front, per the glTF spec) → +X, glTF +Y (up) → +Z, glTF +X → +Y.
// The Axis matrices exist at runtime but Cesium.d.ts does not declare them, hence the cast.
const axis = Axis as unknown as { Y_UP_TO_Z_UP: Matrix4; Z_UP_TO_X_UP: Matrix4 }
export const GLTF_TO_CESIUM: Matrix4 = Matrix4.multiplyTransformation(axis.Y_UP_TO_Z_UP, axis.Z_UP_TO_X_UP, new Matrix4())

/** A GLB measured in Cesium's model frame (after GLTF_TO_CESIUM, before scale). Axes are unit vectors. */
export interface GlbAxes {
  nose: Cartesian3
  up: Cartesian3
  right: Cartesian3 // nose × up
  lengthM: number // extent along nose
  spanM: number // extent along right
  belowOriginM: number // origin → lowest vertex (wheel bottom)
}

/**
 * Finds the nose from the geometry alone. Up is glTF +Y (the glTF spec). The vertical fin (every vertex in the top
 * quarter of the height) sits at the tail, so the nose is the horizontal direction from the fin's centroid to the
 * bounding-box centre.
 * ponytail: reads dense float VEC3 POSITION from the GLB's BIN chunk only, and refuses any extensionsRequired
 * (Draco, meshopt). Upgrade: decode through Cesium's GltfLoader if a compressed model is ever added.
 */
export function measureGlb(glb: Uint8Array): GlbAxes {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  if (glb.byteLength < 28 || dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(4, true) !== 2) {
    throw new Error('not a glTF 2.0 GLB')
  }
  const jsonLen = dv.getUint32(12, true)
  const gltf = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)))
  if (gltf.extensionsRequired?.length) throw new Error(`unsupported glTF extensions: ${gltf.extensionsRequired.join(', ')}`)
  const binStart = 20 + jsonLen + 8

  const pts: Cartesian3[] = []
  const visit = (i: number, parent: Matrix4): void => {
    const n = gltf.nodes[i]
    const local = n.matrix
      ? Matrix4.fromArray(n.matrix)
      : Matrix4.fromTranslationQuaternionRotationScale(
          Cartesian3.fromArray(n.translation ?? [0, 0, 0]),
          Quaternion.unpack(n.rotation ?? [0, 0, 0, 1]),
          Cartesian3.fromArray(n.scale ?? [1, 1, 1]),
        )
    const world = Matrix4.multiply(parent, local, new Matrix4())
    for (const prim of n.mesh === undefined ? [] : gltf.meshes[n.mesh].primitives) {
      const a = gltf.accessors[prim.attributes.POSITION]
      if (a.componentType !== 5126 || a.type !== 'VEC3' || a.sparse) throw new Error('POSITION must be dense float VEC3')
      const bv = gltf.bufferViews[a.bufferView]
      const stride = bv.byteStride ?? 12
      const base = binStart + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0)
      for (let k = 0; k < a.count; k++) {
        const o = base + k * stride
        const p = new Cartesian3(dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true))
        pts.push(Matrix4.multiplyByPoint(world, p, p))
      }
    }
    for (const c of n.children ?? []) visit(c, world)
  }
  for (const i of gltf.scenes[gltf.scene ?? 0].nodes) visit(i, GLTF_TO_CESIUM)

  let [xMin, xMax, yMin, yMax, zMin, zMax] = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity]
  for (const p of pts) {
    xMin = Math.min(xMin, p.x); xMax = Math.max(xMax, p.x)
    yMin = Math.min(yMin, p.y); yMax = Math.max(yMax, p.y)
    zMin = Math.min(zMin, p.z); zMax = Math.max(zMax, p.z)
  }
  const finZ = zMax - 0.25 * (zMax - zMin)
  let [fx, fy, nf] = [0, 0, 0]
  for (const p of pts) if (p.z >= finZ) { fx += p.x; fy += p.y; nf++ }
  const tailToCentre = new Cartesian3((xMin + xMax) / 2 - fx / nf, (yMin + yMax) / 2 - fy / nf, 0)
  const nose = Cartesian3.normalize(tailToCentre, new Cartesian3())
  const up = Cartesian3.clone(Cartesian3.UNIT_Z)
  const right = Cartesian3.cross(nose, up, new Cartesian3())
  const extent = (v: Cartesian3): number => {
    let [lo, hi] = [Infinity, -Infinity]
    for (const p of pts) { const d = Cartesian3.dot(p, v); lo = Math.min(lo, d); hi = Math.max(hi, d) }
    return hi - lo
  }
  return { nose, up, right, lengthM: extent(nose), spanM: extent(right), belowOriginM: -zMin }
}

// ---------- attitude → Cesium ----------
//
// Cesium's conventions, read from the cesium 1.145 source (@cesium/engine Core/Quaternion.js fromHeadingPitchRoll and
// Core/Transforms.js headingPitchRollToFixedFrame): the matrix is ENU(origin) · Rz(−heading) · Ry(−pitch) · Rx(roll),
// with ENU x = east, y = north, z = up. In the model frame above (nose +X, left wing +Y, up +Z) that means:
// - heading 0 points the nose EAST, and positive heading turns it clockwise seen from above: azimuth = 90° + heading.
//   A model whose nose is +X therefore needs forwardAxisFix.headingDeg = −90.
// - positive pitch raises +X: nose up, the same sign as RenderState.pitchDeg.
// - positive roll lifts +Y (the left wing): right wing down, the same sign as RenderState.rollDeg.
// So hprFor only adds the fix. No sign is flipped.

/** Cesium HeadingPitchRoll (radians) for a RenderState: its attitude plus the model's forwardAxisFix. */
export function hprFor(state: RenderState, m: ModelManifestEntry, result: HeadingPitchRoll = new HeadingPitchRoll()): HeadingPitchRoll {
  const fix = m.forwardAxisFix
  result.heading = CesiumMath.toRadians(state.headingDeg + fix.headingDeg)
  result.pitch = CesiumMath.toRadians(state.pitchDeg + fix.pitchDeg)
  result.roll = CesiumMath.toRadians(state.rollDeg + fix.rollDeg)
  return result
}

const scratchPos = new Cartesian3()
const scratchHpr = new HeadingPitchRoll()

/**
 * World matrix of the chase model: origin at (lat, lon, hM + gearHeightM), attitude from hprFor, uniform m.scale
 * baked in (so ChaseModel leaves Model.scale at 1).
 * ponytail: hM is the wheel-bottom height in every phase, not only on the ground, so touchdown has no gear-height
 * step. Airborne, that bias is smaller than ADS-B's 25 ft altitude step. The offset runs along the ellipsoid normal,
 * not body-up, so at 10° pitch the wheels sit 0.06 m high. Upgrade: offset along body-up when M4 adds ground contact.
 */
export function modelMatrixFor(state: RenderState, m: ModelManifestEntry, result?: Matrix4): Matrix4 {
  const pos = Cartesian3.fromDegrees(state.lon, state.lat, state.hM + m.gearHeightM, undefined, scratchPos)
  const mm = Transforms.headingPitchRollToFixedFrame(pos, hprFor(state, m, scratchHpr), undefined, undefined, result ?? new Matrix4())
  return Matrix4.multiplyByUniformScale(mm, m.scale, mm)
}

const scratchOrigin = new Cartesian3()
const scratchEnu = new Matrix4()
const scratchDir = new Cartesian3()

/** A model-frame direction as a unit vector in ENU (x east, y north, z up) at the model's origin. */
function toEnu(modelMatrix: Matrix4, v: Cartesian3, result: Cartesian3): Cartesian3 {
  const origin = Matrix4.getTranslation(modelMatrix, scratchOrigin)
  const fixedToEnu = Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(origin, undefined, scratchEnu), scratchEnu)
  const world = Matrix4.multiplyByPointAsVector(modelMatrix, v, result)
  return Cartesian3.normalize(Matrix4.multiplyByPointAsVector(fixedToEnu, world, result), result)
}

/**
 * True azimuth of the model's nose in [0, 360), clockwise from north. noseAxis is the nose in Cesium's model frame:
 * +X by Cesium's convention, or measureGlb(glb).nose to check a particular asset.
 */
export function noseAzimuthDeg(modelMatrix: Matrix4, noseAxis: Cartesian3 = Cartesian3.UNIT_X): number {
  const f = toEnu(modelMatrix, noseAxis, scratchDir)
  return (CesiumMath.toDegrees(Math.atan2(f.x, f.y)) + 360) % 360
}

// ---------- the chased model in the scene ----------

/** Manifest uris are relative to public/, so they resolve against Vite's base URL ('/' in Node tests). */
function modelUrl(m: ModelManifestEntry): string {
  return `${import.meta.env?.BASE_URL ?? '/'}${m.uri}`
}

export class ChaseModel {
  readonly model: Model
  private readonly viewer: Viewer
  private readonly m: ModelManifestEntry
  private visible = true
  private placed = false

  /** Prefer ChaseModel.load. Adds the model to the scene hidden: it appears on the first update(), not at the Earth's centre. */
  constructor(viewer: Viewer, m: ModelManifestEntry, model: Model) {
    this.viewer = viewer
    this.m = m
    this.model = model
    model.show = false
    viewer.scene.primitives.add(model)
  }

  static async load(viewer: Viewer, m: ModelManifestEntry): Promise<ChaseModel> {
    // Model clones its own identity modelMatrix, which update() then rewrites. The scale is in modelMatrixFor, so
    // Model.scale stays 1. minimumPixelSize keeps a distant model visible.
    const model = await Model.fromGltfAsync({ url: modelUrl(m), minimumPixelSize: 32, show: false })
    return new ChaseModel(viewer, m, model)
  }

  /** Rewrites modelMatrix in place. Model.update compares it with its cached copy on the next frame. */
  update(state: RenderState): void {
    modelMatrixFor(state, this.m, this.model.modelMatrix)
    this.placed = true
    this.model.show = this.visible
  }

  get show(): boolean {
    return this.visible
  }

  set show(v: boolean) {
    this.visible = v
    this.model.show = v && this.placed
  }

  /** Removes the model from the scene. PrimitiveCollection destroys what it removes by default. */
  destroy(): void {
    this.viewer.scene.primitives.remove(this.model)
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/scene/model.test.ts`
Expected: PASS — `ℹ tests 18`, `ℹ pass 18`, `ℹ fail 0`.

- [ ] **Step 5: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/model'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 6: Commit**

```bash
git add client/scene/model.ts client/scene/model.test.ts
git commit -m "feat(scene): ChaseModel wraps a Cesium Model with in-place matrix updates" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Harness page

**Files:**
- Create: `harness/model.html`, `harness/model.ts`

**Interfaces:**
- Consumes: `ChaseModel`, `measureGlb`, `modelMatrixFor`, `noseAzimuthDeg` (Tasks 1–3); `bearingDeg`, `destination` (`shared/geo.ts`); `Airport` (`shared/airports.ts`); `ModelManifest`, `RenderState` (`client/types.ts`). At run time it fetches `/models/manifest.json`, the GLB and `/data/fixtures/golden/airports-sample.json` from the Vite dev server (the dev server serves the repository root).
- Produces: `/harness/model.html?view=overview|28L|1R|synthetic|pitch|roll[&table=0]` and `window.harness = { viewer, results, pass, views }` for scripted checks. The eight cases: KSFO 28L and 1R thresholds (heading = threshold-to-threshold bearing), synthetic headings 0/90/180/270 in a row south of 28L, and at 60 m HAE a model at pitch +10° and one at roll +20° (both heading 90°). Ellipsoid terrain and no imagery: the ground is HAE 0, so the ground cases use `hM = 0` and the wheels stand on it. This page checks orientation, not the datum.

- [ ] **Step 1: Write the page**

```html
<!-- harness/model.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Harness: model calibration</title>
    <style>
      html, body, #globe { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
      #panel { position: absolute; top: 8px; left: 8px; z-index: 1; max-width: calc(100% - 32px); padding: 6px 8px;
        font: 11px/1.35 ui-monospace, monospace; color: #fff; background: rgba(0, 0, 0, 0.7); }
      #panel button { font: inherit; margin: 0 4px 4px 0; }
      #table { margin: 0; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <div id="globe"></div>
    <div id="panel"><pre id="table">loading…</pre></div>
    <script type="module" src="./model.ts"></script>
  </body>
</html>
```

```ts
// harness/model.ts
// WP-V3 harness: /harness/model.html?view=overview|28L|1R|synthetic|pitch|roll[&table=0]
// The default chase model at the KSFO 28L and 1R thresholds (heading = runway bearing from the golden fixture), at
// 0/90/180/270°, and pitched +10° / rolled +20° in the air. Yellow arrows, labelled at the tip, point where each nose
// must point. The pale strips are the KSFO runways. Ellipsoid terrain and no imagery: the ground is HAE 0, so the
// ground models stand on it.
import { Cartesian2, Cartesian3, Color, EllipsoidTerrainProvider, Math as CesiumMath, PolylineArrowMaterialProperty, Viewer } from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import type { Airport } from '../shared/airports.ts'
import { bearingDeg, destination } from '../shared/geo.ts'
import type { ModelManifest, RenderState } from '../client/types.ts'
import { ChaseModel, measureGlb, modelMatrixFor, noseAzimuthDeg } from '../client/scene/model.ts'

interface Case { name: string; s: RenderState }
interface Result { name: string; headingDeg: number; noseDeg: number; errDeg: number }

const panel = document.getElementById('panel')!
const table = document.getElementById('table')!
const q = new URLSearchParams(location.search)

function at(name: string, p: { lat: number; lon: number }, hM: number, headingDeg: number, pitchDeg = 0, rollDeg = 0): Case {
  const s: RenderState = {
    hex: name, lat: p.lat, lon: p.lon, hM, headingDeg, pitchDeg, rollDeg,
    gsKt: null, trackDeg: null, altBaroFt: null, vsFpm: null, mode: 'interp', altSource: 'geom',
    onGround: hM === 0, ageS: 0, quality: 'adsb2', callsign: null, typeCode: null,
  }
  return { name, s }
}

try {
  const viewer = new Viewer('globe', {
    terrainProvider: new EllipsoidTerrainProvider(), baseLayer: false, baseLayerPicker: false, geocoder: false,
    timeline: false, animation: false, homeButton: false, sceneModePicker: false, navigationHelpButton: false,
    infoBox: false, selectionIndicator: false,
  })
  viewer.scene.globe.baseColor = Color.fromCssColorString('#2f3b34')

  const [manifest, airports] = await Promise.all([
    fetch('/models/manifest.json').then((r) => r.json() as Promise<ModelManifest>),
    fetch('/data/fixtures/golden/airports-sample.json').then((r) => r.json() as Promise<Airport[]>),
  ])
  const m = manifest.models.find((x) => x.id === manifest.default)!
  const axes = measureGlb(new Uint8Array(await (await fetch(`/${m.uri}`)).arrayBuffer()))
  const ksfo = airports.find((a) => a.ident === 'KSFO')!

  for (const r of ksfo.runways) {
    const positions = Cartesian3.fromDegreesArray([r.ends[0].lon, r.ends[0].lat, r.ends[1].lon, r.ends[1].lat])
    viewer.entities.add({ corridor: { positions, width: r.widthFt * 0.3048, material: Color.WHITE.withAlpha(0.3) } })
  }

  const threshold = (ident: string): Case => {
    const r = ksfo.runways.find((x) => x.ends.some((e) => e.ident === ident))!
    const [thr, far] = r.ends[0].ident === ident ? r.ends : [r.ends[1], r.ends[0]]
    return at(`KSFO ${ident}`, { lat: thr.thrLat, lon: thr.thrLon }, 0, bearingDeg(thr.thrLat, thr.thrLon, far.thrLat, far.thrLon))
  }
  const [t28L, t1R] = [threshold('28L'), threshold('1R')]
  const row0 = destination(t28L.s.lat, t28L.s.lon, 180, 0.35)
  const row = (i: number): { lat: number; lon: number } => destination(row0.lat, row0.lon, 90, 0.07 * i)
  const pitchCase = at('pitch +10', row(4), 60, 90, 10)
  const r5 = row(5)
  const rollCase = at('roll +20', destination(r5.lat, r5.lon, 180, 0.1), 60, 90, 0, 20) // off both views' sight lines
  const cases = [t28L, t1R, ...[0, 90, 180, 270].map((h, i) => at('synthetic', row(i), 0, h)), pitchCase, rollCase]

  const results: Result[] = []
  for (const c of cases) {
    ;(await ChaseModel.load(viewer, m)).update(c.s)
    const h = c.s.hM + m.gearHeightM
    const tip = destination(c.s.lat, c.s.lon, c.s.headingDeg, 60 / 1852)
    viewer.entities.add({
      polyline: {
        positions: Cartesian3.fromDegreesArrayHeights([c.s.lon, c.s.lat, h, tip.lon, tip.lat, h]),
        width: 14,
        material: new PolylineArrowMaterialProperty(Color.YELLOW),
      },
    })
    viewer.entities.add({
      position: Cartesian3.fromDegrees(tip.lon, tip.lat, h),
      label: {
        text: `${c.name} ${c.s.headingDeg.toFixed(1)}°`, font: '13px sans-serif', showBackground: true,
        pixelOffset: new Cartesian2(0, -16), disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
    const noseDeg = noseAzimuthDeg(modelMatrixFor(c.s, m), axes.nose)
    results.push({ name: c.name, headingDeg: c.s.headingDeg, noseDeg, errDeg: Math.abs(((noseDeg - c.s.headingDeg + 540) % 360) - 180) })
  }

  const look = (p: { lat: number; lon: number }, h: number, headingDeg: number, pitchDeg: number): void =>
    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(p.lon, p.lat, h),
      orientation: { heading: CesiumMath.toRadians(headingDeg), pitch: CesiumMath.toRadians(pitchDeg), roll: 0 },
    })
  const views: Record<string, () => void> = {
    overview: () => look({ lat: 37.606, lon: -122.365 }, 3000, 0, -90),
    '28L': () => look(t28L.s, 160, 0, -90),
    '1R': () => look(t1R.s, 160, 0, -90),
    synthetic: () => look(row(1.5), 500, 0, -90),
    pitch: () => look(destination(pitchCase.s.lat, pitchCase.s.lon, 180, 0.08), 64, 0, 0), // from the south: flies right
    roll: () => look(destination(rollCase.s.lat, rollCase.s.lon, 270, 0.05), 70, 90, -3), // from behind: right wing is screen-right
  }

  const pass = results.every((r) => r.errDeg <= 1)
  const v3 = (v: Cartesian3): string => [v.x, v.y, v.z].map((c) => +c.toFixed(3)).join(', ')
  table.textContent = [
    `model ${m.id}: measured nose (${v3(axes.nose)}), up (${v3(axes.up)}), length ${(axes.lengthM * m.scale).toFixed(2)} m`,
    'case          heading    nose     err',
    ...results.map((r) => `${r.name.padEnd(12)}${r.headingDeg.toFixed(1).padStart(9)}${r.noseDeg.toFixed(1).padStart(8)}${r.errDeg.toFixed(2).padStart(8)}`),
    pass ? 'PASS: every nose within 1° of its heading' : 'FAIL: a nose is more than 1° off its heading',
  ].join('\n')
  const toggle = (): void => void (table.hidden = !table.hidden)
  for (const [name, go] of [...Object.entries(views), ['table', toggle] as const]) {
    const b = document.createElement('button')
    b.textContent = name
    b.onclick = go
    panel.insertBefore(b, table)
  }
  table.hidden = q.get('table') === '0'
  ;(views[q.get('view') ?? 'overview'] ?? views.overview)()
  ;(window as unknown as { harness: unknown }).harness = { viewer, results, pass, views }
} catch (err) {
  table.textContent = `error: ${(err as Error).message}`
  table.style.color = '#ff8080'
}
```

- [ ] **Step 2: Type-check the page**

Run: `npx tsc --noEmit 2>&1 | grep -E 'harness/model'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Start the dev server**

Run: `npm run dev -- --port 5303 --strictPort`
Expected: `VITE v8.x ready`, `Local: http://localhost:5303/`.

- [ ] **Step 4: Look at it**

Open each URL. In a background tab the globe can stay black for 20–30 s while tiles load; the models appear first.
- `http://localhost:5303/harness/model.html`: a table with 8 rows (`KSFO 28L 297.9 297.9 0.00`, `KSFO 1R 27.7 27.7 0.00`, four `synthetic` rows, `pitch +10`, `roll +20`), the first line `model cesium-air: measured nose (1, 0, 0), up (0, 0, 1), length 37.57 m`, and the last line `PASS: every nose within 1° of its heading`. The console has no errors. `window.harness.pass` is `true`.
- `?view=28L&table=0` (top-down, north up): a pale runway strip runs WNW–ESE. The aircraft sits on it at the threshold with its nose to the WNW and its fin and tailplane to the ESE. The yellow arrow starts at the nose and runs along the strip to the label `KSFO 28L 297.9°`.
- `?view=1R&table=0`: the same along the NNE strip. The nose points NNE, and the arrow runs to `KSFO 1R 27.7°`.
- `?view=synthetic&table=0`: four aircraft in a row. Their arrows point north, east, south and west, each from the nose, with the tail on the opposite side.
- `?view=pitch&table=0` (from the south): the aircraft flies to the right (east), and the horizontal yellow arrow starts at its nose. The nose is slightly above the arrow line. The model's tail cone is upswept, so 10° looks smaller than it is; the unit test measures it.
- `?view=roll&table=0` (from behind, looking east): the wings slope down to the right, so the right wing is down, and the fin leans to the right.

Stop the server.

- [ ] **Step 5: Commit**

```bash
git add harness/model.html harness/model.ts
git commit -m "test(scene): model calibration harness (KSFO 28L/1R, synthetic headings, pitch, roll)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: WP gate

- [ ] **Step 1: This package's tests**

Run: `node --test client/scene/model.test.ts`
Expected: `ℹ tests 18`, `ℹ pass 18`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/scene/model|harness/model'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Full check in the worktree**

Run: `npm run check`
Expected: `tsc` prints nothing. On a worktree branched from `wave-0` the counts are `ℹ tests 59`, `ℹ pass 59`, `ℹ fail 0` (41 from WP-00 + 18 here).

- [ ] **Step 4: Confirm there is nothing left to commit**

Run: `git status --short`
Expected: no output.

## Notes for A2, G3 and M4

- **A2:** fetch `${import.meta.env.BASE_URL}models/manifest.json`, take the entry whose `id` equals `default`, call `await ChaseModel.load(viewer, entry)` once, then `update(state)` every frame for the chased aircraft. Set `show = false` when nothing is chased. A second model type later needs only a new manifest entry and its own `forwardAxisFix`; the test then measures that GLB when it is the default.
- **Heights:** `modelMatrixFor` treats `hM` as the height of the wheels, airborne too (the `ponytail:` note in `modelMatrixFor`). For ground states, I2/A2 should pass the runway or terrain HAE, not an altitude-derived value.
- **Attribution:** Apache-2.0 asks that users receive a copy of the license. Add a line such as "Cesium Air model © CesiumJS Contributors, Apache-2.0" to the attribution lines A2 passes to V6's `mountAttribution`. The license text ships in `node_modules/cesium/LICENSE.md`.
- **G3:** "V3 calibration test green" means `node --test client/scene/model.test.ts` passes.
- **minimumPixelSize:** because the scale is in `modelMatrix`, Cesium's minimum-pixel-size enlargement is multiplied by `m.scale`: a distant model draws at about 32 × 1.76 ≈ 56 px. Only the far view is affected. Pass the scale through `Model.scale` instead if that ever matters.
- **M4:** the wheel offset runs along the ellipsoid normal. At 10° pitch the wheels sit 0.06 m high. Move the offset to body-up when the ground-contact model arrives.

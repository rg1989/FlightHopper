# WP-V1 — Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read the client settings from the Vite environment and build the one Cesium `Viewer`. Terrain is switchable: Cesium World Terrain (ion), Re:Earth (keyless) or the bare ellipsoid. Imagery is switchable: Bing Maps (ion), EOX Sentinel-2 cloudless (keyless) or none. Without an ion token, everything works keyless.

**Architecture:** Four small modules.
- `client/config.ts` is pure and tested in Node. `readConfig(env)` reads `VITE_TERRAIN`, `VITE_IMAGERY`, `VITE_CESIUM_ION_TOKEN` and `VITE_API_BASE`. A blank value counts as unset, because Vite turns `VITE_X=` into `''`. Defaults: terrain is `ion` when a token is set, otherwise `reearth`. Imagery is `ion` when a token is set, otherwise `eox`. `apiBase` is `/api`, with trailing slashes removed. An unknown value throws and names the variable. `ion` without a token also throws, because Cesium would otherwise use its built-in evaluation token.
- `client/scene/terrain.ts`: `makeTerrain(cfg)` returns `createWorldTerrainAsync()` for `ion` (after it sets `Ion.defaultAccessToken`), `CesiumTerrainProvider.fromUrl(REEARTH_TERRAIN_URL)` for `reearth`, or `new EllipsoidTerrainProvider()`. All three put heights on the WGS84 ellipsoid (HAE), which is the datum of `RenderState.hM`. If the terrain service cannot be reached, the promise rejects. There is no silent fallback to the ellipsoid, because at KSFO that would put the ground 28 m above the runway heights.
- `client/scene/imagery.ts`: `makeImagery(cfg)` returns `createWorldImageryAsync()` for `ion` (Bing Maps Aerial), a `UrlTemplateImageryProvider` for EOX Sentinel-2 cloudless 2025 (`maximumLevel` 14, credit shown on screen), or `null` for `none`.
- `client/scene/viewer.ts`: `createViewer(el, cfg)` waits for both providers. Then it builds the `Viewer` with `baseLayer` (or `false`) and turns off the timeline, animation, geocoder, base layer picker, scene mode picker, navigation help, home button, info box and selection indicator. It sets `requestRenderMode: false` and `scene.globe.depthTestAgainstTerrain = true`. It imports Cesium's `widgets.css`, so callers do not have to.
- Consumer: A2 calls `createViewer(root, readConfig(import.meta.env))`. Vite 8's `ImportMetaEnv` type-checks against `Record<string, string | undefined>` (checked with `tsc`).

**Tech Stack:** Node ≥ 24.2 (native TypeScript), `node:test`, TypeScript 7 (type-check only), CesiumJS 1.145 (`createWorldTerrainAsync`, `createWorldImageryAsync`, `Ion.defaultAccessToken`, `CesiumTerrainProvider.fromUrl`, `UrlTemplateImageryProvider`, `ImageryLayer`, `Viewer`), Vite 8 (`import.meta.env`, CSS import, harness page). No new dependencies.

**Wave:** 1 (parallel; depends only on WP-00). **Estimated:** 1.5 h. **Validated:** on 2026-09-22 (Node v25.2.1, TypeScript 7.0.2, Vite 8.3.0, CesiumJS 1.145.0), every file below was run in the shared Wave 1 sandbox:
- `node --test client/config.test.ts` passed 9/9.
- `npx tsc --noEmit` reported no errors in `client/config*`, `client/scene/{viewer,terrain,imagery}.ts` or `harness/viewer.ts`.
- Each RED step below quotes the real output from a clean WP-00 tree.
- `harness/viewer.html` was checked in a browser under `vite --port 5301` with no token (so `reearth` + `eox`). KSFO rendered with EOX imagery, Re:Earth terrain and both credits. The console had no errors. The terrain height under the camera, over San Francisco Bay, was −32.29 m. That is the geoid there (EGM96 N = −32.3 m), which proves the terrain heights are ellipsoidal. At the thresholds, terrain − `thrHaeM` was −1.03 m (28R) and −0.39 m (10L), read with `globe.getHeight` on the loaded tiles. `?terrain=ellipsoid&imagery=none` gave a blue globe with `tilesLoaded: true`. `?terrain=ion` without a token showed the `readConfig` error. The `ion` branches were not run, because no token was available.
- The code blocks of this plan were then extracted into a clean WP-00 tree. There `npm test` reported 49/49 and `tsc --noEmit` was clean for the whole tree.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- **No paid services.** ion is used only with the user's own free Community token. Re:Earth and EOX are keyless. Limits are in "Sources" below.
- **Attribution** must be visible. Re:Earth serves its credit in `layer.json`, and Cesium shows it. The EOX licence requires the credit "legibly and in proximity to the usage", so it is an on-screen `Credit`. ion adds its own credits.
- **Heights** are WGS84 ellipsoidal metres (HAE) in every terrain option.
- **Tests never touch the network.** Tests may create the `ellipsoid`, `none` and `eox` providers, because those constructors make no requests. The `ion` and `reearth` branches are checked only in the harness.
- `viewer.ts` imports a `.css` file, and only Vite understands that import. Never import `viewer.ts` from a `*.test.ts`. The test imports `config.ts`, `terrain.ts` and `imagery.ts`. Importing `cesium` in Node takes about 0.4 s and makes no requests.
- Erasable TypeScript only, and relative imports have a `.ts` extension. This package creates or edits only the files below.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `client/config.ts` | `readConfig` |
| `client/config.test.ts` | `readConfig` rules; provider wiring for the offline branches |
| `client/scene/terrain.ts` | `REEARTH_TERRAIN_URL`, `makeTerrain` |
| `client/scene/imagery.ts` | `EOX_YEAR`, `EOX_URL`, `EOX_ATTRIBUTION`, `makeImagery` |
| `client/scene/viewer.ts` | `createViewer` |
| `harness/viewer.html`, `harness/viewer.ts` | eyeball page: `?terrain=&imagery=`, flies to KSFO |

## Sources (checked 2026-09-22)

| Fact | Source |
|---|---|
| Re:Earth terrain: keyless quantized-mesh at `https://terrain.reearth.land/cesium-mesh/ellipsoid`, used with `CesiumTerrainProvider.fromUrl`. Heights on the WGS84 ellipsoid (Mapterhorn DEM + EGM2008 geoid). DEM CC BY 4.0. Rate limits are "planned". | https://github.com/reearth/reearth-terrain |
| One `GET …/cesium-mesh/ellipsoid/layer.json` → 200, `format: quantized-mesh-1.0`, `scheme: tms`, `EPSG:4326`, `maxzoom: 14`, `extensions: [octvertexnormals, watermask]`, `access-control-allow-origin: *`. `attribution` lists Re:Earth Terrain, Mapterhorn, EGM2008 (NGA), Protomaps and OpenStreetMap. | the endpoint itself |
| EOX layers `s2cloudless-2017` … `s2cloudless-2025` (+ `_3857`) and `s2cloudless_3857` (2016). Template `…/wmts/1.0.0/<layer>/default/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.jpg`, tile matrix set `g` = GoogleMapsCompatible. Attribution in the layer abstract: "EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025)". | https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml |
| Licence: 2018–2025 layers CC BY-NC-SA 4.0 (non-commercial only); the 2016 layer CC BY 4.0. The attribution must be "displayed legibly and in proximity to the usage". Maximum request size 4096 px. | https://cloudless.eox.at/license-non-commercial |
| Older attribution wording, still on the 2024 release post: "Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024)". `s2maps.eu` now redirects (301) to `cloudless.eox.at/preview`. | https://eox.at/2025/03/sentinel-2-cloudless-2024/ |
| EOX serves 256 px JPEG tiles at KSFO up to z17 (checked z14–z17), but tiles shrink past z14 (14.2 → 5.7 kB): they are upsampled. Sentinel-2 is 10 m/px ≈ z14, so `maximumLevel: 14`. | 4 tile requests |
| Cesium 1.145: `createWorldTerrainAsync(options?): Promise<CesiumTerrainProvider>`, `Terrain.fromWorldTerrain(options?): Terrain` (not used: the contract returns a `TerrainProvider`), `createWorldImageryAsync({ style? }): Promise<IonImageryProvider>` ("ion's default global base imagery layer, currently Bing Maps"), `IonImageryProvider.fromAssetId`, `Ion.defaultAccessToken`, `Viewer.ConstructorOptions.baseLayer?: ImageryLayer \| false`. None is marked deprecated. | `node_modules/cesium/Source/Cesium.d.ts`; https://cesium.com/learn/cesiumjs/ref-doc/global.html#createWorldImageryAsync, https://cesium.com/learn/cesiumjs/ref-doc/Terrain.html#.fromWorldTerrain, https://cesium.com/learn/cesiumjs/ref-doc/Ion.html |
| Cesium ion Community plan: "For individual projects and evaluation", free. Storage 10 GB; streaming 15 GB/month; Global Imagery (Bing Maps, Google Maps) 1,000 sessions/month; Google Photorealistic 3D Tiles 1,000 root tiles/month; geocodes 50,000/month. For "non-commercial personal projects"; a paid plan is needed above $50K revenue or funding, for government projects, or above the limits. | https://cesium.com/platform/cesium-ion/pricing/ |

---

### Task 1: `readConfig`

**Files:**
- Create: `client/config.ts`, `client/config.test.ts`
- Test: `client/config.test.ts`

**Interfaces:**
- Consumes: `ClientConfig` from `client/types.ts` (WP-00): `{ terrain: 'ion' | 'reearth' | 'ellipsoid'; imagery: 'ion' | 'eox' | 'none'; ionToken: string | null; apiBase: string }`
- Produces: `readConfig(env: Record<string, string | undefined>): ClientConfig`

- [ ] **Step 1: Write the failing test**

```ts
// client/config.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readConfig } from './config.ts'

test('no env at all → keyless defaults (Re:Earth terrain, EOX imagery, /api)', () => {
  assert.deepEqual(readConfig({}), { terrain: 'reearth', imagery: 'eox', ionToken: null, apiBase: '/api' })
})

test('an ion token switches both defaults to ion', () => {
  assert.deepEqual(readConfig({ VITE_CESIUM_ION_TOKEN: 'tok' }), { terrain: 'ion', imagery: 'ion', ionToken: 'tok', apiBase: '/api' })
})

test('explicit choices win over the token-based defaults', () => {
  const c = readConfig({ VITE_CESIUM_ION_TOKEN: 'tok', VITE_TERRAIN: 'reearth', VITE_IMAGERY: 'none' })
  assert.equal(c.terrain, 'reearth')
  assert.equal(c.imagery, 'none')
  assert.equal(c.ionToken, 'tok')
  assert.equal(readConfig({ VITE_TERRAIN: 'ellipsoid' }).terrain, 'ellipsoid')
})

test('empty or blank values count as unset (Vite turns `VITE_X=` into "")', () => {
  assert.deepEqual(readConfig({ VITE_TERRAIN: '', VITE_IMAGERY: ' ', VITE_CESIUM_ION_TOKEN: '  ', VITE_API_BASE: '' }), readConfig({}))
  assert.equal(readConfig({ VITE_CESIUM_ION_TOKEN: ' tok ' }).ionToken, 'tok')
})

test('invalid values throw and name the variable', () => {
  assert.throws(() => readConfig({ VITE_TERRAIN: 'terrarium' }), /VITE_TERRAIN=terrarium/)
  assert.throws(() => readConfig({ VITE_IMAGERY: 'bing' }), /VITE_IMAGERY=bing/)
  assert.throws(() => readConfig({ VITE_TERRAIN: 'Ion', VITE_CESIUM_ION_TOKEN: 'tok' }), /ion \| reearth \| ellipsoid/)
})

test('ion without a token throws instead of silently using the Cesium evaluation token', () => {
  assert.throws(() => readConfig({ VITE_TERRAIN: 'ion' }), /VITE_CESIUM_ION_TOKEN/)
  assert.throws(() => readConfig({ VITE_IMAGERY: 'ion' }), /VITE_CESIUM_ION_TOKEN/)
})

test('apiBase: custom value kept, trailing slashes dropped', () => {
  assert.equal(readConfig({ VITE_API_BASE: 'https://fh.example.net/api/' }).apiBase, 'https://fh.example.net/api')
  assert.equal(readConfig({ VITE_API_BASE: '/api' }).apiBase, '/api')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/config.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '<repo>/client/config.ts' imported from <repo>/client/config.test.ts`, then `ℹ fail 1`.

- [ ] **Step 3: Write the implementation**

```ts
// client/config.ts
import type { ClientConfig } from './types.ts'

const TERRAINS: readonly ClientConfig['terrain'][] = ['ion', 'reearth', 'ellipsoid']
const IMAGERIES: readonly ClientConfig['imagery'][] = ['ion', 'eox', 'none']

/** Vite turns `VITE_X=` into '', so blank counts as unset. */
const val = (v: string | undefined): string | null => (v === undefined || v.trim() === '' ? null : v.trim())

function oneOf<T extends string>(name: string, v: string | null, allowed: readonly T[], fallback: T): T {
  if (v === null) return fallback
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`${name}=${v}: expected ${allowed.join(' | ')}`)
  return v as T
}

/**
 * Client settings from Vite env (pass `import.meta.env`) or any string map.
 * Without VITE_CESIUM_ION_TOKEN the defaults are keyless: Re:Earth terrain + EOX Sentinel-2 imagery.
 * Invalid values throw, and so does `ion` without a token: Cesium would otherwise fall back to its
 * built-in evaluation token, which is not ours to use.
 */
export function readConfig(env: Record<string, string | undefined>): ClientConfig {
  const ionToken = val(env.VITE_CESIUM_ION_TOKEN)
  const terrain = oneOf('VITE_TERRAIN', val(env.VITE_TERRAIN), TERRAINS, ionToken ? 'ion' : 'reearth')
  const imagery = oneOf('VITE_IMAGERY', val(env.VITE_IMAGERY), IMAGERIES, ionToken ? 'ion' : 'eox')
  if (!ionToken && (terrain === 'ion' || imagery === 'ion')) {
    throw new Error('VITE_TERRAIN/VITE_IMAGERY=ion needs VITE_CESIUM_ION_TOKEN (free Community token); or use reearth / eox')
  }
  const apiBase = (val(env.VITE_API_BASE) ?? '/api').replace(/\/+$/, '')
  return { terrain, imagery, ionToken, apiBase }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/config.test.ts`
Expected: PASS — `ℹ tests 7`, `ℹ pass 7`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add client/config.ts client/config.test.ts
git commit -m "feat(client): readConfig with keyless terrain/imagery defaults" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Terrain and imagery providers

**Files:**
- Create: `client/scene/terrain.ts`, `client/scene/imagery.ts`
- Modify: `client/config.test.ts` (adds two provider tests; complete file below)
- Test: `client/config.test.ts`

**Interfaces:**
- Consumes: `ClientConfig` (WP-00); `readConfig` (Task 1); Cesium `createWorldTerrainAsync`, `CesiumTerrainProvider.fromUrl`, `EllipsoidTerrainProvider`, `createWorldImageryAsync`, `UrlTemplateImageryProvider`, `Credit`, `Ion`
- Produces: `makeTerrain(cfg: ClientConfig): Promise<TerrainProvider>` · `makeImagery(cfg: ClientConfig): Promise<ImageryProvider | null>` · extra exports `REEARTH_TERRAIN_URL`, `EOX_YEAR`, `EOX_URL`, `EOX_ATTRIBUTION` (plain text, for V6's attribution lines)

- [ ] **Step 1: Write the failing test** (the complete file: Task 1's tests plus two provider tests)

```ts
// client/config.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EllipsoidTerrainProvider, UrlTemplateImageryProvider } from 'cesium'
import { readConfig } from './config.ts'
import { EOX_ATTRIBUTION, makeImagery } from './scene/imagery.ts'
import { makeTerrain } from './scene/terrain.ts'

test('no env at all → keyless defaults (Re:Earth terrain, EOX imagery, /api)', () => {
  assert.deepEqual(readConfig({}), { terrain: 'reearth', imagery: 'eox', ionToken: null, apiBase: '/api' })
})

test('an ion token switches both defaults to ion', () => {
  assert.deepEqual(readConfig({ VITE_CESIUM_ION_TOKEN: 'tok' }), { terrain: 'ion', imagery: 'ion', ionToken: 'tok', apiBase: '/api' })
})

test('explicit choices win over the token-based defaults', () => {
  const c = readConfig({ VITE_CESIUM_ION_TOKEN: 'tok', VITE_TERRAIN: 'reearth', VITE_IMAGERY: 'none' })
  assert.equal(c.terrain, 'reearth')
  assert.equal(c.imagery, 'none')
  assert.equal(c.ionToken, 'tok')
  assert.equal(readConfig({ VITE_TERRAIN: 'ellipsoid' }).terrain, 'ellipsoid')
})

test('empty or blank values count as unset (Vite turns `VITE_X=` into "")', () => {
  assert.deepEqual(readConfig({ VITE_TERRAIN: '', VITE_IMAGERY: ' ', VITE_CESIUM_ION_TOKEN: '  ', VITE_API_BASE: '' }), readConfig({}))
  assert.equal(readConfig({ VITE_CESIUM_ION_TOKEN: ' tok ' }).ionToken, 'tok')
})

test('invalid values throw and name the variable', () => {
  assert.throws(() => readConfig({ VITE_TERRAIN: 'terrarium' }), /VITE_TERRAIN=terrarium/)
  assert.throws(() => readConfig({ VITE_IMAGERY: 'bing' }), /VITE_IMAGERY=bing/)
  assert.throws(() => readConfig({ VITE_TERRAIN: 'Ion', VITE_CESIUM_ION_TOKEN: 'tok' }), /ion \| reearth \| ellipsoid/)
})

test('ion without a token throws instead of silently using the Cesium evaluation token', () => {
  assert.throws(() => readConfig({ VITE_TERRAIN: 'ion' }), /VITE_CESIUM_ION_TOKEN/)
  assert.throws(() => readConfig({ VITE_IMAGERY: 'ion' }), /VITE_CESIUM_ION_TOKEN/)
})

test('apiBase: custom value kept, trailing slashes dropped', () => {
  assert.equal(readConfig({ VITE_API_BASE: 'https://fh.example.net/api/' }).apiBase, 'https://fh.example.net/api')
  assert.equal(readConfig({ VITE_API_BASE: '/api' }).apiBase, '/api')
})

// Provider wiring for the branches that need no network. ion and reearth are checked in harness/viewer.html.
test('offline branches: ellipsoid terrain, no imagery', async () => {
  const cfg = readConfig({ VITE_TERRAIN: 'ellipsoid', VITE_IMAGERY: 'none' })
  assert.ok((await makeTerrain(cfg)) instanceof EllipsoidTerrainProvider)
  assert.equal(await makeImagery(cfg), null)
})

test('EOX imagery: Sentinel-2 cloudless WebMercator template, native zoom cap, attribution on screen', async () => {
  const p = await makeImagery(readConfig({}))
  assert.ok(p instanceof UrlTemplateImageryProvider)
  assert.equal(p.url, 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg')
  assert.equal(p.maximumLevel, 14)
  assert.equal(p.credit.showOnScreen, true)
  assert.match(p.credit.html, /by EOX IT Services GmbH \(Contains modified Copernicus Sentinel data 2025\)/)
  assert.equal(EOX_ATTRIBUTION, 'EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025)')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/config.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '<repo>/client/scene/imagery.ts' imported from <repo>/client/config.test.ts`, then `ℹ fail 1`.

- [ ] **Step 3: Write the implementation**

```ts
// client/scene/terrain.ts
import { CesiumTerrainProvider, EllipsoidTerrainProvider, Ion, createWorldTerrainAsync, type TerrainProvider } from 'cesium'
import type { ClientConfig } from '../types.ts'

/**
 * Re:Earth Terrain: keyless quantized-mesh-1.0 with heights on the WGS84 ellipsoid
 * (Mapterhorn DEM + EGM2008 geoid, blended server-side). Its layer.json carries the attribution,
 * which Cesium shows as a credit. Source: https://github.com/reearth/reearth-terrain
 * Checked 2026-09-22: GET <url>/layer.json → 200, format quantized-mesh-1.0, maxzoom 14,
 * extensions octvertexnormals + watermask, CORS *.
 */
export const REEARTH_TERRAIN_URL = 'https://terrain.reearth.land/cesium-mesh/ellipsoid'

/**
 * Terrain for the configured source. All three put heights on the WGS84 ellipsoid (HAE), like RenderState.hM.
 * ion = Cesium World Terrain (asset 1; Community plan, 15 GB/month streaming).
 * Rejects when the terrain service cannot be reached: a scene on the wrong datum is worse than none.
 */
export async function makeTerrain(cfg: ClientConfig): Promise<TerrainProvider> {
  if (cfg.terrain === 'ion') {
    if (cfg.ionToken) Ion.defaultAccessToken = cfg.ionToken
    return createWorldTerrainAsync()
  }
  if (cfg.terrain === 'reearth') return CesiumTerrainProvider.fromUrl(REEARTH_TERRAIN_URL)
  return new EllipsoidTerrainProvider()
}
```

```ts
// client/scene/imagery.ts
import { Credit, Ion, UrlTemplateImageryProvider, createWorldImageryAsync, type ImageryProvider } from 'cesium'
import type { ClientConfig } from '../types.ts'

// EOxCloudless (Sentinel-2 cloudless) by EOX: keyless WMTS in WebMercator (tile matrix set 'g').
// Layers and attribution text: https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml (checked 2026-09-22).
// Licence: https://cloudless.eox.at/license-non-commercial — the 2018–2025 layers are CC BY-NC-SA 4.0
// (non-commercial only). The 2016 layer `s2cloudless_3857` is CC BY 4.0. The attribution must be legible
// and near the map, so the credit is shown on screen.
// ponytail: newest non-commercial layer; the commercial path is the 2016 CC BY layer or an EOX commercial licence.
export const EOX_YEAR = 2025
export const EOX_URL = `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${EOX_YEAR}_3857/default/g/{z}/{y}/{x}.jpg`
export const EOX_ATTRIBUTION = `EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data ${EOX_YEAR})`

/**
 * Base imagery for the configured source, or null for none.
 * ion = Bing Maps Aerial via ion (Community plan: 1,000 imagery sessions/month).
 */
export async function makeImagery(cfg: ClientConfig): Promise<ImageryProvider | null> {
  if (cfg.imagery === 'ion') {
    if (cfg.ionToken) Ion.defaultAccessToken = cfg.ionToken
    return createWorldImageryAsync()
  }
  if (cfg.imagery === 'eox') {
    return new UrlTemplateImageryProvider({
      url: EOX_URL,
      // Sentinel-2 is 10 m/px ≈ zoom 14. EOX serves deeper tiles, but they are only upsampled,
      // so stopping here saves requests; Cesium upsamples on the client.
      maximumLevel: 14,
      credit: new Credit(EOX_ATTRIBUTION.replace('https://cloudless.eox.at', '<a href="https://cloudless.eox.at" target="_blank">$&</a>'), true),
    })
  }
  return null
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/config.test.ts`
Expected: PASS — `ℹ tests 9`, `ℹ pass 9`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add client/scene/terrain.ts client/scene/imagery.ts client/config.test.ts
git commit -m "feat(scene): ion / Re:Earth / ellipsoid terrain and ion / EOX imagery providers" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `createViewer` and the harness page

**Files:**
- Create: `harness/viewer.html`, `harness/viewer.ts`, `client/scene/viewer.ts`
- Test: `npx tsc --noEmit` (the harness is the first consumer of `createViewer`), then the harness page in a browser

**Interfaces:**
- Consumes: `readConfig` (Task 1), `makeTerrain`, `makeImagery` (Task 2), `ClientConfig` (WP-00); Cesium `Viewer`, `ImageryLayer`, `cesium/Build/Cesium/Widgets/widgets.css`; `CESIUM_BASE_URL` and `/cesiumStatic` from WP-00's `vite.config.ts`
- Produces: `createViewer(el: HTMLElement | string, cfg: ClientConfig): Promise<Viewer>` · harness page `/harness/viewer.html?terrain=<ion|reearth|ellipsoid>&imagery=<ion|eox|none>` that sets `window.harness = { viewer }`

- [ ] **Step 1: Write the harness first (it is the first consumer of `createViewer`)**

```html
<!-- harness/viewer.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Harness: viewer</title>
    <style>
      html, body, #globe { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
      #status { position: absolute; top: 8px; left: 8px; z-index: 1; max-width: calc(100% - 32px); padding: 6px 8px;
        font: 12px/1.4 ui-monospace, monospace; color: #fff; background: rgba(0, 0, 0, 0.65); white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <div id="globe"></div>
    <div id="status">loading…</div>
    <script type="module" src="./viewer.ts"></script>
  </body>
</html>
```

```ts
// harness/viewer.ts
// WP-V1 harness: /harness/viewer.html?terrain=reearth&imagery=eox builds the viewer from readConfig and flies to KSFO.
// Query params override VITE_TERRAIN / VITE_IMAGERY. The token only ever comes from .env.local, never from the URL.
import { Cartesian3, Math as CesiumMath, type Viewer } from 'cesium'
import { readConfig } from '../client/config.ts'
import { createViewer } from '../client/scene/viewer.ts'

const status = document.getElementById('status')!
const q = new URLSearchParams(location.search)

try {
  const cfg = readConfig({
    VITE_TERRAIN: q.get('terrain') ?? import.meta.env.VITE_TERRAIN,
    VITE_IMAGERY: q.get('imagery') ?? import.meta.env.VITE_IMAGERY,
    VITE_CESIUM_ION_TOKEN: import.meta.env.VITE_CESIUM_ION_TOKEN,
    VITE_API_BASE: import.meta.env.VITE_API_BASE,
  })
  const viewer = await createViewer('globe', cfg)
  ;(window as unknown as { harness: { viewer: Viewer } }).harness = { viewer }
  // East of KSFO over the bay, looking up runways 28L/28R (true heading 298°).
  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(-122.335, 37.598, 600),
    orientation: { heading: CesiumMath.toRadians(298), pitch: CesiumMath.toRadians(-12), roll: 0 },
    duration: 0,
  })
  const shown = { terrain: cfg.terrain, imagery: cfg.imagery, ionToken: cfg.ionToken ? 'set' : null, apiBase: cfg.apiBase }
  viewer.scene.postRender.addEventListener(() => {
    status.textContent = `${JSON.stringify(shown)}\ntilesLoaded: ${viewer.scene.globe.tilesLoaded}`
  })
} catch (err) {
  status.textContent = `error: ${(err as Error).message}`
  status.style.color = '#ff8080'
}
```

- [ ] **Step 2: Type-check to verify it fails**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/config|client/scene/(viewer|terrain|imagery)|harness/viewer'`
Expected: `harness/viewer.ts(6,30): error TS2307: Cannot find module '../client/scene/viewer.ts' or its corresponding type declarations.`

- [ ] **Step 3: Write the implementation**

```ts
// client/scene/viewer.ts
import { ImageryLayer, Viewer } from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import type { ClientConfig } from '../types.ts'
import { makeImagery } from './imagery.ts'
import { makeTerrain } from './terrain.ts'

/**
 * The one Cesium Viewer: configured terrain + imagery, no stock widgets except fullscreen and the credits.
 * The app has its own HUD and picking, so infoBox and selectionIndicator are off too.
 * depthTestAgainstTerrain hides aircraft and runway planes behind hills.
 */
export async function createViewer(el: HTMLElement | string, cfg: ClientConfig): Promise<Viewer> {
  const [terrainProvider, imagery] = await Promise.all([makeTerrain(cfg), makeImagery(cfg)])
  const viewer = new Viewer(el, {
    terrainProvider,
    baseLayer: imagery ? new ImageryLayer(imagery) : false,
    timeline: false,
    animation: false,
    geocoder: false,
    baseLayerPicker: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    homeButton: false,
    infoBox: false,
    selectionIndicator: false,
    requestRenderMode: false,
  })
  viewer.scene.globe.depthTestAgainstTerrain = true
  return viewer
}
```

- [ ] **Step 4: Type-check to verify it passes**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/config|client/scene/(viewer|terrain|imagery)|harness/viewer'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 5: Eyeball the harness**

Run: `npx vite --port 5301 --strictPort`, then open these pages. Wait a few seconds for tiles on each.
- `http://localhost:5301/harness/viewer.html?terrain=reearth&imagery=eox`. Expected: KSFO seen from the east over the bay, looking up runways 28L/28R, with EOX imagery and hills behind. The status box shows `{"terrain":"reearth","imagery":"eox","ionToken":null,"apiBase":"/api"}` and then `tilesLoaded: true`. The credit bar shows the EOxCloudless line and a "Data attribution" link that lists the Re:Earth credits. The console has no errors. In the console, `harness.viewer.scene.globe.getHeight(harness.viewer.camera.positionCartographic)` returns about −32.3: the bay surface is at the geoid, so the terrain heights are ellipsoidal.
- `http://localhost:5301/harness/viewer.html?terrain=ellipsoid&imagery=none`. Expected: a plain blue globe, then `tilesLoaded: true`.
- `http://localhost:5301/harness/viewer.html?terrain=ion`. Expected without `VITE_CESIUM_ION_TOKEN`: the status box turns red with `error: VITE_TERRAIN/VITE_IMAGERY=ion needs VITE_CESIUM_ION_TOKEN (free Community token); or use reearth / eox`.
- Only when `.env.local` has a token: `http://localhost:5301/harness/viewer.html?terrain=ion&imagery=ion`. Expected: Cesium World Terrain and Bing imagery with the Cesium ion and Bing credits.

Stop the server.

- [ ] **Step 6: Commit**

```bash
git add client/scene/viewer.ts harness/viewer.html harness/viewer.ts
git commit -m "feat(scene): createViewer (depth test against terrain, no stock widgets) with harness page" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: WP gate

- [ ] **Step 1: This package's tests**

Run: `node --test client/config.test.ts`
Expected: `ℹ tests 9`, `ℹ pass 9`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/config|client/scene/(viewer|terrain|imagery)|harness/viewer'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Full check in the worktree**

Run: `npm run check`
Expected: `tsc` prints nothing. On a worktree branched from `wave-0` the counts are `ℹ tests 50`, `ℹ pass 50`, `ℹ fail 0` (41 from WP-00 + 9 here).

- [ ] **Step 4: Confirm there is nothing left to commit**

Run: `git status --short`
Expected: no output.

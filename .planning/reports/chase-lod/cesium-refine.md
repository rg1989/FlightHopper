# Complaint 2: why ground refinement "pops", and how to make it gradual cheaply

Scope: CesiumJS 1.145 (`cesium` 1.145.0, `@cesium/engine` 26.3.0). Paths below are relative to
`node_modules/@cesium/engine/Source/` unless stated. This is research only. I edited no repo files.

---

## 0. Summary

- **The pop is almost entirely an imagery-texture swap.** When a finer imagery tile finishes loading,
  `TileImagery.processStateMachine` replaces the ancestor texture with the new one in a single frame
  (`Scene/TileImagery.js:60-69`). The draw loop then binds the new texture with alpha = layer alpha = 1
  (`Scene/GlobeSurfaceTileProvider.js:3035-3044`). Nothing in the globe path fades, morphs or blends
  between LODs (§F). The "square/rectangle" is the footprint of one Web-Mercator imagery tile clipped
  to one geographic terrain tile (`ImageryLayer.js:956-1044`).
- **Each pop covers a big area and doubles the sharpness.** At 32°N, terrain level L uses imagery
  level L+1 (§1.4). With SSE 2 px, a tile refines when it is roughly 1/6 to 1/3 of the screen width.
  The texel size drops from about 1.7 px to about 0.85 px at that moment, and the Esri source/colour
  often changes between zoom levels too. When loading lags several levels (turns, orbiting,
  evicted tiles), the jump is 4× to 16× and looks violent.
- **Terrain geometry pops are secondary.** Re:Earth stops at z14, so every tile past level 14 is
  upsampled from its parent, with the same surface and normals (`GlobeSurfaceTile.js:746-756, 831-880`).
  In chase view the whole near and middle field (up to about 5 km) is therefore imagery-only. Real
  mesh swaps happen farther out, and by construction they are at most about 2 px vertically. The
  visible part of a mesh swap is the lighting: new vertex normals change slope shading. That, plus
  flat-lit "fill" tiles, is the likely cause of complaint 1's "shadows rendering".
- **Best combination (cinematic, gradual, cheap):**
  1. **A: a per-tile imagery cross-fade, done as an app-side monkey-patch** of the exported
     `TileImagery.prototype.processStateMachine` and `GlobeSurfaceTileProvider.prototype.endUpdate`.
     It keeps the old ancestor texture underneath and ramps the new texture's alpha from 0 to 1 over
     about 0.5 s. Cost: one extra texture fetch, only on tiles that are fading (a few percent of the
     screen). No extra draw commands. About 50 lines, no fork.
  2. **D: tuning, so less lag means smaller jumps.** Raise `globe.tileCacheSize` (100 → about 400–600),
     set `globe.preloadSiblings = true`, and raise `RequestScheduler.requestsByServer` for the Esri
     and Re:Earth hosts (18 → about 32/24). Keep `maximumScreenSpaceError = 2` and
     `loadingDescendantLimit = 20`.
  3. **E: a little more haze.** Raise `scene.fog.visualDensityScalar` (0.15 → about 0.3) and optionally
     `scene.fog.screenSpaceErrorFactor` (2 → 3 or 4). Far pops fade into the haze, and the second knob
     *removes* far tiles, which improves FPS. No new shader cost: the FOG path already runs.
  - Terrain geomorphing (B) is not feasible without forking Cesium and its prebuilt workers. It would
    also buy little, because geometry pops are about 2 px and absent past z14.

---

## 1. What happens, step by step, when a globe tile refines

### 1.1 Selection: `Scene/QuadtreePrimitive.js`

- Frame order: `beginFrame` clears the load queues (330-352). `render` runs `beginUpdate`, then
  `selectTilesForRendering`, then `createRenderCommandsForSelectedTiles` (which calls
  `showTileThisFrame`), then `endUpdate` (358-369). `endFrame` runs `processTileLoadQueue` (435-447).
  **So loading, including the texture swap, happens after drawing. A swap made in frame N first shows
  in frame N+1.**
- SSE: `error = maxGeometricError * drawingBufferHeight / (distance * sseDenominator)`, minus
  `fog(distance, density) * fog.sse`, then divided by pixelRatio (1248-1274). A tile meets the SSE when
  `error < maximumScreenSpaceError`, which is 2 by default (110, 732-734).
- `visitTile` (714-987):
  - If this tile meets the SSE (or `ancestorMeetsSse`), it is drawn if any of these holds
    (766-784): (1) it was rendered or kicked last frame; (2) it was culled or not visited last
    frame; (3) it is fully loaded (`DONE`); (4) `canRenderWithoutLosingDetail`
    (GlobeSurfaceTileProvider 930-1042).
  - Otherwise it keeps rendering the more detailed descendants and loads this "blocker" with high
    priority (820-825).
  - If the SSE is not met and `canRefine` holds (GlobeSurfaceTileProvider 903-920), it visits the
    children near to far (869-889). One exception: if all four children are
    `upsampledFromParent`, it renders itself (828-867).
  - **Kicking (904-963):** if some selected descendants are not renderable and none were rendered
    last frame, the descendants are removed from the render list and **the parent is drawn instead**.
    The descendants keep loading. So a refinement appears as one atomic event: the parent's single
    mesh is replaced by up to four child meshes in one frame.
  - **`loadingDescendantLimit` = 20 (133, 936-952):** if more than 20 descendants are still loading
    and this tile was not drawn last frame, the descendant loads are dropped (the queues are truncated)
    and this intermediate tile is loaded first. The result is progressive steps (e.g. L10 → L12 → L14),
    each of them a pop, instead of one long wait.
- Culled tiles are **not loaded** unless `preloadSiblings` (152, 1236-1240) or level 0.
  `preloadAncestors = true` (142, 965-967) loads the parents of rendered tiles at low priority, so
  coarse ancestor imagery is always available as a stand-in.
- Load queue: three queues, High (refinement blockers), Medium (rendered tiles that meet the SSE)
  and Low (ancestors, siblings) (82-84). Each is sorted every frame by `_loadPriority` (1357-1371)
  from `GlobeSurfaceTileProvider.computeTileLoadPriority`, which is
  `(1 - dot(dirToTile, camDir)) * distance`: centre of view and near first (1050-1076). Processing is
  limited to a 5 ms time slice per frame (`_loadQueueTimeSlice` 87, 1328-1383).
- **Eviction:** `trimTiles(tileCacheSize)` runs every frame that has queued loads (1326). With the
  default of 100, only about 100 *non-rendered* tiles survive. In chase view, turning the camera
  around drops almost everything behind you. Looking back reloads those tiles, and the whole
  coarse-to-fine pop sequence plays again. This is complaint 1's "re-rendering at a location I
  already rendered".

### 1.2 Tile load: `Scene/GlobeSurfaceTile.js`, `GlobeSurfaceTileProvider.loadTile`

- `loadTile` (GlobeSurfaceTileProvider 678-734) loads **terrain only** until the tile's bounding
  volume comes from its own terrain, and only then imagery. So a tile's load is sequential: the
  terrain request (or local upsample) first, then the imagery request.
- `processStateMachine` (244-327): `tile.renderable = defined(vertexArray)` (287). Then
  `processImagery` (335-393) sets `renderable &&= (isAnyTileLoaded || isDoneLoading)`, where
  `isAnyTileLoaded` is true as soon as **any `readyImagery` exists, including an ancestor's**
  (374-378, 390). **A child is therefore drawn as soon as its mesh exists, using its ancestor's
  texture.** The sharp texture arrives later and replaces the ancestor texture: that replacement is
  the pop.
- Terrain beyond the provider's availability (Re:Earth max z14) goes to FAILED, then `upsample()`
  from the parent in a worker (746-756, 831-880). The child mesh has the same surface and
  interpolated normals, so the geometry does not change visibly. `upsampledFromParent` only stays true
  if the imagery also failed (295-297, 380-387). With Esri z19, tiles keep refining past z14 for
  imagery alone.
- Terrain and imagery requests use `throttle:false, throttleByServer:true`
  (GlobeSurfaceTile 939-945, ImageryLayer 1149-1154). They skip the priority heap and are capped
  **per server** at `RequestScheduler.maximumRequestsPerServer = 18`, unless
  `requestsByServer[host:port]` overrides it (`Core/RequestScheduler.js:65, 81, request()`). When the
  cap is reached, the request returns `undefined` and is retried the next frame
  (ImageryLayer 1164-1169).

### 1.3 Imagery: `TileImagery.js`, `Imagery.js`, `ImageryLayer.js`

- `TileImagery` (15-21) links one terrain tile to one imagery tile:
  - `loadingImagery` is the imagery the tile wants.
  - `readyImagery` is what is drawn now, which may be an ancestor.
  - It also holds `textureCoordinateRectangle` (the part of the terrain tile this imagery covers,
    fixed at skeleton time) and `textureTranslationAndScale` (the mapping from tile UV to the
    readyImagery's UV).
- `processStateMachine` (46-125):
  - **The swap (60-69):** when `loadingImagery.state === READY`, it calls
    `readyImagery.releaseReference()` on the old ancestor, sets `readyImagery = loadingImagery`,
    recomputes the translation and scale, and returns true. There is no transition state and no
    memory of what was drawn before.
  - **Ancestor stand-in (71-102):** it walks `loadingImagery.parent` to the first READY ancestor with
    a texture. If that differs from the current `readyImagery`, it releases the old one,
    `addReference()`s the ancestor, and recomputes the translation and scale. This path can also
    change the texture (e.g. from the grandparent to a newly ready parent), which is a second,
    smaller pop.
- `Imagery` (11-43) takes a reference on its parent Imagery when it is constructed, through
  `getImageryFromCache` → `addReference` (`ImageryLayer.js:1447-1463`). It releases the parent only
  when its own refcount reaches 0 (`Imagery.js:55-86`), which also destroys its textures. **So ancestor
  Imagery objects, and their textures once loaded, generally stay resident while any descendant
  Imagery exists.** Holding an extra reference on the replaced ancestor during a fade therefore costs
  almost no extra GPU memory.
- `_calculateTextureTranslationAndScale(tile, tileImagery)` (1061-1093) reads only
  `tileImagery.readyImagery.rectangle`, `.imageryLayer.imageryProvider.tilingScheme` and
  `tileImagery.useWebMercatorT`. **So it can be called with a plain object `{readyImagery: ancestor,
  useWebMercatorT}`.** That is how the cross-fade computes the ancestor's UV mapping relative to the
  child tile.
- Imagery level per terrain tile (`_createTileImagerySkeletons` 686-1048): the target texel spacing is
  the terrain `getLevelMaximumGeometricError(level)` with a hard-coded `errorRatio = 1.0` (795-800),
  converted by `getLevelWithMaximumTexelSpacing` (1682-1706) and clamped to `maximumLevel` (806-817).
  One `TileImagery` is created per overlapping imagery tile, each with its own `texCoordsRectangle`
  (1036-1041).
- Textures are built with LINEAR_MIPMAP_LINEAR and anisotropy when the source is power-of-two
  (1286-1328), so the new texture is already mip-filtered.
- The docs say `alpha` may be a `Function(frameState, layer, x, y, level)` (49-54). **The code no longer
  supports that:** the draw loop copies `imageryLayer.alpha` straight into the uniform
  (GlobeSurfaceTileProvider 3043-3044). Do not rely on it.

### 1.4 Numbers for this app (Israel, about 32°N)

- Terrain (CesiumTerrainProvider, geographic 2×1 roots, 65-sample estimate): the level-0 geometric
  error is `6378137·2π·0.25/(65·2)` ≈ 77 067 m, halving per level (`Core/TerrainProvider.js:513-522`).
- Esri/EOX Web-Mercator, 256 px: the level-0 texel spacing is `6378137·2π·cos32°/256` ≈ 132 700 m.
  The imagery level is `round(log2(132700/(77067/2^L)))` = **L+1**. The longitude edges line up
  exactly. The Mercator rows cut terrain tiles at arbitrary latitudes, so each terrain tile has 1–2
  imagery tiles per layer, which gives the rectangular pop shapes.
- Refinement distance, for about 900 px CSS height, 16:9 and fov 60° (sseDenominator ≈ 0.65).
  SSE = 2 is reached at `2^L ≈ 5.3e7/d`:

  | distance | terrain level | imagery level | type of pop |
  |---|---|---|---|
  | 150 m | 19 | 19 (cap) | imagery only |
  | 1 km | 16 | 17 | imagery only (upsampled terrain) |
  | 5 km | 14 | 15 | imagery, plus the last real mesh swap |
  | 20 km | 12 | 13 | imagery, mesh and normals |
  | 80 km | 10 | 11 | imagery, mesh and normals |

- At refinement, a tile's width divided by distance is about 0.32 rad, so **each pop is a patch
  roughly 18° wide** (foreshortened at grazing angles). Its texel density doubles in one frame. When
  loading lags, the drawn stand-in may be 2–4 levels coarser, so the jump is 4×–16×.

### 1.5 Drawing: `GlobeSurfaceTileProvider.addDrawCommandsForTile` (2504-3347)

- It is module-private and is called from `endUpdate` (618) for every tile in
  `_tilesToRenderByTextureCount`.
- A tile without a vertex array is drawn as a `TerrainFillMesh` (2511-2519). A fill's centre vertex
  uses the geodetic normal (`TerrainFillMesh.js:1189-1207`), so **fills are lit flat**. Real terrain
  then brings slope shading, which looks like shadows appearing.
- `maxTextures = ContextLimits.maximumTextureImageUnits` (2536), which is 16 on an M2 with WebGL2.
  One unit each is subtracted for water mask, ocean waves, shadows and clipping planes, and 3 for
  clipping polygons (2607-2635).
- It reads `surfaceTile.imagery` **at draw time** (2754-2756). Then it runs a `do { … } while
  (imageryIndex < imageryLen)` loop (2791-3346). Each iteration is one `DrawCommand`, which is given up
  to `maxTextures` day textures (2999-3173). If a tile has more imagery than that, more commands
  follow, with the blend render state (`otherPassesRenderState`, 3344-3345).
- Per slot i (3000-3172):
  - It skips `readyImagery` if it is undefined or if `imagery.imageryLayer.alpha === 0` (3004).
  - `dayTextures[i]` is the texture: `textureWebMercator` when `useWebMercatorT`, otherwise `texture`.
  - `dayTextureTranslationAndScale[i]` is `tileImagery.textureTranslationAndScale`.
  - `dayTextureTexCoordsRectangle[i]` is `tileImagery.textureCoordinateRectangle`.
  - `dayTextureAlpha[i]` is **`imagery.imageryLayer.alpha`**. `applyAlpha` is set if any alpha ≠ 1
    (3043-3047).
  - The same pattern fills nightAlpha, dayAlpha, brightness, contrast, hue, saturation, gamma, split,
    cutout and colorToAlpha, all read from `imagery.imageryLayer`.
  - **All per-slot state is read through `tileImagery.readyImagery` and `readyImagery.imageryLayer`.**
    That is the hook for a per-tile fade.
- Shader choice: `surfaceShaderSetOptions.numberOfDayTextures` and `applyAlpha` go into
  `GlobeSurfaceShaderSet.getShaderProgram` (3245-3273). The flag bits (`+applyAlpha << 7`, 181-188)
  and `numberOfDayTextures` select a cached program (243-259). A cache miss compiles a new variant
  once (267-301).

### 1.6 Shader: `Shaders/GlobeFS.glsl`, `GlobeSurfaceShaderSet.js`

- The generated `computeDayColor` calls `sampleAndBlend(color, u_dayTextures[i], …,
  applyAlpha ? u_dayTextureAlpha[i] : 1.0, …)` once per slot, in order (ShaderSet 419-472).
  Without `APPLY_ALPHA` the alpha is the constant 1.0, so the uniform is ignored (GlobeFS 8-9).
- `sampleAndBlend` (GlobeFS 182-290):
  - The alpha is zeroed outside `textureCoordinateRectangle` by the step() trick (207-211).
  - It samples `texture(tex, uv*scale+translation)` (217-220).
  - It then blends `outColor = mix(prev.rgb*prev.a, color, alpha*textureAlpha)/outAlpha` (266-270).
  - **So slot k drawn over slot k-1 with alpha t is exactly a cross-fade:** `mix(ancestor, new, t)`
    for opaque imagery.
- `GlobeVS.glsl` decodes compressed position, height, UV, normal and web-Mercator T (123-140). It has
  no attribute for a second (parent) height. See B.

---

## 2. Techniques

### A. Per-tile imagery cross-fade. Verdict: FEASIBLE without forking. Recommended.

**Patchability**

- `cesium/Source/Cesium.js` (the ESM `import` entry, per the `exports` map) re-exports straight from
  `@cesium/engine` (`export { TileImagery } from '@cesium/engine'` etc.). There is one module
  instance, so the constructor you import is the one the engine uses internally.
- Exported in `@cesium/engine/index.js`:
  - `TileImagery` (831), `GlobeSurfaceTileProvider` (646), `GlobeSurfaceTile` (645)
  - `Imagery` (684), `ImageryState` (689), `QuadtreePrimitive` (782)
  - `ContextLimits` (9), `RequestScheduler` (408), `TerrainEncoding` (428)
  - `_shadersGlobeFS` / `_shadersGlobeVS` (186-187)
- `TileImagery.prototype.processStateMachine` is a plain prototype function. `GlobeSurfaceTileProvider`
  and `GlobeSurfaceTile` are ES classes (GlobeSurfaceTileProvider 76), and class methods are writable
  prototype properties. All of them can be reassigned from app code, in Vite dev (esbuild
  pre-bundle, still one graph) and in the prod build.
- The private types are missing from `Cesium.d.ts`, so use
  `import * as Cesium from 'cesium'; const C = Cesium as any`.
- `addDrawCommandsForTile` itself is module-private and **cannot** be patched. The design below does
  not need to patch it.

**Design: a swap-in array during `endUpdate`.** This never mutates Cesium's persistent tile state.

1. Wrap `TileImagery.prototype.processStateMachine`. It runs in `endFrame` → `processTileLoadQueue`:
   ```ts
   const orig = C.TileImagery.prototype.processStateMachine
   C.TileImagery.prototype.processStateMachine = function (tile, frameState, skipLoading) {
     const before = this.readyImagery ?? readyAncestorOf(this.loadingImagery) // see note (a)
     before?.addReference()                        // keep the old texture alive across line 61-62's release
     const done = orig.call(this, tile, frameState, skipLoading)
     const after = this.readyImagery
     if (before && after && after !== before && after.level > before.level
         && after.imageryLayer === before.imageryLayer && fadeable(after.imageryLayer)) {
       fades.begin(tile, this, before)             // takes ownership of the extra ref
     } else before?.releaseReference()             // exactly the ref we added; may free it, as Cesium would have
     return done
   }
   ```
   Notes:
   - (a) If this is the tile's first `processStateMachine` call and its own Imagery is already READY
     (shared with a neighbouring terrain tile), `readyImagery` was undefined. Walk
     `loadingImagery.parent` to the first READY ancestor with a texture, the same test as
     TileImagery 74-77, so the fade starts from what the parent tile was showing.
   - This catches both swap paths: READY (60-69) and ancestor-upgrade (90-101).
   - `fadeable(layer)` = `layer.isBaseLayer() && layer.alpha === 1`. For translucent layers (the
     night lights) a two-slot fade does not end exactly on the plain result (see "Caveats").
   - If a fade already exists for this `TileImagery` (a fast double swap X → Y), keep the existing,
     older `from`, keep the clock, and release the new `before`.
2. The fade registry: `Map<GlobeSurfaceTile, Fade[]>`, where
   `Fade = { tile, ti, from, after, fromTS, start?: number, companion, proxyTI, proxyLayer }`, where
   `after` is `ti.readyImagery` at the time of the swap.
   - `fromTS = from.imageryLayer._calculateTextureTranslationAndScale(tile, { readyImagery: from,
     useWebMercatorT: ti.useWebMercatorT })` (ImageryLayer 1061-1093).
   - `companion = { readyImagery: from, loadingImagery: undefined, textureTranslationAndScale: fromTS,
     textureCoordinateRectangle: ti.textureCoordinateRectangle, useWebMercatorT: ti.useWebMercatorT }`.
     This is the ancestor texture restricted to the same rectangle.
   - `proxyLayer = Object.create(realLayer)` with its own `alpha` data property. All other reads
     (nightAlpha, brightness, cutoutRectangle, `_layerIndex`, …) fall through to the real layer.
   - `proxyImagery = Object.create(after, { imageryLayer: { value: proxyLayer } })`. `texture`,
     `textureWebMercator` and `credits` are inherited.
   - `proxyTI = { readyImagery: proxyImagery, textureTranslationAndScale: ti.textureTranslationAndScale,
     textureCoordinateRectangle: …, useWebMercatorT: … }`. Build these once per fade and only update
     `proxyLayer.alpha` each frame.
3. Wrap `GlobeSurfaceTileProvider.prototype.endUpdate`. This is where `addDrawCommandsForTile` runs
   (500-625):
   ```ts
   const origEnd = C.GlobeSurfaceTileProvider.prototype.endUpdate
   C.GlobeSurfaceTileProvider.prototype.endUpdate = function (frameState) {
     const now = performance.now(), rendered = this._quadtree._tilesRenderedThisFrame  // Set (QuadtreePrimitive 80)
     const swaps = []
     for (const [st, list] of fades) {
       const tile = list[0].tile
       if (!rendered.has(tile)) { expireIfStale(st, list, now); continue }   // e.g. unstarted > 3 s → release
       const orig = st.imagery, aug = scratchArrayFor(st); aug.length = 0
       for (const ti of orig) {
         const f = list.find((x) => x.ti === ti)
         if (!f) { aug.push(ti); continue }
         f.start ??= now                                   // the clock starts at FIRST DRAW, not at load
         const t = smoothstep((now - f.start) / FADE_MS)
         if (t >= 1 || ti.readyImagery !== f.after) { finish(f); aug.push(ti); continue }  // releases f.from
         f.proxyLayer.alpha = Math.max(t, 1e-3)            // 0 would hit the skip at 3004
         aug.push(f.companion, f.proxyTI)                  // ancestor first (below), new on top
       }
       st.imagery = aug; swaps.push(st, orig)
     }
     try { return origEnd.call(this, frameState) }
     finally { for (let i = 0; i < swaps.length; i += 2) swaps[i].imagery = swaps[i + 1] }
   }
   ```
   - Starting the clock at the first draw also covers children that loaded their own imagery while the
     parent was still drawn (kick logic, QuadtreePrimitive 904-963). Their first appearance fades in
     from the ancestor instead of popping.
   - Nothing else reads `surfaceTile.imagery` while it is swapped:
     - `TerrainFillMesh.updateFillTiles` (537-542) only calls `GlobeSurfaceTile.initialize`, which is a
       no-op when `tile.data` exists.
     - Picking reuses last frame's commands (632-647).
     - `showTileThisFrame` already ran against the real array; it only affects bucket order.
4. Release paths. Every Fade owns exactly one reference on `from`:
   - When the fade finishes.
   - When the tile is freed: wrap `GlobeSurfaceTile.prototype.freeResources` (166-198) and release
     that surfaceTile's fades before calling the original.
   - When the layer is removed: `globe.imageryLayers.layerRemoved`. The event fires **before**
     `layer.destroy()` (`ImageryLayerCollection.js:164-176`), so releasing there is safe. This is
     needed for the app's Esri→EOX swap in `client/scene/imagery.ts:eoxOnEsriFailure`.
   - When a fade was never started (the tile stayed culled): after a few seconds.
   - Never call `releaseReference` on a destroyed layer's Imagery.

**How alpha reaches the shader.** `proxyLayer.alpha` → `dayTextureAlpha[i]` (3043-3044) →
`applyAlpha = true` (3045-3047) → the `APPLY_ALPHA` shader variant (ShaderSet 188, 300-301, 449) →
`sampleAndBlend(…, u_dayTextureAlpha[i], …)` → `mix(ancestor, new, t)` (GlobeFS 266-270). Only the
fading tiles switch to the alpha variant. The other tiles keep their current program.

**Refcount.** Covered in steps 1 and 4. Because child Imagery already references its parents
(Imagery 18-27), `from` is usually alive anyway. The extra reference only guarantees that its texture
is not destroyed between line 62 and the end of the fade.

**Texture units.**
- A fading base slot costs 2 units. Base plus night lights is at most 3 of 16.
- If a tile ever exceeded `maxTextures`, Cesium would split it into several commands with blending
  (2791, 3344-3346). That still renders correctly, but it would not happen here.

**Per-frame cost.**
- CPU: one Map walk over the fading tiles (typically 0–20), each with 2–4 array pushes, plus one
  closure per `processStateMachine` call. That is microseconds.
- GPU: fading tiles do one extra `texture()` fetch and one mix per fragment. They are a small share
  of the screen at any moment, so expect < 1 % GPU on the M2.
- Draw commands: unchanged.
- Shader variants: new variants `(n=2, APPLY_ALPHA)` and `(n=3, APPLY_ALPHA)` compile once. That is a
  one-time hitch of roughly 10–50 ms. Pre-warm it at chase start, for example by forcing a
  1-frame fade.

**Caveats.**
- **Refine only.** Coarsening (a kicked or receding tile going back to the parent) stays an instant
  swap. That is less visible, because those tiles are receding or small.
- **Imagery only.** It does not hide mesh or normal swaps at z ≤ 14 (far field, about 2 px) or the
  fill → mesh shading change. The mitigations for those are in D.
- Translucent layers are excluded (see step 1).
- **It relies on private internals** (`_quadtree`, `_tilesRenderedThisFrame`,
  `_calculateTextureTranslationAndScale`, the TileImagery field names). Pin the Cesium version and add
  a startup assert that these exist; if one is missing, disable the fade silently.
- Suggested `FADE_MS`: 400–600 with smoothstep. The app renders continuously
  (`requestRenderMode: false`), so a time-based fade is correct.

**Alternative A′: a mip-bias "sharpen-in".** Sample the new texture with an LOD bias ramping from +1
(which roughly matches the parent's resolution) to 0. That costs zero extra fetches. However, it
needs a modified `GlobeFS` (replace `globe._surfaceShaderSet.baseFragmentShaderSource`, Globe.js
684, using `_shadersGlobeFS`) and a new per-slot uniform added to every uniform map in
`tileProvider._uniformMaps`. That is more invasive. It also does **not** hide the colour and source
changes between Esri zoom levels, which the cross-fade does. Not recommended over A.

### B. Terrain geomorphing on refine. Verdict: NOT feasible within reason.

- It needs a per-vertex "parent height" attribute. `TerrainEncoding` (Core/TerrainEncoding.js
  32-48, 184-290) packs position/height, UV, oct-normal, web-Mercator T and geodetic normal into fixed
  compressed layouts. `GlobeVS.glsl` only declares those inputs (lines 2-10, 123-140).
- It would need changes in several places:
  - the encoding and stride;
  - the mesh creation in the **terrain workers**, which this app serves prebuilt from
    `cesium/Build/Cesium/Workers` (vite.config.ts), so that means a fork;
  - `GlobeSurfaceTile._createVertexArrayForMesh` (485);
  - the base vertex shader (Globe.js 679);
  - a per-tile morph uniform.
- Sampling the parent surface under each child vertex on the CPU is O(vertices × triangles) with
  `interpolateHeight` unless a spatial index is built.
- The payoff is small. Mesh swaps only happen at z ≤ 14 (at least about 5 km away in chase), and they
  are bounded to about the 2 px SSE. The visible part, the normal/shading change, would also need
  parent normals.
- A per-tile "grow from flat" using the existing exaggeration path
  (`u_verticalExaggerationAndRelativeHeight` is set per command, 2904-2906) is not a parent → child
  morph, and it would look wrong.
- Skip B.

### C. Tiles appearing from nothing. Verdict: relevant only when orbiting and when entering chase. Handle it with D, not with a fade.

- Rule 2 in `visitTile` (769-772) renders a tile that was culled last frame immediately, even if it
  is unloaded.
- It is drawn as a flat-lit `TerrainFillMesh` (2511-2519; TerrainFillMesh 1189-1207) with the nearest
  READY ancestor imagery. `preloadAncestors` keeps coarse ancestors resident, so there is almost
  never a hole.
- When the user drags the chase camera into previously culled directions, those areas show fills
  with coarse imagery. Then the mesh arrives (a shading pop) and then the imagery (a texture pop).
  With A, the imagery part cross-fades. The fill → mesh part does not.
- Fading from sky or transparent would look worse than the coarse stand-in. The fix is to make
  culled neighbours resident beforehand: `preloadSiblings` and a larger `tileCacheSize` (D).
- Diagnostic: `scene.globe.fillHighlightColor = Color.RED.withAlpha(0.4)` (Globe.js 158, 1070) tints
  fills. It shows directly how much of complaint 1 and 2 is fills.

### D. Loading earlier and faster. Verdict: YES, as cheap tuning. It shrinks the jump size but does not remove pops.

- **`maximumScreenSpaceError`** (Globe.js 105 → QuadtreePrimitive 110): keep 2.
  - Lowering it (e.g. 1.5) refines at longer distances, so pops are smaller on screen. But it adds
    roughly 1/SSE² more tiles (about 1.8×): more draw commands, more Esri requests and quota, lower
    FPS.
  - The 2× texel jump per refinement is the same at any SSE.
  - Raising it (3) improves FPS but makes the ground blurrier and the pops bigger.
- **`loadingDescendantLimit`** (Globe.js 129 → 133, 936-952): keep 20.
  - Larger means fewer intermediate steps but a longer blur followed by one big jump.
  - Smaller means more steps. With A each step fades, so 20 is fine.
- **`preloadSiblings = true`** (Globe.js 148 → 152, 1236-1240): loads the culled siblings of visible
  tiles, i.e. just outside the frustum.
  - This is the direct fix for orbit reveals (C) and for turns.
  - Cost: more tile loads (about +30–60 % requests, with Esri quota to match), but no extra
    rendering. FPS is almost unaffected, because loading is time-sliced to 5 ms.
- **`tileCacheSize`** (Globe.js 116 → 120, trimmed at 1326): raise from 100 to about 400–600.
  - This stops reloading when you look back, which ends the replayed pop sequences (complaint 1).
  - Cost: GPU memory. A 256² RGBA mipmapped texture is about 350 KB, plus the mesh, so roughly
    0.2–0.4 MB per tile, or about 100–200 MB at 500 tiles. There is no per-frame cost: the cache is
    only a list walk in `trimTiles`.
- **Per-server concurrency.** Globe requests are capped per host at 18 (§1.2):
  `RequestScheduler.requestsByServer['ibasemaps-api.arcgis.com:443'] = 32`,
  `['terrain.reearth.land:443'] = 24`, `['tiles.maps.eox.at:443'] = 24`.
  - This cuts queueing latency, so the stand-in is fewer levels coarse.
  - It does not increase the number of tiles requested; selection decides that.
  - The FPS cost is only more concurrent decodes (off-thread) and texture uploads, which are bounded
    by the 5 ms load slice.
  - Whether the hosts use HTTP/2 was not checked. If they do, the browser multiplexes; if not, it caps
    at about 6 per host anyway, and raising the Cesium cap only queues requests in the browser.
- **Prioritisation.** `computeTileLoadPriority` (1050-1076) already favours the centre of view and
  near tiles. The chase camera looks at the aircraft, so the flight path ahead is already favoured.
  Patching the prototype to bias toward the aircraft's heading only reorders tiles that are already
  queued. The gain is marginal.
- **Prefetch along the flight path.** There is none for the globe. `preloadFlightDestinations` exists
  only for 3D Tiles camera flights. Selection is tied to `frameState.camera`.
  - An app-level fetch-ahead of Esri tile URLs would only warm the browser HTTP cache, if Esri sends
    cacheable headers (not verified). It costs quota, and it saves network latency but not the pop.
  - Low value once A exists.
- Private knob, left alone: `_loadQueueTimeSlice = 5 ms` (87). Raising it trades frame time for load
  speed.

### E. Fog and haze. Verdict: YES, as a cheap complement. It improves FPS.

- Fog is already on (`Fog.js` 25). Density scales with camera height and with how much the camera
  looks at the horizon (122-165).
  - SSE is reduced by `fog(d, density) * screenSpaceErrorFactor` (QuadtreePrimitive 1266-1269,
    default factor 2, Fog 82).
  - The visible haze is `czm_fog(v_distance, …, visualDensityScalar)` (GlobeFS 519-534, default
    0.15, Fog 73).
  - The FOG shader path already runs on every tile where fog exceeds 1e-3 (2982-2985).
- Raising `visualDensityScalar` to about 0.25–0.35 makes far pops fade into the haze. It is
  essentially free and gives a cinematic look.
- Raising `screenSpaceErrorFactor` to about 3–4 stops far tiles refining sooner. The result is fewer
  tiles and fewer far pops, with **better** FPS, but a blurrier distance. Pair the two so the blur is
  hidden by the haze.
- Ground atmosphere per-fragment only turns on beyond `nightFadeOutDistance` (2601-2605), so there is
  no cost in chase view.

### F. Anything in 1.145 that fades or morphs? Verdict: NO for the globe.

- A grep for fade, morph and transition in Globe, GlobeSurfaceTile, GlobeSurfaceTileProvider,
  QuadtreePrimitive, ImageryLayer, TileImagery and TerrainFillMesh finds only:
  - lighting and night fade *distances*;
  - the 2D/3D `SceneMode.MORPHING`;
  - the `ImageryState.TRANSITIONING` enum.
- None of these relate to LOD. The foveated, dynamic-SSE and skip-LOD features are 3D-Tiles-only
  (`Cesium3DTileset*`).
- The documented function-valued `ImageryLayer.alpha` (49-54) is dead: the uniform takes the raw
  property (3043).

---

## 3. Recommendation

1. **Implement A (the cross-fade)** as one small module, for example `client/scene/lodFade.ts`,
   installed once after `createViewer`.
   - It wraps `TileImagery.prototype.processStateMachine`,
     `GlobeSurfaceTileProvider.prototype.endUpdate` and `GlobeSurfaceTile.prototype.freeResources`.
   - It listens to `imageryLayers.layerRemoved`.
   - Settings: base layer only, 500 ms smoothstep, clock starts at first draw. Pre-warm the shader
     variant.
   - Guard it with feature-detect asserts, and pin Cesium.
   - This turns every refinement (and a child's first appearance) into a half-second dissolve from
     the coarse image to the sharp one, for about 1 % GPU.
2. **Tuning (D, E):**
   - `globe.tileCacheSize = 500`
   - `globe.preloadSiblings = true`
   - `RequestScheduler.requestsByServer` for the Esri and Re:Earth hosts at about 32/24
   - `scene.fog.visualDensityScalar ≈ 0.3`
   - `scene.fog.screenSpaceErrorFactor ≈ 3`
   - Keep `maximumScreenSpaceError = 2` and `loadingDescendantLimit = 20`.
   - Net FPS: neutral to slightly better (fewer far tiles). Net memory: +100–200 MB. Esri quota goes
     up moderately because of `preloadSiblings`.
3. Skip B (terrain geomorph). Accept the far-field mesh and normal swaps, which are hidden by haze and
   bounded to about 2 px.
4. Measure before and after with the ridge FPS benchmark (p50 about 140).
   - `globe.tileLoadProgressEvent` (Globe.js 564) gives the queue length, a proxy for lag.
   - `globe._surface._debug.enableDebugOutput = true` prints tiles rendered and waiting for children.
   - `globe.fillHighlightColor` shows fills.

Cross-reference for complaint 1: tile eviction at `tileCacheSize` 100 (QuadtreePrimitive 1326) plus
flat-lit fills (TerrainFillMesh 1189-1207) plus normal changes at z ≤ 14 refinements explain why
shading appears to render again in places already seen. The same D settings address it.

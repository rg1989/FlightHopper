# Prior art: smooth globe LOD, and no re-loading on camera rotation (CesiumJS 1.145)

Research only. I did not edit any repo files. "Verified" means I read the code in
`node_modules/@cesium/engine/Source` (engine 26.3.0 = cesium 1.145.0) or ran curl on 2026-09-23.

## TL;DR

1. **Complaint 1 (re-rendering after looking back) is a cache-size problem, and one line fixes it.**
   Verified in the 1.145 source:
   - `Globe.tileCacheSize` (default 100) is a **tile count**, and the count includes the tiles drawn this frame.
   - `TileReplacementQueue.trimTiles` frees every tile not used this frame while the count is above 100. It runs whenever anything is in the load queue, which is almost always true while we chase an aircraft.
   - Our low-altitude chase view with a horizon draws more than 100 tiles. So when we turn away, the tiles that leave the view are freed almost at once.
   - Freeing a terrain tile also frees its imagery. `Imagery.releaseReference` destroys the texture when its reference count reaches 0, and `ImageryLayer._imageryCache` holds only live tiles.
   - When we look back, Cesium must fetch everything again (from the HTTP cache at best), decode it again in the worker, upload it to the GPU again and rebuild mipmaps. Until then it draws "fill"/ancestor tiles.
   - Result: the user sees the same area refine again. Because we light terrain from vertex normals, the coarse-to-fine normals change the shading, which looks like "shadows rendering".

   Community fix: `globe.tileCacheSize = 1000` (forum). deck.gl's default heuristic is 5x the number of tiles in the viewport. The cost is memory only (estimate below).
2. **The night-lights layer cannot be cached by the browser.** GIBS returns `cache-control: no-store` (verified). Every time we re-request a VIIRS tile, it is a full network fetch.
3. **Complaint 2 (squares that suddenly go sharp): CesiumJS has no LOD fade for the globe.**
   - Issue #8140 "Alpha blending for imagery layers LODs" has been open since 2019. The old roadmap item for this (#526) was closed as not planned.
   - I found **no published plugin or snippet** that fades globe imagery in CesiumJS.
   - The best-proven technique is MapLibre's: a temporal cross-fade between the parent texture and the child texture, done in **one draw with two texture samples**. It costs almost nothing.
   - Cesium's surface shader already supports N day textures per tile, each with its own `textureTranslationAndScale` and alpha. `TileImagery` already holds the ancestor imagery while the child loads. So a cross-fade is about 40 lines. However, one part of it (`addDrawCommandsForTile`) is module-private, so we must use patch-package (see §3).
4. **Rules other engines use, which we should copy:**
   - Do not fade tiles that were off-screen last frame or that come from cache. They pop in (3DTilesRendererJS).
   - Cap the number of fades that run at the same time (50).
   - Skip fades while the camera turns fast (more than 0.25 rad/frame).
   - Use a constant fade time, no matter how many levels were skipped (Google patent).
   - Durations: 250 ms (3DTilesRendererJS), 300 ms (MapLibre), 500 ms (Cesium for Unreal).
5. **Geometry and normal pops** (the terrain mesh itself changes) need geomorphing (CDLOD, regular grids only) or a dithered double-draw (Cesium for Unreal, extra draw calls during transitions). Both are expensive to add to Cesium's quantized-mesh path. Do the cache fix and the imagery fade first.
6. **All our tile hosts speak HTTP/2**, but Cesium still limits each host to 18 simultaneous requests. Globe tile requests use `throttle:false, throttleByServer:true`, so only the per-server cap applies. `requestsByServer` is empty by default and Cesium does not detect HTTP/2. We can raise the cap per host, but the 5 ms/frame load time slice and the worker decode are probably the real bottleneck.

---

## 1. Why rotating re-loads tiles (CesiumJS internals, verified in 1.145)

| Fact | Where |
|---|---|
| `Globe.tileCacheSize = 100`, `maximumScreenSpaceError = 2`, `loadingDescendantLimit = 20`, `preloadAncestors = true`, `preloadSiblings = false` | `Scene/Globe.js:105-148` |
| The cache is a count of tiles. `trimTiles(tileCacheSize)` runs at the start of each `processTileLoadQueue`, but only when a queue is non-empty. It frees tiles from the tail until count ≤ max, and stops at the first tile used this frame. | `QuadtreePrimitive.js:1311-1326`, `TileReplacementQueue.js:32-54` |
| A culled tile is marked "rendered" (kept) only if its parent was visited. Culled tiles are queued for load only at level 0, or when `preloadSiblings` is true. | `QuadtreePrimitive.js:1203-1243` |
| Imagery has no cache of its own. It is ref-counted, and at 0 references the texture is destroyed. | `Imagery.js:55-86`, `ImageryLayer.js:1447-1467` |
| The load work per frame is limited by `_loadQueueTimeSlice = 5 ms` (private). | `QuadtreePrimitive.js:87` |

Community threads:
- **"Increase Terrain Cache?"** (2019): rotating in place re-loaded tiles. Raising `tileCacheSize` and turning on `preloadSiblings` fixed it, as the user confirmed. https://community.cesium.com/t/increase-terrain-cache/8945
- **"Prevent 3D tile re-load when entering camera view"** (2022): `tileCacheSize = 1000` fixed terrain; 3D Tiles need `cacheBytes` instead. https://community.cesium.com/t/prevent-3d-tile-re-load-when-entering-camera-view/18948
- **"Terrain tiles constantly reloading when moving camera"** (2015–16): a Cesium developer suggested a larger `tileCacheSize` or a larger `maximumScreenSpaceError`. The user said these only delayed the tile swapping. The traversal was reworked later. https://community.cesium.com/t/terrain-tiles-constantly-reloading-when-moving-camera/3440
- **PR #7061** (Cesium 1.55, 2019) is the globe loading rewrite that added fill tiles, `preloadAncestors`/`preloadSiblings`/`loadingDescendantLimit`, and removed RequestScheduler priority throttling for globe tiles. It reports 1.4–2.3x faster loads and about 33% less bandwidth. https://github.com/CesiumGS/cesium/pull/7061 ; announcement: https://groups.google.com/g/cesium-dev/c/nH1VJjdlMXE
- **Issue #7987** asks to preload terrain and imagery the way 3D Tiles does for flight destinations. It is still open. https://github.com/CesiumGS/cesium/issues/7987
- **Globe JSDoc for `tileCacheSize`**: tiles beyond the count are freed "as long as they aren't needed for rendering this frame". https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Scene/Globe.js

### Knobs and their costs

- **`tileCacheSize`**: the main fix. It costs memory only; trimming is O(evicted).
  - My estimate. I measured a Re:Earth z12 tile over Israel: 3,415 vertices (68 KB on the wire). A z14 tile has 592 vertices (12 KB).
  - GPU vertex and index data is about 20–140 KB per tile, and Cesium keeps a CPU copy for picking.
  - A 256² RGBA imagery texture with mips is about 350 KB. There are 1–2 per layer per tile, but they are shared between neighbouring tiles.
  - So the total is about 0.3–0.7 MB per cached tile: 400 tiles ≈ 120–280 MB, 1000 tiles ≈ 300–700 MB worst case.
  - Suggestion: read `globe._surface._debug.tilesRendered` (private) in chase, then set the cache to about 3–5x that number (the deck.gl heuristic). Check memory in Chrome's task manager.
  - For comparison, `Cesium3DTileset.cacheBytes` defaults to 512 MB (`Cesium3DTileset.js:251`).
- **`preloadSiblings = true`**: loads culled siblings of rendered tiles, which helps small rotations at the edges of the frustum. It costs extra requests all the time. With Esri this adds billable tiles; the user has said 2M free tiles/month is ample.
- **`loadingDescendantLimit`**: with the default of 20, Cesium can skip levels, so detail may jump 2–3 levels at once (a 4–16x texel jump). This is the "violent" square.
  - 0 to about 4 makes each level load in turn: more, smaller steps, which feels more progressive. The cost is a longer total time to full detail and more requests.
  - Sandcastle "Terrain Tweaks" exposes this knob: https://github.com/CesiumGS/cesium/blob/main/Apps/Sandcastle/gallery/development/Terrain%20Tweaks.html
- **`maximumScreenSpaceError`**: raising it (for example to 3) loads fewer tiles and pops less often, but the image is softer. In a 2019 answer, the Cesium developer suggested lowering it (1.2–1.5) for more detail. https://groups.google.com/g/cesium-dev/c/9bNzgYa6gfM/m/wEidYoVmAgAJ

## 2. Fading imagery and terrain in: what exists

### CesiumJS (globe)
- **#8140 "Alpha blending for imagery layers LODs"** (Omar Shehata, 2019): still open, no PR. It says the fade should be optional because it adds "a little bit of a delay". https://github.com/CesiumGS/cesium/issues/8140
- **#526 "Terrain and imagery roadmap"**: its open items include "morphing between terrain LODs" and "per-pixel imagery LOD selection, blending between adjacent LODs". The issue was **closed as not planned**. https://github.com/CesiumGS/cesium/issues/526
- **#8581**: fading for time-dynamic imagery. Still open. https://github.com/CesiumGS/cesium/issues/8581
- **3D Tiles fade-in forum thread** (2018, and again in 2023): a developer said there is nothing in the engine for this. https://community.cesium.com/t/fade-in-transitions-for-3d-tiles/7490
- **Construkted-Reality research note** (CesiumJS 1.142, 3D Tiles): a dithered cross-fade needs per-tile uniforms and a way to keep the parent alive. The parent keep-alive (a patch to `Cesium3DTilesetTraversal`) is the blocker, estimated at 3 days to 2 weeks. They deferred the work.
  - For the **globe** this blocker does not exist: `TileImagery` already renders the ancestor imagery while the child loads.
  - https://github.com/Construkted-Reality/3DT-Local-viewer/blob/main/docs/research/cross-fade-lod-transitions.md
- **I found no public snippet or plugin that patches `GlobeSurfaceTileProvider` or `TileImagery` to fade imagery**, for any version.

### Cesium for Unreal / cesium-native
- Dithered LOD transitions (PR #882, blog 2022):
  - Old and new tiles are drawn together, with complementary screen-space noise masks. The default duration is 0.5 s.
  - Everything stays in the opaque pass: no overdraw, no depth sorting.
  - The cost is two draws per transitioning tile, with GPU spikes when many tiles transition at once.
  - https://cesium.com/blog/2022/10/20/smoother-lod-transitions-in-cesium-for-unreal/ , https://github.com/CesiumGS/cesium-unreal/pull/882
- **cesium-unreal #961**: successive LODs wait for the previous fade to finish, so full detail arrives later. Proposed fixes: cross-fade in and out at the same time, abort a fade mid-way, and use dynamic speed. https://github.com/CesiumGS/cesium-unreal/issues/961
- **cesium-native #549**: the tile selection keeps both LODs alive and sets a fade percentage from `deltaTime` in `updateView`. https://github.com/CesiumGS/cesium-native/issues/549

### MapLibre / Mapbox GL `raster-fade-duration` (default 300 ms)
Read from source (`src/webgl/draw/draw_raster.ts`, `src/shaders/glsl/raster.fragment.glsl`, `src/tile/tile_manager_raster.ts`):
- **One draw per tile, two textures.** `u_image0` is the tile and `u_image1` is the fading parent (or child). The parent is sampled with `parentScaleBy = 2^(zParent−z)` and `parentTopLeft`, then `mix(color0, color1, u_fade_t)`.
- `fade_t = 1 − clamp((now − tile.timeAdded)/duration)`. The cost is one extra texture fetch per pixel while the fade runs, plus continuous repaints.
- `tile_manager_raster.ts` **retains** the loaded ancestor (or up to two generations of children when zooming out) in `retain[]` until `fadeEndTime`. Edge tiles with no loaded relative "self-fade" in opacity. Tiles already in cache are not faded.
- The fade is **turned off when 3-D terrain is on** (`if (fadeDuration === 0 || isTerrain) return defaults`).
- Known bugs show the bookkeeping is fiddly:
  - Tiles were held forever when the duration was 0 (#2445, fixed in #2455).
  - The fade was lost after v4.2 (#5038).
  - The cross-fade was skipped at the source maxzoom (#8517, still open).
- A related cost report: MapLibre's symbol `fadeDuration` added about 150–300 ms to "idle" on the first load, so they turn it off until the first idle (#2443).
- URLs:
  - https://github.com/maplibre/maplibre-gl-js/blob/main/src/webgl/draw/draw_raster.ts
  - https://github.com/maplibre/maplibre-gl-js/blob/main/src/tile/tile_manager_raster.ts
  - https://github.com/maplibre/maplibre-gl-js/pull/8517
  - https://github.com/maplibre/maplibre-gl-js/issues/2445
  - https://github.com/maplibre/maplibre-gl-js/issues/5038
  - https://github.com/maplibre/maplibre-gl-js/discussions/2443

### deck.gl TileLayer
- `refinementStrategy`:
  - `'best-available'` (default) fills a loading tile with cached content from the nearest zoom.
  - `'no-overlap'` avoids overlapping tiles.
  - `'never'` shows only selected tiles.
  - A custom callback can set `tile.isVisible`.
- There is **no cross-fade**.
- `maxCacheSize` defaults to **5x the number of tiles in the viewport**.
- `maxRequests` defaults to 6. The docs say to use −1 (unlimited) for HTTP/2 servers.
- https://deck.gl/docs/api-reference/geo-layers/tile-layer

### 3DTilesRendererJS (NASA-AMMOS, three.js): `TilesFadePlugin`
- Defaults: `fadeDuration = 250 ms`, `maximumFadeOutTiles = 50` (above this, tiles pop instead of fading), `fadeRootTiles = false`. It dithers materials.
- It has three rules worth copying:
  - Read from `TilesFadePlugin.js`: a tile that **was not in the frustum last frame pops in with no fade**, so turning the camera never replays fades.
  - When there are too many fade-outs **and** every camera moves faster than 0.25 rad or 0.1 units per frame, the fades are finished at once.
  - Root tiles pop the first time they appear.
- Its `UnloadTilesPlugin` frees GPU copies of tiles that are not visible but keeps the CPU data, so a tile can be uploaded again without a new fetch.
- https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/master/src/three/plugins/API.md , https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/master/src/three/plugins/fade/TilesFadePlugin.js

### Google Earth (patent US8654124B2, "Texture fading for smooth LOD transitions", 2012)
- The texture blend weight between the previous LOD and the newly available LOD goes up every frame.
- The texture LOD fade is independent of the geometry LOD.
- The fade rate changes so that the transition time **stays constant** however many levels are skipped. Intermediate LODs are never fetched.
- https://patents.google.com/patent/US8654124B2/en

### iTowns
- I found nothing specific about fading. Its current work is refactoring terrain subdivision and raster fetching (#2421, PR #2609). https://github.com/iTowns/itowns/issues/2421

### Geomorphing (CDLOD, Strugar 2010)
- A quadtree of regular grids that samples the heightmap in the vertex shader. In the last 15–30% of each LOD range, the vertices morph toward the coarser grid, so the swap has no visible seam.
- It needs a **regular grid heightmap**, and the vertex shader reads a texture.
- Cesium's quantized-mesh tiles are irregular TINs. To morph them we would have to compute, in the terrain worker, the parent surface height for each child vertex and store it as an extra vertex attribute. That means changes to `TerrainEncoding`, the worker and `GlobeVS`. It is too invasive for a patch.
- https://aggrobird.com/files/cdlod_latest.pdf , https://github.com/fstrugar/CDLOD

## 3. How an imagery cross-fade would map onto Cesium 1.145 (and which internals it touches)

Hooks (verified):
- **`TileImagery.processStateMachine`** (`Scene/TileImagery.js:46-125`).
  - While the child is loading, `readyImagery` is the nearest READY ancestor, and `textureTranslationAndScale` maps the ancestor onto this tile.
  - At READY, it releases the ancestor and swaps in the child.
  - **Patch:** keep the ancestor reference as `fadeFrom` (with its translation/scale) and a `fadeStart` time. Release it after `fadeDuration`.
  - Skip the fade when the tile was not rendered last frame or when the camera turns fast (the 3DTilesRendererJS rules).
  - `TileImagery` is exported from `cesium` (it is private but on the index), so we can monkey-patch its prototype at runtime.
- **`addDrawCommandsForTile`** (`Scene/GlobeSurfaceTileProvider.js:2504`, a **module-private function**, not on the prototype).
  - It loops over `surfaceTile.imagery` and fills `dayTextures[]`, `dayTextureTranslationAndScale[]` and `dayTextureAlpha[]` (read from `imageryLayer.alpha`, per layer) for each draw command.
  - **Patch:** when `fadeFrom` is set, push the ancestor texture first with its alpha, then the new texture with `alpha × t`.
  - We **cannot** monkey-patch this at runtime. It needs `patch-package` on `@cesium/engine/Source/Scene/GlobeSurfaceTileProvider.js`. This is possible because Vite bundles the engine from ESM `Source` (`@cesium/engine` has `"module": "index.js"`, which re-exports `./Source/...`).
- **`GlobeSurfaceShaderSet`** keys its programs by `(numberOfDayTextures, flags)`, and `applyAlpha` is flag bit 7 (`GlobeSurfaceShaderSet.js:181-280`).
  - During a fade, a tile uses a variant with one more texture and `applyAlpha` on. The first time each variant appears it compiles, which causes a one-off hitch. We can warm the variants up.
  - `maxTextures = ContextLimits.maximumTextureImageUnits` (usually 16). With the base layer plus night lights, a fade needs up to 4 textures.
- **Cost:** only while tiles are fading. One more texture fetch per pixel, per-frame uniform updates (`requestRenderMode` is already off), and the ancestor texture stays alive for about 300 ms. No extra draw calls.
- **This fixes imagery pops only.** It does not fix terrain geometry or normal pops. For those, the only cheap option is fewer and smaller steps (`loadingDescendantLimit`).

**Version-coupling flags:**
- `addDrawCommandsForTile`, the `TileImagery` fields, the shader-set flag bits and `QuadtreePrimitive._loadQueueTimeSlice` are private or undocumented, and Cesium does not follow semver for them.
- Cesium releases monthly (1.145 is from 2026-09-02). The globe-related entries I skimmed in the 1.107–1.145 changelog show no rework of globe imagery, but every upgrade needs the patch re-checked.

## 4. RequestScheduler and HTTP/2

Verified in `Core/RequestScheduler.js` (1.145):
- `maximumRequests = 50`, `maximumRequestsPerServer = 18` (raised from 6 in 1.113, #11627), `priorityHeapLength = 20`, `throttleRequests = true`.
- `requestsByServer = {}` is **empty**. There is no HTTP/2 detection and no host is pre-listed.
- `serverHasOpenSlots` uses `requestsByServer[host:port] ?? maximumRequestsPerServer`.
- Globe terrain and imagery requests are created with `throttle:false, throttleByServer:true` (`ImageryLayer.js:1151`, `CesiumTerrainProvider.js:1371`).
  - So the global cap of 50 and the priority heap **do not** apply to them. Only the per-host cap of 18 does.
  - When a host is at 18, `request()` returns `undefined` and the tile tries again next frame.
- Issue for the 6→18 change: https://github.com/CesiumGS/cesium/issues/11627

Protocol check (`curl -sI --http2 -w '%{http_version}'`, 2026-09-23), plus caching headers:

| Host | HTTP | Cache headers seen |
|---|---|---|
| terrain.reearth.land (layer.json / .terrain) | **2** (alt-svc h3) | layer.json `max-age=3600`; `.terrain` tile `public, max-age=2592000` (30 d), Cloudflare |
| ibasemaps-api.arcgis.com (World_Imagery tile) | **2** | Without a token we get an error body (`max-age=0, must-revalidate`), so the real tile headers are unverified. The public `services.arcgisonline.com` mirror (HTTP/1.1) sends `max-age=86400`. Check in DevTools that re-requests show "(disk cache)". |
| tiles.maps.eox.at (WMTS caps and a z14 jpg) | **2** | `max-age=604800` (7 d) |
| tiles.openfreemap.org/planet | **2** (alt-svc h3) | `public, max-age=86400`, CF HIT |
| gibs.earthdata.nasa.gov (VIIRS night lights, our layer) | **2** | **`no-store, no-cache, max-age=0`**: never cached by the browser |

**Implication:**
- We could set these, for example:
  - `RequestScheduler.requestsByServer['terrain.reearth.land:443'] = 32`
  - `RequestScheduler.requestsByServer['ibasemaps-api.arcgis.com:443'] = 32`
  - `RequestScheduler.requestsByServer['tiles.maps.eox.at:443'] = 32`
- This helps only when fetch latency is the bottleneck. Decode in the worker and the 5 ms per-frame load slice limit throughput anyway.
- More requests in flight means more work finishing in the same frames, and more billable Esri tiles if we preload.
- For re-looking at an area, the cache fix removes the request completely, which is the bigger win.
- For GIBS, the only protection is the in-memory tile cache (or an app-level cache or proxy).

## 5. Recommendation order (cheapest first, from this research)
1. Set `globe.tileCacheSize` to about 3–5x the tiles rendered in chase (measure it; about 400–1000). Consider `preloadSiblings = true`. Cost: memory only.
2. Lower `loadingDescendantLimit` (try 2–4) so refinement arrives in smaller, gradual steps. Cost: slower time to full detail, more requests.
3. Add a MapLibre-style imagery cross-fade (about 250–300 ms), using the 3DTilesRendererJS rules: no fade for tiles off-screen last frame, a cap of about 50 concurrent fades, and a skip when turning fast. This needs `patch-package` on 2 engine files. Cost: one texture fetch per faded pixel during the fade.
4. Optional: raise `requestsByServer` for the HTTP/2 hosts. Measure the FPS p50 (baseline about 140) before and after.
5. Leave geometry geomorphing and dithered double-draw alone unless the terrain mesh or normal pops are still bothersome after steps 1–3.

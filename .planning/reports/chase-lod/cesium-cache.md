# Complaint (1): the ground re-renders when you look back in chase mode

Cesium 1.145 (`@cesium/engine` 26.3.0). All paths below are under `node_modules/@cesium/engine/Source/`. The app files are in `client/scene/`.

## TL;DR

- **Cause:** the globe keeps its tiles in an LRU list. `Globe.tileCacheSize` defaults to **100** (Globe.js:116), and the app does not change it (viewer.ts). That number counts **every** tile in the list, and that includes the tiles used by the current frame, which can never be evicted. In chase view the current frame alone touches **274–406** tiles (measured, see below). So the other tiles have no room: in any frame that has something to load, which is nearly every frame while the aircraft moves, **all** tiles not used in that frame are freed (TileReplacementQueue.js:32-54, QuadtreePrimitive.js:1316-1326). That frees their terrain mesh, vertex buffers and imagery textures.
- **When you look back:** Cesium draws the few coarse ancestor tiles it still holds, then loads the fine tiles again, one level at a time. Coarse tiles have coarse vertex normals. With `enableLighting`, the ground shade comes from those normals (GlobeFS.glsl:431-433), so the hill shading ("shadows") sharpens again in square patches. Measured with a warm HTTP cache: **137–200 tile loads**, and 9–31 coarse tiles grow back to ~160 tiles over **~1.4 s**.
- **Fix:** set `viewer.scene.globe.tileCacheSize = 1200`. One full 360° orbit at chase heights needs **778–1066** entries (measured at 1512×860). With 1200, look-back loads nothing again: the tiles show at once, with **0** reloads in the static test.
- **Cost:** no per-frame CPU cost in steady state. Memory: about **+0.49 MB GPU and ~65 KB JS heap per entry** with Esri z19. Going from ~400 to 1200 resident entries adds about **+400 MB GPU** (worst case ~590 MB for the globe) and **~+55 MB JS heap**.

## 1. What happens to tiles that leave the view

### 1.1 The LRU list and what counts as used

- `TileReplacementQueue` is a doubly linked list. The head holds the most recently used tiles (TileReplacementQueue.js:10-15).
- `markStartOfRenderFrame()` is called at `beginFrame` (QuadtreePrimitive.js:350). It records the current head as `_lastBeforeStartOfFrame` (TileReplacementQueue.js:21-23). A tile marked during the frame moves ahead of that point.
- These calls mark a tile as used:
  - Level-zero tiles, every frame (QuadtreePrimitive.js:589).
  - **Every visited tile**: the ancestors of the drawn tiles, the drawn tiles, and the refined tiles (QuadtreePrimitive.js:725).
  - **Every culled child that the traversal looks at.** When a tile refines, all 4 children are visited, and the culled ones are marked too (QuadtreePrimitive.js:1203-1204).
  - The 4 children of a tile drawn in place of upsampled-only children (QuadtreePrimitive.js:847-851).
  - Every tile the load queue processes (QuadtreePrimitive.js:1379).
- So the list count includes ancestors, and it also includes culled tiles that hold no data. `markTileRendered` adds 1 to `count` for each tile it adds (TileReplacementQueue.js:96). **The limit counts entries in this list, not loaded tiles.** Measured: the list count was exactly `tilesVisited + tilesCulled` (394 = 258 + 136); only 269 of those entries had a vertex array.

### 1.2 When tiles are freed (trimTiles)

- `trimTiles(tileCacheSize)` runs only from `processTileLoadQueue`, and only when a load queue is not empty (QuadtreePrimitive.js:1316-1326). A static camera with everything loaded never trims. That is why a fixed-camera test can look fine while the app, whose aircraft always brings new tiles, trims every frame.
- It walks from the tail (the least recently used entry) toward the head. It stops when `count <= maximumTiles` or when it reaches the last tile not used this frame (TileReplacementQueue.js:32-54). **Tiles used this frame are never freed, even when their number exceeds the limit** (see also the doc comment at QuadtreePrimitive.js:112-120).
  - Consequence: if the tiles used this frame number at least `tileCacheSize`, nothing else is kept. The cache holds only the current frame.
- It skips tiles with `eligibleForUnloading === false`. For globe tiles, that means terrain in `RECEIVING`/`TRANSFORMING`, or imagery in `TRANSITIONING` (GlobeSurfaceTile.js:112-131, QuadtreeTile.js:469-480).
- It is not time-sliced: it can free hundreds of tiles in one frame (TileReplacementQueue.js:34-53).
- Freeing a tile frees **its whole subtree** and detaches the child objects (QuadtreeTile.js:611-631). Parents are always nearer the tail than their children, because the traversal marks the parent first. So evicting one tile behind the camera wipes all of its descendants.
- The value must be set on `Globe`. `Globe.update` copies `tileCacheSize`, `maximumScreenSpaceError`, `loadingDescendantLimit`, `preloadAncestors` and `preloadSiblings` to the quadtree every frame (Globe.js:1037-1041).

### 1.3 What is freed

`QuadtreeTile.freeResources` sets `state = START`, `renderable = false` and `upsampledFromParent = false`, then calls `GlobeSurfaceTile.freeResources` (QuadtreeTile.js:611-621). That call frees the following (GlobeSurfaceTile.js:166-198):

- `terrainData`: the decoded quantized-mesh arrays, or the upsampled data.
- `mesh`: the CPU vertex and index arrays, and the terrain picker.
- The fill mesh.
- The water-mask reference.
- The vector and clipping data.
- The vertex array (GPU vertex buffer, plus the shared index buffer by refcount: GlobeSurfaceTile.js:523-543).
- Every `TileImagery`, through `TileImagery.freeResources`, which releases its `readyImagery` and `loadingImagery` (TileImagery.js:26-34).

**Imagery has no cache of its own.** An `Imagery` is refcounted:

- It is referenced by each `TileImagery` that uses it (ImageryLayer.js:1037-1041, via `getImageryFromCache`, which calls `addReference`: 1447-1463).
- Each `Imagery` also holds a reference to its parent `Imagery` (Imagery.js:18-27).
- When the count reaches 0, the `Imagery` removes itself from `layer._imageryCache` and destroys its image and textures (Imagery.js:55-86, ImageryLayer.js:1465-1468).

`_imageryCache` is only a dedupe map of live objects; it does not keep anything alive. **So `tileCacheSize` alone controls how long imagery stays.** Nothing evicts imagery by itself, apart from the layer events in §5.

### 1.4 What is redone when an area comes back into view

The evicted tiles are back in `START` state, so the whole pipeline runs again:

1. **Terrain request.** `Request{throttle:false, throttleByServer:true}` (GlobeSurfaceTile.js:939-975).
   - The request needs a free slot for that server: 18 per server by default (RequestScheduler.js:65, 406-413). When no slot is free, the tile tries again on a later frame.
   - HTTP caching (checked with `curl -I` on 2026-09-23): Re:Earth terrain sends `cache-control: public, max-age=2592000` (30 days); EOX sends `max-age=604800`; the public Esri World_Imagery endpoint sends `max-age=86400`. The keyed `ibasemaps-api` endpoint was not checked.
   - So a look-back re-fetch usually comes from the browser's disk or memory cache, not the network. Browser-cached Esri tiles are also not billed. It still costs a slot, a cache read and a promise.
2. **Terrain first, imagery later.** While a tile's bounding volume comes from an ancestor, the tile loads terrain only (GlobeSurfaceTileProvider.js:678-734, GlobeSurfaceTile.js:275-282). Imagery requests start only after the tile's own terrain has arrived.
3. **Decode.** The quantized mesh becomes a `TerrainMesh` in a web worker (`createMesh` with `throttle: true`: GlobeSurfaceTile.js:996-1028, 977-985). At most `TerrainData.maximumAsynchronousTasks = 5` tasks run at once (TerrainData.js:124; QuantizedMeshTerrainData.js:241-245).
4. **Upsampling past z14.** The provider's max zoom is 14 (terrain.ts). Levels 15–19 are made by upsampling from the parent, **one level per step**: each tile needs its parent's `terrainData` first (GlobeSurfaceTile.js:718-756, 831-880; QuantizedMeshTerrainData.js:434-436). Each step is another worker task from a 5-task pool (QuantizedMeshTerrainData.js:382-385). An L18 tile near the camera therefore waits for four upsamples in a row after z14.
5. **Vertex buffer upload** (GlobeSurfaceTile.js:1040-1056, 485-518).
6. **Imagery.**
   - Fetch and decode off the main thread with `createImageBitmap` (`preferImageBitmap: true`: ImageryProvider.js:257-263).
   - `texImage2D` upload (ImageryLayer.js:1229-1276).
   - `generateMipmap` (ImageryLayer.js:1286-1328).
   - **No reprojection:** for tiles inside ±85° the Web Mercator texture is used directly (`useWebMercatorT`: ImageryLayer.js:724-727; TileImagery.js:54-58 passes `needGeographicProjection = !useWebMercatorT`; ImageryLayer.js:1378-1414 takes the no-reprojection branch).
7. **Time slice.** The whole load queue gets **5 ms per frame** (QuadtreePrimitive.js:87, 1328, 1373-1376). It is sorted by `(1 − cos(angle from the view direction)) × distance` (GlobeSurfaceTileProvider.js:1050-1076).

### 1.5 What the user sees meanwhile

- A tile that was culled last frame counts as renderable right away (QuadtreePrimitive.js:766-776). When its descendants are not ready and none were drawn last frame, the parent draws in their place, and the children are removed from the render list (QuadtreePrimitive.js:904-963). The parent is loaded because `preloadAncestors` defaults to true (QuadtreePrimitive.js:965-966).
- The coarse tiles still kept are the ancestors that both views share, plus the culled children from §1.1.
- Imagery on those tiles is the ancestor's texture, stretched (TileImagery.js:71-101), so it looks blurred.
- **Shading:** with `globe.enableLighting` and vertex normals, the ground colour is `color × lightColor × clamp(lambert(normal) × 0.9 + vertexShadowDarkness)`, per vertex normal, interpolated (GlobeFS.glsl:431-433; `lambertDiffuseMultiplier = 0.9`, Globe.js:176; the app sets `vertexShadowDarkness` to 0.3–0.5 in sun.ts).
  - A coarse ancestor, say L12 in place of L16, has 16× larger triangles, so small ridges and gullies have no normals of their own and show flat light.
  - When the finer tiles arrive, each quadtree square gets its relief shading back. That is the "shadows rendering again" in the complaint.
  - Fill tiles (tiles with no terrain yet) take their normals from the corners only (TerrainFillMesh.js:1074-1149), so they are shaded flat too.
- Measured (§3.2): after turning back, frames drew **9–31 tiles** (max level 15) for the first 1–1.5 s, instead of ~160 tiles (max level 18).

## 2. Defaults and their effect

| Setting | Default (cite) | Effect | Recommendation |
|---|---|---|---|
| `tileCacheSize` | 100 (Globe.js:116; QuadtreePrimitive.js:120) | Counts all entries in the list, including this frame's tiles, which cannot be evicted (§1.2). | **1200** |
| `maximumScreenSpaceError` | 2 (Globe.js:105) | A tile refines while `err·H/(d·sseDenominator) − fog/pixelRatio ≥ 2` (QuadtreePrimitive.js:1248-1273). This drives the tile count and so the cache size needed. | Keep for complaint 1. Raising it cuts tiles but softens detail, which belongs to complaint 2. |
| `preloadAncestors` | true (Globe.js:138) | Queues every refined ancestor at low priority (QuadtreePrimitive.js:965-966). This supplies the fallback shown on look-back and when zooming out. | Keep true. |
| `preloadSiblings` | false (Globe.js:148) | When true, loads culled siblings (QuadtreePrimitive.js:1236-1240). That covers only one level beside the view, so it does not help a 180° look-back, and it adds requests and memory. | Keep false. |
| `loadingDescendantLimit` | 20 (Globe.js:129) | When more than 20 selected descendants are not ready and none were drawn last frame, Cesium loads and draws the ancestor first (QuadtreePrimitive.js:931-952). You see a coarse block, then a burst of detail. | This belongs to complaint 2. It is not a look-back fix. |
| `fog.screenSpaceErrorFactor` | 2 (Fog.js:82) | Subtracts `fog(d)·2` px from the SSE (QuadtreePrimitive.js:1266-1269). Distant tiles are one level coarser once `fog(d) → 1`. | Keep. |
| `fog.density` | 6e-4 (Fog.js:49) | The effective density is `density · 0.001 · (h/800 km)^-0.59 · (1 − abs(cos(angle to local up)))` (Fog.js:145-161). Tiles with `1 − exp(−(d·ρ)²) ≥ 1` are **culled** (GlobeSurfaceTileProvider.js:755-759; Math.js:1122-1125). Measured ρ = 2.65e-5 at 841 m above the ellipsoid, so culling starts at ~230 km (~50 km at 100 m, ~300 km at 2 km). | Keep. Turning fog off would add far tiles and raise the cache needed. |

**Do culled but cached tiles cost anything per frame?** No, in steady state:

- The traversal touches only the tiles it reaches from visible tiles, plus the culled children of refined tiles (QuadtreePrimitive.js:714-987, 1181-1246).
- `markTileRendered` is O(1).
- `trimTiles` walks only the entries it evicts.
- Draw commands are built only for `_tilesToRender` (QuadtreePrimitive.js:1570+).

Some costs do grow linearly with the number of resident tiles, but only on events:

- **Every frame in which `verticalExaggeration` or its relative height changes**, all loaded tiles are visited (GlobeSurfaceTileProvider.js:556-577):
  - `updateExaggeration` marks each tile's terrain picker for a rebuild (TerrainMesh.js:352-361).
  - Each tile is also pushed to `_tileToUpdateHeights` (GlobeSurfaceTile.js:454-456).
  - In the app this happens every frame of a topography animation, plus one "nudge" frame after it (topography.ts:111-135).
- Imagery layer add, remove, show or hide walks all loaded tiles (GlobeSurfaceTileProvider.js:1230-1377).

## 3. Measurements (Chrome, Cesium 1.145 from jsDelivr, 1512×860 canvas, pixelRatio 1)

Setup:

- Terrain: Re:Earth with `octvertexnormals`, as in the app.
- Imagery: the keyless `services.arcgisonline.com` World_Imagery at z19 (the same tile grid as the keyed endpoint), and EOX z14 for comparison.
- `enableLighting` on.
- Camera: `lookAt` the aircraft point at pitch −12° and range 150 m, which are the ChaseCamera defaults (chaseCamera.ts:113).
- Test page: `scratchpad/understand/lod-measure.html`.
- The pane was hidden and ran at about 30 fps. That changes load timing, not tile counts.

### 3.1 Tiles per frame and for a full orbit (12 headings, 30° apart, `tileCacheSize = 1e6`)

| Place, height above ground, imagery | Entries per frame (visited + culled) | Drawn per frame | Entries after 360° | Tiles with a VA | Textures (MB) | VB+IB MB |
|---|---|---|---|---|---|---|
| Judean hills 31.765N 35.10E, 100 m, Esri z19 | 406 | 177 | **1066** | 998 | 1270 (444) | 65 |
| Meron 32.99N 35.37E, 300 m, Esri z19 | 394 | 160 | **1042** | 963 | 1278 (447) | 63 |
| Judean hills, 2000 m, Esri z19 | 274 | 101 | **778** | 704 | 945 (330) | 77 |
| Judean hills, 300 m, EOX z14 | 386 | 161 | 990 | 920 | 618 (216) | 69 |

- One orbit needs about **2.6–2.8×** the entries of a single frame.
- The levels drawn at 300 m run from L7 far away to L17–L19 near the camera.

### 3.2 Look-back test

The camera faces forward, turns 180° for 8 s while the target moves, then turns forward again.

| tileCacheSize | Entries before turning back | Fresh tile loads in the first 1.5 s | Tiles drawn every 250 ms after turning back |
|---|---|---|---|
| 100 | 318 / 326 | 137 / 149 | 11→31 and 9→14 (coarse) |
| 1200 | 870 / 810 | 78 / 100 (new tiles ahead of the moving target) | 119→162 and 93→125 (near full at once) |

In a static version of the test (the target does not move while the camera looks away, then moves a little):

- `tileCacheSize = 100`: 200 fresh loads, and 16 tiles grew to 160 over ~1.4 s.
- `tileCacheSize = 2000`: 0 fresh loads, and 160 tiles were drawn on the first frame.

### 3.3 Memory per entry (Esri z19)

- **GPU:**
  - Textures: 447 MB / 1042 entries = 0.43 MB (1.23 textures per entry, 1.33 per tile with a VA).
  - Vertex and index buffers: 0.06 MB.
  - Total: **≈0.49 MB per entry**.
  - With EOX z14 it is ≈0.29 MB per entry, because imagery stops at z14 and deep tiles share it.
- **JS heap:** 138 MB with 1066 entries against 84 MB with 254 entries, so **≈65 KB per entry**. This covers the `terrainData`, the CPU copy of `mesh.vertices` and indices, and the picker.

### 3.4 Where these numbers come from, in the source

- **Terrain geometric error.** Quantized mesh uses the heightmap estimate with width 65 over 2 root tiles (CesiumTerrainProvider.js:67, 209-214; TerrainProvider.js:503-525). That gives 77,067 m at L0, halved at each level (CesiumTerrainProvider.js:1148-1151).
- **Imagery level.** It is `round(log2(156,543·cosφ / (77,067/2^L)))`, which is **terrain level + 1** at 31–33°N (ImageryLayer.js:798-810, 1682-1706).
  - The imagery tile at L+1 has the same longitude span as the terrain tile at L, and cosφ ≈ 0.85 of its latitude span.
  - So each terrain tile refers to 2 imagery tiles, or 3 about 18% of the time, and needs ≈1.18 unique ones.
  - Past imagery z19 (Esri), terrain L19 and deeper share z19 textures. Terrain keeps refining by upsampling past z14 because `upsampledFromParent` stays false while the imagery is not FAILED or INVALID (GlobeSurfaceTile.js:335-387; QuadtreePrimitive.js:828-867).
- **Texture size.** Each texture is 256×256 **RGBA** (`UrlTemplateImageryProvider.hasAlphaChannel` defaults to true: UrlTemplateImageryProvider.js:237; ImageryLayer.js:1211-1218), plus mipmaps (+1/3; Texture.js:757-762). That makes **349,525 B**.
  - `hasAlphaChannel:false` would make the textures RGB. The saving on Apple GPUs is doubtful, because RGB8 is usually padded to 4 bytes, so I do not recommend it for memory.
- **Vertex format** (TerrainEncoding.js:624-647):
  - Tiles smaller than 4,095 m (≥ L13) use 12-bit quantization: 3 floats (TerrainEncoding.js:73-77). Coarser tiles use 6 floats.
  - Plus 1 float for web-mercator T, 1 for the oct normal, and **3 for geodetic surface normals**.
  - Geodetic normals are present because the app's exaggeration is never 1 (TOPO_ON ≠ 1, flat = 0; GlobeSurfaceTile.js:436-448, 594-643).
  - So a vertex is 8 floats (32 B), or 11 floats (44 B) for coarse tiles.

## 4. Recommended settings

1. **`viewer.scene.globe.tileCacheSize = 1200`**, in `createViewer` (viewer.ts).
   - It holds a full 360° orbit at 100–2000 m above ground (778–1066 measured) with ~13% headroom, for the default 1512×860 canvas.
   - While the aircraft moves, the LRU evicts the oldest entries first: the ground far behind, and views not seen since the last orbit.
   - The entries that cannot be evicted (~400) are included in the 1200.
   - **Cost:**
     - GPU: up to ~590 MB for the globe, against ~190 MB today (≈400 entries × 0.49 MB). That is **+~400 MB**.
     - JS heap: **+~55 MB**.
     - No steady-state FPS cost (§2).
2. **Bigger screens.** The tiles needed grow with drawing-buffer height (the SSE is proportional to `drawingBufferHeight`: QuadtreePrimitive.js:1261-1264). A 1440-px-high canvas needs about 1.5–2.5× more. Two options:
   - **A:** a fixed 1500 or more. Simple, but it wastes memory on small windows.
   - **B, adaptive (optional):** about once per second after render, `touched = surface._debug.tilesVisited + surface._debug.tilesCulled`, then `globe.tileCacheSize = clamp(max(current, round(3 × touched)), 600, 2000)`.
     - Those counters are reset at `beginFrame` (QuadtreePrimitive.js:312-324) and incremented regardless of `enableDebugOutput` (QuadtreePrimitive.js:723, 1203), so after render they give the last frame's counts.
     - These are private fields: pin a unit test so a Cesium upgrade that breaks them fails loudly.
3. Keep `preloadAncestors = true`, `preloadSiblings = false`, `maximumScreenSpaceError = 2` and the fog defaults (§2).
4. Do **not** expect `tileCacheSize` to help first visits. Tiles you have never seen still refine coarse-to-fine, which is complaint 2.

### Validation (before and after, same route)

- Chrome Task Manager, **GPU memory** column, after 3 full orbits. Expect ≤ +450 MB.
- Ridge FPS p50, which should stay at ~140 headless.
- One topography toggle: frame-time spike, which scales with loaded tiles (§2).
- A look-back count: `loadTile` calls on tiles in `state === 0` within 1.5 s of turning back. Expect ≈ 0 plus the tiles newly ahead.
- `globe.tileCacheSize` has no direct error mode. The risk is memory pressure or WebGL context loss on 8 GB machines: check with the GPU memory column.

## 5. Other things that can re-render a seen area (secondary)

- **Imagery layer show/hide.** `_onLayerShownOrHidden` → `_onLayerRemoved` frees that layer's imagery on **all** loaded tiles. `_onLayerAdded` recreates the skeletons, sets every loaded tile to LOADING, and marks the tiles not drawn this frame as **not renderable** (GlobeSurfaceTileProvider.js:1306-1321, 1328-1364, 1371-1377). In the app:
  - The night-lights layer flips `show` at `alpha > 0.01` (sun.ts:293-295). The alpha depends on night and on camera height through `lightsFactor`. This happens around dusk; if it flickers, add hysteresis.
  - The OSM map layer is hidden and shown on each switch between chase and browse (app.ts:433, 502, 507).
  - The Esri → EOX fallback swaps the layer once (imagery.ts `eoxOnEsriFailure`).
  - `_onLayerAdded`'s reload path also clears `_imageryCache` (GlobeSurfaceTileProvider.js:1242).
- **Terrain provider change or `invalidateAllTiles`:** frees everything (QuadtreePrimitive.js:201-231, 336-339). The app does not do this in chase.
- **Buildings:** not a cause. `buildings.ts` keeps tiles by radius around the aircraft, not by frustum (buildings.ts:31, 323-324).
- **Topography animation:** does not reload tiles. It rewrites exaggeration on every loaded tile each frame (§2), so its cost grows with the cache.

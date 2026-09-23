# Chase view: ground reloads on look-back, and abrupt sharpening

Date: 2026-09-23. Branch: `feat/chase-smooth-lod`. Cesium 1.145.

## The two complaints

1. In chase mode, the user turns the camera away and then back. The ground they already saw loads again, and the hill shading ("shadows") appears again.
2. When the aircraft comes closer to the ground, a sharper tile replaces a blurry one in one frame. A whole rectangle changes at once.

## Causes

1. Cesium keeps at most `globe.tileCacheSize` tiles. The default is 100. One chase frame uses 330 to 400 tiles, and Cesium cannot free those. So every tile outside the view is freed when any tile loads. On the turn back, Cesium loads the view again from coarse to fine. The hill shading comes from the vertex normals of the fine terrain, so it appears again as the fine tiles arrive. Details: [cesium-cache.md](cesium-cache.md).
2. `TileImagery.processStateMachine` replaces the coarse ancestor texture with the sharp texture in one frame. Cesium has no fade for globe imagery (issue #8140 has been open since 2019). Details: [cesium-refine.md](cesium-refine.md). Other engines: [prior-art.md](prior-art.md).

## Fixes

- `client/scene/tileCache.ts` sizes `globe.tileCacheSize` from the tiles one frame uses. The size is 3 × that number, from 400 to 2000 tiles. One full orbit needs 2.6 to 2.8 ×. The size shrinks over about 60 s after the view needs fewer tiles.
- `client/scene/imageryFade.ts` fades each sharper base-imagery tile in over 600 ms. It keeps the ancestor texture below the new texture. It patches three exported Cesium prototypes and changes no Cesium file. If a Cesium upgrade removes a private field that the patch uses, the patch does not install, and the globe changes tiles in one frame as before.
- `createViewer` (`client/scene/viewer.ts`) turns both on. `app.ts` does not change.

## Results

Headless Chrome, Metal, 1280 × 800. The full tables are in [RESULTS.md](RESULTS.md).

| | Before | After |
|---|---|---|
| Tiles loaded again on a 180° turn back, 300 m above the ground | 186 | 0 |
| Tiles loaded again per full orbit, 300 m | 773 | 0 |
| Largest change of a 32-pixel block in one 100 ms step (median, still camera, measured at a fade cap of 96) | 100 % | 45 % |
| Globe GPU memory after two orbits | 89 MB | 265 MB |
| JS heap after garbage collection, after two orbits | 143 MB | 242 MB |
| Frame rate at the 60 Hz cap, 20 s flight | 60 fps | 60 fps |
| Frame rate with no cap, same load (p50) | 92.6 fps | 90.1 fps |
| Worst frame when the street map hides (browse to chase), one run each | 22.0 ms | 22.2 ms |

Evidence:

- [compare-lookback.png](compare-lookback.png): the first 0.6 s after a turn back.
- [compare-refine.png](compare-refine.png): one zoomed area while it sharpens, fade off and fade on.

## Known limits

- The fade covers the base imagery only. When the terrain mesh itself refines (level 14 and coarser, more than about 5 km from the camera in chase), the hill shading still changes in one frame.
- A fill tile (a stand-in for a tile with no terrain yet) that gets its imagery during the draw changes in one frame.
- Full sharpness arrives about 0.6 s later than before. This is the cost of the fade.

## Measure again

The test page is `harness/lod.html` (see its header for the URL parameters and `window.__lod`). The drivers are in [driver/](driver/). Copy them to a scratch folder before you run them, because they write browser profiles and results next to themselves.

1. Serve the worktree with Vite on port 5190.
2. Run `node fix-driver.mjs <run> s1:OLD:300 s1:NEW:300` for the look-back test.
3. Run `node fix-driver.mjs <run> fly:0 fly:1` for the flight test.
4. Stop Chrome and Vite when the run ends.

The drivers cap the frame rate by default. Set `UNCAPPED=1` only for short frame-rate tests, because an uncapped run uses the whole GPU. The Re:Earth terrain server returns HTTP 429 after many runs with a new browser profile in a short time.

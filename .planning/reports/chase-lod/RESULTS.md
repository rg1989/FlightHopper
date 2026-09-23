# Chase LOD fix: measured results (2026-09-23)

Worktree `FlightHopper-lod`, branch `feat/chase-smooth-lod`: WIP 516dae5 plus the uncommitted `imageryFade.ts` edits (MAX_FADES 256; a fade that waits behind a drawn parent stays alive).
Harness: `harness/lod.html`. I added `__lod.toggleTopo()` to `harness/lod.ts`. It is the T key: flatten or grow, with frame and CPU times over the 2.5 s animation. `tsc` is clean.
Drivers: `fix-driver.mjs` (new), `fade-driver.mjs` (sse0/sse1 with TAG=fix), `make-sheets.mjs`. Raw data: `results-fix.json`.
Setup: headless Chrome with Metal at 1280×800, capped at the display rate except for step (e). One Chrome at a time. Vite on 5190, CDP on 9350. Chrome and vite were stopped at the end, and `pgrep` found neither.

- **OLD** = `?tileCache=100&fade=0`: Cesium's default cache, no fade.
- **NEW** = defaults: `tileCache=auto` and fade on.

## Rate limiting (429) and the warm cache

The first cold OLD and NEW pair at 300 m got 144 and 142 terrain 429s. NEW lost 133 of 174 terrain requests on back180. These runs are kept in `results-fix.json` as `*-cold` and are not used below.

All look-back, topography and memory runs then used a copy of one warmed profile, made by a capped warm-up pass per altitude. The warm-up at 1500 m got 129 429s itself. Every measured run had 0 429s. The S2 flights (b) had cold profiles, 90 s apart, with 0 429s. The fade-driver SSE runs do not record HTTP status.

A warm cache does not change the quadtree counters: loads, reloads, frees and imagery re-requests are counted inside Cesium. It does make an OLD reload faster on screen than on a cold network.

## (a) Complaint 1, the look-back reload: FIXED

The legs are away180, back180 (continues to 360), orbit360a, orbit360b and snapBack. snapBack is an instant 180° turn away, then idle, then an instant turn back.

| agl | leg | OLD loads / **reloads** / freed | OLD imagery req / **re-req** | NEW loads / **reloads** / freed | NEW imagery req / **re-req** |
|---|---|---|---|---|---|
| 300 | away180 | 391 / 0 / 344 | 213 / 0 | 391 / 0 / 0 | 213 / 0 |
| 300 | back180 | 400 / **186** / 397 | 177 / **97** | 214 / **0** / 0 | 80 / **0** |
| 300 | orbit360a | 773 / **773** / 773 | 373 / **373** | 0 / 0 / 0 | 0 / 0 |
| 300 | orbit360b | 773 / **773** / 773 | 373 / **373** | 0 / 0 / 0 | 0 / 0 |
| 300 | snapBack | 169 / **169** / 168 | 86 / **86** | 0 / 0 / 0 | 0 / 0 |
| 1500 | away180 | 350 / 0 / 305 | 204 / 0 | 350 / 0 / 0 | 204 / 0 |
| 1500 | back180 | 332 / **149** / 340 | 159 / **84** | 184 / **0** / 0 | 72 / **0** |
| 1500 | orbit360a | 669 / **668** / 668 | 346 / **346** | 0 / 0 / 0 | 0 / 0 |
| 1500 | orbit360b | 669 / **668** / 669 | 346 / **346** | 0 / 0 / 0 | 0 / 0 |
| 1500 | snapBack | 149 / **149** / 144 | 84 / **84** | 0 / 0 / 0 | 0 / 0 |

With OLD, every orbit reloads 100 % of what it passes over. The requests are served from the browser cache because the profile is warm. On a cold network they go to the server, as in the `-cold` runs. With NEW, after one orbit nothing is freed, loaded or requested again.

Some NEW back180 loads are not reloads. back180 continues in the same direction, so it covers the other half of the circle for the first time.

| | OLD 300 | NEW 300 | OLD 1500 | NEW 1500 |
|---|---|---|---|---|
| peak replacement queue | 330–354 | 366 → 742 → **894** | 290–330 | 322 → 678 → **810** |
| `globe.tileCacheSize` chosen | 100 (fixed) | 1000 → 1100, 1050 at the end | 100 | 950 → 1000, 950 at the end |
| network per 360° orbit (terrain + Esri requests) | 629 + 373 (all from cache) | 0 + 0 | 665 + 346 | 0 + 0 |
| snapBack: coarse "waiting" tiles in the first frames | 55 → 52 → 37 → 15 → 0 by 0.61 s | 0 throughout | (not captured) | 0 |

The `back180` legs settled within 0–51 ms of the orbit end in both configurations. With OLD, the reload happens during the 3 s orbit.

**Evidence sheet** (`sheet-lookback.png`): the first 1.5 s after the snap back, every 150 ms, OLD row above the NEW row.

- OLD at 0.02 s: the whole view is the coarse parent imagery. The forest and the road network are smeared, and the ridge on the far right is brown and soft.
- OLD at 0.31 s: the foreground is sharp, but the far-right ridge is still coarse (37 tiles waiting).
- OLD from 0.61 s: fully sharp.
- NEW: fully sharp from the very first frame (0.01 s). All 11 NEW frames are identical.

## Memory cost (the price of fix 1)

GPU is estimated by walking the tile LRU: distinct imagery textures, using `Texture.sizeInBytes`, which is within 1 % of 349,525 B per texture, plus the distinct terrain and fill vertex and index buffers. JS heap is measured after a forced GC (`mem-OLD` and `mem-NEW`: the first idle, then after two 360° orbits).

| | OLD | NEW |
|---|---|---|
| LRU tiles after orbits (300 m / 1500 m) | 322 / 286 | 894 / 810 |
| imagery textures | 161 → **52.9 MB** | 427 → **141.6 MB** |
| vertex and index buffers | 35.8 MB | 123.2 MB |
| **globe GPU total** (300 m / 1500 m) | **88.7 / 84.7 MB** | **264.8 / 259.7 MB** (+176 MB) |
| JS heap after GC, first idle | 132 MB | 140 MB |
| **JS heap after GC, after 2 orbits** | **143 MB** | **242 MB** (+99 MB) |
| S2 flight, 20 s (auto cache in both) | — | 766–770 LRU tiles, 143–150 MB GPU, size 1150 |

About 0.30 MB of GPU memory per LRU entry. At MAX_TILES 2000 that is about 590 MB.

## (b) Complaint 2, abrupt refinement: S2 flight 20 s, auto cache, fade=0 vs fade=1

Both runs used cold profiles, 90 s apart, with 0 429s and 0 page errors. Load averages were 5.7 and 4.9.

| | fade=0 | fade=1 |
|---|---|---|
| blur debt per second: blurTiles avg (max) | 0 (2 in s0, then 0) | 0 (4 in s2, then 0) |
| blurLevels avg, maxGap | 0, 1 (s0 only) | 0.1 (s2), 1 (s2 only) |
| waiting (avg per second) | 0–0.9 | 0.1–0.3 |
| tiles loaded, freed | 201, 0 | 201, 0 |
| harness imageryPops (level rises on drawn tiles) | 2 | 6 (all in s2) |
| refines (parent → 4 children in one frame) | 59 | 59 |
| fades started / finished / expired / cancelled / orphaned | — | 356 / 339 / 3 / 0 / 0 (14 still running at 20 s) |
| fades skipped: offscreen / refined / **cap** / layer | — | 0 / 0 / **0** / 0 |
| active fades (max, sampled 4× per s) | — | 36 |
| refsHeld at idle after the flight | 0 | **0** (idle after 7.9 s; all 555 fades done: 551 finished, 4 expired) |
| fps p50 / p5, frame p95, cpu p50 / p95 (capped) | 59.9 / 55.9, 17.9, 3.1 / 4.2 ms | 59.9 / 56.5, 17.7, 2.7 / 3.5 ms |

In flight, almost no drawn tile waits on imagery (blur debt ≈ 0 in both). The abrupt change is the refine: a parent replaced by 4 children that already have sharper imagery, about 3 per second. The fade catches these through the kicked path, which starts the clock at the child's first draw: about 18 fades per second.

The harness "imageryPops" count does not tell faded swaps from instant ones, so it is not a visibility metric.

### Still-camera refinement A/B (SSE 8 → 2 at t = 0, 300 m, cold profile)

| | fade=0 | fade=1 |
|---|---|---|
| fades started / finished / retargeted / expired | — | 242 / 228 / 15 / 14 |
| skipped: refined / **cap** | — | 19 / **0** (was 141 of 237 at MAX_FADES 96) |
| **peak active fades** | — | **242** (MAX_FADES is 256) |
| harness pops | 31 | 11 |
| refsHeld after settle | 0 | 0 |

**Evidence sheet** (`sheet-refine.png`): fade=0 row above fade=1, every 100 ms, 0–1.0 s.

- fade=0: blurry at 0.0–0.2 s. By 0.4 s it is essentially fully sharp, with a hard jump between 0.2 and 0.4 s (pops 7 → 12 → 31 by 0.6 s).
- fade=1: 0.1 and 0.2 s look like fade=0's blurry frames. At 0.3 s detail is partly dissolved in, and at 0.6 s the view is a soft half-blend (242 fading). It reaches full sharpness at about 1.1–1.2 s (76 → 29 → 14 fading). Frame to frame there is no hard tile-shaped change in the frames I inspected at full size (0.1, 0.2, 0.3 and 0.6 s).
- The cost of the gradual look: full sharpness arrives about 0.6 s later than without the fade, by design.

## (c) Topography toggle cost (T key after one 360° orbit; warm profile; capped)

| | cache 100 (322 LRU tiles) | auto (894 LRU tiles, size 1000–1100) |
|---|---|---|
| still, no toggle: frame p95 / max, cpu p50 / p95 | 17.6 / 18.2, 2.5 / 3.3 ms | 17.7 / 18.8, 3.1 / 3.7 ms |
| **flatten**, 2.52 s, 151 frames: frame p50 / **p95** / **max** | 16.6 / **17.9** / **24.8** | 16.7 / **17.6** / **25.7** |
| flatten: cpu p50 / p95 / max | 4.5 / 5.5 / 12.5 ms | 4.5 / 5.0 / 12.3 ms |
| **grow**, 2.53 s, 152 frames: frame p50 / **p95** / **max** | 16.7 / **17.7** / **18.8** | 16.6 / **17.9** / **19.1** |
| grow: cpu p50 / p95 / max | 4.4 / 5.5 / 6.7 ms | 4.7 / 5.5 / 6.2 ms |

Walking 2.8× as many tiles each animation frame costs no measurable time: the differences are within ±0.5 ms and go both ways. The toggle itself adds about 2 ms of CPU per frame in both configurations. At a 60 Hz cap, frame time hides anything under about 14 ms, so the CPU column is the useful one.

## (e) FPS, uncapped, S2 flight 20 s, one Chrome, warm profile

| run | load avg (1 min) before | fps p50 / p5 | frame p50 / **p95** / p99 | cpu p50 / p95 | cache |
|---|---|---|---|---|---|
| OLD | 19.8 | 100.0 / 76.9 | 10.0 / **13.0** / 16.7 | 9.1 / 11.9 | 100 |
| NEW | 35.3 | 89.3 / 54.6 | 11.2 / **18.3** / 24.9 | 9.8 / 15.7 | 1200 |
| OLD | 46.9 | 92.6 / 70.4 | 10.8 / **14.2** / 19.5 | 9.7 / 13.1 | 100 |
| NEW | 45.8 | 90.1 / 64.9 | 11.1 / **15.4** / 20.7 | 9.9 / 14.1 | 1200 |

The second pair ran at matched load. NEW is 2.7 % lower at fps p50 and 8 % lower at p5, frame p95 is +1.2 ms, and cpu p50 is +0.2 ms. The first pair ran at different loads (20 vs 35), so its −11 % is not trustworthy.

Conclusion: a small cost, a few percent, below the machine noise. The capped runs in (b) and (c) show none.

**Budget overrun:** the uncapped Chrome ran for **190.7 s**, not the < 120 s asked. The four page loads took 12–44 s even with the warm profile. The load average rose from 6 to 46 while this step ran (the uncapped browser and other activity), and fell back afterwards.

## Anything worse

- **Memory:** +176 MB GPU and +99 MB JS heap after an orbit at 1280×800. This is the intended trade.
- **Fade cap headroom:** the SSE 8→2 mass refinement peaked at 242 active fades against MAX_FADES 256. A larger window, such as the user's 1512×860 or a full screen, will likely exceed 256. The excess then swaps instantly (skippedCap), which is only a partial return of the pop in that case.
- **Expired fades:** 47–70 during an S1 initial load and 29–64 during a 180° orbit (3–4 in the flight, 14 in the SSE test). These are tiles that swapped and then were neither drawn nor waiting behind a drawn parent for 2 s. They are off screen, so no pop is visible. The count is not ~0, but it does not reach the screen as far as I can tell.
- **Sharpness delay:** the fade makes full sharpness arrive about 0.6 s later.
- No page errors or exceptions in any run. refsHeld returned to 0 at idle in every run.

## Remaining visible pops (not covered by this change)

- **Terrain geometry and hillshade refinement is still instant.** The fade covers only the base imagery texture. A parent replaced by children whose mesh and normals differ still changes in one frame (the "waiting" column: 44 → 0 over 0.1–0.6 s in the SSE test, 0.1–0.3 per second in flight). I did not isolate this visually. In the frames I inspected it is not obvious under the imagery fade.
- **skippedRefined:** 19 swaps in the SSE test and about 40 during each S1 initial load were not faded, because the tile had already refined into children at swap time. The children fade on their own draw if they were kicked.
- **Night lights and the OSM layer** are never faded, by design.
- **OLD-style reloads return** only if the cache shrinks. It decays with a 60 s time constant after leaving chase, and a look-back after a long look at the sky is not tested here.

## Files

- `sheet-lookback.png` (+ `.html`): frames in `shots/fix-lookback-{OLD,NEW}-agl300/`
- `sheet-refine.png` (+ `.html`): frames in `shots/sse0fix/`, `shots/sse1fix/`
- `results-fix.json`: all runs
- Logs: `run-*.log`

// client/scene/tileCache.ts
// Adaptive globe.tileCacheSize (spec design A, feat/chase-smooth-lod). Cesium's default of 100 (Globe.js:116) counts every
// entry of the tile LRU, including the ones this frame used, which are never evicted (TileReplacementQueue.js:32-54,
// QuadtreePrimitive.js:112-120). A chase frame alone touches 274–406 entries (measured 2026-09-23, 1512×860, Judean hills /
// Meron / 2 km AGL), so every tile out of view was freed whenever anything loaded, and orbiting back reloaded ~100 % of the
// view (137–200 loads, coarse→fine hill shading replayed over ~1.4 s). One full 360° orbit needs 2.6–2.8× one frame's
// entries (778–1066 measured), so the cache follows ORBIT_X × the entries a frame touches, on any screen size.
import type { Viewer } from 'cesium'

export const ORBIT_X = 3 // cache entries per entry touched this frame: one orbit needs 2.6–2.8× (measured), +7–15 % headroom
export const MIN_TILES = 400 // floor: about one chase frame, so browse views and small windows still keep their look-back
export const MAX_TILES = 2000 // ceiling: ~1 GB GPU worst case at ~0.49 MB/entry with Esri z19 (textures 0.43 + VB/IB 0.06), ~130 MB JS heap
export const FALLBACK_TILES = 1200 // fixed size when Cesium's private counters are missing: one orbit at 1512×860 (778–1066) + ~13 %
export const STEP_TILES = 50 // sizes are multiples of this, so noise of a few entries never rewrites the size
export const PEAK_TAU_S = 60 // the peak decays as exp(-t / 60 s): −15 % after a 10 s look at the sky, 1/e after a minute
export const SHRINK_MARGIN = 1.1 // a shrink sizes for 1.1 × the peak, so a peak wobbling by < 10 % never flips the size back and forth

/**
 * The cache size for a frame that touched `entriesPerFrame` LRU entries: ORBIT_X × entries, rounded up to STEP_TILES and
 * clamped to [MIN_TILES, MAX_TILES]. Zero, negative or NaN → MIN_TILES. Pure.
 */
export function tileCacheSizeFor(entriesPerFrame: number): number {
  if (!(entriesPerFrame > 0)) return MIN_TILES
  const size = Math.ceil((ORBIT_X * entriesPerFrame) / STEP_TILES) * STEP_TILES
  return Math.min(MAX_TILES, Math.max(MIN_TILES, size))
}

/** QuadtreePrimitive's counters (QuadtreePrimitive.js:57-75). Private. */
interface SurfaceDebug { tilesVisited: number; tilesCulled: number }
/** The Globe fields this reads and writes; `_surface` is the globe's QuadtreePrimitive (Globe.js:59). Private. */
interface GlobeInternals { tileCacheSize: number; _surface?: { _debug?: Partial<SurfaceDebug> } }

export interface TileCacheOpts {
  /** Clock for the peak decay, in ms (default performance.now). A test seam. */
  nowMs?: () => number
}

/**
 * Keeps viewer.scene.globe.tileCacheSize at tileCacheSizeFor(peak), where peak is a decaying maximum of the LRU entries a
 * frame touched. Read after each render (scene.postRender, raised only for rendered frames: Scene.js:4709-4711).
 *
 * The entries a frame touches = `_surface._debug.tilesVisited + tilesCulled`:
 * - both are zeroed at each render-pass beginFrame (clearTileLoadQueue, QuadtreePrimitive.js:312-319, called at 344);
 *   other passes do not reset them (beginFrame returns at 332-334), so after render they hold this frame's counts;
 * - they are incremented with no enableDebugOutput check, next to the markTileRendered of each visited tile (723-725) and
 *   of each culled child the traversal looked at (1203-1204), which are most of the entries the LRU counts; measured:
 *   list count 394 = 258 visited + 136 culled (2026-09-23). Not counted: level-zero tiles (589), the children of a tile
 *   drawn for upsampled-only children (847-851) and the load queue's marks (1379): a handful, mostly also visited.
 *
 * Growth is written at once (the next trim, QuadtreePrimitive.js:1316-1326, must not free the orbit). Shrinking follows the
 * peak's decay (PEAK_TAU_S) with SHRINK_MARGIN hysteresis, so leaving chase gives the memory back over about a minute and
 * the size never churns: writes happen only when the quantised size changes. Allocates nothing per frame.
 *
 * ponytail: reads Cesium 1.145's private `globe._surface._debug` counters. If they are missing (an upgrade renamed them),
 * the size is set to FALLBACK_TILES once and nothing listens. tileCache.test.ts pins the field names on a real Globe.
 * Upgrade: count the entries another way (e.g. `_surface._tileReplacementQueue.count`) or keep the fixed size.
 */
export class TileCache {
  #viewer: Viewer
  #nowMs: () => number
  #remove: (() => void) | undefined
  #size = 0
  #peak = 0
  #lastMs = NaN

  constructor(viewer: Viewer, opts: TileCacheOpts = {}) {
    this.#viewer = viewer
    this.#nowMs = opts.nowMs ?? (() => performance.now())
    if (!this.#debug()) {
      this.#write(FALLBACK_TILES)
      return
    }
    this.#write(MIN_TILES) // Cesium's 100 would trim the first frames down to the frame itself
    this.#remove = viewer.scene.postRender.addEventListener(this.#onPostRender)
  }

  /** The size last written to globe.tileCacheSize (0 before any write, i.e. no globe). */
  get size(): number { return this.#size }

  /** Stops listening. Leaves globe.tileCacheSize as it is. Idempotent. */
  destroy(): void {
    this.#remove?.()
    this.#remove = undefined
  }

  #globe(): GlobeInternals | undefined {
    return this.#viewer.scene.globe as unknown as GlobeInternals | undefined // undefined with `globe: false`
  }

  #debug(): SurfaceDebug | undefined {
    const d = this.#globe()?._surface?._debug
    return d && typeof d.tilesVisited === 'number' && typeof d.tilesCulled === 'number' ? (d as SurfaceDebug) : undefined
  }

  #write(size: number): void {
    const globe = this.#globe()
    if (!globe) return
    globe.tileCacheSize = size
    this.#size = size
  }

  #onPostRender = (): void => {
    const d = this.#debug()
    if (!d) { // the globe was swapped for one without the counters
      this.destroy()
      if (this.#size !== FALLBACK_TILES) this.#write(FALLBACK_TILES)
      return
    }
    const now = this.#nowMs()
    const dtS = now > this.#lastMs ? (now - this.#lastMs) / 1000 : 0 // first frame (NaN) or a clock step back: no decay
    this.#lastMs = now
    this.#peak = Math.max(d.tilesVisited + d.tilesCulled, this.#peak * Math.exp(-dtS / PEAK_TAU_S))
    const grow = tileCacheSizeFor(this.#peak)
    if (grow > this.#size) return this.#write(grow)
    const shrink = tileCacheSizeFor(this.#peak * SHRINK_MARGIN)
    if (shrink < this.#size) this.#write(shrink)
  }
}

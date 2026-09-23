// client/scene/imageryFade.ts
// Per-tile imagery cross-fade (spec design B, feat/chase-smooth-lod). When a sharper base-imagery tile arrives, Cesium swaps
// it for the coarse ancestor a globe tile was drawn with in one frame (TileImagery.js:60-69, 90-101): a whole terrain-tile
// rectangle pops, 2× to 16× sharper. Here the ancestor stays underneath and the new texture's alpha ramps 0 → 1 over
// FADE_MS (smoothstep), the same time however many levels the swap jumps, from the tile's first draw after the swap. A
// monkey-patch of Cesium's exported private classes, no fork: the imagery array is swapped for [ancestor, new at alpha t]
// only while GlobeSurfaceTileProvider.endUpdate builds the draw commands (GlobeSurfaceTileProvider.js:596-624), and put
// back in a finally. Only fading tiles change their draw (one more texture, the APPLY_ALPHA shader variant); the draw
// command count is unchanged. Research: cesium-refine.md §A, with the corrections noted at each piece below.
// Measured 2026-09-23, harness/lod (headless Chrome, Metal, 1280×800): the Inn-valley chase flight at 90 m/s starts ~18
// fades/s, ≤ 36 at once, none capped; at the 60 Hz cap frame time p95 17.4 ms with the fade vs 17.7 ms without, uncapped
// p50 90.1 vs 92.6 fps at matched load (the adaptive tile cache on in both). Still camera, SSE 8 → 2 (at MAX_FADES 96,
// 141 of 237 swaps capped): without the fade the largest 100 ms step carries a median 100 % of a 32-px block's change, with
// it 45 % (63 % of blocks change over ≥ 4 steps); at 256 none capped (≤ 242 at once). Settled frames are pixel-identical.
// Named imports, not `import * as Cesium`: a namespace object makes the bundler keep all of Cesium (+0.7 MB, 4.28 →
// 4.98 MB app chunk, measured 2026-09-23). The private classes are exported at runtime but missing from Cesium.d.ts. A
// Cesium that drops one fails the build (a missing export), which is louder than the install check below.
import {
  GeographicTilingScheme,
  // @ts-expect-error: private, not in Cesium.d.ts
  GlobeSurfaceTileProvider,
  // @ts-expect-error: private, not in Cesium.d.ts
  Imagery,
  ImageryLayer,
  // @ts-expect-error: private, not in Cesium.d.ts
  ImageryState,
  // @ts-expect-error: private, not in Cesium.d.ts
  QuadtreeTile,
  // @ts-expect-error: private, not in Cesium.d.ts
  TileImagery,
  // @ts-expect-error: private, not in Cesium.d.ts
  TileSelectionResult,
} from 'cesium'
import { smoothstep } from './exaggeration.ts'

export const FADE_MS = 600 // smoothstep; the user asked for a gradual, "cinematic" sharpening (spec, 2026-09-23)
export const MAX_FADES = 256 // concurrent (drawn or waiting); above it a swap is instant, as without the fade. Each fading
// imagery tile costs one more texture sample per fragment of its terrain tile (1–3 base imagery tiles per terrain tile, so a
// few per pixel at most) and no draw command while the day textures fit maxTextures; the cap bounds that, the registry's
// per-frame walk and the ancestors held. At 96 a view reloaded after orbiting back (Cesium's 100-tile cache) capped 303 of
// 663 swaps and SSE 8 → 2 capped 141 of 237; at 256 SSE 8 → 2 peaked at 242, none capped (harness, 2026-09-23)
export const EXPIRE_MS = 2000 // a fade whose tile is neither drawn nor waiting behind a drawn ancestor for this long is
// dropped (it went off screen before its first draw); waiting behind the parent keeps it alive
export const MIN_ALPHA = 1e-3 // alpha 0 would skip the slot (GlobeSurfaceTileProvider.js:3004) and flip the shader variant

// TileSelectionResult.js values (checked against Cesium's at install).
const RENDERED = 2
const REFINED = 3
const RENDERED_AND_KICKED = 6
const REFINED_AND_KICKED = 7

// ---------- the private Cesium shapes this module touches ----------
// ponytail: tied to Cesium 1.145's private globe internals (TileImagery.readyImagery/loadingImagery/…, Imagery refcounts,
// QuadtreeTile._lastSelectionResult(Frame), ImageryLayer
// ._calculateTextureTranslationAndScale). installImageryFade feature-detects them and patches nothing when one is missing
// (no fade, Cesium's plain swap). Upgrade: re-check TileImagery.js, GlobeSurfaceTileProvider.js (endUpdate, the day-texture
// loop at 2999-3173) and QuadtreePrimitive.js (selection results) on a Cesium bump; imageryFade.test.ts fails if they go.

/** Imagery.js: one imagery tile, reference-counted; its last release destroys its textures. */
interface Img {
  imageryLayer: Layer
  level: number
  state: number
  parent?: Img
  texture?: unknown
  textureWebMercator?: unknown
  credits?: unknown
  addReference(): void
  releaseReference(): number
  isDestroyed?: () => boolean // only after destroyObject
}
/** ImageryLayer.js: the fields read here; the draw loop reads the rest through the proxy's prototype. */
interface Layer {
  alpha: number
  isBaseLayer(): boolean
  isDestroyed(): boolean
  _calculateTextureTranslationAndScale(tile: QTile, ti: TIView): unknown
}
/** TileImagery.js: one terrain tile ↔ one imagery tile. readyImagery is what is drawn (maybe an ancestor). */
interface TI {
  readyImagery?: Img
  loadingImagery?: Img
  textureTranslationAndScale?: unknown
  textureCoordinateRectangle: unknown
  useWebMercatorT: boolean
}
type TIView = Pick<TI, 'readyImagery' | 'useWebMercatorT'>
/** GlobeSurfaceTile.js: the globe tile's data. */
interface SurfaceTile { imagery: TI[] }
/** QuadtreeTile.js: selection state of the last frame it was visited. */
interface QTile { data?: SurfaceTile; rectangle?: unknown; _lastSelectionResult: number; _lastSelectionResultFrame?: number }
interface FrameStateLike { frameNumber: number }

type ProcessStateMachine = (this: TI, tile: QTile, frameState: FrameStateLike, skipLoading?: boolean) => boolean
type FreeResources = (this: TI) => void
type EndUpdate = (this: unknown, frameState: FrameStateLike) => void

/** One refinement being faded. Owns exactly one addReference on `from`, released once by end(). */
interface Fade {
  group: Group
  ti: TI
  from: Img // what the tile was drawn with before the swap: kept alive, drawn underneath
  after: Img // ti.readyImagery since the swap (moves on when the tile refines again mid-fade)
  aliveMs: number // the swap, then the last frame it waited behind a drawn ancestor (EXPIRE_MS counts from here)
  startMs: number // first draw after the swap, -1 until then
  seenFrame: number
  proxyLayer: Layer // Object.create(real layer) with its own alpha: brightness, night alpha, … read through
  proxy: ImgProxy // `after` through proxyLayer
  companion: TI // `from`, on ti's rectangle, below
  proxyTI: TI // `proxy`, on top
}
/** The fades of one globe tile, and the array drawn in place of its imagery while they run. */
interface Group { tile: QTile; st: SurfaceTile; list: Fade[]; aug: TI[]; orig: TI[] }

type EndReason = 'finished' | 'expired' | 'cancelled'
const counts = { started: 0, finished: 0, retargeted: 0, expired: 0, cancelled: 0, orphaned: 0, skippedOffscreen: 0, skippedRefined: 0, skippedCap: 0, skippedLayer: 0 }
export type FadeStats = typeof counts & { enabled: boolean; installed: boolean; active: number; refsHeld: number }

const byTI = new Map<TI, Fade>()
const bySurface = new Map<SurfaceTile, Group>()
const groups: Group[] = [] // dense: walked every frame
const swapped: Group[] = [] // scratch: the groups whose imagery array is swapped during this endUpdate
let refsHeld = 0
let drawing = false // inside GlobeSurfaceTileProvider.endUpdate
let enabled = true
let installed = false
let imageryReady = 4 // ImageryState.READY, read from Cesium at install

/**
 * The switch and counters, for the app (viewer.ts), the harness and the tests. Turning it off ends every fade at once
 * (their extra references released). `now` is the clock (a seam for tests). stats(): counts since the last resetStats(),
 * plus `active` and `refsHeld` now (both 0 when idle; every fade holds exactly one reference).
 */
export const imageryFade = {
  get enabled(): boolean {
    return enabled
  },
  set enabled(on: boolean) {
    enabled = on
    if (!on) for (const f of byTI.values()) end(f, 'cancelled')
  },
  durationMs: FADE_MS,
  now: (): number => performance.now(),
  stats(): FadeStats {
    return { ...counts, enabled, installed, active: byTI.size, refsHeld }
  },
  resetStats(): void {
    for (const k of Object.keys(counts) as (keyof typeof counts)[]) counts[k] = 0
  },
}

// ---------- pure pieces ----------

/** The new texture's alpha u of the way through a fade: smoothstep, never below MIN_ALPHA. */
export function fadeAlpha(u: number): number {
  return Math.max(MIN_ALPHA, smoothstep(u))
}

/**
 * Whether an imagery swap in frame `frameNumber` would show, from the tile's selection result that frame. The swap runs in
 * endFrame after the frame's selection and draw (Scene.js render: globe.render then globe.endFrame, one frameNumber), so the
 * result is this frame's. 'visible': drawn (RENDERED), or waiting behind a drawn ancestor (RENDERED_AND_KICKED: its first
 * draw would pop). 'refined': its descendants are, or once the kick lifts will be, drawn instead (REFINED, and
 * REFINED_AND_KICKED: an ancestor above kicked its subtree, QuadtreePrimitive.js:907-920); preloadAncestors loads it, and
 * a fade would only show on a later coarsening, from something blurrier than what was on screen. 'offscreen': culled or
 * not visited: it appears later already sharp, so a pop is invisible and a fade would only delay the detail.
 */
export function swapVisibility(result: number, resultFrame: number | undefined, frameNumber: number): 'visible' | 'refined' | 'offscreen' {
  if (resultFrame !== frameNumber) return 'offscreen'
  if (result === RENDERED || result === RENDERED_AND_KICKED) return 'visible'
  return result === REFINED || result === REFINED_AND_KICKED ? 'refined' : 'offscreen'
}

// ---------- the registry ----------

/** The first READY ancestor with a usable texture: what TileImagery.js:71-77 would draw while `img` loads. */
function readyAncestor(img: Img, useWebMercatorT: boolean): Img | undefined {
  let a = img.parent
  while (a !== undefined && (a.state !== imageryReady || (!useWebMercatorT && a.texture === undefined))) a = a.parent
  return a
}

/**
 * `after` as the draw loop sees it on top, through the fade's layer: the loop reads only imageryLayer, texture or
 * textureWebMercator, and credits from a readyImagery (GlobeSurfaceTileProvider.js:3001-3170). A class, not
 * Object.create(after): that would turn each live Imagery into a V8 prototype with its own map, and the draw loop's
 * property reads on Cesium's imagery would go polymorphic for good.
 */
class ImgProxy {
  img: Img
  imageryLayer: Layer
  constructor(img: Img, imageryLayer: Layer) {
    this.img = img
    this.imageryLayer = imageryLayer
  }
  get texture(): unknown { return this.img.texture }
  get textureWebMercator(): unknown { return this.img.textureWebMercator }
  get credits(): unknown { return this.img.credits }
}

/** Takes over the reference already added on `from`. */
function begin(tile: QTile, st: SurfaceTile, ti: TI, from: Img, after: Img, nowMs: number): void {
  const layer = after.imageryLayer
  const proxyLayer = Object.create(layer, { alpha: { value: MIN_ALPHA, writable: true } }) as Layer
  // The ancestor's UV mapping on this terrain tile, as Cesium computes it for a stand-in (ImageryLayer.js:1061-1093).
  const fromTS = layer._calculateTextureTranslationAndScale(tile, { readyImagery: from, useWebMercatorT: ti.useWebMercatorT })
  let g = bySurface.get(st)
  if (g === undefined) {
    g = { tile, st, list: [], aug: [], orig: st.imagery }
    bySurface.set(st, g)
    groups.push(g)
  }
  const rect = ti.textureCoordinateRectangle
  const proxy = new ImgProxy(after, proxyLayer)
  const f: Fade = {
    group: g, ti, from, after, aliveMs: nowMs, startMs: -1, seenFrame: -1, proxyLayer, proxy,
    companion: { readyImagery: from, loadingImagery: undefined, textureTranslationAndScale: fromTS, textureCoordinateRectangle: rect, useWebMercatorT: ti.useWebMercatorT },
    proxyTI: { readyImagery: proxy as unknown as Img, loadingImagery: undefined, textureTranslationAndScale: ti.textureTranslationAndScale, textureCoordinateRectangle: rect, useWebMercatorT: ti.useWebMercatorT },
  }
  g.list.push(f)
  byTI.set(ti, f)
  refsHeld++
  counts.started++
}

/** Ends a fade: out of the registry, its reference on `from` released (never on a destroyed layer's imagery). */
function end(f: Fade, reason: EndReason): void {
  if (byTI.get(f.ti) !== f) return
  byTI.delete(f.ti)
  const g = f.group
  const list = g.list
  list[list.indexOf(f)] = list[list.length - 1]
  list.pop()
  if (list.length === 0) {
    bySurface.delete(g.st)
    groups[groups.indexOf(g)] = groups[groups.length - 1]
    groups.pop()
  }
  refsHeld--
  release(f.from)
  counts[reason]++
}

/** Gives back a fade's reference, never on a destroyed layer's imagery (a missed release path: nothing safe to release). */
function release(from: Img): void {
  if (from.imageryLayer.isDestroyed() || from.isDestroyed?.() === true) counts.orphaned++
  else from.releaseReference()
}

/**
 * A readyImagery change seen by the processStateMachine wrapper. `before` carries the wrapper's extra reference: kept by a
 * new fade, else released here.
 */
function onSwap(tile: QTile, ti: TI, before: Img, after: Img, frameNumber: number): void {
  const f = byTI.get(ti)
  if (f !== undefined) {
    // Refined again (an ancestor upgrade, then its own imagery). Started: keep the original `from` and the clock (what is on
    // screen is the blend), fade to the newest. Not drawn yet (waiting behind its parent): the screen now shows `before`'s
    // level through the parent, not the older `from`, so fade from `before` (it takes over the wrapper's reference).
    if (f.startMs < 0) {
      release(f.from)
      f.from = before
      f.companion.readyImagery = before
      f.companion.textureTranslationAndScale = before.imageryLayer._calculateTextureTranslationAndScale(tile, { readyImagery: before, useWebMercatorT: ti.useWebMercatorT })
    } else before.releaseReference()
    f.after = after
    f.proxy.img = after
    f.proxyTI.textureTranslationAndScale = ti.textureTranslationAndScale
    counts.retargeted++
    return
  }
  const layer = after.imageryLayer
  const vis = swapVisibility(tile._lastSelectionResult, tile._lastSelectionResultFrame, frameNumber)
  const skip =
    tile.data === undefined || layer.alpha !== 1 || !layer.isBaseLayer() ? 'skippedLayer' // never the night lights or the street map
    : vis === 'refined' ? 'skippedRefined'
    : vis === 'offscreen' ? 'skippedOffscreen'
    : byTI.size >= MAX_FADES ? 'skippedCap'
    : null
  if (skip !== null) {
    before.releaseReference()
    counts[skip]++
    return
  }
  begin(tile, tile.data as SurfaceTile, ti, before, after, imageryFade.now())
}

/**
 * Advances every fade and swaps the drawn tiles' imagery arrays for [companion, proxy] pairs. Returns how many groups are
 * swapped (in `swapped`). Allocates nothing: the per-group arrays are reused.
 */
function prepare(frameNumber: number, nowMs: number): number {
  const durationMs = imageryFade.durationMs
  let n = 0
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi]
    const tile = g.tile
    // Drawn this frame. Not _tilesRenderedThisFrame (the report's test): that Set keeps the descendants kicked out of the
    // render list (QuadtreePrimitive.js:904-929, 1306-1309), so their clock would run while their parent is drawn.
    const thisFrame = tile._lastSelectionResultFrame === frameNumber
    const result = tile._lastSelectionResult
    const drawn = thisFrame && result === RENDERED
    // Kicked: its parent is drawn in its place until its siblings load; its first draw would still pop, so the fade waits.
    const waiting = thisFrame && result === RENDERED_AND_KICKED
    const list = g.list
    for (let i = list.length - 1; i >= 0; i--) {
      const f = list[i]
      if (f.ti.readyImagery !== f.after) {
        end(f, 'cancelled') // changed without passing processStateMachine: never seen, kept as a guard
        continue
      }
      if (f.startMs < 0) {
        if (!drawn) {
          if (waiting) f.aliveMs = nowMs
          else if (nowMs - f.aliveMs > EXPIRE_MS) end(f, 'expired')
          continue
        }
        f.startMs = nowMs
      }
      const u = durationMs > 0 ? (nowMs - f.startMs) / durationMs : 1
      if (u >= 1) {
        end(f, 'finished')
        continue
      }
      f.proxyLayer.alpha = fadeAlpha(u)
      f.proxyTI.textureTranslationAndScale = f.ti.textureTranslationAndScale
    }
    if (!drawn || list.length === 0) continue
    const orig = g.st.imagery
    const aug = g.aug
    aug.length = 0
    let found = 0
    for (let k = 0; k < orig.length; k++) {
      const ti = orig[k]
      const f = byTI.get(ti)
      if (f !== undefined && f.group === g) {
        aug.push(f.companion, f.proxyTI) // ancestor below, new on top: sampleAndBlend gives mix(ancestor, new, alpha), GlobeFS.glsl:266-270
        f.seenFrame = frameNumber
        found++
      } else aug.push(ti)
    }
    if (found < list.length) for (let i = list.length - 1; i >= 0; i--) if (list[i].seenFrame !== frameNumber) end(list[i], 'cancelled') // its TileImagery left the tile
    if (found === 0) continue
    g.orig = orig
    g.st.imagery = aug
    swapped[n++] = g
  }
  return n
}

// ---------- the wrappers (exported for the tests; installImageryFade puts them on Cesium's prototypes) ----------

/**
 * TileImagery.processStateMachine (runs in endFrame's load queue): notes a readyImagery that got sharper and starts a fade
 * when the swap shows. The ancestor gets one extra reference for the call, so TileImagery.js:61-62's release cannot
 * destroy its texture; the fade keeps that reference or it is released before returning. A first call whose own imagery is
 * already READY (shared with a neighbour) fades from the ancestor the parent tile was showing (report note a).
 * Inside endUpdate it passes straight through: a fill mesh built there (TerrainFillMesh.updateFillTiles at
 * GlobeSurfaceTileProvider.js:537, fill.update at 2518 → createFillMesh → processImagery with skipLoading,
 * TerrainFillMesh.js:1305) can swap a tile's imagery before its command is built, so it already draws sharp this frame; a
 * fade starting there would draw it blurry again next frame (a one-frame flicker). Cesium's plain swap it is.
 */
export function wrapProcessStateMachine(orig: ProcessStateMachine): ProcessStateMachine {
  return function processStateMachine(this: TI, tile, frameState, skipLoading) {
    if (!enabled || drawing) return orig.call(this, tile, frameState, skipLoading)
    const loading = this.loadingImagery
    const before = this.readyImagery ?? (loading === undefined ? undefined : readyAncestor(loading, this.useWebMercatorT))
    if (before === undefined) return orig.call(this, tile, frameState, skipLoading)
    before.addReference()
    let done: boolean
    try {
      done = orig.call(this, tile, frameState, skipLoading)
    } catch (e) {
      before.releaseReference()
      throw e
    }
    const after = this.readyImagery
    if (after === undefined || after === before || after.level <= before.level) before.releaseReference()
    else onSwap(tile, this, before, after, frameState.frameNumber)
    return done
  }
}

/**
 * TileImagery.freeResources: every path that drops a TileImagery calls it first (tile freed GlobeSurfaceTile.js:191-194,
 * layer removed or hidden GlobeSurfaceTileProvider.js:1346, provider reload 1885, placeholder GlobeSurfaceTile.js:356), so
 * the fade's reference is released there, before the layer can be destroyed. (The spec wrapped GlobeSurfaceTile.freeResources
 * plus layerRemoved; this one hook covers both and the hide and reload paths too: _onLayerRemoved frees every loaded tile's
 * TileImagery of the layer, GlobeSurfaceTileProvider.js:1337-1355, and `from` and `after` are always on the same layer.)
 * Harness check: Esri → EOX swapped mid-flight with 10 fades running: all 10 released inside layers.remove(), none orphaned.
 * Viewer.destroy frees no tiles (Globe.js:1141-1146), so createViewer turns the fade off first (viewer.ts).
 */
export function wrapFreeResources(orig: FreeResources): FreeResources {
  return function freeResources(this: TI) {
    if (byTI.size > 0) {
      const f = byTI.get(this)
      if (f !== undefined) end(f, 'cancelled')
    }
    orig.call(this)
  }
}

/**
 * GlobeSurfaceTileProvider.endUpdate (builds the globe's draw commands): the fading tiles' imagery arrays are swapped in
 * for the call and restored in a finally. Nothing else reads them meanwhile: endUpdate's TerrainFillMesh.updateFillTiles
 * call (536-543) only initialises START tiles (never fading: a freed tile's fades end first), picking reuses these commands
 * (updateForPick 632-647), and showTileThisFrame already ran (its texture-count bucket only orders draws). The fill meshes
 * built during the call may swap imagery: `drawing` makes processStateMachine pass those through.
 * ponytail: the registry is per page, not per globe: fine for the app's one Viewer. Upgrade: key groups by provider for two globes.
 */
export function wrapEndUpdate(orig: EndUpdate): EndUpdate {
  return function endUpdate(this: unknown, frameState) {
    const n = byTI.size === 0 ? 0 : prepare(frameState.frameNumber, imageryFade.now())
    drawing = true
    try {
      return orig.call(this, frameState)
    } finally {
      drawing = false
      for (let i = 0; i < n; i++) swapped[i].st.imagery = swapped[i].orig
      if (n > 0) swapped.length = 0 // holds no tile past the draw (a destroyed globe's tiles stay unreachable)
    }
  }
}

/**
 * Makes `viewer.destroy()` turn the fade off first. Viewer.destroy frees no globe tiles (Globe.js:1141-1146,
 * QuadtreePrimitive.js:483-485), so no TileImagery.freeResources would end the running fades: turned off, they give back
 * their references while the layers are still alive, and the page-level registry lets the old globe go. createViewer sets
 * `enabled` again for the next viewer.
 */
export function fadeOffOnDestroy(viewer: { destroy(): unknown }): void {
  const destroy = viewer.destroy.bind(viewer)
  viewer.destroy = () => {
    imageryFade.enabled = false
    return destroy()
  }
}

// ---------- install ----------

interface CesiumPrivates {
  TileImagery?: { new (imagery: unknown, rect: unknown, useWebMercatorT: boolean): TI; prototype: { processStateMachine: ProcessStateMachine; freeResources: FreeResources } }
  GlobeSurfaceTileProvider?: { prototype: { endUpdate: EndUpdate } }
  QuadtreeTile?: new (o: { tilingScheme: unknown; x: number; y: number; level: number }) => QTile
  Imagery?: { prototype: Partial<Img> }
  ImageryLayer?: { prototype: Partial<Layer> }
  ImageryState?: { READY?: unknown }
  TileSelectionResult?: Record<string, unknown>
  GeographicTilingScheme?: new () => unknown
}
const MARK = Symbol.for('flighthopper.imageryFade')

/** Every private this module relies on, in the loaded Cesium. */
function supported(C: CesiumPrivates): boolean {
  try {
    const fn = (x: unknown): boolean => typeof x === 'function'
    const { TileImagery, GlobeSurfaceTileProvider, QuadtreeTile, Imagery, ImageryLayer, ImageryState, TileSelectionResult: R, GeographicTilingScheme } = C
    if (!TileImagery || !GlobeSurfaceTileProvider || !QuadtreeTile || !Imagery || !ImageryLayer || !ImageryState || !R || !GeographicTilingScheme) return false
    if (!fn(TileImagery.prototype.processStateMachine) || !fn(TileImagery.prototype.freeResources) || !fn(GlobeSurfaceTileProvider.prototype.endUpdate)) return false
    if (!fn(Imagery.prototype.addReference) || !fn(Imagery.prototype.releaseReference)) return false
    const L = ImageryLayer.prototype
    if (!fn(L._calculateTextureTranslationAndScale) || !fn(L.isBaseLayer) || !fn(L.isDestroyed)) return false
    if (typeof ImageryState.READY !== 'number') return false
    if (R.RENDERED !== RENDERED || R.REFINED !== REFINED || R.RENDERED_AND_KICKED !== RENDERED_AND_KICKED || R.REFINED_AND_KICKED !== REFINED_AND_KICKED) return false
    const ti = new TileImagery(undefined, undefined, true)
    for (const k of ['readyImagery', 'loadingImagery', 'textureTranslationAndScale', 'textureCoordinateRectangle', 'useWebMercatorT']) if (!(k in ti)) return false
    const qt = new QuadtreeTile({ tilingScheme: new GeographicTilingScheme(), x: 0, y: 0, level: 0 })
    return '_lastSelectionResult' in qt && '_lastSelectionResultFrame' in qt
  } catch {
    return false
  }
}

/**
 * Patches Cesium (TileImagery.processStateMachine and freeResources, GlobeSurfaceTileProvider.endUpdate) once per page.
 * Returns false, patching nothing, when a private it needs is missing (a Cesium upgrade): the globe then pops as before.
 * The exported classes are the engine's own (cesium re-exports @cesium/engine; Vite pre-bundles one copy).
 * The fade's shader variants (n + 1 day textures, APPLY_ALPHA) compile on first use: a one-off hitch per flag combination.
 */
export function installImageryFade(): boolean {
  if (installed) return true
  const C = { TileImagery, GlobeSurfaceTileProvider, QuadtreeTile, Imagery, ImageryLayer, ImageryState, TileSelectionResult, GeographicTilingScheme } as unknown as CesiumPrivates
  if (!supported(C)) return false
  const ti = C.TileImagery!.prototype
  const provider = C.GlobeSurfaceTileProvider!.prototype
  imageryReady = C.ImageryState!.READY as number
  if (!(MARK in ti.processStateMachine)) {
    const psm = wrapProcessStateMachine(ti.processStateMachine)
    const free = wrapFreeResources(ti.freeResources)
    const endUpdate = wrapEndUpdate(provider.endUpdate)
    for (const f of [psm, free, endUpdate]) Object.defineProperty(f, MARK, { value: true })
    ti.processStateMachine = psm
    ti.freeResources = free
    provider.endUpdate = endUpdate
  }
  installed = true
  return true
}

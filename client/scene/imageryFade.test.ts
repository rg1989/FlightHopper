// client/scene/imageryFade.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Cesium from 'cesium'
import {
  EXPIRE_MS, FADE_MS, MAX_FADES, MIN_ALPHA, fadeAlpha, fadeOffOnDestroy, imageryFade, installImageryFade, swapVisibility, wrapEndUpdate, wrapFreeResources,
  wrapProcessStateMachine,
} from './imageryFade.ts'

// Cesium's real TileImagery (not in the .d.ts): its own swap code runs against fake Imagery below. Taken before any test
// installs the patch on the prototype.
interface TIFake { readyImagery?: Img; loadingImagery?: Img; textureTranslationAndScale?: unknown; textureCoordinateRectangle: unknown; useWebMercatorT: boolean }
const TileImagery = (Cesium as unknown as { TileImagery: { new (imagery: unknown, rect: unknown, webMercatorT: boolean): TIFake; prototype: { processStateMachine: unknown; freeResources: unknown } } }).TileImagery
const psm = wrapProcessStateMachine(TileImagery.prototype.processStateMachine as Parameters<typeof wrapProcessStateMachine>[0])
const free = wrapFreeResources(TileImagery.prototype.freeResources as Parameters<typeof wrapFreeResources>[0])

const READY = 4 // ImageryState
const LOADING = 1
const [NONE, CULLED, RENDERED, REFINED, RENDERED_AND_KICKED, REFINED_AND_KICKED, CULLED_BUT_NEEDED] = [0, 1, 2, 3, 6, 7, 9]

/** A fake ImageryLayer: the fields the fade and TileImagery.js read. The translation-and-scale names the imagery it maps. */
function layer(o: { base?: boolean; alpha?: number } = {}) {
  return {
    alpha: o.alpha ?? 1,
    brightness: 0.8,
    base: o.base ?? true,
    destroyed: false,
    isBaseLayer(): boolean { return this.base },
    isDestroyed(): boolean { return this.destroyed },
    _calculateTextureTranslationAndScale: (_tile: unknown, ti: { readyImagery?: Img }) => ({ of: ti.readyImagery?.level }),
  }
}
type Layer = ReturnType<typeof layer>

/** A fake Imagery that counts its references (never destroyed: the balance is checked instead). */
interface Img { imageryLayer: Layer; level: number; state: number; parent?: Img; texture: object; refs: number; adds: number; releases: number; addReference(): void; releaseReference(): number; processStateMachine(): void }
function img(l: Layer, level: number, parent?: Img, state = READY): Img {
  return {
    imageryLayer: l, level, state, parent, texture: { level }, refs: 0, adds: 0, releases: 0,
    addReference() { this.refs++; this.adds++ },
    releaseReference() { this.releases++; return --this.refs },
    processStateMachine() {},
  }
}

interface Tile { data: { imagery: TIFake[] }; rectangle: object; _lastSelectionResult: number; _lastSelectionResultFrame?: number }
function tileOf(...tis: TIFake[]): Tile {
  return { data: { imagery: tis }, rectangle: {}, _lastSelectionResult: NONE, _lastSelectionResultFrame: undefined }
}

// A provider whose endUpdate records the imagery arrays it drew (as addDrawCommandsForTile reads them), and can run a fill
// mesh's processImagery in the middle of the draw (duringDraw), as TerrainFillMesh does.
const provider = { drawn: [] as Tile[], seen: [] as TIFake[][], throwNext: false, duringDraw: undefined as (() => void) | undefined }
const endUpdate = wrapEndUpdate(function (this: typeof provider) {
  this.duringDraw?.()
  this.seen = this.drawn.map((t) => [...t.data.imagery])
  if (this.throwNext) {
    this.throwNext = false
    throw new Error('draw failed')
  }
} as unknown as Parameters<typeof wrapEndUpdate>[0])

let frame = 0
let clockMs = 10_000
imageryFade.now = () => clockMs

/**
 * One Cesium frame: selection (each tile's result), endUpdate (the draw), then endFrame's load queue (`load`), all with one
 * frameNumber. Returns what endUpdate saw for each tile in `drawn` order.
 */
function runFrame(results: [Tile, number][], load: () => void = () => {}): TIFake[][] {
  frame++
  for (const [t, r] of results) {
    t._lastSelectionResult = r
    t._lastSelectionResultFrame = frame
  }
  provider.drawn = results.filter(([, r]) => r === RENDERED).map(([t]) => t)
  endUpdate.call(provider as never, { frameNumber: frame })
  load()
  return provider.seen
}
const processTI = (ti: TIFake, t: Tile): boolean => psm.call(ti as never, t as never, { frameNumber: frame }, false)

/** A drawn tile showing the level-10 ancestor while its level-11 imagery loads (Cesium's own stand-in path). */
function standIn(l = layer()) {
  const p0 = img(l, 9)
  const p1 = img(l, 10, p0)
  const own = img(l, 11, p1, LOADING)
  own.refs = 1 // the TileImagery's reference on what it loads
  const ti = new TileImagery(own, { rect: true }, true)
  const t = tileOf(ti)
  runFrame([[t, RENDERED]], () => processTI(ti, t))
  assert.equal(ti.readyImagery, p1)
  assert.equal(p1.refs, 1)
  return { l, p0, p1, own, ti, t }
}

function reset(): void {
  imageryFade.enabled = false // ends whatever a failed test left
  imageryFade.enabled = true
  imageryFade.durationMs = FADE_MS
  imageryFade.resetStats()
}

test('fadeAlpha: smoothstep of the elapsed fraction, never below MIN_ALPHA (0 would drop the texture slot)', () => {
  assert.equal(fadeAlpha(0), MIN_ALPHA)
  assert.equal(fadeAlpha(-1), MIN_ALPHA)
  assert.equal(fadeAlpha(0.25), 0.15625)
  assert.equal(fadeAlpha(0.5), 0.5)
  assert.equal(fadeAlpha(1), 1)
  assert.equal(fadeAlpha(2), 1)
  for (let u = 0; u < 1; u += 0.05) assert.ok(fadeAlpha(u + 0.05) >= fadeAlpha(u))
})

test('swapVisibility: drawn or waiting behind a drawn ancestor fades; refined (kicked or not), culled or not visited does not', () => {
  assert.equal(swapVisibility(RENDERED, 7, 7), 'visible')
  assert.equal(swapVisibility(RENDERED_AND_KICKED, 7, 7), 'visible')
  assert.equal(swapVisibility(REFINED, 7, 7), 'refined')
  assert.equal(swapVisibility(REFINED_AND_KICKED, 7, 7), 'refined', 'its children draw once the kick lifts, never itself')
  for (const r of [NONE, CULLED, CULLED_BUT_NEEDED]) assert.equal(swapVisibility(r, 7, 7), 'offscreen')
  assert.equal(swapVisibility(RENDERED, 6, 7), 'offscreen', 'a result from an earlier frame: not visited this frame')
  assert.equal(swapVisibility(RENDERED, undefined, 7), 'offscreen')
})

test('a visible refinement dissolves from the ancestor over FADE_MS from its first draw, then draws plainly; references balance', () => {
  reset()
  const { l, p1, own, ti, t } = standIn()
  own.state = READY
  runFrame([[t, RENDERED]], () => processTI(ti, t)) // the swap, in endFrame after this frame's draw
  assert.equal(ti.readyImagery, own)
  assert.deepEqual({ started: imageryFade.stats().started, active: imageryFade.stats().active, refsHeld: imageryFade.stats().refsHeld }, { started: 1, active: 1, refsHeld: 1 })
  assert.equal(p1.refs, 1, 'Cesium released its reference; the fade keeps the ancestor and its texture alive')

  clockMs += 500 // the clock starts at the first draw, not at the swap
  const real = t.data.imagery
  let [drawn] = runFrame([[t, RENDERED]])
  assert.equal(t.data.imagery, real, 'the real array is back after endUpdate')
  assert.deepEqual(real, [ti])
  assert.equal(drawn.length, 2)
  const [below, above] = drawn
  assert.equal(below.readyImagery, p1)
  assert.deepEqual(below.textureTranslationAndScale, { of: 10 }, 'the ancestor mapped onto this terrain tile')
  assert.equal(below.textureCoordinateRectangle, ti.textureCoordinateRectangle)
  assert.equal(above.readyImagery!.texture, own.texture)
  assert.equal(above.textureTranslationAndScale, ti.textureTranslationAndScale)
  assert.equal(above.readyImagery!.imageryLayer.alpha, MIN_ALPHA)
  assert.equal(above.readyImagery!.imageryLayer.brightness, l.brightness, 'every other layer setting reads through')
  assert.equal(l.alpha, 1, 'the real layer is untouched')

  clockMs += FADE_MS / 2
  ;[drawn] = runFrame([[t, RENDERED]])
  assert.equal(drawn[1].readyImagery!.imageryLayer.alpha, 0.5)

  clockMs += FADE_MS / 2
  ;[drawn] = runFrame([[t, RENDERED]])
  assert.deepEqual(drawn, [ti], 'done: drawn as Cesium draws it')
  const s = imageryFade.stats()
  assert.deepEqual({ finished: s.finished, active: s.active, refsHeld: s.refsHeld }, { finished: 1, active: 0, refsHeld: 0 })
  assert.equal(p1.refs, 0)
  assert.equal(p1.adds, p1.releases)
})

test('a swap that shows nowhere is instant: culled or not visited → skippedOffscreen, refined → skippedRefined', () => {
  for (const [r, key] of [[CULLED, 'skippedOffscreen'], [CULLED_BUT_NEEDED, 'skippedOffscreen'], [REFINED, 'skippedRefined']] as const) {
    reset()
    const { p1, own, ti, t } = standIn()
    own.state = READY
    runFrame([[t, r]], () => processTI(ti, t))
    const s = imageryFade.stats()
    assert.equal(s[key], 1, `result ${r}`)
    assert.equal(s.started + s.refsHeld, 0)
    assert.equal(p1.refs, 0)
  }
})

test('the night lights (not the base layer) and a translucent base layer never fade', () => {
  for (const l of [layer({ base: false }), layer({ alpha: 0.6 })]) {
    reset()
    const { p1, own, ti, t } = standIn(l)
    own.state = READY
    runFrame([[t, RENDERED]], () => processTI(ti, t))
    assert.equal(imageryFade.stats().skippedLayer, 1)
    assert.equal(imageryFade.stats().started, 0)
    assert.equal(p1.refs, 0)
  }
})

test('a tile kicked behind its parent keeps its clock until its own first draw', () => {
  reset()
  const { own, ti, t } = standIn()
  own.state = READY
  runFrame([[t, RENDERED_AND_KICKED]], () => processTI(ti, t))
  assert.equal(imageryFade.stats().started, 1)
  clockMs += 1500
  let [drawn] = runFrame([[t, RENDERED_AND_KICKED]]) // still behind its parent
  assert.equal(drawn, undefined)
  ;[drawn] = runFrame([[t, RENDERED]])
  assert.equal(drawn[1].readyImagery!.imageryLayer.alpha, MIN_ALPHA, 'starts now, 1.5 s after the swap')
  clockMs += FADE_MS
  runFrame([[t, RENDERED]])
  assert.equal(imageryFade.stats().finished, 1)
})

test('waiting behind a drawn parent for longer than EXPIRE_MS keeps the fade: its first draw still dissolves', () => {
  reset()
  const { p1, own, ti, t } = standIn()
  own.state = READY
  runFrame([[t, RENDERED_AND_KICKED]], () => processTI(ti, t))
  for (let i = 0; i < 4; i++) {
    clockMs += EXPIRE_MS * 0.75 // 3 × EXPIRE_MS in all, a frame each 0.75 × EXPIRE_MS
    runFrame([[t, RENDERED_AND_KICKED]])
  }
  assert.equal(imageryFade.stats().expired, 0)
  const [drawn] = runFrame([[t, RENDERED]])
  assert.equal(drawn[0].readyImagery, p1)
  assert.equal(drawn[1].readyImagery!.imageryLayer.alpha, MIN_ALPHA)
  clockMs += EXPIRE_MS + 1 // then culled before finishing: a started fade runs out on its clock, not EXPIRE_MS
  runFrame([[t, CULLED]])
  assert.deepEqual({ finished: imageryFade.stats().finished, refsHeld: imageryFade.stats().refsHeld }, { finished: 1, refsHeld: 0 })
  assert.equal(p1.refs, 0)
})

test('a tile not drawn within EXPIRE_MS of its swap drops the fade and its reference', () => {
  reset()
  const { p1, own, ti, t } = standIn()
  own.state = READY
  runFrame([[t, RENDERED]], () => processTI(ti, t))
  clockMs += EXPIRE_MS - 1
  runFrame([[t, CULLED]])
  assert.equal(imageryFade.stats().active, 1)
  clockMs += 2
  runFrame([[t, CULLED]])
  const s = imageryFade.stats()
  assert.deepEqual({ expired: s.expired, active: s.active, refsHeld: s.refsHeld }, { expired: 1, active: 0, refsHeld: 0 })
  assert.equal(p1.refs, 0)
})

test('a started fade ends on time even while its tile is not drawn', () => {
  reset()
  const { p1, own, ti, t } = standIn()
  own.state = READY
  runFrame([[t, RENDERED]], () => processTI(ti, t))
  runFrame([[t, RENDERED]])
  clockMs += FADE_MS
  runFrame([[t, CULLED]])
  assert.equal(imageryFade.stats().finished, 1)
  assert.equal(p1.refs, 0)
})

test('freeing the TileImagery (tile evicted, layer removed or hidden) releases the fade first, then Cesium frees its own', () => {
  reset()
  const { p1, own, ti, t } = standIn()
  own.state = READY
  runFrame([[t, RENDERED]], () => processTI(ti, t))
  runFrame([[t, RENDERED]])
  const ownRefs = own.refs
  free.call(ti as never)
  const s = imageryFade.stats()
  assert.deepEqual({ cancelled: s.cancelled, active: s.active, refsHeld: s.refsHeld }, { cancelled: 1, active: 0, refsHeld: 0 })
  assert.equal(p1.refs, 0)
  assert.equal(own.refs, ownRefs - 1, 'TileImagery.freeResources released its readyImagery')
})

test('a layer destroyed behind a fade\'s back (a missed release path) is never released on: counted as orphaned', () => {
  reset()
  const kept = standIn()
  const lost = standIn()
  kept.own.state = READY
  lost.own.state = READY
  runFrame([[kept.t, RENDERED], [lost.t, RENDERED]], () => {
    processTI(kept.ti, kept.t)
    processTI(lost.ti, lost.t)
  })
  assert.equal(imageryFade.stats().active, 2)
  lost.l.destroyed = true
  const releases = lost.p1.releases
  imageryFade.enabled = false
  assert.deepEqual({ orphaned: imageryFade.stats().orphaned, refsHeld: imageryFade.stats().refsHeld }, { orphaned: 1, refsHeld: 0 })
  assert.equal(lost.p1.releases, releases, 'nothing released on the destroyed layer')
  assert.equal(kept.p1.refs, 0)
})

test('refining again mid-fade keeps the original ancestor and the clock, and fades to the newest imagery', () => {
  reset()
  const l = layer()
  const p0 = img(l, 8)
  const mid = img(l, 9, p0, LOADING)
  const own = img(l, 10, mid, LOADING)
  own.refs = 1
  const ti = new TileImagery(own, {}, true)
  const t = tileOf(ti)
  runFrame([[t, RENDERED]], () => processTI(ti, t))
  assert.equal(ti.readyImagery, p0)
  mid.state = READY
  runFrame([[t, RENDERED]], () => processTI(ti, t)) // ancestor upgrade p0 → mid (TileImagery.js:90-101)
  assert.equal(ti.readyImagery, mid)
  runFrame([[t, RENDERED]]) // first draw
  clockMs += FADE_MS / 2
  own.state = READY
  runFrame([[t, RENDERED]], () => processTI(ti, t)) // its own imagery: mid → own
  assert.equal(imageryFade.stats().retargeted, 1)
  const [drawn] = runFrame([[t, RENDERED]])
  assert.equal(drawn[0].readyImagery, p0, 'still from the original ancestor')
  assert.equal(drawn[1].readyImagery!.texture, own.texture, 'the proxy follows the retarget')
  assert.notEqual(Object.getPrototypeOf(drawn[1].readyImagery), own, 'a proxy object, not Object.create(imagery): no live Imagery becomes a V8 prototype')
  assert.equal(drawn[1].readyImagery!.imageryLayer.alpha, 0.5, 'the clock runs on')
  clockMs += FADE_MS / 2
  runFrame([[t, RENDERED]])
  assert.deepEqual({ finished: imageryFade.stats().finished, refsHeld: imageryFade.stats().refsHeld }, { finished: 1, refsHeld: 0 })
  assert.equal(p0.refs, 0)
  assert.equal(mid.refs, 0)
  assert.equal(p0.adds, p0.releases)
  assert.equal(mid.adds, mid.releases)
})

test('a first processStateMachine whose own imagery is already READY (shared with a neighbour) fades from the ready ancestor', () => {
  reset()
  const l = layer()
  const p1 = img(l, 10)
  p1.refs = 1 // held by its child Imagery, as ImageryLayer.getImageryFromCache does
  const own = img(l, 11, p1, READY)
  own.refs = 1
  const ti = new TileImagery(own, {}, true)
  const t = tileOf(ti)
  runFrame([[t, RENDERED_AND_KICKED]], () => processTI(ti, t))
  assert.equal(ti.readyImagery, own)
  assert.equal(imageryFade.stats().started, 1)
  assert.equal(p1.refs, 2)
  const [drawn] = runFrame([[t, RENDERED]])
  assert.equal(drawn[0].readyImagery, p1)
  imageryFade.enabled = false
  assert.equal(p1.refs, 1)
})

test('above MAX_FADES concurrent fades a swap is instant (skippedCap)', () => {
  reset()
  const all = Array.from({ length: MAX_FADES + 1 }, () => standIn())
  for (const s of all) s.own.state = READY
  runFrame(all.map((s) => [s.t, RENDERED] as [Tile, number]), () => { for (const s of all) processTI(s.ti, s.t) })
  const st = imageryFade.stats()
  assert.deepEqual({ started: st.started, skippedCap: st.skippedCap, active: st.active }, { started: MAX_FADES, skippedCap: 1, active: MAX_FADES })
  assert.equal(all.at(-1)!.p1.refs, 0)
  imageryFade.enabled = false
  assert.ok(all.every((s) => s.p1.refs === 0 && s.p1.adds === s.p1.releases))
})

test('the real imagery array is restored even when the draw throws', () => {
  reset()
  const { own, ti, t } = standIn()
  own.state = READY
  runFrame([[t, RENDERED]], () => processTI(ti, t))
  const real = t.data.imagery
  provider.throwNext = true
  assert.throws(() => runFrame([[t, RENDERED]]), /draw failed/)
  assert.equal(t.data.imagery, real)
  assert.deepEqual(real, [ti])
})

test('turning the fade off ends every fade and passes swaps straight through', () => {
  reset()
  const a = standIn()
  a.own.state = READY
  runFrame([[a.t, RENDERED]], () => processTI(a.ti, a.t))
  assert.equal(imageryFade.stats().active, 1)
  imageryFade.enabled = false
  assert.deepEqual({ active: imageryFade.stats().active, refsHeld: imageryFade.stats().refsHeld, cancelled: imageryFade.stats().cancelled }, { active: 0, refsHeld: 0, cancelled: 1 })
  assert.equal(a.p1.refs, 0)
  const b = standIn()
  b.own.state = READY
  runFrame([[b.t, RENDERED]], () => processTI(b.ti, b.t))
  assert.equal(imageryFade.stats().started, 1, 'only the one from before')
  assert.equal(b.p1.refs, 0)
  imageryFade.enabled = true
})

test('a swap inside the draw (a fill mesh processing its imagery) is Cesium\'s plain swap: it already draws sharp this frame', () => {
  reset()
  const { p1, own, ti, t } = standIn()
  own.state = READY
  provider.duringDraw = () => processTI(ti, t)
  try {
    const [drawn] = runFrame([[t, RENDERED]])
    assert.deepEqual(drawn, [ti], 'drawn with its own imagery, no pair')
  } finally {
    provider.duringDraw = undefined
  }
  assert.equal(ti.readyImagery, own)
  const [next] = runFrame([[t, RENDERED]])
  assert.deepEqual(next, [ti], 'and not blurry again next frame')
  assert.deepEqual({ started: imageryFade.stats().started, refsHeld: imageryFade.stats().refsHeld }, { started: 0, refsHeld: 0 })
  assert.equal(p1.refs, 0)
  assert.equal(p1.adds, p1.releases)
})

test('a fade still waiting behind its parent moves its `from` up with each ancestor upgrade: the first draw starts from the newest', () => {
  reset()
  const l = layer()
  const p0 = img(l, 8)
  const mid = img(l, 9, p0, LOADING)
  const own = img(l, 10, mid, LOADING)
  own.refs = 1
  const ti = new TileImagery(own, {}, true)
  const t = tileOf(ti)
  runFrame([[t, RENDERED_AND_KICKED]], () => processTI(ti, t))
  assert.equal(ti.readyImagery, p0)
  mid.state = READY
  runFrame([[t, RENDERED_AND_KICKED]], () => processTI(ti, t)) // p0 → mid while waiting: a fade from p0, not started
  assert.equal(imageryFade.stats().started, 1)
  own.state = READY
  runFrame([[t, RENDERED_AND_KICKED]], () => processTI(ti, t)) // mid → own, still waiting: now from mid
  assert.equal(imageryFade.stats().retargeted, 1)
  assert.equal(p0.adds, p0.releases, 'the stale ancestor let go at once')
  const [drawn] = runFrame([[t, RENDERED]])
  assert.equal(drawn[0].readyImagery, mid)
  assert.deepEqual(drawn[0].textureTranslationAndScale, { of: 9 }, 'mapped for the new `from`')
  assert.equal(drawn[1].readyImagery!.texture, own.texture)
  assert.equal(drawn[1].readyImagery!.imageryLayer.alpha, MIN_ALPHA)
  clockMs += FADE_MS
  runFrame([[t, RENDERED]])
  assert.deepEqual({ finished: imageryFade.stats().finished, refsHeld: imageryFade.stats().refsHeld }, { finished: 1, refsHeld: 0 })
  assert.equal(mid.adds, mid.releases)
})

test('a tile with several imagery tiles: only the fading one becomes a pair, in place, the others keep their order', () => {
  reset()
  const l = layer()
  const nightLayer = layer({ base: false, alpha: 0.5 })
  const p1 = img(l, 10)
  const own0 = img(l, 11, p1, LOADING)
  own0.refs = 1
  const b1 = img(l, 11)
  b1.refs = 1
  const n = img(nightLayer, 8)
  n.refs = 1
  const [ti0, ti1, tiN] = [new TileImagery(own0, { r: 0 }, true), new TileImagery(b1, { r: 1 }, true), new TileImagery(n, { r: 2 }, true)]
  const t = tileOf(ti0, ti1, tiN)
  runFrame([[t, RENDERED]], () => { for (const ti of [ti0, ti1, tiN]) processTI(ti, t) })
  assert.deepEqual([ti0.readyImagery, ti1.readyImagery, tiN.readyImagery], [p1, b1, n])
  own0.state = READY
  runFrame([[t, RENDERED]], () => processTI(ti0, t))
  const real = t.data.imagery
  const [drawn] = runFrame([[t, RENDERED]])
  assert.equal(drawn.length, 4)
  assert.equal(drawn[0].readyImagery, p1)
  assert.equal(drawn[1].readyImagery!.texture, own0.texture)
  assert.deepEqual([drawn[2], drawn[3]], [ti1, tiN], 'the other base tile and the night lights, untouched and in order')
  assert.equal(t.data.imagery, real)
  assert.deepEqual(real, [ti0, ti1, tiN])
  clockMs += FADE_MS
  runFrame([[t, RENDERED]])
  assert.equal(imageryFade.stats().refsHeld, 0)
})

test('fadeOffOnDestroy: destroying the viewer ends every running fade before the original destroy runs', () => {
  reset()
  const a = standIn()
  a.own.state = READY
  runFrame([[a.t, RENDERED]], () => processTI(a.ti, a.t))
  runFrame([[a.t, RENDERED]])
  let seen: { active: number; refsHeld: number } | undefined
  const viewer = { destroy: () => { seen = { active: imageryFade.stats().active, refsHeld: imageryFade.stats().refsHeld }; return 'destroyed' } }
  fadeOffOnDestroy(viewer)
  assert.equal(viewer.destroy(), 'destroyed')
  assert.deepEqual(seen, { active: 0, refsHeld: 0 })
  assert.equal(a.p1.refs, 0)
  assert.equal(imageryFade.enabled, false)
  imageryFade.enabled = true
})

test('installImageryFade: finds every private it needs in the installed Cesium and patches its prototypes once', () => {
  const proto = TileImagery.prototype
  const before = proto.processStateMachine
  assert.equal(installImageryFade(), true)
  const after = proto.processStateMachine
  assert.notEqual(after, before)
  assert.equal(installImageryFade(), true)
  assert.equal(proto.processStateMachine, after, 'idempotent')
  assert.equal(imageryFade.stats().installed, true)
})

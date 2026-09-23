// client/scene/tileCache.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Globe } from 'cesium'
import type { Viewer } from 'cesium'
import { FALLBACK_TILES, MAX_TILES, MIN_TILES, ORBIT_X, PEAK_TAU_S, SHRINK_MARGIN, STEP_TILES, TileCache, tileCacheSizeFor } from './tileCache.ts'

/**
 * A scene with a globe whose `_surface._debug` holds the counters, recording every tileCacheSize write; frame(visited, culled)
 * sets them and runs postRender. The clock is `t` (ms), for opts.nowMs.
 */
function fakeViewer(debug: object | null = { tilesVisited: 0, tilesCulled: 0 }) {
  const after: (() => void)[] = []
  const writes: number[] = []
  let size = 100 // Cesium's default (Globe.js:116)
  const globe = {
    _surface: debug === null ? {} : { _debug: debug },
    get tileCacheSize(): number { return size },
    set tileCacheSize(v: number) { writes.push(v); size = v },
  }
  const clock = { t: 0 }
  const viewer = { scene: { globe, postRender: { addEventListener: (f: () => void) => (after.push(f), () => after.splice(after.indexOf(f), 1)) } } }
  const frame = (visited: number, culled = 0): void => {
    Object.assign(debug ?? {}, { tilesVisited: visited, tilesCulled: culled })
    after.forEach((f) => f())
  }
  return { viewer: viewer as unknown as Viewer, globe, writes, clock, frame, nowMs: () => clock.t, listeners: () => after.length }
}

test('tileCacheSizeFor: 3 × the entries, rounded up to 50 and clamped to 400–2000 (one orbit needs 2.6–2.8× a frame)', () => {
  assert.deepEqual([ORBIT_X, MIN_TILES, MAX_TILES, FALLBACK_TILES, STEP_TILES], [3, 400, 2000, 1200, 50])
  assert.equal(tileCacheSizeFor(394), 1200, 'Meron 300 m: 1182 → 1200, above the 1042 one orbit needed')
  assert.equal(tileCacheSizeFor(406), 1250, 'Judean hills 100 m: 1218 → 1250, above 1066')
  assert.equal(tileCacheSizeFor(274), 850, '2 km AGL: 822 → 850, above 778')
  assert.equal(tileCacheSizeFor(400), 1200, 'an exact multiple stays')
  assert.equal(tileCacheSizeFor(400.1), 1250, 'anything above rounds up')
  assert.equal(tileCacheSizeFor(133), MIN_TILES, '399 → 400: the floor')
  assert.equal(tileCacheSizeFor(134), 450, '402 → 450')
  assert.equal(tileCacheSizeFor(1), MIN_TILES)
  assert.equal(tileCacheSizeFor(666), 2000)
  assert.equal(tileCacheSizeFor(1_000), MAX_TILES, 'a 4K screen is capped at ~1 GB GPU')
  assert.equal(tileCacheSizeFor(Infinity), MAX_TILES)
  for (const bad of [0, -5, NaN]) assert.equal(tileCacheSizeFor(bad), MIN_TILES, `${bad}`)
  for (let n = 1; n < 800; n += 7) assert.equal(tileCacheSizeFor(n) % STEP_TILES, 0, `${n}: a multiple of 50`)
})

test('TileCache: writes 400 at once, then grows to 3 × the entries a frame touched (visited + culled) on the same frame', () => {
  const f = fakeViewer()
  const cache = new TileCache(f.viewer, { nowMs: f.nowMs })
  assert.equal(f.listeners(), 1)
  assert.deepEqual(f.writes, [MIN_TILES], 'Cesium’s 100 is replaced before the first frame')
  assert.equal(cache.size, MIN_TILES)
  f.frame(100, 20) // a browse view: 360 → the floor, no write
  assert.deepEqual(f.writes, [MIN_TILES])
  f.clock.t = 16
  f.frame(258, 136) // the measured Meron frame: 394 entries
  assert.deepEqual(f.writes, [MIN_TILES, 1200])
  assert.equal(cache.size, 1200)
  assert.equal(f.globe.tileCacheSize, 1200)
})

test('TileCache: writes only when the quantised size changes; frame-to-frame noise of a chase view writes nothing', () => {
  const f = fakeViewer()
  const cache = new TileCache(f.viewer, { nowMs: f.nowMs })
  f.frame(394)
  const n = f.writes.length
  // 60 s of a chase view at 60 fps touching 380–406 entries (measured spread 274–406 across heights, a few % at one height)
  for (let i = 1; i <= 3_600; i++) {
    f.clock.t = i * 16.7
    f.frame(380 + ((i * 7) % 27))
  }
  assert.equal(cache.size, 1250, 'grew once for the 406 maximum, then held')
  assert.deepEqual(f.writes.slice(n), [1250])
})

test('TileCache: the peak decays exp(-t / 60 s) after leaving chase: 1200 → the 400 floor in about 70 s, stepwise, never back up', () => {
  assert.equal(PEAK_TAU_S, 60)
  assert.equal(SHRINK_MARGIN, 1.1)
  const f = fakeViewer()
  const cache = new TileCache(f.viewer, { nowMs: f.nowMs })
  f.frame(394)
  assert.equal(cache.size, 1200)
  const sizeAt: Record<number, number> = {}
  for (let i = 1; i <= 120 * 30; i++) { // 120 s at 30 fps of a view touching 100 entries (3 × 100 is below the floor)
    f.clock.t = (i * 1000) / 30
    f.frame(100)
    if (i % 30 === 0) sizeAt[i / 30] = cache.size
  }
  assert.equal(sizeAt[1], 1200, 'nothing lost in the first second')
  assert.equal(sizeAt[5], 1200, 'a 5 s look away keeps the whole orbit: peak 394 → 362, 1.1 × 3 × 362 = 1195 → 1200')
  assert.ok(sizeAt[10] >= 1100, `10 s: ${sizeAt[10]}`)
  assert.ok(sizeAt[30] < 900 && sizeAt[30] > 600, `30 s: ${sizeAt[30]}`)
  assert.ok(sizeAt[60] <= 500, `60 s: ${sizeAt[60]}`)
  assert.equal(sizeAt[80], MIN_TILES, 'at the floor: 1.1 × 3 × 394 e^(−t/60) ≤ 400 at t ≈ 70 s')
  const shrinks = f.writes.slice(2)
  assert.ok(shrinks.every((w, i) => w < (i ? shrinks[i - 1] : 1200)), `strictly down: ${shrinks}`)
  assert.ok(shrinks.length <= 16, `one write per 50-entry step, ${shrinks.length}`)
  f.frame(406) // back into chase: grows at once, the orbit must fit before the next trim
  assert.equal(cache.size, 1250)
})

test('TileCache: a clock step back or a first frame does not decay; a long pause decays once, then the next frame regrows', () => {
  const f = fakeViewer()
  const cache = new TileCache(f.viewer, { nowMs: f.nowMs })
  f.clock.t = 50_000
  f.frame(394)
  f.clock.t = 10_000 // a step back
  f.frame(0)
  assert.equal(cache.size, 1200)
  f.clock.t = 10_000 + 600_000 // a hidden tab for 10 min: no frames, then one
  f.frame(0)
  assert.equal(cache.size, MIN_TILES)
  f.clock.t += 16
  f.frame(394)
  assert.equal(cache.size, 1200)
})

test('TileCache: with no _surface._debug (a Cesium upgrade) it sets 1200 once and never listens', () => {
  const f = fakeViewer(null)
  const cache = new TileCache(f.viewer, { nowMs: f.nowMs })
  assert.deepEqual(f.writes, [FALLBACK_TILES])
  assert.equal(cache.size, FALLBACK_TILES)
  assert.equal(f.listeners(), 0)
  cache.destroy()
  const renamed = fakeViewer({ visited: 0, culled: 0 }) // the object is there, the counters are not
  assert.equal(new TileCache(renamed.viewer).size, FALLBACK_TILES)
  assert.equal(renamed.listeners(), 0)
})

test('TileCache: counters that vanish later (the globe swapped) switch to 1200 once and stop listening', () => {
  const f = fakeViewer()
  const cache = new TileCache(f.viewer, { nowMs: f.nowMs })
  f.frame(500)
  delete (f.globe._surface as { _debug?: object })._debug
  f.frame(0)
  assert.equal(cache.size, FALLBACK_TILES)
  assert.equal(f.listeners(), 0)
  assert.deepEqual(f.writes, [MIN_TILES, 1500, FALLBACK_TILES])
})

test('TileCache: with no globe (globe: false) it writes nothing and throws nothing', () => {
  const after: (() => void)[] = []
  const viewer = { scene: { globe: undefined, postRender: { addEventListener: (fn: () => void) => (after.push(fn), () => {}) } } }
  const cache = new TileCache(viewer as unknown as Viewer)
  assert.equal(cache.size, 0)
  assert.equal(after.length, 0)
})

test('TileCache: destroy removes the postRender listener, is idempotent, and leaves the size as it is', () => {
  const f = fakeViewer()
  const cache = new TileCache(f.viewer, { nowMs: f.nowMs })
  f.frame(394)
  cache.destroy()
  assert.equal(f.listeners(), 0)
  cache.destroy()
  assert.equal(f.listeners(), 0)
  f.frame(600)
  assert.equal(cache.size, 1200)
  assert.equal(f.globe.tileCacheSize, 1200)
})

test('Cesium pin: a real Globe has tileCacheSize 100 and numeric _surface._debug.tilesVisited / tilesCulled (the fields TileCache reads)', () => {
  const globe = new Globe()
  const g = globe as unknown as { tileCacheSize: number; _surface: { _debug: { tilesVisited: unknown; tilesCulled: unknown } } }
  assert.equal(g.tileCacheSize, 100)
  assert.equal(typeof g._surface._debug.tilesVisited, 'number')
  assert.equal(typeof g._surface._debug.tilesCulled, 'number')
  const viewer = { scene: { globe, postRender: { addEventListener: () => () => {} } } }
  const cache = new TileCache(viewer as unknown as Viewer)
  assert.equal(cache.size, MIN_TILES, 'not the fallback')
  assert.equal(globe.tileCacheSize, MIN_TILES)
})

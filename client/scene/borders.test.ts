// client/scene/borders.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Request, RequestState } from 'cesium'
import type { BordersJson } from '../../shared/mapOverlays.ts'
import { bordersFrom } from '../../tools/build-map-overlays.ts'
import { BORDERS_MAX_LEVEL, BordersProvider, decodeBorders, strokeRuns, tileRuns } from './borders.ts'

test('decodeBorders: the first point, then each step from the one before, in 1e-4°; each line\'s box', () => {
  const [a, b] = decodeBorders({ lines: [[347800, 320800, 1, 2, 199, -998], [-1225000, 377000, 10, -10]] })
  assert.ok(a.pts instanceof Float64Array)
  assert.deepEqual([...a.pts], [34.78, 32.08, 34.7801, 32.0802, 34.8, 31.9804])
  assert.deepEqual([a.west, a.south, a.east, a.north], [34.78, 31.9804, 34.8, 32.0802])
  assert.deepEqual([...b.pts], [-122.5, 37.7, -122.499, 37.699])
  assert.deepEqual([b.west, b.south, b.east, b.north], [-122.5, 37.699, -122.499, 37.7])
})

test('the borders file round trip: what tools/build-map-overlays.ts writes decodes back to its points, to 1e-4°', () => {
  const a = [[-117.12345, 32.53], [-116.9, 32.6], [-114.7, 32.72]]
  const b = [[34.25, 31.32], [34.267, 31.22]]
  const line = (coordinates: number[][]) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } })
  const got = decodeBorders(bordersFrom({ type: 'FeatureCollection', features: [line(a), line(b)] }))
  const want = [a, b].map((l) => l.flatMap(([lon, lat]) => [Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4]))
  assert.deepEqual(got.map((l) => [...l.pts]), want)
})

/** A border line straight from degree pairs (decodeBorders' shape). */
const border = (...pairs: [number, number][]) => decodeBorders({ lines: [pairs.flatMap(([lon, lat], i) => i === 0
  ? [Math.round(lon * 1e4), Math.round(lat * 1e4)]
  : [Math.round(lon * 1e4) - Math.round(pairs[i - 1][0] * 1e4), Math.round(lat * 1e4) - Math.round(pairs[i - 1][1] * 1e4)])] })[0]
const close = (got: number[], want: number[], tol = 0.05): boolean => got.length === want.length && got.every((v, i) => Math.abs(v - want[i]) <= tol)

test('tileRuns: a line across the world tile, in its pixels (Web Mercator, 256 px)', () => {
  const runs = tileRuns([border([-90, 0], [90, 0])], 0, 0, 0)
  assert.equal(runs.length, 1)
  assert.ok(close(runs[0], [64, 128, 192, 128]), String(runs[0]))
})

test('tileRuns: a line crossing a deeper tile draws along it, edge to edge; one far from the tile draws nothing', () => {
  const y40 = 131.7 // 40°N in tile (2, 1) of level 2
  const runs = tileRuns([border([-45, 40], [45, 40], [135, 40]), border([-100, -40], [-90, -40])], 2, 1, 2)
  assert.equal(runs.length, 1, 'the far line has no run')
  assert.ok(close(runs[0], [-128, y40, 128, y40, 384, y40], 0.1), String(runs[0]))
})

test('tileRuns: only the stretch near the tile, not a long line\'s whole length; a line whose box covers the tile but that passes by it draws nothing', () => {
  // Along 10°N from 170°W to 10°E: in tile (1, 3) of level 3 (135°–90°W, 0°–41°N) only the steps through it, and one each side.
  const long = border(...Array.from({ length: 19 }, (_, i): [number, number] => [-170 + i * 10, 10]))
  const runs = tileRuns([long], 1, 3, 3)
  assert.equal(runs.length, 1)
  const xs = runs[0].filter((_, i) => i % 2 === 0)
  assert.ok(xs.length <= 8 && xs.length >= 5, `${xs.length} points`)
  assert.ok(xs[0] < 0 && xs[xs.length - 1] > 256, String(xs))
  // An L round the tile's corner: its box holds the tile (0°–90°E, 0°–66.5°N at level 2), its lines never come near.
  assert.deepEqual(tileRuns([border([-10, 80], [100, 80], [100, -10])], 2, 1, 2), [])
})

test('tileRuns: a line within the 2-px margin outside a tile still draws (its halo reaches in); one 3 px out does not', () => {
  // Tile (0, 0) of level 1 ends at 0°E, x 256; 1.0547°E is x 257.5 and 2.109°E x 259.
  assert.equal(tileRuns([border([1.0547, 10], [1.0547, 20])], 0, 0, 1).length, 1)
  assert.equal(tileRuns([border([2.109, 10], [2.109, 20])], 0, 0, 1).length, 0)
})

/** A 2-D context that records what is drawn: each stroke with its style, width and path. */
function recorder() {
  const strokes: { style: string; width: number; join: string; cap: string; path: number[][] }[] = []
  let path: number[][] = []
  const ctx = {
    strokeStyle: '', lineWidth: 1, lineJoin: 'miter', lineCap: 'butt',
    beginPath: (): void => void (path = []),
    moveTo: (x: number, y: number): void => void path.push([x, y]),
    lineTo: (x: number, y: number): void => void path[path.length - 1].push(x, y),
    stroke: (): void => void strokes.push({ style: ctx.strokeStyle, width: ctx.lineWidth, join: ctx.lineJoin, cap: ctx.lineCap, path: path.map((r) => [...r]) }),
  }
  return { ctx, strokes }
}

test('strokeRuns: a dark 3-px halo under a light 1.4-px line, round joins, both along every run', () => {
  const { ctx, strokes } = recorder()
  const runs = [[0, 10, 50, 12, 100, 30], [200, 0, 210, 256]]
  strokeRuns(ctx as unknown as CanvasRenderingContext2D, runs)
  assert.deepEqual(strokes.map((s) => [s.style, s.width, s.join, s.cap]), [
    ['rgba(0, 0, 0, 0.45)', 3, 'round', 'round'],
    ['rgba(255, 238, 205, 0.92)', 1.4, 'round', 'round'],
  ])
  for (const s of strokes) assert.deepEqual(s.path, runs)
})

// The provider, with just enough of a browser: canvases that record their strokes, ImageData, frames.
class FakeImageData {
  width: number
  height: number
  constructor(w: number, h: number) {
    this.width = w
    this.height = h
  }
}
type FakeCanvas = { width: number; height: number; strokes: ReturnType<typeof recorder>['strokes']; getContext: () => unknown }
function fakeCanvas(): FakeCanvas {
  const { ctx, strokes } = recorder()
  return { width: 0, height: 0, strokes, getContext: () => ctx }
}
async function withBrowser(run: () => Promise<void>): Promise<void> {
  const g = globalThis as unknown as Record<string, unknown>
  const saved = (['document', 'ImageData', 'requestAnimationFrame'] as const).map((k) => [k, g[k]] as const)
  Object.assign(g, { document: { createElement: fakeCanvas }, ImageData: FakeImageData, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) })
  try {
    await run()
  } finally {
    for (const [k, v] of saved) g[k] = v
  }
}
const ISRAEL: BordersJson = { lines: [[351000, 331000, 1000, -500]] } // a line at 35.1°E–35.2°E, 33°N

test('BordersProvider: Web Mercator tiles to level 18; the data fetched once, on the first ask, every tile waiting for it', async () => {
  await withBrowser(async () => {
    const urls: string[] = []
    let answer!: (j: BordersJson) => void
    const p = new BordersProvider('map/borders.json', {
      getJson: (url) => {
        urls.push(url)
        return new Promise((r) => (answer = r))
      },
    })
    assert.equal(p.maximumLevel, BORDERS_MAX_LEVEL)
    assert.equal(BORDERS_MAX_LEVEL, 18)
    assert.equal(p.tilingScheme.getNumberOfXTilesAtLevel(0), 1, 'one Web Mercator tile at level 0')
    assert.deepEqual(urls, [], 'nothing asked before the layer shows')
    const near = p.requestImage(9, 6, 4) // 22.5°E–45°E, 21.9°N–40.9°N: holds the line
    const far = p.requestImage(0, 0, 4)
    p.load()
    answer(ISRAEL)
    const [a, b] = (await Promise.all([near, far])) as unknown as [FakeCanvas, FakeImageData]
    assert.deepEqual(urls, ['map/borders.json'], 'fetched once for both tiles')
    assert.deepEqual([a.width, a.height], [256, 256])
    assert.deepEqual(a.strokes.map((s) => s.width), [3, 1.4])
    assert.ok(b instanceof FakeImageData && b.width === 1 && b.height === 1, 'no line: one clear pixel')
    assert.equal(await p.requestImage(1, 1, 4), b, 'every empty tile shares it')
    assert.deepEqual(urls, ['map/borders.json'])
  })
})

test('BordersProvider: a tile still waiting for its turn when the layer hides is dropped, and Cesium hears it cancelled', async () => {
  await withBrowser(async () => {
    let shown = true
    const p = new BordersProvider('map/borders.json', { live: () => shown, getJson: () => Promise.resolve(ISRAEL) })
    const request = new Request({ url: 'map/borders.json' })
    const tile = p.requestImage(9, 6, 4, request)
    shown = false
    await assert.rejects(tile)
    assert.equal(request.state, RequestState.CANCELLED)
  })
})

/** Runs with console.warn collected into the array it gets, then puts it back. */
async function withWarnings(run: (warned: unknown[][]) => Promise<void>): Promise<void> {
  const warn = console.warn
  const warned: unknown[][] = []
  console.warn = (...a: unknown[]) => void warned.push(a)
  try {
    await run(warned)
  } finally {
    console.warn = warn
  }
}

test('BordersProvider: a failed fetch leaves the tiles clear with one warning; nothing is asked again for a minute, then it is', async () => {
  await withBrowser(() => withWarnings(async (warned) => {
    let t = 0
    let calls = 0
    const p = new BordersProvider('map/borders.json', {
      getJson: () => (++calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(ISRAEL)),
      now: () => t,
    })
    assert.ok((await p.requestImage(9, 6, 4)) instanceof FakeImageData, 'clear, not a tile error for Cesium to log')
    for (const at of [1000, 30_000, 59_999]) {
      t = at
      assert.ok((await p.requestImage(9, 6, 4)) instanceof FakeImageData)
    }
    assert.deepEqual([calls, warned.length], [1, 1], 'one fetch and one warning in the minute')
    t = 60_000
    const again = (await p.requestImage(9, 6, 4)) as unknown as FakeCanvas
    assert.equal(calls, 2)
    assert.equal(again.strokes.length, 2, 'drawn this time')
    assert.equal(warned.length, 1)
  }))
})

test('BordersProvider: a file that will not decode is a failure like any other: clear tiles, one warning, asked again only after the minute', async () => {
  await withBrowser(() => withWarnings(async (warned) => {
    let t = 0
    let calls = 0
    const p = new BordersProvider('map/borders.json', {
      getJson: () => (++calls, Promise.resolve({ lines: 5 } as unknown as BordersJson)),
      now: () => t,
    })
    assert.ok((await p.requestImage(9, 6, 4)) instanceof FakeImageData)
    t = 10_000
    assert.ok((await p.requestImage(1, 1, 4)) instanceof FakeImageData)
    assert.deepEqual([calls, warned.length], [1, 1])
    t = 70_000
    await p.requestImage(9, 6, 4)
    assert.deepEqual([calls, warned.length], [2, 2], 'one warning a failed minute')
  }))
})

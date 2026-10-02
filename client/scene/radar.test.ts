// client/scene/radar.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BANDS,
  RADAR_MAX_LEVEL,
  RAIN_PALETTE,
  RadarProvider,
  RadarSource,
  decodeTile,
  renderTile,
  sourceTiles,
  type Palette,
  type Rgba,
  type SourceTile,
} from './radar.ts'

const NONE = -128
const N = 256
type Cell = [number, number, number, boolean?] // x, y, dBZ, snow

/** A source tile with no echo but the given pixels. */
function tile(cells: Cell[] = []): SourceTile {
  const t = { dbz: new Int8Array(N * N).fill(NONE), snow: new Uint8Array(N * N) }
  for (const [x, y, d, s] of cells) {
    t.dbz[y * N + x] = d
    t.snow[y * N + x] = s ? 1 : 0
  }
  return t
}

/** Fills x0 ≤ x < x1, y0 ≤ y < y1 of t with one dBZ. */
function block(t: SourceTile, x0: number, y0: number, x1: number, y1: number, d: number, snow = false): SourceTile {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      t.dbz[y * N + x] = d
      t.snow[y * N + x] = snow ? 1 : 0
    }
  }
  return t
}

/** A source that holds the given tiles, keyed "x/y"; every other one has no echo. */
const from = (tiles: Record<string, SourceTile>) => (sx: number, sy: number): SourceTile | null => tiles[`${sx}/${sy}`] ?? null
const px = (out: Uint8ClampedArray, i: number, j: number): number[] => [...out.subarray((j * N + i) * 4, (j * N + i) * 4 + 4)]
/** A palette colour as the output bytes write it. */
const bytes = (c: Rgba): number[] => [...new Uint8ClampedArray([c[0], c[1], c[2], c[3] * 255])]

// A palette that writes the band count: rain band b is red 20·(b + 1), snow green, both opaque. A count c ≥ 1 reads back
// as red (or green) / 20, below 1 as alpha.
const ramp = (ch: number): Rgba[] => Array.from({ length: BANDS }, (_, b): Rgba => {
  const c: [number, number, number, number] = [0, 0, 0, 1]
  c[ch] = 20 * (b + 1)
  return c
})
const COUNT: Palette = { rain: ramp(0), snow: ramp(1) }
const countAt = (out: Uint8ClampedArray, i: number, j: number): number => {
  const [r, g, , a] = px(out, i, j)
  return a < 255 ? a / 255 : (r || g) / 20
}

test('decodeTile: each Universal Blue colour is one dBZ, rain or snow; no alpha or an unknown colour is no echo', () => {
  const colours = ['88ddeeff', 'ffee00ff', 'ffffffff', 'bfffffff', '9fdfffff', '88ddee00', '123456ff', '00ff00ff', '0000ffff', '6c685d24']
  const rgba = new Uint8ClampedArray(N * N * 4)
  colours.forEach((hex, i) => {
    for (let c = 0; c < 4; c++) rgba[i * 4 + c] = parseInt(hex.slice(c * 2, c * 2 + 2), 16)
  })
  const t = decodeTile(rgba)
  assert.equal(t.dbz.length, N * N)
  assert.equal(t.snow.length, N * N)
  // 15 rain, 35, 65 (white), 10 snow, 15 snow, alpha 0, unknown, 75+ (green: the first of its repeats), 75+ snow, −7 rain
  assert.deepEqual([...t.dbz.subarray(0, 11)], [15, 35, 65, 10, 15, NONE, NONE, 75, 75, -7, NONE])
  assert.deepEqual([...t.snow.subarray(0, 11)], [0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0])
})

test('renderTile: no echo draws nothing', () => {
  for (const out of [renderTile(7, 76, 50, () => null, COUNT), renderTile(9, 305, 201, from({ '76/50': tile() }), RAIN_PALETTE.dark)]) {
    assert.equal(out.length, N * N * 4)
    assert.ok(out.every((v, i) => i % 4 !== 3 || v === 0))
  }
})

test('renderTile: a one-pixel 40 dBZ cell at level 7 keeps its band\'s colour and draws no halo', () => {
  for (const pal of [RAIN_PALETTE.light, RAIN_PALETTE.dark]) {
    const out = renderTile(7, 76, 50, from({ '76/50': tile([[100, 120, 40]]) }), pal)
    assert.deepEqual(px(out, 100, 120), bytes(pal.rain[5]))
    for (const [i, j] of [[103, 120], [97, 120], [100, 123], [100, 117], [103, 123], [97, 117]]) assert.equal(px(out, i, j)[3], 0, `${i}, ${j}`)
    let shown = 0
    for (let p = 3; p < out.length; p += 4) if (out[p] > 0) shown++
    assert.ok(shown <= 9, `a small dot: ${shown} px`)
  }
})

test('renderTile: the same cell at level 9 is a dot of its band\'s colour, nothing above it (no overshoot)', () => {
  // Source pixel (100, 120) of tile 7/76/50 lies in its level-9 child (305, 201), whose square starts at (64, 64): its
  // 4 × 4 output block is 144…147 × 224…227.
  const src = from({ '76/50': tile([[100, 120, 40]]) })
  for (const pal of [RAIN_PALETTE.light, RAIN_PALETTE.dark]) {
    const out = renderTile(9, 305, 201, src, pal)
    for (const [i, j] of [[145, 225], [146, 225], [145, 226], [146, 226]]) assert.deepEqual(px(out, i, j), bytes(pal.rain[5]), `${i}, ${j}`)
  }
  const out = renderTile(9, 305, 201, src, COUNT)
  let most = 0
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) most = Math.max(most, countAt(out, i, j))
  assert.equal(most, 6) // 15, 20, … 40: six bands
})

test('renderTile: a 12 × 12 block of 20 dBZ at level 10 fills with its colour and its outline is anti-aliased over a pixel, not blurred', () => {
  // Source pixels 40…51 of tile 7/76/50 lie in its level-10 child (609, 401), square from 32: output 64…159 each way.
  const pal = RAIN_PALETTE.dark
  const out = renderTile(10, 609, 401, from({ '76/50': block(tile(), 40, 40, 52, 52, 20) }), pal)
  const full = bytes(pal.rain[1])
  for (let j = 66; j < 158; j++) for (let i = 66; i < 158; i++) assert.deepEqual(px(out, i, j), full, `${i}, ${j}`)
  const lines: [string, (t: number) => number[]][] = [['row 112', (t) => px(out, t, 112)], ['column 112', (t) => px(out, 112, t)]]
  for (const [name, at] of lines) {
    const partial: number[] = []
    for (let t = 0; t < N; t++) {
      const a = at(t)[3]
      if (a !== 0 && a !== full[3]) partial.push(t)
      if (t < 58 || t >= 166) assert.equal(a, 0, `${name}: ${t} is clear of the block`)
    }
    const left = partial.filter((t) => t < 112)
    const right = partial.filter((t) => t > 112)
    assert.ok(left.length >= 1 && left.length <= 2 && left.every((t) => t >= 60 && t < 66), `${name}: ${partial}`)
    assert.ok(right.length >= 1 && right.length <= 2 && right.every((t) => t >= 158 && t < 164), `${name}: ${partial}`)
  }
  assert.ok(px(out, 64, 64)[3] < full[3], 'the corners round')
})

/** An echo of several bands round (cx, cy): a cone of 55 dBZ at its peak. */
function cone(t: SourceTile, cx: number, cy: number): SourceTile {
  for (let y = cy - 16; y <= cy + 16; y++) {
    for (let x = cx - 16; x <= cx + 16; x++) {
      const d = Math.round(55 - 3 * Math.hypot(x - cx, y - cy))
      if (d >= 15) t.dbz[y * N + x] = d
    }
  }
  return t
}

test('renderTile: seams — two level-9 tiles from one source tile meet as smoothly as columns inside a tile', () => {
  const src = from({ '76/50': cone(tile(), 64, 30) }) // across the border between the children 304 and 305
  const left = renderTile(9, 304, 200, src, RAIN_PALETTE.dark)
  const right = renderTile(9, 305, 200, src, RAIN_PALETTE.dark)
  const step = (a: Uint8ClampedArray, i: number, b: Uint8ClampedArray, k: number): number => {
    let most = 0
    for (let j = 0; j < N; j++) for (let c = 0; c < 4; c++) most = Math.max(most, Math.abs(a[(j * N + i) * 4 + c] - b[(j * N + k) * 4 + c]))
    return most
  }
  let inside = 0
  for (let i = 0; i < N - 1; i++) inside = Math.max(inside, step(left, i, left, i + 1), step(right, i, right, i + 1))
  const seam = step(left, N - 1, right, 0)
  assert.ok(seam > 0, 'the echo crosses the border')
  assert.ok(seam <= inside, `seam ${seam}, inside ${inside}`)
})

test('renderTile: seams are exact — side by side, two tiles are the one drawn from the echo moved by half a tile', () => {
  // Level 9: the children 304 | 305 of tile 7/76/50, and child 304 of the echo moved 32 source pixels left.
  const left = renderTile(9, 304, 200, from({ '76/50': cone(tile(), 64, 30) }), RAIN_PALETTE.light)
  const right = renderTile(9, 305, 200, from({ '76/50': cone(tile(), 64, 30) }), RAIN_PALETTE.light)
  const moved = renderTile(9, 304, 200, from({ '76/50': cone(tile(), 32, 30) }), RAIN_PALETTE.light)
  // Level 7 across two source tiles (the neighbour's pixels are read): 76 | 77, and 76 with the echo moved 128 left.
  const a = block(tile(), 250, 100, 256, 112, 30)
  const b = block(tile(), 0, 100, 6, 112, 30)
  const l7 = renderTile(7, 76, 50, from({ '76/50': a, '77/50': b }), RAIN_PALETTE.light)
  const r7 = renderTile(7, 77, 50, from({ '76/50': a, '77/50': b }), RAIN_PALETTE.light)
  const m7 = renderTile(7, 76, 50, from({ '76/50': block(tile(), 122, 100, 134, 112, 30) }), RAIN_PALETTE.light)
  for (const [l, r, m] of [[left, right, moved], [l7, r7, m7]]) {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const want = i < N / 2 ? px(l, i + N / 2, j) : px(r, i - N / 2, j)
        assert.deepEqual(px(m, i, j), want, `${i}, ${j}`)
      }
    }
  }
  assert.ok(px(r7, 0, 105)[3] > 0 && px(l7, 255, 105)[3] > 0)
})

test('renderTile: x wraps round the world; rows off the map are never asked for', () => {
  const asked: string[] = []
  const edge = block(tile(), 250, 0, 256, 6, 30)
  const out = renderTile(7, 0, 0, (sx, sy) => {
    asked.push(`${sx}/${sy}`)
    return sx === 127 && sy === 0 ? edge : null
  }, RAIN_PALETTE.dark)
  assert.ok(asked.every((k) => /^\d+\/\d+$/.test(k) && Number(k.split('/')[0]) < 128 && Number(k.split('/')[1]) < 128), asked.join(' '))
  assert.ok(asked.includes('127/0'))
  assert.deepEqual([...out], [...renderTile(7, 1, 0, from({ '0/0': edge }), RAIN_PALETTE.dark)]) // as tile 1 east of tile 0
})

test('renderTile: snow paints from the snow palette, to its outline; rain beside it from the rain palette', () => {
  const pal = RAIN_PALETTE.dark
  const lone = renderTile(7, 76, 50, from({ '76/50': tile([[100, 120, 30, true]]) }), pal)
  assert.deepEqual(px(lone, 100, 120), bytes(pal.snow[3]))
  // Rain west of source column 60, snow east of it: the level-9 children 304 (columns 0…63) and 305 (64…127), rows 0…63.
  const t = block(block(tile(), 40, 40, 60, 60, 30), 60, 40, 80, 60, 30, true)
  const centre = (sx: number, sy: number): [number, number] => [(sx % 64) * 4 + 2, sy * 4 + 2] // a source pixel's output centre
  assert.deepEqual(px(renderTile(9, 305, 200, from({ '76/50': t }), pal), ...centre(70, 50)), bytes(pal.snow[3]))
  assert.deepEqual(px(renderTile(9, 304, 200, from({ '76/50': t }), pal), ...centre(50, 50)), bytes(pal.rain[3]))
  // No rain-coloured rim round the snow: every pixel drawn there comes from the snow palette.
  const counts = renderTile(9, 305, 200, from({ '76/50': block(tile(), 70, 40, 90, 60, 30, true) }), COUNT)
  let drawn = 0
  for (let p = 0; p < counts.length; p += 4) {
    if (counts[p + 3] === 0) continue
    drawn++
    assert.equal(counts[p], 0, `pixel ${p / 4}: no rain colour`)
  }
  assert.ok(drawn > 0)
})

test('sourceTiles: the tile\'s own source tile and only the neighbours its edge reaches', () => {
  const sorted = (l: [number, number][]): string[] => l.map(([x, y]) => `${x}/${y}`).sort()
  const same = (got: [number, number][], want: string[]): void => assert.deepEqual(sorted(got), want.sort())
  same(sourceTiles(12, 76 * 32 + 16, 50 * 32 + 16), ['76/50']) // the middle of its level-7 ancestor
  same(sourceTiles(12, 76 * 32, 50 * 32), ['75/49', '75/50', '76/49', '76/50']) // its top-left corner
  same(sourceTiles(8, 76 * 2 + 1, 50 * 2 + 1), ['76/50', '76/51', '77/50', '77/51'])
  assert.equal(sourceTiles(7, 76, 50).length, 9) // a whole source tile: all its neighbours
  same(sourceTiles(7, 0, 0), ['0/0', '0/1', '1/0', '1/1', '127/0', '127/1']) // x wraps, no row above the map
  same(sourceTiles(3, 2, 7), ['1/6', '1/7', '2/6', '2/7', '3/6', '3/7']) // below 7: the tile itself and its neighbours
  same(sourceTiles(0, 0, 0), ['0/0'])
})

test('RadarSource: one fetch per tile of the frame; a failed tile is no echo and is not asked for again', async () => {
  const asked: string[] = []
  const [fetch0, warn0] = [globalThis.fetch, console.warn]
  globalThis.fetch = (async (url: string | URL | Request) => {
    asked.push(String(url))
    return new Response(null, { status: 404 })
  }) as typeof fetch
  console.warn = () => {}
  try {
    const source = new RadarSource('https://tilecache.rainviewer.com', '/v2/radar/abc')
    assert.equal(source.url, 'https://tilecache.rainviewer.com/v2/radar/abc/256/{z}/{x}/{y}/2/0_1.png')
    const first = source.get(7, 76, 50)
    assert.equal(source.get(7, 76, 50), first)
    assert.equal(await first, null)
    assert.equal(await source.get(7, 76, 50), null)
    assert.deepEqual(asked, ['https://tilecache.rainviewer.com/v2/radar/abc/256/7/76/50/2/0_1.png'])
  } finally {
    globalThis.fetch = fetch0
    console.warn = warn0
  }
})

test('RadarProvider: tiles to level 12 from the frame\'s source; each asks only the source tiles it reads; none with echo → one blank', async () => {
  const asked: string[] = []
  const echo = tile([[100, 120, 40]])
  class Stub extends RadarSource {
    override get(z: number, x: number, y: number): Promise<SourceTile | null> {
      asked.push(`${z}/${x}/${y}`)
      return Promise.resolve(z === 7 && x === 76 && y === 50 ? echo : null)
    }
  }
  // Just enough of a DOM: a canvas that keeps what is put in it, ImageData, and frames.
  class FakeImageData {
    data: Uint8ClampedArray
    width: number
    height: number
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data
      this.width = width
      this.height = height
    }
  }
  const fakeCanvas = () => {
    const c = { width: 0, height: 0, put: null as FakeImageData | null, getContext: () => ({ putImageData: (d: FakeImageData) => void (c.put = d) }) }
    return c
  }
  const g = globalThis as unknown as Record<string, unknown>
  const saved = ['document', 'ImageData', 'requestAnimationFrame'].map((k) => [k, g[k]] as const)
  Object.assign(g, {
    document: { createElement: fakeCanvas },
    ImageData: FakeImageData,
    requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
  })
  try {
    const p = new RadarProvider(new Stub('https://h', '/p'), RAIN_PALETTE.dark)
    assert.equal(p.url, 'https://h/p/256/{z}/{x}/{y}/2/0_1.png')
    assert.equal(p.maximumLevel, RADAR_MAX_LEVEL)
    assert.equal(RADAR_MAX_LEVEL, 12)
    const c = (await p.requestImage(76 * 32 + 16, 50 * 32 + 16, 12)) as unknown as ReturnType<typeof fakeCanvas>
    assert.deepEqual(asked, ['7/76/50'])
    assert.deepEqual([c.width, c.height], [256, 256])
    assert.equal(c.put?.data.length, 256 * 256 * 4)
    asked.length = 0
    const nothing = await p.requestImage(10, 10, 9)
    assert.deepEqual(asked, ['7/2/2'])
    assert.equal(await p.requestImage(11, 10, 9), nothing, 'one shared blank')
    const drawn = (await p.requestImage(305, 201, 9)) as unknown as ReturnType<typeof fakeCanvas>
    assert.deepEqual([...drawn.put!.data.subarray((225 * 256 + 145) * 4, (225 * 256 + 145) * 4 + 4)], bytes(RAIN_PALETTE.dark.rain[5]))
  } finally {
    for (const [k, v] of saved) g[k] = v
  }
})

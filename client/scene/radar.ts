// client/scene/radar.ts
// The rain radar drawn smooth at every zoom, in a palette made for the map under it. RadarSource fetches and decodes a
// frame's tiles and renderTile draws one output tile; weather.ts puts it on the map (RadarProvider, RadarLayer), spreading
// the drawing over frames (drawQueue.ts). No Cesium here: the Layers panel takes its palettes from this file.
//
// RainViewer's free API serves its newest frame as 256-px tiles up to zoom 7 (deeper ones are a "zoom not supported"
// picture), in its "Universal Blue" colours: each colour is one whole dBZ, rain and snow apart. A real cell is ~2 × 2 tile
// pixels, so magnified as they are the tiles are the 1-km squares the user saw. Blurring the dBZ before colouring rounds
// them but lowered small storm cores by up to 19 dBZ (a storm drawn as light rain), so each 5-dBZ band's REGION is
// smoothed instead: for every threshold T the 0/1 field "dBZ ≥ T" is resampled with a cubic B-spline (smooth, never
// overshoots) and the band's edge drawn where it crosses LEVEL, anti-aliased over one pixel. A pixel shows its bands laid
// one over the next, each by its share of the pixel: bands nest, every core keeps its colour (a one-pixel cell stays a
// small dot of it) and the outlines are curves. A tile reads M source pixels round its square from the neighbouring tiles,
// so tiles meet without seams. The data is RainViewer's as sent; only the drawing is ours.
// Colours: https://www.rainviewer.com/files/rainviewer_api_colors_table.csv, column "Universal Blue" (read 2026-10-02).

export const RADAR_INDEX = 'https://api.rainviewer.com/public/weather-maps.json' // its frames, newest past one last
export interface RadarIndex { host: string; radar: { past: { time: number; path: string }[] } }
export const RADAR_SRC_MAX = 7 // RainViewer's free API: deeper zooms are a "zoom not supported" picture
export const RADAR_MAX_LEVEL = 12 // our deepest tile (a source pixel 32 px wide); Cesium magnifies past it
export const FIRST_DBZ = 15 // RainViewer's coloured scale starts here; their faint beige below it is left out
export const STEP_DBZ = 5
export const BANDS = 11 // 15, 20, … 60, 65+
const LEVEL = 0.35 // a band's edge: where its smoothed share crosses this (0.5 would shrink one-pixel cells away)
export const NONE = -128 // a decoded tile's "no echo"
const M = 3 // source pixels read round a tile's square: the B-spline's reach (2) and the gradient's pixel
const SIZE = 256 // a tile's pixels each way, source and output
const W = SIZE + 2 // a resampled field's width: output pixels −1 … 256, the margin for the gradient
const PMAX = SIZE + 2 * M // the widest patch of source pixels (levels ≤ 7)
const FULL = LEVEL + Math.SQRT1_2 / 2 // a field this high is inside its edge whatever its gradient (never above √½)

export type Rgba = readonly [number, number, number, number] // 0–255 ×3, alpha 0–1
export interface Palette { rain: readonly Rgba[]; snow: readonly Rgba[] } // BANDS each
export interface SourceTile { dbz: Int8Array; snow: Uint8Array } // 256 × 256, row-major, north row first; NONE: no echo

// RRGGBBAA by dBZ: UB_RAIN[i] and UB_SNOW[i] are dBZ i − 10. Alpha 00: no echo.
const UB_RAIN = [
  '63615914', '66635a19', '69665c1e', '6c685d24', '6f6b5f29', '726e612e', '75706234', '78736439', '7c75653e',
  '7f786744', '827b6949', '857d6a4e', '88806c54', '8b826d59', '8e856f5e', '92887164', '9e93756e', 'aa9e7978',
  'b6a97e82', 'c2b4828c', 'cec08796', 'd2c48ba0', 'd6c88faa', 'dacc93b4', 'ded097be', '88ddeeff', '6cd1ebff',
  '51c5e8ff', '36bae5ff', '1baee2ff', '00a3e0ff', '009ad5ff', '0091caff', '0088bfff', '007fb4ff', '0077aaff',
  '0070a3ff', '00699cff', '006295ff', '005b8eff', '005588ff', '005180ff', '004e78ff', '004a70ff', '004768ff',
  'ffee00ff', 'ffe000ff', 'ffd200ff', 'ffc500ff', 'ffb700ff', 'ffaa00ff', 'ff9f00ff', 'ff9500ff', 'ff8b00ff',
  'ff8100ff', 'ff4400ff', 'f23600ff', 'e62800ff', 'd91b00ff', 'cd0d00ff', 'c10000ff', 'a80000ff', '8f0000ff',
  '760000ff', '5d0000ff', 'ffaaffff', 'ff9fffff', 'ff95ffff', 'ff8bffff', 'ff81ffff', 'ff77ffff', 'ff6cffff',
  'ff62ffff', 'ff58ffff', 'ff4effff', 'ffffffff', 'ffffffff', 'ffffffff', 'ffffffff', 'ffffffff', 'ffffffff',
  'ffffffff', 'ffffffff', 'ffffffff', 'ffffffff', '00ff00ff', '00ff00ff', '00ff00ff', '00ff00ff', '00ff00ff',
  '00ff00ff', '00ff00ff', '00ff00ff', '00ff00ff', '00ff00ff', '00ff00ff', '00ff00ff', '00ff00ff', '00ff00ff',
  '00ff00ff', '00ff00ff', '00ff00ff', '00ff00ff', '00ff00ff', '00ff00ff', '00ff00ff',
]
const UB_SNOW = [
  'cfffff00', 'ceffff0c', 'cdffff19', 'ccffff26', 'cbffff33', 'cbffff3f', 'caffff4c', 'c9ffff59', 'c8ffff66',
  'c7ffff72', 'c7ffff7f', 'c6ffff8c', 'c5ffff99', 'c4ffffa5', 'c3ffffb2', 'c3ffffbf', 'c2ffffcc', 'c1ffffd8',
  'c0ffffe5', 'bffffff2', 'bfffffff', 'b8f8ffff', 'b2f2ffff', 'abebffff', 'a5e5ffff', '9fdfffff', '98d8ffff',
  '92d2ffff', '8bcbffff', '85c5ffff', '7fbfffff', '78b8ffff', '72b2ffff', '6babffff', '65a5ffff', '5f9fffff',
  '5b9bffff', '5898ffff', '5595ffff', '5292ffff', '4f8fffff', '4b8bffff', '4888ffff', '4585ffff', '4282ffff',
  '3f7fffff', '3b7bffff', '3878ffff', '3575ffff', '3272ffff', '2f6fffff', '2b6bffff', '2868ffff', '2565ffff',
  '2262ffff', '1f5fffff', '1b5bffff', '1858ffff', '1555ffff', '1252ffff', '0f4fffff', '0c4bffff', '0948ffff',
  '0645ffff', '0242ffff', '003fffff', '003bffff', '0038ffff', '0035ffff', '0032ffff', '002fffff', '002bffff',
  '0028ffff', '0025ffff', '0022ffff', '001fffff', '001bffff', '0018ffff', '0015ffff', '0012ffff', '000fffff',
  '000cffff', '0009ffff', '0006ffff', '0002ffff', '0000ffff', '0000ffff', '0000ffff', '0000ffff', '0000ffff',
  '0000ffff', '0000ffff', '0000ffff', '0000ffff', '0000ffff', '0000ffff', '0000ffff', '0000ffff', '0000ffff',
  '0000ffff', '0000ffff', '0000ffff', '0000ffff', '0000ffff', '0000ffff', '0000ffff',
]

// Packed RGBA → the dBZ in its low byte (signed) | 0x100 for snow. A colour repeated up the scale (65+ white, 75+ green
// and blue) reads as its first dBZ.
const ECHO = new Map<number, number>()
for (const [table, snow] of [[UB_RAIN, 0], [UB_SNOW, 0x100]] as const) {
  table.forEach((hex, i) => {
    const rgba = parseInt(hex, 16) >>> 0
    if ((rgba & 0xff) !== 0 && !ECHO.has(rgba)) ECHO.set(rgba, ((i - 10) & 0xff) | snow)
  })
}

/** RGBA bytes of a Universal Blue tile → dBZ and snow per pixel. */
export function decodeTile(rgba: Uint8ClampedArray): SourceTile {
  const n = rgba.length >> 2
  const dbz = new Int8Array(n).fill(NONE)
  const snow = new Uint8Array(n)
  let key0 = -1 // the last colour looked up: echoes come in runs
  let echo0: number | undefined
  for (let p = 0, q = 0; p < n; p++, q += 4) {
    if (rgba[q + 3] === 0) continue
    const key = ((rgba[q] << 24) | (rgba[q + 1] << 16) | (rgba[q + 2] << 8) | rgba[q + 3]) >>> 0
    if (key !== key0) {
      key0 = key
      echo0 = ECHO.get(key)
    }
    if (echo0 === undefined) continue
    dbz[p] = echo0 // an Int8Array keeps the low byte: the signed dBZ
    snow[p] = echo0 >> 8
  }
  return { dbz, snow }
}

const hex = (...cs: [string, number][]): Rgba[] =>
  cs.map(([h, a]): Rgba => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a])

export const RAIN_PALETTE: Record<'light' | 'dark', Palette> = {
  // the light street map: deeper blues for its pale land and blue sea, amber not yellow; light rain faint, so the map shows through
  light: { rain: hex(['#1f86ff', .30], ['#1170f0', .40], ['#1556d6', .48], ['#2a3cb5', .56], ['#ffb300', .62],
    ['#ff8800', .66], ['#f04a2a', .70], ['#c81d42', .74], ['#9b2bc4', .78], ['#6c1fa0', .82], ['#4a148c', .85]),
    snow: hex(['#8f86ff', .28], ['#7d72f5', .36], ['#6a5ce6', .44], ['#5847d4', .52], ['#4b3bc4', .6], ['#4b3bc4', .6],
    ['#4b3bc4', .6], ['#4b3bc4', .6], ['#4b3bc4', .6], ['#4b3bc4', .6], ['#4b3bc4', .6]) },
  // the dark map and the satellite: luminous cyan to indigo, then warm; light rain faint, so the map shows through
  dark: { rain: hex(['#36b4ff', .30], ['#2f9bff', .40], ['#2f7dff', .48], ['#4a63ff', .56], ['#f5c842', .62],
    ['#ff9a35', .66], ['#ff5c3d', .70], ['#e83563', .74], ['#cf5cff', .78], ['#ecd4ff', .82], ['#ffffff', .85]),
    snow: hex(['#cfe0ff', .28], ['#dbe7ff', .36], ['#e6eeff', .44], ['#f0f5ff', .52], ['#ffffff', .6], ['#ffffff', .6],
    ['#ffffff', .6], ['#ffffff', .6], ['#ffffff', .6], ['#ffffff', .6], ['#ffffff', .6]) },
}

/** A palette for the drawing loop: each band's colour premultiplied by its alpha (r·a, g·a, b·a, a), then the first
 *  band's colour as it is, with alpha 0, for clear pixels. */
const premultiplied = new WeakMap<readonly Rgba[], Float64Array>()
function premultipliedOf(cs: readonly Rgba[]): Float64Array {
  let t = premultiplied.get(cs)
  if (t === undefined) {
    t = Float64Array.from([...cs.flatMap(([r, g, b, a]) => [r * a, g * a, b * a, a]), cs[0][0], cs[0][1], cs[0][2], 0])
    premultiplied.set(cs, t)
  }
  return t
}

/** Where a tile at level/x/y reads from: the source tile at level z (≤ 7) and the size × size square at ox, oy in it. */
function square(level: number, x: number, y: number) {
  const z = Math.min(level, RADAR_SRC_MAX)
  const d = level - z
  const size = SIZE >> d
  const sx = x >> d
  const sy = y >> d
  return { z, d, size, sx, sy, ox: (x - (sx << d)) * size, oy: (y - (sy << d)) * size }
}

/** The source tiles a tile at level/x/y reads: its own and the neighbours within M pixels of its square (x wrapped). */
export function sourceTiles(level: number, x: number, y: number): [number, number][] {
  const { z, size, sx, sy, ox, oy } = square(level, x, y)
  const n = 2 ** z
  const out: [number, number][] = []
  const seen = new Set<number>()
  for (let dy = oy < M ? -1 : 0; dy <= (oy + size + M > SIZE ? 1 : 0); dy++) {
    for (let dx = ox < M ? -1 : 0; dx <= (ox + size + M > SIZE ? 1 : 0); dx++) {
      const ty = sy + dy
      const tx = (((sx + dx) % n) + n) % n
      if (ty < 0 || ty >= n || seen.has(ty * n + tx)) continue
      seen.add(ty * n + tx)
      out.push([tx, ty])
    }
  }
  return out
}

/** The cubic B-spline taps of a tile d levels below its source (magnified 2^d times): the same for rows and columns. */
interface Taps {
  first: Int32Array // per field sample (output pixel + 1): the first of the 4 patch pixels it reads
  w: Float64Array // their weights, 4 per sample
  from: Int32Array // per patch pixel x: the first sample reading x or a pixel after it
  to: Int32Array // per patch pixel x: one past the last sample reading x or a pixel before it
}
const TAPS: Taps[] = []
function tapsFor(d: number): Taps {
  if (TAPS[d]) return TAPS[d]
  const k = 2 ** d
  const P = (SIZE >> d) + 2 * M
  const first = new Int32Array(W)
  const w = new Float64Array(W * 4)
  for (let a = 0; a < W; a++) {
    const u = M + (a - 0.5) / k - 0.5 // output pixel a − 1, in patch pixels
    const t = u - Math.floor(u)
    first[a] = Math.floor(u) - 1
    w.set([(1 - t) ** 3 / 6, (3 * t ** 3 - 6 * t ** 2 + 4) / 6, (-3 * t ** 3 + 3 * t ** 2 + 3 * t + 1) / 6, t ** 3 / 6], a * 4)
  }
  const from = new Int32Array(P)
  const to = new Int32Array(P)
  for (let x = 0; x < P; x++) {
    let a = 0
    while (a < W && first[a] + 3 < x) a++
    from[x] = a
    let b = W - 1
    while (b >= 0 && first[b] > x) b--
    to[x] = b + 1
  }
  return (TAPS[d] = { first, w, from, to })
}

/** Scratch for drawing, made on first use and reused: drawing is synchronous, one tile at a time. */
interface Scratch {
  dbz: Int8Array // the patch: P × P source pixels round the square
  snow: Uint8Array
  ind: Uint8Array // a 0/1 field over the patch
  h: Float64Array // the field resampled along its rows: P rows × W
  hLo: Int32Array // per row of h: the samples [lo, hi) that can be above 0
  hHi: Int32Array
  f: Float64Array // W × W resampled: each band's in turn,
  fs: Float64Array // and the snow's
  fLo: Int32Array // per row of the last field resampled: [lo, hi) as hLo
  fHi: Int32Array
  // Per output pixel: what its bands below the last one reached left it (premultiplied colour, 4 each), that last band
  // and its share, and 1 where it takes the snow palette.
  acc: Float64Array
  top: Int8Array
  share: Float64Array
  pick: Uint8Array
}
let scratch: Scratch | null = null
const scratchOf = (): Scratch => (scratch ??= {
  dbz: new Int8Array(PMAX * PMAX), snow: new Uint8Array(PMAX * PMAX), ind: new Uint8Array(PMAX * PMAX),
  h: new Float64Array(PMAX * W), hLo: new Int32Array(PMAX), hHi: new Int32Array(PMAX),
  f: new Float64Array(W * W), fs: new Float64Array(W * W), fLo: new Int32Array(W), fHi: new Int32Array(W),
  acc: new Float64Array(SIZE * SIZE * 4), top: new Int8Array(SIZE * SIZE), share: new Float64Array(SIZE * SIZE), pick: new Uint8Array(SIZE * SIZE),
})

/** s.ind (P × P) resampled into f (W × W): along the rows, then the columns, each row only where its ones reach. */
function resample(s: Scratch, P: number, taps: Taps, f: Float64Array): void {
  const { ind, h, hLo, hHi, fLo, fHi } = s
  const { first, w, from, to } = taps
  for (let y = 0; y < P; y++) {
    const r = y * P
    const hr = y * W
    let lo = 0
    while (lo < P && ind[r + lo] === 0) lo++
    if (lo === P) {
      hLo[y] = hHi[y] = 0
      h.fill(0, hr, hr + W)
      continue
    }
    let hi = P - 1
    while (ind[r + hi] === 0) hi--
    const a0 = from[lo]
    const a1 = to[hi]
    hLo[y] = a0
    hHi[y] = a1
    h.fill(0, hr, hr + a0)
    h.fill(0, hr + a1, hr + W)
    for (let a = a0; a < a1; a++) {
      const x = r + first[a]
      const q = a * 4
      h[hr + a] = w[q] * ind[x] + w[q + 1] * ind[x + 1] + w[q + 2] * ind[x + 2] + w[q + 3] * ind[x + 3]
    }
  }
  for (let a = 0; a < W; a++) {
    const y = first[a]
    const fr = a * W
    let lo = W
    let hi = 0
    for (let t = y; t < y + 4; t++) {
      if (hHi[t] <= hLo[t]) continue
      if (hLo[t] < lo) lo = hLo[t]
      if (hHi[t] > hi) hi = hHi[t]
    }
    if (lo >= hi) {
      fLo[a] = fHi[a] = 0
      f.fill(0, fr, fr + W)
      continue
    }
    fLo[a] = lo
    fHi[a] = hi
    f.fill(0, fr, fr + lo)
    f.fill(0, fr + hi, fr + W)
    const q = a * 4
    const w0 = w[q]
    const w1 = w[q + 1]
    const w2 = w[q + 2]
    const w3 = w[q + 3]
    const r0 = y * W
    const r1 = r0 + W
    const r2 = r1 + W
    const r3 = r2 + W
    for (let x = lo; x < hi; x++) f[fr + x] = w0 * h[r0 + x] + w1 * h[r1 + x] + w2 * h[r2 + x] + w3 * h[r3 + x]
  }
}

/**
 * Band b (its field in s.f) on each output pixel, by its share: 1 inside its edge, 0 outside, and on the edge how far in
 * the pixel lies (the field over its gradient, in pixels) + ½, never more than the band below's (bands nest). What that
 * leaves the band below, its share less this one's, goes into acc in its colour: a pixel shows each band by how much of
 * it is in that band and no higher. Outside the rows' spans the field is 0: no share, the band below keeps its own.
 */
function addBand(s: Scratch, b: number, rain: Float64Array, snow: Float64Array, pick: Uint8Array | null): void {
  const { f, fLo, fHi, acc, top, share } = s
  const o = (b - 1) * 4
  for (let j = 0; j < SIZE; j++) {
    const fr = (j + 1) * W
    const pr = j * SIZE - 1 // the output pixel under field column x: pr + x
    const hi = Math.min(fHi[j + 1], W - 1)
    for (let x = Math.max(fLo[j + 1], 1); x < hi; x++) {
      const q = fr + x
      const v = f[q]
      let sh = 1
      if (v < FULL) {
        const gx = f[q + 1] - f[q - 1]
        const gy = f[q + W] - f[q - W]
        const e = v - LEVEL
        const g2 = Math.max(0.25 * (gx * gx + gy * gy), 1e-8) // the gradient's square, at least 1e-4²
        sh = 4 * e * e >= g2 ? (e > 0 ? 1 : 0) : e / Math.sqrt(g2) + 0.5 // half a pixel or more from the edge: all or none
      }
      const p = pr + x
      const below = share[p]
      if (sh > below) sh = below
      if (sh < below && b > 0) {
        const cs = pick !== null && pick[p] === 1 ? snow : rain
        const w = below - sh
        const k = p * 4
        acc[k] += w * cs[o]
        acc[k + 1] += w * cs[o + 1]
        acc[k + 2] += w * cs[o + 2]
        acc[k + 3] += w * cs[o + 3]
      }
      share[p] = sh
      top[p] = b
    }
  }
}

/** Per output pixel, 1 where snow is at least half the echo round it: the snow's field against the first band's (f0, or
 *  null when that band covers the whole patch). To the echo's outline, where both thin out together. */
function choose(s: Scratch, f0: Float64Array | null): Uint8Array {
  const { fs, pick } = s
  for (let j = 0, p = 0; j < SIZE; j++) {
    const fr = (j + 1) * W + 1
    for (let i = 0; i < SIZE; i++, p++) {
      const v = fs[fr + i]
      pick[p] = v > 0 && 2 * v >= (f0 === null ? 1 : f0[fr + i]) ? 1 : 0
    }
  }
  return pick
}

/**
 * One 256 × 256 output tile (RGBA bytes, straight alpha) at level/x/y, or null when it draws nothing. Its source is the
 * tile at level min(level, 7): itself up to 7, else its level-7 ancestor, of which it covers a 256 / 2^d square magnified
 * k = 2^d times (d = level − 7). src(sx, sy) answers a decoded source tile of that level (x wraps; a y outside the map,
 * or a missing tile → null, read as no echo); M source pixels round the square come from the neighbours, so adjacent
 * tiles meet seamlessly.
 */
export function renderTile(level: number, x: number, y: number, src: (sx: number, sy: number) => SourceTile | null, pal: Palette): Uint8ClampedArray<ArrayBuffer> | null {
  const { z, d, size, sx, sy, ox, oy } = square(level, x, y)
  const n = 2 ** z
  const P = size + 2 * M
  const s = scratchOf()
  const { dbz, snow, ind } = s
  // The patch: P × P source pixels from (ox − M, oy − M) of tile (sx, sy), across into its neighbours.
  const near: (SourceTile | null | undefined)[] = []
  for (let py = 0; py < P; py++) {
    const r = py * P
    const gy = sy * SIZE + oy - M + py
    const ty = Math.floor(gy / SIZE)
    if (ty < 0 || ty >= n) {
      dbz.fill(NONE, r, r + P)
      snow.fill(0, r, r + P)
      continue
    }
    const row = (gy - ty * SIZE) * SIZE
    for (let px = 0; px < P;) {
      const gx = sx * SIZE + ox - M + px
      const tx = Math.floor(gx / SIZE)
      const col = gx - tx * SIZE
      const len = Math.min(P - px, SIZE - col)
      const k = (ty - sy + 1) * 3 + (tx - sx + 1)
      let t = near[k]
      if (t === undefined) t = near[k] = src(((tx % n) + n) % n, ty)
      if (t === null) {
        dbz.fill(NONE, r + px, r + px + len)
        snow.fill(0, r + px, r + px + len)
      } else {
        dbz.set(t.dbz.subarray(row + col, row + col + len), r + px)
        snow.set(t.snow.subarray(row + col, row + col + len), r + px)
      }
      px += len
    }
  }
  let max = NONE
  let min = 127
  let snowy = false
  for (let p = 0; p < P * P; p++) {
    const v = dbz[p]
    if (v > max) max = v
    if (v < min) min = v
    if (snow[p] !== 0 && v >= FIRST_DBZ) snowy = true
  }
  if (max < FIRST_DBZ) return null
  // The bands every patch pixel is in (1 everywhere: not resampled), and those any is in.
  const inBands = (v: number): number => (v < FIRST_DBZ ? 0 : Math.min(BANDS, Math.floor((v - FIRST_DBZ) / STEP_DBZ) + 1))
  const whole = inBands(min)
  const present = inBands(max)
  const taps = tapsFor(d)
  const rain = premultipliedOf(pal.rain)
  const snowCs = premultipliedOf(pal.snow)
  const { acc, top, share } = s
  acc.fill(0)
  share.fill(1)
  top.fill(whole - 1)
  let pick: Uint8Array | null = null
  if (snowy) {
    for (let p = 0; p < P * P; p++) ind[p] = snow[p] !== 0 && dbz[p] >= FIRST_DBZ ? 1 : 0
    resample(s, P, taps, s.fs)
    if (whole > 0) pick = choose(s, null)
  }
  for (let b = whole; b < present; b++) {
    const T = FIRST_DBZ + STEP_DBZ * b
    for (let p = 0; p < P * P; p++) ind[p] = dbz[p] >= T ? 1 : 0
    resample(s, P, taps, s.f)
    addBand(s, b, rain, snowCs, pick)
    if (b === 0 && snowy) pick = choose(s, s.f) // the first band leaves acc nothing: the palettes can wait for its field
  }
  // Each pixel: what its lower bands left in acc, and its last band by its share; then straight colour and alpha.
  const out = new Uint8ClampedArray(SIZE * SIZE * 4)
  let drawn = false
  for (let p = 0; p < SIZE * SIZE; p++) {
    const cs = pick !== null && pick[p] === 1 ? snowCs : rain
    const k = p * 4
    let r = acc[k]
    let g = acc[k + 1]
    let bl = acc[k + 2]
    let a = acc[k + 3]
    const t = top[p]
    if (t >= 0) {
      const w = share[p]
      const o = t * 4
      r += w * cs[o]
      g += w * cs[o + 1]
      bl += w * cs[o + 2]
      a += w * cs[o + 3]
    }
    if (a > 0) {
      out[k] = r / a
      out[k + 1] = g / a
      out[k + 2] = bl / a
      out[k + 3] = a * 255
      if (out[k + 3] > 0) drawn = true
    } else { // clear: still the first band's colour, so filtering draws no dark rim
      const o = BANDS * 4
      out[k] = cs[o]
      out[k + 1] = cs[o + 1]
      out[k + 2] = cs[o + 2]
    }
  }
  return drawn ? out : null
}

let reader: CanvasRenderingContext2D | null = null

/** A tile image's RGBA bytes, through one reused canvas. */
function pixelsOf(img: ImageBitmap): Uint8ClampedArray {
  if (reader === null) {
    const c = document.createElement('canvas')
    c.width = c.height = SIZE
    reader = c.getContext('2d', { willReadFrequently: true })!
  }
  reader.clearRect(0, 0, SIZE, SIZE)
  reader.drawImage(img, 0, 0)
  img.close()
  return reader.getImageData(0, 0, SIZE, SIZE).data
}

/**
 * Decoded source tiles of one frame, fetched once each and shared by every tile and palette drawn from them.
 * ponytail: keeps every tile of the frame it was asked for (a frame lives 10 min; a session pans over tens of tiles, 128 KB
 * each), the next frame's source replaces it.
 */
export class RadarSource {
  readonly url: string // the frame's z/x/y template
  private readonly tiles = new Map<string, Promise<SourceTile | null>>()

  constructor(host: string, path: string) {
    this.url = `${host}${path}/256/{z}/{x}/{y}/2/0_1.png` // no server blur (it erased storm cores), snow told apart
  }

  /** The decoded tile, null when it has no echo or failed; the same promise for the same tile. */
  get(z: number, x: number, y: number): Promise<SourceTile | null> {
    const key = `${z}/${x}/${y}`
    let tile = this.tiles.get(key)
    if (tile === undefined) this.tiles.set(key, (tile = this.load(z, x, y)))
    return tile
  }

  private async load(z: number, x: number, y: number): Promise<SourceTile | null> {
    const url = this.url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
    try {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      // The colours must arrive exactly as sent: each is a dBZ.
      const px = pixelsOf(await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none' }))
      let seen = false
      for (let q = 3; q < px.length && !seen; q += 4) seen = px[q] !== 0
      if (!seen) return null // no echo: no arrays kept
      const tile = decodeTile(px)
      return tile.dbz.some((v) => v >= FIRST_DBZ) ? tile : null
    } catch (e) {
      console.warn(`FlightHopper: radar tile ${url}:`, e)
      return null // not asked again for this frame
    }
  }
}

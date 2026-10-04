// client/scene/wxField.ts
// The weather field: the chase's cloud specs (cloudField.ts CloudSpec) as a map the volumetric weather pass (CloudVolume) reads
// for every ray it marches, and the HUD asks the same map "is the aircraft in cloud?". Pure (no Cesium, no DOM), so Node tests cover it.
// The map is FIELD_KM square, FIELD_N texels a side, centred on the place it was built for, a flat local map (east–west by the
// longitude difference times cos(lat) of that place: accurate to a few metres over 160 km). Texel (i, j) is i texels east of the west
// edge and j north of the south edge, in the array at j × FIELD_N + i; its middle stands (i + ½) texels in.
// There are BANDS bands. Four are layers, by the height of a cloud's base (BAND_TOP_M): so that a low cumulus and a deck over it are two
// clouds in one place, not one muddle. The fifth (TOWER_BAND) is the towers' (a spec with a tower number: a CB's or TCU's, the radar's,
// and their anvils), whatever their bases: a tower is many puffs stacked, which have to be one body. Per band, per texel: the cover
// (0 … 1), the base and the top (metres above sea level) and the severity (0 … 3, cloudField.ts SEV).
// Each spec is a soft disc in its band: whole inside SOLID of its radius, falling smoothly to nothing at the rim. Where discs overlap the
// cover joins as 1 − Π(1 − w) and the severity is the discs' average, by weight; in a layer band the base and top are their averages
// too, in the towers' band the lowest base and the highest top of the discs that reach the texel.
// The GPU filters the four channels of the image (fieldAtlas) on its own, and cannot weight them by cover. So that its plain bilinear
// mix is right at the edge of a cloud, a disc also writes its base, top and severity to every texel within EDGE_TEXELS (a cell's
// diagonal) beyond its rim, with no cover: wherever a mix has some cover, all four texels hold the cloud's heights. In a layer band that
// write weighs EDGE_WEIGHT, so a texel the disc covers is unchanged to within rounding; in the towers' band the lowest and the highest
// simply reach there. sampleField is exactly such a mix, times profile().
// profile() shapes a band's cloud upward: nothing at its base, full from 14 % of the way up, rounded over the top 45 %, but the base
// rises over 300 m at most and the top is rounded over 900 m at most, so that a tall body is full between.
// ponytail: in the towers' band a tower is a prism: at every height its cover is the join of all its puffs' footprints, so it is as wide
// at 3 km as under its anvil and its flank is steeper than one puff's (a 10 km storm falls from 0.8 to nothing in under 2 km). Upgrade:
// the towers' band in a few height slices, or a 3-D image.
import { PUFF_FILL, type CloudSpec } from './cloudField.ts'
import { smoothstep } from './exaggeration.ts'
import { wrapLon } from './wxGeo.ts'

export const FIELD_N = 512 // texels a side
export const FIELD_KM = 320 // the square covered, centred where the field was built
export const BANDS = 5 // the four layer bands, by a cloud's base: under 2,000 m, to 4,500 m, to 8,000 m, above; and the towers' band
export const TOWER_BAND = 4 // every spec with a tower number, whatever its base
export const BAND_TOP_M: readonly number[] = [2000, 4500, 8000] // the first three layer bands' upper edges
export const HEIGHT_MAX_M = 16000 // heights are packed over 0 … this
const TEXEL_KM = FIELD_KM / FIELD_N
const HALF_KM = FIELD_KM / 2
const KM_PER_DEG = 111.195 // of latitude, on a sphere of 6,371 km
const RAD = Math.PI / 180
const RADIUS = 0.36 // a disc's radius, of its spec's billboard width (a puff fills about PUFF_FILL of the billboard)
const SOLID = 0.55 // inside this share of the radius a disc weighs 1
// profile()'s four numbers are written into the weather pass's shader too (cloudVolume.ts), so the two cannot drift.
export const RISE = 0.14 // profile: full from this share of the way up from the base …
export const FALL = 0.55 // … to this, then rounded off to nothing at the top …
export const RISE_MAX_M = 300 // … but the base rises over no more than this …
export const FALL_MAX_M = 900 // … and the top is rounded over no more than this (a thin cloud's own shares are shorter)
const EDGE_TEXELS = Math.SQRT2 // a disc writes its heights this far past its rim: the diagonal of a cell reaches from any corner to any other
const EDGE_WEIGHT = 1e-4 // in a layer band that write weighs this, against 1 inside the disc

/**
 * The map. cov, base, top and sev are one array of FIELD_N² per band, BANDS of them (a texel with no cloud and none near is 0 in all four;
 * one just outside a cloud has its heights and severity, with no cover); lo and hi are each band's lowest base and highest top (lo > hi:
 * the band is empty); empty: no band holds any cloud.
 */
export interface WxField {
  lat: number // its centre, degrees
  lon: number
  cov: Float32Array[]
  base: Float32Array[]
  top: Float32Array[]
  sev: Float32Array[]
  lo: number[]
  hi: number[]
  empty: boolean
}

/** A spec as a disc on the map: its heights and severity, its middle and radius in texels. */
interface Disc {
  base: number
  top: number
  sev: number
  u: number
  v: number
  r: number
}

const clampH = (m: number): number => (m > 0 ? (m < HEIGHT_MAX_M ? m : HEIGHT_MAX_M) : 0)
const kmPerLon = (lat: number): number => KM_PER_DEG * Math.max(0.01, Math.cos(lat * RAD))

/** The map of the specs round lat, lon. Specs that reach nowhere into the square are left out. */
export function buildField(specs: readonly CloudSpec[], lat: number, lon: number): WxField {
  const N = FIELD_N
  const kx = kmPerLon(lat)
  const cells = N * N
  const f: WxField = {
    lat, lon, empty: true,
    cov: Array.from({ length: BANDS }, () => new Float32Array(cells)),
    base: Array.from({ length: BANDS }, () => new Float32Array(cells)),
    top: Array.from({ length: BANDS }, () => new Float32Array(cells)),
    sev: Array.from({ length: BANDS }, () => new Float32Array(cells)),
    lo: Array.from({ length: BANDS }, () => HEIGHT_MAX_M),
    hi: Array.from({ length: BANDS }, () => 0),
  }
  const bands: Disc[][] = Array.from({ length: BANDS }, () => [])
  for (const s of specs) {
    const u = (wrapLon(s.lon - lon) * kx + HALF_KM) / TEXEL_KM - 0.5
    const v = ((s.lat - lat) * KM_PER_DEG + HALF_KM) / TEXEL_KM - 0.5
    const r = Math.max((RADIUS * s.scale[0]) / 1000, TEXEL_KM) / TEXEL_KM
    if (!(u + r > 0 && u - r < N - 1 && v + r > 0 && v - r < N - 1)) continue
    const half = (PUFF_FILL * s.scale[1]) / 2
    const base = clampH(s.heightM - half)
    let band = TOWER_BAND
    if (s.tower === undefined) {
      band = 0
      while (band < BAND_TOP_M.length && base >= BAND_TOP_M[band]) band++
    }
    bands[band].push({ base, top: clampH(s.heightM + half), sev: s.sev ?? 0, u, v, r })
  }
  const weight = new Float32Array(cells) // per band: the discs' weights added up
  for (let b = 0; b < BANDS; b++) {
    if (bands[b].length === 0) continue
    const [cov, base, top, sev] = [f.cov[b], f.base[b], f.top[b], f.sev[b]]
    const tall = b === TOWER_BAND // lowest base, highest top, not averages
    cov.fill(1) // while the discs are laid: Π(1 − w)
    weight.fill(0)
    if (tall) base.fill(HEIGHT_MAX_M)
    for (const d of bands[b]) {
      const solid = SOLID * d.r
      const reach = d.r + EDGE_TEXELS
      let [hit, wrote] = [false, false]
      for (let j = Math.max(0, Math.ceil(d.v - reach)); j <= Math.min(N - 1, Math.floor(d.v + reach)); j++) {
        for (let i = Math.max(0, Math.ceil(d.u - reach)); i <= Math.min(N - 1, Math.floor(d.u + reach)); i++) {
          const dist = Math.sqrt((i - d.u) ** 2 + (j - d.v) ** 2)
          if (dist >= reach) continue
          const o = j * N + i
          let w = EDGE_WEIGHT // past the rim: heights, no cover
          if (dist < d.r) {
            w = dist <= solid ? 1 : 1 - smoothstep((dist - solid) / (d.r - solid))
            cov[o] *= 1 - w
            hit = true
          }
          wrote = true
          weight[o] += w
          sev[o] += w * d.sev
          if (tall) {
            if (d.base < base[o]) base[o] = d.base
            if (d.top > top[o]) top[o] = d.top
          } else {
            base[o] += w * d.base
            top[o] += w * d.top
          }
        }
      }
      if (!wrote) continue
      if (hit) f.empty = false
      f.lo[b] = Math.min(f.lo[b], d.base)
      f.hi[b] = Math.max(f.hi[b], d.top)
    }
    for (let o = 0; o < cells; o++) {
      const w = weight[o]
      if (w > 0) {
        cov[o] = 1 - cov[o]
        sev[o] /= w
        if (!tall) {
          base[o] /= w
          top[o] /= w
        }
      } else cov[o] = base[o] = 0 // (the towers' base was filled with its sentinel)
    }
  }
  return f
}

/**
 * 0 … 1 across a band's cloud at altM: nothing at its base, full from 14 % of the way up to 55 %, rounded to nothing at its top (the
 * mock's prof()); but the rise is over 300 m at most and the rounding over 900 m at most, so a body 9 km tall is full from 300 m over
 * its base to 900 m under its top. The shares are those of a cloud up to about 2 km thick, which no layer's puff is more than.
 */
export function profile(altM: number, base: number, top: number): number {
  if (!(top > base)) return 0
  const rise = Math.min(RISE * (top - base), RISE_MAX_M)
  const fall = Math.min((1 - FALL) * (top - base), FALL_MAX_M)
  return smoothstep((altM - base) / rise) * (1 - smoothstep((altM - (top - fall)) / fall))
}

/** What the field holds at a place and height: how much cloud (0 … 1), and how severe (0 … 3). */
export interface Cover {
  cover: number
  sev: number
}

// coverAt's scratch: the four texels round a place and their weights. Reused, so a call allocates nothing (the HUD asks thousands a frame).
const cell = new Int32Array(4)
const share = new Float64Array(4)
const mix = (a: Float32Array): number => share[0] * a[cell[0]] + share[1] * a[cell[1]] + share[2] * a[cell[2]] + share[3] * a[cell[3]]

/**
 * How much cloud there is at lat, lon, altM (metres above sea level), and how severe: for each band whose heights reach altM, the
 * four texels round the place mixed plainly (cover, base, top and severity each on its own, as a shader's texture() mixes the image),
 * the cover times the profile at altM; the highest wins and brings its band's severity. Nothing for no field, outside its square, or
 * at a height no band reaches. The answer is written into `out` (both numbers, always), which is returned: no allocation.
 */
export function coverAt(f: WxField | null, lat: number, lon: number, altM: number, out: Cover): Cover {
  const N = FIELD_N
  out.cover = 0
  out.sev = 0
  if (f === null || f.empty) return out
  const u = (wrapLon(lon - f.lon) * kmPerLon(f.lat) + HALF_KM) / TEXEL_KM - 0.5
  const v = ((lat - f.lat) * KM_PER_DEG + HALF_KM) / TEXEL_KM - 0.5
  if (!(u >= -0.5 && u <= N - 0.5 && v >= -0.5 && v <= N - 0.5)) return out
  const [x, y] = [Math.min(N - 1, Math.max(0, u)), Math.min(N - 1, Math.max(0, v))] // beyond the outer texels' middles: their value
  const [i, j] = [Math.min(N - 2, Math.floor(x)), Math.min(N - 2, Math.floor(y))]
  const [fx, fy] = [x - i, y - j]
  cell[0] = j * N + i
  cell[1] = j * N + i + 1
  cell[2] = (j + 1) * N + i
  cell[3] = (j + 1) * N + i + 1
  share[0] = (1 - fx) * (1 - fy)
  share[1] = fx * (1 - fy)
  share[2] = (1 - fx) * fy
  share[3] = fx * fy
  for (let b = 0; b < BANDS; b++) {
    if (altM < f.lo[b] || altM > f.hi[b]) continue // (nothing is lost: wherever a band has cover, the mixed base and top lie inside its lo … hi)
    const cover = mix(f.cov[b])
    if (cover <= 0) continue
    const c = cover * profile(altM, mix(f.base[b]), mix(f.top[b]))
    if (c > out.cover) {
      out.cover = c
      out.sev = mix(f.sev[b])
    }
  }
  return out
}

/** coverAt, as an object of its own: for a place or two. A loop over many places gives coverAt one object to write into. */
export function sampleField(f: WxField | null, lat: number, lon: number, altM: number): Cover {
  return coverAt(f, lat, lon, altM, { cover: 0, sev: 0 })
}

/**
 * The field as one image for the GPU: 3 × 2 tiles of FIELD_N², band b at column b % 3 and row ⌊b / 3⌋ (x = (b % 3) × FIELD_N,
 * y = ⌊b / 3⌋ × FIELD_N; the sixth tile is empty), a texel in a tile as in the field (row 0 the south). R the cover, G the base and B the
 * top (each over HEIGHT_MAX_M), A the severity over 3, each 0 … 255. A texel just outside a cloud has no cover and has its heights and
 * severity (see the header). Not premultiplied: upload the bytes as they are, not through a canvas.
 */
export function fieldAtlas(f: WxField): { data: Uint8ClampedArray; width: number; height: number } {
  const [width, height] = [3 * FIELD_N, 2 * FIELD_N]
  const data = new Uint8ClampedArray(width * height * 4)
  for (let b = 0; b < BANDS; b++) {
    if (f.lo[b] > f.hi[b]) continue // an empty band: its tile stays blank (and the work of looking at its 262,144 texels is saved: the field is built while the view runs)
    const [x0, y0] = [(b % 3) * FIELD_N, Math.floor(b / 3) * FIELD_N]
    const [cov, base, top, sev] = [f.cov[b], f.base[b], f.top[b], f.sev[b]]
    for (let j = 0; j < FIELD_N; j++) {
      for (let i = 0; i < FIELD_N; i++) {
        const t = j * FIELD_N + i
        if (!(cov[t] > 0 || top[t] > 0)) continue
        const o = ((y0 + j) * width + x0 + i) * 4
        data[o] = cov[t] * 255
        data[o + 1] = (base[t] / HEIGHT_MAX_M) * 255
        data[o + 2] = (top[t] / HEIGHT_MAX_M) * 255
        data[o + 3] = (sev[t] / 3) * 255
      }
    }
  }
  return { data, width, height }
}

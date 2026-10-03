// client/scene/wxField.ts
// The weather field: the chase's cloud specs (cloudField.ts CloudSpec) as a map the volumetric weather pass (CloudVolume) reads
// for every ray it marches, and the HUD asks the same map "is the aircraft in cloud?". Pure (no Cesium, no DOM), so Node tests cover it.
// The map is FIELD_KM square, FIELD_N texels a side, centred on the place it was built for, a flat local map (east–west by the
// longitude difference times cos(lat) of that place: accurate to a few metres over 160 km). Texel (i, j) is i texels east of the west
// edge and j north of the south edge, in the array at j × FIELD_N + i; its middle stands (i + ½) texels in. A cloud is told apart by
// the height of its base into BANDS bands, so that a low cumulus and a deck over it are two clouds in one place, not one muddle:
// per band, per texel, the cover (0 … 1), the base and the top (metres above sea level) and the severity (0 … 3, cloudField.ts SEV).
// Each spec is a soft disc in its band: whole inside SOLID of its radius, falling smoothly to nothing at the rim. Where discs overlap
// the cover joins as 1 − Π(1 − w), and the base, top and severity are the discs' averages, by weight.
// profile() shapes a band's cloud upward: nothing at its base, full from 14 % of the way up, rounded over the top 45 %.
// ponytail: a texel's base and top are its discs' averages and each band is shaped on its own, so the puffs of a tower in one band pull
// each other's heights together (an anvil lifts the base under it) and a tower that crosses from one band into the next dips where they
// meet: over the axis of a 45 dBZ radar tower (within 3 km of it) there is no cover at all from 5.0 to 6.0 km, and a 0.10 at 6 km over a
// 55 dBZ one. Upgrade: the lowest base and highest top of the discs that weigh 0.25 or more, and one profile for bands whose heights overlap.
import { PUFF_FILL, type CloudSpec } from './cloudField.ts'
import { smoothstep } from './exaggeration.ts'
import { wrapLon } from './wxGeo.ts'

export const FIELD_N = 512 // texels a side
export const FIELD_KM = 320 // the square covered, centred where the field was built
export const BANDS = 4 // by a cloud's base: under 2,000 m, to 4,500 m, to 8,000 m, above
export const BAND_TOP_M: readonly number[] = [2000, 4500, 8000] // the first three bands' upper edges
export const HEIGHT_MAX_M = 16000 // heights are packed over 0 … this
const TEXEL_KM = FIELD_KM / FIELD_N
const HALF_KM = FIELD_KM / 2
const KM_PER_DEG = 111.195 // of latitude, on a sphere of 6,371 km
const RAD = Math.PI / 180
const RADIUS = 0.36 // a disc's radius, of its spec's billboard width (a puff fills about PUFF_FILL of the billboard)
const SOLID = 0.55 // inside this share of the radius a disc weighs 1
const RISE = 0.14 // profile: full from this share of the way up from the base …
const FALL = 0.55 // … to this, then rounded off to nothing at the top

/**
 * The map. cov, base, top and sev are one array of FIELD_N² per band (cloud-free texels are 0 in all four); lo and hi are each band's
 * lowest base and highest top (lo > hi: the band is empty); empty: no band holds any cloud.
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

/** A spec as a disc on the map: its band, heights and severity, its middle and radius in texels. */
interface Disc {
  band: number
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
    let band = 0
    while (band < BANDS - 1 && base >= BAND_TOP_M[band]) band++
    bands[band].push({ band, base, top: clampH(s.heightM + half), sev: s.sev ?? 0, u, v, r })
  }
  const weight = new Float32Array(cells) // per band: the discs' weights added up
  for (let b = 0; b < BANDS; b++) {
    if (bands[b].length === 0) continue
    const [cov, base, top, sev] = [f.cov[b], f.base[b], f.top[b], f.sev[b]]
    cov.fill(1) // while the discs are laid: Π(1 − w)
    weight.fill(0)
    for (const d of bands[b]) {
      const solid = SOLID * d.r
      let hit = false
      for (let j = Math.max(0, Math.ceil(d.v - d.r)); j <= Math.min(N - 1, Math.floor(d.v + d.r)); j++) {
        for (let i = Math.max(0, Math.ceil(d.u - d.r)); i <= Math.min(N - 1, Math.floor(d.u + d.r)); i++) {
          const dist = Math.sqrt((i - d.u) ** 2 + (j - d.v) ** 2)
          if (dist >= d.r) continue
          const w = dist <= solid ? 1 : 1 - smoothstep((dist - solid) / (d.r - solid))
          const o = j * N + i
          cov[o] *= 1 - w
          weight[o] += w
          base[o] += w * d.base
          top[o] += w * d.top
          sev[o] += w * d.sev
          hit = true
        }
      }
      if (!hit) continue
      f.empty = false
      f.lo[b] = Math.min(f.lo[b], d.base)
      f.hi[b] = Math.max(f.hi[b], d.top)
    }
    for (let o = 0; o < cells; o++) {
      const w = weight[o]
      if (w > 0) {
        cov[o] = 1 - cov[o]
        base[o] /= w
        top[o] /= w
        sev[o] /= w
      } else cov[o] = 0
    }
  }
  return f
}

/** 0 … 1 across a band's cloud at altM: nothing at its base, full from 14 % of the way up to 55 %, rounded to nothing at its top (the mock's prof()). */
export function profile(altM: number, base: number, top: number): number {
  if (!(top > base)) return 0
  const h = (altM - base) / (top - base)
  return smoothstep(h / RISE) * (1 - smoothstep((h - FALL) / (1 - FALL)))
}

/**
 * How much cloud there is at lat, lon, altM (metres above sea level), and how severe: for each band whose heights reach altM, the
 * texels round the place joined bilinearly (the cover as it is; the base, top and severity weighted by the cover, so the edge of a
 * cloud keeps its own heights and does not take the empty texels' 0), the cover times the profile at altM; the highest cover wins and
 * brings its band's severity. Nothing for no field, outside its square, or at a height no band reaches.
 */
export function sampleField(f: WxField | null, lat: number, lon: number, altM: number): { cover: number; sev: number } {
  const N = FIELD_N
  if (f === null || f.empty) return { cover: 0, sev: 0 }
  const u = (wrapLon(lon - f.lon) * kmPerLon(f.lat) + HALF_KM) / TEXEL_KM - 0.5
  const v = ((lat - f.lat) * KM_PER_DEG + HALF_KM) / TEXEL_KM - 0.5
  if (!(u >= -0.5 && u <= N - 0.5 && v >= -0.5 && v <= N - 0.5)) return { cover: 0, sev: 0 }
  const [x, y] = [Math.min(N - 1, Math.max(0, u)), Math.min(N - 1, Math.max(0, v))] // beyond the outer texels' middles: their value
  const [i, j] = [Math.min(N - 2, Math.floor(x)), Math.min(N - 2, Math.floor(y))]
  const [fx, fy] = [x - i, y - j]
  const at = [j * N + i, j * N + i + 1, (j + 1) * N + i, (j + 1) * N + i + 1]
  const w = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy]
  let best = { cover: 0, sev: 0 }
  for (let b = 0; b < BANDS; b++) {
    if (altM < f.lo[b] || altM > f.hi[b]) continue
    let [cover, base, top, sev] = [0, 0, 0, 0]
    for (let n = 0; n < 4; n++) {
      const c = w[n] * f.cov[b][at[n]]
      cover += c
      base += c * f.base[b][at[n]]
      top += c * f.top[b][at[n]]
      sev += c * f.sev[b][at[n]]
    }
    if (cover <= 0) continue
    const c = cover * profile(altM, base / cover, top / cover)
    if (c > best.cover) best = { cover: c, sev: sev / cover }
  }
  return best
}

/**
 * The field as one image for the GPU: 2 × 2 tiles of FIELD_N², band b at column b % 2 and row ⌊b / 2⌋ (x = (b % 2) × FIELD_N,
 * y = ⌊b / 2⌋ × FIELD_N), a texel in a tile as in the field (row 0 the south). R the cover, G the base and B the top (each over
 * HEIGHT_MAX_M), A the severity over 3, each 0 … 255. Not premultiplied: upload the bytes as they are, not through a canvas.
 */
export function fieldAtlas(f: WxField): { data: Uint8ClampedArray; width: number; height: number } {
  const size = 2 * FIELD_N
  const data = new Uint8ClampedArray(size * size * 4)
  for (let b = 0; b < BANDS; b++) {
    const [x0, y0] = [(b % 2) * FIELD_N, Math.floor(b / 2) * FIELD_N]
    const [cov, base, top, sev] = [f.cov[b], f.base[b], f.top[b], f.sev[b]]
    for (let j = 0; j < FIELD_N; j++) {
      for (let i = 0; i < FIELD_N; i++) {
        const c = cov[j * FIELD_N + i]
        if (!(c > 0)) continue
        const t = j * FIELD_N + i
        const o = ((y0 + j) * size + x0 + i) * 4
        data[o] = c * 255
        data[o + 1] = (base[t] / HEIGHT_MAX_M) * 255
        data[o + 2] = (top[t] / HEIGHT_MAX_M) * 255
        data[o + 3] = (sev[t] / 3) * 255
      }
    }
  }
  return { data, width: size, height: size }
}

// client/scene/cloudField.ts
// The clouds the chase draws round the aircraft (Weather3D), as specs: where each one stands, how big it is, its shape and
// its shade. Pure (no Cesium, no DOM), so Node tests cover it; cloudLayer.ts draws the specs with one Cesium CloudCollection.
// From the airports' reports (METARs): each cloud layer becomes clouds at its reported base, in a disc of 25 km round the
// station, by its cover: FEW about 0.02 clouds a km², SCT 0.06, BKN 0.14 (wider, flatter), OVC 0.25 (flat, wide, overlapping
// into a deck). A layer of thunderclouds (CB) or towering cumulus (TCU) also stands towers up from its base. A report with no
// layer (CAVOK, clear, none detected, no significant cloud, a sky hidden by fog) draws none.
// What a report does not say is estimated, each estimate a named number below (LOOKS, TOWERS): how thick a layer's clouds
// are, how wide, their shape and shade, and where in the disc each one stands. The places are drawn from a random sequence
// seeded by the station and the layer, so the same report draws the same sky: a refresh reshuffles nothing.
// A station draws its clouds only where no other station that reports the sky is nearer (its disc cut to its own side), so
// a clear report keeps its side clear. Caps: 120 clouds a station (a layer thinned to its share is drawn with wider clouds,
// so it covers as much) and 700 in all, the nearest first, none beyond 150 km. Clouds from other sources (the radar's, a
// model's) join after the observed ones: nearestClouds takes its groups in order.
// ponytail: where stations are dense and the sky overcast, the 700 nearest end 40 to 60 km off. Upgrade: fewer, wider
// clouds the farther a station is, so the cap reaches 150 km.
import { distanceNm } from '../../shared/geo.ts'
import type { Cloud, Metar } from '../../shared/wx.ts'
import { wrapLon } from './wxGeo.ts'

const FT = 0.3048
const KM_PER_DEG = 111.195 // of latitude, on a sphere of 6,371 km
const RAD = Math.PI / 180
export const DISC_KM = 25 // a station's clouds stand within this of it
const DISC_KM2 = Math.PI * DISC_KM ** 2
export const STATION_CAP = 120 // clouds a station, its towers first
export const MAX_CLOUDS = 700 // drawn at once
export const CLOUD_KM = 150 // none drawn farther from the aircraft
export const NIGHT_BRIGHTNESS = 0.15 // a cloud's brightness at full night, of its brightness by day

/**
 * One cloud as cloudLayer.ts draws it: a Cesium cumulus cloud, a billboard that always faces the camera. Its puff fills
 * nearly all of the billboard, so the cloud stands from heightM − scale[1]/2 (its base) to heightM + scale[1]/2.
 */
export interface CloudSpec {
  lon: number // degrees
  lat: number
  heightM: number // its middle, metres above sea level
  groundM: number // the ground it stands over (its station's height), metres above sea level: a flattened relief moves it with that ground
  scale: [number, number] // its width and height, metres
  maxSize: [number, number, number] // its puff's shape: Cesium's maximumSize, an ellipsoid in the units of Cesium's cloud noise (not metres: 5–50 look right)
  slice: number // Cesium's slice: how deep into that ellipsoid the billboard cuts (0.3–0.6: a full, soft puff)
  brightness: number // 0–1, before the sun (cloudLayer.ts scales it by sunBrightness)
  tint: number // 0 white … 1 dark grey
}

type Range = readonly [number, number]
type Cover = 'FEW' | 'SCT' | 'BKN' | 'OVC'
interface Look {
  perKm2: number // clouds a km² (the plan's)
  w: Range // width, m (estimate)
  h: Range // height, m (estimate)
  shape: readonly [Range, Range, Range] // maxSize
  slice: Range
  brightness: number
  tint: number
}

/** Each cover's clouds: cumulus for FEW and SCT; wider, flatter, greyer stratocumulus for BKN; a flat grey deck for OVC. */
export const LOOKS: Readonly<Record<Cover, Look>> = {
  FEW: { perKm2: 0.02, w: [1000, 3000], h: [400, 1200], shape: [[18, 28], [10, 14], [10, 16]], slice: [0.35, 0.5], brightness: 1, tint: 0 },
  SCT: { perKm2: 0.06, w: [1000, 3000], h: [400, 1200], shape: [[18, 28], [10, 14], [10, 16]], slice: [0.35, 0.5], brightness: 1, tint: 0 },
  BKN: { perKm2: 0.14, w: [2000, 4000], h: [300, 700], shape: [[28, 40], [9, 12], [8, 12]], slice: [0.4, 0.55], brightness: 0.92, tint: 0.1 },
  OVC: { perKm2: 0.25, w: [3000, 6000], h: [250, 500], shape: [[36, 50], [8, 11], [6, 10]], slice: [0.45, 0.6], brightness: 0.85, tint: 0.25 },
}
const SHADE = 0.75 // a layer's brightness under each broken or overcast layer above it (estimate)

interface TowerLook {
  count: readonly [number, number] // towers a layer (the plan's)
  h: Range // from the layer's base, m (the plan's)
  w: Range // m (estimate)
  tint: number // its lowest puff's; lighter up to its top
  anvil: boolean // a wide, flat top
}

/** The towers a CB or TCU layer stands up: puffs one over the next, dark at the base. */
export const TOWERS: Readonly<Record<'CB' | 'TCU', TowerLook>> = {
  CB: { count: [2, 4], h: [4000, 9000], w: [3000, 5000], tint: 0.7, anvil: true },
  TCU: { count: [3, 6], h: [2000, 4000], w: [1500, 3000], tint: 0.25, anvil: false },
}
const TOWER_DISC = 0.8 // towers stand within this share of the disc's radius
const PUFF_ASPECT = 0.8 // a tower's puff is about this tall for its width
const PUFF_OVERLAP = 1.3 // and this much taller than its share of the tower, so the puffs overlap into one cloud
const PUFF_SHAPE: readonly [Range, Range, Range] = [[15, 20], [13, 17], [14, 18]]
const PUFF_SLICE: Range = [0.5, 0.6]
const ANVIL_W = 2.5 // an anvil this many times its tower's width
const ANVIL_H = 700 // m
const ANVIL_SHAPE: readonly [Range, Range, Range] = [[44, 52], [8, 10], [8, 10]]
const ANVIL_SLICE = 0.4

const CLEAR_COVERS = new Set(['CLR', 'SKC', 'NSC', 'NCD', 'CAVOK'])
const HIDDEN_COVERS = new Set(['VV', 'OVX']) // the sky hidden (fog): no cloud layer, but the sky reported
const CLEAR_WORDS = /\b(?:CAVOK|CLR|SKC|NSC|NCD)\b/

const isCover = (c: string): c is Cover => Object.hasOwn(LOOKS, c)

/** Whether a report says what the sky is: a cloud layer, a hidden sky, or a clear-sky word. */
export function reportsSky(m: Metar): boolean {
  return m.clouds.some((c) => isCover(c.cover) || HIDDEN_COVERS.has(c.cover) || CLEAR_COVERS.has(c.cover)) || CLEAR_WORDS.test(m.raw)
}

/** A 32-bit FNV-1a hash: a layer's seed from its station and its words. */
function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h >>> 0
}

/** mulberry32: a sequence in [0, 1), the same for the same seed. */
function sequence(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), a | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const between = (r: () => number, [lo, hi]: Range): number => lo + (hi - lo) * r()
const shapeOf = (r: () => number, [x, y, z]: readonly [Range, Range, Range]): [number, number, number] => [between(r, x), between(r, y), between(r, z)]

/** A place drawn evenly from the disc of rKm round lat, lon: [lon, lat]. */
function inDisc(r: () => number, lat: number, lon: number, rKm: number): [number, number] {
  const d = rKm * Math.sqrt(r())
  const a = 2 * Math.PI * r()
  return [wrapLon(lon + (d * Math.sin(a)) / (KM_PER_DEG * Math.max(0.01, Math.cos(lat * RAD)))), lat + (d * Math.cos(a)) / KM_PER_DEG]
}

/** n shared out in proportion to wanted, in whole numbers (the rest by the largest remainders); wanted itself when it fits. */
function shares(wanted: number[], n: number): number[] {
  const total = wanted.reduce((a, b) => a + b, 0)
  if (total <= n) return wanted
  const exact = wanted.map((w) => (w * n) / total)
  const out = exact.map(Math.floor)
  let left = n - out.reduce((a, b) => a + b, 0)
  for (const i of exact.map((_, i) => i).sort((a, b) => exact[b] - out[b] - (exact[a] - out[a]))) {
    if (left-- <= 0) break
    out[i]++
  }
  return out
}

type Layer = Cloud & { cover: Cover; baseFt: number }

/**
 * The clouds of one report: its towers (never thinned), then each layer's clouds by its cover, thinned to its share of
 * what is left of cap (each kept cloud made √(wanted / kept) times wider: the layer covers as much). The kept clouds are
 * the first of the layer's sequence, so thinning keeps their places. seed reshuffles the whole sky.
 */
export function metarClouds(m: Metar, seed = 0, cap = STATION_CAP): CloudSpec[] {
  const ground = m.elevM
  if (ground === null) return [] // its bases are feet above a height not known
  const layers = m.clouds.filter((c): c is Layer => isCover(c.cover) && c.baseFt !== null)
  const out: CloudSpec[] = []
  for (const c of layers) if (c.type !== null) towers(out, m, ground, c, sequence(hash(`${m.id}|${c.cover}${c.baseFt}|${c.type}|towers|${seed}`)))
  const wanted = layers.map((c) => Math.round(LOOKS[c.cover].perKm2 * DISC_KM2))
  const kept = shares(wanted, Math.max(0, cap - out.length))
  layers.forEach((c, i) => {
    if (kept[i] === 0) return
    const look = LOOKS[c.cover]
    const above = layers.filter((o) => o.baseFt > c.baseFt && (o.cover === 'BKN' || o.cover === 'OVC')).length
    const r = sequence(hash(`${m.id}|${c.cover}${c.baseFt}|${c.type ?? ''}|${seed}`))
    const grow = Math.sqrt(wanted[i] / kept[i])
    const base = ground + c.baseFt * FT
    for (let k = 0; k < kept[i]; k++) {
      const [lon, lat] = inDisc(r, m.lat, m.lon, DISC_KM)
      const w = between(r, look.w) * grow
      const h = between(r, look.h)
      out.push({
        lon, lat, heightM: base + h / 2, groundM: ground, scale: [w, h], maxSize: shapeOf(r, look.shape), slice: between(r, look.slice),
        brightness: look.brightness * SHADE ** above, tint: look.tint,
      })
    }
  })
  return out
}

/** A CB or TCU layer's towers: each a stack of overlapping puffs from the base to its top (a CB's crowned by an anvil), darkest at the bottom. */
function towers(out: CloudSpec[], m: Metar, ground: number, c: Layer, r: () => number): void {
  const look = TOWERS[c.type!]
  const base = ground + c.baseFt * FT
  const n = look.count[0] + Math.floor(r() * (look.count[1] - look.count[0] + 1))
  for (let t = 0; t < n; t++) {
    const [lon, lat] = inDisc(r, m.lat, m.lon, DISC_KM * TOWER_DISC)
    const H = between(r, look.h)
    const W = between(r, look.w)
    const puffs = Math.max(2, Math.round(H / (W * PUFF_ASPECT)))
    const hp = (PUFF_OVERLAP * H) / puffs
    for (let i = 0; i < puffs; i++) {
      out.push({
        lon, lat, heightM: base + hp / 2 + (i * (H - hp)) / (puffs - 1), groundM: ground, scale: [W, hp], maxSize: shapeOf(r, PUFF_SHAPE),
        slice: between(r, PUFF_SLICE), brightness: 1, tint: look.tint * (1 - i / puffs),
      })
    }
    if (look.anvil) {
      out.push({
        lon, lat, heightM: base + H - ANVIL_H / 2, groundM: ground, scale: [W * ANVIL_W, ANVIL_H], maxSize: shapeOf(r, ANVIL_SHAPE),
        slice: ANVIL_SLICE, brightness: 1, tint: 0,
      })
    }
  }
}

/** Squared km between two places, on the plane round them (fine within a few hundred km). */
function km2(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const y = (a.lat - b.lat) * KM_PER_DEG
  const x = wrapLon(a.lon - b.lon) * KM_PER_DEG * Math.cos(((a.lat + b.lat) / 2) * RAD)
  return x * x + y * y
}

// A report's clouds, kept for the report object: read-only data from the server (a new report is a new object), so the
// rebuilds as the aircraft flies on work out only the stations they have not seen.
const made = new WeakMap<Metar, CloudSpec[]>()
const cloudsOf = (m: Metar, seed: number): CloudSpec[] => {
  if (seed !== 0) return metarClouds(m, seed)
  let cs = made.get(m)
  if (cs === undefined) made.set(m, (cs = metarClouds(m)))
  return cs
}

/**
 * The observed clouds round lat, lon: those of each station whose disc comes within reachKm, each kept only where no other
 * station that reports the sky is nearer to it; and how many of those stations report the sky (the sky is built from them).
 * The stations are taken nearest first, and none is worked out once max clouds nearer than any it could add are in hand:
 * the nearest max of the result are the nearest max of the whole sky.
 */
export function observedClouds(metars: readonly Metar[], lat: number, lon: number, max = MAX_CLOUDS, reachKm = CLOUD_KM, seed = 0): { specs: CloudSpec[]; stations: number } {
  const claims = metars.filter(reportsSky)
  const near = claims
    .map((m) => ({ m, km: distanceNm(lat, lon, m.lat, m.lon) * 1.852 }))
    .filter((s) => s.km <= reachKm + DISC_KM)
    .sort((a, b) => a.km - b.km)
  const specs: CloudSpec[] = []
  const dist: number[] = [] // km² from lat, lon of each spec kept
  const rx: number[] = []
  const ry: number[] = []
  const rr: number[] = []
  for (const { m, km } of near) {
    // Its clouds are at least km − 25 away (less 1 km: the plane's distances against the sphere's).
    const bound = Math.max(0, km - DISC_KM - 1) ** 2
    let nearer = 0
    for (const d of dist) if (d <= bound) nearer++
    if (nearer >= max) break
    const own = cloudsOf(m, seed)
    if (own.length === 0) continue
    // On the plane round m (km): its rivals, and its place from lat, lon. A cloud at p is nearer m than rival r when 2 p·r ≤ r·r.
    const kx = KM_PER_DEG * Math.cos(m.lat * RAD)
    rx.length = ry.length = rr.length = 0
    for (const o of claims) {
      if (o === m) continue
      const x = wrapLon(o.lon - m.lon) * kx
      const y = (o.lat - m.lat) * KM_PER_DEG
      if (x * x + y * y >= (2 * DISC_KM) ** 2) continue
      rx.push(x)
      ry.push(y)
      rr.push(x * x + y * y)
    }
    const sx = wrapLon(m.lon - lon) * KM_PER_DEG * Math.cos(((m.lat + lat) / 2) * RAD)
    const sy = (m.lat - lat) * KM_PER_DEG
    for (const c of own) {
      const x = wrapLon(c.lon - m.lon) * kx
      const y = (c.lat - m.lat) * KM_PER_DEG
      let mine = true
      for (let k = 0; k < rr.length && mine; k++) mine = 2 * (x * rx[k] + y * ry[k]) <= rr[k]
      if (!mine) continue
      specs.push(c)
      dist.push((sx + x) ** 2 + (sy + y) ** 2)
    }
  }
  return { specs, stations: near.length }
}

/** At most max clouds within maxKm of lat, lon: the groups in order (observed first), each nearest first. */
export function nearestClouds(groups: readonly (readonly CloudSpec[])[], lat: number, lon: number, max = MAX_CLOUDS, maxKm = CLOUD_KM): CloudSpec[] {
  const out: CloudSpec[] = []
  const at = { lat, lon }
  for (const g of groups) {
    if (out.length >= max) break
    const near = g.map((c) => ({ c, d: km2(c, at) })).filter((x) => x.d <= maxKm ** 2).sort((a, b) => a.d - b.d)
    for (const { c } of near.slice(0, max - out.length)) out.push(c)
  }
  return out
}

/** A cloud's brightness for the Sun's night (0 day … 1 night): full by day, about half at dusk, 0.15 at night. */
export function sunBrightness(night: number): number {
  const n = Number.isFinite(night) ? Math.min(1, Math.max(0, night)) : 0
  return 1 - (1 - NIGHT_BRIGHTNESS) * n
}

// client/scene/cloudField.ts
// The clouds the chase draws round the aircraft (Weather3D), as specs: where each one stands, how big it is, its shape and
// its shade. Pure (no Cesium, no DOM), so Node tests cover it; cloudLayer.ts draws the specs with one Cesium CloudCollection.
// From the airports' reports (METARs): each cloud layer becomes clouds at its reported base, in a disc of 25 km round the
// station, by its cover: FEW about 0.02 clouds a km², SCT 0.06, BKN 0.14, OVC 0.25. BKN and OVC puffs are wider and taller
// than cumulus, so a broken layer hides well over half the sky and an overcast nearly all of it, seen from under it, and
// their tops are lumpy seen from above; each puff a little brighter or greyer than the next. A layer of thunderclouds (CB)
// or towering cumulus (TCU) also stands towers up from its base: columns of puffs several km wide, dark at the base and
// white above, a CB's crowned by a wide, flat anvil. A report with no layer (CAVOK, clear, none detected, no significant
// cloud, a sky hidden by fog) draws none.
// What a report does not say is estimated, each estimate a named number below (LOOKS, TOWERS and the tower constants):
// how thick a layer's clouds are, how wide, their shape and shade, and where in the disc each one stands. The places are
// drawn from a random sequence seeded by the station and the layer, so the same report draws the same sky: a refresh
// reshuffles nothing.
// A station draws its clouds only where no other station that reports the sky is nearer (its disc cut to its own side), so
// a clear report keeps its side clear. Caps: 120 clouds a station (a layer thinned to its share is drawn with larger
// clouds, so it covers as much) and 700 in all, the nearest first, none beyond 150 km. A cloud fades out where it looks
// small (fadeAlpha): small cumulus by 60 to 80 km, decks and towers out to 150 km. Clouds from other sources (the radar's,
// a model's) join after the observed ones: nearestClouds takes its groups in order (Weather3D keeps RADAR_LOOK.reserve of the 700
// for the radar's).
// From the radar (radarClouds): each block of the newest radar frame (radarCells.ts) with 30 dBZ or more of rain is a tower, the
// same columns of puffs as a CB's (tower below), as tall as the echo says and darker the heavier; each block of 15 to 30 dBZ (or of
// snow) a flat grey puff of a deck, at the base. The base is the ceiling of the nearest station that reports one within 60 km, else
// 1,200 m over the ground (the nearest station's height if it is within 60 km, else sea level); both, and the tops by intensity, are
// estimates (RADAR_LOOK): the radar says where it rains and how hard, no more. Heavy rain is often one region of hundreds of blocks,
// so the towers (at most 40) and the deck puffs (at most 80) stand farther apart and wider until they fit, by steps. They fade out by
// 100 km. The cells are read REBUILD_KM farther, a ring that stands at alpha 0 and fades in as the aircraft comes, so none pops in
// at the next build (as for the observed clouds, nearestClouds); the ring is thinned on top of the 40 and the 80 and takes no place
// from them.
// From a weather model's forecast (modelClouds; Open-Meteo's grid of places 0.25° apart, shared/wx.ts ModelGrid), for the sky no report
// or radar says anything of: at each place and pressure level where the model has 20 % cloud or more, puffs over the place's cell,
// standing from the level's height (taken as the layer's base: an estimate). A level's density follows its cover: sparse up to 40 %
// (a share of the observed density for each kind of level), rising to nearly the observed look by 80 %; its puffs grow with the
// cover too (none at 40 %, MODEL_LOOK.grow times as large from 80 %) and are that squared fewer, so a fuller deck covers as much with
// larger puffs. Low
// levels (1000 to 850 hPa) look like the observed layers, mid levels (700 to 400) are flat altocumulus, high levels (300 to 200)
// thin, flat, pale cirrus. Observations win: no low level within 40 km of a station that reports the sky, cloudy or clear. The
// grid's outer ring keeps a quarter of its puffs and the next three fifths, so the sky thins out at its edge instead of ending as a
// wall. 49 places and ten levels want far more than the cap, so the puffs are thinned to MODEL_LOOK.max, evenly in the sky they
// cover (a deck of large puffs keeps more than a few small cumulus): each place and level keeps the first puffs of its own sequence,
// the same size they always are, so the next grid draws a place as it drew it (a puff's number changes a little with the thinning,
// never its size or its spot). The model's clouds are the last group nearestClouds takes: they fill what the observed and the
// radar's leave of the 700. Every puff carries clearKm, so that none is drawn round the aircraft that is at its height.
// A puff must end inside its billboard: the shader draws the ellipsoid it ray-casts, sliced, and where that ends in the quad (its
// cut, or the quad's edge) the alpha is whatever the geometry says, a hard straight edge for a low slice on a narrow puff (a tower's
// or an anvil's). cloudQuad.ts knows where it ends; the slices drawn from the looks are raised just far enough that no puff of any
// source can draw more than 3 % there (LOOKS, TOWER_SLICE, ANVIL_SLICE and RADAR_LOOK.deck.slice are the slices asked for).
// ponytail: the base under an echo comes from the nearest station (a mountain valley's reports say nothing of the ridge), the
// ground under it from the nearest station's height within 60 km, and a tower's top from its dBZ alone. Upgrade: the globe's
// terrain height for the ground; a source of echo tops.
// ponytail: where stations are dense and the sky overcast, the 700 nearest end 40 to 60 km off. Upgrade: fewer, larger
// clouds the farther a station is, so the cap reaches 150 km.
import { distanceNm } from '../../shared/geo.ts'
import type { Cloud, Metar, ModelGrid } from '../../shared/wx.ts'
import { softSlice } from './cloudQuad.ts'
import { smoothstep } from './exaggeration.ts'
import { FIRST_DBZ } from './radar.ts'
import { thin, type RadarCell } from './radarCells.ts'
import { wrapLon } from './wxGeo.ts'

const FT = 0.3048
const KM_PER_DEG = 111.195 // of latitude, on a sphere of 6,371 km
const RAD = Math.PI / 180
export const DISC_KM = 25 // a station's clouds stand within this of it
const DISC_KM2 = Math.PI * DISC_KM ** 2
export const STATION_CAP = 120 // clouds a station, its towers first
export const MAX_CLOUDS = 700 // drawn at once
export const CLOUD_KM = 150 // none drawn farther from the aircraft
export const REBUILD_KM = 30 // Weather3D builds the clouds again once the aircraft has moved this far
export const NIGHT_BRIGHTNESS = 0.15 // a cloud's brightness at full night, of its brightness by day
export const PUFF_FILL = 0.75 // a puff fills about this share of its billboard's height (Cesium's ellipsoid, sliced and frayed): an estimate
export const PUFF_SEEN = 0.45 // what shows of it, solid, is about this much (renders of the shader: the middle of the puff): where a shaft hangs from
export const FADE_ANGLE = 0.03 // radians: a cloud has faded out where it looks this small, its larger side over its distance (1.7°)
const FADE_BAND = 0.3 // over the last share of that distance

/**
 * One cloud as cloudLayer.ts draws it: a Cesium cumulus cloud, a billboard that always faces the camera. Its puff fills
 * PUFF_FILL of the billboard's height, so the cloud stands from heightM − PUFF_FILL·scale[1]/2 (its base) to as far above.
 */
export interface CloudSpec {
  lon: number // degrees
  lat: number
  heightM: number // its middle, metres above sea level
  groundM: number // the ground it stands over (its station's height), metres above sea level: a flattened relief moves it with that ground
  scale: [number, number] // its billboard's width and height, metres
  maxSize: [number, number, number] // its puff's shape: Cesium's maximumSize, an ellipsoid in the units of Cesium's cloud noise (not metres: 5–50 look right)
  slice: number // Cesium's slice: how deep into that ellipsoid the billboard cuts (lower: a fuller, denser puff)
  brightness: number // 0–1, before the sun (cloudLayer.ts scales it by sunBrightness)
  tint: number // 0 white … 1 dark grey
  farKm: number // where it has faded out, km from the aircraft (fadeAlpha)
  tower?: number // the tower it belongs to, numbered within its station; none: a layer's cloud
  clearKm?: number // while the aircraft is at the height this puff spans and within this far of it, cloudLayer.ts hides it (the camera must not sit inside a billboard); it comes back over as far again
}

type Range = readonly [number, number]
type Cover = 'FEW' | 'SCT' | 'BKN' | 'OVC'
interface Look {
  perKm2: number // clouds a km² (the plan's)
  w: Range // width, m (estimate)
  h: Range // height, m (estimate)
  shape: readonly [Range, Range, Range] // maxSize
  slice: Range
  brightness: Range // each puff's, drawn from this
  tint: Range // each puff's grey, drawn from this
}

/**
 * Each cover's clouds: cumulus for FEW and SCT; for BKN and OVC wider, taller and fuller puffs (low slices), each a
 * little greyer or brighter than the next, and darker the denser the deck (not blown out from above). The slices are those asked
 * for: a puff that would end in a hard edge has its slice raised (shapeAndSlice).
 */
export const LOOKS: Readonly<Record<Cover, Look>> = {
  FEW: { perKm2: 0.02, w: [1000, 3000], h: [400, 1200], shape: [[18, 28], [10, 14], [10, 16]], slice: [0.32, 0.45], brightness: [0.9, 1], tint: [0, 0.05] },
  SCT: { perKm2: 0.06, w: [1000, 3000], h: [400, 1200], shape: [[18, 28], [10, 14], [10, 16]], slice: [0.32, 0.45], brightness: [0.9, 1], tint: [0, 0.05] },
  BKN: { perKm2: 0.14, w: [3500, 6000], h: [1000, 1800], shape: [[22, 32], [13, 18], [10, 15]], slice: [0.25, 0.36], brightness: [0.78, 0.95], tint: [0.04, 0.16] },
  OVC: { perKm2: 0.25, w: [5500, 9000], h: [1000, 1700], shape: [[24, 36], [13, 18], [10, 14]], slice: [0.24, 0.34], brightness: [0.72, 0.88], tint: [0.1, 0.24] },
}
const SHADE = 0.75 // a layer's brightness under each broken or overcast layer above it (estimate)

interface TowerLook {
  count: readonly [number, number] // towers a layer (the plan's)
  h: Range // from the layer's base to its top, m (the plan's)
  w: Range // the column's width, m: its base puffs spread over about this (estimate)
  baseTint: number // its lowest puffs' grey; white from half its height up
  anvil: Range | null // a CB's anvil: its width, times the column's (estimate)
}

/** The towers a CB or TCU layer stands up. */
export const TOWERS: Readonly<Record<'CB' | 'TCU', TowerLook>> = {
  CB: { count: [2, 4], h: [4000, 9000], w: [4500, 8000], baseTint: 0.65, anvil: [2.5, 3.5] },
  TCU: { count: [3, 6], h: [2000, 4000], w: [2500, 5000], baseTint: 0.3, anvil: null },
}
const TOWER_DISC = 0.8 // towers stand within this share of the disc's radius
const LEVEL_ASPECT = 0.8 // a tower's levels are about this tall for its width
const LEVEL_PUFFS = 3 // puffs side by side at its base, down to one at its top
const PUFF_W = 0.75 // a tower puff's width, of its column's, narrowing a fifth up the tower
const PUFF_RING = 0.3 // a level's puffs stand round the axis this share of the column's width from it
const PUFF_STACK = 1.4 // each level's puffs are this much taller than the level, so the levels merge
/** The levels of a tower H tall and W wide: at least two. */
const levelsOf = (H: number, W: number): number => Math.max(2, Math.round(H / (W * LEVEL_ASPECT)))
const TOWER_SHAPE: readonly [Range, Range, Range] = [[14, 20], [14, 19], [14, 18]]
const TOWER_SLICE: Range = [0.18, 0.26] // low slices: dense, opaque puffs (as asked: raised where they would end in a hard edge, shapeAndSlice)
const TOWER_BRIGHTNESS: Range = [0.95, 1]
const ANVIL_H: Range = [800, 1100] // m
const ANVIL_PUFFS = 3 // side by side along the way it spreads
const ANVIL_SHAPE: readonly [Range, Range, Range] = [[40, 52], [8, 11], [8, 10]]
const ANVIL_SLICE: Range = [0.26, 0.32]

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
export function sequence(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), a | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const between = (r: () => number, [lo, hi]: Range): number => lo + (hi - lo) * r()
const shapeOf = (r: () => number, [x, y, z]: readonly [Range, Range, Range]): [number, number, number] => [between(r, x), between(r, y), between(r, z)]
/**
 * A puff's shape and slice, drawn from its look; the slice raised where the puff would end in a hard edge (a rim where the slice
 * cuts it, or the quad's own edge: cloudQuad.ts). The draws are the same as for the look's own slice, so nothing else moves.
 */
const shapeAndSlice = (r: () => number, shape: readonly [Range, Range, Range], slice: Range): { maxSize: [number, number, number]; slice: number } => {
  const maxSize = shapeOf(r, shape)
  return { maxSize, slice: softSlice(maxSize, between(r, slice)) }
}
/** Where a cloud of this size (its larger side, metres) has faded out: where it looks FADE_ANGLE across, at most CLOUD_KM. */
export const farKmOf = (sizeM: number): number => Math.min(CLOUD_KM, sizeM / 1000 / FADE_ANGLE)

/** How much of a cloud (or a rain shaft) shows at km from the aircraft: all of it until the last 30 % before its farKm, none from there. */
export function fadeAlpha(c: Pick<CloudSpec, 'farKm'>, km: number): number {
  return 1 - smoothstep((km - (1 - FADE_BAND) * c.farKm) / (FADE_BAND * c.farKm))
}

/** A place drawn evenly from the disc of rKm round lat, lon: [lon, lat]. */
function inDisc(r: () => number, lat: number, lon: number, rKm: number): [number, number] {
  const d = rKm * Math.sqrt(r())
  const a = 2 * Math.PI * r()
  return at(lat, lon, d * Math.sin(a), d * Math.cos(a))
}

/** The place eastKm and northKm from lat, lon (on the plane round it): [lon, lat]. */
function at(lat: number, lon: number, eastKm: number, northKm: number): [number, number] {
  return [wrapLon(lon + eastKm / (KM_PER_DEG * Math.max(0.01, Math.cos(lat * RAD)))), lat + northKm / KM_PER_DEG]
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

const SHADE_OF: Readonly<Record<string, number>> = { BKN: 0.55, OVC: 0.85, VV: 0.95, OVX: 0.95 }

/**
 * How much a station's broken or overcast layer greys the sky over the camera, 0 (none) to about 1: its thickest such
 * layer whose base is above the camera. Metres as the station reports them (MSL); the camera's height above the ellipsoid
 * differs by the geoid's few tens of metres, nothing against a cloud base.
 */
export function overcastShade(m: Metar | null, camM: number): number {
  if (m === null || m.elevM === null) return 0
  let shade = 0
  for (const c of m.clouds) {
    const s = SHADE_OF[c.cover] ?? 0
    if (s > shade && c.baseFt !== null && m.elevM + c.baseFt * FT > camM) shade = s
  }
  if (m.vertVisFt !== null && m.elevM + m.vertVisFt * FT > camM) shade = Math.max(shade, SHADE_OF.VV)
  return shade
}

/**
 * The clouds of one report: its towers (never thinned), then each layer's clouds by its cover, thinned to its share of
 * what is left of cap (each kept cloud made √(wanted / kept) times wider and taller: the layer covers as much, from above
 * and from below). The kept clouds are the first of the layer's sequence, so thinning keeps their places. seed reshuffles
 * the whole sky.
 */
export function metarClouds(m: Metar, seed = 0, cap = STATION_CAP): CloudSpec[] {
  const ground = m.elevM
  if (ground === null) return [] // its bases are feet above a height not known
  const layers = m.clouds.filter((c): c is Layer => isCover(c.cover) && c.baseFt !== null)
  const out: CloudSpec[] = []
  let tower = 0
  for (const c of layers) if (c.type !== null) tower = towers(out, m, ground, c, sequence(hash(`${m.id}|${c.cover}${c.baseFt}|${c.type}|towers|${seed}`)), tower)
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
      const h = between(r, look.h) * grow
      out.push({
        lon, lat, heightM: base + (PUFF_FILL * h) / 2, groundM: ground, scale: [w, h], ...shapeAndSlice(r, look.shape, look.slice),
        brightness: between(r, look.brightness) * SHADE ** above, tint: between(r, look.tint), farKm: farKmOf(Math.max(w, h)),
      })
    }
  })
  return out
}

/** One tower to stand, a CB's or the radar's: where, the base it stands on and the ground under it (metres above sea level), its height from the base, its column's width, its anvil's width (0: none) and its lowest puffs' grey. */
interface Tower {
  lat: number
  lon: number
  baseM: number
  groundM: number
  heightM: number
  widthM: number
  anvilM: number
  baseTint: number
  id: number
  fadeKm?: number // fades out by this far at most (default: CLOUD_KM)
}

/**
 * A CB or TCU layer's towers (numbered from first; returns the next number): each at a place in the disc, as tall and as wide as
 * its look says (TOWERS), a CB's with an anvil.
 */
function towers(out: CloudSpec[], m: Metar, ground: number, c: Layer, r: () => number, first: number): number {
  const look = TOWERS[c.type!]
  const base = ground + c.baseFt * FT
  const n = look.count[0] + Math.floor(r() * (look.count[1] - look.count[0] + 1))
  for (let t = 0; t < n; t++) {
    const [lon, lat] = inDisc(r, m.lat, m.lon, DISC_KM * TOWER_DISC)
    const H = between(r, look.h)
    const W = between(r, look.w)
    const anvilM = look.anvil === null ? 0 : W * between(r, look.anvil)
    tower(out, { lat, lon, baseM: base, groundM: ground, heightM: H, widthM: W, anvilM, baseTint: look.baseTint, id: first + t }, r)
  }
  return first + n
}

/**
 * A tower: a column from its base to its top, levels of puffs that overlap into one cloud, three side by side round the axis at
 * the base down to one at the top, dark grey at the base and white from half its height up; an anvil, wide flat puffs along the
 * way it spreads, crowns one that has it. A tower fades out as one, by its height, its width or its anvil.
 */
function tower(out: CloudSpec[], t: Tower, r: () => number): void {
  const { baseM: base, groundM: ground, heightM: H, widthM: W, anvilM: anvilW } = t
  const farKm = Math.min(t.fadeKm ?? CLOUD_KM, farKmOf(Math.max(H, W, anvilW)))
  const levels = levelsOf(H, W)
  const hp = (PUFF_STACK * H) / levels
  const low = base + (PUFF_FILL * hp) / 2 // the lowest level's middle: its puffs' base on the layer's
  const high = base + H - (PUFF_FILL * hp) / 2 // the top level's: their tops at the tower's
  for (let i = 0; i < levels; i++) {
    const up = i / (levels - 1)
    const k = Math.max(1, Math.round(LEVEL_PUFFS - (LEVEL_PUFFS - 1) * up))
    const turn = 2 * Math.PI * r()
    const ring = k === 1 ? 0 : (PUFF_RING * W) / 1000
    const tint = t.baseTint * Math.max(0, 1 - 2 * up)
    for (let j = 0; j < k; j++) {
      const a = turn + (2 * Math.PI * j) / k
      const [lon, lat] = at(t.lat, t.lon, ring * Math.sin(a), ring * Math.cos(a))
      out.push({
        lon, lat, heightM: low + (high - low) * up, groundM: ground, scale: [PUFF_W * W * (1 - 0.2 * up), hp], ...shapeAndSlice(r, TOWER_SHAPE, TOWER_SLICE),
        brightness: between(r, TOWER_BRIGHTNESS), tint, farKm, tower: t.id,
      })
    }
  }
  if (anvilW === 0) return
  const ah = between(r, ANVIL_H)
  const way = 2 * Math.PI * r()
  for (let j = 0; j < ANVIL_PUFFS; j++) {
    const d = ((j - (ANVIL_PUFFS - 1) / 2) * anvilW) / ANVIL_PUFFS / 1000
    const [lon, lat] = at(t.lat, t.lon, d * Math.sin(way), d * Math.cos(way))
    out.push({
      lon, lat, heightM: base + H - (PUFF_FILL * ah) / 2, groundM: ground, scale: [anvilW / 2, ah], ...shapeAndSlice(r, ANVIL_SHAPE, ANVIL_SLICE),
      brightness: between(r, TOWER_BRIGHTNESS), tint: 0, farKm, tower: t.id,
    })
  }
}

/** Squared km between two places, on the plane round them (fine within a few hundred km). */
function km2(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const y = (a.lat - b.lat) * KM_PER_DEG
  const x = wrapLon(a.lon - b.lon) * KM_PER_DEG * Math.cos(((a.lat + b.lat) / 2) * RAD)
  return x * x + y * y
}

/** observedClouds' options: at most max clouds that matter, stations whose disc comes within reachKm, the sky's seed, a cache. */
export interface ObservedOptions {
  max?: number
  reachKm?: number
  seed?: number
  // Each report's clouds, kept for the report object (read-only data from the server: a new report is a new object), so the
  // rebuilds as the aircraft flies on work out only the stations not seen before. A new cache works them all out again.
  cache?: WeakMap<Metar, CloudSpec[]>
}

/**
 * The observed clouds round lat, lon: those of each station whose disc comes within reachKm, each kept only where no other
 * station that reports the sky is nearer to it; and how many of those stations report the sky (the sky is built from them).
 * The stations are taken nearest first, and none is worked out once max clouds nearer than any it could add are in hand:
 * the nearest max of the result are the nearest max of the whole sky.
 */
export function observedClouds(metars: readonly Metar[], lat: number, lon: number, opts: ObservedOptions = {}): { specs: CloudSpec[]; stations: number } {
  const { max = MAX_CLOUDS, reachKm = CLOUD_KM, seed = 0, cache } = opts
  const cloudsOf = (m: Metar): CloudSpec[] => {
    let cs = cache?.get(m)
    if (cs === undefined) {
      cs = metarClouds(m, seed)
      cache?.set(m, cs)
    }
    return cs
  }
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
    const own = cloudsOf(m)
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

/**
 * At most max clouds within maxKm of lat, lon: the groups in order (observed first), each nearest first. None more than
 * REBUILD_KM past where it has faded out: it cannot fade in before the next build.
 */
export function nearestClouds(groups: readonly (readonly CloudSpec[])[], lat: number, lon: number, max = MAX_CLOUDS, maxKm = CLOUD_KM): CloudSpec[] {
  const out: CloudSpec[] = []
  const here = { lat, lon }
  for (const g of groups) {
    if (out.length >= max) break
    const near = g.map((c) => ({ c, d: km2(c, here) })).filter((x) => x.d <= Math.min(maxKm, x.c.farKm + REBUILD_KM) ** 2).sort((a, b) => a.d - b.d)
    for (const { c } of near.slice(0, max - out.length)) out.push(c)
  }
  return out
}

/** A cloud's brightness for the Sun's night (0 day … 1 night): full by day, about half at dusk, 0.15 at night. */
export function sunBrightness(night: number): number {
  const n = Number.isFinite(night) ? Math.min(1, Math.max(0, night)) : 0
  return 1 - (1 - NIGHT_BRIGHTNESS) * n
}

// ---- the radar's clouds ----------------------------------------------------------------------------------------------------

/**
 * Where the radar's clouds and rain shafts stand: a place's base, metres above sea level, and the ground under it (an estimate
 * where no station is near: radarBases).
 */
export interface RadarBase {
  baseM: number
  groundM: number
}
export type BaseOf = (lat: number, lon: number) => RadarBase

interface RadarLook {
  radiusKm: number // its clouds and shafts have faded out by this far from the aircraft; the radar is read REBUILD_KM farther (a ring built at alpha 0)
  stationKm: number // a rain block's base is the ceiling of the nearest station within this
  defaultBaseM: number // else it is this far over the ground (an estimate: neither the radar nor the reports say)
  deckDbz: number // an echo of this and more is cloud: a deck
  rainDbz: number // a rain echo of this and more is a tower
  fullDbz: number // as heavy as the looks tell apart
  tops: readonly (readonly [number, number])[] // a tower's height from its base by the echo, dBZ and metres, in proportion between (estimates)
  width: Range // a tower's column, m: at rainDbz to at fullDbz (estimate)
  widthJitter: number // a column's width varies by this much of that span
  tint: Range // its lowest puffs' grey: at rainDbz to at fullDbz
  anvilM: number // a tower this tall has an anvil
  anvil: Range // as wide as this many columns
  anvilMaxM: number // and no wider than this (a CB's own anvil reaches 28 km)
  spacing: number // two towers stand at least this share of a column's width apart
  towers: number // at most, the nearest
  grow: number // spacing and width grow by this much at most, to fit them
  reserve: number // of the 700 clouds this many are kept for the radar's, when it has so many (the observed clouds give way, the farthest first)
  deck: {
    w: Range // m
    h: Range
    shape: readonly [Range, Range, Range]
    slice: Range
    brightness: Range
    tint: Range // at deckDbz to at rainDbz
    spacingKm: number // one puff to this much of the area
    max: number // puffs, at most, the nearest
  }
  shaft: {
    dbz: number // under rain blocks of this and more (rainShafts.ts)
    max: number // at most, the nearest within radiusKm (the ring beyond it has its own on top)
    width: Range // m: at dbz to at fullDbz
    alpha: Range // opacity at the same
    widthJitter: number // a shaft is this much (of itself, ±) wider or narrower than that, each its own
    alphaJitter: number // and as much more or less opaque
    variants: number // images of rain: a shaft draws one of them, so shafts side by side differ
    overlapM: number // a shaft reaches this far up past where its tower's drawn bottom stands (towerRiseM), into the cloud's soft underside
    spacing: number // as the towers'
  }
}

/** The look of the radar's clouds and shafts: the plan's numbers, and estimates (named, to be tuned by eye). Read as the clouds are made. */
export const RADAR_LOOK: RadarLook = {
  radiusKm: 100,
  stationKm: 60,
  defaultBaseM: 1200,
  deckDbz: FIRST_DBZ,
  rainDbz: 30,
  fullDbz: 55,
  tops: [[30, 3000], [45, 7000], [55, 10000]],
  width: [3000, 6000],
  widthJitter: 0.3,
  tint: [0.4, 0.9],
  anvilM: 6000,
  anvil: [2.5, 3.5],
  anvilMaxM: 28_000,
  spacing: 0.75,
  towers: 40,
  grow: 4,
  reserve: 240,
  deck: { w: [7000, 11000], h: [900, 1500], shape: LOOKS.OVC.shape, slice: LOOKS.OVC.slice, brightness: [0.55, 0.75], tint: [0.3, 0.5], spacingKm: 5, max: 80 },
  shaft: { dbz: 35, max: 40, width: [2000, 4000], alpha: [0.3, 0.85], widthJitter: 0.2, alphaJitter: 0.15, variants: 4, overlapM: 400, spacing: 0.75 },
}

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0)
/** The value t of the way from a to b of a range (0 … 1). */
export const lerp = ([a, b]: Range, t: number): number => a + (b - a) * t

/** 0 at lo and under … 1 at hi and over: an echo's share of the way from lo to hi dBZ. */
export function ramp(dbz: number, lo: number, hi: number): number {
  return clamp01((dbz - lo) / (hi - lo))
}

/** The value at x of the line through points (x rising): the first's before the first, the last's after the last. */
function through(points: readonly (readonly [number, number])[], x: number): number {
  if (x <= points[0][0]) return points[0][1]
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]
    const [x1, y1] = points[i]
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
  }
  return points[points.length - 1][1]
}

/**
 * How far over its base the drawn bottom of a radar tower of this echo stands, metres. A puff shows about PUFF_SEEN of its
 * billboard's height, not the PUFF_FILL the bases are placed by (the drawn bottom is soft: this is where it is solid), so the
 * lowest puff of a tower, as tall as its levels make it (tower, at the size its echo gives, before any thinning), shows its bottom
 * this far up. An estimate; where a rain shaft's top hangs from (rainShafts.ts).
 */
export function towerRiseM(dbz: number): number {
  const L = RADAR_LOOK
  const H = through(L.tops, dbz)
  const W = lerp(L.width, ramp(dbz, L.rainDbz, L.fullDbz))
  return ((PUFF_FILL - PUFF_SEEN) / 2) * ((PUFF_STACK * H) / levelsOf(H, W))
}

const CEILING_COVERS = new Set(['BKN', 'OVC', 'VV', 'OVX'])

/** A report's ceiling, metres above sea level: the base of its lowest broken or overcast layer, or the sky hidden (vertical visibility). Null: none, or the station's height unknown. */
export function ceilingM(m: Metar): number | null {
  if (m.elevM === null) return null
  const ft = m.clouds.filter((c) => CEILING_COVERS.has(c.cover) && c.baseFt !== null).map((c) => c.baseFt!)
  if (m.vertVisFt !== null) ft.push(m.vertVisFt)
  return ft.length === 0 ? null : m.elevM + Math.min(...ft) * FT
}

interface Known {
  lat: number
  lon: number
  elevM: number
  ceilingM: number | null
}

/**
 * Where rain falls from: the ceiling of the nearest station that has one within RADAR_LOOK.stationKm, with that station's height
 * as the ground; else RADAR_LOOK.defaultBaseM over the ground, which is the nearest station's height if it is within stationKm
 * (a farther one says nothing of the ground here: over open sea it would float a base), or sea level. Estimates: the radar has
 * no cloud base and no height of the ground.
 */
export function radarBases(metars: readonly Metar[]): BaseOf {
  const known: Known[] = metars.filter((m) => m.elevM !== null).map((m) => ({ lat: m.lat, lon: m.lon, elevM: m.elevM!, ceilingM: ceilingM(m) }))
  const ceilings = known.filter((s) => s.ceilingM !== null)
  return (lat, lon) => {
    const kx = KM_PER_DEG * Math.cos(lat * RAD)
    const nearest = (list: readonly Known[]): { s: Known; km: number } | null => {
      let best: Known | null = null
      let bestKm2 = Infinity
      for (const s of list) {
        const d2 = (wrapLon(s.lon - lon) * kx) ** 2 + ((s.lat - lat) * KM_PER_DEG) ** 2
        if (d2 < bestKm2) [best, bestKm2] = [s, d2]
      }
      return best === null ? null : { s: best, km: Math.sqrt(bestKm2) }
    }
    const c = nearest(ceilings)
    if (c !== null && c.km <= RADAR_LOOK.stationKm) return { baseM: c.s.ceilingM!, groundM: c.s.elevM }
    const n = nearest(known)
    const ground = n !== null && n.km <= RADAR_LOOK.stationKm ? n.s.elevM : 0
    return { baseM: ground + RADAR_LOOK.defaultBaseM, groundM: ground }
  }
}

/**
 * The clouds of the radar's cells (radarCells.ts): a tower for each rain block of RADAR_LOOK.rainDbz and more (the strongest
 * kept apart, so a core is not a hundred towers: at most RADAR_LOOK.towers within RADAR_LOOK.radiusKm, the nearest), as tall as
 * its echo says, a column 3 to 6 km wide (more where they were thinned), its base dark grey, darker the heavier, white above, an
 * anvil when it is tall; and for each light block (RADAR_LOOK.deckDbz up to the rain's, or any snow) a flat grey puff of a deck at
 * the base, thinned the same way (at most RADAR_LOOK.deck.max). Both stand on the base of their place (base). The cells past
 * radiusKm (the ring the caller read so that a storm is there before it fades in) are kept on top of those, at the same spacing:
 * they stand hidden (they have faded out by radiusKm) and fade in as the aircraft comes. What a cell draws comes from its own
 * seed, so a refresh reshuffles nothing.
 */
export function radarClouds(cells: readonly RadarCell[], base: BaseOf): CloudSpec[] {
  const L = RADAR_LOOK
  const out: CloudSpec[] = []
  const rain = cells.filter((c) => !c.snow && c.dbz >= L.rainDbz)
  const columns = thin(rain, (c) => (L.spacing * lerp(L.width, ramp(c.dbz, L.rainDbz, L.fullDbz))) / 1000, L.towers, L.grow, L.radiusKm)
  columns.kept.forEach((c, id) => {
    const r = sequence(c.seed)
    const b = base(c.lat, c.lon)
    const heavy = ramp(c.dbz, L.rainDbz, L.fullDbz)
    const W = lerp(L.width, clamp01(heavy + (r() - 0.5) * L.widthJitter)) * columns.m
    const H = through(L.tops, c.dbz)
    const anvilM = H >= L.anvilM ? Math.min(W * between(r, L.anvil), L.anvilMaxM) : 0
    tower(out, { lat: c.lat, lon: c.lon, baseM: b.baseM, groundM: b.groundM, heightM: H, widthM: W, anvilM, baseTint: lerp(L.tint, heavy), id, fadeKm: L.radiusKm }, r)
  })
  const light = cells.filter((c) => c.dbz >= L.deckDbz && (c.snow || c.dbz < L.rainDbz))
  const deck = L.deck
  const lying = thin(light, () => deck.spacingKm, deck.max, L.grow, L.radiusKm)
  for (const c of lying.kept) {
    const r = sequence(c.seed)
    const b = base(c.lat, c.lon)
    const w = between(r, deck.w) * lying.m
    const h = between(r, deck.h) * lying.m
    out.push({
      lon: c.lon, lat: c.lat, heightM: b.baseM + (PUFF_FILL * h) / 2, groundM: b.groundM, scale: [w, h], ...shapeAndSlice(r, deck.shape, deck.slice),
      brightness: between(r, deck.brightness), tint: clamp01(lerp(deck.tint, ramp(c.dbz, L.deckDbz, L.rainDbz)) + (r() - 0.5) * 0.1), farKm: Math.min(L.radiusKm, farKmOf(Math.max(w, h))),
    })
  }
  return out
}

// ---- the model's clouds ----------------------------------------------------------------------------------------------------

type ModelKind = 'low' | 'mid' | 'high'
interface ModelClass {
  density: number // the share of the observed looks' clouds a km² (LOOKS) at rampFrom % of cover and under …
  full: number // … and at rampTo % and over, in between by the cover
  look?: Pick<Look, 'w' | 'h' | 'shape' | 'slice' | 'brightness' | 'tint'> // else the cover's own look (LOOKS)
}
interface ModelLook {
  minCover: number // % a level's cover must reach to be drawn (the plan's)
  sct: number // from this cover (%) the clouds are SCT, from bkn BKN, from ovc OVC; from minCover to sct FEW: the oktas' edges, 2, 4 and 7 eighths
  bkn: number
  ovc: number
  rampFrom: number // the density, and the size of a puff, follow the cover from this (%: the density, and the size, as they are at 40 % and under) …
  rampTo: number // … to this (the class's full density, and a puff `grow` times as large)
  stationKm: number // no low level within this of a station that reports the sky (the plan's)
  lowHPa: number // a level at this pressure or more (850: 1000, 925, 850 hPa, the lowest 1.5 km) is low (the plan's) …
  highHPa: number // … at this or less (300: 300, 250, 200 hPa) high (the plan's); those between are mid
  aboveGroundM: number // a level lower than this over the model's ground is not drawn: its cloud is under the ground
  max: number // clouds at most: what is wanted is thinned to this (the 700 are shared with the observed and the radar's, which come first)
  grow: number // a puff of a level at rampTo % cover and over is this much wider and taller than its look says (its number is that squared fewer)
  ring: readonly number[] // the share of its puffs that the outer ring of the grid keeps, and the next ring: the sky thins out at the grid's edge
  clearKm: number // a puff is hidden within this of an aircraft at the height it spans (cloudLayer.ts)
  low: ModelClass
  mid: ModelClass
  high: ModelClass
}

/**
 * The look of the model's clouds: the plan's numbers, and estimates (named, to be tuned by eye). Read as the clouds are made.
 * They are modest by design: densities under the observed looks', rising toward them as a level fills, and the flat, pale puffs
 * of altocumulus and cirrus.
 */
export const MODEL_LOOK: ModelLook = {
  minCover: 20,
  sct: 25,
  bkn: 50,
  ovc: 87.5,
  rampFrom: 40,
  rampTo: 80,
  stationKm: 40,
  lowHPa: 850,
  highHPa: 300,
  aboveGroundM: 100,
  max: 500,
  grow: 3,
  ring: [0.25, 0.6],
  clearKm: 3,
  low: { density: 0.7, full: 0.95 },
  mid: { density: 0.4, full: 0.8, look: { w: [3000, 7000], h: [450, 900], shape: [[30, 44], [8, 12], [9, 13]], slice: [0.3, 0.42], brightness: [0.82, 0.98], tint: [0, 0.08] } },
  high: { density: 0.25, full: 0.6, look: { w: [4000, 9000], h: [250, 500], shape: [[34, 50], [6, 9], [8, 11]], slice: [0.4, 0.55], brightness: [0.78, 0.92], tint: [0, 0.03] } },
}

/**
 * The clouds of a model grid (a forecast round the aircraft): for each place and pressure level with MODEL_LOOK.minCover % of cloud or
 * more, puffs over the place's cell (0.25° square), standing from the level's height: the observed looks' density for its cover,
 * times the share of it for its kind of level and cover (MODEL_LOOK.density up to rampFrom %, full from rampTo %), in puffs larger
 * by a growth that follows the same cover (1 to MODEL_LOOK.grow), so that many fewer of them cover as much; the outer rings of the grid
 * keep MODEL_LOOK.ring of their puffs. At most MODEL_LOOK.max in all: thinned evenly in the sky they cover (a place and level's share
 * is as the number of its puffs times their size squared), each keeping the first puffs of its own sequence (a count worked out from
 * the place and the thinning alone, rounded by a dither of its own: it changes by a puff as the thinning does), their size untouched.
 * A low level is left out at a place within MODEL_LOOK.stationKm of a report in metarsNear that says what the sky is (observations
 * win), and any level under the model's ground. Each place and level draws from a sequence of its own, not the grid's: the next
 * grid's overlapping places draw the puffs they drew.
 * ponytail: the thinning is even over the grid, not by distance, so where the observed clouds and the radar's leave the model little
 * of the 700 only its nearest are drawn; the edge's thinning is by rings of places, 28 km wide, not by distance from the edge; the
 * model's ground is a smoothed relief, so a cloud over a ridge can stand inside it. Upgrade: share by distance and by the
 * aircraft's height; a fade by the distance to the grid's edge; the globe's height under the cloud.
 */
export function modelClouds(grid: ModelGrid, metarsNear: readonly Metar[], seed = 0): CloudSpec[] {
  const M = MODEL_LOOK
  const stations = metarsNear.filter(reportsSky)
  const northKm = grid.step * KM_PER_DEG // a place's cell, on the plane round it
  interface Group {
    lat: number
    lon: number
    ground: number
    hPa: number
    z: number
    kind: ModelKind
    cover: Cover
    grow: number // by its level's cover alone
    wanted: number // the puffs it wants, before the cap
    dither: number // 0 … 1, its own: how its count is rounded
    eastKm: number
  }
  const groups: Group[] = []
  for (let p = 0; p < grid.n * grid.n; p++) {
    const [row, col] = [Math.floor(p / grid.n), p % grid.n]
    const lat = grid.lat0 + row * grid.step
    const lon = wrapLon(grid.lon0 + col * grid.step)
    const ground = grid.elevM[p] ?? 0
    const eastKm = northKm * Math.cos(lat * RAD)
    const edge = M.ring[Math.min(row, col, grid.n - 1 - row, grid.n - 1 - col)] ?? 1 // the grid's outer rings keep part of their puffs
    let observed: boolean | undefined // a station that reports the sky is within stationKm of the place (worked out when a low level asks)
    for (const level of grid.clouds) {
      const cover = level.cover[p]
      const z = level.zM[p]
      if (cover === null || cover === undefined || z === null || z === undefined || cover < M.minCover || z < ground + M.aboveGroundM) continue
      const kind: ModelKind = level.hPa >= M.lowHPa ? 'low' : level.hPa <= M.highHPa ? 'high' : 'mid'
      if (kind === 'low') {
        observed ??= stations.some((s) => km2(s, { lat, lon }) <= M.stationKm ** 2)
        if (observed) continue // observations win; a place left out does not use up the cap
      }
      const by: Cover = cover >= M.ovc ? 'OVC' : cover >= M.bkn ? 'BKN' : cover >= M.sct ? 'SCT' : 'FEW'
      const t = ramp(cover, M.rampFrom, M.rampTo)
      const grow = lerp([1, M.grow], t)
      const wanted = Math.round((LOOKS[by].perKm2 * lerp([M[kind].density, M[kind].full], t) * northKm * eastKm * edge) / grow ** 2)
      if (wanted > 0) groups.push({ lat, lon, ground, hPa: level.hPa, z, kind, cover: by, grow, wanted, dither: hash(`dither|${lat}|${lon}|${level.hPa}|${seed}`) / 4294967296, eastKm })
    }
  }
  // Each group keeps floor(wanted × min(1, f × grow²) + its dither) puffs: f is the most that keeps the total within the cap (1 when all
  // fit, then each keeps what it wants). A group's share is as the sky its puffs cover (their number times their size squared), so
  // where the cap bites a deck of large puffs keeps more of its own than a few small cumulus do. Its count depends on f and on itself
  // alone, and changes by a puff at a time as f does.
  const keep = (g: Group, f: number): number => Math.floor(g.wanted * Math.min(1, f * g.grow ** 2) + g.dither)
  const count = (f: number): number => groups.reduce((n, g) => n + keep(g, f), 0)
  let f = 1
  if (count(1) > M.max) {
    let [lo, hi] = [0, 1]
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (count(mid) <= M.max) lo = mid
      else hi = mid
    }
    f = lo
  }
  const out: CloudSpec[] = []
  for (const g of groups) {
    const kept = keep(g, f)
    if (kept === 0) continue
    const look = M[g.kind].look ?? LOOKS[g.cover]
    const r = sequence(hash(`model|${g.lat}|${g.lon}|${g.hPa}|${seed}`)) // by the place and the level, not the grid: a place in the next grid draws what it drew
    for (let k = 0; k < kept; k++) {
      const [lon, lat] = at(g.lat, g.lon, (r() - 0.5) * g.eastKm, (r() - 0.5) * northKm)
      const w = between(r, look.w) * g.grow
      const h = between(r, look.h) * g.grow
      out.push({
        lon, lat, heightM: g.z + (PUFF_FILL * h) / 2, groundM: g.ground, scale: [w, h], ...shapeAndSlice(r, look.shape, look.slice),
        brightness: between(r, look.brightness), tint: between(r, look.tint), farKm: farKmOf(Math.max(w, h)), clearKm: M.clearKm,
      })
    }
  }
  return out
}

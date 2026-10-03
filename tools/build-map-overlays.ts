// tools/build-map-overlays.ts
// Builds the chase map's overlays (shared/mapOverlays.ts) in public/map/ from Natural Earth (public domain,
// https://www.naturalearthdata.com/about/terms-of-use/):
// - borders.json: every land border line (ne_10m_admin_0_boundary_lines_land), for client/scene/borders.ts to draw.
// - seas.json: one label point per named ocean, sea, gulf and bay (ne_10m_geography_marine_polys), for
//   client/scene/placeLabels.ts: the centre of the largest circle inside it (insidePoint), so the name sits well inside.
// - countries.json: each country at Natural Earth's own label point (ne_10m_admin_0_countries), for placeLabels.ts: on
//   the mainland where a box round the people would fall in the sea (Spain with the Canaries, Portugal with the Azores).
//
//   node tools/build-map-overlays.ts [--out public/map] [--cache node_modules/.cache]
//
// The sources (~17 MB) are downloaded once into --cache (under node_modules, so gitignored); delete them to refresh.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { BORDER_UNIT, type BordersJson, type CountriesJson, type SeasJson } from '../shared/mapOverlays.ts'

const NATURAL_EARTH = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/'
const BORDERS_FILE = 'ne_10m_admin_0_boundary_lines_land.geojson'
const SEAS_FILE = 'ne_10m_geography_marine_polys.geojson'
const COUNTRIES_FILE = 'ne_10m_admin_0_countries.geojson'
const COUNTRY_MIN_LABEL = 6 // Natural Earth names these only from zoom 6 on: bases, leases, reefs, disputed specks
const SEA_KINDS = new Set(['ocean', 'sea', 'gulf', 'bay']) // not the straits, channels, sounds, fjords and lagoons
const GRID = 24 // insidePoint's first look: GRID × GRID points over the polygon's box
const REFINE = 8 // then this many rounds of 5 × 5 points round the best, each at half the last step

type Position = readonly number[] // [lon, lat]
interface Geometry { type: string; coordinates: unknown }
interface Feature { type?: string; properties: Record<string, unknown> | null; geometry: Geometry | null }
interface FeatureCollection { type?: string; features: readonly Feature[] }

/** A line's points as [lon0, lat0, dlon1, dlat1, …] in BORDER_UNITs; a point that rounds onto the one before is dropped. */
export function encodeLine(coords: readonly Position[]): number[] {
  const out: number[] = []
  let px = 0
  let py = 0
  for (const [lon, lat] of coords) {
    const x = Math.round(lon * BORDER_UNIT)
    const y = Math.round(lat * BORDER_UNIT)
    if (out.length === 0) out.push(x, y)
    else if (x !== px || y !== py) out.push(x - px, y - py)
    px = x
    py = y
  }
  return out
}

/** Every line of the collection's LineStrings and MultiLineStrings, encoded; one that rounds to a single point is left out. */
export function bordersFrom(fc: FeatureCollection): BordersJson {
  const lines: number[][] = []
  for (const f of fc.features) {
    const g = f.geometry
    const parts = (g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : []) as Position[][]
    for (const p of parts) {
      const l = encodeLine(p)
      if (l.length >= 4) lines.push(l)
    }
  }
  return { lines }
}

/** Squared distance from (px, py) to the segment (ax, ay)–(bx, by). */
function segmentDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / l2))
  const ex = ax + t * dx - px
  const ey = ay + t * dy - py
  return ex * ex + ey * ey
}

/** The distance from (x, y) to the nearest edge of the rings, positive inside them (even-odd: holes are outside), negative outside; longitudes scaled by kx. */
function signedDist(rings: readonly (readonly Position[])[], x: number, y: number, kx: number): number {
  let inside = false
  let best = Infinity
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i]
      const [xj, yj] = r[j]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
      const d = segmentDist2(x * kx, y, xi * kx, yi, xj * kx, yj)
      if (d < best) best = d
    }
  }
  return (inside ? 1 : -1) * Math.sqrt(best)
}

/**
 * The centre of the largest circle inside a polygon (its outer ring, then its holes; [lon, lat] points) and its radius in
 * degrees of latitude: the best of a GRID × GRID look over its box, refined round it. Longitudes are scaled by the
 * cosine of the box's middle latitude, so the circle is round on the ground.
 * ponytail: one scale for the whole box, so a polygon spanning tens of degrees of latitude (an ocean) gets a circle a
 * little wide or narrow at its ends. Upgrade: measure on the sphere.
 */
export function insidePoint(rings: readonly (readonly Position[])[]): [lon: number, lat: number, r: number] {
  let west = Infinity
  let east = -Infinity
  let south = Infinity
  let north = -Infinity
  for (const [x, y] of rings[0]) {
    west = Math.min(west, x)
    east = Math.max(east, x)
    south = Math.min(south, y)
    north = Math.max(north, y)
  }
  const kx = Math.cos((((south + north) / 2) * Math.PI) / 180)
  let sx = (east - west) / GRID
  let sy = (north - south) / GRID
  let bx = (west + east) / 2
  let by = (south + north) / 2
  let br = signedDist(rings, bx, by, kx)
  const tryAt = (x: number, y: number): void => {
    const d = signedDist(rings, x, y, kx)
    if (d > br) {
      bx = x
      by = y
      br = d
    }
  }
  for (let i = 0; i < GRID; i++) for (let j = 0; j < GRID; j++) tryAt(west + (i + 0.5) * sx, south + (j + 0.5) * sy)
  for (let k = 0; k < REFINE; k++) {
    sx /= 2
    sy /= 2
    const cx = bx
    const cy = by
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) tryAt(cx + i * sx, cy + j * sy)
  }
  return [bx, by, br]
}

const r2 = (v: number): number => Math.round(v * 100) / 100 // 0.01°: ~1 km
const SMALL_WORDS = new Set(['of', 'the', 'and'])
/** "INDIAN OCEAN" → "Indian Ocean": two of Natural Earth's names are in capitals. Others stay as they are. */
const titled = (name: string): string => name !== name.toUpperCase() ? name
  : name.toLowerCase().split(' ').map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ')

/** One label point per named ocean, sea, gulf and bay (a MultiPolygon's from the part holding the largest circle); lowest scalerank first, then by name. */
export function seasFrom(fc: FeatureCollection): SeasJson['seas'] {
  const out: SeasJson['seas'] = []
  for (const f of fc.features) {
    const p = f.properties ?? {}
    const name = typeof p.name === 'string' ? p.name.trim() : ''
    const g = f.geometry
    if (name === '' || !SEA_KINDS.has(String(p.featurecla)) || g === null) continue
    const polys = (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []) as Position[][][]
    let best: [number, number, number] | null = null
    for (const rings of polys) {
      const at = insidePoint(rings)
      if (best === null || at[2] > best[2]) best = at
    }
    if (best !== null) out.push([titled(name), r2(best[0]), r2(best[1]), Number(p.scalerank)])
  }
  return out.sort((a, b) => a[3] - b[3] || a[0].localeCompare(b[0]))
}

/**
 * Each country at Natural Earth's label point (LABEL_X, LABEL_Y) with its LABELRANK (2 the largest … 10), lowest rank
 * first, then by name; MIN_LABEL ≥ COUNTRY_MIN_LABEL left out. The name is the shorter of NAME_EN and NAME_LONG: plain
 * English either way, without the formal "People's Republic of China" (NAME_EN) or "Russian Federation" (NAME_LONG), and
 * without NAME's abbreviations ("Dem. Rep. Congo").
 */
export function countriesFrom(fc: FeatureCollection): CountriesJson['countries'] {
  const out: CountriesJson['countries'] = []
  for (const f of fc.features) {
    const p = f.properties ?? {}
    const named = (n: unknown): string => (typeof n === 'string' ? n.trim() : '')
    const english = [named(p.NAME_EN), named(p.NAME_LONG)].filter((n) => n !== '')
    const name = english.length > 0 ? english.reduce((a, b) => (b.length < a.length ? b : a)) : named(p.NAME)
    const [lon, lat, rank, minLabel] = [p.LABEL_X, p.LABEL_Y, p.LABELRANK, p.MIN_LABEL].map(Number)
    if (name === '' || !Number.isFinite(lon) || !Number.isFinite(lat) || !(minLabel < COUNTRY_MIN_LABEL)) continue
    out.push([name, r2(lon), r2(lat), Number.isFinite(rank) ? rank : 10])
  }
  return out.sort((a, b) => a[3] - b[3] || a[0].localeCompare(b[0]))
}

/** Text of `dir/name`, downloaded from `base` first when it is not cached yet (tools/build-places.ts' pattern). */
async function cached(dir: string, base: string, name: string): Promise<Buffer> {
  const path = join(dir, name)
  if (!existsSync(path)) {
    const res = await fetch(base + name)
    if (!res.ok) throw new Error(`${base + name}: HTTP ${res.status}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, Buffer.from(await res.arrayBuffer()))
  }
  return readFileSync(path)
}

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { out: { type: 'string', default: 'public/map' }, cache: { type: 'string', default: 'node_modules/.cache' } },
  })
  const dir = join(values.cache, 'naturalearth')
  const json = async (name: string): Promise<FeatureCollection> => JSON.parse((await cached(dir, NATURAL_EARTH, name)).toString('utf8')) as FeatureCollection
  const borders = bordersFrom(await json(BORDERS_FILE))
  const seas = seasFrom(await json(SEAS_FILE))
  const countries = countriesFrom(await json(COUNTRIES_FILE))
  mkdirSync(values.out, { recursive: true })
  // One row a line: small diffs when the source changes.
  const rows = (key: string, list: readonly unknown[]): string => `{"${key}":[\n${list.map((r) => JSON.stringify(r)).join(',\n')}\n]}\n`
  writeFileSync(join(values.out, 'borders.json'), rows('lines', borders.lines))
  writeFileSync(join(values.out, 'seas.json'), rows('seas', seas))
  writeFileSync(join(values.out, 'countries.json'), rows('countries', countries))
  const points = borders.lines.reduce((n, l) => n + l.length / 2, 0)
  console.log(`${values.out}: borders.json ${borders.lines.length} lines, ${points} points; seas.json ${seas.length} seas; countries.json ${countries.length} countries`)
}

if (import.meta.main) await main(process.argv.slice(2))

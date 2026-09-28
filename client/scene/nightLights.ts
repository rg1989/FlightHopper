// client/scene/nightLights.ts
import { Credit, ImageryLayer, Resource, UrlTemplateImageryProvider } from 'cesium'
import type { ImageryTypes, Request } from 'cesium'
import { openFreeMapTiles } from './buildings.ts'
import { decodeLines, type LineFeature } from './mvt.ts'

// NASA GIBS WMTS: keyless, CORS *. VIIRS Black Marble (city lights), the 2016 composite, EPSG:3857, tile matrix set
// GoogleMapsCompatible_Level8 (z ≤ 8, z9 → HTTP 400). Checked 2026-09-22:
// https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml
// Level 8 is ~500 m/px here: it says where the light is, not what it looks like up close. The streets draw that.
export const NIGHT_URL =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png'
export const NIGHT_MAX_LEVEL = 8
// The acknowledgment GIBS asks clients to show: https://nasa-gibs.github.io/gibs-api-docs/
export const NIGHT_CREDIT =
  "VIIRS Black Marble 2016. We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS)."
// The street lights: roads from OpenFreeMap (the 3-D buildings' source), lit where the Black Marble says it is lit.
export const STREETS_FROM = 10 // shallower tiles have the glow alone; OpenFreeMap has motorways to secondaries from z10
export const STREETS_MAX_LEVEL = 14 // OpenFreeMap's deepest tiles: every street from z13, service roads at z14
export const STREETS_CREDIT = 'Street lights: OpenFreeMap, © OpenMapTiles, data © OpenStreetMap contributors'

// The Black Marble art is a picture, not light: the sea (4, 5, 15), the unlit land a blue-grey underlay up to luminance
// ~0.2, towns orange-beige, city cores white (sampled over Israel, 2026-09-29). Drawn as it is, a city seen from
// the chase camera was one white sheet that the moonlight turned blue.
const LIT_FROM = 0.22 // the luminance where light begins, just above the land underlay
const LIT_FULL = 0.95 // and where it is full: the art's white cores are 0.95–1
// Lamp colours, warmer than they look: the Moon's blue tint (sun.ts lampBrightness) takes some warmth back.
const SODIUM = [255, 140, 40] // residential streets: sodium orange
const GOLD = [255, 178, 85] // main roads
const WHITE = [255, 215, 160] // motorways, and the glow of the brightest cores: white LED
/** Street lights by OpenMapTiles road class: lit width (m), brightness, colour, and how lit the road is between its lamps (0: the lamps alone). */
const LAMPS: Record<string, { widthM: number; bright: number; rgb: readonly number[]; surface: number }> = {
  motorway: { widthM: 18, bright: 1, rgb: WHITE, surface: 0.3 },
  trunk: { widthM: 16, bright: 1, rgb: WHITE, surface: 0.3 },
  primary: { widthM: 16, bright: 0.95, rgb: GOLD, surface: 0.35 },
  secondary: { widthM: 14, bright: 0.9, rgb: GOLD, surface: 0.3 },
  tertiary: { widthM: 12, bright: 0.85, rgb: GOLD, surface: 0.25 },
  minor: { widthM: 9, bright: 0.8, rgb: SODIUM, surface: 0 },
  service: { widthM: 6, bright: 0.5, rgb: SODIUM, surface: 0 },
}
const HALO = 5 // each road's glow: this many times its width…
const HALO_ALPHA = 0.16 // …this strong
const LAMP_EVERY_M = 40 // street lights ~35–45 m apart
const LAMP_M = 6 // a lamp's pool of light, drawn as a dot
const DOTS_FROM_PX = 2 // closer lamps than this merge into a line…
const MERGED = 0.6 // …this bright
const ROAD_GAIN = 3 // streets are fully lit wherever the art's light passes 1/3
const ROAD_MEAN = 0.3 // share of a city the lit streets cover, for the tiles too coarse to draw them
// The light between the streets (yards, signs, windows) comes from the art alone, blurred over ~500 m: a coarse tile
// shows all of it; a finer one, which draws the lamps themselves, less (halved every two levels from level 11).
const GLOW = 0.25
const GLOW_FULL_LEVEL = 11
const TILE = 256
const EARTH_M = 40_075_016.686 // WGS84 equator, as Web Mercator scales it

/** The art's light at one pixel, 0–1: none below LIT_FROM of luminance, full from LIT_FULL. */
export function litOf(r: number, g: number, b: number): number {
  return Math.min(1, Math.max(0, ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 - LIT_FROM) / (LIT_FULL - LIT_FROM)))
}

/** The glow between the streets on a tile of this level: GLOW up to GLOW_FULL_LEVEL, halved every two levels deeper. */
export const glowAt = (level: number): number => GLOW * Math.min(1, 2 ** ((GLOW_FULL_LEVEL - level) / 2))

/**
 * One tile's lamplight, in place (RGBA, straight alpha, 256², rows from the north). On entry px holds the drawn streets
 * (drawStreets: their colours, their light as alpha) from STREETS_FROM; a coarser level ignores it, its streets too
 * fine to draw, and counts them as their mean. lit is the art's light (litOf) on its 256² grid; the tile covers the
 * art's pixels [ox, ox + span) × [oy, oy + span), sampled bilinearly. Streets are lit where the art has light
 * (ROAD_GAIN), a glow (glowAt) fills between them, sodium orange to white with the light. Unlit land and sea stay
 * transparent (in the glow's colour, so filtering draws no dark fringe).
 */
export function composeLamps(px: Uint8ClampedArray, lit: Float32Array, ox: number, oy: number, span: number, level: number): void {
  const k = span / TILE
  const streets = level >= STREETS_FROM
  const glow = glowAt(level)
  for (let r = 0; r < TILE; r++) {
    const ay = Math.min(TILE - 1, Math.max(0, oy + (r + 0.5) * k - 0.5))
    const y0 = Math.min(TILE - 2, Math.floor(ay))
    const fy = ay - y0
    for (let c = 0; c < TILE; c++) {
      const ax = Math.min(TILE - 1, Math.max(0, ox + (c + 0.5) * k - 0.5))
      const x0 = Math.min(TILE - 2, Math.floor(ax))
      const fx = ax - x0
      const j = y0 * TILE + x0
      const l = (lit[j] * (1 - fx) + lit[j + 1] * fx) * (1 - fy) + (lit[j + TILE] * (1 - fx) + lit[j + TILE + 1] * fx) * fy
      const i = (r * TILE + c) * 4
      const ra = (streets ? px[i + 3] / 255 : ROAD_MEAN) * Math.min(1, l * ROAD_GAIN)
      const ga = glow * l * (1 - ra)
      const a = ra + ga
      const w = l * l
      const gr = SODIUM[0] + (WHITE[0] - SODIUM[0]) * w
      const gg = SODIUM[1] + (WHITE[1] - SODIUM[1]) * w
      const gb = SODIUM[2] + (WHITE[2] - SODIUM[2]) * w
      if (a <= 0) {
        px[i] = gr
        px[i + 1] = gg
        px[i + 2] = gb
        px[i + 3] = 0
        continue
      }
      const [sr, sg, sb] = streets ? [px[i], px[i + 1], px[i + 2]] : GOLD
      px[i] = (sr * ra + gr * ga) / a
      px[i + 1] = (sg * ra + gg * ga) / a
      px[i + 2] = (sb * ra + gb * ga) / a
      px[i + 3] = 255 * a
    }
  }
}

/** Ground metres per pixel of a 256 px Web Mercator tile at level z, row y (at its middle). */
export function metresPerPx(z: number, y: number): number {
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / 2 ** z)))
  return (EARTH_M * Math.cos(lat)) / (TILE * 2 ** z)
}

/**
 * The lit roads in their lamps' colours, alpha their light, class by class: a faint wide halo, the lit road surface
 * (main roads), and the lamps as dots every LAMP_EVERY_M, or a line where they are closer than DOTS_FROM_PX.
 */
function drawStreets(g: OffscreenCanvasRenderingContext2D, features: LineFeature[], extent: number, mPerPx: number): void {
  const s = TILE / extent
  g.lineCap = 'round'
  g.lineJoin = 'round'
  for (const [cls, { widthM, bright, rgb, surface }] of Object.entries(LAMPS)) {
    g.beginPath()
    for (const f of features) {
      if (f.props.class !== cls || f.props.brunnel === 'tunnel') continue
      for (const line of f.lines) {
        g.moveTo(line[0][0] * s, line[0][1] * s)
        for (let i = 1; i < line.length; i++) g.lineTo(line[i][0] * s, line[i][1] * s)
      }
    }
    const w = widthM / mPerPx
    const every = LAMP_EVERY_M / mPerPx
    g.strokeStyle = `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`
    g.setLineDash([])
    g.globalAlpha = HALO_ALPHA * bright
    g.lineWidth = w * HALO
    g.stroke()
    if (every < DOTS_FROM_PX) {
      g.globalAlpha = MERGED * bright
      g.lineWidth = w
      g.stroke()
      continue
    }
    if (surface > 0) {
      g.globalAlpha = surface * bright
      g.lineWidth = w
      g.stroke()
    }
    g.setLineDash([0.01, every]) // round-capped dashes of ~0 length: dots, one per lamp
    g.globalAlpha = bright
    g.lineWidth = Math.max(1, LAMP_M / mPerPx)
    g.stroke()
  }
  g.setLineDash([])
}

// The art's light per level-≤8 tile, shared by every deeper tile under it. ponytail: first in, first out at 32 tiles
// (~150 km each at level 8): a chase view spans a handful.
const ART_KEEP = 32
const arts = new Map<string, Promise<Float32Array>>()
function artLit(z: number, x: number, y: number): Promise<Float32Array> {
  const key = `${z}/${x}/${y}`
  let p = arts.get(key)
  if (!p) {
    p = fetch(NIGHT_URL.replace('{z}', String(z)).replace('{y}', String(y)).replace('{x}', String(x)))
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`night lights ${key}: HTTP ${r.status}`))))
      .then((b) => createImageBitmap(b)) // upright: rows from the north
      .then((bmp) => {
        const c = new OffscreenCanvas(TILE, TILE)
        const g = c.getContext('2d', { willReadFrequently: true })!
        g.drawImage(bmp, 0, 0, TILE, TILE)
        const d = g.getImageData(0, 0, TILE, TILE).data
        const lit = new Float32Array(TILE * TILE)
        for (let i = 0; i < lit.length; i++) lit[i] = litOf(d[4 * i], d[4 * i + 1], d[4 * i + 2])
        return lit
      })
    p.catch(() => arts.delete(key)) // asked again next time
    arts.set(key, p)
    if (arts.size > ART_KEEP) arts.delete(arts.keys().next().value!)
  }
  return p
}

/**
 * A lamplight tile: the art under it, the streets when there are any (an OpenFreeMap tile's bytes). ~3 ms of main
 * thread (p95 ~10, dense level 14 up to ~25; M2, 2026-09-29), so each tile waits for its own task: tiles that arrive
 * together do not pile into one frame.
 */
async function lampTile(roads: ArrayBuffer | undefined, lit: Float32Array, x: number, y: number, level: number): Promise<ImageBitmap> {
  await new Promise((r) => setTimeout(r, 0))
  const c = new OffscreenCanvas(TILE, TILE)
  const g = c.getContext('2d', { willReadFrequently: true })!
  const t = roads && roads.byteLength > 0 ? decodeLines(new Uint8Array(roads), 'transportation') : null
  if (t) drawStreets(g, t.features, t.extent, metresPerPx(level, y))
  const img = g.getImageData(0, 0, TILE, TILE)
  const d = Math.max(0, level - NIGHT_MAX_LEVEL)
  const span = TILE / 2 ** d
  composeLamps(img.data, lit, (x % 2 ** d) * span, (y % 2 ** d) * span, span, level)
  // Cesium's own tiles are ImageBitmaps flipped at decode (WebGL ignores UNPACK_FLIP_Y for them): so this one too.
  return createImageBitmap(img, { imageOrientation: 'flipY', premultiplyAlpha: 'none' })
}

let streetsUrl: string | null = null
let asking = false
/** OpenFreeMap's tile URL once known; until then null, and it is asked for (once at a time). */
function streetsTemplate(): string | null {
  if (streetsUrl === null && !asking) {
    asking = true
    openFreeMapTiles()
      .then((u) => (streetsUrl = u))
      .catch(() => {})
      .finally(() => (asking = false))
  }
  return streetsUrl
}

/**
 * City lights: the Black Marble's light, down to the streets from STREETS_FROM. A deeper tile than the art's level 8
 * samples the level-8 tile above it. Street tiles go through Cesium's request scheduling (per server), so a busy
 * OpenFreeMap answers "later" (undefined) and a cancelled tile fails, to be asked again.
 */
class LampProvider extends UrlTemplateImageryProvider {
  override requestImage(x: number, y: number, level: number, request?: Request): Promise<ImageryTypes> | undefined {
    const d = Math.max(0, level - NIGHT_MAX_LEVEL)
    const art = artLit(level - d, Math.floor(x / 2 ** d), Math.floor(y / 2 ** d))
    if (level < STREETS_FROM) return art.then((lit) => lampTile(undefined, lit, x, y, level))
    const tpl = streetsTemplate()
    if (tpl === null) return undefined
    const url = tpl.replace('{z}', String(level)).replace('{x}', String(x)).replace('{y}', String(y))
    const roads = new Resource({ url, request }).fetchArrayBuffer()
    if (roads === undefined) return undefined
    return Promise.all([roads, art]).then(([buf, lit]) => lampTile(buf, lit, x, y, level))
  }
}

/**
 * The city-lights layer, hidden and transparent: Sun fades it in at dusk (alpha = night) and shows it only while it is
 * visible, so daytime makes no requests. Its tiles are lamplight (composeLamps); Sun sets its brightness so the lamps
 * shine by themselves, whatever the moon.
 * Add it right above the day layer. Constructing it requests nothing.
 */
export function makeNightLayer(): ImageryLayer {
  const provider = new LampProvider({
    url: NIGHT_URL,
    maximumLevel: STREETS_MAX_LEVEL,
    credit: new Credit(`${NIGHT_CREDIT} ${STREETS_CREDIT}`),
  })
  return new ImageryLayer(provider, { alpha: 0, show: false })
}

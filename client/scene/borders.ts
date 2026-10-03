// client/scene/borders.ts
// Country borders in the chase, drawn by us: Natural Earth's land border lines (public/map/borders.json, built by
// tools/build-map-overlays.ts) on every imagery tile Cesium asks for, at the same pixel width whatever the tile's zoom.
// So a border stays a thin crisp line at any distance and drapes on any terrain, where Esri's places raster, drawn for
// top-down zooms, lands on the far low-detail terrain tiles as wide blurred bands. mapLayer.ts shows the layer in the
// chase while Borders & places is on; a hidden layer asks for no tiles, and the data is fetched at its first show.
import { RequestState, UrlTemplateImageryProvider, type ImageryTypes, type Request } from 'cesium'
import { BORDER_UNIT, type BordersJson } from '../../shared/mapOverlays.ts'
import { queueDraw } from './drawQueue.ts'

export const BORDERS_MAX_LEVEL = 18
const TILE = 256 // px
const MARGIN_PX = 2 // a line this near a tile, outside it, is drawn too: its halo (1.5 px a side) and smoothing reach over the edge
const HALO = 'rgba(0, 0, 0, 0.45)' // legible over bright desert and snow as over dark sea
const HALO_PX = 3
const LINE = 'rgba(255, 238, 205, 0.92)'
const LINE_PX = 1.4
const RETRY_MS = 60_000 // after a failed fetch the tiles stay clear this long before the data is asked for again

/** A border line: its points as lon, lat pairs (degrees), and its box. */
export interface BorderLine {
  pts: Float64Array
  west: number
  south: number
  east: number
  north: number
}

/** borders.json's lines (shared/mapOverlays.ts), decoded. */
export function decodeBorders(json: BordersJson): BorderLine[] {
  return json.lines.map((l) => {
    const pts = new Float64Array(l.length)
    let x = 0
    let y = 0
    let west = Infinity
    let east = -Infinity
    let south = Infinity
    let north = -Infinity
    for (let i = 0; i + 1 < l.length; i += 2) {
      x += l[i] // the first point from 0: itself
      y += l[i + 1]
      const lon = (pts[i] = x / BORDER_UNIT)
      const lat = (pts[i + 1] = y / BORDER_UNIT)
      west = Math.min(west, lon)
      east = Math.max(east, lon)
      south = Math.min(south, lat)
      north = Math.max(north, lat)
    }
    return { pts, west, south, east, north }
  })
}

/** Web Mercator y of a latitude, 0 at the top of the world (85.05°N) to 1 at the bottom. */
function mercatorY(latDeg: number): number {
  const s = Math.sin((latDeg * Math.PI) / 180)
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)
}

/** The latitude of a Web Mercator y. */
const latitudeOf = (y: number): number => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI

/**
 * The stretches of the lines that tile (x, y) of level z draws, in its pixels (Web Mercator, TILE px a side, y down): each
 * run the points of consecutive steps that come within MARGIN_PX of it, so a long line costs only its steps through the
 * tile (and one each side, from outside to its edge). [] when no line comes near.
 * ponytail: longitudes are taken as plain numbers and latitudes through Web Mercator, so a line across the antimeridian
 * would be drawn the long way round and a stretch beyond ±85.05° is lost; Natural Earth's land borders have neither.
 * Upgrade, should a source have them: split lines at ±180° and clamp latitudes to ±85.05°.
 */
export function tileRuns(lines: readonly BorderLine[], x: number, y: number, z: number): number[][] {
  const n = 2 ** z
  const m = MARGIN_PX / TILE
  // The tile with its margin in degrees: a cheap test against each line's box first.
  const west = ((x - m) / n) * 360 - 180
  const east = ((x + 1 + m) / n) * 360 - 180
  const north = latitudeOf((y - m) / n)
  const south = latitudeOf((y + 1 + m) / n)
  const lo = -MARGIN_PX
  const hi = TILE + MARGIN_PX
  const runs: number[][] = []
  for (const l of lines) {
    if (l.east < west || l.west > east || l.north < south || l.south > north) continue
    const p = l.pts
    let run: number[] | null = null
    let px = 0
    let py = 0
    for (let i = 0; i + 1 < p.length; i += 2) {
      const qx = (((p[i] + 180) / 360) * n - x) * TILE
      const qy = (mercatorY(p[i + 1]) * n - y) * TILE
      if (i > 0) {
        // A step wholly beyond one side of the tile and its margin draws nothing in it.
        if ((px < lo && qx < lo) || (px > hi && qx > hi) || (py < lo && qy < lo) || (py > hi && qy > hi)) run = null
        else {
          if (run === null) runs.push((run = [px, py]))
          run.push(qx, qy)
        }
      }
      px = qx
      py = qy
    }
  }
  return runs
}

type Pen = Pick<CanvasRenderingContext2D, 'beginPath' | 'moveTo' | 'lineTo' | 'stroke' | 'strokeStyle' | 'lineWidth' | 'lineJoin' | 'lineCap'>

/**
 * The runs on a tile: one path, stroked twice, the dark halo under the light line. One stroke paints each pixel once,
 * so where runs meet or cross the halo does not darken.
 */
export function strokeRuns(ctx: Pen, runs: readonly number[][]): void {
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.beginPath()
  for (const r of runs) {
    ctx.moveTo(r[0], r[1])
    for (let i = 2; i + 1 < r.length; i += 2) ctx.lineTo(r[i], r[i + 1])
  }
  ctx.strokeStyle = HALO
  ctx.lineWidth = HALO_PX
  ctx.stroke()
  ctx.strokeStyle = LINE
  ctx.lineWidth = LINE_PX
  ctx.stroke()
}

let blankTile: ImageData | null = null
/** One clear pixel for every tile without a border: Cesium stretches it over the tile (a 4-byte texture, not 256 KB). */
const blank = (): ImageData => (blankTile ??= new ImageData(1, 1))

/**
 * Tile (x, y, z) as Cesium takes it: a canvas with the borders on it, north up (Cesium flips a canvas as it uploads it).
 * A canvas premultiplies its colours, but the halo round every line is black, so the clear pixels' black does not darken
 * an edge as it would the radar's colours (weather.ts' RadarProvider hands straight-alpha ImageData over for that).
 */
function tileImage(lines: readonly BorderLine[], x: number, y: number, z: number): HTMLCanvasElement | ImageData {
  const runs = tileRuns(lines, x, y, z)
  if (runs.length === 0) return blank()
  const c = document.createElement('canvas')
  c.width = c.height = TILE
  const ctx = c.getContext('2d')
  if (ctx === null) return blank()
  strokeRuns(ctx, runs)
  return c
}

async function getBorders(url: string): Promise<BordersJson> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return (await res.json()) as BordersJson
}

export interface BordersOptions {
  live?: () => boolean // whether its layer is shown: a tile still waiting to be drawn when it turns false is dropped
  getJson?: (url: string) => Promise<BordersJson>
  now?: () => number // ms, for the retry after a failure
}

/**
 * The borders as an imagery provider (Web Mercator tiles to level 18; the URL is the data's, not a tile template). The
 * data comes at the first load() (mapLayer.ts calls it when the layer first shows) or tile asked for, and every tile waits
 * for it. A tile's drawing is a drawQueue job: a view's tiles arriving together fill in over a few frames instead of
 * stalling one, and one still waiting when live() turns false is dropped undrawn.
 * ponytail: tiles drawn clear while the data was missing stay clear until Cesium asks for them again (the chase keeps
 * moving onto new ones). Upgrade: rebuild the layer when the data comes back.
 */
export class BordersProvider extends UrlTemplateImageryProvider {
  readonly #url: string
  readonly #live: () => boolean
  readonly #get: (url: string) => Promise<BordersJson>
  readonly #now: () => number
  #lines: Promise<readonly BorderLine[]> | null = null
  #failedAt: number | null = null

  constructor(url: string, opts: BordersOptions = {}) {
    super({ url, maximumLevel: BORDERS_MAX_LEVEL })
    this.#url = url
    this.#live = opts.live ?? (() => true)
    this.#get = opts.getJson ?? getBorders
    this.#now = opts.now ?? (() => performance.now())
  }

  /**
   * The lines, fetched on the first call. A fetch that fails, or a file that does not decode, leaves the tiles clear with
   * one warning, and the data is asked for again at the first call RETRY_MS after.
   */
  load(): Promise<readonly BorderLine[]> {
    if (this.#lines === null || (this.#failedAt !== null && this.#now() - this.#failedAt >= RETRY_MS)) {
      this.#failedAt = null
      this.#lines = this.#get(this.#url).then(decodeBorders).catch((e: unknown) => {
        console.warn('FlightHopper: no borders (asked again in a minute):', e)
        this.#failedAt = this.#now()
        return []
      })
    }
    return this.#lines
  }

  override requestImage(x: number, y: number, level: number, request?: Request): Promise<ImageryTypes> {
    const image = this.load().then((lines) => queueDraw(() => tileImage(lines, x, y, level), this.#live))
    return image.catch((e: unknown) => {
      // Cesium takes a cancelled request as "ask again later" and logs nothing; any other failure it logs, tile by tile.
      if (!this.#live() && request !== undefined) (request as { state: RequestState }).state = RequestState.CANCELLED
      throw e
    }) as unknown as Promise<ImageryTypes>
  }
}

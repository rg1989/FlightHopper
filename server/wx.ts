// server/wx.ts
// GET /api/wx/metar?bbox=south,west,north,east and GET /api/wx/sigmet: aviationweather.gov through this server (it
// sends no CORS headers), slimmed (shared/wx.ts) and kept a few minutes, so every client and every pan in the same
// whole-degree box costs one upstream request per TTL. A failing upstream serves the last good answer, else throws.
// GET /api/wx/model?lat&lon: Open-Meteo's forecast (weather data by Open-Meteo.com, CC BY 4.0, keyless, non-commercial use) for a
// grid of 7 × 7 places 0.25° apart round the 0.5° cell that holds lat, lon, the current hour: one request for the 49 places, kept
// 30 min, so every client in the same cell shares it. Open-Meteo weighs a request by its places and variables
// (https://open-meteo.com/en/pricing, checked 2026-10-03: free up to 600 calls a minute, 5,000 an hour and 10,000 a day): a grid of
// 49 places with 32 variables is an estimated 49 × 3.2 = 157 calls, about 60 grids a day.
import { MODEL_VARIABLES, slimMetars, slimModel, slimSigmets, type Metar, type ModelGeo, type ModelGrid, type Sigmet } from '../shared/wx.ts'

const API = 'https://aviationweather.gov/api/data'
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast'
const METAR_TTL_MS = 5 * 60_000 // METARs come every 30–60 min; SPECIs sooner
const SIGMET_TTL_MS = 10 * 60_000
const MODEL_TTL_MS = 30 * 60_000 // the model's values are hourly
const MODEL_CELL_DEG = 0.5 // lat, lon snap to a cell this wide
const MODEL_STEP_DEG = 0.25
const MODEL_N = 7
const MAX_SPAN_DEG = 40 // wider views get no stations (thousands of dots, megabytes of JSON)
const MAX_ENTRIES = 200 // ponytail: evicts the oldest past this; plenty for one user's pans

export class WxError extends Error {
  readonly status: 400 | 502
  constructor(message: string, status: 400 | 502) {
    super(message)
    this.status = status
  }
}

/** bbox=s,w,n,e → whole degrees outward, or a WxError saying why not. */
export function parseBbox(v: string | null): [number, number, number, number] {
  const n = (v ?? '').split(',').map((x) => (x.trim() === '' ? NaN : Number(x)))
  if (n.length !== 4 || !n.every(Number.isFinite)) throw new WxError('bbox must be south,west,north,east', 400)
  const [s, w, no, e] = [Math.floor(n[0]), Math.floor(n[1]), Math.ceil(n[2]), Math.ceil(n[3])]
  if (s < -90 || no > 90 || w < -180 || e > 180 || s >= no || w >= e) throw new WxError('bbox out of range', 400)
  if (no - s > MAX_SPAN_DEG || e - w > MAX_SPAN_DEG) throw new WxError(`bbox wider than ${MAX_SPAN_DEG}°`, 400)
  return [s, w, no, e]
}

/** A longitude within −180 … 180, 180 itself as −180: what Open-Meteo takes. */
const wrap = (lon: number): number => ((((lon + 180) % 360) + 360) % 360) - 180

/**
 * The model grid for a place: the 0.5° cell that holds it, a 7 × 7 grid of places 0.25° apart centred on that cell's middle (so
 * every place of a grid is a multiple of 0.25°, and grids of cells next to each other share places). Near a pole the grid is
 * moved to end at it; across the antimeridian it runs on past 180. A WxError (400) for anything but a place.
 */
export function modelGeo(lat: string | null, lon: string | null): ModelGeo {
  const [la, lo] = [lat, lon].map((x) => (x === null || x.trim() === '' ? NaN : Number(x)))
  if (!(Math.abs(la) <= 90 && Math.abs(lo) <= 180)) throw new WxError('lat and lon must be degrees', 400) // NaN fails both
  const middle = (v: number): number => (Math.floor(v / MODEL_CELL_DEG) + 0.5) * MODEL_CELL_DEG
  const half = ((MODEL_N - 1) / 2) * MODEL_STEP_DEG
  const south = Math.min(90 - half, Math.max(-90 + half, middle(la))) - half
  return { lat0: south, lon0: wrap(middle(lo) - half), step: MODEL_STEP_DEG, n: MODEL_N }
}

/** Open-Meteo's request for a grid: the places row by row (longitudes within −180 … 180), the current hour only, the wind in knots. */
export function modelUrl(geo: ModelGeo): string {
  const lats: number[] = []
  const lons: number[] = []
  for (let i = 0; i < geo.n; i++) {
    for (let j = 0; j < geo.n; j++) {
      lats.push(geo.lat0 + i * geo.step)
      lons.push(wrap(geo.lon0 + j * geo.step))
    }
  }
  return `${OPEN_METEO}?latitude=${lats.join(',')}&longitude=${lons.join(',')}&hourly=${MODEL_VARIABLES.join(',')}&wind_speed_unit=kn&forecast_hours=1&timeformat=unixtime`
}

export function makeWx(o: { userAgent: string; fetchFn?: typeof fetch; nowMs?: () => number }) {
  const fetchFn = o.fetchFn ?? fetch
  const nowMs = o.nowMs ?? Date.now
  const cache = new Map<string, { ms: number; body: unknown }>()
  const pending = new Map<string, Promise<unknown>>()

  async function cached<T>(url: string, ttlMs: number, slim: (json: unknown) => T): Promise<T> {
    const hit = cache.get(url)
    if (hit && nowMs() - hit.ms < ttlMs) return hit.body as T
    const inFlight = pending.get(url)
    if (inFlight) return inFlight as Promise<T>
    const p = (async () => {
      try {
        const r = await fetchFn(url, { headers: { 'user-agent': o.userAgent }, signal: AbortSignal.timeout(15_000) })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const body = slim(r.status === 204 ? [] : await r.json()) // 204: nothing reported in the box
        cache.delete(url) // re-inserted last: Map order is age order
        cache.set(url, { ms: nowMs(), body })
        if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!)
        return body
      } catch (e) {
        if (hit) return hit.body as T
        throw new WxError(`${new URL(url).hostname}: ${(e as Error).message}`, 502)
      } finally {
        pending.delete(url)
      }
    })()
    pending.set(url, p)
    return p
  }

  return {
    metars(bbox: string | null): Promise<Metar[]> {
      return cached(`${API}/metar?bbox=${parseBbox(bbox).join(',')}&format=json`, METAR_TTL_MS, slimMetars)
    },
    sigmets(): Promise<Sigmet[]> {
      return cached(`${API}/isigmet?format=geojson`, SIGMET_TTL_MS, slimSigmets)
    },
    model(lat: string | null, lon: string | null): Promise<ModelGrid> {
      const geo = modelGeo(lat, lon)
      return cached(modelUrl(geo), MODEL_TTL_MS, (json) => slimModel(json, geo))
    },
  }
}

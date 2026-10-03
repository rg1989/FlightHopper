// server/wx.ts
// GET /api/wx/metar?bbox=south,west,north,east and GET /api/wx/sigmet: aviationweather.gov through this server (it
// sends no CORS headers), slimmed (shared/wx.ts) and kept a few minutes, so every client and every pan in the same
// whole-degree box costs one upstream request per TTL. A failing upstream serves the last good answer, else throws.
// GET /api/wx/model?lat&lon: Open-Meteo's forecast (weather data by Open-Meteo.com, CC BY 4.0, keyless, non-commercial use) for a
// grid of 7 × 7 places 0.25° apart round the 0.5° cell that holds lat, lon, the current hour. Each place is fetched and kept on its
// own (30 min fresh, 2 h held), so the grids of cells next to each other share places and a grid asks Open-Meteo, in one request,
// only for the places it lacks: 14 of 49 for the cell next to one held. Open-Meteo weighs a request by its places and variables
// (https://open-meteo.com/en/pricing, checked 2026-10-03: free up to 600 calls a minute, 5,000 an hour and 10,000 a day): a place
// with 32 variables is 3.2 calls, so 8,000 a UTC day (the most this server asks) is 2,500 places. Past that, within 20 s of the last
// request, or within 60 s of a failure, it is not asked: the places held are served as they are, a grid that lacks one is a 503
// with Retry-After.
// ponytail: the day's count is in memory (a restart forgets it) and counts only what this server asks: other users of the same
// address share the allowance unseen. A jet at 450 kt crosses a cell about every 4 min and needs 14 to 24 new places for it, so
// 8,000 calls last 6 to 12 h of one chase. Upgrade: keep the count in a file; fetch the cell ahead; a key and a paid plan.
import { MODEL_VARIABLES, assembleModel, slimMetars, slimPlaces, slimSigmets, type Metar, type ModelGeo, type ModelGrid, type ModelPlace, type Sigmet } from '../shared/wx.ts'

const API = 'https://aviationweather.gov/api/data'
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast'
const METAR_TTL_MS = 5 * 60_000 // METARs come every 30–60 min; SPECIs sooner
const SIGMET_TTL_MS = 10 * 60_000
const MODEL_CELL_DEG = 0.5 // lat, lon snap to a cell this wide
const MODEL_STEP_DEG = 0.25
const MODEL_N = 7
const DAY_MS = 86_400_000
/** What the model's places are kept for and what Open-Meteo may be asked (the budget guard): see the header. */
export const MODEL_LIMITS = {
  freshMs: 30 * 60_000, // a place is as good as new this long (the model's values are hourly)
  keepMs: 2 * 60 * 60_000, // and held this long, to serve when Open-Meteo is not asked: the client drops a grid whose hour is 3 h old, and a place's hour is up to an hour older than when it was fetched
  dailyCalls: 8_000, // weighted calls a UTC day, of the free 10,000
  callsPerPlace: Math.max(1, MODEL_VARIABLES.length / 10) * Math.max(1, 1 / 24 / 14), // Open-Meteo's weight of a place: a call for each 10 variables, and for each 14 days (an hour is never more than one)
  gapMs: 20_000, // at least this between requests to Open-Meteo for the model
  failureMs: 60_000, // after a failure it is not asked for this long
} as const
const MAX_SPAN_DEG = 40 // wider views get no stations (thousands of dots, megabytes of JSON)
const MAX_ENTRIES = 200 // ponytail: evicts the oldest past this; plenty for one user's pans

export class WxError extends Error {
  readonly status: 400 | 502 | 503
  readonly retryAfterS: number | undefined // a 503's Retry-After: when what stops the ask will have gone
  constructor(message: string, status: 400 | 502 | 503, retryAfterS?: number) {
    super(message)
    this.status = status
    this.retryAfterS = retryAfterS
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

/** A place of a model grid: where it stands (longitudes within −180 … 180) and its key, the same for every grid that holds it. */
export interface ModelPlaceAt {
  lat: number
  lon: number
  key: string
}

/** The places of a grid, row by row from its south-west: the same lattice point is the same place (and key) in every grid. */
export function modelPlaces(geo: ModelGeo): ModelPlaceAt[] {
  const out: ModelPlaceAt[] = []
  for (let i = 0; i < geo.n; i++) {
    for (let j = 0; j < geo.n; j++) {
      const lat = geo.lat0 + i * geo.step
      const lon = wrap(geo.lon0 + j * geo.step)
      out.push({ lat, lon, key: `${lat},${lon}` })
    }
  }
  return out
}

/** Open-Meteo's request for these places (the answer comes in this order): the current hour only, the wind in knots. */
export function modelUrl(places: readonly { lat: number; lon: number }[]): string {
  return `${OPEN_METEO}?latitude=${places.map((p) => p.lat).join(',')}&longitude=${places.map((p) => p.lon).join(',')}&hourly=${MODEL_VARIABLES.join(',')}&wind_speed_unit=kn&forecast_hours=1&timeformat=unixtime`
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

  // ---- the model: places kept one by one, asked for under a budget ----
  const places = new Map<string, { ms: number; place: ModelPlace }>() // by key, the oldest fetched first (a place fetched again is moved to the end)
  const host = new URL(OPEN_METEO).hostname
  const day = { n: -1, calls: 0 } // the UTC day and the calls asked in it
  let lastAskMs = -Infinity // the last request to Open-Meteo for the model
  let failedUntilMs = 0
  let flight: Promise<WxError | null> = Promise.resolve(null) // requests for the model go one at a time: one that waits then finds what the one before it fetched

  /** The place if it is held (not older than keepMs); the places that are older are dropped (the oldest come first). */
  function held(key: string, now: number): { ms: number; place: ModelPlace } | undefined {
    for (const [k, h] of places) {
      if (now - h.ms < MODEL_LIMITS.keepMs) break
      places.delete(k)
    }
    const h = places.get(key)
    return h !== undefined && now - h.ms < MODEL_LIMITS.keepMs ? h : undefined
  }
  const isFresh = (h: { ms: number } | undefined, now: number): boolean => h !== undefined && now - h.ms < MODEL_LIMITS.freshMs

  /** Why Open-Meteo may not be asked for this many places now, or null. */
  function blocked(now: number, count: number): WxError | null {
    const today = Math.floor(now / DAY_MS)
    if (day.n !== today) [day.n, day.calls] = [today, 0]
    if (day.calls + count * MODEL_LIMITS.callsPerPlace > MODEL_LIMITS.dailyCalls) {
      return new WxError(`${host}: the day's allowance of calls (${MODEL_LIMITS.dailyCalls}) is used; not asked again before the day turns`, 503, Math.ceil(((today + 1) * DAY_MS - now) / 1000))
    }
    if (now < failedUntilMs) {
      const s = Math.ceil((failedUntilMs - now) / 1000)
      return new WxError(`${host}: the last request failed; not asked again for ${s} s`, 503, s)
    }
    if (now - lastAskMs < MODEL_LIMITS.gapMs) {
      const s = Math.ceil((lastAskMs + MODEL_LIMITS.gapMs - now) / 1000)
      return new WxError(`${host}: asked less than ${MODEL_LIMITS.gapMs / 1000} s ago; not asked again for ${s} s`, 503, s)
    }
    return null
  }

  /** Asks Open-Meteo, in one request, for the places of `wanted` that are not fresh; null when it did or none was needed, else why it did not. */
  async function fetchLacking(wanted: readonly ModelPlaceAt[]): Promise<WxError | null> {
    const now = nowMs()
    const lacking = wanted.filter((p) => !isFresh(held(p.key, now), now))
    if (lacking.length === 0) return null
    const why = blocked(now, lacking.length)
    if (why !== null) return why
    lastAskMs = now
    day.calls += lacking.length * MODEL_LIMITS.callsPerPlace // counted when asked: a request that fails may be counted upstream too
    try {
      const r = await fetchFn(modelUrl(lacking), { headers: { 'user-agent': o.userAgent }, signal: AbortSignal.timeout(15_000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const got = slimPlaces(await r.json(), lacking.length)
      const at = nowMs()
      lacking.forEach((p, i) => {
        places.delete(p.key)
        places.set(p.key, { ms: at, place: got[i] })
      })
      failedUntilMs = 0
      return null
    } catch (e) {
      failedUntilMs = nowMs() + MODEL_LIMITS.failureMs
      return new WxError(`${host}: ${(e as Error).message}`, 502)
    }
  }

  /** The grid of geo from the places held, fetching those it lacks first; a grid that lacks one still is the error that stopped the ask (never a grid with holes). */
  async function modelGrid(geo: ModelGeo, wanted: readonly ModelPlaceAt[]): Promise<ModelGrid> {
    let why: WxError | null = null
    const before = nowMs()
    if (wanted.some((p) => !isFresh(held(p.key, before), before))) {
      const run = flight.then(() => fetchLacking(wanted))
      flight = run
      why = await run
    }
    const now = nowMs()
    const got = wanted.map((p) => held(p.key, now))
    if (got.some((h) => h === undefined)) throw why ?? new WxError(`${host}: no forecast held for this place`, 502)
    return assembleModel(geo, got.map((h) => h!.place))
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
      return modelGrid(geo, modelPlaces(geo))
    },
  }
}

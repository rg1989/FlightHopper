// server/adsbdb.ts
// The route of one callsign at a time from adsbdb.com (free, no key): GET /v0/callsign/{callsign}
//   200 → {"response": {"flightroute": {callsign, origin: {icao_code, iata_code, latitude, longitude, …}, destination: {…},
//          midpoint?: {…}}}}   404 → {"response": "unknown callsign"}
// Checked with one real request (2026-09-30, ITY810 → LIRF-LLBG). Used for the selected and recorded aircraft only
// (server/main.ts), since adsb.lol's routeset began answering 201 with an empty body (2026-09-30).
import type { RoutePlace } from '../shared/info.ts'
import type { TokenBucket } from './budget.ts'
import type { InfoStore } from './infoStore.ts'
import { parseRetryAfter } from './sources/http.ts'

export const ADSBDB_URL = 'https://api.adsbdb.com/v0/callsign/'
const TIMEOUT_MS = 10_000

function place(v: unknown): RoutePlace | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  const code = [o.icao_code, o.iata_code].find((c): c is string => typeof c === 'string' && /^[A-Z0-9]{3,4}$/.test(c))
  const lat = o.latitude
  const lon = o.longitude
  if (code === undefined || typeof lat !== 'number' || typeof lon !== 'number' || !(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null
  return { code, lat, lon }
}

/** An adsbdb answer → its airports in flying order (origin, midpoint when there is one, destination); null: no route. */
export function parseAdsbdb(body: unknown): RoutePlace[] | null {
  const r = (body as { response?: { flightroute?: Record<string, unknown> } } | null)?.response?.flightroute
  if (typeof r !== 'object' || r === null) return null
  const places = [r.origin, r.midpoint, r.destination].map(place)
  const [from, , to] = places
  if (from === null || to === null) return null
  return places.filter((p): p is RoutePlace => p !== null)
}

/**
 * Looks up the route of one callsign per tick (the InfoStore's needRoutes, limited to `only`), at most one request per
 * minIntervalMs and only with a token from its bucket. A route is cached as "LIRF-LLBG" with its airports' positions; a
 * 404 caches a miss; anything else (network, 429, 5xx) caches nothing and goes to the bucket.
 */
export class AdsbdbRoutes {
  #bucket: TokenBucket
  #userAgent: string
  #now: () => number
  #fetch: typeof fetch
  #minIntervalMs: number
  #lastReqMs = -Infinity
  #busy = false

  constructor(opts: { bucket: TokenBucket; userAgent: string; nowMs?: () => number; fetchFn?: typeof fetch; minIntervalMs?: number }) {
    this.#bucket = opts.bucket
    this.#userAgent = opts.userAgent
    this.#now = opts.nowMs ?? Date.now
    this.#fetch = opts.fetchFn ?? ((input, init) => fetch(input, init))
    this.#minIntervalMs = opts.minIntervalMs ?? 5000
  }

  async tick(store: InfoStore, only?: ReadonlySet<string>): Promise<boolean> {
    if (this.#busy || this.#now() - this.#lastReqMs < this.#minIntervalMs) return false
    const [plane] = store.needRoutes(1, only)
    if (plane === undefined || !this.#bucket.tryTake()) return false
    this.#busy = true
    this.#lastReqMs = this.#now()
    try {
      let status = 0
      let retryAfterS: number | null = null
      let body: unknown = null
      try {
        const res = await this.#fetch(ADSBDB_URL + encodeURIComponent(plane.callsign), {
          headers: { 'User-Agent': this.#userAgent, Accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        status = res.status
        retryAfterS = parseRetryAfter(res.headers.get('retry-after'), res.headers.get('date'), this.#now())
        body = await res.json().catch(() => null)
      } catch {
        // network error or timeout: status 0
      }
      // A 404 is the answer "no such route", not a failure: the bucket hears 200 so it does not back off.
      this.#bucket.onResult(status === 404 ? 200 : status, retryAfterS)
      const places = status === 200 ? parseAdsbdb(body) : null
      if (status === 200 || status === 404) {
        store.setPlaces(places ?? [])
        store.setRoute(plane.callsign, places === null ? null : places.map((p) => p.code).join('-'))
      }
      return true
    } finally {
      this.#busy = false
    }
  }
}

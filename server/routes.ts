// server/routes.ts
// Flight routes (origin → destination airports) for the browse table and detail panel, from adsb.lol's batched routeset.
// Shape verified against github.com/adsblol/api @ 3c969c8 (2026-06-03): src/adsb_api/utils/api_routes.py `api_routeset`
// and provider.py `_route` (route data: vradarserver/standing-data):
//   POST /api/0/routeset  {"planes": [{"callsign", "lat", "lng"}]}   1..100 planes, else 400
//   200 → JSON array, one object per distinct callsign:
//     { callsign, airport_codes: "LROP-OTHH" | "unknown", _airport_codes_iata: "OTP-DOH", _airports: [{ icao, iata, … }],
//       plausible?: boolean, number?, airline_code? }
// Never called unless ADSB_SOURCE=adsblol and ROUTES=1 (server/main.ts); tests use a fake fetch.
import type { RouteInfo } from '../shared/info.ts'
import type { TokenBucket } from './budget.ts'
import type { InfoStore } from './infoStore.ts'
import { parseRetryAfter } from './sources/http.ts'

export const ROUTESET_URL = 'https://api.adsb.lol/api/0/routeset'
/** The upstream answers 400 above 100 planes. */
export const MAX_PLANES = 100
const DEFAULT_MIN_INTERVAL_MS = 60_000
const TIMEOUT_MS = 10_000
const AIRPORT = /^[A-Z0-9]{3,4}$/

/** "LROP-OTHH" → itself (upper-cased); "unknown", one airport or anything that is not airport codes → null. */
function airportCodes(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const codes = v.trim().toUpperCase().split('-')
  return codes.length >= 2 && codes.every((c) => AIRPORT.test(c)) ? codes.join('-') : null
}

/**
 * A routeset answer → one RouteInfo per item with known airports: ICAO `airport_codes` first, then a hypothetical
 * `_airport_codes`, then `_airport_codes_iata`. Only `plausible: false` marks a route implausible. Malformed items
 * are skipped. null when the body is not an array (not a routeset answer at all).
 */
export function parseRouteset(body: unknown): RouteInfo[] | null {
  if (!Array.isArray(body)) return null
  const out: RouteInfo[] = []
  for (const item of body) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    const callsign = typeof o.callsign === 'string' ? o.callsign.trim() : ''
    const route = airportCodes(o.airport_codes) ?? airportCodes(o._airport_codes) ?? airportCodes(o._airport_codes_iata)
    if (callsign === '' || route === null) continue
    out.push({ callsign, route, plausible: o.plausible !== false })
  }
  return out
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000

/**
 * Asks adsb.lol for the routes of the callsigns the InfoStore lacks: one POST of ≤ 100 callsigns at most every
 * minIntervalMs, only with a token from the poller's bucket, and every answer reported back to that bucket.
 * A route is cached 6 h and a miss (unknown or implausible) 1 h, in the InfoStore. A failed request caches nothing.
 */
export class RouteFetcher {
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
    this.#minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  }

  /** At most one request. Returns whether one was sent. Overlapping calls return false at once. */
  async tick(store: InfoStore): Promise<boolean> {
    if (this.#busy || this.#now() - this.#lastReqMs < this.#minIntervalMs) return false
    const planes = store.needRoutes(MAX_PLANES)
    if (planes.length === 0 || !this.#bucket.tryTake()) return false
    this.#busy = true
    this.#lastReqMs = this.#now()
    try {
      const r = await this.#post(planes.map((p) => ({ callsign: p.callsign, lat: round3(p.lat), lng: round3(p.lon) })))
      this.#bucket.onResult(r.status, r.retryAfterS)
      const routes = r.status === 200 ? parseRouteset(r.body) : null
      if (routes === null) return true
      const found = new Map<string, string>()
      for (const x of routes) if (x.plausible) found.set(x.callsign, x.route)
      // ponytail: an implausible route (flown on another leg today) counts as a miss; retried after an hour.
      for (const p of planes) store.setRoute(p.callsign, found.get(p.callsign) ?? null)
      return true
    } finally {
      this.#busy = false
    }
  }

  /** One POST that never throws: a network error or timeout comes back as status 0. */
  async #post(planes: { callsign: string; lat: number; lng: number }[]): Promise<{ status: number; retryAfterS: number | null; body: unknown }> {
    try {
      const res = await this.#fetch(ROUTESET_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip', 'User-Agent': this.#userAgent },
        body: JSON.stringify({ planes }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const text = await res.text()
      let body: unknown = null
      try {
        body = JSON.parse(text)
      } catch {
        // a 200 that is not JSON (a proxy error page): no routes, nothing cached
      }
      return { status: res.status, retryAfterS: parseRetryAfter(res.headers.get('retry-after'), res.headers.get('date'), this.#now()), body }
    } catch {
      return { status: 0, retryAfterS: null, body: null }
    }
  }
}

// server/infoStore.ts
// Per aircraft: the newest full upstream object (for the detail panel) and its AircraftInfo (for the table), with the
// server-clock time the info last changed. Plus the route cache (callsign → route) that RouteFetcher fills.
import { sameInfo, toInfo, type AircraftInfo } from '../shared/info.ts'
import type { ReadsbAircraft } from '../shared/types.ts'

/** A known route is asked again after 6 h, a miss (the upstream has none) after 1 h. */
export const ROUTE_TTL_MS = 6 * 3_600_000
export const MISS_TTL_MS = 3_600_000

// Route databases know airline flights only: an ICAO airline designator + a flight number (UAL872, EZY84AB).
// ponytail: registrations and military/GA callsigns are never asked; a few non-airline ones (OPS12 ground vehicles)
// still match and cost one negative-cache slot for an hour.
const AIRLINE_CALLSIGN = /^[A-Z]{3}[0-9][0-9A-Z]{0,4}$/

interface Entry {
  raw: ReadsbAircraft
  rxMs: number // server clock of the answer raw came from
  info: AircraftInfo
  changedMs: number // server clock when info last changed
}

interface CachedRoute {
  route: string | null // null = the upstream has no (plausible) route: negative cache
  expiresMs: number
}

export class InfoStore {
  #now: () => number
  #byHex = new Map<string, Entry>()
  #routes = new Map<string, CachedRoute>()

  /** nowMs is the server clock (setRoute's change time, route expiry). */
  constructor(opts: { nowMs?: () => number } = {}) {
    this.#now = opts.nowMs ?? Date.now
  }

  /** One upstream aircraft object received at rxMs (server clock). An object older than the stored one is ignored. */
  update(ac: ReadsbAircraft, rxMs: number): void {
    const hex = ac.hex.toLowerCase()
    const e = this.#byHex.get(hex)
    if (e && rxMs < e.rxMs) return
    const callsign = typeof ac.flight === 'string' ? ac.flight.trim() : ''
    const info = toInfo(ac, this.#routes.get(callsign)?.route ?? null)
    if (!e) {
      this.#byHex.set(hex, { raw: ac, rxMs, info, changedMs: rxMs })
      return
    }
    e.raw = ac
    e.rxMs = rxMs
    if (!sameInfo(e.info, info)) {
      e.info = info
      e.changedMs = rxMs
    }
  }

  /** Infos of these hexes that changed after sinceRxMs; every one of them when sinceRxMs ≤ 0. Pass each hex once. */
  since(hexes: Iterable<string>, sinceRxMs: number): AircraftInfo[] {
    const out: AircraftInfo[] = []
    for (const hex of hexes) {
      const e = this.#byHex.get(hex.toLowerCase())
      if (e && (sinceRxMs <= 0 || e.changedMs > sinceRxMs)) out.push(e.info)
    }
    return out
  }

  /** Server-clock time this hex's info last changed (first seen, identity change or route). */
  changedMs(hex: string): number | null {
    return this.#byHex.get(hex.toLowerCase())?.changedMs ?? null
  }

  get(hex: string): AircraftInfo | null {
    return this.#byHex.get(hex.toLowerCase())?.info ?? null
  }

  /** The newest full upstream object, as received (its seen / seen_pos count from rxMs(hex)). */
  raw(hex: string): ReadsbAircraft | null {
    return this.#byHex.get(hex.toLowerCase())?.raw ?? null
  }

  /** Server-clock receive time of raw(hex). */
  rxMs(hex: string): number | null {
    return this.#byHex.get(hex.toLowerCase())?.rxMs ?? null
  }

  /**
   * Caches a route (null = none) for this callsign and puts it into the info of every aircraft flying it. The change
   * is stamped now, but always after the aircraft's newest answer, so "changed after the client's last sample of it"
   * holds even when both fall in the same millisecond.
   */
  setRoute(callsign: string, route: string | null): void {
    const cs = callsign.trim()
    const now = this.#now()
    this.#routes.set(cs, { route, expiresMs: now + (route === null ? MISS_TTL_MS : ROUTE_TTL_MS) })
    // ponytail: a scan of every aircraft per callsign; ≤ 100 callsigns a minute × 5,000 aircraft is ~1 ms.
    for (const e of this.#byHex.values()) {
      if (e.info.callsign !== cs || e.info.route === route) continue
      e.info = { ...e.info, route }
      e.changedMs = Math.max(now, e.rxMs + 1)
    }
  }

  /**
   * Up to max airline callsigns (with the aircraft's position) that have no fresh cached answer:
   * never-asked ones first, then expired ones. Each callsign once.
   */
  needRoutes(max: number): { callsign: string; lat: number; lon: number }[] {
    const now = this.#now()
    const fresh: { callsign: string; lat: number; lon: number }[] = []
    const stale: { callsign: string; lat: number; lon: number }[] = []
    const seen = new Set<string>()
    for (const e of this.#byHex.values()) {
      if (fresh.length >= max) break
      const cs = e.info.callsign
      const { lat, lon } = e.raw
      if (cs === null || seen.has(cs) || !AIRLINE_CALLSIGN.test(cs)) continue
      if (typeof lat !== 'number' || typeof lon !== 'number') continue
      const cached = this.#routes.get(cs)
      if (cached && cached.expiresMs > now) continue
      seen.add(cs)
      ;(cached ? stale : fresh).push({ callsign: cs, lat, lon })
    }
    return fresh.concat(stale).slice(0, Math.max(0, max))
  }

  /**
   * Forgets aircraft not updated within horizonMs. An expired route stays (and is still shown) until it is fetched
   * again, but is forgotten ROUTE_TTL_MS after it expired, so the cache cannot grow without bound.
   */
  prune(nowMs: number, horizonMs: number): void {
    const cutoff = nowMs - horizonMs
    for (const [hex, e] of this.#byHex) if (e.rxMs < cutoff) this.#byHex.delete(hex)
    for (const [cs, r] of this.#routes) if (r.expiresMs + ROUTE_TTL_MS < nowMs) this.#routes.delete(cs)
  }

  /** Number of aircraft held. */
  get size(): number {
    return this.#byHex.size
  }
}

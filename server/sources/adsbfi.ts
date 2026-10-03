// server/sources/adsbfi.ts
// adsb.fi open data as a Source (github.com/adsbfi/opendata): /api/v3/lat/{lat}/lon/{lon}/dist/{nm} (≤ 250 nm),
// /api/v2/hex/{hex} and /api/v2/sqk/{code}. Same envelope as adsb.lol ({ ac, msg, now (ms), total }), checked with one
// real request per endpoint (data/fixtures/golden/adsbfi-*.json; sqk: an empty answer, 2026-10-03). Terms: personal,
// non-commercial use; cite adsb.fi with a link; public endpoints 1 request/s, and 400/404/429 answers can get the IP
// restricted, so the bucket paces with burst 1.
import { normalizeAdsblol } from '../../shared/readsb.ts'
import { fetchSnapshot } from './http.ts'
import type { FetchResult, Source } from './types.ts'

export const ADSBFI_BASE = 'https://opendata.adsb.fi/api'
const MAX_RADIUS_NM = 250

/** An answer for a request never sent (it could answer 400 or 404, which count toward adsb.fi's IP restriction). */
function notAsked(msg: string): FetchResult {
  const now = Date.now()
  const body = JSON.stringify({ ac: [], msg, now, total: 0 })
  return { url: 'adsbfi:not-asked', status: 200, tSendMs: now, tRecvMs: now, bytes: 0, body, retryAfterS: null, snapshot: { nowMs: now, aircraft: [] } }
}

export function makeAdsbfi(opts: { userAgent: string; baseUrl?: string; timeoutMs?: number }): Source {
  const base = (opts.baseUrl ?? ADSBFI_BASE).replace(/\/+$/, '')
  const get = (path: string) => fetchSnapshot(base + path, normalizeAdsblol, { userAgent: opts.userAgent, timeoutMs: opts.timeoutMs })
  return {
    caps: { kind: 'adsbfi', fullSnapshot: false, maxRps: 1, burst: 1, coverage: null, attribution: 'adsb.fi (personal, non-commercial use)' },
    async circle(lat, lon, radiusNm) {
      const nm = Math.max(1, Math.min(MAX_RADIUS_NM, Math.round(radiusNm)))
      return get(`/v3/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${nm}`)
    },
    // ponytail: one hex per request (the docs show no batch form); one person's app chases one aircraft. The poller
    // only asks when the view circle has not delivered the chased aircraft lately. Non-ICAO addresses ('~…', TIS-B and
    // the like) are never sent: the route takes ICAO addresses, and a 400/404 can get the IP restricted. They are
    // answered here as not found (the poller then waits 30 s), and the view circle still carries them.
    async hexes(hexes) {
      const hex = hexes.find((h) => /^[0-9a-f]{6}$/i.test(h))
      return hex === undefined ? notAsked('not asked: no ICAO address') : get(`/v2/hex/${hex}`)
    },
    // Every aircraft on one squawk, worldwide (/v2/sqk/{code}, the alerts' sweep: server/alerts.ts). A code that is not four
    // octal digits is not sent. An empty answer is a 200 (checked 2026-10-03: {"ac":[],"msg":"No error","now":…,"total":0}).
    async squawk(code) {
      return /^[0-7]{4}$/.test(code) ? get(`/v2/sqk/${code}`) : notAsked('not asked: not a squawk')
    },
    async all() {
      throw new Error('unsupported')
    },
  }
}

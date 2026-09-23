// server/sources/adsbfi.ts
// adsb.fi open data as a Source (github.com/adsbfi/opendata): /api/v3/lat/{lat}/lon/{lon}/dist/{nm} (≤ 250 nm) and
// /api/v2/hex/{hex}. Same envelope as adsb.lol ({ ac, msg, now (ms), total }), checked with one real request per
// endpoint (data/fixtures/golden/adsbfi-*.json). Terms: personal, non-commercial use; cite adsb.fi with a link;
// public endpoints 1 request/s, and 400/404/429 answers can get the IP restricted, so the bucket paces with burst 1.
import { normalizeAdsblol } from '../../shared/readsb.ts'
import { fetchSnapshot } from './http.ts'
import type { Source } from './types.ts'

export const ADSBFI_BASE = 'https://opendata.adsb.fi/api'
const MAX_RADIUS_NM = 250

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
    // only asks when the view circle has not delivered the chased aircraft lately.
    async hexes(hexes) {
      return get(`/v2/hex/${encodeURIComponent(hexes[0] ?? '')}`)
    },
    async all() {
      throw new Error('unsupported')
    },
  }
}

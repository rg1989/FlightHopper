// server/sources/readsb.ts
// Your own receiver as a Source: readsb --net-api-port. Query syntax from github.com/wiedehopf/readsb README-json.md:
// /?circle=<lat>,<lon>,<radius nmi>, /?find_hex=<hex>,<hex>,… (limited to 1000), /?all_with_pos. Envelope: now in seconds.
import { normalizeReadsb } from '../../shared/readsb.ts'
import { fetchSnapshot, hexList } from './http.ts'
import type { Source } from './types.ts'

const MAX_HEXES = 1000

export function makeReadsb(opts: { baseUrl: string; coverage: { lat: number; lon: number; radiusNm: number }; timeoutMs?: number }): Source {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const get = (query: string) => fetchSnapshot(`${base}/?${query}`, normalizeReadsb, { timeoutMs: opts.timeoutMs })
  return {
    caps: { kind: 'readsb', fullSnapshot: true, maxRps: 5, coverage: opts.coverage, attribution: 'own receiver (readsb)' },
    async circle(lat, lon, radiusNm) {
      return get(`circle=${lat.toFixed(4)},${lon.toFixed(4)},${Math.round(radiusNm)}`)
    },
    async hexes(hexes) {
      return get(`find_hex=${hexList(hexes, MAX_HEXES)}`)
    },
    async all() {
      return get('all_with_pos')
    },
  }
}

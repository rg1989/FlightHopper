import type { Snapshot, SourceKind } from '../../shared/types.ts'

export interface SourceCaps {
  kind: SourceKind
  fullSnapshot: boolean                    // true: all() returns everything the source knows
  maxRps: number                           // polite ceiling for this source
  coverage: { lat: number; lon: number; radiusNm: number } | null   // null = global
  attribution: string
}

export interface FetchResult {
  url: string
  status: number                           // HTTP status; 0 = network error / timeout
  tSendMs: number
  tRecvMs: number
  bytes: number                            // wire bytes (content-length when present, else body length)
  body: string                             // raw text, recorded verbatim ('' on error)
  retryAfterS: number | null
  snapshot: Snapshot | null                // non-null only when status 200 and body parsed
}

export interface Source {
  caps: SourceCaps
  circle(lat: number, lon: number, radiusNm: number): Promise<FetchResult>
  hexes(hexes: string[]): Promise<FetchResult>
  all(): Promise<FetchResult>              // rejects with Error('unsupported') when !caps.fullSnapshot
}

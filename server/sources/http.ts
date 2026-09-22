// server/sources/http.ts
import type { Snapshot } from '../../shared/types.ts'
import type { FetchResult } from './types.ts'

export interface FetchOpts {
  userAgent?: string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Retry-After → seconds, or null when absent or unparseable.
 * delay-seconds are used as-is. An HTTP-date is measured against the response's own Date header when there is one
 * (no clock skew), else against nowMs; rounded up, never negative.
 */
export function parseRetryAfter(value: string | null, dateHeader: string | null, nowMs: number): number | null {
  const v = value?.trim() ?? ''
  if (v === '') return null
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v)
  const at = Date.parse(v)
  if (Number.isNaN(at)) return null
  const ref = dateHeader === null ? Number.NaN : Date.parse(dateHeader)
  return Math.max(0, Math.ceil((at - (Number.isNaN(ref) ? nowMs : ref)) / 1000))
}

/**
 * One polite GET. Never throws: network errors, timeouts and body-read failures come back as status 0 with an empty body.
 * Any HTTP status (403, 429, 5xx…) is returned as-is with its body. bytes = Content-Length (the wire size, compressed
 * when gzip was used) when present, else the UTF-8 length of the decoded body.
 */
export async function timedFetch(url: string, opts: FetchOpts): Promise<Omit<FetchResult, 'snapshot'>> {
  const headers: Record<string, string> = { 'Accept-Encoding': 'gzip' }
  if (opts.userAgent) headers['User-Agent'] = opts.userAgent
  const tSendMs = Date.now()
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) })
    const body = await res.text()
    const tRecvMs = Date.now()
    const len = res.headers.get('content-length')
    return {
      url,
      status: res.status,
      tSendMs,
      tRecvMs,
      bytes: len !== null && /^\d+$/.test(len) ? Number(len) : Buffer.byteLength(body),
      body,
      retryAfterS: parseRetryAfter(res.headers.get('retry-after'), res.headers.get('date'), tRecvMs),
    }
  } catch {
    return { url, status: 0, tSendMs, tRecvMs: Date.now(), bytes: 0, body: '', retryAfterS: null }
  }
}

/** timedFetch + envelope normalizer. snapshot is null unless status is 200 AND the body normalizes. */
export async function fetchSnapshot(url: string, normalize: (body: string) => Snapshot, opts: FetchOpts): Promise<FetchResult> {
  const r = await timedFetch(url, opts)
  let snapshot: Snapshot | null = null
  if (r.status === 200) {
    try {
      snapshot = normalize(r.body)
    } catch {
      snapshot = null
    }
  }
  return { ...r, snapshot }
}

/** Hex batch for a URL: lowercased, comma-joined. Throws RangeError when empty or longer than max. */
export function hexList(hexes: string[], max: number): string {
  if (hexes.length === 0 || hexes.length > max) throw new RangeError(`need 1..${max} hexes, got ${hexes.length}`)
  return hexes.map((h) => h.toLowerCase()).join(',')
}

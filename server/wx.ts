// server/wx.ts
// GET /api/wx/metar?bbox=south,west,north,east and GET /api/wx/sigmet: aviationweather.gov through this server (it
// sends no CORS headers), slimmed (shared/wx.ts) and kept a few minutes, so every client and every pan in the same
// whole-degree box costs one upstream request per TTL. A failing upstream serves the last good answer, else throws.
import { slimMetars, slimSigmets, type Metar, type Sigmet } from '../shared/wx.ts'

const API = 'https://aviationweather.gov/api/data'
const METAR_TTL_MS = 5 * 60_000 // METARs come every 30–60 min; SPECIs sooner
const SIGMET_TTL_MS = 10 * 60_000
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
        throw new WxError(`aviationweather.gov: ${(e as Error).message}`, 502)
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
  }
}

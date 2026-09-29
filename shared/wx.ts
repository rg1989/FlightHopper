// shared/wx.ts
// Aviation weather as the server sends it (server/wx.ts) and the top-down map draws it (client/scene/weather.ts): METARs
// cut to what the map shows, and SIGMETs (international, GeoJSON polygons). Upstream: aviationweather.gov Data API
// (https://aviationweather.gov/data/api/, checked 2026-09-30): JSON, no key, no CORS (hence the server), 100 req/min.

export type FlightCategory = 'VFR' | 'MVFR' | 'IFR' | 'LIFR'

export interface Metar {
  id: string // ICAO
  lat: number
  lon: number
  cat: FlightCategory | null
  wdir: number | null // degrees true the wind blows FROM; null: variable or calm
  wspd: number // kt
  wgst: number | null // gusts, kt
  raw: string
}

export interface Sigmet {
  hazard: string // TS, TURB, ICE, VA, MTW, TC, …
  qualifier: string | null // EMBD, SEV, OBSC, …
  base: number | null // ft
  top: number | null // ft
  until: string // ISO
  raw: string
  rings: [number, number][][] // [lon, lat] outer rings
}

const CATS = new Set(['VFR', 'MVFR', 'IFR', 'LIFR'])
const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The Data API's metar JSON → Metar[]; entries without a position are dropped. */
export function slimMetars(json: unknown): Metar[] {
  if (!Array.isArray(json)) return []
  const out: Metar[] = []
  for (const m of json as Record<string, unknown>[]) {
    const lat = fin(m?.lat)
    const lon = fin(m?.lon)
    if (lat === null || lon === null || typeof m.icaoId !== 'string') continue
    out.push({
      id: m.icaoId,
      lat,
      lon,
      cat: CATS.has(m.fltCat as string) ? (m.fltCat as FlightCategory) : null,
      wdir: fin(m.wdir), // "VRB" is a string: null
      wspd: fin(m.wspd) ?? 0,
      wgst: fin(m.wgst),
      raw: typeof m.rawOb === 'string' ? m.rawOb : '',
    })
  }
  return out
}

/** The Data API's isigmet GeoJSON → Sigmet[] (polygons only; a point or line SIGMET has no area to draw). */
export function slimSigmets(json: unknown): Sigmet[] {
  const feats = (json as { features?: unknown } | null)?.features
  if (!Array.isArray(feats)) return []
  const out: Sigmet[] = []
  for (const f of feats as { properties?: Record<string, unknown>; geometry?: { type?: string; coordinates?: unknown } }[]) {
    const g = f?.geometry
    const p = f?.properties ?? {}
    const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? (g.coordinates as unknown[]) : []
    const rings = (polys as unknown[][]).map((poly) => poly?.[0]).filter((r): r is [number, number][] => Array.isArray(r) && r.length >= 3)
    if (rings.length === 0) continue
    out.push({
      hazard: typeof p.hazard === 'string' ? p.hazard : '?',
      qualifier: typeof p.qualifier === 'string' ? p.qualifier : null,
      base: fin(p.base),
      top: fin(p.top),
      until: typeof p.validTimeTo === 'string' ? p.validTimeTo : '',
      raw: typeof p.rawSigmet === 'string' ? p.rawSigmet : '',
      rings,
    })
  }
  return out
}

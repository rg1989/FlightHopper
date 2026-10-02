// shared/wx.ts
// Aviation weather as the server sends it (server/wx.ts) and the top-down map draws it (client/scene/weather.ts): METARs
// cut to what the map and its card show, and SIGMETs (international, GeoJSON polygons). Upstream: aviationweather.gov Data
// API (https://aviationweather.gov/data/api/, checked 2026-10-02): JSON, no key, no CORS (hence the server), 100 req/min.
// It leaves a key out when it has nothing for it (no wgst, wxString, vertVis or clouds), so every field is read warily.

export type FlightCategory = 'VFR' | 'MVFR' | 'IFR' | 'LIFR'

export interface Cloud {
  cover: 'FEW' | 'SCT' | 'BKN' | 'OVC' | 'VV' | string // as the API sends it (a sky hidden by fog is "OVX")
  baseFt: number | null // above the airport
  type: 'CB' | 'TCU' | null // read from the raw report: FEW030CB
}

export interface Metar {
  id: string // ICAO
  name: string | null // "Haifa Intl, HA, IL" as the API sends it
  lat: number
  lon: number
  obsMs: number | null // observation time
  cat: FlightCategory | null
  wdir: number | null // degrees true the wind blows FROM; null: variable or calm
  wspd: number // kt
  wgst: number | null // gusts, kt
  visKm: number | null
  visPlus: boolean // "or more" (9999, 10SM: the API's "6+", "10+")
  tempC: number | null
  dewC: number | null
  qnhHpa: number | null // the API's altim (hPa)
  wx: string | null // the API's wxString: "-RA BR"
  clouds: Cloud[]
  vertVisFt: number | null
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
const KM_PER_MILE = 1.609344

/** The API's visib (statute miles: 4.35, "6+", "1 1/2", "M1/4") as km and whether it is a floor; unreadable → null. */
function readVisibility(v: unknown): { km: number; plus: boolean } | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? { km: v * KM_PER_MILE, plus: false } : null
  if (typeof v !== 'string') return null
  const m = /^M?(?:(\d+(?:\.\d+)?)(?: (\d+)\/(\d+))?|(\d+)\/(\d+))(\+)?$/.exec(v.trim()) // M: "less than", read as the number
  if (m === null) return null
  const miles = m[4] !== undefined ? Number(m[4]) / Number(m[5]) : Number(m[1]) + (m[2] !== undefined ? Number(m[2]) / Number(m[3]) : 0)
  return Number.isFinite(miles) ? { km: miles * KM_PER_MILE, plus: m[6] !== undefined } : null
}

/** The cloud groups with a type in the report's body (FEW033CB, BKN020TCU), by cover and base: "FEW3300" → CB. A trend or a remark is not the observation. */
function cloudTypes(raw: string): Map<string, 'CB' | 'TCU'> {
  const types = new Map<string, 'CB' | 'TCU'>()
  for (const [, cover, hundreds, type] of raw.split(/\b(?:BECMG|TEMPO|RMK)\b/)[0].matchAll(/\b(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)\b/g)) {
    types.set(`${cover}${Number(hundreds) * 100}`, type as 'CB' | 'TCU')
  }
  return types
}

function readClouds(list: unknown, raw: string): Cloud[] {
  if (!Array.isArray(list)) return []
  const types = cloudTypes(raw)
  const out: Cloud[] = []
  for (const c of list as { cover?: unknown; base?: unknown }[]) {
    if (typeof c?.cover !== 'string') continue
    const baseFt = fin(c.base)
    const type = baseFt === null ? null : (types.get(`${c.cover}${Math.round(baseFt / 100) * 100}`) ?? null)
    out.push({ cover: c.cover, baseFt, type })
  }
  return out
}

/** The Data API's metar JSON → Metar[]; entries without a position are dropped. */
export function slimMetars(json: unknown): Metar[] {
  if (!Array.isArray(json)) return []
  const out: Metar[] = []
  for (const m of json as Record<string, unknown>[]) {
    const lat = fin(m?.lat)
    const lon = fin(m?.lon)
    if (lat === null || lon === null || typeof m.icaoId !== 'string') continue
    const raw = typeof m.rawOb === 'string' ? m.rawOb : ''
    const vis = readVisibility(m.visib)
    const obsS = fin(m.obsTime)
    const vv = fin(m.vertVis) // hundreds of feet (VV002 is 2)
    out.push({
      id: m.icaoId,
      name: typeof m.name === 'string' ? m.name : null,
      lat,
      lon,
      obsMs: obsS === null ? null : obsS * 1000,
      cat: CATS.has(m.fltCat as string) ? (m.fltCat as FlightCategory) : null,
      wdir: fin(m.wdir), // "VRB" is a string: null
      wspd: fin(m.wspd) ?? 0,
      wgst: fin(m.wgst),
      visKm: vis?.km ?? null,
      visPlus: vis?.plus ?? false,
      tempC: fin(m.temp),
      dewC: fin(m.dewp),
      qnhHpa: fin(m.altim),
      wx: typeof m.wxString === 'string' && m.wxString.trim() !== '' ? m.wxString.trim() : null,
      clouds: readClouds(m.clouds, raw),
      vertVisFt: vv === null ? null : vv * 100,
      raw,
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

// shared/wx.ts
// Aviation weather as the server sends it (server/wx.ts) and the top-down map draws it (client/scene/weather.ts): METARs
// cut to what the map and its card show, and SIGMETs (international, GeoJSON polygons). Upstream: aviationweather.gov Data
// API (https://aviationweather.gov/data/api/, checked 2026-10-02): JSON, no key, no CORS (hence the server), 100 req/min.
// It leaves a key out when it has nothing for it (no wgst, wxString, vertVis or clouds), so every field is read warily.
// And a weather model's forecast for the chase (client/scene/weather3d.ts): a small grid of places, each with its cloud cover
// and the height of each pressure level, and the wind at some. Upstream: Open-Meteo's forecast API
// (https://open-meteo.com/en/docs, checked 2026-10-03; CC BY 4.0, keyless, non-commercial): asked for many places at once, it
// answers an array of one object per place in the order asked, each with the model's own nearest point (a few km from the
// one asked for), its ground height, and `hourly` arrays of the hours asked for; a value it has none for is null. slimModel cuts
// that to arrays by level. This is a forecast, not an observation: the chase draws it only where no report says otherwise.

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
  elevM: number | null // the station's height above sea level, metres (the API's elev): cloud bases are feet above it
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
      elevM: fin(m.elev),
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

// ---- the model's grid ------------------------------------------------------------------------------------------------------

/** The pressure levels (hPa) the model's cloud cover and level height are asked for, the lowest in the sky first; and those its wind is asked for. */
export const MODEL_CLOUD_HPA: readonly number[] = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200]
export const MODEL_WIND_HPA: readonly number[] = [850, 700, 500, 300, 250, 200]
/** Open-Meteo's `hourly` variables for those levels, in the order they are asked for (the wind in knots: wind_speed_unit=kn). */
export const MODEL_VARIABLES: readonly string[] = [
  ...MODEL_CLOUD_HPA.map((p) => `cloud_cover_${p}hPa`),
  ...MODEL_CLOUD_HPA.map((p) => `geopotential_height_${p}hPa`),
  ...MODEL_WIND_HPA.map((p) => `wind_speed_${p}hPa`),
  ...MODEL_WIND_HPA.map((p) => `wind_direction_${p}hPa`),
]

/** Where a model grid stands: its south-west place (degrees), the spacing, and the places a side: n × n, row by row from the south-west (index = row × n + column; rows go north, columns east). */
export interface ModelGeo {
  lat0: number
  lon0: number // continuous: a grid across the antimeridian runs past 180
  step: number
  n: number
}

/** One pressure level's cloud cover (%) and height (m above sea level, geopotential) at each place; null where the model has none. */
export interface ModelCloudLevel {
  hPa: number
  cover: (number | null)[]
  zM: (number | null)[]
}

/** One pressure level's wind at each place: speed (kt) and the direction it blows from (degrees true). */
export interface ModelWindLevel {
  hPa: number
  kt: (number | null)[]
  deg: (number | null)[]
}

/** The model's forecast of a grid of places for one hour, as the server sends it. */
export interface ModelGrid extends ModelGeo {
  timeMs: number | null // the hour the values are for (the oldest place's: the places of a grid are fetched at different times)
  elevM: (number | null)[] // the model's own ground height at each place, metres above sea level
  clouds: ModelCloudLevel[] // MODEL_CLOUD_HPA's order
  winds: ModelWindLevel[] // MODEL_WIND_HPA's order
}

/**
 * One place of a grid as the server keeps it (a place is fetched and kept on its own: the grids of neighbouring cells share places):
 * what the model says there, by level in MODEL_CLOUD_HPA's and MODEL_WIND_HPA's order; null for what it has none of.
 */
export interface ModelPlace {
  timeMs: number | null // the hour the values are for
  elevM: number | null
  cover: (number | null)[]
  zM: (number | null)[]
  kt: (number | null)[]
  deg: (number | null)[]
}

/**
 * Open-Meteo's answer for `count` places (in the order they were asked) as one ModelPlace each. Many places come as an array of
 * objects, one place as the object itself (or an array of one). Whole percent, metres and degrees, wind to 0.1 kt; a value the model
 * lacks is null. Anything but an object with `hourly` for each place is an error (the caller serves what it holds instead).
 */
export function slimPlaces(json: unknown, count: number): ModelPlace[] {
  const list = count === 1 && !Array.isArray(json) ? [json] : json
  if (!Array.isArray(list) || list.length !== count || !list.every((p) => typeof p === 'object' && p !== null && typeof (p as { hourly?: unknown }).hourly === 'object' && (p as { hourly?: unknown }).hourly !== null)) {
    throw new Error(`expected an object for each of ${count} places`)
  }
  const whole = Math.round
  const tenth = (v: number): number => Math.round(v * 10) / 10
  const compass = (v: number): number => Math.round(v) % 360 // 359.6 is 0
  const round = (v: number | null, f: (v: number) => number): number | null => (v === null ? null : f(v))
  return (list as { elevation?: unknown; hourly: Record<string, unknown> }[]).map((p) => {
    const hour = (name: string): number | null => {
      const values = p.hourly[name]
      return Array.isArray(values) ? fin(values[0]) : null // the one hour asked for
    }
    const time = hour('time')
    return {
      timeMs: time === null ? null : time * 1000,
      elevM: round(fin(p.elevation), whole),
      cover: MODEL_CLOUD_HPA.map((hPa) => round(hour(`cloud_cover_${hPa}hPa`), whole)),
      zM: MODEL_CLOUD_HPA.map((hPa) => round(hour(`geopotential_height_${hPa}hPa`), whole)),
      kt: MODEL_WIND_HPA.map((hPa) => round(hour(`wind_speed_${hPa}hPa`), tenth)),
      deg: MODEL_WIND_HPA.map((hPa) => round(hour(`wind_direction_${hPa}hPa`), compass)),
    }
  })
}

/**
 * The places of a grid (geo.n × geo.n of them, row by row from its south-west) as a ModelGrid, arrays by level. The places stand where
 * they were asked for (a regular grid): the model answers from its own nearest point, up to a few km off, which the response says
 * and this ignores. Its hour is the oldest place's.
 */
export function assembleModel(geo: ModelGeo, places: readonly ModelPlace[]): ModelGrid {
  if (places.length !== geo.n * geo.n) throw new Error(`expected ${geo.n * geo.n} places, got ${places.length}`)
  const times = places.map((p) => p.timeMs).filter((t): t is number => t !== null)
  return {
    lat0: geo.lat0,
    lon0: geo.lon0,
    step: geo.step,
    n: geo.n,
    timeMs: times.length === 0 ? null : Math.min(...times),
    elevM: places.map((p) => p.elevM),
    clouds: MODEL_CLOUD_HPA.map((hPa, l) => ({ hPa, cover: places.map((p) => p.cover[l]), zM: places.map((p) => p.zM[l]) })),
    winds: MODEL_WIND_HPA.map((hPa, l) => ({ hPa, kt: places.map((p) => p.kt[l]), deg: places.map((p) => p.deg[l]) })),
  }
}

/** Open-Meteo's answer for all the places of geo (in the order asked) as a ModelGrid: slimPlaces, assembled. */
export function slimModel(json: unknown, geo: ModelGeo): ModelGrid {
  return assembleModel(geo, slimPlaces(json, geo.n * geo.n))
}

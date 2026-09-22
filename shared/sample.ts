import { geoidN } from './geoid.ts'
import type { Quality, ReadsbAircraft, Sample } from './types.ts'

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s === '' ? null : s
}

/** Position-quality tier. MLAT wins over the message type because readsb marks MLAT-derived fields per field. */
export function classify(ac: ReadsbAircraft): Quality {
  if (ac.type === 'mlat' || ac.mlat?.includes('lat')) return 'mlat'
  if (ac.type?.startsWith('adsb') || ac.type?.startsWith('adsr')) return ac.version === 2 ? 'adsb2' : 'adsb01'
  return 'other'
}

/** PIA (dbFlags & 4) and LADD (dbFlags & 8) aircraft are hidden unless explicitly allowed. */
export function isHidden(ac: ReadsbAircraft): boolean {
  return ((ac.dbFlags ?? 0) & (4 | 8)) !== 0
}

/**
 * One readsb aircraft → one Sample stamped in SERVER clock.
 * tMs = upstreamNowMs − seen_pos (the position's own age in the upstream clock) + offsetMs (upstream → server clock).
 * Returns null when there is no current position.
 */
export function toSample(ac: ReadsbAircraft, upstreamNowMs: number, offsetMs: number, rxMs: number): Sample | null {
  const lat = num(ac.lat)
  const lon = num(ac.lon)
  const seenPos = num(ac.seen_pos)
  if (lat === null || lon === null || seenPos === null) return null
  const onGround = ac.alt_baro === 'ground'
  return {
    hex: ac.hex.toLowerCase(),
    tMs: upstreamNowMs - Math.round(seenPos * 1000) + offsetMs,
    rxMs,
    lat,
    lon,
    onGround,
    altBaroFt: onGround ? null : num(ac.alt_baro),
    altGeomFt: num(ac.alt_geom),
    gsKt: num(ac.gs),
    trackDeg: num(ac.track),
    trueHeadingDeg: num(ac.true_heading),
    rollDeg: num(ac.roll),
    baroRateFpm: num(ac.baro_rate),
    geomRateFpm: num(ac.geom_rate),
    navQnhHpa: num(ac.nav_qnh),
    version: num(ac.version),
    nic: num(ac.nic),
    quality: classify(ac),
    nM: Math.round(geoidN(lat, lon) * 10) / 10,
    callsign: str(ac.flight),
    typeCode: str(ac.t),
    reg: str(ac.r),
  }
}

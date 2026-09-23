import { callsignOf } from './readsb.ts'
import type { ReadsbAircraft } from './types.ts'

/**
 * Slow-changing identity of one aircraft, sent once and again only when it changes (ViewResponse.info).
 * route is filled by the server's route cache (null until known); everything else comes from the aircraft object.
 */
export interface AircraftInfo {
  hex: string
  callsign: string | null
  reg: string | null
  typeCode: string | null        // ICAO type designator, e.g. B738
  category: string | null        // ADS-B emitter category, e.g. A3
  squawk: string | null
  emergency: string | null       // readsb value when not 'none', e.g. 'general', 'lifeguard'
  military: boolean              // dbFlags & 1
  route: string | null           // e.g. 'LGPZ-LLBG' (ICAO) from adsb.lol routeset
}

/** Selected/flat route as the server caches it. */
export interface RouteInfo {
  callsign: string
  route: string                  // airport codes joined by '-', ICAO when known
  plausible: boolean             // adsb.lol's own plausibility flag for the route vs the aircraft position
}

const s = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

export function toInfo(ac: ReadsbAircraft, route: string | null = null): AircraftInfo {
  const emergency = s(ac.emergency)
  return {
    hex: ac.hex.toLowerCase(),
    callsign: callsignOf(ac.flight),
    reg: s(ac.r),
    typeCode: s(ac.t),
    category: s(ac.category),
    squawk: s(ac.squawk),
    emergency: emergency === 'none' ? null : emergency,
    military: ((ac.dbFlags ?? 0) & 1) !== 0,
    route,
  }
}

/** True when nothing the UI shows has changed (so the server need not resend it). */
export function sameInfo(a: AircraftInfo, b: AircraftInfo): boolean {
  return (
    a.hex === b.hex && a.callsign === b.callsign && a.reg === b.reg && a.typeCode === b.typeCode &&
    a.category === b.category && a.squawk === b.squawk && a.emergency === b.emergency &&
    a.military === b.military && a.route === b.route
  )
}

// client/history/trace.ts
// A selected aircraft's trace (GET /api/trace: its flight leg from adsb.lol, 1–4 s points with track, vertical rate and
// roll) as the app uses it: samples for its TrackRegistry (the chase and the card, in History) and points for its
// flown path on the map (scene/routeLine.ts).
import type { TraceReply } from '../../shared/api.ts'
import type { AircraftInfo } from '../../shared/info.ts'
import type { Sample } from '../../shared/types.ts'
import { callsignAt } from './aircraftDay.ts'

const FT = 0.3048

export interface TracePoint {
  tMs: number
  lat: number
  lon: number
  hM: number // WGS84 ellipsoidal metres: baro + N (ground: N), as the icons are drawn
  altFt: number | null
  onGround: boolean
}

const altOf = (a: number | 'g' | null): number | null => (typeof a === 'number' ? a : null)

/**
 * Every point as a Sample, in time order, each with the callsign the aircraft sent at its time. Unknown fields null, as the
 * files do not carry them.
 */
export function traceSamples(tr: TraceReply): Sample[] {
  return tr.t.map((t, i) => {
    const tMs = Math.round(tr.t0Ms + t * 1000)
    return {
      hex: tr.hex, tMs, rxMs: tMs, lat: tr.lat[i], lon: tr.lon[i], onGround: tr.alt[i] === 'g',
      altBaroFt: altOf(tr.alt[i]), altGeomFt: null, gsKt: tr.gs[i], trackDeg: tr.trk[i], trueHeadingDeg: null,
      rollDeg: tr.roll[i], baroRateFpm: tr.vs[i], geomRateFpm: null, navQnhHpa: null, version: null, nic: null,
      quality: 'adsb2', nM: tr.nM[i], callsign: callsignAt(tr, tMs), typeCode: tr.typeCode, reg: tr.reg,
    }
  })
}

/** The flown path's points, in time order. */
export function tracePath(tr: TraceReply): TracePoint[] {
  return tr.t.map((t, i) => {
    const altFt = altOf(tr.alt[i])
    const onGround = tr.alt[i] === 'g'
    return {
      tMs: Math.round(tr.t0Ms + t * 1000), lat: tr.lat[i], lon: tr.lon[i],
      hM: onGround || altFt === null ? tr.nM[i] : altFt * FT + tr.nM[i], altFt, onGround,
    }
  })
}

/** Its identity for the card and the fleet: the trace knows callsign, registration and type. */
export function traceInfo(tr: TraceReply): AircraftInfo {
  return { hex: tr.hex, callsign: tr.callsign, reg: tr.reg, typeCode: tr.typeCode, category: null, squawk: null, emergency: null, military: false, route: null }
}

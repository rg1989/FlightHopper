import type { Snapshot } from './types.ts'

// The only difference between adsb.lol v2 and a local readsb API is this envelope.
// Per-aircraft objects are identical readsb JSON.

/** adsb.lol /v2/*: { ac: [...] | null, now: <ms> } */
export function normalizeAdsblol(body: string): Snapshot {
  const j = JSON.parse(body)
  if (typeof j?.now !== 'number') throw new Error('not an adsb.lol v2 body: missing now')
  if (!('ac' in j) || (j.ac !== null && !Array.isArray(j.ac))) throw new Error('not an adsb.lol v2 body: no ac array')
  return { nowMs: j.now, aircraft: j.ac ?? [] }
}

/**
 * The callsign in a readsb `flight` field, or null: readsb writes '@' for characters it could not decode (so the rest
 * is not the real callsign either), and an all-zero callsign is a transponder's placeholder. Both mean "none" (the
 * table then shows the hex).
 */
export function callsignOf(flight: unknown): string | null {
  if (typeof flight !== 'string') return null
  const t = flight.trim()
  return t === '' || t.includes('@') || /^0+$/.test(t) ? null : t
}

/** readsb --net-api-port and aircraft.json: { aircraft: [...], now: <seconds, fractional> } */
export function normalizeReadsb(body: string): Snapshot {
  const j = JSON.parse(body)
  if (typeof j?.now !== 'number') throw new Error('not a readsb body: missing now')
  if (!('aircraft' in j) || (j.aircraft !== null && !Array.isArray(j.aircraft))) throw new Error('not a readsb body: no aircraft array')
  return { nowMs: Math.round(j.now * 1000), aircraft: j.aircraft ?? [] }
}

export const normalizers = {
  adsblol: normalizeAdsblol,
  adsbfi: normalizeAdsblol, // same envelope
  readsb: normalizeReadsb,
} as const

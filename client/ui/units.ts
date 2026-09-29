// client/ui/units.ts
// The flight-data frame's units (its edit mode's Units menu): altitude in feet, metres or both; speed in knots, km/h, mph
// or knots with km/h; vertical speed in ft/min or m/s. "Both": the tapes and figures in the first, the second as a
// readout of its own under the tape. Data stays in ft, kt and ft/min; these convert it for display only.

export type AltUnit = 'ft' | 'm' | 'ft+m'
export type SpeedUnit = 'kt' | 'kmh' | 'mph' | 'kt+kmh'
export type VsUnit = 'fpm' | 'ms'
export interface Units { alt: AltUnit; speed: SpeedUnit; vs: VsUnit }

export const DEFAULT_UNITS: Units = Object.freeze({ alt: 'ft', speed: 'kt', vs: 'fpm' })
export const ALT_UNITS: readonly AltUnit[] = ['ft', 'm', 'ft+m']
export const SPEED_UNITS: readonly SpeedUnit[] = ['kt', 'kmh', 'mph', 'kt+kmh']
export const VS_UNITS: readonly VsUnit[] = ['fpm', 'ms']

export const M_PER_FT = 0.3048
export const KMH_PER_KT = 1.852
export const MPH_PER_KT = 1.150779
export const MS_PER_FPM = 0.00508

/** What each choice reads as in the menu. */
export const UNIT_NAME: Record<AltUnit | SpeedUnit | VsUnit, string> = {
  ft: 'ft', m: 'm', 'ft+m': 'ft + m', kt: 'kt', kmh: 'km/h', mph: 'mph', 'kt+kmh': 'kt + km/h', fpm: 'ft/min', ms: 'm/s',
}

/** Altitude in the first unit, and its label. */
export const altIn = (ft: number, u: AltUnit): number => (u === 'm' ? ft * M_PER_FT : ft)
export const altLabel = (u: AltUnit): string => (u === 'm' ? 'm' : 'ft')
/** Speed in the first unit, and its label. */
export const speedIn = (kt: number, u: SpeedUnit): number => (u === 'kmh' ? kt * KMH_PER_KT : u === 'mph' ? kt * MPH_PER_KT : kt)
export const speedLabel = (u: SpeedUnit): string => (u === 'kmh' ? 'km/h' : u === 'mph' ? 'mph' : 'kt')
export const vsLabel = (u: VsUnit): string => (u === 'ms' ? 'm/s' : 'ft/min')

/** The stored units, each field checked; anything else keeps the default. */
export function readUnits(v: unknown): Units {
  const o = (v ?? {}) as Record<string, unknown>
  const pick = <T extends string>(x: unknown, all: readonly T[], def: T): T => (all.includes(x as T) ? (x as T) : def)
  return {
    alt: pick(o.alt, ALT_UNITS, DEFAULT_UNITS.alt),
    speed: pick(o.speed, SPEED_UNITS, DEFAULT_UNITS.speed),
    vs: pick(o.vs, VS_UNITS, DEFAULT_UNITS.vs),
  }
}

// shared/airlines.ts
// Airline names by ICAO designator. Data: OpenFlights airline database (https://openflights.org/data),
// Open Database License 1.0 / Database Contents License 1.0; rebuilt by tools/build-airlines.ts.
import names from './airlines.json' with { type: 'json' }

const NAMES: Readonly<Record<string, string>> = names

/**
 * ICAO flight identification: a 3-letter operator designator, then a flight number that starts with a digit
 * (ELY5450, UAE954, EZY84TL), at most 8 characters as ADS-B carries. Registrations flown as callsigns (N123AB, GABCD,
 * DAIBC) fail the pattern.
 * ponytail: letter-first flight numbers (rare, e.g. some military "ABC" + "A1") return null, and a registration that
 * happens to read as designator + digits (UP-A3001 → UPA3001) returns that designator's name; the upgrade path is to
 * cross-check the aircraft's registration (AircraftInfo.reg) when it is known.
 */
const FLIGHT_ID = /^[A-Z]{3}\d[A-Z0-9]{0,4}$/

/** The ICAO operator designator of an airline flight id ('ELY5450' → 'ELY'); null when it is not one. */
export function operatorOf(callsign: string | null): string | null {
  if (callsign === null) return null
  const cs = callsign.trim().toUpperCase()
  return FLIGHT_ID.test(cs) ? cs.slice(0, 3) : null
}

/** Airline name for a callsign such as 'ELY5450' (→ 'El Al Israel Airlines'); null when it is not an airline flight id. */
export function airlineOf(callsign: string | null): string | null {
  const op = operatorOf(callsign)
  return op === null ? null : (NAMES[op] ?? null)
}

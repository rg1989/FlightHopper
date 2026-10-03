// client/track/airspeed.ts
// Airspeed and energy physics, one place for the live chase, the scenarios and the tools that build them.
//   Calibrated airspeed (what the pilots' airspeed indicator shows, and what a flight recorder's "IAS"/"CAS" is) measures
//   the impact pressure of the air; true airspeed is the aircraft's speed through the air, which grows with height as
//   the air thins (and, fast and high, as it compresses): the standard subsonic pitot relations over the ISA atmosphere.
//   Specific energy, height + TAS²/2g, is what engines and drag change and a dive or a zoom only exchanges.

const G = 9.80665
const KT = 1852 / 3600
const FT = 0.3048
const P0 = 101_325 // Pa, ISA sea level
const T0 = 288.15 // K
const A0 = Math.sqrt(1.4 * 287.05287 * T0) // m/s, the speed of sound at sea level
const LAPSE = 0.0065 // K/m, to the tropopause
const TROPOPAUSE_M = 11_000
const T11 = T0 - LAPSE * TROPOPAUSE_M // 216.65 K, the stratosphere's
const P11 = P0 * (T11 / T0) ** (G / (287.05287 * LAPSE))

/** ISA temperature (K) and pressure (Pa) at a pressure altitude in metres. */
function isa(hM: number): { tK: number; pPa: number } {
  if (hM <= TROPOPAUSE_M) {
    const tK = T0 - LAPSE * hM
    return { tK, pPa: P0 * (tK / T0) ** (G / (287.05287 * LAPSE)) }
  }
  return { tK: T11, pPa: P11 * Math.exp((-G * (hM - TROPOPAUSE_M)) / (287.05287 * T11)) }
}

/** The standard atmosphere's pressure (hPa) at a pressure altitude (ft): what a pressure level is in height (the weather model's levels). */
export function pressureHPa(pressureAltFt: number): number {
  return isa(Math.max(pressureAltFt, -1000) * FT).pPa / 100
}

/**
 * True airspeed (kt) from calibrated airspeed (kt) at a pressure altitude (ft), subsonic: the impact pressure CAS means
 * at sea level, the Mach number that pressure means up here, and the speed of sound in the outside air (ISA, or the
 * measured temperature, °C). An altitude above mean sea level stands in for the pressure altitude to within the QNH's
 * few hundred feet (well under 1 % of TAS).
 */
export function trueAirspeedKt(casKt: number, pressureAltFt: number, oatC?: number | null): number {
  const { tK, pPa } = isa(Math.max(pressureAltFt, -1000) * FT)
  const qc = P0 * ((1 + 0.2 * ((casKt * KT) / A0) ** 2) ** 3.5 - 1)
  const mach = Math.sqrt(5 * ((qc / pPa + 1) ** (2 / 7) - 1))
  const t = oatC === null || oatC === undefined || !Number.isFinite(oatC) ? tK : oatC + 273.15
  return (mach * Math.sqrt(1.4 * 287.05287 * t)) / KT
}

/** Specific energy (m): the height the aircraft would reach trading all its speed through the air for height. */
export const specificEnergyM = (hM: number, tasMs: number): number => hM + (tasMs * tasMs) / (2 * G)

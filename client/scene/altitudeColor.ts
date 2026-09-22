// client/scene/altitudeColor.ts
/**
 * Altitude → colour for the browse view. FlightHopper's own palette (not tar1090's): a smooth HSL gradient over seven
 * stops, orange at the surface → yellow → green → cyan → blue → violet → magenta at 40,000 ft and above.
 * On the ground → mid grey; altitude unknown → light grey.
 * Every colour is precomputed once in 100 ft buckets (403 entries), so a lookup allocates nothing.
 */

/** [altitude ft, hue °, saturation %, lightness %]. Lightness dips in the green/cyan band so it stays readable on a light map. */
const STOPS: readonly (readonly [number, number, number, number])[] = [
  [0, 24, 95, 53], //        orange
  [2_000, 50, 95, 50], //    yellow
  [6_000, 118, 65, 42], //   green
  [12_000, 182, 80, 40], //  cyan
  [20_000, 222, 85, 56], //  blue
  [30_000, 268, 75, 62], //  violet
  [40_000, 304, 78, 58], //  magenta
]

export const TOP_FT = 40_000
export const STEP_FT = 100
const BUCKETS = TOP_FT / STEP_FT + 1 // 0, 100, …, 40,000 ft
export const GROUND_INDEX = BUCKETS
export const UNKNOWN_INDEX = BUCKETS + 1
export const COLOR_COUNT = BUCKETS + 2

const GROUND_RGB: readonly [number, number, number] = [128, 128, 128]
const UNKNOWN_RGB: readonly [number, number, number] = [196, 196, 196]

/** The continuous gradient: [hue °, saturation %, lightness %] at altFt, linear between stops, clamped to 0…40,000 ft. */
export function hslAt(altFt: number): [number, number, number] {
  const ft = Math.min(TOP_FT, Math.max(0, altFt))
  let i = 1
  while (i < STOPS.length - 1 && STOPS[i][0] < ft) i++
  const a = STOPS[i - 1]
  const b = STOPS[i]
  const f = Math.min(1, Math.max(0, (ft - a[0]) / (b[0] - a[0])))
  return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f]
}

/** CSS Color 4 HSL → sRGB, 0–255 integers. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sat = s / 100
  const lig = l / 100
  const a = sat * Math.min(lig, 1 - lig)
  const f = (n: number): number => {
    const k = (n + h / 30) % 12
    return Math.round((lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255)
  }
  return [f(0), f(8), f(4)]
}

/** RGBA 0–1 per colour index, 4 floats each (for Cesium). */
export const ALTITUDE_RGBA = new Float32Array(COLOR_COUNT * 4)
const CSS: string[] = new Array(COLOR_COUNT)

function setColor(i: number, [r, g, b]: readonly [number, number, number]): void {
  CSS[i] = `rgb(${r}, ${g}, ${b})`
  ALTITUDE_RGBA.set([r / 255, g / 255, b / 255, 1], i * 4)
}
for (let i = 0; i < BUCKETS; i++) setColor(i, hslToRgb(...hslAt(i * STEP_FT)))
setColor(GROUND_INDEX, GROUND_RGB)
setColor(UNKNOWN_INDEX, UNKNOWN_RGB)

/** Colour-table index: the nearest 100 ft bucket (0 … 400), GROUND_INDEX when on the ground, UNKNOWN_INDEX without an altitude. */
export function altitudeIndex(altFt: number | null, onGround: boolean): number {
  if (onGround) return GROUND_INDEX
  if (altFt === null || !Number.isFinite(altFt)) return UNKNOWN_INDEX
  if (altFt <= 0) return 0
  if (altFt >= TOP_FT) return BUCKETS - 1
  return Math.round(altFt / STEP_FT)
}

/** CSS colour, e.g. 'rgb(247, 115, 17)'. The strings are precomputed; nothing is allocated per call. */
export function altitudeColor(altFt: number | null, onGround: boolean): string {
  return CSS[altitudeIndex(altFt, onGround)]
}

/** Writes the colour (0–1 channels, alpha 1) into `out` (a Cesium Color works) and returns it. */
export function altitudeRgba<T extends { red: number; green: number; blue: number; alpha: number }>(
  altFt: number | null,
  onGround: boolean,
  out: T,
): T {
  const i = altitudeIndex(altFt, onGround) * 4
  out.red = ALTITUDE_RGBA[i]
  out.green = ALTITUDE_RGBA[i + 1]
  out.blue = ALTITUDE_RGBA[i + 2]
  out.alpha = ALTITUDE_RGBA[i + 3]
  return out
}

// client/scene/instrumentMath.ts
// The flight-data frame's instrument geometry (client/scene/flightFrame.ts, client/ui/instruments.ts), pure: where a
// tape's marks go and how far it has scrolled, the readouts' rolling digits, the speed trend, the vertical-speed scale,
// the compass labels, continuous angles (a dial never spins the long way round), and the per-frame smoothing that turns
// stepped data into steady motion.

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)

// ---- tapes ----------------------------------------------------------------------------------------------------------

/** One graduation of a tape: its value, and whether it is a labelled (major) one. */
export interface Mark { v: number; major: boolean }

/** A tape's graduations from lo to hi (both included): every `minor`, the multiples of `major` flagged. */
export function marks(lo: number, hi: number, minor: number, major: number): Mark[] {
  const out: Mark[] = []
  const k1 = Math.floor(hi / minor + 1e-9)
  for (let k = Math.ceil(lo / minor - 1e-9); k <= k1; k++) {
    const v = k * minor || 0 // `|| 0`: no −0
    out.push({ v, major: Math.abs(Math.round(v / major) * major - v) < 1e-9 * major })
  }
  return out
}

/**
 * How far a tape's strip, drawn around `centre`, moves to put `value` under its index: (value − centre) px per unit,
 * rounded to whole device pixels so its 1 px lines stay crisp. A vertical tape moves its strip down by it (higher values
 * are drawn above), a horizontal one left.
 */
export function tapeShift(value: number, centre: number, pxPerUnit: number, dpr: number): number {
  return Math.round((value - centre) * pxPerUnit * dpr) / dpr || 0
}

/**
 * The value a tape's strip is drawn around: `current` while value ± window stays on a strip reaching ± halfSpan from
 * it, else value rounded to `step` (null: none drawn yet). The strip is rebuilt only when this changes.
 */
export function stripCentre(value: number, current: number | null, halfSpan: number, window: number, step: number): number {
  if (current !== null && Math.abs(value - current) + window <= halfSpan) return current
  return Math.round(value / step) * step || 0
}

/** The heading tape's label at deg: every 30°, N E S W and the rest in tens (3 for 030°), '' in between. */
export function hdgLabel(deg: number): string {
  const d = (((Math.round(deg) % 360) + 360) % 360)
  if (d % 30 !== 0) return ''
  return d === 0 ? 'N' : d === 90 ? 'E' : d === 180 ? 'S' : d === 270 ? 'W' : String(d / 10)
}

// ---- readouts -------------------------------------------------------------------------------------------------------

/**
 * A readout's rolling digits, an odometer: the magnitude's whole `unit`s in figures (lead), the rest a position on a drum
 * of `step`s (pos, 0 … unit/step), and a minus from half a step below zero.
 */
export function drum(v: number, unit: number, step: number): { lead: number; pos: number; neg: boolean } {
  const a = Math.abs(v)
  const lead = Math.floor(a / unit)
  return { lead, pos: (a - lead * unit) / step, neg: v <= -step / 2 }
}

/** A drum's cells, top to bottom: one unit's steps from the top down, and one more past each end (its neighbours show). */
export function drumLabels(unit: number, step: number, digits: number): string[] {
  const n = unit / step
  const out: string[] = []
  for (let k = n + 1; k >= -1; k--) out.push(String((((k % n) + n) % n) * step).padStart(digits, '0'))
  return out
}

/** How far a drum of n cells per unit moves, in cells, to centre position pos in its window: down as the value rises. */
export const drumShift = (pos: number, n: number): number => pos - n - 1

/** The speed trend arrow points at the speed this many seconds ahead, at the present rate of change. */
export const TREND_S = 10
const TREND_TAU_S = 1 // the rate's smoothing
const TREND_JUMP_KT_S = 15 // faster than any aircraft changes speed: a seek, not flight

/**
 * A speed's rate of change per second of its own clock, smoothed (an exponential approach): the speed trend. dtS is the
 * data's time: 0 while paused (the trend holds, and a value moved meanwhile, a drag, counts for nothing), negative after
 * a seek back. Time going back, a jump no aircraft could make, and an unknown value start it again from nothing (null).
 */
export class Trend {
  #last: number | null = null
  #rate: number | null = null

  step(v: number | null, dtS: number): number | null {
    const last = this.#last
    this.#last = v
    if (v === null || last === null || dtS < 0) return (this.#rate = null)
    if (dtS === 0) return this.#rate
    const r = (v - last) / dtS
    if (Math.abs(r) > TREND_JUMP_KT_S) return (this.#rate = null)
    return (this.#rate = glide(this.#rate ?? 0, r, dtS, TREND_TAU_S))
  }
}

/** Whether the speed trend arrow shows, for a change of kt10 over TREND_S: from 2 kt on, until it falls below 1 kt. */
export const trendShown = (shown: boolean, kt10: number): boolean => Math.abs(kt10) >= (shown ? 1 : 2)

// ---- vertical speed -------------------------------------------------------------------------------------------------

/** The vertical-speed scale's marks, fpm each way. */
export const VSI_MARKS = [500, 1_000, 2_000, 4_000, 6_000] as const
// The scale's breakpoints (fpm → fraction of the travel from level to the end): fine where it matters, near level.
const VSI_BP: ReadonlyArray<readonly [number, number]> = [[0, 0], [1_000, 0.5], [2_000, 0.75], [6_000, 1]]

/** Where fpm sits on the vertical-speed scale, −1 (6,000 down) … 1 (6,000 up), pinned beyond. */
export function vsiFrac(fpm: number): number {
  const a = Math.min(Math.abs(fpm), 6_000)
  let f = 1
  for (let i = 1; i < VSI_BP.length; i++) {
    const [v0, f0] = VSI_BP[i - 1]
    const [v1, f1] = VSI_BP[i]
    if (a <= v1) {
      f = f0 + ((a - v0) / (v1 - v0)) * (f1 - f0)
      break
    }
  }
  return Math.sign(fpm) * f || 0
}

// ---- angles ---------------------------------------------------------------------------------------------------------

/** An angle in (−180, 180]. */
export const rel180 = (a: number): number => 180 - ((((180 - a) % 360) + 360) % 360)

/** target, turned by whole turns to lie within 180° of prev: an unwrapped angle, continuous across 360/0 and ±180. */
export const follow = (prev: number, target: number): number => prev + rel180(target - prev)

// ---- smoothing ------------------------------------------------------------------------------------------------------

/** cur moved towards target for dtS seconds, an exponential approach with time constant tauS. */
export function glide(cur: number, target: number, dtS: number, tauS: number): number {
  if (!(dtS > 0)) return cur
  if (!(tauS > 0)) return target
  return target + (cur - target) * Math.exp(-dtS / tauS)
}

/**
 * One smoothed quantity, stepped every frame: it glides to each new target (steady motion from data that arrives in
 * steps), but snaps to its first value, after a gap, and across a jump larger than `snap` (a seek, another aircraft):
 * never a glide up from zero or from a stale value. An unknown target (null, NaN) makes it unknown. An angle is kept
 * unwrapped (continuous), so it always turns the short way.
 */
export class Glide {
  value: number | null = null
  readonly tauS: number
  readonly snap: number
  readonly angle: boolean

  constructor(tauS: number, snap: number, angle = false) {
    this.tauS = tauS
    this.snap = snap
    this.angle = angle
  }

  step(target: number | null, dtS: number): number | null {
    if (target === null || !Number.isFinite(target)) return (this.value = null)
    if (this.value === null) return (this.value = target)
    const t = this.angle ? follow(this.value, target) : target
    return (this.value = Math.abs(t - this.value) > this.snap ? t : glide(this.value, t, dtS, this.tauS))
  }
}

// ---- attitude and gauges --------------------------------------------------------------------------------------------

/** The attitude indicator's horizon moves with pitch up to this many degrees, then stays at the edge. */
export const ADI_PITCH_LIMIT = 25
/** Past this bank the bank pointer turns amber (the airliner "bank angle" limit). */
export const BANK_ALERT_DEG = 35

/** The pitch the horizon is drawn at: pitchDeg within ±ADI_PITCH_LIMIT. */
export const pitchShift = (pitchDeg: number): number => clamp(pitchDeg, -ADI_PITCH_LIMIT, ADI_PITCH_LIMIT)

/** Banked past BANK_ALERT_DEG either way (roll may be unwrapped). */
export const bankAlert = (rollDeg: number): boolean => Math.abs(rel180(rollDeg)) > BANK_ALERT_DEG

/** A gauge needle's angle for v on a scale lo…hi drawn from a0 to a1 (degrees clockwise from up), pinned at the ends. */
export const arcDeg = (v: number, lo: number, hi: number, a0: number, a1: number): number =>
  a0 + clamp((v - lo) / (hi - lo), 0, 1) * (a1 - a0)

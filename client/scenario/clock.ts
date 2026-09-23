// client/scenario/clock.ts
// The scenario playback clock: a plain t (scenario seconds) that advances with tick() while playing, at a chosen
// rate, clamped to [start, stop]. No DOM, no Cesium: ScenarioRun drives it once a frame and reads t back.
// `stop` is whatever the caller wants the timeline to reach — normally scenario.end, or
// max(scenario.end, ending.darkAt + ending.cardAfterS) when the ending card runs past the last data second.

export const RATES = [1, 2, 4, 8, 16] as const
export type Rate = (typeof RATES)[number]

export class ScenarioClock {
  readonly start: number
  readonly stop: number
  t: number
  playing = false
  rate: Rate = 1

  constructor(start: number, stop: number, t: number = start) {
    this.start = start
    this.stop = stop
    this.t = clamp(t, start, stop)
  }

  /** Advances t by dtS·rate while playing; stops (and pauses) exactly at `stop`. A no-op while paused. */
  tick(dtS: number): void {
    if (!this.playing) return
    this.t += dtS * this.rate
    if (this.t >= this.stop) {
      this.t = this.stop
      this.playing = false
    }
  }

  /** Clamps to [start, stop]. Never changes `playing`. */
  seek(t: number): void {
    this.t = clamp(t, this.start, this.stop)
  }

  /** Resumes from the current t, or from `start` when t is already at `stop`. */
  play(): void {
    if (this.t >= this.stop) this.t = this.start
    this.playing = true
  }

  pause(): void {
    this.playing = false
  }

  /** Throws when `r` is not a member of RATES; the rate is left unchanged. */
  setRate(r: number): void {
    if (!(RATES as readonly number[]).includes(r)) throw new Error(`rate must be one of ${RATES.join(', ')}, got ${r}`)
    this.rate = r as Rate
  }

  /** Cycles 1→2→4→8→16→1 and returns the new rate. */
  nextRate(): number {
    this.rate = RATES[(RATES.indexOf(this.rate) + 1) % RATES.length]
    return this.rate
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

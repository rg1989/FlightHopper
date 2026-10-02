// client/history/clock.ts
// The replay clock of History mode: a time in the past (UTC ms) that runs at 1x, 10x or 60x while playing, kept inside
// [minMs, maxMs]. Pure: no timers, no DOM. Every method is told performance.now() (perfMs), so the app asks it once a
// frame and a test drives it with plain numbers. At maxMs the clock does not stop itself, it waits there (atEnd): the
// app decides, and setBounds lets a clock that waited carry on when the next half hour is published. Stalled (stall), a
// playing clock holds its time without leaving playing: the app is waiting for the data of the time under it. A start
// older than minMs (a ?hist= link or a reload further back than the bounds known yet) waits as asked: the first bounds
// that reach it take the clock there, unless a seek came first.

export const RATES: readonly number[] = [1, 10, 60]

export class HistoryClock {
  #baseMs: number // the replay time at #basePerf (the time itself while paused)
  #basePerf: number
  #playing: boolean
  #stalled = false // holding its time whatever else it does: waiting for data (buffering), not paused
  #rate: number
  #minMs: number
  #maxMs: number
  #asked: number | null // a start older than minMs, waiting for bounds that reach it; null: none

  /**
   * Starts paused at 1x unless o says otherwise; tMs is clamped to the bounds. One older than minMs is kept as asked: the
   * oldest end is the one a guess holds until the server says (the newest is known from the start).
   */
  constructor(tMs: number, o: { minMs: number; maxMs: number; playing?: boolean; rate?: number }, perfMs: number) {
    this.#minMs = o.minMs
    this.#maxMs = o.maxMs
    this.#playing = o.playing ?? false
    this.#rate = o.rate ?? 1
    this.#baseMs = this.#clamp(tMs)
    this.#basePerf = perfMs
    this.#asked = tMs < o.minMs ? tMs : null
  }

  /** The replay time at perfMs: moves by rate × elapsed while playing (and not stalled), never outside [minMs, maxMs]. */
  now(perfMs: number): number {
    if (!this.#playing || this.#stalled) return this.#baseMs
    // A perfMs older than the last change (a frame timestamp a few ms before the performance.now() of a click handled
    // in the same frame) counts as no time elapsed: the clock never runs backwards by itself.
    const elapsed = perfMs > this.#basePerf ? perfMs - this.#basePerf : 0
    return this.#clamp(this.#baseMs + elapsed * this.#rate)
  }

  get playing(): boolean {
    return this.#playing
  }

  get stalled(): boolean {
    return this.#stalled
  }

  get rate(): number {
    return this.#rate
  }

  get maxMs(): number {
    return this.#maxMs
  }

  /** The start asked for that the bounds do not reach yet (the time the clock goes to when they do); null: none waiting. */
  get asked(): number | null {
    return this.#asked
  }

  /** Playing and waiting at maxMs: nothing newer to show. */
  atEnd(perfMs: number): boolean {
    return this.#playing && this.now(perfMs) >= this.#maxMs
  }

  /**
   * Holds the time (on) or lets it run again (off) without changing playing: a clock waiting for the data of its time does
   * not run over an empty map. The time held is the one at perfMs and it goes on from there, no jump over the wait. Seek,
   * rate, pause and play work meanwhile (a paused clock holds anyway; a played one waits for the stall to end).
   */
  stall(on: boolean, perfMs: number): void {
    if (on === this.#stalled) return
    this.#rebase(perfMs) // the time up to now, as it ran or was held until now: neither way jumps
    this.#stalled = on
  }

  play(perfMs: number): void {
    if (this.#playing) return
    this.#rebase(perfMs)
    this.#playing = true
  }

  pause(perfMs: number): void {
    if (!this.#playing) return
    this.#rebase(perfMs)
    this.#playing = false
  }

  toggle(perfMs: number): void {
    if (this.#playing) this.pause(perfMs)
    else this.play(perfMs)
  }

  /** Jumps to tMs, clamped to the bounds. Playing or paused stays as it is. A start still asked for is dropped: the seek wins. */
  seek(tMs: number, perfMs: number): void {
    this.#baseMs = this.#clamp(tMs)
    this.#basePerf = this.#stamp(perfMs)
    this.#asked = null
  }

  /** The next of RATES (the first after the last; the next larger one for a rate not in RATES). The time does not jump. */
  nextRate(perfMs: number): number {
    this.#rebase(perfMs)
    this.#rate = RATES.find((r) => r > this.#rate) ?? RATES[0]
    return this.#rate
  }

  /**
   * New bounds (minMs ≤ maxMs). The time stays where it is, pulled inside them when it is outside; or, when they are the
   * first to reach the start asked for (asked), it goes there: true (a jump, as a seek; playing or paused stays as it is).
   */
  setBounds(minMs: number, maxMs: number, perfMs: number): boolean {
    this.#rebase(perfMs) // under the old bounds: a clock that waited at the old end continues from it, it does not jump
    this.#minMs = minMs
    this.#maxMs = maxMs
    const asked = this.#asked
    if (asked !== null && asked >= minMs) {
      this.seek(asked, perfMs)
      return true
    }
    this.#baseMs = this.#clamp(this.#baseMs)
    return false
  }

  #rebase(perfMs: number): void {
    this.#baseMs = this.now(perfMs)
    this.#basePerf = this.#stamp(perfMs)
  }

  // The instant a change takes effect: perfMs, but never earlier than the last change. A call stamped earlier than the
  // last one (frame timestamps run a few ms behind a click's performance.now()) would move the base back and count that
  // overlap twice. Written so that a perfMs that is not a number is ignored: with Math.max a NaN would stall the clock.
  #stamp(perfMs: number): number {
    return perfMs > this.#basePerf ? perfMs : this.#basePerf
  }

  // Written so that NaN lands on minMs: a time that is not a number must not reach the render loop.
  #clamp(t: number): number {
    return t > this.#minMs ? (t < this.#maxMs ? t : this.#maxMs) : this.#minMs
  }
}

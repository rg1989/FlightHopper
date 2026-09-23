// client/scenario/audio.ts
// Drives one <audio>-like element to track the scenario clock: seeks into the clip mapped to the current t, plays
// only inside a clip at rate 1 with gain > 0, and pauses otherwise. A rejected play() (the browser's autoplay
// policy, before a user gesture) never escapes as an unhandled rejection: it is caught and logged once.
import type { AudioClip } from './types.ts'

export interface MediaLike {
  currentTime: number
  volume: number
  paused: boolean
  play(): Promise<void> | void
  pause(): void
}

const DRIFT_S = 0.25

export class AudioSync {
  readonly #el: MediaLike
  readonly #clips: readonly AudioClip[]
  #loggedPlayError = false

  constructor(el: MediaLike, clips: readonly AudioClip[]) {
    this.#el = el
    this.#clips = clips
  }

  /** Called once a frame with the scenario clock's state. gain: 0..1 (the user's volume/mute setting). */
  update(t: number, playing: boolean, rate: number, gain: number): void {
    const clip = this.#clips.find((c) => t >= c.at && t < c.at + (c.to - c.from))
    if (clip === undefined || !playing || rate !== 1 || gain <= 0) {
      if (!this.#el.paused) this.#el.pause()
      return
    }
    const expected = clip.from + (t - clip.at)
    if (Math.abs(this.#el.currentTime - expected) > DRIFT_S) this.#el.currentTime = expected
    this.#el.volume = gain
    if (this.#el.paused) {
      const p = this.#el.play()
      if (p) {
        p.catch((e: unknown) => {
          if (this.#loggedPlayError) return
          this.#loggedPlayError = true
          console.error('AudioSync: play() rejected (autoplay policy?):', e)
        })
      }
    }
  }
}

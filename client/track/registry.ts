// client/track/registry.ts
// All tracks the client knows, keyed by hex. The app feeds poll responses in and draws states() each frame.
import type { Sample } from '../../shared/types.ts'
import type { RenderState } from '../types.ts'
import { MIN_DELAY_S } from './delay.ts'
import { Track } from './track.ts'

export class TrackRegistry {
  readonly #tracks = new Map<string, Track>()
  readonly #pollPeriodS: number | undefined

  constructor(opts: { pollPeriodS?: number } = {}) {
    this.#pollPeriodS = opts.pollPeriodS
  }

  /** Routes each sample to its hex's Track (created on first sight). The batch is taken in time order. */
  ingest(samples: Sample[]): void {
    for (const s of [...samples].sort((a, b) => a.tMs - b.tMs)) {
      let t = this.#tracks.get(s.hex)
      if (t === undefined) this.#tracks.set(s.hex, (t = new Track(s.hex, { pollPeriodS: this.#pollPeriodS })))
      t.add(s)
    }
  }

  /** One RenderState per track that has something to draw at tRenderMs. */
  states(tRenderMs: number): RenderState[] {
    const out: RenderState[] = []
    for (const t of this.#tracks.values()) {
      const s = t.stateAt(tRenderMs)
      if (s !== null) out.push(s)
    }
    return out
  }

  get(hex: string): Track | undefined {
    return this.#tracks.get(hex)
  }

  /** The chased track's target playback delay; 3 s when nothing (or nothing known) is chased. */
  delayTargetS(hex: string | null): number {
    const t = hex === null ? undefined : this.#tracks.get(hex)
    return t === undefined ? MIN_DELAY_S : t.delayTargetS
  }

  /** Forgets tracks whose newest sample is more than maxAgeS older than serverNowMs. */
  prune(serverNowMs: number, maxAgeS: number): void {
    for (const [hex, t] of this.#tracks) {
      if ((t.newestTMs ?? -Infinity) < serverNowMs - maxAgeS * 1000) this.#tracks.delete(hex)
    }
  }
}

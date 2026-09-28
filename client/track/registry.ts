// client/track/registry.ts
// All tracks the client knows, keyed by hex. The app feeds poll responses in and draws states() each frame.
import { distanceNm } from '../../shared/geo.ts'
import type { Sample } from '../../shared/types.ts'
import type { FleetEntry, RenderState } from '../types.ts'
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

  /** ingest() for the aircraft within rangeNm of (lat, lon) only, never skipHex (the chase traffic: its own tracks). */
  ingestNear(samples: Sample[], lat: number, lon: number, rangeNm: number, skipHex: string | null): void {
    this.ingest(samples.filter((s) => s.hex !== skipHex && distanceNm(lat, lon, s.lat, s.lon) <= rangeNm))
  }

  /**
   * Writes each tracked aircraft's state at tRenderMs over its fleet entry: position, height, speeds, ground flag and
   * the attitude (att), so the traffic flies the same smoothed physics as the chased aircraft. Other entries get
   * att = null (their newest sample's pose). The entries are the Fleet's reused objects, for this frame.
   */
  applyTo(entries: readonly FleetEntry[], tRenderMs: number): void {
    for (const e of entries) {
      const s = this.#tracks.get(e.hex)?.stateAt(tRenderMs) ?? null
      if (s === null) {
        if (e.att) e.att = null
        continue
      }
      e.lat = s.lat
      e.lon = s.lon
      e.hM = s.hM
      e.onGround = s.onGround
      e.trackDeg = s.trackDeg
      e.gsKt = s.gsKt
      e.vsFpm = s.vsFpm
      e.att = { headingDeg: s.headingDeg, pitchDeg: s.pitchDeg, rollDeg: s.rollDeg }
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

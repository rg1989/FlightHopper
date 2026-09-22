// server/store.ts
import { Deduper } from '../shared/dedupe.ts'
import { distanceNm } from '../shared/geo.ts'
import type { Sample } from '../shared/types.ts'

/**
 * Recent deduped samples per aircraft, kept for horizonMs (default 180 s) of server receipt time (rxMs).
 * Clients poll with `since` = the largest rxMs they have seen, so every answer carries only what is new to them.
 */
export class SampleStore {
  #horizonMs: number
  #byHex = new Map<string, Sample[]>() // arrival order = tMs ascending (the Deduper rejects older samples)
  #dedupe = new Deduper()
  #size = 0

  constructor(opts: { horizonMs?: number } = {}) {
    this.#horizonMs = opts.horizonMs ?? 180_000
  }

  /** false when the Deduper rejects the sample (re-served, older, or unmoved < 100 ms later). */
  add(s: Sample): boolean {
    if (!this.#dedupe.accept(s)) return false
    const list = this.#byHex.get(s.hex)
    if (list) list.push(s)
    else this.#byHex.set(s.hex, [s])
    this.#size++
    return true
  }

  /**
   * Aircraft whose latest position is inside the circle. sinceRxMs ≤ 0: their latest sample only (first poll);
   * otherwise every sample they received after sinceRxMs.
   */
  view(lat: number, lon: number, radiusNm: number, sinceRxMs: number): Sample[] {
    const out: Sample[] = []
    for (const list of this.#byHex.values()) {
      const last = list[list.length - 1]
      if (distanceNm(lat, lon, last.lat, last.lon) > radiusNm) continue
      if (sinceRxMs <= 0) out.push(last)
      else for (const s of list) if (s.rxMs > sinceRxMs) out.push(s)
    }
    return out
  }

  /** Every stored sample of one aircraft received after sinceRxMs, oldest first. */
  track(hex: string, sinceRxMs: number): Sample[] {
    return (this.#byHex.get(hex) ?? []).filter((s) => s.rxMs > sinceRxMs)
  }

  latest(hex: string): Sample | null {
    const list = this.#byHex.get(hex)
    return list ? list[list.length - 1] : null
  }

  /** Drops samples with rxMs < nowMs − horizon; an aircraft left with none is forgotten, Deduper included. */
  prune(nowMs: number): void {
    const cutoff = nowMs - this.#horizonMs
    for (const [hex, list] of this.#byHex) {
      // ponytail: assumes rxMs never decreases within one hex (one poller, one server clock). With several
      // pollers into one store (M6 dual source), switch this to a filter.
      let k = 0
      while (k < list.length && list[k].rxMs < cutoff) k++
      if (k === 0) continue
      this.#size -= k
      if (k === list.length) {
        this.#byHex.delete(hex)
        this.#dedupe.forget(hex)
      } else {
        list.splice(0, k)
      }
    }
  }

  /** Number of stored samples (all aircraft). */
  get size(): number {
    return this.#size
  }
}

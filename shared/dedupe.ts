import type { Sample } from './types.ts'

/**
 * Drops re-served and out-of-order positions. adsb.lol often re-serves the same position;
 * its tMs then repeats within a few ms of rounding. Genuine ADS-B positions are ≥ ~500 ms apart.
 */
export class Deduper {
  #last = new Map<string, { tMs: number; lat: number; lon: number }>()

  accept(s: Sample): boolean {
    const p = this.#last.get(s.hex)
    if (p) {
      const dt = s.tMs - p.tMs
      if (dt <= 5) return false
      if (dt < 100 && s.lat === p.lat && s.lon === p.lon) return false
    }
    this.#last.set(s.hex, { tMs: s.tMs, lat: s.lat, lon: s.lon })
    return true
  }

  forget(hex: string): void {
    this.#last.delete(hex)
  }
}

// client/scene/marchPace.ts
// How fine the cloud volume's march is walked (cloudVolume.ts: the share of the view's size its rays are walked at), by how long the
// frames take. Pure (no Cesium, no DOM), so Node tests cover it. It starts at half the size. The first eight seconds are not looked
// at (the view is loading then, and slow whatever the march). After that frames are looked at in runs of a second and a half; after
// three slow runs in a row it goes one step coarser (0.35, then 0.25), lets one run pass (the new pass is being made), and looks at
// the next: when the frames did not get a tenth quicker, the march is not what makes them slow (the globe's tiles are loading, the
// page is busy), so the step is taken back and nothing is tried again. It never goes finer otherwise, so it cannot go to and fro;
// reset() (the weather hidden and shown again) starts over.
// ponytail: it never goes back to a finer march while the weather shows, though the view may have become cheap again (a display's
// 60 frames a second hide how much time a frame has to spare). Upgrade: the pass's own time from a GPU timer query.

/** The march's sizes, the finest first: the share of the view's width and height its rays are walked at. */
export const MARCH_SCALES: readonly number[] = [0.5, 0.35, 0.25]
const RUN_MS = 1500 // frames are judged in runs of this long
const SLOW_MS = 21 // a run whose frames take longer than this on average is slow (under 48 frames a second)
const SLOW_RUNS = 3 // this many slow runs in a row are "a while"
const HELPED = 0.9 // a coarser march helped when the frames then take no more than this share of what they took
const GAP_MS = 250 // a longer wait is not a frame (the tab was hidden, the page stalled): not counted
const START_MS = 8000 // the frames of this long after the start are not looked at: the view is loading

export class MarchPace {
  #level = 0
  #state: 'watch' | 'settle' | 'judge' | 'held' = 'watch'
  #age = 0 // the frames' time since the start, ms, while it is under START_MS
  #sum = 0 // the run in hand: its frames' time, ms, and how many
  #frames = 0
  #slow = 0 // slow runs in a row
  #before = 0 // the frames' mean time before the step being judged

  /** The share of the view's size to walk the march at now. */
  get scale(): number {
    return MARCH_SCALES[this.#level]
  }

  /** A frame took dtMs since the one before; the scale to walk at. */
  frame(dtMs: number): number {
    if (this.#state === 'held' || !(dtMs > 0) || dtMs > GAP_MS) return this.scale
    if (this.#age < START_MS) {
      this.#age += dtMs
      return this.scale
    }
    this.#sum += dtMs
    this.#frames++
    if (this.#sum < RUN_MS) return this.scale
    const mean = this.#sum / this.#frames
    this.#sum = this.#frames = 0
    if (this.#state === 'settle') this.#state = 'judge'
    else if (this.#state === 'judge') {
      if (mean <= HELPED * this.#before) this.#state = 'watch'
      else {
        this.#level--
        this.#state = 'held'
      }
    } else {
      this.#slow = mean > SLOW_MS ? this.#slow + 1 : 0
      if (this.#slow >= SLOW_RUNS && this.#level < MARCH_SCALES.length - 1) {
        this.#before = mean
        this.#level++
        this.#slow = 0
        this.#state = 'settle'
      }
    }
    return this.scale
  }

  /** From the start again: half the size, watching. */
  reset(): void {
    this.#level = 0
    this.#state = 'watch'
    this.#age = this.#sum = this.#frames = this.#slow = this.#before = 0
  }
}

// client/history/feed.ts
// The past as ordinary samples. History mode loads half-hour slots (HistorySlot: per aircraft, columns of a position per
// kept slice) for the circle of the view. The feed keeps those columns as they arrived (no copy, no object per position:
// a few tens of bytes a position) and builds Samples only for what take() and samplesOf() return. take() gives the app
// the samples that fell in a time window (what the replay clock passed since the last frame), samplesOf() one aircraft's.
// Fleet dead-reckons its newest sample along trackDeg at gsKt, so those two are made to point at the NEXT position and to
// carry the reported speed: the dead reckoning then is an interpolation between the points. Samples of one aircraft in two
// half hours are independent (the last point of a slot has no next one), so a slot never needs its neighbour.
import type { HistorySlot, HistoryTrack } from '../../shared/api.ts'
import { bearingDeg, distanceNm } from '../../shared/geo.ts'
import { EVERYTHING_NM, stepFor } from '../../shared/history.ts'
import type { AircraftInfo } from '../../shared/info.ts'
import type { Sample } from '../../shared/types.ts'

export interface Circle {
  lat: number
  lon: number
  nm: number
}

// A step shorter than this has no direction of its own (parked, jitter): the aircraft keeps the direction it had. Small
// enough that a taxiing aircraft (15 kt is 0.04 nm in 10 s) has one; Fleet treats an aircraft on the ground under 3 kt as
// parked whatever its direction.
const MIN_STEP_NM = 0.005
// A climb rate is stated only over a step this short; across a longer gap it would average several phases of flight.
const MAX_RATE_STEP_S = 120

/** One aircraft in one slot: its columns as they arrived (not copied, never changed here) and where its flags start. */
interface Rec {
  tr: HistoryTrack
  n: number // positions
  off: number // index of its first flag in Held.dir
}

interface Held {
  slotMs: number
  stepS: number // seconds between its slices
  circle: Circle // what it was fetched for
  recs: Rec[] // dense, for the frame loop
  byHex: Map<string, Rec>
  // One byte per position: 1 when the step to the next position has a direction of its own (the last position: 0).
  dir: Uint8Array
  firstMs: number // the earliest and latest sample of any aircraft in it
  lastMs: number
}

/** The sample at position i of r: speed, direction and climb derived from the next point (see the file header). */
function sampleAt(h: Held, r: Rec, i: number): Sample {
  const tr = r.tr
  const lat = tr.lat[i]
  const lon = tr.lon[i]
  const alt = tr.alt[i]
  let gs: number | null = tr.gs[i] ?? null
  let rate: number | null = null
  if (i + 1 < r.n) {
    const dt = tr.t[i + 1] - tr.t[i] // s
    if (gs === null && dt > 0) gs = (distanceNm(lat, lon, tr.lat[i + 1], tr.lon[i + 1]) / dt) * 3600
    const next = tr.alt[i + 1]
    if (typeof alt === 'number' && typeof next === 'number' && dt > 0 && dt <= MAX_RATE_STEP_S) {
      rate = ((next - alt) * 60) / dt // × 60 first: 1,000 ft in 60 s is exactly 1,000 fpm
    }
  }
  // The direction of the latest step, this one or an earlier, that has one of its own. The last point has no step (its
  // flag is 0), so it takes the one before it; a step too short to have one keeps the one before; none yet: null.
  let j = i
  while (j >= 0 && h.dir[r.off + j] === 0) j--
  const trk = j < 0 ? null : bearingDeg(tr.lat[j], tr.lon[j], tr.lat[j + 1], tr.lon[j + 1])
  const tMs = h.slotMs + tr.t[i] * 1000
  return {
    hex: tr.hex, tMs, rxMs: tMs, lat, lon, onGround: alt === 'g',
    altBaroFt: typeof alt === 'number' ? alt : null, altGeomFt: null, gsKt: gs, trackDeg: trk,
    trueHeadingDeg: null, rollDeg: null, baroRateFpm: rate, geomRateFpm: null, navQnhHpa: null, version: null, nic: null,
    quality: 'adsb2', nM: tr.nM, callsign: tr.callsign, typeCode: null, reg: null,
  }
}

/**
 * Pushes onto out the samples of r with fromMs < tMs ≤ toMs, in time order: a binary search of its time column, then
 * the window itself.
 */
function collect(h: Held, r: Rec, fromMs: number, toMs: number, out: Sample[]): void {
  const t = r.tr.t
  const n = r.n
  const base = h.slotMs
  if (base + t[n - 1] * 1000 <= fromMs || base + t[0] * 1000 > toMs) return // none of it is in the window
  let lo = 0 // the first position after fromMs
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (base + t[mid] * 1000 <= fromMs) lo = mid + 1
    else hi = mid
  }
  for (let i = lo; i < n && base + t[i] * 1000 <= toMs; i++) out.push(sampleAt(h, r, i))
}

export class HistoryFeed {
  readonly #slots = new Map<number, Held>()
  #order: Held[] = [] // the same, oldest slot first

  /**
   * Holds slot's aircraft for that circle (replacing what it held for the same slotMs). The slot's arrays are kept, not
   * copied: do not change them afterwards.
   * ponytail: the columns stay as parsed JSON and only the direction is precomputed, as one flag byte a position (does
   * the step to the next position have a direction of its own); speed and climb come from the neighbours when a sample is
   * built, so take() and samplesOf() make new Sample objects on every call: keep what you need rather than asking again
   * each frame. Measured in Node (8-byte pointers), tracks of 150 positions: ~0.04 µs a position here and ~44 bytes a
   * position held, ~59 when every track misses a speed (V8 then boxes its whole speed column); the feed's own part is ~2.
   * A track adds ~380 bytes of its own (strings, array headers), so short tracks cost more a position.
   * Upgrade: copy the columns into typed arrays (Int32 degrees × 1e5, Int16 speeds in 0.1 kt and altitudes in 25 ft units,
   * Uint16 times in s: ~15 bytes a position).
   */
  add(slot: HistorySlot, c: Circle): void {
    let positions = 0
    for (const tr of slot.aircraft) positions += tr.t.length
    const dir = new Uint8Array(positions)
    const byHex = new Map<string, Rec>()
    let off = 0
    for (const tr of slot.aircraft) {
      const n = tr.t.length
      if (n === 0) continue
      for (let i = 0; i + 1 < n; i++) {
        if (distanceNm(tr.lat[i], tr.lon[i], tr.lat[i + 1], tr.lon[i + 1]) >= MIN_STEP_NM) dir[off + i] = 1
      }
      byHex.set(tr.hex, { tr, n, off })
      off += n
    }
    const recs = [...byHex.values()]
    let firstMs = Infinity
    let lastMs = -Infinity
    for (const r of recs) {
      const first = slot.slotMs + r.tr.t[0] * 1000
      const last = slot.slotMs + r.tr.t[r.n - 1] * 1000
      if (first < firstMs) firstMs = first
      if (last > lastMs) lastMs = last
    }
    this.#slots.set(slot.slotMs, {
      slotMs: slot.slotMs, stepS: slot.stepS, circle: { lat: c.lat, lon: c.lon, nm: c.nm },
      recs, byHex, dir, firstMs, lastMs,
    })
    this.#reorder()
  }

  /**
   * The slot is held for a circle that covers c: c lies wholly inside the held circle (distance of the centres + c.nm ≤
   * held.nm; a held circle of EVERYTHING_NM holds the whole world, so any centre does) and the held slices are at least as
   * fine as the view wants (held step ≤ stepFor(c.nm)): zooming in from a wide view asks again for finer slices.
   */
  covers(slotMs: number, c: Circle): boolean {
    const h = this.#slots.get(slotMs)
    if (h === undefined) return false
    if (h.stepS > stepFor(c.nm)) return false
    if (h.circle.nm >= EVERYTHING_NM) return true
    return distanceNm(h.circle.lat, h.circle.lon, c.lat, c.lon) + c.nm <= h.circle.nm
  }

  has(slotMs: number): boolean {
    return this.#slots.has(slotMs)
  }

  /** Seconds between the slices held for that half hour; null when it is not held. */
  stepOf(slotMs: number): number | null {
    return this.#slots.get(slotMs)?.stepS ?? null
  }

  /**
   * Every held sample with fromMs < tMs ≤ toMs, all aircraft, in time order (equal times: older slot, then the slot's
   * own aircraft order). New Sample objects on every call.
   * Runs every frame: a binary search per aircraft, and slots that cannot reach the window are skipped whole.
   */
  take(fromMs: number, toMs: number): Sample[] {
    const out: Sample[] = []
    if (!(fromMs < toMs)) return out // empty, backwards, or not a number
    for (const h of this.#order) {
      if (h.lastMs <= fromMs || h.firstMs > toMs) continue
      for (const r of h.recs) collect(h, r, fromMs, toMs, out)
    }
    if (out.length > 1) out.sort((a, b) => a.tMs - b.tMs) // stable: ties keep the order they were gathered in
    return out
  }

  /** One aircraft's held samples with fromMs < tMs ≤ toMs, in time order. New Sample objects on every call. */
  samplesOf(hex: string, fromMs: number, toMs: number): Sample[] {
    const out: Sample[] = []
    if (!(fromMs < toMs)) return out
    for (const h of this.#order) {
      const r = h.byHex.get(hex)
      if (r !== undefined) collect(h, r, fromMs, toMs, out) // slots do not overlap: still in time order
    }
    return out
  }

  /**
   * What the files know of it: callsign, squawk, type and the category the type implies (HistoryTrack.type and .category:
   * the server's address table gave them; the icon follows the category), each from the newest held slot that has one;
   * the rest null, military false, route null. Null when no held slot has the hex. A fresh object each call.
   * ponytail: no time argument, so it answers from the newest held slot whatever the replay time: a callsign (or squawk)
   * that changed between held slots shows the later one. Upgrade: take the replay time and prefer the slot that holds it.
   */
  info(hex: string): AircraftInfo | null {
    let found = false
    let callsign: string | null = null
    let squawk: string | null = null
    let typeCode: string | null = null
    let category: string | null = null
    for (let i = this.#order.length - 1; i >= 0; i--) {
      const r = this.#order[i].byHex.get(hex)
      if (r === undefined) continue
      found = true
      callsign ??= r.tr.callsign
      squawk ??= r.tr.squawk
      typeCode ??= r.tr.type ?? null // a server older than the field sends none
      category ??= r.tr.category ?? null // likewise
      if (callsign !== null && squawk !== null && typeCode !== null && category !== null) break
    }
    if (!found) return null
    return {
      hex, callsign, reg: null, typeCode, category, squawk, emergency: null, military: false, route: null,
    }
  }

  /** Drops every slot not in keep. */
  retain(keep: ReadonlySet<number>): void {
    let dropped = false
    for (const ms of this.#slots.keys()) {
      if (keep.has(ms)) continue
      this.#slots.delete(ms)
      dropped = true
    }
    if (dropped) this.#reorder()
  }

  clear(): void {
    this.#slots.clear()
    this.#order = []
  }

  #reorder(): void {
    this.#order = [...this.#slots.values()].sort((a, b) => a.slotMs - b.slotMs)
  }
}

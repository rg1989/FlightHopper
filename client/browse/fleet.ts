// client/browse/fleet.ts
// Every aircraft in the browse view: its newest sample, dead-reckoned to the render time. Built for thousands of
// aircraft per frame: one reused array of reused FleetEntry objects, the trig that does not change between frames
// done once per sample, and no allocation in entries(). The full estimator (Track) runs only for the chased aircraft.
import type { AircraftInfo } from '../../shared/info.ts'
import type { Sample } from '../../shared/types.ts'
import type { FleetEntry } from '../types.ts'

const FT = 0.3048
const R_NM = 3440.065 // the sphere of shared/geo.ts destination(), so both agree
const RAD = Math.PI / 180
const DEG = 180 / Math.PI
// How long an aircraft outlives its newest sample (dead-reckoned all the way, then hidden and forgotten): 3 of its own
// usual gaps between samples, at least MIN_STALE_S and at least the server's hint (setHintS). A 1 Hz aircraft goes 60 s
// after its signal ends; one refreshed every 72 s (a hero replay) or every 30 min (the globe view) keeps flying between.
const MIN_STALE_S = 60
const GAP_GAIN = 0.3 // exponential average of the gaps
const PARKED_KT = 3 // on the ground and slower than this: not moving
// The server sends an aircraft's info only when it changes, so a hex that drops out of the view and comes back must
// find its info here. ponytail: fixed 1 h after its newest sample; enough for panning away and back, and it bounds
// memory for worldwide views (~0.3 kB per hex). Upgrade: ask the server for info of hexes that have none.
const INFO_KEEP_MS = 3_600_000

interface Slot {
  e: FleetEntry // the reused output object
  s: Sample | null // newest sample
  tMs: number // newest sample time, server clock
  lat: number // newest sample position, degrees
  lon: number
  moving: boolean // track and speed known, and not parked
  gapS: number // average gap between its samples, s; 0 before a second one
  // Great-circle destination terms that do not depend on the distance (see shared/geo.ts destination()).
  sinLat: number
  cosLat: number
  sinTrk: number
  cosTrk: number
  lonRad: number
  radPerS: number // angular speed along the great circle, radians per second
}

interface InfoRec {
  info: AircraftInfo
  seenMs: number // newest sample tMs of the hex when it was pruned; -Infinity while it has none
}

/** Height of the aircraft in WGS84 ellipsoidal metres: geom when it is HAE (v2), else baro (or geom) + N, ground → N. */
function heightM(s: Sample): number {
  if (s.onGround) return s.nM
  if (s.version === 2 && s.altGeomFt !== null) return s.altGeomFt * FT
  const ft = s.altBaroFt ?? s.altGeomFt
  return ft === null ? s.nM : ft * FT + s.nM
}

function load(slot: Slot, s: Sample): void {
  const e = slot.e
  if (slot.s !== null) {
    const gap = (s.tMs - slot.tMs) / 1000
    slot.gapS = slot.gapS === 0 ? gap : slot.gapS + GAP_GAIN * (gap - slot.gapS)
  }
  slot.s = s
  slot.tMs = s.tMs
  slot.lat = s.lat
  slot.lon = s.lon
  e.hM = heightM(s)
  e.altFt = s.altBaroFt ?? s.altGeomFt
  e.onGround = s.onGround
  e.trackDeg = s.trackDeg
  e.gsKt = s.gsKt
  e.vsFpm = s.baroRateFpm ?? s.geomRateFpm
  e.quality = s.quality
  const trk = s.trackDeg
  const gs = s.gsKt
  slot.moving = trk !== null && gs !== null && gs > 0 && !(s.onGround && gs < PARKED_KT)
  if (!slot.moving) return
  const lat = s.lat * RAD
  const t = trk! * RAD
  slot.sinLat = Math.sin(lat)
  slot.cosLat = Math.cos(lat)
  slot.sinTrk = Math.sin(t)
  slot.cosTrk = Math.cos(t)
  slot.lonRad = s.lon * RAD
  slot.radPerS = gs! / 3600 / R_NM
}

/**
 * Moves the entry to tMs: along the track at ground speed for (tMs − sample) seconds, clamped to ±staleS. A tMs before
 * the sample (the chase draws the fleet at its delayed render time) moves it back along the track; its age stays 0.
 */
function reckon(slot: Slot, tMs: number, floorS: number): void {
  const e = slot.e
  const ageS = (tMs - slot.tMs) / 1000
  e.ageS = ageS > 0 ? ageS : 0
  e.gapS = slot.gapS
  const g3 = 3 * slot.gapS
  e.staleS = g3 > floorS ? g3 : floorS
  if (!slot.moving || ageS === 0) {
    e.lat = slot.lat
    e.lon = slot.lon
    return
  }
  const t = ageS < e.staleS ? (ageS > -e.staleS ? ageS : -e.staleS) : e.staleS
  const d = t * slot.radPerS
  const sinD = Math.sin(d)
  const cosD = Math.cos(d)
  const sinLat2 = slot.sinLat * cosD + slot.cosLat * sinD * slot.cosTrk
  e.lat = Math.asin(sinLat2) * DEG
  const lon = (slot.lonRad + Math.atan2(slot.sinTrk * sinD * slot.cosLat, cosD - slot.sinLat * sinLat2)) * DEG
  e.lon = ((lon + 540) % 360) - 180
}

export class Fleet {
  readonly #byHex = new Map<string, Slot>()
  readonly #slots: Slot[] = [] // dense, same order as #out
  readonly #out: FleetEntry[] = [] // what entries() returns, always the same array
  readonly #info = new Map<string, InfoRec>()
  #lastTMs: number | null = null // time of the last entries() call
  #floorS = MIN_STALE_S
  #hintS = 0 // the last setHintS value

  /** Keeps the newest sample per hex (older and same-tMs samples are ignored) and the latest info per hex. */
  ingest(samples: Sample[], info?: AircraftInfo[]): void {
    for (const s of samples) {
      let slot = this.#byHex.get(s.hex)
      if (slot === undefined) slot = this.#add(s.hex)
      else if (s.tMs <= slot.tMs) continue
      load(slot, s)
      reckon(slot, this.#lastTMs ?? s.tMs, this.#floorS)
    }
    if (info === undefined) return
    for (const i of info) {
      const rec = this.#info.get(i.hex)
      if (rec === undefined) this.#info.set(i.hex, { info: i, seenMs: -Infinity })
      else rec.info = i
      const slot = this.#byHex.get(i.hex)
      if (slot !== undefined) slot.e.info = i
    }
  }

  /**
   * Every aircraft dead-reckoned to tServerMs. The array and its objects are reused by the next call (and changed by
   * ingest/prune): read them now, never keep them across frames.
   */
  entries(tServerMs: number): readonly FleetEntry[] {
    this.#lastTMs = tServerMs
    const slots = this.#slots
    const floorS = this.#floorS
    for (let i = 0; i < slots.length; i++) reckon(slots[i], tServerMs, floorS)
    return this.#out
  }

  /**
   * The server's expected refresh of this view says how long an aircraft may go without a sample: at least 60 s. When
   * it drops (zooming in), each aircraft's average gap is capped at the new refresh interval (s / 2.5): gaps measured
   * in a coarser view no longer describe what to expect, and would keep a lost aircraft flying for minutes.
   */
  setHintS(s: number): void {
    const floor = Number.isFinite(s) && s > MIN_STALE_S ? s : MIN_STALE_S
    const hint = Number.isFinite(s) && s > 0 ? s : 0
    if (hint < this.#hintS) {
      const cap = Math.max(hint / 2.5, 1)
      for (const slot of this.#slots) if (slot.gapS > cap) slot.gapS = cap
    }
    this.#hintS = hint
    this.#floorS = floor
  }

  /** The hex's entry as of the last entries() call (or its newest sample, if that is newer). */
  get(hex: string): FleetEntry | undefined {
    return this.#byHex.get(hex)?.e
  }

  /** The hex's newest sample (e.g. its callsign when no info has arrived, or a seed for the chase estimator). */
  newest(hex: string): Sample | undefined {
    return this.#byHex.get(hex)?.s ?? undefined
  }

  /** Forgets hexes whose newest sample is older than max(minAgeS, their staleS) at tServerMs. */
  prune(tServerMs: number, minAgeS: number): void {
    const slots = this.#slots
    const out = this.#out
    for (let i = slots.length - 1; i >= 0; i--) {
      const slot = slots[i]
      if (slot.tMs >= tServerMs - Math.max(minAgeS, slot.e.staleS) * 1000) continue
      const last = slots.pop()!
      const lastE = out.pop()!
      if (last !== slot) {
        slots[i] = last
        out[i] = lastE
      }
      this.#byHex.delete(slot.e.hex)
      const rec = this.#info.get(slot.e.hex)
      if (rec !== undefined) rec.seenMs = slot.tMs
    }
    for (const [hex, rec] of this.#info) {
      if (rec.seenMs < tServerMs - INFO_KEEP_MS && !this.#byHex.has(hex)) this.#info.delete(hex)
    }
  }

  get size(): number {
    return this.#slots.length
  }

  #add(hex: string): Slot {
    const e: FleetEntry = {
      hex, lat: 0, lon: 0, hM: 0, altFt: null, onGround: false, trackDeg: null, gsKt: null, vsFpm: null, ageS: 0,
      staleS: this.#floorS, gapS: 0, quality: 'other', info: this.#info.get(hex)?.info ?? null,
    }
    const slot: Slot = {
      e, s: null, tMs: -Infinity, lat: 0, lon: 0, moving: false, gapS: 0,
      sinLat: 0, cosLat: 1, sinTrk: 0, cosTrk: 1, lonRad: 0, radPerS: 0,
    }
    this.#byHex.set(hex, slot)
    this.#slots.push(slot)
    this.#out.push(e)
    return slot
  }
}

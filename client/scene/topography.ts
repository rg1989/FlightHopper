// client/scene/topography.ts
// The topography toggle (design D2–D5): the relief grows out of the flat map and sinks back by animating
// scene.verticalExaggeration. The imagery stays draped; aircraft keep their true heights, only the ground moves.
import type { Cartographic, Scene } from 'cesium'
import type { Airport } from '../../shared/airports.ts'
import { distanceNm } from '../../shared/geo.ts'
import type { TerrainFrame } from '../types.ts'
import { TOPO_ON, rescaleSampledM, smoothstep } from './exaggeration.ts'

export const TOPO_ANIM_MS = 2500 // grow / sink duration (smoothstep)
export const NUDGE_DELAY_MS = 500 // PoC: the pickers' workers are idle by then
export const NUDGE = 1e-7
export const HERO_RELH_KM = 30 // a hero airport this close gives the flat plane its runway height
const KM_PER_NM = 1.852
const DEG = 180 / Math.PI
const FLAT_F = 1e-4 // a factor below this draws a flat ground: exaggeration.ts's FLAT_F, which it does not export
const MEMO_RADIUS_M = 50 // a memo answers this close to where it was read: gate GE's longest run at 70 m/s is 43 m

type ExaggeratedScene = Pick<Scene, 'verticalExaggeration' | 'verticalExaggerationRelativeHeight'> // a Scene, or a test fake
type GroundPoint = Pick<Cartographic, 'latitude' | 'longitude'> // a Cartographic, or a test's plain point (radians)

/**
 * The last globe.getHeight reading under one followed point (the chased aircraft, or the chase camera), kept by
 * Topography.ground with the point it was read at. Make one per point, once (groundMemo()); set ok = false to forget
 * it (a new selection).
 */
export interface GroundMemo {
  m: number // the reading: drawn height, HAE m
  f: number // the factor the tiles held when it was read (that frame's fSampled)
  relHM: number // the plane it was read around (that frame's relHM)
  lat: number // where it was read, radians
  lon: number
  ok: boolean // false until the first reading, and after a reset
}

/** An empty memo for Topography.ground. */
export function groundMemo(): GroundMemo {
  return { m: 0, f: 0, relHM: 0, lat: 0, lon: 0, ok: false }
}

/**
 * The only writer of scene.verticalExaggeration and scene.verticalExaggerationRelativeHeight (relH, the height the
 * relief flattens towards). The factor is TOPO_ON while on (never exactly 1: crossing 1 rebuilds every loaded tile)
 * and 0 while flat. Call update() first in scene.preUpdate, before any globe.getHeight.
 *
 * The nudge works around a race in Cesium's TerrainPicker: every factor or relH change resets each tile's picker, and
 * a picker worker that returns after a reset can leave the tile answering globe.getHeight with undefined until the
 * next change (PoC: 40 of 80 readings under the aircraft after animations). So once the workers are idle, 0.5 s after
 * an animation or a re-latch, the factor changes once more by 1e-7 (PoC: 0 of 80). During an animation every frame is
 * a change, so readings still fail there (gate GE: 175 frames in 10 toggles, runs of up to 37): ground() bridges them
 * with a GroundMemo.
 */
export class Topography {
  #scene: ExaggeratedScene
  #durationMs: number
  #nudgeDelayMs: number
  #frame: TerrainFrame = { fSampled: 0, fNow: 0, relHM: 0 }
  #on: boolean
  #f: number // factor written last, the one the tiles hold on the next preUpdate
  #relH = 0 // the ellipsoid until the first latch
  #from = 0
  #to: number
  #t0: number | null = null // animation start; null at rest
  #nudgeAt: number | null = null

  /** Starts at rest, on (TOPO_ON) or flat (0). */
  constructor(scene: ExaggeratedScene, on: boolean, opts: { durationMs?: number; nudgeDelayMs?: number } = {}) {
    this.#scene = scene
    this.#on = on
    this.#f = this.#to = on ? TOPO_ON : 0
    this.#durationMs = opts.durationMs ?? TOPO_ANIM_MS
    this.#nudgeDelayMs = opts.nudgeDelayMs ?? NUDGE_DELAY_MS
    scene.verticalExaggeration = this.#f
  }

  get on(): boolean {
    return this.#on
  }

  /** relH (HAE m), drawn from the next update() on. */
  get relHM(): number {
    return this.#relH
  }

  get animating(): boolean {
    return this.#t0 !== null
  }

  /**
   * Grow (true) or flatten (false), animated from the current factor, so a reversal mid-animation has no jump.
   * A flatten from rest latches relHM (pickRelHM) as the flat plane; mid-animation, and when growing, the plane stays.
   */
  set(on: boolean, nowMs: number, relHM: number): void {
    if (on === this.#on) return
    if (!on && this.#t0 === null && Number.isFinite(relHM)) this.#relH = relHM
    this.#on = on
    this.#from = this.#f
    this.#to = on ? TOPO_ON : 0
    this.#t0 = nowMs
  }

  /** A new plane while fully flat and at rest (a new selection, D4). Ignored otherwise: the relief would jump. */
  relatch(relHM: number): void {
    if (!this.#on && this.#t0 === null && Number.isFinite(relHM)) this.#relH = relHM
  }

  /**
   * Advances the animation and writes both values. Returns the frame's factors and relH in one object that is reused
   * every frame: read it during the frame, never keep it.
   */
  update(nowMs: number): TerrainFrame {
    const fr = this.#frame
    fr.fSampled = this.#f
    if (this.#t0 !== null) {
      // ponytail: a stall (hidden tab) skips ahead by its length, so the ground correction spans a large factor step
      // for one frame (see rescaleSampledM). Upgrade: move #t0 forward by the stall.
      const u = (nowMs - this.#t0) / this.#durationMs
      if (u < 1) this.#f = this.#from + (this.#to - this.#from) * smoothstep(u)
      else {
        // Also for a NaN clock: the animation ends on its exact end value, never on NaN.
        this.#f = this.#to
        this.#t0 = null
        this.#nudgeAt = nowMs + this.#nudgeDelayMs
      }
    } else if (this.#nudgeAt !== null && nowMs >= this.#nudgeAt) {
      // Toggles between the end value and 1e-7 above it, so re-latches never add up.
      this.#f = this.#f === this.#to ? this.#to + NUDGE : this.#to
      this.#nudgeAt = null
    }
    const s = this.#scene
    if (s.verticalExaggerationRelativeHeight !== this.#relH) {
      s.verticalExaggerationRelativeHeight = this.#relH
      if (this.#t0 === null) this.#nudgeAt = nowMs + this.#nudgeDelayMs // a relH change resets the pickers too
    }
    s.verticalExaggeration = this.#f
    fr.fNow = this.#f
    fr.relHM = this.#relH
    return fr
  }

  /**
   * A globe.getHeight reading at `at`, taken this frame (it reflects the previous render's factor) → the ground drawn
   * this frame. undefined (tile not loaded, or the picker race) → null, or, with a memo read around the same plane
   * within 50 m of `at`, the memo's reading rescaled to this frame's factor. A defined reading refills the memo; a memo
   * without the point is neither read nor refilled. A fixed point's drawn height follows the factor exactly, so the
   * memo's error is the ground's change between where it was read and `at`, at most 50 m apart. Farther it answers
   * null: the chase camera reads up to five points a frame, up to 2.9 km apart. A memo read while flat holds no relief:
   * it answers the plane while this frame is flat too, and null (unknown) once the relief grows.
   * ponytail: a grow from flat starts with a flat memo, so a run of undefined readings from its start leaves the ground
   * unknown: the aircraft keeps its estimate and the chase camera has no clearance correction, so it can clip a rising
   * slope for up to the run's length (gate GE: 37 frames, ~0.6 s). A memo read in a grow's first frames multiplies the
   * picker's own error (0.3 mm for 100 m triangles, 3 mm for 300 m) by fNow/f, up to ~1,300 over a 37-frame run.
   * Upgrade for both: drawnHeightM(sampleTerrainMostDetailed(point), fNow, relH) (raw heights, async, e.g. 4 Hz during
   * animations). The check is the harness's ?memo=1 (true heights under the aircraft and the camera): a clearance
   * computed from this result cannot show either.
   * ponytail: the chase camera starts each frame at its uncorrected point, farther than 50 m from its last reading while
   * a large correction holds (range·(cos p − cos p′)), so its memo lapses then: null, no correction, as without a memo.
   * Upgrade: one memo per clearance pass.
   */
  ground(sampledM: number | undefined, frame: TerrainFrame, memo?: GroundMemo, at?: GroundPoint): number | null {
    if (sampledM === undefined) {
      if (!memo?.ok || at === undefined || memo.relHM !== frame.relHM || (memo.f < FLAT_F && frame.fNow >= FLAT_F)) return null
      const m = distanceNm(memo.lat * DEG, memo.lon * DEG, at.latitude * DEG, at.longitude * DEG) * KM_PER_NM * 1000
      return m > MEMO_RADIUS_M ? null : rescaleSampledM(memo.m, memo.f, frame.fNow, frame.relHM)
    }
    if (memo && at) {
      memo.m = sampledM
      memo.f = frame.fSampled
      memo.relHM = frame.relHM
      memo.lat = at.latitude
      memo.lon = at.longitude
      memo.ok = true
    }
    return rescaleSampledM(sampledM, frame.fSampled, frame.fNow, frame.relHM)
  }
}

/**
 * The flat plane for a flatten or re-latch at (lat, lon), HAE m (D4): the runway height of the nearest airport within
 * 30 km (the mean of its runway ends' threshold heights), so runway and touchdown agree; else the drawn ground under
 * the aircraft; else 0 (the ellipsoid). While the ground is flat globe.getHeight answers the old plane everywhere, so
 * pass null or a true height (sampleTerrainMostDetailed) then.
 * ponytail: one plane per airport. At LLBG the runway ends span 49–61 m, so a touchdown far from the mean snaps the
 * aircraft by up to 7.4 m while flat. Upgrade: the nearest runway end’s height.
 */
export function pickRelHM(lat: number, lon: number, drawnGroundM: number | null, airports: readonly Airport[]): number {
  let best: Airport | null = null
  let bestKm = HERO_RELH_KM
  for (const a of airports) {
    const km = distanceNm(lat, lon, a.lat, a.lon) * KM_PER_NM
    if (km <= bestKm && a.runways.length > 0) {
      best = a
      bestKm = km
    }
  }
  if (best !== null) {
    let sum = 0
    let n = 0
    for (const r of best.runways) {
      for (const e of r.ends) {
        sum += e.thrHaeM
        n++
      }
    }
    return sum / n
  }
  return drawnGroundM !== null && Number.isFinite(drawnGroundM) ? drawnGroundM : 0
}

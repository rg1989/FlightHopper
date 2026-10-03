// client/track/landing.ts
// The selected aircraft, no longer heard on its final approach: its estimated landing (shared/landing.ts) in place of a
// pose frozen in the air. A track goes stale 8 s after its newest sample and holds that pose; from then this flies the
// aircraft on to the runway it was landing on, to a stop. When it was not landing (no runway ahead, climbing, too high), or
// before the runways are in, the frozen pose stands. A new sample ends the estimate: the track's own state is back.
// ponytail: the track's state then jumps from the estimate to where the aircraft is (a go-around, or a landing that went
// otherwise). Upgrade: blend, as Track does at a re-join.
// ponytail: the height comes down by the aircraft's own altitude over the runway's elevation, so an altimeter's error is
// a step at the touchdown, where the app puts the wheels on the ground drawn.
import { Runways, landingEnd, landingPose, type LandingEnd, type LastHeard, type RunwayTable } from '../../shared/landing.ts'
import type { RenderState } from '../types.ts'
import { EXTRAP_S } from './track.ts'

const FT = 0.3048

export class LandingEstimate {
  readonly #load: () => Promise<RunwayTable>
  #runways: Runways | null = null
  #asked = false
  // The freeze judged last: its aircraft and frozen place, the state it was last heard in, and the runway (null: no landing).
  #of: { hex: string; lat: number; lon: number; last: LastHeard; end: LandingEnd | null } | null = null

  /** load fetches the runway table (public/airports/runways.json): called once, the first time a stale state comes. */
  constructor(load: () => Promise<RunwayTable>) {
    this.#load = load
  }

  /**
   * s as it is, or, when it is stale, older than lostAfterS (the signal counts as lost: a view refreshed every 13 s leaves
   * its aircraft stale between two answers) and its aircraft was landing, the state of its estimated landing at s's time.
   */
  apply(s: RenderState, lostAfterS = 0): RenderState {
    if (s.mode !== 'stale') {
      this.#of = null
      return s
    }
    if (s.ageS <= lostAfterS) return s
    if (this.#runways === null) {
      if (!this.#asked) {
        this.#asked = true
        this.#load().then((t) => (this.#runways = new Runways(t)), (e: unknown) => console.warn('FlightHopper: no runways for landings:', e))
      }
      return s
    }
    if (this.#of === null || this.#of.hex !== s.hex || this.#of.lat !== s.lat || this.#of.lon !== s.lon) {
      const altMslFt = s.altMslFt ?? s.altBaroFt ?? null
      const known = !s.onGround && altMslFt !== null && s.trackDeg !== null && s.gsKt !== null
      const last: LastHeard = { lat: s.lat, lon: s.lon, altMslFt: altMslFt ?? 0, trackDeg: s.trackDeg ?? 0, gsKt: s.gsKt ?? 0, vsFpm: s.vsFpm }
      this.#of = { hex: s.hex, lat: s.lat, lon: s.lon, last, end: known ? landingEnd(last, this.#runways.near(s.lat, s.lon)) : null }
    }
    const { last, end } = this.#of
    if (end === null) return s
    const p = landingPose(last, end, s.ageS - EXTRAP_S)
    const downFt = Math.max(0, last.altMslFt - end.elevFt) - p.aboveFt // how far it has come down since it was last heard
    return {
      ...s,
      lat: p.lat, lon: p.lon, hM: s.hM - downFt * FT,
      headingDeg: p.headingDeg, trackDeg: p.headingDeg, pitchDeg: p.onGround ? 0 : s.pitchDeg, rollDeg: 0,
      gsKt: p.gsKt, vsFpm: p.vsFpm, onGround: p.onGround,
      iasKt: null, // no airspeed is heard: the instruments show the ground speed
      altBaroFt: s.altBaroFt === null ? null : s.altBaroFt - downFt,
      altMslFt: p.onGround ? null : end.elevFt + p.aboveFt,
      landing: { airport: end.name, runway: end.ident, landed: p.stopped },
    }
  }
}

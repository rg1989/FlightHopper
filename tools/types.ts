/** One rendered frame in a local ENU frame, produced by tools/bench-track.ts and scored by tools/metrics.ts. */
export interface Frame {
  t: number                                     // seconds (render time, server clock)
  e: number                                     // metres
  n: number
  u: number                                     // height above the reference (hM − h0), not tangent-plane up
  mode: 'interp' | 'extrap' | 'stale'
  headingDeg: number
  pitchDeg: number
  rollDeg: number
}

/** A reported (sample-time) vertical rate, m/s, for vertical metrics. */
export interface RateAt {
  t: number
  vsMs: number
}

// shared/landing.ts
// An aircraft that is no longer heard on its final approach has most often landed: receivers lose it below their horizon.
// landingEnd says which runway it was landing on, from every runway of the world (public/airports/runways.json, built by
// tools/build-runways.ts from OurAirports); landingPose flies it on from where it was last heard: down its own path to the
// aiming point, along the runway while it brakes, to a stop. Pure. An estimate: the app says so (client/app.ts).
// ponytail: a go-around below the receivers' horizon is drawn as a landing until the aircraft is heard again.
import { bearingDeg, destination } from './geo.ts'

const FT = 0.3048
const KT = 1852 / 3600 // m/s per knot
const RAD = Math.PI / 180
const R = 6_371_000 // m: the flat map round a threshold, good to centimetres over an approach

/** Every open runway with both its ends placed. One row a runway: its airport (an index), then each physical end. */
export interface RunwayTable {
  airports: [ident: string, name: string][]
  runways: RunwayRow[]
}
export type RunwayRow = [
  airport: number,
  ident1: string, lat1: number, lon1: number, elevFt1: number, displacedFt1: number,
  ident2: string, lat2: number, lon2: number, elevFt2: number, displacedFt2: number,
]

/** One landing direction of a runway. */
export interface LandingEnd {
  airport: string // the airport's ident
  name: string // the airport's name
  ident: string // the runway as landed on: "32"
  thrLat: number // the landing threshold
  thrLon: number
  hdgDeg: number // the landing direction, true
  elevFt: number // the threshold's elevation, MSL
  lengthM: number // from the threshold to the far end
}

/** Where an aircraft was last heard, and how it moved. */
export interface LastHeard {
  lat: number
  lon: number
  altMslFt: number
  trackDeg: number
  gsKt: number
  vsFpm: number | null
}

/** An aircraft on its estimated landing: s seconds after it was last heard. */
export interface LandingPose {
  lat: number
  lon: number
  aboveFt: number // above the threshold's elevation
  gsKt: number
  vsFpm: number
  headingDeg: number // true: along its path in the air, the runway's on the ground
  onGround: boolean
  stopped: boolean
}

// What a landing is: within these of a runway's approach.
const APPROACH_M = 6 * 1852 // this far out at most
const CONE_DEG = 4 // within this of the centreline, seen from the threshold…
const BESIDE_M = 100 // …or this far beside it
const TRACK_DEG = 20 // flying along it (a crosswind's crab is under this)
const PATH_DEG = 6 // not above this path to the aiming point (a steep approach is 5.5°)…
const SLACK_FT = 300 // …by more than an altimeter's error, nor this far under the runway
const ABOVE_FT = 2500
const CLIMB_FPM = 300 // not climbing
const SPEED_KT: [number, number] = [30, 250] // slower hovers, faster is no approach
const AIM_M = 300 // the aiming point, beyond the threshold…
const AIM_SHARE = 1 / 3 // …on a short runway a third of the way along
const BRAKE_MS2 = 1.8 // a landing roll: 1.5 to 3 m/s²
const STOP_SHORT_M = 60 // it stops this far before the far end at the latest
const OVER_SHARE = 0.6 // heard over the runway beyond this share of it, still in the air: no landing on what is left

/** The runway's own flat map: metres along its landing direction from the threshold, and to the right of it. */
function along(end: LandingEnd, lat: number, lon: number): { s: number; c: number } {
  const e = (lon - end.thrLon) * RAD * R * Math.cos(end.thrLat * RAD)
  const n = (lat - end.thrLat) * RAD * R
  const [ue, un] = [Math.sin(end.hdgDeg * RAD), Math.cos(end.hdgDeg * RAD)]
  return { s: e * ue + n * un, c: e * un - n * ue }
}

function place(end: LandingEnd, s: number, c: number): { lat: number; lon: number } {
  const [ue, un] = [Math.sin(end.hdgDeg * RAD), Math.cos(end.hdgDeg * RAD)]
  const e = s * ue + c * un
  const n = s * un - c * ue
  return { lat: end.thrLat + n / (RAD * R), lon: end.thrLon + e / (RAD * R * Math.cos(end.thrLat * RAD)) }
}

const wrap180 = (d: number): number => ((((d + 180) % 360) + 360) % 360) - 180
const aim = (end: LandingEnd): number => Math.min(AIM_M, end.lengthM * AIM_SHARE)

/**
 * The runway this aircraft was landing on when it was last heard, of `ends`; null when it was not landing: on the ground,
 * hovering or fast, climbing, off every centreline or across it, or too high for a path of 6° to the aiming point. Of two
 * runways that fit (parallel ones), the one whose centreline it was nearer.
 */
export function landingEnd(last: LastHeard, ends: readonly LandingEnd[]): LandingEnd | null {
  if (last.gsKt < SPEED_KT[0] || last.gsKt > SPEED_KT[1] || (last.vsFpm ?? 0) > CLIMB_FPM) return null
  let best: LandingEnd | null = null
  let bestC = Infinity
  for (const end of ends) {
    if (Math.abs(wrap180(last.trackDeg - end.hdgDeg)) > TRACK_DEG) continue
    const { s, c } = along(end, last.lat, last.lon)
    if (s < -APPROACH_M || s > end.lengthM * OVER_SHARE) continue
    if (Math.abs(c) > BESIDE_M + Math.tan(CONE_DEG * RAD) * Math.max(0, -s)) continue
    const above = last.altMslFt - end.elevFt
    const toAimFt = Math.max(0, aim(end) - s) / FT
    if (above < -SLACK_FT || above > ABOVE_FT || above > SLACK_FT + Math.tan(PATH_DEG * RAD) * toAimFt) continue
    if (Math.abs(c) < bestC) {
      best = end
      bestC = Math.abs(c)
    }
  }
  return best
}

/**
 * Where the aircraft is dtS seconds after it was last heard, landing on `end`: a straight path at its last ground speed
 * to its touchdown (the aiming point; further along when it was heard too close in for a 6° path), then along the centreline,
 * braking at 1.8 m/s² (harder on a runway too short for that) to a stop.
 * ponytail: no flare and no slowing in the air: it touches down at its approach speed.
 */
export function landingPose(last: LastHeard, end: LandingEnd, dtS: number): LandingPose {
  const from = along(end, last.lat, last.lon)
  const h0 = Math.max(0, last.altMslFt - end.elevFt)
  const v0 = last.gsKt * KT
  const down = Math.max(aim(end), from.s + (h0 * FT) / Math.tan(PATH_DEG * RAD)) // the touchdown, m along
  const d = Math.hypot(down - from.s, from.c)
  const t1 = d / v0 // to the touchdown
  if (dtS < t1) {
    const f = Math.max(0, dtS) / t1
    const at = place(end, from.s + (down - from.s) * f, from.c * (1 - f))
    const to = place(end, down, 0)
    return { ...at, aboveFt: h0 * (1 - f), gsKt: last.gsKt, vsFpm: (-h0 / t1) * 60, headingDeg: d < 1 ? end.hdgDeg : bearingDeg(at.lat, at.lon, to.lat, to.lon), onGround: false, stopped: false }
  }
  const room = Math.max(1, end.lengthM - STOP_SHORT_M - down)
  const a = Math.max(BRAKE_MS2, (v0 * v0) / (2 * room))
  const t = Math.min(dtS - t1, v0 / a)
  const v = v0 - a * t
  return { ...place(end, down + v0 * t - (a * t * t) / 2, 0), aboveFt: 0, gsKt: v / KT, vsFpm: 0, headingDeg: end.hdgDeg, onGround: true, stopped: v <= 0 }
}

/** The runways of a table, found by place. */
export class Runways {
  readonly #table: RunwayTable
  readonly #cells = new Map<number, number[]>() // by whole degree of a runway's first end: its rows

  constructor(table: RunwayTable) {
    this.#table = table
    table.runways.forEach((r, i) => {
      const k = cell(r[2], r[3])
      const list = this.#cells.get(k)
      if (list === undefined) this.#cells.set(k, [i])
      else list.push(i)
    })
  }

  /** Both landing directions of every runway in the degree cell of (lat, lon) and the eight round it: all within 6 nm, and more. */
  near(lat: number, lon: number): LandingEnd[] {
    const out: LandingEnd[] = []
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const i of this.#cells.get(cell(lat + dy, lon + dx)) ?? []) out.push(...this.#ends(this.#table.runways[i]))
      }
    }
    return out
  }

  #ends(r: RunwayRow): LandingEnd[] {
    const [airport, name] = this.#table.airports[r[0]]
    const end = (ident: string, lat: number, lon: number, elevFt: number, displacedFt: number, farLat: number, farLon: number): LandingEnd => {
      const hdgDeg = bearingDeg(lat, lon, farLat, farLon)
      const thr = destination(lat, lon, hdgDeg, (displacedFt * FT) / 1852)
      const far = along({ thrLat: thr.lat, thrLon: thr.lon, hdgDeg } as LandingEnd, farLat, farLon)
      return { airport, name, ident, thrLat: thr.lat, thrLon: thr.lon, hdgDeg, elevFt, lengthM: far.s }
    }
    return [end(r[1], r[2], r[3], r[4], r[5], r[7], r[8]), end(r[6], r[7], r[8], r[9], r[10], r[2], r[3])]
  }
}

/** One number for the whole-degree cell of a place; longitudes wrap at the date line. */
function cell(lat: number, lon: number): number {
  return Math.floor(lat) * 1000 + ((((Math.floor(lon) + 180) % 360) + 360) % 360)
}

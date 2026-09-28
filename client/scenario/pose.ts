// client/scenario/pose.ts
// A scenario's track.csv rows as a continuous pose (design §4). stateAt(t) → the RenderState the chase model and camera
// draw; dataAt(t) → the numbers of the flight-data frame. Both run every frame.
//
// Interpolation: Catmull-Rom through rows i−1…i+2 with the row times as the knots (the Barry–Goldman form, evaluated as
// a cubic Hermite whose per-row tangents are computed once). At the even ≥ 1-Hz spacing the spec asks for where the
// aircraft manoeuvres this is exactly the uniform (and the centripetal) Catmull-Rom; where the spacing changes it still
// reproduces a constant rate, where √Δt (centripetal) knots would make the speed jump (±17 % at a 2 s → 1 s change).

import { bearingDeg, distanceNm } from '../../shared/geo.ts'
import { geoidN } from '../../shared/geoid.ts'
import { trueAirspeedKt } from '../track/airspeed.ts'
import type { FlightData, RenderState } from '../types.ts'
import type { TrackRow } from './types.ts'

const FT = 0.3048
const DEG = 180 / Math.PI
const GEOID_EVERY_NM = 0.5 / 1.852 // the geoid is read again after 0.5 km of travel
const HALF_S = 0.5 // speeds missing from the rows come from the path over t ± 0.5 s
const STILL_KT = 1 // slower than this the path has no direction: the track is the heading

// The cubic channels, indexes into #v and #m.
const LAT = 0
const LON = 1
const ALT = 2
const HDG = 3 // unwrapped: continuous across north
const PITCH = 4
const ROLL = 5

export type PoseData = Omit<FlightData, 'aglFt' | 'gear' | 'flaps'>

export interface PoseOpts {
  geoid?: (lat: number, lon: number) => number // N in metres; default EGM96 (geoidN)
  hex?: string
  callsign?: string | null
  typeCode?: string | null
}

const wrap360 = (d: number): number => ((d % 360) + 360) % 360
const wrap180 = (d: number): number => wrap360(d + 180) - 180
const known = (x: number | null): x is number => x !== null && Number.isFinite(x)

/** Linear from row a (u = 0) to row b (u = 1). A gap (null, or NaN for an empty EPR cell) holds the row at or before t. */
function lin(a: number | null, b: number | null, u: number): number | null {
  if (u >= 1) return known(b) ? b : null
  if (!known(a)) return null
  return known(b) ? a + (b - a) * u : a
}

/** Wind direction (from, true) between two rows through its unit vector, so 350 → 10 passes north. */
function windDir(a: number | null, b: number | null, u: number): number | null {
  const x = lin(a === null ? null : Math.sin(a / DEG), b === null ? null : Math.sin(b / DEG), u)
  const y = lin(a === null ? null : Math.cos(a / DEG), b === null ? null : Math.cos(b / DEG), u)
  return x === null || y === null ? null : wrap360(Math.atan2(x, y) * DEG)
}

/** EPR per engine; an unknown engine is NaN, as in TrackRow. null when no engine is known. */
function eprAt(a: readonly number[] | null, b: readonly number[] | null, u: number): number[] | null {
  const n = Math.max(a?.length ?? 0, b?.length ?? 0)
  const out = new Array<number>(n)
  let any = false
  for (let k = 0; k < n; k++) {
    const v = lin(a?.[k] ?? null, b?.[k] ?? null, u)
    out[k] = v ?? Number.NaN
    any ||= v !== null
  }
  return any ? out : null
}

/**
 * Per-row tangents (per second) of the Catmull-Rom through (t, v) with the row times as knots: at an inner row, the
 * slope of the parabola through it and its two neighbours; an end row is duplicated one interval out (half the slope).
 */
function tangents(t: Float64Array, v: Float64Array): Float64Array {
  const n = v.length
  const m = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const hL = i > 0 ? t[i] - t[i - 1] : 0
    const hR = i < n - 1 ? t[i + 1] - t[i] : 0
    const sL = i > 0 ? (v[i] - v[i - 1]) / hL : 0
    const sR = i < n - 1 ? (v[i + 1] - v[i]) / hR : 0
    m[i] = i === 0 || i === n - 1 ? (sL + sR) / 2 : (sL * hR + sR * hL) / (hL + hR)
  }
  return m
}

export class PoseTrack {
  readonly start: number // first row t
  readonly end: number // last row t
  readonly #rows: readonly TrackRow[]
  readonly #t: Float64Array
  readonly #v: Float64Array[] // per channel (LAT…ROLL): the row values
  readonly #m: Float64Array[] // per channel: the tangents, per second
  readonly #geoid: (lat: number, lon: number) => number
  readonly #state: RenderState // the one object stateAt returns
  #i = 0 // cached segment (rows i, i+1): frames move forward
  #u = 0 // fraction through the segment of the last #seg()
  #w0 = 1 // Hermite weights of the last #seg()
  #w1 = 0
  #w2 = 0
  #w3 = 0
  // The pose at #at, shared by stateAt and dataAt of the same t.
  #at = Number.NaN
  #si = 0
  #su = 0
  #lat = 0
  #lon = 0
  #alt = 0
  #hdg = 0
  #pitch = 0
  #roll = 0
  #gs = 0
  #gsPath = false
  #vs = 0
  #vsPath = false
  #trk = 0
  #gnd = false
  // The geoid, read again after GEOID_EVERY_NM of travel.
  #n = 0
  #nLat = Number.NaN
  #nLon = Number.NaN

  constructor(rows: readonly TrackRow[], opts: PoseOpts = {}) {
    if (rows.length === 0) throw new RangeError('PoseTrack: no rows')
    this.start = rows[0].t
    this.end = rows[rows.length - 1].t
    // One row: a segment that never moves (t is clamped to its start).
    const rs = rows.length === 1 ? [rows[0], { ...rows[0], t: rows[0].t + 1 }] : rows
    const n = rs.length
    const t = new Float64Array(n)
    const v = [LAT, LON, ALT, HDG, PITCH, ROLL].map(() => new Float64Array(n))
    for (let i = 0; i < n; i++) {
      const r = rs[i]
      if (i > 0 && !(r.t > rs[i - 1].t)) throw new RangeError(`PoseTrack: row ${i}: times must increase`)
      t[i] = r.t
      v[LAT][i] = r.lat
      v[LON][i] = r.lon
      v[ALT][i] = r.altFt
      v[HDG][i] = i === 0 ? r.hdg : v[HDG][i - 1] + wrap180(r.hdg - rs[i - 1].hdg)
      v[PITCH][i] = r.pitch
      v[ROLL][i] = r.roll
    }
    this.#rows = rs
    this.#t = t
    this.#v = v
    this.#m = v.map((c) => tangents(t, c))
    this.#geoid = opts.geoid ?? geoidN
    this.#state = {
      hex: opts.hex ?? 'scn000',
      lat: 0,
      lon: 0,
      hM: 0,
      headingDeg: 0,
      pitchDeg: 0,
      rollDeg: 0,
      gsKt: null,
      trackDeg: null,
      altBaroFt: null,
      vsFpm: null,
      mode: 'interp',
      altSource: 'baro-qnh', // true altitude above MSL + N: what the live ladder's QNH rung computes
      onGround: false,
      ageS: 0,
      quality: 'adsb2',
      callsign: opts.callsign ?? null,
      typeCode: opts.typeCode ?? null,
    }
  }

  /** The pose at t (clamped to [start, end]). One reused object: read or copy it before the next call. */
  stateAt(t: number): RenderState {
    this.#eval(t)
    if (!(distanceNm(this.#nLat, this.#nLon, this.#lat, this.#lon) < GEOID_EVERY_NM)) {
      this.#n = this.#geoid(this.#lat, this.#lon)
      this.#nLat = this.#lat
      this.#nLon = this.#lon
    }
    const s = this.#state
    s.lat = this.#lat
    s.lon = this.#lon
    s.hM = this.#alt * FT + this.#n // ponytail: steps by the geoid's change over 0.5 km (cm) when it is read again
    s.headingDeg = this.#hdg
    s.pitchDeg = this.#pitch
    s.rollDeg = this.#roll
    s.gsKt = this.#gs
    s.trackDeg = this.#trk
    s.altBaroFt = this.#alt
    s.vsFpm = this.#vs
    s.onGround = this.#gnd
    return s
  }

  /** The flight-data frame's numbers at t (clamped). `derived`: speeds from the path, wind from q=R rows. */
  dataAt(t: number): PoseData {
    this.#eval(t)
    const u = this.#su
    const a = this.#rows[this.#si]
    const b = this.#rows[this.#si + 1]
    const windFromDeg = windDir(a.windFromDeg, b.windFromDeg, u)
    const windKt = lin(a.windKt, b.windKt, u)
    const derived = new Set<keyof FlightData>(['trackDeg']) // track.csv has no track column
    if (this.#gsPath) derived.add('gsKt')
    if (this.#vsPath) derived.add('vsFpm')
    if ((a.q === 'R' && u < 1) || (b.q === 'R' && u > 0)) {
      if (windFromDeg !== null) derived.add('windFromDeg')
      if (windKt !== null) derived.add('windKt')
    }
    const iasKt = lin(a.iasKt, b.iasKt, u)
    return {
      altFt: this.#alt,
      vsFpm: this.#vs,
      iasKt,
      tasKt: iasKt !== null && iasKt > 0 ? trueAirspeedKt(iasKt, this.#alt) : null,
      gsKt: this.#gs,
      hdgDeg: this.#hdg,
      trackDeg: this.#trk,
      pitchDeg: this.#pitch,
      rollDeg: this.#roll,
      g: lin(a.g, b.g, u),
      windFromDeg,
      windKt,
      epr: eprAt(a.epr, b.epr, u),
      derived,
    }
  }

  /** Fills the pose fields for t, clamped; a repeat of the last t is free. */
  #eval(tIn: number): void {
    const t = tIn >= this.start ? (tIn <= this.end ? tIn : this.end) : this.start // NaN → start
    if (t === this.#at) return
    // ta, t, tb in time order, so the cached segment only walks forward.
    const ta = Math.max(this.start, t - HALF_S)
    const tb = Math.min(this.end, t + HALF_S)
    let i = this.#seg(ta)
    const latA = this.#cubic(LAT, i)
    const lonA = this.#cubic(LON, i)
    const altA = this.#cubic(ALT, i)

    i = this.#seg(t)
    const u = this.#u
    this.#si = i
    this.#su = u
    this.#lat = this.#cubic(LAT, i)
    this.#lon = this.#cubic(LON, i)
    this.#alt = this.#cubic(ALT, i)
    this.#hdg = wrap360(this.#cubic(HDG, i))
    this.#pitch = this.#cubic(PITCH, i)
    this.#roll = this.#cubic(ROLL, i)
    const a = this.#rows[i]
    const b = this.#rows[i + 1]
    this.#gnd = u >= 1 ? b.gnd : a.gnd
    const gs = lin(a.gsKt, b.gsKt, u)
    const vs = lin(a.vsFpm, b.vsFpm, u)

    i = this.#seg(tb)
    const latB = this.#cubic(LAT, i)
    const lonB = this.#cubic(LON, i)
    const altB = this.#cubic(ALT, i)

    // ponytail: the spherical earth of shared/geo.ts, ≤ 0.5 % off the ellipsoid (≤ 1.5 kt at 300 kt; shown as an estimate)
    const dtS = tb - ta
    const pathKt = dtS > 0 ? (distanceNm(latA, lonA, latB, lonB) / dtS) * 3600 : 0
    this.#gsPath = gs === null
    this.#gs = gs ?? pathKt
    this.#vsPath = vs === null
    this.#vs = vs ?? (dtS > 0 ? ((altB - altA) / dtS) * 60 : 0)
    this.#trk = pathKt >= STILL_KT ? bearingDeg(latA, lonA, latB, lonB) : this.#hdg
    this.#at = t
  }

  /** Points the cubic at t (within [start, end]): sets the Hermite weights and #u; returns the segment. */
  #seg(t: number): number {
    const i = this.#find(t)
    const h = this.#t[i + 1] - this.#t[i]
    const u = Math.min(1, (t - this.#t[i]) / h)
    const u2 = u * u
    const u3 = u2 * u
    this.#w0 = 2 * u3 - 3 * u2 + 1
    this.#w1 = (u3 - 2 * u2 + u) * h
    this.#w2 = 3 * u2 - 2 * u3
    this.#w3 = (u3 - u2) * h
    this.#u = u
    return i
  }

  #cubic(c: number, i: number): number {
    const v = this.#v[c]
    const m = this.#m[c]
    return this.#w0 * v[i] + this.#w1 * m[i] + this.#w2 * v[i + 1] + this.#w3 * m[i + 1]
  }

  /** The segment i (rows i, i+1) holding t, the last one holding the end: a few steps from the cached one, else a binary search. */
  #find(t: number): number {
    const ts = this.#t
    const last = ts.length - 2
    let i = this.#i
    for (let k = 0; k < 4; k++) {
      if (t < ts[i]) i--
      else if (i < last && t >= ts[i + 1]) i++
      else return (this.#i = i)
    }
    let lo = 0
    let hi = last
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (ts[mid] <= t) lo = mid
      else hi = mid - 1
    }
    return (this.#i = lo)
  }
}

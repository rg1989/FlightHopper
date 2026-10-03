// client/track/track.ts
// One aircraft's delayed-playback estimator: deduped samples in, a smooth, physically consistent RenderState at any
// render time out (.planning/flight-physics-design.md).
import { Deduper } from '../../shared/dedupe.ts'
import { Enu } from '../../shared/enu.ts'
import type { Quality, Sample } from '../../shared/types.ts'
import type { RenderState } from '../types.ts'
import { AttitudeFilter, aeroPitchRoll } from './attitude.ts'
import { p90, targetDelayS } from './delay.ts'
import { RejoinBlend, extrapolate } from './hermite.ts'
import { positionOutliers, velocitiesFromPositions } from './mlat.ts'
import { quintic, smooth, trendSlopes, type Knot3, type Obs } from './smoother.ts'
import type { AltSource, Att, PosT } from './types.ts'
import { AltitudeLadder } from './vertical.ts'

const KT = 1852 / 3600 // m/s per knot (0.514444)
const FPM = 0.3048 / 60 // m/s per ft/min
const FT = 0.3048
const DEG = 180 / Math.PI
const KEEP_MS = 120_000 // sample window
const GAP_WINDOW_MS = 60_000 // gapP90S() history
export const EXTRAP_S = 8 // dead-reckoning cap; past it the pose freezes (mode 'stale')
const RECENTRE_M = 100_000 // move the ENU origin when the newest sample is this far from it
const GROUND_HOLD_S = 60 // on the ground, keep the last airborne height this long
const CHECK_MIN_MS = 10 // below this finite-difference speed, position noise dominates: don't judge the reported velocity
// A reported velocity is judged against the positions over ±3 s, and only when they span 3 s: over one 1.3 s step a
// time stamp 0.9 s late (1 % of samples) reads as 800 kt and threw a correct 461 kt report away (B77W, Heathrow).
const CHECK_HALF_S = 3
const CHECK_BASE_S = 3
const MAX_TURN_DEGS = 6 // dead-reckoning turn-rate clamp (2× standard rate)
const R = 6_371_000 // mean Earth radius, only for the tangent-plane drop in #geo
const REJOIN_S = 1.5 // re-join blend duration (G2: re-join blended within 1.5 s)
const MLAT_REJOIN_S = 3 // MLAT revisions blend over longer
const D = 1e-3 // s, forward-difference step for the on-screen velocity at a re-join
// The smoother's model (smoother.ts), its noise as measured on 14 min of Heathrow arrivals (2026-09-28):
const Q_H = 0.15 // horizontal jerk density, m²/s⁵: the bank it implies matches the broadcast roll best (1.8° RMS)
const Q_MLAT = 0.03 // MLAT positions are six times noisier: a stiffer path
const Q_V = 0.05 // vertical: level-offs and flares take seconds
const POS_M = 10 // ADS-B position error, per axis
const MLAT_M = 60
const TIME_S = 0.12 // sample-time jitter (feeder latency): an error along the velocity
const VEL_MS = 0.6 // reported velocity: 1 kt steps and its own age
const MLAT_VEL_MS = 5 // MLAT: the aggregator's own estimate (within ±7 % of the flown speed, p5–p95); far-off ones fail agrees()
const H_M = 3 // height: 25 ft steps
const RATE_MS = 0.5 // reported vertical rate
// A velocity report is older than its position: measured in turns at Heathrow, the reported track trails the direction
// flown by 0.73 s (median; quartiles 0.32–1.38 s). A barometric rate lags more (the air data computer filters it).
const VEL_LAG = { s: 0.75, sd: 0.55 }
const MLAT_VEL_LAG = { s: 1, sd: 1 } // ponytail: not measured; assumed a little older than an ADS-B report
const RATE_LAG = { s: 1, sd: 0.7 }
const RATE_TREND_S = 6 // a reported rate counts only when it agrees with the height trend over ±6 s…
const RATE_AGREE_MS = 2.5 // …within 2.5 m/s or 40 % (a transponder reporting +2,600 fpm while level is ignored)
// What no aircraft here does: a measurement implying more is an error, not a manoeuvre.
const H_LIMITS = { v: 400, a: 20 } // m/s per axis (780 kt), m/s² (2 g)
const V_LIMITS = { v: 100, a: 20 } // m/s vertical (20,000 fpm), m/s²
const CRAB_TAU_S = 15 // the wind correction angle (true heading − track) changes with the wind: averaged over 15 s…
const CRAB_MAX_DEG = 25 // …from plausible, fresh reports only
const IAS_TAU_S = 3
const IAS_KEEP_S = 30 // an airspeed report older than this no longer stands
const ROTATE_S = 3 // take-off: the nose comes up over the last 3 s on the runway…
const ROTATE_DEG = 8 // …to the lift-off attitude…
const ROTATE_MS = 30 // …at take-off speeds only
const TAXI_MS = 3 // slower than this on the ground the track is noise: the nose holds
const ACC_TAU_S = 4 // dead reckoning keeps the acceleration along the track (a take-off roll), fading over ~4 s…
const ACC_MAX_MS2 = 3 // …within what brakes, reversers and take-off thrust can do
const BREAK_S = 12 // a gap this long whose ends disagree (a turn, a hold unseen) is not interpolated across: the
const BREAK_FRAC = 0.2 // aircraft flies into the newer state along its velocity (speed off by more than 20 %…
const BREAK_MS = 3 // …or 3 m/s; vertically 2 m/s or 30 %)
const BACK_RESET_S = 2 // render time jumping back further than this (a seek) starts the attitude afresh
const READOUT_TAU_S = 0.5 // the speed and V/S shown lag like an instrument's, so a new sample's revision never steps
const MLAT_READOUT_TAU_S = 2 // MLAT: its positions are six times noisier, and each new one revises the path more

interface V { ve: number; vn: number }
interface P3 { e: number; n: number; h: number }
/** A smoothed horizontal state at a sample time. */
interface HKnot { t: number; e: number; n: number; ve: number; vn: number; ae: number; an: number }
/** The horizontal motion at a time: position, velocity, turn rate (+ right) and acceleration along the track. */
interface HMotion { e: number; n: number; ve: number; vn: number; turnDegS: number; alongMs2: number }
interface VObs { t: number; h: number; rate: number | null }

const wrap360 = (d: number): number => ((d % 360) + 360) % 360
const wrap180 = (d: number): number => wrap360(d + 180) - 180
const dirDeg = (v: V): number => wrap360(Math.atan2(v.ve, v.vn) * DEG)
const clampTurn = (w: number): number => Math.max(-MAX_TURN_DEGS, Math.min(MAX_TURN_DEGS, w))

/** The reported velocity is trusted unless the positions clearly contradict it: > 20 % in speed or > 15° in direction. */
function agrees(rep: V, fd: V & { baseS: number }): boolean {
  const vFd = Math.hypot(fd.ve, fd.vn)
  if (fd.baseS < CHECK_BASE_S || vFd < CHECK_MIN_MS) return true
  return Math.abs(Math.hypot(rep.ve, rep.vn) - vFd) <= 0.2 * vFd && Math.abs(wrap180(dirDeg(rep) - dirDeg(fd))) <= 15
}

/** Turn rate (°/s, + right) and acceleration along the track from a velocity and an acceleration. */
function motion(e: number, n: number, ve: number, vn: number, ae: number, an: number): HMotion {
  const v2 = ve * ve + vn * vn
  const v = Math.sqrt(v2)
  return { e, n, ve, vn, turnDegS: v > 1 ? ((vn * ae - ve * an) / v2) * DEG : 0, alongMs2: v > 1 ? (ve * ae + vn * an) / v : 0 }
}

interface Model {
  tE: number // evaluation time: render time, frozen EXTRAP_S after the last knot
  over: number // render time − last knot time, s (> 0 = extrapolating)
  hz: HMotion
  ci: number // current sample: the newest one at or before the render time
  hM: number
  vsMs: number | null
}

/**
 * Delayed-playback estimator for one aircraft. Times inside are seconds since the first sample.
 * Horizontal: a local ENU frame whose origin is the first sample at h = 0, moved to the newest sample only when that is
 * > 100 km away (the tangent plane then sags ≤ 0.8 km below it, handled by #geo). Each axis is smoothed (smoother.ts)
 * from the positions (noisy, their times jittered) and the reported gs/track (precise; dropped when the neighbouring
 * positions contradict them); the path between the smoothed states is quintic, so position, velocity and acceleration
 * are continuous. MLAT: positions only, noisier. After the newest state: constant speed and turn for ≤ 8 s, then frozen.
 * Whenever a new sample changes the estimate at the last rendered time, a RejoinBlend plus a velocity bump absorb the
 * difference, so the rendered path keeps its position and velocity (C1) in all three axes.
 * Vertical: AltitudeLadder heights and the reported rate (when it agrees with the height trend), smoothed the same way.
 * Attitude: flight mechanics (attitude.ts) on the smoothed path — pitch from lift, bank from the turn, heading the track
 * plus the wind's crab angle — through AttitudeFilter (inertia).
 */
export class Track {
  readonly hex: string
  readonly #pollPeriodS: number
  readonly #dedupe = new Deduper()
  #samples: Sample[] = []
  #gamma: number[] = [] // per sample: bearing of local true north in the ENU frame, deg (meridian convergence)
  #hk: HKnot[] = []
  #vObs: VObs[] = [] // one per airborne sample with a height
  #vk: Knot3[] = []
  #crab: (number | null)[] = [] // per sample: the averaged wind correction angle, deg
  #ias: (number | null)[] = [] // per sample: the averaged indicated airspeed, kt, while reports are fresh
  #enu: Enu | null = null
  #t0Ms = 0
  readonly #ladder = new AltitudeLadder()
  #altSource: AltSource = 'baro-bias' // until any rung has been seen: the least-trusted one
  #callsign: string | null = null
  #typeCode: string | null = null
  #category: string | null = null
  #blend = new RejoinBlend(REJOIN_S)
  #vBlend = new RejoinBlend(REJOIN_S) // vertical position error rides in its `e` component
  #bump: P3 = { e: 0, n: 0, h: 0 } // velocity error at the last re-join, m/s
  #bumpT0 = NaN
  #bumpS = REJOIN_S
  #att = new AttitudeFilter()
  #heading: number | null = null // the last drawn heading, held while taxiing slowly
  #gsShown: number | null = null // m/s, READOUT_TAU_S behind the estimate
  #vsShown: number | null = null
  #lastT: number | null = null

  constructor(hex: string, opts: { pollPeriodS?: number } = {}) {
    this.hex = hex
    this.#pollPeriodS = opts.pollPeriodS ?? 1
  }

  /** false for another hex, a duplicate or an out-of-order sample (Deduper). */
  add(s: Sample): boolean {
    if (s.hex !== this.hex || !this.#dedupe.accept(s)) return false
    const tPrev = this.#lastT
    const was = tPrev === null ? null : [this.#pos(tPrev), this.#pos(tPrev + D)]
    const oldEnu = this.#enu
    if (this.#enu === null) {
      this.#enu = new Enu(s.lat, s.lon, 0)
      this.#t0Ms = s.tMs
    } else {
      const [e, n] = this.#enu.fwd(s.lat, s.lon, 0)
      if (Math.hypot(e, n) > RECENTRE_M) this.#enu = new Enu(s.lat, s.lon, 0)
    }
    this.#samples.push(s) // the Deduper only passes strictly newer samples, so the array stays sorted
    let drop = 0
    while (this.#samples[drop].tMs < s.tMs - KEEP_MS) drop++
    if (drop > 0) this.#samples = this.#samples.slice(drop)
    const h = this.#ladder.height(s)
    if (h !== null) {
      // The rate that matches the height's datum first, the other when it is missing (the trend check guards both).
      const rate = h.source === 'geom' ? (s.geomRateFpm ?? s.baroRateFpm) : (s.baroRateFpm ?? s.geomRateFpm)
      this.#vObs.push({ t: this.#ts(s.tMs), h: h.hM, rate: rate === null ? null : rate * FPM })
      this.#altSource = h.source
    }
    const oldest = this.#ts(this.#samples[0].tMs)
    while (this.#vObs.length > 0 && this.#vObs[0].t < oldest) this.#vObs.shift()
    this.#callsign = s.callsign ?? this.#callsign
    this.#typeCode = s.typeCode ?? this.#typeCode
    this.#category = s.category ?? this.#category
    this.#rebuild()
    if (was?.[0] && was[1] && tPrev !== null) this.#rejoin(was[0], was[1], oldEnu!, tPrev)
    return true
  }

  stateAt(tRenderMs: number): RenderState | null {
    const tS = this.#ts(tRenderMs)
    const m = this.#model(tS)
    if (m === null) return null
    const dtS = this.#lastT === null ? 0 : tS - this.#lastT
    // A clock correction of a few milliseconds backwards just holds the attitude; a seek starts it afresh.
    if (dtS < -BACK_RESET_S) {
      this.#att = new AttitudeFilter()
      this.#heading = null
      this.#gsShown = this.#vsShown = null
    }
    this.#lastT = tS
    const cur = this.#samples[m.ci]
    const off = this.#offset(tS)
    const g = this.#geo(m.hz.e + off.e, m.hz.n + off.n)
    // Speed and track from the estimate, not the re-join blend: a blend's few metres of correction would read as knots
    // (measured on 14 min of Heathrow arrivals: the blend's velocity made the speed readout 3× noisier). Frozen (stale):
    // the last known velocity, not the frozen image's zero.
    const stale = m.over > EXTRAP_S
    const gsMs = Math.hypot(m.hz.ve, m.hz.vn)
    const trackDeg = gsMs >= 0.5 ? wrap360(dirDeg(m.hz) - this.#gamma[m.ci]) : cur.trackDeg
    const att = this.#att.step(this.#target(m, cur, tS, gsMs, trackDeg), Math.max(0, dtS))
    this.#heading = att.headingDeg
    const k = 1 - Math.exp(-Math.max(0, dtS) / (this.quality === 'mlat' ? MLAT_READOUT_TAU_S : READOUT_TAU_S))
    this.#gsShown = this.#gsShown === null ? gsMs : this.#gsShown + k * (gsMs - this.#gsShown)
    this.#vsShown = m.vsMs === null ? null : this.#vsShown === null ? m.vsMs : this.#vsShown + k * (m.vsMs - this.#vsShown)
    const hM = m.hM + off.h
    return {
      hex: this.hex,
      lat: g.lat,
      lon: g.lon,
      hM,
      headingDeg: att.headingDeg,
      pitchDeg: att.pitchDeg,
      rollDeg: att.rollDeg,
      gsKt: this.#hk.length < 2 && cur.gsKt === null ? null : this.#gsShown / KT,
      trackDeg,
      altBaroFt: cur.altBaroFt,
      vsFpm: this.#vsShown === null ? null : this.#vsShown / FPM,
      mode: m.over <= 0 ? 'interp' : stale ? 'stale' : 'extrap',
      altSource: this.#altSource,
      onGround: cur.onGround,
      ageS: (tRenderMs - this.#samples[this.#samples.length - 1].tMs) / 1000,
      quality: cur.quality,
      callsign: this.#callsign,
      typeCode: this.#typeCode,
      altMslFt: cur.onGround || m.vsMs === null ? null : (hM - cur.nM) / FT,
      iasKt: this.#at(this.#ias, m.ci, tS),
    }
  }

  /** p90 of the gaps between consecutive samples whose later sample is within the last 60 s. 0 with < 2 samples. */
  gapP90S(): number {
    const ss = this.#samples
    const gaps: number[] = []
    for (let i = ss.length - 1; i > 0 && ss[ss.length - 1].tMs - ss[i].tMs <= GAP_WINDOW_MS; i--) gaps.push((ss[i].tMs - ss[i - 1].tMs) / 1000)
    return p90(gaps)
  }

  /** The newest sample's quality ('other' before any sample). It also picks the ADS-B or MLAT noise model. */
  get quality(): Quality {
    return this.#samples[this.#samples.length - 1]?.quality ?? 'other'
  }

  get newestTMs(): number | null {
    return this.#samples[this.#samples.length - 1]?.tMs ?? null
  }

  get oldestTMs(): number | null {
    return this.#samples[0]?.tMs ?? null
  }

  get delayTargetS(): number {
    return targetDelayS(this.quality, this.#pollPeriodS, this.gapP90S())
  }

  #ts(tMs: number): number {
    return (tMs - this.#t0Ms) / 1000
  }

  /**
   * Horizontal ENU (h = 0 surface) → lat/lon. The ellipsoid under (e, n) lies ≈ d²/2R below the tangent plane.
   * ponytail: spherical sag; ≤ ~5 cm horizontal error at the 100 km re-centre radius. Upgrade: one Newton step on h.
   */
  #geo(e: number, n: number): { lat: number; lon: number } {
    return this.#enu!.inv(e, n, -(e * e + n * n) / (2 * R))
  }

  /**
   * Smooths the whole window again: both horizontal axes, the height, the crab angle and the airspeed.
   * ponytail: O(window) per sample (≈ 60 samples × 3 axes at the chase rate); fine for the chased aircraft and the
   * traffic around it. Upgrade: keep the forward pass and re-run only the backward pass over the last few samples.
   */
  #rebuild(): void {
    const enu = this.#enu!
    const ss = this.#samples
    const pts: PosT[] = ss.map((s) => {
      const [e, n] = enu.fwd(s.lat, s.lon, 0)
      return { t: this.#ts(s.tMs), e, n }
    })
    this.#gamma = ss.map((s, i) => {
      const [e, n] = enu.fwd(s.lat + 1e-4, s.lon, 0)
      return Math.atan2(e - pts[i].e, n - pts[i].n) * DEG
    })
    // ponytail: the noise model follows the newest sample's quality for the whole window; mixed windows are rare.
    const mlat = this.quality === 'mlat'
    const pos2 = (mlat ? MLAT_M : POS_M) ** 2
    const reps = ss.map((_, i) => this.#reported(i))
    // A mis-stamped ADS-B position (its neighbours and the reported velocities agree it is not where it says) is left
    // out, its velocity kept: as a first sample it anchored the path 200 m off (a 461 kt B77W read 784 kt).
    const out = mlat ? ss.map(() => false) : positionOutliers(pts, reps, (i) => Math.hypot(POS_M, Math.hypot(reps[i]?.ve ?? 0, reps[i]?.vn ?? 0) * TIME_S))
    const fd = velocitiesFromPositions(pts, CHECK_HALF_S, out) // over ±3 s, one-sided at the ends, 0 for a lone sample
    const oe: Obs[] = []
    const on: Obs[] = []
    for (let i = 0; i < ss.length; i++) {
      const rep = reps[i] !== null && agrees(reps[i]!, fd[i]) ? reps[i] : null
      const ve = rep?.ve ?? fd[i].ve
      const vn = rep?.vn ?? fd[i].vn
      const rv = (mlat ? MLAT_VEL_MS : VEL_MS) ** 2
      oe.push({ t: pts[i].t, p: out[i] ? null : pts[i].e, rp: pos2 + (ve * TIME_S) ** 2, v: rep?.ve ?? null, rv })
      on.push({ t: pts[i].t, p: out[i] ? null : pts[i].n, rp: pos2 + (vn * TIME_S) ** 2, v: rep?.vn ?? null, rv })
    }
    const q = mlat ? Q_MLAT : Q_H
    const lag = mlat ? MLAT_VEL_LAG : VEL_LAG
    const ke = smooth(oe, q, H_LIMITS, lag)
    const kn = smooth(on, q, H_LIMITS, lag)
    this.#hk = ke.map((a, i) => ({ t: a.t, e: a.p, n: kn[i].p, ve: a.v, vn: kn[i].v, ae: a.a, an: kn[i].a }))

    const vo = this.#vObs
    const trend = trendSlopes(vo.map((o) => o.t), vo.map((o) => o.h), RATE_TREND_S)
    const agree = (r: number | null, t: number): boolean => r !== null && Math.abs(r - t) <= Math.max(RATE_AGREE_MS, 0.4 * Math.abs(t))
    this.#vk = smooth(vo.map((o, i) => ({ t: o.t, p: o.h, rp: H_M ** 2, v: agree(o.rate, trend[i]) ? o.rate : null, rv: RATE_MS ** 2 })), Q_V, V_LIMITS, RATE_LAG)

    let crab: number | null = null
    let crabT = 0
    let lastHdg: number | null = null
    this.#crab = ss.map((s, i) => {
      const h = s.trueHeadingDeg
      // A repeated heading is a stale radar reply: only a changed one is news.
      if (!s.onGround && h !== null && h !== lastHdg && s.trackDeg !== null && (s.gsKt ?? 0) > 50) {
        const c = wrap180(h - s.trackDeg)
        if (Math.abs(c) <= CRAB_MAX_DEG) {
          crab = crab === null ? c : crab + (1 - Math.exp(-(pts[i].t - crabT) / CRAB_TAU_S)) * (c - crab)
          crabT = pts[i].t
        }
      }
      lastHdg = h
      return crab
    })

    let ias: number | null = null
    let iasT = -Infinity
    this.#ias = ss.map((s, i) => {
      const t = pts[i].t
      if (s.iasKt != null) {
        ias = ias === null || t - iasT > IAS_KEEP_S ? s.iasKt : ias + (1 - Math.exp(-(t - iasT) / IAS_TAU_S)) * (s.iasKt - ias)
        iasT = t
      }
      return t - iasT <= IAS_KEEP_S ? ias : null
    })
  }

  /** Reported velocity (gs + track; true heading on the ground), or null when missing. */
  #reported(i: number): V | null {
    const s = this.#samples[i]
    const dir = s.trackDeg ?? (s.onGround ? s.trueHeadingDeg : null)
    if (s.gsKt === null || dir === null) return null
    const a = (dir + this.#gamma[i]) / DEG
    return { ve: s.gsKt * KT * Math.sin(a), vn: s.gsKt * KT * Math.cos(a) }
  }

  #horiz(t: number): HMotion {
    const k = this.#hk
    const last = k[k.length - 1]
    if (t >= last.t || k.length < 2) {
      // Dead reckoning: the turn the path had at its newest state, and its change of speed over the last 2 s fading
      // out (from the speeds: in a turn the acceleration vector lags round and would invent one).
      const now = motion(last.e, last.n, last.ve, last.vn, last.ae, last.an)
      const turn = clampTurn(now.turnDegS)
      const dt = Math.max(0, t - last.t)
      let j = k.length - 2
      while (j > 0 && k[j].t > last.t - 2) j--
      const ref = k[Math.max(0, j)]
      const dv = last.t > ref.t ? (Math.hypot(last.ve, last.vn) - Math.hypot(ref.ve, ref.vn)) / (last.t - ref.t) : 0
      const a0 = Math.max(-ACC_MAX_MS2, Math.min(ACC_MAX_MS2, dv))
      const fade = Math.exp(-dt / ACC_TAU_S)
      const v0 = Math.hypot(last.ve, last.vn)
      const vNow = Math.max(0, v0 + a0 * ACC_TAU_S * (1 - fade))
      const vAvg = dt > 0 ? Math.max(0, v0 + (a0 * ACC_TAU_S * (dt - ACC_TAU_S * (1 - fade))) / dt) : v0
      const k0 = v0 > 0 ? vAvg / v0 : 0 // along the arc at the average speed…
      const x = extrapolate({ t: last.t, e: last.e, n: last.n, ve: last.ve * k0, vn: last.vn * k0 }, turn, dt)
      const k1 = vAvg > 0 ? vNow / vAvg : 0 // …arriving at the speed of now
      return { e: x.e, n: x.n, ve: x.ve * k1, vn: x.vn * k1, turnDegS: turn, alongMs2: a0 * fade }
    }
    let i = k.length - 2
    while (i > 0 && k[i].t > t) i-- // render time sits near the newest knots: scan from the end
    const a = k[i]
    const b = k[i + 1]
    if (b.t - a.t > BREAK_S) {
      const vEnds = (Math.hypot(a.ve, a.vn) + Math.hypot(b.ve, b.vn)) / 2
      const vGap = Math.hypot(b.e - a.e, b.n - a.n) / (b.t - a.t)
      if (Math.abs(vGap - vEnds) > Math.max(BREAK_FRAC * vEnds, BREAK_MS)) {
        const back = b.t - t
        return { e: b.e - b.ve * back, n: b.n - b.vn * back, ve: b.ve, vn: b.vn, turnDegS: 0, alongMs2: 0 }
      }
    }
    const e = quintic({ t: a.t, p: a.e, v: a.ve, a: a.ae }, { t: b.t, p: b.e, v: b.ve, a: b.ae }, t)
    const n = quintic({ t: a.t, p: a.n, v: a.vn, a: a.an }, { t: b.t, p: b.n, v: b.vn, a: b.an }, t)
    return motion(e.p, n.p, e.v, n.v, e.a, n.a)
  }

  /** Everything position-like at render time tS, without blends. null before the first sample. */
  #model(tS: number): Model | null {
    const ss = this.#samples
    if (ss.length === 0 || tS < this.#ts(ss[0].tMs)) return null
    const lastT = this.#hk[this.#hk.length - 1].t
    const tE = Math.min(tS, lastT + EXTRAP_S)
    let ci = ss.length - 1
    while (ci > 0 && this.#ts(ss[ci].tMs) > tS) ci--
    return { tE, over: tS - lastT, hz: this.#horiz(tE), ci, ...this.#vertical(tE, ci) }
  }

  /**
   * Airborne: the smoothed height. On the ground: the last airborne height if it is < 60 s old, else the sample's
   * geoid N (MSL 0 as HAE). Consumers clamp ground aircraft to terrain.
   */
  #vertical(tE: number, ci: number): { hM: number; vsMs: number | null } {
    const ss = this.#samples
    const cur = ss[ci]
    if (!cur.onGround) return this.#vAt(tE) ?? { hM: cur.nM, vsMs: null }
    for (let i = ci; i >= 0 && tE - this.#ts(ss[i].tMs) < GROUND_HOLD_S; i--) {
      const v = ss[i].onGround ? null : this.#vAt(this.#ts(ss[i].tMs))
      if (v) return { hM: v.hM, vsMs: 0 }
    }
    return { hM: cur.nM, vsMs: 0 }
  }

  /** The smoothed height at t: null before the first; quintic between; at a constant rate after the last. */
  #vAt(t: number): { hM: number; vsMs: number } | null {
    const k = this.#vk
    if (k.length === 0 || t < k[0].t) return null
    const last = k[k.length - 1]
    if (t >= last.t) return { hM: last.p + last.v * (t - last.t), vsMs: last.v }
    let i = k.length - 2
    while (k[i].t > t) i--
    const a = k[i]
    const b = k[i + 1]
    if (b.t - a.t > BREAK_S) {
      const vGap = (b.p - a.p) / (b.t - a.t)
      const vEnds = (a.v + b.v) / 2
      if (Math.abs(vGap - vEnds) > Math.max(0.3 * Math.abs(vEnds), 2)) return { hM: b.p - b.v * (b.t - t), vsMs: b.v }
    }
    const q = quintic(a, b, t)
    return { hM: q.p, vsMs: q.v }
  }

  /** The attitude a real aircraft would have here (before its inertia). */
  #target(m: Model, cur: Sample, tS: number, gsMs: number, trackDeg: number | null): Att {
    const headingDeg = cur.onGround
      ? gsMs > TAXI_MS && trackDeg !== null ? trackDeg : (cur.trueHeadingDeg ?? this.#heading ?? trackDeg ?? 0)
      : (trackDeg ?? this.#heading ?? 0) + (this.#at(this.#crab, m.ci, tS) ?? 0)
    const rotation = this.#rotation(m.ci, tS, gsMs)
    if (rotation !== null) return { headingDeg, pitchDeg: rotation, rollDeg: 0 }
    return {
      headingDeg,
      ...aeroPitchRoll({
        gsMs,
        vsMs: m.vsMs ?? 0,
        turnRateDegS: m.hz.turnDegS,
        alongMs2: m.hz.alongMs2,
        easKt: this.#at(this.#ias, m.ci, tS),
        altM: m.hM,
        onGround: cur.onGround,
        category: this.#category,
      }),
    }
  }

  /** On the runway at take-off speed with the first airborne sample ≤ ROTATE_S ahead: the nose coming up. Else null. */
  #rotation(ci: number, tS: number, gsMs: number): number | null {
    const ss = this.#samples
    if (!ss[ci].onGround || gsMs < ROTATE_MS) return null
    for (let j = ci + 1; j < ss.length; j++) {
      const ahead = this.#ts(ss[j].tMs) - tS
      if (ahead > ROTATE_S) return null
      if (!ss[j].onGround) return ROTATE_DEG * (1 - Math.max(0, ahead) / ROTATE_S)
    }
    return null
  }

  /** A per-sample series at render time: linear between the current sample and the next; null when unknown. */
  #at(xs: readonly (number | null)[], ci: number, tS: number): number | null {
    const a = xs[ci] ?? null
    const b = xs[ci + 1] ?? null
    if (a === null || b === null) return a
    const ta = this.#ts(this.#samples[ci].tMs)
    const tb = this.#ts(this.#samples[ci + 1].tMs)
    return a + Math.min(1, Math.max(0, (tS - ta) / (tb - ta))) * (b - a)
  }

  #pos(tS: number): P3 | null {
    const m = this.#model(tS)
    return m && { e: m.hz.e, n: m.hz.n, h: m.hM }
  }

  /**
   * What the re-join adds to the estimate: RejoinBlend's raised cosine carries the position error, plus a velocity
   * bump T·u(1 − u)²·errV (u = (t − t0)/T) that is 0 at both ends, has slope errV at t0 and none at the end.
   * Together the rendered path keeps its position and velocity (C1) when the estimate changes under it.
   */
  #offset(tS: number): P3 {
    const o = this.#blend.offset(tS)
    const u = (tS - this.#bumpT0) / this.#bumpS
    const b = u >= 0 && u < 1 ? this.#bumpS * u * (1 - u) ** 2 : 0
    return { e: o.e + b * this.#bump.e, n: o.n + b * this.#bump.n, h: this.#vBlend.offset(tS).e + b * this.#bump.h }
  }

  /**
   * A new sample may have moved the estimate at the last rendered time t (the smoothed end of the path, after
   * extrapolating, or an ENU re-centre). m0, m1 = the old estimate at t and t + D. Blend from what was on screen to the
   * new estimate.
   */
  #rejoin(m0: P3, m1: P3, oldEnu: Enu, t: number): void {
    const q0 = this.#pos(t)
    const q1 = this.#pos(t + D)
    if (q0 === null || q1 === null) return
    const o0 = this.#offset(t)
    const o1 = this.#offset(t + D)
    const p0 = this.#reframe({ e: m0.e + o0.e, n: m0.n + o0.n, h: m0.h + o0.h }, oldEnu) // on screen at t
    const p1 = this.#reframe({ e: m1.e + o1.e, n: m1.n + o1.n, h: m1.h + o1.h }, oldEnu)
    const e0 = { e: p0.e - q0.e, n: p0.n - q0.n, h: p0.h - q0.h }
    const e1 = { e: p1.e - q1.e, n: p1.n - q1.n, h: p1.h - q1.h }
    // An unchanged estimate reproduces bit-exactly, so 1 µm at t and t + D (1 mm/s in velocity) means "changed".
    const same = (a: P3, b: P3): boolean => Math.hypot(a.e - b.e, a.n - b.n, a.h - b.h) <= 1e-6
    if (oldEnu === this.#enu && same(e0, o0) && same(e1, o1)) return // the running blend stays valid
    this.#bumpS = this.quality === 'mlat' ? MLAT_REJOIN_S : REJOIN_S
    this.#blend = new RejoinBlend(this.#bumpS)
    this.#blend.start(e0.e, e0.n, t)
    this.#vBlend = new RejoinBlend(this.#bumpS)
    this.#vBlend.start(e0.h, 0, t)
    this.#bump = { e: (e1.e - e0.e) / D, n: (e1.n - e0.n) / D, h: (e1.h - e0.h) / D }
    this.#bumpT0 = t
  }

  /** A point of the previous ENU frame in the current one (identity unless the origin moved). */
  #reframe(p: P3, oldEnu: Enu): P3 {
    if (oldEnu === this.#enu) return p
    const g = oldEnu.inv(p.e, p.n, -(p.e * p.e + p.n * p.n) / (2 * R))
    const [e, n] = this.#enu!.fwd(g.lat, g.lon, 0)
    return { e, n, h: p.h }
  }
}

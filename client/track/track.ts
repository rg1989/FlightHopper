// client/track/track.ts
// One aircraft's delayed-playback estimator: deduped samples in, a smooth RenderState at any render time out.
import { Deduper } from '../../shared/dedupe.ts'
import { Enu } from '../../shared/enu.ts'
import type { Quality, Sample } from '../../shared/types.ts'
import type { RenderState } from '../types.ts'
import { AttitudeSmoother, targetAttitude, turnRateDegS } from './attitude.ts'
import { p90, targetDelayS } from './delay.ts'
import { RejoinBlend, extrapolate, hermite, type HState } from './hermite.ts'
import { gateOutliers, smoothPositions, velocitiesFromPositions } from './mlat.ts'
import type { AltSource, KinPoint, PosT } from './types.ts'
import { AltitudeLadder, VerticalFilter } from './vertical.ts'

const KT = 1852 / 3600 // m/s per knot (0.514444)
const FPM = 0.3048 / 60 // m/s per ft/min
const DEG = 180 / Math.PI
const KEEP_MS = 120_000 // sample window
const GAP_WINDOW_MS = 60_000 // gapP90S() history
const EXTRAP_S = 8 // dead-reckoning cap; past it the pose freezes (mode 'stale')
const RECENTRE_M = 100_000 // move the ENU origin when the newest sample is this far from it
const GROUND_HOLD_S = 60 // on the ground, keep the last airborne height this long
const CHECK_MIN_MS = 10 // below this finite-difference speed, position noise dominates: don't judge the reported velocity
const MAX_TURN_DEGS = 6 // dead-reckoning turn-rate clamp (2× standard rate)
const R = 6_371_000 // mean Earth radius, only for the tangent-plane drop in #geo
const REJOIN_S = 1.5 // re-join blend duration (G2: re-join blended within 1.5 s)
const MLAT_REJOIN_S = 3 // MLAT revisions (every sample re-smooths the newest knots) blend over ≈ one smoothing window
const D = 1e-3 // s, forward-difference step for the on-screen velocity at a re-join

interface V { ve: number; vn: number }
interface P3 { e: number; n: number; h: number }

const wrap360 = (d: number): number => ((d % 360) + 360) % 360
const wrap180 = (d: number): number => wrap360(d + 180) - 180
const dirDeg = (v: V): number => wrap360(Math.atan2(v.ve, v.vn) * DEG)

/** The reported velocity is trusted unless the positions clearly contradict it: > 20 % in speed or > 15° in direction. */
function agrees(rep: V, fd: V): boolean {
  const vFd = Math.hypot(fd.ve, fd.vn)
  if (vFd < CHECK_MIN_MS) return true
  return Math.abs(Math.hypot(rep.ve, rep.vn) - vFd) <= 0.2 * vFd && Math.abs(wrap180(dirDeg(rep) - dirDeg(fd))) <= 15
}

/** Turn rate for dead reckoning: track change between the newest knot and the newest knot ≥ 2 s older (1 Hz jitter averages out). */
function recentTurnDegS(k: KinPoint[]): number {
  const last = k[k.length - 1]
  let i = k.length - 2
  while (i > 0 && k[i].t > last.t - 2) i--
  const ref = k[i]
  if (ref === undefined || Math.hypot(ref.ve, ref.vn) < 1 || Math.hypot(last.ve, last.vn) < 1) return 0
  const w = turnRateDegS(dirDeg(ref), dirDeg(last), last.t - ref.t)
  return Math.max(-MAX_TURN_DEGS, Math.min(MAX_TURN_DEGS, w))
}

interface Model {
  tE: number // evaluation time: render time, frozen EXTRAP_S after the last knot
  over: number // render time − last knot time, s (> 0 = extrapolating)
  hz: HState
  ci: number // current sample: the newest one at or before the render time
  hM: number
  vsMs: number | null
}

/**
 * Delayed-playback estimator for one aircraft. Times inside are seconds since the first sample.
 * Horizontal: a local ENU frame whose origin is the first sample at h = 0, moved to the newest sample only when that is
 * > 100 km away (the tangent plane then sags ≤ 0.8 km below it, handled by #geo). ADS-B knots take their velocity from
 * gs/track (true heading on the ground when track is missing), falling back to the finite difference of neighbouring
 * samples, which also vetoes a reported velocity that disagrees with it. MLAT knots go gate → smooth → differentiate.
 * Hermite between knots; constant-turn dead reckoning after the newest for ≤ 8 s, then frozen ('stale').
 * Whenever a new sample changes the estimate at the last rendered time (after extrapolating, or when MLAT smoothing
 * revises recent knots), a RejoinBlend plus a velocity bump absorb the difference, so the rendered path keeps its
 * position and velocity (C1) in all three axes.
 * Vertical: AltitudeLadder → VerticalFilter. Attitude: targetAttitude → AttitudeSmoother, stepped by render-time deltas.
 */
export class Track {
  readonly hex: string
  readonly #pollPeriodS: number
  readonly #dedupe = new Deduper()
  #samples: Sample[] = []
  #gamma: number[] = [] // per sample: bearing of local true north in the ENU frame, deg (meridian convergence)
  #knots: KinPoint[] = []
  #turnDegS = 0
  #enu: Enu | null = null
  #t0Ms = 0
  readonly #ladder = new AltitudeLadder()
  readonly #vf = new VerticalFilter()
  #altSource: AltSource = 'baro-bias' // until any rung has been seen: the least-trusted one
  #callsign: string | null = null
  #typeCode: string | null = null
  #blend = new RejoinBlend(REJOIN_S)
  #vBlend = new RejoinBlend(REJOIN_S) // vertical position error rides in its `e` component
  #bump: P3 = { e: 0, n: 0, h: 0 } // velocity error at the last re-join, m/s
  #bumpT0 = NaN
  #bumpS = REJOIN_S
  #att = new AttitudeSmoother()
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
      const rate = s.geomRateFpm !== null && h.source === 'geom' ? s.geomRateFpm : s.baroRateFpm
      this.#vf.add(this.#ts(s.tMs), h.hM, rate === null ? null : rate * FPM)
      this.#altSource = h.source
    }
    this.#callsign = s.callsign ?? this.#callsign
    this.#typeCode = s.typeCode ?? this.#typeCode
    this.#rebuild()
    if (was?.[0] && was[1] && tPrev !== null) this.#rejoin(was[0], was[1], oldEnu!, tPrev)
    return true
  }

  stateAt(tRenderMs: number): RenderState | null {
    const tS = this.#ts(tRenderMs)
    const m = this.#model(tS)
    if (m === null) return null
    const dtS = this.#lastT === null ? 0 : tS - this.#lastT
    if (dtS < 0) this.#att = new AttitudeSmoother() // render time went backwards: start the attitude afresh
    this.#lastT = tS
    const cur = this.#samples[m.ci]
    const off = this.#offset(tS)
    const g = this.#geo(m.hz.e + off.e, m.hz.n + off.n)
    const gsMs = Math.hypot(m.hz.ve, m.hz.vn)
    const trackDeg = gsMs >= 0.5 ? wrap360(dirDeg(m.hz) - this.#gamma[m.ci]) : cur.trackDeg
    const att = this.#att.step(
      targetAttitude({
        gsMs,
        vsMs: m.vsMs ?? 0,
        headingDeg: this.#trueHeading(m.ci, tS, m.tE) ?? trackDeg ?? 0,
        broadcastRollDeg: cur.rollDeg,
        turnRateDegS: turnRateDegS(dirDeg(this.#horiz(m.tE - 1)), dirDeg(m.hz), 1),
        onGround: cur.onGround,
        phase: null,
        mlat: cur.quality === 'mlat',
      }),
      Math.max(0, dtS),
    )
    return {
      hex: this.hex,
      lat: g.lat,
      lon: g.lon,
      hM: m.hM + off.h,
      headingDeg: att.headingDeg,
      pitchDeg: att.pitchDeg,
      rollDeg: att.rollDeg,
      gsKt: this.#knots.length < 2 && cur.gsKt === null ? null : gsMs / KT,
      trackDeg,
      altBaroFt: cur.altBaroFt,
      vsFpm: m.vsMs === null ? null : m.vsMs / FPM,
      mode: m.over <= 0 ? 'interp' : m.over <= EXTRAP_S ? 'extrap' : 'stale',
      altSource: this.#altSource,
      onGround: cur.onGround,
      ageS: (tRenderMs - this.#samples[this.#samples.length - 1].tMs) / 1000,
      quality: cur.quality,
      callsign: this.#callsign,
      typeCode: this.#typeCode,
    }
  }

  /** p90 of the gaps between consecutive samples whose later sample is within the last 60 s. 0 with < 2 samples. */
  gapP90S(): number {
    const ss = this.#samples
    const gaps: number[] = []
    for (let i = ss.length - 1; i > 0 && ss[ss.length - 1].tMs - ss[i].tMs <= GAP_WINDOW_MS; i--) gaps.push((ss[i].tMs - ss[i - 1].tMs) / 1000)
    return p90(gaps)
  }

  /** The newest sample's quality ('other' before any sample). It also picks the ADS-B or MLAT knot pipeline. */
  get quality(): Quality {
    return this.#samples[this.#samples.length - 1]?.quality ?? 'other'
  }

  get newestTMs(): number | null {
    return this.#samples[this.#samples.length - 1]?.tMs ?? null
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
   * Rebuilds every knot from the window.
   * ponytail: O(window) per sample (≈ 240 fwd() calls at 1 Hz); upgrade to incremental ADS-B knots if a busy view shows it.
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
    const fd = velocitiesFromPositions(pts) // central differences, one-sided at the ends, 0 for a lone sample
    if (this.quality === 'mlat') {
      // ponytail: the pipeline follows the newest sample's quality for the whole window; mixed windows are rare.
      const gsKt = Math.max(0, ...ss.map((s) => s.gsKt ?? 0))
      this.#knots = velocitiesFromPositions(smoothPositions(gateOutliers(pts, gsKt > 0 ? 1.5 * gsKt * KT : 360), 2))
    } else {
      this.#knots = pts.map((p, i) => ({ ...p, ...this.#reported(i, fd[i]) }))
    }
    this.#turnDegS = recentTurnDegS(this.#knots)
  }

  /** Knot velocity for ADS-B-like samples: reported gs + track (true heading on the ground), unless the positions veto it. */
  #reported(i: number, fd: V): V {
    const s = this.#samples[i]
    const dir = s.trackDeg ?? (s.onGround ? s.trueHeadingDeg : null)
    if (s.gsKt === null || dir === null) return { ve: fd.ve, vn: fd.vn }
    const a = (dir + this.#gamma[i]) / DEG
    const rep = { ve: s.gsKt * KT * Math.sin(a), vn: s.gsKt * KT * Math.cos(a) }
    return agrees(rep, fd) ? rep : { ve: fd.ve, vn: fd.vn }
  }

  #horiz(t: number): HState {
    const k = this.#knots
    const last = k[k.length - 1]
    if (t >= last.t || k.length < 2) return extrapolate(last, this.#turnDegS, Math.max(0, t - last.t))
    let i = k.length - 2
    while (i > 0 && k[i].t > t) i-- // render time sits near the newest knots: scan from the end
    return hermite(k[i], k[i + 1], t)
  }

  /** Everything position-like at render time tS, without blends. null before the first sample. */
  #model(tS: number): Model | null {
    const ss = this.#samples
    if (ss.length === 0 || tS < this.#ts(ss[0].tMs)) return null
    const lastT = this.#knots[this.#knots.length - 1].t
    const tE = Math.min(tS, lastT + EXTRAP_S)
    let ci = ss.length - 1
    while (ci > 0 && this.#ts(ss[ci].tMs) > tS) ci--
    return { tE, over: tS - lastT, hz: this.#horiz(tE), ci, ...this.#vertical(tE, ci) }
  }

  /**
   * Airborne: the filtered height. On the ground: the last airborne filtered height if it is < 60 s old, else the
   * sample's geoid N (MSL 0 as HAE). Consumers clamp ground aircraft to terrain; real touchdown handling is M4's job.
   * ponytail: no filter re-seed after a ground segment or a long airborne gap; α-β re-converges over ~10 samples.
   */
  #vertical(tE: number, ci: number): { hM: number; vsMs: number | null } {
    const ss = this.#samples
    const cur = ss[ci]
    if (!cur.onGround) return this.#vf.at(tE) ?? { hM: cur.nM, vsMs: null }
    for (let i = ci; i >= 0 && tE - this.#ts(ss[i].tMs) < GROUND_HOLD_S; i--) {
      const v = ss[i].onGround ? null : this.#vf.at(this.#ts(ss[i].tMs))
      if (v) return { hM: v.hM, vsMs: 0 }
    }
    return { hM: cur.nM, vsMs: 0 }
  }

  /** True heading when the current sample has one: interpolated the short way to the next sample, turned along while extrapolating. */
  #trueHeading(ci: number, tS: number, tE: number): number | null {
    const a = this.#samples[ci]
    if (a.trueHeadingDeg === null) return null
    const b = this.#samples[ci + 1]
    const ta = this.#ts(a.tMs)
    if (b === undefined) return a.trueHeadingDeg + this.#turnDegS * Math.max(0, tE - ta)
    if (b.trueHeadingDeg === null) return a.trueHeadingDeg
    const u = (tS - ta) / (this.#ts(b.tMs) - ta)
    return a.trueHeadingDeg + u * wrap180(b.trueHeadingDeg - a.trueHeadingDeg)
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
   * A new sample may have moved the estimate at the last rendered time t (after extrapolating, or MLAT smoothing
   * revising recent knots). m0, m1 = the old estimate at t and t + D. Blend from what was on screen to the new estimate.
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

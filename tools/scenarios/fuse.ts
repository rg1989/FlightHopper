// tools/scenarios/fuse.ts
// A scenario's path from sources of mixed quality (a flight recorder's chart, a multilateration or radar record, a
// report's figures), for the tools that build scenario packages. Three physical facts make it hold together where the
// sources are sparse or disagree:
//   - every altitude has two errors: its value's, and its time stamp's. In a 20,000 ft/min dive a 3-s timing error is
//     1,000 ft, so a source counts for less where the aircraft climbs or dives fast (two passes: the first finds the
//     rate). Forcing a path through every fix at its face value is what drew near-vertical spikes between them.
//   - where the airspeed is known, height and speed trade through energy: h + TAS²/2g changes only as fast as the
//     engines and drag allow (specific excess power Ps, a few tens of m/s for an airliner), so the climb rate is
//     Ps − (TAS/g)·dTAS/dt. An aircraft cannot dive and slow down, or zoom and speed up, beyond that.
//   - over the ground the aircraft moves at its airspeed plus the wind, and the wind changes slowly: noisy positions
//     give the path and the wind, the airspeed the speed along it.
import { trueAirspeedKt } from '../../client/track/airspeed.ts'
import { quintic, smooth, type Knot3, type Limits, type Obs } from '../../client/track/smoother.ts'

const FT = 0.3048
const KT = 1852 / 3600
const G = 9.80665
/** An airliner's specific excess power spans ±~40 m/s (full thrust climbing, idle and drag diving): its spread. */
export const PS_SD_MS = 25
const ENERGY_STEP_S = 10 // one energy observation per ~10 s: Ps drifts on that scale, and recorder charts are that coarse
const ENERGY_HALF_S = 5 // dTAS/dt over ± this
const STEP_S = 2 // the model steps at least this often between sources: sparse sources are the data, not a dropout

/** An altitude (ft), its error (ft) and its time stamp's error (s). */
export interface HeightObs { t: number; hFt: number; sdFt: number; sdT: number }
/** A vertical rate (ft/s) and its error: a flare, a level-off the story states. */
export interface RateObs { t: number; vFtS: number; sdFtS: number }
export interface HeightOpts {
  q: number // the white-jerk model's spectral density, m²/s⁵
  lim: Limits // m/s, m/s²
  casAt?: (t: number) => number | null // calibrated airspeed (kt) where known: energy ties the height to it
  energyFrom?: number // the energy observations' span, s (default: the altitudes')
  energyTo?: number
}

/** The smoothed state at t: the white-jerk path between knots, held at the ends. */
export function knotAt(ks: readonly Knot3[], t: number): { p: number; v: number; a: number } {
  if (t <= ks[0].t) return { p: ks[0].p, v: ks[0].v, a: ks[0].a }
  const last = ks[ks.length - 1]
  if (t >= last.t) return { p: last.p, v: last.v, a: 0 }
  let lo = 0
  let hi = ks.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (ks[mid].t <= t) lo = mid
    else hi = mid
  }
  return quintic(ks[lo], ks[hi], t)
}

/**
 * smooth() for a builder's sources, sparse by nature: the model steps every STEP_S between them. (smooth() reads a gap
 * over 4 s as a live feed's dropout, after which the aircraft may have done anything and the next fix is taken on
 * trust; here the model's own physics, and its 4σ outlier gate, must hold between fixes 10–30 s apart.)
 */
export function smoothSparse(obs: readonly Obs[], q: number, lim: Limits | null): Knot3[] {
  const sorted = [...obs].sort((a, b) => a.t - b.t)
  const steps: Obs[] = []
  for (let t = sorted[0].t; t < sorted[sorted.length - 1].t; t += STEP_S) steps.push({ t, p: null, rp: 0, v: null, rv: 0 })
  return smooth([...steps, ...sorted].sort((a, b) => a.t - b.t), q, lim)
}

/** The height (m, with its rate and acceleration) at every observation time, both passes' worth of physics applied. */
export function fuseHeight(heights: readonly HeightObs[], rates: readonly RateObs[], o: HeightOpts): Knot3[] {
  const run = (hVar: (h: HeightObs) => number, extra: readonly RateObs[]): Knot3[] =>
    smoothSparse([
      ...heights.map((h) => ({ t: h.t, p: h.hFt * FT, rp: hVar(h), v: null, rv: 0 })),
      ...[...rates, ...extra].map((r) => ({ t: r.t, p: null, rp: 0, v: r.vFtS * FT, rv: (r.sdFtS * FT) ** 2 })),
    ], o.q, o.lim)
  const first = run((h) => (h.sdFt * FT) ** 2, [])
  const vsAt = (t: number): number => knotAt(first, t).v
  const energy: RateObs[] = []
  if (o.casAt) {
    const from = o.energyFrom ?? heights[0].t
    const to = o.energyTo ?? heights[heights.length - 1].t
    const tas = (t: number): number | null => {
      const cas = o.casAt!(t)
      return cas === null ? null : trueAirspeedKt(cas, knotAt(first, t).p / FT) * KT
    }
    for (let t = from + ENERGY_HALF_S; t <= to - ENERGY_HALF_S; t += ENERGY_STEP_S) {
      const [v0, v, v1] = [tas(t - ENERGY_HALF_S), tas(t), tas(t + ENERGY_HALF_S)]
      if (v0 === null || v === null || v1 === null) continue
      energy.push({ t, vFtS: (-(v / G) * (v1 - v0)) / (2 * ENERGY_HALF_S) / FT, sdFtS: PS_SD_MS / FT })
    }
  }
  return run((h) => (h.sdFt * FT) ** 2 + (vsAt(h.t) * h.sdT) ** 2, energy)
}

// The wind: fitted over the points flown within ±WIND_DH_M of the height and ±WIND_T_S of the time. Winds aloft change
// slowly over an hour and a region, but with height; an aircraft that climbs and dives through them within minutes
// (and turns: the wind triangle needs directions) measures each layer many times.
const WIND_T_S = 1200
const WIND_DH_M = 450 // ±1,500 ft
const AIR_STEP_S = 10 // one ground-velocity observation per ~10 s, as the airspeed's own resolution
const AIR_SD_MS = 15 // per axis: the heading's and the wind's error (the wind is a fit, to ~20 kt), flying straight
const TURN_S = 5 // in a turn the direction is uncertain by the turn rate × this (half an observation step)

interface AirPt { t: number; hM: number; gx: number; gy: number; air: number; turn: number }

/**
 * The wind over pts (a window of ground velocities and airspeeds): the vector w that makes |ground − w| the airspeed
 * in every direction flown (the wind triangle, by Gauss–Newton from the no-crab guess, lightly held to it where the
 * directions do not tell: flying straight, the crosswind hides in an unknown crab).
 */
function fitWind(pts: readonly AirPt[]): [number, number] {
  let [w0x, w0y] = [0, 0]
  for (const p of pts) {
    const g = Math.hypot(p.gx, p.gy)
    w0x += (p.gx - (p.air * p.gx) / g) / pts.length
    w0y += (p.gy - (p.air * p.gy) / g) / pts.length
  }
  let [wx, wy] = [w0x, w0y]
  const RIDGE = 0.05 * pts.length // pull toward the guess, per unit of the fit's own weight
  for (let it = 0; it < 8; it++) {
    let [a, b, c, rx, ry] = [RIDGE, 0, RIDGE, RIDGE * (w0x - wx), RIDGE * (w0y - wy)]
    for (const p of pts) {
      const dx = p.gx - wx
      const dy = p.gy - wy
      const d = Math.hypot(dx, dy)
      if (d < 1) continue
      const [jx, jy] = [-dx / d, -dy / d] // ∂|g − w|/∂w
      const r = d - p.air
      a += jx * jx
      b += jx * jy
      c += jy * jy
      rx -= jx * r
      ry -= jy * r
    }
    const det = a * c - b * b
    wx += (c * rx - b * ry) / det
    wy += (a * ry - b * rx) / det
  }
  return [wx, wy]
}

/**
 * The ground path (east and north, m) from position observations per axis (the same times, in the same order), made
 * to move through the air at its airspeed: airAt(t) is the horizontal airspeed (m/s: √(TAS² − VS²)) and the height (m)
 * where known. Three passes: the positions alone give the ground velocity; against the airspeed that gives the wind
 * (the wind triangle, fitted by layer: WIND_DH_M, WIND_T_S) and the heading (the direction of ground velocity − wind),
 * and the ground velocity airspeed × heading + wind is observed every AIR_STEP_S, with the positions; then any turn the
 * positions were too sparse to show is flown again (flyTurns). Returns the wind too (m/s, the vector it blows toward),
 * and the turns flown again.
 */
export function fuseGround(e: readonly Obs[], n: readonly Obs[], airAt: (t: number) => { air: number; hM: number } | null, q: number, lim: Limits): { e: Knot3[]; n: Knot3[]; wind: Array<{ t: number; wx: number; wy: number }>; turns: Turn[] } {
  const e1 = smoothSparse(e, q, lim)
  const n1 = smoothSparse(n, q, lim)
  const t0 = Math.max(e1[0].t, n1[0].t)
  const t1 = Math.min(e1[e1.length - 1].t, n1[n1.length - 1].t)
  const fixes: Fix[] = []
  e.forEach((o, i) => {
    const pn = n[i].p
    if (o.p !== null && pn !== null) fixes.push({ t: o.t, e: o.p, n: pn, sd: Math.sqrt(o.rp) })
  })
  // The turns the positions cut short, found before the wind is known (slower over the ground than any wind explains):
  // they slow the smoothed path around them, which the wind fit would take for a headwind. Kept out of it.
  const cut = unresolved(e1, n1, fixes, airAt, () => [0, 0], CUT_BAND)
  const clear = (t: number): boolean => !cut.some((s) => t > s.t0 && t < s.t1)
  const pts: AirPt[] = []
  for (let t = t0; t <= t1; t += AIR_STEP_S) {
    const at = airAt(t)
    const ke = knotAt(e1, t)
    const kn = knotAt(n1, t)
    const gs = Math.hypot(ke.v, kn.v)
    if (at === null || gs < 20 || !clear(t)) continue // slower than 40 kt over the ground: no direction to trust
    pts.push({ t, hM: at.hM, gx: ke.v, gy: kn.v, air: at.air, turn: (ke.v * kn.a - kn.v * ke.a) / (gs * gs) })
  }
  const ve: Obs[] = []
  const vn: Obs[] = []
  const wind: Array<{ t: number; wx: number; wy: number }> = []
  for (const p of pts) {
    const [wx, wy] = fitWind(pts.filter((o) => Math.abs(o.t - p.t) <= WIND_T_S && Math.abs(o.hM - p.hM) <= WIND_DH_M))
    const ax = p.gx - wx
    const ay = p.gy - wy
    const a = Math.hypot(ax, ay)
    if (a < 1) continue
    const sd = Math.hypot(AIR_SD_MS, p.air * p.turn * TURN_S)
    ve.push({ t: p.t, p: null, rp: 0, v: (p.air * ax) / a + wx, rv: sd ** 2 })
    vn.push({ t: p.t, p: null, rp: 0, v: (p.air * ay) / a + wy, rv: sd ** 2 })
    wind.push({ t: p.t, wx, wy })
  }
  const e2 = smoothSparse([...e, ...ve], q, lim)
  const n2 = smoothSparse([...n, ...vn], q, lim)
  const windAt = (t: number): [number, number] | null => {
    if (wind.length === 0 || t < wind[0].t || t > wind[wind.length - 1].t) return null
    const i = Math.max(1, wind.findIndex((w) => w.t >= t))
    const [a, b] = [wind[i - 1], wind[i]]
    const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0
    return [a.wx + u * (b.wx - a.wx), a.wy + u * (b.wy - a.wy)]
  }
  const turns = flyTurns(merge([...cut, ...unresolved(e2, n2, fixes, airAt, windAt, TURN_BAND)]), e2, n2, fixes, airAt, windAt)
  if (turns.length === 0) return { e: e2, n: n2, wind, turns: [] }
  // The turns flown again are spliced in as they are (dead reckoning is the physics, and a smoothing would cut a 2-g
  // turn short again), cross-faded over their first and last TURN_PAD_S into the path the rest of the positions give.
  const outside = (o: Obs): boolean => !turns.some((s) => o.t > s.t0 && o.t < s.t1)
  return {
    e: splice(smoothSparse([...e.filter(outside), ...ve.filter(outside)], q, lim), turns, 'e'),
    n: splice(smoothSparse([...n.filter(outside), ...vn.filter(outside)], q, lim), turns, 'n'),
    wind,
    turns: turns.map(({ path: _, ...t }) => t),
  }
}

/** The knots of `ks` outside the turns, and each turn's dead-reckoned path, faded in and out over TURN_PAD_S. */
function splice(ks: readonly Knot3[], turns: readonly FlownTurn[], axis: 'e' | 'n'): Knot3[] {
  const out: Knot3[] = ks.filter((k) => !turns.some((s) => k.t > s.t0 && k.t < s.t1))
  for (const s of turns) {
    const P = s.path[axis]
    for (const k of P) {
      const w = Math.min(1, (k.t - s.t0) / TURN_PAD_S, (s.t1 - k.t) / TURN_PAD_S)
      const u = w * w * (3 - 2 * w) // smoothstep
      const o = knotAt(ks, k.t)
      out.push({ t: k.t, p: o.p + u * (k.p - o.p), v: o.v + u * (k.v - o.v), a: o.a + u * (k.a - o.a) })
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

// ---- turns the positions are too sparse to show ---------------------------------------------------------------------

// Through the air slower than the first share of the airspeed, or faster than the second: a turn the positions did not
// resolve (or the overshoot after one); before the wind is known, over the ground, wider (no airliner's wind is 40 % of
// its airspeed).
const TURN_BAND = [0.7, 1.4] as const
const CUT_BAND = [0.6, 1.5] as const
const TURN_MERGE_S = 6
const TURN_PAD_S = 8 // flown again from this long before to this long after, from and to a path the positions show
const TURN_MAX_S = 480 // several loops in a row merge into one stretch
const DR_S = 0.5 // dead reckoning's step
const KNOT_S = 5 // one turn-rate knot per this many seconds (a roll into a turn takes a few)
const LIMIT_BANK = (67 * Math.PI) / 180 // a 2.5-g turn: an airliner's limit load
// The fit's weights (each residual's spread): meet the path at the far end, heading too; start and end turning as it
// does; change the turn rate gradually; prefer gentle turns, mildly; beyond the airframe's limit, steeply.
const SD_END_M = 30
const SD_END_RAD = 0.1
const SD_EDGE_RATE = 0.03 // rad/s
const SD_DRATE = 0.04 // rad/s per knot
const SD_RATE = 0.3 // rad/s
const SD_OVER = 0.005 // rad/s

/** A position fix (m, east and north) and its error. */
interface Fix { t: number; e: number; n: number; sd: number }
/** A turn flown again: its span, the whole circles added to what the positions showed (+ right), its steepest bank. */
export interface Turn { t0: number; t1: number; circles: number; maxBankDeg: number }
interface FlownTurn extends Turn { path: { e: Knot3[]; n: Knot3[] } }
type AirAt = (t: number) => { air: number } | null
type WindAt = (t: number) => [number, number] | null
interface Span { t0: number; t1: number }
interface Edge { e: number; n: number; psi: number; rate: number }

/**
 * The stretches where the path moves through the air (ground velocity − wind) at a speed outside [lo, hi] × the
 * airspeed: a turn the positions cut short, or the overshoot a smoothing makes after one. Each runs from the second
 * fix before it to the second fix after it, and TURN_PAD_S beyond, so that both ends are on a path the positions show;
 * overlapping ones merged.
 */
function unresolved(e: readonly Knot3[], n: readonly Knot3[], fixes: readonly Fix[], airAt: AirAt, windAt: WindAt, [lo, hi]: readonly [number, number]): Span[] {
  const fixT = fixes.map((f) => f.t)
  const before = (t: number): number => fixT.filter((x) => x < t).at(-2) ?? fixT[0] ?? t
  const after = (t: number): number => fixT.filter((x) => x > t)[1] ?? fixT.at(-1) ?? t
  const out: Span[] = []
  const known = (t: number): boolean => airAt(t) !== null && windAt(t) !== null
  const tB = Math.floor(Math.min(e[e.length - 1].t, n[n.length - 1].t))
  for (let t = Math.ceil(Math.max(e[0].t, n[0].t)); t <= tB; t++) {
    if (!known(t)) continue
    const a = airAt(t)!
    const w = windAt(t)!
    const v = Math.hypot(knotAt(e, t).v - w[0], knotAt(n, t).v - w[1])
    if (v >= lo * a.air && v <= hi * a.air) continue
    // Only as far as the airspeed and the wind are known (the edge of the record, of the air data).
    let [t0, t1] = [before(t) - TURN_PAD_S, after(t) + TURN_PAD_S]
    while (t0 < t && !known(t0)) t0 += 1
    while (t1 > t && !known(t1)) t1 -= 1
    out.push({ t0, t1 })
  }
  return merge(out)
}

function merge(spans: readonly Span[]): Span[] {
  const out: Span[] = []
  for (const sp of [...spans].sort((a, b) => a.t0 - b.t0)) {
    const last = out[out.length - 1]
    if (last !== undefined && sp.t0 <= last.t1 + TURN_MERGE_S) last.t1 = Math.max(last.t1, sp.t1)
    else out.push({ ...sp })
  }
  return out
}

/**
 * Where the path the positions give moves through the air far slower than the airspeed, the aircraft flew a loop or a
 * spiral between two fixes 10–30 s apart that the smoothing cut short. Each such stretch (spans) is flown again by dead
 * reckoning (the airspeed along a heading, plus the wind), its turn rate fitted so that it leaves the path before and
 * joins the path after, at their headings, passes the fixes in between within their error, and turns as gently as it
 * can within an airliner's limit: up to 3 extra circles either way, the one that fits best. Returns each with its
 * path (per axis: position, velocity, acceleration every DR_S).
 */
function flyTurns(spans: readonly Span[], e2: readonly Knot3[], n2: readonly Knot3[], fixes: readonly Fix[], airAt: AirAt, windAt: WindAt): FlownTurn[] {
  const turns: FlownTurn[] = []
  for (const sp of spans) {
    if (sp.t1 - sp.t0 > TURN_MAX_S || airAt(sp.t0) === null || airAt(sp.t1) === null || windAt(sp.t0) === null || windAt(sp.t1) === null) continue
    const a = edge(e2, n2, windAt, sp.t0)
    const b = edge(e2, n2, windAt, sp.t1)
    const inside = fixes.filter((f) => f.t > sp.t0 && f.t < sp.t1)
    const K = Math.max(3, Math.round((sp.t1 - sp.t0) / KNOT_S) + 1)
    const dpsi = wrapPi(b.psi - a.psi)
    let best: { cost: number; om: Float64Array; circles: number } | null = null
    for (const circles of [0, 1, -1, 2, -2, 3, -3]) {
      const total = dpsi + 2 * Math.PI * circles
      const om = fitTurnRates(sp, a, b, total, inside, K, airAt, windAt)
      const cost = sumSq(turnResiduals(sp, a, b, total, inside, om, airAt, windAt))
      if (best === null || cost < best.cost) best = { cost, om, circles }
    }
    const p = deadReckon(sp, a, best!.om, airAt, windAt)
    const path: FlownTurn['path'] = { e: [], n: [] }
    let maxBank = 0
    for (let i = 0; i < p.t.length; i++) {
      const air = airAt(p.t[i])?.air ?? 0
      maxBank = Math.max(maxBank, Math.atan((air * Math.abs(p.om[i])) / G))
      // The acceleration of a turn at rate ω: the velocity through the air rotated a quarter turn, times ω.
      const [ax, ay] = [p.ve[i] - p.w[i][0], p.vn[i] - p.w[i][1]]
      path.e.push({ t: p.t[i], p: p.e[i], v: p.ve[i], a: ay * p.om[i] })
      path.n.push({ t: p.t[i], p: p.n[i], v: p.vn[i], a: -ax * p.om[i] })
    }
    turns.push({ t0: sp.t0, t1: sp.t1, circles: best!.circles, maxBankDeg: (maxBank * 180) / Math.PI, path })
  }
  return turns
}

/** The path's position, heading through the air (rad from north, clockwise) and that heading's rate at t. */
function edge(e2: readonly Knot3[], n2: readonly Knot3[], windAt: WindAt, t: number): Edge {
  const ke = knotAt(e2, t)
  const kn = knotAt(n2, t)
  const [wx, wy] = windAt(t)!
  const ax = ke.v - wx
  const ay = kn.v - wy
  return { e: ke.p, n: kn.p, psi: Math.atan2(ax, ay), rate: (ay * ke.a - ax * kn.a) / Math.max(1, ax * ax + ay * ay) }
}

const wrapPi = (x: number): number => x - 2 * Math.PI * Math.floor((x + Math.PI) / (2 * Math.PI))
const sumSq = (r: readonly number[]): number => r.reduce((s, x) => s + x * x, 0)

/** Dead reckoning over the span from a's position and heading, the turn rate linear between its knots. */
function deadReckon(sp: Span, a: Edge, om: Float64Array, airAt: AirAt, windAt: WindAt) {
  const K = om.length
  const rateAt = (t: number): number => {
    const x = ((t - sp.t0) / (sp.t1 - sp.t0)) * (K - 1)
    const j = Math.min(K - 2, Math.max(0, Math.floor(x)))
    return om[j] + (x - j) * (om[j + 1] - om[j])
  }
  let air = airAt(sp.t0)!.air
  let w = windAt(sp.t0)!
  const out = { t: [sp.t0], e: [a.e], n: [a.n], psi: [a.psi], om: [rateAt(sp.t0)], ve: [air * Math.sin(a.psi) + w[0]], vn: [air * Math.cos(a.psi) + w[1]], w: [w] }
  let [pe, pn, psi] = [a.e, a.n, a.psi]
  for (let t = sp.t0; t < sp.t1 - 1e-9; ) {
    const h = Math.min(DR_S, sp.t1 - t)
    const tm = t + h / 2
    const r = rateAt(tm)
    air = airAt(tm)?.air ?? air
    w = windAt(tm) ?? w
    const pm = psi + (r * h) / 2
    pe += (air * Math.sin(pm) + w[0]) * h
    pn += (air * Math.cos(pm) + w[1]) * h
    psi += r * h
    t += h
    out.t.push(t)
    out.e.push(pe)
    out.n.push(pn)
    out.psi.push(psi)
    out.om.push(rateAt(t))
    out.ve.push(air * Math.sin(psi) + w[0])
    out.vn.push(air * Math.cos(psi) + w[1])
    out.w.push(w)
  }
  return out
}

/** The fit's residuals, each over its spread (SD_*). total: the heading change the span makes, rad. */
function turnResiduals(sp: Span, a: Edge, b: Edge, total: number, inside: readonly Fix[], om: Float64Array, airAt: AirAt, windAt: WindAt): number[] {
  const p = deadReckon(sp, a, om, airAt, windAt)
  const last = p.t.length - 1
  const r = [(p.e[last] - b.e) / SD_END_M, (p.n[last] - b.n) / SD_END_M, (p.psi[last] - (a.psi + total)) / SD_END_RAD]
  for (const f of inside) {
    const i = Math.min(last, Math.max(1, Math.ceil((f.t - sp.t0) / DR_S)))
    const u = (f.t - p.t[i - 1]) / (p.t[i] - p.t[i - 1])
    r.push((p.e[i - 1] + u * (p.e[i] - p.e[i - 1]) - f.e) / f.sd, (p.n[i - 1] + u * (p.n[i] - p.n[i - 1]) - f.n) / f.sd)
  }
  const K = om.length
  r.push((om[0] - a.rate) / SD_EDGE_RATE, (om[K - 1] - b.rate) / SD_EDGE_RATE)
  for (let j = 0; j < K; j++) {
    if (j > 0) r.push((om[j] - om[j - 1]) / SD_DRATE)
    r.push(om[j] / SD_RATE)
    const air = airAt(sp.t0 + (j / (K - 1)) * (sp.t1 - sp.t0))?.air ?? 150
    r.push(Math.max(0, Math.abs(om[j]) - (G * Math.tan(LIMIT_BANK)) / Math.max(air, 30)) / SD_OVER)
  }
  return r
}

/** Levenberg–Marquardt on the turn-rate knots, from a steady turn through `total`. */
function fitTurnRates(sp: Span, a: Edge, b: Edge, total: number, inside: readonly Fix[], K: number, airAt: AirAt, windAt: WindAt): Float64Array {
  let om = new Float64Array(K).fill(total / (sp.t1 - sp.t0))
  let r = turnResiduals(sp, a, b, total, inside, om, airAt, windAt)
  let cost = sumSq(r)
  let lambda = 1e-2
  for (let it = 0; it < 30; it++) {
    const J: number[][] = []
    for (let j = 0; j < K; j++) {
      const o = Float64Array.from(om)
      o[j] += 1e-4
      const rj = turnResiduals(sp, a, b, total, inside, o, airAt, windAt)
      J.push(rj.map((x, i) => (x - r[i]) / 1e-4))
    }
    // (JᵀJ + λ·diag(JᵀJ)) δ = −Jᵀr
    const A = J.map((ji) => J.map((jk) => ji.reduce((s, x, m) => s + x * jk[m], 0)))
    const g = J.map((ji) => -ji.reduce((s, x, m) => s + x * r[m], 0))
    let improved = false
    for (let tries = 0; tries < 8 && !improved; tries++) {
      const d = solveLinear(A.map((row, i) => row.map((x, k) => (i === k ? x * (1 + lambda) + 1e-12 : x))), g)
      const o = Float64Array.from(om, (x, j) => x + d[j])
      const ro = turnResiduals(sp, a, b, total, inside, o, airAt, windAt)
      const co = sumSq(ro)
      if (co < cost) {
        om = o
        r = ro
        cost = co
        improved = true
        lambda = Math.max(1e-6, lambda / 3)
      } else lambda *= 4
    }
    if (!improved) break
  }
  return om
}

/** Gaussian elimination with partial pivoting (a small dense system). */
function solveLinear(M: number[][], v: number[]): number[] {
  const n = v.length
  const A = M.map((row, i) => [...row, v[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r
    ;[A[c], A[p]] = [A[p], A[c]]
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c]
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = A[r][n]
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k]
    x[r] = s / A[r][r]
  }
  return x
}

/** Points along a polyline, timed by distance from t0 to t1 (constant speed). */
export function timedPolyline(poly: Array<[number, number]>, t0: number, t1: number, step = 2): Array<{ t: number; e: number; n: number }> {
  const cum = [0]
  for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]))
  const L = cum[cum.length - 1]
  const out: Array<{ t: number; e: number; n: number }> = []
  let j = 1
  for (let t = t0; t <= t1 + 1e-9; t += step) {
    const s = ((t - t0) / (t1 - t0)) * L
    while (j < cum.length - 1 && cum[j] < s) j++
    const u = (s - cum[j - 1]) / Math.max(1e-9, cum[j] - cum[j - 1])
    out.push({ t, e: poly[j - 1][0] + u * (poly[j][0] - poly[j - 1][0]), n: poly[j - 1][1] + u * (poly[j][1] - poly[j - 1][1]) })
  }
  return out
}

/** A centripetal Catmull–Rom spline through waypoints (metres), densely sampled. */
export function spline(wp: Array<[number, number]>, per = 40): Array<[number, number]> {
  const P = [wp[0], ...wp, wp[wp.length - 1]]
  const out: Array<[number, number]> = []
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]]
    const d = (a: [number, number], b: [number, number]): number => Math.max(1e-6, Math.hypot(b[0] - a[0], b[1] - a[1]) ** 0.5)
    const t1 = d(p0, p1)
    const t2 = t1 + d(p1, p2)
    const t3 = t2 + d(p2, p3)
    for (let k = 0; k < per; k++) {
      const t = t1 + ((t2 - t1) * k) / per
      const lerp = (a: [number, number], b: [number, number], ta: number, tb: number): [number, number] => {
        const w = tb === ta ? 0 : (t - ta) / (tb - ta)
        return [a[0] + w * (b[0] - a[0]), a[1] + w * (b[1] - a[1])]
      }
      const a1 = lerp(p0, p1, 0, t1)
      const a2 = lerp(p1, p2, t1, t2)
      const a3 = lerp(p2, p3, t2, t3)
      const b1 = lerp(a1, a2, 0, t2)
      const b2 = lerp(a2, a3, t1, t3)
      out.push(lerp(b1, b2, t1, t2))
    }
  }
  out.push(wp[wp.length - 1])
  return out
}

// tools/scenarios/kc1388/reconstruct.ts
// Builds public/scenarios/kc1388/track.csv for Air Astana 1388 (11 Nov 2018, ERJ-190LR P4-KCJ), a reconstruction:
//   - 13:34:07–15:04:14 UTC: Flightradar24's multilateration fixes (positions ~every 14 s, the aircraft's own Mode S
//     pressure altitude, FR24's speed and direction), from its blog post's CSV (reference data: not in this repository);
//   - before that, the take-off from Alverca runway 04 at the report's times (take-off 13:30:21, airborne 13:31:35) and the
//     smoothest climb-out to FR24's first fix that keeps the known velocities, altitudes from the report's Figure 13; after 15:04:14 (FR24 had no positions, only
//     altitudes), the three approaches at Beja traced from the report's Figure 3 (a perspective view: to within a few km),
//     timed and height-profiled by FR24's altitude-only record (go-arounds at 15:08:00 and 15:18:40, touchdown ≈ 15:26:50
//     on 19L, the report's "15:27").
// All of it goes through the app's own smoother (client/track/smoother.ts: Kalman + RTS, white jerk), and the attitude is
// the app's flight-mechanics model (client/track/attitude.ts) on that path: the recorded attitude is not published, and
// the aircraft really rolled far more than a path can show. Calibrated airspeed and vertical load come from the report's
// Figure 13, digitised by digitize_fig13.py (≈10 s averages). Every row is q=R.
//
//   node tools/scenarios/kc1388/reconstruct.ts <fr24 positions csv> <fr24 altitude-only csv> <fig13.csv>
import { readFileSync, writeFileSync } from 'node:fs'
import { AttitudeFilter, aeroPitchRoll, densityRatio } from '../../../client/track/attitude.ts'
import { quintic, smooth, type Knot3, type Obs } from '../../../client/track/smoother.ts'

const FT = 0.3048
const KT = 1852 / 3600
const DEG = 180 / Math.PI
const QNH_HPA = 1010 // LPAR 13:00Z and LPBJ 15:00Z/15:20Z METARs (report §1.7): 1010 hPa
const PA_TO_MSL_FT = 27.3 * (QNH_HPA - 1013.25) // pressure altitude → altitude above MSL (no temperature correction)
const OUT_STEP_S = 2
const START = hms('13:29:30')
const END = hms('15:28:00')

function hms(s: string): number {
  const [h, m, sec] = s.split(':').map(Number)
  return h * 3600 + m * 60 + sec
}
const clock = (t: number): string => {
  const s = Math.round(t)
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

// ---- a local tangent plane (equirectangular about the middle of the flight: < 0.5 % over its 150 km) -----------------
const LAT0 = 38.6
const LON0 = -8.4
const M_PER_DEG = 111_195
const COS0 = Math.cos((LAT0 * Math.PI) / 180)
const toEn = (lat: number, lon: number): [number, number] => [(lon - LON0) * M_PER_DEG * COS0, (lat - LAT0) * M_PER_DEG]
const toLl = (e: number, n: number): [number, number] => [LAT0 + n / M_PER_DEG, LON0 + e / (M_PER_DEG * COS0)]
const dir = (deg: number): [number, number] => [Math.sin(deg / DEG), Math.cos(deg / DEG)]

// ---- inputs --------------------------------------------------------------------------------------------------------
const [posCsv, altCsv, figCsv] = process.argv.slice(2)
if (!posCsv || !altCsv || !figCsv) throw new Error('usage: reconstruct.ts <fr24 positions csv> <fr24 altitude-only csv> <fig13.csv>')
const lines = (f: string): string[] => readFileSync(f, 'utf8').replace(/\r\n?/g, '\n').trim().split('\n')

interface Fix { t: number; e: number; n: number; paFt: number; gsKt: number | null; trkDeg: number | null }
const fixes: Fix[] = lines(posCsv).slice(1).map((l) => {
  const m = /^(\d+),([^,]+),([^,]*),"([-\d.]+),([-\d.]+)",(\d+),(\d+),(\d+)$/.exec(l)
  if (m === null) throw new Error(`FR24 line: ${l}`)
  const d = new Date(Number(m[1]) * 1000)
  const [e, n] = toEn(Number(m[4]), Number(m[5]))
  const gs = Number(m[7])
  return { t: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds(), e, n, paFt: Number(m[6]), gsKt: gs > 0 ? gs : null, trkDeg: gs > 0 ? Number(m[8]) : null }
})
// Altitude-only: many replies a second; one median per second.
const altBySec = new Map<number, number[]>()
for (const l of lines(altCsv).slice(1)) {
  const c = l.split(',')
  const m = /(\d\d):(\d\d):(\d\d)Z/.exec(c[0])
  if (m === null || c[6].trim() === '') continue
  const t = hms(`${m[1]}:${m[2]}:${m[3]}`)
  altBySec.set(t, [...(altBySec.get(t) ?? []), Number(c[6])])
}
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const altOnly = [...altBySec].map(([t, xs]) => ({ t, paFt: median(xs) })).sort((a, b) => a.t - b.t)
const fig = lines(figCsv).slice(1).map((l) => {
  const [t, pa, cas, g] = l.split(',')
  const num = (s: string): number | null => (s === '' ? null : Number(s))
  return { t: Number(t), paFt: num(pa), casKt: num(cas), g: num(g) }
})
/** Figure 13's value at t, linear between its (≈10 s) columns; null where the column had none. */
function figAt(t: number, k: 'casKt' | 'g' | 'paFt'): number | null {
  let i = fig.findIndex((r) => r.t >= t)
  if (i <= 0) return null
  const a = fig[i - 1]
  const b = fig[i]
  if (a[k] === null || b[k] === null) return a[k] ?? b[k]
  return a[k]! + ((t - a.t) / (b.t - a.t)) * (b[k]! - a[k]!)
}

// ---- the runways (public/scenarios/kc1388/airport.json) ------------------------------------------------------------
const THR04 = toEn(38.8737041, -9.037774)
const HDG04 = 32.5
const THR19R = toEn(38.0943509, -7.930368)
const THR19L = toEn(38.0919489, -7.9282007)
const HDG19 = 185.9
const LPAR_FT = 11
const LPBJ_FT = 617

// ---- synthetic observations ----------------------------------------------------------------------------------------
interface HObs { t: number; e: number; n: number; sd: number; v?: [number, number] }
interface VObs { t: number; hFt: number; vFtS?: number }
const hObs: HObs[] = []
const vObs: VObs[] = []
const ground: Array<[number, number]> = [] // on the ground: [from, to]

// FR24's fixes, re-timed. Their positions line up, but their time stamps wander: consecutive fixes imply 108–381 kt
// (p5–p95) where the aircraft flew at ~250, and FR24's own speed and direction often repeat a stale value (220 kt, 239°
// for the last 3 min). So each fix's time comes from the distance flown at the recorded airspeed (Figure 13's CAS as
// true airspeed at the fix's height), plus a slowly varying offset (the median of time stamp − that time over ±15 fixes,
// then averaged) that keeps the timing on FR24's clock over minutes and absorbs the wind. FR24's velocities are left
// out; heights keep their fix.
const retimed: number[] = []
{
  const tau: number[] = [fixes[0].t]
  for (let i = 1; i < fixes.length; i++) {
    const a = fixes[i - 1]
    const d = Math.hypot(fixes[i].e - a.e, fixes[i].n - a.n)
    const cas = figAt(a.t, 'casKt') ?? a.gsKt ?? 220
    const tas = (cas * KT) / Math.sqrt(densityRatio((a.paFt + PA_TO_MSL_FT) * FT))
    tau.push(tau[i - 1] + d / tas)
  }
  const off = fixes.map((f, i) => f.t - tau[i])
  const W = 15
  const med = off.map((_, i) => median(off.slice(Math.max(0, i - W), i + W + 1)))
  const avg = med.map((_, i) => {
    const w = med.slice(Math.max(0, i - W), i + W + 1)
    return w.reduce((x, y) => x + y, 0) / w.length
  })
  for (let i = 0; i < fixes.length; i++) retimed.push(Math.max(tau[i] + avg[i], i === 0 ? -Infinity : retimed[i - 1] + 2))
}
for (const [i, f] of fixes.entries()) {
  hObs.push({ t: retimed[i], e: f.e, n: f.n, sd: 60 })
  vObs.push({ t: retimed[i], hFt: f.paFt + PA_TO_MSL_FT })
}

// Alverca: lined up 150 m past the threshold; the roll from 13:31:10 (Figure 13's airspeed leaves its floor), lift-off
// at 13:31:38 at 125 kt (report: airborne 13:31:35; Figure 13 ≈ 105 kt at 13:31:33, 137 kt at 13:31:43).
const LINEUP_M = 150
const ROLL_T0 = hms('13:31:10')
const LIFT_T = hms('13:31:38')
const LIFT_MS = 125 * KT
const ACC = LIFT_MS / (LIFT_T - ROLL_T0)
const [de04, dn04] = dir(HDG04)
const along04 = (d: number): [number, number] => [THR04[0] + de04 * d, THR04[1] + dn04 * d]
for (let t = START; t <= LIFT_T; t += 2) {
  const tr = Math.max(0, t - ROLL_T0)
  const [e, n] = along04(LINEUP_M + 0.5 * ACC * tr * tr)
  const v = ACC * tr
  hObs.push({ t, e, n, sd: 3, v: [de04 * v, dn04 * v] })
  vObs.push({ t, hFt: LPAR_FT })
}
ground.push([START, LIFT_T])
// The climb-out to FR24's first fix: no positions are known. The smoother (below) joins the lift-off to the fix with the
// smoothest path that keeps the known velocities: runway heading at lift-off and still at 13:32:48 ("on initial climb
// heading", report p.20) at Figure 13's ~150 kt, then FR24's fix and velocity. Heights from Figure 13.
{
  const at = hms('13:32:48')
  const v = 150 * KT
  hObs.push({ t: at, e: NaN, n: NaN, sd: Infinity, v: [dir(HDG04)[0] * v, dir(HDG04)[1] * v] })
  for (let t = LIFT_T + 4; t < retimed[0]; t += 4) {
    const pa = figAt(t, 'paFt')
    if (pa !== null && pa > 500) vObs.push({ t, hFt: pa + PA_TO_MSL_FT })
  }
  vObs.push({ t: hms('13:31:50'), hFt: LPAR_FT + 150 })
}

/** Points along a polyline, timed by distance from t0 to t1 (constant speed). */
function timedPolyline(poly: Array<[number, number]>, t0: number, t1: number, step = 2): Array<{ t: number; e: number; n: number }> {
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
function spline(wp: Array<[number, number]>, per = 40): Array<[number, number]> {
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

// Beja (Figure 3): each approach comes from the north onto the extended centreline, each go-around carries on south over
// the runway and turns left (east); the second approach's loop reaches ~17 km east, the final one's ~9 km. Offsets in
// km from the 19R threshold: east, north.
const km = (e: number, n: number, from = THR19R): [number, number] => [from[0] + e * 1000, from[1] + n * 1000]
const [c19e, c19n] = dir(HDG19) // along the landing direction (south)
const onCl = (d: number, thr = THR19R): [number, number] => [thr[0] - c19e * d * 1000, thr[1] - c19n * d * 1000] // d km before
const lastFix = { ...fixes[fixes.length - 1], t: retimed[retimed.length - 1] }
const GA1 = hms('15:08:00')
const GA2 = hms('15:18:40')
const TD = hms('15:26:50')
const STOP = hms('15:27:25')
const legs: Array<{ wp: Array<[number, number]>; t0: number; t1: number }> = [
  // 1st approach: from FR24's last fix (south-west bound), onto the 19R centreline, low point ~1 km before the threshold.
  { wp: [[lastFix.e, lastFix.n], km(4, 14), km(1.2, 8), onCl(5), onCl(2.5), onCl(1)], t0: lastFix.t, t1: GA1 },
  // go-around 1 and the second approach's loop: south over the runway, east ~17 km, back west ~9 km north, final 19R.
  {
    wp: [onCl(1), onCl(-1.5), km(2.5, -3.5), km(9, -2), km(15.5, 0.5), km(17.5, 4.5), km(14, 9), km(6, 10), km(1.5, 9.5), onCl(6), onCl(3), onCl(0.4)],
    t0: GA1, t1: GA2,
  },
  // go-around 2 and the final loop: over the whole runway, east ~9 km, back west ~7 km north, final onto 19L.
  {
    wp: [onCl(0.4), onCl(-2), onCl(-3.6), km(2.5, -5), km(7.5, -3), km(9.5, 1.5), km(7, 6.5), km(2, 7.5), onCl(5, THR19L), onCl(2.5, THR19L), onCl(-0.35, THR19L)],
    t0: GA2, t1: TD,
  },
]
for (const leg of legs) {
  const pts = timedPolyline(spline(leg.wp), leg.t0, leg.t1)
  for (const p of pts) if (p.t > lastFix.t) hObs.push({ t: p.t, e: p.e, n: p.n, sd: 40 }) // a leg's first point: the last's end
}
// The landing roll on 19L: from the touchdown (350 m in) to a stop 1.3 km further, decelerating evenly.
{
  const [a, b] = [onCl(-0.35, THR19L), onCl(-1.65, THR19L)]
  const v0 = 2 * Math.hypot(b[0] - a[0], b[1] - a[1]) / (STOP - TD)
  for (let t = TD + 2; t <= END; t += 2) {
    const tt = Math.min(t - TD, STOP - TD)
    const s = v0 * tt - (v0 / (STOP - TD)) * tt * tt * 0.5
    const L = Math.hypot(b[0] - a[0], b[1] - a[1])
    const [ue, un] = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
    const v = t >= STOP ? 0 : v0 * (1 - tt / (STOP - TD))
    hObs.push({ t, e: a[0] + ue * s, n: a[1] + un * s, sd: 3, v: [ue * v, un * v] })
  }
  ground.push([TD, END])
}
// Heights at Beja: FR24's altitude-only record (to 15:26:15), then the runway.
for (const a of altOnly) if (a.t > lastFix.t && a.t < TD) vObs.push({ t: a.t, hFt: a.paFt + PA_TO_MSL_FT }) // (one more reply after the landing)
// The flare: from the record's last airborne height (15:26:15, ~80 ft up) to the touchdown the sink rate eases to nothing,
// so the smoother does not carry the descent below the runway first.
{
  const last = altOnly.filter((a) => a.t < TD).at(-1)!
  const h0 = last.paFt + PA_TO_MSL_FT
  for (let t = last.t + 2; t < TD; t += 2) {
    const u = (t - last.t) / (TD - last.t)
    const dh = h0 - (LPBJ_FT - 10)
    vObs.push({ t, hFt: LPBJ_FT - 10 + dh * (1 - u) ** 2, vFtS: (-2 * dh * (1 - u)) / (TD - last.t) })
  }
}
for (let t = TD; t <= END; t += 2) vObs.push({ t, hFt: LPBJ_FT - 10 }) // 19L's touchdown zone (SRTM 607–630 ft)

// ---- smooth ---------------------------------------------------------------------------------------------------------
hObs.sort((a, b) => a.t - b.t)
vObs.sort((a, b) => a.t - b.t)
const uniq = <T extends { t: number }>(xs: T[]): T[] => xs.filter((x, i) => i === 0 || x.t > xs[i - 1].t)
const H = uniq(hObs)
const V = uniq(vObs)
const Q_H = Number(process.env.Q_H ?? 0.03) // client/track/track.ts Q_MLAT: MLAT positions call for a stiff path
const Q_V = 0.05
const LIM_H = { v: 400, a: 20 }
const LIM_V = { v: 100, a: 20 }
const RV = Number(process.env.RV ?? 5)
const axis = (k: 0 | 1): Obs[] => H.map((o) => ({ t: o.t, p: Number.isFinite(o.e) ? (k === 0 ? o.e : o.n) : null, rp: o.sd ** 2, v: o.v ? o.v[k] : null, rv: RV ** 2 }))
const ke = smooth(axis(0), Q_H, LIM_H)
const kn = smooth(axis(1), Q_H, LIM_H)
const kv = smooth(V.map((o) => ({ t: o.t, p: o.hFt * FT, rp: 4 ** 2, v: o.vFtS === undefined ? null : o.vFtS * FT, rv: 0.3 ** 2 })), Q_V, LIM_V)

function at(ks: Knot3[], t: number): { p: number; v: number; a: number } {
  let lo = 0
  let hi = ks.length - 1
  if (t <= ks[0].t) return { p: ks[0].p, v: ks[0].v, a: ks[0].a }
  if (t >= ks[hi].t) return { p: ks[hi].p, v: ks[hi].v, a: 0 }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (ks[mid].t <= t) lo = mid
    else hi = mid
  }
  return quintic(ks[lo], ks[hi], t)
}

// ---- attitude and rows ----------------------------------------------------------------------------------------------
const onGround = (t: number): boolean => ground.some(([a, b]) => t >= a && t <= b)
const filt = new AttitudeFilter()
const rows: string[] = ['time,lat,lon,alt_ft,hdg,pitch,roll,gnd,ias_kt,g,q,src']
let lastTrk = HDG04
let att = { headingDeg: HDG04, pitchDeg: 0, rollDeg: 0 }
const SUB = 0.5
for (let t = START; t <= END + 1e-9; t += SUB) {
  const e = at(ke, t)
  const n = at(kn, t)
  const h = at(kv, t)
  const gnd = onGround(t)
  const gs = Math.hypot(e.v, n.v)
  const trk = gs > 3 ? Math.atan2(e.v, n.v) * DEG : lastTrk
  lastTrk = trk
  const turn = gs > 3 ? ((n.v * e.a - e.v * n.a) / (gs * gs)) * DEG : 0 // d(track)/dt, + right (clockwise from above)
  const along = gs > 3 ? (e.v * e.a + n.v * n.a) / gs : 0
  const cas = figAt(t, 'casKt')
  const pr = aeroPitchRoll({
    gsMs: gs, vsMs: gnd ? 0 : h.v, turnRateDegS: turn, alongMs2: along, easKt: cas !== null && cas > 60 ? cas : null,
    altM: h.p, onGround: gnd, category: 'A3',
  })
  // Rotation: the nose comes up over the last 3 s of the roll; the touchdown keeps the flare's nose-up for 3 s.
  const rot = t > LIFT_T - 3 && t <= LIFT_T ? ((t - (LIFT_T - 3)) / 3) * 8 : 0
  att = filt.step({ headingDeg: gnd ? (t < TD ? HDG04 : HDG19) : trk, pitchDeg: gnd ? rot : pr.pitchDeg, rollDeg: gnd ? 0 : pr.rollDeg }, SUB)
  if (Math.abs(t / OUT_STEP_S - Math.round(t / OUT_STEP_S)) > 1e-6) continue
  const [lat, lon] = toLl(e.p, n.p)
  const hFt = gnd ? (t < TD ? LPAR_FT : LPBJ_FT - 10) : h.p / FT
  const g = figAt(t, 'g')
  const src = t < retimed[0] ? 'GPIAAF:p.19-20' : t <= lastFix.t ? 'FR24' : 'GPIAAF:p.23'
  const hdg = (Math.round((((att.headingDeg % 360) + 360) % 360) * 10) / 10) % 360
  rows.push([
    clock(t), lat.toFixed(6), lon.toFixed(6), hFt.toFixed(0), hdg.toFixed(1),
    att.pitchDeg.toFixed(1), att.rollDeg.toFixed(1), gnd ? '1' : '', cas !== null && cas > 60 ? cas.toFixed(0) : '',
    g !== null ? g.toFixed(2) : '', 'R', src,
  ].join(','))
}
writeFileSync(new URL('../../../public/scenarios/kc1388/track.csv', import.meta.url), `${rows.join('\n')}\n`)
console.log(`${rows.length - 1} rows, ${clock(START)}–${clock(END)}; fixes ${fixes.length}, altitude-only seconds ${altOnly.length}`)

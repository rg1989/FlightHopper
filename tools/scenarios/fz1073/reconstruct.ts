// tools/scenarios/fz1073/reconstruct.ts
// Builds public/scenarios/fz1073/track.csv for flydubai 1073 (30 Sep 2026, Boeing 737 MAX 8 A6-FKF, Dubai → Tel Aviv,
// diverted to Tabuk) from the aircraft's own ADS-B broadcasts as adsb.lol's receivers heard them (its tar1090 trace of
// the day: GPS positions at ~1 Hz, pressure and GNSS altitude, airspeed, ground velocity; ODbL). Three stretches:
//   - 05:16:30–05:21:44 and 05:31:26–05:53:31: the broadcasts themselves, smoothed by the scenario builders' physics
//     (tools/scenarios/fuse.ts: each source with its own error; height tied to airspeed by energy; the wind fitted);
//   - 05:21:44–05:22:13, the onset of the dive: the positions are smooth, but the pressure altitude jumps by up to
//     1,000 ft within a second (static-pressure errors in violent manoeuvres; the ground speed falls 441 → 377 kt in
//     5 s): those altitudes count for little (ALT_SD_UPSET_FT); the two receptions at 05:22:13 agree on 27,950 ft,
//     descending at ~21,000 ft/min;
//   - 05:22:13–05:31:26, no receiver heard it: the smoothest path between the two ends that keeps their positions and
//     velocities, and a height that follows the dive down to the bottom Israeli media reported from tracking data
//     (BOTTOM_FT, about a minute after it steepened), then down to 15,000 ft, level where reception resumes. q=R.
// The attitude is the app's flight-mechanics model (client/track/attitude.ts) on that path, with an upset's limits
// around the dive: the recorded attitude is not published, and the aircraft certainly pitched more sharply than the path.
//
//   node tools/scenarios/fz1073/reconstruct.ts <adsb.lol trace_full_8965d1.json>
import { readFileSync, writeFileSync } from 'node:fs'
import { AttitudeFilter, NORMAL_LIMITS, UPSET_LIMITS, UPSET_RATES, aeroPitchRoll } from '../../../client/track/attitude.ts'
import type { Obs } from '../../../client/track/smoother.ts'
import { trueAirspeedKt } from '../../../client/track/airspeed.ts'
import { geoidN } from '../../../shared/geoid.ts'
import { fuseGround, fuseHeight, knotAt, type HeightObs, type RateObs } from '../fuse.ts'

const FT = 0.3048
const KT = 1852 / 3600
const DEG = 180 / Math.PI
const DAY0 = Date.UTC(2026, 8, 30) / 1000
const START = hms('05:16:30')
const END = hms('05:53:31')
const UPSET_FROM = hms('05:21:44') // the pressure altitude stops making sense
const HEARD_AGAIN = hms('05:31:26')
const LAST_BEFORE_GAP = hms('05:22:13.4')
const BOTTOM_FT = Number(process.env.BOTTOM_FT ?? 17_000) // the dive's low point, as reported (see scenario.json MEDIA)
const BOTTOM_T = hms('05:22:48') // ~1 min after the dive steepened, at the ~21,000 ft/min last heard
const POS_SD_M = 15 // NACp 8–9: the aircraft's own GPS position, 95 % within 30–93 m
const VEL_SD_MS = 2
const ALT_SD_FT = 25
const ALT_SD_UPSET_FT = 1000

function hms(s: string): number {
  const [h, m, sec] = s.split(':').map(Number)
  return h * 3600 + m * 60 + sec
}
const clock = (t: number): string => {
  const s = Math.round(t)
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

// ---- a local tangent plane about the middle of the stretch (~200 km across) ----------------------------------------
const LAT0 = 30.4
const LON0 = 38.2
const M_PER_DEG = 111_195
const COS0 = Math.cos((LAT0 * Math.PI) / 180)
const toEn = (lat: number, lon: number): [number, number] => [(lon - LON0) * M_PER_DEG * COS0, (lat - LAT0) * M_PER_DEG]
const toLl = (e: number, n: number): [number, number] => [LAT0 + n / M_PER_DEG, LON0 + e / (M_PER_DEG * COS0)]

// ---- the trace ------------------------------------------------------------------------------------------------------
// tar1090 trace rows: [dt, lat, lon, alt_baro | "ground", gs, track, flags, baro_rate, details | null, kind, alt_geom,
// geom_rate, ias, roll]; flags & 1: a stale position. alt_geom is the GNSS height above the WGS84 ellipsoid.
type Row = [number, number, number, number | 'ground', number | null, number | null, number, number | null, Record<string, unknown> | null, string, number | null, number | null, number | null, number | null]
const [traceFile] = process.argv.slice(2)
if (!traceFile) throw new Error('usage: reconstruct.ts <adsb.lol trace_full_8965d1.json>')
const trace = JSON.parse(readFileSync(traceFile, 'utf8')) as { icao: string; timestamp: number; trace: Row[] }
const pts = trace.trace
  .map((r) => ({ t: trace.timestamp + r[0] - DAY0, r }))
  .filter(({ t, r }) => t >= START - 120 && t <= END + 10 && (r[6] & 1) === 0 && r[3] !== 'ground')

const hObs: Obs[] = []
const vObs: HeightObs[] = []
const rObs: RateObs[] = []
const iasPts: Array<{ t: number; kt: number }> = []
// The aircraft's own wind (readsb: its TAS and heading against its ground velocity), where it flew straight: in a turn
// the heading reply lags the track and the wind swings.
const windPts: Array<{ t: number; baro: number; wx: number; wy: number }> = []
const deltas: Array<{ baro: number; d: number }> = [] // GNSS − pressure altitude by height: the day's temperatures
const heard: number[] = []
let lastPos = ''
let lastVel = ''
const heights: Array<{ t: number; baro: number; geom: number | null; lat: number; lon: number; sdFt: number }> = []
for (const { t, r } of pts) {
  const [lat, lon, alt, gs, trk] = [r[1], r[2], r[3] as number, r[4], r[5]]
  const pos = `${lat},${lon}`
  const vel = `${gs},${trk}`
  const newPos = pos !== lastPos
  const newVel = gs !== null && trk !== null && vel !== lastVel
  lastPos = pos
  lastVel = vel
  if (newPos || newVel) {
    const [e, n] = toEn(lat, lon)
    const v = newVel ? [gs! * KT * Math.sin(trk! / DEG), gs! * KT * Math.cos(trk! / DEG)] : null
    hObs.push({ t, p: newPos ? e : null, rp: POS_SD_M ** 2, v: v?.[0] ?? null, rv: VEL_SD_MS ** 2 }, { t, p: newPos ? n : null, rp: POS_SD_M ** 2, v: v?.[1] ?? null, rv: VEL_SD_MS ** 2 })
  }
  if (newPos) heard.push(t)
  const det = r[8]
  const calm = t < UPSET_FROM || t >= HEARD_AGAIN // in the upset the heading reply is stale (268.6° while turning to 300°)
  if (det !== null && calm) {
    const straight = typeof det.roll === 'number' && Math.abs(det.roll) < 5
    if (typeof det.wd === 'number' && typeof det.ws === 'number' && straight) {
      windPts.push({ t, baro: alt, wx: -Math.sin(det.wd / DEG) * det.ws * KT, wy: -Math.cos(det.wd / DEG) * det.ws * KT })
    }
    if (typeof det.alt_geom === 'number') deltas.push({ baro: alt, d: det.alt_geom - alt })
  }
  const upset = t > UPSET_FROM && t < LAST_BEFORE_GAP - 1
  heights.push({ t, baro: alt, geom: r[10], lat, lon, sdFt: upset ? ALT_SD_UPSET_FT : ALT_SD_FT })
  const ias = r[12]
  // The airspeed stops updating at 05:21:45 (the same 293 kt repeats until the gap) and is next heard at 05:31:26.
  if (ias !== null && ias > 60 && (t < UPSET_FROM || t >= HEARD_AGAIN)) iasPts.push({ t, kt: ias })
}
// Above MSL: the GNSS height (above the ellipsoid) less the geoid; a reception without one, by the GNSS − pressure
// difference the flight measured near its height (carrying the last one across the gap would put 15,000 ft 1,100 ft high).
for (const x of heights) {
  vObs.push({ t: x.t, hFt: x.geom !== null ? (x.geom * FT - geoidN(x.lat, x.lon)) / FT : mslOf(x.baro, x.lat, x.lon), sdFt: x.sdFt, sdT: 0.5 })
}
// The dive as last heard (two receptions agree): ~21,000 ft/min down.
rObs.push({ t: LAST_BEFORE_GAP, vFtS: -21_312 / 60, sdFtS: 60 })
// The gap: the reported low point (a flight level: a tracker shows pressure altitude), the pull-out from it, then down to
// 15,000 ft, level where reception resumes. How it got there is not known: the gentlest way is drawn.
/** Pressure altitude → above MSL, by the GNSS − pressure difference the flight itself measured near that height. */
function mslOf(baroFt: number, lat: number, lon: number): number {
  const near = deltas.filter((x) => Math.abs(x.baro - baroFt) < 3_000)
  const pick = near.length > 0 ? near : [...deltas].sort((a, b) => Math.abs(a.baro - baroFt) - Math.abs(b.baro - baroFt)).slice(0, 20)
  const d = pick.reduce((s, x) => s + x.d, 0) / pick.length
  return (((baroFt + d) * FT) - geoidN(lat, lon)) / FT
}
const HEARD_AGAIN_BARO = 15_025
vObs.push({ t: BOTTOM_T, hFt: mslOf(BOTTOM_FT, 29.8, 38.2), sdFt: 1_000, sdT: 5 })
rObs.push({ t: BOTTOM_T + 12, vFtS: 0, sdFtS: 25 })
for (let t = BOTTOM_T + 30; t < HEARD_AGAIN - 10; t += 20) {
  const u = (t - (BOTTOM_T + 30)) / (HEARD_AGAIN - 10 - (BOTTOM_T + 30))
  vObs.push({ t, hFt: mslOf(BOTTOM_FT + u * (HEARD_AGAIN_BARO - BOTTOM_FT), 30.2, 38.1), sdFt: 400, sdT: 0 })
  rObs.push({ t, vFtS: 0, sdFtS: 15 })
}
vObs.sort((a, b) => a.t - b.t)
// Over the ground the gap is 95 km, flown in 9 min 13 s at the ~330 kt both ends had: close to the straight line. The
// smoothest path between the ends' velocities alone swings 50° either side of it; held near it in the middle.
{
  const a = pts.findLast(({ t }) => t <= LAST_BEFORE_GAP)!
  const b = pts.find(({ t }) => t >= HEARD_AGAIN)!
  const [ea, na] = toEn(a.r[1], a.r[2])
  const [eb, nb] = toEn(b.r[1], b.r[2])
  const dt = b.t - a.t
  const [ve, vn] = [(eb - ea) / dt, (nb - na) / dt]
  for (let t = LAST_BEFORE_GAP + 150; t <= HEARD_AGAIN - 120; t += 30) {
    hObs.push({ t, p: null, rp: 0, v: ve, rv: 12 ** 2 }, { t, p: null, rp: 0, v: vn, rv: 12 ** 2 })
  }
  // (hObs alternates east, north; keep both in time order)
}

/** The aircraft's wind (m/s, the vector it blows toward): its reports within ±90 s averaged; in the gap, those near the
 * height (the wind changed with height: ~70 kt at FL340, ~30 kt at FL150). */
function ownWind(t: number, baroFt: number): [number, number] | null {
  const mean = (ws: typeof windPts): [number, number] => [ws.reduce((a, w) => a + w.wx, 0) / ws.length, ws.reduce((a, w) => a + w.wy, 0) / ws.length]
  if (t <= LAST_BEFORE_GAP || t >= HEARD_AGAIN) {
    const near = windPts.filter((w) => Math.abs(w.t - t) <= 90)
    return near.length === 0 ? null : mean(near)
  }
  // In the gap: linear in height between the layers it reported above and below (FL340 and FL150; none between).
  const below = windPts.filter((w) => w.baro <= baroFt && w.baro > baroFt - 20_000)
  const above = windPts.filter((w) => w.baro > baroFt && w.baro < baroFt + 20_000)
  if (below.length === 0 || above.length === 0) return below.length + above.length === 0 ? null : mean([...below, ...above])
  const hb = below.reduce((a, w) => a + w.baro, 0) / below.length
  const ha = above.reduce((a, w) => a + w.baro, 0) / above.length
  const [wb, wa] = [mean(below), mean(above)]
  const u = Math.min(1, Math.max(0, (baroFt - hb) / Math.max(1, ha - hb)))
  return [wb[0] + u * (wa[0] - wb[0]), wb[1] + u * (wa[1] - wb[1])]
}
/** Above MSL → pressure altitude, the inverse of mslOf near the gap (for the wind by height). */
const baroOf = (mslFt: number): number => mslFt - (mslOf(20_000, 30, 38) - 20_000)

/** Calibrated airspeed (kt) where heard, linear between receptions up to 30 s apart; null elsewhere. */
function casAt(t: number): number | null {
  const i = iasPts.findIndex((p) => p.t >= t)
  if (i < 0) return null
  if (i === 0) return iasPts[0].t - t < 2 ? iasPts[0].kt : null
  const [a, b] = [iasPts[i - 1], iasPts[i]]
  if (b.t - a.t > 30) return null
  return a.kt + ((t - a.t) / Math.max(1e-9, b.t - a.t)) * (b.kt - a.kt)
}

// ---- smooth ---------------------------------------------------------------------------------------------------------
const Q_H = 1
const Q_V = 1
const LIM_H = { v: 400, a: 35 }
const LIM_V = { v: 130, a: 35 } // ~25,600 ft/min; 4.5 g
const kv = fuseHeight(vObs, rObs, { q: Q_V, lim: LIM_V, casAt, energyFrom: START, energyTo: END })
const airAt = (t: number): { air: number; hM: number } | null => {
  const cas = casAt(t)
  if (cas === null) return null
  const h = knotAt(kv, t)
  const tas = trueAirspeedKt(cas, h.p / FT) * KT
  return { air: Math.sqrt(Math.max(0, tas * tas - h.v * h.v)), hM: h.p }
}
const eObs = hObs.filter((_, i) => i % 2 === 0)
const nObs = hObs.filter((_, i) => i % 2 === 1)
const { e: ke, n: kn, wind, turns } = fuseGround(eObs, nObs, airAt, Q_H, LIM_H)
function windAt(t: number): [number, number] | null {
  if (wind.length === 0) return null
  const i = wind.findIndex((w) => w.t >= t)
  if (i === 0) return [wind[0].wx, wind[0].wy]
  if (i < 0) return [wind[wind.length - 1].wx, wind[wind.length - 1].wy]
  const [a, b] = [wind[i - 1], wind[i]]
  // Across the gap the wind changes with the height (70 kt at FL340, ~30 kt at FL150): linear in time is a guess.
  const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0
  return [a.wx + u * (b.wx - a.wx), a.wy + u * (b.wy - a.wy)]
}

// ---- attitude and rows ----------------------------------------------------------------------------------------------
const nearHeard = (t: number): boolean => {
  let lo = 0
  let hi = heard.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (heard[mid] <= t) lo = mid
    else hi = mid
  }
  return Math.min(Math.abs(heard[lo] - t), Math.abs(heard[hi] - t)) <= 5
}
const filt = new AttitudeFilter(4, UPSET_RATES)
const rows: string[] = ['time,lat,lon,alt_ft,hdg,pitch,roll,ias_kt,wind_dir,wind_kt,q,src']
let lastTrk = 270
const SUB = 0.5
const OUT_STEP_S = 1
for (let t = START; t <= END + 1e-9; t += SUB) {
  const e = knotAt(ke, t)
  const n = knotAt(kn, t)
  const h = knotAt(kv, t)
  const gs = Math.hypot(e.v, n.v)
  const trk = gs > 3 ? Math.atan2(e.v, n.v) * DEG : lastTrk
  lastTrk = trk
  const turn = gs > 3 ? ((n.v * e.a - e.v * n.a) / (gs * gs)) * DEG : 0
  const along = gs > 3 ? (e.v * e.a + n.v * n.a) / gs : 0
  const cas = casAt(t)
  const upset = t > UPSET_FROM - 40 && t < BOTTOM_T + 90
  const pr = aeroPitchRoll({
    gsMs: gs, vsMs: h.v, turnRateDegS: turn, alongMs2: along, easKt: cas, altM: h.p, onGround: false, category: 'A3',
  }, upset ? UPSET_LIMITS : NORMAL_LIMITS)
  // The nose points where the aircraft goes through the air: its ground velocity less the wind it reported (the fit where
  // it reported none).
  const w = ownWind(t, baroOf(h.p / FT)) ?? windAt(t)
  const [ax, ay] = w === null ? [e.v, n.v] : [e.v - w[0], n.v - w[1]]
  const hdgAir = Math.hypot(ax, ay) > 3 ? Math.atan2(ax, ay) * DEG : trk
  const att = filt.step({ headingDeg: hdgAir, pitchDeg: pr.pitchDeg, rollDeg: pr.rollDeg }, SUB)
  if (Math.abs(t / OUT_STEP_S - Math.round(t / OUT_STEP_S)) > 1e-6) continue
  const [lat, lon] = toLl(e.p, n.p)
  const measured = nearHeard(t) && !(t > UPSET_FROM && t < HEARD_AGAIN)
  const hdg = (Math.round((((att.headingDeg % 360) + 360) % 360) * 10) / 10) % 360
  rows.push([
    clock(t), lat.toFixed(6), lon.toFixed(6), (h.p / FT).toFixed(0), hdg.toFixed(1), att.pitchDeg.toFixed(1), att.rollDeg.toFixed(1),
    cas !== null ? cas.toFixed(0) : '',
    w === null ? '' : ((Math.atan2(-w[0], -w[1]) * DEG + 360) % 360).toFixed(0), w === null ? '' : (Math.hypot(w[0], w[1]) / KT).toFixed(0),
    measured ? 'A' : 'R', t > LAST_BEFORE_GAP && t < HEARD_AGAIN ? 'MEDIA' : 'ADSBLOL',
  ].join(','))
}
writeFileSync(new URL('../../../public/scenarios/fz1073/track.csv', import.meta.url), `${rows.join('\n')}\n`)
console.log(`${rows.length - 1} rows, ${clock(START)}–${clock(END)}; receptions ${heard.length}, altitudes ${vObs.length}, airspeeds ${iasPts.length}`)
console.log(`turns flown again: ${turns.map((s) => `${clock(s.t0)}–${clock(s.t1)} ${s.circles} circle(s), bank ≤ ${s.maxBankDeg.toFixed(0)}°`).join('; ') || 'none'}`)

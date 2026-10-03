// tools/scenarios/fz1073/reconstruct.ts
// Builds public/scenarios/fz1073/track.csv for flydubai 1073 (30 Sep 2026, Boeing 737 MAX 8 A6-FKF, Dubai → Tel Aviv,
// diverted to Tabuk), take-off to landing, from the aircraft's own ADS-B broadcasts:
//   - as adsb.lol's receivers heard them (its tar1090 trace of the day: GPS positions at ~1 Hz, pressure and GNSS
//     altitude, airspeed, ground velocity; ODbL) wherever they did: the climb-out 03:05–03:54 and 05:16–05:53;
//   - as a commercial tracking network's playback of the flight has it only where no open network heard it: the cruise 03:54–05:16,
//     05:22–05:31 through the dive and the zoom (its receivers followed it every 2–3 s: a hard right turn through
//     north-east at ~595 kt over the ground at the bottom, up to 21,725 ft, down again, 13,675 ft at 05:27), 05:53–06:13,
//     then its satellites' fixes at 06:28:37 and 06:43:39.
// Smoothed by the scenario builders' physics (tools/scenarios/fuse.ts: each source with its own error; height tied to
// airspeed by energy; the wind fitted). Stretches no one heard, built:
//   - the take-off roll on Dubai's runway 30R (airport.json): lined up 120 m past the threshold, rolling from 03:04:32 at
//     a steady 2.0 m/s², which puts it where the playback's 03:04:54 fix has it (~600 m in, 86 kt), airborne at 177 kt
//     over the ground (~165 kt through the air: adsb.lol's wind is a 7-kt tailwind) and ~100 ft up where adsb.lol first
//     hears it (03:05:27);
//   - 05:21:44–05:22:45, the dive and its pull-out: the positions are smooth, but the pressure altitude jumps by up to
//     1,000 ft within a second (static-pressure errors in violent manoeuvres; the ground speed falls 441 → 377 kt in
//     5 s): those altitudes count for little (ALT_SD_UPSET_FT);
//   - 06:13:37–06:28:37, between the playback's last ground-received fix (15,050 ft, 331 kt) and its first satellite
//     fix (5,475 ft, 205 kt): the smoothest path, the gentlest descent;
//   - 06:28:37–06:43:39: the two satellite fixes are 14 nm apart and 15 minutes apart, so the aircraft flew ~3 times
//     that; how is not known. Drawn as an extended right-hand circuit for runway 31 at the first fix's height, onto the
//     3° glidepath the second fix is on (3.2 nm out on the centreline, 40 ft under it);
//   - the landing: on down the glidepath, slowing 185 → 163 kt, touchdown 450 m past the threshold, the roll braking at
//     2.2 m/s² to taxi speed. (The last satellite fix, 06:58:59, has it stopped at the airfield's north-west end.)
// The attitude is the app's flight-mechanics model (client/track/attitude.ts) on that path, with an upset's limits
// around the dive: the recorded attitude is not published, and the aircraft certainly pitched more sharply than the path.
//
// Heights where no open network heard it: the granular data published for the flight (pressure altitude about
// once a second, time-stamped to the millisecond on the playback's clock: the playback's rows are a subsample of it).
//
//   node tools/scenarios/fz1073/reconstruct.ts <adsb.lol trace_full_8965d1.json> <playback CSV> <granular CSV>
import { readFileSync, writeFileSync } from 'node:fs'
import { AttitudeFilter, NORMAL_LIMITS, UPSET_LIMITS, UPSET_RATES, aeroPitchRoll } from '../../../client/track/attitude.ts'
import type { Knot3, Obs } from '../../../client/track/smoother.ts'
import { trueAirspeedKt } from '../../../client/track/airspeed.ts'
import { bearingDeg, destination } from '../../../shared/geo.ts'
import { geoidN } from '../../../shared/geoid.ts'
import { fuseGround, fuseHeight, knotAt, spline, timedPolyline, type HeightObs, type RateObs } from '../fuse.ts'

const FT = 0.3048
const KT = 1852 / 3600
const DEG = 180 / Math.PI
const DAY0 = Date.UTC(2026, 8, 30) / 1000
const M_PER_DEG = 111_195
const UPSET_FROM = hms('05:21:44') // the pressure altitude stops making sense
const HEARD_AGAIN = hms('05:31:26')
const LAST_BEFORE_GAP = hms('05:22:13.4')
const UPSET_TO = hms('05:23:00') // the pull-out
const LOST = hms('05:53:32.9') // the open networks' last reception
const SAT1 = hms('06:28:37') // the playback's satellite fixes
const SAT2 = hms('06:43:39')
const SAUDI = hms('05:00:00') // before: the Gulf's air (hot, QNH 1009); after: northern Saudi Arabia's
const POS_SD_M = 15 // NACp 8–9: the aircraft's own GPS position, 95 % within 30–93 m
const VEL_SD_MS = 2
const ALT_SD_FT = 25
const ALT_SD_UPSET_FT = 1000
// The same GPS positions, but time-stamped as the playback's network received them: against adsb.lol's clock its fixes scatter
// −5…+6 s (p10–p90; median offset < 1 s). A fix counts for its timing error times the speed, ~1 km at 600 kt.
const NET_POS_SD_M = 100
const NET_SD_T = 3
const NET_VEL_SD_MS = 3
const NET_VEL_SD_UPSET_MS = 15 // a stale speed and direction in the pull-out's turn

function hms(s: string): number {
  const [h, m, sec] = s.split(':').map(Number)
  return h * 3600 + m * 60 + sec
}
const clock = (t: number): string => {
  const s = Math.round(t)
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
const dir = (deg: number): [number, number] => [Math.sin(deg / DEG), Math.cos(deg / DEG)]
const dot = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1]

// ---- the runways (public/scenarios/fz1073/airport.json) -------------------------------------------------------------
const THR30R = [25.2477035, 55.3809094] as const
const THR12L = [25.2646315, 55.3504159] as const
const HDG30R = bearingDeg(THR30R[0], THR30R[1], THR12L[0], THR12L[1])
const LEN30R_M = 3599 // threshold to threshold
const elev30R = (s: number): number => 32 + ((11 - 32) * Math.min(s, LEN30R_M)) / LEN30R_M
const THR31 = [28.3618733, 36.6175436] as const
const THR13 = [28.3803511, 36.5945249] as const
const HDG31 = bearingDeg(THR31[0], THR31[1], THR13[0], THR13[1])
const LEN31_M = 3048
const elev31 = (s: number): number => 2539 + ((2530 - 2539) * Math.min(s, LEN31_M)) / LEN31_M
// Tabuk's QNH 1018 hPa and ISA+14 °C (OETB METARs, 06Z–07Z): a pressure altitude near the field → above MSL.
const tabukMsl = (baroFt: number): number => 2539 + (baroFt + 27.3 * (1018 - 1013.25) - 2539) * (1 + 14 / 288)

// ---- the take-off and the landing ----------------------------------------------------------------------------------
const START = hms('03:04:20') // lined up
const LINEUP_M = 120
const ROLL_T0 = hms('03:04:32')
const ROLL_ACC = 2.0
const LIFT_MS = 91
const LIFT_T = ROLL_T0 + LIFT_MS / ROLL_ACC
const TD_M = 450 // touchdown, past the threshold
const P2_MS = 185 * KT // the 06:43:39 fix's ground speed
const TD_MS = 163 * KT
const BRAKE = 2.2
const TAXI_MS = 12
const FINAL_M = 5867 + TD_M // the 06:43:39 fix → the touchdown (the fix is 5,867 m out on the centreline)
const TD = SAT2 + (2 * FINAL_M) / (P2_MS + TD_MS)
const END = TD + 45

// ---- the sources ----------------------------------------------------------------------------------------------------
// tar1090 trace rows: [dt, lat, lon, alt_baro | "ground", gs, track, flags, baro_rate, details | null, kind, alt_geom,
// geom_rate, ias, roll]; flags & 1: a stale position. alt_geom is the GNSS height above the WGS84 ellipsoid.
type Row = [number, number, number, number | 'ground', number | null, number | null, number, number | null, Record<string, unknown> | null, string, number | null, number | null, number | null, number | null]
const [traceFile, playbackFile, granularFile] = process.argv.slice(2)
if (!traceFile || !playbackFile || !granularFile) throw new Error('usage: reconstruct.ts <adsb.lol trace_full_8965d1.json> <playback CSV> <granular CSV>')
const trace = JSON.parse(readFileSync(traceFile, 'utf8')) as { icao: string; timestamp: number; trace: Row[] }
const pts = trace.trace
  .map((r) => ({ t: trace.timestamp + r[0] - DAY0, r }))
  .filter(({ t, r }) => t >= START - 120 && t <= LOST + 10 && (r[6] & 1) === 0 && r[3] !== 'ground')
// The playback's rows: time_utc, lat, lon, alt_ft_baro, gs_kt, vs_fpm, heading_deg (its track), squawk.
const playback = readFileSync(playbackFile, 'utf8').trim().split('\n').slice(1).map((l) => {
  const [time, lat, lon, baro, gs, , trk] = l.split(',')
  return { t: hms(time), lat: Number(lat), lon: Number(lon), baro: Number(baro), gs: Number(gs), trk: Number(trk) }
})
// The granular rows: "2026-09-30 05:22:36Z.049", alt_ft_baro, gs_kt, vs_fpm.
const granular = readFileSync(granularFile, 'utf8').trim().split('\n').slice(1).map((l) => {
  const [stamp, baro] = l.split(',')
  return { t: hms(stamp.slice(11, 19)) + Number(stamp.split('Z')[1] || 0), baro: baro === '' ? null : Number(baro) }
}).filter((g): g is { t: number; baro: number } => g.baro !== null)
const adsbTimes = pts.map((p) => p.t)
/** Where no open network heard the aircraft for over a minute: the playback fills in. */
const unheard = (t: number): boolean => {
  const i = adsbTimes.findIndex((x) => x > t)
  const [a, b] = [i <= 0 ? -Infinity : adsbTimes[i - 1], i < 0 ? Infinity : adsbTimes[i]]
  return b - a > 60 && t - a > 3 && b - t > 3
}

/** A horizontal observation, in degrees and true east/north m/s. */
interface HO { t: number; lat: number | null; lon: number | null; sd: number; ve: number | null; vn: number | null; sdV: number }
const hos: HO[] = []
const vObs: HeightObs[] = []
const rObs: RateObs[] = []
const iasPts: Array<{ t: number; kt: number }> = []
// The aircraft's own wind (readsb: its TAS and heading against its ground velocity), where it flew straight: in a turn
// the heading reply lags the track and the wind swings.
const windPts: Array<{ t: number; baro: number; wx: number; wy: number }> = []
const deltas: Array<{ t: number; baro: number; d: number }> = [] // GNSS − pressure altitude by height: the day's temperatures
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
    const [ve, vn] = newVel ? dir(trk!).map((c) => c * gs! * KT) : [null, null]
    hos.push({ t, lat: newPos ? lat : null, lon: newPos ? lon : null, sd: POS_SD_M, ve, vn, sdV: VEL_SD_MS })
  }
  if (newPos) heard.push(t)
  const det = r[8]
  const calm = t < UPSET_FROM || t >= HEARD_AGAIN // in the upset the heading reply is stale (268.6° while turning to 300°)
  if (det !== null && calm) {
    const straight = typeof det.roll === 'number' && Math.abs(det.roll) < 5
    if (typeof det.wd === 'number' && typeof det.ws === 'number' && straight) {
      windPts.push({ t, baro: alt, wx: -Math.sin(det.wd / DEG) * det.ws * KT, wy: -Math.cos(det.wd / DEG) * det.ws * KT })
    }
    if (typeof det.alt_geom === 'number') deltas.push({ t, baro: alt, d: det.alt_geom - alt })
  }
  const upset = t > UPSET_FROM && t < LAST_BEFORE_GAP - 1 // (the last two receptions agree: 27,950 ft)
  heights.push({ t, baro: alt, geom: r[10], lat, lon, sdFt: upset ? ALT_SD_UPSET_FT : ALT_SD_FT })
  const ias = r[12]
  // The airspeed stops updating at 05:21:45 (the same 293 kt repeats until the gap) and is next heard at 05:31:26.
  if (ias !== null && ias > 60 && (t < UPSET_FROM || t >= HEARD_AGAIN)) iasPts.push({ t, kt: ias })
}
// Above MSL: the GNSS height (above the ellipsoid) less the geoid; a reception without one, by the GNSS − pressure
// difference the flight measured near its height (carrying the last one across the gap would put 15,000 ft 1,100 ft high).
for (const x of heights) {
  vObs.push({ t: x.t, hFt: x.geom !== null ? (x.geom * FT - geoidN(x.lat, x.lon)) / FT : mslOf(x.baro, x.lat, x.lon, x.t), sdFt: x.sdFt, sdT: 0.5 })
}
/** Pressure altitude → above MSL, by the GNSS − pressure difference the flight itself measured near that height, in the
 * same air (the Gulf's or Saudi Arabia's). */
function mslOf(baroFt: number, lat: number, lon: number, t: number): number {
  const air = deltas.filter((x) => x.t >= SAUDI === t >= SAUDI)
  const near = air.filter((x) => Math.abs(x.baro - baroFt) < 3_000)
  const pick = near.length > 0 ? near : [...air].sort((a, b) => Math.abs(a.baro - baroFt) - Math.abs(b.baro - baroFt)).slice(0, 20)
  const d = pick.reduce((s, x) => s + x.d, 0) / pick.length
  return (((baroFt + d) * FT) - geoidN(lat, lon)) / FT
}
// (mslOf's GNSS − pressure difference is ~+900 ft at FL150 and ~+2,000 ft at FL300: the day was warm.)
// The playback where no open network heard the aircraft: the cruise, and 05:53–06:13 from its ground receivers; then its
// two satellite fixes, near the field.
for (const f of playback) {
  const sat = f.t === SAT1 || f.t === SAT2
  if (!sat && !(unheard(f.t) && f.t > hms('03:10:00') && f.t <= hms('06:13:37'))) continue
  const [ve, vn] = dir(f.trk).map((c) => c * f.gs * KT)
  const upset = f.t > UPSET_FROM && f.t < UPSET_TO
  hos.push({ t: f.t, lat: f.lat, lon: f.lon, sd: Math.hypot(NET_POS_SD_M, NET_SD_T * f.gs * KT), ve, vn, sdV: upset ? NET_VEL_SD_UPSET_MS : NET_VEL_SD_MS })
  heard.push(f.t)
  // In the upset, only the playback's heights (one every 2–3 s): the granular data's second-by-second pressure altitudes
  // there (static-pressure errors: 27,950 → 19,350 ft in 10.6 s, ~49,000 ft/min) make the smoother jump.
  if (sat) vObs.push({ t: f.t, hFt: tabukMsl(f.baro), sdFt: 50, sdT: NET_SD_T })
  else if (upset) vObs.push({ t: f.t, hFt: mslOf(f.baro, f.lat, f.lon, f.t), sdFt: ALT_SD_UPSET_FT, sdT: NET_SD_T })
}
for (const g of granular) {
  if (!(unheard(g.t) && g.t > hms('03:10:00') && g.t <= hms('06:13:37') + 1) || (g.t > UPSET_FROM && g.t < UPSET_TO)) continue
  const f = playback.reduce((a, b) => (Math.abs(b.t - g.t) < Math.abs(a.t - g.t) ? b : a)) // where, for the geoid and the air
  vObs.push({ t: g.t, hFt: mslOf(g.baro, f.lat, f.lon, g.t), sdFt: 50, sdT: NET_SD_T })
}
heard.sort((a, b) => a - b)
// The dive between adsb.lol's last reception (27,950 ft at 05:22:13) and the playback's 16,850 ft at 05:22:36: ~29,000 ft/min
// down on average. The playback's fixes in it are time-stamped a few seconds either way; the rate keeps the path on them.
rObs.push({ t: LAST_BEFORE_GAP, vFtS: -28_000 / 60, sdFtS: 60 }, { t: hms('05:22:25'), vFtS: -30_000 / 60, sdFtS: 80 })
// Level where the playback's ground receivers lose it and where the satellite first hears it: between, the gentlest
// descent.
for (const t of [hms('06:13:37'), SAT1]) rObs.push({ t, vFtS: 0, sdFtS: 3 })

// The take-off roll on 30R.
const ground: Array<[number, number]> = [[START, LIFT_T]]
{
  const [ue, un] = dir(HDG30R)
  const times = Array.from({ length: Math.ceil(LIFT_T - START) }, (_, i) => START + i)
  for (const t of [...times, LIFT_T]) {
    const tr = Math.max(0, t - ROLL_T0)
    const s = LINEUP_M + 0.5 * ROLL_ACC * tr * tr
    const p = destination(THR30R[0], THR30R[1], HDG30R, s / 1852)
    hos.push({ t, lat: p.lat, lon: p.lon, sd: 3, ve: ue * ROLL_ACC * tr, vn: un * ROLL_ACC * tr, sdV: 0.5 })
    vObs.push({ t, hFt: elev30R(s), sdFt: 3, sdT: 0 })
  }
}

// Tabuk, in metres east and north of the 31 threshold.
const c31 = Math.cos(THR31[0] / DEG)
const en31 = (lat: number, lon: number): [number, number] => [(lon - THR31[1]) * M_PER_DEG * c31, (lat - THR31[0]) * M_PER_DEG]
const ll31 = (e: number, n: number): [number, number] => [THR31[0] + n / M_PER_DEG, THR31[1] + e / (M_PER_DEG * c31)]
const out31 = dir(HDG31 - 180) // out along the approach
const ne31 = dir(HDG31 - 270) // the circuit's side (north-east)
const glideFt = (alongM: number): number => elev31(0) + 50 + (alongM / FT) * Math.tan(3 / DEG)
const s1 = playback.find((f) => f.t === SAT1)!
const s2 = playback.find((f) => f.t === SAT2)!
const P1 = en31(s1.lat, s1.lon)
const P2 = en31(s2.lat, s2.lon)
const LEVEL_FT = tabukMsl(s1.baro)
let glideAt = 0 // when the circuit meets the glidepath
{
  // In from the first fix on its track (198°) to 4 km off the centreline, a downwind leg out along the approach, a
  // 180° turn onto the final (2-km radius: ~25° of bank at 200 kt), in to the second fix. The downwind's length makes
  // the circuit ~15 min long at the ~195 kt between the fixes' 205 and 185 kt.
  const OFF = 4000
  const R = OFF / 2
  const d1 = dir(s1.trk)
  const x = (OFF - dot(P1, ne31)) / dot(d1, ne31)
  const B1: [number, number] = [P1[0] + d1[0] * x, P1[1] + d1[1] * x]
  const want = (SAT2 - SAT1) * 195 * KT
  const legD = Math.max(0, (want - x - Math.PI * R - dot(B1, out31) + dot(P2, out31)) / 2)
  const at = (along: number, off: number): [number, number] => [out31[0] * along + ne31[0] * off, out31[1] * along + ne31[1] * off]
  const alongB2 = dot(B1, out31) + legD
  const turn = Array.from({ length: 9 }, (_, i) => {
    const th = (i / 8) * Math.PI
    return at(alongB2 + R * Math.sin(th), R + R * Math.cos(th))
  })
  const wp: Array<[number, number]> = [P1, B1, ...turn, at(alongB2 - 3000, 0), at(dot(P2, out31) + 1500, 0), P2]
  const path = timedPolyline(spline(wp), SAT1, SAT2)
  for (const p of path) {
    if (p.t <= SAT1 || p.t >= SAT2) continue
    const along = dot([p.e, p.n], out31)
    const onFinal = Math.abs(dot([p.e, p.n], ne31)) < 150 && along < alongB2
    const [lat, lon] = ll31(p.e, p.n)
    hos.push({ t: p.t, lat, lon, sd: 40, ve: null, vn: null, sdV: 0 })
    const h = onFinal ? Math.min(LEVEL_FT, glideFt(along)) : LEVEL_FT
    if (glideAt === 0 && onFinal && glideFt(along) < LEVEL_FT) glideAt = p.t
    vObs.push({ t: p.t, hFt: h, sdFt: 60, sdT: 0 })
  }
  console.log(`circuit: in ${(x / 1000).toFixed(1)} km on ${s1.trk}°, downwind ${(legD / 1000).toFixed(1)} km, final from ${(alongB2 / 1852).toFixed(1)} nm`)
}
// The final from the second fix, slowing evenly, down the glidepath; the flare from 50 ft over the threshold; the roll.
{
  const P2A = dot(P2, out31)
  const acc = (TD_MS ** 2 - P2_MS ** 2) / (2 * FINAL_M)
  const thrT = SAT2 + (-P2_MS + Math.sqrt(P2_MS ** 2 + 2 * acc * P2A)) / acc // over the threshold
  for (let t = SAT2 + 1; t <= END + 1e-9; t += 1) {
    const tt = Math.min(t, TD) - SAT2
    let s = P2_MS * tt + 0.5 * acc * tt * tt // along the final, from the fix
    let v = P2_MS + acc * tt
    if (t > TD) {
      const tr = t - TD
      const tBrake = (TD_MS - TAXI_MS) / BRAKE
      const b = Math.min(tr, tBrake)
      s = FINAL_M + TD_MS * b - 0.5 * BRAKE * b * b + TAXI_MS * Math.max(0, tr - tBrake)
      v = tr < tBrake ? TD_MS - BRAKE * tr : TAXI_MS
    }
    const along = P2A - s // out from the threshold (negative on the runway)
    const [lat, lon] = ll31(out31[0] * along, out31[1] * along)
    hos.push({ t, lat, lon, sd: t > TD ? 3 : 20, ve: -out31[0] * v, vn: -out31[1] * v, sdV: t > TD ? 0.5 : 3 })
    if (t >= TD) vObs.push({ t, hFt: elev31(-along), sdFt: 3, sdT: 0 })
    else if (t < thrT) vObs.push({ t, hFt: glideFt(along), sdFt: 30, sdT: 0 })
    else {
      const u = (t - thrT) / (TD - thrT)
      vObs.push({ t, hFt: elev31(-along) + 50 * (1 - u) ** 2, sdFt: 5, sdT: 0 })
      rObs.push({ t, vFtS: (-2 * 50 * (1 - u)) / (TD - thrT), sdFtS: 1 })
    }
  }
  vObs.push({ t: TD, hFt: elev31(TD_M), sdFt: 3, sdT: 0 })
  ground.push([TD, END])
}
vObs.sort((a, b) => a.t - b.t)

/** The aircraft's wind (m/s, the vector it blows toward): its reports within ±90 s averaged; in the gap, those near the
 * height (the wind changed with height: ~70 kt at FL340, ~30 kt at FL150). */
function ownWind(t: number, baroFt: number): [number, number] | null {
  const mean = (ws: typeof windPts): [number, number] => [ws.reduce((a, w) => a + w.wx, 0) / ws.length, ws.reduce((a, w) => a + w.wy, 0) / ws.length]
  if (t <= LAST_BEFORE_GAP || t >= HEARD_AGAIN) {
    const near = windPts.filter((w) => Math.abs(w.t - t) <= 90)
    return near.length === 0 ? null : mean(near)
  }
  // In the gap: linear in height between the layers it reported above and below (FL340 and FL150; none between).
  const here = windPts.filter((w) => w.t >= SAUDI)
  const below = here.filter((w) => w.baro <= baroFt && w.baro > baroFt - 20_000)
  const above = here.filter((w) => w.baro > baroFt && w.baro < baroFt + 20_000)
  if (below.length === 0 || above.length === 0) return below.length + above.length === 0 ? null : mean([...below, ...above])
  const hb = below.reduce((a, w) => a + w.baro, 0) / below.length
  const ha = above.reduce((a, w) => a + w.baro, 0) / above.length
  const [wb, wa] = [mean(below), mean(above)]
  const u = Math.min(1, Math.max(0, (baroFt - hb) / Math.max(1, ha - hb)))
  return [wb[0] + u * (wa[0] - wb[0]), wb[1] + u * (wa[1] - wb[1])]
}
/** Above MSL → pressure altitude, the inverse of mslOf near the gap (for the wind by height). */
const baroOf = (mslFt: number): number => mslFt - (mslOf(20_000, 30, 38, LAST_BEFORE_GAP) - 20_000)

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
const LIM_V = { v: 220, a: 40 } // ~43,000 ft/min: a 42° dive at 600 kt (the playback's fixes need ~36,000 over 20 s); ~5 g
const kv = fuseHeight(vObs, rObs, { q: Q_V, lim: LIM_V, casAt, energyFrom: LIFT_T + 10, energyTo: LOST })
const onGround = (t: number): boolean => ground.some(([a, b]) => t >= a && t <= b)
const airAt = (t: number): { air: number; hM: number } | null => {
  const cas = casAt(t)
  if (cas === null || onGround(t)) return null
  const h = knotAt(kv, t)
  const tas = trueAirspeedKt(cas, h.p / FT) * KT
  return { air: Math.sqrt(Math.max(0, tas * tas - h.v * h.v)), hM: h.p }
}
// Over the ground, in pieces a few hundred kilometres across, each on its own plane (east scaled by the cosine of its
// middle latitude: within ~1.3 % over each piece's latitudes; velocities in and out rescaled exactly), joined where both
// hold the same receptions.
interface Piece { to: number; lat0: number; lon0: number; ke: Knot3[]; kn: Knot3[]; wind: Array<{ t: number; wx: number; wy: number }> }
const pieces: Piece[] = [
  { to: hms('03:54:21'), lat0: 26.1, lon0: 52.4 },
  { to: hms('05:16:30'), lat0: 28.4, lon0: 44.2 },
  { to: LOST, lat0: 30.4, lon0: 38.2 },
  { to: END + 1, lat0: 29.5, lon0: 37.4 },
].map((p, i, all) => {
  const from = i === 0 ? -Infinity : all[i - 1].to
  const c0 = Math.cos(p.lat0 / DEG)
  const sel = hos.filter((o) => o.t >= from - 120 && o.t <= p.to + 120).sort((a, b) => a.t - b.t)
    .filter((o, j, xs) => j === 0 || o.t > xs[j - 1].t)
  const k = (lat: number | null): number => c0 / Math.cos((lat ?? p.lat0) / DEG) // grid east per true east
  const e: Obs[] = sel.map((o) => ({ t: o.t, p: o.lon === null ? null : (o.lon - p.lon0) * M_PER_DEG * c0, rp: o.sd ** 2, v: o.ve === null ? null : o.ve * k(o.lat), rv: o.sdV ** 2 }))
  const n: Obs[] = sel.map((o) => ({ t: o.t, p: o.lat === null ? null : (o.lat - p.lat0) * M_PER_DEG, rp: o.sd ** 2, v: o.vn, rv: o.sdV ** 2 }))
  const g = fuseGround(e, n, airAt, Q_H, LIM_H)
  if (g.turns.length > 0) console.log(`turns flown again: ${g.turns.map((s) => `${clock(s.t0)}–${clock(s.t1)} ${s.circles} circle(s), bank ≤ ${s.maxBankDeg.toFixed(0)}°`).join('; ')}`)
  return { ...p, ke: g.e, kn: g.n, wind: g.wind }
})
/** The path at t: degrees, and true east/north velocity (m/s) and acceleration (m/s²). */
function pathAt(t: number): { lat: number; lon: number; ve: number; vn: number; ae: number; an: number; piece: Piece } {
  const p = pieces.find((x) => t < x.to) ?? pieces[pieces.length - 1]
  const e = knotAt(p.ke, t)
  const n = knotAt(p.kn, t)
  const lat = p.lat0 + n.p / M_PER_DEG
  const c0 = Math.cos(p.lat0 / DEG)
  const k = Math.cos(lat / DEG) / c0
  return { lat, lon: p.lon0 + e.p / (M_PER_DEG * c0), ve: e.v * k, vn: n.v, ae: e.a * k, an: n.a, piece: p }
}
function windAt(t: number, p: Piece): [number, number] | null {
  const w = p.wind
  if (w.length === 0) return null
  const i = w.findIndex((x) => x.t >= t)
  if (i === 0) return [w[0].wx, w[0].wy]
  if (i < 0) return [w[w.length - 1].wx, w[w.length - 1].wy]
  const [a, b] = [w[i - 1], w[i]]
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
// A row a second around the take-off, the dive and the landing; every 4 s in the cruise and the descent to Tabuk (the
// player interpolates; the path is straight or gently turning there).
const dense = (t: number): boolean => t < hms('03:10:00') || (t >= hms('05:16:30') && t <= LOST) || t >= SAT2 - 180
const filt = new AttitudeFilter(4, UPSET_RATES)
const rows: string[] = ['time,lat,lon,alt_ft,hdg,pitch,roll,gnd,ias_kt,wind_dir,wind_kt,q,src']
let lastTrk = HDG30R
const SUB = 0.5
for (let t = START; t <= END + 1e-9; t += SUB) {
  const s = pathAt(t)
  const h = knotAt(kv, t)
  const gnd = onGround(t)
  const gs = Math.hypot(s.ve, s.vn)
  const trk = gs > 3 ? Math.atan2(s.ve, s.vn) * DEG : lastTrk
  lastTrk = trk
  const turn = gs > 3 ? ((s.vn * s.ae - s.ve * s.an) / (gs * gs)) * DEG : 0
  const along = gs > 3 ? (s.ve * s.ae + s.vn * s.an) / gs : 0
  const cas = casAt(t)
  const upset = t > UPSET_FROM - 40 && t < hms('05:27:30')
  const pr = aeroPitchRoll({
    gsMs: gs, vsMs: gnd ? 0 : h.v, turnRateDegS: turn, alongMs2: along, easKt: cas, altM: h.p, onGround: gnd, category: 'A3',
  }, upset ? UPSET_LIMITS : NORMAL_LIMITS)
  // Rotation: the nose comes up over the last 3 s of the roll; at the touchdown the flare's nose-up lowers over 4 s.
  const rot = t > LIFT_T - 3 && t <= LIFT_T ? ((t - (LIFT_T - 3)) / 3) * 8 : t >= TD && t < TD + 4 ? 4 * (1 - (t - TD) / 4) : 0
  // The nose points where the aircraft goes through the air: its ground velocity less the wind it reported (the fit where
  // it reported none).
  const w = ownWind(t, baroOf(h.p / FT)) ?? windAt(t, s.piece)
  const [ax, ay] = w === null ? [s.ve, s.vn] : [s.ve - w[0], s.vn - w[1]]
  const hdgAir = Math.hypot(ax, ay) > 3 ? Math.atan2(ax, ay) * DEG : trk
  const att = filt.step({ headingDeg: gnd ? (t < TD ? HDG30R : HDG31) : hdgAir, pitchDeg: gnd ? rot : pr.pitchDeg, rollDeg: gnd ? 0 : pr.rollDeg }, SUB)
  if (Math.abs(t - Math.round(t)) > 1e-6 || (!dense(t) && Math.round(t) % 4 !== 0 && t < END)) continue
  const measured = nearHeard(t)
  const hdg = (Math.round((((att.headingDeg % 360) + 360) % 360) * 10) / 10) % 360
  const hFt = gnd ? (t < TD ? elev30R(LINEUP_M + 0.5 * ROLL_ACC * Math.max(0, t - ROLL_T0) ** 2) : h.p / FT) : h.p / FT
  const src = t > LOST || (t > LAST_BEFORE_GAP && t < HEARD_AGAIN) || (t > hms('03:54:22') && t < hms('05:16:12')) ? '' : 'ADSBLOL'
  rows.push([
    clock(t), s.lat.toFixed(6), s.lon.toFixed(6), hFt.toFixed(0), hdg.toFixed(1), att.pitchDeg.toFixed(1), att.rollDeg.toFixed(1),
    gnd ? '1' : '', cas !== null ? cas.toFixed(0) : '',
    w === null ? '' : ((Math.atan2(-w[0], -w[1]) * DEG + 360) % 360).toFixed(0), w === null ? '' : (Math.hypot(w[0], w[1]) / KT).toFixed(0),
    measured ? 'A' : 'R', src,
  ].join(','))
}
writeFileSync(new URL('../../../public/scenarios/fz1073/track.csv', import.meta.url), `${rows.join('\n')}\n`)
console.log(`${rows.length - 1} rows, ${clock(START)}–${clock(END)}; receptions ${heard.length}, altitudes ${vObs.length}, airspeeds ${iasPts.length}`)
console.log(`lift-off ${clock(LIFT_T)}, glidepath ${clock(glideAt)}, touchdown ${clock(TD)}, end ${clock(END)}`)

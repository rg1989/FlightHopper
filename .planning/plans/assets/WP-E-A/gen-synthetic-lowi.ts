// .planning/plans/assets/WP-E-A/gen-synthetic-lowi.ts
// Synthetic Innsbruck replay for gate GE (terrain & sun): 600 adsb.lol-style polls (RecordLine JSONL, 1 Hz, 40 nm around
// LOWI) holding four invented aircraft. Run from the repository root:
//   node .planning/plans/assets/WP-E-A/gen-synthetic-lowi.ts [out]      (default data/recordings/synthetic-lowi.jsonl)
//   ADSB_SOURCE=replay REPLAY_FILES=data/recordings/synthetic-lowi.jsonl RECORD_DIR= npm run server
// data/recordings/ is gitignored: the output is never committed; this script is its source.
// Deterministic (fixed epoch, no randomness): every run writes the same bytes. Same conventions as WP-A2's
// gen-synthetic-ksfo.ts: unallocated ICAO addresses 000e01–000e04, SYN callsigns, invalid N-numbers (N0…), heights in
// WGS84 ellipsoidal metres (HAE, alt_geom with ADS-B version 2; alt_baro from the EGM96 geoid and the QNH). Runway 26 is
// from public/airports/heroes.json (WP-T1, 2026-09-22).
// SYN601 (?hex=000e01) is the one to chase: over the Karwendel from the north, across the Nordkette ridge at 2,700 m HAE
// (the ridge is 2,350 m there), a left turn onto a downwind east along the Inn valley, a right turn onto the runway 26
// final, a 3° glide path, touchdown and rollout. Its terrain clearance was checked against Re:Earth (plan WP-E-A).
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { bearingDeg, destination, distanceNm } from '../../../../shared/geo.ts'
import { geoidN } from '../../../../shared/geoid.ts'

const T0_MS = Date.UTC(2026, 8, 22, 10, 0, 0) // 12:00 CEST: the replay is lit at this time (D12), sun ~41° high
const POLLS = 600
const DT = 0.02 // s, integration step
const T_MIN = -2 // s: the first poll's positions are up to 1 s old
const KT = 1852 / 3600 // m/s per knot
const FT = 0.3048
const FPM = FT / 60 // m/s per ft/min
const RAD = Math.PI / 180
const QNH = 1016.0 // hPa (ADS-B reports QNH in 0.8 hPa steps: 1016.0 is one)
const TAN3 = Math.tan(3 * RAD)
const TURN_DEG_S = 3 // standard rate
const LOWI = { lat: 47.260201, lon: 11.344 } // heroes.json reference point: the poll centre
const RWY_26 = { lat: 47.26160049438477, lon: 11.357000350952148, hdg: 261, haeM: 625.72 } // landing threshold
const RWY_08 = { lat: 47.258945864390505, lon: 11.332252515916366, haeM: 629.72 } // the far threshold
/** The runway rises 4 m towards 08 (m per m): the flare and the rollout follow it. */
const RWY_RISE = (RWY_08.haeM - RWY_26.haeM) / (distanceNm(RWY_26.lat, RWY_26.lon, RWY_08.lat, RWY_08.lon) * 1852)
const OUT_CRS = 81 // the final approach course seen from the threshold (reciprocal of 261)
const NORDKETTE = { lat: 47.3125, lon: 11.3864 } // Hafelekar, 2,345 m HAE (Re:Earth)
const PASS_HAE = 2700 // over the ridge
const DOWNWIND_HAE = 1450 // level until the glide path comes down to it (~15 km out: intercepted from below)
const TURN_R = (160 * KT) / (TURN_DEG_S * RAD) // 1,572 m: the base turn's radius at 160 kt
const BASE_AT = 16_000 // m from the threshold along the final course where the base turn starts
const X_FLARE = 5 / TAN3 // m past the threshold: glide path 15 m (50 ft) over it, flare from 10 m
const X_TD = X_FLARE + 400

/** One point of a flight path. h: WGS84 ellipsoidal metres, null = on the ground. trk null = no valid track (stationary). */
interface Row {
  t: number
  lat: number
  lon: number
  h: number | null
  v: number // ground speed, m/s
  trk: number | null
  vs: number // m/s
}

const frac = (x: number): number => x - Math.floor(x)
const lerp = (a: number, b: number, u: number): number => a + (b - a) * Math.min(1, Math.max(0, u))
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const wrap360 = (d: number): number => ((d % 360) + 360) % 360
const wrap180 = (d: number): number => wrap360(d + 180) - 180
/** x to a multiple of step; steps below 1 divide by an integer so 0.1 prints as 0.1, not 0.30000000000000004. */
const round = (x: number, step: number): number => (step < 1 ? Math.round(x / step) / Math.round(1 / step) : Math.round(x / step) * step)
/** Deterministic noise in [−1, 1]. */
const noise = (i: number, k: number): number => 2 * frac(Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) - 1

function run(step: (t: number) => Row): Row[] {
  const rows: Row[] = []
  for (let n = 0; T_MIN + n * DT <= POLLS + 2; n++) rows.push(step(T_MIN + n * DT))
  return rows
}

/** Linear interpolation between integration rows (track from the earlier row). */
function at(rows: Row[], t: number): Row {
  const k = Math.min(rows.length - 2, Math.max(0, Math.floor((t - T_MIN) / DT)))
  const [a, b] = [rows[k], rows[k + 1]]
  const u = (t - a.t) / DT
  const h = a.h === null || b.h === null ? (u < 0.5 ? a.h : b.h) : lerp(a.h, b.h, u)
  return { t, lat: lerp(a.lat, b.lat, u), lon: lerp(a.lon, b.lon, u), h, v: lerp(a.v, b.v, u), trk: a.trk, vs: lerp(a.vs, b.vs, u) }
}

/** Metres along the final approach course out from the runway 26 threshold, and to its right (south: positive). */
function finalFrame(lat: number, lon: number): { along: number; cross: number } {
  const d = distanceNm(RWY_26.lat, RWY_26.lon, lat, lon) * 1852
  const b = (bearingDeg(RWY_26.lat, RWY_26.lon, lat, lon) - OUT_CRS) * RAD
  return { along: d * Math.cos(b), cross: d * Math.sin(b) }
}

/** Height above the threshold on the 3° glide path, flare and touchdown (as WP-A2's 28R arrival); null = on the ground. */
function glideAbove(x: number): number | null {
  if (x <= X_FLARE) return 15 - x * TAN3
  if (x >= X_TD) return null
  const u = (x - X_FLARE) / 400
  const [m0, m1] = [-TAN3 * 400, -0.15 * TAN3 * 400] // cubic Hermite: 10 m → 0 m, slope −3° → −0.45°
  return 10 * (2 * u ** 3 - 3 * u ** 2 + 1) + m0 * (u ** 3 - 2 * u ** 2 + u) + m1 * (u ** 3 - u ** 2)
}

/** HAE on the glide path x metres past the threshold (negative on final), over the rising runway; null = on the ground. */
function pathHae(x: number): number | null {
  const g = glideAbove(x)
  return g === null ? null : RWY_26.haeM + Math.max(0, x) * RWY_RISE + g
}

/** Turns trk towards cmd at the standard rate; returns the new track. */
const steer = (trk: number, cmd: number): number => wrap360(trk + clamp(wrap180(cmd - trk), -TURN_DEG_S * DT, TURN_DEG_S * DT))

// ---------- SYN601: A320 across the Nordkette, downwind in the Inn valley, runway 26 ----------
// A right-hand circuit flown by a small autopilot: the downwind is 2·TURN_R left of the final course, so a 180° standard
// rate turn at 160 kt ends on it. The cross-track laws (30° per km, at most 45°) settle in ~20 s without overshoot.
function arrival(): Row[] {
  let { lat, lon } = destination(NORDKETTE.lat, NORDKETTE.lon, 348, 7000 / 1852) // 7 km before the ridge, on 168°
  let h: number | null = 2950
  let v = 180 * KT
  let trk = 168
  let vs = 0
  let phase: 'pass' | 'downwind' | 'base' | 'final' | 'ground' = 'pass'
  return run((t) => {
    const { along, cross } = finalFrame(lat, lon)
    const row: Row = { t, lat, lon, h, v, trk: v > 0 ? trk : null, vs }
    let hNext = h
    if (phase === 'pass') {
      // 2,950 → 2,700 m over the 7 km to the ridge (−650 fpm), then down the south face into the valley
      vs = -(250 / 7000) * v
      if (distanceNm(lat, lon, NORDKETTE.lat, NORDKETTE.lon) * 1852 < 50) phase = 'downwind'
    } else if (phase === 'downwind') {
      trk = steer(trk, OUT_CRS + clamp(-0.03 * (cross + 2 * TURN_R), -45, 45))
      vs = h! > DOWNWIND_HAE ? -1500 * FPM : 0
      if (along > 10_000) v = Math.max(160 * KT, v - 0.5 * DT) // slow to the base-turn speed
      if (along >= BASE_AT) phase = 'base'
    } else if (phase === 'base') {
      trk = wrap360(trk + TURN_DEG_S * DT) // right turn, 081 → 261
      vs = h! > DOWNWIND_HAE ? -1500 * FPM : 0
      if (wrap180(trk - RWY_26.hdg) >= 0) {
        trk = RWY_26.hdg
        phase = 'final'
      }
    } else if (phase === 'final') {
      trk = steer(trk, RWY_26.hdg + clamp(0.03 * cross, -30, 30))
      const x = -along // metres past the threshold
      if (along > 12_000) v = 160 * KT
      else if (along > 7000) v = lerp(138, 160, (along - 7000) / 5000) * KT // 160 → 138 kt from 12 to 7 km out
      else if (x <= X_FLARE) v = 138 * KT
      else v = lerp(138, 132, (x - X_FLARE) / 400) * KT // bleeds 6 kt in the flare
      const onPath = pathHae(x)
      if (onPath === null) {
        phase = 'ground'
        hNext = null
        vs = 0
      } else if (onPath <= h!) {
        const ahead = pathHae(x + 0.5)
        const behind = pathHae(x - 0.5)
        vs = ahead === null || behind === null ? 0 : (ahead - behind) * v
        hNext = onPath
      } else vs = 0 // below the glide path: level until it comes down
    } else {
      if (v > 30 * KT) v -= 2.0 * DT // autobrake
      else if (v > 15 * KT) v -= 0.8 * DT
      else v = Math.max(0, v - 0.6 * DT) // stops on the runway, ~250 m before its end
    }
    if (phase !== 'final' && hNext !== null) hNext += vs * DT
    ;({ lat, lon } = destination(lat, lon, trk, (v * DT) / 1852))
    h = hNext
    return row
  })
}

// ---------- SYN602: A320 parked south of the runway, transponder on (a ground icon for the grow and sink) ----------
function parked(): Row[] {
  const p = { lat: 47.2592, lon: 11.348 }
  return run((t) => ({ t, ...p, h: null, v: 0, trk: null, vs: 0 }))
}

// ---------- SYN603: C172 westbound along the Inn valley at 1,100 m HAE, 100 kt (a low icon over the valley) ----------
// Over Wattens, down the valley past the airport, then right onto 280° where the valley bends north-west towards Zirl.
function valley(): Row[] {
  let { lat, lon } = destination(RWY_26.lat, RWY_26.lon, OUT_CRS, 18_000 / 1852)
  const v = 100 * KT
  let trk = RWY_26.hdg
  return run((t) => {
    const row: Row = { t, lat, lon, h: 1100, v, trk, vs: 0 }
    if (finalFrame(lat, lon).along < -2000) trk = steer(trk, 280)
    ;({ lat, lon } = destination(lat, lon, trk, (v * DT) / 1852))
    return row
  })
}

// ---------- SYN604: B77W cruising FL350 on 135° at 480 kt, from 35 nm north-west of LOWI ----------
function cruise(): Row[] {
  let { lat, lon } = destination(LOWI.lat, LOWI.lon, 315, 35)
  const v = 480 * KT
  return run((t) => {
    const row: Row = { t, lat, lon, h: 36_125 * FT, v, trk: 135, vs: 0 } // alt_geom 36,125 ft with alt_baro FL350
    ;({ lat, lon } = destination(lat, lon, 135, (v * DT) / 1852))
    return row
  })
}

// ---------- readsb / adsb.lol v2 aircraft objects ----------

interface Plane {
  k: number
  hex: string
  flight: string
  r: string
  t: string
  category: string
  squawk: string
  mcpFt: number | null
  baroFt?: number // fixed pressure altitude (cruise); otherwise from the height
  heading?: number // true heading sent while stationary
  rows: Row[]
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6

/** The object one poll at now (s since T0, integer i) shows for this aircraft (ADS-B version 2). */
function object(p: Plane, i: number): Record<string, unknown> {
  // Position message times: 1–2 per second in the air; every 5 s for a stationary aircraft on the ground.
  let seenPos = 0.05 + 0.9 * frac(0.6180339887 * i + 0.3183 * p.k)
  let s = at(p.rows, i - seenPos)
  if (s.h === null && s.v === 0) {
    const tPos = 5 * Math.floor((i + 0.3) / 5) - 0.3
    seenPos = i - tPos
    s = at(p.rows, tPos)
  }
  const seen = Math.min(seenPos, 0.05 + 0.5 * frac(0.4142 * i + 0.27 * p.k))
  const o: Record<string, unknown> = { hex: p.hex, type: 'adsb_icao', flight: p.flight, r: p.r, t: p.t }
  if (s.h === null) {
    o.alt_baro = 'ground'
    o.gs = round(s.v / KT, 0.1)
    if (s.trk !== null) o.track = round(s.trk, 0.01)
    else if (p.heading !== undefined) o.true_heading = p.heading
  } else {
    o.alt_baro = p.baroFt ?? round((s.h - geoidN(s.lat, s.lon)) / FT - (QNH - 1013.25) * 27, 25)
    o.alt_geom = round(s.h / FT, 25)
    o.gs = round(s.v / KT, 0.1)
    if (s.trk !== null) o.track = round(s.trk, 0.01)
    o.baro_rate = round(s.vs / FPM, 64)
    if (s.vs !== 0) o.geom_rate = round(s.vs / FPM + 32 * noise(i, p.k + 3), 64)
  }
  o.squawk = p.squawk
  o.emergency = 'none'
  o.category = p.category
  if (s.h !== null) o.nav_qnh = QNH
  if (p.mcpFt !== null && s.h !== null) o.nav_altitude_mcp = p.mcpFt
  o.lat = round6(s.lat)
  o.lon = round6(s.lon)
  o.nic = 8
  o.rc = 186
  o.seen_pos = Math.round(seenPos * 1000) / 1000
  o.version = 2
  o.nic_baro = 1
  o.nac_p = 9
  o.nac_v = 2
  o.sil = 3
  o.sil_type = 'perhour'
  o.gva = 2
  o.sda = 2
  o.alert = 0
  o.spi = 0
  o.mlat = []
  o.tisb = []
  o.messages = 1000 * p.k + 9 * i
  o.seen = Math.floor(seen * 10) / 10 // adsb.lol rounds seen to 0.1 s; floor keeps seen ≤ seen_pos
  o.rssi = Math.round((-24 - 3 * p.k + 2 * noise(i, p.k + 4)) * 10) / 10
  o.dst = Math.round(distanceNm(LOWI.lat, LOWI.lon, s.lat, s.lon) * 1000) / 1000
  o.dir = Math.round(bearingDeg(LOWI.lat, LOWI.lon, s.lat, s.lon) * 10) / 10
  return o
}

const planes: Plane[] = [
  { k: 1, hex: '000e01', flight: 'SYN601  ', r: 'N0SYN6', t: 'A320', category: 'A3', squawk: '4521', mcpFt: 5000, heading: 261, rows: arrival() },
  { k: 2, hex: '000e02', flight: 'SYN602  ', r: 'N0SYN7', t: 'A320', category: 'A3', squawk: '2000', mcpFt: null, heading: 81, rows: parked() },
  { k: 3, hex: '000e03', flight: 'SYN603  ', r: 'N0SYN8', t: 'C172', category: 'A1', squawk: '7000', mcpFt: null, rows: valley() },
  { k: 4, hex: '000e04', flight: 'SYN604  ', r: 'N0SYN9', t: 'B77W', category: 'A5', squawk: '2206', mcpFt: 35_008, baroFt: 35_000, rows: cruise() },
]

const OUT = process.argv[2] ?? 'data/recordings/synthetic-lowi.jsonl'
const lines: string[] = []
for (let i = 0; i < POLLS; i++) {
  const now = T0_MS + i * 1000
  const ac = planes.map((p) => object(p, i)).filter((o) => (o.dst as number) <= 40)
  const body = JSON.stringify({ ac, ctime: now, msg: 'No error', now, ptime: 0, total: ac.length })
  const tSendMs = now - 45 - ((i * 17) % 30)
  const tRecvMs = now + 95 + ((i * 29) % 60)
  const url = `synthetic:/v2/point/${LOWI.lat}/${LOWI.lon}/40`
  lines.push(JSON.stringify({ v: 1, source: 'adsblol', url, status: 200, tSendMs, tRecvMs, bytes: Buffer.byteLength(body), body }))
}
const text = lines.join('\n') + '\n'
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, text)
console.log(`${OUT}: ${POLLS} polls, ${planes.length} aircraft, ${Buffer.byteLength(text)} bytes`)

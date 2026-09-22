// .planning/plans/assets/WP-A2/gen-synthetic-ksfo.ts
// Synthetic replay fixture for the whole app: 330 adsb.lol-style polls (RecordLine JSONL, 1 Hz, 40 nm around KSFO)
// holding five invented aircraft, printed to stdout. Run from the repository root:
//   node .planning/plans/assets/WP-A2/gen-synthetic-ksfo.ts > .planning/plans/assets/WP-A2/synthetic-ksfo.jsonl
// Deterministic (fixed epoch, no randomness): every run prints the same bytes.
// The aircraft use unallocated ICAO addresses 000a01–000a05, SYN callsigns and invalid N-numbers (N0…), so nothing
// here can be mistaken for a real flight. Runway numbers are from public/airports/heroes.json (WP-T1, 2026-09-22).
import { bearingDeg, destination, distanceNm } from '../../../../shared/geo.ts'
import { geoidN } from '../../../../shared/geoid.ts'

const T0_MS = Date.UTC(2026, 8, 22, 18, 0, 0) // 11:00 PDT
const POLLS = 330
const DT = 0.02 // s, integration step
const T_MIN = -2 // s: the first poll's positions are up to 1 s old
const KT = 1852 / 3600 // m/s per knot
const FT = 0.3048
const FPM = FT / 60 // m/s per ft/min
const QNH = 1016.0 // hPa (ADS-B reports QNH in 0.8 hPa steps: 1016.0 is one)
const TAN3 = Math.tan((3 * Math.PI) / 180)
const KSFO = { lat: 37.6188, lon: -122.3758 } // the recorder's KSFO centre (tools/record-cells.ts)
const RWY_28R = { lat: 37.61392406152527, lon: -122.35807660762543, hdg: 298, haeM: -28.3 } // landing threshold
const RWY_1R = { lat: 37.60768835105868, lon: -122.38015132095961, hdg: 28, haeM: -28.65 }

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
const wrap360 = (d: number): number => ((d % 360) + 360) % 360
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

// ---------- SYN101: A320 on a 3° ILS to 28R from 10 nm, flare, touchdown, rollout ----------
// x = metres past the 28R threshold along 298° (negative on final). Threshold crossing height 15 m (50 ft), so the
// glide path meets the runway 286 m in; the flare starts at 10 m and touches down 400 m later at ~110 fpm.
const X_FLARE = 5 / TAN3
const X_TD = X_FLARE + 400

function heightAbove28R(x: number): number | null {
  if (x <= X_FLARE) return 15 - x * TAN3
  if (x >= X_TD) return null
  const u = (x - X_FLARE) / 400
  const [m0, m1] = [-TAN3 * 400, -0.15 * TAN3 * 400] // cubic Hermite: 10 m → 0 m, slope −3° → −0.45°
  return 10 * (2 * u ** 3 - 3 * u ** 2 + 1) + m0 * (u ** 3 - 2 * u ** 2 + u) + m1 * (u ** 3 - u ** 2)
}

function speed28R(x: number): number {
  if (x <= -9260) return lerp(170, 145, (x + 18_520) / 9260) * KT // 10 → 5 nm: 170 → 145 kt
  if (x <= -7408) return lerp(145, 138, (x + 9260) / 1852) * KT // 5 → 4 nm: → 138 kt (final approach speed)
  if (x <= X_FLARE) return 138 * KT
  return lerp(138, 132, (x - X_FLARE) / 400) * KT // bleeds 6 kt in the flare
}

const posOn28R = (x: number): { lat: number; lon: number } => destination(RWY_28R.lat, RWY_28R.lon, RWY_28R.hdg, x / 1852)

function arrival(): Row[] {
  let x = -18_520
  let v = speed28R(x)
  return run((t) => {
    const air = heightAbove28R(x)
    if (air !== null) v = speed28R(x)
    else if (v > 30 * KT) v -= 2.0 * DT // autobrake
    else if (v > 15 * KT) v -= 0.8 * DT // to taxi speed, then hold it
    const p = posOn28R(x)
    const hi = heightAbove28R(x + 0.5)
    const lo = heightAbove28R(x - 0.5)
    const row: Row = {
      t,
      ...p,
      h: air === null ? null : RWY_28R.haeM + air,
      v,
      trk: bearingDeg(p.lat, p.lon, posOn28R(x + 50).lat, posOn28R(x + 50).lon),
      vs: air === null || hi === null || lo === null ? 0 : (hi - lo) * v,
    }
    x += v * DT
    return row
  })
}

// ---------- SYN202: B738 lined up on 1R, takeoff at t = 40 s, right turn to 118° at 1,000 ft, climb to 10,000 ft ----------
function departure(): Row[] {
  let { lat, lon } = RWY_1R
  let h: number | null = null
  let v = 0
  let vs = 0
  let trk = RWY_1R.hdg
  return run((t) => {
    if (t >= 40) {
      if (h === null) {
        v += 2.2 * DT
        if (v >= 150 * KT) h = RWY_1R.haeM // rotate
      } else {
        v = Math.min(250 * KT, v + 0.6 * DT)
        const mslFt = (h - geoidN(lat, lon)) / FT
        vs = mslFt < 9800 ? Math.min(2500 * FPM, vs + 3 * DT) : Math.max(0, vs - 1 * DT) // level off at 10,000 ft
        if (h - RWY_1R.haeM > 1000 * FT && trk < 118) trk = Math.min(118, trk + 3 * DT) // standard-rate right turn
      }
    }
    const row: Row = { t, lat, lon, h, v, trk: v > 0 ? trk : null, vs }
    const p = destination(lat, lon, trk, (v * DT) / 1852)
    ;({ lat, lon } = p)
    if (h !== null) h += vs * DT
    return row
  })
}

// ---------- SYN303: B77W cruising FL350 on 135° at 480 kt, from 35 nm north-west of KSFO ----------
function cruise(): Row[] {
  let { lat, lon } = destination(KSFO.lat, KSFO.lon, 315, 35)
  const v = 480 * KT
  return run((t) => {
    const row: Row = { t, lat, lon, h: 36_125 * FT, v, trk: 135, vs: 0 } // alt_geom 36,125 ft with alt_baro FL350
    ;({ lat, lon } = destination(lat, lon, 135, (v * DT) / 1852))
    return row
  })
}

// ---------- SYN404: E75L (ADS-B v0) in a right-hand hold at 6,000 ft, inbound 298°, 16 nm south-east of KSFO ----------
function hold(): Row[] {
  const fix = destination(KSFO.lat, KSFO.lon, 118, 16)
  const v = 210 * KT
  let { lat, lon } = destination(fix.lat, fix.lon, 118, (v * 30) / 1852) // 30 s before the fix
  let trk = 298
  return run((t) => {
    const tau = (t - T_MIN) % 240 // 30 s inbound, 60 s turn, 60 s outbound, 60 s turn, 30 s inbound
    const turning = (tau >= 30 && tau < 90) || (tau >= 150 && tau < 210)
    const row: Row = { t, lat, lon, h: 6000 * FT, v, trk: wrap360(trk), vs: 0 } // h unused: v0 sends baro only
    if (turning) trk += 3 * DT
    else trk = tau < 30 || tau >= 210 ? 298 : 118 // snap the rounding of 60 s × 3°/s
    ;({ lat, lon } = destination(lat, lon, trk, (v * DT) / 1852))
    return row
  })
}

// ---------- SYN505: C172 seen only by MLAT, 3,500 ft, 300° at 105 kt ----------
function mlat(): Row[] {
  let { lat, lon } = destination(KSFO.lat, KSFO.lon, 160, 9)
  const v = 105 * KT
  return run((t) => {
    const row: Row = { t, lat, lon, h: null, v, trk: 300, vs: 0 }
    ;({ lat, lon } = destination(lat, lon, 300, (v * DT) / 1852))
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
  kind: 'v2' | 'v0' | 'mlat'
  mcpFt: number | null
  baroFt?: number // fixed pressure altitude (cruise, hold, MLAT); otherwise from the height
  rows: Row[]
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6

/** The object one poll at now (s since T0, integer i) shows for this aircraft. */
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
  let { lat, lon } = s
  let gs = s.v / KT
  let trk = s.trk
  if (p.kind === 'mlat') {
    const d = destination(lat, lon, 360 * frac(0.1 * i + p.k), (20 * Math.abs(noise(i, p.k))) / 1852) // ≤ 20 m of scatter
    ;({ lat, lon } = d)
    gs += 3 * noise(i, p.k + 1)
    if (trk !== null) trk = wrap360(trk + 2 * noise(i, p.k + 2))
  }
  const ground = s.h === null && p.kind !== 'mlat'
  const o: Record<string, unknown> = { hex: p.hex, type: p.kind === 'mlat' ? 'mlat' : 'adsb_icao', flight: p.flight, r: p.r, t: p.t }
  if (ground) {
    o.alt_baro = 'ground'
    o.gs = round(gs, 0.1)
    if (trk !== null) o.track = round(trk, 0.01)
    else o.true_heading = RWY_1R.hdg + 0.35
  } else {
    const hae = s.h
    const baroFt = p.baroFt ?? round(((hae! - geoidN(lat, lon)) / FT) - (QNH - 1013.25) * 27, 25)
    o.alt_baro = baroFt
    if (p.kind === 'v2') o.alt_geom = round(hae! / FT, 25)
    o.gs = round(gs, 0.1)
    if (trk !== null) o.track = round(trk, 0.01)
    o.baro_rate = round(s.vs / FPM, 64)
    if (p.kind === 'v2' && s.vs !== 0) o.geom_rate = round(s.vs / FPM + 32 * noise(i, p.k + 3), 64)
  }
  o.squawk = p.squawk
  if (p.kind !== 'mlat') o.emergency = 'none'
  o.category = p.category
  if (p.kind === 'v2' && !ground) o.nav_qnh = QNH
  if (p.mcpFt !== null && !ground) o.nav_altitude_mcp = p.mcpFt
  o.lat = round6(lat)
  o.lon = round6(lon)
  const mlatKind = p.kind === 'mlat'
  o.nic = mlatKind ? 0 : 8
  o.rc = mlatKind ? 0 : 186
  o.seen_pos = Math.round(seenPos * 1000) / 1000
  if (!mlatKind) {
    o.version = p.kind === 'v2' ? 2 : 0
    if (p.kind === 'v2') o.nic_baro = 1
    o.nac_p = p.kind === 'v2' ? 9 : 8
    o.nac_v = p.kind === 'v2' ? 2 : 1
    o.sil = p.kind === 'v2' ? 3 : 2
    o.sil_type = p.kind === 'v2' ? 'perhour' : 'unknown'
    if (p.kind === 'v2') o.gva = 2
    o.sda = p.kind === 'v2' ? 2 : 0
  }
  o.alert = 0
  o.spi = 0
  o.mlat = mlatKind ? ['gs', 'track', 'lat', 'lon', 'nic', 'rc'] : []
  o.tisb = []
  o.messages = 1000 * p.k + 9 * i
  o.seen = Math.floor(seen * 10) / 10 // adsb.lol rounds seen to 0.1 s; floor keeps seen ≤ seen_pos
  o.rssi = Math.round((-24 - 3 * p.k + 2 * noise(i, p.k + 4)) * 10) / 10
  o.dst = Math.round(distanceNm(KSFO.lat, KSFO.lon, lat, lon) * 1000) / 1000
  o.dir = Math.round(bearingDeg(KSFO.lat, KSFO.lon, lat, lon) * 10) / 10
  return o
}

const planes: Plane[] = [
  { k: 1, hex: '000a01', flight: 'SYN101  ', r: 'N0SYN1', t: 'A320', category: 'A3', squawk: '4521', kind: 'v2', mcpFt: 3000, rows: arrival() },
  { k: 2, hex: '000a02', flight: 'SYN202  ', r: 'N0SYN2', t: 'B738', category: 'A3', squawk: '4717', kind: 'v2', mcpFt: 10_000, rows: departure() },
  { k: 3, hex: '000a03', flight: 'SYN303  ', r: 'N0SYN3', t: 'B77W', category: 'A5', squawk: '2206', kind: 'v2', mcpFt: 35_008, baroFt: 35_000, rows: cruise() },
  { k: 4, hex: '000a04', flight: 'SYN404  ', r: 'N0SYN4', t: 'E75L', category: 'A3', squawk: '4462', kind: 'v0', mcpFt: null, baroFt: 6000, rows: hold() },
  { k: 5, hex: '000a05', flight: 'SYN505  ', r: 'N0SYN5', t: 'C172', category: 'A1', squawk: '1200', kind: 'mlat', mcpFt: null, baroFt: 3500, rows: mlat() },
]

const out: string[] = []
for (let i = 0; i < POLLS; i++) {
  const now = T0_MS + i * 1000
  const ac = planes.map((p) => object(p, i)).filter((o) => (o.dst as number) <= 40)
  const body = JSON.stringify({ ac, ctime: now, msg: 'No error', now, ptime: 0, total: ac.length })
  const tSendMs = now - 45 - ((i * 17) % 30)
  const tRecvMs = now + 95 + ((i * 29) % 60)
  const url = `synthetic:/v2/point/${KSFO.lat}/${KSFO.lon}/40`
  out.push(JSON.stringify({ v: 1, source: 'adsblol', url, status: 200, tSendMs, tRecvMs, bytes: Buffer.byteLength(body), body }))
}
process.stdout.write(out.join('\n') + '\n')

// .planning/plans/assets/WP-B-A/gen-synthetic-heavy.ts
// Heavy synthetic replay for Gate GB: 5,000 invented aircraft within 240 nm of Innsbruck (LOWI, the hero airport in
// central Europe), 26 adsb.lol-style /v2/point polls 12 s apart (5 min), as RecordLine JSONL. Run from the repository root:
//   node .planning/plans/assets/WP-B-A/gen-synthetic-heavy.ts [out]      (default data/recordings/synthetic-heavy.jsonl)
//   ADSB_SOURCE=replay REPLAY_FILES=data/recordings/synthetic-heavy.jsonl RECORD_DIR= npm run server
// data/recordings/ is gitignored: the output (~80 MB) is never committed; this script is its source.
// Deterministic: a fixed epoch and an integer hash instead of randomness, so every run writes the same bytes.
// Nothing here is a real flight. Every address is in B00000–B01387, a block ICAO Annex 10 Vol III Table 9-1 allocates to
// no State (the app shows no country for them); there are no registrations; general aviation and helicopters use
// invalid N-numbers (N0…). Airliners use real ICAO airline designators with invented flight numbers, so the table and
// the detail panel have airline names to show. Airport positions and elevations: OurAirports (public domain).
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { bearingDeg, destination, distanceNm } from '../../../../shared/geo.ts'
import { geoidN } from '../../../../shared/geoid.ts'

const T0_MS = Date.UTC(2026, 8, 22, 12, 0, 0)
const POLLS = 26 // t = 0, 12, …, 300 s
const PERIOD_S = 12
const N = 5000
const CENTER = { lat: 47.260201, lon: 11.344 } // LOWI, as in public/airports/heroes.json
const PLACE_NM = 240 // aircraft start within this distance of the centre
const QUERY_NM = 250 // the emulated /v2/point radius: aircraft further out are not in the poll
const HEX0 = 0xb00000
const T_FIRST = -12 // s: integrate from before the first poll (a position is up to 9 s old)
const STEPS = (POLLS - 1) * PERIOD_S - T_FIRST + 2 // one state per second
const OUT = process.argv[2] ?? 'data/recordings/synthetic-heavy.jsonl'

// ---- deterministic values ------------------------------------------------------------------------------------------

/** A value in [0, 1) for (aircraft i, key k): an integer hash (murmur3-style finaliser), no randomness. */
function u(i: number, k: number): number {
  let h = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca77)
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d)
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b)
  h ^= h >>> 16
  return (h >>> 0) / 2 ** 32
}
const between = (i: number, k: number, lo: number, hi: number): number => lo + (hi - lo) * u(i, k)
const pick = <T>(xs: readonly T[], i: number, k: number): T => xs[Math.floor(u(i, k) * xs.length)]
function weighted<T>(xs: readonly (readonly [T, number])[], i: number, k: number): T {
  let total = 0
  for (const [, w] of xs) total += w
  let r = u(i, k) * total
  for (const [x, w] of xs) if ((r -= w) < 0) return x
  return xs[xs.length - 1][0]
}
const wrap360 = (d: number): number => ((d % 360) + 360) % 360
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const step = (x: number, s: number): number => Math.round(x / s) * s
const r1 = (x: number): number => Math.round(x * 10) / 10
const r2 = (x: number): number => Math.round(x * 100) / 100
const r3 = (x: number): number => Math.round(x * 1000) / 1000
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

// ---- reference data --------------------------------------------------------------------------------------------------

interface Airport {
  icao: string
  lat: number
  lon: number
  elevFt: number
}
/** [airport, traffic weight]. OurAirports (public domain). */
const AIRPORTS: readonly (readonly [Airport, number])[] = [
  [{ icao: 'EDDM', lat: 48.353802, lon: 11.7861, elevFt: 1487 }, 5],
  [{ icao: 'LSZH', lat: 47.464699, lon: 8.54917, elevFt: 1416 }, 4],
  [{ icao: 'LOWW', lat: 48.110298, lon: 16.5697, elevFt: 600 }, 4],
  [{ icao: 'EDDF', lat: 50.033333, lon: 8.570556, elevFt: 364 }, 5],
  [{ icao: 'LIMC', lat: 45.630606, lon: 8.728111, elevFt: 768 }, 3],
  [{ icao: 'EDDS', lat: 48.689899, lon: 9.22196, elevFt: 1276 }, 2],
  [{ icao: 'LIPZ', lat: 45.505299, lon: 12.3519, elevFt: 7 }, 2],
  [{ icao: 'LKPR', lat: 50.1008, lon: 14.26, elevFt: 1247 }, 2],
  [{ icao: 'LSGG', lat: 46.238098, lon: 6.10895, elevFt: 1411 }, 2],
  [{ icao: 'LIML', lat: 45.445099, lon: 9.27674, elevFt: 353 }, 2],
  [{ icao: 'LIME', lat: 45.673901, lon: 9.70417, elevFt: 782 }, 2],
  [{ icao: 'LIPE', lat: 44.5354, lon: 11.2887, elevFt: 123 }, 1],
  [{ icao: 'EDDN', lat: 49.498699, lon: 11.078056, elevFt: 1046 }, 1],
  [{ icao: 'LOWI', lat: 47.260201, lon: 11.344, elevFt: 1907 }, 1],
  [{ icao: 'LOWS', lat: 47.793301, lon: 13.0043, elevFt: 1411 }, 1],
  [{ icao: 'LOWG', lat: 46.991100, lon: 15.4396, elevFt: 1115 }, 1],
  [{ icao: 'LOWL', lat: 48.233200, lon: 14.1875, elevFt: 980 }, 1],
  [{ icao: 'LJLJ', lat: 46.223701, lon: 14.4576, elevFt: 1273 }, 1],
  [{ icao: 'LIPX', lat: 45.395699, lon: 10.8885, elevFt: 239 }, 1],
  [{ icao: 'LFSB', lat: 47.59, lon: 7.529167, elevFt: 885 }, 1],
  [{ icao: 'EDJA', lat: 47.988800, lon: 10.2395, elevFt: 2077 }, 1],
  [{ icao: 'LDZA', lat: 45.742901, lon: 16.068800, elevFt: 353 }, 1],
  [{ icao: 'LIPH', lat: 45.648399, lon: 12.1944, elevFt: 59 }, 1],
  [{ icao: 'LIPB', lat: 46.460201, lon: 11.3264, elevFt: 789 }, 0.5],
]

/** ICAO type designator → ADS-B emitter category (DO-260B: A1 light, A2 small, A3 large, A4 B757, A5 heavy, A6 high performance, A7 rotorcraft). */
const CATEGORY: Record<string, string> = {
  A319: 'A3', A320: 'A3', A20N: 'A3', A321: 'A3', A21N: 'A3', B738: 'A3', B38M: 'A3', E190: 'A3', E195: 'A3', E75L: 'A3',
  BCS1: 'A3', BCS3: 'A3', CRJ9: 'A3', DH8D: 'A2', AT76: 'A2', B752: 'A4', A332: 'A5', A333: 'A5', A339: 'A5', A359: 'A5',
  A35K: 'A5', B763: 'A5', B772: 'A5', B77W: 'A5', B77L: 'A5', B788: 'A5', B789: 'A5', B748: 'A5', A388: 'A5',
  A400: 'A5', C30J: 'A3', EUFI: 'A6', C25A: 'A2', C56X: 'A2', CL35: 'A2', E55P: 'A2', PC24: 'A2', GLF6: 'A3',
  C172: 'A1', P28A: 'A1', SR22: 'A1', DA40: 'A1', C182: 'A1', PC12: 'A1', DA42: 'A1',
  EC35: 'A7', EC45: 'A7', A139: 'A7', R44: 'A7', AS50: 'A7', B06: 'A7',
}

/** [ICAO airline designator (real), weight, types it flies here]. The flight numbers are invented. */
const AIRLINES: readonly (readonly [string, number, readonly string[]])[] = [
  ['DLH', 14, ['A319', 'A320', 'A20N', 'A321', 'A21N', 'CRJ9', 'E190', 'A359', 'B748', 'A333']],
  ['EWG', 6, ['A319', 'A320', 'A20N']],
  ['RYR', 8, ['B738', 'B38M']],
  ['EZY', 6, ['A319', 'A320', 'A20N', 'A21N']],
  ['WZZ', 4, ['A320', 'A321', 'A21N']],
  ['SWR', 5, ['BCS1', 'BCS3', 'A320', 'A20N', 'A333', 'B77W']],
  ['AUA', 5, ['A320', 'A20N', 'E195', 'DH8D', 'B763', 'B772']],
  ['KLM', 3, ['B738', 'E75L', 'E190', 'B789']],
  ['AFR', 3, ['A320', 'A20N', 'BCS3', 'A359']],
  ['BAW', 3, ['A320', 'A20N', 'A321', 'B772', 'A35K']],
  ['CFG', 3, ['A320', 'A321', 'A20N', 'A339']],
  ['TRA', 2, ['B738', 'B38M']],
  ['EXS', 1, ['B738']],
  ['DLA', 2, ['E195']],
  ['THY', 4, ['A321', 'A21N', 'B38M', 'A333', 'B77W', 'A359']],
  ['PGT', 2, ['A20N', 'A21N', 'B38M']],
  ['SXS', 2, ['B738', 'B38M']],
  ['AEE', 2, ['A320', 'A20N']],
  ['TAP', 1, ['A20N', 'A21N']],
  ['IBE', 1, ['A320', 'A321', 'A20N']],
  ['VLG', 2, ['A320', 'A20N']],
  ['SAS', 2, ['A320', 'A20N', 'A21N']],
  ['FIN', 1, ['A320', 'A321', 'A359']],
  ['LOT', 2, ['B38M', 'E195', 'DH8D', 'B788']],
  ['CSA', 1, ['A320', 'A20N', 'AT76']],
  ['BTI', 1, ['BCS3']],
  ['LGL', 1, ['DH8D', 'E195', 'B38M']],
  ['EIN', 1, ['A320', 'A20N', 'A321']],
  ['ICE', 0.5, ['B38M']],
  ['NAX', 1, ['B738', 'B38M']],
  ['CTN', 1, ['DH8D', 'A319', 'A20N']],
  ['TVS', 1, ['B738', 'B38M']],
  ['ROT', 0.5, ['B738', 'B38M']],
  ['ELY', 1, ['B738', 'B789', 'B788']],
  ['UAE', 2, ['B77W', 'A388']],
  ['QTR', 2, ['A359', 'B77W', 'B788', 'A35K']],
  ['ETD', 1, ['B789']],
  ['SIA', 1, ['A359', 'B77W']],
  ['CCA', 0.5, ['A359', 'B77W']],
  ['ETH', 0.5, ['B788', 'A359']],
  ['MSR', 1, ['A320', 'A20N', 'B738']],
  ['RAM', 0.5, ['B738', 'B788']],
  ['UAL', 1, ['B763', 'B772', 'B789']],
  ['DAL', 1, ['A333', 'A339', 'B763']],
  ['AAL', 0.5, ['B772', 'B788']],
  ['ACA', 0.5, ['B789', 'A333']],
  ['GEC', 1, ['B77L']],
]
const BIZJETS = ['C25A', 'C56X', 'CL35', 'E55P', 'PC24', 'GLF6']
const MILITARY: readonly (readonly [string, readonly string[]])[] = [['GAF', ['A400', 'EUFI']], ['IAM', ['C30J', 'EUFI']]]
const LIGHT = ['C172', 'P28A', 'SR22', 'DA40', 'C182', 'PC12', 'DA42']
const HELIS = ['EC35', 'EC45', 'A139', 'R44', 'AS50', 'B06']
const NAV_MODES: readonly (readonly string[])[] = [
  ['autopilot', 'althold', 'lnav', 'tcas'],
  ['autopilot', 'vnav', 'lnav', 'tcas'],
  ['autopilot', 'lnav', 'tcas'],
]
const EMERGENCIES: Record<number, [string, string]> = { 1234: ['7700', 'general'], 2468: ['7600', 'nordo'] }

// ---- flight model --------------------------------------------------------------------------------------------------

type Kind = 'ground' | 'departure' | 'arrival' | 'cruise' | 'military' | 'bizjet' | 'light' | 'heli'
type Link = 'adsb2' | 'adsb0' | 'mlat'

/** One aircraft at one second. altFt null = on the ground (baro, ft). */
interface State {
  lat: number
  lon: number
  altFt: number | null
  gs: number // kt
  trk: number // deg
  vs: number // fpm
  turn: number // deg/s
}

interface Plane {
  i: number
  hex: string
  kind: Kind
  flight: string
  t: string
  squawk: string
  emergency: string
  dbFlags: number
  link: Link
  ehs: boolean // reports air data (ias/tas/mach, wind, temperatures, selected altitude/heading)
  navModes: readonly string[] | null
  mcpFt: number | null
  first: number // first and last poll the aircraft is in
  last: number
  rows: State[] // one per second from T_FIRST
}

function callsign(i: number, designator: string): string {
  if (u(i, 21) < 0.45) return designator + String(1 + Math.floor(u(i, 22) * 4999)) // DLH1234
  const n = String(1 + Math.floor(u(i, 23) * 99))
  const a = LETTERS[Math.floor(u(i, 24) * 26)]
  const b = u(i, 25) < 0.6 ? LETTERS[Math.floor(u(i, 26) * 26)] : ''
  return designator + n + a + b // EZY84TL, DLH9L
}

function nNumber(i: number): string {
  const c = '0123456789ABCDEFGHJKLMNPRSTUVWXYZ'
  return 'N0' + c[Math.floor(u(i, 27) * c.length)] + c[Math.floor(u(i, 28) * c.length)] + c[Math.floor(u(i, 29) * 10)]
}

const octal = (i: number, k: number): string => String(1 + Math.floor(u(i, k) * 6)) + [1, 2, 3].map((j) => Math.floor(u(i, k + j) * 8)).join('')

/** Integrates one aircraft second by second. toward: an arrival homes on this airport down a 3° path. */
function fly(s0: State, levelFt: number | null, toward: Airport | null): State[] {
  const rows: State[] = []
  let s = { ...s0 }
  for (let n = 0; n < STEPS; n++) {
    rows.push(s)
    const next = { ...s }
    if (toward !== null && s.altFt !== null) {
      const d = distanceNm(s.lat, s.lon, toward.lat, toward.lon)
      const want = bearingDeg(s.lat, s.lon, toward.lat, toward.lon)
      const turn = clamp(((want - s.trk + 540) % 360) - 180, -3, 3) // standard rate at most
      next.trk = wrap360(s.trk + turn)
      next.turn = turn
      next.gs = s.gs + clamp(clamp(140 + 2.2 * d, 140, s.altFt < 10_000 ? 250 : 300) - s.gs, -1, 1)
      const pathFt = toward.elevFt + 318 * d // 3° glide path: 318 ft per nm
      const vs = d < 2 ? 0 : clamp((pathFt - s.altFt) * 2, -2500, 0) // descend onto the path, never climb
      next.vs = vs
      next.altFt = Math.max(toward.elevFt + 800, s.altFt + vs / 60)
    } else {
      next.trk = wrap360(s.trk + s.turn)
      if (s.altFt !== null) {
        const alt = s.altFt + s.vs / 60
        if (levelFt !== null && (s.vs > 0 ? alt >= levelFt : s.vs < 0 && alt <= levelFt)) {
          next.altFt = levelFt
          next.vs = 0
        } else next.altFt = alt
      }
    }
    const p = destination(s.lat, s.lon, s.trk, s.gs / 3600)
    next.lat = p.lat
    next.lon = p.lon
    s = next
  }
  return rows
}

function plane(i: number): Plane {
  const hex = (HEX0 + i).toString(16)
  const r = u(i, 0)
  const cruiser = EMERGENCIES[i] !== undefined // the two emergencies fly at cruise level
  const kind: Kind = cruiser ? 'cruise'
    : r < 0.11 ? 'ground'
    : r < 0.27 ? 'departure'
    : r < 0.45 ? 'arrival'
    : r < 0.88 ? (u(i, 1) < 0.01 ? 'military' : u(i, 1) < 0.04 ? 'bizjet' : 'cruise')
    : r < 0.96 ? 'light'
    : 'heli'
  const [designator, , types] = weighted(AIRLINES.map((a) => [a, a[1]] as const), i, 2)
  let flight = callsign(i, designator)
  let t = pick(types, i, 3)
  let squawk = octal(i, 4)
  let dbFlags = 0
  let link: Link = u(i, 8) < 0.97 ? 'adsb2' : 'adsb0'
  let ehs = u(i, 9) < 0.85
  const apt = weighted(AIRPORTS, i, 10)
  const brg = between(i, 11, 0, 360)
  const trk = between(i, 12, 0, 360)
  const heavy = CATEGORY[t] === 'A5'
  let s0: State
  let levelFt: number | null = null
  let toward: Airport | null = null
  let mcpFt: number | null = null

  const random = (maxNm: number): { lat: number; lon: number } =>
    destination(CENTER.lat, CENTER.lon, between(i, 13, 0, 360), maxNm * Math.sqrt(u(i, 14)))

  switch (kind) {
    case 'ground': {
      const p = destination(apt.lat, apt.lon, brg, between(i, 15, 0.1, 0.9))
      const taxi = u(i, 16) < 0.3
      s0 = { ...p, altFt: null, gs: taxi ? between(i, 17, 8, 20) : 0, trk, vs: 0, turn: taxi ? between(i, 18, -1.5, 1.5) : 0 }
      ehs = false
      break
    }
    case 'departure': {
      const d = between(i, 15, 2, 45)
      const altFt = apt.elevFt + 1000 + d * 480
      levelFt = 1000 * (24 + Math.floor(u(i, 16) * 14))
      mcpFt = levelFt
      s0 = { ...destination(apt.lat, apt.lon, brg, d), altFt, gs: altFt < 10_000 ? between(i, 17, 220, 250) : 300 + altFt / 250, trk: wrap360(brg + between(i, 18, -8, 8)), vs: between(i, 19, 1500, 3200) * (altFt > 20_000 ? 0.6 : 1), turn: 0 }
      break
    }
    case 'arrival': {
      const d = between(i, 15, 15, 110)
      const altFt = Math.min(37_000, step(apt.elevFt + 318 * d + between(i, 16, 0, 3000), 100))
      toward = apt
      mcpFt = Math.max(3000, step(altFt - 4000, 1000))
      s0 = { ...destination(apt.lat, apt.lon, brg, d), altFt, gs: clamp(140 + 2.2 * d, 140, altFt < 10_000 ? 250 : 300), trk: wrap360(brg + 180), vs: 0, turn: 0 }
      break
    }
    case 'cruise':
    case 'military':
    case 'bizjet': {
      if (kind === 'military') {
        const [mil, milTypes] = pick(MILITARY, i, 30)
        flight = mil + String(10 + Math.floor(u(i, 31) * 990))
        t = pick(milTypes, i, 32)
        dbFlags = 1
        ehs = false
      } else if (kind === 'bizjet') {
        flight = nNumber(i)
        t = pick(BIZJETS, i, 32)
      }
      const east = trk < 180 // semicircular rule: eastbound odd, westbound even flight levels
      const fl = kind === 'military' ? 200 + 10 * Math.floor(u(i, 15) * 15) : pick(east ? [290, 310, 330, 350, 370, 390, 410] : [280, 300, 320, 340, 360, 380, 400], i, 15)
      const changing = u(i, 16) < 0.08
      const vs = changing ? (u(i, 17) < 0.5 ? -1 : 1) * between(i, 18, 1000, 2000) : 0
      levelFt = changing ? clamp(fl * 100 + Math.sign(vs) * 2000, 26_000, 41_000) : null
      mcpFt = levelFt ?? fl * 100
      s0 = { ...random(PLACE_NM), altFt: fl * 100, gs: between(i, 19, 400, 520), trk, vs, turn: 0 }
      break
    }
    case 'light': {
      flight = nNumber(i)
      t = pick(LIGHT, i, 32)
      squawk = '7000'
      link = u(i, 8) < 0.7 ? 'adsb2' : u(i, 8) < 0.85 ? 'adsb0' : 'mlat'
      ehs = false
      const turning = u(i, 16) < 0.4
      s0 = { ...random(200), altFt: step(between(i, 15, 2000, 10_500), 100), gs: between(i, 17, 80, 150), trk, vs: step(between(i, 18, -500, 500), 64), turn: turning ? between(i, 19, -3, 3) : 0 }
      levelFt = s0.altFt! + Math.sign(s0.vs) * 1000
      break
    }
    case 'heli': {
      flight = nNumber(i)
      t = pick(HELIS, i, 32)
      squawk = '7000'
      link = u(i, 8) < 0.6 ? 'adsb2' : u(i, 8) < 0.8 ? 'adsb0' : 'mlat'
      ehs = false
      const turning = u(i, 16) < 0.5
      s0 = { ...destination(apt.lat, apt.lon, brg, between(i, 15, 2, 30)), altFt: step(apt.elevFt + between(i, 17, 500, 2500), 100), gs: between(i, 18, 60, 130), trk, vs: 0, turn: turning ? between(i, 19, -4, 4) : 0 }
      break
    }
  }
  if (heavy && kind === 'departure') s0.vs *= 0.7
  const e = EMERGENCIES[i]
  // Churn: 5 % appear during the recording, 5 % leave it (and leaving the 250 nm query circle adds more).
  const c = u(i, 40)
  const first = c < 0.05 ? 1 + Math.floor(u(i, 41) * 12) : 0
  const last = c >= 0.05 && c < 0.1 ? 12 + Math.floor(u(i, 42) * 12) : POLLS - 1
  return {
    i, hex, kind, flight, t, squawk: e ? e[0] : squawk, emergency: e ? e[1] : 'none', dbFlags, link, ehs,
    navModes: ehs && u(i, 43) < 0.6 ? pick(NAV_MODES, i, 44) : null, mcpFt, first, last, rows: fly(s0, levelFt, toward),
  }
}

// ---- the adsb.lol v2 aircraft object -------------------------------------------------------------------------------

/** The state tS seconds after T0 (linear between whole seconds). */
function at(p: Plane, tS: number): State {
  const x = tS - T_FIRST
  const k = clamp(Math.floor(x), 0, p.rows.length - 2)
  const f = x - k
  const a = p.rows[k]
  const b = p.rows[k + 1]
  const lerp = (m: number, n: number): number => m + (n - m) * f
  return {
    lat: lerp(a.lat, b.lat), lon: lerp(a.lon, b.lon), altFt: a.altFt === null || b.altFt === null ? a.altFt : lerp(a.altFt, b.altFt),
    gs: lerp(a.gs, b.gs), trk: wrap360(a.trk + a.turn * f), vs: a.vs, turn: a.turn,
  }
}

/** ISA density ratio at a pressure altitude (troposphere, then the isothermal layer). */
const sigma = (ft: number): number => (ft <= 36_089 ? (1 - 6.8756e-6 * ft) ** 4.2559 : 0.2971 * Math.exp(-(ft - 36_089) / 20_806))

function object(p: Plane, k: number): Record<string, unknown> | null {
  const i = p.i
  const tPoll = k * PERIOD_S
  const parked = p.kind === 'ground' && p.rows[0].gs === 0
  const seenPos = r3(parked ? between(i, 100 + k, 1, 9) : p.link === 'mlat' ? between(i, 100 + k, 0.5, 4) : between(i, 100 + k, 0.1, 2.5))
  const s = at(p, tPoll - seenPos)
  const dst = distanceNm(CENTER.lat, CENTER.lon, s.lat, s.lon)
  if (dst > QUERY_NM) return null
  const mlat = p.link === 'mlat'
  const o: Record<string, unknown> = { hex: p.hex, type: mlat ? 'mlat' : 'adsb_icao', flight: p.flight.padEnd(8), t: p.t }
  if (p.dbFlags) o.dbFlags = p.dbFlags
  const air = s.altFt !== null
  if (!air) {
    o.alt_baro = 'ground'
    o.gs = r1(s.gs)
    o.track = r2(s.trk)
  } else {
    const baro = step(s.altFt!, 25)
    const dev = between(i, 50, -6, 6) // ISA temperature deviation, °C
    o.alt_baro = baro
    if (!mlat) o.alt_geom = step(baro + geoidN(s.lat, s.lon) / 0.3048 + dev * baro * 0.004, 25)
    o.gs = r1(s.gs)
    if (p.ehs) {
      const wd = wrap360(250 + 40 * Math.sin((s.lat - 45) * 0.9) + 20 * Math.cos(s.lon * 0.7))
      const ws = 12 + (s.altFt! / 1000) * 1.6
      const head = ws * Math.cos(((wd - s.trk) * Math.PI) / 180) // headwind component
      const tas = s.gs + head
      const oat = Math.max(-56.5, 15 - 1.98 * (s.altFt! / 1000)) + dev
      const tK = oat + 273.15
      const mach = tas / (38.967854 * Math.sqrt(tK))
      const wca = (Math.asin(clamp((ws * Math.sin(((wd - s.trk) * Math.PI) / 180)) / tas, -1, 1)) * 180) / Math.PI
      const hdg = wrap360(s.trk + wca)
      o.ias = Math.round(tas * Math.sqrt(sigma(s.altFt!)))
      o.tas = Math.round(tas)
      o.mach = Math.round(mach * 1000) / 1000
      o.wd = Math.round(wd)
      o.ws = Math.round(ws)
      o.oat = Math.round(oat)
      o.tat = Math.round(tK * (1 + 0.2 * mach * mach) - 273.15)
      o.track_rate = r2(s.turn)
      o.roll = r2((Math.atan(((s.turn * Math.PI) / 180) * s.gs * 0.514444 / 9.80665) * 180) / Math.PI)
      o.mag_heading = r2(wrap360(hdg - 4)) // declination ≈ 4° E around the Alps
      o.true_heading = r2(hdg)
    }
    o.track = r2(s.trk)
    o.baro_rate = step(s.vs + between(i, 200 + k, -40, 40), 64)
    if (p.link === 'adsb2' && s.vs !== 0) o.geom_rate = step(s.vs + between(i, 300 + k, -60, 60), 64)
  }
  o.squawk = p.squawk
  if (!mlat) o.emergency = p.emergency
  o.category = CATEGORY[p.t]
  if (air && p.link === 'adsb2') o.nav_qnh = p.kind === 'arrival' || p.kind === 'departure' ? 1016 : 1013.6
  if (air && p.ehs && p.mcpFt !== null) o.nav_altitude_mcp = p.mcpFt
  if (air && p.ehs && u(i, 45) < 0.6) o.nav_heading = r2(wrap360(s.trk + between(i, 46, -3, 3)))
  if (air && p.navModes !== null) o.nav_modes = p.navModes
  o.lat = r6(s.lat)
  o.lon = r6(s.lon)
  o.nic = mlat ? 0 : 8
  o.rc = mlat ? 0 : 186
  o.seen_pos = seenPos
  if (!mlat) {
    const v2 = p.link === 'adsb2'
    o.version = v2 ? 2 : 0
    if (v2) o.nic_baro = 1
    o.nac_p = v2 ? 9 : 8
    o.nac_v = v2 ? 2 : 1
    o.sil = v2 ? 3 : 2
    o.sil_type = v2 ? 'perhour' : 'unknown'
    if (v2) o.gva = 2
    o.sda = v2 ? 2 : 0
  }
  o.alert = 0
  o.spi = 0
  o.mlat = mlat ? ['gs', 'track', 'baro_rate', 'lat', 'lon', 'nic', 'rc'] : []
  o.tisb = []
  o.messages = 2000 + ((i * 37) % 9000) + Math.round(tPoll * between(i, 47, 2, 9))
  o.seen = Math.floor(Math.min(seenPos, between(i, 400 + k, 0.05, 1)) * 10) / 10 // adsb.lol: 0.1 s, ≤ seen_pos
  o.rssi = r1(-12 - 20 * (dst / QUERY_NM) + between(i, 500 + k, -3, 3))
  o.dst = r3(dst)
  o.dir = r1(bearingDeg(CENTER.lat, CENTER.lon, s.lat, s.lon))
  return o
}

// ---- output --------------------------------------------------------------------------------------------------------

const planes: Plane[] = []
for (let i = 0; i < N; i++) planes.push(plane(i))
const lines: string[] = []
let objects = 0
for (let k = 0; k < POLLS; k++) {
  const now = T0_MS + k * PERIOD_S * 1000
  const ac: Record<string, unknown>[] = []
  for (const p of planes) {
    if (k < p.first || k > p.last) continue
    const o = object(p, k)
    if (o !== null) ac.push(o)
  }
  objects += ac.length
  const body = JSON.stringify({ ac, ctime: now, msg: 'No error', now, ptime: 0, total: ac.length })
  const tSendMs = now - 45 - ((k * 17) % 30)
  const tRecvMs = now + 95 + ((k * 29) % 60)
  const url = `synthetic:/v2/point/${CENTER.lat}/${CENTER.lon}/${QUERY_NM}`
  lines.push(JSON.stringify({ v: 1, source: 'adsblol', url, status: 200, tSendMs, tRecvMs, bytes: Buffer.byteLength(body), body }))
}
const text = lines.join('\n') + '\n'
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, text)
const counts: Record<string, number> = {}
for (const p of planes) counts[p.kind] = (counts[p.kind] ?? 0) + 1
console.log(`${OUT}: ${POLLS} polls, ${N} aircraft (${objects} objects), ${Buffer.byteLength(text)} bytes`)
console.log(Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', '))

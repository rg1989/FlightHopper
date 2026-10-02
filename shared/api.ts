import type { AircraftInfo, RoutePlace } from './info.ts'
import type { ReadsbAircraft, Sample, SourceKind } from './types.ts'

export type Degraded = null | 'rate-limited' | 'blocked' | 'upstream-down'

export interface StatusBrief {
  source: SourceKind
  degraded: Degraded
  cellPeriodP95S: number | null
  chasePeriodP95S: number | null
  upstreamOffsetMs?: number      // server clock − upstream clock, whole ms (the poller's MinOffset); absent until known. Replay: server now − recording time; live: ≈ latency
  viewEveryS?: number            // expected refresh of the newest view's aircraft, s (its zoom-scaled period, stretched by the budget)
  chaseEveryS?: number           // expected refresh of the chased aircraft, s
  pendingAreas?: number          // areas of the view not loaded yet: no good answer so far (a wide view fills centre-out)
  recording?: { hex: string; callsign: string | null }[] // flights being recorded (server/flightLog.ts); absent when none
  pendingBoxes?: [number, number, number, number][] // those of them that are grid cells, [south, north, west, east] °, in the order they will be asked (the first is loading now); absent when none: the map veils them
}

export interface ViewResponse {
  serverNowMs: number
  samples: Sample[]
  status: StatusBrief
  info?: AircraftInfo[]          // for returned hexes whose info changed after `since` (all of them when since=0)
}

export interface ChaseResponse {
  serverNowMs: number
  samples: Sample[]
  status: StatusBrief
  raw?: ReadsbAircraft | null    // newest full upstream object for the detail panel
  info?: AircraftInfo | null
  dest?: RoutePlace | null       // the route's last airport, when the route and its position are known
  origin?: RoutePlace | null     // the route's first airport, likewise (the flown path's lead-in from it)
  rec?: RecordingState | null    // this aircraft is being recorded (server/flightLog.ts)
}

/** One aircraft in a history slot (GET /api/history): a position per kept slice while it was heard. Columnar. */
export interface HistoryTrack {
  hex: string                    // 6 hex digits, '~' first for a non-ICAO address
  callsign: string | null        // the newest in the slot
  squawk: string | null
  nM: number                     // geoid N at its first position in the slot, m (0.1)
  t: number[]                    // s after the slot's start
  lat: number[]                  // °, 5 decimals
  lon: number[]
  alt: (number | 'g' | null)[]   // baro ft (25 ft steps), 'g' on the ground, null unknown
  gs: (number | null)[]          // ground speed, kt (0.1)
  type: string | null            // ICAO type designator from the server's address table (the files carry none); null unknown
}

/** A UTC half hour of the past in one circle (GET /api/history?slot&lat&lon&nm): adsb.lol's tar1090 heatmap file. */
export interface HistorySlot {
  slotMs: number                 // its start, UTC ms, a multiple of 30 min
  stepS: number                  // seconds between the slices kept: 10 for a near view, coarser for a wide one
  aircraft: HistoryTrack[]
}

/** What the server holds of the past (GET /api/history/status). */
export interface HistoryStatus {
  newestSlotMs: number           // the newest half hour published upstream: its file appears just after it ends
  oldestSlotMs: number           // the oldest half hour upstream still keeps
  slots: { slotMs: number; state: 'ready' | 'loading' | 'missing' }[]
}

/** One aircraft's flight leg (GET /api/trace?hex&at): adsb.lol's trace of it, the leg flying at `at`. Columnar. */
export interface TraceReply {
  hex: string
  callsign: string | null        // the leg's last
  calls: [number, string][]      // every callsign it sent and from when: [s after t0Ms, callsign], in time order
  reg: string | null
  typeCode: string | null
  t0Ms: number                   // the leg's first point, UTC ms
  t: number[]                    // s after t0Ms (0.1)
  lat: number[]                  // °, 5 decimals
  lon: number[]
  alt: (number | 'g' | null)[]   // baro ft (a geometric one, the only kind some send, converted to MSL), 'g' on the ground, null unknown
  gs: (number | null)[]          // kt
  trk: (number | null)[]         // true track, °
  vs: (number | null)[]          // vertical rate, fpm (baro, else geometric)
  roll: (number | null)[]        // °
  nM: number[]                   // geoid N, m (0.1)
  origin?: RoutePlace | null     // the route's first airport, when the server knows the route
}

/** One aircraft's flights over a span (GET /api/trace?hex&from&to): every leg overlapping it, in time order. */
export interface TraceDay {
  hex: string
  reg: string | null
  typeCode: string | null
  fromMs: number                 // the span asked for, as answered (to is capped at the server's now)
  toMs: number
  legs: TraceReply[]
}

/** One flight being recorded to its own file (server/flightLog.ts). Times on the server clock. */
export interface RecordingState {
  hex: string
  callsign: string | null
  file: string                   // relative to the flights directory, e.g. 2026-09-30/143012Z-ELY315-738abc.jsonl
  startedMs: number
  samples: number
  lastMs: number | null          // rxMs of the newest recorded sample
}

/** A recorded flight as the Recordings list shows it (server/flightLog.ts list()). Times on the server clock. */
export interface RecordingInfo {
  file: string                   // relative to the flights directory: its id
  name: string | null            // given by hand (Rename); null: none, shown by its callsign
  hex: string
  callsign: string | null
  reg: string | null
  typeCode: string | null
  category: string | null
  military: boolean
  route: string | null           // e.g. 'LIRF-LLBG'
  source: string
  startedMs: number
  firstMs: number | null         // tMs of its first and last sample (null: none)
  lastMs: number | null
  samples: number
  ended: { why: 'stopped' | 'landed' | 'lost'; endedMs: number } | null // null: still recording, or cut short
  active: boolean                // being recorded now
}

/** One recording's content (GET /api/recordings/track?file=), for a replay. */
export interface RecordingTrack {
  info: RecordingInfo
  samples: Sample[]
}

export interface RecordResponse {
  rec: RecordingState | null     // after the change: null once stopped
  active: RecordingState[]
}

export interface BudgetState {
  rps: number
  maxRps: number
  tokens: number
  blocked: boolean
  pausedUntilMs: number
  counts: { ok: number; r429: number; r4xx: number; r5xx: number; err: number }
}

export interface CellStatus {
  id: string
  lat: number
  lon: number
  radiusNm: number
  lastOkMs: number | null
  periodP95S: number | null
}

export interface StatusReport extends StatusBrief {
  budget: BudgetState
  cells: CellStatus[]
  chasedHexes: string[]
  bytesPerHourEstimate: number
  requestsTotal: number
}

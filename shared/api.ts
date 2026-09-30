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
  rec?: RecordingState | null    // this aircraft is being recorded (server/flightLog.ts)
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

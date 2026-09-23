import type { AircraftInfo } from './info.ts'
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

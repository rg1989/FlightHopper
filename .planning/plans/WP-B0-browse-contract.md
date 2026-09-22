# WP-B0 — Browse & Detail Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the shared types the browse/detail feature needs, so its eight work packages (B-C1 … B-U2) can be built in parallel: `AircraftInfo`/`toInfo`/`sameInfo`, optional `info`/`raw` fields on the API responses, the extra readsb fields the detail panel shows, and `FleetEntry`.

**Architecture:** Additive only. Every new field is optional, so no existing producer or test changes. It follows user feedback #2 (2026-09-22): a tar1090-style top-down browse view with icons coloured by altitude, a table of visible aircraft, and a detail panel with photo, registration, country, airline, route, signal, selected-altitude and wind data. It must stay fast with thousands of aircraft.

**Tech Stack:** as PLAN.md. **Wave:** B0 (after A1, A2, A3 and WP-V4 Task 4 are merged). **Estimated:** 30 min. **Validated:** 2026-09-22 in the integrated tree (all 27 WPs applied): tsc clean, full suite 460/460 (457 + 3 new).

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. Code blocks preceded by `File: \`path\`` contain that file's complete content.

## Files owned by this package

| Path | Change |
|---|---|
| `shared/info.ts`, `shared/info.test.ts` | new |
| `shared/types.ts` | `ReadsbAircraft` gains optional detail fields |
| `shared/api.ts` | `ViewResponse.info?`, `ChaseResponse.raw?` / `info?` |
| `client/types.ts` | `FleetEntry` |

---

### Task 1: Aircraft info type

**Files:** Create `shared/info.ts`; Test `shared/info.test.ts`

**Interfaces:**
- Consumes: `ReadsbAircraft` (WP-00; extended in Task 2 — do Task 2's `shared/types.ts` edit first if tsc complains about `squawk`/`category`/`emergency`)
- Produces: `interface AircraftInfo { hex; callsign; reg; typeCode; category; squawk; emergency; military; route }` (all `string | null` except `military: boolean`), `interface RouteInfo { callsign; route; plausible }`, `toInfo(ac, route?): AircraftInfo`, `sameInfo(a, b): boolean`

- [ ] **Step 1: Write the failing test**

File: `shared/info.test.ts`
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sameInfo, toInfo } from './info.ts'
import { normalizeAdsblol } from './readsb.ts'

const snap = normalizeAdsblol(readFileSync(new URL('../data/fixtures/golden/adsblol-point-ksfo.json', import.meta.url), 'utf8'))

test('toInfo: identity fields trimmed, hex lower-cased, emergency none → null, route passed through', () => {
  const ac = { ...snap.aircraft[0], hex: '71BD79', flight: 'UAL1  ', r: 'N12345', t: 'B738', squawk: '7433', category: 'A3', emergency: 'none', dbFlags: 1 }
  const i = toInfo(ac, 'KSFO-KLAX')
  assert.deepEqual(i, { hex: '71bd79', callsign: 'UAL1', reg: 'N12345', typeCode: 'B738', category: 'A3', squawk: '7433', emergency: null, military: true, route: 'KSFO-KLAX' })
})

test('toInfo: missing fields are null, never undefined', () => {
  const i = toInfo({ hex: 'abc123' })
  assert.deepEqual(Object.values(i).filter((v) => v === undefined), [])
  assert.equal(i.route, null)
  assert.equal(i.military, false)
})

test('sameInfo: any shown field change counts', () => {
  const a = toInfo({ hex: 'abc123', squawk: '1000' })
  assert.equal(sameInfo(a, { ...a }), true)
  assert.equal(sameInfo(a, { ...a, squawk: '7700' }), false)
  assert.equal(sameInfo(a, { ...a, route: 'LLBG-LOWI' }), false)
})
```

- [ ] **Step 2: Run it** — `node --test shared/info.test.ts` → FAIL: `Cannot find module './info.ts'`

- [ ] **Step 3: Implement**

File: `shared/info.ts`
```ts
import type { ReadsbAircraft } from './types.ts'

/**
 * Slow-changing identity of one aircraft, sent once and again only when it changes (ViewResponse.info).
 * route is filled by the server's route cache (null until known); everything else comes from the aircraft object.
 */
export interface AircraftInfo {
  hex: string
  callsign: string | null
  reg: string | null
  typeCode: string | null        // ICAO type designator, e.g. B738
  category: string | null        // ADS-B emitter category, e.g. A3
  squawk: string | null
  emergency: string | null       // readsb value when not 'none', e.g. 'general', 'lifeguard'
  military: boolean              // dbFlags & 1
  route: string | null           // e.g. 'LGPZ-LLBG' (ICAO) from adsb.lol routeset
}

/** Selected/flat route as the server caches it. */
export interface RouteInfo {
  callsign: string
  route: string                  // airport codes joined by '-', ICAO when known
  plausible: boolean             // adsb.lol's own plausibility flag for the route vs the aircraft position
}

const s = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

export function toInfo(ac: ReadsbAircraft, route: string | null = null): AircraftInfo {
  const emergency = s(ac.emergency)
  return {
    hex: ac.hex.toLowerCase(),
    callsign: s(ac.flight),
    reg: s(ac.r),
    typeCode: s(ac.t),
    category: s(ac.category),
    squawk: s(ac.squawk),
    emergency: emergency === 'none' ? null : emergency,
    military: ((ac.dbFlags ?? 0) & 1) !== 0,
    route,
  }
}

/** True when nothing the UI shows has changed (so the server need not resend it). */
export function sameInfo(a: AircraftInfo, b: AircraftInfo): boolean {
  return (
    a.hex === b.hex && a.callsign === b.callsign && a.reg === b.reg && a.typeCode === b.typeCode &&
    a.category === b.category && a.squawk === b.squawk && a.emergency === b.emergency &&
    a.military === b.military && a.route === b.route
  )
}
```

- [ ] **Step 4: Run it** — `node --test shared/info.test.ts` → PASS `ℹ tests 3`

- [ ] **Step 5: Commit** — `git add shared/info.ts shared/info.test.ts && git commit -m "feat(contract): AircraftInfo for the browse table and detail panel"`

---

### Task 2: Extend the wire and client types (additive)

**Files:** Modify `shared/types.ts`, `shared/api.ts`, `client/types.ts` (complete new contents below)

**Interfaces:**
- Produces: optional `ReadsbAircraft` fields `squawk, category, emergency, ias, tas, mach, track_rate, mag_heading, nav_altitude_mcp, nav_altitude_fms, nav_heading, nav_modes, wd, ws, oat, tat, rssi, messages, nac_v, nic_baro, sil, sda, gva, rc`; `ViewResponse.info?: AircraftInfo[]`; `ChaseResponse.raw?: ReadsbAircraft | null`, `ChaseResponse.info?: AircraftInfo | null`; `interface FleetEntry { hex; lat; lon; hM; altFt; onGround; trackDeg; gsKt; vsFpm; ageS; quality; info }`

- [ ] **Step 1: Write the files**

File: `shared/types.ts`
```ts
export type SourceKind = 'adsblol' | 'readsb' | 'replay'
export type Quality = 'adsb2' | 'adsb01' | 'mlat' | 'other'

/** Subset of one readsb / adsb.lol v2 aircraft object that we read. Field names are readsb's. */
export interface ReadsbAircraft {
  hex: string
  type?: string
  flight?: string
  r?: string
  t?: string
  dbFlags?: number
  alt_baro?: number | 'ground'
  alt_geom?: number
  gs?: number
  track?: number
  true_heading?: number
  roll?: number
  baro_rate?: number
  geom_rate?: number
  nav_qnh?: number
  lat?: number
  lon?: number
  nic?: number
  nac_p?: number
  version?: number
  seen_pos?: number
  seen?: number
  mlat?: string[]
  tisb?: string[]
  // Detail-panel fields (read only for the selected aircraft and the table; all optional, as upstream omits unknowns)
  squawk?: string
  category?: string
  emergency?: string
  ias?: number
  tas?: number
  mach?: number
  track_rate?: number
  mag_heading?: number
  nav_altitude_mcp?: number
  nav_altitude_fms?: number
  nav_heading?: number
  nav_modes?: string[]
  wd?: number
  ws?: number
  oat?: number
  tat?: number
  rssi?: number
  messages?: number
  nac_v?: number
  nic_baro?: number
  sil?: number
  sda?: number
  gva?: number
  rc?: number
}

/** Source-agnostic envelope. nowMs is the UPSTREAM clock in ms. */
export interface Snapshot {
  nowMs: number
  aircraft: ReadsbAircraft[]
}

/** One deduped position sample. tMs and rxMs are SERVER clock ms. ADS-B native units (ft, kt, fpm, deg). */
export interface Sample {
  hex: string
  tMs: number
  rxMs: number
  lat: number
  lon: number
  onGround: boolean
  altBaroFt: number | null
  altGeomFt: number | null
  gsKt: number | null
  trackDeg: number | null
  trueHeadingDeg: number | null
  rollDeg: number | null
  baroRateFpm: number | null
  geomRateFpm: number | null
  navQnhHpa: number | null
  version: number | null
  nic: number | null
  quality: Quality
  nM: number
  callsign: string | null
  typeCode: string | null
  reg: string | null
}
```

File: `shared/api.ts`
```ts
import type { AircraftInfo } from './info.ts'
import type { ReadsbAircraft, Sample, SourceKind } from './types.ts'

export type Degraded = null | 'rate-limited' | 'blocked' | 'upstream-down'

export interface StatusBrief {
  source: SourceKind
  degraded: Degraded
  cellPeriodP95S: number | null
  chasePeriodP95S: number | null
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
```

File: `client/types.ts`
```ts
import type { AircraftInfo } from '../shared/info.ts'
import type { Quality } from '../shared/types.ts'
import type { AltSource } from './track/types.ts'

/** What the scene draws for one aircraft at render time. Produced by Track.stateAt(). */
export interface RenderState {
  hex: string
  lat: number
  lon: number
  hM: number                                    // WGS84 ellipsoidal metres of the wheels (the chase model adds gearHeightM)
  headingDeg: number                            // true, nose direction
  pitchDeg: number                              // nose-up positive
  rollDeg: number                               // right-wing-down positive
  gsKt: number | null                           // copied from the newest sample
  trackDeg: number | null                       // copied from the newest sample
  altBaroFt: number | null                      // copied from the newest sample
  vsFpm: number | null                          // from the vertical filter (derived)
  mode: 'interp' | 'extrap' | 'stale'           // stale = extrapolated past 8 s → frozen
  altSource: AltSource
  onGround: boolean
  ageS: number                                  // tRender − newest sample tMs, seconds
  quality: Quality
  callsign: string | null
  typeCode: string | null
}

export interface ClientConfig {
  terrain: 'ion' | 'reearth' | 'ellipsoid'
  imagery: 'ion' | 'eox' | 'none'
  ionToken: string | null
  apiBase: string
}

/** public/models/manifest.json entry. Calibration makes the model's nose point along RenderState.headingDeg. */
export interface ModelManifestEntry {
  id: string
  uri: string                                   // relative to public/, e.g. "models/airliner.glb"
  license: string
  author: string
  source: string                                // where it was downloaded from
  forwardAxisFix: { headingDeg: number; pitchDeg: number; rollDeg: number }
  gearHeightM: number                           // model origin → wheel bottom, metres (after scale)
  lengthM: number                               // real-world length the scale targets
  scale: number
}

export interface ModelManifest {
  default: string                               // id of the model used when no type match
  models: ModelManifestEntry[]
}

/**
 * One aircraft in the browse view: newest sample, dead-reckoned to the render time (no Hermite, no filters), for
 * thousands of aircraft per frame. Objects are reused between frames by Fleet; never keep a reference across frames.
 */
export interface FleetEntry {
  hex: string
  lat: number
  lon: number
  hM: number                                    // HAE metres for 3-D placement (geom, else baro + N; ground: N)
  altFt: number | null                          // baro ft (geom when no baro) for colour and table; null = unknown
  onGround: boolean
  trackDeg: number | null
  gsKt: number | null
  vsFpm: number | null
  ageS: number                                  // render time − newest sample tMs, seconds
  quality: Quality
  info: AircraftInfo | null
}
```

- [ ] **Step 2: Verify nothing else changed** — `npm run check` → tsc silent; every existing test still passes (460 in the integrated tree).

- [ ] **Step 3: Commit** — `git add shared/types.ts shared/api.ts client/types.ts && git commit -m "feat(contract): optional info/raw on API responses, FleetEntry, readsb detail fields"`

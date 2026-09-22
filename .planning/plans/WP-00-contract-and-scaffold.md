# WP-00 — Contract & Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the repository, every shared type and interface as real code, the small pure helpers everything else depends on, golden test fixtures, the Vite + Cesium setup, and a day-1 fixture recorder — so that all Wave 1 work packages can start in parallel without touching each other's files.

**Architecture:** Contract-first. This package owns every type that crosses a work-package boundary (`shared/*.ts`, `server/sources/types.ts`, `server/recording.ts`, `client/types.ts`, `client/track/types.ts`, `tools/types.ts`) plus the tiny, fully specified helpers that many packages call (envelope normalizers, `toSample`, `Deduper`, `MinOffset`, spherical geo, geoid, recording reader). Nothing here is speculative: each helper has at least two consumers in later packages.

**Tech Stack:** Node ≥ 24.2 (native TypeScript), `node:test`, TypeScript 7 (type-check only), Vite 8 + `vite-plugin-static-copy` 4, CesiumJS 1.145, `egm96-universal` 1.1.

**Wave:** 0 (sequential; everything else waits for this). **Estimated:** 2–3 h. **Validated:** every file below was run in a scratch copy on 2026-09-22: 41/41 tests pass, `tsc --noEmit` clean, `vite build` produces `dist/cesiumStatic/{Workers,Assets,ThirdParty,Widgets}`, and the dev server renders a globe.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints — they apply to every task here. The ones this package establishes:
- Node `>=24.2` (`import.meta.main` needs 24.2), `"type": "module"`, erasable TypeScript only, `.ts` extensions on relative imports.
- Tests: `node:test` + `node:assert/strict`, `*.test.ts` next to the code; `npm test` discovers them by glob, so later packages never edit `package.json`.
- Dependencies are fixed here. Later packages add none without a justification line in their plan.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `.env.example` | scaffold |
| `vite.config.ts`, `index.html`, `client/main.ts` (placeholder, replaced by WP-F2) | client build |
| `shared/types.ts`, `shared/api.ts`, `shared/airports.ts` | cross-package data types |
| `shared/readsb.ts` | the only envelope difference between adsb.lol and readsb |
| `shared/sample.ts`, `shared/geoid.ts` | `classify`, `isHidden`, `toSample`, `geoidN` |
| `shared/dedupe.ts`, `shared/clock.ts`, `shared/geo.ts` | `Deduper`, `MinOffset`, `distanceNm`/`bearingDeg`/`destination` |
| `server/sources/types.ts` | `Source`, `SourceCaps`, `FetchResult` |
| `server/recording.ts` | `RecordLine`, `readRecording`, `recordingToSamples` |
| `client/types.ts`, `client/track/types.ts`, `tools/types.ts` | client/tool data types |
| `tools/record-cells.ts` | day-1 fixture recorder |
| `data/fixtures/README.md`, `data/fixtures/golden/*` | golden test data |

---

### Task 1: Repository scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`

**Interfaces:**
- Consumes: nothing
- Produces: npm scripts `dev`, `server`, `build`, `typecheck`, `test`, `check`, `record:cells` used by every later package.

- [ ] **Step 1: Initialise git and install exact dependencies**

Run from the repository root (`/Users/rgv250cc/Documents/Projects/FlightHopper`):

```bash
git init -b main
npm init -y >/dev/null
npm i cesium@^1.145.0 egm96-universal@^1.1.1
npm i -D vite@^8.3.0 vite-plugin-static-copy@^4.1.1 typescript@^7.0.2 @types/node@^24
```

- [ ] **Step 2: Replace `package.json` with this content (keep the versions npm resolved in the dependency blocks if they are newer patch releases)**

```json
{
  "name": "flighthopper",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24.2"
  },
  "dependencies": {
    "cesium": "^1.145.0",
    "egm96-universal": "^1.1.1"
  },
  "devDependencies": {
    "@types/node": "^24.13.6",
    "typescript": "^7.0.2",
    "vite": "^8.3.0",
    "vite-plugin-static-copy": "^4.1.1"
  },
  "scripts": {
    "dev": "vite",
    "server": "node --env-file-if-exists=.env.local server/main.ts",
    "build": "vite build",
    "typecheck": "tsc --noEmit",
    "test": "node --test \"shared/**/*.test.ts\" \"server/**/*.test.ts\" \"client/**/*.test.ts\" \"tools/**/*.test.ts\"",
    "check": "npm run typecheck && npm test",
    "record:cells": "node --env-file-if-exists=.env.local tools/record-cells.ts"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["es2023", "dom", "dom.iterable"],
    "types": ["node", "vite/client"],
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "noUncheckedIndexedAccess": false,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["shared", "server", "client", "tools", "harness", "vite.config.ts"]
}
```

- [ ] **Step 4: Write `.gitignore` and `.env.example`**

```gitignore
node_modules/
dist/
data/recordings/
.env.local
*.log
.DS_Store
```

```bash
# Copy to .env.local (gitignored). Server reads plain env; client reads VITE_* via Vite.
CONTACT=you@example.com
ADSB_SOURCE=replay            # adsblol | readsb | replay
MAX_RPS=1                     # adsb.lol ceiling; never raise above 1
READSB_URL=http://127.0.0.1:8042
READSB_COVERAGE=32.01,34.88,200
REPLAY_FILES=data/fixtures/*.jsonl
REPLAY_SPEED=1
RECORD_DIR=data/recordings
PORT=8787
SHOW_PIA_LADD=0
VITE_TERRAIN=ion              # ion | reearth | ellipsoid
VITE_IMAGERY=ion              # ion | eox
VITE_CESIUM_ION_TOKEN=
VITE_API_BASE=/api
```

- [ ] **Step 5: Verify the toolchain**

Run: `node --version && npx tsc --version`
Expected: `v24.2.0` or newer, and `Version 7.x`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore .env.example .planning
git commit -m "chore: scaffold repository (Node 24 native TS, node:test, Vite, Cesium)"
```

---

### Task 2: Contract types

**Files:**
- Create: `shared/types.ts`, `shared/api.ts`, `shared/airports.ts`, `server/sources/types.ts`, `client/types.ts`, `client/track/types.ts`, `tools/types.ts`

**Interfaces:**
- Consumes: nothing
- Produces: every cross-package type. Later packages import these names verbatim; renaming any of them is a contract change that needs `.planning/PLAN.md` updated first.

- [ ] **Step 1: Write the files exactly as below**

```ts
// shared/types.ts
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

```ts
// shared/api.ts
import type { Sample, SourceKind } from './types.ts'

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
}

export interface ChaseResponse {
  serverNowMs: number
  samples: Sample[]
  status: StatusBrief
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

```ts
// shared/airports.ts
/**
 * Airport data built by tools/build-airports.ts from OurAirports (public domain) + EGM96.
 * Heights named *HaeM are WGS84 ellipsoidal metres; *Ft are MSL feet as published.
 */
export interface RunwayEnd {
  ident: string
  lat: number            // physical runway end (OurAirports le_/he_ lat/lon)
  lon: number
  thrLat: number         // landing threshold: end moved along hdgTrueDeg by displacedFt
  thrLon: number
  displacedFt: number
  elevFt: number         // end elevation MSL ft; airport elevation when OurAirports leaves it blank
  hdgTrueDeg: number     // landing direction, true
  thrHaeM: number        // elevFt * 0.3048 + geoidN(thrLat, thrLon)
}

export interface Runway {
  lengthFt: number
  widthFt: number
  surface: string
  ends: [RunwayEnd, RunwayEnd]
}

export interface Airport {
  ident: string
  name: string
  lat: number
  lon: number
  elevFt: number
  nM: number
  runways: Runway[]
}
```

```ts
// server/sources/types.ts
import type { Snapshot, SourceKind } from '../../shared/types.ts'

export interface SourceCaps {
  kind: SourceKind
  fullSnapshot: boolean                    // true: all() returns everything the source knows
  maxRps: number                           // polite ceiling for this source
  coverage: { lat: number; lon: number; radiusNm: number } | null   // null = global
  attribution: string
}

export interface FetchResult {
  url: string
  status: number                           // HTTP status; 0 = network error / timeout
  tSendMs: number
  tRecvMs: number
  bytes: number                            // wire bytes (content-length when present, else body length)
  body: string                             // raw text, recorded verbatim ('' on error)
  retryAfterS: number | null
  snapshot: Snapshot | null                // non-null only when status 200 and body parsed
}

export interface Source {
  caps: SourceCaps
  circle(lat: number, lon: number, radiusNm: number): Promise<FetchResult>
  hexes(hexes: string[]): Promise<FetchResult>
  all(): Promise<FetchResult>              // rejects with Error('unsupported') when !caps.fullSnapshot
}
```

```ts
// client/types.ts
import type { Quality } from '../shared/types.ts'
import type { AltSource } from './track/types.ts'

/** What the scene draws for one aircraft at render time. Produced by Track.stateAt(). */
export interface RenderState {
  hex: string
  lat: number
  lon: number
  hM: number                                    // WGS84 ellipsoidal metres
  headingDeg: number                            // true, nose direction
  pitchDeg: number                              // nose-up positive
  rollDeg: number                               // right-wing-down positive
  gsKt: number | null
  trackDeg: number | null
  altBaroFt: number | null
  vsFpm: number | null
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
```

```ts
// client/track/types.ts
/** ENU kinematic point: t in seconds, e/n in metres, ve/vn in m/s. The origin is chosen by Track. */
export interface KinPoint {
  t: number
  e: number
  n: number
  ve: number
  vn: number
}

/** ENU position at time t (seconds). */
export interface PosT {
  t: number
  e: number
  n: number
}

/** Aircraft attitude. headingDeg true; pitch nose-up positive; roll right-wing-down positive. */
export interface Att {
  headingDeg: number
  pitchDeg: number
  rollDeg: number
}

export type Phase = 'ground' | 'takeoff' | 'climb' | 'cruise' | 'descent' | 'approach' | 'landing'

export type AltSource = 'geom' | 'baro-qnh' | 'baro-bias'
```

```ts
// tools/types.ts
/** One rendered frame in a local ENU frame, produced by tools/bench-track.ts and scored by tools/metrics.ts. */
export interface Frame {
  t: number                                     // seconds (render time, server clock)
  e: number                                     // metres
  n: number
  u: number
  mode: 'interp' | 'extrap' | 'stale'
  headingDeg: number
  pitchDeg: number
  rollDeg: number
}

/** A reported (sample-time) vertical rate, m/s, for vertical metrics. */
export interface RateAt {
  t: number
  vsMs: number
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add shared server client tools
git commit -m "feat(contract): shared data types for all work packages"
```

---

### Task 3: Golden fixtures

**Files:**
- Create: `data/fixtures/README.md`, `data/fixtures/golden/{adsblol-point-ksfo.json, adsblol-point-lowi.json, adsblol-hex.json, readsb-circle.json, recording-sample.jsonl, airports-sample.json}`

**Interfaces:**
- Produces: test inputs used by WP-00 and Wave 1 tests. Facts the tests rely on: `adsblol-point-ksfo.json` has `now = 1790081633500` and 7 aircraft (`71bd79` v2 at 40000 ft, `a0b88d` on ground, `~a330e6` non-ICAO, `000001` with `dbFlags: 8` (identity replaced: PIA/LADD aircraft are scrubbed to unallocated addresses 000001/000002)); `recording-sample.jsonl` has 4 lines with statuses `[200, 200, 429, 200]` yielding 65 deduped samples (63 with LADD hidden); `airports-sample.json` has KSFO, LLBG, LOWI with KSFO 28R `thrHaeM = -28.3` and LOWI 08 `thrHaeM = 629.72`.

- [ ] **Step 1: Copy the committed assets**

```bash
mkdir -p data/fixtures data/recordings
cp -R .planning/plans/assets/WP-00/golden data/fixtures/golden
cp .planning/plans/assets/WP-00/README.md data/fixtures/README.md
```

- [ ] **Step 2: Verify**

Run: `ls data/fixtures/golden && wc -l data/fixtures/golden/recording-sample.jsonl`
Expected: the six files listed above; `4 data/fixtures/golden/recording-sample.jsonl`.

- [ ] **Step 3: Commit**

```bash
git add data/fixtures
git commit -m "test: golden adsb.lol/readsb/airport fixtures (ODbL, public domain)"
```

---

### Task 4: Envelope normalizers

**Files:**
- Create: `shared/readsb.ts`, `shared/readsb.test.ts`
- Test: `shared/readsb.test.ts`

**Interfaces:**
- Consumes: `Snapshot` (Task 2), golden fixtures (Task 3)
- Produces: `normalizeAdsblol(body: string): Snapshot`, `normalizeReadsb(body: string): Snapshot`, `normalizers.{adsblol,readsb}`

- [ ] **Step 1: Write the failing test**

```ts
// shared/readsb.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeAdsblol, normalizeReadsb } from './readsb.ts'

const golden = (f: string): string => readFileSync(new URL(`../data/fixtures/golden/${f}`, import.meta.url), 'utf8')

test('adsb.lol envelope: now is ms, list key is ac', () => {
  const s = normalizeAdsblol(golden('adsblol-point-ksfo.json'))
  assert.equal(s.nowMs, 1790081633500)
  assert.equal(s.aircraft.length, 7)
  assert.equal(s.aircraft[0].hex, '71bd79')
})

test('adsb.lol ac:null means no aircraft', () => {
  assert.deepEqual(normalizeAdsblol('{"ac":null,"now":5,"msg":"No error"}'), { nowMs: 5, aircraft: [] })
})

test('readsb envelope: now is seconds, list key is aircraft', () => {
  const s = normalizeReadsb(golden('readsb-circle.json'))
  assert.equal(s.nowMs, 1790081633500)
  assert.equal(s.aircraft.length, 7)
})

test('same aircraft either way: the flip changes only the envelope', () => {
  assert.deepEqual(normalizeReadsb(golden('readsb-circle.json')), normalizeAdsblol(golden('adsblol-point-ksfo.json')))
})

test('wrong envelope is rejected, not silently empty', () => {
  assert.throws(() => normalizeAdsblol(golden('readsb-circle.json')))
  assert.throws(() => normalizeReadsb('{"ac":[],"now":1}'), /aircraft/)
  assert.throws(() => normalizeAdsblol('not json'))
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test shared/readsb.test.ts`
Expected: FAIL — Cannot find module ./readsb.ts

- [ ] **Step 3: Write the implementation**

```ts
// shared/readsb.ts
import type { Snapshot } from './types.ts'

// The only difference between adsb.lol v2 and a local readsb API is this envelope.
// Per-aircraft objects are identical readsb JSON.

/** adsb.lol /v2/*: { ac: [...] | null, now: <ms> } */
export function normalizeAdsblol(body: string): Snapshot {
  const j = JSON.parse(body)
  if (typeof j?.now !== 'number') throw new Error('not an adsb.lol v2 body: missing now')
  if (!('ac' in j) || (j.ac !== null && !Array.isArray(j.ac))) throw new Error('not an adsb.lol v2 body: no ac array')
  return { nowMs: j.now, aircraft: j.ac ?? [] }
}

/** readsb --net-api-port and aircraft.json: { aircraft: [...], now: <seconds, fractional> } */
export function normalizeReadsb(body: string): Snapshot {
  const j = JSON.parse(body)
  if (typeof j?.now !== 'number') throw new Error('not a readsb body: missing now')
  if (!('aircraft' in j) || (j.aircraft !== null && !Array.isArray(j.aircraft))) throw new Error('not a readsb body: no aircraft array')
  return { nowMs: Math.round(j.now * 1000), aircraft: j.aircraft ?? [] }
}

export const normalizers = {
  adsblol: normalizeAdsblol,
  readsb: normalizeReadsb,
} as const
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test shared/readsb.test.ts`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add shared/readsb.ts shared/readsb.test.ts
git commit -m "feat(shared): adsb.lol and readsb envelope normalizers"
```

---

### Task 5: Geoid and sample stamping

**Files:**
- Create: `shared/geoid.ts`, `shared/geoid.test.ts`, `shared/sample.ts`, `shared/sample.test.ts`
- Test: `shared/sample.test.ts`

**Interfaces:**
- Consumes: `ReadsbAircraft`, `Sample`, `Quality` (Task 2); `normalizeAdsblol` (Task 4)
- Produces: `geoidN(latDeg, lonDeg): number`; `classify(ac): Quality`; `isHidden(ac): boolean`; `toSample(ac, upstreamNowMs, offsetMs, rxMs): Sample | null`

- [ ] **Step 1: Write the failing tests** (geoid values are pinned against GeographicLib; this is the unit half of the datum gate)

```ts
// shared/geoid.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { egm96ToEllipsoid } from 'egm96-universal'
import { geoidN } from './geoid.ts'

// Pinned EGM96 values. Reference column: GeographicLib egm96-5 (review workflow wf_a83bb071-6da, TD1).
// This test is the datum gate's unit half: it catches sign, unit and omission errors that A2 could not.
const CASES: [string, number, number, number, number][] = [
  // name, lat, lon, expected (this library), GeographicLib reference
  ['origin', 0, 0, 17.16, 17.16],
  ['KSFO 28R end', 37.613538, -122.35716, -32.26, -32.18],
  ['LOWI 08 end', 47.2588005065918, 11.330900192260742, 48.46, 48.45],
  ['LLBG 12 end', 32.01470184326172, 34.86579895019531, 19.6, 19.6],
]

for (const [name, lat, lon, expected, reference] of CASES) {
  test(`N at ${name}`, () => {
    const n = geoidN(lat, lon)
    assert.ok(Math.abs(n - expected) < 0.05, `${name}: N=${n}, expected ${expected}`)
    assert.ok(Math.abs(n - reference) < 0.3, `${name}: N=${n}, reference ${reference}`)
  })
}

test('sign convention: h = H + N', () => {
  const [lat, lon, H] = [37.613538, -122.35716, 100]
  assert.ok(Math.abs(egm96ToEllipsoid(lat, lon, H) - (H + geoidN(lat, lon))) < 1e-9)
})
```

```ts
// shared/sample.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeAdsblol } from './readsb.ts'
import { classify, isHidden, toSample } from './sample.ts'
import type { ReadsbAircraft } from './types.ts'

const snap = normalizeAdsblol(readFileSync(new URL('../data/fixtures/golden/adsblol-point-ksfo.json', import.meta.url), 'utf8'))
const byHex = (h: string): ReadsbAircraft => snap.aircraft.find((a) => a.hex === h)!

test('tMs = upstream now − seen_pos + offset (never receipt time)', () => {
  const ac = byHex('71bd79')
  const s = toSample(ac, snap.nowMs, 250, 999)!
  assert.equal(s.tMs, snap.nowMs - Math.round(ac.seen_pos! * 1000) + 250)
  assert.equal(s.rxMs, 999)
  assert.equal(s.altBaroFt, 40000)
  assert.equal(s.onGround, false)
  assert.equal(s.quality, 'adsb2')
})

test('ground aircraft: onGround, no baro altitude', () => {
  const s = toSample(byHex('a0b88d'), snap.nowMs, 0, 0)!
  assert.equal(s.onGround, true)
  assert.equal(s.altBaroFt, null)
})

test('geoid N attached, rounded to 0.1 m (KSFO area ≈ −32 m)', () => {
  const s = toSample(byHex('a0b88d'), snap.nowMs, 0, 0)!
  assert.ok(s.nM < -31 && s.nM > -33, `nM=${s.nM}`)
  assert.equal(Math.round(s.nM * 10) / 10, s.nM)
})

test('non-ICAO hex kept and lowercased; strings trimmed', () => {
  const s = toSample(byHex('~a330e6'), snap.nowMs, 0, 0)!
  assert.equal(s.hex, '~a330e6')
  assert.equal(toSample({ ...byHex('71bd79'), hex: 'ABC123', flight: 'UAL1    ' }, 0, 0, 0)!.hex, 'abc123')
  assert.equal(toSample({ ...byHex('71bd79'), flight: 'UAL1    ' }, 0, 0, 0)!.callsign, 'UAL1')
})

test('no position → null', () => {
  assert.equal(toSample({ hex: 'abc123', alt_baro: 1000 }, 0, 0, 0), null)
  assert.equal(toSample({ hex: 'abc123', lat: 1, lon: 1 }, 0, 0, 0), null)
})

test('classify', () => {
  assert.equal(classify({ hex: 'a', type: 'adsb_icao', version: 2 }), 'adsb2')
  assert.equal(classify({ hex: 'a', type: 'adsb_icao', version: 0 }), 'adsb01')
  assert.equal(classify({ hex: 'a', type: 'adsr_icao' }), 'adsb01')
  assert.equal(classify({ hex: 'a', type: 'mlat' }), 'mlat')
  assert.equal(classify({ hex: 'a', type: 'adsb_icao', version: 2, mlat: ['lat', 'lon'] }), 'mlat')
  assert.equal(classify({ hex: 'a', type: 'adsb_icao', version: 2, mlat: ['track'] }), 'adsb2')
  assert.equal(classify({ hex: 'a', type: 'tisb_icao' }), 'other')
  assert.equal(classify({ hex: 'a', type: 'mode_s' }), 'other')
})

test('PIA (4) and LADD (8) are hidden; military (1) is not', () => {
  assert.equal(isHidden(byHex('000001')), true)   // dbFlags 8 in the golden file
  assert.equal(isHidden({ hex: 'a', dbFlags: 4 }), true)
  assert.equal(isHidden({ hex: 'a', dbFlags: 1 }), false)
  assert.equal(isHidden({ hex: 'a' }), false)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test shared/geoid.test.ts shared/sample.test.ts`
Expected: FAIL — Cannot find module ./sample.ts

- [ ] **Step 3: Write the implementation**

```ts
// shared/geoid.ts
import { meanSeaLevel } from 'egm96-universal'

/** EGM96 geoid undulation N in metres. Ellipsoidal height h = orthometric (MSL) height H + N. */
export function geoidN(latDeg: number, lonDeg: number): number {
  return meanSeaLevel(latDeg, lonDeg)
}
```

```ts
// shared/sample.ts
import { geoidN } from './geoid.ts'
import type { Quality, ReadsbAircraft, Sample } from './types.ts'

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s === '' ? null : s
}

/** Position-quality tier. MLAT wins over the message type because readsb marks MLAT-derived fields per field. */
export function classify(ac: ReadsbAircraft): Quality {
  if (ac.type === 'mlat' || ac.mlat?.includes('lat')) return 'mlat'
  if (ac.type?.startsWith('adsb') || ac.type?.startsWith('adsr')) return ac.version === 2 ? 'adsb2' : 'adsb01'
  return 'other'
}

/** PIA (dbFlags & 4) and LADD (dbFlags & 8) aircraft are hidden unless explicitly allowed. */
export function isHidden(ac: ReadsbAircraft): boolean {
  return ((ac.dbFlags ?? 0) & (4 | 8)) !== 0
}

/**
 * One readsb aircraft → one Sample stamped in SERVER clock.
 * tMs = upstreamNowMs − seen_pos (the position's own age in the upstream clock) + offsetMs (upstream → server clock).
 * Returns null when there is no current position.
 */
export function toSample(ac: ReadsbAircraft, upstreamNowMs: number, offsetMs: number, rxMs: number): Sample | null {
  const lat = num(ac.lat)
  const lon = num(ac.lon)
  const seenPos = num(ac.seen_pos)
  if (lat === null || lon === null || seenPos === null) return null
  const onGround = ac.alt_baro === 'ground'
  return {
    hex: ac.hex.toLowerCase(),
    tMs: upstreamNowMs - Math.round(seenPos * 1000) + offsetMs,
    rxMs,
    lat,
    lon,
    onGround,
    altBaroFt: onGround ? null : num(ac.alt_baro),
    altGeomFt: num(ac.alt_geom),
    gsKt: num(ac.gs),
    trackDeg: num(ac.track),
    trueHeadingDeg: num(ac.true_heading),
    rollDeg: num(ac.roll),
    baroRateFpm: num(ac.baro_rate),
    geomRateFpm: num(ac.geom_rate),
    navQnhHpa: num(ac.nav_qnh),
    version: num(ac.version),
    nic: num(ac.nic),
    quality: classify(ac),
    nM: Math.round(geoidN(lat, lon) * 10) / 10,
    callsign: str(ac.flight),
    typeCode: str(ac.t),
    reg: str(ac.r),
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test shared/geoid.test.ts shared/sample.test.ts`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add shared/geoid.ts shared/geoid.test.ts shared/sample.ts shared/sample.test.ts
git commit -m "feat(shared): EGM96 geoid and server-clock sample stamping"
```

---

### Task 6: Deduper and clock offset

**Files:**
- Create: `shared/dedupe.ts`, `shared/dedupe.test.ts`, `shared/clock.ts`, `shared/clock.test.ts`
- Test: `shared/dedupe.test.ts`

**Interfaces:**
- Consumes: `Sample` (Task 2)
- Produces: `class Deduper { accept(s: Sample): boolean; forget(hex: string): void }`; `class MinOffset { constructor(windowMs); update(localRecvMs, remoteNowMs); get ready(): boolean; get(): number }`

- [ ] **Step 1: Write the failing tests**

```ts
// shared/clock.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MinOffset } from './clock.ts'

test('offset is the minimum of recv − remote over the window', () => {
  const o = new MinOffset(60_000)
  o.update(10_150, 10_000)  // 150
  o.update(11_120, 11_000)  // 120
  o.update(12_300, 12_000)  // 300
  assert.equal(o.get(), 120)
})

test('old minima age out of the window', () => {
  const o = new MinOffset(1_000)
  o.update(10_050, 10_000)  // 50
  o.update(12_200, 12_000)  // 200, first is now 2150 ms old
  assert.equal(o.get(), 200)
})

test('get before any update throws; ready tells', () => {
  const o = new MinOffset(1000)
  assert.equal(o.ready, false)
  assert.throws(() => o.get())
  o.update(1, 0)
  assert.equal(o.ready, true)
})
```

```ts
// shared/dedupe.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Deduper } from './dedupe.ts'
import type { Sample } from './types.ts'

const s = (hex: string, tMs: number, lat = 1, lon = 2): Sample => ({
  hex, tMs, rxMs: 0, lat, lon, onGround: false, altBaroFt: null, altGeomFt: null, gsKt: null, trackDeg: null,
  trueHeadingDeg: null, rollDeg: null, baroRateFpm: null, geomRateFpm: null, navQnhHpa: null, version: 2, nic: 8,
  quality: 'adsb2', nM: 0, callsign: null, typeCode: null, reg: null,
})

test('first sample per hex is accepted', () => {
  assert.equal(new Deduper().accept(s('a', 1000)), true)
})

test('re-served position (same tMs within rounding) is rejected', () => {
  const d = new Deduper()
  d.accept(s('a', 1000))
  assert.equal(d.accept(s('a', 1003)), false)
  assert.equal(d.accept(s('a', 1000)), false)
})

test('older sample is rejected', () => {
  const d = new Deduper()
  d.accept(s('a', 1000))
  assert.equal(d.accept(s('a', 900, 5, 5)), false)
})

test('identical position < 100 ms later is rejected; a moved one is accepted', () => {
  const d = new Deduper()
  d.accept(s('a', 1000))
  assert.equal(d.accept(s('a', 1050)), false)
  assert.equal(d.accept(s('a', 1060, 1.0001, 2)), true)
})

test('new position ≥ 100 ms later is accepted even if identical (parked aircraft)', () => {
  const d = new Deduper()
  d.accept(s('a', 1000))
  assert.equal(d.accept(s('a', 1500)), true)
})

test('hexes are independent; forget resets', () => {
  const d = new Deduper()
  d.accept(s('a', 1000))
  assert.equal(d.accept(s('b', 1000)), true)
  d.forget('a')
  assert.equal(d.accept(s('a', 1000)), true)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test shared/dedupe.test.ts shared/clock.test.ts`
Expected: FAIL — Cannot find module ./dedupe.ts

- [ ] **Step 3: Write the implementation**

```ts
// shared/dedupe.ts
import type { Sample } from './types.ts'

/**
 * Drops re-served and out-of-order positions. adsb.lol often re-serves the same position;
 * its tMs then repeats within a few ms of rounding. Genuine ADS-B positions are ≥ ~500 ms apart.
 */
export class Deduper {
  #last = new Map<string, { tMs: number; lat: number; lon: number }>()

  accept(s: Sample): boolean {
    const p = this.#last.get(s.hex)
    if (p) {
      const dt = s.tMs - p.tMs
      if (dt <= 5) return false
      if (dt < 100 && s.lat === p.lat && s.lon === p.lon) return false
    }
    this.#last.set(s.hex, { tMs: s.tMs, lat: s.lat, lon: s.lon })
    return true
  }

  forget(hex: string): void {
    this.#last.delete(hex)
  }
}
```

```ts
// shared/clock.ts
/**
 * Windowed minimum of (localRecvMs − remoteNowMs) = remote→local clock offset + smallest one-way latency seen.
 * Add get() to a remote timestamp to express it in the local clock.
 */
export class MinOffset {
  #win: { t: number; v: number }[] = []
  #windowMs: number

  constructor(windowMs: number) {
    this.#windowMs = windowMs
  }

  update(localRecvMs: number, remoteNowMs: number): void {
    this.#win.push({ t: localRecvMs, v: localRecvMs - remoteNowMs })
    const cutoff = localRecvMs - this.#windowMs
    while (this.#win.length > 1 && this.#win[0].t < cutoff) this.#win.shift()
  }

  get ready(): boolean {
    return this.#win.length > 0
  }

  get(): number {
    if (this.#win.length === 0) throw new Error('MinOffset: no samples yet')
    let m = Infinity
    for (const x of this.#win) if (x.v < m) m = x.v
    return m
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test shared/dedupe.test.ts shared/clock.test.ts`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add shared/dedupe.ts shared/dedupe.test.ts shared/clock.ts shared/clock.test.ts
git commit -m "feat(shared): sample dedupe and windowed min clock offset"
```

---

### Task 7: Spherical geo helpers

**Files:**
- Create: `shared/geo.ts`, `shared/geo.test.ts`
- Test: `shared/geo.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `distanceNm(lat1, lon1, lat2, lon2): number`; `bearingDeg(lat1, lon1, lat2, lon2): number`; `destination(lat, lon, brgDeg, distNm): { lat; lon }`

- [ ] **Step 1: Write the failing test**

```ts
// shared/geo.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bearingDeg, destination, distanceNm } from './geo.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} ${msg}`)

test('one degree of latitude ≈ 60 nm', () => {
  near(distanceNm(0, 0, 1, 0), 60.04, 0.01)
})

test('KSFO → LLBG great-circle distance ≈ 6,437 nm', () => {
  near(distanceNm(37.6188, -122.3758, 32.0114, 34.8867), 6437, 5)
})

test('bearings: north, east, west', () => {
  near(bearingDeg(0, 0, 1, 0), 0, 1e-9)
  near(bearingDeg(0, 0, 0, 1), 90, 1e-9)
  near(bearingDeg(0, 0, 0, -1), 270, 1e-9)
})

test('destination round-trips distance and bearing', () => {
  const p = destination(37.6135, -122.3572, 298, 1.5)
  near(distanceNm(37.6135, -122.3572, p.lat, p.lon), 1.5, 1e-6)
  near(bearingDeg(37.6135, -122.3572, p.lat, p.lon), 298, 1e-6)
})

test('destination wraps longitude across the antimeridian', () => {
  const p = destination(0, 179.9, 90, 30)
  assert.ok(p.lon < -179, `lon=${p.lon}`)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test shared/geo.test.ts`
Expected: FAIL — Cannot find module ./geo.ts

- [ ] **Step 3: Write the implementation**

```ts
// shared/geo.ts
// Spherical-earth helpers for distances and bearings (≤ 0.5 % error — fine for cells, hop and runway offsets).
// Precise ellipsoidal ECEF/ENU math lives in shared/enu.ts.

const R_NM = 3440.065
const rad = (d: number): number => (d * Math.PI) / 180
const deg = (r: number): number => (r * 180) / Math.PI

export function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1)
  const dLon = rad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** Initial true bearing from point 1 to point 2, degrees in [0, 360). */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = rad(lat1)
  const φ2 = rad(lat2)
  const dλ = rad(lon2 - lon1)
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (deg(Math.atan2(y, x)) + 360) % 360
}

/** Point reached from (lat, lon) after distNm along initial true bearing brgDeg. */
export function destination(lat: number, lon: number, brgDeg: number, distNm: number): { lat: number; lon: number } {
  const δ = distNm / R_NM
  const θ = rad(brgDeg)
  const φ1 = rad(lat)
  const λ1 = rad(lon)
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return { lat: deg(φ2), lon: ((deg(λ2) + 540) % 360) - 180 }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test shared/geo.test.ts`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add shared/geo.ts shared/geo.test.ts
git commit -m "feat(shared): distance, bearing and destination helpers"
```

---

### Task 8: Recording format and causal replay to samples

**Files:**
- Create: `server/recording.ts`, `server/recording.test.ts`
- Test: `server/recording.test.ts`

**Interfaces:**
- Consumes: `normalizers` (Task 4), `toSample`/`isHidden` (Task 5), `Deduper`/`MinOffset` (Task 6)
- Produces: `interface RecordLine`; `parseRecordLine(line): RecordLine`; `readRecording(path): RecordLine[]`; `recordingToSamples(lines, { hideFlagged? }): Sample[]`

- [ ] **Step 1: Write the failing test**

```ts
// server/recording.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { parseRecordLine, readRecording, recordingToSamples } from './recording.ts'

const path = fileURLToPath(new URL('../data/fixtures/golden/recording-sample.jsonl', import.meta.url))

test('reads all record lines, including non-200', () => {
  const lines = readRecording(path)
  assert.equal(lines.length, 4)
  assert.deepEqual(lines.map((l) => l.status), [200, 200, 429, 200])
})

test('re-served poll adds nothing; 429 skipped; second real poll adds only moved aircraft', () => {
  // 40 positions in poll 1; poll 2 is a re-serve (0 new); 429 has no body; poll 3 has 25 new positions.
  assert.equal(recordingToSamples(readRecording(path), { hideFlagged: false }).length, 40 + 25)
})

test('LADD/PIA aircraft are hidden by default (000002 has dbFlags 8 in both real polls)', () => {
  const samples = recordingToSamples(readRecording(path))
  assert.equal(samples.length, 40 + 25 - 2)
  assert.ok(!samples.some((s) => s.hex === '000002'))
})

test('stamps in the recording clock: offset = min(tRecv − now) so far', () => {
  const lines = readRecording(path)
  const first = JSON.parse(lines[0].body)
  const ac = first.ac.find((a: { lat?: number }) => a.lat !== undefined)
  const s = recordingToSamples([lines[0]]).find((x) => x.hex === ac.hex)!
  assert.equal(s.tMs, first.now - Math.round(ac.seen_pos * 1000) + (lines[0].tRecvMs - first.now))
  assert.equal(s.rxMs, lines[0].tRecvMs)
})

test('rejects lines that are not v1 records', () => {
  assert.throws(() => parseRecordLine('{"v":2}'))
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test server/recording.test.ts`
Expected: FAIL — Cannot find module ./recording.ts

- [ ] **Step 3: Write the implementation**

```ts
// server/recording.ts
import { readFileSync } from 'node:fs'
import { MinOffset } from '../shared/clock.ts'
import { Deduper } from '../shared/dedupe.ts'
import { normalizers } from '../shared/readsb.ts'
import { isHidden, toSample } from '../shared/sample.ts'
import type { Sample } from '../shared/types.ts'

/** One upstream poll, recorded verbatim. Written by server/recorder.ts and tools/record-cells.ts. */
export interface RecordLine {
  v: 1
  source: 'adsblol' | 'readsb'
  url: string
  status: number
  tSendMs: number
  tRecvMs: number
  bytes: number
  body: string
}

export function parseRecordLine(line: string): RecordLine {
  const r = JSON.parse(line)
  if (r?.v !== 1 || (r.source !== 'adsblol' && r.source !== 'readsb')) throw new Error('not a v1 record line')
  return r as RecordLine
}

export function readRecording(path: string): RecordLine[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map(parseRecordLine)
}

/**
 * Causal conversion of recorded polls to deduped samples, in recording (arrival) order.
 * Server clock = the recording machine's clock: offset is the windowed min of (tRecvMs − upstream now),
 * updated with each line BEFORE that line's samples are stamped. rxMs = tRecvMs.
 */
export function recordingToSamples(lines: RecordLine[], opts: { hideFlagged?: boolean } = {}): Sample[] {
  const hideFlagged = opts.hideFlagged ?? true
  const offset = new MinOffset(10 * 60_000)
  const dedupe = new Deduper()
  const out: Sample[] = []
  for (const line of lines) {
    if (line.status !== 200 || line.body === '') continue
    const snap = normalizers[line.source](line.body)
    offset.update(line.tRecvMs, snap.nowMs)
    for (const ac of snap.aircraft) {
      if (hideFlagged && isHidden(ac)) continue
      const s = toSample(ac, snap.nowMs, offset.get(), line.tRecvMs)
      if (s && dedupe.accept(s)) out.push(s)
    }
  }
  return out
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test server/recording.test.ts`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add server/recording.ts server/recording.test.ts
git commit -m "feat(server): recording line format and causal recording→samples"
```

---

### Task 9: Day-1 fixture recorder

**Files:**
- Create: `tools/record-cells.ts`, `tools/record-cells.test.ts`
- Test: `tools/record-cells.test.ts`

**Interfaces:**
- Consumes: `RecordLine` (Task 8)
- Produces: `nextInterval(currentMs, baseMs, status, retryAfterS): number | "stop"`; `nextBase(baseMs, status): number`; CLI `npm run record:cells` writing `data/recordings/YYYY-MM-DD.jsonl`

- [ ] **Step 1: Write the failing test**

```ts
// tools/record-cells.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextBase, nextInterval } from './record-cells.ts'

test('401/403 stop for good', () => {
  assert.equal(nextInterval(2000, 2000, 403, null), 'stop')
  assert.equal(nextInterval(2000, 2000, 401, null), 'stop')
})

test('429 doubles and honours Retry-After (default 30 s)', () => {
  assert.equal(nextInterval(2000, 2000, 429, null), 30_000)
  assert.equal(nextInterval(40_000, 2000, 429, 5), 80_000)
  assert.equal(nextInterval(2000, 2000, 429, 120), 120_000)
})

test('5xx / network error doubles, capped at 5 min', () => {
  assert.equal(nextInterval(2000, 2000, 503, null), 4000)
  assert.equal(nextInterval(200_000, 2000, 0, null), 300_000)
})

test('success recovers toward base, never below 1 s', () => {
  assert.equal(nextInterval(10_000, 2000, 200, null), 9000)
  assert.equal(nextInterval(2000, 2000, 200, null), 2000)
  assert.equal(nextInterval(1000, 500, 200, null), 1000)
})

test('a 429 doubles the base for the rest of the run; nothing else changes it', () => {
  assert.equal(nextBase(2000, 429), 4000)
  assert.equal(nextBase(4000, 200), 4000)
  assert.equal(nextBase(4000, 503), 4000)
  assert.equal(nextBase(200_000, 429), 300_000)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tools/record-cells.test.ts`
Expected: FAIL — Cannot find module ./record-cells.ts

- [ ] **Step 3: Write the implementation**

```ts
// tools/record-cells.ts
// Early fixture collector: polls a small circle around each hero airport on adsb.lol, round-robin,
// and appends every raw response to data/recordings/YYYY-MM-DD.jsonl in the RecordLine format.
// ponytail: standalone on purpose so recording starts on day 1; tools/record-arrivals.ts replaces it after M1b.
//
//   CONTACT=you@example.com node tools/record-cells.ts [--interval-ms 3000] [--radius-nm 40] [--heroes KSFO,LLBG,LOWI]
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { RecordLine } from '../server/recording.ts'

export const HEROES: Record<string, { lat: number; lon: number }> = {
  KSFO: { lat: 37.6188, lon: -122.3758 },
  LLBG: { lat: 32.0114, lon: 34.8867 },
  LOWI: { lat: 47.2602, lon: 11.3439 },
}

const MIN_INTERVAL_MS = 1000 // never faster than 1 req/s total
const MAX_INTERVAL_MS = 5 * 60_000

/** Next request interval after a response. 'stop' on 401/403: never retry a block. */
export function nextInterval(currentMs: number, baseMs: number, status: number, retryAfterS: number | null): number | 'stop' {
  if (status === 401 || status === 403) return 'stop'
  if (status === 429) return Math.min(MAX_INTERVAL_MS, Math.max(currentMs * 2, (retryAfterS ?? 30) * 1000))
  if (status === 0 || status >= 500) return Math.min(MAX_INTERVAL_MS, currentMs * 2)
  // success: recover 10 % per request toward the base interval
  return Math.max(baseMs, Math.max(MIN_INTERVAL_MS, Math.round(currentMs * 0.9)))
}

/** A 429 permanently halves the rate for this run: never climb back to a rate that was refused. */
export function nextBase(baseMs: number, status: number): number {
  return status === 429 ? Math.min(MAX_INTERVAL_MS, baseMs * 2) : baseMs
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'interval-ms': { type: 'string', default: '3000' },
      'radius-nm': { type: 'string', default: '40' },
      heroes: { type: 'string', default: 'KSFO,LLBG,LOWI' },
      out: { type: 'string', default: 'data/recordings' },
    },
  })
  const contact = process.env.CONTACT
  if (!contact) throw new Error('Set CONTACT (e.g. in .env.local); it goes into the User-Agent.')
  let baseMs = Math.max(MIN_INTERVAL_MS, Number(values['interval-ms']))
  const radius = Number(values['radius-nm'])
  const heroes = values.heroes.split(',').map((id) => ({ id, ...HEROES[id] }))
  if (heroes.some((h) => h.lat === undefined)) throw new Error(`unknown hero in ${values.heroes}`)
  mkdirSync(values.out, { recursive: true })

  let interval = baseMs
  for (let i = 0; ; i++) {
    const h = heroes[i % heroes.length]
    const url = `https://api.adsb.lol/v2/point/${h.lat}/${h.lon}/${radius}`
    const tSendMs = Date.now()
    let status = 0
    let body = ''
    let bytes = 0
    let retryAfterS: number | null = null
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': `FlightHopper/0.1 (+${contact})`, 'Accept-Encoding': 'gzip' },
        signal: AbortSignal.timeout(10_000),
      })
      status = res.status
      body = await res.text()
      bytes = Number(res.headers.get('content-length') ?? Buffer.byteLength(body))
      const ra = res.headers.get('retry-after')
      retryAfterS = ra !== null && Number.isFinite(Number(ra)) ? Number(ra) : null
    } catch {
      status = 0
    }
    const line: RecordLine = { v: 1, source: 'adsblol', url, status, tSendMs, tRecvMs: Date.now(), bytes, body: status === 200 ? body : '' }
    appendFileSync(join(values.out, `${new Date(tSendMs).toISOString().slice(0, 10)}.jsonl`), JSON.stringify(line) + '\n')
    baseMs = nextBase(baseMs, status)
    const next = nextInterval(interval, baseMs, status, retryAfterS)
    if (next === 'stop') {
      console.error(`HTTP ${status} from ${url}: blocked. Stopping; do not retry automatically.`)
      process.exit(1)
    }
    if (status !== 200) console.error(`${new Date().toISOString()} HTTP ${status} ${h.id}; next in ${next} ms`)
    interval = next
    await new Promise((r) => setTimeout(r, interval))
  }
}

if (import.meta.main) await main()
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tools/record-cells.test.ts`
Expected: PASS, 0 failures.

- [ ] **Step 5: Start recording now and leave it running**

Put your contact in `.env.local` (`CONTACT=you@example.com`), then:

```bash
nohup npm run record:cells > data/recordings/record-cells.log 2>&1 &
sleep 20 && tail -c 300 data/recordings/$(date -u +%F).jsonl
```

Expected: at least one line with `"status":200`. It polls KSFO, LLBG and LOWI (40 nm) round-robin every 3 s ≈ 0.33 req/s. A 429 doubles the interval for the rest of the run and it never climbs back (adsb.lol returned a 429 at 0.5 req/s on 2026-09-22). While it runs, any live `adsblol` server run must use `MAX_RPS=0.5` so the total stays ≤ 1 req/s. Stop it with `pkill -f record-cells` when WP-E4's `record-arrivals` takes over.

- [ ] **Step 6: Commit**

```bash
git add tools/record-cells.ts tools/record-cells.test.ts
git commit -m "feat(tools): day-1 hero-airport recorder (0.5 req/s, stops on 403)"
```

---

### Task 10: Vite + Cesium client build

**Files:**
- Create: `vite.config.ts`, `index.html`, `client/main.ts` (placeholder; WP-F2 replaces it)

**Interfaces:**
- Consumes: nothing
- Produces: `npm run dev` serves `index.html` and any `harness/*.html` page (Wave 1 scene packages add their own harness pages; Vite serves them without config changes). Cesium static files at `/cesiumStatic`. `/api` proxied to `http://127.0.0.1:8787`.

- [ ] **Step 1: Write the files**

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// Cesium needs its Workers/Assets/Widgets/ThirdParty served as static files at CESIUM_BASE_URL.
const cesiumSource = 'node_modules/cesium/Build/Cesium'
const cesiumBaseUrl = 'cesiumStatic'

export default defineConfig({
  define: { CESIUM_BASE_URL: JSON.stringify(`/${cesiumBaseUrl}`) },
  plugins: [
    viteStaticCopy({
      targets: ['ThirdParty', 'Workers', 'Assets', 'Widgets'].map((d) => ({ src: `${cesiumSource}/${d}`, dest: cesiumBaseUrl, rename: { stripBase: 4 } })),
    }),
  ],
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
})
```

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>FlightHopper</title>
    <style>
      html, body, #globe { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
    </style>
  </head>
  <body>
    <div id="globe"></div>
    <script type="module" src="/client/main.ts"></script>
  </body>
</html>
```

```ts
// client/main.ts
// Placeholder owned by WP-00 until WP-F2 replaces it: proves the Vite + Cesium setup renders a globe.
import { EllipsoidTerrainProvider, Viewer } from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'

const viewer = new Viewer('globe', {
  terrainProvider: new EllipsoidTerrainProvider(),
  baseLayer: false,
  baseLayerPicker: false,
  geocoder: false,
  timeline: false,
  animation: false,
})
;(window as unknown as { viewer: Viewer }).viewer = viewer
```

- [ ] **Step 2: Verify the production build**

Run: `npx vite build && ls dist/cesiumStatic && rm -rf dist`
Expected: `✓ built`, then `Assets  ThirdParty  Widgets  Workers` (a chunk-size warning is expected and harmless).

- [ ] **Step 3: Verify it renders**

Run: `npm run dev -- --port 5173`, open `http://localhost:5173/`.
Expected: a blue globe on black (no imagery yet), no console errors, and `window.viewer.scene.globe.tilesLoaded === true` in the console after a few seconds. Stop the server.

- [ ] **Step 4: Commit**

```bash
git add vite.config.ts index.html client/main.ts
git commit -m "feat(client): Vite + Cesium build with static assets and /api proxy"
```

---

### Task 11: Wave 0 gate

- [ ] **Step 1: Full check**

Run: `npm run check`
Expected: `tsc` silent; `ℹ tests 41`, `ℹ pass 41`, `ℹ fail 0`.

- [ ] **Step 2: Tag**

```bash
git tag wave-0
```

Wave 1 work packages branch from `wave-0`.

# WP-I3 — Arrival Recorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the day-1 cell recorder with one that finds aircraft landing at the hero airports and follows them with a batched hex poll, all inside one polite request budget, and draft the courtesy note to adsb.lol.

**Architecture:** One file, `tools/record-arrivals.ts`, in three layers. `pickArrivals(samples, heroes)` is pure: the latest sample of each hex decides whether it is landing at a hero. `arrivalLoop(opts)` is the scheduler with an injected `Source`, clock and `TokenBucket`. Each `step()` sends at most one request: a hero cell (a 40 nm `/v2/point` circle, every 6 s) or the arrival batch (`/v2/hex` of the picked hexes, every 1 s), whichever is most overdue relative to its period. Answers go to the bucket, the `Recorder`, and through `MinOffset` + `toSample` into a `SampleStore`, which feeds the next `pickArrivals`. The CLI wires `makeAdsblol` (S1), `TokenBucket` (S3), `Recorder` (S2) and `SampleStore` (S4) and exits on a block. Requests are spaced at least `1/maxRps` apart, and every 429 doubles that spacing for the rest of the run. The day-1 recorder does the same: never climb back to a rate the upstream refused.

**Tech Stack:** Node ≥ 24.2 (native TypeScript), `node:test`, `node:util` `parseArgs`, `node:http` + `node:child_process` (CLI smoke test only). No new dependencies.

**Wave:** 2 (needs S1, S2, S3 and S4 merged — S4 for `SampleStore`). **Estimated:** 1.5 h plus the switch-over. **Validated:** on 2026-09-22 in the shared sandbox (Node v25.2.1, TypeScript 7.0.2) with WP-00 and the S1–S4 code. Task 1's test failed with `ERR_MODULE_NOT_FOUND`, then passed 8/8 with Task 1's implementation. Task 2's test failed against Task 1's implementation with `does not provide an export named 'arrivalLoop'`, then passed 16/16 with the final file. That includes a CLI smoke test that spawns the real CLI against a local fake adsb.lol on port 0 and checks the User-Agent, the recording and exit 1 on 403. Both stages ran in a separate copy of the sandbox. `tsc --noEmit` reported nothing for these files at either stage, and the whole sandbox gave 412/412 tests with `tsc` silent. The three CLI argument guards were run by hand. None of this sent a request to adsb.lol. Every code block in this plan was extracted and compared byte for byte with the tested files.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. The ones that matter most for this package:
- **Upstream politeness:** ≤ 1 req/s from all processes together, `User-Agent: FlightHopper/0.1 (+${CONTACT})`, `Accept-Encoding: gzip` (both from `makeAdsblol`). A 429 halves the rate and honours `Retry-After`; 401/403 stops the process with no retry. Never probe for the failure rate.
- **Tests never touch the network:** the loop tests use a fake `Source`; the CLI smoke test uses a local `node:http` server on port 0.
- **Privacy:** PIA/LADD aircraft (`dbFlags & 12`) are never followed. Their raw lines stay in the recording as the upstream served them, exactly as the day-1 recorder does.
- Erasable TypeScript only, `.ts` import extensions, `if (import.meta.main)` for the CLI.

## Upstream reality check (read before starting the recorder)

The day-1 recorder (`tools/record-cells.ts`, 40 nm `/v2/point` circles round-robin) logged this on 2026-09-22 between 14:40 and 15:03 UTC. It got HTTP 429 three times: at 14:40:48 (the 4th request, 2.1 s after the one before), at 14:43:04 (3.1 s after) and at 14:47:07 (7.2 s after). Its spacing then settled at 12.2 s, and it ran clean for 70 requests in a row (about 15 minutes). The adsb.lol API description (`github.com/adsblol/api`, `src/adsb_api/app.py`) says its rate limits "are dynamic based on the environment load", and that a client which gets 4xx errors is doing something wrong. So the PLAN's 1 req/s is a ceiling, not a working rate. The switch-over below starts this recorder at `--max-rps 0.08` (12.5 s spacing), a little slower than the 12.2 s that ran clean. At that rate the scheduler follows each arrival about every 22 s and polls each hero cell about every 86 s (simulated). At `--max-rps 1` it would be 1.8 s and 7 s. Raise the rate only after an hour with no 429, or after adsb.lol answers the courtesy note.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `tools/record-arrivals.ts` | `pickArrivals`, `HEROES`, `arrivalLoop`, CLI |
| `tools/record-arrivals.test.ts` | pickArrivals cases, fake-clock loop tests, CLI smoke test |
| `.planning/reports/adsblol-note.md` | courtesy email draft; the user sends it |

---

### Task 1: pickArrivals

**Files:**
- Create: `tools/record-arrivals.ts`, `tools/record-arrivals.test.ts`
- Test: `tools/record-arrivals.test.ts`

**Interfaces:**
- Consumes: `Sample` (`shared/types.ts`), `distanceNm` and (test only) `destination` (`shared/geo.ts`), all WP-00.
- Produces (locked, PLAN.md §4 I3): `pickArrivals(samples: Sample[], heroes: { ident; lat; lon; elevFt }[]): string[]`. Extra exports: `interface Hero { ident: string; lat: number; lon: number; elevFt: number }` and `HEROES: Hero[]` (KSFO, LLBG, LOWI with OurAirports reference points and field elevations 13, 135 and 1,907 ft, the same values as `data/fixtures/golden/airports-sample.json`).

Rule, applied to the latest sample (largest `tMs`) of each hex, each hex listed once, in first-seen order:
- within 25 nm of a hero, **and**
- either airborne, below 10,000 ft **above that hero's field** (`(altBaroFt ?? altGeomFt) − elevFt < 10000`), and descending faster than 300 fpm (`(baroRateFpm ?? geomRateFpm) < −300`),
- or on the ground and rolling faster than 30 kt (`gsKt > 30`).

The field elevation is why `elevFt` is in the signature. At KSFO (13 ft) this is the PLAN's "< 10,000 ft". At LOWI (field 1,907 ft) the limit is 11,907 ft MSL.

- [ ] **Step 1: Write the failing test**

```ts
// tools/record-arrivals.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { destination } from '../shared/geo.ts'
import type { Sample } from '../shared/types.ts'
import { HEROES, pickArrivals, type Hero } from './record-arrivals.ts'

const hero = (ident: string): Hero => HEROES.find((h) => h.ident === ident)!
const KSFO = hero('KSFO')
const LOWI = hero('LOWI')

/** A sample `nm` from the hero on bearing 120°, descending through 3,000 ft unless overridden. */
function smp(hex: string, h: Hero, nm: number, over: Partial<Sample> = {}): Sample {
  const p = destination(h.lat, h.lon, 120, nm)
  return {
    hex, tMs: 1000, rxMs: 1000, lat: p.lat, lon: p.lon, onGround: false, altBaroFt: 3000, altGeomFt: null, gsKt: 160,
    trackDeg: 300, trueHeadingDeg: null, rollDeg: null, baroRateFpm: -800, geomRateFpm: null, navQnhHpa: null,
    version: 2, nic: 8, quality: 'adsb2', nM: 0, callsign: null, typeCode: null, reg: null, ...over,
  }
}

test('pickArrivals: low, descending, within 25 nm of a hero', () => {
  assert.deepEqual(pickArrivals([smp('a00001', KSFO, 10)], HEROES), ['a00001'])
  assert.deepEqual(pickArrivals([smp('a00002', KSFO, 24.5)], HEROES), ['a00002'])
  assert.deepEqual(pickArrivals([smp('a00003', KSFO, 26)], HEROES), [])
})

test('pickArrivals: below 10,000 ft above the field', () => {
  assert.deepEqual(pickArrivals([smp('a00001', KSFO, 10, { altBaroFt: 10_500 })], HEROES), [])
  assert.deepEqual(pickArrivals([smp('a00002', KSFO, 10, { altBaroFt: 9900 })], HEROES), ['a00002'])
  // LOWI's field is at 1,907 ft: 11,000 ft MSL in the Inn valley is 9,093 ft above it
  assert.deepEqual(pickArrivals([smp('a00003', LOWI, 15, { altBaroFt: 11_000 })], HEROES), ['a00003'])
  assert.deepEqual(pickArrivals([smp('a00004', LOWI, 15, { altBaroFt: 12_000 })], HEROES), [])
})

test('pickArrivals: must be descending faster than 300 fpm (baro rate, else geometric rate)', () => {
  assert.deepEqual(pickArrivals([smp('a00001', KSFO, 10, { baroRateFpm: -200 })], HEROES), [])
  assert.deepEqual(pickArrivals([smp('a00002', KSFO, 10, { baroRateFpm: 1500 })], HEROES), [])
  assert.deepEqual(pickArrivals([smp('a00003', KSFO, 10, { baroRateFpm: null, geomRateFpm: -704 })], HEROES), ['a00003'])
  assert.deepEqual(pickArrivals([smp('a00004', KSFO, 10, { baroRateFpm: null })], HEROES), [])
})

test('pickArrivals: no baro altitude falls back to geometric altitude', () => {
  assert.deepEqual(pickArrivals([smp('a00001', KSFO, 10, { altBaroFt: null, altGeomFt: 2500 })], HEROES), ['a00001'])
  assert.deepEqual(pickArrivals([smp('a00002', KSFO, 10, { altBaroFt: null })], HEROES), [])
})

test('pickArrivals: on the ground only while rolling faster than 30 kt', () => {
  const ground = { onGround: true, altBaroFt: null, baroRateFpm: null }
  assert.deepEqual(pickArrivals([smp('a00001', KSFO, 0.5, { ...ground, gsKt: 120 })], HEROES), ['a00001'])
  assert.deepEqual(pickArrivals([smp('a00002', KSFO, 0.5, { ...ground, gsKt: 12 })], HEROES), [])
  assert.deepEqual(pickArrivals([smp('a00003', KSFO, 0.5, { ...ground, gsKt: null })], HEROES), [])
})

test('pickArrivals: the latest sample of each hex decides, whatever the array order', () => {
  const landed = smp('a00001', KSFO, 0.5, { tMs: 9000, onGround: true, altBaroFt: null, baroRateFpm: null, gsKt: 15 })
  const approach = smp('a00001', KSFO, 8, { tMs: 5000 })
  assert.deepEqual(pickArrivals([landed, approach], HEROES), [])
  assert.deepEqual(pickArrivals([approach, landed], HEROES), [])
  const later = smp('a00002', KSFO, 8, { tMs: 9000 })
  const climbing = smp('a00002', KSFO, 4, { tMs: 5000, baroRateFpm: 2000 })
  assert.deepEqual(pickArrivals([later, climbing], HEROES), ['a00002'])
})

test('pickArrivals: one entry per hex even when near two heroes', () => {
  const twin: Hero = { ident: 'TWIN', lat: KSFO.lat + 0.1, lon: KSFO.lon, elevFt: 0 }
  assert.deepEqual(pickArrivals([smp('a00001', KSFO, 5), smp('a00001', KSFO, 5)], [KSFO, twin]), ['a00001'])
})

test('HEROES: the three hero airports with field elevations', () => {
  assert.deepEqual(HEROES.map((h) => h.ident), ['KSFO', 'LLBG', 'LOWI'])
  assert.deepEqual(HEROES.map((h) => h.elevFt), [13, 135, 1907])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tools/record-arrivals.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/tools/record-arrivals.ts' imported from …/tools/record-arrivals.test.ts`

- [ ] **Step 3: Write the implementation**

```ts
// tools/record-arrivals.ts
// Arrival recorder (replaces tools/record-cells.ts). Task 1: which aircraft are landing at a hero airport.
import { distanceNm } from '../shared/geo.ts'
import type { Sample } from '../shared/types.ts'

export interface Hero {
  ident: string
  lat: number
  lon: number
  elevFt: number
}

/** Airport reference points and field elevations from OurAirports (data/fixtures/golden/airports-sample.json). */
export const HEROES: Hero[] = [
  { ident: 'KSFO', lat: 37.619806, lon: -122.374821, elevFt: 13 },
  { ident: 'LLBG', lat: 32.011398, lon: 34.8867, elevFt: 135 },
  { ident: 'LOWI', lat: 47.260201, lon: 11.344, elevFt: 1907 },
]

const PICK_NM = 25
const MAX_ABOVE_FIELD_FT = 10_000
const DESCENT_FPM = -300
const ROLL_KT = 30

/**
 * Hexes worth following to the runway. Per hex only its latest sample (largest tMs) counts: within 25 nm of a
 * hero, and either airborne below 10,000 ft above that field and descending faster than 300 fpm (baro rate, else
 * geometric rate; baro altitude, else geometric), or on the ground rolling faster than 30 kt (landing roll).
 */
export function pickArrivals(samples: Sample[], heroes: { ident: string; lat: number; lon: number; elevFt: number }[]): string[] {
  const latest = new Map<string, Sample>()
  for (const s of samples) {
    const p = latest.get(s.hex)
    if (!p || s.tMs > p.tMs) latest.set(s.hex, s)
  }
  const out: string[] = []
  for (const s of latest.values()) {
    const alt = s.altBaroFt ?? s.altGeomFt
    const rate = s.baroRateFpm ?? s.geomRateFpm
    const near = heroes.filter((h) => distanceNm(h.lat, h.lon, s.lat, s.lon) <= PICK_NM)
    const rolling = s.onGround && (s.gsKt ?? 0) > ROLL_KT
    const descending = !s.onGround && rate !== null && rate < DESCENT_FPM && alt !== null && near.some((h) => alt - h.elevFt < MAX_ABOVE_FIELD_FT)
    if (near.length > 0 && (rolling || descending)) out.push(s.hex)
  }
  return out
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tools/record-arrivals.test.ts`
Expected: PASS — `ℹ tests 8`, `ℹ pass 8`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add tools/record-arrivals.ts tools/record-arrivals.test.ts
git commit -m "feat(tools): pickArrivals finds aircraft landing at the hero airports" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Polling loop and CLI

**Files:**
- Modify: `tools/record-arrivals.ts`, `tools/record-arrivals.test.ts` (complete new contents below)
- Test: `tools/record-arrivals.test.ts`

**Interfaces:**
- Consumes: `makeAdsblol({ userAgent, baseUrl? })` (WP-S1, `server/sources/adsblol.ts`); `TokenBucket` (WP-S3: `tryTake`, `onResult`, `state().maxRps`, `degraded`); `Recorder` (WP-S2: `write(kind, r)`); `SampleStore` (WP-S4: `add`, `view(lat, lon, nm, 0)`, `prune`); `Source`, `FetchResult` (`server/sources/types.ts`), `MinOffset` (`shared/clock.ts`), `toSample`, `isHidden` (`shared/sample.ts`), `readRecording` (`server/recording.ts`, test only), `normalizeAdsblol` (test only) — WP-00.
- Produces: `interface ArrivalLoopOpts { source: Source; bucket: TokenBucket; store: SampleStore; recorder: Recorder | null; heroes: Hero[]; radiusNm?: number; cellPeriodMs?: number; hexPeriodMs?: number; nowMs?: () => number; log?: (line: string) => void }` and `arrivalLoop(o: ArrivalLoopOpts): { step(): Promise<'sent' | 'idle' | 'blocked'>; picked(): string[] }` (defaults 40 nm, 6000 ms, 1000 ms, `Date.now`, `console.log`). CLI: `node tools/record-arrivals.ts [--max-rps 0.08] [--heroes KSFO,LLBG,LOWI] [--radius-nm 40] [--cell-period-ms 6000] [--hex-period-ms 1000] [--out data/recordings]` with `CONTACT` from the environment. `--max-rps` must be in (0, 1]. There is also a hidden `--base-url` for the smoke test.

| `step()` | Behaviour |
|---|---|
| blocked | `bucket.degraded === 'blocked'` (after a 401/403) → `'blocked'`, no request; the CLI then exits 1 |
| picking | `store.prune(now)`; `pickArrivals` over `store.view(hero, 25 nm, 0)` of every hero; a change in the picked list is logged |
| spacing | `now − lastSend < gap` → `'idle'`. The gap starts at `1000 / maxRps` and doubles (max 5 min) on every 429, for the rest of the run |
| choice | overdue = `(now − last) / period` for the batch (only while something is picked) and each hero cell. The largest overdue ≥ 1 goes, the batch winning ties, if `bucket.tryTake()`. So under a short budget every job slows by the same factor |
| answer | `bucket.onResult`; `recorder.write(caps.kind, r)`; non-200 logged; a snapshot → `MinOffset(10 min)`, `toSample` → `store.add`, PIA/LADD skipped |

- [ ] **Step 1: Write the failing test (complete file; Task 1's tests are unchanged at the top)**

```ts
// tools/record-arrivals.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TokenBucket } from '../server/budget.ts'
import { Recorder } from '../server/recorder.ts'
import { readRecording } from '../server/recording.ts'
import type { FetchResult, Source } from '../server/sources/types.ts'
import { SampleStore } from '../server/store.ts'
import { destination, distanceNm } from '../shared/geo.ts'
import { normalizeAdsblol } from '../shared/readsb.ts'
import type { ReadsbAircraft, Sample } from '../shared/types.ts'
import { arrivalLoop, HEROES, pickArrivals, type Hero } from './record-arrivals.ts'

const hero = (ident: string): Hero => HEROES.find((h) => h.ident === ident)!
const KSFO = hero('KSFO')
const LOWI = hero('LOWI')

/** A sample `nm` from the hero on bearing 120°, descending through 3,000 ft unless overridden. */
function smp(hex: string, h: Hero, nm: number, over: Partial<Sample> = {}): Sample {
  const p = destination(h.lat, h.lon, 120, nm)
  return {
    hex, tMs: 1000, rxMs: 1000, lat: p.lat, lon: p.lon, onGround: false, altBaroFt: 3000, altGeomFt: null, gsKt: 160,
    trackDeg: 300, trueHeadingDeg: null, rollDeg: null, baroRateFpm: -800, geomRateFpm: null, navQnhHpa: null,
    version: 2, nic: 8, quality: 'adsb2', nM: 0, callsign: null, typeCode: null, reg: null, ...over,
  }
}

test('pickArrivals: low, descending, within 25 nm of a hero', () => {
  assert.deepEqual(pickArrivals([smp('a00001', KSFO, 10)], HEROES), ['a00001'])
  assert.deepEqual(pickArrivals([smp('a00002', KSFO, 24.5)], HEROES), ['a00002'])
  assert.deepEqual(pickArrivals([smp('a00003', KSFO, 26)], HEROES), [])
})

test('pickArrivals: below 10,000 ft above the field', () => {
  assert.deepEqual(pickArrivals([smp('a00001', KSFO, 10, { altBaroFt: 10_500 })], HEROES), [])
  assert.deepEqual(pickArrivals([smp('a00002', KSFO, 10, { altBaroFt: 9900 })], HEROES), ['a00002'])
  // LOWI's field is at 1,907 ft: 11,000 ft MSL in the Inn valley is 9,093 ft above it
  assert.deepEqual(pickArrivals([smp('a00003', LOWI, 15, { altBaroFt: 11_000 })], HEROES), ['a00003'])
  assert.deepEqual(pickArrivals([smp('a00004', LOWI, 15, { altBaroFt: 12_000 })], HEROES), [])
})

test('pickArrivals: must be descending faster than 300 fpm (baro rate, else geometric rate)', () => {
  assert.deepEqual(pickArrivals([smp('a00001', KSFO, 10, { baroRateFpm: -200 })], HEROES), [])
  assert.deepEqual(pickArrivals([smp('a00002', KSFO, 10, { baroRateFpm: 1500 })], HEROES), [])
  assert.deepEqual(pickArrivals([smp('a00003', KSFO, 10, { baroRateFpm: null, geomRateFpm: -704 })], HEROES), ['a00003'])
  assert.deepEqual(pickArrivals([smp('a00004', KSFO, 10, { baroRateFpm: null })], HEROES), [])
})

test('pickArrivals: no baro altitude falls back to geometric altitude', () => {
  assert.deepEqual(pickArrivals([smp('a00001', KSFO, 10, { altBaroFt: null, altGeomFt: 2500 })], HEROES), ['a00001'])
  assert.deepEqual(pickArrivals([smp('a00002', KSFO, 10, { altBaroFt: null })], HEROES), [])
})

test('pickArrivals: on the ground only while rolling faster than 30 kt', () => {
  const ground = { onGround: true, altBaroFt: null, baroRateFpm: null }
  assert.deepEqual(pickArrivals([smp('a00001', KSFO, 0.5, { ...ground, gsKt: 120 })], HEROES), ['a00001'])
  assert.deepEqual(pickArrivals([smp('a00002', KSFO, 0.5, { ...ground, gsKt: 12 })], HEROES), [])
  assert.deepEqual(pickArrivals([smp('a00003', KSFO, 0.5, { ...ground, gsKt: null })], HEROES), [])
})

test('pickArrivals: the latest sample of each hex decides, whatever the array order', () => {
  const landed = smp('a00001', KSFO, 0.5, { tMs: 9000, onGround: true, altBaroFt: null, baroRateFpm: null, gsKt: 15 })
  const approach = smp('a00001', KSFO, 8, { tMs: 5000 })
  assert.deepEqual(pickArrivals([landed, approach], HEROES), [])
  assert.deepEqual(pickArrivals([approach, landed], HEROES), [])
  const later = smp('a00002', KSFO, 8, { tMs: 9000 })
  const climbing = smp('a00002', KSFO, 4, { tMs: 5000, baroRateFpm: 2000 })
  assert.deepEqual(pickArrivals([later, climbing], HEROES), ['a00002'])
})

test('pickArrivals: one entry per hex even when near two heroes', () => {
  const twin: Hero = { ident: 'TWIN', lat: KSFO.lat + 0.1, lon: KSFO.lon, elevFt: 0 }
  assert.deepEqual(pickArrivals([smp('a00001', KSFO, 5), smp('a00001', KSFO, 5)], [KSFO, twin]), ['a00001'])
})

test('HEROES: the three hero airports with field elevations', () => {
  assert.deepEqual(HEROES.map((h) => h.ident), ['KSFO', 'LLBG', 'LOWI'])
  assert.deepEqual(HEROES.map((h) => h.elevFt), [13, 135, 1907])
})

// ---- the polling loop, driven by a fake adsb.lol and a fake clock ----

interface Call {
  t: number
  m: 'circle' | 'hexes'
  args: unknown[]
}

/** Aircraft seen by the fake upstream. seen_pos 0: the positions are current at every poll. */
function aircraft(hex: string, h: Hero, nm: number, over: Partial<ReadsbAircraft> = {}): ReadsbAircraft {
  const p = destination(h.lat, h.lon, 120, nm)
  return { hex, type: 'adsb_icao', version: 2, lat: p.lat, lon: p.lon, alt_baro: 3000, gs: 160, baro_rate: -800, seen_pos: 0, ...over }
}

function fakeAdsblol(clock: { t: number }, world: ReadsbAircraft[]) {
  const calls: Call[] = []
  const replies: { status: number; retryAfterS?: number }[] = []
  const reply = (m: Call['m'], args: unknown[], ac: ReadsbAircraft[]): Promise<FetchResult> => {
    calls.push({ t: clock.t, m, args })
    const { status, retryAfterS } = replies.shift() ?? { status: 200 }
    const body = status === 200 ? JSON.stringify({ ac, msg: 'No error', now: clock.t - 250 }) : ''
    return Promise.resolve({
      url: `fake:${m}`, status, tSendMs: clock.t, tRecvMs: clock.t, bytes: body.length, body,
      retryAfterS: retryAfterS ?? null, snapshot: status === 200 ? normalizeAdsblol(body) : null,
    })
  }
  const source: Source = {
    caps: { kind: 'adsblol', fullSnapshot: false, maxRps: 1, coverage: null, attribution: 'test' },
    circle: (lat, lon, nm) => reply('circle', [lat, lon, nm], world.filter((a) => distanceNm(lat, lon, a.lat!, a.lon!) <= nm)),
    hexes: (hexes) => reply('hexes', [hexes], world.filter((a) => hexes.includes(a.hex))),
    all: () => Promise.reject(new Error('unsupported')),
  }
  return { source, calls, replies }
}

const T0 = 1_790_000_000_000

function setup(o: { world?: ReadsbAircraft[]; maxRps?: number; recorder?: Recorder } = {}) {
  const clock = { t: T0 }
  const f = fakeAdsblol(clock, o.world ?? [])
  const bucket = new TokenBucket(o.maxRps ?? 10, () => clock.t, () => 0)
  const logs: string[] = []
  const loop = arrivalLoop({
    source: f.source, bucket, store: new SampleStore(), recorder: o.recorder ?? null, heroes: HEROES,
    nowMs: () => clock.t, log: (l) => logs.push(l),
  })
  return { clock, bucket, loop, logs, ...f }
}

/** Steps every 100 ms up to and including T0 + untilMs; returns the step results. */
async function runUntil(s: ReturnType<typeof setup>, untilMs: number): Promise<string[]> {
  const out: string[] = []
  for (; s.clock.t <= T0 + untilMs; s.clock.t += 100) out.push(await s.loop.step())
  return out
}

const rel = (calls: Call[], m?: Call['m']): number[] => calls.filter((c) => m === undefined || c.m === m).map((c) => c.t - T0)

test('loop: hero cells round-robin, each every 6 s at 40 nm; no hex batch without arrivals', async () => {
  const s = setup()
  await runUntil(s, 12_500)
  assert.deepEqual(rel(s.calls), [0, 100, 200, 6000, 6100, 6200, 12_000, 12_100, 12_200])
  assert.deepEqual(s.calls.slice(0, 3).map((c) => c.args), HEROES.map((h) => [h.lat, h.lon, 40]))
  assert.deepEqual(s.loop.picked(), [])
})

test('loop: an arrival seen in a cell is followed with a batched hex poll every second', async () => {
  const world = [
    aircraft('a00001', KSFO, 12), // arriving
    aircraft('a00002', KSFO, 12, { baro_rate: 2500 }), // departing
    aircraft('a00003', KSFO, 30, { alt_baro: 35_000, baro_rate: 0 }), // cruising overhead
    aircraft('a00004', LOWI, 10, { alt_baro: 8000 }), // arriving at LOWI
  ]
  const s = setup({ world })
  await runUntil(s, 5000)
  // KSFO cell at 0 finds a00001 → hex batch at 100; LLBG, LOWI cells next; then a00001 + a00004 every second
  assert.deepEqual(s.calls.slice(0, 4).map((c) => [c.t - T0, c.m]), [[0, 'circle'], [100, 'hexes'], [200, 'circle'], [300, 'circle']])
  assert.deepEqual(s.calls[1].args, [['a00001']])
  assert.deepEqual(rel(s.calls, 'hexes'), [100, 1100, 2100, 3100, 4100])
  assert.deepEqual(s.calls[4].args, [['a00001', 'a00004']])
  assert.deepEqual(s.loop.picked(), ['a00001', 'a00004'])
  assert.ok(s.logs.some((l) => l.includes('a00001')), s.logs.join('\n'))
})

test('loop: LADD/PIA aircraft are never followed', async () => {
  const s = setup({ world: [aircraft('000001', KSFO, 12, { dbFlags: 8 })] })
  await runUntil(s, 3000)
  assert.deepEqual(rel(s.calls, 'hexes'), [])
  assert.deepEqual(s.loop.picked(), [])
})

test('loop: never more than --max-rps, even when cells and arrivals want more', async () => {
  const s = setup({ world: [aircraft('a00001', KSFO, 12)], maxRps: 1 })
  await runUntil(s, 120_000)
  assert.ok(s.calls.length <= 121, `${s.calls.length} requests in 120 s`)
  for (let i = 1; i < s.calls.length; i++) assert.ok(s.calls[i].t - s.calls[i - 1].t >= 1000, 'one request per second at most')
  // both kinds keep flowing: the earliest-due request goes first
  assert.ok(rel(s.calls, 'hexes').length >= 60)
  for (const h of HEROES) assert.ok(s.calls.filter((c) => c.m === 'circle' && c.args[0] === h.lat).length >= 12, h.ident)
})

test('loop: a 429 pauses for Retry-After and permanently doubles the spacing', async () => {
  const s = setup({ maxRps: 1 })
  s.replies.push({ status: 429, retryAfterS: 3 })
  await runUntil(s, 12_000)
  assert.deepEqual(rel(s.calls), [0, 3000, 5000, 7000, 9000, 11_000])
  assert.equal(s.bucket.state().counts.r429, 1)
  assert.ok(s.logs.some((l) => l.includes('429')), s.logs.join('\n'))
})

test('loop: 401/403 means blocked: one request, then stop', async () => {
  const s = setup()
  s.replies.push({ status: 403 })
  const results = await runUntil(s, 10_000)
  assert.equal(s.calls.length, 1)
  assert.equal(results[0], 'sent')
  assert.ok(results.slice(1).every((r) => r === 'blocked'))
})

test('loop: every response is recorded, failures included', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fh-arrivals-'))
  const s = setup({ world: [aircraft('a00001', KSFO, 12)], recorder: new Recorder(dir) })
  s.replies.push({ status: 200 }, { status: 503 })
  await runUntil(s, 4000)
  const files = readdirSync(dir)
  assert.equal(files.length, 1)
  const lines = readRecording(join(dir, files[0]))
  assert.equal(lines.length, s.calls.length)
  assert.deepEqual(lines.slice(0, 2).map((l) => l.status), [200, 503])
  assert.equal(lines[1].body, '')
  assert.ok(lines.every((l) => l.source === 'adsblol'))
})

test('CLI: polls a local fake adsb.lol with our User-Agent, records it, exits 1 on 403', async () => {
  const seen: { url: string; ua: string | undefined }[] = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', ua: req.headers['user-agent'] })
    if (seen.length >= 2) return void res.writeHead(403).end('forbidden')
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ac: [], msg: 'No error', now: Date.now() }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const dir = mkdtempSync(join(tmpdir(), 'fh-arrivals-cli-'))
  const cli = fileURLToPath(new URL('./record-arrivals.ts', import.meta.url))
  const child = spawn(process.execPath, [cli, '--base-url', base, '--max-rps', '1', '--out', dir], {
    env: { ...process.env, CONTACT: 'test@example.invalid' },
  })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  const timer = setTimeout(() => child.kill(), 10_000)
  const [code] = await once(child, 'exit')
  clearTimeout(timer)
  server.close()
  assert.equal(code, 1, stderr)
  assert.match(stderr, /blocked/)
  assert.deepEqual(seen.map((x) => x.url), ['/v2/point/37.6198/-122.3748/40', '/v2/point/32.0114/34.8867/40'])
  assert.ok(seen.every((x) => x.ua === 'FlightHopper/0.1 (+test@example.invalid)'))
  const lines = readRecording(join(dir, readdirSync(dir)[0]))
  assert.deepEqual(lines.map((l) => [l.status, l.url]), [[200, `${base}/v2/point/37.6198/-122.3748/40`], [403, `${base}/v2/point/32.0114/34.8867/40`]])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tools/record-arrivals.test.ts`
Expected: FAIL — `SyntaxError: The requested module './record-arrivals.ts' does not provide an export named 'arrivalLoop'`

- [ ] **Step 3: Write the implementation (complete file)**

```ts
// tools/record-arrivals.ts
// Arrival recorder (replaces tools/record-cells.ts): polls a 40 nm circle around each hero airport on adsb.lol,
// round-robin, and follows every aircraft that is landing there with one batched /v2/hex poll per second, all
// under one TokenBucket. Every raw response goes to data/recordings/YYYY-MM-DD.jsonl (RecordLine format).
//
//   CONTACT=you@example.com node tools/record-arrivals.ts [--max-rps 0.08] [--heroes KSFO,LLBG,LOWI] [--radius-nm 40]
//     [--cell-period-ms 6000] [--hex-period-ms 1000] [--out data/recordings]
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { TokenBucket } from '../server/budget.ts'
import { Recorder } from '../server/recorder.ts'
import { makeAdsblol } from '../server/sources/adsblol.ts'
import type { FetchResult, Source } from '../server/sources/types.ts'
import { SampleStore } from '../server/store.ts'
import { MinOffset } from '../shared/clock.ts'
import { distanceNm } from '../shared/geo.ts'
import { isHidden, toSample } from '../shared/sample.ts'
import type { Sample } from '../shared/types.ts'

export interface Hero {
  ident: string
  lat: number
  lon: number
  elevFt: number
}

/** Airport reference points and field elevations from OurAirports (data/fixtures/golden/airports-sample.json). */
export const HEROES: Hero[] = [
  { ident: 'KSFO', lat: 37.619806, lon: -122.374821, elevFt: 13 },
  { ident: 'LLBG', lat: 32.011398, lon: 34.8867, elevFt: 135 },
  { ident: 'LOWI', lat: 47.260201, lon: 11.344, elevFt: 1907 },
]

const PICK_NM = 25
const MAX_ABOVE_FIELD_FT = 10_000
const DESCENT_FPM = -300
const ROLL_KT = 30
const MAX_HEXES = 100 // server/sources/adsblol.ts batch limit
const MAX_GAP_MS = 5 * 60_000

/**
 * Hexes worth following to the runway. Per hex only its latest sample (largest tMs) counts: within 25 nm of a
 * hero, and either airborne below 10,000 ft above that field and descending faster than 300 fpm (baro rate, else
 * geometric rate; baro altitude, else geometric), or on the ground rolling faster than 30 kt (landing roll).
 */
export function pickArrivals(samples: Sample[], heroes: { ident: string; lat: number; lon: number; elevFt: number }[]): string[] {
  const latest = new Map<string, Sample>()
  for (const s of samples) {
    const p = latest.get(s.hex)
    if (!p || s.tMs > p.tMs) latest.set(s.hex, s)
  }
  const out: string[] = []
  for (const s of latest.values()) {
    const alt = s.altBaroFt ?? s.altGeomFt
    const rate = s.baroRateFpm ?? s.geomRateFpm
    const near = heroes.filter((h) => distanceNm(h.lat, h.lon, s.lat, s.lon) <= PICK_NM)
    const rolling = s.onGround && (s.gsKt ?? 0) > ROLL_KT
    const descending = !s.onGround && rate !== null && rate < DESCENT_FPM && alt !== null && near.some((h) => alt - h.elevFt < MAX_ABOVE_FIELD_FT)
    if (near.length > 0 && (rolling || descending)) out.push(s.hex)
  }
  return out
}

export interface ArrivalLoopOpts {
  source: Source
  bucket: TokenBucket
  store: SampleStore
  recorder: Recorder | null
  heroes: Hero[]
  radiusNm?: number
  cellPeriodMs?: number
  hexPeriodMs?: number
  nowMs?: () => number
  log?: (line: string) => void
}

/**
 * The recorder's scheduler. step() sends at most one request: of the hero cells (each due cellPeriodMs after its
 * last poll) and the arrival batch (due hexPeriodMs after its last poll, only while pickArrivals finds any), the
 * most overdue goes first, the batch winning ties. Requests are spaced ≥ 1/maxRps apart; every 429 doubles that
 * spacing for the rest of the run (never climb back to a rate that was refused), on top of the bucket's own
 * Retry-After pause. 'blocked' after a 401/403: the caller must stop.
 */
export function arrivalLoop(o: ArrivalLoopOpts): { step(): Promise<'sent' | 'idle' | 'blocked'>; picked(): string[] } {
  const radiusNm = o.radiusNm ?? 40
  const cellPeriodMs = o.cellPeriodMs ?? 6000
  const hexPeriodMs = o.hexPeriodMs ?? 1000
  const nowMs = o.nowMs ?? Date.now
  const log = o.log ?? console.log
  const offset = new MinOffset(10 * 60_000)
  const lastCellMs = o.heroes.map(() => -Infinity)
  let lastHexMs = -Infinity
  let lastSendMs = -Infinity
  let gapMs = 1000 / o.bucket.state().maxRps
  let picked: string[] = []

  function ingest(r: FetchResult): void {
    o.bucket.onResult(r.status, r.retryAfterS)
    if (r.status === 429) gapMs = Math.min(MAX_GAP_MS, gapMs * 2)
    o.recorder?.write(o.source.caps.kind, r)
    if (r.status !== 200) log(`${new Date(nowMs()).toISOString()} HTTP ${r.status} ${r.url}; spacing ${gapMs} ms`)
    const snap = r.snapshot
    if (snap === null) return
    offset.update(r.tRecvMs, snap.nowMs)
    for (const ac of snap.aircraft) {
      if (isHidden(ac)) continue // never follow PIA/LADD aircraft (their raw lines are still recorded as served)
      const s = toSample(ac, snap.nowMs, offset.get(), r.tRecvMs)
      if (s) o.store.add(s)
    }
  }

  async function step(): Promise<'sent' | 'idle' | 'blocked'> {
    if (o.bucket.degraded === 'blocked') return 'blocked'
    const now = nowMs()
    o.store.prune(now)
    const next = pickArrivals(o.heroes.flatMap((h) => o.store.view(h.lat, h.lon, PICK_NM, 0)), o.heroes)
    if (next.join() !== picked.join()) log(`${new Date(now).toISOString()} following ${next.length}: ${next.join(' ')}`)
    picked = next
    if (now - lastSendMs < gapMs) return 'idle'
    // overdue = time since the last poll in periods; ≥ 1 is due. The most overdue goes first, so when the budget
    // is short every job slows by the same factor and the 1 s : 6 s proportion holds.
    let most = picked.length > 0 ? (now - lastHexMs) / hexPeriodMs : 0
    let cell = -1 // -1: the arrival batch
    for (let i = 0; i < o.heroes.length; i++) {
      const overdue = (now - lastCellMs[i]) / cellPeriodMs
      if (overdue > most) {
        most = overdue
        cell = i
      }
    }
    if (most < 1 || !o.bucket.tryTake()) return 'idle'
    lastSendMs = now
    if (cell === -1) {
      lastHexMs = now
      ingest(await o.source.hexes(picked.slice(0, MAX_HEXES)))
    } else {
      lastCellMs[cell] = now
      const h = o.heroes[cell]
      ingest(await o.source.circle(h.lat, h.lon, radiusNm))
    }
    return 'sent'
  }

  return { step, picked: () => picked }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'max-rps': { type: 'string', default: '0.08' },
      heroes: { type: 'string', default: 'KSFO,LLBG,LOWI' },
      'radius-nm': { type: 'string', default: '40' },
      'cell-period-ms': { type: 'string', default: '6000' },
      'hex-period-ms': { type: 'string', default: '1000' },
      out: { type: 'string', default: 'data/recordings' },
      'base-url': { type: 'string' }, // hidden: tests point the CLI at a local fake adsb.lol
    },
  })
  const contact = process.env.CONTACT
  if (!contact) throw new Error('Set CONTACT (e.g. in .env.local); it goes into the User-Agent.')
  const maxRps = Number(values['max-rps'])
  if (!(maxRps > 0 && maxRps <= 1)) throw new Error('--max-rps must be in (0, 1]: adsb.lol gets at most 1 req/s from all our processes')
  const heroes = values.heroes.split(',').map((id) => {
    const h = HEROES.find((x) => x.ident === id)
    if (!h) throw new Error(`unknown hero ${id}; known: ${HEROES.map((x) => x.ident).join(',')}`)
    return h
  })
  const bucket = new TokenBucket(maxRps)
  const loop = arrivalLoop({
    source: makeAdsblol({ userAgent: `FlightHopper/0.1 (+${contact})`, baseUrl: values['base-url'] }),
    bucket,
    store: new SampleStore(),
    recorder: new Recorder(values.out),
    heroes,
    radiusNm: Number(values['radius-nm']),
    cellPeriodMs: Number(values['cell-period-ms']),
    hexPeriodMs: Number(values['hex-period-ms']),
  })
  console.log(`record-arrivals: ${values.heroes} at ${values['radius-nm']} nm, ≤ ${maxRps} req/s → ${values.out}`)
  let summaryAt = Date.now() + 60_000
  for (;;) {
    const r = await loop.step()
    if (r === 'blocked') {
      console.error('HTTP 401/403 from adsb.lol: blocked. Stopping; do not retry automatically.')
      process.exit(1)
    }
    if (Date.now() >= summaryAt) {
      const s = bucket.state()
      console.log(`${new Date().toISOString()} ok ${s.counts.ok} 429 ${s.counts.r429} 5xx ${s.counts.r5xx} err ${s.counts.err} rps ${s.rps.toFixed(3)} following ${loop.picked().length}`)
      summaryAt += 60_000
    }
    if (r === 'idle') await sleep(100)
  }
}

if (import.meta.main) await main()
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tools/record-arrivals.test.ts`
Expected: PASS — `ℹ tests 16`, `ℹ pass 16`, `ℹ fail 0`. The CLI smoke test takes ≈ 1.2 s (two requests 1 s apart); the rest take milliseconds.

- [ ] **Step 5: Check the argument guards (no network: each fails before a source exists)**

Run: `CONTACT=test@example.invalid node tools/record-arrivals.ts --max-rps 2`
Expected: exit 1, `Error: --max-rps must be in (0, 1]: adsb.lol gets at most 1 req/s from all our processes`

Run: `CONTACT=test@example.invalid node tools/record-arrivals.ts --heroes KSFO,EGLL`
Expected: exit 1, `Error: unknown hero EGLL; known: KSFO,LLBG,LOWI`

Run: `env -u CONTACT node tools/record-arrivals.ts`
Expected: exit 1, `Error: Set CONTACT (e.g. in .env.local); it goes into the User-Agent.`

- [ ] **Step 6: Commit**

```bash
git add tools/record-arrivals.ts tools/record-arrivals.test.ts
git commit -m "feat(tools): arrival recorder loop and CLI under one token bucket" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Courtesy note to adsb.lol

**Files:**
- Create: `.planning/reports/adsblol-note.md`

**Interfaces:**
- Consumes: facts from this package and WP-S1: the endpoints, the User-Agent format and the attribution string `adsb.lol (ODbL 1.0)`.
- Produces: an email draft. The user sends it (PLAN.md §0 A4). No agent sends anything. The address `info@adsb.lol` is the public email of the adsb.lol GitHub organisation (`api.github.com/orgs/adsblol` → `"email": "info@adsb.lol"`, `"blog": "https://adsb.lol"`, read 2026-09-22). adsb.lol itself was not opened, because all of this project's adsb.lol traffic belongs to the recorder.

- [ ] **Step 1: Write the note**

```markdown
<!-- .planning/reports/adsblol-note.md -->
# Courtesy note to adsb.lol (draft)

You send this yourself, from the address in `CONTACT` (`.env.local`). Nothing in this project sends it.

- **To:** `info@adsb.lol`. This is the public email of the adsb.lol GitHub organisation (github.com/adsblol, read through api.github.com/orgs/adsblol on 2026-09-22). adsb.lol itself was not opened, because all of this project's adsb.lol traffic belongs to the recorder.
- **Subject:** FlightHopper, a small personal project using api.adsb.lol

---

Hi,

I am building FlightHopper, a personal, non-commercial 3D flight viewer (CesiumJS) for myself and a few friends. It reads your public API, and I want to stay well inside what you are comfortable with.

- **Endpoints:** `/v2/point/{lat}/{lon}/{radius}` (40 nm circles around KSFO, LLBG and LOWI, and circles of at most 250 nm around the area a viewer is looking at, only while someone looks), and batched `/v2/hex/{hex1,hex2,…}` (at most 100 hexes) for the aircraft being followed.
- **Identification:** every request sends `User-Agent: FlightHopper/0.1 (+CONTACT)`, where CONTACT is the address I am writing from, and `Accept-Encoding: gzip`.
- **Rate:** about one request every 12 s (≈ 0.08 req/s) in total, from all my processes together. Your API answered 429 when my first recorder polled every 2–7 s, so that is where it settled. On a 429 my code slows down, honours Retry-After and never speeds back up; on 401 or 403 it stops and does not retry.
- **Question:** what sustained rate is acceptable for a single personal client like this? I would rather ask than find out by testing your limits.
- **Attribution:** the app shows "adsb.lol (ODbL 1.0)" on screen. Recordings stay on my machine, except small test fixtures, which carry the ODbL notice.
- **Feeding:** I am setting up my own ADS-B receiver (readsb) and will feed adsb.lol with it soon.

If you prefer a different rate or other endpoints, or want me to use a key once I feed, tell me and I will change it.

Thank you for running adsb.lol.

Best regards,
```

- [ ] **Step 2: Check it**

Run: `grep -c 'info@adsb.lol' .planning/reports/adsblol-note.md`
Expected: `1`.

- [ ] **Step 3: Commit**

```bash
git add .planning/reports/adsblol-note.md
git commit -m "docs: courtesy note draft for adsb.lol" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: WP gate

- [ ] **Step 1: All tests of this package**

Run: `node --test tools/record-arrivals.test.ts`
Expected: `ℹ tests 16`, `ℹ pass 16`, `ℹ fail 0`.

- [ ] **Step 2: Type-check, filtered to this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E '^tools/record-arrivals'`
Expected: no output (grep exit status 1).

- [ ] **Step 3: Full check in the worktree**

Run: `npm run check`
Expected: `tsc` silent; `ℹ fail 0` (the test count is WP-00 + the merged Wave 1 packages + 16).

- [ ] **Step 4: Nothing left uncommitted**

Run: `git status --short`
Expected: no output. The branch is ready to merge (PLAN.md §5 step 4).

---

## After the merge: switch the recorder (on `main`, in the main checkout)

Do this once this branch is merged, from the repository root of the main checkout, not from the worktree. The recording must stay in the main checkout's `data/recordings/`, and the worktree is deleted after the merge. `tools/record-cells.ts` stays in the repository (WP-00 owns it); only its process stops.

- [ ] **Step 1: Stop the day-1 recorder and start this one**

```bash
pkill -f record-cells
sleep 1
nohup node --env-file-if-exists=.env.local tools/record-arrivals.ts --max-rps 0.08 >> data/recordings/record-arrivals.log 2>&1 &
sleep 60
pgrep -fl record-cells
tail -5 data/recordings/record-arrivals.log
tail -c 400 data/recordings/$(date -u +%F).jsonl
```

Expected: `pgrep` prints nothing. The log starts with `record-arrivals: KSFO,LLBG,LOWI at 40 nm, ≤ 0.08 req/s → data/recordings`, and a `following N: …` line appears once an arrival is found. The JSONL ends with lines that have `"status":200` and a URL under `https://api.adsb.lol/v2/point/` (and `/v2/hex/` once something is followed). About 5 new lines per minute.

- [ ] **Step 2: Watch it for an hour**

Run: `grep -c '"status":429' data/recordings/$(date -u +%F).jsonl; grep -E 'HTTP (429|401|403)' data/recordings/record-arrivals.log | tail -3`
Run it right after the switch and again an hour later (use the next day's file after 00:00 UTC).
Expected: the same 429 count both times, and no new `HTTP 429` log line. After any 429 the spacing doubles on its own and stays doubled; a restart resets it to `--max-rps`. A 401/403 stops the process with `blocked. Stopping; do not retry automatically.` Then do not restart it. Tell the user and send the courtesy note first.

- [ ] **Step 3: Budget rule while it runs**

The recorder and any live `ADSB_SOURCE=adsblol` server share one budget. Before a live server run (e.g. Gate G1), stop the recorder (`pkill -f record-arrivals`), or give each process half of a rate that has been proven clean. Never let the sum go above what has run clean.

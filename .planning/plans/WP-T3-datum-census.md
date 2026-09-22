# WP-T3 — Datum & Census Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The two G2 analyses that decide whether `alt_geom` can be trusted and which airports can be landing heroes. The **datum check** tests whether ADS-B v2 `alt_geom` sits on the 3° glidepath as WGS84 ellipsoidal height: `|median residual| ≤ 10 m` over ≥ 3 v2 arrivals. The **coverage census** asks whether ≥ 80 % of arrivals are tracked below 200 ft above the airport, and also reports gaps, `alt_geom` share, `nic < 6` share and position jumps. Both are pure functions plus two CLIs over recordings that write `.planning/reports/`.

**Architecture:** Four files.
- `tools/analysis/datum.ts` holds `alongCross`, which gives distance before a threshold and signed lateral offset from the extended centreline using `shared/geo` (spherical; it is only used within 12 nm). `approachResiduals` keeps airborne samples with `alt_geom` that are 0.3–2 nm before the threshold, ≤ 100 m off the centreline and tracking within 30° of the landing heading. For each it computes `r = altGeomFt·0.3048 − (thrHaeM + 15 + d·tan 3°)`. The heading check keeps reciprocal-runway departures out: KSFO 28L/R departures climb straight through the 10L/R approach windows. `summarizeDatum` uses v2 residuals only. An arrival is a distinct hex pass, split on gaps > 10 min. The median is pooled; it is `NaN` with no v2 data. `pass = arrivals ≥ minArrivals (3) && |median| ≤ 10 m`. v0/v1 residuals are still returned with their version, so the CLI can report them as flagged.
- `tools/analysis/census.ts` measures height above the airport with `aglFt`. It returns 0 on the ground. Otherwise it uses v2 `alt_geom` minus the airport HAE (`elevFt + nM/0.3048`), else baro corrected with the aircraft's own `nav_qnh` (950–1050 hPa, < 18,000 ft), else raw baro minus field elevation. This follows the client's AltitudeLadder (WP-C4) order: raw pressure altitude is off by 27 ft per hPa of weather, too coarse for a 200 ft test. `findArrivals` keeps samples ≤ 15 nm from the airport and splits each hex into visits on gaps > 10 min. A visit holds an arrival when a sample is established on final: airborne, ≤ 5,000 ft AGL, ≤ 12 nm before a threshold, ≤ 1 nm off its centreline, track within 30° of the landing heading. The arrival runs from the last ground sample before that point to the first ground sample after it (touchdown), so a later departure in the same visit is not mixed in. Per arrival it reports:
  - `minAglFt`
  - `reachedGround`
  - `p90GapBelow1000S`: p90 of airborne sample gaps with an end below 1,000 ft
  - `geomShare`
  - `badNicShare` (`nic < 6`)
  - `jumps`: pairs > 0.25 nm apart whose implied speed exceeds 1.5 × reported gs; a lone false position counts twice

  `summarizeCensus` returns mean percentages, the p90 of the per-arrival gap p90s, and `landingHeroOk = arrivals > 0 && trackedBelow200Pct ≥ 80`.
- `tools/datum-check.ts` is the datum CLI plus the input loader both CLIs share. `loadInputs` parses `--recordings <files…>` (quoted globs are expanded with `fs.globSync`; shell-expanded files arrive as positionals), `--airports`, `--airport` and `--out`. `samplesNear` streams the recordings line by line with `parseRecordLine` and decodes them with `recordingToSamples` in 2,000-line chunks. Each chunk is re-decoded behind the previous 10 min of lines, so the clock offset and dedupe state match one single pass (tested at chunk sizes 1 and 3). `readRecording` cannot be used here: it reads a whole file into one string, V8's maximum is 536,870,888 characters, and one KSFO 40 nm poll records as about 18 KB, so a 0.5 req/s day file is about 0.8 GB.
- `tools/census.ts` is the census CLI.

Each CLI prints a `console.table` summary, writes `<out>/{datum,census}-<ICAO>-<UTC date>.json` and sets exit code 1 on FAIL / not a landing hero.

**Tech Stack:** Node ≥ 24.2 (native TypeScript; `fs.globSync` is stable since v24.0.0), `node:test`, `node:readline`, TypeScript 7 (type-check only). Uses WP-00's `server/recording.ts`, `shared/geo.ts`, `shared/geoid.ts`, `shared/airports.ts`, `shared/types.ts` and `data/fixtures/golden/airports-sample.json`. No new dependencies. Tests use the golden airports file, not `public/airports/heroes.json`, because WP-T1 runs in parallel.

**Wave:** 1 (parallel; depends only on WP-00). **Estimated:** 2 h. **Validated:** every file below was run in a sandbox copy of the Wave 0 tree on 2026-09-22 (Node v25.2.1, TypeScript 7.0.2). `node --test tools/analysis/datum.test.ts tools/analysis/census.test.ts tools/datum-check.test.ts tools/census.test.ts` → 26/26 pass. `npx tsc --noEmit` reports nothing for these files (the whole sandbox type-checked clean). Measured results:
- Three synthetic arrivals on the 3° path with HAE `alt_geom` give median ≈ 0.00 m (pass). The same arrivals with MSL `alt_geom` give +32.23 m at KSFO 28R and −19.49 m at LLBG 12 (fail).
- An arrival lost at 2,500 ft gives `minAglFt` 2,509 ft.
- Chunked decoding of a 90 MB, 5,000-line recording takes 0.74 s.
- Both CLIs ran on `data/fixtures/golden/recording-sample.jsonl` (63 samples, no arrivals): FAIL / not a hero, exit code 1.
- Mutations turn tests red: changing `>= 80` to `> 80` in `summarizeCensus`, and removing the chunk lead-in in `samplesNear`.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints — they apply to every task here. The ones this package relies on:
- Tests never touch the network. They build synthetic `Sample`s, or `RecordLine` files in `os.tmpdir()`, on exact 3° glidepaths computed with `shared/geo.destination` and `shared/geoid.geoidN`.
- `alt_geom` is HAE only when `version === 2`. v0/v1 residuals are reported and flagged, never gated.
- Heights: residuals and thresholds are WGS84 ellipsoidal metres; AGL is feet above the airport (see `aglFt`).

## Files owned by this package

| Path | Responsibility |
|---|---|
| `tools/analysis/datum.ts` | `approachResiduals`, `summarizeDatum` (+ `Residual`, `alongCross`, `angleDiffDeg`, `quantile`) |
| `tools/analysis/datum.test.ts` | glidepath residuals HAE vs MSL, window/centreline/heading filters, v0 flagging, arrival counting |
| `tools/analysis/census.ts` | `Arrival`, `findArrivals`, `summarizeCensus` (+ `aglFt`, `RADIUS_NM`) |
| `tools/analysis/census.test.ts` | AGL ladder, tracked-to-ground / lost-at-2,500 ft, gaps, nic share, 5 km jump, non-arrivals, hero verdict |
| `tools/datum-check.ts` | datum CLI; shared `loadInputs`, `samplesNear`, `writeReport`, `round1` |
| `tools/datum-check.test.ts` | glob/positional inputs, errors, chunked = single-pass decoding, PASS/FAIL reports |
| `tools/census.ts` | census CLI |
| `tools/census.test.ts` | end-to-end census from recorded polls |

---

### Task 1: Datum residuals and verdict

**Files:**
- Create: `tools/analysis/datum.ts`, `tools/analysis/datum.test.ts`
- Test: `tools/analysis/datum.test.ts`

**Interfaces:**
- Consumes: `Airport`, `RunwayEnd` (`shared/airports.ts`) · `Sample` (`shared/types.ts`) · `bearingDeg`, `distanceNm`, `destination` (`shared/geo.ts`) · `geoidN` (`shared/geoid.ts`) · `data/fixtures/golden/airports-sample.json` (all WP-00)
- Produces: `approachResiduals(samples: Sample[], rwy: RunwayEnd): Residual[]` with `interface Residual { hex: string; tMs: number; dNm: number; rM: number; version: number | null }` · `summarizeDatum(res: Residual[], minArrivals = 3): { arrivals: number; n: number; medianM: number; pass: boolean }` · extra exports `quantile(xs: number[], q: number): number`, `angleDiffDeg(a: number, b: number): number`, `alongCross(lat: number, lon: number, end: RunwayEnd): { alongNm: number; crossM: number }` (used by Task 2)

- [ ] **Step 1: Write the failing test**

```ts
// tools/analysis/datum.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Airport } from '../../shared/airports.ts'
import { destination } from '../../shared/geo.ts'
import { geoidN } from '../../shared/geoid.ts'
import type { Sample } from '../../shared/types.ts'
import { alongCross, approachResiduals, quantile, summarizeDatum } from './datum.ts'

const airports: Airport[] = JSON.parse(readFileSync(new URL('../../data/fixtures/golden/airports-sample.json', import.meta.url), 'utf8'))
const ksfo = airports.find((a) => a.ident === 'KSFO')!
const e28r = ksfo.runways.flatMap((r) => r.ends).find((e) => e.ident === '28R')!
const GLIDE = Math.tan((3 * Math.PI) / 180)

const BASE: Sample = {
  hex: 'a00001', tMs: 0, rxMs: 0, lat: 0, lon: 0, onGround: false, altBaroFt: null, altGeomFt: null, gsKt: 140,
  trackDeg: 298, trueHeadingDeg: null, rollDeg: null, baroRateFpm: -750, geomRateFpm: null, navQnhHpa: null,
  version: 2, nic: 8, quality: 'adsb2', nM: 0, callsign: null, typeCode: null, reg: null,
}

type PathOpts = { msl?: boolean; offsetM?: number; version?: number; tMs?: number; trackDeg?: number; onGround?: boolean; noGeom?: boolean }

/** A sample dNm before the 28R threshold (offsetM right of the centreline), exactly on the 3° path with TCH 15 m. */
function onPath(hex: string, dNm: number, o: PathOpts = {}): Sample {
  let p = destination(e28r.thrLat, e28r.thrLon, e28r.hdgTrueDeg + 180, dNm)
  if (o.offsetM) p = destination(p.lat, p.lon, e28r.hdgTrueDeg + 90, o.offsetM / 1852)
  const haeM = e28r.thrHaeM + 15 + dNm * 1852 * GLIDE
  const geomM = o.msl ? haeM - geoidN(p.lat, p.lon) : haeM
  return {
    ...BASE, hex, tMs: o.tMs ?? 0, lat: p.lat, lon: p.lon, onGround: o.onGround ?? false,
    altGeomFt: o.noGeom ? null : geomM / 0.3048, version: o.version ?? 2, trackDeg: o.trackDeg ?? e28r.hdgTrueDeg,
  }
}

/** One arrival from 2.95 nm to 0.15 nm, 0.1 nm apart (≈ 2.6 s at 140 kt), starting at t0Ms. */
function arrival(hex: string, t0Ms: number, o: PathOpts = {}): Sample[] {
  const out: Sample[] = []
  for (let k = 0; k < 29; k++) out.push(onPath(hex, 2.95 - k * 0.1, { ...o, tMs: t0Ms + k * 2600 }))
  return out
}

test('alongCross: positive before the threshold, signed right of the landing direction', () => {
  const p = destination(e28r.thrLat, e28r.thrLon, e28r.hdgTrueDeg + 180, 1)
  const right = destination(p.lat, p.lon, e28r.hdgTrueDeg + 90, 50 / 1852)
  const a = alongCross(right.lat, right.lon, e28r)
  assert.ok(Math.abs(a.alongNm - 1) < 1e-4, `along ${a.alongNm}`)
  assert.ok(Math.abs(a.crossM - 50) < 0.1, `cross ${a.crossM}`)
  const past = destination(e28r.thrLat, e28r.thrLon, e28r.hdgTrueDeg, 0.5)
  assert.ok(alongCross(past.lat, past.lon, e28r).alongNm < -0.49)
})

test('true HAE alt_geom on the 3° glidepath → residuals ≈ 0 and the gate passes', () => {
  const samples = [...arrival('a00001', 0), ...arrival('a00002', 600_000), ...arrival('a00003', 1_200_000)]
  const res = approachResiduals(samples, e28r)
  assert.equal(res.length, 3 * 17) // 0.35 … 1.95 nm per arrival
  assert.ok(res.every((r) => Math.abs(r.rM) < 0.01 && r.dNm >= 0.3 && r.dNm <= 2 && r.version === 2))
  const sum = summarizeDatum(res)
  assert.equal(sum.arrivals, 3)
  assert.equal(sum.n, 51)
  assert.ok(Math.abs(sum.medianM) < 0.01, `median ${sum.medianM}`)
  assert.equal(sum.pass, true)
})

test('alt_geom that is really MSL → median ≈ −N ≈ +32.3 m at KSFO and the gate fails', () => {
  const samples = [...arrival('a00001', 0, { msl: true }), ...arrival('a00002', 600_000, { msl: true }), ...arrival('a00003', 1_200_000, { msl: true })]
  const sum = summarizeDatum(approachResiduals(samples, e28r))
  assert.ok(Math.abs(sum.medianM - 32.3) < 0.15, `median ${sum.medianM}`)
  assert.equal(sum.pass, false)
})

test('only airborne samples with alt_geom, 0.3–2 nm before the threshold, ≤ 100 m off the centreline, flying the runway heading', () => {
  const keep = [onPath('b1', 1, { offsetM: 90 }), onPath('b2', 1.5, { offsetM: -90 })]
  const drop = [
    onPath('c1', 0.25),
    onPath('c2', 2.1),
    onPath('c3', 1, { offsetM: 150 }),
    onPath('c4', 1, { offsetM: -150 }),
    onPath('c5', 1, { trackDeg: 118 }), // departure off the reciprocal runway
    onPath('c6', 1, { onGround: true }),
    onPath('c7', 1, { noGeom: true }),
    { ...onPath('c8', 1), ...destination(e28r.thrLat, e28r.thrLon, e28r.hdgTrueDeg, 0.5) }, // past the threshold
  ]
  const res = approachResiduals([...keep, ...drop], e28r)
  assert.deepEqual(res.map((r) => r.hex), ['b1', 'b2'])
  assert.ok(res.every((r) => Math.abs(r.rM) < 0.05))
})

test('v0 samples are reported with their version but kept out of the gate', () => {
  const v2 = [...arrival('a00001', 0), ...arrival('a00002', 600_000), ...arrival('a00003', 1_200_000)]
  const v0 = [...arrival('b00001', 0, { msl: true, version: 0 }), ...arrival('b00002', 0, { msl: true, version: 0 })]
  const res = approachResiduals([...v2, ...v0], e28r)
  assert.equal(res.filter((r) => r.version === 0).length, 2 * 17)
  const sum = summarizeDatum(res)
  assert.equal(sum.n, 51)
  assert.equal(sum.arrivals, 3)
  assert.ok(Math.abs(sum.medianM) < 0.01)
  assert.equal(sum.pass, true)
})

test('fewer than minArrivals v2 arrivals → no pass; one airframe twice (> 10 min apart) counts twice', () => {
  const two = approachResiduals([...arrival('a00001', 0), ...arrival('a00002', 0)], e28r)
  assert.equal(summarizeDatum(two).pass, false)
  assert.equal(summarizeDatum(two, 2).pass, true)
  const again = approachResiduals([...arrival('a00001', 0), ...arrival('a00001', 3_600_000)], e28r)
  assert.equal(summarizeDatum(again).arrivals, 2)
})

test('no residuals → NaN median, no pass', () => {
  const sum = summarizeDatum([])
  assert.deepEqual({ ...sum, medianM: Number.isNaN(sum.medianM) }, { arrivals: 0, n: 0, medianM: true, pass: false })
})

test('quantile: linear interpolation, unsorted input, empty → NaN', () => {
  assert.equal(quantile([3, 1, 2], 0.5), 2)
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5)
  assert.equal(quantile([0, 10], 0.9), 9)
  assert.ok(Number.isNaN(quantile([], 0.5)))
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tools/analysis/datum.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/tools/analysis/datum.ts'`, `ℹ fail 1`

- [ ] **Step 3: Write the implementation**

```ts
// tools/analysis/datum.ts
// G2 datum check: is ADS-B v2 alt_geom really WGS84 ellipsoidal height (HAE)?
// On short final an arrival flies the 3° glidepath, so alt_geom·0.3048 ≈ thrHaeM + 15 m + d·tan 3°.
// If alt_geom were MSL instead, the residual would sit at −N: ≈ +32 m at KSFO, ≈ −20 m at LLBG.
import type { RunwayEnd } from '../../shared/airports.ts'
import { bearingDeg, distanceNm } from '../../shared/geo.ts'
import type { Sample } from '../../shared/types.ts'

const FT = 0.3048
const TCH_M = 15 // nominal threshold crossing height
const TAN_GLIDE = Math.tan((3 * Math.PI) / 180)
const ARRIVAL_GAP_MS = 10 * 60_000 // same hex seen again after this long = a new arrival
const MAX_TRACK_ERR_DEG = 30

export interface Residual {
  hex: string
  tMs: number
  dNm: number // distance before the threshold along the extended centreline
  rM: number // alt_geom (m) − nominal glidepath HAE (m)
  version: number | null // only version 2 counts toward the gate
}

/** q-quantile (0…1) with linear interpolation between order statistics; NaN for an empty list. */
export function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return Number.NaN
  const s = [...xs].sort((a, b) => a - b)
  const i = (s.length - 1) * q
  const lo = Math.floor(i)
  return lo + 1 < s.length ? s[lo] + (s[lo + 1] - s[lo]) * (i - lo) : s[lo]
}

/** Absolute difference between two directions, degrees in [0, 180]. */
export function angleDiffDeg(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360)
  return d > 180 ? 360 - d : d
}

/**
 * Position relative to a runway end's threshold: alongNm > 0 before the threshold (approach side),
 * crossM = lateral offset from the extended centreline, + = right of the landing direction.
 */
export function alongCross(lat: number, lon: number, end: RunwayEnd): { alongNm: number; crossM: number } {
  const d = distanceNm(end.thrLat, end.thrLon, lat, lon)
  const rel = ((bearingDeg(end.thrLat, end.thrLon, lat, lon) - end.hdgTrueDeg) * Math.PI) / 180
  return { alongNm: -d * Math.cos(rel), crossM: d * Math.sin(rel) * 1852 }
}

/**
 * Glidepath residuals for one runway end: airborne samples with alt_geom, 0.3–2 nm before the threshold,
 * within 100 m of the extended centreline and tracking within 30° of the landing heading
 * (the heading check keeps reciprocal-runway departures out). Every version is returned; the gate uses v2 only.
 */
export function approachResiduals(samples: Sample[], rwy: RunwayEnd): Residual[] {
  const out: Residual[] = []
  for (const s of samples) {
    if (s.onGround || s.altGeomFt === null || s.trackDeg === null) continue
    if (angleDiffDeg(s.trackDeg, rwy.hdgTrueDeg) > MAX_TRACK_ERR_DEG) continue
    const { alongNm, crossM } = alongCross(s.lat, s.lon, rwy)
    if (alongNm < 0.3 || alongNm > 2 || Math.abs(crossM) > 100) continue
    const glideM = rwy.thrHaeM + TCH_M + alongNm * 1852 * TAN_GLIDE
    out.push({ hex: s.hex, tMs: s.tMs, dNm: alongNm, rM: s.altGeomFt * FT - glideM, version: s.version })
  }
  return out
}

/** Distinct approaches: per hex, a new one starts after a gap > 10 min. */
function countArrivals(res: Residual[]): number {
  const byHex = new Map<string, number[]>()
  for (const r of res) {
    const ts = byHex.get(r.hex)
    if (ts) ts.push(r.tMs)
    else byHex.set(r.hex, [r.tMs])
  }
  let n = 0
  for (const ts of byHex.values()) {
    ts.sort((a, b) => a - b)
    n += 1 + ts.filter((t, i) => i > 0 && t - ts[i - 1] > ARRIVAL_GAP_MS).length
  }
  return n
}

/**
 * Datum verdict over ADS-B v2 residuals only (v0/v1 alt_geom may be MSL by design).
 * pass = ≥ minArrivals v2 arrivals and |median| ≤ 10 m. The median pools all v2 samples.
 * ponytail: pooled median, so a densely sampled arrival weighs more; per-arrival medians if one airframe dominates.
 */
export function summarizeDatum(res: Residual[], minArrivals = 3): { arrivals: number; n: number; medianM: number; pass: boolean } {
  const v2 = res.filter((r) => r.version === 2)
  const arrivals = countArrivals(v2)
  const medianM = quantile(v2.map((r) => r.rM), 0.5)
  return { arrivals, n: v2.length, medianM, pass: arrivals >= minArrivals && Math.abs(medianM) <= 10 }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tools/analysis/datum.test.ts`
Expected: PASS — `ℹ tests 8`, `ℹ pass 8`, `ℹ fail 0`

- [ ] **Step 5: Commit**

```bash
git add tools/analysis/datum.ts tools/analysis/datum.test.ts
git commit -m "feat(analysis): glidepath datum residuals and verdict" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Arrival coverage census

**Files:**
- Create: `tools/analysis/census.ts`, `tools/analysis/census.test.ts`
- Test: `tools/analysis/census.test.ts`

**Interfaces:**
- Consumes: `Airport` (`shared/airports.ts`) · `Sample` (`shared/types.ts`) · `distanceNm`, `destination` (`shared/geo.ts`) · `geoidN` (`shared/geoid.ts`) · `data/fixtures/golden/airports-sample.json` (WP-00) · `alongCross`, `angleDiffDeg`, `quantile` (Task 1)
- Produces: `interface Arrival { hex: string; callsign: string | null; minAglFt: number; reachedGround: boolean; p90GapBelow1000S: number | null; geomShare: number; badNicShare: number; jumps: number }` · `findArrivals(samples: Sample[], ap: Airport): Arrival[]` (ordered by first-seen time) · `summarizeCensus(a: Arrival[]): { arrivals: number; trackedBelow200Pct: number; p90GapBelow1000S: number | null; geomSharePct: number; badNicPct: number; landingHeroOk: boolean }` · extra exports `aglFt(s: Sample, ap: Airport): number | null`, `RADIUS_NM = 15`

- [ ] **Step 1: Write the failing test**

```ts
// tools/analysis/census.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Airport } from '../../shared/airports.ts'
import { destination } from '../../shared/geo.ts'
import { geoidN } from '../../shared/geoid.ts'
import type { Sample } from '../../shared/types.ts'
import { type Arrival, aglFt, findArrivals, summarizeCensus } from './census.ts'

const airports: Airport[] = JSON.parse(readFileSync(new URL('../../data/fixtures/golden/airports-sample.json', import.meta.url), 'utf8'))
const ksfo = airports.find((a) => a.ident === 'KSFO')!
const ends = ksfo.runways.flatMap((r) => r.ends)
const e28r = ends.find((e) => e.ident === '28R')!
const e28l = ends.find((e) => e.ident === '28L')!
const FT = 0.3048
const TAN3 = Math.tan((3 * Math.PI) / 180)

const BASE: Sample = {
  hex: 'a00001', tMs: 0, rxMs: 0, lat: 0, lon: 0, onGround: false, altBaroFt: null, altGeomFt: null, gsKt: 140,
  trackDeg: 298, trueHeadingDeg: null, rollDeg: null, baroRateFpm: -750, geomRateFpm: null, navQnhHpa: 1013.2,
  version: 2, nic: 8, quality: 'adsb2', nM: 0, callsign: null, typeCode: null, reg: null,
}

type ApproachOpts = {
  t0Ms?: number
  stepS?: number // sample spacing
  slowBelowFt?: number // switch to slowStepS below this AGL
  slowStepS?: number
  lostBelowFt?: number // coverage ends before going below this AGL
  ground?: boolean // add 5 rollout samples (default true)
  version?: number
  geom?: boolean
  nic?: (i: number) => number | null
  jumpAt?: number // displace sample i by 5 km to the right
}

/** A 140 kt arrival on the KSFO 28R 3° glidepath from 12 nm, altitudes consistent in baro (QNH 1013.2) and HAE geom. */
function approach(hex: string, o: ApproachOpts = {}): Sample[] {
  const mps = (140 * 1852) / 3600
  const t0 = o.t0Ms ?? 0
  const out: Sample[] = []
  let t = 0
  for (let i = 0; ; i++) {
    const d = 12 - (t * mps) / 1852
    if (d <= 0) break
    const agl = (15 + d * 1852 * TAN3) / FT
    if (o.lostBelowFt !== undefined && agl < o.lostBelowFt) return out
    let p = destination(e28r.thrLat, e28r.thrLon, e28r.hdgTrueDeg + 180, d)
    if (o.jumpAt === i) p = destination(p.lat, p.lon, e28r.hdgTrueDeg + 90, 5000 / 1852)
    const mslFt = e28r.elevFt + agl
    out.push({
      ...BASE, hex, tMs: t0 + t * 1000, rxMs: t0 + t * 1000 + 500, lat: p.lat, lon: p.lon,
      altBaroFt: Math.round(mslFt / 25) * 25, altGeomFt: o.geom === false ? null : (mslFt * FT + geoidN(p.lat, p.lon)) / FT,
      version: o.version ?? 2, nic: o.nic ? o.nic(i) : 8, callsign: 'UAL123',
    })
    t += o.slowBelowFt !== undefined && agl < o.slowBelowFt ? o.slowStepS! : (o.stepS ?? 2)
  }
  if (o.ground === false) return out
  let past = (t * mps) / 1852 - 12
  for (let k = 0; k < 5; k++, t += 2, past += 0.05) {
    const p = destination(e28r.thrLat, e28r.thrLon, e28r.hdgTrueDeg, past)
    out.push({ ...BASE, hex, tMs: t0 + t * 1000, lat: p.lat, lon: p.lon, onGround: true, gsKt: 100 - 15 * k, version: o.version ?? 2, callsign: 'UAL123' })
  }
  return out
}

/** Takeoff from 28L: 4 ground samples, then a climb along 298° to 3,000 ft. */
function departure(hex: string, t0Ms: number): Sample[] {
  const out: Sample[] = []
  for (let k = 0; k < 40; k++) {
    const x = 0.1 + k * 0.08 // nm past the 28L threshold
    const p = destination(e28l.thrLat, e28l.thrLon, e28l.hdgTrueDeg, x)
    const onGround = k < 4
    const altFt = onGround ? null : 13 + (x - 0.3) * 1000
    out.push({ ...BASE, hex, tMs: t0Ms + k * 2000, lat: p.lat, lon: p.lon, onGround, altBaroFt: altFt, altGeomFt: altFt === null ? null : (altFt * FT + geoidN(p.lat, p.lon)) / FT, gsKt: 150 })
  }
  return out
}

test('aglFt: ground 0; v2 alt_geom above airport HAE; else QNH-corrected baro; else raw baro; else null', () => {
  const apHaeFt = ksfo.elevFt + ksfo.nM / FT
  assert.equal(aglFt({ ...BASE, onGround: true, altGeomFt: 500 }, ksfo), 0)
  assert.equal(aglFt({ ...BASE, altGeomFt: 400, altBaroFt: 900 }, ksfo), 400 - apHaeFt)
  assert.equal(aglFt({ ...BASE, version: 0, altGeomFt: 400, altBaroFt: 900, navQnhHpa: 1000 }, ksfo), 900 + (1000 - 1013.25) * 27 - 13)
  assert.equal(aglFt({ ...BASE, version: 0, altBaroFt: 900, navQnhHpa: null }, ksfo), 900 - 13)
  assert.equal(aglFt({ ...BASE, version: 1, altBaroFt: 900, navQnhHpa: 1100 }, ksfo), 900 - 13)
  assert.equal(aglFt({ ...BASE, version: 0, altBaroFt: 20_000, navQnhHpa: 1000 }, ksfo), 20_000 - 13)
  assert.equal(aglFt({ ...BASE, version: 0 }, ksfo), null)
})

test('an arrival tracked to the ground: min AGL 0, reached ground, no jumps, full geom share', () => {
  const [a] = findArrivals(approach('a00001'), ksfo)
  assert.equal(a.hex, 'a00001')
  assert.equal(a.callsign, 'UAL123')
  assert.equal(a.minAglFt, 0)
  assert.equal(a.reachedGround, true)
  assert.equal(a.p90GapBelow1000S, 2)
  assert.equal(a.geomShare, 1)
  assert.equal(a.badNicShare, 0)
  assert.equal(a.jumps, 0)
})

test('an arrival lost at 2,500 ft AGL still counts, with its lowest height and no gap stat', () => {
  const [a] = findArrivals(approach('a00002', { lostBelowFt: 2500 }), ksfo)
  assert.ok(a.minAglFt >= 2500 && a.minAglFt < 2530, `minAglFt ${a.minAglFt}`)
  assert.equal(a.reachedGround, false)
  assert.equal(a.p90GapBelow1000S, null)
})

test('gaps below 1,000 ft AGL: 10 s spacing down low gives p90 10 s', () => {
  const [a] = findArrivals(approach('a00003', { slowBelowFt: 1200, slowStepS: 10 }), ksfo)
  assert.equal(a.p90GapBelow1000S, 10)
  assert.equal(a.reachedGround, true)
})

test('nic < 6 share, missing alt_geom share, and a 5 km position jump', () => {
  const nic = approach('a00004', { nic: (i) => (i % 2 === 0 ? 3 : 8), ground: false })
  const [n] = findArrivals(nic, ksfo)
  assert.equal(n.badNicShare, nic.filter((s) => s.nic === 3).length / nic.length)
  const [g] = findArrivals(approach('a00005', { geom: false, version: 0 }), ksfo)
  assert.equal(g.geomShare, 0)
  assert.equal(g.minAglFt, 0)
  const [j] = findArrivals(approach('a00006', { jumpAt: 100 }), ksfo)
  assert.equal(j.jumps, 2) // out to the false position and back
})

test('departures, overflights and traffic outside 15 nm are not arrivals', () => {
  const overflight = approach('b00002', { ground: false }).map((s) => ({ ...s, altBaroFt: 10_000, altGeomFt: 10_000 }))
  const far = approach('b00003').map((s) => ({ ...s, lat: s.lat + 1 }))
  assert.deepEqual(findArrivals([...departure('b00001', 0), ...overflight, ...far], ksfo), [])
})

test('landing then departing in one visit is one arrival that ends at touchdown', () => {
  const arr = approach('a00007')
  const dep = departure('a00007', arr.at(-1)!.tMs + 5 * 60_000)
  const found = findArrivals([...dep, ...arr], ksfo)
  assert.equal(found.length, 1)
  assert.deepEqual(found[0], findArrivals(arr, ksfo)[0])
})

test('the same airframe arriving twice an hour apart is two arrivals, ordered by time', () => {
  const found = findArrivals([...approach('a00008', { t0Ms: 3_600_000 }), ...approach('a00009', { t0Ms: 1_800_000, lostBelowFt: 2500 }), ...approach('a00008')], ksfo)
  assert.deepEqual(found.map((a) => [a.hex, a.reachedGround]), [['a00008', true], ['a00009', false], ['a00008', true]])
})

const A = (minAglFt: number, extra: Partial<Arrival> = {}): Arrival => ({
  hex: 'x', callsign: null, minAglFt, reachedGround: minAglFt === 0, p90GapBelow1000S: 2, geomShare: 1, badNicShare: 0, jumps: 0, ...extra,
})

test('summarizeCensus: landing hero needs ≥ 80 % of arrivals tracked below 200 ft AGL', () => {
  const ok = summarizeCensus([A(0), A(0), A(50), A(199), A(2500)])
  assert.equal(ok.arrivals, 5)
  assert.equal(ok.trackedBelow200Pct, 80)
  assert.equal(ok.landingHeroOk, true)
  const bad = summarizeCensus([A(0), A(0), A(200), A(2500), A(0)])
  assert.equal(bad.trackedBelow200Pct, 60)
  assert.equal(bad.landingHeroOk, false)
})

test('summarizeCensus: gap p90 across arrivals, geom and bad-nic shares as mean percentages', () => {
  const s = summarizeCensus([
    A(0, { p90GapBelow1000S: 2, geomShare: 1, badNicShare: 0 }),
    A(0, { p90GapBelow1000S: 4, geomShare: 0.5, badNicShare: 0.5 }),
    A(0, { p90GapBelow1000S: 6 }),
    A(0, { p90GapBelow1000S: 8 }),
    A(0, { p90GapBelow1000S: 10 }),
    A(2500, { p90GapBelow1000S: null }),
  ])
  assert.ok(Math.abs(s.p90GapBelow1000S! - 9.2) < 1e-9)
  assert.ok(Math.abs(s.geomSharePct - (100 * 5.5) / 6) < 1e-9)
  assert.ok(Math.abs(s.badNicPct - (100 * 0.5) / 6) < 1e-9)
})

test('summarizeCensus: no arrivals → not a landing hero', () => {
  assert.deepEqual(summarizeCensus([]), { arrivals: 0, trackedBelow200Pct: 0, p90GapBelow1000S: null, geomSharePct: 0, badNicPct: 0, landingHeroOk: false })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tools/analysis/census.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/tools/analysis/census.ts'`, `ℹ fail 1`

- [ ] **Step 3: Write the implementation**

```ts
// tools/analysis/census.ts
// G2 coverage census: how low do recorded arrivals stay tracked at an airport?
// A landing hero needs ≥ 80 % of its arrivals tracked below 200 ft above the airport.
import type { Airport } from '../../shared/airports.ts'
import { distanceNm } from '../../shared/geo.ts'
import type { Sample } from '../../shared/types.ts'
import { alongCross, angleDiffDeg, quantile } from './datum.ts'

const FT = 0.3048
export const RADIUS_NM = 15 // samples farther from the airport reference point are ignored
const VISIT_GAP_MS = 10 * 60_000 // same hex seen again after this long = a new visit
const FINAL_MAX_NM = 12
const FINAL_HALF_WIDTH_M = 1852
const FINAL_MAX_AGL_FT = 5000
const FINAL_MAX_TRACK_ERR_DEG = 30
const LOW_FT = 1000
const BAD_NIC = 6
const JUMP_MIN_NM = 0.25

export interface Arrival {
  hex: string
  callsign: string | null
  minAglFt: number // lowest height above the airport while tracked; 0 once on the ground
  reachedGround: boolean // tracked through touchdown (an on-ground sample ends the arrival)
  p90GapBelow1000S: number | null // p90 of airborne sample gaps with an end below 1,000 ft AGL; null if never that low
  geomShare: number // airborne samples with alt_geom / airborne samples
  badNicShare: number // samples with nic < 6 / samples (GNSS interference)
  jumps: number // consecutive pairs implying > 1.5 × reported ground speed; a lone false position counts twice
}

/**
 * Height above the airport in feet: 0 on the ground; ADS-B v2 alt_geom (HAE) minus the airport's HAE;
 * otherwise baro corrected with the aircraft's own QNH setting; otherwise raw baro minus field elevation.
 * Raw pressure altitude is off by 27 ft per hPa of weather (±300 ft is normal), too coarse for a 200 ft test,
 * so the rungs follow the client's AltitudeLadder order (WP-C4).
 * ponytail: if the datum check shows v2 alt_geom is not HAE, this is off by N (≈ 106 ft at KSFO); drop rung 2 then.
 */
export function aglFt(s: Sample, ap: Airport): number | null {
  if (s.onGround) return 0
  if (s.version === 2 && s.altGeomFt !== null) return s.altGeomFt - (ap.elevFt + ap.nM / FT)
  if (s.altBaroFt === null) return null
  const q = s.navQnhHpa
  const qnhFt = q !== null && q >= 950 && q <= 1050 && s.altBaroFt < 18_000 ? (q - 1013.25) * 27 : 0
  return s.altBaroFt + qnhFt - ap.elevFt
}

/**
 * Established on final for one of the airport's runway ends: airborne, ≤ 5,000 ft AGL, ≤ 12 nm before a threshold,
 * ≤ 1 nm off its extended centreline and tracking within 30° of its landing heading.
 * ponytail: curved or offset approaches (LOWI) only count once aligned; widen the corridor if the census misses them.
 */
function onFinal(s: Sample, ap: Airport): boolean {
  const agl = aglFt(s, ap)
  const track = s.trackDeg
  if (s.onGround || track === null || agl === null || agl > FINAL_MAX_AGL_FT) return false
  return ap.runways.some((r) =>
    r.ends.some((e) => {
      if (angleDiffDeg(track, e.hdgTrueDeg) > FINAL_MAX_TRACK_ERR_DEG) return false
      const { alongNm, crossM } = alongCross(s.lat, s.lon, e)
      return alongNm > 0 && alongNm <= FINAL_MAX_NM && Math.abs(crossM) <= FINAL_HALF_WIDTH_M
    }),
  )
}

function measure(arr: Sample[], ap: Airport): Arrival {
  const agl = arr.map((s) => aglFt(s, ap))
  const low = (i: number): boolean => agl[i] !== null && agl[i]! < LOW_FT
  const airborne = arr.filter((s) => !s.onGround)
  const gaps: number[] = []
  let jumps = 0
  for (let i = 1; i < arr.length; i++) {
    const a = arr[i - 1]
    const b = arr[i]
    const dtS = (b.tMs - a.tMs) / 1000
    if (!a.onGround && (low(i - 1) || low(i))) gaps.push(dtS)
    const dNm = distanceNm(a.lat, a.lon, b.lat, b.lon)
    const refKt = Math.max(a.gsKt ?? 0, b.gsKt ?? 0) || 250
    if (dNm > JUMP_MIN_NM && dNm / (dtS / 3600) > 1.5 * refKt) jumps++
  }
  return {
    hex: arr[0].hex,
    callsign: arr.find((s) => s.callsign !== null)?.callsign ?? null,
    minAglFt: agl.reduce<number>((m, x) => (x === null ? m : Math.min(m, x)), Infinity),
    reachedGround: arr[arr.length - 1].onGround,
    p90GapBelow1000S: gaps.length > 0 ? quantile(gaps, 0.9) : null,
    geomShare: airborne.length > 0 ? airborne.filter((s) => s.altGeomFt !== null).length / airborne.length : 0,
    badNicShare: arr.filter((s) => s.nic !== null && s.nic < BAD_NIC).length / arr.length,
    jumps,
  }
}

/** Arrivals in one visit (time-sorted samples of one hex): from the last ground sample before final to touchdown. */
function arrivalsInVisit(v: Sample[], ap: Airport): { t: number; a: Arrival }[] {
  const out: { t: number; a: Arrival }[] = []
  let from = 0
  for (;;) {
    let i0 = from
    while (i0 < v.length && !onFinal(v[i0], ap)) i0++
    if (i0 === v.length) return out
    let start = i0
    while (start > from && !v[start - 1].onGround) start--
    let end = i0
    while (end < v.length - 1 && !v[end].onGround) end++
    out.push({ t: v[start].tMs, a: measure(v.slice(start, end + 1), ap) })
    from = end + 1
  }
}

/** Every arrival at `ap` in the samples (any hexes, any order), ordered by the time it was first seen. */
export function findArrivals(samples: Sample[], ap: Airport): Arrival[] {
  const byHex = new Map<string, Sample[]>()
  for (const s of samples) {
    if (distanceNm(ap.lat, ap.lon, s.lat, s.lon) > RADIUS_NM) continue
    const list = byHex.get(s.hex)
    if (list) list.push(s)
    else byHex.set(s.hex, [s])
  }
  const found: { t: number; a: Arrival }[] = []
  for (const list of byHex.values()) {
    list.sort((a, b) => a.tMs - b.tMs)
    let v0 = 0
    for (let i = 1; i <= list.length; i++) {
      if (i < list.length && list[i].tMs - list[i - 1].tMs <= VISIT_GAP_MS) continue
      found.push(...arrivalsInVisit(list.slice(v0, i), ap))
      v0 = i
    }
  }
  return found.sort((x, y) => x.t - y.t).map((x) => x.a)
}

/**
 * Airport-level census. Percentages are means over arrivals; p90GapBelow1000S is the p90 of the per-arrival p90s.
 * ponytail: no minimum sample size; the CLI flags fewer than 10 arrivals as indicative only.
 */
export function summarizeCensus(a: Arrival[]): {
  arrivals: number
  trackedBelow200Pct: number
  p90GapBelow1000S: number | null
  geomSharePct: number
  badNicPct: number
  landingHeroOk: boolean
} {
  const n = a.length
  const pct = (k: number): number => (n === 0 ? 0 : (100 * k) / n)
  const gaps = a.map((x) => x.p90GapBelow1000S).filter((g): g is number => g !== null)
  const trackedBelow200Pct = pct(a.filter((x) => x.minAglFt < 200).length)
  return {
    arrivals: n,
    trackedBelow200Pct,
    p90GapBelow1000S: gaps.length > 0 ? quantile(gaps, 0.9) : null,
    geomSharePct: pct(a.reduce((m, x) => m + x.geomShare, 0)),
    badNicPct: pct(a.reduce((m, x) => m + x.badNicShare, 0)),
    landingHeroOk: n > 0 && trackedBelow200Pct >= 80,
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tools/analysis/census.test.ts`
Expected: PASS — `ℹ tests 11`, `ℹ pass 11`, `ℹ fail 0`

- [ ] **Step 5: Commit**

```bash
git add tools/analysis/census.ts tools/analysis/census.test.ts
git commit -m "feat(analysis): arrival coverage census and landing-hero verdict" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Datum-check CLI and the shared recording loader

**Files:**
- Create: `tools/datum-check.ts`, `tools/datum-check.test.ts`
- Test: `tools/datum-check.test.ts`

**Interfaces:**
- Consumes: `RecordLine`, `parseRecordLine`, `recordingToSamples` (`server/recording.ts`, WP-00) · `Airport`, `Sample`, `distanceNm`, `destination`, `geoidN` (WP-00) · `approachResiduals`, `quantile`, `summarizeDatum` (Task 1) · `RADIUS_NM` (Task 2)
- Produces: `samplesNear(files: string[], ap: Airport, radiusNm: number, chunkLines = 2000): Promise<Sample[]>` · `interface Inputs { airport: Airport; files: string[]; samples: Sample[]; out: string }` · `loadInputs(argv: string[]): Promise<Inputs>` · `writeReport(out: string, name: string, report: unknown): string` · `round1(x: number | null): number | null` · `run(argv: string[])` → report `{ airport, generatedAt, files, samplesNearAirport, summary, runwayEnds, notV2, residuals }` · CLI `node tools/datum-check.ts --recordings <files or glob…> [--airports public/airports/heroes.json] --airport <ICAO> [--out .planning/reports]` → `<out>/datum-<ICAO>-<YYYY-MM-DD>.json`, exit code 1 on FAIL

- [ ] **Step 1: Write the failing test**

```ts
// tools/datum-check.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RecordLine } from '../server/recording.ts'
import type { Airport } from '../shared/airports.ts'
import { destination } from '../shared/geo.ts'
import { geoidN } from '../shared/geoid.ts'
import { loadInputs, run, samplesNear } from './datum-check.ts'

const AIRPORTS = fileURLToPath(new URL('../data/fixtures/golden/airports-sample.json', import.meta.url))
const ksfo = (JSON.parse(readFileSync(AIRPORTS, 'utf8')) as Airport[]).find((a) => a.ident === 'KSFO')!
const e28r = ksfo.runways.flatMap((r) => r.ends).find((e) => e.ident === '28R')!
const URL_KSFO = 'https://api.adsb.lol/v2/point/37.6188/-122.3758/40'
const T0 = 1_790_000_000_000

/** adsb.lol aircraft object dNm before 28R on the 3° path; alt_geom is HAE (or MSL when msl). */
function aircraft(hex: string, dNm: number, msl = false): Record<string, unknown> {
  const p = destination(e28r.thrLat, e28r.thrLon, e28r.hdgTrueDeg + 180, dNm)
  const haeM = e28r.thrHaeM + 15 + dNm * 1852 * Math.tan((3 * Math.PI) / 180)
  const geomM = msl ? haeM - geoidN(p.lat, p.lon) : haeM
  const baroFt = Math.round((haeM - geoidN(p.lat, p.lon)) / 0.3048 / 25) * 25
  return { hex, type: 'adsb_icao', flight: 'TST1    ', version: 2, lat: p.lat, lon: p.lon, alt_baro: baroFt, alt_geom: Math.round(geomM / 0.3048), gs: 140, track: e28r.hdgTrueDeg, nic: 8, seen_pos: 0.2 }
}

const line = (nowMs: number, ac: unknown[], status = 200): string => {
  const body = status === 200 ? JSON.stringify({ ac, now: nowMs, msg: 'No error' }) : ''
  const r: RecordLine = { v: 1, source: 'adsblol', url: URL_KSFO, status, tSendMs: nowMs - 100, tRecvMs: nowMs + 150, bytes: body.length, body }
  return JSON.stringify(r)
}

/** One arrival polled every 2 s from 3 nm to 0.2 nm, starting t0Ms; every 5th poll is re-served 1 s later. */
function arrivalLines(hex: string, t0Ms: number, msl = false): string[] {
  const out: string[] = []
  for (let k = 0; ; k++) {
    const d = 3 - k * 0.0778
    if (d < 0.2) return out
    const l = line(t0Ms + k * 2000, [aircraft(hex, d, msl)])
    out.push(l)
    if (k % 5 === 0) out.push(l.replace(/"tRecvMs":(\d+)/, (_, t) => `"tRecvMs":${Number(t) + 1000}`))
  }
}

/** Two day files: arrival 1 (+ a 429) in the first, arrivals 2 and 3 in the second. */
function recordingDir(msl = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'fh-datum-'))
  writeFileSync(join(dir, '2026-09-22.jsonl'), [...arrivalLines('a00001', T0, msl), line(T0 + 200_000, [], 429)].join('\n') + '\n')
  writeFileSync(join(dir, '2026-09-23.jsonl'), [...arrivalLines('a00002', T0 + 86_400_000, msl), ...arrivalLines('a00003', T0 + 90_000_000, msl)].join('\n') + '\n')
  return dir
}

test('loadInputs: a quoted glob, or shell-expanded files after --recordings, give the same sorted inputs', async () => {
  const dir = recordingDir()
  const a = await loadInputs(['--recordings', join(dir, '*.jsonl'), '--airports', AIRPORTS, '--airport', 'ksfo'])
  const b = await loadInputs(['--recordings', join(dir, '2026-09-23.jsonl'), join(dir, '2026-09-22.jsonl'), '--airports', AIRPORTS, '--airport', 'KSFO'])
  assert.deepEqual(a.files, [join(dir, '2026-09-22.jsonl'), join(dir, '2026-09-23.jsonl')])
  assert.deepEqual(b, a)
  assert.equal(a.airport.ident, 'KSFO')
  assert.equal(a.out, '.planning/reports')
})

test('loadInputs: missing airport or recordings are errors', async () => {
  const dir = recordingDir()
  await assert.rejects(loadInputs(['--recordings', join(dir, '*.jsonl'), '--airports', AIRPORTS]), /--airport/)
  await assert.rejects(loadInputs(['--recordings', join(dir, '*.jsonl'), '--airports', AIRPORTS, '--airport', 'EGLL']), /EGLL/)
  await assert.rejects(loadInputs(['--recordings', join(dir, '*.nothing'), '--airports', AIRPORTS, '--airport', 'KSFO']), /no recordings/)
})

test('samplesNear: chunked decoding gives exactly the single-pass samples (re-serves across chunk edges dropped)', async () => {
  const dir = recordingDir()
  const files = readdirSync(dir).sort().map((f) => join(dir, f))
  const whole = await samplesNear(files, ksfo, 15)
  assert.equal(whole.length, 3 * 36) // 36 distinct positions per arrival (3 nm → 0.28 nm)
  assert.deepEqual(await samplesNear(files, ksfo, 15, 3), whole)
  assert.deepEqual(await samplesNear(files, ksfo, 15, 1), whole)
  assert.equal((await samplesNear(files, { ...ksfo, lat: ksfo.lat + 1 }, 15)).length, 0)
})

test('run: HAE alt_geom passes, prints and writes datum-KSFO-<date>.json', async () => {
  const dir = recordingDir()
  const out = join(dir, 'reports')
  const r = await run(['--recordings', join(dir, '*.jsonl'), '--airports', AIRPORTS, '--airport', 'KSFO', '--out', out])
  assert.equal(r.summary.pass, true)
  assert.equal(r.summary.arrivals, 3)
  assert.ok(Math.abs(r.summary.medianM) < 1, `median ${r.summary.medianM}`) // alt_geom is rounded to 1 ft on the wire
  assert.equal(r.runwayEnds.find((e) => e.ident === '28R')!.arrivals, 3)
  assert.equal(r.notV2.n, 0)
  const [file] = readdirSync(out)
  assert.match(file, /^datum-KSFO-\d{4}-\d{2}-\d{2}\.json$/)
  assert.deepEqual(JSON.parse(readFileSync(join(out, file), 'utf8')).summary, r.summary)
})

test('run: MSL alt_geom fails with median ≈ +32 m at KSFO', async () => {
  const dir = recordingDir(true)
  const r = await run(['--recordings', join(dir, '*.jsonl'), '--airports', AIRPORTS, '--airport', 'KSFO', '--out', join(dir, 'reports')])
  assert.equal(r.summary.pass, false)
  assert.ok(Math.abs(r.summary.medianM - 32.2) < 1, `median ${r.summary.medianM}`)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tools/datum-check.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/tools/datum-check.ts'`, `ℹ fail 1`

- [ ] **Step 3: Write the implementation**

```ts
// tools/datum-check.ts
// G2 datum gate: |median(alt_geom − nominal 3° glidepath HAE)| ≤ 10 m over ≥ 3 ADS-B v2 arrivals.
//
//   node tools/datum-check.ts --recordings 'data/recordings/*.jsonl' --airports public/airports/heroes.json --airport KSFO [--out .planning/reports]
//
// --recordings takes files and/or globs (quoted globs are expanded here). Files are read in name order,
// which is time order for the UTC daily recording files. Writes <out>/datum-<ICAO>-<YYYY-MM-DD>.json; exit code 1 = fail.
import { createReadStream, globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { parseRecordLine, recordingToSamples, type RecordLine } from '../server/recording.ts'
import type { Airport } from '../shared/airports.ts'
import { distanceNm } from '../shared/geo.ts'
import type { Sample } from '../shared/types.ts'
import { RADIUS_NM } from './analysis/census.ts'
import { approachResiduals, quantile, summarizeDatum } from './analysis/datum.ts'

const OFFSET_WINDOW_MS = 10 * 60_000 // recordingToSamples' MinOffset window

/**
 * Samples within radiusNm of the airport, decoded chunkLines lines at a time. A day of recordings is
 * larger than the biggest string V8 can hold, so readRecording (one readFileSync) cannot load it.
 * Each chunk is re-decoded with the previous 10 min of lines in front, so the clock offset and the
 * dedupe state match a single recordingToSamples pass; samples of those lead-in lines are not emitted twice.
 */
export async function samplesNear(files: string[], ap: Airport, radiusNm: number, chunkLines = 2000): Promise<Sample[]> {
  const out: Sample[] = []
  let lines: RecordLine[] = []
  let fresh = 0
  let doneRxMs = -Infinity
  const flush = (): void => {
    for (const s of recordingToSamples(lines)) {
      if (s.rxMs > doneRxMs && distanceNm(ap.lat, ap.lon, s.lat, s.lon) <= radiusNm) out.push(s)
    }
    doneRxMs = lines[lines.length - 1].tRecvMs
    lines = lines.filter((l) => l.tRecvMs >= doneRxMs - OFFSET_WINDOW_MS)
    fresh = 0
  }
  for (const file of files) {
    for await (const text of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
      if (text.trim() === '') continue
      lines.push(parseRecordLine(text))
      if (++fresh >= chunkLines) flush()
    }
  }
  if (fresh > 0) flush()
  return out
}

export interface Inputs {
  airport: Airport
  files: string[]
  samples: Sample[]
  out: string
}

/** Shared by tools/datum-check.ts and tools/census.ts: parse the CLI, load the airport and the nearby samples. */
export async function loadInputs(argv: string[]): Promise<Inputs> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      recordings: { type: 'string', multiple: true, default: [] },
      airports: { type: 'string', default: 'public/airports/heroes.json' },
      airport: { type: 'string' },
      out: { type: 'string', default: '.planning/reports' },
    },
  })
  const ident = values.airport?.toUpperCase()
  if (!ident) throw new Error('--airport <ICAO> is required')
  const airport = (JSON.parse(readFileSync(values.airports, 'utf8')) as Airport[]).find((a) => a.ident === ident)
  if (!airport) throw new Error(`${ident} is not in ${values.airports}`)
  const patterns = [...values.recordings, ...positionals]
  const files = [...new Set(patterns.flatMap((p) => (/[*?[{]/.test(p) ? globSync(p) : [p])))].sort()
  if (files.length === 0) throw new Error(`no recordings match ${patterns.join(' ') || '(none given)'}: pass --recordings <files or glob>`)
  return { airport, files, samples: await samplesNear(files, airport, RADIUS_NM), out: values.out }
}

/** Writes <out>/<name>-<UTC date>.json and returns its path. */
export function writeReport(out: string, name: string, report: unknown): string {
  mkdirSync(out, { recursive: true })
  const path = join(out, `${name}-${new Date().toISOString().slice(0, 10)}.json`)
  writeFileSync(path, JSON.stringify(report, null, 1) + '\n')
  return path
}

export const round1 = (x: number | null): number | null => (x === null || Number.isNaN(x) ? null : Math.round(x * 10) / 10)

export async function run(argv: string[]) {
  const { airport, files, samples, out } = await loadInputs(argv)
  const ends = airport.runways.flatMap((r) => r.ends).map((e) => ({ ident: e.ident, res: approachResiduals(samples, e) }))
  const all = ends.flatMap((e) => e.res)
  const summary = summarizeDatum(all)
  const notV2 = all.filter((r) => r.version !== 2)
  const report = {
    airport: airport.ident,
    generatedAt: new Date().toISOString(),
    files,
    samplesNearAirport: samples.length,
    summary,
    runwayEnds: ends.map((e) => {
      const { arrivals, n, medianM } = summarizeDatum(e.res, 1)
      return { ident: e.ident, arrivals, n, medianM }
    }),
    // v0/v1 alt_geom may legitimately be MSL: reported for information, never part of the gate.
    notV2: { n: notV2.length, medianM: quantile(notV2.map((r) => r.rM), 0.5) },
    residuals: ends.flatMap((e) => e.res.map((r) => ({ end: e.ident, ...r }))),
  }
  const path = writeReport(out, `datum-${airport.ident}`, report)
  console.log(`Datum check ${airport.ident} (EGM96 N ${airport.nM} m): ${samples.length} samples within ${RADIUS_NM} nm, ${files.length} file(s)`)
  console.table([
    ...report.runwayEnds.map((e) => ({ set: `v2 ${e.ident}`, arrivals: e.arrivals, samples: e.n, medianM: round1(e.medianM) })),
    { set: 'v2 all (gate)', arrivals: summary.arrivals, samples: summary.n, medianM: round1(summary.medianM) },
    { set: 'v0/v1 (flagged, not gated)', arrivals: null, samples: notV2.length, medianM: round1(report.notV2.medianM) },
  ])
  console.log(`${summary.pass ? 'PASS' : 'FAIL'}: |median| ${round1(Math.abs(summary.medianM)) ?? 'n/a'} m (limit 10 m), ${summary.arrivals} v2 arrivals (need 3)`)
  console.log(`wrote ${path}`)
  return report
}

if (import.meta.main) {
  const r = await run(process.argv.slice(2))
  process.exitCode = r.summary.pass ? 0 : 1
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tools/datum-check.test.ts`
Expected: PASS — `ℹ tests 5`, `ℹ pass 5`, `ℹ fail 0`. The console shows two runway tables, `PASS: |median| 0 m (limit 10 m), 3 v2 arrivals (need 3)` and `FAIL: |median| 32.2 m (limit 10 m), 3 v2 arrivals (need 3)`.

- [ ] **Step 5: Smoke-run the CLI on the golden recording**

Run: `node tools/datum-check.ts --recordings data/fixtures/golden/recording-sample.jsonl --airports data/fixtures/golden/airports-sample.json --airport KSFO --out "$(mktemp -d)"; echo "exit=$?"`
Expected: `Datum check KSFO (EGM96 N -32.3 m): 63 samples within 15 nm, 1 file(s)`, a table with one `v2` row per runway end (all 0), `FAIL: |median| n/a m (limit 10 m), 0 v2 arrivals (need 3)`, `wrote …/datum-KSFO-<date>.json`, `exit=1`. The fixture holds 4 polls and no approach.

- [ ] **Step 6: Commit**

```bash
git add tools/datum-check.ts tools/datum-check.test.ts
git commit -m "feat(tools): datum-check CLI with chunked recording reader" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Census CLI

**Files:**
- Create: `tools/census.ts`, `tools/census.test.ts`
- Test: `tools/census.test.ts`

**Interfaces:**
- Consumes: `loadInputs`, `round1`, `writeReport` (Task 3) · `findArrivals`, `summarizeCensus`, `RADIUS_NM` (Task 2) · `RecordLine`, `Airport`, `destination`, `geoidN` (WP-00, test only)
- Produces: `run(argv: string[])` → report `{ airport, generatedAt, files, samplesNearAirport, summary, arrivalsWithJumps, arrivals }` · CLI `node tools/census.ts --recordings <files or glob…> [--airports public/airports/heroes.json] --airport <ICAO> [--out .planning/reports]` → `<out>/census-<ICAO>-<YYYY-MM-DD>.json`, exit code 1 when not a landing hero

- [ ] **Step 1: Write the failing test**

```ts
// tools/census.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RecordLine } from '../server/recording.ts'
import type { Airport } from '../shared/airports.ts'
import { destination } from '../shared/geo.ts'
import { geoidN } from '../shared/geoid.ts'
import { run } from './census.ts'

const AIRPORTS = fileURLToPath(new URL('../data/fixtures/golden/airports-sample.json', import.meta.url))
const ksfo = (JSON.parse(readFileSync(AIRPORTS, 'utf8')) as Airport[]).find((a) => a.ident === 'KSFO')!
const e28r = ksfo.runways.flatMap((r) => r.ends).find((e) => e.ident === '28R')!
const T0 = 1_790_000_000_000
const MPS = (140 * 1852) / 3600

/** RecordLines for one 28R arrival from 12 nm, polled every 2 s; lostBelowFt ends coverage early, else 5 ground polls. */
function arrivalLines(hex: string, t0Ms: number, lostBelowFt?: number): string[] {
  const out: string[] = []
  const poll = (tS: number, ac: Record<string, unknown>): void => {
    const now = t0Ms + tS * 1000
    const body = JSON.stringify({ ac: [{ hex, type: 'adsb_icao', flight: 'TST1    ', version: 2, nic: 8, seen_pos: 0.3, ...ac }], now })
    const r: RecordLine = { v: 1, source: 'adsblol', url: 'https://api.adsb.lol/v2/point/37.6188/-122.3758/40', status: 200, tSendMs: now - 90, tRecvMs: now + 120, bytes: body.length, body }
    out.push(JSON.stringify(r))
  }
  let t = 0
  for (; ; t += 2) {
    const d = 12 - (t * MPS) / 1852
    if (d <= 0) break
    const aglFt = (15 + d * 1852 * Math.tan((3 * Math.PI) / 180)) / 0.3048
    if (lostBelowFt !== undefined && aglFt < lostBelowFt) return out
    const p = destination(e28r.thrLat, e28r.thrLon, e28r.hdgTrueDeg + 180, d)
    const mslFt = e28r.elevFt + aglFt
    poll(t, { lat: p.lat, lon: p.lon, alt_baro: Math.round(mslFt / 25) * 25, alt_geom: Math.round(mslFt + geoidN(p.lat, p.lon) / 0.3048), gs: 140, track: e28r.hdgTrueDeg })
  }
  for (let k = 0; k < 5; k++, t += 2) {
    const p = destination(e28r.thrLat, e28r.thrLon, e28r.hdgTrueDeg, 0.1 + k * 0.05)
    poll(t, { lat: p.lat, lon: p.lon, alt_baro: 'ground', gs: 100 - 15 * k, track: e28r.hdgTrueDeg })
  }
  return out
}

function recording(arrivals: [hex: string, lostBelowFt?: number][]): string {
  const dir = mkdtempSync(join(tmpdir(), 'fh-census-'))
  const lines = arrivals.flatMap(([hex, lost], i) => arrivalLines(hex, T0 + i * 1_800_000, lost))
  writeFileSync(join(dir, '2026-09-22.jsonl'), lines.join('\n') + '\n')
  return dir
}

test('run: one arrival to the ground, one lost at 2,500 ft → 50 % tracked, not a landing hero', async () => {
  const dir = recording([['a00001'], ['a00002', 2500]])
  const out = join(dir, 'reports')
  const r = await run(['--recordings', join(dir, '*.jsonl'), '--airports', AIRPORTS, '--airport', 'KSFO', '--out', out])
  assert.equal(r.summary.arrivals, 2)
  assert.equal(r.summary.trackedBelow200Pct, 50)
  assert.equal(r.summary.landingHeroOk, false)
  assert.deepEqual(r.arrivals.map((a) => [a.hex, a.callsign, a.reachedGround]), [['a00001', 'TST1', true], ['a00002', 'TST1', false]])
  assert.equal(r.summary.p90GapBelow1000S, 2)
  assert.equal(r.summary.geomSharePct, 100)
  const [file] = readdirSync(out)
  assert.match(file, /^census-KSFO-\d{4}-\d{2}-\d{2}\.json$/)
  assert.deepEqual(JSON.parse(readFileSync(join(out, file), 'utf8')).summary, r.summary)
})

test('run: four of five arrivals tracked to the ground → landing hero ok', async () => {
  const dir = recording([['a00001'], ['a00002'], ['a00003', 2500], ['a00004'], ['a00005']])
  const r = await run([join(dir, '2026-09-22.jsonl'), '--airport', 'KSFO', '--airports', AIRPORTS, '--out', join(dir, 'reports')])
  assert.equal(r.summary.arrivals, 5)
  assert.equal(r.summary.trackedBelow200Pct, 80)
  assert.equal(r.summary.landingHeroOk, true)
  assert.equal(r.arrivalsWithJumps, 0)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tools/census.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/tools/census.ts'`, `ℹ fail 1`

- [ ] **Step 3: Write the implementation**

```ts
// tools/census.ts
// G2 coverage census: can this airport be a landing hero (≥ 80 % of arrivals tracked below 200 ft AGL)?
//
//   node tools/census.ts --recordings 'data/recordings/*.jsonl' --airports public/airports/heroes.json --airport LLBG [--out .planning/reports]
//
// Same inputs as tools/datum-check.ts. Writes <out>/census-<ICAO>-<YYYY-MM-DD>.json; exit code 1 = not a landing hero.
import { RADIUS_NM, findArrivals, summarizeCensus } from './analysis/census.ts'
import { loadInputs, round1, writeReport } from './datum-check.ts'

export async function run(argv: string[]) {
  const { airport, files, samples, out } = await loadInputs(argv)
  const arrivals = findArrivals(samples, airport)
  const summary = summarizeCensus(arrivals)
  const report = {
    airport: airport.ident,
    generatedAt: new Date().toISOString(),
    files,
    samplesNearAirport: samples.length,
    summary,
    arrivalsWithJumps: arrivals.filter((a) => a.jumps > 0).length,
    arrivals,
  }
  const path = writeReport(out, `census-${airport.ident}`, report)
  console.log(`Census ${airport.ident}: ${samples.length} samples within ${RADIUS_NM} nm, ${files.length} file(s)`)
  console.table([
    {
      arrivals: summary.arrivals,
      'tracked <200 ft %': round1(summary.trackedBelow200Pct),
      'p90 gap <1000 ft s': round1(summary.p90GapBelow1000S),
      'alt_geom %': round1(summary.geomSharePct),
      'nic<6 %': round1(summary.badNicPct),
      'with jumps': report.arrivalsWithJumps,
      'landing hero': summary.landingHeroOk,
    },
  ])
  if (summary.arrivals < 10) console.log('fewer than 10 arrivals: treat the verdict as indicative only')
  console.log(`wrote ${path}`)
  return report
}

if (import.meta.main) {
  const r = await run(process.argv.slice(2))
  process.exitCode = r.summary.landingHeroOk ? 0 : 1
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tools/census.test.ts`
Expected: PASS — `ℹ tests 2`, `ℹ pass 2`, `ℹ fail 0`. The tables show `2 │ 50 │ 2 │ 100 │ 0 │ 0 │ false` and `5 │ 80 │ 2 │ 100 │ 0 │ 0 │ true`.

- [ ] **Step 5: Commit**

```bash
git add tools/census.ts tools/census.test.ts
git commit -m "feat(tools): census CLI for landing-hero coverage" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: WP gate

- [ ] **Step 1: Run every test this package owns**

Run: `node --test tools/analysis/datum.test.ts tools/analysis/census.test.ts tools/datum-check.test.ts tools/census.test.ts`
Expected: `ℹ tests 26`, `ℹ pass 26`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'tools/(analysis/|datum-check|census)'`
Expected: no output (grep exits 1). On a branch where every merged package is complete, `npm run check` must also pass.

- [ ] **Step 3: Confirm everything is committed and record the gate**

```bash
git status --short -- tools
git commit --allow-empty -m "chore(tools): WP-T3 gate passed (26 tests, tsc clean)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Expected: `git status` prints nothing before the commit. The branch `wp/T3` is ready to merge.

At G2 (after WP-T1 is merged and ≥ 24 h of recordings exist), run for both datum airports and the census:

```bash
node tools/datum-check.ts --recordings 'data/recordings/*.jsonl' --airport KSFO
node tools/datum-check.ts --recordings 'data/recordings/*.jsonl' --airport LLBG
node tools/census.ts --recordings 'data/recordings/*.jsonl' --airport KSFO
node tools/census.ts --recordings 'data/recordings/*.jsonl' --airport LLBG
```

With `tools/record-cells.ts` recordings each hero is polled every 6 s, so gaps below 1,000 ft are at least 6 s by construction. WP-I3's `record-arrivals` (1 Hz chase) measures real coverage gaps.

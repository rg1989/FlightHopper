# WP-S4 — Cells & Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the server its two in-memory data structures. The first is a fixed global grid of upstream query circles ("cells"): many client views share a few cached area queries, and those queries cover every point of each view. The second is the deduped, time-bounded sample store that answers client polls with only the samples that are new to them.

**Architecture:** `server/cells.ts` tiles the globe into 4° latitude bands. Each band has `floor(360·cos φc / 4)` columns, so every cell is ≈ 4° × 4° of arc. All 2,558 cells are built once at module load. A cell's query radius is its half-diagonal + 10 nm (180–218 nm; the 250 nm cap never binds). `cellsForView` returns every cell whose query circle intersects the view circle, found by brute force over all cells in ≈ 0.1 ms. Because of the brute force, the poles and the antimeridian need no special cases. `server/store.ts` keeps one array per hex in arrival order, behind WP-00's `Deduper`. `view`/`track` filter on the server receipt time `rxMs`, so a client that sends back the largest `rxMs` it has seen gets only new samples. `prune` drops samples older than the horizon (180 s) and forgets emptied hexes.

**Tech Stack:** Node ≥ 24.2 (native TypeScript), `node:test`. Only WP-00 helpers (`distanceNm`, `destination`, `Deduper`). No new dependencies.

**Wave:** 1 (parallel; depends only on WP-00). **Estimated:** 1–1.5 h. **Validated:** on 2026-09-22, every file below was run in the shared Wave 1 sandbox (Node v25.2.1, TypeScript 7). The tests were written first and failed with `ERR_MODULE_NOT_FOUND`. Then `node --test server/cells.test.ts server/store.test.ts` gave 13/13 pass (6 cells, including a 4,000-point coverage property near ±80°, both poles and the antimeridian; 7 store), and `tsc --noEmit` reported no errors in these files. The code blocks in this plan were then extracted into a clean copy of WP-00 + this package, and `npm run check` there gave `tsc` silent and 53/53 tests passing (40 WP-00 + 13).

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. The ones that matter most for this package:
- **Time:** `Sample.tMs` and `Sample.rxMs` are server clock. The store orders by arrival and filters on `rxMs` (receipt), never on `tMs`.
- adsb.lol `/v2/point` accepts a radius of at most 250 nm, so no cell may exceed it.
- Pure in-memory code: no I/O, no network. Erasable TypeScript only, `.ts` import extensions.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `server/cells.ts` | `Cell`, `cellsForView`, `cellById`: the fixed global query grid |
| `server/cells.test.ts` | grid numbers, radius bound, id round-trip, exactness and coverage property |
| `server/store.ts` | `SampleStore`: deduped per-hex samples with `since` polling and a 180 s horizon |
| `server/store.test.ts` | add/dedupe, `view` (`since` = 0 and > 0), `track`, `latest`, `prune` + `Deduper.forget` |

---

### Task 1: Cell grid

**Files:**
- Create: `server/cells.ts`, `server/cells.test.ts`
- Test: `server/cells.test.ts`

**Interfaces:**
- Consumes: `distanceNm` from `shared/geo.ts` (WP-00 Task 7). The test also uses `destination`.
- Produces (locked, PLAN.md §4 S4): `interface Cell { id: string; lat: number; lon: number; radiusNm: number }` · `cellsForView(lat: number, lon: number, radiusNm: number): Cell[]` · `cellById(id: string): Cell`. `cellById` throws `Error('unknown cell id: …')` for an id that is not in the grid.

| Fact | Value |
|---|---|
| band | `floor((lat + 90) / 4)`, 0…44; centre latitude `φc = −90 + 4·band + 2` |
| columns | `n = max(1, floor(360·cos φc / 4))`: 90 at the equator, 72 at φc = 36°, 3 at φc = ±88°; lon step `360 / n` |
| cell centre | `(φc, −180 + (col + 0.5)·step)`; id `b{band}:{col}` |
| query radius | `min(250, ceil(half-diagonal + 10))` nm; the half-diagonal is the distance to the farther (equatorward) corner; the result is 180–218 nm |
| count | 2,558 cells; KSFO's cell is `b31:11` = (36, −122.5), 182 nm |
| result | all cells with `distanceNm(view, cell) ≤ cell.radiusNm + view radius`, in band-then-column order; cells are shared frozen objects |

A cell contains no point farther from its centre than a corner, so the cell that contains any view point always intersects the view. Every view point is therefore inside the query circle of at least one returned cell. A small view near the middle of a cell returns only that cell. A view near a cell edge also gets the neighbour, because the neighbour's query circle reaches into the view.

- [ ] **Step 1: Write the failing test**

```ts
// server/cells.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { destination, distanceNm } from '../shared/geo.ts'
import { cellById, cellsForView } from './cells.ts'

/** Deterministic PRNG (mulberry32) so the property test is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WHOLE_EARTH_NM = 10_900 // > half the circumference: every cell intersects

test('grid: 4° bands, lon step 360/floor(360·cos φc/4), ids b{band}:{col}', () => {
  // KSFO (37.62, −122.38): band floor((37.62+90)/4) = 31, φc = 36°, 72 columns of 5°, column 11
  const c = cellById('b31:11')
  assert.equal(c.id, 'b31:11')
  assert.equal(c.lat, 36)
  assert.equal(c.lon, -122.5)
  // equator band: 90 columns of 4°; polar bands: 3 columns of 120°
  assert.equal(cellById('b22:0').lat, 0)
  assert.equal(cellById('b22:0').lon, -178)
  assert.doesNotThrow(() => cellById('b22:89'))
  assert.throws(() => cellById('b22:90'), /unknown cell/)
  assert.equal(cellById('b44:0').lat, 88)
  assert.equal(cellById('b44:0').lon, -120)
  assert.doesNotThrow(() => cellById('b0:2'))
  assert.throws(() => cellById('b0:3'), /unknown cell/)
  assert.throws(() => cellById('b45:0'), /unknown cell/)
  assert.throws(() => cellById('nonsense'), /unknown cell/)
})

test('every cell: query radius = half-diagonal + 10 nm, at most 250 nm; cellById round-trips', () => {
  const all = cellsForView(0, 0, WHOLE_EARTH_NM)
  assert.equal(all.length, 2558)
  assert.equal(new Set(all.map((c) => c.id)).size, all.length)
  for (const c of all) {
    assert.ok(c.radiusNm > 0 && c.radiusNm <= 250, `${c.id} radius ${c.radiusNm}`)
    assert.deepEqual(cellById(c.id), c)
  }
  // b31:11 spans 34–38° N, 125–120° W; the far (equatorward) corner is ≈ 170 nm from its centre
  const k = cellById('b31:11')
  const halfDiag = distanceNm(k.lat, k.lon, 34, -125)
  assert.ok(k.radiusNm >= halfDiag + 10 && k.radiusNm < halfDiag + 11, `radius ${k.radiusNm}, half-diagonal ${halfDiag}`)
})

test('a small view in the middle of a cell needs only that cell', () => {
  for (const id of ['b31:11', 'b22:0', 'b38:10', 'b10:40']) {
    const c = cellById(id)
    assert.deepEqual(cellsForView(c.lat, c.lon, 20).map((x) => x.id), [id])
  }
})

test('returned cells are exactly those whose query circle intersects the view circle', () => {
  const view = { lat: 37.6188, lon: -122.3758, nm: 40 }
  const got = new Set(cellsForView(view.lat, view.lon, view.nm).map((c) => c.id))
  assert.ok(got.has('b31:11'))
  for (const c of cellsForView(0, 0, WHOLE_EARTH_NM)) {
    const hits = distanceNm(view.lat, view.lon, c.lat, c.lon) <= c.radiusNm + view.nm
    assert.equal(got.has(c.id), hits, c.id)
  }
})

test('coverage: every point of the view lies inside some returned query circle (poles, ±80°, antimeridian)', () => {
  const views: [number, number, number][] = [
    [37.6188, -122.3758, 40], // KSFO
    [32.0114, 34.8867, 150], // LLBG
    [47.2602, 11.3439, 5], // LOWI, tiny view
    [0, 179.9, 200], // equator, antimeridian
    [65, -179.95, 250], // high latitude, antimeridian
    [79.7, 20, 150], // near +80°
    [-79.9, -60, 120], // near −80°
    [89.5, 45, 100], // contains the north pole
    [-88, 170, 250], // near the south pole, antimeridian
    [2, 0, 1], // band edge, tiny view
  ]
  const rand = rng(42)
  for (const [lat, lon, nm] of views) {
    const cells = cellsForView(lat, lon, nm)
    assert.ok(cells.length > 0)
    for (let i = 0; i < 400; i++) {
      const p = destination(lat, lon, rand() * 360, nm * Math.sqrt(rand()))
      const covered = cells.some((c) => distanceNm(p.lat, p.lon, c.lat, c.lon) <= c.radiusNm)
      assert.ok(covered, `view (${lat}, ${lon}, ${nm}): point (${p.lat}, ${p.lon}) not covered`)
    }
  }
})

test('cells are shared, read-only objects', () => {
  const c = cellById('b31:11')
  assert.throws(() => {
    ;(c as { radiusNm: number }).radiusNm = 1
  }, TypeError)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test server/cells.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/server/cells.ts' imported from …/server/cells.test.ts`, `ℹ fail 1`.

- [ ] **Step 3: Write the implementation**

```ts
// server/cells.ts
import { distanceNm } from '../shared/geo.ts'

/**
 * One fixed upstream query circle. The globe is tiled into ≈ 2,560 cells so that every client view maps to a few
 * shared queries (many viewers of one area cost the upstream nothing extra).
 */
export interface Cell {
  id: string
  lat: number
  lon: number
  radiusNm: number
}

const BAND_DEG = 4
const BANDS = 180 / BAND_DEG
const MARGIN_NM = 10
const MAX_RADIUS_NM = 250 // adsb.lol /v2/point limit

/** Columns in a band: lon step = 360 / floor(360·cos φc / 4), so cells stay ≈ 4° × 4° of arc. */
function bandCols(band: number): number {
  const φc = -90 + (band + 0.5) * BAND_DEG
  return Math.max(1, Math.floor((360 * Math.cos((φc * Math.PI) / 180)) / BAND_DEG))
}

function makeCell(band: number, col: number): Cell {
  const step = 360 / bandCols(band)
  const lat = -90 + (band + 0.5) * BAND_DEG
  const lon = -180 + (col + 0.5) * step
  const west = lon - step / 2
  // The farthest points of a lat/lon rectangle from its centre are its corners; the equatorward ones are farther.
  const halfDiag = Math.max(distanceNm(lat, lon, lat - BAND_DEG / 2, west), distanceNm(lat, lon, lat + BAND_DEG / 2, west))
  // ceil: the upstream URL carries whole nm, and rounding down would shave the margin.
  return Object.freeze({ id: `b${band}:${col}`, lat, lon, radiusNm: Math.min(MAX_RADIUS_NM, Math.ceil(halfDiag + MARGIN_NM)) })
}

const ALL: Cell[] = []
const BY_ID = new Map<string, Cell>()
for (let band = 0; band < BANDS; band++) {
  for (let col = 0; col < bandCols(band); col++) {
    const cell = makeCell(band, col)
    ALL.push(cell)
    BY_ID.set(cell.id, cell)
  }
}

/** Cells whose query circle intersects the view circle. Together they cover every point of the view. */
export function cellsForView(lat: number, lon: number, radiusNm: number): Cell[] {
  // ponytail: brute force over all ≈ 2,560 cells (≈ 0.1 ms per call), which also makes poles and the antimeridian
  // free of special cases. Upgrade to a band/column range scan if it ever shows up in a profile.
  return ALL.filter((c) => distanceNm(lat, lon, c.lat, c.lon) <= c.radiusNm + radiusNm)
}

export function cellById(id: string): Cell {
  const c = BY_ID.get(id)
  if (!c) throw new Error(`unknown cell id: ${id}`)
  return c
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test server/cells.test.ts`
Expected: PASS — `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/cells.ts server/cells.test.ts
git commit -m "feat(server): 4-degree band cell grid for shared upstream area queries" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Sample store

**Files:**
- Create: `server/store.ts`, `server/store.test.ts`
- Test: `server/store.test.ts`

**Interfaces:**
- Consumes: `Sample` (`shared/types.ts`, WP-00 Task 2), `Deduper` (`shared/dedupe.ts`, WP-00 Task 6), `distanceNm` (`shared/geo.ts`, WP-00 Task 7).
- Produces (locked, PLAN.md §4 S4): `class SampleStore { constructor(opts?: { horizonMs?: number }); add(s: Sample): boolean; view(lat: number, lon: number, radiusNm: number, sinceRxMs: number): Sample[]; track(hex: string, sinceRxMs: number): Sample[]; latest(hex: string): Sample | null; prune(nowMs: number): void; get size(): number }`

| Method | Behaviour |
|---|---|
| `add(s)` | `false` when the internal `Deduper` rejects it (re-served, older, unmoved < 100 ms later); otherwise appended to its hex |
| `view(lat, lon, nm, since ≤ 0)` | the latest sample of every hex whose latest position is within `nm` |
| `view(lat, lon, nm, since > 0)` | every sample with `rxMs > since` of every hex whose latest position is within `nm` (older positions outside the circle included) |
| `track(hex, since)` | samples of `hex` with `rxMs > since`, oldest first; `[]` for an unknown hex |
| `latest(hex)` | newest sample or `null` |
| `prune(nowMs)` | drops samples with `rxMs < nowMs − horizonMs` (default 180 000); an emptied hex is deleted and `Deduper.forget(hex)` is called |
| `size` | number of stored samples (all hexes) |

Hex keys are exactly `Sample.hex` (lower-case from `toSample`). Callers such as WP-A1's `/api/chase` lower-case the query hex. WP-I1 calls `add` for each polled sample and `prune(now)` once per tick.

- [ ] **Step 1: Write the failing test**

```ts
// server/store.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SampleStore } from './store.ts'
import type { Sample } from '../shared/types.ts'

const KSFO = { lat: 37.6188, lon: -122.3758 }

const s = (hex: string, tMs: number, rxMs: number, lat = KSFO.lat, lon = KSFO.lon): Sample => ({
  hex, tMs, rxMs, lat, lon, onGround: false, altBaroFt: 5000, altGeomFt: null, gsKt: 200, trackDeg: 90,
  trueHeadingDeg: null, rollDeg: null, baroRateFpm: null, geomRateFpm: null, navQnhHpa: null, version: 2, nic: 8,
  quality: 'adsb2', nM: -32.3, callsign: null, typeCode: null, reg: null,
})

const hexes = (xs: Sample[]): string[] => xs.map((x) => `${x.hex}@${x.tMs}`).sort()

test('add dedupes through Deduper; size counts stored samples', () => {
  const st = new SampleStore()
  assert.equal(st.size, 0)
  assert.equal(st.add(s('a', 1000, 1100)), true)
  assert.equal(st.add(s('a', 1000, 2100)), false) // re-served
  assert.equal(st.add(s('a', 900, 2100, 38)), false) // older
  assert.equal(st.add(s('a', 2000, 2100, 37.62)), true)
  assert.equal(st.add(s('b', 1000, 1100)), true)
  assert.equal(st.size, 3)
})

test('latest(hex) is the newest sample, null for an unknown hex', () => {
  const st = new SampleStore()
  st.add(s('a', 1000, 1100))
  st.add(s('a', 2000, 2100, 37.7))
  assert.equal(st.latest('a')?.tMs, 2000)
  assert.equal(st.latest('zzz'), null)
})

test('view(…, 0) = latest sample per hex whose latest position is inside the circle', () => {
  const st = new SampleStore()
  st.add(s('in', 1000, 1100))
  st.add(s('in', 2000, 2100, 37.7))
  st.add(s('out', 1000, 1100, 40, -122.3)) // ≈ 143 nm north
  st.add(s('left', 1000, 1100)) // was inside…
  st.add(s('left', 2000, 2100, 41, -122.3)) // …now outside
  assert.deepEqual(hexes(st.view(KSFO.lat, KSFO.lon, 40, 0)), ['in@2000'])
  assert.deepEqual(hexes(st.view(KSFO.lat, KSFO.lon, 250, 0)), ['in@2000', 'left@2000', 'out@1000'])
})

test('view(…, since) = every sample received after since, for hexes whose latest is inside', () => {
  const st = new SampleStore()
  st.add(s('a', 1000, 1100, 36.9)) // outside a 40 nm circle, but a's latest is inside
  st.add(s('a', 2000, 2100))
  st.add(s('a', 3000, 3100, 37.62))
  st.add(s('b', 2500, 2600, 41)) // outside
  assert.deepEqual(hexes(st.view(KSFO.lat, KSFO.lon, 40, 1100)), ['a@2000', 'a@3000'])
  assert.deepEqual(hexes(st.view(KSFO.lat, KSFO.lon, 40, 1099)), ['a@1000', 'a@2000', 'a@3000'])
  assert.deepEqual(st.view(KSFO.lat, KSFO.lon, 40, 3100), [])
})

test('track(hex, since) = the samples of one hex received after since, oldest first', () => {
  const st = new SampleStore()
  st.add(s('a', 1000, 1100))
  st.add(s('a', 2000, 2100, 37.7))
  st.add(s('a', 3000, 3100, 37.8))
  st.add(s('b', 3000, 3100))
  assert.deepEqual(st.track('a', 0).map((x) => x.tMs), [1000, 2000, 3000])
  assert.deepEqual(st.track('a', 2100).map((x) => x.tMs), [3000])
  assert.deepEqual(st.track('zzz', 0), [])
})

test('prune drops samples received before now − horizon (180 s by default)', () => {
  const st = new SampleStore()
  st.add(s('a', 1000, 10_000))
  st.add(s('a', 2000, 20_000, 37.7))
  st.add(s('b', 2000, 20_000))
  st.prune(190_000) // cutoff 10_000: rxMs 10_000 is kept
  assert.equal(st.size, 3)
  st.prune(190_001)
  assert.equal(st.size, 2)
  assert.deepEqual(st.track('a', 0).map((x) => x.tMs), [2000])
})

test('prune forgets emptied hexes everywhere, including the Deduper', () => {
  const st = new SampleStore({ horizonMs: 60_000 })
  st.add(s('a', 1000, 1000))
  st.add(s('b', 1000, 50_000))
  st.prune(61_001)
  assert.equal(st.size, 1)
  assert.equal(st.latest('a'), null)
  assert.deepEqual(st.track('a', 0), [])
  assert.deepEqual(hexes(st.view(KSFO.lat, KSFO.lon, 40, 0)), ['b@1000'])
  // the Deduper forgot 'a', so the same position is new again
  assert.equal(st.add(s('a', 1000, 70_000)), true)
  // 'b' was not emptied, so its Deduper memory stays
  assert.equal(st.add(s('b', 1000, 70_000)), false)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test server/store.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/server/store.ts' imported from …/server/store.test.ts`, `ℹ fail 1`.

- [ ] **Step 3: Write the implementation**

```ts
// server/store.ts
import { Deduper } from '../shared/dedupe.ts'
import { distanceNm } from '../shared/geo.ts'
import type { Sample } from '../shared/types.ts'

/**
 * Recent deduped samples per aircraft, kept for horizonMs (default 180 s) of server receipt time (rxMs).
 * Clients poll with `since` = the largest rxMs they have seen, so every answer carries only what is new to them.
 */
export class SampleStore {
  #horizonMs: number
  #byHex = new Map<string, Sample[]>() // arrival order = tMs ascending (the Deduper rejects older samples)
  #dedupe = new Deduper()
  #size = 0

  constructor(opts: { horizonMs?: number } = {}) {
    this.#horizonMs = opts.horizonMs ?? 180_000
  }

  /** false when the Deduper rejects the sample (re-served, older, or unmoved < 100 ms later). */
  add(s: Sample): boolean {
    if (!this.#dedupe.accept(s)) return false
    const list = this.#byHex.get(s.hex)
    if (list) list.push(s)
    else this.#byHex.set(s.hex, [s])
    this.#size++
    return true
  }

  /**
   * Aircraft whose latest position is inside the circle. sinceRxMs ≤ 0: their latest sample only (first poll);
   * otherwise every sample they received after sinceRxMs.
   */
  view(lat: number, lon: number, radiusNm: number, sinceRxMs: number): Sample[] {
    const out: Sample[] = []
    for (const list of this.#byHex.values()) {
      const last = list[list.length - 1]
      if (distanceNm(lat, lon, last.lat, last.lon) > radiusNm) continue
      if (sinceRxMs <= 0) out.push(last)
      else for (const s of list) if (s.rxMs > sinceRxMs) out.push(s)
    }
    return out
  }

  /** Every stored sample of one aircraft received after sinceRxMs, oldest first. */
  track(hex: string, sinceRxMs: number): Sample[] {
    return (this.#byHex.get(hex) ?? []).filter((s) => s.rxMs > sinceRxMs)
  }

  latest(hex: string): Sample | null {
    const list = this.#byHex.get(hex)
    return list ? list[list.length - 1] : null
  }

  /** Drops samples with rxMs < nowMs − horizon; an aircraft left with none is forgotten, Deduper included. */
  prune(nowMs: number): void {
    const cutoff = nowMs - this.#horizonMs
    for (const [hex, list] of this.#byHex) {
      // ponytail: assumes rxMs never decreases within one hex (one poller, one server clock). With several
      // pollers into one store (M6 dual source), switch this to a filter.
      let k = 0
      while (k < list.length && list[k].rxMs < cutoff) k++
      if (k === 0) continue
      this.#size -= k
      if (k === list.length) {
        this.#byHex.delete(hex)
        this.#dedupe.forget(hex)
      } else {
        list.splice(0, k)
      }
    }
  }

  /** Number of stored samples (all aircraft). */
  get size(): number {
    return this.#size
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test server/store.test.ts`
Expected: PASS — `ℹ tests 7`, `ℹ pass 7`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/store.ts server/store.test.ts
git commit -m "feat(server): deduped per-aircraft sample store with since-polling and 180 s horizon" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: WP gate

- [ ] **Step 1: All tests of this package**

Run: `node --test server/cells.test.ts server/store.test.ts`
Expected: `ℹ tests 13`, `ℹ pass 13`, `ℹ fail 0`.

- [ ] **Step 2: Type-check, filtered to this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E '^server/(cells|store)'`
Expected: no output (grep exit status 1).

- [ ] **Step 3: Full check in the worktree (WP-00 + this package)**

Run: `npm run check`
Expected: `tsc` silent; `ℹ tests 54`, `ℹ pass 54`, `ℹ fail 0` (41 WP-00 + 13 here).

- [ ] **Step 4: Nothing left uncommitted**

Run: `git status --short`
Expected: no output. The branch is ready to merge (PLAN.md §5 step 4).

# WP-B-V2 — Fleet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hold every aircraft of the browse view (thousands, up to the 12,000 tar1090 shows worldwide) as its newest sample plus its latest `AircraftInfo`, and hand the scene and the table one `FleetEntry` per aircraft each frame, dead-reckoned to the render time, without allocating per frame.

**Architecture:** One module, `client/browse/fleet.ts`, one class `Fleet` (PLAN.md §5.3 B-V2, exactly, plus one extra accessor `newest(hex)`).
- **State.** A `Map<hex, Slot>` plus two dense parallel arrays, `#slots` and `#out`. A slot holds the reused `FleetEntry`, the newest `Sample`, its `tMs`/`lat`/`lon`, and the dead-reckoning terms that do not change between frames. `#out` holds the same `FleetEntry` objects in the same order, and `entries()` always returns that array.
- **`ingest(samples, info?)`.** A sample replaces the hex's current one only when its `tMs` is newer (older and same-`tMs` samples are ignored, so batch order does not matter). On load, the per-sample fields are written into the entry once: `altFt = altBaroFt ?? altGeomFt`; `hM` = `altGeomFt × 0.3048` when `version === 2` (HAE), else `(altBaroFt ?? altGeomFt) × 0.3048 + nM`, `nM` on the ground or with no altitude; `vsFpm = baroRateFpm ?? geomRateFpm`; `onGround`, `trackDeg`, `gsKt`, `quality`. The slot also precomputes `sin/cos(lat)`, `sin/cos(track)`, `lon` in radians and the angular speed `gs / 3600 / 3440.065` rad/s. The entry is then placed at the time of the last `entries()` call, so `get()` is right before the next frame. Each `info` element replaces the hex's info and is attached to its entry, whether it arrives with, after or before the hex's first sample.
- **`entries(tServerMs)`.** For every slot: `ageS = max(0, (t − tMs) / 1000)`; not moving → the sample position; moving → the great-circle destination of `shared/geo.ts` (same sphere, R = 3440.065 nm) at distance `min(ageS, 20 s) × angular speed`. That costs 4 transcendental calls per aircraft (`sin`, `cos`, `asin`, `atan2`) and no allocation. An aircraft is not moving when track or speed is unknown, when `gs ≤ 0`, or on the ground below 3 kt (a taxiing aircraft moves).
- **`prune(tServerMs, maxAgeS)`.** Removes hexes whose newest `tMs < tServerMs − maxAgeS × 1000` (exactly `maxAgeS` old stays, like `TrackRegistry.prune`) by swap-with-last on both arrays, so the survivors keep their objects. The server sends a hex's info only when it changes (`ViewResponse.info` after `since`), so info outlives its hex by 1 h after the hex's newest sample: an aircraft that leaves the view and comes back still has its callsign. Info that never had a sample is dropped at the next prune.
- **Extra:** `newest(hex): Sample | undefined` returns the hex's newest sample. The integrator can use it as the callsign/type/registration fallback while no info has arrived, or to seed the chase `TrackRegistry` when a row is clicked.

Conventions consumers (B-V1, B-U1, B-A) rely on: the array returned by `entries()` and its objects are **reused** by the next `entries()` and changed by `ingest`/`prune`. Read them in the same frame and never keep them across frames (copy what you need). Order is arbitrary (insertion order, disturbed by swap-removal), so sort for display. `get(hex)` returns the same object as the one in `entries()`. `ageS` never goes negative (a render time before the sample shows the sample position). `info` is `null` until the server has sent it.

**Tech Stack:** TypeScript (erasable only), `node:test`. No Cesium, no DOM: pure data, so there is no harness page. Tests compare against `shared/geo.ts` (`destination`, `distanceNm`, `bearingDeg`) and use `shared/info.ts` `toInfo`.

**Wave:** B1 (parallel with the other seven B-* packages; depends only on WP-B0). Consumed by B-A (feeds it from `/api/view`, calls `entries()` each frame and hands the result to B-V1 `FleetLayer.update` and B-U1 `mountTable().update`). **Estimated:** 1 h. **Validated:** 2026-09-22 in the integrated tree (WP-00 + 26 WPs + WP-V4 orbit + WP-B0, installed `node_modules`, Node 25.2.1, TypeScript 7.0.2) on the user's Mac (Apple silicon):
- `node --test client/browse/fleet.test.ts` → 12/12 pass. `npx tsc --noEmit` reports no errors in `client/browse/fleet*`. Full `npm test` in the shared tree (other B-* packages in progress, up to 527 tests): this package's 12 passed in every run; the only failures were in other packages' unfinished files.
- **Performance:** `entries()` over 10,000 aircraft (9 % unknown track, 2 % on the ground), 300–1,000 frames after a 300-frame warm-up (budget p95 ≤ 2 ms). Run alone, 18 runs: wall p50 0.35–0.43 ms, p95 0.44–1.07 ms (the upper end while other agents loaded the machine); CPU p95 0.59–0.74 ms. Inside a full parallel `npm test` at load average 13: wall p95 3.1–4.1 ms (the process was descheduled mid-call), CPU p50 0.46–0.52 ms, CPU p95 ≈ 1.0 ms. The test therefore checks the budget on CPU time per call (`process.cpuUsage`, 1 µs resolution, 0.3 µs per read) and reports both. **Allocation:** 3,000 frames × 10,000 aircraft under `--expose-gc` triggered 0 GCs and grew the heap by 79 KiB in total (an empty loop grew it by 5.7 KiB), so nothing is allocated per aircraft.
- **Mutations:** 15 hand-made faults, all caught (1–4 failing tests each): no 20 s clamp, flat-earth dead-reckoning, same-`tMs` accepted, parked aircraft moving, v2 geom ignored, ground not at N, `vsFpm` geom-first, negative `ageS`, info not attached, no info keep, no reckoning on ingest, prune off by one, broken swap-removal, a new array per `entries()`, `newest` not stored.
- **Replay:** the plan's code blocks were extracted into an isolated copy (WP-00 + WP-B0 type files only): Task 1 Step 2 failed as written, Step 4 passed 12/12, and `tsc --noEmit` was clean.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- This package creates only the two files below. It reads `shared/types.ts` (`Sample`), `shared/info.ts` (`AircraftInfo`, WP-B0) and `client/types.ts` (`FleetEntry`, WP-B0).
- Heights are WGS84 ellipsoidal metres (HAE). `alt_geom` is HAE only when `version === 2`; otherwise baro + N (`Sample.nM`).
- Unit tests need no WebGL and no network.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `client/browse/fleet.ts` | `class Fleet`: newest sample + info per hex, dead-reckoned reused `FleetEntry`s, prune |
| `client/browse/fleet.test.ts` | dead-reckoning distance/direction/clamp, ground and unknowns, altitude fields, newest-only, info merge and keep, prune, object reuse, 10,000-aircraft benchmark |

---

### Task 1: Fleet

**Files:**
- Create: `client/browse/fleet.ts`, `client/browse/fleet.test.ts`
- Test: `client/browse/fleet.test.ts`

**Interfaces:**
- Consumes: `Sample` (`shared/types.ts`, WP-00), `AircraftInfo` + `toInfo` (`shared/info.ts`, WP-B0), `FleetEntry` (`client/types.ts`, WP-B0), `destination`/`distanceNm`/`bearingDeg` (`shared/geo.ts`, WP-00, tests only)
- Produces: `class Fleet { ingest(samples: Sample[], info?: AircraftInfo[]): void; entries(tServerMs: number): readonly FleetEntry[]; get(hex: string): FleetEntry | undefined; prune(tServerMs: number, maxAgeS: number): void; get size(): number }` (PLAN.md §5.3 B-V2, exactly) plus `newest(hex: string): Sample | undefined`

- [ ] **Step 1: Write the failing test**

```ts
// client/browse/fleet.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bearingDeg, destination, distanceNm } from '../../shared/geo.ts'
import { toInfo } from '../../shared/info.ts'
import type { Sample } from '../../shared/types.ts'
import { Fleet } from './fleet.ts'

const near = (a: number, b: number, tol: number, msg = ''): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol}) ${msg}`)
const FT = 0.3048
const T0 = 1_790_000_000_000

const BASE: Sample = {
  hex: 'abc123', tMs: T0, rxMs: T0, lat: 32, lon: 34.8, onGround: false,
  altBaroFt: 35000, altGeomFt: 35500, gsKt: 360, trackDeg: 90, trueHeadingDeg: null, rollDeg: null,
  baroRateFpm: -500, geomRateFpm: -480, navQnhHpa: null, version: 2, nic: 8, quality: 'adsb2', nM: 19.6,
  callsign: 'ELY001', typeCode: 'B738', reg: '4X-EKA',
}
const smp = (o: Partial<Sample> = {}): Sample => ({ ...BASE, ...o })

test('dead-reckons along track at ground speed: 360 kt for 10 s is 1 nm due east on the great circle', () => {
  const f = new Fleet()
  f.ingest([smp()])
  const [e] = f.entries(T0 + 10_000)
  const want = destination(32, 34.8, 90, 1)
  near(e.lat, want.lat, 1e-9)
  near(e.lon, want.lon, 1e-9)
  near(distanceNm(32, 34.8, e.lat, e.lon), 1, 1e-9)
  near(bearingDeg(32, 34.8, e.lat, e.lon), 90, 1e-6)
  assert.equal(e.ageS, 10)
})

test('direction follows the track in every quadrant, across the antimeridian and the equator', () => {
  const cases: [number, number, number][] = [[60, 10, 225], [-33.9, 151.2, 30], [51.5, 179.99, 80], [0.001, 0, 180], [45, -73, 315]]
  for (const [lat, lon, trk] of cases) {
    const f = new Fleet()
    f.ingest([smp({ lat, lon, trackDeg: trk, gsKt: 480 })])
    const [e] = f.entries(T0 + 15_000) // 480 kt × 15 s = 2 nm
    const want = destination(lat, lon, trk, 2)
    near(e.lat, want.lat, 1e-9, `lat from ${lat},${lon} trk ${trk}`)
    near(e.lon, want.lon, 1e-9, `lon from ${lat},${lon} trk ${trk}`)
    near(distanceNm(lat, lon, e.lat, e.lon), 2, 1e-9)
  }
})

test('dead-reckoning stops 20 s after the newest sample; before the sample the sample position is used', () => {
  const f = new Fleet()
  f.ingest([smp()])
  const at20 = { ...f.entries(T0 + 20_000)[0] }
  const at90 = f.entries(T0 + 90_000)[0]
  assert.equal(at90.lat, at20.lat)
  assert.equal(at90.lon, at20.lon)
  near(distanceNm(32, 34.8, at90.lat, at90.lon), 2, 1e-9)
  assert.equal(at90.ageS, 90) // the age keeps counting
  const early = f.entries(T0 - 5_000)[0]
  assert.equal(early.lat, 32)
  assert.equal(early.lon, 34.8)
  assert.equal(early.ageS, 0)
})

test('no motion when parked on the ground (< 3 kt) or when track or speed is unknown; taxiing moves', () => {
  const f = new Fleet()
  const ground = { onGround: true, altBaroFt: null, altGeomFt: null }
  f.ingest([
    smp({ hex: 'a00001', ...ground, gsKt: 2.9 }),
    smp({ hex: 'a00002', ...ground, gsKt: 15, trackDeg: 0 }),
    smp({ hex: 'a00003', trackDeg: null }),
    smp({ hex: 'a00004', gsKt: null }),
  ])
  f.entries(T0 + 10_000)
  const g = (hex: string) => f.get(hex)!
  for (const hex of ['a00001', 'a00003', 'a00004']) {
    assert.equal(g(hex).lat, 32, hex)
    assert.equal(g(hex).lon, 34.8, hex)
    assert.equal(g(hex).ageS, 10, hex)
  }
  near(distanceNm(32, 34.8, g('a00002').lat, g('a00002').lon), (15 * 10) / 3600, 1e-12)
  near(g('a00002').lon, 34.8, 1e-9) // due north
  assert.ok(g('a00002').lat > 32)
  assert.equal(g('a00001').onGround, true)
  assert.equal(g('a00001').hM, 19.6) // on the ground: the geoid
  assert.equal(g('a00001').altFt, null)
})

test('altitude fields: altFt = baro ?? geom; hM = geom (v2 HAE) else baro + N; vsFpm = baro rate ?? geom rate', () => {
  const f = new Fleet()
  f.ingest([
    smp({ hex: 'b00001' }), // v2: geom is HAE
    smp({ hex: 'b00002', version: 1 }), // v0/v1: geom is not HAE → baro + N
    smp({ hex: 'b00003', altGeomFt: null }), // v2 without geom → baro + N
    smp({ hex: 'b00004', version: 0, altBaroFt: null, baroRateFpm: null }), // geom only, not HAE → geom + N
    smp({ hex: 'b00005', altBaroFt: null, altGeomFt: null, baroRateFpm: null, geomRateFpm: null, version: null }),
    smp({ hex: 'b00006', onGround: true, altBaroFt: null, altGeomFt: 120, gsKt: 0 }), // ground wins over geom
  ])
  f.entries(T0)
  const g = (hex: string) => f.get(hex)!
  near(g('b00001').hM, 35500 * FT, 1e-9)
  near(g('b00002').hM, 35000 * FT + 19.6, 1e-9)
  near(g('b00003').hM, 35000 * FT + 19.6, 1e-9)
  near(g('b00004').hM, 35500 * FT + 19.6, 1e-9)
  assert.equal(g('b00005').hM, 19.6)
  assert.equal(g('b00006').hM, 19.6)
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((i) => g(`b0000${i}`).altFt), [35000, 35000, 35000, 35500, null, 120])
  assert.deepEqual([1, 4, 5].map((i) => g(`b0000${i}`).vsFpm), [-500, -480, null])
  assert.deepEqual({ ...g('b00001'), hM: 0 }, {
    hex: 'b00001', lat: 32, lon: 34.8, hM: 0, altFt: 35000, onGround: false, trackDeg: 90, gsKt: 360,
    vsFpm: -500, ageS: 0, quality: 'adsb2', info: null,
  })
})

test('keeps only the newest sample per hex: older and same-tMs samples are ignored, in any batch order', () => {
  const f = new Fleet()
  f.ingest([smp({ tMs: T0 + 5_000, lat: 33, trackDeg: null }), smp({ tMs: T0, lat: 31 })])
  f.ingest([smp({ tMs: T0 + 5_000, lat: 40 }), smp({ tMs: T0 + 1_000, lat: 41 })])
  assert.equal(f.size, 1)
  assert.equal(f.entries(T0 + 5_000)[0].lat, 33)
  const s6 = smp({ tMs: T0 + 6_000, lat: 34, trackDeg: null, quality: 'mlat' })
  f.ingest([s6])
  const e = f.entries(T0 + 6_000)[0]
  assert.equal(e.lat, 34)
  assert.equal(e.quality, 'mlat')
  assert.equal(f.newest('abc123'), s6)
  assert.equal(f.newest('ffffff'), undefined)
})

test('a newer sample updates the entry at once (get() is right before the next entries())', () => {
  const f = new Fleet()
  f.ingest([smp({ trackDeg: null })])
  f.entries(T0 + 3_000)
  f.ingest([smp({ tMs: T0 + 2_000, lat: 32.5, trackDeg: null, altBaroFt: 1000 })])
  const e = f.get('abc123')!
  assert.equal(e.lat, 32.5)
  assert.equal(e.altFt, 1000)
  assert.equal(e.ageS, 1) // measured at the last entries() time
})

test('info: the latest AircraftInfo per hex is attached to its entry, arriving with, after or before the sample', () => {
  const f = new Fleet()
  const i1 = toInfo({ hex: 'abc123', flight: 'ELY001', squawk: '1000' })
  f.ingest([smp()], [i1])
  const e = f.get('abc123')!
  assert.equal(e.info, i1)
  const i2 = { ...i1, squawk: '7700' }
  f.ingest([], [i2])
  assert.equal(f.get('abc123'), e) // same object, new info
  assert.equal(e.info, i2)
  f.ingest([smp({ tMs: T0 + 1_000 })]) // a reply without info keeps the info
  assert.equal(e.info, i2)
  const early = toInfo({ hex: 'def456', flight: 'LY001' })
  f.ingest([], [early])
  assert.equal(f.get('def456'), undefined) // info alone is not an aircraft
  assert.equal(f.size, 1)
  f.ingest([smp({ hex: 'def456' })])
  assert.equal(f.get('def456')!.info, early)
})

test('prune forgets hexes whose newest sample is older than maxAgeS; the others keep their objects and positions', () => {
  const f = new Fleet()
  f.ingest([smp({ hex: 'a00001', tMs: T0 }), smp({ hex: 'a00002', tMs: T0 + 30_000 }), smp({ hex: 'a00003', tMs: T0 + 50_000 })])
  const e2 = f.get('a00002')!
  const e3 = f.get('a00003')!
  f.prune(T0 + 70_000, 60)
  assert.equal(f.size, 2)
  assert.equal(f.get('a00001'), undefined)
  assert.deepEqual(f.entries(T0 + 70_000).map((e) => e.hex).sort(), ['a00002', 'a00003'])
  assert.equal(f.get('a00002'), e2)
  f.prune(T0 + 90_000, 60) // exactly maxAgeS old stays
  assert.equal(f.size, 2)
  f.prune(T0 + 90_001, 60)
  const left = f.entries(T0 + 90_001)
  assert.deepEqual(left.map((e) => e.hex), ['a00003'])
  assert.equal(left[0], e3)
  near(distanceNm(32, 34.8, e3.lat, e3.lon), 2, 1e-9) // 40 s old → clamped to 20 s → 2 nm
  f.prune(T0 + 1e9, 60)
  assert.equal(f.size, 0)
  assert.equal(f.entries(T0 + 1e9).length, 0)
})

test('prune: info outlives its hex for an hour, because the server resends info only when it changes', () => {
  const f = new Fleet()
  const info = toInfo({ hex: 'abc123', flight: 'ELY001' })
  f.ingest([smp()], [info])
  f.prune(T0 + 120_000, 60)
  assert.equal(f.size, 0)
  f.ingest([smp({ tMs: T0 + 600_000 })]) // back 10 min later, no info in this reply
  assert.equal(f.get('abc123')!.info, info)
  f.prune(T0 + 700_000, 60) // gone again; its newest sample was T0 + 600 s
  f.prune(T0 + 600_000 + 3_600_000, 60) // exactly an hour: still kept
  f.ingest([smp({ tMs: T0 + 4_100_000 })])
  assert.equal(f.get('abc123')!.info, info)
  f.prune(T0 + 4_200_000, 60)
  f.prune(T0 + 4_100_000 + 3_600_001, 60) // more than an hour after its newest sample: forgotten
  f.ingest([smp({ tMs: T0 + 8_000_000 })])
  assert.equal(f.get('abc123')!.info, null)
  f.ingest([], [toInfo({ hex: 'fff000' })]) // info for a hex that never showed up goes at the next prune
  f.prune(T0 + 8_000_000, 60)
  f.ingest([smp({ hex: 'fff000', tMs: T0 + 8_000_001 })])
  assert.equal(f.get('fff000')!.info, null)
})

test('entries() reuses one array and one object per aircraft between frames (no per-frame allocation)', () => {
  const f = new Fleet()
  f.ingest([smp({ hex: 'a00001' }), smp({ hex: 'a00002', trackDeg: 0 })])
  const a = f.entries(T0 + 1_000)
  const objs = [...a]
  const lat2 = f.get('a00002')!.lat
  const b = f.entries(T0 + 2_000)
  assert.equal(b, a)
  assert.equal(b.length, 2)
  b.forEach((e, i) => assert.equal(e, objs[i]))
  assert.ok(f.get('a00002')!.lat > lat2) // moved north in place
  assert.equal(f.get('a00001'), objs.find((e) => e.hex === 'a00001'))
  f.ingest([smp({ hex: 'a00001', tMs: T0 + 1_500 })]) // a newer sample updates the same object
  const c = f.entries(T0 + 3_000)
  assert.equal(c, a)
  c.forEach((e, i) => assert.equal(e, objs[i]))
  f.ingest([smp({ hex: 'a00003' })]) // a new hex joins the same array
  assert.equal(f.entries(T0 + 3_000), a)
  assert.equal(a.length, 3)
})

test('perf: entries() for 10,000 aircraft, CPU p95 ≤ 2 ms', (t) => {
  const f = new Fleet()
  const samples: Sample[] = []
  for (let i = 0; i < 10_000; i++) {
    samples.push(smp({
      hex: i.toString(16).padStart(6, '0'),
      tMs: T0 - (i % 15) * 1_000,
      lat: -70 + (i % 140),
      lon: -180 + i * 0.036,
      trackDeg: i % 11 === 0 ? null : (i * 37) % 360,
      gsKt: 80 + (i % 420),
      onGround: i % 50 === 0,
    }))
  }
  f.ingest(samples)
  assert.equal(f.size, 10_000)
  for (let i = 0; i < 300; i++) f.entries(T0 + i * 16) // warm up the JIT
  // Wall time is reported; the budget is checked on this process's CPU time per call, which a busy machine (npm test
  // runs the test files in parallel next to other work) cannot inflate by descheduling us mid-call.
  const pct = (xs: number[], q: number): number => xs[Math.floor(xs.length * q)]
  const wallMs: number[] = []
  const cpuMs: number[] = []
  for (let i = 0; i < 500; i++) {
    const c0 = process.cpuUsage()
    const t0 = performance.now()
    f.entries(T0 + 5_000 + i * 16)
    wallMs.push(performance.now() - t0)
    const c = process.cpuUsage(c0)
    cpuMs.push((c.user + c.system) / 1000)
  }
  wallMs.sort((x, y) => x - y)
  cpuMs.sort((x, y) => x - y)
  t.diagnostic(`entries() × 10,000 aircraft: wall p50 ${pct(wallMs, 0.5).toFixed(3)} ms, p95 ${pct(wallMs, 0.95).toFixed(3)} ms; ` +
    `CPU p50 ${pct(cpuMs, 0.5).toFixed(3)} ms, p95 ${pct(cpuMs, 0.95).toFixed(3)} ms`)
  assert.ok(pct(cpuMs, 0.95) <= 2, `CPU p95 ${pct(cpuMs, 0.95)} ms`)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/browse/fleet.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/browse/fleet.ts' imported from …/client/browse/fleet.test.ts`

- [ ] **Step 3: Write the implementation**

```ts
// client/browse/fleet.ts
// Every aircraft in the browse view: its newest sample, dead-reckoned to the render time. Built for thousands of
// aircraft per frame: one reused array of reused FleetEntry objects, the trig that does not change between frames
// done once per sample, and no allocation in entries(). The full estimator (Track) runs only for the chased aircraft.
import type { AircraftInfo } from '../../shared/info.ts'
import type { Sample } from '../../shared/types.ts'
import type { FleetEntry } from '../types.ts'

const FT = 0.3048
const R_NM = 3440.065 // the sphere of shared/geo.ts destination(), so both agree
const RAD = Math.PI / 180
const DEG = 180 / Math.PI
const MAX_AHEAD_S = 20 // dead-reckon at most this far past the newest sample, then hold
const PARKED_KT = 3 // on the ground and slower than this: not moving
// The server sends an aircraft's info only when it changes, so a hex that drops out of the view and comes back must
// find its info here. ponytail: fixed 1 h after its newest sample; enough for panning away and back, and it bounds
// memory for worldwide views (~0.3 kB per hex). Upgrade: ask the server for info of hexes that have none.
const INFO_KEEP_MS = 3_600_000

interface Slot {
  e: FleetEntry // the reused output object
  s: Sample | null // newest sample
  tMs: number // newest sample time, server clock
  lat: number // newest sample position, degrees
  lon: number
  moving: boolean // track and speed known, and not parked
  // Great-circle destination terms that do not depend on the distance (see shared/geo.ts destination()).
  sinLat: number
  cosLat: number
  sinTrk: number
  cosTrk: number
  lonRad: number
  radPerS: number // angular speed along the great circle, radians per second
}

interface InfoRec {
  info: AircraftInfo
  seenMs: number // newest sample tMs of the hex when it was pruned; -Infinity while it has none
}

/** Height of the aircraft in WGS84 ellipsoidal metres: geom when it is HAE (v2), else baro (or geom) + N, ground → N. */
function heightM(s: Sample): number {
  if (s.onGround) return s.nM
  if (s.version === 2 && s.altGeomFt !== null) return s.altGeomFt * FT
  const ft = s.altBaroFt ?? s.altGeomFt
  return ft === null ? s.nM : ft * FT + s.nM
}

function load(slot: Slot, s: Sample): void {
  const e = slot.e
  slot.s = s
  slot.tMs = s.tMs
  slot.lat = s.lat
  slot.lon = s.lon
  e.hM = heightM(s)
  e.altFt = s.altBaroFt ?? s.altGeomFt
  e.onGround = s.onGround
  e.trackDeg = s.trackDeg
  e.gsKt = s.gsKt
  e.vsFpm = s.baroRateFpm ?? s.geomRateFpm
  e.quality = s.quality
  const trk = s.trackDeg
  const gs = s.gsKt
  slot.moving = trk !== null && gs !== null && gs > 0 && !(s.onGround && gs < PARKED_KT)
  if (!slot.moving) return
  const lat = s.lat * RAD
  const t = trk! * RAD
  slot.sinLat = Math.sin(lat)
  slot.cosLat = Math.cos(lat)
  slot.sinTrk = Math.sin(t)
  slot.cosTrk = Math.cos(t)
  slot.lonRad = s.lon * RAD
  slot.radPerS = gs! / 3600 / R_NM
}

/** Moves the entry to tMs: along the track at ground speed for (tMs − sample) seconds, clamped to 0…MAX_AHEAD_S. */
function reckon(slot: Slot, tMs: number): void {
  const e = slot.e
  const ageS = (tMs - slot.tMs) / 1000
  e.ageS = ageS > 0 ? ageS : 0
  if (!slot.moving || ageS <= 0) {
    e.lat = slot.lat
    e.lon = slot.lon
    return
  }
  const d = (ageS < MAX_AHEAD_S ? ageS : MAX_AHEAD_S) * slot.radPerS
  const sinD = Math.sin(d)
  const cosD = Math.cos(d)
  const sinLat2 = slot.sinLat * cosD + slot.cosLat * sinD * slot.cosTrk
  e.lat = Math.asin(sinLat2) * DEG
  const lon = (slot.lonRad + Math.atan2(slot.sinTrk * sinD * slot.cosLat, cosD - slot.sinLat * sinLat2)) * DEG
  e.lon = ((lon + 540) % 360) - 180
}

export class Fleet {
  readonly #byHex = new Map<string, Slot>()
  readonly #slots: Slot[] = [] // dense, same order as #out
  readonly #out: FleetEntry[] = [] // what entries() returns, always the same array
  readonly #info = new Map<string, InfoRec>()
  #lastTMs: number | null = null // time of the last entries() call

  /** Keeps the newest sample per hex (older and same-tMs samples are ignored) and the latest info per hex. */
  ingest(samples: Sample[], info?: AircraftInfo[]): void {
    for (const s of samples) {
      let slot = this.#byHex.get(s.hex)
      if (slot === undefined) slot = this.#add(s.hex)
      else if (s.tMs <= slot.tMs) continue
      load(slot, s)
      reckon(slot, this.#lastTMs ?? s.tMs)
    }
    if (info === undefined) return
    for (const i of info) {
      const rec = this.#info.get(i.hex)
      if (rec === undefined) this.#info.set(i.hex, { info: i, seenMs: -Infinity })
      else rec.info = i
      const slot = this.#byHex.get(i.hex)
      if (slot !== undefined) slot.e.info = i
    }
  }

  /**
   * Every aircraft dead-reckoned to tServerMs. The array and its objects are reused by the next call (and changed by
   * ingest/prune): read them now, never keep them across frames.
   */
  entries(tServerMs: number): readonly FleetEntry[] {
    this.#lastTMs = tServerMs
    const slots = this.#slots
    for (let i = 0; i < slots.length; i++) reckon(slots[i], tServerMs)
    return this.#out
  }

  /** The hex's entry as of the last entries() call (or its newest sample, if that is newer). */
  get(hex: string): FleetEntry | undefined {
    return this.#byHex.get(hex)?.e
  }

  /** The hex's newest sample (e.g. its callsign when no info has arrived, or a seed for the chase estimator). */
  newest(hex: string): Sample | undefined {
    return this.#byHex.get(hex)?.s ?? undefined
  }

  /** Forgets hexes whose newest sample is more than maxAgeS older than tServerMs. */
  prune(tServerMs: number, maxAgeS: number): void {
    const cutoff = tServerMs - maxAgeS * 1000
    const slots = this.#slots
    const out = this.#out
    for (let i = slots.length - 1; i >= 0; i--) {
      const slot = slots[i]
      if (slot.tMs >= cutoff) continue
      const last = slots.pop()!
      const lastE = out.pop()!
      if (last !== slot) {
        slots[i] = last
        out[i] = lastE
      }
      this.#byHex.delete(slot.e.hex)
      const rec = this.#info.get(slot.e.hex)
      if (rec !== undefined) rec.seenMs = slot.tMs
    }
    for (const [hex, rec] of this.#info) {
      if (rec.seenMs < tServerMs - INFO_KEEP_MS && !this.#byHex.has(hex)) this.#info.delete(hex)
    }
  }

  get size(): number {
    return this.#slots.length
  }

  #add(hex: string): Slot {
    const e: FleetEntry = {
      hex, lat: 0, lon: 0, hM: 0, altFt: null, onGround: false, trackDeg: null, gsKt: null, vsFpm: null, ageS: 0,
      quality: 'other', info: this.#info.get(hex)?.info ?? null,
    }
    const slot: Slot = {
      e, s: null, tMs: -Infinity, lat: 0, lon: 0, moving: false,
      sinLat: 0, cosLat: 1, sinTrk: 0, cosTrk: 1, lonRad: 0, radPerS: 0,
    }
    this.#byHex.set(hex, slot)
    this.#slots.push(slot)
    this.#out.push(e)
    return slot
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/browse/fleet.test.ts`
Expected: PASS — `ℹ tests 12`, `ℹ pass 12`, `ℹ fail 0`, and a diagnostic line like `ℹ entries() × 10,000 aircraft: wall p50 0.383 ms, p95 0.743 ms; CPU p50 0.383 ms, p95 0.594 ms`. The test asserts CPU p95 ≤ 2 ms. Wall time is only reported, because a busy machine inflates it.

- [ ] **Step 5: Commit**

```bash
git add client/browse/fleet.ts client/browse/fleet.test.ts
git commit -m "feat(browse): Fleet — newest sample per hex, dead-reckoned reused entries for thousands of aircraft"
```

---

### Task 2: WP gate

- [ ] **Step 1: This package's tests**

Run: `node --test client/browse/fleet.test.ts`
Expected: `ℹ tests 12`, `ℹ pass 12`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/browse/fleet'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Full check**

Run: `npm run check`
Expected: `tsc` prints nothing, and every test passes. On WP-B0's tree (460 tests) plus this package, that is `ℹ tests 472`, `ℹ pass 472`, `ℹ fail 0`. With other B-* packages merged, the total is higher and `fail` is still 0.

- [ ] **Step 4: Confirm there is nothing left to commit**

Run: `git status --short`
Expected: no output.

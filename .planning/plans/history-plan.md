# History (flown path + time travel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use
> `- [ ]`. Design: `.planning/history-design.md`. Research: `.planning/reports/historical-positions-research.md`.

**Goal:** the selected aircraft's flown path since take-off, and a History mode that replays every aircraft in view at
any time of the last ~30 days, from adsb.lol's keyless heatmap and trace files.

**Architecture:** the server fetches and caches adsb.lol files and answers small JSON (`HistorySlot`, `TraceReply` in
`shared/api.ts`); the client turns them into ordinary `Sample`s and plays them through the live pipeline (Fleet,
TrackRegistry, card, chase) on a replay clock.

**Tech stack:** TypeScript run directly by Node ≥ 24.2 (`node --test`, type stripping: no enums, no parameter
properties, `.ts` import suffixes), Cesium 1.145 on the client, no new dependencies.

## Global constraints

- Worktree `/Users/rgv250cc/Documents/Projects/FlightHopper-liveries`, branch `feat/history`. Several workers run at once
  in it: touch ONLY the files your task lists. Do not run `git add`/`git commit` (the lead commits after review).
- Test one file: `node --test path/to/x.test.ts`. Typecheck: `npx tsc --noEmit` (whole project: ignore errors in files
  another task owns, fix every error in yours). Do not run the whole suite.
- Style: match the surrounding code: a header comment saying what the file is for, comments in plain short sentences,
  `ponytail:` comments for deliberate shortcuts with their ceiling. Tests use `node:test` + `node:assert/strict`.
- Shared contracts (already written, do not change): `shared/api.ts` → `HistoryTrack`, `HistorySlot`, `HistoryStatus`,
  `TraceReply`, `ChaseResponse.origin`; `shared/history.ts` → `SLOT_MS`, `PUBLISH_DELAY_MS`, `slotOf`, `newestSlotMs`,
  `stepFor`. Geoid: `shared/geoid.ts` → `geoidN(lat, lon)`. Geometry: `shared/geo.ts` → `distanceNm`, `bearingDeg`,
  `destination`. Altitude colours: `client/scene/altitudeColor.ts`.
- Network: never call adsb.lol (or anything) from tests: inject `fetchFn`.
- Numbers in JSON replies: lat/lon 5 decimals, speeds 0.1, geoid N 0.1, times in the units the type says.

## File map

| File | Task | Responsibility |
|---|---|---|
| `server/heatmap.ts` (+test) | A | read a decompressed heatmap file into a `HistorySlot` for one circle |
| `server/historyStore.ts` (+test) | A | fetch, dedupe, memory cache (≤ 4, newest 2 pinned), rolling `tick()`, `status()` |
| `server/trace.ts` (+test) | B | trace URL, leg cut, `TraceReply`, small cache |
| `client/history/clock.ts` (+test) | C | replay clock |
| `client/history/feed.ts` (+test) | C | loaded slots → `Sample`s, infos |
| `client/scene/routeLine.ts` (+test) | D | altitude-coloured path, gaps, lead-in, first-heard label |
| `client/ui/playbar.ts`, `playbar.css`, `client/ui/icons.ts`, `client/history/bar.ts`, `client/history/bar.css` (+test) | E | time bar + Go to popover |
| `server/main.ts`, `server/infoStore.ts`, `client/api.ts`, `client/ui/urlState.ts`, `client/ui/flightCard.ts`, `client/app.ts`, `client/ui/layout.css` | lead | endpoints, origin, API client, URL, card status, integration |

---

### Task A: heatmap reader and history store (server)

**Files:** create `server/heatmap.ts`, `server/heatmap.test.ts`, `server/historyStore.ts`, `server/historyStore.test.ts`.

**Interfaces (produce):**
```ts
// server/heatmap.ts
export const HEAT_MAGIC = 0x0e7f7c9d
export interface HeatRecordIn { hex: string; lat: number; lon: number; alt: number | 'g' | null; gs: number | null }
export interface HeatIdentIn { hex: string; callsign: string | null; squawk: string | null }
export interface HeatSliceIn { tMs: number; records: (HeatRecordIn | HeatIdentIn)[] }
/** Test/tool helper: a decompressed heatmap file (index records first, as readsb writes them). */
export function encodeHeatmap(slices: HeatSliceIn[], intervalMs?: number): Uint8Array
/** One pass over a decompressed file: the positions in the circle, every stepS. null if no slice header. */
export function readSlot(buf: Uint8Array, q: { lat: number; lon: number; nm: number; stepS: number }): HistorySlot | null

// server/historyStore.ts
export interface HistoryStoreOpts {
  base?: string                  // default 'https://adsb.lol'
  userAgent: string
  fetchFn?: typeof fetch
  nowMs?: () => number
  maxSlots?: number              // default 4 (the newest 2 count, and are never dropped)
}
export function heatmapUrl(base: string, slotMs: number): string // `${base}/globe_history/YYYY/MM/DD/heatmap/NN.bin.ttf`
export class HistoryStore {
  constructor(o: HistoryStoreOpts)
  /** The decompressed file of the half hour starting at slotMs; null: not published (404) or too new. Dedupes concurrent calls. */
  file(slotMs: number): Promise<Uint8Array | null>
  /** readSlot of file(slotMs) for the circle; null when the file is missing. */
  query(slotMs: number, q: { lat: number; lon: number; nm: number }): Promise<HistorySlot | null>
  /** The rolling fetch: ensures the newest two published slots are held (call every minute from a live server). */
  tick(): Promise<void>
  status(): HistoryStatus
}
```

**File format (verified in readsb `globe_index.c` handleHeatmap and tar1090 `script.js` initReplay/replayStep):**
an array of 16-byte little-endian records. The first records (until the first magic) are an index: skip them. A
slice header is `[0x0e7f7c9d, time ms high 32 bits (uint), time ms low 32 bits (uint), interval ms in the low 16 bits]`.
After it, until the next header, each record is `[w0 uint32, w1 int32, w2 int32, w3]`:
- `w0`: address in bits 0–23 (`hex = (w0 & 0xffffff).toString(16).padStart(6, '0')`), bit 24 = non-ICAO (prefix `~`).
- If `w1 >= 1 << 30`: an ident record. Squawk = `(w1 & 0xffff)` as decimal digits, `padStart(4, '0')`. Callsign = the
  8 ASCII bytes at offset +8 when the first is not 0, trailing spaces and NULs trimmed (empty → null).
- Else a position: `lat = w1 / 1e6`, `lon = int32 at +8 / 1e6`, `alt = int16 at +12` (−123 ground → `'g'`, −124 unknown →
  `null`, else × 25 ft), `gs = int16 at +14` (−1 → null, else / 10 kt).

**readSlot rules:** `slotMs = slotOf(first slice time)`. Keep a slice when `Math.round((tMs − slotMs) / 1000) % stepS === 0`.
Keep a position when `nm >= 5400` (everything) or `distanceNm(q.lat, q.lon, lat, lon) <= nm` (prefilter: skip when
`|lat − q.lat| > nm / 60 + 0.1`). Per hex, columns in time order: `t` = seconds after slotMs (integer), lat/lon 5
decimals, alt, gs 0.1. `nM` = `geoidN` at the hex's first kept position, 0.1. Callsign/squawk: the hex's newest ident
record anywhere in the file (also in slices not kept). Aircraft with no kept position are left out. Output aircraft
sorted by hex (stable tests).

**HistoryStore rules:** URL from `heatmapUrl` (NN = 2 × UTC hour + (minute ≥ 30)). Request headers `user-agent`,
`accept-encoding: gzip`. A 200 body: `new Uint8Array(await res.arrayBuffer())`; if it starts with `1f 8b` gunzip it
(`zlib.gunzipSync`; fetch already undoes `Content-Encoding: gzip`, theairtraffic-style raw files arrive plain). 404 (or
410): remember "missing" for 10 min, return null. Other failures (status ≥ 400, network error): return null, do not
remember. A slot newer than `newestSlotMs(now)` → null without fetching. Concurrent `file()` calls for one slot share
one fetch. Keep at most `maxSlots` files: on insert, drop the least recently used one that is not one of the newest two
published slots. `status()`: `newestSlotMs(now)` and every slot held ('ready'), being fetched ('loading') or remembered
missing ('missing'), sorted by slotMs. `tick()`: `file(newest)` and `file(newest − SLOT_MS)` (sequentially).

- [ ] Write `server/heatmap.test.ts` first: (1) encode two slices 10 s apart with 3 aircraft (one non-ICAO, one on the
  ground, one with unknown alt and gs) + an ident record (callsign `'ELY397  '`, squawk 7500) → `readSlot` with a
  circle holding two of them gives exactly those, columns as specified, `squawk '7500'`, callsign `'ELY397'`, the
  non-ICAO hex `'~abc123'`, alt `'g'`/`null`, gs `null`; (2) `stepS: 20` with slices at +0, +10, +20 keeps +0 and +20;
  (3) the index records before the first header are ignored (encodeHeatmap writes one per slice); (4) `nm: 5400` keeps
  a position 6,000 nm away; (5) a buffer with no header → null.
- [ ] Run it: fails (module missing). Implement `heatmap.ts`. Run: passes.
- [ ] Write `server/historyStore.test.ts`: fake `fetchFn` counting calls and returning (a) a gzipped encodeHeatmap
  buffer, (b) a plain one, (c) 404. Cases: the URL for `2026-09-30T04:00Z` ends `globe_history/2026/09/30/heatmap/08.bin.ttf`;
  both bodies decode; two concurrent `file()` calls → one fetch; a 404 is not refetched within 10 min and is after;
  a slot newer than newestSlotMs → null with no fetch; with `maxSlots: 3`, loading 4 old slots keeps the newest two
  published (after `tick()`) plus the last used; `status()` lists ready/loading/missing; `query()` returns readSlot's
  result.
- [ ] Run, implement, run until green. `npx tsc --noEmit`: no errors in your files.

### Task B: traces (server)

**Files:** create `server/trace.ts`, `server/trace.test.ts`.

**Interfaces (produce):**
```ts
export interface TraceStoreOpts { base?: string; userAgent: string; fetchFn?: typeof fetch; nowMs?: () => number }
/** The live file (atMs within the last 24 h) or the day file of atMs's UTC date. */
export function traceUrl(base: string, hex: string, atMs: number, nowMs: number): string
/** The leg flying at atMs (the last leg starting at or before it), as a TraceReply; null when the file has no point then. */
export function traceReply(json: unknown, hex: string, atMs: number): TraceReply | null
export class TraceStore {
  constructor(o: TraceStoreOpts)
  /** null: no trace (404) or no leg at atMs. Cached: a live file 30 s, a day file 1 h (≤ 50 entries). */
  get(hex: string, atMs: number): Promise<TraceReply | null>
}
```

**Trace file (readsb README-json "trace jsons"):** `{ icao, r?, t?, desc?, timestamp (s, float), trace: [[dtS, lat, lon,
alt (ft | "ground" | null), gs, track, flags, vrate, acObj | null, source?, geomAlt?, geomRate?, ias?, roll?], …] }`.
Flags: `& 1` stale, `& 2` start of a new leg, `& 4` vrate is geometric, `& 8` altitude is geometric. `<xx>` in the URL =
the last two hex digits (`~` addresses keep the `~` in the file name: `trace_full_~abc123.json`, folder from the last two
digits). Live: `${base}/data/traces/<xx>/trace_full_<hex>.json` when `nowMs − atMs < 24 h`; else
`${base}/globe_history/YYYY/MM/DD/traces/<xx>/trace_full_<hex>.json` (atMs's UTC date).

**traceReply rules:** point time = `(timestamp + dtS) × 1000`. Legs start at index 0 and at every point with flags & 2.
Pick the last leg whose first point time ≤ atMs (none → null; also null when atMs is more than 6 h after that leg's last
point: it has landed long since). Columns over the whole leg (points after atMs included: the client cuts). `alt`:
`'g'` for "ground", the number, or null; `vs`: vrate (whichever kind), `trk`, `gs`, `roll` (index 13 when present),
`nM`: `geoidN` per point, 0.1. `callsign`: the newest non-empty `flight` (trimmed) among the leg's acObjs, else null.
`reg` = `r`, `typeCode` = `t` (null when absent). `t0Ms` = the leg's first point time, `t` = seconds after it (0.1).

**TraceStore:** headers `user-agent`, `accept-encoding: gzip`. 404 → null (cache the null for the same time). Network
errors → null (not cached). Key = url + leg pick: cache the parsed JSON per URL, run `traceReply` per call.

- [ ] Write `server/trace.test.ts`: `traceUrl` live vs day (and the `~` case); a file with two legs (second starts with
  flags 2) → atMs in the first gives leg 1, in the second gives leg 2, before the first point → null; ground and numeric
  alt; callsign from the newest acObj `flight`; `t`/`t0Ms` arithmetic; nM present; TraceStore caches (one fetch for two
  gets within 30 s, a second fetch after), 404 → null.
- [ ] Run (fails), implement, run (green), `npx tsc --noEmit` clean for your files.

### Task C: replay clock and feed (client)

**Files:** create `client/history/clock.ts`, `client/history/clock.test.ts`, `client/history/feed.ts`, `client/history/feed.test.ts`.

**Interfaces (produce):**
```ts
// client/history/clock.ts
export const RATES: readonly number[] // [1, 10, 60]
export class HistoryClock {
  constructor(tMs: number, o: { minMs: number; maxMs: number; playing?: boolean; rate?: number }, perfMs: number)
  now(perfMs: number): number             // advances by rate × elapsed while playing; clamped to [minMs, maxMs]
  get playing(): boolean
  get rate(): number
  get maxMs(): number
  atEnd(perfMs: number): boolean          // playing and now(perfMs) === maxMs
  play(perfMs: number): void
  pause(perfMs: number): void
  toggle(perfMs: number): void
  seek(tMs: number, perfMs: number): void // clamped; keeps playing
  nextRate(perfMs: number): number        // the next of RATES (wraps), keeps now() continuous
  setBounds(minMs: number, maxMs: number, perfMs: number): void
}

// client/history/feed.ts
export interface Circle { lat: number; lon: number; nm: number }
export class HistoryFeed {
  /** Holds slot's aircraft for that circle (replacing what it held for the same slotMs). */
  add(slot: HistorySlot, c: Circle): void
  /** The slot is held for a circle that covers c: c's centre within the held circle and c.nm ≤ held.nm. */
  covers(slotMs: number, c: Circle): boolean
  has(slotMs: number): boolean
  /** Every held sample with fromMs < tMs ≤ toMs, all aircraft, in time order. */
  take(fromMs: number, toMs: number): Sample[]
  /** One aircraft's held samples with fromMs < tMs ≤ toMs, in time order. */
  samplesOf(hex: string, fromMs: number, toMs: number): Sample[]
  /** What the files know of it: callsign and squawk (the rest null, military false, route null). */
  info(hex: string): AircraftInfo | null
  /** Drops every slot not in keep. */
  retain(keep: ReadonlySet<number>): void
  clear(): void
}
```

**Sample synthesis (one per held position; computed once in add()):** `hex`, `tMs = slotMs + t × 1000`, `rxMs = tMs`,
`lat`, `lon`, `onGround = alt === 'g'`, `altBaroFt = typeof alt === 'number' ? alt : null`, `altGeomFt null`, `gsKt =
gs ?? (distance to the next point / dt, kt) ?? null`, `trackDeg = bearingDeg(this → next)` when the next is ≥ 0.05 nm
away (else the previous point's derived track, else null; the last point takes the one before it), `baroRateFpm =
(nextAlt − alt) / dt × 60` when both are numbers and dt ≤ 120 s (else null), `quality 'adsb2'`, `nM` = the track's,
`callsign` = the track's, every other field null (`version`, `nic`, `navQnhHpa`, `trueHeadingDeg`, `rollDeg`,
`geomRateFpm`, `typeCode`, `reg`). Samples of one aircraft in two adjacent slots are independent (no cross-slot
derivation).

- [ ] Write `clock.test.ts`: playing at 10× for 2 s moves 20 s; pause freezes; seek clamps to bounds and keeps playing;
  nextRate cycles 1 → 10 → 60 → 1 and now() does not jump; atEnd at maxMs; setBounds extends maxMs.
- [ ] Write `feed.test.ts` with a hand-built `HistorySlot` (two aircraft, one turning, one on the ground; a slot with
  stepS 10): take(from, to) bounds are (from, to]; samples in time order across aircraft; trackDeg toward the next
  point (east = 90); baroRateFpm (1,000 ft in 60 s → 1,000 fpm); ground → onGround, altBaroFt null; info() has the
  callsign/squawk; covers() rules; add() for the same slot replaces; retain() drops.
- [ ] Run (fails), implement, run (green), `npx tsc --noEmit` clean for your files.

### Task D: the flown path on the map (client)

**Files:** modify `client/scene/routeLine.ts`; create `client/scene/routeLine.test.ts` (pure helpers only).

**Interfaces (produce):**
```ts
export interface PathPoint { tMs: number; lat: number; lon: number; hM: number; altFt: number | null; onGround: boolean }
export interface PathRun { gap: boolean; color: number; points: PathPoint[] } // color: altitudeIndex of the run (ignored for gaps)
export const GAP_S: number   // 60
export const GAP_NM: number  // 2
/** The path up to cutMs as runs: a new run where the colour bucket (1,000 ft; ground its own) changes; a step longer
 *  than GAP_S and GAP_NM is a gap run of its two ends. Consecutive runs share their joining point. */
export function pathRuns(points: readonly PathPoint[], cutMs: number): PathRun[]
export class RouteLine {
  constructor(viewer: Viewer)
  /** at: the aircraft as drawn now (the path ends there); path: its points in time order (the part after cutMs is not
   *  drawn); dest/origin: the route's ends when known; cutMs: Infinity live, the replay time in history. */
  update(at: { lat: number; lon: number; hM: number; altFt?: number | null } | null, path: readonly PathPoint[],
    dest: RoutePlace | null, origin: RoutePlace | null, cutMs: number): void
  destroy(): void
}
```
Keep what `RouteLine` does now for the destination (the dashed great circle from the aircraft to `dest`, its dot and
code label) and its redraw cadence (REDRAW_MS). Replace the solid amber "since selected" line with the runs: flown runs
in their altitude colour (`altitudeRgba` of the run's bucket; bucket = `Math.floor(altitudeIndex(altFt, onGround) / 10)`
for airborne points, ground its own), drawn with a dark outline for contrast on the light map (Cesium
`Material.PolylineOutlineType`, width ~4 px, outline ~1 px, rgba(13,17,25,0.5)); gap runs dotted grey (`PolylineDash`,
dash ~6 px). The last flown point joins `at` in the last run's colour. Lead-in: when `origin` is known, the first point
(after the cut) is airborne and ≥ 10 nm from it, a dotted grey great circle from origin to the first point, and a
label "First heard HH:MM" (local time, 24 h) beside the first point (LabelCollection, as the destination code is).
Decimate before drawing: keep a point when it is ≥ 0.3 nm from the last kept one, starts or ends a run, or is the last.
Hide everything for `at === null` (as now). Use primitives in pools (reuse polylines; set `show`), no per-frame allocation
when nothing changed (same path length, same last tMs, same cut bucket of 1 s, same at within 0.0001°).

- [ ] Write `routeLine.test.ts` for `pathRuns`: one colour → one run; climbing across 1,000 ft buckets → several runs
  sharing ends; a 90 s / 5 nm hole → a gap run; a 90 s hole of 0.5 nm (parked, slow) → not a gap; cutMs drops later
  points; ground points form their own bucket; empty → [].
- [ ] Run (fails), implement pathRuns, run (green); then the drawing in RouteLine. `npx tsc --noEmit` clean for your file.

### Task E: the time bar and the Go to popover (client UI)

**Files:** modify `client/ui/playbar.ts`, `client/ui/playbar.css`, `client/ui/icons.ts`; create `client/history/bar.ts`,
`client/history/bar.css`, `client/history/bar.test.ts` (pure helpers only).

**Playbar options (add, all optional, defaults = today's behaviour):**
```ts
exitLabel?: string                         // default 'Exit scenario'
exitText?: string                          // set: the exit button is a text pill ('Live') instead of the × icon
tools?: HTMLElement[]                      // extra controls between the speed and the exit
scale?: { t: number; label: string }[]     // small labels under the rail (the hours)
className?: string                         // an extra class on the bar
// handle:
setSegments(segs: readonly { from: number; to: number; state: 'ready' | 'loading' | 'missing' }[]): void // on the rail, under the thumb
setLimit(maxT: number | null): void        // past maxT: hatched; a drag or key past it seeks to maxT
setTitle(title: string): void
```
Segments: ready = `rgba(255,255,255,0.42)`, loading = striped accent (animated 1 s), missing = faint red hatch. Limit
zone: diagonal hatch `rgba(255,255,255,0.08)`. Scale labels: 10 px `var(--fh-faint)` under the rail; on phones every
other label hidden. `.fh-playbar-history .fh-playbar-title { color: var(--fh-warn) }`. The text exit pill: 32 px high,
radius 16, `rgba(255,255,255,0.08)`, a 8 px hollow dot before the text.

**Icons:** add `history: 'M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 3.8v4.6h4.6M12 7.5V12l3 2'` and
`calendar: 'M4.5 6h15v14h-15zM4.5 10h15M8.5 3.5v4M15.5 3.5v4'` to `client/ui/icons.ts`.

**History bar (`client/history/bar.ts`):**
```ts
export interface LocalDay { startMs: number; endMs: number; label: string } // 'Tue 22 Sep' (en-GB weekday short, day, month short)
export function localDay(tMs: number): LocalDay                            // local midnight to the next (23/25 h on DST days)
export function hourScale(day: LocalDay, everyH: number): { t: number; label: string }[] // t = s after startMs, '00' … '24'
export function quickTimes(nowMs: number): { label: string; tMs: number }[] // '1 h ago', '6 h ago', 'Yesterday' (−24 h), 'A week ago'
export function parseLocal(date: string, time: string): number | null       // 'YYYY-MM-DD' + 'HH:MM' → local ms
export interface HistoryBarOpts {
  zone: string                       // short zone name for the clock, e.g. 'IDT'
  minMs: number                      // the earliest time the picker offers (now − 30 days)
  nowMs(): number
  onToggle(): void; onSeek(tMs: number): void; onRate(): void; onLive(): void; onGoTo(tMs: number): void
}
export interface HistoryBarHandle {
  update(v: { tMs: number; playing: boolean; rate: number }): void // re-mounts the inner play bar when tMs leaves its day
  setSlots(slots: HistoryStatus['slots'], loading: readonly number[]): void   // half hours → segments in the day
  setLimit(maxMs: number): void
  openGoTo(): void
  destroy(): void
}
export function mountHistoryBar(root: HTMLElement, o: HistoryBarOpts): HistoryBarHandle
```
The inner play bar: `start 0`, `stop = end =` day length in s, `marks []`, `clockLabel = zone`, title
`Replay · <day label>`, `className 'fh-playbar-history'`, `exitLabel 'Back to live'`, `exitText 'Live'`, `tools` = the
calendar button (`fh-ibtn`, icon calendar, aria-label 'Go to a date and time', aria-expanded while open), `scale` =
`hourScale(day, 3)`. `update` writes `t = (tMs − day.startMs) / 1000`, clock `HH:MM:SS` local.
Go to popover (`.fh-goto fh-glass`, anchored above the bar's left end on wide screens, full width above the bar on
phones ≤ 640 px): header "Go to" + close ×; chips from `quickTimes`; `<input type="date">` (min/max from minMs/now) and
`<input type="time" step="60">` prefilled with the current replay time; a note "The last 30 days open in seconds.";
a "Go" button (accent). Go or a chip → `onGoTo(ms)` and close; Esc or a click outside → close (stopPropagation of that
Esc so the app does not also act on it).

- [ ] Write `bar.test.ts` for `localDay` (a normal day = 86,400 s; label format), `hourScale(day, 3)` (9 labels, '00'…'24'),
  `quickTimes` (4 entries, offsets 1 h / 6 h / 24 h / 7 d), `parseLocal` (valid → local ms; '' or bad → null).
- [ ] Run (fails), implement helpers, run (green); then the DOM parts and CSS. `npx tsc --noEmit` clean for your files.

### Task F (lead): server endpoints

`server/infoStore.ts`: `origin(hex)` beside `dest(hex)` (the route's first code). `server/main.ts`:
`const history = new HistoryStore({ userAgent: userAgent(cfg.contact ?? 'personal use'), fetchFn: deps.historyFetch })`,
`const traces = new TraceStore({ … same })`; routes `GET /api/history?slot&lat&lon&nm` (slot a multiple of SLOT_MS,
nm 1–5400 → `history.query(slot, {lat, lon, nm: …, stepS via stepFor})` → 200 slot | 404),
`GET /api/history/status`, `GET /api/trace?hex&at` (at default now; add `origin: info.origin(hex)`) → 200 | 404;
`chase()` adds `origin`. A 60 s `setInterval(() => history.tick())` (unref) only when `cfg.source !== 'replay'`; cleared
in close(). Tests in `server/main.history.test.ts` with a fake `historyFetch`.

### Task G (lead): client integration

`client/api.ts` (`history`, `historyStatus`, `trace`), `client/ui/urlState.ts` (`hist` = unix s), `client/ui/flightCard.ts`
(replay status: amber dot, "Replay · HH:MM", no Record button), `client/app.ts` (history mode: rail button, poll pause,
per-frame feed → own Fleet, replay clock as render time, select → trace → path + registry, Esc, scenario/search
interplay, URL), `client/ui/layout.css` (history: the map key and the phone card above the bar).

### Task H (lead): verification and merge

Typecheck, full suite, `npm run build`; headless desktop + phone screenshots of live path, history paused/playing, Go
to, chase in history; a short live check; README; merge to main after asking the other sessions.

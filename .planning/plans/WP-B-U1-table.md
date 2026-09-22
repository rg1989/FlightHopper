# WP-B-U1 — Visible-Aircraft Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A right-hand sidebar that lists the aircraft on screen, like the list in adsb.lol's tar1090 view: flag, callsign (hex when none), route, type, squawk (7500/7600/7700 highlighted), altitude (ft, `ground`, ▲/▼ beyond ±300 fpm) and speed (kt), with "Total aircraft" / "On screen" counts, a search box and click-to-sort headers. A row click selects the aircraft. It stays smooth with thousands of aircraft, and `update()` may be called every frame.

**Architecture:** One module, `client/ui/table.ts`, and its stylesheet. The design and code are our own; nothing is taken from tar1090.
- **Pure half (Node-tested):** `sortRows(rows, key, desc)` returns a new array. Unknown values go last in both directions, and equal keys are ordered by hex, so the order is stable from one re-sort to the next. For `alt`, ground sorts below every airborne altitude. `TableKey = 'hex' | 'callsign' | 'route' | 'type' | 'squawk' | 'alt' | 'speed'`. The flag column sorts by `hex`, because ICAO address blocks are allocated per country, so this groups countries. `filterRows(rows, query)` keeps rows whose callsign, hex, registration, type or squawk contains the trimmed query, in any case. The route is not searched. `cellText(e, col, flagOf?)` gives each cell's text: the route `LLBG-LOWI` becomes `LLBG - LOWI`; the altitude is `35,000`, `2,375 ▲` or `ground` (thousands grouped by a regex, because `toLocaleString` builds a formatter on every call); the speed is rounded to whole knots. `isEmergencySquawk`, `windowRange(scrollTop, viewH, rowH, count, overscan)`, `COLUMNS`, `ROW_H = 22`, `OVERSCAN = 8` and `RESORT_MS = 1000` are also exported.
- **`mountTable(root, { onSelect, onHover, flagOf? })`** builds `aside.fh-table`. It has a header (collapse toggle, `Total aircraft: N`, `On screen: M`, plus ` · K match` while searching), a search input, one sort button per column, and a scroll box that holds a spacer `count × 22 px` high.
- **`update(all, onScreen, selectedHex)`:**
  1. A selection change repaints the row highlight at once.
  2. At most once per `RESORT_MS`, it copies the on-screen entries into table-owned `Row` objects keyed by hex. Fleet reuses its `FleetEntry` objects every frame, so the table never keeps a reference to one.
  3. It filters and sorts that copy, then redraws. Between these copies, `update()` does nothing but a clock read and a comparison.
  4. The copy keeps the last display order, and new aircraft are appended at the end. V8's sort (TimSort) is adaptive, so re-sorting a nearly sorted list takes about n comparisons instead of n·log₂n. At 5,000 aircraft the re-sort frame fell from 3.7 ms to 1.6 ms (p50).
  5. A header click (the same column again reverses it) or a search re-sorts the last copy at once.
- **Virtual list:**
  - Only the rows in the viewport plus 8 above and 8 below exist.
  - Row `i` always uses row element `i % poolSize` and is placed with `translateY(i × 22 px)`. When the list scrolls, only the rows that come into view are rewritten.
  - Each cell holds one `Text` node, and its last string is cached, so a cell is written only when its text changes. Upstream strings are never parsed as HTML.
  - The flag is recomputed only when a row element gets a different hex.
  - The pool grows when the viewport grows. Unused elements are `hidden`.
  - The viewport height comes from a `ResizeObserver`, so layout reads stay out of the render path.
  - The scroll box has `contain: strict` and every row has `contain: strict`.
- **Events:**
  - A row click calls `onSelect(hex)`. Moving the mouse over a row calls `onHover(hex)` when the hex changes, and leaving the list calls `onHover(null)`.
  - Keys typed in the search box do not propagate, so they are never app shortcuts. `Esc` in the search box clears it, and a second `Esc` leaves it.
  - The toggle collapses the panel to a small header-only box. While the panel is collapsed, the table still copies once a second for the counts, but it does not filter, sort or render.
- **Style:** dark, semi-transparent (`rgba(10,14,20,.82)`) and 420 px wide (`min(420px, 100vw − 16px)`), absolutely positioned 8 px from the top, right and bottom, with `z-index` 10. There is no `backdrop-filter`: a blur behind the panel would cost a pass every time the globe redraws. The selected row is blue, and the odd rows have a faint stripe. An emergency squawk is shown bold in a red box, so it does not depend on colour alone.

**For the integrator (B-A):**
- `all` is used only for the "Total aircraft" count. "On screen" counts the distinct hexes of `onScreen`.
- `flagOf(hex)` should return `''` for an unknown country, for example ``(hex) => { const c = countryOf(hex); return c ? flagEmoji(c.iso2) : '' }``. It runs once each time a row element gets a new hex.
- `.fh-table` overlaps the bottom-right `.fh-attribution` from `client/ui/ui.css`. `client/ui/layout.css` should move one of them (for example `.fh-table { bottom: 64px }`) or put the attribution bottom-left.
- `destroy()` sends `onHover(null)` when a row was hovered.
- Values are at most 1 s old (see the `ponytail:` note in the code).

**Tech Stack:** TypeScript (erasable), DOM, CSS; `node:test` with a `registerHooks` loader that turns `.css` imports into empty modules (the same pattern as `client/app.test.ts`). No Cesium, no network, no new dependencies, no shipped data.

**Wave:** B (parallel with B-C1, B-C2, B-S1, B-V1, B-V2, B-V3 and B-U2). It depends only on WP-B0 (`FleetEntry`, `AircraftInfo`), and B-A consumes it. **Estimated:** 2 h. **Validated:** on 2026-09-22 in the integrated tree (`/private/tmp/claude-501/fh-assembly`: WP-00, the 26 WPs, V4 Task 4 and B0), with Node v25.2.1, TypeScript 7.0.2 and Vite 8.3.0:
- **Tests:** `node --test client/ui/table.test.ts` → 11/11 pass. `npx tsc --noEmit` reports nothing in `client/ui/table*` or `harness/table*`. `npm run check` in that tree, with the other B packages being built alongside, passed: tsc was clean and 608/608 tests passed.
- **Replay:** every task was replayed in an isolated copy that held only `package.json`, `tsconfig.json`, `node_modules`, B0's type files (`shared/info.ts`, `shared/types.ts`, `client/types.ts`, `client/track/types.ts`) and this plan's code blocks. Task 1 failed (`ERR_MODULE_NOT_FOUND`, `ℹ fail 1`) and then passed 11/11. Tasks 2 and 3 kept 11/11, and `tsc` was clean at each stage.
- **Mutations:** each of these makes at least one test fail: unknowns sorting with the direction, no hex tie-break, the arrow at exactly 300 fpm, the route searched, ground treated as unknown, no hex fallback for the callsign, no overscan above the viewport.
- **Browser check:** `harness/table.html` was opened under `vite --port 5414`, in the desktop app's Browser pane (Chrome 152, 8 cores, 1280×800 viewport). The pane ran `requestAnimationFrame` at about 100 Hz, and `performance.now()` has a resolution of 0.1 ms.

  | Scenario | `update()` per frame | Re-sort frame (per-second max) | Other |
  |---|---|---|---|
  | 5,000 aircraft, all on screen, 20 s (1,999 frames) | p50 0.0 ms, **p95 0.0 ms**, p99 1.0 ms, max 2.0 ms | p50 1.6 ms, max 2.2 ms | 0 long tasks; 40 row elements in the DOM |
  | 5,000 aircraft, panning (≈2,500 on screen, ≈200 entering and ≈200 leaving per second) | p95 0.0 ms, p99 0.7 ms | p50 2.0 ms, max 4.4 ms | |
  | 12,000 aircraft, all on screen (tar1090 worldwide scale) | p95 0.0 ms, p99 3.1 ms | p50 4.2 ms, max 5.6 ms | |

  | Scroll test | Frames | Frame p95 | Frames > 25 ms | Scroll handler p95 / max | Rows in the DOM |
  |---|---|---|---|---|---|
  | 5,000 aircraft, 45 px per frame for 5 s | 500 | 11 ms (the pane's rate) | 0 | 0.4 / 0.7 ms | 49 |
  | 5,000 aircraft, jumps of 2,000 px per frame | 300 | 11 ms | 0 | 0.9 / 2.0 ms | 49 |
  | 12,000 aircraft, 45 px per frame | 500 | 11 ms | 0 | 0.2 / 0.5 ms | 48 |

  **By hand:** the second click on `Alt ft` sorted descending (`▾`), with ground rows after the airborne ones. Searching `ely` showed `On screen: 5,000 · 370 match`, and `7700` showed red boxes in the squawk column. A row click reached `onSelect` and highlighted the row, a mouse-over reached `onHover`, and leaving the list gave `null`. `Esc` in the search box cleared it without reaching the page's own `Esc` handler. Collapse and expand worked. The panel fits a 375 px wide viewport. The console had no errors.
- **Bug found by the harness:** the first harness version generated duplicate hexes, so `On screen` read 10,964 of 12,000 (the table counts distinct hexes, correctly). The harness now keeps hexes unique, as Fleet does.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- This package creates or edits only the five files below. It reads WP-B0's `FleetEntry` (`client/types.ts`) and `AircraftInfo` (`shared/info.ts`).
- `table.ts` imports `./table.css`, and only Vite understands that import. The test loads `table.ts` through a `registerHooks` load hook that turns every `.css` into an empty module; the hook lives only in that test's process.
- Strings that come from data (callsign, route, registration, type, squawk) reach the DOM only as `Text` node data, never through `innerHTML`.
- The tests never touch the network, and neither does the harness (synthetic data only).
- Code blocks: each block's first line is its path comment and the block is the file's complete content. When a file appears twice, the later block replaces it.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `client/ui/table.ts` | `TableKey`, `COLUMNS`, `sortRows`, `filterRows`, `cellText`, `isEmergencySquawk`, `windowRange`, `mountTable` |
| `client/ui/table.test.ts` | the sorting, filtering, cell text, window range and scale tests |
| `client/ui/table.css` | sidebar, virtual-list and row styles |
| `harness/table.html`, `harness/table.ts` | manual and performance check: 5,000 / 12,000 synthetic aircraft, per-frame `update()` timing, scroll test |

---

### Task 1: Sort, filter and cell text (pure)

**Files:**
- Create: `client/ui/table.test.ts`, `client/ui/table.ts` (the pure half; Task 2 completes it)
- Test: `client/ui/table.test.ts`

**Interfaces:**
- Consumes: `FleetEntry` (`client/types.ts`, WP-B0), `AircraftInfo` (`shared/info.ts`, WP-B0)
- Produces: `type TableKey = 'hex' | 'callsign' | 'route' | 'type' | 'squawk' | 'alt' | 'speed'` · `sortRows(rows: readonly FleetEntry[], key: TableKey, desc: boolean): FleetEntry[]` · `filterRows(rows: readonly FleetEntry[], query: string): FleetEntry[]` · `cellText(e: FleetEntry, col: number, flagOf?: (hex: string) => string): string` · `isEmergencySquawk(squawk: string | null): boolean` · `windowRange(scrollTop, viewH, rowH, count, overscan): { first: number; end: number }` · `COLUMNS`, `ROW_H`, `OVERSCAN`, `RESORT_MS`. PLAN.md §5.3 locks `sortRows(rows: FleetEntry[], …)`; a `readonly` parameter is wider, so every call the contract allows still type-checks.

- [ ] **Step 1: Write the failing test**

```ts
// client/ui/table.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import type { AircraftInfo } from '../../shared/info.ts'
import type { FleetEntry } from '../types.ts'

// table.ts imports table.css for Vite. Node cannot load CSS, so this test loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { cellText, filterRows, isEmergencySquawk, sortRows, windowRange } = await import('./table.ts')

const info = (hex: string, o: Partial<AircraftInfo> = {}): AircraftInfo => ({
  hex, callsign: null, reg: null, typeCode: null, category: null, squawk: null, emergency: null, military: false, route: null, ...o,
})
const entry = (hex: string, o: Partial<FleetEntry> = {}, i: Partial<AircraftInfo> | null = {}): FleetEntry => ({
  hex, lat: 32, lon: 34.8, hM: 1000, altFt: 3000, onGround: false, trackDeg: 90, gsKt: 250, vsFpm: 0, ageS: 1, quality: 'adsb2',
  info: i === null ? null : info(hex, i), ...o,
})
const hexes = (rows: readonly FleetEntry[]): string[] => rows.map((e) => e.hex)

test('sortRows: callsign ascending, no callsign last, equal keys by hex; desc reverses but keeps unknowns last', () => {
  const rows = [ // ties arrive out of hex order, so a stable sort alone would not pass
    entry('000005', {}, { callsign: 'UAL1' }),
    entry('000004', {}, { callsign: null }),
    entry('000002', {}, { callsign: 'ELY5' }),
    entry('000003', {}, { callsign: 'UAL1' }),
    entry('000001', {}, null), // no info at all
  ]
  assert.deepEqual(hexes(sortRows(rows, 'callsign', false)), ['000002', '000003', '000005', '000001', '000004'])
  assert.deepEqual(hexes(sortRows(rows, 'callsign', true)), ['000003', '000005', '000002', '000001', '000004'])
})

test('sortRows: altitude puts ground below every airborne altitude and unknown last, both directions', () => {
  const rows = [
    entry('a1', { altFt: 12000 }),
    entry('a2', { altFt: null, onGround: true }),
    entry('a3', { altFt: -150 }), // below sea level (e.g. the Dead Sea): still airborne
    entry('a4', { altFt: null }),
    entry('a5', { altFt: 41000 }),
    entry('a6', { altFt: Number.NaN }),
  ]
  assert.deepEqual(hexes(sortRows(rows, 'alt', false)), ['a2', 'a3', 'a1', 'a5', 'a4', 'a6'])
  assert.deepEqual(hexes(sortRows(rows, 'alt', true)), ['a5', 'a1', 'a3', 'a2', 'a4', 'a6'])
})

test('sortRows: speed, squawk, route, type and hex keys', () => {
  const rows = [
    entry('c', { gsKt: 480 }, { squawk: '7700', route: 'OTHH-LROP', typeCode: 'B789' }),
    entry('a', { gsKt: null }, { squawk: '1000', route: null, typeCode: 'A320' }),
    entry('b', { gsKt: 12.4 }, { squawk: null, route: 'LLBG-LOWI', typeCode: null }),
  ]
  assert.deepEqual(hexes(sortRows(rows, 'speed', false)), ['b', 'c', 'a'])
  assert.deepEqual(hexes(sortRows(rows, 'speed', true)), ['c', 'b', 'a'])
  assert.deepEqual(hexes(sortRows(rows, 'squawk', false)), ['a', 'c', 'b'])
  assert.deepEqual(hexes(sortRows(rows, 'route', false)), ['b', 'c', 'a'])
  assert.deepEqual(hexes(sortRows(rows, 'type', true)), ['c', 'a', 'b'])
  assert.deepEqual(hexes(sortRows(rows, 'hex', false)), ['a', 'b', 'c'])
  assert.deepEqual(hexes(sortRows(rows, 'hex', true)), ['c', 'b', 'a'])
})

test('sortRows is pure: returns a new array and leaves its input as it was', () => {
  const rows = [entry('b'), entry('a')]
  const out = sortRows(rows, 'hex', false)
  assert.notEqual(out, rows)
  assert.deepEqual(hexes(rows), ['b', 'a'])
  assert.deepEqual(hexes(out), ['a', 'b'])
  assert.equal(out[0], rows[1]) // same objects, new order
})

test('filterRows: case-insensitive substring of callsign, hex, registration, type or squawk', () => {
  const rows = [
    entry('738a1b', {}, { callsign: 'ELY001', reg: '4X-EKA', typeCode: 'B738', squawk: '4501', route: 'LLBG-KJFK' }),
    entry('4ca9f2', {}, { callsign: 'RYR12AB', reg: 'EI-DWF', typeCode: 'B738', squawk: '7700' }),
    entry('a0c0de', {}, null),
  ]
  assert.deepEqual(hexes(filterRows(rows, 'ely')), ['738a1b'])
  assert.deepEqual(hexes(filterRows(rows, '4CA9')), ['4ca9f2'])
  assert.deepEqual(hexes(filterRows(rows, 'ei-d')), ['4ca9f2'])
  assert.deepEqual(hexes(filterRows(rows, 'b738')), ['738a1b', '4ca9f2'])
  assert.deepEqual(hexes(filterRows(rows, '7700')), ['4ca9f2'])
  assert.deepEqual(hexes(filterRows(rows, ' c0de ')), ['a0c0de']) // trimmed; no info: the hex still matches
  assert.deepEqual(hexes(filterRows(rows, 'kjfk')), []) // the route is not searched
})

test('filterRows: an empty or blank query keeps every row, in a new array', () => {
  const rows = [entry('a'), entry('b')]
  for (const q of ['', '   ']) {
    const out = filterRows(rows, q)
    assert.notEqual(out, rows)
    assert.deepEqual(hexes(out), ['a', 'b'])
  }
})

test('cellText: flag, callsign (hex when none), route with spaced dashes, type, squawk', () => {
  const e = entry('738a1b', {}, { callsign: 'ELY001', route: 'LLBG-LOWI', typeCode: 'B738', squawk: '7700' })
  const flagOf = (hex: string): string => (hex.startsWith('738') ? '🇮🇱' : '')
  assert.equal(cellText(e, 0, flagOf), '🇮🇱')
  assert.equal(cellText(e, 0), '') // no flagOf given
  assert.equal(cellText(e, 1), 'ELY001')
  assert.equal(cellText(entry('abc123', {}, null), 1), 'abc123')
  assert.equal(cellText(e, 2), 'LLBG - LOWI')
  assert.equal(cellText(entry('x', {}, { route: 'OTP-VIE-DOH' }), 2), 'OTP - VIE - DOH')
  assert.equal(cellText(e, 3), 'B738')
  assert.equal(cellText(e, 4), '7700')
  assert.deepEqual([2, 3, 4].map((c) => cellText(entry('x', {}, null), c)), ['', '', ''])
})

test('cellText: altitude in ft with thousands separators, ground, and ▲/▼ only beyond ±300 fpm; speed in whole knots', () => {
  assert.equal(cellText(entry('x', { altFt: 35000, vsFpm: 0 }), 5), '35,000')
  assert.equal(cellText(entry('x', { altFt: 2375.4, vsFpm: 301 }), 5), '2,375 ▲')
  assert.equal(cellText(entry('x', { altFt: 2375, vsFpm: 300 }), 5), '2,375')
  assert.equal(cellText(entry('x', { altFt: 2375, vsFpm: -300 }), 5), '2,375')
  assert.equal(cellText(entry('x', { altFt: 2375, vsFpm: -1200 }), 5), '2,375 ▼')
  assert.equal(cellText(entry('x', { altFt: 1100, vsFpm: null }), 5), '1,100')
  assert.equal(cellText(entry('x', { altFt: -150, vsFpm: 0 }), 5), '-150')
  assert.equal(cellText(entry('x', { altFt: null, onGround: true, vsFpm: 0 }), 5), 'ground')
  assert.equal(cellText(entry('x', { altFt: null }), 5), '')
  assert.equal(cellText(entry('x', { gsKt: 451.6 }), 6), '452')
  assert.equal(cellText(entry('x', { gsKt: null }), 6), '')
})

test('isEmergencySquawk: 7500, 7600 and 7700 only', () => {
  assert.deepEqual(['7500', '7600', '7700', '7000', '1200', null].map(isEmergencySquawk), [true, true, true, false, false, false])
})

test('windowRange: the rows in the viewport plus overscan, clamped to the list', () => {
  assert.deepEqual(windowRange(0, 440, 22, 5000, 8), { first: 0, end: 28 }) // 20 visible + 8 below
  assert.deepEqual(windowRange(2200, 440, 22, 5000, 8), { first: 92, end: 128 }) // rows 100…119 visible
  assert.deepEqual(windowRange(2211, 440, 22, 5000, 8), { first: 92, end: 129 }) // half-row offset: 21 partly visible
  assert.deepEqual(windowRange(109_560, 440, 22, 5000, 8), { first: 4972, end: 5000 })
  assert.deepEqual(windowRange(0, 440, 22, 3, 8), { first: 0, end: 3 })
  assert.deepEqual(windowRange(0, 440, 22, 0, 8), { first: 0, end: 0 })
  assert.deepEqual(windowRange(500, 0, 22, 100, 8), { first: 14, end: 31 }) // not laid out yet: overscan only
})

test('sortRows and filterRows stay cheap at 12,000 rows (tar1090 worldwide scale)', () => {
  const rows: FleetEntry[] = []
  for (let i = 0; i < 12_000; i++) {
    const hex = (i * 2654435761 % 0xffffff).toString(16).padStart(6, '0')
    rows.push(entry(hex, { altFt: (i * 37) % 45000, gsKt: (i * 13) % 520 }, { callsign: i % 50 === 0 ? null : `ABC${(i * 7919) % 10000}` }))
  }
  for (const key of ['callsign', 'alt', 'speed', 'hex'] as const) {
    const t0 = performance.now()
    const out = sortRows(filterRows(rows, ''), key, true)
    const ms = performance.now() - t0
    assert.equal(out.length, 12_000)
    assert.ok(ms < 100, `${key}: ${ms.toFixed(1)} ms`) // generous: catches an accidental O(n²), not a benchmark
  }
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/ui/table.test.ts`
Expected: FAIL. The output shows `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/ui/table.ts' imported from …/client/ui/table.test.ts`, then `ℹ tests 1`, `ℹ pass 0`, `ℹ fail 1`.

- [ ] **Step 3: Write the implementation (pure half)**

```ts
// client/ui/table.ts
// Right-hand sidebar listing the aircraft on screen: flag, callsign, route, type, squawk, altitude, speed. Sortable by
// any column, searchable, with "Total aircraft" / "On screen" counts; a row click selects the aircraft.
// Built for thousands of rows with update() called every frame:
// - once a second (RESORT_MS) the on-screen entries are copied into table-owned objects, then filtered and sorted.
//   Fleet reuses its FleetEntry objects every frame, so the table never keeps a reference to one. The sort starts
//   from the last display order, which V8's adaptive sort finishes in about one pass;
// - a header click or a search re-sorts that copy at once;
// - only the rows in the scroll viewport plus OVERSCAN exist in the DOM. Row i always uses row element i % poolSize,
//   so scrolling rewrites only the rows that come into view, and a cell is written only when its text changes.
import type { FleetEntry } from '../types.ts'

/** What a column sorts by. The flag column sorts by ICAO address: address blocks are allocated per country. */
export type TableKey = 'hex' | 'callsign' | 'route' | 'type' | 'squawk' | 'alt' | 'speed'

export interface TableColumn {
  key: TableKey
  label: string
  title: string
  num: boolean // right-aligned number
}

/** The columns, in order. cellText(e, i) is the text of column i. */
export const COLUMNS: readonly TableColumn[] = [
  { key: 'hex', label: '⚑', title: 'Country of registration (sorts by ICAO address, which groups countries)', num: false },
  { key: 'callsign', label: 'Callsign', title: 'Callsign (ICAO address when there is none)', num: false },
  { key: 'route', label: 'Route', title: 'Route (origin - destination)', num: false },
  { key: 'type', label: 'Type', title: 'ICAO aircraft type designator', num: false },
  { key: 'squawk', label: 'Sqk', title: 'Squawk (7500, 7600 and 7700 highlighted)', num: false },
  { key: 'alt', label: 'Alt ft', title: 'Barometric altitude in feet; ▲ climbing / ▼ descending faster than 300 ft/min', num: true },
  { key: 'speed', label: 'Spd kt', title: 'Ground speed in knots', num: true },
]

export const ROW_H = 22 // px; fixed, the virtual scroll depends on it (table.css .fh-row height)
export const OVERSCAN = 8 // rows kept above and below the viewport so a fast scroll never shows a gap
// ponytail: rows show values up to RESORT_MS old (a list, not a gauge; tar1090 also refreshes its table about once a
// second). Upgrade if a live column is wanted: repaint only the visible rows every frame from a hex → entry lookup.
export const RESORT_MS = 1000 // at most one copy + filter + sort per second from update()
const VS_ARROW_FPM = 300
const GROUND = -1e9 // sort key: below every airborne altitude
const noFlag = (): string => ''

const finite = (v: number | null): v is number => v !== null && Number.isFinite(v)

/** 35000 → "35,000". Not toLocaleString: that builds a number formatter per call. */
const grouped = (n: number): string => String(Math.round(n) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

function keyOf(e: FleetEntry, key: TableKey): string | number | null {
  const i = e.info
  switch (key) {
    case 'hex': return e.hex
    case 'callsign': return i?.callsign ?? null
    case 'route': return i?.route ?? null
    case 'type': return i?.typeCode ?? null
    case 'squawk': return i?.squawk ?? null
    case 'alt': return e.onGround ? GROUND : finite(e.altFt) ? e.altFt : null
    case 'speed': return finite(e.gsKt) ? e.gsKt : null
  }
}

/**
 * The rows sorted by key (ascending, or descending when desc). Unknown values go last in both directions; equal keys
 * are ordered by hex so the order is stable from one re-sort to the next. Returns a new array; the input is untouched.
 */
export function sortRows(rows: readonly FleetEntry[], key: TableKey, desc: boolean): FleetEntry[] {
  const n = rows.length
  const keys: (string | number | null)[] = []
  const idx: number[] = []
  for (let i = 0; i < n; i++) {
    keys.push(keyOf(rows[i], key))
    idx.push(i)
  }
  const sign = desc ? -1 : 1
  idx.sort((i, j) => {
    const a = keys[i]
    const b = keys[j]
    if (a !== b) {
      if (a === null) return 1
      if (b === null) return -1
      if (a < b) return -sign
      if (a > b) return sign
    }
    const ha = rows[i].hex
    const hb = rows[j].hex
    return ha < hb ? -1 : ha > hb ? 1 : 0
  })
  const out: FleetEntry[] = []
  for (let k = 0; k < n; k++) out.push(rows[idx[k]])
  return out
}

const has = (v: string | null | undefined, q: string): boolean => v != null && v.toLowerCase().includes(q)

/** The rows whose callsign, hex, registration, type or squawk contains the query (trimmed, any case). New array. */
export function filterRows(rows: readonly FleetEntry[], query: string): FleetEntry[] {
  const q = query.trim().toLowerCase()
  if (q === '') return rows.slice()
  const out: FleetEntry[] = []
  for (const e of rows) {
    const i = e.info
    if (has(e.hex, q) || has(i?.callsign, q) || has(i?.reg, q) || has(i?.typeCode, q) || has(i?.squawk, q)) out.push(e)
  }
  return out
}

export function isEmergencySquawk(squawk: string | null): boolean {
  return squawk === '7500' || squawk === '7600' || squawk === '7700'
}

/** Text of column `col` (index into COLUMNS) for one row; '' when unknown. */
export function cellText(e: FleetEntry, col: number, flagOf: (hex: string) => string = noFlag): string {
  const i = e.info
  switch (col) {
    case 0: return flagOf(e.hex)
    case 1: return i?.callsign ?? e.hex
    case 2: return i?.route == null ? '' : i.route.replace(/\s*-\s*/g, ' - ')
    case 3: return i?.typeCode ?? ''
    case 4: return i?.squawk ?? ''
    case 5: {
      if (e.onGround) return 'ground'
      if (!finite(e.altFt)) return ''
      const vs = e.vsFpm
      return grouped(e.altFt) + (finite(vs) && vs > VS_ARROW_FPM ? ' ▲' : finite(vs) && vs < -VS_ARROW_FPM ? ' ▼' : '')
    }
    case 6: return finite(e.gsKt) ? String(Math.round(e.gsKt)) : ''
    default: return ''
  }
}

/** Rows [first, end) to keep in the DOM for a viewport at scrollTop of height viewH (px). */
export function windowRange(scrollTop: number, viewH: number, rowH: number, count: number, overscan: number): { first: number; end: number } {
  const first = Math.max(0, Math.floor(scrollTop / rowH) - overscan)
  const end = Math.min(count, Math.ceil((scrollTop + viewH) / rowH) + overscan)
  return { first: Math.min(first, end), end }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/ui/table.test.ts`
Expected: PASS: `ℹ tests 11`, `ℹ pass 11`, `ℹ fail 0`. The 12,000-row test takes about 25 ms.

- [ ] **Step 5: Commit**

```bash
git add client/ui/table.ts client/ui/table.test.ts
git commit -m "feat(ui): sort, filter and cell text for the aircraft table"
```

---

### Task 2: The virtualised table (DOM + CSS)

**Files:**
- Modify: `client/ui/table.ts` (complete new version below: the Task 1 code plus the CSS import and everything from `// ---- DOM`)
- Create: `client/ui/table.css`

**Interfaces:**
- Consumes: Task 1; `FleetEntry` (WP-B0)
- Produces: `interface TableOpts { onSelect(hex: string): void; onHover(hex: string | null): void; flagOf?: (hex: string) => string }` · `interface TableHandle { update(all: readonly FleetEntry[], onScreen: readonly FleetEntry[], selectedHex: string | null): void; destroy(): void }` · `mountTable(root: HTMLElement, opts: TableOpts): TableHandle` (PLAN.md §5.3 B-U1, exactly). DOM: `aside.fh-table` (`.fh-collapsed` while collapsed) › `.fh-table-head` (`button.fh-table-toggle`, two `span.fh-table-count`) + `.fh-table-body` (`input.fh-table-search`, `.fh-table-cols` with one `button` per column carrying `data-sort="asc|desc|"`, `.fh-table-empty`, `.fh-table-scroll` › `.fh-table-spacer` › `div.fh-row` (`data-slot`, `.fh-odd`, `.fh-sel`; seven `span` cells, the squawk cell `.fh-emerg` when 7500/7600/7700)).

This task has no new unit test. Node has no DOM, and a fake one would test the fake. The Task 1 tests pin the logic `mountTable` uses (`windowRange`, `cellText`, `sortRows`, `filterRows`). Task 3's harness checks the DOM, events and performance in a real browser.

- [ ] **Step 1: Write the stylesheet**

```css
/* client/ui/table.css */
/* Right-hand sidebar over the map: a dark translucent panel with a fixed-row-height virtual list. No backdrop-filter:
   blurring the globe behind the panel would cost a pass every frame the globe redraws. */
.fh-table {
  position: absolute;
  z-index: 10;
  top: 8px;
  right: 8px;
  bottom: 8px;
  width: min(420px, calc(100vw - 16px));
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  border-radius: 6px;
  background: rgba(10, 14, 20, 0.82);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.45);
  color: #e6ebf0;
  font: 12px/1.3 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}

/* Collapsed: only the header (toggle + counts) stays, as a small box in the corner. */
.fh-table.fh-collapsed {
  bottom: auto;
  width: auto;
}

.fh-table.fh-collapsed .fh-table-body {
  display: none;
}

.fh-table-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 10px 6px 6px;
  white-space: nowrap;
}

.fh-table-toggle {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.fh-table-count {
  color: #c3ccd5;
}

.fh-table-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.fh-table-search {
  margin: 0 8px 6px;
  padding: 5px 8px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.07);
  color: inherit;
  font: inherit;
  outline: none;
}

.fh-table-search:focus {
  border-color: #4aa3ff;
}

/* Header and rows share one grid, so the columns line up. */
.fh-grid {
  display: grid;
  grid-template-columns: 20px 62px minmax(0, 1fr) 36px 34px 62px 42px;
  column-gap: 4px;
  padding: 0 8px;
}

.fh-table-cols {
  border-bottom: 1px solid rgba(255, 255, 255, 0.14);
}

.fh-table-cols button {
  overflow: hidden;
  padding: 4px 0;
  border: 0;
  background: none;
  color: #9aa6b2;
  font: inherit;
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}

.fh-table-cols button:hover,
.fh-table-cols button[data-sort='asc'],
.fh-table-cols button[data-sort='desc'] {
  color: #fff;
}

.fh-table-cols button[data-sort='asc']::after {
  content: ' ▴';
}

.fh-table-cols button[data-sort='desc']::after {
  content: ' ▾';
}

.fh-table-empty {
  padding: 10px;
  color: #9aa6b2;
}

.fh-table-empty[hidden] {
  display: none;
}

/* contain: strict keeps layout, style and paint of the list inside this box: moving rows never relayouts the page. */
.fh-table-scroll {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  contain: strict;
  scrollbar-color: rgba(255, 255, 255, 0.3) transparent;
  scrollbar-width: thin;
}

.fh-table-spacer {
  position: relative;
  width: 100%;
}

/* Height must equal ROW_H in table.ts. Rows are placed with transform: translateY(i × ROW_H). */
.fh-row {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  height: 22px;
  line-height: 22px;
  contain: strict;
  cursor: pointer;
  font-variant-numeric: tabular-nums;
}

.fh-row[hidden] {
  display: none;
}

.fh-row.fh-odd {
  background: rgba(255, 255, 255, 0.035);
}

.fh-row:hover {
  background: rgba(255, 255, 255, 0.12);
}

.fh-row.fh-sel {
  background: rgba(33, 136, 255, 0.5);
}

.fh-row > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fh-num {
  text-align: right;
}

.fh-table-cols button.fh-num {
  text-align: right;
}

/* Hijack, radio failure, general emergency: not colour alone (bold + box) so it reads for colour-blind users too. */
.fh-row > span.fh-emerg {
  align-self: center;
  border-radius: 3px;
  background: #d32f2f;
  color: #fff;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
}
```

- [ ] **Step 2: Write the complete module**

```ts
// client/ui/table.ts
// Right-hand sidebar listing the aircraft on screen: flag, callsign, route, type, squawk, altitude, speed. Sortable by
// any column, searchable, with "Total aircraft" / "On screen" counts; a row click selects the aircraft.
// Built for thousands of rows with update() called every frame:
// - once a second (RESORT_MS) the on-screen entries are copied into table-owned objects, then filtered and sorted.
//   Fleet reuses its FleetEntry objects every frame, so the table never keeps a reference to one. The sort starts
//   from the last display order, which V8's adaptive sort finishes in about one pass;
// - a header click or a search re-sorts that copy at once;
// - only the rows in the scroll viewport plus OVERSCAN exist in the DOM. Row i always uses row element i % poolSize,
//   so scrolling rewrites only the rows that come into view, and a cell is written only when its text changes.
import type { FleetEntry } from '../types.ts'
import './table.css'

/** What a column sorts by. The flag column sorts by ICAO address: address blocks are allocated per country. */
export type TableKey = 'hex' | 'callsign' | 'route' | 'type' | 'squawk' | 'alt' | 'speed'

export interface TableColumn {
  key: TableKey
  label: string
  title: string
  num: boolean // right-aligned number
}

/** The columns, in order. cellText(e, i) is the text of column i. */
export const COLUMNS: readonly TableColumn[] = [
  { key: 'hex', label: '⚑', title: 'Country of registration (sorts by ICAO address, which groups countries)', num: false },
  { key: 'callsign', label: 'Callsign', title: 'Callsign (ICAO address when there is none)', num: false },
  { key: 'route', label: 'Route', title: 'Route (origin - destination)', num: false },
  { key: 'type', label: 'Type', title: 'ICAO aircraft type designator', num: false },
  { key: 'squawk', label: 'Sqk', title: 'Squawk (7500, 7600 and 7700 highlighted)', num: false },
  { key: 'alt', label: 'Alt ft', title: 'Barometric altitude in feet; ▲ climbing / ▼ descending faster than 300 ft/min', num: true },
  { key: 'speed', label: 'Spd kt', title: 'Ground speed in knots', num: true },
]

export const ROW_H = 22 // px; fixed, the virtual scroll depends on it (table.css .fh-row height)
export const OVERSCAN = 8 // rows kept above and below the viewport so a fast scroll never shows a gap
// ponytail: rows show values up to RESORT_MS old (a list, not a gauge; tar1090 also refreshes its table about once a
// second). Upgrade if a live column is wanted: repaint only the visible rows every frame from a hex → entry lookup.
export const RESORT_MS = 1000 // at most one copy + filter + sort per second from update()
const VS_ARROW_FPM = 300
const GROUND = -1e9 // sort key: below every airborne altitude
const noFlag = (): string => ''

const finite = (v: number | null): v is number => v !== null && Number.isFinite(v)

/** 35000 → "35,000". Not toLocaleString: that builds a number formatter per call. */
const grouped = (n: number): string => String(Math.round(n) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

function keyOf(e: FleetEntry, key: TableKey): string | number | null {
  const i = e.info
  switch (key) {
    case 'hex': return e.hex
    case 'callsign': return i?.callsign ?? null
    case 'route': return i?.route ?? null
    case 'type': return i?.typeCode ?? null
    case 'squawk': return i?.squawk ?? null
    case 'alt': return e.onGround ? GROUND : finite(e.altFt) ? e.altFt : null
    case 'speed': return finite(e.gsKt) ? e.gsKt : null
  }
}

/**
 * The rows sorted by key (ascending, or descending when desc). Unknown values go last in both directions; equal keys
 * are ordered by hex so the order is stable from one re-sort to the next. Returns a new array; the input is untouched.
 */
export function sortRows(rows: readonly FleetEntry[], key: TableKey, desc: boolean): FleetEntry[] {
  const n = rows.length
  const keys: (string | number | null)[] = []
  const idx: number[] = []
  for (let i = 0; i < n; i++) {
    keys.push(keyOf(rows[i], key))
    idx.push(i)
  }
  const sign = desc ? -1 : 1
  idx.sort((i, j) => {
    const a = keys[i]
    const b = keys[j]
    if (a !== b) {
      if (a === null) return 1
      if (b === null) return -1
      if (a < b) return -sign
      if (a > b) return sign
    }
    const ha = rows[i].hex
    const hb = rows[j].hex
    return ha < hb ? -1 : ha > hb ? 1 : 0
  })
  const out: FleetEntry[] = []
  for (let k = 0; k < n; k++) out.push(rows[idx[k]])
  return out
}

const has = (v: string | null | undefined, q: string): boolean => v != null && v.toLowerCase().includes(q)

/** The rows whose callsign, hex, registration, type or squawk contains the query (trimmed, any case). New array. */
export function filterRows(rows: readonly FleetEntry[], query: string): FleetEntry[] {
  const q = query.trim().toLowerCase()
  if (q === '') return rows.slice()
  const out: FleetEntry[] = []
  for (const e of rows) {
    const i = e.info
    if (has(e.hex, q) || has(i?.callsign, q) || has(i?.reg, q) || has(i?.typeCode, q) || has(i?.squawk, q)) out.push(e)
  }
  return out
}

export function isEmergencySquawk(squawk: string | null): boolean {
  return squawk === '7500' || squawk === '7600' || squawk === '7700'
}

/** Text of column `col` (index into COLUMNS) for one row; '' when unknown. */
export function cellText(e: FleetEntry, col: number, flagOf: (hex: string) => string = noFlag): string {
  const i = e.info
  switch (col) {
    case 0: return flagOf(e.hex)
    case 1: return i?.callsign ?? e.hex
    case 2: return i?.route == null ? '' : i.route.replace(/\s*-\s*/g, ' - ')
    case 3: return i?.typeCode ?? ''
    case 4: return i?.squawk ?? ''
    case 5: {
      if (e.onGround) return 'ground'
      if (!finite(e.altFt)) return ''
      const vs = e.vsFpm
      return grouped(e.altFt) + (finite(vs) && vs > VS_ARROW_FPM ? ' ▲' : finite(vs) && vs < -VS_ARROW_FPM ? ' ▼' : '')
    }
    case 6: return finite(e.gsKt) ? String(Math.round(e.gsKt)) : ''
    default: return ''
  }
}

/** Rows [first, end) to keep in the DOM for a viewport at scrollTop of height viewH (px). */
export function windowRange(scrollTop: number, viewH: number, rowH: number, count: number, overscan: number): { first: number; end: number } {
  const first = Math.max(0, Math.floor(scrollTop / rowH) - overscan)
  const end = Math.min(count, Math.ceil((scrollTop + viewH) / rowH) + overscan)
  return { first: Math.min(first, end), end }
}

// ---- DOM ----------------------------------------------------------------------------------------------------------

export interface TableOpts {
  onSelect(hex: string): void
  onHover(hex: string | null): void
  flagOf?: (hex: string) => string // emoji flag of the hex's country ('' when unknown); injected by the app (B-A)
}

export interface TableHandle {
  /** all = every aircraft known, onScreen = the ones in the view. Cheap to call every frame (see the file comment). */
  update(all: readonly FleetEntry[], onScreen: readonly FleetEntry[], selectedHex: string | null): void
  destroy(): void
}

/** The table's own copy of one on-screen aircraft (Fleet's objects are reused every frame, so none are kept). */
interface Row extends FleetEntry {
  gen: number // copy() generation that last saw this hex on screen
}

/** One recycled row element and what it currently shows, so unchanged cells are never written. */
interface Slot {
  el: HTMLDivElement
  cells: HTMLSpanElement[]
  text: Text[]
  shown: string[]
  row: number // index into the sorted list, -1 = hidden
  hex: string
  sel: boolean
  emerg: boolean
}

const NCOL = COLUMNS.length

function blankRow(): Row {
  return { hex: '', lat: 0, lon: 0, hM: 0, altFt: null, onGround: false, trackDeg: null, gsKt: null, vsFpm: null, ageS: 0, quality: 'other', info: null, gen: 0 }
}

function copyEntry(d: FleetEntry, s: FleetEntry): void {
  d.hex = s.hex
  d.lat = s.lat
  d.lon = s.lon
  d.hM = s.hM
  d.altFt = s.altFt
  d.onGround = s.onGround
  d.trackDeg = s.trackDeg
  d.gsKt = s.gsKt
  d.vsFpm = s.vsFpm
  d.ageS = s.ageS
  d.quality = s.quality
  d.info = s.info // AircraftInfo is replaced, never mutated, when it changes
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = className
  if (text !== '') el.textContent = text
  return el
}

export function mountTable(root: HTMLElement, opts: TableOpts): TableHandle {
  const flagOf = opts.flagOf ?? noFlag

  const el = h('aside', 'fh-table')
  el.setAttribute('aria-label', 'Aircraft on screen')
  const head = h('div', 'fh-table-head')
  const toggle = h('button', 'fh-table-toggle', '▸')
  toggle.type = 'button'
  toggle.title = 'Hide the aircraft list'
  toggle.setAttribute('aria-expanded', 'true')
  const totalEl = h('span', 'fh-table-count')
  const shownEl = h('span', 'fh-table-count')
  head.append(toggle, totalEl, shownEl)

  const body = h('div', 'fh-table-body')
  const search = h('input', 'fh-table-search')
  search.type = 'search'
  search.placeholder = 'Search callsign, hex, reg, type, squawk'
  search.spellcheck = false
  search.autocomplete = 'off'
  search.setAttribute('aria-label', 'Search aircraft')
  const cols = h('div', 'fh-table-cols fh-grid')
  const colButtons = COLUMNS.map((c) => {
    const b = h('button', c.num ? 'fh-num' : '', c.label)
    b.type = 'button'
    b.title = c.title
    b.onclick = () => sortBy(c.key)
    return b
  })
  cols.append(...colButtons)
  const empty = h('div', 'fh-table-empty')
  const scroll = h('div', 'fh-table-scroll')
  const spacer = h('div', 'fh-table-spacer')
  scroll.append(spacer)
  body.append(search, cols, empty, scroll)
  el.append(head, body)
  root.append(el)

  let sortKey: TableKey = 'callsign'
  let desc = false
  let query = ''
  let collapsed = false
  let selected: string | null = null
  let lastCopyMs = -Infinity
  let total = 0
  let viewH = 0
  let list: FleetEntry[] = [] // filtered + sorted Rows
  let count = -1
  const rowsByHex = new Map<string, Row>() // the copy of each aircraft on screen at the last copy()
  // The on-screen copies in the last display order, then the new ones. Sorting starts from this order, and V8's sort
  // (TimSort) is adaptive: on nearly sorted input it does about n comparisons instead of n·log2(n) (5,000 → ~61,000).
  let snap: Row[] = []
  let gen = 0
  const slots: Slot[] = []
  let hoverSlot = -1
  let hoverHex: string | null = null
  let shownTotal = ''
  let shownOnScreen = ''

  function setText(node: HTMLElement, text: string): void {
    if (node.textContent !== text) node.textContent = text
  }

  function paintCounts(): void {
    const t = `Total aircraft: ${grouped(total)}`
    const q = query.trim() === '' ? '' : ` · ${grouped(Math.max(count, 0))} match`
    const s = `On screen: ${grouped(snap.length)}${q}`
    if (t !== shownTotal) totalEl.textContent = shownTotal = t
    if (s !== shownOnScreen) shownEl.textContent = shownOnScreen = s
  }

  function paintHeader(): void {
    COLUMNS.forEach((c, k) => {
      const b = colButtons[k]
      const on = c.key === sortKey
      b.dataset.sort = on ? (desc ? 'desc' : 'asc') : ''
      b.setAttribute('aria-pressed', String(on))
    })
  }

  function newSlot(j: number): Slot {
    const row = h('div', 'fh-row fh-grid')
    row.dataset.slot = String(j)
    row.hidden = true
    const cells: HTMLSpanElement[] = []
    const text: Text[] = []
    for (const c of COLUMNS) {
      const cell = h('span', c.num ? 'fh-num' : '')
      const t = document.createTextNode('')
      cell.append(t)
      row.append(cell)
      cells.push(cell)
      text.push(t)
    }
    spacer.append(row)
    return { el: row, cells, text, shown: new Array<string>(NCOL).fill(''), row: -1, hex: '', sel: false, emerg: false }
  }

  function write(s: Slot, c: number, t: string): void {
    if (s.shown[c] === t) return
    s.shown[c] = t
    s.text[c].data = t // textContent-equivalent: upstream strings are never parsed as HTML
  }

  function hide(s: Slot): void {
    if (s.row === -1) return
    s.row = -1
    s.el.hidden = true
  }

  function paint(s: Slot, i: number): void {
    const e = list[i]
    if (s.row !== i) {
      if (s.row === -1) s.el.hidden = false
      s.row = i
      s.el.style.transform = `translateY(${i * ROW_H}px)`
      s.el.classList.toggle('fh-odd', (i & 1) === 1)
    }
    if (s.hex !== e.hex) {
      s.hex = e.hex
      write(s, 0, flagOf(e.hex))
    }
    for (let c = 1; c < NCOL; c++) write(s, c, cellText(e, c))
    const sel = e.hex === selected
    if (sel !== s.sel) s.el.classList.toggle('fh-sel', (s.sel = sel))
    const emerg = isEmergencySquawk(e.info?.squawk ?? null)
    if (emerg !== s.emerg) s.cells[4].classList.toggle('fh-emerg', (s.emerg = emerg))
  }

  function render(): void {
    if (collapsed) return
    const { first, end } = windowRange(scroll.scrollTop, viewH, ROW_H, count, OVERSCAN)
    if (end - first > slots.length) {
      // More rows fit than there are elements: grow, and forget the old row → element mapping (it was i % old size).
      for (const s of slots) hide(s)
      while (slots.length < end - first) slots.push(newSlot(slots.length))
    }
    const n = slots.length
    for (let i = first; i < end; i++) paint(slots[i % n], i)
    for (const s of slots) if (s.row !== -1 && (s.row < first || s.row >= end)) hide(s)
    emitHover()
  }

  function paintSelection(): void {
    for (const s of slots) {
      const sel = s.row !== -1 && s.hex === selected
      if (sel !== s.sel) s.el.classList.toggle('fh-sel', (s.sel = sel))
    }
  }

  /** Filter + sort the last copy and redraw. Runs on each copy (≤ 1 Hz) and at once on a sort or search change. */
  function refilter(): void {
    list = sortRows(filterRows(snap, query), sortKey, desc)
    if (query.trim() === '') snap = list as Row[] // same rows, now in display order
    if (list.length !== count) {
      count = list.length
      spacer.style.height = `${count * ROW_H}px`
    }
    const none = count === 0
    empty.hidden = !none
    if (none) setText(empty, query.trim() === '' ? 'No aircraft on screen' : 'No match')
    paintCounts()
    render()
  }

  function copy(all: readonly FleetEntry[], onScreen: readonly FleetEntry[]): void {
    total = all.length
    gen++
    const fresh: Row[] = []
    for (const e of onScreen) {
      let r = rowsByHex.get(e.hex)
      if (r === undefined) {
        rowsByHex.set(e.hex, (r = blankRow()))
        fresh.push(r)
      }
      copyEntry(r, e)
      r.gen = gen
    }
    const next: Row[] = []
    for (const r of snap) {
      if (r.gen === gen) next.push(r)
      else rowsByHex.delete(r.hex) // left the screen
    }
    for (const r of fresh) next.push(r)
    snap = next
  }

  function sortBy(key: TableKey): void {
    if (key === sortKey) desc = !desc
    else {
      sortKey = key
      desc = false
    }
    paintHeader()
    refilter()
  }

  function slotOf(target: EventTarget | null): Slot | null {
    const row = target instanceof Element ? target.closest<HTMLElement>('.fh-row') : null
    const s = row === null ? undefined : slots[Number(row.dataset.slot)]
    return s === undefined || s.row === -1 ? null : s
  }

  function emitHover(): void {
    const s = hoverSlot === -1 ? null : slots[hoverSlot]
    const hex = s === null || s.row === -1 ? null : s.hex
    if (hex === hoverHex) return
    hoverHex = hex
    opts.onHover(hex)
  }

  toggle.onclick = () => {
    collapsed = !collapsed
    el.classList.toggle('fh-collapsed', collapsed)
    toggle.textContent = collapsed ? '◂' : '▸'
    toggle.title = collapsed ? 'Show the aircraft list' : 'Hide the aircraft list'
    toggle.setAttribute('aria-expanded', String(!collapsed))
    if (collapsed) {
      hoverSlot = -1
      emitHover()
    } else refilter()
  }
  search.addEventListener('input', () => {
    query = search.value
    refilter()
  })
  // Keys typed into the search box are not app shortcuts. Esc clears the box, then leaves it.
  search.addEventListener('keydown', (ev) => {
    ev.stopPropagation()
    if (ev.key !== 'Escape') return
    if (search.value !== '') {
      search.value = ''
      query = ''
      refilter()
    } else search.blur()
  })
  scroll.addEventListener('scroll', render, { passive: true })
  // ponytail: rows are mouse-only (header buttons and the search box are keyboard-reachable). Upgrade: a roving
  // tabindex on the recycled rows plus Up/Down/Enter handling, scrolling the list to keep the focused row in view.
  scroll.addEventListener('click', (ev) => {
    const s = slotOf(ev.target)
    if (s !== null) opts.onSelect(s.hex)
  })
  scroll.addEventListener('mouseover', (ev) => {
    const s = slotOf(ev.target)
    hoverSlot = s === null ? -1 : slots.indexOf(s)
    emitHover()
  })
  scroll.addEventListener('mouseleave', () => {
    hoverSlot = -1
    emitHover()
  })
  // The viewport height changes with the window and on expand; reading it here keeps layout reads out of render().
  const resize = new ResizeObserver(() => {
    viewH = scroll.clientHeight
    render()
  })
  resize.observe(scroll)

  paintHeader()
  refilter()

  return {
    update(all, onScreen, selectedHex) {
      if (selectedHex !== selected) {
        selected = selectedHex
        paintSelection()
      }
      const now = performance.now()
      if (now - lastCopyMs < RESORT_MS) return
      lastCopyMs = now
      copy(all, onScreen)
      if (collapsed) paintCounts()
      else refilter()
    },
    destroy() {
      resize.disconnect()
      if (hoverHex !== null) opts.onHover(null)
      el.remove()
    },
  }
}
```

- [ ] **Step 3: Run the tests and type-check**

Run: `node --test client/ui/table.test.ts`
Expected: PASS: `ℹ tests 11`, `ℹ pass 11`, `ℹ fail 0`. The load hook turns `./table.css` into an empty module.

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/ui/table'`
Expected: no output (grep exits 1).

- [ ] **Step 4: Commit**

```bash
git add client/ui/table.ts client/ui/table.css
git commit -m "feat(ui): virtualised, sortable, searchable aircraft table"
```

---

### Task 3: Harness page and measurements

**Files:**
- Create: `harness/table.html`, `harness/table.ts`

**Interfaces:**
- Consumes: `mountTable` (Task 2), `FleetEntry`, `AircraftInfo`; the Vite setup from WP-00
- Produces: the page `/harness/table.html` (`?n=<count>` sets the aircraft count, default 5000; `?clock=worker` drives the loop from a worker timer for measuring in a hidden tab) and, for console checks, `window.harness = { table, stats(), resetStats(), scrollTest(ms?, pxPerFrame?), setN(n), setMode('all' | 'pan' | 'none'), select(hex), all }`

- [ ] **Step 1: Write the page**

```html
<!-- harness/table.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Harness: aircraft table</title>
    <style>
      /* A light, busy street-map stand-in: the table must read over it, as it will over the browse map. */
      html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
      body { background:
        repeating-linear-gradient(28deg, transparent 0 58px, #f6f1e4 58px 64px),
        repeating-linear-gradient(-62deg, transparent 0 90px, #ffffff 90px 97px),
        linear-gradient(160deg, #e8e4d8, #d6e6c9 45%, #aad3df 75%, #e8e4d8); }
      #panel { position: absolute; top: 8px; left: 8px; z-index: 20; width: min(440px, calc(100% - 460px)); min-width: 260px;
        padding: 6px 8px; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; color: #fff;
        background: rgba(0, 0, 0, 0.75); border-radius: 4px; }
      #panel button { font: inherit; margin: 0 4px 4px 0; }
      #panel button[aria-pressed='true'] { outline: 2px solid #1e88e5; }
      #stats { white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <div id="panel">
      <div id="controls"></div>
      <div id="stats">loading…</div>
    </div>
    <script type="module" src="./table.ts"></script>
  </body>
</html>
```

```ts
// harness/table.ts
// WP-B-U1 harness: /harness/table.html mounts the aircraft table over a map-like background and drives it every
// animation frame with N synthetic aircraft (default 5,000; ?n=12000) whose altitude, speed and squawk change like live
// data, reusing the same objects the way Fleet does. It measures update() on every frame (p50/p95/max, plus the
// per-second maximum, which is the frame that re-sorts), frame intervals, long tasks, and a scripted scroll test.
// Everything is also on window.harness for console checks.
import type { AircraftInfo } from '../shared/info.ts'
import type { FleetEntry } from '../client/types.ts'
import { mountTable } from '../client/ui/table.ts'

// Seeded PRNG (mulberry32), so every run shows the same fleet.
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
const rand = rng(20260922)
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]

// Harness stand-in for the app's flagOf (B-A injects B-C1's countryOf + flagEmoji). A few ICAO address blocks
// (ICAO Annex 10 Vol. III, Table 9-1) so the synthetic hexes get plausible flags; illustrative only.
const BLOCKS: [string, string][] = [['a', 'US'], ['3c', 'DE'], ['40', 'GB'], ['738', 'IL'], ['4b0', 'CH'], ['06a', 'QA'], ['4a8', 'RO']]
const flagEmoji = (iso2: string): string => String.fromCodePoint(...[...iso2].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65))
const flagCache = new Map<string, string>()
function flagOf(hex: string): string {
  let f = flagCache.get(hex)
  if (f === undefined) {
    const b = BLOCKS.find(([p]) => hex.startsWith(p))
    flagCache.set(hex, (f = b === undefined ? '' : flagEmoji(b[1])))
  }
  return f
}

const AIRLINES = ['ELY', 'UAL', 'DLH', 'BAW', 'QTR', 'ROT', 'SWR', 'RYR', 'WZZ', 'AAL', 'ISR', 'EZY']
const AIRPORTS = ['LLBG', 'LROP', 'OTHH', 'EGLL', 'EDDF', 'KJFK', 'LSZH', 'LOWW', 'EHAM', 'LFPG', 'LTFM', 'KSFO']
const TYPES = ['B738', 'A320', 'A21N', 'B789', 'A359', 'E190', 'B77W', 'A333', 'C172', 'AT76', 'B38M', 'A20N']
const EMERGENCY = ['7500', '7600', '7700']

const usedHexes = new Set<string>() // hexes are unique, as in Fleet
function newHex(): string {
  for (;;) {
    const [prefix] = pick(BLOCKS.concat([['', '']]))
    let h = prefix
    while (h.length < 6) h += Math.floor(rand() * 16).toString(16)
    if (usedHexes.has(h)) continue
    usedHexes.add(h)
    return h
  }
}

function newInfo(hex: string): AircraftInfo {
  const noCallsign = rand() < 0.03
  const squawk = rand() < 0.002 ? pick(EMERGENCY) : Math.floor(rand() * 4096).toString(8).padStart(4, '0')
  const from = pick(AIRPORTS)
  let to = pick(AIRPORTS)
  if (to === from) to = 'LOWI'
  return {
    hex,
    callsign: noCallsign ? null : `${pick(AIRLINES)}${Math.floor(rand() * 9000) + 1}`,
    reg: `${pick(['N', '4X-', 'D-', 'G-', 'YR-', 'A7-', 'HB-'])}${Math.floor(rand() * 46656).toString(36).toUpperCase().padStart(3, 'A')}`,
    typeCode: rand() < 0.05 ? null : pick(TYPES),
    category: 'A3',
    squawk,
    emergency: null,
    military: false,
    route: rand() < 0.2 ? null : `${from}-${to}`,
  }
}

function newEntry(): FleetEntry {
  const hex = newHex()
  const onGround = rand() < 0.05
  return {
    hex, lat: 20 + rand() * 45, lon: -30 + rand() * 90, hM: 0,
    altFt: onGround ? null : Math.round(rand() * 45000), onGround,
    trackDeg: rand() * 360, gsKt: onGround ? rand() * 25 : 120 + rand() * 400,
    vsFpm: onGround ? 0 : pick([0, 0, 0, 1500, -1200, 2400, -800]), ageS: 0, quality: 'adsb2', info: newInfo(hex),
  }
}

const all: FleetEntry[] = []
const onScreenBuf: FleetEntry[] = [] // reused every frame, like the app's on-screen filter would
let mode: 'all' | 'pan' | 'none' = 'all'
let selected: string | null = null
let hovered: string | null = null

function setN(n: number): void {
  while (all.length < n) all.push(newEntry())
  all.length = n
}

/** Live-data stand-in: move altitudes by their vertical rate, jitter speeds, and replace a few info objects. */
function step(dtS: number, tS: number): void {
  for (const e of all) {
    if (e.onGround) continue
    e.altFt = Math.max(0, (e.altFt ?? 0) + ((e.vsFpm ?? 0) * dtS) / 60)
    if (e.altFt > 45000 || e.altFt < 1000) e.vsFpm = -(e.vsFpm ?? 0)
    e.gsKt = (e.gsKt ?? 0) + (rand() - 0.5) * 0.5
    e.lon += ((e.gsKt ?? 0) * dtS) / 3600 / 60 // about right at mid latitudes; only the pan window cares
  }
  for (let k = 0; k < 3 && all.length > 0; k++) {
    const e = all[Math.floor(rand() * all.length)]
    e.info = { ...(e.info ?? newInfo(e.hex)), squawk: rand() < 0.01 ? '7700' : Math.floor(rand() * 4096).toString(8).padStart(4, '0') }
  }
  onScreenBuf.length = 0
  if (mode === 'all') for (const e of all) onScreenBuf.push(e)
  else if (mode === 'pan') {
    const west = -30 + ((tS * 4) % 90) // a 45° window sliding east over the 90° wide fleet
    for (const e of all) if (e.lon >= west && e.lon < west + 45) onScreenBuf.push(e)
  }
}

// --- measurement ---------------------------------------------------------------------------------------------------
const N_KEEP = 1200
const updMs = new Float64Array(N_KEEP)
const frameMs = new Float64Array(N_KEEP)
let nUpd = 0
let nFrame = 0
const perSecondMax: number[] = []
let secMax = 0
let secStart = 0
let longTasks = 0
new PerformanceObserver((list) => (longTasks += list.getEntries().length)).observe({ type: 'longtask', buffered: true })

function pct(xs: ArrayLike<number>, n: number, p: number): number {
  const a = Array.from({ length: Math.min(n, xs.length) }, (_, i) => xs[i]).sort((x, y) => x - y)
  return a.length === 0 ? Number.NaN : a[Math.min(a.length - 1, Math.floor(p * a.length))]
}

function stats(): Record<string, number | string | null> {
  const nu = Math.min(nUpd, N_KEEP)
  const nf = Math.min(nFrame, N_KEEP)
  return {
    aircraft: all.length,
    onScreen: onScreenBuf.length,
    mode,
    updates: nUpd,
    updateP50Ms: pct(updMs, nu, 0.5),
    updateP95Ms: pct(updMs, nu, 0.95),
    updateP99Ms: pct(updMs, nu, 0.99),
    updateMaxMs: pct(updMs, nu, 1),
    resortP50Ms: pct(perSecondMax, perSecondMax.length, 0.5), // per-second max ≈ the frame that copies + sorts
    resortMaxMs: pct(perSecondMax, perSecondMax.length, 1),
    frameP50Ms: pct(frameMs, nf, 0.5),
    frameP95Ms: pct(frameMs, nf, 0.95),
    longTasks,
    domRows: document.querySelectorAll('.fh-row:not([hidden])').length,
    selected,
    hovered,
  }
}

function resetStats(): void {
  nUpd = nFrame = 0
  perSecondMax.length = 0
  secMax = 0
  longTasks = 0
}

const table = mountTable(document.body, {
  onSelect: (hex) => (selected = hex),
  onHover: (hex) => (hovered = hex),
  flagOf,
})

// Scroll handler cost: a capture listener on document runs before the table's own scroll listener on the element,
// and a listener added to the element after mountTable runs after it.
const scrollEl = document.querySelector<HTMLElement>('.fh-table-scroll')!
let scrollT0 = 0
const scrollMs: number[] = []
document.addEventListener('scroll', () => (scrollT0 = performance.now()), { capture: true, passive: true })
scrollEl.addEventListener('scroll', () => scrollMs.push(performance.now() - scrollT0), { passive: true })

/** Scrolls the table by pxPerFrame every frame for ms (wrapping at the end) and reports frame and handler times. */
function scrollTest(ms = 5000, pxPerFrame = 45): Promise<Record<string, number>> {
  scrollMs.length = 0
  const frames: number[] = []
  const lt0 = longTasks
  return new Promise((resolve) => {
    const t0 = performance.now()
    let last = t0
    const tick = (now: number): void => {
      frames.push(now - last)
      last = now
      const max = scrollEl.scrollHeight - scrollEl.clientHeight
      scrollEl.scrollTop = scrollEl.scrollTop + pxPerFrame > max ? 0 : scrollEl.scrollTop + pxPerFrame
      if (now - t0 < ms) requestAnimationFrame(tick)
      else {
        frames.shift()
        resolve({
          frames: frames.length,
          frameP50Ms: pct(frames, frames.length, 0.5),
          frameP95Ms: pct(frames, frames.length, 0.95),
          frameMaxMs: pct(frames, frames.length, 1),
          framesOver25Ms: frames.filter((f) => f > 25).length,
          scrollEvents: scrollMs.length,
          handlerP95Ms: pct(scrollMs, scrollMs.length, 0.95),
          handlerMaxMs: pct(scrollMs, scrollMs.length, 1),
          longTasks: longTasks - lt0,
          domRows: document.querySelectorAll('.fh-row:not([hidden])').length,
        })
      }
    }
    requestAnimationFrame(tick)
  })
}

// --- frame loop ----------------------------------------------------------------------------------------------------
// ?clock=worker drives the loop from a worker timer at ~60 Hz instead of requestAnimationFrame, for measuring update()
// in a hidden tab (no animation frames there; the page does not paint either, so the scroll test needs a visible tab).
const workerClock = new URLSearchParams(location.search).get('clock') === 'worker'
const statsEl = document.getElementById('stats')!
let lastFrame = performance.now()
let lastStats = 0
function frame(now: number): void {
  const dtS = Math.min(0.1, (now - lastFrame) / 1000)
  frameMs[nFrame++ % N_KEEP] = now - lastFrame
  lastFrame = now
  step(dtS, now / 1000)
  const t0 = performance.now()
  table.update(all, onScreenBuf, selected)
  const dt = performance.now() - t0
  updMs[nUpd++ % N_KEEP] = dt
  if (now - secStart >= 1000) {
    if (secStart !== 0) perSecondMax.push(secMax)
    secStart = now
    secMax = 0
  }
  secMax = Math.max(secMax, dt)
  if (now - lastStats > 500) {
    lastStats = now
    const s = stats()
    statsEl.textContent = Object.entries(s)
      .map(([k, v]) => `${k.padEnd(13)} ${typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(3) : String(v)}`)
      .join('\n')
  }
  if (!workerClock) requestAnimationFrame(frame)
}

// --- controls ------------------------------------------------------------------------------------------------------
const controls = document.getElementById('controls')!
function button(label: string, group: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = label
  b.dataset.group = group
  b.onclick = () => {
    for (const x of controls.querySelectorAll<HTMLButtonElement>('button')) if (x.dataset.group === group && group !== '') x.setAttribute('aria-pressed', 'false')
    if (group !== '') b.setAttribute('aria-pressed', 'true')
    onClick()
  }
  controls.append(b)
  return b
}
const n0 = Number(new URLSearchParams(location.search).get('n') ?? 5000)
for (const n of [1000, 5000, 12000]) button(`${n / 1000}k`, 'n', () => (setN(n), resetStats())).setAttribute('aria-pressed', String(n === n0))
for (const m of ['all', 'pan', 'none'] as const) button(`on screen: ${m}`, 'mode', () => (mode = m, resetStats())).setAttribute('aria-pressed', String(m === 'all'))
button('scroll test', '', () => void scrollTest().then((r) => console.log('scrollTest', r)))
button('jump test', '', () => void scrollTest(3000, 2000).then((r) => console.log('jumpTest', r)))
button('select random', '', () => (selected = pick(onScreenBuf)?.hex ?? null))
button('reset stats', '', resetStats)
addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') selected = null
})

setN(n0)
if (workerClock) {
  const ticker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 1000 / 60)'], { type: 'text/javascript' })))
  ticker.onmessage = () => frame(performance.now())
} else requestAnimationFrame(frame)
;(window as unknown as { harness: object }).harness = {
  table, stats, resetStats, scrollTest, setN, all,
  setMode: (m: typeof mode) => (mode = m),
  select: (hex: string | null) => (selected = hex),
}
```

- [ ] **Step 2: Type-check the page**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/ui/table|harness/table'`
Expected: no output (grep exits 1).

- [ ] **Step 3: Look at it and measure**

Run: `npx vite --port 5414 --strictPort`, then open `http://localhost:5414/harness/table.html` at a window size of about 1280×800.
Expected:
- **Layout:** a dark panel on the right, 420 px wide and nearly full height, over a light map-like background. The header reads `Total aircraft: 5,000   On screen: 5,000`. Below it are the search box and the header row `⚑ Callsign ▴ Route Type Sqk Alt ft Spd kt`. The rows are sorted by callsign (`AAL…` first), with flags on the `a…`, `3c…`, `40…`, `738…`, `4b0…`, `06a…` and `4a8…` hexes, routes such as `OTHH - LLBG`, and altitudes such as `30,490`, `3,347 ▲` and `ground`.
- **Stats panel (top left, twice a second):** `updateP95Ms` ≤ 5, measured 0.0; `resortP50Ms` ≈ 1.6 on an M-series Mac; `longTasks` 0; `domRows` about 40.
- **Console:** `await harness.scrollTest()` gives `framesOver25Ms: 0`, a handler p95 under 1 ms and `domRows` under 50. `await harness.scrollTest(3000, 2000)` (jumps) also gives 0 frames over 25 ms.
- **By hand:**
  - Click `Alt ft` twice: it shows `▾`, the highest altitudes come first and `ground` sorts after the airborne rows.
  - Type `ely`: the header adds `· N match`. Type `7700`: the squawk cells turn red.
  - Click a row: it turns blue and `selected` shows its hex. Hover shows `hovered`, and leaving the list gives `null`.
  - `Esc` in the search box clears it, and the selection stays (the key does not reach the page).
  - The toggle collapses the panel to its header and expands it again.
  - The `12k` and `on screen: pan` buttons keep `updateP95Ms` at 0.0 ms.
- **Errors:** the console has none.

Stop the server.

- [ ] **Step 4: Commit**

```bash
git add harness/table.html harness/table.ts
git commit -m "test(ui): aircraft table harness with 5k/12k synthetic aircraft and timing"
```

---

### Task 4: WP gate

- [ ] **Step 1: This package's tests**

Run: `node --test client/ui/table.test.ts`
Expected: `ℹ tests 11`, `ℹ pass 11`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/ui/table|harness/table'`
Expected: no output (grep exits 1).

- [ ] **Step 3: Full check**

Run: `npm run check`
Expected: `tsc` prints nothing and every test passes. This package adds 11 tests; the other packages' tests are unchanged.

- [ ] **Step 4: Confirm there is nothing left to commit**

Run: `git status --short`
Expected: no output.

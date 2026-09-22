# WP-V6 — HUD & Banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the chased aircraft's numbers honestly. Every HUD value carries a tag: observed, derived, stale or unknown. A one-line banner reports provider trouble, lost signal and prediction. An attribution box is always visible and always says "Not for navigation".

**Architecture:** Pure text is kept apart from the DOM.
- `client/ui/format.ts` is pure and tested in Node. It exports `hudFields`, `hudTitle`, `bannerText`, `attributionLines` and `isStale`.
- `client/ui/hud.ts` and `client/ui/banner.ts` are thin DOM mounts. They call format.ts and set text with `textContent` only, never `innerHTML`, because callsigns come from upstream data. `mountAttribution` lives in `banner.ts`.
- `client/ui/ui.css` places the HUD bottom-left, the banner top-centre and the attribution bottom-right. The HUD sits 40 px up so it clears Cesium's own credit bar. The panels are dark and translucent, with a text shadow, and use `pointer-events: none`, so globe drag and aircraft picking pass through them.
- Consumer: A2 (`startApp`) mounts all three in its full-screen root and calls `hud.update(state, status)` and `banner.update(status, state)` every frame. The HUD rebuilds its DOM only when its text changes.

The rules, each pinned by a test in Task 1:
- **Fields**, always in this order: `GS` (`146 kt`), `ALT`, `VS`, `TRK` (`282°`), `HDG`, `AGE`, `SRC`. When nothing is selected (`s === null`), there are no fields and the HUD hides.
- **Tag precedence:** `unknown` (value null or not finite, shown as `—`) wins over `stale` (`mode === 'stale'` or `ageS > 10`). `stale` wins over `derived` (a computed field, or any field while `mode === 'extrap'`). `derived` wins over `observed`. The computed fields are `VS` (vertical filter), `HDG` (true heading or track, smoothed by the attitude synthesiser) and `AGE` (render clock). `GS`, `ALT`, `TRK` and `SRC` are taken as copied from the newest sample, so they are `observed` while interpolating.
- **ALT** is baro pressure altitude, labelled as such: `2,175 ft baro`. It gains the suffix ` · alt est.` when `altSource !== 'geom'`, because the drawn height then comes from baro and not from GNSS. On the ground it shows `GND`.
- **VS** is signed and rounded to 10 fpm (`+1,230 fpm`, `-740 fpm`, `0 fpm`), with no negative zero. **Angles** are three digits, wrapped into 000–359. **AGE** is `max(0, ageS)` with one decimal. `ageS` is negative while interpolating, because the drawn state then lies between real samples. **SRC** is `ADS-B v2`, `ADS-B v0-1`, `MLAT` or `other`, plus ` (replay)` when `status.source === 'replay'`, so replayed data is never shown as live.
- **bannerText precedence:** `degraded` comes first: `'blocked'` gives `Live data blocked by provider — showing nothing new`, `'rate-limited'` gives `Provider rate-limited us — updates slowed`, and `'upstream-down'` gives `Live data unavailable`. Next, a stale selected aircraft gives `Signal lost Ns ago` (whole seconds). Next, `mode === 'extrap'` gives `Predicting (no fresh data)`. Otherwise the result is `null` and the banner hides.
- **attributionLines** appends `Entertainment only. Not for navigation.` unless a given line already contains "not for navigation" (case-insensitive).

**Tech Stack:** Node ≥ 24.2 (native TypeScript), `node:test`, TypeScript 7 (type-check only), Vite 8 (CSS side-effect import, harness page). No new dependencies. The overlays are plain DOM laid over the viewer, so this package does not import Cesium.

**Wave:** 1 (parallel; depends only on WP-00). **Estimated:** 1 h. **Validated:** on 2026-09-22 (Node v25.2.1, TypeScript 7.0.2, Vite 8.3.0), every file below was run in the shared Wave 1 sandbox:
- `node --test client/ui/format.test.ts` passed 14/14.
- `npx tsc --noEmit` reported no errors in `client/ui/*` or `harness/hud.ts`.
- Each Step 2 below quotes its real RED output.
- `harness/hud.html` was checked in a browser under `vite --port 5306`. All eleven scenarios and the `play` loop rendered. The text was readable on the snow, sea, terrain and black-and-white stripe backgrounds. The `hidden` HUD and banner computed to `display: none`, the attribution had `pointer-events: none`, and the console had no errors. That check found one bug, now fixed: centring the banner with `left: 50%` plus a transform wrapped it at half the viewport width.
- The code blocks of this plan were then extracted into a clean WP-00 tree. There they passed the same 14/14, `tsc --noEmit` was clean for the whole tree, and `npm test` reported 54/54.

## Global Constraints

See `.planning/PLAN.md` § Global Constraints. They apply to every task here. These matter most in this package:
- **Safety and attribution** must be visible in the UI (PLAN.md "Safety" and "Attribution"). `mountAttribution` guarantees the "Not for navigation" line whatever lines the caller passes.
- Strings that come from data (callsign, type, hex) reach the DOM only through `textContent`.
- `hud.ts` and `banner.ts` import `./ui.css`, and only Vite understands that import. Never import them from a `*.test.ts`. The tests cover the pure `format.ts`. The DOM files are checked by `tsc` and by the harness.
- Erasable TypeScript only, and relative imports have a `.ts` extension. This package creates or edits only the files below.

## Files owned by this package

| Path | Responsibility |
|---|---|
| `client/ui/format.ts` | pure text: `hudFields`, `hudTitle`, `bannerText`, `attributionLines`, `isStale`, `STALE_AGE_S`, `NOT_FOR_NAVIGATION`, types `HudField` and `HudTag` |
| `client/ui/format.test.ts` | field order, units, rounding, tag precedence, banner wording and precedence, attribution safety line |
| `client/ui/hud.ts` | `mountHud(root)`: bottom-left readout with title, seven rows and a tag legend |
| `client/ui/banner.ts` | `mountBanner(root)` (top-centre banner) and `mountAttribution(root, lines)` (bottom-right credits) |
| `client/ui/ui.css` | placement, readability over imagery, tag colours (derived is also italic, so colour is not the only cue) |
| `harness/hud.html`, `harness/hud.ts` | eyeball page: eleven scenarios, a per-frame `play` loop, four imagery-like backgrounds |

---

### Task 1: Pure HUD, banner and attribution text

**Files:**
- Create: `client/ui/format.ts`, `client/ui/format.test.ts`
- Test: `client/ui/format.test.ts`

**Interfaces:**
- Consumes: `RenderState` (`client/types.ts`, WP-00: `mode`, `ageS`, `gsKt`, `altBaroFt`, `altSource`, `onGround`, `vsFpm`, `trackDeg`, `headingDeg`, `quality`, `callsign`, `typeCode`, `hex`). `StatusBrief` and `Degraded` (`shared/api.ts`, WP-00). `Quality` (`shared/types.ts`, WP-00).
- Produces:
  - `hudFields(s: RenderState | null, status: StatusBrief): HudField[]`, where `interface HudField { label: string; value: string; tag: HudTag }` and `type HudTag = 'observed' | 'derived' | 'stale' | 'unknown'`
  - `bannerText(status: StatusBrief, s: RenderState | null): string | null`
  - extra exports: `hudTitle(s: RenderState): string`, `attributionLines(lines: string[]): string[]`, `isStale(s: RenderState): boolean`, `STALE_AGE_S = 10` and `NOT_FOR_NAVIGATION = 'Entertainment only. Not for navigation.'`

- [ ] **Step 1: Write the failing test**

```ts
// client/ui/format.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { StatusBrief } from '../../shared/api.ts'
import type { RenderState } from '../types.ts'
import { NOT_FOR_NAVIGATION, attributionLines, bannerText, hudFields, hudTitle } from './format.ts'

const live: StatusBrief = { source: 'adsblol', degraded: null, cellPeriodP95S: 2, chasePeriodP95S: 1 }

const state = (o: Partial<RenderState> = {}): RenderState => ({
  hex: 'a1b2c3', lat: 37.6, lon: -122.4, hM: 700, headingDeg: 284.4, pitchDeg: -2, rollDeg: 0,
  gsKt: 146.2, trackDeg: 281.7, altBaroFt: 2175, vsFpm: -742, mode: 'interp', altSource: 'geom',
  onGround: false, ageS: -1.3, quality: 'adsb2', callsign: 'UAL123', typeCode: 'B738', ...o,
})

const field = (s: RenderState, label: string, status = live) => hudFields(s, status).find((f) => f.label === label)!
const tags = (s: RenderState) => hudFields(s, live).map((f) => f.tag)

test('interpolating: seven fields in a fixed order; sample values observed, computed values derived', () => {
  assert.deepEqual(hudFields(state(), live), [
    { label: 'GS', value: '146 kt', tag: 'observed' },
    { label: 'ALT', value: '2,175 ft baro', tag: 'observed' },
    { label: 'VS', value: '-740 fpm', tag: 'derived' },
    { label: 'TRK', value: '282°', tag: 'observed' },
    { label: 'HDG', value: '284°', tag: 'derived' },
    { label: 'AGE', value: '0.0 s', tag: 'derived' },
    { label: 'SRC', value: 'ADS-B v2', tag: 'observed' },
  ])
})

test('extrapolating: every value is derived', () => {
  assert.deepEqual(tags(state({ mode: 'extrap', ageS: 3.4 })), Array(7).fill('derived'))
  assert.equal(field(state({ mode: 'extrap', ageS: 3.4 }), 'AGE').value, '3.4 s')
})

test('stale: mode stale, or older than 10 s even before the track gives up', () => {
  assert.deepEqual(tags(state({ mode: 'stale', ageS: 9 })), Array(7).fill('stale'))
  assert.deepEqual(tags(state({ mode: 'extrap', ageS: 10.5 })), Array(7).fill('stale'))
  assert.deepEqual(tags(state({ mode: 'extrap', ageS: 10 })), Array(7).fill('derived'))
  assert.equal(field(state({ mode: 'stale', ageS: 14.2 }), 'AGE').value, '14.2 s')
})

test('missing values are unknown and shown as a dash, never as zero, even when stale', () => {
  for (const mode of ['interp', 'stale'] as const) {
    const s = state({ mode, ageS: mode === 'stale' ? 12 : -1, gsKt: null, trackDeg: null, vsFpm: null, altBaroFt: null })
    for (const label of ['GS', 'ALT', 'VS', 'TRK']) assert.deepEqual(field(s, label), { label, value: '—', tag: 'unknown' })
  }
  assert.deepEqual(field(state({ headingDeg: Number.NaN }), 'HDG'), { label: 'HDG', value: '—', tag: 'unknown' })
  assert.deepEqual(field(state({ ageS: Number.NaN }), 'AGE'), { label: 'AGE', value: '—', tag: 'unknown' })
})

test('ALT is pressure altitude, labelled baro; "alt est." when the drawn height is not GNSS; GND on the ground', () => {
  assert.equal(field(state({ altSource: 'baro-qnh' }), 'ALT').value, '2,175 ft baro · alt est.')
  assert.equal(field(state({ altSource: 'baro-bias', altBaroFt: 37000 }), 'ALT').value, '37,000 ft baro · alt est.')
  assert.equal(field(state({ altBaroFt: -120.4 }), 'ALT').value, '-120 ft baro')
  assert.deepEqual(field(state({ onGround: true, altBaroFt: null }), 'ALT'), { label: 'ALT', value: 'GND', tag: 'observed' })
})

test('VS: signed, rounded to 10 fpm, no negative zero', () => {
  assert.equal(field(state({ vsFpm: 1500 }), 'VS').value, '+1,500 fpm')
  assert.equal(field(state({ vsFpm: 1234 }), 'VS').value, '+1,230 fpm')
  assert.equal(field(state({ vsFpm: 4 }), 'VS').value, '0 fpm')
  assert.equal(field(state({ vsFpm: -3 }), 'VS').value, '0 fpm')
  assert.equal(field(state({ vsFpm: -2980 }), 'VS').value, '-2,980 fpm')
})

test('angles: three digits, wrapped into 000–359', () => {
  assert.equal(field(state({ trackDeg: 359.6 }), 'TRK').value, '000°')
  assert.equal(field(state({ trackDeg: 5 }), 'TRK').value, '005°')
  assert.equal(field(state({ headingDeg: -5 }), 'HDG').value, '355°')
  assert.equal(field(state({ headingDeg: 720.2 }), 'HDG').value, '000°')
})

test('SRC names the position quality and flags replayed (not live) data', () => {
  assert.equal(field(state({ quality: 'adsb01' }), 'SRC').value, 'ADS-B v0-1')
  assert.equal(field(state({ quality: 'mlat' }), 'SRC').value, 'MLAT')
  assert.equal(field(state({ quality: 'other' }), 'SRC').value, 'other')
  assert.equal(field(state(), 'SRC', { ...live, source: 'readsb' }).value, 'ADS-B v2')
  assert.equal(field(state(), 'SRC', { ...live, source: 'replay' }).value, 'ADS-B v2 (replay)')
})

test('no aircraft selected: no fields', () => {
  assert.deepEqual(hudFields(null, live), [])
})

test('hudTitle: callsign · type · hex, skipping unknowns', () => {
  assert.equal(hudTitle(state()), 'UAL123 · B738 · a1b2c3')
  assert.equal(hudTitle(state({ callsign: null, typeCode: null })), 'a1b2c3')
})

test('banner: provider problems first, with the exact wording', () => {
  assert.equal(bannerText({ ...live, degraded: 'blocked' }, null), 'Live data blocked by provider — showing nothing new')
  assert.equal(bannerText({ ...live, degraded: 'rate-limited' }, state()), 'Provider rate-limited us — updates slowed')
  assert.equal(bannerText({ ...live, degraded: 'upstream-down' }, state({ mode: 'stale', ageS: 30 })), 'Live data unavailable')
})

test('banner: selected aircraft stale → signal lost, whole seconds', () => {
  assert.equal(bannerText(live, state({ mode: 'stale', ageS: 14.4 })), 'Signal lost 14s ago')
  assert.equal(bannerText(live, state({ mode: 'stale', ageS: 9.6 })), 'Signal lost 10s ago')
  assert.equal(bannerText(live, state({ mode: 'extrap', ageS: 10.6 })), 'Signal lost 11s ago')
  assert.equal(bannerText(live, state({ mode: 'stale', ageS: Number.NaN })), 'Signal lost')
})

test('banner: extrapolating → predicting; otherwise nothing', () => {
  assert.equal(bannerText(live, state({ mode: 'extrap', ageS: 2 })), 'Predicting (no fresh data)')
  assert.equal(bannerText(live, state()), null)
  assert.equal(bannerText(live, null), null)
})

test('attribution always ends up with the not-for-navigation line, once', () => {
  const given = ['Aircraft data © adsb.lol contributors (ODbL)', 'Airports: OurAirports']
  assert.deepEqual(attributionLines(given), [...given, NOT_FOR_NAVIGATION])
  assert.equal(given.length, 2)
  assert.deepEqual(attributionLines(['x', 'Toy only, NOT FOR NAVIGATION']), ['x', 'Toy only, NOT FOR NAVIGATION'])
  assert.match(NOT_FOR_NAVIGATION, /Not for navigation/)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test client/ui/format.test.ts`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/client/ui/format.ts' imported from …/client/ui/format.test.ts`

- [ ] **Step 3: Write the implementation**

```ts
// client/ui/format.ts
// Pure text for the HUD, the status banner and the attribution box. hud.ts / banner.ts only put it in the DOM.
import type { Degraded, StatusBrief } from '../../shared/api.ts'
import type { Quality } from '../../shared/types.ts'
import type { RenderState } from '../types.ts'

/** observed = copied from the newest sample while interpolating; derived = computed or predicted; stale = too old to trust; unknown = no value. */
export type HudTag = 'observed' | 'derived' | 'stale' | 'unknown'

export interface HudField {
  label: string
  value: string
  tag: HudTag
}

/** Past this age a value is stale even if the track has not switched to mode 'stale' yet. */
export const STALE_AGE_S = 10

export const NOT_FOR_NAVIGATION = 'Entertainment only. Not for navigation.'

const QUALITY_LABEL: Record<Quality, string> = { adsb2: 'ADS-B v2', adsb01: 'ADS-B v0-1', mlat: 'MLAT', other: 'other' }

const DEGRADED_TEXT: Record<Exclude<Degraded, null>, string> = {
  blocked: 'Live data blocked by provider — showing nothing new',
  'rate-limited': 'Provider rate-limited us — updates slowed',
  'upstream-down': 'Live data unavailable',
}

const finite = (v: number | null): v is number => v !== null && Number.isFinite(v)
const int = (v: number): string => (Math.round(v) || 0).toLocaleString('en-US') // `|| 0` turns -0 into 0
const deg3 = (d: number): string => `${String((((Math.round(d) % 360) + 360) % 360)).padStart(3, '0')}°`

function vs(fpm: number): string {
  const v = Math.round(fpm / 10) * 10
  return `${v > 0 ? '+' : ''}${int(v)} fpm`
}

export function isStale(s: RenderState): boolean {
  return s.mode === 'stale' || s.ageS > STALE_AGE_S
}

/**
 * HUD rows for the selected aircraft, always GS ALT VS TRK HDG AGE SRC (none when nothing is selected).
 * Assumes Track copies gsKt, trackDeg and altBaroFt from its newest sample; vsFpm (filter), headingDeg
 * (true heading or track, smoothed) and ageS (render clock) are computed, so they are never 'observed'.
 */
export function hudFields(s: RenderState | null, status: StatusBrief): HudField[] {
  if (s === null) return []
  const stale = isStale(s)
  const row = (label: string, value: string | null, computed: boolean): HudField => ({
    label,
    value: value ?? '—',
    tag: value === null ? 'unknown' : stale ? 'stale' : computed || s.mode === 'extrap' ? 'derived' : 'observed',
  })
  // ALT is pressure altitude (what ATC and the pilot see). "alt est." = the drawn height is not GNSS but estimated from baro.
  const alt = s.onGround
    ? 'GND'
    : finite(s.altBaroFt)
      ? `${int(s.altBaroFt)} ft baro${s.altSource === 'geom' ? '' : ' · alt est.'}`
      : null
  return [
    row('GS', finite(s.gsKt) ? `${int(s.gsKt)} kt` : null, false),
    row('ALT', alt, false),
    row('VS', finite(s.vsFpm) ? vs(s.vsFpm) : null, true),
    row('TRK', finite(s.trackDeg) ? deg3(s.trackDeg) : null, false),
    row('HDG', finite(s.headingDeg) ? deg3(s.headingDeg) : null, true),
    // ageS < 0 while interpolating (render time is behind the newest sample): the drawn state is bracketed by real data.
    row('AGE', finite(s.ageS) ? `${Math.max(0, s.ageS).toFixed(1)} s` : null, true),
    row('SRC', `${QUALITY_LABEL[s.quality]}${status.source === 'replay' ? ' (replay)' : ''}`, false),
  ]
}

/** "UAL123 · B738 · a1b2c3", skipping the parts we do not know. */
export function hudTitle(s: RenderState): string {
  return [s.callsign, s.typeCode, s.hex].filter((x) => x).join(' · ')
}

/** One line for the top banner, or null when there is nothing to warn about. Provider problems win over the aircraft's state. */
export function bannerText(status: StatusBrief, s: RenderState | null): string | null {
  if (status.degraded !== null) return DEGRADED_TEXT[status.degraded]
  if (s === null) return null
  if (isStale(s)) return Number.isFinite(s.ageS) ? `Signal lost ${Math.round(Math.max(0, s.ageS))}s ago` : 'Signal lost'
  if (s.mode === 'extrap') return 'Predicting (no fresh data)'
  return null
}

/** The given credit lines plus the safety line, unless one of them already says "not for navigation". */
export function attributionLines(lines: string[]): string[] {
  return lines.some((l) => /not for navigation/i.test(l)) ? [...lines] : [...lines, NOT_FOR_NAVIGATION]
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test client/ui/format.test.ts`
Expected: PASS — `ℹ tests 14`, `ℹ pass 14`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add client/ui/format.ts client/ui/format.test.ts
git commit -m "feat(ui): honest HUD fields, status banner text and attribution lines"
```

---

### Task 2: DOM overlays, stylesheet and harness

**Files:**
- Create: `harness/hud.html`, `harness/hud.ts`, `client/ui/ui.css`, `client/ui/hud.ts`, `client/ui/banner.ts`
- Test: `npx tsc --noEmit` (the harness is the first consumer of the mounts) plus the harness page in a browser

**Interfaces:**
- Consumes: `hudFields`, `hudTitle`, `bannerText`, `attributionLines` (Task 1). `RenderState` and `StatusBrief` (WP-00).
- Produces:
  - `mountHud(root: HTMLElement): { update(s: RenderState | null, status: StatusBrief): void; destroy(): void }`
  - `mountBanner(root: HTMLElement): { update(status: StatusBrief, s: RenderState | null): void; destroy(): void }`
  - `mountAttribution(root: HTMLElement, lines: string[]): void`
  - CSS classes `fh-hud`, `fh-banner`, `fh-attribution`, and the tag classes `fh-observed`, `fh-derived`, `fh-stale`, `fh-unknown`
  - The overlays are `position: absolute`. Pass a full-screen root, such as `document.body` or the viewer's container.

- [ ] **Step 1: Write the harness first (it is the mounts' first consumer)**

```html
<!-- harness/hud.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Harness: HUD</title>
    <style>
      html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
      /* Stand-ins for imagery: the HUD must stay readable over the brightest and busiest of these. */
      body[data-bg='snow'] { background: linear-gradient(160deg, #fff 0%, #e9eef3 40%, #cfd8e0 70%, #fff 100%); }
      body[data-bg='sea'] { background: linear-gradient(180deg, #0b2a4a, #184e77 60%, #1e6091); }
      body[data-bg='terrain'] { background: repeating-linear-gradient(35deg, #6b8f3e 0 40px, #a88b5b 40px 90px, #d8d2b8 90px 120px, #3f5f2a 120px 170px); }
      body[data-bg='stripes'] { background: repeating-linear-gradient(90deg, #000 0 6px, #fff 6px 12px); }
      #controls { position: absolute; top: 72px; left: 8px; z-index: 20; display: flex; flex-wrap: wrap; gap: 4px;
        max-width: calc(100% - 32px); font: 12px system-ui, sans-serif; }
      #controls button { font: inherit; padding: 3px 8px; }
      #controls button[aria-pressed='true'] { outline: 2px solid #1e88e5; }
    </style>
  </head>
  <body data-bg="snow">
    <div id="controls"></div>
    <script type="module" src="./hud.ts"></script>
  </body>
</html>
```

```ts
// harness/hud.ts
// WP-V6 harness: /harness/hud.html shows the HUD, banner and attribution for fixed scenarios over imagery-like
// backgrounds. "play" runs the per-frame path: age −2 → 16 s, interp → extrap (0 s) → stale (8 s), every animation frame.
import type { StatusBrief } from '../shared/api.ts'
import type { RenderState } from '../client/types.ts'
import { mountAttribution, mountBanner } from '../client/ui/banner.ts'
import { mountHud } from '../client/ui/hud.ts'

const base: RenderState = {
  hex: 'a1b2c3', lat: 37.6, lon: -122.3, hM: 640, headingDeg: 284.4, pitchDeg: -2, rollDeg: 0, gsKt: 146.2, trackDeg: 281.7,
  altBaroFt: 2175, vsFpm: -742, mode: 'interp', altSource: 'geom', onGround: false, ageS: -1.3, quality: 'adsb2',
  callsign: 'UAL123', typeCode: 'B738',
}
const live: StatusBrief = { source: 'adsblol', degraded: null, cellPeriodP95S: 2.1, chasePeriodP95S: 1.1 }

const scenarios: Record<string, [RenderState | null, StatusBrief]> = {
  interp: [base, live],
  'baro height': [{ ...base, altSource: 'baro-qnh' }, live],
  extrap: [{ ...base, mode: 'extrap', ageS: 3.4 }, live],
  stale: [{ ...base, mode: 'stale', ageS: 14.2 }, live],
  'on ground': [{ ...base, onGround: true, altBaroFt: null, gsKt: 12, vsFpm: 0 }, live],
  'MLAT + nulls': [{ ...base, quality: 'mlat', gsKt: null, trackDeg: null, vsFpm: null, callsign: null }, live],
  replay: [base, { ...live, source: 'replay' }],
  blocked: [base, { ...live, degraded: 'blocked' }],
  'rate-limited': [base, { ...live, degraded: 'rate-limited' }],
  'upstream-down': [base, { ...live, degraded: 'upstream-down' }],
  'no selection': [null, live],
}

const hud = mountHud(document.body)
const banner = mountBanner(document.body)
mountAttribution(document.body, ['Aircraft data © adsb.lol contributors (ODbL)', 'Airports: OurAirports (public domain)'])

let raf = 0
function show([s, status]: [RenderState | null, StatusBrief]): void {
  hud.update(s, status)
  banner.update(status, s)
}
function play(t0: number): void {
  const frame = (now: number): void => {
    const ageS = (((now - t0) / 1000) % 18) - 2
    show([{ ...base, ageS, mode: ageS <= 0 ? 'interp' : ageS <= 8 ? 'extrap' : 'stale' }, live])
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
}

const controls = document.getElementById('controls')!
function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = label
  b.onclick = () => {
    for (const x of controls.querySelectorAll('button')) if (x.dataset.group === b.dataset.group) x.setAttribute('aria-pressed', 'false')
    b.setAttribute('aria-pressed', 'true')
    onClick()
  }
  controls.append(b)
  return b
}
for (const [name, sc] of Object.entries(scenarios)) button(name, () => (cancelAnimationFrame(raf), show(sc))).dataset.group = 'scenario'
button('play', () => (cancelAnimationFrame(raf), play(performance.now()))).dataset.group = 'scenario'
for (const bg of ['snow', 'sea', 'terrain', 'stripes']) button(`bg: ${bg}`, () => (document.body.dataset.bg = bg)).dataset.group = 'bg'
show(scenarios.interp)
;(window as unknown as { harness: object }).harness = { hud, banner, scenarios, show }
```

- [ ] **Step 2: Type-check to verify it fails**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/ui|harness/hud'`
Expected: FAIL —
```
harness/hud.ts(6,47): error TS2307: Cannot find module '../client/ui/banner.ts' or its corresponding type declarations.
harness/hud.ts(7,26): error TS2307: Cannot find module '../client/ui/hud.ts' or its corresponding type declarations.
```

- [ ] **Step 3: Write the stylesheet and the two mounts**

```css
/* client/ui/ui.css */
/* HUD bottom-left, banner top-centre, attribution bottom-right. Dark translucent panels plus a text shadow keep the
   text readable over snow, cloud, sea and busy terrain imagery. Overlays never take pointer events, so globe drag and
   aircraft picking work through them. */
.fh-hud,
.fh-banner,
.fh-attribution {
  position: absolute;
  z-index: 10;
  box-sizing: border-box;
  pointer-events: none;
  border-radius: 4px;
  background: rgba(8, 12, 18, 0.72);
  color: #f2f5f8;
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  text-shadow: 0 1px 2px #000;
}

/* An author display value would beat the hidden attribute's UA style; say it again. */
.fh-hud[hidden],
.fh-banner[hidden] {
  display: none;
}

/* 40px up clears Cesium's own credit bar, which sits on the bottom-left edge. */
.fh-hud {
  left: 8px;
  bottom: 40px;
  min-width: 24ch;
  padding: 6px 10px;
}

.fh-hud-title {
  margin-bottom: 2px;
  font-weight: 700;
  white-space: nowrap;
}

.fh-hud-row {
  white-space: nowrap;
}

.fh-hud-label {
  display: inline-block;
  width: 5ch;
  color: #9aa6b2;
}

/* Honesty tags. Derived is also italic so it does not rely on colour alone. */
.fh-observed {
  color: #f2f5f8;
}

.fh-derived {
  color: #7cc8ff;
  font-style: italic;
}

.fh-stale {
  color: #ffb347;
}

.fh-unknown {
  color: #7d8793;
}

.fh-hud-legend {
  display: flex;
  gap: 1.5ch;
  margin-top: 4px;
  font-size: 10px;
}

/* left/right + fit-content + auto margins centre it; left: 50% with a transform would wrap it at half the width. */
.fh-banner {
  top: 8px;
  left: 16px;
  right: 16px;
  width: fit-content;
  margin: 0 auto;
  padding: 6px 14px;
  background: rgba(110, 55, 0, 0.88);
  font-size: 13px;
  text-align: center;
}

.fh-attribution {
  right: 8px;
  bottom: 8px;
  max-width: min(44ch, 45vw);
  padding: 4px 8px;
  color: #c9d1d9;
  font-size: 10px;
  text-align: right;
}
```

```ts
// client/ui/hud.ts
// Bottom-left readout for the chased aircraft. The text and honesty tags come from format.ts; this file only builds DOM.
import type { StatusBrief } from '../../shared/api.ts'
import type { RenderState } from '../types.ts'
import { hudFields, hudTitle } from './format.ts'
import './ui.css'

const div = (className: string, text = ''): HTMLDivElement => {
  const el = document.createElement('div')
  el.className = className
  el.textContent = text
  return el
}

const span = (className: string, text: string): HTMLSpanElement => {
  const el = document.createElement('span')
  el.className = className
  el.textContent = text
  return el
}

export function mountHud(root: HTMLElement): { update(s: RenderState | null, status: StatusBrief): void; destroy(): void } {
  const el = div('fh-hud')
  el.hidden = true
  root.append(el)
  const legend = div('fh-hud-legend')
  legend.append(span('fh-observed', 'observed'), span('fh-derived', 'derived'), span('fh-stale', 'stale'))
  let last = ''

  return {
    update(s, status) {
      const title = s === null ? '' : hudTitle(s)
      const fields = hudFields(s, status)
      const key = title + JSON.stringify(fields)
      if (key === last) return // called every frame: touch the DOM only when the text changes
      last = key
      el.hidden = s === null
      // textContent only: callsigns come from upstream data and must never be parsed as HTML.
      const rows = fields.map((f) => {
        const r = div('fh-hud-row')
        r.append(span('fh-hud-label', f.label), span(`fh-hud-value fh-${f.tag}`, f.value))
        return r
      })
      el.replaceChildren(div('fh-hud-title', title), ...rows, legend)
    },
    destroy() {
      el.remove()
    },
  }
}
```

```ts
// client/ui/banner.ts
// Top-centre status banner (provider trouble, lost signal, prediction) and the bottom-right attribution box.
import type { StatusBrief } from '../../shared/api.ts'
import type { RenderState } from '../types.ts'
import { attributionLines, bannerText } from './format.ts'
import './ui.css'

export function mountBanner(root: HTMLElement): { update(status: StatusBrief, s: RenderState | null): void; destroy(): void } {
  const el = document.createElement('div')
  el.className = 'fh-banner'
  el.setAttribute('role', 'status')
  el.hidden = true
  root.append(el)

  return {
    update(status, s) {
      const text = bannerText(status, s)
      el.hidden = text === null
      if (text !== null && el.textContent !== text) el.textContent = text
    },
    destroy() {
      el.remove()
    },
  }
}

/** Credit lines, bottom right. Always carries the "Not for navigation" line (added when the caller's lines lack it). */
export function mountAttribution(root: HTMLElement, lines: string[]): void {
  const el = document.createElement('div')
  el.className = 'fh-attribution'
  for (const line of attributionLines(lines)) {
    const row = document.createElement('div')
    row.textContent = line
    el.append(row)
  }
  root.append(el)
}
```

- [ ] **Step 4: Type-check to verify it passes**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/ui|harness/hud'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 5: Eyeball the harness**

Run: `npm run dev -- --port 5306 --strictPort`, then open `http://localhost:5306/harness/hud.html`.
Expected:
- **interp:** the bottom-left HUD reads `UAL123 · B738 · a1b2c3`, then `GS 146 kt`, `ALT 2,175 ft baro`, `VS -740 fpm` (blue italic), `TRK 282°`, `HDG 284°` (blue italic), `AGE 0.0 s` (blue italic) and `SRC ADS-B v2`. A legend reads `observed derived stale`. There is no banner.
- **The bottom-right box** has two credit lines plus `Entertainment only. Not for navigation.`
- **stale:** all values turn amber, and the banner reads `Signal lost 14s ago`.
- **blocked:** the top-centre banner shows `Live data blocked by provider — showing nothing new` on one line. The HUD is unchanged.
- **no selection:** the HUD and banner disappear.
- **play:** AGE counts up every frame. The banner changes to `Predicting (no fresh data)` after 0 s and to `Signal lost …` after 8 s.
- **Backgrounds:** every `bg:` button leaves all text readable, including `stripes`.
- The console shows no errors.

Stop the server.

- [ ] **Step 6: Commit**

```bash
git add client/ui/ui.css client/ui/hud.ts client/ui/banner.ts harness/hud.html harness/hud.ts
git commit -m "feat(ui): HUD, status banner and attribution overlays with harness page"
```

---

### Task 3: WP gate

- [ ] **Step 1: This package's tests**

Run: `node --test client/ui/format.test.ts`
Expected: `ℹ tests 14`, `ℹ pass 14`, `ℹ fail 0`.

- [ ] **Step 2: Type-check this package's files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'client/ui|harness/hud'`
Expected: no output. grep exits 1 because nothing matched.

- [ ] **Step 3: Full check in the worktree**

Run: `npm run check`
Expected: `tsc` prints nothing. On a worktree branched from `wave-0`, the counts are `ℹ tests 55`, `ℹ pass 55`, `ℹ fail 0` (41 from WP-00 plus 14 here).

- [ ] **Step 4: Confirm there is nothing left to commit**

Run: `git status --short`
Expected: no output.

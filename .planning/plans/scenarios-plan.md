<!-- .planning/plans/scenarios-plan.md -->
# Scenarios (JAL 123 first) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Scenarios menu that plays a recorded flight in chase mode, with a scrubbable timeline, captions, optional
audio, a flight-data frame around the chased aircraft (also in live chase), and the first scenario: JAL 123, 1985.

**Architecture:** Static scenario packages in `public/scenarios/<id>/` are loaded, validated and played by pure client
modules (`client/scenario/`). A `ScenarioRun` replaces the live pipeline inside `app.ts`'s frame loop while it runs,
reusing the chase camera, per-type model, livery shader, terrain and sun. The JAL 123 track is rebuilt from the official
DFDR charts by Python tools in `tools/scenarios/jal123/`.

**Tech Stack:** TypeScript (Node ≥ 24.2 strips types; `node --test`), CesiumJS 1.145, Vite 8; Python 3.9 + OpenCV +
numpy + Pillow + poppler (`pdftoppm`) for the data tools.

**Spec:** `.planning/scenarios-design.md` (read it first). Contract types: `client/scenario/types.ts`, `FlightData` in
`client/types.ts` (Task 0, done).

## Global Constraints

- Worktree `../FlightHopper-scenarios`, branch `feat/scenarios`. Never touch the main
  checkout `../FlightHopper` (other sessions use it), except reading `.work/`.
- Source PDFs are in `../FlightHopper/.work/jal123/sources/` (git-ignored). Do NOT
  download the report appendix (付録, 62-2-JA8119-huroku.pdf): the user declined it. Other downloads need the user's OK.
- Tests: `node --test <file>` for one file; `npm run check` = typecheck + all tests. Baseline 803/803.
- Imports use explicit `.ts` extensions; Cesium named imports only (no `import * as Cesium`: it bloats the bundle).
- Every new module starts with `// <path>` and a short comment saying what it is, like the existing files.
- UI: `textContent` only for data (never innerHTML); 44 px touch targets on coarse pointers; the app's tokens
  (`client/ui/theme.css`: `--fh-glass`, `--fh-hairline`, `--fh-text`, `--fh-muted`, `--fh-accent`, `--fh-radius`,
  `--fh-fast`); `.fh-glass` without backdrop blur on large surfaces; `prefers-reduced-motion` respected.
- No disclaimers or credit boxes on the map; credits go to the About panel only.
- Sensitivity (spec §7): nothing depicts the impact; the veil is fully dark by 18:56:22; captions only from the
  official record; `[unintelligible]` where the record says so.
- Agents do not commit. The coordinator commits each task's files with explicit paths.
- `ponytail:` comments mark deliberate simplifications and name their ceiling.

---

## Wave 1 (parallel; each task owns only its files)

### Task 1: CSV parser and scenario loader

**Files:**
- Create: `client/scenario/csv.ts`, `client/scenario/csv.test.ts`
- Create: `client/scenario/format.ts`, `client/scenario/format.test.ts`

**Interfaces:**
- Consumes: `client/scenario/types.ts`.
- Produces:
  - `parseCsv(text: string): string[][]` (RFC 4180; `\r\n` or `\n`; a trailing newline adds no row; BOM stripped).
  - `clockToS(clock: string): number` (`'18:24:35.7'` → 66275.7; hours may exceed 23; throws on bad input).
  - `sToClock(t: number, decimals = 0): string` (66275 → `'18:24:35'`; hours ≥ 24 kept as such).
  - `offsetMs(utcOffset: string): number` (`'+09:00'` → 32_400_000).
  - `class ScenarioError extends Error { readonly problems: string[] }`.
  - `parseScenario(files: { base: string; manifest: unknown; track: string; events: string | null; transcript: string | null; present: Scenario['present'] }): Scenario` (pure; throws ScenarioError listing all problems).
  - `parseCard(manifest: unknown): ScenarioCard` (manifest only; for the panel).
  - `loadScenario(base: string, id: string, fetcher: typeof fetch = fetch): Promise<Scenario>`: fetches
    `${base}scenarios/${id}/scenario.json`, `track.csv`, `events.csv` (404 → null), `transcript.csv` (404 → null);
    probes optional files with `HEAD` (`livery.body`, `livery.finLogo`, `audio.file`) into `present`.
  - `listScenarios(base: string, fetcher = fetch): Promise<ScenarioCard[]>` (index.json → each scenario.json).

**Validation (spec §3.6)** — collect every problem as `"<file>:<row>: <column>: <message>"`, then throw once:
- manifest: `format === 1`; required strings (`id title subtitle date utcOffset clockLabel start end note`);
  `date` `YYYY-MM-DD`; `utcOffset` `±HH:MM`; `start < end`; `aircraft.model` non-empty; every `speakers[k].kind` in
  SpeakerKind; every `sources[].id` unique; `imagery[].rect` west<east, south<north; `ending.fadeFrom ≤ darkAt`;
  `audio.source` non-empty and every clip `from < to`.
- track.csv: required columns `time lat lon alt_ft hdg pitch roll`; allowed optional `gnd ias_kt gs_kt vs_fpm g wind_dir
  wind_kt epr1 epr2 epr3 epr4 q src`; any `x_*` ignored; any other column is an error. `time` strictly increasing;
  lat ∈ [−90, 90]; lon ∈ [−180, 180]; hdg ∈ [0, 360); pitch ∈ [−90, 90]; roll ∈ [−180, 180]; `q` ∈ A M R;
  `src` id (before `:`) in sources. At least 2 rows; first row ≤ start; last row ≥ end.
- events.csv: columns `time type value label src`; type ∈ EventType; gear value `0|1`; flaps value a number; damage
  value non-empty; times non-decreasing.
- transcript.csv: columns `time dur speaker to channel lang text original q src`; speaker (and `to` when non-empty) in
  speakers; channel ∈ Channel; q ∈ D T U; `q=U` ⇒ text `[unintelligible]`; times non-decreasing;
  empty `dur` ⇒ `clamp(1.2 + 0.06 · text.length, 2.5, 8)`.

- [ ] **Step 1: Write failing tests** in `csv.test.ts`: quoted comma, quoted `""`, newline inside quotes, CRLF, BOM,
  trailing newline, empty cells.
- [ ] **Step 2: Implement `parseCsv`** (a single pass state machine, ~40 lines). Run `node --test client/scenario/csv.test.ts` → PASS.
- [ ] **Step 3: Write failing tests** in `format.test.ts` with a tiny inline package (3 track rows, 2 events, 2 lines):
  parses; `t0UtcMs` for `1985-08-12 +09:00` equals `Date.UTC(1985, 7, 11, 15, 0, 0)`; `clockToS('24:05:00') === 86700`;
  one test per error class above asserting the message names file, row and column; several errors are reported together.
- [ ] **Step 4: Implement `format.ts`**. Run `node --test client/scenario/format.test.ts` → PASS.
- [ ] **Step 5: Add a test that validates every real package**: read `public/scenarios/index.json` from disk (skip with
  `t.skip` when absent), and for each id read its files from disk and call `parseScenario` → no throw.
- [ ] **Step 6:** `npx tsc --noEmit -p .` shows no errors in these files.

### Task 2: Scenario clock and timeline helpers

**Files:**
- Create: `client/scenario/clock.ts`, `client/scenario/clock.test.ts`
- Create: `client/scenario/timeline.ts`, `client/scenario/timeline.test.ts`

**Interfaces:**
- Produces:
```ts
export const RATES = [1, 2, 4, 8, 16] as const
export class ScenarioClock {
  constructor(start: number, stop: number, t = start) // stop = max(end, ending.darkAt + ending.cardAfterS)
  t: number; playing: boolean; rate: number
  tick(dtS: number): void            // t += dtS·rate while playing; at stop: t = stop, playing = false
  seek(t: number): void              // clamped to [start, stop]; keeps playing state
  play(): void                       // at stop: seeks to start first
  pause(): void
  setRate(r: number): void           // must be in RATES
  nextRate(): number                 // cycles RATES, returns the new rate
}
export interface EventState { phase: string | null; gear: boolean; flaps: number | null; damage: ReadonlySet<string> }
export function eventStateAt(events: readonly EventRow[], t: number): EventState   // last value at or before t
export function marks(events: readonly EventRow[]): { t: number; label: string }[] // type 'mark'
export function captionsAt(lines: readonly Line[], t: number, max = 3): Line[]     // l.t ≤ t < l.t + l.dur; newest max, oldest first
export function endingAt(e: EndingSpec | null, t: number): { fade: number; card: boolean }
// fade: 0 before fadeFrom, smoothstep over [fadeFrom, darkAt], 1 from darkAt; card: t ≥ darkAt + cardAfterS
```
- [ ] **Step 1: Failing tests** (`clock.test.ts`): tick advances by dt·rate; clamps and stops at stop; play at stop
  restarts; seek clamps and keeps playing; setRate rejects 3; nextRate cycles 1→2→4→8→16→1.
- [ ] **Step 2: Implement `clock.ts`** → PASS.
- [ ] **Step 3: Failing tests** (`timeline.test.ts`): gear toggles by value; damage accumulates part ids; phase is the
  last label; captionsAt returns overlapping lines oldest first, at most 3, none after their dur; endingAt 0 / 0.5 /
  1 / card at the right times; null ending → `{fade: 0, card: false}`.
- [ ] **Step 4: Implement `timeline.ts`** → PASS.

### Task 3: Pose track (interpolation)

**Files:**
- Create: `client/scenario/pose.ts`, `client/scenario/pose.test.ts`

**Interfaces:**
- Consumes: `TrackRow` (types.ts), `RenderState`, `FlightData` (client/types.ts), `geoidN` (shared/geoid.ts).
- Produces:
```ts
export class PoseTrack {
  constructor(rows: readonly TrackRow[], opts?: { geoid?: (lat: number, lon: number) => number; hex?: string; callsign?: string | null; typeCode?: string | null })
  readonly start: number   // first row t
  readonly end: number     // last row t
  stateAt(t: number): RenderState   // clamped to [start, end]
  dataAt(t: number): Omit<FlightData, 'aglFt' | 'gear' | 'flaps'>  // derived set marks estimates
}
```
- Interpolation: centripetal Catmull-Rom over rows i−1, i, i+1, i+2 (ends: duplicate the end row) for `lat`, `lon`,
  `altFt`, **unwrapped** `hdg` (unwrap the whole column once in the constructor), `pitch`, `roll`, and linear for the
  optional scalars (`iasKt`, `g`, `windKt`, `epr[k]`; wind direction via its unit vector). Exactly the row values at row
  times. Row lookup: binary search, cached last index (frames move forward).
- `RenderState`: `hex` (default `'scn000'`), `hM = altFt·0.3048 + geoid(lat, lon)` (default `geoidN`; the geoid is read
  at most every 0.5 km of travel: cache last value and position), `headingDeg` wrapped to [0, 360),
  `gsKt`/`trackDeg` from the row value when present, else from the path derivative over ±0.5 s (great-circle bearing and
  distance), `vsFpm` likewise, `altBaroFt = altFt`, `mode: 'interp'`, `ageS: 0`, `quality: 'adsb2'`,
  `altSource: 'baro'`, `onGround: gnd of the row at or before t`.
- `dataAt`: the same numbers; `derived` holds `gsKt`/`trackDeg`/`vsFpm` when derived from the path, and `windFromDeg`,
  `windKt` when the surrounding rows are `q=R`.
- [ ] **Step 1: Failing tests:** exact at row times; continuity (no jump > 1e-6° between t and t+1e-3 anywhere);
  heading across 359→1 goes through 0 not 180; a 1-Hz sinusoidal roll of 11 s period and ±40° amplitude keeps ≥ 90 %
  of its amplitude at mid-row times; clamps before start / after end; gsKt derived for a 1-Hz straight track at 300 kt
  within 0.5 kt; onGround follows `gnd`; hM uses the injected geoid.
- [ ] **Step 2: Implement** → PASS. Keep per-call allocation to one RenderState object (reuse a scratch object; the
  app copies it with a spread).

### Task 4: Livery, shape, damage and gear on the chase model

**Files:**
- Modify: `client/scene/livery.ts`, `client/scene/livery.test.ts`
- Modify: `client/scene/model.ts`, `client/scene/model.test.ts`
- Modify: `client/types.ts` (only `Paint` and `ModelManifestEntry`; `FlightData` is done)
- Modify: `public/models/manifest.json` (b744 entry only)
- Create: `tools/models/gear-glb.ts` (Node script, no deps: writes a glTF 2.0 GLB), `public/models/b744-gear.glb`
- Test: the existing test files above, plus `tools/models/gear-glb.test.ts`

**Interfaces:**
- `Paint` gains optional: `body?: [zNose: number, zTail: number, yBottom: number, yTop: number]` (turned frame, as the
  other fields), `wingTipY?: number` (raw-frame y of the wing plane at the tip), `cut?: { finKeepY: number; rudderFrac: number; tailConeZ: number }`
  (turned frame: fin kept below `finKeepY` except the rudder chord fraction; everything aft of `tailConeZ` removed).
- `ModelManifestEntry` gains optional `gear?: { uri: string; heightM: number }` (heightM: origin → wheel bottom with the
  gear down).
- `Livery` gains `bodyUrl: string | null; finUrl: string | null; titleUrl: string | null`. Table liveries set finUrl
  and titleUrl from the code as today and bodyUrl null. New `liveryFromSpec(key: string, spec: LiverySpec, base: string, present: {body: boolean; finLogo: boolean}): Livery`.
- `LiveryShaders.custom(livery: Livery): CustomShader` (cached by `livery.code`).
- Every shader declares `u_body` (SAMPLER_2D, blank default), `u_span` (FLOAT, 0), `u_cut` (FLOAT, 0).
  Vertex shader: `if (u_span > 0.0 && abs(p.x) > u_span) { p.x = sign(p.x)·u_span; p.y = min(p.y, WING_TIP_Y); }`
  written back to `vsOutput.positionMC` (raw frame; only when the paint has `wingTipY`).
  Fragment: body wrap (spec §6.2): `u = (zNose − p.z)/(zNose − zTail)`, rows: top half of the texture = the left side
  (turned +x), bottom half = the right side; applied where `body && abs(n.x) > 0.2` and inside the box, mixed by alpha
  over base/belly. Damage when `u_cut > 0.5`: discard fin fragments above a jagged line at `finKeepY` (amplitude 0.35 m)
  and in the aft `rudderFrac` of the local fin chord, and every fragment with `p.z < tailConeZ` within the fuselage;
  back faces (`czm_backFacing()`) of the cut drawn `vec3(0.04)`.
- `ChaseModel`: `setShape(halfSpanM: number | null)`, `setDamage(on: boolean)`, `setGear(on: boolean)` (loads
  `entry.gear.uri` once as a plain Model; each `update()` copies the chase modelMatrix to it; while the gear shows,
  placement uses `gear.heightM` instead of `gearHeightM`), `paintLivery(livery: Livery)` (custom livery), `get entry()`.
  `setShape`/`setDamage` write uniforms on the current shader (`CustomShader.setUniform`) and are re-applied after
  `use()` or `paint*()` switch shaders. The chase model's `backFaceCulling` is false only while damage is on.
- b744 manifest: measure `body`, `wingTipY`, `cut` from `public/models/b744.glb` (see
  `.planning/reports/scenarios/model.md` for measured numbers: fin LE z 18.8→31.1, TE 32.3→35.4 raw, crown y −1.45,
  tail cone ends z 33.0, winglet from x 32.0, wing plane y ≈ −4.3 at the tip; fin kept ≈ one third of its height:
  the dorsal fillet and lower leading edge), `gear: { uri: "models/b744-gear.glb", heightM: <belly −8.6 − 3.0 = 11.6> }`.
- Gear GLB: nose gear at raw z ≈ −28 (≈ 25.6 m ahead of the mains), mains at z ≈ −2…+3, x = ±1.9 (body) and ±5.5
  (wing); struts + 2×2 wheel bogies (4 wheels each main, 2 on the nose); grey; ≤ 600 triangles; wheel bottoms at
  y = −11.6; POSITION + NORMAL only.
- [ ] **Step 1: Failing tests:** shader text contains `u_body`, `u_span`, `u_cut` and the damage branch only when the
  paint has `cut`; defaults off; `liveryFromSpec` URLs resolve against base and are null when absent;
  `custom()` caches by key; the b744 entry's `body`/`cut`/`gear` exist and lie inside the GLB's bounding box
  (`measureGlb`); gear GLB parses with `measureGlb`, its lowest vertex is at −11.6 ± 0.05 (raw y).
- [ ] **Step 2: Implement.** → `node --test client/scene/livery.test.ts client/scene/model.test.ts tools/models/gear-glb.test.ts` PASS.
- [ ] **Step 3:** Render check in the Browser pane with the `harness/model.html` page (or a new `harness/scenario-model.html`
  showing b744 with a test body texture, span fold, damage on, gear on). Screenshots in `.planning/reports/scenarios/shots/`.

### Task 5: Flight-data frame

**Files:**
- Create: `client/scene/flightFrame.ts`, `client/scene/flightFrame.test.ts`, `client/ui/flightFrame.css`
- Create: `harness/flight-frame.html`, `harness/flight-frame.ts` (DOM-only page: a fake square you can drag/resize, with
  sample data, to judge the look at every size and viewport)

**Interfaces:**
- Consumes: `FlightData` (client/types.ts), `squarePx`, `MIN_PX` (traffic.ts), `ModelManifestEntry.box`, `ReadsbAircraft`.
- Produces:
```ts
export interface Rect { x: number; y: number; w: number; h: number }
export interface Square { x: number; y: number; side: number } // centre and side, CSS px from the canvas top-left
export type BlockId = 'left' | 'right' | 'top' | 'bottom'
export function frameLayout(sq: Square, sizes: Record<BlockId, { w: number; h: number }>, safe: Rect, gap = 10): Record<BlockId, { x: number; y: number }>
export function liveFlightData(s: RenderState, raw: ReadsbAircraft | null, aglFt: number | null): FlightData
export function formatBlocks(d: FlightData): Record<BlockId, BlockView> // the strings and glyph angles each block shows
export class FlightFrame {
  constructor(layer: HTMLElement)   // layer: a .fh-frame div (app creates it)
  update(viewer: Viewer, modelMatrix: Matrix4, entry: ModelManifestEntry, data: FlightData | null, safe: Rect): void // null: hidden
  destroy(): void
}
```
- Layout rules (spec §5): hug the square with `gap`; left/right blocks vertically centred on the square, top/bottom
  horizontally centred; clamp each inside `safe`; if the square is larger than `safe` in a dimension, the blocks pin
  to the matching safe edge; blocks never overlap each other (resolve by pushing top/bottom outward vertically).
- Blocks: left = ALT (large) + `AGL n ft` + VS arrow `↑ 1,500 fpm`; right = `IAS n kt`, `GS n kt`, EPR bars (one per
  engine, 1.0–2.0 scale, labelled 1–4); top = `HDG 250°` + wind dial (18 px circle, nose up, arrow from the wind's
  relative bearing `windFrom − hdg`) + `220°/16 kt`; bottom = a 28 px horizon glyph (rotated by −roll, horizon line
  offset by pitch·0.6 px/°) + `Bank 38° R · Pitch +9°` + `1.8 g` + chips `GEAR DN`, `FLAPS 10`. A block with nothing to
  show is hidden. Estimated fields at 60 % opacity.
- DOM: brackets exactly as `.fh-bracket` (reuse the class); blocks are `div.fh-fblock` with a light glass chip
  (`rgb(13 17 25 / .55)`, 1 px hairline, 8 px radius, no blur), 11–12 px tabular numbers, large ALT 15 px. Position via
  `transform: translate3d()` every frame; text re-rendered at most every 100 ms; block sizes measured after a text
  change (`offsetWidth/offsetHeight`) and cached.
- Square: projected from `entry.box` (centre, half) × `entry.scale` through `modelMatrix` exactly as `traffic.ts`
  `update()` does (`SceneTransforms.worldToWindowCoordinates`, depth along the view, `squarePx`). Behind the camera → hidden.
- `liveFlightData`: altFt = s.altBaroFt, vsFpm = s.vsFpm, gsKt = s.gsKt, trackDeg = s.trackDeg, iasKt = raw.ias,
  hdgDeg = raw.true_heading, rollDeg = raw.roll (only when present), windFromDeg/windKt = raw.wd/ws, pitch/g/gear/flaps/epr null.
- [ ] **Step 1: Failing tests** for `frameLayout`: small square in the middle → blocks hug it at `gap`; square near
  each edge → blocks clamped inside safe; square larger than safe → blocks pinned at the safe edges; no two blocks
  overlap in any of 200 random cases (seeded LCG); for `liveFlightData`: fields map as above, missing raw → nulls;
  for `formatBlocks`: thousands separators, signs, `R`/`L` bank, wind arrow angle = windFrom − hdg.
- [ ] **Step 2: Implement** → PASS.
- [ ] **Step 3:** Harness page; screenshots at square sizes 24, 120, 400, 1400 px and at 375×812, in
  `.planning/reports/scenarios/shots/`.

### Task 6: Scenario UI (panel, play bar, captions, ending)

**Files:**
- Create: `client/ui/scenarioPanel.ts`, `client/ui/scenarioPanel.css`, `client/ui/scenarioPanel.test.ts`
- Create: `client/ui/playbar.ts`, `client/ui/playbar.css`, `client/ui/playbar.test.ts`
- Create: `client/ui/captions.ts`, `client/ui/captions.css`, `client/ui/captions.test.ts`
- Create: `client/ui/ending.ts`, `client/ui/ending.css`, `client/ui/ending.test.ts`
- Modify: `client/ui/icons.ts` (add `film`, `play`, `pause`)
- Create: `harness/scenario-ui.html`, `harness/scenario-ui.ts` (all four mounted over a still background with fake data)

**Interfaces:**
```ts
// scenarioPanel.ts
export function mountScenarioPanel(body: HTMLElement, opts: { list(): Promise<ScenarioCard[]>; onPlay(id: string): void }): { refresh(): void; setPlaying(id: string | null): void; destroy(): void }
// playbar.ts
export interface PlaybarView { t: number; playing: boolean; rate: number; clock: string; phase: string | null }
export function mountPlaybar(root: HTMLElement, opts: { start: number; stop: number; end: number; marks: { t: number; label: string }[]; clockLabel: string; title: string;
  onToggle(): void; onSeek(t: number): void; onRate(): void; onExit(): void }): { update(v: PlaybarView): void; destroy(): void }
// captions.ts
export interface CaptionView { key: string; who: string; to: string | null; channel: Channel; translated: boolean; unintelligible: boolean; text: string; original: string | null }
export function mountCaptions(root: HTMLElement): { update(lines: readonly CaptionView[]): void; destroy(): void }
// ending.ts
export function mountEnding(root: HTMLElement, opts: { onClose(): void }): { update(fade: number, card: { title: string; lines: string[] } | null): void; destroy(): void }
```
- Panel: a card per scenario: title, subtitle, date, `registration · type`, summary lines, a collapsed "Crew" details
  list, the `note` in muted text, a Play button (`.fh-pill`). Loading skeleton (`.fh-skel`) while `list()` runs; an
  error line if it fails. When playing, the card's button reads "Playing" (disabled).
- Play bar (`.fh-playbar`, z 17, `.fh-glass`, full width between the left gutter and the rail; on phones directly above
  the tab bar): play/pause (`aria-label` Play/Pause), the clock `18:24:35 JST`, the phase label, a scrubber
  (`<input type="range" step="0.1">` from start to end, marks as ticks under it with `title`/`aria-label`
  = label + clock, a tick press seeks to it), speed button (`1×`…`16×`), exit (×, `aria-label` "Exit scenario").
  Dragging calls onSeek continuously (input event). 44 px targets on coarse pointers. Keyboard focus visible.
- Captions (`.fh-captions`, z 16, `pointer-events: none`, `aria-live="polite"`, centred above the play bar, max
  640 px): each line = a head row `Captain → First Officer` (+ ` · radio` for channel radio/company, `· cabin` for
  cabin, a small `JA→EN` mark when translated) and the text; `original` in smaller muted text under it when present;
  unintelligible lines italic muted. Channel tints: cockpit neutral, radio/company accent blue, cabin muted,
  alert amber. Lines enter with a 150 ms fade; keyed by `key` so a line is not re-created every frame.
- Ending (`.fh-ending`, z 30): a full-screen black veil with opacity = fade (pointer-events only when ≥ 0.99);
  the card (centred, `.fh-glass`, max 520 px) fades in when given; its lines as paragraphs; one button "Close"
  (onClose). No other controls.
- [ ] **Step 1: Failing tests** with the fake-DOM pattern of `client/ui/sceneToggles.test.ts`: panel renders a card per
  scenario and calls onPlay(id); playbar maps a scrubber input to onSeek(t) and renders clock/phase/rate; tick press
  seeks; captions keep existing elements for unchanged keys and remove gone ones, and use textContent only; ending sets
  veil opacity and shows the card only when given.
- [ ] **Step 2: Implement** → PASS. Step 3: harness page screenshots desktop 1280×800 and phone 375×812.

### Task 7: Static files: audio types and HTTP Range

**Files:** Modify `server/main.ts`; Test `server/main.test.ts` (add cases)
- `TYPES` gains `.csv: text/csv; charset=utf-8`, `.m4a: audio/mp4`, `.mp3: audio/mpeg`, `.ogg: audio/ogg`,
  `.opus: audio/ogg`, `.wav: audio/wav`, `.vtt: text/vtt; charset=utf-8`.
- `serveStatic` answers `Range: bytes=a-b` / `a-` / `-n` with 206, `content-range`, the slice, `accept-ranges: bytes`
  on every file; unsatisfiable → 416 with `content-range: bytes */size`; multiple ranges → whole file 200.
- [ ] Failing tests (a temp dir with a 1000-byte file): 206 slices for the three forms, 416, 200 with accept-ranges,
  MIME types. Implement → PASS.

### Task 8: Audio sync

**Files:** Create `client/scenario/audio.ts`, `client/scenario/audio.test.ts`
```ts
export interface MediaLike { currentTime: number; volume: number; paused: boolean; play(): Promise<void> | void; pause(): void }
export class AudioSync {
  constructor(el: MediaLike, clips: readonly AudioClip[])
  update(t: number, playing: boolean, rate: number, gain: number): void
}
```
- Inside a clip and playing at rate 1 with gain > 0: expected file time = from + (t − at); seek when |el.currentTime −
  expected| > 0.25 s; play if paused; volume = gain. Otherwise pause. Never throws when `play()` rejects (autoplay rules):
  it logs once.
- [ ] Failing tests with a fake MediaLike: plays inside, pauses outside, seeks on drift and after a scrub, pauses at
  rate ≠ 1, volume follows gain, pauses at gain 0. Implement → PASS.

### Task D1: DFDR digitization (JAL 123)

**Files:** Create `tools/scenarios/jal123/README.md`, `tools/scenarios/jal123/digitize.py`,
`tools/scenarios/jal123/digitize_check.py`. Output (git-ignored): `../FlightHopper/.work/jal123/dfdr_1hz.csv`
and `.work/jal123/digitize-report.md` with overlay PNGs (trace drawn over the scan) per chart page.
- Input: `62-2-JA8119-11.pdf` (77 pages: DFDR図-1…6 strip charts on the first ≈ 42 pages, then the CVR record).
  Render with `pdftoppm -r 300`. Identify per page: time axis (tick labels), each parameter's band and its scale
  (labels at the band edges), the trace. Read `.planning/reports/scenarios/track.md` §1 and §3 first (axis scales it
  already found: RLL ±80° with right roll up, PCH ±40°; HDG is magnetic; ALT pressure altitude on 29.92).
- Output columns: `time,hdg_mag,cas_kt,alt_press_ft,roll,pitch,vrtg_g,epr1,epr2,epr3,epr4,aoa` at 1 Hz from 18:11:32
  to 18:56:27 (empty where a chart has no data), plus `src_page`.
- `digitize_check.py` asserts the official observations (spec §6.1 step 1) within tolerances: CAS min 108 ± 6 kt within
  18:49:36–18:49:48; ALT min 5,300 ± 400 ft within 18:48:40–18:49:30; PCH ≤ −30° and RLL ≥ 60° within 18:56:00–18:56:12;
  RLL p-p ≥ 60° in 18:28:30–18:31:00; VRTG ≥ 2.5 within 18:56:17–18:56:24; HDG ≈ 040° before 18:39:51 and ≈ 100° after
  the 420° right turn at 18:45:21 (±15°); exits non-zero on failure.

### Task D2: Transcript (JAL 123)

**Files:** fragments `.work/jal123/transcript/<range>.csv` (git-ignored); Create
`tools/scenarios/jal123/merge_transcript.py`; Output `public/scenarios/jal123/transcript.csv`.
- Split by time: (a) ATC + company 18:09–18:24:11 (English report Attachments 3–4; PDF pages near printed 270–274);
  (b) 18:24:12–18:30:59; (c) 18:31:00–18:38:59; (d) 18:39:00–18:47:59; (e) 18:48:00–18:56:28 (Attachment 6, English
  report printed pp. 293–330, scanned upside-down: rotate 180°; Japanese record in part 11 after the charts).
- Each row per spec §3.5. Timing: the second row of the Japanese record's 00–59 grid (read the line's vertical position
  against the grid); wording: the English report verbatim (`q=D`), our translation from the Japanese only where the
  English page is illegible (`q=T`), `+++` → `[unintelligible]` (`q=U`). `src` = `EN:p.<printed page>` or `JA:p.<page>`.
  Addressee: from channel and content (commands to the flying pilot → `COP`; radio → the station; PA → empty).
- Include: every cockpit line, every radio exchange with JL123 (ACC, APC, YOK, COM, TWR, DEP), GPWS / stall warning as
  `alert` lines, the first of each cabin PA/PRA announcement. Exclude: other aircraft's traffic, repeats marked "same
  as left", contact sounds, everything after 18:56:21.
- `merge_transcript.py`: concatenates, sorts, checks schema, warns on lines closer than 0.3 s from the same speaker,
  and cross-checks the key-line times in `.planning/reports/scenarios/cvr.md` §2 (JTSB commentary times): any key line
  off by more than 3 s is an error.

### Task D3: Reconstruction inputs and livery art (JAL 123)

**Files:** Create `tools/scenarios/jal123/anchors.csv`, `tools/scenarios/jal123/winds.json`,
`tools/scenarios/jal123/livery.py`; Output `public/scenarios/jal123/livery/body.png` (committed) and
`public/scenarios/jal123/local/fin.png` (git-ignored).
- anchors.csv `time,lat,lon,alt_ft,tol_m,kind,src`: the 1985 runway 15L threshold and the lift-off point (trace
  from GSI `gazo3` 1984–86 aerial tiles at z16–17 around Haneda; viewing a handful of tiles is fine), the corrected
  anchors of `.planning/reports/scenarios/track.md` §2, the failure point, the larch, groove and ridge.
- winds.json: 1985-08-12 00Z and 12Z soundings for Tateno 47646 and Hamamatsu 47681 (University of Wyoming archive,
  read as web pages), levels with pressure, height, temperature, wind dir/speed; plus the magnetic declination at the
  area for 1985.6 (NOAA historical calculator or IGRF-13), with URLs.
- livery.py (Pillow): `body.png` 4096×1024, two rows (top = left side, bottom = right side, text mirrored in place on
  the right), u = nose→tail across `Paint.body` of b744, per spec §6.2 colours and positions; `fin.png` 512×512 RGBA
  simplified red crane ring with white "JAL" (local only). Screenshot both in the report folder.

### Task A1: Find the CVR audio (no download)

- Search the web for copies of the JAL 123 CVR audio: prefer the longest continuous one, from the most accountable
  host (e.g. archive.org items with a description of provenance). For each candidate: URL, host, title, duration,
  size if shown, format, whether it is the ≈32-min composite or the 5-min TBS edit, subtitles burned in or not,
  and red flags (added lines, music, narration). Report to the coordinator; **download nothing**.

---

## Wave 2

### Task 9: ScenarioRun and app integration

**Files:** Create `client/scenario/run.ts`, `client/scenario/run.test.ts` (pure parts only); Modify `client/app.ts`,
`client/app.test.ts`, `client/ui/urlState.ts`, `client/ui/urlState.test.ts`, `client/ui/layout.css`, `client/main.ts`.
- `ScenarioRun.start({ viewer, ui, scenario, t?, onExit })`: builds PoseTrack, ScenarioClock (paused at `t ?? start`),
  mounts playbar, captions, ending into `ui`; era imagery layers (UrlTemplateImageryProvider with `rectangle`,
  min/max zoom; inserted right above the base layer, under the night lights); `AudioSync` when `present.audio`; a
  keydown listener (Space play/pause, ←/→ ±10 s, Shift+←/→ ±60 s; ignores modifiers, repeats and typing, as
  `sceneKey`); `frame(dtS)` → `{ state, data, tUtcMs, event: EventState, fade }`; `destroy()` removes all of it.
- `app.ts`:
  - rail item `scenarios` (group 2, before About) with `mountScenarioPanel`; `onPlay(id)` → `startScenario(id)`.
  - `startScenario(id, t?)`: `loadScenario`; `select(null)`; chasing = true; `ui.dataset.scenario = id`; the chase
    model switches to the scenario model by id (`pick.models.find`) and waits until `use()` returns true;
    `paintLivery(liveryFromSpec(...))`; `setShape(aircraft.shape?.halfSpanM ?? null)`; camera to behind the first pose.
  - `frame()`: when a run is active: `s = run.frame(dtS).state`, `all = NO_ENTRIES`, the sun at `tUtcMs` (bypass
    `sunTimeMs`), `model.setDamage(event.damage.has('fin'))`, `model.setGear(event.gear)`, buildings hidden, the card
    hidden, `aglFt` from the ground, the frame drawn with the run's data; audio gain = 1 − fade.
  - Live chase: the FlightFrame with `liveFlightData(placed, chaseRaw, aglFt)`; safe area: the rail on the right, the
    card on the left when visible.
  - Poll loop: sleeps while a run is active. Esc: close a panel, else exit the run (then back to the map over the last
    position). `syncUrl`: `?scenario=<id>&t=<whole s>` while a run is active (and no `hex`/`chase`).
  - `?scenario=<id>&t=<s>` on load starts the run paused at t; `hooks.onFirstData` fires when it is ready.
  - About credits: the scenario's sources and imagery credit while it runs.
- [ ] Tests: urlState reads/writes scenario and t; `run.test.ts` covers the frame composition with fakes; `npm run check` PASS.
- [ ] Browser-pane verification per spec §8, screenshots to `.planning/reports/scenarios/shots/`.

### Task D4: Track reconstruction and check (JAL 123)

**Files:** Create `tools/scenarios/jal123/reconstruct.py`, `tools/scenarios/jal123/check.py`; Output
`public/scenarios/jal123/track.csv`.
- Method: spec §6.1 step 3. TAS from CAS via the compressible-flow relation with the sounding temperature; true
  heading = magnetic + declination; dead-reckon from the failure point forwards and backwards with the sounding wind;
  add a smooth correction (cubic smoothing spline in time for east and north offsets) that brings the path within each
  anchor's tolerance; true altitude = pressure altitude corrected with the sounding temperatures and the QNH that makes
  the final pass match the ground points (larch top ≈ 1,530 + 14 m at ≈18:56:23). Pitch, roll, g, EPR from the DFDR.
  Take-off roll: along the 1985 15L centreline from the roll start (18:11:32) to lift-off (18:12:16), `gnd=1`.
  Before 18:11:32: the aircraft holds on the threshold (start row at 18:11:15).
- Rows: 1 Hz; 4 Hz from 18:55:30 (spline-resampled); `q` = M where DFDR-derived, R where anchored/modelled; `src`.
- `check.py`: spec §6.1 step 4, exit non-zero on failure; prints a table of anchor misses and the minimum terrain
  clearance before 18:56:22 (GSI elevation API `cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php`, cached
  in `.work/jal123/elev-cache.json`).

### Task D5: JAL 123 package and the interface doc

**Files:** Create `public/scenarios/index.json`, `public/scenarios/jal123/scenario.json`,
`public/scenarios/jal123/events.csv`, `docs/scenarios.md`; Modify `.gitignore` (`public/scenarios/*/local/`).
- scenario.json per spec §3.2 with the JAL 123 values (spec §1, §6): start 18:11:15, end 18:56:28, ending fadeFrom
  18:56:17 / darkAt 18:56:22 / cardAfterS 5, the card text of spec §6.5, speakers of spec §6.4, the GSI imagery layer
  (rect around Haneda and Tokyo Bay), sources (report EN/JA with URLs, JTSB commentary, GSI, soundings), aircraft with
  model b744, halfSpanM 29.8, livery per spec §6.2.
- events.csv: phases (Take-off Haneda 15L · Climb over Tokyo Bay · Direct to Seaperch · Failure: loss of hydraulics ·
  Phugoid and Dutch roll · Turning north over Suruga Bay · West of Mt Fuji · Gear down · Otsuki loop · Descent toward
  Okutama · Low over Okutama · Stall and recovery · Flaps on alternate power · Final turn), marks (failure 18:24:35,
  "uncontrollable" 18:28:35 / 18:45:46 / 18:47:17 / 18:53:31, gear 18:39:32, stall 18:49:42, flaps 18:51:06, last ATC
  contact 18:55:05), gear 1 at start / 0 at 18:12:25 / 1 at 18:39:32, flaps per spec §6.3, damage fin at 18:24:35.
- docs/scenarios.md: the format (spec §3) for authors, the "what to send" checklist and the "not needed" list, the
  quality flags, the sensitivity rules, and a copy-paste prompt for a research agent that produces a package.

### Task A2: Audio (only after the user approves a specific file)

- Download the approved file to `public/scenarios/jal123/local/` (git-ignored). Transcribing it for alignment needs a
  speech model (none cached; Whisper `small` ≈ 460 MB is itself a download: ask first). Align each audio segment to the
  official transcript (distinctive lines and the GPWS calls), write `audio.clips` into scenario.json with the provenance
  in `audio.source`; a segment that does not match the record is left out.

---

## Wave 3: verify, review, finish

- Browser-pane verification of the whole flow (spec §8), phone viewport, screenshots sent to the user.
- A multi-dimension review workflow (correctness, sensitivity/content, UI/UX, performance) with adversarial checks; fix.
- `npm run check`, `npm run build`; ping the other sessions; merge to main after the user's OK; memory updated.

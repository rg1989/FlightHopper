# Weather that reads well — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The top-down map's weather (Layers › Weather) makes sense at a glance and looks as good as the map under it:
airports show a clear wind marker and a plain-language card instead of a wind barb and a raw METAR; the rain radar is
drawn smooth (no 1-km squares), in colours made for the light or dark map, and the map's labels stay on top of it.

**User's words (2026-10-02):** at Haifa airport "a very strange thing with a weird shape and texts that make no sense"
(the barb + raw METAR); radar "pixelated … relative to the map it looks bad … the data is staying the same, but we can
make it look nicer"; "texts … appear above the cloud and not beneath it, because it's unreadable"; "in dark and light mode
… adapt the clouds so they look appropriate, very clear, visible".

**Architecture:** Three tasks, each leaving the app working.
1. Airport weather in plain words: `shared/wx.ts` keeps the METAR fields the card needs; a new pure module
   `client/scene/wxText.ts` turns METARs and SIGMETs into short phrases; `client/scene/weather.ts` draws a new station
   marker and an HTML card.
2. Smooth radar: a new `client/scene/radar.ts` reads RainViewer's tiles back to dBZ, smooths each 5-dBZ band's outline
   and paints it in the theme's palette at any zoom up to 12; `weather.ts` uses it and swaps palettes with the theme.
3. Labels above the rain: `client/scene/mapLayer.ts` adds a copy of the street map holding only its ink (text, lines and
   their halo), shown over the radar while the weather is on; the radar goes in under it (and under the satellite's
   reference overlays).

**Tech Stack:** TypeScript 7 (`npm run typecheck`), Node 25 `node:test`, Cesium 1.145, Vite. No new dependencies.

## Global Constraints

- The data stays the same: RainViewer's newest past radar frame; METARs/SIGMETs as aviationweather.gov sends them. Only
  how they are drawn and worded changes.
- RainViewer free API (probed 2026-10-02): tiles exist for zoom ≤ 7 only; the colour-scheme parameter is IGNORED (every
  tile is "Universal Blue", scheme 2); options `{smooth}_{snow}`. We ask `…/256/{z}/{x}/{y}/2/0_1.png` (no server blur:
  it erased storm cores; snow told apart). Every pixel of a real tile matched a Universal Blue colour exactly.
- Copy is plain words; aviation codes only in a small muted chip or parentheses. No explanatory filler text.
- Speeds and heights shown to the user follow the flight-data frame's units (`client/ui/units.ts`: `speedIn`,
  `speedLabel`, `altIn`, `altLabel`; `'kt+kmh'` / `'ft+m'` add the second in parentheses). Times are local `HH:MM`.
- The top-down map is always north-up (`client/scene/browseCamera.ts` locks tilt; heading 0): marker images may bake in
  directions.
- External strings (station names, raw reports) go into the DOM with `textContent` only — never `innerHTML`.
- Repo style: a header comment per file saying what it is and why; comments only where the code can't say it; a
  `ponytail:` comment names any known ceiling. Match neighbouring code.
- The user's Mac is shared: run checks at low priority, one at a time —
  `nice -n 15 npm run typecheck` and `nice -n 15 node --test --test-concurrency=1 <the test files you touched>`.
  Do not start dev servers or browsers (the controller does the visual QA). Do not run the whole suite more than once
  per task.
- Commit on branch `feat/weather-look` in `/Users/rgv250cc/Documents/Projects/FlightHopper-liveries`. End commit
  messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Airport weather in plain words

**Files:**
- Modify: `shared/wx.ts` (Metar fields, `slimMetars`)
- Create: `client/scene/wxText.ts`, `client/scene/wxText.test.ts`
- Create: `shared/wx.test.ts`
- Modify: `client/scene/weather.ts` (station marker, hover card, SIGMET label, status line, constructor options)
- Modify: `client/scene/weather.test.ts` (sigmetLabel moved/reworded)
- Modify: `client/ui/sceneToggles.ts` (row hint, legend words), `client/ui/sceneToggles.css` (card),
  `client/ui/sceneToggles.test.ts` (only if a test pins the old words)
- Modify: `client/app.ts` (pass the units getter)

**Interfaces:**
- Produces: `Metar` with the new fields below; `wxText.ts` exports listed below; `Weather` constructor
  `new Weather(viewer, apiBase, tipParent, onStatus, opts?: WeatherOptions)` with
  `interface WeatherOptions { units?: () => Units }` (Task 3 adds `radarIndex`).

#### 1a. `shared/wx.ts`

`Metar` becomes (keep `raw`; the card reads cloud-free words such as CAVOK from it):

```ts
export interface Cloud {
  cover: 'FEW' | 'SCT' | 'BKN' | 'OVC' | 'VV' | string // as the API sends it
  baseFt: number | null // above the airport
  type: 'CB' | 'TCU' | null // read from the raw report: FEW030CB
}

export interface Metar {
  id: string
  name: string | null // "Haifa Intl, HA, IL" as the API sends it
  lat: number
  lon: number
  obsMs: number | null // observation time
  cat: FlightCategory | null
  wdir: number | null
  wspd: number
  wgst: number | null
  visKm: number | null
  visPlus: boolean // "or more" (9999, 10SM: the API's "6+", "10+")
  tempC: number | null
  dewC: number | null
  qnhHpa: number | null // the API's altim (hPa)
  wx: string | null // the API's wxString: "-RA BR"
  clouds: Cloud[]
  vertVisFt: number | null
  raw: string
}
```

`slimMetars` fills them from the Data API JSON (`name`, `obsTime` seconds → ms, `temp`, `dewp`, `visib`, `altim`,
`wxString`, `clouds: [{cover, base}]`, `vertVis`, `rawOb`). `visib` is statute miles: a number, or a string such as
`"6+"`, `"10+"`, `"1/2"`, `"1 1/2"`, `"M1/4"`; km = miles × 1.609344; a trailing `+` sets `visPlus`; `M` (less than)
reads as the number; anything unreadable → null. A cloud's `type` comes from the raw report's group with the same
cover and base in hundreds of feet (`FEW030CB` → cover FEW, base 3000 → `'CB'`).

`shared/wx.test.ts`: one test feeding the LLHA record below (and one with `visib: "1 1/2"`, clouds with a CB group in
`rawOb`, `wxString`, `obsTime`) and checking every field:

```json
{"icaoId":"LLHA","name":"Haifa Intl, HA, IL","obsTime":1790956200,"temp":26,"dewp":16,"wdir":250,"wspd":5,"wgst":null,
 "visib":"6+","altim":1014,"wxString":null,"clouds":[{"cover":"FEW","base":4500}],"fltCat":"VFR","vertVis":null,
 "rawOb":"METAR LLHA 021550Z AUTO 25005KT 9999 FEW045 26/16 Q1014","lat":32.81,"lon":35.04}
```
(LLHA: visKm ≈ 9.66, visPlus true, obsMs 1790956200000, clouds `[{cover:'FEW', baseFt:4500, type:null}]`.)

#### 1b. `client/scene/wxText.ts` (pure, no DOM, no Cesium)

Exports (all strings in plain English; `u` is `Units` from `client/ui/units.ts`):

- `compass(deg: number): string` — 16 points: `N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW` (250 → `WSW`).
- `stationName(name: string | null, id: string): string` — the part before the first comma, `/` → space, spaces
  collapsed, whole words `Intl` → `International`, `Arpt` → `Airport`, `Rgnl` → `Regional`, `Muni` → `Municipal`;
  null/empty → `id`. `"Haifa Intl, HA, IL"` → `"Haifa International"`; `"Tel Aviv/Ben Gurion Arpt, C, IL"` →
  `"Tel Aviv Ben Gurion Airport"`.
- `speedText(kt: number, u: Units): string` — `5 kt`, `9 km/h`, `6 mph`; `'kt+kmh'` → `5 kt (9 km/h)`; rounded.
- `altText(ft: number, u: Units): string` — `4,500 ft` (nearest 100 ft), `1,350 m` (nearest 50 m), `'ft+m'` →
  `4,500 ft (1,350 m)`; thousands separated (`toLocaleString('en-US')`).
- `windText(m: Pick<Metar,'wdir'|'wspd'|'wgst'>, u): string` — speed < 1 → `Calm`; `wdir` null → `Variable, 3 kt`;
  else `From WSW, 5 kt`; gusts add `, gusting 15 kt`.
- `visibilityText(km: number | null, plus: boolean): string | null` — null → null; ≥ 5 km → whole km; 1–5 km → one
  decimal; < 1 km → metres to the nearest 50; `plus` adds ` or more` (`9.66, true` → `10 km or more`; `2.4` →
  `2.4 km`; `0.8` → `800 m`).
- `cloudText(m: Pick<Metar,'clouds'|'vertVisFt'|'raw'>, u): string` — layers joined with ` · `: `Few at 4,500 ft`,
  `Scattered at …`, `Broken at …`, `Overcast at …`; type adds ` (thunderclouds)` for CB, ` (towering cumulus)` for TCU;
  `vertVisFt` → `Sky hidden, vertical visibility 200 ft`. No layers: raw has `CAVOK` → `None below 5,000 ft`, `NSC` →
  `No significant cloud`, `NCD` → `None detected`, `SKC`/`CLR` → `Clear sky`, else `Not reported`.
- `weatherText(wx: string | null): string | null` — tokens split on spaces, each decoded, joined with `, `, only the
  first letter of the whole text capitalised:
  ```ts
  const DESC: Record<string, string> = { MI: 'shallow', PR: 'partial', BC: 'patches of', DR: 'drifting', BL: 'blowing',
    SH: '', TS: '', FZ: 'freezing' }
  const PHEN: Record<string, string> = { DZ: 'drizzle', RA: 'rain', SN: 'snow', SG: 'snow grains', IC: 'ice crystals',
    PL: 'ice pellets', GR: 'hail', GS: 'small hail', UP: 'precipitation', BR: 'mist', FG: 'fog', FU: 'smoke',
    VA: 'volcanic ash', DU: 'dust', SA: 'sand', HZ: 'haze', PY: 'spray', PO: 'dust whirls', SQ: 'squalls',
    FC: 'funnel cloud', SS: 'sandstorm', DS: 'dust storm' }
  function phrase(tok: string): string {
    let i = 0
    let strength = ''
    if (tok[0] === '-') [strength, i] = ['light', 1]
    else if (tok[0] === '+') [strength, i] = ['heavy', 1]
    const near = tok.startsWith('VC', i)
    if (near) i += 2
    const d = tok.slice(i, i + 2)
    const desc = d in DESC ? d : ''
    if (desc) i += 2
    const ph: string[] = []
    for (; i + 2 <= tok.length; i += 2) ph.push(PHEN[tok.slice(i, i + 2)] ?? tok.slice(i, i + 2))
    const what = ph.join(' and ')
    const words = desc === 'SH' ? `${what ? `${what} ` : ''}showers`
      : desc === 'TS' ? `thunderstorm${what ? ` with ${what}` : ''}`
      : [DESC[desc], what].filter(Boolean).join(' ')
    return [strength, words].filter(Boolean).join(' ') + (near ? ' nearby' : '')
  }
  ```
  `-RA BR` → `Light rain, mist`; `-SHRA` → `Light rain showers`; `+TSRA` → `Heavy thunderstorm with rain`;
  `VCSH` → `Showers nearby`; `FZFG` → `Freezing fog`; `BCFG` → `Patches of fog`; `RASN` → `Rain and snow`.
- `tempText(t: number | null, dew: number | null): string | null` — `26 °C, dew point 16 °C`; no dew point → `26 °C`;
  no temperature → null. Whole degrees.
- `pressureText(hpa: number | null): string | null` — `1014 hPa`.
- `CONDITION: Record<FlightCategory, string>` — `{ VFR: 'Good', MVFR: 'Marginal', IFR: 'Poor', LIFR: 'Very poor' }`.
- `hhmm(ms: number): string` — local `HH:MM`, zero-padded (as `client/history/selected.ts`' private `hhmm`).
- `sigmetTitle(s: Sigmet): string` — hazard name, the qualifier as a word before it:
  ```ts
  const HAZARD: Record<string, string> = { TS: 'Thunderstorms', TSGR: 'Thunderstorms with hail', TURB: 'Turbulence',
    ICE: 'Icing', MTW: 'Mountain waves', VA: 'Volcanic ash', TC: 'Tropical cyclone', DS: 'Dust storm',
    SS: 'Sandstorm', RDOACT: 'Radioactive cloud' }
  const QUALIFIER: Record<string, string> = { SEV: 'Severe', MOD: 'Moderate', EMBD: 'Embedded', OBSC: 'Obscured',
    FRQ: 'Frequent', ISOL: 'Isolated', OCNL: 'Occasional', SQL: 'Squall-line', HVY: 'Heavy' }
  ```
  `{hazard:'TS', qualifier:'EMBD'}` → `Embedded thunderstorms`; `{TURB, SEV}` → `Severe turbulence`; unknown hazard →
  the code; unknown qualifier → no word.
- `sigmetLevels(s: Sigmet, u): string | null` — top null → null; base null → `Up to 35,000 ft`; base ≤ 0 →
  `Surface to 5,500 ft`; else `18,000 to 35,000 ft` (via `altText`).
- `sigmetLabel(s: Sigmet, u): string` — the map label: `` `${title} · ${levels}` `` with the levels lower-cased at the
  start (`Embedded thunderstorms · up to 35,000 ft`), or the title alone. (Moves here from weather.ts, which keeps no
  `sigmetLabel` of its own; update weather.test.ts accordingly.)

`client/scene/wxText.test.ts`: the examples above, each as an assertion (group by function; ~10 tests).

#### 1c. Station marker (`weather.ts`, replaces `symbol` and `barbs`)

One canvas per look, drawn at 2× for sharp edges, shown 48 × 48 px, north-up (no billboard rotation or alignedAxis):

- centre (24, 24); a disc r = 10.5 filled `rgba(13, 17, 25, 0.92)`, ringed 2.5 px in the flight-rules colour
  (`CATEGORY_COLOR`, `NO_CATEGORY` when null);
- inside, the wind speed in the frame's speed unit (`speedIn`, first unit, rounded), white, `700 11px` system UI font
  (`600 9.5px` when ≥ 100), centred;
- when the direction is known and the speed ≥ 1 kt: an arrow pointing where the wind blows TO (`wdir + 180°`; screen
  `dx = sin θ`, `dy = −cos θ`): shaft from r = 12 to r = 19, a filled head from r = 17 (half-width 4.5) to its tip at
  r = 23; white (2 px shaft) over a dark halo `rgba(10, 14, 22, 0.85)` 5 px wide, like the old barb's halo.
- Look key: `` `wx:${cat}:${number}:${dir}` `` with the arrow direction rounded to 10° (or `-` for none); keep the
  existing one-texture-per-look cache. Remove `barbs` and its test.

#### 1d. Hover card (`weather.ts` + `sceneToggles.css`)

The existing `.fh-wx-tip` element keeps its placement logic; its content becomes DOM built with `textContent`:

METAR (rows whose text is null are left out):
```
<div class="fh-wx-h"><span class="fh-wx-name">Haifa International</span><span class="fh-wx-id">LLHA</span>
  <span class="fh-wx-t">18:50</span></div>
<div class="fh-wx-cond" style="--c: <category colour>">Good conditions <span class="fh-wx-code">VFR</span></div>
<dl class="fh-wx-rows">
  <dt>Wind</dt><dd>From WSW, 5 kt</dd>
  <dt>Visibility</dt><dd>10 km or more</dd>
  <dt>Cloud</dt><dd>Few at 4,500 ft</dd>
  <dt>Weather</dt><dd>Light rain, mist</dd>
  <dt>Temperature</dt><dd>26 °C, dew point 16 °C</dd>
  <dt>Pressure</dt><dd>1014 hPa</dd>
</dl>
```
(no category → no `.fh-wx-cond` line; no `obsMs` → no time.)

SIGMETs under the pointer, one block each, separated by a hairline:
```
<div class="fh-wx-h"><span class="fh-wx-name" style="--c: <sigmetColor>">Embedded thunderstorms</span>
  <span class="fh-wx-t">until 21:00</span></div>
<dl class="fh-wx-rows"><dt>Height</dt><dd>Up to 35,000 ft</dd></dl>
```

CSS (replace the monospace `.fh-wx-tip` rule): `font: 12.5px/1.45 var(--fh-font)`, `white-space: normal`,
`max-width: min(300px, calc(100% - 16px))`, padding 10px 12px, `.fh-glass` look kept; `.fh-wx-h` a baseline flex row
(name 600 13px `--fh-text`; id 11px `--fh-faint`; time `--fh-muted` pushed right, `fh-num`); `.fh-wx-cond` 12px with an
8 px dot `::before` in `var(--c)`; `.fh-wx-code` a small muted chip (10px, 1px 5px padding, hairline border,
radius 4px); `.fh-wx-rows` a two-column grid (`auto 1fr`, gap 2px 12px, margin 6px 0 0) with `dt` in `--fh-muted`;
a `.fh-wx-sep` hairline (`border-top: 1px solid var(--fh-hairline)`, margin 8px 0) between SIGMET blocks; a SIGMET
`.fh-wx-name` gets the same coloured dot before it.

#### 1e. Words elsewhere

- SIGMET map labels use `sigmetLabel(s, units())`.
- Status line: `` `Radar ${hhmm(ms)}` `` (local, not `Z`), `N airports`, `N hazard areas` (1 → `1 hazard area`).
- `client/ui/sceneToggles.ts`: the Weather row's hint → `Rain radar, airport weather, hazard areas`; the legend starts
  with a muted `Airports` word, then the four chips worded `Good`, `Marginal`, `Poor`, `Very poor` (same colours).
- `client/app.ts`: keep the frame's units in a variable updated in FlightFrame's `onPrefs` (and initialised from
  `readFramePrefs(storedFrame).units`); pass `{ units: () => frameUnits }` to `new Weather`. Re-wording on a units
  change needs only the next hover/refresh — no rebuild.

- [ ] Step 1: `shared/wx.test.ts` + `wxText.test.ts` failing; implement `shared/wx.ts`, `wxText.ts`; tests pass.
- [ ] Step 2: marker + card + words in `weather.ts`, CSS, toggles, app wiring; update `weather.test.ts`.
- [ ] Step 3: `nice -n 15 npm run typecheck`; `nice -n 15 node --test --test-concurrency=1 shared/wx.test.ts
  client/scene/wxText.test.ts client/scene/weather.test.ts client/ui/sceneToggles.test.ts`.
- [ ] Step 4: commit `feat(weather): airports in plain words — a wind arrow and speed in place of the barb, a card in place of the raw METAR; hazard areas named`.

---

### Task 2: Smooth radar in the theme's colours

**Files:**
- Create: `client/scene/radar.ts`, `client/scene/radar.test.ts`
- Modify: `client/scene/weather.ts` (radar layer, `theme`, swap without a gap)
- Modify: `client/ui/sceneToggles.ts` / `.css` / `.test.ts` (rain scale)
- Modify: `client/app.ts` (`weather.theme`)

**Interfaces:**
- Consumes: Task 1's `Weather` shape.
- Produces: `radar.ts` exports below; `Weather.theme: 'light' | 'dark'` (setter); `RAIN_PALETTE`.

#### 2a. What the tiles hold and how we read them

RainViewer's z ≤ 7 tiles, 256 px, Universal Blue colours: each colour is one integer dBZ, rain and snow separately.
The table (dBZ −10 … 95, rain then snow, RRGGBBAA, from https://www.rainviewer.com/files/rainviewer_api_colors_table.csv,
column "Universal Blue") is ready to paste in
`/private/tmp/claude-501/-Users-rgv250cc-Documents-Projects-FlightHopper/e8b64e5e-e91e-4b6c-9a70-073e94db0ee2/scratchpad/wx/ub.ts`
(`UB_RAIN[i]` and `UB_SNOW[i]` are dBZ `i − 10`). Build a `Map<number, number>` from the packed RGBA (`>>> 0`) to
`dbz | (snow ? 0x100 : 0)` skipping alpha-0 entries and keeping the FIRST dBZ of a repeated colour (65+ white, 75+ green
and blue). A pixel with alpha 0, or a colour not in the map, is no echo.

```ts
export const RADAR_SRC_MAX = 7 // RainViewer's free API: deeper zooms are a "zoom not supported" picture
export const RADAR_MAX_LEVEL = 12 // our deepest tile (a source pixel 32 px wide); Cesium magnifies past it
export const FIRST_DBZ = 15 // RainViewer's coloured scale starts here; their faint beige below it is left out
export const STEP_DBZ = 5
export const BANDS = 11 // 15, 20, … 60, 65+
const LEVEL = 0.35 // a band's edge: where its smoothed share crosses this (0.5 would shrink one-pixel cells away)
const NONE = -128
export type Rgba = readonly [number, number, number, number] // 0–255 ×3, alpha 0–1
export interface Palette { rain: readonly Rgba[]; snow: readonly Rgba[] } // BANDS each
export interface SourceTile { dbz: Int8Array; snow: Uint8Array } // 256 × 256, row-major, north row first; NONE: no echo

/** RGBA bytes of a Universal Blue tile → dBZ and snow per pixel. */
export function decodeTile(rgba: Uint8ClampedArray): SourceTile
```

#### 2b. Drawing one tile — the method and why

Measured on today's tiles: the radar's real cells are ~2 km (2 × 2 tile pixels); upscaled as is they are the squares the
user saw. Blurring the dBZ and then colouring rounds them but lowered small storm cores by up to 19 dBZ (a storm drawn
as light rain) — not allowed. Instead each band's REGION is smoothed: for every threshold T = 15, 20, … 65, the 0/1
"dBZ ≥ T" field is resampled with a cubic B-spline (smooth, never overshoots) and its edge drawn where it crosses
`LEVEL`. Bands nest, every core keeps its band (a one-pixel cell stays a small dot), and the outlines are curves.

```ts
/**
 * One 256 × 256 output tile (RGBA bytes, straight alpha) at level/x/y. Its source is the tile at level min(level, 7):
 * itself up to 7, else its level-7 ancestor, of which it covers a 256 / 2^d square magnified k = 2^d times (d = level −
 * 7). src(sx, sy) answers a decoded source tile of that level (x wraps; a y outside the map, or a missing tile → null,
 * read as no echo); M source pixels round the square come from the neighbours, so adjacent tiles meet seamlessly.
 */
export function renderTile(level: number, x: number, y: number, src: (sx: number, sy: number) => SourceTile | null, pal: Palette): Uint8ClampedArray
```

Exact steps (output pixel i, j in 0…255; ±1 margin for the gradient):
1. `S = min(level, 7)`, `d = level − S`, `k = 2 ** d`, `size = 256 / k`, source tile `sx = x >> d`, `sy = y >> d`,
   square origin `ox = (x − (sx << d)) * size`, `oy` likewise.
2. Patch of `P = size + 2M` source pixels, `M = 3`, top-left at source pixel `(ox − M, oy − M)` of tile (sx, sy);
   pixels outside that tile read from the neighbour tile (global source pixel `gx = sx·256 + ox − M + px`, tile
   `floor(gx / 256)` wrapped mod 2^S, column `gx mod 256`; rows likewise, out-of-map rows → no echo).
3. Sample positions for output index `i ∈ [−1, 256]` (258 values): `u = M + (i + 0.5) / k − 0.5` in patch pixels; taps
   `floor(u) − 1 … floor(u) + 2` with cubic B-spline weights of `t = u − floor(u)`:
   `w0 = (1−t)³/6, w1 = (3t³ − 6t² + 4)/6, w2 = (−3t³ + 3t² + 3t + 1)/6, w3 = t³/6`. Same for rows (v).
4. For each band b (T = 15 + 5b), skipped when no patch pixel reaches T: the indicator (1 where dBZ ≥ T) resampled
   separably (rows first, then columns) to a 258 × 258 field `F`. Its edge, anti-aliased over one output pixel:
   `count += clamp((F − LEVEL) / g + 0.5, 0, 1)`, `g = max(hypot((F[i+1] − F[i−1]) / 2, (F[j+1] − F[j−1]) / 2), 1e−4)`.
5. Snow: when any patch pixel is snow at ≥ 15 dBZ, its indicator resampled the same way; `≥ 0.5` paints from
   `pal.snow`, else `pal.rain`.
6. Colour from `c = count`: `c ≤ 0` transparent; `c < 1` the first band's colour, alpha × c; else `n = floor(c)`,
   lerp(colours[n − 1], colours[min(n, BANDS − 1)], c − n) (RGB and alpha alike). Write alpha × 255.

Palettes (tuned by eye on the controller's QA; values to start from):
```ts
export const RAIN_PALETTE: Record<'light' | 'dark', Palette> = {
  // the light street map: deeper blues so light rain shows on its pale land and blue sea; amber, not yellow
  light: { rain: hex(['#0a84ff', .38], ['#0a6cff', .50], ['#1450e0', .62], ['#2a35b8', .72], ['#ffc400', .85],
    ['#ff8a00', .88], ['#f0442c', .90], ['#c8193c', .92], ['#a020c8', .92], ['#6a1b9a', .92], ['#4a148c', .92]),
    snow: hex(['#8f86ff', .35], ['#7d72f5', .45], ['#6a5ce6', .55], ['#5847d4', .65], ['#4b3bc4', .72], ['#4b3bc4', .72],
    ['#4b3bc4', .72], ['#4b3bc4', .72], ['#4b3bc4', .72], ['#4b3bc4', .72], ['#4b3bc4', .72]) },
  // the dark map and the satellite: luminous cyan to indigo, then warm
  dark: { rain: hex(['#38c6ff', .40], ['#2fa8ff', .52], ['#2f86ff', .62], ['#3d66ff', .70], ['#ffd447', .88],
    ['#ff9c33', .90], ['#ff5a3c', .92], ['#e8325f', .94], ['#d659ff', .95], ['#f3d9ff', .95], ['#ffffff', .95]),
    snow: hex(['#cfe0ff', .35], ['#dbe7ff', .45], ['#e6eeff', .55], ['#f0f5ff', .65], ['#ffffff', .75], ['#ffffff', .75],
    ['#ffffff', .75], ['#ffffff', .75], ['#ffffff', .75], ['#ffffff', .75], ['#ffffff', .75]) },
}
```

#### 2c. The provider

```ts
/** Decoded source tiles of one frame, fetched once each and shared by every tile and palette drawn from them. */
export class RadarSource {
  constructor(host: string, path: string)
  /** The decoded tile, null when it has no echo or failed; the same promise for the same tile. */
  get(z: number, x: number, y: number): Promise<SourceTile | null>
}
```
- URL `` `${host}${path}/256/${z}/${x}/${y}/2/0_1.png` ``; `fetch` → `blob` → `createImageBitmap` → a 256-px canvas →
  `getImageData` → `decodeTile`. A tile with no echo resolves null (and costs no arrays). Failures resolve null and
  are not retried for this frame. ponytail: keeps every tile of the frame it was asked for (a frame lives 10 min; a
  session pans over tens of tiles), the next frame's source replaces it.

```ts
/** RainViewer's frame drawn smooth (renderTile) in a palette: Cesium asks for tiles up to RADAR_MAX_LEVEL. */
export class RadarProvider extends UrlTemplateImageryProvider {
  constructor(source: RadarSource, palette: Palette) // super({ url: <the frame's z/x/y template>, maximumLevel: RADAR_MAX_LEVEL })
  override requestImage(x: number, y: number, level: number): Promise<HTMLCanvasElement>
}
```
`requestImage` awaits the source tile (sx, sy) and, when the square lies within M pixels of its edges, the neighbours
it needs (at most 3 more); calls `renderTile` with a sync `src` over the awaited set; returns a fresh 256-px canvas with
the pixels put in (a canvas, drawn north-up: Cesium flips canvases on upload as it does images). When every needed
source is null the result is one shared transparent canvas.

#### 2d. `weather.ts`

- `theme` setter (`'light' | 'dark'`, default `'dark'`): when it changes and a frame is loaded, a new layer with the
  other palette replaces the old one, sharing the frame's `RadarSource` (no refetch).
- `loadRadar`: a frame not changed since the last index (same `path`) is not reloaded; a new frame gets a new
  `RadarSource`.
- Replacing a radar layer (new frame or theme) never leaves a gap: the new layer is added (shown as the weather is),
  the old one removed once `viewer.scene.globe.tilesLoaded` after at least one rendered frame (as `mapLayer.ts`' theme
  swap does with `scene.postRender`), at once when hidden.
- The layer is still added on top of all imagery (Task 3 moves it under the map's labels).

#### 2e. Panel and app

- `sceneToggles.ts`: under the Weather row, above the airports legend, a rain scale: `Light` · a 6 px high rounded bar
  (`linear-gradient(90deg, …)` of the current theme's 11 rain colours at full opacity) · `Heavy`. Theme =
  `prefs.dark || !prefs[baseKey(chasing)] ? 'dark' : 'light'`; re-drawn when the base or theme changes.
- `app.ts` `applyLayers`: `weather.theme = prefs.dark || !onMap ? 'dark' : 'light'` (the satellite is dark under the
  rain).

`client/scene/radar.test.ts` (pure, no network, no canvas):
- `decodeTile`: `#88ddeeff` → 15 rain; `#ffee00ff` → 35; `#ffffffff` → 65; `#bfffffff` → 10 snow; `#9fdfffff` → 15 snow;
  alpha 0 → NONE; an unknown colour → NONE.
- `renderTile` with a synthetic source (all NONE but given pixels):
  - empty source → all alpha 0;
  - a single 40 dBZ pixel at level 7 → the output pixel there carries the 40–45 band's colour (rain[5]) and pixels 3
    away are transparent (cores kept, no halo);
  - the same pixel at level 9 (k = 4) → the centre of its 4 × 4 output block is rain[5]; no output pixel is a colour
    above rain[5] (no overshoot);
  - a 20 dBZ block of 12 × 12 source pixels → at level 10 the tile's interior is rain[1] and its outline has
    intermediate alphas only within 1 px of the edge (anti-aliased, not blurred);
  - seams: two adjacent level-9 tiles cut from one source tile with an echo across their border → the columns either
    side of the border differ by no more than neighbouring columns inside a tile;
  - snow pixels paint from `pal.snow`.

- [ ] Step 1: failing tests; implement `radar.ts`; tests pass.
- [ ] Step 2: `weather.ts`, toggles, app; typecheck; run `radar.test.ts`, `weather.test.ts`, `sceneToggles.test.ts`.
- [ ] Step 3: commit `feat(weather): rain drawn smooth at every zoom in colours for the light or dark map — each band's outline smoothed, every storm core kept`.

---

### Task 3: Labels above the rain

**Files:**
- Modify: `client/scene/mapLayer.ts`, `client/scene/mapLayer.test.ts`
- Modify: `client/scene/weather.ts` (`radarIndex` option)
- Modify: `client/app.ts`

**Interfaces:**
- Consumes: Task 2's radar layer handling.
- Produces: `StreetMap.lift: boolean`, `StreetMap.liftIndex: number`, `inkAlpha`, `WeatherOptions.radarIndex`.

The street map's labels are baked into its tiles, so they cannot be raised alone. A second copy of the same tiles
keeps only their ink — text, road casings, borders, rails, icons — and the light halo round it, transparent
elsewhere; it lies over the radar while the weather shows. Where no rain falls it draws exactly what the map under it
already shows, so it is invisible; under rain the names stay crisp. Measured on Haifa/Lebanon tiles (prototype): legible
in both themes.

```ts
// Ink: dark pixels of the light (original) tile, and a halo one pixel round them.
const INK_DARK = 0.42 // luminance at or below: ink
const INK_LIGHT = 0.62 // at or above: not ink (fills: land 0.94, water 0.80, parks 0.93, forest 0.78, buildings 0.82)
const HALO = 0.85

/** The ink share (0–255) of each pixel of a w × h RGBA tile in the light map's own colours. */
export function inkAlpha(px: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const n = w * h
  const t = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const lum = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255
    t[i] = lum <= INK_DARK ? 1 : lum >= INK_LIGHT ? 0 : (INK_LIGHT - lum) / (INK_LIGHT - INK_DARK)
  }
  const out = new Uint8Array(n)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let halo = 0
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx >= 0 && xx < w && t[yy * w + xx] > halo) halo = t[yy * w + xx]
        }
      }
      out[y * w + x] = Math.round(Math.max(t[y * w + x], HALO * halo) * 255)
    }
  }
  return out
}
```

- `InkOsmProvider extends OpenStreetMapImageryProvider` with a `dark` flag: `requestImage` → `super.requestImage` →
  draw into a canvas → `getImageData` → alpha = `inkAlpha` of those (original) pixels → when dark, `nightPixels` on
  the same bytes (alpha untouched by it) → set the alpha → `putImageData` → return as `night()` does (an
  `ImageBitmap` source goes back as a bitmap, closed after drawing; an image as a canvas).
- `makeMapLayer` adds two ink layers right after the dark layer — light (same `brightness`/`saturation` as the light
  map layer, so the two match pixel for pixel) then dark — both hidden. `StreetMap` gains:
  - `lift: boolean` (default false): while `show && lift`, the current theme's ink layer shows, the other hides;
    otherwise both hide (a hidden layer loads nothing). Theme swaps keep this true.
  - `readonly liftIndex: number` — `layers.indexOf(<the light ink layer>)`: a layer added at this index lies over the
    map and under its ink.
- `Weather` options gain `radarIndex?: () => number`; a radar layer is added with
  `viewer.imageryLayers.add(layer, radarIndex())` when given (else on top, as before).
- `app.ts`: `new Weather(…, { units: …, radarIndex: () => map.liftIndex })`; in `applyLayers`, after `weather.show`:
  `map.lift = weather.show`. Over the satellite, the radar now also lies under Esri's roads and places overlays (added
  after the map layers).

`mapLayer.test.ts` additions:
- `inkAlpha`: a land pixel (#f2efe9) → 0; a text pixel (#222222) → 255; a land pixel next to a text pixel → ~217
  (0.85 × 255); a water pixel (#aad3df) with no ink near → 0; a mid grey (#8f8f8f, lum ≈ 0.56) → partial.
- Layer order: after `makeMapLayer` + `makeReferenceLayers` and a layer added at `map.liftIndex`: base < light map <
  dark map < added layer < light ink < dark ink < roads < places.
- `lift`: hidden by default; `lift = true` shows the light ink only; `dark = true` swaps to the dark ink; `show = false`
  hides both; `lift = false` hides both.
- The existing count test (3 layers) becomes 5.

- [ ] Step 1: failing tests; implement; tests pass.
- [ ] Step 2: weather + app wiring; typecheck; run `mapLayer.test.ts`, `weather.test.ts`.
- [ ] Step 3: commit `feat(map): the map's names and lines over the rain — a copy of its tiles holding only their ink, shown while the weather is on; the radar under it and under the satellite's overlays`.

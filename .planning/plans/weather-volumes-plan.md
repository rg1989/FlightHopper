# Weather Volumes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the chase view the weather is real 3-D volumes the aircraft flies into and disappears in, in three looks the user switches on the fly, with three hazard-area styles and three "looking ahead" aids, all chosen in a new Weather menu.

**Architecture:** The cloud specs Weather3D already builds (`CloudSpec[]`) gain a severity and are rasterised into a *weather field* (four altitude bands of coverage, base, top, severity over a 320 km square). One post-process pass (`CloudVolume`) ray-marches that field at half resolution, reading the depth buffer so the aircraft, terrain and buildings hide and are hidden correctly. The same pass draws the hazard areas' edges, the level slice and the track line, so they sort with the cloud. A pure `wxAhead` module answers "what is on this heading" for the HUD's status line and ahead strip. A new rail panel holds the choices; they persist in localStorage.

**Tech stack:** TypeScript, Cesium 1.145 (`PostProcessStage`, `PostProcessStageComposite`), Vite, `node:test`.

**Reference implementation:** `.planning/mocks/chase-weather-mocks.html` is the mock the user approved ("I like all of them"). Its fragment shader (`<script id="fs">`) is the look to port: `macro()`, `warp()`, `fbm()`, the march loop, the "blocks" branch, the events (hazard walls, level slice, track line), `seaCol()`'s shadows and hatch. Its JS shows the status line and the ahead strip. Port the behaviour, not the mock's toy scene.

## The user's requirements (verbatim, 2026-10-03)

- "The added clouds look very two-dimensional. Extremely pixelated. It's very unclear how far they are from the aircraft."
- "there is like this red border thing in front and around, and it's very unclear in the 3D mode whether I am already in the zone. Is it the next zone?"
- "if we enable weather, then an aircraft that actually is going through clouds should be actually going through clouds in the 3D mode. So I would actually see the airplane partially or fully disappear within the cloud or storms"
- "to be able to see, when I'm looking forward in the map, where are these next zones, or areas, or clouds that I might enter … if it doesn't change direction"
- "It doesn't have to look like physical clouds, but it has to be a very proper representation that makes it very clear when I'm in a cloud and what type, or what color, cloud is it, or its severity."
- "add all of these options in a new menu similar to the Layers menu, but it would be the Weather menu and it would open after we enable the Weather … I like all of them for different scenarios … implement all of them so I can turn all of them on and off or choose on the fly."
- "the ahead of this heading component should also be something I can switch on and off."

## Global Constraints

- Work only in `/Users/rgv250cc/Documents/Projects/FlightHopper-wxlab` (branch `feat/wx-lab`). Never write under any `.claude/` or `.git/` path. Never push. No new dependencies. No downloads.
- **The Mac must stay responsive (the user is on it).** On the Mac run only `nice -n 15 node --test <one test file>` for files you touch and, once at the end of a task, `nice -n 15 npx tsc --noEmit -p .`. No full test suite, no `npm run check`, no dev server, no browser, no headless Chrome on the Mac.
- **Visual checks run on omarchy only**, through `.planning/tools/qa-omarchy.sh <out-dir> "<name>|<query>" …` (it copies the tree, starts a replay API, vite and one headless Chromium there, takes the shots, stops everything, fetches the PNGs). Use an out-dir under `/private/tmp/claude-501/-Users-rgv250cc-Documents-Projects-FlightHopper/b1844639-577f-4145-81b6-c98f44234437/scratchpad/qa/`. One QA run at a time. Never touch `~/flighthopper` on omarchy (the TV's own app). Look at the shots yourself (Read the PNG) and iterate until they are right.
- The standard QA scene: `hex=a831b2&chase=1&wx=1&wxdemo=1&cam=<headingOffset>,<pitch>,<rangeM>` (replay aircraft QXE2290, 2026-09-23, descending to SFO; `wxdemo=1` is Task 1's synthetic sky, so no upstream weather is asked for). Useful cameras: `0,-12,250` (chase), `35,-22,6000`, `20,-38,45000`.
- No personal data in any request, headers included.
- Match the code around you: comment style (plain declarative sentences that say what and why), naming, density. A deliberate simplification gets a `// ponytail: <ceiling>. Upgrade: <path>.` comment. Tests are `node:test` in the sibling `*.test.ts`. Pure logic lives in Cesium-free modules so Node tests cover it.
- The weather is live only and costs nothing while hidden: `Weather3D.show = false` must leave no post-process stage in the scene and run nothing per frame.
- Severity scale everywhere: `0` cloud, `1` light rain or snow, `2` heavy rain, `3` thunderstorm. Colours: `#f2f5f8`, `#58a6ff`, `#ffbe3d`, `#ff4d3d`. Hazard red: `#ff5a52`.
- Commit at the end of each task: message style as `git log` shows (`feat(chase): …`), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File structure

| File | Responsibility |
|---|---|
| `client/scene/cloudField.ts` (modify) | `CloudSpec.sev`, set by each builder |
| `client/scene/wxField.ts` (new, pure) | specs → weather field; sample it; pack it for the GPU |
| `client/scene/wxDemo.ts` (new, pure) | a synthetic sky and hazard area laid along a track (`?wxdemo=1`) |
| `client/scene/cloudVolume.ts` (new) | the post-process pass: three looks, rain veil, ground shadows, hazard edges, level slice, track line |
| `client/scene/wxAhead.ts` (new, pure) | the path ahead; what it meets; the strip's cells; the status line's words |
| `client/scene/weather3d.ts` (modify) | owns the field and the pass; style setters; demo sky; ground footprints |
| `client/ui/wxPrefs.ts` (new, pure) | the Weather menu's choices: URL > localStorage > defaults |
| `client/ui/wxMenu.ts`, `wxMenu.css` (new) | the Weather panel |
| `client/ui/wxHud.ts`, `wxHud.css` (new) | status line, inside frame, ahead strip |
| `client/app.ts` (modify) | rail item, prefs, per-frame wiring |

---

### Task 1: Severity, the weather field, the demo sky

**Files:** modify `client/scene/cloudField.ts`, `client/scene/cloudField.test.ts`; create `client/scene/wxField.ts`, `wxField.test.ts`, `client/scene/wxDemo.ts`, `wxDemo.test.ts`.

**Produces (exact names later tasks use):**

```ts
// cloudField.ts
export interface CloudSpec { /* …existing… */ sev?: number } // absent: 0
// wxField.ts
export const FIELD_N = 512          // texels a side
export const FIELD_KM = 320         // the square covered, centred where the field was built
export const BANDS = 4              // by a cloud's base: under 2,000 m, to 4,500 m, to 8,000 m, above
export const BAND_TOP_M: readonly number[] // [2000, 4500, 8000]
export const HEIGHT_MAX_M = 16000   // heights are packed over 0 … this
export interface WxField {
  lat: number; lon: number                      // its centre, degrees
  cov: Float32Array[]; base: Float32Array[]; top: Float32Array[]; sev: Float32Array[] // one per band, FIELD_N² each; metres above sea level
  lo: number[]; hi: number[]                    // each band's lowest base and highest top, m; lo > hi: the band is empty
  empty: boolean
}
export function buildField(specs: readonly CloudSpec[], lat: number, lon: number): WxField
export function profile(h: number, base: number, top: number): number // 0…1: flat base, rounded top (the mock's prof())
export function sampleField(f: WxField | null, lat: number, lon: number, altM: number): { cover: number; sev: number }
export function fieldAtlas(f: WxField): { data: Uint8ClampedArray; width: number; height: number } // 2 × 2 tiles of FIELD_N²: R cover, G base, B top (each /HEIGHT_MAX_M), A sev/3
// wxDemo.ts
export function demoSky(lat: number, lon: number, trackDeg: number): { specs: CloudSpec[]; sigmets: Sigmet[] }
```

**Behaviour:**

- Severity by builder in `cloudField.ts`: observed layer puffs 0; a TCU tower's puffs 2; a CB tower's puffs and anvil 3; the radar's deck puffs (15–30 dBZ, or snow) 1; the radar's towers 2 for 30 to under 40 dBZ and 3 from 40 dBZ; the model's puffs 0. Read the file's header and builders first; the tower and radar builders already know which case they are in.
- `buildField`: each spec is a soft disc on the map in the band its base falls in. Base `heightM − PUFF_FILL·scale[1]/2`, top `heightM + PUFF_FILL·scale[1]/2` (`PUFF_FILL` is exported by cloudField.ts). Radius `max(0.36·scale[0], one texel)`; weight 1 inside 55 % of the radius, falling smoothly to 0 at the rim. In a texel: cover joins as `1 − Π(1 − wᵢ)`; base, top and sev are the weights' averages. Map east–west by the longitude difference times `cos(lat)`; a flat local map is accurate enough over 160 km. Specs outside the square are skipped.
- `sampleField`: bilinear in the band maps, `cover = max over bands of cov·profile(alt, base, top)`, `sev` of that band; `{cover: 0, sev: 0}` for null, outside the square, or outside every band's `lo…hi`.
- `demoSky`: the mock's scene in real units, laid along `trackDeg` from the given place: scattered small cumulus (bases about 1,500 m) from 0 to 40 km ahead and to the sides; a rain layer 7,000–8,700 m from 50 to 76 km ahead (sev 1, a deck of overlapping puffs); a thunderstorm 100 km ahead on the track (a tower of puffs from 1,000 m to 11,000 m, sev 2 outside and 3 in its core, an anvil on top); a second storm 25 km left of the track at 88 km; and one SIGMET (hazard `TS`, qualifier as the app's data uses for "embedded thunderstorms": read `shared/wx.ts` and `wxText.ts` for the real field values, top 34,000 ft, no base) whose ring is a five-corner polygon round both storms, starting 80 km ahead. Seeded, so the same call gives the same sky. Reuse cloudField.ts's own tower builder if it can be called for a made-up layer; otherwise build the puffs directly.

**Tests (write first, see them fail, then implement):** a CB layer's tower puffs carry sev 3, a plain BKN layer's 0, a 45 dBZ radar cell's tower 3 and a 20 dBZ cell's deck 1; `buildField` puts one spec at the centre texel of the right band with cover > 0.9 and the spec's base and top, and nothing 20 km away; two overlapping deck puffs give cover above either alone; `sampleField` is > 0.5 mid-cloud, 0 above the top and below the base, 0 outside the square; `fieldAtlas` writes the centre texel's bytes at the right tile and offset; `demoSky` is deterministic and has a sev-3 spec about 100 km along the track and a ring that contains it.

- [ ] Tests written and failing for the right reason
- [ ] Implementation; the three test files pass; `tsc` clean
- [ ] Commit

### Task 2: The volume pass (clouds)

**Files:** create `client/scene/cloudVolume.ts`, `cloudVolume.test.ts`; modify `client/scene/weather3d.ts`, `weather3d.test.ts`.

**Consumes:** Task 1's `buildField`, `fieldAtlas`, `WxField`, `demoSky`. **Produces:**

```ts
// cloudVolume.ts
export type CloudLook = 'natural' | 'severity' | 'blocks'
export class CloudVolume {
  constructor(scene: Scene, opts?: { geoid?: (lat: number, lon: number) => number })
  get show(): boolean; set show(on: boolean)
  look: CloudLook
  get field(): WxField | null
  draw(specs: readonly CloudSpec[], at: { lat: number; lon: number }): void // builds the field and uploads it
  frame(tf: TerrainFrame, night: number): void
  fade(from: Cartesian3): void   // the aircraft: the reach's fade is centred on it
  destroy(): void
}
// weather3d.ts
export interface Weather3DOptions { /* …existing… */ demo?: boolean } // ?wxdemo=1
class Weather3D { set look(l: CloudLook); get look(): CloudLook; get field(): WxField | null }
export function parseWxDemo(search: string): boolean
```

**Behaviour:**

- `Sky.clouds` becomes `{ show; draw(specs, at); frame; fade; destroy }`; `cesiumSky` builds a `CloudVolume` in place of `CloudLayer`, and the rain shafts are no longer drawn (the pass draws the rain: below). Leave `cloudLayer.ts` and `rainShafts.ts` in the tree, unused, with one `// ponytail:` line in `cesiumSky` saying they are kept until the user has accepted the volumes; do not delete their tests.
- With `demo`, Weather3D asks no upstream weather at all: its clouds are `demoSky(...)`'s specs and its SIGMETs `demoSky(...)`'s, laid out once from the aircraft's first position and track. Weather3D's `update()` has no track today: add an optional `trackDeg` to its `Aircraft` and pass `chased.trackDeg ?? chased.headingDeg` from `app.ts`.
- The pass is a `PostProcessStageComposite` of two stages: the march at `textureScale: 0.5`, then a full-resolution mix that lays the march's premultiplied colour over the scene (`inputPreviousStageTexture: false`; the mix reads the march by a uniform whose value is the march stage's name). `groundFog.ts` shows the depth read-back that works in this app (`czm_windowToEyeCoordinates(gl_FragCoord.xy, depth)`, depth ≥ 1 is the sky): copy it. Work in a local east-north-up frame at the field's centre: each frame JS gives the shader `u_eyeToLocal` (the frame's inverse times `camera.inverseViewMatrix`, computed in doubles) so the shader has no large numbers; a point's height is `p.z + dot(p.xy, p.xy) / (2 R)`.
- Uniform textures: the field atlas as `ImageData` (set on `stage.uniforms` again after each `draw`; Cesium uploads an `ImageData` uniform as a texture, default sampler linear and clamped; its default `flipY` is true, so check which way is north in a shot); a noise atlas built once (the mock builds a 32³ smoothed random volume: pack its 32 slices as tiles of one 2-D image and sample two slices for the third axis; clamp to the tile's inside so bilinear does not bleed).
- Density at a point: for each band whose `lo…hi` holds the point's height, `cov·profile(h, base, top)`; the largest wins and gives the severity; then the mock's domain warp and noise erosion. Steps: the mock's (small in cloud, long outside, jittered, straight to the slab when outside every band's heights, stop at the depth buffer's hit and at alpha 0.985), at most 96.
- No clearing round the aircraft: it must fade as it enters cloud and be gone in thick cloud (the user's requirement). Extinction as the mock (about 7 per km, 11 in storms).
- Looks: `natural` (sunlit white to shadowed blue-grey by two samples towards the light, darker with severity), `severity` (the same, tinted by the severity colour from sev 0.5 up), `blocks` (cells of 1 km × 1 km × 500 m of height; a cell is filled when the field's cover at its centre is above 0.28; solid faces shaded by which way they face, thin darker edges, the severity colour; a camera inside a filled body sees a mist of its colour, as the mock's `fogLen`). For blocks, march with steps of at most a quarter cell near the camera, and when a sample first lands in a filled cell bisect back to the face; the mock's exact grid walk does not carry over to a curved Earth, so do not port it.
- Rain: under a texel with sev ≥ 1, from its base down to the ground, a thin veil (about a tenth of the cloud's extinction, streaked along the vertical) in the look's colour.
- Ground shadows, in the mix stage: for a pixel that is ground (depth < 1), each band's cover at the place the light's ray from that pixel meets the band's `lo` darkens it (up to about 50 %). The light's direction is `czm_lightDirectionWC` turned into the local frame.
- Night: `frame(tf, night)` dims the cloud's light as `cloudField.ts sunBrightness(night)` did for the puffs. Relief: `// ponytail:` the clouds stand at their true heights when the relief is flattened; say so in the header.
- The reach: cover fades to nothing between 130 and 150 km from the aircraft (`fade(from)` gives its place).
- No stage in the scene while hidden, while the field is `empty`, or after `destroy()` (Task 3 adds: and no hazard edge or aid to draw).
- Check aids: `?wxlook=natural|severity|blocks` sets the look at start (read in `app.ts` beside `parseWxAt`); `window.weather3d.look = '…'` in the console.

**Pure, tested in Node:** the shader's source is a template string; export the helpers it mirrors (`tileUv`, the eye-to-local matrix builder given a camera inverse-view and a centre) and test them; test that `show = false`, an empty field and `destroy()` leave no stage (a fake `postProcessStages` with `add`/`remove`, as `groundFog.test.ts` does); test Weather3D's `demo` asks no URL and hands the volume the demo specs; keep the existing weather3d tests green (their fake sky's `draw` gains the second argument).

**Visual acceptance (omarchy, demo sky), all three looks:** from `0,-12,250` the cumulus ahead read as 3-D bodies with shadows on the ground; `35,-22,6000` shows the rain layer and the storm as volumes, the storm with its anvil; with the camera `0,-12,600` and the aircraft inside the rain layer the aircraft is faint or gone; `20,-38,45000` shows the whole sky; no hard square or tile seam anywhere; no pixel blocks (the user's complaint about the old puffs). Report the frame time with the pass on and off: `eval` in a QA run is not available, so add the numbers to the page title or a `console.warn` once (the QA driver prints console warnings) behind `?bench=1`, which the app already has.

- [ ] Pure helpers and stage-lifecycle tests written and failing
- [ ] `CloudVolume` and the Weather3D wiring; tests pass; `tsc` clean
- [ ] Visual acceptance on omarchy, shots kept in the out-dir and listed in the report
- [ ] Commit

### Task 3: Hazard edges, level slice, track line (in the pass) and ground footprints

**Files:** modify `client/scene/cloudVolume.ts`, `cloudVolume.test.ts`, `client/scene/weather3d.ts`, `weather3d.test.ts`; create `client/scene/wxAhead.ts`, `wxAhead.test.ts`.

**Consumes:** `CloudVolume`, `WxField`, `sampleField`, wxGeo.ts's `Hazard`, `inRing`. **Produces:**

```ts
// wxAhead.ts (pure)
export const AHEAD_MIN = 6
export interface AheadPoint { lat: number; lon: number; altM: number }
export interface AheadPath { points: AheadPoint[]; kmPerMin: number } // the aircraft now, then each minute to AHEAD_MIN
export function aheadPath(a: AheadPoint, trackDeg: number, gsKt: number, vsFpm: number): AheadPath | null // null under 40 kt
// cloudVolume.ts
export type HazardStyle = 'curtain' | 'fence' | 'box'
class CloudVolume {
  setHazards(hazards: readonly Hazard[], style: HazardStyle, color: (h: Hazard) => string): void
  setAhead(path: AheadPath | null, show: { track: boolean; slice: boolean }): void
}
// weather3d.ts
class Weather3D { hazardStyle: HazardStyle; setAhead(path: AheadPath | null, show: { track: boolean; slice: boolean }): void }
```

**Behaviour:**

- `aheadPath`: great-circle steps along `trackDeg` at `gsKt`, the height changing by `vsFpm` each minute, never below 0.
- Hazard edges are drawn by the march, not by Cesium entities, so they sort with the cloud (an entity drawn before the pass would be painted over by any cloud behind it). The edges nearest the aircraft, at most 48, go to the shader in the local frame (two ends, base, top, colour). Uniform arrays through `PostProcessStage.uniforms` are untried in this app: try them first; if Cesium refuses them, pack the edges into a small `ImageData` (two bytes a coordinate) and read it with `texelFetch`.
  - `curtain`: a line at the top height and one at the base, and between them a veil strongest at the top, gone by a quarter of the way up from the base, with faint vertical pleats every 2 km.
  - `fence`: a line at the top and at the base, and a post every 4 km.
  - `box`: today's look (faint fill on every wall and on the top face, lines at the edges). Weather3D's entity volumes (`#drawVolumes`) go: the pass draws all three styles.
- Ground footprint for `curtain` and `fence`, by Cesium on the ground (it has depth, so cloud covers it rightly): the ring's outline clamped to the ground and a striped fill at low alpha (`StripeMaterialProperty`, the stripes a few km wide whatever the ring's size). None for `box`.
- Level slice (`show.slice`): the mock's: a horizontal cut at the aircraft's height within 60 km, the field's cover there filled in the severity colour with a brighter rim, rings at 10, 20 and 40 km, fading out at the edge.
- Track line (`show.track`): the path's points joined, two pixels wide at any distance, a wider tick at each minute, white-blue in clear air and the severity colour, thicker, where the field's cover at that point is above 0.3. Lines are drawn at half resolution: if they look soft in the shots, raise the march's `textureScale` (measure the cost) or draw the lines in the mix stage; say which you chose and why.
- The stage now stays in the scene while there is cloud, a hazard edge, or an aid to draw.
- The hazard labels (placeLabels layer `hazards`) stay as they are.

**Tests:** `aheadPath` (level, climbing, descending into the ground, slow → null, minute spacing equals `gsKt·1.852/60` km); the edge packing (nearest 48, local coordinates of a known corner); Weather3D hands the volume its hazards when they change and its style when it is set, and draws footprints only for curtain and fence (fake data source, as the existing volume tests do: adapt them).

**Visual acceptance (demo sky):** each style from outside the area (`35,-22,6000` early in the run) and from inside it; the curtain is visible in front of the storm cloud, not painted over; the slice from `20,-38,45000`; the track line from `35,-22,6000` with its ticks, coloured where it enters the rain layer.

- [ ] Tests failing, then passing; `tsc` clean
- [ ] Visual acceptance on omarchy
- [ ] Commit

### Task 4: Status line, inside frame, ahead strip

**Files:** modify `client/scene/wxAhead.ts`, `wxAhead.test.ts`; create `client/ui/wxHud.ts`, `wxHud.css`, `wxHud.test.ts`; modify `client/app.ts`.

**Produces:**

```ts
// wxAhead.ts
export interface AheadStatus {
  cloud: { inside: boolean; sev: number; inMin: number | null }   // inMin: minutes to the first weather on the path; null: none within reach
  hazard: { inside: boolean; inMin: number | null; text: string } | null // the nearest hazard area on the path, its label's words
}
export function aheadStatus(path: AheadPath, field: WxField | null, hazards: readonly Hazard[], label: (h: Hazard) => string): AheadStatus
export interface AheadProfile { cols: number; rows: number; kmAhead: number; topM: number; cover: Float32Array; sev: Float32Array; hazards: { fromKm: number; toKm: number; baseM: number; topM: number }[] }
export function aheadProfile(path: AheadPath, field: WxField | null, hazards: readonly Hazard[]): AheadProfile // 160 × 50 cells, 80 km ahead, 0 … 12,500 m
export function statusWords(s: AheadStatus): { cloud: string; sev: number | null; hazard: string | null } // "In light rain", "Clear air · a thunderstorm in 3 min", "Clear air ahead"; "Inside hazard area · …", "Hazard area in 2 min · …"
// wxHud.ts
export interface WxHudHandle { set(status: AheadStatus | null, profile: AheadProfile | null, path: AheadPath | null, units: Units): void; setStrip(on: boolean): void; destroy(): void }
export function mountWxHud(root: HTMLElement): WxHudHandle
```

**Behaviour:** the mock's status line and strip, in the app's HUD style (read `client/ui/flightFrame.css` and `theme.css` for the cards' glass, type and tokens). The status line sits at the top centre under the search box; the strip under it (not among the frame's movable cards: `// ponytail:` a fixed place; upgrade: a block of the flight-data frame). An inset red frame round the view while the aircraft is inside a hazard area and under its top. Heights on the strip in the frame's units (`Units.alt`). `app.ts` computes the path each frame from the chased `RenderState` (`trackDeg ?? headingDeg`, `gsKt`, `vsFpm`), hands it to `weather3d.setAhead`, and four times a second works out the status and profile and hands them to the HUD. Hidden with the weather; nothing computed then. The minute labels on the track line ("1 min" …) go through `placeLabels.setLayer('ahead', …)` only while the track line shows.

**Tests:** `aheadStatus` on a field with one cloud on the path (inside, ahead by N minutes, none) and a hazard ring (inside and under the top, inside but above the top is not inside, ahead); `aheadProfile`'s cells against `sampleField`; `statusWords` for each case; `wxHud` with the repo's DOM test approach (see `client/ui/sceneToggles.test.ts`).

**Visual acceptance:** the HUD at 1440 × 900 and at a phone size (`size 390 844 2 mobile` needs a second driver run: the QA script takes one size; add an optional `SIZE` env to `qa-remote.sh`), clear of the search box, the flight card and the frame's cards.

- [ ] Tests failing, then passing; `tsc` clean
- [ ] Visual acceptance on omarchy
- [ ] Commit

### Task 5: The Weather menu

**Files:** create `client/ui/wxPrefs.ts`, `wxPrefs.test.ts`, `client/ui/wxMenu.ts`, `wxMenu.css`, `wxMenu.test.ts`; modify `client/app.ts`, `client/ui/rail.ts`/`rail.css` only if a second square under the rail needs it, `README.md` (the weather section).

**Produces:**

```ts
// wxPrefs.ts
export interface WxPrefs { look: CloudLook; hazard: HazardStyle; track: boolean; slice: boolean; strip: boolean }
export const DEFAULT_WX_PREFS: WxPrefs // severity, curtain, track on, slice off, strip on
export const WX_PREFS_KEY = 'fh.wx3d.v1'
export function readWxPrefs(search: string, stored: string | null): WxPrefs // URL (?wxlook, ?wxhaz, ?wxtrack, ?wxslice, ?wxstrip) > stored > defaults; never throws
export function writeWxPrefs(p: WxPrefs, storage: Pick<Storage, 'setItem'> | null): void
// wxMenu.ts
export function mountWxMenu(root: HTMLElement, opts: { prefs: WxPrefs; onChange(next: WxPrefs): void }): { update(p: WxPrefs): void; destroy(): void }
```

**Behaviour:** a rail item `weather` (icon `cloud`, label "Weather: clouds, hazard areas, looking ahead", short "Weather") as a square of its own just under the Layers square, shown only while the chase's weather is drawn (`weather3d.show`), hidden otherwise. Its panel "Weather": **Clouds** (segmented: Natural · Severity colours · Blocks) with the four-colour legend under it; **Hazard areas** (Curtain · Fence · Box); **Looking ahead** (switch rows as the Layers panel's, each with a hint: Track line "The next six minutes on this heading"; Level slice "The weather at the aircraft's own altitude"; Ahead strip "Side view of the next 80 km"). Reuse the Layers panel's classes (`fh-seg`, `fh-seg-b`, `fh-scene-row`, `fh-switch`, `fh-scene-head`) so it looks the same. A choice applies at once (`weather3d.look`, `.hazardStyle`, `setAhead`'s flags, `wxHud.setStrip`) and is stored. The panel opens by itself when the user turns Weather on in a live chase (the Layers switch or the W key), not at page load with it already on. Task 2's `?wxlook` reading moves into `readWxPrefs`.

**Tests:** `readWxPrefs` (URL wins, corrupt JSON, unknown values fall back), `writeWxPrefs`; the menu's clicks call `onChange` with the right prefs and `update` moves the pressed states.

**Visual acceptance:** the panel open at 1440 × 900 and as a sheet at phone size; each choice changes the view (one shot per look and per hazard style through the URL aids).

- [ ] Tests failing, then passing; `tsc` clean
- [ ] Visual acceptance on omarchy
- [ ] README's weather section says what the menu offers
- [ ] Commit

### Task 6 (the controller's): whole-branch review, full tests on omarchy, merge to local main

Full `npm run check` on omarchy in `~/flighthopper-wxlab-qa` (never on the Mac); a last set of shots; fast-forward local `main`; no push.

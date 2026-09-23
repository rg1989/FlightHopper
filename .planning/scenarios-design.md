<!-- .planning/scenarios-design.md -->
# Scenarios: recorded-flight playback, first scenario JAL 123 (12 Aug 1985)

Status: design approved by the user 2026-09-23. Branch `feat/scenarios`, worktree `../FlightHopper-scenarios`.
Research behind it: `.planning/reports/scenarios/` (9 discovery reports; sources with URLs).

## 1. What the user asked for, and what they decided

- A **Scenarios** entry (rail button + panel) to play a pre-recorded scenario. First scenario: Japan Air Lines 123,
  Boeing 747SR-46 JA8119, Haneda → Itami, 12 Aug 1985. 524 aboard, 520 died, 4 survived.
- While a scenario plays: **only this aircraft** is drawn; **chase mode only**; a **timeline** to play, pause and drag
  back and forth. The aircraft moves as a function of scenario time: pause freezes it, a drag jumps it to that second,
  play carries on from there. **The camera stays free at all times** (orbit, zoom, playing or paused).
- The aircraft flies the documented manoeuvres **as precisely as the record allows**. It wears its **1985 livery**.
- Cockpit voice recorder (CVR) and radio lines as **English captions with who speaks to whom**; the CVR **audio** plays
  along when a trustworthy copy is available (user: "try to find a copy… confirmed by the actual real transcript…
  if you cannot find it, the captions are sufficient").
- A **frame around the chased aircraft** (corner brackets, the traffic style) with a flight-data readout around it:
  altitude, vertical speed, speeds, wind, attitude and whatever else explains what the aircraft is doing. It must look
  right at every zoom. **It shows in live chase too** (user decision): there it shows what ADS-B broadcasts.
- A **reusable scenario format** and a written interface: what to send for the next scenario, what is not needed.

Decisions (2026-09-23):

| Topic | Decision |
|---|---|
| Ending | Fade to dark and silence while the aircraft is still in the air, **before the first tree strike (≈18:56:23)**; then a memorial card. No impact, fire or crash sound is ever drawn or played. |
| Audio | Search for a copy; show the user file, source and size before any download; verify against the official record; keep it out of git (the repo is public). Captions alone if none is trustworthy. |
| Fin logo | JAL's crane is not free-licensed (live trademark; user rule: free-licensed logos only). Draw it locally, **git-ignored**; without the file the fin is plain white. |
| Downloads | English report `JA8119-en.pdf` (57.7 MB) approved and fetched to `.work/jal123/sources/`. The report appendix (付録, 18.1 MB) was **not** approved: do not download it. |
| Frame scope | Live chase and scenarios, one shared component. |

## 2. Architecture

Scenarios run **entirely in the client from static files** (`public/scenarios/`). The server replay path cannot carry
pitch or roll (roll is clamped to ±35°, pitch is synthesised), cannot seek backwards and adds ≈16 s of delay, so it is
not used. The scenario reuses the app's chase camera, per-type model, livery shader, terrain, sun and moon.

```
public/scenarios/<id>/  ──fetch──▶ loadScenario() ──▶ Scenario (validated, typed)
                                                        │
ScenarioClock (t, playing, rate) ──t──▶ PoseTrack.stateAt(t) ──▶ RenderState ─▶ ChaseModel / ChaseCamera (app.frame)
                                   ├──▶ captionsAt(t)        ──▶ captions overlay
                                   ├──▶ stateOf(events, t)   ──▶ gear, damage, flaps, phase label
                                   ├──▶ flightDataAt(t)      ──▶ FlightFrame (the readout around the brackets)
                                   ├──▶ tUtcMs(t)            ──▶ Sun.update (1985 sky)
                                   └──▶ AudioSync(t)         ──▶ <audio> (optional)
```

In scenario mode the app: stops polling (no `/api/view`, no `/api/chase`), draws no fleet icons, no traffic, no
list; hides the flight card; forces chase; hides 3-D buildings (they are modern); adds the scenario's era imagery
layers; writes `?scenario=<id>&t=<s>` to the URL (not `hex`/`chase`).

## 3. Scenario package format, version 1 (the contract)

```
public/scenarios/index.json            {"scenarios": ["jal123"]}
public/scenarios/<id>/scenario.json    manifest (required)
public/scenarios/<id>/track.csv        timed pose (required)
public/scenarios/<id>/events.csv       discrete events (optional)
public/scenarios/<id>/transcript.csv   captions (optional)
public/scenarios/<id>/livery/…         decals committed with the scenario (optional)
public/scenarios/<id>/local/…          git-ignored: files that must not be published (logo, audio). Optional.
```

All text is UTF-8. CSV is RFC 4180 (header row; quotes for fields with commas, quotes or newlines). Unknown columns
are an error unless they start with `x_`. Empty cell = unknown.

### 3.1 Time

Every time in the package is a **local clock string** `HH:MM:SS` or `HH:MM:SS.s…` on `date` in `utcOffset`. Hours may
exceed 23 for a scenario that crosses midnight (`24:05:00` is 00:05 the next day). Internally the loader turns each
into `t`, seconds since `date 00:00` local, and `tUtcMs(t) = Date.UTC(date) + t·1000 − offset`. Times in a file are
non-decreasing (track: strictly increasing).

### 3.2 scenario.json

```jsonc
{
  "format": 1,
  "id": "jal123",                                  // = folder name
  "title": "Japan Air Lines Flight 123",
  "subtitle": "Tokyo Haneda → Osaka Itami",
  "date": "1985-08-12", "utcOffset": "+09:00", "clockLabel": "JST",
  "start": "18:11:15",                             // playback starts here
  "end": "18:56:28",                               // last second of data the timeline reaches
  "note": "A reconstruction of a real accident in which 520 people died. It ends before the impact.",
  "summary": ["…", "…"],                           // short lines for the scenario card
  "crew": [{ "role": "Captain", "name": "Masami Takahama", "detail": "instructor, right seat" }],
  "aircraft": {
    "registration": "JA8119", "type": "Boeing 747SR-46", "callsign": "JAL123", "operator": "Japan Air Lines",
    "model": "b744",                               // id in public/models/manifest.json
    "shape": { "halfSpanM": 29.8 },                // optional: fold wing tips (and winglets) in to this half-span
    "livery": {                                    // colours are sRGB hex; decal paths are relative to the scenario folder
      "base": "#f4f4f1", "belly": "#bfc3c7", "fin": "#f4f4f1", "engine": "#b9bdc1",
      "body": "livery/body.png",                   // optional body-wrap decal (§6.2)
      "finLogo": "local/fin.png"                   // optional; a missing file = no logo, never an error
    }
  },
  "speakers": {                                    // every code used in transcript.csv speaker/to
    "CAP": { "name": "Captain", "kind": "crew" },  // kind: crew | cabin | atc | company | alert | other
    "ACC": { "name": "Tokyo Control", "kind": "atc" }
  },
  "imagery": [                                     // optional era imagery, drawn over the base map while it plays
    { "url": "https://cyberjapandata.gsi.go.jp/xyz/gazo3/{z}/{x}/{y}.jpg", "rect": [139.70, 35.45, 139.90, 35.62],
      "minZoom": 10, "maxZoom": 17, "credit": "GSI Japan, aerial photographs 1984–1986" }
  ],
  "ending": {                                      // optional
    "fadeFrom": "18:56:17", "darkAt": "18:56:22",  // picture and sound fade over this span
    "cardAfterS": 5,                               // seconds of dark silence before the card
    "card": { "title": "…", "lines": ["…"] }
  },
  "audio": {                                       // optional; a missing file = captions only
    "file": "local/cvr.m4a", "source": "…provenance…",
    "clips": [{ "from": 0.0, "to": 312.4, "at": "18:24:12.0" }]   // file seconds [from,to) play at scenario time `at`
  },
  "sources": [{ "id": "R", "title": "AAIC report (1987)", "url": "https://…" }]
}
```

### 3.3 track.csv

| Column | Required | Meaning |
|---|---|---|
| `time` | yes | local clock (§3.1), strictly increasing |
| `lat`, `lon` | yes | WGS84 degrees |
| `alt_ft` | yes | true altitude above mean sea level, feet (not pressure altitude) |
| `hdg` | yes | **true** heading of the nose, degrees 0–360 |
| `pitch` | yes | degrees, nose up + |
| `roll` | yes | degrees, right wing down + |
| `gnd` | no | 1 = wheels on the ground (take-off roll); the app puts the wheels on the terrain |
| `ias_kt`, `gs_kt`, `vs_fpm` | no | airspeed, ground speed, vertical speed. Missing `gs_kt`/`vs_fpm` are derived from the path |
| `g` | no | vertical load factor |
| `wind_dir`, `wind_kt` | no | wind **from** (true degrees) and speed |
| `epr1`…`epr4` | no | engine pressure ratio per engine (thrust); any engine count 1–4 |
| `q` | no | quality: `A` documented value, `M` measured from an official chart/figure, `R` reconstructed/modelled |
| `src` | no | a `sources[].id`, with an optional page: `R:p.281` |

Rows may be irregular. **Where the aircraft manoeuvres, rows must be dense enough to carry the motion: ≥ 1 per
second** (JAL 123's Dutch roll has an ≈11 s period).

### 3.4 events.csv

`time,type,value,label,src`

| type | value | effect |
|---|---|---|
| `phase` | — | the label shown in the play bar from this time on (a chapter) |
| `mark` | — | a tick on the timeline with this label |
| `gear` | `1` down / `0` up | gear model shown/hidden; frame shows GEAR DN |
| `flaps` | units (number) | frame shows FLAPS n |
| `damage` | `fin` | from this time the model lacks the upper fin, rudder and tail cone (§6.3) |

### 3.5 transcript.csv

`time,dur,speaker,to,channel,lang,text,original,q,src`

- `time`: when the line starts. `dur`: seconds on screen (empty: estimated from length, 2.5–8 s).
- `speaker`: a code from `speakers`. `to`: a code, or empty for "to anyone listening" (PA, guard calls).
- `channel`: `cockpit` | `radio` | `company` | `cabin` | `interphone` | `alert` (GPWS, stall warning).
- `lang`: the language actually spoken (`en`, `ja`, …). `text`: the English caption. `original`: the words as spoken
  when not English (optional).
- `q`: `D` = the official record, verbatim, including its official English translation · `T` = our translation of the
  official original (marked on screen) · `U` = the record marks it unintelligible (text is `[unintelligible]`).
- Never fill an unintelligible passage from unofficial versions.

### 3.6 Validation

`loadScenario(id)` fetches and validates everything and throws one `ScenarioError` listing every problem (file, row,
column). Errors: missing required file/column, unknown column, bad number/time, times out of order, a row outside
`start`–`end` (+ the card), unknown speaker/source/model id, lat/lon/angles out of range. The loader never fetches
`local/` files eagerly; it probes them (`HEAD`) and treats a miss as "absent". A Node test validates every package
under `public/scenarios/` (so a broken package fails `npm test`).

## 4. Runtime modules

Pure modules take no DOM and no Cesium viewer, and have unit tests. File ownership matters: parallel agents edit only
their own files.

| File | Exports | Notes |
|---|---|---|
| `client/scenario/csv.ts` | `parseCsv(text): string[][]` | RFC 4180, ~40 lines |
| `client/scenario/format.ts` | types `Scenario, TrackRow, EventRow, Line, SpeakerDef…`; `parseScenario(files): Scenario`; `loadScenario(base, id, fetcher?)`; `ScenarioError`; `clockToS`, `sToClock` | validation per §3.6 |
| `client/scenario/pose.ts` | `class PoseTrack { constructor(rows, geoid); stateAt(t): RenderState; dataAt(t): FlightData }` | Catmull-Rom (centripetal) on lat, lon, alt; unwrapped heading; pitch, roll. Binary search. `hM = alt·0.3048 + N(lat,lon)`. `RenderState` gets `mode:'interp', ageS:0, quality:'adsb2', onGround: gnd` |
| `client/scenario/clock.ts` | `class ScenarioClock { t; playing; rate; tick(dtS); seek(t); play(); pause(); setRate(r) }` | clamps to [start, end]; stops at end; rates 1, 2, 4, 8, 16 |
| `client/scenario/timeline.ts` | `captionsAt(lines, t, max=3)`, `eventStateAt(events, t)` → `{phase, gear, flaps, damage}`, `marks(events)`, `endingAt(ending, t)` → `{fade: 0..1, card: boolean}` | pure |
| `client/scenario/audio.ts` | `class AudioSync { constructor(el, clips); update(t, playing, rate, gain) }` | plays only at rate 1; seeks when off by > 0.25 s; silent outside clips |
| `client/scenario/run.ts` | `class ScenarioRun { static start(viewer, scn, ui): …; frame(dtS): ScenarioFrame; destroy() }` | owns clock, pose, UI handles, audio, imagery layers |
| `client/scene/flightFrame.ts` | `class FlightFrame { constructor(layer); update(viewer, box, data: FlightData \| null); destroy() }`; pure `frameLayout(square, blocks, viewport)` | §5 |
| `client/ui/scenarioPanel.ts` (+ .css) | `mountScenarioPanel(body, {onPlay})` | the rail panel: cards from index.json |
| `client/ui/playbar.ts` (+ .css) | `mountPlaybar(root, {…})` | play/pause, scrubber with marks, speed, clock, phase, exit |
| `client/ui/captions.ts` (+ .css) | `mountCaptions(root)` → `update(lines)` | textContent only, never HTML |
| `client/ui/memorial.ts` (+ .css) | `mountEnding(root)` → `update(fade, card)` | the fade veil and the card |

**`FlightData`** (in `client/types.ts`; every field nullable, null = not shown):
`altFt, aglFt, vsFpm, iasKt, gsKt, hdgDeg, trackDeg, pitchDeg, rollDeg, g, windFromDeg, windKt, gear ('up'|'down'),
flaps, epr (number[]), derived (Set of field names that are estimates, shown dimmer)`.
- Scenario: from `PoseTrack.dataAt(t)` + `eventStateAt` + `aglFt = hM − ground` (the app knows the ground).
- Live chase: from `RenderState` and the chase reply's `ReadsbAircraft`: `alt_baro`, `baro_rate`/vs, `gs`, `track`,
  `ias`, `true_heading`, `roll` (only when broadcast), `wd`/`ws`. Pitch is not shown live (it is synthesised).

**Model and livery changes** (`client/scene/livery.ts`, `model.ts`, `types.ts`):
- `Livery` may carry decal URLs: `bodyUrl`, `finUrl`, `titleUrl` (a scenario passes absolute URLs; table liveries keep
  building theirs from the code). `LiveryShaders.custom(key, livery)` caches by key.
- `Paint` gains `body?: [zNose, zTail, yBottom, yTop]`: the box the body-wrap decal covers (side projection, as the
  title). b744's is measured from the GLB.
- Every livery shader gets uniforms `u_span` (float; 0 = off) and `u_cut` (vec4; x = on) with default off. The vertex
  shader folds vertices with |x| > u_span to ±u_span and clamps their y to the wing plane (winglets vanish, span
  shortens); the fragment shader discards the damaged parts when `u_cut.x > 0.5` (§6.3).
  `ChaseModel.setShape(halfSpanM | null)` and `ChaseModel.setDamage(on)` set them on the current shader.
- Gear: a manifest entry may name `gear: "models/<id>-gear.glb"`. `ChaseModel.setGear(on)` loads it once and draws it
  with the chase model's matrix. `public/models/b744-gear.glb` is generated by a script (boxes and cylinders, a few
  hundred triangles, raw b744 frame).

**App (`client/app.ts`) hooks, kept small:** a `scenario: ScenarioRun | null`; `frame()` takes `s` and the sun time from
it; the poll loop sleeps while it is set; Esc closes a panel, then exits the scenario; `syncUrl` writes the scenario
keys; the rail gets `{ id: 'scenarios', icon: 'film', label: 'Scenarios', short: 'Scenes', group: 2 }` before About;
`?scenario=<id>&t=<s>` starts one on load (paused at `t`). About lists the scenario's sources and imagery credit.

**Server (`server/main.ts`)**: add MIME types for `.csv .m4a .mp3 .ogg .opus .wav` and HTTP Range (206) for static
files, so audio can seek from the built `dist/` as it does in Vite dev.

## 5. The flight-data frame

- Two corner brackets (top-right, bottom-left), exactly the traffic style (`.fh-bracket`), sized to the chased model on
  screen from the manifest `box` (projected like `traffic.ts`: `squarePx`). No name, no distance. No click action.
- Blocks placed around the square, fixed pixel size (they do not scale with zoom):
  - **left** (right-aligned against the square): altitude (large), height above ground, vertical speed with ↑/↓;
  - **right** (left-aligned): IAS, GS; the thrust bars (one per engine, EPR) under them;
  - **top**: heading and a wind dial (a small circle, nose up; the arrow shows where the wind comes from relative to
    the nose) with direction/speed;
  - **bottom**: bank and pitch (a small horizon glyph that rolls and pitches) and g; chips for GEAR DN and FLAPS n.
- Layout is pure (`frameLayout`): blocks hug the square with a gap; each block is clamped inside the safe area (the
  viewport minus the rail, the play bar and the captions); when the square outgrows the safe area, the blocks pin to its
  corners. Blocks never overlap each other.
- Positions update every frame through `transform`; text at ≤ 10 Hz. Tabular numbers, the app's tokens, a light
  glass chip behind each block (no backdrop blur), legible over bright imagery and night.
- Units: ft, ft/min, kt, degrees, g. Estimated values (`derived`) render at 60 % opacity.
- Layer `.fh-frame` at z 6: over the traffic brackets, under every panel.

## 6. JAL 123 content

### 6.1 Track (tools/scenarios/jal123/, Python + OpenCV; inputs in `.work/jal123/sources/`, git-ignored)

1. **Digitize** the official DFDR charts (report part 11, `62-2-JA8119-11.pdf`, DFDR図-1…6) at 1 Hz, 18:11:32–18:56:28:
   heading (magnetic), CAS, pressure altitude, roll, pitch, vertical g, EPR 1–4, and AOA where charted. Check against
   the official observations (Attachment 5): min CAS 108 kt at 18:49:42 with AOA 30.9°, min altitude ≈5,300 ft at
   ≈18:49, PCH ≈36° down and RLL ≈70° R at 18:56:07, RLL ±40° Dutch roll 18:26–18:31, 3 g at 18:56:18–23.
2. **Winds and temperatures** aloft for 1985-08-12 from the Tateno (47646) and Hamamatsu (47681) soundings (00Z, 12Z)
   → wind and temperature by altitude, interpolated to the time. Magnetic declination at 1985.6 for the area (IGRF).
3. **Reconstruct the path**: TAS from CAS + pressure altitude + temperature; true heading; dead reckoning with the
   wind; a smooth position correction (spline in time) that passes through the anchors within their tolerance:
   runway 15L of 1985 (traced from GSI 1984–86 aerial photographs), the report's flight-path map (付図-1) labels, the
   failure point (34.761 N 139.100 E ± 0.5 km), the ATC fixes, and at the end the larch (35.9951 N 138.7048 E, ground
   1,530 m), the U-shaped groove (35.9976 N 138.6995 E, 1,610 m) and the ridge (36.0010 N 138.6943 E, 1,565 m).
   True altitude from pressure altitude with the sounding temperatures and QNH, tied to those ground points.
4. **Check**: the observations above; no terrain within 30 m of the aircraft until 18:56:22 (GSI elevation);
   ground speed and heading consistent with the path; the final 360° right turn (18:54:55–18:56:18) present.
5. Output `public/scenarios/jal123/track.csv` at 1 Hz (4 Hz in 18:55:30–18:56:28) with `q` and `src` per row.

The dossier's own track and attitude columns are not used (10–30 km off on most legs; synthetic attitude).

### 6.2 Livery

From photos of JA8119 (Haneda 3 Mar 1985; Itami 1984; Wikimedia Commons, CC BY-SA; reference only, not shipped):
white `#F4F4F1` upper body; a thin red pinstripe `#C80019` over a navy band `#1C2451` that holds the cabin windows,
nose to tail cone, not up the fin; "JAPAN AIR LINES" in black bold sans capitals on the main deck from behind door L1
to the wing root; a small red sun disc behind L1; "JA8119" small black between L4 and L5; aluminium belly `#BFC3C7`;
grey wings `#A6AAAD`; metallic nacelles `#B9BDC1`. `livery/body.png` (drawn by a script from this spec) carries
stripes, titles, disc and registration; `local/fin.png` carries the crane (git-ignored).

### 6.3 Damage and configuration

- From 18:24:35 (`damage fin`): about two-thirds of the fin (torsion box and upper leading edge), both rudders and the
  3.4 m tail cone with the APU are gone; the dorsal fillet and the lower leading edge forward of the front spar stay
  (report fig. 27). Fragment discard in the fin region above a jagged line, the rudder chord and the tail cone; back
  faces of the cut drawn dark.
- Gear down from 18:39:32. Flaps (alternate electric) from 18:51:06: 5 units at 18:54:31, 10 at ≈18:54:50, 20 at
  18:55:33, ≈25 at 18:55:42 then retracting: shown in the frame only (the model has no movable flaps).

### 6.4 Transcript

- Timing: the official Japanese CVR record (report part 11, 別添6: one page per minute on a 00–59 s grid) and ATC /
  company records (Attachments 3, 4). Wording: the official English report (`JA8119-en.pdf`, Attachment 6 pp. 293–330,
  Attachments 3–4 pp. 270–274). Cross-check: the JTSB 2011 commentary times gathered in the research (key-line table).
- Captions from the take-off clearance (≈18:11:20) to the last GPWS call before the fade. Cabin PAs: the first of each
  announcement, not every repeat. Traffic between other aircraft and ATC: left out. "Contact sound" lines: left out.
- Radio in Japanese after 18:31:26 → `lang ja`, English caption. Yokota's guard calls stay English.
- Speakers: CAP (captain, right seat, instructor), COP (first officer, left seat, flying), FE, PUR, STH, PRA, ACC,
  APC, YOK, COM, TWR, DEP, GPWS, STALL.

### 6.5 Ending card (text)

Japan Air Lines Flight 123 · 12 August 1985 · Boeing 747SR-46 JA8119, Tokyo Haneda to Osaka Itami.
At 18:56 the aircraft struck the Osutaka Ridge in Ueno Village, Gunma. Of the 524 people aboard, 509 passengers and
15 crew, 520 died. Four survived.
The crew kept the aircraft flying for 32 minutes after its aft pressure bulkhead failed and took all four hydraulic
systems with it.
Every 12 August families and JAL staff climb to the ridge; a moment of silence is held at 18:56.
JAL's Safety Promotion Center at Haneda keeps the wreckage and the lessons of this accident.
Reconstruction from the official report of the Aircraft Accident Investigation Commission (1987).

## 7. Sensitivity rules (hard)

- No impact, fire, wreckage, crash sound or camera view of the ground contact; the veil is fully dark by 18:56:22
  and stays dark to the card; dragging into those seconds shows dark and the clock only.
- Captions only from the official record; `[unintelligible]` where it says so; no fabricated or leaked-audio readings.
- No playful UI: no scores, no "replay" flourish; audio never autoplays (it starts with the user's Play).
- Audio and the crane stay out of git.

## 8. Testing and verification

- Unit tests (node --test) for csv, format (incl. the real package), pose (continuity, heading wrap, 1-Hz Dutch roll kept,
  exact at rows), clock, timeline, audio sync, frame layout (never off-screen, never overlapping, pins when large),
  livery shader text (new uniforms present, defaults off), server Range.
- `tools/scenarios/jal123/check.py`: the track checks of §6.1 step 4; exits non-zero on failure.
- Browser (the Browser pane): play, pause, drag, speed; orbit while paused; the frame at close, mid and far zoom;
  phone viewport 375×812; the take-off on 1985 imagery; the fade and card; live chase frame on a live aircraft.
  Screenshots to the user.

## 9. Not built (ponytail)

- The 747-400's long upper deck and its engines stay (a mesh limit). Movable flaps: the frame shows them instead.
- Clouds and weather: none (the report: decaying scattered cumulus, good visibility).
- 3-D buildings are hidden in scenarios (modern); modern night lights remain.
- No scenario editor or upload: packages are files in `public/scenarios/`.
- No ACMI/KML import or export yet: add when a second scenario arrives in such a format.

<!-- docs/scenarios.md -->
# Scenarios: the package format and what to send

A scenario is a recorded flight that FlightHopper plays back. The app reads it from static files in
`public/scenarios/`. Only that aircraft is drawn, in chase view. A timeline plays, pauses and drags the flight. The
aircraft's position is a function of the scenario clock. Captions show what the crew and ATC said, from the official
record.

This document is for two readers:

- a person who prepares a new scenario, and
- the research agent that collects the data for it.

Part 1 is the package format. Part 2 says what to send and what not to send. Part 3 has the sensitivity rules for
accident scenarios. Part 4 is a prompt to give to a research agent.

The first package is Japan Air Lines Flight 123 (12 August 1985) in `public/scenarios/jal123/`. The scripts that built
it are in `tools/scenarios/jal123/`. Use them as a worked example. The second, Air Astana Flight 1388 (11 November 2018)
in `public/scenarios/kc1388/`, shows a package built from tracking data instead of a flight data recorder: its scripts
are in `tools/scenarios/kc1388/`. The design is in `.planning/scenarios-design.md`.
The loader that checks every rule below is `client/scenario/format.ts`.

## Part 1. The package format (version 1)

### 1.1 Files

```
public/scenarios/index.json            {"scenarios": ["jal123", "<id>"]}   the list the Scenarios panel shows
public/scenarios/<id>/scenario.json    the manifest (required)
public/scenarios/<id>/track.csv        the timed position and attitude (required)
public/scenarios/<id>/events.csv       phases, marks, gear, flaps, damage (optional)
public/scenarios/<id>/transcript.csv   the captions (optional)
public/scenarios/<id>/airport.json     the airfields as they were: runways, flattened ground (optional)
public/scenarios/<id>/livery/…         decal images, committed (optional)
public/scenarios/<id>/local/…          files that must not be published: logos under trademark, audio (optional)
```

- `<id>` is the folder name. It has 1 to 64 letters, digits, `_` or `-`, and starts with a letter or a digit.
- A package appears in the app only when its id is in `index.json`.
- `local/` is git-ignored (`public/scenarios/*/local/` in `.gitignore`). The repository is public. Everything else in
  the folder is published.
- All text is UTF-8. CSV files follow RFC 4180: a header row, and quotes around a field that holds a comma, a quote or
  a line break.
- An unknown column is an error, unless its name starts with `x_`. Use `x_` columns for your own notes. The app
  ignores them.
- An empty cell means "unknown".

### 1.2 Time

Every time in the package is a **local clock time** on the scenario's `date`, in its `utcOffset`: `HH:MM:SS` or
`HH:MM:SS.s`. Hours can go past 23 for a flight that crosses midnight (`24:05:00` is 00:05 the next day).

- The loader turns each time into `t`, the seconds since local midnight of `date`.
- The sun, the moon and the sky come from `date`, the time and `utcOffset`. You do not send them.
- In each file, times do not go backwards. In `track.csv` they must go forwards (no two rows at the same time).
- A link can open a scenario, paused: `/?scenario=jal123&t=66270` opens JAL 123 at 18:24:30 (t = 66,270 s).

### 1.3 scenario.json

The JAL 123 file is a complete example. The fields:

| Field | Required | Meaning |
|---|---|---|
| `format` | yes | Always `1`. |
| `id` | yes | The folder name. |
| `title`, `subtitle` | yes | Shown on the scenario card and the play bar. Example: "Japan Air Lines Flight 123", "Tokyo Haneda → Osaka Itami". |
| `date` | yes | `YYYY-MM-DD`, local date of `start`. |
| `utcOffset` | yes | `+09:00`. The offset in force on that day (check daylight saving time). |
| `clockLabel` | yes | The zone name shown next to the clock, for example `JST`. |
| `start` | yes | The first second of playback. |
| `end` | yes | The last second the timeline reaches. |
| `note` | yes | One or two sentences on the card. For an accident, say that it is a reconstruction, how many people died, and that it ends before the impact. |
| `summary` | no | Short lines for the card: route, aircraft, what happened, where. |
| `crew` | no | `[{ "role", "name", "detail" }]`. Example: Captain, Masami Takahama, "instructor, right seat". |
| `aircraft` | yes | See the next table. |
| `speakers` | no | Every code that `transcript.csv` uses in `speaker` or `to`. See 1.6. |
| `imagery` | no | Imagery of the time, drawn over the base map while the scenario plays. See 1.7. |
| `ending` | no | The fade to dark and the closing card. See 1.8. |
| `audio` | no | A recording that plays with the timeline. See 1.9. |
| `sources` | yes, in practice | `[{ "id", "title", "url", "note" }]`. Every `src` cell names one of these ids. See 1.10. |

`aircraft`:

| Field | Required | Meaning |
|---|---|---|
| `registration`, `type`, `callsign`, `operator` | no | Shown on the card. Example: `JA8119`, `Boeing 747SR-46`, `JAL123`, `Japan Air Lines`. |
| `model` | yes | A model id from `public/models/manifest.json`. Today: `a320 a321 a333 a359 b738 b744 b773 b789 e75l crj9 at75 c550 c182 ec135`. Take the nearest one. |
| `shape.halfSpanM` | no | Folds the wing tips in to this half-span in metres, when the real aircraft is shorter than the model (a 747SR on the 747-400 model: `29.8`). |
| `livery.base`, `belly`, `fin`, `engine` | `base` and `fin` | sRGB hex colours: upper body, lower body, fin, engine nacelles. |
| `livery.body` | no | A body-wrap decal (stripes, titles, registration), path relative to the folder, normally `livery/body.png`. |
| `livery.finLogo` | no | A fin logo image. Put a logo under trademark in `local/`. If the file is missing, the fin stays plain. |

The body decal, the damage and a separate gear model need measurements of the model. They are in the model's
entry in `public/models/manifest.json` (`paint.body`, `paint.cut`, `gear`). Today `b744` has all three, and `b738` and `b38m` have
`paint.cut`. For another
model, ask for the measurements to be added. That is a code change, not a package change.

### 1.4 track.csv

| Column | Required | Meaning |
|---|---|---|
| `time` | yes | Local clock time. Strictly increasing. |
| `lat`, `lon` | yes | WGS84 degrees. |
| `alt_ft` | yes | **True altitude above mean sea level**, feet. Not pressure altitude: correct it with the QNH and the temperatures of the day. |
| `hdg` | yes | **True** heading of the nose, degrees, 0 to less than 360. Not the track, not magnetic: add the magnetic declination for the date. |
| `pitch` | yes | Degrees, nose up positive, −90 to 90. |
| `roll` | yes | Degrees, right wing down positive, −180 to 180. |
| `gnd` | no | `1` while the wheels are on the ground. The app puts the wheels on the terrain. |
| `ias_kt`, `gs_kt`, `vs_fpm` | no | Airspeed, ground speed, vertical speed. If `gs_kt` or `vs_fpm` is empty, the app derives it from the path and shows it dimmer. |
| `g` | no | Vertical load factor. |
| `wind_dir`, `wind_kt` | no | The wind: the true direction it comes **from**, and its speed. On `q=R` rows the frame shows it dimmer, as an estimate. |
| `epr1` … `epr4` | no | Engine pressure ratio (thrust) per engine. Use as many columns as the aircraft has engines. |
| `q` | no | Quality of the row: `A`, `M` or `R` (see 1.11). |
| `src` | no | A source id with an optional page: `R11:p.5`. |

Rules:

- The first row is at or before `start`. The last row is at or after `end`. At least 2 rows.
- The app draws a smooth curve (a Catmull-Rom spline timed by the rows' own times) that passes exactly through every row.
- Rows can be irregular. **Where the aircraft manoeuvres, give at least 1 row per second.** A Dutch roll with an
  11-second period needs 1 Hz. Straight and level flight can have a row every 10 to 30 s.
- Do not send smoothed or synthetic attitude as if it were measured. Mark it `R`.

### 1.5 events.csv

Columns: `time,type,value,label,src`.

| `type` | `value` | What the app does |
|---|---|---|
| `phase` | empty | The play bar shows `label` from this time on (a chapter). |
| `mark` | empty | A tick on the timeline. Its tooltip is `label` and the time. A click on it jumps there. |
| `gear` | `1` down, `0` up | Shows or hides the landing gear. The flight-data frame shows GEAR DN. |
| `flaps` | a number (flap units) | The frame shows FLAPS n. At 0 the chip goes away. |
| `damage` | `fin`, `rudder:<from>-<to>` | From this time the model has no upper fin, rudder or tail cone (`fin`), or no rudder between two heights given as fractions of the fin, 0 root … 1 tip (`rudder:0.35-0.88`). Models with `paint.cut` only (b744, b738, b38m; see 1.3). |
| `story` | seconds on screen (empty: 12) | A short narrative message, top-left, that fades in at this time and out after its seconds (at least 5 s of real time at any speed). Write `label` as one or two plain sentences: what happens and why it matters. Only facts from the record; cite `src`. |

- Events have no `q` column. When a time is an estimate, say so in `label`, for example "Gear up (not recorded,
  estimated)".
- Put the state at `start` in the file: for example `gear 1` at `start` when the aircraft is on the ground. With no
  `gear` event the gear is up, and with no `flaps` event the frame shows no flaps.
- Several events can have the same time. Keep them in the order you want them applied.
- Mark labels are short and exact. Quote the record's words: “But now uncontrol”.

### 1.6 transcript.csv

Columns: `time,dur,speaker,to,channel,lang,text,original,q,src`.

| Column | Meaning |
|---|---|
| `time` | When the line starts. Several lines can have the same second: they show in file order. |
| `dur` | Seconds on screen. Empty: 1.2 s + 0.06 s per character of `text`, between 2.5 and 8 s. Set it for a long transmission, from the record's own span. |
| `speaker` | A code from `speakers` in `scenario.json`. |
| `to` | The code of the addressee. Empty: to anyone listening (a PA, a call on the guard frequency) or not known. |
| `channel` | `cockpit`, `radio`, `company`, `cabin`, `interphone` or `alert` (warnings: GPWS, stall, horns). |
| `lang` | The language actually spoken: `en`, `ja`, and so on. Empty for a sound or a wholly unintelligible line. |
| `text` | The English caption. |
| `original` | The words as spoken, whenever they are not English. Empty for English and for sounds. |
| `q` | `D`, `T` or `U` (see 1.11). |
| `src` | The source of the **wording**, with a page: `EN:p.300`. |

`speakers` in `scenario.json` gives each code a name and a kind:

```json
"CAP": { "name": "Captain", "kind": "crew" },
"ACC": { "name": "Tokyo Control", "kind": "atc" }
```

- `kind` is one of `crew`, `cabin`, `atc`, `company`, `alert`, `other`.
- The caption head shows "Captain → Tokyo Control · radio".
- For a line whose speaker the record does not identify, use a code such as `UNK` with the name "Unidentified" and
  the kind `other`.
- For the aircraft side of an ATC transcript that names only the flight, use a code such as `JL123` ("JAL 123").
  Do not guess which pilot spoke.
- The app shows up to 3 captions at once. No caption shows once the screen is dark (see 1.8).

What goes into the transcript:

- Every cockpit line, and every radio exchange with the aircraft (ATC and company).
- Warnings (GPWS, stall warning, horns) as `alert` lines, and call chimes such as SELCAL.
- The first complete occurrence of each cabin announcement, not every repeat.
- Lines whose speaker the record does not identify, with the "Unidentified" code.

What stays out: traffic between ATC and other aircraft, repeats that the record marks as the same, contact and
impact sounds, and everything after the screen goes dark.

Timing: when the record lays each minute out on a grid of seconds, `time` is the grid row of the line's first
word. When the record gives only the minute, say so in the source note.

### 1.7 imagery

```json
{ "url": "https://cyberjapandata.gsi.go.jp/xyz/gazo3/{z}/{x}/{y}.jpg", "rect": [139.70, 35.46, 139.84, 35.62],
  "minZoom": 10, "maxZoom": 17, "credit": "GSI Japan, aerial photographs 1984–1986" }
```

- `url` is an XYZ tile template. `rect` is `[west, south, east, north]` in degrees.
- The app requests tiles only inside `rect` and only from `minZoom` to `maxZoom`. Closer in, it enlarges the
  `maxZoom` tiles.
- Check the coverage before you send it. Request a few tiles at the corners of `rect` and at each end of the zoom
  range. Keep `rect` inside the area that returns tiles (a missing tile returns HTTP 404).
- Use only imagery whose terms allow this use. Name the terms in the source note.

### 1.8 ending

```json
"ending": { "fadeFrom": "18:56:17", "darkAt": "18:56:22", "cardAfterS": 5,
            "card": { "title": "…", "lines": ["…", "…"] } }
```

- From `fadeFrom` to `darkAt` the picture fades to black. From `darkAt` the screen is dark and shows no captions.
- `cardAfterS` seconds after `darkAt`, the closing card shows: `title` and each line as a paragraph, with one button,
  Close.
- A drag back on the timeline lifts the veil. A drag into the dark seconds shows only dark and the clock.
- For an accident, `darkAt` is before the first contact with the ground or an obstacle (see Part 3).

### 1.9 audio (optional)

```json
"audio": { "file": "local/cvr.m4a", "source": "who recorded it, who published it, where, and how it was checked",
           "clips": [{ "from": 0.0, "to": 312.4, "at": "18:24:12.0" }] }
```

- `clips` maps the file to the scenario clock. File seconds `from` to `to` play at scenario time `at`.
- The file lives in `local/`, so git never publishes it. If the file is missing, the scenario plays with captions
  only. The loader asks the server for the file (`HEAD`) and treats a miss as "no audio".
- The app plays audio only at 1× speed. It seeks when the audio is more than 0.25 s off the clock. It is silent
  outside the clips. It never starts before the user presses Play.
- File types: `.m4a`, `.mp3`, `.ogg`, `.opus`, `.wav`.
- `source` is required. The loader rejects audio without it.
- Before anyone downloads audio: show the file name, the source and the size to the project owner, and wait for a
  yes. Then check each clip against the official transcript. If a copy is edited, re-ordered or of unclear origin,
  do not use it. Captions alone are enough.

### 1.10 Sources and `src` cells

```json
{ "id": "EN", "title": "AAIC report on JA8119 (1987), English edition",
  "url": "https://jtsb.mlit.go.jp/eng-air_report/JA8119.pdf",
  "note": "Pages are PDF page numbers of this file. CVR record: pp. 293–327." }
```

- A `src` cell is an id, optionally with a page: `EN`, `EN:p.300`, `EN:p.312-313`.
- Say in `note` which page numbers you use: the printed numbers or the PDF page numbers. Scanned attachments often
  restart their printed numbers.
- One id per document. If a report is published in parts, give each part its own id (JAL 123: `R05`, `R10`, `R11`).

### 1.11 Quality flags

| Where | Flag | Meaning |
|---|---|---|
| `track.csv` `q` | `A` | A documented value: printed in the record as a number. |
| | `M` | Measured from an official chart or figure. |
| | `R` | Reconstructed or modelled: dead reckoning, a spline between anchors, a smoothed value. |
| `transcript.csv` `q` | `D` | The official record, verbatim, including its official translation and its spelling. |
| | `T` | Our translation of the official original. The caption shows a translation mark (today it reads JA→EN: another language needs a small code change). |
| | `U` | The record marks it unintelligible. `text` is exactly `[unintelligible]`, `lang` and `original` are empty. |
| `transcript.csv` `x_unclear` | `1` | The record marks the reading as uncertain (for example, underlined). The caption does not change. |

- When part of a line is unintelligible, keep `q=D` and write `[unintelligible]` in its place in `text`. Keep the
  record's own mark (`・・・`, `+++`) in `original`.
- Never fill an unintelligible passage from another source.

### 1.11a airport.json (optional)

The airfields the flight uses, when the app's own runways do not show them as they were: one airport, or a list of
them (JAL 123: Haneda in 1985; KC1388: Alverca and Beja). Each is the app's `Airport` shape (`shared/airports.ts`) plus
an optional `flat` list of rings (`{ "ring": [[lat, lon], …], "elevFt": … }`) where the ground is laid flat, and a
`source` note. Every runway end needs `thrHaeM`: its threshold elevation in metres above MSL plus the EGM96 geoid
height (`shared/geoid.ts`). While the scenario plays, the app paints these runways and lays the ground flat along them.

### 1.12 Checking a package

1. Add the id to `public/scenarios/index.json`.
2. Run `node --test client/scenario/format.test.ts`. It loads every package in `index.json` with the app's own
   loader. A broken package fails the test.
3. Run `npm run check` before you commit.
4. Open the app with `/?scenario=<id>` and play the whole flight once.

The loader collects every problem and reports them together, one per line, as `file:row: column: problem`. Example:
`transcript.csv:83: speaker: unknown speaker: "UNK"`.

## Part 2. What to send

### 2.1 Checklist

Send these for a new scenario. The first 5 are needed. The rest make it better.

1. **Identity.** Date, local UTC offset on that day, flight number and callsign, registration, exact aircraft type,
   operator, route.
2. **Time span.** The first and last second to play. For an accident, also the time of the first contact with
   anything (a tree, a building, the ground), from the official report.
3. **Track.** Either a finished `track.csv` (1.4), or the inputs to reconstruct it:
   - The flight data recorder values per second: heading, airspeed, altitude, pitch, roll, vertical g, engine thrust,
     with the chart or table pages.
   - Position fixes with times: radar positions, ATC position reports, map labels in the report, the runway
     threshold, the accident site.
   - The reference of each value: magnetic or true heading, pressure or true altitude, the altimeter setting.
4. **Model.** The nearest model id from 1.3, and the real half-span if it is shorter.
5. **Sources.** Every document with its URL, its title and a note on its page numbers. Primary sources first.
6. **Events.** Phases with a short name, marks for the key moments, gear and flap changes with their times.
7. **Transcript.** The cockpit voice recorder and ATC lines, one row per line, with speaker, addressee, channel,
   language, the original words, the official English and the page. See 1.6 and 1.11.
8. **Livery.** Reference photos of that aircraft near that date (URL and licence of each), the colours as hex, and
   where the stripes, titles and registration are. A logo only if it is free-licensed. Otherwise the fin stays plain,
   or the logo goes to `local/`.
9. **Imagery of the time.** A tile URL, the area, the zoom range, the credit and the terms (1.7). Only if the base map
   would show something misleading, for example a runway that did not exist then.
10. **Weather aloft.** Upper-air soundings near the route for the day: wind and temperature by height. They convert
    pressure altitude to true altitude and add the wind.
11. **Card text.** `note`, `summary`, `crew` and, for an accident, the closing card.
12. **Audio.** Only as described in 1.9. Say where a copy exists. Do not download it.

### 2.2 Not needed

Do not send these. They cost time and the app does not use them.

| Do not send | Why |
|---|---|
| A lighting, sun or moon table | The app computes the sky from the date, time and offset. |
| KML, KMZ, GPX, ACMI or other copies of the track | One `track.csv` is the source. Other formats can be derived from it. |
| Flight-dynamics models, failure-injection specs | The app replays the recorded flight. It does not simulate it. |
| Terrain, weather or sound-design prose | Terrain comes from the map. The app draws no weather. There is no sound design. |
| An alternate-airports table | The app does not use it. |
| Derivable columns: distance to impact, time since start, ground speed or vertical speed next to dense positions | The app derives them. Two copies of one value can disagree. |
| Raw OCR dumps of the report | Cite the page instead. OCR text has errors and is not a source. |
| Screenshots, videos, 3-D models | The app has its own models. Reference photos for the livery are enough. |
| Transcripts from websites, videos or books | Only the official record goes into captions (Part 3). |

## Part 3. Sensitivity rules for accident scenarios

These rules are fixed. They apply to every accident or serious-incident scenario.

1. **End before the impact.** The screen is fully dark (`darkAt`) before the first contact with anything. The app
   never draws or plays an impact, fire, wreckage, a crash sound or a camera view of the ground contact.
2. **Captions from the official record only.** Use the investigating authority's transcript. Keep its words and its
   spelling. Our own translation of the official original is `q=T`.
3. **Unintelligible stays unintelligible.** Where the record says the words cannot be read, the caption is
   `[unintelligible]`. Never fill it from leaked audio, media transcripts or "full transcripts" found online. Some of
   those are fabricated (for JAL 123, see `.planning/reports/scenarios/cvr.md` §1a).
4. **No uncertain speaker guesses.** If the record does not say who spoke, use an "Unidentified" code.
5. **Name the flight crew only.** Do not name passengers or survivors.
6. **Sober wording.** The note says it is a reconstruction, how many people died and that it ends before the impact.
   The card gives facts, remembrance and the source. No adjectives that dramatise.
7. **No playful interface.** No scores, no "replay" button, no share prompt at the end. Audio never starts by itself.
8. **Out of git.** Audio and logos under trademark stay in `local/`.
9. **Check everything against the record.** A time, a quote or a number that only a secondary source gives is
   marked as such in the source note, or left out.

## Part 4. Prompt for a research agent

Copy the text below. Replace the parts in angle brackets.

```text
Research a FlightHopper scenario package for <flight, date, aircraft registration>.
Read docs/scenarios.md in the FlightHopper repository first. It defines every file and column.

Use primary sources first, in this order:
1. The final report of the investigating authority, with all attachments: flight data recorder charts and
   tables, the cockpit voice recorder transcript, ATC and company radio transcripts, the flight-path map,
   the wreckage map. If the report is split into parts, list each part.
2. Later official commentary or re-examinations by the same authority.
3. Government geodata: aerial photographs of the period, elevation data.
4. Upper-air soundings for the day (for example the University of Wyoming archive).
Use secondary sources only to find primary ones, or to cross-check. Mark anything that comes only from a
secondary source.

Deliver, as files:
- sources.json: [{id, title, url, note}], with a note on the page numbering of each document.
- identity.md: date, local UTC offset, callsign, registration, exact type, operator, route, the first and
  last second to play, and (for an accident) the time of the first contact with anything. The flight crew
  with roles, names and seats as the official record gives them. How the recorders' clocks were tied to
  local time (the report usually says).
- track inputs: either track.csv as in the doc, or the recorder values per second (heading, airspeed,
  altitude, pitch, roll, vertical g, thrust per engine) with their pages, plus position fixes with times
  (radar, ATC reports, map labels, runway threshold, accident site with ground elevation). State for each
  value whether heading is true or magnetic and whether altitude is pressure or true.
- events.csv: phases, marks, gear, flaps, damage, with a src on every row. Also the report's own
  statements with times ("at 18:49:42 the minimum airspeed was 108 kt"): they check the track.
- transcript.csv: one row per line, columns time,dur,speaker,to,channel,lang,text,original,q,src.
  Times from the official transcript. text = the official English, verbatim. original = the words as
  spoken when not English. q = D (official), T (your translation of the official original), U
  (unintelligible in the record, text "[unintelligible]"). Add x_unclear=1 where the record marks a reading
  as uncertain. List every speaker code with a name. Include every cockpit line, every radio exchange
  with the aircraft, warnings, and the first complete occurrence of each cabin announcement. Leave out
  other aircraft's traffic, repeats, contact and impact sounds.
- livery.md: reference photos of that aircraft near that date (URL, licence), colours as hex, and the
  positions of stripes, titles and registration.
- audio.md (only if a recording exists): where it is, who published it, its length and size, and whether it
  matches the official transcript. Do not download it.
- card.md: 2 to 4 short summary lines and a closing card, facts only: route, aircraft, what failed and
  when, where it ended, the number of people aboard and of those who died, and the report as the source.

Rules:
- Every value has a source id and a page.
- Never fill an unintelligible passage. Never use leaked-audio readings or transcripts from websites.
- Say "unverified" when you could not confirm something. Do not guess.
- Ask before you download any file larger than a web page.
- Do not send: sun or moon tables, KML or other track copies, flight-dynamics or failure models, terrain,
  weather or sound-design prose, alternate airports, derivable columns such as distance to impact, raw OCR
  dumps, screenshots or 3-D models.
```

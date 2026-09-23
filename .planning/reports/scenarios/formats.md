## Prior-art survey and recommended FlightHopper scenario format

### 1. What each format carries

| Format | Attitude? | Time model | Useful for us | Against it |
|---|---|---|---|---|
| **X-Plane .fdr** | Yes: `ptch deg`, `roll deg`, `hdng TRUE`, plus controls, gear, flaps and engines | Header `TIME` is Zulu and `DATE` is MM/DD/YY only. Each `DATA` row starts with seconds from the start of the recording ([x-plane.com](https://www.x-plane.com/kb/creating-fdr-files/), [XP11 page](https://www.x-plane.com/kb/fdr-files-x-plane-11/)) | Rows carry true heading and airspeed. It has timed `TEXT` (text-to-speech), `MARK` and `EVNT` header lines, which are earlier examples of captions and events in a track file | About 80 columns in a fixed order, with dummy values required for every column you lack. The column order is `lon, lat` and it is easy to get wrong. Not ISO 8601. Tied to X-Plane `.acf` paths. A later variant adds fractional seconds ([xpfdr](https://github.com/devleaks/xpfdr)) |
| **Tacview ACMI 2.2** | Yes: `T=Lon\|Lat\|Alt\|Roll\|Pitch\|Yaw`, where Yaw is "clockwise relative to true north" | `0,ReferenceTime=…Z`, then `#<seconds>` frame lines. UTC and metric throughout (metres, m/s) ([spec](https://raia-software-inc.gitbook.io/tacview/technical-documentation/acmi-telemetry-file-format)) | Named properties (`Name`, `Registration`, `CallSign`, `Color`, `IAS`, `AOA`, `LandingGear`, `Flaps`), timed `Event=Message\|Bookmark`, and global `Title`, `Author`, `DataSource` and `Briefing` | Delta encoding (a missing field means "unchanged") and `ReferenceLongitude/Latitude` offsets make it hard to write by hand or with an LLM. Commas in text must be escaped ([mirror](https://github.com/jayscoder/pyacmi/blob/main/ACMI%20file%20documentation.md)). No speaker or addressee structure. No per-sample provenance |
| **Tacview CSV** | Roll, Pitch, Yaw (true), plus IAS, TAS, CAS, AOA and Mach | `Time` is ISO UTC or seconds offset. `Timestamp` is Unix time. Columns may appear in any order, and "only time and position are mandatory" ([doc](https://raia-software-inc.gitbook.io/tacview/real-life-data/real-life-csv-data)) | Closest to what we need: named columns, a flat file, easy to write | Aircraft metadata is encoded in the **file name**. Metric units only. No events |
| **KML gx:Track** | `<gx:angles>` holds heading, tilt and roll ([libkml sample](https://github.com/google/libkml/blob/master/testdata/gx/all-gx.kml)). Whether Google Earth applies tilt and roll to a model is **unverified** ([Google group](https://groups.google.com/g/kml-support-advanced/c/efYYAhsdW7U)) | One `<when>` (ISO 8601, offset allowed) per `<gx:coord>` (lon, lat, alt) | Quick preview in Google Earth. The dossier already ships one | XML is verbose. The dossier's KML has **no `gx:angles`**, so it only duplicates positions that are already in the CSV |
| **Cesium CZML** | Only as a `unitQuaternion [X,Y,Z,W]` in Earth-fixed axes, or `velocityReference`. No heading/pitch/roll form ([Orientation](https://github.com/AnalyticalGraphicsInc/czml-writer/wiki/Orientation)) | `epoch` plus a flat array of `[t, lon, lat, alt, …]`. `interpolationAlgorithm` is LINEAR, LAGRANGE or HERMITE ([Structure](https://github.com/AnalyticalGraphicsInc/czml-writer/wiki/CZML-Structure)) | Cesium's native model. It is the right **runtime** target: `SampledPositionProperty` plus sampled quaternions | Nobody can write quaternions by hand. Too low-level to be the authoring format |
| **FlightGear** | `.fgtape` stores serialized property-tree values that "don't mean anything outside FlightGear" (search snippet from [wiki](https://wiki.flightgear.org/Fgtape); the page returned 403, so **unverified**). The generic protocol replays an ASCII file defined in XML: `--generic=file,in,20,flight.out,playback` ([README.IO](https://github.com/FlightGear/flightgear/blob/next/docs-mini/README.IO)) | Sample rate set by the protocol | The idea of a user-defined column schema | Only makes sense inside FlightGear |
| **IGC** | Optional I-record extensions `HDT`, `AOP`/`AOR` (pitch, roll), depending on the recorder maker ([guide](https://xp-soaring.github.io/igc_file_format/igc_format_2008.html)) | Fixed-width `B HHMMSS…` records in UTC, usually at 1 s | Clean split between header (H), fixes (B) and events (E) | Fixed-width columns, glider-centric, security G-record. Poor fit |
| **GPX 1.1** | None. No course or speed either. Anything else goes in `<extensions>` | `time` is "UTC, not local time!" ([xsd](https://www.topografix.com/GPX/1/1/gpx.xsd)) | Universal position import | Carries no attitude |
| **WebVTT** | n/a | `[hh:]mm:ss.ttt --> …`, "relative to the current playback position of the media" ([W3C](https://w3c.github.io/webvtt/)) | `<v Speaker>` voice spans, `<lang ja>` spans (BCP 47), `NOTE` blocks, metadata cues | Has a speaker but no addressee, channel, original text or source fields, unless you add JSON metadata cues. Times are tied to the media file, not to the scenario |
| **SRT** | n/a | `hh:mm:ss,mmm` | Everyone can read it | No native speaker label (secondary source, [soniox](https://soniox.com/wiki/captions-subtitles-srt-vtt)). The LoC page returned 403 |

What these formats have in common:
- **Tacview CSV** shows that a flat CSV with named columns, where only time and position are mandatory, is enough for a track.
- **ACMI** and **X-Plane** both use **true heading** and put timed text or events next to the track.
- Only CZML matches Cesium's runtime model. It is a compile target, not an authoring format.

### 2. Recommendation: our own folder format, with importers for the other formats

Do not adopt ACMI or FDR as the native format. Copy their ideas in a plain CSV-plus-JSON package. Later, write an ACMI **exporter** so a scenario can be checked in Tacview, and a KML/GPX **importer** for position-only sources.

```
scenarios/jal123-1985/
  scenario.json      manifest (required)
  track.csv          timed 6-DOF samples (required)
  events.csv         discrete events (optional)
  transcript.csv     speaker-attributed lines (optional)
  audio/*.ogg        optional; each file listed in the manifest with an offset
  NOTES.md           free text; the loader ignores it
```

All text files are UTF-8. CSV follows RFC 4180 and has a header row. Units go in the column names. Unknown columns are errors unless they start with `x_`.

**scenario.json** (sketch):
```json
{ "format": "flighthopper-scenario/1",
  "id": "jal123-1985", "title": "Japan Air Lines Flight 123",
  "t0": "1985-08-12T18:12:00+09:00", "tz": "Asia/Tokyo", "clock_label": "JST",
  "duration_s": 2670, "start_s": 720,
  "aircraft": { "registration": "JA8119", "type": "Boeing 747SR-46",
    "model": "<key in public/models/manifest.json>", "operator": "Japan Air Lines",
    "callsign": "JAL123", "livery": "<key in liveries.json>" },
  "conventions": { "heading": "true", "altitude": "msl", "roll_positive": "right_wing_down" },
  "quality": { "A":  {"desc": "documented value at documented time"},
               "A~": {"desc": "documented event, approximate position", "pos_err_nm": 1},
               "R":  {"desc": "model/interpolated", "pos_err_nm": 3} },
  "speakers": { "CAP": {"name": "Captain", "role": "crew"}, "ACC": {"name": "Tokyo Control", "role": "atc"} },
  "audio": [ { "file": "audio/cvr.ogg", "at_s": 732.0, "source": "S1" } ],
  "sources": [ { "id": "S1", "title": "AAIC report (1987)", "url": "…", "note": "pages" } ],
  "content_note": "…", "memorial": "…" }
```

**track.csv columns**

| Column | Status | Meaning |
|---|---|---|
| `t` | required | Seconds since `t0`. Float. Strictly increasing. Spacing may be irregular |
| `lat`, `lon` | required | WGS84 degrees |
| `alt_ft` | required | Altitude, on the datum stated in `conventions` |
| `hdg` | needed for chase | True heading, degrees clockwise |
| `pitch` | needed for chase | Degrees, positive nose up |
| `roll` | needed for chase | Degrees, positive right wing down |
| `ias_kt` | optional | Shown in the HUD |
| `vs_fpm` | optional | Vertical speed |
| `aoa` | optional | Angle of attack |
| `gear` | optional | 0 to 1 |
| `flaps` | optional | Degrees |
| `q` | optional | Quality flag: a key of `quality` |
| `src` | optional | Source reference, for example `S1:p281` |
| `note` | optional | Free text |

Without `hdg`, `pitch` and `roll`, the player falls back to velocity orientation, which is a heuristic.

Drop derivable columns such as the dossier's `km_to_impact`. Move its `event` column into events.csv.

**events.csv**: `t, type, value, label, q, src`. `type` must come from this closed list:
- `phase`
- `failure`
- `damage` (value is a part id, for example `vertical_stabilizer`; the model hides that node if it has one)
- `gear`
- `flaps`
- `squawk`
- `sound` (a cue id)
- `bookmark` (shown as a timeline tick)
- `end`

**transcript.csv**: `t, dur, speaker, to, channel, lang, text, text_en, q, src`
- `channel`: `cockpit`, `rt`, `company`, `pa` or `interphone`.
- `q`:
  - `D`: official record as published, including an official translation.
  - `T`: our own translation.
  - `P`: paraphrase.
- Keep the report's `+++` (indecipherable) markers as they are.

I recommend CSV and not WebVTT as the master transcript for three reasons:
- WebVTT times are relative to the media file.
- WebVTT has no field for the addressee, the channel or the source.
- FlightHopper draws its own captions from the scenario clock, so it does not need a `<track>` element.

Offer WebVTT import and export (`<v CAP>…`, `<lang ja>`) with cue times read as seconds since `t0`.

**Audio**: each clip has an `at_s` offset in scenario time and a required `source`. The validator refuses audio that has no source. This matters here: in August 2025 a Japanese fact-check rated a viral "CVR" video that claimed the pilot said "we've been hit" as unsubstantiated. The official 1987 transcript has no such line ([FactCheck Center Japan](https://www.factcheckcenter.jp/fact-check/affairs/baseless-jal123-fake-voice-recorder/)). The dossier also warns about a fabricated "farewell transcript".

### 3. Time zone

- The canonical time is `t` seconds from a `t0` that carries an explicit offset (ISO 8601). `tz` is an IANA name used only for display.
- The loader converts to UTC once. Sun and moon positions use UTC.
- For convenience, authors may give a `time_local` column (`HH:MM:SS[.s]`) instead of `t`. The validator converts it using `t0`'s date and offset. It rejects the file if both columns are present and disagree by more than 0.5 s, or if times go backwards. A run that crosses midnight must use `t`.
- JST is UTC+9, and Japan has used no daylight saving time since 1952 ([Wikipedia](https://en.wikipedia.org/wiki/Japan_Standard_Time); secondary source). The notes in the dossier's CVR appendix say the CVR times were aligned with the JST time signal on the ATC tape. That comes from the local OCR file, not the web.

### 4. Uncertainty and provenance

- Keep the dossier's row flags (`A`, `A~`, `R`) as `q` values, and declare them once in `quality` with typical errors. Optional columns `pos_err_nm` and `alt_err_ft` override the error for one row.
- If position and attitude differ in quality, split `q` into `q_pos` and `q_att`. This matters for DFDR attitude with a radar-only position.
- `src` must point to a `sources[].id`.
- The UI can show quality as a coloured band on the timeline and draw a dashed trail where `q=R`.

### 5. Strict validation

The validator fails on errors and only warns on anything that is merely unusual.

Errors:
- The manifest must pass a JSON Schema with the version string `format`.
- Values must be in range: lat ±90, lon ±180, pitch ±90, roll ±180, hdg in [0, 360).
- `t` must be strictly increasing, and all times must lie within `duration_s`.
- Speaker, source, model and livery keys must exist.
- Audio files must exist.

Warnings:
- A gap between samples of more than 30 s.
- A ground speed between rows (worked out from lat/lon) above about 650 kt.
- A difference between heading and track above 45° on rows not flagged `R`.

### 6. Realism for chase mode

- **Sample spacing.** 15-s samples cannot show the roughly ±40° Dutch roll that the dossier describes. Because `t` may be irregular, denser segments can be spliced in where they exist, for example second-by-second values from the DFDR observations in Attachment 5.
- **Position interpolation.** Use Cesium Hermite or Lagrange interpolation for position ([CZML](https://github.com/AnalyticalGraphicsInc/czml-writer/wiki/CZML-Structure)).
- **Attitude interpolation.** Unwrap heading, then interpolate orientation as quaternions.
- **Heading convention.** Cesium's documentation describes heading as measured "from the local east direction" ([Transforms](https://cesium.com/learn/cesiumjs/ref-doc/Transforms.html)). The file always stores heading as true, clockwise from north. The renderer owns the conversion, and it needs a test.
- **Altitude datum.** The dossier does not say whether `alt_ft` is pressure altitude or MSL, or whether `hdg_deg` is true or magnetic. The format forces both to be declared.

### 7. What a future scenario needs from the research agent

**Needed:**
- The track CSV. The dossier's CSV maps almost directly.
- The master timeline, turned into events.csv.
- The CVR and ATC lines to show as captions, as transcript.csv. Include speaker, addressee and page reference for each line.
- The source list, with page numbers.
- The model and livery: reference photos with URLs and a short description, so we can add the livery to liveries.json.
- Audio (optional): the file, its offset and its source.
- A short content note.

**Missing from this dossier:**
- Whether heading is true or magnetic.
- The altitude datum.
- Addressee and channel for each line, in columns.
- Audio file, offset and provenance.
- Model and livery keys.
- A source id on each row.

**Not needed:**
- **The celestial CSV.** FlightHopper computes the sun and moon itself; the CSV is useful only as a check in a test.
- **The KML.** It can be derived from the track.
- **The flight-dynamics and failure-injection spec.** FlightHopper replays the flight; it does not simulate it.
- **The terrain spec.**
- **The alternates table.**
- **The cabin and sound-design prose.** Turn it into `sound` events if wanted.
- **The full OCR appendices.** Cite them by page, or keep them outside the parsed files.

### Primary sources for this scenario

- The JTSB 2011 explanatory page ([jtsb.mlit.go.jp/kaisetsu/nikkou123.html](https://jtsb.mlit.go.jp/kaisetsu/nikkou123.html)) links the 1987 report (`/aircraft/rep-acci/62-2-JA8119.pdf`) and the commentary PDF (3,637 KB).
- The report appendix PDF: [62-2-JA8119-huroku.pdf](https://jtsb.mlit.go.jp/aircraft/download/62-2-JA8119-huroku.pdf).
- The English translation hosted by the FAA: [JAL123_Acc_Report.pdf](https://www.faa.gov/sites/faa.gov/files/JAL123_Acc_Report.pdf).

I found these three PDFs through search and did not open them. The FAA's JA8119 page and JAL's Safety Promotion Center page both returned 403, so none of their content is verified here.
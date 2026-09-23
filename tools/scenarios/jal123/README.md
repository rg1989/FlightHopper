<!-- tools/scenarios/jal123/README.md -->
# JAL 123 scenario tools

These scripts build the JAL 123 scenario package (`public/scenarios/jal123/`) from the official accident report.
The design is in `.planning/scenarios-design.md` §6. The inputs and every intermediate file are in the git-ignored
work folder `.work/jal123/` of the main checkout. The scripts find it through `--work`, through `$JAL123_WORK`, or
at `<repo>/.work/jal123`. From a worktree, give the path of the main checkout:

```sh
export JAL123_WORK=/path/to/FlightHopper/.work/jal123
```

The scripts need Python 3.9 with numpy, Pillow and opencv-python, and `pdfimages` (poppler).

## 1. DFDR digitization: `digitize.py`, `digitize_check.py`

The script reads the official DFDR strip charts into a 1 Hz table.

- **Input:** `sources/62-2-JA8119-11.pdf`, part 11 of the 1987 AAIC report (R11). This part holds DFDR図-1…6 and
  the CVR record. The parameter definitions and the official reading of the charts are in part 10 (R10),
  `sources/62-2-JA8119-10.pdf`, printed pp.282-294.
- **Output:**
  - `dfdr_1hz.csv`: one row per second from 18:11:32 to 18:56:27 JST.
  - `digitize-report.md`: the calibration of each page, the checks, the page overlaps and the empty cells.
  - `overlays/p-NN.png`: the traces drawn over each scan.
  - `pages/dfdr/p-NN.png`: the page scans, extracted without loss.

```sh
/usr/bin/python3 tools/scenarios/jal123/digitize.py        # about 1-5 minutes; writes all of the above
/usr/bin/python3 tools/scenarios/jal123/digitize_check.py  # exit 0 = every official observation is met
/usr/bin/python3 -m doctest tools/scenarios/jal123/digitize.py tools/scenarios/jal123/digitize_check.py
```

### Columns of `dfdr_1hz.csv`

| Column | Unit | Meaning |
|---|---|---|
| `time` | `HH:MM:SS` | JST, the clock of the charts |
| `hdg_mag` | degrees, 0-360 | Magnetic heading (HDG). |
| `cas_kt` | kt | Computed airspeed CAS1. It has position-error correction only. The recorder writes it only above 50 kt. |
| `alt_press_ft` | ft | Pressure altitude ALT1, referenced to 29.92 inHg. |
| `roll` | degrees | RLL1. Right wing down is positive. |
| `pitch` | degrees | PCH1. Nose up is positive. |
| `vrtg_g` | g | Vertical acceleration on the body axis. 1.0 is the aircraft standing on the ground. |
| `epr1`…`epr4` | ratio | Engine pressure ratio of each engine. |
| `aoa` | degrees | AOA vane angle. This is not the true angle of attack; flaps and gear affect it. |
| `src_page` | | The R11 PDF page of each figure used, for example `1:p4 2:p10 3:p16 4:p22`. |

- An empty cell means that the chart could not be read there reliably. The report lists every empty cell.
- The rows from 18:56:25 are empty. The official reading (R10 p.294) records abnormal changes in all the data from
  about 18:56:26, and on the charts the continuous traces end at about 18:56:24.

### Method

The scans are 1-bit images at 400 ppi. On each page the script does these steps:

1. It fits each of the 15 dotted grid lines. The scale labels printed on the charts give the value of each line.
2. It builds the time scale from the minute ticks on the top and bottom axes. The scale is piecewise linear
   between the ticks and leans with the rotation of the scan. One labelled tick on each page gives the clock.
3. It erases the grid dots, the ticks and the printed labels. A label that a trace runs through is found by
   matching it against the same label on another page, and then it is removed.
4. It follows each trace with a dynamic-programming path through the ink in the band of the trace. The samples
   are interpolated to whole seconds. VRTG is the median of its ink over each second.

The chart pages overlap, and the script compares the overlaps in the report. `digitize_check.py` compares the
table with the official observations: minimum CAS 108 kt at the stall, minimum altitude about 5,300 ft, the final
dive attitude, the Dutch roll, the 3 g pull-up, and the headings before and after the 420° right turn.

### Limits

- The chart plotter moves in steps of about 4.4 px on the scans. The values of the table have the same
  resolution: about 100 ft, 2 kt, 3.5° of heading, 1.6° of roll, 0.8° of pitch and AOA, and 0.01 of EPR and g.
- At 18:24:31-51 the report also has enlarged plots of the raw samples (R11 pp.37-42). The 1 Hz channels of the
  strip charts appear about 1.5-2 s earlier than in those plots, and VRTG does not. The table keeps the time of
  the strip charts. The official reading of the report uses the same time, for example the stall at 18:49:42 and
  the dive at 18:56:07.

## 2. Inputs: `anchors.csv`, `winds.json` and their builders (`inputs/`)

Task D3 made `anchors.csv` and `winds.json`. Its builders and checks are in `inputs/`, so a fresh clone can rebuild
`winds.json` and check the anchors again. (Until D4 they were scratch files in the git-ignored `.work/jal123/d3/`.)

| File | What it does |
|---|---|
| `inputs/soundings_raw.py` | The four University of Wyoming sounding pages: Tateno 47646 and Hamamatsu 47681, 1985-08-12 at 00Z and 12Z, metric and aviation views, copied verbatim. Data only. |
| `inputs/build_winds.py` | Builds `winds.json` from the sounding pages, the report's surface observations (EN p.19) and the NOAA declination points. It checks that the two views agree and that each layer fits the hypsometric equation. Without `--write` it fails unless `winds.json` is byte-identical to its output. |
| `inputs/runway.py` | The 1985 runway 15L centreline, traced on the GSI gazo3 photographs of 1984-86, and points along it. |
| `inputs/liftoff.py` | The take-off roll from `dfdr_1hz.csv`: the distance from the threshold at each second, its bracket, and the lift-off evidence. |
| `inputs/verify.py` | Checks `livery/body.png`, `local/fin.png`, `anchors.csv` and `winds.json` against the sources and the contract. It exits 1 on a failure. `ANCHORS=<file>` checks a planted copy. It imports `livery.py` and `liftoff.py`. |

```sh
/usr/bin/python3 tools/scenarios/jal123/inputs/build_winds.py          # checks; --write rewrites winds.json
/usr/bin/python3 tools/scenarios/jal123/inputs/verify.py --work "$JAL123_WORK"
/usr/bin/python3 tools/scenarios/jal123/inputs/liftoff.py --work "$JAL123_WORK"
/usr/bin/python3 tools/scenarios/jal123/inputs/runway.py
```

`liftoff.py` and `verify.py` read `dfdr_1hz.csv` from the work folder: `--work`, else `$JAL123_WORK`, else
`<repo>/.work/jal123`.

**`anchors.csv`** has the columns `time,lat,lon,alt_ft,tol_m,kind,src`. `tol_m` is a horizontal distance. `alt_ft`
is set only on the `contact` rows, and it is the height of the part that touched, not the aircraft's altitude. The
kinds are `threshold`, `liftoff`, `map` (a fit to the flight-path map R05 fig.1, ±1.5-2 km), `failure` (K fig.16),
`backcalc` and `contact`. A `backcalc` row is SOFT: track.md worked it back from the crash with chart readings that
are a few seconds off, so it is a coarse check only.

D4 changed three rows:

- **Ridge:** moved from 18:56:28 to 18:56:29 and marked SOFT. The ridge is 602 m from the U-shaped ditch (18:56:26).
  At 18:56:28 that needs about 585 kt, against a true airspeed of about 365-375 kt. Three seconds at about 190 m/s
  fit. R05 fig.1 labels the crash site 18:56'30, and the report gives 18:56:28-30. The row only sets the path's
  direction after the ditch; the scenario ends at 18:56:28.
- **Lift-off `src`:** the arithmetic is now explicit: 1304 + 236 = 1540 m; range 1284 + 173 = 1457 to
  1321 + 298 = 1620 m. The time evidence now cites the official 18:12:16 (R10 p.290) and explains why the row stays
  at 18:12:12 (§3.2).
- **U-shaped ditch `src`:** the bank at the contact is not recorded. The last roll in `dfdr_1hz.csv` is 59.5° R at
  18:56:24, and its rows are empty from 18:56:25.

## 3. Track: `reconstruct.py`, `check.py`

`reconstruct.py` writes `public/scenarios/jal123/track.csv`. `check.py` checks it and exits 1 on a failure.

```sh
/usr/bin/python3 tools/scenarios/jal123/reconstruct.py --work "$JAL123_WORK"                 # about 30 s
/usr/bin/python3 tools/scenarios/jal123/check.py --work "$JAL123_WORK" [--plots <dir>]        # exit 0 = all pass
/usr/bin/python3 -m doctest tools/scenarios/jal123/reconstruct.py tools/scenarios/jal123/check.py
```

- The inputs are `dfdr_1hz.csv` (§1), `anchors.csv` and `winds.json` (§2).
- Both scripts need numpy and scipy. `--plots` needs matplotlib.
- Both read the GSI elevation API through the cache `<work>/elev-cache.json`, at most 4 requests a second.
  `--offline` uses the cache only. The first `check.py` run fetches about 2,400 elevations, which takes about 10-30
  minutes.

**What is measured and what is modelled.** The position is always reconstructed: no position was recorded. `q` is
`M` on a row where the attitude, the airspeed and the altitude come from the DFDR (on the runway: the attitude and
the airspeed; the altitude there is the ground), and `R` where one of them is modelled.

| Column | From | Notes |
|---|---|---|
| `lat`, `lon` | model | Dead reckoning from the DFDR, corrected into the anchors (§3.4). On the runway: the 15L centreline. |
| `alt_ft` | DFDR + model | DFDR pressure altitude made true with the soundings and one tie to the larch (§3.3). On the runway: the GSI ground height. |
| `hdg` | DFDR | Magnetic heading + declination = true heading. |
| `pitch`, `roll` | DFDR | As recorded. |
| `ias_kt` | DFDR | CAS1. Empty below the 50 kt recording floor and after 18:56:23. |
| `gs_kt`, `vs_fpm` | model | From the reconstructed path and altitude. |
| `g` | DFDR | VRTG. Empty where the chart has no reading, and after 18:56:24. |
| `wind_dir`, `wind_kt` | soundings | Not measured on board (§3.4). |
| `epr1`…`epr4` | DFDR | As recorded. |
| `gnd` | model | 1 from 18:11:15 to the lift-off at 18:12:12. |
| `src` | | `R11:p5/p11/p17/p23` = the R11 PDF pages of the DFDR figures 1-4 for that second. `retimed pp.37-38` = §3.1. `GSI:15L …` = the runway rows. `EN:p.8 larch-ditch-ridge` = the rows after the traces end (§3.6). |

The `R` rows are: 18:11:15-18:11:47 (holding, and the roll while CAS is below its floor), 18:12:13-18:12:19 (the
first climb, §3.2), the DFDR gaps 18:16:00-08 and 18:47:45-49 (heading) and 18:41:42-49 (pitch), filled linearly,
and 18:56:23.25-18:56:28 (§3.6).

### 3.1 The clock

The table keeps the clock of the strip charts. The official reading of the DFDR (R10 pp.290-294) times its events on
the same charts, and the table agrees with it within 1 s (`.work/jal123/d4/clock_events.py`):

| Event (R10) | Official | Table | Offset |
|---|---|---|---|
| Take-off roll starts: mean EPR rises (fig.2) | 18:11:32 | 18:11:32.8 | +0.8 s |
| Lift-off: the ALT trace leaves its runway reading (fig.1) | 18:12:16 | 18:12:15.5 | -0.5 s |
| Minimum CAS 108 kt (figs 1, 3) | 18:49:42 | 18:49:41.8 | -0.3 s |
| AOA 30.9° (figs 1, 3) | 18:49:42 | 18:49:41.7 | -0.3 s |
| Pitch about 15° down (fig.2) | 18:55:57 | 18:55:56.6 | -0.4 s |
| Pitch about 36° down (fig.2) | 18:56:07 | 18:56:06.1 | -0.9 s |
| CAS over 340 kt (fig.1) | 18:56:17 | 18:56:16.5 | -0.5 s |
| About 3 g from (fig.1) | 18:56:18 | 18:56:17.7 | -0.3 s |

The mean is -0.3 s and the range is -0.9 to +0.8 s. The chart resolves about 1 s (3.7 px a second, one sample a
second), so there is no consistent offset, and the clock is not corrected.

The exception is the failure. R10 times it by the enlarged plots of 18:24:31-51 (R11 pp.37-38): the LNGG impulse at
18:24:35.7, the VRTG jump at 18:24:36.28, then airspeed down and AOA and pitch up from about 18:24:37. On the strip
chart the pitch spike peaks at 18:24:36.1, 1.7 s earlier than on the enlarged plot (18:24:37.8), and it starts to
rise at about 18:24:34.5, before the impulse that caused it. The CAS peak is 1.0 s early; VRTG is 0.7 s late. So in that window only, the 1 Hz channels (heading,
CAS, altitude, roll, pitch, EPR, AOA) are moved 1.8 s later, with 5 s linear ramps on each side (18:24:26-31 and
18:24:51-56). VRTG is not moved. Those rows carry `retimed pp.37-38` in `src`.

A second test found no consistent offset either. In the phugoid (R10 p.294: AOA about constant), the load factor
follows the rate of the flight path. Cross-correlating VRTG with the altitude's second derivative, and with the pitch
rate, over 18:26-18:54 gives lags of +0.1 to +1.6 s and -0.7 to -1.3 s: opposite signs, within the static-line lag
and the phugoid's phase (`.work/jal123/d4/clock_xcorr.py`).

### 3.2 The take-off

- **18:11:15-18:11:31:** the aircraft holds on the 1985 threshold of runway 15L (the old C runway). `gnd=1`, `q=R`.
- **Roll:** it starts from rest at 18:11:32 (R10 p.290) and runs along the traced centreline. Below 55 kt CAS is on
  its 50 kt recording floor (R10 p.282). So until 18:11:48 (60.2 kt) the speed is modelled: an acceleration that
  varies linearly from 1.88 to 1.74 m/s² and meets both the 18:11:48 speed and the lift-off distance. From 18:11:48
  the ground speed is the DFDR CAS × 1.0238 − 5.3 kt: TAS/CAS at 29 °C and QNH 29.93, less the headwind part of the
  Haneda wind 216/16 (EN p.19). The early EPR ramp suggests less thrust early, so the real roll may have started a
  little earlier or moving slowly (D3). The lift-off anchor's ±200 m covers it.
- **Runway height:** the 1985 surface is gone. `alt_ft` on the runway runs linearly between the GSI heights at the
  threshold (3.8 m) and the lift-off point (3.9 m). The app puts the wheels on its terrain anyway.
- **Lift-off at 18:12:12**, 1,540 m from the threshold. `gnd=1` up to it. R10 p.290 gives 18:12:16 from fig.1; that
  is the second the ALT trace first leaves its runway reading. §3.1 shows the table's clock agrees with R10's, so the
  difference is not a clock offset. The ALT trace resolves about 100 ft, and it first steps up after the aircraft has
  climbed. At 18:12:12 the DFDR shows the lift-off itself:
  - pitch 9.8°, after 2.5°/s from 18:12:08, and the rate eases after it;
  - VRTG rises clear of 1 g: 0.97, then 1.06, 1.12, 1.17;
  - the first roll, 1.4° R;
  - the heading steps from 151.4 to 155.5 magnetic, as the aircraft takes up a crab into the 15 kt crosswind from
    the right.

  At 18:12:16 the pitch is 16.6°. A 747 still on its wheels at that attitude would strike its tail.
- **First climb:** for the first 8 s the ALT trace cannot resolve the height. The height is a cubic that leaves the
  runway level and joins the DFDR altitude at 18:12:20 (74 m up, 14 m/s). Its initial vertical acceleration is
  0.35 g. Those rows are `q=R`.

### 3.3 Altitude

1. **Smoothing.** The chart resolves about 100 ft (quantisation rms 29 ft), so the pressure altitude is a cubic
   smoothing spline with residuals of 30 ft rms. From 18:25:00 to 18:47:30 the allowance is 50 ft: in the Dutch roll
   the trace carries 10-s wiggles of about 50 ft (sideslip on the static ports and the plotter steps), which a 30 ft
   spline turns into ±2,000 fpm of false vertical speed. The phugoid, the stall climb and the final dive keep their
   shape: the largest residual is 155 ft (the steepest phugoid, 18:34:49), and the sink rate still passes
   18,000 fpm about 18:56:11, as R10 p.293 states (18,670 fpm of pressure altitude).
2. **True altitude.** The static pressure of each reading goes to the four soundings. They are blended linearly in
   time (09:00 to 21:00 JST) and by inverse square distance to the two stations. Each sounding's height is linear in
   ln p between its levels, which is the hypsometric equation with a mean layer temperature. Geopotential height is
   converted to geometric height.
3. **The tie ("QNH").** One pressure bias is tied to the larch at 18:56:23. The larch was cut 14 m up, at 1,544 m
   (EN p.8, p.12). The No.4 engine did it, and at the recorded bank of 45.9° the engine hangs 17.0 m below the
   fuselage centreline (747 geometry: 21.2 m outboard, 2.6 m below). So the centreline was at 1,561.2 m. The
   soundings alone give 1,559.1 m for that reading, so the bias is -0.24 hPa (+2.1 m). The soundings and the ground
   points agree to about 2 m.
4. **Near Haneda.** The runway's GSI height (3.9 m) and the sounding height of the runway reading (-9 ft: 5.2 m)
   differ by 1.3 m. The difference fades out over the first 60 s.

`alt_ft` is the altitude of the fuselage centreline. The app draws the wheels at `alt_ft` (hM is the wheel-bottom
height), so the drawn aircraft sits about 5-7 m higher than the true one. That is not visible at chase range.

### 3.4 Position

1. **Dead reckoning** from the lift-off point at 18:12:12 to 18:56:23, in 0.25 s steps (Heun's rule):
   - true airspeed from CAS by the compressible-flow relation, with the static pressure and the sounding temperature;
   - true heading = DFDR magnetic heading + declination. The declination is inverse-square weighted over the five
     NOAA points of `winds.json`: 6.4-6.9° W;
   - horizontal speed = TAS × cos(flight-path angle), where sin(flight-path angle) = climb rate / TAS;
   - wind from the soundings at the aircraft's height. Within 40 km of Haneda and below 1,500 m it blends into the
     Haneda surface wind, because the soundings miss the bay's sea breeze;
   - no sideslip is modelled. The air path is taken along the heading.
2. **Correction.** The DFDR path alone ends 16.0 km from the larch. The correction is one smooth function of time,
   east and north, added to the dead reckoning:
   - a constant velocity: a wind the soundings miss. It comes out as a wind from 298° at 11.7 kt;
   - plus a cubic B-spline with knots every 60 s. It is penalised on its rate (1e-5) and on the path's curvature
     (3e2);
   - each anchor is weighted 1/tol² (SOFT rows × 0.25);
   - hard rows: the lift-off (no offset, no rate, so the path leaves the runway at the roll's speed) and the larch;
   - an anchor outside 0.95 of its tolerance gets double the weight, and the fit repeats (25 passes).
3. **Result.** Every anchor is within its tolerance; the worst is at 0.92 of it. The smooth part adds at most
   19.7 m/s and 9.2 m/s on average. That is mostly the ±1.5-2 km of the R05 fig.1 sketch map: legs between
   neighbouring map points disagree with the DFDR by 0.2-6 km. The heading stays within 8° of the track.

### 3.5 Attitude, speeds, g and EPR

- Between the 1 Hz samples: pitch and roll use a Catmull-Rom cubic (it keeps the 11 s Dutch roll's peaks, as in
  §1); heading and CAS use PCHIP; g and EPR are linear. The 4 Hz rows from 18:55:30 use the same interpolants.
- Gaps: heading 18:16:00-08 and 18:47:45-49, and pitch 18:41:42-49, are filled linearly and marked `R`. Where
  VRTG or an EPR has no reading, the cell stays empty.

### 3.6 After the traces end: 18:56:23.25-18:56:28 (`q=R`)

The picture is fully dark from 18:56:22 (design §7). These rows only carry the motion on to the scenario's end.

- **Path:** cubic Hermite pieces from the larch (the path's position and velocity at 18:56:23) through the
  U-shaped ditch (18:56:26) toward the ridge (18:56:29, SOFT: direction only). The ground speed stays 353-395 kt.
- **Height:** the recorded pull-up carries on until the ditch second: vertical acceleration
  g (n cos(roll) cos(pitch) − 1) with n = 3 (VRTG 2.96 at 18:56:23, 3.07 at 18:56:24). After the ditch the vertical
  speed is held. The right wing tip passes the ditch at 1,595 m, 15 m under the ditch's 1,610 m. The recorded 3 g
  does not quite reach it in 3 s.
- **Attitude:** roll as recorded to 59.5° at 18:56:24, then held. Pitch held at its last value, 7.1°. The heading
  follows the path's track; its recorded offset from the track at 18:56:23 fades out over 2 s.
- **Not modelled:** the roll to inverted and the descent to the ridge. WJ's last values are pitch -42° and roll 131°.

### 3.7 The checks (`check.py`)

| Group | Check |
|---|---|
| shape | the header; 1 Hz from 18:11:15 and 4 Hz from 18:55:30 to 18:56:28; required cells; `q` is M or R; `gnd=1` exactly up to the lift-off |
| anchors | every anchor within `tol_m`, with the table of misses; the path heads for the ridge after 18:56:28; the No.4 engine at the larch within 15 m of 1,544 m; the wing tip at the ditch within 30 m of 1,610 m |
| terrain | `alt_ft` (orthometric, as the app draws it: hM = alt_ft × 0.3048 + EGM96 N) at least 30 m above the GSI ground from 18:12:30 to 18:56:22, with the ten closest samples; a monotonic climb from the runway before 18:12:30. The samples are every 200 m of path, every second from 18:53:30 and every row from 18:56:15. |
| kinematics | no ground-speed change over 15 % from one second to the next after the lift-off; heading within 25° of the track (rows with more than 60° of bank are reported, not checked); `gs_kt` equals the path's speed within 5 % |
| official | R10 pp.290-294 on the final track: minimum CAS 108 kt at 18:49:42; minimum pressure altitude about 5,300 ft (the true altitude converted back); pitch -36° and roll 70° R about 18:56:07; roll ±40° in 18:28:30-18:31:00; 3 g at 18:56:18-23.5; a sink rate over 18,000 fpm about 18:56:11; CAS over 340 kt at 18:56:17; heading 040 and 100 magnetic around the Otsuki loop and its +420° turn; the final right turn (+375 ± 30° from 18:54:50, R10 p.293, to the end); lift-off by 18:12:16 without more than 11° of pitch on the wheels; the failure's pitch rising after 18:24:35.7 and peaking in 18:24:37-39 |

`--plots <dir>` writes `track-map.png` (the path, the anchors with their tolerance circles, the time every 2 minutes),
`track-profile.png` (true altitude over the ground under the path) and `track-final.png` (the final 3 minutes).

### 3.8 Limits

- The position between anchors is dead reckoning: ±1-2 km. The anchors themselves come from a sketch map.
- No sideslip is modelled. The Dutch roll's sideslip, and any steady sideslip after the fin was lost, are inside
  the correction.
- The wind is from soundings 9 hours before and 3 hours after the flight, 60-200 km away. The correction's constant
  part (298°/11.7 kt) is the wind they miss, or a heading or airspeed bias. The data cannot separate those.
- The final seconds (§3.6) are a continuity model in the dark, not a reconstruction of the impact.

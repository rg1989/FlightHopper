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

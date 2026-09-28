#!/usr/bin/env python3
"""Digitise Figure 13 of the GPIAAF final report on KC1388 (08/ACCID/2018, "DVDR basic data", PDF page 44).

The figure is a 912 x 730 raster (a flyback/Embraer plot of the DVDR). Extract it with
    pdfimages -f 44 -l 44 -png <report.pdf> <prefix>        (the 912 x 730 image is <prefix>-004.png)
and run
    python3 digitize_fig13.py <prefix>-004.png > fig13.csv

Each pixel column is ~9.93 s. For each column and trace, the median row of the trace's colour gives one value: a ~10 s
average (single-sample spikes shrink). The vertical-speed trace is left out: its grey matches the grid lines (the
reconstruction derives the vertical speed from the altitude). Axes, calibrated on the figure's own tick labels:
  time      50 ticks, 13:25:21 at x = 64.5 ... 15:27:51 at x = 804.5 (the yellow take-off line at 13:30:21 falls at 94.7)
  pressure altitude  0 ft at y 159.7 (the zero line, row 160; a fit to FR24's 387 Mode S altitudes gives 159.73 and
            181.6 ft/px), 5,000 ft per 27.6 px
  calibrated airspeed 0 kt at y 475.5, 50 kt per 23.33 px
  vertical acceleration 1 g at y 562.5 (the level-cruise trace sits at 562.0), 32 px per g
The "maximum" marker lines drawn across each band, and the traces' own name labels over the right end of each band,
are masked out (the altitude's marker, at ~19,300 ft, hides the top of the climb at 14:45–14:50: FR24 has fixes there).
pa_lo_ft and pa_hi_ft are the altitude trace's extent in the column (its lowest and highest point).
"""
import sys
import numpy as np
from PIL import Image

T0 = 13 * 3600 + 25 * 60 + 21
X0, X1 = 64.5, 804.5
S_PER_PX = 7350 / (X1 - X0)

a = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(int)
R, G, B = a[..., 0], a[..., 1], a[..., 2]
# The airspeed trace is saturated where it runs level, but pale where it moves fast (a spike's thin strokes, smoothed
# by the figure's compression): a pixel counts in proportion to how much bluer than grey it is, so the spikes, where
# the energy is, are not read as missing.
blueness = np.clip(B - np.maximum(R, G) - 20, 0, None) * (B >= 150)
blue = blueness > 0
# The altitude trace is a pale, anti-aliased mauve: any pixel this much pinker than grey (a strict mask kept a third of
# the columns, the darkest pixels only, and read the rest as missing).
mauve = (R - G >= 14) & (B - G >= 6) & (R >= B - 4) & (G < 235)
orange = (R > 180) & (G > 80) & (G < 210) & (B < 150) & (R - B > 90)

# The traces' name labels, drawn over the plot: (x0, x1, y0, y1)
LABELS = [(645, 815, 100, 140), (570, 815, 320, 352), (575, 815, 495, 528)]
for x0, x1, y0, y1 in LABELS:
    for m in (mauve, blue, orange, blueness):
        m[y0:y1, x0:x1] = 0
mauve[:, :70] = False  # the altitude axis


def wmedian(ys, ws):
    order = np.argsort(ys)
    c = np.cumsum(np.asarray(ws, float)[order])
    return float(np.asarray(ys)[order][np.searchsorted(c, c[-1] / 2)])

# (mask, y from, y to, rows of marker lines to skip, value of a row)
TRACES = {
    'pa_ft': (mauve, 40, 162, range(49, 56), lambda y: (159.7 - y) * 5000 / 27.6),
    'cas_kt': (blue, 300, 480, range(306, 314), lambda y: (475.5 - y) * 50 / 23.33),
    'g': (orange, 425, 632, range(428, 434), lambda y: 1 + (562.5 - y) / 32),
}

# The altitude trace's extent in each column too: a dive's bottom (or a zoom's top) inside a column is its lowest (highest)
# pixel, where the median would sit halfway up the V. The line is ~3 px thick: half of it is trimmed off each end.
HALF_PX = 1.5

print('t,' + ','.join(TRACES) + ',pa_lo_ft,pa_hi_ft')
for x in range(66, 805):
    t = T0 + (x - X0) * S_PER_PX
    vals = []
    for name, (mask, y0, y1, skip, val) in TRACES.items():
        ys = [y for y in range(y0, y1) if mask[y, x] and y not in skip]
        if name == 'cas_kt' and ys:
            vals.append(f'{val(wmedian(ys, [blueness[y, x] for y in ys])):.1f}')
            continue
        vals.append('' if not ys else f'{val(float(np.median(ys))):.1f}')
    mask, y0, y1, skip, val = TRACES['pa_ft']
    ys = [y for y in range(y0, y1) if mask[y, x] and y not in skip]
    if ys and max(ys) - min(ys) > 2 * HALF_PX:
        vals += [f'{val(max(ys) - HALF_PX):.1f}', f'{val(min(ys) + HALF_PX):.1f}']
    else:
        vals += [vals[0], vals[0]]
    print(f'{t:.1f},' + ','.join(vals))

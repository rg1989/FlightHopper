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
  pressure altitude  0 ft at y 159, 5,000 ft per 27.6 px
  calibrated airspeed 0 kt at y 475.5, 50 kt per 23.33 px
  vertical acceleration 1 g at y 562.5 (the level-cruise trace sits at 562.0), 32 px per g
The "maximum" marker lines drawn across each band, and the traces' own name labels over the right end of each band,
are masked out.
"""
import sys
import numpy as np
from PIL import Image

T0 = 13 * 3600 + 25 * 60 + 21
X0, X1 = 64.5, 804.5
S_PER_PX = 7350 / (X1 - X0)

a = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(int)
R, G, B = a[..., 0], a[..., 1], a[..., 2]
blue = (B > 150) & (R < 140) & (G < 140)
mauve = (R > 130) & (R - G > 35) & (B > G + 10) & (B < R)
orange = (R > 180) & (G > 80) & (G < 210) & (B < 150) & (R - B > 90)

# The traces' name labels, drawn over the plot: (x0, x1, y0, y1)
LABELS = [(645, 815, 100, 140), (570, 815, 320, 352), (575, 815, 495, 528)]
for x0, x1, y0, y1 in LABELS:
    for m in (mauve, blue, orange):
        m[y0:y1, x0:x1] = False

# (mask, y from, y to, rows of marker lines to skip, value of a row)
TRACES = {
    'pa_ft': (mauve, 40, 162, range(49, 56), lambda y: (159 - y) * 5000 / 27.6),
    'cas_kt': (blue, 300, 480, range(306, 314), lambda y: (475.5 - y) * 50 / 23.33),
    'g': (orange, 425, 632, range(428, 434), lambda y: 1 + (562.5 - y) / 32),
}

print('t,' + ','.join(TRACES))
for x in range(66, 805):
    t = T0 + (x - X0) * S_PER_PX
    vals = []
    for mask, y0, y1, skip, val in TRACES.values():
        ys = [y for y in range(y0, y1) if mask[y, x] and y not in skip]
        vals.append('' if not ys else f'{val(float(np.median(ys))):.1f}')
    print(f'{t:.1f},' + ','.join(vals))

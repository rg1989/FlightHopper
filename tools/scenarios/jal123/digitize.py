# tools/scenarios/jal123/digitize.py
# Digitizes the JAL 123 DFDR strip charts (AAIC 1987 report, part 11, DFDR図-1…4) into a 1 Hz table.
"""
    /usr/bin/python3 tools/scenarios/jal123/digitize.py [--work <FlightHopper>/.work/jal123] [--pages 2,3]

Input  <work>/sources/62-2-JA8119-11.pdf (git-ignored). The chart pages are 400 ppi 1-bit scans; they are
       extracted losslessly with `pdfimages -png` to <work>/pages/dfdr/p-NN.png (NN = PDF page).
Output <work>/dfdr_1hz.csv, <work>/digitize-report.md, <work>/overlays/p-NN.png (trace drawn over the scan).
       --pages reads only those pages and writes only their overlays (for debugging).

Method, per chart page:
  1. grid: the 15 dotted horizontal lines, each fitted as y = a + b·x + c·x² (the scans are slightly rotated and
     stretched); the scale labels printed on the charts say which line carries which value;
  2. time: the minute ticks on the top and bottom axes, piecewise linear between ticks, top and bottom blended
     by height (the time lines lean with the scan); one labelled tick per page anchors the minutes;
  3. clean: minute ticks, grid dots (at the dot phase of the page) and printed labels are erased; a label that a
     trace runs through is found by matching the same label printed elsewhere, and only its strokes are removed;
  4. trace: per parameter, a dynamic-programming path through the ink in the parameter's band (one candidate
     per column, penalising vertical jumps and unexplained ink); the path is cut into flat runs (a plotted
     sample is a short flat mark), each run gives its end points, and the samples are interpolated to whole
     seconds. VRTG is the median of its marks over each second instead.
Pages overlap by about two minutes; each second is taken from the page where it lies farthest from an edge,
and the overlaps are compared in the report.
"""
import argparse
import csv
import math
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import cv2
from PIL import Image

SRC_PDF = '62-2-JA8119-11.pdf'
T_FIRST = 18 * 3600 + 11 * 60 + 32    # 18:11:32 take-off roll start (R10 p.290)
T_LAST = 18 * 3600 + 56 * 60 + 27     # 18:56:27
COLUMNS = ['time', 'hdg_mag', 'cas_kt', 'alt_press_ft', 'roll', 'pitch', 'vrtg_g',
           'epr1', 'epr2', 'epr3', 'epr4', 'aoa', 'src_page']
DECIMALS = {'hdg_mag': 1, 'cas_kt': 1, 'alt_press_ft': 0, 'roll': 1, 'pitch': 1, 'vrtg_g': 2,
            'epr1': 3, 'epr2': 3, 'epr3': 3, 'epr4': 3, 'aoa': 1}


# ---------------------------------------------------------------------------------------------------------------
# small pure helpers (doctests: /usr/bin/python3 -m doctest tools/scenarios/jal123/digitize.py)

def clock(s):
    """Seconds since midnight -> 'HH:MM:SS'.

    >>> clock(T_FIRST), clock(T_LAST)
    ('18:11:32', '18:56:27')
    """
    s = int(round(s))
    return '%02d:%02d:%02d' % (s // 3600, s // 60 % 60, s % 60)


def parse_clock(text):
    """'HH:MM' or 'HH:MM:SS' -> seconds since midnight.

    >>> parse_clock('18:25'), parse_clock('18:24:35')
    (66300, 66275)
    """
    parts = [int(p) for p in text.split(':')]
    while len(parts) < 3:
        parts.append(0)
    return parts[0] * 3600 + parts[1] * 60 + parts[2]


def value_at(y, ys, vals):
    """Linear scale: pixel row y -> value, given rows ys (top to bottom) that carry vals; extrapolates.

    >>> value_at(1440.0, [1440.0, 1660.0], [1.0, 0.5])
    1.0
    >>> value_at(1550.0, [1440.0, 1660.0], [1.0, 0.5])
    0.75
    >>> round(value_at(1330.0, [1440.0, 1660.0, 1880.0], [1.0, 0.5, 0.0]), 3)
    1.25
    """
    ys = list(ys)
    vals = list(vals)
    if y <= ys[0]:
        i = 0
    elif y >= ys[-1]:
        i = len(ys) - 2
    else:
        i = max(k for k in range(len(ys) - 1) if ys[k] <= y)
    f = (y - ys[i]) / (ys[i + 1] - ys[i])
    return vals[i] + f * (vals[i + 1] - vals[i])


def runs_to_points(xs, ys, tol=1.5, half=1.5):
    """Collapses a per-column path into sample points.

    A plotted sample is a short flat mark (about 4 px wide); equal consecutive samples merge into a longer
    flat run. Each run of consecutive columns whose y stays within `tol` of the run's first y gives its
    first and last sample centre (`half` px in from each end), or its centre when it is shorter than that.

    >>> runs_to_points([10, 11, 12, 13], [5, 5, 5, 5])
    [(11.5, 5.0), (11.5, 5.0)]
    >>> runs_to_points([10, 11, 12, 13, 14, 15, 16, 17], [5, 5, 5, 5, 5, 5, 5, 5])
    [(11.5, 5.0), (15.5, 5.0)]
    >>> runs_to_points([10, 11, 12, 13, 14, 15], [5, 5, 5, 9, 9, 9])
    [(11.0, 5.0), (11.0, 5.0), (14.0, 9.0), (14.0, 9.0)]
    """
    pts = []
    n = len(xs)
    i = 0
    while i < n:
        j = i
        while j + 1 < n and xs[j + 1] == xs[j] + 1 and abs(ys[j + 1] - ys[i]) <= tol:
            j += 1
        seg_y = float(np.mean(ys[i:j + 1]))
        a, b = xs[i] + half, xs[j] - half
        if a > b:
            a = b = (xs[i] + xs[j]) / 2.0
        pts.append((float(a), seg_y))
        pts.append((float(b), seg_y))
        i = j + 1
    return pts


def bridge_runs(runs, rects, max_dy=8.0):
    """Run ids for a path's flat runs [(x_first, x_last, y)], where a hole that lies under a printed label
    (rects [(x0, y0, x1, y1)] around the trace's row) and that the trace leaves at the level it entered
    (within max_dy px, two plotter steps) joins its two runs: the label hid a flat trace.

    >>> label = [(100, 480, 160, 520)]
    >>> bridge_runs([(10, 98, 500.0), (163, 200, 502.0), (260, 300, 502.0)], label)
    [0, 0, 2]
    >>> bridge_runs([(10, 98, 500.0), (163, 200, 530.0)], label)
    [0, 1]
    """
    ids = []
    for k, (xa, xb, yv) in enumerate(runs):
        if k:
            pa, pb, py = runs[k - 1]
            if abs(yv - py) <= max_dy and any(x0 - 4 <= pb and xa <= x1 + 4 and y0 - 20 <= yv <= y1 + 20
                                              for (x0, y0, x1, y1) in rects):
                ids.append(ids[-1])
                continue
        ids.append(k)
    return ids


def lone_spikes(runs, jump=40.0, back=12.0, width=6.0):
    """Indices of runs [(x_first, x_last, y)] that are a lone mark off the trace: one sample wide, at least
    `jump` px from both neighbours on the same side, the neighbours within `back` px of each other.

    >>> lone_spikes([(0, 8, 100.0), (12, 13, 160.0), (17, 30, 104.0)])
    [1]
    >>> lone_spikes([(0, 8, 100.0), (12, 13, 160.0), (17, 30, 170.0)])
    []
    """
    out = []
    for k in range(1, len(runs) - 1):
        (a0, a1, ya), (b0, b1, yb), (c0, c1, yc) = runs[k - 1], runs[k], runs[k + 1]
        if b1 - b0 <= width and abs(ya - yc) <= back and min(abs(yb - ya), abs(yb - yc)) >= jump \
                and (yb - ya) * (yb - yc) > 0:
            out.append(k)
    return out


def unwrap_deg(vals):
    """Unwraps a heading series (degrees) so steps are never larger than 180.

    >>> unwrap_deg([350.0, 355.0, 2.0, 10.0])
    [350.0, 355.0, 362.0, 370.0]
    """
    out = []
    for v in vals:
        if out:
            k = round((out[-1] - v) / 360.0)
            v = v + 360.0 * k
        out.append(v)
    return out


# ---------------------------------------------------------------------------------------------------------------
# page images

def page_path(work, n):
    return Path(work) / 'pages' / 'dfdr' / ('p-%02d.png' % n)


def load_ink(work, n):
    """The page as a bool array, True = ink. Extracts the embedded 400 ppi bitmap on first use."""
    path = page_path(work, n)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        prefix = path.parent / ('tmp-%02d' % n)
        subprocess.run(['pdfimages', '-png', '-f', str(n), '-l', str(n),
                        str(Path(work) / 'sources' / SRC_PDF), str(prefix)], check=True)
        made = sorted(path.parent.glob('tmp-%02d-*.png' % n))
        if len(made) != 1:
            raise SystemExit('page %d: expected one image, got %d' % (n, len(made)))
        made[0].rename(path)
    im = Image.open(path)
    a = np.array(im)
    if a.dtype == bool:
        return ~a
    if a.ndim == 3:
        a = a[..., 0]
    return a < 128


# ---------------------------------------------------------------------------------------------------------------
# grid lines

def short_run_mask(ink, maxlen=6):
    """Pixels that belong to horizontal ink runs of at most `maxlen` px (the grid dots are ~4 px wide)."""
    a8 = ink.astype(np.int8)
    pad = np.zeros((ink.shape[0], 1), np.int8)
    d = np.diff(np.hstack([pad, a8, pad]), axis=1)
    rs, cs = np.nonzero(d == 1)
    _, ce = np.nonzero(d == -1)
    keep = (ce - cs) <= maxlen
    out = np.zeros(ink.shape, bool)
    for r, s, e in zip(rs[keep], cs[keep], ce[keep]):
        out[r, s:e] = True
    return out


class Line:
    """A fitted grid line y(x) = c0 + c1·u + c2·u², u = (x - 1664) / 1664."""

    def __init__(self, coef, rms, n):
        self.coef = coef
        self.rms = rms
        self.n = n

    def y(self, x):
        u = (np.asarray(x, float) - 1664.0) / 1664.0
        return self.coef[0] + self.coef[1] * u + self.coef[2] * u * u


def _fit_poly(xs, ys, deg):
    u = (np.asarray(xs, float) - 1664.0) / 1664.0
    c = np.polyfit(u, ys, deg)[::-1]
    c = list(c) + [0.0] * (3 - len(c))
    return np.array(c)


def fit_grid(ink, n_lines, y_lo, y_hi, x_lo=0, x_hi=None, spacing=(205, 236)):
    """Finds the dotted grid lines between rows y_lo and y_hi; returns n_lines Line objects, top first."""
    H, W = ink.shape
    x_hi = W if x_hi is None else x_hi
    sr = short_run_mask(ink[y_lo:y_hi])
    pts = []
    for xc in range(max(x_lo, 0) + 100, min(x_hi, W) - 99, 50):
        prof = sr[:, xc - 100:xc + 100].sum(1).astype(float)
        prof3 = np.convolve(prof, [1, 1, 1], 'same')
        for r in range(3, len(prof3) - 3):
            if prof3[r] >= 70 and prof3[r] == prof3[r - 3:r + 4].max() and prof3[r] > prof3[r - 1]:
                pts.append((xc, r + y_lo, prof3[r]))
    if not pts:
        raise RuntimeError('no grid points')
    pts = np.array(pts)
    order = np.argsort(pts[:, 1])
    pts = pts[order]
    clusters = []
    for p in pts:
        if clusters and p[1] - clusters[-1][-1][1] <= 25:
            clusters[-1].append(p)
        else:
            clusters.append([p])
    n_seg = len(set(pts[:, 0]))
    clusters = [np.array(c) for c in clusters if len(set(np.array(c)[:, 0])) >= 0.4 * n_seg]
    lines = []
    for c in clusters:
        # per segment keep the strongest point, then refit rejecting outliers
        best = {}
        for x, y, s in c:
            if x not in best or s > best[x][1]:
                best[x] = (y, s)
        xs = np.array(sorted(best))
        ys = np.array([best[x][0] for x in xs])
        coef = _fit_poly(xs, ys, 1)
        for _ in range(4):
            cand = {}
            for x, y, s in c:
                r = abs(y - Line(coef, 0, 0).y(x))
                if r <= 4 and (x not in cand or r < cand[x][1]):
                    cand[x] = (y, r)
            xs = np.array(sorted(cand))
            ys = np.array([cand[x][0] for x in xs])
            coef = _fit_poly(xs, ys, 2 if len(xs) >= 12 else 1)
        res = ys - Line(coef, 0, 0).y(xs)
        lines.append(Line(coef, float(np.sqrt(np.mean(res ** 2))), len(xs)))
    lines.sort(key=lambda l: l.y(1664))
    # place the lines on the lattice (the top axis is always found): drop off-lattice lines (a flat dashed trace),
    # interpolate a line hidden under a flat trace from its neighbours
    y0 = lines[0].y(1664)
    step = float(np.median([g for g in np.diff([l.y(1664) for l in lines]) if spacing[0] <= g <= spacing[1]]))
    slots = {}
    for l in lines:
        f = (l.y(1664) - y0) / step
        k = int(round(f))
        if abs(f - k) <= 0.12 and 0 <= k < n_lines and (k not in slots or l.n > slots[k].n):
            slots[k] = l
    missing = [k for k in range(n_lines) if k not in slots]
    for k in missing:
        lo = max([j for j in slots if j < k], default=None)
        hi = min([j for j in slots if j > k], default=None)
        if lo is None or hi is None:
            raise RuntimeError('grid line %d missing at an edge' % k)
        w = (k - lo) / (hi - lo)
        slots[k] = Line(slots[lo].coef * (1 - w) + slots[hi].coef * w, float('nan'), 0)
    out = [slots[k] for k in range(n_lines)]
    gaps = np.diff([l.y(1664) for l in out])
    if gaps.min() < spacing[0] or gaps.max() > spacing[1]:
        raise RuntimeError('grid spacing out of range: %s' % [round(g, 1) for g in gaps])
    return out, missing


# ---------------------------------------------------------------------------------------------------------------
# minute ticks and the time scale

def find_ticks(ink, line, kind, x_lo, x_hi):
    """x centres of the minute ticks on an axis line: 'cross' ticks are '+' marks, 'hang' ticks hang below."""
    H, W = ink.shape
    cols = np.zeros(W, int)
    hit = np.zeros(W, bool)
    for x in range(max(x_lo, 0), min(x_hi, W)):
        yl = int(round(float(line.y(x))))
        above = int(ink[yl - 22:yl - 3, x].sum())
        near_above = int(ink[yl - 10:yl - 3, x].sum())
        below = int(ink[yl + 4:yl + 30, x].sum())
        cols[x] = above + below
        if kind == 'cross':
            hit[x] = above >= 8 and below >= 4
        else:
            hit[x] = below >= 10 and near_above <= 1
    xs = []
    x = 0
    while x < W:
        if hit[x]:
            j = x
            while j + 1 < W and hit[j + 1]:
                j += 1
            if j - x <= 7:
                w = cols[x:j + 1].astype(float)
                xs.append(float((np.arange(x, j + 1) * w).sum() / w.sum()))
            x = j + 1
        else:
            x += 1
    return xs


def assign_minutes(xs, x_anchor, minute_anchor, pitch=220.3, tol=7.0):
    """Minute number of each tick, walking out from the tick nearest x_anchor (which is minute_anchor).

    A tick is accepted when it lies a whole number k of pitches from the last accepted one, within k·tol;
    anything else (a trace crossing the axis, the page border) is dropped. Returns {minute: x}.

    >>> assign_minutes([10, 230, 300, 451, 671, 1112], 440, 1105)
    {1103: 10, 1104: 230, 1105: 451, 1106: 671, 1108: 1112}
    >>> assign_minutes([10, 230, 671], 450, 1105)
    {1103: 10, 1104: 230, 1106: 671}
    >>> assign_minutes([], 440, 1105)
    {}
    """
    xs = sorted(xs)
    if not xs:
        return {}
    i0 = int(np.argmin([abs(x - x_anchor) for x in xs]))
    k0 = int(round((xs[i0] - x_anchor) / pitch))
    if abs(xs[i0] - x_anchor - k0 * pitch) > 40:
        return {}
    m0 = minute_anchor + k0
    out = {m0: xs[i0]}
    for direction in (1, -1):
        m_last, x_last = m0, xs[i0]
        j = i0 + direction
        while 0 <= j < len(xs):
            d = (xs[j] - x_last) * direction
            k = int(round(d / pitch))
            if k >= 1 and abs(d - k * pitch) <= k * tol:
                m_last += k * direction
                x_last = xs[j]
                out[m_last] = xs[j]
            j += direction
    return dict(sorted(out.items()))


class TimeScale:
    """Pixel (x, y) -> seconds of day on one page, from the minute ticks of its top and bottom axes.

    Between ticks the scale is piecewise linear (the paper stretches by a few px per minute); a time line runs
    from its top tick to its bottom tick, so a point is placed by its height between the two axes.
    """

    def __init__(self, top, bot, axis_top, axis_bot):
        both = sorted(m for m in top if m in bot)
        if len(both) < 2:
            raise RuntimeError('fewer than two minutes ticked on both axes')
        lean_m = np.array(both, float)
        lean_v = np.array([bot[m] - top[m] for m in both], float)
        ms = sorted(set(top) | set(bot))
        self.ms = np.array(ms, float)
        self.xt = np.array([top[m] if m in top else bot[m] - np.interp(m, lean_m, lean_v) for m in ms])
        self.xb = np.array([bot[m] if m in bot else top[m] + np.interp(m, lean_m, lean_v) for m in ms])
        self.axis_top = axis_top
        self.axis_bot = axis_bot
        self.lean = lean_v

    def _xk(self, x, y):
        yt = float(self.axis_top.y(x))
        yb = float(self.axis_bot.y(x))
        f = (y - yt) / (yb - yt)
        return self.xt + (self.xb - self.xt) * f

    def t(self, x, y):
        """Seconds of day at pixel (x, y)."""
        xk = self._xk(x, y)
        ms = self.ms
        n = len(ms)
        if x <= xk[0]:
            i = 0
        elif x >= xk[-1]:
            i = n - 2
        else:
            i = min(max(int(np.searchsorted(xk, x)) - 1, 0), n - 2)
        m = ms[i] + (x - xk[i]) / (xk[i + 1] - xk[i]) * (ms[i + 1] - ms[i])
        return 60.0 * m

    def x(self, t, y):
        """Column of time t at height y (inverse of t)."""
        m = t / 60.0
        x = float(np.interp(m, self.ms, self.xt))
        for _ in range(3):
            xk = self._xk(x, y)
            n = len(self.ms)
            i = min(max(int(np.searchsorted(self.ms, m)) - 1, 0), n - 2)
            x = xk[i] + (m - self.ms[i]) / (self.ms[i + 1] - self.ms[i]) * (xk[i + 1] - xk[i])
        return x


# ---------------------------------------------------------------------------------------------------------------
# cleaning: grid dots, ticks, printed labels

def components(ink):
    n, lab, st, cen = cv2.connectedComponentsWithStats(ink.astype(np.uint8), connectivity=8)
    return n, lab, st, cen


def erase_grid_dots(ink, lines, ts):
    """Erases the dots of the dotted grid lines.

    The dots come in pairs every 10 s (about 37 px), at a phase that is fixed on a page. The phase is learnt
    from all the small marks on the lines (their offset from the nearest 10-s instant), and only marks at that
    phase are erased: a trace running along a line (VRTG at 1 g, roll at 0) keeps its marks between the dots.
    """
    n, lab, st, cen = components(ink)
    x, y, w, h, a = st[:, 0], st[:, 1], st[:, 2], st[:, 3], st[:, 4]
    small = (w <= 7) & (h <= 8) & (a <= 45)
    small[0] = False
    cx, cy = cen[:, 0], cen[:, 1]
    near = np.zeros(n, bool)
    for line in lines:
        near |= np.abs(cy - line.y(cx)) <= 4.5
    cand = np.nonzero(small & near)[0]
    half = 5.0 * 220.3 / 60.0              # half of the 10-s pitch in px
    off = {}
    for i in cand:
        t = ts.t(cx[i], cy[i])
        o = cx[i] - ts.x(round(t / 10.0) * 10.0, cy[i])
        off[i] = (o + half) % (2 * half) - half
    o_all = np.array(list(off.values()))

    def circ(d):
        return np.abs((d + half) % (2 * half) - half)
    peaks = []
    for _ in range(2):
        best = None
        for c in np.arange(-half, half, 0.5):
            if any(circ(c - p) < 7 for p in peaks):
                continue
            k = int((circ(o_all - c) <= 3.5).sum())
            if best is None or k > best[1]:
                best = (c, k)
        sel = circ(o_all - best[0]) <= 3.5
        peaks.append(float(best[0] + np.mean((o_all[sel] - best[0] + half) % (2 * half) - half)))
    kill = np.zeros(n, bool)
    for i, o in off.items():
        kill[i] = min(circ(o - p) for p in peaks) <= 4.0
    out = ink.copy()
    out[kill[lab]] = False
    return out, int(kill.sum())


def erase_ticks(ink, xs, line, keep_line):
    """Erases the minute ticks; keep_line spares the rows on the axis itself (a trace can run along it)."""
    for x in xs:
        xi = int(round(x))
        yl = int(round(float(line.y(x))))
        if keep_line:
            ink[yl - 24:yl - 3, xi - 3:xi + 4] = False
            ink[yl + 4:yl + 33, xi - 3:xi + 4] = False
        else:
            ink[yl - 24:yl + 33, xi - 3:xi + 4] = False


def find_labels(ink, lines):
    """Boxes of printed labels (scale values, parameter names): rows of glyph-sized components.

    Glyphs are 26-36 px tall with thick strokes (ink fills >= 25 % of the box; a thin trace diagonal fills
    about 15 %); a label is two or more glyphs with the same top and height within 75 px of each other, or a
    single solid glyph centred on a grid line (a lone '0'). Returns [(x0, y0, x1, y1)].
    """
    n, lab, st, cen = components(ink)
    x, y, w, h, a = st[:, 0], st[:, 1], st[:, 2], st[:, 3], st[:, 4]
    fill = a / np.maximum(w * h, 1)
    glyph = (h >= 26) & (h <= 36) & (w >= 5) & (w <= 32) & (a >= 70) & (fill >= 0.25)
    glyph[0] = False
    idx = list(np.nonzero(glyph)[0])
    idx.sort(key=lambda i: x[i])
    parent = {i: i for i in idx}

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for k, i in enumerate(idx):
        for j in idx[k + 1:]:
            if x[j] - (x[i] + w[i]) > 75:
                break
            if abs(y[i] - y[j]) <= 3 and abs(h[i] - h[j]) <= 4:
                parent[root(j)] = root(i)
    groups = {}
    for i in idx:
        groups.setdefault(root(i), []).append(i)
    boxes = []
    for g in groups.values():
        if len(g) == 1:
            i = g[0]
            on_line = min(abs(cen[i, 1] - float(l.y(cen[i, 0]))) for l in lines) <= 8
            if not (on_line and fill[i] >= 0.3 and 27 <= h[i] <= 34):
                continue
        x0 = min(x[i] for i in g)
        y0 = min(y[i] for i in g)
        x1 = max(x[i] + w[i] for i in g)
        y1 = max(y[i] + h[i] for i in g)
        boxes.append((int(x0), int(y0), int(x1), int(y1)))
    # grow each label along its row to the rest of its string: glyphs of the dotted plotter font often break
    # into pieces ('2' in '2.0G'), and a lone glyph beside a label ('70' of 'W 270') is not solid enough alone
    # Only scale labels grow (centred on a grid line or half-way between two); a name label ('CAS1') sits beside
    # its trace and would swallow it. At most two more glyphs (90 px) are added.
    grown = []
    for (bx0, y0, bx1, y1) in boxes:
        cx, cy = (bx0 + bx1) / 2.0, (y0 + y1) / 2.0
        ly = [float(l.y(cx)) for l in lines]
        rows = ly + [(p + q) / 2.0 for p, q in zip(ly, ly[1:])]
        x0, x1 = bx0, bx1
        while min(abs(cy - v) for v in rows) <= 8:
            row = (y >= y0 - 4) & (y + h <= y1 + 4) & (x + w >= x0 - 45) & (x <= x1 + 45) & (a >= 3) & (w <= 32)
            row[0] = False
            idx = np.nonzero(row)[0]
            nx0 = min([x0] + [int(x[i]) for i in idx])
            nx1 = max([x1] + [int(x[i] + w[i]) for i in idx])
            if (nx0, nx1) == (x0, x1) or (nx1 - nx0) - (bx1 - bx0) > 90:
                break
            x0, x1 = nx0, nx1
        grown.append((x0, y0, x1, y1))
    return grown


def erase_inside(ink, boxes, pad=4):
    """Erases every component that lies wholly inside one of the boxes (grown by pad)."""
    n, lab, st, cen = components(ink)
    x, y, w, h = st[:, 0], st[:, 1], st[:, 2], st[:, 3]
    kill = np.zeros(n, bool)
    for (x0, y0, x1, y1) in boxes:
        kill |= (x >= x0 - pad) & (y >= y0 - pad) & (x + w <= x1 + pad) & (y + h <= y1 + pad)
    kill[0] = False
    out = ink.copy()
    out[kill[lab]] = False
    return out


# ---------------------------------------------------------------------------------------------------------------
# traces

def column_candidates(ink, x, ylo, yhi, join=3):
    """Ink clusters in column x between rows ylo and yhi: [(y_centre, n_px)]."""
    ylo = max(int(ylo), 0)
    yhi = min(int(yhi), ink.shape[0])
    r = np.flatnonzero(ink[ylo:yhi, x])
    if r.size == 0:
        return []
    cut = np.flatnonzero(np.diff(r) > join) + 1
    return [(ylo + float(g.mean()), int(g.size)) for g in np.split(r, cut)]


def dp_path(cols, cands, scale=10.0, gap_ink=6.0, gap_empty=0.05, max_gap=400, period=None):
    """Chooses at most one candidate per column so the path is continuous: minimises sum |dy|/scale, plus
    gap_ink for each skipped column that has ink and gap_empty for each skipped empty column.
    cols: consecutive column numbers; cands: per column, list of y; period: per column, the wrap distance in
    px (heading) or None. Returns {col: y}.

    A sampled trace is followed through its peaks (skipping ink costs more than the jumps):
    >>> sorted(dp_path(list(range(7)), [[0], [20], [40], [60], [40], [20], [0]]).items())
    [(0, 0.0), (1, 20.0), (2, 40.0), (3, 60.0), (4, 40.0), (5, 20.0), (6, 0.0)]

    A stray mark beside the trace is not:
    >>> sorted(dp_path(list(range(5)), [[100], [100], [100, 160], [100], [100]]).items())
    [(0, 100.0), (1, 100.0), (2, 100.0), (3, 100.0), (4, 100.0)]

    Across a wrap (period 440 px), 438 -> 2 is a 4 px step:
    >>> sorted(dp_path([0, 1, 2], [[436], [438, 200], [2]], period={0: 440, 1: 440, 2: 440}).items())
    [(0, 436.0), (1, 438.0), (2, 2.0)]
    """
    X, Y, P = [], [], []
    for c, ys in zip(cols, cands):
        for yv in ys:
            X.append(c)
            Y.append(yv)
            P.append(period[c] if period is not None else 0.0)
    if not X:
        return {}
    X = np.array(X, float)
    Y = np.array(Y, float)
    P = np.array(P, float)
    N = len(X)
    c0 = cols[0]
    # skip cost of columns c0..c-1 (cumulative), so any gap costs skip[b] - skip[a+1]
    per_col = np.array([gap_ink if ys else gap_empty for ys in cands], float)
    skip = np.concatenate([[0.0], np.cumsum(per_col)])
    Xi = (X - c0).astype(int)
    cost = np.empty(N)
    back = np.full(N, -1)
    for k in range(N):
        best = skip[Xi[k]]
        lo = int(np.searchsorted(X, X[k] - max_gap, 'left'))
        hi = int(np.searchsorted(X, X[k], 'left'))
        if hi > lo:
            dy = np.abs(Y[k] - Y[lo:hi])
            if period is not None:
                dy = np.minimum(dy, np.abs(P[k] - dy))
            c = cost[lo:hi] + dy / scale + (skip[Xi[k]] - skip[Xi[lo:hi] + 1])
            j = int(np.argmin(c))
            if c[j] < best:
                best = c[j]
                back[k] = lo + j
        cost[k] = best
    total = cost + (skip[-1] - skip[Xi + 1])
    k = int(np.argmin(total))
    path = {}
    while k >= 0:
        path[int(X[k])] = float(Y[k])
        k = back[k]
    return path


# ---------------------------------------------------------------------------------------------------------------
# what is on the charts (read off the scale labels of each figure; R11 = 62-2-JA8119-11.pdf)
#
# Each figure has 15 dotted grid lines, L0 (top axis, minute ticks) to L14 (bottom axis). A band lists the grid
# lines that carry values, the rows to search (line, px offset) and how to read the trace.

class Band:
    def __init__(self, name, scale, region, mode='path', wrap=False, below=None, gap_ink=6.0, gap_empty=0.05,
                 floor=None, interp='pchip'):
        self.floor = floor          # (line, offset px): the region bottom where the `below` trace is not found
        self.interp = interp        # between samples: 'pchip' (steps, plateaus) or 'cubic' (smooth oscillations)
        self.name = name
        self.scale = scale          # [(line index, value)], top to bottom
        self.region = region        # (line, offset px, line, offset px): the rows searched, top and bottom
        self.mode = mode            # 'path': samples interpolated; 'mean': all ink averaged over each second
        self.wrap = wrap            # heading: the band spans exactly 360 degrees
        self.below = below          # this trace always lies above the named one (search only above it)
        self.gap_ink = gap_ink      # dp cost of leaving a column with ink unexplained (a 10 px jump costs 1)
        self.gap_empty = gap_empty  # dp cost of an empty column in a gap
        # A band alone in its rows follows all of its ink (high gap_ink). ALT shares its upper rows with CAS, so
        # it keeps to continuity instead (low gap_ink) and never borrows CAS ink across a hole; CAS searches only
        # above the ALT path, so it can follow all its ink.


FIGURES = {
    # DFDR図-1 (R11 pp.1-6, printed 295-296): VRTG 0.5 g per line (1.0 g on L4); HDG N360 on L5, S180 on L6,
    # N000 on L7; CAS 300 kt on L8 to 0 on L11; ALT 30,000 ft on L8 to 0 on L14.
    1: dict(top_tick='cross', bands=[
        Band('alt_press_ft', [(8, 30000), (9, 25000), (10, 20000), (11, 15000), (12, 10000), (13, 5000), (14, 0)],
             (8, -40, 14, 6), gap_ink=0.5, gap_empty=0.5),
        Band('cas_kt', [(8, 300), (9, 200), (10, 100), (11, 0)], (8, -130, 11, -60), below='alt_press_ft'),
        Band('hdg_mag', [(5, 360), (6, 180), (7, 0)], (5, -8, 7, 8), wrap=True),
        Band('vrtg_g', [(0, 3.0), (1, 2.5), (2, 2.0), (3, 1.5), (4, 1.0), (5, 0.5), (6, 0.0)], (0, -45, 5, 60),
             mode='mean', below='hdg_mag', floor=(5, -7)),
    ]),
    # DFDR図-2 (R11 pp.7-12, printed 297-298): RLL1 +80 R on L10, 0 on L11, -80 L on L12 (right roll up);
    # PCH1 +40 U on L12, 0 on L13, -40 D on L14.
    2: dict(top_tick='cross', bands=[
        Band('roll', [(10, 80), (11, 0), (12, -80)], (10, -100, 12, -20), interp='cubic'),
        Band('pitch', [(12, 40), (13, 0), (14, -40)], (12, -2, 14, 30), interp='cubic'),
    ]),
    # DFDR図-3 (R11 pp.13-18, printed 299-300): AOA +40 on L5, 0 on L6, -40 on L7 (vane angle, R10 p.284).
    3: dict(top_tick='hang', bands=[
        Band('aoa', [(5, 40), (6, 0), (7, -40)], (4, 0, 8, -10)),
    ]),
    # DFDR図-4 (R11 pp.19-24, printed 301-302): each EPR has 1.5 / 1.0 / 0.5 on three lines:
    # EPR-4 on L5-L7, EPR-3 on L7-L9, EPR-2 on L9-L11, EPR-1 on L11-L13.
    4: dict(top_tick='hang', bands=[
        Band('epr4', [(5, 1.5), (6, 1.0), (7, 0.5)], (5, -155, 6, 88)),
        Band('epr3', [(7, 1.5), (8, 1.0), (9, 0.5)], (7, -130, 8, 88)),
        Band('epr2', [(9, 1.5), (10, 1.0), (11, 0.5)], (9, -130, 10, 88)),
        Band('epr1', [(11, 1.5), (12, 1.0), (13, 0.5)], (11, -130, 12, 88)),
    ]),
}

# The chart pages: figure, usable columns (clear of the scan's border noise; the first page of each figure starts
# before 18:11:32, the last ends before its uncorrected-data inset, "エラー無修正データ"), and one labelled minute tick
# (x near the tick, the label printed under it) that anchors the time axis.
PAGES = {
    2: (1, 740, 3290, (567, '18:10')),
    3: (1, 40, 3290, (53, '18:20')),
    4: (1, 40, 3290, (303, '18:35')),
    5: (1, 40, 2330, (858, '18:50')),
    8: (2, 560, 3290, (385, '18:10')),
    9: (2, 40, 3290, (931, '18:25')),
    10: (2, 40, 3290, (376, '18:35')),
    11: (2, 40, 2390, (925, '18:50')),
    14: (3, 420, 3290, (246, '18:10')),
    15: (3, 40, 3290, (792, '18:25')),
    16: (3, 40, 3290, (249, '18:35')),
    17: (3, 40, 2240, (788, '18:50')),
    20: (4, 480, 3290, (310, '18:10')),
    21: (4, 40, 3290, (860, '18:25')),
    22: (4, 40, 3290, (303, '18:35')),
    23: (4, 40, 2310, (862, '18:50')),
}

MAX_GAP_S = 2.5      # a trace may skip one 1 Hz sample; wider holes are left empty
EDGE_S = 3.0         # seconds kept clear of a page's usable edges
# R10 p.294: "56分26秒ごろ～27.92秒 DFDRの飛行状況を表す各種データに異常な変化が記録されている" (abnormal changes in all
# flight data from about 18:56:26 to 27.92). On the strip charts the continuous traces end at about 18:56:24 and
# only scattered marks follow (and the strip charts place the 1 Hz channels 1.5-2 s earlier than the enlarged
# plots do, see the report), so samples after 18:56:24.5 are not used: the rows from 18:56:25 stay empty.
T_TRUST_END = 18 * 3600 + 56 * 60 + 24.5


def band_rows(lines, region, x):
    l0, o0, l1, o1 = region
    return float(lines[l0].y(x)) + o0, float(lines[l1].y(x)) + o1


def band_value(lines, band, x, y):
    ys = [float(lines[i].y(x)) for i, _ in band.scale]
    vs = [v for _, v in band.scale]
    return value_at(y, ys, vs)


class PageResult:
    pass


def prepare_page(work, page):
    """Loads a chart page and calibrates it: grid, minute ticks, time scale; erases ticks and grid dots; finds labels."""
    fig, xa, xb, (x_anchor, hhmm) = PAGES[page]
    F = FIGURES[fig]
    ink = load_ink(work, page)
    H, W = ink.shape
    lines, missing = fit_grid(ink, 15, 440, 3720)
    m_anchor = parse_clock(hhmm) // 60
    top = assign_minutes(find_ticks(ink, lines[0], F['top_tick'], 12, W - 12), x_anchor, m_anchor)
    bot = assign_minutes(find_ticks(ink, lines[14], 'hang', 12, W - 12), x_anchor, m_anchor)
    for m in set(top) & set(bot):
        if abs(top[m] - bot[m]) > 35:
            raise RuntimeError('p%d: minute %d ticks disagree (%s vs %s)' % (page, m, top[m], bot[m]))
    ts = TimeScale(top, bot, lines[0], lines[14])
    # labelled ticks must be the 5-minute ones
    label_bad = []
    for m, x in top.items():
        xi = int(round(x))
        if xi < 40 or xi > W - 40:
            continue
        y0 = int(round(float(lines[0].y(x)))) + 30
        y1 = int(round(float(lines[1].y(x)))) - 30
        has = int(ink[y0:y1, xi - 20:xi + 21].sum()) >= 80
        if has != (m % 5 == 0):
            label_bad.append((clock(m * 60), has))
    clean = ink.copy()
    erase_ticks(clean, top.values(), lines[0], keep_line=False)
    erase_ticks(clean, bot.values(), lines[14], keep_line=True)
    clean, n_dots = erase_grid_dots(clean, lines, ts)     # after the ticks: a dot touching a tick is then alone
    for m, x in top.items():
        if m % 5 == 0:
            xi = int(round(x))
            y0 = int(round(float(lines[0].y(x)))) + 22
            y1 = int(round(float(lines[1].y(x)))) - 15
            clean[y0:y1, max(xi - 26, 0):xi + 27] = False
    boxes = find_labels(clean, lines)
    r = PageResult()
    r.page, r.fig, r.xa, r.xb = page, fig, xa, xb
    r.lines, r.missing, r.top, r.bot, r.ts = lines, missing, top, bot, ts
    r.label_bad, r.n_dots, r.boxes, r.ink, r.base = label_bad, n_dots, boxes, ink, clean
    ymid = float(lines[7].y((xa + xb) / 2))
    r.t_from, r.t_to = ts.t(xa, ymid), ts.t(xb, ymid)
    return r


def label_templates(results):
    """Bitmaps of the labels found (glyph components wholly inside a label box), with their row offset from the
    nearest grid line: the same printed label recurs on other pages, where a trace may run through it."""
    out = []
    for r in results:
        n, lab, st, cen = components(r.base)
        for (x0, y0, x1, y1) in r.boxes:
            x0, y0, x1, y1 = x0 - 2, y0 - 2, x1 + 3, y1 + 3
            sub = lab[y0:y1, x0:x1]
            ids = [i for i in np.unique(sub) if i and st[i, 0] >= x0 and st[i, 1] >= y0
                   and st[i, 0] + st[i, 2] <= x1 and st[i, 1] + st[i, 3] <= y1]
            T = np.isin(sub, ids)
            if T.sum() < 200 or T.shape[1] < 20:
                continue            # a lone thin glyph ('1', '-') would match any trace
            cx = (x0 + x1) / 2.0
            k = int(np.argmin([abs((y0 + y1) / 2.0 - float(l.y(cx))) for l in r.lines]))
            out.append(dict(T=T, n=int(T.sum()), k=k, off=y0 - float(r.lines[k].y(cx)), src=(r.page, x0, y0)))
    return out


def hidden_labels(r, templates, thr=0.92):
    """Places where a known label is printed but was not found as a label (a trace runs through it).

    Each template is matched at its own row offset from its own grid line: every template pixel must have ink
    within 1 px (>= thr of them), and the other ink inside the box must be no more than a trace crossing it
    (about 5 px per column), so a dense cloud of samples is not taken for a label. Returns [(x, y, template)].
    """
    base = r.base
    img = cv2.dilate(base.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(np.float32)
    H, W = img.shape
    k3 = np.ones((3, 3), np.uint8)
    found = []
    for tp in templates:
        T = tp['T'].astype(np.float32)
        h, w = T.shape
        near = cv2.dilate(tp['T'].astype(np.uint8), k3).astype(bool)
        for line in (r.lines if tp['k'] is None else [r.lines[tp['k']]]):
            ys = [float(line.y(x)) + tp['off'] for x in (0, W // 2, W - 1)]
            s0 = max(int(min(ys)) - 12, 0)
            s1 = min(int(max(ys)) + h + 12, H)
            if s1 - s0 <= h:
                continue
            res = cv2.matchTemplate(img[s0:s1], T, cv2.TM_CCORR) / tp['n']
            for _ in range(12):
                _, mx, _, (px, py) = cv2.minMaxLoc(res)
                if mx < thr:
                    break
                res[max(py - h // 2, 0):py + h // 2 + 1, max(px - w // 2, 0):px + w // 2 + 1] = 0
                y = s0 + py
                extra = int((base[y:y + h, px:px + w] & ~near).sum())
                if extra <= 5 * w + 40:
                    found.append((px, y, tp))
    return found


def extract_page(r, templates, log):
    """Erases the labels (found, and hidden under traces) and reads every band of the page."""
    fig, xa, xb = r.fig, r.xa, r.xb
    F = FIGURES[fig]
    lines, ts = r.lines, r.ts
    clean = erase_inside(r.base, r.boxes)
    r.hidden = hidden_labels(r, templates)
    r.label_rects = list(r.boxes) + [(x, y, x + tp['T'].shape[1], y + tp['T'].shape[0]) for x, y, tp in r.hidden]
    k3 = np.ones((3, 3), np.uint8)
    for (x, y, tp) in r.hidden:
        h, w = tp['T'].shape
        mask = cv2.dilate(tp['T'].astype(np.uint8), k3).astype(bool)
        clean[y:y + h, x:x + w] &= ~mask
    # specks: scan dust of 1-4 px (a plotted sample mark is 10-20 px)
    n, lab, st, cen = components(clean)
    speck = st[:, 4] < 5
    speck[0] = False
    clean[speck[lab]] = False
    r.clean = clean
    r.paths, r.series, r.means, r.spikes = {}, {}, {}, []
    cols = list(range(xa, xb + 1))
    for band in F['bands']:
        other = r.paths.get(band.below) if band.below else None

        def rows(c):
            ylo, yhi = band_rows(lines, band.region, c)
            if other is not None:
                near = [other[k] for k in range(c - 3, c + 4) if k in other]
                if near:
                    yhi = min(yhi, min(near) - 7)
                elif band.floor:
                    yhi = min(yhi, float(lines[band.floor[0]].y(c)) + band.floor[1])
            return ylo, yhi
        if band.mode == 'mean':
            pts = []
            for c in cols:
                ylo, yhi = rows(c)
                rr = np.flatnonzero(clean[int(ylo):int(yhi), c])
                if rr.size:
                    ys = int(ylo) + rr.astype(float)
                    ym = float(np.median(ys))
                    vs = np.array([band_value(lines, band, c, yv) for yv in ys])
                    pts.append((c, ym, ts.t(c, ym), vs))
            r.means[band.name] = [p for p in pts if p[2] <= T_TRUST_END]
            continue
        cands = []
        period = {} if band.wrap else None
        for c in cols:
            ylo, yhi = rows(c)
            cands.append([yv for yv, npx in column_candidates(clean, c, ylo, yhi)])
            if band.wrap:
                y360 = float(lines[band.scale[0][0]].y(c))
                y0 = float(lines[band.scale[-1][0]].y(c))
                period[c] = y0 - y360
        path = dp_path(cols, cands, gap_ink=band.gap_ink, gap_empty=band.gap_empty, period=period)
        r.paths[band.name] = path
        xs = sorted(path)
        pts = runs_to_points(xs, [path[k] for k in xs])
        if not band.wrap:           # (on the heading a 360 <-> 0 flip looks like a spike)
            runs = [(pts[k][0], pts[k + 1][0], pts[k][1]) for k in range(0, len(pts), 2)]
            drop = set(lone_spikes(runs))
            for k in sorted(drop):
                r.spikes.append((band.name, ts.t(runs[k][0], runs[k][2]),
                                 band_value(lines, band, runs[k][0], runs[k][2])))
            pts = [p for i, p in enumerate(pts) if i // 2 not in drop]
        t = np.array([ts.t(x, y) for x, y in pts])
        v = np.array([band_value(lines, band, x, y) for x, y in pts])
        if band.wrap:
            v = np.array(unwrap_deg(list(np.mod(v, 360.0))))
        ids = bridge_runs([(pts[k][0], pts[k + 1][0], pts[k][1]) for k in range(0, len(pts), 2)], r.label_rects)
        run = np.repeat(np.array(ids, int), 2)
        # time order (a steep step leans with the scan) and one point per instant
        order = np.argsort(t, kind='stable')
        t, v, run = t[order], v[order], run[order]
        keep = np.concatenate([[True], np.diff(t) > 1e-6]) & (t <= T_TRUST_END)
        r.series[band.name] = (t[keep], v[keep], run[keep])
    log('p%02d fig %d  %s-%s  grid rms %.2f px%s  ticks %d/%d  lean %.0f..%.0f px  dots erased %d  labels %d '
        '+ %d under traces%s' % (
            r.page, fig, clock(r.t_from), clock(r.t_to), max(l.rms for l in lines if l.n),
            ' (line %s interpolated)' % r.missing if r.missing else '', len(r.top), len(r.bot), ts.lean.min(),
            ts.lean.max(), r.n_dots, len(r.boxes), len(r.hidden),
            ('  LABEL CHECK: %s' % r.label_bad) if r.label_bad else ''))
    return r


def pchip_at(t, v, i, s):
    """Monotone cubic (Fritsch-Carlson) value at s, t[i] <= s <= t[i+1]: follows 1 Hz samples through peaks
    better than a straight line and never overshoots them (flat runs stay flat).

    >>> t = [0.0, 1.0, 2.0]; v = [0.0, 10.0, 0.0]
    >>> round(pchip_at(t, v, 0, 0.5), 2), round(pchip_at(t, v, 1, 1.5), 2)
    (6.25, 6.25)
    >>> t = [0.0, 1.0, 2.0, 3.0]; v = [0.0, 0.0, 10.0, 10.0]
    >>> pchip_at(t, v, 0, 0.5), pchip_at(t, v, 1, 1.5), pchip_at(t, v, 2, 2.5)
    (0.0, 5.0, 10.0)
    """
    n = len(t)

    def secant(k):
        return (v[k + 1] - v[k]) / (t[k + 1] - t[k])

    def slope(k):
        if k == 0:
            return secant(0) if n > 1 else 0.0
        if k == n - 1:
            return secant(n - 2)
        a, b = secant(k - 1), secant(k)
        if a * b <= 0:
            return 0.0
        wa = 2 * (t[k + 1] - t[k]) + (t[k] - t[k - 1])
        wb = (t[k + 1] - t[k]) + 2 * (t[k] - t[k - 1])
        return (wa + wb) / (wa / a + wb / b)
    h = t[i + 1] - t[i]
    if h <= 0:
        return float(v[i])
    d = secant(i)
    m0, m1 = slope(i), slope(i + 1)
    if d == 0:
        return float(v[i])
    # the end slopes of a one-sided start/end may overshoot; clamp to 3x the secant (Fritsch-Carlson)
    m0 = max(min(m0, 3 * d), 0) if d > 0 else min(max(m0, 3 * d), 0)
    m1 = max(min(m1, 3 * d), 0) if d > 0 else min(max(m1, 3 * d), 0)
    u = (s - t[i]) / h
    h00 = (1 + 2 * u) * (1 - u) ** 2
    h10 = u * (1 - u) ** 2
    h01 = u * u * (3 - 2 * u)
    h11 = u * u * (u - 1)
    return float(h00 * v[i] + h10 * h * m0 + h01 * v[i + 1] + h11 * h * m1)


def cubic_at(t, v, i, s):
    """Cubic Hermite with finite-difference (Catmull-Rom) tangents at s, t[i] <= s <= t[i+1]: for smooth
    oscillations (the Dutch roll has about 11 samples per period) it rebuilds the curve between samples,
    peaks included, where a straight line or a monotone cubic cuts them.

    >>> import math
    >>> t = [k + 0.57 for k in range(12)]; v = [40 * math.sin(2 * math.pi * x / 11) for x in t]
    >>> true = 40 * math.sin(2 * math.pi * 3.0 / 11)
    >>> abs(cubic_at(t, v, 2, 3.0) - true) < 0.2, abs(pchip_at(t, v, 2, 3.0) - true) < 0.2
    (True, False)
    """
    n = len(t)

    def tangent(k):
        if k == 0:
            return (v[1] - v[0]) / (t[1] - t[0])
        if k == n - 1:
            return (v[n - 1] - v[n - 2]) / (t[n - 1] - t[n - 2])
        return (v[k + 1] - v[k - 1]) / (t[k + 1] - t[k - 1])
    h = t[i + 1] - t[i]
    if h <= 0:
        return float(v[i])
    u = (s - t[i]) / h
    h00 = (1 + 2 * u) * (1 - u) ** 2
    h10 = u * (1 - u) ** 2
    h01 = u * u * (3 - 2 * u)
    h11 = u * u * (u - 1)
    return float(h00 * v[i] + h10 * h * tangent(i) + h01 * v[i + 1] + h11 * h * tangent(i + 1))


def sample_series(t, v, run, s, max_gap=MAX_GAP_S, interp='pchip'):
    """Value of a page series at second s, or None when s falls in a hole wider than max_gap.

    >>> t = np.array([0.0, 1.0, 5.0]); v = np.array([1.0, 2.0, 6.0]); run = np.array([0, 1, 2])
    >>> sample_series(t, v, run, 0.5), sample_series(t, v, run, 3.0), sample_series(t, v, run, 9.0)
    (1.5, None, None)
    """
    if len(t) < 2 or s < t[0] or s > t[-1]:
        return None
    i = int(np.searchsorted(t, s, 'right')) - 1
    i = min(max(i, 0), len(t) - 2)

    def hole(k):
        return run[k] != run[k + 1] and t[k + 1] - t[k] > max_gap
    if hole(i):
        return None
    lo = i - 1 if i >= 1 and not hole(i - 1) else i
    hi = i + 2 if i + 2 < len(t) and not hole(i + 1) else i + 1
    tt = [float(x) for x in t[lo:hi + 1]]
    vv = [float(x) for x in v[lo:hi + 1]]
    return (cubic_at if interp == 'cubic' else pchip_at)(tt, vv, i - lo, s)


def page_value(r, name, s):
    """Value of parameter `name` at second s from page result r (None when the page cannot say)."""
    if not (r.t_from + EDGE_S <= s <= r.t_to - EDGE_S):
        return None
    if name in r.series:
        t, v, run = r.series[name]
        return sample_series(t, v, run, s, interp=BAND_OF[name].interp)
    if name in r.means:
        pts = r.means[name]
        if not hasattr(r, '_mean_t'):
            r._mean_t = {}
        if name not in r._mean_t:
            order = sorted(range(len(pts)), key=lambda k: pts[k][2])
            r._mean_t[name] = (np.array([pts[k][2] for k in order]), [pts[k][3] for k in order])
        tt, vals = r._mean_t[name]
        for half in (0.5, 1.0):         # the pen leaves small gaps (at minute marks); then take +-1 s
            a, b = np.searchsorted(tt, s - half, 'left'), np.searchsorted(tt, s + half, 'left')
            if b - a >= 2:
                return float(np.median(np.concatenate(vals[a:b])))
        return None
    return None


# ---------------------------------------------------------------------------------------------------------------
# overlays

BAND_COLOURS = {'alt_press_ft': (0, 0, 230), 'cas_kt': (0, 150, 0), 'hdg_mag': (200, 0, 200),
                'vrtg_g': (0, 140, 255), 'roll': (0, 0, 230), 'pitch': (0, 150, 0), 'aoa': (0, 0, 230),
                'epr4': (0, 0, 230), 'epr3': (0, 150, 0), 'epr2': (200, 0, 200), 'epr1': (0, 140, 255)}


def draw_overlay(r, path, scale=0.5):
    """The scan in grey, erased ink in pale blue, label boxes in blue, grid lines in cyan, minute ticks with their
    clock in green, and each extracted trace in colour (BGR image, cv2)."""
    H, W = r.ink.shape
    img = np.full((H, W, 3), 255, np.uint8)
    img[r.ink] = (235, 200, 170)          # erased (not used)
    img[r.clean] = (150, 150, 150)        # kept ink
    for l in r.lines:
        xs = np.arange(0, W, 8)
        for x in xs:
            y = int(round(float(l.y(x))))
            img[y, x] = (200, 200, 0)
    for (x0, y0, x1, y1) in r.boxes:
        cv2.rectangle(img, (x0 - 4, y0 - 4), (x1 + 4, y1 + 4), (255, 60, 0), 2)
    for (x, y, tp) in r.hidden:
        h, w = tp['T'].shape
        cv2.rectangle(img, (x - 2, y - 2), (x + w + 2, y + h + 2), (160, 0, 160), 2)
    for m, x in r.top.items():
        xi = int(round(x))
        y = int(round(float(r.lines[0].y(x))))
        cv2.line(img, (xi, y - 40), (xi, y - 12), (0, 160, 0), 3)
        cv2.putText(img, clock(m * 60)[:5], (xi - 60, y - 48), cv2.FONT_HERSHEY_SIMPLEX, 1.3, (0, 160, 0), 3)
    for m, x in r.bot.items():
        xi = int(round(x))
        y = int(round(float(r.lines[14].y(x))))
        cv2.line(img, (xi, y + 34), (xi, y + 60), (0, 160, 0), 3)
    cv2.line(img, (r.xa, 400), (r.xa, H - 400), (0, 0, 255), 2)
    cv2.line(img, (r.xb, 400), (r.xb, H - 400), (0, 0, 255), 2)
    for name, pathd in r.paths.items():
        col = BAND_COLOURS.get(name, (0, 0, 255))
        for x, y in pathd.items():
            cv2.circle(img, (int(x), int(round(y))), 2, col, -1)
    for name, pts in r.means.items():
        col = BAND_COLOURS.get(name, (0, 0, 255))
        for c, ym, _, _ in pts:
            cv2.circle(img, (int(c), int(round(ym))), 2, col, -1)
    if scale != 1.0:
        img = cv2.resize(img, (int(W * scale), int(H * scale)), interpolation=cv2.INTER_AREA)
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), img)


# ---------------------------------------------------------------------------------------------------------------
# merge, overlaps, output

PARAMS = [c for c in COLUMNS if c not in ('time', 'src_page')]
FIG_OF = {b.name: f for f, F in FIGURES.items() for b in F['bands']}
BAND_OF = {b.name: b for F in FIGURES.values() for b in F['bands']}


def merge(results):
    """One row per second, T_FIRST..T_LAST: each value from the page where that second lies farthest from an
    edge among the pages that can read it; src_page names the pages used, per figure."""
    rows = []
    for s in range(T_FIRST, T_LAST + 1):
        row = {'time': clock(s)}
        used = {}
        for name in PARAMS:
            best = None
            if s <= T_TRUST_END:
                for r in results:
                    if r.fig != FIG_OF[name]:
                        continue
                    v = page_value(r, name, s)
                    if v is None:
                        continue
                    margin = min(s - r.t_from, r.t_to - s)
                    if best is None or margin > best[0]:
                        best = (margin, v, r.page)
            if best is None:
                row[name] = None
                continue
            v = best[1] % 360.0 if name == 'hdg_mag' else best[1]
            row[name] = v
            used.setdefault(FIG_OF[name], set()).add(best[2])
        row['src_page'] = ' '.join('%d:%s' % (f, '/'.join('p%d' % p for p in sorted(ps)))
                                   for f, ps in sorted(used.items()))
        rows.append(row)
    return rows


def overlap_stats(results):
    """For each pair of consecutive pages of a figure: differences over their common seconds, and the time
    shift of the later page that best matches the earlier one (a check of the two time calibrations)."""
    out = []
    for f in FIGURES:
        pages = sorted([r for r in results if r.fig == f], key=lambda r: r.t_from)
        for a, b in zip(pages, pages[1:]):
            lo = int(math.ceil(max(a.t_from, b.t_from) + EDGE_S))
            hi = int(math.floor(min(a.t_to, b.t_to) - EDGE_S))
            for band in FIGURES[f]['bands']:
                def diffs(lag):
                    d = []
                    for s in range(lo, hi + 1):
                        va = page_value(a, band.name, s)
                        vb = page_value(b, band.name, s + lag) if lo <= s + lag <= hi else None
                        if va is None or vb is None:
                            continue
                        dv = vb - va
                        if band.wrap:
                            dv = (dv + 180.0) % 360.0 - 180.0
                        d.append(dv)
                    return np.array(d)
                d0 = diffs(0.0)
                if len(d0) == 0:
                    out.append(dict(fig=f, a=a.page, b=b.page, name=band.name, n=0))
                    continue
                lags = np.arange(-2.0, 2.01, 0.25)
                rms = []
                for L in lags:
                    dl = diffs(L)
                    rms.append(float(np.sqrt(np.mean(dl ** 2))) if len(dl) > 10 else 1e9)
                out.append(dict(fig=f, a=a.page, b=b.page, name=band.name, n=len(d0), lo=clock(lo), hi=clock(hi),
                                med=float(np.median(d0)), mad=float(np.median(np.abs(d0))),
                                p95=float(np.percentile(np.abs(d0), 95)), mx=float(np.max(np.abs(d0))),
                                lag=float(lags[int(np.argmin(rms))]), rms0=float(np.sqrt(np.mean(d0 ** 2))),
                                rmsb=float(min(rms))))
    return out


def empty_ranges(rows, name):
    """Contiguous runs of empty cells: [(from, to, n)]."""
    out = []
    start = None
    for i, row in enumerate(rows):
        if row[name] is None:
            if start is None:
                start = i
        elif start is not None:
            out.append((rows[start]['time'], rows[i - 1]['time'], i - start))
            start = None
    if start is not None:
        out.append((rows[start]['time'], rows[-1]['time'], len(rows) - start))
    return out


def write_csv(rows, path):
    with open(path, 'w', newline='') as fh:
        w = csv.writer(fh, lineterminator='\n')
        w.writerow(COLUMNS)
        for row in rows:
            out = []
            for c in COLUMNS:
                v = row[c]
                if c in DECIMALS:
                    if v is None:
                        out.append('')
                    else:
                        d = DECIMALS[c]
                        out.append(('%.' + str(d) + 'f') % v if d else str(int(round(v))))
                else:
                    out.append(v)
            w.writerow(out)


def process_pages(work, pages, log):
    """Calibrates every page, gathers each figure's label templates, then reads the traces."""
    prepared = [prepare_page(work, p) for p in pages]
    templates = {f: label_templates([r for r in prepared if r.fig == f]) for f in FIGURES}
    # a lone zero is printed centred on the zero line of most bands, where the trace usually runs through it,
    # so it is rarely found on its own figure: every figure also gets the lone glyphs found anywhere (the same
    # plotter font), searched on every grid line
    lone = [dict(tp, k=None) for f in FIGURES for tp in templates[f] if tp['T'].shape[1] <= 34]
    return [extract_page(r, templates[r.fig] + lone, log) for r in prepared]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1].strip())
    here = Path(__file__).resolve()
    ap.add_argument('--work', default=os.environ.get('JAL123_WORK', str(here.parents[3] / '.work' / 'jal123')),
                    help='the git-ignored work folder (sources/ inside); default $JAL123_WORK or <repo>/.work/jal123')
    ap.add_argument('--pages', help='only these chart pages (comma list), for debugging; no CSV is written')
    ap.add_argument('--no-overlays', action='store_true')
    args = ap.parse_args(argv)
    work = Path(args.work)
    if not (work / 'sources' / SRC_PDF).exists():
        raise SystemExit('missing %s' % (work / 'sources' / SRC_PDF))
    pages = [int(p) for p in args.pages.split(',')] if args.pages else sorted(PAGES)
    log_lines = []

    def log(msg):
        print(msg)
        log_lines.append(msg)
    results = process_pages(work, pages, log)
    if not args.no_overlays:
        for r in results:
            draw_overlay(r, work / 'overlays' / ('p-%02d.png' % r.page))
    if args.pages:
        return 0
    rows = merge(results)
    write_csv(rows, work / 'dfdr_1hz.csv')
    stats = overlap_stats(results)
    write_report(work, rows, results, stats, log_lines)
    print('wrote %s (%d rows) and %s' % (work / 'dfdr_1hz.csv', len(rows), work / 'digitize-report.md'))
    return 0


# Samples read by eye off the enlarged plots of 18:24:31-51 (DFDR拡大図, R11 PDF pp.37-38, one point per sample):
# an independent check of values and timing around the failure. (clock, value)
ENLARGED = {
    'alt_press_ft': [('18:24:31.0', 23900), ('18:24:35.0', 23945), ('18:24:37.0', 23975), ('18:24:39.0', 24000),
                     ('18:24:41.0', 24140), ('18:24:43.0', 24120), ('18:24:45.0', 24130), ('18:24:47.0', 24170)],
    'cas_kt': [('18:24:31.0', 299.0), ('18:24:33.0', 300.0), ('18:24:35.0', 300.5), ('18:24:36.7', 301.5),
               ('18:24:39.2', 299.2), ('18:24:41.2', 299.1), ('18:24:43.2', 298.3), ('18:24:47.2', 297.4)],
    'pitch': [('18:24:32.8', 2.5), ('18:24:35.8', 2.2), ('18:24:36.8', 2.9), ('18:24:37.8', 7.1),
              ('18:24:38.8', 5.7), ('18:24:39.8', 2.2), ('18:24:40.8', 1.9), ('18:24:44.8', 3.3)],
    'roll': [('18:24:32.2', 0.35), ('18:24:36.2', 0.7), ('18:24:39.2', 2.1), ('18:24:41.2', 3.9),
             ('18:24:43.2', 1.8), ('18:24:45.2', -1.4)],
    'hdg_mag': [('18:24:32.7', 250.0), ('18:24:38.7', 250.4), ('18:24:42.7', 249.6), ('18:24:45.7', 249.0)],
    'aoa': [('18:24:33.3', 2.2), ('18:24:37.3', 4.2), ('18:24:37.8', 5.0), ('18:24:38.8', 2.7),
            ('18:24:39.8', 0.55), ('18:24:41.8', 2.4), ('18:24:44.8', 2.8)],
}

# Further statements of the official DFDR reading (R10 pp.290-293) compared with the table (informational; the
# pass/fail checks are in digitize_check.py). (text, column, from, to, how, reference)
STATEMENTS = [
    ('24:34 "高度23,900フィート" (p.290)', 'alt_press_ft', '18:24:34', '18:24:34', 'value', '23,900 ft'),
    ('26-40 min CAS ±約25 kt, ALT ±約1,500 ft phugoid (p.291)', 'cas_kt', '18:26:00', '18:40:00', 'range', '±25 kt'),
    ('26-40 min ALT phugoid (p.291)', 'alt_press_ft', '18:26:00', '18:40:00', 'range', '±1,500 ft'),
    ('26-40 min Dutch roll ±約40度 (p.291)', 'roll', '18:26:00', '18:40:00', 'range', '±40 deg'),
    ('39:51-45:21 mean bank up to 40 R, Dutch roll ±25 (p.291)', 'roll', '18:39:51', '18:45:21', 'range', '<= +65'),
    ('40-48 min 22,000 -> 6,600 ft (p.292)', 'alt_press_ft', '18:40:00', '18:48:00', 'ends', '22,000 / 6,600 ft'),
    ('45 min EPR ~0.9 (p.292)', 'epr1', '18:45:00', '18:45:59', 'range', '~0.9'),
    ('48 min EPR up to ~1.6 (p.292)', 'epr1', '18:48:00', '18:48:59', 'range', '~1.6'),
    ('49:42 AOA 30.9 deg (p.292)', 'aoa', '18:49:38', '18:49:46', 'range', 'max 30.9'),
    ('55:57 pitch ~15 deg down (p.293)', 'pitch', '18:55:57', '18:55:57', 'value', '-15 deg'),
    ('55:57 ALT ~10,000 ft (p.293)', 'alt_press_ft', '18:55:57', '18:55:57', 'value', '10,000 ft'),
    ('56:07 pitch ~36 down, roll ~70 R (p.293)', 'pitch', '18:56:07', '18:56:07', 'value', '-36 deg'),
    ('56:07 roll ~70 R (p.293)', 'roll', '18:56:07', '18:56:07', 'value', '+70 deg'),
    ('56:17 ALT ~5,000 ft (p.293)', 'alt_press_ft', '18:56:17', '18:56:17', 'value', '5,000 ft'),
    ('56:17 CAS > 340 kt (p.293)', 'cas_kt', '18:56:15', '18:56:20', 'range', '> 340 kt'),
    ('56:17 roll back to ~40 R (p.293)', 'roll', '18:56:17', '18:56:17', 'value', '+40 deg'),
]


def _clock_f(text):
    h, m, s = text.split(':')
    return int(h) * 3600 + int(m) * 60 + float(s)


def _series(rows, name):
    t = np.array([parse_clock(r['time']) for r in rows if r[name] is not None], float)
    v = np.array([r[name] for r in rows if r[name] is not None], float)
    if name == 'hdg_mag' and len(v):
        v = np.array(unwrap_deg(list(v)))
    return t, v


def write_report(work, rows, results, stats, log_lines):
    sys.dont_write_bytecode = True      # no __pycache__ in the repo
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import digitize_check
    L = []
    add = L.append
    n = len(rows)
    add('# JAL 123: DFDR strip-chart digitization (task D1)')
    add('')
    add('Generated by `tools/scenarios/jal123/digitize.py`. Sources: **R11** = AAIC report part 11, '
        '`62-2-JA8119-11.pdf` (DFDR図-1…4, the error-corrected strip charts, PDF pp.2-5, 8-11, 14-17, 20-23; '
        'printed pp.295-302); **R10** = part 10, `62-2-JA8119-10.pdf` (parameter definitions printed pp.282-289, '
        'observations "DFDR記録より認められる飛行状況" printed pp.290-294). Both in `.work/jal123/sources/`.')
    add('')
    add('## Output')
    add('')
    add('`dfdr_1hz.csv`: %d rows, one per second from 18:11:32 to 18:56:27 JST (the charts\' clock, JJY time). '
        'An empty cell means the chart could not be read there with confidence (see "Empty cells").' % n)
    add('')
    add('| column | unit | meaning (R10) | chart | resolution |')
    add('|---|---|---|---|---|')
    add('| `hdg_mag` | deg 0-360 | HDG, magnetic heading (0 = magnetic north, p.282) | 図-1, 180 deg per grid line | 0.8 deg/px |')
    add('| `cas_kt` | kt | CAS1, computed airspeed: position-error corrected only; recorded only above 50 kt (p.282), '
        'so 49.9-50 on the take-off roll is the floor | 図-1, 100 kt per line | 0.45 kt/px |')
    add('| `alt_press_ft` | ft | ALT1, pressure altitude on 29.92 inHg (p.282) | 図-1, 5,000 ft per line | 23 ft/px |')
    add('| `roll` | deg, right wing down + | RLL1, INS No.1 (p.283); chart +80 R on top | 図-2, 80 deg per line | 0.36 deg/px |')
    add('| `pitch` | deg, nose up + | PCH1, INS No.1 (pp.283-284) | 図-2, 40 deg per line | 0.18 deg/px |')
    add('| `vrtg_g` | g | VRTG, body vertical axis, 1.0 = standing on the ground (p.282) | 図-1, 0.5 g per line | 0.002 g/px |')
    add('| `epr1`..`epr4` | ratio | EPR per engine (p.286) | 図-4, 0.5 per line | 0.002/px |')
    add('| `aoa` | deg | AOA **vane angle** on the left fuselage, not the true angle of attack; affected by flaps '
        'and gear (pp.284-285) | 図-3, 40 deg per line | 0.18 deg/px |')
    add('| `src_page` | | the R11 PDF page each figure\'s values come from, `figure:page` (e.g. `1:p4 2:p10`) | | |')
    add('')
    add('Sample rates seen on the charts and the enlarged plots (R11 pp.37-42): HDG, CAS, ALT, RLL, PCH, EPR 1 per s; '
        'AOA 2 per s; VRTG several per s. Values are for the whole second. Between samples: a monotone cubic '
        '(PCHIP; no overshoot of steps and plateaus) for HDG, CAS, ALT, EPR, AOA; a Catmull-Rom cubic for roll and '
        'pitch, whose Dutch roll (about 11 s, 11 samples per period) a straight line or a monotone cubic flattens at '
        'the peaks. VRTG is the median of all its ink over the second.')
    add('')
    add('`overlays/p-NN.png` (half scale): the scan in grey; erased ink (grid dots, ticks, printed labels) pale blue; '
        'label boxes blue; grid lines cyan; minute ticks with their clock in green; the traces read, in colour '
        '(図-1: ALT red, CAS green, HDG magenta, VRTG orange; 図-2: roll red, pitch green; 図-3: AOA red; '
        '図-4: EPR-4 red, EPR-3 green, EPR-2 magenta, EPR-1 orange); red vertical lines bound the columns used.')
    add('')
    add('## Pages and calibration')
    add('')
    add('Each page: 15 dotted grid lines fitted as quadratics (rms of the dot rows about the fit); minute ticks '
        'on the top and bottom axes (their offset, "lean", is the scan\'s rotation: time lines are drawn from the '
        'top tick to the bottom tick); one labelled tick anchors the clock and every other 5-minute label is '
        'checked to sit on a multiple of 5 minutes.')
    add('')
    add('| R11 page | figure | span used | grid rms | ticks top/bottom | lean px | labels erased | anchor |')
    add('|---|---|---|---|---|---|---|---|')
    for r in results:
        add('| %d | 図-%d | %s-%s | %.2f px%s | %d/%d | %.0f..%.0f | %d | %s at x=%d |' % (
            r.page, r.fig, clock(r.t_from), clock(r.t_to), max(l.rms for l in r.lines if l.n),
            ' (L%s interpolated: a flat trace hides it)' % ','.join(str(m) for m in r.missing) if r.missing else '',
            len(r.top), len(r.bot), r.ts.lean.min(), r.ts.lean.max(), len(r.boxes), PAGES[r.page][3][1],
            PAGES[r.page][3][0]))
    bad = [(r.page, r.label_bad) for r in results if r.label_bad]
    add('')
    if bad:
        add('Label-position check: ink under a non-5-minute tick on %s. These are traces (the control-wheel '
            'trace CWP of 図-2 reaches up under the top axis), not clock labels; every 5-minute label was found where '
            'expected.' % ', '.join('p%d (%s)' % (p, ', '.join(c for c, _ in b)) for p, b in bad))
    else:
        add('Label-position check: every clock label sits under a 5-minute tick.')
    add('')
    add('## Checks against the official observations (`digitize_check.py`)')
    add('')
    table = digitize_check.load(work / 'dfdr_1hz.csv')
    res = digitize_check.checks(table)
    add('| check | result | read |')
    add('|---|---|---|')
    for name, ok, detail in res:
        add('| %s | %s | %s |' % (name, 'pass' if ok else '**FAIL**', detail))
    add('')
    add('## Other statements of the official reading (informational)')
    add('')
    add('| R10 statement | reference | table |')
    add('|---|---|---|')
    for text, name, a, b, how, ref in STATEMENTS:
        v = digitize_check.window(table, name, a, b)
        if not v:
            got = 'no data'
        elif how == 'value':
            got = '%g' % round(v[0], 1)
        elif how == 'ends':
            got = '%g at %s, %g at %s (min %g)' % (round(v[0]), a, round(v[-1]), b, round(min(v)))
        else:
            got = '%g..%g' % (round(min(v), 2), round(max(v), 2))
        add('| %s | %s | %s |' % (text, ref, got))
    add('')
    add('## Enlarged plots of 18:24:31-51 (R11 pp.37-38): values and timing')
    add('')
    add('Sample values read by eye off the enlarged plots (their scales are 10-50 times finer than the strip charts), '
        'against the table interpolated to the same instant. The pitch and AOA jumps at 18:24:37-38 test the clock.')
    add('')
    add('| column | time | enlarged plot | table | difference |')
    add('|---|---|---|---|---|')
    for name, pts in ENLARGED.items():
        t, v = _series(rows, name)
        for c, ref in pts:
            s = _clock_f(c)
            got = float(np.interp(s, t, v)) if len(t) else float('nan')
            if name == 'hdg_mag':
                got %= 360.0
            add('| %s | %s | %g | %.1f | %+.1f |' % (name, c, ref, got, got - ref))
    add('')
    add('## Page overlaps')
    add('')
    add('Consecutive pages of a figure overlap by one to two minutes; each is read on its own. "shift" is the time '
        'offset of the later page that best matches the earlier one (0 = the two clocks agree); rms is the '
        'difference at that shift and at none.')
    add('')
    add('| figure | pages | seconds | column | median diff | 95th pct abs | max abs | shift s | rms at 0 / at shift |')
    add('|---|---|---|---|---|---|---|---|---|')
    for s in stats:
        if not s['n']:
            add('| 図-%d | p%d/p%d | 0 | %s | | | | | |' % (s['fig'], s['a'], s['b'], s['name']))
            continue
        add('| 図-%d | p%d/p%d | %d (%s-%s) | %s | %+.3g | %.3g | %.3g | %+.2f | %.3g / %.3g |' % (
            s['fig'], s['a'], s['b'], s['n'], s['lo'], s['hi'], s['name'], s['med'], s['p95'], s['mx'], s['lag'],
            s['rms0'], s['rmsb']))
    add('')
    add('## Empty cells')
    add('')
    add('| column | filled | empty runs (from-to, seconds) |')
    add('|---|---|---|')
    for name in PARAMS:
        er = empty_ranges(rows, name)
        filled = sum(1 for r in rows if r[name] is not None)
        txt = ', '.join('%s-%s (%d)' % (a, b, k) for a, b, k in er[:14])
        if len(er) > 14:
            txt += ', … %d more' % (len(er) - 14)
        add('| %s | %d/%d | %s |' % (name, filled, n, txt or 'none'))
    add('')
    add('18:56:25 to 18:56:27 are empty in every column on purpose, and 18:56:24 is in part (a column there needs '
        'a sample after 18:56:24). R10 p.294 records "abnormal changes" in all '
        'the flight data from about 18:56:26 to 18:56:27.92; on the strip charts the continuous traces end at about '
        '18:56:24 and only scattered marks follow (and the strip charts place the 1 Hz channels 1.5-2 s earlier '
        'than the enlarged plots do, below). Samples after 18:56:24.5 are not used.')
    add('')
    add('Other empty cells are holes of more than %.1f s in a trace: mostly where a trace runs through a printed '
        'label and changes level inside it. A hole under a label that the trace leaves at the level it entered '
        '(within two plotter steps) is filled, flat. VRTG is empty where fewer than two columns of its marks fall '
        'within 1 s of the second.' % MAX_GAP_S)
    add('')
    add('## Decisions and limits')
    add('')
    add('- **Scans.** The pages are 400 ppi 1-bit bitmaps; they are extracted as they are (`pdfimages`) instead of '
        'rendered at 300 dpi, which would resample them.')
    add('- **Resolution.** The plotter moves in steps of about 4.4 px (a histogram of the steps between flat runs '
        'peaks at 4-5 px, then 9 and 13-14 px): about 100 ft, 2 kt, 3.5 deg of heading, 1.6 deg of roll, 0.8 deg '
        'of pitch and AOA, 0.01 of EPR and g. Time: about 3.7 px per second.')
    add('- **Clock.** The table keeps the clock printed on the strip charts. At 18:24:31-51 the enlarged plots '
        '(table above) put the 1 Hz channels about 1.5-2 s later than the strip charts do (the pitch and AOA jump '
        'at 18:24:37.8 there, at about 18:24:36 here), while VRTG agrees within about 0.5 s. The official reading '
        'uses the strip-chart clock elsewhere (the stall at 18:49:42, the dive at 18:56:07), and the table agrees '
        'with it; the offset is reported, not corrected.')
    wa, wb = parse_clock('18:28:30'), parse_clock('18:31:00')
    cover = [r for r in results if 'roll' in r.series and r.t_from + EDGE_S <= wa and wb <= r.t_to - EDGE_S]
    pp = '-'
    if cover:
        t_, v_, _ = cover[0].series['roll']
        sel = v_[(t_ >= wa) & (t_ <= wb)]
        pp = '%.1f deg (%.1f..%.1f, p%d)' % (sel.max() - sel.min(), sel.min(), sel.max(), cover[0].page)
    add('- **Between samples.** The 1 Hz channels are sampled once a second at their own point in the second; a '
        'value on a whole second is interpolated from the plotted samples (PCHIP, or Catmull-Rom for roll and '
        'pitch). Read at its own samples, the chart gives a roll peak-to-peak of %s in 18:28:30-18:31:00; the '
        'whole-second table gives %s.' % (pp, next((d for n_, ok, d in res if n_.startswith('RLL peak')), '-')))
    add('- **VRTG** is recorded 8 times a second (the enlarged plots), but the strip charts show fewer marks, '
        'about one or two a second; the value is the median of the marks within the second.')
    add('- **CAS** is recorded only above 50 kt (R10 p.282): 49.9-50 on the take-off roll is that floor, not a '
        'speed. **AOA** is the vane angle (R10 p.284). **HDG** is magnetic.')
    add('- **Labels.** Scale and name labels are erased. Where a trace runs through a label, the label is found by '
        'matching it against the same label printed elsewhere (a lone "0" against any lone "0") and only its '
        'strokes are removed.')
    spikes = [(r.page, n_, t_, v_) for r in results for (n_, t_, v_) in r.spikes]
    add('- **Lone marks.** A single-sample mark at least 40 px off the trace on the same side of both neighbours, '
        'which lie within 12 px of each other, is treated as a glitch and not used: %s.' % (
            '; '.join('%s at %s on p%d (%.1f)' % (n_, clock(t_), p_, v_) for p_, n_, t_, v_ in spikes)
            if spikes else 'none found'))
    add('')
    add('## Run log')
    add('')
    add('```')
    L.extend(log_lines)
    add('```')
    (work / 'digitize-report.md').write_text('\n'.join(L) + '\n', encoding='utf-8')


if __name__ == '__main__':
    sys.exit(main())

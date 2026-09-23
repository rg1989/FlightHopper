# tools/scenarios/jal123/digitize_check.py
# Checks the digitized JAL 123 DFDR table (dfdr_1hz.csv) against the official observations of the report.
"""
    /usr/bin/python3 tools/scenarios/jal123/digitize_check.py --csv <FlightHopper>/.work/jal123/dfdr_1hz.csv

The observations are the AAIC report's DFDR reading (付録 5 / 別添5 "DFDR記録より認められる飛行状況", report part 10,
R10 pp.290-294, 62-2-JA8119-10.pdf PDF pp.33-37). Exit 0 when every check passes, 1 otherwise.
Doctests: /usr/bin/python3 -m doctest tools/scenarios/jal123/digitize_check.py
"""
import argparse
import csv
import math
import os
import sys
from pathlib import Path

COLUMNS = ['time', 'hdg_mag', 'cas_kt', 'alt_press_ft', 'roll', 'pitch', 'vrtg_g',
           'epr1', 'epr2', 'epr3', 'epr4', 'aoa', 'src_page']
FIRST, LAST = '18:11:32', '18:56:27'


def secs(clock):
    """'HH:MM:SS' -> seconds of day.

    >>> secs('18:49:42')
    67782
    """
    h, m, s = (int(p) for p in clock.split(':'))
    return h * 3600 + m * 60 + s


def window(table, name, t0, t1):
    """The non-empty values of column `name` for t0 <= time <= t1 (clock strings).

    >>> table = {'t': [10, 11, 12], 'x': [1.0, None, 3.0]}
    >>> window(table, 'x', '00:00:10', '00:00:12')
    [1.0, 3.0]
    """
    a, b = secs(t0), secs(t1)
    return [v for t, v in zip(table['t'], table[name]) if a <= t <= b and v is not None]


def circ_mean(degs):
    """Mean direction of headings in degrees, 0-360.

    >>> round(circ_mean([350.0, 10.0]), 6) % 360
    0.0
    >>> round(circ_mean([30.0, 50.0]), 6)
    40.0
    """
    x = sum(math.cos(math.radians(d)) for d in degs)
    y = sum(math.sin(math.radians(d)) for d in degs)
    return math.degrees(math.atan2(y, x)) % 360.0


def ang_diff(a, b):
    """Signed a - b in degrees, -180..180.

    >>> ang_diff(10.0, 350.0), ang_diff(350.0, 10.0)
    (20.0, -20.0)
    """
    return (a - b + 180.0) % 360.0 - 180.0


def unwrapped_turn(degs):
    """Total signed heading change along a series (right turn positive).

    >>> unwrapped_turn([40.0, 160.0, 280.0, 40.0, 100.0])
    420.0
    """
    return sum(ang_diff(b, a) for a, b in zip(degs, degs[1:]))


def load(path):
    with open(path, newline='') as fh:
        rows = list(csv.reader(fh))
    if not rows or rows[0] != COLUMNS:
        raise ValueError('header is %s, expected %s' % (rows[0] if rows else None, COLUMNS))
    table = {c: [] for c in COLUMNS}
    table['t'] = []
    for r in rows[1:]:
        table['t'].append(secs(r[0]))
        for c, v in zip(COLUMNS, r):
            if c in ('time', 'src_page'):
                table[c].append(v)
            else:
                table[c].append(float(v) if v != '' else None)
    return table


def checks(table):
    """[(name, ok, detail)] for every check."""
    out = []

    def add(name, ok, detail):
        out.append((name, bool(ok), detail))

    # shape: one row per second over the whole span
    t = table['t']
    add('rows 18:11:32-18:56:27 at 1 Hz',
        t and t[0] == secs(FIRST) and t[-1] == secs(LAST) and all(b - a == 1 for a, b in zip(t, t[1:])),
        '%d rows, %s..%s' % (len(t), table['time'][0] if t else '-', table['time'][-1] if t else '-'))

    # R10 p.292 "49分42秒 最低CASは108ノットになり、迎え角が30.9度に達している"
    v = window(table, 'cas_kt', '18:49:36', '18:49:48')
    add('CAS min 108 +- 6 kt in 18:49:36-18:49:48 (R10 p.292)', v and abs(min(v) - 108) <= 6,
        'min %.1f kt' % min(v) if v else 'no data')

    # R10 p.292 "49分ごろ この運動中の最低気圧高度は、5,300フィートほどである"
    v = window(table, 'alt_press_ft', '18:48:40', '18:49:30')
    add('ALT min 5,300 +- 400 ft in 18:48:40-18:49:30 (R10 p.292)', v and abs(min(v) - 5300) <= 400,
        'min %.0f ft' % min(v) if v else 'no data')

    # R10 p.293 "56分7秒 ... 機首下げ約36度、右横揺れ角70度ほどである"
    v = window(table, 'pitch', '18:56:00', '18:56:12')
    add('PCH <= -30 deg in 18:56:00-18:56:12 (R10 p.293)', v and min(v) <= -30,
        'min %.1f deg' % min(v) if v else 'no data')
    v = window(table, 'roll', '18:56:00', '18:56:12')
    add('RLL >= 60 deg right in 18:56:00-18:56:12 (R10 p.293)', v and max(v) >= 60,
        'max %.1f deg' % max(v) if v else 'no data')

    # R10 p.291 "26分～40分 ... ダッチロールによる横揺れ角は±約40度"
    v = window(table, 'roll', '18:28:30', '18:31:00')
    add('RLL peak-to-peak >= 60 deg in 18:28:30-18:31:00 (R10 p.291)', v and max(v) - min(v) >= 60,
        'p-p %.1f deg (%.1f..%.1f)' % (max(v) - min(v), min(v), max(v)) if v else 'no data')

    # R10 p.293 "56分18秒～23.5秒 ... 垂直加速度は上向き3G程度は続いている"
    v = window(table, 'vrtg_g', '18:56:17', '18:56:24')
    add('VRTG >= 2.5 g in 18:56:17-18:56:24 (R10 p.293)', v and max(v) >= 2.5,
        'max %.2f g' % max(v) if v else 'no data')

    # R10 p.291 "39分51秒～45分21秒 ... 方位約40度から約420度右旋回し、方位約100度に変化している"
    v = window(table, 'hdg_mag', '18:39:41', '18:39:51')
    add('HDG 040 +- 15 deg before 18:39:51 (R10 p.291)', v and abs(ang_diff(circ_mean(v), 40.0)) <= 15,
        'mean %.1f deg over 18:39:41-51' % circ_mean(v) if v else 'no data')
    v = window(table, 'hdg_mag', '18:45:21', '18:45:31')
    add('HDG 100 +- 15 deg after 18:45:21 (R10 p.291)', v and abs(ang_diff(circ_mean(v), 100.0)) <= 15,
        'mean %.1f deg over 18:45:21-31' % circ_mean(v) if v else 'no data')
    v = window(table, 'hdg_mag', '18:39:51', '18:45:21')
    n_all = secs('18:45:21') - secs('18:39:51') + 1
    turn = unwrapped_turn(v) if v else 0.0
    add('HDG turns right about 420 deg (+-30) from 18:39:51 to 18:45:21 (R10 p.291)',
        len(v) >= 0.95 * n_all and abs(turn - 420.0) <= 30,
        'net %+.0f deg over %d of %d s' % (turn, len(v), n_all))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description='check dfdr_1hz.csv against the official observations')
    here = Path(__file__).resolve()
    work = os.environ.get('JAL123_WORK', str(here.parents[3] / '.work' / 'jal123'))
    ap.add_argument('--csv', default=str(Path(work) / 'dfdr_1hz.csv'))
    args = ap.parse_args(argv)
    try:
        table = load(args.csv)
    except (OSError, ValueError) as e:
        print('FAIL cannot read %s: %s' % (args.csv, e))
        return 1
    results = checks(table)
    for name, ok, detail in results:
        print('%s  %s: %s' % ('ok  ' if ok else 'FAIL', name, detail))
    bad = sum(1 for _, ok, _ in results if not ok)
    print('%d of %d checks failed' % (bad, len(results)) if bad else 'all %d checks passed' % len(results))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())

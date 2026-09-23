# tools/scenarios/jal123/check.py
# Checks the reconstructed JAL 123 track (public/scenarios/jal123/track.csv) against the anchors, the terrain, its own
# kinematics and the official DFDR observations (design §6.1 step 4). Exit 1 on any failure.
"""
    /usr/bin/python3 tools/scenarios/jal123/check.py [--work <FlightHopper>/.work/jal123] [--track <track.csv>]
                                                     [--offline] [--plots <dir>] [--anchors <anchors.csv>]

Checks (README §3.7):
  shape      header, times (1 Hz to 18:55:30, 4 Hz to 18:56:28), required cells, q, gnd only up to lift-off
  anchors    every anchor within its tolerance (table of misses); the ridge (after the end) sets the direction only;
             the contact heights of the part that touched
  terrain    minimum clearance of alt_ft (orthometric, as the app draws hM = alt_ft x 0.3048 + EGM96 N) above the GSI
             DEM from 18:12:30 to 18:56:22: fail below 30 m; the ten closest samples. Samples snap to the 0.0001 deg grid. The first 18 s after lift-off
             must climb monotonically from the runway.
  kinematics no ground-speed jump over 15 % between consecutive seconds after lift-off; heading vs track within 25 deg
             (rows with |roll| > 60 deg excepted, reported); gs_kt equals the path's speed
  official   the R10 pp.290-294 observations of digitize_check.py on the final track, plus the lift-off, the failure
             sequence's order, the Otsuki loop (+420 deg) and the final right turn (about +375 deg from 18:54:50)
--plots writes track-map.png, track-profile.png and track-final.png (matplotlib).
Doctests: /usr/bin/python3 -m doctest tools/scenarios/jal123/check.py
"""
import argparse
import csv
import json
import math
import os
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reconstruct as R  # noqa: E402

COLUMNS = R.COLUMNS
T_CLEAR_FROM = R.sec('18:12:30')
T_DARK = R.sec('18:56:22')
CLEAR_MIN_M = 30.0
GS_JUMP = 0.15
HDG_TRK_MAX = 25.0
SAMPLE_M = 200.0
SNAP = 4          # DEM samples snap to the 0.0001 deg grid (at most 7 m away), so a re-run reuses the cache


def load_track(path):
    """track.csv -> (header, list of row dicts with numbers; empty cells None)."""
    with open(path, newline='') as fh:
        rd = csv.reader(fh)
        header = next(rd)
        rows = []
        for cells in rd:
            r = dict(zip(header, cells))
            d = {'time': r['time'], 't': R.sec(r['time']), 'q': r.get('q', ''), 'src': r.get('src', '')}
            for c in header:
                if c in ('time', 'q', 'src'):
                    continue
                d[c] = float(r[c]) if r[c] != '' else None
            rows.append(d)
    return header, rows


def at(rows, t, key):
    """Linear interpolation of a column at time t (None when either neighbour is empty)."""
    ts = [r['t'] for r in rows]
    i = int(np.searchsorted(ts, t, side='right')) - 1
    i = max(0, min(i, len(rows) - 2))
    a, b = rows[i], rows[i + 1]
    if a[key] is None or b[key] is None:
        return None
    u = (t - a['t']) / (b['t'] - a['t'])
    if key == 'hdg':
        return (a[key] + R.ang(b[key] - a[key]) * u) % 360
    return a[key] + (b[key] - a[key]) * u


def window(rows, key, t0, t1):
    a, b = R.sec(t0), R.sec(t1)
    return [(r['t'], r[key]) for r in rows if a <= r['t'] <= b and r[key] is not None]


def unwrapped_turn(degs):
    """Total signed heading change along a series (right turn positive).

    >>> unwrapped_turn([40.0, 160.0, 280.0, 40.0, 100.0])
    420.0
    """
    return sum(R.ang(b - a) for a, b in zip(degs, degs[1:]))


def circ_mean(degs):
    """Mean direction, 0-360.

    >>> round(circ_mean([350.0, 10.0]), 6) % 360
    0.0
    """
    x = sum(math.cos(math.radians(d)) for d in degs)
    y = sum(math.sin(math.radians(d)) for d in degs)
    return math.degrees(math.atan2(y, x)) % 360.0


class Checks:
    def __init__(self):
        self.results = []

    def add(self, group, name, ok, detail):
        self.results.append((group, name, bool(ok), detail))
        print('%s  %-9s %s: %s' % ('ok  ' if ok else 'FAIL', group, name, detail))

    @property
    def failed(self):
        return [r for r in self.results if not r[2]]


def pressure_alt_of(atm, z_m, t, lat, lon):
    """Pressure altitude (ft) whose sounding height at (t, lat, lon) is z_m (bisection on p)."""
    lo, hi = 150.0, 1100.0
    for _ in range(50):
        mid = (lo + hi) / 2
        if atm.z_of_p(mid, t, lat, lon) > z_m:
            lo = mid
        else:
            hi = mid
    return float(R.pressure_alt_ft((lo + hi) / 2))


def samples(rows, until):
    """Points along the path for the DEM, up to `until`: one every SAMPLE_M metres of path, every whole second from
    18:53:30 and every row (4 Hz) from 18:56:15. [(t, lat, lon, alt_m)]."""
    out = []
    cum, nxt = 0.0, 0.0
    for a, b in zip(rows, rows[1:]):
        if a['t'] >= until:
            break
        if (a['t'] >= R.sec('18:53:30') and abs(a['t'] - round(a['t'])) < 1e-9) or a['t'] >= R.sec('18:56:15'):
            out.append((a['t'], a['lat'], a['lon'], a['alt_ft'] * R.FT))
        d = R.dist(a['lat'], a['lon'], b['lat'], b['lon'])
        if d < 1e-6:
            continue
        while nxt <= cum + d:
            u = (nxt - cum) / d
            out.append((a['t'] + (b['t'] - a['t']) * u, a['lat'] + (b['lat'] - a['lat']) * u,
                        a['lon'] + (b['lon'] - a['lon']) * u, (a['alt_ft'] + (b['alt_ft'] - a['alt_ft']) * u) * R.FT))
            nxt += SAMPLE_M
        cum += d
    return sorted(set(out))


def run(track_path, work, offline=False, plots=None, anchors_path=R.ANCHORS):
    C = Checks()
    header, rows = load_track(track_path)
    anchors = R.load_anchors(anchors_path)
    atm = R.Atmos(json.loads(R.WINDS.read_text()))
    dem = R.Dem(Path(work) / 'elev-cache.json', offline=offline)
    lo = R.anchor(anchors, 'liftoff')
    ts = np.array([r['t'] for r in rows])

    # ---- shape --------------------------------------------------------------------------------------------------
    C.add('shape', 'header', header == COLUMNS, ','.join(header))
    want = [float(x) for x in range(R.T_HOLD, R.T_4HZ)] + list(np.arange(R.T_4HZ, R.T_END + 1e-9, 0.25))
    C.add('shape', 'rows 18:11:15-18:55:30 at 1 Hz, 4 Hz to 18:56:28',
          len(ts) == len(want) and np.allclose(ts, want), '%d rows, %s..%s' % (len(rows), rows[0]['time'], rows[-1]['time']))
    req = [r['time'] for r in rows if any(r[c] is None for c in ('lat', 'lon', 'alt_ft', 'hdg', 'pitch', 'roll'))]
    C.add('shape', 'required cells', not req, 'empty in %s' % req[:5] if req else 'all present')
    qs = {r['q'] for r in rows}
    nm = sum(r['q'] == 'M' for r in rows)
    C.add('shape', 'q is M or R', qs <= {'M', 'R'}, '%d M, %d R' % (nm, len(rows) - nm))
    gnd = [r['t'] for r in rows if r['gnd'] == 1]
    C.add('shape', 'gnd=1 exactly up to lift-off', gnd and max(gnd) == lo['t'] and len(gnd) == lo['t'] - R.T_HOLD + 1,
          'gnd=1 %s..%s (lift-off anchor %s)' % (R.clock(min(gnd)), R.clock(max(gnd)), lo['time']))

    # ---- anchors --------------------------------------------------------------------------------------------------
    print('\nanchor misses (horizontal, m):')
    print('  %-8s %-9s %6s %7s %5s' % ('time', 'kind', 'tol', 'miss', 'ratio'))
    table = []
    for a in anchors:
        if a['t'] > rows[-1]['t']:
            continue
        la, lo_ = at(rows, a['t'], 'lat'), at(rows, a['t'], 'lon')
        miss = R.dist(la, lo_, a['lat'], a['lon'])
        table.append((a, miss))
        print('  %-8s %-9s %6.0f %7.0f %5.2f%s' % (a['time'], a['kind'], a['tol_m'], miss, miss / a['tol_m'],
                                                   '' if miss <= a['tol_m'] else '  OUT'))
    bad = [(a['time'], round(m)) for a, m in table if m > a['tol_m']]
    C.add('anchors', 'every anchor within its tolerance', not bad,
          '%d anchors; worst %.2f of tol%s' % (len(table), max(m / a['tol_m'] for a, m in table),
                                               '; out: %s' % bad if bad else ''))
    ridge = [a for a in anchors if a['t'] > rows[-1]['t']]
    for a in ridge:
        last, prev = rows[-1], rows[-5]
        trk = R.bearing(prev['lat'], prev['lon'], last['lat'], last['lon'])
        brg = R.bearing(last['lat'], last['lon'], a['lat'], a['lon'])
        d = R.dist(last['lat'], last['lon'], a['lat'], a['lon'])
        v = R.dist(prev['lat'], prev['lon'], last['lat'], last['lon'])
        exp = v * (a['t'] - last['t'])
        C.add('anchors', 'ridge %s (SOFT, after the end): the path heads for it' % a['time'],
              abs(R.ang(brg - trk)) <= 10 and abs(d - exp) <= max(a['tol_m'], 0.5 * exp),
              'track at 18:56:28 %.0f, bearing to the ridge %.0f; %.0f m to go, %.0f m at the last speed'
              % (trk, brg, d, exp))
    # contact heights: the part that touched, from the centreline by the drawn attitude
    for a, part, tol in ((R.anchor(anchors, 'contact', 0), R.ENGINE4, 15.0), (R.anchor(anchors, 'contact', 1), R.WINGTIP, 30.0)):
        z = at(rows, a['t'], 'alt_ft') * R.FT
        roll = at(rows, a['t'], 'roll')
        hp = z - R.part_drop(part, roll)
        name = 'larch: No.4 engine' if part is R.ENGINE4 else 'ditch: right wing tip'
        C.add('anchors', '%s at %s within %.0f m of %.0f m' % (name, a['time'], tol, a['alt_m']), abs(hp - a['alt_m']) <= tol,
              'centreline %.0f m, bank %.1f, part %.0f m (%+.0f)' % (z, roll, hp, hp - a['alt_m']))

    # ---- terrain -----------------------------------------------------------------------------------------------
    pts = samples(rows, T_DARK)
    print('\nterrain: %d DEM samples (%d elevations cached before this run)' % (len(pts), len(dem.cache)), flush=True)
    dem.prefetch([(round(la, SNAP), round(lo_, SNAP)) for _, la, lo_, _ in pts])
    clear = []
    for k, (t, la, lo_, z) in enumerate(pts):
        g = dem.get(round(la, SNAP), round(lo_, SNAP))
        clear.append((z - g, t, la, lo_, z, g))
    dem.save()
    air = [c for c in clear if T_CLEAR_FROM <= c[1] < T_DARK]
    air.sort()
    mn = air[0]
    C.add('terrain', 'clearance above the GSI DEM >= %.0f m, 18:12:30 to 18:56:22' % CLEAR_MIN_M, mn[0] >= CLEAR_MIN_M,
          'minimum %.1f m at %s (alt %.0f m over ground %.0f m)' % (mn[0], R.clock(round(mn[1] * 4) / 4), mn[4], mn[5]))
    print('  the ten closest samples:')
    print('  %-12s %10s %11s %7s %7s %7s' % ('time', 'lat', 'lon', 'alt m', 'DEM m', 'clear'))
    seen = set()
    n = 0
    for c in air:
        key = round(c[1])
        if key in seen:
            continue
        seen.add(key)
        print('  %-12s %10.5f %11.5f %7.0f %7.0f %7.1f' % (R.clock(round(c[1] * 4) / 4), c[2], c[3], c[4], c[5], c[0]))
        n += 1
        if n == 10:
            break
    climb = [r for r in rows if lo['t'] <= r['t'] <= T_CLEAR_FROM]
    zs = [r['alt_ft'] for r in climb]
    g_lo = dem.get(round(lo['lat'], 5), round(lo['lon'], 5)) / R.FT
    C.add('terrain', 'lift-off to 18:12:30 climbs from the runway', all(b >= a for a, b in zip(zs, zs[1:])) and zs[0] >= g_lo - 1,
          'alt %.0f -> %.0f ft (runway DEM %.0f ft)' % (zs[0], zs[-1], g_lo))

    # ---- kinematics -------------------------------------------------------------------------------------------
    whole = [r for r in rows if abs(r['t'] - round(r['t'])) < 1e-9]
    gs = []
    for a, b in zip(whole, whole[1:]):
        gs.append((a['t'], R.dist(a['lat'], a['lon'], b['lat'], b['lon']) / (b['t'] - a['t'])))
    jumps = []
    for (ta, va), (tb, vb) in zip(gs, gs[1:]):
        if ta <= lo['t']:
            continue
        j = abs(vb - va) / max(va, 1.0)
        jumps.append((j, ta, va, vb))
    jumps.sort(reverse=True)
    C.add('kinematics', 'ground speed changes <= %.0f %% per second after lift-off' % (GS_JUMP * 100), jumps[0][0] <= GS_JUMP,
          'largest %.1f %% at %s (%.0f -> %.0f kt)' % (jumps[0][0] * 100, R.clock(jumps[0][1]), jumps[0][2] / R.KT, jumps[0][3] / R.KT))
    dif = []
    for k in range(1, len(rows) - 1):
        r = rows[k]
        if r['t'] <= lo['t']:
            continue
        a, b = rows[k - 1], rows[k + 1]
        trk = R.bearing(a['lat'], a['lon'], b['lat'], b['lon'])
        dif.append((abs(R.ang(r['hdg'] - trk)), r['time'], r['roll'], r['q']))
    ext = [d for d in dif if abs(d[2]) <= 60]
    ext.sort(reverse=True)
    allmax = max(dif)
    C.add('kinematics', 'heading vs track <= %.0f deg (|roll| <= 60)' % HDG_TRK_MAX, ext[0][0] <= HDG_TRK_MAX,
          'max %.1f at %s; p99 %.1f; with |roll| > 60 included: max %.1f at %s (roll %.0f)'
          % (ext[0][0], ext[0][1], np.percentile([d[0] for d in ext], 99), allmax[0], allmax[1], allmax[2]))
    dgs = [(abs(r['gs_kt'] * R.KT - v) / max(v, 1.0), R.clock(t)) for (t, v), r in zip(gs, whole) if r['t'] > lo['t'] and r['gs_kt']]
    dgs.sort(reverse=True)
    C.add('kinematics', 'gs_kt equals the path speed within 5 %', dgs[0][0] <= 0.05, 'largest %.1f %% at %s' % (dgs[0][0] * 100, dgs[0][1]))

    # ---- official observations (R10 pp.290-294) on the final track ------------------------------------------
    v = window(rows, 'ias_kt', '18:49:36', '18:49:48')
    mv = min(v, key=lambda x: x[1])
    C.add('official', 'CAS min 108 +- 6 kt at 18:49:42 +- 6 s (R10 p.292)', abs(mv[1] - 108) <= 6,
          'min %.1f kt at %s' % (mv[1], R.clock(mv[0])))
    pa = [(t, pressure_alt_of(atm, z * R.FT, t, at(rows, t, 'lat'), at(rows, t, 'lon'))) for t, z in window(rows, 'alt_ft', '18:48:40', '18:49:30')]
    mp = min(pa, key=lambda x: x[1])
    C.add('official', 'pressure ALT min 5,300 +- 400 ft about 18:49 (R10 p.292)', abs(mp[1] - 5300) <= 400,
          'min %.0f ft pressure altitude (true %.0f ft) at %s' % (mp[1], at(rows, mp[0], 'alt_ft'), R.clock(mp[0])))
    v = window(rows, 'pitch', '18:56:00', '18:56:12')
    C.add('official', 'PCH <= -30 deg in 18:56:00-12, about -36 at 18:56:07 (R10 p.293)', min(x for _, x in v) <= -30,
          'min %.1f; %.1f at 18:56:07' % (min(x for _, x in v), at(rows, R.sec('18:56:07'), 'pitch')))
    v = window(rows, 'roll', '18:56:00', '18:56:12')
    C.add('official', 'RLL >= 60 deg R in 18:56:00-12, about 70 at 18:56:07 (R10 p.293)', max(x for _, x in v) >= 60,
          'max %.1f; %.1f at 18:56:07' % (max(x for _, x in v), at(rows, R.sec('18:56:07'), 'roll')))
    v = [x for _, x in window(rows, 'roll', '18:28:30', '18:31:00')]
    C.add('official', 'RLL peak-to-peak >= 60 deg in 18:28:30-18:31:00 (R10 p.291)', max(v) - min(v) >= 60,
          'p-p %.1f (%.1f..%.1f)' % (max(v) - min(v), min(v), max(v)))
    v = [x for _, x in window(rows, 'g', '18:56:17', '18:56:24')]
    C.add('official', 'VRTG >= 2.5 g in 18:56:17-24, about 3 g 18:56:18-23.5 (R10 p.293)', max(v) >= 2.5,
          'max %.2f; min over 18:56:18-23 %.2f' % (max(v), min(x for _, x in window(rows, 'g', '18:56:18', '18:56:23'))))
    sink = []
    for c in ('18:56:09', '18:56:10', '18:56:11', '18:56:12', '18:56:13'):
        t = R.sec(c)
        pz = [pressure_alt_of(atm, at(rows, x, 'alt_ft') * R.FT, x, at(rows, x, 'lat'), at(rows, x, 'lon')) for x in (t - 0.5, t + 0.5)]
        sink.append((pz[0] - pz[1]) * 60)
    C.add('official', 'sink rate over 18,000 fpm about 18:56:11 (R10 p.293)', max(sink) > 18000,
          'pressure-altitude sink rate %s fpm at 18:56:09-13' % '/'.join('%.0f' % x for x in sink))
    C.add('official', 'CAS > 340 kt at about 18:56:17 (R10 p.293)', at(rows, R.sec('18:56:17'), 'ias_kt') > 340,
          '%.1f kt at 18:56:17' % at(rows, R.sec('18:56:17'), 'ias_kt'))

    def mag(t0, t1):
        return [(r['hdg'] - atm.declination(r['lat'], r['lon'])) % 360 for r in rows
                if R.sec(t0) <= r['t'] <= R.sec(t1)]
    m1 = circ_mean(mag('18:39:41', '18:39:51'))
    C.add('official', 'HDG about 040 mag before 18:39:51 (R10 p.291)', abs(R.ang(m1 - 40)) <= 15, 'mean %.1f mag over 18:39:41-51' % m1)
    m2 = circ_mean(mag('18:45:21', '18:45:31'))
    C.add('official', 'HDG about 100 mag after 18:45:21 (R10 p.291)', abs(R.ang(m2 - 100)) <= 15, 'mean %.1f mag over 18:45:21-31' % m2)
    turn = unwrapped_turn([r['hdg'] for r in rows if R.sec('18:39:51') <= r['t'] <= R.sec('18:45:21')])
    C.add('official', 'Otsuki loop: right turn about 420 deg (+-30) 18:39:51-18:45:21 (R10 p.291)', abs(turn - 420) <= 30,
          'net %+.0f deg' % turn)
    def turn_of(a, b):
        return unwrapped_turn([r['hdg'] for r in rows if R.sec(a) <= r['t'] <= R.sec(b)])
    turn2 = turn_of('18:54:50', '18:56:28')
    C.add('official', 'final right turn about 375 deg (+-30) from 18:54:50 (R10 p.293: the right turn begins) to the end',
          abs(turn2 - 375) <= 30 and turn_of('18:54:50', '18:56:23') >= 330,
          'net %+.0f deg; %+.0f to the last recorded heading (18:56:23); %+.0f in track.md\'s 18:54:55-18:56:18, whose end '
          'reading is 5-7 s early (anchors.csv 18:56:18)' % (turn2, turn_of('18:54:50', '18:56:23'), turn_of('18:54:55', '18:56:18')))
    t_air = min(r['t'] for r in rows if r['gnd'] == 0)
    C.add('official', 'lift-off by 18:12:16 (R10 p.290) with pitch <= 11 deg on the wheels',
          t_air <= R.sec('18:12:16') and max(r['pitch'] for r in rows if r['gnd'] == 1) <= 11,
          'first airborne row %s; max pitch on the wheels %.1f' % (R.clock(t_air), max(r['pitch'] for r in rows if r['gnd'] == 1)))
    p0 = at(rows, R.sec('18:24:35.7'), 'pitch')
    pk = max(window(rows, 'pitch', '18:24:34', '18:24:44'), key=lambda x: x[1])
    C.add('official', 'failure: pitch rises after the 18:24:35.7 impulse, peak in 18:24:37-39 (R10 p.290, R11 pp.37-38)',
          abs(p0 - at(rows, R.sec('18:24:33'), 'pitch')) <= 1.0 and R.sec('18:24:37') <= pk[0] <= R.sec('18:24:39'),
          'pitch %.1f at 18:24:33, %.1f at 18:24:35.7, peak %.1f at %s' % (at(rows, R.sec('18:24:33'), 'pitch'), p0, pk[1], R.clock(pk[0])))

    if plots:
        draw(rows, anchors, clear, Path(plots))
    print('\n%d of %d checks failed' % (len(C.failed), len(C.results)) if C.failed else '\nall %d checks passed' % len(C.results))
    return C, rows, clear


# ---- plots ---------------------------------------------------------------------------------------------------------

def draw(rows, anchors, clear, out):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    out.mkdir(parents=True, exist_ok=True)
    lat = np.array([r['lat'] for r in rows])
    lon = np.array([r['lon'] for r in rows])
    t = np.array([r['t'] for r in rows])
    kx = math.cos(math.radians(35.5))
    colors = {'threshold': '#444', 'liftoff': '#444', 'map': '#2a6fdb', 'failure': '#d62728', 'backcalc': '#9467bd',
              'contact': '#111'}

    def circles(ax, sel):
        for a in anchors:
            if not sel(a):
                continue
            th = np.linspace(0, 2 * np.pi, 90)
            m, n = R.radii(a['lat'])
            ax.plot(a['lon'] + a['tol_m'] * np.sin(th) / n, a['lat'] + a['tol_m'] * np.cos(th) / m,
                    color=colors[a['kind']], lw=0.8, alpha=0.8, ls='--' if a['kind'] == 'backcalc' else '-')
            ax.plot(a['lon'], a['lat'], 'o', color=colors[a['kind']], ms=3)

    # map
    fig, ax = plt.subplots(figsize=(13, 10))
    ax.plot(lon, lat, '-', color='#e0782a', lw=1.3, label='reconstructed track')
    circles(ax, lambda a: True)
    for a in anchors:
        if a['kind'] in ('map', 'failure'):
            ax.annotate(a['time'][:5], (a['lon'], a['lat']), xytext=(4, -9), textcoords='offset points', fontsize=7,
                        color=colors[a['kind']])
    for tt in range(R.sec('18:14:00'), R.T_END, 120):
        la, lo_ = at(rows, tt, 'lat'), at(rows, tt, 'lon')
        ax.plot(lo_, la, 's', color='#e0782a', ms=3)
        ax.annotate(R.clock(tt)[:5], (lo_, la), xytext=(4, 4), textcoords='offset points', fontsize=8, color='#b0501a',
                    fontweight='bold')
    ax.set_aspect(1 / kx)
    ax.set_xlabel('longitude (deg E)')
    ax.set_ylabel('latitude (deg N)')
    ax.set_title('JAL 123 reconstructed track, 18:11:15-18:56:28 JST. Orange labels: track time every 2 min. '
                 'Circles: anchors and tolerances\n(blue: R05 fig.1 map fit; red: failure point K fig.16; purple dashed: '
                 'SOFT backcalc; black: runway and contact points)', fontsize=9)
    ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(out / 'track-map.png', dpi=110)
    plt.close(fig)

    # profile
    cl = sorted(clear, key=lambda c: c[1])
    ct = np.array([c[1] for c in cl])
    fig, ax = plt.subplots(figsize=(13, 5.5))
    ax.fill_between((ct - ct[0]) / 60, 0, [c[5] for c in cl], color='#8c6d46', alpha=0.55, label='GSI ground under the track')
    ax.plot((t - ct[0]) / 60, np.array([r['alt_ft'] for r in rows]) * R.FT, '-', color='#e0782a', lw=1.2,
            label='true altitude (alt_ft)')
    ticks = list(range(R.sec('18:12:00'), R.T_END, 240))
    ax.set_xticks([(x - ct[0]) / 60 for x in ticks])
    ax.set_xticklabels([R.clock(x)[:5] for x in ticks])
    ax.set_ylabel('m above mean sea level')
    ax.set_title('JAL 123: true altitude and the ground under the track (the picture is dark from 18:56:22)', fontsize=10)
    ax.legend(loc='upper left')
    ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(out / 'track-profile.png', dpi=110)
    plt.close(fig)

    # the final 3 minutes
    t0 = R.T_END - 180
    sel = t >= t0
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(15, 7), gridspec_kw={'width_ratios': [1.1, 1]})
    a1.plot(lon[sel], lat[sel], '-', color='#e0782a', lw=1.4)
    circles(a1, lambda a: a['t'] >= t0 - 60)
    for a in anchors:
        if a['t'] >= t0 - 60:
            a1.annotate('%s %s' % (a['time'], a['kind']), (a['lon'], a['lat']), xytext=(5, 5), textcoords='offset points',
                        fontsize=7, color=colors[a['kind']])
    for tt in list(range(t0, R.sec('18:56:20'), 10)) + [R.sec('18:56:22'), R.sec('18:56:24'), R.sec('18:56:26'), R.T_END]:
        la, lo_ = at(rows, tt, 'lat'), at(rows, tt, 'lon')
        a1.plot(lo_, la, 's', color='#e0782a', ms=3)
        a1.annotate(R.clock(tt)[3:8], (lo_, la), xytext=(4, -10), textcoords='offset points', fontsize=7, color='#b0501a')
    a1.set_xlim(138.66, 138.80)
    a1.set_ylim(35.94, 36.04)
    a1.set_aspect(1 / math.cos(math.radians(36)))
    a1.set_title('final 3 minutes: track, SOFT backcalc anchors (dashed) and contact points', fontsize=9)
    a1.grid(alpha=0.3)
    cs = [c for c in cl if c[1] >= t0]
    a2.fill_between([c[1] - t0 for c in cs], 1000, [c[5] for c in cs], color='#8c6d46', alpha=0.55, label='GSI ground under the track')
    a2.plot(t[sel] - t0, np.array([r['alt_ft'] for r in rows])[sel] * R.FT, '-', color='#e0782a', lw=1.4, label='true altitude')
    for a in anchors:
        if a['kind'] == 'contact' and a['t'] <= R.T_END:
            a2.plot(a['t'] - t0, a['alt_m'], 'kx')
            a2.annotate(a['time'] + ' contact', (a['t'] - t0, a['alt_m']),
                        xytext=(-60, -14), textcoords='offset points', fontsize=7)
    a2.axvspan(T_DARK - t0, R.T_END - t0, color='#000', alpha=0.12, label='dark (veil) from 18:56:22')
    a2.set_ylim(1000, max(r['alt_ft'] for r in rows if r['t'] >= t0) * R.FT + 250)
    a2.set_xticks(range(0, 181, 30))
    a2.set_xticklabels([R.clock(t0 + x)[3:8] for x in range(0, 181, 30)])
    a2.set_ylabel('m above mean sea level')
    a2.set_title('final 3 minutes: altitude and ground; x = contact heights of the part that touched', fontsize=9)
    a2.legend(loc='upper right', fontsize=8)
    a2.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(out / 'track-final.png', dpi=110)
    plt.close(fig)
    print('wrote %s/track-map.png, track-profile.png, track-final.png' % out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1].strip())
    ap.add_argument('--work', default=os.environ.get('JAL123_WORK', str(R.REPO / '.work' / 'jal123')))
    ap.add_argument('--track', default=str(R.TRACK))
    ap.add_argument('--offline', action='store_true', help='use only cached elevations')
    ap.add_argument('--plots', help='write the three PNGs to this folder')
    ap.add_argument('--anchors', default=str(R.ANCHORS), help='anchors.csv (a planted copy for a RED run)')
    args = ap.parse_args(argv)
    try:
        C, _, _ = run(args.track, args.work, args.offline, args.plots, args.anchors)
    except (OSError, KeyError, ValueError) as e:
        print('FAIL cannot check %s: %s' % (args.track, e))
        return 1
    return 1 if C.failed else 0


if __name__ == '__main__':
    sys.exit(main())

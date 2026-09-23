# tools/scenarios/jal123/reconstruct.py
# Reconstructs the JAL 123 track, public/scenarios/jal123/track.csv, from the digitized DFDR (dfdr_1hz.csv), the
# 1985-08-12 soundings and declination (winds.json) and the position anchors (anchors.csv). Design §6.1 step 3.
"""
    /usr/bin/python3 tools/scenarios/jal123/reconstruct.py [--work <FlightHopper>/.work/jal123] [--out <track.csv>]

Attitude, speed, altitude, g and EPR come from the DFDR (R11 charts, digitized by digitize.py). The position is
always reconstructed: dead reckoning of the DFDR true airspeed and true heading with the sounding wind, from the
lift-off point, plus one smooth correction in time (a penalised cubic B-spline for east and north) that brings the
path inside every anchor's tolerance. README §3 states every modelling choice. check.py checks the result.
Doctests: /usr/bin/python3 -m doctest tools/scenarios/jal123/reconstruct.py
"""
import argparse
import csv
import json
import math
import os
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
from scipy.interpolate import BSpline, PchipInterpolator, UnivariateSpline

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
ANCHORS = HERE / 'anchors.csv'
WINDS = HERE / 'winds.json'
TRACK = REPO / 'public' / 'scenarios' / 'jal123' / 'track.csv'

KT = 0.514444          # m/s per knot
FT = 0.3048
G0 = 9.80665
R_EARTH = 6371008.8    # mean radius, for geopotential -> geometric height
A_WGS, E2_WGS = 6378137.0, 6.69437999014e-3

# ---- times (JST, seconds of day) ----------------------------------------------------------------------------


def sec(clock):
    """'HH:MM:SS' or 'HH:MM:SS.ss' -> seconds of day.

    >>> sec('18:49:42'), sec('18:55:30.25')
    (67782, 68130.25)
    """
    h, m, s = clock.split(':')
    v = int(h) * 3600 + int(m) * 60 + float(s)
    return int(v) if v == int(v) else v


def clock(t):
    """Seconds of day -> 'HH:MM:SS', or 'HH:MM:SS.ss' when t is not whole.

    >>> clock(67782), clock(68130.25), clock(68130.5)
    ('18:49:42', '18:55:30.25', '18:55:30.50')
    """
    c = int(round(t * 100))
    s, cs = divmod(c, 100)
    base = '%02d:%02d:%02d' % (s // 3600, s // 60 % 60, s % 60)
    return base if cs == 0 else '%s.%02d' % (base, cs)


T_HOLD = sec('18:11:15')     # playback start: the aircraft holds on the 15L threshold (design §3.2)
T_ROLL = sec('18:11:32')     # take-off roll starts (R10 p.290, DFDR fig.2)
T_FLOOR = sec('18:11:48')    # CAS first clear of its 50 kt recording floor (60.2 kt; R10 p.282: CAS below 50 kt is not recorded)
T_4HZ = sec('18:55:30')      # 4 Hz rows from here (the final dive and pull-up)
T_DFDR_END = sec('18:56:23')  # last second with every flight channel (18:56:24 in part; R10 p.294: abnormal from ~26)
T_END = sec('18:56:28')      # last row (design §3.2 "end")
DT = 0.25                    # integration step (s)
# Pressure-altitude smoothing: the chart resolves about 100 ft (quantisation rms 29 ft). In the Dutch-roll phase the
# trace also carries 10-s wiggles of about 50 ft (sideslip on the static ports and the plotter steps) that a 30 ft
# spline turns into +-2,000 fpm of false vertical speed, so there the residual allowed is 50 ft. README §3.3.
ALT_SIGMA = (30.0, 50.0)
ALT_WIDE = (sec('18:25:00'), sec('18:47:30'))

# The failure window (R11 pp.37-38, the enlarged plots of 18:24:31-51): there the strip charts draw the 1 Hz channels
# about 1.8 s earlier than the enlarged plots do (pitch and AOA jump at 18:24:37.8 on the enlarged plots, about
# 18:24:36 on the strip chart) while VRTG agrees; the official reading (R10 p.290) times the failure sequence by the
# enlarged plots (LNGG impulse 18:24:35.7, VRTG jump 36.28, AOA and pitch rising 37-43). README §3.1.
FAIL_A, FAIL_B = sec('18:24:31'), sec('18:24:51')
FAIL_SHIFT = 1.8
FAIL_RAMP = 5.0
RETIMED = ('hdg_mag', 'cas_kt', 'alt_press_ft', 'roll', 'pitch', 'epr1', 'epr2', 'epr3', 'epr4', 'aoa')

# 747SR geometry for the contact heights (README §3.6): the No.4 engine's fan case and the right wing tip, in body
# axes from the fuselage centreline: (outboard m, below m). Half-span 29.8 m (scenario.json aircraft.shape).
ENGINE4 = (21.2, 2.6)
WINGTIP = (29.8, -1.2)

# ---- geodesy -------------------------------------------------------------------------------------------------


def radii(lat):
    """Metres per degree of latitude and of longitude on WGS84 at `lat`.

    >>> m, n = radii(35.0); round(m), round(n)
    (110941, 91288)
    """
    s = math.sin(math.radians(lat))
    w = 1 - E2_WGS * s * s
    return (A_WGS * (1 - E2_WGS) / w ** 1.5 * math.pi / 180,
            A_WGS / math.sqrt(w) * math.cos(math.radians(lat)) * math.pi / 180)


def en(lat0, lon0, lat, lon):
    """(east, north) metres of (lat, lon) from (lat0, lon0), local radii at the mid latitude (< 0.1 % over 10 km)."""
    m, n = radii((lat0 + lat) / 2)
    return (lon - lon0) * n, (lat - lat0) * m


def move(lat, lon, de, dn):
    """(lat, lon) moved by de metres east and dn metres north."""
    m, n = radii(lat + dn / 2 / 111000.0)
    return lat + dn / m, lon + de / n


def dist(lat0, lon0, lat, lon):
    e, n = en(lat0, lon0, lat, lon)
    return math.hypot(e, n)


def bearing(lat0, lon0, lat, lon):
    """True bearing, degrees 0-360, from the first point to the second.

    >>> round(bearing(35.56189, 139.76002, 35.55047, 139.76967), 1)
    145.4
    """
    e, n = en(lat0, lon0, lat, lon)
    return math.degrees(math.atan2(e, n)) % 360


def ang(a):
    """Angle to -180..180.

    >>> ang(350.0), ang(-190.0)
    (-10.0, 170.0)
    """
    return (a + 180.0) % 360.0 - 180.0


# ---- inputs --------------------------------------------------------------------------------------------------

DFDR_COLS = ['hdg_mag', 'cas_kt', 'alt_press_ft', 'roll', 'pitch', 'vrtg_g', 'epr1', 'epr2', 'epr3', 'epr4', 'aoa']


def load_dfdr(path):
    """dfdr_1hz.csv -> {'t': array, column: array with NaN for empty, 'src_page': list}."""
    with open(path, newline='') as fh:
        rows = list(csv.DictReader(fh))
    out = {'t': np.array([sec(r['time']) for r in rows], float), 'src_page': [r['src_page'] for r in rows]}
    for c in DFDR_COLS:
        out[c] = np.array([float(r[c]) if r[c] != '' else np.nan for r in rows])
    return out


def load_anchors(path=ANCHORS):
    with open(path, newline='') as fh:
        rows = list(csv.DictReader(fh))
    for r in rows:
        r['t'] = sec(r['time'])
        r['lat'], r['lon'], r['tol_m'] = float(r['lat']), float(r['lon']), float(r['tol_m'])
        r['alt_m'] = float(r['alt_ft']) * FT if r['alt_ft'] else None
    return rows


def anchor(anchors, kind, i=0):
    return [a for a in anchors if a['kind'] == kind][i]


# ---- the failure-window re-timing ----------------------------------------------------------------------------


def fail_shift(t_chart):
    """Seconds added to a strip-chart time in the failure window: 0 outside, FAIL_SHIFT over 18:24:31-51, linear ramps
    over the FAIL_RAMP seconds on each side.

    >>> [round(fail_shift(sec(c)), 2) for c in ('18:24:20', '18:24:28.5', '18:24:40', '18:24:53.5', '18:25:00')]
    [0.0, 0.9, 1.8, 0.9, 0.0]
    """
    t = np.asarray(t_chart, float)
    up = np.clip((t - (FAIL_A - FAIL_RAMP)) / FAIL_RAMP, 0, 1)
    down = np.clip(((FAIL_B + FAIL_RAMP) - t) / FAIL_RAMP, 0, 1)
    out = FAIL_SHIFT * np.minimum(up, down)
    return float(out) if out.ndim == 0 else out


def retime(table):
    """A copy of the table with the RETIMED channels resampled at whole seconds of the corrected clock: a value the
    strip chart draws at t_chart belongs at t_chart + fail_shift(t_chart)."""
    out = dict(table)
    t = table['t']
    fine = np.arange(t[0], t[-1] + 1e-9, 0.05)
    true = fine + fail_shift(fine)
    back = np.interp(t, true, fine)          # the chart time whose value belongs at each whole true second
    moved = np.abs(back - t) > 1e-9
    for c in RETIMED:
        v = table[c]
        ok = np.isfinite(v)
        f = PchipInterpolator(t[ok], v[ok], extrapolate=False) if c != 'hdg_mag' else None
        if c == 'hdg_mag':
            u = np.degrees(np.unwrap(np.radians(v[ok])))
            val = np.interp(back, t[ok], u) % 360
        elif c in ('roll', 'pitch'):
            val = catmull(t[ok], v[ok], back)
        else:
            val = f(back)
        new = v.copy()
        new[moved] = val[moved]
        out[c] = new
    out['retimed'] = moved
    return out


# ---- interpolation helpers -----------------------------------------------------------------------------------


def catmull(tk, vk, tq):
    """Catmull-Rom cubic through (tk, vk) at tq (knot tangents = central differences; ends one-sided), as digitize.py
    uses for roll and pitch: it keeps an 11 s Dutch roll's peaks where a monotone cubic flattens them.

    >>> [round(float(x), 3) for x in catmull(np.array([0., 1, 2, 3]), np.array([0., 1, 0, -1]), np.array([0.5, 1, 1.5]))]
    [0.625, 1.0, 0.625]
    """
    tk = np.asarray(tk, float)
    vk = np.asarray(vk, float)
    tq = np.asarray(tq, float)
    m = np.gradient(vk, tk)
    i = np.clip(np.searchsorted(tk, tq, side='right') - 1, 0, len(tk) - 2)
    h = tk[i + 1] - tk[i]
    s = np.clip((tq - tk[i]) / h, 0, 1)
    h00 = 2 * s ** 3 - 3 * s ** 2 + 1
    h10 = s ** 3 - 2 * s ** 2 + s
    h01 = -2 * s ** 3 + 3 * s ** 2
    h11 = s ** 3 - s ** 2
    return h00 * vk[i] + h10 * h * m[i] + h01 * vk[i + 1] + h11 * h * m[i + 1]


# ---- atmosphere (winds.json) ---------------------------------------------------------------------------------


def pressure_hpa(pa_ft):
    """Static pressure (hPa) of a pressure altitude (ft, 29.92 inHg datum; ISA troposphere).

    >>> [round(float(pressure_hpa(x)), 1) for x in (0.0, 4807.0, 23900.0)]   # FL240 is 392.7 hPa
    [1013.2, 849.2, 394.4]
    """
    return 1013.25 * (1 - 6.8755856e-6 * np.asarray(pa_ft, float)) ** 5.2558797


def pressure_alt_ft(p_hpa):
    """Inverse of pressure_hpa.

    >>> round(float(pressure_alt_ft(pressure_hpa(12345.0))), 3)
    12345.0
    """
    return (1 - (np.asarray(p_hpa, float) / 1013.25) ** (1 / 5.2558797)) / 6.8755856e-6


def tas_ms(cas_kt, p_hpa, t_k):
    """True airspeed (m/s) from calibrated airspeed, static pressure and air temperature (compressible flow).

    >>> round(float(tas_ms(300.0, 1013.25, 288.15)) / KT, 1)      # sea level ISA: TAS = CAS
    300.0
    >>> round(float(tas_ms(300.0, pressure_hpa(23900), 273.15 - 15.0)) / KT, 0)    # ISA+17 at 23,900 ft
    439.0
    """
    a0, p0 = 340.294, 1013.25
    vc = np.asarray(cas_kt, float) * KT
    qc = p0 * ((1 + 0.2 * (vc / a0) ** 2) ** 3.5 - 1)
    mach = np.sqrt(5 * ((qc / np.asarray(p_hpa, float) + 1) ** (2 / 7) - 1))
    return mach * np.sqrt(1.4 * 287.053 * np.asarray(t_k, float))


class Atmos:
    """The four soundings (Tateno 47646, Hamamatsu 47681; 00Z and 12Z) blended by time (linear from 09:00 to 21:00
    JST) and place (inverse square distance to the two stations): the height of a pressure level, its temperature, the
    wind at a height. Near Haneda the low-level wind blends into the report's Haneda surface observation."""

    def __init__(self, winds):
        self.w = winds
        self.snd = []
        for s in winds['soundings']:
            lv = [l for l in s['levels'] if l['p_hpa'] and l['h_m'] is not None and l['t_c'] is not None]
            lnp = np.log([l['p_hpa'] for l in lv])
            hgp = np.array([l['h_m'] for l in lv], float)
            z = R_EARTH * hgp / (R_EARTH - hgp)                     # geopotential -> geometric metres
            tk = np.array([l['t_c'] for l in lv]) + 273.15
            wl = [l for l in s['levels'] if l['dir_deg'] is not None and l['ms'] is not None]
            wz = np.array([l['h_m'] for l in wl], float)
            wz = R_EARTH * wz / (R_EARTH - wz)
            d = np.radians([l['dir_deg'] for l in wl])
            ms = np.array([l['ms'] for l in wl])
            self.snd.append(dict(st=s['station'], hh=int(s['time_utc'][11:13]), lat=s['lat'], lon=s['lon'],
                                 lnp=lnp[::-1], z=z[::-1], tk=tk[::-1], wz=wz, u=-ms * np.sin(d), v=-ms * np.cos(d)))
        obs = [o for o in winds['surface']['obs'] if o['place'].startswith('Tokyo International')]
        self.haneda = [(sec(o['jst'] + ':00'), o['wind_dir'], o['wind_kt']) for o in obs]
        self.decl = winds['declination']['points']

    def weights(self, t, lat, lon):
        """[(weight, sounding)]: time 09:00 -> 21:00 JST linear, space inverse square distance."""
        w12 = min(max((t - sec('09:00:00')) / (12 * 3600.0), 0.0), 1.0)
        ds = {}
        for s in self.snd:
            ds[s['st']] = max(dist(lat, lon, s['lat'], s['lon']), 1000.0) ** -2
        tot = sum(ds.values())
        return [((w12 if s['hh'] == 12 else 1 - w12) * ds[s['st']] / tot, s) for s in self.snd]

    def z_of_p(self, p_hpa, t, lat, lon):
        """Geometric height (m above MSL) of the pressure level p (linear in ln p between levels = hypsometric with a
        mean layer temperature; below the first level the lowest layer is extended)."""
        lp = math.log(p_hpa)
        z = 0.0
        for w, s in self.weights(t, lat, lon):
            z += w * float(np.interp(lp, s['lnp'], s['z'], left=None, right=None) if s['lnp'][0] <= lp <= s['lnp'][-1]
                           else self._extrap(lp, s['lnp'], s['z']))
        return z

    def t_of_p(self, p_hpa, t, lat, lon):
        lp = math.log(p_hpa)
        return sum(w * float(np.interp(lp, s['lnp'], s['tk'])) for w, s in self.weights(t, lat, lon))

    @staticmethod
    def _extrap(x, xs, ys):
        i = 0 if x < xs[0] else len(xs) - 2
        return ys[i] + (ys[i + 1] - ys[i]) * (x - xs[i]) / (xs[i + 1] - xs[i])

    def haneda_wind(self, t):
        """Haneda surface wind (from, kt) interpolated between the report's half-hourly observations (EN p.19)."""
        obs = self.haneda
        for (ta, da, ka), (tb, db, kb) in zip(obs, obs[1:]):
            if ta <= t <= tb:
                u = (t - ta) / (tb - ta)
                ua, va = -ka * math.sin(math.radians(da)), -ka * math.cos(math.radians(da))
                ub, vb = -kb * math.sin(math.radians(db)), -kb * math.cos(math.radians(db))
                x, y = ua + (ub - ua) * u, va + (vb - va) * u
                return math.degrees(math.atan2(-x, -y)) % 360, math.hypot(x, y)
        raise ValueError('no Haneda observation around %s' % clock(t))

    def wind(self, z, t, lat, lon):
        """Wind (u east, v north, m/s, the direction the air moves) at height z m. Within 40 km of Haneda and below
        1,500 m it blends linearly into the Haneda surface observation (the soundings miss the bay's sea breeze)."""
        u = v = 0.0
        for w, s in self.weights(t, lat, lon):
            u += w * float(np.interp(z, s['wz'], s['u']))
            v += w * float(np.interp(z, s['wz'], s['v']))
        dh = dist(lat, lon, 35.55, 139.78)
        f = max(0.0, 1 - dh / 40000.0) * max(0.0, 1 - max(z, 0.0) / 1500.0)
        if f > 0:
            d, k = self.haneda_wind(t)
            uh, vh = -k * KT * math.sin(math.radians(d)), -k * KT * math.cos(math.radians(d))
            u, v = u + f * (uh - u), v + f * (vh - v)
        return u, v

    def declination(self, lat, lon):
        """Magnetic declination (deg, east +) by inverse square distance over the five NOAA points of winds.json."""
        ws = [(max(dist(lat, lon, p['lat'], p['lon']), 1000.0) ** -2, p['deg']) for p in self.decl]
        return sum(w * d for w, d in ws) / sum(w for w, _ in ws)


def wind_from(u, v):
    """(direction the wind comes from, degrees true; speed kt) of a wind vector (u east, v north, m/s).

    >>> d, k = wind_from(0.0, -5.0); round(d), round(k, 1)
    (0, 9.7)
    """
    return math.degrees(math.atan2(-u, -v)) % 360, math.hypot(u, v) / KT


# ---- GSI elevation (orthometric, m) --------------------------------------------------------------------------

DEM_URL = 'https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=%.6f&lat=%.6f&outtype=JSON'


class Dem:
    """GSI elevation API with a JSON cache. Keys are 'lat,lon' at 5 decimals (about 1 m). Sea and no-data = 0 m.
    At most `rate` requests per second."""

    def __init__(self, cache_path, rate=4.0, offline=False):
        self.path = Path(cache_path)
        self.rate = rate
        self.offline = offline
        self.cache = json.loads(self.path.read_text()) if self.path.exists() else {}
        self.fetched = 0
        self._last = 0.0

    @staticmethod
    def key(lat, lon):
        return '%.5f,%.5f' % (lat, lon)

    def get(self, lat, lon):
        k = self.key(lat, lon)
        if k not in self.cache:
            if self.offline:
                raise KeyError('elevation not cached: %s (run without --offline)' % k)
            wait = 1.0 / self.rate - (time.time() - self._last)
            if wait > 0:
                time.sleep(wait)
            la, lo = map(float, k.split(','))
            for attempt in range(4):
                try:
                    with urllib.request.urlopen(DEM_URL % (lo, la), timeout=30) as r:
                        e = json.loads(r.read().decode())['elevation']
                    break
                except Exception:
                    if attempt == 3:
                        raise
                    time.sleep(2.0 * (attempt + 1))
            self._last = time.time()
            self.cache[k] = float(e) if isinstance(e, (int, float)) else None     # '-----' = sea / no data
            self.fetched += 1
            if self.fetched % 50 == 0:
                self.save()
        e = self.cache[k]
        return 0.0 if e is None else e

    def prefetch(self, points, workers=10):
        """Fetch every uncached (lat, lon) with a few parallel connections, still at most `rate` requests a second."""
        import threading
        from concurrent.futures import ThreadPoolExecutor
        keys = sorted({self.key(la, lo) for la, lo in points} - set(self.cache))
        if not keys or self.offline:
            return 0
        lock = threading.Lock()
        slot = [time.time()]

        def one(k):
            with lock:                       # the next free start slot, 1/rate apart
                start = max(slot[0], time.time())
                slot[0] = start + 1.0 / self.rate
            time.sleep(max(0.0, start - time.time()))
            la, lo = map(float, k.split(','))
            for attempt in range(4):
                try:
                    with urllib.request.urlopen(DEM_URL % (lo, la), timeout=30) as r:
                        e = json.loads(r.read().decode())['elevation']
                    return k, (float(e) if isinstance(e, (int, float)) else None)
                except Exception:
                    if attempt == 3:
                        raise
                    time.sleep(2.0 * (attempt + 1))

        done = 0
        with ThreadPoolExecutor(workers) as ex:
            for k, e in ex.map(one, keys):
                self.cache[k] = e
                done += 1
                if done % 200 == 0:
                    self.save()
                    print('  DEM: %d of %d fetched' % (done, len(keys)), flush=True)
        self.fetched += done
        self.save()
        return done

    def save(self):
        tmp = self.path.with_suffix('.tmp')
        tmp.write_text(json.dumps(self.cache, separators=(',', ':'), sort_keys=True))
        tmp.replace(self.path)


# ---- the reconstruction --------------------------------------------------------------------------------------


def part_drop(part, roll_deg):
    """Metres a part hangs below the fuselage centreline at a right bank (pitch ignored: < 1 m at 10 deg).

    >>> round(part_drop(ENGINE4, 45.9), 1), round(part_drop(WINGTIP, 60.0), 1)
    (17.0, 25.2)
    """
    y, below = part
    r = math.radians(roll_deg)
    return y * math.sin(r) + below * math.cos(r)


def fill_gaps(t, v):
    """Linear fill of empty cells; returns (filled, was_empty)."""
    ok = np.isfinite(v)
    out = v.copy()
    out[~ok] = np.interp(t[~ok], t[ok], v[ok])
    return out, ~ok


class Recon:
    """Every step of the reconstruction (run() in order); build_rows(recon) gives the track.csv rows."""

    def __init__(self, work, anchors_path=ANCHORS, winds_path=WINDS, offline=False, log=print):
        self.log = log
        self.work = Path(work)
        self.anchors = load_anchors(anchors_path)
        self.atm = Atmos(json.loads(Path(winds_path).read_text()))
        self.dem = Dem(self.work / 'elev-cache.json', offline=offline)
        raw = load_dfdr(self.work / 'dfdr_1hz.csv')
        self.raw = raw
        self.tab = retime(raw)
        self.thr = anchor(self.anchors, 'threshold')
        self.lo = anchor(self.anchors, 'liftoff')
        self.t_lo = self.lo['t']
        contacts = [a for a in self.anchors if a['kind'] == 'contact']
        self.larch, self.ditch, self.ridge = contacts
        self.rwy_brg = bearing(self.thr['lat'], self.thr['lon'], self.lo['lat'], self.lo['lon'])
        self.s_lo = dist(self.thr['lat'], self.thr['lon'], self.lo['lat'], self.lo['lon'])

    # -- 1 Hz channels, gaps filled ------------------------------------------------------------------------
    def channels(self):
        tab = self.tab
        t = tab['t']
        filled = {}
        gap = np.zeros(len(t), bool)
        last = t <= T_DFDR_END
        for c in ('hdg_mag', 'cas_kt', 'alt_press_ft', 'roll', 'pitch'):
            v = tab[c].copy()
            f, g = fill_gaps(t[last], v[last])
            v[last] = f
            filled[c] = v
            gap[last] |= g
        if 'hdg_mag' in filled:          # heading gaps: fill on the unwrapped circle
            v = tab['hdg_mag'][last]
            ok = np.isfinite(v)
            u = np.degrees(np.unwrap(np.radians(v[ok])))
            filled['hdg_mag'][last] = np.interp(t[last], t[last][ok], u) % 360
        self.ch = filled
        self.gap = gap
        return filled

    # -- altitude ----------------------------------------------------------------------------------------------
    def altitude(self):
        """Smoothed pressure altitude (the chart resolves about 100 ft), then true altitude from the soundings with
        one pressure bias tied to the larch contact (README §3.3)."""
        t = self.tab['t']
        pa = self.ch['alt_press_ft']
        m = (t >= self.t_lo) & (t <= T_DFDR_END + 1) & np.isfinite(pa)
        tt, yy = t[m], pa[m]
        sig = np.where((tt >= ALT_WIDE[0]) & (tt <= ALT_WIDE[1]), ALT_SIGMA[1], ALT_SIGMA[0])
        self.pa_spline = UnivariateSpline(tt, yy, w=1 / sig, k=3, s=len(tt))
        res = yy - self.pa_spline(tt)
        self.log('altitude: smoothing spline, residual rms %.0f ft (%.0f ft in the Dutch-roll window), max %.0f ft'
                 % (res.std(), res[sig > ALT_SIGMA[0]].std(), np.abs(res).max()))
        return self.pa_spline

    # -- the take-off roll ---------------------------------------------------------------------------------------
    def _roll_setup(self):
        """The ground speed along the runway (m/s): from rest at 18:11:32; from 18:11:48 the DFDR CAS as
        GS = CAS * TAS/CAS - headwind (29 C, QNH 29.93; the Haneda wind interpolated to 18:12, EN p.19); between, an
        acceleration varying linearly in time that meets both the 18:11:48 speed and the lift-off anchor's distance
        (README §3.2)."""
        t = self.tab['t']
        cas = self.ch['cas_kt']
        self.k_tas = math.sqrt((273.15 + 29) / 288.15 * 29.92 / 29.93)
        d, k = self.atm.haneda_wind(sec('18:12:00'))
        self.hw_kt = k * math.cos(math.radians(d - self.rwy_brg))
        sel = (t >= T_FLOOR) & (t <= self.t_lo)
        self.roll_t = t[sel]
        self.roll_gs = (cas[sel] * self.k_tas - self.hw_kt) * KT
        trace = float(np.trapezoid(self.roll_gs, self.roll_t))
        v1 = self.roll_gs[0]
        T = T_FLOOR - T_ROLL
        early = self.s_lo - trace
        # a(t) = a0 + a1 t from rest: v(T) = a0 T + a1 T^2/2 = v1 ; s(T) = a0 T^2/2 + a1 T^3/6 = early
        A = np.array([[T, T * T / 2], [T * T / 2, T ** 3 / 6]])
        self.a0, self.a1 = np.linalg.solve(A, [v1, early])
        self.roll_trace, self.roll_early = trace, early
        self.log('take-off roll: trace 18:11:48-%s %.0f m, early segment %.0f m (a %.2f -> %.2f m/s2), '
                 'headwind %.1f kt, TAS/CAS %.4f' % (clock(self.t_lo), trace, early, self.a0,
                                                    self.a0 + self.a1 * T, self.hw_kt, self.k_tas))

    def roll_s(self, t):
        """Distance (m) along the centreline from the threshold row at time t."""
        if t <= T_ROLL:
            return 0.0
        tau = min(t, T_FLOOR) - T_ROLL
        s = self.a0 * tau * tau / 2 + self.a1 * tau ** 3 / 6
        if t > T_FLOOR:
            tt = np.append(self.roll_t[self.roll_t < t], t)
            vv = np.interp(tt, self.roll_t, self.roll_gs)
            s += float(np.trapezoid(vv, tt))
        return s

    def roll_v(self, t):
        if t <= T_ROLL:
            return 0.0
        if t <= T_FLOOR:
            tau = t - T_ROLL
            return self.a0 * tau + self.a1 * tau * tau / 2
        return float(np.interp(t, self.roll_t, self.roll_gs))

    # -- dead reckoning ------------------------------------------------------------------------------------------
    def dead_reckon(self, bias=1.0):
        """Fine grid from lift-off to 18:56:23 at DT. At each step, at the current DR position: true altitude of the
        smoothed pressure altitude, air temperature, TAS, true heading (magnetic + declination) and wind; the DR
        position advances by Heun's rule (the velocity at the predicted point) from the lift-off point."""
        t1 = self.tab['t']
        g = np.arange(self.t_lo, T_DFDR_END + 1e-9, DT)
        ok = t1 <= T_DFDR_END
        hdg_u = np.degrees(np.unwrap(np.radians(self.ch['hdg_mag'][ok])))
        hdg = PchipInterpolator(t1[ok], hdg_u)(g)
        cas = PchipInterpolator(t1[ok], self.ch['cas_kt'][ok])(g)
        pa = self.pa_spline(g)
        dpa = self.pa_spline.derivative()(g)
        n = len(g)
        lat, lon, z, vz, tas, tru, wu, wv = (np.empty(n) for _ in range(8))
        atm = self.atm

        def state(i, la, lo):
            p = float(pressure_hpa(pa[i])) * bias
            zi = atm.z_of_p(p, g[i], la, lo)
            dzdpa = (atm.z_of_p(float(pressure_hpa(pa[i] + 20.0)) * bias, g[i], la, lo) - zi) / 20.0
            ti = float(tas_ms(cas[i], p, atm.t_of_p(p, g[i], la, lo)))
            ps = hdg[i] + atm.declination(la, lo)
            u, v = atm.wind(zi, g[i], la, lo)
            return zi, dzdpa * dpa[i], ti, ps, u, v

        def vel(zi, vzi, ti, ps, u, v):
            vh = ti * math.cos(math.asin(max(-0.95, min(0.95, vzi / ti))))
            return vh * math.sin(math.radians(ps)) + u, vh * math.cos(math.radians(ps)) + v

        lat[0], lon[0] = self.lo['lat'], self.lo['lon']
        st = state(0, lat[0], lon[0])
        for i in range(n):
            z[i], vz[i], tas[i], tru[i], wu[i], wv[i] = st
            if i == n - 1:
                break
            e0, n0 = vel(*st)
            pla, plo = move(lat[i], lon[i], e0 * DT, n0 * DT)
            st1 = state(i + 1, pla, plo)
            e1, n1 = vel(*st1)
            lat[i + 1], lon[i + 1] = move(lat[i], lon[i], (e0 + e1) / 2 * DT, (n0 + n1) / 2 * DT)
            st = state(i + 1, lat[i + 1], lon[i + 1])
        self.g, self.z_raw, self.vz_raw, self.tas, self.tru, self.wind_uv = g, z, vz, tas, tru, (wu, wv)
        return g

    def integrate(self, z):
        """DR positions again (trapezoid) with the climb angle of the final true altitude z; TAS, heading and wind as
        dead_reckon found them (their dependence on the position is far below a metre per second)."""
        g, tas, tru = self.g, self.tas, self.tru
        wu, wv = self.wind_uv
        vz = np.gradient(z, g)
        vz[1:-1] = (z[2:] - z[:-2]) / (2 * DT)
        gam = np.arcsin(np.clip(vz / tas, -0.95, 0.95))
        vh = tas * np.cos(gam)
        ve = vh * np.sin(np.radians(tru)) + wu
        vn = vh * np.cos(np.radians(tru)) + wv
        n = len(g)
        lat = np.empty(n)
        lon = np.empty(n)
        lat[0], lon[0] = self.lo['lat'], self.lo['lon']
        for i in range(1, n):
            lat[i], lon[i] = move(lat[i - 1], lon[i - 1], (ve[i - 1] + ve[i]) / 2 * DT, (vn[i - 1] + vn[i]) / 2 * DT)
        self.vz, self.gam, self.ve, self.vn = vz, gam, ve, vn
        self.dr_lat, self.dr_lon = lat, lon
        return lat, lon

    # -- the correction ------------------------------------------------------------------------------------------
    def fit_correction(self, knot_s=60.0, lam1=1e-5, lam2=3e2, goal=0.95, iters=60):
        """c(t) east and north (m) added to the DR: a constant velocity w (a wind the soundings miss) plus a cubic
        B-spline s(t), minimising  sum_a w_a |c(t_a) - r_a|^2 + lam1 int s'^2 + lam2 int c''^2  with w_a = 1/tol^2
        (SOFT backcalc rows x 0.25); c = 0 and c' = 0 at lift-off (the runway roll carries on) and c = r at the larch
        are hard rows. Anchors outside goal x tol get their weight x2 and the fit repeats (README §3.4)."""
        g = self.g
        t0, t1 = g[0], g[-1]
        inner = np.arange(t0 + knot_s, t1 - knot_s / 2, knot_s)
        k = 3
        knots = np.concatenate([[t0] * (k + 1), inner, [t1] * (k + 1)])
        nb = len(knots) - k - 1
        B = BSpline.design_matrix(g, knots, k).toarray()
        eye = np.eye(nb)
        D1 = np.column_stack([BSpline(knots, eye[j], k).derivative(1)(g) for j in range(nb)])
        D2 = np.column_stack([BSpline(knots, eye[j], k).derivative(2)(g) for j in range(nb)])
        SC = 1000.0                                  # the linear column in km per 1000 s: keeps the system scaled
        tau = (g - t0) / SC
        Bx = np.column_stack([B, tau])
        D1x = np.column_stack([D1, np.full(len(g), 1 / SC)])
        R = np.zeros((nb + 1, nb + 1))
        R[:nb, :nb] = lam1 * (D1.T @ D1) * DT + lam2 * (D2.T @ D2) * DT
        idx = lambda t: int(round((t - t0) / DT))
        rows = []
        for a in self.anchors:
            if not (a['kind'] in ('map', 'failure', 'backcalc') or a is self.larch):
                continue
            i = idx(a['t'])
            e, n = en(self.dr_lat[i], self.dr_lon[i], a['lat'], a['lon'])
            w = (1e4 if a is self.larch else 0.25 if a['kind'] == 'backcalc' else 1.0) / a['tol_m'] ** 2
            rows.append([a, i, e, n, w])
        HARD = 1e6
        for it in range(iters):
            A = R.copy()
            be = np.zeros(nb + 1)
            bn = np.zeros(nb + 1)
            for vec in (Bx[0], D1x[0] * 60.0):
                A += HARD * np.outer(vec, vec)
            for a, i, e, n, w in rows:
                A += w * np.outer(Bx[i], Bx[i])
                be += w * Bx[i] * e
                bn += w * Bx[i] * n
            ce = np.linalg.solve(A, be)
            cn = np.linalg.solve(A, bn)
            cE, cN = Bx @ ce, Bx @ cn
            worst = 0.0
            for r in rows:
                a, i, e, n, w = r
                q = math.hypot(cE[i] - e, cN[i] - n) / a['tol_m']
                worst = max(worst, q)
                if q > goal:
                    r[4] = w * 2
            if worst <= goal:
                break
        self.fit_iters = it + 1
        self.cE, self.cN = cE, cN
        self.cvel = (D1x @ ce, D1x @ cn)
        self.wind_extra = (ce[-1] / SC, cn[-1] / SC)
        self.fit_rows = rows
        d, kt = wind_from(*self.wind_extra)
        sv = np.hypot(D1 @ ce[:nb], D1 @ cn[:nb])
        self.log('correction: %d passes; constant part = a wind from %03.0f at %.1f kt; the smooth part adds at most '
                 '%.1f m/s (mean %.1f); worst anchor at %.2f of its tolerance' % (self.fit_iters, d, kt, sv.max(),
                                                                                sv.mean(), worst))
        return cE, cN

    def corrected(self):
        lat = np.empty(len(self.g))
        lon = np.empty(len(self.g))
        for i in range(len(self.g)):
            lat[i], lon[i] = move(self.dr_lat[i], self.dr_lon[i], self.cE[i], self.cN[i])
        self.lat, self.lon = lat, lon
        return lat, lon

    # -- the whole pipeline ------------------------------------------------------------------------------------
    def run(self):
        self.channels()
        self._roll_setup()
        self.altitude()
        self.tie_larch()
        self.dead_reckon(self.bias)
        self.join_liftoff()
        self.integrate(self.z)
        self.fit_correction()
        self.corrected()
        self.final_segment()
        return self

    def tie_larch(self):
        """The one pressure bias (the "QNH") that puts the fuselage centreline at the larch's cut height plus the No.4
        engine's drop below the centreline at the recorded bank, at the larch second (README §3.3)."""
        la = self.larch
        roll_l = float(np.interp(la['t'], self.tab['t'], self.ch['roll']))
        self.larch_roll = roll_l
        self.larch_centre = la['alt_m'] + part_drop(ENGINE4, roll_l)
        p_l = float(pressure_hpa(self.pa_spline(la['t'])))
        lo, hi = 0.97, 1.03
        for _ in range(60):
            mid = (lo + hi) / 2
            if self.atm.z_of_p(p_l * mid, la['t'], la['lat'], la['lon']) > self.larch_centre:
                lo = mid          # more pressure at the same reading = a lower height
            else:
                hi = mid
        self.bias = (lo + hi) / 2
        self.z_larch_snd = self.atm.z_of_p(p_l, la['t'], la['lat'], la['lon'])
        self.log('larch tie: centreline %.1f m (cut %.0f m + No.4 engine %.1f m below at bank %.1f); the soundings '
                 'alone give %.1f m; pressure bias %+.2f hPa at the surface (%+.1f m here)'
                 % (self.larch_centre, la['alt_m'], part_drop(ENGINE4, roll_l), roll_l, self.z_larch_snd,
                    1013.25 * (self.bias - 1), self.larch_centre - self.z_larch_snd))

    def join_liftoff(self):
        """The wheels leave the runway (the DEM at the lift-off point) at the lift-off second; the height joins the
        DFDR-derived altitude 8 s later with a cubic that starts level; a fading offset takes the difference between
        the runway's DEM height and the sounding height of the runway's pressure reading out over 60 s (README §3.2)."""
        z = self.z_raw.copy()
        self.rwy_z = self.dem.get(self.lo['lat'], self.lo['lon'])
        t, pa = self.tab['t'], self.ch['alt_press_ft']
        self.rwy_pa = float(np.mean(pa[(t >= self.t_lo - 12) & (t <= self.t_lo)]))     # the runway reading
        self.rwy_snd = self.atm.z_of_p(float(pressure_hpa(self.rwy_pa)) * self.bias, self.t_lo, self.lo['lat'], self.lo['lon'])
        off = self.rwy_z - self.rwy_snd
        fade = np.clip(1 - (self.g - self.t_lo) / 60.0, 0, 1)
        z = z + off * fade
        T = 8.0
        j = int(round(T / DT))
        zj, vj = z[j], (z[j + 1] - z[j - 1]) / (2 * DT)
        tau = self.g[:j + 1] - self.t_lo
        h = zj - self.rwy_z
        b = (vj * T - 2 * h) / T ** 3          # h(tau) = a tau^2 + b tau^3: h(T) = h, h'(T) = vj
        a = (h - b * T ** 3) / T ** 2
        z[:j + 1] = self.rwy_z + a * tau ** 2 + b * tau ** 3
        self.z = z
        self.liftoff_join = dict(a=a, b=b, h=h, vj=vj, off=off)
        self.log('lift-off: runway DEM %.1f m; the runway reading %.0f ft is %.1f m on the soundings (offset faded over '
                 '60 s); the climb joins the DFDR after 8 s at %.0f m above the runway, %.1f m/s; initial vertical '
                 'acceleration %.2f g' % (self.rwy_z, self.rwy_pa, self.rwy_snd, h, vj, 2 * a / G0))

    # -- 18:56:23 to 18:56:28: after the DFDR traces end ----------------------------------------------------------
    def final_segment(self):
        """Horizontal: cubic Hermite pieces from the larch (the corrected path's position and velocity at 18:56:23)
        through the U-shaped ditch at 18:56:26 toward the ridge at 18:56:29 (a SOFT anchor: it only sets the direction
        after the ditch; no row after 18:56:28). Vertical: the recorded pull-up carried on, vertical acceleration
        g (n cos(roll) cos(pitch) - 1) with n = 3 (VRTG 2.96 at 18:56:23, 3.07 at 18:56:24), the roll as recorded to
        18:56:24 (59.5) and then held, the pitch held at its last value (7.1 at 18:56:23), up to the ditch second; after
        it the vertical speed is held. README §3.6."""
        i = len(self.g) - 1
        t0 = self.g[i]
        lat0, lon0 = self.lat[i], self.lon[i]
        v0e = self.ve[i] + self.cvel[0][i]
        v0n = self.vn[i] + self.cvel[1][i]
        pts = [(t0, 0.0, 0.0)]
        for a in (self.ditch, self.ridge):
            e, n = en(lat0, lon0, a['lat'], a['lon'])
            pts.append((a['t'], e, n))
        (ta, ea, na), (tb, eb, nb), (tc, ec, nc) = pts
        m0 = (v0e, v0n)
        m1 = ((ec - ea) / (tc - ta), (nc - na) / (tc - ta))
        m2 = ((ec - eb) / (tc - tb), (nc - nb) / (tc - tb))
        self.fin_pts = pts

        def herm(t, t_a, p_a, m_a, t_b, p_b, m_b):
            h = t_b - t_a
            s = (t - t_a) / h
            h00, h10, h01, h11 = 2 * s ** 3 - 3 * s ** 2 + 1, s ** 3 - 2 * s ** 2 + s, -2 * s ** 3 + 3 * s ** 2, s ** 3 - s ** 2
            return h00 * p_a + h10 * h * m_a + h01 * p_b + h11 * h * m_b

        tab = self.tab
        t24 = T_DFDR_END + 1
        self.roll_last = float(tab['roll'][tab['t'] == t24][0])            # 59.5 at 18:56:24, the last roll
        self.pitch_last = float(tab['pitch'][tab['t'] == T_DFDR_END][0])    # 7.1 at 18:56:23, the last pitch
        ok = np.isfinite(tab['roll'])
        n_g = 3.0

        def roll_at(t):
            return float(catmull(tab['t'][ok], tab['roll'][ok], np.array([min(t, t24)]))[0])

        z, vz = self.z[i], self.vz[i]
        out = []
        t = t0
        while t < T_END - 1e-9:
            # the vertical: small steps, the acceleration of the pull-up while t <= the ditch second
            for _ in range(5):
                h = DT / 5
                az = 0.0
                if t < self.ditch['t'] - 1e-9:
                    az = G0 * (n_g * math.cos(math.radians(roll_at(t + h / 2))) * math.cos(math.radians(self.pitch_last)) - 1)
                z += vz * h + az * h * h / 2
                vz += az * h
                t += h
            seg = (ta, ea, na, m0, tb, eb, nb, m1) if t <= tb + 1e-9 else (tb, eb, nb, m1, tc, ec, nc, m2)
            e = herm(t, seg[0], seg[1], seg[3][0], seg[4], seg[5], seg[7][0])
            n = herm(t, seg[0], seg[2], seg[3][1], seg[4], seg[6], seg[7][1])
            la, lo = move(lat0, lon0, e, n)
            out.append((round(t, 6), la, lo, z, vz, roll_at(t)))
        self.fin = out
        return out


# ---- rows ------------------------------------------------------------------------------------------------------

COLUMNS = ['time', 'lat', 'lon', 'alt_ft', 'hdg', 'pitch', 'roll', 'gnd', 'ias_kt', 'gs_kt', 'vs_fpm', 'g',
           'wind_dir', 'wind_kt', 'epr1', 'epr2', 'epr3', 'epr4', 'q', 'src']


def build_rows(rc):
    """The track.csv rows (dicts with numbers, formatted by write_track)."""
    tab, ch = rc.tab, rc.ch
    t1 = tab['t']
    atm = rc.atm
    rows = []

    def src_pages(t):
        i = int(np.argmin(np.abs(t1 - round(t))))
        sp = tab['src_page'][i]
        pages = '/'.join(p.split(':')[1] for p in sp.split()) if sp else ''
        return 'R11:' + pages if pages else 'R11'

    def dfdr_at(t, c):
        v = tab[c] if c in ('vrtg_g', 'epr1', 'epr2', 'epr3', 'epr4') else ch[c]
        ok = np.isfinite(v)
        if c in ('roll', 'pitch'):
            return float(catmull(t1[ok], v[ok], np.array([t]))[0])
        if c == 'hdg_mag':
            u = np.degrees(np.unwrap(np.radians(v[ok])))
            return float(PchipInterpolator(t1[ok], u)(t)) % 360
        if c in ('vrtg_g', 'epr1', 'epr2', 'epr3', 'epr4'):
            j = int(round(t))
            if abs(t - j) < 1e-9:
                k = np.where(t1 == j)[0]
                return float(v[k[0]]) if len(k) and np.isfinite(v[k[0]]) else None
            a, b = math.floor(t), math.ceil(t)
            ka, kb = np.where(t1 == a)[0], np.where(t1 == b)[0]
            if len(ka) and len(kb) and np.isfinite(v[ka[0]]) and np.isfinite(v[kb[0]]):
                return float(v[ka[0]] + (v[kb[0]] - v[ka[0]]) * (t - a))
            return None
        return float(PchipInterpolator(t1[ok], v[ok])(t))

    def gap_at(t):
        a, b = math.floor(t), math.ceil(t)
        return bool(rc.gap[(t1 == a) | (t1 == b)].any())

    decl_rwy = atm.declination(rc.thr['lat'], rc.thr['lon'])
    hw_d, hw_k = atm.haneda_wind(sec('18:12:00'))
    times = [float(x) for x in range(T_HOLD, T_4HZ)] + list(np.arange(T_4HZ, T_END + 1e-9, 0.25))
    g0 = rc.g[0]
    for t in times:
        r = {'time': clock(t)}
        if t <= rc.t_lo:
            s = rc.roll_s(t)
            la, lo = move(rc.thr['lat'], rc.thr['lon'], s * math.sin(math.radians(rc.rwy_brg)),
                          s * math.cos(math.radians(rc.rwy_brg)))
            z_thr, z_lo = rc.dem.get(rc.thr['lat'], rc.thr['lon']), rc.dem.get(rc.lo['lat'], rc.lo['lon'])
            r.update(lat=la, lon=lo, alt_m=z_thr + (z_lo - z_thr) * s / rc.s_lo, gnd=1, gs=rc.roll_v(t) / KT, vs=0.0,
                     wind=(hw_d, hw_k))
            if t < T_ROLL:
                r.update(hdg=(float(ch['hdg_mag'][0]) + decl_rwy) % 360, pitch=float(ch['pitch'][0]),
                         roll=float(ch['roll'][0]), ias=None, g=None, epr=[None] * 4, q='R', src='GSI:15L threshold')
            else:
                r.update(hdg=(dfdr_at(t, 'hdg_mag') + decl_rwy) % 360, pitch=dfdr_at(t, 'pitch'),
                         roll=dfdr_at(t, 'roll'), g=dfdr_at(t, 'vrtg_g'),
                         epr=[dfdr_at(t, 'epr%d' % k) for k in (1, 2, 3, 4)])
                floor = t < T_FLOOR
                r.update(ias=None if floor else dfdr_at(t, 'cas_kt'), q='R' if floor else 'M',
                         src='GSI:15L roll' if floor else src_pages(t))
            rows.append(r)
            continue
        if t <= T_DFDR_END + 1e-9:
            i = int(round((t - g0) / DT))
            la, lo = rc.lat[i], rc.lon[i]
            ve, vn = rc.ve[i] + rc.cvel[0][i], rc.vn[i] + rc.cvel[1][i]
            decl = atm.declination(la, lo)
            u, v = rc.wind_uv[0][i], rc.wind_uv[1][i]
            wd, wk = wind_from(u, v)
            join = t < rc.t_lo + 8.0
            q = 'R' if (gap_at(t) or join) else 'M'
            src = src_pages(t)
            if rc.tab['retimed'][(t1 == math.floor(t)) | (t1 == math.ceil(t))].any():
                src += ' retimed pp.37-38'
            r.update(lat=la, lon=lo, alt_m=rc.z[i], gnd=0, hdg=(dfdr_at(t, 'hdg_mag') + decl) % 360,
                     pitch=dfdr_at(t, 'pitch'), roll=dfdr_at(t, 'roll'), ias=dfdr_at(t, 'cas_kt'),
                     gs=math.hypot(ve, vn) / KT, vs=rc.vz[i] / FT * 60, g=dfdr_at(t, 'vrtg_g'),
                     epr=[dfdr_at(t, 'epr%d' % k) for k in (1, 2, 3, 4)], wind=(wd, wk), q=q, src=src)
            rows.append(r)
            continue
        # modelled: after the traces end
        k = int(round((t - rc.fin[0][0]) / DT))
        tf, la, lo, z, vz, roll = rc.fin[k]
        g = None
        if t <= T_DFDR_END + 1:                                  # VRTG to 18:56:24 (3.07), linear
            g = dfdr_at(T_DFDR_END, 'vrtg_g') + (dfdr_at(T_DFDR_END + 1, 'vrtg_g') - dfdr_at(T_DFDR_END, 'vrtg_g')) * (t - T_DFDR_END)
        rows.append(dict(time=clock(t), lat=la, lon=lo, alt_m=z, vs=vz / FT * 60, roll=roll, g=g, gnd=0, q='R',
                         src='EN:p.8 larch-ditch-ridge'))
    finish_modelled(rc, rows)
    return rows


def finish_modelled(rc, rows):
    """Heading, pitch, speeds and wind of the modelled rows after 18:56:23 (README §3.6): the heading follows the path's
    track, with the last recorded heading's offset from the track fading out over 2 s; pitch held; ground speed from
    the path; the wind of the last DFDR row."""
    idx = [k for k, r in enumerate(rows) if 'hdg' not in r]
    if not idx:
        return
    last = rows[idx[0] - 1]
    before = rows[idx[0] - 2]
    t_last = sec(last['time'])
    crab0 = ang(last['hdg'] - bearing(before['lat'], before['lon'], last['lat'], last['lon']))
    pts = [(sec(r['time']), r['lat'], r['lon']) for r in rows[idx[0] - 1:]]
    pts.append((rc.ridge['t'], rc.ridge['lat'], rc.ridge['lon']))
    for j, k in enumerate(idx):
        tp, lap, lop = pts[j]
        t = pts[j + 1][0]
        tn, lan, lon_ = pts[j + 2]
        trk = bearing(lap, lop, lan, lon_)
        crab = crab0 * max(0.0, 1 - (t - t_last) / 2.0)
        r = rows[k]
        r.update(hdg=(trk + crab) % 360, pitch=rc.pitch_last, ias=None, gs=dist(lap, lop, lan, lon_) / (tn - tp) / KT,
                 epr=[None] * 4, wind=last['wind'])


def fmt(v, nd):
    if v is None or (isinstance(v, float) and not math.isfinite(v)):
        return ''
    s = ('%.' + str(nd) + 'f') % v
    return '0' if s in ('-0', '-0.0', '-0.00') and nd <= 2 and float(s) == 0 else s


def write_track(rows, path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w', newline='') as fh:
        w = csv.writer(fh, lineterminator='\n')
        w.writerow(COLUMNS)
        for r in rows:
            epr = r.get('epr') or [None] * 4
            wd, wk = r.get('wind') or (None, None)
            w.writerow([r['time'], fmt(r['lat'], 6), fmt(r['lon'], 6), fmt(r['alt_m'] / FT, 0), fmt(r['hdg'] % 360, 1),
                        fmt(r['pitch'], 1), fmt(r['roll'], 1), r['gnd'], fmt(r['ias'], 1), fmt(r['gs'], 1),
                        fmt(r['vs'], 0), fmt(r['g'], 2), fmt(wd, 0), fmt(wk, 0)] +
                       [fmt(e, 3) for e in epr] + [r['q'], r['src']])


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1].strip())
    ap.add_argument('--work', default=os.environ.get('JAL123_WORK', str(REPO / '.work' / 'jal123')),
                    help='the git-ignored work folder with dfdr_1hz.csv; default $JAL123_WORK or <repo>/.work/jal123')
    ap.add_argument('--out', default=str(TRACK))
    ap.add_argument('--offline', action='store_true', help='use only cached elevations')
    args = ap.parse_args(argv)
    rc = Recon(args.work, offline=args.offline).run()
    rows = build_rows(rc)
    write_track(rows, args.out)
    rc.dem.save()
    print('wrote %s: %d rows %s..%s' % (args.out, len(rows), rows[0]['time'], rows[-1]['time']))
    return 0


if __name__ == '__main__':
    sys.exit(main())

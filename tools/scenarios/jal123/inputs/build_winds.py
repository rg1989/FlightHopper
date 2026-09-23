# tools/scenarios/jal123/inputs/build_winds.py
# Builds tools/scenarios/jal123/winds.json from the verbatim sounding pages (soundings_raw.py), the report's surface
# observations and the NOAA declination points, with consistency checks (D3; moved here from .work/jal123/d3 in D4).
# usage: /usr/bin/python3 tools/scenarios/jal123/inputs/build_winds.py [--write]
#   without --write: runs the checks and fails unless winds.json is byte-identical to what it would write.
import json, math, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from soundings_raw import METRIC, AVIATION

OUT = str(Path(__file__).resolve().parents[1] / 'winds.json')
W = 7

def fields(line, n):
    out = []
    for i in range(n):
        s = line[i * W:(i + 1) * W].strip()
        out.append(float(s) if s else None)
    return out

def rows(txt, n):
    return [fields(l, n) for l in txt.strip('\n').split('\n') if l.strip()]

STATIONS = {
    '47646': dict(name='TATENO, JAPAN', lat=36.050, lon=140.130),
    '47681': dict(name='HAMAMATSU AB, JAPAN', lat=34.730, lon=137.670),
}
BASE = 'https://weather.uwyo.edu/wsgi/sounding?datetime=1985-08-12%20{hh}:00:00&id={id}'

problems = []
soundings = []
for (sid, hh) in [('47646', '00'), ('47646', '12'), ('47681', '00'), ('47681', '12')]:
    m = rows(METRIC[(sid, hh)], 11)
    a = rows(AVIATION[(sid, hh)], 8)
    if len(m) != len(a):
        problems.append(f'{sid} {hh}: {len(m)} metric rows vs {len(a)} aviation rows')
    levels = []
    for i, (rm, ra) in enumerate(zip(m, a)):
        p, hm, t, td, rh, mx, d, ms = rm[:8]
        p2, hft, t2, td2, rh2, mx2, d2, kt = ra
        tag = f'{sid} {hh}Z row {i} p={p}'
        if (p, t, td, rh, mx, d) != (p2, t2, td2, rh2, mx2, d2):
            problems.append(f'{tag}: metric/aviation columns differ')
        if abs(hm / 0.3048 - hft) > 2.0:
            problems.append(f'{tag}: {hm} m vs {hft} ft')
        if (ms is None) != (kt is None) or (ms is not None and abs(ms / 0.514444 - kt) > 0.15):
            problems.append(f'{tag}: {ms} m/s vs {kt} kt')
        levels.append({'p_hpa': p, 'h_m': int(hm), 'h_ft': int(hft), 't_c': t, 'td_c': td,
                       'dir_deg': None if d is None else int(d), 'kt': kt, 'ms': ms})
    # hydrostatic check with virtual temperature from THTV (col 10): Tv = THTV * (p/1000)^0.2857
    for i in range(1, len(m)):
        p0, h0, thv0 = m[i - 1][0], m[i - 1][1], m[i - 1][10]
        p1, h1, thv1 = m[i][0], m[i][1], m[i][10]
        if thv0 is None or thv1 is None:
            continue
        tv0 = thv0 * (p0 / 1000) ** 0.2857; tv1 = thv1 * (p1 / 1000) ** 0.2857
        dz = 287.05 * (tv0 + tv1) / 2 / 9.80665 * math.log(p0 / p1)
        if abs(dz - (h1 - h0)) > max(8.0, 0.006 * (h1 - h0)):
            problems.append(f'{sid} {hh}Z {p0}->{p1} hPa: hypsometric {dz:.0f} m vs {h1 - h0:.0f} m')
    st = STATIONS[sid]
    soundings.append({
        'station': sid, 'name': st['name'], 'lat': st['lat'], 'lon': st['lon'],
        'time_utc': f'1985-08-12T{hh}:00Z', 'time_jst': f'1985-08-12T{int(hh) + 9:02d}:00+09:00',
        'url': BASE.format(hh=hh, id=sid) + '&type=TEXT:LIST',
        'url_aviation': BASE.format(hh=hh, id=sid) + '&type=TEXT:AVIATION&src=FM35',
        'levels': levels,
    })

doc = {
    'about': [
        'Upper air and surface weather for JAL 123 (12 Aug 1985, 18:12-18:56 JST = 09:12-09:56 UTC), and the magnetic '
        'declination, as inputs for reconstruct.py (design section 6.1 step 2).',
        'Soundings: University of Wyoming archive, read as web pages on 2026-09-23; values copied verbatim. Each level '
        'merges the two views of the same FM35 TEMP message: TEXT:LIST (h_m, ms) and TEXT:AVIATION (h_ft, kt); '
        'p, t, td and dir are identical in both. Heights are geopotential above mean sea level; the first level is the '
        'surface. dir_deg is where the wind comes from, degrees true. null = not reported.',
        'The flight lies between the 00Z and 12Z soundings, nearer 12Z (21:00 JST). Tateno is east-north-east of the '
        'route (Tsukuba), Hamamatsu west of Suruga Bay.',
        "Provenance: this file was written by a scratch builder that is not in the repository (build_winds.py with the "
        "verbatim pages in soundings_raw.py, in the main checkout's git-ignored .work/jal123/d3/). Its checks: the two "
        "views agree on p, t, td, RH, MIXR and dir; |h_m / 0.3048 - h_ft| <= 2; |ms / 0.5144 - kt| <= 0.15; every "
        "layer's thickness matches the hypsometric equation (Tv from THTV) within 8 m or 0.6 %. To re-verify, read the "
        "url and url_aviation pages again.",
    ],
    'soundings': soundings,
    'surface': {
        'source': 'AAIC report (1987), English edition JA8119-en.pdf, 2.8.2 Observations at related Airports, printed '
                  'p.19 (PDF p.30); table header on printed p.18. Wind degrees/knots, QNH in inches of mercury, JST.',
        'obs': [
            {'place': 'Tokyo International (Haneda)', 'jst': '17:00', 'wind_dir': 210, 'wind_kt': 18, 't_c': 29, 'td_c': 21, 'qnh_inhg': 29.91},
            {'place': 'Tokyo International (Haneda)', 'jst': '18:00', 'wind_dir': 220, 'wind_kt': 17, 't_c': 29, 'td_c': 21, 'qnh_inhg': 29.93},
            {'place': 'Tokyo International (Haneda)', 'jst': '18:30', 'wind_dir': 210, 'wind_kt': 15, 't_c': 29, 'td_c': 21, 'qnh_inhg': 29.93},
            {'place': 'Tokyo International (Haneda)', 'jst': '19:00', 'wind_dir': 220, 'wind_kt': 13, 't_c': 28, 'td_c': 21, 'qnh_inhg': 29.94},
            {'place': 'Yokota', 'jst': '18:00', 'wind_dir': None, 'wind_kt': 0, 't_c': 28, 'td_c': 23, 'qnh_inhg': 29.96, 'note': 'calm'},
            {'place': 'Yokota', 'jst': '19:00', 'wind_dir': None, 'wind_kt': 0, 't_c': 28, 'td_c': 23, 'qnh_inhg': 29.97, 'note': 'calm'},
            {'place': 'Nagoya', 'jst': '17:00', 'wind_dir': 180, 'wind_kt': 7, 't_c': 25, 'td_c': 23, 'qnh_inhg': 29.98},
            {'place': 'Nagoya', 'jst': '18:00', 'wind_dir': 210, 'wind_kt': 4, 't_c': 26, 'td_c': 24, 'qnh_inhg': 29.99},
            {'place': 'Nagoya', 'jst': '18:30', 'wind_dir': 220, 'wind_kt': 10, 't_c': 26, 'td_c': 24, 'qnh_inhg': 30.00},
            {'place': 'Nagoya', 'jst': '19:00', 'wind_dir': None, 'wind_kt': 0, 't_c': 26, 'td_c': 23, 'qnh_inhg': 30.00, 'note': 'calm'},
            {'place': 'Shizuhama', 'jst': '18:00', 'wind_dir': 240, 'wind_kt': 5, 't_c': 29, 'td_c': 25, 'qnh_inhg': 29.98},
            {'place': 'Shizuhama', 'jst': '19:00', 'wind_dir': 250, 'wind_kt': 5, 't_c': 28, 'td_c': 24, 'qnh_inhg': 29.99},
        ],
        'notes': [
            'Report 2.8.1 (printed p.18): between Izu Oshima and the Izu Peninsula the wind was about 5 m/s from the south.',
            'Report 2.8.5.1 and 2.8.5.2 (printed p.21): no clouds at 10,000-25,000 ft on the course near Otsuki; sunset at the crash site about 18:40.',
        ],
    },
    'declination': {
        'about': 'Magnetic declination, degrees, east positive (negative = west): true = magnetic + declination. '
                 'NOAA NCEI historical declination calculator, model IGRF (it answered with DGRF85), date '
                 '1985-08-12 = 1985.611, at sea level; read 2026-09-23.',
        'url': 'https://www.ngdc.noaa.gov/geomag-web/calculators/calculateDeclination?lat1={lat}&lon1={lon}&key=zNEw7'
               '&model=IGRF&startYear=1985&startMonth=8&startDay=12&resultFormat=json',
        'calculator': 'https://www.ngdc.noaa.gov/geomag/calculators/magcalc.shtml#declination',
        'model': 'DGRF85',
        'date': 1985.611,
        'points': [
            {'place': 'Haneda', 'lat': 35.55, 'lon': 139.78, 'deg': -6.57621, 'sv_deg_per_yr': -0.0239},
            {'place': 'failure point', 'lat': 34.761, 'lon': 139.100, 'deg': -6.38345, 'sv_deg_per_yr': -0.0238},
            {'place': 'west of Mt Fuji (18:34:53)', 'lat': 35.31, 'lon': 138.34, 'deg': -6.66415, 'sv_deg_per_yr': -0.02382},
            {'place': 'Otsuki loop', 'lat': 35.58, 'lon': 138.95, 'deg': -6.6914, 'sv_deg_per_yr': -0.02387},
            {'place': 'Osutaka ridge', 'lat': 36.001, 'lon': 138.694, 'deg': -6.86957, 'sv_deg_per_yr': -0.02389},
        ],
    },
}

if problems:
    print('\n'.join(problems)); sys.exit(1)
def pretty(v, ind=0):
    """JSON with one line per level / observation / point (flat objects inside lists)."""
    sp = '  ' * ind
    if isinstance(v, dict):
        items = [f'{sp}  {json.dumps(k)}: {pretty(x, ind + 1)}' for k, x in v.items()]
        return '{\n' + ',\n'.join(items) + '\n' + sp + '}'
    if isinstance(v, list):
        if all(not isinstance(x, (dict, list)) for x in v) and sum(len(json.dumps(x)) for x in v) < 60:
            return json.dumps(v, ensure_ascii=False)
        parts = []
        for x in v:
            flat = isinstance(x, dict) and all(not isinstance(y, (dict, list)) for y in x.values())
            parts.append(sp + '  ' + (json.dumps(x, ensure_ascii=False, separators=(', ', ': ')) if flat else pretty(x, ind + 1)))
        return '[\n' + ',\n'.join(parts) + '\n' + sp + ']'
    return json.dumps(v, ensure_ascii=False)

if '--write' in sys.argv:
    text = pretty(doc) + '\n'
    assert json.loads(text) == doc
    with open(OUT, 'w') as f:
        f.write(text)
    print('wrote', OUT)
else:  # fix round 2: the committed file must be exactly what the builder makes
    with open(OUT) as f:
        committed = f.read()
    if committed != pretty(doc) + '\n':
        print('FAIL: winds.json differs from the builder output (run with --write, or fix the builder)')
        sys.exit(1)
    print('ok: winds.json is byte-identical to the builder output')
print('ok:', ', '.join(f"{s['station']} {s['time_utc']} {len(s['levels'])} levels" for s in soundings))

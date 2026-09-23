# tools/scenarios/jal123/inputs/verify.py
# Checks the D3 inputs against the contract and the sources: livery body.png and fin.png, anchors.csv, winds.json
# (D3; moved here from .work/jal123/d3 in D4). Exit 1 on any failure.
# usage: [ANCHORS=planted.csv] /usr/bin/python3 tools/scenarios/jal123/inputs/verify.py [--work <dir>] [BODY_PNG]
#   the work folder (dfdr_1hz.csv, for the lift-off checks): --work, else $JAL123_WORK, else <repo>/.work/jal123
import csv, json, sys, math, re, os, subprocess
from pathlib import Path
from PIL import Image, ImageOps, ImageChops

REPO = str(Path(__file__).resolve().parents[4])
args = [a for i, a in enumerate(sys.argv[1:], 1) if a != '--work' and sys.argv[i - 1] != '--work']
body_path = args[0] if args else REPO + '/public/scenarios/jal123/livery/body.png'
fails = []
def check(ok, msg):
    print(('ok   ' if ok else 'FAIL ') + msg)
    if not ok: fails.append(msg)

sys.path.insert(0, REPO + '/tools/scenarios/jal123')
import livery
f = livery.Frame(livery.measure(livery.read_glb(livery.GLB)))
col = lambda bs: f.px(f.z(bs)) / livery.SS
row = lambda h: f.py(f.y(h)) / livery.SS

# ---- body.png
try:
    b = Image.open(body_path)
except FileNotFoundError:
    b = None
check(b is not None, 'body.png exists')
if b is not None:
    check(b.size == (4096, 1024) and b.mode == 'RGBA', f'body.png is 4096x1024 RGBA ({b.size} {b.mode})')
    px = b.load()
    # transparent pixels carry the base white
    a = b.getchannel('A')
    clear = [px[x, y][:3] for x in range(0, 4096, 97) for y in range(0, 1024, 7) if px[x, y][3] == 0]
    check(all(c == livery.WHITE for c in clear), f'transparent pixels are base white ({len(clear)} sampled)')
    for half, off in (('left', 0), ('right', 512)):
        # bands at mid fuselage (column 2600, between doors 4 and 5 and clear of windows: sample between windows)
        x = 2600
        def rgb(h): return px[x, int(round(row(h))) + off][:3]
        check(rgb(0.76) == livery.NAVY or rgb(0.60) == livery.NAVY, f'{half}: navy at h 0.60 m')
        check(rgb(1.20) == livery.RED, f'{half}: red at h 1.20 m')
        check(px[x, int(row(2.5)) + off][3] == 0, f'{half}: transparent (base white) at h 2.5 m')
        check(px[x, int(row(-0.8)) + off][:3] == livery.BELLY and px[x, int(row(-0.8)) + off][3] == 255, f'{half}: belly below the floor')
        # title ink inside its stations and its cap band
        tb = b.crop((0, off, 4096, off + 512)).crop((int(col(560)), int(row(2.7)), int(col(1200)), int(row(1.9))))
        dark = tb.point(lambda v: 0).convert('L')
        ink = [(xx, yy) for xx in range(tb.width) for yy in range(tb.height) if tb.getpixel((xx, yy))[3] > 128 and sum(tb.getpixel((xx, yy))[:3]) < 150]
        xs = [p[0] + int(col(560)) for p in ink]
        check(abs(min(xs) - col(595)) < 3 and abs(max(xs) - col(1166)) < 3,
              f'{half}: title ink spans columns {min(xs)}-{max(xs)} = BS 595-1166 ({col(595):.0f}-{col(1166):.0f})')
    # right title = left title mirrored in place (the block's box is whole pixels: allow its half-pixel centre)
    y0, y1 = int(row(2.50)), int(row(2.02))
    L = b.crop((int(col(595)), y0, int(col(1166)) + 1, y1)).getchannel('A')
    best = min(max(ImageChops.difference(ImageOps.mirror(L), b.crop((int(col(595)) + sh, y0 + 512, int(col(1166)) + 1 + sh, y1 + 512)).getchannel('A')).getdata()) for sh in (-1, 0, 1))
    check(best <= 2, f'right-side title is the left title mirrored in place (max alpha difference {best})')
    same = ImageChops.difference(b.crop((0, 0, 4096, int(row(1.43)))).crop((0, 0, int(col(560)), int(row(1.43)))),
                                 b.crop((0, 512, int(col(560)), 512 + int(row(1.43))))).getbbox()
    check(same is None, 'both sides identical ahead of the title (windows, cockpit, disc)')
    # doors: an outline pixel at each door's forward edge, mid height
    for bs in livery.DOORS_BS:
        x0 = int(round(col(bs) - (livery.DOOR_W / 2) * f.k / 0.0254 / 71 * 4096))
        seg = [px[x, int(row(1.2))] for x in range(x0 - 2, x0 + 3)]
        check(any(abs(p[0] - 0x70) < 40 and abs(p[2] - 0x7A) < 40 for p in seg), f'door outline at BS {bs} (column {x0})')

# ---- fin.png
try:
    fn = Image.open(REPO + '/public/scenarios/jal123/local/fin.png'); check(fn.size == (512, 512) and fn.mode == 'RGBA', 'fin.png is 512x512 RGBA')
    c = fn.getpixel((256, 256)); e = fn.getpixel((5, 5))
    check(e[3] == 0, 'fin.png corner transparent')
    check(fn.getpixel((256, 256 + 200))[:3] == livery.RED, 'fin.png red base below the centre')
except FileNotFoundError:
    check(False, 'fin.png exists')

# ---- anchors.csv
rows = list(csv.DictReader(open(os.environ.get('ANCHORS', REPO + '/tools/scenarios/jal123/anchors.csv'))))  # ANCHORS=: a planted copy
check(list(rows[0].keys()) == ['time', 'lat', 'lon', 'alt_ft', 'tol_m', 'kind', 'src'], 'anchors.csv header')
ts = [sum(int(x) * m for x, m in zip(r['time'].split(':'), (3600, 60, 1))) for r in rows]
check(all(b2 > a2 for a2, b2 in zip(ts, ts[1:])), 'anchors.csv times strictly increasing')
check(all(r['src'] and float(r['tol_m']) > 0 and r['kind'] for r in rows), 'every anchor has tol, kind and src')
md = open(REPO + '/.planning/reports/scenarios/track.md').read().split('## 2.')[1].split('## 3.')[0]
pairs = [(float(p), float(q)) for p, q in re.findall(r'(\d{2}\.\d+) N,? (\d{3}\.\d+) E', md)]
# not anchors: the CSV's own wrong points, the loop centres, and the 18:49 spot (no fig.1 label there: fix round 1)
not_anchor = {(35.18, 139.48), (35.03, 138.255), (36.02, 139.10), (35.58, 138.95), (36.001, 138.723), (35.80, 139.10)}
exp = [p for p in pairs if p not in not_anchor]
mine = [(float(r['lat']), float(r['lon'])) for r in rows if r['kind'] not in ('threshold', 'liftoff', 'failure')]
check(mine == exp, f'anchor positions equal track.md section 2 ({len(mine)} rows)')
check(not any(r['time'].startswith('18:49') for r in rows), 'no 18:49 anchors (R05 fig.1 has no label there)')
bc = [r for r in rows if r['kind'] == 'backcalc']
check(len(bc) == 6 and all(int(r['tol_m']) >= 1000 and r['src'].startswith('SOFT.') for r in bc),
      'backcalc rows: six, tol >= 1000 m, marked SOFT (' + ' '.join(r['tol_m'] for r in bc) + ')')
parts = [r['src'].split('PART: ')[1][:24] if 'PART: ' in r['src'] else None for r in rows if r['kind'] == 'contact']
check(all(parts), 'every contact row names the part that touched (' + ' | '.join(map(str, parts)) + ')')
fl = next(r for r in rows if r['kind'] == 'failure')
check((fl['time'], float(fl['lat']), float(fl['lon']), fl['tol_m']) == ('18:24:35', 34.761, 139.100, '500'), 'failure point 34.761 139.100 +-500 m at 18:24:35')
g = {r['time']: r for r in rows if r['kind'] == 'contact'}
check([round(float(r['alt_ft']) * 0.3048) for r in rows if r['kind'] == 'contact'] == [1544, 1610, 1565], 'contact altitudes 1530+14, 1610, 1565 m')
# D4 fixes: the ridge row is soft, at 18:56:29 (3 s at about 190 m/s after the ditch), after the scenario's end
ct = [r for r in rows if r['kind'] == 'contact']
check([r['time'] for r in ct] == ['18:56:23', '18:56:26', '18:56:29'] and ct[2]['src'].startswith('SOFT'),
      'contact times 18:56:23, 18:56:26 and 18:56:29 (ridge SOFT: direction only)')
dd = math.hypot((float(ct[2]['lat']) - float(ct[1]['lat'])) * 110951, (float(ct[2]['lon']) - float(ct[1]['lon'])) * 90204)
check(150 <= dd / 3 <= 230, f'ditch to ridge {dd:.0f} m in 3 s = {dd / 3:.0f} m/s (DFDR about 190 m/s)')
check("last roll is 59.5 R at 18:56:24" in ct[1]['src'] and '59-79' not in ct[1]['src'],
      'ditch src: the bank at the contact is not recorded (last roll 59.5 R at 18:56:24)')
# threshold to lift-off (fix round 2): on the traced 15L centreline, at the DFDR take-off roll distance of the row's
# own second (liftoff.py: D1's lean-corrected dfdr_1hz), and at a second the DFDR shows as lift-off
t0 = next(r for r in rows if r['kind'] == 'threshold'); t1 = next(r for r in rows if r['kind'] == 'liftoff')
la0, lo0, la1, lo1 = map(float, (t0['lat'], t0['lon'], t1['lat'], t1['lon']))
dn = (la1 - la0) * 110951; de = (lo1 - lo0) * 90673
dist = math.hypot(dn, de)
check(abs(math.degrees(math.atan2(de, dn)) - 145.39) < 0.2, f'lift-off on the 15L centreline ({math.degrees(math.atan2(de, dn)):.2f} true)')
check(t0['time'] == '18:11:32' and 'REF POINT' in t0['src'], 'threshold row at 18:11:32 states its aircraft reference point')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import liftoff
mid, lo, hi = liftoff.roll_distance(t1['time'])
check(lo <= dist <= hi and abs(dist - mid) <= 25 and hi - lo <= 2 * float(t1['tol_m']),
      f'lift-off {dist:.0f} m = the DFDR take-off roll at {t1["time"]} ({mid:.0f} m, range {lo:.0f}-{hi:.0f}; tol {t1["tol_m"]})')
ts1 = liftoff.sec(t1['time'])
p, vg, vg0 = liftoff.f(ts1, 'pitch'), liftoff.f(ts1, 'vrtg_g'), liftoff.f(ts1 - 1, 'vrtg_g')
check(8 <= p <= 11 and vg > 1.02 >= vg0, f'lift-off second: pitch {p} deg (747 lift-off about 8-11) and VRTG rises clear of 1 ({vg0} -> {vg})')
check(f'{round(dist, -1):.0f} m from the threshold' in t1['src'], f'lift-off src states its distance ({round(dist, -1):.0f} m)')
# D4: the src arithmetic matches liftoff.py (trace bracket + early-segment bracket)
tr = [liftoff.trace_dist(ts1, k, hw) for k in (liftoff.TAS_K * 0.995, liftoff.TAS_K * 1.005)
      for hw in (liftoff.headwind(220, 17), liftoff.headwind(210, 15))]
em = liftoff.early_models()
e_lo, e_hi = min(em['least'], em['rolling'], em['floor_lo']), max(em['least'], em['rolling'], em['floor_hi'])
mid_tr, mid_e = round(liftoff.trace_dist(ts1)), round((e_lo + e_hi) / 2)
want = '%d + %d = %d m; range %.0f + %.0f = %.0f to %.0f + %.0f = %.0f m' % (
    mid_tr, mid_e, mid_tr + mid_e, min(tr), e_lo, lo, max(tr), e_hi, hi)
check(want in t1['src'] and abs(mid_tr + mid_e - dist) < 5, 'lift-off src arithmetic: ' + want)
# R05 fig.1's own labels on the last leg (fix round 2): cited, and equal to the DFDR at their second
lab = {r['time']: r['src'] for r in rows}
check("18:54:23 / 11000 ft / 220 kt" in lab['18:54:30'] and "18:55:03 / 11300 ft / 180 kt" in lab['18:55:00'],
      'fig.1 labels 18:54:23 and 18:55:03 cited in the 18:54:30 and 18:55:00 rows')
for t, ft, kt in (('18:54:23', 11000, 220), ('18:55:03', 11300, 180)):
    a, c = liftoff.f(liftoff.sec(t), 'alt_press_ft'), liftoff.f(liftoff.sec(t), 'cas_kt')
    check(abs(a - ft) <= 100 and abs(c - kt) <= 5, f'fig.1 label {t} {ft} ft / {kt} kt = dfdr_1hz {a:.0f} ft / {c:.0f} kt')
# the crane stays out of git (read-only git query)
ig = subprocess.run(['git', '-C', REPO, 'check-ignore', '-q', 'public/scenarios/jal123/local/fin.png']).returncode
check(ig == 0, f'git ignores public/scenarios/jal123/local/fin.png (check-ignore exit {ig})')

# ---- winds.json
w = json.load(open(REPO + '/tools/scenarios/jal123/winds.json'))
st = {(s['station'], s['time_utc'][11:13]) for s in w['soundings']}
check(st == {('47646', '00'), ('47646', '12'), ('47681', '00'), ('47681', '12')}, 'four soundings: Tateno and Hamamatsu, 00Z and 12Z')
check(all(set(l) == {'p_hpa', 'h_m', 'h_ft', 't_c', 'td_c', 'dir_deg', 'kt', 'ms'} for s in w['soundings'] for l in s['levels']), 'every level has p, h, t, td, dir, speed')
check(all(s['url'].startswith('https://weather.uwyo.edu/') for s in w['soundings']), 'sounding URLs')
dec = w['declination']['points']
check(len(dec) == 5 and all(-7.0 < p['deg'] < -6.3 for p in dec), 'declination 6.4-6.9 W at five points')
check(abs(145.39 - dec[0]['deg'] - 152) < 1.0, f'15L true 145.39 + {-dec[0]["deg"]:.2f} W = {145.39 - dec[0]["deg"]:.2f} magnetic ~ DFDR 152')

print('\n%d failed' % len(fails) if fails else '\nall passed')
sys.exit(1 if fails else 0)

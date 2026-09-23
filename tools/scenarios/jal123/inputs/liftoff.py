# tools/scenarios/jal123/inputs/liftoff.py
# The take-off roll from dfdr_1hz.csv (R11 DFDR charts, digitized by digitize.py) and the lift-off second: sets the
# anchors.csv lift-off row (D3; moved here from .work/jal123/d3 in D4). verify.py imports roll_distance().
# usage: /usr/bin/python3 tools/scenarios/jal123/inputs/liftoff.py [--work <FlightHopper>/.work/jal123]
#   the work folder: --work, else $JAL123_WORK, else <repo>/.work/jal123 (as digitize.py)
import csv, math, os, sys
from pathlib import Path


def work_dir(argv=sys.argv):
    if '--work' in argv:
        return Path(argv[argv.index('--work') + 1])
    return Path(os.environ.get('JAL123_WORK', str(Path(__file__).resolve().parents[4] / '.work' / 'jal123')))


DFDR = str(work_dir() / 'dfdr_1hz.csv')
rows = {r['time']: r for r in csv.DictReader(open(DFDR))}
def sec(t): h, m, s = map(int, t.split(':')); return h * 3600 + m * 60 + s
def hms(s): return '%02d:%02d:%02d' % (s // 3600, s // 60 % 60, s % 60)
def f(t, k): v = rows[hms(t)][k]; return float(v) if v else None
KT = 0.514444
T0 = sec('18:11:32')   # roll start (threshold row)
TH = sec('18:11:48')   # first second clear of the 50 kt floor's neighbourhood (60 kt); the trace is used from here

# TAS/CAS on the runway: sqrt(rho0/rho) at 29 C and QNH 29.93 (EN p.19, Haneda 18:00)
TAS_K = math.sqrt((273.15 + 29) / 288.15 * 29.92 / 29.93)
# wind: Haneda 18:00 220/17 and 18:30 210/15 -> 18:12 about 216/16.2; runway 145.39 true
def headwind(d, s): return s * math.cos(math.radians(d - 145.39))
HW = headwind(216, 16.2)
def gs(t, k=TAS_K, hw=HW): return (f(t, 'cas_kt') * k - hw) * KT   # m/s
def epr(t): return sum(f(t, 'epr%d' % i) for i in (1, 2, 3, 4)) / 4
def trace_dist(t1, k=TAS_K, hw=HW): return sum((gs(t, k, hw) + gs(t + 1, k, hw)) / 2 for t in range(TH, t1))

def full_accel():
    """least-squares GS slope 18:11:48-18:12:08, full take-off EPR, before rotation (m/s2)"""
    xs = list(range(TH, sec('18:12:08') + 1)); ys = [gs(t) for t in xs]
    mx = sum(xs) / len(xs); my = sum(ys) / len(ys)
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)

def early_models():
    """distance 18:11:32-18:11:48, while CAS is on or near its 50 kt floor (R10 p.282): three models (m)"""
    a = full_accel(); v_h = gs(TH)
    # (1) least: standing as late as possible, then full thrust (+0.2 m/s2 for less ram drag at low speed)
    d1 = v_h ** 2 / (2 * (a + 0.2))
    # (3) acceleration k (EPR - 1) - 0.15 (rolling friction) with k from full thrust: needs a rolling start
    k = (a + 0.15) / (epr(TH) - 1.0)
    vv = [0.0]
    for t in range(T0, TH): vv.append(vv[-1] + k * ((epr(t) - 1.0) + (epr(t + 1) - 1.0)) / 2 - 0.15)
    v0 = v_h - vv[-1]; vv = [x + v0 for x in vv]
    d3 = sum((vv[i] + vv[i - 1]) / 2 for i in range(1, len(vv)))
    # (4) the floor-adjacent readings from 18:11:44 (52.4 kt) at face value, plus standstill -> 50 kt in 12 s (131-196 m)
    d44 = sum((gs(t) + gs(t + 1)) / 2 for t in range(sec('18:11:44'), TH))
    return dict(least=d1, rolling=d3, rolling_v0_kt=v0 / KT, floor_lo=131 + d44, floor_hi=196 + d44)

def roll_distance(t1):
    """(mid, lo, hi) metres from the roll start at 18:11:32 to second t1 ('HH:MM:SS')"""
    s = sec(t1); m = early_models()
    e_lo = min(m['least'], m['rolling'], m['floor_lo'])
    e_hi = max(m['least'], m['rolling'], m['floor_hi'])
    lo = e_lo + min(trace_dist(s, TAS_K * 0.995, headwind(220, 17)), trace_dist(s, TAS_K * 0.995, headwind(210, 15)))
    hi = e_hi + max(trace_dist(s, TAS_K * 1.005, headwind(220, 17)), trace_dist(s, TAS_K * 1.005, headwind(210, 15)))
    return trace_dist(s) + (e_lo + e_hi) / 2, lo, hi

if __name__ == '__main__':
    print('TAS/CAS %.4f; headwind %.2f kt (216/16.2); bracket 220/17 %.2f, 210/15 %.2f' % (TAS_K, HW, headwind(220, 17), headwind(210, 15)))
    print('\nsecond    CAS  pitch  roll  VRTG   ALT   HDG  EPR mean')
    for t in range(sec('18:12:06'), sec('18:12:18')):
        print('%s %5.1f %6.1f %5.1f %5.2f %5.0f %5.1f  %.3f' % (hms(t), f(t, 'cas_kt'), f(t, 'pitch'), f(t, 'roll'), f(t, 'vrtg_g'), f(t, 'alt_press_ft'), f(t, 'hdg_mag'), epr(t)))
    print('\nfull-thrust acceleration 18:11:48-18:12:08: %.2f m/s2 (%.2f kt/s CAS); GS at 18:11:48 %.1f m/s' % (full_accel(), full_accel() / KT / TAS_K, gs(TH)))
    m = early_models()
    print('18:11:32-18:11:48: least (late standstill, full thrust) %.0f m; rolling start (k(EPR-1), %.1f kt at 18:11:32) %.0f m; floor readings at face value %.0f-%.0f m'
          % (m['least'], m['rolling_v0_kt'], m['rolling'], m['floor_lo'], m['floor_hi']))
    print('\nfrom the roll start (m)   mid   [lo .. hi]   (trace from 18:11:48 + early segment; wind 210/15..220/17; TAS/CAS +-0.5%)')
    for t1 in ('18:12:11', '18:12:12', '18:12:13', '18:12:14', '18:12:15', '18:12:16'):
        mid, lo, hi = roll_distance(t1)
        print('  %s  trace %5.0f  total %5.0f  [%4.0f .. %4.0f]  GS %.0f kt' % (t1, trace_dist(sec(t1)), mid, lo, hi, gs(sec(t1)) / KT))

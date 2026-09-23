# tools/scenarios/jal123/inputs/runway.py
# The 1985 runway 15L centreline (traced on GSI gazo3 z17 1984-86 photographs) and points along it: the lift-off
# point of anchors.csv (D3; moved here from .work/jal123/d3 in D4).
# usage: /usr/bin/python3 tools/scenarios/jal123/inputs/runway.py
import math
a, e2 = 6378137.0, 6.69437999014e-3

def radii(lat):
    s = math.sin(math.radians(lat))
    w = 1 - e2 * s * s
    M = a * (1 - e2) / w ** 1.5
    N = a / math.sqrt(w)
    return M * math.pi / 180, N * math.cos(math.radians(lat)) * math.pi / 180

# centreline ends picked on gazo3 z17 (browser tracing, see report): NW edge of the 15L threshold stripes, SE edge of the 33R stripes
T15 = (35.56188984084828, 139.7600231254473)
T33 = (35.53869276316107, 139.7796116076216)
lat0 = (T15[0] + T33[0]) / 2
mlat, mlon = radii(lat0)
dn = (T33[0] - T15[0]) * mlat
de = (T33[1] - T15[1]) * mlon
L = math.hypot(dn, de)
brg = (math.degrees(math.atan2(de, dn)) + 360) % 360
print('runway length %.0f m, true bearing %.2f deg, magnetic %.2f (decl -6.58)' % (L, brg, brg + 6.576))

def along(s):
    return T15[0] + dn / L * s / mlat, T15[1] + de / L * s / mlon

# fix round 2: lift-off 1540 m at 18:12:12 (liftoff.py; range 1457-1620). Round 1's 1465 m at 18:12:16 was read off
# R11 p-02 without its scan lean and was about 4 s late.
for s in (0, 1540, 1457, 1620):
    la, lo = along(s)
    print('s=%5d m  %.5f %.5f' % (s, la, lo))

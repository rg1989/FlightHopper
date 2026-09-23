# tools/scenarios/jal123/livery.py
# Draws JA8119's August 1985 Japan Air Lines livery for the JAL 123 scenario (design §6.2): the body wrap the b744
# livery shader projects onto the fuselage sides, and the local-only fin logo.
"""
    /usr/bin/python3 tools/scenarios/jal123/livery.py [--font PATH] [--check]

Output (paths relative to the repository):
  public/scenarios/jal123/livery/body.png  4096×1024 RGBA, committed. Stripes, windows, doors, titles, disc, registration.
  public/scenarios/jal123/local/fin.png    512×512 RGBA, must be git-ignored (spec §7: the crane stays out of git; the
                                           script warns when git does not ignore it). A simplified 1959 Tsurumaru: a
                                           red crane whose wings form a ring, white "JAL" in the red.
After writing, the script checks both images against the placements it printed and exits 1 on a failure.
--check re-measures the model, prints every placement and checks the images already written, without writing.

The body-wrap contract (shared with paintShaderText() in client/scene/livery.ts; b744 Paint.body in
public/models/manifest.json = [zNose 35.5, zTail -35.5, yBottom -8.7, yTop -0.5], the paint's turned frame: x = the
aircraft's left, y up, z nose-forward, unscaled metres):
  column 0 = zNose, column 4095 = zTail                  u = (zNose - z) / (zNose - zTail)
  rows 0-511 = the LEFT side (turned +x), rows 512-1023 = the RIGHT side; inside a half the first row is yTop and
  the last yBottom. Both halves put the nose on the left, so text on the right half is mirrored in place to read
  correctly on the aircraft. The shader applies the wrap only on the body where |n.x| > 0.2, mixed by alpha over the
  base and belly colours; transparent pixels carry the base white so filtering never darkens an edge.

Where things go. The b744 mesh is a 747-400; JA8119 was a 747SR-46 (747-100 fuselage, short upper deck, no windows
or doors in the mesh). Every mark is placed on the real aircraft's body stations (BS, inches from the datum; the
nose is BS 90) and on heights above the main-deck floor, then mapped onto the mesh:
  z(BS) = nose tip z - (BS - 90) * k,  k = (nose tip z - tail cone end z) / (2792 - 90)     (tail cone end: BS 2792)
  y(h)  = floor y + h * s,  floor y = belly + 0.40 * (crown - belly),  s = (crown - belly) / 6.97 m
The nose tip, tail cone end, belly and main crown are measured from public/models/b744.glb below.

Sources (R05 = AAIC 1987 report part 5 figures, https://jtsb.mlit.go.jp/aircraft/download/62-2-JA8119-05.pdf):
  S1  R05 p.140 付図-4, 747SR-100 three-view: floor line at 0.40 of the body height above the keel (side view), body
      height 6.97 m, tail cone end at BS 2792, overall length 231 ft 4 in.
  S2  R05 p.141 付図-5, fuselage stations: BS 90 nose … 2792 tail; the five main-deck door cut-outs in the window row
      at BS 453, 823, 1301, 1695, 2266 (measured on the scan, ±8 in); main-deck window row from BS ≈140;
      main-deck floor WL 199.8.
  P1  Photo, Haneda 3 Mar 1985, Stuart Jessup, CC BY-SA 2.0 (reference only, not shipped):
      https://commons.wikimedia.org/wiki/File:BOEING_747SR-46,_JA8119_,_JAPAN_AIRLINES.jpg
  P2  Photo, Itami 1984, Harcmac60, CC BY-SA 3.0 (reference only, not shipped):
      https://commons.wikimedia.org/wiki/File:Japan_Airlines_B747SR-46_(JA8119)_at_Itami_Airport_in_1984.jpg
  Heights in P1/P2 are measured with the door outline as the ruler (a 747 main-deck door is 42 × 76 in, 1.07 × 1.93 m)
  and stations by interpolating between the doors of S2; P1 doors fall at BS 451, 819, 1295, 1698, 2283.
  Colours: scenarios-design §6.2 (from .planning/reports/scenarios/livery.md).
"""
import argparse
import json
import math
import struct
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[3]
MANIFEST = ROOT / 'public/models/manifest.json'
GLB = ROOT / 'public/models/b744.glb'
BODY_PNG = ROOT / 'public/scenarios/jal123/livery/body.png'
FIN_PNG = ROOT / 'public/scenarios/jal123/local/fin.png'

W, H = 4096, 1024  # body.png; each side is W × H/2
SS = 2  # supersampling while drawing
BOX = (35.5, -35.5, -8.7, -0.5)  # the contract: b744 Paint.body [zNose, zTail, yBottom, yTop]

# colours, design §6.2
WHITE = (0xF4, 0xF4, 0xF1)
RED = (0xC8, 0x00, 0x19)
NAVY = (0x1C, 0x24, 0x51)
BLACK = (0x16, 0x16, 0x16)
BELLY = (0xBF, 0xC3, 0xC7)
WINDOW = (0x3B, 0x40, 0x49)  # subtle dark grey: reads as glass on white, barely on the navy (as in P1)
COCKPIT = (0x22, 0x26, 0x2B)
SEAM = (0x70, 0x74, 0x7A, 210)  # door outlines: darker than the white, lighter than the navy (P1, P2)

# 747SR reference geometry (see the sources above)
BS_NOSE, BS_TAIL_CONE = 90.0, 2792.0  # S2
FLOOR_FRACTION = 0.40  # S1
BODY_HEIGHT_M = 6.97  # S1: keel to main-deck crown, 274.5 in at 0.50277 px/in on the scan
DOORS_BS = (453, 823, 1301, 1695, 2266)  # S2 (P1 agrees within 17 in)
DOOR_W, DOOR_H, DOOR_R = 1.07, 1.93, 0.14  # 42 × 76 in; corner radius from P1
LINE_M = 0.035  # door outline width
# heights above the main-deck floor (= door sill), metres: mean of five door-ruler readings in P1 and P2
BELLY_TOP_H = 0.0  # white ends at about the door sill (P2 clearly; P1 at the L1 door)
NAVY_H = (0.53, 1.00)  # P1 0.57/0.52/0.52, P2 0.50/0.54
RED_H = (1.00, 1.42)  # P1 1.06/0.97/0.94 and 1.40/1.40/1.39, P2 0.93/1.08 and 1.43/1.50
# The red is a band 0.42 m tall, nearly as tall as the navy, not the "thin red pinstripe" of design §6.2 and
# livery.md (≈0.2 m): measured on P1 with the L1 door as the ruler (red ≈0.41 m, navy ≈0.47 m). Keep the photo value.
MAIN_WIN = dict(first_bs=140, last_bs=2240, pitch_in=20, w=0.24, h=0.34, centre_h=0.87, r=0.08, door_clear_in=32)
# window centre: S2 draws the row ≈1.0 m above the floor, P2 (lit cabin) 0.97 m, P1 shows the window tops notching
# the red stripe's lower edge; 0.87 m keeps them mostly in the navy with the tops just into the red, as in P1.
# ponytail: the row follows P1's look, not S2's drawn ≈1.0 m; ceiling: up to 0.13 m off, one window height at most.
UPPER_WIN = dict(first_bs=545, n=10, pitch_in=20, w=0.19, h=0.29, centre_h=3.45, r=0.06)  # P1: ten, BS 545-726
# (BS, h) P1: the side windows' lower edge BS 276-332 at 3.44 m, upper edge BS 292-332 at 3.95 m (slanted front)
COCKPIT_POLY = [(276, 3.44), (332, 3.44), (332, 3.95), (292, 3.95)]
COCKPIT_POSTS_BS = (305,)  # the divider between the No.2 and No.3 side windows (P1)
DISC = dict(bs=519, h=2.29, d=0.55)  # P1: just behind L1 at title height
# text: glyphs widened by stretch, spaced by track, word space (both × cap height), a stroke of bold cap heights round
# every glyph, then sheared by slant (tan of the italic angle); the block is then scaled into its measured box.
# The title is a wide bold italic (P1, P2). P1 at full size (2302 px, cap 17.7 px), measured on the scan:
#   stems of I, I, J and R lean 0.45-0.49 px per px of height; the scan is 0.915 as wide per metre as it is tall
#   (door L2 26.5 × 52 px against 42 × 76 in; title ink 22.1 cap long against the 24.17 cap of its box), so the
#   paint leans 0.47 / 0.915 = 0.51 (27°). P2 leans more (0.67-0.69 px/px on the scan).
#   Straightened by that lean, at half ink: letters J 1.29 A 1.66 P 1.36 N 1.66 I 0.31 R 1.36 L 1.23 E 1.29 S 1.36 cap
#   wide, letter gaps 0.25-0.61 (median 0.43) cap, word gaps 1.29 cap. Helvetica Bold widened ×1.75 with track 0.20
#   and word space 0.85 gives the same widths (rms 0.11 cap), median gap 0.43 and word gaps 1.27/1.34.
# ponytail: Helvetica Bold widened and sheared stands in for JAL's logotype, whose face is unknown (livery.md);
# ceiling: widths, spacing and lean match P1 to about 0.1 cap, the letter shapes (J, N, S) only roughly.
TITLE = dict(text='JAPAN AIR LINES', bs=(595, 1166), base_h=1.96, cap=0.60, stretch=1.75, track=0.20, space=0.85,
             bold=0.0, slant=0.51)  # P1
# P1 with the L5 door as the ruler: baseline 0.27 m above the red top, 1.71 m above the sill; cap 0.39 m; upright.
REG = dict(text='JA8119', bs_centre=2125, width=1.91, base_h=1.71, cap=0.40, stretch=1.0, track=0.06, space=0.3,
           bold=0.0, slant=0.0)  # BS: P2 2116, P1 2134
# ponytail: small marks are left out: "BOEING 747" in the navy band behind L5 and the Tsukuba Expo '85 mark under the
# cheatline behind L1 (P1); ceiling: both are under 0.2 m tall and unreadable beyond about 30 m.

FONTS = [  # a bold grotesque whose J sits on the baseline, as on the aircraft
    ('/System/Library/Fonts/Helvetica.ttc', 1),  # Helvetica Bold (macOS)
    ('/System/Library/Fonts/Supplemental/Arial Bold.ttf', 0),
    ('C:/Windows/Fonts/arialbd.ttf', 0),
    ('/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf', 0),
    ('/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf', 0),
]
ITALIC_FONTS = [
    ('/System/Library/Fonts/Helvetica.ttc', 3),  # Helvetica Bold Oblique
    ('/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf', 0),
    ('C:/Windows/Fonts/arialbi.ttf', 0),
    ('/usr/share/fonts/truetype/liberation/LiberationSans-BoldItalic.ttf', 0),
]


# ---------- the model ----------

def read_glb(path):
    """POSITION of the single b744 primitive, in the paint's turned frame (raw x and z negated: noseMinusZ)."""
    b = path.read_bytes()
    json_len = struct.unpack_from('<I', b, 12)[0]
    g = json.loads(b[20:20 + json_len])
    bin0 = 20 + json_len + 8
    if len(g['meshes']) != 1 or len(g['meshes'][0]['primitives']) != 1 or any(
            k in n for n in g['nodes'] for k in ('matrix', 'rotation', 'translation', 'scale')):
        raise SystemExit('b744.glb is no longer one untransformed primitive: re-check the measurements')
    a = g['accessors'][g['meshes'][0]['primitives'][0]['attributes']['POSITION']]
    bv = g['bufferViews'][a['bufferView']]
    stride = bv.get('byteStride', 12)
    off = bin0 + bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    return [(-x, y, -z) for x, y, z in (struct.unpack_from('<3f', b, off + i * stride) for i in range(a['count']))]


def measure(pts):
    """Nose tip, tail cone end (below the fin), belly (ahead of the wing fairing) and main crown (aft of the
    upper-deck hump) of the fuselage."""
    body = [p for p in pts if abs(p[0]) < 3.4]
    nose = max(p[2] for p in pts)
    tail = min(p[2] for p in body if p[1] < -1.0 and abs(p[0]) < 1.5)
    belly = min(p[1] for p in body if 16 < p[2] < 24)
    crown = max(p[1] for p in body if -16 < p[2] < -4)
    return dict(nose_z=nose, tail_z=tail, belly_y=belly, crown_y=crown)


class Frame:
    """747SR stations and heights → mesh z, y → body.png pixels (supersampled)."""

    def __init__(self, m):
        self.m = m
        self.k = (m['nose_z'] - m['tail_z']) / (BS_TAIL_CONE - BS_NOSE)  # metres of mesh per inch of station
        self.floor = m['belly_y'] + FLOOR_FRACTION * (m['crown_y'] - m['belly_y'])
        self.s = (m['crown_y'] - m['belly_y']) / BODY_HEIGHT_M

    def z(self, bs):
        return self.m['nose_z'] - (bs - BS_NOSE) * self.k

    def y(self, h):
        return self.floor + h * self.s

    def px(self, z):  # x on the supersampled side canvas
        z_nose, z_tail = BOX[0], BOX[1]
        return (z_nose - z) / (z_nose - z_tail) * W * SS

    def py(self, y):  # y on the supersampled side canvas (one half)
        y_bottom, y_top = BOX[2], BOX[3]
        return (y_top - y) / (y_top - y_bottom) * (H // 2) * SS

    def at(self, bs, h):
        return self.px(self.z(bs)), self.py(self.y(h))

    def metres(self, m):  # a horizontal length in mesh metres → canvas pixels
        return m / (BOX[0] - BOX[1]) * W * SS

    def box_bs(self, bs, w, h0, h1):  # a box centred on a station, w metres wide on the aircraft
        half = w / 2 * self.k / 0.0254  # metres on the aircraft → mesh metres
        x0, x1 = self.px(self.z(bs) + half), self.px(self.z(bs) - half)
        return [x0, self.py(self.y(h1)), x1, self.py(self.y(h0))]


# ---------- text ----------

def find_font(cands, override):
    if override:
        return ImageFont.truetype(override, 400)
    for path, index in cands:
        if Path(path).exists():
            return ImageFont.truetype(path, 400, index=index)
    raise SystemExit('no bold sans font found: pass --font /path/to/a/bold/sans.ttf')


def text_image(text, font, stretch, track, space, fill, bold=0.0, slant=0.0):
    """The text as an RGBA image from its cap line to its baseline, cropped to its ink left and right: glyphs widened
    by stretch, followed by track, a space advancing by space, emboldened by a stroke of bold (all in cap heights),
    then sheared so each row moves right by slant × its height above the baseline (an italic of angle atan(slant))."""
    cap = font.getbbox('H')[3] - font.getbbox('H')[1]
    top = font.getbbox('H')[1]
    glyphs, x = [], 0.0
    for ch in text:
        if ch == ' ':
            x += space * cap
            continue
        adv = font.getlength(ch)
        g = Image.new('L', (int(adv * 1.3) + 40, int(cap * 1.6)), 0)
        ImageDraw.Draw(g).text((20, -top + cap * 0.3), ch, font=font, fill=255, stroke_width=round(bold * cap),
                               stroke_fill=255)
        g = g.resize((max(1, round(g.width * stretch)), g.height), Image.LANCZOS)
        glyphs.append((x - 20 * stretch, g))
        x += adv * stretch + track * cap
    width = int(x + 80)
    mask = Image.new('L', (width, int(cap * 1.6)), 0)
    for gx, g in glyphs:
        mask.paste(g, (int(round(gx)) + 40, 0), g)
    bbox = mask.getbbox()
    pad = round(bold * cap)  # the stroke grows the letters above the cap line and below the baseline too
    mask = mask.crop((bbox[0], round(cap * 0.3) - pad, bbox[2], round(cap * 1.3) + pad))  # cap line to baseline
    if slant:
        h = mask.height  # the baseline is row h - pad; rows shift by slant × (h - pad - y), plus slant × pad
        mask = mask.transform((mask.width + math.ceil(slant * h), h), Image.AFFINE, (1, slant, -slant * h, 0, 1, 0),
                              Image.BICUBIC)
        bbox = mask.getbbox()
        mask = mask.crop((bbox[0], 0, bbox[2], h))
    img = Image.new('RGBA', mask.size, fill + (255,))
    img.putalpha(mask)
    return img


def paste_text(canvas, img, box, mirror):
    """Scale img into box (x0, y_cap, x1, y_base) on the canvas; mirrored in place for the right side."""
    x0, y0, x1, y1 = [round(v) for v in box]
    t = img.resize((x1 - x0, y1 - y0), Image.LANCZOS)
    if mirror:
        t = ImageOps.mirror(t)
    canvas.alpha_composite(t, (x0, y0))


# ---------- the body wrap ----------

def rounded(d, box, r, fill=None, outline=None, width=0):
    d.rounded_rectangle([round(v) for v in box], radius=max(1, round(r)), fill=fill, outline=outline, width=width)


def draw_side(f, font, mirror):
    """One side of the fuselage, nose on the left, supersampled."""
    cw, ch = W * SS, H // 2 * SS
    c = Image.new('RGBA', (cw, ch), WHITE + (0,))
    d = ImageDraw.Draw(c)
    # belly below the floor line, then the navy band and the red pinstripe, nose to tail cone (not up the fin: the
    # shader never applies the wrap to the fin)
    d.rectangle([0, round(f.py(f.y(BELLY_TOP_H))), cw, ch], fill=BELLY + (255,))
    d.rectangle([0, round(f.py(f.y(NAVY_H[1]))), cw, round(f.py(f.y(NAVY_H[0])))], fill=NAVY + (255,))
    d.rectangle([0, round(f.py(f.y(RED_H[1]))), cw, round(f.py(f.y(RED_H[0])))], fill=RED + (255,))
    # main-deck windows, with a gap at each door and the door's own window in line with them
    mw = MAIN_WIN
    wr = f.py(f.y(0)) - f.py(f.y(mw['r']))
    bs = mw['first_bs']
    stations = []
    while bs <= mw['last_bs']:
        if all(abs(bs - door) > mw['door_clear_in'] for door in DOORS_BS):
            stations.append(bs)
        bs += mw['pitch_in']
    stations += list(DOORS_BS)
    for bs in stations:
        rounded(d, f.box_bs(bs, mw['w'], mw['centre_h'] - mw['h'] / 2, mw['centre_h'] + mw['h'] / 2), wr,
                fill=WINDOW + (255,))
    # door outlines
    lw = max(1, round(f.metres(LINE_M)))
    dr = f.metres(DOOR_R)
    for bs in DOORS_BS:
        rounded(d, f.box_bs(bs, DOOR_W, 0.0, DOOR_H), dr, outline=SEAM, width=lw)
    # upper-deck windows (the 747SR's short upper deck: ten per side, P1)
    uw = UPPER_WIN
    ur = f.py(f.y(0)) - f.py(f.y(uw['r']))
    for i in range(uw['n']):
        rounded(d, f.box_bs(uw['first_bs'] + i * uw['pitch_in'], uw['w'], uw['centre_h'] - uw['h'] / 2,
                            uw['centre_h'] + uw['h'] / 2), ur, fill=WINDOW + (255,))
    # cockpit side windows at the nose top
    d.polygon([f.at(bs, h) for bs, h in COCKPIT_POLY], fill=COCKPIT + (255,))
    for bs in COCKPIT_POSTS_BS:
        x = f.px(f.z(bs))
        d.line([(x, f.py(f.y(COCKPIT_POLY[0][1]))), (x + f.metres(0.05), f.py(f.y(COCKPIT_POLY[-1][1])))],
               fill=WHITE + (255,), width=lw)
    # the red disc (Hinomaru) behind door 1
    cx, cy = f.at(DISC['bs'], DISC['h'])
    rx = f.metres(DISC['d'] / 2 * f.k / 0.0254)
    ry = f.py(f.y(0)) - f.py(f.y(DISC['d'] / 2))
    d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=RED + (255,))
    # the title and the registration, mirrored in place on the right side
    t = TITLE
    img = text_image(t['text'], font, t['stretch'], t['track'], t['space'], BLACK, t['bold'], t['slant'])
    x0, x1 = f.px(f.z(t['bs'][0])), f.px(f.z(t['bs'][1]))
    paste_text(c, img, (x0, f.py(f.y(t['base_h'] + t['cap'])), x1, f.py(f.y(t['base_h']))), mirror)
    r = REG
    img = text_image(r['text'], font, r['stretch'], r['track'], r['space'], BLACK, r['bold'], r['slant'])
    half = r['width'] / 2 * f.k / 0.0254
    zc = f.z(r['bs_centre'])
    paste_text(c, img, (f.px(zc + half), f.py(f.y(r['base_h'] + r['cap'])), f.px(zc - half), f.py(f.y(r['base_h']))),
               mirror)
    return c


def body_png(f, font):
    left = draw_side(f, font, mirror=False)
    right = draw_side(f, font, mirror=True)
    out = Image.new('RGBA', (W, H))
    out.paste(left.resize((W, H // 2), Image.LANCZOS), (0, 0))
    out.paste(right.resize((W, H // 2), Image.LANCZOS), (0, H // 2))
    return clean_alpha(out)


def clean_alpha(img):
    """Fully transparent pixels carry the base white, so texture filtering blends toward the paint under them."""
    painted = img.getchannel('A').point(lambda v: 255 if v else 0)
    return Image.composite(img, Image.new('RGBA', img.size, WHITE + (0,)), painted)


# ---------- the fin logo (local only) ----------

def fin_png(italic):
    """A simplified 1959 Tsurumaru: the crane's raised wings make a red ring, thin at the top and heavy at the base,
    with feather lines in the wings, the neck rising in an S from the base to a head whose long beak points forward
    (left: the decal is not mirrored on either side), and white italic "JAL" across the red base."""
    # ponytail: a geometric stand-in built from ellipses, arcs and a spline, not a tracing of the Tsurumaru; ceiling:
    # reads as the JAL crane at chase distance, not in a close-up of the fin.
    n = 512 * 4
    R = n * 0.46
    cx, cy = n / 2, n / 2

    def P(x, y):  # unit coordinates (ring radius 1, y up) → pixels
        return cx + x * R, cy - y * R

    ring = Image.new('L', (n, n), 0)
    d = ImageDraw.Draw(ring)
    d.ellipse([cx - R, cy - R, cx + R, cy + R], fill=255)
    inner = Image.new('L', (n, n), 0)
    di = ImageDraw.Draw(inner)
    ir, icy = 0.70, 0.25
    x0, y0 = P(-ir, icy + ir)
    x1, y1 = P(ir, icy - ir)
    di.ellipse([x0, y0, x1, y1], fill=255)
    bowl = Image.new('L', (n, n), 0)  # the inner white ends in a shallow bowl over the red base
    bx0, by0 = P(-1.22, 1.0 + 1.22)
    bx1, by1 = P(1.22, 1.0 - 1.22)
    ImageDraw.Draw(bowl).ellipse([bx0, by0, bx1, by1], fill=255)
    inner = ImageChops.multiply(inner, bowl)
    di = ImageDraw.Draw(inner)
    # feather lines: thin white arcs in each wing, 150°-200° (left) and -20°-30° (right) counter-clockwise from +x;
    # PIL measures clockwise on a y-down image, hence the negated, swapped angles
    for rr in (0.80, 0.87, 0.94):
        box = [cx - rr * R, cy - rr * R, cx + rr * R, cy + rr * R]
        di.arc(box, -200, -150, fill=255, width=round(0.022 * R))
        di.arc(box, -30, 20, fill=255, width=round(0.022 * R))
    red = Image.composite(Image.new('L', (n, n), 0), ring, inner)
    dr = ImageDraw.Draw(red)
    # neck: an S through these points, tapering from the base to the head
    path = [(-0.04, -0.30), (-0.15, -0.05), (-0.13, 0.12), (-0.02, 0.27), (0.10, 0.40), (0.19, 0.52), (0.24, 0.61)]
    widths = [0.22, 0.15, 0.13, 0.12, 0.11, 0.10, 0.10]
    pts = smooth(path, 12)
    wts = smooth([(w, 0) for w in widths], 12)
    for (x, y), (w, _) in zip(pts, wts):
        rx0, ry0 = P(x - w / 2, y + w / 2)
        rx1, ry1 = P(x + w / 2, y - w / 2)
        dr.ellipse([rx0, ry0, rx1, ry1], fill=255)
    # head and the long beak pointing forward
    hx, hy = P(0.25, 0.62)
    hr = 0.085 * R
    dr.ellipse([hx - hr, hy - hr, hx + hr, hy + hr], fill=255)
    dr.polygon([P(0.22, 0.675), P(-0.45, 0.60), P(0.20, 0.575)], fill=255)
    # "JAL": white italic across the base
    font = find_font(italic, None)
    j = text_image('JAL', font, 1.0, 0.04, 0.3, (255, 255, 255))
    cap = 0.26 * R
    jw = round(cap * j.width / j.height)
    j = j.resize((jw, round(cap)), Image.LANCZOS)
    jx, jy = P(0.10, -0.56)
    red.paste(0, (round(jx - jw / 2), round(jy - cap / 2)), j.getchannel('A'))
    out = Image.new('RGBA', (n, n), WHITE + (0,))
    out.paste(Image.new('RGBA', (n, n), RED + (255,)), (0, 0), red)
    return clean_alpha(out.resize((512, 512), Image.LANCZOS))


def smooth(points, k):
    """Catmull-Rom through the points, k samples per segment."""
    out = []
    pts = [points[0]] + list(points) + [points[-1]]
    for i in range(1, len(pts) - 2):
        p0, p1, p2, p3 = pts[i - 1], pts[i], pts[i + 1], pts[i + 2]
        for s in range(k):
            t = s / k
            out.append(tuple(0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t * t
                                    + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t ** 3) for j in range(2)))
    out.append(points[-1])
    return out


# ---------- checks ----------

def check_outputs(f):
    """The written images against the placements: returns the number of failed checks."""
    fails = []

    def ok(cond, msg):
        print(('  ok   ' if cond else '  FAIL ') + msg)
        if not cond:
            fails.append(msg)

    def col(bs):
        return f.px(f.z(bs)) / SS

    def row(h):
        return f.py(f.y(h)) / SS

    b = Image.open(BODY_PNG)
    ok(b.size == (W, H) and b.mode == 'RGBA', 'body.png is %d×%d RGBA (%s %s)' % (W, H, b.size, b.mode))
    px = b.load()
    clear = {px[x, y][:3] for x in range(0, W, 97) for y in range(0, H, 7) if px[x, y][3] == 0}
    ok(clear <= {WHITE}, 'transparent pixels carry the base white')
    t0, t1 = col(TITLE['bs'][0]), col(TITLE['bs'][1])
    for side, off in (('left', 0), ('right', H // 2)):
        x = 2600  # between doors 4 and 5, clear of the registration; h 0.60 is below the windows
        ok(px[x, round(row(0.60)) + off][:3] == NAVY, side + ': navy at h 0.60 m')
        ok(px[x, round(row(1.20)) + off][:3] == RED, side + ': red at h 1.20 m')
        ok(px[x, round(row(2.50)) + off][3] == 0, side + ': clear (base white) at h 2.50 m')
        ok(px[x, round(row(-0.8)) + off] == BELLY + (255,), side + ': belly at h -0.80 m')
        band = b.crop((0, off + round(row(TITLE['base_h'] + TITLE['cap'])), W, off + round(row(TITLE['base_h']))))
        ink = [x for x in range(round(t0) - 40, round(t1) + 40) for y in range(band.height)
               if band.getpixel((x, y))[3] > 128 and sum(band.getpixel((x, y))[:3]) < 150]
        ok(abs(min(ink) - t0) < 3 and abs(max(ink) - t1) < 3, '%s: title ink in columns %d-%d = BS %d-%d (%.0f-%.0f)' % (
            side, min(ink), max(ink), TITLE['bs'][0], TITLE['bs'][1], t0, t1))
    y0, y1 = round(row(TITLE['base_h'] + TITLE['cap'])), round(row(TITLE['base_h']))
    left = ImageOps.mirror(b.crop((int(t0), y0, int(t1) + 1, y1)).getchannel('A'))
    diff = min(max(ImageChops.difference(left, b.crop((int(t0) + s, y0 + H // 2, int(t1) + 1 + s, y1 + H // 2))
                                         .getchannel('A')).getdata()) for s in (-1, 0, 1))
    ok(diff <= 2, 'right title = left title mirrored in place (max alpha difference %d)' % diff)
    ahead = (0, 0, int(t0) - 20, round(row(RED_H[1])))
    ok(ImageChops.difference(b.crop(ahead), b.crop((ahead[0], H // 2, ahead[2], H // 2 + ahead[3]))).getbbox() is None,
       'both sides identical ahead of the title (windows, cockpit, disc)')
    for bs in DOORS_BS:
        x = round(col(bs) - f.metres(DOOR_W / 2 * f.k / 0.0254) / SS)
        seg = [px[x + dx, round(row(1.2))] for dx in range(-2, 3)]
        ok(any(abs(p[0] - SEAM[0]) < 40 and abs(p[2] - SEAM[2]) < 40 for p in seg), 'door outline at BS %d' % bs)
    if FIN_PNG.exists():
        fin = Image.open(FIN_PNG)
        ok(fin.size == (512, 512) and fin.mode == 'RGBA', 'fin.png is 512×512 RGBA')
        ok(fin.getpixel((5, 5))[3] == 0 and fin.getpixel((256, 456))[:3] == RED, 'fin.png: clear corner, red base')
    else:
        print('  --   no fin.png (local only)')
    return len(fails)


def git_ignored(path):
    """True when git ignores path (check-ignore only reads)."""
    try:
        return subprocess.run(['git', 'check-ignore', '-q', str(path)], cwd=ROOT).returncode == 0
    except OSError:
        return False


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1])
    ap.add_argument('--font', help='a bold sans TTF for the titles (default: Helvetica Bold, Arial Bold, Liberation Sans Bold)')
    ap.add_argument('--check', action='store_true', help='print the placements and check the written images, write nothing')
    a = ap.parse_args()

    paint = next(m for m in json.loads(MANIFEST.read_text())['models'] if m['id'] == 'b744')['paint']
    if tuple(paint['body']) != BOX:
        raise SystemExit(f'b744 Paint.body is {paint["body"]}, the wrap contract says {list(BOX)}')
    m = measure(read_glb(GLB))
    f = Frame(m)
    print('b744 mesh: nose z %.3f, tail cone z %.3f, belly y %.2f, crown y %.2f' % tuple(m.values()))
    print('frame: %.5f m per station inch, floor y %.2f, height scale %.3f' % (f.k, f.floor, f.s))
    for name, bs in [('door %d' % (i + 1), b) for i, b in enumerate(DOORS_BS)] + [
            ('title start', TITLE['bs'][0]), ('title end', TITLE['bs'][1]), ('disc', DISC['bs']),
            ('registration', REG['bs_centre']), ('upper-deck windows', UPPER_WIN['first_bs'])]:
        print('  %-18s BS %5d  z %7.2f  column %5.0f' % (name, bs, f.z(bs), f.px(f.z(bs)) / SS))
    for name, h in [('belly top', BELLY_TOP_H), ('navy', NAVY_H[0]), ('red', RED_H[0]), ('red top', RED_H[1]),
                    ('window centre', MAIN_WIN['centre_h']), ('title base', TITLE['base_h']),
                    ('upper windows', UPPER_WIN['centre_h'])]:
        print('  %-18s h %5.2f m  y %6.2f  row %5.1f' % (name, h, f.y(h), f.py(f.y(h)) / SS))
    if not a.check:
        font = find_font(FONTS, a.font)
        print('font:', ' '.join(font.getname()))
        BODY_PNG.parent.mkdir(parents=True, exist_ok=True)
        body_png(f, font).save(BODY_PNG, optimize=True)
        print('wrote', BODY_PNG.relative_to(ROOT))
        FIN_PNG.parent.mkdir(parents=True, exist_ok=True)
        fin_png(ITALIC_FONTS).save(FIN_PNG, optimize=True)
        print('wrote', FIN_PNG.relative_to(ROOT))
    if FIN_PNG.exists() and not git_ignored(FIN_PNG):
        print('WARNING: git does not ignore %s. The crane is a live JAL trademark and stays out of git (design §7): add '
              '"public/scenarios/*/local/" to .gitignore before any git add.' % FIN_PNG.relative_to(ROOT), file=sys.stderr)
    print('checks:')
    return 1 if check_outputs(f) else 0


if __name__ == '__main__':
    sys.exit(main())

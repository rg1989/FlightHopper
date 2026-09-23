#!/usr/bin/env python3
"""Bring every converted model into the one orientation the renderer expects.

The upstream libraries disagree about which way an aeroplane points: across the
68 files we see all four horizontal orientations (+X, -X, +Z, -Z), and one model
is Z-up rather than Y-up. LiveTaiwan's WebGL layer assumes a single convention:

    +X right wing, +Y up, -Z nose

so this script rotates each mesh into that convention, recentres it, and adds the
per-vertex COLOR_0 shade attribute the renderer reads. Orientation is decided by
two independent geometric tests and cross-checked against real span/length
figures; see docs/ORIENTATION.md.

Usage:
    python3 canonicalise.py <in-dir> <out-dir> [--report report.json]
"""
import argparse
import json
import math
import os
import struct
import sys

CHUNK_JSON, CHUNK_BIN = 0x4E4F534A, 0x004E4942
COPYRIGHT = ("GPL-2.0-or-later, derived from FlightGear / FGMEMBERS / "
             "Flightradar24 fr24-3d-models")

# Models the automatic tests cannot call. Helicopters have no wing or tailplane,
# so the fin-height and tail-span tests are meaningless for them; these four were
# set by eye from the rendered contact sheet instead.
#   value = (up_axis, long_axis, nose_sign)  -- axes as source-space indices
OVERRIDES = {
    'B407': (2, 0, +1),   # Z-up in the source; nose toward +X
    'EC35': (1, 2, +1),
    'ec135': (1, 2, -1),
    'GAZL': (1, 2, +1),
}


def read_glb(path):
    blob = open(path, 'rb').read()
    if blob[:4] != b'glTF':
        raise ValueError('not a glb: %s' % path)
    off, gltf, binary = 12, None, None
    while off < len(blob):
        ln, kind = struct.unpack('<II', blob[off:off + 8])
        payload = blob[off + 8:off + 8 + ln]
        if kind == CHUNK_JSON:
            gltf = json.loads(payload)
        elif kind == CHUNK_BIN:
            binary = payload
        off += 8 + ln
    return gltf, binary


def read_accessor(gltf, binary, index):
    acc = gltf['accessors'][index]
    bv = gltf['bufferViews'][acc['bufferView']]
    n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[acc['type']]
    fmt = {5121: 'B', 5123: 'H', 5125: 'I', 5126: 'f'}[acc['componentType']]
    size = struct.calcsize(fmt)
    base = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    raw = binary[base:base + acc['count'] * n * size]
    flat = struct.unpack('<%d%s' % (acc['count'] * n, fmt), raw)
    return [flat[i:i + n] for i in range(0, len(flat), n)] if n > 1 else list(flat)


# ------------------------------------------------------------------ detection

def detect(points):
    """Return (up_axis, long_axis, nose_sign) as source-space axis indices."""
    ext = [max(p[i] for p in points) - min(p[i] for p in points) for i in range(3)]
    up = 1              # every file but B407 is Y-up; B407 is handled in OVERRIDES
    horiz = [i for i in range(3) if i != up]
    centre = [(max(p[i] for p in points) + min(p[i] for p in points)) / 2 for i in range(3)]

    # Test A - the fin is the tallest point; it sits over the tail.
    top = max(points, key=lambda p: p[up])
    frac = {i: abs(top[i] - centre[i]) / (ext[i] / 2 or 1) for i in horiz}
    a_axis = max(horiz, key=lambda i: frac[i])
    a_tail = 1 if top[a_axis] > centre[a_axis] else -1
    a_conf = abs(frac[horiz[0]] - frac[horiz[1]])

    # Test B - the tailplane makes the tail-end slice wider than the nose cone.
    def outer_width(axis, other, sign):
        vals = [p[axis] for p in points]
        lo, hi = min(vals), max(vals)
        cut = lo + (hi - lo) * (0.90 if sign > 0 else 0.10)
        sel = [p[other] for p in points if (p[axis] >= cut if sign > 0 else p[axis] <= cut)]
        return (max(sel) - min(sel)) / (ext[other] or 1) if sel else 0.0

    best = None
    for axis in horiz:
        other = [i for i in horiz if i != axis][0]
        lo, hi = outer_width(axis, other, -1), outer_width(axis, other, +1)
        cand = (abs(hi - lo), axis, 1 if hi > lo else -1)
        if best is None or cand[0] > best[0]:
            best = cand
    b_conf, b_axis, b_tail = best

    # Trust whichever test is more confident when they disagree; in practice they
    # agree on 57 of 68 and the tail-span test wins the rest.
    if (a_axis, a_tail) == (b_axis, b_tail):
        axis, tail, agree = a_axis, a_tail, True
    elif b_conf >= 0.12:
        axis, tail, agree = b_axis, b_tail, False
    else:
        axis, tail, agree = a_axis, a_tail, False
    return up, axis, -tail, (round(a_conf, 3), round(b_conf, 3), agree)


# --------------------------------------------------------------- transform

def canonicalise(points, normals, up, long_axis, nose_sign):
    """Map source axes onto +X right wing / +Y up / -Z nose.

    The mapping must be a proper rotation, not a mirror: the fragment shader
    lights the hull from the vertex normals, and a mirrored basis would turn the
    geometry inside out. Aircraft are symmetric left to right, so we are free to
    pick whichever sign of the span axis keeps the determinant positive.
    """
    span_axis = [i for i in range(3) if i not in (up, long_axis)][0]

    # sign of the permutation that sends (span, up, long) to (X, Y, Z)
    perm = (span_axis, up, long_axis)
    parity = 1
    for i in range(3):
        for k in range(i + 1, 3):
            if perm[i] > perm[k]:
                parity = -parity

    sz = -1 if nose_sign > 0 else 1        # put the nose on -Z
    sx = parity * sz                        # ...and keep the basis right-handed

    def remap(v):
        return [sx * v[span_axis], v[up], sz * v[long_axis]]

    pts = [remap(p) for p in points]
    nrm = [remap(n) for n in normals]

    # Recentre: symmetry plane on X, airframe centre on Z, and the fuselage
    # centreline on Y so an aircraft meets the ground the way the existing
    # procedural models do.
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]; zs = [p[2] for p in pts]
    cx = (max(xs) + min(xs)) / 2
    cz = (max(zs) + min(zs)) / 2
    half_span = (max(xs) - min(xs)) / 2
    fuselage = [p[1] for p in pts if abs(p[0] - cx) < half_span * 0.10]
    cy = ((max(fuselage) + min(fuselage)) / 2) if fuselage else (max(ys) + min(ys)) / 2

    pts = [[p[0] - cx, p[1] - cy, p[2] - cz] for p in pts]
    return pts, nrm


def shade_from_normals(normals):
    """Fake ambient occlusion: upward faces catch the sky, undersides go dark.

    The renderer multiplies the per-instance tint by this value, so on a hull
    with one untextured material it is the only thing giving the shape volume.
    The range is matched to the procedural models already in the fleet.
    """
    out = []
    for n in normals:
        length = math.sqrt(sum(c * c for c in n)) or 1.0
        ny = n[1] / length
        out.append(max(0.0, min(1.0, 0.55 + 0.45 * (ny * 0.5 + 0.5))))
    return out


# ------------------------------------------------------------------- writing

def build_glb(points, normals, shades, indices, name):
    def pack(fmt, rows):
        return b''.join(struct.pack(fmt, *r) for r in rows)

    pos_b = pack('<3f', points)
    nrm_b = pack('<3f', normals)
    col_b = pack('<4B', [(round(s * 255), round(s * 255), round(s * 255), 255) for s in shades])
    idx_b = pack('<H', [(i,) for i in indices])

    blobs, views, offset = [], [], 0
    for data, target in ((pos_b, 34962), (nrm_b, 34962), (col_b, 34962), (idx_b, 34963)):
        pad = (-len(data)) % 4
        views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(data), 'target': target})
        blobs.append(data + b'\x00' * pad)
        offset += len(data) + pad
    binary = b''.join(blobs)

    def mm(rows, i):
        col = [r[i] for r in rows]
        return min(col), max(col)

    gltf = {
        'asset': {'version': '2.0', 'generator': 'livetaiwan canonicalise.py',
                  'copyright': COPYRIGHT},
        'scene': 0,
        'scenes': [{'nodes': [0]}],
        'nodes': [{'mesh': 0, 'name': name}],
        'materials': [{'name': 'hull', 'doubleSided': False,
                       'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1],
                                                'metallicFactor': 0, 'roughnessFactor': 0.5}}],
        'meshes': [{'name': name, 'primitives': [{
            'attributes': {'POSITION': 0, 'NORMAL': 1, 'COLOR_0': 2},
            'indices': 3, 'material': 0}]}],
        'accessors': [
            {'bufferView': 0, 'componentType': 5126, 'count': len(points), 'type': 'VEC3',
             'min': [mm(points, i)[0] for i in range(3)],
             'max': [mm(points, i)[1] for i in range(3)]},
            {'bufferView': 1, 'componentType': 5126, 'count': len(normals), 'type': 'VEC3'},
            {'bufferView': 2, 'componentType': 5121, 'count': len(shades), 'type': 'VEC4',
             'normalized': True},
            {'bufferView': 3, 'componentType': 5123, 'count': len(indices), 'type': 'SCALAR'},
        ],
        'bufferViews': views,
        'buffers': [{'byteLength': len(binary)}],
    }

    js = json.dumps(gltf, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    out = bytearray(b'glTF' + struct.pack('<II', 2, 12 + 8 + len(js) + 8 + len(binary)))
    out += struct.pack('<II', len(js), CHUNK_JSON) + js
    out += struct.pack('<II', len(binary), CHUNK_BIN) + binary
    return bytes(out)


def process(src, dst):
    gltf, binary = read_glb(src)
    prim = gltf['meshes'][0]['primitives'][0]
    points = read_accessor(gltf, binary, prim['attributes']['POSITION'])
    normals = read_accessor(gltf, binary, prim['attributes']['NORMAL'])
    indices = read_accessor(gltf, binary, prim['indices'])
    stem = os.path.basename(src)[:-4]

    if stem in OVERRIDES:
        up, long_axis, nose = OVERRIDES[stem]
        conf = (None, None, 'override')
    else:
        up, long_axis, nose, conf = detect(points)

    pts, nrm = canonicalise(points, normals, up, long_axis, nose)
    shades = shade_from_normals(nrm)
    open(dst, 'wb').write(build_glb(pts, nrm, shades, indices, stem))

    ext = [round(max(p[i] for p in pts) - min(p[i] for p in pts), 2) for i in range(3)]
    return {'model': stem, 'span_x': ext[0], 'height_y': ext[1], 'length_z': ext[2],
            'tris': len(indices) // 3, 'verts': len(pts),
            'kb': round(os.path.getsize(dst) / 1024),
            'source_up': up, 'source_long': long_axis, 'source_nose': nose,
            'confidence': conf}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--report')
    args = ap.parse_args()

    rows = []
    for root, _d, files in os.walk(args.src):
        for name in sorted(files):
            if not name.endswith('.glb'):
                continue
            rel = os.path.relpath(root, args.src)
            outdir = os.path.join(args.dst, rel) if rel != '.' else args.dst
            os.makedirs(outdir, exist_ok=True)
            rows.append(process(os.path.join(root, name), os.path.join(outdir, name)))

    weak = [r for r in rows if r['confidence'][2] is False]
    print('canonicalised %d models' % len(rows))
    print('resolved by tie-break (tests disagreed): %d %s'
          % (len(weak), [r['model'] for r in weak]))
    print('manual overrides: %d %s'
          % (len(OVERRIDES), sorted(OVERRIDES)))
    if args.report:
        json.dump(rows, open(args.report, 'w'), indent=1)
    return 0


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
# tools/models/render.py
# Renders a model GLB from a few orthographic views into one PNG sheet, with optional overlay lines, for eyeballing
# (tools/models/profile.ts --png, tools/models/variants.ts --png). numpy + Pillow; a z-buffer rasteriser, smooth
# shading from the vertex NORMAL, albedo from COLOR_0 (grey without). A triangle seen from its back (by winding: what
# Cesium culls) is drawn magenta, so holes and inverted faces show; a front face whose vertex normals point away from
# the camera shades dark.
#
#   python3 tools/models/render.py spec.json
#
# spec: { "glb": path, "turn": bool (noseMinusZ: the mesh is turned 180° about y, the paint frame), "out": png path,
#         "title": str, "views": [{ "name", "dir": [x,y,z] (camera → model), "up": [x,y,z], "px": width in pixels,
#         "centre": [x,y,z]?, "extent": metres across? (a close-up), "clip": [axis, lo]?, "overlay": [{ "pts": [[x,y,z]…], "color": "#rrggbb",
#         "closed": bool, "width": px, "label": str?, "dots": bool? }] }], "cols": views per row }
# ponytail: reads every primitive's POSITION/NORMAL/COLOR_0 with node transforms; no textures, no sparse accessors.
import json
import struct
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont


def read_glb(path):
    b = open(path, 'rb').read()
    jl = struct.unpack('<I', b[12:16])[0]
    g = json.loads(b[20:20 + jl])
    bin0 = 20 + jl + 8

    def acc(i):
        a = g['accessors'][i]
        bv = g['bufferViews'][a['bufferView']]
        n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]
        dt = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}[a['componentType']]
        stride = bv.get('byteStride')
        o = bin0 + bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        size = np.dtype(dt).itemsize
        if stride and stride != n * size:
            raw = np.frombuffer(b, dtype=np.uint8, count=stride * a['count'], offset=o).reshape(-1, stride)[:, :n * size]
            arr = np.ascontiguousarray(raw).view(dt).reshape(-1, n)
        else:
            arr = np.frombuffer(b, dtype=dt, count=a['count'] * n, offset=o).reshape(-1, n)
        if a.get('normalized') and dt == np.uint8:
            arr = arr / 255.0
        return arr if n > 1 else arr[:, 0]

    P, N, C, T = [], [], [], []

    def trs(n):
        if 'matrix' in n:
            return np.array(n['matrix'], dtype=float).reshape(4, 4).T
        t = n.get('translation', [0, 0, 0])
        x, y, z, w = n.get('rotation', [0, 0, 0, 1])
        s = n.get('scale', [1, 1, 1])
        r = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        m = np.eye(4)
        m[:3, :3] = r * np.array(s)
        m[:3, 3] = t
        return m

    def visit(i, parent):
        n = g['nodes'][i]
        world = parent @ trs(n)
        for prim in (g['meshes'][n['mesh']]['primitives'] if 'mesh' in n else []):
            at = prim['attributes']
            p = acc(at['POSITION']).astype(float)
            p = p @ world[:3, :3].T + world[:3, 3]
            nr = acc(at['NORMAL']).astype(float) @ world[:3, :3].T if 'NORMAL' in at else None
            c = acc(at['COLOR_0'])[:, :3].astype(float) if 'COLOR_0' in at else np.full((len(p), 3), 0.8)
            idx = acc(prim['indices']).astype(np.int64) if 'indices' in prim else np.arange(len(p))
            base = sum(len(q) for q in P)
            if nr is None:
                nr = np.zeros_like(p)
            P.append(p)
            N.append(nr)
            C.append(c)
            T.append(idx.reshape(-1, 3) + base)
        for ch in n.get('children', []):
            visit(ch, world)

    for i in g['scenes'][g.get('scene', 0)]['nodes']:
        visit(i, np.eye(4))
    P, N, C, T = np.concatenate(P), np.concatenate(N), np.concatenate(C), np.concatenate(T)
    # vertices without normals: the face normals
    miss = np.linalg.norm(N, axis=1) < 1e-6
    if miss.any():
        fn = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]])
        for k in range(3):
            np.add.at(N, T[:, k], fn * miss[T[:, k]][:, None])
    N = N / np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
    return P, N, C, T


def camera(d, up):
    d = np.array(d, float)
    d /= np.linalg.norm(d)
    r = np.cross(d, np.array(up, float))
    r /= np.linalg.norm(r)
    u = np.cross(r, d)
    return d, r, u


def render(P, N, C, T, view, light):
    d, r, u = camera(view['dir'], view['up'])
    su, sv, sd = P @ r, P @ u, P @ d
    if 'centre' in view:
        c = np.array(view['centre'], float)
        cu, cv = c @ r, c @ u
        half = view['extent'] / 2
        u0, u1, v0, v1 = cu - half, cu + half, cv - half * view.get('aspect', 1.0), cv + half * view.get('aspect', 1.0)
    else:
        pad = 0.04 * max(su.max() - su.min(), sv.max() - sv.min())
        u0, u1, v0, v1 = su.min() - pad, su.max() + pad, sv.min() - pad, sv.max() + pad
    W = int(view.get('px', 1200))
    s = W / (u1 - u0)
    H = int(np.ceil((v1 - v0) * s))
    X = (su - u0) * s
    Y = (v1 - sv) * s
    zb = np.full((H, W), np.inf)
    img = np.zeros((H, W, 3))
    img[:] = (0.93, 0.95, 0.97)
    L = np.array(light, float)
    L /= np.linalg.norm(L)
    clip = view.get('clip')  # [axis, lo]: only the triangles whose centre is beyond lo on that axis (a close-up's own part)
    for t in T:
        if clip is not None and P[t, clip[0]].mean() < clip[1]:
            continue
        xs, ys = X[t], Y[t]
        x0, x1 = int(max(0, np.floor(xs.min()))), int(min(W - 1, np.ceil(xs.max())))
        y0, y1 = int(max(0, np.floor(ys.min()))), int(min(H - 1, np.ceil(ys.max())))
        if x1 < x0 or y1 < y0:
            continue
        area = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0])
        if abs(area) < 1e-12:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        w0 = ((xs[1] - gx) * (ys[2] - gy) - (xs[2] - gx) * (ys[1] - gy)) / area
        w1 = ((xs[2] - gx) * (ys[0] - gy) - (xs[0] - gx) * (ys[2] - gy)) / area
        w2 = 1 - w0 - w1
        m = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
        if not m.any():
            continue
        z = w0 * sd[t[0]] + w1 * sd[t[1]] + w2 * sd[t[2]]
        sub = zb[y0:y1 + 1, x0:x1 + 1]
        m &= z < sub
        if not m.any():
            continue
        sub[m] = z[m]
        # pixel y grows down, so a face counter-clockwise as the camera sees it (glTF's front) has area < 0
        if area > 0:
            col = np.array([1.0, 0.0, 0.85])
            img[y0:y1 + 1, x0:x1 + 1][m] = col
            continue
        n = w0[m][:, None] * N[t[0]] + w1[m][:, None] * N[t[1]] + w2[m][:, None] * N[t[2]]
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
        alb = w0[m][:, None] * C[t[0]] + w1[m][:, None] * C[t[1]] + w2[m][:, None] * C[t[2]]
        lam = np.clip(n @ L, 0, 1)
        facing = np.clip(-(n @ d), 0, 1)
        shade = 0.28 + 0.55 * lam + 0.25 * facing
        img[y0:y1 + 1, x0:x1 + 1][m] = np.clip(alb * shade[:, None], 0, 1)
    out = Image.fromarray((img * 255).astype(np.uint8))

    def proj(q):
        q = np.array(q, float)
        return float((q @ r - u0) * s), float((v1 - q @ u) * s)

    draw = ImageDraw.Draw(out)
    try:
        font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', max(11, W // 110))
    except OSError:
        font = ImageFont.load_default()
    for o in view.get('overlay', []):
        pts = [proj(q) for q in o['pts']]
        col = o.get('color', '#ff0000')
        wdt = int(o.get('width', 2))
        if o.get('dots'):
            for x, y in pts:
                draw.ellipse([x - 2 * wdt, y - 2 * wdt, x + 2 * wdt, y + 2 * wdt], outline=col, width=wdt)
        elif len(pts) > 1:
            draw.line(pts + ([pts[0]] if o.get('closed') else []), fill=col, width=wdt, joint='curve')
        if o.get('label'):
            x, y = pts[0]
            draw.text((x + 4, y + 2), o['label'], fill=col, font=font)
    draw.text((8, 6), view.get('name', ''), fill='#223', font=font)
    return out


def main():
    spec = json.load(open(sys.argv[1]))
    P, N, C, T = read_glb(spec['glb'])
    if spec.get('turn'):
        P = P * np.array([-1, 1, -1])
        N = N * np.array([-1, 1, -1])
    light = spec.get('light', [0.35, 0.8, 0.45])
    imgs = []
    for v in spec['views']:
        imgs.append(render(P, N, C, T, v, v.get('light', light)))
    cols = spec.get('cols', 1)
    rows = [imgs[i:i + cols] for i in range(0, len(imgs), cols)]
    W = max(sum(i.width for i in row) for row in rows)
    H = sum(max(i.height for i in row) for row in rows) + 30
    sheet = Image.new('RGB', (W, H), (255, 255, 255))
    y = 30
    for row in rows:
        x = 0
        for i in row:
            sheet.paste(i, (x, y))
            x += i.width
        y += max(i.height for i in row)
    try:
        font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 18)
    except OSError:
        font = ImageFont.load_default()
    ImageDraw.Draw(sheet).text((8, 5), spec.get('title', ''), fill='#000', font=font)
    sheet.save(spec['out'])
    print(spec['out'])


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Orthographic contact sheet used to eyeball orientation across the whole fleet.

Renders every model from directly above with the canonical axes mapped so that a
correctly oriented aircraft points UP in its cell: image x = model +X (right
wing), image y = model +Z, and the nose is meant to be at -Z.
"""
import glob, json, math, os, struct, sys
import numpy as np
from PIL import Image, ImageDraw

CJ, CB = 0x4E4F534A, 0x004E4942

def read_glb(path):
    blob = open(path, 'rb').read(); off, g, b = 12, None, None
    while off < len(blob):
        ln, kind = struct.unpack('<II', blob[off:off+8]); pay = blob[off+8:off+8+ln]
        if kind == CJ: g = json.loads(pay)
        elif kind == CB: b = pay
        off += 8 + ln
    return g, b

def acc(g, b, i):
    a = g['accessors'][i]; bv = g['bufferViews'][a['bufferView']]
    n = {'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']]
    dt = {5121:np.uint8,5123:np.uint16,5125:np.uint32,5126:np.float32}[a['componentType']]
    base = bv.get('byteOffset',0)+a.get('byteOffset',0)
    arr = np.frombuffer(b, dtype=dt, count=a['count']*n, offset=base)
    return arr.reshape(-1, n) if n > 1 else arr

def render(path, S=190, view='top'):
    g, b = read_glb(path); p = g['meshes'][0]['primitives'][0]
    P = acc(g, b, p['attributes']['POSITION']).astype(np.float64)
    N = acc(g, b, p['attributes']['NORMAL']).astype(np.float64)
    I = acc(g, b, p['indices']).astype(np.int64)
    if view == 'top':   u, v, d, dn = 0, 2, 1, 1.0     # look down -Y
    else:               u, v, d, dn = 0, 1, 2, -1.0    # look along +Z from behind
    ext = max(P[:,u].max()-P[:,u].min(), P[:,v].max()-P[:,v].min()) or 1
    cu = (P[:,u].max()+P[:,u].min())/2; cv = (P[:,v].max()+P[:,v].min())/2
    sc = (S*0.86)/ext
    X = (P[:,u]-cu)*sc + S/2
    if view == 'top':  Y = (P[:,v]-cv)*sc + S/2        # +Z downward => nose at top
    else:              Y = S/2 - (P[:,v]-cv)*sc        # +Y upward
    D = P[:,d]*dn
    img = np.zeros((S,S,3), np.float32); zb = np.full((S,S), -1e9)
    tri = I.reshape(-1,3)
    light = np.array([0.3,0.6,0.74]); light /= np.linalg.norm(light)
    for t in tri:
        x0,x1,x2 = X[t]; y0,y1,y2 = Y[t]; z0,z1,z2 = D[t]
        minx=max(int(min(x0,x1,x2)),0); maxx=min(int(max(x0,x1,x2))+1,S-1)
        miny=max(int(min(y0,y1,y2)),0); maxy=min(int(max(y0,y1,y2))+1,S-1)
        if minx>maxx or miny>maxy: continue
        area=(x1-x0)*(y2-y0)-(x2-x0)*(y1-y0)
        if abs(area)<1e-9: continue
        ys,xs = np.mgrid[miny:maxy+1, minx:maxx+1]
        w0=((x1-xs)*(y2-ys)-(x2-xs)*(y1-ys))/area
        w1=((x2-xs)*(y0-ys)-(x0-xs)*(y2-ys))/area
        w2=1-w0-w1
        m=(w0>=0)&(w1>=0)&(w2>=0)
        if not m.any(): continue
        z=w0*z0+w1*z1+w2*z2
        nrm=N[t].mean(0); nl=np.linalg.norm(nrm) or 1; nrm=nrm/nl
        sh=0.32+0.68*max(float(np.dot(nrm,light)),0.0)
        upd=m&(z>zb[miny:maxy+1,minx:maxx+1])
        sub=zb[miny:maxy+1,minx:maxx+1]; sub[upd]=z[upd]
        col=img[miny:maxy+1,minx:maxx+1]; col[upd]=np.array([sh*0.85,sh*0.90,sh*1.0])
    out=(np.clip(img,0,1)*255).astype(np.uint8)
    return Image.fromarray(out)

files = sorted(glob.glob(sys.argv[1]))
view = sys.argv[3] if len(sys.argv) > 3 else 'top'
S, COLS = 190, 9
rows = (len(files)+COLS-1)//COLS
sheet = Image.new('RGB', (COLS*S, rows*(S+18)), (12,14,18))
dr = ImageDraw.Draw(sheet)
for i, f in enumerate(files):
    im = render(f, S, view)
    x, y = (i%COLS)*S, (i//COLS)*(S+18)
    sheet.paste(im, (x, y))
    dr.text((x+5, y+S+3), os.path.basename(f)[:-4], fill=(210,215,225))
sheet.save(sys.argv[2])
print('wrote', sys.argv[2], sheet.size, 'view=', view, 'models=', len(files))

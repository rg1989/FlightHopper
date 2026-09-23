// client/scene/mvt.ts
// Just enough Mapbox Vector Tile 2.1 decoding for building footprints: one layer's polygons + properties, rings split
// into polygons with holes and clipped to the tile (neighbouring tiles repeat the buffer strip, which would z-fight).
// ponytail: hand-rolled protobuf reader (~40 lines); take @mapbox/vector-tile + pbf if more layers or geometry types are needed.

type Val = string | number | boolean
export type Pt = [number, number]
export interface Feature { id: number; props: Record<string, Val>; polys: Pt[][][] } // polys[i] = [outer, ...holes]
export interface Layer { extent: number; features: Feature[] }

class Pbf {
  readonly b: Uint8Array
  i: number
  readonly end: number
  constructor(b: Uint8Array, i = 0, end = b.length) {
    this.b = b
    this.i = i
    this.end = end
  }
  varint(): number {
    let v = 0
    let m = 1
    let c: number
    do {
      c = this.b[this.i++]
      v += (c & 0x7f) * m
      m *= 128
    } while (c & 0x80)
    return v
  }
  sub(): Pbf {
    const len = this.varint()
    const s = new Pbf(this.b, this.i, this.i + len)
    this.i += len
    return s
  }
  string(): string {
    const s = this.sub()
    return new TextDecoder().decode(this.b.subarray(s.i, s.end))
  }
  packed(): number[] {
    const s = this.sub()
    const out: number[] = []
    while (s.i < s.end) out.push(s.varint())
    return out
  }
  skip(wt: number): void {
    if (wt === 0) this.varint()
    else if (wt === 1) this.i += 8
    else if (wt === 2) this.i += this.varint()
    else if (wt === 5) this.i += 4
    else throw new Error(`mvt: wire type ${wt}`)
  }
}

const zz = (n: number): number => (n % 2 === 1 ? -(n + 1) / 2 : n / 2)

function value(p: Pbf): Val {
  let v: Val = ''
  const dv = new DataView(p.b.buffer, p.b.byteOffset)
  while (p.i < p.end) {
    const tag = p.varint()
    const f = tag >> 3
    if (f === 1) v = p.string()
    else if (f === 2) (v = dv.getFloat32(p.i, true)), (p.i += 4)
    else if (f === 3) (v = dv.getFloat64(p.i, true)), (p.i += 8)
    else if (f === 4 || f === 5) v = p.varint() // ponytail: int64 read as unsigned; negative ints do not occur in building heights
    else if (f === 6) v = zz(p.varint())
    else if (f === 7) v = p.varint() !== 0
    else p.skip(tag & 7)
  }
  return v
}

/** Command stream → rings in tile coordinates (MoveTo starts a ring, ClosePath ends it). */
export function rings(geom: number[]): Pt[][] {
  const out: Pt[][] = []
  let ring: Pt[] = []
  let x = 0
  let y = 0
  let i = 0
  while (i < geom.length) {
    const cmd = geom[i++]
    const id = cmd & 7
    const n = cmd >> 3
    if (id === 7) {
      if (ring.length) out.push(ring)
      ring = []
      continue
    }
    for (let k = 0; k < n; k++) {
      x += zz(geom[i++])
      y += zz(geom[i++])
      if (id === 1 && ring.length) {
        out.push(ring)
        ring = []
      }
      ring.push([x, y])
    }
  }
  if (ring.length) out.push(ring)
  return out
}

/** Surveyor's formula in tile coordinates (y down): exterior rings are positive, holes negative (MVT spec 4.3.4.4). */
export const area = (r: Pt[]): number => {
  let s = 0
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1]
  return s / 2
}

/** Sutherland–Hodgman against the box [0, e]²; [] when nothing is left. */
export function clip(r: Pt[], e: number): Pt[] {
  if (r.every(([x, y]) => x >= 0 && x <= e && y >= 0 && y <= e)) return r
  let out = r
  for (const [ax, lim, lo] of [[0, 0, true], [0, e, false], [1, 0, true], [1, e, false]] as const) {
    const inp = out
    out = []
    const inside = (p: Pt): boolean => (lo ? p[ax] >= lim : p[ax] <= lim)
    for (let i = 0; i < inp.length; i++) {
      const a = inp[i]
      const b = inp[(i + 1) % inp.length]
      if (inside(a)) out.push(a)
      if (inside(a) !== inside(b)) {
        const t = (lim - a[ax]) / (b[ax] - a[ax])
        out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])])
      }
    }
    if (out.length < 3) return []
  }
  return out
}

/** The named layer's polygon features (type 3), clipped to the tile, or null when the tile has no such layer. */
export function decodeLayer(buf: Uint8Array, name: string): Layer | null {
  const tile = new Pbf(buf)
  while (tile.i < tile.end) {
    const tag = tile.varint()
    if (tag >> 3 !== 3) {
      tile.skip(tag & 7)
      continue
    }
    const l = tile.sub()
    let lname = ''
    let extent = 4096
    const keys: string[] = []
    const vals: Val[] = []
    const raw: Pbf[] = []
    while (l.i < l.end) {
      const t = l.varint()
      const f = t >> 3
      if (f === 1) lname = l.string()
      else if (f === 2) raw.push(l.sub())
      else if (f === 3) keys.push(l.string())
      else if (f === 4) vals.push(value(l.sub()))
      else if (f === 5) extent = l.varint()
      else l.skip(t & 7)
    }
    if (lname !== name) continue
    const features: Feature[] = []
    for (const fp of raw) {
      let id = 0
      let type = 0
      let tags: number[] = []
      let geom: number[] = []
      while (fp.i < fp.end) {
        const t = fp.varint()
        const f = t >> 3
        if (f === 1) id = fp.varint()
        else if (f === 2) tags = fp.packed()
        else if (f === 3) type = fp.varint()
        else if (f === 4) geom = fp.packed()
        else fp.skip(t & 7)
      }
      if (type !== 3) continue
      const props: Record<string, Val> = {}
      for (let k = 0; k < tags.length; k += 2) props[keys[tags[k]]] = vals[tags[k + 1]]
      const polys: Pt[][][] = []
      for (const r of rings(geom)) {
        const a = area(r)
        const c = clip(r, extent)
        if (c.length < 3) continue
        if (a > 0) polys.push([c])
        else if (polys.length) polys[polys.length - 1].push(c)
      }
      if (polys.length) features.push({ id, props, polys })
    }
    return { extent, features }
  }
  return null
}

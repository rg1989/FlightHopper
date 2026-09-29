// client/livery/designs/FDB.ts
// flydubai, the standard scheme (since 2009; the same art on the 737-800, 737-8 and 737-9): a white aircraft, the
// "flydubai" title, an orange stripe that rises from the belly and runs aft over the rear door, blue swoosh bands and a
// navy lower tail, and fin art of blue bands and white arcs that differs between the two sides (left: an orange
// trailing-edge wedge; right: a near-vertical orange band and a navy tip corner). Dossier: .planning/liveries/FDB.md.
//
// Measured on the reference photos (data/livery-refs/FDB/, git-ignored): the fuselage in "real" side-elevation metres
// (z aft of the nose tip, h above the keel; A6-FML, 28 px/m), the fin art in each photo's fin coordinates (u 0 leading
// edge … 1 trailing edge, v 0 root … 1 tip), traced on A6-FML (left) and A6-FMH (right).
import { asset } from '../kit.ts'
import type { Design, Fill, Kit, Pt } from '../kit.ts'

// Paint colours (sRGB), from sunlit and evenly lit photo samples (dossier §3).
const WHITE = '#f4f5f6'
const ORANGE = '#f05a26' // the stripe, the fin orange, the winglets
const ORANGE_DEEP = '#e44d1d' // the inner two thirds of the stripe, the root of the fin orange
const ORANGE_LIGHT = '#f5823a' // the stripe's outer third
const ORANGE_TINT = '#f7a466' // light-dot screens on the fin orange
const NAVY = '#0b2c72'
const BLUE = '#0d4a9e' // the title's "dubai", the winglets' inboard faces
const FIN_DARK = '#3a7cba' // the fin's darkest swoosh
const FIN_MID = '#4895d0' // the fin's main blue
const FIN_AFT = '#579dd0' // the blue along the trailing edge
const LIGHT = '#79bce6'
const LIGHT2 = '#9dcdea'
const PALE = '#c3dff0'
const BAND1 = '#9ccbea' // the fuselage swoosh bands, fore to aft
const BAND2 = '#6fb6e2'
const BAND3 = '#3a88c8'
const WING = '#babec2'
const NACELLE = '#e8eaec'

type UV = [u: number, v: number]
type XY = [number, number]

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** A Catmull-Rom curve through the points, n samples per span (both ends included). */
function curve(pts: XY[], n = 6): XY[] {
  if (pts.length < 3) return pts
  const out: XY[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    for (let j = 0; j < n; j++) {
      const t = j / n
      const f = (a: number, b: number, c: number, d: number): number =>
        0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t)
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])])
    }
  }
  out.push(pts[pts.length - 1])
  return out
}

/** Whether (z, y) is inside a polygon (even-odd). */
function inside(poly: Pt[], z: number, y: number): boolean {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [zi, yi] = poly[i]
    const [zj, yj] = poly[j]
    if (yi > y !== yj > y && z < ((zj - zi) * (y - yi)) / (yj - yi) + zi) hit = !hit
  }
  return hit
}

/** Shifts a fin curve along the chord (du < 0: towards the leading edge). */
const shiftU = (c: UV[], du: number): UV[] => c.map(([u, v]): UV => [u + du, v])

// The real fin (A6-FML, corrected to its true edges): leading edge (31.64, 3.77)–(37.93, 11.29), trailing edge
// (37.46, 3.77)–(39.47, 11.29); v = (h − 3.77) / 7.52.
const REAL_LE: [number, number] = [31.64, 37.93]
const REAL_TE: [number, number] = [37.46, 39.47]
/** A right-photo fin point (raw) in real metres. */
function rightReal(u: number, v: number): XY {
  const c = (u + 0.09) / 1.11
  return [lerp(lerp(REAL_LE[0], REAL_LE[1], v), lerp(REAL_TE[0], REAL_TE[1], v), c), 3.77 + 7.52 * v]
}

/**
 * Where the photos' measurements land on this model. P(z, h): a fuselage point (real metres), which near the fin root
 * follows the model's fin (so the fuselage art meets the fin art as on the aircraft). L(u, v) and R(u, v): a point of
 * the left and right photo's fin frame (each corrected to its fin's true leading and trailing edge).
 */
function frame(k: Kit): { P: (z: number, h: number) => Pt; L: (u: number, v: number) => Pt; R: (u: number, v: number) => Pt; s: number; hs: number } {
  const s = (k.a.nose - k.a.finTip[2]) / 39.45 // the real fin's trailing-edge tip is 39.45 m aft of the nose
  const zRef = k.a.nose - 12 * s
  const keel = k.bottom(zRef)
  const hs = (k.top(zRef) - keel) / 4.01 // the real fuselage is 4.01 m tall
  const nb = (z: number, h: number): Pt => [k.a.nose - z * s, keel + h * hs]
  const ff = (z: number, h: number): Pt => {
    const v = (h - 3.77) / 7.52
    const le = lerp(REAL_LE[0], REAL_LE[1], v)
    const te = lerp(REAL_TE[0], REAL_TE[1], v)
    return k.fin((z - le) / (te - le), v)
  }
  const P = (z: number, h: number): Pt => {
    const w = smoothstep(3.0, 4.2, h)
    const a = nb(z, h)
    if (w <= 0) return a
    const b = ff(z, h)
    return [lerp(a[0], b[0], w), lerp(a[1], b[1], w)]
  }
  return { P, L: (u, v) => k.fin((u - 0.035) / 0.975, v), R: (u, v) => k.fin((u + 0.09) / 1.11, v), s, hs }
}

/** A ribbon between rungs [fore/upper edge point, aft/lower edge point]: its outline between fractions t0 and t1 across. */
type Rung = [z0: number, h0: number, z1: number, h1: number]
function ribbon(rungs: Rung[], t0 = 0, t1 = 1): XY[] {
  const a = curve(rungs.map(([z0, h0, z1, h1]): XY => [lerp(z0, z1, t0), lerp(h0, h1, t0)]))
  const b = curve(rungs.map(([z0, h0, z1, h1]): XY => [lerp(z0, z1, t1), lerp(h0, h1, t1)]))
  return [...a, ...b.reverse()]
}
const edge = (rungs: Rung[], t: number): XY[] => curve(rungs.map(([z0, h0, z1, h1]): XY => [lerp(z0, z1, t), lerp(h0, h1, t)]))

// ---- The fuselage (real metres) ----

/** The orange stripe from under the belly up and aft to over the rear door (both sides). */
const STRIPE_COMMON: Rung[] = [
  [27.7, -1.0, 28.3, -1.0],
  [27.95, 0, 28.5, 0],
  [28.05, 0.5, 28.55, 0.5],
  [28.1, 1.0, 28.65, 1.0],
  [28.35, 1.5, 28.85, 1.5],
  [28.58, 2.0, 29.02, 2.0],
  [28.95, 2.5, 29.32, 2.5],
  [29.2, 2.8, 29.6, 2.72],
  [29.5, 3.05, 29.85, 2.9],
  [29.8, 3.22, 30.05, 3.08],
  [30.2, 3.34, 30.3, 3.16],
  [30.6, 3.46, 30.6, 3.18],
  [31.0, 3.56, 31.0, 3.2],
  [32.0, 3.6, 32.0, 3.19],
]
/** Left: it runs on, thickening, and rises into the fin's trailing-edge wedge. */
const STRIPE_LEFT: Rung[] = [
  ...STRIPE_COMMON,
  [32.5, 3.56, 32.5, 3.12],
  [33.0, 3.53, 33.0, 3.02],
  [34.0, 3.53, 34.0, 2.96],
  [34.6, 3.6, 34.6, 2.96],
  [35.2, 3.72, 35.2, 3.0],
  [35.8, 3.95, 35.8, 3.12],
  [36.6, 4.4, 36.6, 3.25],
  [37.6, 4.6, 37.6, 3.3],
  [39.0, 4.6, 39.0, 3.35],
  [40.5, 4.6, 40.5, 3.4],
]
/**
 * Right: it stays about 0.3 m wide to just aft of the rear door, then sweeps up as a smooth crescent about 0.6 m wide
 * through the bend and 0.8 m higher up, climbing the fin as a near-vertical band until the leading edge cuts it off
 * (A6-FMH, the band in fin coordinates turned into metres).
 */
const STRIPE_RIGHT: Rung[] = [
  ...STRIPE_COMMON,
  [32.8, 3.58, 32.95, 3.16],
  [33.5, 3.66, 33.85, 3.2],
  [33.95, 3.82, 34.45, 3.4],
  [34.28, 4.05, 34.82, 3.74],
  [34.45, 4.3, 35.03, 4.18],
  [34.55, 4.6, 35.13, 4.57],
  [34.5, 4.9, 35.15, 4.9],
  [34.38, 5.25, 35.1, 5.25],
  [34.2, 5.6, 35.0, 5.6],
  [34.0, 5.95, 34.86, 5.95],
  [33.75, 6.3, 34.76, 6.3],
  [33.55, 6.65, 34.62, 6.65],
  [33.5, 7.0, 34.44, 7.0],
  [33.5, 7.4, 34.2, 7.3],
]

/** The swoosh bands between the stripe and the navy: each rises from the belly, leans aft and runs out under the stripe. */
const BANDS: Array<[Rung[], string]> = [
  [[
    [28.9, -1.0, 29.45, -1.0], [29.1, 0, 29.6, 0], [29.25, 0.5, 29.75, 0.5], [29.35, 1.0, 29.9, 1.0], [29.6, 1.5, 30.05, 1.5],
    [30.2, 2.0, 30.65, 2.0], [30.7, 2.3, 31.2, 2.25], [31.2, 2.55, 31.7, 2.45], [31.7, 2.78, 32.0, 2.62], [32.3, 2.9, 32.4, 2.74],
    [33.0, 2.95, 33.0, 2.84], [33.6, 2.95, 33.6, 2.93],
  ], BAND1],
  [[
    [29.8, -1.0, 30.3, -1.0], [29.95, 0, 30.4, 0], [30.05, 0.5, 30.45, 0.5], [30.15, 1.0, 30.55, 1.0], [30.35, 1.5, 30.85, 1.5],
    [30.95, 2.0, 31.45, 2.0], [31.5, 2.3, 32.0, 2.22], [32.0, 2.52, 32.45, 2.42], [32.6, 2.74, 32.85, 2.6], [33.3, 2.84, 33.35, 2.7],
    [34.0, 2.88, 34.0, 2.79], [34.6, 2.89, 34.6, 2.87],
  ], BAND2],
  [[
    [30.5, -1.0, 31.1, -1.0], [30.6, 0, 31.2, 0], [30.65, 0.5, 31.3, 0.5], [30.75, 1.0, 31.45, 1.0], [31.15, 1.5, 31.85, 1.5],
    [31.75, 2.0, 32.25, 2.0], [32.3, 2.25, 32.8, 2.18], [32.85, 2.48, 33.3, 2.4], [33.6, 2.66, 33.9, 2.54], [34.3, 2.77, 34.4, 2.66],
    [35.0, 2.83, 35.0, 2.77], [35.5, 2.86, 35.5, 2.85],
  ], BAND3],
]

/** The navy lower tail: its front and top edge (it fills everything below). */
const NAVY_EDGE: XY[] = [
  [31.2, -1.0], [31.35, 0], [31.6, 0.5], [31.95, 1.0], [32.2, 1.5], [32.6, 1.9], [33.05, 2.2], [33.55, 2.44], [34.2, 2.6],
  [34.8, 2.71], [35.5, 2.8], [36.1, 2.94], [37.0, 3.08], [38.5, 3.16], [40.5, 3.22],
]

// ---- The fin art (each photo's fin frame, raw) ----

/**
 * Left fin (A6-FML), curves from the root up to the leading edge (or the tip): F the white fillet's edge, A B C the
 * white arcs, K and T the dark swoosh's fore and aft edges, D the white arc over the trailing-edge wedge (it meets the
 * trailing edge at v 0.48), O the orange's upper edge (it meets it lower, at v 0.33, a light-blue sliver above it).
 */
const LF: Record<'F' | 'A' | 'B' | 'C' | 'K' | 'T' | 'D' | 'O', UV[]> = {
  F: [[0.3, -0.08], [0.26, 0.0], [0.22, 0.07], [0.16, 0.125], [0.09, 0.18], [0.03, 0.235], [-0.1, 0.31]],
  A: [[0.36, -0.08], [0.34, 0.06], [0.305, 0.16], [0.24, 0.235], [0.14, 0.295], [0.03, 0.35], [-0.1, 0.39]],
  B: [[0.575, -0.08], [0.6, 0.08], [0.595, 0.2], [0.555, 0.3], [0.48, 0.385], [0.36, 0.465], [0.2, 0.54], [0.05, 0.595], [-0.1, 0.64]],
  C: [[0.655, -0.08], [0.69, 0.08], [0.715, 0.22], [0.705, 0.33], [0.655, 0.42], [0.56, 0.51], [0.43, 0.59], [0.28, 0.67], [0.13, 0.725],
    [0.03, 0.77], [-0.1, 0.82]],
  K: [[0.73, 0.25], [0.72, 0.36], [0.68, 0.46], [0.6, 0.57], [0.48, 0.68], [0.35, 0.78], [0.22, 0.87], [0.1, 0.95], [-0.1, 1.05]],
  T: [[0.93, -0.1], [0.9, 0.2], [0.875, 0.4], [0.83, 0.53], [0.74, 0.65], [0.6, 0.77], [0.46, 0.87], [0.36, 0.95], [0.3, 1.1]],
  D: [[0.66, -0.08], [0.7, 0.01], [0.77, 0.085], [0.85, 0.16], [0.9, 0.24], [0.95, 0.33], [0.99, 0.42], [1.04, 0.52]],
  O: [[0.64, -0.08], [0.7, 0.02], [0.78, 0.1], [0.85, 0.2], [0.93, 0.28], [1.02, 0.34]],
}

/**
 * Right fin (A6-FMH): F the fillet's edge, R0 the white arc ahead of the orange band, R2 the one behind it, RT the
 * lighter swoosh along the trailing edge, NW the white arc round the navy tip corner.
 */
const RF: Record<'F' | 'R0' | 'R2' | 'RT' | 'NW', UV[]> = {
  F: [[0.08, -0.08], [0.02, 0.02], [-0.06, 0.1], [-0.13, 0.17], [-0.25, 0.27]],
  R0: [[0.13, -0.08], [0.17, 0.0], [0.155, 0.07], [0.1, 0.14], [0.02, 0.21], [-0.15, 0.3]],
  R2: [[0.6, -0.08], [0.6, 0.1], [0.57, 0.2], [0.515, 0.29], [0.43, 0.37], [0.32, 0.445], [0.18, 0.515], [0.05, 0.57], [-0.15, 0.63]],
  RT: [[0.74, -0.08], [0.78, 0.06], [0.85, 0.18], [0.875, 0.32], [0.85, 0.45], [0.74, 0.58], [0.52, 0.7], [0.28, 0.8], [0.1, 0.9], [-0.15, 1.0]],
  NW: [[-0.15, 0.99], [0.05, 0.935], [0.25, 0.89], [0.45, 0.843], [0.62, 0.795], [0.76, 0.745], [0.87, 0.695], [0.94, 0.645], [1.1, 0.57]],
}

/**
 * The tailplane root's side projection out to the body half-width, measured on the b738 / b38m mesh (same tail):
 * the leading edge from the fuselage (0.8 m out) to 2.1 m out, the trailing edge back, the upper surface's height
 * there (it has 10° of dihedral) and at the root. Null on other models.
 */
function stabRoot(k: Kit): Pt[] | null {
  if (!k.p.stab || !(k.model === 'b738' || k.model === 'b38m')) return null
  const z = k.p.stab[1] // the root leading edge
  const y = k.a.finRoot[0]
  return [[z + 0.12, y - 0.67], [z + 0.14, y - 0.62], [z - 0.84, y - 0.3], [z - 3.62, y - 0.3], [z - 3.4, y - 0.67]]
}

/** The tailplane root's lower surface in plan view (z, y across), both sides: from the tail cone out to 2.25 m. */
function stabRootBelow(k: Kit): Pt[][] {
  if (!k.p.stab || !(k.model === 'b738' || k.model === 'b38m')) return []
  const z = k.p.stab[1]
  const inner = (zz: number): number => Math.max(0.1, 0.9 + 0.23 * (zz - z - 0.18)) // the tail cone's half-width at the root
  const zs = [z + 0.15, z - 0.5, z - 1.2, z - 2, z - 2.8, z - 3.45]
  const one: Pt[] = [...zs.map((zz): Pt => [zz, inner(zz) - 0.02]), [z - 3.62, 2.25], [z - 0.88, 2.25]]
  return [one, one.map(([a, b]): Pt => [a, -b])]
}

function side(k: Kit): void {
  const { P, L, R, s, hs } = frame(k)
  const left = k.side === 'left'
  const F = left ? L : R
  const at = (pts: XY[]): Pt[] => pts.map(([z, h]) => P(z, h))
  const onFin = (pts: UV[]): Pt[] => pts.map(([u, v]) => F(u, v))
  /** The part of the fin (and the fuselage just under it) ahead of a curve that runs from the root to the leading edge. */
  const ahead = (c: UV[], color: Fill): void => {
    const pts = curve(c)
    k.poly(onFin([...pts, [-2.5, pts[pts.length - 1][1]], [-2.5, pts[0][1]]]), color)
  }
  /** The part of the fin behind a curve, to past the trailing edge (and up to v = top). */
  const behind = (c: UV[], color: Fill, top = 1.3): void => {
    const pts = curve(c)
    k.poly(onFin([...pts, [1.6, Math.max(top, pts[pts.length - 1][1])], [1.6, pts[0][1]]]), color)
  }
  const arc = (c: UV[], widthM: number, color = WHITE): void => {
    k.stroke(onFin(curve(c)), widthM, color)
  }
  /** A gradient along the fin's height, from v0 to v1. */
  const upFin = (v0: number, v1: number, stops: Array<[number, string]>): Fill => {
    const [z0, y0] = F(0.5, v0)
    const [z1, y1] = F(0.5, v1)
    return { linear: [z0, y0, z1, y1], stops }
  }
  // The model's fin frame backwards: a model point → this side's photo fin coordinates.
  const [fy0, fle0, fte0] = k.a.finRoot
  const [fy1, fle1, fte1] = k.a.finTip
  const uvOf = (z: number, y: number): UV => {
    const v = (y - fy0) / (fy1 - fy0)
    const le = lerp(fle0, fle1, v)
    const u = (z - le) / (lerp(fte0, fte1, v) - le)
    return [left ? u * 0.975 + 0.035 : u * 1.11 - 0.09, v]
  }
  /** A halftone screen inside a region: dots on a square grid `pitch` metres apart, each covering cover(u, v) of its cell. */
  const screen = (region: Pt[], pitch: number, color: string, cover: (u: number, v: number) => number): void => {
    const zs = region.map((p) => p[0])
    const ys = region.map((p) => p[1])
    const near = (z: number, y: number, r: number): boolean =>
      inside(region, z, y) || inside(region, z - r, y) || inside(region, z + r, y) || inside(region, z, y - r) || inside(region, z, y + r)
    k.clip(region, () => {
      for (let z = Math.floor(Math.min(...zs) / pitch) * pitch; z <= Math.max(...zs); z += pitch) {
        for (let y = Math.floor(Math.min(...ys) / pitch) * pitch; y <= Math.max(...ys); y += pitch) {
          const [u, v] = uvOf(z, y)
          if (u < -0.15 || u > 1.15 || v > 1.05) continue // off the fin
          const c = Math.min(1.6, cover(u, v))
          const r = pitch * Math.sqrt(c / Math.PI)
          if (c > 0.04 && near(z, y, r)) k.circle(z, y, r, color)
        }
      }
    })
  }
  const upper = (c: UV[], v: number): UV[] => curve(c).filter((p) => p[1] >= v)

  k.fill(WHITE)

  // The fin art, from the trailing edge forward, each region over the last; its foot is covered by the stripe.
  k.clip(onFin([[-0.6, -0.06], [-0.6, 1.3], [1.8, 1.3], [1.8, -0.06]]), () => {
    if (left) {
      // The trailing-edge strip, an even mid blue; the dark swoosh ahead of it, darker than the strip low down and
      // lightening past it near the tip (A6-FML: #2e72aa → #5aa5d6 against #4d8cb8). Both a little lighter than the
      // photo, as the model's rudder facet renders about 40 % darker than the fin ahead of it.
      k.poly(onFin([[-3, -0.1], [-3, 1.3], [1.8, 1.3], [1.8, -0.1]]), upFin(0.4, 1.0, [[0, '#62a9da'], [1, '#5fa5d6']]))
      ahead(LF.T, upFin(0.3, 0.97, [[0, '#3f86c6'], [0.45, '#4a93cf'], [0.82, '#62acdd'], [1, LIGHT]]))
      ahead(LF.K, upFin(0.4, 0.95, [[0, FIN_MID], [0.5, '#5aa3d8'], [1, LIGHT]]))
      ahead(LF.C, FIN_MID)
      ahead(shiftU(LF.C, -0.09), LIGHT)
      ahead(LF.B, '#66addf')
      ahead(shiftU(LF.B, -0.05), LIGHT2)
      ahead(LF.A, PALE)
      // dot screens: light-blue dots on the pale field up the leading edge, lighter dots high on the leading-edge side
      screen(onFin([...curve(shiftU(LF.B, -0.05)), ...curve(LF.F).reverse()]), 0.1, LIGHT, (_u, v) => 0.12 + 0.3 * smoothstep(0.0, 0.45, v))
      screen(onFin([...upper(LF.C, 0.45), [-0.4, 0.82], [-0.4, 1.3], [0.3, 1.3], ...upper(LF.K, 0.45).reverse()]), 0.1, '#9dd0ef',
        (_u, v) => 0.18 + 0.25 * smoothstep(0.6, 0.95, v))
      arc(LF.A, 0.2)
      arc(LF.B, 0.22)
      arc(LF.C, 0.22)
      // the orange trailing-edge wedge behind arc D: a light-dot screen at its top, deep at the root
      behind(LF.D, LIGHT, 0.6)
      behind(LF.O, upFin(0.36, -0.05, [[0, '#ee7a3c'], [0.35, '#f27036'], [0.6, ORANGE], [1, ORANGE_DEEP]]), 0.4)
      screen(onFin([...upper(LF.O, 0.12), [1.6, 0.4], [1.6, 0.12]]), 0.1, ORANGE_TINT, (_u, v) => 0.7 * smoothstep(0.12, 0.32, v))
      arc(LF.D, 0.2)
      ahead(LF.F, WHITE)
    } else {
      k.poly(onFin([[-3, -0.1], [-3, 1.3], [1.8, 1.3], [1.8, -0.1]]), FIN_DARK)
      behind(RF.RT, FIN_AFT)
      behind(RF.NW, NAVY)
      k.poly(onFin([[-2.5, 0.45], [0.17, 0.45], [0.18, 0.6], [0.14, 0.72], [0.04, 0.8], [-2.5, 0.82]]), FIN_MID) // along the leading edge
      ahead(RF.R2, FIN_MID)
      ahead(shiftU(RF.R2, -0.06), LIGHT)
      ahead(RF.R0, LIGHT2)
      ahead(RF.F, WHITE)
      screen(onFin([...upper(RF.R2, 0.5), [-0.4, 0.63], [-0.4, 1.1], ...upper(RF.RT, 0.5).reverse()]), 0.1, '#62aadd', () => 0.3)
      screen(onFin([...upper(RF.NW, 0), [1.6, 0.57], [1.6, 1.3], [-0.4, 1.3]]), 0.1, '#28559c', (_u, v) => 0.35 * smoothstep(0.9, 0.98, v))
      arc(RF.R0, 0.2)
      arc(RF.R2, 0.22)
      arc(RF.NW, 0.26)
      k.poly(onFin([[0.93, -0.3], [0.93, 0.02], [0.96, 0.08], [1.6, 0.1], [1.6, -0.3]]), NAVY) // the trailing-edge root corner
    }
  })

  // The fuselage: swoosh bands, the navy lower tail (on the right also over the tail cone), the orange stripe.
  for (const [rungs, color] of BANDS) k.poly(at(ribbon(rungs)), color)
  k.poly(at([...curve(NAVY_EDGE), [41, -3], [31, -3]]), NAVY)
  if (!left) k.poly(onFin([[0.93, -0.8], [0.93, 0.02], [0.96, 0.08], [1.6, 0.1], [1.6, -0.8]]), NAVY)
  if (left) {
    k.poly(at(ribbon(STRIPE_LEFT)), ORANGE_DEEP)
    k.poly(at(ribbon(STRIPE_LEFT.slice(0, 19), 0, 0.36)), ORANGE_LIGHT)
  } else {
    // the right band: white edges on the fin, solid orange below, a light-dot screen on its upper 40 %
    const n = STRIPE_COMMON.length
    k.stroke(at(edge(STRIPE_RIGHT.slice(n + 1), -0.12)), 0.12, WHITE)
    k.stroke(at(edge(STRIPE_RIGHT.slice(n + 1), 1.12)), 0.12, WHITE)
    const [gz0, gy0] = P(34.2, 6.6)
    const [gz1, gy1] = P(34.6, 5.3)
    k.poly(at(ribbon(STRIPE_RIGHT)), ORANGE_DEEP)
    k.poly(at(ribbon(STRIPE_RIGHT.slice(0, n + 8), 0, 0.36)), ORANGE_LIGHT)
    // its upper part: orange dots on light blue, merging into solid orange lower down
    const top = at(ribbon(STRIPE_RIGHT.slice(n + 5)))
    k.poly(top, { linear: [gz0, gy0, gz1, gy1], stops: [[0, LIGHT], [0.5, '#9fc6dc'], [0.75, '#f08a55'], [1, ORANGE]] })
    screen(top, 0.1, ORANGE, (_u, v) => lerp(0.22, 1.6, smoothstep(0.38, 0.14, v)))
  }

  // The tailplane is plain grey on both surfaces (A6-FED, A6-FMA, A6-FMN), but the shader paints its root with the
  // skin atlas out to the body half-width (2.1 m), so the root's upper surface takes the art at its height (on the left
  // the orange run). Grey over the root's side projection, between its leading and trailing edges up to its height at
  // 2.1 m out (the tail cone's flank in there is behind the tailplane from the side). Its lower surface: belly().
  const sr = stabRoot(k)
  if (sr) k.poly(sr, WING)

  // The title, z 6.0–18.2 and 2.14 m tall on both sides (the kit keeps it reading forwards on the right); its middle
  // is 0.08 m above the window line, which runs through the lower half of the small letters.
  const [tz] = P(12.1, 0)
  k.image(asset('liveries/FDB/title.svg'), { z: tz, y: k.a.windowY + 0.08 * hs, w: 12.2 * s, h: 2.14 * hs })
}

export const FDB: Design = {
  code: 'FDB',
  name: 'flydubai (2009 scheme)',
  sources: [
    'https://commons.wikimedia.org/wiki/File:A6-FML_@_DXB,_2022-03-30.jpg (Anna Zvereva, CC BY-SA 2.0): left side',
    'https://commons.wikimedia.org/wiki/File:FlyDubai,_A6-FMH,_Boeing_737-8_MAX_(53812657763).jpg (Anna Zvereva, CC BY-SA 2.0): right side',
    'https://commons.wikimedia.org/wiki/File:FlyDubai,_A6-FMA,_Boeing_737-8_MAX_(45620442302).jpg (Anna Zvereva, CC BY-SA 2.0): right side',
    'https://commons.wikimedia.org/wiki/File:A6-FED_Boeing_738WL_FlyDubai_Tail_(12237999613).jpg (Aeroprints.com, CC BY-SA 3.0): left fin',
    'https://commons.wikimedia.org/wiki/File:TLV-FlyDubai_Boeing_737_MAX8_A6-FMH.jpg (ronen fefer, CC BY-SA 2.0): winglets, engines',
    'https://commons.wikimedia.org/wiki/File:Flydubai_737_8-MAX_(A6-FMN)_taking_off_from_Pisa_airport,_P4_parking,_2024.jpg (Marcxosm, CC BY 4.0): belly',
    'https://commons.wikimedia.org/wiki/File:Fly_Dubai_logo_2010_03.svg (PD-textlogo): the title',
  ],
  base: WHITE,
  wing: WING,
  stab: WING,
  engineColor: NACELLE,
  wingletColor: ORANGE,
  side,
  belly(k) {
    for (const p of stabRootBelow(k)) k.poly(p, WING)
  },
  engine(k) {
    // Plain white cowls, a polished inlet lip, the grey core nozzle and plug at the back.
    const [z0, z1] = [k.a.box[0], k.a.box[1]]
    k.fill(NACELLE)
    k.poly([[z1 - 0.28, -99], [z1 - 0.28, 99], [z1 + 1, 99], [z1 + 1, -99]], '#c9c9c6')
    k.poly([[z0 - 1, -99], [z0 - 1, 99], [z0 + 0.12 * (z1 - z0), 99], [z0 + 0.12 * (z1 - z0), -99]], '#9a9ea3')
  },
  winglet(k) {
    // The tip atlas's "left" half paints both outboard faces, its "right" half both inboard faces (livery.ts).
    // The upper element's leading and trailing edges from the wing-tip plane (t 0) to its tip (t 1), as box fractions
    // measured on the b38m mesh (A6-FMH, A6-FMN: the art follows the element).
    const [z0, z1, , y1] = k.a.box
    const tipY = k.p.wing[4]
    const Y = (t: number): number => lerp(tipY, y1, t)
    const le = (t: number): number => lerp(z1, z0 + 0.13 * (z1 - z0), t)
    const te = (t: number): number => lerp(z1 - 0.62 * (z1 - z0), z0, t)
    if (k.side === 'left') {
      // Outboard: orange on both elements; over the upper element's upper half a screen of light dots on a deeper orange
      // (a 45° lattice 7.5 cm apart, the dots growing to half the area over its lowest 0.35 m).
      k.fill(ORANGE)
      const t0 = 0.45
      const ys = Y(t0)
      k.poly([[99, ys], [-99, ys], [-99, y1 + 1], [99, y1 + 1]], { linear: [0, ys, 0, ys + 0.35], stops: [[0, ORANGE], [1, '#c9531f']] })
      const d = 0.075 / Math.SQRT2
      for (let j = Math.floor(ys / d); j * d <= y1 + d; j++) {
        const y = j * d
        const t = (y - tipY) / (y1 - tipY)
        const cover = lerp(0.06, 0.5, smoothstep(ys, ys + 0.35, y))
        const r = 0.075 * Math.sqrt(cover / Math.PI)
        for (let i = Math.floor((te(t) - 0.1) / d); i * d <= le(t) + 0.1; i++) if ((i + j) % 2 === 0) k.circle(i * d, y, r, '#fbb57f')
      }
    } else {
      // Inboard: flydubai blue on the upper element with the wordmark up its span, letter tops to the leading edge
      // ("fly" at the root, as on the right winglet), the ventral element navy.
      // ponytail: one half paints both inboard faces, so the left winglet shows the right one's wordmark mirrored (on
      // the aircraft its "fly" is at the tip); a readable wordmark on both needs a third tip-atlas region.
      k.fill(BLUE)
      k.poly([[99, tipY], [-99, tipY], [-99, tipY - 9], [99, tipY - 9]], NAVY)
      const t = 0.55
      k.image(asset('liveries/FDB/winglet-wordmark.svg'), { z: (le(t) + te(t)) / 2, y: Y(t), h: 1.285 * ((y1 - tipY) / 2.13), mirror: true })
    }
  },
}

// client/livery/designs/ELY.ts
// El Al (ELY), on the 737-800 / 737-900ER (model b738) and the 787-8 / 787-9 (model b789). Two schemes fly at once:
//   A, the 1999 "blue and silver ribbons": a white aircraft, one diagonal band from the belly behind door 1 up to the crown
//      above the wing with a metallic ribbon along its lower edge, the swept-flag fin (two stripes with ribbons and a Star
//      of David), the two-tone bilingual title. Two colour sub-variants:
//      A1, the classic navy with silver ribbons; A2, the brighter royal blue with a half-tone and champagne ribbons
//      (every 787, and the 737s repainted from 2018), with the larger fin star.
//   B, the 2025 refresh: the same band in one medium blue, no ribbons, all-blue titles much larger, and the lower fin
//      stripe run down over the whole rear fuselage, belly and tail cone as one blue area.
// The Sun d'Or frames (El Al's charter arm, flying as ELY) wear their own paint; with no free Sun d'Or logo they are
// drawn plain white (SUNDOR). The special liveries (4X-EDF retro, 4X-EDM "Jerusalem of Gold") are drawn in their base
// scheme.
// Measurements: .planning/liveries/ELY.md (the dossier: x metres aft of the nose on the real type, h fractions of the
// fuselage height above the keel of the constant section), checked against the reference photos in
// data/livery-refs/ELY/.
import { asset } from '../kit.ts'
import type { Design, Fill, Kit, Pt } from '../kit.ts'

const WHITE = '#f4f5f7'
const NAVY = '#262d70' // A1: the 1999 paint (violet navy)
const ROYAL = '#0848a0' // A2: the bright royal blue
const ROYAL_DOTS = '#0a4093' // A2: the band's half-tone (dark dots) towards its lower edge, seen at a distance
const ROYAL_EDGE = '#0b3781' // … at the lower edge itself
const ROYAL_LIGHT = '#2f7cc8' // A2: the fin stripes' dotted zone, a lighter cyan-blue along part of each stripe
const NEW = '#0556a6' // B: the 2025 blue
const SILVER = '#a9aeb6' // A1 ribbons (metallic: #9da1a8 in the dossier; lighter here, as 4X-EKA's reads against its white)
const CHAMPAGNE = '#c8bfb0' // A2 ribbons (metallic: #bfb6a7 in the dossier, a little lighter as in sun on 4X-ERB, 4X-EDA)
const CONE = '#2e2e2e' // 787 APU tail cone
const METAL = '#b8bcc0' // bare metal: inlet lips, winglet leading edge, 737 APU exhaust
const EXHAUST = '#6b6e73' // core nozzles
const GREY = '#d2d4d6' // Boeing light grey: wings and tailplane

type Scheme = 'A1' | 'A2' | 'B' | 'SUNDOR'
const schemeOf = (k: Kit): Scheme => (k.variant === 'A1' || k.variant === 'A2' || k.variant === 'SUNDOR' ? k.variant : 'B')

/** The dossier's frame on this model. */
interface Frame {
  is787: boolean
  X: (x: number) => number // model z of a point x metres aft of the nose on the real type
  Y: (h: number) => number // model y of a point h fuselage heights above the keel
  H: number // the fuselage height (metres)
  m: number // model metres per real metre (along the fuselage)
  Lr: number // the real type's length (the dossier's L)
}

function frame(k: Kit): Frame {
  const is787 = k.model.startsWith('b78')
  // x metres aft of the nose on the real type → the same fraction of the model's length (the dossier's and my
  // measurements are fractions of the nose-to-tail-cone length on broadside photos; the models' doors are not drawn,
  // and their windows, wing and fin sit at the same fractions within a few per cent)
  const Lr = is787 ? 62.81 : 39.47
  const zMid = k.a.nose - 0.3 * k.a.length
  const keel = k.bottom(zMid)
  const H = k.top(zMid) - keel
  return { is787, X: (x) => k.a.nose - (x / Lr) * k.a.length, Y: (h) => keel + h * H, H, m: k.a.length / Lr, Lr }
}

/** A smooth curve through [x, h] knots (Catmull-Rom on x), sampled every ~0.3 m: [x, h] points. */
function smooth(knots: Array<[number, number]>, step = 0.3): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = 0; i < knots.length - 1; i++) {
    const p0 = knots[Math.max(0, i - 1)]
    const p1 = knots[i]
    const p2 = knots[i + 1]
    const p3 = knots[Math.min(knots.length - 1, i + 2)]
    const n = Math.max(1, Math.ceil(Math.abs(p2[0] - p1[0]) / step))
    for (let j = 0; j < n; j++) {
      const t = j / n
      const t2 = t * t
      const t3 = t2 * t
      const cr = (a: number, b: number, c: number, e: number): number => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - e) * t2 + (-a + 3 * b - 3 * c + e) * t3)
      out.push([cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])])
    }
  }
  out.push(knots[knots.length - 1])
  return out
}

/** Linear interpolation of h at x along [x, h] points sorted by x. */
function hAt(pts: Array<[number, number]>, x: number): number {
  if (x <= pts[0][0]) return pts[0][1]
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, h0] = pts[i - 1]
      const [x1, h1] = pts[i]
      return h0 + ((x - x0) / (x1 - x0)) * (h1 - h0)
    }
  }
  return pts[pts.length - 1][1]
}

/**
 * The fuselage band (dossier §4.1): its top and bottom edges, [x metres aft of the nose, h], from the keel behind door 1
 * to the tip on the crown above the wing, and the ribbon's depth under it (at the keel, at the tip). The 737 table was
 * measured on 4X-EKA (the same path on B), the 787 one on the 787-9 4X-EDK by a pixel scan (the blue; the champagne
 * ribbon under it reaches the keel ≈0.02 L further aft); both as fractions of the length.
 */
function bandEdges(f: Frame): { top: Array<[number, number]>; bottom: Array<[number, number]>; ribbon: [w0: number, w1: number] } {
  const s = (e: Array<[number, number]>): Array<[number, number]> => e.map(([x, h]) => [x * f.Lr, h])
  if (!f.is787) {
    return {
      top: s([[0.186, 0], [0.212, 0.11], [0.243, 0.23], [0.264, 0.3], [0.277, 0.35], [0.309, 0.46], [0.342, 0.57], [0.38, 0.68], [0.44, 0.81], [0.505, 0.9], [0.57, 0.96], [0.687, 1.0]]),
      bottom: s([[0.264, 0], [0.277, 0.04], [0.309, 0.14], [0.342, 0.27], [0.38, 0.39], [0.44, 0.61], [0.505, 0.77], [0.57, 0.88], [0.687, 1.0]]),
      ribbon: [0.075, 0.035],
    }
  }
  return {
    top: s([[0.15, 0], [0.158, 0.08], [0.17, 0.14], [0.183, 0.2], [0.209, 0.29], [0.235, 0.38], [0.261, 0.47], [0.287, 0.54], [0.312, 0.6], [0.338, 0.67], [0.364, 0.73],
      [0.39, 0.78], [0.416, 0.82], [0.442, 0.86], [0.467, 0.9], [0.493, 0.93], [0.519, 0.96], [0.545, 0.98], [0.571, 1.0], [0.61, 1.0]]),
    bottom: s([[0.205, 0], [0.222, 0.08], [0.235, 0.12], [0.248, 0.18], [0.261, 0.22], [0.274, 0.28], [0.287, 0.32], [0.312, 0.41], [0.338, 0.49], [0.364, 0.56],
      [0.39, 0.63], [0.416, 0.69], [0.442, 0.74], [0.467, 0.79], [0.493, 0.83], [0.519, 0.87], [0.545, 0.905], [0.571, 0.95], [0.597, 0.98], [0.625, 1.0]]),
    ribbon: [0.1, 0.03],
  }
}

/** The polygon between two edges given as smooth [x, h] curves, closed below the keel where either reaches it. */
function bandPoly(f: Frame, top: Array<[number, number]>, bottom: Array<[number, number]>): Pt[] {
  const below = -0.6
  const up = top.map(([x, h]): Pt => [f.X(x), f.Y(h)])
  const down = [...bottom].reverse().map(([x, h]): Pt => [f.X(x), f.Y(h)])
  return [[f.X(top[0][0]), f.Y(below)], ...up, ...down, [f.X(bottom[0][0]), f.Y(below)]]
}

/** A straight fin-stripe edge: t down from the tip at the trailing edge, `drop` lower at the leading edge (fin heights). */
function finLine(k: Kit, t: number, drop: number): [Pt, Pt] {
  const te = k.fin(1, 1 - t)
  const le = k.fin(0, 1 - t - drop)
  const dz = te[0] - le[0]
  const dy = te[1] - le[1]
  const far = 40
  const n = Math.hypot(dz, dy)
  return [[le[0] - (dz / n) * far, le[1] - (dy / n) * far], [te[0] + (dz / n) * 6, te[1] + (dy / n) * 6]]
}

/** The fin stripe between two edges (t from the tip at the trailing edge). */
function finStripe(k: Kit, t0: number, t1: number, drop: number, color: Fill): void {
  const [a0, a1] = finLine(k, t0, drop)
  const [b0, b1] = finLine(k, t1, drop)
  k.poly([a0, a1, b1, b0], color)
}

/** The Star of David as painted on the fin: the flag's outline hexagram (two triangle rings), `h` metres tip to tip. */
function star(k: Kit, z: number, y: number, h: number, color: Fill, weight = 0.19): void {
  // tip to tip = 2 (R + s), s the ring's width (the flag: s = 0.189 R)
  const R = h / 2 / (1 + weight)
  const s = weight * R
  const tri = (r: number, a0: number, rev: boolean): Array<['M' | 'L', number, number]> => {
    const pts = [0, 1, 2].map((i): Pt => {
      const a = a0 + ((rev ? -1 : 1) * i * 2 * Math.PI) / 3
      return [z + r * Math.cos(a), y + r * Math.sin(a)]
    })
    return pts.map(([pz, py], i) => [i === 0 ? 'M' : 'L', pz, py])
  }
  for (const a0 of [Math.PI / 2, -Math.PI / 2]) k.path([...tri(R + s, a0, false), ['Z'], ...tri(R - s, a0, true), ['Z']], color)
}

/** The rear-fuselage blue of scheme B: below and aft of the boundary from the keel to the fin's leading edge. */
function rearBlue(k: Kit, f: Frame, lowerT: number, drop: number): void {
  const [zk, c, zc] = rearBoundary(k, f)
  const curve: Pt[] = []
  for (let i = 0; i <= 12; i++) {
    const t = i / 12
    const p0: Pt = [zk, f.Y(0)]
    const p2: Pt = [zc, f.Y(1.0)]
    curve.push([(1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p2[0], (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p2[1]])
  }
  const [, s1] = finLine(k, lowerT, drop)
  const le = k.fin(0, 1 - lowerT - drop)
  const bottom = f.Y(-1)
  const tailEnd = k.a.tail - 6
  k.poly([[zk + 0.8, bottom], ...curve, le, s1, [tailEnd, s1[1]], [tailEnd, bottom]], NEW)
}

/**
 * The B boundary as a quadratic from the keel (z) through a control point to the crown (z): the 737's nearly straight
 * at ≈40° from 0.71 L to the fin's root (4X-EKF, 4X-EKH: the aft door inside the blue, the dorsal fillet white), the
 * 787's concave, steepening from 0.70 L to 0.83 L, just ahead of door 4 (4X-EDN).
 */
function rearBoundary(k: Kit, f: Frame): [zKeel: number, control: Pt, zCrown: number] {
  if (!f.is787) {
    const zk = f.X(0.712 * f.Lr)
    const zc = Math.min(k.a.finRoot[1], f.X(0.835 * f.Lr))
    return [zk, [(zk + zc) / 2 - 0.15, f.Y(0.5)], zc]
  }
  const zk = f.X(0.70 * f.Lr)
  return [zk, [f.X(0.785 * f.Lr), f.Y(0.3)], k.a.finRoot[1] - 0.2]
}

/** The fin flag of scheme A (dossier §4.1 table), with the lower pair run forward along the dorsal fillet. */
function finA(k: Kit, f: Frame, s: Scheme): void {
  const blue = s === 'A1' ? NAVY : ROYAL
  const ribbon = s === 'A1' ? SILVER : CHAMPAGNE
  const drop = 0.175
  const t = f.is787
    ? { r0: 0.04, b0: 0.11, b1: 0.24, l0: 0.67, l1: 0.79, r1: 0.85 }
    : { r0: 0.05, b0: 0.11, b1: 0.265, l0: 0.63, l1: 0.76, r1: 0.82 }
  // A2: the half-tone runs along each stripe, solid at one end and a lighter dotted cyan-blue over part of it (the
  // upper stripe towards the trailing edge, the lower one in its middle: 4X-EDK, 4X-ERB, 4X-EDA)
  const along = (tMid: number, stops: Array<[number, string]>): Fill => {
    const a = k.fin(0, 1 - tMid - drop)
    const b = k.fin(1, 1 - tMid)
    return s === 'A2' ? { linear: [a[0], a[1], b[0], b[1]], stops } : blue
  }
  // the lower pair runs on forward along the dorsal fillet and tapers to a point on the crown (737: 0.775 L on 4X-EKA;
  // 787: ≈0.85 L on 4X-EDK), cut by the line from the stripe's leading-edge end down to that point
  const zPoint = f.X((f.is787 ? 0.85 : 0.775) * f.Lr)
  const [leZ, leY] = k.fin(0, 1 - t.l0 - drop)
  const aftOfPoint: Pt[] = [[zPoint, f.Y(-2)], [zPoint, k.top(zPoint) - 0.05], [leZ, leY + 0.03], [leZ - 0.4, leY + 40], [k.a.tail - 10, leY + 40], [k.a.tail - 10, f.Y(-2)]]
  k.clip('fin', () => {
    finStripe(k, t.r0, t.b0 + 0.01, drop, ribbon)
    finStripe(k, t.b0, t.b1, drop, along((t.b0 + t.b1) / 2, [[0, ROYAL], [0.45, ROYAL], [0.85, ROYAL_LIGHT], [1, ROYAL_LIGHT]]))
    k.clip(aftOfPoint, () => {
      finStripe(k, t.l0, t.l1 + 0.01, drop, along((t.l0 + t.l1) / 2, [[0, ROYAL], [0.2, ROYAL], [0.5, ROYAL_LIGHT], [0.8, ROYAL], [1, ROYAL]]))
      finStripe(k, t.l1, t.r1, drop, ribbon)
    })
  })
  // the star: A1 small (0.19 of the fin height), A2 as large as on the 787 (0.28)
  const hs = s === 'A1' ? 0.19 : 0.28
  const hc = f.is787 ? 0.52 : 0.54
  const [sz, sy] = k.fin(0.38, 1 - hc)
  star(k, sz, sy, hs * (k.a.finTip[0] - k.a.finRoot[0]), blue, s === 'A1' ? 0.16 : 0.19)
}

function finB(k: Kit, f: Frame): void {
  const drop = 0.19
  const t = f.is787 ? { b0: 0.06, b1: 0.24, hs: 0.27, hc: 0.495 } : { b0: 0.09, b1: 0.24, hs: 0.28, hc: 0.55 }
  k.clip('fin', () => finStripe(k, t.b0, t.b1, drop, NEW))
  const [sz, sy] = k.fin(0.38, 1 - t.hc)
  star(k, sz, sy, t.hs * (k.a.finTip[0] - k.a.finRoot[0]), NEW, 0.19)
}

/** The tail cone: the 737's bare-metal APU exhaust, the 787's dark cone; capped at the crown so the fin's trailing
 * edge, which overhangs the cone, keeps its paint. */
function tailCone(k: Kit, f: Frame): void {
  const z = f.is787 ? k.a.tail + 1.3 * f.m : k.a.tail + 0.35
  const hi = k.top(z) + 0.02
  k.poly([[z, f.Y(-1)], [z, hi], [k.a.tail - 3, hi], [k.a.tail - 3, f.Y(-1)]], f.is787 ? CONE : METAL)
}

export const ELY: Design = {
  code: 'ELY',
  name: 'El Al (1999 ribbons A1/A2, 2025 refresh B)',
  sources: [
    'https://commons.wikimedia.org/wiki/File:4X-EKH_Micha.jpg',
    'https://commons.wikimedia.org/wiki/File:4X-EKL_B737-800,_El_Al,_Luton_05-27-26.jpg',
    'https://commons.wikimedia.org/wiki/File:4X-EDN_Micha.jpg',
    'https://commons.wikimedia.org/wiki/File:Boeing_737-858_(c-n_29957,_4X-EKA)_2025-05-13_Andre_Gerwing_Collection_ID_023619.jpg',
    'https://commons.wikimedia.org/wiki/File:Boeing_737-958ER_(cn_41556,_4X-EHE)_2024-09-02_Andre_Gerwing_Collection_ID_021860.jpg',
    'https://commons.wikimedia.org/wiki/File:4X-EHA_Boeing_739WL_ELAL_Tail_(12325792033).jpg',
    'https://commons.wikimedia.org/wiki/File:Boeing_737-86Q_(c-n_30287,_4X-EKO)_2025-01-07_Andre_Gerwing_Collection_ID_022723.jpg',
    'https://commons.wikimedia.org/wiki/File:4X-EKU_El_Al_Israel_Boeing_737-800_24.04.2025_01.jpg',
    'https://commons.wikimedia.org/wiki/File:Boeing_787-9_Dreamliner_(55004485125).jpg',
    'https://commons.wikimedia.org/wiki/File:4X-EDA_JFK_Taxiing_Out_22R_LY_B787_9_Ashdod_Beacon_Small_(52781213803).png',
    'https://commons.wikimedia.org/wiki/File:El_Al_Boeing_787-8_4X-ERB_at_Boston_May_2025.jpg',
    'https://commons.wikimedia.org/wiki/File:ELAL2023Logo.svg',
    'https://commons.wikimedia.org/wiki/File:El_Al_logo_wordmark.svg',
    'https://commons.wikimedia.org/wiki/File:Flag_of_Israel.svg',
  ],
  base: WHITE,
  engineColor: WHITE,
  wingletColor: WHITE,
  wing: GREY,
  stab: GREY,
  // Schemes by registration, checked 2026-09-29 against the dossier's photos (planespotters' featured photo per frame and
  // dated Commons photos). The repaint into B goes on at each heavy check: re-check A1/A2 every few months.
  variants: {
    A1: ['4X-EKA', '4X-EKB', '4X-EKC', '4X-EHA', '4X-EHB', '4X-EHC', '4X-EHD', '4X-EHE', '4X-EHF', '4X-EHH', '4X-EHI'],
    // the A2 737s, every 787-9 but EDN (EDF retro and EDM "Jerusalem of Gold" drawn in their base scheme), the 787-8s
    A2: ['4X-EKK', '4X-EKO', '4X-EKT', '4X-EKU', '4X-EDA', '4X-EDB', '4X-EDC', '4X-EDD', '4X-EDE', '4X-EDF', '4X-EDH', '4X-EDI',
      '4X-EDJ', '4X-EDK', '4X-EDL', '4X-EDM', '4X-ERA', '4X-ERB', '4X-ERC', '4X-ERD'],
    B: ['4X-EKF', '4X-EKH', '4X-EKI', '4X-EKJ', '4X-EKL', '4X-EKP', '4X-EKS', '4X-EDN'],
    SUNDOR: ['4X-EKM', '4X-EKR', '4X-EKV'], // Sun d'Or paint, flying as ELY: plain white here
  },
  defaultVariant: 'B', // new deliveries and repaints get the 2025 scheme

  side(k) {
    const s = schemeOf(k)
    const f = frame(k)
    k.fill(WHITE)
    if (s === 'SUNDOR') {
      if (f.is787) tailCone(k, f)
      return
    }
    const e = bandEdges(f)
    const top = smooth(e.top)
    const bottom = smooth(e.bottom)
    const ribbonW = (x: number): number => {
      const x0 = bottom[0][0]
      const x1 = bottom[bottom.length - 1][0]
      const t = Math.min(1, Math.max(0, (x - x0) / (x1 - x0)))
      return e.ribbon[0] + (e.ribbon[1] - e.ribbon[0]) * t
    }
    if (s === 'B') {
      // the band: the same path in one blue; on the 787 it also fills the A ribbon's depth
      const lower = f.is787 ? bottom.map(([x, h]): [number, number] => [x, h - ribbonW(x)]) : bottom
      k.poly(bandPoly(f, top, lower), NEW)
      rearBlue(k, f, f.is787 ? 0.64 : 0.67, 0.19)
      finB(k, f)
      tailCone(k, f)
      // the title: the all-blue wordmark, much larger than A's; reads the same way on both sides (the flag forward on
      // the right)
      const [zFore, zAft, base, top_] = f.is787
        ? [f.X(0.126 * f.Lr), f.X(0.338 * f.Lr), f.Y(0.735), f.Y(0.9)] // 4X-EDN: past door 2
        : [f.X(0.163 * f.Lr), f.X(0.361 * f.Lr), f.Y(0.71), f.Y(0.885)] // 4X-EKF, 4X-EKH
      k.image(asset('liveries/ELY/title-B.svg'), { z: (zFore + zAft) / 2, y: (base + top_) / 2, w: zFore - zAft, h: top_ - base })
      return
    }
    // scheme A: the ribbon under the band's lower edge, then the band
    const blue = s === 'A1' ? NAVY : ROYAL
    const ribbon = s === 'A1' ? SILVER : CHAMPAGNE
    const rib = bottom.map(([x, h]): [number, number] => [x, h - ribbonW(x)])
    const ribTop = bottom.map(([x, h]): [number, number] => [x, h + 0.02])
    k.poly(bandPoly(f, ribTop, rib), ribbon)
    k.poly(bandPoly(f, top, bottom), blue)
    if (s === 'A2') {
      // the half-tone: dark dots over the lower part of the band, darkest at its lower edge (4X-ERB in sun)
      const part = (t: number): Array<[number, number]> => bottom.map(([x, h]): [number, number] => [x, h + (hAt(top, x) - h) * t])
      k.poly(bandPoly(f, part(0.4), bottom), ROYAL_DOTS)
      k.poly(bandPoly(f, part(0.15), bottom), ROYAL_EDGE)
    }
    finA(k, f, s)
    tailCone(k, f)
    const [zFore, zAft, base, top_] = f.is787
      ? [f.X(0.134 * f.Lr), f.X(0.285 * f.Lr), f.Y(0.71), f.Y(0.85)] // 4X-EDK: between doors 1 and 2
      : [f.X(0.155 * f.Lr), f.X(0.316 * f.Lr), f.Y(0.71), f.Y(0.87)] // 4X-EKA
    k.image(asset(`liveries/ELY/title-${s}.svg`), { z: (zFore + zAft) / 2, y: (base + top_) / 2, w: zFore - zAft, h: top_ - base })
  },

  engine(k) {
    const [zMin, zMax, yMin, yMax] = k.a.box
    const is787 = k.model.startsWith('b78')
    k.fill(WHITE)
    // the core nozzle and plug behind the fan cowl, the bare-metal inlet lip
    const aft = is787 ? 2.2 : 1.1
    k.poly([[zMin + aft, yMin - 1], [zMin + aft, yMax + 1], [zMin - 1, yMax + 1], [zMin - 1, yMin - 1]], EXHAUST)
    k.poly([[zMax + 1, yMin - 1], [zMax + 1, yMax + 1], [zMax - 0.18, yMax + 1], [zMax - 0.18, yMin - 1]], METAL)
  },

  winglet(k) {
    const s = schemeOf(k)
    const [zMin, zMax, yMin, yMax] = k.a.box
    k.fill(WHITE)
    const Hw = yMax - yMin
    // the leading edge: bare metal
    k.poly([[zMax + 1, yMin - 1], [zMax + 1, yMax + 1], [zMax - 0.06, yMax + 1], [zMax - 0.06, yMin - 1]], METAL)
    if (s === 'SUNDOR') return
    // the outer face: one diagonal stripe near the top, sloping down to the leading edge (A1: a silver line under it)
    const blue = s === 'A1' ? NAVY : s === 'A2' ? ROYAL : NEW
    const at = (h: number, z: number): number => yMin + Hw * h - ((z - zMin) / (zMax - zMin)) * Hw * 0.28
    const band = (h0: number, h1: number, c: Fill): void => {
      k.poly([[zMin - 1, at(h0, zMin - 1)], [zMax + 1, at(h0, zMax + 1)], [zMax + 1, at(h1, zMax + 1)], [zMin - 1, at(h1, zMin - 1)]], c)
    }
    band(0.75, 0.83, blue)
    if (s === 'A1') band(0.72, 0.75, SILVER)
    if (s === 'A2') band(0.72, 0.75, CHAMPAGNE)
  },
}

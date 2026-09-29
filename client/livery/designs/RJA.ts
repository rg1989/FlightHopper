// client/livery/designs/RJA.ts
// Royal Jordanian, the 2024 scheme (A320neo fleet JY-RAA … JY-RAQ): a dark charcoal-green aircraft, a light grey belly
// under a straight gold line that sweeps down at the nose over a red crescent and a thin green line, gold Roman and
// Arabic titles above the windows, a gold crown and two gold root lines on the fin with a red tip cap, red sharklets
// and red-lipped charcoal nacelles with a gold crown over "RJ". Dossier: .planning/liveries/RJA.md (all positions below
// are the dossier's, in metres aft of the nose and above the keel, mapped onto the model by its doors and height).
// The crowns are our own plain drawing (RJ's crown has no free file); the titles are typeset in OFL fonts.
// Scheme OW (JY-RAK, dossier §1): the same paint with "member of oneworld" titles on the forward fuselage.
import { asset } from '../kit.ts'
import type { Design, Kit, Pt, Seg } from '../kit.ts'

// The paint photographs #2a3a44 (noon) … #3a403d (evening); the renderer's lighting darkens it, so the paint colour is
// set lighter to land the lit side near the photos
const CHARCOAL = '#414b4a'
const FIN_GREY = '#4f5a5c' // the fin reads lighter and more neutral than the fuselage in every photo
const BELLY = '#e0e2de'
const RED = '#ce1126'
const GOLD = '#d2aa63'
const GREEN = '#007a3d'
const METAL = '#c9ccd0'
const WING = '#c6c9cb'
const WHITE = '#f4f4f4'
const SILL = '#8c9294'
const BELLY_LOGO = '#4a5150'
const CORE = '#707477' // the core nozzle, darker bare metal
const BRONZE = '#a48c62' // the exhaust plug

const ROMAN = "Cinzel, 'Trajan Pro', Georgia, serif"

// the dossier's frame: door 1's centre and the rear door's centre (m aft of the nose), the fuselage height
const REAL_DOOR1 = 4.93
const REAL_DOOR_AFT = 29.4
const REAL_H = 4.14

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/** The dossier's (x aft of the nose, z above the keel) on this model: X(x) → model z, Y(z) → model y. */
function frame(k: Kit): { X: (x: number) => number; Y: (z: number) => number; s: number; hs: number } {
  const d1 = k.a.door1
  const dN = k.a.doors.length > 1 ? k.a.doors[k.a.doors.length - 1] : k.a.tail + 0.22 * k.a.length
  const s = (d1 - dN) / (REAL_DOOR_AFT - REAL_DOOR1) // model metres per metre along the fuselage
  const zRef = (k.a.door1 + k.a.wingLe) / 2 // the constant section ahead of the wing
  const keel = k.bottom(zRef)
  const hs = (k.top(zRef) - keel) / REAL_H // model metres per metre in height
  return { X: (x) => d1 - (x - REAL_DOOR1) * s, Y: (z) => keel + z * hs, s, hs }
}

/** The dossier's fin (x, z) as fin coordinates (u chord, h height) of the real fin, by inverting its bilinear map. */
const FIN = { r0: [28.9, 4.04], r1: [35.4, 3.84], t0: [34.6, 9.5], t1: [36.8, 9.9] } as const
function finUH(x: number, z: number): [number, number] {
  const P = (u: number, h: number): [number, number] => [
    lerp(lerp(FIN.r0[0], FIN.r1[0], u), lerp(FIN.t0[0], FIN.t1[0], u), h),
    lerp(lerp(FIN.r0[1], FIN.r1[1], u), lerp(FIN.t0[1], FIN.t1[1], u), h),
  ]
  let [u, h] = [0.5, 0.5]
  for (let i = 0; i < 12; i++) {
    const [px, pz] = P(u, h)
    const e = 1e-4
    const [ux, uz] = P(u + e, h)
    const [hx, hz] = P(u, h + e)
    const a = (ux - px) / e, b = (hx - px) / e, c = (uz - pz) / e, d = (hz - pz) / e
    const det = a * d - b * c
    const dx = x - px, dz = z - pz
    u += (d * dx - b * dz) / det
    h += (a * dz - c * dx) / det
  }
  return [u, h]
}

/** A smooth path through points (Catmull-Rom as cubic Béziers), optionally closed by straight lines through `close`. */
function smooth(pts: Pt[], close: Pt[] = []): Seg[] {
  const d: Seg[] = [['M', pts[0][0], pts[0][1]]]
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)]
    d.push(['C', p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]])
  }
  for (const [z, y] of close) d.push(['L', z, y])
  if (close.length) d.push(['Z'])
  return d
}

/**
 * A plain heraldic crown (our own drawing, not RJ's artwork): four arches round a pointed centre leaf with a finial,
 * a circlet with ball points and lozenge and dot cut-outs, and a base bar. Centred at (cz, cy), w wide, upright in
 * the side view, or with its top towards the nose (`along`, for the belly, where z is along and y across).
 */
function crown(k: Kit, cz: number, cy: number, w: number, color: string, cut: string, along = false): void {
  const hgt = w * 0.78
  // unit coordinates: u −0.5 … 0.5 across, v 0 (base) … 1 (finial tip)
  const T = (u: number, v: number): Pt => (along ? [cz + (v - 0.5) * hgt, cy + u * w] : [cz + u * w, cy + (v - 0.5) * hgt])
  const poly = (pts: Array<[number, number]>, c: string): void => void k.poly(pts.map(([u, v]) => T(u, v)), c)
  const dot = (u: number, v: number, r: number, c: string): void => {
    const [z, y] = T(u, v)
    k.circle(z, y, r * w, c)
  }
  /** An arch: a cubic (4 points) stroked `width` wide. */
  const arch = (a: Array<[number, number]>, width: number): void => {
    const [a0, a1, a2, a3] = a.map(([u, v]) => T(u, v))
    k.stroke([['M', a0[0], a0[1]], ['C', a1[0], a1[1], a2[0], a2[1], a3[0], a3[1]]], width * w, color)
  }
  // the base bar, and the circlet (wider at the top) with its scalloped, ball-tipped top edge
  poly([[-0.31, 0], [0.31, 0], [0.31, 0.06], [-0.31, 0.06]], color)
  poly([[-0.33, 0.085], [0.33, 0.085], [0.37, 0.235], [-0.37, 0.235]], color)
  for (const u of [-0.3, -0.15, 0, 0.15, 0.3]) {
    poly([[u - 0.07, 0.23], [u + 0.07, 0.23], [u, 0.28]], color)
    dot(u, 0.29, 0.03, color)
  }
  for (const m of [-1, 1]) {
    // four round arches over the circlet: the outer ones lower and flaring outwards, the inner ones higher and meeting
    // over the centre leaf, so the outline is domed
    arch([[m * 0.45, 0.36], [m * 0.62, 0.8], [m * 0.3, 0.86], [m * 0.2, 0.55]], 0.11)
    arch([[m * 0.2, 0.45], [m * 0.21, 0.96], [m * 0.01, 0.96], [0, 0.56]], 0.095)
  }
  // the centre leaf (pointed at the bottom) and the arrow finial
  poly([[0, 0.45], [0.05, 0.6], [0.035, 0.76], [0, 0.82], [-0.035, 0.76], [-0.05, 0.6]], color)
  poly([[-0.018, 0.78], [0.018, 0.78], [0.018, 0.9], [-0.018, 0.9]], color)
  poly([[0, 1], [0.055, 0.9], [0.02, 0.9], [0, 0.86], [-0.02, 0.9], [-0.055, 0.9]], color)
  // the circlet's cut-outs: three long lozenges with two dots between them
  for (const u of [-0.2, 0, 0.2]) poly([[u - 0.065, 0.16], [u, 0.185], [u + 0.065, 0.16], [u, 0.135]], cut)
  for (const u of [-0.1, 0.1]) dot(u, 0.16, 0.018, cut)
}

/** A rounded rectangle outline (door surrounds), centred at (cz, cy), w × h, line lw wide. */
function doorOutline(k: Kit, cz: number, cy: number, w: number, h: number, lw: number, color: string): void {
  const r = Math.min(0.18, w / 3)
  const [z0, z1, y0, y1] = [cz - w / 2, cz + w / 2, cy - h / 2, cy + h / 2]
  k.stroke([['M', z0 + r, y0], ['L', z1 - r, y0], ['Q', z1, y0, z1, y0 + r], ['L', z1, y1 - r], ['Q', z1, y1, z1 - r, y1],
    ['L', z0 + r, y1], ['Q', z0, y1, z0, y1 - r], ['L', z0, y0 + r], ['Q', z0, y0, z0 + r, y0], ['Z']], lw, color)
}

/**
 * A plain Roman "RJ" drawn with strokes (for the belly, where the kit's text cannot turn): letters C high, their tops
 * towards the nose (+z), reading towards the left wing (+y) as seen from below; centred at (cz, cy).
 */
function rjAlong(k: Kit, cz: number, cy: number, c: number, color: string): void {
  const T = (a: number, b: number): [number, number] => [cz + (b - 0.5) * c, cy + (a - 0.6) * c]
  const line = (pts: Array<[number, number]>, w: number): void => void k.stroke(pts.map(([a, b]) => T(a, b)), w * c, color)
  const bez = (p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number], w: number): void => {
    const [a, b, d, e] = [T(...p0), T(...p1), T(...p2), T(...p3)]
    k.stroke([['M', a[0], a[1]], ['C', b[0], b[1], d[0], d[1], e[0], e[1]]], w * c, color)
  }
  // R: stem, bowl, leg, serifs
  line([[0.08, 0], [0.08, 1]], 0.13)
  line([[0.0, 1], [0.34, 1]], 0.07)
  bez([0.3, 1], [0.66, 1], [0.66, 0.5], [0.3, 0.5], 0.1)
  line([[0.08, 0.5], [0.32, 0.5]], 0.08)
  line([[0.28, 0.5], [0.62, 0.0]], 0.11)
  line([[-0.02, 0], [0.2, 0]], 0.06)
  // J: stem descending into a hook, top serif
  line([[0.94, 1], [0.94, 0.05]], 0.12)
  bez([0.94, 0.05], [0.94, -0.28], [0.72, -0.3], [0.64, -0.14], 0.1)
  line([[0.83, 1], [1.07, 1]], 0.06)
}

export const RJA: Design = {
  code: 'RJA',
  name: 'Royal Jordanian (2024 scheme)',
  sources: [
    'https://commons.wikimedia.org/wiki/File:Airbus_A320-271N_(c-n_12292,_JY-RAA)_2025-09-29_Andre_Gerwing_Collection_ID_025794.jpg',
    'https://commons.wikimedia.org/wiki/File:JY-RAN_STN_210226.jpg',
    'https://commons.wikimedia.org/wiki/File:JY-RAJ_AIRCRAFT_Airbus_A320-271N_(1a).jpg',
    'https://commons.wikimedia.org/wiki/File:JY-RAB_A320neo_Royal_Jordanian_ARN_01.jpg',
    'https://commons.wikimedia.org/wiki/File:JY-RAC_STN_140825.jpg',
    'https://commons.wikimedia.org/wiki/File:Airbus_A320-271N_(c-n_12523,_JY-RAH)_2025-09-24_Andre_Gerwing_Collection_ID_025617.jpg',
    '.planning/liveries/RJA.md',
  ],
  base: CHARCOAL,
  engineColor: CHARCOAL,
  wing: WING,
  stab: WING,
  fonts: [{ family: 'Cinzel', src: asset('fonts/Cinzel-wght.ttf'), weight: '400 900' }],
  // JY-RAK wears "member of oneworld" titles (dossier §1; checked 2026-09-29 on photos of 2026-01 and 2026-02). Every
  // other A320neo (JY-RAA … JY-RAQ) wears the standard titles.
  variants: { OW: ['JY-RAK'] },
  defaultVariant: 'STD',

  side(k) {
    const { X, Y, s, hs } = frame(k)
    const P = (x: number, z: number): Pt => [X(x), Y(z)]
    const far = k.a.tail - 2 // past the tail
    const deep = Y(-1.5) // below the keel

    k.fill(CHARCOAL)

    // the gold line's centre: straight at 1.06 m, sweeping down forward of 7.6 m to meet the nose's underside at ~3 m
    const gold: Pt[] = [P(8.6, 1.06), P(7.6, 1.06), P(6.8, 1.05), P(5.7, 0.99), P(5.1, 0.91), P(4.6, 0.8), P(4.0, 0.66), P(3.6, 0.55), P(3.1, 0.33), P(2.7, 0.02), P(2.3, -0.5)]
    // the light grey belly under it (the aft underside rises through the line ~1 m aft of the rear door: charcoal aft)
    k.path(smooth(gold, [[X(2.0), deep], [far, deep], [far, Y(1.06)]]), BELLY)
    // the red crescent: under the gold curve, down to its own lower edge; forward of 4.6 m it fills to the underside
    const redLow: Pt[] = [P(8.4, 1.04), P(8.0, 0.99), P(7.6, 0.94), P(7.2, 0.89), P(6.8, 0.83), P(6.4, 0.76), P(6.0, 0.67), P(5.6, 0.57), P(5.2, 0.44), P(4.8, 0.33), P(4.55, 0.1), P(4.3, -0.5)]
    const redTop = gold.slice(1)
    k.path(smooth([P(8.5, 1.06), ...redTop], redLow.slice().reverse()), RED)
    // the thin green line below the red, a widening grey gap between them
    k.stroke(smooth([P(8.3, 1.02), P(7.4, 0.88), P(7.0, 0.8), P(6.4, 0.65), P(6.0, 0.55), P(5.6, 0.4), P(5.4, 0.33), P(4.9, 0.05), P(4.6, -0.4)]), 0.05 * hs, GREEN)
    // the gold line over all: straight from past the tail to 8.6 m, then the sweep
    k.stroke(smooth([[far, Y(1.06)], ...gold]), 0.11 * hs, GOLD)

    // the black mask round the cockpit windows (x 1.7 … 3.2 m, z 2.35 … 3.05 m, the top sloping down to the windscreen)
    const ck = k.a.cockpit
    k.path(smooth([[ck + 0.05, Y(2.33)], [ck + 0.05, Y(3.07)], [X(2.3), Y(3.08)], [X(1.75), Y(2.8)], [X(1.6), Y(2.5)]], [[X(1.7), Y(2.4)]]), '#141719')

    // doors and over-wing exits: thin white surrounds; light grey sill plates under the passenger doors
    const doorY = Y(2.66)
    for (const z of k.a.doors) {
      doorOutline(k, z, doorY, 1.06 * s, 1.96 * hs, 0.05, WHITE)
      const sill = Y(1.68) - 0.04
      k.poly([[z + 0.62 * s, sill], [z - 0.62 * s, sill], [z - 0.52 * s, sill - 0.2], [z + 0.52 * s, sill - 0.2]], SILL)
    }
    for (const x of [14.25, 15.05]) doorOutline(k, X(x), Y(2.55), 0.6 * s, 1.08 * hs, 0.045, WHITE)

    // The Arabic title (Aref Ruqaa outlines: public/liveries/RJA/sources.json) is 9455 units wide; its baseline lies
    // 323 units below the image's centre. titleAr(x0, x1, baseline) sets it over x0 … x1 m.
    const titleAr = (x0: number, x1: number, base: number): void => {
      const w = (x1 - x0) * s
      k.image(asset('liveries/RJA/title-ar.svg'), { z: X((x0 + x1) / 2), y: Y(base) + (323 / 9455) * w, w })
    }
    // the calligraphic "Alia" (a compact typeset block standing in for RJ's monogram), centred at x, z; h m tall
    const emblem = (x: number, z: number, h: number): void => void k.image(asset('liveries/RJA/emblem.svg'), { z: X(x), y: Y(z), h: h * hs })
    if (k.variant === 'OW') {
      // JY-RAK (dossier §1, measured on commons/JY-RAK_gerwing027832.jpg): a shaded oneworld roundel ahead of door 1 on
      // both sides; the light grey "oneworld" wordmark across the window line, x 6.1 … 14.2 m, its x-height band
      // (≈0.95 m) centred just below the windows; a small "member of" over "one"; the gold title moved below the windows
      // (English on the left, Arabic on the right). No title above the windows, none aft of the exits, and no small
      // roundel aft of door 1.
      k.image(asset('liveries/RJA/oneworld-roundel.svg'), { z: X(4.15), y: Y(2.83), w: 0.86 * s })
      const [wm0, wm1] = [6.12, 14.2] // the wordmark: "one" at the fore end on the left side, at the aft end on the right
      k.image(asset('liveries/RJA/oneworld-wordmark.svg'), { z: X((wm0 + wm1) / 2), y: Y(2.08), w: ((wm1 - wm0) * 31.608) / 31.408 * s }) // baseline at the centre
      const mo = 2.27 // "member of": 0.30 m ascenders, its baseline on top of "one"
      k.image(asset('liveries/RJA/member-of.svg'), { z: X(k.side === 'left' ? wm0 + mo / 2 : wm1 - mo / 2), y: Y(3.09), w: mo * s })
      emblem(6.36, 1.67, 0.55)
      if (k.side === 'left') k.text('ROYAL JORDANIAN', { z: X(6.74), y: Y(1.42), capM: 0.32 * hs, color: GOLD, font: ROMAN, weight: 600, align: 'fore', tracking: -0.03 })
      else titleAr(6.74, 10.34, 1.45)
    } else {
      // titles, gold, above the windows, in the same place on both sides (English forward, Arabic aft)
      k.text('ROYAL JORDANIAN', { z: X(6.8), y: Y(3.03), capM: 0.46 * hs, color: GOLD, font: ROMAN, weight: 600, align: 'fore', tracking: 0.03 })
      // the Arabic title: x 15.5 … 20.1 m, its risers up to the English cap line, its baseline ≈3.15 m
      titleAr(15.55, 20.1, 3.15)
      // the calligraphic "Alia" beside door 1, clear of the door: x ≈5.8 … 6.25 m, z ≈3.05 … 3.55 m
      emblem(6.05, 3.3, 0.52)
      // the small oneworld roundel aft of door 1: left side only
      if (k.side === 'left') k.circle(X(5.8), Y(2.67), 0.15, { radial: [X(5.8) + 0.04, Y(2.67) + 0.05, 0.17], stops: [[0, '#8a90dc'], [1, '#2c2a86']] })
    }
    // the Jordanian flag ahead of the registration, its hoist forward on both sides
    k.image(asset('liveries/RJA/flag.svg'), { z: X(27.25), y: Y(3.25), w: 0.7 * s, mirror: true })

    // the APU exhaust at the tail cone's tip: bare metal
    k.poly([[X(37.2), Y(-1)], [far, Y(-1)], [far, Y(6)], [X(37.2), Y(6)]], METAL)

    // the fin: two gold root lines fanning out to the trailing edge, the crown, the red tip cap
    const F = (x: number, z: number): Pt => {
      const [u, h] = finUH(x, z)
      return k.fin(u, h)
    }
    k.finFill(FIN_GREY, { down: 0 })
    k.stroke(smooth([F(28.6, 4.03), F(31.0, 4.07), F(33.0, 4.33), F(34.2, 4.63), F(35.4, 5.02), F(36.2, 5.3)]), 0.07, GOLD)
    k.stroke(smooth([F(28.6, 4.03), F(30.6, 3.99), F(31.4, 3.97), F(33.0, 4.03), F(35.4, 4.36), F(36.2, 4.5)]), 0.07, GOLD)
    const [cu, ch] = finUH(34.46, 7.34)
    const [cz, cy] = k.fin(cu, ch)
    const chordReal = lerp(FIN.r1[0] - FIN.r0[0], FIN.t1[0] - FIN.t0[0], ch)
    const chordModel = k.fin(1, ch)[0] - k.fin(0, ch)[0]
    const heightReal = lerp(FIN.t0[1] - FIN.r0[1], FIN.t1[1] - FIN.r1[1], 0.5)
    const heightModel = k.a.finTip[0] - k.a.finRoot[0]
    const finScale = Math.sqrt(Math.abs(chordModel / chordReal) * (heightModel / heightReal))
    crown(k, cz, cy, 1.84 * finScale, GOLD, FIN_GREY)
    const depth: Array<[number, number]> = [[0, 0.45], [0.1, 0.36], [0.27, 0.27], [0.36, 0.21], [0.55, 0.09], [0.68, 0]]
    const tipY = (u: number): number => k.fin(u, 1)[1]
    const cap: Pt[] = depth.map(([u, d]) => [k.fin(u, 1)[0], tipY(u) - d])
    k.path(smooth(cap, [[k.fin(0.75, 1)[0], tipY(0) + 1], [k.fin(-0.4, 1)[0], tipY(0) + 1], [k.fin(-0.4, 1)[0], tipY(0) - 0.45]]), RED)
  },

  engine(k) {
    // [zMin, zMax, yMin, yMax]: the nacelle and its pylon, the inlet at zMax
    const [z0, z1, y0, y1] = k.a.box
    const top = y0 + 2.45 // the nacelle's crown (PW1100G nacelle ~2.45 m); the pylon above
    const cyN = (y0 + top) / 2
    const cowl = z1 - 3.68 // the fan cowl and reverser end ~3.7 m aft of the lip (RAA; the a20n cowl ends there too)
    k.fill(CHARCOAL)
    k.poly([[cowl, top + 0.02], [z0 - 1, top + 0.02], [z0 - 1, y1 + 1], [cowl, y1 + 1]], WING) // the pylon over the cowl's end
    // aft of the cowl: the core nozzle round the axis, the small bronze plug cone on it, and above them the pylon's light
    // grey aft fairing
    k.poly([[cowl, y0 - 1], [z0 - 1, y0 - 1], [z0 - 1, y1 + 1], [cowl, y1 + 1]], CORE)
    k.poly([[cowl, cyN + 0.5], [z0 - 1, cyN + 0.5], [z0 - 1, y1 + 1], [cowl, y1 + 1]], WING)
    k.poly([[cowl - 0.65, cyN - 0.4], [z0 - 1, cyN - 0.4], [z0 - 1, cyN + 0.4], [cowl - 0.65, cyN + 0.4]], BRONZE)
    // the inlet: a bare-metal lip ring ~0.15 m wide seen from the side, silver round its inward curl too, then the red band
    k.poly([[z1 - 0.22, y0 - 1], [z1 + 1, y0 - 1], [z1 + 1, y1 + 1], [z1 - 0.22, y1 + 1]], METAL)
    k.poly([[z1 - 0.5, y0 - 1], [z1 - 0.22, y0 - 1], [z1 - 0.22, top + 0.05], [z1 - 0.5, top + 0.05]], RED)
    // the gold crown over "RJ", ~0.9 m aft of the red band, at mid-height
    const lz = z1 - 0.5 - 0.9
    crown(k, lz, cyN + 0.26, 0.62, GOLD, CHARCOAL)
    k.text('RJ', { z: lz, y: cyN - 0.42, capM: 0.4, color: GOLD, font: ROMAN, weight: 500, align: 'centre' })
  },

  belly(k) {
    // the belly logo under the wing box: the crown towards the nose, then "RJ", darker than the grey belly
    const { X } = frame(k)
    crown(k, X(14.1), 0, 2.2, BELLY_LOGO, BELLY, true)
    rjAlong(k, X(16.3), 0, 1.7, BELLY_LOGO)
  },

  winglet(k) {
    // [zMin, zMax, yMin, yMax]: the sharklet's side box (root at yMin, leading edge towards zMax)
    const [z0, z1, y0, y1] = k.a.box
    const hgt = y1 - y0
    const H = (f: number): number => y0 + f * hgt
    // the blade's leading and trailing edges from its root (t 0) to its tip (t 1): horizontal sections of the a20n mesh
    // (the leading edge -1.55 at the root … -3.32 at 90 %; the trailing edge -2.73 … -3.82, box z -3.93 … -1.61)
    const le = (t: number): number => lerp(z1 + 0.05, z0 + 0.4, t)
    const te = (t: number): number => lerp(z0 + 1.19, z0, t)
    k.fill(RED)
    k.poly([[z1 + 1, y0 - 1], [z0 - 1, y0 - 1], [z0 - 1, H(0.02)], [z1 + 1, H(0.02)]], WING) // the grey root blend
    k.poly([[z1 + 1, H(0.08)], [z0 - 1, H(0.08)], [z0 - 1, H(0.22)], [z1 + 1, H(0.22)]], CHARCOAL) // charcoal band
    // the light leading-edge strip, ~38 % of the chord (RAA, RAJ, RAB), up to 95 % of the height: the red wraps over the
    // tip ahead of it
    const ts = [-0.2, 0, 0.25, 0.5, 0.75, 0.95]
    k.poly([...ts.map((t): Pt => [le(t) + 1, H(t)]), ...ts.slice().reverse().map((t): Pt => [le(t) - 0.38 * (le(t) - te(t)), H(t)])], METAL)
  },
}

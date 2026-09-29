// client/livery/designs/ISR.ts
// Israir, the 2010 scheme (unchanged since; every own A320-232, 4X-AB*): a white fuselage with the bilingual title
// lock-up "ישראייר ★ ISRAIR" forward, an azure keel band, and a rear built from overlapping azure, sky and navy
// fields that run up into a navy fin with the orange Israir star and a sky top-aft corner; navy engines. Measured from
// the photos in the dossier (.planning/liveries/ISR.md): positions are d metres aft of the nose on the real A320
// (37.57 m), scaled to the model, and f fractions of the local fuselage height; fin art is placed in fin (u, h).
import { asset } from '../kit.ts'
import type { Design, Kit, Pt, Seg } from '../kit.ts'

const WHITE = '#f4f5f7'
const NAVY = '#102a78' // the photo mean (ABG, ABW22, ABT, SZG, checker: #102777)
const AZURE = '#4c92e0'
const SKY = '#8cb2ee' // ABG's periwinkle, white-balanced (#90ADE3), a little less cyan than the sunlit reads
const WING = '#bdbfbf'
const STAB = '#c8caca'
const METAL = '#b5b9bd' // the inlet lip and the V2500's common nozzle
const NOZZLE = '#8c9094' // the exhaust aft of it

const A320 = 37.57 // the real length the d values are measured on

/** The z of a point d metres aft of the nose of a real A320, scaled to this model's length. */
const zOf = (k: Kit, d: number): number => k.a.nose - (d * (k.a.nose - k.a.box[0] - 0.1)) / A320
/** The d of a z (inverse of zOf). */
const dOf = (k: Kit, z: number): number => ((k.a.nose - z) * A320) / (k.a.nose - k.a.box[0] - 0.1)
/** A point d metres aft of the nose at fraction f of the local fuselage height. */
const P = (k: Kit, d: number, f: number): Pt => {
  const z = zOf(k, d)
  return [z, k.at(z, f)]
}
const Ps = (k: Kit, df: Array<[d: number, f: number]>): Pt[] => df.map(([d, f]) => P(k, d, f))

/** Smooth cubic segments through the points (Catmull-Rom), from the first (already reached) to the last. */
function through(pts: Pt[]): Seg[] {
  const out: Seg[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const [p0, p1, p2, p3] = [pts[Math.max(0, i - 1)], pts[i], pts[i + 1], pts[Math.min(pts.length - 1, i + 2)]]
    out.push(['C', p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]])
  }
  return out
}
const M = (p: Pt): Seg => ['M', p[0], p[1]]
const L = (p: Pt): Seg => ['L', p[0], p[1]]

/** A smooth step between knots [d, f] (flat at each knot), for the keel band's top edge. */
function knots(ks: Array<[number, number]>): (d: number) => number {
  return (d) => {
    if (d <= ks[0][0]) return ks[0][1]
    for (let i = 1; i < ks.length; i++) {
      const [d0, f0] = ks[i - 1]
      const [d1, f1] = ks[i]
      if (d <= d1) {
        const t = (d - d0) / (d1 - d0)
        return f0 + (f1 - f0) * t * t * (3 - 2 * t)
      }
    }
    return ks[ks.length - 1][1]
  }
}

// The keel band's top edge in side elevation, from the nose-gear bay aft. The dossier measures f 0.05-0.09 forward
// (ABG); on this model's faceted keel that sits on faces that look almost straight down, so forward and aft of the
// fairing it is raised to f 0.10 to show the 0.3-0.4 m blue underline of the near-level photos (ABG-2025-04-04, SZG2).
// On the fairing the belly panel (belly()) paints the faces that look down, and the band stays at the measured 0.12.
// Seen from below, the belly panel covers the band's edge with straight ones.
const KEEL = knots([[5.4, -0.08], [6.0, 0], [7.5, 0.1], [13.0, 0.1], [14.0, 0.12], [21.0, 0.12], [23.0, 0.1], [27.0, 0.1], [28.2, 0.13], [29.1, 0.16], [30.0, 0.16]])
// The belly panel's half-width in plan view (belly()), as a fraction of the local half-height of the fuselage.
const BELLY = knots([[6.0, 0.58], [13.0, 0.6], [14.2, 0.86], [19.5, 0.84], [21.3, 0.7], [23.0, 0.5], [27.0, 0.48], [28.2, 0.6], [29.1, 0.75]])

// The aft edge of the white (boundary 1), crown → the keel band.
const WHITE_EDGE: Array<[number, number]> = [[24.9, 1.0], [25.8, 0.87], [26.7, 0.75], [27.7, 0.62], [28.05, 0.5], [28.5, 0.35], [28.95, 0.18], [29.1, 0.16]]
// The azure crescent's aft edge, crown → its tip on the window line.
const CRESCENT_AFT: Array<[number, number]> = [[27.1, 1.0], [27.35, 0.85], [27.5, 0.72], [27.7, 0.62]]
// The sky disc's lower edge (above the navy wedge), from the crescent tip aft to the azure triangle.
const DISC_LOW: Array<[number, number]> = [[27.7, 0.62], [28.4, 0.43], [28.95, 0.31], [29.6, 0.26], [30.15, 0.24]]
// The disc's aft arc, from the triangle's upper-aft corner up to the crown.
const DISC_ARC: Array<[number, number]> = [[31.1, 0.3], [31.2, 0.39], [31.45, 0.53], [31.65, 0.68], [31.8, 0.85], [31.85, 1.0]]
// The tail-cone line (the navy's aft edge), from the triangle's upper-aft corner up, just ahead of the tailplane's
// root, and aft to the fin's trailing edge where it meets the crown (dTe: d 35.0-35.5 on the aircraft).
const coneLine = (dTe: number): Array<[number, number]> => [[31.1, 0.3], [31.3, 0.33], [31.7, 0.42], [32.2, 0.63], [32.2 + 0.55 * (dTe - 32.2), 0.8], [dTe - 0.15, 0.97]]
// The white tail cone's lower edge over the navy keel strip, from the triangle's lower-aft corner to the keel.
const CONE_LOW: Array<[number, number]> = [[30.8, 0.16], [31.3, 0.1], [31.8, 0.02], [31.9, 0.0]]

function side(k: Kit): void {
  k.fill(WHITE)

  // the azure keel band, from just aft of the nose gear into the navy under the tail
  k.below((z) => KEEL(dOf(k, z)), AZURE, { from: zOf(k, 5.4), to: zOf(k, 30.0) })

  // navy: everything aft of the white's edge (the fin and the tail cone too; the fields below are painted over it)
  const crownHigh = (d: number): Pt => [zOf(k, d), k.top(zOf(k, d)) + 1.2]
  const far = k.a.tail - 3
  k.path([
    M([zOf(k, 24.9), k.a.finTip[0] + 3]), L(P(k, 24.9, 1.0)), ...through(Ps(k, WHITE_EDGE)),
    L(P(k, 29.7, 0)), L(P(k, 29.75, -0.6)), L([far, k.bottom(k.a.tail) - 3]), L([far, k.a.finTip[0] + 3]), ['Z'],
  ], NAVY)

  // the azure crescent: between the white's edge and a near-straight aft edge, tip on the window line
  k.path([M(crownHigh(24.9)), L(P(k, 24.9, 1.0)), ...through(Ps(k, WHITE_EDGE.slice(0, 4))), ...through(Ps(k, [...CRESCENT_AFT].reverse())), L(crownHigh(27.1)), ['Z']], AZURE)

  // the sky disc around door 4, running up into the fin's leading-edge root (fin h 0.265)
  const finArc: Pt[] = [k.fin(0.3, 0.04), k.fin(0.25, 0.1), k.fin(0.19, 0.16), k.fin(0.12, 0.215), k.fin(0.05, 0.25), k.fin(0, 0.265)]
  k.path([
    M(crownHigh(27.1)), L(P(k, 27.1, 1.0)), ...through(Ps(k, CRESCENT_AFT)), ...through(Ps(k, DISC_LOW)), L(P(k, 31.1, 0.3)),
    ...through([...Ps(k, DISC_ARC), ...finArc]), L(k.fin(-0.6, 0.265)), L(crownHigh(29)), ['Z'],
  ], SKY)

  // the azure triangle at the disc's aft-lower corner, aft of the door-4 sill
  k.poly(Ps(k, [[30.15, 0.24], [31.1, 0.3], [30.8, 0.16]]), AZURE)

  // door 4's white frame on the sky, its sill on the disc's lower edge (at the published door station, where the
  // fields around it are measured). The a320 mesh's own door-4 panel lines are 0.46 m forward of that station (z -10.96
  // … -9.95, y -3.39 … -1.37); the fields cannot follow it (its forward edge would reach the white's edge), so the frame
  // stays with the fields and is kept thin (0.05 m, ABG 0.07-0.09) so the mesh's faint outline beside it reads less
  if (k.a.doors.length >= 2) {
    const zd = k.a.doors[k.a.doors.length - 1]
    const [top, bot, hw, r] = [k.at(zd, 0.87), k.at(zd, 0.31), 0.44, 0.12] // the frame's centre line; about 0.93 × 1.9 m outside
    k.stroke([['M', zd + hw - r, top], ['Q', zd + hw, top, zd + hw, top - r], ['L', zd + hw, bot + r], ['Q', zd + hw, bot, zd + hw - r, bot], ['L', zd - hw + r, bot],
      ['Q', zd - hw, bot, zd - hw, bot + r], ['L', zd - hw, top - r], ['Q', zd - hw, top, zd - hw + r, top], ['Z']], 0.05, WHITE)
  }

  // the white tail cone aft of the tail-cone line, with the small patch under the fin's trailing-edge root
  const teRoot: Pt = [k.a.finRoot[2], k.top(k.a.finRoot[2]) + 0.25]
  k.path([
    M(P(k, 31.1, 0.3)), L(P(k, 30.8, 0.16)), ...through(Ps(k, CONE_LOW)), L(P(k, 32.0, -0.6)), L([far, k.bottom(k.a.tail) - 3]),
    L([far, k.a.finTip[0] + 3]), L(k.fin(1.04, 1.3)), L(teRoot),
    ...through([teRoot, ...Ps(k, coneLine(dOf(k, k.a.finRoot[2])).reverse())]),
    ['Z'],
  ], WHITE)

  // the fin's top-aft corner in sky: a broad lens from the tip near the leading edge, bowing towards the corner, to the
  // trailing edge at h 0.71 (ABG, ABW22)
  k.path([M(k.fin(0.05, 1.4)), L(k.fin(0.05, 1.0)), ...through([k.fin(0.05, 1.0), k.fin(0.4, 0.92), k.fin(0.6, 0.84), k.fin(1.0, 0.71)]), L(k.fin(1.5, 0.71)), L(k.fin(1.5, 1.4)), ['Z']], SKY)

  // the Israir star on the fin: upright, the same on both sides (reads correctly), in the logo's own aspect. On the
  // aircraft (ABG) it is 4.2 × 3.7 m, its top tip at fin h 0.74 and the bottom one at h 0.05, the arms reaching the
  // leading and trailing edges. This model's leading edge is more swept, so the arms that reach past the edges are cut
  // by the fin's outline rather than the star shrunk: centred so the fore-upper and aft-lower arms overhang alike
  const finH = k.a.finTip[0] - k.a.finRoot[0]
  const [sz, sy] = k.fin(0.589, 0.385)
  k.clip('fin', () => k.image(asset('liveries/ISR/star.svg'), { z: sz, y: sy, h: 0.65 * finH }))

  // the titles: "ישראייר ★ ISRAIR" as one lock-up, d 6.0 … 14.3, the baseline 0.46 m above the window row (f 0.76 on
  // the aircraft); the kit reads it correctly on the right side too, so the Hebrew is forward on the left and ISRAIR
  // forward on the right, as on the aircraft
  const [zf, za] = [zOf(k, 6.0), zOf(k, 14.3)]
  const base = k.a.windowY + 0.46
  // title.svg is the lock-up in side elevation, 1 unit = 1 cm: 8.3 × 0.97 m, its baseline 0.67 m below its top
  k.image(asset('liveries/ISR/title.svg'), { z: (zf + za) / 2, y: base + 0.67 - 0.97 / 2, w: zf - za, h: 0.97 })
}

export const ISR: Design = {
  code: 'ISR',
  name: 'Israir (2010 scheme)',
  sources: [
    'https://commons.wikimedia.org/wiki/File:Airbus_A320-232_(c-n_4413,_4X-ABG)_2025-04-04_Andre_Gerwing_Collection_ID_023336.jpg',
    'https://commons.wikimedia.org/wiki/File:Berlin_Brandenburg_Airport_Israir_Airbus_A320-232_4X-ABT_(DSC06434).jpg',
    'https://commons.wikimedia.org/wiki/File:Airbus_A320-232_(cn_4354,_4X-ABF)_2024-07-14_Andre_Gerwing_Collection_ID_021134.jpg',
    'https://commons.wikimedia.org/wiki/File:4X-ABW_Micha.jpg',
    'https://commons.wikimedia.org/wiki/File:Salzburg_-_Maxglan_-_Flughafen_-_4X-ABX_(Israir)_-_2026_07_15-2.jpg',
    'https://commons.wikimedia.org/wiki/File:147528_israir_takes_off_from_ben_gurion_airport_PikiWiki_Israel.jpg',
    'https://commons.wikimedia.org/wiki/File:Airbus_A320-232_(cn_7110,_4X-ABI)_2024-04-16_Andre_Gerwing_Collection_ID_019833.jpg',
    'https://commons.wikimedia.org/wiki/File:Israir_Airlines_Logo.svg',
  ],
  base: WHITE,
  wing: WING,
  stab: STAB,
  engineColor: NAVY,
  side,
  belly(k) {
    // the azure belly panel in plan view (ABI-2025-08-18-belly-piki), with clean edges: a rounded front just aft of the
    // nose-gear bay (d 6.0), about half the fuselage's width forward of the wing, the whole underside of the
    // wing-to-body fairing, narrower again aft of it, then widening with the side band's rise into the navy, which it
    // meets on the keel at d 29.7. The half-width is a fraction of the local half-height; it lies just outside the side
    // band's top edge (KEEL) on this model, so the side band's own edge never shows from below
    const [d0, d1, nose, end] = [6.0, 29.75, 1.2, 0.65]
    const hw = (d: number): number => {
      const z = zOf(k, d)
      const round = d < d0 + nose ? Math.sqrt(Math.max(0, 1 - ((d0 + nose - d) / nose) ** 2)) : d > d1 - end ? Math.sqrt(Math.max(0, 1 - ((d - d1 + end) / end) ** 2)) : 1
      return BELLY(d) * round * (k.top(z) - k.bottom(z)) / 2
    }
    const ds = Array.from({ length: Math.round((d1 - d0) / 0.1) + 1 }, (_, i) => d0 + i * 0.1)
    k.poly([...ds.map((d): Pt => [zOf(k, d), hw(d)]), ...ds.reverse().map((d): Pt => [zOf(k, d), -hw(d)])], AZURE)
  },
  engine(k) {
    // the V2500 nacelle: navy cowls right up to the pylon (ABW22 from above, ABG, ABF), a bare-metal inlet lip and
    // common nozzle, the dark exhaust aft of it, the pylon over the exhaust in wing grey. The a320 model's nacelle box is
    // 4.8 m: the cowl the fore 73 % (its crown at y -3.93 … -4.0, 0.1 m under the old pylon band, so that band never
    // reached it), the exhaust cone aft of it. The cowl's crown still shows wing grey from above: the paint shader
    // (client/scene/livery.ts, engineTest) leaves nacelle faces with |n.y| >= 0.8 out of the engine region, and they
    // take the wing colour; only a shader change can paint them navy
    const [zMin, zMax, yMin, yMax] = k.a.box
    const cowlAft = zMin + 0.27 * (zMax - zMin)
    k.fill(NAVY)
    k.poly([[zMax + 1, yMin - 1], [zMax - 0.2, yMin - 1], [zMax - 0.2, yMax + 1], [zMax + 1, yMax + 1]], METAL)
    k.poly([[cowlAft + 0.8, yMin - 1], [zMin - 1, yMin - 1], [zMin - 1, yMax + 1], [cowlAft + 0.8, yMax + 1]], METAL)
    k.poly([[cowlAft, yMin - 1], [zMin - 1, yMin - 1], [zMin - 1, yMax + 1], [cowlAft, yMax + 1]], NOZZLE)
    k.poly([[cowlAft, yMin + 0.6 * (yMax - yMin)], [zMin - 1, yMin + 0.6 * (yMax - yMin)], [zMin - 1, yMax + 1], [cowlAft, yMax + 1]], WING)
  },
  winglet(k) {
    // 4X-ABI's sharklets (the rest of the fleet has fences, not modelled): a navy blade over a wing-grey lower
    // transition, a light-grey leading-edge strip, the orange star at 47 % of the height on both faces
    const [zMin, zMax, yMin, yMax] = k.a.box
    const h = yMax - yMin
    k.fill(NAVY)
    k.poly([[zMax + 1, yMin - 1], [zMin - 1, yMin - 1], [zMin - 1, yMin + 0.25 * h], [zMax + 1, yMin + 0.25 * h]], WING)
    k.poly([[zMax + 1, yMin - 1], [zMax - 0.12 * (zMax - zMin), yMin - 1], [zMax - 0.12 * (zMax - zMin), yMax + 1], [zMax + 1, yMax + 1]], STAB)
    k.image(asset('liveries/ISR/star.svg'), { z: (zMin + zMax) / 2, y: yMin + 0.47 * h, h: 0.28 * h })
  },
}

// client/livery/designs/WZZ.ts
// Wizz Air (WZZ; Wizz Air Malta WMT and Wizz Air UK WUK wear the same paint), the 2015 livery as on the A321neo fleet:
// a white nose with the outline "WIZZ" logo, a straight diagonal cut (L1) near the wing to all-round magenta, a second,
// flatter diagonal (L2) to royal blue that runs on across the fin and leaves a magenta triangle at the fin's tip, a white
// "wizzair.com" above the windows, a white belly title, magenta engines with titles, magenta Sharklets.
// Measurements: .planning/liveries/WZZ.md (the dossier: d metres aft of the nose, h above the keel, on a 44.51 m
// A321neo), checked by pixel scans of the side-on photos 9H-WDX (left) and HA-LZW (right).
import { asset } from '../kit.ts'
import type { Design, Kit, Pt, Seg } from '../kit.ts'

// The magenta: Wizz Air's press-office #d40f8c made a little lighter (#d93a93, hue 326°), as the paint photographs
// (in sun #e8469a, overcast #b04478 under a #d4d1cf white; hue 319–334°); the blue: the photos' royal blue (median of
// the samples, hue 228°; the brand's digital #2e3192 is a little more violet).
const MAGENTA = '#d93a93'
const BLUE = '#223b9e'
const WHITE = '#f4f5f2'
const GREY = '#b6bbbf' // Airbus light grey: wings, tailplane, pylons, the Sharklet's knee
const LIGHT = '#d2d4d6' // the Sharklet's leading-edge band
const LIP = '#c5c3c0' // bare-metal inlet lip
const METAL = '#4a4d52' // exhaust, core cowl, APU nozzle
const GLASS = '#16181c' // the cockpit windows
const OUTLINE = '#c9cdd0' // door outlines on the white nose
const FONT = 'Montserrat, "Helvetica Neue", Arial, sans-serif'
const X_OVER_CAP = 0.769 // Montserrat Bold's x-height over its cap height (the titles are lowercase; the kit sizes by caps)
const title = (xHeight: number): number => xHeight / X_OVER_CAP // capM for a lowercase title of that x-height
const TITLE_LEN = 11.53 // "wizzair.com" in Montserrat Bold: its length over its x-height

const REF_LEN = 44.51 // the dossier's A321neo, nose tip to the APU exhaust
const REF_H = 4.14 // its fuselage height

/** The dossier's frame on this model: z of a point d metres aft of the nose, y of a point h metres above the keel. */
function frame(k: Kit): { Z: (d: number) => number; Y: (h: number) => number; s: number; hs: number } {
  const s = k.a.length / REF_LEN
  const zMid = k.a.nose - 0.3 * k.a.length // the constant section, ahead of the wing
  const keel = k.bottom(zMid)
  const hs = (k.top(zMid) - keel) / REF_H
  return { Z: (d) => k.a.nose - d * s, Y: (h) => keel + h * hs, s, hs }
}

/** Everything aft of the straight line through a and b (extended far past both ends), as a polygon. */
function aftOf(a: Pt, b: Pt, k: Kit): Pt[] {
  const far = 60
  const [dz, dy] = [b[0] - a[0], b[1] - a[1]]
  const n = Math.hypot(dz, dy)
  const [ux, uy] = [dz / n, dy / n]
  const p0: Pt = [a[0] - ux * far, a[1] - uy * far]
  const p1: Pt = [b[0] + ux * far, b[1] + uy * far]
  const aft = k.a.tail - far
  return [p0, p1, [aft, p1[1]], [aft, p0[1]]]
}

/** A rounded rectangle [z0 aft, z1 fore] × [y0, y1] with corner radius r, as a path. */
function roundRect(z0: number, z1: number, y0: number, y1: number, r: number): Seg[] {
  return [['M', z0 + r, y0], ['L', z1 - r, y0], ['Q', z1, y0, z1, y0 + r], ['L', z1, y1 - r], ['Q', z1, y1, z1 - r, y1],
    ['L', z0 + r, y1], ['Q', z0, y1, z0, y1 - r], ['L', z0, y0 + r], ['Q', z0, y0, z0 + r, y0], ['Z']]
}

export const WZZ: Design = {
  code: 'WZZ',
  name: 'Wizz Air, 2015 livery (A321neo)',
  sources: [
    'https://commons.wikimedia.org/wiki/File:GDN_9H-WDX_2.jpg',
    'https://commons.wikimedia.org/wiki/File:Wizz_Air,_HA-LZW,_Airbus_A321-271NX.jpg',
    'https://commons.wikimedia.org/wiki/File:Wizz_Air_UK,_G-WUKU,_Airbus_A321-271NX_(52531902668).jpg',
    'https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(c-n_12146,_9H-WNR)_2026-09-15_Andre_Gerwing_Collection_ID_031119.jpg',
    'https://commons.wikimedia.org/wiki/File:Airbus_A321-271NX_(c-n_12567,_9H-WMD)_2026-02-25_Andre_Gerwing_Collection_ID_027930.jpg',
    'https://commons.wikimedia.org/wiki/File:9H-WNF_aircraft_at_Kutaisi_Airport,_2024_(12).jpg',
    'https://commons.wikimedia.org/wiki/File:9H-WNF_aircraft_at_Kutaisi_Airport,_2024_(02).jpg',
    'https://commons.wikimedia.org/wiki/File:Wizz_Air_logo_2015.svg',
    'https://commons.wikimedia.org/wiki/File:Wizz_Air_Logo.png',
  ],
  base: WHITE,
  engineColor: MAGENTA,
  wingletColor: MAGENTA,
  wing: GREY,
  stab: GREY,
  fonts: [{ family: 'Montserrat', src: asset('fonts/Montserrat-Bold.woff2'), weight: '700' }],

  side(k) {
    const { Z, Y, s, hs } = frame(k)
    k.fill(WHITE)

    // the cockpit windows, dark (the mesh's glass takes the atlas like the skin): the Airbus outline (9H-WDX), its aft
    // edge on the model's measured one, reaching up and forward over the model's windscreen
    const cz = (d: number): number => k.a.cockpit + (3.02 - d) * s
    k.poly(([[1.2, 2.33], [1.35, 2.62], [1.62, 2.88], [2.0, 2.97], [2.7, 2.95], [2.93, 2.86], [3.03, 2.7], [3.04, 2.4], [2.98, 2.26], [2.0, 2.22], [1.4, 2.24]] as Pt[])
      .map(([d, h]): Pt => [cz(d), Y(h + 0.1)]), GLASS)

    // L1: white → magenta, the keel at d 16.1 to the crown at d 20.0 (pixel scan of 9H-WDX: d = 16.06 + 0.95 h)
    const l1: [Pt, Pt] = [[Z(16.1), Y(0)], [Z(16.1 + 0.945 * 4.14), Y(4.14)]]
    k.poly(aftOf(l1[0], l1[1], k), MAGENTA)
    // L2: magenta → blue, from the keel at d 29.7 through the fin's trailing edge 1.35 m below its tip: the one line
    // crosses the fuselage (crown at d 36.3) and the fin (leading edge about 1 m above the crown), leaving the magenta
    // triangle at the fin's tip and leading edge
    const [tipY] = k.a.finTip
    const teY = tipY - 1.35 * hs
    const t = (teY - k.a.finRoot[0]) / (k.a.finTip[0] - k.a.finRoot[0])
    const te: Pt = [k.a.finRoot[2] + (k.a.finTip[2] - k.a.finRoot[2]) * t, teY]
    const l2: [Pt, Pt] = [[Z(29.7), Y(0)], te]
    k.poly(aftOf(l2[0], l2[1], k), BLUE)
    // the APU exhaust: bare metal
    k.poly([[Z(44.2), Y(-2)], [Z(44.2), Y(6)], [k.a.tail - 2, Y(6)], [k.a.tail - 2, Y(-2)]], METAL)

    // door and over-wing exit outlines: grey on the white, white on the colours
    const outlines = (color: string): void => {
      k.a.doors.forEach((zc, i) => {
        const [w, h0, h1] = i === 0 ? [0.95, 1.5, 3.4] : [0.85, 1.6, 3.3]
        k.stroke(roundRect(zc - (w / 2) * s, zc + (w / 2) * s, Y(h0), Y(h1), 0.12), 0.035, color)
      })
      for (const [d0, d1] of [[17.9, 18.6], [18.7, 19.4]]) k.stroke(roundRect(Z(d1), Z(d0), Y(1.9), Y(3.15), 0.1), 0.035, color)
    }
    outlines(OUTLINE)
    k.clip(aftOf(l1[0], l1[1], k), () => outlines(WHITE))

    // the outline logo between door 1 and the wing, stretched to its painted box (curvature shortens it side-on); it reads
    // correctly on both sides: the "W" nearest the nose on the left, at the aft end on the right
    k.image(asset('liveries/WZZ/logo.svg'), { z: Z((6.6 + 12.1) / 2), y: Y((1.35 + 3.62) / 2), w: 5.5 * s, h: 2.27 * hs })
    // "wizzair.com" above the windows from 0.5 m aft of door 3 (the model's door, else the A321neo's station): x-height
    // 0.465 m on a 3.03 m baseline, 5.36 m long (9H-WDX: d 27.33 … 32.66, HA-LZW: 27.76 … 33.1), ending 1.5 m ahead of
    // L2 (the model's door 3 sits 0.3 m aft of the photos': the title splits the difference). On a shorter fuselage it
    // shrinks to keep 1.4 m clear of L2 and 0.3 m clear of the next door.
    const door3 = k.a.doors.find((zc) => Math.abs(zc - Z(26.65)) < 1.5)
    const fore = door3 !== undefined ? (door3 - (0.45 + 0.5) * s + Z(27.45)) / 2 : Z(27.45)
    const base = Y(3.03)
    const l2At = l2[0][0] + ((l2[1][0] - l2[0][0]) * (base - l2[0][1])) / (l2[1][1] - l2[0][1])
    const next = k.a.doors.find((zc) => zc < fore - 0.5)
    const end = Math.max(l2At + 1.4 * s, next !== undefined ? next + 0.45 * s + 0.3 : -Infinity)
    const xh = Math.max(0.2, Math.min(0.465 * hs, (fore - end) / TITLE_LEN))
    k.text('wizzair.com', { z: fore, y: base, capM: title(xh), color: WHITE, font: FONT, weight: 700, align: 'fore' })
  },

  engine(k) {
    // the nacelle's side box: the inlet lip at zMax; the fan cowl and reverser (magenta) end 3.75 m aft of it
    const [zMin, zMax, yMin, yMax] = k.a.box
    const zc = zMax - 3.75
    const yc = yMin + 1.27 // the nacelle's axis (2.55 m across; the pylon rises above it)
    k.fill(MAGENTA)
    k.poly([[zc, yMin - 1], [zc, yMax + 1], [zMin - 1, yMax + 1], [zMin - 1, yMin - 1]], METAL) // core cowl, nozzle, plug
    k.poly([[zMax - 1.9, yc + 1.33], [zMax - 1.9, yMax + 1], [zMin - 1, yMax + 1], [zMin - 1, yc + 0.7], [zc, yc + 0.7], [zc, yc + 1.33]], GREY) // pylon
    k.poly([[zMax + 1, yMin - 1], [zMax + 1, yMax + 1], [zMax - 0.15, yMax + 1], [zMax - 0.15, yMin - 1]], LIP)
    // "wizzair.com" 0.62 to 2.97 m aft of the lip, on the axis, on every face (upright: the kit reads it right on both)
    k.text('wizzair.com', { z: zMax - 0.62, y: yc - 0.1, capM: title(0.205), color: WHITE, font: FONT, weight: 700, align: 'fore' })
  },

  winglet(k) {
    // the Sharklet's side box (a21n: z -5.45 … -3.13, y -2.31 … 0.11): the knee (its lowest 0.4 m) wing grey, the blade
    // magenta with a light leading-edge band (about a fifth of the chord: 9H-WNR, 9H-WMD). The mesh: the leading edge
    // 0.3 m aft of zMax at the top of the knee, swept 0.775 m aft per metre up; the chord 1.0 m there, 0.47 m at the tip.
    const [zMin, zMax, yMin, yMax] = k.a.box
    const knee = yMin + 0.4
    const le = (y: number): number => zMax - 0.3 - 0.775 * (y - knee)
    const chord = (y: number): number => Math.max(0.3, 1.0 - ((1.0 - 0.47) * (y - knee)) / (yMax - knee))
    k.fill(MAGENTA)
    k.poly([[le(yMin - 1) + 1, yMin - 1], [le(yMax + 1) + 1, yMax + 1], [le(yMax + 1) - 0.2 * chord(yMax + 1), yMax + 1],
      [le(yMin - 1) - 0.2 * chord(yMin - 1), yMin - 1]], LIGHT)
    k.poly([[zMin - 1, yMin - 1], [zMax + 1, yMin - 1], [zMax + 1, knee], [zMin - 1, knee]], GREY)
  },

  belly(k) {
    const { Z, hs } = frame(k)
    // the belly title, nose to tail from where L1 meets the keel (d 17.1 … 25.4, 9H-WMD), letter tops to port (readable
    // from below-left, upside down from below-right): x-height 0.72 m, the fuselage title's proportions
    k.text('wizzair.com', { z: Z(17.1), y: -0.36, capM: title(0.72) * hs, color: WHITE, font: FONT, weight: 700, align: 'fore' })
  },
}

// client/scene/icons.ts
/**
 * Top-down aircraft silhouettes for the fleet layer, drawn here on a canvas (FlightHopper's own shapes, no third-party
 * icon set). White fill + thin dark outline: a Cesium billboard's `color` multiplies the texture, so the fill takes the
 * altitude tint and the outline stays dark on light and dark maps. Nose points up (north before rotation).
 */

export type IconKind = 'jet' | 'heavy' | 'light' | 'heli' | 'ground' | 'unknown'
export const ICON_KINDS: readonly IconKind[] = ['jet', 'heavy', 'light', 'heli', 'ground', 'unknown']
/** Texture-atlas id per kind: a stable id makes Cesium store each canvas once for every billboard that uses it. */
export const ICON_ID: Readonly<Record<IconKind, string>> = {
  jet: 'fh-icon-jet',
  heavy: 'fh-icon-heavy',
  light: 'fh-icon-light',
  heli: 'fh-icon-heli',
  ground: 'fh-icon-ground',
  unknown: 'fh-icon-unknown',
}
export const ICON_PX = 40
export const HALO_PX = 64
export const HALO_ID = 'fh-halo'

// ADS-B emitter category (DO-260B §2.2.3.2.5.2) → silhouette. A0/B0/C0 ("no information") and reserved values are absent.
const BY_CATEGORY = new Map<string, IconKind>([
  ['A1', 'light'], // light, < 15,500 lb
  ['A2', 'jet'], //   small, 15,500–75,000 lb (regional and business jets)
  ['A3', 'jet'], //   large, 75,000–300,000 lb
  ['A4', 'jet'], //   high-vortex large (B757)
  ['A5', 'heavy'], // heavy, > 300,000 lb
  ['A6', 'jet'], //   high performance (> 5 g, > 400 kt)
  ['A7', 'heli'], //  rotorcraft
  ['B1', 'light'], // glider / sailplane
  ['B2', 'unknown'], // lighter-than-air
  ['B3', 'unknown'], // parachutist / skydiver
  ['B4', 'light'], // ultralight / hang-glider / paraglider
  ['B6', 'light'], // unmanned aerial vehicle
  ['B7', 'unknown'], // space / trans-atmospheric vehicle
  ['C1', 'ground'], // surface vehicle, emergency
  ['C2', 'ground'], // surface vehicle, service
  ['C3', 'ground'], // point obstacle (incl. tethered balloons)
  ['C4', 'ground'], // cluster obstacle
  ['C5', 'ground'], // line obstacle
])

// ICAO Doc 8643 type designators (facts, listed by hand). Wide-body / heavy-wake airframes:
const HEAVY = new Set([
  'A306', 'A30B', 'A310', 'A332', 'A333', 'A337', 'A338', 'A339', 'A342', 'A343', 'A345', 'A346', 'A359', 'A35K', 'A388',
  'A3ST', 'A400', 'A124', 'A225', 'AN22', 'B741', 'B742', 'B743', 'B744', 'B748', 'B74R', 'B74S', 'B762', 'B763', 'B764',
  'B772', 'B773', 'B77L', 'B77W', 'B778', 'B779', 'B788', 'B789', 'B78X', 'C5M', 'C17', 'DC10', 'IL76', 'IL86', 'IL96',
  'K35R', 'L101', 'MD11',
])
// Helicopters:
const HELI = new Set([
  'A109', 'A119', 'A129', 'A139', 'A149', 'A169', 'A189', 'AS32', 'AS3B', 'AS50', 'AS55', 'AS65', 'B06', 'B06T', 'B105',
  'B212', 'B407', 'B412', 'B429', 'B430', 'B47G', 'B505', 'BK17', 'EC20', 'EC25', 'EC30', 'EC35', 'EC45', 'EC55', 'EC75',
  'EH10', 'EXPL', 'GAZL', 'H160', 'H269', 'H47', 'H500', 'H53', 'H60', 'H64', 'KA32', 'LYNX', 'MI8', 'MI24', 'MI26',
  'NH90', 'PUMA', 'R22', 'R44', 'R66', 'S61', 'S64', 'S76', 'S92', 'UH1',
])
// Pistons, turboprops and other light / straight-wing types (Cessna, Piper, Cirrus, Diamond, Beech, Mooney, ATR, Dash 8, …).
// ponytail: a hand list of the common families, not the full Doc 8643 table. Misses fall back to 'jet', and C130/C160 draw
// as 'light' (right shape, small). Upgrade: ship the Doc 8643 description codes (L1P/L2T/…) as JSON and map by those.
const LIGHT =
  /^(C1\d\d|C2\d\d|C3[0-4]\d|C4[0-4]\d|P28.|P32.|PA\d\d|SR2[02]|S22T|DA\d\d|DV20|BE\d\d|BE9.|B350|B190|M20.|AT[4-7]\d|DH8.|DHC\d|SF34|SB20|JS\d\d|D228|D328|L410|PC\d{1,2}T?|TBM\d|P180|E110|E120|F27|F50|AN2[468]|AN32|Y12|C212|CN35|C295|BN2.|GA8|G115|AA5)$/

/**
 * Which silhouette to draw. A helicopter type designator wins outright (transponders are often set to A1/A2); otherwise
 * the broadcast emitter category decides; without one the type designator does; with neither → 'unknown'.
 */
export function iconFor(category: string | null, typeCode: string | null): IconKind {
  const type = typeCode || null
  if (type !== null && HELI.has(type)) return 'heli'
  const byCategory = category ? BY_CATEGORY.get(category) : undefined
  if (byCategory) return byCategory
  if (type === null) return 'unknown'
  if (HEAVY.has(type)) return 'heavy'
  if (LIGHT.test(type)) return 'light'
  return 'jet'
}

// Outlines: the right half, nose → tail, as x,y pairs in a 40-unit box centred on the aircraft (y down, nose at −y).
// The left half is the mirror image. pods = engines / nacelles [x, y, rx, ry], drawn on both sides.
interface Shape {
  half: readonly number[]
  pods: readonly (readonly [number, number, number, number])[]
}
const SHAPES: Readonly<Record<Exclude<IconKind, 'heli'>, Shape>> = {
  jet: {
    half: [0, -15, 1.3, -13.8, 2, -11.5, 2, -3, 13.5, 3.2, 13.5, 5, 2, 2.2, 1.7, 9, 6.2, 12.4, 6.2, 14, 1, 13.2, 0, 14.6],
    pods: [[6, 0.2, 1.2, 2.2]],
  },
  heavy: {
    half: [0, -18, 1.7, -16.6, 2.7, -13.5, 2.7, -4, 18, 5, 18, 7, 2.7, 2.6, 2.3, 11.5, 8, 15.2, 8, 17, 1.4, 15.8, 0, 17.6],
    pods: [[8, 0.6, 1.6, 2.9]],
  },
  light: {
    half: [0, -11, 1.2, -10.2, 1.7, -8, 1.7, -3.6, 13, -3.2, 13, -0.4, 1.7, 0, 1.1, 7.2, 5, 7.6, 5, 9.6, 0.8, 9.8, 0, 10.6],
    pods: [],
  },
  ground: { half: [0, -7, 3, -7, 4, -6, 4, 6, 3, 7, 0, 7], pods: [] },
  unknown: { half: [0, -11, 8, 10, 0, 5], pods: [] },
}
const HELI_BOOM = [0, 1.5, 1, 2, 1, 10.8, 4, 11, 4, 12.6, 1, 12.8, 0, 14]
const FILL = '#fff'
const OUTLINE = 'rgba(0, 0, 0, 0.85)'
const OUTLINE_PX = 1.2

type Ctx = CanvasRenderingContext2D

function outline(ctx: Ctx, half: readonly number[], X: (x: number) => number, Y: (y: number) => number): void {
  ctx.beginPath()
  ctx.moveTo(X(half[0]), Y(half[1]))
  for (let i = 2; i < half.length; i += 2) ctx.lineTo(X(half[i]), Y(half[i + 1]))
  for (let i = half.length - 4; i >= 2; i -= 2) ctx.lineTo(X(-half[i]), Y(half[i + 1]))
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
}

/** Draws one silhouette centred in a px × px canvas. */
export function drawIcon(ctx: Ctx, kind: IconKind, px: number): void {
  const k = px / 40
  const X = (x: number): number => px / 2 + x * k
  const Y = (y: number): number => px / 2 + y * k
  ctx.lineJoin = 'round'
  ctx.lineWidth = OUTLINE_PX
  ctx.strokeStyle = OUTLINE
  if (kind === 'heli') {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)' // rotor disc: a faint tinted circle
    ctx.beginPath()
    ctx.arc(X(0), Y(-2), 11 * k, 0, 2 * Math.PI)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = FILL
    outline(ctx, HELI_BOOM, X, Y)
    ctx.beginPath()
    ctx.ellipse(X(0), Y(-2.5), 3.6 * k, 6 * k, 0, 0, 2 * Math.PI)
    ctx.fill()
    ctx.stroke()
    return
  }
  const shape = SHAPES[kind]
  ctx.fillStyle = FILL
  outline(ctx, shape.half, X, Y)
  for (const [x, y, rx, ry] of shape.pods) {
    for (const side of [-1, 1]) {
      ctx.beginPath()
      ctx.ellipse(X(side * x), Y(y), rx * k, ry * k, 0, 0, 2 * Math.PI)
      ctx.fill()
      ctx.stroke()
    }
  }
}

function canvas(px: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas')
  c.width = px
  c.height = px
  return [c, c.getContext('2d') as Ctx]
}

const cache = new Map<IconKind, HTMLCanvasElement>()

/** The silhouette canvas for a kind: drawn on first use, then the same object every call. */
export function iconCanvas(kind: IconKind): HTMLCanvasElement {
  let c = cache.get(kind)
  if (!c) {
    const [cv, ctx] = canvas(ICON_PX)
    drawIcon(ctx, kind, ICON_PX)
    cache.set(kind, (c = cv))
  }
  return c
}

let halo: HTMLCanvasElement | null = null

/** Selection ring (white on a dark edge, so it reads on any map; tint it with the billboard colour). */
export function haloCanvas(): HTMLCanvasElement {
  if (!halo) {
    const [cv, ctx] = canvas(HALO_PX)
    ctx.beginPath()
    ctx.arc(HALO_PX / 2, HALO_PX / 2, HALO_PX / 2 - 5, 0, 2 * Math.PI)
    ctx.lineWidth = 5
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)'
    ctx.stroke()
    ctx.lineWidth = 2.5
    ctx.strokeStyle = FILL
    ctx.stroke()
    halo = cv
  }
  return halo
}

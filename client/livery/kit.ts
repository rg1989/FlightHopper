// client/livery/kit.ts
// The livery kit: an airline design (designs/*.ts) draws its paint with it in side elevation, in metres of the model's
// paint frame (+z nose, +y up; livery-pipeline-design.md §4), in landmark terms: the fuselage contour, the fin's chord
// and height, the window line, door 1, the wing root. The kit only records draw ops (pure, tested in node); raster.ts
// draws them into the atlases the paint shader samples. One design paints every model: the same calls land on each
// model's own measured profile (manifest `profile`, tools/models/profile.ts).
import type { ModelManifestEntry, ModelProfile, Paint } from '../types.ts'

export type Side = 'left' | 'right'
export type Region = 'skin' | 'nacelle' | 'tip' | 'belly'
/** A CSS colour (sRGB). */
export type Color = string
/** A colour or a gradient in metres: linear from (z0, y0) to (z1, y1), or radial around (z, y); stops 0 … 1. */
export type Fill = Color | { linear: [z0: number, y0: number, z1: number, y1: number]; stops: Array<[number, Color]> } | { radial: [z: number, y: number, r: number]; stops: Array<[number, Color]> }
/** A point [z, y] in metres. */
export type Pt = [z: number, y: number]
/** A height on the fuselage as a fraction of its local height (0 keel … 1 crown), fixed or varying along z. */
export type Frac = number | ((z: number) => number)
/** A path segment in metres: M/L to a point, Q/C Béziers (control points first), Z closes. */
export type Seg = ['M', number, number] | ['L', number, number] | ['Q', number, number, number, number] | ['C', number, number, number, number, number, number] | ['Z']

export interface TextOpts {
  z: number // the anchor along the fuselage (see align)
  y: number // the baseline
  capM: number // cap height in metres
  color: Color
  font?: string // CSS font family list
  weight?: number | string
  italic?: boolean
  align?: 'fore' | 'centre' | 'aft' // which end of the text sits at z (on both sides: the text covers the same span)
  tracking?: number // letter spacing, em
  mirror?: boolean // right side: mirror it instead of reading correctly (never for text in practice)
}

export interface ImageOpts {
  z: number // box centre
  y: number
  w?: number // box size in metres; give one and the image's aspect gives the other
  h?: number
  mirror?: boolean // right side: mirrored, so a directional logo faces forward on both sides (default: reads correctly)
  opacity?: number
}

export type Op =
  | { k: 'fill'; color: Fill }
  | { k: 'path'; d: Seg[]; color: Fill }
  | { k: 'stroke'; d: Seg[]; color: Fill; widthM: number }
  | { k: 'clip'; d: Seg[] }
  | { k: 'unclip' }
  | ({ k: 'text'; text: string } & Required<Omit<TextOpts, 'font'>> & { font: string })
  | ({ k: 'image'; src: string } & ImageOpts)
  | { k: 'wrap'; src: string; box: [zNose: number, zTail: number, yBottom: number, yTop: number] }

/** An airline's paint, drawn by the kit on any model (client/livery/designs/). */
export interface Design {
  code: string // airline ICAO code (liveries.json key)
  name: string // e.g. "Wizz Air, 2015 livery"
  sources?: string[] // reference photos and brand pages the design was drawn from
  /** The fuselage and fin, one side at a time (k.side); shapes should be the same on both sides. */
  side(k: Kit): void
  /** The engine nacelles, in the nacelle's side box. Default: fill `engine`, else the flat base. */
  engine?(k: Kit): void
  /** The wingtip devices (sharklets, winglets), in their side box. Default: fill `winglet` else `wing`. */
  winglet?(k: Kit): void
  /**
   * Markings seen only from below (belly titles, a belly panel narrower than the fuselage), drawn in plan view: z along
   * the fuselage and y across it (+ the left wing), seen from below with the nose at the left. Transparent where not
   * drawn; blended onto the skin where it faces down. Default: none.
   */
  belly?(k: Kit): void
  base?: Color // the fuselage colour drawn before the atlas is ready (default: white)
  engineColor?: Color
  wingletColor?: Color
  wing?: Color // wings (default: light grey)
  stab?: Color // horizontal tailplane (default: wing)
  fonts?: Array<{ family: string; src: string; weight?: string; style?: string }> // web fonts to load (public/ paths)
}

/** A public/ file's URL (logos, fonts), under the app's base path. */
export const asset = (path: string): string => `${import.meta.env?.BASE_URL ?? '/'}${path}`

export const WING = '#dbe0e6' // the old shader's wing grey (0.86, 0.88, 0.9)
export const WHITE = '#f7f7f7'

/** The landmarks a design places things by. */
export interface Landmarks {
  nose: number
  tail: number
  length: number
  cockpit: number // z of the cockpit windows' aft edge
  door1: number // z of the first left passenger door's centre
  doors: number[]
  windowY: number // the cabin window row's centre
  wingLe: number // wing root leading and trailing edge z
  wingTe: number
  finRoot: [y: number, le: number, te: number]
  finTip: [y: number, le: number, te: number]
  box: [zMin: number, zMax: number, yMin: number, yMax: number] // this region's atlas box
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const fracAt = (f: Frac, z: number): number => (typeof f === 'number' ? f : f(z))

/** The contour [z, yBottom, yTop] at z, linearly between stations (nose → tail; clamped at the ends). */
export function contourAt(body: ModelProfile['body'], z: number): [number, number] {
  if (body.length === 0) return [0, 0]
  if (z >= body[0][0]) return [body[0][1], body[0][2]]
  const last = body[body.length - 1]
  if (z <= last[0]) return [last[1], last[2]]
  let lo = 0
  let hi = body.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (body[mid][0] >= z) lo = mid
    else hi = mid
  }
  const [z0, b0, t0] = body[lo]
  const [z1, b1, t1] = body[hi]
  const t = z0 === z1 ? 0 : (z - z0) / (z1 - z0)
  return [lerp(b0, b1, t), lerp(t0, t1, t)]
}

/**
 * The kit for one region and side. Drawing is painter's order; everything outside the region's surface is never seen,
 * so shapes may overshoot freely (and should, at the nose and tail tips, to leave no seams).
 */
export class Kit {
  readonly ops: Op[] = []
  readonly a: Landmarks
  readonly p: ModelProfile
  readonly side: Side
  readonly model: string // manifest id, for the rare per-model tweak
  readonly region: Region
  readonly paint: Paint | undefined // the model's paint map (old-style liveries place their decals by it)
  constructor(o: { profile: ModelProfile; side: Side; model: string; region?: Region; paint?: Paint }) {
    const p = (this.p = o.profile)
    this.side = o.side
    this.model = o.model
    const region = (this.region = o.region ?? 'skin')
    this.paint = o.paint
    const windowY = o.paint?.windows?.[0]
    const nose = p.body.length ? p.body[0][0] : p.box[1]
    const tail = p.body.length ? p.body[p.body.length - 1][0] : p.box[0]
    const box: Landmarks['box'] =
      region === 'nacelle' && p.engines ? [p.engines[2], p.engines[3], p.engines[4], p.engines[5]]
      : region === 'tip' && p.winglet ? [p.winglet[2], p.winglet[3], p.winglet[4], p.winglet[5]]
      : region === 'belly' ? [p.box[0], p.box[1], -bellyHalf(o.paint), bellyHalf(o.paint)]
      : p.box
    const [bot, top] = contourAt(p.body, (nose + tail) / 2)
    this.a = {
      nose, tail, length: nose - tail, cockpit: p.cockpit, door1: p.doors[0] ?? p.cockpit - 2.2, doors: p.doors,
      windowY: windowY ?? lerp(bot, top, 0.6), wingLe: p.wing[0], wingTe: p.wing[1], finRoot: p.finRoot, finTip: p.finTip, box,
    }
  }

  /** The fuselage's bottom and top at z. */
  bottom(z: number): number {
    return contourAt(this.p.body, z)[0]
  }

  top(z: number): number {
    return contourAt(this.p.body, z)[1]
  }

  /** The y at fraction f of the fuselage's local height at z (0 keel, 1 crown; may go beyond). */
  at(z: number, f: number): number {
    const [b, t] = contourAt(this.p.body, z)
    return lerp(b, t, f)
  }

  /** The point on the fin at chord fraction u (0 leading edge … 1 trailing edge) and height h (0 root … 1 tip). */
  fin(u: number, h: number): Pt {
    const [y0, le0, te0] = this.a.finRoot
    const [y1, le1, te1] = this.a.finTip
    return [lerp(lerp(le0, le1, h), lerp(te0, te1, h), u), lerp(y0, y1, h)]
  }

  /** Fills the whole region. */
  fill(color: Fill): this {
    this.ops.push({ k: 'fill', color })
    return this
  }

  poly(pts: Pt[], color: Fill): this {
    if (pts.length < 3) return this
    this.ops.push({ k: 'path', d: segs(pts, true), color })
    return this
  }

  path(d: Seg[], color: Fill): this {
    this.ops.push({ k: 'path', d, color })
    return this
  }

  /** A line along a path or through points, widthM metres wide on the aircraft. */
  stroke(d: Seg[] | Pt[], widthM: number, color: Fill): this {
    this.ops.push({ k: 'stroke', d: isSegs(d) ? d : segs(d, false), color, widthM })
    return this
  }

  /** A disc of radius r metres (dots, roundels). */
  circle(z: number, y: number, r: number, color: Fill): this {
    const k = 0.5523 * r // four cubic quarter-arcs
    return this.path([['M', z + r, y], ['C', z + r, y + k, z + k, y + r, z, y + r], ['C', z - k, y + r, z - r, y + k, z - r, y],
      ['C', z - r, y - k, z - k, y - r, z, y - r], ['C', z + k, y - r, z + r, y - k, z + r, y], ['Z']], color)
  }

  /** Draws only inside a shape: 'fin' (its measured outline, a little into the fuselage), points, or a path. */
  clip(shape: 'fin' | Pt[] | Seg[], draw: () => void): this {
    const d = shape === 'fin' ? segs(this.finOutline(0.05), true) : isSegs(shape) ? shape : segs(shape, true)
    this.ops.push({ k: 'clip', d })
    draw()
    this.ops.push({ k: 'unclip' })
    return this
  }

  /** The fin's outline (measured, else from the root and tip chords), reaching `down` metres below its root. */
  finOutline(down = 0): Pt[] {
    const pts: Pt[] = this.p.fin.length >= 3 ? [...this.p.fin] : [this.fin(0, 0), this.fin(0, 1), this.fin(1, 1), this.fin(1, 0)]
    if (down <= 0) return pts
    const [y0, le0, te0] = this.a.finRoot
    return [[le0, y0 - down], ...pts, [Math.min(te0, this.a.tail) - 0.5, y0 - down]]
  }

  /** The z stations from `from` to `to` (fore to aft), every step metres, both ends included. */
  stations(from: number, to: number, step = 0.25): number[] {
    const n = Math.max(1, Math.ceil(Math.abs(from - to) / step))
    return Array.from({ length: n + 1 }, (_, i) => lerp(from, to, i / n))
  }

  /**
   * A band between two contour fractions (f0 below f1), from z `from` to `to` (default: past the nose to past the
   * tail). Fractions below 0 or above 1 reach past the keel or the crown (e.g. −0.3 … 0.35: the whole belly).
   */
  band(f0: Frac, f1: Frac, color: Fill, o: { from?: number; to?: number } = {}): this {
    const from = o.from ?? this.a.nose + 0.5
    const to = o.to ?? this.a.tail - 0.5
    const zs = this.stations(from, to)
    const upper = zs.map((z): Pt => [z, this.at(z, fracAt(f1, z))])
    const lower = zs.reverse().map((z): Pt => [z, this.at(z, fracAt(f0, z))])
    return this.poly([...upper, ...lower], color)
  }

  /** Everything below fraction f (the belly), past the keel. */
  below(f: Frac, color: Fill, o: { from?: number; to?: number } = {}): this {
    return this.band(-0.6, f, color, o)
  }

  /** Everything above fraction f up to past the crown (the fin is drawn over it, or not, by the design's order). */
  above(f: Frac, color: Fill, o: { from?: number; to?: number } = {}): this {
    return this.band(f, 1.6, color, o)
  }

  /** A stripe of constant width (metres) centred on fraction f. */
  stripe(f: Frac, widthM: number, color: Fill, o: { from?: number; to?: number } = {}): this {
    const from = o.from ?? this.a.nose + 0.5
    const to = o.to ?? this.a.tail - 0.5
    const zs = this.stations(from, to)
    const mid = (z: number): number => this.at(z, fracAt(f, z))
    const upper = zs.map((z): Pt => [z, mid(z) + widthM / 2])
    const lower = zs.reverse().map((z): Pt => [z, mid(z) - widthM / 2])
    return this.poly([...upper, ...lower], color)
  }

  /** The fin (its measured outline), reaching `down` metres into the fuselage below its root. */
  finFill(color: Fill, o: { down?: number } = {}): this {
    const down = o.down ?? 0.15
    const [y0, le0, te0] = this.a.finRoot
    this.poly(this.finOutline(), color)
    // the root strip: from under the leading edge root to under the trailing edge root, past the tail
    return this.poly([[le0, y0 + 0.05], [le0, y0 - down], [Math.min(te0, this.a.tail) - 0.5, y0 - down], [Math.min(te0, this.a.tail) - 0.5, y0 + 0.05]], color)
  }

  /** A polygon in fin coordinates [u, h] (chord fraction, height fraction); may overshoot the outline. */
  finPoly(pts: Array<[u: number, h: number]>, color: Fill): this {
    return this.poly(pts.map(([u, h]) => this.fin(u, h)), color)
  }

  text(text: string, o: TextOpts): this {
    this.ops.push({
      k: 'text', text, z: o.z, y: o.y, capM: o.capM, color: o.color, font: o.font ?? 'Helvetica, Arial, sans-serif', weight: o.weight ?? 700,
      italic: o.italic ?? false, align: o.align ?? 'fore', tracking: o.tracking ?? 0, mirror: o.mirror ?? false,
    })
    return this
  }

  image(src: string, o: ImageOpts): this {
    this.ops.push({ k: 'image', src, ...o })
    return this
  }

  /** A ready-made atlas image over box (top half: left side, bottom half: right side, both nose at the left). */
  wrap(src: string, box: [zNose: number, zTail: number, yBottom: number, yTop: number]): this {
    this.ops.push({ k: 'wrap', src, box })
    return this
  }
}

const isSegs = (d: Seg[] | Pt[]): d is Seg[] => d.length > 0 && typeof d[0][0] === 'string'
const segs = (pts: Pt[], closed: boolean): Seg[] => [['M', pts[0][0], pts[0][1]], ...pts.slice(1).map(([z, y]): Seg => ['L', z, y]), ...(closed ? [['Z'] as Seg] : [])]

/** A region's ops for both sides. */
export interface RegionOps {
  box: Landmarks['box']
  left: Op[]
  right: Op[]
}

export interface DesignOps {
  skin: RegionOps
  nacelle: RegionOps | null
  tip: RegionOps | null
  belly: RegionOps | null // one view (left), from below
}

/** Half the belly atlas's width: the fuselage's half-width and a little. */
export const bellyHalf = (paint: Paint | undefined): number => (paint?.bodyHalfWidth ?? 2.4) + 0.1

/** The model a design is drawn on. */
export interface Target {
  id: string
  profile: ModelProfile
  paint?: Paint
}

/** Runs a design on a model: the draw ops of each region and side. */
export function drawDesign(d: Design, m: Target): DesignOps {
  const p = m.profile
  const run = (region: Region, draw: (k: Kit) => void): RegionOps => {
    const left = new Kit({ profile: p, side: 'left', model: m.id, region, paint: m.paint })
    const right = new Kit({ profile: p, side: 'right', model: m.id, region, paint: m.paint })
    draw(left)
    draw(right)
    return { box: left.a.box, left: left.ops, right: right.ops }
  }
  return {
    skin: run('skin', (k) => d.side(k)),
    nacelle: p.engines ? run('nacelle', (k) => (d.engine ? d.engine(k) : k.fill(d.engineColor ?? d.base ?? WHITE))) : null,
    tip: p.winglet ? run('tip', (k) => (d.winglet ? d.winglet(k) : k.fill(d.wingletColor ?? d.wing ?? WING))) : null,
    belly: d.belly ? run('belly', d.belly) : null,
  }
}

/** Every image a design's ops use (to load before drawing). */
export function imagesOf(ops: DesignOps): string[] {
  const out = new Set<string>()
  for (const r of [ops.skin, ops.nacelle, ops.tip, ops.belly]) {
    for (const op of r ? [...r.left, ...r.right] : []) if (op.k === 'image' || op.k === 'wrap') out.add(op.src)
  }
  return [...out]
}

/**
 * A rough profile for a model the profile tool has not measured, from its paint map and length: a centred tube with
 * a tapered nose and an upswept tail, the paint map's fin. Enough for the flat colours and decals of old liveries.
 * ponytail: a stand-in only; every painted model in the manifest carries a measured profile.
 */
export function roughProfile(paint: Paint, lengthM: number): ModelProfile {
  const half = lengthM / 2
  const r = paint.bodyHalfWidth * 0.9
  const yc = paint.windows ? paint.windows[0] - 0.1 : paint.bellyBelowY + r * 0.75
  const [ly, ls] = [paint.finLogo[1], paint.finLogo[2]]
  const finTop = ly + ls * 0.75
  const body: ModelProfile['body'] = []
  for (let z = half; z >= -half; z -= 0.25) {
    const s = (half - z) / lengthM // 0 nose … 1 tail
    const noseK = Math.min(1, Math.sqrt(s / 0.1))
    const tailK = s < 0.72 ? 1 : 1 - (s - 0.72) / 0.28
    const bottom = yc - r * noseK * (s < 0.72 ? 1 : 1 - 0.9 * (1 - tailK))
    const top = yc + r * noseK * (s < 0.72 ? 1 : 0.35 + 0.65 * tailK)
    body.push([+z.toFixed(2), +bottom.toFixed(2), +Math.max(top, bottom + 0.2).toFixed(2)])
  }
  const le0 = paint.fin.behindZ
  const te0 = -half + 0.8
  const finRoot: ModelProfile['finRoot'] = [paint.fin.aboveY, le0, te0]
  const finTip: ModelProfile['finTip'] = [finTop, te0 + (le0 - te0) * 0.45, te0 + 0.3]
  return {
    box: [-half - 0.1, half + 0.1, yc - r - 0.4, finTop + 0.1], body,
    fin: [[finRoot[1], finRoot[0]], [finTip[1], finTip[0]], [finTip[2], finTip[0]], [finRoot[2], finRoot[0]]], finRoot, finTip,
    wing: [paint.engines[3] + 1, paint.engines[2] - 2, paint.bellyBelowY, paint.engines[1] * 2, paint.wingTipY ?? paint.bellyBelowY],
    engines: null, winglet: null, stab: null, doors: [], cockpit: half - lengthM * 0.09,
  }
}

/** The profile a model's paint is drawn on. */
export function profileOf(m: Pick<ModelManifestEntry, 'profile' | 'paint' | 'lengthM' | 'scale'>): ModelProfile | null {
  if (m.profile) return m.profile
  return m.paint ? roughProfile(m.paint, m.lengthM / m.scale) : null
}

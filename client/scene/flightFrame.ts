// client/scene/flightFrame.ts
// The flight-data frame (.planning/scenarios-design.md §5): the traffic's two corner brackets around the chased
// aircraft, and four small readout blocks hugging them: altitude, height and vertical speed on the left; airspeed,
// ground speed and thrust on the right; heading and wind on top; attitude, g and configuration below. One component for
// live chase (liveFlightData: what ADS-B broadcasts) and scenarios (the track's FlightData). The blocks keep a fixed
// pixel size at every zoom; frameLayout (pure) places them, every frame, and their text changes at most every TEXT_MS.
import { Cartesian2, Cartesian3, Math as CesiumMath, Matrix4, SceneTransforms } from 'cesium'
import type { PerspectiveFrustum, Viewer } from 'cesium'
import type { ReadsbAircraft } from '../../shared/types.ts'
import type { FlightData, ModelManifestEntry, RenderState } from '../types.ts'
import { BOX_CENTRE, BOX_HALF, squarePx } from './traffic.ts'
import '../ui/flightFrame.css'

/** A rectangle in CSS px from the canvas's top-left. */
export interface Rect { x: number; y: number; w: number; h: number }
/** The bracket square: centre and side, CSS px from the canvas's top-left. */
export interface Square { x: number; y: number; side: number }
export type BlockId = 'left' | 'right' | 'top' | 'bottom'

/** One quantity as a block shows it: "AGL 11,850 ft" is { label: 'AGL', value: '11,850', unit: 'ft' }. est: an estimate, drawn dimmer. */
export interface Field { key: string; label: string; value: string; unit: string; est: boolean; big?: true }
export interface Chip { key: string; text: string; est: boolean }
/** One engine's thrust bar: frac of the 1.0–2.0 EPR scale, 0–1; null: unknown. */
export interface Bar { label: string; frac: number | null }
/**
 * What one block shows: lines of fields, and its glyph (the top's wind dial, the bottom's horizon, the right's thrust
 * bars) with the angles to draw it at. A block with nothing (isEmpty) is hidden.
 */
export interface BlockView {
  rows: Field[][]
  wind: { deg: number; est: boolean } | null // the arrow's bearing from the nose, clockwise, −180…180
  horizon: { rotDeg: number; offsetPx: number; est: boolean } | null // the horizon's rotation (−roll) and its drop (pitch)
  bars: { bars: Bar[]; est: boolean } | null
  chips: Chip[]
}

export const TEXT_MS = 100 // text at most 10 times a second: steadier to read, and a DOM rebuild costs more than a transform
export const PITCH_PX = 0.6 // the horizon glyph's line moves this many px per degree of pitch
const HORIZON_MAX_PX = 12 // …up to ±20°, inside the glyph's 14 px radius
const LEVEL_FPM = 50 // within this a vertical speed reads 0, without an arrow (ADS-B rates come in 64 fpm steps)
const EPR_MIN = 1
const EPR_MAX = 2
const MINUS = '\u2212' // the typographic minus: the width of the plus sign, not a hyphen's
const IDS: readonly BlockId[] = ['left', 'right', 'top', 'bottom']

const fin = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v)
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)
/** Whole, thousands separated, a true minus sign: "−1,300". */
const num = (v: number): string => {
  const r = Math.round(v) || 0 // `|| 0` turns −0 into 0
  return `${r < 0 ? MINUS : ''}${Math.abs(r).toLocaleString('en-US')}`
}
const by10 = (v: number): number => Math.round(v / 10) * 10
/** Three figures, north as 360 (the aviation convention: 001–360). */
const deg3 = (d: number): string => `${String((((Math.round(d) % 360) + 360) % 360) || 360).padStart(3, '0')}°`
/** An angle in (−180, 180]. */
const rel180 = (a: number): number => 180 - ((((180 - a) % 360) + 360) % 360)

export const fieldText = (f: Field): string => [f.label, f.value, f.unit].filter((s) => s !== '').join(' ')
export const rowText = (row: readonly Field[]): string => row.map(fieldText).join(' · ')
export const isEmpty = (v: BlockView): boolean =>
  v.rows.length === 0 && v.wind === null && v.horizon === null && v.bars === null && v.chips.length === 0

/**
 * Where each block's top-left goes around the square sq (sizes: each block's measured size; 0 × 0: hidden, it takes
 * no room). Each hugs its side of the square at `gap`, centred on it; each stays inside `safe` (a square larger than
 * the safe area pins them to its edges). No two come closer than `gap`: left and right go side by side when clamping
 * brings them together; the top block rises above any side block it would touch and the bottom block drops below
 * them, and when an edge stops them the sides give way. Holds while the safe area fits the stack: top, the taller
 * side, bottom and two gaps high; left, a gap and right wide (a phone's is, with room to spare).
 */
export function frameLayout(sq: Square, sizes: Record<BlockId, { w: number; h: number }>, safe: Rect, gap = 10): Record<BlockId, { x: number; y: number }> {
  const r = sq.side / 2
  const right = safe.x + safe.w
  const bottom = safe.y + safe.h
  const { left: L, right: R, top: T, bottom: B } = sizes
  const cx = (x: number, w: number): number => Math.max(safe.x, Math.min(x, right - w))
  const cy = (y: number, h: number): number => Math.max(safe.y, Math.min(y, bottom - h))
  const p: Record<BlockId, { x: number; y: number }> = {
    left: { x: cx(sq.x - r - gap - L.w, L.w), y: cy(sq.y - L.h / 2, L.h) },
    right: { x: cx(sq.x + r + gap, R.w), y: cy(sq.y - R.h / 2, R.h) },
    top: { x: cx(sq.x - T.w / 2, T.w), y: cy(sq.y - r - gap - T.h, T.h) },
    bottom: { x: cx(sq.x - B.w / 2, B.w), y: cy(sq.y + r + gap, B.h) },
  }
  const on = (id: BlockId): boolean => sizes[id].w > 0 && sizes[id].h > 0
  // Closer than the gap along x: they must be apart along y.
  const nearX = (a: BlockId, b: BlockId): boolean => p[a].x < p[b].x + sizes[b].w + gap && p[b].x < p[a].x + sizes[a].w + gap
  // Left and right both sit on the square's middle, so they meet only when clamped together: side by side, left first.
  if (on('left') && on('right') && nearX('left', 'right')) {
    p.right.x = Math.min(Math.max(p.right.x, p.left.x + L.w + gap), right - R.w)
    p.left.x = Math.max(safe.x, Math.min(p.left.x, p.right.x - gap - L.w))
  }
  const sides = (['left', 'right'] as const).filter(on)
  const t = on('top')
  const b = on('bottom')
  const tb = t && b && nearX('top', 'bottom')
  // Out from the square: the top above the sides it would touch, the bottom below them.
  for (const s of sides) {
    if (t && nearX('top', s)) p.top.y = Math.min(p.top.y, p[s].y - gap - T.h)
    if (b && nearX('bottom', s)) p.bottom.y = Math.max(p.bottom.y, p[s].y + sizes[s].h + gap)
  }
  // Down from the safe top: a top block stopped there pushes the sides down, and they the bottom.
  if (t) p.top.y = Math.max(p.top.y, safe.y)
  for (const s of sides) if (t && nearX('top', s)) p[s].y = Math.max(p[s].y, p.top.y + T.h + gap)
  if (tb) p.bottom.y = Math.max(p.bottom.y, p.top.y + T.h + gap)
  for (const s of sides) if (b && nearX('bottom', s)) p.bottom.y = Math.max(p.bottom.y, p[s].y + sizes[s].h + gap)
  // Up from the safe bottom: the same the other way.
  if (b) p.bottom.y = Math.min(p.bottom.y, bottom - B.h)
  for (const s of sides) {
    p[s].y = Math.min(p[s].y, bottom - sizes[s].h)
    if (b && nearX('bottom', s)) p[s].y = Math.min(p[s].y, p.bottom.y - gap - sizes[s].h)
  }
  if (t) {
    p.top.y = Math.min(p.top.y, bottom - T.h)
    for (const s of sides) if (nearX('top', s)) p.top.y = Math.min(p.top.y, p[s].y - gap - T.h)
    if (tb) p.top.y = Math.min(p.top.y, p.bottom.y - gap - T.h)
  }
  return p
}

const NO_DERIVED: ReadonlySet<keyof FlightData> = new Set()
const AGL_DERIVED: ReadonlySet<keyof FlightData> = new Set(['aglFt'])
export const AGL_SHOWN_BELOW_FT = 15_000

/**
 * The frame's data in live chase: the drawn state for altitude, vertical speed, speed and track, and what the aircraft
 * broadcasts in the chase reply for the rest (airspeed, heading, roll, wind: Mode S enhanced surveillance, when it
 * does). s.rollDeg and s.pitchDeg are never shown: they are synthesised for drawing. aglFt (the app's ground under the
 * aircraft) is an estimate.
 */
export function liveFlightData(s: RenderState, raw: ReadsbAircraft | null, aglFt: number | null): FlightData {
  const n = (v: number | undefined): number | null => (fin(v) ? v : null)
  return {
    altFt: s.altBaroFt, aglFt, vsFpm: s.vsFpm, iasKt: n(raw?.ias), gsKt: s.gsKt, hdgDeg: n(raw?.true_heading),
    trackDeg: s.trackDeg, pitchDeg: null, rollDeg: n(raw?.roll), g: null, windFromDeg: n(raw?.wd), windKt: n(raw?.ws),
    gear: null, flaps: null, epr: null, derived: aglFt === null ? NO_DERIVED : AGL_DERIVED,
  }
}

/** The text and glyph angles of every block for d. Unknown (null) values are left out; a block left with nothing is empty. */
export function formatBlocks(d: FlightData): Record<BlockId, BlockView> {
  const est = (k: keyof FlightData): boolean => d.derived.has(k)
  const f = (key: keyof FlightData, label: string, value: string, unit: string): Field => ({ key, label, value, unit, est: est(key) })
  const view = (rows: Field[][], more: Partial<BlockView> = {}): BlockView => ({ rows, wind: null, horizon: null, bars: null, chips: [], ...more })

  const left: Field[][] = []
  if (fin(d.altFt)) left.push([{ ...f('altFt', '', num(by10(d.altFt)), 'ft'), big: true }])
  // Height above the ground only where the ground matters: high up it reads as noise (over the sea a geometric AGL even
  // tops the barometric ALT above it).
  if (fin(d.aglFt) && d.aglFt < AGL_SHOWN_BELOW_FT) left.push([f('aglFt', 'AGL', num(by10(Math.max(0, d.aglFt))), 'ft')])
  if (fin(d.vsFpm)) {
    const v = by10(d.vsFpm)
    left.push([f('vsFpm', '', Math.abs(d.vsFpm) < LEVEL_FPM ? '0' : `${v > 0 ? '↑' : '↓'} ${num(Math.abs(v))}`, 'fpm')])
  }

  const right: Field[][] = []
  if (fin(d.iasKt)) right.push([f('iasKt', 'IAS', num(d.iasKt), 'kt')])
  if (fin(d.gsKt)) right.push([f('gsKt', 'GS', num(d.gsKt), 'kt')])
  const bars = d.epr !== null && d.epr.length > 0
    ? {
        bars: d.epr.map((e, i) => ({ label: String(i + 1), frac: fin(e) ? Math.round(clamp((e - EPR_MIN) / (EPR_MAX - EPR_MIN), 0, 1) * 1000) / 1000 : null })),
        est: est('epr'),
      }
    : null

  // The dial's nose is the heading; without one, the track (the nose within a few degrees of drift): an estimate.
  const top: Field[] = []
  if (fin(d.hdgDeg)) top.push(f('hdgDeg', 'HDG', deg3(d.hdgDeg), ''))
  else if (fin(d.trackDeg)) top.push(f('trackDeg', 'TRK', deg3(d.trackDeg), ''))
  const nose = fin(d.hdgDeg) ? d.hdgDeg : fin(d.trackDeg) ? d.trackDeg : null
  let wind: BlockView['wind'] = null
  if (fin(d.windFromDeg) && fin(d.windKt)) {
    const windEst = est('windFromDeg') || est('windKt')
    if (Math.round(d.windKt) === 0) top.push({ key: 'wind', label: '', value: 'Calm', unit: '', est: windEst })
    else {
      top.push({ key: 'wind', label: '', value: `${deg3(d.windFromDeg)}/${num(d.windKt)}`, unit: 'kt', est: windEst })
      if (nose !== null) wind = { deg: Math.round(rel180(d.windFromDeg - nose)) || 0, est: windEst || !fin(d.hdgDeg) || est('hdgDeg') }
    }
  }

  const attitude: Field[] = []
  if (fin(d.rollDeg)) {
    const r = Math.round(d.rollDeg) || 0
    attitude.push(f('rollDeg', 'Bank', `${Math.abs(r)}°${r > 0 ? ' R' : r < 0 ? ' L' : ''}`, ''))
  }
  if (fin(d.pitchDeg)) {
    const p = Math.round(d.pitchDeg) || 0
    attitude.push(f('pitchDeg', 'Pitch', `${p > 0 ? '+' : p < 0 ? MINUS : ''}${Math.abs(p)}°`, ''))
  }
  const bottom: Field[][] = attitude.length > 0 ? [attitude] : []
  if (fin(d.g)) {
    const g = Math.abs(d.g).toFixed(1)
    bottom.push([f('g', '', `${d.g < 0 && g !== '0.0' ? MINUS : ''}${g}`, 'g')])
  }
  // The glyph draws level for an unknown angle, so it is dimmed then.
  const horizon = fin(d.rollDeg) || fin(d.pitchDeg)
    ? {
        rotDeg: -(d.rollDeg ?? 0) || 0,
        offsetPx: clamp((d.pitchDeg ?? 0) * PITCH_PX, -HORIZON_MAX_PX, HORIZON_MAX_PX) || 0,
        est: !fin(d.rollDeg) || !fin(d.pitchDeg) || est('rollDeg') || est('pitchDeg'),
      }
    : null
  // Configuration shows when it is out of the clean cruise state: gear down, flaps out.
  const chips: Chip[] = []
  if (d.gear === 'down') chips.push({ key: 'gear', text: 'GEAR DN', est: est('gear') })
  if (fin(d.flaps) && Math.round(d.flaps) > 0) chips.push({ key: 'flaps', text: `FLAPS ${Math.round(d.flaps)}`, est: est('flaps') })

  return {
    left: view(left),
    right: view(right, { bars }),
    top: view(top.length > 0 ? [top] : [], { wind }),
    bottom: view(bottom, { horizon, chips }),
  }
}

// ---- DOM ------------------------------------------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg'

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  return e
}

/** The tile's label when the field has none of its own: the altitude, vertical speed, g and wind read by their figures. */
const TILE_LABEL: Readonly<Record<string, string>> = { altFt: 'Alt', vsFpm: 'V/S', g: 'Load', wind: 'Wind' }

/**
 * One quantity as a tile, the flight card's stat style: the figure over a small caps label with the unit ("ALT ft"). The
 * text reads whole for copy and screen readers ("11,850 AGL ft").
 */
function fieldEl(f: Field): HTMLDivElement {
  const tile = h('div', `fh-ft${f.big ? ' fh-big' : ''}${f.est ? ' fh-est' : ''}`)
  tile.dataset.key = f.key
  const label = h('div', 'fh-ft-l', f.label || TILE_LABEL[f.key] || '')
  if (f.unit !== '') label.append(' ', h('span', 'fh-ft-u', f.unit))
  tile.append(h('div', 'fh-ft-v', f.value), label)
  return tile
}

/** A row of tiles. */
function rowEl(fields: readonly Field[]): HTMLDivElement {
  const row = h('div', 'fh-frow')
  row.append(...fields.map(fieldEl))
  return row
}

/** The wind dial, 18 px: a ring, a small aircraft nose-up in the middle, and the arrow blowing in from the wind's side. */
function dialEl(): { root: SVGSVGElement; arrow: SVGGElement } {
  const root = svg('svg', { class: 'fh-dial', viewBox: '0 0 18 18', width: 18, height: 18, 'aria-hidden': 'true' })
  const arrow = svg('g', { class: 'fh-dial-arrow' })
  arrow.append(svg('path', { d: 'M9 0.7V5.3' }), svg('path', { d: 'M7.1 3.5L9 5.5L10.9 3.5' }))
  root.append(
    svg('circle', { class: 'fh-dial-ring', cx: 9, cy: 9, r: 8.3 }),
    svg('path', { class: 'fh-dial-ac', d: 'M9 7V11.7M6.6 9.2H11.4M8 11.3H10' }),
    arrow,
  )
  return { root, arrow }
}

/** The horizon glyph, 28 px: sky over ground (with ±10° pitch marks) that rolls and pitches behind a fixed aircraft symbol. */
function horizonEl(): { root: HTMLDivElement; world: HTMLDivElement } {
  const root = h('div', 'fh-hz')
  const world = h('div', 'fh-hz-w')
  const w = svg('svg', { viewBox: '-40 -40 80 80', width: 80, height: 80, 'aria-hidden': 'true' })
  const mark = (y: number, half: number): SVGPathElement => svg('path', { class: 'fh-hz-mark', d: `M${-half} ${y}H${half}` })
  w.append(
    svg('rect', { class: 'fh-hz-sky', x: -40, y: -40, width: 80, height: 40 }),
    svg('rect', { class: 'fh-hz-gnd', x: -40, y: 0, width: 80, height: 40 }),
    mark(-10 * PITCH_PX, 3.5),
    mark(10 * PITCH_PX, 3.5),
    svg('path', { class: 'fh-hz-line', d: 'M-40 0H40' }),
  )
  world.append(w)
  const ac = svg('svg', { class: 'fh-hz-ac', viewBox: '-14 -14 28 28', width: 28, height: 28, 'aria-hidden': 'true' })
  ac.append(svg('path', { d: 'M-8.5 0H-3.5L-2 1.6M8.5 0H3.5L2 1.6' }), svg('circle', { cx: 0, cy: 0, r: 0.9 }))
  root.append(world, ac)
  return { root, world }
}

const ZERO = (): { w: number; h: number } => ({ w: 0, h: 0 })

/**
 * The frame in the DOM, in layer (a .fh-frame div the app creates over the globe). update() each frame after the
 * camera moved; draw() is the same without Cesium (the harness drives it with a square of its own). Each block keeps
 * its glyphs attached and rebuilds only its text slots: a detached element loses its style, and with it the transition
 * that smooths the 10 Hz steps.
 * ponytail: the frame does not hide when terrain hides the aircraft, only behind the camera (as the traffic brackets).
 * Upgrade: a depth test under the square's centre.
 */
export class FlightFrame {
  readonly #bracket = h('div', 'fh-bracket')
  readonly #blocks: Record<BlockId, HTMLDivElement>
  readonly #sizes: Record<BlockId, { w: number; h: number }> = { left: ZERO(), right: ZERO(), top: ZERO(), bottom: ZERO() }
  readonly #keys: Record<BlockId, string> = { left: '', right: '', top: '', bottom: '' }
  // Text slots, rebuilt when their text changes, beside the glyphs, which stay attached (their transitions smooth the
  // 10 Hz steps).
  readonly #leftTop = h('div', 'fh-frow') // the altitude
  readonly #leftRow = h('div', 'fh-frow') // height above ground, vertical speed
  readonly #rightRow = h('div', 'fh-frow') // airspeed, ground speed
  readonly #epr = h('div', 'fh-ft fh-ft-epr') // thrust: one bar per engine
  readonly #bars = h('div', 'fh-bars')
  readonly #fills: HTMLDivElement[] = []
  readonly #nav = h('div', 'fh-fslot') // heading (or track)
  readonly #windTile = h('div', 'fh-ft fh-ft-wind')
  readonly #windText = h('span', 'fh-ft-wv')
  readonly #windLabel = h('div', 'fh-ft-l')
  readonly #dial = dialEl()
  readonly #hz = horizonEl()
  readonly #hzTile = h('div', 'fh-ft fh-ft-hz')
  readonly #att = h('div', 'fh-frow') // bank, pitch, g
  readonly #chips = h('div', 'fh-fchips') // GEAR DN, FLAPS 10
  readonly #sq: Square = { x: 0, y: 0, side: 0 }
  readonly #c = new Cartesian3()
  readonly #v = new Cartesian3()
  readonly #bc = new Cartesian3()
  readonly #w = new Cartesian2()
  #textAt = -Infinity
  #shown = false

  constructor(layer: HTMLElement) {
    this.#bracket.hidden = true
    const blocks = {} as Record<BlockId, HTMLDivElement>
    for (const id of IDS) {
      const b = (blocks[id] = h('div', 'fh-fblock'))
      b.dataset.block = id
      b.hidden = true
    }
    const eprLabel = h('div', 'fh-ft-l', 'Thrust')
    eprLabel.append(' ', h('span', 'fh-ft-u', 'EPR'))
    this.#epr.append(this.#bars, eprLabel)
    blocks.left.append(this.#leftTop, this.#leftRow)
    blocks.right.append(this.#rightRow, this.#epr)
    const windV = h('div', 'fh-ft-v')
    windV.append(this.#dial.root, this.#windText)
    this.#windTile.append(windV, this.#windLabel)
    const topRow = h('div', 'fh-frow')
    topRow.append(this.#nav, this.#windTile)
    blocks.top.append(topRow) // HDG 250° · (dial) 220°/16 WIND kt
    this.#hzTile.append(this.#hz.root)
    const bottomRow = h('div', 'fh-frow')
    bottomRow.append(this.#hzTile, this.#att)
    blocks.bottom.append(bottomRow, this.#chips) // (horizon) BANK · PITCH · LOAD, then GEAR DN FLAPS 10
    this.#blocks = blocks
    layer.append(this.#bracket, ...IDS.map((id) => blocks[id]))
  }

  /**
   * The frame around the chased model this frame: its square from the manifest box through modelMatrix (which carries
   * entry.scale), as Traffic.update projects a traffic model's. data null, or the model behind the camera: hidden.
   */
  update(viewer: Viewer, modelMatrix: Matrix4, entry: ModelManifestEntry, data: FlightData | null, safe: Rect): void {
    this.draw(data === null ? null : this.#square(viewer, modelMatrix, entry), data, safe)
  }

  /** The frame around sq (null: hidden) showing data, its blocks inside safe. Hidden too when sq is outside safe. */
  draw(sq: Square | null, data: FlightData | null, safe: Rect, nowMs = performance.now()): void {
    const r = sq === null ? 0 : sq.side / 2
    if (sq === null || data === null || sq.x + r < safe.x || sq.x - r > safe.x + safe.w || sq.y + r < safe.y || sq.y - r > safe.y + safe.h) {
      if (this.#shown) {
        this.#bracket.hidden = true
        for (const id of IDS) {
          this.#blocks[id].hidden = true
          this.#keys[id] = '' // shown again: filled and measured again
        }
        this.#shown = false
      }
      return
    }
    if (!this.#shown || nowMs - this.#textAt >= TEXT_MS) {
      this.#text(formatBlocks(data))
      this.#textAt = nowMs
    }
    this.#shown = true
    const side = Math.round(sq.side)
    const br = this.#bracket
    br.style.width = br.style.height = `${side}px`
    br.style.transform = `translate3d(${(sq.x - side / 2).toFixed(1)}px, ${(sq.y - side / 2).toFixed(1)}px, 0)`
    br.hidden = false
    const at = frameLayout(sq, this.#sizes, safe)
    for (const id of IDS) {
      const b = this.#blocks[id]
      if (!b.hidden) b.style.transform = `translate3d(${Math.round(at[id].x)}px, ${Math.round(at[id].y)}px, 0)` // whole px: crisp text
    }
  }

  destroy(): void {
    this.#bracket.remove()
    for (const id of IDS) this.#blocks[id].remove()
    this.#shown = false
  }

  #square(viewer: Viewer, modelMatrix: Matrix4, entry: ModelManifestEntry): Square | null {
    const scene = viewer.scene
    const cam = scene.camera
    const fovy = (cam.frustum as PerspectiveFrustum).fovy ?? CesiumMath.PI_OVER_THREE // undefined before the first render
    const bc = entry.box ? Cartesian3.fromArray(entry.box.centre, 0, this.#bc) : BOX_CENTRE
    const c = Matrix4.multiplyByPoint(modelMatrix, bc, this.#c)
    const depthM = Cartesian3.dot(Cartesian3.subtract(c, cam.positionWC, this.#v), cam.directionWC)
    if (!(depthM > 1)) return null // behind the camera
    const w = SceneTransforms.worldToWindowCoordinates(scene, c, this.#w)
    if (w === undefined) return null
    this.#sq.x = w.x
    this.#sq.y = w.y
    this.#sq.side = squarePx((entry.box?.half ?? BOX_HALF) * entry.scale, depthM, fovy, scene.canvas.clientHeight)
    return this.#sq
  }

  /** Refills the blocks whose text changed and measures them (one layout for all); glyph angles on every call. */
  #text(views: Record<BlockId, BlockView>): void {
    const changed: BlockId[] = []
    for (const id of IDS) {
      const v = views[id]
      // What sets the block's size: its text and which glyphs it has. Angles, bar heights and dimming do not.
      const key = JSON.stringify([v.rows, v.chips, v.wind !== null, v.horizon !== null, v.bars?.bars.length ?? 0])
      if (key === this.#keys[id]) continue
      this.#keys[id] = key
      changed.push(id)
      const empty = isEmpty(v)
      this.#blocks[id].hidden = empty
      if (!empty) this.#fill(id, v)
    }
    this.#glyphs(views)
    for (const id of changed) {
      const b = this.#blocks[id]
      this.#sizes[id] = b.hidden ? ZERO() : { w: b.offsetWidth, h: b.offsetHeight }
    }
  }

  #fill(id: BlockId, v: BlockView): void {
    const fields = v.rows.flat()
    if (id === 'left') {
      // The altitude on its own row, the rest beside each other under it.
      const [first, ...rest] = v.rows
      this.#leftTop.replaceChildren(...(first ?? []).map(fieldEl))
      this.#leftRow.replaceChildren(...rest.flat().map(fieldEl))
      this.#leftRow.hidden = rest.length === 0
    } else if (id === 'right') {
      this.#rightRow.replaceChildren(...fields.map(fieldEl))
      this.#rightRow.hidden = fields.length === 0
      this.#epr.hidden = v.bars === null
      if (v.bars !== null && v.bars.bars.length !== this.#fills.length) this.#buildBars(v.bars.bars)
    } else if (id === 'top') {
      const nav = fields.find((f) => f.key !== 'wind')
      const wind = fields.find((f) => f.key === 'wind')
      this.#nav.replaceChildren(...(nav ? [fieldEl(nav)] : []))
      this.#nav.hidden = nav === undefined
      this.#windTile.hidden = wind === undefined
      if (wind !== undefined) {
        this.#windTile.classList.toggle('fh-est', wind.est)
        this.#windText.textContent = wind.value
        this.#windLabel.replaceChildren('Wind', ...(wind.unit === '' ? [] : [' ', h('span', 'fh-ft-u', wind.unit)]))
      }
      this.#dial.root.style.display = v.wind === null ? 'none' : ''
    } else {
      this.#hzTile.hidden = v.horizon === null
      this.#att.replaceChildren(...fields.map(fieldEl))
      this.#att.hidden = fields.length === 0
      this.#chips.replaceChildren(
        ...v.chips.map((c) => {
          const chip = h('span', `fh-chip${c.est ? ' fh-est' : ''}`, c.text)
          chip.dataset.chip = c.key
          return chip
        }),
      )
      this.#chips.hidden = v.chips.length === 0
    }
  }

  /** The wind arrow, the horizon and the thrust bars at this call's angles (their transitions fill the 10 Hz steps). */
  #glyphs(views: Record<BlockId, BlockView>): void {
    const wind = views.top.wind
    if (wind !== null) {
      this.#dial.arrow.setAttribute('transform', `rotate(${wind.deg} 9 9)`)
      this.#dial.root.classList.toggle('fh-est', wind.est)
    }
    const hz = views.bottom.horizon
    if (hz !== null) {
      this.#hz.world.style.transform = `rotate(${hz.rotDeg.toFixed(1)}deg) translateY(${hz.offsetPx.toFixed(1)}px)`
      this.#hz.root.classList.toggle('fh-est', hz.est)
    }
    const bars = views.right.bars
    if (bars !== null && bars.bars.length === this.#fills.length) {
      this.#epr.classList.toggle('fh-est', bars.est)
      bars.bars.forEach((bar, i) => {
        const fill = this.#fills[i]
        fill.style.height = `${((bar.frac ?? 0) * 100).toFixed(1)}%`
        fill.parentElement!.classList.toggle('fh-na', bar.frac === null)
      })
    }
  }

  /** EPR, one bar per engine on a 1.0–2.0 scale, numbered from the left wingtip. */
  #buildBars(bars: readonly Bar[]): void {
    this.#fills.length = 0
    this.#bars.replaceChildren(
      ...bars.map((bar) => {
        const fill = h('div', 'fh-bar-f')
        const track = h('div', 'fh-bar-t')
        track.append(fill)
        this.#fills.push(fill)
        const cell = h('div', 'fh-bar')
        cell.append(track, h('span', 'fh-bar-l', bar.label))
        return cell
      }),
    )
  }
}

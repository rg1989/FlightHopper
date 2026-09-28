// client/scene/flightFrame.ts
// The flight-data frame (.planning/scenarios-design.md §5): the traffic's two corner brackets around the chased
// aircraft, and four glass blocks of instruments around them, glass-cockpit style: on the left an altitude tape with the
// vertical-speed scale and the height above the ground; on the right an airspeed tape (ground speed without one) and the
// ground speed; on top a heading tape with the wind; below, the attitude indicator (the horizon and the aircraft against
// it), bank, pitch, load factor, gear and flaps, and the engines' thrust under them. One component for live chase
// (liveFlightData: what ADS-B broadcasts and the drawn state) and scenarios (the track's FlightData). Every instrument
// moves every frame, smoothly (transforms only); its figures change at most every TEXT_MS, but the tapes' readouts roll
// every frame, and the speed tape's trend arrow points at the speed 10 s ahead. frameLayout (pure) places the blocks
// round the aircraft, never over it.
import { Cartesian2, Cartesian3, Math as CesiumMath, Matrix4, SceneTransforms } from 'cesium'
import type { PerspectiveFrustum, Viewer } from 'cesium'
import type { ReadsbAircraft } from '../../shared/types.ts'
import type { FlightData, ModelManifestEntry, RenderState } from '../types.ts'
import { ALT_TAPE, Adi, ArcGauge, EPR_GAUGE, G_GAUGE, HeadingTape, SPEED_TAPE, Tape, Vsi, WindDial, h, move, say, show } from '../ui/instruments.ts'
import { Glide, TREND_S, Trend, rel180, trendShown } from './instrumentMath.ts'
import { BOX_CENTRE, BOX_HALF, squarePx } from './traffic.ts'
import '../ui/flightFrame.css'

/** A rectangle in CSS px from the canvas's top-left. */
export interface Rect { x: number; y: number; w: number; h: number }
/** The bracket square: centre and side, CSS px from the canvas's top-left. */
export interface Square { x: number; y: number; side: number }
export type BlockId = 'left' | 'right' | 'top' | 'bottom'

export const TEXT_MS = 100 // figures at most 10 times a second: steadier to read (the instruments themselves move every frame)
export const AGL_SHOWN_BELOW_FT = 15_000
const LEVEL_FPM = 50 // within this a vertical speed reads 0, without an arrow (ADS-B rates come in 64 fpm steps)
const TRACK_DIAMOND_DEG = 1 // the track diamond shows once the track is this far off the heading
const MINUS = '−' // the typographic minus: the width of the plus sign, not a hyphen's
const IDS: readonly BlockId[] = ['left', 'right', 'top', 'bottom']

const fin = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v)

// ---- layout ---------------------------------------------------------------------------------------------------------

/**
 * A block's size in one of its variants (the full one, then smaller ones), and its anchor: the point that lines up with
 * the square's centre, x for a block above or below it, y for one beside it (the tapes' readouts level with the
 * aircraft, the attitude indicator under it). Default: the block's centre.
 */
export interface BlockSize { w: number; h: number; ax?: number; ay?: number }
/** Where a block went: its top-left, the side of the square it is on (its own, or another), and which variant. */
export interface Placed { x: number; y: number; side: BlockId; v: number }
/** Coming home from another side, or growing back to a larger variant, takes this much room to spare: no flicker. */
export const HYST_PX = 16

interface Box { x0: number; y0: number; x1: number; y1: number }
interface Cand { x: number; y: number; cost: number }
const EPS = 1e-6
// Where a block with no room on its own side goes, in order, and the detour (px) each is charged.
const AWAY: Record<BlockId, ReadonlyArray<readonly [BlockId, number]>> = {
  left: [['right', 0], ['bottom', 40], ['top', 80]],
  right: [['left', 0], ['bottom', 40], ['top', 80]],
  top: [['bottom', 0], ['right', 40], ['left', 40]],
  bottom: [['top', 0], ['right', 40], ['left', 40]],
}
const AWAY_ORDER: readonly BlockId[] = ['left', 'right', 'bottom', 'top'] // altitude, speed, attitude, heading
const VARIANT_PX = 60 // away from home, a smaller variant is charged as this much detour
const SLIDE_COST = 1.5 // a px along the side (out of line with the aircraft) costs this much more than a px out from it
const STAY_PX = 30 // away from home, the place it had last frame is kept over one up to this much better

/** The position nearest pref of a segment len long in [lo, hi], clear of every blocked (open) interval; null: none. */
function slide(pref: number, len: number, lo: number, hi: number, blocked: ReadonlyArray<readonly [number, number]>): number | null {
  if (hi - lo < len - EPS) return null
  const cands = [Math.min(Math.max(pref, lo), hi - len), lo, hi - len]
  for (const [a, b] of blocked) cands.push(a - len, b)
  let best: number | null = null
  for (const p of cands) {
    if (p < lo - EPS || p + len > hi + EPS) continue
    if (blocked.some(([a, b]) => p + len > a + EPS && p < b - EPS)) continue
    if (best === null || Math.abs(p - pref) < Math.abs(best - pref)) best = p
  }
  return best
}

/**
 * The best place for a block of size b on one side of the square S: against it at the gap, or out beyond a block already
 * there (each such level is tried), slid along the side to its anchor's line as near as the safe area and the other
 * blocks allow. Cost: how far out, plus SLIDE_COST × how far along (out of line with the aircraft). extra: room to spare
 * it needs at the safe area's far edge.
 */
function onSide(side: BlockId, b: BlockSize, sq: Square, S: Box, taken: readonly Box[], safe: Rect, gap: number, extra: number): Cand | null {
  const alongX = side === 'top' || side === 'bottom' // above or below the square it slides along x
  const len = alongX ? b.w : b.h
  const dep = alongX ? b.h : b.w
  const pref = alongX ? sq.x - (b.ax ?? b.w / 2) : sq.y - (b.ay ?? b.h / 2)
  const lo = alongX ? safe.x : safe.y
  const hi = alongX ? safe.x + safe.w : safe.y + safe.h
  const oLo = alongX ? safe.y : safe.x
  const oHi = alongX ? safe.y + safe.h : safe.x + safe.w
  const q = (t: Box): [number, number, number, number] => (alongX ? [t.y0, t.y1, t.x0, t.x1] : [t.x0, t.x1, t.y0, t.y1])
  const out = side === 'left' || side === 'top' ? -1 : 1
  const [s0, s1] = q(S)
  const e0 = out < 0 ? s0 - gap : s1 + gap // the block's edge facing the square
  const levels = [e0]
  for (const t of taken) {
    const [t0, t1] = q(t)
    const e = out < 0 ? t0 - gap : t1 + gap
    if (out < 0 ? e < e0 : e > e0) levels.push(e)
  }
  const boxes = [S, ...taken]
  let best: Cand | null = null
  for (const e of levels) {
    const u0 = out < 0 ? e - dep : e
    if (u0 < oLo + (out < 0 ? extra : 0) - EPS || u0 + dep > oHi - (out > 0 ? extra : 0) + EPS) continue
    const blocked: Array<[number, number]> = []
    for (const t of boxes) {
      const [t0, t1, t2, t3] = q(t)
      if (t0 - gap < u0 + dep - EPS && u0 < t1 + gap - EPS) blocked.push([t2 - gap, t3 + gap])
    }
    const s = slide(pref, len, lo, hi, blocked)
    if (s === null) continue
    const cost = Math.abs(e - e0) + SLIDE_COST * Math.abs(s - pref)
    if (best === null || cost < best.cost - EPS) best = alongX ? { x: s, y: u0, cost } : { x: u0, y: s, cost }
  }
  return best
}

/**
 * Where each block goes round the square sq, inside `safe`, never over the square (the aircraft) and never over another
 * block: each keeps the gap to both. A block hugs its own side of the square at `gap`, its anchor on the square's centre
 * line, sliding along that side as the safe area and the blocks placed before it require (the top and bottom blocks go
 * out past side blocks taller than the square). With no room on its own side a block takes its smaller variant there,
 * else goes to another side (the altitude beyond the speed, the heading under the attitude…), else it is hidden (null):
 * a square larger than the safe area hides them all. sizes: each block's variants (0 × 0, or none: hidden). prev: the
 * last frame's placement, for hysteresis: a block that went away comes home, or grows back, only with HYST_PX to spare.
 */
export function frameLayout(
  sq: Square,
  sizes: Record<BlockId, BlockSize | readonly BlockSize[]>,
  safe: Rect,
  gap = 10,
  prev?: Partial<Record<BlockId, Placed | null>>,
): Record<BlockId, Placed | null> {
  const r = sq.side / 2
  const S: Box = { x0: sq.x - r, y0: sq.y - r, x1: sq.x + r, y1: sq.y + r }
  const out: Record<BlockId, Placed | null> = { left: null, right: null, top: null, bottom: null }
  const taken: Box[] = []
  const variants = (id: BlockId): Array<{ b: BlockSize; v: number }> => {
    const s = sizes[id]
    const list: readonly BlockSize[] = Array.isArray(s) ? s : [s as BlockSize]
    return list.map((b, v) => ({ b, v })).filter(({ b }) => b.w > 0 && b.h > 0)
  }
  const put = (id: BlockId, c: Cand, side: BlockId, v: number, b: BlockSize): void => {
    out[id] = { x: c.x, y: c.y, side, v }
    taken.push({ x0: c.x, y0: c.y, x1: c.x + b.w, y1: c.y + b.h })
  }
  // Home first, every block, the largest variant that fits.
  for (const id of IDS) {
    const p = prev?.[id]
    for (const { b, v } of variants(id)) {
      const extra = p === null || (p !== undefined && (p.side !== id || v < p.v)) ? HYST_PX : 0
      const c = onSide(id, b, sq, S, taken, safe, gap, extra)
      if (c !== null) {
        put(id, c, id, v, b)
        break
      }
    }
  }
  // Then the ones with no room at home, elsewhere.
  for (const id of AWAY_ORDER) {
    if (out[id] !== null) continue
    const p = prev?.[id]
    let best: { c: Cand; side: BlockId; v: number; b: BlockSize; cost: number } | null = null
    for (const { b, v } of variants(id)) {
      for (const [side, detour] of AWAY[id]) {
        const c = onSide(side, b, sq, S, taken, safe, gap, 0)
        if (c === null) continue
        const cost = c.cost + detour + VARIANT_PX * v - (p != null && p.side === side && p.v === v ? STAY_PX : 0)
        if (best === null || cost < best.cost - EPS) best = { c, side, v, b, cost }
      }
    }
    if (best !== null) put(id, best.c, best.side, best.v, best.b)
  }
  return out
}

// ---- data -----------------------------------------------------------------------------------------------------------

const LIVE_DERIVED: ReadonlySet<keyof FlightData> = new Set(['pitchDeg', 'rollDeg'])
const LIVE_DERIVED_AGL: ReadonlySet<keyof FlightData> = new Set(['pitchDeg', 'rollDeg', 'aglFt'])
const LIVE_DERIVED_GEAR: ReadonlySet<keyof FlightData> = new Set(['pitchDeg', 'rollDeg', 'gear'])
const LIVE_DERIVED_AGL_GEAR: ReadonlySet<keyof FlightData> = new Set(['pitchDeg', 'rollDeg', 'aglFt', 'gear'])

/**
 * The frame's data in live chase: the drawn state for altitude, vertical speed, speed, heading, track and attitude, and
 * what the aircraft broadcasts in the chase reply for the rest (wind: Mode S enhanced surveillance, when it does). The
 * altitude is the smoothed height the aircraft is drawn at (the sample's barometric figure only without one), so ALT −
 * AGL is the ground under it; the airspeed the track's average of the broadcast one. The heading and attitude are the
 * drawn ones, the 3-D model's, so the instruments and the model agree: the heading while the aircraft reports one (the
 * track + its averaged crab), the attitude synthesised from the path, so an estimate; aglFt (the app's ground under the
 * aircraft) is one too. One line per field: each is the one place its source is chosen.
 */
export function liveFlightData(s: RenderState, raw: ReadsbAircraft | null, aglFt: number | null, gear: FlightData['gear'] = null): FlightData {
  const n = (v: number | undefined): number | null => (fin(v) ? v : null)
  return {
    altFt: s.altMslFt ?? s.altBaroFt,
    aglFt,
    vsFpm: s.vsFpm,
    iasKt: s.iasKt ?? n(raw?.ias),
    gsKt: s.gsKt,
    hdgDeg: fin(raw?.true_heading) ? s.headingDeg : null,
    trackDeg: s.trackDeg,
    pitchDeg: s.pitchDeg,
    rollDeg: s.rollDeg,
    g: null,
    windFromDeg: n(raw?.wd),
    windKt: n(raw?.ws),
    gear, // the drawn gear (gear.ts), as a crew would have it: an estimate
    flaps: null,
    epr: null,
    derived: gear === null ? (aglFt === null ? LIVE_DERIVED : LIVE_DERIVED_AGL) : aglFt === null ? LIVE_DERIVED_GEAR : LIVE_DERIVED_AGL_GEAR,
  }
}

/** One quantity an instrument shows: its value, and whether it is an estimate (drawn dimmer). */
export interface Reading { value: number; est: boolean }

/**
 * What the instruments show for one FlightData: null where nothing is known (the instrument is hidden: no fake zeros).
 * The speed tape shows the airspeed, else the ground speed (never a missing airspeed as 0); the heading tape the heading,
 * else the track.
 */
export interface FrameView {
  alt: Reading | null
  agl: Reading | null // below AGL_SHOWN_BELOW_FT only, never below 0
  vs: Reading | null
  speed: (Reading & { kind: 'IAS' | 'GS' }) | null // the tape
  gs: Reading | null // the ground speed beside an airspeed tape
  hdg: (Reading & { kind: 'HDG' | 'TRK' }) | null // the tape: the heading, else the track (an estimate of the nose)
  track: Reading | null // the track diamond on the heading tape, once it differs from the heading by TRACK_DIAMOND_DEG
  // rel: where it comes from, clockwise from the nose; null: calm, or no nose.
  wind: { fromDeg: number; kt: number; est: boolean; rel: { deg: number; est: boolean } | null } | null
  roll: Reading | null
  pitch: Reading | null
  adi: { est: boolean } | null // the attitude indicator: with either angle, an estimate without both
  g: Reading | null
  epr: { values: ReadonlyArray<number | null>; est: boolean } | null // one per engine, null unknown
  gear: { est: boolean } | null // down
  flaps: Reading | null // out
}

export function frameView(d: FlightData): FrameView {
  const est = (k: keyof FlightData): boolean => d.derived.has(k)
  const read = (k: keyof FlightData, v: number | null | undefined): Reading | null => (fin(v) ? { value: v, est: est(k) } : null)
  const gs = read('gsKt', d.gsKt)
  // An airspeed of 0 or less is no airspeed (a transponder's empty field, or at rest on the ground): the ground speed.
  const speed = fin(d.iasKt) && d.iasKt > 0
    ? { value: d.iasKt, est: est('iasKt'), kind: 'IAS' as const }
    : gs !== null ? { ...gs, kind: 'GS' as const } : null
  const hdg = fin(d.hdgDeg)
    ? { value: d.hdgDeg, est: est('hdgDeg'), kind: 'HDG' as const }
    : fin(d.trackDeg) ? { value: d.trackDeg, est: true, kind: 'TRK' as const } : null
  const track = fin(d.hdgDeg) && fin(d.trackDeg) && Math.abs(rel180(d.trackDeg - d.hdgDeg)) >= TRACK_DIAMOND_DEG
    ? { value: d.trackDeg, est: est('trackDeg') }
    : null
  let wind: FrameView['wind'] = null
  if (fin(d.windFromDeg) && fin(d.windKt)) {
    const e = est('windFromDeg') || est('windKt')
    const rel = Math.round(d.windKt) === 0 || hdg === null ? null : { deg: rel180(d.windFromDeg - hdg.value), est: e || hdg.est }
    wind = { fromDeg: d.windFromDeg, kt: d.windKt, est: e, rel }
  }
  const roll = read('rollDeg', d.rollDeg)
  const pitch = read('pitchDeg', d.pitchDeg)
  return {
    alt: read('altFt', d.altFt),
    agl: fin(d.aglFt) && d.aglFt < AGL_SHOWN_BELOW_FT ? { value: Math.max(0, d.aglFt), est: est('aglFt') } : null,
    vs: read('vsFpm', d.vsFpm),
    speed,
    gs: speed?.kind === 'IAS' ? gs : null,
    hdg,
    track,
    wind,
    roll,
    pitch,
    adi: roll !== null || pitch !== null ? { est: roll === null || pitch === null || roll.est || pitch.est } : null,
    g: read('g', d.g),
    epr: d.epr !== null && d.epr.length > 0 ? { values: d.epr.map((e) => (fin(e) ? e : null)), est: est('epr') } : null,
    gear: d.gear === 'down' ? { est: est('gear') } : null,
    flaps: fin(d.flaps) && Math.round(d.flaps) > 0 ? { value: d.flaps, est: est('flaps') } : null,
  }
}

/** Which blocks have anything to show. */
export function blocksShown(v: FrameView): Record<BlockId, boolean> {
  return {
    left: v.alt !== null || v.agl !== null || v.vs !== null,
    right: v.speed !== null,
    top: v.hdg !== null || v.wind !== null,
    bottom: v.adi !== null || v.g !== null || v.gear !== null || v.flaps !== null || v.epr !== null,
  }
}

// ---- text -----------------------------------------------------------------------------------------------------------

/** Whole, thousands separated, a true minus sign: "−1,300". */
const num = (v: number): string => {
  const r = Math.round(v) || 0 // `|| 0` turns −0 into 0
  return `${r < 0 ? MINUS : ''}${Math.abs(r).toLocaleString('en-US')}`
}
/** Altitude to 10 ft: "12,300". */
export const altText = (ft: number): string => num(Math.round(ft / 10) * 10)
/** Speed, whole knots: "140". */
export const speedText = (kt: number): string => num(kt)
/** Vertical speed to 50 fpm (a VSI's digits), with its arrow; within LEVEL_FPM of level "0" and none. */
export function vsText(fpm: number): { arrow: '↑' | '↓' | ''; text: string } {
  if (!(Math.abs(fpm) >= LEVEL_FPM)) return { arrow: '', text: '0' }
  const v = Math.round(fpm / 50) * 50
  return { arrow: v > 0 ? '↑' : '↓', text: num(Math.abs(v)) }
}
/** Three figures, north as 360 (the aviation convention: 001–360). */
export const deg3 = (d: number): string => `${String((((Math.round(d) % 360) + 360) % 360) || 360).padStart(3, '0')}°`
/** Bank with the side of the low wing: "13° R"; wings level "0°". */
export function bankText(rollDeg: number): string {
  const r = Math.round(rel180(rollDeg)) || 0
  return `${Math.abs(r)}°${r > 0 ? ' R' : r < 0 ? ' L' : ''}`
}
/** Pitch with its sign: "+10°", "−3°", "0°". */
export function pitchText(pitchDeg: number): string {
  const r = Math.round(pitchDeg) || 0
  return `${r > 0 ? '+' : r < 0 ? MINUS : ''}${Math.abs(r)}°`
}
/** Wind from/speed ("220°/16", knots), or "Calm". */
export const windText = (fromDeg: number, kt: number): string => (Math.round(kt) === 0 ? 'Calm' : `${deg3(fromDeg)}/${num(kt)}`)
/** Load factor to 0.1 g. */
export function gText(g: number): string {
  const t = Math.abs(g).toFixed(1)
  return `${g < 0 && t !== '0.0' ? MINUS : ''}${t}`
}
/** Engine pressure ratio to 0.01. */
export const eprText = (e: number): string => e.toFixed(2)

// ---- DOM ------------------------------------------------------------------------------------------------------------

const GAP = 10 // between the square and a block, and between blocks
const PHONE = '(max-width: 640px)' // the app's phone layout: the blocks' smaller sizes (flightFrame.css)

/** A small caps label with its unit: "ALT ft". */
function label(text: string | HTMLElement, unit = ''): HTMLSpanElement {
  const l = h('span', 'fh-l')
  l.append(text)
  if (unit !== '') l.append(' ', h('span', 'fh-u', unit))
  return l
}

/** A block's heading line: labels, spread across it. */
function head(...kids: HTMLElement[]): HTMLDivElement {
  const d = h('div', 'fh-bhead')
  d.append(...kids)
  return d
}

/** A figure on a line with its label and unit: "AGL 1,700 ft". */
function line(cls: string, name: string, unit: string): { el: HTMLDivElement; value: HTMLSpanElement } {
  const el = h('div', `fh-line ${cls}`)
  const value = h('span', 'fh-v')
  el.append(h('span', 'fh-l', name), value, h('span', 'fh-u', unit))
  return { el, value }
}

/** A figure under its label: "BANK / 13° R". */
function stat(cls: string, name: string): { el: HTMLDivElement; value: HTMLSpanElement } {
  const el = h('div', `fh-stat ${cls}`)
  const value = h('span', 'fh-v')
  el.append(h('span', 'fh-l', name), value)
  return { el, value }
}

const dim = (el: Element, on: boolean): void => {
  el.classList.toggle('fh-est', on)
}

/**
 * The frame in the DOM, in layer (a .fh-frame div the app creates over the globe). update() each frame after the
 * camera moved; draw() is the same without Cesium (the harness drives it with a square of its own). Every frame each
 * instrument glides to its value (Glide) and moves by transforms only; at most every TEXT_MS the figures, which parts
 * show, and the dimming of estimates are written, and a block whose parts changed is measured again (its full and
 * compact variants, for frameLayout).
 * ponytail: the frame does not hide when terrain hides the aircraft, only behind the camera (as the traffic brackets).
 * Upgrade: a depth test under the square's centre.
 */
export class FlightFrame {
  readonly #bracket = h('div', 'fh-bracket')
  readonly #blocks: Record<BlockId, HTMLDivElement>
  // Left: the altitude tape, the vertical-speed scale and figure, the height above the ground.
  readonly #alt = new Tape(ALT_TAPE, 'alt')
  readonly #vsi = new Vsi()
  readonly #vs = h('span', 'fh-vs')
  readonly #altRow = h('div', 'fh-brow')
  readonly #agl = line('fh-agl', 'AGL', 'ft')
  // Right: the speed tape (airspeed, else ground speed), the ground speed.
  readonly #spd = new Tape(SPEED_TAPE, 'spd')
  readonly #spdKind = h('span', 'fh-k')
  readonly #spdHead = head(label(this.#spdKind, 'kt'))
  readonly #spdRow = h('div', 'fh-brow')
  readonly #gs = line('fh-gs', 'GS', 'kt')
  // Top: the wind, the heading tape.
  readonly #wind = h('div', 'fh-wind')
  readonly #wdial = new WindDial()
  readonly #windText = h('span', 'fh-v')
  readonly #windUnit = h('span', 'fh-u', 'kt')
  readonly #hdgCol = h('div', 'fh-hdgcol')
  readonly #hdgKind = h('span', 'fh-k')
  readonly #hdg = new HeadingTape()
  // Bottom: bank and load factor, the attitude indicator, pitch, gear and flaps; the thrust under them.
  readonly #adi = new Adi()
  readonly #bank = stat('fh-bank', 'Bank')
  readonly #pitch = stat('fh-pitch', 'Pitch')
  readonly #gload = h('div', 'fh-gload')
  readonly #g = new ArcGauge(G_GAUGE)
  readonly #annun = h('div', 'fh-annun')
  readonly #gear = h('span', 'fh-ann', 'GEAR DN')
  readonly #flaps = h('span', 'fh-ann')
  readonly #thrust = h('div', 'fh-thrust')
  readonly #eprs = h('div', 'fh-eprs')
  #eprGauges: ArcGauge[] = []
  // Each moving part glides to its value; the angles unwrapped (a dial never spins the long way round).
  readonly #gl = {
    alt: new Glide(0.25, 2_000),
    vs: new Glide(0.35, 4_000),
    spd: new Glide(0.25, 60),
    gs: new Glide(0.25, 60),
    hdg: new Glide(0.3, 90, true),
    trk: new Glide(0.3, 90, true),
    wind: new Glide(0.4, 120, true),
    roll: new Glide(0.05, 60, true),
    pitch: new Glide(0.05, 20),
    g: new Glide(0.1, 1),
  }
  #epr: Glide[] = []
  #spdSrc: 'IAS' | 'GS' | null = null
  readonly #trend = new Trend() // the speed's rate, on the data's clock
  #trendOn = false
  #dataT: number | null = null
  readonly #phone: MediaQueryList | null
  readonly #sizes: Record<BlockId, BlockSize[]> = { left: [], right: [], top: [], bottom: [] }
  readonly #keys: Record<BlockId, string> = { left: '', right: '', top: '', bottom: '' }
  #has: Record<BlockId, boolean> = { left: false, right: false, top: false, bottom: false }
  #placed: Partial<Record<BlockId, Placed | null>> = {}
  readonly #sq: Square = { x: 0, y: 0, side: 0 }
  readonly #c = new Cartesian3()
  readonly #v = new Cartesian3()
  readonly #bc = new Cartesian3()
  readonly #w = new Cartesian2()
  #textAt = -Infinity
  #lastMs = 0
  #shown = false

  constructor(layer: HTMLElement) {
    this.#phone = typeof matchMedia === 'function' ? matchMedia(PHONE) : null
    this.#bracket.hidden = true
    const blocks = {} as Record<BlockId, HTMLDivElement>
    for (const id of IDS) {
      const b = (blocks[id] = h('div', 'fh-fblock'))
      b.dataset.block = id
      b.dataset.v = '0'
      b.hidden = true
    }
    this.#altRow.append(this.#alt.el, this.#vsi.el)
    blocks.left.append(head(label('Alt', 'ft'), this.#vs), this.#altRow, this.#agl.el)

    this.#spdRow.append(this.#spd.el)
    blocks.right.append(this.#spdHead, this.#spdRow, this.#gs.el)

    const windRow = h('div', 'fh-wind-row')
    windRow.append(this.#wdial.el, this.#windText, this.#windUnit)
    this.#wind.append(head(label('Wind')), windRow)
    this.#hdgCol.append(head(label(this.#hdgKind)), this.#hdg.el)
    blocks.top.append(this.#wind, this.#hdgCol)

    this.#gload.append(label('Load', 'g'), this.#g.el)
    this.#annun.append(this.#gear, this.#flaps)
    this.#gear.dataset.k = 'gear'
    this.#flaps.dataset.k = 'flaps'
    const left = h('div', 'fh-attcol fh-att-l')
    left.append(this.#bank.el, this.#gload)
    const right = h('div', 'fh-attcol fh-att-r')
    right.append(this.#pitch.el, this.#annun)
    const att = h('div', 'fh-attrow')
    att.append(left, this.#adi.el, right)
    // The engines under the attitude, left to right as on the wing.
    const thrustLabel = h('div', 'fh-thrust-l')
    thrustLabel.append(h('span', 'fh-l', 'Thrust'), h('span', 'fh-u', 'EPR'))
    this.#thrust.append(thrustLabel, this.#eprs)
    blocks.bottom.append(att, this.#thrust)

    this.#blocks = blocks
    layer.append(this.#bracket, ...IDS.map((id) => blocks[id]))
  }

  /**
   * The frame around the chased model this frame: its square from the manifest box through modelMatrix (which carries
   * entry.scale), as Traffic.update projects a traffic model's. data null, or the model behind the camera: hidden.
   * dataT: the data's own clock in seconds (a scenario's), for the speed trend; absent: real time (live).
   */
  update(viewer: Viewer, modelMatrix: Matrix4, entry: ModelManifestEntry, data: FlightData | null, safe: Rect, dataT?: number): void {
    this.draw(data === null ? null : this.#square(viewer, modelMatrix, entry), data, safe, performance.now(), dataT)
  }

  /** The frame around sq (null: hidden) showing data, its blocks inside safe. Hidden too when sq is outside safe. */
  draw(sq: Square | null, data: FlightData | null, safe: Rect, nowMs = performance.now(), dataT?: number): void {
    const r = sq === null ? 0 : sq.side / 2
    if (sq === null || data === null || sq.x + r < safe.x || sq.x - r > safe.x + safe.w || sq.y + r < safe.y || sq.y - r > safe.y + safe.h) {
      if (this.#shown) this.#hide()
      return
    }
    // A long pause (a hidden tab) glides all the way: the same as a snap.
    const dt = this.#shown ? Math.min(Math.max((nowMs - this.#lastMs) / 1000, 0), 1) : 0
    this.#lastMs = nowMs
    // The trend's time step: the data's (0 paused, negative after a seek back), else the frame's.
    const dataDt = dataT === undefined ? dt : this.#dataT === null ? 0 : dataT - this.#dataT
    this.#dataT = dataT ?? null
    const v = frameView(data)
    this.#step(v, dt, dataDt)
    if (!this.#shown || nowMs - this.#textAt >= TEXT_MS) {
      this.#text(v)
      this.#textAt = nowMs
    }
    this.#shown = true
    const side = Math.round(sq.side)
    const br = this.#bracket
    const px = `${side}px`
    if (br.style.width !== px) br.style.width = br.style.height = px
    move(br, `translate3d(${(sq.x - side / 2).toFixed(1)}px, ${(sq.y - side / 2).toFixed(1)}px, 0)`)
    show(br, true)
    const at = frameLayout(sq, this.#sizes, safe, GAP, this.#placed)
    for (const id of IDS) {
      const b = this.#blocks[id]
      const p = at[id]
      show(b, p !== null)
      if (p === null) continue
      const variant = String(p.v)
      if (b.dataset.v !== variant) {
        b.dataset.v = variant
        if (id === 'right') this.#spd.resized()
      }
      move(b, `translate3d(${Math.round(p.x)}px,${Math.round(p.y)}px,0)`) // whole px: crisp text
    }
    this.#placed = at
  }

  destroy(): void {
    this.#bracket.remove()
    for (const id of IDS) this.#blocks[id].remove()
    this.#shown = false
  }

  #hide(): void {
    this.#bracket.hidden = true
    for (const id of IDS) {
      this.#blocks[id].hidden = true
      this.#keys[id] = '' // shown again: measured again
    }
    // Shown again, every value snaps: none glides in from where it was.
    for (const g of [...Object.values(this.#gl), ...this.#epr]) g.step(null, 0)
    this.#trend.step(null, 0)
    this.#trendOn = false
    this.#dataT = null
    this.#spdSrc = null
    this.#placed = {}
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

  /** Every frame: each value glides on, each instrument moves to it. dataDt: the data's time step (the speed trend). */
  #step(v: FrameView, dt: number, dataDt: number): void {
    const gl = this.#gl
    const dpr = globalThis.devicePixelRatio || 1
    const alt = gl.alt.step(v.alt?.value ?? null, dt)
    if (alt !== null) this.#alt.set(alt, dpr)
    const vs = gl.vs.step(v.vs?.value ?? null, dt)
    if (vs !== null) this.#vsi.set(vs)
    const src = v.speed?.kind ?? null
    if (src !== this.#spdSrc) {
      gl.spd.step(null, 0) // airspeed ↔ ground speed: another quantity, no glide from one to the other
      this.#trend.step(null, 0)
      this.#spdSrc = src
    }
    const spd = gl.spd.step(v.speed?.value ?? null, dt)
    if (spd !== null) this.#spd.set(spd, dpr)
    const rate = this.#trend.step(v.speed?.value ?? null, dataDt) // the data's own rate, not the glide's
    this.#trendOn = rate !== null && trendShown(this.#trendOn, rate * TREND_S)
    this.#spd.trend(this.#trendOn ? rate! * TREND_S : null, dpr)
    gl.gs.step(v.gs?.value ?? null, dt)
    const hdg = gl.hdg.step(v.hdg?.value ?? null, dt)
    const trk = gl.trk.step(v.track?.value ?? null, dt)
    if (hdg !== null) this.#hdg.set(hdg, trk === null ? null : rel180(trk - hdg), dpr)
    const wind = gl.wind.step(v.wind?.rel?.deg ?? null, dt)
    if (wind !== null) this.#wdial.set(wind)
    const roll = gl.roll.step(v.roll?.value ?? null, dt)
    const pitch = gl.pitch.step(v.pitch?.value ?? null, dt)
    if (v.adi !== null) this.#adi.set(roll ?? 0, pitch ?? 0) // an unknown angle is drawn level (and the indicator dimmed)
    this.#g.set(gl.g.step(v.g?.value ?? null, dt))
    const epr = v.epr?.values ?? []
    if (epr.length !== this.#eprGauges.length) this.#buildEpr(epr.length)
    epr.forEach((e, i) => this.#eprGauges[i].set(this.#epr[i].step(e, dt)))
  }

  /** At most every TEXT_MS: the figures (from the glided values), which parts show, the dimming; then new sizes. */
  #text(v: FrameView): void {
    const gl = this.#gl
    // Left.
    show(this.#alt.el, v.alt !== null)
    if (v.alt !== null) dim(this.#alt.el, v.alt.est)
    show(this.#vsi.el, v.vs !== null)
    show(this.#vs, v.vs !== null)
    if (v.vs !== null && gl.vs.value !== null) {
      const t = vsText(gl.vs.value)
      say(this.#vs, t.arrow === '' ? t.text : `${t.arrow} ${t.text}`)
      this.#vs.dataset.dir = t.arrow === '↑' ? 'up' : t.arrow === '↓' ? 'down' : 'level'
      dim(this.#vsi.el, v.vs.est)
      dim(this.#vs, v.vs.est)
    }
    show(this.#altRow, v.alt !== null || v.vs !== null)
    show(this.#agl.el, v.agl !== null)
    if (v.agl !== null) {
      say(this.#agl.value, altText(v.agl.value))
      dim(this.#agl.el, v.agl.est)
    }
    // Right.
    show(this.#spdHead, v.speed !== null)
    show(this.#spdRow, v.speed !== null)
    if (v.speed !== null) {
      say(this.#spdKind, v.speed.kind)
      dim(this.#spd.el, v.speed.est)
    }
    show(this.#gs.el, v.gs !== null)
    if (v.gs !== null && gl.gs.value !== null) {
      say(this.#gs.value, speedText(gl.gs.value))
      dim(this.#gs.el, v.gs.est)
    }
    show(this.#thrust, v.epr !== null)
    if (v.epr !== null) {
      v.epr.values.forEach((e, i) => this.#eprGauges[i]?.text(e === null ? '—' : eprText(e)))
      dim(this.#thrust, v.epr.est)
    }
    // Top.
    show(this.#hdgCol, v.hdg !== null)
    if (v.hdg !== null && gl.hdg.value !== null) {
      say(this.#hdgKind, v.hdg.kind)
      this.#hdg.text(deg3(gl.hdg.value), v.track?.est ?? false)
      dim(this.#hdg.el, v.hdg.est)
    }
    show(this.#wind, v.wind !== null)
    if (v.wind !== null) {
      const t = windText(v.wind.fromDeg, v.wind.kt)
      say(this.#windText, t)
      show(this.#windUnit, t !== 'Calm')
      show(this.#wdial.el, v.wind.rel !== null)
      dim(this.#windText, v.wind.est)
      dim(this.#wdial.el, v.wind.rel?.est ?? false)
    }
    // Bottom.
    show(this.#adi.el, v.adi !== null)
    if (v.adi !== null) dim(this.#adi.el, v.adi.est)
    show(this.#bank.el, v.roll !== null)
    if (v.roll !== null && gl.roll.value !== null) {
      say(this.#bank.value, bankText(gl.roll.value))
      dim(this.#bank.el, v.roll.est)
    }
    show(this.#pitch.el, v.pitch !== null)
    if (v.pitch !== null && gl.pitch.value !== null) {
      say(this.#pitch.value, pitchText(gl.pitch.value))
      dim(this.#pitch.el, v.pitch.est)
    }
    show(this.#gload, v.g !== null)
    if (v.g !== null && gl.g.value !== null) {
      this.#g.text(gText(gl.g.value))
      dim(this.#gload, v.g.est)
    }
    show(this.#gear, v.gear !== null)
    if (v.gear !== null) dim(this.#gear, v.gear.est)
    show(this.#flaps, v.flaps !== null)
    if (v.flaps !== null) {
      say(this.#flaps, `FLAPS ${Math.round(v.flaps.value)}`)
      dim(this.#flaps, v.flaps.est)
    }
    show(this.#annun, v.gear !== null || v.flaps !== null)

    // What sets a block's size: which parts it shows, their labels and the length of their figures (the readouts are
    // sized for the usual lengths, so this rarely changes), and the phone layout. Values and dimming do not.
    this.#has = blocksShown(v)
    const phone = this.#phone?.matches ?? false
    const len = (el: Element): number => el.textContent?.length ?? 0
    const keys: Record<BlockId, string> = {
      left: [phone, v.alt !== null, v.vs !== null, v.agl !== null, this.#alt.leadLength, len(this.#vs), len(this.#agl.value)].join(),
      right: [phone, v.speed?.kind, v.gs !== null, this.#spd.leadLength, len(this.#gs.value)].join(),
      top: [phone, v.hdg?.kind, v.wind !== null, v.wind?.rel !== null, len(this.#windText)].join(),
      bottom: [
        phone, v.adi !== null, v.roll !== null, v.pitch !== null, v.g !== null, v.gear !== null, v.flaps !== null, len(this.#flaps),
        v.epr?.values.length ?? 0,
      ].join(),
    }
    for (const id of IDS) {
      if (!this.#has[id]) {
        this.#sizes[id] = []
        this.#keys[id] = ''
      } else if (keys[id] !== this.#keys[id]) {
        this.#keys[id] = keys[id]
        this.#measure(id)
      }
    }
  }

  /** A block's size in each variant (full, compact) and its anchor: one layout per variant. */
  #measure(id: BlockId): void {
    if (id === 'right') this.#spd.resized()
    const b = this.#blocks[id]
    const hidden = b.hidden
    const was = b.dataset.v
    b.hidden = false
    const out: BlockSize[] = []
    for (const variant of ['0', '1']) {
      b.dataset.v = variant
      const r = b.getBoundingClientRect()
      const s: BlockSize = { w: Math.ceil(r.width), h: Math.ceil(r.height) }
      const a = this.#anchor(id)
      if (a !== null) {
        const ar = a.getBoundingClientRect()
        if (id === 'left' || id === 'right') s.ay = Math.round(ar.top + ar.height / 2 - r.top)
        else s.ax = Math.round(ar.left + ar.width / 2 - r.left)
      }
      out.push(s)
    }
    b.dataset.v = was
    b.hidden = hidden
    this.#sizes[id] = out
  }

  /** The part a block lines up with the aircraft: the tapes' middles, the heading index, the attitude indicator. */
  #anchor(id: BlockId): HTMLElement | null {
    const el = id === 'left' ? this.#altRow : id === 'right' ? this.#spdRow : id === 'top' ? this.#hdgCol : this.#adi.el
    return el.hidden ? null : id === 'top' ? this.#hdg.el : el
  }

  /** One EPR gauge per engine, numbered from the left wingtip. */
  #buildEpr(n: number): void {
    this.#eprGauges = Array.from({ length: n }, () => new ArcGauge(EPR_GAUGE))
    this.#epr = this.#eprGauges.map(() => new Glide(0.15, 0.3))
    this.#eprs.replaceChildren(
      ...this.#eprGauges.map((g, i) => {
        g.el.dataset.engine = String(i + 1)
        return g.el
      }),
    )
  }
}

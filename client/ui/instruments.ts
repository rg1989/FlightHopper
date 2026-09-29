// client/ui/instruments.ts
// The flight-data frame's instruments (client/scene/flightFrame.ts), glass-cockpit style, as DOM + SVG: the altitude and
// speed tapes, the vertical-speed scale, the heading tape, the attitude indicator, the wind dial and the small arc
// gauges (load factor, EPR). Each is drawn once and then only moved: set() every frame writes transforms (compositor
// work, no layout), text() at most every TEXT_MS writes figures; the tapes' readouts roll every frame, an odometer's
// last digits on a drum. Sizes come from CSS (flightFrame.css): the tapes keep their scale in px and show a shorter
// window when smaller; the round instruments scale as a whole.
import {
  VSI_MARKS, arcDeg, bankAlert, drum, drumLabels, drumShift, hdgLabel, marks, pitchShift, stripCentre, tapeShift, vsiFrac,
} from '../scene/instrumentMath.ts'

const SVG_NS = 'http://www.w3.org/2000/svg'
const MINUS = '−'

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  return e
}

// Every frame most values hold still: a style is written only when it changed.
const written = new WeakMap<Element, string>()
/** Sets el's transform, if it changed. */
export function move(el: HTMLElement, t: string): void {
  if (written.get(el) === t) return
  el.style.transform = t
  written.set(el, t)
}
/** Sets el's text, if it changed. */
export function say(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text
}
/** Shows or hides el, if that changed. */
export function show(el: HTMLElement, on: boolean): void {
  if (el.hidden === on) el.hidden = !on
}

let uid = 0 // gradient ids, unique in the page

// ---- tapes ----------------------------------------------------------------------------------------------------------

/**
 * A vertical tape's scale: px per unit, a mark every `minor` and a label every `major`, a strip drawn ± halfSpan round
 * its centre (redrawn when the value nears its end), the ticks on the side facing the aircraft.
 */
export interface TapeSpec {
  ppu: number
  minor: number
  major: number
  halfSpan: number
  window: number // half the tallest window shown, in units: the strip is redrawn before it would show its end
  ticks: 'left' | 'right'
  min?: number // no marks below it (no negative speeds)
  label: (v: number) => string
  read: { unit: number; step: number; digits: number } // the readout: whole units in figures, the rest rolling in steps
}

const STRIP_W = 84 // the strip's drawn width; the tape's well clips it to its own
const TICK_MINOR = 7
const TICK_MAJOR = 12
const LABEL_IN = 16 // a label's near end, from the tick edge

/** Altitude: 11 px per 100 ft, a mark every 100 ft, a label every 500 (two or three in view). */
export const ALT_TAPE: TapeSpec = {
  ppu: 0.11, minor: 100, major: 500, halfSpan: 2_000, window: 760, ticks: 'right',
  label: (v) => `${v < 0 ? MINUS : ''}${Math.abs(v).toLocaleString('en-US')}`,
  read: { unit: 100, step: 20, digits: 2 }, // "12,3" and the tens rolling in 20 ft steps, as an airliner's
}
/** Speed: 14 px per 10 kt, a mark every 10 kt, a label every 20; nothing below 0. */
export const SPEED_TAPE: TapeSpec = {
  ppu: 1.4, minor: 10, major: 20, halfSpan: 140, window: 64, ticks: 'left', min: 0, label: (v) => String(v),
  read: { unit: 10, step: 1, digits: 1 },
}

/** Altitude in metres (units.ts): the feet tape's px per foot, a mark every 50 m, a label every 100 m; the tens roll in 10s. */
export const ALT_TAPE_M: TapeSpec = {
  ...ALT_TAPE, ppu: 0.11 / 0.3048, minor: 50, major: 100, halfSpan: 600, window: 232,
  read: { unit: 100, step: 10, digits: 2 },
}
/** Speed in km/h: the knot tape's px per knot, a mark every 20 km/h, a label every 40. */
export const SPEED_TAPE_KMH: TapeSpec = { ...SPEED_TAPE, ppu: 1.4 / 1.852, minor: 20, major: 40, halfSpan: 260, window: 120 }
/** Speed in mph: a mark every 10 mph, a label every 20. */
export const SPEED_TAPE_MPH: TapeSpec = { ...SPEED_TAPE, ppu: 1.4 / 1.150779, halfSpan: 160, window: 74 }

const TREND_HEAD = 6 // the trend arrow's head, px; the arrow stops this far inside the tape's end
const DRUM_CELL_EM = 1.15 // a drum cell's height: at rest the window (the readout box) shows none of the neighbours' ink

/**
 * A vertical tape in its well, the value's readout boxed across its middle with a pointer to the ticks: its whole units
 * in figures, the rest on a drum that rolls (the neighbouring digits come in from above and below). The strip is drawn
 * round a centre and slid (whole device pixels: crisp lines) to put the value under the index. The speed tape adds the
 * trend arrow: from the index to the speed 10 s ahead.
 */
export class Tape {
  readonly el = h('div', 'fh-tapebox')
  readonly #spec: TapeSpec
  readonly #well = h('div', 'fh-tape')
  readonly #strip = h('div', 'fh-strip')
  readonly #lead = h('span', 'fh-read-lead')
  readonly #col = h('span', 'fh-drum-col')
  readonly #n: number // the drum's cells per unit
  #centre: number | null = null
  #arrow: { el: HTMLDivElement; shaft: HTMLDivElement; head: HTMLDivElement } | null = null
  #half = 0 // half the well's height, px (0: measure it again)

  constructor(spec: TapeSpec, kind: string) {
    this.#spec = spec
    this.el.dataset.kind = kind
    this.el.dataset.ticks = spec.ticks
    const { unit, step, digits } = spec.read
    this.#n = unit / step
    for (const l of drumLabels(unit, step, digits)) this.#col.append(h('span', 'fh-drum-c', l))
    this.#col.style.lineHeight = `${DRUM_CELL_EM}em`
    this.#col.style.top = `calc(50% - ${DRUM_CELL_EM / 2}em)` // the cell at the drum's position centred
    const drumEl = h('span', 'fh-drum')
    drumEl.style.width = `${digits}ch`
    drumEl.append(this.#col)
    const value = h('span', 'fh-read-v')
    value.append(this.#lead, drumEl)
    const read = h('div', 'fh-read')
    read.append(value)
    const view = h('div', 'fh-tape-view') // fades the marks out at the ends; the strip slides inside it
    view.append(this.#strip)
    this.#well.append(view)
    this.el.append(this.#well, read)
  }

  /** Every frame: the strip and the readout at value. */
  set(value: number, dpr: number): void {
    const s = this.#spec
    const c = stripCentre(value, this.#centre, s.halfSpan, s.window, s.major)
    if (c !== this.#centre) {
      this.#centre = c
      this.#build(c)
    }
    move(this.#strip, `translate3d(0,${tapeShift(value, c, s.ppu, dpr)}px,0)`)
    const { unit, digits } = s.read
    const d = drum(value, unit, s.read.step)
    say(this.#lead, `${d.neg ? MINUS : ''}${d.lead === 0 ? '' : (d.lead * unit).toLocaleString('en-US').slice(0, -digits)}`)
    // ponytail: in em, so it follows the readout's size; between whole px at rest on a 1× screen (sharp from 2×)
    move(this.#col, `translate3d(0,${(drumShift(d.pos, this.#n) * DRUM_CELL_EM).toFixed(4)}em,0)`)
  }

  /** The readout's figures before the drum, in characters: what sizes the box. */
  get leadLength(): number {
    return this.#lead.textContent?.length ?? 0
  }

  /**
   * Every frame on the speed tape: the trend arrow from the index to kt10, the change over the next 10 s (null: none),
   * up for faster; pinned inside the tape's end.
   */
  trend(kt10: number | null, dpr: number): void {
    if (this.#arrow === null) {
      const a = { el: h('div', 'fh-trend'), shaft: h('div', 'fh-trend-shaft'), head: h('div', 'fh-trend-head') }
      a.el.append(a.shaft, a.head)
      this.#well.append(a.el)
      this.#arrow = a
    }
    const a = this.#arrow
    show(a.el, kt10 !== null)
    if (kt10 === null) return
    if (this.#half <= 0) this.#half = this.#well.clientHeight / 2 // a layout read, once per size
    const len = Math.round(Math.min(Math.abs(kt10) * this.#spec.ppu, Math.max(0, this.#half - TREND_HEAD)) * dpr) / dpr
    const dir = kt10 > 0 ? 'up' : 'down'
    if (a.el.dataset.dir !== dir) a.el.dataset.dir = dir
    move(a.shaft, `translate3d(0,${dir === 'up' ? -len : 0}px,0) scaleY(${len})`)
    move(a.head, `translate3d(0,${dir === 'up' ? -len : len}px,0)`)
  }

  /** The tape's size changed (another variant, the phone layout): the trend arrow measures it again. */
  resized(): void {
    this.#half = 0
  }

  #build(c: number): void {
    const { ppu, minor, major, halfSpan, ticks, min, label } = this.#spec
    const H = Math.round(2 * halfSpan * ppu)
    const right = ticks === 'right'
    const root = svg('svg', { width: STRIP_W, height: H, viewBox: `0 0 ${STRIP_W} ${H}`, 'aria-hidden': 'true' })
    const lines = svg('path', { class: 'fh-tick', d: '' })
    let d = ''
    for (const m of marks(c - halfSpan, c + halfSpan, minor, major)) {
      if (min !== undefined && m.v < min) continue
      const y = Math.round(H / 2 + (c - m.v) * ppu)
      const len = m.major ? TICK_MAJOR : TICK_MINOR
      d += `M${right ? STRIP_W - len : 0} ${y}h${len}v1h${-len}z` // a 1 px bar on whole pixels: crisp
      if (m.major) {
        const t = svg('text', { x: right ? STRIP_W - LABEL_IN : LABEL_IN, y: y + 0.5, dy: '0.36em', 'text-anchor': right ? 'end' : 'start' })
        t.textContent = label(m.v)
        root.append(t)
      }
    }
    lines.setAttribute('d', d)
    root.prepend(lines)
    this.#strip.style.top = `calc(50% - ${H / 2}px)`
    this.#strip.replaceChildren(root)
  }
}

// ---- vertical speed -------------------------------------------------------------------------------------------------

/**
 * The vertical-speed scale beside the altitude tape: marks at 0.5, 1, 2, 4 and 6 thousand fpm each way on the
 * non-linear scale (vsiFrac), a bar from level to the value and a pointer at its end. Laid out in % of its height, so it
 * follows the tape's.
 */
export class Vsi {
  readonly el = h('div', 'fh-vsi')
  readonly #bar = h('div', 'fh-vsi-bar')
  readonly #ptr = h('div', 'fh-vsi-ptr')
  readonly #labels: { el: HTMLSpanElement; fpm: number }[] = []

  constructor() {
    const scale = h('div', 'fh-vsi-scale')
    for (const sign of [1, -1]) {
      for (const m of VSI_MARKS) {
        const top = `${(50 - 50 * vsiFrac(sign * m)).toFixed(3)}%`
        const major = m === 1_000 || m === 2_000 || m === 6_000
        const mark = h('div', `fh-vsi-m${major ? ' fh-major' : ''}`)
        mark.style.top = top
        scale.append(mark)
        if (major) {
          const l = h('span', 'fh-vsi-l', String(m / 1_000))
          l.style.top = top
          scale.append(l)
          this.#labels.push({ el: l, fpm: m })
        }
      }
    }
    scale.append(h('div', 'fh-vsi-zero'))
    this.el.append(scale, this.#bar, this.#ptr)
  }

  /** The scale's figures: thousands of ft/min (1 2 6), or m/s (5 10 30: the same marks, rounded). */
  units(ms: boolean): void {
    for (const { el, fpm } of this.#labels) el.textContent = ms ? String(Math.round((fpm * 0.00508) / 5) * 5) : String(fpm / 1_000)
  }

  /** Every frame. */
  set(fpm: number): void {
    const f = vsiFrac(fpm)
    move(this.#bar, `scaleY(${f.toFixed(4)})`)
    move(this.#ptr, `translate3d(0,${(-100 * f).toFixed(3)}%,0)`)
  }
}

// ---- heading --------------------------------------------------------------------------------------------------------

const HDG_PPD = 2.8 // px per degree
const HDG_HALF = 120 // the strip, ± degrees round its centre
const HDG_WINDOW = 50 // half the widest window, degrees
const HDG_H = 30 // the strip's height, px (the well's, flightFrame.css)
const TRK_MAX = 24 // the track diamond stops this far off the index: inside the narrowest tape's window

/**
 * The heading tape: the compass (a mark every 5°, longer every 10°, N 3 6 E 12… every 30°) sliding under a fixed index,
 * the heading boxed across its middle, and the track as a small diamond where it differs. Continuous across north: it
 * takes an unwrapped heading.
 */
export class HeadingTape {
  readonly el = h('div', 'fh-hdg')
  readonly #strip = h('div', 'fh-strip')
  readonly #trk = h('div', 'fh-hdg-trk')
  readonly #value = h('span', 'fh-read-v')
  #centre: number | null = null

  constructor() {
    const well = h('div', 'fh-hdg-tape')
    const view = h('div', 'fh-tape-view')
    const read = h('div', 'fh-read')
    read.append(this.#value)
    view.append(this.#strip, this.#trk)
    well.append(view, h('div', 'fh-hdg-index'))
    this.el.append(well, read)
  }

  /** Every frame: the tape at the unwrapped heading; trkOffDeg: the track's offset from it (null: no diamond). */
  set(hdgDeg: number, trkOffDeg: number | null, dpr: number): void {
    const c = stripCentre(hdgDeg, this.#centre, HDG_HALF, HDG_WINDOW, 30)
    if (c !== this.#centre) {
      this.#centre = c
      this.#build(c)
    }
    move(this.#strip, `translate3d(${-tapeShift(hdgDeg, c, HDG_PPD, dpr)}px,0,0)`)
    show(this.#trk, trkOffDeg !== null)
    if (trkOffDeg !== null) {
      const x = Math.max(-TRK_MAX, Math.min(TRK_MAX, trkOffDeg)) * HDG_PPD
      move(this.#trk, `translate3d(${(Math.round(x * dpr) / dpr).toFixed(2)}px,0,0) rotate(45deg)`)
    }
  }

  /** The heading's figure; trkEst: the track diamond is an estimate (dimmed). */
  text(value: string, trkEst: boolean): void {
    say(this.#value, value)
    this.#trk.classList.toggle('fh-est', trkEst)
  }

  #build(c: number): void {
    const W = Math.round(2 * HDG_HALF * HDG_PPD)
    const root = svg('svg', { width: W, height: HDG_H, viewBox: `0 0 ${W} ${HDG_H}`, 'aria-hidden': 'true' })
    let d = ''
    for (const m of marks(c - HDG_HALF, c + HDG_HALF, 5, 10)) {
      const x = Math.round(W / 2 + (m.v - c) * HDG_PPD)
      const len = m.major ? 8 : 5
      d += `M${x} 0v${len}h1v${-len}z`
      const l = hdgLabel(m.v)
      if (l !== '') {
        const cardinal = /^[NESW]$/.test(l)
        const t = svg('text', { x: x + 0.5, y: 20.5, dy: '0.36em', 'text-anchor': 'middle', class: cardinal ? 'fh-card' : '' })
        t.textContent = l
        root.append(t)
      }
    }
    root.prepend(svg('path', { class: 'fh-tick', d }))
    this.#strip.style.left = `calc(50% - ${W / 2}px)`
    this.#strip.replaceChildren(root)
  }
}

// ---- attitude -------------------------------------------------------------------------------------------------------

// The indicator in units of its ball: 100 units across. The world (sky, ground, pitch ladder) is 300 units square.
const ADI_UPD = 2.25 // units per degree of pitch: ±20° near the rim
const PITCH_PCT = (ADI_UPD / 300) * 100 // the world's shift per degree, % of its own height
const BANK_TICKS: ReadonlyArray<readonly [number, boolean]> = [[10, false], [20, false], [30, true], [45, false], [60, true]]

const polar = (r: number, deg: number): string => {
  const a = (deg * Math.PI) / 180
  return `${(r * Math.sin(a)).toFixed(2)} ${(-r * Math.cos(a)).toFixed(2)}`
}

/**
 * The attitude indicator: a round window on the world (sky over ground, the horizon, a pitch ladder every 5° labelled at
 * 10 and 20) that rolls and pitches behind a fixed aircraft symbol, the bank scale above it (0, 10, 20, 30, 45, 60 each
 * way) and the sky pointer turning along it with the world; amber past BANK_ALERT_DEG.
 */
export class Adi {
  readonly el = h('div', 'fh-adi')
  readonly #world = h('div', 'fh-adi-world')
  readonly #ptr = h('div', 'fh-adi-ptr')
  #alert = false

  constructor() {
    const id = `fh-adi-${++uid}`
    const ball = h('div', 'fh-adi-ball')
    const w = svg('svg', { viewBox: '-150 -150 300 300', 'aria-hidden': 'true' })
    const grad = (gid: string, y1: number, y2: number, a: string, b: string): SVGLinearGradientElement => {
      const g = svg('linearGradient', { id: gid, x1: 0, y1, x2: 0, y2, gradientUnits: 'userSpaceOnUse' })
      g.append(svg('stop', { offset: 0, class: a }), svg('stop', { offset: 1, class: b }))
      return g
    }
    const defs = svg('defs', {})
    defs.append(grad(`${id}-sky`, -150, 0, 'fh-sky0', 'fh-sky1'), grad(`${id}-gnd`, 0, 150, 'fh-gnd0', 'fh-gnd1'))
    const ladder = svg('g', { class: 'fh-adi-ladder' })
    let d = ''
    for (let p = -30; p <= 30; p += 5) {
      if (p === 0) continue
      const y = -p * ADI_UPD
      const half = p % 10 === 0 ? 15 : 7
      d += `M${-half} ${y}H${half}`
      if (p % 10 === 0 && Math.abs(p) <= 20) {
        for (const x of [-half - 3, half + 3]) {
          const t = svg('text', { x, y, dy: '0.35em', 'text-anchor': x < 0 ? 'end' : 'start' })
          t.textContent = String(Math.abs(p))
          ladder.append(t)
        }
      }
    }
    ladder.prepend(svg('path', { d }))
    w.append(
      defs,
      svg('rect', { x: -150, y: -150, width: 300, height: 150, fill: `url(#${id}-sky)` }),
      svg('rect', { x: -150, y: 0, width: 300, height: 150, fill: `url(#${id}-gnd)` }),
      ladder,
      svg('path', { class: 'fh-adi-hz', d: 'M-150 0H150' }),
    )
    this.#world.append(w)
    ball.append(this.#world, h('div', 'fh-adi-glass'))

    // The bank scale, fixed: an arc, the ticks, the zero index.
    const scale = svg('svg', { class: 'fh-adi-scale', viewBox: '-50 -50 100 100', 'aria-hidden': 'true' })
    let t = `M${polar(51.5, -60)}A51.5 51.5 0 0 1 ${polar(51.5, 60)}`
    for (const [a, long] of BANK_TICKS) for (const s of [-1, 1]) t += `M${polar(51.5, s * a)}L${polar(long ? 58.5 : 55.5, s * a)}`
    scale.append(svg('path', { class: 'fh-adi-bank', d: t }), svg('path', { class: 'fh-adi-zero', d: 'M0 -51.5L-3.6 -58.2H3.6Z' }))
    // The sky pointer: turns with the world, points up to the scale.
    const ptr = svg('svg', { viewBox: '-50 -50 100 100', 'aria-hidden': 'true' })
    ptr.append(svg('path', { d: 'M0 -49.5L-4.4 -42H4.4Z' }))
    this.#ptr.append(ptr)
    // The aircraft symbol, fixed: two wing bars with their inner ends turned down, and the centre square.
    const ac = svg('svg', { class: 'fh-adi-ac', viewBox: '-50 -50 100 100', 'aria-hidden': 'true' })
    ac.append(svg('path', { d: 'M-40 -2H-13V8H-17.5V2H-40ZM40 -2H13V8H17.5V2H40ZM-2.6 -2.6H2.6V2.6H-2.6Z' }))
    this.el.append(ball, scale, this.#ptr, ac)
  }

  /** Every frame: rollDeg unwrapped (continuous), right wing down +; pitchDeg nose up +. */
  set(rollDeg: number, pitchDeg: number): void {
    const r = (-rollDeg).toFixed(2)
    move(this.#world, `rotate(${r}deg) translate3d(0,${(pitchShift(pitchDeg) * PITCH_PCT).toFixed(3)}%,0)`)
    move(this.#ptr, `rotate(${r}deg)`)
    const alert = bankAlert(rollDeg)
    if (alert !== this.#alert) {
      this.#alert = alert
      this.#ptr.classList.toggle('fh-alert', alert)
    }
  }
}

// ---- wind -----------------------------------------------------------------------------------------------------------

/** The wind dial: a small aircraft nose-up in a ring, and the wind's arrow on the ring, blowing in from its side. */
export class WindDial {
  readonly el = h('div', 'fh-wdial')
  readonly #arrow = h('div', 'fh-wdial-arrow')

  constructor() {
    const base = svg('svg', { viewBox: '-13 -13 26 26', 'aria-hidden': 'true' })
    base.append(
      svg('circle', { class: 'fh-wdial-ring', cx: 0, cy: 0, r: 12 }),
      svg('path', { class: 'fh-wdial-ac', d: 'M0 -5.2V5M-5.4 0.6H5.4M-2.1 4.4H2.1' }),
    )
    const arrow = svg('svg', { viewBox: '-13 -13 26 26', 'aria-hidden': 'true' })
    arrow.append(svg('path', { class: 'fh-wdial-shaft', d: 'M0 -13.6V-8.2' }), svg('path', { class: 'fh-wdial-head', d: 'M0 -3.4L-3.6 -8.6H3.6Z' }))
    this.#arrow.append(arrow)
    this.el.append(base, this.#arrow)
  }

  /** Every frame: where the wind comes from, degrees clockwise from the nose (unwrapped is fine). */
  set(relDeg: number): void {
    move(this.#arrow, `rotate(${relDeg.toFixed(1)}deg)`)
  }
}

// ---- arc gauges -----------------------------------------------------------------------------------------------------

/** A small arc gauge: lo…hi along an arc from a0 to a1 (degrees clockwise from up), ticks, and a needle. */
export interface ArcSpec {
  lo: number
  hi: number
  a0: number
  a1: number
  r: number // the arc's radius, in the gauge's 44-unit box
  ticks: readonly number[]
  major: readonly number[] // longer ticks
  mark?: number // one value marked out (1 g)
}

export const G_GAUGE: ArcSpec = { lo: 0, hi: 2.5, a0: -90, a1: 90, r: 17, ticks: [0, 0.5, 1, 1.5, 2, 2.5], major: [0, 1, 2], mark: 1 }
export const EPR_GAUGE: ArcSpec = { lo: 1, hi: 2, a0: -120, a1: 90, r: 17, ticks: [1, 1.25, 1.5, 1.75, 2], major: [1, 1.5, 2] }

/**
 * An arc gauge, 44 units square round its pivot (CSS sizes it): the scale drawn once, the needle turned every frame,
 * its figure under the pivot at most every TEXT_MS.
 */
export class ArcGauge {
  readonly el = h('div', 'fh-arc')
  readonly #spec: ArcSpec
  readonly #needle = h('div', 'fh-arc-needle')
  readonly #value = h('span', 'fh-arc-v')

  constructor(spec: ArcSpec) {
    this.#spec = spec
    const { r, a0, a1, lo, hi } = spec
    const face = svg('svg', { viewBox: '-22 -22 44 44', 'aria-hidden': 'true' })
    const large = a1 - a0 > 180 ? 1 : 0
    let d = ''
    for (const v of spec.ticks) {
      const a = arcDeg(v, lo, hi, a0, a1)
      d += `M${polar(r - (spec.major.includes(v) ? 4.5 : 3), a)}L${polar(r, a)}`
    }
    face.append(
      svg('path', { class: 'fh-arc-track', d: `M${polar(r, a0)}A${r} ${r} 0 ${large} 1 ${polar(r, a1)}` }),
      svg('path', { class: 'fh-arc-ticks', d }),
    )
    if (spec.mark !== undefined) {
      const a = arcDeg(spec.mark, lo, hi, a0, a1)
      face.append(svg('path', { class: 'fh-arc-mark', d: `M${polar(r - 5.5, a)}L${polar(r + 1.5, a)}` }))
    }
    const needle = svg('svg', { viewBox: '-22 -22 44 44', 'aria-hidden': 'true' })
    needle.append(svg('path', { d: `M0 ${-(r - 1.5)}L1.6 0L0 2.2L-1.6 0Z` }), svg('circle', { cx: 0, cy: 0, r: 2.2 }))
    this.#needle.append(needle)
    this.el.append(face, this.#needle, this.#value)
  }

  /** Every frame (null: unknown, no needle). */
  set(v: number | null): void {
    show(this.#needle, v !== null)
    if (v !== null) move(this.#needle, `rotate(${arcDeg(v, this.#spec.lo, this.#spec.hi, this.#spec.a0, this.#spec.a1).toFixed(1)}deg)`)
  }

  text(value: string): void {
    say(this.#value, value)
  }
}

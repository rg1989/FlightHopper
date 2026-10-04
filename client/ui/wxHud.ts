// client/ui/wxHud.ts
// The chase weather's HUD, over the 3-D view (wxAhead.ts works out what it says): at the top centre under the search box
// - the status line: a chip with where the aircraft is ("In light rain", or "Clear air · a thunderstorm in 3 min"; a dot in the
//   severity's colour; "No weather data" with a grey dot until a weather source has answered) and, when a hazard area is on the path,
//   a chip under it edged in the area's own colour ("Inside hazard area · …", "Hazard area in 2 min · …"); each chip is one line;
// - while the aircraft is inside a hazard area and under its top, a red frame inset round the whole view: the answer to "am I in it?"
//   (red whatever the area's colour, and whatever style its edges are drawn in);
// - the ahead strip under them: a side view of the next 80 km on this heading (the weather's cells in the severity's colours, the hazard
//   areas dashed, each in its colour, the aircraft's way as a dashed line with a tick each minute, the heights in the frame's units).
//   A window under 480 px high has no room for it (wxHud.css): it is not drawn there.
// The app gives it what to say a few times a second (set) and whether the strip shows (setStrip: the Weather menu's choice). Nothing
// here is computed: set(null …) hides it all, and so does the app while the weather is hidden. It publishes its height as
// --fh-wxhud-h on its root, which wxHud.css uses to stand the alert toasts under it.
// ponytail: the strip is not one of the flight-data frame's movable cards: it has a fixed place, and the frame keeps off it as it does off
// the search box (app.ts FRAME_COVERS). Upgrade: a block of the flight-data frame.
import { AHEAD_MIN, SEV_COLOR, STRIP_COVER, pathPointAt, sevOf, statusWords, type AheadPath, type AheadProfile, type AheadStatus } from '../scene/wxAhead.ts'
import { M_PER_FT, type Units } from './units.ts'
import './wxHud.css'

export interface WxHudHandle {
  /** What to show now: no status hides the whole HUD; no profile or path, just the strip. The strip is drawn only while it is on (setStrip). */
  set(status: AheadStatus | null, profile: AheadProfile | null, path: AheadPath | null, units: Units): void
  setStrip(on: boolean): void
  destroy(): void
}

/** The parts of a canvas's 2-D context the strip draws with (a recording stand-in in tests). */
export type StripContext = Pick<CanvasRenderingContext2D,
  'clearRect' | 'fillRect' | 'strokeRect' | 'beginPath' | 'moveTo' | 'lineTo' | 'stroke' | 'fill' | 'fillText' | 'setLineDash'
  | 'fillStyle' | 'strokeStyle' | 'lineWidth' | 'font' | 'textAlign' | 'textBaseline' | 'globalAlpha'>

const UNKNOWN_COLOR = 'var(--fh-muted)' // the status dot while the sky is not known
const PATH_COLOR = '#ffd23f' // the traffic's yellow (theme.css --fh-traffic): the aircraft and its way
const AXIS_COLOR = '#8e9aab' // theme.css --fh-muted
const GRID_COLOR = 'rgba(142, 154, 171, 0.25)'
const PLOT_COLOR = 'rgba(255, 255, 255, 0.045)'
const FONT_PX = 11
const FALLBACK_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif'
const STRIP_W = 400 // the strip's drawn size when the page has not laid it out (a test)
const STRIP_RATIO = 0.28 // its height of its width; the canvas's CSS keeps the same shape
const PAD = { left: 58, right: 8, rightBoth: 58, top: 6, bottom: 18 } // CSS px round the plot: the height labels at its left (and right, in both units), the minutes under it
const TICK_PX = 6
const MIN_LABEL_GAP_PX = 44 // the least room between two minute labels: a slow aircraft's minutes are close, and every other is named
const MIN_LABEL_PX = 34 // a minute label's width, about ("6 min" at 11 px)
const GRID_FT = [10_000, 20_000, 30_000, 40_000] // the gridlines, in the unit the strip's heights are in
const GRID_M = [3000, 6000, 9000, 12_000]
const TRACE_STEP_KM = 5

/** The plot's rectangle inside a strip of w × h CSS px, its heights in these units. */
export function stripPlot(w: number, h: number, units: Units): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: PAD.left, y0: PAD.top, x1: w - (units.alt === 'ft+m' ? PAD.rightBoth : PAD.right), y1: h - PAD.bottom }
}

const thousands = (n: number): string => n.toLocaleString('en-US')

/**
 * The ahead strip on a canvas of w × h CSS px (its context scaled to them): the plot's cells in the severity's colours where the cover is
 * over STRIP_COVER, the hazard areas the path crosses (a dashed box in the area's colour, base to top), the gridlines with their heights in the frame's
 * units (feet, metres, or feet at the left and metres at the right), the minutes under the plot, and the way ahead as a dashed line
 * from a marker for the aircraft.
 */
export function drawStrip(ctx: StripContext, w: number, h: number, profile: AheadProfile, path: AheadPath, units: Units, family = FALLBACK_FONT): void {
  const { x0, y0, x1, y1 } = stripPlot(w, h, units)
  const [pw, ph] = [x1 - x0, y1 - y0]
  const X = (km: number): number => x0 + (km / profile.kmAhead) * pw
  const Y = (m: number): number => y1 - (Math.min(m, profile.topM) / profile.topM) * ph
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = PLOT_COLOR
  ctx.fillRect(x0, y0, pw, ph)
  for (const z of profile.hazards) { // the hazard areas: from the base to the top, over the stretch of the path inside, each in its own colour
    const [ax, ay, bx, by] = [X(z.fromKm), Y(z.topM), X(z.toKm), Y(z.baseM)]
    ctx.globalAlpha = 0.14
    ctx.fillStyle = z.color
    ctx.fillRect(ax, ay, bx - ax, by - ay)
    ctx.globalAlpha = 1
  }
  const [cw, ch] = [pw / profile.cols, ph / profile.rows]
  for (let j = 0; j < profile.rows; j++) {
    for (let i = 0; i < profile.cols; i++) {
      const cover = profile.cover[j * profile.cols + i]
      if (!(cover > STRIP_COVER)) continue
      ctx.globalAlpha = Math.min(1, 0.35 + cover)
      ctx.fillStyle = SEV_COLOR[sevOf(profile.sev[j * profile.cols + i])]
      ctx.fillRect(x0 + i * cw, y1 - (j + 1) * ch, cw + 0.6, ch + 0.6) // a little over, so no seam shows between cells
    }
  }
  ctx.globalAlpha = 1
  ctx.lineWidth = 1.5
  ctx.setLineDash([5, 3])
  for (const z of profile.hazards) {
    ctx.strokeStyle = z.color
    ctx.strokeRect(X(z.fromKm), Y(z.topM), X(z.toKm) - X(z.fromKm), Y(z.baseM) - Y(z.topM))
  }
  ctx.setLineDash([])
  // The heights.
  ctx.font = `500 ${FONT_PX}px ${family}`
  ctx.fillStyle = AXIS_COLOR
  ctx.strokeStyle = GRID_COLOR
  ctx.lineWidth = 1
  ctx.textBaseline = 'middle'
  const metres = units.alt === 'm'
  for (const n of metres ? GRID_M : GRID_FT) {
    const y = Y(metres ? n : n * M_PER_FT)
    ctx.beginPath()
    ctx.moveTo(x0, y)
    ctx.lineTo(x1, y)
    ctx.stroke()
    ctx.textAlign = 'right'
    ctx.fillText(`${thousands(n)} ${metres ? 'm' : 'ft'}`, x0 - 5, y)
    if (units.alt === 'ft+m') { // the same line in metres at the right, to the nearest 50
      ctx.textAlign = 'left'
      ctx.fillText(`${thousands(Math.round((n * M_PER_FT) / 50) * 50)} m`, x1 + 5, y)
    }
  }
  // The minutes: a tick each, and the number under it where there is room.
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  let named = -Infinity
  for (let m = 1; m <= AHEAD_MIN; m++) {
    const km = m * path.kmPerMin
    if (km > profile.kmAhead) break
    const x = X(km)
    ctx.beginPath()
    ctx.moveTo(x, y1)
    ctx.lineTo(x, y1 - TICK_PX)
    ctx.stroke()
    if (x - named < MIN_LABEL_GAP_PX) continue
    named = x
    const inside = x + MIN_LABEL_PX / 2 <= w // a minute at the plot's far edge: its label ends at the strip's edge, not past it
    ctx.textAlign = inside ? 'center' : 'right'
    ctx.fillText(`${m} min`, inside ? x : w - 1, y1 + 4)
  }
  // The way ahead, from the aircraft.
  ctx.strokeStyle = PATH_COLOR
  ctx.lineWidth = 2
  ctx.setLineDash([6, 3.5])
  ctx.beginPath()
  ctx.moveTo(x0, Y(path.points[0].altM))
  for (let km = TRACE_STEP_KM; km < profile.kmAhead; km += TRACE_STEP_KM) ctx.lineTo(X(km), Y(pathPointAt(path, km).altM))
  ctx.lineTo(x1, Y(pathPointAt(path, profile.kmAhead).altM))
  ctx.stroke()
  ctx.setLineDash([])
  const y = Y(path.points[0].altM)
  ctx.fillStyle = PATH_COLOR
  ctx.beginPath()
  ctx.moveTo(x0 + 8, y)
  ctx.lineTo(x0, y - 4)
  ctx.lineTo(x0, y + 4)
  ctx.fill()
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = className
  if (text !== '') el.textContent = text
  return el
}

export function mountWxHud(root: HTMLElement): WxHudHandle {
  const veil = h('div', 'fh-wxhud-veil')
  veil.setAttribute('aria-hidden', 'true')
  const box = h('div', 'fh-wxhud')
  const lines = h('div', 'fh-wxhud-lines')
  lines.setAttribute('role', 'status')
  const cloudChip = h('div', 'fh-glass fh-wxhud-chip')
  const dot = h('i', 'fh-wxhud-dot')
  const cloudText = h('span', 'fh-wxhud-text')
  cloudChip.append(dot, cloudText)
  const hazardChip = h('div', 'fh-glass fh-wxhud-chip fh-wxhud-hazard')
  const hazardText = h('span', 'fh-wxhud-text')
  hazardChip.append(hazardText)
  lines.append(cloudChip, hazardChip)
  const strip = h('div', 'fh-glass fh-wxhud-strip')
  const canvas = h('canvas', 'fh-wxhud-cv')
  canvas.setAttribute('role', 'img')
  canvas.setAttribute('aria-label', 'Side view of the weather on this heading, 80 km ahead')
  strip.append(h('div', 'fh-wxhud-strip-h', 'Ahead on this heading'), canvas)
  box.append(lines, strip)
  for (const el of [veil, box, hazardChip, strip]) el.hidden = true
  root.append(veil, box)

  let stripOn = true
  let last: { status: AheadStatus | null; profile: AheadProfile | null; path: AheadPath | null; units: Units } | null = null
  let published = 0
  let dotColor = ''
  let hazardColor = ''
  const family = (): string => (typeof getComputedStyle === 'function' ? getComputedStyle(canvas).fontFamily : '') || FALLBACK_FONT

  /** Text and visibility written only when they change: the line says the same thing most of the time. */
  const say = (el: HTMLElement, text: string): void => {
    if (el.textContent !== text) el.textContent = text
  }
  const show = (el: HTMLElement, on: boolean): void => {
    if (el.hidden === on) el.hidden = !on // (hidden is the opposite of on)
  }

  function paintStrip(profile: AheadProfile, path: AheadPath, units: Units): void {
    const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null
    if (ctx === null) return
    if (canvas.clientWidth === 0 && typeof getComputedStyle === 'function' && getComputedStyle(strip).display === 'none') return // a short window: the stylesheet has taken the strip away
    const w = Math.max(220, Math.round(canvas.clientWidth || STRIP_W)) // laid out: the strip is shown, so it has a width
    const hh = Math.round(w * STRIP_RATIO)
    const r = Math.min(2, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1)
    if (canvas.width !== Math.round(w * r) || canvas.height !== Math.round(hh * r)) {
      canvas.width = Math.round(w * r)
      canvas.height = Math.round(hh * r)
    }
    ctx.setTransform(r, 0, 0, r, 0, 0)
    drawStrip(ctx, w, hh, profile, path, units, family())
  }

  function publish(): void {
    const height = box.hidden ? 0 : Math.ceil(box.offsetHeight || 0)
    if (height === published) return
    published = height
    if (height === 0) root.style.removeProperty('--fh-wxhud-h')
    else root.style.setProperty('--fh-wxhud-h', `${height}px`)
  }

  function apply(): void {
    const s = last?.status ?? null
    if (last === null || s === null) {
      show(box, false)
      show(veil, false)
      publish()
      return
    }
    const words = statusWords(s)
    show(box, true)
    say(cloudText, words.cloud)
    const color = !s.known ? UNKNOWN_COLOR : words.sev === null ? 'var(--fh-ok)' : SEV_COLOR[words.sev]
    if (color !== dotColor) dot.style.setProperty('--c', (dotColor = color))
    show(hazardChip, words.hazard !== null)
    if (words.hazard !== null) say(hazardText, words.hazard)
    if (s.hazard !== null && s.hazard.color !== hazardColor) hazardChip.style.setProperty('--hz', (hazardColor = s.hazard.color))
    show(veil, s.hazard?.inside === true)
    const drawn = stripOn && last.profile !== null && last.path !== null
    show(strip, drawn)
    if (drawn) paintStrip(last.profile!, last.path!, last.units) // after the strip is shown: its width is read
    publish()
  }

  return {
    set(status, profile, path, units) {
      last = { status, profile, path, units }
      apply()
    },
    setStrip(on) {
      if (on === stripOn) return
      stripOn = on
      apply()
    },
    destroy() {
      veil.remove()
      box.remove()
      root.style.removeProperty('--fh-wxhud-h')
    },
  }
}

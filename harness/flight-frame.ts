// harness/flight-frame.ts
// Scenarios task 5 harness: /harness/flight-frame.html draws the flight-data frame (client/scene/flightFrame.ts) around
// a stand-in aircraft, no Cesium scene: FlightFrame.draw() with a square of its own, as update() gives it one from the
// model. Drag the aircraft; the wheel or +/− resizes it; pick a size, a background, a data set, and whether it
// animates, to judge the look at every size and viewport. The safe area leaves out the rail and a play bar, as the app's
// will; its dashed outline can be hidden. URL: ?side=120&x=640&y=360&bg=sky|bright|imagery|night
// &data=scenario|live|sparse&anim=1&t=4.5&ui=0&safe=0 (x, y: the square's centre, px; default: the safe area's middle).
// window.harness.check() lists the drawn blocks' rectangles, any two that overlap, and any outside the safe area.
// Sample values only: nothing here is data from a real flight.
import '../client/ui/theme.css'
import '../client/ui/layout.css'
import { FlightFrame, TEXT_MS, liveFlightData } from '../client/scene/flightFrame.ts'
import type { Rect, Square } from '../client/scene/flightFrame.ts'
import { MIN_PX } from '../client/scene/traffic.ts'
import type { FlightData, RenderState } from '../client/types.ts'
import type { ReadsbAircraft } from '../shared/types.ts'

type DataSet = 'scenario' | 'live' | 'sparse'
const q = new URLSearchParams(location.search)
const num = (k: string): number | null => {
  const v = q.get(k)
  return v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v)
}

// A recorded flight: every field, some estimated (dimmed), gear and flaps out.
const SCENARIO: FlightData = {
  altFt: 6_480, aglFt: 3_120, vsFpm: -1_480, iasKt: 208, gsKt: 231, hdgDeg: 252, trackDeg: 256, pitchDeg: 4.2, rollDeg: 31.5,
  g: 1.21, windFromDeg: 220, windKt: 16, gear: 'down', flaps: 10, epr: [1.22, 1.18, 1.31, 1.27],
  derived: new Set<keyof FlightData>(['aglFt', 'windFromDeg', 'windKt']),
}
// Live chase: the drawn state plus what the aircraft broadcasts (Mode S EHS: airspeed, heading, roll, wind).
const S: RenderState = {
  hex: 'abc123', lat: 32.37, lon: 34.43, hM: 2620, headingDeg: 105, pitchDeg: -1.5, rollDeg: 0.5, gsKt: 337.1, trackDeg: 101.8,
  altBaroFt: 7975, vsFpm: -951, mode: 'interp', altSource: 'geom', onGround: false, ageS: -0.8, quality: 'adsb2',
  callsign: 'TEST123', typeCode: 'A320',
}
const RAW: ReadsbAircraft = { hex: 'abc123', ias: 268, true_heading: 99.5, roll: -2.1, wd: 281, ws: 22 }

const state = {
  side: Math.max(MIN_PX, num('side') ?? 120),
  x: num('x'),
  y: num('y'),
  data: (['scenario', 'live', 'sparse'].includes(q.get('data') ?? '') ? q.get('data') : 'scenario') as DataSet,
  anim: q.get('anim') === '1',
  t: num('t') ?? 0,
}
document.body.dataset.bg = q.get('bg') ?? 'sky'
document.body.dataset.ui = q.get('ui') ?? '1'
document.body.dataset.safe = q.get('safe') ?? '1'

const layer = document.getElementById('layer')!
const plane = document.getElementById('plane')!
const safeEl = document.getElementById('safe')!
const chrome = document.getElementById('chrome')!
const controls = document.getElementById('controls')!
const frame = new FlightFrame(layer)

/** The canvas minus the app's chrome: the rail (right edge; a tab bar at the bottom on phones) and a play bar. */
function layout(): { safe: Rect; chrome: Array<Rect & { name: string }> } {
  const w = innerWidth
  const h = innerHeight
  const m = 8
  if (w <= 640) {
    const tab = { name: 'tab bar', x: 0, y: h - 61, w, h: 61 }
    const bar = { name: 'play bar', x: m, y: tab.y - m - 76, w: w - 2 * m, h: 76 }
    return { safe: { x: m, y: m, w: w - 2 * m, h: bar.y - 2 * m }, chrome: [tab, bar] }
  }
  const rail = { name: 'rail', x: w - 56, y: 12, w: 44, h: 300 }
  const bar = { name: 'play bar', x: 12, y: h - 12 - 64, w: w - 24 - 64, h: 64 }
  return { safe: { x: m, y: m, w: rail.x - 2 * m, h: bar.y - 2 * m }, chrome: [rail, bar] }
}

function dataAt(set: DataSet, t: number): FlightData {
  const base = set === 'scenario' ? SCENARIO : liveFlightData(S, set === 'live' ? RAW : null, set === 'live' ? 7_400 : null)
  if (t === 0) return base
  const s = (period: number, phase = 0): number => Math.sin((2 * Math.PI * t) / period + phase)
  const plus = (v: number | null, dv: number): number | null => (v === null ? null : v + dv)
  return {
    ...base,
    altFt: plus(base.altFt, 420 * s(11, 1)),
    aglFt: plus(base.aglFt, 420 * s(11, 1) + 180 * s(5)),
    vsFpm: plus(base.vsFpm, 1_600 * s(11)),
    iasKt: plus(base.iasKt, 9 * s(7)),
    gsKt: plus(base.gsKt, 9 * s(7, 0.4)),
    hdgDeg: plus(base.hdgDeg, 10 * s(17)),
    trackDeg: plus(base.trackDeg, 10 * s(17, 0.2)),
    rollDeg: plus(base.rollDeg, 24 * s(9)),
    pitchDeg: plus(base.pitchDeg, 5 * s(13)),
    g: plus(base.g, 0.2 * s(9, 1)),
    epr: base.epr?.map((e, i) => e + 0.12 * s(6 + i, i)) ?? null,
  }
}

// ---- input ----------------------------------------------------------------------------------------------------------

let drag: { dx: number; dy: number } | null = null
plane.addEventListener('pointerdown', (e) => {
  plane.setPointerCapture(e.pointerId)
  drag = { dx: e.clientX - (state.x ?? 0), dy: e.clientY - (state.y ?? 0) }
})
plane.addEventListener('pointermove', (e) => {
  if (drag === null) return
  state.x = e.clientX - drag.dx
  state.y = e.clientY - drag.dy
  changed()
})
plane.addEventListener('pointerup', () => (drag = null))
const resize = (k: number): void => {
  state.side = Math.min(Math.max(state.side * k, MIN_PX), 4 * innerHeight)
  changed()
}
addEventListener('wheel', (e) => resize(Math.exp(-e.deltaY * 0.0015)), { passive: true })
addEventListener('keydown', (e) => {
  if (e.key === '+' || e.key === '=') resize(1.1)
  else if (e.key === '-') resize(1 / 1.1)
})
addEventListener('resize', () => changed())

const syncs: Array<() => void> = []
function row(title: string): HTMLDivElement {
  const r = document.createElement('div')
  r.append(title)
  controls.append(r)
  return r
}
function button(parent: HTMLElement, label: string, on: () => boolean, click: () => void): void {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = label
  b.addEventListener('click', () => {
    click()
    changed()
  })
  syncs.push(() => b.setAttribute('aria-pressed', String(on())))
  parent.append(b)
}
const sizes = row('size')
for (const px of [MIN_PX, 120, 400, 1400]) button(sizes, String(px), () => Math.round(state.side) === px, () => (state.side = px))
const bgs = row('bg')
for (const bg of ['sky', 'bright', 'imagery', 'night']) button(bgs, bg, () => document.body.dataset.bg === bg, () => (document.body.dataset.bg = bg))
const sets = row('data')
for (const d of ['scenario', 'live', 'sparse'] as const) button(sets, d, () => state.data === d, () => (state.data = d))
const opts = row('')
button(opts, 'animate', () => state.anim, () => {
  state.anim = !state.anim
  t0 = performance.now()
})
button(opts, 'safe area', () => document.body.dataset.safe !== '0', () => (document.body.dataset.safe = document.body.dataset.safe === '0' ? '1' : '0'))
button(opts, 'centre', () => false, () => (state.x = state.y = null))
const stats = document.createElement('div')
stats.id = 'stats'
controls.append(stats)

// ---- drawing --------------------------------------------------------------------------------------------------------

const place = (el: HTMLElement, r: Rect): void => {
  el.style.left = `${r.x}px`
  el.style.top = `${r.y}px`
  el.style.width = `${r.w}px`
  el.style.height = `${r.h}px`
}

let t0 = performance.now()
// A static page draws for a moment after each change: the frame changes its text at most every TEXT_MS.
let busyUntil = 0
const changed = (): void => {
  busyUntil = performance.now() + 2 * TEXT_MS
}

function render(nowMs: number): void {
  const { safe, chrome: boxes } = layout()
  if (state.x === null || state.y === null) {
    state.x = safe.x + safe.w / 2
    state.y = safe.y + safe.h / 2
  }
  const sq: Square = { x: state.x, y: state.y, side: state.side }
  const t = state.anim ? state.t + (nowMs - t0) / 1000 : state.t
  frame.draw(sq, dataAt(state.data, t), safe, nowMs)
  // The stand-in's span is 93 % of the square's side, as a model's is of its box.
  place(plane, { x: sq.x - sq.side / 2, y: sq.y - sq.side / 4, w: sq.side, h: sq.side / 2 })
  place(safeEl, safe)
  if (chrome.childElementCount !== boxes.length) {
    chrome.replaceChildren(...boxes.map(() => Object.assign(document.createElement('div'), { className: 'chrome' })))
  }
  boxes.forEach((r, i) => {
    const el = chrome.children[i] as HTMLElement
    el.textContent = r.name
    place(el, r)
  })
  for (const sync of syncs) sync()
  const c = check()
  stats.textContent = `square ${Math.round(sq.side)} px at ${Math.round(sq.x)},${Math.round(sq.y)} · viewport ${innerWidth}×${innerHeight}\n` +
    `overlaps: ${c.overlaps.length > 0 ? c.overlaps.join(', ') : 'none'} · outside safe: ${c.outside.length > 0 ? c.outside.join(', ') : 'none'}`
}

/** The drawn blocks (page px), and which overlap each other or leave the safe area. */
function check(): { safe: Rect; blocks: Array<Rect & { id: string }>; overlaps: string[]; outside: string[] } {
  const { safe } = layout()
  const blocks = [...layer.querySelectorAll<HTMLElement>('.fh-fblock:not([hidden])')].map((el) => {
    const r = el.getBoundingClientRect()
    return { id: el.dataset.block ?? '?', x: r.x, y: r.y, w: r.width, h: r.height }
  })
  const overlaps: string[] = []
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i]
      const b = blocks[j]
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlaps.push(`${a.id}/${b.id}`)
    }
  }
  const e = 0.5
  const outside = blocks
    .filter((b) => b.x < safe.x - e || b.y < safe.y - e || b.x + b.w > safe.x + safe.w + e || b.y + b.h > safe.y + safe.h + e)
    .map((b) => b.id)
  return { safe, blocks, overlaps, outside }
}

function loop(nowMs: number): void {
  if (state.anim || drag !== null || nowMs < busyUntil) render(nowMs)
  requestAnimationFrame(loop)
}
changed()
requestAnimationFrame(loop)
;(window as unknown as { harness: object }).harness = {
  frame, state, check,
  set: (o: Partial<typeof state>): void => {
    Object.assign(state, o)
    t0 = performance.now()
    changed()
  },
}

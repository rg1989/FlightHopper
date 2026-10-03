// client/ui/wxHud.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { PROFILE_COLS, PROFILE_ROWS, PROFILE_TOP_M, aheadPath, type AheadProfile, type AheadStatus } from '../scene/wxAhead.ts'
import { DEFAULT_UNITS, type Units } from './units.ts'

// wxHud.ts imports its CSS for Vite. Node cannot load CSS, so this test process loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { drawStrip, mountWxHud, stripPlot } = await import('./wxHud.ts')

// Node has no DOM: just enough of one for mountWxHud, with counters for what is written.
interface Call { op: string; a: unknown[]; fill: string; stroke: string; alpha: number; dash: number[] }
class Ctx {
  calls: Call[] = []
  fillStyle = '#000'
  strokeStyle = '#000'
  lineWidth = 1
  font = ''
  textAlign = 'start'
  textBaseline = 'alphabetic'
  globalAlpha = 1
  #dash: number[] = []
  transform: number[] = []
  #note(op: string, a: unknown[]): void {
    this.calls.push({ op, a, fill: this.fillStyle, stroke: this.strokeStyle, alpha: this.globalAlpha, dash: this.#dash })
  }
  clearRect(...a: number[]): void { this.#note('clearRect', a) }
  fillRect(...a: number[]): void { this.#note('fillRect', a) }
  strokeRect(...a: number[]): void { this.#note('strokeRect', a) }
  beginPath(): void { this.#note('beginPath', []) }
  moveTo(...a: number[]): void { this.#note('moveTo', a) }
  lineTo(...a: number[]): void { this.#note('lineTo', a) }
  stroke(): void { this.#note('stroke', []) }
  fill(): void { this.#note('fill', []) }
  fillText(...a: unknown[]): void { this.#note('fillText', a) }
  setLineDash(d: number[]): void { this.#dash = d }
  setTransform(...a: number[]): void { this.transform = a }
  texts(): string[] { return this.calls.filter((c) => c.op === 'fillText').map((c) => String(c.a[0])) }
  rects(color: string): Call[] { return this.calls.filter((c) => c.op === 'fillRect' && c.fill === color) }
}

class El {
  tag: string
  children: El[] = []
  parent: El | null = null
  className = ''
  #text = ''
  textWrites = 0
  hiddenWrites = 0
  #hidden = false
  attrs: Record<string, string> = {}
  vars: Record<string, string> = {}
  setProps = 0
  removed: string[] = []
  offsetHeight = 0
  clientWidth = 0
  width = 300
  height = 150
  ctx = new Ctx()
  style = {
    setProperty: (k: string, v: string): void => { this.setProps++; this.vars[k] = v },
    removeProperty: (k: string): void => { this.removed.push(k); delete this.vars[k] },
  }
  constructor(tag: string) {
    this.tag = tag
  }
  get textContent(): string { return this.#text }
  set textContent(v: string) { this.textWrites++; this.#text = v }
  get hidden(): boolean { return this.#hidden }
  set hidden(v: boolean) { this.hiddenWrites++; this.#hidden = v }
  append(...cs: El[]): void { for (const c of cs) { c.parent = this; this.children.push(c) } }
  remove(): void {
    if (!this.parent) return
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }
  setAttribute(k: string, v: string): void { this.attrs[k] = v }
  getContext(): Ctx { return this.ctx }
}
Object.assign(globalThis, { document: { createElement: (tag: string) => new El(tag) } })

const all = (el: El): El[] => [el, ...el.children.flatMap(all)]
const byClass = (root: El, cls: string): El => all(root).find((e) => e.className.split(' ').includes(cls))!

function mount() {
  const root = new El('div')
  const hud = mountWxHud(root as unknown as HTMLElement)
  const [veil, box] = root.children
  const cloud = byClass(box, 'fh-wxhud-chip')
  const hazard = byClass(box, 'fh-wxhud-hazard')
  return {
    root, hud, veil, box, cloud, hazard, strip: byClass(box, 'fh-wxhud-strip'), canvas: byClass(box, 'fh-wxhud-cv'),
    cloudText: byClass(cloud, 'fh-wxhud-text'), hazardText: byClass(hazard, 'fh-wxhud-text'), dot: byClass(cloud, 'fh-wxhud-dot'),
  }
}
type Mounted = ReturnType<typeof mount>

const status = (cloud: Partial<AheadStatus['cloud']> = {}, hazard: AheadStatus['hazard'] = null): AheadStatus => ({ cloud: { inside: false, sev: 0, inMin: null, ...cloud }, hazard })
const PATH = aheadPath({ lat: 32, lon: 34.9, altM: 3000 }, 0, 360, 0)!
/** A profile with weather in the cells given: [column, row, cover, severity]. */
function profile(cells: [number, number, number, number][] = [], hazards: AheadProfile['hazards'] = []): AheadProfile {
  const [cover, sev] = [new Float32Array(PROFILE_COLS * PROFILE_ROWS), new Float32Array(PROFILE_COLS * PROFILE_ROWS)]
  for (const [i, j, c, s] of cells) { cover[j * PROFILE_COLS + i] = c; sev[j * PROFILE_COLS + i] = s }
  return { cols: PROFILE_COLS, rows: PROFILE_ROWS, kmAhead: 80, topM: PROFILE_TOP_M, cover, sev, hazards }
}
/** What is on screen: a part inside the hidden HUD is not. */
const visible = (m: Mounted): { box: boolean; veil: boolean; hazard: boolean; strip: boolean } =>
  ({ box: !m.box.hidden, veil: !m.veil.hidden, hazard: !m.box.hidden && !m.hazard.hidden, strip: !m.box.hidden && !m.strip.hidden })

test('mounted: a frame (the veil) and the HUD in the root, both hidden; the status line a live region; nothing published until there is something', () => {
  const m = mount()
  assert.deepEqual(m.root.children, [m.veil, m.box])
  assert.equal(m.veil.className, 'fh-wxhud-veil')
  assert.equal(m.veil.attrs['aria-hidden'], 'true')
  assert.equal(m.box.className, 'fh-wxhud')
  assert.deepEqual(visible(m), { box: false, veil: false, hazard: false, strip: false })
  assert.equal(byClass(m.box, 'fh-wxhud-lines').attrs.role, 'status')
  assert.equal(m.canvas.attrs.role, 'img')
  assert.deepEqual(m.root.vars, {})
  m.hud.set(null, null, null, DEFAULT_UNITS)
  assert.deepEqual(visible(m), { box: false, veil: false, hazard: false, strip: false })
})

test('the status line: where the aircraft is, in the words and the dot of its severity; clear air is green', () => {
  const m = mount()
  m.hud.set(status({ inside: true, sev: 1, inMin: 0 }), null, null, DEFAULT_UNITS)
  assert.equal(m.cloudText.textContent, 'In light rain')
  assert.equal(m.dot.vars['--c'], '#58a6ff')
  assert.deepEqual(visible(m), { box: true, veil: false, hazard: false, strip: false })
  m.hud.set(status({ sev: 3, inMin: 3.1 }), null, null, DEFAULT_UNITS)
  assert.equal(m.cloudText.textContent, 'Clear air · a thunderstorm in 3 min')
  assert.equal(m.dot.vars['--c'], '#ff4d3d')
  m.hud.set(status(), null, null, DEFAULT_UNITS)
  assert.equal(m.cloudText.textContent, 'Clear air ahead')
  assert.equal(m.dot.vars['--c'], 'var(--fh-ok)')
  m.hud.set(status({ inside: true, sev: 0, inMin: 0 }), null, null, DEFAULT_UNITS)
  assert.equal(m.cloudText.textContent, 'In cloud')
  assert.equal(m.dot.vars['--c'], '#f2f5f8')
})

test('a hazard area: its chip under the status line, and the red frame round the view only while the aircraft is inside it', () => {
  const m = mount()
  m.hud.set(status({}, { inside: true, inMin: 0, text: 'embedded thunderstorms, up to 35,000 ft' }), null, null, DEFAULT_UNITS)
  assert.equal(m.hazardText.textContent, 'Inside hazard area · embedded thunderstorms, up to 35,000 ft')
  assert.deepEqual(visible(m), { box: true, veil: true, hazard: true, strip: false })
  m.hud.set(status({}, { inside: false, inMin: 2.2, text: 'icing, 8,000 to 20,000 ft' }), null, null, DEFAULT_UNITS)
  assert.equal(m.hazardText.textContent, 'Hazard area in 2 min · icing, 8,000 to 20,000 ft')
  assert.deepEqual(visible(m), { box: true, veil: false, hazard: true, strip: false }, 'ahead of it: no frame')
  m.hud.set(status(), null, null, DEFAULT_UNITS)
  assert.deepEqual(visible(m), { box: true, veil: false, hazard: false, strip: false }, 'none on the path')
  m.hud.set(status({}, { inside: true, inMin: 0, text: 'x' }), null, null, DEFAULT_UNITS)
  m.hud.set(null, null, null, DEFAULT_UNITS)
  assert.deepEqual(visible(m), { box: false, veil: false, hazard: false, strip: false }, 'no status: the whole HUD and the frame go')
})

test('the ahead strip: shown with a profile and a path while it is on; Ahead strip off, or no profile, hides it; turning it on draws from what was last given', () => {
  const m = mount()
  const s = status({ sev: 2, inMin: 4 })
  m.hud.set(s, profile(), PATH, DEFAULT_UNITS)
  assert.equal(m.strip.hidden, false)
  assert.ok(m.canvas.ctx.calls.length > 0 && m.canvas.ctx.calls[0].op === 'clearRect', 'drawn')
  m.hud.setStrip(false)
  assert.equal(m.strip.hidden, true)
  const drawn = m.canvas.ctx.calls.length
  m.hud.set(s, profile(), PATH, DEFAULT_UNITS)
  assert.equal(m.strip.hidden, true)
  assert.equal(m.canvas.ctx.calls.length, drawn, 'off: nothing is drawn')
  m.hud.setStrip(true)
  assert.equal(m.strip.hidden, false)
  assert.ok(m.canvas.ctx.calls.length > drawn, 'drawn at once from the last set')
  m.hud.set(s, null, PATH, DEFAULT_UNITS)
  assert.equal(m.strip.hidden, true, 'no profile (the app skips it while the strip is off)')
  m.hud.set(s, profile(), null, DEFAULT_UNITS)
  assert.equal(m.strip.hidden, true, 'no path')
  assert.equal(m.box.hidden, false, 'the status line is still up')
})

test('the strip is drawn at the width it is laid out at, as sharp as the screen (up to 2×), its height the same shape', () => {
  const m = mount()
  m.canvas.clientWidth = 360
  m.hud.set(status(), profile(), PATH, DEFAULT_UNITS)
  assert.deepEqual([m.canvas.width, m.canvas.height], [360, Math.round(360 * 0.28)])
  assert.deepEqual(m.canvas.ctx.transform, [1, 0, 0, 1, 0, 0])
  ;(globalThis as { devicePixelRatio?: number }).devicePixelRatio = 3
  try {
    m.hud.set(status(), profile(), PATH, DEFAULT_UNITS)
    assert.deepEqual([m.canvas.width, m.canvas.height], [720, Math.round(360 * 0.28) * 2], 'at most 2×')
    assert.deepEqual(m.canvas.ctx.transform, [2, 0, 0, 2, 0, 0])
  } finally {
    delete (globalThis as { devicePixelRatio?: number }).devicePixelRatio
  }
  const n = mount()
  n.hud.set(status(), profile(), PATH, DEFAULT_UNITS) // not laid out (no width): 400
  assert.deepEqual([n.canvas.width, n.canvas.height], [400, 112])
})

test('what has not changed is not written again: the line says the same thing most of the time', () => {
  const m = mount()
  const s = status({ sev: 1, inMin: 5 }, { inside: false, inMin: 3, text: 'icing' })
  m.hud.set(s, null, null, DEFAULT_UNITS)
  const [a, b, c, d] = [m.cloudText.textWrites, m.hazardText.textWrites, m.dot.setProps, m.box.hiddenWrites + m.hazard.hiddenWrites + m.veil.hiddenWrites]
  m.hud.set(status({ sev: 1, inMin: 5.2 }, { inside: false, inMin: 3.3, text: 'icing' }), null, null, DEFAULT_UNITS) // the same words
  assert.deepEqual([m.cloudText.textWrites, m.hazardText.textWrites, m.box.hiddenWrites + m.hazard.hiddenWrites + m.veil.hiddenWrites], [a, b, d])
  assert.equal(m.dot.setProps, c, 'nor the dot\'s colour')
  m.hud.set(status({ sev: 1, inMin: 6.2 }, { inside: false, inMin: 3.3, text: 'icing' }), null, null, DEFAULT_UNITS)
  assert.equal(m.cloudText.textWrites, a + 1, 'a new minute is new words')
  assert.equal(m.hazardText.textWrites, b)
})

test('its height is published as --fh-wxhud-h on the root for the toasts to stand under it: when it changes, and gone with the HUD', () => {
  const m = mount()
  m.box.offsetHeight = 41.2
  m.hud.set(status(), null, null, DEFAULT_UNITS)
  assert.equal(m.root.vars['--fh-wxhud-h'], '42px')
  const writes = m.root.setProps
  m.hud.set(status(), null, null, DEFAULT_UNITS)
  assert.equal(m.root.setProps, writes, 'the same height is not written again')
  m.box.offsetHeight = 172
  m.hud.set(status(), profile(), PATH, DEFAULT_UNITS)
  assert.equal(m.root.vars['--fh-wxhud-h'], '172px')
  m.hud.set(null, null, null, DEFAULT_UNITS)
  assert.deepEqual(m.root.vars, {}, 'hidden: none')
  m.hud.set(status(), null, null, DEFAULT_UNITS)
  assert.equal(m.root.vars['--fh-wxhud-h'], '172px')
  m.hud.destroy()
  assert.deepEqual(m.root.vars, {})
  assert.deepEqual(m.root.children, [], 'the frame and the HUD are gone')
})

test('the stylesheet: a hidden part really goes (its chips and veil are flex and absolute boxes), the toasts stand under the HUD, and the frame is inset', () => {
  const css = readFileSync(new URL('./wxHud.css', import.meta.url), 'utf8')
  assert.match(css, /\.fh-wxhud\[hidden\],\s*\.fh-wxhud \[hidden\],\s*\.fh-wxhud-veil\[hidden\] \{\s*display: none !important;\s*\}/)
  assert.match(css, /\.fh-wxhud-veil \{[^}]*inset: 0;[^}]*pointer-events: none;[^}]*box-shadow: inset 0 0 0 2px #ff5a5a, inset 0 0 46px/)
  assert.match(css, /\.fh-ui:has\(> \.fh-wxhud:not\(\[hidden\]\)\) \.fh-toasts \{\s*top: calc\(var\(--fh-top\) \+ 54px \+ var\(--fh-wxhud-h, 0px\)/)
  assert.match(css, /\.fh-wxhud \{[^}]*pointer-events: none;/)
})

// ---- the strip's drawing ---------------------------------------------------------------------------------------------------

const [W, H] = [400, 112]
const draw = (p: AheadProfile, units: Units = DEFAULT_UNITS, path = PATH): Ctx => {
  const ctx = new Ctx()
  drawStrip(ctx as unknown as CanvasRenderingContext2D, W, H, p, path, units)
  return ctx
}

test('drawStrip: the heights in the frame\'s units, at the same gridlines: feet, metres, or feet with metres to the right', () => {
  assert.deepEqual(draw(profile()).texts().filter((t) => /ft|m$/.test(t) && !/min/.test(t)), ['10,000 ft', '20,000 ft', '30,000 ft', '40,000 ft'])
  assert.deepEqual(draw(profile(), { ...DEFAULT_UNITS, alt: 'm' }).texts().filter((t) => !/min/.test(t)), ['3,000 m', '6,000 m', '9,000 m', '12,000 m'])
  const both = draw(profile(), { ...DEFAULT_UNITS, alt: 'ft+m' })
  assert.deepEqual(both.texts().filter((t) => !/min/.test(t)), ['10,000 ft', '3,050 m', '20,000 ft', '6,100 m', '30,000 ft', '9,150 m', '40,000 ft', '12,200 m'])
  const left = both.calls.filter((c) => c.op === 'fillText' && /ft$/.test(String(c.a[0]))).map((c) => c.a[1] as number)
  const right = both.calls.filter((c) => c.op === 'fillText' && /m$/.test(String(c.a[0])) && !/min/.test(String(c.a[0]))).map((c) => c.a[1] as number)
  const p = stripPlot(W, H, { ...DEFAULT_UNITS, alt: 'ft+m' })
  assert.ok(left.every((x) => x < p.x0) && right.every((x) => x > p.x1), 'ft left of the plot, m right of it')
  assert.ok(p.x1 < stripPlot(W, H, DEFAULT_UNITS).x1, 'the plot gives the metres their room')
})

test('drawStrip: a gridline stands at its height: 30,000 ft at 9,144 of 12,500 m up the plot', () => {
  const ctx = draw(profile())
  const p = stripPlot(W, H, DEFAULT_UNITS)
  const text = ctx.calls.find((c) => c.op === 'fillText' && c.a[0] === '30,000 ft')!
  assert.ok(Math.abs((text.a[2] as number) - (p.y1 - (9144 / PROFILE_TOP_M) * (p.y1 - p.y0))) < 1e-9)
})

test('drawStrip: the minutes under the plot, each at its distance along 80 km; a slow aircraft\'s minutes are close, so only those with room are named; none past 80 km', () => {
  const p = stripPlot(W, H, DEFAULT_UNITS)
  const at = (ctx: Ctx, t: string): number => ctx.calls.find((c) => c.op === 'fillText' && c.a[0] === t)!.a[1] as number
  const fast = draw(profile())
  assert.deepEqual(fast.texts().filter((t) => /min/.test(t)), ['1 min', '2 min', '3 min', '4 min', '5 min', '6 min'], '360 kt: 11.1 km a minute')
  assert.ok(Math.abs(at(fast, '3 min') - (p.x0 + ((3 * PATH.kmPerMin) / 80) * (p.x1 - p.x0))) < 1e-9)
  const quick = draw(profile(), DEFAULT_UNITS, aheadPath({ lat: 32, lon: 34.9, altM: 3000 }, 0, 480, 0)!)
  assert.deepEqual(quick.texts().filter((t) => /min/.test(t)), ['1 min', '2 min', '3 min', '4 min', '5 min'], '480 kt: the sixth is at 89 km')
  const slow = draw(profile(), DEFAULT_UNITS, aheadPath({ lat: 32, lon: 34.9, altM: 3000 }, 0, 100, 0)!)
  const named = slow.texts().filter((t) => /min/.test(t))
  assert.ok(named.length >= 2 && named.length < 6, `100 kt: ${named.join(', ')}`)
  const xs = named.map((t) => at(slow, t))
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= 44, 'room between the labels')
})

test('drawStrip: a cell is drawn where the cover is over 0.25, in its severity\'s colour, the more solid the cover the stronger; none for less', () => {
  const p = stripPlot(W, H, DEFAULT_UNITS)
  const [cw, ch] = [(p.x1 - p.x0) / PROFILE_COLS, (p.y1 - p.y0) / PROFILE_ROWS]
  const ctx = draw(profile([[10, 5, 1, 3], [11, 5, 0.2, 3], [12, 5, 0.6, 1], [13, 5, 0.25, 2], [20, 30, 0.8, 2.4], [30, 40, 0.5, 0]]))
  const storm = ctx.rects('#ff4d3d')
  assert.equal(storm.length, 1)
  assert.ok(Math.abs((storm[0].a[0] as number) - (p.x0 + 10 * cw)) < 1e-9 && Math.abs((storm[0].a[1] as number) - (p.y1 - 6 * ch)) < 1e-9, 'column 10, row 5 (the sixth up from the bottom)')
  assert.equal(storm[0].alpha, 1, '0.35 + 1, kept to 1')
  const rain = ctx.rects('#58a6ff')
  assert.equal(rain.length, 1)
  assert.ok(Math.abs(rain[0].alpha - 0.95) < 1e-6, '0.35 + 0.6 (the cover is a float32)')
  assert.equal(ctx.rects('#ffbe3d').length, 1, 'one heavy rain: 2.4 is step 2; the 0.25 is not over 0.25')
  assert.equal(ctx.rects('#f2f5f8').length, 1, 'and cloud')
})

test('drawStrip: a hazard area is a dashed red box over the stretch it is crossed, from its base to its top, tinted inside', () => {
  const p = stripPlot(W, H, DEFAULT_UNITS)
  const ctx = draw(profile([], [{ fromKm: 40, toKm: 60, baseM: 3000, topM: 10_000 }]))
  const boxes = ctx.calls.filter((c) => c.op === 'strokeRect')
  assert.equal(boxes.length, 1)
  assert.equal(boxes[0].stroke, '#ff5a5a')
  assert.ok(boxes[0].dash.length > 0, 'dashed')
  const [x, y, w, h] = boxes[0].a as number[]
  const pw = p.x1 - p.x0
  const ph = p.y1 - p.y0
  assert.ok(Math.abs(x - (p.x0 + 0.5 * pw)) < 1e-9 && Math.abs(w - 0.25 * pw) < 1e-9)
  assert.ok(Math.abs(y - (p.y1 - (10_000 / PROFILE_TOP_M) * ph)) < 1e-9 && Math.abs(h - ((7000 / PROFILE_TOP_M) * ph)) < 1e-9, 'from 3,000 m to 10,000 m')
  const tint = ctx.calls.filter((c) => c.op === 'fillRect' && c.fill === '#ff5a5a')
  assert.equal(tint.length, 1)
  assert.ok(tint[0].alpha < 0.3)
  const high = draw(profile([], [{ fromKm: 0, toKm: 20, baseM: 0, topM: 30_000 }])).calls.find((c) => c.op === 'strokeRect')!
  assert.ok(Math.abs((high.a[1] as number) - p.y0) < 1e-9, 'a top above the strip is held to its top edge')
})

test('drawStrip: the aircraft\'s way is a dashed yellow line from its height now, a marker on it, to the plot\'s far edge at the height it reaches; a climb rises, and the strip\'s top holds it', () => {
  const p = stripPlot(W, H, DEFAULT_UNITS)
  const Y = (m: number): number => p.y1 - (Math.min(m, PROFILE_TOP_M) / PROFILE_TOP_M) * (p.y1 - p.y0)
  const level = draw(profile())
  const start = level.calls.find((c) => c.op === 'moveTo' && c.stroke === '#ffd23f')!
  assert.deepEqual(start.a, [p.x0, Y(3000)])
  assert.ok(start.dash.length > 0)
  const way = (ctx: Ctx): Call[] => ctx.calls.filter((c) => c.op === 'lineTo' && c.stroke === '#ffd23f' && c.dash.length > 0) // (the marker is not dashed)
  const last = way(level).at(-1)!
  assert.ok(Math.abs((last.a[0] as number) - p.x1) < 1e-9 && Math.abs((last.a[1] as number) - Y(3000)) < 1e-9, 'level: level')
  assert.ok(level.calls.some((c) => c.op === 'fill' && c.fill === '#ffd23f'), 'the marker')
  const up = draw(profile(), DEFAULT_UNITS, aheadPath({ lat: 32, lon: 34.9, altM: 3000 }, 0, 360, 2000)!)
  const upEnd = way(up).at(-1)!
  const wantM = 3000 + 2000 * 0.3048 * (80 / PATH.kmPerMin)
  assert.ok(Math.abs((upEnd.a[1] as number) - Y(wantM)) < 1e-6, `${upEnd.a[1]} against ${Y(wantM)}`)
  const steep = draw(profile(), DEFAULT_UNITS, aheadPath({ lat: 32, lon: 34.9, altM: 9000 }, 0, 360, 6000)!)
  assert.ok(Math.abs((way(steep).at(-1)!.a[1] as number) - p.y0) < 1e-9, 'held to the top')
})

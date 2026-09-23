// harness/scenario-ui.ts
// Task 6 harness: /harness/scenario-ui.html mounts the scenario UI over a still painted scene with fake data: the
// Scenarios panel in a real rail, the play bar, the captions and the ending. A small clock plays the app's part, so
// play/pause, drag, ticks, speed, exit and Close all work. The phase times are rough (harness only); the caption lines
// are samples from the research notes (.planning/reports/scenarios/cvr.md §2), the real transcript is the package's.
//   ?state=play (default) | panel | crew | loading | error | captions | fade | dark | card    a still for screenshots
//     (dark: paused in the black seconds before the card, where only the play bar must still show and answer)
//   ?bg=day | bright | night    ?chrome=0 hides the harness buttons    ?t=<seconds> starts there
import '../client/ui/theme.css'
import '../client/ui/layout.css'
import '../client/ui/flightCard.css' // .fh-pill (the app loads it with the flight card)
import { clockToS as clk } from '../client/scenario/format.ts'
import type { ScenarioCard } from '../client/scenario/types.ts'
import { mountCaptions, type CaptionView } from '../client/ui/captions.ts'
import { mountEnding } from '../client/ui/ending.ts'
import { clockText, mountPlaybar } from '../client/ui/playbar.ts'
import { mountRail } from '../client/ui/rail.ts'
import { mountScenarioPanel } from '../client/ui/scenarioPanel.ts'

const START = clk('18:11:15')
const END = clk('18:56:28')
const ENDING = { fadeFrom: clk('18:56:17'), darkAt: clk('18:56:22'), cardAfterS: 5 }
const STOP = Math.max(END, ENDING.darkAt + ENDING.cardAfterS)
const RATES = [1, 2, 4, 8, 16]

const CARD: ScenarioCard = {
  id: 'jal123',
  title: 'Japan Air Lines Flight 123',
  subtitle: 'Tokyo Haneda to Osaka Itami',
  date: '1985-08-12',
  clockLabel: 'JST',
  note: 'Reconstructed from the official report of the Aircraft Accident Investigation Commission (1987). Captions are the official record; the path between known points is estimated.',
  summary: [
    'Boeing 747SR-46 JA8119 with 524 people aboard, 509 passengers and 15 crew.',
    'Twelve minutes after take-off the aft pressure bulkhead failed: most of the fin was lost, and all four hydraulic systems with it.',
    'The crew kept the aircraft flying for 32 minutes on engine thrust alone.',
  ],
  crew: [
    { role: 'Captain', name: 'Masami Takahama', detail: 'right seat, instructor' },
    { role: 'First Officer', name: 'Yutaka Sasaki', detail: 'left seat, flying' },
    { role: 'Flight Engineer', name: 'Hiroshi Fukuda' },
  ],
  aircraft: { registration: 'JA8119', type: 'Boeing 747SR-46', callsign: 'JAL123', operator: 'Japan Air Lines', model: 'b744' },
  start: START,
  end: END,
}

const MARKS = [
  ['18:24:35', 'Failure'],
  ['18:28:35', 'Uncontrollable'],
  ['18:39:32', 'Gear down'],
  ['18:45:46', 'Uncontrollable'],
  ['18:47:17', 'Uncontrollable'],
  ['18:49:42', 'Stall'],
  ['18:51:06', 'Flaps'],
  ['18:53:31', 'Uncontrollable'],
  ['18:55:05', 'Last ATC contact'],
].map(([c, label]) => ({ t: clk(c), label }))

// Harness only: rough phase starts, for the label.
const PHASES = [
  ['18:11:15', 'Take-off Haneda 15L'],
  ['18:13:00', 'Climb over Tokyo Bay'],
  ['18:18:00', 'Direct to Seaperch'],
  ['18:24:35', 'Failure: loss of hydraulics'],
  ['18:26:00', 'Phugoid and Dutch roll'],
  ['18:33:00', 'Turning north over Suruga Bay'],
  ['18:38:00', 'West of Mt Fuji'],
  ['18:39:32', 'Gear down'],
  ['18:41:00', 'Otsuki loop'],
  ['18:46:00', 'Descent toward Okutama'],
  ['18:48:00', 'Low over Okutama'],
  ['18:49:30', 'Stall and recovery'],
  ['18:51:06', 'Flaps on alternate power'],
  ['18:54:00', 'Final turn'],
].map(([c, label]) => ({ t: clk(c), label }))

// Sample lines (research notes, cvr.md §2), timed as there; dur is the seconds on screen.
const LINES: (CaptionView & { t: number; dur: number })[] = [
  { t: clk('18:24:35'), dur: 3, key: 'l1', who: 'Captain', to: null, channel: 'cockpit', translated: false, unintelligible: true, text: '[unintelligible]', original: null },
  { t: clk('18:28:35'), dur: 5, key: 'l2', who: 'Captain', to: 'Tokyo Control', channel: 'radio', translated: false, unintelligible: false, text: 'But now uncontrol.', original: null },
  { t: clk('18:31:26'), dur: 5, key: 'l3', who: 'Tokyo Control', to: 'Captain', channel: 'radio', translated: false, unintelligible: false, text: 'You may speak in Japanese from now on.', original: null },
  { t: clk('18:45:46'), dur: 5, key: 'l4', who: 'Captain', to: 'Tokyo Control', channel: 'radio', translated: false, unintelligible: false, text: 'Japan Air 123, uncontrollable.', original: null },
  { t: clk('18:46:16'), dur: 5, key: 'l5', who: 'Captain', to: 'Tokyo Control', channel: 'radio', translated: true, unintelligible: false, text: 'Stay with us, please.', original: 'このままでお願いします' },
]
// A still with three lines at once (one of each style), for the captions screenshot.
const STILL_LINES: CaptionView[] = [
  { ...LINES[3], key: 's1' },
  { ...LINES[4], key: 's2' },
  { ...LINES[0], key: 's3' },
]

const ENDING_CARD = {
  title: 'Japan Air Lines Flight 123 · 12 August 1985',
  lines: [
    'Boeing 747SR-46 JA8119, Tokyo Haneda to Osaka Itami.',
    'At 18:56 the aircraft struck the Osutaka Ridge in Ueno Village, Gunma. Of the 524 people aboard, 509 passengers and 15 crew, 520 died. Four survived.',
    'The crew kept the aircraft flying for 32 minutes after its aft pressure bulkhead failed and took all four hydraulic systems with it.',
    'Every 12 August families and JAL staff climb to the ridge; a moment of silence is held at 18:56.',
    "JAL's Safety Promotion Center at Haneda keeps the wreckage and the lessons of this accident.",
    'Reconstruction from the official report of the Aircraft Accident Investigation Commission (1987).',
  ],
}

const q = new URLSearchParams(location.search)
const state = q.get('state') ?? 'play'
document.body.dataset.bg = q.get('bg') ?? 'day'
document.body.dataset.chrome = q.get('chrome') ?? '1'

const ui = document.getElementById('ui')!
const chrome = document.getElementById('chrome')!
const logBox = document.createElement('pre')
logBox.id = 'log'
const log: string[] = []
function note(s: string): void {
  log.unshift(s)
  log.length = Math.min(log.length, 5)
  logBox.textContent = log.join('\n')
  console.log('[scenario-ui]', s)
}

// The app's clock (ScenarioClock's rules: clamps to [start, stop], stops at stop, Play at stop restarts).
let t = Number(q.get('t') ?? NaN)
if (!Number.isFinite(t)) t = { captions: clk('18:46:18'), fade: clk('18:56:19') + 0.5, dark: ENDING.darkAt + 2, card: STOP }[state] ?? clk('18:24:30')
let playing = false
let rate = 1

const list = (): Promise<ScenarioCard[]> =>
  state === 'loading'
    ? new Promise(() => {})
    : state === 'error'
      ? Promise.reject(new Error('harness: list() failed on purpose'))
      : new Promise((res) => setTimeout(() => res([CARD]), 400))

let panel!: ReturnType<typeof mountScenarioPanel>
const rail = mountRail(ui, [
  { id: 'status', icon: 'status', label: 'Status', short: 'Status', group: 0, action: () => note('status') },
  { id: 'aircraft', icon: 'list', label: 'Aircraft list', short: 'Aircraft', group: 1, action: () => note('aircraft') },
  { id: 'scene', icon: 'layers', label: 'Scene', short: 'Scene', group: 1, action: () => note('scene') },
  { id: 'legend', icon: 'altitude', label: 'Altitude colours', short: 'Colours', group: 1, action: () => note('legend') },
  {
    id: 'scenarios', icon: 'film', label: 'Scenarios', short: 'Scenes', group: 2,
    panel: { title: 'Scenarios', mount: (body) => (panel = mountScenarioPanel(body, { list, onPlay: (id) => { note(`onPlay ${id}`); panel.setPlaying(id); t = START; playing = true } })) },
  },
  { id: 'info', icon: 'info', label: 'About', short: 'About', group: 2, action: () => note('about') },
])
panel.setPlaying('jal123')

function toggle(from: string): void {
  if (!playing && t >= STOP) t = START
  playing = !playing
  note(`${from} → ${playing ? 'play' : 'pause'}`)
}

const bar = mountPlaybar(ui, {
  start: START, stop: STOP, end: END, marks: MARKS, clockLabel: 'JST', title: CARD.title,
  onToggle: () => toggle('onToggle'),
  onSeek: (to) => {
    t = Math.min(STOP, Math.max(START, to))
    note(`onSeek ${clockText(t)} (${to.toFixed(1)})`)
  },
  onRate: () => {
    rate = RATES[(RATES.indexOf(rate) + 1) % RATES.length]
    note(`onRate → ${rate}×`)
  },
  onExit: () => note('onExit'),
})
const captions = mountCaptions(ui)
const ending = mountEnding(ui, { onClose: () => note('onClose') })

const smooth = (x: number): number => x * x * (3 - 2 * x)
function fadeAt(at: number): number {
  if (at < ENDING.fadeFrom) return 0
  if (at >= ENDING.darkAt) return 1
  return smooth((at - ENDING.fadeFrom) / (ENDING.darkAt - ENDING.fadeFrom))
}
const lastBefore = <T extends { t: number }>(xs: T[], at: number): T | undefined => xs.filter((x) => x.t <= at).at(-1)

let last = performance.now()
function frame(now: number): void {
  const dt = Math.min(0.25, (now - last) / 1000)
  last = now
  if (playing) {
    t += dt * rate
    if (t >= STOP) {
      t = STOP
      playing = false
    }
  }
  bar.update({ t, playing, rate, clock: clockText(t), phase: lastBefore(PHASES, t)?.label ?? null })
  const fade = fadeAt(t)
  const lines = state === 'captions' ? STILL_LINES : LINES.filter((l) => l.t <= t && t < l.t + l.dur).slice(-3)
  captions.update(fade >= 1 ? [] : lines)
  ending.update(fade, t >= ENDING.darkAt + ENDING.cardAfterS ? ENDING_CARD : null)
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

// Stands in for ScenarioRun's key listener (plan Task 9): Space plays/pauses unless a control that owns Space has focus.
window.addEventListener('keydown', (e) => {
  if (e.key !== ' ' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
  const el = e.target as HTMLElement
  if (el.closest('input, textarea, select, button, summary, [contenteditable]')) return
  e.preventDefault()
  toggle('app Space')
})

if (['panel', 'crew', 'loading', 'error'].includes(state)) rail.open('scenarios')
if (state === 'crew') setTimeout(() => document.querySelector('details.fh-scn-crew')?.setAttribute('open', ''), 450)

function button(label: string, onClick: () => void): void {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = label
  b.addEventListener('click', onClick)
  chrome.append(b)
}
for (const bg of ['day', 'bright', 'night']) button(`bg: ${bg}`, () => (document.body.dataset.bg = bg))
for (const s of ['play', 'panel', 'captions', 'fade', 'dark', 'card']) button(`state: ${s}`, () => (location.search = `?state=${s}&bg=${document.body.dataset.bg}`))
chrome.append(logBox)
note(`state ${state}, t ${clockText(t)}`)

;(window as unknown as { harness: object }).harness = {
  seek: (to: number) => (t = to),
  get t() {
    return t
  },
  get playing() {
    return playing
  },
}

// client/ui/playbar.ts
// The scenario play bar (bottom, between the left gutter and the rail; on phones on top of the tab bar): play/pause, the
// scenario clock with its zone, the phase, a scrubber over the timeline with the marks as ticks under it (a press seeks
// to one), the speed and exit. It only asks: onToggle, onSeek(t), onRate, onExit; the app answers through update(),
// which is cheap to call every frame (it writes only what changed, and leaves the thumb alone under a dragging finger).
// Keys on the focused scrubber: ←/→ ±10 s (Shift ±60 s), PgUp/PgDn ±60 s, Home/End, Space play/pause. Every other key,
// and all keys on the bar's buttons except Space (which presses them), belong to the app's own handler. A mouse or finger
// press leaves no focus on speed or a tick, so a later Space reaches the app (play/pause) instead of pressing them again.
import { sToClock } from '../scenario/format.ts'
import { icon } from './icons.ts'
import './playbar.css'

export interface PlaybarView {
  t: number // scenario seconds
  playing: boolean
  rate: number
  clock: string // clockText(t), e.g. '18:24:35'; the bar adds the zone label
  phase: string | null
}

/** The bar's clock text: whole seconds, floored (a second shows once it has begun), as the tick labels are. */
export const clockText = (t: number): string => sToClock(Math.floor(t))

export interface PlaybarOpts {
  start: number // the scrubber runs from start…
  stop: number // …to stop, the last second the clock reaches (the ending card may wait past the data)
  end: number // the last data second: stop is at least this
  marks: { t: number; label: string }[]
  clockLabel: string // 'JST'
  title: string
  onToggle(): void
  onSeek(t: number): void
  onRate(): void
  onExit(): void
}

export interface PlaybarHandle {
  update(v: PlaybarView): void
  destroy(): void
}

const STEP_S = 10
const BIG_STEP_S = 60

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = className
  if (text !== '') el.textContent = text
  return el
}

/** After a mouse or finger click (detail ≥ 1; a key's click has 0), let go of the focus Chrome leaves on the button: a
 *  later Space would press it again (a speed step, a jump back to the mark) where the user means play/pause. */
function dropPointerFocus(b: HTMLButtonElement, e: MouseEvent): void {
  if (e.detail > 0) b.blur()
}

function button(className: string, label: string): HTMLButtonElement {
  const b = h('button', className)
  b.type = 'button'
  b.setAttribute('aria-label', label)
  return b
}

export function mountPlaybar(root: HTMLElement, opts: PlaybarOpts): PlaybarHandle {
  // One bound for all of it (drag, keys, ticks, the thumb): every second the clock can reach.
  const { start } = opts
  const stop = Math.max(opts.end, opts.stop)
  const span = Math.max(stop - start, 1e-9)
  const pct = (t: number): number => Math.min(1, Math.max(0, (t - start) / span)) * 100

  const bar = h('div', 'fh-playbar fh-glass')
  bar.setAttribute('role', 'group')
  bar.setAttribute('aria-label', `Playback: ${opts.title}`)

  const play = button('fh-ibtn fh-playbar-play', 'Play')
  play.append(icon('play', 20))

  // Title, clock and phase: stacked beside the play button; on phones the clock and phase share a row above the rest.
  const meta = h('div', 'fh-playbar-meta')
  const clock = h('span', 'fh-playbar-clock fh-num')
  const time = h('span', 'fh-playbar-time')
  clock.append(time, h('span', 'fh-playbar-zone', opts.clockLabel))
  const phase = h('span', 'fh-playbar-phase')
  phase.hidden = true
  meta.append(h('span', 'fh-playbar-title', opts.title), clock, phase)

  // The scrubber in three layers: the rail (its played part and a dot per mark) under a native range input whose own
  // track is transparent (the thumb and the keys are the browser's), and over it the marks' buttons, round and clear,
  // each on its dot: a press on a dot seeks to that mark, a press anywhere else scrubs. A mark's label shows in a bubble
  // above it on hover or focus.
  const track = h('div', 'fh-playbar-track')
  const rail = h('div', 'fh-playbar-rail')
  rail.append(h('div', 'fh-playbar-fill'))
  const range = h('input', 'fh-playbar-range')
  range.type = 'range'
  range.min = String(start)
  range.max = String(stop)
  range.step = '0.1'
  range.setAttribute('aria-label', 'Scenario time')
  const ticks = h('div', 'fh-playbar-ticks')
  const dots: { t: number; el: HTMLElement }[] = []
  for (const m of opts.marks) {
    if (!(m.t >= start && m.t <= stop)) continue
    const label = `${m.label} · ${clockText(m.t)} ${opts.clockLabel}`
    const left = `${pct(m.t).toFixed(3)}%`
    const dot = h('span', 'fh-playbar-dot')
    dot.style.setProperty('left', left)
    rail.append(dot)
    dots.push({ t: m.t, el: dot })
    const tick = button('fh-playbar-tick', label)
    tick.setAttribute('data-label', label)
    tick.style.setProperty('left', left)
    tick.addEventListener('click', (e) => {
      opts.onSeek(m.t)
      dropPointerFocus(tick, e)
    })
    ticks.append(tick)
  }
  track.append(rail, range, ticks)

  const rate = button('fh-playbar-rate fh-num', 'Playback speed')
  rate.title = 'Playback speed'
  const exit = button('fh-ibtn fh-playbar-exit', 'Exit scenario')
  exit.title = 'Exit scenario'
  exit.append(icon('x', 18))

  bar.append(play, meta, track, rate, exit)
  root.append(bar)

  // What is on screen, so update() writes only what changed.
  let t = start
  let playing = false
  let shownClock: string | null = null
  let shownPhase: string | null | undefined
  let shownRate = NaN
  let shownValue = ''
  let shownFill = ''
  let dragging = false

  const fill = (at: number): void => {
    const f = `${pct(at).toFixed(2)}%`
    if (f === shownFill) return
    shownFill = f
    range.style.setProperty('--fh-p', f)
    rail.style.setProperty('--fh-p', f)
    for (const d of dots) d.el.classList.toggle('fh-past', d.t <= at) // the marks already passed, on the played part
  }

  play.addEventListener('click', () => opts.onToggle())
  rate.addEventListener('click', (e) => {
    opts.onRate()
    dropPointerFocus(rate, e)
  })
  exit.addEventListener('click', () => opts.onExit())

  range.addEventListener('input', () => {
    shownValue = range.value
    const at = Number(range.value)
    fill(at)
    opts.onSeek(at)
  })
  // While a finger or the mouse holds the thumb, the clock does not move it (it would slide out from under the finger).
  range.addEventListener('pointerdown', (e) => {
    dragging = true
    range.setPointerCapture?.(e.pointerId) // its pointerup comes back here even when released off the bar
  })
  for (const type of ['pointerup', 'pointercancel', 'change', 'blur']) range.addEventListener(type, () => (dragging = false))

  range.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    let to: number
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        to = t - (e.shiftKey ? BIG_STEP_S : STEP_S)
        break
      case 'ArrowRight':
      case 'ArrowUp':
        to = t + (e.shiftKey ? BIG_STEP_S : STEP_S)
        break
      case 'PageDown':
        to = t - BIG_STEP_S
        break
      case 'PageUp':
        to = t + BIG_STEP_S
        break
      case 'Home':
        to = start
        break
      case 'End':
        to = stop
        break
      case ' ':
        e.preventDefault()
        opts.onToggle()
        return
      default:
        return
    }
    e.preventDefault() // the native step (0.1 s) would be too fine to use
    opts.onSeek(Math.min(stop, Math.max(start, to)))
  })
  // Space presses a focused bar button (or plays, on the scrubber); the app's Space shortcut must not act on it again.
  bar.addEventListener('keydown', (e) => {
    if (e.key === ' ') e.stopPropagation()
  })

  return {
    update(v) {
      t = v.t
      if (v.playing !== playing) {
        playing = v.playing
        play.replaceChildren(icon(playing ? 'pause' : 'play', 20))
        play.setAttribute('aria-label', playing ? 'Pause' : 'Play')
      }
      if (v.clock !== shownClock) {
        shownClock = v.clock
        time.textContent = v.clock
        range.setAttribute('aria-valuetext', `${v.clock} ${opts.clockLabel}`)
      }
      if (v.phase !== shownPhase) {
        shownPhase = v.phase
        phase.textContent = v.phase ?? ''
        phase.title = v.phase ?? ''
        phase.hidden = v.phase === null
      }
      if (v.rate !== shownRate) {
        shownRate = v.rate
        rate.textContent = `${v.rate}×`
        rate.setAttribute('aria-label', `Playback speed ${v.rate}×`)
      }
      if (!dragging) {
        const value = v.t.toFixed(1)
        if (value !== shownValue) {
          shownValue = value
          range.value = value
          fill(v.t)
        }
      }
    },
    destroy() {
      bar.remove()
    },
  }
}

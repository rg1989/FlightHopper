// client/ui/playbar.ts
// The scenario play bar (bottom, between the left gutter and the rail; on phones on top of the tab bar): play/pause, the
// scenario clock with its zone, the phase, a scrubber over the timeline with the marks as ticks under it (a press seeks
// to one), the voices' mute and volume (with audio only), the speed and exit. It only asks: onToggle, onSeek(t), onRate,
// onExit, sound.onGain; the app answers through update(), which is cheap to call every frame (it writes only what
// changed, and leaves the thumb alone under a dragging finger).
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

export interface PlaybarSound {
  reenacted: boolean // a voice-over, not the recording: a note over the controls says so
  onGain(g: number): void // 0..1, 0 when muted: at mount (the setting this browser remembers) and on every change
}

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
  sound?: PlaybarSound | null // the scenario's audio is there
}

export interface PlaybarHandle {
  update(v: PlaybarView): void
  toggleMute(): void // M: nothing without sound
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

const SOUND_KEY = 'fh-scenario-sound'
export const REENACTED =
  'A reenactment: synthetic voices read the English translation of the official record. They are not the recorded voices of the crew or the controllers.'

interface SoundPref {
  volume: number
  muted: boolean
}

/** The volume this browser remembers: a convenience, so storage that is missing or throws gives the default. */
function readSound(): SoundPref {
  try {
    const p: unknown = JSON.parse(localStorage.getItem(SOUND_KEY) ?? 'null')
    const { volume, muted } = (p ?? {}) as Record<string, unknown>
    if (typeof volume === 'number' && volume >= 0 && volume <= 1 && typeof muted === 'boolean') return { volume, muted }
  } catch {
    // the default
  }
  return { volume: 0.8, muted: false }
}

function writeSound(p: SoundPref): void {
  try {
    localStorage.setItem(SOUND_KEY, JSON.stringify(p))
  } catch {
    // not remembered
  }
}

/** Mute and volume for the voices, and for a reenactment the note over them. Space on the slider plays or pauses. */
function soundControl(o: PlaybarSound, onToggle: () => void): { el: HTMLElement; toggle(): void } {
  const pref = readSound()
  const el = h('div', 'fh-playbar-sound')
  if (o.reenacted) {
    const note = h('span', 'fh-playbar-note', 'Reenacted voices')
    note.title = REENACTED
    el.append(note)
  }
  const mute = button('fh-ibtn fh-playbar-mute', 'Mute the voices')
  const vol = h('input', 'fh-playbar-vol')
  vol.type = 'range'
  vol.min = '0'
  vol.max = '1'
  vol.step = '0.05'
  vol.setAttribute('aria-label', 'Voice volume')
  const row = h('div', 'fh-playbar-vrow')
  row.append(mute, vol)
  el.append(row)

  let shownOff: boolean | null = null
  const apply = (): void => {
    const off = pref.muted || pref.volume === 0
    if (off !== shownOff) {
      shownOff = off
      mute.replaceChildren(icon(off ? 'muted' : 'volume', 18))
      mute.setAttribute('aria-label', off ? 'Unmute the voices' : 'Mute the voices')
      mute.title = off ? 'Unmute (M)' : 'Mute (M)'
    }
    vol.value = String(pref.volume)
    vol.style.setProperty('--fh-v', `${Math.round((off ? 0 : pref.volume) * 100)}%`)
    o.onGain(off ? 0 : pref.volume)
    writeSound(pref)
  }
  const toggle = (): void => {
    pref.muted = !pref.muted
    if (!pref.muted && pref.volume === 0) pref.volume = 0.8
    apply()
  }
  mute.addEventListener('click', (e) => {
    toggle()
    dropPointerFocus(mute, e)
  })
  vol.addEventListener('input', () => {
    pref.volume = Number(vol.value)
    if (pref.volume > 0) pref.muted = false
    apply()
  })
  vol.addEventListener('keydown', (e) => {
    if (e.key !== ' ') return
    e.preventDefault()
    onToggle()
  })
  apply()
  return { el, toggle }
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

  const sound = opts.sound ? soundControl(opts.sound, () => opts.onToggle()) : null
  if (sound !== null) bar.classList.add('fh-has-sound')

  bar.append(play, meta, track, ...(sound === null ? [] : [sound.el]), rate, exit)
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
    toggleMute() {
      sound?.toggle()
    },
    destroy() {
      bar.remove()
    },
  }
}

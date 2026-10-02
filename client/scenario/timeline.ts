// client/scenario/timeline.ts
// Pure lookups over a loaded scenario's events.csv and transcript.csv at a given clock time t: the event state
// (phase/gear/flaps/damage), the timeline's tick marks (and the one a step of playback passed), the captions on screen,
// and the ending fade/card. No DOM, no Cesium: ScenarioRun and the UI mounters call these once a frame with the clock's
// current t.
import type { EndingSpec, EventRow, Line } from './types.ts'

export interface EventState {
  phase: string | null
  gear: boolean
  flaps: number | null
  damage: ReadonlySet<string>
}

/** The state implied by every event at or before t: gear/flaps/phase take the latest row's value; damage accumulates. */
export function eventStateAt(events: readonly EventRow[], t: number): EventState {
  let phase: string | null = null
  let gear = false
  let flaps: number | null = null
  const damage = new Set<string>()
  for (const e of events) {
    if (e.t > t) continue
    switch (e.type) {
      case 'phase':
        phase = e.label
        break
      case 'gear':
        gear = e.value === '1'
        break
      case 'flaps':
        flaps = Number(e.value)
        break
      case 'damage':
        damage.add(e.value)
        break
    }
  }
  return { phase, gear, flaps, damage }
}

/**
 * A scenario's damage on the chase model: the paint map's whole cut (JAL 123: the upper fin, the rudders and the tail
 * cone), and the rudder lost between two heights, as fractions of the fin's height (0 root … 1 tip).
 */
export interface Damage {
  fin: boolean
  rudder: readonly [number, number] | null
}

export const NO_DAMAGE: Damage = { fin: false, rudder: null }

/** One damage event's value: 'fin', or 'rudder:<from>-<to>' (e.g. 'rudder:0.35-0.88'); null when it is neither. */
export function damagePart(v: string): Partial<Damage> | null {
  if (v === 'fin') return { fin: true }
  const m = /^rudder:(\d*\.?\d+)-(\d*\.?\d+)$/.exec(v)
  if (m === null) return null
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a >= 0 && a < b && b <= 1 ? { rudder: [a, b] } : null
}

/** The damage the event state's parts add up to (an unknown part is ignored; format.ts rejects it). */
export function damageOf(parts: ReadonlySet<string>): Damage {
  let d = NO_DAMAGE
  for (const v of parts) d = { ...d, ...damagePart(v) }
  return d
}

/** How long a story message stays, in scenario seconds, when its row gives no value. */
export const STORY_S = 12

/** A story message: the moment it tells of, and its text. key: stable per row. */
export interface Story {
  key: string
  t: number
  text: string
}

/** The story message at t: the latest `story` event with e.t ≤ t < e.t + (its value, else STORY_S) seconds; else null. */
export function storyAt(events: readonly EventRow[], t: number): Story | null {
  let out: Story | null = null
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (e.type !== 'story' || e.t > t) continue
    const dur = Number(e.value) > 0 ? Number(e.value) : STORY_S
    out = t < e.t + dur ? { key: `s${i}`, t: e.t, text: e.label } : null
  }
  return out
}

/** The timeline's tick marks: every `mark` event, in file order. */
export function marks(events: readonly EventRow[]): { t: number; label: string }[] {
  return events.filter((e) => e.type === 'mark').map((e) => ({ t: e.t, label: e.label }))
}

/** A mark as its title shows it (eventTitle.ts). key: stable per row. */
export interface PassedMark {
  key: string
  t: number
  label: string
}

/**
 * The mark playback passed going from t0 to t1: the latest `mark` event with t0 ≤ e.t ≤ t1 (so playing on from a mark
 * shows it), null when t1 ≤ t0 (paused) or none lies between. The caller passes only the clock's own advance: t0 is
 * where the step began, after any seek, so a seek passes nothing, however many marks it jumps. Assumes `events` in
 * time order (the loader's check), so the last match is the latest.
 */
export function markPassed(events: readonly EventRow[], t0: number, t1: number): PassedMark | null {
  if (!(t1 > t0)) return null
  let out: PassedMark | null = null
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (e.type === 'mark' && e.t >= t0 && e.t <= t1) out = { key: `m${i}`, t: e.t, label: e.label }
  }
  return out
}

/**
 * The lines on screen at t: l.t ≤ t < l.t + l.dur, newest `max` of them, oldest first. Assumes `lines` is already
 * in non-decreasing `t` order (transcript.csv, §3.1), so the active ones are already oldest-first: keep the tail.
 */
export function captionsAt(lines: readonly Line[], t: number, max = 3): Line[] {
  const active = lines.filter((l) => l.t <= t && t < l.t + l.dur)
  return active.slice(-max)
}

/**
 * fade: 0 before `fadeFrom`, a smoothstep over [fadeFrom, darkAt], 1 from `darkAt` on.
 * card: true once t reaches darkAt + cardAfterS. A null ending never fades or shows a card.
 */
export function endingAt(e: EndingSpec | null, t: number): { fade: number; card: boolean } {
  if (e === null) return { fade: 0, card: false }
  const fade = t <= e.fadeFrom ? 0 : t >= e.darkAt ? 1 : smoothstep(e.fadeFrom, e.darkAt, t)
  return { fade, card: t >= e.darkAt + e.cardAfterS }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const u = (x - edge0) / (edge1 - edge0)
  return u * u * (3 - 2 * u)
}

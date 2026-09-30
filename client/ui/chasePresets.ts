// client/ui/chasePresets.ts
// The chase camera's preset views, for the TV (?tv=1: app.ts mounts them then only): a column of glass pills under the
// rail's Layers square, shown in the chase only and not beside an open panel (chasePresets.css). OK on one glides the
// orbit there in GLIDE_S (glide: eased, the heading the short way round, the range in proportion), through the chase
// camera's own orbit (?cam=), never a jump. Auto tours them: a slower glide to each in turn (AUTO_ORDER), AUTO_HOLD_S on
// each, until another preset, Auto again, or a camera key (the remote's map mode: cancel()). The pill of the view on
// screen is marked (the orbit at a preset: presetAt; touring, Auto, and the view it is on dotted). The app steps it
// every frame (update), before the chase camera reads the orbit.
import type { Orbit } from './urlState.ts'
import './chasePresets.css'

export type PresetId = 'behind' | 'left' | 'right' | 'front' | 'above' | 'wide'

/** Heading offset from the nose (0 behind it, 90 on its left, -90 on its right), look pitch (negative: down), range. */
export const PRESETS: Readonly<Record<PresetId, Orbit & { label: string }>> = {
  behind: { label: 'Behind', headingDeg: 0, pitchDeg: -12, rangeM: 150 }, // the chase's own start (chaseCamera.ts)
  left: { label: 'Left side', headingDeg: 90, pitchDeg: -6, rangeM: 120 },
  right: { label: 'Right side', headingDeg: -90, pitchDeg: -6, rangeM: 120 },
  front: { label: 'Front', headingDeg: 180, pitchDeg: -5, rangeM: 130 },
  above: { label: 'Above', headingDeg: 0, pitchDeg: -80, rangeM: 230 },
  wide: { label: 'Wide', headingDeg: -35, pitchDeg: -22, rangeM: 1100 },
}
export const AUTO_ORDER: readonly PresetId[] = ['behind', 'left', 'front', 'right', 'above', 'wide']
export const GLIDE_S = 1.2 // a preset picked
export const AUTO_GLIDE_S = 4 // … and the tour's, slower: a camera move, not a cut
export const AUTO_HOLD_S = 15
const AT_DEG = 1 // presetAt: an orbit this close to a preset's angles …
const AT_RANGE = 0.02 // … and range (a share) is at it (?cam= keeps whole numbers)

/** Ease in and out (cubic) over k in [0, 1], clamped outside it. */
export function ease(k: number): number {
  const t = Math.min(1, Math.max(0, k))
  return t < 0.5 ? 4 * t ** 3 : 1 - (2 - 2 * t) ** 3 / 2
}

const turn = (deg: number): number => ((((deg + 180) % 360) + 360) % 360) - 180 // into [-180, 180)

/**
 * The orbit k of the way (0 → from, 1 → to) through a glide, eased: the heading the shorter way round (not wrapped:
 * OrbitControl.set wraps it), the pitch in step, the range by the same ratio each step (a zoom, not a slide).
 */
export function glide(from: Orbit, to: Orbit, k: number): Orbit {
  const e = ease(k)
  return {
    headingDeg: from.headingDeg + turn(to.headingDeg - from.headingDeg) * e,
    pitchDeg: from.pitchDeg + (to.pitchDeg - from.pitchDeg) * e,
    rangeM: from.rangeM * (to.rangeM / from.rangeM) ** e,
  }
}

/** The preset an orbit is at, or null (a view the remote's camera keys made). */
export function presetAt(o: Orbit): PresetId | null {
  for (const id of AUTO_ORDER) {
    const p = PRESETS[id]
    if (Math.abs(turn(o.headingDeg - p.headingDeg)) <= AT_DEG && Math.abs(o.pitchDeg - p.pitchDeg) <= AT_DEG && Math.abs(o.rangeM / p.rangeM - 1) <= AT_RANGE) return id
  }
  return null
}

// ---- DOM ----------------------------------------------------------------------------------------------------------

export interface ChasePresetsHandle {
  update(nowMs: number, chasing: boolean): void // every frame: the glide, the tour, the mark (out of the chase: the tour ends)
  cancel(): void // a camera key: the glide and the tour stop where they are
  focus(): void // the focus to the marked pill, else Behind
  destroy(): void
}

export function mountChasePresets(parent: HTMLElement, orbit: { get(): Orbit; set(o: Orbit): void }): ChasePresetsHandle {
  const row = document.createElement('div')
  row.className = 'fh-presets'
  row.setAttribute('role', 'toolbar')
  row.setAttribute('aria-label', 'Camera views')
  const ids = [...AUTO_ORDER, 'auto'] as const
  const pills = new Map(ids.map((id) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'fh-preset fh-glass'
    b.dataset.id = id
    b.textContent = id === 'auto' ? 'Auto' : PRESETS[id].label
    b.setAttribute('aria-pressed', 'false')
    b.addEventListener('click', () => choose(id))
    row.append(b)
    return [id, b] as const
  }))
  parent.append(row)

  let glider: { from: Orbit | null; to: PresetId; t0: number; s: number } | null = null // from null: set at its first frame
  let touring = false
  let stop = 0 // the tour's stop (AUTO_ORDER)
  let holdUntil = Infinity // touring: the next glide then
  let painted = ''

  function start(to: PresetId, s: number): void {
    glider = { from: null, to, t0: 0, s }
  }

  function choose(id: PresetId | 'auto'): void {
    if (id !== 'auto') {
      touring = false
      return start(id, GLIDE_S)
    }
    if (touring) return cancel() // Auto again: the tour stops where it is
    touring = true
    // On from the view on screen (or the one being glided to); from elsewhere, from the start.
    const at = glider?.to ?? presetAt(orbit.get())
    stop = at === null ? 0 : (AUTO_ORDER.indexOf(at) + 1) % AUTO_ORDER.length
    start(AUTO_ORDER[stop], AUTO_GLIDE_S)
  }

  function cancel(): void {
    glider = null
    touring = false
    holdUntil = Infinity
  }

  /** The pill of the view on screen marked (aria-pressed); touring, Auto, and the view it is on or going to dotted. */
  function paint(): void {
    const on = touring ? 'auto' : glider?.to ?? presetAt(orbit.get())
    const tour = touring ? (glider?.to ?? AUTO_ORDER[stop]) : null
    const key = `${on} ${tour}`
    if (key === painted) return
    painted = key
    for (const [id, b] of pills) {
      b.setAttribute('aria-pressed', String(id === on))
      b.classList.toggle('fh-touring', id === tour)
    }
  }

  return {
    update(now, chasing) {
      if (!chasing) {
        if (touring || glider !== null) cancel()
        return
      }
      if (glider === null && touring && now >= holdUntil) {
        stop = (stop + 1) % AUTO_ORDER.length
        start(AUTO_ORDER[stop], AUTO_GLIDE_S)
      }
      if (glider !== null) {
        if (glider.from === null) {
          glider.from = orbit.get()
          glider.t0 = now
        }
        const k = (now - glider.t0) / 1000 / glider.s
        orbit.set(glide(glider.from, PRESETS[glider.to], k))
        if (k >= 1) {
          glider = null
          holdUntil = touring ? now + AUTO_HOLD_S * 1000 : Infinity
        }
      }
      paint()
    },
    cancel() {
      cancel()
      paint()
    },
    focus() {
      const on = touring ? 'auto' : glider?.to ?? presetAt(orbit.get())
      pills.get(on ?? 'behind')!.focus({ preventScroll: true })
    },
    destroy() {
      row.remove()
    },
  }
}

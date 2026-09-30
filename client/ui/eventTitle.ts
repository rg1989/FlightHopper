// client/ui/eventTitle.ts
// A timeline mark's title, as a film shows its own: when playback passes a mark (timeline.ts markPassed), its label in
// large type, centred at the top of the view, fading in, holding and fading out. The hold is wall-clock time, so a title
// reads the same at 16×. A newer mark replaces the one up (never a pile); a seek takes it away. The band it shows in
// stays for the whole playback, as the captions' does: the flight-data frame lays out round it (app.ts FRAME_COVERS)
// and stays put as titles come and go. Where the title still meets the story message (under 900 px the band spans the
// top, and on phones the story does too), it moves down under it. Text only; it never takes the pointer. A polite live
// region, so a screen reader reads each title once.
import './eventTitle.css'

export interface EventTitleView {
  key: string
  text: string
}

/** How long a title stays before it fades out, from the moment it comes (wall-clock ms, whatever the rate). */
export const HOLD_MS = 4000
/** What the title keeps under when they would meet: the story message (story.ts) while it shows. */
const CLEAR_OF = '.fh-story:not(.fh-out)'
const GAP_PX = 12
const MEASURE_MS = 100 // a layout read at most this often, and only while a title shows

export interface EventTitleHandle {
  /** Once a frame. m: a mark playback just passed (its title replaces the one up), else null; jumped: a seek, which takes it away. */
  update(m: EventTitleView | null, jumped: boolean): void
  destroy(): void
}

export function mountEventTitle(root: HTMLElement, now: () => number = () => performance.now()): EventTitleHandle {
  const band = document.createElement('div')
  band.className = 'fh-event-title'
  const text = document.createElement('p')
  text.className = 'fh-event-title-x fh-out'
  text.setAttribute('role', 'status')
  text.setAttribute('aria-live', 'polite')
  band.append(text)
  root.append(band)

  let key: string | null = null // the title on screen (fading out included)
  let since = 0
  let out = true
  let dy = 0 // px moved down to clear the story
  let measuredAt = -Infinity

  /** Down under the story message when the two would meet, else home; the CSS glides it (translate). */
  function place(): void {
    measuredAt = now()
    const s = root.querySelector(CLEAR_OF)?.getBoundingClientRect()
    const r = text.getBoundingClientRect()
    const top = r.top - dy // where the band puts it
    const meet = s !== undefined && s.left < r.right && r.left < s.right && s.bottom + GAP_PX > top
    const want = meet ? Math.ceil(s.bottom + GAP_PX - top) : 0
    if (want === dy) return
    dy = want
    text.style.translate = dy === 0 ? '' : `0 ${dy}px`
  }

  return {
    update(m, jumped) {
      if (m !== null && m.key !== key) {
        key = m.key
        since = now()
        text.textContent = m.text
        text.classList.remove('fh-out', 'fh-in')
        text.style.transition = 'none' // a new title takes its place at once, not with a glide from the last one's
        place()
        void text.offsetWidth // commits that, and restarts the entry animation when one title replaces another
        text.style.transition = ''
        text.classList.add('fh-in')
        out = false
      } else if (!out && m === null && (jumped || now() - since >= HOLD_MS)) {
        text.classList.add('fh-out')
        out = true
        key = null
      } else if (!out && now() - measuredAt >= MEASURE_MS) {
        place() // a story message came or went under it
      }
    },
    destroy() {
      band.remove()
    },
  }
}

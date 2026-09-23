// client/ui/ending.ts
// The end of a scenario: a black veil over the whole screen whose opacity is the fade (timeline.endingAt), and, once
// given, the closing card in the middle: its title, its lines as paragraphs, and one button, Close. Nothing else: no
// replay, no share. The veil takes the pointer only once fully dark, so the camera stays free while it fades; once dark,
// nothing under it (the scene, the rail) is touched blind. The play bar stands above the veil while it shows (ending.css),
// so in the dark seconds before the card the clock, pause, scrubber and exit stay in reach, and a drag back on the
// timeline lifts the veil. update() runs every frame and writes only what changed. Text only.
import './ending.css'

export interface EndingCard {
  title: string
  lines: string[]
}

export interface EndingOpts {
  onClose(): void
}

export interface EndingHandle {
  update(fade: number, card: EndingCard | null): void
  destroy(): void
}

/** From this fade on the veil counts as dark: it blocks the scene under it. */
const SOLID = 0.99

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = className
  if (text !== '') el.textContent = text
  return el
}

export function mountEnding(root: HTMLElement, opts: EndingOpts): EndingHandle {
  const wrap = h('div', 'fh-ending')
  wrap.hidden = true
  const veil = h('div', 'fh-ending-veil')
  const card = h('section', 'fh-ending-card fh-glass')
  card.hidden = true
  card.setAttribute('role', 'dialog')
  const title = h('h2', 'fh-ending-title')
  const body = h('div', 'fh-ending-body')
  const close = h('button', 'fh-pill fh-pill-secondary fh-ending-close', 'Close')
  close.type = 'button'
  close.addEventListener('click', () => opts.onClose())
  const foot = h('div', 'fh-ending-foot')
  foot.append(close)
  card.append(title, body, foot)
  wrap.append(veil, card)
  root.append(wrap)

  let shownOpacity = ''
  let solid = false
  let shownCard = '' // the card's text, as a key: '' = none
  return {
    update(fade, c) {
      const f = Math.min(1, Math.max(0, Number.isFinite(fade) ? fade : 0))
      const hide = f === 0 && c === null
      if (wrap.hidden !== hide) wrap.hidden = hide
      const o = String(Math.round(f * 1000) / 1000)
      if (o !== shownOpacity) {
        shownOpacity = o
        veil.style.opacity = o
      }
      if (f >= SOLID !== solid) {
        solid = f >= SOLID
        wrap.classList.toggle('fh-ending-solid', solid)
      }
      const key = c === null ? '' : JSON.stringify([c.title, c.lines])
      if (key === shownCard) return
      const first = shownCard === ''
      shownCard = key
      card.hidden = c === null
      if (c === null) return
      title.textContent = c.title
      card.setAttribute('aria-label', c.title)
      body.replaceChildren(...c.lines.map((l) => h('p', 'fh-ending-line', l)))
      if (first) close.focus({ preventScroll: true }) // keyboard users land on the one thing to do
    },
    destroy() {
      wrap.remove()
    },
  }
}

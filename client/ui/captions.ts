// client/ui/captions.ts
// Scenario captions: the lines spoken at the scenario time, centred above the play bar, oldest first. Each line has a
// head (who → to, the channel after a dot, a JA→EN mark when translated), the English text, and the original words in
// smaller type under it when they were not English. Lines are keyed: update() runs every frame, so a line that stays
// keeps its element (its 150 ms fade-in plays once), gone lines go, new lines are added. Text only, never HTML: the
// words are the official record's. A polite live region, so a screen reader reads each new line once.
import type { Channel } from '../scenario/types.ts'
import './captions.css'

export interface CaptionView {
  key: string // stable per line (the same line keeps it from frame to frame)
  who: string // 'Captain'
  to: string | null // 'First Officer'; null: to anyone listening
  channel: Channel
  translated: boolean
  unintelligible: boolean
  text: string
  original: string | null
}

export interface CaptionsHandle {
  update(lines: readonly CaptionView[]): void
  destroy(): void
}

/** The channel as the head names it after the speakers ('' for the cockpit and alerts: that is the default). */
const CHANNEL_NOTE: Record<Channel, string> = {
  cockpit: '',
  radio: 'radio',
  company: 'radio',
  cabin: 'cabin',
  interphone: 'interphone',
  alert: '',
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = className
  if (text !== '') el.textContent = text
  return el
}

function line(c: CaptionView): HTMLElement {
  const el = h('div', c.unintelligible ? 'fh-cap fh-cap-u' : 'fh-cap')
  el.dataset.channel = c.channel
  const head = h('div', 'fh-cap-head')
  head.append(h('span', 'fh-cap-who', c.to === null ? c.who : `${c.who} → ${c.to}`))
  const note = CHANNEL_NOTE[c.channel]
  if (note !== '') head.append(h('span', 'fh-cap-ch', ` · ${note}`))
  // ponytail: the mark names Japanese → English, the only translated language so far; a second one needs `lang` here.
  if (c.translated) {
    const tr = h('span', 'fh-cap-tr', 'JA→EN')
    tr.title = 'Translated from Japanese'
    head.append(tr)
  }
  el.append(head, h('p', 'fh-cap-text', c.text))
  if (c.original !== null && c.original !== '') el.append(h('p', 'fh-cap-orig', c.original))
  return el
}

export function mountCaptions(root: HTMLElement): CaptionsHandle {
  const box = h('div', 'fh-captions')
  box.setAttribute('aria-live', 'polite')
  box.setAttribute('aria-relevant', 'additions')
  root.append(box)
  // ponytail: a key's line never changes, so a kept element is not re-rendered; a gone line disappears at once (no fade-out).
  let shown: { key: string; el: HTMLElement }[] = []

  return {
    update(lines) {
      if (lines.length === shown.length && lines.every((l, i) => l.key === shown[i].key)) return
      const byKey = new Map(shown.map((s) => [s.key, s.el]))
      const next = lines.map((l) => ({ key: l.key, el: byKey.get(l.key) ?? line(l) }))
      const keep = new Set(next.map((n) => n.el))
      for (const s of shown) if (!keep.has(s.el)) s.el.remove()
      // Into order, moving only what is out of place (a moved line would replay its fade): as time runs, the oldest
      // lines go from the top and new ones join at the bottom, so nothing kept moves.
      next.forEach((n, i) => {
        const at = box.children[i] ?? null
        if (at !== n.el) box.insertBefore(n.el, at)
      })
      shown = next
    },
    destroy() {
      box.remove()
      shown = []
    },
  }
}

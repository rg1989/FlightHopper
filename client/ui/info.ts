// client/ui/info.ts
// The Controls panel: the keyboard shortcuts.
import './info.css'

interface Section {
  title: string
  rows: [string, string][]
}

// ponytail: keys only (the user's call, 2026-09-30); the mouse, trackpad and touch gestures are not listed.
const KEYS: Section[] = [
  { title: 'Anywhere', rows: [
    ['Esc', 'One step back: a panel, a card, the layout, the chase or a scenario, then the selection'],
    ['M', 'Map or satellite, for the view on screen (in a scenario it mutes)'],
    ['R', 'Roads and places over the satellite'],
    ['W', 'Weather on the top-down map'],
  ] },
  { title: '3-D chase', rows: [
    ['T', '3-D terrain'],
    ['L', 'Sun and moon light'],
    ['X', 'See-through buildings'],
  ] },
  { title: 'In a scenario', rows: [
    ['Space', 'Play or pause'],
    ['← →', 'Back or ahead 10 s; with Shift, 60 s'],
    ['M', 'Mute or unmute the voices'],
  ] },
]

export function mountInfoPanel(root: HTMLElement): void {
  const h = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag)
    e.className = className
    if (text !== '') e.textContent = text
    return e
  }
  for (const sec of KEYS) {
    const box = h('section', 'fh-info-sec')
    const dl = h('dl', 'fh-info-keys')
    for (const [what, does] of sec.rows) {
      const dt = h('dt')
      dt.append(...what.split(' ').map((k) => h('kbd', 'fh-kbd', k)))
      dl.append(dt, h('dd', '', does))
    }
    box.append(h('h3', 'fh-info-t', sec.title), dl)
    root.append(box)
  }
}

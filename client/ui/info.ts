// client/ui/info.ts
// The Info panel: mouse and keyboard controls (touch gestures on a touch screen), then the data and map sources.
import './info.css'

// On a touch screen (no keys, no hover): gestures instead.
const TOUCH: [string, string][] = [
  ['Tap an aircraft', 'Its card: details and Chase'],
  ['Tap the map', 'Clear the selection'],
  ['Drag, pinch', 'Move and zoom; in chase, orbit it'],
  ['Double-tap', 'In chase: back behind it'],
  ['Swipe a sheet down', 'Close it'],
]

const SHORTCUTS: [string, string][] = [
  ['Click an aircraft', 'Its card: details and Chase'],
  ['Click the map', 'Clear the selection'],
  ['Drag, scroll', 'Move and zoom; in chase, orbit it'],
  ['Double-click', 'In chase: back behind it'],
  ['Esc', 'Close a panel, leave chase, clear the selection'],
  ['T', '3-D terrain'],
  ['L', 'Sun and moon light'],
  ['X', 'See-through buildings'],
]

export interface InfoPanelHandle {
  setCredits(lines: string[]): void
}

export function mountInfoPanel(root: HTMLElement): InfoPanelHandle {
  const h = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag)
    e.className = className
    if (text !== '') e.textContent = text
    return e
  }
  const keys = h('section', 'fh-info-sec')
  keys.append(h('h3', 'fh-info-t', 'Controls'))
  const dl = h('dl', 'fh-info-keys')
  for (const [k, what] of globalThis.matchMedia?.('(pointer: coarse)').matches ? TOUCH : SHORTCUTS) {
    const dt = h('dt')
    dt.append(k.length <= 3 ? h('kbd', 'fh-kbd', k) : h('span', '', k)) // single keys as key caps
    dl.append(dt, h('dd', '', what))
  }
  keys.append(dl)

  const credits = h('section', 'fh-info-sec')
  credits.append(h('h3', 'fh-info-t', 'Data and credits'))
  const list = h('ul', 'fh-info-credits')
  credits.append(list)
  root.append(keys, credits)

  return {
    setCredits(lines) {
      list.replaceChildren(...lines.map((l) => h('li', '', l)))
    },
  }
}

// client/ui/info.ts
// The Controls panel: what the mouse, a trackpad and the keys do on the map, in the 3-D chase and in a scenario; on a
// touch screen, the gestures instead.
import './info.css'

interface Section {
  title: string
  keys?: boolean // the first column holds keys, drawn as key caps
  rows: [string, string][]
}

const LAYOUT: [string, string] = ['Layout button in the corner', 'Drag the instrument cards; hide or show each with its eye; Reset or Done']

const MOUSE: Section[] = [
  { title: 'Map', rows: [
    ['Click an aircraft', 'Its card: photo, details and Chase in 3-D'],
    ['Point at an aircraft', 'Its callsign'],
    ['Click the empty map', 'Close the card'],
    ['Drag', 'Move the map'],
    ['Scroll wheel or right-drag', 'Zoom in or out'],
    ['Trackpad: two fingers', 'Move the map'],
    ['Trackpad: pinch', 'Zoom in or out where the fingers are'],
  ] },
  { title: '3-D chase', rows: [
    ['Chase in 3-D, on the card', 'Follow the aircraft in 3-D; Map (or Esc) goes back'],
    ['Drag', 'Turn the camera around the aircraft'],
    ['Scroll wheel', 'Closer or farther'],
    ['Trackpad: pinch, or two fingers up and down', 'Closer or farther'],
    ['Double-click', 'Back behind the aircraft'],
    ['Click an aircraft in yellow corners', 'Its card; its Chase follows it instead'],
    LAYOUT,
  ] },
  { title: 'Keys', keys: true, rows: [
    ['Esc', 'One step back: a panel, a card, the layout, the chase or a scenario, then the selection'],
    ['T', '3-D terrain in the chase'],
    ['L', 'Sun and moon light in the chase'],
    ['X', 'See-through buildings in the chase'],
  ] },
  { title: 'In a scenario', keys: true, rows: [
    ['Space', 'Play or pause'],
    ['← →', 'Back or ahead 10 s; with Shift, 60 s'],
    ['M', 'Mute or unmute the voices'],
  ] },
]

// On a touch screen (no keys, no hover): gestures instead.
const TOUCH: Section[] = [
  { title: 'Map', rows: [
    ['Tap an aircraft', 'Its card: photo, details and Chase in 3-D'],
    ['Tap the empty map', 'Close the card'],
    ['Drag', 'Move the map'],
    ['Pinch', 'Zoom in or out'],
  ] },
  { title: '3-D chase', rows: [
    ['Chase in 3-D, on the card', 'Follow the aircraft in 3-D; Map goes back'],
    ['Drag', 'Turn the camera around the aircraft'],
    ['Pinch', 'Closer or farther'],
    ['Double-tap', 'Back behind the aircraft'],
    ['Tap an aircraft in yellow corners', 'Its card; its Chase follows it instead'],
    LAYOUT,
  ] },
  { title: 'Panels', rows: [['Swipe a sheet down', 'Close it']] },
]

export function mountInfoPanel(root: HTMLElement): void {
  const h = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag)
    e.className = className
    if (text !== '') e.textContent = text
    return e
  }
  for (const sec of globalThis.matchMedia?.('(pointer: coarse)').matches ? TOUCH : MOUSE) {
    const box = h('section', 'fh-info-sec')
    const dl = h('dl', 'fh-info-keys')
    for (const [what, does] of sec.rows) {
      const dt = h('dt')
      if (sec.keys) dt.append(...what.split(' ').map((k) => h('kbd', 'fh-kbd', k)))
      else dt.textContent = what
      dl.append(dt, h('dd', '', does))
    }
    box.append(h('h3', 'fh-info-t', sec.title), dl)
    root.append(box)
  }
}

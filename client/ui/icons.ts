// client/ui/icons.ts
// The app's line icons: 24-unit grid, 1.75 stroke, round caps, drawn in currentColor so buttons colour them. Drawn for
// this app (simple geometry), inline so they need no requests and never flash in.

const P: Record<string, string> = {
  // A pulse line: the live data feed.
  status: 'M3 12h4l2.5-6 5 12 2.5-6h4',
  // Rows of a list, with bullets.
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  // Stacked sheets: the scene layers.
  layers: 'M12 3 2.5 8 12 13l9.5-5L12 3ZM2.5 12.5 12 17.5l9.5-5M2.5 16.5 12 21.5l9.5-5',
  // A fan of waves, struck through: no network.
  wifiOff: 'M2.5 8.8a14 14 0 0 1 5.8-3.4M12.5 5a14 14 0 0 1 9 3.8M5.6 12.2a9.5 9.5 0 0 1 3.6-2.3M15.3 10.6a9.5 9.5 0 0 1 3.1 1.6M8.6 15.5a5 5 0 0 1 6.8 0M12 19.5h.01M3.5 3.5l17 17',
  // Two stacked server boxes: the app's own server.
  server: 'M4 4.5h16v6H4zM4 13.5h16v6H4zM7.5 7.5h.01M7.5 16.5h.01M11 7.5h5.5M11 16.5h5.5',
  // A radar scope and its sweep: the flight-data source.
  radar: 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18ZM12 16.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9ZM12 12l6.4-6.4',
  // A circle struck through: refused.
  ban: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM5.6 5.6l12.8 12.8',
  // An hourglass: slowed, or taking long.
  hourglass: 'M6.5 3.5h11M6.5 20.5h11M7.5 3.5c0 5 9 5 9 8.5s-9 3.5-9 8.5M16.5 3.5c0 5-9 5-9 8.5s9 3.5 9 8.5',
  // A cloud: the weather.
  cloud: 'M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.5 9.6 4.5 4.5 0 0 0 7 18.5Z',
  // A road running into the distance: roads and places.
  road: 'M9.5 3.5 5 20.5M14.5 3.5l4.5 17M12 5v2.5M12 11v2.5M12 17v3',
  // Two peaks: 3-D terrain.
  mountain: 'M2.5 19.5 9 8l4 7 2.5-4 6 8.5h-19Z',
  // A sun with rays.
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4',
  // Two buildings: see-through buildings.
  building: 'M4 21V8l6-3v16M10 21V3.5l8 3.5v14M3 21h18M13.5 9.5h1.5M13.5 13h1.5M13.5 16.5h1.5M6.5 11h1M6.5 14.5h1',
  // Stepped bars rising: altitude colours.
  altitude: 'M4 20V15M9.3 20V11M14.7 20V7M20 20V3.5',
  // i in a circle.
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5.5M12 7.5h.01',
  // Four cards of different sizes: a layout (the flight-data frame's), to edit.
  layout: 'M3.5 3.5h7v9h-7zM13.5 3.5h7v5h-7zM13.5 11.5h7v9h-7zM3.5 15.5h7v5h-7z',
  // An eye, open and struck through: shown, hidden (the flight-data frame's cards), or a secret (Settings).
  eye: 'M2.5 12c2.2-4.3 5.6-6.5 9.5-6.5s7.3 2.2 9.5 6.5c-2.2 4.3-5.6 6.5-9.5 6.5S4.7 16.3 2.5 12ZM12 14.75a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5Z',
  eyeOff: 'M2.5 12c2.2-4.3 5.6-6.5 9.5-6.5s7.3 2.2 9.5 6.5c-2.2 4.3-5.6 6.5-9.5 6.5S4.7 16.3 2.5 12ZM12 14.75a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5ZM4 4l16 16',
  // Four corners out / in.
  maximize: 'M8 3.5H3.5V8M16 3.5h4.5V8M20.5 16v4.5H16M3.5 16v4.5H8',
  minimize: 'M8 3.5V8H3.5M16 3.5V8h4.5M20.5 16H16v4.5M3.5 16H8v4.5',
  x: 'M6 6l12 12M18 6 6 18',
  chevronDown: 'm6 9 6 6 6-6',
  chevronUp: 'm6 15 6-6 6 6',
  chevronLeft: 'm15 6-6 6 6 6',
  chevronRight: 'm9 6 6 6-6 6',
  link: 'M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1-1',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  refresh: 'M20 11a8 8 0 0 0-14.3-4.9L4 8M4 3.5V8h4.5M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20.5V16h-4.5',
  search: 'M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20.5 20.5l-5-5',
  // A control tower (the search's airports): the cab on its shaft.
  tower: 'M6.5 4.5h11l-1.5 5h-8l-1.5-5ZM12 2.5v2M9.5 9.5l-1 11M14.5 9.5l1 11M6 20.5h12',
  // A flag on its pole (the search's countries).
  flag: 'M5.5 21V3.5M5.5 4.5h12l-2.5 4.5 2.5 4.5h-12',
  // A clock face (the search's past picks).
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7.5V12l3 2',
  // A clock face with an arrow turning it back: history (the map in the past).
  history: 'M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 3.8v4.6h4.6M12 7.5V12l3 2',
  // A calendar page with its two rings: go to a date (the history bar).
  calendar: 'M4.5 6h15v14h-15zM4.5 10h15M8.5 3.5v4M15.5 3.5v4',
  // A plane seen from above, nose up.
  plane: 'M12 2.5c.9 0 1.5 1 1.5 2.5v4.5l7.5 4.5v2l-7.5-2.3v4.8l2 1.6v1.6L12 20.7l-3.5 1v-1.6l2-1.6v-4.8L3 16v-2l7.5-4.5V5c0-1.5.6-2.5 1.5-2.5Z',
  // A folded map: the top-down view.
  map: 'M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4ZM9 4v14M15 6v14',
  // Two corner brackets (top right, bottom left): the chase traffic's mark.
  bracket: 'M13.5 4.5h6v6M10.5 19.5h-6v-6',
  // A camera, struck through: no photo of this aircraft.
  cameraOff: 'M3.5 7.5H7L8.5 5h7L17 7.5h3.5v12h-17v-12ZM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM3 3l18 18',
  keyboard: 'M3.5 6.5h17v11h-17zM7 10h.01M10.5 10h.01M14 10h.01M17.5 10h.01M8 14h8',
  // A strip of film with its sprocket holes: the scenarios (recorded flights).
  film: 'M5.5 3.5h13a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2ZM7.5 3.5v17M16.5 3.5v17M3.5 8h4M3.5 12h4M3.5 16h4M16.5 8h4M16.5 12h4M16.5 16h4',
  // Media controls (the scenario play bar fills them).
  play: 'M7.5 5.2v13.6L18.8 12 7.5 5.2Z',
  pause: 'M7 5.5h3v13H7zM14 5.5h3v13h-3z',
  // A gear with eight teeth round a hub: the settings.
  settings: 'M10.16 5.14L10.53 2.72L13.47 2.72L13.84 5.14A7.1 7.1 0 0 1 15.55 5.85L17.53 4.4L19.6 6.47L18.15 8.45A7.1 7.1 0 0 1 18.86 10.16L21.28 10.53L21.28 13.47L18.86 13.84A7.1 7.1 0 0 1 18.15 15.55L19.6 17.53L17.53 19.6L15.55 18.15A7.1 7.1 0 0 1 13.84 18.86L13.47 21.28L10.53 21.28L10.16 18.86A7.1 7.1 0 0 1 8.45 18.15L6.47 19.6L4.4 17.53L5.85 15.55A7.1 7.1 0 0 1 5.14 13.84L2.72 13.47L2.72 10.53L5.14 10.16A7.1 7.1 0 0 1 5.85 8.45L4.4 6.47L6.47 4.4L8.45 5.85A7.1 7.1 0 0 1 10.16 5.14ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  // A box with an arrow leaving it: opens another site.
  external: 'M13.5 4.5h6v6M19.5 4.5 11 13M17 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1H10',
  // A triangle with an exclamation mark: a warning.
  alert: 'M12 4 2.8 19.5h18.4L12 4ZM12 10v4.5M12 17h.01',
  // A speaker with its sound, and silenced.
  volume: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4v-5ZM15.5 9.2a4 4 0 0 1 0 5.6M18.3 6.5a7.8 7.8 0 0 1 0 11',
  muted: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4v-5ZM16 9.5l5 5M21 9.5l-5 5',
  // Record (a dot in a ring) and stop (a square): a flight recorded to a file.
  record: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
  stop: 'M7.5 7.5h9v9h-9z',
}

const NS = 'http://www.w3.org/2000/svg'

export type IconName = keyof typeof P

/** An SVG icon (aria-hidden: the button around it carries the label). */
export function icon(name: IconName, size = 18): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.75')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('fh-icon')
  const path = document.createElementNS(NS, 'path')
  path.setAttribute('d', P[name])
  svg.append(path)
  return svg
}

export const ICON_NAMES = Object.keys(P) as IconName[]

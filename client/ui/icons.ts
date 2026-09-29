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
  // Four corners out / in.
  maximize: 'M8 3.5H3.5V8M16 3.5h4.5V8M20.5 16v4.5H16M3.5 16v4.5H8',
  minimize: 'M8 3.5V8H3.5M16 3.5V8h4.5M20.5 16H16v4.5M3.5 16H8v4.5',
  x: 'M6 6l12 12M18 6 6 18',
  chevronDown: 'm6 9 6 6 6-6',
  chevronUp: 'm6 15 6-6 6 6',
  link: 'M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1-1',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  refresh: 'M20 11a8 8 0 0 0-14.3-4.9L4 8M4 3.5V8h4.5M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20.5V16h-4.5',
  search: 'M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20.5 20.5l-5-5',
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
  // An eye, open and struck through: show or hide a secret.
  eye: 'M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  eyeOff: 'M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.5 3.5l17 17',
  // A box with an arrow leaving it: opens another site.
  external: 'M13.5 4.5h6v6M19.5 4.5 11 13M17 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1H10',
  // A triangle with an exclamation mark: a warning.
  alert: 'M12 4 2.8 19.5h18.4L12 4ZM12 10v4.5M12 17h.01',
  // A speaker with its sound, and silenced.
  volume: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4v-5ZM15.5 9.2a4 4 0 0 1 0 5.6M18.3 6.5a7.8 7.8 0 0 1 0 11',
  muted: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4v-5ZM16 9.5l5 5M21 9.5l-5 5',
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

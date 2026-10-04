// client/ui/setup.ts
// The setup guide: a dialog in the Settings dialog's look that opens by itself the first time the app runs in a browser
// (and from Settings → API keys → Setup guide). Welcome, one step for each key, Ready. A key step says where to sign up
// and what to click there, with links, then takes the key in the Settings dialog's own form (settings.ts keyForm: the
// same check, the same storage). Nothing here is required: the app runs without keys. Closing it in any way counts as
// seen (SETUP_KEY).
import type { KeySource } from '../config.ts'
import { icon, type IconName } from './icons.ts'
import type { KeyId } from './settings.ts'
import './setup.css'

/** Set once the guide has been closed in this browser. */
export const SETUP_KEY = 'fh.setup.v1'

type Sources = Readonly<Record<KeyId, KeySource>>

/**
 * Whether the guide opens by itself at start: once in a browser that still lacks a key. Not on the TV kiosk (?tv=1: a
 * remote cannot paste), nor where storage is blocked (it could not be remembered). ?setup=1 opens it anyway, ?setup=0
 * keeps it shut (screenshots, shared links).
 */
export function setupDue(store: Storage | null, sources: Sources, search: string): boolean {
  const q = new URLSearchParams(search)
  if (q.get('setup') === '1') return true
  if (q.get('setup') === '0' || q.get('tv') === '1' || store === null) return false
  if (sources.arcgis !== 'none' && sources.ion !== 'none') return false
  try {
    return store.getItem(SETUP_KEY) === null
  } catch {
    return false
  }
}

/** What the globe is drawn with, given the keys (config.ts readConfig's defaults). */
export function setupSummary(sources: Sources): { imagery: string; terrain: string } {
  const ion = sources.ion !== 'none'
  return {
    imagery: sources.arcgis !== 'none' ? 'Esri World Imagery' : ion ? 'Bing imagery via Cesium ion' : 'EOX Sentinel-2, 10 m (no key)',
    terrain: ion ? 'Cesium World Terrain' : 'Re:Earth terrain (no key)',
  }
}

interface Guide {
  icon: IconName
  gain: string // the Welcome row's title
  title: string
  about: string
  steps: readonly { text: string; href?: string; link?: string }[]
}

/** Each provider's own steps, as its site names them (checked 2026-10-04). */
export const GUIDES: Readonly<Record<KeyId, Guide>> = {
  arcgis: {
    icon: 'layers', gain: 'Sharper imagery', title: 'ArcGIS API key',
    about: 'Esri World Imagery, 0.3 m at big airports. Free up to 2 million tiles a month.',
    steps: [
      { text: 'Create an ArcGIS Location Platform account.', href: 'https://location.arcgis.com/sign-up/', link: 'Sign up' },
      { text: 'In the dashboard open My portal, then Content → New item → Developer credentials → API key credentials.', href: 'https://location.arcgis.com/', link: 'Dashboard' },
      { text: 'Choose Public application, then No item access. Under Privileges tick Basemap styles service.' },
      { text: 'Set an expiration date (a key lasts up to one year) and a title, then generate the key and copy it. It is shown once.' },
      { text: 'Paste it below and save.' },
    ],
  },
  ion: {
    icon: 'mountain', gain: 'Better terrain', title: 'Cesium ion access token',
    about: 'Cesium World Terrain. Free for personal, non-commercial use.',
    steps: [
      { text: 'Create a Cesium ion account.', href: 'https://ion.cesium.com/signup/', link: 'Sign up' },
      { text: 'Open Access Tokens and copy the Default Token.', href: 'https://ion.cesium.com/tokens', link: 'Tokens' },
      { text: 'Paste it below and save.' },
    ],
  },
}
const ORDER: readonly KeyId[] = ['arcgis', 'ion']

/** What the guide needs of the Settings dialog, which owns the keys. */
export interface SetupHost {
  /** The key's form (field, status, Clear and Save), sharing the Settings dialog's state. */
  keyForm(id: KeyId): HTMLElement
  sources(): Sources
  /** A key changed since the page loaded: a reload applies it. */
  changed(): boolean
  store: Storage | null
  reload(): void
}

export interface SetupHandle {
  open(): void
  /** A key was saved or cleared. */
  sync(): void
  destroy(): void
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = className
  if (text !== '') el.textContent = text
  return el
}

function pill(text: string, secondary = false): HTMLButtonElement {
  const b = h('button', secondary ? 'fh-pill fh-pill-secondary' : 'fh-pill', text)
  b.type = 'button'
  return b
}

/** Mounts the (closed) guide in root. */
export function mountSetup(root: HTMLElement, host: SetupHost): SetupHandle {
  const dialog = h('dialog', 'fh-settings fh-setup')
  dialog.setAttribute('aria-labelledby', 'fh-setup-title')
  const box = h('div', 'fh-settings-box')
  const head = h('header', 'fh-settings-head')
  const headIcon = h('span', 'fh-settings-icon')
  headIcon.append(icon('plane', 18))
  const title = h('h2', 'fh-settings-title', 'Set up FlightHopper')
  title.id = 'fh-setup-title'
  const close = h('button', 'fh-ibtn fh-sm')
  close.type = 'button'
  close.setAttribute('aria-label', 'Close (Esc)')
  close.title = 'Close (Esc)'
  close.append(icon('x', 16))
  head.append(headIcon, title, close)
  const body = h('div', 'fh-settings-body')

  // Welcome: what the app runs on, and the two keys with whether each is set.
  const welcome = h('section', 'fh-setup-step')
  welcome.append(
    h('h3', 'fh-setup-h', 'Welcome'),
    h('p', 'fh-settings-intro', 'FlightHopper works as it is: no account, no keys. Two free keys make the globe look better. Each takes a few minutes, and you can add them later in Settings.'),
  )
  const marks = new Map<KeyId, HTMLElement>()
  for (const id of ORDER) {
    const g = GUIDES[id]
    const row = h('div', 'fh-setup-row')
    const art = h('span', 'fh-setup-row-icon')
    art.append(icon(g.icon, 18))
    const text = h('div', 'fh-setup-row-text')
    text.append(h('div', 'fh-key-title', g.gain), h('div', 'fh-key-about', `${g.title}. ${g.about}`))
    const mark = h('span', 'fh-key-status')
    marks.set(id, mark)
    row.append(art, text, mark)
    welcome.append(row)
  }

  // One step for each key: the provider's steps, then the key's form.
  const keySteps = ORDER.map((id, i) => {
    const g = GUIDES[id]
    const step = h('section', 'fh-setup-step')
    const list = h('ol', 'fh-setup-list')
    for (const s of g.steps) {
      const li = h('li', '', s.text)
      if (s.href !== undefined) {
        const a = h('a', 'fh-key-link', s.link)
        a.href = s.href
        a.target = '_blank'
        a.rel = 'noopener'
        a.append(icon('external', 13))
        li.append(' ', a)
      }
      list.append(li)
    }
    step.append(h('div', 'fh-setup-eyebrow', `Key ${i + 1} of ${ORDER.length} · ${g.gain}`), h('h3', 'fh-setup-h', g.title), h('p', 'fh-settings-intro', g.about), list, host.keyForm(id))
    return step
  })

  // Ready: what the globe is drawn with now.
  const ready = h('section', 'fh-setup-step')
  const sum = { imagery: h('dd', ''), terrain: h('dd', '') }
  const dl = h('dl', 'fh-setup-sum')
  dl.append(h('dt', '', 'Imagery'), sum.imagery, h('dt', '', 'Terrain'), sum.terrain)
  const readyNote = h('p', 'fh-settings-intro')
  ready.append(h('h3', 'fh-setup-h', 'Ready'), dl, readyNote)

  const steps = [welcome, ...keySteps, ready]
  body.append(...steps)

  const foot = h('footer', 'fh-settings-foot fh-setup-foot')
  const dots = h('div', 'fh-setup-dots')
  dots.setAttribute('aria-hidden', 'true')
  for (const _ of steps) dots.append(h('span', ''))
  const back = pill('', true)
  const next = pill('')
  next.autofocus = true
  foot.append(dots, back, next)
  box.append(head, body, foot)
  dialog.append(box)
  root.append(dialog)

  let at = 0
  const last = steps.length - 1
  function sync(): void {
    const sources = host.sources()
    for (const [id, mark] of marks) {
      const set = sources[id] !== 'none'
      mark.replaceChildren(h('span', 'fh-dot'), set ? 'Set' : 'Not set')
      mark.dataset.tone = set ? 'ok' : 'off'
    }
    const s = setupSummary(sources)
    sum.imagery.textContent = s.imagery
    sum.terrain.textContent = s.terrain
    readyNote.textContent = `${host.changed() ? 'Reload to use the new keys. ' : ''}Keys can be changed at any time in Settings (the gear button).`
    steps.forEach((el, i) => (el.hidden = i !== at))
    dots.childNodes.forEach((d, i) => (d as HTMLElement).classList.toggle('fh-on', i === at))
    back.textContent = at === 0 ? 'Not now' : 'Back'
    const key = ORDER[at - 1] as KeyId | undefined // the key steps sit between Welcome and Ready
    next.textContent = at === 0 ? 'Set up keys' : at === last ? (host.changed() ? 'Reload and start' : 'Start') : key !== undefined && sources[key] === 'none' ? 'Skip this key' : 'Next'
  }
  function go(to: number): void {
    at = to
    sync()
    body.scrollTop = 0
    next.focus()
  }
  back.addEventListener('click', () => (at === 0 ? dialog.close() : go(at - 1)))
  next.addEventListener('click', () => {
    if (at < last) return go(at + 1)
    dialog.close()
    if (host.changed()) host.reload()
  })
  close.addEventListener('click', () => dialog.close())

  // While it is open no key reaches the app's own handlers (T, L, X toggle the scene), as in the Settings dialog; typing,
  // Enter saving and Esc closing still happen (the browser's defaults).
  const keep = (e: KeyboardEvent): void => e.stopPropagation()
  dialog.addEventListener('close', () => {
    window.removeEventListener('keydown', keep, true)
    try {
      host.store?.setItem(SETUP_KEY, '1')
    } catch {
      // blocked: it opens again next time only where ?setup=1 asks
    }
  })

  return {
    open() {
      if (dialog.open) return
      at = 0
      sync()
      window.addEventListener('keydown', keep, true)
      dialog.showModal()
    },
    sync,
    destroy() {
      window.removeEventListener('keydown', keep, true)
      if (dialog.open) dialog.close()
      dialog.remove()
    },
  }
}

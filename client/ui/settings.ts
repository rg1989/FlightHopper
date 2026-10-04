// client/ui/settings.ts
// The Settings dialog, opened by the rail's gear: the API keys FlightHopper can use. Each is optional: without them it
// runs on keyless Re:Earth terrain and EOX imagery. A key is checked with a cheap request to its own provider, then
// saved in this browser (config.ts KEYS_KEY), where it wins over the build's .env.local from the next load: terrain and
// imagery are built with the viewer, so a reload applies it. A key goes to its own provider only: the check sends it in
// the Authorization header; in use, it travels in the URLs those services ask for (Esri's tiles take ?token=, Cesium
// asks ion's asset endpoint with ?access_token=). It never goes into the app's own URL, a log or the page (an
// .env.local key is never shown). A second tab, Controls, lists the keyboard shortcuts (info.ts; left out on touch
// screens, opts.controls false). A third, Display, picks the map's theme, Light or Dark (the same pref as the Layers
// panel's; the app owns it: onDark asks, setDark shows). A native modal <dialog>: the page behind is inert, so the focus stays in it; Esc, the
// X and a click on the backdrop close it. It opens on the API keys tab unless asked otherwise. The setup guide (setup.ts)
// is mounted here too: it takes each key in a second form of the same kind, on the same state.
import { KEYS_KEY, keySources, readSavedKeys, writeSavedKeys, type KeySource, type SavedKeys } from '../config.ts'
import { icon } from './icons.ts'
import { mountInfoPanel } from './info.ts'
import { mountSetup, setupDue, type SetupHandle } from './setup.ts'
import './settings.css'

export type KeyId = 'arcgis' | 'ion'

/** What a key feeds, and so what can fall back to its keyless source: Re:Earth terrain, EOX imagery. */
export type KeyUse = 'terrain' | 'imagery'
const KEYLESS: Readonly<Record<KeyUse, string>> = { terrain: 'Re:Earth terrain', imagery: 'EOX imagery' }

/** A key that failed while the app used it: why, and what fell back (ion: its terrain, its imagery, or both). */
export interface KeyFailure {
  why: string
  what: readonly KeyUse[]
}

interface KeySpec {
  id: KeyId
  field: keyof SavedKeys
  title: string
  noun: 'key' | 'token'
  provider: string
  about: string
  paste: string // the empty input's placeholder
  href: string
  linkText: string
  keyless: string // what runs without it
}

const SPECS: readonly KeySpec[] = [
  {
    id: 'arcgis', field: 'arcgisKey', title: 'ArcGIS API key', noun: 'key', provider: 'ArcGIS',
    about: 'Esri World Imagery, 0.3 m at big airports. A free ArcGIS Location Platform key with the “Basemap styles service” privilege.',
    paste: 'Paste your API key', href: 'https://developers.arcgis.com/', linkText: 'Get a key', keyless: 'EOX imagery',
  },
  {
    id: 'ion', field: 'ionToken', title: 'Cesium ion access token', noun: 'token', provider: 'Cesium ion',
    about: 'Cesium World Terrain, and Bing imagery via ion where there is no ArcGIS key. A free Community token.',
    paste: 'Paste your access token', href: 'https://ion.cesium.com/tokens', linkText: 'Get a token', keyless: 'Re:Earth terrain',
  },
]

/**
 * A request that needs the key and costs little, at its own provider: ArcGIS's imagery basemap style (it takes the
 * privilege the imagery needs; the tiles themselves answer any key), and ion's endpoint of Cesium World Terrain (asset
 * 1, which the terrain opens).
 */
export const CHECK_URL: Readonly<Record<KeyId, string>> = {
  arcgis: 'https://basemapstyles-api.arcgis.com/arcgis/rest/services/styles/v2/styles/arcgis/imagery',
  ion: 'https://api.cesium.com/v1/assets/1/endpoint',
}
const CHECK_TIMEOUT_MS = 8000

/** The provider's answer: it took the key; it refused it (why: not saved); or none came (why: saved, with a warning). */
export type KeyCheck = { ok: true } | { ok: false; why: string } | { ok: null; why: string }

/**
 * Asks the key's own provider (CHECK_URL), the key in the Authorization header. Offline, blocked (CORS), timed out or a
 * 5xx: no answer. A 401 is a bad or expired key; a 403 (or ion's 404) one without the right: ArcGIS's privilege, ion's
 * asset. ArcGIS may also answer 200 with its error in the body.
 */
export async function checkKey(id: KeyId, key: string, fetchFn: typeof fetch = (input, init) => fetch(input, init)): Promise<KeyCheck> {
  const { provider, noun } = SPECS.find((s) => s.id === id)!
  const noRight = id === 'arcgis' ? 'This key lacks the “Basemap styles service” privilege' : 'This token cannot open Cesium World Terrain (asset 1)'
  let res: Response
  try {
    res = await fetchFn(CHECK_URL[id], { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) })
  } catch {
    return { ok: null, why: `${provider} could not be reached` }
  }
  if (res.status >= 500) return { ok: null, why: `${provider} answered HTTP ${res.status}` }
  if (res.status === 401) return { ok: false, why: `${provider} says this ${noun} is invalid or expired` }
  if (res.status === 403 || res.status === 404) return { ok: false, why: noRight }
  if (!res.ok) return { ok: false, why: `${provider} refused this ${noun} (HTTP ${res.status})` }
  if (id === 'arcgis') {
    const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null
    if (body?.error) return { ok: false, why: body.error.code === 403 ? noRight : `${provider} says this ${noun} is invalid or expired` }
  }
  return { ok: true }
}

/**
 * A key's status line: where the app takes it from (source, now), a reload still to come when that changed since the
 * page loaded, and a failure while it was in use (what fell back to its keyless source, and why).
 */
export function keyStatus(id: KeyId, source: KeySource, changed: boolean, failure: KeyFailure | null): { text: string; tone: 'ok' | 'off' | 'warn' } {
  const spec = SPECS.find((s) => s.id === id)!
  const base = source === 'saved' ? 'Saved in this browser'
    : source === 'env' ? `Using the ${spec.noun} from .env.local`
      : `Not set — using keyless ${spec.keyless}`
  if (changed) return { text: `${base} · reload to apply`, tone: source === 'none' ? 'off' : 'ok' }
  if (failure !== null && failure.what.length > 0 && source !== 'none') {
    const instead = (['terrain', 'imagery'] as const).filter((w) => failure.what.includes(w)).map((w) => KEYLESS[w]).join(' and ')
    return { text: `${base}, but it failed (${failure.why}): ${instead} instead`, tone: 'warn' }
  }
  return { text: base, tone: source === 'none' ? 'off' : 'ok' }
}

export interface SettingsOpts {
  env: Record<string, string | undefined> // the build's (import.meta.env): whether .env.local has each key
  store: Storage | null // localStorage; null where it is blocked (nothing can be saved)
  fetch?: typeof fetch
  reload?: () => void
  controls?: boolean // the Controls tab (the keyboard shortcuts); default true
  dark?: boolean // the map's theme at mount (Display tab)
  onDark?(dark: boolean): void
  search?: string // the page's query (location.search): the setup guide opens by itself when due (setup.ts setupDue); unset = never
}

export type SettingsTab = 'keys' | 'display' | 'controls'

export interface SettingsHandle {
  /** Opens on this tab (default: API keys). */
  open(tab?: SettingsTab): void
  /** Opens the setup guide (setup.ts). */
  setup(): void
  /** A key failed while the app used it: what fell back to its keyless source and why, on its status line. */
  setFallback(id: KeyId, what: KeyUse, why: string): void
  /** The map's theme changed (here or in the Layers panel). */
  setDark(dark: boolean): void
  destroy(): void
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = className
  if (text !== '') el.textContent = text
  return el
}

/** Mounts the (closed) dialog in root. The keys the app loaded with are read once, here: what a reload would change. */
export function mountSettings(root: HTMLElement, opts: SettingsOpts): SettingsHandle {
  let stored: string | null = null
  try {
    stored = opts.store?.getItem(KEYS_KEY) ?? null
  } catch {
    // blocked: nothing saved
  }
  const atLoad = readSavedKeys(stored)
  let saved: SavedKeys = { ...atLoad }
  const failures = new Map<KeyId, { why: string; what: KeyUse[] }>()

  const dialog = h('dialog', 'fh-settings')
  dialog.setAttribute('aria-labelledby', 'fh-settings-title')
  const box = h('div', 'fh-settings-box') // fills the dialog: a click outside it lands on the backdrop
  const head = h('header', 'fh-settings-head')
  const headIcon = h('span', 'fh-settings-icon')
  headIcon.append(icon('settings', 18))
  const title = h('h2', 'fh-settings-title', 'Settings')
  title.id = 'fh-settings-title'
  const close = h('button', 'fh-ibtn fh-sm')
  close.type = 'button'
  close.setAttribute('aria-label', 'Close (Esc)')
  close.title = 'Close (Esc)'
  close.append(icon('x', 16))
  head.append(headIcon, title, close)

  const body = h('div', 'fh-settings-body')
  const section = h('section', 'fh-settings-section')
  const guide = h('button', 'fh-key-link fh-settings-guide', 'Setup guide')
  guide.type = 'button'
  guide.append(icon('chevronRight', 13))
  section.append(
    h('p', 'fh-settings-intro', 'FlightHopper runs without keys, on Re:Earth terrain and EOX 10 m imagery. A key saved here stays in this browser, goes only to its own provider, and takes over from .env.local when the page reloads.'),
    guide,
  )
  const controls = h('section', 'fh-settings-section fh-settings-controls')
  mountInfoPanel(controls)
  // Display: the map theme, as the Layers panel's Light | Dark.
  const display = h('section', 'fh-settings-section')
  const themeLabel = h('div', 'fh-key-title', 'Map theme')
  themeLabel.id = 'fh-settings-theme'
  const theme = h('div', 'fh-seg fh-settings-seg')
  theme.setAttribute('role', 'group')
  theme.setAttribute('aria-labelledby', themeLabel.id)
  let dark = opts.dark ?? false
  const themeBtns = ([['Light', false], ['Dark', true]] as const).map(([text, on]) => {
    const b = h('button', 'fh-seg-b', text)
    b.type = 'button'
    b.addEventListener('click', () => on !== dark && opts.onDark?.(on))
    theme.append(b)
    return { b, on }
  })
  const showDark = (): void => {
    for (const { b, on } of themeBtns) b.setAttribute('aria-pressed', String(on === dark))
  }
  showDark()
  display.append(themeLabel, theme, h('p', 'fh-settings-intro', 'The street map in either view. Also in the Layers panel, under Map.'))
  // The tabs, under the title (the WAI-ARIA tab pattern: ← → Home End move between them, the focus goes with the tab).
  const tabList = h('div', 'fh-settings-tabs')
  tabList.setAttribute('role', 'tablist')
  tabList.setAttribute('aria-label', 'Settings')
  const tabs: { id: SettingsTab; tab: HTMLButtonElement; panel: HTMLElement }[] = []
  for (const [id, label, panel] of [['keys', 'API keys', section], ['display', 'Display', display], ['controls', 'Controls', controls]] as const) {
    if (id === 'controls' && opts.controls === false) continue
    const tab = h('button', 'fh-settings-tab', label)
    tab.type = 'button'
    tab.id = `fh-settings-tab-${id}`
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-controls', `fh-settings-panel-${id}`)
    panel.id = `fh-settings-panel-${id}`
    panel.setAttribute('role', 'tabpanel')
    panel.setAttribute('aria-labelledby', tab.id)
    tab.addEventListener('click', () => show(id))
    tabList.append(tab)
    body.append(panel)
    tabs.push({ id, tab, panel })
  }
  function show(id: SettingsTab, focus = false): void {
    for (const t of tabs) {
      const on = t.id === id
      t.tab.setAttribute('aria-selected', String(on))
      t.tab.tabIndex = on ? 0 : -1
      t.panel.hidden = !on
      if (on && focus) t.tab.focus()
    }
    body.scrollTop = 0
  }
  /** ← → Home End on a tab: the tab before or after it (round), the first or the last. */
  function tabKey(e: KeyboardEvent): boolean {
    const i = tabs.findIndex((t) => t.tab === e.target)
    if (i < 0) return false
    const n = tabs.length
    const to = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1
    if (to < 0) return false
    e.preventDefault()
    show(tabs[to].id, true)
    return true
  }
  tabList.hidden = tabs.length < 2 // one tab: no tab row

  const foot = h('footer', 'fh-settings-foot')
  foot.hidden = true
  const reload = h('button', 'fh-pill')
  reload.type = 'button'
  const reloadIcon = h('span', 'fh-pill-icon')
  reloadIcon.append(icon('refresh', 16))
  reload.append(reloadIcon, h('span', '', 'Reload now'))
  foot.append(h('p', 'fh-settings-foot-t', 'Keys apply when the page reloads.'), reload)
  box.append(head, tabList, body, foot)
  dialog.append(box)
  root.append(dialog)

  const keys: Array<{ sync(): void; reset(): void }> = []
  let setup: SetupHandle | null = null
  const changed = (): boolean => SPECS.some((s) => saved[s.field] !== atLoad[s.field])
  const syncFoot = (): void => {
    foot.hidden = !changed()
    setup?.sync()
  }

  /** A key's card: its title, link and what it unlocks, then the field. In the setup guide (bare), the field alone. */
  function keyForm(spec: KeySpec, bare = false): HTMLFormElement {
    const block = h('form', 'fh-key')
    block.noValidate = true
    const field = h('div', 'fh-key-field')
    const input = h('input', 'fh-key-input')
    input.id = `fh-${bare ? 'setup-' : ''}key-${spec.id}`
    if (bare) input.setAttribute('aria-label', spec.title)
    else {
      const top = h('div', 'fh-key-head')
      const label = h('label', 'fh-key-title', spec.title)
      label.htmlFor = input.id
      const link = h('a', 'fh-key-link', spec.linkText)
      link.href = spec.href
      link.target = '_blank'
      link.rel = 'noopener'
      link.append(icon('external', 13))
      top.append(label, link)
      block.append(top, h('p', 'fh-key-about', spec.about))
    }
    input.type = 'password'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.setAttribute('autocapitalize', 'off')
    input.setAttribute('autocorrect', 'off')
    const eye = h('button', 'fh-ibtn fh-sm fh-key-eye')
    eye.type = 'button'
    field.append(input, eye)
    const paintEye = (shown: boolean): void => {
      input.type = shown ? 'text' : 'password'
      eye.replaceChildren(icon(shown ? 'eyeOff' : 'eye', 16))
      const what = `${shown ? 'Hide' : 'Show'} ${spec.noun}`
      eye.setAttribute('aria-label', what)
      eye.title = what
      eye.setAttribute('aria-pressed', String(shown))
    }
    paintEye(false)
    eye.addEventListener('click', () => paintEye(input.type === 'password'))

    const row = h('div', 'fh-key-row')
    const status = h('p', 'fh-key-status')
    const statusText = h('span', '')
    status.append(h('span', 'fh-dot'), statusText)
    const actions = h('div', 'fh-key-actions')
    const clear = h('button', 'fh-pill fh-pill-secondary', 'Clear')
    clear.type = 'button'
    // While it checks, a spinner stands in for its label, which keeps the button's width: the row does not move.
    const save = h('button', 'fh-pill fh-key-save')
    save.type = 'submit'
    save.append(h('span', '', 'Save'), h('span', 'fh-spin'))
    actions.append(clear, save)
    row.append(status, actions)

    const msg = h('p', 'fh-key-msg')
    msg.setAttribute('role', 'status')
    msg.hidden = true
    const say = (tone: 'ok' | 'err' | 'warn' | 'wait', text: string): void => {
      const mark = tone === 'wait' ? h('span', 'fh-spin') : icon(tone === 'ok' ? 'check' : tone === 'err' ? 'x' : 'alert', 14)
      msg.replaceChildren(mark, h('span', '', text))
      msg.dataset.tone = tone
      msg.hidden = false
      msg.scrollIntoView?.({ block: 'nearest' }) // a phone's dialog scrolls: the answer below the fold comes into view
    }

    block.append(field, row, msg)

    let checking = false
    const sync = (): void => {
      const source = keySources(opts.env, saved)[spec.id]
      const s = keyStatus(spec.id, source, saved[spec.field] !== atLoad[spec.field], failures.get(spec.id) ?? null)
      statusText.textContent = s.text
      status.dataset.tone = s.tone
      // Instead of .env.local's: the status line names it (a longer placeholder is cut off on a phone).
      input.placeholder = keySources(opts.env, {})[spec.id] === 'env' ? `Paste a ${spec.noun} to use instead` : spec.paste
      const typed = input.value.trim()
      save.disabled = checking || typed === '' || typed === saved[spec.field]
      save.classList.toggle('fh-checking', checking)
      clear.disabled = checking || saved[spec.field] === undefined
      input.readOnly = checking
      syncFoot()
    }
    // Each opening shows what is saved: this browser's own key, masked again; never the build's. Unsaved typing and
    // the last answer go.
    const reset = (): void => {
      if (checking) return
      input.value = saved[spec.field] ?? ''
      paintEye(false)
      msg.hidden = true
      sync()
    }
    keys.push({ sync, reset })
    input.addEventListener('input', () => {
      msg.hidden = true
      sync()
    })

    const store = (key: string | undefined): boolean => {
      const next = { ...saved }
      if (key === undefined) delete next[spec.field]
      else next[spec.field] = key
      if (!writeSavedKeys(next, opts.store)) return false
      saved = next
      failures.delete(spec.id) // it was the old key's
      return true
    }
    block.addEventListener('submit', (e) => {
      e.preventDefault()
      const key = input.value.trim()
      if (checking || key === '' || key === saved[spec.field]) return
      checking = true
      say('wait', `Checking with ${spec.provider}…`)
      input.focus() // Save is disabled while it checks: the focus stays in the dialog
      sync()
      void checkKey(spec.id, key, opts.fetch).then((r) => {
        checking = false
        if (r.ok === false) say('err', `${r.why}. Not saved.`)
        else if (!store(key)) say('err', 'This browser blocks storage for this page, so the key cannot be saved.')
        else if (r.ok) say('ok', `${spec.provider} accepted the ${spec.noun}. Saved: reload to use it.`)
        else say('warn', `Could not check it (${r.why}). Saved anyway: if it is wrong, the app falls back to its keyless sources.`)
        sync()
      })
    })
    clear.addEventListener('click', () => {
      if (!store(undefined)) return say('err', 'This browser blocks storage for this page, so nothing changed.')
      input.value = ''
      input.focus() // Clear is disabled now
      const next = keySources(opts.env, saved)[spec.id] === 'env' ? `the ${spec.noun} from .env.local` : `keyless ${spec.keyless}`
      say('ok', `Cleared: reload to use ${next}.`)
      sync()
    })
    reset()
    return block
  }
  for (const spec of SPECS) section.append(keyForm(spec))
  const reloadPage = opts.reload ?? ((): void => location.reload())
  setup = mountSetup(root, {
    keyForm: (id) => keyForm(SPECS.find((s) => s.id === id)!, true),
    sources: () => keySources(opts.env, saved),
    changed,
    store: opts.store,
    reload: reloadPage,
  })
  guide.addEventListener('click', () => {
    dialog.close()
    setup?.open()
  })

  // While it is open, no key reaches the app's own handlers (Esc leaves the chase, T L X toggle the scene), wherever the
  // focus is: stopped on its way down, at the window. What keys do by default still happens: typing, Enter saving, and
  // Esc closing the dialog (the browser's, not a listener's).
  const keep = (e: KeyboardEvent): void => {
    e.stopPropagation() // stopped here, at the window, it reaches no element in the dialog either: the tabs' keys go now
    tabKey(e)
  }
  let downOnBackdrop = false // a drag that starts in the box and ends outside it is no backdrop click
  dialog.addEventListener('pointerdown', (e) => (downOnBackdrop = e.target === dialog))
  dialog.addEventListener('click', (e) => {
    if (downOnBackdrop && e.target === dialog) dialog.close()
  })
  close.addEventListener('click', () => dialog.close())
  reload.addEventListener('click', () => reloadPage())
  let opener: HTMLElement | null = null
  dialog.addEventListener('close', () => {
    window.removeEventListener('keydown', keep, true)
    opener?.focus() // back where it was opened from
  })

  if (opts.search !== undefined && setupDue(opts.store, keySources(opts.env, saved), opts.search)) setup.open()

  return {
    setup: () => setup?.open(),
    open(tab = 'keys') {
      show(tabs.some((t) => t.id === tab) ? tab : 'keys')
      if (dialog.open) return
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
      for (const k of keys) k.reset()
      window.addEventListener('keydown', keep, true)
      dialog.showModal()
    },
    setFallback(id, what, why) {
      const f = failures.get(id) ?? { why, what: [] }
      if (!f.what.includes(what)) f.what.push(what)
      failures.set(id, f)
      for (const k of keys) k.sync()
    },
    setDark(on) {
      dark = on
      showDark()
    },
    destroy() {
      window.removeEventListener('keydown', keep, true)
      if (dialog.open) dialog.close()
      dialog.remove()
      setup?.destroy()
    },
  }
}

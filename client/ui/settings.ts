// client/ui/settings.ts
// The Settings dialog, opened by the rail's gear: the API keys FlightHopper can use. Each is optional: without them it
// runs on keyless Re:Earth terrain and EOX imagery. A key is checked with a cheap request to its own provider, then
// saved in this browser (config.ts KEYS_KEY), where it wins over the build's .env.local from the next load: terrain and
// imagery are built with the viewer, so a reload applies it. A key goes nowhere else: it rides in its provider's
// Authorization header, never in a URL, a log or the page (an .env.local key is never shown). A native modal <dialog>:
// the page behind is inert, so the focus stays in it; Esc, the X and a click on the backdrop close it.
import { KEYS_KEY, keySources, readSavedKeys, writeSavedKeys, type KeySource, type SavedKeys } from '../config.ts'
import { icon, type IconName } from './icons.ts'
import './settings.css'

export type KeyId = 'arcgis' | 'ion'

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
 * page loaded, and a failure while it was in use (the keyless source took its place).
 */
export function keyStatus(id: KeyId, source: KeySource, changed: boolean, failure: string | null): { text: string; tone: 'ok' | 'off' | 'warn' } {
  const spec = SPECS.find((s) => s.id === id)!
  const base = source === 'saved' ? 'Saved in this browser'
    : source === 'env' ? `Using the ${spec.noun} from .env.local`
      : `Not set — using keyless ${spec.keyless}`
  if (changed) return { text: `${base} · reload to apply`, tone: source === 'none' ? 'off' : 'ok' }
  if (failure !== null && source !== 'none') return { text: `${base}, but it failed (${failure}): ${spec.keyless} instead`, tone: 'warn' }
  return { text: base, tone: source === 'none' ? 'off' : 'ok' }
}

export interface SettingsOpts {
  env: Record<string, string | undefined> // the build's (import.meta.env): whether .env.local has each key
  store: Storage | null // localStorage; null where it is blocked (nothing can be saved)
  fetch?: typeof fetch
  reload?: () => void
}

export interface SettingsHandle {
  open(): void
  /** A key failed while the app used it (the keyless source took its place): why, on its status line. */
  setFallback(id: KeyId, why: string): void
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
  const failures = new Map<KeyId, string>()

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
  section.append(
    h('h3', 'fh-settings-section-t', 'API keys'),
    h('p', 'fh-settings-intro', 'FlightHopper runs without keys, on Re:Earth terrain and EOX 10 m imagery. A key saved here stays in this browser, goes only to its own provider, and takes over from .env.local when the page reloads.'),
  )
  body.append(section)

  const foot = h('footer', 'fh-settings-foot')
  foot.hidden = true
  const reload = h('button', 'fh-pill')
  reload.type = 'button'
  const reloadIcon = h('span', 'fh-pill-icon')
  reloadIcon.append(icon('refresh', 16))
  reload.append(reloadIcon, h('span', '', 'Reload now'))
  foot.append(h('p', 'fh-settings-foot-t', 'Keys apply when the page reloads.'), reload)
  box.append(head, body, foot)
  dialog.append(box)
  root.append(dialog)

  const keys: Array<{ sync(): void; reset(): void }> = []
  const syncFoot = (): void => {
    foot.hidden = SPECS.every((s) => saved[s.field] === atLoad[s.field])
  }

  for (const spec of SPECS) {
    const block = h('form', 'fh-key')
    block.noValidate = true
    const top = h('div', 'fh-key-head')
    const label = h('label', 'fh-key-title', spec.title)
    label.htmlFor = `fh-key-${spec.id}`
    const link = h('a', 'fh-key-link', spec.linkText)
    link.href = spec.href
    link.target = '_blank'
    link.rel = 'noopener'
    link.append(icon('external', 13))
    top.append(label, link)

    const field = h('div', 'fh-key-field')
    const input = h('input', 'fh-key-input')
    input.id = `fh-key-${spec.id}`
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
    const save = h('button', 'fh-pill')
    save.type = 'submit'
    const saveText = h('span', '', 'Save')
    const spin = h('span', 'fh-spin')
    spin.hidden = true
    save.append(spin, saveText)
    actions.append(clear, save)
    row.append(status, actions)

    const msg = h('p', 'fh-key-msg')
    msg.setAttribute('role', 'status')
    msg.hidden = true
    const say = (tone: 'ok' | 'err' | 'warn', text: string): void => {
      const name: IconName = tone === 'ok' ? 'check' : tone === 'err' ? 'x' : 'alert'
      msg.replaceChildren(icon(name, 14), h('span', '', text))
      msg.dataset.tone = tone
      msg.hidden = false
    }

    block.append(top, h('p', 'fh-key-about', spec.about), field, row, msg)
    section.append(block)

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
      spin.hidden = false
      saveText.textContent = 'Checking…'
      msg.hidden = true
      input.focus() // Save is disabled while it checks: the focus stays in the dialog
      sync()
      void checkKey(spec.id, key, opts.fetch).then((r) => {
        checking = false
        spin.hidden = true
        saveText.textContent = 'Save'
        if (r.ok === false) say('err', `${r.why}. Not saved.`)
        else if (!store(key)) say('err', 'This browser blocks storage for this page, so the key cannot be saved.')
        else if (r.ok) say('ok', `${spec.provider} accepted the ${spec.noun}. Saved: reload to use it.`)
        else say('warn', `Could not check it (${r.why}). Saved anyway: if it is wrong, the app falls back to ${spec.keyless}.`)
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
  }

  // While it is open, no key reaches the app's own handlers (Esc leaves the chase, T L X toggle the scene), wherever the
  // focus is: stopped on its way down, at the window. What keys do by default still happens: typing, Enter saving, and
  // Esc closing the dialog (the browser's, not a listener's).
  const keep = (e: KeyboardEvent): void => e.stopPropagation()
  let downOnBackdrop = false // a drag that starts in the box and ends outside it is no backdrop click
  dialog.addEventListener('pointerdown', (e) => (downOnBackdrop = e.target === dialog))
  dialog.addEventListener('click', (e) => {
    if (downOnBackdrop && e.target === dialog) dialog.close()
  })
  close.addEventListener('click', () => dialog.close())
  reload.addEventListener('click', () => (opts.reload ?? ((): void => location.reload()))())
  let opener: HTMLElement | null = null
  dialog.addEventListener('close', () => {
    window.removeEventListener('keydown', keep, true)
    opener?.focus() // back where it was opened from
  })

  return {
    open() {
      if (dialog.open) return
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
      for (const k of keys) k.reset()
      window.addEventListener('keydown', keep, true)
      dialog.showModal()
    },
    setFallback(id, why) {
      failures.set(id, why)
      for (const k of keys) k.sync()
    },
    destroy() {
      window.removeEventListener('keydown', keep, true)
      if (dialog.open) dialog.close()
      dialog.remove()
    },
  }
}

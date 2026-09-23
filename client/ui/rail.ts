// client/ui/rail.ts
// The tool rail: small square icon buttons down the right edge. A button opens its panel beside the rail (one panel at a
// time; all start closed) or runs an action. Panel bodies are mounted once, at start, so their owners can update them
// while they are closed. The app routes Esc here first (close()), then to leaving chase. On phones (rail.css) the rail
// is a tab bar along the bottom with a short label under each icon, and a panel is a sheet above it that a downward
// swipe on its header closes.
import { icon, type IconName } from './icons.ts'
import './rail.css'

export interface RailItem {
  id: string
  icon: IconName
  label: string // tooltip and aria-label, e.g. 'Aircraft list'
  short: string // the label under the icon in the phone tab bar, e.g. 'Aircraft'
  group?: number // a thin divider goes between groups
  /** Opens a panel titled `title`; mount() fills its body (and may add controls to its header) once, at start. */
  panel?: { title: string; wide?: boolean; mount(body: HTMLElement, head: HTMLElement): void }
  action?(): void
}

export interface RailHandle {
  readonly openId: string | null
  open(id: string | null): void
  close(): boolean // closes the open panel; false when none was open
  button(id: string): HTMLButtonElement
  setBadge(id: string, text: string | null): void
  setBusy(id: string, busy: boolean): void
  setDot(id: string, state: 'live' | 'replay' | 'trouble' | 'wait' | null): void
  destroy(): void
}

/** Where rail.css turns the rail into a bottom tab bar and panels into sheets. */
export const SHEET_MEDIA = '(max-width: 640px)'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = className
  if (text !== '') e.textContent = text
  return e
}

export function mountRail(root: HTMLElement, items: readonly RailItem[], onOpen?: (id: string | null) => void): RailHandle {
  const rail = el('nav', 'fh-rail fh-glass fh-blur')
  rail.setAttribute('aria-label', 'Tools')
  const panel = el('section', 'fh-panel fh-glass')
  panel.hidden = true
  const head = el('header', 'fh-panel-head')
  const headIcon = el('span', 'fh-panel-icon')
  const title = el('h2', 'fh-panel-title')
  const extras = el('div', 'fh-panel-extras')
  const close = el('button', 'fh-ibtn fh-sm')
  close.type = 'button'
  close.setAttribute('aria-label', 'Close panel')
  close.dataset.tip = 'Close  Esc'
  close.append(icon('x', 16))
  head.append(headIcon, title, extras, close)
  const bodies = el('div', 'fh-panel-bodies')
  panel.append(head, bodies)

  const buttons = new Map<string, HTMLButtonElement>()
  const panes = new Map<string, { body: HTMLElement; extras: HTMLElement; item: RailItem }>()
  const badges = new Map<string, HTMLElement>()
  let openId: string | null = null
  let lastGroup = items[0]?.group ?? 0

  for (const item of items) {
    if ((item.group ?? 0) !== lastGroup) {
      rail.append(el('span', 'fh-rail-sep'))
      lastGroup = item.group ?? 0
    }
    const b = el('button', 'fh-ibtn')
    b.type = 'button'
    b.setAttribute('aria-label', item.label)
    b.dataset.tip = item.label
    b.dataset.id = item.id
    b.append(icon(item.icon), el('span', 'fh-ibtn-label', item.short))
    if (item.panel) b.setAttribute('aria-expanded', 'false')
    b.addEventListener('click', () => (item.panel ? api.open(openId === item.id ? null : item.id) : item.action?.()))
    rail.append(b)
    buttons.set(item.id, b)
    if (item.panel) {
      const body = el('div', 'fh-panel-body')
      body.hidden = true
      const ex = el('div', 'fh-panel-extra')
      ex.hidden = true
      extras.append(ex)
      bodies.append(body)
      item.panel.mount(body, ex)
      panes.set(item.id, { body, extras: ex, item })
    }
  }
  close.addEventListener('click', () => api.open(null))
  root.append(rail, panel)

  // Phone sheet: drag the header down to close (past SWIPE_PX), else it springs back. Clicks on its buttons stay clicks.
  const SWIPE_PX = 70
  let drag: { id: number; y0: number; dy: number } | null = null
  head.addEventListener('pointerdown', (e) => {
    if (!matchMedia(SHEET_MEDIA).matches || (e.target as Element).closest('button, input')) return
    drag = { id: e.pointerId, y0: e.clientY, dy: 0 }
    head.setPointerCapture(e.pointerId)
    panel.style.transition = 'none'
  })
  head.addEventListener('pointermove', (e) => {
    if (drag === null || e.pointerId !== drag.id) return
    drag.dy = Math.max(0, e.clientY - drag.y0)
    panel.style.transform = `translateY(${drag.dy}px)`
  })
  const endDrag = (e: PointerEvent): void => {
    if (drag === null || e.pointerId !== drag.id) return
    const done = drag.dy > SWIPE_PX
    drag = null
    panel.style.transition = ''
    panel.style.transform = ''
    if (done) api.open(null)
  }
  head.addEventListener('pointerup', endDrag)
  head.addEventListener('pointercancel', endDrag)

  const api: RailHandle = {
    get openId() {
      return openId
    },
    open(id) {
      if (id === openId || (id !== null && !panes.has(id))) return
      if (openId !== null) {
        const p = panes.get(openId)!
        p.body.hidden = true
        p.extras.hidden = true
        buttons.get(openId)!.setAttribute('aria-expanded', 'false')
      }
      openId = id
      rail.classList.toggle('fh-has-open', id !== null)
      if (id === null) {
        panel.hidden = true
      } else {
        const p = panes.get(id)!
        p.body.hidden = false
        p.extras.hidden = false
        buttons.get(id)!.setAttribute('aria-expanded', 'true')
        title.textContent = p.item.panel!.title
        headIcon.replaceChildren(icon(p.item.icon, 16))
        panel.classList.toggle('fh-wide', p.item.panel!.wide === true)
        panel.dataset.id = id
        panel.hidden = false
      }
      onOpen?.(id)
    },
    close() {
      if (openId === null) return false
      api.open(null)
      return true
    },
    button(id) {
      const b = buttons.get(id)
      if (!b) throw new Error(`rail: no item ${id}`)
      return b
    },
    setBadge(id, text) {
      let b = badges.get(id)
      if (b === undefined) {
        b = el('span', 'fh-badge fh-num')
        api.button(id).append(b)
        badges.set(id, b)
      }
      b.hidden = text === null
      if (text !== null && b.textContent !== text) b.textContent = text
    },
    setBusy(id, busy) {
      api.button(id).classList.toggle('fh-busy', busy)
    },
    setDot(id, state) {
      const b = api.button(id)
      let d = b.querySelector<HTMLElement>('.fh-dot')
      if (state === null) return d?.remove()
      if (d === null) {
        d = el('span', 'fh-dot fh-ibtn-dot')
        b.append(d)
      }
      if (d.dataset.state !== state) d.dataset.state = state
    },
    destroy() {
      rail.remove()
      panel.remove()
    },
  }
  return api
}

// client/ui/rail.ts
// The tool rail: small square icon buttons down the right edge. A button opens its panel beside the rail (one panel at a
// time; all start closed) or runs an action. Panel bodies are mounted once, at start, so their owners can update them
// while they are closed. The app routes Esc here first (close()), then to leaving chase. On phones (rail.css) the rail
// is a tab bar along the bottom with a short label under each icon, which scrolls sideways when the tabs do not fit, and
// a panel is a sheet above it that a downward swipe on its header closes. An item with a spot is not on the rail: it is
// a button of its own, in a glass square, at that spot (rail.css): 'under' just under the rail, 'corner' at the bottom
// right, 'bottom' at the bottom centre; 'phone' nowhere (the thing it opens has its own place there, e.g. the search box at
// the top centre). On phones there is no room for them: every button is a tab in the one bottom strip, in item order (it
// scrolls sideways when they do not fit). The app can take a button away while what it opens has nothing to show (setHidden):
// its square on a wide screen, its tab on a phone; its panel closes with it.
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
  spot?: 'under' | 'corner' | 'bottom' | 'phone' // a button of its own there, not on the rail; 'phone': a tab on phones only
  action?(): void
}

export interface RailHandle {
  readonly openId: string | null
  open(id: string | null): void
  close(): boolean // closes the open panel; false when none was open
  button(id: string): HTMLButtonElement
  setBadge(id: string, text: string | null): void
  setBusy(id: string, busy: boolean): void
  setHidden(id: string, hidden: boolean): void // the button gone (its square, its tab); an open panel of it closes
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

  const corner = el('div', 'fh-corner')
  const under = el('div', 'fh-under')
  const spots = { under, corner, bottom: el('div', 'fh-spot-bottom') }
  const buttons = new Map<string, HTMLButtonElement>()
  const panes = new Map<string, { body: HTMLElement; extras: HTMLElement; item: RailItem }>()
  const badges = new Map<string, HTMLElement>()
  let openId: string | null = null
  let lastGroup = items[0]?.group ?? 0
  const railKids: HTMLElement[] = [] // the rail's own buttons and dividers, as a wide screen shows them
  const owned: { b: HTMLButtonElement; square: HTMLElement }[] = []

  for (const item of items) {
    const own = item.spot !== undefined // a button of its own, not on the rail
    if (!own && (item.group ?? 0) !== lastGroup) {
      const sep = el('span', 'fh-rail-sep')
      rail.append(sep)
      railKids.push(sep)
      lastGroup = item.group ?? 0
    }
    const b = el('button', 'fh-ibtn')
    b.type = 'button'
    b.setAttribute('aria-label', item.label)
    b.dataset.tip = item.label
    b.dataset.id = item.id
    b.append(icon(item.icon))
    b.append(el('span', 'fh-ibtn-label', item.short)) // shown in the phone tab strip only (rail.css)
    if (item.panel) b.setAttribute('aria-expanded', 'false')
    b.addEventListener('click', () => (item.panel ? api.open(openId === item.id ? null : item.id) : item.action?.()))
    if (item.spot === 'phone') {
      // only in the phone strip (arrange)
    } else if (own) {
      const square = el('div', 'fh-corner-b fh-glass fh-blur')
      square.dataset.id = item.id
      square.append(b)
      spots[item.spot as 'under' | 'corner' | 'bottom'].append(square)
      owned.push({ b, square })
    } else {
      rail.append(b)
      railKids.push(b)
    }
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
  root.append(rail, panel, ...Object.values(spots))

  // The under squares sit 8 px below the rail's foot; on phones (the rail a bottom tab bar) at the top right, with the
  // corner buttons 8 px below them. A sideways phone's full-height rail leaves no room below it: rail.css places them.
  const phone = matchMedia(SHEET_MEDIA)
  const place = (): void => {
    under.style.top = phone.matches || under.childElementCount === 0 ? '' : `${rail.offsetTop + rail.offsetHeight + 8}px`
  }
  // Phones: every button a tab in the strip, in item order; wider: the spot buttons back in their squares.
  const arrange = (): void => {
    if (phone.matches) for (const item of items) rail.append(buttons.get(item.id)!)
    else {
      rail.replaceChildren(...railKids) // a phone-only tab leaves with the rest
      for (const o of owned) o.square.append(o.b)
    }
  }
  arrange()
  phone.addEventListener('change', arrange)

  // Phone tab bar: where it scrolls, a fade on each side that has more tabs (rail.css). Re-read on a scroll, a resize,
  // and a tab shown or hidden (its size changes).
  const edges = (): void => {
    rail.classList.toggle('fh-more-start', rail.scrollLeft > 1)
    rail.classList.toggle('fh-more-end', rail.scrollLeft < rail.scrollWidth - rail.clientWidth - 1)
  }
  rail.addEventListener('scroll', edges, { passive: true })
  const resized = new ResizeObserver(() => {
    edges()
    place()
  })
  resized.observe(rail)
  resized.observe(under)
  for (const b of buttons.values()) resized.observe(b)

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
    setHidden(id, hidden) {
      const b = api.button(id)
      if (b.hidden === hidden) return
      b.hidden = hidden
      const own = owned.find((o) => o.b === b)
      if (own) own.square.hidden = hidden // on a phone the square is empty and not shown at all (rail.css)
      if (hidden && openId === id) api.open(null)
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
      resized.disconnect()
      phone.removeEventListener('change', arrange)
      rail.remove()
      panel.remove()
      for (const e of Object.values(spots)) e.remove()
    },
  }
  return api
}

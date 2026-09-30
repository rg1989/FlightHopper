// client/ui/remote.ts
// The TV remote, with ?tv=1 only (docs/superpowers/specs/2026-09-30-tv-remote-design.md). A kiosk renders the app and
// streams it to the living-room TV, whose remote reaches the page as plain keys: the arrows, Enter (OK), Escape (Back)
// and ContextMenu (Menu); a held key repeats. One keydown listener on the window, in the capture phase, takes them
// first, and a key it acts on goes no further (the scenario player's ←/→ do not fire as well). Two modes:
// - UI: a control has the focus, ringed bold (remote.css). An arrow moves it to the nearest control that way (pickNext);
//   a control that owns some arrows keeps them: a text field ←/→ (its caret), a slider ←/→, a settings tab ←/→. The
//   box the focus is in (a panel, a card, the play bar) comes first. OK clicks it (a slider: its Space). Back is the
//   app's Esc, one step back; then the focus goes to the rail button of the panel that closed, stays where it was, or
//   goes to the first rail button. An arrow with nowhere to go, or Menu, hands the remote to the map. A modal dialog
//   (Settings) keeps the focus inside it and its own Esc.
// - Map: a crosshair at the centre and a hint at the bottom. The top-down map pans (a press a tenth of the view, a held
//   arrow on and on) and zooms (OK in, OK held HOLD_MS out); the chase camera orbits (←/→), tilts (↑/↓) and comes
//   closer or goes farther, through the orbit a mouse drives (?cam=). OK over an aircraft (in the chase, a traffic
//   bracket) picks it as a click there would. Back or Menu gives the focus back to the control it came from.
// The app does the moving (hooks), by cameraStep: every change goes through its usual paths (URL, polls, loading veil).
// Left out of the arrows' reach: the search box (typing needs a keyboard, and its list closes with its field's focus;
// with a keyboard, / still opens it and its keys are its own) and links that open a new tab (no remote key leaves one).
// A focus lost to the page (its control went: a panel closed, the list refreshed, a button replaced) comes back near
// where it was, at once after a key and within WATCH_MS otherwise.
import './remote.css'

export type Dir = 'up' | 'down' | 'left' | 'right'
export type RemoteKey = Dir | 'ok' | 'back' | 'menu'
export type Mode = 'ui' | 'map'
export type Motion = Dir | 'in' | 'out'
/**
 * What has the focus, as the keys see it: a text field, a slider, a tab, a box of text that scrolls, the search box (a
 * keyboard's), anything else.
 */
export type Control = 'text' | 'range' | 'tab' | 'scroll' | 'keyboard' | 'other'
export type Action = 'pass' | 'none' | 'move' | 'scroll' | 'click' | 'back' | 'map' | 'ui' | 'camera' | 'ok'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export const STEP_S = 0.25 // a press moves the camera this long; a held arrow keeps it moving at the same pace
export const PAN_SHARE = 0.1 // a press pans the map a tenth of the view
export const ORBIT_DEG = 15 // a press swings the chase camera this far round the aircraft
export const TILT_DEG = 5 // … or up or down
export const MAP_ZOOM = 2 // OK halves the map camera's height, a held OK doubles it
export const CHASE_ZOOM = 1.5 // … and the chase camera's range, by this
export const HOLD_MS = 600 // OK held this long zooms out (and again each HOLD_MS more)
const HELD_MS = 1000 // a held key repeats (after ~0.5 s, then ~30 times a second): this long with no repeat, it is let go
export const PICK_PX = 40 // the crosshair's ring (remote.css), the square an OK looks for an aircraft in
const RESTORE_PX = 120 // a lost focus goes to a control at most this far from where it was, else to the first rail button
const WATCH_MS = 400
const SCROLL_SHARE = 0.6 // ↑/↓ on a box of text scroll this much of what shows
const EDGE_PX = 1 // boxes this far into each other still count as side by side (sub-pixel layout)
const ACROSS_UP_DOWN = 2 // pickNext: weight of the gap across the way, moving up or down …
const ACROSS_SIDEWAYS = 30 // … and sideways (the W3C spatial-navigation weights) …
const OUT_OF_ROW = 1e6 // … where, as in Android's FocusFinder, a control level with it always wins over one that is not
const ALIGN = 0.01 // … and of the centres' offset across it, which only breaks ties

/** ?tv=1: the kiosk's URL. */
export function tvMode(search: string): boolean {
  return new URLSearchParams(search).get('tv') === '1'
}

const KEYS = new Map<string, RemoteKey>([
  ['ArrowUp', 'up'], ['ArrowDown', 'down'], ['ArrowLeft', 'left'], ['ArrowRight', 'right'],
  ['Enter', 'ok'], ['Escape', 'back'], ['ContextMenu', 'menu'],
])

/** The remote key a keydown is; null for any other key, and with a modifier (a keyboard's: Shift+← is a big step). */
export function remoteKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): RemoteKey | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null
  return KEYS.get(e.key) ?? null
}

/**
 * The candidate the focus moves to from `from` going dir (its index), or -1 when none lies that way. A candidate must
 * lie wholly beyond from's edge that way (EDGE_PX of overlap allowed); the nearest wins by the gap along the way plus
 * the gap across it (0 where they overlap across) times ACROSS_*, ties to the best aligned. Sideways, one level with
 * from (overlapping across) beats any that is not.
 */
export function pickNext(from: Box, cands: readonly Box[], dir: Dir): number {
  const vertical = dir === 'up' || dir === 'down'
  const weight = vertical ? ACROSS_UP_DOWN : ACROSS_SIDEWAYS
  const [a0, a1] = vertical ? [from.x, from.x + from.w] : [from.y, from.y + from.h]
  let best = -1
  let bestScore = Infinity
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i]
    const along = dir === 'down' ? c.y - (from.y + from.h)
      : dir === 'up' ? from.y - (c.y + c.h)
        : dir === 'right' ? c.x - (from.x + from.w)
          : from.x - (c.x + c.w)
    if (along < -EDGE_PX) continue
    const [b0, b1] = vertical ? [c.x, c.x + c.w] : [c.y, c.y + c.h]
    const gap = Math.max(0, b0 - a1, a0 - b1)
    const score = Math.max(0, along) + gap * weight + (!vertical && gap > 0 ? OUT_OF_ROW : 0) + Math.abs(a0 + a1 - b0 - b1) * 0.5 * ALIGN
    if (score < bestScore) {
      best = i
      bestScore = score
    }
  }
  return best
}

/**
 * What a remote key does. UI mode: the arrows move the focus (a text field, slider or tab keeps ←/→: pass; a box of text
 * scrolls with ↑/↓, to its end), OK clicks (a text field's Enter is its own), Back steps back (a text field's and a
 * modal dialog's Esc are their own), Menu goes to map mode (none from a modal dialog); the search box, which only a
 * keyboard reaches, keeps every key but Menu. Map mode: the arrows move the camera, OK is OK (a press or a hold: the
 * caller times it), Back and Menu go back to UI mode.
 */
export function remoteAction(key: RemoteKey, mode: Mode, ctx: { control: Control; modal: boolean }): Action {
  if (mode === 'map') return key === 'ok' ? 'ok' : key === 'back' || key === 'menu' ? 'ui' : 'camera'
  const { control, modal } = ctx
  if (key === 'menu') return modal ? 'none' : 'map'
  if (control === 'keyboard') return 'pass'
  if (key === 'back') return modal || control === 'text' ? 'pass' : 'back'
  if (key === 'ok') return control === 'text' ? 'pass' : 'click'
  const sideways = key === 'left' || key === 'right'
  if (control === 'scroll') return sideways ? 'move' : 'scroll'
  return sideways && control !== 'other' ? 'pass' : 'move'
}

export interface CameraStep {
  dx: number // the top-down map pans (CSS px of the view, right and down) …
  dy: number
  headingDeg: number // … the chase orbit turns (its heading offset from the nose) and tilts (its look pitch) …
  pitchDeg: number
  zoom: number // … and the map's height or the chase range divides by this (> 1: closer)
}

/**
 * The camera's move for dtS of motion m on a w × h view, at the pace of one press per STEP_S: the map pans PAN_SHARE of
 * the view that way; the chase camera goes that way round the aircraft (right: its heading offset falls; up: it rises,
 * so it looks further down); in and out zoom by MAP_ZOOM (chase: CHASE_ZOOM).
 */
export function cameraStep(m: Motion, dtS: number, w: number, h: number, chase: boolean): CameraStep {
  const f = dtS / STEP_S
  const s: CameraStep = { dx: 0, dy: 0, headingDeg: 0, pitchDeg: 0, zoom: 1 }
  const sign = m === 'right' || m === 'down' || m === 'in' ? 1 : -1
  if (m === 'left' || m === 'right') {
    s.dx = sign * PAN_SHARE * w * f
    s.headingDeg = -sign * ORBIT_DEG * f
  } else if (m === 'up' || m === 'down') {
    s.dy = sign * PAN_SHARE * h * f
    s.pitchDeg = sign * TILT_DEG * f
  } else s.zoom = (chase ? CHASE_ZOOM : MAP_ZOOM) ** (sign * f)
  return s
}

// ---- DOM ----------------------------------------------------------------------------------------------------------

export interface RemoteHooks {
  chasing(): boolean // the 3-D view (a scenario's too): the arrows orbit and tilt, OK comes closer
  move(m: Motion, dtS: number): void // move the camera by cameraStep(m, dtS, …)
  pick(): boolean // OK at the crosshair: what a click there picks (a traffic bracket, an aircraft); false: nothing there
  back(): void // the app's Esc: one step back
}

export interface RemoteHandle {
  destroy(): void
}

// What the arrows move the focus to. A list row (the aircraft list's) takes clicks but not the focus on the desktop:
// focus() gives it a tabindex here.
// So is a box of text that scrolls with nothing focusable in it (the card's details, a scenario's), which ↑/↓ scroll.
const SCROLLS = '.fh-card-more, .fh-scn-details'
const FOCUSABLE = `button, input, select, textarea, a[href], [tabindex], .fh-row, ${SCROLLS}`
const NATIVE = 'button, input, select, textarea, a[href], [tabindex]'
const SKIP = '.fh-search, a[target="_blank"]'
// The boxes an arrow looks in first, before the rest of the page: from a panel's header ↓ goes into the panel, not to
// the rail beside it.
const GROUP = '.fh-panel, .fh-card, .fh-playbar, .fh-frame, .fh-outage-card, .fh-ending-card'
const TEXT = new Set(['text', 'search', 'password', 'email', 'url', 'tel', 'number'])
const HINTS: Readonly<Record<'map' | 'chase', readonly [string, string][]>> = {
  map: [['◀ ▲ ▼ ▶', 'move'], ['OK', 'zoom in / pick'], ['hold OK', 'zoom out'], ['Back', 'done']],
  chase: [['◀ ▶', 'orbit'], ['▲ ▼', 'tilt'], ['OK', 'closer / pick'], ['hold OK', 'farther'], ['Back', 'done']],
}

const boxOf = (el: Element): Box => {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height }
}

function control(el: Element | null): Control {
  if (!(el instanceof HTMLElement)) return 'other'
  if (el.closest('.fh-search') !== null) return 'keyboard'
  if (el.matches(SCROLLS)) return 'scroll'
  if (el instanceof HTMLInputElement) return el.type === 'range' ? 'range' : TEXT.has(el.type) ? 'text' : 'other'
  if (el instanceof HTMLTextAreaElement || el.isContentEditable) return 'text'
  return el.getAttribute('role') === 'tab' ? 'tab' : 'other'
}

/** Drawn: it has a size and is neither invisible nor transparent. */
function rendered(el: Element): boolean {
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return false
  const s = getComputedStyle(el)
  return s.visibility !== 'hidden' && s.opacity !== '0'
}

/** A control the arrows may go to: not a text field either (a remote cannot type; the aircraft list's filter). */
function usable(el: Element): el is HTMLElement {
  return el instanceof HTMLElement && !el.matches(':disabled') && el.closest(SKIP) === null && el.closest('[inert]') === null && control(el) !== 'text' && rendered(el)
}

/**
 * Scrolls each scrolling box round el the least that shows all of it (scrollIntoView's block: 'nearest'), which
 * scrollIntoView itself would not stop at: it scrolls the overlay layer and the page too (overflow: hidden scrolls from
 * a script).
 */
function reveal(el: HTMLElement): void {
  for (let p = el.parentElement; p !== null && p !== document.body; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY
    if (y !== 'auto' && y !== 'scroll') continue
    const r = el.getBoundingClientRect()
    const top = p.getBoundingClientRect().top + p.clientTop
    const bottom = top + p.clientHeight
    if (r.top < top) p.scrollTop -= top - r.top
    else if (r.bottom > bottom) p.scrollTop += Math.min(r.bottom - bottom, r.top - top)
  }
}

/**
 * Scrolls a box of text a step (SCROLL_SHARE of what shows) that way: itself where it scrolls, else the box it scrolls
 * in, until its edge that way shows. False when that edge already shows: the arrow moves on.
 */
function scrollText(el: HTMLElement, down: boolean): boolean {
  let box: HTMLElement | null = el
  while (box !== null && box !== document.body && !/^(auto|scroll)$/.test(getComputedStyle(box).overflowY)) box = box.parentElement
  if (box === null || box === document.body) return false
  const r = el.getBoundingClientRect()
  const b = box.getBoundingClientRect()
  const hidden = box === el ? (down ? el.scrollHeight - el.clientHeight - el.scrollTop : el.scrollTop)
    : down ? r.bottom - (b.top + box.clientTop + box.clientHeight) : b.top + box.clientTop - r.top
  if (hidden < 1) return false
  box.scrollTop += (down ? 1 : -1) * Math.min(hidden, Math.round(box.clientHeight * SCROLL_SHARE))
  return true
}

/** Mounts the crosshair and hint in ui and takes the remote's keys until destroy(). The focus starts on the rail. */
export function mountRemote(ui: HTMLElement, hooks: RemoteHooks): RemoteHandle {
  const html = document.documentElement
  html.dataset.tv = ''
  const cross = document.createElement('div')
  cross.className = 'fh-remote-cross'
  const hint = document.createElement('div')
  hint.className = 'fh-remote-hint fh-glass'
  cross.hidden = hint.hidden = true
  ui.append(cross, hint)

  let mode: Mode = 'ui'
  let from: HTMLElement | null = null // the control map mode came from
  let last: { box: Box; panel: string | null } | null = null // where the focus last was, and in which rail panel

  const modal = (): Element | null => document.querySelector(':modal')
  const candidates = (): HTMLElement[] => [...(modal() ?? document).querySelectorAll(FOCUSABLE)].filter(usable)
  const openPanel = (): string | null => document.querySelector<HTMLElement>('.fh-panel:not([hidden])')?.dataset.id ?? null
  const railButton = (id: string): HTMLElement | null => document.querySelector(`.fh-ui button[data-id="${CSS.escape(id)}"]`)
  const firstRail = (): HTMLElement | null => [...document.querySelectorAll('.fh-rail button')].find(usable) ?? null
  /** Nothing has the focus, or what has it is not drawn any more. */
  const lost = (): boolean => {
    const a = document.activeElement
    return !(a instanceof HTMLElement) || a === document.body || !rendered(a)
  }

  function focus(el: HTMLElement | null): void {
    if (el === null) return
    if (!el.matches(NATIVE)) el.tabIndex = -1 // a list row: focusable from a script only, as it was for the mouse
    el.focus({ preventScroll: true })
    reveal(el)
    last = { box: boxOf(el), panel: el.closest<HTMLElement>('.fh-panel')?.dataset.id ?? null }
  }
  const onFocusIn = (e: FocusEvent): void => {
    const el = e.target
    if (el instanceof HTMLElement && el !== document.body) last = { box: boxOf(el), panel: el.closest<HTMLElement>('.fh-panel')?.dataset.id ?? null }
  }

  /**
   * The focus back near where it was lost: the rail button of the panel it was in, now closed; else the control nearest
   * where it was (one that took its place), not a text field; else the first rail button (in a dialog, its first control).
   */
  function restore(): void {
    const m = modal()
    const b = m === null && last?.panel != null && openPanel() !== last.panel ? railButton(last.panel) : null
    if (b !== null && usable(b)) return focus(b)
    const cands = candidates().filter((el) => control(el) !== 'text')
    let near: HTMLElement | null = null
    let nearD = m === null ? RESTORE_PX : Infinity
    if (last !== null) {
      const cx = last.box.x + last.box.w / 2
      const cy = last.box.y + last.box.h / 2
      for (const el of cands) {
        const r = boxOf(el)
        const d = Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy)
        if (d < nearD) {
          near = el
          nearD = d
        }
      }
    }
    focus(near ?? (m === null ? firstRail() : (cands[0] ?? null)))
  }

  /** The focus to the nearest control dir of it, in its own box first (GROUP); false when there is none. */
  function moveFocus(dir: Dir): boolean {
    const a = document.activeElement!
    const all = candidates().filter((c) => c !== a)
    const group = a.closest(GROUP)
    for (const cands of group === null ? [all] : [all.filter((c) => group.contains(c)), all]) {
      const i = pickNext(boxOf(a), cands.map(boxOf), dir)
      if (i >= 0) return (focus(cands[i]), true)
    }
    return false
  }

  function back(): void {
    const open = openPanel()
    hooks.back()
    if (open !== null && openPanel() === null) {
      const b = railButton(open)
      if (b !== null && usable(b)) return focus(b)
    }
    if (lost() || control(document.activeElement) === 'text') focus(firstRail())
  }

  function paintHint(): void {
    const kind = hooks.chasing() ? 'chase' : 'map'
    if (hint.dataset.kind === kind) return
    hint.dataset.kind = kind
    hint.replaceChildren()
    HINTS[kind].forEach(([keys, what], i) => {
      const b = document.createElement('b')
      b.textContent = keys
      hint.append(i === 0 ? '' : ' · ', b, ` ${what}`)
    })
  }

  function toMap(): void {
    const a = document.activeElement
    from = a instanceof HTMLElement && a !== document.body ? a : null
    from?.blur()
    mode = 'map'
    paintHint()
    cross.hidden = hint.hidden = false
  }

  function toUi(): void {
    mode = 'ui'
    stop()
    cross.hidden = hint.hidden = true
    focus(from !== null && from.isConnected && usable(from) ? from : firstRail())
    from = null
  }

  // Camera motions under way, frame by frame: a press owes one STEP_S of motion, whatever the frame rate; a held key
  // keeps it going until its release (or HELD_MS with no repeat: a release that never came).
  const moving = new Map<Motion, { owedS: number; held: boolean; seen: number }>()
  let raf = 0
  let lastT = 0
  function run(m: Motion, held: boolean): void {
    const now = performance.now()
    moving.set(m, { owedS: STEP_S, held, seen: now })
    if (raf !== 0) return
    lastT = now
    raf = requestAnimationFrame(tick)
  }
  function tick(t: number): void {
    const dtS = Math.min(STEP_S, Math.max(0, (t - lastT) / 1000)) // a stall does not jump the camera
    lastT = t
    for (const [m, s] of moving) {
      const holding = s.held && t - s.seen < HELD_MS
      const d = holding ? dtS : Math.min(dtS, s.owedS)
      s.owedS = Math.max(0, s.owedS - dtS)
      if (d > 0) hooks.move(m, d)
      if (!holding && s.owedS === 0) moving.delete(m)
    }
    raf = moving.size > 0 ? requestAnimationFrame(tick) : 0
  }

  // OK in map mode: on its release, a pick or a zoom in; held HOLD_MS, a zoom out instead (and again every HOLD_MS).
  let okDownAt: number | null = null
  let okSeen = 0
  let okHeld = false
  let okTimer: ReturnType<typeof setTimeout> | null = null
  function okHold(): void {
    okTimer = null
    if (okDownAt === null) return
    if (performance.now() - okSeen > HELD_MS) return void (okDownAt = null) // no repeats: its release was lost
    okHeld = true
    run('out', false)
    okTimer = setTimeout(okHold, HOLD_MS)
  }
  function okUp(): void {
    if (okTimer !== null) clearTimeout(okTimer)
    okTimer = null
    const down = okDownAt
    okDownAt = null
    if (down === null || okHeld) return
    if (!hooks.pick()) run('in', false)
  }

  function stop(): void {
    moving.clear()
    if (raf !== 0) cancelAnimationFrame(raf)
    raf = 0
    if (okTimer !== null) clearTimeout(okTimer)
    okTimer = null
    okDownAt = null
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    const key = remoteKey(e)
    if (key === null) return
    const act = remoteAction(key, mode, { control: control(document.activeElement), modal: modal() !== null })
    if (act === 'pass') return
    e.preventDefault()
    e.stopImmediatePropagation()
    if (mode === 'ui' && lost() && act !== 'back' && act !== 'map') return restore() // show where the focus is first
    const now = performance.now()
    switch (act) {
      case 'scroll':
        if (scrollText(document.activeElement as HTMLElement, key === 'down')) return
      // falls through: at its end, the arrow moves on
      case 'move':
        // A held arrow stops at the last control; only a press goes on to the map.
        if (!moveFocus(key as Dir) && !e.repeat && modal() === null) toMap()
        return
      case 'click': {
        if (e.repeat) return
        const a = document.activeElement as HTMLElement
        // A slider has nothing to click: OK is its Space (the play bar's scrubber and volume: play or pause).
        if (control(a) === 'range') a.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }))
        else {
          const was = openPanel()
          a.click()
          // A rail button that opened its panel hands the focus into it: its first list row, else its first control.
          const id = openPanel()
          if (id !== null && id !== was) requestAnimationFrame(() => {
            const p = document.querySelector<HTMLElement>('.fh-panel:not([hidden])')
            const inside = candidates().filter((c) => p?.contains(c) && c.closest('.fh-panel-head') === null)
            focus(inside.find((c) => c.matches('.fh-row')) ?? inside[0] ?? null)
          })
        }
        return
      }
      case 'back':
        if (!e.repeat) back()
        return
      case 'map':
        if (!e.repeat) toMap()
        return
      case 'ui':
        if (!e.repeat) toUi()
        return
      case 'camera': {
        paintHint()
        const s = moving.get(key as Dir)
        if (e.repeat && s !== undefined) s.seen = now
        else run(key as Dir, true)
        return
      }
      case 'ok':
        paintHint()
        if (e.repeat) okSeen = now
        else {
          okDownAt = okSeen = now
          okHeld = false
          if (okTimer !== null) clearTimeout(okTimer)
          okTimer = setTimeout(okHold, HOLD_MS)
        }
    }
  }
  const onKeyUp = (e: KeyboardEvent): void => {
    const key = remoteKey(e)
    if (key === null || mode !== 'map') return
    e.preventDefault()
    e.stopImmediatePropagation()
    if (key === 'ok') okUp()
    else {
      const s = moving.get(key as Motion)
      if (s !== undefined) s.held = false
    }
  }
  const onBlur = (): void => {
    for (const s of moving.values()) s.held = false
    okDownAt = null
  }
  const noMenu = (e: Event): void => e.preventDefault() // Menu is the remote's: never the page's context menu
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('blur', onBlur)
  window.addEventListener('contextmenu', noMenu, true)
  document.addEventListener('focusin', onFocusIn)
  const watch = setInterval(() => mode === 'ui' && lost() && restore(), WATCH_MS)
  focus(firstRail())

  return {
    destroy() {
      stop()
      clearInterval(watch)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('contextmenu', noMenu, true)
      document.removeEventListener('focusin', onFocusIn)
      cross.remove()
      hint.remove()
      delete html.dataset.tv
    },
  }
}

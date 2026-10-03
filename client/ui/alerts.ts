// client/ui/alerts.ts
// The Events panel (the rail's bell) and its toasts: the emergencies and steep descents the server finds worldwide
// (server/alerts.ts; shared/alerts.ts words them). The panel, top to bottom: the server's switch, Watch the world, with a
// line on what it watches; two options kept in this browser, Follow automatically and Desktop notifications (where the
// browser has them); then the last 7 days of events, newest first. A row follows its aircraft live while its event is
// ongoing, else replays it in History; a small text button beside it does the other (Live only within the hour). Quiet
// events (a light aircraft's radio failure) are listed, dimmed, and raise nothing. After the first reply, each new
// alerting event shows a toast (at most 3, each closing by itself after 30 s) and, with the option on, a desktop
// notification; with Follow automatically on, the app is asked to follow the newest (onAuto). The rail's bell counts the
// events since the panel was last opened (opened after it, or come in after it: found late); while it is open they count
// as seen. The app owns the fetching, the rail, and what following and replaying do.
import { ongoing, what, who, type AlertEvent, type EventsReply } from '../../shared/alerts.ts'
import { icon, type IconName } from './icons.ts'
import './sceneToggles.css' // the switch rows are the Layers panel's (.fh-scene-row and its parts)
import './alerts.css'

export interface AlertsUiOpts {
  store: Storage | null // the browser's own options (follow, notifications, when the panel was last opened); null: blocked
  nowMs(): number // the server's clock where known (ApiClient.serverNowMs), else Date.now
  onSwitch(on: boolean): Promise<EventsReply> // the server's switch (ApiClient.setAlerts)
  onFollow(e: AlertEvent): void // follow its aircraft live
  onReplay(e: AlertEvent): void // History at the event, its aircraft selected
  onAuto(e: AlertEvent): void // "Follow automatically" is on and a new live event came in: the app decides (not in History or a scenario)
  onBadge(text: string | null): void // the rail's count of events not yet seen
}

export interface AlertsHandle {
  update(reply: EventsReply | null): void // a reply of GET or POST /api/events; null: no alerts on this server
  opened(): void // the panel was opened: what it lists counts as seen, the badge clears
  destroy(): void
}

type Action = 'follow' | 'replay'

const TOAST_MS = 30_000 // a toast closes by itself after this
const TOAST_AFTER_MS = 4000 // …and at least this long after the pointer or the focus leaves it
const MAX_TOASTS = 3
const LIVE_MS = 60 * 60_000 // a replayed row offers Live while its aircraft was seen with its cause this recently
const TICK_MS = 15_000 // the open panel's times, live dots and actions are redrawn this often
const FOLLOW_KEY = 'fh.alerts.follow'
const NOTIFY_KEY = 'fh.alerts.notify'
const SEEN_KEY = 'fh.alerts.seen'
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const NOTIFY_HINT = 'A notification for each new event'
const BLOCKED_HINT = 'Blocked in this browser’s settings'
const NONE: ReadonlySet<string> = new Set()

/** The alerting events (not quiet) whose ids are not in known, newest first. known is not changed. */
export function freshEvents(known: ReadonlySet<string>, next: readonly AlertEvent[]): AlertEvent[] {
  return next.filter((e) => !e.quiet && !known.has(e.id)).sort((a, b) => b.openedMs - a.openedMs)
}

/**
 * The alerting events opened after seenMs (when the panel was last opened), and those in since (ids that came in after it
 * though they opened before: found late, or confirmed after the look).
 */
export function unseenCount(events: readonly AlertEvent[], seenMs: number, since: ReadonlySet<string> = NONE): number {
  let n = 0
  for (const e of events) if (!e.quiet && (e.openedMs > seenMs || since.has(e.id))) n++
  return n
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** How long ago ms was, from nowMs: "now", "5 min ago", "3 h ago", then the day and the time (local): "Wed 14:05". */
export function ago(ms: number, nowMs: number): string {
  const d = nowMs - ms
  if (d < 60_000) return 'now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`
  const t = new Date(ms)
  return `${DAYS[t.getDay()]} ${pad2(t.getHours())}:${pad2(t.getMinutes())}`
}

/** What a click on its row does: an ongoing live event is followed; any other is replayed in History. */
export function primaryAction(e: AlertEvent, nowMs: number): Action {
  return ongoing(e, nowMs) ? 'follow' : 'replay'
}

/** The row's small text button: Replay beside a followed row, Live beside a replayed one seen within the hour; else none. */
export function secondaryAction(e: AlertEvent, nowMs: number): Action | null {
  if (primaryAction(e, nowMs) === 'follow') return 'replay'
  return nowMs - e.lastMs < LIVE_MS ? 'follow' : null
}

/** The tag: the squawk, else EMG for a status, else an arrow for a fall. Red for 7700, 7500 and any fall; amber for the rest. */
export function tagOf(e: AlertEvent): { text: string; tone: 'danger' | 'warn' } {
  const text = e.squawk ?? (e.emergency !== null ? 'EMG' : '↓')
  return { text, tone: e.drop !== null || e.squawk === '7700' || e.squawk === '7500' ? 'danger' : 'warn' }
}

/** The line under the switch: what the server watches. null: this server has no alerts. */
export function watchText(reply: EventsReply | null): string {
  if (reply === null) return 'This server has no alerts: run it with make live'
  if (!reply.on) return 'Off'
  return reply.sweep
    ? 'Watching: squawks every 30 s, descents from each half hour of adsb.lol'
    : 'Watching what this app polls, and each half hour of adsb.lol'
}

const actionText = (e: AlertEvent, action: Action): string => (action === 'follow' ? `Follow ${who(e)} live` : `Replay ${who(e)} in History`)

/** A row's accessible name: what its click does, then what happened and when. */
export function rowLabel(e: AlertEvent, nowMs: number): string {
  return `${actionText(e, primaryAction(e, nowMs))}: ${what(e)}, ${ago(e.openedMs, nowMs)}${e.late ? ', found late' : ''}`
}

/** A stored option is on ('1'); off where it is not, and where storage is blocked. */
function readOn(store: Storage | null, key: string): boolean {
  try {
    return store?.getItem(key) === '1'
  } catch {
    return false
  }
}

/** When the panel was last opened; 0 when never (the first visit counts the whole week) or where storage is blocked. */
function readSeen(store: Storage | null): number {
  try {
    const ms = Number(store?.getItem(SEEN_KEY) ?? 0)
    return Number.isFinite(ms) ? ms : 0
  } catch {
    return 0
  }
}

function keep(store: Storage | null, key: string, value: string): void {
  try {
    store?.setItem(key, value)
  } catch {
    // blocked or full: kept for this page only
  }
}

/** The browser's desktop notifications; null where there are none: an iPhone outside a Home Screen app, a page not served securely. */
function notificationApi(): typeof Notification | null {
  return 'Notification' in window && window.isSecureContext ? window.Notification : null
}

/** Notification.requestPermission, also where it still takes a callback and returns nothing (older Safari). */
function askPermission(n: typeof Notification): Promise<NotificationPermission> {
  return new Promise((resolve) => {
    try {
      const asked = n.requestPermission(resolve) as Promise<NotificationPermission> | undefined
      asked?.then(resolve, () => resolve(n.permission))
    } catch {
      resolve(n.permission)
    }
  })
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = className
  if (text !== '') el.textContent = text
  return el
}

/** Writes a text or an attribute only when it changes (the open panel is redrawn every few seconds). */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text
}
function setAttr(el: HTMLElement, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value)
}
function setData(el: HTMLElement, key: string, value: string): void {
  if (el.dataset[key] !== value) el.dataset[key] = value
}

let ids = 0 // ids for aria-describedby, unique if the panel is ever mounted twice

interface SwitchRow {
  row: HTMLElement
  sw: HTMLButtonElement
  hint: HTMLElement
}

/** A switch row as the Layers panel's (sceneToggles.ts): an icon, a label, a hint, the switch. The whole row is the target. */
function switchRow(name: string, ic: IconName, label: string, hint: string, onClick: () => void): SwitchRow {
  const row = h('div', 'fh-scene-row fh-alerts-row')
  row.dataset.row = name
  const box = h('span', 'fh-scene-icon')
  box.append(icon(ic, 18))
  const text = h('div', 'fh-scene-text')
  const hintEl = h('span', 'fh-scene-hint fh-alerts-hint', hint)
  hintEl.id = `fh-alerts-${++ids}`
  text.append(h('span', 'fh-scene-label', label), hintEl)
  const sw = h('button', 'fh-switch')
  sw.type = 'button'
  sw.setAttribute('role', 'switch')
  sw.setAttribute('aria-checked', 'false')
  sw.setAttribute('aria-label', label)
  sw.setAttribute('aria-describedby', hintEl.id)
  sw.addEventListener('click', onClick)
  row.addEventListener('click', (e) => e.target !== sw && sw.click()) // a disabled switch takes no click()
  row.append(box, text, sw)
  return { row, sw, hint: hintEl }
}

/** One event's row: the main button (tag, aircraft, what happened, when, live or late) and the small text button beside it. */
interface Row {
  e: AlertEvent
  action: Action
  alt: Action | null
  li: HTMLLIElement
  main: HTMLButtonElement
  tag: HTMLElement
  who: HTMLElement
  what: HTMLElement
  ago: HTMLElement
  dot: HTMLElement
  late: HTMLElement
  altBtn: HTMLButtonElement
}

interface Toast {
  el: HTMLElement
  timer: ReturnType<typeof setTimeout> | null
  leftMs: number // of its 30 s
  armedMs: number // when the timer last started (Date.now)
  hover: boolean
  focus: boolean
}

export function mountAlerts(body: HTMLElement, toastRoot: HTMLElement, opts: AlertsUiOpts): AlertsHandle {
  const { store } = opts
  const notifications = notificationApi()
  let reply: EventsReply | null | undefined // undefined until the first answer; null: no alerts on this server
  let switching = false // the switch's request is under way
  let failed = false // the last switch failed: the line says so until the next answer
  let primed = false // the first answer came: what it held was not new
  const known = new Set<string>() // ids of the alerting events seen (toasted, or there at the first answer)
  const since = new Set<string>() // ids toasted since the panel was last open (on the bell, whenever they opened)
  let follow = readOn(store, FOLLOW_KEY)
  let notify = readOn(store, NOTIFY_KEY)
  let seenMs = readSeen(store)
  let dead = false
  const act = (e: AlertEvent, action: Action): void => (action === 'follow' ? opts.onFollow(e) : opts.onReplay(e))
  const visible = (): boolean => !body.hidden // the rail shows the open panel's body only

  const root = h('div', 'fh-alerts')
  root.dataset.state = 'loading'

  // The server's switch, then what it watches.
  const watch = switchRow('watch', 'radar', 'Watch the world', 'Emergency squawks and steep descents, anywhere', () => {
    if (reply == null || switching) return
    switching = true
    failed = false
    showWatch()
    opts.onSwitch(!reply.on).then(
      (r) => {
        switching = false
        handle.update(r)
      },
      (err: unknown) => {
        if (dead) return
        console.warn('FlightHopper: the alerts switch failed:', err)
        switching = false
        failed = true
        showWatch()
      },
    )
  })
  const spin = h('span', 'fh-spin fh-alerts-spin')
  spin.hidden = true
  watch.row.insertBefore(spin, watch.sw)
  const line = h('p', 'fh-alerts-line')
  line.id = `fh-alerts-${++ids}`
  line.hidden = true
  watch.sw.setAttribute('aria-describedby', `${watch.hint.id} ${line.id}`)

  const followRow = switchRow('follow', 'plane', 'Follow automatically', 'Go to each new event’s aircraft', () => {
    follow = !follow
    keep(store, FOLLOW_KEY, follow ? '1' : '0')
    followRow.sw.setAttribute('aria-checked', String(follow))
  })
  followRow.sw.setAttribute('aria-checked', String(follow))

  // Shown on only with the browser's permission; turning it on asks for it in the click (a browser asks only then).
  const notifyOn = (): boolean => notifications !== null && notify && notifications.permission === 'granted'
  const notifyRow = switchRow('notify', 'bell', 'Desktop notifications', NOTIFY_HINT, () => {
    if (notifications === null) return
    if (notifyOn()) {
      notify = false
      keep(store, NOTIFY_KEY, '0')
      return showNotify()
    }
    void askPermission(notifications).then((p) => {
      if (dead) return
      notify = p === 'granted'
      keep(store, NOTIFY_KEY, notify ? '1' : '0')
      showNotify()
    })
  })
  notifyRow.row.hidden = notifications === null
  const showNotify = (): void => {
    setAttr(notifyRow.sw, 'aria-checked', String(notifyOn()))
    setText(notifyRow.hint, notifications?.permission === 'denied' ? BLOCKED_HINT : NOTIFY_HINT)
  }
  showNotify()

  const options = h('div', 'fh-scene fh-alerts-options')
  options.append(watch.row, line, followRow.row, notifyRow.row)

  // The week's events.
  const section = h('h3', 'fh-alerts-section', 'Last 7 days')
  section.id = `fh-alerts-${++ids}`
  const skel = h('div', 'fh-alerts-skel')
  skel.setAttribute('aria-hidden', 'true')
  for (let i = 0; i < 3; i++) skel.append(h('span', 'fh-skel')) // widths in the CSS
  const list = h('ul', 'fh-alerts-list')
  list.setAttribute('aria-labelledby', section.id)
  list.hidden = true
  const empty = h('p', 'fh-alerts-empty', 'Nothing in the last 7 days.')
  empty.hidden = true
  root.append(options, section, skel, list, empty)
  body.append(root)
  const rows = new Map<string, Row>() // by event id: kept across redraws, so a focused row keeps its focus

  // New events: a stack of toasts at the top centre, a live region for screen readers.
  const stack = h('div', 'fh-toasts fh-alerts-toasts')
  stack.setAttribute('role', 'status')
  stack.setAttribute('aria-atomic', 'false') // a new toast is read, not the whole stack again
  toastRoot.append(stack)
  const toasts: Toast[] = [] // oldest first
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')

  function showWatch(): void {
    const on = reply?.on === true
    root.dataset.state = reply === undefined ? 'loading' : reply === null ? 'none' : on ? 'on' : 'off'
    setAttr(watch.sw, 'aria-checked', String(on))
    watch.sw.disabled = reply == null || switching
    setAttr(watch.sw, 'aria-busy', String(switching))
    spin.hidden = !switching
    line.hidden = reply === undefined && !failed
    line.dataset.state = failed ? 'error' : reply === undefined ? 'loading' : reply === null ? 'none' : on ? 'on' : 'off'
    setText(line, failed ? 'Could not change it. Try again.' : reply === undefined ? '' : watchText(reply))
  }
  showWatch()

  function makeRow(e: AlertEvent): Row {
    const li = h('li', 'fh-alerts-item')
    const main = h('button', 'fh-alerts-main')
    main.type = 'button'
    const tag = h('span', 'fh-alerts-tag fh-num')
    tag.setAttribute('aria-hidden', 'true') // the button's label says it in words
    const text = h('span', 'fh-alerts-text')
    const whoEl = h('span', 'fh-alerts-who')
    const whatEl = h('span', 'fh-alerts-what')
    text.append(whoEl, whatEl)
    const meta = h('span', 'fh-alerts-meta')
    const agoEl = h('span', 'fh-alerts-ago fh-num')
    const dot = h('span', 'fh-dot fh-alerts-live')
    dot.dataset.state = 'live'
    const late = h('span', 'fh-alerts-late', 'late')
    meta.append(agoEl, dot, late)
    main.append(tag, text, meta)
    const altBtn = h('button', 'fh-alerts-alt')
    altBtn.type = 'button'
    li.append(main, altBtn)
    const r: Row = { e, action: 'replay', alt: null, li, main, tag, who: whoEl, what: whatEl, ago: agoEl, dot, late, altBtn }
    main.addEventListener('click', () => act(r.e, r.action))
    altBtn.addEventListener('click', (ev) => {
      ev.stopPropagation() // the row's own click is the other action
      if (r.alt !== null) act(r.e, r.alt)
    })
    return r
  }

  function paintRow(r: Row, e: AlertEvent, now: number): void {
    r.e = e
    r.action = primaryAction(e, now)
    r.alt = secondaryAction(e, now)
    const tag = tagOf(e)
    setData(r.li, 'id', e.id)
    setData(r.li, 'action', r.action)
    setData(r.li, 'tone', tag.tone)
    r.li.classList.toggle('fh-alerts-quiet', e.quiet)
    setText(r.tag, tag.text)
    setText(r.who, who(e))
    setText(r.what, what(e))
    setText(r.ago, ago(e.openedMs, now))
    setAttr(r.main, 'aria-label', rowLabel(e, now))
    const tip = r.action === 'follow' ? 'Follow live' : 'Replay in History'
    if (r.main.title !== tip) r.main.title = tip
    if (r.dot.hidden === (r.action === 'follow')) r.dot.hidden = r.action !== 'follow' // ongoing: a live dot
    if (r.late.hidden === e.late) r.late.hidden = !e.late
    if (r.altBtn.hidden === (r.alt !== null)) r.altBtn.hidden = r.alt === null
    if (r.alt !== null) {
      setText(r.altBtn, r.alt === 'follow' ? 'Live' : 'Replay')
      setAttr(r.altBtn, 'aria-label', actionText(e, r.alt))
    }
  }

  /** The list as the last answer has it, at the time now: rows kept by id, moved only when the order changes. */
  function paintList(): void {
    skel.hidden = reply !== undefined
    section.hidden = reply === null
    if (reply == null) {
      list.hidden = empty.hidden = true
      if (reply === null && rows.size > 0) {
        rows.clear()
        list.replaceChildren()
      }
      return
    }
    const now = opts.nowMs()
    const els: HTMLElement[] = []
    const listed = new Set<string>()
    for (const e of reply.events) {
      let r = rows.get(e.id)
      if (r === undefined) rows.set(e.id, (r = makeRow(e)))
      paintRow(r, e, now)
      listed.add(e.id)
      els.push(r.li)
    }
    for (const id of rows.keys()) if (!listed.has(id)) rows.delete(id)
    const kids = list.children
    if (kids.length !== els.length || els.some((el, i) => kids[i] !== el)) {
      const focused = document.activeElement
      list.replaceChildren(...els)
      if (focused instanceof HTMLElement && focused !== document.activeElement && list.contains(focused)) focused.focus({ preventScroll: true })
    }
    list.hidden = els.length === 0
    empty.hidden = els.length > 0
  }
  paintList()

  /** The panel shows its list: everything in it counts as seen. */
  function seen(now: number): void {
    seenMs = now
    since.clear()
    keep(store, SEEN_KEY, String(Math.round(now)))
  }

  function badge(): void {
    const n = reply == null ? 0 : unseenCount(reply.events, seenMs, since)
    opts.onBadge(n > 0 ? String(n) : null)
  }

  /** Starts the rest of a toast's time (it closes by itself), unless the pointer or the focus is on it. */
  function arm(t: Toast): void {
    if (t.timer !== null || t.hover || t.focus) return
    t.armedMs = Date.now()
    t.timer = setTimeout(() => closeToast(t), t.leftMs)
  }
  function hold(t: Toast): void {
    if (t.timer === null) return
    clearTimeout(t.timer)
    t.timer = null
    t.leftMs = Math.max(TOAST_AFTER_MS, t.leftMs - (Date.now() - t.armedMs))
  }
  function closeToast(t: Toast, fade = true): void {
    const i = toasts.indexOf(t)
    if (i < 0) return
    toasts.splice(i, 1)
    if (t.timer !== null) clearTimeout(t.timer)
    t.timer = null
    if (!fade || reduced.matches) return t.el.remove()
    t.el.classList.add('fh-out')
    setTimeout(() => t.el.remove(), 180)
  }

  /** A toast for a new event, the newest on top; the oldest goes when there would be more than MAX_TOASTS. */
  function showToast(e: AlertEvent, now: number): void {
    while (toasts.length >= MAX_TOASTS) closeToast(toasts[0], false)
    const action = primaryAction(e, now)
    const tag = tagOf(e)
    const el = h('div', 'fh-alerts-toast fh-glass fh-blur')
    el.dataset.id = e.id
    el.dataset.tone = tag.tone
    el.dataset.action = action
    const tagEl = h('span', 'fh-alerts-tag fh-num', tag.text)
    tagEl.setAttribute('aria-hidden', 'true')
    const text = h('div', 'fh-alerts-toast-text')
    text.append(h('strong', 'fh-alerts-toast-who', who(e)), h('span', 'fh-alerts-toast-what', what(e)))
    const go = h('button', 'fh-pill fh-alerts-toast-go', action === 'follow' ? 'Follow' : 'Replay')
    go.type = 'button'
    go.setAttribute('aria-label', actionText(e, action))
    const x = h('button', 'fh-ibtn fh-sm fh-alerts-toast-x')
    x.type = 'button'
    x.setAttribute('aria-label', 'Close')
    x.append(icon('x', 14))
    el.append(tagEl, text, go, x)
    const t: Toast = { el, timer: null, leftMs: TOAST_MS, armedMs: 0, hover: false, focus: false }
    go.addEventListener('click', () => {
      closeToast(t)
      act(e, action)
    })
    x.addEventListener('click', () => closeToast(t))
    // Kept while the pointer or the focus is on it: it never goes from under a hand about to press it.
    el.addEventListener('pointerenter', () => {
      t.hover = true
      hold(t)
    })
    el.addEventListener('pointerleave', () => {
      t.hover = false
      arm(t)
    })
    el.addEventListener('focusin', () => {
      t.focus = true
      hold(t)
    })
    el.addEventListener('focusout', (ev) => {
      if (ev.relatedTarget instanceof Node && el.contains(ev.relatedTarget)) return
      t.focus = false
      arm(t)
    })
    stack.prepend(el)
    toasts.push(t)
    arm(t)
  }

  /** A desktop notification for a new event, with the option on and the browser's permission. A click acts on it as it is then. */
  function notifyOf(e: AlertEvent): void {
    if (!notifyOn()) return
    try {
      const n = new notifications!(who(e), { body: what(e), tag: e.id })
      n.onclick = () => {
        window.focus()
        const cur = rows.get(e.id)?.e ?? e // the newest word on it
        act(cur, primaryAction(cur, opts.nowMs()))
        n.close()
      }
    } catch (err) {
      console.warn('FlightHopper: no desktop notification:', err) // Android's Chrome makes them through a service worker only
    }
  }

  // The open panel's times and live dots stay true between answers.
  const tick = setInterval(() => {
    if (visible() && reply != null) paintList()
  }, TICK_MS)

  const handle: AlertsHandle = {
    update(next) {
      if (dead) return
      failed = false
      reply = next
      if (next === null) {
        showWatch()
        paintList()
        return opts.onBadge(null)
      }
      const now = opts.nowMs()
      if (!primed) {
        // What happened while away shows in the badge, not in a burst of toasts.
        primed = true
        for (const e of next.events) if (!e.quiet) known.add(e.id)
      } else {
        const fresh = freshEvents(known, next.events)
        for (const e of fresh) {
          known.add(e.id)
          since.add(e.id)
        }
        const shown = fresh.slice(0, MAX_TOASTS)
        for (let i = shown.length - 1; i >= 0; i--) {
          showToast(shown[i], now) // the oldest first: the newest ends on top
          notifyOf(shown[i])
        }
        if (follow && shown.length > 0 && primaryAction(shown[0], now) === 'follow') opts.onAuto(shown[0])
      }
      if (visible()) seen(now)
      showWatch()
      paintList()
      badge()
    },
    opened() {
      if (dead) return
      seen(opts.nowMs())
      opts.onBadge(null)
      showNotify() // the browser's permission may have changed meanwhile
      paintList()
    },
    destroy() {
      dead = true
      clearInterval(tick)
      for (const t of [...toasts]) closeToast(t, false)
      rows.clear()
      root.remove()
      stack.remove()
    },
  }
  return handle
}

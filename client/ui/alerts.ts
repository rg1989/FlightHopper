// client/ui/alerts.ts
// The Events panel (the rail's bell) and its toasts: the emergencies and steep descents the server finds worldwide
// (server/alerts.ts; shared/alerts.ts words them). The panel, top to bottom: the server's switch, Watch the world, with a
// line on what it watches; two options kept in this browser, Follow automatically and Notifications (where the browser
// has them); then the last 7 days of events, newest first. A row follows its aircraft live while its event is ongoing, else
// replays it in History once History has it (until then it goes to where the aircraft was last heard, and says when Replay
// opens); a small text button beside a followed row replays it. No row offers Live for an aircraft that is not heard with
// its cause now: it has most often landed. Quiet events (a light aircraft's radio failure) are listed, dimmed,
// and raise nothing by themselves. After the first answer, each new alerting event shows a toast (at most 3, each closing
// by itself after 30 s) and, with the option on, a notification while the page is hidden or not focused; with Follow
// automatically on, the app is asked to follow the newest that is followed (onAuto). The rail's bell counts the events
// since the panel was last opened (opened after it, or come in after it: found late); while it is open they count as seen.
// The asks for the events are made here (eventsFeed): when the app says the server's events changed (refresh), when the
// panel opens, and every 30 s while the app polls nothing live: in History and in a scenario (setLivePolling), and in a tab
// in the background with notifications on. None on that timer while the server has no alerts. The app owns the rail and
// what following and replaying do.
// ponytail: a browser that freezes or discards a background tab runs no timer there, so no notification comes; ntfy is the
// path then.
import { ongoing, what, who, type AlertEvent, type EventsReply } from '../../shared/alerts.ts'
import { PUBLISH_DELAY_MS, SLOT_MS, slotOf } from '../../shared/history.ts'
import { icon, type IconName } from './icons.ts'
import './sceneToggles.css' // the switch rows are the Layers panel's (.fh-scene-row and its parts)
import './alerts.css'

export interface AlertsUiOpts {
  store: Storage | null // the browser's own options (follow, notifications, when the panel was last opened); null: blocked
  nowMs(): number // the server's clock where known (ApiClient.serverNowMs), else Date.now
  get(): Promise<EventsReply | null> // GET /api/events (ApiClient.events); never asked while mounting
  onSwitch(on: boolean): Promise<EventsReply> // the server's switch (ApiClient.setAlerts)
  onFollow(e: AlertEvent): void // follow its aircraft live
  onReplay(e: AlertEvent): void // History at the event, its aircraft selected
  onAuto(e: AlertEvent): void // "Follow automatically" is on and a new event to follow came in: the app decides (mayAutoFollow)
  onBadge(text: string | null): void // the rail's count of events not yet seen
}

export interface AlertsHandle {
  refresh(): void // ask for the events (the server says they changed); one ask at a time
  update(reply: EventsReply | null): void // a reply of GET or POST /api/events; null: no alerts on this server
  opened(): void // the panel was opened: what it lists counts as seen, the badge clears, and the events are asked for afresh
  // Whether the app polls live data now (false in History and in a scenario): while it does not, no status says that the
  // events changed, so the panel asks for them every 30 s itself.
  setLivePolling(on: boolean): void
  destroy(): void
}

type Action = 'follow' | 'replay'

const TOAST_MS = 30_000 // a toast closes by itself after this
const TOAST_AFTER_MS = 4000 // …and at least this long after the pointer or the focus leaves it
const MAX_TOASTS = 3
const LIVE_MS = 60 * 60_000 // until History has it, a row goes to its aircraft while it was seen with its cause this recently
const TICK_MS = 15_000 // the open panel's times, live dots and actions are redrawn this often
const FOLLOW_KEY = 'fh.alerts.follow'
const NOTIFY_KEY = 'fh.alerts.notify'
const SEEN_KEY = 'fh.alerts.seen'
const DAY_MS = 86_400_000
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const RETRY_MS = 10_000 // a failed ask for the events is asked again once, this long after
const ASK_EVERY_MS = 30_000 // with no live polls, the events are asked for this often (in a hidden tab browsers make it ~1 min)
const AUTO_MAP_QUIET_MS = 60_000 // Follow automatically waits this long after the person last moved the map…
const AUTO_PICK_QUIET_MS = 2 * 60_000 // …and this long after they last picked an aircraft by hand
const NOTIFY_LABEL = 'Notifications' // a phone's too: not "desktop" ones
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

/** "14:05": ms in local time. */
function clock(ms: number): string {
  const t = new Date(ms)
  return `${pad2(t.getHours())}:${pad2(t.getMinutes())}`
}

/**
 * How long ago ms was, from nowMs: "now", "5 min ago", "3 h ago", then the day and the time (local): "Wed 14:05"; over 6
 * days, the date: "26 Sep 13:00" (a weekday a week ago would read as today's).
 */
export function ago(ms: number, nowMs: number): string {
  const d = nowMs - ms
  if (d < 60_000) return 'now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`
  if (d < DAY_MS) return `${Math.floor(d / 3_600_000)} h ago`
  const t = new Date(ms)
  return `${d > 6 * DAY_MS ? `${t.getDate()} ${MONTHS[t.getMonth()]}` : DAYS[t.getDay()]} ${clock(ms)}`
}

/**
 * When History has the event (UTC ms): its half hour's file is published at the end of that half hour and PUBLISH_DELAY_MS
 * (shared/history.ts newestSlotMs). From then History reaches the event and the minute before it, where Replay starts.
 * ponytail: the panel's clock is the server's, History's first guess of its newest half hour the browser's: a Replay pressed in
 * the seconds the two clocks disagree at a publication starts at the end of the half hour before. Upgrade: History waits for a
 * time past its guess as it waits for one before it (HistoryClock.asked).
 */
export function replayableAt(e: AlertEvent): number {
  return slotOf(e.openedMs) + SLOT_MS + PUBLISH_DELAY_MS
}

/** "Replay at 12:01": when Replay opens, in local time, to the next whole minute (never before it opens). */
export function replayAtText(e: AlertEvent): string {
  return `Replay at ${clock(Math.ceil(replayableAt(e) / 60_000) * 60_000)}`
}

/**
 * What a click on its row does: an ongoing live event is followed; any other is replayed in History once History has it;
 * until then it is followed while its aircraft was seen within the hour, else replayed (the row says when Replay opens).
 * Followed and not ongoing, the click goes to where the aircraft was last heard: live if it still flies, and its card says
 * for how long its signal is lost if it does not. A quiet event's row too: "listed only" means no toast, notification or follow by itself, and
 * a click is the person's own.
 */
export function primaryAction(e: AlertEvent, nowMs: number): Action {
  if (ongoing(e, nowMs)) return 'follow'
  if (nowMs >= replayableAt(e)) return 'replay'
  return nowMs - e.lastMs < LIVE_MS ? 'follow' : 'replay'
}

/**
 * Beside the row: 'later' while History lacks the event (a note, not a button: replayAtText); else Replay beside a followed
 * row, or nothing. Never Live beside a replayed row: its aircraft is not heard with its cause now, so Live would promise
 * what is most often a landed aircraft (C-FRSJ, 2026-10-03: "Signal lost" for 28 min under a Live button).
 * ponytail: an aircraft that flies on after its cause (a code set back, a fall found late) has no way to it from its row but
 * Replay. Upgrade: the server asks for each recent event's aircraft once a minute and says whether it is heard.
 */
export function secondaryAction(e: AlertEvent, nowMs: number): 'replay' | 'later' | null {
  if (nowMs < replayableAt(e)) return 'later'
  return primaryAction(e, nowMs) === 'follow' ? 'replay' : null
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
    ? 'Watching: emergency squawks worldwide, and falls in each half hour of adsb.lol'
    : 'Watching what this app polls, and each half hour of adsb.lol'
}

/** What an action does, in words. Follow is live only while the event is ongoing; else it goes to where the aircraft was last heard. */
function actionText(e: AlertEvent, action: Action, nowMs: number): string {
  if (action === 'replay') return `Replay ${who(e)} in History`
  return ongoing(e, nowMs) ? `Follow ${who(e)} live` : `Go to where ${who(e)} was last heard`
}

/** A row's accessible name: what its click does, then what happened and when; and when Replay opens, while History lacks it. */
export function rowLabel(e: AlertEvent, nowMs: number): string {
  const wait = nowMs < replayableAt(e) ? `, ${replayAtText(e).toLowerCase()}` : ''
  return `${actionText(e, primaryAction(e, nowMs), nowMs)}: ${what(e)}, ${ago(e.openedMs, nowMs)}${e.late ? ', found late' : ''}${wait}`
}

/**
 * Where Follow flies the map: the live map's position of the aircraft (its newest sample's time and place) or the event's,
 * whichever is newer. The map's can be from before History (no polls there); the event's can be an hour old on a Live row.
 */
export function followTarget(e: AlertEvent, onMap: { tMs: number; lat: number; lon: number } | null): { lat: number; lon: number } | null {
  const own = e.lat === null || e.lon === null ? null : { lat: e.lat, lon: e.lon }
  if (onMap === null) return own
  return own === null || onMap.tMs >= e.lastMs ? { lat: onMap.lat, lon: onMap.lon } : own
}

/** What the app knows when a new event could be followed by itself (Follow automatically). */
export interface AutoFollowState {
  history: boolean // the map in the past
  scenario: boolean // a scenario plays or loads
  mapMovedAgoMs: number // since the person last moved the map (Infinity: never)
  handPickAgoMs: number // since they last picked an aircraft by hand: the list, a click on the map, the search, a card
  chasing: boolean
  otherSheet: boolean // on a phone, another tool's sheet is open
}

/** Whether Follow automatically may take the screen now. It never fights the person: the toast shows all the same. */
export function mayAutoFollow(s: AutoFollowState): boolean {
  if (s.history || s.scenario) return false // they took the screen on purpose
  if (s.mapMovedAgoMs < AUTO_MAP_QUIET_MS) return false // (a) they moved the map in the last minute: they look somewhere
  if (s.handPickAgoMs < AUTO_PICK_QUIET_MS) return false // (b) they picked an aircraft by hand in the last 2 min
  if (s.chasing) return false // (c) a chase, started by hand (every chase is): following would swap its aircraft
  if (s.otherSheet) return false // (d) on a phone, another tool's sheet is open: they are using it
  return true
}

export interface EventsFeed {
  refresh(): void // ask now; while an ask is in flight, once more after it
  destroy(): void
}

/**
 * The asks for the events (GET /api/events): one at a time, and asks meanwhile ask once more after it, so a change is never
 * missed nor asked for twice at once. A failed ask is asked again once, RETRY_MS later; an ask meanwhile takes that retry's
 * place, so there is never more than one timer, and a retry that fails waits for the next ask (the server's next change,
 * the panel opening).
 */
export function eventsFeed(get: () => Promise<EventsReply | null>, apply: (reply: EventsReply | null) => void): EventsFeed {
  let busy = false
  let again = false
  let retry: ReturnType<typeof setTimeout> | null = null
  let dead = false
  const send = (isRetry: boolean): void => {
    if (retry !== null) clearTimeout(retry) // this ask takes its place
    retry = null
    busy = true
    get()
      .then((r) => {
        if (!dead) apply(r)
      }, (e: unknown) => {
        if (dead) return
        console.warn('FlightHopper: events failed:', e)
        if (!isRetry && retry === null) retry = setTimeout(() => ask(true), RETRY_MS)
      })
      .catch((e: unknown) => console.error('FlightHopper: events crashed:', e))
      .finally(() => {
        busy = false
        if (dead || !again) return
        again = false
        send(false)
      })
  }
  const ask = (isRetry: boolean): void => {
    if (isRetry) retry = null
    if (dead) return
    if (busy) again = true
    else send(isRetry)
  }
  return {
    refresh: () => ask(false),
    destroy() {
      dead = true
      if (retry !== null) clearTimeout(retry)
      retry = null
    },
  }
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

/** The browser's notifications; null where there are none: an iPhone outside a Home Screen app, a page not served securely. */
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

/** Shows el or hides it, writing only a change (the open panel is redrawn every few seconds). */
function show(el: HTMLElement, on: boolean): void {
  if (el.hidden === on) el.hidden = !on
}

/**
 * One event's row: its button (the tag over the late mark, the aircraft over what happened), then the time and, under it
 * (beside it on phones), the other action or when Replay opens. Those are outside the row's button, which cannot hold
 * another; a click on the time or the note is the row's.
 */
interface Row {
  e: AlertEvent
  action: Action
  alt: 'replay' | 'later' | null
  li: HTMLLIElement
  main: HTMLButtonElement
  tag: HTMLElement
  late: HTMLElement
  who: HTMLElement
  what: HTMLElement
  ago: HTMLElement
  dot: HTMLElement
  altBtn: HTMLButtonElement
  at: HTMLElement
}

interface Toast {
  el: HTMLElement
  x: HTMLButtonElement // its close button: where the focus goes when the toast above or below it closes
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
  let autoFollow = readOn(store, FOLLOW_KEY)
  let notify = readOn(store, NOTIFY_KEY)
  let seenMs = readSeen(store)
  let dead = false
  const act = (e: AlertEvent, action: Action): void => (action === 'follow' ? opts.onFollow(e) : opts.onReplay(e))
  const visible = (): boolean => !body.hidden // the rail shows the open panel's body only
  const feed = eventsFeed(() => opts.get(), (r) => handle.update(r))

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
        if (dead) return
        switching = false
        handle.update(r)
        showWatch() // its wait ends even where a newer answer came first (update drops this one)
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
    autoFollow = !autoFollow
    keep(store, FOLLOW_KEY, autoFollow ? '1' : '0')
    followRow.sw.setAttribute('aria-checked', String(autoFollow))
  })
  followRow.sw.setAttribute('aria-checked', String(autoFollow))

  // The app's polls carry the server's word that the events changed (refresh). While none run, the events are asked for here,
  // on a timer of their own: in History and in a scenario (setLivePolling), and in a tab in the background (the app polls
  // nothing there) with notifications on, as only a notification could tell the person. Not while the server has no alerts:
  // each ask would be a 404. Before the first answer it may have them.
  let polled = true // the app polls live data
  let askTimer: ReturnType<typeof setInterval> | null = null
  const ownAsks = (): void => {
    const want = reply !== null && (document.hidden ? notifyOn() : !polled)
    if (want === (askTimer !== null)) return
    if (askTimer !== null) clearInterval(askTimer)
    askTimer = want ? setInterval(() => feed.refresh(), ASK_EVERY_MS) : null
  }
  document.addEventListener('visibilitychange', ownAsks)

  // On only with the browser's permission; turning it on asks for it in the click (a browser asks only then).
  const notifyOn = (): boolean => notifications !== null && notify && notifications.permission === 'granted'
  const notifyRow = switchRow('notify', 'bell', NOTIFY_LABEL, NOTIFY_HINT, () => {
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
    ownAsks()
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
  // ponytail: a toast can cover the top flight-data cards of the chase for its 30 s; it stays out of the frame's covers
  // (app.ts FRAME_COVERS), which would move the frame each time one comes and goes. Upgrade: toasts at the bottom in the chase.
  const stack = h('div', 'fh-toasts fh-alerts-toasts')
  stack.setAttribute('role', 'status')
  stack.setAttribute('aria-atomic', 'false') // a new toast is read, not the whole stack again
  toastRoot.append(stack)
  const toasts: Toast[] = [] // oldest first
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  let before: HTMLElement | null = null // where the focus was before it came into the toasts
  stack.addEventListener('focusin', (ev) => {
    const from = ev.relatedTarget
    if (from instanceof Node && stack.contains(from)) return // from one toast to another
    before = from instanceof HTMLElement ? from : null
  })
  // Esc in a toast closes that toast: not the panel, the chase or the focus, as the app's Esc would.
  stack.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return
    const t = toasts.find((x) => ev.target instanceof Node && x.el.contains(ev.target))
    if (t === undefined) return
    ev.preventDefault()
    ev.stopPropagation()
    closeToast(t)
  })

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
    const lead = h('span', 'fh-alerts-lead')
    lead.setAttribute('aria-hidden', 'true') // the button's label says it in words
    const tag = h('span', 'fh-alerts-tag fh-num')
    const late = h('span', 'fh-alerts-late', 'late')
    lead.append(tag, late)
    const text = h('span', 'fh-alerts-text')
    const whoEl = h('span', 'fh-alerts-who')
    const whatEl = h('span', 'fh-alerts-what')
    text.append(whoEl, whatEl)
    main.append(lead, text)
    const when = h('span', 'fh-alerts-when')
    when.setAttribute('aria-hidden', 'true') // in the button's label
    const agoEl = h('span', 'fh-alerts-ago fh-num')
    const dot = h('span', 'fh-dot fh-alerts-live')
    dot.dataset.state = 'live'
    when.append(agoEl, dot)
    const altBtn = h('button', 'fh-alerts-alt')
    altBtn.type = 'button'
    const at = h('span', 'fh-alerts-at fh-num')
    at.setAttribute('aria-hidden', 'true') // in the button's label
    li.append(main, when, altBtn, at)
    const r: Row = { e, action: 'replay', alt: null, li, main, tag, late, who: whoEl, what: whatEl, ago: agoEl, dot, altBtn, at }
    main.addEventListener('click', () => act(r.e, r.action))
    altBtn.addEventListener('click', (ev) => {
      ev.stopPropagation() // the row's own click is the other action
      if (r.alt === 'replay') act(r.e, r.alt)
    })
    li.addEventListener('click', (ev) => {
      const t = ev.target
      if (t === li || (t instanceof Node && (when.contains(t) || at.contains(t)))) main.click()
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
    const tip = r.action === 'replay' ? 'Replay in History' : ongoing(e, now) ? 'Follow live' : 'Go to where it was last heard'
    if (r.main.title !== tip) r.main.title = tip
    show(r.dot, ongoing(e, now)) // live
    show(r.late, e.late)
    show(r.altBtn, r.alt === 'replay')
    show(r.at, r.alt === 'later')
    if (r.alt === 'replay') {
      setText(r.altBtn, 'Replay')
      setAttr(r.altBtn, 'aria-label', actionText(e, r.alt, now))
    } else if (r.alt === 'later') setText(r.at, replayAtText(e))
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

  /** Starts the rest of a toast's time (it closes by itself), unless it is closed or the pointer or the focus is on it. */
  function arm(t: Toast): void {
    if (!toasts.includes(t) || t.timer !== null || t.hover || t.focus) return
    t.armedMs = Date.now()
    t.timer = setTimeout(() => closeToast(t), t.leftMs)
  }
  function hold(t: Toast): void {
    if (t.timer === null) return
    clearTimeout(t.timer)
    t.timer = null
    t.leftMs = Math.max(TOAST_AFTER_MS, t.leftMs - (Date.now() - t.armedMs))
  }
  /**
   * A toast goes (faded, unless fade is false or motion is reduced). The focus in it goes to the toast below it, else the one
   * above, else back where it was before the toasts, else the body: it is never left on a button that is gone.
   */
  function closeToast(t: Toast, fade = true): void {
    const i = toasts.indexOf(t)
    if (i < 0) return
    toasts.splice(i, 1)
    if (t.timer !== null) clearTimeout(t.timer)
    t.timer = null
    if (t.el.contains(document.activeElement)) {
      const near = toasts[i - 1] ?? toasts[i] // oldest first: i - 1 is the one below it, i (after the splice) the one above
      if (near !== undefined) near.x.focus()
      else if (before?.isConnected) before.focus()
      else (document.activeElement as HTMLElement | null)?.blur()
    }
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
    go.setAttribute('aria-label', actionText(e, action, now))
    const x = h('button', 'fh-ibtn fh-sm fh-alerts-toast-x')
    x.type = 'button'
    x.setAttribute('aria-label', 'Close')
    x.append(icon('x', 14))
    el.append(tagEl, text, go, x)
    const t: Toast = { el, x, timer: null, leftMs: TOAST_MS, armedMs: 0, hover: false, focus: false }
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

  /**
   * A notification for a new event: with the option on and the browser's permission, and only while the page is hidden or
   * not focused (a visible, focused page has the toast). A click acts on the event as it is then.
   * ponytail: Android's Chrome makes notifications only through a service worker (the constructor throws), so none come
   * there; the switch still turns on. Upgrade: a service worker's showNotification.
   */
  function notifyOf(e: AlertEvent): void {
    if (!notifyOn() || (!document.hidden && document.hasFocus())) return
    try {
      const n = new notifications!(who(e), { body: what(e), tag: e.id })
      n.onclick = () => {
        window.focus()
        const cur = rows.get(e.id)?.e ?? e // the newest word on it
        act(cur, primaryAction(cur, opts.nowMs()))
        n.close()
      }
    } catch (err) {
      console.warn('FlightHopper: no notification:', err)
    }
  }

  // The open panel's times, live dots and actions stay true between answers, and a row turns to Replay as its half hour is published.
  const tick = setInterval(() => {
    if (visible() && reply != null) paintList()
  }, TICK_MS)

  const handle: AlertsHandle = {
    refresh: () => feed.refresh(),
    update(next) {
      if (dead) return
      // A lower rev is an older answer come late: a restarted server's is higher, as its rev starts at its clock.
      if (next !== null && reply != null && next.rev < reply.rev) return
      failed = false
      reply = next
      if (next === null) {
        showWatch()
        paintList()
        ownAsks()
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
        // The newest new event that is followed (one found late is replayed): the app decides whether it may.
        const go = fresh.find((e) => primaryAction(e, now) === 'follow')
        if (autoFollow && go !== undefined) opts.onAuto(go)
      }
      if (visible()) seen(now)
      showWatch()
      paintList()
      badge()
      ownAsks()
    },
    opened() {
      if (dead) return
      seen(opts.nowMs())
      opts.onBadge(null)
      showNotify() // the browser's permission may have changed meanwhile
      paintList()
      feed.refresh() // History and a scenario poll nothing that would say the events changed: at once, not in 30 s
    },
    setLivePolling(on) {
      if (dead || on === polled) return
      polled = on
      ownAsks()
    },
    destroy() {
      dead = true
      feed.destroy()
      clearInterval(tick)
      if (askTimer !== null) clearInterval(askTimer)
      askTimer = null
      document.removeEventListener('visibilitychange', ownAsks)
      for (const t of [...toasts]) closeToast(t, false)
      rows.clear()
      root.remove()
      stack.remove()
    },
  }
  return handle
}

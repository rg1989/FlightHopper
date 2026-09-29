// client/ui/outage.ts
// What the app shows when live data stops (outageFor): offline, the app's own server not answering, the flight-data
// source refusing or down, or slowed. A serious outage is a card over a dimmed, greyed map: an emblem (the kind's icon
// in pulsing rings), what happened in plain words, when the last update came, that it retries by itself, and "Keep
// browsing", which folds it into a pill at the top (a tap unfolds it). Slowed is the pill alone. When live data comes
// back after a serious outage, a green "Live again" pill shows for a few seconds. The splash (splash.ts) uses the same
// emblem (outageArt) for loading and start-up failures. The app polls every second whatever happens, so no Retry button.
import type { Degraded } from '../../shared/api.ts'
import { icon, type IconName } from './icons.ts'
import './outage.css'

export const FAILS_DOWN = 3 // failed polls in a row before the app's own server counts as unreachable
const LIVE_AGAIN_MS = 3500

export type OutageKind = 'offline' | 'server' | 'blocked' | 'down' | 'slowed'
export type Tone = 'red' | 'amber' | 'blue' | 'green'

/** The outage to show, most basic cause first; none in a scenario (it needs no live data). */
export function outageFor(o: { online: boolean; failedPolls: number; degraded: Degraded; inScenario: boolean }): OutageKind | null {
  if (o.inScenario) return null
  if (!o.online) return 'offline'
  if (o.failedPolls >= FAILS_DOWN) return 'server'
  if (o.degraded === 'blocked') return 'blocked'
  if (o.degraded === 'upstream-down') return 'down'
  if (o.degraded === 'rate-limited') return 'slowed'
  return null
}

interface Copy { icon: IconName; tone: Tone; title: (src: string) => string; body: (src: string) => string; pill: (src: string) => string }
export const OUTAGE_COPY: Record<OutageKind, Copy> = {
  offline: {
    icon: 'wifiOff', tone: 'red',
    title: () => 'You’re offline',
    body: () => 'FlightHopper needs the internet for live traffic, maps and weather. What’s on screen stays, and it reconnects by itself as soon as the network is back.',
    pill: () => 'Offline · reconnecting when the network is back',
  },
  server: {
    icon: 'server', tone: 'red',
    title: () => 'The FlightHopper server isn’t answering',
    body: () => 'No new positions are arriving because the app’s own server stopped responding. If you started it with make, check that it is still running.',
    pill: () => 'Server not answering · retrying',
  },
  blocked: {
    icon: 'ban', tone: 'red',
    title: (src) => `${src} is refusing our requests`,
    body: (src) => `${src} blocked this server’s requests, usually for asking too often or from a blocked address. Nothing new arrives until it lets us back in; the server keeps trying at a gentler pace.`,
    pill: (src) => `${src} is refusing requests`,
  },
  down: {
    icon: 'radar', tone: 'amber',
    title: (src) => `${src} isn’t answering`,
    body: (src) => `The flight-data source failed several times in a row. Aircraft stay where they were last seen and start moving again as soon as ${src} answers.`,
    pill: (src) => `${src} isn’t answering · retrying`,
  },
  slowed: {
    icon: 'hourglass', tone: 'amber',
    title: (src) => `${src} slowed us down`,
    body: (src) => `${src} asked us to ask less often, so positions update less often for a minute or so. Nothing to do: it recovers by itself.`,
    pill: (src) => `${src} slowed us down · updates less often`,
  },
}

/** "just now", "42 s ago", "3 min ago", "2 h ago". */
export function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 5) return 'just now'
  if (s < 90) return `${s} s ago`
  const m = Math.round(s / 60)
  return m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`
}

/** The emblem: the icon on a disc in the tone's colour, inside three rings that pulse outwards. */
export function outageArt(name: IconName, tone: Tone): HTMLElement {
  const art = document.createElement('div')
  art.className = 'fh-art'
  art.dataset.tone = tone
  for (let i = 0; i < 3; i++) {
    const r = document.createElement('span')
    r.className = 'fh-art-ring'
    r.style.animationDelay = `${i * 0.9}s`
    art.append(r)
  }
  const disc = document.createElement('span')
  disc.className = 'fh-art-disc'
  disc.append(icon(name, 30))
  art.append(disc)
  return art
}

export interface OutageHandle {
  /** Every frame: the outage (null: live), the source's name, and when the last good answer came (ms, Date.now clock). */
  update(kind: OutageKind | null, source: string, lastOkMs: number | null, nowMs: number): void
  destroy(): void
}

export function mountOutage(root: HTMLElement): OutageHandle {
  const h = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag)
    e.className = className
    if (text !== '') e.textContent = text
    return e
  }
  const layer = h('div', 'fh-outage')
  layer.hidden = true
  const veil = h('div', 'fh-outage-veil')
  const card = h('section', 'fh-outage-card fh-glass fh-blur')
  card.setAttribute('role', 'alert')
  const artBox = h('div', 'fh-outage-art')
  const title = h('h2', 'fh-outage-title')
  const body = h('p', 'fh-outage-body')
  const chips = h('div', 'fh-outage-chips')
  const lastChip = h('span', 'fh-chip')
  const retryChip = h('span', 'fh-chip')
  const retryDot = h('span', 'fh-spin')
  retryChip.append(retryDot, document.createTextNode('Retrying by itself'))
  chips.append(lastChip, retryChip)
  const actions = h('div', 'fh-outage-actions')
  const keep = h('button', 'fh-pill fh-pill-secondary', 'Keep browsing')
  keep.type = 'button'
  actions.append(keep)
  card.append(artBox, title, body, chips, actions)
  layer.append(veil, card)

  const pill = h('button', 'fh-outage-pill fh-glass fh-blur')
  pill.type = 'button'
  pill.hidden = true
  const pillDot = h('span', 'fh-dot')
  const pillText = h('span', 'fh-outage-pill-t')
  const pillMore = h('span', 'fh-outage-pill-more', 'Details')
  pill.append(pillDot, pillText, pillMore)

  const ok = h('div', 'fh-outage-pill fh-outage-ok fh-glass fh-blur')
  ok.setAttribute('role', 'status')
  ok.hidden = true
  const okDot = h('span', 'fh-dot')
  okDot.dataset.state = 'live'
  ok.append(okDot, h('span', '', 'Live again'))
  root.append(layer, pill, ok)

  let kind: OutageKind | null = null
  let folded = false
  let okTimer: ReturnType<typeof setTimeout> | null = null
  let lastText = ''
  const show = (): void => {
    layer.hidden = kind === null || folded
    pill.hidden = kind === null || !folded
  }
  keep.addEventListener('click', () => {
    folded = true
    show()
  })
  pill.addEventListener('click', () => {
    folded = false
    show()
  })

  return {
    update(next, source, lastOkMs, nowMs) {
      if (next !== kind) {
        const was = kind
        kind = next
        if (next !== null) {
          const c = OUTAGE_COPY[next]
          layer.dataset.tone = pill.dataset.tone = c.tone
          artBox.replaceChildren(outageArt(c.icon, c.tone))
          folded = next === 'slowed' // mild: the pill alone, a tap for the card
          pillDot.dataset.state = c.tone === 'red' ? 'trouble' : 'replay'
          ok.hidden = true
        } else if (was !== null && was !== 'slowed') {
          ok.hidden = false
          if (okTimer !== null) clearTimeout(okTimer)
          okTimer = setTimeout(() => (ok.hidden = true), LIVE_AGAIN_MS)
        }
        lastText = ''
        show()
      }
      if (kind === null) return
      const c = OUTAGE_COPY[kind]
      const last = lastOkMs === null ? 'No live data yet' : `Last update ${agoText(nowMs - lastOkMs)}`
      const key = `${kind}|${source}|${last}`
      if (key === lastText) return
      lastText = key
      title.textContent = c.title(source)
      body.textContent = c.body(source)
      pillText.textContent = c.pill(source)
      lastChip.textContent = last
    },
    destroy() {
      if (okTimer !== null) clearTimeout(okTimer)
      layer.remove()
      pill.remove()
      ok.remove()
    },
  }
}

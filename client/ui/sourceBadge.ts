// client/ui/sourceBadge.ts
// Where the aircraft come from: the Status panel ("Live traffic", the source linked as adsb.fi's terms ask, "Replay ·
// <recording time>" for a recording), how often the map refreshes, areas still loading, and the rail's status dot.
import type { StatusBrief } from '../../shared/api.ts'
import type { SourceKind } from '../../shared/types.ts'
import './sourceBadge.css'

const SOURCES: Record<SourceKind, { name: string; href: string | null; credit: string }> = {
  adsbfi: { name: 'adsb.fi', href: 'https://adsb.fi', credit: 'Flight data: adsb.fi, non-commercial use' }, // one line on a phone
  adsblol: { name: 'adsb.lol', href: 'https://adsb.lol', credit: 'Flight data © adsb.lol contributors, ODbL 1.0' },
  readsb: { name: 'own receiver', href: null, credit: 'Flight data: own receiver (readsb)' },
  // A recording holds what its source answered: the recorder polls adsb.lol; a live server with RECORD_DIR records its own.
  replay: { name: 'recording', href: null, credit: 'Flight data: a recording (adsb.lol contributors, ODbL 1.0, or adsb.fi)' },
}

/** The flight-data line of the credit box for this source. */
export function flightCredit(source: SourceKind): string {
  return SOURCES[source].credit
}

export interface SourceView {
  text: string
  title: string
  state: 'live' | 'replay' | 'trouble'
  href: string | null
}

/** Badge text for a status; serverNowMs dates a replay (server now − upstreamOffsetMs = the recording's own time). */
export function sourceView(status: StatusBrief, serverNowMs: number | null): SourceView {
  const src = SOURCES[status.source]
  const trouble = status.degraded !== null
  // In trouble the pending count means nothing (no answers are coming): the badge says what is wrong instead.
  const loading = !trouble && (status.pendingAreas ?? 0) > 0 ? ` · loading ${status.pendingAreas} area${status.pendingAreas === 1 ? '' : 's'}` : ''
  if (status.source === 'replay') {
    const at = serverNowMs !== null && status.upstreamOffsetMs !== undefined ? new Date(serverNowMs - status.upstreamOffsetMs) : null
    const when = at === null ? '' : ` · ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`
    return { text: `REPLAY${when}`, title: 'A recorded session played back, not live traffic (make live for live)', state: 'replay', href: null }
  }
  const word = status.degraded === 'rate-limited' ? 'SLOWED' : trouble ? 'NO DATA' : 'LIVE'
  return {
    text: `${word} · ${src.name}${loading}`,
    title: trouble ? `The flight-data source is ${status.degraded}` : `Live flight data from ${src.name}`,
    state: trouble ? 'trouble' : 'live',
    href: src.href,
  }
}

/** The rail's status dot for a status (null before the first one). */
export function statusDot(status: StatusBrief | null): 'live' | 'replay' | 'trouble' | 'wait' {
  if (status === null) return 'wait'
  if (status.degraded !== null) return 'trouble'
  return status.source === 'replay' ? 'replay' : 'live'
}

export interface StatusPanelHandle {
  update(status: StatusBrief | null, serverNowMs: number | null): void
  setImagery(text: string, state: 'ok' | 'fallback' | 'plain'): void
}

/** The Status panel: mode and source (linked), how often the view refreshes, areas still loading, imagery. */
export function mountStatusPanel(root: HTMLElement): StatusPanelHandle {
  const h = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag)
    e.className = className
    if (text !== '') e.textContent = text
    return e
  }
  const hero = h('div', 'fh-status-hero')
  const dot = h('span', 'fh-dot')
  const heroText = h('div', 'fh-status-hero-t')
  const mode = h('div', 'fh-status-mode', 'Connecting…')
  const sourceLine = h('div', 'fh-status-src')
  const link = h('a', 'fh-status-link')
  link.target = '_blank'
  link.rel = 'noopener'
  sourceLine.append(link)
  heroText.append(mode, sourceLine)
  hero.append(dot, heroText)

  const rows = h('dl', 'fh-status-rows')
  const row = (label: string): HTMLElement => {
    const v = h('dd', '')
    rows.append(h('dt', '', label), v)
    return v
  }
  const refreshV = row('Map refresh')
  const coverageV = row('Coverage')
  const imageryV = row('Imagery')
  root.append(hero, rows)

  let shown = ''
  return {
    update(status, serverNowMs) {
      const v = status === null ? null : sourceView(status, serverNowMs)
      const src = status === null ? null : SOURCES[status.source]
      // In trouble the pending count means nothing (no answers are coming): no "Loading" spinner then.
      const pending = status !== null && status.degraded === null ? (status.pendingAreas ?? 0) : 0
      const every = status?.viewEveryS
      const key = `${v?.text}|${v?.state}|${v?.title}|${pending}|${every}|${statusDot(status)}`
      if (key === shown) return
      shown = key
      dot.dataset.state = statusDot(status)
      mode.textContent = v === null ? 'Connecting…' : v.text.split(' · ')[0] === 'REPLAY' ? v.text.replace('REPLAY', 'Replay') : v.state === 'trouble' ? v.title : 'Live traffic'
      if (src !== null && src.href !== null) {
        link.href = src.href
        link.textContent = src.name
        sourceLine.hidden = false
      } else {
        link.removeAttribute('href')
        link.textContent = src?.name ?? ''
        sourceLine.hidden = src === null
      }
      refreshV.textContent = every === undefined ? '—' : every < 60 ? `every ${Math.round(every)} s` : `every ${Math.round(every / 60)} min`
      coverageV.replaceChildren()
      if (pending > 0) {
        coverageV.append(h('span', 'fh-spin'), document.createTextNode(` Loading ${pending} area${pending === 1 ? '' : 's'}`))
      } else coverageV.textContent = status === null ? '—' : status.degraded !== null ? 'Waiting for the source' : 'Up to date'
    },
    setImagery(text, state) {
      imageryV.textContent = text.replace(/^Imagery: /, '')
      imageryV.dataset.state = state
    },
  }
}

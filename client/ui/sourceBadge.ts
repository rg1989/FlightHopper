// client/ui/sourceBadge.ts
// Where the aircraft come from, at the top of the right column in both modes: "LIVE · adsb.fi" (linked, as adsb.fi's
// terms ask), "REPLAY · <recording time>" for a recording, plus "loading N areas" while a wide view fills centre-out.
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

export function mountSourceBadge(root: HTMLElement): { update(status: StatusBrief | null, serverNowMs: number | null): void } {
  const el = document.createElement('a')
  el.className = 'fh-source'
  el.target = '_blank'
  el.rel = 'noopener'
  el.hidden = true
  root.prepend(el)
  let shown = ''
  return {
    update(status, serverNowMs) {
      if (status === null) return
      const v = sourceView(status, serverNowMs)
      const key = `${v.text}|${v.state}|${v.title}`
      if (key === shown) return
      shown = key
      el.hidden = false
      el.textContent = v.text
      el.title = v.title
      el.dataset.state = v.state
      if (v.href === null) el.removeAttribute('href')
      else el.href = v.href
    },
  }
}

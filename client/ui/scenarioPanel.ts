// client/ui/scenarioPanel.ts
// The Scenarios panel (rail): a card per recorded flight, built from its manifest alone: title, subtitle, date and clock
// span, registration · type, the summary, a collapsed crew list, the note, and Play. It loads list() at mount (a
// skeleton meanwhile, an error line with Try again if it fails); refresh() loads again, and an older answer that
// arrives late is dropped. setPlaying(id) marks the running scenario's button "Playing" (disabled). Text only.
import { sToClock } from '../scenario/format.ts'
import type { ScenarioCard } from '../scenario/types.ts'
import { icon } from './icons.ts'
import './scenarioPanel.css'

export interface ScenarioPanelOpts {
  list(): Promise<ScenarioCard[]>
  onPlay(id: string): void
}

export interface ScenarioPanelHandle {
  refresh(): void
  setPlaying(id: string | null): void
  destroy(): void
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** '1985-08-12' → '12 August 1985' (read as written: no time zone moves the day). */
function dateText(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return `${d} ${MONTHS[m - 1] ?? ''} ${y}`
}

/** Scenario seconds → 'HH:MM', floored as the play bar's clock is (hours past 23 kept). */
const hm = (t: number): string => sToClock(Math.floor(t)).slice(0, -3)

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (className !== '') el.className = className
  if (text !== '') el.textContent = text
  return el
}

export function mountScenarioPanel(body: HTMLElement, opts: ScenarioPanelOpts): ScenarioPanelHandle {
  const root = h('div', 'fh-scn')
  body.append(root)
  const buttons = new Map<string, { btn: HTMLButtonElement; label: HTMLElement }>()
  let playing: string | null = null
  let generation = 0 // a newer refresh() (or destroy) makes older answers stale

  function skeleton(): HTMLElement {
    const s = h('div', 'fh-scn-skel')
    s.setAttribute('aria-hidden', 'true')
    for (let i = 0; i < 5; i++) s.append(h('span', 'fh-skel')) // widths in the CSS
    return s
  }

  function card(c: ScenarioCard): HTMLElement {
    const art = h('article', 'fh-scn-card')
    art.setAttribute('aria-label', c.title) // its Play button then reads in context
    const head = h('header', 'fh-scn-head')
    head.append(h('h3', 'fh-scn-title', c.title))
    if (c.subtitle) head.append(h('p', 'fh-scn-sub', c.subtitle))
    art.append(head)
    art.append(h('p', 'fh-scn-date fh-num', `${dateText(c.date)} · ${hm(c.start)}–${hm(c.end)} ${c.clockLabel}`))
    art.append(h('p', 'fh-scn-ac', [c.aircraft.registration, c.aircraft.type].filter(Boolean).join(' · ')))
    if (c.summary.length > 0) {
      const sum = h('div', 'fh-scn-summary')
      for (const line of c.summary) sum.append(h('p', '', line))
      art.append(sum)
    }
    if (c.crew.length > 0) {
      const crew = h('details', 'fh-scn-crew')
      const list = h('ul', 'fh-scn-crew-list')
      for (const m of c.crew) {
        const li = h('li')
        li.append(h('span', 'fh-scn-crew-role', m.role), h('span', 'fh-scn-crew-name', m.name))
        if (m.detail) li.append(h('span', 'fh-scn-crew-detail', m.detail))
        list.append(li)
      }
      crew.append(h('summary', 'fh-scn-crew-t', 'Crew'), list)
      art.append(crew)
    }
    if (c.note) art.append(h('p', 'fh-scn-note', c.note))
    const btn = h('button', 'fh-pill fh-scn-play')
    btn.type = 'button'
    const ic = h('span', 'fh-pill-icon')
    ic.append(icon('play', 14))
    const label = h('span', 'fh-scn-play-t', 'Play')
    btn.append(ic, label)
    btn.addEventListener('click', () => opts.onPlay(c.id))
    const foot = h('div', 'fh-scn-foot')
    foot.append(btn)
    art.append(foot)
    buttons.set(c.id, { btn, label })
    return art
  }

  function paintPlaying(): void {
    for (const [id, { btn, label }] of buttons) {
      const on = id === playing
      if (btn.disabled !== on) btn.disabled = on
      const t = on ? 'Playing' : 'Play'
      if (label.textContent !== t) label.textContent = t
      btn.classList.toggle('fh-pill-secondary', on)
    }
  }

  function failed(): HTMLElement {
    const box = h('div', 'fh-scn-error')
    box.setAttribute('role', 'alert')
    box.append(h('p', 'fh-scn-error-t', 'Could not load the scenarios.'))
    const retry = h('button', 'fh-pill fh-pill-secondary', 'Try again')
    retry.type = 'button'
    retry.addEventListener('click', () => api.refresh())
    box.append(retry)
    return box
  }

  const api: ScenarioPanelHandle = {
    refresh() {
      const mine = ++generation
      buttons.clear()
      root.setAttribute('aria-busy', 'true')
      root.replaceChildren(skeleton())
      const show = (content: HTMLElement[]): void => {
        root.setAttribute('aria-busy', 'false')
        root.replaceChildren(...content)
        paintPlaying()
      }
      opts.list().then(
        (cards) => {
          if (mine === generation) show(cards.length > 0 ? cards.map((c) => card(c)) : [h('p', 'fh-scn-empty', 'No scenarios yet.')])
        },
        (err: unknown) => {
          if (mine !== generation) return
          console.warn('[scenarios] list failed', err) // a package author needs the reason (ScenarioError lists every problem)
          show([failed()])
        },
      )
    },
    setPlaying(id) {
      playing = id
      paintPlaying()
    },
    destroy() {
      generation++
      buttons.clear()
      root.remove()
    },
  }
  api.refresh()
  return api
}

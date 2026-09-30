// client/ui/scenarioPanel.ts
// The Scenarios panel (rail), in two sections. Scenarios: the packaged reconstructions (public/scenarios). Recordings:
// the flights recorded with the flight card's Record button (server/flightLog.ts), newest first, each replayed like a
// scenario (fromRecording.ts). Every item is one compact row: Play, its title and one line (date and span, or route,
// start and length), and a chevron that opens its details (a package's subtitle, aircraft, summary, crew and note; a
// recording's aircraft, route, times, points and how it ended). A recording still under way is marked and plays what
// is recorded so far; one too short to play says so. A recording's details also hold Rename (a name of its own, in
// place: Enter saves, Esc cancels, blank clears) and Delete (asked twice: it is for good). The scenarios load once, at
// mount; the recordings at mount and again on refresh('recordings') (the app asks when the panel opens). An older
// answer that arrives late is dropped; open details stay open across reloads. setPlaying(id) marks the running item.
// Text only.
import type { RecordingInfo } from '../../shared/api.ts'
import { sToClock } from '../scenario/format.ts'
import { recordingId } from '../scenario/fromRecording.ts'
import type { ScenarioCard } from '../scenario/types.ts'
import { icon } from './icons.ts'
import './scenarioPanel.css'

export interface ScenarioPanelOpts {
  list(): Promise<ScenarioCard[]>
  /** The recorded flights, newest first; null: this server records nothing. Absent: no Recordings section. */
  recordings?(): Promise<RecordingInfo[] | null>
  onPlay(id: string): void
  /** Names a recording (blank clears); resolves to the list after. Absent: no Rename. */
  onRename?(file: string, name: string): Promise<RecordingInfo[]>
  /** Deletes a recording for good; resolves to the list after. Absent: no Delete. */
  onDelete?(file: string): Promise<RecordingInfo[]>
}

export interface ScenarioPanelHandle {
  /** Loads both sections again, or only the recordings. */
  refresh(what?: 'recordings'): void
  setPlaying(id: string | null): void
  destroy(): void
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MIN_PLAY_S = 2 // a recording shorter than this has nothing to play
const NAME_MAX = 60 // server/flightLog.ts NAME_MAX

/** '1985-08-12' → '12 August 1985' (read as written: no time zone moves the day). */
function dateText(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return `${d} ${MONTHS[m - 1] ?? ''} ${y}`
}

/** Scenario seconds → 'HH:MM', floored as the play bar's clock is (hours past 23 kept). */
const hm = (t: number): string => sToClock(Math.floor(t)).slice(0, -3)

/** UTC ms → '30 Sep 2026 · 00:29 UTC'. */
function utcText(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()} · ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`
}

/** 45 → '45 s', 400 → '6 min', 4400 → '1 h 13 min'. */
export function lengthText(s: number): string {
  if (s < 60) return `${Math.max(0, Math.round(s))} s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

const ENDED: Record<NonNullable<RecordingInfo['ended']>['why'], string> = {
  landed: 'Landed (stopped by itself)',
  stopped: 'Stopped by hand',
  lost: 'Signal lost for 15 min',
}

/** A recording's played seconds: its first to last sample. */
const spanS = (r: RecordingInfo): number => (r.firstMs === null || r.lastMs === null ? 0 : (r.lastMs - r.firstMs) / 1000)

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (className !== '') el.className = className
  if (text !== '') el.textContent = text
  return el
}

export function mountScenarioPanel(body: HTMLElement, opts: ScenarioPanelOpts): ScenarioPanelHandle {
  const root = h('div', 'fh-scn')
  const scnList = h('div', 'fh-scn-list')
  const recList = h('div', 'fh-scn-list')
  root.append(h('h3', 'fh-scn-section', 'Scenarios'), scnList)
  if (opts.recordings) root.append(h('h3', 'fh-scn-section', 'Recordings'), recList)
  body.append(root)
  const buttons = new Map<string, HTMLButtonElement>()
  const expanded = new Set<string>() // ids whose details are open: kept across reloads
  let playing: string | null = null
  const generation = { scn: 0, rec: 0 } // a newer load (or destroy) makes older answers stale

  function skeleton(): HTMLElement {
    const s = h('div', 'fh-scn-skel')
    s.setAttribute('aria-hidden', 'true')
    for (let i = 0; i < 3; i++) s.append(h('span', 'fh-skel')) // widths in the CSS
    return s
  }

  /** Label: value rows for an item's details. */
  function facts(rows: [string, string][]): HTMLElement {
    const dl = h('dl', 'fh-scn-facts')
    for (const [k, v] of rows) if (v !== '') dl.append(h('dt', '', k), h('dd', '', v))
    return dl
  }

  /**
   * One compact row: Play, title (+ a mark), one line, and a chevron that shows the details. playable false: Play is
   * disabled and why says so in the line's place.
   */
  function item(id: string, title: string, line: string, details: HTMLElement[], o: { mark?: string; playable?: boolean; why?: string } = {}): HTMLElement {
    const art = h('article', 'fh-scn-item')
    art.setAttribute('aria-label', title)
    const row = h('div', 'fh-scn-row')
    const play = h('button', 'fh-scn-play')
    play.type = 'button'
    play.append(icon('play', 14))
    play.setAttribute('aria-label', `Play ${title}`)
    play.title = o.playable === false ? (o.why ?? 'Nothing to play') : 'Play'
    play.addEventListener('click', () => opts.onPlay(id))
    if (o.playable === false) play.dataset.off = '1'
    const text = h('div', 'fh-scn-text')
    const top = h('div', 'fh-scn-top')
    top.append(h('span', 'fh-scn-title', title))
    if (o.mark) top.append(h('span', 'fh-scn-mark', o.mark))
    text.append(top, h('div', 'fh-scn-line fh-num', o.playable === false && o.why ? o.why : line))
    const more = h('button', 'fh-ibtn fh-sm fh-scn-more')
    more.type = 'button'
    more.append(icon('chevronDown', 16))
    more.setAttribute('aria-expanded', 'false')
    more.setAttribute('aria-label', `Details of ${title}`)
    more.title = 'Details'
    const box = h('div', 'fh-scn-details')
    box.append(...details)
    const show = (open: boolean): void => {
      box.hidden = !open
      if (open) expanded.add(id)
      else expanded.delete(id)
      more.setAttribute('aria-expanded', String(open))
      more.replaceChildren(icon(open ? 'chevronUp' : 'chevronDown', 16))
    }
    show(expanded.has(id))
    more.addEventListener('click', () => show(box.hidden !== false))
    row.append(play, text, more)
    art.append(row, box)
    buttons.set(id, play)
    return art
  }

  function scenarioItem(c: ScenarioCard): HTMLElement {
    const details: HTMLElement[] = []
    if (c.subtitle) details.push(h('p', 'fh-scn-sub', c.subtitle))
    details.push(facts([['Aircraft', [c.aircraft.registration, c.aircraft.type].filter(Boolean).join(' · ')], ['Flight', c.aircraft.callsign]]))
    for (const p of c.summary) details.push(h('p', 'fh-scn-p', p))
    if (c.crew.length > 0) {
      const list = h('ul', 'fh-scn-crew-list')
      for (const m of c.crew) {
        const li = h('li')
        li.append(h('span', 'fh-scn-crew-role', m.role), h('span', 'fh-scn-crew-name', m.name))
        if (m.detail) li.append(h('span', 'fh-scn-crew-detail', m.detail))
        list.append(li)
      }
      details.push(h('h4', 'fh-scn-h', 'Crew'), list)
    }
    if (c.note) details.push(h('p', 'fh-scn-note', c.note))
    return item(c.id, c.title, `${dateText(c.date)} · ${hm(c.start)}–${hm(c.end)} ${c.clockLabel}`, details)
  }

  /** Rename and Delete for one recording, in its details. */
  function recordingActions(r: RecordingInfo, flight: string): HTMLElement {
    const bar = h('div', 'fh-scn-actions')
    const msg = h('p', 'fh-scn-actmsg')
    msg.hidden = true
    msg.setAttribute('role', 'alert')
    const small = (label: string, cls = ''): HTMLButtonElement => {
      const b = h('button', `fh-scn-act ${cls}`.trim(), label)
      b.type = 'button'
      return b
    }
    const busy = (on: boolean): void => {
      for (const b of bar.querySelectorAll('button')) b.disabled = on
    }
    const fail = (what: string, e: unknown): void => {
      console.warn(`[recordings] ${what} failed`, e)
      busy(false)
      msg.textContent = `Could not ${what} it. Try again.`
      msg.hidden = false
    }
    const done = (recs: RecordingInfo[]): void => {
      generation.rec++ // an answer to an older ask must not undo this
      recList.replaceChildren(...showRecordings(recs))
      paintPlaying()
    }

    const idle = (): void => {
      const items: HTMLElement[] = []
      if (opts.onRename) {
        const rename = small('Rename')
        rename.addEventListener('click', editing)
        items.push(rename)
      }
      if (opts.onDelete) {
        const del = small('Delete', 'fh-scn-danger')
        del.addEventListener('click', confirming)
        items.push(del)
      }
      bar.replaceChildren(...items)
    }

    const editing = (): void => {
      const input = h('input', 'fh-scn-input')
      input.type = 'text'
      input.value = r.name ?? ''
      input.placeholder = flight
      input.maxLength = NAME_MAX
      input.setAttribute('aria-label', `Name of the recording of ${flight}`)
      const save = small('Save', 'fh-scn-primary')
      const cancel = small('Cancel')
      const commit = (): void => {
        busy(true)
        input.disabled = true
        opts.onRename!(r.file, input.value).then(done, (e: unknown) => {
          input.disabled = false
          fail('rename', e)
        })
      }
      save.addEventListener('click', commit)
      cancel.addEventListener('click', idle)
      input.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key !== 'Enter' && e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation() // Esc here cancels the edit, not the panel (the app's Esc closes it)
        if (e.key === 'Enter') commit()
        else idle()
      })
      bar.replaceChildren(input, save, cancel)
      input.focus()
    }

    const confirming = (): void => {
      const q = h('span', 'fh-scn-ask', 'Delete for good?')
      const yes = small('Delete', 'fh-scn-danger fh-scn-primary')
      const no = small('Cancel')
      yes.addEventListener('click', () => {
        busy(true)
        opts.onDelete!(r.file).then(done, (e: unknown) => fail('delete', e))
      })
      no.addEventListener('click', idle)
      bar.replaceChildren(q, yes, no)
      no.focus()
    }

    idle()
    const wrap = h('div', 'fh-scn-edit')
    wrap.append(bar, msg)
    return wrap
  }

  function recordingItem(r: RecordingInfo): HTMLElement {
    const flight = r.callsign ?? r.hex.toUpperCase()
    const title = r.name ?? flight
    const route = r.route === null ? '' : r.route.split('-').join(' → ')
    const span = spanS(r)
    const when = utcText(r.firstMs ?? r.startedMs)
    const ended = r.active ? 'Still recording' : r.ended === null ? 'Cut short (the server stopped)' : ENDED[r.ended.why]
    const details = [facts([
      ['Flight', r.name === null ? '' : flight],
      ['Aircraft', [r.reg, r.typeCode].filter(Boolean).join(' · ')],
      ['Route', route],
      ['Started', utcText(r.startedMs)],
      ['Length', lengthText(span)],
      ['Points', r.samples.toLocaleString('en-US')],
      ['Ended', ended],
      ['Source', r.source],
    ])]
    if (opts.onRename || opts.onDelete) details.push(recordingActions(r, flight))
    const line = [route, when, lengthText(span)].filter(Boolean).join(' · ')
    const playable = r.samples >= 2 && span >= MIN_PLAY_S
    return item(recordingId(r.file), title, line, details, { mark: r.active ? 'REC' : undefined, playable, why: 'Too short to replay' })
  }

  function failed(what: string, retry: () => void): HTMLElement {
    const box = h('div', 'fh-scn-error')
    box.setAttribute('role', 'alert')
    box.append(h('p', 'fh-scn-error-t', `Could not load the ${what}.`))
    const again = h('button', 'fh-pill fh-pill-secondary', 'Try again')
    again.type = 'button'
    again.addEventListener('click', retry)
    box.append(again)
    return box
  }

  function paintPlaying(): void {
    for (const [id, btn] of buttons) {
      const on = id === playing
      const off = btn.dataset.off === '1'
      if (btn.disabled !== (on || off)) btn.disabled = on || off
      btn.classList.toggle('fh-on', on)
      btn.setAttribute('aria-pressed', String(on))
    }
  }

  function load<T>(list: HTMLElement, key: 'scn' | 'rec', get: () => Promise<T>, show: (v: T) => HTMLElement[], what: string): void {
    const mine = ++generation[key]
    for (const [id] of buttons) if ((key === 'rec') === id.startsWith('rec:')) buttons.delete(id)
    list.setAttribute('aria-busy', 'true')
    // A reload keeps what is there until the answer comes (no flash); the first load shows a skeleton.
    if (list.childElementCount === 0) list.replaceChildren(skeleton())
    get().then(
      (v) => {
        if (mine !== generation[key]) return
        list.setAttribute('aria-busy', 'false')
        list.replaceChildren(...show(v))
        paintPlaying()
      },
      (err: unknown) => {
        if (mine !== generation[key]) return
        console.warn(`[scenarios] ${what} failed`, err) // a package author needs the reason (ScenarioError lists every problem)
        list.setAttribute('aria-busy', 'false')
        list.replaceChildren(failed(what, () => load(list, key, get, show, what)))
      },
    )
  }

  const loadScenarios = (): void =>
    load(scnList, 'scn', opts.list, (cards) => (cards.length > 0 ? cards.map(scenarioItem) : [h('p', 'fh-scn-empty', 'No scenarios yet.')]), 'scenarios')
  const showRecordings = (recs: RecordingInfo[] | null): HTMLElement[] =>
    recs === null
      ? [h('p', 'fh-scn-empty', 'This server records nothing: start it with make to record flights.')]
      : recs.length > 0
        ? recs.map(recordingItem)
        : [h('p', 'fh-scn-empty', 'None yet. Select a flight and press the record button on its card.')]
  const loadRecordings = (): void => {
    if (opts.recordings) load(recList, 'rec', opts.recordings, showRecordings, 'recordings')
  }

  const api: ScenarioPanelHandle = {
    refresh(what) {
      if (what !== 'recordings') loadScenarios()
      loadRecordings()
    },
    setPlaying(id) {
      playing = id
      paintPlaying()
    },
    destroy() {
      generation.scn++
      generation.rec++
      buttons.clear()
      root.remove()
    },
  }
  api.refresh()
  return api
}

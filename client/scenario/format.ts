// client/scenario/format.ts
// Scenario package validation and assembly (.planning/scenarios-design.md §3): turns scenario.json + the CSV text
// of a package into a typed, validated Scenario, or throws one ScenarioError listing every problem found.
import { parseCsv } from './csv.ts'
import type {
  AircraftSpec,
  AudioClip,
  AudioSpec,
  Channel,
  CrewMember,
  EndingSpec,
  EventRow,
  EventType,
  ImagerySpec,
  Line,
  LineQuality,
  LiverySpec,
  RowQuality,
  Scenario,
  ScenarioCard,
  SourceRef,
  SpeakerDef,
  SpeakerKind,
  TrackRow,
} from './types.ts'

const SPEAKER_KINDS: readonly SpeakerKind[] = ['crew', 'cabin', 'atc', 'company', 'alert', 'other']
const CHANNELS: readonly Channel[] = ['cockpit', 'radio', 'company', 'cabin', 'interphone', 'alert']
const EVENT_TYPES: readonly EventType[] = ['phase', 'mark', 'gear', 'flaps', 'damage']

export class ScenarioError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(problems.length === 1 ? problems[0] : `${problems.length} problems:\n${problems.join('\n')}`)
    this.name = 'ScenarioError'
    this.problems = problems
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

// ---- time -----------------------------------------------------------------------------------------

const CLOCK_RE = /^(\d+):([0-5]\d):([0-5]\d)(\.\d+)?$/

/** '18:24:35.7' → 66275.7. Hours may exceed 23 (a scenario that crosses local midnight). Throws on bad input. */
export function clockToS(clock: string): number {
  const m = CLOCK_RE.exec(clock)
  if (!m) throw new Error(`bad clock: ${JSON.stringify(clock)}`)
  const h = Number(m[1])
  const mi = Number(m[2])
  const sec = Number(m[3])
  const frac = m[4] ? Number(m[4]) : 0
  return h * 3600 + mi * 60 + sec + frac
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n))

/** 66275 → '18:24:35'. Hours ≥ 24 are kept as such (not wrapped to a new day). */
export function sToClock(t: number, decimals = 0): string {
  const neg = t < 0
  const at = Math.abs(t)
  const scale = 10 ** decimals
  const rounded = Math.round(at * scale) / scale
  const wholeS = Math.floor(rounded)
  const frac = rounded - wholeS
  const hh = Math.floor(wholeS / 3600)
  const mm = Math.floor((wholeS % 3600) / 60)
  const ss = wholeS % 60
  const secStr = decimals > 0 ? (ss + frac).toFixed(decimals).padStart(decimals + 3, '0') : pad2(ss)
  return `${neg ? '-' : ''}${pad2(hh)}:${pad2(mm)}:${secStr}`
}

const OFFSET_RE = /^([+-])(\d{2}):(\d{2})$/

/** '+09:00' → 32_400_000 (ms east of UTC). */
export function offsetMs(utcOffset: string): number {
  const m = OFFSET_RE.exec(utcOffset)
  if (!m) throw new Error(`bad utc offset: ${JSON.stringify(utcOffset)}`)
  const sign = m[1] === '-' ? -1 : 1
  return sign * (Number(m[2]) * 3600 + Number(m[3]) * 60) * 1000
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// ---- unknown-JSON helpers --------------------------------------------------------------------------

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}
function isString(x: unknown): x is string {
  return typeof x === 'string'
}
function isNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x)
}

// ---- manifest (scenario.json) ----------------------------------------------------------------------

interface ManifestOut {
  format: 1
  id: string
  title: string
  subtitle: string
  date: string
  utcOffset: string
  clockLabel: string
  start: number
  end: number
  t0UtcMs: number
  note: string
  summary: string[]
  crew: CrewMember[]
  aircraft: AircraftSpec
  speakers: Record<string, SpeakerDef>
  imagery: ImagerySpec[]
  ending: EndingSpec | null
  audio: AudioSpec | null
  sources: SourceRef[]
}

const MANIFEST_FILE = 'scenario.json'

function parseManifest(manifest: unknown, problems: string[]): ManifestOut {
  const add = (col: string, msg: string): void => {
    problems.push(`${MANIFEST_FILE}:-: ${col}: ${msg}`)
  }
  const m: Record<string, unknown> = isRecord(manifest) ? manifest : {}
  if (!isRecord(manifest)) add('-', 'manifest is not an object')

  if (m.format !== 1) add('format', `must be 1, got ${JSON.stringify(m.format)}`)

  const reqStr = (key: string): string => {
    const v = m[key]
    if (!isString(v) || v.length === 0) {
      add(key, 'required, non-empty string')
      return ''
    }
    return v
  }
  const id = reqStr('id')
  const title = reqStr('title')
  const subtitle = reqStr('subtitle')
  const date = reqStr('date')
  const utcOffset = reqStr('utcOffset')
  const clockLabel = reqStr('clockLabel')
  const startStr = reqStr('start')
  const endStr = reqStr('end')
  const note = reqStr('note')

  if (date && !DATE_RE.test(date)) add('date', `bad date, want YYYY-MM-DD: ${JSON.stringify(date)}`)
  if (utcOffset && !OFFSET_RE.test(utcOffset)) add('utcOffset', `bad utc offset, want ±HH:MM: ${JSON.stringify(utcOffset)}`)

  let start = 0
  let end = 0
  let startOk = false
  let endOk = false
  try {
    if (startStr) {
      start = clockToS(startStr)
      startOk = true
    }
  } catch {
    add('start', `bad time: ${JSON.stringify(startStr)}`)
  }
  try {
    if (endStr) {
      end = clockToS(endStr)
      endOk = true
    }
  } catch {
    add('end', `bad time: ${JSON.stringify(endStr)}`)
  }
  if (startOk && endOk && !(start < end)) add('start', 'start must be before end')

  let t0UtcMs = 0
  if (DATE_RE.test(date) && OFFSET_RE.test(utcOffset)) {
    const [y, mo, d] = date.split('-').map(Number)
    t0UtcMs = Date.UTC(y, mo - 1, d) - offsetMs(utcOffset)
  }

  const aircraftRaw = m.aircraft
  let aircraft: AircraftSpec = { registration: '', type: '', callsign: '', operator: '', model: '' }
  if (isRecord(aircraftRaw)) {
    const model = aircraftRaw.model
    if (!isString(model) || model.length === 0) add('aircraft.model', 'required, non-empty')
    aircraft = {
      registration: isString(aircraftRaw.registration) ? aircraftRaw.registration : '',
      type: isString(aircraftRaw.type) ? aircraftRaw.type : '',
      callsign: isString(aircraftRaw.callsign) ? aircraftRaw.callsign : '',
      operator: isString(aircraftRaw.operator) ? aircraftRaw.operator : '',
      model: isString(model) ? model : '',
      // ponytail: shape/livery sub-fields are passed through as given (ceiling: no per-field validation) since the
      // brief's validation list does not call them out beyond aircraft.model.
      ...(isRecord(aircraftRaw.shape) ? { shape: aircraftRaw.shape as AircraftSpec['shape'] } : {}),
      ...(isRecord(aircraftRaw.livery) ? { livery: aircraftRaw.livery as unknown as LiverySpec } : {}),
    }
  } else {
    add('aircraft', 'required object')
  }

  const speakersRaw = m.speakers
  const speakers: Record<string, SpeakerDef> = {}
  if (isRecord(speakersRaw)) {
    for (const [k, v] of Object.entries(speakersRaw)) {
      if (!isRecord(v) || !isString(v.name) || !SPEAKER_KINDS.includes(v.kind as SpeakerKind)) {
        add(`speakers.${k}`, `bad speaker: ${JSON.stringify(v)}`)
        continue
      }
      speakers[k] = { name: v.name, kind: v.kind as SpeakerKind }
    }
  }

  const imageryRaw = m.imagery
  const imagery: ImagerySpec[] = []
  if (Array.isArray(imageryRaw)) {
    imageryRaw.forEach((it, i) => {
      if (!isRecord(it) || !Array.isArray(it.rect) || it.rect.length !== 4) {
        add(`imagery[${i}]`, 'bad imagery entry')
        return
      }
      const [west, south, east, north] = it.rect as number[]
      if (!(west < east)) add(`imagery[${i}].rect`, `west must be < east: ${west} >= ${east}`)
      if (!(south < north)) add(`imagery[${i}].rect`, `south must be < north: ${south} >= ${north}`)
      imagery.push({
        url: isString(it.url) ? it.url : '',
        rect: [west, south, east, north],
        credit: isString(it.credit) ? it.credit : '',
        ...(isNumber(it.minZoom) ? { minZoom: it.minZoom } : {}),
        ...(isNumber(it.maxZoom) ? { maxZoom: it.maxZoom } : {}),
      })
    })
  }

  const endingRaw = m.ending
  let ending: EndingSpec | null = null
  if (isRecord(endingRaw)) {
    let fadeFrom = 0
    let darkAt = 0
    try {
      fadeFrom = clockToS(String(endingRaw.fadeFrom))
    } catch {
      add('ending.fadeFrom', `bad time: ${JSON.stringify(endingRaw.fadeFrom)}`)
    }
    try {
      darkAt = clockToS(String(endingRaw.darkAt))
    } catch {
      add('ending.darkAt', `bad time: ${JSON.stringify(endingRaw.darkAt)}`)
    }
    if (fadeFrom > darkAt) add('ending.fadeFrom', 'fadeFrom must be <= darkAt')
    const cardRaw = endingRaw.card
    ending = {
      fadeFrom,
      darkAt,
      cardAfterS: isNumber(endingRaw.cardAfterS) ? endingRaw.cardAfterS : 0,
      card: isRecord(cardRaw)
        ? { title: isString(cardRaw.title) ? cardRaw.title : '', lines: Array.isArray(cardRaw.lines) ? cardRaw.lines.filter(isString) : [] }
        : { title: '', lines: [] },
    }
  }

  const audioRaw = m.audio
  let audio: AudioSpec | null = null
  if (isRecord(audioRaw)) {
    if (!isString(audioRaw.source) || audioRaw.source.length === 0) add('audio.source', 'required, non-empty')
    const clipsRaw = Array.isArray(audioRaw.clips) ? audioRaw.clips : []
    const clips: AudioClip[] = []
    clipsRaw.forEach((c, i) => {
      if (!isRecord(c) || !isNumber(c.from) || !isNumber(c.to)) {
        add(`audio.clips[${i}]`, 'bad clip')
        return
      }
      if (!(c.from < c.to)) add(`audio.clips[${i}]`, `from must be < to: ${c.from} >= ${c.to}`)
      let at = 0
      try {
        at = clockToS(String(c.at))
      } catch {
        add(`audio.clips[${i}].at`, `bad time: ${JSON.stringify(c.at)}`)
      }
      clips.push({ from: c.from, to: c.to, at })
    })
    audio = { file: isString(audioRaw.file) ? audioRaw.file : '', source: isString(audioRaw.source) ? audioRaw.source : '', clips }
  }

  const sourcesRaw = Array.isArray(m.sources) ? m.sources : []
  const sources: SourceRef[] = []
  const seenSourceIds = new Set<string>()
  sourcesRaw.forEach((s, i) => {
    if (!isRecord(s) || !isString(s.id) || s.id.length === 0) {
      add(`sources[${i}]`, 'required id')
      return
    }
    if (seenSourceIds.has(s.id)) add(`sources[${i}]`, `duplicate source id: ${JSON.stringify(s.id)}`)
    seenSourceIds.add(s.id)
    sources.push({
      id: s.id,
      title: isString(s.title) ? s.title : '',
      ...(isString(s.url) ? { url: s.url } : {}),
      ...(isString(s.note) ? { note: s.note } : {}),
    })
  })

  const crew: CrewMember[] = Array.isArray(m.crew)
    ? m.crew.filter(isRecord).map((c) => ({ role: isString(c.role) ? c.role : '', name: isString(c.name) ? c.name : '', ...(isString(c.detail) ? { detail: c.detail } : {}) }))
    : []
  const summary: string[] = Array.isArray(m.summary) ? m.summary.filter(isString) : []

  return { format: 1, id, title, subtitle, date, utcOffset, clockLabel, start, end, t0UtcMs, note, summary, crew, aircraft, speakers, imagery, ending, audio, sources }
}

// ---- CSV files --------------------------------------------------------------------------------------

function cell(row: string[], i: number): string {
  return i >= 0 ? (row[i] ?? '') : ''
}

/** Parses a CSV file's text, checks its header against the schema (missing required / unknown columns, `x_*` allowed). */
function parseCsvFile(
  file: string,
  text: string,
  required: readonly string[],
  optional: readonly string[],
  problems: string[],
): { rows: string[][]; col: (name: string) => number } {
  const all = parseCsv(text)
  const header = all[0] ?? []
  const rows = all.slice(1)
  const idx = new Map<string, number>()
  header.forEach((h, i) => idx.set(h, i))
  for (const req of required) {
    if (!idx.has(req)) problems.push(`${file}:1: ${req}: missing required column`)
  }
  header.forEach((h) => {
    if (!required.includes(h) && !optional.includes(h) && !h.startsWith('x_')) problems.push(`${file}:1: ${h}: unknown column`)
  })
  const col = (name: string): number => idx.get(name) ?? -1
  return { rows, col }
}

const TRACK_REQUIRED = ['time', 'lat', 'lon', 'alt_ft', 'hdg', 'pitch', 'roll'] as const
const TRACK_OPTIONAL = ['gnd', 'ias_kt', 'gs_kt', 'vs_fpm', 'g', 'wind_dir', 'wind_kt', 'epr1', 'epr2', 'epr3', 'epr4', 'q', 'src'] as const

function parseTrack(file: string, text: string, sourceIds: ReadonlySet<string>, startT: number, endT: number, problems: string[]): TrackRow[] {
  const { rows, col } = parseCsvFile(file, text, TRACK_REQUIRED, TRACK_OPTIONAL, problems)
  const out: TrackRow[] = []
  const tOk: boolean[] = [] // parallel to out: whether that row's time parsed, so boundary checks can skip a bad one
  let prevT: number | null = null
  const eprCols = (['epr1', 'epr2', 'epr3', 'epr4'] as const).map((c) => col(c)).filter((i) => i >= 0)

  const num = (row: string[], i: number, name: string, r: number, required: boolean): number | null => {
    const v = cell(row, i)
    if (v === '') {
      if (required) problems.push(`${file}:${r}: ${name}: required, missing value`)
      return null
    }
    const n = Number(v)
    if (!Number.isFinite(n)) {
      problems.push(`${file}:${r}: ${name}: bad number: ${JSON.stringify(v)}`)
      return null
    }
    return n
  }

  rows.forEach((row, i) => {
    const r = i + 2 // header is file line 1
    const timeStr = cell(row, col('time'))
    let t = NaN
    try {
      t = clockToS(timeStr)
    } catch {
      problems.push(`${file}:${r}: time: bad time: ${JSON.stringify(timeStr)}`)
    }
    if (Number.isFinite(t)) {
      if (prevT !== null && !(t > prevT)) problems.push(`${file}:${r}: time: not strictly increasing`)
      prevT = t
    }

    const lat = num(row, col('lat'), 'lat', r, true) ?? 0
    const lon = num(row, col('lon'), 'lon', r, true) ?? 0
    const altFt = num(row, col('alt_ft'), 'alt_ft', r, true) ?? 0
    const hdg = num(row, col('hdg'), 'hdg', r, true) ?? 0
    const pitch = num(row, col('pitch'), 'pitch', r, true) ?? 0
    const roll = num(row, col('roll'), 'roll', r, true) ?? 0

    if (lat < -90 || lat > 90) problems.push(`${file}:${r}: lat: out of range [-90, 90]: ${lat}`)
    if (lon < -180 || lon > 180) problems.push(`${file}:${r}: lon: out of range [-180, 180]: ${lon}`)
    if (!(hdg >= 0 && hdg < 360)) problems.push(`${file}:${r}: hdg: out of range [0, 360): ${hdg}`)
    if (pitch < -90 || pitch > 90) problems.push(`${file}:${r}: pitch: out of range [-90, 90]: ${pitch}`)
    if (roll < -180 || roll > 180) problems.push(`${file}:${r}: roll: out of range [-180, 180]: ${roll}`)

    const gnd = cell(row, col('gnd')) === '1'

    const qCell = cell(row, col('q'))
    if (qCell !== '' && qCell !== 'A' && qCell !== 'M' && qCell !== 'R') problems.push(`${file}:${r}: q: bad quality, want A, M or R: ${JSON.stringify(qCell)}`)

    const srcCell = cell(row, col('src'))
    let src: string | null = null
    if (srcCell !== '') {
      src = srcCell
      const id = srcCell.split(':')[0]
      if (!sourceIds.has(id)) problems.push(`${file}:${r}: src: unknown source: ${JSON.stringify(id)}`)
    }

    const epr = eprCols.length > 0 ? eprCols.map((ci) => { const v = cell(row, ci); return v === '' ? NaN : Number(v) }) : null

    out.push({
      t: Number.isFinite(t) ? t : 0,
      lat,
      lon,
      altFt,
      hdg,
      pitch,
      roll,
      gnd,
      iasKt: num(row, col('ias_kt'), 'ias_kt', r, false),
      gsKt: num(row, col('gs_kt'), 'gs_kt', r, false),
      vsFpm: num(row, col('vs_fpm'), 'vs_fpm', r, false),
      g: num(row, col('g'), 'g', r, false),
      windFromDeg: num(row, col('wind_dir'), 'wind_dir', r, false),
      windKt: num(row, col('wind_kt'), 'wind_kt', r, false),
      epr,
      q: qCell === 'A' || qCell === 'M' || qCell === 'R' ? (qCell as RowQuality) : null,
      src,
    })
    tOk.push(Number.isFinite(t))
  })

  if (out.length < 2) problems.push(`${file}:-: -: at least 2 rows required, got ${out.length}`)
  if (out.length > 0) {
    // Skip a boundary check on an endpoint whose time failed to parse: that row already got its own "bad time"
    // problem, and comparing its 0-fallback t to start/end would just duplicate and obscure it.
    if (tOk[0] && out[0].t > startT) problems.push(`${file}:2: time: first row (${sToClock(out[0].t)}) must be at or before start (${sToClock(startT)})`)
    const last = out[out.length - 1]
    if (tOk[tOk.length - 1] && last.t < endT) problems.push(`${file}:${out.length + 1}: time: last row (${sToClock(last.t)}) must be at or after end (${sToClock(endT)})`)
  }

  return out
}

const EVENT_COLUMNS = ['time', 'type', 'value', 'label', 'src'] as const

function parseEvents(file: string, text: string, sourceIds: ReadonlySet<string>, problems: string[]): EventRow[] {
  const { rows, col } = parseCsvFile(file, text, EVENT_COLUMNS, [], problems)
  const out: EventRow[] = []
  let prevT: number | null = null
  rows.forEach((row, i) => {
    const r = i + 2
    const timeStr = cell(row, col('time'))
    let t = NaN
    try {
      t = clockToS(timeStr)
    } catch {
      problems.push(`${file}:${r}: time: bad time: ${JSON.stringify(timeStr)}`)
    }
    if (Number.isFinite(t)) {
      if (prevT !== null && t < prevT) problems.push(`${file}:${r}: time: out of order`)
      prevT = t
    }
    const type = cell(row, col('type'))
    if (!EVENT_TYPES.includes(type as EventType)) problems.push(`${file}:${r}: type: bad type: ${JSON.stringify(type)}`)
    const value = cell(row, col('value'))
    if (type === 'gear' && value !== '0' && value !== '1') problems.push(`${file}:${r}: value: gear must be 0 or 1: ${JSON.stringify(value)}`)
    if (type === 'flaps' && (value === '' || !Number.isFinite(Number(value)))) problems.push(`${file}:${r}: value: flaps must be a number: ${JSON.stringify(value)}`)
    if (type === 'damage' && value === '') problems.push(`${file}:${r}: value: damage requires a value`)
    const label = cell(row, col('label'))
    const srcCell = cell(row, col('src'))
    let src: string | null = null
    if (srcCell !== '') {
      src = srcCell
      const id = srcCell.split(':')[0]
      if (!sourceIds.has(id)) problems.push(`${file}:${r}: src: unknown source: ${JSON.stringify(id)}`)
    }
    out.push({ t: Number.isFinite(t) ? t : 0, type: type as EventType, value, label, src })
  })
  return out
}

const TRANSCRIPT_COLUMNS = ['time', 'dur', 'speaker', 'to', 'channel', 'lang', 'text', 'original', 'q', 'src'] as const

function parseTranscript(file: string, text: string, speakerIds: ReadonlySet<string>, sourceIds: ReadonlySet<string>, problems: string[]): Line[] {
  const { rows, col } = parseCsvFile(file, text, TRANSCRIPT_COLUMNS, [], problems)
  const out: Line[] = []
  let prevT: number | null = null
  rows.forEach((row, i) => {
    const r = i + 2
    const timeStr = cell(row, col('time'))
    let t = NaN
    try {
      t = clockToS(timeStr)
    } catch {
      problems.push(`${file}:${r}: time: bad time: ${JSON.stringify(timeStr)}`)
    }
    if (Number.isFinite(t)) {
      if (prevT !== null && t < prevT) problems.push(`${file}:${r}: time: out of order`)
      prevT = t
    }
    const speaker = cell(row, col('speaker'))
    if (!speakerIds.has(speaker)) problems.push(`${file}:${r}: speaker: unknown speaker: ${JSON.stringify(speaker)}`)
    const toCell = cell(row, col('to'))
    if (toCell !== '' && !speakerIds.has(toCell)) problems.push(`${file}:${r}: to: unknown speaker: ${JSON.stringify(toCell)}`)
    const channel = cell(row, col('channel'))
    if (!CHANNELS.includes(channel as Channel)) problems.push(`${file}:${r}: channel: bad channel: ${JSON.stringify(channel)}`)
    const lang = cell(row, col('lang'))
    const text = cell(row, col('text'))
    const originalCell = cell(row, col('original'))
    const q = cell(row, col('q'))
    if (q !== 'D' && q !== 'T' && q !== 'U') problems.push(`${file}:${r}: q: bad quality, want D, T or U: ${JSON.stringify(q)}`)
    if (q === 'U' && text !== '[unintelligible]') problems.push(`${file}:${r}: text: q=U requires text '[unintelligible]'`)
    const srcCell = cell(row, col('src'))
    let src: string | null = null
    if (srcCell !== '') {
      src = srcCell
      const id = srcCell.split(':')[0]
      if (!sourceIds.has(id)) problems.push(`${file}:${r}: src: unknown source: ${JSON.stringify(id)}`)
    }
    const durCell = cell(row, col('dur'))
    let dur: number
    if (durCell === '') {
      dur = clamp(1.2 + 0.06 * text.length, 2.5, 8)
    } else {
      dur = Number(durCell)
      if (!Number.isFinite(dur)) {
        problems.push(`${file}:${r}: dur: bad number: ${JSON.stringify(durCell)}`)
        dur = 0
      }
    }
    out.push({
      t: Number.isFinite(t) ? t : 0,
      dur,
      speaker,
      to: toCell === '' ? null : toCell,
      channel: channel as Channel,
      lang,
      text,
      original: originalCell === '' ? null : originalCell,
      q: (q === 'D' || q === 'T' || q === 'U' ? q : 'D') as LineQuality,
      src,
    })
  })
  return out
}

// ---- public API --------------------------------------------------------------------------------------

/**
 * Validates and assembles one scenario package (pure: no fetching). Throws a single ScenarioError listing every
 * problem found across the manifest and the CSV files.
 */
export function parseScenario(files: {
  base: string
  manifest: unknown
  track: string
  events: string | null
  transcript: string | null
  present: Scenario['present']
}): Scenario {
  const problems: string[] = []
  const manifest = parseManifest(files.manifest, problems)
  const sourceIds = new Set(manifest.sources.map((s) => s.id))
  const speakerIds = new Set(Object.keys(manifest.speakers))

  const track = parseTrack('track.csv', files.track, sourceIds, manifest.start, manifest.end, problems)
  const events = files.events !== null ? parseEvents('events.csv', files.events, sourceIds, problems) : []
  const lines = files.transcript !== null ? parseTranscript('transcript.csv', files.transcript, speakerIds, sourceIds, problems) : []

  if (problems.length > 0) throw new ScenarioError(problems)

  return {
    format: 1,
    id: manifest.id,
    title: manifest.title,
    subtitle: manifest.subtitle,
    date: manifest.date,
    utcOffset: manifest.utcOffset,
    clockLabel: manifest.clockLabel,
    start: manifest.start,
    end: manifest.end,
    t0UtcMs: manifest.t0UtcMs,
    note: manifest.note,
    summary: manifest.summary,
    crew: manifest.crew,
    aircraft: manifest.aircraft,
    speakers: manifest.speakers,
    imagery: manifest.imagery,
    ending: manifest.ending,
    audio: manifest.audio,
    sources: manifest.sources,
    track,
    events,
    lines,
    base: files.base,
    present: files.present,
  }
}

/** Validates and reads the manifest alone (no CSVs), for the Scenarios panel's cards. */
export function parseCard(manifest: unknown): ScenarioCard {
  const problems: string[] = []
  const m = parseManifest(manifest, problems)
  if (problems.length > 0) throw new ScenarioError(problems)
  return { id: m.id, title: m.title, subtitle: m.subtitle, date: m.date, clockLabel: m.clockLabel, note: m.note, summary: m.summary, crew: m.crew, aircraft: m.aircraft, start: m.start, end: m.end }
}

/** Vite's dev server answers any unknown path with index.html (200, text/html): no package file is HTML, so that is a miss. */
const isHtml = (res: Response): boolean => (res.headers.get('content-type') ?? '').startsWith('text/html')

async function readTextOrNull(res: Response): Promise<string | null> {
  if (res.status === 404 || (res.ok && isHtml(res))) return null
  if (!res.ok) throw new ScenarioError([`${res.url}:-: -: fetch failed: ${res.status}`])
  return res.text()
}

/** True for a non-empty string: guards a HEAD probe against firing on an absent (`""`) manifest path. */
function nonEmptyString(x: unknown): x is string {
  return isString(x) && x.length > 0
}

/** Fetches and validates one scenario package. `base` ends in '/' (e.g. the app's own URL root). */
export async function loadScenario(base: string, id: string, fetcher: typeof fetch = fetch): Promise<Scenario> {
  const folder = `${base}scenarios/${id}/`

  const manifestRes = await fetcher(`${folder}scenario.json`)
  if (!manifestRes.ok) throw new ScenarioError([`scenario.json:-: -: fetch failed: ${manifestRes.status}`])
  const manifest: unknown = await manifestRes.json()

  // track/events/transcript don't depend on each other or on the manifest, so fetch them together.
  const [trackRes, eventsRes, transcriptRes] = await Promise.all([fetcher(`${folder}track.csv`), fetcher(`${folder}events.csv`), fetcher(`${folder}transcript.csv`)])
  if (!trackRes.ok) throw new ScenarioError([`track.csv:-: -: fetch failed: ${trackRes.status}`])
  const [track, events, transcript] = await Promise.all([trackRes.text(), readTextOrNull(eventsRes), readTextOrNull(transcriptRes)])

  const probe = async (path: string): Promise<boolean> => {
    try {
      const r = await fetcher(`${folder}${path}`, { method: 'HEAD' })
      return r.ok && !isHtml(r)
    } catch {
      return false
    }
  }

  const manifestRecord = isRecord(manifest) ? manifest : {}
  const aircraftRecord = isRecord(manifestRecord.aircraft) ? manifestRecord.aircraft : {}
  const liveryRecord = isRecord(aircraftRecord.livery) ? aircraftRecord.livery : {}
  const audioRecord = isRecord(manifestRecord.audio) ? manifestRecord.audio : {}

  const [body, finLogo, audio] = await Promise.all([
    nonEmptyString(liveryRecord.body) ? probe(liveryRecord.body) : Promise.resolve(false),
    nonEmptyString(liveryRecord.finLogo) ? probe(liveryRecord.finLogo) : Promise.resolve(false),
    nonEmptyString(audioRecord.file) ? probe(audioRecord.file) : Promise.resolve(false),
  ])
  const present = { body, finLogo, audio }

  return parseScenario({ base: folder, manifest, track, events, transcript, present })
}

/** Reads `index.json` and every scenario's manifest, for the Scenarios panel. */
export async function listScenarios(base: string, fetcher: typeof fetch = fetch): Promise<ScenarioCard[]> {
  const idxRes = await fetcher(`${base}scenarios/index.json`)
  if (!idxRes.ok) throw new ScenarioError([`index.json:-: -: fetch failed: ${idxRes.status}`])
  const idx: unknown = await idxRes.json()
  const ids = isRecord(idx) && Array.isArray(idx.scenarios) ? idx.scenarios.filter(isString) : []

  const cards: ScenarioCard[] = []
  for (const id of ids) {
    const res = await fetcher(`${base}scenarios/${id}/scenario.json`)
    if (!res.ok) throw new ScenarioError([`${id}/scenario.json:-: -: fetch failed: ${res.status}`])
    const manifest: unknown = await res.json()
    cards.push(parseCard(manifest))
  }
  return cards
}

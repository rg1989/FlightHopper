// client/scenario/types.ts
// A scenario package (.planning/scenarios-design.md §3) as loadScenario returns it: validated, typed, times resolved.
// Every time is t: seconds since `date` 00:00 in the scenario's local time (clockToS in format.ts); the UTC instant of
// t is t0UtcMs + t·1000.

export type SpeakerKind = 'crew' | 'cabin' | 'atc' | 'company' | 'alert' | 'other'
export type Channel = 'cockpit' | 'radio' | 'company' | 'cabin' | 'interphone' | 'alert'
/** D: the official record verbatim (incl. its official translation) · T: our translation of the official original · U: unintelligible in the record. */
export type LineQuality = 'D' | 'T' | 'U'
/** A: documented value · M: measured from an official chart or figure · R: reconstructed or modelled. */
export type RowQuality = 'A' | 'M' | 'R'
export type EventType = 'phase' | 'mark' | 'gear' | 'flaps' | 'damage'

/** One row of track.csv. Angles in degrees: heading true 0–360, pitch nose-up +, roll right-wing-down +. */
export interface TrackRow {
  t: number
  lat: number
  lon: number
  altFt: number // true altitude above mean sea level
  hdg: number
  pitch: number
  roll: number
  gnd: boolean // wheels on the ground
  iasKt: number | null
  gsKt: number | null // null: derived from the path
  vsFpm: number | null // null: derived from the path
  g: number | null
  windFromDeg: number | null
  windKt: number | null
  epr: number[] | null // null: the file has no epr columns; NaN for an empty cell
  q: RowQuality | null
  src: string | null
}

export interface EventRow {
  t: number
  type: EventType
  value: string // gear: '1' | '0'; flaps: units; damage: part id ('fin'); '' otherwise
  label: string
  src: string | null
}

export interface Line {
  t: number
  dur: number // seconds on screen, resolved (estimated from the text when the cell was empty)
  speaker: string // a key of Scenario.speakers
  to: string | null // a key of Scenario.speakers, or null: to anyone listening
  channel: Channel
  lang: string // the language spoken
  text: string // the English caption
  original: string | null // the words as spoken, when not English
  q: LineQuality
  src: string | null
}

export interface SpeakerDef {
  name: string
  kind: SpeakerKind
}

/** sRGB hex colours; decal paths relative to the scenario folder. */
export interface LiverySpec {
  base: string
  belly?: string
  fin: string
  fin2?: string
  engine?: string
  body?: string // body-wrap decal (design §6.2)
  finLogo?: string // may live in local/ (git-ignored): absent is fine
  title?: string
}

export interface AircraftSpec {
  registration: string
  type: string
  callsign: string
  operator: string
  model: string // id in public/models/manifest.json
  shape?: { halfSpanM?: number }
  livery?: LiverySpec
}

export interface ImagerySpec {
  url: string // {z}/{x}/{y} template
  rect: [west: number, south: number, east: number, north: number] // degrees
  minZoom?: number
  maxZoom?: number
  credit: string
}

export interface EndingSpec {
  fadeFrom: number // t
  darkAt: number // t
  cardAfterS: number
  card: { title: string; lines: string[] }
}

/** File seconds [from, to) play at scenario time at (t). */
export interface AudioClip {
  from: number
  to: number
  at: number
}

export interface AudioSpec {
  file: string // relative to the scenario folder (normally local/)
  source: string // provenance, required
  clips: AudioClip[]
}

export interface SourceRef {
  id: string
  title: string
  url?: string
  note?: string
}

export interface CrewMember {
  role: string
  name: string
  detail?: string
}

export interface Scenario {
  format: 1
  id: string
  title: string
  subtitle: string
  date: string // YYYY-MM-DD, local
  utcOffset: string // ±HH:MM
  clockLabel: string // e.g. JST
  start: number // t where playback starts
  end: number // t of the last data second the timeline reaches
  t0UtcMs: number // UTC ms of `date` 00:00 local
  note: string
  summary: string[]
  crew: CrewMember[]
  aircraft: AircraftSpec
  speakers: Record<string, SpeakerDef>
  imagery: ImagerySpec[]
  ending: EndingSpec | null
  audio: AudioSpec | null
  sources: SourceRef[]
  track: TrackRow[]
  events: EventRow[]
  lines: Line[]
  base: string // URL of the scenario folder, ending in '/'
  present: { body: boolean; finLogo: boolean; audio: boolean } // optional files the loader found
}

/** The manifest alone (scenario.json), for the Scenarios panel's cards: no CSVs fetched. */
export type ScenarioCard = Pick<Scenario, 'id' | 'title' | 'subtitle' | 'date' | 'clockLabel' | 'note' | 'summary' | 'crew' | 'aircraft' | 'start' | 'end'>

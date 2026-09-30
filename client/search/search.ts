// client/search/search.ts
// What the search box (ui/searchBox.ts) finds, and how it ranks it: one list, best first, each row with its kind.
// - Places (public/search/places.json, tools/build-places.ts): airports with scheduled flights, cities of 15 000+ people,
//   countries. Flights: only those in view (the fleet has nothing else), by callsign or ticket number (FZ8455 is
//   FDB8455). Recordings and scenarios: their lists.
// - A row's score is how well it matches (an exact code 100, an exact name 90, a name's initials 85 — "LA" is Los
//   Angeles —, a name's start 75, a word's start 60, all the words' starts 55, inside a word 30; other names such as an
//   airport's city count 0.85 of that) plus how much it matters (a big airport, a big city, a flight in view), plus 30
//   when it was picked before.
// - Past picks (localStorage, ui/searchBox.ts) keep only what a row shows and where it goes: a place still opens from
//   them before the places load; a flight or a recording shows only while it is still there.
import { airlineOf, flightNumbersOf, numberOf } from '../../shared/airlines.ts'
import type { RecordingInfo } from '../../shared/api.ts'
import { countryOf } from '../../shared/icaoCountry.ts'
import type { AircraftInfo } from '../../shared/info.ts'
import type { Places } from '../../shared/places.ts'
import { recordingId } from '../scenario/fromRecording.ts'
import type { ScenarioCard } from '../scenario/types.ts'

export type Kind = 'airport' | 'city' | 'country' | 'flight' | 'recording' | 'scenario'
export const KINDS: readonly Kind[] = ['airport', 'city', 'country', 'flight', 'recording', 'scenario']
const PLACE_KINDS: ReadonlySet<Kind> = new Set(['airport', 'city', 'country'])

/** Where a pick goes: over a place, round a box, to a flight in view (focus it), or a replay (scenario or recording). */
export type Go =
  | { to: 'place'; lat: number; lon: number; heightM: number }
  | { to: 'box'; south: number; north: number; west: number; east: number }
  | { to: 'flight'; hex: string }
  | { to: 'play'; id: string }

/** One result as a row shows it. key is unique across kinds, e.g. 'airport:KLAX'. */
export interface Item {
  key: string
  kind: Kind
  label: string
  sub: string
  iso2: string | null // its country, for a flag
  go: Go
}

/** An Item with what it is matched on, normalized (normalize()), and how much it matters (added to its score). */
export interface Candidate extends Item {
  codes: string[] // airport codes, callsign, registration, hex, type: no spaces
  names: string[]
  inits: string[] // a city's names' initials when they have 2+ words, else '' (parallel to names): airports go by their codes
  alt: string[] // other names: an airport's city, a flight's airline and route
  weight: number
}

export interface Hit extends Item {
  score: number
  recent: boolean
}

/** A past pick: its Item and when (ms). */
export interface Recent extends Item {
  t: number
}

const RECENT_MAX = 20
const RECENT_BONUS = 30
const EMPTY_MAX = 8 // past picks listed in an empty box
const ALT = 0.85

/** Lower case, accents and apostrophes off (Lu’an is one word), anything else but letters and digits a single space; trimmed. */
export function normalize(s: string): string {
  return s.normalize('NFD').replace(/[\p{M}'’ʼ‘`]/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

const initials = (n: string): string => {
  const w = n.split(' ')
  return w.length < 2 ? '' : w.map((x) => x[0]).join('')
}

/** The typed text, prepared once for every candidate: normalized, without spaces, with a space in front, its words. */
interface Query {
  q: string
  qc: string // q without its spaces (codes, initials)
  qs: string // ' ' + q: a word's start
  words: string[] // ' ' + each word, when there are 2+
}

function prepare(typed: string): Query {
  const q = normalize(typed)
  const w = q.split(' ')
  return { q, qc: q.replace(/ /g, ''), qs: ' ' + q, words: w.length > 1 ? w.map((x) => ' ' + x) : [] }
}

function nameScore(Q: Query, n: string, init: string): number {
  const { q, qc } = Q
  if (n === q) return 90
  if (init !== '' && init === qc && qc.length >= 2 && !n.startsWith(q)) return 85 // "la" is L. A., not La Asunción's article
  if (n.startsWith(q)) return 75
  if (n.includes(Q.qs)) return 60
  if (Q.words.length > 0 && Q.words.every((w) => n.startsWith(w.slice(1)) || n.includes(w))) return 55
  if (q.length >= 3 && n.includes(q)) return 30
  return 0
}

function scoreOf(Q: Query, c: Pick<Candidate, 'codes' | 'names' | 'inits' | 'alt'>): number {
  const qc = Q.qc
  let best = 0
  for (const code of c.codes) {
    if (code === qc) return 100
    if (qc.length >= 2 && code.startsWith(qc)) best = 70 // one letter starts too many codes
  }
  for (let i = 0; i < c.names.length; i++) best = Math.max(best, nameScore(Q, c.names[i]!, c.inits[i] ?? ''))
  for (const a of c.alt) best = Math.max(best, nameScore(Q, a, '') * ALT)
  return best
}

/** How well the typed text matches c: 0 not at all, up to 100. */
export function matchScore(typed: string, c: Pick<Candidate, 'codes' | 'names' | 'inits' | 'alt'>): number {
  return scoreOf(prepare(typed), c)
}

const code = (s: string | null | undefined): string => normalize(s ?? '').replace(/ /g, '')

type Texts = { codes?: (string | null | undefined)[]; names?: (string | null | undefined)[]; alt?: (string | null | undefined)[]; inits?: boolean }

function candidate(item: Item, m: Texts, weight: number): Candidate {
  const names = (m.names ?? []).map((n) => normalize(n ?? '')).filter((n) => n !== '')
  return {
    ...item,
    codes: (m.codes ?? []).map(code).filter((c) => c !== ''),
    names,
    inits: names.map((n) => (m.inits === true ? initials(n) : '')),
    alt: (m.alt ?? []).map((n) => normalize(n ?? '')).filter((n) => n !== ''),
    weight,
  }
}

/** 3 900 000 → '3.9 M', 285 316 → '285 k'. */
function people(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : `${Math.round(n / 1e3)} k`
}

/** How much a city matters: 0 at 15 000 people, 20 at 10 M and over. */
const cityWeight = (pop: number): number => Math.min(20, Math.max(0, (Math.log10(Math.max(1, pop)) - 4.2) * 7))
const AIRPORT_WEIGHT = { 1: 3, 2: 8, 3: 10 } as const // under a big city's: "san f" is the city first, then SFO
const AIRPORT_HEIGHT_M = 40_000 // ≈ 25 nm across: the approaches
const cityHeightM = (pop: number): number => (pop >= 1e6 ? 90_000 : pop >= 1e5 ? 50_000 : 30_000)

/** Every place of the file, as candidates. */
export function placeCandidates(p: Places): Candidate[] {
  const countryName = new Map(p.countries.map((c) => [c[0], c[1]]))
  const out: Candidate[] = []
  for (const [iso2, name, aka, south, north, west, east] of p.countries) {
    out.push(candidate({ key: `country:${iso2}`, kind: 'country', label: name, sub: '', iso2, go: { to: 'box', south, north, west, east } },
      { names: [name, ...aka.split(',')] }, 20))
  }
  for (const [ident, iata, name, city, iso2, lat, lon, size] of p.airports) {
    const where = [city, countryName.get(iso2)].filter(Boolean).join(', ')
    out.push(candidate({
      key: `airport:${ident}`, kind: 'airport', label: name, sub: [where, iata, ident].filter(Boolean).join(' · '), iso2,
      go: { to: 'place', lat, lon, heightM: AIRPORT_HEIGHT_M },
    }, { codes: [iata, ident], names: [name], alt: [city] }, AIRPORT_WEIGHT[size]))
  }
  for (const [name, iso2, region, lat, lon, pop] of p.cities) {
    const where = [p.regions[region], countryName.get(iso2)].filter(Boolean).join(', ')
    out.push(candidate({
      key: `city:${name}:${iso2}`, kind: 'city', label: name, sub: [where, pop > 0 ? `${people(pop)} people` : ''].filter(Boolean).join(' · '), iso2,
      go: { to: 'place', lat, lon, heightM: cityHeightM(pop) },
    }, { names: [name], inits: true }, cityWeight(pop)))
  }
  return out
}

const route = (r: string | null): string => (r ?? '').replace(/\s*-\s*/g, '–')

/** 'Fly Dubai 8455' and 'FlyDubai 8455': found by the airline as written or run together ('Elal 290'), the number, or both. */
const withNumber = (airline: string | null, callsign: string | null): string[] =>
  airline === null ? [] : [airline, airline.replace(/ /g, '')].map((a) => [a, numberOf(callsign)].filter(Boolean).join(' '))

/** The flights in view. One without a callsign goes by its hex. */
export function flightCandidates(entries: readonly { hex: string; info: AircraftInfo | null }[]): Candidate[] {
  return entries.map(({ hex, info: i }) => {
    const cs = i?.callsign ?? null
    const airline = airlineOf(cs)
    return candidate({
      key: `flight:${hex}`, kind: 'flight', label: i?.callsign ?? hex.toUpperCase(),
      sub: [airline, i?.typeCode, i?.reg, route(i?.route ?? null)].filter(Boolean).join(' · '), iso2: countryOf(hex)?.iso2 ?? null,
      go: { to: 'flight', hex },
    }, { codes: [i?.callsign, ...flightNumbersOf(cs), i?.reg, hex, i?.typeCode],
      alt: [...withNumber(airline, cs), i?.route] }, 18)
  })
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const day = (y: number, m: number, d: number): string => `${d} ${MONTHS[m]} ${y}`

export function recordingCandidates(list: readonly RecordingInfo[]): Candidate[] {
  return list.map((r) => {
    const at = new Date(r.startedMs)
    return candidate({
      key: `recording:${r.file}`, kind: 'recording', label: r.name ?? r.callsign ?? r.hex.toUpperCase(),
      sub: [r.name === null ? null : r.callsign, route(r.route), day(at.getFullYear(), at.getMonth(), at.getDate())].filter(Boolean).join(' · '),
      iso2: countryOf(r.hex)?.iso2 ?? null, go: { to: 'play', id: recordingId(r.file) },
    }, { codes: [r.callsign, ...flightNumbersOf(r.callsign), r.reg, r.typeCode], names: [r.name],
      alt: [...withNumber(airlineOf(r.callsign), r.callsign), r.route] }, 16)
  })
}

export function scenarioCandidates(list: readonly ScenarioCard[]): Candidate[] {
  return list.map((s) => {
    const [y, m, d] = s.date.split('-').map(Number)
    const when = y && m && d ? day(y, m - 1, d) : s.date
    return candidate({ key: `scenario:${s.id}`, kind: 'scenario', label: s.title, sub: [s.subtitle, when].filter(Boolean).join(' · '), iso2: null, go: { to: 'play', id: s.id } },
      { codes: [s.aircraft.callsign, s.aircraft.registration], names: [s.title], alt: [s.subtitle, s.aircraft.type] }, 16)
  })
}

/**
 * The rows for what was typed: every candidate that matches, and every past pick that still exists (a place, or one of
 * the candidates) and matches, best first; at most `limit`. An empty box lists the past picks that still exist, newest
 * first. A candidate picked before is marked recent, and shows as it is now (a flight's route may have come in).
 */
export function search(typed: string, pools: readonly (readonly Candidate[])[], recents: readonly Recent[], limit = 50): Hit[] {
  const Q = prepare(typed)
  const live = new Map<string, Candidate>()
  for (const pool of pools) for (const c of pool) live.set(c.key, c)
  const recentKeys = new Set(recents.map((r) => r.key))
  const hit = (i: Item, score: number, recent: boolean): Hit => ({ key: i.key, kind: i.kind, label: i.label, sub: i.sub, iso2: i.iso2, go: i.go, score, recent })

  if (Q.q === '') {
    const out: Hit[] = []
    for (const r of recents) {
      const c = live.get(r.key)
      if (c !== undefined || PLACE_KINDS.has(r.kind)) out.push(hit(c ?? r, 0, true))
      if (out.length === EMPTY_MAX) break
    }
    return out
  }
  // Scores first, rows only for the best: one or two letters match thousands of places.
  const found: { i: Item; score: number; recent: boolean }[] = []
  for (const c of live.values()) {
    const m = scoreOf(Q, c)
    if (m === 0) continue
    const recent = recentKeys.has(c.key)
    found.push({ i: c, score: m + c.weight + (recent ? RECENT_BONUS : 0), recent })
  }
  for (const r of recents) {
    if (live.has(r.key) || !PLACE_KINDS.has(r.kind)) continue
    const m = scoreOf(Q, candidate(r, { names: [r.label], alt: [r.sub], inits: r.kind === 'city' }, 0))
    if (m > 0) found.push({ i: r, score: m + RECENT_BONUS, recent: true })
  }
  found.sort((a, b) => b.score - a.score || a.i.label.length - b.i.label.length || a.i.label.localeCompare(b.i.label))
  return found.slice(0, limit).map((f) => hit(f.i, f.score, f.recent))
}

/**
 * Where a label shows what was typed, as [start, end) ranges of it: the text at a word's start (else inside a word, from
 * 3 letters), else each typed word at a word's start, else a city's initials (LA: L… A…). Case and accents do not count.
 */
export function highlight(label: string, typed: string): [number, number][] {
  const Q = prepare(typed)
  if (Q.q === '') return []
  let folded = ''
  const at: number[] = [] // the label's index of each folded character
  let gap = true
  for (let i = 0; i < label.length; i++) {
    const f = normalize(label[i]!)
    if (f !== '') {
      for (const ch of f) {
        folded += ch
        at.push(i)
      }
      gap = false
    } else if (!/['’ʼ‘`]/.test(label[i]!) && !gap) {
      folded += ' '
      at.push(i)
      gap = true
    }
  }
  const range = (start: number, len: number): [number, number] => [at[start]!, at[start + len - 1]! + 1]
  const spaced = ' ' + folded
  const whole = spaced.indexOf(Q.qs)
  if (whole >= 0) return [range(whole, Q.q.length)]
  if (Q.q.length >= 3 && folded.includes(Q.q)) return [range(folded.indexOf(Q.q), Q.q.length)]
  if (Q.words.length > 0) {
    const parts = Q.words.map((w) => spaced.indexOf(w))
    if (parts.every((p) => p >= 0)) return parts.map((p, k) => range(p, Q.words[k]!.length - 1)).sort((a, b) => a[0] - b[0])
  }
  const starts = [...spaced.matchAll(/ \S/g)].map((m) => m.index)
  if (Q.qc.length >= 2 && starts.length === Q.qc.length && starts.every((p) => spaced[p + 1] === Q.qc[starts.indexOf(p)])) return starts.map((p) => range(p, 1))
  return []
}

/** The picks with this one first (once), at most RECENT_MAX; only its Item is kept, with the time. */
export function addRecent(list: readonly Recent[], item: Item, t: number): Recent[] {
  const r: Recent = { key: item.key, kind: item.kind, label: item.label, sub: item.sub, iso2: item.iso2, go: item.go, t }
  return [r, ...list.filter((x) => x.key !== item.key)].slice(0, RECENT_MAX)
}

const isGo = (g: unknown): g is Go => {
  if (typeof g !== 'object' || g === null) return false
  const o = g as Record<string, unknown>
  const num = (...k: string[]): boolean => k.every((x) => typeof o[x] === 'number' && Number.isFinite(o[x]))
  switch (o.to) {
    case 'place': return num('lat', 'lon', 'heightM')
    case 'box': return num('south', 'north', 'west', 'east')
    case 'flight': return typeof o.hex === 'string'
    case 'play': return typeof o.id === 'string'
    default: return false
  }
}

/** The stored picks (JSON); anything malformed is dropped. */
export function readRecents(json: string | null): Recent[] {
  let v: unknown
  try {
    v = JSON.parse(json ?? '[]')
  } catch {
    return []
  }
  if (!Array.isArray(v)) return []
  return v.filter((x): x is Recent => {
    if (typeof x !== 'object' || x === null) return false
    const o = x as Record<string, unknown>
    return typeof o.key === 'string' && KINDS.includes(o.kind as Kind) && typeof o.label === 'string' && typeof o.sub === 'string' &&
      (o.iso2 === null || typeof o.iso2 === 'string') && typeof o.t === 'number' && isGo(o.go)
  }).slice(0, RECENT_MAX)
}

// client/search/search.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RecordingInfo } from '../../shared/api.ts'
import type { AircraftInfo } from '../../shared/info.ts'
import type { Places } from '../../shared/places.ts'
import type { ScenarioCard } from '../scenario/types.ts'
import {
  addRecent, flightCandidates, highlight, matchScore, normalize, placeCandidates, readRecents, recordingCandidates, scenarioCandidates,
  search, type Candidate, type Recent,
} from './search.ts'

const PLACES: Places = {
  countries: [
    ['US', 'United States', 'USA,America', 24.5, 49.4, -124.8, -66.9],
    ['LA', 'Laos', '', 14, 22, 100, 107],
    ['IL', 'Israel', '', 29.558, 33.017, 34.571, 35.532],
  ],
  airports: [
    ['KLAX', 'LAX', 'Los Angeles International Airport', 'Los Angeles', 'US', 33.943, -118.408, 3],
    ['KLGA', 'LGA', 'LaGuardia Airport', 'New York', 'US', 40.777, -73.873, 3],
    ['LLBG', 'TLV', 'Ben Gurion International Airport', 'Tel Aviv', 'IL', 32.011, 34.887, 3],
    ['LLHA', 'HFA', 'Uri Michaeli Haifa International Airport', 'Haifa', 'IL', 32.81, 35.044, 2],
  ],
  regions: ['California', 'New York', 'Tel Aviv'],
  cities: [
    ['New York City', 'US', 1, 40.714, -74.006, 8_804_190],
    ['Lagos', 'NG', -1, 6.454, 3.395, 9_000_000],
    ['Los Angeles', 'US', 0, 34.052, -118.244, 3_898_747],
    ['Tel Aviv', 'IL', 2, 32.081, 34.781, 432_892],
    ['Haifa', 'IL', -1, 32.815, 34.989, 285_316],
    ['Zürich', 'CH', -1, 47.367, 8.55, 341_730],
    ['La Asunción', 'VE', -1, 11.033, -63.863, 35_000],
  ],
}
const places = placeCandidates(PLACES)
const info = (hex: string, callsign: string | null, more: Partial<AircraftInfo> = {}): AircraftInfo => ({
  hex, callsign, reg: null, typeCode: null, category: null, squawk: null, emergency: null, military: false, route: null, ...more,
})
const flights = flightCandidates([
  { hex: '738abc', info: info('738abc', 'ELY315', { reg: '4X-EKA', typeCode: 'B738', route: 'LLBG-LIRF' }) },
  { hex: 'e80123', info: info('e80123', 'LAN705', { typeCode: 'B789' }) },
  { hex: 'aaaaaa', info: null },
])
const top = (q: string, pools: Candidate[][] = [places], recents: Recent[] = []): string[] => search(q, pools, recents).map((h) => h.key)

test('normalize: case, accents and punctuation fold away', () => {
  assert.equal(normalize('  Zürich-Flughafen '), 'zurich flughafen')
  assert.equal(normalize('São Paulo/Guarulhos'), 'sao paulo guarulhos')
  assert.equal(normalize("Zikhron Ya'akov"), 'zikhron yaakov')
  assert.equal(normalize('Lu’an'), 'luan')
})

test('matchScore: exact code, exact name, initials, prefix, word, contains; the others count less', () => {
  const c: Candidate = { ...places.find((p) => p.key === 'airport:KLAX')! }
  const la = places.find((p) => p.key === 'city:Los Angeles:US')!
  assert.equal(matchScore('lax', c), 100)
  assert.equal(matchScore('los angeles', la), 90)
  assert.equal(matchScore('la', la), 85) // L.A.
  assert.equal(matchScore('los', la), 75)
  assert.equal(matchScore('angel', la), 60)
  assert.equal(matchScore('ngele', la), 30)
  assert.equal(matchScore('ng', la), 0) // too short to match inside a word
  assert.equal(matchScore('xyz', la), 0)
  // An airport's city is one of its other names: 0.85 of a name.
  assert.equal(matchScore('new york', places.find((p) => p.key === 'airport:KLGA')!), 76.5)
  assert.equal(matchScore('los angeles', c), 76.5) // over its own name's start (75)
})

test('search: "la" finds Los Angeles first (L.A.), then what starts with it, each with its kind', () => {
  const hits = search('la', [places], [])
  assert.deepEqual(hits.slice(0, 4).map((h) => h.key), ['city:Los Angeles:US', 'country:LA', 'city:Lagos:NG', 'airport:KLGA'])
  assert.ok(hits.some((h) => h.key === 'airport:KLAX'))
  assert.deepEqual(new Set(hits.map((h) => h.kind)), new Set(['city', 'airport', 'country']))
})

test('search: an airport code wins over everything', () => {
  assert.equal(top('lax')[0], 'airport:KLAX')
  assert.equal(top('TLV')[0], 'airport:LLBG')
  assert.equal(top('llbg')[0], 'airport:LLBG')
})

test('search: a city comes before the airport named for it', () => {
  assert.deepEqual(top('tel aviv').slice(0, 2), ['city:Tel Aviv:IL', 'airport:LLBG'])
  assert.deepEqual(top('haifa').slice(0, 2), ['city:Haifa:IL', 'airport:LLHA'])
  assert.deepEqual(top('new york').slice(0, 2), ['city:New York City:US', 'airport:KLGA'])
  assert.equal(top('zurich')[0], 'city:Zürich:CH')
  assert.equal(top('usa')[0], 'country:US')
  assert.deepEqual(top('los an').slice(0, 2), ['city:Los Angeles:US', 'airport:KLAX'])
  assert.equal(top('la a')[0], 'city:La Asunción:VE') // its name, not its initials
  assert.ok(search('la', [places], []).findIndex((h) => h.key === 'city:La Asunción:VE') > 4)
})

test('placeCandidates: what each row says and where it goes', () => {
  const lax = places.find((p) => p.key === 'airport:KLAX')!
  assert.equal(lax.label, 'Los Angeles International Airport')
  assert.equal(lax.sub, 'Los Angeles, United States · LAX · KLAX')
  assert.equal(lax.iso2, 'US')
  assert.deepEqual(lax.go, { to: 'place', lat: 33.943, lon: -118.408, heightM: 40_000 })
  const la = places.find((p) => p.key === 'city:Los Angeles:US')!
  assert.equal(la.sub, 'California, United States · 3.9 M people')
  assert.deepEqual(la.go, { to: 'place', lat: 34.052, lon: -118.244, heightM: 90_000 })
  assert.equal(places.find((p) => p.key === 'city:Haifa:IL')!.sub, 'Israel · 285 k people')
  const us = places.find((p) => p.key === 'country:US')!
  assert.deepEqual(us.go, { to: 'box', south: 24.5, north: 49.4, west: -124.8, east: -66.9 })
})

test('flights in view: callsign, registration, type and airline match; a flight without info goes by its hex', () => {
  assert.deepEqual(top('ely3', [flights]), ['flight:738abc'])
  assert.deepEqual(top('4xeka', [flights]), ['flight:738abc'])
  assert.deepEqual(top('4X-EKA', [flights]), ['flight:738abc'])
  assert.deepEqual(top('b789', [flights]), ['flight:e80123'])
  assert.deepEqual(top('aaaa', [flights]), ['flight:aaaaaa'])
  const ely = flights[0]!
  assert.equal(ely.label, 'ELY315')
  assert.equal(ely.sub, 'El Al Israel Airlines · B738 · 4X-EKA · LLBG–LIRF')
  assert.deepEqual(ely.go, { to: 'flight', hex: '738abc' })
  // "la" reaches the LATAM flight too, among the places.
  assert.ok(top('la', [places, flights]).includes('flight:e80123'))
})

test('recordings and scenarios: by name, callsign, route or title; they play', () => {
  const rec: RecordingInfo = {
    file: '2026-09-30/002932Z-ITY810-4cae1d.jsonl', name: 'Rome evening', hex: '4cae1d', callsign: 'ITY810', reg: 'EI-IMX',
    typeCode: 'A20N', category: 'A3', military: false, route: 'LIRF-LLBG', source: 'adsbfi', startedMs: Date.UTC(2026, 8, 30, 12, 0),
    firstMs: null, lastMs: null, samples: 10, ended: null, active: false,
  }
  const recs = recordingCandidates([rec])
  assert.deepEqual(top('rome', [recs]), ['recording:2026-09-30/002932Z-ITY810-4cae1d.jsonl'])
  assert.deepEqual(top('ity8', [recs]), ['recording:2026-09-30/002932Z-ITY810-4cae1d.jsonl'])
  assert.equal(recs[0]!.label, 'Rome evening')
  assert.match(recs[0]!.sub, /^ITY810 · LIRF–LLBG · 30 Sep 2026$/)
  assert.deepEqual(recs[0]!.go, { to: 'play', id: 'rec:2026-09-30/002932Z-ITY810-4cae1d' })
  const card = { id: 'jal123', title: 'Japan Air Lines Flight 123', subtitle: 'Tokyo Haneda → Osaka Itami', date: '1985-08-12',
    aircraft: { callsign: 'JAL123', registration: 'JA8119', type: 'B747SR-46' } } as unknown as ScenarioCard
  const scn = scenarioCandidates([card])
  assert.deepEqual(top('japan', [scn]), ['scenario:jal123'])
  assert.deepEqual(top('ja8119', [scn]), ['scenario:jal123'])
  assert.deepEqual(top('haneda', [scn]), ['scenario:jal123'])
  assert.equal(scn[0]!.sub, 'Tokyo Haneda → Osaka Itami · 12 Aug 1985')
  assert.deepEqual(scn[0]!.go, { to: 'play', id: 'jal123' })
})

test('recents: a past pick that matches is marked and comes first among equals', () => {
  const lagos = places.find((p) => p.key === 'city:Lagos:NG')!
  const recents = addRecent([], lagos, 1000)
  const hits = search('la', [places], recents)
  assert.equal(hits[0]!.key, 'city:Lagos:NG')
  assert.equal(hits[0]!.recent, true)
  assert.equal(hits.find((h) => h.key === 'city:Los Angeles:US')!.recent, false)
})

test('recents: an empty box lists them, newest first; a flight out of view or a deleted recording is left out', () => {
  const lagos = places.find((p) => p.key === 'city:Lagos:NG')!
  let r = addRecent([], lagos, 1)
  r = addRecent(r, flights[0]!, 2)
  r = addRecent(r, { key: 'flight:gone00', kind: 'flight', label: 'GONE1', sub: '', iso2: null, go: { to: 'flight', hex: 'gone00' } }, 3)
  r = addRecent(r, { key: 'recording:x.jsonl', kind: 'recording', label: 'X', sub: '', iso2: null, go: { to: 'play', id: 'rec:x' } }, 4)
  const hits = search('', [flights], r)
  assert.deepEqual(hits.map((h) => h.key), ['flight:738abc', 'city:Lagos:NG'])
  assert.ok(hits.every((h) => h.recent))
  // Before the places load, a past place still matches from what was kept of it.
  assert.deepEqual(search('lag', [], r).map((h) => h.key), ['city:Lagos:NG'])
})

test('addRecent: one entry per result, newest first, at most 20; readRecents drops anything malformed', () => {
  let r: Recent[] = []
  for (let i = 0; i < 25; i++) r = addRecent(r, { ...flights[0]!, key: `flight:${i}` }, i)
  assert.equal(r.length, 20)
  assert.equal(r[0]!.key, 'flight:24')
  r = addRecent(r, { ...flights[0]!, key: 'flight:10' }, 99)
  assert.equal(r[0]!.key, 'flight:10')
  assert.equal(r.filter((x) => x.key === 'flight:10').length, 1)
  assert.equal((r[0] as unknown as Record<string, unknown>).codes, undefined) // only what a row shows and where it goes
  assert.deepEqual(readRecents(JSON.stringify(r)), r)
  assert.deepEqual(readRecents('not json'), [])
  assert.deepEqual(readRecents(JSON.stringify([{ key: 'x' }, 5, null, r[0]])), [r[0]])
  assert.deepEqual(readRecents(null), [])
})

test('highlight: the typed text in the label, whatever its case and accents; a city initials', () => {
  assert.deepEqual(highlight('Los Angeles', 'la'), [[0, 1], [4, 5]])
  assert.deepEqual(highlight('Los Angeles', 'los an'), [[0, 6]])
  assert.deepEqual(highlight('Zürich', 'zur'), [[0, 3]])
  assert.deepEqual(highlight('Tel Aviv', 'AVIV'), [[4, 8]])
  assert.deepEqual(highlight('LaGuardia Airport', 'lag'), [[0, 3]])
  assert.deepEqual(highlight('London Heathrow Airport', 'heathrow london'), [[0, 6], [7, 15]])
  assert.deepEqual(highlight('Lu’an', 'luan'), [[0, 5]])
  assert.deepEqual(highlight('Rome', 'xyz'), [])
  assert.deepEqual(highlight('Rome', ''), [])
})

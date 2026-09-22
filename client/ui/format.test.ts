// client/ui/format.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { StatusBrief } from '../../shared/api.ts'
import type { RenderState } from '../types.ts'
import { NOT_FOR_NAVIGATION, attributionLines, bannerText, hudFields, hudTitle } from './format.ts'

const live: StatusBrief = { source: 'adsblol', degraded: null, cellPeriodP95S: 2, chasePeriodP95S: 1 }

const state = (o: Partial<RenderState> = {}): RenderState => ({
  hex: 'a1b2c3', lat: 37.6, lon: -122.4, hM: 700, headingDeg: 284.4, pitchDeg: -2, rollDeg: 0,
  gsKt: 146.2, trackDeg: 281.7, altBaroFt: 2175, vsFpm: -742, mode: 'interp', altSource: 'geom',
  onGround: false, ageS: -1.3, quality: 'adsb2', callsign: 'UAL123', typeCode: 'B738', ...o,
})

const field = (s: RenderState, label: string, status = live) => hudFields(s, status).find((f) => f.label === label)!
const tags = (s: RenderState) => hudFields(s, live).map((f) => f.tag)

test('interpolating: seven fields in a fixed order; sample values observed, computed values derived', () => {
  assert.deepEqual(hudFields(state(), live), [
    { label: 'GS', value: '146 kt', tag: 'observed' },
    { label: 'ALT', value: '2,175 ft baro', tag: 'observed' },
    { label: 'VS', value: '-740 fpm', tag: 'derived' },
    { label: 'TRK', value: '282°', tag: 'observed' },
    { label: 'HDG', value: '284°', tag: 'derived' },
    { label: 'AGE', value: '0.0 s', tag: 'derived' },
    { label: 'SRC', value: 'ADS-B v2', tag: 'observed' },
  ])
})

test('extrapolating: every value is derived', () => {
  assert.deepEqual(tags(state({ mode: 'extrap', ageS: 3.4 })), Array(7).fill('derived'))
  assert.equal(field(state({ mode: 'extrap', ageS: 3.4 }), 'AGE').value, '3.4 s')
})

test('stale: mode stale, or older than 10 s even before the track gives up', () => {
  assert.deepEqual(tags(state({ mode: 'stale', ageS: 9 })), Array(7).fill('stale'))
  assert.deepEqual(tags(state({ mode: 'extrap', ageS: 10.5 })), Array(7).fill('stale'))
  assert.deepEqual(tags(state({ mode: 'extrap', ageS: 10 })), Array(7).fill('derived'))
  assert.equal(field(state({ mode: 'stale', ageS: 14.2 }), 'AGE').value, '14.2 s')
})

test('missing values are unknown and shown as a dash, never as zero, even when stale', () => {
  for (const mode of ['interp', 'stale'] as const) {
    const s = state({ mode, ageS: mode === 'stale' ? 12 : -1, gsKt: null, trackDeg: null, vsFpm: null, altBaroFt: null })
    for (const label of ['GS', 'ALT', 'VS', 'TRK']) assert.deepEqual(field(s, label), { label, value: '—', tag: 'unknown' })
  }
  assert.deepEqual(field(state({ headingDeg: Number.NaN }), 'HDG'), { label: 'HDG', value: '—', tag: 'unknown' })
  assert.deepEqual(field(state({ ageS: Number.NaN }), 'AGE'), { label: 'AGE', value: '—', tag: 'unknown' })
})

test('ALT is pressure altitude, labelled baro; "alt est." when the drawn height is not GNSS; GND on the ground', () => {
  assert.equal(field(state({ altSource: 'baro-qnh' }), 'ALT').value, '2,175 ft baro · alt est.')
  assert.equal(field(state({ altSource: 'baro-bias', altBaroFt: 37000 }), 'ALT').value, '37,000 ft baro · alt est.')
  assert.equal(field(state({ altBaroFt: -120.4 }), 'ALT').value, '-120 ft baro')
  assert.deepEqual(field(state({ onGround: true, altBaroFt: null }), 'ALT'), { label: 'ALT', value: 'GND', tag: 'observed' })
})

test('VS: signed, rounded to 10 fpm, no negative zero', () => {
  assert.equal(field(state({ vsFpm: 1500 }), 'VS').value, '+1,500 fpm')
  assert.equal(field(state({ vsFpm: 1234 }), 'VS').value, '+1,230 fpm')
  assert.equal(field(state({ vsFpm: 4 }), 'VS').value, '0 fpm')
  assert.equal(field(state({ vsFpm: -3 }), 'VS').value, '0 fpm')
  assert.equal(field(state({ vsFpm: -2980 }), 'VS').value, '-2,980 fpm')
})

test('angles: three digits, wrapped into 000–359', () => {
  assert.equal(field(state({ trackDeg: 359.6 }), 'TRK').value, '000°')
  assert.equal(field(state({ trackDeg: 5 }), 'TRK').value, '005°')
  assert.equal(field(state({ headingDeg: -5 }), 'HDG').value, '355°')
  assert.equal(field(state({ headingDeg: 720.2 }), 'HDG').value, '000°')
})

test('SRC names the position quality and flags replayed (not live) data', () => {
  assert.equal(field(state({ quality: 'adsb01' }), 'SRC').value, 'ADS-B v0-1')
  assert.equal(field(state({ quality: 'mlat' }), 'SRC').value, 'MLAT')
  assert.equal(field(state({ quality: 'other' }), 'SRC').value, 'other')
  assert.equal(field(state(), 'SRC', { ...live, source: 'readsb' }).value, 'ADS-B v2')
  assert.equal(field(state(), 'SRC', { ...live, source: 'replay' }).value, 'ADS-B v2 (replay)')
})

test('no aircraft selected: no fields', () => {
  assert.deepEqual(hudFields(null, live), [])
})

test('hudTitle: callsign · type · hex, skipping unknowns', () => {
  assert.equal(hudTitle(state()), 'UAL123 · B738 · a1b2c3')
  assert.equal(hudTitle(state({ callsign: null, typeCode: null })), 'a1b2c3')
})

test('banner: provider problems first, with the exact wording', () => {
  assert.equal(bannerText({ ...live, degraded: 'blocked' }, null), 'Live data blocked by provider — showing nothing new')
  assert.equal(bannerText({ ...live, degraded: 'rate-limited' }, state()), 'Provider rate-limited us — updates slowed')
  assert.equal(bannerText({ ...live, degraded: 'upstream-down' }, state({ mode: 'stale', ageS: 30 })), 'Live data unavailable')
})

test('banner: selected aircraft stale → signal lost, whole seconds', () => {
  assert.equal(bannerText(live, state({ mode: 'stale', ageS: 14.4 })), 'Signal lost 14s ago')
  assert.equal(bannerText(live, state({ mode: 'stale', ageS: 9.6 })), 'Signal lost 10s ago')
  assert.equal(bannerText(live, state({ mode: 'extrap', ageS: 10.6 })), 'Signal lost 11s ago')
  assert.equal(bannerText(live, state({ mode: 'stale', ageS: Number.NaN })), 'Signal lost')
})

test('banner: extrapolating → predicting; otherwise nothing', () => {
  assert.equal(bannerText(live, state({ mode: 'extrap', ageS: 2 })), 'Predicting (no fresh data)')
  assert.equal(bannerText(live, state()), null)
  assert.equal(bannerText(live, null), null)
})

test('attribution always ends up with the not-for-navigation line, once', () => {
  const given = ['Aircraft data © adsb.lol contributors (ODbL)', 'Airports: OurAirports']
  assert.deepEqual(attributionLines(given), [...given, NOT_FOR_NAVIGATION])
  assert.equal(given.length, 2)
  assert.deepEqual(attributionLines(['x', 'Toy only, NOT FOR NAVIGATION']), ['x', 'Toy only, NOT FOR NAVIGATION'])
  assert.match(NOT_FOR_NAVIGATION, /Not for navigation/)
})

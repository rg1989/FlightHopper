// shared/alerts.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ongoing, pushBody, pushTitle, what, who, type AlertEvent } from './alerts.ts'

const ev = (o: Partial<AlertEvent> = {}): AlertEvent => ({
  id: '89645a-1000', hex: '89645a', kind: 'squawk', callsign: 'FDB1073', reg: 'A6-FNC', type: 'B38M', squawk: '7700',
  emergency: null, drop: null, lat: 29.95, lon: 38.12, altFt: 30_000, openedMs: 1000, lastMs: 61_000, late: false, quiet: false, ...o,
})

test('who: the callsign, else the registration, else the address; then the type', () => {
  assert.equal(who(ev()), 'FDB1073 · B38M')
  assert.equal(who(ev({ callsign: null })), 'A6-FNC · B38M')
  assert.equal(who(ev({ callsign: null, reg: null, type: null })), '89645A')
})

test('what: the status, else the meaning of the squawk, then the code; a fall first', () => {
  assert.equal(what(ev()), 'Emergency · 7700')
  assert.equal(what(ev({ squawk: '7600' })), 'Radio failure · 7600')
  assert.equal(what(ev({ squawk: '7500', emergency: 'unlawful' })), 'Unlawful interference · 7500')
  assert.equal(what(ev({ kind: 'status', squawk: null, emergency: 'minfuel' })), 'Minimum fuel')
  assert.equal(what(ev({ squawk: '2000' })), 'Squawk · 2000')
  const fell = ev({ kind: 'descent', squawk: null, drop: { fromFt: 35_000, toFt: 22_700, overS: 110 } })
  assert.equal(what(fell), 'Fell 12,300 ft in 1 min 50 s from FL350')
  const dive = ev({ kind: 'dive', drop: { fromFt: 34_678, toFt: 30_045, overS: 30 } })
  assert.equal(what(dive), 'Dived 4,633 ft in 30 s, then lost · 7700')
  assert.equal(what(ev({ kind: 'descent', squawk: null, drop: { fromFt: 30_000, toFt: 19_000, overS: 120 } })), 'Fell 11,000 ft in 2 min from FL300')
})

test('ongoing: seen with its cause in the last 2 min, and not found after the fact', () => {
  assert.equal(ongoing(ev(), 61_000 + 119_000), true)
  assert.equal(ongoing(ev(), 61_000 + 120_000), false)
  assert.equal(ongoing(ev({ late: true }), 61_000), false)
})

test('the push: an ASCII title (an HTTP header) and where and when in the text', () => {
  assert.equal(pushTitle(ev()), 'Emergency - 7700: FDB1073 - B38M')
  assert.match(pushTitle(ev()), /^[\x20-\x7e]+$/)
  assert.equal(pushBody(ev({ lastMs: Date.UTC(2026, 8, 30, 5, 31) })), 'FL300 at 29.95 N 38.12 E, 05:31 UTC')
  assert.equal(pushBody(ev({ lat: -1.5, lon: -70.25, altFt: null, late: true, lastMs: Date.UTC(2026, 8, 30, 5, 31) })), 'at 1.50 S 70.25 W, 05:31 UTC (found in the half-hour file)')
  assert.equal(pushBody(ev({ lat: null, lon: null, altFt: null, lastMs: Date.UTC(2026, 8, 30, 5, 31) })), 'position unknown, 05:31 UTC')
})

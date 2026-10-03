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
  const fell = ev({ kind: 'descent', squawk: null, drop: { fromFt: 35_000, toFt: 22_700, overS: 110, lost: false } })
  assert.equal(what(fell), 'Fell 12,300 ft in 1 min 50 s from FL350')
  const dive = ev({ kind: 'dive', drop: { fromFt: 34_678, toFt: 30_045, overS: 30, lost: true } })
  assert.equal(what(dive), 'Dived 4,633 ft in 30 s, then lost · 7700')
  assert.equal(what(ev({ kind: 'descent', squawk: null, drop: { fromFt: 30_000, toFt: 19_000, overS: 120, lost: false } })), 'Fell 11,000 ft in 2 min from FL300')
})

test('what: a lost fall reads as a dive, whatever opened the event (a squawk event that a dive was added to)', () => {
  const e = ev({ kind: 'squawk', squawk: '7500', drop: { fromFt: 34_678, toFt: 30_045, overS: 30, lost: true } })
  assert.equal(what(e), 'Dived 4,633 ft in 30 s, then lost · 7500')
})

test('what: a fall that was not lost reads as a fall, even in an event that a dive opened', () => {
  const e = ev({ kind: 'dive', squawk: null, drop: { fromFt: 34_678, toFt: 30_045, overS: 30, lost: false } })
  assert.equal(what(e), 'Fell 4,633 ft in 30 s from FL347')
})

test('what: a squawk that is not in the table reads as a squawk, never as an inherited name', () => {
  for (const key of ['constructor', 'toString', '__proto__']) assert.equal(what(ev({ squawk: key })), `Squawk · ${key}`)
})

test('what: a status that is not in the table is shown as it is, never as an inherited name', () => {
  for (const key of ['constructor', 'toString', '__proto__']) assert.equal(what(ev({ kind: 'status', squawk: null, emergency: key })), key)
})

test('ongoing: seen with its cause in the last 2 min, and not found after the fact', () => {
  assert.equal(ongoing(ev(), 61_000 + 119_000), true)
  assert.equal(ongoing(ev(), 61_000 + 120_000), false)
  assert.equal(ongoing(ev({ late: true }), 61_000), false)
})

const AT = Date.UTC(2026, 8, 30, 5, 31)

test('the push: an ASCII title (an HTTP header) and where and when in the text', () => {
  assert.equal(pushTitle(ev()), 'Emergency - 7700: FDB1073 - B38M')
  assert.match(pushTitle(ev()), /^[\x20-\x7e]+$/)
  assert.equal(pushBody(ev({ lastMs: AT })), 'FL300 at 29.95 N 38.12 E, 05:31 UTC')
  assert.equal(pushBody(ev({ lat: -1.5, lon: -70.25, altFt: null, late: true, lastMs: AT })), 'at 1.50 S 70.25 W, 05:31 UTC (found after the fact)')
  assert.equal(pushBody(ev({ lat: null, lon: null, altFt: null, lastMs: AT })), 'position unknown, 05:31 UTC')
})

test('pushTitle: a callsign cannot bring a line break or a letter outside ASCII into the header', () => {
  const title = pushTitle(ev({ callsign: 'FD\u00c4B\r\n10\u044773' })) // U+00C4 (A with a diaeresis), a CR LF, U+0447 (Cyrillic che)
  assert.equal(title, 'Emergency - 7700: FDB1073 - B38M')
  assert.match(title, /^[\x20-\x7e]+$/)
})

test('pushBody: a level without a position is set off by a comma', () => {
  assert.equal(pushBody(ev({ lat: null, lon: null, lastMs: AT })), 'FL300, position unknown, 05:31 UTC')
})

test('pushBody: a flight level is never negative (a field below sea level)', () => {
  assert.equal(pushBody(ev({ altFt: -300, lastMs: AT })), 'FL000 at 29.95 N 38.12 E, 05:31 UTC')
  assert.equal(pushBody(ev({ altFt: -1_400, lastMs: AT })), 'FL000 at 29.95 N 38.12 E, 05:31 UTC')
  assert.equal(pushBody(ev({ altFt: 0, lastMs: AT })), 'FL000 at 29.95 N 38.12 E, 05:31 UTC')
})

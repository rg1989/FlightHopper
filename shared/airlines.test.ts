// shared/airlines.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AIRLINES_CREDIT, airlineOf } from './airlines.ts'

test('airlineOf: ICAO designator + flight number → airline name', () => {
  assert.equal(airlineOf('ELY5450'), 'El Al Israel Airlines')
  assert.equal(airlineOf('UAE954'), 'Emirates')
  assert.equal(airlineOf('BAW1'), 'British Airways')
  assert.equal(airlineOf('EZY84TL'), 'easyJet')
  assert.equal(airlineOf('SWR1234'), 'Swiss International Air Lines')
})

test('airlineOf: null and empty → null', () => {
  assert.equal(airlineOf(null), null)
  assert.equal(airlineOf(''), null)
  assert.equal(airlineOf('   '), null)
})

test('airlineOf: registrations used as callsigns → null', () => {
  for (const reg of ['N123AB', 'N1', 'GABCD', 'DAIBC', 'HBJVA', 'CGABC', '4XEKA', 'RA89001', 'JA01XJ', 'B1234']) {
    assert.equal(airlineOf(reg), null, reg)
  }
})

test('airlineOf: readsb padding and lower case are tolerated', () => {
  assert.equal(airlineOf('ELY5450 '), 'El Al Israel Airlines')
  assert.equal(airlineOf('uae954'), 'Emirates')
})

test('airlineOf: no flight number, letter-first suffix, too long or unknown designator → null', () => {
  for (const cs of ['ELY', 'ELYA12', 'ELY 12', 'ELY123456', 'XXX123', 'EL5450']) assert.equal(airlineOf(cs), null, cs)
})

test('credit line names the source and its licence', () => {
  assert.match(AIRLINES_CREDIT, /OpenFlights/)
  assert.match(AIRLINES_CREDIT, /ODbL/)
})

test('airlines.json: sorted 3-letter keys, trimmed non-empty names, about a thousand entries', () => {
  const names: Record<string, string> = JSON.parse(readFileSync(new URL('./airlines.json', import.meta.url), 'utf8'))
  const keys = Object.keys(names)
  assert.ok(keys.length >= 1000, `${keys.length} entries`)
  assert.deepEqual(keys, [...keys].sort())
  for (const k of keys) {
    assert.match(k, /^[A-Z]{3}$/)
    assert.ok(names[k] !== '' && names[k] === names[k].trim(), `${k}: ${JSON.stringify(names[k])}`)
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeAdsblol } from './readsb.ts'
import { classify, isHidden, toSample } from './sample.ts'
import type { ReadsbAircraft } from './types.ts'

const snap = normalizeAdsblol(readFileSync(new URL('../data/fixtures/golden/adsblol-point-ksfo.json', import.meta.url), 'utf8'))
const byHex = (h: string): ReadsbAircraft => snap.aircraft.find((a) => a.hex === h)!

test('tMs = upstream now − seen_pos + offset (never receipt time)', () => {
  const ac = byHex('71bd79')
  const s = toSample(ac, snap.nowMs, 250, 999)!
  assert.equal(s.tMs, snap.nowMs - Math.round(ac.seen_pos! * 1000) + 250)
  assert.equal(s.rxMs, 999)
  assert.equal(s.altBaroFt, 40000)
  assert.equal(s.onGround, false)
  assert.equal(s.quality, 'adsb2')
})

test('ground aircraft: onGround, no baro altitude', () => {
  const s = toSample(byHex('a0b88d'), snap.nowMs, 0, 0)!
  assert.equal(s.onGround, true)
  assert.equal(s.altBaroFt, null)
})

test('geoid N attached, rounded to 0.1 m (KSFO area ≈ −32 m)', () => {
  const s = toSample(byHex('a0b88d'), snap.nowMs, 0, 0)!
  assert.ok(s.nM < -31 && s.nM > -33, `nM=${s.nM}`)
  assert.equal(Math.round(s.nM * 10) / 10, s.nM)
})

test('non-ICAO hex kept and lowercased; strings trimmed', () => {
  const s = toSample(byHex('~a330e6'), snap.nowMs, 0, 0)!
  assert.equal(s.hex, '~a330e6')
  assert.equal(toSample({ ...byHex('71bd79'), hex: 'ABC123', flight: 'UAL1    ' }, 0, 0, 0)!.hex, 'abc123')
  assert.equal(toSample({ ...byHex('71bd79'), flight: 'UAL1    ' }, 0, 0, 0)!.callsign, 'UAL1')
  for (const junk of ['@@@@@@@@', '00000000', '   ', '@@ ']) assert.equal(toSample({ ...byHex('71bd79'), flight: junk }, 0, 0, 0)!.callsign, null, junk)
  assert.equal(toSample({ ...byHex('71bd79'), flight: 'AB@C1   ' }, 0, 0, 0)!.callsign, 'ABC1')
})

test('no position → null', () => {
  assert.equal(toSample({ hex: 'abc123', alt_baro: 1000 }, 0, 0, 0), null)
  assert.equal(toSample({ hex: 'abc123', lat: 1, lon: 1 }, 0, 0, 0), null)
})

test('classify', () => {
  assert.equal(classify({ hex: 'a', type: 'adsb_icao', version: 2 }), 'adsb2')
  assert.equal(classify({ hex: 'a', type: 'adsb_icao', version: 0 }), 'adsb01')
  assert.equal(classify({ hex: 'a', type: 'adsr_icao' }), 'adsb01')
  assert.equal(classify({ hex: 'a', type: 'mlat' }), 'mlat')
  assert.equal(classify({ hex: 'a', type: 'adsb_icao', version: 2, mlat: ['lat', 'lon'] }), 'mlat')
  assert.equal(classify({ hex: 'a', type: 'adsb_icao', version: 2, mlat: ['track'] }), 'adsb2')
  assert.equal(classify({ hex: 'a', type: 'tisb_icao' }), 'other')
  assert.equal(classify({ hex: 'a', type: 'mode_s' }), 'other')
})

test('PIA (4) and LADD (8) are hidden; military (1) is not', () => {
  assert.equal(isHidden(byHex('000001')), true)   // dbFlags 8 in the golden file
  assert.equal(isHidden({ hex: 'a', dbFlags: 4 }), true)
  assert.equal(isHidden({ hex: 'a', dbFlags: 1 }), false)
  assert.equal(isHidden({ hex: 'a' }), false)
})

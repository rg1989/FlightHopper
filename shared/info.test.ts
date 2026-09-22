import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sameInfo, toInfo } from './info.ts'
import { normalizeAdsblol } from './readsb.ts'

const snap = normalizeAdsblol(readFileSync(new URL('../data/fixtures/golden/adsblol-point-ksfo.json', import.meta.url), 'utf8'))

test('toInfo: identity fields trimmed, hex lower-cased, emergency none → null, route passed through', () => {
  const ac = { ...snap.aircraft[0], hex: '71BD79', flight: 'UAL1  ', r: 'N12345', t: 'B738', squawk: '7433', category: 'A3', emergency: 'none', dbFlags: 1 }
  const i = toInfo(ac, 'KSFO-KLAX')
  assert.deepEqual(i, { hex: '71bd79', callsign: 'UAL1', reg: 'N12345', typeCode: 'B738', category: 'A3', squawk: '7433', emergency: null, military: true, route: 'KSFO-KLAX' })
})

test('toInfo: missing fields are null, never undefined', () => {
  const i = toInfo({ hex: 'abc123' })
  assert.deepEqual(Object.values(i).filter((v) => v === undefined), [])
  assert.equal(i.route, null)
  assert.equal(i.military, false)
})

test('sameInfo: any shown field change counts', () => {
  const a = toInfo({ hex: 'abc123', squawk: '1000' })
  assert.equal(sameInfo(a, { ...a }), true)
  assert.equal(sameInfo(a, { ...a, squawk: '7700' }), false)
  assert.equal(sameInfo(a, { ...a, route: 'LLBG-LOWI' }), false)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeAdsblol, normalizeReadsb } from './readsb.ts'

const golden = (f: string): string => readFileSync(new URL(`../data/fixtures/golden/${f}`, import.meta.url), 'utf8')

test('adsb.lol envelope: now is ms, list key is ac', () => {
  const s = normalizeAdsblol(golden('adsblol-point-ksfo.json'))
  assert.equal(s.nowMs, 1790081633500)
  assert.equal(s.aircraft.length, 7)
  assert.equal(s.aircraft[0].hex, '71bd79')
})

test('adsb.lol ac:null means no aircraft', () => {
  assert.deepEqual(normalizeAdsblol('{"ac":null,"now":5,"msg":"No error"}'), { nowMs: 5, aircraft: [] })
})

test('readsb envelope: now is seconds, list key is aircraft', () => {
  const s = normalizeReadsb(golden('readsb-circle.json'))
  assert.equal(s.nowMs, 1790081633500)
  assert.equal(s.aircraft.length, 7)
})

test('same aircraft either way: the flip changes only the envelope', () => {
  assert.deepEqual(normalizeReadsb(golden('readsb-circle.json')), normalizeAdsblol(golden('adsblol-point-ksfo.json')))
})

test('wrong envelope is rejected, not silently empty', () => {
  assert.throws(() => normalizeAdsblol(golden('readsb-circle.json')))
  assert.throws(() => normalizeReadsb('{"ac":[],"now":1}'), /aircraft/)
  assert.throws(() => normalizeAdsblol('not json'))
})

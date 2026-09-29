// tools/liveries/survey.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { combos, tally } from './survey.ts'
import type { Seen } from './survey.ts'

test('survey: airframes by hex, flights by day and callsign, operator from the callsign prefix', () => {
  const seen = new Map<string, Seen>()
  tally(seen, { hex: 'a', t: 'B738', r: '4X-EKA', flight: 'ELY315  ' }, '2026-09-28')
  tally(seen, { hex: 'a', t: 'B738', flight: 'ELY315' }, '2026-09-28') // the same flight again
  tally(seen, { hex: 'a', t: 'B738', flight: 'ELY316' }, '2026-09-28')
  tally(seen, { hex: 'b', t: 'B738', flight: 'ELY1' }, '2026-09-29')
  tally(seen, { hex: 'c', t: 'C172', flight: '4XCAB' }, '2026-09-29') // no airline prefix
  tally(seen, { hex: 'd', flight: 'ELY2' }, '2026-09-29') // no type: skipped
  const c = combos(seen)
  assert.deepEqual(c.map((x) => [x.type, x.op, x.airframes, x.flights]), [['B738', 'ELY', 2, 3], ['C172', null, 1, 1]])
  assert.deepEqual(c[0].frames[0], { hex: 'a', reg: '4X-EKA', flights: 2 })
})

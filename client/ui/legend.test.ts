// client/ui/legend.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { altitudeColor } from '../scene/altitudeColor.ts'
import { LEGEND_TICKS_FT, legendGradient, tickLabel } from './legend.ts'

test('ticks: 0, 1 000, 2 000, 4 000, 6 000, 8 000, 10 000, 20 000, 30 000, 40 000+ ft', () => {
  assert.deepEqual([...LEGEND_TICKS_FT], [0, 1_000, 2_000, 4_000, 6_000, 8_000, 10_000, 20_000, 30_000, 40_000])
  assert.deepEqual(
    LEGEND_TICKS_FT.map(tickLabel),
    ['0', '1k', '2k', '4k', '6k', '8k', '10k', '20k', '30k', '40k+'],
  )
})

test('gradient: evenly spaced ticks, each tick in its altitude colour, sampled in between', () => {
  const g = legendGradient()
  assert.ok(g.startsWith(`linear-gradient(to right, ${altitudeColor(0, false)} 0.00%`), g.slice(0, 80))
  assert.ok(g.endsWith(`${altitudeColor(40_000, false)} 100.00%)`))
  const n = LEGEND_TICKS_FT.length - 1
  LEGEND_TICKS_FT.forEach((ft, i) => assert.ok(g.includes(`${altitudeColor(ft, false)} ${((i / n) * 100).toFixed(2)}%`), `${ft} ft at tick ${i}`))
  assert.ok(g.includes(`${altitudeColor(15_000, false)} ${((6.5 / n) * 100).toFixed(2)}%`), 'half-way between 10 000 and 20 000')
  assert.ok(g.split('%').length - 1 > 60, 'enough stops for the HSL path')
})

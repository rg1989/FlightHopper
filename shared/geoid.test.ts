import { test } from 'node:test'
import assert from 'node:assert/strict'
import { egm96ToEllipsoid } from 'egm96-universal'
import { geoidN } from './geoid.ts'

// Pinned EGM96 values. Reference column: GeographicLib egm96-5 (review workflow wf_a83bb071-6da, TD1).
// This test is the datum gate's unit half: it catches sign, unit and omission errors that A2 could not.
const CASES: [string, number, number, number, number][] = [
  // name, lat, lon, expected (this library), GeographicLib reference
  ['origin', 0, 0, 17.16, 17.16],
  ['KSFO 28R end', 37.613538, -122.35716, -32.26, -32.18],
  ['LOWI 08 end', 47.2588005065918, 11.330900192260742, 48.46, 48.45],
  ['LLBG 12 end', 32.01470184326172, 34.86579895019531, 19.6, 19.6],
]

for (const [name, lat, lon, expected, reference] of CASES) {
  test(`N at ${name}`, () => {
    const n = geoidN(lat, lon)
    assert.ok(Math.abs(n - expected) < 0.05, `${name}: N=${n}, expected ${expected}`)
    assert.ok(Math.abs(n - reference) < 0.3, `${name}: N=${n}, reference ${reference}`)
  })
}

test('sign convention: h = H + N', () => {
  const [lat, lon, H] = [37.613538, -122.35716, 100]
  assert.ok(Math.abs(egm96ToEllipsoid(lat, lon, H) - (H + geoidN(lat, lon))) < 1e-9)
})

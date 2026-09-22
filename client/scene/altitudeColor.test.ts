// client/scene/altitudeColor.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Color } from 'cesium'
import { ALTITUDE_RGBA, COLOR_COUNT, GROUND_INDEX, UNKNOWN_INDEX, altitudeColor, altitudeIndex, altitudeRgba, hslAt } from './altitudeColor.ts'

/** 'rgb(r, g, b)' → [r, g, b] 0–255 */
function rgbOf(css: string): [number, number, number] {
  const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(css)
  assert.ok(m, `not an rgb() string: ${css}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** Hue in degrees of an 'rgb()' string (the usual max/min formula). */
function hueOf(css: string): number {
  const [r, g, b] = rgbOf(css).map((v) => v / 255)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (d === 0) return NaN
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}

test('the named anchors: orange, yellow, green, cyan, blue, violet, magenta', () => {
  const band = (ft: number, lo: number, hi: number, name: string): void => {
    const h = hueOf(altitudeColor(ft, false))
    assert.ok(h >= lo && h <= hi, `${ft} ft should be ${name} (hue ${lo}–${hi}°), got ${h.toFixed(1)}°`)
  }
  band(0, 15, 35, 'orange')
  band(2_000, 45, 60, 'yellow')
  band(6_000, 100, 135, 'green')
  band(12_000, 170, 195, 'cyan')
  band(20_000, 210, 235, 'blue')
  band(30_000, 255, 280, 'violet')
  band(40_000, 290, 320, 'magenta')
})

test('hue rises smoothly with altitude and saturates at 40,000 ft', () => {
  let prev = -1
  for (let ft = 0; ft <= 40_000; ft += 100) {
    const h = hslAt(ft)[0]
    assert.ok(h >= prev, `hue must not fall: ${ft} ft → ${h}° after ${prev}°`)
    assert.ok(h - prev < 5 || prev < 0, `no jumps: ${ft} ft → ${h}° after ${prev}°`)
    prev = h
  }
  assert.equal(altitudeColor(45_000, false), altitudeColor(40_000, false))
  assert.equal(altitudeColor(60_000, false), altitudeColor(40_000, false))
  assert.deepEqual(hslAt(50_000), hslAt(40_000))
})

test('below sea level reads as 0 ft; the CSS colour is the rounded 100 ft bucket', () => {
  assert.equal(altitudeColor(-150, false), altitudeColor(0, false))
  assert.equal(altitudeColor(1_240, false), altitudeColor(1_200, false))
  assert.equal(altitudeColor(1_260, false), altitudeColor(1_300, false))
  assert.notEqual(altitudeColor(1_200, false), altitudeColor(1_300, false))
})

test('on the ground → grey whatever the altitude; unknown altitude → a lighter grey', () => {
  const [r, g, b] = rgbOf(altitudeColor(null, true))
  assert.ok(r === g && g === b, 'ground is a neutral grey')
  assert.equal(altitudeColor(35_000, true), altitudeColor(null, true))
  assert.equal(altitudeColor(0, true), altitudeColor(null, true))
  const [ur, ug, ub] = rgbOf(altitudeColor(null, false))
  assert.ok(ur === ug && ug === ub, 'unknown is a neutral grey')
  assert.ok(ur > r, 'unknown is lighter than ground')
  assert.equal(altitudeColor(Number.NaN, false), altitudeColor(null, false))
})

test('altitudeIndex: 100 ft buckets, then ground, then unknown', () => {
  assert.equal(altitudeIndex(0, false), 0)
  assert.equal(altitudeIndex(-50, false), 0)
  assert.equal(altitudeIndex(149, false), 1)
  assert.equal(altitudeIndex(40_000, false), 400)
  assert.equal(altitudeIndex(99_999, false), 400)
  assert.equal(altitudeIndex(12_000, true), GROUND_INDEX)
  assert.equal(altitudeIndex(null, false), UNKNOWN_INDEX)
  assert.equal(GROUND_INDEX, 401)
  assert.equal(UNKNOWN_INDEX, 402)
  assert.equal(COLOR_COUNT, 403)
  assert.equal(ALTITUDE_RGBA.length, COLOR_COUNT * 4)
})

test('altitudeRgba writes the same colour as the CSS string into the object it is given, allocating nothing', () => {
  const out = new Color()
  for (const [ft, gnd] of [[0, false], [7_300, false], [40_000, false], [null, true], [null, false]] as const) {
    const ret = altitudeRgba(ft, gnd, out)
    assert.equal(ret, out, 'returns the same object')
    const [r, g, b] = rgbOf(altitudeColor(ft, gnd))
    assert.ok(Math.abs(out.red - r / 255) < 1e-6 && Math.abs(out.green - g / 255) < 1e-6 && Math.abs(out.blue - b / 255) < 1e-6)
    assert.equal(out.alpha, 1)
  }
})

test('Cesium parses every CSS colour to the same RGBA as the table', () => {
  const cases: [number | null, boolean, number][] = [[null, true, GROUND_INDEX], [null, false, UNKNOWN_INDEX]]
  for (let i = 0; i <= 400; i += 7) cases.push([i * 100, false, i])
  for (const [ft, gnd, i] of cases) {
    const css = altitudeColor(ft, gnd)
    const c = Color.fromCssColorString(css)
    assert.ok(Math.abs(c.red - ALTITUDE_RGBA[i * 4]) < 1e-6, css)
    assert.ok(Math.abs(c.green - ALTITUDE_RGBA[i * 4 + 1]) < 1e-6, css)
    assert.ok(Math.abs(c.blue - ALTITUDE_RGBA[i * 4 + 2]) < 1e-6, css)
  }
})

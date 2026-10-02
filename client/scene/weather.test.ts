// client/scene/weather.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Metar } from '../../shared/wx.ts'
import { DEFAULT_UNITS, type Units } from '../ui/units.ts'
import { MARKER_PX, inRing, lookKey, lookOf, statusText, viewBox, windArrow } from './weather.ts'

const metric: Units = { alt: 'm', speed: 'kmh', vs: 'ms' }
const wind = (wdir: number | null, wspd: number, cat: Metar['cat'] = 'VFR'): Pick<Metar, 'cat' | 'wdir' | 'wspd'> => ({ cat, wdir, wspd })

test('viewBox: whole degrees outward; null when wider than 40°, crossing the antimeridian, or no view', () => {
  assert.equal(viewBox({ west: 34.2, south: 29.5, east: 35.9, north: 33.1 }), '29,34,34,36')
  assert.equal(viewBox({ west: -10, south: 20, east: 31, north: 30 }), null)
  assert.equal(viewBox({ west: 170, south: 0, east: -170, north: 10 }), null)
  assert.equal(viewBox(null), null)
})

test('point-in-area', () => {
  const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]]
  assert.equal(inRing(sq, 5, 5), true)
  assert.equal(inRing(sq, 15, 5), false)
})

test('statusText: radar time, airports, hazard areas, a note; singular for one; zoom in when no airports are asked for', () => {
  const s = { radarTime: '18:50', zoomedOut: false, airports: 6, areas: 3, note: '' }
  assert.equal(statusText(s), 'Radar 18:50 · 6 airports · 3 hazard areas')
  assert.equal(statusText({ ...s, airports: 1, areas: 1 }), 'Radar 18:50 · 1 airport · 1 hazard area')
  assert.equal(statusText({ ...s, airports: 0, areas: 0 }), 'Radar 18:50 · 0 airports · 0 hazard areas')
  assert.equal(statusText({ ...s, radarTime: '', zoomedOut: true }), 'zoom in for airports · 3 hazard areas')
  assert.equal(statusText({ ...s, note: 'some weather unavailable' }), 'Radar 18:50 · 6 airports · 3 hazard areas · some weather unavailable')
})

test('lookOf and lookKey: colour, the speed in the frame\'s unit, and the arrow where the wind goes to, to 10°', () => {
  assert.deepEqual(lookOf(wind(250, 5), DEFAULT_UNITS), { cat: 'VFR', shown: 5, dir: 70 }) // from WSW blows towards ENE
  assert.equal(lookKey(lookOf(wind(250, 5), DEFAULT_UNITS)), 'wx:VFR:5:70')
  assert.equal(lookOf(wind(254, 5), DEFAULT_UNITS).dir, 70) // near directions share a texture
  assert.equal(lookOf(wind(256, 5), DEFAULT_UNITS).dir, 80)
  assert.equal(lookOf(wind(175, 5), DEFAULT_UNITS).dir, 0) // 355 + 5 → 360 reads 0
  assert.equal(lookOf(wind(180, 5), DEFAULT_UNITS).dir, 0)
  assert.equal(lookOf(wind(360, 5), DEFAULT_UNITS).dir, 180)
  assert.equal(lookKey(lookOf(wind(null, 3, 'IFR'), DEFAULT_UNITS)), 'wx:IFR:3:-') // variable: no arrow
  assert.equal(lookKey(lookOf(wind(250, 0), DEFAULT_UNITS)), 'wx:VFR:0:-') // calm: no arrow
  assert.equal(lookKey(lookOf(wind(250, 1), DEFAULT_UNITS)), 'wx:VFR:1:70') // 1 kt is the least that has one
  assert.equal(lookKey(lookOf(wind(90, 12, null), DEFAULT_UNITS)), 'wx:null:12:270')
  assert.equal(lookOf(wind(250, 5), metric).shown, 9) // km/h
  assert.equal(lookOf(wind(250, 5), { ...DEFAULT_UNITS, speed: 'mph' }).shown, 6)
  assert.equal(lookOf(wind(250, 5), { ...DEFAULT_UNITS, speed: 'kt+kmh' }).shown, 5) // the first unit
  assert.notEqual(lookKey(lookOf(wind(250, 5), DEFAULT_UNITS)), lookKey(lookOf(wind(250, 5), metric))) // a unit change is a new look
})

test('windArrow: from r 12 to 16 and a head from r 15.5 (half-width 4.5) to the tip at r 21.5, pointing clockwise from north', () => {
  const close = (got: number[][], want: number[][]): void => {
    assert.equal(got.length, want.length)
    got.forEach((p, i) => assert.ok(Math.hypot(p[0] - want[i][0], p[1] - want[i][1]) < 1e-9, `${JSON.stringify(got)} vs ${JSON.stringify(want)}`))
  }
  const [n, e, s, w] = [0, 90, 180, 270].map(windArrow)
  close(n.shaft, [[0, -12], [0, -16]])
  close(n.head, [[-4.5, -15.5], [0, -21.5], [4.5, -15.5]])
  close(e.shaft, [[12, 0], [16, 0]])
  close(e.head, [[15.5, -4.5], [21.5, 0], [15.5, 4.5]])
  close(s.shaft, [[0, 12], [0, 16]])
  close(s.head, [[4.5, 15.5], [0, 21.5], [-4.5, 15.5]])
  close(w.shaft, [[-12, 0], [-16, 0]])
  close(w.head, [[-15.5, 4.5], [-21.5, 0], [-15.5, -4.5]])
  const d = windArrow(70) // wind from 250°: right and a little up
  assert.ok(d.head[1][0] > 20 && d.head[1][1] < 0 && d.head[1][1] > -10, JSON.stringify(d.head[1]))
  for (const deg of [0, 33, 70, 135, 250, 340]) {
    const a = windArrow(deg)
    assert.ok(Math.abs(Math.hypot(...a.head[1]) - 21.5) < 1e-9)
    assert.ok(Math.abs(Math.hypot(...a.shaft[0]) - 12) < 1e-9 && Math.abs(Math.hypot(...a.shaft[1]) - 16) < 1e-9)
    assert.ok(Math.abs(Math.hypot(...a.head[0]) - Math.hypot(15.5, 4.5)) < 1e-9)
  }
})

test('windArrow: in every direction the arrow and its 5 px halo stay inside the marker\'s canvas', () => {
  for (let deg = 0; deg < 360; deg++) {
    const a = windArrow(deg)
    for (const [x, y] of [...a.shaft, ...a.head]) assert.ok(Math.max(Math.abs(x), Math.abs(y)) + 2.5 <= MARKER_PX / 2 + 1e-9, `${deg}°: ${x}, ${y}`)
  }
})

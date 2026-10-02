// client/scene/weather.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Metar, Sigmet } from '../../shared/wx.ts'
import { DEFAULT_UNITS, type Units } from '../ui/units.ts'
import { CATEGORY_COLOR, inRing, lookKey, lookOf, metarCard, sigmetCards, sigmetColor, statusText, viewBox, windArrow } from './weather.ts'

// Node has no DOM: just enough of one for the card builders, which only create elements, set their class, text and custom
// properties, and append children (elements or text).
class El {
  tag: string
  className = ''
  textContent = ''
  children: (El | string)[] = []
  vars: Record<string, string> = {}
  style = { setProperty: (k: string, v: string): void => void (this.vars[k] = v) }
  constructor(tag: string) {
    this.tag = tag
  }
  append(...cs: (El | string)[]): void {
    this.children.push(...cs)
  }
}
Object.assign(globalThis, { document: { createElement: (tag: string) => new El(tag) } })
const els = (e: El): El[] => e.children.filter((c): c is El => typeof c !== 'string')
const text = (e: El | string): string => (typeof e === 'string' ? e : e.textContent + e.children.map(text).join(''))
const asEl = (nodes: unknown[]): El[] => nodes as El[]
/** A <dl> as its [term, definition] pairs. */
const pairs = (dl: El): string[][] => els(dl).reduce<string[][]>((out, e) => (e.tag === 'dt' ? [...out, [text(e)]] : (out.at(-1)!.push(text(e)), out)), [])

const metric: Units = { alt: 'm', speed: 'kmh', vs: 'ms' }
const wind = (wdir: number | null, wspd: number, cat: Metar['cat'] = 'VFR'): Pick<Metar, 'cat' | 'wdir' | 'wspd'> => ({ cat, wdir, wspd })

test('viewBox: whole degrees outward; null when wider than 40°, crossing the antimeridian, or no view', () => {
  assert.equal(viewBox({ west: 34.2, south: 29.5, east: 35.9, north: 33.1 }), '29,34,34,36')
  assert.equal(viewBox({ west: -10, south: 20, east: 31, north: 30 }), null)
  assert.equal(viewBox({ west: 170, south: 0, east: -170, north: 10 }), null)
  assert.equal(viewBox(null), null)
})

test('sigmet colour and point-in-area', () => {
  assert.equal(sigmetColor('TS'), '#ff5a5a')
  assert.equal(sigmetColor('ICE'), '#4fd1ff')
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

test('windArrow: from r 12 to 19 and a head from r 17 (half-width 4.5) to the tip at r 23, pointing clockwise from north', () => {
  const close = (got: number[][], want: number[][]): void => {
    assert.equal(got.length, want.length)
    got.forEach((p, i) => assert.ok(Math.hypot(p[0] - want[i][0], p[1] - want[i][1]) < 1e-9, `${JSON.stringify(got)} vs ${JSON.stringify(want)}`))
  }
  const [n, e, s, w] = [0, 90, 180, 270].map(windArrow)
  close(n.shaft, [[0, -12], [0, -19]])
  close(n.head, [[-4.5, -17], [0, -23], [4.5, -17]])
  close(e.shaft, [[12, 0], [19, 0]])
  close(e.head, [[17, -4.5], [23, 0], [17, 4.5]])
  close(s.shaft, [[0, 12], [0, 19]])
  close(s.head, [[4.5, 17], [0, 23], [-4.5, 17]])
  close(w.shaft, [[-12, 0], [-19, 0]])
  close(w.head, [[-17, 4.5], [-23, 0], [-17, -4.5]])
  const d = windArrow(70) // wind from 250°: right and a little up
  assert.ok(d.head[1][0] > 20 && d.head[1][1] < 0 && d.head[1][1] > -10, JSON.stringify(d.head[1]))
  for (const deg of [0, 33, 70, 135, 250, 340]) {
    const a = windArrow(deg)
    assert.ok(Math.abs(Math.hypot(...a.head[1]) - 23) < 1e-9)
    assert.ok(Math.abs(Math.hypot(...a.shaft[0]) - 12) < 1e-9 && Math.abs(Math.hypot(...a.shaft[1]) - 19) < 1e-9)
    assert.ok(Math.abs(Math.hypot(...a.head[0]) - Math.hypot(17, 4.5)) < 1e-9)
  }
})

const llha: Metar = {
  id: 'LLHA', name: 'Haifa Intl, HA, IL', lat: 32.81, lon: 35.04, obsMs: new Date(2026, 9, 2, 18, 50).getTime(), cat: 'VFR', wdir: 250, wspd: 5,
  wgst: null, visKm: 9.656, visPlus: true, tempC: 26, dewC: 16, qnhHpa: 1014, wx: null, clouds: [{ cover: 'FEW', baseFt: 4500, type: null }],
  vertVisFt: null, raw: 'METAR LLHA 021550Z AUTO 25005KT 9999 FEW045 26/16 Q1014',
}

test('metarCard: name, id and time, the condition with its code, then the rows that have something to say', () => {
  const [head, cond, rows, ...more] = asEl(metarCard(llha, DEFAULT_UNITS))
  assert.equal(more.length, 0)
  assert.equal(head.className, 'fh-wx-h')
  assert.deepEqual(els(head).map((e) => [e.className, text(e)]), [['fh-wx-name', 'Haifa International'], ['fh-wx-id', 'LLHA'], ['fh-wx-t fh-num', '18:50']])
  assert.equal(cond.className, 'fh-wx-cond')
  assert.equal(cond.vars['--c'], CATEGORY_COLOR.VFR)
  assert.equal(text(cond), 'Good conditions VFR')
  assert.deepEqual(els(cond).map((e) => [e.className, text(e)]), [['fh-wx-code', 'VFR']])
  assert.equal(rows.tag, 'dl')
  assert.equal(rows.className, 'fh-wx-rows')
  assert.deepEqual(pairs(rows), [
    ['Wind', 'From WSW, 5 kt'], ['Visibility', '10 km or more'], ['Cloud', 'Few at 4,500 ft'],
    ['Temperature', '26 °C, dew point 16 °C'], ['Pressure', '1014 hPa'],
  ])
})

test('metarCard: weather and the frame\'s units; a row with nothing to say, no category and no time are left out', () => {
  const wet: Metar = { ...llha, wx: '-RA BR', wgst: 15, wspd: 8, visKm: 2.4, visPlus: false, clouds: [{ cover: 'BKN', baseFt: 1500, type: 'CB' }] }
  assert.deepEqual(pairs(asEl(metarCard(wet, metric))[2]), [
    ['Wind', 'From WSW, 15 km/h, gusting 28 km/h'], ['Visibility', '2.4 km'], ['Cloud', 'Broken at 450 m (thunderclouds)'],
    ['Weather', 'Light rain, mist'], ['Temperature', '26 °C, dew point 16 °C'], ['Pressure', '1014 hPa'],
  ])
  const bare: Metar = { ...llha, name: null, obsMs: null, cat: null, visKm: null, tempC: null, dewC: null, qnhHpa: null, clouds: [] }
  const [head, rows, ...more] = asEl(metarCard(bare, DEFAULT_UNITS))
  assert.equal(more.length, 0)
  assert.deepEqual(els(head).map((e) => [e.className, text(e)]), [['fh-wx-name', 'LLHA']]) // no name: the id is the name, said once; no time
  assert.equal(rows.className, 'fh-wx-rows') // no condition line: the rows follow the head
  assert.deepEqual(pairs(rows), [['Wind', 'From WSW, 5 kt'], ['Cloud', 'Not reported']])
})

test('sigmetCards: one block per area, a hairline between, the hazard in its colour, the height row only when it is known', () => {
  const until = new Date(2026, 9, 2, 21, 0).toISOString()
  const ts: Sigmet = { hazard: 'TS', qualifier: 'EMBD', base: null, top: 35000, until, raw: 'LLLL SIGMET …', rings: [] }
  const turb: Sigmet = { hazard: 'TURB', qualifier: 'SEV', base: 0, top: null, until: '', raw: '', rings: [] }
  const one = asEl(sigmetCards([ts], DEFAULT_UNITS))
  assert.deepEqual(one.map((e) => e.className), ['fh-wx-h', 'fh-wx-rows'])
  const [name, until1] = els(one[0])
  assert.deepEqual([name.className, text(name), name.vars['--c']], ['fh-wx-name fh-wx-hazard', 'Embedded thunderstorms', sigmetColor('TS')])
  assert.deepEqual([until1.className, text(until1)], ['fh-wx-t fh-num', 'until 21:00'])
  assert.deepEqual(pairs(one[1]), [['Height', 'Up to 35,000 ft']])
  assert.ok(!text(one[0]).includes('LLLL')) // the raw report is not shown

  const two = asEl(sigmetCards([ts, turb], metric))
  assert.deepEqual(two.map((e) => e.className), ['fh-wx-h', 'fh-wx-rows', 'fh-wx-sep', 'fh-wx-h'])
  assert.deepEqual(pairs(two[1]), [['Height', 'Up to 10,650 m']])
  assert.deepEqual(els(two[3]).map((e) => [e.className, text(e)]), [['fh-wx-name fh-wx-hazard', 'Severe turbulence']]) // no top, no until: no height row, no time
  assert.equal(els(two[3])[0].vars['--c'], sigmetColor('TURB'))
})

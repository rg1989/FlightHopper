// client/scene/wxCard.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Metar, Sigmet } from '../../shared/wx.ts'
import { DEFAULT_UNITS, type Units } from '../ui/units.ts'
import { metarCard, sigmetCards } from './wxCard.ts'
import { CATEGORY_COLOR, sigmetColor } from './wxText.ts'

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

const llha: Metar = {
  id: 'LLHA', name: 'Haifa Intl, HA, IL', lat: 32.81, lon: 35.04, elevM: 3, obsMs: new Date(2026, 9, 2, 18, 50).getTime(), cat: 'VFR', wdir: 250, wspd: 5,
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
  const nsw: Metar = { ...llha, wx: 'NSW' } // a code with no words: no Weather row, and no letters in its place
  assert.deepEqual(pairs(asEl(metarCard(nsw, DEFAULT_UNITS))[2]).map(([term]) => term), ['Wind', 'Visibility', 'Cloud', 'Temperature', 'Pressure'])
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

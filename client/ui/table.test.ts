// client/ui/table.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import type { AircraftInfo } from '../../shared/info.ts'
import type { FleetEntry } from '../types.ts'

// table.ts imports table.css for Vite. Node cannot load CSS, so this test loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})
const { cellText, filterRows, isEmergencySquawk, sortRows, windowRange } = await import('./table.ts')

const info = (hex: string, o: Partial<AircraftInfo> = {}): AircraftInfo => ({
  hex, callsign: null, reg: null, typeCode: null, category: null, squawk: null, emergency: null, military: false, route: null, ...o,
})
const entry = (hex: string, o: Partial<FleetEntry> = {}, i: Partial<AircraftInfo> | null = {}): FleetEntry => ({
  hex, lat: 32, lon: 34.8, hM: 1000, altFt: 3000, onGround: false, trackDeg: 90, gsKt: 250, vsFpm: 0, ageS: 1, staleS: 60, quality: 'adsb2',
  info: i === null ? null : info(hex, i), ...o,
})
const hexes = (rows: readonly FleetEntry[]): string[] => rows.map((e) => e.hex)

test('sortRows: callsign ascending, no callsign last, equal keys by hex; desc reverses but keeps unknowns last', () => {
  const rows = [ // ties arrive out of hex order, so a stable sort alone would not pass
    entry('000005', {}, { callsign: 'UAL1' }),
    entry('000004', {}, { callsign: null }),
    entry('000002', {}, { callsign: 'ELY5' }),
    entry('000003', {}, { callsign: 'UAL1' }),
    entry('000001', {}, null), // no info at all
  ]
  assert.deepEqual(hexes(sortRows(rows, 'callsign', false)), ['000002', '000003', '000005', '000001', '000004'])
  assert.deepEqual(hexes(sortRows(rows, 'callsign', true)), ['000003', '000005', '000002', '000001', '000004'])
})

test('sortRows: altitude puts ground below every airborne altitude and unknown last, both directions', () => {
  const rows = [
    entry('a1', { altFt: 12000 }),
    entry('a2', { altFt: null, onGround: true }),
    entry('a3', { altFt: -150 }), // below sea level (e.g. the Dead Sea): still airborne
    entry('a4', { altFt: null }),
    entry('a5', { altFt: 41000 }),
    entry('a6', { altFt: Number.NaN }),
  ]
  assert.deepEqual(hexes(sortRows(rows, 'alt', false)), ['a2', 'a3', 'a1', 'a5', 'a4', 'a6'])
  assert.deepEqual(hexes(sortRows(rows, 'alt', true)), ['a5', 'a1', 'a3', 'a2', 'a4', 'a6'])
})

test('sortRows: speed, squawk, route, type and hex keys', () => {
  const rows = [
    entry('c', { gsKt: 480 }, { squawk: '7700', route: 'OTHH-LROP', typeCode: 'B789' }),
    entry('a', { gsKt: null }, { squawk: '1000', route: null, typeCode: 'A320' }),
    entry('b', { gsKt: 12.4 }, { squawk: null, route: 'LLBG-LOWI', typeCode: null }),
  ]
  assert.deepEqual(hexes(sortRows(rows, 'speed', false)), ['b', 'c', 'a'])
  assert.deepEqual(hexes(sortRows(rows, 'speed', true)), ['c', 'b', 'a'])
  assert.deepEqual(hexes(sortRows(rows, 'squawk', false)), ['a', 'c', 'b'])
  assert.deepEqual(hexes(sortRows(rows, 'route', false)), ['b', 'c', 'a'])
  assert.deepEqual(hexes(sortRows(rows, 'type', true)), ['c', 'a', 'b'])
  assert.deepEqual(hexes(sortRows(rows, 'hex', false)), ['a', 'b', 'c'])
  assert.deepEqual(hexes(sortRows(rows, 'hex', true)), ['c', 'b', 'a'])
})

test('sortRows is pure: returns a new array and leaves its input as it was', () => {
  const rows = [entry('b'), entry('a')]
  const out = sortRows(rows, 'hex', false)
  assert.notEqual(out, rows)
  assert.deepEqual(hexes(rows), ['b', 'a'])
  assert.deepEqual(hexes(out), ['a', 'b'])
  assert.equal(out[0], rows[1]) // same objects, new order
})

test('filterRows: case-insensitive substring of callsign, hex, registration, type or squawk', () => {
  const rows = [
    entry('738a1b', {}, { callsign: 'ELY001', reg: '4X-EKA', typeCode: 'B738', squawk: '4501', route: 'LLBG-KJFK' }),
    entry('4ca9f2', {}, { callsign: 'RYR12AB', reg: 'EI-DWF', typeCode: 'B738', squawk: '7700' }),
    entry('a0c0de', {}, null),
  ]
  assert.deepEqual(hexes(filterRows(rows, 'ely')), ['738a1b'])
  assert.deepEqual(hexes(filterRows(rows, '4CA9')), ['4ca9f2'])
  assert.deepEqual(hexes(filterRows(rows, 'ei-d')), ['4ca9f2'])
  assert.deepEqual(hexes(filterRows(rows, 'b738')), ['738a1b', '4ca9f2'])
  assert.deepEqual(hexes(filterRows(rows, '7700')), ['4ca9f2'])
  assert.deepEqual(hexes(filterRows(rows, ' c0de ')), ['a0c0de']) // trimmed; no info: the hex still matches
  assert.deepEqual(hexes(filterRows(rows, 'kjfk')), []) // the route is not searched
})

test('filterRows: an empty or blank query keeps every row, in a new array', () => {
  const rows = [entry('a'), entry('b')]
  for (const q of ['', '   ']) {
    const out = filterRows(rows, q)
    assert.notEqual(out, rows)
    assert.deepEqual(hexes(out), ['a', 'b'])
  }
})

test('cellText: flag, callsign (upper-case hex when none), route with spaced dashes, type, squawk', () => {
  const e = entry('738a1b', {}, { callsign: 'ELY001', route: 'LLBG-LOWI', typeCode: 'B738', squawk: '7700' })
  const flagOf = (hex: string): string => (hex.startsWith('738') ? '🇮🇱' : '')
  assert.equal(cellText(e, 'hex', flagOf), '🇮🇱')
  assert.equal(cellText(e, 'hex'), '') // no flagOf given
  assert.equal(cellText(e, 'callsign'), 'ELY001')
  assert.equal(cellText(entry('abc123', {}, null), 'callsign'), 'ABC123')
  assert.equal(cellText(e, 'route'), 'LLBG - LOWI')
  assert.equal(cellText(entry('x', {}, { route: 'OTP-VIE-DOH' }), 'route'), 'OTP - VIE - DOH')
  assert.equal(cellText(e, 'type'), 'B738')
  assert.equal(cellText(e, 'squawk'), '7700')
  assert.deepEqual((['route', 'type', 'squawk'] as const).map((k) => cellText(entry('x', {}, null), k)), ['', '', ''])
})

test('cellText: altitude in ft with thousands separators, ground, and ▲/▼ only beyond ±300 fpm; speed in whole knots', () => {
  assert.equal(cellText(entry('x', { altFt: 35000, vsFpm: 0 }), 'alt'), '35,000')
  assert.equal(cellText(entry('x', { altFt: 2375.4, vsFpm: 301 }), 'alt'), '2,375 ▲')
  assert.equal(cellText(entry('x', { altFt: 2375, vsFpm: 300 }), 'alt'), '2,375')
  assert.equal(cellText(entry('x', { altFt: 2375, vsFpm: -300 }), 'alt'), '2,375')
  assert.equal(cellText(entry('x', { altFt: 2375, vsFpm: -1200 }), 'alt'), '2,375 ▼')
  assert.equal(cellText(entry('x', { altFt: 1100, vsFpm: null }), 'alt'), '1,100')
  assert.equal(cellText(entry('x', { altFt: -150, vsFpm: 0 }), 'alt'), '-150')
  assert.equal(cellText(entry('x', { altFt: null, onGround: true, vsFpm: 0 }), 'alt'), 'ground')
  assert.equal(cellText(entry('x', { altFt: null }), 'alt'), '')
  assert.equal(cellText(entry('x', { gsKt: 451.6 }), 'speed'), '452')
  assert.equal(cellText(entry('x', { gsKt: null }), 'speed'), '')
})

test('isEmergencySquawk: 7500, 7600 and 7700 only', () => {
  assert.deepEqual(['7500', '7600', '7700', '7000', '1200', null].map(isEmergencySquawk), [true, true, true, false, false, false])
})

test('windowRange: the rows in the viewport plus overscan, clamped to the list', () => {
  assert.deepEqual(windowRange(0, 440, 22, 5000, 8), { first: 0, end: 28 }) // 20 visible + 8 below
  assert.deepEqual(windowRange(2200, 440, 22, 5000, 8), { first: 92, end: 128 }) // rows 100…119 visible
  assert.deepEqual(windowRange(2211, 440, 22, 5000, 8), { first: 92, end: 129 }) // half-row offset: 21 partly visible
  assert.deepEqual(windowRange(109_560, 440, 22, 5000, 8), { first: 4972, end: 5000 })
  assert.deepEqual(windowRange(0, 440, 22, 3, 8), { first: 0, end: 3 })
  assert.deepEqual(windowRange(0, 440, 22, 0, 8), { first: 0, end: 0 })
  assert.deepEqual(windowRange(500, 0, 22, 100, 8), { first: 14, end: 31 }) // not laid out yet: overscan only
})

test('sortRows and filterRows stay cheap at 12,000 rows (tar1090 worldwide scale)', () => {
  const rows: FleetEntry[] = []
  for (let i = 0; i < 12_000; i++) {
    const hex = (i * 2654435761 % 0xffffff).toString(16).padStart(6, '0')
    rows.push(entry(hex, { altFt: (i * 37) % 45000, gsKt: (i * 13) % 520 }, { callsign: i % 50 === 0 ? null : `ABC${(i * 7919) % 10000}` }))
  }
  for (const key of ['callsign', 'alt', 'speed', 'hex'] as const) {
    const t0 = performance.now()
    const out = sortRows(filterRows(rows, ''), key, true)
    const ms = performance.now() - t0
    assert.equal(out.length, 12_000)
    assert.ok(ms < 100, `${key}: ${ms.toFixed(1)} ms`) // generous: catches an accidental O(n²), not a benchmark
  }
})

// shared/wx.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slimMetars } from './wx.ts'

const MI = 1.609344 // km in a statute mile
const near = (a: number | null, b: number): boolean => a !== null && Math.abs(a - b) < 1e-9

// Records as aviationweather.gov sends them (checked 2026-10-02): a key it has nothing for is left out, not null.
const LLHA = {
  icaoId: 'LLHA', name: 'Haifa Intl, HA, IL', obsTime: 1790956200, temp: 26, dewp: 16, wdir: 250, wspd: 5, wgst: null,
  visib: '6+', altim: 1014, wxString: null, clouds: [{ cover: 'FEW', base: 4500 }], fltCat: 'VFR', vertVis: null,
  rawOb: 'METAR LLHA 021550Z AUTO 25005KT 9999 FEW045 26/16 Q1014', lat: 32.81, lon: 35.04, elev: 3,
}

test('slimMetars: Haifa, every field', () => {
  const [m] = slimMetars([LLHA])
  const { visKm, ...rest } = m
  assert.ok(near(visKm, 6 * MI), String(visKm)) // 9.66 km: "6+" is 6 miles or more
  assert.deepEqual(rest, {
    id: 'LLHA', name: 'Haifa Intl, HA, IL', lat: 32.81, lon: 35.04, elevM: 3, obsMs: 1790956200000, cat: 'VFR', wdir: 250, wspd: 5, wgst: null,
    visPlus: true, tempC: 26, dewC: 16, qnhHpa: 1014, wx: null, clouds: [{ cover: 'FEW', baseFt: 4500, type: null }], vertVisFt: null,
    raw: 'METAR LLHA 021550Z AUTO 25005KT 9999 FEW045 26/16 Q1014',
  })
})

test('slimMetars: a variable wind, 1 1/2 miles, weather, and a thundercloud read from the raw report', () => {
  const [m] = slimMetars([{
    icaoId: 'KXYZ', name: 'Example Rgnl, TX, US', lat: 31.5, lon: -97.2, obsTime: 1790956200, temp: -3.4, dewp: -5, wdir: 'VRB', wspd: 3,
    visib: '1 1/2', altim: 1020.7, wxString: '-RA BR', fltCat: 'IFR', elev: 312,
    clouds: [{ cover: 'FEW', base: 3000 }, { cover: 'FEW', base: 3300 }, { cover: 'BKN', base: 8000 }],
    rawOb: 'METAR KXYZ 021550Z VRB03KT 1 1/2SM -RA BR FEW030 FEW033CB BKN080 M03/M05 A3014',
  }])
  const { visKm, ...rest } = m
  assert.ok(near(visKm, 1.5 * MI), String(visKm))
  assert.deepEqual(rest, {
    id: 'KXYZ', name: 'Example Rgnl, TX, US', lat: 31.5, lon: -97.2, elevM: 312, obsMs: 1790956200000, cat: 'IFR', wdir: null, wspd: 3, wgst: null,
    visPlus: false, tempC: -3.4, dewC: -5, qnhHpa: 1020.7, wx: '-RA BR',
    clouds: [{ cover: 'FEW', baseFt: 3000, type: null }, { cover: 'FEW', baseFt: 3300, type: 'CB' }, { cover: 'BKN', baseFt: 8000, type: null }],
    vertVisFt: null, raw: 'METAR KXYZ 021550Z VRB03KT 1 1/2SM -RA BR FEW030 FEW033CB BKN080 M03/M05 A3014',
  })
})

test('slimMetars: visibility in statute miles, as a number or a string; unreadable is null', () => {
  const cases: [unknown, number | null, boolean][] = [
    [4.35, 4.35 * MI, false], [10, 10 * MI, false], ['6+', 6 * MI, true], ['10+', 10 * MI, true], ['1/2', 0.5 * MI, false],
    ['1 1/2', 1.5 * MI, false], ['M1/4', 0.25 * MI, false], ['  2  ', 2 * MI, false],
    ['', null, false], ['abc', null, false], ['1/0', null, false], [null, null, false], [undefined, null, false], [{}, null, false],
  ]
  for (const [visib, km, plus] of cases) {
    const [m] = slimMetars([{ icaoId: 'X', lat: 1, lon: 2, visib }])
    if (km === null) assert.equal(m.visKm, null, JSON.stringify(visib))
    else assert.ok(near(m.visKm, km), `${JSON.stringify(visib)} → ${m.visKm}`)
    assert.equal(m.visPlus, plus, JSON.stringify(visib))
  }
})

test('slimMetars: thunderclouds and towering cumulus come from the report body, matched by cover and base; trend groups do not count', () => {
  const clouds = (rawOb: string, ...layers: [string, number][]) =>
    slimMetars([{ icaoId: 'X', lat: 1, lon: 2, rawOb, clouds: layers.map(([cover, base]) => ({ cover, base })) }])[0].clouds
  assert.deepEqual(clouds('METAR X 021700Z 25009KT 8000 FEW030 FEW033CB SCT040', ['FEW', 3000], ['FEW', 3300], ['SCT', 4000]).map((c) => c.type), [null, 'CB', null])
  assert.deepEqual(clouds('METAR X 021700Z 09005KT 9999 BKN020TCU', ['BKN', 2000]).map((c) => c.type), ['TCU'])
  assert.deepEqual(clouds('METAR X 021700Z 09005KT 9999 FEW030 BECMG FEW030CB RMK SCT040CB', ['FEW', 3000]).map((c) => c.type), [null])
  assert.deepEqual(clouds('METAR X 021700Z 09005KT 9999 FEW030CB BKN030', ['FEW', 3000], ['BKN', 3000]).map((c) => c.type), ['CB', null]) // same base, other cover
})

test('slimMetars: sky hidden: vertVis is in hundreds of feet, the cloud list says OVX; no cloud list is empty', () => {
  const [m] = slimMetars([{
    icaoId: 'ESOK', lat: 59.4, lon: 13.3, vertVis: 2, clouds: [{ cover: 'OVX', base: 200 }], fltCat: 'LIFR', // ESOK 021650Z … FG VV002 …
    rawOb: 'METAR ESOK 021650Z 22004KT 0650 R03/1700N R21/1400U FG VV002 14/14 Q1026',
  }])
  assert.equal(m.vertVisFt, 200)
  assert.deepEqual(m.clouds, [{ cover: 'OVX', baseFt: 200, type: null }])
  assert.deepEqual(slimMetars([{ icaoId: 'LFKJ', lat: 41.9, lon: 8.8, rawOb: 'METAR LFKJ 021700Z AUTO 07006KT 9999 ///TCU 23/18 Q1026' }])[0].clouds, [])
})

test('slimMetars: a bare record gets null, false and empty for everything it lacks; no position or a non-array gives nothing', () => {
  assert.deepEqual(slimMetars([{ icaoId: 'BARE', lat: 1, lon: 2 }]), [{
    id: 'BARE', name: null, lat: 1, lon: 2, elevM: null, obsMs: null, cat: null, wdir: null, wspd: 0, wgst: null, visKm: null, visPlus: false,
    tempC: null, dewC: null, qnhHpa: null, wx: null, clouds: [], vertVisFt: null, raw: '',
  }])
  assert.deepEqual(slimMetars([{ icaoId: 'X', lat: null, lon: 1 }, { lat: 1, lon: 2 }]), [])
  assert.deepEqual(slimMetars({}), [])
  assert.equal(slimMetars([{ icaoId: 'X', lat: 1, lon: 2, wxString: '  ' }])[0].wx, null) // nothing to say is no weather
})

test('slimMetars: elevM is the API\'s elev, the station\'s metres above sea level (below it too); missing or not a number is null', () => {
  const elev = (v: unknown): number | null => slimMetars([{ icaoId: 'X', lat: 1, lon: 2, elev: v }])[0].elevM
  assert.equal(elev(1656), 1656) // Denver
  assert.equal(elev(0), 0) // at sea level is not unknown
  assert.equal(elev(-12), -12)
  for (const bad of ['35', null, undefined, Number.NaN, {}]) assert.equal(elev(bad), null, String(bad))
  assert.equal(slimMetars([{ icaoId: 'X', lat: 1, lon: 2 }])[0].elevM, null)
})

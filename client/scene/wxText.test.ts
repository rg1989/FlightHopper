// client/scene/wxText.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Cloud, Sigmet } from '../../shared/wx.ts'
import { DEFAULT_UNITS, type Units } from '../ui/units.ts'
import {
  CONDITION, altText, cloudText, compass, hhmm, pressureText, sigmetLabel, sigmetLevels, sigmetTitle, speedText, stationName, tempText,
  visibilityText, weatherText, windText,
} from './wxText.ts'

const ft: Units = DEFAULT_UNITS // ft, kt
const metric: Units = { alt: 'm', speed: 'kmh', vs: 'ms' }
const mph: Units = { ...DEFAULT_UNITS, speed: 'mph' }
const both: Units = { alt: 'ft+m', speed: 'kt+kmh', vs: 'fpm' }

test('compass: 16 points, 250° is WSW', () => {
  assert.equal(compass(250), 'WSW')
  assert.deepEqual([0, 90, 180, 270, 359, 360, 22, 23].map(compass), ['N', 'E', 'S', 'W', 'N', 'N', 'NNE', 'NNE'])
  assert.deepEqual([45, 135, 225, 315, 67.5, 337.5].map(compass), ['NE', 'SE', 'SW', 'NW', 'ENE', 'NNW'])
})

test('stationName: before the first comma, slashes as spaces, whole words spelled out, the id when nothing is there', () => {
  assert.equal(stationName('Haifa Intl, HA, IL', 'LLHA'), 'Haifa International')
  assert.equal(stationName('Tel Aviv/Ben Gurion Arpt, C, IL', 'LLBG'), 'Tel Aviv Ben Gurion Airport')
  assert.equal(stationName('Aqaba/Hussein Intl, MN, JO', 'OJAQ'), 'Aqaba Hussein International')
  assert.equal(stationName('Casper  Natrona Rgnl , WY, US', 'KCPR'), 'Casper Natrona Regional')
  assert.equal(stationName('Ames Muni, IA, US', 'KAMW'), 'Ames Municipal')
  assert.equal(stationName('Intlville Arptown', 'X'), 'Intlville Arptown') // whole words only
  assert.equal(stationName(null, 'LLHA'), 'LLHA')
  assert.equal(stationName('', 'LLHA'), 'LLHA')
  assert.equal(stationName(' , IL', 'LLHA'), 'LLHA')
})

test('speedText: rounded, in the frame\'s unit; knots with km/h gives both', () => {
  assert.equal(speedText(5, ft), '5 kt')
  assert.equal(speedText(5, metric), '9 km/h')
  assert.equal(speedText(5, mph), '6 mph')
  assert.equal(speedText(5, both), '5 kt (9 km/h)')
  assert.equal(speedText(15, both), '15 kt (28 km/h)')
  assert.equal(speedText(4.6, ft), '5 kt')
})

test('altText: nearest 100 ft or 50 m, thousands separated, feet with metres gives both', () => {
  assert.equal(altText(4500, ft), '4,500 ft')
  assert.equal(altText(4500, metric), '1,350 m')
  assert.equal(altText(4500, both), '4,500 ft (1,350 m)')
  assert.equal(altText(4540, ft), '4,500 ft')
  assert.equal(altText(4560, ft), '4,600 ft')
  assert.equal(altText(35000, ft), '35,000 ft')
  assert.equal(altText(35000, metric), '10,650 m')
  assert.equal(altText(200, ft), '200 ft')
  assert.equal(altText(0, metric), '0 m')
})

test('windText: calm, variable, from a direction, gusting', () => {
  assert.equal(windText({ wdir: 250, wspd: 5, wgst: null }, ft), 'From WSW, 5 kt')
  assert.equal(windText({ wdir: 250, wspd: 0, wgst: null }, ft), 'Calm')
  assert.equal(windText({ wdir: null, wspd: 0, wgst: null }, ft), 'Calm')
  assert.equal(windText({ wdir: null, wspd: 0.4, wgst: null }, ft), 'Calm') // under 1 kt
  assert.equal(windText({ wdir: null, wspd: 3, wgst: null }, ft), 'Variable, 3 kt')
  assert.equal(windText({ wdir: 290, wspd: 12, wgst: 22 }, ft), 'From WNW, 12 kt, gusting 22 kt')
  assert.equal(windText({ wdir: 290, wspd: 12, wgst: 22 }, metric), 'From WNW, 22 km/h, gusting 41 km/h')
  assert.equal(windText({ wdir: 290, wspd: 12, wgst: 22 }, both), 'From WNW, 12 kt (22 km/h), gusting 22 kt (41 km/h)')
})

test('visibilityText: whole km from 5, one decimal to 1 km, metres below; "or more" when it is a floor', () => {
  assert.equal(visibilityText(null, false), null)
  assert.equal(visibilityText(null, true), null)
  assert.equal(visibilityText(9.66, true), '10 km or more')
  assert.equal(visibilityText(7.0, false), '7 km')
  assert.equal(visibilityText(5, false), '5 km')
  assert.equal(visibilityText(2.4, false), '2.4 km')
  assert.equal(visibilityText(1.59, false), '1.6 km')
  assert.equal(visibilityText(0.8, false), '800 m')
  assert.equal(visibilityText(0.6437, false), '650 m') // 0650 in the report is 0.4 miles in the API
  assert.equal(visibilityText(0.82, false), '800 m')
})

test('cloudText: layers in words, thunderclouds named, sky hidden, and what a report without layers says', () => {
  const layer = (cover: string, baseFt: number | null, type: Cloud['type'] = null): Cloud => ({ cover, baseFt, type })
  const text = (clouds: Cloud[], raw = '', vertVisFt: number | null = null, u: Units = ft): string => cloudText({ clouds, vertVisFt, raw }, u)
  assert.equal(text([layer('FEW', 4500)]), 'Few at 4,500 ft')
  assert.equal(text([layer('FEW', 4500)], '', null, both), 'Few at 4,500 ft (1,350 m)')
  assert.equal(text([layer('SCT', 3000), layer('BKN', 8000), layer('OVC', 12000)]), 'Scattered at 3,000 ft · Broken at 8,000 ft · Overcast at 12,000 ft')
  assert.equal(text([layer('FEW', 3300, 'CB')]), 'Few at 3,300 ft (thunderclouds)')
  assert.equal(text([layer('BKN', 2000, 'TCU')]), 'Broken at 2,000 ft (towering cumulus)')
  assert.equal(text([layer('FEW', null, 'TCU')]), 'Few (towering cumulus)') // a layer whose base is not reported
  assert.equal(text([layer('OVX', 200)], '', 200), 'Sky hidden, vertical visibility 200 ft') // the API's OVX is the layer VV makes
  assert.equal(text([layer('OVX', null)]), 'Sky hidden') // VV///: hidden, no height
  // no layers
  assert.equal(text([], 'METAR OJAQ 021700Z 29006KT CAVOK 31/08 Q1016 NOSIG'), 'None below 5,000 ft')
  assert.equal(text([], 'METAR OJAQ 021700Z 29006KT CAVOK 31/08 Q1016', null, metric), 'None below 1,500 m')
  assert.equal(text([], 'METAR OJAQ 021700Z 29006KT CAVOK 31/08 Q1016', null, both), 'None below 5,000 ft (1,500 m)')
  assert.equal(text([], 'METAR X 021700Z 29006KT 9999 NSC 31/08 Q1016'), 'No significant cloud')
  assert.equal(text([], 'METAR X 021700Z 29006KT 9999 NCD 31/08 Q1016'), 'None detected')
  assert.equal(text([], 'METAR X 021700Z 29006KT 9999 SKC 31/08 Q1016'), 'Clear sky')
  assert.equal(text([layer('CLR', null)], 'METAR KXYZ 021700Z 29006KT 10SM CLR 31/08 A2992'), 'Clear sky')
  assert.equal(text([], 'METAR X 021700Z 29006KT 9999 31/08 Q1016'), 'Not reported')
  assert.equal(text([], ''), 'Not reported')
  assert.equal(text([], 'METAR X 021700Z 29006KT 9999 NOSIG RMK NSCX'), 'Not reported') // whole words only
})

test('weatherText: each code in words, joined, the first letter capital', () => {
  assert.equal(weatherText('-RA BR'), 'Light rain, mist')
  assert.equal(weatherText('-SHRA'), 'Light rain showers')
  assert.equal(weatherText('+TSRA'), 'Heavy thunderstorm with rain')
  assert.equal(weatherText('VCSH'), 'Showers nearby')
  assert.equal(weatherText('FZFG'), 'Freezing fog')
  assert.equal(weatherText('BCFG'), 'Patches of fog')
  assert.equal(weatherText('RASN'), 'Rain and snow')
  assert.equal(weatherText('VCTS'), 'Thunderstorm nearby')
  assert.equal(weatherText('-TSRA'), 'Light thunderstorm with rain')
  assert.equal(weatherText('PRFG'), 'Partial fog')
  assert.equal(weatherText('HZ'), 'Haze')
  assert.equal(weatherText('+SHRAGR'), 'Heavy rain and hail showers')
  assert.equal(weatherText('DZ BR'), 'Drizzle, mist')
  assert.equal(weatherText(null), null)
  assert.equal(weatherText(''), null)
})

test('tempText, pressureText, CONDITION', () => {
  assert.equal(tempText(26, 16), '26 °C, dew point 16 °C')
  assert.equal(tempText(26, null), '26 °C')
  assert.equal(tempText(null, 16), null)
  assert.equal(tempText(null, null), null)
  assert.equal(tempText(25.6, 15.5), '26 °C, dew point 16 °C')
  assert.equal(tempText(-3.4, -5), '-3 °C, dew point -5 °C')
  assert.equal(tempText(-0.2, null), '0 °C')
  assert.equal(pressureText(1014), '1014 hPa')
  assert.equal(pressureText(1020.7), '1021 hPa')
  assert.equal(pressureText(null), null)
  assert.deepEqual(CONDITION, { VFR: 'Good', MVFR: 'Marginal', IFR: 'Poor', LIFR: 'Very poor' })
})

test('hhmm: local hours and minutes, zero-padded', () => {
  assert.equal(hhmm(new Date(2026, 9, 2, 18, 50).getTime()), '18:50')
  assert.equal(hhmm(new Date(2026, 9, 2, 0, 5).getTime()), '00:05')
  assert.equal(hhmm(new Date(2026, 0, 31, 9, 0, 59).getTime()), '09:00')
})

const sig = (o: Partial<Sigmet>): Sigmet => ({ hazard: 'TS', qualifier: null, base: null, top: null, until: '', raw: '', rings: [], ...o })

test('sigmetTitle: the hazard in words, its qualifier a word before it; unknown hazards read as their code', () => {
  assert.equal(sigmetTitle(sig({ hazard: 'TS', qualifier: 'EMBD' })), 'Embedded thunderstorms')
  assert.equal(sigmetTitle(sig({ hazard: 'TURB', qualifier: 'SEV' })), 'Severe turbulence')
  assert.equal(sigmetTitle(sig({ hazard: 'TS' })), 'Thunderstorms')
  assert.equal(sigmetTitle(sig({ hazard: 'TSGR', qualifier: 'FRQ' })), 'Frequent thunderstorms with hail')
  assert.equal(sigmetTitle(sig({ hazard: 'ICE', qualifier: 'MOD' })), 'Moderate icing')
  assert.equal(sigmetTitle(sig({ hazard: 'TS', qualifier: 'SQL' })), 'Squall-line thunderstorms')
  assert.equal(sigmetTitle(sig({ hazard: 'MTW', qualifier: 'SEV' })), 'Severe mountain waves')
  assert.equal(sigmetTitle(sig({ hazard: 'VA' })), 'Volcanic ash')
  assert.equal(sigmetTitle(sig({ hazard: 'XYZ' })), 'XYZ')
  assert.equal(sigmetTitle(sig({ hazard: 'XYZ', qualifier: 'SEV' })), 'Severe XYZ')
  assert.equal(sigmetTitle(sig({ hazard: 'TS', qualifier: 'ZZZ' })), 'Thunderstorms') // unknown qualifier: no word
})

test('sigmetLevels and sigmetLabel: heights in the frame\'s unit, "up to" without a base, "surface" at the ground', () => {
  assert.equal(sigmetLevels(sig({ top: null }), ft), null)
  assert.equal(sigmetLevels(sig({ base: 0, top: null }), ft), null)
  assert.equal(sigmetLevels(sig({ base: null, top: 35000 }), ft), 'Up to 35,000 ft')
  assert.equal(sigmetLevels(sig({ base: 0, top: 5500 }), ft), 'Surface to 5,500 ft')
  assert.equal(sigmetLevels(sig({ base: -100, top: 5500 }), ft), 'Surface to 5,500 ft')
  assert.equal(sigmetLevels(sig({ base: 18000, top: 35000 }), ft), '18,000 to 35,000 ft')
  assert.equal(sigmetLevels(sig({ base: 18000, top: 35000 }), metric), '5,500 to 10,650 m')
  assert.equal(sigmetLevels(sig({ base: 18000, top: 35000 }), both), '18,000 to 35,000 ft (5,500 to 10,650 m)')
  assert.equal(sigmetLevels(sig({ base: null, top: 35000 }), both), 'Up to 35,000 ft (10,650 m)')
  assert.equal(sigmetLevels(sig({ base: 0, top: 5500 }), metric), 'Surface to 1,700 m')

  assert.equal(sigmetLabel(sig({ hazard: 'TS', qualifier: 'EMBD', top: 35000 }), ft), 'Embedded thunderstorms · up to 35,000 ft')
  assert.equal(sigmetLabel(sig({ hazard: 'TURB', qualifier: 'SEV', base: 0, top: 5500 }), ft), 'Severe turbulence · surface to 5,500 ft')
  assert.equal(sigmetLabel(sig({ hazard: 'ICE', base: 18000, top: 35000 }), ft), 'Icing · 18,000 to 35,000 ft')
  assert.equal(sigmetLabel(sig({ hazard: 'TURB' }), ft), 'Turbulence')
  assert.equal(sigmetLabel(sig({ hazard: 'TS', top: 35000 }), metric), 'Thunderstorms · up to 10,650 m')
})

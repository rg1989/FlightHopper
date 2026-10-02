// client/scene/wxText.ts
// The weather layer's words, in plain English: an airport's wind, visibility, cloud, weather, temperature and pressure, and
// a hazard area's name and heights, as short phrases; and the colours they go with (a flight category's, a hazard's). Speeds
// and heights follow the flight-data frame's units (units.ts: a second unit in brackets when the frame shows both). Pure, no
// DOM and no Cesium, so Node tests cover every phrase, and the map, its card (wxCard.ts) and the Layers panel share the colours.
// ponytail: English only, as the rest of the app. Upgrade: a phrase table per language when the UI is translated.
import type { FlightCategory, Metar, Sigmet } from '../../shared/wx.ts'
import { altIn, altLabel, speedIn, speedLabel, type Units } from '../ui/units.ts'

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
/** The compass point (of 16) a bearing in degrees falls on. */
export const compass = (deg: number): string => POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]

// ponytail: only the commonest abbreviations are spelled out (Natl, AFB and the like stay as sent). Upgrade: a longer table when a name reads badly.
const NAME_WORDS: Record<string, string> = {
  Intl: 'International', Arpt: 'Airport', Rgnl: 'Regional', Muni: 'Municipal', Fld: 'Field', Cnty: 'County', Mem: 'Memorial',
}
const NAME_WORD = new RegExp(`\\b(?:${Object.keys(NAME_WORDS).join('|')})\\b`, 'g')
/** An airport's name as the API sends it ("Tel Aviv/Ben Gurion Arpt, C, IL") in words ("Tel Aviv Ben Gurion Airport"); the id when it has none. */
export function stationName(name: string | null, id: string): string {
  const n = (name ?? '').split(',')[0].replace(/\//g, ' ').replace(/\s+/g, ' ').trim()
  return n === '' ? id : n.replace(NAME_WORD, (w) => NAME_WORDS[w])
}

export function speedText(kt: number, u: Units): string {
  const first = `${Math.round(speedIn(kt, u.speed))} ${speedLabel(u.speed)}`
  return u.speed === 'kt+kmh' ? `${first} (${Math.round(speedIn(kt, 'kmh'))} ${speedLabel('kmh')})` : first
}

// ponytail: metres to the nearest 50 are coarse for low cloud (200 ft reads 50 m). Upgrade: 10 m steps under 500 m.
const STEP: Record<'ft' | 'm', number> = { ft: 100, m: 50 }
/** "4,500 ft", or with a lower height "18,000 to 35,000 ft", in one unit. */
function span(lo: number | null, hi: number, unit: 'ft' | 'm'): string {
  const n = (ft: number): string => (Math.round(altIn(ft, unit) / STEP[unit]) * STEP[unit]).toLocaleString('en-US')
  return `${lo === null ? '' : `${n(lo)} to `}${n(hi)} ${altLabel(unit)}`
}
const heights = (lo: number | null, hi: number, u: Units): string => (u.alt === 'ft+m' ? `${span(lo, hi, 'ft')} (${span(lo, hi, 'm')})` : span(lo, hi, u.alt))

/** A height in feet: the nearest 100 ft or 50 m. */
export const altText = (ft: number, u: Units): string => heights(null, ft, u)

export function windText(m: Pick<Metar, 'wdir' | 'wspd' | 'wgst'>, u: Units): string {
  if (m.wspd < 1) return 'Calm'
  const gusts = m.wgst === null ? '' : `, gusting ${speedText(m.wgst, u)}`
  return `${m.wdir === null ? 'Variable' : `From ${compass(m.wdir)}`}, ${speedText(m.wspd, u)}${gusts}`
}

/** Visibility in km: whole from 5, in 0.1 km down to 1 km ("4 km", "2.4 km"), metres to the nearest 50 below that; plus: it is a floor ("10 km or more"). */
export function visibilityText(km: number | null, plus: boolean): string | null {
  if (km === null) return null
  const metres = Math.round((km * 1000) / 50) * 50
  const what = km >= 5 ? `${Math.round(km)} km` : km >= 1 ? `${Math.round(km * 10) / 10} km` : metres >= 1000 ? '1 km' : `${metres} m`
  return plus ? `${what} or more` : what
}

const COVER: Record<string, string> = { FEW: 'Few', SCT: 'Scattered', BKN: 'Broken', OVC: 'Overcast' }
const CLOUD_TYPE = { CB: ' (thunderclouds)', TCU: ' (towering cumulus)' }
/** The cloud layers, or when a report has none what it says instead (CAVOK, no significant cloud, clear sky …). */
export function cloudText(m: Pick<Metar, 'clouds' | 'vertVisFt' | 'raw'>, u: Units): string {
  const parts = m.clouds
    .filter((c) => Object.hasOwn(COVER, c.cover))
    .map((c) => `${COVER[c.cover]}${c.baseFt === null ? '' : ` at ${altText(c.baseFt, u)}`}${c.type === null ? '' : CLOUD_TYPE[c.type]}`)
  if (m.vertVisFt !== null) parts.push(`Sky hidden, vertical visibility ${altText(m.vertVisFt, u)}`)
  else if (m.clouds.some((c) => c.cover === 'OVX' || c.cover === 'VV')) parts.push('Sky hidden') // VV///: hidden, no height
  if (parts.length > 0) return parts.join(' · ')
  if (/\bCAVOK\b/.test(m.raw)) return `None below ${altText(5000, u)}`
  if (/\bNSC\b/.test(m.raw)) return 'No significant cloud'
  if (/\bNCD\b/.test(m.raw)) return 'None detected'
  if (/\b(?:SKC|CLR)\b/.test(m.raw)) return 'Clear sky'
  return 'Not reported'
}

const DESC: Record<string, string> = { MI: 'shallow', PR: 'partial', BC: 'patches of', DR: 'drifting', BL: 'blowing',
  SH: '', TS: '', FZ: 'freezing' }
const PHEN: Record<string, string> = { DZ: 'drizzle', RA: 'rain', SN: 'snow', SG: 'snow grains', IC: 'ice crystals',
  PL: 'ice pellets', GR: 'hail', GS: 'small hail', UP: 'precipitation', BR: 'mist', FG: 'fog', FU: 'smoke',
  VA: 'volcanic ash', DU: 'dust', SA: 'sand', HZ: 'haze', PY: 'spray', PO: 'dust whirls', SQ: 'squalls',
  FC: 'funnel cloud', SS: 'sandstorm', DS: 'dust storm' }

/** One present-weather group (-SHRA, +TSRA, VCSH, BCFG) in words; null when any part of it has none (NSW, RERA: no stray letters). */
function phrase(tok: string): string | null {
  let i = 0
  let strength = ''
  if (tok[0] === '-') [strength, i] = ['light', 1]
  else if (tok[0] === '+') [strength, i] = ['heavy', 1]
  const near = tok.startsWith('VC', i)
  if (near) i += 2
  const d = tok.slice(i, i + 2)
  const desc = d in DESC ? d : ''
  if (desc) i += 2
  const ph: string[] = []
  for (; i + 2 <= tok.length; i += 2) {
    const word = PHEN[tok.slice(i, i + 2)]
    if (word === undefined) return null
    ph.push(word)
  }
  if (i !== tok.length) return null // a letter left over
  const what = ph.join(' and ')
  const words = desc === 'SH' ? `${what ? `${what} ` : ''}showers`
    : desc === 'TS' ? `thunderstorm${what ? ` with ${what}` : ''}`
    : [DESC[desc], what].filter(Boolean).join(' ')
  if (words === '') return null // a bare strength or VC says nothing
  return [strength, words].filter(Boolean).join(' ') + (near ? ' nearby' : '')
}

/** The API's wxString ("-RA BR") in words ("Light rain, mist"); a group with no words is left out, and null when none is left. */
export function weatherText(wx: string | null): string | null {
  const text = (wx ?? '').split(' ').filter(Boolean).map(phrase).filter((p) => p !== null).join(', ')
  return text === '' ? null : text[0].toUpperCase() + text.slice(1)
}

export function tempText(t: number | null, dew: number | null): string | null {
  if (t === null) return null
  return dew === null ? `${Math.round(t)} °C` : `${Math.round(t)} °C, dew point ${Math.round(dew)} °C`
}

export const pressureText = (hpa: number | null): string | null => (hpa === null ? null : `${Math.round(hpa)} hPa`)

/** The flight category as a condition (VFR is good flying weather, LIFR very poor). */
export const CONDITION: Record<FlightCategory, string> = { VFR: 'Good', MVFR: 'Marginal', IFR: 'Poor', LIFR: 'Very poor' }

/** A flight category's colour: the marker's ring, the card's dot, the Layers panel's legend. */
export const CATEGORY_COLOR: Record<FlightCategory, string> = { VFR: '#3ddc84', MVFR: '#4f9dff', IFR: '#ff5a5a', LIFR: '#e05cff' }

const pad2 = (n: number): string => String(n).padStart(2, '0')
/** Local HH:MM. */
export function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

const HAZARD: Record<string, string> = { TS: 'Thunderstorms', TSGR: 'Thunderstorms with hail', TURB: 'Turbulence',
  ICE: 'Icing', MTW: 'Mountain waves', VA: 'Volcanic ash', TC: 'Tropical cyclone', DS: 'Dust storm',
  SS: 'Sandstorm', RDOACT: 'Radioactive cloud' }
const QUALIFIER: Record<string, string> = { SEV: 'Severe', MOD: 'Moderate', EMBD: 'Embedded', OBSC: 'Obscured',
  FRQ: 'Frequent', ISOL: 'Isolated', OCNL: 'Occasional', SQL: 'Squall-line', HVY: 'Heavy' }

const NAMED = new Set(['VA', 'TC']) // the hazards whose qualifier, past the known words, is a name: the volcano's, the cyclone's

const lowerFirst = (word: string): string => word[0].toLowerCase() + word.slice(1)
/** "ERUPTION MT SANGAY" → "Eruption Mt Sangay". */
const titleCase = (text: string): string => text.toLowerCase().replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase())

/**
 * "Embedded thunderstorms", "Severe turbulence (mountain waves)", "Volcanic ash (Santa Maria)": the hazard, the qualifier's known
 * words before it in the report's order, MTW after it, and for ash and cyclones the rest of the qualifier as the name. A hazard
 * code with no words reads as itself; other words are left out.
 */
export function sigmetTitle(s: Sigmet): string {
  const words = (s.qualifier ?? '').split(/\s+/).filter(Boolean)
  const adjectives = words.filter((w) => Object.hasOwn(QUALIFIER, w)).map((w) => lowerFirst(QUALIFIER[w]))
  const hazard = Object.hasOwn(HAZARD, s.hazard) ? lowerFirst(HAZARD[s.hazard]) : s.hazard
  const title = [...adjectives, hazard].join(' ')
  const waves = words.includes('MTW') && s.hazard !== 'MTW' ? ' (mountain waves)' : ''
  const name = NAMED.has(s.hazard) ? words.filter((w) => !Object.hasOwn(QUALIFIER, w) && w !== 'MTW').join(' ') : ''
  return `${title.charAt(0).toUpperCase()}${title.slice(1)}${waves}${name === '' ? '' : ` (${titleCase(name)})`}`
}

/** A hazard's colour: its area's outline, fill and label on the map, and the dot on its card. */
export function sigmetColor(hazard: string): string {
  if (/TS|CB/.test(hazard)) return '#ff5a5a'
  if (/TURB|MTW/.test(hazard)) return '#ffb020'
  if (/ICE/.test(hazard)) return '#4fd1ff'
  if (/VA|RDOACT/.test(hazard)) return '#c080ff'
  if (/TC/.test(hazard)) return '#ff3df0'
  if (/DS|SS/.test(hazard)) return '#d8b070'
  return '#dddddd'
}

/** "Up to 35,000 ft", "Surface to 5,500 ft", "18,000 to 35,000 ft"; null when the top is not given. */
export function sigmetLevels(s: Sigmet, u: Units): string | null {
  if (s.top === null) return null
  if (s.base === null) return `Up to ${altText(s.top, u)}`
  if (s.base <= 0) return `Surface to ${altText(s.top, u)}`
  return heights(s.base, s.top, u)
}

/** The area's label on the map: "Embedded thunderstorms · up to 35,000 ft". */
export function sigmetLabel(s: Sigmet, u: Units): string {
  const title = sigmetTitle(s)
  const levels = sigmetLevels(s, u)
  return levels === null ? title : `${title} · ${levels[0].toLowerCase()}${levels.slice(1)}`
}

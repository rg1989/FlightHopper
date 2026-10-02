// client/scene/wxText.ts
// The weather layer's words, in plain English: an airport's wind, visibility, cloud, weather, temperature and pressure, and
// a hazard area's name and heights, as short phrases. Speeds and heights follow the flight-data frame's units (units.ts: a
// second unit in brackets when the frame shows both). Pure, no DOM and no Cesium, so Node tests cover every phrase.
// ponytail: English only, as the rest of the app. Upgrade: a phrase table per language when the UI is translated.
import type { FlightCategory, Metar, Sigmet } from '../../shared/wx.ts'
import { altIn, altLabel, speedIn, speedLabel, type Units } from '../ui/units.ts'

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
/** The compass point (of 16) a bearing in degrees falls on. */
export const compass = (deg: number): string => POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]

const NAME_WORDS: Record<string, string> = { Intl: 'International', Arpt: 'Airport', Rgnl: 'Regional', Muni: 'Municipal' }
/** An airport's name as the API sends it ("Tel Aviv/Ben Gurion Arpt, C, IL") in words ("Tel Aviv Ben Gurion Airport"); the id when it has none. */
export function stationName(name: string | null, id: string): string {
  const n = (name ?? '').split(',')[0].replace(/\//g, ' ').replace(/\s+/g, ' ').trim()
  return n === '' ? id : n.replace(/\b(?:Intl|Arpt|Rgnl|Muni)\b/g, (w) => NAME_WORDS[w])
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

/** Visibility in km: whole from 5, a decimal to 1 km, metres below that; plus: it is a floor ("10 km or more"). */
export function visibilityText(km: number | null, plus: boolean): string | null {
  if (km === null) return null
  const what = km >= 5 ? `${Math.round(km)} km` : km >= 1 ? `${km.toFixed(1)} km` : `${Math.round((km * 1000) / 50) * 50} m`
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

/** One present-weather group (-SHRA, +TSRA, VCSH, BCFG) in words. */
function phrase(tok: string): string {
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
  for (; i + 2 <= tok.length; i += 2) ph.push(PHEN[tok.slice(i, i + 2)] ?? tok.slice(i, i + 2))
  const what = ph.join(' and ')
  const words = desc === 'SH' ? `${what ? `${what} ` : ''}showers`
    : desc === 'TS' ? `thunderstorm${what ? ` with ${what}` : ''}`
    : [DESC[desc], what].filter(Boolean).join(' ')
  return [strength, words].filter(Boolean).join(' ') + (near ? ' nearby' : '')
}

/** The API's wxString ("-RA BR") in words ("Light rain, mist"); null when there is none. */
export function weatherText(wx: string | null): string | null {
  const text = (wx ?? '').split(' ').filter(Boolean).map(phrase).join(', ')
  return text === '' ? null : text[0].toUpperCase() + text.slice(1)
}

export function tempText(t: number | null, dew: number | null): string | null {
  if (t === null) return null
  return dew === null ? `${Math.round(t)} °C` : `${Math.round(t)} °C, dew point ${Math.round(dew)} °C`
}

export const pressureText = (hpa: number | null): string | null => (hpa === null ? null : `${Math.round(hpa)} hPa`)

/** The flight category as a condition (VFR is good flying weather, LIFR very poor). */
export const CONDITION: Record<FlightCategory, string> = { VFR: 'Good', MVFR: 'Marginal', IFR: 'Poor', LIFR: 'Very poor' }

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

/** "Embedded thunderstorms", "Severe turbulence": the hazard, its qualifier a word before it. A code with no words reads as itself. */
export function sigmetTitle(s: Sigmet): string {
  const name = Object.hasOwn(HAZARD, s.hazard) ? HAZARD[s.hazard] : null
  const q = s.qualifier !== null && Object.hasOwn(QUALIFIER, s.qualifier) ? QUALIFIER[s.qualifier] : null
  if (q === null) return name ?? s.hazard
  return name === null ? `${q} ${s.hazard}` : `${q} ${name[0].toLowerCase()}${name.slice(1)}`
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

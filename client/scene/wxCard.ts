// client/scene/wxCard.ts
// The weather layer's hover card as DOM (weather.ts shows it under the pointer): an airport's weather, or the hazard areas over a
// point, in the words of wxText.ts, never the raw report. DOM only, no Cesium and no viewer, so Node tests build it against a
// minimal fake document. The reports are outside text: it goes in through textContent (and text nodes), never as markup.
import type { Metar, Sigmet } from '../../shared/wx.ts'
import { h } from '../ui/instruments.ts'
import type { Units } from '../ui/units.ts'
import {
  CATEGORY_COLOR, CONDITION, cloudText, hhmm, pressureText, sigmetColor, sigmetLevels, sigmetTitle, stationName, tempText, visibilityText,
  weatherText, windText,
} from './wxText.ts'

/** A card's head line: the name (a hazard's with its colour as a dot), then the small id and the time, pushed right. */
function cardHead(name: string, hazardColor: string | null, id: string | null, time: string | null): HTMLElement {
  const row = h('div', 'fh-wx-h')
  const n = h('span', hazardColor === null ? 'fh-wx-name' : 'fh-wx-name fh-wx-hazard', name)
  if (hazardColor !== null) n.style.setProperty('--c', hazardColor)
  row.append(n)
  if (id !== null) row.append(h('span', 'fh-wx-id', id))
  if (time !== null) row.append(h('span', 'fh-wx-t fh-num', time))
  return row
}

/** A two-column list of the rows that have a text; null when none has. */
function cardRows(rows: [string, string | null][]): HTMLElement | null {
  const dl = h('dl', 'fh-wx-rows')
  for (const [term, text] of rows) if (text !== null) dl.append(h('dt', '', term), h('dd', '', text))
  return dl.children.length > 0 ? dl : null
}

/** An airport's card: name, id and time of the report; the condition in its colour; wind, visibility, cloud, weather, temperature, pressure. */
export function metarCard(m: Metar, u: Units): HTMLElement[] {
  const name = stationName(m.name, m.id)
  const out = [cardHead(name, null, name === m.id ? null : m.id, m.obsMs === null ? null : hhmm(m.obsMs))]
  if (m.cat !== null) {
    const cond = h('div', 'fh-wx-cond')
    cond.style.setProperty('--c', CATEGORY_COLOR[m.cat])
    cond.append(`${CONDITION[m.cat]} conditions `, h('span', 'fh-wx-code', m.cat))
    out.push(cond)
  }
  const rows = cardRows([
    ['Wind', windText(m, u)],
    ['Visibility', visibilityText(m.visKm, m.visPlus)],
    ['Cloud', cloudText(m, u)],
    ['Weather', weatherText(m.wx)],
    ['Temperature', tempText(m.tempC, m.dewC)],
    ['Pressure', pressureText(m.qnhHpa)],
  ])
  if (rows !== null) out.push(rows)
  return out
}

/** The hazard areas over a point: a card each (its name in its colour, until when, the heights), a hairline between. */
export function sigmetCards(list: Sigmet[], u: Units): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const s of list) {
    if (out.length > 0) out.push(h('div', 'fh-wx-sep'))
    const until = Date.parse(s.until)
    out.push(cardHead(sigmetTitle(s), sigmetColor(s.hazard), null, Number.isNaN(until) ? null : `until ${hhmm(until)}`))
    const rows = cardRows([['Height', sigmetLevels(s, u)]])
    if (rows !== null) out.push(rows)
  }
  return out
}

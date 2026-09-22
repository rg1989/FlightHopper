// client/ui/table.ts
// Right-hand sidebar listing the aircraft on screen: flag, callsign, route, type, squawk, altitude, speed. Sortable by
// any column, searchable, with "Total aircraft" / "On screen" counts; a row click selects the aircraft.
// Built for thousands of rows with update() called every frame:
// - once a second (RESORT_MS) the on-screen entries are copied into table-owned objects, then filtered and sorted.
//   Fleet reuses its FleetEntry objects every frame, so the table never keeps a reference to one. The sort starts
//   from the last display order, which V8's adaptive sort finishes in about one pass;
// - a header click or a search re-sorts that copy at once;
// - only the rows in the scroll viewport plus OVERSCAN exist in the DOM. Row i always uses row element i % poolSize,
//   so scrolling rewrites only the rows that come into view, and a cell is written only when its text changes.
import type { FleetEntry } from '../types.ts'

/** What a column sorts by. The flag column sorts by ICAO address: address blocks are allocated per country. */
export type TableKey = 'hex' | 'callsign' | 'route' | 'type' | 'squawk' | 'alt' | 'speed'

export interface TableColumn {
  key: TableKey
  label: string
  title: string
  num: boolean // right-aligned number
}

/** The columns, in order. cellText(e, i) is the text of column i. */
export const COLUMNS: readonly TableColumn[] = [
  { key: 'hex', label: '⚑', title: 'Country of registration (sorts by ICAO address, which groups countries)', num: false },
  { key: 'callsign', label: 'Callsign', title: 'Callsign (ICAO address when there is none)', num: false },
  { key: 'route', label: 'Route', title: 'Route (origin - destination)', num: false },
  { key: 'type', label: 'Type', title: 'ICAO aircraft type designator', num: false },
  { key: 'squawk', label: 'Sqk', title: 'Squawk (7500, 7600 and 7700 highlighted)', num: false },
  { key: 'alt', label: 'Alt ft', title: 'Barometric altitude in feet; ▲ climbing / ▼ descending faster than 300 ft/min', num: true },
  { key: 'speed', label: 'Spd kt', title: 'Ground speed in knots', num: true },
]

export const ROW_H = 22 // px; fixed, the virtual scroll depends on it (table.css .fh-row height)
export const OVERSCAN = 8 // rows kept above and below the viewport so a fast scroll never shows a gap
// ponytail: rows show values up to RESORT_MS old (a list, not a gauge; tar1090 also refreshes its table about once a
// second). Upgrade if a live column is wanted: repaint only the visible rows every frame from a hex → entry lookup.
export const RESORT_MS = 1000 // at most one copy + filter + sort per second from update()
const VS_ARROW_FPM = 300
const GROUND = -1e9 // sort key: below every airborne altitude
const noFlag = (): string => ''

const finite = (v: number | null): v is number => v !== null && Number.isFinite(v)

/** 35000 → "35,000". Not toLocaleString: that builds a number formatter per call. */
const grouped = (n: number): string => String(Math.round(n) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

function keyOf(e: FleetEntry, key: TableKey): string | number | null {
  const i = e.info
  switch (key) {
    case 'hex': return e.hex
    case 'callsign': return i?.callsign ?? null
    case 'route': return i?.route ?? null
    case 'type': return i?.typeCode ?? null
    case 'squawk': return i?.squawk ?? null
    case 'alt': return e.onGround ? GROUND : finite(e.altFt) ? e.altFt : null
    case 'speed': return finite(e.gsKt) ? e.gsKt : null
  }
}

/**
 * The rows sorted by key (ascending, or descending when desc). Unknown values go last in both directions; equal keys
 * are ordered by hex so the order is stable from one re-sort to the next. Returns a new array; the input is untouched.
 */
export function sortRows(rows: readonly FleetEntry[], key: TableKey, desc: boolean): FleetEntry[] {
  const n = rows.length
  const keys: (string | number | null)[] = []
  const idx: number[] = []
  for (let i = 0; i < n; i++) {
    keys.push(keyOf(rows[i], key))
    idx.push(i)
  }
  const sign = desc ? -1 : 1
  idx.sort((i, j) => {
    const a = keys[i]
    const b = keys[j]
    if (a !== b) {
      if (a === null) return 1
      if (b === null) return -1
      if (a < b) return -sign
      if (a > b) return sign
    }
    const ha = rows[i].hex
    const hb = rows[j].hex
    return ha < hb ? -1 : ha > hb ? 1 : 0
  })
  const out: FleetEntry[] = []
  for (let k = 0; k < n; k++) out.push(rows[idx[k]])
  return out
}

const has = (v: string | null | undefined, q: string): boolean => v != null && v.toLowerCase().includes(q)

/** The rows whose callsign, hex, registration, type or squawk contains the query (trimmed, any case). New array. */
export function filterRows(rows: readonly FleetEntry[], query: string): FleetEntry[] {
  const q = query.trim().toLowerCase()
  if (q === '') return rows.slice()
  const out: FleetEntry[] = []
  for (const e of rows) {
    const i = e.info
    if (has(e.hex, q) || has(i?.callsign, q) || has(i?.reg, q) || has(i?.typeCode, q) || has(i?.squawk, q)) out.push(e)
  }
  return out
}

export function isEmergencySquawk(squawk: string | null): boolean {
  return squawk === '7500' || squawk === '7600' || squawk === '7700'
}

/** Text of column `col` (index into COLUMNS) for one row; '' when unknown. */
export function cellText(e: FleetEntry, col: number, flagOf: (hex: string) => string = noFlag): string {
  const i = e.info
  switch (col) {
    case 0: return flagOf(e.hex)
    case 1: return i?.callsign ?? e.hex
    case 2: return i?.route == null ? '' : i.route.replace(/\s*-\s*/g, ' - ')
    case 3: return i?.typeCode ?? ''
    case 4: return i?.squawk ?? ''
    case 5: {
      if (e.onGround) return 'ground'
      if (!finite(e.altFt)) return ''
      const vs = e.vsFpm
      return grouped(e.altFt) + (finite(vs) && vs > VS_ARROW_FPM ? ' ▲' : finite(vs) && vs < -VS_ARROW_FPM ? ' ▼' : '')
    }
    case 6: return finite(e.gsKt) ? String(Math.round(e.gsKt)) : ''
    default: return ''
  }
}

/** Rows [first, end) to keep in the DOM for a viewport at scrollTop of height viewH (px). */
export function windowRange(scrollTop: number, viewH: number, rowH: number, count: number, overscan: number): { first: number; end: number } {
  const first = Math.max(0, Math.floor(scrollTop / rowH) - overscan)
  const end = Math.min(count, Math.ceil((scrollTop + viewH) / rowH) + overscan)
  return { first: Math.min(first, end), end }
}

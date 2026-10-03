// server/heatmap.ts
// Reads adsb.lol's half-hour "heatmap" file: every aircraft the network heard in one UTC half hour, one position per
// aircraft per slice (a slice is 10 s there). readsb writes it (globe_index.c handleHeatmap); tar1090 replays it
// (script.js initReplay and replayStep). Checked on a real file: 2026-09-30 08.bin.ttf, 825,533 records, 180 slices.
//
// The decompressed file is an array of 16-byte little-endian records:
//   index     [offset of slice i's header, 0, 0, 0], one per slice, first in the file
//   header    [HEAT_MAGIC, slice time in ms: high 32 bits, low 32 bits, interval in ms: low 16 bits]
//   ident     [address, 1 << 30 | squawk digits as a decimal number, callsign bytes 0-3, callsign bytes 4-7]
//   position  [address, lat × 1e6, lon × 1e6, altitude int16, ground speed int16]
// Each header is followed by the records of its slice, up to the next header. The address is 24 bits, bit 24 marks a
// non-ICAO one. An altitude is in 25 ft steps (-123 on the ground, -124 unknown), a speed in 0.1 kt (-1 unknown). An ident
// comes once a minute per aircraft, and when its callsign or squawk changes.
import type { HistorySlot, HistoryTrack } from '../shared/api.ts'
import type { AltSeries } from './descent.ts'
import { distanceNm } from '../shared/geo.ts'
import { geoidN } from '../shared/geoid.ts'
import { EVERYTHING_NM, SLOT_MS } from '../shared/history.ts'

export const HEAT_MAGIC = 0x0e7f7c9d

export interface HeatRecordIn {
  hex: string // 6 hex digits, '~' first for a non-ICAO address
  lat: number
  lon: number
  alt: number | 'g' | null // ft, 'g' on the ground, null unknown
  gs: number | null // kt
}
export interface HeatIdentIn {
  hex: string
  callsign: string | null // up to 8 characters, space padded; null is written as 8 NULs. Read back: null for none, blanks or only '@'
  squawk: string | null // 4 digits; null is written as 0000, which readsb writes for none, and is read back as null
}
export interface HeatSliceIn {
  tMs: number
  records: (HeatRecordIn | HeatIdentIn)[]
}

const REC = 16 // bytes per record
const IDENT = 1 << 30 // a record whose second word is at least this is an ident (readsb sets bit 30 of the latitude word)
const KEY_MASK = 0x1ffffff // address and the non-ICAO bit: one number per aircraft, no string needed to find it
const NON_ICAO = 0x1000000
const GROUND = -123
const NO_ALT = -124
const NO_GS = -1
const MIN_AIR_GS = 500 // 50 kt, in the file's 0.1 kt: slower, with an altitude and no ground flag, is taxiing
const MAX_LAT = 90_000_000 // micro-degrees, as the file has them
const MAX_LON = 180_000_000

/** The address word of a hex like '738a10' or '~abc123'. */
function addressOf(hex: string): number {
  const nonIcao = hex.startsWith('~')
  return (parseInt(nonIcao ? hex.slice(1) : hex, 16) & 0xffffff) | (nonIcao ? NON_ICAO : 0)
}

/** The hex of an address key: 6 digits, '~' first for a non-ICAO address. */
function hexOf(key: number): string {
  return (key & NON_ICAO ? '~' : '') + (key & 0xffffff).toString(16).padStart(6, '0')
}

/**
 * The second into the half hour at slotMs of the slice whose header is at o. Rounded to whole seconds first, so a file stamped
 * a few ms off, early or late, groups as one on the grid does. The + 0 turns a -0 (a slice 3 ms early) into 0.
 */
function sliceSec(dv: DataView, o: number, slotMs: number): number {
  return Math.round((dv.getUint32(o + 4, true) * 2 ** 32 + dv.getUint32(o + 8, true) - slotMs) / 1000) + 0
}

/** The squawk in an ident's second word: 4 digits, null for 0 (readsb writes 0 when it has none). */
function squawkOf(w1: number): string | null {
  const digits = w1 & 0xffff
  return digits === 0 ? null : digits.toString(10).padStart(4, '0')
}

/** Test and tool helper: a decompressed heatmap file, index records first as readsb writes them. */
export function encodeHeatmap(slices: HeatSliceIn[], intervalMs = 10_000): Uint8Array {
  let records = slices.length
  for (const s of slices) records += 1 + s.records.length
  const out = new Uint8Array(records * REC)
  const dv = new DataView(out.buffer)
  let next = slices.length // the record after the index
  slices.forEach((s, i) => {
    dv.setUint32(i * REC, next, true) // index: where this slice's header is
    let o = next++ * REC
    dv.setUint32(o, HEAT_MAGIC, true)
    dv.setUint32(o + 4, Math.floor(s.tMs / 2 ** 32), true)
    dv.setUint32(o + 8, s.tMs % 2 ** 32, true)
    dv.setUint16(o + 12, intervalMs & 0xffff, true)
    for (const r of s.records) {
      o = next++ * REC
      dv.setUint32(o, addressOf(r.hex), true)
      if ('callsign' in r) {
        dv.setInt32(o + 4, IDENT | (r.squawk === null ? 0 : Number(r.squawk)), true)
        // No callsign is 8 NULs; a short one is padded with spaces, as in a real file.
        if (r.callsign !== null) for (let j = 0; j < 8; j++) out[o + 8 + j] = j < r.callsign.length ? r.callsign.charCodeAt(j) : 0x20
      } else {
        dv.setInt32(o + 4, Math.round(r.lat * 1e6), true)
        dv.setInt32(o + 8, Math.round(r.lon * 1e6), true)
        dv.setInt16(o + 12, r.alt === 'g' ? GROUND : r.alt === null ? NO_ALT : Math.round(r.alt / 25), true)
        dv.setInt16(o + 14, r.gs === null ? NO_GS : Math.round(r.gs * 10), true)
      }
    }
  })
  return out
}

/** The offset of the first slice header, -1 when there is none. The index records before it are not positions. */
function firstHeader(dv: DataView, end: number): number {
  for (let o = 0; o < end; o += REC) if (dv.getUint32(o, true) === HEAT_MAGIC) return o
  return -1
}

/** Whether buf is a heatmap at all: it holds a slice header. An empty body, zeros or an HTML page do not. */
export function hasSliceHeader(buf: Uint8Array): boolean {
  return firstHeader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), buf.byteLength - (buf.byteLength % REC)) >= 0
}

/**
 * The callsign in the 8 bytes at `o`, trimmed. null when there is none, it is blank, or it is readsb's empty ident
 * '@@@@@@@@' (zeros, shown as @): the same rule as server/trace.ts.
 */
function callsignAt(buf: Uint8Array, o: number): string | null {
  if (buf[o] === 0) return null
  let n = 8
  while (n > 0 && (buf[o + n - 1] === 0 || buf[o + n - 1] === 0x20)) n--
  let s = ''
  for (let i = 0; i < n; i++) {
    const c = buf[o + i]
    s += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : '?' // it is shown as text: nothing but printable ASCII
  }
  s = s.trim()
  return /^@*$/.test(s) ? null : s
}

/**
 * One pass over a decompressed file (the 13 MB, 825,000 records of a real half hour): the positions inside the circle
 * (q.lat, q.lon, q.nm), in the slices of the half hour q.slotMs, the first slice of each group of q.stepS seconds. The slot is
 * the one asked for, not the file's word for it: a slice stamped outside [slotMs, slotMs + 30 min) is dropped. An aircraft is a
 * column set per hex; its callsign and squawk come from its newest ident record in the whole file, also one in a slice that is
 * not kept. null: no slice header. A position outside the circle costs a few reads and compares, no allocation.
 */
export function readSlot(buf: Uint8Array, q: { slotMs: number; lat: number; lon: number; nm: number; stepS: number }): HistorySlot | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const end = buf.byteLength - (buf.byteLength % REC) // a half record at the end is not read
  const everything = q.nm >= EVERYTHING_NM // the whole-world circle keeps every position, with no distance test
  // A degree of latitude is 60 nm and a bit, so a position more than nm / 60 + 0.1 degrees of latitude from the centre
  // is outside the circle. In micro-degrees, as the file has them.
  const band = (q.nm / 60 + 0.1) * 1e6
  const minLat = q.lat * 1e6 - band
  const maxLat = q.lat * 1e6 + band
  let o = firstHeader(dv, end)
  if (o < 0) return null
  const tracks = new Map<number, HistoryTrack>() // by address; hex is set at the end, for the aircraft that are kept
  // ponytail: the newest ident record wins as a whole: with no callsign, or squawk 0 (readsb's "none"), the aircraft gets
  // none, even if an older ident had one. That never happened in the real file above (0 of 9,373 aircraft). The offset
  // of the record is kept: nothing is decoded until an aircraft is kept.
  const identAt = new Map<number, number>()
  let keep = false
  let sec = 0 // seconds into the slot of the slice being read, once it is kept
  let group = Number.NaN // the group of stepS seconds of the last slice kept
  for (; o < end; o += REC) {
    const w0 = dv.getUint32(o, true)
    if (w0 === HEAT_MAGIC) {
      const at = sliceSec(dv, o, q.slotMs)
      const g = Math.floor(at / q.stepS)
      keep = at >= 0 && at < SLOT_MS / 1000 && g !== group
      if (keep) {
        sec = at
        group = g
      }
      continue
    }
    const w1 = dv.getInt32(o + 4, true)
    if (w1 >= IDENT) {
      identAt.set(w0 & KEY_MASK, o)
      continue
    }
    if (!keep) continue
    // Written so that a NaN in the query keeps nothing.
    if (!everything && !(w1 >= minLat && w1 <= maxLat)) continue
    const w2 = dv.getInt32(o + 8, true)
    if (w1 > MAX_LAT || w1 < -MAX_LAT || w2 > MAX_LON || w2 < -MAX_LON) continue // not a place on earth: geoidN would throw
    if (!everything && !(distanceNm(q.lat, q.lon, w1 / 1e6, w2 / 1e6) <= q.nm)) continue
    const lat = Math.round(w1 / 10) / 1e5
    const lon = Math.round(w2 / 10) / 1e5
    const key = w0 & KEY_MASK
    let trk = tracks.get(key)
    if (trk === undefined) {
      trk = { hex: '', callsign: null, squawk: null, type: null, nM: Math.round(geoidN(lat, lon) * 10) / 10, t: [], lat: [], lon: [], alt: [], gs: [] }
      tracks.set(key, trk)
    }
    const alt = dv.getInt16(o + 12, true)
    const gs = dv.getInt16(o + 14, true)
    trk.t.push(sec)
    trk.lat.push(lat)
    trk.lon.push(lon)
    trk.alt.push(alt === GROUND ? 'g' : alt === NO_ALT ? null : alt * 25)
    trk.gs.push(gs === NO_GS ? null : gs / 10)
  }
  // The address number sorts like the hex string: six digits each, and every '~' one is after every other.
  const aircraft = [...tracks.keys()]
    .sort((a, b) => a - b)
    .map((key) => {
      const trk = tracks.get(key)!
      trk.hex = hexOf(key)
      const id = identAt.get(key)
      if (id !== undefined) {
        trk.squawk = squawkOf(dv.getInt32(id + 4, true))
        trk.callsign = callsignAt(buf, id + 8)
      }
      return trk
    })
  return { slotMs: q.slotMs, stepS: q.stepS, aircraft }
}

/** One aircraft of a half-hour file as the alerts read it (scanSlot). */
export interface ScanAircraft {
  alt: AltSeries // its altitudes off the ground, whatever its speed (ft, 25 ft steps; baro, or GNSS where readsb had no baro): t in s into the slot
  lat: number // its newest position
  lon: number
  tS: number // when, in s into the slot
  callsign: string | null // from its newest ident record
  squawks: { tS: number; squawk: string }[] // its ident records carrying one of the codes asked for while airborne (see scanSlot)
}

export interface SlotScan {
  endS: number // the second of the last slice read, into the slot
  aircraft: Map<string, ScanAircraft> // by hex
}

/**
 * One pass over a decompressed half-hour file for the alerts (server/alerts.ts): each aircraft's altitudes, its newest position
 * and callsign, and its ident records that carry one of `codes` while it is airborne. What counts, exactly:
 *   - an ident counts when the aircraft's newest position before it had a known altitude off the ground and a ground speed that
 *     is unknown or 50 kt or more (a taxiing aircraft can report -250 ft at 19 kt without the ground flag);
 *   - a position with an unknown altitude leaves that state unchanged; before any position it is unknown, and an ident does not count;
 *   - idents in slices outside the half hour are not read: a slice stamped before the slot or at 30 min or later is skipped, as
 *     readSlot does, and endS is the last slice kept.
 * An altitude is collected for every position with a known altitude off the ground, whatever its speed. null: no slice header.
 * ponytail: every aircraft's altitudes are held at once, about 2 million numbers for a busy half hour.
 */
export function scanSlot(buf: Uint8Array, slotMs: number, codes: ReadonlySet<string>): SlotScan | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const end = buf.byteLength - (buf.byteLength % REC)
  let o = firstHeader(dv, end)
  if (o < 0) return null
  const byKey = new Map<number, ScanAircraft & { airborne: boolean | null }>()
  const get = (key: number): ScanAircraft & { airborne: boolean | null } => {
    let a = byKey.get(key)
    if (a === undefined) {
      a = { alt: { t: [], ft: [] }, lat: Number.NaN, lon: Number.NaN, tS: -1, callsign: null, squawks: [], airborne: null }
      byKey.set(key, a)
    }
    return a
  }
  let keep = false
  let sec = 0
  let endS = 0
  for (; o < end; o += REC) {
    const w0 = dv.getUint32(o, true)
    if (w0 === HEAT_MAGIC) {
      const at = sliceSec(dv, o, slotMs)
      keep = at >= 0 && at < SLOT_MS / 1000
      if (keep) endS = Math.max(endS, (sec = at))
      continue
    }
    if (!keep) continue
    const key = w0 & KEY_MASK
    const w1 = dv.getInt32(o + 4, true)
    if (w1 >= IDENT) {
      const a = get(key)
      a.callsign = callsignAt(buf, o + 8)
      const squawk = squawkOf(w1)
      if (squawk !== null && codes.has(squawk) && a.airborne === true) a.squawks.push({ tS: sec, squawk })
      continue
    }
    const w2 = dv.getInt32(o + 8, true)
    if (w1 > MAX_LAT || w1 < -MAX_LAT || w2 > MAX_LON || w2 < -MAX_LON) continue
    const a = get(key)
    a.lat = Math.round(w1 / 10) / 1e5
    a.lon = Math.round(w2 / 10) / 1e5
    a.tS = sec
    const alt = dv.getInt16(o + 12, true)
    if (alt === GROUND) a.airborne = false
    else if (alt !== NO_ALT) {
      const gs = dv.getInt16(o + 14, true)
      a.airborne = gs === NO_GS || gs >= MIN_AIR_GS
      a.alt.t.push(sec)
      a.alt.ft.push(alt * 25)
    }
  }
  const aircraft = new Map<string, ScanAircraft>()
  for (const [key, { airborne, ...a }] of byKey) {
    if (a.tS < 0) continue // ident records only: no place to show
    aircraft.set(hexOf(key), a)
  }
  return { endS, aircraft }
}

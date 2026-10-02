// server/trace.ts
// One aircraft's flown path from adsb.lol's trace files (keyless, ODbL 1.0): the live file of the last 25 h
//   <base>/data/traces/<xx>/trace_full_<hex>.json
// or the file of one UTC day
//   <base>/globe_history/YYYY/MM/DD/traces/<xx>/trace_full_<hex>.json            (<xx> = the last two hex digits)
// Neither sends CORS headers, so the browser gets this server's replies (shared/api.ts) instead: a TraceReply, the one
// flight leg flying at the asked time, as columns, with the geoid N of every point (live mode's flown path); or a TraceDay,
// every leg of a span of up to 48 h, the live file and the day files merged (History).
// The files are readsb's "trace json": { icao, r?, t?, timestamp (s), trace: [[dtS, lat, lon, alt | "ground" | null, gs,
// track, flags, vrate, acObj | null, source, geomAlt, geomRate, ias, roll], …] }, a point at timestamp + dtS. Flags: 1 stale,
// 2 first point of a new leg, 4 vrate is geometric, 8 altitude is geometric. Checked on a real live file and a real day
// file (2026-10-02): 14 columns a row, `flight` in an acObj padded to 8 characters, a day file's timestamp is its UTC
// midnight and a live file's is its first point.
// Legs: readsb marks a leg's first point (flag 2) from the 24 h + 60 min of points it holds when it writes a file, and the
// first point it holds is never marked: a file's first point is often one it could not judge. So a leg starts at the first
// point of what is read and at every point flagged 2; where two files meet in a span, a file's first point starts one only
// when readsb would have said so (a gap of over 25 min, on the ground at either end or low at both: legAtEdge). A leg
// crossing midnight, or the 25 h cut between the day files and the live file, stays one leg.
// The client shows alt × 0.3048 + N as the height above the ellipsoid, which is right for a baro altitude (feet above mean sea
// level). A point flagged 8 has a geometric altitude, which is above the ellipsoid already: it goes out as ft - N / 0.3048, so
// the client's sum gives it back.

import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import type { TraceDay, TraceReply } from '../shared/api.ts'
import { geoidN } from '../shared/geoid.ts'

const gunzipAsync = promisify(gunzip) // off the event loop: a day file is a few MB unzipped

export const TRACE_BASE = 'https://adsb.lol'
const LIVE_WINDOW_MS = 25 * 3_600_000 // the live file keeps 24 h + 60 min; tar1090 turns to a day file 60 min after its UTC day ends
const DAY_MS = 24 * 3_600_000
/** A leg that ended longer ago than this has landed long since: nothing is flying on it. */
const LANDED_MS = 6 * 3_600_000
const LIVE_TTL_MS = 30_000 // the live file grows by the second
const DAY_TTL_MS = 3_600_000 // a finished day does not change
// ponytail: the cache holds each file parsed. Measured ~0.4 KB a point (1 MB for a 2,400-point file); the longest day file
// probed had 16,000 points (~7 MB). So 50 files is tens of MB, 350 MB at the very worst. Cache the cut columns if that bites.
const MAX_ENTRIES = 50
const TIMEOUT_MS = 20_000 // a day file is a few MB
const HEX = /^~?[0-9a-f]{6}$/
// Where two files meet, readsb's own rule for a leg on the ground: a reception gap of over 25 min. Low: its ceiling for a leg
// found in a gap is 20,000 ft; half that here, so a turboprop's cruise across a coverage hole stays in its leg.
const EDGE_GAP_MS = 25 * 60_000
const EDGE_LOW_FT = 10_000
const FAILED = Symbol('failed') // a file that could not be had (not a 404): not kept

const isLive = (atMs: number, nowMs: number) => nowMs - atMs < LIVE_WINDOW_MS
/** Whether ms is a date from the year 2000 to 9999: outside it toISOString gives no 4-digit year. NaN and ±Infinity are not. */
const isDate = (ms: number): boolean => {
  const year = new Date(ms).getUTCFullYear() // NaN when ms is no date: NaN, ±Infinity, beyond ±8.64e15
  return year >= 2000 && year <= 9999
}
const fileOf = (hex: string) => `traces/${hex.slice(-2)}/trace_full_${hex}.json`
const liveUrl = (base: string, hex: string) => `${base}/data/${fileOf(hex)}`
/** The file of the UTC date holding tMs. */
function dayUrl(base: string, hex: string, tMs: number): string {
  const [y, m, d] = new Date(tMs).toISOString().slice(0, 10).split('-')
  return `${base}/globe_history/${y}/${m}/${d}/${fileOf(hex)}`
}

/** The live file (atMs within the last 25 h) or the day file of atMs's UTC date. `hex` is lowercase, `~` kept. */
export function traceUrl(base: string, hex: string, atMs: number, nowMs: number): string {
  return isLive(atMs, nowMs) ? liveUrl(base, hex) : dayUrl(base, hex, atMs)
}

type Row = unknown[]
/** A trace row and its time, UTC ms. first: the first point of its file, which readsb never marks. */
interface Point {
  ms: number
  row: Row
  first: boolean
}

/** A trace row is a point when its time is a number and its position is on the globe (geoidN throws beyond ±90°); else it is skipped. */
const isPoint = (r: unknown): r is Row =>
  Array.isArray(r) && [r[0], r[1], r[2]].every((v) => Number.isFinite(v)) && Math.abs(r[1]) <= 90 && Math.abs(r[2]) <= 180
const roundTo = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const rounded = (v: unknown, dp: number): number | null => {
  const n = num(v)
  return n === null ? null : roundTo(n, dp)
}
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** The call sign in an acObj: its `flight` trimmed; null when there is none, it is blank, or it is readsb's '@@@@@@@@' (all zeros). */
function callsignOf(acObj: unknown): string | null {
  const flight = typeof acObj === 'object' && acObj !== null ? (acObj as { flight?: unknown }).flight : undefined
  const c = typeof flight === 'string' ? flight.trim() : ''
  return /^@*$/.test(c) ? null : c
}

/** A trace file's points in file order, and the registration and type it names; null when it is no trace file. */
function readTrace(json: unknown): { points: Point[]; reg: string | null; typeCode: string | null } | null {
  const f = json as { r?: unknown; t?: unknown; timestamp?: unknown; trace?: unknown } | null
  if (typeof f !== 'object' || f === null || typeof f.timestamp !== 'number' || !Number.isFinite(f.timestamp) || !Array.isArray(f.trace)) return null
  const stampS = f.timestamp
  const points = (f.trace as unknown[]).filter(isPoint).map((row, i) => ({ ms: Math.round((stampS + (row[0] as number)) * 1000), row, first: i === 0 }))
  return { points, reg: nonEmpty(f.r), typeCode: nonEmpty(f.t) }
}

const marked = (r: Row): boolean => typeof r[6] === 'number' && (r[6] & 2) !== 0
const onGround = (r: Row): boolean => r[3] === 'ground'
const low = (r: Row): boolean => typeof r[3] !== 'number' || r[3] < EDGE_LOW_FT // 'ground' and no altitude count as low

/**
 * Whether a file's first point p starts a new leg after prev, the last point of the file before: after a gap of over 25 min
 * with the aircraft on the ground at either end, or low at both (it landed, out of coverage or not, and took off again).
 * A gap at cruise is a coverage hole of one flight.
 */
function legAtEdge(prev: Point, p: Point): boolean {
  if (p.ms - prev.ms <= EDGE_GAP_MS) return false
  return onGround(prev.row) || onGround(p.row) || (low(prev.row) && low(p.row))
}

/** The points cut into legs: one starts at the first point, at every point flagged 2, and at a file's first point after a leg's end. */
function splitLegs(points: Point[]): Point[][] {
  const legs: Point[][] = []
  points.forEach((p, i) => {
    if (i === 0 || marked(p.row) || (p.first && legAtEdge(points[i - 1], p))) legs.push([p])
    else legs[legs.length - 1].push(p)
  })
  return legs
}

/** One leg as columns, t in s after its first point. calls: each callsign it sent, from the point it starts; a repeat is skipped. */
function legReply(hex: string, leg: Point[], reg: string | null, typeCode: string | null): TraceReply {
  const t0Ms = leg[0].ms
  const out: TraceReply = {
    hex, callsign: null, calls: [], reg, typeCode, t0Ms,
    t: [], lat: [], lon: [], alt: [], gs: [], trk: [], vs: [], roll: [], nM: [],
  }
  for (const { ms, row: r } of leg) {
    const lat = r[1] as number
    const lon = r[2] as number
    const nM = roundTo(geoidN(lat, lon), 1)
    let alt: number | 'g' | null = r[3] === 'ground' ? 'g' : num(r[3])
    if (typeof alt === 'number' && typeof r[6] === 'number' && (r[6] & 8) !== 0) alt = Math.round(alt - nM / 0.3048) // geometric
    const t = roundTo((ms - t0Ms) / 1000, 1)
    out.t.push(t)
    out.lat.push(roundTo(lat, 5))
    out.lon.push(roundTo(lon, 5))
    out.alt.push(alt)
    out.gs.push(rounded(r[4], 1))
    out.trk.push(rounded(r[5], 1))
    out.vs.push(num(r[7])) // already the baro rate, else the geometric one (flags & 4 says which)
    out.roll.push(rounded(r[13], 1))
    out.nM.push(nM)
    const call = callsignOf(r[8])
    if (call !== null && call !== out.calls.at(-1)?.[1]) out.calls.push([t, call])
  }
  out.callsign = out.calls.at(-1)?.[1] ?? null // the leg's newest
  return out
}

/**
 * The leg flying at atMs (the last leg starting at or before it) as a TraceReply; null when the file has no point that early
 * or the leg ended more than 6 h before atMs. A leg starts at the first point and at every point flagged 2. The whole leg is
 * returned, the points after atMs too: the client cuts.
 */
export function traceReply(json: unknown, hex: string, atMs: number): TraceReply | null {
  if (Number.isNaN(atMs)) return null // every comparison with it is false: it would pick the last leg
  const f = readTrace(json)
  if (f === null) return null
  const legs = splitLegs(f.points)
  let k = legs.length - 1
  while (k >= 0 && legs[k][0].ms > atMs) k--
  if (k < 0) return null
  const leg = legs[k]
  if (atMs - leg[leg.length - 1].ms > LANDED_MS) return null
  return legReply(hex, leg, f.reg, f.typeCode)
}

/** One file of a span (json null: it is not there) and the part of it that counts: its points from fromMs to before toMs. */
export interface SpanFile {
  json: unknown
  fromMs: number
  toMs: number
}

/**
 * Every leg overlapping [fromMs, toMs], from the files of a span given in time order (the day files, then the live file).
 * Each file adds only its own part, so the points are in time order and none comes twice. reg and typeCode: the newest
 * file's that names them. A leg comes whole as far as the files go, built as traceReply builds one; no legs is no flight.
 */
export function traceDay(hex: string, files: SpanFile[], fromMs: number, toMs: number): TraceDay {
  const points: Point[] = []
  let reg: string | null = null
  let typeCode: string | null = null
  for (const file of files) {
    const f = readTrace(file.json)
    if (f === null) continue
    reg = f.reg ?? reg
    typeCode = f.typeCode ?? typeCode
    for (const p of f.points) if (p.ms >= file.fromMs && p.ms < file.toMs) points.push(p)
  }
  const legs = splitLegs(points).filter((leg) => leg[0].ms <= toMs && leg[leg.length - 1].ms >= fromMs)
  return { hex, reg, typeCode, fromMs, toMs, legs: legs.map((leg) => legReply(hex, leg, reg, typeCode)) }
}

export interface TraceStoreOpts {
  base?: string
  userAgent: string
  fetchFn?: typeof fetch
  nowMs?: () => number
}

/** A downloaded body as text: the files are stored gzip; the host says so (fetch undoes it), but raw gzip bytes are unzipped too. */
async function bodyText(bytes: Uint8Array): Promise<string> {
  const plain = bytes[0] === 0x1f && bytes[1] === 0x8b ? await gunzipAsync(bytes) : bytes
  return new TextDecoder().decode(plain)
}

/**
 * Fetches trace files and cuts the leg flying at the asked time (traceReply) or the legs of a span (traceDay). The parsed file
 * is kept per URL (a live file 30 s, a day file 1 h, at most 50 files), so a replay selecting several aircraft, or one aircraft
 * at several times, costs one request per file. A 404 is kept as long as a file would be; a network error, a bad status, a
 * gzip that is cut or a body that is not JSON is not kept (and the body of an answer that is not 200 is not read).
 * Gets for one file at the same moment share one request.
 */
export class TraceStore {
  #base: string
  #userAgent: string
  #fetch: typeof fetch
  #now: () => number
  #cache = new Map<string, { ms: number; ttlMs: number; json: unknown }>() // Map order is age order; json null: a 404
  #pending = new Map<string, Promise<unknown>>()
  #stop = new AbortController() // close() aborts the downloads under way

  constructor(o: TraceStoreOpts) {
    this.#base = (o.base ?? TRACE_BASE).replace(/\/+$/, '')
    this.#userAgent = o.userAgent
    this.#fetch = o.fetchFn ?? ((input, init) => fetch(input, init))
    this.#now = o.nowMs ?? Date.now
  }

  /** null: no trace (404, or a failed fetch), a hex that is not an address, a time that is no date from 2000 to 9999, or no leg at atMs. */
  async get(hex: string, atMs: number): Promise<TraceReply | null> {
    const h = hex.toLowerCase()
    if (!HEX.test(h) || !isDate(atMs)) return null
    const now = this.#now()
    const json = await this.#file(traceUrl(this.#base, h, atMs, now), isLive(atMs, now) ? LIVE_TTL_MS : DAY_TTL_MS)
    return json === null || json === FAILED ? null : traceReply(json, h, atMs)
  }

  /**
   * Every leg of hex overlapping [fromMs, toMs] (traceDay): the part of the span at or after now − 25 h from the live file, the
   * part before it from the day files of the UTC dates it overlaps (3 at most for 48 h). A file that is not there (404) adds
   * nothing. 'unavailable': a file could not be had (network, timeout, 5xx, 429, a body that is not JSON), so the span would be
   * incomplete; ask again. null: a hex that is not an address, or a span that is not two dates from 2000 to 9999 in order.
   * The caller keeps the span to its limits (main.ts: to at most now, at most 48 h, from no older than adsb.lol keeps).
   */
  async day(hex: string, fromMs: number, toMs: number): Promise<TraceDay | 'unavailable' | null> {
    const h = hex.toLowerCase()
    if (!HEX.test(h) || !isDate(fromMs) || !isDate(toMs) || fromMs > toMs) return null
    const cut = this.#now() - LIVE_WINDOW_MS
    const parts: { url: string; ttlMs: number; fromMs: number; toMs: number }[] = []
    if (fromMs < cut) {
      const last = Math.min(toMs, cut - 1)
      for (let d = Math.floor(fromMs / DAY_MS) * DAY_MS; d <= last; d += DAY_MS) {
        parts.push({ url: dayUrl(this.#base, h, d), ttlMs: DAY_TTL_MS, fromMs: d, toMs: Math.min(d + DAY_MS, cut) })
      }
    }
    if (toMs >= cut) parts.push({ url: liveUrl(this.#base, h), ttlMs: LIVE_TTL_MS, fromMs: cut, toMs: Infinity })
    const files = await Promise.all(parts.map((p) => this.#file(p.url, p.ttlMs)))
    if (files.includes(FAILED)) return 'unavailable'
    return traceDay(h, parts.map((p, i) => ({ json: files[i], fromMs: p.fromMs, toMs: p.toMs })), fromMs, toMs)
  }

  /** Aborts the downloads under way (their gets are null, their spans unavailable); nothing is asked after it. A server calls it when it closes. */
  close(): void {
    this.#stop.abort()
  }

  /** The parsed file, null when it is not there (404), FAILED when it could not be had; fresh from the cache when it can. */
  async #file(url: string, ttlMs: number): Promise<unknown> {
    const hit = this.#cache.get(url)
    if (hit !== undefined && this.#now() - hit.ms < hit.ttlMs) return hit.json
    let pending = this.#pending.get(url)
    if (pending === undefined) {
      if (this.#stop.signal.aborted) return FAILED
      pending = this.#load(url, ttlMs).finally(() => this.#pending.delete(url))
      this.#pending.set(url, pending)
    }
    return pending
  }

  /** The parsed file, null for a 404 (kept), or FAILED (not kept); never throws. */
  async #load(url: string, ttlMs: number): Promise<unknown> {
    let json: unknown
    try {
      const res = await this.#fetch(url, {
        headers: { 'user-agent': this.#userAgent, 'accept-encoding': 'gzip' },
        signal: AbortSignal.any([this.#stop.signal, AbortSignal.timeout(TIMEOUT_MS)]),
      })
      if (res.status !== 200) {
        void res.body?.cancel().catch(() => {}) // not read: let the connection go
        if (res.status !== 404) return FAILED
        this.#keep(url, ttlMs, null)
        return null
      }
      json = JSON.parse(await bodyText(new Uint8Array(await res.arrayBuffer())))
    } catch {
      return FAILED // network error, timeout, a gzip that is cut, or a body that is not JSON
    }
    this.#keep(url, ttlMs, json)
    return json
  }

  #keep(url: string, ttlMs: number, json: unknown): void {
    const now = this.#now()
    // The expired go first: a live file lasts 30 s and a day file an hour, so the oldest entry is not always the first to expire.
    for (const [u, e] of this.#cache) if (now - e.ms >= e.ttlMs) this.#cache.delete(u)
    this.#cache.delete(url) // re-inserted last
    this.#cache.set(url, { ms: now, ttlMs, json })
    if (this.#cache.size > MAX_ENTRIES) this.#cache.delete(this.#cache.keys().next().value!)
  }
}

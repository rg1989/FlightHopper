// server/trace.ts
// One aircraft's flown path from adsb.lol's trace files (keyless, ODbL 1.0): the live file of the last 25 h
//   <base>/data/traces/<xx>/trace_full_<hex>.json
// or the file of one UTC day
//   <base>/globe_history/YYYY/MM/DD/traces/<xx>/trace_full_<hex>.json            (<xx> = the last two hex digits)
// Neither sends CORS headers, so the browser gets this server's TraceReply (shared/api.ts) instead: the one flight leg
// flying at the asked time, as columns, with the geoid N of every point.
// The files are readsb's "trace json": { icao, r?, t?, timestamp (s), trace: [[dtS, lat, lon, alt | "ground" | null, gs,
// track, flags, vrate, acObj | null, source, geomAlt, geomRate, ias, roll], …] }, a point at timestamp + dtS. Flags: 1 stale,
// 2 first point of a new leg, 4 vrate is geometric, 8 altitude is geometric. Checked on a real live file and a real day
// file (2026-10-02): 14 columns a row, `flight` in an acObj padded to 8 characters, a day file's timestamp is its UTC
// midnight and a live file's is its first point.
// The client shows alt × 0.3048 + N as the height above the ellipsoid, which is right for a baro altitude (feet above mean sea
// level). A point flagged 8 has a geometric altitude, which is above the ellipsoid already: it goes out as ft - N / 0.3048, so
// the client's sum gives it back.

import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import type { TraceReply } from '../shared/api.ts'
import { geoidN } from '../shared/geoid.ts'

const gunzipAsync = promisify(gunzip) // off the event loop: a day file is a few MB unzipped

export const TRACE_BASE = 'https://adsb.lol'
const LIVE_WINDOW_MS = 25 * 3_600_000 // the live file keeps 24 h + 60 min; tar1090 turns to a day file 60 min after its UTC day ends
/** A leg that ended longer ago than this has landed long since: nothing is flying on it. */
const LANDED_MS = 6 * 3_600_000
const LIVE_TTL_MS = 30_000 // the live file grows by the second
const DAY_TTL_MS = 3_600_000 // a finished day does not change
// ponytail: the cache holds each file parsed. Measured ~0.4 KB a point (1 MB for a 2,400-point file); the longest day file
// probed had 16,000 points (~7 MB). So 50 files is tens of MB, 350 MB at the very worst. Cache the cut columns if that bites.
const MAX_ENTRIES = 50
const TIMEOUT_MS = 20_000 // a day file is a few MB
const HEX = /^~?[0-9a-f]{6}$/

const isLive = (atMs: number, nowMs: number) => nowMs - atMs < LIVE_WINDOW_MS

/** The live file (atMs within the last 25 h) or the day file of atMs's UTC date. `hex` is lowercase, `~` kept. */
export function traceUrl(base: string, hex: string, atMs: number, nowMs: number): string {
  const file = `traces/${hex.slice(-2)}/trace_full_${hex}.json`
  if (isLive(atMs, nowMs)) return `${base}/data/${file}`
  const [y, m, d] = new Date(atMs).toISOString().slice(0, 10).split('-')
  return `${base}/globe_history/${y}/${m}/${d}/${file}`
}

type Row = unknown[]

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

/**
 * The leg flying at atMs (the last leg starting at or before it) as a TraceReply; null when the file has no point that early
 * or the leg ended more than 6 h before atMs. A leg starts at the first point and at every point flagged 2. The whole leg is
 * returned, the points after atMs too: the client cuts.
 */
export function traceReply(json: unknown, hex: string, atMs: number): TraceReply | null {
  const f = json as { r?: unknown; t?: unknown; timestamp?: unknown; trace?: unknown } | null
  if (typeof f !== 'object' || f === null || typeof f.timestamp !== 'number' || !Number.isFinite(f.timestamp) || !Array.isArray(f.trace)) return null
  if (Number.isNaN(atMs)) return null // every comparison with it is false: it would pick the last leg
  const stampS = f.timestamp
  const rows = (f.trace as unknown[]).filter(isPoint)
  const timeMs = (r: Row) => Math.round((stampS + (r[0] as number)) * 1000)

  const starts: number[] = []
  rows.forEach((r, i) => {
    if (i === 0 || (typeof r[6] === 'number' && (r[6] & 2) !== 0)) starts.push(i)
  })
  let k = starts.length - 1
  while (k >= 0 && timeMs(rows[starts[k]]) > atMs) k--
  if (k < 0) return null
  const leg = rows.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : rows.length)
  if (atMs - timeMs(leg[leg.length - 1]) > LANDED_MS) return null

  const dt0 = leg[0][0] as number
  const out: TraceReply = {
    hex, callsign: null, calls: [], reg: nonEmpty(f.r), typeCode: nonEmpty(f.t), t0Ms: timeMs(leg[0]),
    t: [], lat: [], lon: [], alt: [], gs: [], trk: [], vs: [], roll: [], nM: [],
  }
  for (const r of leg) {
    const lat = r[1] as number
    const lon = r[2] as number
    const nM = roundTo(geoidN(lat, lon), 1)
    let alt: number | 'g' | null = r[3] === 'ground' ? 'g' : num(r[3])
    if (typeof alt === 'number' && typeof r[6] === 'number' && (r[6] & 8) !== 0) alt = Math.round(alt - nM / 0.3048) // geometric
    out.t.push(roundTo((r[0] as number) - dt0, 1))
    out.lat.push(roundTo(lat, 5))
    out.lon.push(roundTo(lon, 5))
    out.alt.push(alt)
    out.gs.push(rounded(r[4], 1))
    out.trk.push(rounded(r[5], 1))
    out.vs.push(num(r[7])) // already the baro rate, else the geometric one (flags & 4 says which)
    out.roll.push(rounded(r[13], 1))
    out.nM.push(nM)
  }
  for (let i = leg.length - 1; i >= 0 && out.callsign === null; i--) out.callsign = callsignOf(leg[i][8])
  return out
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
 * Fetches trace files and cuts the leg flying at the asked time (traceReply). The parsed file is kept per URL (a live file 30 s,
 * a day file 1 h, at most 50 files), so a replay selecting several aircraft, or one aircraft at several times, costs one request
 * per file. A 404 is kept as long as a file would be; a network error, a bad status, a gzip that is cut or a body that is not
 * JSON is not kept (and the body of an answer that is not 200 is not read).
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
    const year = new Date(atMs).getUTCFullYear() // NaN when atMs is no date: NaN, ±Infinity, beyond ±8.64e15
    if (!HEX.test(h) || !(year >= 2000 && year <= 9999)) return null // outside it toISOString gives no 4-digit year
    const now = this.#now()
    const json = await this.#file(traceUrl(this.#base, h, atMs, now), isLive(atMs, now) ? LIVE_TTL_MS : DAY_TTL_MS)
    return json === null ? null : traceReply(json, h, atMs)
  }

  /** Aborts the downloads under way (their gets are null); nothing is asked after it. A server calls it when it closes. */
  close(): void {
    this.#stop.abort()
  }

  async #file(url: string, ttlMs: number): Promise<unknown> {
    const hit = this.#cache.get(url)
    if (hit !== undefined && this.#now() - hit.ms < hit.ttlMs) return hit.json
    let pending = this.#pending.get(url)
    if (pending === undefined) {
      if (this.#stop.signal.aborted) return null
      pending = this.#load(url, ttlMs).finally(() => this.#pending.delete(url))
      this.#pending.set(url, pending)
    }
    return pending
  }

  /** The parsed file, or null; never throws. */
  async #load(url: string, ttlMs: number): Promise<unknown> {
    let json: unknown
    try {
      const res = await this.#fetch(url, {
        headers: { 'user-agent': this.#userAgent, 'accept-encoding': 'gzip' },
        signal: AbortSignal.any([this.#stop.signal, AbortSignal.timeout(TIMEOUT_MS)]),
      })
      if (res.status !== 200) {
        void res.body?.cancel().catch(() => {}) // not read: let the connection go
        if (res.status === 404) this.#keep(url, ttlMs, null)
        return null
      }
      json = JSON.parse(await bodyText(new Uint8Array(await res.arrayBuffer())))
    } catch {
      return null // network error, timeout, a gzip that is cut, or a body that is not JSON
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

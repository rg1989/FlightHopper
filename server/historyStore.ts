// server/historyStore.ts
// The past, from adsb.lol: one heatmap file per UTC half hour (server/heatmap.ts reads it), published just after the half
// hour ends. A file is fetched when it is asked for and held in memory, a few at a time: 12-25 MB on the wire, about 13-28 MB
// decompressed, so about 140 MB at the server's maxSlots of 5. tick() keeps the newest two published ones, so the minutes
// just gone are always at hand; a live server calls it every minute. Nothing here runs a timer.
// Memory only, by the user's choice: they asked not to collect the files. There is no disk cache; a restart fetches again.
// ponytail: the body is not capped: it comes from adsb.lol over https.
// A slot with no file is either "missing" (adsb.lol has none: a 404 or 410, remembered 10 min, or the slot is older than it keeps)
// or "unavailable" (it could not be had now: 5xx, 429, a network error, a timeout, a 200 that is not a heatmap, not published yet,
// too many downloads at once): the caller says 404 for the first and 503 for the second, which is worth asking again.
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import type { HistorySlot, HistoryStatus } from '../shared/api.ts'
import { SLOT_MS, newestSlotMs, stepFor } from '../shared/history.ts'
import { hasSliceHeader, readSlot } from './heatmap.ts'

const gunzipAsync = promisify(gunzip) // off the event loop: a file is 13-28 MB decompressed
const MISSING_MS = 10 * 60_000 // a file that answered 404 or 410 is not asked for again for this long
const MAX_AGE_MS = 31 * 24 * 3_600_000 // adsb.lol keeps its half hours for about 30 days (2026-09-01 was there on 2026-10-01, 08-15 was not)
const MAX_LOADING = 2 // downloads at once: 12-25 MB each
const FETCH_TIMEOUT_MS = 120_000 // a 25 MB file on a slow line; a stuck connection ends here

/** Why a slot has no file: adsb.lol has none ('missing'), or it cannot be had now ('unavailable'). */
export type HistoryMiss = 'missing' | 'unavailable'

export interface HistoryStoreOpts {
  base?: string // default 'https://adsb.lol'
  userAgent: string
  fetchFn?: typeof fetch
  nowMs?: () => number
  maxSlots?: number // default 4 (the newest 2 count, and are never dropped)
}

/** The file of the half hour starting at slotMs: base/globe_history/YYYY/MM/DD/heatmap/NN.bin.ttf, NN = 2 × UTC hour + (minute ≥ 30). */
export function heatmapUrl(base: string, slotMs: number): string {
  const d = new Date(slotMs)
  const two = (n: number): string => String(n).padStart(2, '0')
  const nn = two(d.getUTCHours() * 2 + (d.getUTCMinutes() >= 30 ? 1 : 0))
  return `${base}/globe_history/${d.getUTCFullYear()}/${two(d.getUTCMonth() + 1)}/${two(d.getUTCDate())}/heatmap/${nn}.bin.ttf`
}

export class HistoryStore {
  #base: string
  #userAgent: string
  #fetch: typeof fetch
  #now: () => number
  #maxSlots: number
  #files = new Map<number, Uint8Array>() // slotMs → the decompressed file; Map order is use order, the oldest use first
  #loading = new Map<number, Promise<Uint8Array | HistoryMiss>>()
  #missing = new Map<number, number>() // slotMs → when "missing" is forgotten; in the order added, so the oldest first
  #stop = new AbortController() // close() aborts the downloads under way

  constructor(o: HistoryStoreOpts) {
    this.#base = o.base ?? 'https://adsb.lol'
    this.#userAgent = o.userAgent
    this.#fetch = o.fetchFn ?? ((input, init) => fetch(input, init))
    this.#now = o.nowMs ?? Date.now
    this.#maxSlots = o.maxSlots ?? 4
  }

  /**
   * The decompressed file of the half hour starting at slotMs, or why there is none. 'missing': adsb.lol has none (404, 410),
   * it is older than 31 days (no request is made), or it is no half hour. 'unavailable': it is not published yet (a half hour
   * is published PUBLISH_DELAY_MS after it ends), the fetch failed (5xx, 429, network, timeout, a 200 that is not a heatmap), or
   * two other downloads are under way already. Concurrent calls for one slot share one fetch. The array is shared: do not write to it.
   * ponytail: any half hour from the last 31 days costs one request to adsb.lol (a 404 is remembered 10 min), and a client that
   * alternates between more than maxSlots slots downloads 12-25 MB each time. The downloads under way count toward maxSlots
   * when files are dropped, so memory is about maxSlots + 2 files of up to 28 MB (the same again for a body that is still gzip).
   */
  async file(slotMs: number): Promise<Uint8Array | HistoryMiss> {
    const now = this.#now()
    if (slotMs % SLOT_MS !== 0 || slotMs < now - MAX_AGE_MS) return 'missing'
    if (slotMs > newestSlotMs(now)) return 'unavailable'
    const held = this.#files.get(slotMs)
    if (held !== undefined) {
      this.#files.delete(slotMs) // now the most recently used
      this.#files.set(slotMs, held)
      return held
    }
    const until = this.#missing.get(slotMs)
    if (until !== undefined) {
      if (now < until) return 'missing'
      this.#missing.delete(slotMs)
    }
    let loading = this.#loading.get(slotMs)
    if (loading === undefined) {
      if (this.#stop.signal.aborted || this.#loading.size >= MAX_LOADING) return 'unavailable'
      loading = this.#load(slotMs).finally(() => this.#loading.delete(slotMs))
      this.#loading.set(slotMs, loading)
    }
    return loading
  }

  /** readSlot of file(slotMs) for the circle, its step from the radius (shared/history.ts stepFor); or why there is no file. */
  async query(slotMs: number, q: { lat: number; lon: number; nm: number }): Promise<HistorySlot | HistoryMiss> {
    const file = await this.file(slotMs)
    if (typeof file === 'string') return file
    return readSlot(file, { ...q, slotMs, stepS: stepFor(q.nm) }) ?? 'unavailable' // a held file has a slice header: never null
  }

  /** The rolling fetch: the newest two published slots are held afterwards, if the upstream has them. Call it every minute. */
  async tick(): Promise<void> {
    const newest = newestSlotMs(this.#now())
    await this.file(newest)
    await this.file(newest - SLOT_MS)
  }

  /** The newest slot published and every slot held (ready), being fetched (loading) or remembered missing, oldest first. */
  status(): HistoryStatus {
    const now = this.#now()
    this.#forgetMissing(now)
    const state = new Map<number, HistoryStatus['slots'][number]['state']>()
    for (const slotMs of this.#missing.keys()) state.set(slotMs, 'missing')
    for (const slotMs of this.#loading.keys()) state.set(slotMs, 'loading')
    for (const slotMs of this.#files.keys()) state.set(slotMs, 'ready') // a fetch that has just finished is in both
    const slots = [...state].map(([slotMs, s]) => ({ slotMs, state: s })).sort((a, b) => a.slotMs - b.slotMs)
    return { newestSlotMs: newestSlotMs(now), slots }
  }

  /** Aborts the downloads under way (they end as unavailable); no new one starts. A server calls it when it closes. */
  close(): void {
    this.#stop.abort()
  }

  /**
   * One fetch, never throws. A 404 or 410 is 'missing' and remembered; any other failure (5xx, 429, network, timeout, broken
   * gzip, not a heatmap, close()) is 'unavailable' and not remembered.
   */
  async #load(slotMs: number): Promise<Uint8Array | HistoryMiss> {
    try {
      const res = await this.#fetch(heatmapUrl(this.#base, slotMs), {
        headers: { 'user-agent': this.#userAgent, 'accept-encoding': 'gzip' },
        signal: AbortSignal.any([this.#stop.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      })
      if (res.status !== 200) {
        void res.body?.cancel().catch(() => {}) // not read: let the connection go
        if (res.status !== 404 && res.status !== 410) return 'unavailable'
        this.#remember(slotMs)
        return 'missing'
      }
      let file = new Uint8Array(await res.arrayBuffer())
      // adsb.lol says Content-Encoding: gzip and fetch undoes it. A body that is still gzip (no such header) is undone here.
      if (file[0] === 0x1f && file[1] === 0x8b) {
        const plain = await gunzipAsync(file)
        file = new Uint8Array(plain.buffer, plain.byteOffset, plain.byteLength)
      }
      // A 200 that is not a heatmap (an HTML page, an empty body) is no file: held, it would stay for good, because the
      // newest two are never dropped.
      if (!hasSliceHeader(file)) return 'unavailable'
      this.#hold(slotMs, file)
      return file
    } catch {
      return 'unavailable'
    }
  }

  /**
   * Keeps a file as the most recently used. Over maxSlots, drops the least recently used one that is not of the newest two
   * published; the other downloads under way count, as each will be held when it ends.
   */
  #hold(slotMs: number, file: Uint8Array): void {
    this.#files.delete(slotMs)
    this.#files.set(slotMs, file)
    const newest = newestSlotMs(this.#now())
    const coming = this.#loading.size - (this.#loading.has(slotMs) ? 1 : 0) // this one is in #loading until it returns
    for (const held of this.#files.keys()) {
      if (this.#files.size + coming <= this.#maxSlots) break
      if (held !== newest && held !== newest - SLOT_MS) this.#files.delete(held)
    }
  }

  #remember(slotMs: number): void {
    const now = this.#now()
    this.#forgetMissing(now)
    this.#missing.delete(slotMs)
    this.#missing.set(slotMs, now + MISSING_MS)
  }

  /** Every miss lasts as long as the others, so the expired ones are the first added. */
  #forgetMissing(now: number): void {
    for (const [slotMs, until] of this.#missing) {
      if (now < until) break
      this.#missing.delete(slotMs)
    }
  }
}

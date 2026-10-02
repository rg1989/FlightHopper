// server/historyStore.ts
// The past, from adsb.lol: one heatmap file per UTC half hour (server/heatmap.ts reads it), published just after the half
// hour ends. A file is fetched when it is asked for and held in memory, a few at a time: 12-25 MB on the wire, about 13-28 MB
// decompressed, so about 140 MB at the server's maxSlots of 5. tick() keeps the newest two published ones, so the minutes
// just gone are always at hand; a live server calls it every minute. Nothing here runs a timer.
// Memory only, by the user's choice: they asked not to collect the files. There is no disk cache; a restart fetches again.
// ponytail: the body is not capped: it comes from adsb.lol over https.
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import type { HistorySlot, HistoryStatus } from '../shared/api.ts'
import { SLOT_MS, newestSlotMs, stepFor } from '../shared/history.ts'
import { hasSliceHeader, readSlot } from './heatmap.ts'

const gunzipAsync = promisify(gunzip) // off the event loop: a file is 13-28 MB decompressed
const MISSING_MS = 10 * 60_000 // a file that answered 404 or 410 is not asked for again for this long
const FETCH_TIMEOUT_MS = 120_000 // a 25 MB file on a slow line; a stuck connection ends here

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
  #loading = new Map<number, Promise<Uint8Array | null>>()
  #missing = new Map<number, number>() // slotMs → when "missing" is forgotten; in the order added, so the oldest first

  constructor(o: HistoryStoreOpts) {
    this.#base = o.base ?? 'https://adsb.lol'
    this.#userAgent = o.userAgent
    this.#fetch = o.fetchFn ?? ((input, init) => fetch(input, init))
    this.#now = o.nowMs ?? Date.now
    this.#maxSlots = o.maxSlots ?? 4
  }

  /**
   * The decompressed file of the half hour starting at slotMs; null: it is not published (404, 410), is not yet (a half hour
   * is published PUBLISH_DELAY_MS after it ends), is not a half hour, or could not be fetched now. Concurrent calls for one
   * slot share one fetch. The array is shared: do not write to it.
   * ponytail: the slot is not range-checked here: any half hour up to the newest costs one request to adsb.lol (a 404 is
   * remembered 10 min). A file being fetched does not count in maxSlots, so many distinct slots asked at once are all in
   * memory together, up to about 28 MB each (twice that while a body that is still gzip is undone); the client asks for at
   * most 2 at a time. A client that alternates between more than maxSlots slots downloads 12-25 MB each time.
   */
  async file(slotMs: number): Promise<Uint8Array | null> {
    const now = this.#now()
    if (slotMs % SLOT_MS !== 0 || slotMs > newestSlotMs(now)) return null
    const held = this.#files.get(slotMs)
    if (held !== undefined) {
      this.#files.delete(slotMs) // now the most recently used
      this.#files.set(slotMs, held)
      return held
    }
    const until = this.#missing.get(slotMs)
    if (until !== undefined) {
      if (now < until) return null
      this.#missing.delete(slotMs)
    }
    let loading = this.#loading.get(slotMs)
    if (loading === undefined) {
      loading = this.#load(slotMs).finally(() => this.#loading.delete(slotMs))
      this.#loading.set(slotMs, loading)
    }
    return loading
  }

  /** readSlot of file(slotMs) for the circle, its step from the radius (shared/history.ts stepFor); null when there is no file. */
  async query(slotMs: number, q: { lat: number; lon: number; nm: number }): Promise<HistorySlot | null> {
    const file = await this.file(slotMs)
    return file === null ? null : readSlot(file, { ...q, stepS: stepFor(q.nm) })
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

  /** One fetch, never throws: a failure that is not a 404 or 410 (5xx, 429, network, timeout, broken gzip, not a heatmap) is null and not remembered. */
  async #load(slotMs: number): Promise<Uint8Array | null> {
    try {
      const res = await this.#fetch(heatmapUrl(this.#base, slotMs), {
        headers: { 'user-agent': this.#userAgent, 'accept-encoding': 'gzip' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (res.status !== 200) {
        void res.body?.cancel().catch(() => {}) // not read: let the connection go
        if (res.status === 404 || res.status === 410) this.#remember(slotMs)
        return null
      }
      let file = new Uint8Array(await res.arrayBuffer())
      // adsb.lol says Content-Encoding: gzip and fetch undoes it. A body that is still gzip (no such header) is undone here.
      if (file[0] === 0x1f && file[1] === 0x8b) {
        const plain = await gunzipAsync(file)
        file = new Uint8Array(plain.buffer, plain.byteOffset, plain.byteLength)
      }
      // A 200 that is not a heatmap (an HTML page, an empty body) is no file: held, it would stay for good, because the
      // newest two are never dropped.
      if (!hasSliceHeader(file)) return null
      this.#hold(slotMs, file)
      return file
    } catch {
      return null
    }
  }

  /** Keeps a file as the most recently used; over maxSlots, drops the least recently used one that is not of the newest two published. */
  #hold(slotMs: number, file: Uint8Array): void {
    this.#files.delete(slotMs)
    this.#files.set(slotMs, file)
    const newest = newestSlotMs(this.#now())
    for (const held of this.#files.keys()) {
      if (this.#files.size <= this.#maxSlots) break
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
